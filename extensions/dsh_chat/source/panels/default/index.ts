/**
 * DSH 对话面板（渲染进程）。
 *
 * ## 它是什么
 *
 * 停靠在 Inspector 旁边的一个聊天框：说的每句话交给主进程托管的那只 DSH agent，
 * agent 又能通过 `cocos_execute_code` 直接操作**你正开着的这个编辑器**。
 *
 * ## 观感口径：抄 DSH，不嵌 DSH
 *
 * 曾评估过「把 `dsh web` 用 iframe 嵌进面板」—— 否决。理由是硬的：那套前端是
 * webserver + WS + 客户端模块动态加载的一整套 host（web profile 有 57 个插件），
 * 嵌进来就等于再起一份 agent（会话、设置、工具全分家），而且它的 CSS 里
 * **一条响应式媒体查询都没有**（只有 prefers-reduced-motion），三栏应用塞进
 * 面板宽度必然挤。所以走「面板自绘 + 抄它的设计系统」：
 *
 * 1. **设计 token 直接抽**：`static/style/default/dsw-tokens.css` 由
 *    `scripts/extract-dsw-tokens.js` 从 `@deepseek-ai/dsh-client-ui-theme` 里抠出来
 *    （色板 → 语义别名、明暗两套、字号阶梯、elevation、滚动条），一条不手抄；
 * 2. **渲染模型照抄**：用户气泡 / 助手 markdown / 折叠的思考块 / 按工具名分类的工具卡片
 *    （见 `tool-card.ts`）/ 四态与耗时 / 代码块带 banner 与复制 —— 这些正是 DSH web 客户端
 *    的对话区在做的事，而我们吃的是**同一条事件流**（`SessionEventLikeEntry`）。
 *
 * ## 五条实现口径
 *
 * 1. **零依赖**：不引 Vue/React，只用 DOM。多出来的两个兄弟文件（`markdown.ts` /
 *    `tool-card.ts`）用相对 require 引（面板 dist 是 CommonJS，能解析同级文件）。
 * 2. **元素一律走 `Editor.Panel.define` 的 `$` 选择器**（`ctx.$.xxx`）。
 *    ⚠ **踩过的坑**：`document.getElementById('banner')` 在这个环境里**返回 null**（模板不在
 *    普通文档树里，`getElementById` 找不到），而 `$` 是编辑器在面板子树里解析的、可靠。
 *    第一版用 `getElementById` 拿状态点/横幅 → 一进面板 `refreshState` 就抛
 *    `Cannot set properties of null (setting 'textContent')`，整块 UI 其实是死的。
 *    **结论：面板里不要用 `document.getElementById/querySelector` 找面板元素。**
 *    （元素**内部**查询可以：`element.querySelector('.dsh-think')` 是拿在自己手里的子树。）
 * 3. **两条更新路**：主进程广播（`dsh_chat:event`，快） **+** 轮询 `get-events`（稳）。
 *    两条路都并进同一份 `Map<seq, Entry>`，靠 `seq` / `rev` 幂等。
 * 4. **只重绘变化的条目**：`seq → 元素` 一一对应，流式增量原地替换该条目的内容，
 *    不整屏重排（否则输入焦点和滚动位置都会跳）。展开/收起这类**交互状态**另存在
 *    `Map<seq, boolean>` 里，跨重绘保留。
 * 5. **取不到元素也只 warn 不抛，并把自检报给主进程**（`panel-probe`）：面板抛错会污染
 *    编辑器控制台，而用户拿不到任何可用信息；自检回传让「面板里到底怎么了」能被外部读到。
 *
 * ## 路径口径
 *
 * 编译产物在 `dist/panels/default/index.js`，所以静态资源从 `__dirname` 往上三级回扩展根，
 * 再进 `static/`。改目录结构时这几个 join 要一起改。
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    BROADCAST_CHANNEL,
    EXTENSION_NAME,
    MSG,
    PROFILE_NAME,
    type ActivityView,
    type AgentSnapshot,
    type AgentStatus,
    type CommandView,
    type ContextTimelineView,
    type DshChatSettings,
    type Entry,
    type EntryImage,
    type HistorySearchHitView,
    type HistorySessionView,
    type HostUpdateView,
    type ImageMimeType,
    type InteractionAnswerItem,
    type InteractionDecision,
    type InteractionView,
    type JobView,
    type PanelTheme,
    type ReferenceCandidate,
    type SessionUsage,
    type ProgressView,
    type SubagentView,
    type TimelinePointView,
    type TodoView,
    type TurnView,
    formatDuration,
    formatTokens,
    timelineTextOf,
} from '../../constants';
import {
    IMAGE_MIME_BY_EXT,
    MAX_IMAGE_BYTES,
    MAX_IMAGES_PER_MESSAGE,
    MAX_LISTED_IMAGES,
    filterProjectImages,
    formatBytes,
    type ProjectImage,
} from '../../images';
import { renderMarkdown } from './markdown';
import { activeAtToken, commandDraft, formatFileMention, lineAt, replaceToken } from './mention';
import { GOAL_PHASE_TEXT, TODO_MARK, progressChipText, todoCounts, turnHeadHint } from './progress';
import { costTextOf } from './cost';
import { createToolCard, defaultOpen } from './tool-card';

/** 静态资源根。 */
const STATIC_ROOT = join(__dirname, '../../../static');

/** 从扩展根读一份静态文件。 */
function readStatic(relativePath: string): string {
    return readFileSync(join(STATIC_ROOT, relativePath), 'utf-8');
}

/**
 * 面板样式 = **token 层 + 组件层 + 配色覆盖层**。
 *
 * token 层是脚本从已安装的 DSH 里抽出来的（见 `scripts/extract-dsw-tokens.js`），
 * 组件层是手写的、只消费 token。分开的理由：DSH 升版本时重跑脚本即可，
 * 手写的组件样式不会被覆盖。
 *
 * 第三份 `editor-theme.css` 是**只重定义变量**的配色覆盖（`palette = editor` 时生效）——
 * 它不能写进 token 层（那份是生成物，会被整份覆盖），也不该混进组件层（那层零硬编码色）。
 */
function readStyle(): string {
    return `${readStatic('style/default/dsw-tokens.css')}\n${readStatic('style/default/index.css')}\n${readStatic(
        'style/default/editor-theme.css',
    )}`;
}

/**
 * ⚠ **两条路的地位**（踩过的坑，见文件头第 3 条）：轮询是**主路**，广播是加速。
 * 面板**必须自己在 `mount` 里把轮询起起来** —— 曾经只挂在 `listeners.show` 上，
 * 结果那个钩子没在 `ready` 之后触发，轮询根本没跑，症状是「上一轮的回复要等下一次发送
 * 才整段冒出来」（`send()` 里那次 `pollOnce` 成了唯一的刷新点）。
 * 空闲 800ms、跑动 300ms：跑动时密一点流式才顺（模型实测 ~200 字/250ms）。
 */
const POLL_INTERVAL_MS = 800;

/** 跑动时的轮询间隔（毫秒）。 */
const POLL_INTERVAL_ACTIVE_MS = 300;

/** 每几次轮询顺带刷一次状态（比拉转写贵一点）；有新条目时当轮就刷。 */
const STATE_EVERY_TICKS = 5;

/** 草稿存在浏览器本地（按扩展名分键），面板关掉再开不丢。 */
const DRAFT_KEY = `${EXTENSION_NAME}:draft`;

/**
 * 图片的四个预算数字（**与 `source/images.ts` / DSH 附件库同口径**，只有这一处改）。
 *
 * | 数字 | 为什么是这个值 |
 * |---|---|
 * | `maxPixels` 2048×2048 | DSH 归一化后就是这个预算（`normalizedImageMaxPixels`）。**面板先缩到位**，别把 4K 截图整个塞进 IPC 再让它缩 —— 那是十几 MB 的字符串，面板和子进程都要白扛一遍 |
 * | `maxSide` 4096 | 极端长条图（2700×20000 的截图）按像素预算缩完还剩很长的边，再夹一道 |
 * | `normalizedMaxBytes` 4MB | DSH 归一化后的编码目标（`normalizedImageMaxBytes`）。超了就往下走 webp / JPEG 质量梯子（见 `encodeCanvas`） |
 * | `thumbSide` 128 | 输入区/选择器里的缩略图边长，只影响观感与内存 |
 */
const IMAGE_BUDGET = {
    maxPixels: 2048 * 2048,
    maxSide: 4096,
    normalizedMaxBytes: 4 * 1024 * 1024,
    thumbSide: 128,
} as const;

/** JPEG 质量梯子（依次试，取第一个进预算的）。只在「PNG 太大」或源本来就是 JPEG 时用。 */
const JPEG_LADDER = [0.92, 0.8, 0.7, 0.6];

/** 选择器里最多同几路读图（每张都是一次 IPC + 一次解码，并发高了面板会卡）。 */
const THUMB_CONCURRENCY = 3;

/** 缩略图缓存条数上限（每条是一个小 data URL，几十 KB 级别）。 */
const THUMB_CACHE_LIMIT = 200;

/**
 * 提示条的**最短停留时间**（毫秒）—— 见 `setBanner` 的 `holdMs`。
 *
 * 分开两档的理由：错误要读到（12s 够看清、又不会一直挂在那儿），
 * 而「已经在列表里了」这类确认信息 4 秒足够。
 */
const BANNER_HOLD = { INFO: 4000, ERROR: 12_000 } as const;

/** 状态点/文案。 */
const STATUS_TEXT: Record<AgentStatus, string> = {
    stopped: '未启动',
    installing: '准备 profile…',
    starting: '启动中…',
    ready: '就绪',
    stopping: '停止中…',
    error: '出错',
};

/** 外观按钮上的三档循环（title 用）。 */
const THEME_CYCLE: PanelTheme[] = ['auto', 'dark', 'light'];
/**
 * ⚠ 文案要跟**行为**一致：`auto` 的实际行为是「能认出编辑器主题就跟编辑器，认不出才跟系统」
 * （`resolveTheme`），原来写的是「跟随系统」—— 那是把回落档当成了主档，实测对不上。
 */
const THEME_LABEL: Record<PanelTheme, string> = { auto: '跟随编辑器', dark: '深色', light: '浅色' };
const THEME_GLYPH: Record<PanelTheme, string> = { auto: '◐', dark: '●', light: '○' };

/** 主进程返回的状态包。 */
interface StateReply {
    ok: boolean;
    extension?: { name: string; version: string; root?: string };
    agent?: AgentSnapshot;
    settings?: DshChatSettings;
    /** 最近一次把 `dsh-profile/` 同步到 `$DSH_HOME` 的结果。 */
    profile?: { ok: boolean; profileDir?: string; version?: string; changes?: string[]; error?: string };
    /** 面板自检历史（主进程收的，见 `panelProbe`）。 */
    panel?: Array<{ at: number; data: Record<string, unknown> }>;
}

/**
 * 输入区里**待发送**的一张图。
 *
 * 与 `constants.ts` 的 `SendImage` 的区别：那一个是「协议上真正会传出去的东西」（两个字段），
 * 这一个还带着面板自己要用的东西 —— 缩略图、像素尺寸、来源。**多出来的字段一律不进 IPC 的图**。
 */
interface Attachment {
    /** 面板本地身份（去重/删除用；同名的两张剪贴板图不能互相顶掉）。 */
    id: string;
    /** 显示名（工程图是文件名，剪贴板图是「剪贴板图片-1.png」）。 */
    name: string;
    mimeType: ImageMimeType;
    /** **规范** base64（无 `data:` 前缀、无换行）—— 附件库的解码器只认这一种。 */
    data: string;
    /** 解码后的字节数。 */
    bytes: number;
    width: number;
    height: number;
    /** 小图 data URL（只用于显示）。 */
    thumb: string;
    origin: 'clipboard' | 'project' | 'drop';
    /** 归一化时做过什么（「已缩到 2048×1152」「PNG → JPEG」），显示在碎片上给人一个交代。 */
    note?: string;
}

/** 一次面板实例的全部可变状态。元素引用全部来自 `$`（见文件头第 2 条）。 */
interface UiState {
    root: HTMLElement | null;
    dot: HTMLElement | null;
    title: HTMLElement | null;
    sub: HTMLElement | null;
    banner: HTMLElement | null;
    settingsHost: HTMLElement | null;
    body: HTMLElement;
    input: HTMLTextAreaElement;
    sendButton: HTMLButtonElement | null;
    live: HTMLElement | null;
    meta: HTMLElement | null;
    els: Map<number, HTMLElement>;
    entries: Map<number, Entry>;
    /** 展开/收起：工具卡片与思考块（按 seq 记，跨重绘保留）。 */
    openTools: Map<number, boolean>;
    collapsedThink: Map<number, boolean>;
    maxRev: number;
    maxSeq: number;
    /**
     * 转写代数 —— 主进程那边 `resetTranscript()` 会 +1（换会话、回放历史）。
     *
     * 面板只按 `rev` 取增量，「某条被删掉」这件事表达不出来，所以清空必须有独立记号：
     * 代数对不上就**整块重画**（而不是把新旧条目混在一起）。
     */
    generation: number;
    tick: number;
    /** 下一轮轮询的定时器（自调度：跑动/空闲用不同间隔）。 */
    timer: ReturnType<typeof setTimeout> | null;
    /** 是否在轮询（`timer` 只是当前这一跳，用它表达「开着/停了」）。 */
    polling: boolean;
    /** 只在第一次 resume 时回传一次自检，免得刷屏。 */
    reportedResume: boolean;
    snapshot: AgentSnapshot | null;
    settings: DshChatSettings | null;
    settingsOpen: boolean;
    /** 历史会话抽屉是否打开。 */
    historyOpen: boolean;
    startRequested: boolean;
    /**
     * 已经发出「停止本轮」、但 `turn/end` 还没到的那一段。
     *
     * 为什么要记：`Agent.cancel()` 是**请求**不是即时生效 —— 模型会把已经生成的那一小段
     * 吐完、在飞的工具调用也可能再回一条结果，这期间 `running` 仍是 true。
     * 不记这个标志的话按钮会立刻恢复可点，用户连点几下等于重复发取消请求。
     */
    interrupting: boolean;
    /**
     * 提示条的最短停留截止时刻（见 `setBanner` 的 `holdMs`）。
     * `refreshState` 里那句「没事就把横幅收起来」要先问过它。
     */
    bannerUntil: number;
    emptyEl: HTMLElement | null;
    typingEl: HTMLElement | null;
    /** 上一个出现的用户消息 seq（用来在回合之间拉分隔线）。 */
    lastUserSeq: number;
    /** 历史会话抽屉与「继续此会话」横幅（元素见 static/template/default/index.html）。 */
    historyBar: HTMLElement | null;
    historyBarText: HTMLElement | null;
    history: HTMLElement | null;
    historyList: HTMLElement | null;
    historyNote: HTMLElement | null;
    /** 抽屉里的标题筛选框（Enter = 搜全文，Esc = 回列表）。 */
    historySearchEl: HTMLInputElement | null;
    /** 「搜全文」按钮（搜索中显示「搜索中…」并禁用 —— 连点会开好几个 node 进程）。 */
    btnHistorySearch: HTMLButtonElement | null;
    /** 「返回列表」按钮（只在搜索结果里出现）。 */
    btnHistoryBack: HTMLButtonElement | null;
    /** 「刷新」按钮（搜索中一并禁用）。 */
    btnHistoryRefreshEl: HTMLButtonElement | null;
    resumeButton: HTMLButtonElement | null;
    /**
     * 历史抽屉里的搜索框当前的文本（**只筛标题/id**，纯本地，即时生效）。
     *
     * 与 `historySearch` 分开的理由：这是「在手边这几条里找」，那是「在磁盘上所有会话里找」。
     * 前者零成本、后者有预算，混成一个控件会让人分不清「为什么刚才秒出、这次要等两秒」。
     */
    historyQuery: string;
    /** 上一次列表接口给回来的会话（重画时要它，不然每次改搜索词都要重读磁盘）。 */
    historySessions: HistorySessionView[];
    /** 全文搜索的结果；非 null 表示抽屉现在显示的是**搜索结果**而不是列表。 */
    historySearch: HistorySearchState | null;
    /** 正在跑一次全文搜索（按钮要禁用，不然连点会开好几个进程）。 */
    historyBusy: boolean;
    /** 正在等二次确认删除的那条会话（存 dry-run 报出来的清单）。 */
    historyConfirm: HistoryConfirmState | null;
    /** 回放完要滚过去的**转写条目号**（全文搜索命中时由主进程换算好给回来）。 */
    jumpTo: number | null;
    /** 高亮那个定时器（4 秒后把标记摘掉）。 */
    jumpTimer: ReturnType<typeof setTimeout> | null;
    // ---- 用量（token / 上下文占用）----
    /** 用量抽屉是否打开。 */
    usageOpen: boolean;
    /** 抽屉本体（`#usage`）。字段名带 Host 后缀，免得与快照里那份 `usage`（数字）看混。 */
    usageHost: HTMLElement | null;
    /** 抽屉里的内容宿主（每次重画都清空重建 —— 内容是「读一次的答案」，没有需要保住的状态）。 */
    usageBody: HTMLElement | null;
    /** 抽屉头部那行提示（读失败 / 还没读数时的原因；成功时写数据来源与水位）。 */
    usageNoteEl: HTMLElement | null;
    /** 状态行那颗「上下文 xx%」；没数据时整颗藏起来。 */
    usageChip: HTMLButtonElement | null;
    /** 抽屉头部的「刷新」（读的时候禁用，连点会读好几遍盘）。 */
    btnUsageRefreshEl: HTMLButtonElement | null;
    /**
     * 正在等一次**读数**（用量 + 进度是同一次读盘，所以两个抽屉共用这一个闸）。
     *
     * 为什么合成一个闸：两个抽屉的「刷新」打的是**同一个**主进程方法，主进程那边就是
     * 读一遍同一个文件。分成两个闸的话，两个抽屉都开着时连点两下会读两遍同一个文件，
     * 而且两份回执的新旧可能交错（面板上就会出现「用量是新的、清单是旧的」）。
     */
    usageBusy: boolean;
    // ---- 进度（待办清单 / 目标 / 回合目录）----
    /** 进度抽屉是否打开。 */
    progressOpen: boolean;
    /** 抽屉本体（`#progress`）。 */
    progressHost: HTMLElement | null;
    /** 抽屉里的内容宿主（每次重画都清空重建）。 */
    progressBody: HTMLElement | null;
    /** 抽屉头部那行提示（读失败的原因 / 数据来源与水位）。 */
    progressNoteEl: HTMLElement | null;
    /** 状态行那颗「待办 x/y」；没有清单时整颗藏起来。 */
    progressChip: HTMLButtonElement | null;
    /** 抽屉头部的「刷新」（两个抽屉打的是**同一个**主进程方法，所以也都是一次读盘）。 */
    btnProgressRefreshEl: HTMLButtonElement | null;

    // ---- 活动（后台任务 jobs / 子 agent subagents）----
    /** 活动抽屉是否打开。 */
    activityOpen: boolean;
    /** 抽屉本体（`#activity`）。 */
    activityHost: HTMLElement | null;
    /** 抽屉里的内容宿主（每次重画都清空重建）。 */
    activityBody: HTMLElement | null;
    /** 抽屉头部那行提示（读到几点的 / 服务没挂的原因）。 */
    activityNoteEl: HTMLElement | null;
    /** 状态行那颗「后台 x · 子 y」；**没事时整颗藏起来**。 */
    activityChip: HTMLButtonElement | null;
    /** 抽屉头部的「刷新」。 */
    btnActivityRefreshEl: HTMLButtonElement | null;
    /**
     * 最近一次读到的活动那一份（`null` = 还没读过）。
     *
     * ⚠ 它**不在 `AgentSnapshot` 里**，与用量/进度那两块刻意不同：那两个来自磁盘上的检查点缓存
     * （主进程顺手读一次就能塞进状态快照），而这两块只活在运行时进程的内存里，
     * 要**专门打一条控制帧**去问 —— 所以由面板自己决定什么时候问（打开抽屉 / 跑动中按节流问）。
     */
    activity: ActivityView | null;
    /** 上一次问活动的时刻（节流用；这两个服务没有变化通知可订阅，只能问）。 */
    activityAt: number;
    /** 正在等一次活动回执（避免叠着问）。 */
    activityBusy: boolean;
    /**
     * 抽屉头部那句话（**读不出来 / 没起 agent** 的原因）。
     *
     * 为什么单独一个字段而不是直接写进 DOM：那句话原本是「读的时候写进元素、画的时候再从
     * 元素里读回来」—— 那是**读自己的 DOM 当状态**，一旦 `renderActivity` 先跑一步就会把
     * 它当空的重画一遍（症状是原因那句时有时无）。状态归状态、DOM 归 DOM 是这面板的老规矩。
     */
    activityNote: string | null;

    broadcastHandler: ((update: unknown) => void) | null;

    // ---- 交互（模型的提问 / 授权请求 / 计划评审）----
    /** 承载交互卡片的容器（模板里的 `#interaction`）。 */
    interactionHost: HTMLElement | null;
    /** 主进程报的、当前在等的交互（整份快照，不是增量）。 */
    interactions: InteractionView[];
    /**
     * 已经提交过回答的交互 id。
     *
     * 提交到卡片消失之间有一小段（主进程 → 插件 → 回执 → 广播），这段时间按钮必须禁用，
     * 否则连点两下会发两次回答（第二次会被插件当竞态拒掉，但用户看到的是"点了没反应"）。
     */
    interactionSent: Set<string>;
    /**
     * 上一次画出来的交互「签名」。
     *
     * **为什么要有它**：`refreshState` 每 800ms（跑动时 300ms）就会跑一次，而面板的交互块里
     * 有单选框状态和**正在输入的自定义回答** —— 每次都重建 DOM 会把用户刚敲的字抹掉。
     * 签名没变就一个字节都不动（只由 `interactionSent` 与交互集合本身决定）。
     */
    interactionSig: string;

    // ---- 输入触发器（`/` 斜杠命令 · `@` 路径引用）----
    /** 承载弹出块的容器（模板里的 `#popup`）。 */
    popup: HTMLElement | null;
    /**
     * 弹出块现在是哪种：`command` = 斜杠命令表，`mention` = `@` 路径候选，`null` = 关着。
     *
     * 两种共用一个容器（同一时刻不会有第二种）、共用一个键盘协议（↑↓ 选、Enter/Tab 认、
     * Esc 关），所以用一个字段而不是两个 bool。
     */
    popupKind: 'command' | 'mention' | null;
    /**
     * 弹出块里**当前这份**候选（画出来的是它，也是 ↑↓ 与 Enter 作用的那个数组）。
     *
     * 每一项自己带 `apply()`：命令的 apply 是「把命令行填进输入框」，
     * 路径的 apply 是「替换光标处那个 token」。这样键盘与鼠标两条路走的是同一段代码。
     */
    popupItems: Array<{ label: string; detail: string; disabled?: boolean; apply: () => void }>;
    /** 键盘高亮的候选下标。 */
    popupIndex: number;
    /**
     * 命令表（**按会话缓存**：命令是按 agent 查的，换会话要重拉）。
     *
     * `null` = 还没拉过。拉失败会留一条空数组 + 横幅（不反复重试，否则每敲一个字符
     * 就往主进程打一发）。
     */
    commands: CommandView[] | null;
    /**
     * `@` 候选的缓存：查询串 → 候选。
     *
     * 为什么要有：`@` 补全**每敲一个字符就查一次**，而提供方的第一次「裸查询」要把
     * 整个工作区索引一遍。同一个查询串重复问没有意义（比如退格再打回来）。
     */
    mentionCache: Map<string, ReferenceCandidate[]>;
    /** 在飞的那次 `@` 查询的序号：回来时对不上就丢掉（防旧结果盖新结果）。 */
    mentionSeq: number;

    // ---- 图片（粘贴剪贴板 / 从工程里选）----
    /** 待发送的图片（发送成功才清空；失败留着让用户重试）。 */
    attachments: Attachment[];
    /** 输入区上方那排碎片。 */
    attachHost: HTMLElement | null;
    imageButton: HTMLButtonElement | null;
    /** 正在归一化（解码 + 缩放 + 编码）的图片数 —— 大于 0 时按钮转圈、回车不抢发。 */
    imageBusy: number;
    /** 图片选择器（工程图片浏览器）。 */
    picker: HTMLElement | null;
    pickerList: HTMLElement | null;
    pickerNote: HTMLElement | null;
    pickerSearch: HTMLInputElement | null;
    pickerOpen: boolean;
    /** 工程图片清单（打开选择器时拉一次，之后缓存在面板里；`refresh` 强制重拉）。 */
    pickerImages: ProjectImage[] | null;
    /** 这份清单是从哪来的（`asset-db` = 资源库，`scan` = 扫目录兜底）。 */
    pickerSource: string;
    /** 选择器里的搜索词（跨重绘保留）。 */
    pickerQuery: string;
    /** 缩略图缓存：图片路径 → data URL（选择器关掉再开不重读）。 */
    pickerThumbs: Map<string, string>;
    /** 读不出缩略图的路径（别反复重试，否则滚动一次就刷一串 IPC）。 */
    pickerFailed: Set<string>;
    /** 正在读的路径（去重）。 */
    pickerLoading: Set<string>;
    /** 等待读缩略图的队列（见 `THUMB_CONCURRENCY`）。 */
    pickerQueue: Array<{ image: ProjectImage; target: HTMLImageElement }>;
    /** 可见即加载（长清单里只读眼前这几张）。 */
    pickerObserver: IntersectionObserver | null;
    /**
     * 刚发出去的那几张图的缩略图（名字 → data URL）。
     *
     * 只为了让**自己那条用户消息**里显示真图：转写里只有元数据（见 `EntryImage`），
     * 而「我刚才贴的是哪张」这件事必须一眼能确认。只留最近 12 张，FIFO 淘汰。
     */
    sentThumbs: Map<string, string>;
}

const uiByPanel = new WeakMap<object, UiState>();

/**
 * 所有活着的面板实例。
 *
 * 存在理由：`listeners.show/hide` 收到的 `this` 偶尔对不上 `ready` 那次（或钩子先于 `ready` 到达），
 * 这时按 `this` 查 WeakMap 会**静默失败**。只有一个面板实例时（常态）直接作用在它身上更可靠。
 */
const liveStates = new Set<UiState>();

/** 找到钩子该作用的面板状态：先按 `this`，再退到「唯一实例」。 */
function resolveState(self: object): UiState | null {
    const direct = uiByPanel.get(self);
    if (direct) return direct;
    if (liveStates.size === 1) return [...liveStates][0];
    return null;
}

/**
 * 面板元素的选择器表 —— **唯一真源**：`$` 表与兜底补查都用它。
 *
 * 加元素时只改这里（外加 `static/template/default/index.html`）。
 */
