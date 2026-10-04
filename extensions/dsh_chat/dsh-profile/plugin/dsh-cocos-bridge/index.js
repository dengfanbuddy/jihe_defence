/**
 * dsh-cocos-bridge —— 把 Cocos Creator 编辑器暴露成 DSH 的**原生工具**。
 *
 * ## 它解决什么
 *
 * DSH 是「编辑器扩展 fork 出来的子进程」，所以它天生有一条回到编辑器的 IPC 通道
 * （`child_process.fork` 给的那个 fd）。本插件就用这条通道：
 *
 * ```
 * 模型 → cocos_execute_code（原生工具）
 *         → process.send({__dshCocos:1, kind:'req', method:'execute_code', ...})
 *         ← editor 主进程：本扩展的 core/engine → vm 沙箱 / 本扩展的场景脚本
 *         ← process.on('message') 收到 kind:'res'
 * ```
 *
 * **不走 loopback HTTP、不占端口、不需要 MCP**（对比：`dsh-mcp-client` + streamable-http）。
 * 也因此，工具名是干净的 `cocos_execute_code`，而不是 `mcp__cocos__execute_code`。
 *
 * ## 四个工具 = 编辑器能力面（工具部分）
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `cocos_execute_code` | 在编辑器主进程（vm 沙箱）或引擎场景进程里跑一段代码 |
 * | `cocos_describe_api` | 渐进式披露：查编辑器/引擎 API，**别猜** |
 * | `cocos_editor_state` | 自检：我在哪个工程/场景、选中了什么、沙箱能不能动场景 |
 * | `cocos_capture_view` | 场景视图截图 → 图片文件（像素塞不进返回值，只能落盘回路径） |
 *
 * ⚠ **这里的四段 description 是模型唯一的说明书。** DSH 不消费 MCP 的
 * `initialize.instructions`，所以用法要点（别猜 API、recipe 五件套、gizmo 剪枝、
 * 返回值上限）必须搬进工具描述里 —— 否则模型看不到，等于没写。
 * 这也是为什么下面几段文字比一般工具描述长得多。
 *
 * ## 三条口径
 *
 * 1. **IPC 不可用时必须说人话**：直接 `node <dsh> --profile <cocos>` 从终端跑时没有 IPC，
 *    工具不报 ENOENT 之类的底层错，而是明确说「请在 Cocos Creator 里打开 DSH 面板」。
 * 2. **超时自己管**：编辑器可能卡住（场景重载、资源导入），不能让模型调用无限挂起。
 * 3. **本文件是纯 ESM JS，不经过编译**：由 Cordis Loader 直接 import。改完不用 build，
 *    但**必须同步到 profile**（`scripts/install-profile.js`），**并且重启一次 agent**。
 *
 *    ⚠ **`patchReload: live` 不会热重载本文件**（实测，见 README 坑 23）——它只盯
 *    `cordis.patch.yml` 这类 patch 配置：launcher 在 `patchReload === 'live'` 时建的 HMR 实例
 *    `root: []`，**不监视任何模块目录**（`dsh-base` 里 `hmr` row 也是 `disabled: true`）。
 *    所以**新增/改名工具、改工具 description 之后，模型手里不会自动变**，要 stop/start 一次 agent。
 *    这条曾经被写反过（原文写"会热重载"），**别再改回去**。
 *
 * @module dsh-cocos-bridge
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 插件名。Cordis Loader 用它做行标识与日志标签。 */
export const name = 'cocos-bridge';

/** 依赖的工具注册表。 */
export const inject = ['tools'];

/** IPC 帧上的标记位，避免和别的扩展/DSH 自身的 message 撞车。 */
const IPC_TAG = 'dsh-cocos-bridge';

/**
 * 面板 → 插件 的**控制帧**种类。
 *
 * 与工具帧（`kind: 'req'`，服务模型）分开：控制帧服务**面板**（继续历史会话这类面板要干的活），
 * 模型看不到、也拿不到。两条通道各管一头，互不干扰 —— 这也是为什么控制帧失败不会影响工具。
 */
const CONTROL_KIND = 'ctl';

/** 单次 IPC 往返的默认上限（毫秒）。场景重载 + 资源导入可能很慢，所以给得宽。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 自增请求号。 */
let seq = 0;

/** 在飞请求：id → { resolve, reject, timer, detach }。 */
const pending = new Map();

/** 事件回执（编辑器主动推送，例如场景切换）。当前版本只在日志里记一笔。 */
const listeners = new Set();

/**
 * DSH 是否被编辑器 fork 起来的（有 IPC 通道）。
 * @returns {boolean} 有 IPC 通道时为 true。
 */
function hasIpc() {
    return typeof process.send === 'function';
}

/**
 * 向编辑器要一次调用。
 *
 * @param {string} method - 语义方法名（`execute_code` / `editor_state` / ...）。
 * @param {Record<string, unknown>} params - 方法参数。
 * @param {AbortSignal} [signal] - 模型侧取消信号（工具被中断时 abort）。
 * @returns {Promise<{ok: boolean, text: string, data?: unknown}>} 编辑器回执。
 */
