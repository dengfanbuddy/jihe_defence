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

import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';

import { COCOS_IPC_METHODS } from './cocos-tools';
import {
    BROADCAST_CHANNEL,
    IPC_TAG,
    PROFILE_NAME,
    type AgentSnapshot,
    type AgentStatus,
    type Entry,
    type EntryImage,
    type EntryKind,
    type EventsPayload,
    type HistorySessionView,
    type HistoryView,
    type HostUpdateView,
    type SessionKind,
    type ToolEntry,
} from './constants';
import { listHistory, readHistory, titleOfEvents, type HistorySession } from './history';
import { type ValidImage } from './images';
import { resolveRuntime, type ResolvedRuntime } from './paths';
import { SdkClient } from './sdk-client';
import { getSettings } from './settings';

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
function bundledSkillDir(): string {
    return join(__dirname, '..', 'skills');
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

/** 面板/其它监听者收到的推送（类型定义在 constants，面板共用同一份）。 */
export type { HostUpdateView as HostUpdate } from './constants';
/** 从 ContentBlock[] 里取纯文本。 */
function textOfBlocks(blocks: unknown): string {
    if (!Array.isArray(blocks)) return '';
    const parts: string[] = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const text = (block as { text?: string }).text;
            if (typeof text === 'string' && text) parts.push(text);
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
function imagesOfBlocks(blocks: unknown): EntryImage[] {
    if (!Array.isArray(blocks)) return [];
    const out: EntryImage[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as {
            type?: string;
            mimeType?: string;
            attachment?: { mediaType?: string; bytes?: number; width?: number; height?: number; name?: string };
        };
        if (typed.type !== 'image') continue;
        const ref = typed.attachment;
        out.push({
            name: ref?.name,
            mimeType: ref?.mediaType ?? typed.mimeType,
            bytes: typeof ref?.bytes === 'number' ? ref.bytes : undefined,
            width: typeof ref?.width === 'number' ? ref.width : undefined,
            height: typeof ref?.height === 'number' ? ref.height : undefined,
        });
    }
    return out;
}

/** 一张待发送的图 → SDK 的内容块（`data` 必须是规范 base64，见 `source/images.ts`）。 */
function imageBlockOf(image: ValidImage): Record<string, unknown> {
    const block: Record<string, unknown> = { type: 'image', data: image.data, mimeType: image.mimeType };
    if (image.name) block.name = image.name;
    return block;
}

/** 把异常/未知收敛成一句话。 */
function describe(error: unknown): string {
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
function toolResultOf(message: unknown): { text: string; isError: boolean } {
    const typed = (message ?? {}) as { content?: unknown; isError?: unknown };
    const content = typed.content;
    if (!Array.isArray(content)) return { text: '', isError: typed.isError === true };

    const wrapper = content[0] as { type?: string; content?: unknown; isError?: unknown } | undefined;
    const blocks = wrapper?.type === 'tool-result' && Array.isArray(wrapper.content) ? wrapper.content : content;
    return {
        text: textOfBlocks(blocks),
        isError: wrapper?.isError === true || typed.isError === true,
    };
}

/** DSH 子进程的宿主。整个扩展只有这一个实例（`main.ts` 里持有）。 */
export class DshHost {
    private child: ChildProcess | null = null;
    private client: SdkClient | null = null;
    private status: AgentStatus = 'stopped';
    private running = false;
    private sessionId: string | null = null;
    private lastBootMs: number | null = null;
    private lastError: string | null = null;
    private runtime: ResolvedRuntime = { nodeExe: null, nodeSource: '未探测', dshBin: null, dshSource: '未探测' };

    /**
     * 当前 sessionId 的来历。
     *
     * - `sdk`：SDK 协议 `session/prompt` 懒创建出来的会话（老路子）；
     * - `resumed`：插件用 `agents.resume` **真正接上**的历史会话 —— 发消息走控制帧；
     * - `history`：只是把历史日志回放到面板上（只读，还没接上）。
     */
    private sessionKind: SessionKind = 'sdk';

    /** 非空 = 对话区正在显示一条历史会话。 */
    private historyView: HistoryView | null = null;

    private readonly entries: Entry[] = [];
    private seq = 0;
    private revision = 0;

    /** 转写代数：清空/换会话就 +1（面板据此丢弃旧条目）。 */
    private generation = 0;

    /** 控制帧（面板→插件）的请求号与在飞请求。 */
    private ctlSeq = 0;
    private readonly ctlPending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

    /** 流式中的条目（文本 / 思考各一条，回合内复用）。 */
    private textStream: Entry | null = null;
    private reasoningStream: Entry | null = null;

    /** callId → 工具条目，用于把 `tool/result` 配回 `tool/call`。 */
    private readonly toolByCallId = new Map<string, Entry>();

    /** 本帧内被改动过的条目（广播用）。 */
    private readonly dirty = new Set<Entry>();
    private flushTimer: NodeJS.Timeout | null = null;

    private stderrTail: string[] = [];
    private stderrBuffer = '';

    private readonly listeners = new Set<(update: HostUpdateView) => void>();

    // ---------------------------------------------------------------- 对外只读

    /** 注册更新回调（`main.ts` 用它发广播）。返回注销函数。 */
    onUpdate(listener: (update: HostUpdateView) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** 当前快照。 */
    snapshot(): AgentSnapshot {
        return {
            status: this.status,
            running: this.running,
            sessionId: this.sessionId,
            sessionKind: this.sessionKind,
            history: this.historyView ? { ...this.historyView } : null,
            generation: this.generation,
            pid: this.child?.pid ?? null,
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
    eventsSince(since: number): EventsPayload {
        const from = Number.isFinite(since) ? since : 0;
        return {
            entries: this.entries.filter((entry) => entry.rev > from),
            revision: this.revision,
            generation: this.generation,
        };
    }

    /** 探测一次运行时（面板要在没启动时也能显示「将用哪个 node/dsh」）。 */
    probeRuntime(): ResolvedRuntime {
        this.runtime = resolveRuntime(getSettings());
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
    async start(): Promise<{ ok: boolean; error?: string }> {
        if (this.status === 'ready' || this.status === 'starting') return { ok: true };

        const settings = getSettings();
        this.runtime = resolveRuntime(settings);
        if (!this.runtime.nodeExe) {
            return this.fail(
                '找不到可用的 node。请在 DSH 面板设置里填「node 路径」，或把 node 加到 PATH。' +
                    '（注意：编辑器自带的 Electron 不是 node，不能拿来跑 dsh。）',
            );
        }
        if (!this.runtime.dshBin) {
            return this.fail(
                '找不到 dsh CLI 入口。请在设置里填「dsh bin.js 路径」（通常形如 ' +
                    '`<npm 全局目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`）。',
            );
        }

        const cwd = settings.workdir || Editor.Project.path;
        this.setStatus('starting');
        this.lastError = null;
        this.stderrTail = [];
        this.stderrBuffer = '';
        const startedAt = Date.now();

        try {
            this.child = fork(this.runtime.dshBin, ['--profile', PROFILE_NAME], {
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
            } as import('child_process').ForkOptions);
        } catch (error) {
            return this.fail(`启动 dsh 子进程失败：${describe(error)}`);
        }

        this.attachChild(this.child);

        try {
            const params: Record<string, unknown> = {
                cwd,
                provider: settings.provider,
                model: settings.model,
            };
            if (settings.reasoningEffort) params.reasoningEffort = settings.reasoningEffort;
            if (settings.maxTokens > 0) params.maxTokens = settings.maxTokens;

            await this.client?.initialize(params as { cwd: string; provider: string; model: string });
        } catch (error) {
            const message = describe(error);
            // 起不来就别留半死的进程
            this.killChild();
            return this.fail(`初始化失败：${message}`);
        }

        this.lastBootMs = Date.now() - startedAt;
        this.setStatus('ready');
        this.append(
            'note',
            `agent 已就绪（${this.lastBootMs}ms） 模型 ${settings.provider}/${settings.model}；工作目录 ${cwd}`,
        );

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
    private async restoreLastSession(cwd: string): Promise<void> {
        try {
            const listed = await listHistory(this.runtime.nodeExe, cwd, 5);
            if (!listed.ok) throw new Error(listed.error ?? '列历史会话失败');
            const candidate = (listed.sessions ?? []).find((session) => session.turns > 0) ?? (listed.sessions ?? [])[0];
            if (!candidate) {
                this.sessionId = randomUUID();
                this.sessionKind = 'sdk';
                this.append('note', '还没聊过，已开新会话。');
                return;
            }

            const opened = await this.loadHistory(candidate.id, { quiet: true });
            if (!opened.ok) throw new Error(opened.error ?? '读历史会话失败');
            const resumed = await this.resumeHistory(candidate.id);
            if (!resumed.ok) throw new Error(resumed.error ?? '继续会话失败');
        } catch (error) {
            this.sessionId = randomUUID();
            this.sessionKind = 'sdk';
            this.historyView = null;
            this.append(
                'note',
                `没能接上上次的会话（${describe(error)}）—— 已开新会话 ${String(this.sessionId).slice(0, 8)}…。` +
                    '历史仍在右上角「历史」里。',
            );
        }
    }

    /**
     * 列历史会话（面板上的「历史」按钮）。
     *
     * @param limit - 最多几条。
     * @returns `{ok, sessions?, error?}`。
     */
    async historyList(limit = 20): Promise<{ ok: boolean; sessions?: HistorySessionView[]; error?: string }> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const listed = await listHistory(this.runtime.nodeExe, cwd, limit);
        if (!listed.ok) return { ok: false, error: listed.error };

        const current = this.historyView?.sessionId ?? null;
        const sessions = (listed.sessions ?? []).map((session: HistorySession) => ({
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
    async loadHistory(sessionId: string, options: { quiet?: boolean } = {}): Promise<{ ok: boolean; events?: number; error?: string }> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const read = await readHistory(this.runtime.nodeExe, cwd, sessionId);
        if (!read.ok) return { ok: false, error: read.error };

        const events = read.events ?? [];
        this.resetTranscript();
        this.historyView = {
            sessionId,
            title: titleOfEvents(events) || '(无标题)',
            createdAt: ((read.header ?? {}) as { createdAt?: number }).createdAt ?? null,
            messageCount: events.length,
            live: false,
        };
        this.sessionKind = 'history';
        for (const event of events) this.handleSessionEvent(event, true, sessionId);

        if (!options.quiet) {
            this.append(
                'note',
                `以上是历史会话 ${sessionId.slice(0, 8)}… 的 ${events.length} 条记录（只读回放，共 ${read.total ?? events.length} 条）。` +
                    '想接着聊就点上面的「继续此会话」。',
            );
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
    async resumeHistory(sessionId?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
        const target = sessionId ?? this.historyView?.sessionId;
        if (!target) return { ok: false, error: '没有可继续的会话（先从「历史」里打开一条）' };
        if (this.status !== 'ready' || !this.child) {
            return { ok: false, error: 'agent 没在跑 —— 先点「启动」再继续这条会话' };
        }

        const settings = getSettings();
        try {
            const result = await this.callChild(
                'session/resume',
                {
                    sessionId: target,
                    provider: settings.provider,
                    model: settings.model,
                    reasoningEffort: settings.reasoningEffort || undefined,
                    maxTokens: settings.maxTokens > 0 ? settings.maxTokens : undefined,
                },
                180_000,
            );
            this.sessionId = target;
            this.sessionKind = 'resumed';
            if (this.historyView) this.historyView = { ...this.historyView, sessionId: target, live: true };
            else {
                this.historyView = { sessionId: target, title: '(未回放)', createdAt: null, messageCount: 0, live: true };
            }
            this.append(
                'note',
                `已接上会话 ${target.slice(0, 8)}…（agent ${String(result.agentId ?? '?').slice(0, 8)}…）——` +
                    '接下来的消息会带着它的上下文。',
            );
            return { ok: true, sessionId: target };
        } catch (error) {
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
    private callChild(
        method: string,
        params: Record<string, unknown>,
        timeoutMs = 60_000,
    ): Promise<Record<string, unknown>> {
        const child = this.child;
        if (!child) return Promise.reject(new Error('agent 子进程不在'));

        const id = ++this.ctlSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ctlPending.delete(id);
                reject(
                    new Error(
                        `控制帧 ${method} 在 ${timeoutMs}ms 内没有回执（插件版本过旧？` +
                            '本扩展要求 dsh-cocos-bridge 支持控制通道，先跑一次 scripts/install-profile.js）',
                    ),
                );
            }, timeoutMs);
            this.ctlPending.set(id, { resolve, reject, timer });
            try {
                child.send({ __tag: IPC_TAG, kind: 'ctl', id, method, params });
            } catch (error) {
                clearTimeout(timer);
                this.ctlPending.delete(id);
                reject(new Error(`发送控制帧失败：${describe(error)}`));
            }
        });
    }

    /** 停止 agent。先走协议 `shutdown`（服务端会自己退出），兜底再 kill。 */
    async stop(): Promise<{ ok: boolean; error?: string }> {
        if (!this.child) {
            this.setStatus('stopped');
            return { ok: true };
        }
        this.setStatus('stopping');
        const child = this.child;
        const client = this.client;
        try {
            await client?.shutdown();
        } catch (error) {
            console.warn(`[dsh_chat] shutdown 请求没走完（继续 kill）：${describe(error)}`);
        }
        // 服务端通常会自己 exit；给它 1.5s，然后兜底。
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) {
                    try {
                        child.kill();
                    } catch {
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
    async interrupt(): Promise<{ ok: boolean; cancelled?: boolean; status?: string; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        try {
            /**
             * ⚠ **不拿 `this.running` 当闸门**：它来自 `session.status` 通知，可能在
             * 「面板刚重开」「通知还没到」时是陈旧的 `false`；而**谁在跑**这件事，
             * 运行时里的 `agent.status` 才是真源。所以一律问插件，由它回 `cancelled`。
             */
            const result = await this.callChild('session/cancel', { sessionId: this.sessionId }, 15_000);
            const cancelled = result.cancelled === true;
            const status = typeof result.status === 'string' ? result.status : undefined;
            this.append('note', cancelled ? '已请求中断这一轮（会话保留，可以接着说）' : '这一轮已经结束了');
            // 乐观收敛：中断请求已受理时，本地 running 立刻置位，别等下一次通知
            // （面板那个按钮的禁用态靠它，不然会有一小段「看起来没反应」）
            if (cancelled) this.running = false;
            return { ok: true, cancelled, status };
        } catch (error) {
            const message = describe(error);
            this.append('error', `中断失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /** 开一个新会话（新的 sessionId；旧会话在 DSH 侧仍按日志留在磁盘上）。 */
    newSession(): { ok: boolean; sessionId: string | null } {
        // 接上来的历史会话是**插件持有的 agent**：开新会话就要显式放掉它，
        // 否则它会一直挂在运行时里（下次 resume 同一个 id 会撞上）。
        if (this.sessionKind === 'resumed' && this.sessionId) {
            const previous = this.sessionId;
            void this.callChild('session/dispose', { sessionId: previous }).catch((error) => {
                console.warn(`[dsh_chat] 释放会话 ${previous.slice(0, 8)}… 失败：${describe(error)}`);
            });
        }
        this.sessionId = randomUUID();
        this.sessionKind = 'sdk';
        this.historyView = null;
        this.resetTranscript();
        this.append(
            'note',
            `已开新会话 ${this.sessionId.slice(0, 8)}…（上一段对话仍在右上角「历史」里，随时可以接着聊）`,
        );
        return { ok: true, sessionId: this.sessionId };
    }

    /**
     * 清空对话区（换会话/回放历史前调用）。
     *
     * **代数 +1** 是给面板的信号：面板只按 `rev` 拉增量，没法表达「某条被删掉了」，
     * 所以「清空」这件事必须有一个独立的、单调递增的记号（`generation`）。
     */
    private resetTranscript(): void {
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
    async send(text: string, images: ValidImage[] = []): Promise<{ ok: boolean; error?: string; messageId?: string }> {
        const content = typeof text === 'string' ? text.trim() : '';
        const attachments = images.filter((image) => image && typeof image.data === 'string' && image.data);
        if (!content && attachments.length === 0) return { ok: false, error: '消息是空的' };
        if (this.status !== 'ready' || !this.client) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) {
            this.sessionId = randomUUID();
            this.sessionKind = 'sdk';
        }

        // 内容块：文本在前、图片在后（附件库按顺序把 image 块换成附件引用，顺序即消息顺序）
        const blocks: Array<Record<string, unknown>> = [];
        if (content) blocks.push({ type: 'text', text: content });
        for (const image of attachments) blocks.push(imageBlockOf(image));

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
            } catch (error) {
                const message = describe(error);
                this.append('error', `发送失败（已接上的历史会话走控制帧）：${message}`);
                return { ok: false, error: message };
            }
        }

        try {
            const result = (await this.client.prompt(this.sessionId, blocks)) as { messageId?: string } | undefined;
            return { ok: true, messageId: result?.messageId };
        } catch (error) {
            const message = describe(error);
            this.append('error', `发送失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /** 扩展卸载时调用：断开一切、杀掉子进程。 */
    async dispose(): Promise<void> {
        this.listeners.clear();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.child) {
            try {
                this.client?.dispose();
            } catch {
                /* 忽略 */
            }
            this.killChild();
        }
        this.cleanup();
        this.status = 'stopped';
    }

    // ---------------------------------------------------------------- 子进程接线

    private attachChild(child: ChildProcess): void {
        this.client = new SdkClient(child, (method, params) => this.handleNotification(method, params));
        this.client.attach();

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => this.handleStderr(chunk));

        // 原生工具调用：DSH 插件 → 本进程；以及控制帧回执（面板 → 插件）
        child.on('message', (frame: unknown) => {
            const typed = frame as { __tag?: string; kind?: string; id?: unknown } | null;
            if (typed && typed.__tag === IPC_TAG && typed.kind === 'ctl-res') {
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
            this.fail(`agent 进程退出了（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`);
        });
    }

    /** 收尾：摘监听、清引用（不 kill）。 */
    private cleanup(): void {
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
    private killChild(): void {
        const child = this.child;
        if (!child) return;
        try {
            if (child.exitCode === null) child.kill();
        } catch {
            /* 已经没了 */
        }
    }

    private handleStderr(chunk: string): void {
        this.stderrBuffer += chunk;
        for (;;) {
            const newline = this.stderrBuffer.indexOf('\n');
            if (newline < 0) break;
            const line = this.stderrBuffer.slice(0, newline).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (!line) continue;
            this.stderrTail.push(line);
            while (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift();
            if (getSettings().showStderrNotes) this.append('note', `stderr: ${line}`);
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
    private handleControlReply(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): void {
        const id = Number(frame.id);
        const entry = this.ctlPending.get(id);
        if (!entry) return;
        this.ctlPending.delete(id);
        clearTimeout(entry.timer);
        if (frame.ok === false) {
            entry.reject(new Error(String(frame.error ?? '插件返回失败')));
            return;
        }
        entry.resolve((frame.result && typeof frame.result === 'object' ? frame.result : {}) as Record<string, unknown>);
    }

    private async handleIpcFrame(frame: unknown): Promise<void> {
        if (!frame || typeof frame !== 'object') return;
        const request = frame as { __tag?: string; kind?: string; id?: unknown; method?: string; params?: unknown };
        if (request.__tag !== IPC_TAG || request.kind !== 'req' || request.id === undefined) return;

        const method = String(request.method ?? '');
        const params = request.params && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
        const handler = COCOS_IPC_METHODS[method];

        let reply: { ok: boolean; text: string; error?: string; data?: unknown };
        if (!handler) {
            reply = {
                ok: false,
                text: `dsh_chat：未知的编辑器方法 "${method}"（扩展版本与 profile 版本可能不匹配，请重新打开面板或重载扩展）。`,
            };
        } else {
            try {
                reply = await handler(params);
            } catch (error) {
                reply = { ok: false, text: `编辑器侧处理 "${method}" 时抛错：${describe(error)}` };
            }
        }

        try {
            // 失败时**必须**把原因放进 `error`：DSH 侧插件只读帧上的 `error`（读不到就回落成
            // 一句没有信息量的「编辑器返回失败」）。这里少了它，`result.text` 里那句真原因
            // 就永远到不了模型眼前 —— 实测为此盲试了十几轮。
            this.child?.send({
                __tag: IPC_TAG,
                kind: 'res',
                id: request.id,
                ok: reply.ok,
                ...(reply.ok ? {} : { error: reply.error ?? reply.text ?? '编辑器侧执行失败（没有给出原因）' }),
                result: reply,
            });
        } catch (error) {
            console.warn(`[dsh_chat] 回执 IPC 失败：${describe(error)}`);
        }
    }

    // ---------------------------------------------------------------- 通知处理

    private handleNotification(method: string, params: Record<string, unknown>): void {
        switch (method) {
            case 'session.event': {
                const event = params.event;
                if (event && typeof event === 'object') {
                    this.handleSessionEvent(event as Record<string, unknown>, false, String(params.sessionId ?? ''));
                }
                break;
            }
            case 'session.status': {
                this.running = params.status === 'running';
                if (!this.running) this.finishStreams();
                this.scheduleFlush();
                break;
            }
            case 'subagent.started': {
                this.append('note', `子 agent 启动：${String(params.agentId ?? '')}`);
                break;
            }
            case 'subagent.finished': {
                this.append('note', `子 agent 结束：${String(params.agentId ?? '')}（${String(params.status ?? '')}）`);
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
    private handleSessionEvent(event: Record<string, unknown>, replay = false, sessionId = ''): void {
        // 接上历史会话之后，运行时里可能同时有「老的 SDK 会话」和「接上来的会话」两个 id，
        // 不按 id 过滤的话两段对话会串在一起。子 agent 的会话同样被挡掉（它另有
        // subagent.started/finished 两条 note）。
        if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId) return;

        const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
        switch (String(event.type ?? '')) {
            case 'user/message': {
                // 自己发的那条已经在 send() 里回显过了；这里只把「注入的上下文」记成一行 note，
                // 否则转写里会混进一大堆 AGENTS.md / skill 正文。
                const source = data.source as { kind?: string; form?: string; summary?: string } | undefined;
                if (source?.kind === 'plugin' && source.form === 'notice' && source.summary) {
                    this.append('note', `注入上下文：${source.summary}`);
                } else if (replay && (!source || source.kind === 'user')) {
                    // 回放时用户消息必须画出来（实时那条由 send() 负责；历史里没有 send()）
                    const blocks = data.content ?? (data.message as { content?: unknown } | undefined)?.content;
                    const text = textOfBlocks(blocks);
                    const images = imagesOfBlocks(blocks);
                    // 纯图片消息（没有文字）在日志里是一堆 image 块 —— 也要上屏，只画碎片
                    if (text || images.length > 0) this.append('user', text, undefined, images);
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = data.chunk as { type?: string; text?: string } | undefined;
                if (!chunk) break;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.pushStream('agent', chunk.text);
                else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') this.pushStream('thinking', chunk.text);
                break;
            }
            case 'assistant/message': {
                const message = data.message as { content?: unknown } | undefined;
                const text = textOfBlocks(message?.content);
                const interrupted = data.interrupted === true;
                if (replay) {
                    // 回放：思考块也在 content 里（实时是 chunk 流），按块顺序还原
                    for (const block of Array.isArray(message?.content) ? message?.content : []) {
                        const typed = block as { type?: string; text?: string };
                        if (typed?.type === 'reasoning' && typeof typed.text === 'string' && typed.text.trim()) {
                            this.append('thinking', typed.text);
                        }
                    }
                    if (text) this.append('agent', text);
                } else if (this.textStream) {
                    // 用「拼装好的完整消息」盖掉流式累积（同一 seq → 面板原地替换，不会出现两遍）
                    if (text) this.textStream.text = text;
                    this.touch(this.textStream);
                    this.textStream = null;
                } else if (text) {
                    this.append('agent', text);
                }
                this.finishReasoningStream();
                if (interrupted) this.append('note', '本轮被中断（以上是已产出的内容）');
                break;
            }
            case 'tool/call': {
                this.finishStreams();
                const callId = String(data.callId ?? '');
                const entry = this.append('tool', undefined, {
                    name: String(data.name ?? 'unknown'),
                    callId,
                    args: typeof data.arguments === 'string' ? data.arguments : undefined,
                    done: false,
                });
                if (callId) this.toolByCallId.set(callId, entry);
                break;
            }
            case 'tool/result': {
                const message = data.message as
                    | { source?: { callId?: string }; content?: Array<{ content?: unknown; isError?: boolean; toolCallId?: string }> }
                    | undefined;
                const callId = String(message?.source?.callId ?? message?.content?.[0]?.toolCallId ?? '');
                const entry = callId ? this.toolByCallId.get(callId) : undefined;
                // ⚠ 文本与 isError 的取法见 `toolResultOf`（新老日志形状不同，只认一种会静默丢结果）
                const result = toolResultOf(message);
                const output = result.text;
                const isError = result.isError || data.error !== undefined;
                const shown =
                    output.length > TOOL_OUTPUT_DISPLAY_LIMIT
                        ? `${output.slice(0, TOOL_OUTPUT_DISPLAY_LIMIT)}\n…（已截断，完整结果已交给模型）`
                        : output;
                if (entry) {
                    // `endedAt` 只给面板算耗时用（`entry.at` 是发起时刻）
                    entry.tool = { ...(entry.tool as ToolEntry), done: true, ok: !isError, output: shown, endedAt: Date.now() };
                    this.touch(entry);
                    if (callId) this.toolByCallId.delete(callId);
                } else {
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
                const raw = data.reason as
                    | string
                    | { kind?: string; error?: { message?: string; code?: string } }
                    | undefined;
                const kind = typeof raw === 'string' ? raw : String(raw?.kind ?? '');
                if (kind && kind !== 'completed') {
                    const detail =
                        typeof raw === 'object' && raw?.error?.message ? `：${raw.error.message}` : '';
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

    private append(kind: EntryKind, text?: string, tool?: ToolEntry, images?: EntryImage[]): Entry {
        const entry: Entry = { seq: ++this.seq, rev: ++this.revision, kind, at: Date.now(), text, tool };
        if (images && images.length > 0) entry.images = images;
        this.entries.push(entry);
        while (this.entries.length > MAX_ENTRIES) this.entries.shift();
        this.dirty.add(entry);
        this.scheduleFlush();
        return entry;
    }

    private touch(entry: Entry): void {
        entry.rev = ++this.revision;
        this.dirty.add(entry);
        this.scheduleFlush();
    }

    /** 流式追加：第一条 delta 建条目，后续原地增长（同一 seq，面板原地替换）。 */
    private pushStream(kind: 'agent' | 'thinking', delta: string): void {
        let entry = kind === 'agent' ? this.textStream : this.reasoningStream;
        if (!entry) {
            // append() 自己会标脏 + 排刷
            entry = this.append(kind, delta);
            if (kind === 'agent') this.textStream = entry;
            else this.reasoningStream = entry;
            return;
        }
        entry.text = `${entry.text ?? ''}${delta}`;
        this.touch(entry);
    }

    /** 结束流式（收尾成静态条目）。 */
    private finishStreams(): void {
        this.textStream = null;
        this.finishReasoningStream();
    }

    private finishReasoningStream(): void {
        if (!this.reasoningStream) return;
        if (!this.reasoningStream.text) {
            // 空的思考条目没有意义，从转写里摘掉
            const index = this.entries.indexOf(this.reasoningStream);
            if (index >= 0) this.entries.splice(index, 1);
            this.dirty.delete(this.reasoningStream);
        }
        this.reasoningStream = null;
    }

    // ---------------------------------------------------------------- 广播

    private setStatus(status: AgentStatus): void {
        this.status = status;
        this.scheduleFlush();
    }

    private fail(message: string): { ok: false; error: string } {
        this.lastError = message;
        this.status = 'error';
        this.append('error', message);
        return { ok: false, error: message };
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    private flush(): void {
        if (this.dirty.size === 0) return;
        const batch = [...this.dirty].slice(0, FLUSH_BATCH_LIMIT);
        for (const entry of batch) this.dirty.delete(entry);
        if (this.dirty.size > 0) this.scheduleFlush();
        const update: HostUpdateView = {
            entries: batch,
            revision: this.revision,
            generation: this.generation,
            status: this.status,
            running: this.running,
        };
        for (const listener of this.listeners) {
            try {
                listener(update);
            } catch (error) {
                console.warn(`[dsh_chat] 更新回调抛错：${describe(error)}`);
            }
        }
        try {
            Editor.Message.broadcast(BROADCAST_CHANNEL, update as unknown as object);
        } catch {
            // 广播是保险丝而非主路：面板还有轮询兜底，这里失败不算错。
        }
    }
}
