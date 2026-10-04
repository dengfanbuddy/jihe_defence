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
    getSettings: 'get-settings',
    updateSettings: 'update-settings',
    installProfile: 'install-profile',
    panelProbe: 'panel-probe',
    /** 列工程里的图片（面板的图片选择器）。 */
    listImages: 'list-images',
    /** 读一张工程图片（转成 base64 回给面板做缩略图/发送）。 */
    readImage: 'read-image',
} as const;

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
    /** 面板外观：跟随系统 / 强制深色 / 强制浅色。 */
    theme: PanelTheme;
    /** 面板正文字号（px，12~17）；0 = 用 token 默认的 14。 */
    fontSize: number;
}

/** 面板外观。`auto` = 能认出编辑器主题就跟编辑器，认不出跟系统。 */
export type PanelTheme = 'auto' | 'dark' | 'light';

/** 广播载荷（`HostUpdate` 的面板侧视图）。 */
export interface HostUpdateView {
    entries: Entry[];
    revision: number;
    /** 转写「第几代」—— 清空/换成另一个会话时 +1，面板据此丢掉旧条目（见 `resetTranscript`）。 */
    generation: number;
    status: AgentStatus;
    running: boolean;
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
    /** 解析出来的 node / dsh 路径，面板上显示出来便于排查。 */
    runtime: { nodeExe: string | null; dshBin: string | null; nodeSource: string; dshSource: string };
    /** 子进程 stderr 的尾巴（诊断用，不进上下文）。 */
    stderrTail: string[];
}
