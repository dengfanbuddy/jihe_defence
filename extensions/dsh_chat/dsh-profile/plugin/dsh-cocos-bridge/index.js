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
 * ## 五个工具 = 编辑器能力面（工具部分）
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `cocos_execute_code` | 在编辑器主进程（vm 沙箱）或引擎场景进程里跑一段代码 |
 * | `cocos_describe_api` | 渐进式披露：查编辑器/引擎 API，**别猜** |
 * | `cocos_editor_state` | 自检：我在哪个工程/场景、选中了什么、沙箱能不能动场景 |
 * | `cocos_capture_view` | 场景视图 / **某个节点**截图 → 图片文件（像素塞不进返回值，只能落盘回路径） |
 * | `cocos_logs` | 读工程里的**日志文件**（路径 + 行号 + 原文）。控制台里的字代码拿不到，只能另开一条通道 |
 *
 * 每个工具的回执里还会带一段 `refs`（结果里出现过的全形 uuid / `db://` 路径，去重后列在文案结尾）
 * —— 由编辑器侧的 `withRefs` 统一补，见 `source/cocos-tools.ts`。它只做搬运，不做判断。
 *
 * ⚠ **这里的每段 description 都是模型唯一的说明书。** DSH 不消费 MCP 的
 * `initialize.instructions`，所以用法要点（别猜 API、recipe 五件套、gizmo 剪枝、
 * 返回值上限）必须搬进工具描述里 —— 否则模型看不到，等于没写。
 * 这也是为什么下面几段文字比一般工具描述长得多。
 *
 * ## 除了工具，本插件还管两条**给面板用的**通道
 *
 * | 通道 | 方向 | 干什么 |
 * |---|---|---|
 * | 控制帧 `kind:'ctl'` / `'ctl-res'` | 编辑器 → 插件 → 编辑器 | 继续历史会话、中断当前一轮、投喂消息、**借宿主的两个面向人的注册表**（斜杠命令 / `@路径` 候选）——SDK 协议表达不了的那些 |
 * | 交互帧 `kind:'ask'` + 控制帧 `interaction/answer` | **插件主动**发起 → 面板作答 | 替两个 waterfall 当应答者：模型提问 / 授权请求 / 计划评审（详见文件下半部分） |
 *
 * 两条都不服务模型，也不占端口 —— 只是把「人机之间那几次必须由人拍板的时刻」接回面板。
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

/**
 * 插件的 ctx。
 *
 * 只用来两件事：挂交互应答者（`ctx.on`）与**登记服务注入**（`hostService`）。
 * ⚠ 别拿它 `ctx.get('某个服务')` —— 那样取恒为 undefined，见 `hostService` 上面那一大段。
 */
let runtimeCtx = null;

/**
 * 「现用现取」拿到的服务：服务名 → 实例（没挂时是 null）。
 *
 * 为什么要缓存：`hostService` 里那次 `ctx.inject` 是**注册一个子 fiber**，
 * 不是每次调用都能跑一遍的东西。第一次调用时注册，回调把实例放进来。
 */
const hostServices = new Map();

/** 上面那个缓存是**按 ctx** 的：换了 ctx（`apply()` 又跑了一次）就整个作废。 */
let hostServicesCtx = null;

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
 *
 *    ⚠ 附件库是**注入**拿的（`hostService('attachments')`），不是 `ctx.get` ——
 *    这里以前写的是 `runtimeCtx.get('attachments')`，而它在真运行时**恒为 undefined**
 *    （见 `hostService` 上面那一大段），于是「接上来的会话发图」一直报「本 profile 没挂附件库」。
 *    本地测试没抓到是因为 `verify-bridge` 喂的是**假 ctx**（假的 `get` 什么都给），
 *    真运行时才暴露 —— 现在由 `scripts/verify-profile-rows.js` 盯住这条取值路。
 * 2. **base64 必须是规范形式**：附件库的解码器要求
 *    `Buffer.from(data,'base64').toString('base64') === data`（`INVALID_IMAGE_BASE64`），
 *    带换行/空格/`data:` 前缀的一律拒收。这里先判一次，好让错误说得清楚。
 *
 * @param {unknown} rawImages - 控制帧里的 `images`：`[{mimeType|mediaType, data, name?}]`。
 * @returns {Promise<Array<Record<string, unknown>>>} 可直接塞进 `createUserMessage` 的内容块。
 */
