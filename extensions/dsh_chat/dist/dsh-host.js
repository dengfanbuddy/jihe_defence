"use strict";
/**
 * Agent 宿主：托管「被 fork 出来的 DSH 子进程」，并把它的三条流接起来。
 *
 * ```
 *                    ┌─────────────── DSH 子进程（系统 node，--profile cocos）──────────────┐
 *   面板（渲染进程）  │                                                                      │
 *      ▲  ▲           │  stdout ── SDK JSON-RPC（initialize / session.prompt / session.event）│
 *      │  │ broadcast │  stderr ── 插件日志（诊断尾巴，不进上下文）                          │
 *      │  └───────────┤  ipc    ── 原生工具调用（cocos_execute_code → 本进程 → 本扩展沙箱/场景脚本）  │
 *      │              └──────────────────────────────────────────────────────────────────────┘
 *      └── Editor.Message.request/get-events（轮询兜底）
 *
 * ## 三条口径
 *
 * 1. **stdout 是协议，stderr 是日志，ipc 是工具**。三者绝不混用：
 *    stdout 上有杂质行只会计数跳过（见 `SdkClient`），不会打断对话。
 * 2. **面板两条路都能拿到更新**：广播（快，但 `__protected__` 是保护接口）+ 轮询
 *    `get-events`（慢一点，但一定到）。两条路合并进同一份 `Map<seq, Entry>`，靠 `seq`/`rev` 幂等。
 * 3. **子进程一定要收干净**：`unload()`、编辑器退出、agent 自己 `exit`，三条路都要落到
 *    同一个 `cleanup()`；否则会留下孤儿 node 进程占着 CPU。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DshHost = void 0;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const path_1 = require("path");
const cocos_tools_1 = require("./cocos-tools");
const constants_1 = require("./constants");
const history_1 = require("./history");
const paths_1 = require("./paths");
const sdk_client_1 = require("./sdk-client");
const settings_1 = require("./settings");
/**
 * 随扩展发布的通用 skill 目录（`<扩展根>/skills`）。
 *
 * 为什么要显式注入：DSH 的 `@deepseek-ai/dsh-skill-filesystem` 会读环境变量
 * `DSH_BUNDLED_SKILL_DIR` 并把它当成 **bundled 根**扫描（`rank = 600`，全表最低优先级）。
 * 于是「引擎/编辑器操作的通用知识」**跟着插件走** —— 换个工程装上就有，
 * 而工程自己的 `.agents/skills/`（rank 200）、用户级 `~/.agents/skills/`（rank 500）仍然优先。
 *
 * ⚠ **同名是「整体覆盖」而不是「合并」**（`dsh-skill` 的 `collectLayer` 按 rank 升序 + 按名字去重），
 * 所以消费工程里**不要**再放一个同名的 `cocos-editor-ops` —— 那会把插件这份整个吃掉。
 * 完整口径见 `skills/README.md`。
 */
function bundledSkillDir() {
    return (0, path_1.join)(__dirname, '..', 'skills');
}
/** 转写保留上限（超出丢最老的）。面板只看最近这些，够用且不涨内存。 */
const MAX_ENTRIES = 600;
/** stderr 诊断尾巴保留行数。 */
const MAX_STDERR_LINES = 40;
/** 工具结果在**面板上**的截断长度（模型拿到的仍是完整结果）。 */
const TOOL_OUTPUT_DISPLAY_LIMIT = 4000;
/** 广播节流：流式增量可能很密，攒到一个间隔再推一次。 */
const FLUSH_INTERVAL_MS = 120;
/** 一次广播携带的条目上限（超出的靠轮询补齐，避免单帧过大）。 */
const FLUSH_BATCH_LIMIT = 60;
/** 从 ContentBlock[] 里取纯文本。 */
function textOfBlocks(blocks) {
    if (!Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'text') {
            const text = block.text;
            if (typeof text === 'string' && text)
                parts.push(text);
        }
    }
    return parts.join('\n');
}
/**
 * 从 ContentBlock[] 里取图片的**元数据**（回放历史时用）。
 *
 * 两种形状都要认，理由和 `toolResultOf` 一样（DSH 升过版）：
 *
 * | 来源 | 图片块 |
 * |---|---|
 * | 我们发出去的（面板 echo） | `{type:'image', data, mimeType}` —— 还没进附件库 |
 * | 会话日志里记下来的 | `{type:'image', attachment:{mediaType, bytes, width, height, name?}}` |
 *
 * 日志里那条**没有像素**（字节另存在附件库），所以面板上历史消息只能画「图名 + 尺寸」，
 * 这也正是 `EntryImage` 只有元数据的原因。
 *
 * @param blocks - `user/message` 的 `data.content`。
 * @returns 图片元数据列表（顺序即消息里的顺序）。
 */
function imagesOfBlocks(blocks) {
    var _a;
    if (!Array.isArray(blocks))
        return [];
    const out = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type !== 'image')
            continue;
        const ref = typed.attachment;
        out.push({
            name: ref === null || ref === void 0 ? void 0 : ref.name,
            mimeType: (_a = ref === null || ref === void 0 ? void 0 : ref.mediaType) !== null && _a !== void 0 ? _a : typed.mimeType,
            bytes: typeof (ref === null || ref === void 0 ? void 0 : ref.bytes) === 'number' ? ref.bytes : undefined,
            width: typeof (ref === null || ref === void 0 ? void 0 : ref.width) === 'number' ? ref.width : undefined,
            height: typeof (ref === null || ref === void 0 ? void 0 : ref.height) === 'number' ? ref.height : undefined,
        });
    }
    return out;
}
/** 一张待发送的图 → SDK 的内容块（`data` 必须是规范 base64，见 `source/images.ts`）。 */
function imageBlockOf(image) {
    const block = { type: 'image', data: image.data, mimeType: image.mimeType };
    if (image.name)
        block.name = image.name;
    return block;
}
/** 把异常/未知收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 从 `tool/result` 的 message 里取「文本 + 是不是错误」—— **两种形状都要认**。
 *
 * 这不是洁癖，是实测撞出来的：同一天的两个会话日志形状不一样（DSH 升过版）。
 *
 * | 来源 | `message.content` |
 * |---|---|
 * | 实时事件 / 老日志（`version: 0`） | `[ { type: 'tool-result', toolCallId, content: [块…], isError } ]` —— 内容在**里层** |
 * | 新日志（`version: 4`） | `[ { type: 'text', text } ]` —— 内容**就是**这一层 |
 *
 * 只认前一种的话，回放新日志时**每张工具卡片的结果都是空的**（`done: true` 却一个字没有，
 * 看起来像工具没输出），而且不报错。`isError` 同理：新形状挂在外层 `message.isError`。
 *
 * @param message - `data.message`。
 * @returns 文本与错误标记。
 */
