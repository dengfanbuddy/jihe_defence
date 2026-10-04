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
    type AgentSnapshot,
    type AgentStatus,
    type DshChatSettings,
    type Entry,
    type EntryImage,
    type HistorySessionView,
    type HostUpdateView,
    type ImageMimeType,
    type PanelTheme,
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
import { createToolCard, defaultOpen } from './tool-card';

/** 静态资源根。 */
const STATIC_ROOT = join(__dirname, '../../../static');

/** 从扩展根读一份静态文件。 */
function readStatic(relativePath: string): string {
    return readFileSync(join(STATIC_ROOT, relativePath), 'utf-8');
}

/**
 * 面板样式 = **token 层 + 组件层**。
 *
 * token 层是脚本从已安装的 DSH 里抽出来的（见 `scripts/extract-dsw-tokens.js`），
 * 组件层是手写的、只消费 token。分开的理由：DSH 升版本时重跑脚本即可，
 * 手写的组件样式不会被覆盖。
 */
function readStyle(): string {
    return `${readStatic('style/default/dsw-tokens.css')}\n${readStatic('style/default/index.css')}`;
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
const THEME_LABEL: Record<PanelTheme, string> = { auto: '跟随系统', dark: '深色', light: '浅色' };
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
    resumeButton: HTMLButtonElement | null;
    broadcastHandler: ((update: unknown) => void) | null;

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
    btnHistoryClose: '#btn-history-close',
    btnHistoryRefresh: '#btn-history-refresh',
    btnSettings: '#btn-settings',
    btnTheme: '#btn-theme',
    live: '#live',
    meta: '#meta',
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

/** 把外观设置落到根节点（主题 + 字号）。 */
function applyAppearance(state: UiState): void {
    const root = state.root;
    if (!root) return;
    const mode = state.settings?.theme ?? 'auto';
    root.dataset.theme = resolveTheme(mode);
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
    // maxRev 归零：代数变了，之前那批条目在主进程里已经不存在，重拉一遍不会重复
    state.maxRev = 0;
    state.maxSeq = 0;
    state.lastUserSeq = 0;
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

/** 打开/刷新历史抽屉。 */
async function openHistory(state: UiState): Promise<void> {
    state.historyOpen = true;
    if (state.history) state.history.hidden = false;
    if (state.historyList) state.historyList.textContent = '';
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
    renderHistoryList(state, reply);
}

/** 画历史列表。 */
function renderHistoryList(state: UiState, reply: HistoryListReply): void {
    const list = state.historyList;
    if (!list) return;
    list.textContent = '';
    if (state.historyNote) {
        state.historyNote.textContent = reply.ok
            ? `${reply.sessions?.length ?? 0} 条会话（按最后修改时间倒序）`
            : `读取失败：${reply.error ?? '未知原因'}`;
        state.historyNote.dataset.tone = reply.ok ? '' : 'error';
    }
    if (!reply.ok) return;

    for (const session of reply.sessions ?? []) {
        const item = el('button', 'dsh-history-item');
        item.dataset.current = session.current ? 'true' : 'false';
        item.title = session.id;
        item.appendChild(el('div', 'dsh-history-item-title', session.title || '(无标题)'));
        item.appendChild(
            el(
                'div',
                'dsh-history-item-meta',
                `${formatTime(session.updatedAt)} · ${session.turns} 轮 · ${formatBytes(session.bytes)}` +
                    (session.current ? ' · 正在显示' : ''),
            ),
        );
        item.addEventListener('click', () => void openHistorySession(state, session.id));
        list.appendChild(item);
    }
    if ((reply.sessions ?? []).length === 0) {
        list.appendChild(el('div', 'dsh-history-empty', '这个工程还没有历史会话。'));
    }
}

/** 关闭历史抽屉。 */
function closeHistory(state: UiState): void {
    state.historyOpen = false;
    if (state.history) state.history.hidden = true;
}

/** 点一条历史会话：让主进程读日志并回放（只读）。 */
async function openHistorySession(state: UiState, sessionId: string): Promise<void> {
    if (state.historyNote) state.historyNote.textContent = '正在读日志并回放…（大日志会稍慢）';
    try {
        const reply = await call<{ ok: boolean; events?: number; error?: string }>(MSG.historyOpen, { sessionId });
        if (!reply?.ok) {
            if (state.historyNote) {
                state.historyNote.textContent = `回放失败：${reply?.error ?? '未知原因'}`;
                state.historyNote.dataset.tone = 'error';
            }
            return;
        }
        closeHistory(state);
        await refreshState(state);
        // 回放是「主进程转写代数 +1」的副作用，这里主动拉一次，别让用户盯着空白等轮询
        await pollOnce(state);
    } catch (error) {
        if (state.historyNote) {
            state.historyNote.textContent = `回放失败：${String(error)}`;
            state.historyNote.dataset.tone = 'error';
        }
    }
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
    if (reply.settings) state.settings = reply.settings;
    applyAppearance(state);

    if (state.dot) {
        state.dot.dataset.state = reply.agent.status;
        state.dot.title = STATUS_TEXT[reply.agent.status] ?? reply.agent.status;
    }
    const settings = state.settings;
    if (state.title) state.title.textContent = `DSH · ${PROFILE_NAME}`;
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
    const changed = mergeEntries(state, entries);
    if (changed && pinned) {
        // 等一帧再滚：刚插入的内容还没量高度
        requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
        });
    }
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
    // 广播只带增量，revision 用它推游标；漏掉的部分靠轮询补齐
    if (typeof payload.revision === 'number' && payload.revision > state.maxRev) state.maxRev = payload.revision;
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

/** 发送。 */
async function send(state: UiState): Promise<void> {
    const text = state.input.value.trim();
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
        ['auto', '跟随系统'],
        ['dark', '深色'],
        ['light', '浅色'],
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
        resumeButton: pick('btnResume') as HTMLButtonElement | null,
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
    });
    state.input.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send(state);
        }
    });

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
    pick('btnHistoryRefresh')?.addEventListener('click', () => void openHistory(state));
    pick('btnHistoryClose')?.addEventListener('click', () => closeHistory(state));
    state.resumeButton?.addEventListener('click', () => void resumeHistory(state));

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