async function admitImages(rawImages) {
    if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
    const store = hostService('attachments');
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

// ---------------------------------------------------------------------------
// 服务通道：把宿主自己的两个**面向人的**注册表借给面板用
// ---------------------------------------------------------------------------
//
// ## 为什么是这两个
//
// DSH 的「人能直接用的东西」有两条，它们的**生产方全在宿主**，但消费方原本只有
// 浏览器那一半（`dsh-client-ui-commands` / `dsh-client-ui-reference`，长在 `dsh-web-app` 里）：
//
// | 注册表 | 谁注册 | 宿主服务 | 原本谁在用 |
// |---|---|---|---|
// | 斜杠命令 `ctx.commands` | `/compact` `/plan` `/goal` `/feedback` 等各插件 | `@deepseek-ai/dsh-commands`（base 里有） | 浏览器命令面 |
// | `@路径` 候选 `ctx.fileReferences` | `@deepseek-ai/dsh-file-reference-local` | 同左 | 浏览器输入框 |
//
// SDK 协议（`initialize` / `session/prompt` / `shutdown`）**一个都表达不了**，
// 而本插件就长在运行时里 —— 所以由它把这两个服务**按 agent 转发**给面板。
//
// ## 三条口径
//
// 1. **惰性取服务**（`ctx.get`），不写进 `inject: [...]`：行没挂时只是这两个功能不可用，
//    **四个 `cocos_*` 工具照旧**（与附件库、交互通道同一条理由）。
// 2. **命令走注册表自己的分派，不自己解析**：`parseCommand` 的语法（第 0 字节斜杠、
//    小写名、名字后全是 `rawInput`）由 `ctx.commands.execute` 拥有，我们抄一份必然漂移。
//    它返回 `undefined` = 「语法不合法或名字不认识」—— 这与「命令跑了但报错」是**两件事**，
//    面板要能分辨，所以回执里用 `known` 区分。
// 3. **不替命令收图片**：`execute` 的第三个参数是附件库的 `EncodedImageAttachment`。
//    面板现在只在**普通消息**上带图（命令面没有图片入口），所以一律传空数组；
//    真要支持 `/plan <图>` 时再补 —— 那时要连 `admitImages` 一起复用，别另写一条。
//
// ⚠ 命令的**结果文本不会进模型历史**（注册表把它记成 `command/run` + `command/done` 两条
//    仅写日志的事件）—— 所以面板把结果画在自己的气泡里，而不是当成助手消息。
//    顺带：这两条事件会经 `session.event` 回到面板，所以**命令结果有两条到面板的路**
//    （控制回执 + 日志事件）。面板以**控制回执**为准（它带 `known`/`kind` 的结构），
//    日志事件只用来在刷新后骨牌回放（见 `dsh-host.ts` 的 `command/done` 分支）。

/**
 * 惰性取一个宿主服务。
 *
 * ⚠ **`ctx.get(name)` 在这里是取不到东西的**（实测，见下）—— 必须用 `ctx.inject` 捕获：
 *
 * ```js
 * ctx.get('tools')          // → undefined   ← 服务明明在
 * ctx.inject(['tools'], (c) => c.tools)  // → 服务实例
 * ```
 *
 * 这个坑值得写一大段，因为它**静默**：`ctx.get()` 不报错，只回 `undefined`，
 * 于是每一处「现用现取」的代码都表现成「这个 profile 没挂那个服务」——
 * 一句听起来很像配置问题的话，实际是取值方式错了。
 *
 * cordis 的 `Context.get` 文档写的是「without the inject requirement」，但那读的是
 * **fiber 自己的 store**（只装它 inject 过的东西），不是整条上下文链。
 * `scripts/verify-profile-rows.js` 就是为此存在的：真起一次 profile，
 * 对每个服务同时跑两条取值路，把结果摆出来。2026-12 靠它抓到了两处（本插件的
 * `attachments` 与 `commands` / `fileReferences`）。
 *
 * 每个服务**单独一次 `ctx.inject`**（而不是一次 inject 一串）：一次 inject 是
 * 「全都要」——只要有一个行没挂，回调根本不跑，于是**能用的那个也一起废掉**。
 * 分开来，少哪个只影响哪个功能。
 *
 * @param {string} name - 服务名。
 * @returns {any} 服务实例；没挂时为 null。
 */
function hostService(name) {
    if (runtimeCtx === null) return null;
    // ⚠ 缓存是**按 ctx** 的：本模块的状态是进程级的，而 `apply()` 可能被跑不只一次
    // （profile 热重载、或者测试里连着 apply 好几个假 ctx）。不跟着 ctx 作废的话，
    // 第二次注册注入会被「已经有缓存了」跳过，于是新 ctx 上永远拿不到服务。
    if (hostServicesCtx !== runtimeCtx) {
        hostServices.clear();
        hostServicesCtx = runtimeCtx;
    }
    if (!hostServices.has(name)) {
        hostServices.set(name, null);
        try {
            runtimeCtx.inject([name], (scoped) => {
                const found = scoped?.[name] ?? null;
                hostServices.set(name, found);
                if (found === null) {
                    console.warn(`[cocos-bridge] 服务 ${name} 的注入回调跑了，但拿到的还是空 —— 请把这条报给插件作者`);
                }
                return () => {
                    hostServices.set(name, null);
                };
            });
        } catch (error) {
            console.warn(`[cocos-bridge] inject ${name} 失败：${error instanceof Error ? error.message : error}`);
        }
    }
    return hostServices.get(name) ?? null;
}

/**
 * 按 sessionId 找 agent，找不到就说人话。
 *
 * @param {unknown} rawSessionId - 面板给的 sessionId。
 * @returns {any} Agent 实例。
 */
function requireAgent(rawSessionId) {
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) throw new Error('这个控制方法需要 sessionId');
    const agent = findAgent(sessionId);
    if (!agent) {
        throw new Error(
            `运行时里没有会话 ${sessionId} 的 agent（它可能已经结束、或属于别的 profile）。` +
                '先发一句话把它建起来再试。',
        );
    }
    return agent;
}

/** 斜杠命令一次最多回给面板多少条（面板是个窄抽屉，再多也画不下）。 */
const COMMAND_LIMIT = 120;

/** `@` 候选一次最多回给面板多少条（与 `file-reference-local` 的 maxResults 独立，这里是**跨 IPC 的上限**）。 */
const REFERENCE_LIMIT = 40;

/** 单条候选路径的长度上限（跨 IPC 的载荷要收敛，别让一条超长路径把面板的列表撑爆）。 */
const REFERENCE_PATH_MAX = 400;

/**
 * 列出当前 agent 能用的斜杠命令。
 *
 * @param {Record<string, any>} params - `{sessionId}`。
 * @returns {Promise<Record<string, unknown>>} `{commands: [{name, description, input?}]}`。
 */
async function listCommands(params) {
    const commands = hostService('commands');
    if (!commands) {
        throw new Error(
            '这个 profile 没有挂命令注册表（commands 服务）。' +
                '请检查 profile 的 bundles（dsh-base 里有 commands）后重启 agent。',
        );
    }
    const agent = requireAgent(params.sessionId);
    const descriptors = commands.list(agent) ?? [];
    return {
        commands: descriptors.slice(0, COMMAND_LIMIT).map((descriptor) => {
            /** @type {Record<string, unknown>} */
            const view = {
                name: String(descriptor.name ?? ''),
                description: String(descriptor.description ?? ''),
            };
            const hint = descriptor.input && typeof descriptor.input.hint === 'string' ? descriptor.input.hint : '';
            if (hint) view.hint = hint;
            if (descriptor.input && descriptor.input.images === true) view.images = true;
            return view;
        }),
        total: descriptors.length,
    };
}

/**
 * 执行一条斜杠命令行。
 *
 * @param {Record<string, any>} params - `{sessionId, line}`。
 * @returns {Promise<Record<string, unknown>>} `{known, commandId?, kind?, text?}`。
 */
async function runCommand(params) {
    const commands = hostService('commands');
    if (!commands) {
        throw new Error(
            '这个 profile 没有挂命令注册表（commands 服务）。' +
                '请检查 profile 的 bundles（dsh-base 里有 commands）后重启 agent。',
        );
    }
    const agent = requireAgent(params.sessionId);
    const line = String(params.line ?? '').trim();
    if (!line.startsWith('/')) throw new Error('斜杠命令必须以 "/" 开头');
    if (line.length > 2000) throw new Error('斜杠命令太长了（上限 2000 字符）');

    // 用注册表自己的语法判定：`undefined` = 语法不合法或名字不认识（**两类都算 known:false**）。
    // 这条与「命令跑了但返回 error」是两件事，面板的显示不一样，所以必须分开。
    const execution = await commands.execute(agent, line, [], new AbortController().signal);
    if (execution === undefined) return { known: false, line };

    const result = execution.result ?? {};
    return {
        known: true,
        commandId: String(execution.commandId ?? ''),
        kind: result.kind === 'error' ? 'error' : 'success',
        text: typeof result.text === 'string' ? result.text : '',
    };
}

/**
 * 列 `@路径` 候选（`@` 补全）。
 *
 * @param {Record<string, any>} params - `{sessionId, query}`。
 * @returns {Promise<Record<string, unknown>>} `{candidates: [{path, kind}]}`。
 */
async function listFileReferences(params) {
    const references = hostService('fileReferences');
    if (!references) {
        throw new Error(
            '这个 profile 没有挂文件引用服务（fileReferences）。' +
                '请检查 profile 的 cordis.patch.yml 里有没有 file-reference / file-reference-local 两行，然后重启 agent。',
        );
    }
    const agent = requireAgent(params.sessionId);
    const query = String(params.query ?? '').slice(0, 400);
    const candidates = await references.list(agent, query, new AbortController().signal);
    const list = [];
    for (const candidate of candidates ?? []) {
        const path = String(candidate?.path ?? '');
        if (!path || path.length > REFERENCE_PATH_MAX) continue;
        list.push({ path, kind: candidate?.kind === 'directory' ? 'directory' : 'file' });
        if (list.length >= REFERENCE_LIMIT) break;
    }
    return { candidates: list, query };
}

