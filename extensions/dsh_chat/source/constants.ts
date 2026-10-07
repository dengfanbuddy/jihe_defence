/**
 * 全扩展共享的常量：名字、通道名、IPC 协议标记。
 *
 * 单独一个文件的理由：这些字符串**跨进程、跨语言**（TS ↔ 面板 ↔ DSH 侧的 .mjs 插件），
 * 散落各处一定会对不上。改这里，就等于改协议。
 */

/** 扩展名。`Editor.Message.request('dsh_chat', ...)` 用的就是它。 */
export const EXTENSION_NAME = 'dsh_chat';

/** 扩展版本（面板标题栏显示）。 */
export const EXTENSION_VERSION = '0.1.0';

/** dsh profile 名。`dsh --profile cocos`。 */
export const PROFILE_NAME = 'cocos';

/**
 * fork IPC 帧上的标记位。
 *
 * ⚠ 必须与 `dsh-profile/plugin/dsh-cocos-bridge/index.js` 里的 `IPC_TAG` **逐字相同**。
 * 两边是不同语言/不同包，靠这个常量对齐。
 */
export const IPC_TAG = 'dsh-cocos-bridge';

/** 主进程 → 面板的广播通道名。 */
export const BROADCAST_CHANNEL = 'dsh_chat:event';

/** 面板 → 主进程的消息名（必须与 package.json 的 contributions.messages 一致）。 */
export const MSG = {
    getState: 'get-state',
    getEvents: 'get-events',
    sendMessage: 'send-message',
    newSession: 'new-session',
    startAgent: 'start-agent',
    stopAgent: 'stop-agent',
    /**
     * 中断**当前这一轮**（不等于停 agent）。
     *
     * 名字刻意与 `stopAgent` 分开：那个停的是整个 agent 进程，这个只取消正在跑的这一轮，
     * 会话与上下文都留着。SDK 协议里没有取消这一轮的表达，走的是插件控制通道
     * （`dsh-cocos-bridge` 的 `session/cancel` → 运行时 `Agent.cancel()`）。
     */
    interrupt: 'interrupt',
    historyList: 'history-list',
    historyOpen: 'history-open',
    historyResume: 'history-resume',
    /**
     * 在**所有**会话日志里做字面子串全文搜索（面板历史抽屉里的「搜全文」）。
     *
     * 走的是那个 node 读取器的 `search` 子命令（磁盘扫描），不是宿主的
     * `ctx.sessionQuery` —— 本 profile 里 FTS 后端是关着的（`openAt: never`），
     * 而它继承来的 `filterEvents` 是逐会话、跑在宿主事件循环上的，搜一次就能
     * 把正在跑的 agent 卡住几秒。详见 `scripts/session-log.js` 的头注释。
     */
    historySearch: 'history-search',
    /** 把一条会话导出成文件（`md` 转写 / `jsonl` 原样日志），落在 `<DSH_HOME>/exports/<工程键>/`。 */
    historyExport: 'history-export',
    /** 删掉一条会话（**先 dry-run 拿清单，再真删** —— 面板据此做二次确认）。 */
    historyDelete: 'history-delete',
    getSettings: 'get-settings',
    updateSettings: 'update-settings',
    installProfile: 'install-profile',
    panelProbe: 'panel-probe',
    /** 列工程里的图片（面板的图片选择器）。 */
    listImages: 'list-images',
    /** 读一张工程图片（转成 base64 回给面板做缩略图/发送）。 */
    readImage: 'read-image',
    /**
     * 回答一次「需要人拍板」的交互（模型的提问 / 授权请求 / 计划评审）。
     *
     * 为什么要这一条：DSH 的两个 waterfall（`user-questions/request`、
     * `approval/request`）在 sdk profile 里**没有任何应答者** —— 应答者长在
     * `dsh-web-app` 的浏览器那一半。没有它就表现成「`ask_user_question` 报
     * NO_PROVIDER」「需要授权的操作一律被拒」「计划模式出不来」。
     * 插件（`dsh-cocos-bridge`）现在挂了应答者，把请求经 IPC 送到这里，面板作答。
     */
    interactionAnswer: 'interaction-answer',
    /**
     * 列这个 agent 能用的斜杠命令（面板输入 `/` 时弹的那张表）。
     *
     * 命令的**生产方全在宿主**（`/compact` `/plan` `/goal` `/feedback` …），
     * 原本只有浏览器命令面在消费。SDK 协议没有命令这一层，所以走插件控制帧。
     */
    commandList: 'command-list',
    /** 执行一条斜杠命令行（`/compact` 这类；结果**不进模型历史**）。 */
    commandRun: 'command-run',
    /** 列 `@路径` 候选（`@` 补全；服务由 `dsh-file-reference-local` 提供）。 */
    fileReference: 'file-reference',
    /**
     * 读**当前会话的用量**（token 累计 / 上下文占用 / 花费）。
     *
     * 数据不是问 agent 要的：SDK 协议里没有投影读取，而 `ctx.tokenMeter` 只有宿主进程内的
     * 插件拿得到。真正读的是 DSH 的**会话投影缓存**
     * （`<DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json`）——
     * 明文 JSON，所以主进程自己读就行（不需要 zstd、也不需要外面那个 node）。
     * 读数与四条诚实口径见 `source/stats.ts` 的头注释。
     */
    sessionUsage: 'session-usage',
    /**
     * 读**这条会话的后台任务**（jobs）与**子 agent**（subagents）——「活动」抽屉的两块。
     *
     * 两者都只活在**运行时进程的内存里**（jobs 的注册表是个 `Map`，子 agent 的描述符写在
     * 子会话自己的日志里），SDK 协议一个都表达不了 —— 所以和斜杠命令、`@` 路径一样，
     * 走插件（`dsh-cocos-bridge`）的控制帧借宿主的注册表。
     *
     * ⚠ **job 的输出面板一个字都不许读**：每个 job 只有一个消费游标，`read()` 一调就把它推走，
     * 模型下一次 `job_output` 只会拿到 `(no new output)`。口径与「为什么」见插件的
     * `listJobs` 上方那段注释。
     */
    panelActivity: 'panel-activity',
    /**
     * 中断一个**子 agent** 的当前一轮（面板上那一行的按钮）。
     *
     * 语义与我们那个「停止本轮」完全一致：只停当前这一轮，会话与上下文都留着
     * （插件里的 authority 是 `{kind:'user', parentSessionId}` —— 别改成 ancestor 那支）。
     */
    subagentInterrupt: 'subagent-interrupt',
} as const;

/**
 * 一条可用的斜杠命令（面板只画这三样 + 两个可选标记）。
 *
 * 字段名对齐 `@deepseek-ai/dsh-commands` 的 `CommandDescriptor`（`input.hint` /
 * `input.images` 被**压平**成顶层字段 —— 面板不需要知道原嵌套）。
 */
export interface CommandView {
    /** 不带斜杠的命令名。 */
    name: string;
    /** 一句话说明（命令自己写的）。 */
    description: string;
    /** 可选输入提示，如 `[off|message]`；有它就说明这个命令能吃参数。 */
    hint?: string;
    /** 这个命令接受图片附件（面板据此决定要不要提示「先把图贴上去」）。 */
    images?: boolean;
}

/** `@` 补全的一个候选（对齐 `FileReferenceCandidate`，只多一个「目录带尾斜杠」的既定写法）。 */
export interface ReferenceCandidate {
    /** 工作区相对路径；目录候选带尾斜杠。 */
    path: string;
    /** 目录选中后**继续往下钻**（引号保持打开），文件选中即完成。 */
    kind: 'file' | 'directory';
}

/**
 * 一个后台任务（job）—— 面板「活动」抽屉的上半块。
 *
 * 字段逐条对应插件的 `JobSnapshot` 投影（`projectJob`），**故意不带 `owner`**：
 * 那是一个 Agent 实例，过不了 IPC。
 *
 * ⚠ **没有输出**，而且这不是"还没做"：每个 job 只有一个消费游标，面板读一次就会让模型的
 * `job_output` 变成 `(no new output)`。所以这里只有元数据 + 状态 + 退出码（在 `detail` 里）。
 */