const SELECTORS: Record<string, string> = {
    root: '.dsh-root',
    dot: '#dot',
    title: '#title',
    sub: '#sub',
    banner: '#banner',
    settings: '#settings',
    body: '#body',
    input: '#input',
    btnSend: '#btn-send',
    /** 「停止本轮」：只在 `running` 时可见（见 `refreshState`）。 */
    btnInterrupt: '#btn-interrupt',
    btnNew: '#btn-new',
    btnStop: '#btn-stop',
    btnRestart: '#btn-restart',
    btnHistory: '#btn-history',
    btnResume: '#btn-resume',
    historyBar: '#history-bar',
    historyBarText: '#history-bar-text',
    history: '#history',
    historyList: '#history-list',
    historyNote: '#history-note',
    historySearch: '#history-search',
    btnHistoryClose: '#btn-history-close',
    btnHistoryRefresh: '#btn-history-refresh',
    btnHistorySearch: '#btn-history-search',
    btnHistoryBack: '#btn-history-back',
    btnSettings: '#btn-settings',
    btnTheme: '#btn-theme',
    live: '#live',
    meta: '#meta',
    // 用量：状态行那颗 chip + 抽屉
    btnUsage: '#btn-usage',
    usage: '#usage',
    usageBody: '#usage-body',
    usageNote: '#usage-note',
    btnUsageRefresh: '#btn-usage-refresh',
    btnUsageClose: '#btn-usage-close',
    // 进度（待办清单 / 目标 / 回合目录）：同样是「状态行一颗 chip + 一个抽屉」
    btnProgress: '#btn-progress',
    progress: '#progress',
    progressBody: '#progress-body',
    progressNote: '#progress-note',
    btnProgressRefresh: '#btn-progress-refresh',
    btnProgressClose: '#btn-progress-close',
    // 活动（后台任务 / 子 agent）：同样是「状态行一颗 chip + 一个抽屉」
    btnActivity: '#btn-activity',
    activity: '#activity',
    activityBody: '#activity-body',
    activityNote: '#activity-note',
    btnActivityRefresh: '#btn-activity-refresh',
    btnActivityClose: '#btn-activity-close',
    /** 交互块（模型的提问 / 授权请求 / 计划评审）：内容由 `renderInteractions` 现建。 */
    interaction: '#interaction',
    /**
     * 输入触发器弹出块（`/` 命令表 与 `@` 路径候选共用一块）。
     *
     * 与历史抽屉 / 选择器同一个摆法：`.dsh-root` 的直接子元素、夹在对话区与输入区之间 ——
     * **不做浮层**。窄面板里浮层要自己算位置（输入框会长高、面板会滚动），而且会盖住对话内容。
     */
    popup: '#popup',
    // ---- 图片（粘贴 / 选图）----
    attachments: '#attachments',
    btnImage: '#btn-image',
    picker: '#picker',
    btnPickerClose: '#btn-picker-close',
    btnPickerRefresh: '#btn-picker-refresh',
    btnPickerPaste: '#btn-picker-paste',
    pickerSearch: '#picker-search',
    pickerNote: '#picker-note',
    pickerList: '#picker-list',
};

/** 调主进程的方法。失败一律收敛成抛给调用方的 Promise，面板自己 try/catch。 */
async function call<T = any>(message: string, ...args: unknown[]): Promise<T> {
    return (await Editor.Message.request(EXTENSION_NAME, message, ...args)) as T;
}

/** 建元素小工具。 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * 把面板自检报给主进程（读不到也无所谓，纯诊断）。
 *
 * 不依赖 state：`mount` 半路抛错时它也能用（那时还没有 state）。
 */
function reportProbe(payload: Record<string, unknown>): void {
    try {
        const pending = Editor.Message.request(EXTENSION_NAME, MSG.panelProbe, {
            ...payload,
            at: Date.now(),
        }) as Promise<unknown>;
        void pending?.catch?.(() => undefined);
    } catch {
        /* 诊断失败不许影响面板 */
    }
}

/** 提示条：文字 + 可选动作按钮。元素缺失时只 warn（绝不让 UI 抛错）。 */
function setBanner(
    state: UiState,
    text: string | null,
    tone: 'error' | 'info' = 'error',
    actions: Array<{ label: string; run: () => void }> = [],
    /**
     * 最短停留时间（毫秒）。
     *
     * 为什么需要它：`refreshState` 里有一句「一切正常就把横幅收起来」，而它在
     * **每次有新条目时、以及每 5 跳轮询时**都会跑（跑动时 300ms 一跳）—— 于是
     * 「贴图失败/发送失败」这类**由用户动作产生**的提示平均只能活几百毫秒，
     * 用户根本读不完（`send()` 结尾还立刻 `refreshState()` 一次，等于当场抹掉）。
     * 动作类提示一律带 `holdMs`，状态类提示（profile 同步失败、agent 出错）不用带：
     * 那些本来就会在每一轮状态里被重新写出来。
     */
    holdMs = 0,
): void {
    const node = state.banner;
    if (!node) return;
    node.textContent = '';
    if (!text) {
        node.hidden = true;
        return;
    }
    state.bannerUntil = Date.now() + Math.max(0, holdMs);
    node.hidden = false;
    node.dataset.tone = tone;
    node.appendChild(el('div', undefined, text));
    if (actions.length > 0) {
        const row = el('div', 'dsh-banner-actions');
        for (const action of actions) {
            const button = el('button', 'dsh-btn', action.label);
            button.addEventListener('click', action.run);
            row.appendChild(button);
        }
        node.appendChild(row);
    }
}

/**
 * 主题：`auto` 先看能不能认出编辑器主题，认不出再跟系统。
 *
 * 面板很可能跑在独立文档里（这也是 `getElementById` 拿不到面板元素的原因），
 * 那时 `documentElement.className` 是我们自己的、认不出编辑器 —— 于是回落系统偏好。
 */
function resolveTheme(mode: PanelTheme): 'dark' | 'light' {
    if (mode === 'dark' || mode === 'light') return mode;
    const hint = `${document.documentElement?.className ?? ''} ${document.body?.className ?? ''} ${
        document.body?.dataset?.theme ?? ''
    }`;
    if (/dark/i.test(hint)) return 'dark';
    if (/light/i.test(hint)) return 'light';
    try {
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'dark';
    }
}

/**
 * 把外观设置落到根节点（主题 + 配色 + 字号）。
 *
 * `data-theme` 管**明暗**，`data-palette` 管**配色**（见 `static/style/default/editor-theme.css`）：
 * 两个维度正交 —— 配色层挂在 `[data-palette='editor'][data-theme='dark']` 上，
 * 所以「编辑器配色 + 浅色」不会命中（编辑器深色才是常驻形态）。
 */
function applyAppearance(state: UiState): void {
    const root = state.root;
    if (!root) return;
    const mode = state.settings?.theme ?? 'auto';
    root.dataset.theme = resolveTheme(mode);
    root.dataset.palette = state.settings?.palette === 'editor' ? 'editor' : 'dsw';
    const size = Number(state.settings?.fontSize ?? 0);
    if (size >= 12 && size <= 17) root.style.setProperty('--dsh-content-font-size', `${size}px`);
    else root.style.removeProperty('--dsh-content-font-size');
}

/**
 * 布局自检：面板的高度从哪来。
 *
 * 老版样式靠 `html,body{height:100%}` 撑起来 —— 那条规则会改到编辑器自己的页面，
 * 所以新版把它删了，改成这里量一次：`.dsh-root` 高度塌了（< 40px）就按情况兜底。
 * 面板到底独占一个文档还是与编辑器共用，各版本编辑器不一样，量出来的结果会回传给主进程。
 */
function ensureLayout(state: UiState): Record<string, unknown> {
    const root = state.root;
    if (!root) return { root: 'missing' };
    const rect = root.getBoundingClientRect();
    const info: Record<string, unknown> = {
        kind: 'layout',
        rootHeight: Math.round(rect.height),
        rootWidth: Math.round(rect.width),
        parent: root.parentElement?.tagName ?? null,
        htmlHeight: document.documentElement?.clientHeight ?? -1,
        bodyHeight: document.body?.clientHeight ?? -1,
        bodyChildren: document.body?.children?.length ?? -1,
        bodyMargin: document.body ? getComputedStyle(document.body).margin : '',
        theme: root.dataset.theme,
    };
    // 面板独占这个文档（body 里只有我们）时，清掉 body 的默认外边距是安全的
    const ownsDocument = Boolean(document.body) && document.body.children.length <= 1 && document.body.contains(root);
    info.ownsDocument = ownsDocument;
    if (ownsDocument && document.body) {
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.documentElement.style.height = '100%';
        document.body.style.height = '100%';
        document.body.style.overflow = 'hidden';
        const after = root.getBoundingClientRect();
        info.rootHeightAfterReset = Math.round(after.height);
        if (after.height < 40) {
            root.style.position = 'absolute';
            root.style.inset = '0';
        }
    } else if (rect.height < 40) {
        info.warning = '高度塌了但不是独占文档 —— 没有自动兜底，请把这条报给扩展作者';
    }
    return info;
}

// ---------------------------------------------------------------- 条目渲染

/**
 * 用户气泡里的图片碎片。
 *
 * **像素不进转写**（见 `constants.ts` 的 `EntryImage` 注释）：这里只有元数据 —— 图名、尺寸、
 * 大小。刚刚**由本面板发出去**的那几张例外：那时碎片上的缩略图还在手边（`sentThumbs`），
 * 就顺手显示真图，让「我刚才贴的是这张」一眼能确认。回放历史时日志里没有像素，
 * `sentThumbs` 也早已轮空，于是回落成「🖼 图名（尺寸）」。
 */
function renderEntryImages(state: UiState, images: EntryImage[]): HTMLElement {
    const wrap = el('div', 'dsh-msg-images');
    for (const image of images) {
        const chip = el('span', 'dsh-msg-image');
        const thumb = image.name ? state.sentThumbs.get(image.name) : undefined;
        if (thumb) {
            const node = el('img', 'dsh-msg-image-thumb');
            node.src = thumb;
            node.alt = image.name ?? '';
            chip.appendChild(node);
        } else {
            chip.appendChild(el('span', 'dsh-msg-image-glyph', '🖼'));
        }
        const dims = image.width && image.height ? `${image.width}×${image.height}` : '';
        const size = image.bytes ? formatBytes(image.bytes) : '';
        chip.appendChild(el('span', 'dsh-msg-image-name', image.name || '图片'));
        const meta = [dims, size].filter(Boolean).join(' · ');
        if (meta) chip.appendChild(el('span', 'dsh-msg-image-meta', meta));
        wrap.appendChild(chip);
    }
    return wrap;
}

/** 思考块（默认折叠；流式那一块自动展开）。 */function renderThinking(state: UiState, host: HTMLElement, entry: Entry): void {
    const explicit = state.collapsedThink.get(entry.seq);
    const isLive = state.snapshot?.running === true && entry.seq === state.maxSeq;
    const collapsed = explicit === undefined ? !isLive : explicit;

    const box = el('div', 'dsh-think');
    box.dataset.collapsed = collapsed ? 'true' : 'false';
    const head = el('div', 'dsh-think-head');
    head.append(el('span', 'dsh-think-caret', '▸'), el('span', undefined, isLive ? '思考中…' : '思考过程'));
    const body = el('div', 'dsh-think-body', entry.text ?? '');
    head.addEventListener('click', () => {
        const next = box.dataset.collapsed !== 'true';
        box.dataset.collapsed = next ? 'true' : 'false';
        state.collapsedThink.set(entry.seq, next);
    });
    box.append(head, body);
    host.appendChild(box);
}

/** 工具卡片。 */
function renderTool(state: UiState, host: HTMLElement, entry: Entry): void {
    const explicit = state.openTools.get(entry.seq);
    const open = explicit === undefined ? defaultOpen(entry) : explicit;
    const card = createToolCard(entry, open, (next) => state.openTools.set(entry.seq, next));
    host.appendChild(card.root);
}

/** 按条目种类渲染内容（元素已被清空）。 */
function paintEntry(state: UiState, element: HTMLElement, entry: Entry): void {
    element.className = '';
    element.textContent = '';
    switch (entry.kind) {
        case 'user': {
            element.className = 'dsh-msg-user';
            // 纯图片消息没有文字 —— 那就只画碎片（别留一个空气泡）
            if (entry.text) element.appendChild(el('div', 'dsh-msg-text', entry.text));
            if (entry.images && entry.images.length > 0) element.appendChild(renderEntryImages(state, entry.images));
            return;
        }
        case 'agent': {
            element.className = 'dsh-msg-agent';
            const md = el('div', 'dsh-md');
            renderMarkdown(md, entry.text ?? (state.snapshot?.running ? '…' : ''));
            element.appendChild(md);
            return;
        }
        case 'thinking': {
            renderThinking(state, element, entry);
            return;
        }
        case 'tool': {
            renderTool(state, element, entry);
            return;
        }
        case 'error': {
            element.className = 'dsh-error';
            element.textContent = entry.text ?? '出错';
            return;
        }
        default: {
            element.className = 'dsh-note';
            if ((entry.text ?? '').startsWith('stderr:')) element.dataset.kind = 'stderr';
            element.textContent = entry.text ?? '';
            return;
        }
    }
}

/** 空态：首次打开时告诉用户这是什么、怎么开始。 */
function renderEmpty(state: UiState, reason: 'no-agent' | 'no-messages'): void {
    const wrap = el('div', 'dsh-empty');
    if (reason === 'no-agent') {
        wrap.appendChild(el('div', 'dsh-empty-title', 'DSH 还没启动'));
        const lines = el('div', 'dsh-empty-lines');
        const snapshot = state.snapshot;
        const text = [
            '面板会在编辑器里跑一个独立的 dsh profile（cocos）：能读工程里的文件与 skill，',
            '并通过 cocos_execute_code 直接操作你正开着的编辑器（工具走进程间通道，不占端口）。',
            '',
            '首次启动要几十秒 —— 要加载整棵 DSH 插件树。',
            snapshot ? `node：${snapshot.runtime.nodeExe ?? '未找到'}（${snapshot.runtime.nodeSource}）` : '',
            snapshot ? `dsh ：${snapshot.runtime.dshBin ?? '未找到'}（${snapshot.runtime.dshSource}）` : '',
        ]
            .filter(Boolean)
            .join('\n');
        lines.textContent = text;
        wrap.appendChild(lines);
        const button = el('button', 'dsh-send-primary', '启动 agent');
        button.addEventListener('click', () => void startAgent(state));
        wrap.appendChild(button);
    } else {
        wrap.appendChild(el('div', 'dsh-empty-title', '说点什么开始'));
        const lines = el('div', 'dsh-empty-lines');
        lines.textContent = '比如：「看一眼当前场景，把 Canvas 下的节点列出来」。';
        wrap.appendChild(lines);
    }
    state.body.appendChild(wrap);
    state.emptyEl = wrap;
}

/** 「正在回复」的三个点（只在跑的时候挂在最后）。 */
function syncTyping(state: UiState): void {
    const running = state.snapshot?.running === true;
    if (!running) {
        if (state.typingEl) {
            state.typingEl.remove();
            state.typingEl = null;
        }
        return;
    }
    if (!state.typingEl) {
        const dots = el('div', 'dsh-typing');
        dots.append(el('span'), el('span'), el('span'));
        state.typingEl = dots;
    }
    if (state.body.lastElementChild !== state.typingEl) state.body.appendChild(state.typingEl);
}

/** 流式状态变了之后，重算「思考块该不该展开」（用户手动点过的以用户为准）。 */
function syncLiveBlocks(state: UiState): void {
    for (const entry of state.entries.values()) {
        if (entry.kind !== 'thinking') continue;
        if (state.collapsedThink.has(entry.seq)) continue;
        const element = state.els.get(entry.seq);
        const box = element?.querySelector<HTMLElement>('.dsh-think');
        if (!box) continue;
        const isLive = state.snapshot?.running === true && entry.seq === state.maxSeq;
        box.dataset.collapsed = isLive ? 'false' : 'true';
    }
}

/**
 * 清空对话区（换会话 / 回放历史时）。
 *
 * 由**主进程的转写代数**驱动（`generation` 对不上就调一次），而不是各自按钮里手写一遍 ——
 * 这样「谁清空的」只有一个真源，不会出现「按钮清了、轮询又把旧条目灌回来」。
 *
 * @param generation - 主进程给的新代数（不传就只清 DOM）。
 */
function resetUi(state: UiState, generation?: number): void {
    state.entries.clear();
    state.els.clear();
    state.openTools.clear();
    state.collapsedThink.clear();
    state.body.textContent = '';
    state.emptyEl = null;
    state.typingEl = null;
    // 「要滚到的那一条」属于上一个会话的转写：代数变了就等于没了（否则会滚到一个
    // 恰好复用了同一个 seq 的无关条目上）
    state.jumpTo = null;
    if (state.jumpTimer) {
        clearTimeout(state.jumpTimer);
        state.jumpTimer = null;
    }
    // maxRev 归零：代数变了，之前那批条目在主进程里已经不存在，重拉一遍不会重复
    state.maxRev = 0;
    state.maxSeq = 0;
    state.lastUserSeq = 0;
    // 交互块不跟着会话走（它属于「插件在等的那一问」，换会话也要留着），但记号要重算
    state.interactionSig = '';
    renderInteractions(state);
    // 换会话 = 换 agent 上下文：命令表要重拉（命令是**按 agent** 查的，注册表支持按 agent 遮蔽），
    // `@` 候选取自 agent 的工作目录，同理作废。
    state.commands = null;
    state.mentionCache.clear();
    closePopup(state);
    if (typeof generation === 'number') state.generation = generation;
    if (state.entries.size === 0) renderEmpty(state, state.snapshot?.status === 'ready' ? 'no-messages' : 'no-agent');
}

/** 按 seq 合并条目（同一 seq 原地更新）。 */
function mergeEntries(state: UiState, entries: Entry[]): boolean {
    let changed = false;
    for (const entry of entries) {
        const previous = state.entries.get(entry.seq);
        state.entries.set(entry.seq, entry);
        if (entry.seq > state.maxSeq) state.maxSeq = entry.seq;
        let element = state.els.get(entry.seq);
        if (!element) {
            // 新回合（又一条用户消息）前面拉一条分隔线，只在不是第一条时拉
            if (entry.kind === 'user' && state.els.size > 0 && entry.seq !== state.lastUserSeq) {
                const sep = el('div', 'dsh-turn-sep');
                state.body.appendChild(sep);
            }
            if (entry.kind === 'user') state.lastUserSeq = entry.seq;
            element = el('div');
            state.els.set(entry.seq, element);
            state.body.appendChild(element);
            changed = true;
        } else if (previous && previous.rev === entry.rev) {
            continue; // 没变
        }
        paintEntry(state, element, entry);
        changed = true;
    }
    return changed;
}

// ---------------------------------------------------------------- 图片附件

/**
 * 图片这条链路在**面板侧**要做的事，和它的四条口径。
 *
 * 1. **先归一化再进 IPC**：剪贴板/工程里的图可能是任意尺寸、任意格式（BMP/截屏工具产出的 TIFF…），
 *    而 DSH 附件库只收 png/jpeg/webp/gif 四种、且会拿字节验一遍声明的 MIME。所以面板先
 *    「解码 → 按预算缩放 → 编码成白名单里的一种 → 规范 base64」。这也顺手把 IPC 上的体积
 *    从「4K 截图的十几 MB」压到几 MB 以内（像素预算与编码预算都照附件库的口径来，见 `IMAGE_BUDGET`）。
 * 2. **缩略图是面板自己画的**：`<img src="data:...">` 一张 128px 的 PNG 只有几 KB，
 *    而原图要几 MB —— 输入区的碎片和选择器的格子都只看缩略图（原图只留在 `data` 里等着发）。
 * 3. **发送前不落盘、不写草稿**：图片只在内存里，面板关掉即丢（草稿只存文字）。
 *    理由：localStorage 有 5MB 配额，一张图就能把它撑爆，而「配额爆了」的表现是
 *    **整个草稿功能静默失效**（连带文字一起丢），这个代价换不来「记住上次贴的图」。
 * 4. **失败要说人话**：读不到/太大/格式不认，一律变成输入区上方横幅里的一句中文，
 *    绝不静默丢图（静默丢图的表现是「我贴了但它没发出去」，最难查）。
 */
let attachSeq = 0;

/** 白名单 MIME 集合（从 `IMAGE_MIME_BY_EXT` 推，别手抄第二份）。 */
const ACCEPTED_MIME = new Set<string>(Object.values(IMAGE_MIME_BY_EXT));

/** MIME → 扩展名（拼显示名用）。 */
function extOfMime(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    return mimeType.replace(/^image\//, '') || 'png';
}

/**
 * 显示名保证带**正确**的扩展名。
 *
 * 两件事都要做：没有扩展名就补（剪贴板来的图没有名字），扩展名不对就**换掉** ——
 * 只看「有没有扩展名」会得到 `screenshot.bmp.png` 这种名字（bmp 不在白名单里，
 * 但压缩产物是 PNG），发出去之后自己也看不出到底存的是哪种格式。
 */
function withExt(name: string, mimeType: string): string {
    const wanted = `.${extOfMime(mimeType)}`;
    const trimmed = (name.trim() || '图片').replace(/[\\/:*?"<>|]+/g, '_');
    if (trimmed.toLowerCase().endsWith(wanted)) return trimmed;
    const withoutOldExt = trimmed.replace(/\.[a-z0-9]{1,5}$/i, '');
    return `${withoutOldExt || '图片'}${wanted}`;
}

/** base64 → 字节数（面板里只为显示，不引 Buffer）。 */
function base64Bytes(data: string): number {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * 按预算算目标尺寸 —— **与 DSH 附件库的 `requestImageDimensions` 同一套算法**。
 *
 * 算法一致的意义：面板算出来的尺寸就是附件库**本来也会缩到**的尺寸，所以这一步不引入
 * 任何额外损失，只是把「十几 MB 的原图」提前换掉。**只缩不放**（小图不动）。
 *
 * @param width - 原始宽。
 * @param height - 原始高。
 * @returns 目标尺寸（整数，至少 1）。
 */
function fitWithin(width: number, height: number): { width: number; height: number; scaled: boolean } {
    const { maxPixels, maxSide } = IMAGE_BUDGET;
    let scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
    if (Math.max(width, height) * scale > maxSide) scale = maxSide / Math.max(width, height);
    if (scale >= 1) return { width, height, scaled: false };
    let projectedWidth = Math.max(1, Math.round(width * scale));
    let projectedHeight = Math.max(1, Math.round(height * scale));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
        projectedWidth -= 1;
        projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight, scaled: true };
}

/** 解码后的图（`ImageBitmap` 与 `<img>` 都能 `drawImage`，所以统一成这个形状）。 */
interface DecodedImage {
    source: CanvasImageSource;
    width: number;
    height: number;
    release: () => void;
}

/**
 * 解码一段图片字节。
 *
 * 两条路：`createImageBitmap`（快、异步、能直接再编码）与 `<img>` + object URL（兜底）。
 * 后者必须 `revokeObjectURL`，否则每贴一张图就漏一个 blob。
 */
async function decodeBlob(blob: Blob): Promise<DecodedImage> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
        } catch {
            /* 解码失败/不支持：落到 <img> 那条路，让它给出更清楚的错误 */
        }
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('这个文件不是能解码的图片'));
            image.src = url;
        });
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/** 把解码结果画到 canvas（`fillWhite` 用于要转 JPEG 的场合：透明区在 JPEG 里会变黑）。 */
function drawTo(decoded: DecodedImage, width: number, height: number, fillWhite = false): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('拿不到 canvas 2d 上下文');
    if (fillWhite) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
    }
    context.drawImage(decoded.source, 0, 0, width, height);
    return canvas;
}

/** canvas → JPEG（质量梯子，取第一个进预算的；都不行就取最小的那个）。 */
function encodeJpeg(canvas: HTMLCanvasElement): { mimeType: ImageMimeType; dataUrl: string } {
    let best: { mimeType: ImageMimeType; dataUrl: string; bytes: number } | null = null;
    for (const quality of JPEG_LADDER) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const bytes = base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        if (!best || bytes < best.bytes) best = { mimeType: 'image/jpeg', dataUrl, bytes };
        if (bytes <= IMAGE_BUDGET.normalizedMaxBytes) break;
    }
    if (!best) throw new Error('JPEG 编码失败');
    return { mimeType: best.mimeType, dataUrl: best.dataUrl };
}

/**
 * canvas → webp（质量梯子）。
 *
 * ⚠ **必须验一下回来的是不是真 webp**：浏览器不支持某种编码时，`toDataURL` 会**静默回落成 PNG**
 * （不报错）。若不验，我们会把 PNG 的字节当成 `image/webp` 声明出去 —— 附件库会拿字节验类型，
 * 于是报一个很难懂的错。
 *
 * @returns webp 的 data URL；浏览器不支持编码 webp 时返回 null。
 */
function encodeWebp(canvas: HTMLCanvasElement): { mimeType: ImageMimeType; dataUrl: string } | null {
    let best: { mimeType: ImageMimeType; dataUrl: string; bytes: number } | null = null;
    for (const quality of JPEG_LADDER) {
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (!dataUrl.startsWith('data:image/webp')) return null;
        const bytes = base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        if (!best || bytes < best.bytes) best = { mimeType: 'image/webp', dataUrl, bytes };
        if (bytes <= IMAGE_BUDGET.normalizedMaxBytes) break;
    }
    return best ? { mimeType: best.mimeType, dataUrl: best.dataUrl } : null;
}

/**
 * canvas → 白名单里的一种编码，并且**压进归一化预算**。
 *
 * 顺序是照 DSH 附件库自己的梯子来的（`["alpha:webp", "opaque:jpeg"]`）：
 * **PNG → webp → JPEG**。理由：PNG 保真但压不动，一张 4K 截图能到十几 MB，而附件库那边
 * 超预算照样会重压一遍（`normalizedImageMaxBytes` 4MB）—— 与其让十几 MB 的 base64
 * 走一趟 IPC 再被压掉，不如在面板里就压好。webp 在**有透明通道**时明显优于 JPEG
 * （JPEG 会把透明区画成黑块），所以它排在 JPEG 前面；JPEG 那一档要先铺白底。
 *
 * @param canvas - 已经画好目标尺寸的画布。
 * @returns 编码结果与一句「做了什么」的说明（`note`）。
 */
function encodeCanvas(canvas: HTMLCanvasElement): { mimeType: ImageMimeType; dataUrl: string; note?: string } {
    const png = canvas.toDataURL('image/png');
    if (base64Bytes(png.slice(png.indexOf(',') + 1)) <= IMAGE_BUDGET.normalizedMaxBytes) {
        return { mimeType: 'image/png', dataUrl: png };
    }
    const webp = encodeWebp(canvas);
    if (webp && base64Bytes(webp.dataUrl.slice(webp.dataUrl.indexOf(',') + 1)) <= IMAGE_BUDGET.normalizedMaxBytes) {
        return { ...webp, note: 'PNG 压不进预算 → webp' };
    }
    // 铺白底再编 JPEG：透明区在 JPEG 里是黑的，直接编会得到一张「黑底图」
    const flattened = drawTo({ source: canvas, width: canvas.width, height: canvas.height, release: () => undefined }, canvas.width, canvas.height, true);
    const jpeg = encodeJpeg(flattened);
    if (base64Bytes(jpeg.dataUrl.slice(jpeg.dataUrl.indexOf(',') + 1)) <= IMAGE_BUDGET.normalizedMaxBytes) {
        return { ...jpeg, note: 'PNG 压不进预算 → JPEG' };
    }
    // 连质量梯子都压不进（极端大图）：交回给附件库，让它按自己的策略处理
    return { ...jpeg, note: '压不进预算，交给附件库归一化' };
}

/** 缩略图：≤128px 的 PNG data URL（几 KB，随便塞进 DOM）。 */
function makeThumb(decoded: DecodedImage): string {
    const side = IMAGE_BUDGET.thumbSide;
    const scale = Math.min(1, side / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    return drawTo(decoded, width, height).toDataURL('image/png');
}

/** Blob → 规范 base64（`readAsDataURL` 给的正是规范形式，去前缀即可）。 */
async function blobToBase64(blob: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('读不出这张图的数据'));
        reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('这张图的数据不是 data URL');
    return dataUrl.slice(comma + 1);
}

/**
 * 归一化一张图 → 可直接发送的 `Attachment`。
 *
 * @param blob - 图片字节（剪贴板/工程读取/拖拽三个来源都是它）。
 * @param name - 显示名（可以没有扩展名）。
 * @param origin - 来源，只用于显示与排查。
 * @returns 附件，或一句人话的失败原因。
 */