function toolResultOf(message) {
    const typed = (message !== null && message !== void 0 ? message : {});
    const content = typed.content;
    if (!Array.isArray(content))
        return { text: '', isError: typed.isError === true };
    const wrapper = content[0];
    const blocks = (wrapper === null || wrapper === void 0 ? void 0 : wrapper.type) === 'tool-result' && Array.isArray(wrapper.content) ? wrapper.content : content;
    return {
        text: textOfBlocks(blocks),
        isError: (wrapper === null || wrapper === void 0 ? void 0 : wrapper.isError) === true || typed.isError === true,
    };
}
/** DSH 子进程的宿主。整个扩展只有这一个实例（`main.ts` 里持有）。 */
class DshHost {
    constructor() {
        this.child = null;
        this.client = null;
        this.status = 'stopped';
        this.running = false;
        this.sessionId = null;
        this.lastBootMs = null;
        this.lastError = null;
        this.runtime = { nodeExe: null, nodeSource: '未探测', dshBin: null, dshSource: '未探测' };
        /**
         * 当前 sessionId 的来历。
         *
         * - `sdk`：SDK 协议 `session/prompt` 懒创建出来的会话（老路子）；
         * - `resumed`：插件用 `agents.resume` **真正接上**的历史会话 —— 发消息走控制帧；
         * - `history`：只是把历史日志回放到面板上（只读，还没接上）。
         */
        this.sessionKind = 'sdk';
        /** 非空 = 对话区正在显示一条历史会话。 */
        this.historyView = null;
        this.entries = [];
        this.seq = 0;
        this.revision = 0;
        /** 转写代数：清空/换会话就 +1（面板据此丢弃旧条目）。 */
        this.generation = 0;
        /** 控制帧（面板→插件）的请求号与在飞请求。 */
        this.ctlSeq = 0;
        this.ctlPending = new Map();
        /** 流式中的条目（文本 / 思考各一条，回合内复用）。 */
        this.textStream = null;
        this.reasoningStream = null;
        /** callId → 工具条目，用于把 `tool/result` 配回 `tool/call`。 */
        this.toolByCallId = new Map();
        /** 本帧内被改动过的条目（广播用）。 */
        this.dirty = new Set();
        this.flushTimer = null;
        this.stderrTail = [];
        this.stderrBuffer = '';
        this.listeners = new Set();
    }
    // ---------------------------------------------------------------- 对外只读
    /** 注册更新回调（`main.ts` 用它发广播）。返回注销函数。 */
    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** 当前快照。 */
    snapshot() {
        var _a, _b;
        return {
            status: this.status,
            running: this.running,
            sessionId: this.sessionId,
            sessionKind: this.sessionKind,
            history: this.historyView ? { ...this.historyView } : null,
            generation: this.generation,
            pid: (_b = (_a = this.child) === null || _a === void 0 ? void 0 : _a.pid) !== null && _b !== void 0 ? _b : null,
            lastBootMs: this.lastBootMs,
            lastError: this.lastError,
            entryCount: this.entries.length,
            revision: this.revision,
            runtime: {
                nodeExe: this.runtime.nodeExe,
                dshBin: this.runtime.dshBin,
                nodeSource: this.runtime.nodeSource,
                dshSource: this.runtime.dshSource,
            },
            stderrTail: [...this.stderrTail],
        };
    }
    /** 增量拉取：返回 `rev > since` 的条目（同一 seq 会被反复返回，面板原地更新）。 */
    eventsSince(since) {
        const from = Number.isFinite(since) ? since : 0;
        return {
            entries: this.entries.filter((entry) => entry.rev > from),
            revision: this.revision,
            generation: this.generation,
        };
    }
    /** 探测一次运行时（面板要在没启动时也能显示「将用哪个 node/dsh」）。 */
    probeRuntime() {
        this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        return this.runtime;
    }
    // ---------------------------------------------------------------- 生命周期
    /**
     * 启动 agent。
     *
     * 幂等：已经在跑或正在起就直接返回成功。
     *
     * @returns `{ok, error?}`；失败**不抛**，让面板能显示原因。
     */
    async start() {
        var _a;
        if (this.status === 'ready' || this.status === 'starting')
            return { ok: true };
        const settings = (0, settings_1.getSettings)();
        this.runtime = (0, paths_1.resolveRuntime)(settings);
        if (!this.runtime.nodeExe) {
            return this.fail('找不到可用的 node。请在 DSH 面板设置里填「node 路径」，或把 node 加到 PATH。' +
                '（注意：编辑器自带的 Electron 不是 node，不能拿来跑 dsh。）');
        }
        if (!this.runtime.dshBin) {
            return this.fail('找不到 dsh CLI 入口。请在设置里填「dsh bin.js 路径」（通常形如 ' +
                '`<npm 全局目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`）。');
        }
        const cwd = settings.workdir || Editor.Project.path;
        this.setStatus('starting');
        this.lastError = null;
        this.stderrTail = [];
        this.stderrBuffer = '';
        const startedAt = Date.now();
        try {
            this.child = (0, child_process_1.fork)(this.runtime.dshBin, ['--profile', constants_1.PROFILE_NAME], {
                // ⚠ 必须显式给 execPath：默认会用编辑器的 `process.execPath`（CocosCreator.exe）
                execPath: this.runtime.nodeExe,
                cwd,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                windowsHide: true,
                env: {
                    ...process.env,
                    // 随扩展发布的通用 skill 根 —— 让「引擎/编辑器操作的通用知识」跟着插件走，
                    // 换工程装上就有。见 bundledSkillDir() 与 skills/README.md。
                    DSH_BUNDLED_SKILL_DIR: bundledSkillDir(),
                },
                // `windowsHide` 是真实存在的选项（Windows 上别弹黑框），但本地的 @types/node
                // 比它旧、ForkOptions 里还没声明，所以这里断言一下而不是删掉这个选项。
            });
        }
        catch (error) {
            return this.fail(`启动 dsh 子进程失败：${describe(error)}`);
        }
        this.attachChild(this.child);
        try {
            const params = {
                cwd,
                provider: settings.provider,
                model: settings.model,
            };
            if (settings.reasoningEffort)
                params.reasoningEffort = settings.reasoningEffort;
            if (settings.maxTokens > 0)
                params.maxTokens = settings.maxTokens;
            await ((_a = this.client) === null || _a === void 0 ? void 0 : _a.initialize(params));
        }
        catch (error) {
            const message = describe(error);
            // 起不来就别留半死的进程
            this.killChild();
            return this.fail(`初始化失败：${message}`);
        }
        this.lastBootMs = Date.now() - startedAt;
        this.setStatus('ready');
        this.append('note', `agent 已就绪（${this.lastBootMs}ms） 模型 ${settings.provider}/${settings.model}；工作目录 ${cwd}`);
        // 启动后**接着上次聊**：DSH 的 web 端也是这个行为（面板自己不带磁盘转写，所以还要把历史回放一遍）
        await this.restoreLastSession(cwd);
        return { ok: true };
    }
    /**
     * 启动后自动恢复「本工程最近一条有内容的会话」。
     *
     * ## 为什么默认要这么做
     *
     * 一次「停止 → 启动」在 DSH 侧是**换了一个运行时**，而 SDK 协议里的 `session/prompt`
     * 只会 `create` 新会话（模型侧没有任何历史上下文）—— 所以老代码里 `start()` 每次
     * 随便抽一个新 uuid，效果就是「一重启，之前聊的全没了」。用户看到的正是这个。
     *
     * 走插件控制帧的 `session/resume` 才是**真恢复**（`agents.resume`，模型带着上下文回来），
     * 顺带把这段历史回放到面板上，于是重启前后的观感是连续的。
     *
     * 失败不致命：退回「新会话」并把原因写进转写（不然用户只会看到一片空白）。
     */
    async restoreLastSession(cwd) {
        var _a, _b, _c, _d, _e, _f;
        try {
            const listed = await (0, history_1.listHistory)(this.runtime.nodeExe, cwd, 5);
            if (!listed.ok)
                throw new Error((_a = listed.error) !== null && _a !== void 0 ? _a : '列历史会话失败');
            const candidate = (_c = ((_b = listed.sessions) !== null && _b !== void 0 ? _b : []).find((session) => session.turns > 0)) !== null && _c !== void 0 ? _c : ((_d = listed.sessions) !== null && _d !== void 0 ? _d : [])[0];
            if (!candidate) {
                this.sessionId = (0, crypto_1.randomUUID)();
                this.sessionKind = 'sdk';
                this.append('note', '还没聊过，已开新会话。');
                return;
            }
            const opened = await this.loadHistory(candidate.id, { quiet: true });
            if (!opened.ok)
                throw new Error((_e = opened.error) !== null && _e !== void 0 ? _e : '读历史会话失败');
            const resumed = await this.resumeHistory(candidate.id);
            if (!resumed.ok)
                throw new Error((_f = resumed.error) !== null && _f !== void 0 ? _f : '继续会话失败');
        }
        catch (error) {
            this.sessionId = (0, crypto_1.randomUUID)();
            this.sessionKind = 'sdk';
            this.historyView = null;
            this.append('note', `没能接上上次的会话（${describe(error)}）—— 已开新会话 ${String(this.sessionId).slice(0, 8)}…。` +
                '历史仍在右上角「历史」里。');
        }
    }
    /**
     * 列历史会话（面板上的「历史」按钮）。
     *
     * @param limit - 最多几条。
     * @returns `{ok, sessions?, error?}`。
     */
    async historyList(limit = 20) {
        var _a, _b, _c;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const listed = await (0, history_1.listHistory)(this.runtime.nodeExe, cwd, limit);
        if (!listed.ok)
            return { ok: false, error: listed.error };
        const current = (_b = (_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId) !== null && _b !== void 0 ? _b : null;
        const sessions = ((_c = listed.sessions) !== null && _c !== void 0 ? _c : []).map((session) => ({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            bytes: session.bytes,
            turns: session.turns,
            current: session.id === current,
        }));
        return { ok: true, sessions };
    }
    /**
     * 把一条历史会话**回放到对话区**（只读）。
     *
     * 回放走的是「同一份事件流」：日志里的事件和实时通知是同构的
     * （`{type, seq, time, data}`），所以这里把 `handleSessionEvent` 的 `replay` 档打开，
     * 让历史走一遍**和实时完全一样**的投影逻辑 —— 不另写一套渲染规则，就不会两边不一致。
     *
     * ⚠ 实测（`.tmp/verify-resume.mjs`）：`agents.resume` **不会**把历史事件重放出来，
     * 所以这段回放不是「多此一举」，而是「不画就没有」。
     *
     * @param sessionId - 会话 id。
     * @param options.quiet - 自动恢复时不刷那两行 note（避免启动就一屏字）。
     * @returns `{ok, events?, error?}`。
     */
    async loadHistory(sessionId, options = {}) {
        var _a, _b, _c, _d;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const read = await (0, history_1.readHistory)(this.runtime.nodeExe, cwd, sessionId);
        if (!read.ok)
            return { ok: false, error: read.error };
        const events = (_a = read.events) !== null && _a !== void 0 ? _a : [];
        this.resetTranscript();
        this.historyView = {
            sessionId,
            title: (0, history_1.titleOfEvents)(events) || '(无标题)',
            createdAt: (_c = ((_b = read.header) !== null && _b !== void 0 ? _b : {}).createdAt) !== null && _c !== void 0 ? _c : null,
            messageCount: events.length,
            live: false,
        };
        this.sessionKind = 'history';
        for (const event of events)
            this.handleSessionEvent(event, true, sessionId);
        if (!options.quiet) {
            this.append('note', `以上是历史会话 ${sessionId.slice(0, 8)}… 的 ${events.length} 条记录（只读回放，共 ${(_d = read.total) !== null && _d !== void 0 ? _d : events.length} 条）。` +
                '想接着聊就点上面的「继续此会话」。');
        }
        return { ok: true, events: events.length };
    }
    /**
     * **真正接上**一条历史会话（插件侧 `agents.resume`）。
     *
     * 接上之后：`sessionId` 指向它、后续消息走控制帧投喂（`agent.followup`），
     * 而流式事件仍从 SDK 的 `session.event` 通知回来（那个订阅覆盖运行时里的**所有**会话）。
     *
     * @param sessionId - 会话 id；省略则用当前回放的那条。
     * @returns `{ok, sessionId?, error?}`。
     */
    async resumeHistory(sessionId) {
        var _a, _b;
        const target = sessionId !== null && sessionId !== void 0 ? sessionId : (_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId;
        if (!target)
            return { ok: false, error: '没有可继续的会话（先从「历史」里打开一条）' };
        if (this.status !== 'ready' || !this.child) {
            return { ok: false, error: 'agent 没在跑 —— 先点「启动」再继续这条会话' };
        }
        const settings = (0, settings_1.getSettings)();
        try {
            const result = await this.callChild('session/resume', {
                sessionId: target,
                provider: settings.provider,
                model: settings.model,
                reasoningEffort: settings.reasoningEffort || undefined,
                maxTokens: settings.maxTokens > 0 ? settings.maxTokens : undefined,
            }, 180000);
            this.sessionId = target;
            this.sessionKind = 'resumed';
            if (this.historyView)
                this.historyView = { ...this.historyView, sessionId: target, live: true };
            else {
                this.historyView = { sessionId: target, title: '(未回放)', createdAt: null, messageCount: 0, live: true };
            }
            this.append('note', `已接上会话 ${target.slice(0, 8)}…（agent ${String((_b = result.agentId) !== null && _b !== void 0 ? _b : '?').slice(0, 8)}…）——` +
                '接下来的消息会带着它的上下文。');
            return { ok: true, sessionId: target };
        }
        catch (error) {
            const message = describe(error);
            this.append('error', `继续会话失败：${message}`);
            return { ok: false, error: message };
        }
    }
    /**
     * 发一条控制帧并等回执（面板→插件那一路）。
     *
     * 与工具帧（`kind: 'req'`）共用 IPC 通道，靠 `kind` 区分；回执在 `attachChild` 的
     * 消息路由里按 `id` 配对。
     */
    callChild(method, params, timeoutMs = 60000) {
        const child = this.child;
        if (!child)
            return Promise.reject(new Error('agent 子进程不在'));
        const id = ++this.ctlSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ctlPending.delete(id);
                reject(new Error(`控制帧 ${method} 在 ${timeoutMs}ms 内没有回执（插件版本过旧？` +
                    '本扩展要求 dsh-cocos-bridge 支持控制通道，先跑一次 scripts/install-profile.js）'));
            }, timeoutMs);
            this.ctlPending.set(id, { resolve, reject, timer });
            try {
                child.send({ __tag: constants_1.IPC_TAG, kind: 'ctl', id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.ctlPending.delete(id);
                reject(new Error(`发送控制帧失败：${describe(error)}`));
            }
        });
    }
    /** 停止 agent。先走协议 `shutdown`（服务端会自己退出），兜底再 kill。 */
    async stop() {
        if (!this.child) {
            this.setStatus('stopped');
            return { ok: true };
        }
        this.setStatus('stopping');
        const child = this.child;
        const client = this.client;
        try {
            await (client === null || client === void 0 ? void 0 : client.shutdown());
        }
        catch (error) {
            console.warn(`[dsh_chat] shutdown 请求没走完（继续 kill）：${describe(error)}`);
        }
        // 服务端通常会自己 exit；给它 1.5s，然后兜底。
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) {
                    try {
                        child.kill();
                    }
                    catch {
                        /* 已经没了 */
                    }
                }
                resolve();
            }, 1500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.cleanup();
        this.setStatus('stopped');
        this.append('note', 'agent 已停止');
        return { ok: true };
    }
    /**
     * 中断**当前这一轮**（面板上那个「停止本轮」按钮）。
     *
     * ## 为什么它必须有，以及为什么只能这么做
     *
     * SDK 协议只有 `initialize` / `session/prompt` / `shutdown` 三个方法，
     * **没有「取消这一轮」**；而且 `session/prompt` 的回执只是「入队成功」
     * （`SessionPromptResult` 是 durable enqueue receipt），拿到回执≠这一轮结束。
     * 所以在加这条通道之前，面板上唯一的「停止」是**杀掉整个 agent 进程** ——
     * 会话、子 agent、正在跑的工具一起没，下一句还要重新启动 + 自动接上下文。
     * 「AI 想歪了想改口」这种最常见的场景，代价高得离谱。
     *
     * 真正能取消的是运行时内部的 `Agent.cancel(cause)`，而它只有插件能调
     * （见 `dsh-cocos-bridge` 的 `session/cancel`）。这条方法就是那一步的转发：
     *
     * ```
     * 面板「停止本轮」→ 主进程 interrupt() → ctl session/cancel {sessionId}
     *                                     → 插件 agents.get(sessionId).cancel({kind:'user'})
     * ```
     *
     * ## 三条口径
     *
     * 1. **没在跑就不算错**：`running` 为假直接回一句 note，不打扰插件 ——
     *    按钮与「这一轮刚好自己结束」之间有天然竞态，报红是误报。
     * 2. **中断不是回滚**：已经产出的文本 / 已经跑完的工具调用都留着
     *    （`assistant/message` 的 `interrupted` 与 `turn/end` 的 `aborted` 会到，转写里会多一条 note）。
     * 3. **不动 `sessionId`**：中断之后接着说，还是同一个会话、同一段上下文。
     *
     * @returns `{ok, cancelled?, status?, error?}`。
     */
    async interrupt() {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        try {
            /**
             * ⚠ **不拿 `this.running` 当闸门**：它来自 `session.status` 通知，可能在
             * 「面板刚重开」「通知还没到」时是陈旧的 `false`；而**谁在跑**这件事，
             * 运行时里的 `agent.status` 才是真源。所以一律问插件，由它回 `cancelled`。
             */
            const result = await this.callChild('session/cancel', { sessionId: this.sessionId }, 15000);
            const cancelled = result.cancelled === true;
            const status = typeof result.status === 'string' ? result.status : undefined;
            this.append('note', cancelled ? '已请求中断这一轮（会话保留，可以接着说）' : '这一轮已经结束了');
            // 乐观收敛：中断请求已受理时，本地 running 立刻置位，别等下一次通知
            // （面板那个按钮的禁用态靠它，不然会有一小段「看起来没反应」）
            if (cancelled)
                this.running = false;
            return { ok: true, cancelled, status };
        }
        catch (error) {
            const message = describe(error);
            this.append('error', `中断失败：${message}`);
            return { ok: false, error: message };
        }
    }
    /** 开一个新会话（新的 sessionId；旧会话在 DSH 侧仍按日志留在磁盘上）。 */
    newSession() {
        // 接上来的历史会话是**插件持有的 agent**：开新会话就要显式放掉它，
        // 否则它会一直挂在运行时里（下次 resume 同一个 id 会撞上）。
        if (this.sessionKind === 'resumed' && this.sessionId) {
            const previous = this.sessionId;
            void this.callChild('session/dispose', { sessionId: previous }).catch((error) => {
                console.warn(`[dsh_chat] 释放会话 ${previous.slice(0, 8)}… 失败：${describe(error)}`);
            });
        }
        this.sessionId = (0, crypto_1.randomUUID)();
        this.sessionKind = 'sdk';
        this.historyView = null;
        this.resetTranscript();
        this.append('note', `已开新会话 ${this.sessionId.slice(0, 8)}…（上一段对话仍在右上角「历史」里，随时可以接着聊）`);
        return { ok: true, sessionId: this.sessionId };
    }
    /**
     * 清空对话区（换会话/回放历史前调用）。
     *
     * **代数 +1** 是给面板的信号：面板只按 `rev` 拉增量，没法表达「某条被删掉了」，
     * 所以「清空」这件事必须有一个独立的、单调递增的记号（`generation`）。
     */
    resetTranscript() {
        this.entries.length = 0;
        this.seq = 0;
        this.generation += 1;
        this.textStream = null;
        this.reasoningStream = null;
        this.toolByCallId.clear();
        this.dirty.clear();
        this.scheduleFlush();
    }
    /**
     * 发一条用户消息（文本 + 可选图片）。
     *
     * 回执只代表**入队**成功；答案通过 `session.event` 异步到来（见 `handleSessionEvent`）。
     *
     * 三条路：
     * - 接上来的历史会话（`resumed`）走控制帧（插件 `session/prompt`，图片由插件送进附件库）；
     * - 其余走 SDK 的 `session/prompt`（服务端懒创建会话，图片由服务端送进附件库）；
     * - 只有图没有字也允许（模型只看图）。
     *
     * @param text - 用户输入的文本（可空）。
     * @param images - 已经过 `validateImageBatch` 的图片（可空）。
     * @returns `{ok, error?, messageId?}`。
     */
    async send(text, images = []) {
        const content = typeof text === 'string' ? text.trim() : '';
        const attachments = images.filter((image) => image && typeof image.data === 'string' && image.data);
        if (!content && attachments.length === 0)
            return { ok: false, error: '消息是空的' };
        if (this.status !== 'ready' || !this.client)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) {
            this.sessionId = (0, crypto_1.randomUUID)();
            this.sessionKind = 'sdk';
        }
        // 内容块：文本在前、图片在后（附件库按顺序把 image 块换成附件引用，顺序即消息顺序）
        const blocks = [];
        if (content)
            blocks.push({ type: 'text', text: content });
        for (const image of attachments)
            blocks.push(imageBlockOf(image));
        // 本地立即回显（不等 `user/message` 事件，避免"点了没反应"的错觉）。
        // 图片只记元数据 —— 转写是要经广播/轮询回面板的，塞像素进去会把面板拖死（见 `EntryImage`）。
        this.append('user', content, undefined, attachments.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            bytes: image.bytes,
        })));
        this.textStream = null;
        this.reasoningStream = null;
        if (this.sessionKind === 'resumed') {
            try {
                const result = await this.callChild('session/prompt', {
                    sessionId: this.sessionId,
                    text: content,
                    // 控制帧上也走 base64（插件那边转成附件引用），别传路径：
                    // 插件跑在 DSH 运行时里，它读不到编辑器的工程目录语义。
                    images: attachments.map((image) => ({ mimeType: image.mimeType, data: image.data, name: image.name })),
                });
                return { ok: true, messageId: typeof result.messageId === 'string' ? result.messageId : undefined };
            }
            catch (error) {
                const message = describe(error);
                this.append('error', `发送失败（已接上的历史会话走控制帧）：${message}`);
                return { ok: false, error: message };
            }
        }
        try {
            const result = (await this.client.prompt(this.sessionId, blocks));
            return { ok: true, messageId: result === null || result === void 0 ? void 0 : result.messageId };
        }
        catch (error) {
            const message = describe(error);
            this.append('error', `发送失败：${message}`);
            return { ok: false, error: message };
        }
    }
    /** 扩展卸载时调用：断开一切、杀掉子进程。 */
    async dispose() {
        var _a;
        this.listeners.clear();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.child) {
            try {
                (_a = this.client) === null || _a === void 0 ? void 0 : _a.dispose();
            }
            catch {
                /* 忽略 */
            }
            this.killChild();
        }
        this.cleanup();
        this.status = 'stopped';
    }
    // ---------------------------------------------------------------- 子进程接线
    attachChild(child) {
        var _a, _b, _c;
        this.client = new sdk_client_1.SdkClient(child, (method, params) => this.handleNotification(method, params));
        this.client.attach();
        (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding('utf8');
        (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.setEncoding('utf8');
        (_c = child.stderr) === null || _c === void 0 ? void 0 : _c.on('data', (chunk) => this.handleStderr(chunk));
        // 原生工具调用：DSH 插件 → 本进程；以及控制帧回执（面板 → 插件）
        child.on('message', (frame) => {
            const typed = frame;
            if (typed && typed.__tag === constants_1.IPC_TAG && typed.kind === 'ctl-res') {
                this.handleControlReply(typed);
                return;
            }
            void this.handleIpcFrame(frame);
        });
        child.on('error', (error) => {
            this.fail(`子进程错误：${describe(error)}`);
        });
        child.on('exit', (code, signal) => {
            const wasStopping = this.status === 'stopping';
            this.cleanup();
            if (wasStopping) {
                this.setStatus('stopped');
                return;
            }
            this.fail(`agent 进程退出了（code=${code !== null && code !== void 0 ? code : 'null'}${signal ? `, signal=${signal}` : ''}）`);
        });
    }
    /** 收尾：摘监听、清引用（不 kill）。 */
    cleanup() {
        if (this.client) {
            this.client.dispose();
            this.client = null;
        }
        // 子进程没了，控制帧的在飞请求永远不会回来 —— 立刻让它们失败，别让面板转圈
        for (const [, entry] of this.ctlPending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('agent 子进程已退出，控制帧没有回执'));
        }
        this.ctlPending.clear();
        if (this.child) {
            this.child.removeAllListeners('message');
            this.child.removeAllListeners('exit');
            this.child.removeAllListeners('error');
            this.child = null;
        }
        this.running = false;
        this.textStream = null;
        this.reasoningStream = null;
        this.scheduleFlush();
    }
    /** 杀掉子进程（不碰 client/监听）。 */
    killChild() {
        const child = this.child;
        if (!child)
            return;
        try {
            if (child.exitCode === null)
                child.kill();
        }
        catch {
            /* 已经没了 */
        }
    }
    handleStderr(chunk) {
        this.stderrBuffer += chunk;
        for (;;) {
            const newline = this.stderrBuffer.indexOf('\n');
            if (newline < 0)
                break;
            const line = this.stderrBuffer.slice(0, newline).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (!line)
                continue;
            this.stderrTail.push(line);
            while (this.stderrTail.length > MAX_STDERR_LINES)
                this.stderrTail.shift();
            if ((0, settings_1.getSettings)().showStderrNotes)
                this.append('note', `stderr: ${line}`);
        }
        this.scheduleFlush();
    }
    // ---------------------------------------------------------------- IPC（工具）
    /**
     * 控制帧的回执（插件 → 本进程）。
     *
     * 与工具帧共用通道、按 `kind` 分流：工具帧服务**模型**（`req`/`res`），
     * 控制帧服务**面板**（`ctl`/`ctl-res`）。
     */
    handleControlReply(frame) {
        var _a;
        const id = Number(frame.id);
        const entry = this.ctlPending.get(id);
        if (!entry)
            return;
        this.ctlPending.delete(id);
        clearTimeout(entry.timer);
        if (frame.ok === false) {
            entry.reject(new Error(String((_a = frame.error) !== null && _a !== void 0 ? _a : '插件返回失败')));
            return;
        }
        entry.resolve((frame.result && typeof frame.result === 'object' ? frame.result : {}));
    }
    async handleIpcFrame(frame) {
        var _a, _b, _c, _d;
        if (!frame || typeof frame !== 'object')
            return;
        const request = frame;
        if (request.__tag !== constants_1.IPC_TAG || request.kind !== 'req' || request.id === undefined)
            return;
        const method = String((_a = request.method) !== null && _a !== void 0 ? _a : '');
        const params = request.params && typeof request.params === 'object' ? request.params : {};
        const handler = cocos_tools_1.COCOS_IPC_METHODS[method];
        let reply;
        if (!handler) {
            reply = {
                ok: false,
                text: `dsh_chat：未知的编辑器方法 "${method}"（扩展版本与 profile 版本可能不匹配，请重新打开面板或重载扩展）。`,
            };
        }
        else {
            try {
                reply = await handler(params);
            }
            catch (error) {
                reply = { ok: false, text: `编辑器侧处理 "${method}" 时抛错：${describe(error)}` };
            }
        }
        try {
            // 失败时**必须**把原因放进 `error`：DSH 侧插件只读帧上的 `error`（读不到就回落成
            // 一句没有信息量的「编辑器返回失败」）。这里少了它，`result.text` 里那句真原因
            // 就永远到不了模型眼前 —— 实测为此盲试了十几轮。
            (_b = this.child) === null || _b === void 0 ? void 0 : _b.send({
                __tag: constants_1.IPC_TAG,
                kind: 'res',
                id: request.id,
                ok: reply.ok,
                ...(reply.ok ? {} : { error: (_d = (_c = reply.error) !== null && _c !== void 0 ? _c : reply.text) !== null && _d !== void 0 ? _d : '编辑器侧执行失败（没有给出原因）' }),
                result: reply,
            });
        }
        catch (error) {
            console.warn(`[dsh_chat] 回执 IPC 失败：${describe(error)}`);
        }
    }
    // ---------------------------------------------------------------- 通知处理
    handleNotification(method, params) {
        var _a, _b, _c, _d;
        switch (method) {
            case 'session.event': {
                const event = params.event;
                if (event && typeof event === 'object') {
                    this.handleSessionEvent(event, false, String((_a = params.sessionId) !== null && _a !== void 0 ? _a : ''));
                }
                break;
            }
            case 'session.status': {
                this.running = params.status === 'running';
                if (!this.running)
                    this.finishStreams();
                this.scheduleFlush();
                break;
            }
            case 'subagent.started': {
                this.append('note', `子 agent 启动：${String((_b = params.agentId) !== null && _b !== void 0 ? _b : '')}`);
                break;
            }
            case 'subagent.finished': {
                this.append('note', `子 agent 结束：${String((_c = params.agentId) !== null && _c !== void 0 ? _c : '')}（${String((_d = params.status) !== null && _d !== void 0 ? _d : '')}）`);
                break;
            }
            default:
                // 协议可能新增通知；不认识的忽略，不要因为未知方法报错。
                break;
        }
    }
    /**
     * 处理一条会话事件。
     *
     * ⚠ **信封结构是踩过的坑**：`session.event` 的 `params.event` 是
     * `SessionEvent = { type, seq, time, data: SessionEventMap[type] }` ——
     * 载荷一律在 **`event.data`** 里，不在 `event` 上。第一版直接读 `event.name` / `event.message`，
     * 结果是工具名变成 `unknown`、助手文本一个字都上不了屏（而事件本身是好的）。
     * 权威定义见 `dsh-session` 的 `SessionEventMap`。
     *
     * @param event - 事件信封（实时通知与**磁盘日志**同构，所以这一份投影两处共用）。
     * @param replay - 是不是在回放历史：回放时「用户消息」也要上屏（实时那条是 `send()` 自己回显的），
     *   助手消息还要把思考块也画出来（实时走的是 `assistant/chunk` 流式累计）。
     * @param sessionId - 事件属于哪个会话；用于把**别的会话**（子 agent、上一轮 SDK 会话）挡在外面。
     */
    handleSessionEvent(event, replay = false, sessionId = '') {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        // 接上历史会话之后，运行时里可能同时有「老的 SDK 会话」和「接上来的会话」两个 id，
        // 不按 id 过滤的话两段对话会串在一起。子 agent 的会话同样被挡掉（它另有
        // subagent.started/finished 两条 note）。
        if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId)
            return;
        const data = (event.data && typeof event.data === 'object' ? event.data : {});
        switch (String((_a = event.type) !== null && _a !== void 0 ? _a : '')) {
            case 'user/message': {
                // 自己发的那条已经在 send() 里回显过了；这里只把「注入的上下文」记成一行 note，
                // 否则转写里会混进一大堆 AGENTS.md / skill 正文。
                const source = data.source;
                if ((source === null || source === void 0 ? void 0 : source.kind) === 'plugin' && source.form === 'notice' && source.summary) {
                    this.append('note', `注入上下文：${source.summary}`);
                }
                else if (replay && (!source || source.kind === 'user')) {
                    // 回放时用户消息必须画出来（实时那条由 send() 负责；历史里没有 send()）
                    const blocks = (_b = data.content) !== null && _b !== void 0 ? _b : (_c = data.message) === null || _c === void 0 ? void 0 : _c.content;
                    const text = textOfBlocks(blocks);
                    const images = imagesOfBlocks(blocks);
                    // 纯图片消息（没有文字）在日志里是一堆 image 块 —— 也要上屏，只画碎片
                    if (text || images.length > 0)
                        this.append('user', text, undefined, images);
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = data.chunk;
                if (!chunk)
                    break;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    this.pushStream('agent', chunk.text);
                else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string')
                    this.pushStream('thinking', chunk.text);
                break;
            }
            case 'assistant/message': {
                const message = data.message;
                const text = textOfBlocks(message === null || message === void 0 ? void 0 : message.content);
                const interrupted = data.interrupted === true;
                if (replay) {
                    // 回放：思考块也在 content 里（实时是 chunk 流），按块顺序还原
                    for (const block of Array.isArray(message === null || message === void 0 ? void 0 : message.content) ? message === null || message === void 0 ? void 0 : message.content : []) {
                        const typed = block;
                        if ((typed === null || typed === void 0 ? void 0 : typed.type) === 'reasoning' && typeof typed.text === 'string' && typed.text.trim()) {
                            this.append('thinking', typed.text);
                        }
                    }
                    if (text)
                        this.append('agent', text);
                }
                else if (this.textStream) {
                    // 用「拼装好的完整消息」盖掉流式累积（同一 seq → 面板原地替换，不会出现两遍）
                    if (text)
                        this.textStream.text = text;
                    this.touch(this.textStream);
                    this.textStream = null;
                }
                else if (text) {
                    this.append('agent', text);
                }
                this.finishReasoningStream();
                if (interrupted)
                    this.append('note', '本轮被中断（以上是已产出的内容）');
                break;
            }
            case 'tool/call': {
                this.finishStreams();
                const callId = String((_d = data.callId) !== null && _d !== void 0 ? _d : '');
                const entry = this.append('tool', undefined, {
                    name: String((_e = data.name) !== null && _e !== void 0 ? _e : 'unknown'),
                    callId,
                    args: typeof data.arguments === 'string' ? data.arguments : undefined,
                    done: false,
                });
                if (callId)
                    this.toolByCallId.set(callId, entry);
                break;
            }
            case 'tool/result': {
                const message = data.message;
                const callId = String((_k = (_g = (_f = message === null || message === void 0 ? void 0 : message.source) === null || _f === void 0 ? void 0 : _f.callId) !== null && _g !== void 0 ? _g : (_j = (_h = message === null || message === void 0 ? void 0 : message.content) === null || _h === void 0 ? void 0 : _h[0]) === null || _j === void 0 ? void 0 : _j.toolCallId) !== null && _k !== void 0 ? _k : '');
                const entry = callId ? this.toolByCallId.get(callId) : undefined;
                // ⚠ 文本与 isError 的取法见 `toolResultOf`（新老日志形状不同，只认一种会静默丢结果）
                const result = toolResultOf(message);
                const output = result.text;
                const isError = result.isError || data.error !== undefined;
                const shown = output.length > TOOL_OUTPUT_DISPLAY_LIMIT
                    ? `${output.slice(0, TOOL_OUTPUT_DISPLAY_LIMIT)}\n…（已截断，完整结果已交给模型）`
                    : output;
                if (entry) {
                    // `endedAt` 只给面板算耗时用（`entry.at` 是发起时刻）
                    entry.tool = { ...entry.tool, done: true, ok: !isError, output: shown, endedAt: Date.now() };
                    this.touch(entry);
                    if (callId)
                        this.toolByCallId.delete(callId);
                }
                else {
                    this.append('tool', undefined, {
                        name: '(未知工具)',
                        callId,
                        done: true,
                        ok: !isError,
                        output: shown,
                        endedAt: Date.now(),
                    });
                }
                break;
            }
            case 'turn/end': {
                this.finishStreams();
                // ⚠ `reason` 是**对象**不是字符串：`TurnEndReason = { kind: 'completed' | 'aborted'
                // | 'blocked' | 'error' | 'max-tokens' | 'interrupted', ... }`。
                // 第一版 `String(reason)` 直接打出 `[object Object]`。
                const raw = data.reason;
                const kind = typeof raw === 'string' ? raw : String((_l = raw === null || raw === void 0 ? void 0 : raw.kind) !== null && _l !== void 0 ? _l : '');
                if (kind && kind !== 'completed') {
                    const detail = typeof raw === 'object' && ((_m = raw === null || raw === void 0 ? void 0 : raw.error) === null || _m === void 0 ? void 0 : _m.message) ? `：${raw.error.message}` : '';
                    this.append('note', `本轮结束：${kind}${detail}`);
                }
                break;
            }
            default:
                // `turn/start` / `step/start` 等登记型事件不需要上屏。
                break;
        }
    }
    // ---------------------------------------------------------------- 转写
    append(kind, text, tool, images) {
        const entry = { seq: ++this.seq, rev: ++this.revision, kind, at: Date.now(), text, tool };
        if (images && images.length > 0)
            entry.images = images;
        this.entries.push(entry);
        while (this.entries.length > MAX_ENTRIES)
            this.entries.shift();
        this.dirty.add(entry);
        this.scheduleFlush();
        return entry;
    }
    touch(entry) {
        entry.rev = ++this.revision;
        this.dirty.add(entry);
        this.scheduleFlush();
    }
    /** 流式追加：第一条 delta 建条目，后续原地增长（同一 seq，面板原地替换）。 */
    pushStream(kind, delta) {
        var _a;
        let entry = kind === 'agent' ? this.textStream : this.reasoningStream;
        if (!entry) {
            // append() 自己会标脏 + 排刷
            entry = this.append(kind, delta);
            if (kind === 'agent')
                this.textStream = entry;
            else
                this.reasoningStream = entry;
            return;
        }
        entry.text = `${(_a = entry.text) !== null && _a !== void 0 ? _a : ''}${delta}`;
        this.touch(entry);
    }
    /** 结束流式（收尾成静态条目）。 */
    finishStreams() {
        this.textStream = null;
        this.finishReasoningStream();
    }
    finishReasoningStream() {
        if (!this.reasoningStream)
            return;
        if (!this.reasoningStream.text) {
            // 空的思考条目没有意义，从转写里摘掉
            const index = this.entries.indexOf(this.reasoningStream);
            if (index >= 0)
                this.entries.splice(index, 1);
            this.dirty.delete(this.reasoningStream);
        }
        this.reasoningStream = null;
    }
    // ---------------------------------------------------------------- 广播
    setStatus(status) {
        this.status = status;
        this.scheduleFlush();
    }
    fail(message) {
        this.lastError = message;
        this.status = 'error';
        this.append('error', message);
        return { ok: false, error: message };
    }
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }
    flush() {
        if (this.dirty.size === 0)
            return;
        const batch = [...this.dirty].slice(0, FLUSH_BATCH_LIMIT);
        for (const entry of batch)
            this.dirty.delete(entry);
        if (this.dirty.size > 0)
            this.scheduleFlush();
        const update = {
            entries: batch,
            revision: this.revision,
            generation: this.generation,
            status: this.status,
            running: this.running,
        };
        for (const listener of this.listeners) {
            try {
                listener(update);
            }
            catch (error) {
                console.warn(`[dsh_chat] 更新回调抛错：${describe(error)}`);
            }
        }
        try {
            Editor.Message.broadcast(constants_1.BROADCAST_CHANNEL, update);
        }
        catch {
            // 广播是保险丝而非主路：面板还有轮询兜底，这里失败不算错。
        }
    }
}
exports.DshHost = DshHost;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHNoLWhvc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvZHNoLWhvc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW9CRzs7O0FBRUgsaURBQXdEO0FBQ3hELG1DQUFvQztBQUNwQywrQkFBNEI7QUFFNUIsK0NBQWtEO0FBQ2xELDJDQWVxQjtBQUNyQix1Q0FBeUY7QUFFekYsbUNBQStEO0FBQy9ELDZDQUF5QztBQUN6Qyx5Q0FBeUM7QUFFekM7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxTQUFTLGVBQWU7SUFDcEIsT0FBTyxJQUFBLFdBQUksRUFBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNDLENBQUM7QUFFRCx1Q0FBdUM7QUFDdkMsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDO0FBRXhCLHVCQUF1QjtBQUN2QixNQUFNLGdCQUFnQixHQUFHLEVBQUUsQ0FBQztBQUU1QixzQ0FBc0M7QUFDdEMsTUFBTSx5QkFBeUIsR0FBRyxJQUFJLENBQUM7QUFFdkMsZ0NBQWdDO0FBQ2hDLE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDO0FBRTlCLG9DQUFvQztBQUNwQyxNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztBQUk3Qiw4QkFBOEI7QUFDOUIsU0FBUyxZQUFZLENBQUMsTUFBZTtJQUNqQyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUN0QyxNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7SUFDM0IsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUN6QixJQUFJLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUssS0FBMkIsQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7WUFDckYsTUFBTSxJQUFJLEdBQUksS0FBMkIsQ0FBQyxJQUFJLENBQUM7WUFDL0Ms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SSxDQUFDLEtBQUssQ0FBQyxJQUFJLEdBQUcsQ0FBQztZQUFFLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztRQUM5QyxNQUFNLE1BQU0sR0FBbUI7WUFDM0IsT0FBTyxFQUFFLEtBQUs7WUFDZCxRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7WUFDdkIsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO1lBQzNCLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTTtZQUNuQixPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87U0FDeEIsQ0FBQztRQUNGLEtBQUssTUFBTSxRQUFRLElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ3BDLElBQUksQ0FBQztnQkFDRCxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDckIsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2IsT0FBTyxDQUFDLElBQUksQ0FBQyxxQkFBcUIsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUN6RCxDQUFDO1FBQ0wsQ0FBQztRQUNELElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLDZCQUFpQixFQUFFLE1BQTJCLENBQUMsQ0FBQztRQUM3RSxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsK0JBQStCO1FBQ25DLENBQUM7SUFDTCxDQUFDO0NBQ0o7QUF0K0JELDBCQXMrQkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFnZW50IOWuv+S4u++8muaJmOeuoeOAjOiiqyBmb3JrIOWHuuadpeeahCBEU0gg5a2Q6L+b56iL44CN77yM5bm25oqK5a6D55qE5LiJ5p2h5rWB5o6l6LW35p2l44CCXG4gKlxuICogYGBgXG4gKiAgICAgICAgICAgICAgICAgICAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIERTSCDlrZDov5vnqIvvvIjns7vnu58gbm9kZe+8jC0tcHJvZmlsZSBjb2Nvc++8ieKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkFxuICogICDpnaLmnb/vvIjmuLLmn5Pov5vnqIvvvIkgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIJcbiAqICAgICAg4payICDilrIgICAgICAgICAgIOKUgiAgc3Rkb3V0IOKUgOKUgCBTREsgSlNPTi1SUEPvvIhpbml0aWFsaXplIC8gc2Vzc2lvbi5wcm9tcHQgLyBzZXNzaW9uLmV2ZW5077yJ4pSCXG4gKiAgICAgIOKUgiAg4pSCIGJyb2FkY2FzdCDilIIgIHN0ZGVyciDilIDilIAg5o+S5Lu25pel5b+X77yI6K+K5pat5bC+5be077yM5LiN6L+b5LiK5LiL5paH77yJICAgICAgICAgICAgICAgICAgICAgICAgICDilIJcbiAqICAgICAg4pSCICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilKQgIGlwYyAgICDilIDilIAg5Y6f55Sf5bel5YW36LCD55So77yIY29jb3NfZXhlY3V0ZV9jb2RlIOKGkiDmnKzov5vnqIsg4oaSIOacrOaJqeWxleaymeeusS/lnLrmma/ohJrmnKzvvIkgIOKUglxuICogICAgICDilIIgICAgICAgICAgICAgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmFxuICogICAgICDilJTilIDilIAgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdC9nZXQtZXZlbnRz77yI6L2u6K+i5YWc5bqV77yJXG4gKlxuICogIyMg5LiJ5p2h5Y+j5b6EXG4gKlxuICogMS4gKipzdGRvdXQg5piv5Y2P6K6u77yMc3RkZXJyIOaYr+aXpeW/l++8jGlwYyDmmK/lt6XlhbcqKuOAguS4ieiAhee7neS4jea3t+eUqO+8mlxuICogICAgc3Rkb3V0IOS4iuacieadgui0qOihjOWPquS8muiuoeaVsOi3s+i/h++8iOingSBgU2RrQ2xpZW50YO+8ie+8jOS4jeS8muaJk+aWreWvueivneOAglxuICogMi4gKirpnaLmnb/kuKTmnaHot6/pg73og73mi7/liLDmm7TmlrAqKu+8muW5v+aSre+8iOW/q++8jOS9hiBgX19wcm90ZWN0ZWRfX2Ag5piv5L+d5oqk5o6l5Y+j77yJKyDova7or6JcbiAqICAgIGBnZXQtZXZlbnRzYO+8iOaFouS4gOeCue+8jOS9huS4gOWumuWIsO+8ieOAguS4pOadoei3r+WQiOW5tui/m+WQjOS4gOS7vSBgTWFwPHNlcSwgRW50cnk+YO+8jOmdoCBgc2VxYC9gcmV2YCDluYLnrYnjgIJcbiAqIDMuICoq5a2Q6L+b56iL5LiA5a6a6KaB5pS25bmy5YeAKirvvJpgdW5sb2FkKClg44CB57yW6L6R5Zmo6YCA5Ye644CBYWdlbnQg6Ieq5bexIGBleGl0YO+8jOS4ieadoei3r+mDveimgeiQveWIsFxuICogICAg5ZCM5LiA5LiqIGBjbGVhbnVwKClg77yb5ZCm5YiZ5Lya55WZ5LiL5a2k5YS/IG5vZGUg6L+b56iL5Y2g552AIENQVeOAglxuICovXG5cbmltcG9ydCB7IGZvcmssIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHsgQ09DT1NfSVBDX01FVEhPRFMgfSBmcm9tICcuL2NvY29zLXRvb2xzJztcbmltcG9ydCB7XG4gICAgQlJPQURDQVNUX0NIQU5ORUwsXG4gICAgSVBDX1RBRyxcbiAgICBQUk9GSUxFX05BTUUsXG4gICAgdHlwZSBBZ2VudFNuYXBzaG90LFxuICAgIHR5cGUgQWdlbnRTdGF0dXMsXG4gICAgdHlwZSBFbnRyeSxcbiAgICB0eXBlIEVudHJ5SW1hZ2UsXG4gICAgdHlwZSBFbnRyeUtpbmQsXG4gICAgdHlwZSBFdmVudHNQYXlsb2FkLFxuICAgIHR5cGUgSGlzdG9yeVNlc3Npb25WaWV3LFxuICAgIHR5cGUgSGlzdG9yeVZpZXcsXG4gICAgdHlwZSBIb3N0VXBkYXRlVmlldyxcbiAgICB0eXBlIFNlc3Npb25LaW5kLFxuICAgIHR5cGUgVG9vbEVudHJ5LFxufSBmcm9tICcuL2NvbnN0YW50cyc7XG5pbXBvcnQgeyBsaXN0SGlzdG9yeSwgcmVhZEhpc3RvcnksIHRpdGxlT2ZFdmVudHMsIHR5cGUgSGlzdG9yeVNlc3Npb24gfSBmcm9tICcuL2hpc3RvcnknO1xuaW1wb3J0IHsgdHlwZSBWYWxpZEltYWdlIH0gZnJvbSAnLi9pbWFnZXMnO1xuaW1wb3J0IHsgcmVzb2x2ZVJ1bnRpbWUsIHR5cGUgUmVzb2x2ZWRSdW50aW1lIH0gZnJvbSAnLi9wYXRocyc7XG5pbXBvcnQgeyBTZGtDbGllbnQgfSBmcm9tICcuL3Nkay1jbGllbnQnO1xuaW1wb3J0IHsgZ2V0U2V0dGluZ3MgfSBmcm9tICcuL3NldHRpbmdzJztcblxuLyoqXG4gKiDpmo/mianlsZXlj5HluIPnmoTpgJrnlKggc2tpbGwg55uu5b2V77yIYDzmianlsZXmoLk+L3NraWxsc2DvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjopoHmmL7lvI/ms6jlhaXvvJpEU0gg55qEIGBAZGVlcHNlZWstYWkvZHNoLXNraWxsLWZpbGVzeXN0ZW1gIOS8muivu+eOr+Wig+WPmOmHj1xuICogYERTSF9CVU5ETEVEX1NLSUxMX0RJUmAg5bm25oqK5a6D5b2T5oiQICoqYnVuZGxlZCDmoLkqKuaJq+aPj++8iGByYW5rID0gNjAwYO+8jOWFqOihqOacgOS9juS8mOWFiOe6p++8ieOAglxuICog5LqO5piv44CM5byV5pOOL+e8lui+keWZqOaTjeS9nOeahOmAmueUqOefpeivhuOAjSoq6Lef552A5o+S5Lu26LWwKiog4oCU4oCUIOaNouS4quW3peeoi+ijheS4iuWwseacie+8jFxuICog6ICM5bel56iL6Ieq5bex55qEIGAuYWdlbnRzL3NraWxscy9g77yIcmFuayAyMDDvvInjgIHnlKjmiLfnuqcgYH4vLmFnZW50cy9za2lsbHMvYO+8iHJhbmsgNTAw77yJ5LuN54S25LyY5YWI44CCXG4gKlxuICog4pqgICoq5ZCM5ZCN5piv44CM5pW05L2T6KaG55uW44CN6ICM5LiN5piv44CM5ZCI5bm244CNKirvvIhgZHNoLXNraWxsYCDnmoQgYGNvbGxlY3RMYXllcmAg5oyJIHJhbmsg5Y2H5bqPICsg5oyJ5ZCN5a2X5Y676YeN77yJ77yMXG4gKiDmiYDku6XmtojotLnlt6XnqIvph4wqKuS4jeimgSoq5YaN5pS+5LiA5Liq5ZCM5ZCN55qEIGBjb2Nvcy1lZGl0b3Itb3BzYCDigJTigJQg6YKj5Lya5oqK5o+S5Lu26L+Z5Lu95pW05Liq5ZCD5o6J44CCXG4gKiDlrozmlbTlj6PlvoTop4EgYHNraWxscy9SRUFETUUubWRg44CCXG4gKi9cbmZ1bmN0aW9uIGJ1bmRsZWRTa2lsbERpcigpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKF9fZGlybmFtZSwgJy4uJywgJ3NraWxscycpO1xufVxuXG4vKiog6L2s5YaZ5L+d55WZ5LiK6ZmQ77yI6LaF5Ye65Lii5pyA6ICB55qE77yJ44CC6Z2i5p2/5Y+q55yL5pyA6L+R6L+Z5Lqb77yM5aSf55So5LiU5LiN5rao5YaF5a2Y44CCICovXG5jb25zdCBNQVhfRU5UUklFUyA9IDYwMDtcblxuLyoqIHN0ZGVyciDor4rmlq3lsL7lt7Tkv53nlZnooYzmlbDjgIIgKi9cbmNvbnN0IE1BWF9TVERFUlJfTElORVMgPSA0MDtcblxuLyoqIOW3peWFt+e7k+aenOWcqCoq6Z2i5p2/5LiKKirnmoTmiKrmlq3plb/luqbvvIjmqKHlnovmi7/liLDnmoTku43mmK/lrozmlbTnu5PmnpzvvInjgIIgKi9cbmNvbnN0IFRPT0xfT1VUUFVUX0RJU1BMQVlfTElNSVQgPSA0MDAwO1xuXG4vKiog5bm/5pKt6IqC5rWB77ya5rWB5byP5aKe6YeP5Y+v6IO95b6I5a+G77yM5pSS5Yiw5LiA5Liq6Ze06ZqU5YaN5o6o5LiA5qyh44CCICovXG5jb25zdCBGTFVTSF9JTlRFUlZBTF9NUyA9IDEyMDtcblxuLyoqIOS4gOasoeW5v+aSreaQuuW4pueahOadoeebruS4iumZkO+8iOi2heWHuueahOmdoOi9ruivouihpem9kO+8jOmBv+WFjeWNleW4p+i/h+Wkp++8ieOAgiAqL1xuY29uc3QgRkxVU0hfQkFUQ0hfTElNSVQgPSA2MDtcblxuLyoqIOmdouadvy/lhbblroPnm5HlkKzogIXmlLbliLDnmoTmjqjpgIHvvIjnsbvlnovlrprkuYnlnKggY29uc3RhbnRz77yM6Z2i5p2/5YWx55So5ZCM5LiA5Lu977yJ44CCICovXG5leHBvcnQgdHlwZSB7IEhvc3RVcGRhdGVWaWV3IGFzIEhvc3RVcGRhdGUgfSBmcm9tICcuL2NvbnN0YW50cyc7XG4vKiog5LuOIENvbnRlbnRCbG9ja1tdIOmHjOWPlue6r+aWh+acrOOAgiAqL1xuZnVuY3Rpb24gdGV4dE9mQmxvY2tzKGJsb2NrczogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGJsb2NrcykpIHJldHVybiAnJztcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuICAgICAgICBpZiAoYmxvY2sgJiYgdHlwZW9mIGJsb2NrID09PSAnb2JqZWN0JyAmJiAoYmxvY2sgYXMgeyB0eXBlPzogc3RyaW5nIH0pLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgY29uc3QgdGV4dCA9IChibG9jayBhcyB7IHRleHQ/OiBzdHJpbmcgfSkudGV4dDtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgJiYgdGV4dCkgcGFydHMucHVzaCh0ZXh0KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGFydHMuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICog5LuOIENvbnRlbnRCbG9ja1tdIOmHjOWPluWbvueJh+eahCoq5YWD5pWw5o2uKirvvIjlm57mlL7ljoblj7Lml7bnlKjvvInjgIJcbiAqXG4gKiDkuKTnp43lvaLnirbpg73opoHorqTvvIznkIbnlLHlkowgYHRvb2xSZXN1bHRPZmAg5LiA5qC377yIRFNIIOWNh+i/h+eJiO+8ie+8mlxuICpcbiAqIHwg5p2l5rqQIHwg5Zu+54mH5Z2XIHxcbiAqIHwtLS18LS0tfFxuICogfCDmiJHku6zlj5Hlh7rljrvnmoTvvIjpnaLmnb8gZWNob++8iSB8IGB7dHlwZTonaW1hZ2UnLCBkYXRhLCBtaW1lVHlwZX1gIOKAlOKAlCDov5jmsqHov5vpmYTku7blupMgfFxuICogfCDkvJror53ml6Xlv5fph4zorrDkuIvmnaXnmoQgfCBge3R5cGU6J2ltYWdlJywgYXR0YWNobWVudDp7bWVkaWFUeXBlLCBieXRlcywgd2lkdGgsIGhlaWdodCwgbmFtZT99fWAgfFxuICpcbiAqIOaXpeW/l+mHjOmCo+adoSoq5rKh5pyJ5YOP57SgKirvvIjlrZfoioLlj6blrZjlnKjpmYTku7blupPvvInvvIzmiYDku6XpnaLmnb/kuIrljoblj7Lmtojmga/lj6rog73nlLvjgIzlm77lkI0gKyDlsLrlr7jjgI3vvIxcbiAqIOi/meS5n+ato+aYryBgRW50cnlJbWFnZWAg5Y+q5pyJ5YWD5pWw5o2u55qE5Y6f5Zug44CCXG4gKlxuICogQHBhcmFtIGJsb2NrcyAtIGB1c2VyL21lc3NhZ2VgIOeahCBgZGF0YS5jb250ZW50YOOAglxuICogQHJldHVybnMg5Zu+54mH5YWD5pWw5o2u5YiX6KGo77yI6aG65bqP5Y2z5raI5oGv6YeM55qE6aG65bqP77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGltYWdlc09mQmxvY2tzKGJsb2NrczogdW5rbm93bik6IEVudHJ5SW1hZ2VbXSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGJsb2NrcykpIHJldHVybiBbXTtcbiAgICBjb25zdCBvdXQ6IEVudHJ5SW1hZ2VbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG4gICAgICAgIGlmICghYmxvY2sgfHwgdHlwZW9mIGJsb2NrICE9PSAnb2JqZWN0JykgY29udGludWU7XG4gICAgICAgIGNvbnN0IHR5cGVkID0gYmxvY2sgYXMge1xuICAgICAgICAgICAgdHlwZT86IHN0cmluZztcbiAgICAgICAgICAgIG1pbWVUeXBlPzogc3RyaW5nO1xuICAgICAgICAgICAgYXR0YWNobWVudD86IHsgbWVkaWFUeXBlPzogc3RyaW5nOyBieXRlcz86IG51bWJlcjsgd2lkdGg/OiBudW1iZXI7IGhlaWdodD86IG51bWJlcjsgbmFtZT86IHN0cmluZyB9O1xuICAgICAgICB9O1xuICAgICAgICBpZiAodHlwZWQudHlwZSAhPT0gJ2ltYWdlJykgY29udGludWU7XG4gICAgICAgIGNvbnN0IHJlZiA9IHR5cGVkLmF0dGFjaG1lbnQ7XG4gICAgICAgIG91dC5wdXNoKHtcbiAgICAgICAgICAgIG5hbWU6IHJlZj8ubmFtZSxcbiAgICAgICAgICAgIG1pbWVUeXBlOiByZWY/Lm1lZGlhVHlwZSA/PyB0eXBlZC5taW1lVHlwZSxcbiAgICAgICAgICAgIGJ5dGVzOiB0eXBlb2YgcmVmPy5ieXRlcyA9PT0gJ251bWJlcicgPyByZWYuYnl0ZXMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB3aWR0aDogdHlwZW9mIHJlZj8ud2lkdGggPT09ICdudW1iZXInID8gcmVmLndpZHRoIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgaGVpZ2h0OiB0eXBlb2YgcmVmPy5oZWlnaHQgPT09ICdudW1iZXInID8gcmVmLmhlaWdodCA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDkuIDlvKDlvoXlj5HpgIHnmoTlm74g4oaSIFNESyDnmoTlhoXlrrnlnZfvvIhgZGF0YWAg5b+F6aG75piv6KeE6IyDIGJhc2U2NO+8jOingSBgc291cmNlL2ltYWdlcy50c2DvvInjgIIgKi9cbmZ1bmN0aW9uIGltYWdlQmxvY2tPZihpbWFnZTogVmFsaWRJbWFnZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBibG9jazogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6ICdpbWFnZScsIGRhdGE6IGltYWdlLmRhdGEsIG1pbWVUeXBlOiBpbWFnZS5taW1lVHlwZSB9O1xuICAgIGlmIChpbWFnZS5uYW1lKSBibG9jay5uYW1lID0gaW1hZ2UubmFtZTtcbiAgICByZXR1cm4gYmxvY2s7XG59XG5cbi8qKiDmiorlvILluLgv5pyq55+l5pS25pWb5oiQ5LiA5Y+l6K+d44CCICovXG5mdW5jdGlvbiBkZXNjcmliZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiDku44gYHRvb2wvcmVzdWx0YCDnmoQgbWVzc2FnZSDph4zlj5bjgIzmlofmnKwgKyDmmK/kuI3mmK/plJnor6/jgI3igJTigJQgKirkuKTnp43lvaLnirbpg73opoHorqQqKuOAglxuICpcbiAqIOi/meS4jeaYr+a0geeZlu+8jOaYr+Wunua1i+aSnuWHuuadpeeahO+8muWQjOS4gOWkqeeahOS4pOS4quS8muivneaXpeW/l+W9oueKtuS4jeS4gOagt++8iERTSCDljYfov4fniYjvvInjgIJcbiAqXG4gKiB8IOadpea6kCB8IGBtZXNzYWdlLmNvbnRlbnRgIHxcbiAqIHwtLS18LS0tfFxuICogfCDlrp7ml7bkuovku7YgLyDogIHml6Xlv5fvvIhgdmVyc2lvbjogMGDvvIkgfCBgWyB7IHR5cGU6ICd0b29sLXJlc3VsdCcsIHRvb2xDYWxsSWQsIGNvbnRlbnQ6IFvlnZfigKZdLCBpc0Vycm9yIH0gXWAg4oCU4oCUIOWGheWuueWcqCoq6YeM5bGCKiogfFxuICogfCDmlrDml6Xlv5fvvIhgdmVyc2lvbjogNGDvvIkgfCBgWyB7IHR5cGU6ICd0ZXh0JywgdGV4dCB9IF1gIOKAlOKAlCDlhoXlrrkqKuWwseaYryoq6L+Z5LiA5bGCIHxcbiAqXG4gKiDlj6rorqTliY3kuIDnp43nmoTor53vvIzlm57mlL7mlrDml6Xlv5fml7YqKuavj+W8oOW3peWFt+WNoeeJh+eahOe7k+aenOmDveaYr+epuueahCoq77yIYGRvbmU6IHRydWVgIOWNtOS4gOS4quWtl+ayoeacie+8jFxuICog55yL6LW35p2l5YOP5bel5YW35rKh6L6T5Ye677yJ77yM6ICM5LiU5LiN5oql6ZSZ44CCYGlzRXJyb3JgIOWQjOeQhu+8muaWsOW9oueKtuaMguWcqOWkluWxgiBgbWVzc2FnZS5pc0Vycm9yYOOAglxuICpcbiAqIEBwYXJhbSBtZXNzYWdlIC0gYGRhdGEubWVzc2FnZWDjgIJcbiAqIEByZXR1cm5zIOaWh+acrOS4jumUmeivr+agh+iusOOAglxuICovXG5mdW5jdGlvbiB0b29sUmVzdWx0T2YobWVzc2FnZTogdW5rbm93bik6IHsgdGV4dDogc3RyaW5nOyBpc0Vycm9yOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IHR5cGVkID0gKG1lc3NhZ2UgPz8ge30pIGFzIHsgY29udGVudD86IHVua25vd247IGlzRXJyb3I/OiB1bmtub3duIH07XG4gICAgY29uc3QgY29udGVudCA9IHR5cGVkLmNvbnRlbnQ7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGNvbnRlbnQpKSByZXR1cm4geyB0ZXh0OiAnJywgaXNFcnJvcjogdHlwZWQuaXNFcnJvciA9PT0gdHJ1ZSB9O1xuXG4gICAgY29uc3Qgd3JhcHBlciA9IGNvbnRlbnRbMF0gYXMgeyB0eXBlPzogc3RyaW5nOyBjb250ZW50PzogdW5rbm93bjsgaXNFcnJvcj86IHVua25vd24gfSB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBibG9ja3MgPSB3cmFwcGVyPy50eXBlID09PSAndG9vbC1yZXN1bHQnICYmIEFycmF5LmlzQXJyYXkod3JhcHBlci5jb250ZW50KSA/IHdyYXBwZXIuY29udGVudCA6IGNvbnRlbnQ7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdGV4dDogdGV4dE9mQmxvY2tzKGJsb2NrcyksXG4gICAgICAgIGlzRXJyb3I6IHdyYXBwZXI/LmlzRXJyb3IgPT09IHRydWUgfHwgdHlwZWQuaXNFcnJvciA9PT0gdHJ1ZSxcbiAgICB9O1xufVxuXG4vKiogRFNIIOWtkOi/m+eoi+eahOWuv+S4u+OAguaVtOS4quaJqeWxleWPquaciei/meS4gOS4quWunuS+i++8iGBtYWluLnRzYCDph4zmjIHmnInvvInjgIIgKi9cbmV4cG9ydCBjbGFzcyBEc2hIb3N0IHtcbiAgICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIGNsaWVudDogU2RrQ2xpZW50IHwgbnVsbCA9IG51bGw7XG4gICAgcHJpdmF0ZSBzdGF0dXM6IEFnZW50U3RhdHVzID0gJ3N0b3BwZWQnO1xuICAgIHByaXZhdGUgcnVubmluZyA9IGZhbHNlO1xuICAgIHByaXZhdGUgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIGxhc3RCb290TXM6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHJ1bnRpbWU6IFJlc29sdmVkUnVudGltZSA9IHsgbm9kZUV4ZTogbnVsbCwgbm9kZVNvdXJjZTogJ+acquaOoua1iycsIGRzaEJpbjogbnVsbCwgZHNoU291cmNlOiAn5pyq5o6i5rWLJyB9O1xuXG4gICAgLyoqXG4gICAgICog5b2T5YmNIHNlc3Npb25JZCDnmoTmnaXljobjgIJcbiAgICAgKlxuICAgICAqIC0gYHNka2DvvJpTREsg5Y2P6K6uIGBzZXNzaW9uL3Byb21wdGAg5oeS5Yib5bu65Ye65p2l55qE5Lya6K+d77yI6ICB6Lev5a2Q77yJ77ybXG4gICAgICogLSBgcmVzdW1lZGDvvJrmj5Lku7bnlKggYGFnZW50cy5yZXN1bWVgICoq55yf5q2j5o6l5LiKKirnmoTljoblj7LkvJror50g4oCU4oCUIOWPkea2iOaBr+i1sOaOp+WItuW4p++8m1xuICAgICAqIC0gYGhpc3Rvcnlg77ya5Y+q5piv5oqK5Y6G5Y+y5pel5b+X5Zue5pS+5Yiw6Z2i5p2/5LiK77yI5Y+q6K+777yM6L+Y5rKh5o6l5LiK77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXNzaW9uS2luZDogU2Vzc2lvbktpbmQgPSAnc2RrJztcblxuICAgIC8qKiDpnZ7nqbogPSDlr7nor53ljLrmraPlnKjmmL7npLrkuIDmnaHljoblj7LkvJror53jgIIgKi9cbiAgICBwcml2YXRlIGhpc3RvcnlWaWV3OiBIaXN0b3J5VmlldyB8IG51bGwgPSBudWxsO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBlbnRyaWVzOiBFbnRyeVtdID0gW107XG4gICAgcHJpdmF0ZSBzZXEgPSAwO1xuICAgIHByaXZhdGUgcmV2aXNpb24gPSAwO1xuXG4gICAgLyoqIOi9rOWGmeS7o+aVsO+8mua4heepui/mjaLkvJror53lsLEgKzHvvIjpnaLmnb/mja7mraTkuKLlvIPml6fmnaHnm67vvInjgIIgKi9cbiAgICBwcml2YXRlIGdlbmVyYXRpb24gPSAwO1xuXG4gICAgLyoqIOaOp+WItuW4p++8iOmdouadv+KGkuaPkuS7tu+8ieeahOivt+axguWPt+S4juWcqOmjnuivt+axguOAgiAqL1xuICAgIHByaXZhdGUgY3RsU2VxID0gMDtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGN0bFBlbmRpbmcgPSBuZXcgTWFwPG51bWJlciwgeyByZXNvbHZlOiAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB2b2lkOyByZWplY3Q6IChlcnJvcjogRXJyb3IpID0+IHZvaWQ7IHRpbWVyOiBOb2RlSlMuVGltZW91dCB9PigpO1xuXG4gICAgLyoqIOa1geW8j+S4reeahOadoeebru+8iOaWh+acrCAvIOaAneiAg+WQhOS4gOadoe+8jOWbnuWQiOWGheWkjeeUqO+8ieOAgiAqL1xuICAgIHByaXZhdGUgdGV4dFN0cmVhbTogRW50cnkgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHJlYXNvbmluZ1N0cmVhbTogRW50cnkgfCBudWxsID0gbnVsbDtcblxuICAgIC8qKiBjYWxsSWQg4oaSIOW3peWFt+adoeebru+8jOeUqOS6juaKiiBgdG9vbC9yZXN1bHRgIOmFjeWbniBgdG9vbC9jYWxsYOOAgiAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9vbEJ5Q2FsbElkID0gbmV3IE1hcDxzdHJpbmcsIEVudHJ5PigpO1xuXG4gICAgLyoqIOacrOW4p+WGheiiq+aUueWKqOi/h+eahOadoeebru+8iOW5v+aSreeUqO+8ieOAgiAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgZGlydHkgPSBuZXcgU2V0PEVudHJ5PigpO1xuICAgIHByaXZhdGUgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcblxuICAgIHByaXZhdGUgc3RkZXJyVGFpbDogc3RyaW5nW10gPSBbXTtcbiAgICBwcml2YXRlIHN0ZGVyckJ1ZmZlciA9ICcnO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBsaXN0ZW5lcnMgPSBuZXcgU2V0PCh1cGRhdGU6IEhvc3RVcGRhdGVWaWV3KSA9PiB2b2lkPigpO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlr7nlpJblj6ror7tcblxuICAgIC8qKiDms6jlhozmm7TmlrDlm57osIPvvIhgbWFpbi50c2Ag55So5a6D5Y+R5bm/5pKt77yJ44CC6L+U5Zue5rOo6ZSA5Ye95pWw44CCICovXG4gICAgb25VcGRhdGUobGlzdGVuZXI6ICh1cGRhdGU6IEhvc3RVcGRhdGVWaWV3KSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG4gICAgICAgIHRoaXMubGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICAgIHJldHVybiAoKSA9PiB0aGlzLmxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgIH1cblxuICAgIC8qKiDlvZPliY3lv6vnhafjgIIgKi9cbiAgICBzbmFwc2hvdCgpOiBBZ2VudFNuYXBzaG90IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YXR1czogdGhpcy5zdGF0dXMsXG4gICAgICAgICAgICBydW5uaW5nOiB0aGlzLnJ1bm5pbmcsXG4gICAgICAgICAgICBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkLFxuICAgICAgICAgICAgc2Vzc2lvbktpbmQ6IHRoaXMuc2Vzc2lvbktpbmQsXG4gICAgICAgICAgICBoaXN0b3J5OiB0aGlzLmhpc3RvcnlWaWV3ID8geyAuLi50aGlzLmhpc3RvcnlWaWV3IH0gOiBudWxsLFxuICAgICAgICAgICAgZ2VuZXJhdGlvbjogdGhpcy5nZW5lcmF0aW9uLFxuICAgICAgICAgICAgcGlkOiB0aGlzLmNoaWxkPy5waWQgPz8gbnVsbCxcbiAgICAgICAgICAgIGxhc3RCb290TXM6IHRoaXMubGFzdEJvb3RNcyxcbiAgICAgICAgICAgIGxhc3RFcnJvcjogdGhpcy5sYXN0RXJyb3IsXG4gICAgICAgICAgICBlbnRyeUNvdW50OiB0aGlzLmVudHJpZXMubGVuZ3RoLFxuICAgICAgICAgICAgcmV2aXNpb246IHRoaXMucmV2aXNpb24sXG4gICAgICAgICAgICBydW50aW1lOiB7XG4gICAgICAgICAgICAgICAgbm9kZUV4ZTogdGhpcy5ydW50aW1lLm5vZGVFeGUsXG4gICAgICAgICAgICAgICAgZHNoQmluOiB0aGlzLnJ1bnRpbWUuZHNoQmluLFxuICAgICAgICAgICAgICAgIG5vZGVTb3VyY2U6IHRoaXMucnVudGltZS5ub2RlU291cmNlLFxuICAgICAgICAgICAgICAgIGRzaFNvdXJjZTogdGhpcy5ydW50aW1lLmRzaFNvdXJjZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGRlcnJUYWlsOiBbLi4udGhpcy5zdGRlcnJUYWlsXSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiog5aKe6YeP5ouJ5Y+W77ya6L+U5ZueIGByZXYgPiBzaW5jZWAg55qE5p2h55uu77yI5ZCM5LiAIHNlcSDkvJrooqvlj43lpI3ov5Tlm57vvIzpnaLmnb/ljp/lnLDmm7TmlrDvvInjgIIgKi9cbiAgICBldmVudHNTaW5jZShzaW5jZTogbnVtYmVyKTogRXZlbnRzUGF5bG9hZCB7XG4gICAgICAgIGNvbnN0IGZyb20gPSBOdW1iZXIuaXNGaW5pdGUoc2luY2UpID8gc2luY2UgOiAwO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZW50cmllczogdGhpcy5lbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnJldiA+IGZyb20pLFxuICAgICAgICAgICAgcmV2aXNpb246IHRoaXMucmV2aXNpb24sXG4gICAgICAgICAgICBnZW5lcmF0aW9uOiB0aGlzLmdlbmVyYXRpb24sXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqIOaOoua1i+S4gOasoei/kOihjOaXtu+8iOmdouadv+imgeWcqOayoeWQr+WKqOaXtuS5n+iDveaYvuekuuOAjOWwhueUqOWTquS4qiBub2RlL2RzaOOAje+8ieOAgiAqL1xuICAgIHByb2JlUnVudGltZSgpOiBSZXNvbHZlZFJ1bnRpbWUge1xuICAgICAgICB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShnZXRTZXR0aW5ncygpKTtcbiAgICAgICAgcmV0dXJuIHRoaXMucnVudGltZTtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOeUn+WRveWRqOacn1xuXG4gICAgLyoqXG4gICAgICog5ZCv5YqoIGFnZW5044CCXG4gICAgICpcbiAgICAgKiDluYLnrYnvvJrlt7Lnu4/lnKjot5HmiJbmraPlnKjotbflsLHnm7TmjqXov5Tlm57miJDlip/jgIJcbiAgICAgKlxuICAgICAqIEByZXR1cm5zIGB7b2ssIGVycm9yP31g77yb5aSx6LSlKirkuI3mipsqKu+8jOiuqemdouadv+iDveaYvuekuuWOn+WboOOAglxuICAgICAqL1xuICAgIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgPT09ICdyZWFkeScgfHwgdGhpcy5zdGF0dXMgPT09ICdzdGFydGluZycpIHJldHVybiB7IG9rOiB0cnVlIH07XG5cbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSBnZXRTZXR0aW5ncygpO1xuICAgICAgICB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShzZXR0aW5ncyk7XG4gICAgICAgIGlmICghdGhpcy5ydW50aW1lLm5vZGVFeGUpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZhaWwoXG4gICAgICAgICAgICAgICAgJ+aJvuS4jeWIsOWPr+eUqOeahCBub2Rl44CC6K+35ZyoIERTSCDpnaLmnb/orr7nva7ph4zloavjgIxub2RlIOi3r+W+hOOAje+8jOaIluaKiiBub2RlIOWKoOWIsCBQQVRI44CCJyArXG4gICAgICAgICAgICAgICAgICAgICfvvIjms6jmhI/vvJrnvJbovpHlmajoh6rluKbnmoQgRWxlY3Ryb24g5LiN5pivIG5vZGXvvIzkuI3og73mi7/mnaXot5EgZHNo44CC77yJJyxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF0aGlzLnJ1bnRpbWUuZHNoQmluKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5mYWlsKFxuICAgICAgICAgICAgICAgICfmib7kuI3liLAgZHNoIENMSSDlhaXlj6PjgILor7flnKjorr7nva7ph4zloavjgIxkc2ggYmluLmpzIOi3r+W+hOOAje+8iOmAmuW4uOW9ouWmgiAnICtcbiAgICAgICAgICAgICAgICAgICAgJ2A8bnBtIOWFqOWxgOebruW9lT5cXFxcbm9kZV9tb2R1bGVzXFxcXEBkZWVwc2Vlay1haVxcXFxkc2hcXFxcbGliXFxcXGJpbi5qc2DvvInjgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGN3ZCA9IHNldHRpbmdzLndvcmtkaXIgfHwgRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3N0YXJ0aW5nJyk7XG4gICAgICAgIHRoaXMubGFzdEVycm9yID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdGRlcnJUYWlsID0gW107XG4gICAgICAgIHRoaXMuc3RkZXJyQnVmZmVyID0gJyc7XG4gICAgICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGQgPSBmb3JrKHRoaXMucnVudGltZS5kc2hCaW4sIFsnLS1wcm9maWxlJywgUFJPRklMRV9OQU1FXSwge1xuICAgICAgICAgICAgICAgIC8vIOKaoCDlv4XpobvmmL7lvI/nu5kgZXhlY1BhdGjvvJrpu5jorqTkvJrnlKjnvJbovpHlmajnmoQgYHByb2Nlc3MuZXhlY1BhdGhg77yIQ29jb3NDcmVhdG9yLmV4Ze+8iVxuICAgICAgICAgICAgICAgIGV4ZWNQYXRoOiB0aGlzLnJ1bnRpbWUubm9kZUV4ZSxcbiAgICAgICAgICAgICAgICBjd2QsXG4gICAgICAgICAgICAgICAgc3RkaW86IFsncGlwZScsICdwaXBlJywgJ3BpcGUnLCAnaXBjJ10sXG4gICAgICAgICAgICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICAgICAgICAgICAgZW52OiB7XG4gICAgICAgICAgICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgICAgICAgICAgICAvLyDpmo/mianlsZXlj5HluIPnmoTpgJrnlKggc2tpbGwg5qC5IOKAlOKAlCDorqnjgIzlvJXmk44v57yW6L6R5Zmo5pON5L2c55qE6YCa55So55+l6K+G44CN6Lef552A5o+S5Lu26LWw77yMXG4gICAgICAgICAgICAgICAgICAgIC8vIOaNouW3peeoi+ijheS4iuWwseacieOAguingSBidW5kbGVkU2tpbGxEaXIoKSDkuI4gc2tpbGxzL1JFQURNRS5tZOOAglxuICAgICAgICAgICAgICAgICAgICBEU0hfQlVORExFRF9TS0lMTF9ESVI6IGJ1bmRsZWRTa2lsbERpcigpLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgLy8gYHdpbmRvd3NIaWRlYCDmmK/nnJ/lrp7lrZjlnKjnmoTpgInpobnvvIhXaW5kb3dzIOS4iuWIq+W8uem7keahhu+8ie+8jOS9huacrOWcsOeahCBAdHlwZXMvbm9kZVxuICAgICAgICAgICAgICAgIC8vIOavlOWug+aXp+OAgUZvcmtPcHRpb25zIOmHjOi/mOayoeWjsOaYju+8jOaJgOS7pei/memHjOaWreiogOS4gOS4i+iAjOS4jeaYr+WIoOaOiei/meS4qumAiemhueOAglxuICAgICAgICAgICAgfSBhcyBpbXBvcnQoJ2NoaWxkX3Byb2Nlc3MnKS5Gb3JrT3B0aW9ucyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5mYWlsKGDlkK/liqggZHNoIOWtkOi/m+eoi+Wksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5hdHRhY2hDaGlsZCh0aGlzLmNoaWxkKTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICBjd2QsXG4gICAgICAgICAgICAgICAgcHJvdmlkZXI6IHNldHRpbmdzLnByb3ZpZGVyLFxuICAgICAgICAgICAgICAgIG1vZGVsOiBzZXR0aW5ncy5tb2RlbCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MucmVhc29uaW5nRWZmb3J0KSBwYXJhbXMucmVhc29uaW5nRWZmb3J0ID0gc2V0dGluZ3MucmVhc29uaW5nRWZmb3J0O1xuICAgICAgICAgICAgaWYgKHNldHRpbmdzLm1heFRva2VucyA+IDApIHBhcmFtcy5tYXhUb2tlbnMgPSBzZXR0aW5ncy5tYXhUb2tlbnM7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuY2xpZW50Py5pbml0aWFsaXplKHBhcmFtcyBhcyB7IGN3ZDogc3RyaW5nOyBwcm92aWRlcjogc3RyaW5nOyBtb2RlbDogc3RyaW5nIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRlc2NyaWJlKGVycm9yKTtcbiAgICAgICAgICAgIC8vIOi1t+S4jeadpeWwseWIq+eVmeWNiuatu+eahOi/m+eoi1xuICAgICAgICAgICAgdGhpcy5raWxsQ2hpbGQoKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZhaWwoYOWIneWni+WMluWksei0pe+8miR7bWVzc2FnZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMubGFzdEJvb3RNcyA9IERhdGUubm93KCkgLSBzdGFydGVkQXQ7XG4gICAgICAgIHRoaXMuc2V0U3RhdHVzKCdyZWFkeScpO1xuICAgICAgICB0aGlzLmFwcGVuZChcbiAgICAgICAgICAgICdub3RlJyxcbiAgICAgICAgICAgIGBhZ2VudCDlt7LlsLHnu6rvvIgke3RoaXMubGFzdEJvb3RNc31tc++8iSDmqKHlnosgJHtzZXR0aW5ncy5wcm92aWRlcn0vJHtzZXR0aW5ncy5tb2RlbH3vvJvlt6XkvZznm67lvZUgJHtjd2R9YCxcbiAgICAgICAgKTtcblxuICAgICAgICAvLyDlkK/liqjlkI4qKuaOpeedgOS4iuasoeiBiioq77yaRFNIIOeahCB3ZWIg56uv5Lmf5piv6L+Z5Liq6KGM5Li677yI6Z2i5p2/6Ieq5bex5LiN5bim56OB55uY6L2s5YaZ77yM5omA5Lul6L+Y6KaB5oqK5Y6G5Y+y5Zue5pS+5LiA6YGN77yJXG4gICAgICAgIGF3YWl0IHRoaXMucmVzdG9yZUxhc3RTZXNzaW9uKGN3ZCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5ZCv5Yqo5ZCO6Ieq5Yqo5oGi5aSN44CM5pys5bel56iL5pyA6L+R5LiA5p2h5pyJ5YaF5a6555qE5Lya6K+d44CN44CCXG4gICAgICpcbiAgICAgKiAjIyDkuLrku4DkuYjpu5jorqTopoHov5nkuYjlgZpcbiAgICAgKlxuICAgICAqIOS4gOasoeOAjOWBnOatoiDihpIg5ZCv5Yqo44CN5ZyoIERTSCDkvqfmmK8qKuaNouS6huS4gOS4qui/kOihjOaXtioq77yM6ICMIFNESyDljY/orq7ph4znmoQgYHNlc3Npb24vcHJvbXB0YFxuICAgICAqIOWPquS8miBgY3JlYXRlYCDmlrDkvJror53vvIjmqKHlnovkvqfmsqHmnInku7vkvZXljoblj7LkuIrkuIvmlofvvInigJTigJQg5omA5Lul6ICB5Luj56CB6YeMIGBzdGFydCgpYCDmr4/mrKFcbiAgICAgKiDpmo/kvr/mir3kuIDkuKrmlrAgdXVpZO+8jOaViOaenOWwseaYr+OAjOS4gOmHjeWQr++8jOS5i+WJjeiBiueahOWFqOayoeS6huOAjeOAgueUqOaIt+eci+WIsOeahOato+aYr+i/meS4quOAglxuICAgICAqXG4gICAgICog6LWw5o+S5Lu25o6n5Yi25bin55qEIGBzZXNzaW9uL3Jlc3VtZWAg5omN5pivKirnnJ/mgaLlpI0qKu+8iGBhZ2VudHMucmVzdW1lYO+8jOaooeWei+W4puedgOS4iuS4i+aWh+Wbnuadpe+8ie+8jFxuICAgICAqIOmhuuW4puaKiui/meauteWOhuWPsuWbnuaUvuWIsOmdouadv+S4iu+8jOS6juaYr+mHjeWQr+WJjeWQjueahOinguaEn+aYr+i/nue7reeahOOAglxuICAgICAqXG4gICAgICog5aSx6LSl5LiN6Ie05ZG977ya6YCA5Zue44CM5paw5Lya6K+d44CN5bm25oqK5Y6f5Zug5YaZ6L+b6L2s5YaZ77yI5LiN54S255So5oi35Y+q5Lya55yL5Yiw5LiA54mH56m655m977yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBhc3luYyByZXN0b3JlTGFzdFNlc3Npb24oY3dkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGxpc3RlZCA9IGF3YWl0IGxpc3RIaXN0b3J5KHRoaXMucnVudGltZS5ub2RlRXhlLCBjd2QsIDUpO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZWQub2spIHRocm93IG5ldyBFcnJvcihsaXN0ZWQuZXJyb3IgPz8gJ+WIl+WOhuWPsuS8muivneWksei0pScpO1xuICAgICAgICAgICAgY29uc3QgY2FuZGlkYXRlID0gKGxpc3RlZC5zZXNzaW9ucyA/PyBbXSkuZmluZCgoc2Vzc2lvbikgPT4gc2Vzc2lvbi50dXJucyA+IDApID8/IChsaXN0ZWQuc2Vzc2lvbnMgPz8gW10pWzBdO1xuICAgICAgICAgICAgaWYgKCFjYW5kaWRhdGUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNlc3Npb25JZCA9IHJhbmRvbVVVSUQoKTtcbiAgICAgICAgICAgICAgICB0aGlzLnNlc3Npb25LaW5kID0gJ3Nkayc7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ25vdGUnLCAn6L+Y5rKh6IGK6L+H77yM5bey5byA5paw5Lya6K+d44CCJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCB0aGlzLmxvYWRIaXN0b3J5KGNhbmRpZGF0ZS5pZCwgeyBxdWlldDogdHJ1ZSB9KTtcbiAgICAgICAgICAgIGlmICghb3BlbmVkLm9rKSB0aHJvdyBuZXcgRXJyb3Iob3BlbmVkLmVycm9yID8/ICfor7vljoblj7LkvJror53lpLHotKUnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VtZWQgPSBhd2FpdCB0aGlzLnJlc3VtZUhpc3RvcnkoY2FuZGlkYXRlLmlkKTtcbiAgICAgICAgICAgIGlmICghcmVzdW1lZC5vaykgdGhyb3cgbmV3IEVycm9yKHJlc3VtZWQuZXJyb3IgPz8gJ+e7p+e7reS8muivneWksei0pScpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25LaW5kID0gJ3Nkayc7XG4gICAgICAgICAgICB0aGlzLmhpc3RvcnlWaWV3ID0gbnVsbDtcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgICAgICdub3RlJyxcbiAgICAgICAgICAgICAgICBg5rKh6IO95o6l5LiK5LiK5qyh55qE5Lya6K+d77yIJHtkZXNjcmliZShlcnJvcil977yJ4oCU4oCUIOW3suW8gOaWsOS8muivnSAke1N0cmluZyh0aGlzLnNlc3Npb25JZCkuc2xpY2UoMCwgOCl94oCm44CCYCArXG4gICAgICAgICAgICAgICAgICAgICfljoblj7Lku43lnKjlj7PkuIrop5LjgIzljoblj7LjgI3ph4zjgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOWIl+WOhuWPsuS8muivne+8iOmdouadv+S4iueahOOAjOWOhuWPsuOAjeaMiemSru+8ieOAglxuICAgICAqXG4gICAgICogQHBhcmFtIGxpbWl0IC0g5pyA5aSa5Yeg5p2h44CCXG4gICAgICogQHJldHVybnMgYHtvaywgc2Vzc2lvbnM/LCBlcnJvcj99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIGhpc3RvcnlMaXN0KGxpbWl0ID0gMjApOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IHNlc3Npb25zPzogSGlzdG9yeVNlc3Npb25WaWV3W107IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICAgICAgaWYgKCF0aGlzLnJ1bnRpbWUubm9kZUV4ZSkgdGhpcy5ydW50aW1lID0gcmVzb2x2ZVJ1bnRpbWUoZ2V0U2V0dGluZ3MoKSk7XG4gICAgICAgIGNvbnN0IGN3ZCA9IGdldFNldHRpbmdzKCkud29ya2RpciB8fCBFZGl0b3IuUHJvamVjdC5wYXRoO1xuICAgICAgICBjb25zdCBsaXN0ZWQgPSBhd2FpdCBsaXN0SGlzdG9yeSh0aGlzLnJ1bnRpbWUubm9kZUV4ZSwgY3dkLCBsaW1pdCk7XG4gICAgICAgIGlmICghbGlzdGVkLm9rKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBsaXN0ZWQuZXJyb3IgfTtcblxuICAgICAgICBjb25zdCBjdXJyZW50ID0gdGhpcy5oaXN0b3J5Vmlldz8uc2Vzc2lvbklkID8/IG51bGw7XG4gICAgICAgIGNvbnN0IHNlc3Npb25zID0gKGxpc3RlZC5zZXNzaW9ucyA/PyBbXSkubWFwKChzZXNzaW9uOiBIaXN0b3J5U2Vzc2lvbikgPT4gKHtcbiAgICAgICAgICAgIGlkOiBzZXNzaW9uLmlkLFxuICAgICAgICAgICAgdGl0bGU6IHNlc3Npb24udGl0bGUsXG4gICAgICAgICAgICBjcmVhdGVkQXQ6IHNlc3Npb24uY3JlYXRlZEF0LFxuICAgICAgICAgICAgdXBkYXRlZEF0OiBzZXNzaW9uLnVwZGF0ZWRBdCxcbiAgICAgICAgICAgIGJ5dGVzOiBzZXNzaW9uLmJ5dGVzLFxuICAgICAgICAgICAgdHVybnM6IHNlc3Npb24udHVybnMsXG4gICAgICAgICAgICBjdXJyZW50OiBzZXNzaW9uLmlkID09PSBjdXJyZW50LFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXNzaW9ucyB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOaKiuS4gOadoeWOhuWPsuS8muivnSoq5Zue5pS+5Yiw5a+56K+d5Yy6KirvvIjlj6ror7vvvInjgIJcbiAgICAgKlxuICAgICAqIOWbnuaUvui1sOeahOaYr+OAjOWQjOS4gOS7veS6i+S7tua1geOAje+8muaXpeW/l+mHjOeahOS6i+S7tuWSjOWunuaXtumAmuefpeaYr+WQjOaehOeahFxuICAgICAqIO+8iGB7dHlwZSwgc2VxLCB0aW1lLCBkYXRhfWDvvInvvIzmiYDku6Xov5nph4zmioogYGhhbmRsZVNlc3Npb25FdmVudGAg55qEIGByZXBsYXlgIOaho+aJk+W8gO+8jFxuICAgICAqIOiuqeWOhuWPsui1sOS4gOmBjSoq5ZKM5a6e5pe25a6M5YWo5LiA5qC3KirnmoTmipXlvbHpgLvovpEg4oCU4oCUIOS4jeWPpuWGmeS4gOWll+a4suafk+inhOWIme+8jOWwseS4jeS8muS4pOi+ueS4jeS4gOiHtOOAglxuICAgICAqXG4gICAgICog4pqgIOWunua1i++8iGAudG1wL3ZlcmlmeS1yZXN1bWUubWpzYO+8ie+8mmBhZ2VudHMucmVzdW1lYCAqKuS4jeS8mioq5oqK5Y6G5Y+y5LqL5Lu26YeN5pS+5Ye65p2l77yMXG4gICAgICog5omA5Lul6L+Z5q615Zue5pS+5LiN5piv44CM5aSa5q2k5LiA5Li+44CN77yM6ICM5piv44CM5LiN55S75bCx5rKh5pyJ44CN44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gc2Vzc2lvbklkIC0g5Lya6K+dIGlk44CCXG4gICAgICogQHBhcmFtIG9wdGlvbnMucXVpZXQgLSDoh6rliqjmgaLlpI3ml7bkuI3liLfpgqPkuKTooYwgbm90Ze+8iOmBv+WFjeWQr+WKqOWwseS4gOWxj+Wtl++8ieOAglxuICAgICAqIEByZXR1cm5zIGB7b2ssIGV2ZW50cz8sIGVycm9yP31g44CCXG4gICAgICovXG4gICAgYXN5bmMgbG9hZEhpc3Rvcnkoc2Vzc2lvbklkOiBzdHJpbmcsIG9wdGlvbnM6IHsgcXVpZXQ/OiBib29sZWFuIH0gPSB7fSk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgZXZlbnRzPzogbnVtYmVyOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICghdGhpcy5ydW50aW1lLm5vZGVFeGUpIHRoaXMucnVudGltZSA9IHJlc29sdmVSdW50aW1lKGdldFNldHRpbmdzKCkpO1xuICAgICAgICBjb25zdCBjd2QgPSBnZXRTZXR0aW5ncygpLndvcmtkaXIgfHwgRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgY29uc3QgcmVhZCA9IGF3YWl0IHJlYWRIaXN0b3J5KHRoaXMucnVudGltZS5ub2RlRXhlLCBjd2QsIHNlc3Npb25JZCk7XG4gICAgICAgIGlmICghcmVhZC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcmVhZC5lcnJvciB9O1xuXG4gICAgICAgIGNvbnN0IGV2ZW50cyA9IHJlYWQuZXZlbnRzID8/IFtdO1xuICAgICAgICB0aGlzLnJlc2V0VHJhbnNjcmlwdCgpO1xuICAgICAgICB0aGlzLmhpc3RvcnlWaWV3ID0ge1xuICAgICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgICAgdGl0bGU6IHRpdGxlT2ZFdmVudHMoZXZlbnRzKSB8fCAnKOaXoOagh+mimCknLFxuICAgICAgICAgICAgY3JlYXRlZEF0OiAoKHJlYWQuaGVhZGVyID8/IHt9KSBhcyB7IGNyZWF0ZWRBdD86IG51bWJlciB9KS5jcmVhdGVkQXQgPz8gbnVsbCxcbiAgICAgICAgICAgIG1lc3NhZ2VDb3VudDogZXZlbnRzLmxlbmd0aCxcbiAgICAgICAgICAgIGxpdmU6IGZhbHNlLFxuICAgICAgICB9O1xuICAgICAgICB0aGlzLnNlc3Npb25LaW5kID0gJ2hpc3RvcnknO1xuICAgICAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIGV2ZW50cykgdGhpcy5oYW5kbGVTZXNzaW9uRXZlbnQoZXZlbnQsIHRydWUsIHNlc3Npb25JZCk7XG5cbiAgICAgICAgaWYgKCFvcHRpb25zLnF1aWV0KSB7XG4gICAgICAgICAgICB0aGlzLmFwcGVuZChcbiAgICAgICAgICAgICAgICAnbm90ZScsXG4gICAgICAgICAgICAgICAgYOS7peS4iuaYr+WOhuWPsuS8muivnSAke3Nlc3Npb25JZC5zbGljZSgwLCA4KX3igKYg55qEICR7ZXZlbnRzLmxlbmd0aH0g5p2h6K6w5b2V77yI5Y+q6K+75Zue5pS+77yM5YWxICR7cmVhZC50b3RhbCA/PyBldmVudHMubGVuZ3RofSDmnaHvvInjgIJgICtcbiAgICAgICAgICAgICAgICAgICAgJ+aDs+aOpeedgOiBiuWwseeCueS4iumdoueahOOAjOe7p+e7reatpOS8muivneOAjeOAgicsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBldmVudHM6IGV2ZW50cy5sZW5ndGggfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiAqKuecn+ato+aOpeS4iioq5LiA5p2h5Y6G5Y+y5Lya6K+d77yI5o+S5Lu25L6nIGBhZ2VudHMucmVzdW1lYO+8ieOAglxuICAgICAqXG4gICAgICog5o6l5LiK5LmL5ZCO77yaYHNlc3Npb25JZGAg5oyH5ZCR5a6D44CB5ZCO57ut5raI5oGv6LWw5o6n5Yi25bin5oqV5ZaC77yIYGFnZW50LmZvbGxvd3VwYO+8ie+8jFxuICAgICAqIOiAjOa1geW8j+S6i+S7tuS7jeS7jiBTREsg55qEIGBzZXNzaW9uLmV2ZW50YCDpgJrnn6Xlm57mnaXvvIjpgqPkuKrorqLpmIXopobnm5bov5DooYzml7bph4znmoQqKuaJgOaciSoq5Lya6K+d77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gc2Vzc2lvbklkIC0g5Lya6K+dIGlk77yb55yB55Wl5YiZ55So5b2T5YmN5Zue5pS+55qE6YKj5p2h44CCXG4gICAgICogQHJldHVybnMgYHtvaywgc2Vzc2lvbklkPywgZXJyb3I/fWDjgIJcbiAgICAgKi9cbiAgICBhc3luYyByZXN1bWVIaXN0b3J5KHNlc3Npb25JZD86IHN0cmluZyk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IHNlc3Npb25JZCA/PyB0aGlzLmhpc3RvcnlWaWV3Py5zZXNzaW9uSWQ7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5Y+v57un57ut55qE5Lya6K+d77yI5YWI5LuO44CM5Y6G5Y+y44CN6YeM5omT5byA5LiA5p2h77yJJyB9O1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2hpbGQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdhZ2VudCDmsqHlnKjot5Eg4oCU4oCUIOWFiOeCueOAjOWQr+WKqOOAjeWGjee7p+e7rei/meadoeS8muivnScgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gZ2V0U2V0dGluZ3MoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY2FsbENoaWxkKFxuICAgICAgICAgICAgICAgICdzZXNzaW9uL3Jlc3VtZScsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBzZXNzaW9uSWQ6IHRhcmdldCxcbiAgICAgICAgICAgICAgICAgICAgcHJvdmlkZXI6IHNldHRpbmdzLnByb3ZpZGVyLFxuICAgICAgICAgICAgICAgICAgICBtb2RlbDogc2V0dGluZ3MubW9kZWwsXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbmluZ0VmZm9ydDogc2V0dGluZ3MucmVhc29uaW5nRWZmb3J0IHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgbWF4VG9rZW5zOiBzZXR0aW5ncy5tYXhUb2tlbnMgPiAwID8gc2V0dGluZ3MubWF4VG9rZW5zIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgMTgwXzAwMCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25JZCA9IHRhcmdldDtcbiAgICAgICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAncmVzdW1lZCc7XG4gICAgICAgICAgICBpZiAodGhpcy5oaXN0b3J5VmlldykgdGhpcy5oaXN0b3J5VmlldyA9IHsgLi4udGhpcy5oaXN0b3J5Vmlldywgc2Vzc2lvbklkOiB0YXJnZXQsIGxpdmU6IHRydWUgfTtcbiAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlzdG9yeVZpZXcgPSB7IHNlc3Npb25JZDogdGFyZ2V0LCB0aXRsZTogJyjmnKrlm57mlL4pJywgY3JlYXRlZEF0OiBudWxsLCBtZXNzYWdlQ291bnQ6IDAsIGxpdmU6IHRydWUgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgICAgICdub3RlJyxcbiAgICAgICAgICAgICAgICBg5bey5o6l5LiK5Lya6K+dICR7dGFyZ2V0LnNsaWNlKDAsIDgpfeKApu+8iGFnZW50ICR7U3RyaW5nKHJlc3VsdC5hZ2VudElkID8/ICc/Jykuc2xpY2UoMCwgOCl94oCm77yJ4oCU4oCUYCArXG4gICAgICAgICAgICAgICAgICAgICfmjqXkuIvmnaXnmoTmtojmga/kvJrluKbnnYDlroPnmoTkuIrkuIvmlofjgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXNzaW9uSWQ6IHRhcmdldCB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRlc2NyaWJlKGVycm9yKTtcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdlcnJvcicsIGDnu6fnu63kvJror53lpLHotKXvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDlj5HkuIDmnaHmjqfliLbluKflubbnrYnlm57miafvvIjpnaLmnb/ihpLmj5Lku7bpgqPkuIDot6/vvInjgIJcbiAgICAgKlxuICAgICAqIOS4juW3peWFt+W4p++8iGBraW5kOiAncmVxJ2DvvInlhbHnlKggSVBDIOmAmumBk++8jOmdoCBga2luZGAg5Yy65YiG77yb5Zue5omn5ZyoIGBhdHRhY2hDaGlsZGAg55qEXG4gICAgICog5raI5oGv6Lev55Sx6YeM5oyJIGBpZGAg6YWN5a+544CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBjYWxsQ2hpbGQoXG4gICAgICAgIG1ldGhvZDogc3RyaW5nLFxuICAgICAgICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICB0aW1lb3V0TXMgPSA2MF8wMDAsXG4gICAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgICAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XG4gICAgICAgIGlmICghY2hpbGQpIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoJ2FnZW50IOWtkOi/m+eoi+S4jeWcqCcpKTtcblxuICAgICAgICBjb25zdCBpZCA9ICsrdGhpcy5jdGxTZXE7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuY3RsUGVuZGluZy5kZWxldGUoaWQpO1xuICAgICAgICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYOaOp+WItuW4pyAke21ldGhvZH0g5ZyoICR7dGltZW91dE1zfW1zIOWGheayoeacieWbnuaJp++8iOaPkuS7tueJiOacrOi/h+aXp++8n2AgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICfmnKzmianlsZXopoHmsYIgZHNoLWNvY29zLWJyaWRnZSDmlK/mjIHmjqfliLbpgJrpgZPvvIzlhYjot5HkuIDmrKEgc2NyaXB0cy9pbnN0YWxsLXByb2ZpbGUuanPvvIknLFxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9LCB0aW1lb3V0TXMpO1xuICAgICAgICAgICAgdGhpcy5jdGxQZW5kaW5nLnNldChpZCwgeyByZXNvbHZlLCByZWplY3QsIHRpbWVyIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjaGlsZC5zZW5kKHsgX190YWc6IElQQ19UQUcsIGtpbmQ6ICdjdGwnLCBpZCwgbWV0aG9kLCBwYXJhbXMgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICAgICAgdGhpcy5jdGxQZW5kaW5nLmRlbGV0ZShpZCk7XG4gICAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihg5Y+R6YCB5o6n5Yi25bin5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKiog5YGc5q2iIGFnZW5044CC5YWI6LWw5Y2P6K6uIGBzaHV0ZG93bmDvvIjmnI3liqHnq6/kvJroh6rlt7HpgIDlh7rvvInvvIzlhZzlupXlho0ga2lsbOOAgiAqL1xuICAgIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICghdGhpcy5jaGlsZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3N0b3BwZWQnKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3N0b3BwaW5nJyk7XG4gICAgICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnQ7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBjbGllbnQ/LnNodXRkb3duKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0gc2h1dGRvd24g6K+35rGC5rKh6LWw5a6M77yI57un57utIGtpbGzvvInvvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICAgICAgfVxuICAgICAgICAvLyDmnI3liqHnq6/pgJrluLjkvJroh6rlt7EgZXhpdO+8m+e7meWugyAxLjVz77yM54S25ZCO5YWc5bqV44CCXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2hpbGQua2lsbCgpO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8qIOW3sue7j+ayoeS6hiAqL1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICAgIH0sIDE1MDApO1xuICAgICAgICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5jbGVhbnVwKCk7XG4gICAgICAgIHRoaXMuc2V0U3RhdHVzKCdzdG9wcGVkJyk7XG4gICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgJ2FnZW50IOW3suWBnOatoicpO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOS4reaWrSoq5b2T5YmN6L+Z5LiA6L2uKirvvIjpnaLmnb/kuIrpgqPkuKrjgIzlgZzmraLmnKzova7jgI3mjInpkq7vvInjgIJcbiAgICAgKlxuICAgICAqICMjIOS4uuS7gOS5iOWug+W/hemhu+acie+8jOS7peWPiuS4uuS7gOS5iOWPquiDvei/meS5iOWBmlxuICAgICAqXG4gICAgICogU0RLIOWNj+iuruWPquaciSBgaW5pdGlhbGl6ZWAgLyBgc2Vzc2lvbi9wcm9tcHRgIC8gYHNodXRkb3duYCDkuInkuKrmlrnms5XvvIxcbiAgICAgKiAqKuayoeacieOAjOWPlua2iOi/meS4gOi9ruOAjSoq77yb6ICM5LiUIGBzZXNzaW9uL3Byb21wdGAg55qE5Zue5omn5Y+q5piv44CM5YWl6Zif5oiQ5Yqf44CNXG4gICAgICog77yIYFNlc3Npb25Qcm9tcHRSZXN1bHRgIOaYryBkdXJhYmxlIGVucXVldWUgcmVjZWlwdO+8ie+8jOaLv+WIsOWbnuaJp+KJoOi/meS4gOi9rue7k+adn+OAglxuICAgICAqIOaJgOS7peWcqOWKoOi/meadoemAmumBk+S5i+WJje+8jOmdouadv+S4iuWUr+S4gOeahOOAjOWBnOatouOAjeaYryoq5p2A5o6J5pW05LiqIGFnZW50IOi/m+eoiyoqIOKAlOKAlFxuICAgICAqIOS8muivneOAgeWtkCBhZ2VudOOAgeato+WcqOi3keeahOW3peWFt+S4gOi1t+ayoe+8jOS4i+S4gOWPpei/mOimgemHjeaWsOWQr+WKqCArIOiHquWKqOaOpeS4iuS4i+aWh+OAglxuICAgICAqIOOAjEFJIOaDs+atquS6huaDs+aUueWPo+OAjei/meenjeacgOW4uOingeeahOWcuuaZr++8jOS7o+S7t+mrmOW+l+emu+iwseOAglxuICAgICAqXG4gICAgICog55yf5q2j6IO95Y+W5raI55qE5piv6L+Q6KGM5pe25YaF6YOo55qEIGBBZ2VudC5jYW5jZWwoY2F1c2UpYO+8jOiAjOWug+WPquacieaPkuS7tuiDveiwg1xuICAgICAqIO+8iOingSBgZHNoLWNvY29zLWJyaWRnZWAg55qEIGBzZXNzaW9uL2NhbmNlbGDvvInjgILov5nmnaHmlrnms5XlsLHmmK/pgqPkuIDmraXnmoTovazlj5HvvJpcbiAgICAgKlxuICAgICAqIGBgYFxuICAgICAqIOmdouadv+OAjOWBnOatouacrOi9ruOAjeKGkiDkuLvov5vnqIsgaW50ZXJydXB0KCkg4oaSIGN0bCBzZXNzaW9uL2NhbmNlbCB7c2Vzc2lvbklkfVxuICAgICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKGkiDmj5Lku7YgYWdlbnRzLmdldChzZXNzaW9uSWQpLmNhbmNlbCh7a2luZDondXNlcid9KVxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogIyMg5LiJ5p2h5Y+j5b6EXG4gICAgICpcbiAgICAgKiAxLiAqKuayoeWcqOi3keWwseS4jeeul+mUmSoq77yaYHJ1bm5pbmdgIOS4uuWBh+ebtOaOpeWbnuS4gOWPpSBub3Rl77yM5LiN5omT5omw5o+S5Lu2IOKAlOKAlFxuICAgICAqICAgIOaMiemSruS4juOAjOi/meS4gOi9ruWImuWlveiHquW3see7k+adn+OAjeS5i+mXtOacieWkqeeEtuernuaAge+8jOaKpee6ouaYr+ivr+aKpeOAglxuICAgICAqIDIuICoq5Lit5pat5LiN5piv5Zue5ruaKirvvJrlt7Lnu4/kuqflh7rnmoTmlofmnKwgLyDlt7Lnu4/ot5HlroznmoTlt6XlhbfosIPnlKjpg73nlZnnnYBcbiAgICAgKiAgICDvvIhgYXNzaXN0YW50L21lc3NhZ2VgIOeahCBgaW50ZXJydXB0ZWRgIOS4jiBgdHVybi9lbmRgIOeahCBgYWJvcnRlZGAg5Lya5Yiw77yM6L2s5YaZ6YeM5Lya5aSa5LiA5p2hIG5vdGXvvInjgIJcbiAgICAgKiAzLiAqKuS4jeWKqCBgc2Vzc2lvbklkYCoq77ya5Lit5pat5LmL5ZCO5o6l552A6K+077yM6L+Y5piv5ZCM5LiA5Liq5Lya6K+d44CB5ZCM5LiA5q615LiK5LiL5paH44CCXG4gICAgICpcbiAgICAgKiBAcmV0dXJucyBge29rLCBjYW5jZWxsZWQ/LCBzdGF0dXM/LCBlcnJvcj99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIGludGVycnVwdCgpOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGNhbmNlbGxlZD86IGJvb2xlYW47IHN0YXR1cz86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2hpbGQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdhZ2VudCDov5jmsqHlsLHnu6onIH07XG4gICAgICAgIGlmICghdGhpcy5zZXNzaW9uSWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfov5jmsqHmnInkvJror50nIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIOKaoCAqKuS4jeaLvyBgdGhpcy5ydW5uaW5nYCDlvZPpl7jpl6gqKu+8muWug+adpeiHqiBgc2Vzc2lvbi5zdGF0dXNgIOmAmuefpe+8jOWPr+iDveWcqFxuICAgICAgICAgICAgICog44CM6Z2i5p2/5Yia6YeN5byA44CN44CM6YCa55+l6L+Y5rKh5Yiw44CN5pe25piv6ZmI5pen55qEIGBmYWxzZWDvvJvogIwqKuiwgeWcqOi3kSoq6L+Z5Lu25LqL77yMXG4gICAgICAgICAgICAgKiDov5DooYzml7bph4znmoQgYGFnZW50LnN0YXR1c2Ag5omN5piv55yf5rqQ44CC5omA5Lul5LiA5b6L6Zeu5o+S5Lu277yM55Sx5a6D5ZueIGBjYW5jZWxsZWRg44CCXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY2FsbENoaWxkKCdzZXNzaW9uL2NhbmNlbCcsIHsgc2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCB9LCAxNV8wMDApO1xuICAgICAgICAgICAgY29uc3QgY2FuY2VsbGVkID0gcmVzdWx0LmNhbmNlbGxlZCA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IHN0YXR1cyA9IHR5cGVvZiByZXN1bHQuc3RhdHVzID09PSAnc3RyaW5nJyA/IHJlc3VsdC5zdGF0dXMgOiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGNhbmNlbGxlZCA/ICflt7Lor7fmsYLkuK3mlq3ov5nkuIDova7vvIjkvJror53kv53nlZnvvIzlj6/ku6XmjqXnnYDor7TvvIknIDogJ+i/meS4gOi9ruW3sue7j+e7k+adn+S6hicpO1xuICAgICAgICAgICAgLy8g5LmQ6KeC5pS25pWb77ya5Lit5pat6K+35rGC5bey5Y+X55CG5pe277yM5pys5ZywIHJ1bm5pbmcg56uL5Yi7572u5L2N77yM5Yir562J5LiL5LiA5qyh6YCa55+lXG4gICAgICAgICAgICAvLyDvvIjpnaLmnb/pgqPkuKrmjInpkq7nmoTnpoHnlKjmgIHpnaDlroPvvIzkuI3nhLbkvJrmnInkuIDlsI/mrrXjgIznnIvotbfmnaXmsqHlj43lupTjgI3vvIlcbiAgICAgICAgICAgIGlmIChjYW5jZWxsZWQpIHRoaXMucnVubmluZyA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGNhbmNlbGxlZCwgc3RhdHVzIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGVzY3JpYmUoZXJyb3IpO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgYOS4reaWreWksei0pe+8miR7bWVzc2FnZX1gKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKiDlvIDkuIDkuKrmlrDkvJror53vvIjmlrDnmoQgc2Vzc2lvbklk77yb5pen5Lya6K+d5ZyoIERTSCDkvqfku43mjInml6Xlv5fnlZnlnKjno4Hnm5jkuIrvvInjgIIgKi9cbiAgICBuZXdTZXNzaW9uKCk6IHsgb2s6IGJvb2xlYW47IHNlc3Npb25JZDogc3RyaW5nIHwgbnVsbCB9IHtcbiAgICAgICAgLy8g5o6l5LiK5p2l55qE5Y6G5Y+y5Lya6K+d5pivKirmj5Lku7bmjIHmnInnmoQgYWdlbnQqKu+8muW8gOaWsOS8muivneWwseimgeaYvuW8j+aUvuaOieWug++8jFxuICAgICAgICAvLyDlkKbliJnlroPkvJrkuIDnm7TmjILlnKjov5DooYzml7bph4zvvIjkuIvmrKEgcmVzdW1lIOWQjOS4gOS4qiBpZCDkvJrmkp7kuIrvvInjgIJcbiAgICAgICAgaWYgKHRoaXMuc2Vzc2lvbktpbmQgPT09ICdyZXN1bWVkJyAmJiB0aGlzLnNlc3Npb25JZCkge1xuICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSB0aGlzLnNlc3Npb25JZDtcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYWxsQ2hpbGQoJ3Nlc3Npb24vZGlzcG9zZScsIHsgc2Vzc2lvbklkOiBwcmV2aW91cyB9KS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g6YeK5pS+5Lya6K+dICR7cHJldmlvdXMuc2xpY2UoMCwgOCl94oCmIOWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG4gICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnc2RrJztcbiAgICAgICAgdGhpcy5oaXN0b3J5VmlldyA9IG51bGw7XG4gICAgICAgIHRoaXMucmVzZXRUcmFuc2NyaXB0KCk7XG4gICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgYOW3suW8gOaWsOS8muivnSAke3RoaXMuc2Vzc2lvbklkLnNsaWNlKDAsIDgpfeKApu+8iOS4iuS4gOauteWvueivneS7jeWcqOWPs+S4iuinkuOAjOWOhuWPsuOAjemHjO+8jOmaj+aXtuWPr+S7peaOpeedgOiBiu+8iWAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5riF56m65a+56K+d5Yy677yI5o2i5Lya6K+dL+WbnuaUvuWOhuWPsuWJjeiwg+eUqO+8ieOAglxuICAgICAqXG4gICAgICogKirku6PmlbAgKzEqKiDmmK/nu5npnaLmnb/nmoTkv6Hlj7fvvJrpnaLmnb/lj6rmjIkgYHJldmAg5ouJ5aKe6YeP77yM5rKh5rOV6KGo6L6+44CM5p+Q5p2h6KKr5Yig5o6J5LqG44CN77yMXG4gICAgICog5omA5Lul44CM5riF56m644CN6L+Z5Lu25LqL5b+F6aG75pyJ5LiA5Liq54us56uL55qE44CB5Y2V6LCD6YCS5aKe55qE6K6w5Y+377yIYGdlbmVyYXRpb25g77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNldFRyYW5zY3JpcHQoKTogdm9pZCB7XG4gICAgICAgIHRoaXMuZW50cmllcy5sZW5ndGggPSAwO1xuICAgICAgICB0aGlzLnNlcSA9IDA7XG4gICAgICAgIHRoaXMuZ2VuZXJhdGlvbiArPSAxO1xuICAgICAgICB0aGlzLnRleHRTdHJlYW0gPSBudWxsO1xuICAgICAgICB0aGlzLnJlYXNvbmluZ1N0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMudG9vbEJ5Q2FsbElkLmNsZWFyKCk7XG4gICAgICAgIHRoaXMuZGlydHkuY2xlYXIoKTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5Y+R5LiA5p2h55So5oi35raI5oGv77yI5paH5pysICsg5Y+v6YCJ5Zu+54mH77yJ44CCXG4gICAgICpcbiAgICAgKiDlm57miaflj6rku6PooagqKuWFpemYnyoq5oiQ5Yqf77yb562U5qGI6YCa6L+HIGBzZXNzaW9uLmV2ZW50YCDlvILmraXliLDmnaXvvIjop4EgYGhhbmRsZVNlc3Npb25FdmVudGDvvInjgIJcbiAgICAgKlxuICAgICAqIOS4ieadoei3r++8mlxuICAgICAqIC0g5o6l5LiK5p2l55qE5Y6G5Y+y5Lya6K+d77yIYHJlc3VtZWRg77yJ6LWw5o6n5Yi25bin77yI5o+S5Lu2IGBzZXNzaW9uL3Byb21wdGDvvIzlm77niYfnlLHmj5Lku7bpgIHov5vpmYTku7blupPvvInvvJtcbiAgICAgKiAtIOWFtuS9mei1sCBTREsg55qEIGBzZXNzaW9uL3Byb21wdGDvvIjmnI3liqHnq6/mh5LliJvlu7rkvJror53vvIzlm77niYfnlLHmnI3liqHnq6/pgIHov5vpmYTku7blupPvvInvvJtcbiAgICAgKiAtIOWPquacieWbvuayoeacieWtl+S5n+WFgeiuuO+8iOaooeWei+WPqueci+Wbvu+8ieOAglxuICAgICAqXG4gICAgICogQHBhcmFtIHRleHQgLSDnlKjmiLfovpPlhaXnmoTmlofmnKzvvIjlj6/nqbrvvInjgIJcbiAgICAgKiBAcGFyYW0gaW1hZ2VzIC0g5bey57uP6L+HIGB2YWxpZGF0ZUltYWdlQmF0Y2hgIOeahOWbvueJh++8iOWPr+epuu+8ieOAglxuICAgICAqIEByZXR1cm5zIGB7b2ssIGVycm9yPywgbWVzc2FnZUlkP31g44CCXG4gICAgICovXG4gICAgYXN5bmMgc2VuZCh0ZXh0OiBzdHJpbmcsIGltYWdlczogVmFsaWRJbWFnZVtdID0gW10pOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmcgfT4ge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBpbWFnZXMuZmlsdGVyKChpbWFnZSkgPT4gaW1hZ2UgJiYgdHlwZW9mIGltYWdlLmRhdGEgPT09ICdzdHJpbmcnICYmIGltYWdlLmRhdGEpO1xuICAgICAgICBpZiAoIWNvbnRlbnQgJiYgYXR0YWNobWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5raI5oGv5piv56m655qEJyB9O1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2xpZW50KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnYWdlbnQg6L+Y5rKh5bCx57uqJyB9O1xuICAgICAgICBpZiAoIXRoaXMuc2Vzc2lvbklkKSB7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25JZCA9IHJhbmRvbVVVSUQoKTtcbiAgICAgICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnc2RrJztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOWGheWuueWdl++8muaWh+acrOWcqOWJjeOAgeWbvueJh+WcqOWQju+8iOmZhOS7tuW6k+aMiemhuuW6j+aKiiBpbWFnZSDlnZfmjaLmiJDpmYTku7blvJXnlKjvvIzpobrluo/ljbPmtojmga/pobrluo/vvIlcbiAgICAgICAgY29uc3QgYmxvY2tzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgICAgICAgaWYgKGNvbnRlbnQpIGJsb2Nrcy5wdXNoKHsgdHlwZTogJ3RleHQnLCB0ZXh0OiBjb250ZW50IH0pO1xuICAgICAgICBmb3IgKGNvbnN0IGltYWdlIG9mIGF0dGFjaG1lbnRzKSBibG9ja3MucHVzaChpbWFnZUJsb2NrT2YoaW1hZ2UpKTtcblxuICAgICAgICAvLyDmnKzlnLDnq4vljbPlm57mmL7vvIjkuI3nrYkgYHVzZXIvbWVzc2FnZWAg5LqL5Lu277yM6YG/5YWNXCLngrnkuobmsqHlj43lupRcIueahOmUmeinie+8ieOAglxuICAgICAgICAvLyDlm77niYflj6rorrDlhYPmlbDmja4g4oCU4oCUIOi9rOWGmeaYr+imgee7j+W5v+aSrS/ova7or6Llm57pnaLmnb/nmoTvvIzloZ7lg4/ntKDov5vljrvkvJrmiorpnaLmnb/mi5bmrbvvvIjop4EgYEVudHJ5SW1hZ2Vg77yJ44CCXG4gICAgICAgIHRoaXMuYXBwZW5kKCd1c2VyJywgY29udGVudCwgdW5kZWZpbmVkLCBhdHRhY2htZW50cy5tYXAoKGltYWdlKSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogaW1hZ2UubmFtZSxcbiAgICAgICAgICAgIG1pbWVUeXBlOiBpbWFnZS5taW1lVHlwZSxcbiAgICAgICAgICAgIGJ5dGVzOiBpbWFnZS5ieXRlcyxcbiAgICAgICAgfSkpKTtcbiAgICAgICAgdGhpcy50ZXh0U3RyZWFtID0gbnVsbDtcbiAgICAgICAgdGhpcy5yZWFzb25pbmdTdHJlYW0gPSBudWxsO1xuXG4gICAgICAgIGlmICh0aGlzLnNlc3Npb25LaW5kID09PSAncmVzdW1lZCcpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5jYWxsQ2hpbGQoJ3Nlc3Npb24vcHJvbXB0Jywge1xuICAgICAgICAgICAgICAgICAgICBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgICAgICB0ZXh0OiBjb250ZW50LFxuICAgICAgICAgICAgICAgICAgICAvLyDmjqfliLbluKfkuIrkuZ/otbAgYmFzZTY077yI5o+S5Lu26YKj6L656L2s5oiQ6ZmE5Lu25byV55So77yJ77yM5Yir5Lyg6Lev5b6E77yaXG4gICAgICAgICAgICAgICAgICAgIC8vIOaPkuS7tui3keWcqCBEU0gg6L+Q6KGM5pe26YeM77yM5a6D6K+75LiN5Yiw57yW6L6R5Zmo55qE5bel56iL55uu5b2V6K+t5LmJ44CCXG4gICAgICAgICAgICAgICAgICAgIGltYWdlczogYXR0YWNobWVudHMubWFwKChpbWFnZSkgPT4gKHsgbWltZVR5cGU6IGltYWdlLm1pbWVUeXBlLCBkYXRhOiBpbWFnZS5kYXRhLCBuYW1lOiBpbWFnZS5uYW1lIH0pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbWVzc2FnZUlkOiB0eXBlb2YgcmVzdWx0Lm1lc3NhZ2VJZCA9PT0gJ3N0cmluZycgPyByZXN1bHQubWVzc2FnZUlkIDogdW5kZWZpbmVkIH07XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBkZXNjcmliZShlcnJvcik7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgYOWPkemAgeWksei0pe+8iOW3suaOpeS4iueahOWOhuWPsuS8muivnei1sOaOp+WItuW4p++8ie+8miR7bWVzc2FnZX1gKTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gKGF3YWl0IHRoaXMuY2xpZW50LnByb21wdCh0aGlzLnNlc3Npb25JZCwgYmxvY2tzKSkgYXMgeyBtZXNzYWdlSWQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtZXNzYWdlSWQ6IHJlc3VsdD8ubWVzc2FnZUlkIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGVzY3JpYmUoZXJyb3IpO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgYOWPkemAgeWksei0pe+8miR7bWVzc2FnZX1gKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKiDmianlsZXljbjovb3ml7bosIPnlKjvvJrmlq3lvIDkuIDliIfjgIHmnYDmjonlrZDov5vnqIvjgIIgKi9cbiAgICBhc3luYyBkaXNwb3NlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgICB0aGlzLmxpc3RlbmVycy5jbGVhcigpO1xuICAgICAgICBpZiAodGhpcy5mbHVzaFRpbWVyKSB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGhpcy5mbHVzaFRpbWVyKTtcbiAgICAgICAgICAgIHRoaXMuZmx1c2hUaW1lciA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuY2hpbGQpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgdGhpcy5jbGllbnQ/LmRpc3Bvc2UoKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5raWxsQ2hpbGQoKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmNsZWFudXAoKTtcbiAgICAgICAgdGhpcy5zdGF0dXMgPSAnc3RvcHBlZCc7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlrZDov5vnqIvmjqXnur9cblxuICAgIHByaXZhdGUgYXR0YWNoQ2hpbGQoY2hpbGQ6IENoaWxkUHJvY2Vzcyk6IHZvaWQge1xuICAgICAgICB0aGlzLmNsaWVudCA9IG5ldyBTZGtDbGllbnQoY2hpbGQsIChtZXRob2QsIHBhcmFtcykgPT4gdGhpcy5oYW5kbGVOb3RpZmljYXRpb24obWV0aG9kLCBwYXJhbXMpKTtcbiAgICAgICAgdGhpcy5jbGllbnQuYXR0YWNoKCk7XG5cbiAgICAgICAgY2hpbGQuc3Rkb3V0Py5zZXRFbmNvZGluZygndXRmOCcpO1xuICAgICAgICBjaGlsZC5zdGRlcnI/LnNldEVuY29kaW5nKCd1dGY4Jyk7XG4gICAgICAgIGNoaWxkLnN0ZGVycj8ub24oJ2RhdGEnLCAoY2h1bms6IHN0cmluZykgPT4gdGhpcy5oYW5kbGVTdGRlcnIoY2h1bmspKTtcblxuICAgICAgICAvLyDljp/nlJ/lt6XlhbfosIPnlKjvvJpEU0gg5o+S5Lu2IOKGkiDmnKzov5vnqIvvvJvku6Xlj4rmjqfliLbluKflm57miafvvIjpnaLmnb8g4oaSIOaPkuS7tu+8iVxuICAgICAgICBjaGlsZC5vbignbWVzc2FnZScsIChmcmFtZTogdW5rbm93bikgPT4ge1xuICAgICAgICAgICAgY29uc3QgdHlwZWQgPSBmcmFtZSBhcyB7IF9fdGFnPzogc3RyaW5nOyBraW5kPzogc3RyaW5nOyBpZD86IHVua25vd24gfSB8IG51bGw7XG4gICAgICAgICAgICBpZiAodHlwZWQgJiYgdHlwZWQuX190YWcgPT09IElQQ19UQUcgJiYgdHlwZWQua2luZCA9PT0gJ2N0bC1yZXMnKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oYW5kbGVDb250cm9sUmVwbHkodHlwZWQpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZvaWQgdGhpcy5oYW5kbGVJcGNGcmFtZShmcmFtZSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNoaWxkLm9uKCdlcnJvcicsIChlcnJvcikgPT4ge1xuICAgICAgICAgICAgdGhpcy5mYWlsKGDlrZDov5vnqIvplJnor6/vvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY2hpbGQub24oJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB3YXNTdG9wcGluZyA9IHRoaXMuc3RhdHVzID09PSAnc3RvcHBpbmcnO1xuICAgICAgICAgICAgdGhpcy5jbGVhbnVwKCk7XG4gICAgICAgICAgICBpZiAod2FzU3RvcHBpbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNldFN0YXR1cygnc3RvcHBlZCcpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuZmFpbChgYWdlbnQg6L+b56iL6YCA5Ye65LqG77yIY29kZT0ke2NvZGUgPz8gJ251bGwnfSR7c2lnbmFsID8gYCwgc2lnbmFsPSR7c2lnbmFsfWAgOiAnJ33vvIlgKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqIOaUtuWwvu+8muaRmOebkeWQrOOAgea4heW8leeUqO+8iOS4jSBraWxs77yJ44CCICovXG4gICAgcHJpdmF0ZSBjbGVhbnVwKCk6IHZvaWQge1xuICAgICAgICBpZiAodGhpcy5jbGllbnQpIHtcbiAgICAgICAgICAgIHRoaXMuY2xpZW50LmRpc3Bvc2UoKTtcbiAgICAgICAgICAgIHRoaXMuY2xpZW50ID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICAvLyDlrZDov5vnqIvmsqHkuobvvIzmjqfliLbluKfnmoTlnKjpo57or7fmsYLmsLjov5zkuI3kvJrlm57mnaUg4oCU4oCUIOeri+WIu+iuqeWug+S7rOWksei0pe+8jOWIq+iuqemdouadv+i9rOWciFxuICAgICAgICBmb3IgKGNvbnN0IFssIGVudHJ5XSBvZiB0aGlzLmN0bFBlbmRpbmcpIHtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dChlbnRyeS50aW1lcik7XG4gICAgICAgICAgICBlbnRyeS5yZWplY3QobmV3IEVycm9yKCdhZ2VudCDlrZDov5vnqIvlt7LpgIDlh7rvvIzmjqfliLbluKfmsqHmnInlm57miacnKSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5jdGxQZW5kaW5nLmNsZWFyKCk7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkLnJlbW92ZUFsbExpc3RlbmVycygnbWVzc2FnZScpO1xuICAgICAgICAgICAgdGhpcy5jaGlsZC5yZW1vdmVBbGxMaXN0ZW5lcnMoJ2V4aXQnKTtcbiAgICAgICAgICAgIHRoaXMuY2hpbGQucmVtb3ZlQWxsTGlzdGVuZXJzKCdlcnJvcicpO1xuICAgICAgICAgICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7XG4gICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMucmVhc29uaW5nU3RyZWFtID0gbnVsbDtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqIOadgOaOieWtkOi/m+eoi++8iOS4jeeisCBjbGllbnQv55uR5ZCs77yJ44CCICovXG4gICAgcHJpdmF0ZSBraWxsQ2hpbGQoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICAgICAgaWYgKCFjaGlsZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlID09PSBudWxsKSBjaGlsZC5raWxsKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5bey57uP5rKh5LqGICovXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBwcml2YXRlIGhhbmRsZVN0ZGVycihjaHVuazogc3RyaW5nKTogdm9pZCB7XG4gICAgICAgIHRoaXMuc3RkZXJyQnVmZmVyICs9IGNodW5rO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgICBjb25zdCBuZXdsaW5lID0gdGhpcy5zdGRlcnJCdWZmZXIuaW5kZXhPZignXFxuJyk7XG4gICAgICAgICAgICBpZiAobmV3bGluZSA8IDApIGJyZWFrO1xuICAgICAgICAgICAgY29uc3QgbGluZSA9IHRoaXMuc3RkZXJyQnVmZmVyLnNsaWNlKDAsIG5ld2xpbmUpLnRyaW0oKTtcbiAgICAgICAgICAgIHRoaXMuc3RkZXJyQnVmZmVyID0gdGhpcy5zdGRlcnJCdWZmZXIuc2xpY2UobmV3bGluZSArIDEpO1xuICAgICAgICAgICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICAgICAgICAgIHRoaXMuc3RkZXJyVGFpbC5wdXNoKGxpbmUpO1xuICAgICAgICAgICAgd2hpbGUgKHRoaXMuc3RkZXJyVGFpbC5sZW5ndGggPiBNQVhfU1RERVJSX0xJTkVTKSB0aGlzLnN0ZGVyclRhaWwuc2hpZnQoKTtcbiAgICAgICAgICAgIGlmIChnZXRTZXR0aW5ncygpLnNob3dTdGRlcnJOb3RlcykgdGhpcy5hcHBlbmQoJ25vdGUnLCBgc3RkZXJyOiAke2xpbmV9YCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBJUEPvvIjlt6XlhbfvvIlcblxuICAgIC8qKlxuICAgICAqIOaOp+WItuW4p+eahOWbnuaJp++8iOaPkuS7tiDihpIg5pys6L+b56iL77yJ44CCXG4gICAgICpcbiAgICAgKiDkuI7lt6XlhbfluKflhbHnlKjpgJrpgZPjgIHmjIkgYGtpbmRgIOWIhua1ge+8muW3peWFt+W4p+acjeWKoSoq5qih5Z6LKirvvIhgcmVxYC9gcmVzYO+8ie+8jFxuICAgICAqIOaOp+WItuW4p+acjeWKoSoq6Z2i5p2/KirvvIhgY3RsYC9gY3RsLXJlc2DvvInjgIJcbiAgICAgKi9cbiAgICBwcml2YXRlIGhhbmRsZUNvbnRyb2xSZXBseShmcmFtZTogeyBpZD86IHVua25vd247IG9rPzogdW5rbm93bjsgcmVzdWx0PzogdW5rbm93bjsgZXJyb3I/OiB1bmtub3duIH0pOiB2b2lkIHtcbiAgICAgICAgY29uc3QgaWQgPSBOdW1iZXIoZnJhbWUuaWQpO1xuICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuY3RsUGVuZGluZy5nZXQoaWQpO1xuICAgICAgICBpZiAoIWVudHJ5KSByZXR1cm47XG4gICAgICAgIHRoaXMuY3RsUGVuZGluZy5kZWxldGUoaWQpO1xuICAgICAgICBjbGVhclRpbWVvdXQoZW50cnkudGltZXIpO1xuICAgICAgICBpZiAoZnJhbWUub2sgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICBlbnRyeS5yZWplY3QobmV3IEVycm9yKFN0cmluZyhmcmFtZS5lcnJvciA/PyAn5o+S5Lu26L+U5Zue5aSx6LSlJykpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBlbnRyeS5yZXNvbHZlKChmcmFtZS5yZXN1bHQgJiYgdHlwZW9mIGZyYW1lLnJlc3VsdCA9PT0gJ29iamVjdCcgPyBmcmFtZS5yZXN1bHQgOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgIH1cblxuICAgIHByaXZhdGUgYXN5bmMgaGFuZGxlSXBjRnJhbWUoZnJhbWU6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgaWYgKCFmcmFtZSB8fCB0eXBlb2YgZnJhbWUgIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSBmcmFtZSBhcyB7IF9fdGFnPzogc3RyaW5nOyBraW5kPzogc3RyaW5nOyBpZD86IHVua25vd247IG1ldGhvZD86IHN0cmluZzsgcGFyYW1zPzogdW5rbm93biB9O1xuICAgICAgICBpZiAocmVxdWVzdC5fX3RhZyAhPT0gSVBDX1RBRyB8fCByZXF1ZXN0LmtpbmQgIT09ICdyZXEnIHx8IHJlcXVlc3QuaWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhyZXF1ZXN0Lm1ldGhvZCA/PyAnJyk7XG4gICAgICAgIGNvbnN0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zICYmIHR5cGVvZiByZXF1ZXN0LnBhcmFtcyA9PT0gJ29iamVjdCcgPyAocmVxdWVzdC5wYXJhbXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDoge307XG4gICAgICAgIGNvbnN0IGhhbmRsZXIgPSBDT0NPU19JUENfTUVUSE9EU1ttZXRob2RdO1xuXG4gICAgICAgIGxldCByZXBseTogeyBvazogYm9vbGVhbjsgdGV4dDogc3RyaW5nOyBlcnJvcj86IHN0cmluZzsgZGF0YT86IHVua25vd24gfTtcbiAgICAgICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgICAgICByZXBseSA9IHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgdGV4dDogYGRzaF9jaGF077ya5pyq55+l55qE57yW6L6R5Zmo5pa55rOVIFwiJHttZXRob2R9XCLvvIjmianlsZXniYjmnKzkuI4gcHJvZmlsZSDniYjmnKzlj6/og73kuI3ljLnphY3vvIzor7fph43mlrDmiZPlvIDpnaLmnb/miJbph43ovb3mianlsZXvvInjgIJgLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVwbHkgPSBhd2FpdCBoYW5kbGVyKHBhcmFtcyk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHJlcGx5ID0geyBvazogZmFsc2UsIHRleHQ6IGDnvJbovpHlmajkvqflpITnkIYgXCIke21ldGhvZH1cIiDml7bmipvplJnvvJoke2Rlc2NyaWJlKGVycm9yKX1gIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8g5aSx6LSl5pe2Kirlv4XpobsqKuaKiuWOn+WboOaUvui/myBgZXJyb3Jg77yaRFNIIOS+p+aPkuS7tuWPquivu+W4p+S4iueahCBgZXJyb3Jg77yI6K+75LiN5Yiw5bCx5Zue6JC95oiQXG4gICAgICAgICAgICAvLyDkuIDlj6XmsqHmnInkv6Hmga/ph4/nmoTjgIznvJbovpHlmajov5Tlm57lpLHotKXjgI3vvInjgILov5nph4zlsJHkuoblroPvvIxgcmVzdWx0LnRleHRgIOmHjOmCo+WPpeecn+WOn+WboFxuICAgICAgICAgICAgLy8g5bCx5rC46L+c5Yiw5LiN5LqG5qih5Z6L55y85YmNIOKAlOKAlCDlrp7mtYvkuLrmraTnm7Lor5XkuobljYHlh6Dova7jgIJcbiAgICAgICAgICAgIHRoaXMuY2hpbGQ/LnNlbmQoe1xuICAgICAgICAgICAgICAgIF9fdGFnOiBJUENfVEFHLFxuICAgICAgICAgICAgICAgIGtpbmQ6ICdyZXMnLFxuICAgICAgICAgICAgICAgIGlkOiByZXF1ZXN0LmlkLFxuICAgICAgICAgICAgICAgIG9rOiByZXBseS5vayxcbiAgICAgICAgICAgICAgICAuLi4ocmVwbHkub2sgPyB7fSA6IHsgZXJyb3I6IHJlcGx5LmVycm9yID8/IHJlcGx5LnRleHQgPz8gJ+e8lui+keWZqOS+p+aJp+ihjOWksei0pe+8iOayoeaciee7meWHuuWOn+WboO+8iScgfSksXG4gICAgICAgICAgICAgICAgcmVzdWx0OiByZXBseSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbZHNoX2NoYXRdIOWbnuaJpyBJUEMg5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOmAmuefpeWkhOeQhlxuXG4gICAgcHJpdmF0ZSBoYW5kbGVOb3RpZmljYXRpb24obWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICAgICAgc3dpdGNoIChtZXRob2QpIHtcbiAgICAgICAgICAgIGNhc2UgJ3Nlc3Npb24uZXZlbnQnOiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZXZlbnQgPSBwYXJhbXMuZXZlbnQ7XG4gICAgICAgICAgICAgICAgaWYgKGV2ZW50ICYmIHR5cGVvZiBldmVudCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5oYW5kbGVTZXNzaW9uRXZlbnQoZXZlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGZhbHNlLCBTdHJpbmcocGFyYW1zLnNlc3Npb25JZCA/PyAnJykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ3Nlc3Npb24uc3RhdHVzJzoge1xuICAgICAgICAgICAgICAgIHRoaXMucnVubmluZyA9IHBhcmFtcy5zdGF0dXMgPT09ICdydW5uaW5nJztcbiAgICAgICAgICAgICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5maW5pc2hTdHJlYW1zKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdzdWJhZ2VudC5zdGFydGVkJzoge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOWtkCBhZ2VudCDlkK/liqjvvJoke1N0cmluZyhwYXJhbXMuYWdlbnRJZCA/PyAnJyl9YCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdzdWJhZ2VudC5maW5pc2hlZCc6IHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGDlrZAgYWdlbnQg57uT5p2f77yaJHtTdHJpbmcocGFyYW1zLmFnZW50SWQgPz8gJycpfe+8iCR7U3RyaW5nKHBhcmFtcy5zdGF0dXMgPz8gJycpfe+8iWApO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAvLyDljY/orq7lj6/og73mlrDlop7pgJrnn6XvvJvkuI3orqTor4bnmoTlv73nlaXvvIzkuI3opoHlm6DkuLrmnKrnn6Xmlrnms5XmiqXplJnjgIJcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOWkhOeQhuS4gOadoeS8muivneS6i+S7tuOAglxuICAgICAqXG4gICAgICog4pqgICoq5L+h5bCB57uT5p6E5piv6Lip6L+H55qE5Z2RKirvvJpgc2Vzc2lvbi5ldmVudGAg55qEIGBwYXJhbXMuZXZlbnRgIOaYr1xuICAgICAqIGBTZXNzaW9uRXZlbnQgPSB7IHR5cGUsIHNlcSwgdGltZSwgZGF0YTogU2Vzc2lvbkV2ZW50TWFwW3R5cGVdIH1gIOKAlOKAlFxuICAgICAqIOi9veiNt+S4gOW+i+WcqCAqKmBldmVudC5kYXRhYCoqIOmHjO+8jOS4jeWcqCBgZXZlbnRgIOS4iuOAguesrOS4gOeJiOebtOaOpeivuyBgZXZlbnQubmFtZWAgLyBgZXZlbnQubWVzc2FnZWDvvIxcbiAgICAgKiDnu5PmnpzmmK/lt6XlhbflkI3lj5jmiJAgYHVua25vd25g44CB5Yqp5omL5paH5pys5LiA5Liq5a2X6YO95LiK5LiN5LqG5bGP77yI6ICM5LqL5Lu25pys6Lqr5piv5aW955qE77yJ44CCXG4gICAgICog5p2D5aiB5a6a5LmJ6KeBIGBkc2gtc2Vzc2lvbmAg55qEIGBTZXNzaW9uRXZlbnRNYXBg44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gZXZlbnQgLSDkuovku7bkv6HlsIHvvIjlrp7ml7bpgJrnn6XkuI4qKuejgeebmOaXpeW/lyoq5ZCM5p6E77yM5omA5Lul6L+Z5LiA5Lu95oqV5b2x5Lik5aSE5YWx55So77yJ44CCXG4gICAgICogQHBhcmFtIHJlcGxheSAtIOaYr+S4jeaYr+WcqOWbnuaUvuWOhuWPsu+8muWbnuaUvuaXtuOAjOeUqOaIt+a2iOaBr+OAjeS5n+imgeS4iuWxj++8iOWunuaXtumCo+adoeaYryBgc2VuZCgpYCDoh6rlt7Hlm57mmL7nmoTvvInvvIxcbiAgICAgKiAgIOWKqeaJi+a2iOaBr+i/mOimgeaKiuaAneiAg+Wdl+S5n+eUu+WHuuadpe+8iOWunuaXtui1sOeahOaYryBgYXNzaXN0YW50L2NodW5rYCDmtYHlvI/ntK/orqHvvInjgIJcbiAgICAgKiBAcGFyYW0gc2Vzc2lvbklkIC0g5LqL5Lu25bGe5LqO5ZOq5Liq5Lya6K+d77yb55So5LqO5oqKKirliKvnmoTkvJror50qKu+8iOWtkCBhZ2VudOOAgeS4iuS4gOi9riBTREsg5Lya6K+d77yJ5oyh5Zyo5aSW6Z2i44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBoYW5kbGVTZXNzaW9uRXZlbnQoZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByZXBsYXkgPSBmYWxzZSwgc2Vzc2lvbklkID0gJycpOiB2b2lkIHtcbiAgICAgICAgLy8g5o6l5LiK5Y6G5Y+y5Lya6K+d5LmL5ZCO77yM6L+Q6KGM5pe26YeM5Y+v6IO95ZCM5pe25pyJ44CM6ICB55qEIFNESyDkvJror53jgI3lkozjgIzmjqXkuIrmnaXnmoTkvJror53jgI3kuKTkuKogaWTvvIxcbiAgICAgICAgLy8g5LiN5oyJIGlkIOi/h+a7pOeahOivneS4pOauteWvueivneS8muS4suWcqOS4gOi1t+OAguWtkCBhZ2VudCDnmoTkvJror53lkIzmoLfooqvmjKHmjonvvIjlroPlj6bmnIlcbiAgICAgICAgLy8gc3ViYWdlbnQuc3RhcnRlZC9maW5pc2hlZCDkuKTmnaEgbm90Ze+8ieOAglxuICAgICAgICBpZiAoIXJlcGxheSAmJiBzZXNzaW9uSWQgJiYgdGhpcy5zZXNzaW9uSWQgJiYgc2Vzc2lvbklkICE9PSB0aGlzLnNlc3Npb25JZCkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IGRhdGEgPSAoZXZlbnQuZGF0YSAmJiB0eXBlb2YgZXZlbnQuZGF0YSA9PT0gJ29iamVjdCcgPyBldmVudC5kYXRhIDoge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBzd2l0Y2ggKFN0cmluZyhldmVudC50eXBlID8/ICcnKSkge1xuICAgICAgICAgICAgY2FzZSAndXNlci9tZXNzYWdlJzoge1xuICAgICAgICAgICAgICAgIC8vIOiHquW3seWPkeeahOmCo+adoeW3sue7j+WcqCBzZW5kKCkg6YeM5Zue5pi+6L+H5LqG77yb6L+Z6YeM5Y+q5oqK44CM5rOo5YWl55qE5LiK5LiL5paH44CN6K6w5oiQ5LiA6KGMIG5vdGXvvIxcbiAgICAgICAgICAgICAgICAvLyDlkKbliJnovazlhpnph4zkvJrmt7fov5vkuIDlpKfloIYgQUdFTlRTLm1kIC8gc2tpbGwg5q2j5paH44CCXG4gICAgICAgICAgICAgICAgY29uc3Qgc291cmNlID0gZGF0YS5zb3VyY2UgYXMgeyBraW5kPzogc3RyaW5nOyBmb3JtPzogc3RyaW5nOyBzdW1tYXJ5Pzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZT8ua2luZCA9PT0gJ3BsdWdpbicgJiYgc291cmNlLmZvcm0gPT09ICdub3RpY2UnICYmIHNvdXJjZS5zdW1tYXJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOazqOWFpeS4iuS4i+aWh++8miR7c291cmNlLnN1bW1hcnl9YCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChyZXBsYXkgJiYgKCFzb3VyY2UgfHwgc291cmNlLmtpbmQgPT09ICd1c2VyJykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8g5Zue5pS+5pe255So5oi35raI5oGv5b+F6aG755S75Ye65p2l77yI5a6e5pe26YKj5p2h55SxIHNlbmQoKSDotJ/otKPvvJvljoblj7Lph4zmsqHmnIkgc2VuZCgp77yJXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGJsb2NrcyA9IGRhdGEuY29udGVudCA/PyAoZGF0YS5tZXNzYWdlIGFzIHsgY29udGVudD86IHVua25vd24gfSB8IHVuZGVmaW5lZCk/LmNvbnRlbnQ7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRleHQgPSB0ZXh0T2ZCbG9ja3MoYmxvY2tzKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VzID0gaW1hZ2VzT2ZCbG9ja3MoYmxvY2tzKTtcbiAgICAgICAgICAgICAgICAgICAgLy8g57qv5Zu+54mH5raI5oGv77yI5rKh5pyJ5paH5a2X77yJ5Zyo5pel5b+X6YeM5piv5LiA5aCGIGltYWdlIOWdlyDigJTigJQg5Lmf6KaB5LiK5bGP77yM5Y+q55S756KO54mHXG4gICAgICAgICAgICAgICAgICAgIGlmICh0ZXh0IHx8IGltYWdlcy5sZW5ndGggPiAwKSB0aGlzLmFwcGVuZCgndXNlcicsIHRleHQsIHVuZGVmaW5lZCwgaW1hZ2VzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdhc3Npc3RhbnQvY2h1bmsnOiB7XG4gICAgICAgICAgICAgICAgY29uc3QgY2h1bmsgPSBkYXRhLmNodW5rIGFzIHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGlmICghY2h1bmspIGJyZWFrO1xuICAgICAgICAgICAgICAgIGlmIChjaHVuay50eXBlID09PSAndGV4dC1kZWx0YScgJiYgdHlwZW9mIGNodW5rLnRleHQgPT09ICdzdHJpbmcnKSB0aGlzLnB1c2hTdHJlYW0oJ2FnZW50JywgY2h1bmsudGV4dCk7XG4gICAgICAgICAgICAgICAgZWxzZSBpZiAoY2h1bmsudHlwZSA9PT0gJ3JlYXNvbmluZy1kZWx0YScgJiYgdHlwZW9mIGNodW5rLnRleHQgPT09ICdzdHJpbmcnKSB0aGlzLnB1c2hTdHJlYW0oJ3RoaW5raW5nJywgY2h1bmsudGV4dCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdhc3Npc3RhbnQvbWVzc2FnZSc6IHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGF0YS5tZXNzYWdlIGFzIHsgY29udGVudD86IHVua25vd24gfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gdGV4dE9mQmxvY2tzKG1lc3NhZ2U/LmNvbnRlbnQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGludGVycnVwdGVkID0gZGF0YS5pbnRlcnJ1cHRlZCA9PT0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAocmVwbGF5KSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIOWbnuaUvu+8muaAneiAg+Wdl+S5n+WcqCBjb250ZW50IOmHjO+8iOWunuaXtuaYryBjaHVuayDmtYHvvInvvIzmjInlnZfpobrluo/ov5jljp9cbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBibG9jayBvZiBBcnJheS5pc0FycmF5KG1lc3NhZ2U/LmNvbnRlbnQpID8gbWVzc2FnZT8uY29udGVudCA6IFtdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0eXBlZCA9IGJsb2NrIGFzIHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVkPy50eXBlID09PSAncmVhc29uaW5nJyAmJiB0eXBlb2YgdHlwZWQudGV4dCA9PT0gJ3N0cmluZycgJiYgdHlwZWQudGV4dC50cmltKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgndGhpbmtpbmcnLCB0eXBlZC50ZXh0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAodGV4dCkgdGhpcy5hcHBlbmQoJ2FnZW50JywgdGV4dCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnRleHRTdHJlYW0pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8g55So44CM5ou86KOF5aW955qE5a6M5pW05raI5oGv44CN55uW5o6J5rWB5byP57Sv56ev77yI5ZCM5LiAIHNlcSDihpIg6Z2i5p2/5Y6f5Zyw5pu/5o2i77yM5LiN5Lya5Ye6546w5Lik6YGN77yJXG4gICAgICAgICAgICAgICAgICAgIGlmICh0ZXh0KSB0aGlzLnRleHRTdHJlYW0udGV4dCA9IHRleHQ7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMudG91Y2godGhpcy50ZXh0U3RyZWFtKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy50ZXh0U3RyZWFtID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHRleHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2FnZW50JywgdGV4dCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuZmluaXNoUmVhc29uaW5nU3RyZWFtKCk7XG4gICAgICAgICAgICAgICAgaWYgKGludGVycnVwdGVkKSB0aGlzLmFwcGVuZCgnbm90ZScsICfmnKzova7ooqvkuK3mlq3vvIjku6XkuIrmmK/lt7Lkuqflh7rnmoTlhoXlrrnvvIknKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ3Rvb2wvY2FsbCc6IHtcbiAgICAgICAgICAgICAgICB0aGlzLmZpbmlzaFN0cmVhbXMoKTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYWxsSWQgPSBTdHJpbmcoZGF0YS5jYWxsSWQgPz8gJycpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5hcHBlbmQoJ3Rvb2wnLCB1bmRlZmluZWQsIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogU3RyaW5nKGRhdGEubmFtZSA/PyAndW5rbm93bicpLFxuICAgICAgICAgICAgICAgICAgICBjYWxsSWQsXG4gICAgICAgICAgICAgICAgICAgIGFyZ3M6IHR5cGVvZiBkYXRhLmFyZ3VtZW50cyA9PT0gJ3N0cmluZycgPyBkYXRhLmFyZ3VtZW50cyA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgZG9uZTogZmFsc2UsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgaWYgKGNhbGxJZCkgdGhpcy50b29sQnlDYWxsSWQuc2V0KGNhbGxJZCwgZW50cnkpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAndG9vbC9yZXN1bHQnOiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRhdGEubWVzc2FnZSBhc1xuICAgICAgICAgICAgICAgICAgICB8IHsgc291cmNlPzogeyBjYWxsSWQ/OiBzdHJpbmcgfTsgY29udGVudD86IEFycmF5PHsgY29udGVudD86IHVua25vd247IGlzRXJyb3I/OiBib29sZWFuOyB0b29sQ2FsbElkPzogc3RyaW5nIH0+IH1cbiAgICAgICAgICAgICAgICAgICAgfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FsbElkID0gU3RyaW5nKG1lc3NhZ2U/LnNvdXJjZT8uY2FsbElkID8/IG1lc3NhZ2U/LmNvbnRlbnQ/LlswXT8udG9vbENhbGxJZCA/PyAnJyk7XG4gICAgICAgICAgICAgICAgY29uc3QgZW50cnkgPSBjYWxsSWQgPyB0aGlzLnRvb2xCeUNhbGxJZC5nZXQoY2FsbElkKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICAvLyDimqAg5paH5pys5LiOIGlzRXJyb3Ig55qE5Y+W5rOV6KeBIGB0b29sUmVzdWx0T2Zg77yI5paw6ICB5pel5b+X5b2i54q25LiN5ZCM77yM5Y+q6K6k5LiA56eN5Lya6Z2Z6buY5Lii57uT5p6c77yJXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gdG9vbFJlc3VsdE9mKG1lc3NhZ2UpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG91dHB1dCA9IHJlc3VsdC50ZXh0O1xuICAgICAgICAgICAgICAgIGNvbnN0IGlzRXJyb3IgPSByZXN1bHQuaXNFcnJvciB8fCBkYXRhLmVycm9yICE9PSB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2hvd24gPVxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQubGVuZ3RoID4gVE9PTF9PVVRQVVRfRElTUExBWV9MSU1JVFxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgJHtvdXRwdXQuc2xpY2UoMCwgVE9PTF9PVVRQVVRfRElTUExBWV9MSU1JVCl9XFxu4oCm77yI5bey5oiq5pat77yM5a6M5pW057uT5p6c5bey5Lqk57uZ5qih5Z6L77yJYFxuICAgICAgICAgICAgICAgICAgICAgICAgOiBvdXRwdXQ7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGBlbmRlZEF0YCDlj6rnu5npnaLmnb/nrpfogJfml7bnlKjvvIhgZW50cnkuYXRgIOaYr+WPkei1t+aXtuWIu++8iVxuICAgICAgICAgICAgICAgICAgICBlbnRyeS50b29sID0geyAuLi4oZW50cnkudG9vbCBhcyBUb29sRW50cnkpLCBkb25lOiB0cnVlLCBvazogIWlzRXJyb3IsIG91dHB1dDogc2hvd24sIGVuZGVkQXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy50b3VjaChlbnRyeSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWxsSWQpIHRoaXMudG9vbEJ5Q2FsbElkLmRlbGV0ZShjYWxsSWQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCd0b29sJywgdW5kZWZpbmVkLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnKOacquefpeW3peWFtyknLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9rOiAhaXNFcnJvcixcbiAgICAgICAgICAgICAgICAgICAgICAgIG91dHB1dDogc2hvd24sXG4gICAgICAgICAgICAgICAgICAgICAgICBlbmRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICd0dXJuL2VuZCc6IHtcbiAgICAgICAgICAgICAgICB0aGlzLmZpbmlzaFN0cmVhbXMoKTtcbiAgICAgICAgICAgICAgICAvLyDimqAgYHJlYXNvbmAg5pivKirlr7nosaEqKuS4jeaYr+Wtl+espuS4su+8mmBUdXJuRW5kUmVhc29uID0geyBraW5kOiAnY29tcGxldGVkJyB8ICdhYm9ydGVkJ1xuICAgICAgICAgICAgICAgIC8vIHwgJ2Jsb2NrZWQnIHwgJ2Vycm9yJyB8ICdtYXgtdG9rZW5zJyB8ICdpbnRlcnJ1cHRlZCcsIC4uLiB9YOOAglxuICAgICAgICAgICAgICAgIC8vIOesrOS4gOeJiCBgU3RyaW5nKHJlYXNvbilgIOebtOaOpeaJk+WHuiBgW29iamVjdCBPYmplY3RdYOOAglxuICAgICAgICAgICAgICAgIGNvbnN0IHJhdyA9IGRhdGEucmVhc29uIGFzXG4gICAgICAgICAgICAgICAgICAgIHwgc3RyaW5nXG4gICAgICAgICAgICAgICAgICAgIHwgeyBraW5kPzogc3RyaW5nOyBlcnJvcj86IHsgbWVzc2FnZT86IHN0cmluZzsgY29kZT86IHN0cmluZyB9IH1cbiAgICAgICAgICAgICAgICAgICAgfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgY29uc3Qga2luZCA9IHR5cGVvZiByYXcgPT09ICdzdHJpbmcnID8gcmF3IDogU3RyaW5nKHJhdz8ua2luZCA/PyAnJyk7XG4gICAgICAgICAgICAgICAgaWYgKGtpbmQgJiYga2luZCAhPT0gJ2NvbXBsZXRlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZGV0YWlsID1cbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09ICdvYmplY3QnICYmIHJhdz8uZXJyb3I/Lm1lc3NhZ2UgPyBg77yaJHtyYXcuZXJyb3IubWVzc2FnZX1gIDogJyc7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOacrOi9rue7k+adn++8miR7a2luZH0ke2RldGFpbH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIC8vIGB0dXJuL3N0YXJ0YCAvIGBzdGVwL3N0YXJ0YCDnrYnnmbvorrDlnovkuovku7bkuI3pnIDopoHkuIrlsY/jgIJcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6L2s5YaZXG5cbiAgICBwcml2YXRlIGFwcGVuZChraW5kOiBFbnRyeUtpbmQsIHRleHQ/OiBzdHJpbmcsIHRvb2w/OiBUb29sRW50cnksIGltYWdlcz86IEVudHJ5SW1hZ2VbXSk6IEVudHJ5IHtcbiAgICAgICAgY29uc3QgZW50cnk6IEVudHJ5ID0geyBzZXE6ICsrdGhpcy5zZXEsIHJldjogKyt0aGlzLnJldmlzaW9uLCBraW5kLCBhdDogRGF0ZS5ub3coKSwgdGV4dCwgdG9vbCB9O1xuICAgICAgICBpZiAoaW1hZ2VzICYmIGltYWdlcy5sZW5ndGggPiAwKSBlbnRyeS5pbWFnZXMgPSBpbWFnZXM7XG4gICAgICAgIHRoaXMuZW50cmllcy5wdXNoKGVudHJ5KTtcbiAgICAgICAgd2hpbGUgKHRoaXMuZW50cmllcy5sZW5ndGggPiBNQVhfRU5UUklFUykgdGhpcy5lbnRyaWVzLnNoaWZ0KCk7XG4gICAgICAgIHRoaXMuZGlydHkuYWRkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICBwcml2YXRlIHRvdWNoKGVudHJ5OiBFbnRyeSk6IHZvaWQge1xuICAgICAgICBlbnRyeS5yZXYgPSArK3RoaXMucmV2aXNpb247XG4gICAgICAgIHRoaXMuZGlydHkuYWRkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqIOa1geW8j+i/veWKoO+8muesrOS4gOadoSBkZWx0YSDlu7rmnaHnm67vvIzlkI7nu63ljp/lnLDlop7plb/vvIjlkIzkuIAgc2Vx77yM6Z2i5p2/5Y6f5Zyw5pu/5o2i77yJ44CCICovXG4gICAgcHJpdmF0ZSBwdXNoU3RyZWFtKGtpbmQ6ICdhZ2VudCcgfCAndGhpbmtpbmcnLCBkZWx0YTogc3RyaW5nKTogdm9pZCB7XG4gICAgICAgIGxldCBlbnRyeSA9IGtpbmQgPT09ICdhZ2VudCcgPyB0aGlzLnRleHRTdHJlYW0gOiB0aGlzLnJlYXNvbmluZ1N0cmVhbTtcbiAgICAgICAgaWYgKCFlbnRyeSkge1xuICAgICAgICAgICAgLy8gYXBwZW5kKCkg6Ieq5bex5Lya5qCH6ISPICsg5o6S5Yi3XG4gICAgICAgICAgICBlbnRyeSA9IHRoaXMuYXBwZW5kKGtpbmQsIGRlbHRhKTtcbiAgICAgICAgICAgIGlmIChraW5kID09PSAnYWdlbnQnKSB0aGlzLnRleHRTdHJlYW0gPSBlbnRyeTtcbiAgICAgICAgICAgIGVsc2UgdGhpcy5yZWFzb25pbmdTdHJlYW0gPSBlbnRyeTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBlbnRyeS50ZXh0ID0gYCR7ZW50cnkudGV4dCA/PyAnJ30ke2RlbHRhfWA7XG4gICAgICAgIHRoaXMudG91Y2goZW50cnkpO1xuICAgIH1cblxuICAgIC8qKiDnu5PmnZ/mtYHlvI/vvIjmlLblsL7miJDpnZnmgIHmnaHnm67vvInjgIIgKi9cbiAgICBwcml2YXRlIGZpbmlzaFN0cmVhbXMoKTogdm9pZCB7XG4gICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMuZmluaXNoUmVhc29uaW5nU3RyZWFtKCk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmaW5pc2hSZWFzb25pbmdTdHJlYW0oKTogdm9pZCB7XG4gICAgICAgIGlmICghdGhpcy5yZWFzb25pbmdTdHJlYW0pIHJldHVybjtcbiAgICAgICAgaWYgKCF0aGlzLnJlYXNvbmluZ1N0cmVhbS50ZXh0KSB7XG4gICAgICAgICAgICAvLyDnqbrnmoTmgJ3ogIPmnaHnm67msqHmnInmhI/kuYnvvIzku47ovazlhpnph4zmkZjmjolcbiAgICAgICAgICAgIGNvbnN0IGluZGV4ID0gdGhpcy5lbnRyaWVzLmluZGV4T2YodGhpcy5yZWFzb25pbmdTdHJlYW0pO1xuICAgICAgICAgICAgaWYgKGluZGV4ID49IDApIHRoaXMuZW50cmllcy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICAgICAgdGhpcy5kaXJ0eS5kZWxldGUodGhpcy5yZWFzb25pbmdTdHJlYW0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVhc29uaW5nU3RyZWFtID0gbnVsbDtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOW5v+aSrVxuXG4gICAgcHJpdmF0ZSBzZXRTdGF0dXMoc3RhdHVzOiBBZ2VudFN0YXR1cyk6IHZvaWQge1xuICAgICAgICB0aGlzLnN0YXR1cyA9IHN0YXR1cztcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nIH0ge1xuICAgICAgICB0aGlzLmxhc3RFcnJvciA9IG1lc3NhZ2U7XG4gICAgICAgIHRoaXMuc3RhdHVzID0gJ2Vycm9yJztcbiAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgbWVzc2FnZSk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICB9XG5cbiAgICBwcml2YXRlIHNjaGVkdWxlRmx1c2goKTogdm9pZCB7XG4gICAgICAgIGlmICh0aGlzLmZsdXNoVGltZXIpIHJldHVybjtcbiAgICAgICAgdGhpcy5mbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5mbHVzaCgpO1xuICAgICAgICB9LCBGTFVTSF9JTlRFUlZBTF9NUyk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmbHVzaCgpOiB2b2lkIHtcbiAgICAgICAgaWYgKHRoaXMuZGlydHkuc2l6ZSA9PT0gMCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBiYXRjaCA9IFsuLi50aGlzLmRpcnR5XS5zbGljZSgwLCBGTFVTSF9CQVRDSF9MSU1JVCk7XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgYmF0Y2gpIHRoaXMuZGlydHkuZGVsZXRlKGVudHJ5KTtcbiAgICAgICAgaWYgKHRoaXMuZGlydHkuc2l6ZSA+IDApIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgICAgICBjb25zdCB1cGRhdGU6IEhvc3RVcGRhdGVWaWV3ID0ge1xuICAgICAgICAgICAgZW50cmllczogYmF0Y2gsXG4gICAgICAgICAgICByZXZpc2lvbjogdGhpcy5yZXZpc2lvbixcbiAgICAgICAgICAgIGdlbmVyYXRpb246IHRoaXMuZ2VuZXJhdGlvbixcbiAgICAgICAgICAgIHN0YXR1czogdGhpcy5zdGF0dXMsXG4gICAgICAgICAgICBydW5uaW5nOiB0aGlzLnJ1bm5pbmcsXG4gICAgICAgIH07XG4gICAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgdGhpcy5saXN0ZW5lcnMpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXIodXBkYXRlKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGBbZHNoX2NoYXRdIOabtOaWsOWbnuiwg+aKm+mUme+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5icm9hZGNhc3QoQlJPQURDQVNUX0NIQU5ORUwsIHVwZGF0ZSBhcyB1bmtub3duIGFzIG9iamVjdCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLy8g5bm/5pKt5piv5L+d6Zmp5Lid6ICM6Z2e5Li76Lev77ya6Z2i5p2/6L+Y5pyJ6L2u6K+i5YWc5bqV77yM6L+Z6YeM5aSx6LSl5LiN566X6ZSZ44CCXG4gICAgICAgIH1cbiAgICB9XG59XG4iXX0=