export interface JobView {
    /** `<kind>-N`（**每 kind 一个计数器，进程内自增** —— 重启后会复用，别当全局唯一 id 用）。 */
    id: string;
    /** 谁起的：`pwsh` / `bash` / `subagent` …（由工具自己传的字符串，词表不封闭）。 */
    kind: string;
    /** 一句话说明 —— pwsh 传的是**整条命令原文**（跨 IPC 前会被截到 400 字）。 */
    label: string;
    /** `running` / `stopping` / `completed` / `killed` / `failed`；认不出的原值一律 `unknown`。 */
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed' | 'unknown';
    /** 退出码**在这里**（`exit code: N` / `signal: X` / `killed before exit`），没有就是 null。 */
    detail: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    /** 这个 job 归哪条会话（**子 agent 起的 job 归子 agent**，所以不一定是当前会话）。 */
    ownerSessionId: string;
    /** 拥有者的委派深度：0 = 当前会话自己（null = 查不到）。 */
    depth: number | null;
}

/** 一个子 agent —— 面板「活动」抽屉的下半块。 */
export interface SubagentView {
    /** 子**会话** id（同时也是 `send_message` / 中断的 target）。 */
    id: string;
    /** `child` = 正常的子 agent；`diagnostic` = 这条记录本身有问题（`reason` 说是什么）。 */
    kind: 'child' | 'diagnostic';
    /** 委派时给的那句话；one-shot 的可能没有（**空串就是空串，不许编**）。 */
    label: string;
    /** `continuable` 才能再发消息；`one-shot` 结构上不支持。 */
    mode: 'continuable' | 'one-shot';
    /** 委派深度（1 = 直接子级）。⚠ 它会**跳号**（普通会话也占层），别当成"第几个孩子"。 */
    depth: number | null;
    hasChildren: boolean;
    /** ⚠ 只是「会话记录是否驻留」，**不是**「忙不忙」—— 忙闲看 `status`。 */
    activity: 'running' | 'inactive';
    /** 只有 diagnostic 行有：`corrupt` / `unsupported` / `unavailable`。 */
    reason: string | null;
    /** 合成出来的忙闲：活着的看 `agent.status`，找不到 = `ready`（= 只在磁盘上，可 resume）。 */
    status: 'running' | 'idle' | 'ready';
}

/** 「活动」抽屉一次读到的两块（一起给：面板上它们是同一个抽屉的两段）。 */
export interface ActivityView {
    /** 后台任务。 */
    jobs: JobView[];
    /** 子 agent。 */
    subagents: SubagentView[];
    /**
     * 服务在不在（`false` 时两块都是空的，原因在下面那两条 `*Reason` 里）。
     *
     * 为什么不是一个布尔：两者**可能只有一个**不可用（分开 `ctx.inject` 的理由，
     * 见插件里的 `hostService`）—— 合成一个的话，一个缺失会把另一个能用的也藏起来。
     */
    jobsAvailable: boolean;
    subagentsAvailable: boolean;
    /** 服务缺失时的一句话（面板说「看不到」+ 原因，而不是画一个空列表）。 */
    jobsReason: string | null;
    subagentsReason: string | null;
    /** 列不出来 / 被截断 / 被截短的如实说明（一条一句，面板原样画）。 */
    notes: string[];
    /** 读到的时刻（面板据此说「这是几秒前的」）。 */
    at: number;
}

/** DSH 附件库接受的四种栅格图（与 `source/images.ts` 的 `ImageMimeType` 是同一份）。 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 面板发给主进程的一张图（**只有这两个字段是协议的一部分**）。 */
export interface SendImage {
    mimeType: ImageMimeType;
    /** 规范 base64（无 `data:` 前缀、无换行）。 */
    data: string;
    /** 显示名，只用于转写里那条「🖼 图名」的标记，绝不当作路径。 */
    name?: string;
}

/**
 * 转写条目上记录的「这条消息带了哪些图」——**只有元数据，没有像素**。
 *
 * 为什么不带像素：转写要走广播/轮询回面板（每 120ms 一批、每 800ms 一次全量增量），
 * 塞进去几 MB 的 base64 会把面板拖死；而回放历史日志时**根本拿不到原图**
 * （日志里存的是附件引用 `{attachmentId, mediaType, bytes, width, height}`）。
 * 所以面板上历史消息只画「图名 + 尺寸」的碎片，缩略图只在**发送前**的输入区里显示。
 */
export interface EntryImage {
    name?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
}

/** 智能体子进程的生命周期状态。 */
export type AgentStatus = 'stopped' | 'installing' | 'starting' | 'ready' | 'stopping' | 'error';

/** 转写条目的种类（面板按它决定渲染样式）。 */
export type EntryKind = 'user' | 'agent' | 'thinking' | 'tool' | 'note' | 'error';

/** 一条工具调用（面板上渲染成一张卡片）。 */
export interface ToolEntry {
    /** 工具名，如 `cocos_execute_code` / `read` / `pwsh`。 */
    name: string;
    /** SDK 侧的调用 id，用来把 `tool/result` 配回 `tool/call`。 */
    callId?: string;
    /** 模型给的原始参数（JSON 字符串，未必合法）。 */
    args?: string;
    /** 结果文本（可能很长，面板自己折叠）。 */
    output?: string;
    /** 是否已收到结果。 */
    done?: boolean;
    /** 结果是否为错误。 */
    ok?: boolean;
    /** 收到结果的时刻（面板用它算耗时，`at` 是发起的时刻）。 */
    endedAt?: number;
}

/** 一次「编辑器侧工具调用」的回执（IPC 服务端 → DSH 插件）。 */
export interface ToolReply {
    /** 是否成功。 */
    ok: boolean;
    /** 给模型看的文本。 */
    text: string;
    /**
     * 失败原因（`ok: false` 时必须有）。
     *
     * ⚠ **踩过的坑**：这一格以前不存在，于是失败回执只带 `text`，而 IPC 回执帧上又只传
     * `error` —— 真原因被丢在 `result.text` 里，模型只看到一句
     * 「cocos bridge：编辑器返回失败」，等于没有任何信息（实测为此白跑了十几轮）。
     * 失败时一律把**人能读懂的那句话**放进来。
     */
    error?: string;
    /** 结构化原始结果（不进模型上下文）。 */
    data?: unknown;
}

/**
 * 扩展设置。
 *
 * ⚠ 放在 constants 而不是 settings.ts：**面板（渲染进程）也要这份类型**，
 * 而 settings.ts 会 `Editor.Profile`，面板不该 import 主进程逻辑。
 */
export interface DshChatSettings {
    /** 面板打开时自动启动 agent。 */
    autoStart: boolean;
    /** node 可执行文件；留空 = 自动探测。 */
    nodePath: string;
    /** dsh CLI 的 `lib/bin.js`；留空 = 从 PATH 推导。 */
    dshBin: string;
    /** 模型提供方。 */
    provider: string;
    /** 模型 id。 */
    model: string;
    /** 推理档位（空 = 用模型默认）。 */
    reasoningEffort: string;
    /** 单次输出上限；0 = 不传。 */
    maxTokens: number;
    /** agent 工作目录；留空 = 当前工程根。 */
    workdir: string;
    /** 把子进程 stderr 也作为 note 显示（排查用）。 */
    showStderrNotes: boolean;
    /** 面板外观：跟随编辑器 / 强制深色 / 强制浅色。 */
    theme: PanelTheme;
    /** 面板配色：DSH 官方色板，或跟随 Cocos 编辑器的深色系。 */
    palette: PanelPalette;
    /** 面板正文字号（px，12~17）；0 = 用 token 默认的 14。 */
    fontSize: number;
}

/** 面板外观。`auto` = 能认出编辑器主题就跟编辑器，认不出跟系统。 */
export type PanelTheme = 'auto' | 'dark' | 'light';

/**
 * 面板配色。与 `PanelTheme` **正交**：明暗是一维，配色是另一维。
 *
 * - `dsw`：DSH 官方色板（默认，什么都不覆盖）
 * - `editor`：跟着 Cocos Creator 编辑器走 —— 覆盖层在 `static/style/default/editor-theme.css`
 *   （只重定义 `--dsw-alias-*`，不碰组件选择器；目前只有深色一档）
 */
export type PanelPalette = 'dsw' | 'editor';