async function buildAttachment(
    blob: Blob,
    name: string,
    origin: Attachment['origin'],
): Promise<{ attachment: Attachment } | { error: string }> {
    if (blob.size > MAX_IMAGE_BYTES) {
        return { error: `${name}有 ${formatBytes(blob.size)}，超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}（附件库是拒收而不是压缩）。` };
    }
    let decoded: DecodedImage;
    try {
        decoded = await decodeBlob(blob);
    } catch (error) {
        return { error: `${name} 解不开：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
        if (!decoded.width || !decoded.height) return { error: `${name} 的像素尺寸是 0，读不出内容。` };

        const sourceMime = (blob.type || '').toLowerCase();
        const target = fitWithin(decoded.width, decoded.height);
        /**
         * 快路（原样发）的三个条件，缺一不可：
         * ① 声明的 MIME 在白名单里（附件库只收那四种）；
         * ② 尺寸在像素预算内（否则要缩）；
         * ③ 字节在归一化预算内 —— 超了附件库反正也会重压一遍，那就**在面板里压**
         *    （十几 MB 的 base64 走一趟 IPC 是纯浪费）。
         */
        const reusable =
            ACCEPTED_MIME.has(sourceMime) && !target.scaled && blob.size <= IMAGE_BUDGET.normalizedMaxBytes;
        const notes: string[] = [];

        let mimeType: ImageMimeType;
        let data: string;
        if (reusable) {
            mimeType = sourceMime as ImageMimeType;
            data = await blobToBase64(blob);
        } else {
            const canvas = drawTo(decoded, target.width, target.height);
            const encoded = encodeCanvas(canvas);
            mimeType = encoded.mimeType;
            data = encoded.dataUrl.slice(encoded.dataUrl.indexOf(',') + 1);
            if (target.scaled) notes.push(`已缩到 ${target.width}×${target.height}`);
            if (!ACCEPTED_MIME.has(sourceMime)) notes.push(`${sourceMime || '未知格式'} → ${extOfMime(mimeType)}`);
            if (encoded.note) notes.push(encoded.note);
        }

        const bytes = base64Bytes(data);
        if (bytes > MAX_IMAGE_BYTES) {
            return { error: `${name} 归一化后仍有 ${formatBytes(bytes)}，超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}。` };
        }
        return {
            attachment: {
                id: `img_${++attachSeq}`,
                name: withExt(name, mimeType),
                mimeType,
                data,
                bytes,
                width: decoded.width,
                height: decoded.height,
                thumb: makeThumb(decoded),
                origin,
                note: notes.join(' · ') || undefined,
            },
        };
    } finally {
        decoded.release();
    }
}

/** 画输入区上方那排图片碎片。 */
function renderAttachments(state: UiState): void {
    const host = state.attachHost;
    if (!host) return;
    host.textContent = '';
    host.hidden = state.attachments.length === 0;
    for (const attachment of state.attachments) {
        const chip = el('div', 'dsh-attach');
        const thumb = el('img', 'dsh-attach-thumb');
        thumb.src = attachment.thumb;
        thumb.alt = attachment.name;
        const meta = el('div', 'dsh-attach-meta');
        meta.append(
            el('div', 'dsh-attach-name', attachment.name),
            el(
                'div',
                'dsh-attach-size',
                `${attachment.width}×${attachment.height} · ${formatBytes(attachment.bytes)}` +
                    (attachment.note ? ` · ${attachment.note}` : ''),
            ),
        );
        const remove = el('button', 'dsh-attach-del', '✕');
        remove.title = '移除这张图';
        remove.addEventListener('click', () => {
            state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
            renderAttachments(state);
        });
        chip.append(thumb, meta, remove);
        host.appendChild(chip);
    }
    if (state.imageButton) {
        state.imageButton.dataset.count = String(state.attachments.length);
        state.imageButton.title =
            state.imageButton.dataset.count === '0'
                ? '添加图片：Ctrl+V 粘贴剪贴板，或在这里选工程里的图'
                : `已附 ${state.attachments.length} 张图（点击继续添加）`;
    }
}

/** 把一批 `Attachment` 或一句错误反映到面板上（唯一入口，别在两处各写一遍）。 */
function addAttachments(state: UiState, attachments: Attachment[]): void {
    if (attachments.length === 0) return;
    const room = MAX_IMAGES_PER_MESSAGE - state.attachments.length;
    const accepted = attachments.slice(0, Math.max(0, room));
    if (accepted.length < attachments.length) {
        setBanner(
            state,
            `一条消息最多带 ${MAX_IMAGES_PER_MESSAGE} 张图，多出来的 ${attachments.length - accepted.length} 张没有加上。`,
            'info',
            [],
            BANNER_HOLD.INFO,
        );
    }
    state.attachments = [...state.attachments, ...accepted];
    renderAttachments(state);
    reportProbe({
        kind: 'attach',
        count: state.attachments.length,
        bytes: state.attachments.reduce((sum, item) => sum + item.bytes, 0),
        mimes: [...new Set(state.attachments.map((item) => item.mimeType))],
    });
}

/**
 * 「把这几张图加上」——粘贴、拖拽、选图三条路共用的入口。
 *
 * 失败一律进横幅（不抛）：面板抛错会污染编辑器控制台且用户什么都看不到（见文件头第 5 条）。
 *
 * @param blobs - 一批图片字节 + 名字。
 * @param origin - 来源标记。
 */
async function attachBlobs(state: UiState, blobs: Array<{ blob: Blob; name: string }>, origin: Attachment['origin']): Promise<void> {
    if (blobs.length === 0) return;
    state.imageBusy += 1;
    if (state.imageButton) state.imageButton.dataset.busy = 'true';
    const errors: string[] = [];
    const built: Attachment[] = [];
    try {
        for (const item of blobs) {
            const result = await buildAttachment(item.blob, item.name, origin);
            if ('attachment' in result) built.push(result.attachment);
            else errors.push(result.error);
        }
    } catch (error) {
        errors.push(`处理图片时出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        state.imageBusy -= 1;
        if (state.imageButton) state.imageButton.dataset.busy = state.imageBusy > 0 ? 'true' : 'false';
    }
    addAttachments(state, built);
    if (errors.length > 0) setBanner(state, errors.join('\n'), 'error', [], BANNER_HOLD.ERROR);
    else if (built.length > 0) setBanner(state, null);
}

/**
 * 剪贴板里有没有图 —— 两种来源都要认。
 *
 * | 来源 | 形状 |
 * |---|---|
 * | 截图/复制图片（Explorer、微信、QQ…） | `DataTransferItem.kind === 'file'`，`type` 是 `image/*` |
 * | 从浏览器/网页里复制 | 网页可能只放 `text/html`，但 Chromium 一般也会带 `image/png` 的 file 项 |
 *
 * 只有**确认有图**才 `preventDefault()`：纯文字粘贴必须原样交给 textarea，否则「粘贴一段文字」
 * 会被我们吃掉（那是最常见的操作，绝不能碰）。
 */