// ---------------------------------------------------------------------------
// 交互通道：替运行时的两个 waterfall 当**应答者**
// ---------------------------------------------------------------------------
//
// ## 它解决什么
//
// `@deepseek-ai/dsh-user-questions` 与 `@deepseek-ai/dsh-user-approval` 都是
// **cordis waterfall**：谁来回答，取决于**有没有人挂监听**。DSH 自带的应答者
// 只有浏览器客户端那一半（`dsh-client-ui-user-questions` / `dsh-client-ui-approval`），
// 它们长在 `dsh-web-app` 这个 bundle 里 —— 而本 profile（`dsh-sdk-app`）不挂它。
//
// 后果（三条症状、一个根因）：
//
// | 症状 | 机制 |
// |---|---|
// | 模型 `ask_user_question` 反问你 → 工具报 `NO_PROVIDER` | `dsh-user-questions` 的兜底是 `noAnswerer` |
// | 需要授权的操作 → 一律被拒（你连"它问过我"都看不到） | `dsh-user-approval` 的兜底是 `"unavailable"`（fail closed） |
// | 计划模式出不来（`exit_plan_mode` 报"评审通道不可用"） | `dsh-plan-mode` 走的就是 `userQuestions` |
//
// 所以本插件在这两个 waterfall 上挂一个应答者，把请求经**已有的 fork IPC**
// 转给编辑器面板，等人按下按钮再把结果还回去：
//
// ```
// 运行时 waterfall ──► 本插件 ctx.on('…/request') ──► process.send({kind:'ask', phase:'open'})
//                                                          │
//   面板（人点按钮）──► 扩展主进程 ──► {kind:'ctl', method:'interaction/answer'} ──┘
// ```
//
// ## 四条口径
//
// 1. **拿不到面板就立刻委派**（`next()`），不是干等 —— 编辑器的面板没开、
//    或者从终端直接跑这个 profile 时，行为必须与加这段代码之前**完全一致**
//    （提问报错、授权拒绝）。这一条由扩展主进程把关（它会看面板最近有没有在轮询），
//    本插件只负责「等到一个决定，或者等到被取消」。
// 2. **不设自己的超时**：请求带 `signal`（这一轮被取消 / 工具调用超时时它会 abort），
//    到点就撤下问题并抛取消 —— 与浏览器客户端的行为一致。自己再定一个超时
//    只会制造「面板还开着但问题自己消失了」这种更难查的现象。
// 3. **不 import 那两个包**：与「不 import 附件库」同一条口径 —— 静态 import 一旦
//    解析失败，**整个插件**（含四个 `cocos_*` 工具）都不会加载。取消的错误形状
//    手写成 `{name:'UserQuestionError', code:'ASK_CANCELLED'}` 即可：`ask()` 里那句
//    `restoreUserQuestionError` 是按名字+code 认的，不要求 instanceof。
// 4. **载荷只过 JSON 能表达的东西**：`Agent` 对象与 `AbortSignal` 都不能跨 IPC，
//    所以只投影出 `agentId` / `sessionId` 这些字符串，供面板显示「是谁在问」。

/**
 * 在飞的交互：id → `{resolve, reject}`。
 *
 * 一般同时只有一条（模型一次问一件事），但子 agent 的授权请求可能与主会话的提问重叠，
 * 所以用 Map 记账、面板那边并排画 —— 比「排队等着」少一个看不见的坑。
 */
const askPending = new Map();

/** 交互 id 的自增序号（与 pid 拼成全局唯一）。 */
let askSeq = 0;

/** 授权请求的**全部**合法结果（`ApprovalOutcome`，运行时自己的词表）。 */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * 发一条交互帧给编辑器（`kind: 'ask'`，与工具帧 `req`、控制帧 `ctl` 分开）。
 *
 * ⚠ **`kind` 必须最后写**：`frame` 里带着业务字段 `kind`（`'question'` / `'approval'`），
 * 先展开它就会被它盖掉路由标签 —— 编辑器那侧按 `kind === 'ask'` 分流，盖掉了就**整条路静默失效**
 * （现象：面板上永远不出现卡片、模型一直等）。实测踩过一次，`verify-bridge` 里有一条专门盯它。
 *
 * @param {Record<string, unknown>} frame - `{phase, id, …}`。
 */
function sendAskFrame(frame) {
    try {
        process.send({ ...frame, __tag: IPC_TAG, kind: 'ask' });
    } catch (error) {
        console.warn(`[cocos-bridge] 交互帧发送失败：${error instanceof Error ? error.message : error}`);
    }
}

/**
 * 把运行时给的 Agent 投影成面板要的两行字（对象本身跨不了 IPC）。
 *
 * @param {Record<string, any>} request - waterfall 的请求载荷。
 * @returns {Record<string, string>} `{agentId?, sessionId?}`。
 */
function identify(request) {
    const agent = request && typeof request === 'object' ? request.agent : undefined;
    const out = {};
    if (agent && typeof agent.id === 'string' && agent.id) out.agentId = agent.id;
    const sessionId = agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : '';
    if (sessionId) out.sessionId = sessionId;
    return out;
}

/**
 * 把 `AskUserQuestionItem[]` 原样投影成 JSON（丢掉方法、保持字段名）。
 *
 * 字段名**不许改**：面板那边是按 `AskUserQuestionItem` 的契约画的
 * （`id` / `question` / `detail` / `header` / `options[{label,description}]` /
 * `multiSelect` / `intent{kind,approve}`），改一个就要改两处。
 *
 * @param {Record<string, any>} request - `{questions: AskUserQuestionItem[]}`。
 * @returns {Array<Record<string, unknown>>} 可直接过 IPC 的问题列表。
 */
function projectQuestions(request) {
    const questions = request && Array.isArray(request.questions) ? request.questions : [];
    return questions.slice(0, 8).map((question) => {
        const item = question && typeof question === 'object' ? question : {};
        const options = Array.isArray(item.options)
            ? item.options.slice(0, 12).map((option) => {
                  const entry = option && typeof option === 'object' ? option : {};
                  return {
                      label: String(entry.label ?? ''),
                      ...(entry.description === undefined ? {} : { description: String(entry.description) }),
                  };
              })
            : undefined;
        const intent = item.intent && typeof item.intent === 'object' ? item.intent : undefined;
        return {
            id: String(item.id ?? ''),
            question: String(item.question ?? ''),
            ...(item.detail === undefined ? {} : { detail: String(item.detail) }),
            ...(item.header === undefined ? {} : { header: String(item.header) }),
            ...(options === undefined ? {} : { options }),
            ...(item.multiSelect === true ? { multiSelect: true } : {}),
            ...(intent === undefined ? {} : { intent: { kind: String(intent.kind ?? ''), approve: String(intent.approve ?? '') } }),
        };
    });
}