/** 广播载荷（`HostUpdate` 的面板侧视图）。 */
export interface HostUpdateView {
    entries: Entry[];
    revision: number;
    /** 转写「第几代」—— 清空/换成另一个会话时 +1，面板据此丢掉旧条目（见 `resetTranscript`）。 */
    generation: number;
    status: AgentStatus;
    running: boolean;
    /**
     * 当前在等的交互（整份，不是增量）。
     *
     * 为什么不只放 `snapshot()`：交互出现时人正盯着面板，靠每 800ms 的轮询最坏会慢近一秒；
     * 而它就是「现在必须点一下」的东西。整份带来的好处是撤回也能表达（空数组 = 没了）。
     */
    interactions?: InteractionView[];
    /**
     * 当前会话的标题（`session/title` 事件折出来的最新一条）。
     *
     * 一起广播的理由与 `interactions` 相同：标题是**异步**来的（`session-title-llm`
     * 要单独发一次模型请求，比首轮回答还慢一拍），靠 800ms 的全量轮询会明显迟到。
     * `undefined` = 这条广播没说标题（面板保留旧值）；`null` = 明确没有标题。
     */
    title?: string | null;
    /**
     * 当前会话的用量（整份，不是增量）。
     *
     * 走广播的理由：用量是**回合结束时**才刷新的（缓存恰好在 `turn/end` 写一次检查点），
     * 而面板的全量状态轮询是「每 5 跳」（空闲 4 秒）—— 靠它的话数字会晚好几秒才变。
     * `undefined` = 这条广播没带用量（面板保留旧值）。
     */
    usage?: SessionUsage | null;
    /** 跟着 `usage` 一起发的一句话（读失败 / 还没读数时的原因）。 */
    usageNote?: string | null;
    /**
     * 当前会话的进度（整份，不是增量）。
     *
     * 走广播的理由比用量还硬：`todo_write` 是 agent 在**回合中间**调的，标记的又正是
     * 「我现在做到哪一步了」—— 靠 800ms 的轮询会明显迟到（而这一块的全部价值就是实时）。
     * `undefined` = 这条广播没带进度（面板保留旧值）。
     */
    progress?: ProgressView | null;
    /** 跟着 `progress` 一起发的一句话（哪来的 / 缺哪一块）。 */
    progressNote?: string | null;
}

/**
 * 把 token 数缩成「一眼能比大小」的形式：`85811` → `85.8k`。
 *
 * 放在 constants 而不是某个只跑在一侧的模块里：**面板与主进程必须用同一套缩写**，
 * 否则同一份数字在两处显示成不同的样子（一处 `85811`、一处 `85.8k`）。
 * 口径：`< 1000` 原样；`k` / `M` / `G` 各保留一位小数，而**进位到下一个量级时换单位**
 * （`999_950` 显示 `1.0M`，不是 `1000.0k`）。
 *
 * @param value - token 数；非有限数或负数按 `—` 出。
 * @returns 给人看的缩写。
 */
export function formatTokens(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return String(Math.round(value));
    const units = [
        { limit: 1e9, suffix: 'G' },
        { limit: 1e6, suffix: 'M' },
        { limit: 1e3, suffix: 'k' },
    ];
    for (const unit of units) {
        if (value >= unit.limit) {
            const scaled = value / unit.limit;
            // ⚠ 先算再判：`999_950 / 1000 = 999.95` → `toFixed(1)` 会进位成 `1000.0`，
            // 于是 `999.9k` 显示成 `1000.0k`。所以进位到下一个量级时要换单位。
            if (scaled >= 999.95 && unit.suffix !== 'G') {
                const next = units[units.indexOf(unit) - 1];
                return `${(value / next.limit).toFixed(1)}${next.suffix}`;
            }
            return `${scaled.toFixed(1)}${unit.suffix}`;
        }
    }
    return String(value);
}

/**
 * 毫秒 → 人话（`2671113` → `44 分 31 秒`）。
 *
 * 用在与模型的耗时上：面板上写 `2671113ms` 没人读得下去，而写 `44.5 分` 又太糊
 * （工具耗时是秒级的，差一个数量级）。
 *
 * @param value - 毫秒；非有限数或负数按 `—` 出。
 * @returns 给人看的时长。
 */