function imagesFromClipboard(data: DataTransfer | null): Array<{ blob: Blob; name: string }> {
    const out: Array<{ blob: Blob; name: string }> = [];
    if (!data) return out;
    const items = data.items ? Array.from(data.items) : [];
    for (const item of items) {
        if (item.kind !== 'file') continue;
        if (!item.type || !item.type.toLowerCase().startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        out.push({ blob: file, name: file.name && file.name !== 'image.png' ? file.name : `剪贴板图片-${out.length + 1}` });
    }
    if (out.length === 0 && data.files && data.files.length > 0) {
        // 有些来源不在 items 里、只在 files 里
        for (const file of Array.from(data.files)) {
            if (file.type.toLowerCase().startsWith('image/')) {
                out.push({ blob: file, name: file.name || `剪贴板图片-${out.length + 1}` });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------- 图片选择器（工程图片）

/** `list-images` 的回执。 */
interface ListImagesReply {
    ok: boolean;
    source?: string;
    total?: number;
    images?: ProjectImage[];
    error?: string;
}

/** `read-image` 的回执。 */
interface ReadImageReply {
    ok: boolean;
    name?: string;
    path?: string;
    url?: string;
    mimeType?: string;
    bytes?: number;
    data?: string;
    error?: string;
}

/** 拉一次工程图片清单（带缓存；`force` 时重拉）。 */
async function ensurePickerList(state: UiState, force = false): Promise<void> {
    if (state.pickerImages && !force) return;
    if (state.pickerNote) {
        state.pickerNote.textContent = '正在读工程的资源库…';
        state.pickerNote.dataset.tone = '';
    }
    let reply: ListImagesReply;
    try {
        reply = await call<ListImagesReply>(MSG.listImages);
    } catch (error) {
        reply = { ok: false, error: String(error) };
    }
    if (!reply?.ok) {
        state.pickerImages = [];
        if (state.pickerNote) {
            state.pickerNote.textContent = `读不到工程图片：${reply?.error ?? '未知原因'}`;
            state.pickerNote.dataset.tone = 'error';
        }
        return;
    }
    state.pickerImages = reply.images ?? [];
    state.pickerSource = reply.source ?? '';
    renderPickerList(state);
}

/** 画选择器里的格子（按搜索词过滤后）。 */
function renderPickerList(state: UiState): void {
    const list = state.pickerList;
    if (!list) return;
    const all = state.pickerImages ?? [];
    const shown = filterProjectImages(all, state.pickerQuery).slice(0, MAX_LISTED_IMAGES);
    list.textContent = '';
    state.pickerObserver?.disconnect();
    state.pickerObserver = null;
    state.pickerQueue = [];

    if (state.pickerNote) {
        const origin = state.pickerSource === 'scan' ? '（资源库没给出结果，这是扫 assets 目录得到的）' : '';
        state.pickerNote.textContent =
            all.length === 0
                ? '这个工程里没找到图片（只认 png / jpg / jpeg / webp / gif）。'
                : `共 ${all.length} 张${origin}${state.pickerQuery ? `，筛出 ${shown.length} 张` : ''} · 点一张就加上`;
        state.pickerNote.dataset.tone = all.length === 0 ? 'error' : '';
    }

    const observer =
        typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(
                  (entries) => {
                      for (const entry of entries) {
                          if (!entry.isIntersecting) continue;
                          const node = entry.target as HTMLElement;
                          observer.unobserve(node);
                          const image = all.find((item) => item.path === node.dataset.path);
                          const target = node.querySelector('img');
                          if (image && target) queueThumb(state, image, target);
                      }
                  },
                  { root: list, rootMargin: '160px' },
              )
            : null;
    state.pickerObserver = observer;

    for (const image of shown) {
        const item = el('button', 'dsh-pick-item');
        item.type = 'button';
        item.dataset.path = image.path;
        item.title = `${image.name}\n${image.rel || image.url}${image.bytes ? `\n${formatBytes(image.bytes)}` : ''}`;
        const thumb = el('img', 'dsh-pick-thumb');
        thumb.alt = '';
        // 缓存里有就直接给（关掉再开不重读），没有则挂上观察者按需读
        const cached = state.pickerThumbs.get(image.path);
        if (cached) thumb.src = cached;
        const text = el('span', 'dsh-pick-text');
        text.append(el('span', 'dsh-pick-name', image.name), el('span', 'dsh-pick-path', image.rel || image.url));
        item.append(thumb, text);
        item.addEventListener('click', () => void attachProjectImage(state, image));
        list.appendChild(item);
        if (!cached && observer) observer.observe(item);
        else if (!cached && shown.indexOf(image) < 24) queueThumb(state, image, thumb);
    }
}

/**
 * 缩略图按需读：一次 IPC + 一次解码，所以**同屏最多 `THUMB_CONCURRENCY` 路**，读完即出队。
 * 读不出来的路径记进 `pickerFailed`，免得滚动一次就重试一整串。
 */
function queueThumb(state: UiState, image: ProjectImage, target: HTMLImageElement): void {
    if (state.pickerThumbs.has(image.path) || state.pickerFailed.has(image.path)) return;
    if (state.pickerLoading.has(image.path)) return;
    state.pickerQueue.push({ image, target });
    void pumpThumbs(state);
}

/** 推缩略图队列（自带并发上限）。 */
async function pumpThumbs(state: UiState): Promise<void> {
    while (state.pickerLoading.size < THUMB_CONCURRENCY && state.pickerQueue.length > 0) {
        const next = state.pickerQueue.shift();
        if (!next) break;
        const { image, target } = next;
        if (state.pickerThumbs.has(image.path) || state.pickerLoading.has(image.path)) continue;
        state.pickerLoading.add(image.path);
        void (async () => {
            try {
                const reply = await readProjectImage(image);
                if (!reply.ok || !reply.data) {
                    state.pickerFailed.add(image.path);
                    target.dataset.failed = 'true';
                    return;
                }
                const blob = new Blob([base64ToBuffer(reply.data)], { type: reply.mimeType ?? 'image/png' });
                const decoded = await decodeBlob(blob);
                try {
                    const thumb = makeThumb(decoded);
                    state.pickerThumbs.set(image.path, thumb);
                    while (state.pickerThumbs.size > THUMB_CACHE_LIMIT) {
                        const oldest = state.pickerThumbs.keys().next();
                        if (oldest.done) break;
                        state.pickerThumbs.delete(oldest.value);
                    }
                    if (target.isConnected) target.src = thumb;
                } finally {
                    decoded.release();
                }
            } catch {
                state.pickerFailed.add(image.path);
                target.dataset.failed = 'true';
            } finally {
                state.pickerLoading.delete(image.path);
                void pumpThumbs(state);
            }
        })();
    }
}

/**
 * base64 → `ArrayBuffer`（要交给 `Blob` 再解码，所以只能自己转；`atob` 是标准 API）。
 *
 * 为什么返回 `ArrayBuffer` 而不是 `Uint8Array`：`new Blob([bytes])` 的 TS 类型要求
 * `ArrayBufferView<ArrayBuffer>`，而 `Uint8Array` 的 `buffer` 是 `ArrayBufferLike`
 * （可能被推成 `SharedArrayBuffer`）—— 直接传会被类型检查拦下。给 `ArrayBuffer` 最省事。
 */
function base64ToBuffer(data: string): ArrayBuffer {
    const binary = atob(data);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return buffer;
}

/** 读一张工程图（选择器点开、拖进来、加附件都走它）。 */
async function readProjectImage(image: ProjectImage): Promise<ReadImageReply> {
    try {
        return await call<ReadImageReply>(MSG.readImage, { url: image.url, path: image.path });
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

/** 点一张工程图 = 读原图 → 归一化 → 进碎片区。 */
async function attachProjectImage(state: UiState, image: ProjectImage): Promise<void> {
    if (state.attachments.some((item) => item.name === image.name && item.origin === 'project')) {
        setBanner(state, `「${image.name}」已经在待发送列表里了。`, 'info', [], BANNER_HOLD.INFO);
        return;
    }
    const reply = await readProjectImage(image);
    if (!reply.ok || !reply.data) {
        setBanner(state, `读不到「${image.name}」：${reply.error ?? '未知原因'}`, 'error', [], BANNER_HOLD.ERROR);
        return;
    }
    const blob = new Blob([base64ToBuffer(reply.data)], { type: reply.mimeType ?? 'image/png' });
    await attachBlobs(state, [{ blob, name: reply.name ?? image.name }], 'project');
}

/** 打开/关掉图片选择器。 */
function togglePicker(state: UiState, open?: boolean): void {
    const next = open ?? !state.pickerOpen;
    state.pickerOpen = next;
    if (state.picker) state.picker.hidden = !next;
    // 选择器与输入弹出块**抢同一块版面**（都在对话区与输入区之间）：开一个就收另一个
    if (next) closePopup(state);
    if (next) {
        /**
         * 缓存命中时**必须重画一次**：关抽屉时把 `IntersectionObserver` 摘掉了，
         * 而没读到的那些格子正是靠它排队的 —— 不重挂的话，第二次打开时那些格子
         * 永远是空的（图片本身没变、缓存也在，只是没人再去读）。
         */
        if (state.pickerImages) renderPickerList(state);
        void ensurePickerList(state);
        // 打开就把焦点给搜索框：键盘流「打开 → 打几个字 → 点一张」一气呵成
        setTimeout(() => state.pickerSearch?.focus(), 0);
    } else if (state.pickerObserver) {
        state.pickerObserver.disconnect();
        state.pickerObserver = null;
    }
}

/** 「读剪贴板」按钮：拿不到权限时给一条可操作的提示（别只说失败）。 */
async function pasteFromClipboardApi(state: UiState): Promise<void> {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard?.read) {
        setBanner(state, '这个面板拿不到剪贴板读取接口 —— 把光标放进输入框按 Ctrl+V 即可。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    try {
        const items = await clipboard.read();
        const blobs: Array<{ blob: Blob; name: string }> = [];
        for (const item of items) {
            const type = item.types.find((candidate) => candidate.startsWith('image/'));
            if (!type) continue;
            blobs.push({ blob: await item.getType(type), name: `剪贴板图片-${blobs.length + 1}` });
        }
        if (blobs.length === 0) {
            setBanner(state, '剪贴板里没有图片（只有文字）。', 'info', [], BANNER_HOLD.INFO);
            return;
        }
        await attachBlobs(state, blobs, 'clipboard');
    } catch (error) {
        setBanner(
            state,
            `读剪贴板失败：${error instanceof Error ? error.message : String(error)}（把光标放进输入框按 Ctrl+V 也一样能用）。`,
            'info',
            [],
            BANNER_HOLD.INFO,
        );
    }
}

// ---------------------------------------------------------------- 动作

/** 启动 agent 并把结果反映到横幅上。 */
async function startAgent(state: UiState): Promise<void> {
    if (state.startRequested) return;
    state.startRequested = true;
    setBanner(state, '正在启动 agent…（首次几十秒，请稍等）', 'info');
    try {
        const result = await call<{ ok: boolean; error?: string }>(MSG.startAgent);
        if (!result?.ok) {
            setBanner(state, result?.error ?? '启动失败', 'error', [{ label: '重试', run: () => void startAgent(state) }]);
        } else {
            setBanner(state, null);
        }
    } catch (error) {
        setBanner(state, `启动失败：${String(error)}`, 'error');
    } finally {
        state.startRequested = false;
        void refreshState(state);
    }
}

/** 重新同步 profile 并把结果显示出来。 */
async function repairProfile(state: UiState): Promise<void> {
    setBanner(state, '正在同步 profile…', 'info');
    try {
        const report = await call<{ ok: boolean; profileDir?: string; error?: string; changes?: string[] }>(
            MSG.installProfile,
        );
        if (report?.ok) {
            setBanner(
                state,
                `profile 已就位：${report.profileDir}\n${report.changes?.length ? report.changes.join('\n') : '（无变更）'}`,
                'info',
            );
        } else {
            setBanner(state, `修复失败：${report?.error ?? '未知原因'}`, 'error');
        }
    } catch (error) {
        setBanner(state, `修复失败：${String(error)}`, 'error');
    }
    await refreshState(state);
}

// ---------------------------------------------------------------- 历史会话

/** `history-list` 的回执。 */
interface HistoryListReply {
    ok: boolean;
    sessions?: HistorySessionView[];
    error?: string;
}

/** `history-search` 的回执（字段与 `constants.ts` 的 `HistorySearchView` 同形）。 */
interface HistorySearchReply {
    ok: boolean;
    error?: string;
    query?: string;
    hits?: HistorySearchHitView[];
    scanned?: number;
    available?: number;
    partial?: boolean;
    stoppedBy?: string | null;
    elapsedMs?: number;
    scannedBytes?: number;
}

/** 抽屉里「当前显示的是一份搜索结果」这件事（连同覆盖率一起存）。 */
interface HistorySearchState {
    query: string;
    hits: HistorySearchHitView[];
    scanned: number;
    available: number;
    partial: boolean;
    stoppedBy: string | null;
    elapsedMs: number;
    scannedBytes: number;
}

/** 删一条会话的**二次确认**：第一次点击拿到这份清单，第二次点击才真删。 */
interface HistoryConfirmState {
    id: string;
    fileCount: number;
    bytes: number;
    /**
     * 这一趟要不要顺带回收无引用附件（**默认 false**）。
     *
     * 为什么要把这个选择**带进清单**：候选数会随它变（勾上之后要跑一次全库扫描才知道
     * 「有几个已无引用」），而用户是按着清单上那个数决定要不要按「确认删除」的。
     * 只存一个布尔、清单照旧的话，那句话就是错的。
     */
    reclaim?: boolean;
}

/**
 * 时间戳 → `09-30 00:36`（面板窄，不带年份）。
 *
 * 字节数怎么显示见 `images.ts` 的 `formatBytes` —— **只有那一份**（历史抽屉的体积、
 * 图片碎片的大小都走它，别在面板里再抄一个）。
 */
function formatTime(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 「当前对话区是不是一条历史会话」的横幅。
 *
 * 两种状态：**只读回放**（还没接上，给「继续此会话」按钮）与**已接上**（能接着聊，
 * 按钮收起来）。这是面板上唯一会告诉用户「你现在看的不是活会话」的地方，别省。
 */
function renderHistoryBar(state: UiState): void {
    const bar = state.historyBar;
    if (!bar) return;
    const history = state.snapshot?.history ?? null;
    if (!history) {
        bar.hidden = true;
        return;
    }
    bar.hidden = false;
    bar.dataset.live = history.live ? 'true' : 'false';
    const when = history.createdAt ? formatTime(history.createdAt) : '时间未知';
    if (state.historyBarText) {
        state.historyBarText.textContent = history.live
            ? `已接上历史会话 ${history.sessionId.slice(0, 8)}…（${when}）· 接下来的消息带着它的上下文`
            : `历史会话（只读回放）：${history.title}（${when} · ${history.messageCount} 条记录）`;
    }
    if (state.resumeButton) state.resumeButton.hidden = history.live === true;
}

/** 打开/刷新历史抽屉（**总是回到列表**：搜索状态属于一次交互，不该跨开关活着）。 */
async function openHistory(state: UiState): Promise<void> {
    state.historyOpen = true;
    if (state.history) state.history.hidden = false;
    state.historySearch = null;
    state.historyConfirm = null;
    syncHistoryControls(state);
    await refreshHistory(state);
}

/** 抽屉头部那几个控件跟着「当前是列表还是搜索结果 / 有没有在忙」调整。 */
function syncHistoryControls(state: UiState): void {
    const searching = state.historySearch !== null;
    if (state.btnHistorySearch) {
        state.btnHistorySearch.disabled = state.historyBusy;
        state.btnHistorySearch.textContent = state.historyBusy ? '搜索中…' : '搜全文';
    }
    if (state.btnHistoryBack) state.btnHistoryBack.hidden = !searching;
    if (state.historySearchEl) state.historySearchEl.placeholder = searching ? '筛选标题…（Esc 返回列表）' : '筛选标题…（Enter = 搜全文）';
    if (state.btnHistoryRefreshEl) state.btnHistoryRefreshEl.disabled = state.historyBusy;
}

/** 重新读一遍列表（不动搜索状态）。 */
async function loadHistoryList(state: UiState): Promise<void> {
    if (state.historyNote) {
        state.historyNote.textContent = '读取中…（直接读 $DSH_HOME/sessions，不需要 agent 在跑）';
        state.historyNote.dataset.tone = '';
    }
    let reply: HistoryListReply;
    try {
        reply = await call<HistoryListReply>(MSG.historyList, { limit: 30 });
    } catch (error) {
        reply = { ok: false, error: String(error) };
    }
    state.historySessions = reply.sessions ?? [];
    renderHistoryList(state, reply);
}

/** 按「当前是列表还是搜索结果」重画抽屉（删完 / 导出完调用它）。 */
async function refreshHistory(state: UiState): Promise<void> {
    if (state.historySearch) {
        await runHistorySearch(state, state.historySearch.query, true);
        return;
    }
    await loadHistoryList(state);
}

/**
 * 画历史列表（按搜索框里的词**只筛标题和 id**）。
 *
 * 为什么本地筛而不是让主进程筛：这一档是「在我手边这几条里挑一条」，纯字符串匹配，
 * 零延迟；真正需要读磁盘的是 `搜全文`（另一个按钮、另一份预算、另一套诚实的覆盖率说明）。
 */
function renderHistoryList(state: UiState, reply: HistoryListReply): void {
    const list = state.historyList;
    if (!list) return;
    list.textContent = '';
    const all = reply.sessions ?? [];
    const shown = filterSessions(all, state.historyQuery);

    if (state.historyNote) {
        if (!reply.ok) {
            state.historyNote.textContent = `读取失败：${reply.error ?? '未知原因'}`;
            state.historyNote.dataset.tone = 'error';
        } else {
            state.historyNote.textContent =
                `${all.length} 条会话（按最后修改时间倒序）` +
                (state.historyQuery ? ` · 标题筛出 ${shown.length} 条` : '') +
                ' · 点一条只读回放，右下角可以导出 / 删除';
            state.historyNote.dataset.tone = '';
        }
    }
    if (!reply.ok) return;

    for (const session of shown) list.appendChild(historyRow(state, session));
    if (shown.length === 0) {
        list.appendChild(
            el('div', 'dsh-history-empty', all.length === 0 ? '这个工程还没有历史会话。' : '没有标题匹配的会话 —— 试试「搜全文」（它连内容一起搜）。'),
        );
    }
}

/** 搜索框里的词 → 命中的会话（大小写不敏感，标题与 id 都算）。 */
function filterSessions(sessions: HistorySessionView[], query: string): HistorySessionView[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
        (session) => session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle),
    );
}

/**
 * 画一条会话（列表与搜索结果共用）。
 *
 * ⚠ 行**不能**整个是一颗 `<button>`：里面有导出/删除按钮，按钮套按钮既是非法 HTML，
 * 点击事件也会互相打架。所以外壳是 `div`，可点的部分是里面那颗 `.dsh-history-open`。
 */
function historyRow(state: UiState, session: HistorySessionView): HTMLElement {
    const row = el('div', 'dsh-history-item');
    row.dataset.current = session.current ? 'true' : 'false';
    row.dataset.id = session.id;

    const open = el('button', 'dsh-history-open');
    open.type = 'button';
    open.title = session.id;
    open.appendChild(el('div', 'dsh-history-item-title', session.title || '(无标题)'));
    open.appendChild(
        el(
            'div',
            'dsh-history-item-meta',
            `${formatTime(session.updatedAt)} · ${session.turns} 轮 · ${formatBytes(session.bytes)}` +
                (session.current ? ' · 正在显示' : ''),
        ),
    );
    open.addEventListener('click', () => void openHistorySession(state, session.id));
    row.appendChild(open);
    row.appendChild(historyActions(state, session.id));
    return row;
}

/**
 * 一条会话右下角那几个动作：导出 md / 导出 jsonl / 导出 ZIP / 删除。
 *
 * 删除是**两段式**（`historyConfirm`）：第一下只拿清单，第二下才真删。
 * 划重点的原因：删会话是不可逆的，而它离「点开看看」只差十几个像素。
 *
 * ## 三个导出为什么是三个按钮，而不是「导出 + 两个开关」
 *
 * 它们**不是同一件事的三种格式**，而是三种用途：
 * `md` 给人读、`jsonl` 给工具吃（解压后原样）、`zip` **对齐 DSH 官方导出**
 * （`session.jsonl` + `subagents/<id>/session.jsonl` + `media/<hex>.<ext>`）。
 * 后者**默认就带子孙与附件像素**（那份布局本来就是这三样），而且**慢得多** ——
 * 做成开关的话，用户会以为「导出 + 勾选 = 还是同一个文件」，而不是「多跑一趟几分钟的活」。
 */
function historyActions(state: UiState, sessionId: string): HTMLElement {
    const box = el('div', 'dsh-history-actions');
    const confirm = state.historyConfirm && state.historyConfirm.id === sessionId ? state.historyConfirm : null;

    if (confirm) {
        box.dataset.confirm = 'true';
        /**
         * 确认条上的那句话是**拼出来**的，不是一句固定文案：勾了「顺带回收附件」之后，
         * 用户要看到的是「会等多久、这一趟大概要干什么」—— 而回收是**分钟级**的
         * （本机 498 条会话 / 569 MB 全库扫描：解压 60.8 秒 + 解析 8.2 秒），
         * 不先说清楚的话，按下去之后那几分钟看起来就像卡死了。
         */
        const parts = [`删除这条会话？${confirm.fileCount} 个文件 · ${formatBytes(confirm.bytes)}`];
        parts.push('图片附件默认不跟着删');
        if (confirm.reclaim) parts.push('顺带回收无引用附件（要全库扫一遍，通常 1~2 分钟）');
        box.appendChild(el('span', 'dsh-history-confirm-text', parts.join(' · ')));

        /**
         * 「顺带回收附件」的勾：**默认不勾**。
         *
         * 为什么不默认：附件是**不可重建**的（`dsh-attachment-local/README.md`：*"Images are kept
         * forever … nothing collects unreferenced objects"*），而我们的回收有一条硬口径是
         * 「全库扫描超预算 ⇒ 一个都不搬」。所以它必须是**用户明确要**的事，
         * 而不是删除时顺手发生的事。
         * 勾上/取消都只动 `historyConfirm.reclaim` —— **清单要重拿**（候选数会变），
         * 所以这里再跑一次 dry-run，而不是就地改个布尔。
         */
        const reclaimLabel = el('label', 'dsh-history-reclaim');
        const reclaimBox = document.createElement('input');
        reclaimBox.type = 'checkbox';
        reclaimBox.checked = confirm.reclaim === true;
        reclaimBox.addEventListener('change', () => {
            void deleteHistorySession(state, sessionId, true, reclaimBox.checked);
        });
        reclaimLabel.append(reclaimBox, el('span', '', '顺带回收无引用附件'));

        const yes = el('button', 'dsh-mini-btn dsh-mini-danger', '确认删除');
        yes.type = 'button';
        yes.addEventListener('click', () => void deleteHistorySession(state, sessionId, false, confirm.reclaim === true));
        const no = el('button', 'dsh-mini-btn', '取消');
        no.type = 'button';
        no.addEventListener('click', () => {
            state.historyConfirm = null;
            void refreshHistory(state);
        });
        box.append(reclaimLabel, yes, no);
        return box;
    }

    const md = el('button', 'dsh-mini-btn', 'md');
    md.type = 'button';
    md.title = '导出成 markdown 转写（落在 $DSH_HOME/exports/<工程键>/）';
    md.addEventListener('click', () => void exportHistorySession(state, sessionId, 'md'));

    const jsonl = el('button', 'dsh-mini-btn', 'jsonl');
    jsonl.type = 'button';
    jsonl.title = '导出成原始日志（解压后一行一事件，不投影不截断）';
    jsonl.addEventListener('click', () => void exportHistorySession(state, sessionId, 'jsonl'));

    const zip = el('button', 'dsh-mini-btn', 'zip');
    zip.type = 'button';
    zip.title =
        '导出成 ZIP（对齐 DSH 官方那一份：session.jsonl + subagents/<id>/session.jsonl + media/<附件>），' +
        '含子会话与附件像素，比另外两种慢';
    zip.addEventListener('click', () => void exportHistorySession(state, sessionId, 'zip'));

    const remove = el('button', 'dsh-mini-btn dsh-mini-danger', '删');
    remove.type = 'button';
    remove.title = '删除这条会话（会先问一次，并报出要删几个文件）';
    remove.addEventListener('click', () => void deleteHistorySession(state, sessionId, true));

    box.append(md, jsonl, zip, remove);
    return box;
}

/** 关闭历史抽屉。 */
function closeHistory(state: UiState): void {
    state.historyOpen = false;
    state.historyConfirm = null;
    if (state.history) state.history.hidden = true;
}

/**
 * 点一条历史会话：让主进程读日志并回放（只读）。
 *
 * @param state - 面板状态。
 * @param sessionId - 会话 id。
 * @param jumpTo - 可选，回放完滚到这条**事件 seq**（全文搜索命中时用）。
 */
async function openHistorySession(state: UiState, sessionId: string, jumpTo?: number): Promise<void> {
    if (state.historyNote) state.historyNote.textContent = '正在读日志并回放…（大日志会稍慢）';
    try {
        const reply = await call<{ ok: boolean; events?: number; entrySeq?: number; error?: string }>(MSG.historyOpen, {
            sessionId,
            jumpTo,
        });
        if (!reply?.ok) {
            if (state.historyNote) {
                state.historyNote.textContent = `回放失败：${reply?.error ?? '未知原因'}`;
                state.historyNote.dataset.tone = 'error';
            }
            return;
        }
        closeHistory(state);
        await refreshState(state);
        // 回放是「主进程转写代数 +1」的副作用，这里主动拉一次，别让用户盯着空白等轮询。
        // 这一拉会顺带 `resetUi` —— 所以「要滚到的那一条」必须**在这一步之后**才装上，
        // 否则会被 `resetUi` 当场清掉（那正是它该做的：清掉的是上一个会话的旧目标）。
        await pollOnce(state);
        if (typeof reply.entrySeq === 'number') {
            // 换算好的**转写条目号**（日志事件与面板条目是两套编号，中间隔着一层投影：
            // `tool/result` 只把结果补进已有卡片、`session/title` 根本不上屏）
            state.jumpTo = reply.entrySeq;
            applyJump(state);
        }
    } catch (error) {
        if (state.historyNote) {
            state.historyNote.textContent = `回放失败：${String(error)}`;
            state.historyNote.dataset.tone = 'error';
        }
    }
}

/**
 * 跑一次全文搜索（读磁盘，有预算）。
 *
 * @param state - 面板状态。
 * @param query - 查询串。
 * @param silent - 静默重跑（删完/导出完刷新时用：不把 note 改成「搜索中…」）。
 */
async function runHistorySearch(state: UiState, query: string, silent = false): Promise<void> {
    const text = query.trim();
    if (!text) {
        state.historySearch = null;
        syncHistoryControls(state);
        await loadHistoryList(state);
        return;
    }
    if (state.historyBusy) return;
    state.historyBusy = true;
    state.historyConfirm = null;
    syncHistoryControls(state);
    if (state.historyNote && !silent) {
        state.historyNote.textContent = `正在搜「${text}」…（直接读盘；会话多的时候最多几秒）`;
        state.historyNote.dataset.tone = '';
    }
    try {
        const reply = await call<HistorySearchReply>(MSG.historySearch, {
            query: text,
            // 预算是**面板**给的：它知道自己在等多久。上限由主进程再夹一道。
            limit: 20,
            perSession: 3,
            maxSessions: 150,
            budgetMs: 6000,
        });
        if (!reply?.ok) {
            state.historySearch = null;
            state.historyBusy = false;
            syncHistoryControls(state);
            renderHistoryList(state, { ok: false, error: reply?.error ?? '未知原因' });
            return;
        }
        state.historySearch = {
            query: reply.query ?? text,
            hits: reply.hits ?? [],
            scanned: reply.scanned ?? 0,
            available: reply.available ?? 0,
            partial: reply.partial === true,
            stoppedBy: reply.stoppedBy ?? null,
            elapsedMs: reply.elapsedMs ?? 0,
            scannedBytes: reply.scannedBytes ?? 0,
        };
        renderSearchResults(state);
    } catch (error) {
        state.historySearch = null;
        renderHistoryList(state, { ok: false, error: String(error) });
    } finally {
        state.historyBusy = false;
        syncHistoryControls(state);
    }
}

/** 停止原因是给人看的一句话（说不清就不说，别编）。 */
function stoppedText(stoppedBy: string | null): string {
    switch (stoppedBy) {
        case 'limit':
            return '已经找够这么多条就收工了（更老的还没看）';
        case 'sessions':
            return '到「最多看几个会话」的上限就停了';
        case 'bytes':
            return '到「最多读多少字节」的上限就停了';
        case 'time':
            return `到时间预算就停了`;
        default:
            return '';
    }
}

/**
 * 画搜索结果。
 *
 * ⚠ 覆盖率那一行是**这个功能里最要紧的一句**：搜索是有预算的，「找到 3 条」与
 * 「在 107 个会话里找到 3 条」是完全不同的两件事。停止原因 + 扫了多少 + 花了多久 +
 * 读了多少字节全写出来，用户才知道该不该把关键词写细一点再搜一次。
 */
function renderSearchResults(state: UiState): void {
    const list = state.historyList;
    const found = state.historySearch;
    if (!list || !found) return;
    list.textContent = '';

    if (state.historyNote) {
        const covered = `扫了 ${found.scanned}/${found.available} 个会话 · ${formatBytes(found.scannedBytes)} · ${found.elapsedMs} ms`;
        state.historyNote.textContent = found.partial
            ? `「${found.query}」命中 ${found.hits.length} 条 —— ⚠ 没搜完：${stoppedText(found.stoppedBy)}（${covered}）。关键词写细一点能搜得更快更准。`
            : `「${found.query}」命中 ${found.hits.length} 条 · 整个工程都扫过了（${covered}）`;
        state.historyNote.dataset.tone = found.partial ? 'warn' : '';
    }

    for (const hit of found.hits) list.appendChild(searchHitRow(state, hit));
    if (found.hits.length === 0) {
        list.appendChild(
            el(
                'div',
                'dsh-history-empty',
                found.partial
                    ? '这几条里没有 —— 但不是「整个工程都没有」：这次没搜完（见上面那行）。'
                    : '整个工程都没有这个词。',
            ),
        );
    }
}

/** 画一条搜索命中（标题 + 元信息 + 片段 + 同一套动作按钮）。 */
function searchHitRow(state: UiState, hit: HistorySearchHitView): HTMLElement {
    const row = el('div', 'dsh-history-item dsh-history-hit');

    const open = el('button', 'dsh-history-open');
    open.type = 'button';
    open.title = `${hit.id}\n点一下只读回放，并滚到命中的那一条`;
    open.appendChild(el('div', 'dsh-history-item-title', hit.title || '(无标题)'));
    open.appendChild(
        el(
            'div',
            'dsh-history-item-meta',
            `${formatTime(hit.updatedAt)} · ${hit.turns} 轮 · ${formatBytes(hit.bytes)} · 命中 ${hit.hits} 次`,
        ),
    );
    // 点结果 = 打开 + 滚到命中的那一条（`seq` 是**事件**号，主进程回放时换算成条目号）
    open.addEventListener('click', () => void openHistorySession(state, hit.id, hit.seq));
    row.appendChild(open);

    const snippets = el('div', 'dsh-history-snippets');
    for (const snippet of hit.snippets) {
        const line = el('div', 'dsh-history-snippet');
        line.appendChild(el('span', 'dsh-history-snippet-label', snippet.label));
        line.appendChild(el('span', 'dsh-history-snippet-text', snippet.snippet));
        snippets.appendChild(line);
    }
    row.appendChild(snippets);
    row.appendChild(historyActions(state, hit.id));
    return row;
}

/** 「继续此会话」：让插件用 `agents.resume` 真接上（之后能接着聊）。 */
async function resumeHistory(state: UiState, sessionId?: string): Promise<void> {
    setBanner(state, '正在接上会话…（DSH 侧 agents.resume，要加载这段历史）', 'info');
    try {
        const reply = await call<{ ok: boolean; sessionId?: string; error?: string }>(
            MSG.historyResume,
            sessionId ? { sessionId } : undefined,
        );
        if (!reply?.ok) setBanner(state, `接上失败：${reply?.error ?? '未知原因'}`, 'error');
        else setBanner(state, null);
    } catch (error) {
        setBanner(state, `接上失败：${String(error)}`, 'error');
    }
    await refreshState(state);
}

/**
 * 导出（或删除）之后的那句提示。
 *
 * 为什么走**顶部横幅**而不是抽屉里的 note：抽屉马上要重画（刷新列表），
 * 写进 note 的那句话会被下一次 `renderHistoryList` 覆盖掉；而「文件写哪儿了」
 * 是用户马上要用的东西（去资源管理器里找它），必须有地方留得住。
 */
function historyBanner(state: UiState, text: string, tone: 'info' | 'error'): void {
    setBanner(state, text, tone, undefined, 12_000);
}

/**
 * 导出这条会话。
 *
 * 导出物落在 `<DSH_HOME>/exports/<工程键>/`（**不往工程里写**：它是「看一眼就删」的东西，
 * 扔进工程只会污染 git），所以这里要把绝对路径显示出来 —— 否则用户根本找不到文件。
 *
 * ## 三种格式的横幅话术不同（`md` / `jsonl` / `zip`）
 *
 * 前两种是「一个文件、几万条事件」，一句话就够。`zip` **不是**：
 * 它含子孙会话与附件像素，而且有三件必须一起说出来的事 ——
 * ① 里面到底装了什么（子孙几个、**其中子 agent 与 fork 各几个**、附件几个）；
 * ② 脚本交代的注意事项（尤其「当前活跃会话可能少最后几条」：DSH 导出前会先 flush，我们做不到）；
 * ③ 有引用但读不到文件的附件（`missingMedia`）—— 那是**缺了东西**，不是「本来就没有」。
 */
async function exportHistorySession(state: UiState, sessionId: string, format: 'md' | 'jsonl' | 'zip'): Promise<void> {
    const slow = format === 'zip';
    historyBanner(
        state,
        slow ? '正在导出 ZIP…（要解压子孙会话日志、读附件像素，大会话会慢）' : `正在导出 ${format}…（大日志要读完整份）`,
        'info',
    );
    try {
        const reply = await call<{
            ok: boolean;
            path?: string;
            bytes?: number;
            events?: number;
            error?: string;
            subagents?: { total: number; subagentCount: number; forkCount: number; maxDepth: number | null; dangling: string[]; incomplete: boolean };
            media?: { count: number; missing: number; namingDeviation: string | null };
            missingMedia?: string[];
            notes?: string[];
        }>(MSG.historyExport, { sessionId, format });
        if (!reply?.ok) {
            historyBanner(state, `导出失败：${reply?.error ?? '未知原因'}`, 'error');
            return;
        }
        const head = `已导出 ${reply.events ?? 0} 条（${formatBytes(reply.bytes ?? 0)}）→ ${reply.path ?? '?'}`;
        if (!slow) {
            historyBanner(state, head, 'info');
            return;
        }
        const facts: string[] = [head];
        if (reply.subagents) {
            const bits = [`子孙 ${reply.subagents.total} 个`];
            // ⚠ 子 agent 与 fork 分开说：用户关心的是「几个是我派出去的 agent」
            bits.push(`其中子 agent ${reply.subagents.subagentCount} · fork ${reply.subagents.forkCount}`);
            if (reply.subagents.maxDepth !== null) bits.push(`最深第 ${reply.subagents.maxDepth} 层`);
            if (reply.subagents.dangling.length > 0) bits.push(`有 ${reply.subagents.dangling.length} 个的父级在索引里找不到`);
            if (reply.subagents.incomplete) bits.push('索引扫描超预算，子孙可能不全');
            facts.push(`ZIP 里的会话：${bits.join(' · ')}`);
        }
        if (reply.media) {
            facts.push(
                `ZIP 里的附件：${reply.media.count} 个${reply.media.missing > 0 ? `（另有 ${reply.media.missing} 个引用读不到文件）` : ''}`,
            );
        }
        if (reply.missingMedia && reply.missingMedia.length > 0) {
            facts.push(`读不到文件的附件：${reply.missingMedia.slice(0, 3).map((id) => id.slice(0, 14)).join('、')}…`);
        }
        for (const line of reply.notes ?? []) facts.push(line);
        historyBanner(state, facts.join('\n'), 'info');
    } catch (error) {
        historyBanner(state, `导出失败：${String(error)}`, 'error');
    }
}

/**
 * 删除这条会话。
 *
 * `dryRun: true` 是**第一下**：只让主进程把「要删几个文件、多大」报回来，然后**在行内**
 * 换成确认条。第二下（`dryRun: false`）才真删。这样即使误点，损失的也只是多看一眼。
 *
 * `reclaim` 是「顺带回收无引用附件」（**默认关**，见 `historyActions` 里那个勾的说明）。
 * 两条口径：
 * 1. **dry-run 也要带上它** —— 否则勾上之后用户看不到「候选几个 / 被引用几个」，
 *    而那正是判断「这一趟值不值得等」的唯一依据；
 * 2. **真删那一趟的横幅必须把回收结果说全**：候选 / 仍被引用 / 无引用 / 搬走几个，
 *    还有「超预算 ⇒ 一个都没搬」。少说一句都会被读成「功能坏了」或「一键腾空间」。
 */
async function deleteHistorySession(
    state: UiState,
    sessionId: string,
    dryRun: boolean,
    reclaim = false,
): Promise<void> {
    try {
        const reply = await call<{
            ok: boolean;
            removed?: boolean;
            fileCount?: number;
            bytes?: number;
            cleared?: boolean;
            error?: string;
            reclaim?: {
                candidates: number;
                referenced: number;
                orphans: number;
                trashed: number;
                bytesFreed: number;
                incomplete: boolean;
                incompleteReason: string | null;
                scanned: { sessions: number; bytes: number; elapsedMs: number };
                skipped: Array<{ id: string; reason: string }>;
            };
        }>(MSG.historyDelete, { sessionId, dryRun, reclaim });

        if (!reply?.ok) {
            state.historyConfirm = null;
            historyBanner(state, `删除失败：${reply?.error ?? '未知原因'}`, 'error');
            await refreshHistory(state);
            return;
        }
        if (dryRun) {
            state.historyConfirm = {
                id: sessionId,
                fileCount: reply.fileCount ?? 0,
                bytes: reply.bytes ?? 0,
                reclaim,
            };
            await refreshHistory(state);
            return;
        }

        state.historyConfirm = null;
        const lines = [
            `已删除会话 ${sessionId.slice(0, 8)}…（${reply.fileCount ?? 0} 个文件 · ${formatBytes(reply.bytes ?? 0)}）`,
        ];
        if (reply.reclaim) {
            const r = reply.reclaim;
            lines.push(
                `附件回收：候选 ${r.candidates} 个 → ${r.referenced} 个仍被别的会话引用、${r.orphans} 个已无引用 → 搬进墓碑 ${r.trashed} 个（${formatBytes(r.bytesFreed)}）`,
            );
            lines.push(
                `全库扫了 ${r.scanned.sessions} 条会话（${formatBytes(r.scanned.bytes)} / ${Math.round(r.scanned.elapsedMs / 1000)} 秒）`,
            );
            if (r.incomplete) {
                lines.push(`回收被中断（${r.incompleteReason ?? '超预算'}）—— 一个都没搬：判据不全时误删不可逆，这是有意的`);
            } else if (r.trashed === 0) {
                lines.push('这次没有可回收的附件（候选里每一个都还被别的会话引用着）');
            }
            const skipped = r.skipped.filter((entry) => entry.reason !== 'still-referenced');
            if (skipped.length > 0) {
                lines.push(`跳过 ${skipped.length} 个（不是"还在用"，是别的守卫拦下的）：${skipped.slice(0, 3).map((entry) => entry.reason).join('、')}`);
            }
        } else {
            lines.push('图片附件是全局去重的，不随会话删除（勾「顺带回收无引用附件」才会去查一遍）');
        }
        historyBanner(state, lines.join('\n'), 'info');
        if (reply.cleared) setBanner(state, `已删除正在回放的那条会话（${sessionId.slice(0, 8)}…）—— 对话区已清空。`, 'info', undefined, 8_000);
        await refreshHistory(state);
        await refreshState(state);
        await pollOnce(state);
    } catch (error) {
        state.historyConfirm = null;
        historyBanner(state, `删除失败：${String(error)}`, 'error');
        await refreshHistory(state);
    }
}

/**
 * 「搜到的就是这一条」：回放完滚过去并高亮几秒。
 *
 * 由 `applyEntries` 在**条目真的到了面板上**之后调（回放是主进程的副作用，
 * 条目要等下一次 `get-events` 才回来，所以不能在这里定时等）。
 */
function applyJump(state: UiState): void {
    if (state.jumpTo === null) return;
    const element = state.els.get(state.jumpTo);
    if (!element) return;
    state.jumpTo = null;
    element.dataset.hit = 'true';
    element.scrollIntoView({ block: 'center' });
    if (state.jumpTimer) clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => {
        delete element.dataset.hit;
        state.jumpTimer = null;
    }, 4000);
}

// ---------------------------------------------------------------- 用量
//
// 数据全部来自**主进程读回来的**那一份 `SessionUsage`（读的是 DSH 的会话投影缓存，
// 见 `source/stats.ts`）。面板这一侧只有三条纪律：
//
// 1. **只画不算**：占用率、缩写、时长都是主进程给的数与 `constants.ts` 里的两个格式化函数。
//    面板自己再算一遍必然与主进程的口径漂移（而且两处都"看起来对"）。
// 2. **null 画成「—」并说明**，绝不补 0 —— 0% 占用和「不知道占用多少」是两件事，
//    这个面板上最不能出现的谎就是它。
// 3. **口径说明跟着数字一起显示**：那些 notes 不是装饰，是让数字可判读的部分
//    （检查点是攒着写的、组成是估算的、花费要读两个文件）。

/** 占用率的颜色档：60% 起提醒、85% 起报警（都是「该想想压缩了」的信号）。 */
function usageTone(ratio: number | null): '' | 'warn' | 'danger' {
    if (ratio === null || !Number.isFinite(ratio)) return '';
    if (ratio >= 0.85) return 'danger';
    if (ratio >= 0.6) return 'warn';
    return '';
}

/**
 * 状态行那颗 chip 上写什么（写不出东西就返回 null = 整颗藏起来）。
 *
 * 优先级：**占用率**（一眼能比大小）→ 退到「累计进出」（至少说明有数据）→ 什么都没有。
 * 为什么不显示 `0%`：`projected` 是 null 时占用率是**不知道**，不是 0。
 */
function usageChipText(usage: SessionUsage | null): string | null {
    if (!usage) return null;
    const { ratio, window, projected } = usage.context;
    if (ratio !== null && window !== null) {
        return `上下文 ${(ratio * 100).toFixed(1)}%`;
    }
    const totals = usage.usage.totals;
    if (totals) return `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`;
    if (projected !== null) return `上下文 ${formatTokens(projected)}`;
    return null;
}

/** 画状态行那颗 chip（每次刷状态与每次广播都调，很便宜）。 */
function renderUsageChip(state: UiState): void {
    const chip = state.usageChip;
    if (!chip) return;
    const usage = state.snapshot?.usage ?? null;
    const text = usageChipText(usage);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    const tone = usageTone(usage?.context.ratio ?? null);
    chip.dataset.tone = tone;
    const ratio = usage?.context.ratio ?? null;
    const percent = ratio === null ? '占用率未知' : `占用率 ${(ratio * 100).toFixed(1)}%`;
    chip.title =
        `${percent}（预估 ${formatTokens(usage?.context.projected ?? null)} / 窗口 ${formatTokens(usage?.context.window ?? null)}）\n` +
        '点开看明细（token 累计 / 组成 / 耗时 / 花费）';
}

/** 一行「标签 值」；值不是数就画「—」并把它做成灰色的（`null` 是有话要说的，不是空白）。 */
function usageLine(label: string, value: string, mono = false): HTMLElement {
    const line = el('div', 'dsh-usage-line');
    line.appendChild(el('span', 'dsh-usage-label', label));
    const valueEl = el('span', 'dsh-usage-value', value || '—');
    if (mono) valueEl.dataset.mono = 'true';
    line.appendChild(valueEl);
    return line;
}

/** 一块带标题的说明。 */
function usageBlock(title: string, lines: HTMLElement[]): HTMLElement {
    const block = el('div', 'dsh-usage-block');
    block.appendChild(el('div', 'dsh-usage-block-title', title));
    for (const line of lines) block.appendChild(line);
    return block;
}

/** 「1.0M / 1.0M」这种给人看的写法（窗口未知时不写假的）。 */
function usageAmount(value: number | null): string {
    return value === null ? '—' : formatTokens(value);
}

/**
 * 花费那一块的几行。
 *
 * 三件事分开画，**一件都不许合并**（合并出来的数字没法判读）：
 * ① 谁花的 + 显示成多少钱（币种与汇率来自 `dsh-cost-meter` 的账本，面板不自己换算）；
 * ② 账本原值（**恒为美元**）与模型调用次数 —— 「折算是怎么来的」必须看得见；
 * ③ 「今日」那一行**是这台机器上所有工程加起来的**（账本共享），所以标签里就写着。
 *
 * 一个金额都没有时**不画 0**：那句「为什么没有」由 `cost.ts` 的 `noRecordNote` 出
 * （三种来路 —— 会话太老 / 这个 profile 没装那个 bundle / 别的 profile 的会话 —— 各一句），
 * 面板这一层**一句话都不自己编**，只负责把它画出来。
 */
function costLines(usage: SessionUsage): HTMLElement[] {
    const text = costTextOf({
        cost: usage.cost,
        display: usage.costDisplay,
        ledger: usage.costLedger,
        note: usage.costNote,
        mounted: usage.costMounted,
        bundle: usage.costBundle,
    });
    const lines: HTMLElement[] = [];
    if (text.amount !== null) {
        lines.push(usageLine(text.head, text.amount, true));
        if (text.usd !== null) lines.push(usageLine('账本原值（美元）', text.usd, true));
        if (text.calls !== null) lines.push(usageLine('模型调用', text.calls));
        if (text.today !== null) {
            lines.push(usageLine(`今日（${usage.costLedger?.todayKey ?? '今天'}，全部工程）`, text.today, true));
        }
    }
    for (const note of text.notes) lines.push(el('div', 'dsh-usage-source', note));
    return lines;
}

/**
 * 上下文增长曲线：**一根柱 = 一次模型调用**（点太多时是一个回合），柱高按最大值归一。
 *
 * 这一块的全部文字（哪条是实测、哪条是估算、为什么没画、聚合了没有、archiveFloor 那句）
 * 都在 `constants.ts` 的 `timelineTextOf` 里 —— 那是**纯函数**，有已知答案表
 * （`scripts/verify-stats.js` 拿它跑），面板这一层只负责把它画出来 + 把柱子摆对。
 *
 * 三条实现口径：
 * 1. **横向滚动、柱宽固定**：柱宽由调用次数决定、容器 `overflow-x: auto`
 *    —— 让容器去挤柱子的画法会把落差抹平（而落差就是这张图要看的东西）；
 * 2. **压缩点画竖线 + `✂`**，钉在「压缩之后的那一根柱」上（跟宿主 wire view 的挂载规则一致）；
 *    同一根柱上有好几处压缩时只画一个 `✂`（它们是同一条竖线），明细在 tip 里；
 * 3. **回合分带**：柱子上方那一条是**回合带**（交替底色 + 第 N 轮），所以「哪一段是哪一轮」
 *    一眼能看出来 —— 这一步（第 1 步的那个回归）正是最容易看不出来的地方。
 *
 * ⚠ 面板这一层**不补任何 0**：柱高用的数与归一化的分母都是 `SessionUsage.timeline` 给的，
 * 认不出的请求在读取器里就被丢掉了（并在说明里报出条数）。
 */

/** 一根柱的横向像素（一次调用）。**固定**：柱子不随容器伸缩。 */
const TIMELINE_SLOT_PX = 6;

/** 聚合之后的柱宽上限（按步数加宽，但别宽到一屏只剩两三根）。 */
const TIMELINE_SLOT_MAX_STEPS = 4;

/**
 * 一根柱占的横向像素（含 1px 间隔）。
 *
 * ⚠ 上面那排**回合带**必须用**同一个**函数算宽度，否则两排会越差越远
 * （最后一根柱对不上它的回合带，而那正是「哪一段是哪一轮」的唯一依据）。
 */
function timelineSlotWidth(point: TimelinePointView): number {
    const steps = Math.min(Math.max(point.steps, 1), TIMELINE_SLOT_MAX_STEPS);
    return TIMELINE_SLOT_PX * steps + 1;
}

/** 柱子的 tip：这一根的全部事实（轮到哪、实测多少、估算多少、压缩了几处）。 */
function timelinePointTitle(point: TimelinePointView, contextWindow: number | null): string {
    const lines: string[] = [];
    const where =
        point.turn === null
            ? `第 ${point.index} 根柱`
            : `第 ${point.turn} 回合 · 第 ${point.step ?? '?'} 步（第 ${point.index} 根柱）`;
    lines.push(where + (point.steps > 1 ? ` —— 这一根合并了 ${point.steps} 步` : ''));
    lines.push(
        `${point.estimated ? '估算' : '实测'} ${formatTokens(point.tokens)} token` +
            (contextWindow === null ? '' : `（占窗口 ${(point.tokens / contextWindow * 100).toFixed(1)}%）`),
    );
    if (point.prompt !== null && point.total !== null) {
        lines.push(`实测 prompt ${formatTokens(point.prompt)} · 估算 total ${formatTokens(point.total)}`);
    } else if (point.total !== null) {
        lines.push(`只有估算的 total ${formatTokens(point.total)}（provider 没报这次调用的 usage）`);
    }
    for (const cut of point.cuts) {
        lines.push(
            `✂ ${cut.kind === 'compaction' ? '压缩' : '裁剪'}：净释放 ${formatTokens(cut.tokens)} token` +
                (cut.count === null ? '' : ` · 涉及 ${cut.count} 条记录`) +
                (cut.merged > 1 ? ` · 同一处连发了 ${cut.merged} 条（已合并成一个标记）` : '') +
                (cut.time === null ? '' : ` · ${formatTime(cut.time)}`),
        );
    }
    return lines.join('\n');
}

/**
 * 画曲线本身：**回合带 + 柱林**，两排裹在同一个横向滚动容器里。
 *
 * 为什么两排要放在同一个滚动容器里：分开两个容器的话，滚动其中一个另一个不动 ——
 * 而「哪一根柱属于哪一轮」就靠它们对齐，滚起来错位等于没有回合带。
 */
function timelineChart(view: ContextTimelineView): HTMLElement {
    const scroll = el('div', 'dsh-timeline-scroll');

    // ---- ① 回合带：**一整轮一条带**（宽度 = 这一轮所有柱的宽度和），交替底色 ----
    const bands = el('div', 'dsh-timeline-bands');
    const runs: { turn: number | null; width: number }[] = [];
    for (const point of view.points) {
        const width = timelineSlotWidth(point);
        const last = runs[runs.length - 1];
        if (last && last.turn === point.turn) last.width += width;
        else runs.push({ turn: point.turn, width });
    }
    runs.forEach((run, index) => {
        const band = el('div', 'dsh-timeline-band');
        band.dataset.alt = index % 2 === 0 ? 'false' : 'true';
        // 窄带里的字会被 CSS 裁掉（ellipsis），所以完整的轮次同时写在 title 里
        band.title = run.turn === null ? '这一段的轮次号读取不出来' : `第 ${run.turn} 轮`;
        band.appendChild(el('span', 'dsh-timeline-band-label', run.turn === null ? '轮次未知' : `第 ${run.turn} 轮`));
        band.style.width = `${run.width}px`;
        bands.appendChild(band);
    });
    scroll.appendChild(bands);

    // ---- ② 柱林 ----
    const plot = el('div', 'dsh-timeline-plot');
    for (const point of view.points) {
        const slot = el('div', 'dsh-timeline-slot');
        slot.style.width = `${timelineSlotWidth(point)}px`;
        slot.title = timelinePointTitle(point, view.contextWindow);
        const bar = el('div', 'dsh-timeline-bar');
        // 归一化：`max` 是读取器给的（points 里最大的那个 tokens）；max 是 0 时全部画成 0 高
        bar.style.height = view.max > 0 ? `${(point.tokens / view.max) * 100}%` : '0%';
        if (point.estimated) bar.dataset.estimated = 'true';
        if (point.cuts.length > 0) bar.dataset.cut = 'true';
        slot.appendChild(bar);
        if (point.cuts.length > 0) {
            /**
             * 压缩点：**一条竖线 + 一个 ✂**。同一根柱上有好几处压缩时是**同一条竖线**
             * （横坐标相同），所以只画一个 `✂`，几处、各释放多少全在 tip 里 —— 画 N 个
             * 会在 6px 宽的柱子上糊成一团，那正是这块最容易出现的糊法。
             */
            const cut = el('div', 'dsh-timeline-cut');
            cut.appendChild(el('span', 'dsh-timeline-cut-mark', '✂'));
            slot.appendChild(cut);
        }
        plot.appendChild(slot);
    }
    scroll.appendChild(plot);
    return scroll;
}

/**
 * 「上下文增长」那一块要画的行（DOM 由 `renderUsage` 挂上去）。
 *
 * 没画曲线时（`timeline === null`）**只画说明**：那几句话分四种来路（版本不认识 / 宿主低于
 * 基线 / 还没有请求记录 / 这一行压根不存在 —— 最后一种是**常态**，因为注册者是第三方），
 * 四句原文都由 `timelineTextOf` 给，面板一句都不自己编。
 */
function timelineLines(usage: SessionUsage): HTMLElement[] {
    const text = timelineTextOf({ timeline: usage.timeline, note: usage.timelineNote });
    const lines: HTMLElement[] = [];
    if (usage.timeline) {
        if (text.headline) lines.push(el('div', 'dsh-timeline-head', text.headline));
        lines.push(timelineChart(usage.timeline));
    }
    if (text.legend.length > 0) {
        const legend = el('div', 'dsh-timeline-legend');
        for (const item of text.legend) {
            const row = el('div', 'dsh-timeline-legend-item');
            const swatch = el('span', 'dsh-timeline-swatch', item.swatch === 'cut' ? '✂' : '');
            swatch.dataset.swatch = item.swatch;
            row.appendChild(swatch);
            row.appendChild(el('span', 'dsh-timeline-legend-text', item.label));
            legend.appendChild(row);
        }
        lines.push(legend);
    }
    for (const note of text.notes) lines.push(el('div', 'dsh-usage-source', note));
    return lines;
}

/**
 * 「这些数字有多新」——抽屉头部那一行（没有读数时换成原因，见 `renderUsage`）。
 *
 * 四个事实，缺一个都会让人误判：**来源**（检查点不是实时流）、**水位**（记到第几条事件）、
 * **落后多少条**、**写于何时**。这一行是整块用量里最容易被省略、也最不该省略的东西 ——
 * 一份「12% 占用」在落后一万条事件时是完全没有意义的。
 */
function usageFreshness(usage: SessionUsage): string {
    const parts: string[] = ['来自会话投影缓存（检查点，不是实时流）'];
    if (usage.seq !== null) parts.push(`水位第 ${usage.seq} 条事件`);
    if (usage.behind !== null) parts.push(usage.behind > 0 ? `落后 ${usage.behind} 条` : '已跟上');
    else parts.push('没有实时水位可比');
    if (usage.updatedAt > 0) parts.push(`写于 ${formatTime(usage.updatedAt)}`);
    return parts.join(' · ');
}

/**
 * 画用量抽屉。
 *
 * 为什么每次整块重建而不是就地更新：内容是「读一次的答案」，不需要保住任何输入状态
 * （对比：交互卡片里有用户正在敲的字，所以那边必须按签名跳过重画）。
 * 一眼能读完的十几行，重建比维护增量便宜得多。
 */
function renderUsage(state: UiState): void {
    const body = state.usageBody;
    if (!body) return;
    body.textContent = '';

    const usage = state.snapshot?.usage ?? null;
    const note = state.snapshot?.usageNote ?? null;

    if (state.usageNoteEl) {
        /**
         * 抽屉头部那一行**永远**有话说，而且是两种内容之一：
         *
         * - 读失败/还没读数 → **原因**（带警告色）；
         * - 有数字 → **「这些数字有多新」**：来源、记录水位、落后多少条、缓存写于何时。
         *
         * 为什么把「新鲜度」放这一行而不是放到内容末尾：抽屉有 `max-height: 62%`，
         * 内容满的时候是要滚的 —— 而这一行恰恰是**不看就没法判读那些数字**的东西
         * （`.dsh-usage-head` 是 sticky，永远在视野里）。
         */
        state.usageNoteEl.textContent = note ?? (usage ? usageFreshness(usage) : '');
        state.usageNoteEl.dataset.tone = note ? 'warn' : '';
    }

    if (!usage) {
        /**
         * 「没有数字可画」有两种来路，**不能混成一句话**：
         * 读失败（原因在上面那行，带警告色）与「这条会话还没有用量」。
         * 面板分不清具体是哪种（那是主进程的事），所以只说一句两种情况下都成立的话 +
         * 一个可操作的动作，而**原因永远由上面那一行负责**。
         */
        body.appendChild(
            el(
                'div',
                'dsh-usage-source',
                note
                    ? '这里没有数字可画 —— 原因见上面那行。点「刷新」可以再读一次。'
                    : '还没有读数 —— 用量在 agent 启动、发出第一条消息之后才有（数据来自 DSH 的会话投影缓存，agent 没在跑也能读）。',
            ),
        );
        return;
    }

    const { context } = usage;

    // ---- ① 占用条（只回答「下一次请求大概占多少」）----
    if (context.projected !== null && context.window !== null && context.ratio !== null) {
        const bar = el('div', 'dsh-usage-bar');
        const fill = el('div', 'dsh-usage-fill');
        // 超过窗口时条画满，但百分比照实写（不许悄悄钳成 100%）
        fill.style.width = `${Math.min(100, Math.max(0, context.ratio * 100))}%`;
        fill.dataset.tone = usageTone(context.ratio);
        bar.appendChild(fill);
        body.appendChild(bar);
        body.appendChild(
            usageLine(
                '下一次请求预估',
                `${usageAmount(context.projected)} / ${usageAmount(context.window)}（${(context.ratio * 100).toFixed(1)}%）`,
                true,
            ),
        );
    }
    const contextLines: HTMLElement[] = [];
    contextLines.push(usageLine('上一次请求实测', usageAmount(context.pressure), true));
    if (context.window === null) contextLines.push(usageLine('窗口上限', '不知道（DSH 还没记到）'));
    if (context.projected === null && context.ratio === null && context.window !== null) {
        contextLines.push(usageLine('占用率', '算不出来（缺 prompt 侧的实测）'));
    }
    body.appendChild(usageBlock('上下文', contextLines));

    // ---- ② 估算组成：**单独一块**，并明说它不参与上面那条 ----
    if (context.system !== null || context.tools !== null || context.messages !== null) {
        body.appendChild(
            usageBlock('上下文组成（估算）', [
                usageLine('系统提示', usageAmount(context.system), true),
                usageLine('工具表', usageAmount(context.tools), true),
                usageLine('对话', usageAmount(context.messages), true),
                el(
                    'div',
                    'dsh-usage-source',
                    '这一块是按「四字符一个 token」估的：中文与 JSON schema 会明显低估，' +
                        '三个数加起来也和上面那条占用率对不上 —— 所以它只用来比相对大小。',
                ),
            ]),
        );
    }

    // ---- ③ 本会话累计 ----
    const totals = usage.usage.totals;
    if (totals) {
        body.appendChild(
            usageBlock('本会话累计', [
                usageLine('输入（未命中缓存）', formatTokens(totals.input), true),
                usageLine('输出', formatTokens(totals.output), true),
                usageLine('缓存读', formatTokens(totals.cacheRead), true),
                usageLine('缓存写', formatTokens(totals.cacheWrite), true),
            ]),
        );
    }
    if (usage.usage.last) {
        const last = usage.usage.last;
        body.appendChild(
            usageBlock(`最近一步（第 ${last.turn} 回合 / 第 ${last.step} 步）`, [
                usageLine(
                    '这一步',
                    `输入 ${formatTokens(last.buckets.input)} · 输出 ${formatTokens(last.buckets.output)} · 缓存读 ${formatTokens(last.buckets.cacheRead)}`,
                    true,
                ),
            ]),
        );
    }

    // ---- ④ 回合与耗时（`sessionStats`）----
    const sessionLines: HTMLElement[] = [];
    if (usage.session.turns !== null || usage.session.steps !== null) {
        sessionLines.push(usageLine('回合 / 步', `${usage.session.turns ?? '—'} 回合 · ${usage.session.steps ?? '—'} 步`));
    }
    if (usage.session.llmMs !== null) sessionLines.push(usageLine('模型耗时', formatDuration(usage.session.llmMs)));
    if (usage.session.toolMs !== null) sessionLines.push(usageLine('工具耗时', formatDuration(usage.session.toolMs)));
    if (usage.session.ttftMs !== null && usage.session.ttftSteps) {
        sessionLines.push(
            usageLine('首字延迟均值', `${formatDuration(usage.session.ttftMs / usage.session.ttftSteps)}（${usage.session.ttftSteps} 步）`),
        );
    }
    if (usage.session.decodeMs !== null && usage.session.decodeTokens !== null && usage.session.decodeMs > 0) {
        const perSecond = (usage.session.decodeTokens / usage.session.decodeMs) * 1000;
        sessionLines.push(
            usageLine('生成速度', `${perSecond.toFixed(1)} tok/s（${formatTokens(usage.session.decodeTokens)} 个输出 token）`),
        );
    }
    if (sessionLines.length > 0) body.appendChild(usageBlock('这一局', sessionLines));

    // ---- ⑤ 上下文增长：**这一块通常没有曲线**（注册者是第三方，本 profile 不挂它）----
    // 与花费那一块同一套规矩：没有就说清是**哪一种没有**，绝不画一条空的坐标轴充数。
    body.appendChild(usageBlock('上下文增长', timelineLines(usage)));

    // ---- ⑥ 花费：**没有就说没有**，绝不显示 0 ----
    body.appendChild(usageBlock('花费', costLines(usage)));

    // ---- ⑦ 口径说明（一条都不许吞）----
    // 数据来源与水位在**头部那一行**（`#usage-note`，sticky、永远可见），这里只放说明。
    if (usage.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of usage.notes) notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}

/** 开/关用量抽屉。打开时**顺手要一次新读数**（缓存是攒着写的，旧读数可能过时了）。 */
function toggleUsage(state: UiState, open?: boolean): void {
    const next = open ?? !state.usageOpen;
    state.usageOpen = next;
    if (state.usageHost) state.usageHost.hidden = !next;
    if (next) {
        renderUsage(state);
        void readUsage(state);
    }
}

/**
 * 问一次主进程要最新读数（**用量 + 进度**：主进程读一遍同一个文件，两边一次给全）。
 *
 * 平时不需要面板催：主进程在**回合结束**与**跑完斜杠命令**之后自己会读并走广播推过来
 * （清单那一路更快 —— agent 每写一次 `todo_write` 就推一次）。
 * 这一条只服务「打开抽屉」与「点刷新」两个动作 —— 用户主动看的时候，必须看到刚读的。
 *
 * ⚠ 两个抽屉共用这一个函数与这一个闸（`usageBusy`）：它们打的是同一个主进程方法。
 */
async function readUsage(state: UiState): Promise<void> {
    if (state.usageBusy) {
        /**
         * 已经有一次在读：**不重复读盘**，但要把两颗「刷新」按钮都复原 ——
         * 调用方（哪一颗按钮都可能是）在调之前先把它禁用了，早退不还原的话它会**永远禁着**
         * （只在开启抽屉那一路已经在读时点刷新才会撞上，但撞上就是死按钮）。
         */
        if (state.btnUsageRefreshEl) state.btnUsageRefreshEl.disabled = false;
        if (state.btnProgressRefreshEl) state.btnProgressRefreshEl.disabled = false;
        return;
    }
    state.usageBusy = true;
    if (state.usageNoteEl && state.usageOpen) {
        state.usageNoteEl.textContent = '读取中…';
        state.usageNoteEl.dataset.tone = '';
    }
    if (state.progressNoteEl && state.progressOpen) {
        state.progressNoteEl.textContent = '读取中…';
        state.progressNoteEl.dataset.tone = '';
    }
    try {
        const reply = await call<{
            ok: boolean;
            usage?: SessionUsage | null;
            note?: string | null;
            progress?: ProgressView | null;
            progressNote?: string | null;
            error?: string;
        }>(MSG.sessionUsage);
        if (state.snapshot) {
            state.snapshot.usage = reply?.usage ?? null;
            // ⚠ 读失败的原因有两处可能给：主进程的 note，或者这条请求本身抛了（error）
            state.snapshot.usageNote = reply?.note ?? reply?.error ?? null;
            /**
             * 同一条请求也带回了进度 —— 两个抽屉打的是**同一个**主进程方法（同一次读盘）。
             * 所以谁点的「刷新」都会把两边一起更新，不存在「用量是新的、清单是旧的」。
             */
            state.snapshot.progress = reply?.progress ?? null;
            state.snapshot.progressNote = reply?.progressNote ?? reply?.error ?? null;
        }
    } catch (error) {
        if (state.snapshot) {
            state.snapshot.usage = null;
            state.snapshot.usageNote = `读用量失败：${String(error)}`;
            state.snapshot.progress = null;
            state.snapshot.progressNote = `读进度失败：${String(error)}`;
        }
    } finally {
        state.usageBusy = false;
        if (state.btnUsageRefreshEl) state.btnUsageRefreshEl.disabled = false;
        if (state.btnProgressRefreshEl) state.btnProgressRefreshEl.disabled = false;
        renderUsageChip(state);
        renderProgressChip(state);
        if (state.usageOpen) renderUsage(state);
        if (state.progressOpen) renderProgress(state);
    }
}

// ---------------------------------------------------------------- 进度（清单 / 目标 / 回合目录）
//
// 数据是**宿主合并好的成品**（`ProgressView`）：清单优先取实时事件、缓存补洞，
// 回合目录只有缓存那一路（事件流里没有「整个日志」这个概念）。
// 面板这一侧的纪律与用量抽屉一样：**只画不算** —— 进度那点算术（完成几条、一共几条、
// chip 上写什么）全在 `./progress` 那个纯函数模块里（那里能跑已知答案，见该文件头注释）；
// 凡涉及「这一轮算不算结束了」这类判断，一律用宿主给的 `stale`，面板不自己推。
//
// 三句必须说出来的话（每一句都是「不说就会误导」的那种）：
// 1. **清单可能是上一轮的** —— DSH 的投影口径是「每一次 `turn/start` 清单归零」，
//    所以本轮 agent 还没写新表时，面板上这一份属于上一轮，必须标出来；
// 2. **清单那一路是实时的、目标和回合目录是缓存给的**（后者最多落后几条事件）——
//    三块混在一起时，用户会以为它们一样新；
// 3. **更早的回合点不动** —— 面板转写只留最近 600 条，那一轮已经被挤掉时说清楚，
//    而不是点了没反应（静默失败是这面板上最不能出现的东西）。

/**
 * 抽屉头部那一行（**永远**有话说）。
 *
 * 与用量抽屉同一条纪律：读失败/没读数时给**原因**，有数据时给**新鲜度**。
 * 进度这里更麻烦一点，因为它的三块**来源不同**（清单实时、目标与回合目录来自缓存），
 * 所以这一行要把「哪几块是缓存的、记到第几条事件」说清楚 —— 只说一句「来自缓存」
 * 会让人以为清单也是攒着写的（它不是，它是实时的）。
 */
function progressFreshness(progress: ProgressView): string {
    const parts: string[] = [];
    if (progress.todosSource === 'events' && progress.todos !== null) parts.push('清单来自实时事件（agent 每写一次就到）');
    else if (progress.todosSource === 'checkpoint') parts.push('清单来自会话投影缓存');
    if (progress.currentTurn > 0) parts.push(`现在第 ${progress.currentTurn} 轮`);
    if (progress.turns.length > 0 || progress.goal) {
        if (progress.seq !== null) parts.push(`目标与回合目录来自会话投影缓存（水位第 ${progress.seq} 条事件）`);
        else parts.push('目标与回合目录来自会话投影缓存');
    }
    if (progress.behind !== null) parts.push(progress.behind > 0 ? `落后 ${progress.behind} 条` : '已跟上');
    if (progress.updatedAt > 0) parts.push(`写于 ${formatTime(progress.updatedAt)}`);
    return parts.join(' · ');
}

/** 画那颗 chip（没清单就整颗藏起来，绝不显示 `0/0`）。 */
function renderProgressChip(state: UiState): void {
    const chip = state.progressChip;
    if (!chip) return;
    const progress = state.snapshot?.progress ?? null;
    const text = progressChipText(progress);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    chip.dataset.tone = progress?.stale ? 'stale' : '';
    const counts = todoCounts(progress?.todos ?? []);
    const parts: string[] = [];
    parts.push(counts.total > 0 ? `完成 ${counts.done} / 共 ${counts.total}` : '清单是空的');
    if (counts.active > 0) parts.push(`进行中 ${counts.active}`);
    if (progress?.stale) parts.push(`这是第 ${progress.todosTurn} 轮写的，本轮还没写新的`);
    if (progress?.todosSource === 'checkpoint') parts.push('来自检查点（不是实时事件）');
    chip.title = `${parts.join(' · ')}\n点开看清单 / 目标 / 回合目录`;
}

/** 清单那一条（标记 + 文本）。 */
function todoItem(todo: TodoView): HTMLElement {
    const item = el('div', 'dsh-todo-item');
    item.dataset.status = todo.status;
    item.appendChild(el('span', 'dsh-todo-mark', TODO_MARK[todo.status]));
    item.appendChild(el('span', 'dsh-todo-text', todo.content));
    return item;
}

/**
 * 回合目录里的一条。
 *
 * 能跳的用 `<button>`（键盘也能用），跳不了的用 `<div>` —— 形状本身就在说
 * 「这一条点不动」，比画成按钮再弹一句「点不动」好。
 */
function turnItem(state: UiState, turn: TurnView, current: boolean): HTMLElement {
    const jumpable = turn.entrySeq !== null;
    const item = el(jumpable ? 'button' : 'div', 'dsh-turn');
    item.dataset.jump = jumpable ? 'true' : 'false';
    if (current) item.dataset.current = 'true';

    const head = el('div', 'dsh-turn-head');
    head.appendChild(el('span', 'dsh-turn-no', `第 ${turn.turn} 轮`));
    // 每一行都自己说清「这条点不点得动」—— 让用户去翻底部的说明太绕
    head.appendChild(el('span', '', turnHeadHint(jumpable)));
    item.appendChild(head);

    if (turn.prompt) item.appendChild(el('div', 'dsh-turn-prompt', turn.prompt));
    if (turn.response) item.appendChild(el('div', 'dsh-turn-response', turn.response));
    else if (current) item.appendChild(el('div', 'dsh-turn-response', '（这一轮还没结束）'));

    if (jumpable) {
        item.title = `跳到第 ${turn.turn} 轮`;
        item.addEventListener('click', () => jumpToTurn(state, turn));
    }
    return item;
}

/**
 * 跳到某一轮的转写位置。
 *
 * ⚠ 与「搜全文命中后跳过去」那条路（`applyJump`）分开写：那条路的失手是**安静**的
 * （命中太靠前时主进程已经给过一句提示了），而这一条必须自己说话 ——
 * 用户是**主动点**的，点了没反应等于面板坏了。
 */
function jumpToTurn(state: UiState, turn: TurnView): void {
    const target = turn.entrySeq;
    if (target === null) {
        setBanner(state, `第 ${turn.turn} 轮的正文已经不在面板的转写窗口里了（只保留最近 600 条）。`, 'info', undefined, 6_000);
        return;
    }
    if (!state.els.has(target)) {
        setBanner(
            state,
            `第 ${turn.turn} 轮的正文刚刚被挤出转写窗口（面板只保留最近 600 条条目）—— 点「刷新」再看一眼目录。`,
            'info',
            undefined,
            6_000,
        );
        return;
    }
    toggleProgress(state, false);
    state.jumpTo = target;
    applyJump(state);
}

/**
 * 画进度抽屉（每次整块重建，理由与用量抽屉相同：内容是「读一次的答案」）。
 */
function renderProgress(state: UiState): void {
    const body = state.progressBody;
    if (!body) return;
    body.textContent = '';

    const progress = state.snapshot?.progress ?? null;
    const note = state.snapshot?.progressNote ?? null;

    if (state.progressNoteEl) {
        state.progressNoteEl.textContent = note ?? (progress ? progressFreshness(progress) : '');
        state.progressNoteEl.dataset.tone = note ? 'warn' : '';
    }

    if (!progress) {
        /**
         * 「没有数字可画」的两种来路不许混（与用量抽屉同一条纪律）：
         * 读失败 → 原因在上面那行；还没有读数 → 说清楚进度什么时候才有。
         */
        body.appendChild(
            el(
                'div',
                'dsh-usage-source',
                note
                    ? '这里没有东西可画 —— 原因见上面那行。点「刷新」可以再读一次。'
                    : '还没有进度 —— 清单要等 agent 写第一份待办，目标与回合目录来自会话投影缓存（agent 没在跑也能读）。',
            ),
        );
        return;
    }

    // ---- ① 待办清单（这一块是实时的）----
    const todos = progress.todos;
    const block = el('div', 'dsh-usage-block');
    block.appendChild(el('div', 'dsh-usage-block-title', '待办清单'));
    if (todos === null || todos.length === 0) {
        block.appendChild(
            el(
                'div',
                'dsh-usage-source',
                todos === null
                    ? '这一轮 agent 还没有写清单（DSH 的投影在每一轮开始时把清单归零）。'
                    : 'agent 明确写了一份空清单（是它自己写的，不是读不到）。',
            ),
        );
    } else {
        const counts = todoCounts(todos);
        block.appendChild(
            el(
                'div',
                'dsh-todo-count',
                `完成 ${counts.done} / 共 ${counts.total}` +
                    (counts.active > 0 ? ` · 进行中 ${counts.active}` : '') +
                    (counts.total - counts.done - counts.active > 0 ? ` · 还没开始 ${counts.total - counts.done - counts.active}` : ''),
            ),
        );
        const list = el('div', 'dsh-todo');
        for (const todo of todos) list.appendChild(todoItem(todo));
        block.appendChild(list);
    }
    /**
     * 两句必须说的话，按情况出现（顺序有意义：先说「这是哪一轮的」再说「数据从哪来」）。
     */
    if (progress.stale) {
        block.appendChild(
            el(
                'div',
                'dsh-usage-source',
                `⚠ 这份清单是第 ${progress.todosTurn} 轮写的 —— 第 ${progress.currentTurn} 轮开始后 DSH 已经把清单归零了，` +
                    '也就是说「本轮 agent 还没写新清单」——下面这些不是现在正在做的事。',
            ),
        );
    }
    if (progress.todosSource === 'checkpoint') {
        block.appendChild(
            el('div', 'dsh-usage-source', '这一份来自会话投影缓存（不是实时事件）：它攒够 200 条事件或 5 秒才写一次，可能比面板上真实发生的事慢几秒。'),
        );
    }
    body.appendChild(block);

    // ---- ② 目标（有才画）----
    if (progress.goal) {
        const goal = progress.goal;
        const lines: HTMLElement[] = [];
        lines.push(usageLine('目标', goal.objective));
        lines.push(
            usageLine(
                '阶段',
                `${GOAL_PHASE_TEXT[goal.phase] ?? goal.phase}` +
                    (goal.maxGoalRounds > 0 ? ` · 已跑 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮` : ''),
            ),
        );
        if (goal.blockedReason) lines.push(usageLine('卡住的原因', goal.blockedReason));
        body.appendChild(usageBlock('目标（goal 模式）', lines));
    }

    // ---- ③ 回合目录（整个日志，能点的就点）----
    if (progress.turns.length > 0) {
        const turnsBlock = el('div', 'dsh-usage-block');
        const hidden = progress.turnsTotal - progress.turns.length;
        turnsBlock.appendChild(
            el(
                'div',
                'dsh-usage-block-title',
                `回合目录（${progress.turnsTotal} 轮${hidden > 0 ? `，只列最近 ${progress.turns.length} 轮` : ''}）`,
            ),
        );
        const list = el('div', 'dsh-todo');
        for (const turn of progress.turns) list.appendChild(turnItem(state, turn, turn.turn === progress.currentTurn));
        turnsBlock.appendChild(list);
        /**
         * 正在写的那一轮的草稿：它**还没定稿**，所以单独一行、斜体、低对比度 ——
         * 混进上面那份「已经结束的轮次」里会让人以为这一轮已经答完了。
         */
        if (progress.draft) turnsBlock.appendChild(el('div', 'dsh-turn-draft', `正在写：${progress.draft}`));
        turnsBlock.appendChild(
            el(
                'div',
                'dsh-usage-source',
                '目录是整个日志的（缓存折出来的）；能不能点取决于那一轮的正文还在不在面板的转写里 —— 面板只保留最近 600 条条目。',
            ),
        );
        body.appendChild(turnsBlock);
    } else {
        /**
         * ⚠ 这一块**必须**画出来，哪怕目录是空的：三块里缺一块而**什么都不说**，
         * 用户看到的是「面板上没有回合目录」——分不清「这条会话没有回合」与
         * 「缓存里没有这一行」。两句话完全不同（前者是事实，后者是数据源缺了一块）。
         */
        body.appendChild(
            usageBlock('回合目录', [
                el(
                    'div',
                    'dsh-usage-source',
                    progress.currentTurn > 0
                        ? `缓存里没有回合大纲（事件流显示已经到第 ${progress.currentTurn} 轮了）—— 这一块只有会话投影缓存给得出（agent 没在跑、或者缓存里没这一行时就看不到）。`
                        : '这条会话还没有回合（还没发过消息）。',
                ),
            ]),
        );
    }

    // ---- ④ 口径说明 ----
    if (progress.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of progress.notes) notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}

/** 开/关进度抽屉（打开时顺手要一次新读数，理由与用量抽屉相同）。 */
function toggleProgress(state: UiState, open?: boolean): void {
    const next = open ?? !state.progressOpen;
    state.progressOpen = next;
    if (state.progressHost) state.progressHost.hidden = !next;
    if (next) {
        renderProgress(state);
        void readUsage(state);
    }
}

// ---------------------------------------------------------------- 活动（后台任务 / 子 agent）

/**
 * 面板上「活动」那条控制帧的节流间隔（毫秒）。
 *
 * 为什么是**轮询**而不是等推送：这两个服务**没有可订阅的变化事件** ——
 * `jobs.onJobsChanged` 只在「集合变了」时响（注册 / kill / settle / 拥有者销毁），
 * **输出增长不触发**；子 agent 那边只有 `subagent/start|end` 两个粗事件。
 * 所以想要「后台还在跑什么」这件事是新的，就只能按节流问。
 *
 * 4 秒这个数：job 的粒度是「一条命令跑几秒到几分钟」，4 秒足够看出它结束了；
 * 而且它**只在有东西可看时才轮询**（见 `shouldPollActivity`）—— 空闲时一次都不问。
 */
const ACTIVITY_POLL_MS = 4_000;

/**
 * 问一次主进程要「活动」那一份（后台任务 + 子 agent）。
 *
 * ⚠ 与用量/进度那两块**最要紧的区别**：那两个读的是磁盘上的检查点（agent 没在跑照样能看），
 * 而这两块只活在**运行时进程的内存里** —— agent 没起就真的什么都看不到，
 * 所以这里失败/为空时说的话与另外两个抽屉不一样（不许说成「读盘失败」）。
 *
 * @param state - 面板状态。
 * @param options.quiet - 静默模式（后台轮询用）：失败不弹横幅，只把原因写进抽屉头部。
 */
async function readActivity(state: UiState, options: { quiet?: boolean } = {}): Promise<void> {
    if (state.activityBusy) return;
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.status !== 'ready') {
        // 没起 agent 就没有内存里的东西可看 —— 这一条要**当场说出来**，别留一个空抽屉
        state.activity = null;
        state.activityAt = Date.now();
        state.activityNote = 'agent 没在跑：后台任务与子 agent 只活在运行时进程里，停掉之后就没了（历史会话也看不到它们）。';
        renderActivity(state);
        renderActivityChip(state);
        return;
    }
    state.activityBusy = true;
    if (state.btnActivityRefreshEl) state.btnActivityRefreshEl.disabled = true;
    if (state.activityNoteEl && state.activityOpen) {
        state.activityNoteEl.textContent = '读取中…';
        state.activityNoteEl.dataset.tone = '';
    }
    try {
        const reply = await call<{ ok: boolean; activity?: ActivityView; error?: string }>(MSG.panelActivity);
        state.activity = reply?.activity ?? null;
        state.activityAt = Date.now();
        state.activityNote = reply?.ok ? null : `读活动失败：${reply?.error ?? '未知原因'}`;
        if (!reply?.ok && !options.quiet) {
            setBanner(state, `读活动失败：${reply?.error ?? '未知原因'}`, 'error', undefined, 6_000);
        }
    } catch (error) {
        state.activity = null;
        state.activityAt = Date.now();
        state.activityNote = `读活动失败：${String(error)}`;
        if (!options.quiet) setBanner(state, `读活动失败：${String(error)}`, 'error', undefined, 6_000);
    } finally {
        state.activityBusy = false;
        if (state.btnActivityRefreshEl) state.btnActivityRefreshEl.disabled = false;
        renderActivity(state);
        renderActivityChip(state);
    }
}

/** 这颗 chip 该不该亮 + 亮什么（**没事就整个藏起来**，不写 0）。 */
function activityChipText(activity: ActivityView | null): string {
    if (!activity) return '';
    const jobs = activity.jobs.length;
    const subs = activity.subagents.length;
    if (jobs === 0 && subs === 0) return '';
    const parts: string[] = [];
    if (jobs > 0) parts.push(`后台 ${jobs}`);
    if (subs > 0) parts.push(`子 ${subs}`);
    return parts.join(' · ');
}

/** 有东西还在跑吗（决定 chip 用不用强调色）。 */
function activityBusyNow(activity: ActivityView | null): boolean {
    if (!activity) return false;
    return (
        activity.jobs.some((job) => job.status === 'running' || job.status === 'stopping') ||
        activity.subagents.some((row) => row.status === 'running')
    );
}

/** 画那颗 chip（没东西就藏起来 —— 与前两颗 chip 同一条纪律）。 */
function renderActivityChip(state: UiState): void {
    const chip = state.activityChip;
    if (!chip) return;
    const text = activityChipText(state.activity);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    chip.dataset.tone = activityBusyNow(state.activity) ? 'busy' : '';
    const notes: string[] = [];
    notes.push(`点开看后台任务与子 agent（读到 ${formatTime(state.activity?.at ?? 0)}）`);
    if (activityBusyNow(state.activity)) notes.push('还有东西在跑');
    chip.title = notes.join(' · ');
}

/** job 状态的中文与色调（认不出的原值是「不明」，不是「在跑」）。 */
const JOB_STATUS_TEXT: Record<JobView['status'], { text: string; tone: string }> = {
    running: { text: '运行中', tone: 'busy' },
    stopping: { text: '正在停', tone: 'busy' },
    completed: { text: '已完成', tone: 'done' },
    killed: { text: '已终止', tone: 'warn' },
    failed: { text: '失败', tone: 'error' },
    unknown: { text: '状态不明', tone: 'warn' },
};

/** 子 agent 忙闲的中文（`ready` = 只在磁盘上，可以接着聊）。 */
const SUBAGENT_STATUS_TEXT: Record<SubagentView['status'], string> = {
    running: '运行中',
    idle: '空闲',
    ready: '可继续',
};

/** 后台任务那一行。 */
function jobItem(job: JobView, currentSessionId: string | null): HTMLElement {
    const item = el('div', 'dsh-activity-item dsh-job');
    const status = JOB_STATUS_TEXT[job.status] ?? JOB_STATUS_TEXT.unknown;
    item.dataset.tone = status.tone;

    const head = el('div', 'dsh-activity-item-head');
    head.appendChild(el('span', 'dsh-activity-badge', status.text));
    if (job.kind) head.appendChild(el('span', 'dsh-activity-kind', job.kind));
    head.appendChild(el('span', 'dsh-activity-id', job.id));
    item.appendChild(head);

    // label 可能是整条命令原文（pwsh 就是这么传的）：原样画，靠 CSS 换行，不做二次加工
    item.appendChild(el('div', 'dsh-activity-label', job.label || '（这条任务没有说明）'));

    const meta: string[] = [];
    if (job.startedAt) meta.push(`起于 ${formatTime(job.startedAt)}`);
    if (job.finishedAt) meta.push(`结束于 ${formatTime(job.finishedAt)}`);
    if (job.detail) meta.push(job.detail);
    // 子 agent 起的任务归子 agent —— 不标出来的话，用户会以为「我这条会话怎么多了个任务」
    if (job.ownerSessionId && currentSessionId && job.ownerSessionId !== currentSessionId) {
        meta.push(`属于子 agent ${job.ownerSessionId.slice(0, 8)}…${job.depth === null ? '' : `（第 ${job.depth} 层）`}`);
    }
    if (meta.length > 0) item.appendChild(el('div', 'dsh-activity-meta', meta.join(' · ')));
    return item;
}

/** 子 agent 那一行（带一个「中断当前一轮」按钮）。 */
function subagentItem(state: UiState, row: SubagentView): HTMLElement {
    const item = el('div', 'dsh-activity-item dsh-subagent');
    item.dataset.tone = row.status === 'running' ? 'busy' : row.kind === 'diagnostic' ? 'warn' : 'idle';

    const head = el('div', 'dsh-activity-item-head');
    head.appendChild(el('span', 'dsh-activity-badge', SUBAGENT_STATUS_TEXT[row.status] ?? row.status));
    head.appendChild(el('span', 'dsh-activity-kind', row.mode === 'continuable' ? '可继续' : '一次性'));
    if (row.depth !== null) head.appendChild(el('span', 'dsh-activity-id', `第 ${row.depth} 层`));
    /**
     * 「中断」只对**活着的**子 agent 有意义（`ready` = 它只在磁盘上，运行时里没有它的 agent）。
     * 按钮做不出来的时候不画一个禁用的假按钮 —— 直接不画。
     */
    if (row.status !== 'ready') {
        const stop = el('button', 'dsh-btn dsh-activity-stop', '中断当前一轮') as HTMLButtonElement;
        stop.title = '只停它当前这一轮 —— 会话与上下文都留着（同「停止本轮」）';
        stop.addEventListener('click', () => {
            stop.disabled = true;
            void (async () => {
                try {
                    const reply = await call<{ ok: boolean; error?: string }>(MSG.subagentInterrupt, { subagentId: row.id });
                    if (!reply?.ok) setBanner(state, `中断失败：${reply?.error ?? '未知原因'}`, 'error', undefined, 6_000);
                } catch (error) {
                    setBanner(state, `中断失败：${String(error)}`, 'error', undefined, 6_000);
                } finally {
                    stop.disabled = false;
                    void readActivity(state, { quiet: true });
                }
            })();
        });
        head.appendChild(stop);
    }
    item.appendChild(head);

    item.appendChild(
        el('div', 'dsh-activity-label', row.label || `（这条子 agent 没给说明）${row.id.slice(0, 8)}…`),
    );

    const meta: string[] = [`${row.id.slice(0, 8)}…`];
    if (row.hasChildren) meta.push('它自己还带了下级');
    if (row.kind === 'diagnostic') meta.push(`这条记录本身有问题：${row.reason ?? '原因不明'}`);
    // ⚠ 两个字段都在，但含义完全不同，所以都要说出来
    meta.push(row.activity === 'running' ? '会话记录在内存里' : '会话记录只在磁盘上');
    item.appendChild(el('div', 'dsh-activity-meta', meta.join(' · ')));
    return item;
}

/**
 * 画活动抽屉（每次整块重建，理由与另外两个抽屉相同：内容是「问一次的答案」）。
 *
 * ## 三句必须画出来的话
 *
 * 1. **后台任务的输出看不到** —— 不是没做，是**不能做**：每个 job 只有一个消费游标，
 *    面板读一次就会让模型的 `job_output` 变成 `(no new output)`。
 * 2. **这些数字只活在内存里** —— agent 停掉之后就查无此物（历史会话看不到它们）。
 * 3. **服务没挂时说清是哪个服务** —— 与「读失败」分开说。
 */
function renderActivity(state: UiState): void {
    const body = state.activityBody;
    if (!body) return;
    body.textContent = '';

    const activity = state.activity;
    if (state.activityNoteEl) {
        // 三句话的优先级：**读不出来 / 没起 agent 的原因** > 读到几点 > 还没有读数
        const note = state.activityNote ?? (activity ? `读到 ${formatTime(activity.at)} · 这两块只活在运行时进程的内存里（agent 停掉就没了）` : '');
        state.activityNoteEl.textContent = note;
        state.activityNoteEl.dataset.tone = state.activityNote ? 'warn' : '';
    }

    if (!activity) {
        body.appendChild(
            el('div', 'dsh-usage-source', '还没有读数 —— 点上面的「刷新」，或者先让 agent 跑起来（这两块在内存里）。'),
        );
        return;
    }

    // ---- 上半块：后台任务
    body.appendChild(usageBlock('后台任务', activityAvailableLines(activity, 'jobs')));
    if (activity.jobsAvailable) {
        if (activity.jobs.length === 0) {
            body.appendChild(el('div', 'dsh-usage-source', '现在没有后台任务。'));
        } else {
            const list = el('div', 'dsh-activity-list');
            for (const job of activity.jobs) list.appendChild(jobItem(job, state.snapshot?.sessionId ?? null));
            body.appendChild(list);
            // ⚠ 这句是「如实说明」而不是免责：用户最想看的恰恰是输出
            body.appendChild(
                el(
                    'div',
                    'dsh-usage-source',
                    '看不到任务的输出 —— 每个后台任务只有一个消费游标，面板读一次就会把模型的 job_output 变成「(no new output)」。' +
                        '想看输出就在对话里让模型调 job_output。',
                ),
            );
        }
    }

    // ---- 下半块：子 agent
    body.appendChild(usageBlock('子 agent', activityAvailableLines(activity, 'subagents')));
    if (activity.subagentsAvailable) {
        if (activity.subagents.length === 0) {
            body.appendChild(el('div', 'dsh-usage-source', '没有子 agent。'));
        } else {
            const list = el('div', 'dsh-activity-list');
            for (const row of activity.subagents) list.appendChild(subagentItem(state, row));
            body.appendChild(list);
            body.appendChild(
                el(
                    'div',
                    'dsh-usage-source',
                    '「一次性」的子 agent 结构上不能再发消息（只有「可继续」的能接着聊）；「中断」只停它当前这一轮，会话与上下文都留着。',
                ),
            );
        }
    }

    if (activity.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of activity.notes) notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}

/**
 * 一块的「不可用」那几行（服务没挂时说清是哪个服务，而不是画一个空列表）。
 *
 * @returns 可直接塞进 `usageBlock` 的元素数组（可用时是空数组）。
 */
function activityAvailableLines(activity: ActivityView, which: 'jobs' | 'subagents'): HTMLElement[] {
    const available = which === 'jobs' ? activity.jobsAvailable : activity.subagentsAvailable;
    if (available) return [];
    const reason = which === 'jobs' ? activity.jobsReason : activity.subagentsReason;
    return [el('div', 'dsh-usage-source', reason ?? `这个 profile 没挂 ${which} 服务，所以看不到。`)];
}

/** 开/关活动抽屉（打开时顺手问一次 —— 它没有任何后台推送，不问就永远是空的）。 */
function toggleActivity(state: UiState, open?: boolean): void {
    const next = open ?? !state.activityOpen;
    state.activityOpen = next;
    if (state.activityHost) state.activityHost.hidden = !next;
    if (next) {
        renderActivity(state);
        void readActivity(state);
    }
}

/**
 * 现在该不该问一次活动。
 *
 * 三个条件任意一个成立就问，否则**一次都不问**（空闲时省 IPC）：
 * ① 抽屉开着（用户正在看，必须新）；② 这一轮在跑（随时可能有新任务）；
 * ③ 芯片还亮着（有东西没结束 —— 跑完之后也得继续问，否则芯片会一直亮着一个早就结束的任务）。
 */
function shouldPollActivity(state: UiState): boolean {
    if (state.activityBusy) return false;
    if (Date.now() - state.activityAt < ACTIVITY_POLL_MS) return false;
    if (state.activityOpen) return true;
    if (state.snapshot?.running) return true;
    return state.activityChip !== null && state.activityChip.hidden === false;
}

/** 当前「正在干什么」（状态行左半边）。 */
function liveText(state: UiState): { text: string; tone: 'busy' | 'error' | 'idle' } {
    const snapshot = state.snapshot;
    if (!snapshot) return { text: '读取状态…', tone: 'idle' };
    if (snapshot.status === 'error') return { text: snapshot.lastError ?? '出错', tone: 'error' };
    if (snapshot.running) {
        // 最后一个还没结果的工具 = 当前在跑的那个
        let runningTool = '';
        for (const entry of state.entries.values()) {
            if (entry.kind === 'tool' && entry.tool && !entry.tool.done) runningTool = entry.tool.name;
        }
        return { text: runningTool ? `运行中：${runningTool}` : '思考中…', tone: 'busy' };
    }
    return { text: STATUS_TEXT[snapshot.status] ?? snapshot.status, tone: 'idle' };
}

// ---------------------------------------------------------------- 交互（人机之间那一问）

/**
 * 交互块的「签名」：交互集合 + 已提交集合。
 *
 * 为什么要签名而不是每次都重画：`refreshState` 每 800ms（跑动时 300ms）跑一次，而这块
 * 里面有**用户正在敲的自定义回答**与刚点出来的选中态 —— 重建 DOM 会把它们抹掉。
 * 只有「问了什么」或「提交过没有」变了才重画。
 *
 * @param list - 当前在等的交互。
 * @param sent - 已提交回答的 id。
 * @returns 可比较的字符串。
 */
function interactionSignature(list: InteractionView[], sent: Set<string>): string {
    return JSON.stringify([
        [...sent].sort(),
        list.map((view) => [view.id, view.kind, (view.questions ?? []).map((question) => question.id).join(',')]),
    ]);
}

/** 卡片里某道题的「其他」输入框当前值（没写就是空串）。 */
function customValueOf(card: HTMLElement, questionId: string): string {
    for (const input of card.querySelectorAll<HTMLInputElement>('.dsh-interaction-input')) {
        if (input.dataset.question === questionId) return input.value.trim();
    }
    return '';
}

/**
 * 把卡片上的选中态与自定义输入收成答案（**从 DOM 读**，不另存一份状态）。
 *
 * 从 DOM 读的理由：DOM 就是用户看到的那个真相，另存一份必然出现「显示与实际不一致」
 * （渲染被跳过 / 重画时机不同步）。代价是必须在重建前读 —— 所以提交与重建是分开的两步。
 *
 * @param card - 卡片元素。
 * @param view - 它对应的交互。
 * @returns 合法答案（空数组 = 用户什么都没选也没写）。
 */
function collectAnswers(card: HTMLElement, view: InteractionView): InteractionAnswerItem[] {
    const out: InteractionAnswerItem[] = [];
    for (const question of view.questions ?? []) {
        const selected: string[] = [];
        for (const button of card.querySelectorAll<HTMLButtonElement>('.dsh-interaction-option')) {
            if (button.dataset.question === question.id && button.dataset.on === '1') selected.push(button.textContent ?? '');
        }
        const custom = customValueOf(card, question.id);
        if (selected.length === 0 && !custom) continue;
        out.push({ id: question.id, selected, ...(custom ? { custom } : {}) });
    }
    return out;
}

/**
 * 把决定交给主进程（再由它转给插件）。
 *
 * 三条口径：
 * 1. **先记 `interactionSent` 再发** —— 提交到卡片消失之间有一小段（主进程 → 插件 → 回执
 *    → 广播），不禁用按钮的话连点两下会发两次（第二次被插件当竞态拒掉，用户看到的是
 *    「点了没反应」）；
 * 2. **失败要把记号退掉** —— 否则卡片永远卡在「已提交…」上，而其实什么都没发生；
 * 3. **不猜结果**：卡片由主进程广播的新状态收掉，面板不自己删（否则插件的 settled 与
 *    面板的乐观删除会打架）。
 *
 * @param state - 面板状态。
 * @param view - 要回答的交互。
 * @param decision - 决定（answer / dismiss / delegate）。
 */
async function answerInteraction(state: UiState, view: InteractionView, decision: InteractionDecision): Promise<void> {
    if (state.interactionSent.has(view.id)) return;
    state.interactionSent.add(view.id);
    renderInteractions(state);
    try {
        const reply = await call<{ ok: boolean; error?: string }>(MSG.interactionAnswer, decision);
        if (!reply?.ok) {
            state.interactionSent.delete(view.id);
            renderInteractions(state);
            setBanner(state, reply?.error ?? '回答没有送出去', 'error', [], BANNER_HOLD.ERROR);
        }
    } catch (error) {
        state.interactionSent.delete(view.id);
        renderInteractions(state);
        setBanner(state, `回答失败：${error instanceof Error ? error.message : String(error)}`, 'error', [], BANNER_HOLD.ERROR);
    }
}

/**
 * 画一张交互卡片。
 *
 * 三种样子，一份数据：
 * - `approval`（授权请求）：工具名 + 理由 + 「允许一次 / 拒绝」；
 * - `plan-review`（计划评审）：它就是带 `intent` 的一道题，`detail` 是那份计划 markdown；
 * - 普通提问：问题 + 选项（可多选）+ 自定义输入。
 *
 * @param state - 面板状态。
 * @param view - 交互。
 * @returns 卡片元素。
 */
function buildInteractionCard(state: UiState, view: InteractionView): HTMLElement {
    const sent = state.interactionSent.has(view.id);
    const questions = view.questions ?? [];
    const planReview = view.kind === 'question' && questions[0]?.intent?.kind === 'plan-review';

    const card = el('div', 'dsh-interaction-card');
    card.dataset.kind = view.kind === 'approval' ? 'approval' : planReview ? 'plan' : 'question';

    const head = el('div', 'dsh-interaction-head');
    head.appendChild(el('span', 'dsh-interaction-badge', view.kind === 'approval' ? '需要你批准' : planReview ? '计划评审' : '模型在等你回答'));
    const source = view.toolName ?? (view.agentId ? `agent ${view.agentId.length > 16 ? view.agentId.slice(0, 8) : view.agentId}` : '');
    if (source) {
        const tag = el('span', 'dsh-interaction-source', source);
        tag.title = `${view.agentId ? `agent ${view.agentId}` : ''}${view.sessionId ? `\n会话 ${view.sessionId}` : ''}`;
        head.appendChild(tag);
    }
    const close = el('button', 'dsh-icon-btn', '✕') as HTMLButtonElement;
    close.title = view.kind === 'approval' ? '关掉这次授权请求（按「取消」处理）' : '关掉不回答（模型会当作「你要插话」，本轮结束）';
    close.disabled = sent;
    close.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'dismiss' }));
    head.appendChild(close);
    card.appendChild(head);

    /** 单选 + 只有一道题 = 点一下就是答案（最常见的形态，少一次点击）。 */
    const single = questions.length === 1 && questions[0].multiSelect !== true;
    /** 单选那道题的「其他」输入框（它的内容决定要不要露出「提交回答」）。 */
    let singleInput: HTMLInputElement | null = null;

    const body = el('div', 'dsh-interaction-body');
    if (view.kind === 'approval') {
        body.appendChild(el('div', 'dsh-interaction-question', `要执行：${view.toolName ?? '(未知工具)'}`));
        if (view.reason) body.appendChild(el('div', 'dsh-interaction-reason', view.reason));
    } else {
        for (const question of questions) {
            const block = el('div', 'dsh-interaction-question-block');
            if (question.header) block.appendChild(el('div', 'dsh-interaction-header', question.header));
            block.appendChild(el('div', 'dsh-interaction-question', question.question));
            if (question.detail) {
                const detail = el('div', 'dsh-interaction-detail');
                renderMarkdown(detail, question.detail);
                block.appendChild(detail);
            }
            const options = el('div', 'dsh-interaction-options');
            for (const option of question.options ?? []) {
                const button = el('button', 'dsh-interaction-option', option.label) as HTMLButtonElement;
                button.dataset.question = question.id;
                button.dataset.on = '0';
                if (option.description) button.title = option.description;
                // 「批准」那一项标绿：intent 用**名字**指定，面板不许按顺序猜（同 DSH 口径）
                if (question.intent?.approve === option.label) button.dataset.role = 'approve';
                button.disabled = sent;
                button.addEventListener('click', () => {
                    if (single && !customValueOf(card, question.id)) {
                        void answerInteraction(state, view, {
                            id: view.id,
                            action: 'answer',
                            answers: [{ id: question.id, selected: [option.label] }],
                        });
                        return;
                    }
                    button.dataset.on = button.dataset.on === '1' ? '0' : '1';
                });
                options.appendChild(button);
            }
            if ((question.options ?? []).length > 0) block.appendChild(options);
            const input = el('input', 'dsh-interaction-input') as HTMLInputElement;
            input.type = 'text';
            input.spellcheck = false;
            input.disabled = sent;
            input.dataset.question = question.id;
            input.placeholder = (question.options ?? []).length > 0 ? '其他（可留空 —— 想自己写一句就填这里）' : '写下你的回答';
            block.appendChild(input);
            if (single) singleInput = input;
            body.appendChild(block);
        }
    }
    card.appendChild(body);

    const actions = el('div', 'dsh-interaction-actions');
    if (view.kind === 'approval') {
        const allow = el('button', 'dsh-btn dsh-interaction-allow', '允许一次') as HTMLButtonElement;
        allow.title = '只批准这一次（DSH 的 allowed-once：授权不跨调用保留）';
        allow.disabled = sent;
        allow.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'answer', outcome: 'allowed-once' }));
        const deny = el('button', 'dsh-btn', '拒绝') as HTMLButtonElement;
        deny.disabled = sent;
        deny.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'answer', outcome: 'rejected' }));
        actions.appendChild(allow);
        actions.appendChild(deny);
    } else {
        const submit = el('button', 'dsh-btn dsh-interaction-submit', sent ? '已提交…' : '提交回答') as HTMLButtonElement;
        submit.disabled = sent;
        submit.addEventListener('click', () => {
            const answers = collectAnswers(card, view);
            if (answers.length === 0) {
                setBanner(state, '选一个选项，或者写一句自定义回答。', 'info', [], BANNER_HOLD.INFO);
                return;
            }
            void answerInteraction(state, view, { id: view.id, action: 'answer', answers });
        });
        if (single) {
            /*
             * 单选：点选项本身就是答案，所以**默认不给「提交回答」按钮**（计划评审上多一个按钮
             * 只会让人犹豫点哪个）。但「其他」框一旦写了字就得有地方按 —— 否则用户敲完
             * 无处提交，而点选项又会把刚写的字丢掉（见 `collectAnswers` 的口径）。
             */
            const sync = () => {
                const typed = (singleInput?.value.trim() ?? '') !== '';
                if (typed && !actions.contains(submit)) actions.appendChild(submit);
                if (!typed && actions.contains(submit)) submit.remove();
            };
            singleInput?.addEventListener('input', sync);
            sync();
        } else {
            actions.appendChild(submit);
        }
    }
    card.appendChild(actions);
    return card;
}