/**
 * 「面板上关掉提问」= 用户在抢话。
 *
 * 形状照抄 `dsh-user-questions` 的 `UserQuestionError`（见本节口径 3）。
 * `dsh-plan-mode` 正是靠 `code === 'ASK_CANCELLED'` 认出「用户要说话，
 * 那就留在计划模式」这条语义的。
 *
 * @returns {Error} 带 `name`/`code` 的普通 Error。
 */
function userQuestionCancelled() {
    return Object.assign(new Error('the user dismissed the question to speak instead'), {
        name: 'UserQuestionError',
        code: 'ASK_CANCELLED',
    });
}

/**
 * 把面板送回来的答案收敛成 `AskUserQuestionAnswerItem[]`（面板是渲染进程，它说的不可信）。
 *
 * @param {unknown} raw - `[{id, selected?, custom?}]`。
 * @returns {Array<{id: string, selected: string[], custom?: string}>} 合法条目（空条目被丢掉）。
 */
function normalizeAnswers(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.id ?? '').trim();
        if (!id) continue;
        const selected = Array.isArray(entry.selected)
            ? entry.selected.map((value) => String(value)).filter((value) => value !== '')
            : [];
        const custom = typeof entry.custom === 'string' && entry.custom.trim() ? entry.custom : undefined;
        if (selected.length === 0 && custom === undefined) continue;
        out.push({ id, selected, ...(custom === undefined ? {} : { custom }) });
    }
    return out;
}

/**
 * 向编辑器面板要一次「人类决定」，等到答案（或被取消）。
 *
 * @param {'question'|'approval'} kind - 交互种类。
 * @param {Record<string, unknown>} payload - 该种类的载荷。
 * @param {AbortSignal} [signal] - 请求的生命周期。
 * @returns {Promise<{id: string, action: string, answers?: unknown, outcome?: unknown}>} 面板的决定。
 */
function askEditor(kind, payload, signal) {
    return new Promise((resolve, reject) => {
        if (!hasIpc()) {
            reject(new Error('cocos bridge：没有 IPC 通道（本进程不是 Cocos 扩展 fork 起来的），问题送不到面板'));
            return;
        }
        if (signal?.aborted) {
            reject(new Error('cocos bridge：请求已被取消'));
            return;
        }

        const id = `ask-${process.pid}-${++askSeq}`;
        const detach = () => {
            askPending.delete(id);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const onAbort = () => {
            detach();
            sendAskFrame({ phase: 'settled', id, kind, outcome: 'aborted', summary: '这一轮被取消了' });
            reject(new Error('cocos bridge：这一次交互被取消'));
        };

        askPending.set(id, {
            resolve: (value) => {
                detach();
                resolve({ id, ...value });
            },
            reject: (error) => {
                detach();
                reject(error);
            },
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });

        sendAskFrame({
            phase: 'open',
            id,
            kind,
            interaction: { id, kind, at: Date.now(), ...payload },
        });
    });
}

/**
 * 收下一条 `interaction/answer` 控制帧（面板的决定）。
 *
 * @param {Record<string, any>} params - `{id, action, answers?, outcome?}`。
 * @returns {Record<string, unknown>} 回执（`settled:false` 表示这条交互已经结束了）。
 */
function settleAsk(params) {
    const id = String(params?.id ?? '').trim();
    if (!id) throw new Error('interaction/answer 需要 id');
    const entry = askPending.get(id);
    if (!entry) {
        // 竞态而非错误：用户可能点快了（同一张卡点了两下），或这一轮刚好被取消
        return { settled: false, reason: '这次交互已经结束了（回答过 / 被取消 / agent 重启过）' };
    }
    const action = String(params?.action ?? 'answer');
    if (action !== 'answer' && action !== 'dismiss' && action !== 'delegate') {
        throw new Error(`interaction/answer：action 只能是 answer / dismiss / delegate，收到 "${action}"`);
    }
    entry.resolve({ action, answers: params?.answers, outcome: params?.outcome, reason: params?.reason });
    return { settled: true, action };
}

/**
 * 一条交互收尾后告诉编辑器（面板据此把卡片收掉）。
 *
 * @param {string} id - 交互 id。
 * @param {string} outcome - `answered` / `dismissed` / `delegated` / `aborted`。
 * @param {string} summary - 给人看的一句话。
 */
function announceSettled(id, outcome, summary) {
    sendAskFrame({ phase: 'settled', id, outcome, summary });
}

/**
 * 在两个 waterfall 上挂应答者。
 *
 * 监听器签名是 cordis 的 waterfall 口径：`(载荷…, next)` —— 返回一个值就是「我答了」，
 * 调 `next()` 就是「我不答，交给下一个」。
 *
 * ⚠ **作用域**：运行时用 `scopeTarget(agent, agent)` 派发（按 agent 过滤），而
 * `dsh-scope` 的准入规则是「没打 scope 标签的监听器全局准入」—— 本插件挂在 profile
 * 根上、没有 scope 标签，所以收得到所有 agent 的请求（`dsh-scope/lib/index.js` 的
 * `scopeTarget`）。不需要按 agent 逐个注册。
 *
 * @param {any} ctx - 插件上下文。
 */
function registerInteractionAnswerers(ctx) {
    if (typeof ctx?.on !== 'function') {
        console.warn('[cocos-bridge] ctx.on 不可用，交互应答者未挂上（提问/授权仍会失败关闭）');
        return;
    }

    ctx.on('user-questions/request', async (request, next) => {
        if (!hasIpc()) return next();
        let reply;
        try {
            reply = await askEditor('question', { questions: projectQuestions(request), ...identify(request) }, request?.signal);
        } catch (error) {
            console.warn(`[cocos-bridge] 提问没能送到面板，交给下一个应答者：${error instanceof Error ? error.message : error}`);
            return next();
        }
        if (reply.action === 'delegate') {
            announceSettled(reply.id, 'delegated', '面板不在，问题交给了下一个应答者（没有人能回答）');
            return next();
        }
        if (reply.action === 'dismiss') {
            announceSettled(reply.id, 'dismissed', '你在面板上关掉了这个问题（模型会当作「你要说话」）');
            throw userQuestionCancelled();
        }
        const answers = normalizeAnswers(reply.answers);
        if (answers.length === 0) {
            announceSettled(reply.id, 'delegated', '面板回了一个空答案，按「没人回答」处理');
            return next();
        }
        announceSettled(reply.id, 'answered', `已回答：${answers.map((item) => [...item.selected, item.custom ?? ''].filter(Boolean).join('、')).join('；')}`);
        return { answers };
    });

    ctx.on('approval/request', async (request, next) => {
        if (!hasIpc()) return next();
        const toolName = String(request?.toolName ?? '');
        const callId = typeof request?.callId === 'string' ? request.callId : undefined;
        const reason = typeof request?.reason === 'string' ? request.reason : undefined;
        let reply;
        try {
            reply = await askEditor(
                'approval',
                { toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }), ...identify(request) },
                request?.signal,
            );
        } catch (error) {
            console.warn(`[cocos-bridge] 授权请求没能送到面板，交给下一个应答者：${error instanceof Error ? error.message : error}`);
            return next();
        }
        if (reply.action === 'answer' && APPROVAL_OUTCOMES.has(String(reply.outcome))) {
            const outcome = String(reply.outcome);
            const summary =
                outcome === 'allowed-once'
                    ? `已允许一次：${toolName || '这次操作'}`
                    : outcome === 'rejected'
                      ? `已拒绝：${toolName || '这次操作'}`
                      : `已取消：${toolName || '这次操作'}`;
            announceSettled(reply.id, 'answered', summary);
            return outcome;
        }
        if (reply.action === 'dismiss') {
            announceSettled(reply.id, 'dismissed', '你在面板上关掉了这次授权（按「取消」处理）');
            return 'cancelled';
        }
        announceSettled(reply.id, 'delegated', '面板不在，授权请求交给了下一个应答者（等于拒绝）');
        return next();
    });

    console.warn('[cocos-bridge] 交互通道就绪（模型提问 / 授权请求 / 计划评审都能在面板上回答）');
}