export function formatDuration(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
    const ms = Math.round(value);
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - minutes * 60);
    if (minutes < 60) return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes - hours * 60} 分`;
}

/** 转写里的一条。`seq` 是稳定身份，`rev` 是「最后一次改动」的版本号（流式会反复改同一条）。 */
export interface Entry {
    seq: number;
    /** 最后一次被改动的版本号。面板按 `rev > since` 拉增量，同一 seq 反复出现即「原地更新」。 */
    rev: number;
    kind: EntryKind;
    at: number;
    text?: string;
    tool?: ToolEntry;
    /** 这条消息带的图片（只有元数据，见 `EntryImage`）。 */
    images?: EntryImage[];
}

/** `get-events` 的增量结果。 */
export interface EventsPayload {
    entries: Entry[];
    /** 当前最大 seq；面板下次拿它当 since。 */
    revision: number;
    /** 转写代数：和面板记的不一样就说明「换会话了」，面板要清空重画。 */
    generation: number;
}

/** 当前对话区绑的是哪种会话。 */
export type SessionKind = 'sdk' | 'resumed' | 'history';

/** 面板上的历史会话条目（主进程已按标题/时间整理好）。 */
export interface HistorySessionView {
    id: string;
    title: string;
    createdAt: number | null;
    updatedAt: number;
    bytes: number;
    turns: number;
    /** 是不是**当前正在显示**的那条（列表里高亮用）。 */
    current: boolean;
}

/**
 * 「当前对话区显示的是一条历史会话」这件事本身。
 *
 * `live === false` 时面板挂只读横幅 + 「继续此会话」按钮；`true` 表示已经用
 * `agents.resume` 接上了，接下来的消息带着它的上下文。
 */
export interface HistoryView {
    sessionId: string;
    title: string;
    createdAt: number | null;
    /** 回放进来多少条事件。 */
    messageCount: number;
    /** 只读回放还是已接上（能接着聊）。 */
    live: boolean;
}

/** 一条搜索命中里的**片段**（谁说的那句话 + 上下文）。 */
export interface HistorySnippetView {
    /** 投影侧的来源种类：`user` / `assistant` / `thinking` / `tool` / `tool-result` / `command` / `title` … */
    role: string;
    /** 给人看的标签（`你` / `我` / `思考` / `工具 read`）。 */
    label: string;
    /** 这条片段来自哪个事件（诊断用；跳转用的是外层那条 `seq`）。 */
    seq: number;
    /** 截出来的片段（前后带 `…` 说明被截过）。 */
    snippet: string;
}

/** 全文搜索命中的一条会话（主进程已把片段与覆盖率整理好）。 */
export interface HistorySearchHitView {
    id: string;
    title: string;
    createdAt: number | null;
    updatedAt: number;
    bytes: number;
    turns: number;
    /** 这个词在**这条会话里**出现了几次（有上限）。 */
    hits: number;
    /**
     * 最靠前那条命中的**事件 seq**。
     *
     * 不是转写条目号：日志事件与面板条目是两套编号，中间隔着一层投影
     * （`read`/`tool result` 只更新卡片、不新增条目）。面板把它交给主进程的
     * `history-open`，由主进程在回放时换算出**条目 seq** 再滚过去。
     */
    seq: number;
    snippets: HistorySnippetView[];
}

/**
 * 全文搜索的回执。
 *
 * ⚠ `partial` / `stoppedBy` / `scanned` / `available` **必须如实画出来**：
 * 搜索是**有预算的**（会话数 / 字节数 / 毫秒），停下来的地方是「更老的会话没看」。
 * 只说「找到 3 条」而不说「只扫了 6 个会话、一共 107 个」，用户就会以为搜全了。
 */
export interface HistorySearchView {
    ok: boolean;
    error?: string;
    /** 原样回显的查询串（面板据此确认「这是哪次搜索的结果」）。 */
    query?: string;
    hits?: HistorySearchHitView[];
    /** 实际扫了几个会话。 */
    scanned?: number;
    /** 这个工程一共几个会话。 */
    available?: number;
    /** 有没有因为预算而提前收工。 */
    partial?: boolean;
    /** 为什么收工：`limit` / `sessions` / `bytes` / `time`；扫完了就是 `null`。 */
    stoppedBy?: string | null;
    elapsedMs?: number;
    scannedBytes?: number;
}

/** 导出的回执。 */
export interface HistoryExportView {
    ok: boolean;
    error?: string;
    id?: string;
    title?: string;
    /** `md` = 给人读的转写；`jsonl` = 解压后**原样**的日志；`zip` = 对齐 DSH 官方那一份（含子孙与附件）。 */
    format?: string;
    /** 写出来的绝对路径（面板显示 + 复制）。 */
    path?: string;
    dir?: string;
    bytes?: number;
    /** md = 投影后的事件条数；jsonl = 原样搬出去的行数；zip = **条目数**。 */
    events?: number;
    /**
     * ZIP 那一路的子孙会话事实。
     *
     * ⚠ `subagentCount`（`origin === 'subagent'`）与 `forkCount`（有 `parentSession` 但没有 origin）
     * **分开报**：两者在日志头里的判据不同，而用户看到「含 5 个子会话」时真正想知道的是
     * 「其中几个是我派出去的 agent」。
     */
    subagents?: {
        total: number;
        subagentCount: number;
        forkCount: number;
        maxDepth: number | null;
        /** 父级在索引里找不到的子孙（悬空引用）—— 如实说，不假装树是完整的。 */
        dangling: string[];
        /** 索引扫描超了预算 ⇒ 子孙可能不全。 */
        incomplete: boolean;
    };
    /** ZIP 那一路的附件事实。 */
    media?: { count: number; missing: number; namingDeviation: string | null };
    /** 引用了但读不到文件的附件 id（缺失就如实说）。 */
    missingMedia?: string[];
    /** 脚本要交代的话（活跃会话可能少最后几条 / 索引超预算 / 缺媒体…）。 */
    notes?: string[];
    /** ZIP 自己的事实。 */
    zip?: { fileName: string; entries: number };
}

/** 删除的回执（`removed === false` = 这一趟只是 dry-run 的清单）。 */
export interface HistoryDeleteView {
    ok: boolean;
    error?: string;
    id?: string;
    dir?: string;
    removed?: boolean;
    /** 这个会话目录里有多少个文件、共多少字节（二次确认要显示）。 */
    fileCount?: number;
    bytes?: number;
    /** 真删了之后，主进程顺手把「正在只读回放的那条」清掉没有。 */
    cleared?: boolean;
    /**
     * 「删会话时顺带回收无引用附件」那一趟的结果（**默认关**，要显式打开才有）。
     *
     * ⚠ 它天然是「可能什么都没做」：附件按内容全局去重，本机实测 797 个对象**全都被引用**，
     * 所以 `orphans` 通常是 0；而**超预算时 `incomplete: true` 且一个都不搬**（fail-closed）。
     * 面板上不许把它写成「一键腾空间」—— 它只在删过「引用唯一」的会话之后才有活干。
     */
    reclaim?: {
        dryRun: boolean;
        /** 这条会话引用到的附件数（候选）。 */
        candidates: number;
        /** 候选里仍被**别的**会话引用的个数。 */
        referenced: number;
        /** 已无引用的个数。 */
        orphans: number;
        /** 实际搬进墓碑的个数（dry-run 时是 0）。 */
        trashed: number;
        bytesFreed: number;
        /** 全库扫描被预算中断 ⇒ **一个都没搬**（这句话必须原样画出来）。 */
        incomplete: boolean;
        incompleteReason: string | null;
        /** 全库扫描的口径（几条会话 / 多少字节 / 多久）—— 这一步是分钟级的，要说出来。 */
        scanned: { sessions: number; bytes: number; elapsedMs: number };
        /** 被守卫否决的候选与原因（`still-referenced` / `hash-mismatch` / `recent` …）。 */
        skipped: Array<{ id: string; reason: string }>;
        trashDir: string;
    };
}

/** 四个 token 桶（prompt 侧的 `input` 是**未命中缓存**的那部分，缓存读写在另一栏）。 */
export interface UsageBuckets {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/**
 * `dsh-cost-meter` **账本**里的显示设置（`<DSH_HOME>/storages/cost-meter/ledger.json`
 * 的 `config` 那几个字段）。
 *
 * ## 为什么金额要两个文件才画得出来
 *
 * 账本**恒以美元入账**（上游 `usdFromCost` 的注释：「账本恒以美元存储」），而显示成
 * 人民币还是美元、保留几位小数、按什么汇率折 —— 全在这一份**配置**里，不在金额那一行。
 * 所以「本会话花了多少」来自投影缓存，而「这笔钱显示成 `¥19.09` 还是 `$2.65`」来自账本。
 * 缺了它就只能按美元原值显示（面板会说出来，不假装知道汇率）。
 */
export interface CostDisplay {
    /** 显示币种：`CNY` / `USD` / `EUR` / 自定义。 */
    currency: string;
    /** 货币符号（`¥` / `$` …）。 */
    symbol: string;
    /** 小数位（0~10；数值过小时上游会自动放宽两位，见 `stats.ts` 的 `formatMoney`）。 */
    decimals: number;
    /** 展示层汇率：**美元 → 显示币种**。 */
    exchangeRate: number;
    /** 官方**价表**的币种（`USD` / `CNY`）—— 它决定入账前怎么折算，与显示币种是两件事。 */
    pricingCurrency: string;
}

/**
 * 账本里跟**某一条会话**有关的事实（对账 + 兜底用）。
 *
 * 检查点（投影缓存）与账本折的是同一份日志，所以正常应该一样；不一样的两种情况都真实存在：
 * ① 检查点是**用当前价表重算**的，而账本保留**调用当时**算出的金额（上游 v9 的注释）；
 * ② 老会话的检查点里根本没有 `costUsage` 这一行（插件是后挂上的），账本却有。
 */
export interface CostLedgerView {
    /** 账本里这条会话的总花费（美元）；账本里没有它就 null。 */
    sessionUsd: number | null;
    /** 账本记的调用次数（同一条会话）；没有就是 null。 */
    calls: number | null;
    /** 账本里**今天**的花费（美元）—— ⚠ 是这台机器上**所有工程、所有 profile** 的合计。 */
    todayUsd: number | null;
    /** 上面那一行是哪一天（本地日期 `YYYY-MM-DD`，与上游 `localDayKey` 同一个口径）。 */
    todayKey: string;
}

/**
 * 上下文增长曲线上的**一个压缩点**（`contextTimeline` 的 `events` 里 `kind` 是
 * `compaction` / `prune` 的那些）。
 *
 * 为什么它自己一个类型：面板要画的不是「有一条压缩」这么简单 —— 上游一次 `prune` 会**连发**
 * （本机真数据里有一条会话连发 7 条小 prune、52ms 内跑完，随后 3.0 秒才是一条大 compaction），
 * 一条事件画一根竖线的话柱子上会糊成一片。所以读取器按「**钉在同一根柱上 + 时间相近**」
 * 把它们合并成一个标记，`merged` 就是合并了几条 —— 面板据此说「这里连发了 N 条」。
 */
export interface TimelineCutView {
    /** `compaction` = 大压缩（宿主给的净释放最多）；`prune` = 单条裁剪。合并组里只要有 compaction 就算 compaction。 */
    kind: 'compaction' | 'prune';
    /** 净释放的 token（宿主算的 `tokens`，同一组合并时求和）。 */
    tokens: number;
    /** 被这次压缩盖掉的记录条数（上游只给 `compaction` 带 `count`）；没有就是 null。 */
    count: number | null;
    /** 这个标记是几条事件合并出来的（`1` = 只有一条）。 */
    merged: number;
    /** 第一条事件的时刻 / 事件序号（面板的 tip 与排查用）。 */
    time: number | null;
    seq: number | null;
}

/**
 * 曲线上的一根柱 —— **一次模型调用**（点少时）或**一个回合**（点多时，见 `aggregated`）。
 *
 * 三个字段是这块的判据，缺一个面板就会撒谎：
 * - `tokens`：柱高用的那个数（**优先实测的 `prompt`**，回落到估算的 `total`，见 `estimated`）；
 * - `estimated`：这一根是不是估算 —— 面板把它画成斜纹，**不许混进实测里**；
 * - `steps`：这根柱代表几步（单次调用是 1；按回合聚合时是该回合的请求条数，也就是柱宽）。
 */
export interface TimelinePointView {
    /** 第几根柱（1 起，面板的「第 N 次」与压缩点的位置都用它）。 */
    index: number;
    /** 柱高用的 token 数（prompt ?? total）。 */
    tokens: number;
    /** provider 实测的 prompt（input + cacheRead + cacheWrite）；没报就是 null。 */
    prompt: number | null;
    /** 估算的 total（系统 + 工具 + 对话，四字符一 token 那套）；没有就是 null。 */
    total: number | null;
    /** 这一根用的是估算值（`prompt` 缺失时的回落）—— 平台图上要标出来。 */
    estimated: boolean;
    /** 落在哪一回合 / 哪一步（认不出就是 null）。 */
    turn: number | null;
    step: number | null;
    /** 这根柱最后一次调用的会话事件序号（压缩点就是按它钉上来的）。 */
    seq: number | null;
    /** 这根柱代表几步（聚合时的柱宽依据）。 */
    steps: number;
    /** 钉在这一根柱上的压缩点（同一处连发的已经合并过）。 */
    cuts: TimelineCutView[];
}

/**
 * 一条会话的**上下文增长曲线**（`contextTimeline` 那一行归一化之后的样子）。
 *
 * ⚠ 这一行由**第三方**插件 `dsh-context` 注册（不是 DSH 自带的），而**本 profile 不挂它**
 * —— 所以「没有这一行」是常态路径，面板要说的那句话在 `timelineTextOf` 里。
 * 挂过它的 profile（web / desktop）跑的会话，缓存里就有这一行。
 *
 * 为什么读取器要自己归一化 + 聚合：缓存里的 `val` 是**投影状态**（`requests` /
 * `events` / `archiveFloor` …），而且规模可以很大（本机真数据：`requests` 中位 37 条、
 * p95 322、最大 1500；`val` 的 JSON 中位 16KB、最大 404KB）。一次调用一根柱在 1500 条时
 * 既画不下也点不动，所以超过阈值按回合聚合 —— **取该回合最后一步**，绝不取平均值
 * （平均会把压缩掉的那一截抹平，而那正是这张图存在的理由）。
 */
export interface ContextTimelineView {
    /** 这一行的状态版本（当前只认 13，见 `CONTEXT_TIMELINE_STATE_VERSION`）。 */
    ver: number;
    /** 这一行的水位（至少折到第几条事件）。 */
    seq: number | null;
    /** 要画的柱（按会话顺序）。 */
    points: TimelinePointView[];
    /** 聚合**之前**的请求条数（面板用它说「一共调用了几次」）。 */
    requests: number;
    /** 有没有按回合聚合（`points.length` 比 `requests` 小就是它）。 */
    aggregated: boolean;
    /** 认不出形状被丢掉的请求条数（**不补 0**：丢几条就说几条）。 */
    dropped: number;
    /** 柱高归一用的最大值（`points` 里最大的那个 `tokens`）。 */
    max: number;
    /** 有几根柱用的是估算值（> 0 时面板必须说清楚）。 */
    estimatedCount: number;
    /** 最新那根柱的 token 数（头部那一行的「最新一次」）。 */
    lastTokens: number | null;
    /** 最新那根柱是不是估算的。 */
    lastEstimated: boolean;
    /** 上下文窗口上限；**缺失时不许画百分比**（分母不知道就不补一个）。 */
    contextWindow: number | null;
    /** 上游的 `archiveFloor`：seq 小于它的删除记录已经被缓存裁掉了（有就要说出来）。 */
    archiveFloor: number | null;
    /** 压缩点总数（合并之后的标记个数）。 */
    cutsTotal: number;
}

/** 图例里的一格（`swatch` 决定画什么小色块）。 */
export interface TimelineLegendItem {
    swatch: 'measured' | 'estimated' | 'cut';
    label: string;
}

/**
 * 「上下文增长」那一块要画的**文字**（DOM 由面板建）。
 *
 * 为什么要一个纯函数：这几句话全是判据（哪条是实测、哪条是估算、为什么没画、聚合了没有、
 * `archiveFloor` 是哪一段没了），而它们**只在这儿写一份** —— 面板照画、
 * `scripts/verify-stats.js` 拿已知答案跑它（面板的 DOM 代码测不了，文字能测）。
 */
export interface TimelineText {
    /** 头部那一行（几次调用 / 最新一次是多少）；**没画曲线时是 null**。 */
    headline: string | null;
    /** 图例（没画曲线时是空数组）。 */
    legend: TimelineLegendItem[];
    /** 说明（一条一句，按重要性排）；**永远至少有两条** —— 最少也是「为什么没有」那一组。 */
    notes: string[];
}

/**
 * 一条会话的用量（面板用量抽屉里画的全部内容）。
 *
 * ⚠ **字段全是「拿不到就 null」，没有一个是「估算成 0」** —— 面板只画不算，
 * 所以这里的每个 null 都会变成界面上的「—」加一句解释，而不是一个骗人的 0。
 * 口径、公式来源与四条诚实说明见 `source/stats.ts` 的头注释。
 */
export interface SessionUsage {
    /** 会话 id（= 缓存文件名）。 */
    id: string;
    /** 缓存记录的**文档**格式版本。 */
    version: number | null;
    /** **水位**：这份账至少记到第几条事件（检查点是攒着写的，不是实时的）。 */
    seq: number | null;
    /** 相对当前实时水位落后多少条事件；拿不到实时水位就是 null。 */
    behind: number | null;
    /** 缓存文件的写入时刻。 */
    updatedAt: number;
    identity: { cwd: string | null; seeded: boolean; inheritedEvents: number };
    model: string | null;
    provider: string | null;
    context: {
        /** 窗口上限（`request/context` 带过来的）。 */
        window: number | null;
        /** **下一次**请求的 prompt 侧预估 —— 占用率用的就是它。 */
        projected: number | null;
        /** **上一次**请求的 prompt 侧实测（provider 报的，不含输出）。 */
        pressure: number | null;
        /** `projected / window`；窗口未知则 null。**不钳制**：超过 1 要看得出来。 */
        ratio: number | null;
        /** 上下文**估算**组成（系统提示 / 工具表 / 对话）—— 与上面三行不是一个口径，加起来也对不上。 */
        system: number | null;
        tools: number | null;
        messages: number | null;
    };
    usage: {
        totals: UsageBuckets | null;
        last: { turn: number; step: number; buckets: UsageBuckets } | null;
    };
    /**
     * 花费（**本会话**，单位恒为**美元**：`costUsage` 那一行的 `totals.cost`）。
     *
     * 那一行由 `dsh-cost-meter` 注册 —— 而 **cocos profile 刻意不挂它**（2026-12 的决定：
     * `dsh-profile/package.json` 里零第三方 bundle，见 `stats.ts` 文件头口径 4）。
     * 所以这个字段**基本总是 null**；留着它是因为「挂过它的 profile 跑的会话」与**老会话**
     * 的检查点里确实有这一行，面板照旧要画。null = 这一行**不存在**，不是「没花钱」。
     */
    cost: { amount: number; provider: string; model: string } | null;
    /** 怎么把钱显示出来（币种 / 汇率 / 小数位）—— 来自账本；读不到就是 null（面板按美元原值画）。 */
    costDisplay: CostDisplay | null;
    /** 账本那一份同一件事（对账与兜底）；读不到账本就是 null。 */
    costLedger: CostLedgerView | null;
    /**
     * **读账本失败的原因**（原文照搬给面板）。
     *
     * ⚠ 它不进 `notes`：`notes` 是**会话用量本身**的口径问题，而这一条只影响「花费显示成
     * 什么币种」，所以由花费那一块自己显示（`panels/default/cost.ts` 管措辞）。
     * 一条账本都没有（插件没跑过）时也有值 —— 那不是错误，只是没有显示设置。
     */
    costNote: string | null;
    /**
     * 这个 profile **到底挂没挂** `dsh-cost-meter`（读的是 `$DSH_HOME/profiles/cocos/package.json`
     * 的 `dsh.profile.bundles`）。
     *
     * 为什么要单独一个字段：`cost` 为 null 有**三种完全不同的来路**，而它们的界面话术
     * （与「该做什么」）都不一样：① 这条会话太老（挂上之前跑的）；② 这个 profile **刻意没挂**
     * 那个第三方 bundle（**本 profile 的常态**）；③ 别的 profile 跑的会话。光看缓存分不出来
     * —— 只有读 profile 清单才行。
     * `null` = 读不到清单（分不清 ①②③，面板会说分不清，不猜）。
     */
    costMounted: boolean | null;
    /** 那个第三方 bundle 的名字（面板话术里要写出来；名字的真源在 `stats.ts`）。 */
    costBundle: string;
    /**
     * **上下文增长曲线**（`contextTimeline` 那一行：一条会话里上下文随每次模型调用怎么长大）。
     *
     * 那一行由**第三方**插件 `dsh-context` 注册 —— 与 `cost` 同一个处境，**本 profile 不挂它**，
     * 所以「没有这一行」是**常态路径**（不是读失败）：只有 web / desktop profile 跑的会话才有。
     * `null` = 这一行不存在（或者它的形状/版本我们认不出来，原因在 `timelineNote` 里）；
     * 它**不是**「这条会话没有上下文」—— 那是两件事，面板上也是两句话。
     */
    timeline: ContextTimelineView | null;
    /**
     * **这一行为什么没画出来**（原文照搬给面板）。
     *
     * ⚠ 与 `costNote` 同一条纪律：它**不进 `notes`**。`notes` 是**会话用量本身**的口径问题
     * （占用率怎么来的、累计 token 少了哪一块），而这一条只影响「上下文增长」那一块 ——
     * 混进去会让「用量那一半的口径」看起来像坏了，而其实只是另一个第三方插件的行不在。
     * `null` = 这一行**根本没有**（那是常态，措辞由面板给：见 `timelineTextOf` 的那两句），
     * 有值 = 这一行在、但版本不认识 / 是降级占位 / 还没有请求记录 / 形状读不出来。
     */
    timelineNote: string | null;
    session: {
        turns: number | null;
        steps: number | null;
        llmMs: number | null;
        toolMs: number | null;
        ttftMs: number | null;
        ttftSteps: number | null;
        decodeMs: number | null;
        decodeTokens: number | null;
    };
    /** 读的时候发现的口径问题（面板原样显示，一条都不许吞）。 */
    notes: string[];
}

// ---------------------------------------------------------------- 上下文增长曲线（第三方注册的那一行）
//
// 这一节只有两样东西：**一个第三方插件的名字/版本**，以及**面板上那几句话的原文**。
//
// 为什么话术放在 `constants.ts` 而不是面板目录里：面板的 DOM 代码测不了（它要 `Editor`），
// 而这几句话全是判据（哪条是实测、哪条是估算、为什么没画、聚合了没有），必须有已知答案表。
// `constants.ts` 是**零依赖、面板与主进程共用、并且两个体检脚本都已经 require** 的那一份
// （`verify-panel.js` 跑 `formatTokens` 的已知答案就是在这儿），所以它是唯一合适的位置。
//
// ⚠ 面板一律 `textContent` 写入（不解析 markdown），所以下面每一句里都**不许出现 `**`** ——
// 两个星号会原样画在界面上（这一条踩过三次，`verify-panel.js` 有一条机器检查扫面板源码）。

/** `contextTimeline` 那一行的注册者 —— 一个**第三方** bundle（不是 DSH 自带的）。 */
export const CONTEXT_TIMELINE_BUNDLE = 'dsh-context';

/** 本读取器认的**状态版本**（上游 `dsh-context` 的 `stateVersion`）。 */
export const CONTEXT_TIMELINE_STATE_VERSION = 13;

/**
 * 上游的**降级占位**版本。
 *
 * 宿主版本低于那个插件的基线时，它注册的是一份「什么都不折」的 unit：
 * `stateVersion` 钉在 1、状态恒为 `{}`。这时缓存里**有这一行**，但里面没有数据 ——
 * 所以读到的 `ver: 1` + 空值不是「坏了」，而是「宿主太老」，面板上的话也完全不同。
 */
export const CONTEXT_TIMELINE_FALLBACK_VERSION = 1;

/**
 * 超过这么多根柱就**按回合聚合**（一次请求一根柱 + 横向滚动）。
 *
 * 150 这个数来自真数据的分布：`requests` 中位 37 条、p95 322 条、最大 1500 条
 * （撞上宿主的 `maxRequestSteps`）。150 根柱大约是「柱宽 6px、滚两屏扫得完」的量级，
 * 再往上就该按回合看形状了。**聚合只取该回合最后一步，绝不取平均值** ——
 * 平均会把压缩掉的那一截抹平，而那张图的全部价值就在那一截上。
 */
export const CONTEXT_TIMELINE_MAX_BARS = 150;

/**
 * 「实测 prompt ÷ 估算 total」在本机真缓存里的**中位数**（470 份缓存 / 40427 条请求实测）。
 *
 * 这是「主曲线为什么用 prompt 而不是 total」的唯一依据：比值中位 1.34、p95 1.63、
 * 最大 2.69 —— 也就是说只画 `total` 会让人以为上下文占用**远低于真实**（最多低估到 1/2.7）。
 */
export const CONTEXT_TIMELINE_RATIO_MEDIAN = 1.34;

/** 上面那个比值分布的 p95（写进面板的说明里，免得只给一个中位数显得像编的）。 */
export const CONTEXT_TIMELINE_RATIO_P95 = 1.63;

/** 上面那个比值分布的最大值（同一批样本）——「最多低估到 1/2.7」那句话的依据。 */
export const CONTEXT_TIMELINE_RATIO_MAX = 2.69;

/**
 * 「这一行的版本我们不认」那句话（`stats.ts` 与**预览样本**共用同一份原文）。
 *
 * 框架的口径是「`ver` 不匹配就丢掉整行、从日志冷折叠」，**从不迁移** —— 所以这里不猜、
 * 不按旧版本硬读，只如实说：版本是几、只认几。
 *
 * @param ver - 那一行的 `ver`（读不出数值就是 null）。
 */
export function contextTimelineVersionNote(ver: number | null): string {
    return (
        `这一行的版本是 ${ver === null ? '?' : ver}，本读取器只认 ${CONTEXT_TIMELINE_STATE_VERSION}，所以不画这条曲线。` +
        '框架的口径是「版本不匹配就丢掉整行、从日志冷折叠」，它从不迁移旧版本 —— 硬读只会读出一个错的形状。'
    );
}

/**
 * 「宿主低于这个插件的基线」那句话（那个插件自己的降级占位）。
 *
 * @param ver - 读到的 `ver`（正常情况下是 1）。
 */
export function contextTimelineBaselineNote(ver: number | null): string {
    return (
        `宿主版本低于这个插件的基线，这一行是空的（${CONTEXT_TIMELINE_BUNDLE} 的降级占位，ver ${ver === null ? '?' : ver}）` +
        '—— 它把行注册上了但什么都没折，所以这条会话没有曲线可画。升级宿主之后跑的新会话才会有。'
    );
}

/** 「这一行还没有请求记录」那句话（新会话 / 还没发过消息）。 */
export function contextTimelineEmptyNote(): string {
    return `这一行还没有请求记录 —— ${CONTEXT_TIMELINE_BUNDLE} 的要到第一次模型调用才有数据（新会话、或者还没发过消息）。`;
}

/**
 * 「这一行由别人注册，本 profile 不挂它」那一句。
 *
 * 为什么必须说出来：否则用户看到的是「这一块什么都没有」，而**没有这一行是常态** ——
 * `contextTimeline` 由第三方插件注册，本 profile 的 `bundles` 里零第三方
 * （声明了却没装会让整棵树起不来，见 README「花费」一节）。
 * 同时把「缓存目录是共享的」也讲清楚：别的 profile 跑的会话也落在同一个目录里，
 * 所以「这条会话没有这一行」说的是**那次会话是在没挂它的 profile 里跑的**，
 * 而不是「这台机器上没有上下文数据」。
 */
const TIMELINE_REGISTRAR_NOTE =
    `这一行由第三方 ${CONTEXT_TIMELINE_BUNDLE} 注册，本 profile 不挂它，` +
    '所以本面板跑的会话通常没有这条曲线（只有 web/desktop profile 跑的会话才有）。';

/** 上面那句的补充（缓存目录共享这一件事本身）。 */
const TIMELINE_SHARED_CACHE_NOTE =
    '投影缓存目录是同一个 DSH_HOME 共享的（不分 profile）：web / desktop profile 跑的会话也落在同一个目录里，' +
    '所以「这里看不到这一行」与「这条会话没有上下文」是两件事。';

/**
 * 把曲线（含「没有曲线」）变成面板要画的文字。**纯函数**，所以能直接拿已知答案跑。
 *
 * 四种「没有曲线」的话术完全不同，面板不许把它们混成一句：
 * ① 版本不认识（`contextTimelineVersionNote`）；② 宿主低于基线（`contextTimelineBaselineNote`）；
 * ③ 还没有请求记录（`contextTimelineEmptyNote`）；④ **这一行根本不存在** ——
 * 那是**常态**（注册者是第三方、本 profile 不挂它），照实说清并给出「别的 profile 才有」。
 *
 * @param input.timeline - 归一化好的曲线；没有就是 null。
 * @param input.note - `SessionUsage.timelineNote`（**这一行为什么没画出来**）；没有就是 null。
 */
export function timelineTextOf(input: { timeline: ContextTimelineView | null; note: string | null }): TimelineText {
    const { timeline, note } = input;

    if (!timeline) {
        const notes: string[] = [];
        if (note) notes.push(note);
        notes.push(TIMELINE_REGISTRAR_NOTE);
        notes.push(TIMELINE_SHARED_CACHE_NOTE);
        return { headline: null, legend: [], notes };
    }

    /**
     * 头部那一行：**几次调用 + 画几根柱 + 最新一次是多少**。
     *
     * 为什么不写「平均值」：那正是这块最容易编出来的数字（平均一次调用占多少 token）——
     * 而这条曲线的信息全在**形状**上（涨、压缩、再涨），一个平均值会把压缩抹平，
     * 看起来还挺合理（这是这块最不能出现的谎）。
     */
    const last = timeline.lastTokens;
    const lastText =
        last === null
            ? ''
            : ` · 最新一次 ${timeline.lastEstimated ? '估算' : '实测'} ${formatTokens(last)}` +
              (timeline.contextWindow === null
                  ? ''
                  : `（占窗口 ${formatTokens(timeline.contextWindow)} 的 ${((last / timeline.contextWindow) * 100).toFixed(1)}%）`);
    const headline =
        `共 ${timeline.requests} 次模型调用` +
        (timeline.aggregated
            ? `，按回合聚合成 ${timeline.points.length} 根柱（一根柱 = 那个回合的最后一步）`
            : '，一次调用一根柱') +
        lastText;

    const legend: TimelineLegendItem[] = [
        { swatch: 'measured', label: '实心柱 = prompt（provider 实测：输入 + 缓存读 + 缓存写）' },
        { swatch: 'estimated', label: '斜纹柱 = total（按「四字符一个 token」估的）' },
        { swatch: 'cut', label: '✂ 竖线 = 压缩 / 裁剪点（钉在压缩之后的那一根柱上）' },
    ];

    const notes: string[] = [
        '主曲线优先用实测的 prompt、不用估算的 total：真机 470 份缓存 / 4 万多条请求里，' +
            `prompt ÷ total 的中位数是 ${CONTEXT_TIMELINE_RATIO_MEDIAN} 倍（p95 ${CONTEXT_TIMELINE_RATIO_P95}、最大 ${CONTEXT_TIMELINE_RATIO_MAX}）` +
            '—— 只画 total 会让人以为上下文占用远低于真实。',
    ];
    if (timeline.estimatedCount > 0) {
        notes.push(
            `其中 ${timeline.estimatedCount} 根柱没有实测（那几次调用 provider 没报 usage），画的是估算的 total（斜纹）—— 它们不许混进实测里。`,
        );
    }
    if (timeline.aggregated) {
        notes.push(
            `这一行有 ${timeline.requests} 次调用，超过 ${CONTEXT_TIMELINE_MAX_BARS} 根柱就按回合聚合：` +
                '一根柱取那个回合的最后一步，柱宽 = 那个回合的步数。为什么不取平均值 —— 平均会把压缩掉的那一截抹平，而那一截正是这张图要看的东西。',
        );
    }
    if (timeline.dropped > 0) {
        notes.push(
            `有 ${timeline.dropped} 条请求记录认不出来（字段是字符串 / NaN / 负数 / 缺字段），它们被丢掉了 —— 没有为它们补一个 0（补 0 会让曲线看起来「这里很省」）。`,
        );
    }
    if (timeline.archiveFloor !== null) {
        notes.push(
            `这份记录里 archiveFloor = ${timeline.archiveFloor}：seq 小于它的删除记录已经被缓存裁掉了 —— ` +
                '也就是说曲线最左边那一段「上下文为什么变小」已经查不到了，别把它当成「一开始就这么小」。',
        );
    }
    if (timeline.contextWindow === null) {
        notes.push('这份记录里没有窗口上限（contextWindow），所以不画占用率百分比 —— 分母不知道就不补一个。');
    } else {
        notes.push(`占用率的分母来自这一行自己的 contextWindow（${formatTokens(timeline.contextWindow)}），不是面板编的。`);
    }
    if (timeline.cutsTotal === 0) {
        notes.push('这条会话一次压缩 / 裁剪都没发生过（events 里没有 compaction / prune）—— 曲线一路涨就是实情。');
    }
    notes.push(TIMELINE_REGISTRAR_NOTE);

    return { headline, legend, notes };
}

// ---------------------------------------------------------------- 进度
//
// 「这个会话在干什么」的三块：**待办清单**（agent 自己写的工作表）、**目标**（goal 模式）、
// **回合目录**（整个日志的每一轮摘要）。三块都来自 DSH 自己的投影，但**来路分两条**：
//
// - **实时事件**（`todo/write` / `turn/start` / `goal/change`）：精确，但只覆盖面板转写窗口
//   里的那一段（历史回放只读日志尾部的 2000 条事件）；
// - **会话投影缓存**：整个日志折出来的（回合大纲连 600 条窗口之外的轮次都有），但最多
//   落后几条事件（缓存是攒着写的，见 `stats.ts`）。
//
// 合并规则只有一条：**事件优先，缓存补洞**（宿主侧实现，见 `dsh-host.ts` 的 `mergeProgress`）。
// 所以面板拿到的 `ProgressView` 已经是一份成品，不需要自己去猜哪一份更新。

/** 清单里一条的状态（逐字对应 DSH 的 `TodoItem.status`）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 待办清单里的一条（DSH `todo_write` 工具写的整份快照里的一项）。 */
export interface TodoView {
    content: string;
    status: TodoStatus;
}

/** 目标（`goal` 投影 / `goal/change` 事件；面板只画前几项）。 */
export interface GoalView {
    objective: string;
    /** 生命周期阶段；`armed`/`disarmed`（能不能自动续跑）是**进程内**的、不落盘，所以这里没有。 */
    phase: 'active' | 'paused' | 'blocked' | 'complete';
    /** 已经跑了几轮 / 上限几轮。 */
    roundsStarted: number;
    maxGoalRounds: number;
    /** 只在 `phase === 'blocked'` 时有值。 */
    blockedReason: string | null;
    updatedAt: number;
}

/**
 * 回合目录里的一轮（`turnOutline` 的一行 + 宿主给的跳转锚点）。
 *
 * `seq` 是那一轮 `turn/start` 的**事件序号** —— 上游文档明说它就是「往回翻页的目标」
 * （把窗口翻过这个 seq 就包含整轮）。但面板的转写条目号是**宿主自己的计数器**（不是事件序号），
 * 所以真正能用来跳的是 `entrySeq`。
 */
export interface TurnView {
    turn: number;
    /** 用户那一轮的输入预览（上游裁成一行）。 */
    prompt: string;
    /** 那一轮的最终回复预览（上游裁成最多三行）；还没结束就是空串。 */
    response: string;
    /** 面板转写里的条目号；那一轮已经被 600 条上限挤掉时为 null（面板会说清楚，不是静默失败）。 */
    entrySeq: number | null;
    /** 那一轮 `turn/start` 的事件序号（排查用）。 */
    seq: number | null;
}

/**
 * 从**会话投影缓存**里读出来的进度（宿主读盘那一路的原始结果）。
 *
 * ⚠ 这一份是**检查点**：`todos` 可能比面板上真实发生的事旧（缓存攒够 200 条事件或 5 秒才写）。
 * 所以它只用来**补洞**（实时事件没覆盖到的部分），合并与口径由宿主负责。
 */
export interface SessionProgress {
    /** 整份清单；`null` = 这份记录里没有（本轮还没写过，或者从来没写过）。 */
    todos: TodoView[] | null;
    goal: GoalView | null;
    /** 整个日志的回合大纲（含面板窗口之外的轮次，按 turn 升序）。 */
    turns: TurnView[];
    /** 大纲里一共几轮；`turns` 被截断时用它说实话。 */
    turnsTotal: number;
    /** 正在写的那一轮的回复草稿预览（不在轮次内时是空串）。 */
    draft: string;
}

/**
 * 面板上看到的进度（**宿主合并「实时事件」与「检查点」之后的成品**）。
 *
 * 三块的口径各不相同，所以各自带着自己的「这是哪来的」：
 * - `todosSource`：清单是事件给的（准）还是缓存给的（可能旧）；
 * - `todosTurn` / `stale`：清单是**第几轮**写的 —— DSH 的投影口径是「新一轮开始清单归零」，
 *   所以清单所属的轮次比当前轮次旧时，面板必须说「本轮 agent 还没写清单」，
 *   否则用户会把上一轮的表当成现在这一轮在做的事（那是**看板撒谎**，不是小毛病）；
 * - `turns`：大纲是缓存给的（整个日志），`entrySeq` 是事件给的（能不能跳）。
 */
export interface ProgressView {
    todos: TodoView[];
    todosSource: 'events' | 'checkpoint';
    /** 清单是第几轮写的；宿主不知道（缓存那一份不带轮次）时是 null。 */
    todosTurn: number | null;
    /** 清单所属轮次已经过去了（当前轮次里 agent 还没写新的）。 */
    stale: boolean;
    /** 现在在第几轮（`turn/start` 给的）；一次都没开始就是 0。 */
    currentTurn: number;
    goal: GoalView | null;
    turns: TurnView[];
    /** 大纲里一共几轮（缓存记的）；面板据此说明「只列了最近几轮」。 */
    turnsTotal: number;
    /** 正在写的那一轮的回复草稿预览。 */
    draft: string;
    /** 检查点那一半的水位（`turns` / `goal` 的新鲜度）；没有读数时 null。 */
    seq: number | null;
    behind: number | null;
    updatedAt: number;
    /** 口径说明（面板原样显示）。 */
    notes: string[];
}

/** 面板/CLI 看到的 agent 快照。 */
export interface AgentSnapshot {
    status: AgentStatus;
    /** 服务端报的 `running` / `idle`（一个回合进行中吗）。 */
    running: boolean;
    sessionId: string | null;
    /** 这个 sessionId 是怎么来的：SDK 新建 / 插件 resume / 只读历史。 */
    sessionKind: SessionKind;
    /** 非空表示对话区正在显示一条历史会话（面板据此挂横幅）。 */
    history: HistoryView | null;
    /** 转写代数（换会话会 +1）。 */
    generation: number;
    /** 子进程 pid（没起就是 null）。 */
    pid: number | null;
    /** 启动耗时（毫秒），用于解释「第一次为什么慢」。 */
    lastBootMs: number | null;
    /** 最近一次错误（启动失败、进程崩了、协议报错）。 */
    lastError: string | null;
    /** 转写条数（面板不需要全量时用它判断有没有新内容）。 */
    entryCount: number;
    revision: number;
    /** 正在等人类拍板的交互（模型提问 / 授权请求 / 计划评审）；一般为空数组。 */
    interactions: InteractionView[];
    /**
     * 当前会话的标题；没有（还没到第一条合格输入）时是 null。
     *
     * 来源是会话日志里的 `session/title` 事件 —— 它是**仅写日志**的，不进模型上下文。
     * 两条提供方：`dsh-session-title` 的确定性回退（首条用户消息的头几个词），
     * 以及本 profile 重新启用的 `session-title-llm`（模型生成，异步追上，较新者胜出）。
     */
    title: string | null;
    /**
     * 当前会话的用量（从 DSH 的会话投影缓存读的）。
     *
     * `null` = 还没有读数（agent 没起过、会话还没落过检查点）或读失败；
     * 失败原因在 `usageNote` 里 —— **「读失败」与「没有用量」在面板上是两句话**。
     */
    usage: SessionUsage | null;
    /** 用量读失败 / 没读数时的一句话（成功时为 null）。 */
    usageNote: string | null;
    /**
     * 当前会话的进度（清单 / 目标 / 回合目录）。
     *
     * 与 `usage` **分开**的理由：两者的**更新时机**完全不同 —— 用量是回合结束才刷的检查点
     * 读数（一轮里数字本来就不怎么动），而清单是 agent 每调一次 `todo_write` 就到的实时事件，
     * 顺序、频率、新鲜度都不是一回事。合成一份的话面板只能整块重画，而重画时用的是**另一块**
     * 的旧值（清单来了会把用量抽屉里的旧数字再画一遍，反之亦然）。
     */
    progress: ProgressView | null;
    /** 进度那一份的口径说明 / 没有时的原因。 */
    progressNote: string | null;
    /** 解析出来的 node / dsh 路径，面板上显示出来便于排查。 */
    runtime: { nodeExe: string | null; dshBin: string | null; nodeSource: string; dshSource: string };
    /** 子进程 stderr 的尾巴（诊断用，不进上下文）。 */
    stderrTail: string[];
}

/**
 * 一次「需要人拍板」的交互（面板上那块可应答的对话框）。
 *
 * 字段名**逐字对应 DSH 的契约**，改一个就要改两处（`@deepseek-ai/dsh-user-questions`
 * 的 `AskUserQuestionItem`、`@deepseek-ai/dsh-user-approval` 的 `ApprovalRequestEvent`）。
 * 面板只负责画 + 收集答案，**不做任何语义判断**（哪种交互怎么画由 `kind` 决定）。
 */
export interface InteractionView {
    /** 插件发的交互 id（回答时要原样带回去）。 */
    id: string;
    kind: InteractionKind;
    /** 发起时刻（插件侧的时钟）。 */
    at: number;
    /** 谁在问（Agent 的 id；跨 IPC 只投影字符串）。 */
    agentId?: string;
    /** 在哪个会话里问的（面板据此判断「是不是当前这条会话」）。 */
    sessionId?: string;

    // ---- kind === 'question'（含计划评审：它只是带 intent 的一道题）----
    /** 要问的问题（一般 1 个；`ask_user_question` 也允许多个）。 */
    questions?: InteractionQuestion[];

    // ---- kind === 'approval' ----
    /** 需要授权的工具名。 */
    toolName?: string;
    /** 对应的工具调用 id（能据此在转写里找到那张卡片）。 */
    callId?: string;
    /** 提问方给的理由（hook / 权限策略写的）。 */
    reason?: string;
}

/** 交互种类。`question` = 模型提问或计划评审；`approval` = 授权请求。 */
export type InteractionKind = 'question' | 'approval';

/** 一个可选项（`AskUserQuestionOption`）。 */
export interface InteractionQuestionOption {
    label: string;
    description?: string;
}

/** 一道题（`AskUserQuestionItem`）。 */
export interface InteractionQuestion {
    id: string;
    question: string;
    /** 附带的细节（计划评审时**就是那份计划 markdown**）。 */
    detail?: string;
    /** 短标题/分组名。 */
    header?: string;
    options?: InteractionQuestionOption[];
    /** 能不能多选（默认单选）。 */
    multiSelect?: boolean;
    /**
     * 展示意图。`plan-review` 时 `approve` 指出**哪个选项是「批准」** ——
     * 命名而不是按位置，所以面板不许自己猜顺序。
     */
    intent?: { kind: string; approve: string };
}

/** 一道题的答案（`AskUserQuestionAnswerItem`）。 */
export interface InteractionAnswerItem {
    id: string;
    /** 选中的选项 label（可能是空的，只写了自定义回答）。 */
    selected: string[];
    /** 自定义回答（「其他…」）。 */
    custom?: string;
}

/** 授权结果（`ApprovalOutcome`，运行时自己的词表；只有 `allowed-once` 是授予）。 */
export type InteractionApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';

/** 面板 → 主进程 → 插件 的一次作答。 */
export interface InteractionDecision {
    /** 要回答哪一次交互。 */
    id: string;
    /**
     * 怎么答：
     * - `answer` —— 给了答案（问答题带 `answers`，授权带 `outcome`）；
     * - `dismiss` —— 关掉不答（提问 = 抢话`ASK_CANCELLED`；授权 = `cancelled`）；
     * - `delegate` —— 交给下一个应答者（最终等于「没人回答」，授权会失败关闭）。
     */
    action: 'answer' | 'dismiss' | 'delegate';
    /** `action === 'answer'` 且是问答题时的答案。 */
    answers?: InteractionAnswerItem[];
    /** `action === 'answer'` 且是授权时的结果。 */
    outcome?: InteractionApprovalOutcome;
}