function ipcCall(method, params, signal) {
    if (!hasIpc()) {
        return Promise.reject(
            new Error(
                'cocos bridge：没有 IPC 通道 —— 本插件只能运行在「由 Cocos Creator 扩展 fork 起来的」DSH 进程里。' +
                    '请打开 Cocos Creator 的 DSH 面板（扩展 dsh_chat）再来调用；不要直接从终端跑 dsh --profile cocos。',
            ),
        );
    }
    if (signal?.aborted) return Promise.reject(new Error('cocos bridge：调用已被取消'));

    const id = ++seq;
    return new Promise((resolve, reject) => {
        const detach = () => {
            const entry = pending.get(id);
            if (entry?.timer) clearTimeout(entry.timer);
            pending.delete(id);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const onAbort = () => {
            detach();
            reject(new Error('cocos bridge：调用已被取消'));
        };
        const timer = setTimeout(() => {
            detach();
            reject(new Error(`cocos bridge：编辑器在 ${DEFAULT_TIMEOUT_MS}ms 内没有回执（method=${method}）`));
        }, DEFAULT_TIMEOUT_MS);

        pending.set(id, {
            resolve: (value) => {
                detach();
                resolve(value);
            },
            reject: (error) => {
                detach();
                reject(error);
            },
            timer,
            detach,
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });

        try {
            process.send({ __tag: IPC_TAG, kind: 'req', id, method, params });
        } catch (error) {
            detach();
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

/**
 * 编辑器回执/事件的分发入口。
 * @param {unknown} message - 来自编辑器主进程的 IPC 消息。
 */
function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    const frame = /** @type {Record<string, any>} */ (message);
    if (frame.__tag !== IPC_TAG) return;

    if (frame.kind === CONTROL_KIND) {
        void handleControlFrame(frame);
        return;
    }
    if (frame.kind === 'res') {
        const entry = pending.get(frame.id);
        if (!entry) return;
        if (frame.ok === false) {
            // 失败原因可能在 `error`（编辑器侧显式带的），也可能只在 `result.text` 里
            // （工具回执的正文）。**两个都要看** —— 只看 `error` 的话，真实原因会被
            // 换成一句没有信息量的「编辑器返回失败」，模型只能靠猜。
            const fromResult = frame.result && typeof frame.result.text === 'string' ? frame.result.text.trim() : '';
            const reason = typeof frame.error === 'string' && frame.error.trim() ? frame.error.trim() : fromResult;
            entry.reject(new Error(reason || 'cocos bridge：编辑器返回失败（没有给出原因）'));
        } else entry.resolve(frame.result ?? { ok: true, text: '' });
        return;
    }
    if (frame.kind === 'evt') {
        for (const listener of listeners) {
            try {
                listener(frame.event, frame.data);
            } catch (error) {
                console.warn(`[cocos-bridge] 事件监听器抛错：${error instanceof Error ? error.message : error}`);
            }
        }
    }
}

process.on('message', onMessage);

// ---------------------------------------------------------------------------
// 控制通道（面板要干的活：继续历史会话 / 中断当前一轮）
// ---------------------------------------------------------------------------
//
// 三个方法：`session/resume`（继续历史会话）、`session/prompt`（往继续过的会话投喂）、
// `session/cancel`（**中断当前一轮**）。第三个的理由与第一个一模一样：
// SDK 协议表达不了「取消这一轮」，只有运行时内部的 `Agent.cancel()` 能。

/**
 * ## 为什么这个通道必须存在
 *
 * SDK profile 的协议只有三个方法（`initialize` / `session/prompt` / `shutdown`），
 * **没有「恢复某个历史会话」**：`session/prompt` 走的是 `agents.create`，也就是
 * 「用这个 id 新建一个会话」——模型那边没有任何历史上下文。
 *
 * 真正能恢复上下文的是运行时自己的 `agents.resume({resumeSessionId})`（`dsh --profile tui --resume <id>`
 * 就是它），而它只有**运行时内部**能调。本插件正跑在运行时里，所以由它来调：
 *
 * ```
 * 面板「继续此会话」 → 扩展主进程 → ctl session/resume {sessionId}
 *                                    → ctx.agents.resume({resumeSessionId})  → 拿到 AgentHandle
 * 之后这个会话的每一句话 → ctl session/prompt {sessionId, text} → handle.agent.followup(...)
 * ```
 *
 * **事件不用另开一条路**：SDK server 订阅的是 `ctx.on('session/event')`（全部会话，不只它自己建的），
 * 所以 resume 出来的会话的流式事件照样经 stdout 的 `session.event` 通知回到面板。
 *
 * ⚠ 两个服务（`agents` / `llm`）都不在我们的 `inject` 里 —— 用 `ctx.inject` 惰性挂：
 * 拿不到时只是**这个功能**不可用，三个工具照旧（工具是这个插件的主职，不能让附属功能拖垮它）。
 */

/** 面板「继续」过的会话：sessionId → AgentHandle。 */
const ownedSessions = new Map();

/** 运行时里的 agents 服务（`ctx.inject(['agents'])` 拿到；没有就是 null）。 */
let agentsService = null;

/** 插件的 ctx —— 附件库（`ctx.get('attachments')`）要现拿，所以记住它。 */
let runtimeCtx = null;

/**
 * 把面板发来的图片送进 DSH 的**附件库**，换成 `{type:'image', attachment}` 内容块。
 *
 * ## 为什么这一段必须在这里做
 *
 * 走 SDK 的 `session/prompt` 时，「base64 → 附件」这一步是**服务端**替我们做的
 * （`dsh-sdk-jsonrpc-server` 的 `durablePromptContent` → `admitEncodedImages`）。
 * 而「继续历史会话」这条路**根本不经过 SDK**：面板 → 扩展主进程 → 本插件的控制帧
 * → `handle.agent.followup(...)` —— 没有服务端插手，附件库就得我们自己送。
 *
 * ## 两条口径
 *
 * 1. **不 import `@deepseek-ai/dsh-attachment`**：那个包只提供
 *    `admitEncodedImages = (store, imgs) => store.saveImages(imgs.map(saveInput))`，
 *    也就是「解 base64 + 调服务的 `saveImages`」。自己写这三行，换掉的是一个
 *    **顶层静态 import** —— 万一某个 profile 没装那个包，静态 import 会让**整个插件
 *    （含四个工具）加载失败**，为了一条附属功能赔上主职，不划算。
 * 2. **base64 必须是规范形式**：附件库的解码器要求
 *    `Buffer.from(data,'base64').toString('base64') === data`（`INVALID_IMAGE_BASE64`），
 *    带换行/空格/`data:` 前缀的一律拒收。这里先判一次，好让错误说得清楚。
 *
 * @param {unknown} rawImages - 控制帧里的 `images`：`[{mimeType|mediaType, data, name?}]`。
 * @returns {Promise<Array<Record<string, unknown>>>} 可直接塞进 `createUserMessage` 的内容块。
 */
async function admitImages(rawImages) {
    if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
    const store = runtimeCtx?.get?.('attachments') ?? null;
    if (!store) {
        throw new Error(
            '这个 profile 没有挂附件库（attachments 服务），所以「接上来的历史会话」发不了图片。' +
                '请检查 profile 的 bundles（dsh-base 里有 attachment-local）后重启 agent。',
        );
    }

    const inputs = [];
    for (let index = 0; index < rawImages.length; index += 1) {
        const raw = rawImages[index] ?? {};
        const where = `第 ${index + 1} 张图`;
        const data = typeof raw.data === 'string' ? raw.data.trim() : '';
        const mediaType = String(raw.mediaType ?? raw.mimeType ?? '');
        if (!data) throw new Error(`${where}没有数据`);
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length === 0 || bytes.toString('base64') !== data) {
            throw new Error(`${where}的 base64 不是规范形式（不许有换行/空格/缓存前缀）`);
        }
        inputs.push({
            data: new Uint8Array(bytes),
            mediaType,
            ...(raw.name ? { name: String(raw.name) } : {}),
        });
    }

    const refs = await store.saveImages(inputs);
    return refs.map((ref) => ({ type: 'image', attachment: ref }));
}

/**
 * 继续一个历史会话（幂等：同一个 id 重复继续会复用已有的 handle）。
 *
 * @param {Record<string, any>} params - `{sessionId, provider, model, reasoningEffort?, maxTokens?}`。
 * @returns {Promise<Record<string, unknown>>} `{sessionId, agentId, reused?}`。
 */
async function resumeSession(params) {
    if (agentsService === null) {
        throw new Error(
            'agents 服务不可用 —— 这个 profile 没有加载 agent-loop，无法恢复会话。' +
                '（会话历史仍然可以查看，但不能接着聊。）',
        );
    }
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) throw new Error('session/resume 需要 sessionId');

    const existing = ownedSessions.get(sessionId);
    if (existing) return { sessionId, agentId: String(existing.agent.id), reused: true };

    /** @type {Record<string, unknown>} */
    const agentOptions = {
        provider: String(params.provider ?? 'deepseek-official'),
        model: String(params.model ?? 'deepseek-official'),
    };
    if (typeof params.reasoningEffort === 'string' && params.reasoningEffort) {
        agentOptions.reasoningEffort = params.reasoningEffort;
    }
    if (Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0) agentOptions.maxTokens = params.maxTokens;

    const handle = await agentsService.resume({ resumeSessionId: sessionId, agentOptions });
    ownedSessions.set(sessionId, handle);
    console.warn(`[cocos-bridge] 已继续会话 ${sessionId}（agent ${handle.agent.id}）`);
    return { sessionId, agentId: String(handle.agent.id), resumed: true };
}

/**
 * 找一个会话的 agent —— **两条来源都要看**。
 *
 * SDK 协议只有 `initialize` / `session/prompt` / `shutdown`，**没有「取消这一轮」**
 * （`SessionPromptResult` 是「入队回执」，`prompt()` 在 `followup()` 之后立刻返回，
 * 不等这一轮跑完）。所以「AI 思考到一半要中断」这件事，SDK 那条路根本表达不了，
 * 只能由**跑在运行时里的本插件**去做：`Agent.cancel(cause)`。
 *
 * 于是第一步是「拿到那个 Agent」，两种会话来源不同：
 *
 * | 会话怎么来的 | 谁持有 | 怎么取 |
 * |---|---|---|
 * | 面板普通会话（SDK `session/prompt`） | SDK 服务端 `ctx.agents.create()` | `agents.get(sessionId)` |
 * | 面板「继续此会话」（我们 `session/resume`） | 本插件 `ownedSessions` | 直接拿 handle.agent |
 *
 * ⚠ 两者**其实是同一个注册表**里的同一个对象（`agents.get(agent.id) === handle.agent`，
 * 见 `dsh-sdk-jsonrpc-server` 的 `assertLiveAgent`），先查自己持有的只是为了少一次查找。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {any} Agent；找不到返回 null。
 */
function findAgent(sessionId) {
    const owned = ownedSessions.get(sessionId);
    if (owned && owned.agent) return owned.agent;
    if (agentsService === null) return null;
    try {
        // `get` 是 AgentRegistry 的公开方法（`get(id: SessionId): Agent | undefined`）
        return typeof agentsService.get === 'function' ? agentsService.get(sessionId) ?? null : null;
    } catch (error) {
        console.warn(`[cocos-bridge] agents.get 失败：${error instanceof Error ? error.message : error}`);
        return null;
    }
}

/**
 * 中断当前这一轮（面板上那个「停止本轮」按钮）。
 *
 * ## 为什么是「取消这一轮」而不是「杀掉 agent」
 *
 * 面板原来的「停止」按钮停的是**整个 agent 进程**（会话、子 agent、工具全没了，
 * 下一句要重新启动 + 自动接上下文）。用户实际想要的多数时候是「这一轮别做了，我要改口」，
 * 那正是 `Agent.cancel()` 的语义：清掉排队与插话、中止当前这一轮，
 * **会话与上下文全留着**，下一句照样带着历史接着说。
 *
 * ## 三条口径
 *
 * 1. **没在跑就不算失败**：`agent.status !== 'running'` 时回 `{cancelled:false}` 而不是抛错 ——
 *    面板按下按钮与这一轮自己结束之间天然会有一拍竞争，把它报成红色错误是误报。
 * 2. **不停在 `ownedSessions` 上**：SDK 建的会话不由本插件持有，但它在同一个注册表里，
 *    `agents.get(sessionId)` 一样拿得到（见 {@link findAgent}）。
 * 3. **cause 用 `{kind:'user'}`**：这是运行时自己的口径（`AgentCancelCause`），
 *    与用户点了「中断」这件事对得上；`turn/end` 的 reason 会因此是 `aborted`。
 *
 * @param {Record<string, any>} params - `{sessionId}`。
 * @returns {Promise<Record<string, unknown>>} `{sessionId, agentId, cancelled, status}`。
 */
async function cancelSession(params) {
    if (agentsService === null) {
        throw new Error(
            'agents 服务不可用 —— 这个 profile 没有加载 agent-loop，无法中断。' +
                '（会话历史仍然可以查看，但没法控制它。）',
        );
    }
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) throw new Error('session/cancel 需要 sessionId');

    const agent = findAgent(sessionId);
    if (!agent) {
        throw new Error(
            `运行时里没有会话 ${sessionId} 的 agent（它可能已经结束，或不是本 profile 建的）。` +
                '先发一句话把它建起来，再中断。',
        );
    }

    const before = String(agent.status ?? '');
    if (before !== 'running') {
        // 竞态而非错误：按钮按下时这一轮可能刚好自己跑完了
        return { sessionId, agentId: String(agent.id), cancelled: false, status: before || 'idle' };
    }

    agent.cancel({ kind: 'user' });
    console.warn(`[cocos-bridge] 已请求中断会话 ${sessionId} 的当前一轮（agent ${agent.id}）`);
    return { sessionId, agentId: String(agent.id), cancelled: true, status: before };
}

/**
 * 控制方法分发表。
 *
 * @param {string} method - 方法名。
 * @param {Record<string, any>} params - 参数。
 * @returns {Promise<unknown>} 结果（会被原样回给扩展主进程）。
 */
async function controlMethod(method, params) {
    switch (method) {
        case 'ping':
            return {
                pid: process.pid,
                agents: agentsService !== null,
                cancel: agentsService !== null,
                owned: [...ownedSessions.keys()],
            };

        case 'session/resume':
            return resumeSession(params);

        case 'session/cancel':
            return cancelSession(params);

        case 'session/prompt': {
            const sessionId = String(params.sessionId ?? '');
            const handle = ownedSessions.get(sessionId);
            if (!handle) {
                throw new Error(
                    `会话 ${sessionId || '(空)'} 不由本插件持有，无法投喂（先 session/resume）。` +
                        '普通会话请走 SDK 的 session/prompt。',
                );
            }
            const content = [];
            const text = String(params.text ?? '');
            if (text) content.push({ type: 'text', text });
            // 图片：接上来的会话**没走 SDK 的 session/prompt**，所以附件库那一步也得我们自己来
            // （SDK 那条路是服务端的 `durablePromptContent` 干的活，见 dsh-sdk-jsonrpc-server）。
            for (const ref of await admitImages(params.images)) content.push(ref);
            if (content.length === 0) throw new Error('session/prompt：文本与图片都是空的');
            const message = createUserMessage({ content, source: { kind: 'user' } });
            handle.agent.followup(message);
            return { sessionId, messageId: message.id };
        }

        case 'session/dispose': {
            const sessionId = String(params.sessionId ?? '');
            const handle = ownedSessions.get(sessionId);
            if (!handle) return { disposed: false };
            ownedSessions.delete(sessionId);
            await handle.dispose();
            console.warn(`[cocos-bridge] 已释放会话 ${sessionId}`);
            return { disposed: true };
        }

        default:
            throw new Error(`未知控制方法 "${method}"`);
    }
}

/**
 * 处理一条控制帧并回执。
 * @param {Record<string, any>} frame - `{id, method, params}`。
 */
async function handleControlFrame(frame) {
    const id = frame.id;
    let reply;
    try {
        const result = await controlMethod(String(frame.method ?? ''), frame.params ?? {});
        reply = { __tag: IPC_TAG, kind: 'ctl-res', id, ok: true, result };
    } catch (error) {
        reply = {
            __tag: IPC_TAG,
            kind: 'ctl-res',
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    try {
        process.send(reply);
    } catch (error) {
        console.warn(`[cocos-bridge] 控制回执发送失败：${error instanceof Error ? error.message : error}`);
    }
}

/**
 * 两个工具共用的工具名片段与输出契约。
 *
 * 输出契约统一成 `{ok, text, data}`：
 * - `text` 是给模型看的**唯一**内容（编辑器那边的富结构不进上下文，避免噪音）；
 * - `data` 是结构化留档，不参与渲染（`type: 'json'` 只做标注，不进 JSON Schema 校验）。
 */
const OUTPUT = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            ok: { type: 'boolean', required: true, description: '编辑器侧是否成功执行' },
            text: { type: 'string', required: true, description: '给模型看的执行结果文本' },
            data: { type: 'json', description: '结构化原始结果（不给模型看，供面板/留档用）' },
        },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
};

const EXECUTE_CODE_DESCRIPTION = [
    '在 Cocos Creator 编辑器里执行一段 JavaScript，并拿到它的返回值。这是操作编辑器的**主工具**——不要找「创建节点」「查询资源」之类的专用工具，直接写代码。',
    '',
    '**动手前先查 API**：不确定属性名/方法名时先调 `cocos_describe_api`（运行时反射，永远比文档和记忆新）。猜属性名猜错一次就是一轮白跑。',
    '',
    '关键是 `context`：',
    "- `editor`（默认）—— 编辑器主进程（Node.js）。可用 `Editor`（Message/Profile/Project/App/Selection/Logger 全套）、`require`、`fs`、`path`、`os`、以及助手 `sleep / projectPath() / readJson(file) / listDir(dir)`。管**编辑器的事**：查改资源、工程设置、偏好、构建、日志。",
    '- `scene` —— 引擎场景进程。可用 `cc`（Node/Component/Asset/director/find 全套）、`director`、`scene`、`find`，以及助手 `nodeByUuid(uuid) / nodeByPath(\'Canvas/Panel\') / eachNode(fn) / tree({maxDepth}) / dump(node) / contentChildren(node) / isEditorNode(node) / captureView({savePath, maxWidth}) / loadFrame(ref) / worldRect(node, {root})`。管**场景的事**：读写节点、组件、预制体实例。',
    '⚠ **一定要显式写 `context`**。漏给时工具会按代码里的标识符猜（含 `cc`/`nodeByPath` 就当 scene），并在回执里用 `contextInferred` 注明 —— 猜错的表现是 `ReferenceError: cc is not defined` 这类**看不出是上下文选错**的错，别在那上面绕。',
    '',
    '两个把「已知必踩」封好的场景助手（别再手搓）：',
    "- `await loadFrame('db://assets/resources/textures/common/rect_rd_20.png')` → `SpriteFrame`。**别用 `cc.resources.load('…/spriteFrame')`**（编辑器场景上下文里必报 `Can not parse this input`）、也别手拼 `@f9941` 子资源 uuid（工具会读 `.meta` 自己解析）。也接受 `<uuid>@<子资源键>` 与裸 uuid。",
    '- `worldRect(node, { root })` → `{cx, cy, width, height, left, right, bottom, top}`，编辑态**可信**的世界矩形（由 `position` + `anchor` + `contentSize` 自洽累加而来）。**别用 `getBoundingBoxToWorld()`** —— 实测在编辑态给过自相矛盾的值（710×1074 的节点被报成 710×1170）。布局验收、重叠与越界检查都用它。',
    '',
    '参数用 `args` 传：`cocos_execute_code({context:"scene", code:"return { name: args.name }", args:{name:"x"}})`。同一段代码换参数复用走它，不要在代码里拼字符串。',
    '**改完节点树/布局要看画面**时用 `cocos_capture_view`（它把场景视图存成图片并回路径），不要靠坐标数字猜 —— 叠字、错位、贴图空白只有画面看得出。',
    '',
    '⚠ **沙箱是「防手滑」，不是安全边界**：`editor` 侧是 `vm` 起的新 realm（但 `require(\'process\')` 仍能拿到真的）；`scene` 侧**零隔离**（跑在宿主 realm）。这段代码是在**用户正开着的编辑器进程里**跑的，`editor` 上下文能读改工程文件、能访问网络。所以**只做用户要求的事** —— 别顺手扫盘、别碰工程外的路径、别把工程内容往外发。',
    '',
    '判别口诀：**改文件/查资源库 → editor；碰节点/组件 → scene。**',
    '',
    '写法：代码被包进 `(async () => { ... })()`，所以顶层可以直接 `return <值>`、可以直接 `await`。返回值深度 6 / 数组 100 项 / 对象 60 键 / 字符串 4000 字会被截断；cc 对象（Node/Component）会被压成 `[Node name=x uuid=y]` 摘要 —— 所以**在代码里筛完只 return 结论**（`return nodes.filter(...).map(n => n.name)`），要看细节用 `dump(node)` 或 `tree()`，不要 `return node`。`console.*` 不会污染编辑器控制台，会被收集进结果的 logs 里。',
    '',
    '场景树里混着编辑器自己的 gizmo / 网格 / 参考图（实测空场景 128 个节点里真实内容只有 2 个）：`eachNode` / `tree()` **默认按 HideInHierarchy 剪掉**，要连 gizmo 一起看就传 `includeEditor: true`；`nodeByPath` 是显式点名，不受剪枝影响。',
    '',
    '在 scene 上下文里改完场景（增删节点、改属性）后请传 `snapshot: true`，编辑器会登记一次撤销快照（Ctrl+Z 可回退）。',
    '（`snapshot: true` **不会**改变代码跑在哪个上下文 —— 它只是「跑完再登记一次撤销」；带 `cc` 的代码配上 `context: "scene"` 就是对的。）',
    '',
    '## 复用：别每次重新探索 —— 先找 recipe',
    '跑通了一段有价值的代码（建场景、批量改资源、按契约搭节点树…）就把它固化下来，下次（哪怕换了会话）直接跑：',
    '```js',
    "saveRecipe('create-2d-scene', `<刚才那段代码>`, { description: '从内部模板创建 2D 场景并打开', params: { name: '场景名' } });",
    "findRecipes('scene');              // 只回索引：名字/说明/参数/新鲜度",
    "readRecipe('create-2d-scene');     // 按需取源码，想改写就改",
    "await runRecipe('create-2d-scene', { name: 'BossArena' });",
    '```',
    '存放处：`<工程根>/.dsh-mcp/recipes/*.js`（**建议入库**，团队共享）。`findRecipes` 回的 `daysSinceVerified` 是判断新鲜度的唯一依据：超过 30 天没跑通的，**先 `readRecipe` 看一眼再跑** —— 过期的路径/API 比没有 recipe 更坑。',
    '⚠ **不是跑通了就能存**：`saveRecipe` 有复用门禁 —— 必须写 `description` 与 `returns`，`params` 里声明的参数代码里得真的用上，代码里不许有具体 uuid / 绝对路径 / `.tmp/`（那些该走 `args`）。被拒时它会告诉你缺什么。只对这一次成立的结果，直接 `return` 出来就好，不用落盘。',
    '引擎 API 的用法**不要**存成 recipe，那是 `cocos_describe_api` 的活（存了必然过期）。',
].join('\n');

const CAPTURE_VIEW_DESCRIPTION = [
    '把**编辑器场景视图**当前一帧截成图片文件，返回文件路径。',
    '',
    '## 什么时候用',
    '- 你刚在 scene 上下文里搭完/改了节点树、布局、UI，想知道**看起来对不对**（叠字、错位、贴图空白、一屏只剩个角……）。坐标数字看不出这些，一张图能。',
    '- 用户说「画面不对」「看不见」「位置偏了」时，**先截一张自己看**再决定改什么；不要拿一串 rect 去猜，也不要把用户当验图工具。',
    '',
    '## 截的是什么',
    '编辑器**场景视图**（你正开着的那块），所见即所得：含网格与 gizmo。**不是**运行时/游戏预览画面。',
    '',
    '## 参数',
    '- `savePath`：存到哪（绝对路径）。默认写系统临时目录 `dsh-cocos-captures/`。',
    '- `maxWidth`：缩放到最大宽度，默认 640。看清布局足够，也回传得快。',
    '- `format` / `quality`：`png`（默认，无损）或 `jpeg`；`quality` 只对 jpeg 生效。',
    '- `waitMs`：等下一帧的上限（默认 800ms）。场景视图没在渲染时直接抓当前缓冲。',
    '',
    '## 返回',
    '`{ ok, path, width, height, sourceWidth, sourceHeight, format, bytes, blankRatio }`。',
    '- 拿 `path` 用你的图片读取能力**看一眼** —— 这才是本工具的用途。',
    '- `blankRatio` 接近 1 表示基本是张空图：场景视图可能被遮挡/最小化，或刚发生过重载，等一会儿再截一次。',
    '',
    '## 前置条件',
    '需要**开着场景**（场景进程里加载了扩展脚本）。没开场景时会明确说要先打开一个场景。',
].join('\n');

const EDITOR_STATE_DESCRIPTION = [    '看一眼编辑器现在是什么状态：工程路径、编辑器版本、当前场景、当前选中的节点/资源、已启用的相关扩展。',
    '',
    '什么时候用：动手之前先确认「我在哪个工程、哪个场景、选中了什么」；或者用户说「这个节点」「当前选中的」时，先调这个把指代落实。**不要**每轮都调——它是按需的自检工具，不是上下文注入。',
    '',
    '返回值末尾会给「下一步该用什么工具」的几条建议（含可直接改写的代码样例），会话开头看一次能少走几轮试错。',
].join('\n');

const DESCRIBE_API_DESCRIPTION = [
    '渐进式披露：按需查一个 API 定义，**不要**指望一次加载全部 API，也不要靠猜写代码。写代码前不确定属性名就先调它——这是运行时反射，永远比文档/记忆新。',
    '',
    '`context` 与 `target` 的组合：',
    '',
    '`context: "editor"`',
    "- `target` 省略 → 列出 `Editor` 下所有命名空间与各自方法数，外加常用调用速查",
    "- `target: 'Editor.Message'` / `'Editor.Profile'` / 任意 `Editor.Xxx` → 该命名空间的方法与字段全表",
    "- `target: 'helpers'` → 编辑器沙箱里的助手函数签名（含 recipe 五件套）",
    "- `target: 'module:fs'` / `'module:path'` → require 一个 node 模块并列出它的导出",
    '',
    '`context: "scene"`',
    '- `target` 省略 → `cc` 模块的顶层导出清单 + 场景侧助手函数签名',
    "- `target: 'helpers'` → 场景沙箱助手签名",
    "- `target: 'cc.Camera'` → 生成该类的 TS 风格定义（属性名 + 推断类型 + 可调用方法）",
    "- `target: 'cc.Camera'` 且带 `nodeUuid` → 用节点上的**实时实例**补出真实类型与当前值",
    '',
    '典型工作流（discover → act）：',
    "1. `cocos_execute_code({context:'scene', code:'return tree({maxDepth:2, withComponents:true})'})` → 看清层级，找到目标节点的 uuid",
    "2. `cocos_describe_api({context:'scene', target:'cc.Camera', nodeUuid:'<刚拿到的 uuid>'})` → 拿到真实属性名与类型",
    "3. `cocos_execute_code({context:'scene', code:'...按刚学到的属性名精确改...', snapshot:true})` → 一次改对，不用猜",
    '',
    '为什么 scene 侧要传 `nodeUuid`：Cocos 的属性存在 `__props__` 里，`@property` 的装饰器信息在运行时对象上、不在原型上。给它一个真实的组件实例，才能读出「属性名 + 当前值」。',
    '',
    '⚠ scene 侧需要场景进程已经加载了扩展脚本（也就是**开着场景**）；没开场景时这一档会明确说「先去打开一个场景」，不会给你一个看不懂的内部错误。',
].join('\n');

/**
 * 注册插件：把三个原生工具挂到 `ctx.tools`。
 *
 * @param {any} ctx - 注入了 `tools` 的 Cordis 上下文。
 */
export function apply(ctx) {
    runtimeCtx = ctx;
    if (!hasIpc()) {
        // 不是错误：用户完全可能从终端跑这个 profile 做别的调试。给一条清楚的提示就行。
        console.warn(
            '[cocos-bridge] 当前进程没有 IPC 通道（不是由 Cocos 扩展 fork 的），cocos_* 工具会在调用时明确报错。',
        );
    }

    ctx.tools.register(
        defineTool({
            name: 'cocos_execute_code',
            description: EXECUTE_CODE_DESCRIPTION,
            parameters: {
                code: { type: 'string', required: true, description: '要执行的 JavaScript。顶层可直接 return / await。' },
                context: {
                    type: 'string',
                    enum: ['editor', 'scene'],
                    description:
                        'editor=编辑器主进程（改文件/查资源库）；scene=引擎场景进程（碰节点/组件）。**建议每次都显式给**；漏给时编辑器侧会按代码里的标识符推断（含 cc / nodeByPath 就当 scene）并在回执里注明 contextInferred。',
                },
                args: {
                    type: 'object',
                    // 自由形状的对象（键由调用方定）。桥接的工具 schema 要求显式写这一项，
                    // 写成 false 会把所有键都判成非法 —— 那就等于没这个参数。
                    additionalProperties: true,
                    description:
                        '注入沙箱的 `args` 变量（对象）。同一段代码换参数复用时用它，不要在代码里拼字符串。',
                },
                timeoutMs: { type: 'number', description: '超时毫秒，默认取编辑器侧设置（15000）。' },
                snapshot: { type: 'boolean', description: '为 true 时在 scene 上下文执行成功后登记一次撤销快照。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall(
                    'execute_code',
                    {
                        // ⚠ **不要把缺失的 context 兜成 'editor'**：编辑器侧靠这个字段的
                        // 「有没有给」来决定「要不要按代码推断」（`engine.executeCode`）。
                        // 这里静默兜一个默认值，那边就永远看不到「模型漏写了」这个事实，
                        // 于是又回到「漏给 → 跑 editor → ReferenceError: cc is not defined」
                        // 那条把模型坑了 10 步的老路。原样透传，判定只留一处。
                        context: args.context,
                        code: args.code,
                        // `args` 必须一路透传到沙箱，少传一层模型看到的就是
                        // `reading 'x' of undefined`（很难查）
                        args: args.args && typeof args.args === 'object' ? args.args : {},
                        timeoutMs: args.timeoutMs,
                        snapshot: args.snapshot === true,
                    },
                    exec?.signal,
                );
                return {
                    ok: result.ok !== false,
                    text: typeof result.text === 'string' ? result.text : String(result.text ?? ''),
                    ...(result.data === undefined ? {} : { data: result.data }),
                };
            },
            presentCall: (args) => ({
                card: 'generic',
                title: `Cocos: 执行代码（${args.context === 'scene' ? 'scene' : args.context === 'editor' ? 'editor' : 'context 未给'}）`,
                kind: 'other',
                rawInput: args.code,
            }),
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'cocos_capture_view',
            description: CAPTURE_VIEW_DESCRIPTION,
            parameters: {
                savePath: {
                    type: 'string',
                    description: '保存到的绝对路径；默认写系统临时目录 dsh-cocos-captures/。目录不存在会自动创建。',
                },
                maxWidth: { type: 'number', description: '缩放到的最大宽度，默认 640。越小越快。' },
                format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
                quality: { type: 'number', description: 'jpeg 质量 0.1~1，默认 0.9。' },
                waitMs: { type: 'number', description: '等下一帧的上限（毫秒），默认 800。' },
                timeoutMs: { type: 'number', description: '整个截图的超时（毫秒），默认取编辑器侧设置（15000）。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall(
                    'capture_view',
                    {
                        savePath: args.savePath,
                        maxWidth: args.maxWidth,
                        format: args.format,
                        quality: args.quality,
                        waitMs: args.waitMs,
                        timeoutMs: args.timeoutMs,
                    },
                    exec?.signal,
                );
                return {
                    ok: result.ok !== false,
                    text: typeof result.text === 'string' ? result.text : String(result.text ?? ''),
                    ...(result.data === undefined ? {} : { data: result.data }),
                };
            },
            presentCall: (args) => ({
                card: 'generic',
                title: `Cocos: 截场景视图${args && args.maxWidth ? `（≤${args.maxWidth}px）` : ''}`,
                kind: 'other',
                rawInput: args && args.savePath ? String(args.savePath) : '',
            }),
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'cocos_editor_state',
            description: EDITOR_STATE_DESCRIPTION,
            parameters: {
                verbose: { type: 'boolean', description: '为 true 时额外列出启用的扩展与资源库摘要。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall('editor_state', { verbose: args.verbose === true }, exec?.signal);
                return {
                    ok: result.ok !== false,
                    text: typeof result.text === 'string' ? result.text : String(result.text ?? ''),
                    ...(result.data === undefined ? {} : { data: result.data }),
                };
            },
            presentCall: () => ({
                card: 'generic',
                title: 'Cocos: 看一眼编辑器状态',
                kind: 'other',
            }),
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'cocos_describe_api',
            description: DESCRIBE_API_DESCRIPTION,
            parameters: {
                context: {
                    type: 'string',
                    enum: ['editor', 'scene'],
                    description: '查哪一侧的 API。editor=编辑器主进程（Editor.* / node 模块）；scene=引擎（cc.*）。默认 editor。',
                },
                target: {
                    type: 'string',
                    description:
                        "要查的目标。editor：'Editor.Message' / 'helpers' / 'module:fs'，省略则给总览。scene：'cc.Camera' / 'helpers'，省略则给总览。",
                },
                nodeUuid: { type: 'string', description: 'scene 专用：用该节点上的实时组件实例补出真实类型与当前值。' },
                limit: { type: 'number', description: '最多列多少项，默认 80。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall(
                    'describe_api',
                    {
                        context: args.context === 'scene' ? 'scene' : 'editor',
                        target: args.target,
                        nodeUuid: args.nodeUuid,
                        limit: args.limit,
                    },
                    exec?.signal,
                );
                return {
                    ok: result.ok !== false,
                    text: typeof result.text === 'string' ? result.text : String(result.text ?? ''),
                    ...(result.data === undefined ? {} : { data: result.data }),
                };
            },
            presentCall: (args) => ({
                card: 'generic',
                title: `Cocos: 查 API（${args.context === 'scene' ? 'scene' : 'editor'} / ${args.target || '总览'}）`,
                kind: 'other',
                rawInput: String(args.target ?? ''),
            }),
        }),
    );

    /**
     * 控制通道：惰性挂 `agents`（详见文件上半部分那段「控制通道」）。
     *
     * 用 `ctx.inject` 而不是写进 `inject: ['tools', 'agents']`：后者一旦拿不到 agents，
     * **整个插件**（含四个工具）都不会加载。工具是主职，不能被附属功能绑架。
     *
     * 附件库（`attachments`）不在这里 inject —— 它只在**发图片**那一刻才需要，
     * 所以 `admitImages` 里现用现取（`ctx.get('attachments')`），拿不到就只让那一次发送失败。
     */
    ctx.inject(['agents'], (agentCtx) => {
        agentsService = agentCtx.agents ?? agentCtx.get('agents') ?? null;
        console.warn('[cocos-bridge] 控制通道就绪（可以继续历史会话）');
        return () => {
            agentsService = null;
            ownedSessions.clear();
        };
    });

    // ⚠ 一律走 stderr（console.warn）：SDK profile 的 **stdout 专属于 JSON-RPC 帧**，
    // 任何 console.log 都会插进协议流里（实测踩过一次）。
    console.warn(
        '[cocos-bridge] 已注册原生工具：cocos_execute_code / cocos_describe_api / cocos_editor_state / cocos_capture_view',
    );
}