/**
 * 画全部交互块（0 条时整块收起，不占位）。
 *
 * @param state - 面板状态。
 */
function renderInteractions(state: UiState): void {
    const host = state.interactionHost;
    if (!host) return;
    const list = state.interactions ?? [];
    // 已经消失的交互，把「刚提交过」的记号一起清掉（否则同一个 id 复用时会误禁用）
    for (const id of [...state.interactionSent]) {
        if (!list.some((view) => view.id === id)) state.interactionSent.delete(id);
    }
    const sig = interactionSignature(list, state.interactionSent);
    if (sig === state.interactionSig) return;
    state.interactionSig = sig;
    host.textContent = '';
    host.hidden = list.length === 0;
    for (const view of list) host.appendChild(buildInteractionCard(state, view));
}

/** 拉一次状态（状态点、头顶两行、状态行、横幅、空态、外观）。 */
async function refreshState(state: UiState): Promise<void> {
    let reply: StateReply;
    try {
        reply = await call<StateReply>(MSG.getState);
    } catch {
        return; // 主进程忙/面板刚挂载：下一轮再说
    }
    if (!reply?.ok || !reply.agent) return;
    state.snapshot = reply.agent;
    state.interactions = Array.isArray(reply.agent.interactions) ? reply.agent.interactions : [];
    if (reply.settings) state.settings = reply.settings;
    applyAppearance(state);

    if (state.dot) {
        state.dot.dataset.state = reply.agent.status;
        state.dot.title = STATUS_TEXT[reply.agent.status] ?? reply.agent.status;
    }
    const settings = state.settings;
    if (state.title) {
        /**
         * 标题栏：有会话标题就显示它，没有才显示品牌名。
         *
         * 标题来自会话日志里的 `session/title` 事件（`dsh-session-title` 追加的仅写日志事件）。
         * 它**先粗后细**地跳一次是正常的：确定性回退（首条用户消息的前几个词）同步就有，
         * `session-title-llm`（本 profile 已重新启用）要另发一次模型请求、晚一两秒才覆盖它。
         * 完整标题放 `title` 属性里 —— 窄面板一行放不下，但鼠标停上去要能看全。
         */
        const title = reply.agent.title;
        state.title.textContent = title || `DSH · ${PROFILE_NAME}`;
        state.title.title = title ? `会话标题：${title}` : `DSH · ${PROFILE_NAME}（这条会话还没有标题）`;
    }
    if (state.sub) {
        const parts: string[] = [];
        if (settings) parts.push(`${settings.provider}/${settings.model}`);
        if (reply.agent.status === 'ready' && reply.agent.lastBootMs) {
            parts.push(`启动 ${(reply.agent.lastBootMs / 1000).toFixed(1)}s`);
        }
        if (reply.agent.pid) parts.push(`pid ${reply.agent.pid}`);
        const text = parts.join(' · ') || STATUS_TEXT[reply.agent.status] || '';
        state.sub.textContent = text;
        state.sub.title = text;
    }
    if (state.live) {
        const live = liveText(state);
        state.live.textContent = live.text;
        state.live.dataset.tone = live.tone === 'busy' ? 'busy' : live.tone === 'error' ? 'error' : '';
        state.live.title = live.text;
    }
    if (state.meta) {
        const parts: string[] = [];
        if (settings) parts.push(`effort ${settings.reasoningEffort || '默认'}`);
        if (reply.agent.sessionId) parts.push(`会话 ${reply.agent.sessionId.slice(0, 8)}`);
        if (state.entries.size > 0) parts.push(`${state.entries.size} 条`);
        const text = parts.join(' · ');
        state.meta.textContent = text;
        state.meta.title = text;
    }
    // 状态行那颗「上下文 xx%」：数据是主进程随快照一起发下来的（`usage` / `usageNote`）
    renderUsageChip(state);
    // 那颗「待办 x/y」同理（数据来自 `progress` / `progressNote`）
    renderProgressChip(state);
    // 抽屉开着就一直跟着刷新（回合结束/跑完命令时主进程会重读并广播；清单是实时广播的）
    if (state.usageOpen) renderUsage(state);
    if (state.progressOpen) renderProgress(state);

    // 按钮可用性：发送要就绪，新会话要就绪，「启动/停止」按状态变形，重启只在跑着时才有意义
    const ready = reply.agent.status === 'ready';
    const settled = reply.agent.status === 'stopped' || reply.agent.status === 'error';
    if (state.sendButton) state.sendButton.disabled = !ready;
    const btnNew = state.root?.querySelector<HTMLButtonElement>('#btn-new');
    if (btnNew) btnNew.disabled = !ready;

    /**
     * 一个按钮干两件事：没跑时是「启动」，跑着时是「停止」。
     *
     * 之前只有「停止」一个状态 —— 用户把 agent 停掉之后**没有任何办法再起来**
     * （唯一的入口是重开面板 / 重启编辑器，`autoStart` 还只在「从没起过」时才触发），
     * 这就是「停止后没有重启按钮」这个坑的来源。
     */
    const btnStop = state.root?.querySelector<HTMLButtonElement>('#btn-stop');
    if (btnStop) {
        btnStop.textContent = settled ? '启动' : '停止';
        btnStop.title = settled
            ? '启动 agent（会自动接上上次的会话）'
            : '停掉整个 agent 进程（只想打断这一轮请用输入框旁的「停止本轮」）';
        btnStop.disabled = reply.agent.status === 'starting' || reply.agent.status === 'stopping' || reply.agent.status === 'installing';
    }

    /**
     * 「停止本轮」：**只在真的在跑的时候出现**。
     *
     * 为什么不是常驻置灰：面板宽度最小 380px，输入区已经很挤；而且这个按钮
     * 「现在没用」的语义很强（没在跑就是没得停）。淡入淡出交给 `hidden`，不占位。
     *
     * 为什么不是「发送」按钮变脸：发送与中断是两件事，`followup` 允许在跑的时候
     * 再排一句（会在这一轮之后执行）。把发送按钮改成中断会**顺手拿走排队的能力**。
     */
    const btnInterrupt = state.root?.querySelector<HTMLButtonElement>('#btn-interrupt');
    if (btnInterrupt) {
        btnInterrupt.title =
            '中断当前这一轮（DSH 的 Agent.cancel：停掉这一轮，会话与上下文都保留，可以接着说）\n' +
            '想连 agent 进程一起停，用右上角的「停止」。';
    }
    syncInterruptButton(state);
    const btnRestart = state.root?.querySelector<HTMLButtonElement>('#btn-restart');
    if (btnRestart) {
        btnRestart.disabled = !ready;
        btnRestart.title = ready ? '重启 agent（重启后会自动接上上次的会话）' : '先启动 agent 才能重启';
    }
    if (state.resumeButton) state.resumeButton.disabled = !ready;

    renderHistoryBar(state);
    // 交互块：广播是主路，这里兜一次（面板刚打开时靠它把「已经在等的那一问」画出来）
    renderInteractions(state);

    if (reply.profile && reply.profile.ok === false) {
        // profile 同步失败会直接导致 agent 起不来（或起来的是旧插件），必须显眼。
        setBanner(
            state,
            `dsh profile 同步失败：${reply.profile.error ?? '未知原因'}\n（agent 会用到 $DSH_HOME/profiles/cocos；可点下面按钮重试）`,
            'error',
            [
                { label: '修复 profile', run: () => void repairProfile(state) },
                { label: '重试启动', run: () => void startAgent(state) },
            ],
        );
    } else if (reply.agent.status === 'error' && reply.agent.lastError) {
        setBanner(state, reply.agent.lastError, 'error', [{ label: '重试', run: () => void startAgent(state) }]);
    } else if (reply.agent.status !== 'starting' && Date.now() >= state.bannerUntil) {
        setBanner(state, null);
    }

    // 空态跟着状态走
    if (state.entries.size === 0) {
        if (state.emptyEl) state.emptyEl.remove();
        state.emptyEl = null;
        renderEmpty(state, reply.agent.status === 'ready' ? 'no-messages' : 'no-agent');
    }

    syncTyping(state);
    syncLiveBlocks(state);

    // 设置里的自动启动：只在「确实没起过」时触发
    if (reply.agent.status === 'stopped' && reply.settings?.autoStart && !state.startRequested && state.entries.size === 0) {
        void startAgent(state);
    }
}