// ---------------------------------------------------------------------------
// 后台任务（jobs）与子 agent（subagents）
// ---------------------------------------------------------------------------
//
// ## 为什么这两件事只能靠插件转（面板自己拿不到）
//
// 它们**只活在运行时进程的内存里**：jobs 的注册表是 `new Map()`（进程没了全没，
// id 计数器也重置），子 agent 的描述符写在**子会话自己**的日志里。面板与 agent 是两个进程，
// SDK 协议（`initialize` / `session/prompt` / `shutdown`）一个都表达不了 —— 与
// `commands` / `fileReferences` 那两个「借宿主注册表」的通道同一个来路。
//
// ## 三条硬口径（都是调研确认过的，别改）
//
// 1. **job 的输出面板一个字都不许读。** 每个 job 只有**一个消费游标**
//    （`dsh-jobs/lib/types/types.d.ts:77-82`：*"each job has one consuming cursor"*），
//    `read()` 一调就把游标推走 —— 模型下一次 `job_output` 只会拿到 `(no new output)`。
//    所以这里**只用 `list()` / `get()`**（`get()` 的契约明写 "without changing its read cursor"）。
//    代价是面板**看不到输出尾部**（溢出内容还在随机临时目录里，`ctx.spillStore` 只写不读）——
//    这一点在面板上**如实说**，不许假装能看。
// 2. **列 job 必须传 Agent。** `list(caller)` 的实现是
//    `job.owner === undefined || job.owner.id === session`（`dsh-jobs-local/lib/index.js:178-181`），
//    不传 caller 就只剩「无主 job」= 什么都看不到。而且**子 agent 自己起的 job 归子 agent**，
//    所以「这条会话在后台跑的东西」= 它自己的 + 它活着的那几个子孙的（见 `jobOwners`）。
// 3. **子 agent 的状态要自己合成。** `listDescendants` 给的 `activity` 只是
//    "会话记录是否驻留"，不是"agent 忙不忙"；`running/idle/ready` 的合成口径照抄
//    `dsh-tool-subagent-control/lib/types/list-agents.js:24-29`：
//    `agents.get(id)` 拿不到 ⇒ `ready`，拿到就看 `agent.status`。
//
// ⚠ 服务一律走 `hostService`（`ctx.inject`），**不用 `ctx.get`** —— 真运行时 `ctx.get` 恒 undefined
//（见 `hostService` 上面那一大段）。这两个服务都是 `dsh-base` 的行，本 profile 天生就有。

/** 一次最多回给面板多少条 job（面板是个窄抽屉；超了如实说 `truncated`）。 */
const JOB_LIMIT = 40;

/** 一次最多回给面板多少个子 agent。 */
const SUBAGENT_LIMIT = 40;

/** job 状态的合法值（`JobStatus`，只有这五个）。 */
const JOB_STATUSES = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);

/** job 的 label 可能是**整条命令原文**（pwsh 就是这么传的），跨 IPC 前先截一下。 */
const JOB_LABEL_MAX = 400;

/**
 * 一个 job 快照 → 面板要画的形状。
 *
 * 为什么要挑字段而不是整份透传：`JobSnapshot` 里带着 `owner`（一个 Agent 实例，
 * **过不了 IPC**）与 `reported` 这类内部状态；透传会在 `process.send` 那里直接炸。
 *
 * @param {any} snapshot - `JobSnapshot`。
 * @param {string} ownerSessionId - 这个 job 属于哪条会话（子孙 job 也标出来）。
 * @param {number | null} depth - 拥有者的委派深度（0 = 当前会话自己）。
 * @returns {Record<string, unknown>} 给面板的形状。
 */
function projectJob(snapshot, ownerSessionId, depth) {
    const job = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const status = JOB_STATUSES.has(job.status) ? job.status : 'unknown';
    return {
        id: String(job.id ?? ''),
        kind: String(job.kind ?? ''),
        label: String(job.label ?? '').slice(0, JOB_LABEL_MAX),
        status,
        /** 退出码在这一栏里（`exit code: N` / `signal: X` / `killed before exit`），没有就是 null。 */
        detail: typeof job.detail === 'string' ? job.detail : null,
        startedAt: typeof job.startedAt === 'number' ? job.startedAt : null,
        finishedAt: typeof job.finishedAt === 'number' ? job.finishedAt : null,
        ownerSessionId,
        depth,
    };
}

/**
 * 「这条会话在后台跑的东西」都归谁。
 *
 * 先是有 agent 的会话自己，再加上**活着的**子孙 agent —— 子 agent 起的 job 归子 agent
 * （见上面口径 2），所以只查父会话会漏掉「子 agent 在后台跑着一条长命令」这种最要紧的情况。
 * 子孙列表拿不到（服务没挂 / 抛错）不影响自己那一份：**少列不许变成列不出来**。
 *
 * @param {string} sessionId - 面板正看着的会话。
 * @returns {Array<{sessionId: string, agent: any, depth: number | null}>} 拥有者清单。
 */
async function jobOwners(sessionId) {
    const owners = [];
    const self = findAgent(sessionId);
    if (self) owners.push({ sessionId, agent: self, depth: 0 });

    const subagents = hostService('subagents');
    if (self && subagents !== null && typeof subagents.listDescendants === 'function') {
        try {
            const entries = await Promise.resolve(subagents.listDescendants(sessionId));
            for (const entry of Array.isArray(entries) ? entries : []) {
                const id = String(entry?.id ?? '');
                if (!id) continue;
                const agent = findAgent(id);
                // 只有活着的子孙才有 jobs 可列（冷会话的 job 早就随进程没了）
                if (agent) owners.push({ sessionId: id, agent, depth: typeof entry.depth === 'number' ? entry.depth : null });
            }
        } catch (error) {
            console.warn(`[cocos-bridge] 列子会话失败（job 只报本会话那一份）：${error instanceof Error ? error.message : error}`);
        }
    }
    return owners;
}

/**
 * 列后台任务（面板「活动」抽屉的上半块）。
 *
 * @param {Record<string, any>} params - `{sessionId}`。
 * @returns {Promise<Record<string, unknown>>} `{ok, available, reason?, jobs, total, truncated}`。
 */