/** 拉一次增量转写。@returns 是否拿到新条目（决定要不要顺带刷状态）。 */
async function pollOnce(state: UiState): Promise<boolean> {
    try {
        const reply = await call<{ ok: boolean; entries?: Entry[]; revision?: number; generation?: number }>(MSG.getEvents, {
            since: state.maxRev,
        });
        // 代数变了 = 主进程换了会话/回放了历史：先整块重画，再收这一批
        if (reply?.ok && typeof reply.generation === 'number' && reply.generation !== state.generation) {
            resetUi(state, reply.generation);
        }
        if (reply?.ok && typeof reply.revision === 'number') state.maxRev = Math.max(state.maxRev, reply.revision);
        if (reply?.ok && Array.isArray(reply.entries) && reply.entries.length > 0) {
            applyEntries(state, reply.entries);
            return true;
        }
    } catch {
        /* 下一轮再说 */
    }
    return false;
}

/** 合并一批条目：贴底时跟着滚，不然保持用户的位置。 */
function applyEntries(state: UiState, entries: Entry[]): void {
    const body = state.body;
    const pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 48;
    if (state.emptyEl && entries.length > 0) {
        state.emptyEl.remove();
        state.emptyEl = null;
    }
    const pendingJump = state.jumpTo !== null;
    const changed = mergeEntries(state, entries);
    // ⚠ 有「要滚到的那一条」时不许贴底：短会话会被这句 `scrollTop = scrollHeight` 顶到最后，
    // 于是刚刚 `scrollIntoView` 过去的位置当场被覆盖（`applyJump` 在下面跑）。
    if (changed && pinned && !pendingJump) {
        // 等一帧再滚：刚插入的内容还没量高度
        requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
        });
    }
    // 「搜到的就是这一条」：条目真的到了面板上才滚得动（回放是主进程的副作用）
    if (changed) applyJump(state);
}

/** 应用广播推来的更新（与轮询走同一套合并逻辑）。 */
function applyBroadcast(state: UiState, update: unknown): void {
    const payload = update as HostUpdateView | undefined;
    if (!payload) return;
    if (payload.running !== undefined && state.snapshot) state.snapshot.running = payload.running;
    if (payload.status && state.snapshot) state.snapshot.status = payload.status;
    // 广播也可能带来「换会话」（清空 + 代数为证），处理口径与轮询一致
    if (typeof payload.generation === 'number' && payload.generation !== state.generation) {
        resetUi(state, payload.generation);
    }
    if (Array.isArray(payload.entries) && payload.entries.length > 0) applyEntries(state, payload.entries as Entry[]);
    // 交互是整份来的（不是增量）：一问一答就是「现在必须点一下」，等轮询最坏要慢近一秒
    if (Array.isArray(payload.interactions)) {
        state.interactions = payload.interactions;
        renderInteractions(state);
    }
    // 标题也是整份来的。为什么值得走广播：它**异步**到（`session-title-llm` 要另发一次
    // 模型请求），靠 800ms 的轮询会明显迟到 —— 而"标题先粗后细地跳一次"正是它该有的样子。
    if (payload.title !== undefined && state.snapshot) {
        state.snapshot.title = payload.title;
        if (state.title) {
            state.title.textContent = payload.title || `DSH · ${PROFILE_NAME}`;
            state.title.title = payload.title ? `会话标题：${payload.title}` : `DSH · ${PROFILE_NAME}`;
        }
    }
    // 广播只带增量，revision 用它推游标；漏掉的部分靠轮询补齐
    if (typeof payload.revision === 'number' && payload.revision > state.maxRev) state.maxRev = payload.revision;
    // 用量也是整份来的（`null` = 明确「现在没有读数」）。走广播的理由：它是**回合结束**才刷的，
    // 而全量状态轮询是「每 5 跳」（空闲 4 秒）—— 靠它的话数字会晚好几秒才变。
    if (payload.usage !== undefined && state.snapshot) {
        state.snapshot.usage = payload.usage ?? null;
        state.snapshot.usageNote = payload.usageNote ?? null;
        renderUsageChip(state);
        if (state.usageOpen) renderUsage(state);
    }
    // 进度也是整份来的。它比用量更值得走广播：清单是 agent 在**回合中间**写的，
    // 而标记的正是「我现在做到哪一步」—— 靠轮询会明显迟到。
    if (payload.progress !== undefined && state.snapshot) {
        state.snapshot.progress = payload.progress ?? null;
        state.snapshot.progressNote = payload.progressNote ?? null;
        renderProgressChip(state);
        if (state.progressOpen) renderProgress(state);
    }
    // 运行状态是广播里最新的，立刻反映到状态行与「正在回复」上
    if (state.live) {
        const live = liveText(state);
        state.live.textContent = live.text;
        state.live.dataset.tone = live.tone === 'busy' ? 'busy' : live.tone === 'error' ? 'error' : '';
    }
    syncTyping(state);
    syncLiveBlocks(state);
    syncInterruptButton(state);
}

/**
 * 「停止本轮」按钮的显隐 —— **广播与轮询两条路都要调**。
 *
 * 只放在 `refreshState` 里会慢半拍：面板在跑的时候靠广播推增量，而 `refreshState`
 * 只在「有新条目」或每 N 跳才跑一次，于是「模型刚开始想 → 按钮该出现」会晚几百毫秒。
 * 而 `payload.running` 恰好就在每一次广播里，顺手同步是最便宜的。
 *
 * @param state - 面板状态。
 */
function syncInterruptButton(state: UiState): void {
    const running = state.snapshot?.running === true;
    // 这一轮真的收尾之后，「正在中断」这个临时态自己复位（不必等谁去清）
    if (!running) state.interrupting = false;
    const button = state.root?.querySelector<HTMLButtonElement>('#btn-interrupt');
    if (!button) return;
    const shouldHide = !running;
    if (button.hidden !== shouldHide) button.hidden = shouldHide;
    button.disabled = !running || state.interrupting === true;
}

// ---------------------------------------------------------------- 输入触发器
//
// `/` 斜杠命令 与 `@` 路径引用 —— 两样能力**都在宿主里**（`ctx.commands` /
// `ctx.fileReferences`），SDK 协议一个都表达不了，所以经插件控制帧借过来
// （见 `dsh-host.ts` 的「服务通道」一节）。
//
// ## 三条口径（都是踩过的那种）
//
// 1. **一个容器、一套键盘协议**：两者永远不会同时出现，共用一个 `#popup` 与
//    ↑↓ 选 / Enter·Tab 认 / Esc 关。两套实现必然在其中一套上漏掉一个键。
// 2. **不做浮层**（与历史抽屉、图片选择器同一摆法）：窄面板里浮层要自己算位置，
//    而输入框会长高、对话区会滚动 —— 结果就是"菜单飘到别处"。挤在输入区上方一块，
//    位置永远是对的，代价只是把对话区挤矮一点。
// 3. **`/开头的整行输入不走模型**：它是命令，走 `commands/run`。这条不是优化，
//    是语义 —— 把 `/compact` 当普通消息发给模型，模型只会一脸茫然地回你一段话。

/** 弹出块最多画几条（再多也看不完，还会把对话区挤没）。 */
const POPUP_LIMIT = 12;

/**
 * `@` 候选缓存的 key 上限。
 *
 * `@` 补全是**每敲一个字符换一个查询串**，一次会话能攒下几百个 key（每个都是一个候选数组）。
 * 超了就整个清掉 —— 反正下一次查询会重新问，而提供方那边本来就有自己的索引缓存
 * （我们这层只是省一次 IPC）。
 */
const MENTION_CACHE_LIMIT = 200;

/**
 * 关掉弹出块。
 *
 * @param state - 面板状态。
 */
function closePopup(state: UiState): void {
    state.popupKind = null;
    state.popupItems = [];
    state.popupIndex = 0;
    if (state.popup) {
        state.popup.hidden = true;
        state.popup.textContent = '';
        delete state.popup.dataset.kind;
    }
}

/**
 * 画弹出块。
 *
 * 只在**内容变了**的时候重建 DOM（`popupKind` + 候选标签的签名）——
 * 与交互卡片同一个理由：这个块在输入过程中会被反复触发，重建 DOM 会把键盘高亮与
 * 鼠标悬停状态一起抹掉。
 *
 * @param state - 面板状态。
 */
function renderPopup(state: UiState): void {
    const host = state.popup;
    if (!host) return;
    if (state.popupKind === null || state.popupItems.length === 0) {
        closePopup(state);
        return;
    }
    // 签名**只含「哪些候选」**，不含高亮下标 —— 高亮是每一帧都要重算的便宜活，
    // 而重建 DOM 会把鼠标悬停/滚动位置一起清掉。把 index 放进签名就等于每按一次
    // 上下键重建整个列表（第一版就是这么写的，注释还写着"只动高亮"，实际那条路根本走不到）。
    const signature = `${state.popupKind}:${state.popupItems.map((item) => `${item.label}\u0000${item.detail}`).join('\u0001')}`;
    if (host.dataset.sig !== signature) {
        host.dataset.sig = signature;
        host.textContent = '';
        host.hidden = false;
        host.dataset.kind = state.popupKind;
        state.popupItems.forEach((item, index) => {
            const row = el('button', 'dsh-popup-item');
            row.type = 'button';
            // `mousedown` 而不是 `click`：click 之前输入框会先失焦，而失焦会关掉菜单
            // （`blur` 那条路见 `mount` 里的监听）——用 mousedown 抢在它前面。
            row.addEventListener('mousedown', (event: MouseEvent) => {
                event.preventDefault();
                state.popupIndex = index;
                acceptPopup(state);
            });
            row.appendChild(el('span', 'dsh-popup-label', item.label));
            if (item.detail) row.appendChild(el('span', 'dsh-popup-detail', item.detail));
            if (item.disabled) {
                row.disabled = true;
                row.dataset.disabled = 'true';
            }
            host.appendChild(row);
        });
    }
    // 高亮每次都重算（幂等、便宜），这样「重建」与「只换高亮」两条路共用同一段代码
    const rows = host.querySelectorAll<HTMLElement>('.dsh-popup-item');
    rows.forEach((row, index) => {
        if (index === state.popupIndex) row.dataset.active = 'true';
        else delete row.dataset.active;
    });
}

/**
 * 输入框内容变了之后重算弹出块（`/` 命令 与 `@` 路径）。
 *
 * @param state - 面板状态。
 */
function refreshPopup(state: UiState): void {
    const value = state.input.value;
    const caret = state.input.selectionStart ?? value.length;

    // ① 命令：整行以 `/` 开头、还没出现空白（见 `commandDraft` 的口径）
    const draft = commandDraft(value, caret);
    if (draft) {
        openCommandPopup(state, draft.query);
        return;
    }

    // ② `@` 路径：光标处那个活动 token
    const { line, col } = lineAt(value, caret);
    const token = activeAtToken(line, col);
    if (token) {
        openMentionPopup(state, token);
        return;
    }

    closePopup(state);
}

/**
 * 打开斜杠命令表。
 *
 * 命令表**按会话缓存**（`state.commands`），第一次敲 `/` 才拉 —— 面板挂载时就去拉是浪费：
 * 大多数会话从头到尾不用命令，而拉一次要走 IPC 到插件再查注册表。
 *
 * @param state - 面板状态。
 * @param query - `/` 之后已经敲的那一段（用来过滤）。
 */
function openCommandPopup(state: UiState, query: string): void {
    if (state.commands === null) {
        void loadCommands(state);
        return;
    }
    const needle = query.toLowerCase();
    const items = state.commands
        .filter((command) => !needle || command.name.toLowerCase().includes(needle))
        .slice(0, POPUP_LIMIT)
        .map((command) => ({
            label: `/${command.name}`,
            detail: `${command.description}${command.hint ? `  ${command.hint}` : ''}`,
            apply: () => {
                // 命令补全只把**命令行**填进输入框，不直接执行：
                // `/plan` 这类命令后面还要写参数（`/plan 把配表迁移到新口径`），
                // 自动执行等于替用户按了回车。
                state.input.value = `/${command.name}${command.hint ? ' ' : ''}`;
                state.input.focus();
                const end = state.input.value.length;
                state.input.setSelectionRange(end, end);
                autoGrow(state.input);
                saveDraft(state.input.value);
                closePopup(state);
            },
        }));
    if (items.length === 0) {
        // 打了一半没匹配：**关掉**而不是留一个空框（空框看起来像面板卡了）
        closePopup(state);
        return;
    }
    state.popupKind = 'command';
    state.popupItems = items;
    state.popupIndex = Math.min(state.popupIndex, items.length - 1);
    renderPopup(state);
}

/**
 * 拉一次命令表（只拉一次，失败就留空表并提示）。
 *
 * @param state - 面板状态。
 */
async function loadCommands(state: UiState): Promise<void> {
    // 先占位，避免同一次输入里连打几发（`null` 只表示"还没拉过"）
    state.commands = [];
    try {
        const reply = await call<{ ok: boolean; commands?: CommandView[]; error?: string }>(MSG.commandList);
        if (!reply?.ok) {
            setBanner(state, `读不到斜杠命令表：${reply?.error ?? '未知原因'}`, 'info', [], BANNER_HOLD.INFO);
            return;
        }
        state.commands = Array.isArray(reply.commands) ? reply.commands : [];
        // 拉回来时用户可能已经打完了命令名 —— 重算一次
        refreshPopup(state);
    } catch (error) {
        setBanner(state, `读不到斜杠命令表：${String(error)}`, 'info', [], BANNER_HOLD.INFO);
    }
}

/**
 * 打开 `@` 路径候选。
 *
 * 三条细节：
 * 1. **缓存按查询串**：`@` 补全每敲一个字符问一次，而提供方的第一次「裸查询」要把工作区
 *    索引一遍；同一个查询串（退格再打回来）直接吃缓存。
 * 2. **序号防乱序**：异步回来的结果带发起时的序号，对不上就丢 —— 否则打字快的时候
 *    旧结果会盖掉新结果，菜单里的候选看起来「跳回了上一个字符」。
 * 3. **候选为空时关掉菜单**：留一个空框比没有框更让人困惑。
 *
 * @param state - 面板状态。
 * @param token - `activeAtToken` 给的 token。
 */
function openMentionPopup(state: UiState, token: { prefix: string; query: string; quoted: boolean }): void {
    const cached = state.mentionCache.get(token.query);
    if (cached) {
        showMentionItems(state, token, cached);
        return;
    }
    const seq = ++state.mentionSeq;
    void (async () => {
        try {
            const reply = await call<{ ok: boolean; candidates?: ReferenceCandidate[]; error?: string }>(MSG.fileReference, {
                query: token.query,
            });
            if (seq !== state.mentionSeq) return;
            if (!reply?.ok) {
                // 这条**不弹横幅**：`@` 是边打字边问的，服务没挂时每敲一个字符弹一次红条会淹掉面板。
                closePopup(state);
                return;
            }
            const candidates = Array.isArray(reply.candidates) ? reply.candidates : [];
            state.mentionCache.set(token.query, candidates);
            // 缓存上限：`@` 是**每敲一个字符**换一个查询串的，一次会话能攒下几百个 key
            // （每个都是一个候选数组）。超了就整个清掉 —— 反正下一次查询会重新问，
            // 而且提供方那边本来就有索引缓存（我们这层只是省一次 IPC）。
            if (state.mentionCache.size > MENTION_CACHE_LIMIT) state.mentionCache.clear();
            showMentionItems(state, token, candidates);
        } catch {
            if (seq === state.mentionSeq) closePopup(state);
        }
    })();
}

/**
 * 把一批 `@` 候选画出来。
 *
 * @param state - 面板状态。
 * @param token - 触发这次查询的 token（应用补全时要拿它替换）。
 * @param candidates - 候选。
 */
function showMentionItems(state: UiState, token: { prefix: string; query: string; quoted: boolean }, candidates: ReferenceCandidate[]): void {
    const items = candidates
        .slice(0, POPUP_LIMIT)
        .map((candidate) => {
            const insertion = formatFileMention(candidate, token.quoted);
            return {
                label: candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path,
                detail: candidate.kind === 'directory' ? '目录（继续往下钻）' : '文件',
                disabled: insertion === undefined,
                apply: () => {
                    if (insertion === undefined) return;
                    const caret = state.input.selectionStart ?? state.input.value.length;
                    // ⚠ 用**当前**光标位置重算 token，而不是用发起查询时那个：
                    // 异步回来时用户可能又打了几个字符（那时 token 已经变长）。
                    // 拿不到活动 token 就不改任何东西（`replaceToken` 也会再兜一层）。
                    const { line, col } = lineAt(state.input.value, caret);
                    const live = activeAtToken(line, col);
                    if (!live) return;
                    const next = replaceToken(state.input.value, caret, live, insertion);
                    state.input.value = next.value;
                    state.input.focus();
                    state.input.setSelectionRange(next.caret, next.caret);
                    autoGrow(state.input);
                    saveDraft(state.input.value);
                    // 目录选中后**留在菜单里**（继续往下钻），文件选中即收工
                    if (candidate.kind === 'directory') refreshPopup(state);
                    else closePopup(state);
                },
            };
        });
    if (items.length === 0) {
        closePopup(state);
        return;
    }
    state.popupKind = 'mention';
    state.popupItems = items;
    state.popupIndex = 0;
    renderPopup(state);
}

/**
 * 键盘移动高亮。
 *
 * @param state - 面板状态。
 * @param delta - +1 往下，-1 往上（首尾循环）。
 */
function movePopup(state: UiState, delta: number): void {
    if (state.popupKind === null || state.popupItems.length === 0) return;
    const count = state.popupItems.length;
    state.popupIndex = (state.popupIndex + delta + count) % count;
    renderPopup(state);
}

/**
 * 认下当前高亮的那一条。
 *
 * @param state - 面板状态。
 * @returns 是否消费了这次回车/Tab（消费了就不该再走「发送」）。
 */
function acceptPopup(state: UiState): boolean {
    if (state.popupKind === null) return false;
    const item = state.popupItems[state.popupIndex];
    if (!item) return false;
    if (item.disabled) return true;
    item.apply();
    return true;
}

/**
 * 输入触发器/弹出块的键盘协议。返回 `true` = 这次按键已经被它吃掉。
 *
 * 为什么要在**捕获**阶段处理（`mount` 里挂 `keydown` 的那一段）：
 * Enter 默认是「发送」，而弹出块打开时 Enter 应该是「认下候选」。两者都在 keydown 上，
 * 谁先看到谁说了算 —— 由这里统一决断，`send` 那条路不再自己判。
 *
 * @param state - 面板状态。
 * @param event - 键盘事件。
 * @returns 是否已被弹出块消费。
 */
function handlePopupKey(state: UiState, event: KeyboardEvent): boolean {
    if (state.popupKind === null) return false;
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            movePopup(state, 1);
            return true;
        case 'ArrowUp':
            event.preventDefault();
            movePopup(state, -1);
            return true;
        case 'Tab':
            event.preventDefault();
            acceptPopup(state);
            return true;
        case 'Enter':
            // 组合输入（中文输入法）时的回车是在选字，不是认候选
            if (event.isComposing) return false;
            event.preventDefault();
            acceptPopup(state);
            return true;
        case 'Escape':
            event.preventDefault();
            closePopup(state);
            return true;
        default:
            return false;
    }
}

/**
 * 执行一条斜杠命令行（**不走模型**）。
 *
 * 结果由**主进程**写进转写（一条 note），所以这里不自己造条目 —— 只有一个真源，
 * 而且面板刷新 / 换会话 / 回放之后它还在（回放那条分支见 `handleSessionEvent`）。
 * 这里只负责：清空输入、失败时提示、把没发出去的命令放回去。
 *
 * @param state - 面板状态。
 * @param line - 完整命令行。
 */