async function listJobs(params) {
    const jobs = hostService('jobs');
    if (jobs === null) {
        return {
            ok: true,
            available: false,
            reason:
                '这个 profile 没挂 jobs 服务（它是 dsh-base 的行）—— 所以看不到后台任务。' +
                '会话、工具、编辑器操作都不受影响。',
            jobs: [],
            total: 0,
            truncated: false,
        };
    }
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) throw new Error('jobs/list 需要 sessionId');

    const owners = await jobOwners(sessionId);
    const collected = [];
    const errors = [];
    for (const owner of owners) {
        try {
            const rows = typeof jobs.list === 'function' ? jobs.list(owner.agent) : [];
            for (const row of Array.isArray(rows) ? rows : []) collected.push(projectJob(row, owner.sessionId, owner.depth));
        } catch (error) {
            errors.push(`${owner.sessionId}：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // 新的在前（没有 startedAt 的排最后）—— 面板上「刚起的」应该在第一眼的位置
    collected.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return {
        ok: true,
        available: true,
        jobs: collected.slice(0, JOB_LIMIT),
        total: collected.length,
        truncated: collected.length > JOB_LIMIT,
        /** 某个拥有者列不出来时的原因（不静默吞掉：少列的那一份要让用户知道）。 */
        errors,
        /** ⚠ 面板据此如实说「看不到输出」—— 见上面口径 1。 */
        outputReadable: false,
    };
}

/**
 * 列子 agent（面板「活动」抽屉的下半块）。
 *
 * ⚠ **一次性子 agent 没有 LLM provider/model**（descriptor 里就没有那两个字段，
 * 只有 continuable 才有），而读 descriptor 要再开一次子会话日志 —— 这一轮**不读**，
 * 面板上也不许编一个出来。`mode` 会如实告诉用户它是哪种。
 *
 * @param {Record<string, any>} params - `{sessionId}`。
 * @returns {Promise<Record<string, unknown>>} `{ok, available, reason?, subagents, total, truncated}`。
 */
async function listSubagents(params) {
    const subagents = hostService('subagents');
    if (subagents === null) {
        return {
            ok: true,
            available: false,
            reason:
                '这个 profile 没挂 subagents 服务（它是 dsh-base 的行）—— 所以看不到子 agent。' +
                '会话、工具、编辑器操作都不受影响。',
            subagents: [],
            total: 0,
            truncated: false,
        };
    }
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) throw new Error('subagents/list 需要 sessionId');

    const listFn = typeof subagents.listDescendants === 'function' ? subagents.listDescendants.bind(subagents) : null;
    if (listFn === null) throw new Error('subagents 服务没有 listDescendants（DSH 版本可能变了）');

    const entries = await Promise.resolve(listFn(sessionId));
    const rows = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(entry?.id ?? '');
        if (!id) continue;
        const diagnostic = entry?.kind === 'diagnostic';
        const agent = findAgent(id);
        rows.push({
            id,
            kind: diagnostic ? 'diagnostic' : 'child',
            label: typeof entry?.label === 'string' ? entry.label : '',
            /** `one-shot` 的子 agent **不能**再发消息（面板要据此把按钮藏起来）。 */
            mode: entry?.mode === 'continuable' ? 'continuable' : 'one-shot',
            depth: typeof entry?.depth === 'number' ? entry.depth : null,
            hasChildren: entry?.hasChildren === true,
            /** 「会话记录驻留与否」，与「忙不忙」不是一回事（下面那个 `status` 才是）。 */
            activity: entry?.activity === 'running' ? 'running' : 'inactive',
            /** 只有 diagnostic 行有：`corrupt` / `unsupported` / `unavailable`。 */
            reason: typeof entry?.reason === 'string' ? entry.reason : null,
            status: agent ? (agent.status === 'running' ? 'running' : 'idle') : 'ready',
        });
    }
    rows.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.id.localeCompare(b.id));
    return {
        ok: true,
        available: true,
        subagents: rows.slice(0, SUBAGENT_LIMIT),
        total: rows.length,
        truncated: rows.length > SUBAGENT_LIMIT,
    };
}

/**
 * 中断一个子 agent 的**当前这一轮**（面板上那一行的「中断」按钮）。
 *
 * 三条口径：
 * 1. **authority 用 `{kind:'user', parentSessionId}`**：`subagents.interrupt` 有两个分支，
 *    `{kind:'ancestor', agent}` 是给模型工具用的，而「人从面板上按的」正是 user 那一支
 *    （`dsh-subagent/lib/types/continuation.d.ts:92-98`）。
 * 2. **它只停当前这一轮**（内部 `Agent.cancel(cause, {keepInbox:true})`）：会话与上下文留着，
 *    与我们那个「停止本轮」同一个语义 —— 面板文案不许写成「杀掉子 agent」。
 * 3. **目标不存在是静默 no-op**（服务自己的口径），这里如实回 `interrupted: false`。
 *
 * @param {Record<string, any>} params - `{parentSessionId, subagentId}`。
 * @returns {Promise<Record<string, unknown>>} `{ok, interrupted, subagentId}`。
 */
async function interruptSubagent(params) {
    const subagents = hostService('subagents');
    if (subagents === null) throw new Error('这个 profile 没挂 subagents 服务，无法中断子 agent。');
    if (typeof subagents.interrupt !== 'function') throw new Error('subagents 服务没有 interrupt（DSH 版本可能变了）');
    const parentSessionId = String(params.parentSessionId ?? '').trim();
    const subagentId = String(params.subagentId ?? '').trim();
    if (!parentSessionId || !subagentId) throw new Error('subagents/interrupt 需要 parentSessionId 与 subagentId');
    await Promise.resolve(subagents.interrupt(subagentId, { kind: 'user', parentSessionId }));
    console.warn(`[cocos-bridge] 已请求中断子 agent ${subagentId} 的当前一轮（父会话 ${parentSessionId}）`);
    return { ok: true, interrupted: true, subagentId };
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
                /** 交互通道：挂上了就有（面板据此判断「这个插件版本能回答问题吗」）。 */
                ask: typeof runtimeCtx?.on === 'function',
                pendingAsks: [...askPending.keys()],
                /**
                 * 服务通道的两个能力位。
                 *
                 * ⚠ 这里判的是**服务在不在**，不是「行有没有配」—— 服务由插件挂，
                 * 行没挂、或挂了但注入没满足时它是 null。面板据此决定要不要显示
                 * `/` 与 `@` 两个入口（不显示比显示了报错好）。
                 */
                commands: hostService('commands') !== null,
                fileRef: hostService('fileReferences') !== null,
                /**
                 * 「活动」抽屉的两个能力位（后台任务 / 子 agent）。
                 * 同样是**判服务在不在**：不在时面板说「看不到」并给原因，而不是画一个空列表。
                 */
                jobs: hostService('jobs') !== null,
                subagents: hostService('subagents') !== null,
            };

        case 'jobs/list':
            return listJobs(params);

        case 'subagents/list':
            return listSubagents(params);

        case 'subagents/interrupt':
            return interruptSubagent(params);

        case 'commands/list':
            return listCommands(params);

        case 'commands/run':
            return runCommand(params);

        case 'fileref/list':
            return listFileReferences(params);

        case 'interaction/answer':
            return settleAsk(params);

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
    '**改完节点树/布局要看画面**时用 `cocos_capture_view`（把场景视图、或某一个节点，存成图片并回路径），不要靠坐标数字猜 —— 叠字、错位、贴图空白只有画面看得出。想单独确认一个控件就传 `node`（uuid 或 `Canvas/skill_details`）。⚠ 截图抓的是「屏幕上现在这一帧」，所以你（或用户）把场景视图缩放/平移过之后，默认的 `fit:"auto"` 会**先取景再截、截完还原视角**；想按当前视角原样截就传 `fit:"none"`，想看全景就传 `fit:"scene"`。',
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
    '把**编辑器场景视图**当前一帧截成图片文件，返回文件路径；也可以只截**某一个节点**。',
    '',
    '## 什么时候用',
    '- 你刚在 scene 上下文里搭完/改了节点树、布局、UI，想知道**看起来对不对**（叠字、错位、贴图空白、一屏只剩个角……）。坐标数字看不出这些，一张图能。',
    '- 用户说「画面不对」「看不见」「位置偏了」时，**先截一张自己看**再决定改什么；不要拿一串 rect 去猜，也不要把用户当验图工具。',
    '- 想单独确认某个控件（一个按钮、一张卡、一段文字）时传 `node` —— 比截整张视图再自己数像素准得多，也省得图太大看不清。',
    '',
    '## 截的是什么',
    '编辑器**场景视图**（你正开着的那块），所见即所得：含网格与 gizmo。**不是**运行时/游戏预览画面。',
    '传了 `node` 时，截的是**那个节点在视图里占据的那块**（按相机投影算出来的矩形，不是在整图上瞎裁）。',
    '',
    '## `fit`：用户缩放过之后，屏幕上那一帧**未必是全景**',
    '截图抓的是「屏幕上现在这一帧」，所以用户把场景视图缩放/平移过之后，只截到他当时看的那块地方。`fit` 会在截之前先把相机摆到「框住目标」的位置，**截完立刻还原**（回执 `framing.restored` 说明还原成功没有）：',
    '- `auto`（默认）：截整张视图时，**内容没拍全** 或 **内容小得看不清**（占画布面积 < 0.15）才取景；截节点时只在**节点没被拍全**（会缺一块或压根在图外）时取景——节点本来就在画里就按原样裁，不动用户视角。',
    '- `scene`：强制框住**整个场景内容**（想「看一眼全景」就传它）。',
    '- `node`：强制框住**目标节点**（要同时给 `node`）。',
    '- `none`：**不动相机**，就截现在这一帧；回执里照样会告诉你拍全没有（`framing.before.covered`）。',
    '',
    '## 参数',
    '- `savePath`：存到哪（绝对路径）。默认写系统临时目录 `dsh-cocos-captures/`。',
    '- `node`：**只要这一个节点**。给节点 `uuid` 或路径（`Canvas/skill_details`）。算不出矩形时会**如实说明原因并退回整张视图**（不会给你一张瞎裁的图）。',
    '- `padding`：`node` 模式下向外扩几像素（默认 0）—— 描边/阴影贴边时留点白。',
    '- `fit`：见上一节，默认 `auto`。',
    '- `maxWidth`：缩放到最大宽度，默认 640。看清布局足够，也回传得快。',
    '- `format` / `quality`：`png`（默认，无损）或 `jpeg`；`quality` 只对 jpeg 生效。',
    '- `waitMs`：**只有兜底通道**用得上（等下一帧的上限，默认 800ms）；主通道自己会在空图时逼一次重绘。',
    '',
    '## 动手前先想清楚',
    '改完布局再截，**一次就能看出问题**；反过来"先截图看看现在什么样"通常没必要 —— 视图可能是空的、也可能停在你上次离开的位置（后者现在由 `fit:auto` 兜住了：没拍全就会自己取景）。',
    '',
    '## 返回',
    '`{ ok, method, path, width, height, sourceWidth, sourceHeight, format, bytes, blankRatio, target, framing, contents, view }`。',
    '- 拿 `path` 用你的图片读取能力**看一眼** —— 这才是本工具的用途。',
    '- `target`：`{kind:"view"}` 或 `{kind:"node", ref, uuid, name, rect, crop}`；`rect` 是场景侧算出来的矩形（页面 CSS 像素），`crop` 是**真正拿去裁的**那个（含 padding、已换算到图片像素）。',
    '- `framing`：**这张图是不是全景，看它**。`before` / `after` 各是一次实测（`covered` 目标是否整个在画布里、`areaRatio` 占比、`edges` 四边余量），`method` 是哪一级取景生效（`focus` / `adjust` / `manual`），`restored` 是视角还原成功没有。`framing.note` 里会明说「这张图可能仍然不是全景」或「视角没还原」。',
    '- `blankRatio` 接近 1 = 抓到的确实是一张空图。**别再重试**（换 `waitMs` / `maxWidth` / 重新聚焦都不会变）：先看 `view.visibleMatchesDesign` 是不是 `false`（场景视图的设备模拟被改过），然后改用**数值判据**（`worldRect(node)` 等），并把「真实渲染截图未完成」如实说出来。',
    '- `method`：`electron` = 主通道（读编辑器**合成后的画面**，空图时会 `invalidate()` 逼一次重绘）；`scene-gl` = 兜底通道（老路，读 GL 后备缓冲，**不会取景**）。若回执里有 `electronFallback`，那是**主通道为什么没接手**的原因。',
    '',
    '## 前置条件',
    '需要**开着场景**（场景进程里加载了扩展脚本）。没开场景时会明确说要先打开一个场景。',
    '⚠ 取景会**临时动一下用户的编辑器视角**（截完自动还原）。这是刻意的：不摆相机就拍不到视口外的东西。',
].join('\n');

const LOGS_DESCRIPTION = [
    '读**工程里的日志文件**，回「文件路径 + 行号 + 原文行」。',
    '',
    '## 为什么需要它',
    '`cocos_execute_code` 只回你那段代码的 `return`。而引擎抛的异常、场景加载失败、资源导入被拒这些，是**别的进程打到日志里**的 —— 代码拿不到。想弄清「为什么画面没反应」「刚才那一步是不是报错了」，先来这里看原文。',
    '',
    '## 怎么用（三步）',
    '1. `cocos_logs({ list: true })` —— 先看日志到底在哪、有几个、多大、最后写入是什么时候。',
    '2. `cocos_logs({ tail: 50 })` —— 看最新的 50 行。',
    "3. `cocos_logs({ grep: 'Error', tail: 30 })` —— 按子串找；要正则就加 `regex: true`。",
    '',
    '⚠ **先看原文再下结论**：回执里给的是 `F1:120 <原文>` 这样的行，引用时请把**原文**一起说出来（「F1:120 写的是 xxx」），不要只给自己的转述 —— 转述丢掉的细节往往正是排查的入口。',
    '',
    '## 参数',
    '- `list`：只列文件（路径 / 大小 / 最后写入时间），不读内容。',
    '- `tail`：每个文件最多回多少行（默认 200，上限 2000）。有 `grep` 时是「最后 N 条**命中**」。',
    '- `grep` / `regex` / `caseSensitive`：筛行。默认按子串、不区分大小写。',
    '- `since`：只要这个时刻之后的（ISO 时间或毫秒时间戳）；文件整体比它旧就直接跳过。',
    '- `dir` / `files`：日志不在默认那几个目录时，用绝对路径直接点名。',
    '- `clear`：清空日志。**必须同时给 `confirm: "clear"`**，否则会被拒绝并告诉你该传什么。清空 = **截断成 0 字节**（不删文件，因为编辑器可能正开着它）。',
    '',
    '## 返回',
    '`工程路径 → 扫到的目录（✓ 存在 / ✗ 不存在）→ 每个文件（编号 / 路径 / 大小 / 最后写入 / 命中数）→ 命中行`。',
    '超过 2MB 的文件只读**尾部**（此时行号是尾读窗口内的行号，不是全文件行号，回执里会写「已尾读」）；输出超预算会明说被截断。',
    '',
    '## 三条口径',
    '- **只回事实，不做判断**：它不认识「这是哪类 bug」，也不给修复建议或结论 —— 判断是你的活。',
    '- **目录是一张通用候选表**（`temp/logs` / `logs` / `local/logs` / `temp/asset-db/log` / `local` / `temp`），**全都扫**；认不全就用 `dir` / `files` 点名。',
    '- **`temp/logs/project.log` 是 0 字节是正常的**（编辑器还没往这份日志里写过东西）。这时用 `list: true` 看看还有哪些文件。',
    '',
    '⚠ 它**不是** `cocos_execute_code` 回执里的 `logs` —— 那个是你这段代码自己的 `console.*` 输出。',
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

    // 交互应答者先挂：waterfall 是「先注册的先被问」，早注册才抢得到这一问。
    registerInteractionAnswerers(ctx);

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
                node: {
                    type: 'string',
                    description: '只截这一个节点：给 uuid 或路径（如 Canvas/skill_details）。不给就截整张场景视图。算不出矩形时会说明原因并退回整张视图。',
                },
                padding: { type: 'number', description: 'node 模式下向外扩几像素（CSS 像素），默认 0。' },
                fit: {
                    type: 'string',
                    enum: ['auto', 'scene', 'node', 'none'],
                    description:
                        '取景：auto（默认，需要时才动相机）/ scene（强制框住整个场景内容）/ node（强制框住目标节点）/ none（不动相机，就截现在这一帧）。取景在截图后自动还原视角。',
                },
                maxWidth: { type: 'number', description: '缩放到的最大宽度，默认 640。越小越快。' },
                format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
                quality: { type: 'number', description: 'jpeg 质量 0.1~1，默认 0.9。' },
                waitMs: { type: 'number', description: '兜底通道等下一帧的上限（毫秒），默认 800。主通道不用它。' },
                timeoutMs: { type: 'number', description: '整个截图的超时（毫秒），默认取编辑器侧设置（15000）。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall(
                    'capture_view',
                    {
                        savePath: args.savePath,
                        node: args.node,
                        padding: args.padding,
                        fit: args.fit,
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
                title: (() => {
                    const what = args && args.node ? `截节点 ${args.node}` : '截场景视图';
                    const fit = args && args.fit && args.fit !== 'auto' ? ` · fit:${args.fit}` : '';
                    return `Cocos: ${what}${fit}`;
                })(),
                kind: 'other',
                rawInput: args && args.savePath ? String(args.savePath) : '',
            }),
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'cocos_logs',
            description: LOGS_DESCRIPTION,
            parameters: {
                list: { type: 'boolean', description: '只列日志文件（路径/大小/最后写入时间），不读内容。' },
                tail: { type: 'number', description: '每个文件最多回多少行，默认 200，上限 2000；有 grep 时是「最后 N 条命中」。' },
                grep: { type: 'string', description: '只回包含它的行（默认按子串，不区分大小写）。' },
                regex: { type: 'boolean', description: '把 grep 当正则用（默认按字面子串找）。' },
                caseSensitive: { type: 'boolean', description: 'grep 区分大小写（默认不区分）。' },
                since: { type: 'string', description: '只要这个时刻之后的：ISO 时间（2026-10-06 06:04）或毫秒时间戳。' },
                dir: { type: 'string', description: '改扫这个目录（绝对路径，或相对工程根）。不给就扫默认候选表。' },
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '显式点名若干日志文件（绝对路径或相对工程根）。给了就不扫目录。',
                },
                clear: { type: 'boolean', description: '清空日志（截断成 0 字节）。必须同时给 confirm:"clear"。' },
                confirm: { type: 'string', description: 'clear 的确认口令：固定字符串 "clear"。' },
            },
            output: OUTPUT,
            async execute(args, exec) {
                const result = await ipcCall(
                    'read_logs',
                    {
                        list: args.list === true,
                        tail: args.tail,
                        grep: args.grep,
                        regex: args.regex === true,
                        caseSensitive: args.caseSensitive === true,
                        since: args.since,
                        dir: args.dir,
                        files: Array.isArray(args.files) ? args.files : undefined,
                        clear: args.clear === true,
                        confirm: args.confirm,
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
                title: (() => {
                    if (args && args.clear) return 'Cocos: 清空日志';
                    if (args && args.list) return 'Cocos: 看日志文件清点';
                    const what = args && args.grep ? `找日志 ${args.grep}` : '读日志';
                    const tail = args && args.tail ? ` · tail:${args.tail}` : '';
                    return `Cocos: ${what}${tail}`;
                })(),
                kind: 'other',
                rawInput: args && args.grep ? String(args.grep) : '',
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
     */
    ctx.inject(['agents'], (agentCtx) => {
        agentsService = agentCtx.agents ?? agentCtx.get('agents') ?? null;
        console.warn('[cocos-bridge] 控制通道就绪（可以继续历史会话）');
        return () => {
            agentsService = null;
            ownedSessions.clear();
        };
    });

    /**
     * 三个「现用现取」的服务：**启动时就登记注入**，别等面板第一次问。
     *
     * 为什么要预热：注入回执是**异步**的（服务出现时才跑回调），而第一次 `hostService`
     * 调用发生在面板按下 `/` 或发第一张图时 —— 那一次必然拿到空的占位值。
     * 预热一次，回执在启动阶段就跑完了，之后每次调用都是从一个已经填好的表里取。
     *
     * 三个都不写进 `inject: [...]`：那是「全都要」，少一个就整个插件（含四个工具）不加载。
     * 这里每个各起一个注入，少哪个只影响哪个功能。
     */
    for (const name of ['attachments', 'commands', 'fileReferences']) hostService(name);

    // ⚠ 一律走 stderr（console.warn）：SDK profile 的 **stdout 专属于 JSON-RPC 帧**，
    // 任何 console.log 都会插进协议流里（实测踩过一次）。
    console.warn(
        '[cocos-bridge] 已注册原生工具：cocos_execute_code / cocos_describe_api / cocos_editor_state / cocos_capture_view / cocos_logs',
    );
}