async function runCommandLine(state: UiState, line: string): Promise<void> {
    if (state.snapshot?.status !== 'ready') {
        setBanner(state, 'agent 还没就绪，命令要连上会话才能执行。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    if (state.attachments.length > 0) {
        // 命令面现在没有图片入口（插件的 `commands/run` 一律传空图片数组）——
        // 与其静默丢掉用户贴的图，不如直说。
        setBanner(state, '斜杠命令暂不支持带图片附件（先把图去掉，或者在普通消息里发）。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    closePopup(state);
    state.input.value = '';
    autoGrow(state.input);
    saveDraft('');
    if (state.sendButton) state.sendButton.disabled = true;
    try {
        const reply = await call<{ ok: boolean; known?: boolean; kind?: string; text?: string; error?: string }>(MSG.commandRun, { line });
        if (!reply?.ok) {
            // 结果那条 note 由主进程写；这里只提示 + 把命令行放回去让用户改
            setBanner(state, reply?.error ?? '命令没有执行', 'error', [], BANNER_HOLD.ERROR);
            state.input.value = line;
            autoGrow(state.input);
            saveDraft(line);
        } else {
            setBanner(state, null);
        }
    } catch (error) {
        setBanner(state, `命令没有执行：${String(error)}`, 'error', [], BANNER_HOLD.ERROR);
        state.input.value = line;
        autoGrow(state.input);
        saveDraft(line);
    } finally {
        if (state.sendButton) state.sendButton.disabled = false;
        void pollOnce(state);
        void refreshState(state);
    }
}

/** 发送。 */
async function send(state: UiState): Promise<void> {
    const text = state.input.value.trim();
    // `/开头的整行输入是**命令**，不是给模型的消息（见本节顶部第 3 条口径）。
    // 判据只看首字节 —— 与 `dsh-commands` 的 `parseCommand` 一致。
    if (text.startsWith('/') && state.attachments.length === 0) {
        await runCommandLine(state, text);
        return;
    }
    const attachments = state.attachments;
    // 只有图没有字也允许（模型只看图）；两样都空才是没得发
    if (!text && attachments.length === 0) return;
    if (state.snapshot?.status !== 'ready') {
        setBanner(state, 'agent 还没就绪，先等它启动完成。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    if (state.imageBusy > 0) {
        setBanner(state, '图片还在处理（解码/缩放）中，稍等一下再发。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    state.input.value = '';
    autoGrow(state.input);
    saveDraft('');
    if (state.sendButton) state.sendButton.disabled = true;
    try {
        const result = await call<{ ok: boolean; error?: string }>(MSG.sendMessage, {
            text,
            // 只把协议需要的三个字段送出去（thumb/width/height 是面板自己的事）
            images: attachments.map((item) => ({ mimeType: item.mimeType, data: item.data, name: item.name })),
        });
        if (!result?.ok) {
            setBanner(state, result?.error ?? '发送失败', 'error', [], BANNER_HOLD.ERROR);
            // 失败时**把图和文字都留着**：用户的输入不能因为一次网络/校验错误就没了
            restoreDraft(state, text, attachments);
        } else {
            setBanner(state, null);
            rememberSentThumbs(state, attachments);
            state.attachments = [];
            renderAttachments(state);
        }
    } catch (error) {
        setBanner(state, `发送失败：${String(error)}`, 'error', [], BANNER_HOLD.ERROR);
        restoreDraft(state, text, attachments);
    } finally {
        if (state.sendButton) state.sendButton.disabled = false;
        void pollOnce(state);
        // 立刻刷一次状态：`running` 翻真后轮询才会切到 300ms（流式就是靠它顺起来的）
        void refreshState(state);
    }
}

/** 发送失败后把没发出去的东西放回输入区（只在用户还没开始打新内容时）。 */
function restoreDraft(state: UiState, text: string, attachments: Attachment[]): void {
    if (text && !state.input.value.trim()) {
        state.input.value = text;
        autoGrow(state.input);
        saveDraft(text);
    }
    if (attachments.length > 0) {
        state.attachments = attachments;
        renderAttachments(state);
    }
}

/** 记下发出去那几张图的缩略图（用户气泡里显示真图用，见 `renderEntryImages`）。 */
function rememberSentThumbs(state: UiState, attachments: Attachment[]): void {
    for (const item of attachments) {
        state.sentThumbs.set(item.name, item.thumb);
        while (state.sentThumbs.size > 12) {
            const oldest = state.sentThumbs.keys().next();
            if (oldest.done) break;
            state.sentThumbs.delete(oldest.value);
        }
    }
}

/** 输入框按内容长高（最多 8 行，再多就滚）。 */
function autoGrow(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}

/** 草稿读写（面板关掉再开不丢）。 */
function saveDraft(text: string): void {
    try {
        if (text) localStorage.setItem(DRAFT_KEY, text);
        else localStorage.removeItem(DRAFT_KEY);
    } catch {
        /* 隐私模式/被禁就没草稿，不影响用 */
    }
}

function loadDraft(): string {
    try {
        return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
        return '';
    }
}

/** 外观按钮：auto → dark → light 循环。 */
async function cycleTheme(state: UiState): Promise<void> {
    const current = state.settings?.theme ?? 'auto';
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    const saved = await call<{ ok: boolean; settings?: DshChatSettings }>(MSG.updateSettings, { theme: next });
    if (saved?.settings) state.settings = saved.settings;
    applyAppearance(state);
    updateThemeButton(state);
}

/** 外观按钮的图标/提示跟着当前档位走。 */
function updateThemeButton(state: UiState): void {
    const button = state.root?.querySelector<HTMLButtonElement>('#btn-theme');
    if (!button) return;
    const mode = state.settings?.theme ?? 'auto';
    button.textContent = THEME_GLYPH[mode];
    button.title = `外观：${THEME_LABEL[mode]}（点击切换）`;
}

/** 设置面板（就地编辑 + 保存）。 */
function toggleSettings(state: UiState): void {
    const host = state.settingsHost;
    if (!host) {
        console.warn('[dsh_chat] 面板里找不到设置容器 #settings（选择器没解析出来？）');
        return;
    }
    state.settingsOpen = !state.settingsOpen;
    host.hidden = !state.settingsOpen;
    if (!state.settingsOpen) return;

    const settings = state.settings;
    host.textContent = '';
    if (!settings) {
        host.textContent = '还没读到设置，稍后再试。';
        return;
    }

    const draft: Record<string, unknown> = { ...settings };

    /** 一个文本/数字输入行。 */
    const addInput = (group: string | null, key: keyof DshChatSettings, label: string, type: 'text' | 'number'): void => {
        if (group) host.appendChild(el('div', 'dsh-settings-group', group));
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const input = el('input');
        input.type = type;
        input.value = String(settings[key] ?? '');
        input.addEventListener('input', () => {
            draft[key as string] = type === 'number' ? Number(input.value) : input.value;
        });
        row.appendChild(input);
        host.appendChild(row);
    };

    /** 一个下拉行。 */
    const addSelect = (key: keyof DshChatSettings, label: string, options: Array<[string, string]>): void => {
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const select = el('select');
        for (const [value, text] of options) {
            const option = el('option', undefined, text);
            option.value = value;
            select.appendChild(option);
        }
        select.value = String(settings[key] ?? '');
        select.addEventListener('change', () => {
            draft[key as string] = select.value;
        });
        row.appendChild(select);
        host.appendChild(row);
    };

    /** 一个勾选行。 */
    const addCheckbox = (key: keyof DshChatSettings, label: string): void => {
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const input = el('input');
        input.type = 'checkbox';
        input.checked = Boolean(settings[key]);
        input.addEventListener('change', () => {
            draft[key as string] = input.checked;
        });
        row.appendChild(input);
        host.appendChild(row);
    };

    host.appendChild(el('div', 'dsh-settings-group', '外观'));
    addSelect('theme', '主题', [
        ['auto', '跟随编辑器'],
        ['dark', '深色'],
        ['light', '浅色'],
    ]);
    // 配色与明暗**正交**：明暗管 data-theme，配色管 data-palette（覆盖层见 editor-theme.css）
    addSelect('palette', '配色', [
        ['dsw', 'DSH 默认'],
        ['editor', '跟随 Cocos 编辑器（深色）'],
    ]);
    addSelect('fontSize', '正文字号', [
        ['0', '默认（14px）'],
        ['12', '12px'],
        ['13', '13px'],
        ['14', '14px'],
        ['15', '15px'],
        ['16', '16px'],
        ['17', '17px'],
    ]);

    host.appendChild(el('div', 'dsh-settings-group', '模型'));
    addInput(null, 'provider', 'provider', 'text');
    addInput(null, 'model', 'model', 'text');
    addInput(null, 'reasoningEffort', '推理档位', 'text');
    addInput(null, 'maxTokens', 'maxTokens', 'number');

    host.appendChild(el('div', 'dsh-settings-group', '运行时'));
    addInput(null, 'workdir', '工作目录', 'text');
    addInput(null, 'nodePath', 'node 路径', 'text');
    addInput(null, 'dshBin', 'dsh bin.js', 'text');
    addCheckbox('autoStart', '自动启动');
    addCheckbox('showStderrNotes', '显示 stderr');

    const hint = el('div', 'dsh-hint');
    hint.textContent =
        '留空 = 自动探测（node 走 PATH，dsh 从 PATH 上的 dsh/npm 推导）。改完点保存；' +
        'node/dsh 路径改了会立即重新探测（正在跑的 agent 不受影响，重启后生效）。';
    host.appendChild(hint);

    const actions = el('div', 'dsh-banner-actions');
    const save = el('button', 'dsh-btn', '保存');
    save.addEventListener('click', async () => {
        const saved = await call<{ ok: boolean; settings?: DshChatSettings }>(MSG.updateSettings, draft);
        if (saved?.settings) state.settings = saved.settings;
        applyAppearance(state);
        updateThemeButton(state);
        state.settingsOpen = false;
        host.hidden = true;
        await refreshState(state);
        toggleSettings(state);
    });
    const repair = el('button', 'dsh-btn', '修复 profile');
    repair.addEventListener('click', () => void repairProfile(state));
    const close = el('button', 'dsh-btn', '关闭');
    close.addEventListener('click', () => toggleSettings(state));
    actions.append(save, repair, close);
    host.appendChild(actions);
}

// ---------------------------------------------------------------- 挂载

/** 组装面板的交互（每个面板实例一次）。 */
function mount(ctx: any): UiState {
    const $ = ctx.$ ?? {};

    // 面板根节点：拿到它就能在里面按选择器补查（见下面 pick 的说明）。
    const root: HTMLElement | null =
        ($.root as HTMLElement) ??
        ($.body as HTMLElement)?.closest?.('.dsh-root') ??
        ($.body as HTMLElement)?.parentElement ??
        null;

    /**
     * 取元素：先信编辑器给的 `$`，拿不到再**在面板根节点里按同一个选择器查一次**。
     *
     * 为什么要这道兜底：`document.getElementById` 在这个环境里拿不到面板元素（实测），
     * 说明面板 DOM 不一定挂在模块所处的那个 document 上；而 `$` 偶尔漏一个键时，
     * 从根节点 scope 查询仍然能命中。两道都不行就返回 null，由调用方降级（只 warn 不抛）。
     */
    const pick = (key: string): HTMLElement | null => {
        const direct = $[key] as HTMLElement | undefined;
        if (direct) return direct;
        const selector = SELECTORS[key];
        if (!selector || !root) return null;
        try {
            return root.querySelector<HTMLElement>(selector);
        } catch {
            return null;
        }
    };

    const missing = Object.keys(SELECTORS).filter((key) => !pick(key));
    if (missing.length > 0) {
        // 只 warn 不抛：面板少个元素也要能开，否则用户在编辑器里只看到一条红错。
        console.warn(
            `[dsh_chat] 面板里没找到这些元素：${missing.join(', ')}（对应选择器 ${missing
                .map((k) => SELECTORS[k])
                .join(', ')}）`,
        );
    }

    const state: UiState = {
        root,
        dot: pick('dot'),
        title: pick('title'),
        sub: pick('sub'),
        banner: pick('banner'),
        settingsHost: pick('settings'),
        body: pick('body') as HTMLElement,
        input: pick('input') as HTMLTextAreaElement,
        sendButton: pick('btnSend') as HTMLButtonElement | null,
        live: pick('live'),
        meta: pick('meta'),
        historyBar: pick('historyBar'),
        historyBarText: pick('historyBarText'),
        history: pick('history'),
        historyList: pick('historyList'),
        historyNote: pick('historyNote'),
        historySearchEl: pick('historySearch') as HTMLInputElement | null,
        btnHistorySearch: pick('btnHistorySearch') as HTMLButtonElement | null,
        btnHistoryBack: pick('btnHistoryBack') as HTMLButtonElement | null,
        btnHistoryRefreshEl: pick('btnHistoryRefresh') as HTMLButtonElement | null,
        resumeButton: pick('btnResume') as HTMLButtonElement | null,
        usageOpen: false,
        usageHost: pick('usage'),
        usageBody: pick('usageBody'),
        usageNoteEl: pick('usageNote'),
        usageChip: pick('btnUsage') as HTMLButtonElement | null,
        btnUsageRefreshEl: pick('btnUsageRefresh') as HTMLButtonElement | null,
        usageBusy: false,
    // ---- 进度（待办清单 / 目标 / 回合目录）----
    progressOpen: false,
    progressHost: pick('progress'),
    progressBody: pick('progressBody'),
    progressNoteEl: pick('progressNote'),
    progressChip: pick('btnProgress') as HTMLButtonElement | null,
    btnProgressRefreshEl: pick('btnProgressRefresh') as HTMLButtonElement | null,
    // ---- 活动（后台任务 / 子 agent）----
    activityOpen: false,
    activityHost: pick('activity'),
    activityBody: pick('activityBody'),
    activityNoteEl: pick('activityNote'),
    activityChip: pick('btnActivity') as HTMLButtonElement | null,
    btnActivityRefreshEl: pick('btnActivityRefresh') as HTMLButtonElement | null,
    // 面板自己持有（**不在 AgentSnapshot 里**：这两块要专门打控制帧去问，见 UiState 的注释）
    activity: null,
    activityAt: 0,
    activityBusy: false,
    activityNote: null,
        historyQuery: '',
        historySessions: [],
        historySearch: null,
        historyBusy: false,
        historyConfirm: null,
        jumpTo: null,
        jumpTimer: null,
        els: new Map(),
        entries: new Map(),
        openTools: new Map(),
        collapsedThink: new Map(),
        maxRev: 0,
        maxSeq: 0,
        generation: 0,
        tick: 0,
        timer: null,
        polling: false,
        reportedResume: false,
        interrupting: false,
        snapshot: null,
        settings: null,
        settingsOpen: false,
        historyOpen: false,
        startRequested: false,
        bannerUntil: 0,
        emptyEl: null,
        typingEl: null,
        lastUserSeq: 0,
        broadcastHandler: null,
        interactionHost: pick('interaction'),
        interactions: [],
        interactionSent: new Set(),
        interactionSig: '',
        popup: pick('popup'),
        popupKind: null,
        popupItems: [],
        popupIndex: 0,
        commands: null,
        mentionCache: new Map(),
        mentionSeq: 0,
        attachments: [],
        attachHost: pick('attachments'),
        imageButton: pick('btnImage') as HTMLButtonElement | null,
        imageBusy: 0,
        picker: pick('picker'),
        pickerList: pick('pickerList'),
        pickerNote: pick('pickerNote'),
        pickerSearch: pick('pickerSearch') as HTMLInputElement | null,
        pickerOpen: false,
        pickerImages: null,
        pickerSource: '',
        pickerQuery: '',
        pickerThumbs: new Map(),
        pickerFailed: new Set(),
        pickerLoading: new Set(),
        pickerQueue: [],
        pickerObserver: null,
        sentThumbs: new Map(),
    };

    if (!state.body || !state.input) {
        console.warn('[dsh_chat] 面板缺少 #body 或 #input，UI 无法工作（请检查 static/template/default/index.html）');
        reportProbe({ kind: 'fatal', missing, hasBody: Boolean(state.body), hasInput: Boolean(state.input) });
        return state;
    }

    // 主题先按「跟随系统」画上，避免一进来是白底再跳成黑底
    applyAppearance(state);
    updateThemeButton(state);

    // 布局自检（结果回传主进程，面板高度塌了也还能报上来）
    const layout = ensureLayout(state);
    reportProbe({ kind: 'ready', missing, layout });

    renderEmpty(state, 'no-agent');

    // 草稿回填
    const draft = loadDraft();
    if (draft) {
        state.input.value = draft;
        autoGrow(state.input);
    }

    state.sendButton?.addEventListener('click', () => void send(state));
    state.input.addEventListener('input', () => {
        autoGrow(state.input);
        saveDraft(state.input.value);
        // 输入触发器（`/` 命令 与 `@` 路径）：每敲一个字符重算一次。
        // 这里是**唯一**触发点 —— 光标移动 / 点击不该重开菜单（那会把方向键抢走）。
        refreshPopup(state);
    });
    state.input.addEventListener('keydown', (event: KeyboardEvent) => {
        // 弹出块优先吃键（↑↓ 选 / Enter·Tab 认 / Esc 关）——
        // 否则 Enter 会被下面的「发送」抢走，候选永远选不上。
        if (handlePopupKey(state, event)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send(state);
        }
    });
    /**
     * 失焦时收掉菜单。
     *
     * 为什么要收：弹出块**不是浮层**（它占着对话区上方的一块版面），输入框不在焦点上时
     * 那一块就是白占地方。点候选走的是 `mousedown`（抢在失焦前面），所以这条不会打断选择。
     */
    state.input.addEventListener('blur', () => closePopup(state));

    /**
     * 粘贴：**只认图**。
     *
     * `preventDefault()` 只在「剪贴板里确实有图」时才调 —— 否则粘贴一段文字会被我们吃掉，
     * 而那是这个输入框最常用的操作。监听挂在**面板根节点**上（不只是 textarea）：
     * 焦点在输入框里是常态，但刚点完图片选择器时焦点可能在别处，那时 Ctrl+V 也该能用。
     * 事件冒泡到根节点即可，所以只挂一处。
     */
    const onPaste = (event: ClipboardEvent): void => {
        const images = imagesFromClipboard(event.clipboardData);
        if (images.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        reportProbe({ kind: 'paste', images: images.length, types: images.map((item) => item.blob.type) });
        void attachBlobs(state, images, 'clipboard');
    };
    (root ?? state.body).addEventListener('paste', onPaste as EventListener);
    state.input.addEventListener('paste', onPaste as EventListener);

    // 拖进来也算「加图」：三个来源（粘贴/选择器/拖拽）都落到 attachBlobs 这一条路上
    (root ?? state.body).addEventListener('dragover', (event: DragEvent) => {
        if (event.dataTransfer?.types?.includes('Files')) {
            event.preventDefault();
            if (root) root.dataset.drag = 'true';
        }
    });
    (root ?? state.body).addEventListener('dragleave', () => {
        if (root) delete root.dataset.drag;
    });
    (root ?? state.body).addEventListener('drop', (event: DragEvent) => {
        if (root) delete root.dataset.drag;
        const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
        const images = files
            .filter((file) => file.type.toLowerCase().startsWith('image/'))
            .map((file, index) => ({ blob: file as Blob, name: file.name || `拖进来的图片-${index + 1}` }));
        if (images.length === 0) return;
        event.preventDefault();
        void attachBlobs(state, images, 'drop');
    });

    // 图片按钮与选择器
    state.imageButton?.addEventListener('click', () => togglePicker(state));
    pick('btnPickerClose')?.addEventListener('click', () => togglePicker(state, false));
    pick('btnPickerRefresh')?.addEventListener('click', () => {
        state.pickerThumbs.clear();
        state.pickerFailed.clear();
        void ensurePickerList(state, true);
    });
    pick('btnPickerPaste')?.addEventListener('click', () => void pasteFromClipboardApi(state));
    state.pickerSearch?.addEventListener('input', () => {
        state.pickerQuery = state.pickerSearch?.value ?? '';
        renderPickerList(state);
    });
    state.pickerSearch?.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') togglePicker(state, false);
    });

    pick('btnNew')?.addEventListener('click', async () => {
        // 主进程会清转写并把代数 +1；面板不自己清 DOM（清空只有一个真源，见 resetUi）
        await call(MSG.newSession);
        await refreshState(state);
        await pollOnce(state);
    });

    pick('btnStop')?.addEventListener('click', async () => {
        const settled = state.snapshot?.status === 'stopped' || state.snapshot?.status === 'error';
        if (settled) {
            // 没跑的时候这个按钮是「启动」—— 之前根本没有这个入口（见 refreshState 里的说明）
            await startAgent(state);
            return;
        }
        setBanner(state, '正在停止 agent…', 'info');
        await call(MSG.stopAgent);
        await refreshState(state);
    });

    /**
     * 「停止本轮」—— 中断当前这一轮，**不动 agent、不动会话**。
     *
     * 三条眼前能看到的反馈（不然用户会以为按钮没生效，因为模型还会把已生成的
     * 那一小段文字吐完、工具结果也可能再来一条）：
     * ① 立刻把状态行改成「正在中断…」并禁用按钮；② 主进程会记一条 note；
     * ③ `turn/end` 的 `aborted` 到了之后状态行自己会变回空闲。
     */
    pick('btnInterrupt')?.addEventListener('click', async () => {
        state.interrupting = true;
        syncInterruptButton(state);
        if (state.live) {
            state.live.textContent = '正在中断这一轮…';
            state.live.dataset.tone = 'busy';
        }
        try {
            const reply = await call<{ ok: boolean; cancelled?: boolean; error?: string }>(MSG.interrupt);
            if (!reply?.ok) setBanner(state, `中断失败：${reply?.error ?? '未知原因'}`, 'error');
        } catch (error) {
            setBanner(state, `中断失败：${String(error)}`, 'error');
        }
        await refreshState(state);
        await pollOnce(state);
    });

    pick('btnRestart')?.addEventListener('click', async () => {
        setBanner(state, '正在重启 agent…（重启后会自动接上上次的会话）', 'info');
        try {
            await call(MSG.stopAgent);
        } catch (error) {
            console.warn(`[dsh_chat] 重启时 stop 失败（继续 start）：${String(error)}`);
        }
        await startAgent(state);
    });

    pick('btnHistory')?.addEventListener('click', () => void openHistory(state));
    state.btnHistoryRefreshEl?.addEventListener('click', () => void refreshHistory(state));
    pick('btnHistoryClose')?.addEventListener('click', () => closeHistory(state));
    state.resumeButton?.addEventListener('click', () => void resumeHistory(state));

    // 用量：状态行那颗 chip 开关抽屉；抽屉里刷新 / 关闭
    state.usageChip?.addEventListener('click', () => toggleUsage(state));
    pick('btnUsageClose')?.addEventListener('click', () => toggleUsage(state, false));
    state.btnUsageRefreshEl?.addEventListener('click', () => {
        if (state.btnUsageRefreshEl) state.btnUsageRefreshEl.disabled = true;
        if (state.btnProgressRefreshEl) state.btnProgressRefreshEl.disabled = true;
        void readUsage(state);
    });

    // 进度：同一套摆法（那颗 chip 也一样，没清单时整颗藏起来）
    state.progressChip?.addEventListener('click', () => toggleProgress(state));
    pick('btnProgressClose')?.addEventListener('click', () => toggleProgress(state, false));
    // ---- 活动（后台任务 / 子 agent）：与另外两个抽屉同一套交互
    state.activityChip?.addEventListener('click', () => toggleActivity(state));
    pick('btnActivityClose')?.addEventListener('click', () => toggleActivity(state, false));
    pick('btnActivityRefresh')?.addEventListener('click', () => {
        // 用户主动点的：**必须看到刚读的**（轮询的节流不参与这条路）
        state.activityAt = 0;
        void readActivity(state);
    });
    state.btnProgressRefreshEl?.addEventListener('click', () => {
        // 两颗「刷新」一起禁用：它们打的是同一次读盘（见 `readUsage`）
        if (state.btnProgressRefreshEl) state.btnProgressRefreshEl.disabled = true;
        if (state.btnUsageRefreshEl) state.btnUsageRefreshEl.disabled = true;
        void readUsage(state);
    });

    /**
     * 抽屉里的搜索框：**边打字边筛标题**（本地、零成本），Enter 才去读磁盘搜全文。
     *
     * 两条路分开的理由写在 `runHistorySearch` 上：一个是在手边这几条里挑，
     * 一个是有预算的磁盘扫描。清空输入框 = 回到列表（不用再点一下「返回列表」）。
     */
    state.historySearchEl?.addEventListener('input', () => {
        state.historyQuery = state.historySearchEl?.value ?? '';
        if (!state.historyQuery.trim() && state.historySearch) {
            state.historySearch = null;
            syncHistoryControls(state);
            void loadHistoryList(state);
            return;
        }
        if (!state.historySearch) void loadHistoryList(state);
    });
    state.historySearchEl?.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void runHistorySearch(state, state.historyQuery);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            if (state.historySearchEl) state.historySearchEl.value = '';
            state.historyQuery = '';
            state.historySearch = null;
            syncHistoryControls(state);
            void loadHistoryList(state);
        }
    });
    state.btnHistorySearch?.addEventListener('click', () => void runHistorySearch(state, state.historyQuery));
    state.btnHistoryBack?.addEventListener('click', () => {
        state.historySearch = null;
        syncHistoryControls(state);
        void loadHistoryList(state);
    });

    pick('btnSettings')?.addEventListener('click', () => toggleSettings(state));
    pick('btnTheme')?.addEventListener('click', () => void cycleTheme(state));

    // ⚠ **轮询在这里起，不等 `listeners.show`**（见 POLL_INTERVAL_MS 上方的说明）
    resume(state, 'mount');

    return state;
}

/** 面板显示/挂载：起轮询 + 接广播（**幂等**，`mount` 与 `listeners.show` 都会调）。 */
function resume(state: UiState, source: 'mount' | 'show'): void {
    const attached = attachBroadcast(state);
    state.polling = true;
    schedulePoll(state);
    if (!state.reportedResume) {
        state.reportedResume = true;
        reportProbe({ kind: 'resumed', source, broadcast: attached, pollMs: POLL_INTERVAL_MS });
    }
    // 立刻拉一次并刷状态，别等第一个间隔（也让「打开面板」立刻看到最新内容）
    void pollOnce(state);
    void refreshState(state);
}

/** 接广播（快路）。拿不到编辑器保护接口也不影响用 —— 轮询才是主路。 */
function attachBroadcast(state: UiState): boolean {
    if (state.broadcastHandler) return true;
    try {
        const bus = (
            Editor.Message as unknown as {
                __protected__?: { addBroadcastListener?: (m: string, f: (u: unknown) => void) => void };
            }
        ).__protected__;
        if (!bus?.addBroadcastListener) return false;
        const handler = (update: unknown): void => applyBroadcast(state, update);
        bus.addBroadcastListener(BROADCAST_CHANNEL, handler);
        state.broadcastHandler = handler;
        return true;
    } catch {
        return false;
    }
}

/** 排下一跳轮询。跑动时密一点（流式主要靠这一路显示出来）。 */
function schedulePoll(state: UiState): void {
    if (!state.polling) return;
    if (state.timer) clearTimeout(state.timer);
    const delay = state.snapshot?.running ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_MS;
    state.timer = setTimeout(() => void tick(state), delay);
}

/** 一跳：拉转写 →（有新条目或到了周期）刷状态 → 排下一跳。 */
async function tick(state: UiState): Promise<void> {
    if (!state.polling) return;
    state.tick += 1;
    const changed = await pollOnce(state);
    if (changed || state.tick % STATE_EVERY_TICKS === 0) await refreshState(state);
    /**
     * 活动（后台任务 / 子 agent）：**唯一一块要面板自己按节流去问的东西**。
     *
     * 别的读数都有推送 —— 用量/进度由主进程在回合结束与命令之后自己读并广播；而这两块
     * 只活在运行时内存里、没有可订阅的变化事件，所以只能在「有东西可看」时按节流问
     * （判据在 `shouldPollActivity`，空闲时一次都不问）。
     */
    if (shouldPollActivity(state)) void readActivity(state, { quiet: true });
    schedulePoll(state);
}

/**
 * 面板此刻是否真的看得见（量 DOM，不信编辑器的钩子）。
 *
 * 用途只有一个：`hide` 钩子的兜底 —— 钩子说「藏起来了」但面板明明占着位置时，
 * 宁可继续轮询（多一次 IPC 而已），也不能把刷新停掉（停了就是「内容不更新」这个 bug）。
 * 判据故意宽松：量不出来时**当作可见**（误判方向必须偏向「继续轮询」）。
 */
function panelVisible(state: UiState): boolean {
    const root = state.root;
    if (!root) return true;
    try {
        return root.getClientRects().length > 0 && root.offsetHeight > 0;
    } catch {
        return true;
    }
}

/** 面板隐藏：停轮询（广播也摘掉，避免看不见时还在重绘）。 */
function pause(state: UiState, source: 'hide' | 'manual' = 'hide'): void {
    if (source === 'hide' && panelVisible(state)) {
        // 钩子与地面真相打架：以地面真相为准，继续轮询
        reportProbe({ kind: 'hide-ignored', reason: '面板仍可见，继续轮询' });
        return;
    }
    state.polling = false;
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
    if (state.broadcastHandler) {
        try {
            const bus = (
                Editor.Message as unknown as {
                    __protected__?: { removeBroadcastListener?: (m: string, f: (u: unknown) => void) => void };
                }
            ).__protected__;
            bus?.removeBroadcastListener?.(BROADCAST_CHANNEL, state.broadcastHandler);
        } catch {
            /* 忽略 */
        }
        state.broadcastHandler = null;
    }
    reportProbe({ kind: 'paused', source });
}

module.exports = Editor.Panel.define({
    listeners: {
        /**
         * `show` / `hide` 只是**优化**（切到别的 tab 时省点轮询），不是必需的：
         * 轮询在 `ready`/`mount` 里已经起来了。
         *
         * ⚠ 实测（也是这次「不流式」的根因）：对**编辑器启动时恢复的停靠面板**，
         * 这两个钩子不保证在 `ready` 之后触发 —— 那时 WeakMap 里还没有 state，
         * 老写法（`uiByPanel.get(this)?.resume()`）会**静默什么都不做**。
         * 所以这里加了兜底：`this` 查不到时，若只有一个面板实例就作用在它身上。
         */
        show(this: object) {
            const state = resolveState(this);
            if (state) resume(state, 'show');
        },
        hide(this: object) {
            const state = resolveState(this);
            if (state) pause(state, 'hide');
        },
    },

    template: readStatic('template/default/index.html'),
    style: readStyle(),

    // ⚠ 全部元素引用都从这里拿：`$` 由编辑器在面板子树里解析，
    //    而 `document.getElementById` 在这个环境里拿不到（实测返回 null）。
    //    这份表与文件顶部 SELECTORS 是同一份键（SELECTORS 是真源，这里喂给编辑器）。
    $: SELECTORS,

    methods: {},

    /**
     * 面板挂载完成时由编辑器调用（**不是** `methods` 里的方法 —— 编辑器对它就是按顶层钩子调的，
     * 放进 `methods` 里永远不会被调到，实测过）。
     *
     * 包一层 try/catch：`mount` 半路抛错会**连带**丢掉 `uiByPanel` 的登记（于是 `show`/`hide`
     * 全成了空操作，症状是面板看着有、内容永远不刷新），至少把错报给主进程。
     */
    ready(this: object) {
        let state: UiState;
        try {
            state = mount(this);
        } catch (error) {
            const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
            console.error(`[dsh_chat] 面板挂载失败：${stack}`);
            reportProbe({ kind: 'mount-error', stack: stack.slice(0, 800) });
            return;
        }
        uiByPanel.set(this, state);
        liveStates.add(state);
    },
});
