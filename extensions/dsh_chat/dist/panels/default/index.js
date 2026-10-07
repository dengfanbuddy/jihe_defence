"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const constants_1 = require("../../constants");
const images_1 = require("../../images");
const markdown_1 = require("./markdown");
const mention_1 = require("./mention");
const progress_1 = require("./progress");
const cost_1 = require("./cost");
const tool_card_1 = require("./tool-card");
/** 静态资源根。 */
const STATIC_ROOT = (0, path_1.join)(__dirname, '../../../static');
/** 从扩展根读一份静态文件。 */
function readStatic(relativePath) {
    return (0, fs_1.readFileSync)((0, path_1.join)(STATIC_ROOT, relativePath), 'utf-8');
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
function readStyle() {
    return `${readStatic('style/default/dsw-tokens.css')}\n${readStatic('style/default/index.css')}\n${readStatic('style/default/editor-theme.css')}`;
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
const DRAFT_KEY = `${constants_1.EXTENSION_NAME}:draft`;
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
};
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
const BANNER_HOLD = { INFO: 4000, ERROR: 12000 };
/** 状态点/文案。 */
const STATUS_TEXT = {
    stopped: '未启动',
    installing: '准备 profile…',
    starting: '启动中…',
    ready: '就绪',
    stopping: '停止中…',
    error: '出错',
};
/** 外观按钮上的三档循环（title 用）。 */
const THEME_CYCLE = ['auto', 'dark', 'light'];
/**
 * ⚠ 文案要跟**行为**一致：`auto` 的实际行为是「能认出编辑器主题就跟编辑器，认不出才跟系统」
 * （`resolveTheme`），原来写的是「跟随系统」—— 那是把回落档当成了主档，实测对不上。
 */
const THEME_LABEL = { auto: '跟随编辑器', dark: '深色', light: '浅色' };
const THEME_GLYPH = { auto: '◐', dark: '●', light: '○' };
const uiByPanel = new WeakMap();
/**
 * 所有活着的面板实例。
 *
 * 存在理由：`listeners.show/hide` 收到的 `this` 偶尔对不上 `ready` 那次（或钩子先于 `ready` 到达），
 * 这时按 `this` 查 WeakMap 会**静默失败**。只有一个面板实例时（常态）直接作用在它身上更可靠。
 */
const liveStates = new Set();
/** 找到钩子该作用的面板状态：先按 `this`，再退到「唯一实例」。 */
function resolveState(self) {
    const direct = uiByPanel.get(self);
    if (direct)
        return direct;
    if (liveStates.size === 1)
        return [...liveStates][0];
    return null;
}
/**
 * 面板元素的选择器表 —— **唯一真源**：`$` 表与兜底补查都用它。
 *
 * 加元素时只改这里（外加 `static/template/default/index.html`）。
 */
const SELECTORS = {
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
async function call(message, ...args) {
    return (await Editor.Message.request(constants_1.EXTENSION_NAME, message, ...args));
}
/** 建元素小工具。 */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
/**
 * 把面板自检报给主进程（读不到也无所谓，纯诊断）。
 *
 * 不依赖 state：`mount` 半路抛错时它也能用（那时还没有 state）。
 */
function reportProbe(payload) {
    var _a;
    try {
        const pending = Editor.Message.request(constants_1.EXTENSION_NAME, constants_1.MSG.panelProbe, {
            ...payload,
            at: Date.now(),
        });
        void ((_a = pending === null || pending === void 0 ? void 0 : pending.catch) === null || _a === void 0 ? void 0 : _a.call(pending, () => undefined));
    }
    catch {
        /* 诊断失败不许影响面板 */
    }
}
/** 提示条：文字 + 可选动作按钮。元素缺失时只 warn（绝不让 UI 抛错）。 */
function setBanner(state, text, tone = 'error', actions = [], 
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
holdMs = 0) {
    const node = state.banner;
    if (!node)
        return;
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
function resolveTheme(mode) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (mode === 'dark' || mode === 'light')
        return mode;
    const hint = `${(_b = (_a = document.documentElement) === null || _a === void 0 ? void 0 : _a.className) !== null && _b !== void 0 ? _b : ''} ${(_d = (_c = document.body) === null || _c === void 0 ? void 0 : _c.className) !== null && _d !== void 0 ? _d : ''} ${(_g = (_f = (_e = document.body) === null || _e === void 0 ? void 0 : _e.dataset) === null || _f === void 0 ? void 0 : _f.theme) !== null && _g !== void 0 ? _g : ''}`;
    if (/dark/i.test(hint))
        return 'dark';
    if (/light/i.test(hint))
        return 'light';
    try {
        return ((_h = window.matchMedia) === null || _h === void 0 ? void 0 : _h.call(window, '(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    catch {
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
function applyAppearance(state) {
    var _a, _b, _c, _d, _e;
    const root = state.root;
    if (!root)
        return;
    const mode = (_b = (_a = state.settings) === null || _a === void 0 ? void 0 : _a.theme) !== null && _b !== void 0 ? _b : 'auto';
    root.dataset.theme = resolveTheme(mode);
    root.dataset.palette = ((_c = state.settings) === null || _c === void 0 ? void 0 : _c.palette) === 'editor' ? 'editor' : 'dsw';
    const size = Number((_e = (_d = state.settings) === null || _d === void 0 ? void 0 : _d.fontSize) !== null && _e !== void 0 ? _e : 0);
    if (size >= 12 && size <= 17)
        root.style.setProperty('--dsh-content-font-size', `${size}px`);
    else
        root.style.removeProperty('--dsh-content-font-size');
}
/**
 * 布局自检：面板的高度从哪来。
 *
 * 老版样式靠 `html,body{height:100%}` 撑起来 —— 那条规则会改到编辑器自己的页面，
 * 所以新版把它删了，改成这里量一次：`.dsh-root` 高度塌了（< 40px）就按情况兜底。
 * 面板到底独占一个文档还是与编辑器共用，各版本编辑器不一样，量出来的结果会回传给主进程。
 */
function ensureLayout(state) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const root = state.root;
    if (!root)
        return { root: 'missing' };
    const rect = root.getBoundingClientRect();
    const info = {
        kind: 'layout',
        rootHeight: Math.round(rect.height),
        rootWidth: Math.round(rect.width),
        parent: (_b = (_a = root.parentElement) === null || _a === void 0 ? void 0 : _a.tagName) !== null && _b !== void 0 ? _b : null,
        htmlHeight: (_d = (_c = document.documentElement) === null || _c === void 0 ? void 0 : _c.clientHeight) !== null && _d !== void 0 ? _d : -1,
        bodyHeight: (_f = (_e = document.body) === null || _e === void 0 ? void 0 : _e.clientHeight) !== null && _f !== void 0 ? _f : -1,
        bodyChildren: (_j = (_h = (_g = document.body) === null || _g === void 0 ? void 0 : _g.children) === null || _h === void 0 ? void 0 : _h.length) !== null && _j !== void 0 ? _j : -1,
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
    }
    else if (rect.height < 40) {
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
function renderEntryImages(state, images) {
    var _a;
    const wrap = el('div', 'dsh-msg-images');
    for (const image of images) {
        const chip = el('span', 'dsh-msg-image');
        const thumb = image.name ? state.sentThumbs.get(image.name) : undefined;
        if (thumb) {
            const node = el('img', 'dsh-msg-image-thumb');
            node.src = thumb;
            node.alt = (_a = image.name) !== null && _a !== void 0 ? _a : '';
            chip.appendChild(node);
        }
        else {
            chip.appendChild(el('span', 'dsh-msg-image-glyph', '🖼'));
        }
        const dims = image.width && image.height ? `${image.width}×${image.height}` : '';
        const size = image.bytes ? (0, images_1.formatBytes)(image.bytes) : '';
        chip.appendChild(el('span', 'dsh-msg-image-name', image.name || '图片'));
        const meta = [dims, size].filter(Boolean).join(' · ');
        if (meta)
            chip.appendChild(el('span', 'dsh-msg-image-meta', meta));
        wrap.appendChild(chip);
    }
    return wrap;
}
/** 思考块（默认折叠；流式那一块自动展开）。 */ function renderThinking(state, host, entry) {
    var _a, _b;
    const explicit = state.collapsedThink.get(entry.seq);
    const isLive = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running) === true && entry.seq === state.maxSeq;
    const collapsed = explicit === undefined ? !isLive : explicit;
    const box = el('div', 'dsh-think');
    box.dataset.collapsed = collapsed ? 'true' : 'false';
    const head = el('div', 'dsh-think-head');
    head.append(el('span', 'dsh-think-caret', '▸'), el('span', undefined, isLive ? '思考中…' : '思考过程'));
    const body = el('div', 'dsh-think-body', (_b = entry.text) !== null && _b !== void 0 ? _b : '');
    head.addEventListener('click', () => {
        const next = box.dataset.collapsed !== 'true';
        box.dataset.collapsed = next ? 'true' : 'false';
        state.collapsedThink.set(entry.seq, next);
    });
    box.append(head, body);
    host.appendChild(box);
}
/** 工具卡片。 */
function renderTool(state, host, entry) {
    const explicit = state.openTools.get(entry.seq);
    const open = explicit === undefined ? (0, tool_card_1.defaultOpen)(entry) : explicit;
    const card = (0, tool_card_1.createToolCard)(entry, open, (next) => state.openTools.set(entry.seq, next));
    host.appendChild(card.root);
}
/** 按条目种类渲染内容（元素已被清空）。 */
function paintEntry(state, element, entry) {
    var _a, _b, _c, _d, _e;
    element.className = '';
    element.textContent = '';
    switch (entry.kind) {
        case 'user': {
            element.className = 'dsh-msg-user';
            // 纯图片消息没有文字 —— 那就只画碎片（别留一个空气泡）
            if (entry.text)
                element.appendChild(el('div', 'dsh-msg-text', entry.text));
            if (entry.images && entry.images.length > 0)
                element.appendChild(renderEntryImages(state, entry.images));
            return;
        }
        case 'agent': {
            element.className = 'dsh-msg-agent';
            const md = el('div', 'dsh-md');
            (0, markdown_1.renderMarkdown)(md, (_a = entry.text) !== null && _a !== void 0 ? _a : (((_b = state.snapshot) === null || _b === void 0 ? void 0 : _b.running) ? '…' : ''));
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
            element.textContent = (_c = entry.text) !== null && _c !== void 0 ? _c : '出错';
            return;
        }
        default: {
            element.className = 'dsh-note';
            if (((_d = entry.text) !== null && _d !== void 0 ? _d : '').startsWith('stderr:'))
                element.dataset.kind = 'stderr';
            element.textContent = (_e = entry.text) !== null && _e !== void 0 ? _e : '';
            return;
        }
    }
}
/** 空态：首次打开时告诉用户这是什么、怎么开始。 */
function renderEmpty(state, reason) {
    var _a, _b;
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
            snapshot ? `node：${(_a = snapshot.runtime.nodeExe) !== null && _a !== void 0 ? _a : '未找到'}（${snapshot.runtime.nodeSource}）` : '',
            snapshot ? `dsh ：${(_b = snapshot.runtime.dshBin) !== null && _b !== void 0 ? _b : '未找到'}（${snapshot.runtime.dshSource}）` : '',
        ]
            .filter(Boolean)
            .join('\n');
        lines.textContent = text;
        wrap.appendChild(lines);
        const button = el('button', 'dsh-send-primary', '启动 agent');
        button.addEventListener('click', () => void startAgent(state));
        wrap.appendChild(button);
    }
    else {
        wrap.appendChild(el('div', 'dsh-empty-title', '说点什么开始'));
        const lines = el('div', 'dsh-empty-lines');
        lines.textContent = '比如：「看一眼当前场景，把 Canvas 下的节点列出来」。';
        wrap.appendChild(lines);
    }
    state.body.appendChild(wrap);
    state.emptyEl = wrap;
}
/** 「正在回复」的三个点（只在跑的时候挂在最后）。 */
function syncTyping(state) {
    var _a;
    const running = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running) === true;
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
    if (state.body.lastElementChild !== state.typingEl)
        state.body.appendChild(state.typingEl);
}
/** 流式状态变了之后，重算「思考块该不该展开」（用户手动点过的以用户为准）。 */
function syncLiveBlocks(state) {
    var _a;
    for (const entry of state.entries.values()) {
        if (entry.kind !== 'thinking')
            continue;
        if (state.collapsedThink.has(entry.seq))
            continue;
        const element = state.els.get(entry.seq);
        const box = element === null || element === void 0 ? void 0 : element.querySelector('.dsh-think');
        if (!box)
            continue;
        const isLive = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running) === true && entry.seq === state.maxSeq;
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
function resetUi(state, generation) {
    var _a;
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
    if (typeof generation === 'number')
        state.generation = generation;
    if (state.entries.size === 0)
        renderEmpty(state, ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.status) === 'ready' ? 'no-messages' : 'no-agent');
}
/** 按 seq 合并条目（同一 seq 原地更新）。 */
function mergeEntries(state, entries) {
    let changed = false;
    for (const entry of entries) {
        const previous = state.entries.get(entry.seq);
        state.entries.set(entry.seq, entry);
        if (entry.seq > state.maxSeq)
            state.maxSeq = entry.seq;
        let element = state.els.get(entry.seq);
        if (!element) {
            // 新回合（又一条用户消息）前面拉一条分隔线，只在不是第一条时拉
            if (entry.kind === 'user' && state.els.size > 0 && entry.seq !== state.lastUserSeq) {
                const sep = el('div', 'dsh-turn-sep');
                state.body.appendChild(sep);
            }
            if (entry.kind === 'user')
                state.lastUserSeq = entry.seq;
            element = el('div');
            state.els.set(entry.seq, element);
            state.body.appendChild(element);
            changed = true;
        }
        else if (previous && previous.rev === entry.rev) {
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
const ACCEPTED_MIME = new Set(Object.values(images_1.IMAGE_MIME_BY_EXT));
/** MIME → 扩展名（拼显示名用）。 */
function extOfMime(mimeType) {
    if (mimeType === 'image/jpeg')
        return 'jpg';
    return mimeType.replace(/^image\//, '') || 'png';
}
/**
 * 显示名保证带**正确**的扩展名。
 *
 * 两件事都要做：没有扩展名就补（剪贴板来的图没有名字），扩展名不对就**换掉** ——
 * 只看「有没有扩展名」会得到 `screenshot.bmp.png` 这种名字（bmp 不在白名单里，
 * 但压缩产物是 PNG），发出去之后自己也看不出到底存的是哪种格式。
 */
function withExt(name, mimeType) {
    const wanted = `.${extOfMime(mimeType)}`;
    const trimmed = (name.trim() || '图片').replace(/[\\/:*?"<>|]+/g, '_');
    if (trimmed.toLowerCase().endsWith(wanted))
        return trimmed;
    const withoutOldExt = trimmed.replace(/\.[a-z0-9]{1,5}$/i, '');
    return `${withoutOldExt || '图片'}${wanted}`;
}
/** base64 → 字节数（面板里只为显示，不引 Buffer）。 */
function base64Bytes(data) {
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
function fitWithin(width, height) {
    const { maxPixels, maxSide } = IMAGE_BUDGET;
    let scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
    if (Math.max(width, height) * scale > maxSide)
        scale = maxSide / Math.max(width, height);
    if (scale >= 1)
        return { width, height, scaled: false };
    let projectedWidth = Math.max(1, Math.round(width * scale));
    let projectedHeight = Math.max(1, Math.round(height * scale));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
        projectedWidth -= 1;
        projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight, scaled: true };
}
/**
 * 解码一段图片字节。
 *
 * 两条路：`createImageBitmap`（快、异步、能直接再编码）与 `<img>` + object URL（兜底）。
 * 后者必须 `revokeObjectURL`，否则每贴一张图就漏一个 blob。
 */
async function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { var _a; return (_a = bitmap.close) === null || _a === void 0 ? void 0 : _a.call(bitmap); } };
        }
        catch {
            /* 解码失败/不支持：落到 <img> 那条路，让它给出更清楚的错误 */
        }
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('这个文件不是能解码的图片'));
            image.src = url;
        });
    }
    catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}
/** 把解码结果画到 canvas（`fillWhite` 用于要转 JPEG 的场合：透明区在 JPEG 里会变黑）。 */
function drawTo(decoded, width, height, fillWhite = false) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
        throw new Error('拿不到 canvas 2d 上下文');
    if (fillWhite) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
    }
    context.drawImage(decoded.source, 0, 0, width, height);
    return canvas;
}
/** canvas → JPEG（质量梯子，取第一个进预算的；都不行就取最小的那个）。 */
function encodeJpeg(canvas) {
    let best = null;
    for (const quality of JPEG_LADDER) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const bytes = base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        if (!best || bytes < best.bytes)
            best = { mimeType: 'image/jpeg', dataUrl, bytes };
        if (bytes <= IMAGE_BUDGET.normalizedMaxBytes)
            break;
    }
    if (!best)
        throw new Error('JPEG 编码失败');
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
function encodeWebp(canvas) {
    let best = null;
    for (const quality of JPEG_LADDER) {
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (!dataUrl.startsWith('data:image/webp'))
            return null;
        const bytes = base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        if (!best || bytes < best.bytes)
            best = { mimeType: 'image/webp', dataUrl, bytes };
        if (bytes <= IMAGE_BUDGET.normalizedMaxBytes)
            break;
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
function encodeCanvas(canvas) {
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
function makeThumb(decoded) {
    const side = IMAGE_BUDGET.thumbSide;
    const scale = Math.min(1, side / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    return drawTo(decoded, width, height).toDataURL('image/png');
}
/** Blob → 规范 base64（`readAsDataURL` 给的正是规范形式，去前缀即可）。 */
async function blobToBase64(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => { var _a; return resolve(String((_a = reader.result) !== null && _a !== void 0 ? _a : '')); };
        reader.onerror = () => reject(new Error('读不出这张图的数据'));
        reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(',');
    if (comma < 0)
        throw new Error('这张图的数据不是 data URL');
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
async function buildAttachment(blob, name, origin) {
    if (blob.size > images_1.MAX_IMAGE_BYTES) {
        return { error: `${name}有 ${(0, images_1.formatBytes)(blob.size)}，超过单张上限 ${(0, images_1.formatBytes)(images_1.MAX_IMAGE_BYTES)}（附件库是拒收而不是压缩）。` };
    }
    let decoded;
    try {
        decoded = await decodeBlob(blob);
    }
    catch (error) {
        return { error: `${name} 解不开：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
        if (!decoded.width || !decoded.height)
            return { error: `${name} 的像素尺寸是 0，读不出内容。` };
        const sourceMime = (blob.type || '').toLowerCase();
        const target = fitWithin(decoded.width, decoded.height);
        /**
         * 快路（原样发）的三个条件，缺一不可：
         * ① 声明的 MIME 在白名单里（附件库只收那四种）；
         * ② 尺寸在像素预算内（否则要缩）；
         * ③ 字节在归一化预算内 —— 超了附件库反正也会重压一遍，那就**在面板里压**
         *    （十几 MB 的 base64 走一趟 IPC 是纯浪费）。
         */
        const reusable = ACCEPTED_MIME.has(sourceMime) && !target.scaled && blob.size <= IMAGE_BUDGET.normalizedMaxBytes;
        const notes = [];
        let mimeType;
        let data;
        if (reusable) {
            mimeType = sourceMime;
            data = await blobToBase64(blob);
        }
        else {
            const canvas = drawTo(decoded, target.width, target.height);
            const encoded = encodeCanvas(canvas);
            mimeType = encoded.mimeType;
            data = encoded.dataUrl.slice(encoded.dataUrl.indexOf(',') + 1);
            if (target.scaled)
                notes.push(`已缩到 ${target.width}×${target.height}`);
            if (!ACCEPTED_MIME.has(sourceMime))
                notes.push(`${sourceMime || '未知格式'} → ${extOfMime(mimeType)}`);
            if (encoded.note)
                notes.push(encoded.note);
        }
        const bytes = base64Bytes(data);
        if (bytes > images_1.MAX_IMAGE_BYTES) {
            return { error: `${name} 归一化后仍有 ${(0, images_1.formatBytes)(bytes)}，超过单张上限 ${(0, images_1.formatBytes)(images_1.MAX_IMAGE_BYTES)}。` };
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
    }
    finally {
        decoded.release();
    }
}
/** 画输入区上方那排图片碎片。 */
function renderAttachments(state) {
    const host = state.attachHost;
    if (!host)
        return;
    host.textContent = '';
    host.hidden = state.attachments.length === 0;
    for (const attachment of state.attachments) {
        const chip = el('div', 'dsh-attach');
        const thumb = el('img', 'dsh-attach-thumb');
        thumb.src = attachment.thumb;
        thumb.alt = attachment.name;
        const meta = el('div', 'dsh-attach-meta');
        meta.append(el('div', 'dsh-attach-name', attachment.name), el('div', 'dsh-attach-size', `${attachment.width}×${attachment.height} · ${(0, images_1.formatBytes)(attachment.bytes)}` +
            (attachment.note ? ` · ${attachment.note}` : '')));
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
function addAttachments(state, attachments) {
    if (attachments.length === 0)
        return;
    const room = images_1.MAX_IMAGES_PER_MESSAGE - state.attachments.length;
    const accepted = attachments.slice(0, Math.max(0, room));
    if (accepted.length < attachments.length) {
        setBanner(state, `一条消息最多带 ${images_1.MAX_IMAGES_PER_MESSAGE} 张图，多出来的 ${attachments.length - accepted.length} 张没有加上。`, 'info', [], BANNER_HOLD.INFO);
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
async function attachBlobs(state, blobs, origin) {
    if (blobs.length === 0)
        return;
    state.imageBusy += 1;
    if (state.imageButton)
        state.imageButton.dataset.busy = 'true';
    const errors = [];
    const built = [];
    try {
        for (const item of blobs) {
            const result = await buildAttachment(item.blob, item.name, origin);
            if ('attachment' in result)
                built.push(result.attachment);
            else
                errors.push(result.error);
        }
    }
    catch (error) {
        errors.push(`处理图片时出错：${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        state.imageBusy -= 1;
        if (state.imageButton)
            state.imageButton.dataset.busy = state.imageBusy > 0 ? 'true' : 'false';
    }
    addAttachments(state, built);
    if (errors.length > 0)
        setBanner(state, errors.join('\n'), 'error', [], BANNER_HOLD.ERROR);
    else if (built.length > 0)
        setBanner(state, null);
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
function imagesFromClipboard(data) {
    const out = [];
    if (!data)
        return out;
    const items = data.items ? Array.from(data.items) : [];
    for (const item of items) {
        if (item.kind !== 'file')
            continue;
        if (!item.type || !item.type.toLowerCase().startsWith('image/'))
            continue;
        const file = item.getAsFile();
        if (!file)
            continue;
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
/** 拉一次工程图片清单（带缓存；`force` 时重拉）。 */
async function ensurePickerList(state, force = false) {
    var _a, _b, _c;
    if (state.pickerImages && !force)
        return;
    if (state.pickerNote) {
        state.pickerNote.textContent = '正在读工程的资源库…';
        state.pickerNote.dataset.tone = '';
    }
    let reply;
    try {
        reply = await call(constants_1.MSG.listImages);
    }
    catch (error) {
        reply = { ok: false, error: String(error) };
    }
    if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
        state.pickerImages = [];
        if (state.pickerNote) {
            state.pickerNote.textContent = `读不到工程图片：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`;
            state.pickerNote.dataset.tone = 'error';
        }
        return;
    }
    state.pickerImages = (_b = reply.images) !== null && _b !== void 0 ? _b : [];
    state.pickerSource = (_c = reply.source) !== null && _c !== void 0 ? _c : '';
    renderPickerList(state);
}
/** 画选择器里的格子（按搜索词过滤后）。 */
function renderPickerList(state) {
    var _a, _b;
    const list = state.pickerList;
    if (!list)
        return;
    const all = (_a = state.pickerImages) !== null && _a !== void 0 ? _a : [];
    const shown = (0, images_1.filterProjectImages)(all, state.pickerQuery).slice(0, images_1.MAX_LISTED_IMAGES);
    list.textContent = '';
    (_b = state.pickerObserver) === null || _b === void 0 ? void 0 : _b.disconnect();
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
    const observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting)
                    continue;
                const node = entry.target;
                observer.unobserve(node);
                const image = all.find((item) => item.path === node.dataset.path);
                const target = node.querySelector('img');
                if (image && target)
                    queueThumb(state, image, target);
            }
        }, { root: list, rootMargin: '160px' })
        : null;
    state.pickerObserver = observer;
    for (const image of shown) {
        const item = el('button', 'dsh-pick-item');
        item.type = 'button';
        item.dataset.path = image.path;
        item.title = `${image.name}\n${image.rel || image.url}${image.bytes ? `\n${(0, images_1.formatBytes)(image.bytes)}` : ''}`;
        const thumb = el('img', 'dsh-pick-thumb');
        thumb.alt = '';
        // 缓存里有就直接给（关掉再开不重读），没有则挂上观察者按需读
        const cached = state.pickerThumbs.get(image.path);
        if (cached)
            thumb.src = cached;
        const text = el('span', 'dsh-pick-text');
        text.append(el('span', 'dsh-pick-name', image.name), el('span', 'dsh-pick-path', image.rel || image.url));
        item.append(thumb, text);
        item.addEventListener('click', () => void attachProjectImage(state, image));
        list.appendChild(item);
        if (!cached && observer)
            observer.observe(item);
        else if (!cached && shown.indexOf(image) < 24)
            queueThumb(state, image, thumb);
    }
}
/**
 * 缩略图按需读：一次 IPC + 一次解码，所以**同屏最多 `THUMB_CONCURRENCY` 路**，读完即出队。
 * 读不出来的路径记进 `pickerFailed`，免得滚动一次就重试一整串。
 */
function queueThumb(state, image, target) {
    if (state.pickerThumbs.has(image.path) || state.pickerFailed.has(image.path))
        return;
    if (state.pickerLoading.has(image.path))
        return;
    state.pickerQueue.push({ image, target });
    void pumpThumbs(state);
}
/** 推缩略图队列（自带并发上限）。 */
async function pumpThumbs(state) {
    while (state.pickerLoading.size < THUMB_CONCURRENCY && state.pickerQueue.length > 0) {
        const next = state.pickerQueue.shift();
        if (!next)
            break;
        const { image, target } = next;
        if (state.pickerThumbs.has(image.path) || state.pickerLoading.has(image.path))
            continue;
        state.pickerLoading.add(image.path);
        void (async () => {
            var _a;
            try {
                const reply = await readProjectImage(image);
                if (!reply.ok || !reply.data) {
                    state.pickerFailed.add(image.path);
                    target.dataset.failed = 'true';
                    return;
                }
                const blob = new Blob([base64ToBuffer(reply.data)], { type: (_a = reply.mimeType) !== null && _a !== void 0 ? _a : 'image/png' });
                const decoded = await decodeBlob(blob);
                try {
                    const thumb = makeThumb(decoded);
                    state.pickerThumbs.set(image.path, thumb);
                    while (state.pickerThumbs.size > THUMB_CACHE_LIMIT) {
                        const oldest = state.pickerThumbs.keys().next();
                        if (oldest.done)
                            break;
                        state.pickerThumbs.delete(oldest.value);
                    }
                    if (target.isConnected)
                        target.src = thumb;
                }
                finally {
                    decoded.release();
                }
            }
            catch {
                state.pickerFailed.add(image.path);
                target.dataset.failed = 'true';
            }
            finally {
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
function base64ToBuffer(data) {
    const binary = atob(data);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
    return buffer;
}
/** 读一张工程图（选择器点开、拖进来、加附件都走它）。 */
async function readProjectImage(image) {
    try {
        return await call(constants_1.MSG.readImage, { url: image.url, path: image.path });
    }
    catch (error) {
        return { ok: false, error: String(error) };
    }
}
/** 点一张工程图 = 读原图 → 归一化 → 进碎片区。 */
async function attachProjectImage(state, image) {
    var _a, _b, _c;
    if (state.attachments.some((item) => item.name === image.name && item.origin === 'project')) {
        setBanner(state, `「${image.name}」已经在待发送列表里了。`, 'info', [], BANNER_HOLD.INFO);
        return;
    }
    const reply = await readProjectImage(image);
    if (!reply.ok || !reply.data) {
        setBanner(state, `读不到「${image.name}」：${(_a = reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error', [], BANNER_HOLD.ERROR);
        return;
    }
    const blob = new Blob([base64ToBuffer(reply.data)], { type: (_b = reply.mimeType) !== null && _b !== void 0 ? _b : 'image/png' });
    await attachBlobs(state, [{ blob, name: (_c = reply.name) !== null && _c !== void 0 ? _c : image.name }], 'project');
}
/** 打开/关掉图片选择器。 */
function togglePicker(state, open) {
    const next = open !== null && open !== void 0 ? open : !state.pickerOpen;
    state.pickerOpen = next;
    if (state.picker)
        state.picker.hidden = !next;
    // 选择器与输入弹出块**抢同一块版面**（都在对话区与输入区之间）：开一个就收另一个
    if (next)
        closePopup(state);
    if (next) {
        /**
         * 缓存命中时**必须重画一次**：关抽屉时把 `IntersectionObserver` 摘掉了，
         * 而没读到的那些格子正是靠它排队的 —— 不重挂的话，第二次打开时那些格子
         * 永远是空的（图片本身没变、缓存也在，只是没人再去读）。
         */
        if (state.pickerImages)
            renderPickerList(state);
        void ensurePickerList(state);
        // 打开就把焦点给搜索框：键盘流「打开 → 打几个字 → 点一张」一气呵成
        setTimeout(() => { var _a; return (_a = state.pickerSearch) === null || _a === void 0 ? void 0 : _a.focus(); }, 0);
    }
    else if (state.pickerObserver) {
        state.pickerObserver.disconnect();
        state.pickerObserver = null;
    }
}
/** 「读剪贴板」按钮：拿不到权限时给一条可操作的提示（别只说失败）。 */
async function pasteFromClipboardApi(state) {
    const clipboard = navigator.clipboard;
    if (!(clipboard === null || clipboard === void 0 ? void 0 : clipboard.read)) {
        setBanner(state, '这个面板拿不到剪贴板读取接口 —— 把光标放进输入框按 Ctrl+V 即可。', 'info', [], BANNER_HOLD.INFO);
        return;
    }
    try {
        const items = await clipboard.read();
        const blobs = [];
        for (const item of items) {
            const type = item.types.find((candidate) => candidate.startsWith('image/'));
            if (!type)
                continue;
            blobs.push({ blob: await item.getType(type), name: `剪贴板图片-${blobs.length + 1}` });
        }
        if (blobs.length === 0) {
            setBanner(state, '剪贴板里没有图片（只有文字）。', 'info', [], BANNER_HOLD.INFO);
            return;
        }
        await attachBlobs(state, blobs, 'clipboard');
    }
    catch (error) {
        setBanner(state, `读剪贴板失败：${error instanceof Error ? error.message : String(error)}（把光标放进输入框按 Ctrl+V 也一样能用）。`, 'info', [], BANNER_HOLD.INFO);
    }
}
// ---------------------------------------------------------------- 动作
/** 启动 agent 并把结果反映到横幅上。 */
async function startAgent(state) {
    var _a;
    if (state.startRequested)
        return;
    state.startRequested = true;
    setBanner(state, '正在启动 agent…（首次几十秒，请稍等）', 'info');
    try {
        const result = await call(constants_1.MSG.startAgent);
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
            setBanner(state, (_a = result === null || result === void 0 ? void 0 : result.error) !== null && _a !== void 0 ? _a : '启动失败', 'error', [{ label: '重试', run: () => void startAgent(state) }]);
        }
        else {
            setBanner(state, null);
        }
    }
    catch (error) {
        setBanner(state, `启动失败：${String(error)}`, 'error');
    }
    finally {
        state.startRequested = false;
        void refreshState(state);
    }
}
/** 重新同步 profile 并把结果显示出来。 */
async function repairProfile(state) {
    var _a, _b;
    setBanner(state, '正在同步 profile…', 'info');
    try {
        const report = await call(constants_1.MSG.installProfile);
        if (report === null || report === void 0 ? void 0 : report.ok) {
            setBanner(state, `profile 已就位：${report.profileDir}\n${((_a = report.changes) === null || _a === void 0 ? void 0 : _a.length) ? report.changes.join('\n') : '（无变更）'}`, 'info');
        }
        else {
            setBanner(state, `修复失败：${(_b = report === null || report === void 0 ? void 0 : report.error) !== null && _b !== void 0 ? _b : '未知原因'}`, 'error');
        }
    }
    catch (error) {
        setBanner(state, `修复失败：${String(error)}`, 'error');
    }
    await refreshState(state);
}
/**
 * 时间戳 → `09-30 00:36`（面板窄，不带年份）。
 *
 * 字节数怎么显示见 `images.ts` 的 `formatBytes` —— **只有那一份**（历史抽屉的体积、
 * 图片碎片的大小都走它，别在面板里再抄一个）。
 */
function formatTime(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
 * 「当前对话区是不是一条历史会话」的横幅。
 *
 * 两种状态：**只读回放**（还没接上，给「继续此会话」按钮）与**已接上**（能接着聊，
 * 按钮收起来）。这是面板上唯一会告诉用户「你现在看的不是活会话」的地方，别省。
 */
function renderHistoryBar(state) {
    var _a, _b;
    const bar = state.historyBar;
    if (!bar)
        return;
    const history = (_b = (_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.history) !== null && _b !== void 0 ? _b : null;
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
    if (state.resumeButton)
        state.resumeButton.hidden = history.live === true;
}
/** 打开/刷新历史抽屉（**总是回到列表**：搜索状态属于一次交互，不该跨开关活着）。 */
async function openHistory(state) {
    state.historyOpen = true;
    if (state.history)
        state.history.hidden = false;
    state.historySearch = null;
    state.historyConfirm = null;
    syncHistoryControls(state);
    await refreshHistory(state);
}
/** 抽屉头部那几个控件跟着「当前是列表还是搜索结果 / 有没有在忙」调整。 */
function syncHistoryControls(state) {
    const searching = state.historySearch !== null;
    if (state.btnHistorySearch) {
        state.btnHistorySearch.disabled = state.historyBusy;
        state.btnHistorySearch.textContent = state.historyBusy ? '搜索中…' : '搜全文';
    }
    if (state.btnHistoryBack)
        state.btnHistoryBack.hidden = !searching;
    if (state.historySearchEl)
        state.historySearchEl.placeholder = searching ? '筛选标题…（Esc 返回列表）' : '筛选标题…（Enter = 搜全文）';
    if (state.btnHistoryRefreshEl)
        state.btnHistoryRefreshEl.disabled = state.historyBusy;
}
/** 重新读一遍列表（不动搜索状态）。 */
async function loadHistoryList(state) {
    var _a;
    if (state.historyNote) {
        state.historyNote.textContent = '读取中…（直接读 $DSH_HOME/sessions，不需要 agent 在跑）';
        state.historyNote.dataset.tone = '';
    }
    let reply;
    try {
        reply = await call(constants_1.MSG.historyList, { limit: 30 });
    }
    catch (error) {
        reply = { ok: false, error: String(error) };
    }
    state.historySessions = (_a = reply.sessions) !== null && _a !== void 0 ? _a : [];
    renderHistoryList(state, reply);
}
/** 按「当前是列表还是搜索结果」重画抽屉（删完 / 导出完调用它）。 */
async function refreshHistory(state) {
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
function renderHistoryList(state, reply) {
    var _a, _b;
    const list = state.historyList;
    if (!list)
        return;
    list.textContent = '';
    const all = (_a = reply.sessions) !== null && _a !== void 0 ? _a : [];
    const shown = filterSessions(all, state.historyQuery);
    if (state.historyNote) {
        if (!reply.ok) {
            state.historyNote.textContent = `读取失败：${(_b = reply.error) !== null && _b !== void 0 ? _b : '未知原因'}`;
            state.historyNote.dataset.tone = 'error';
        }
        else {
            state.historyNote.textContent =
                `${all.length} 条会话（按最后修改时间倒序）` +
                    (state.historyQuery ? ` · 标题筛出 ${shown.length} 条` : '') +
                    ' · 点一条只读回放，右下角可以导出 / 删除';
            state.historyNote.dataset.tone = '';
        }
    }
    if (!reply.ok)
        return;
    for (const session of shown)
        list.appendChild(historyRow(state, session));
    if (shown.length === 0) {
        list.appendChild(el('div', 'dsh-history-empty', all.length === 0 ? '这个工程还没有历史会话。' : '没有标题匹配的会话 —— 试试「搜全文」（它连内容一起搜）。'));
    }
}
/** 搜索框里的词 → 命中的会话（大小写不敏感，标题与 id 都算）。 */
function filterSessions(sessions, query) {
    const needle = query.trim().toLowerCase();
    if (!needle)
        return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
}
/**
 * 画一条会话（列表与搜索结果共用）。
 *
 * ⚠ 行**不能**整个是一颗 `<button>`：里面有导出/删除按钮，按钮套按钮既是非法 HTML，
 * 点击事件也会互相打架。所以外壳是 `div`，可点的部分是里面那颗 `.dsh-history-open`。
 */
function historyRow(state, session) {
    const row = el('div', 'dsh-history-item');
    row.dataset.current = session.current ? 'true' : 'false';
    row.dataset.id = session.id;
    const open = el('button', 'dsh-history-open');
    open.type = 'button';
    open.title = session.id;
    open.appendChild(el('div', 'dsh-history-item-title', session.title || '(无标题)'));
    open.appendChild(el('div', 'dsh-history-item-meta', `${formatTime(session.updatedAt)} · ${session.turns} 轮 · ${(0, images_1.formatBytes)(session.bytes)}` +
        (session.current ? ' · 正在显示' : '')));
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
function historyActions(state, sessionId) {
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
        const parts = [`删除这条会话？${confirm.fileCount} 个文件 · ${(0, images_1.formatBytes)(confirm.bytes)}`];
        parts.push('图片附件默认不跟着删');
        if (confirm.reclaim)
            parts.push('顺带回收无引用附件（要全库扫一遍，通常 1~2 分钟）');
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
function closeHistory(state) {
    state.historyOpen = false;
    state.historyConfirm = null;
    if (state.history)
        state.history.hidden = true;
}
/**
 * 点一条历史会话：让主进程读日志并回放（只读）。
 *
 * @param state - 面板状态。
 * @param sessionId - 会话 id。
 * @param jumpTo - 可选，回放完滚到这条**事件 seq**（全文搜索命中时用）。
 */
async function openHistorySession(state, sessionId, jumpTo) {
    var _a;
    if (state.historyNote)
        state.historyNote.textContent = '正在读日志并回放…（大日志会稍慢）';
    try {
        const reply = await call(constants_1.MSG.historyOpen, {
            sessionId,
            jumpTo,
        });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            if (state.historyNote) {
                state.historyNote.textContent = `回放失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`;
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
    }
    catch (error) {
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
async function runHistorySearch(state, query, silent = false) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const text = query.trim();
    if (!text) {
        state.historySearch = null;
        syncHistoryControls(state);
        await loadHistoryList(state);
        return;
    }
    if (state.historyBusy)
        return;
    state.historyBusy = true;
    state.historyConfirm = null;
    syncHistoryControls(state);
    if (state.historyNote && !silent) {
        state.historyNote.textContent = `正在搜「${text}」…（直接读盘；会话多的时候最多几秒）`;
        state.historyNote.dataset.tone = '';
    }
    try {
        const reply = await call(constants_1.MSG.historySearch, {
            query: text,
            // 预算是**面板**给的：它知道自己在等多久。上限由主进程再夹一道。
            limit: 20,
            perSession: 3,
            maxSessions: 150,
            budgetMs: 6000,
        });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            state.historySearch = null;
            state.historyBusy = false;
            syncHistoryControls(state);
            renderHistoryList(state, { ok: false, error: (_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因' });
            return;
        }
        state.historySearch = {
            query: (_b = reply.query) !== null && _b !== void 0 ? _b : text,
            hits: (_c = reply.hits) !== null && _c !== void 0 ? _c : [],
            scanned: (_d = reply.scanned) !== null && _d !== void 0 ? _d : 0,
            available: (_e = reply.available) !== null && _e !== void 0 ? _e : 0,
            partial: reply.partial === true,
            stoppedBy: (_f = reply.stoppedBy) !== null && _f !== void 0 ? _f : null,
            elapsedMs: (_g = reply.elapsedMs) !== null && _g !== void 0 ? _g : 0,
            scannedBytes: (_h = reply.scannedBytes) !== null && _h !== void 0 ? _h : 0,
        };
        renderSearchResults(state);
    }
    catch (error) {
        state.historySearch = null;
        renderHistoryList(state, { ok: false, error: String(error) });
    }
    finally {
        state.historyBusy = false;
        syncHistoryControls(state);
    }
}
/** 停止原因是给人看的一句话（说不清就不说，别编）。 */
function stoppedText(stoppedBy) {
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
function renderSearchResults(state) {
    const list = state.historyList;
    const found = state.historySearch;
    if (!list || !found)
        return;
    list.textContent = '';
    if (state.historyNote) {
        const covered = `扫了 ${found.scanned}/${found.available} 个会话 · ${(0, images_1.formatBytes)(found.scannedBytes)} · ${found.elapsedMs} ms`;
        state.historyNote.textContent = found.partial
            ? `「${found.query}」命中 ${found.hits.length} 条 —— ⚠ 没搜完：${stoppedText(found.stoppedBy)}（${covered}）。关键词写细一点能搜得更快更准。`
            : `「${found.query}」命中 ${found.hits.length} 条 · 整个工程都扫过了（${covered}）`;
        state.historyNote.dataset.tone = found.partial ? 'warn' : '';
    }
    for (const hit of found.hits)
        list.appendChild(searchHitRow(state, hit));
    if (found.hits.length === 0) {
        list.appendChild(el('div', 'dsh-history-empty', found.partial
            ? '这几条里没有 —— 但不是「整个工程都没有」：这次没搜完（见上面那行）。'
            : '整个工程都没有这个词。'));
    }
}
/** 画一条搜索命中（标题 + 元信息 + 片段 + 同一套动作按钮）。 */
function searchHitRow(state, hit) {
    const row = el('div', 'dsh-history-item dsh-history-hit');
    const open = el('button', 'dsh-history-open');
    open.type = 'button';
    open.title = `${hit.id}\n点一下只读回放，并滚到命中的那一条`;
    open.appendChild(el('div', 'dsh-history-item-title', hit.title || '(无标题)'));
    open.appendChild(el('div', 'dsh-history-item-meta', `${formatTime(hit.updatedAt)} · ${hit.turns} 轮 · ${(0, images_1.formatBytes)(hit.bytes)} · 命中 ${hit.hits} 次`));
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
async function resumeHistory(state, sessionId) {
    var _a;
    setBanner(state, '正在接上会话…（DSH 侧 agents.resume，要加载这段历史）', 'info');
    try {
        const reply = await call(constants_1.MSG.historyResume, sessionId ? { sessionId } : undefined);
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok))
            setBanner(state, `接上失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error');
        else
            setBanner(state, null);
    }
    catch (error) {
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
function historyBanner(state, text, tone) {
    setBanner(state, text, tone, undefined, 12000);
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
async function exportHistorySession(state, sessionId, format) {
    var _a, _b, _c, _d, _e;
    const slow = format === 'zip';
    historyBanner(state, slow ? '正在导出 ZIP…（要解压子孙会话日志、读附件像素，大会话会慢）' : `正在导出 ${format}…（大日志要读完整份）`, 'info');
    try {
        const reply = await call(constants_1.MSG.historyExport, { sessionId, format });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            historyBanner(state, `导出失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error');
            return;
        }
        const head = `已导出 ${(_b = reply.events) !== null && _b !== void 0 ? _b : 0} 条（${(0, images_1.formatBytes)((_c = reply.bytes) !== null && _c !== void 0 ? _c : 0)}）→ ${(_d = reply.path) !== null && _d !== void 0 ? _d : '?'}`;
        if (!slow) {
            historyBanner(state, head, 'info');
            return;
        }
        const facts = [head];
        if (reply.subagents) {
            const bits = [`子孙 ${reply.subagents.total} 个`];
            // ⚠ 子 agent 与 fork 分开说：用户关心的是「几个是我派出去的 agent」
            bits.push(`其中子 agent ${reply.subagents.subagentCount} · fork ${reply.subagents.forkCount}`);
            if (reply.subagents.maxDepth !== null)
                bits.push(`最深第 ${reply.subagents.maxDepth} 层`);
            if (reply.subagents.dangling.length > 0)
                bits.push(`有 ${reply.subagents.dangling.length} 个的父级在索引里找不到`);
            if (reply.subagents.incomplete)
                bits.push('索引扫描超预算，子孙可能不全');
            facts.push(`ZIP 里的会话：${bits.join(' · ')}`);
        }
        if (reply.media) {
            facts.push(`ZIP 里的附件：${reply.media.count} 个${reply.media.missing > 0 ? `（另有 ${reply.media.missing} 个引用读不到文件）` : ''}`);
        }
        if (reply.missingMedia && reply.missingMedia.length > 0) {
            facts.push(`读不到文件的附件：${reply.missingMedia.slice(0, 3).map((id) => id.slice(0, 14)).join('、')}…`);
        }
        for (const line of (_e = reply.notes) !== null && _e !== void 0 ? _e : [])
            facts.push(line);
        historyBanner(state, facts.join('\n'), 'info');
    }
    catch (error) {
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
async function deleteHistorySession(state, sessionId, dryRun, reclaim = false) {
    var _a, _b, _c, _d, _e, _f;
    try {
        const reply = await call(constants_1.MSG.historyDelete, { sessionId, dryRun, reclaim });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            state.historyConfirm = null;
            historyBanner(state, `删除失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error');
            await refreshHistory(state);
            return;
        }
        if (dryRun) {
            state.historyConfirm = {
                id: sessionId,
                fileCount: (_b = reply.fileCount) !== null && _b !== void 0 ? _b : 0,
                bytes: (_c = reply.bytes) !== null && _c !== void 0 ? _c : 0,
                reclaim,
            };
            await refreshHistory(state);
            return;
        }
        state.historyConfirm = null;
        const lines = [
            `已删除会话 ${sessionId.slice(0, 8)}…（${(_d = reply.fileCount) !== null && _d !== void 0 ? _d : 0} 个文件 · ${(0, images_1.formatBytes)((_e = reply.bytes) !== null && _e !== void 0 ? _e : 0)}）`,
        ];
        if (reply.reclaim) {
            const r = reply.reclaim;
            lines.push(`附件回收：候选 ${r.candidates} 个 → ${r.referenced} 个仍被别的会话引用、${r.orphans} 个已无引用 → 搬进墓碑 ${r.trashed} 个（${(0, images_1.formatBytes)(r.bytesFreed)}）`);
            lines.push(`全库扫了 ${r.scanned.sessions} 条会话（${(0, images_1.formatBytes)(r.scanned.bytes)} / ${Math.round(r.scanned.elapsedMs / 1000)} 秒）`);
            if (r.incomplete) {
                lines.push(`回收被中断（${(_f = r.incompleteReason) !== null && _f !== void 0 ? _f : '超预算'}）—— 一个都没搬：判据不全时误删不可逆，这是有意的`);
            }
            else if (r.trashed === 0) {
                lines.push('这次没有可回收的附件（候选里每一个都还被别的会话引用着）');
            }
            const skipped = r.skipped.filter((entry) => entry.reason !== 'still-referenced');
            if (skipped.length > 0) {
                lines.push(`跳过 ${skipped.length} 个（不是"还在用"，是别的守卫拦下的）：${skipped.slice(0, 3).map((entry) => entry.reason).join('、')}`);
            }
        }
        else {
            lines.push('图片附件是全局去重的，不随会话删除（勾「顺带回收无引用附件」才会去查一遍）');
        }
        historyBanner(state, lines.join('\n'), 'info');
        if (reply.cleared)
            setBanner(state, `已删除正在回放的那条会话（${sessionId.slice(0, 8)}…）—— 对话区已清空。`, 'info', undefined, 8000);
        await refreshHistory(state);
        await refreshState(state);
        await pollOnce(state);
    }
    catch (error) {
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
function applyJump(state) {
    if (state.jumpTo === null)
        return;
    const element = state.els.get(state.jumpTo);
    if (!element)
        return;
    state.jumpTo = null;
    element.dataset.hit = 'true';
    element.scrollIntoView({ block: 'center' });
    if (state.jumpTimer)
        clearTimeout(state.jumpTimer);
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
function usageTone(ratio) {
    if (ratio === null || !Number.isFinite(ratio))
        return '';
    if (ratio >= 0.85)
        return 'danger';
    if (ratio >= 0.6)
        return 'warn';
    return '';
}
/**
 * 状态行那颗 chip 上写什么（写不出东西就返回 null = 整颗藏起来）。
 *
 * 优先级：**占用率**（一眼能比大小）→ 退到「累计进出」（至少说明有数据）→ 什么都没有。
 * 为什么不显示 `0%`：`projected` 是 null 时占用率是**不知道**，不是 0。
 */
function usageChipText(usage) {
    if (!usage)
        return null;
    const { ratio, window, projected } = usage.context;
    if (ratio !== null && window !== null) {
        return `上下文 ${(ratio * 100).toFixed(1)}%`;
    }
    const totals = usage.usage.totals;
    if (totals)
        return `↑${(0, constants_1.formatTokens)(totals.input)} ↓${(0, constants_1.formatTokens)(totals.output)}`;
    if (projected !== null)
        return `上下文 ${(0, constants_1.formatTokens)(projected)}`;
    return null;
}
/** 画状态行那颗 chip（每次刷状态与每次广播都调，很便宜）。 */
function renderUsageChip(state) {
    var _a, _b, _c, _d, _e, _f;
    const chip = state.usageChip;
    if (!chip)
        return;
    const usage = (_b = (_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.usage) !== null && _b !== void 0 ? _b : null;
    const text = usageChipText(usage);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    const tone = usageTone((_c = usage === null || usage === void 0 ? void 0 : usage.context.ratio) !== null && _c !== void 0 ? _c : null);
    chip.dataset.tone = tone;
    const ratio = (_d = usage === null || usage === void 0 ? void 0 : usage.context.ratio) !== null && _d !== void 0 ? _d : null;
    const percent = ratio === null ? '占用率未知' : `占用率 ${(ratio * 100).toFixed(1)}%`;
    chip.title =
        `${percent}（预估 ${(0, constants_1.formatTokens)((_e = usage === null || usage === void 0 ? void 0 : usage.context.projected) !== null && _e !== void 0 ? _e : null)} / 窗口 ${(0, constants_1.formatTokens)((_f = usage === null || usage === void 0 ? void 0 : usage.context.window) !== null && _f !== void 0 ? _f : null)}）\n` +
            '点开看明细（token 累计 / 组成 / 耗时 / 花费）';
}
/** 一行「标签 值」；值不是数就画「—」并把它做成灰色的（`null` 是有话要说的，不是空白）。 */
function usageLine(label, value, mono = false) {
    const line = el('div', 'dsh-usage-line');
    line.appendChild(el('span', 'dsh-usage-label', label));
    const valueEl = el('span', 'dsh-usage-value', value || '—');
    if (mono)
        valueEl.dataset.mono = 'true';
    line.appendChild(valueEl);
    return line;
}
/** 一块带标题的说明。 */
function usageBlock(title, lines) {
    const block = el('div', 'dsh-usage-block');
    block.appendChild(el('div', 'dsh-usage-block-title', title));
    for (const line of lines)
        block.appendChild(line);
    return block;
}
/** 「1.0M / 1.0M」这种给人看的写法（窗口未知时不写假的）。 */
function usageAmount(value) {
    return value === null ? '—' : (0, constants_1.formatTokens)(value);
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
function costLines(usage) {
    var _a, _b;
    const text = (0, cost_1.costTextOf)({
        cost: usage.cost,
        display: usage.costDisplay,
        ledger: usage.costLedger,
        note: usage.costNote,
        mounted: usage.costMounted,
        bundle: usage.costBundle,
    });
    const lines = [];
    if (text.amount !== null) {
        lines.push(usageLine(text.head, text.amount, true));
        if (text.usd !== null)
            lines.push(usageLine('账本原值（美元）', text.usd, true));
        if (text.calls !== null)
            lines.push(usageLine('模型调用', text.calls));
        if (text.today !== null) {
            lines.push(usageLine(`今日（${(_b = (_a = usage.costLedger) === null || _a === void 0 ? void 0 : _a.todayKey) !== null && _b !== void 0 ? _b : '今天'}，全部工程）`, text.today, true));
        }
    }
    for (const note of text.notes)
        lines.push(el('div', 'dsh-usage-source', note));
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
function timelineSlotWidth(point) {
    const steps = Math.min(Math.max(point.steps, 1), TIMELINE_SLOT_MAX_STEPS);
    return TIMELINE_SLOT_PX * steps + 1;
}
/** 柱子的 tip：这一根的全部事实（轮到哪、实测多少、估算多少、压缩了几处）。 */
function timelinePointTitle(point, contextWindow) {
    var _a;
    const lines = [];
    const where = point.turn === null
        ? `第 ${point.index} 根柱`
        : `第 ${point.turn} 回合 · 第 ${(_a = point.step) !== null && _a !== void 0 ? _a : '?'} 步（第 ${point.index} 根柱）`;
    lines.push(where + (point.steps > 1 ? ` —— 这一根合并了 ${point.steps} 步` : ''));
    lines.push(`${point.estimated ? '估算' : '实测'} ${(0, constants_1.formatTokens)(point.tokens)} token` +
        (contextWindow === null ? '' : `（占窗口 ${(point.tokens / contextWindow * 100).toFixed(1)}%）`));
    if (point.prompt !== null && point.total !== null) {
        lines.push(`实测 prompt ${(0, constants_1.formatTokens)(point.prompt)} · 估算 total ${(0, constants_1.formatTokens)(point.total)}`);
    }
    else if (point.total !== null) {
        lines.push(`只有估算的 total ${(0, constants_1.formatTokens)(point.total)}（provider 没报这次调用的 usage）`);
    }
    for (const cut of point.cuts) {
        lines.push(`✂ ${cut.kind === 'compaction' ? '压缩' : '裁剪'}：净释放 ${(0, constants_1.formatTokens)(cut.tokens)} token` +
            (cut.count === null ? '' : ` · 涉及 ${cut.count} 条记录`) +
            (cut.merged > 1 ? ` · 同一处连发了 ${cut.merged} 条（已合并成一个标记）` : '') +
            (cut.time === null ? '' : ` · ${formatTime(cut.time)}`));
    }
    return lines.join('\n');
}
/**
 * 画曲线本身：**回合带 + 柱林**，两排裹在同一个横向滚动容器里。
 *
 * 为什么两排要放在同一个滚动容器里：分开两个容器的话，滚动其中一个另一个不动 ——
 * 而「哪一根柱属于哪一轮」就靠它们对齐，滚起来错位等于没有回合带。
 */
function timelineChart(view) {
    const scroll = el('div', 'dsh-timeline-scroll');
    // ---- ① 回合带：**一整轮一条带**（宽度 = 这一轮所有柱的宽度和），交替底色 ----
    const bands = el('div', 'dsh-timeline-bands');
    const runs = [];
    for (const point of view.points) {
        const width = timelineSlotWidth(point);
        const last = runs[runs.length - 1];
        if (last && last.turn === point.turn)
            last.width += width;
        else
            runs.push({ turn: point.turn, width });
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
        if (point.estimated)
            bar.dataset.estimated = 'true';
        if (point.cuts.length > 0)
            bar.dataset.cut = 'true';
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
function timelineLines(usage) {
    const text = (0, constants_1.timelineTextOf)({ timeline: usage.timeline, note: usage.timelineNote });
    const lines = [];
    if (usage.timeline) {
        if (text.headline)
            lines.push(el('div', 'dsh-timeline-head', text.headline));
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
    for (const note of text.notes)
        lines.push(el('div', 'dsh-usage-source', note));
    return lines;
}
/**
 * 「这些数字有多新」——抽屉头部那一行（没有读数时换成原因，见 `renderUsage`）。
 *
 * 四个事实，缺一个都会让人误判：**来源**（检查点不是实时流）、**水位**（记到第几条事件）、
 * **落后多少条**、**写于何时**。这一行是整块用量里最容易被省略、也最不该省略的东西 ——
 * 一份「12% 占用」在落后一万条事件时是完全没有意义的。
 */
function usageFreshness(usage) {
    const parts = ['来自会话投影缓存（检查点，不是实时流）'];
    if (usage.seq !== null)
        parts.push(`水位第 ${usage.seq} 条事件`);
    if (usage.behind !== null)
        parts.push(usage.behind > 0 ? `落后 ${usage.behind} 条` : '已跟上');
    else
        parts.push('没有实时水位可比');
    if (usage.updatedAt > 0)
        parts.push(`写于 ${formatTime(usage.updatedAt)}`);
    return parts.join(' · ');
}
/**
 * 画用量抽屉。
 *
 * 为什么每次整块重建而不是就地更新：内容是「读一次的答案」，不需要保住任何输入状态
 * （对比：交互卡片里有用户正在敲的字，所以那边必须按签名跳过重画）。
 * 一眼能读完的十几行，重建比维护增量便宜得多。
 */
function renderUsage(state) {
    var _a, _b, _c, _d, _e, _f;
    const body = state.usageBody;
    if (!body)
        return;
    body.textContent = '';
    const usage = (_b = (_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.usage) !== null && _b !== void 0 ? _b : null;
    const note = (_d = (_c = state.snapshot) === null || _c === void 0 ? void 0 : _c.usageNote) !== null && _d !== void 0 ? _d : null;
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
        state.usageNoteEl.textContent = note !== null && note !== void 0 ? note : (usage ? usageFreshness(usage) : '');
        state.usageNoteEl.dataset.tone = note ? 'warn' : '';
    }
    if (!usage) {
        /**
         * 「没有数字可画」有两种来路，**不能混成一句话**：
         * 读失败（原因在上面那行，带警告色）与「这条会话还没有用量」。
         * 面板分不清具体是哪种（那是主进程的事），所以只说一句两种情况下都成立的话 +
         * 一个可操作的动作，而**原因永远由上面那一行负责**。
         */
        body.appendChild(el('div', 'dsh-usage-source', note
            ? '这里没有数字可画 —— 原因见上面那行。点「刷新」可以再读一次。'
            : '还没有读数 —— 用量在 agent 启动、发出第一条消息之后才有（数据来自 DSH 的会话投影缓存，agent 没在跑也能读）。'));
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
        body.appendChild(usageLine('下一次请求预估', `${usageAmount(context.projected)} / ${usageAmount(context.window)}（${(context.ratio * 100).toFixed(1)}%）`, true));
    }
    const contextLines = [];
    contextLines.push(usageLine('上一次请求实测', usageAmount(context.pressure), true));
    if (context.window === null)
        contextLines.push(usageLine('窗口上限', '不知道（DSH 还没记到）'));
    if (context.projected === null && context.ratio === null && context.window !== null) {
        contextLines.push(usageLine('占用率', '算不出来（缺 prompt 侧的实测）'));
    }
    body.appendChild(usageBlock('上下文', contextLines));
    // ---- ② 估算组成：**单独一块**，并明说它不参与上面那条 ----
    if (context.system !== null || context.tools !== null || context.messages !== null) {
        body.appendChild(usageBlock('上下文组成（估算）', [
            usageLine('系统提示', usageAmount(context.system), true),
            usageLine('工具表', usageAmount(context.tools), true),
            usageLine('对话', usageAmount(context.messages), true),
            el('div', 'dsh-usage-source', '这一块是按「四字符一个 token」估的：中文与 JSON schema 会明显低估，' +
                '三个数加起来也和上面那条占用率对不上 —— 所以它只用来比相对大小。'),
        ]));
    }
    // ---- ③ 本会话累计 ----
    const totals = usage.usage.totals;
    if (totals) {
        body.appendChild(usageBlock('本会话累计', [
            usageLine('输入（未命中缓存）', (0, constants_1.formatTokens)(totals.input), true),
            usageLine('输出', (0, constants_1.formatTokens)(totals.output), true),
            usageLine('缓存读', (0, constants_1.formatTokens)(totals.cacheRead), true),
            usageLine('缓存写', (0, constants_1.formatTokens)(totals.cacheWrite), true),
        ]));
    }
    if (usage.usage.last) {
        const last = usage.usage.last;
        body.appendChild(usageBlock(`最近一步（第 ${last.turn} 回合 / 第 ${last.step} 步）`, [
            usageLine('这一步', `输入 ${(0, constants_1.formatTokens)(last.buckets.input)} · 输出 ${(0, constants_1.formatTokens)(last.buckets.output)} · 缓存读 ${(0, constants_1.formatTokens)(last.buckets.cacheRead)}`, true),
        ]));
    }
    // ---- ④ 回合与耗时（`sessionStats`）----
    const sessionLines = [];
    if (usage.session.turns !== null || usage.session.steps !== null) {
        sessionLines.push(usageLine('回合 / 步', `${(_e = usage.session.turns) !== null && _e !== void 0 ? _e : '—'} 回合 · ${(_f = usage.session.steps) !== null && _f !== void 0 ? _f : '—'} 步`));
    }
    if (usage.session.llmMs !== null)
        sessionLines.push(usageLine('模型耗时', (0, constants_1.formatDuration)(usage.session.llmMs)));
    if (usage.session.toolMs !== null)
        sessionLines.push(usageLine('工具耗时', (0, constants_1.formatDuration)(usage.session.toolMs)));
    if (usage.session.ttftMs !== null && usage.session.ttftSteps) {
        sessionLines.push(usageLine('首字延迟均值', `${(0, constants_1.formatDuration)(usage.session.ttftMs / usage.session.ttftSteps)}（${usage.session.ttftSteps} 步）`));
    }
    if (usage.session.decodeMs !== null && usage.session.decodeTokens !== null && usage.session.decodeMs > 0) {
        const perSecond = (usage.session.decodeTokens / usage.session.decodeMs) * 1000;
        sessionLines.push(usageLine('生成速度', `${perSecond.toFixed(1)} tok/s（${(0, constants_1.formatTokens)(usage.session.decodeTokens)} 个输出 token）`));
    }
    if (sessionLines.length > 0)
        body.appendChild(usageBlock('这一局', sessionLines));
    // ---- ⑤ 上下文增长：**这一块通常没有曲线**（注册者是第三方，本 profile 不挂它）----
    // 与花费那一块同一套规矩：没有就说清是**哪一种没有**，绝不画一条空的坐标轴充数。
    body.appendChild(usageBlock('上下文增长', timelineLines(usage)));
    // ---- ⑥ 花费：**没有就说没有**，绝不显示 0 ----
    body.appendChild(usageBlock('花费', costLines(usage)));
    // ---- ⑦ 口径说明（一条都不许吞）----
    // 数据来源与水位在**头部那一行**（`#usage-note`，sticky、永远可见），这里只放说明。
    if (usage.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of usage.notes)
            notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}
/** 开/关用量抽屉。打开时**顺手要一次新读数**（缓存是攒着写的，旧读数可能过时了）。 */
function toggleUsage(state, open) {
    const next = open !== null && open !== void 0 ? open : !state.usageOpen;
    state.usageOpen = next;
    if (state.usageHost)
        state.usageHost.hidden = !next;
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
async function readUsage(state) {
    var _a, _b, _c, _d, _e, _f;
    if (state.usageBusy) {
        /**
         * 已经有一次在读：**不重复读盘**，但要把两颗「刷新」按钮都复原 ——
         * 调用方（哪一颗按钮都可能是）在调之前先把它禁用了，早退不还原的话它会**永远禁着**
         * （只在开启抽屉那一路已经在读时点刷新才会撞上，但撞上就是死按钮）。
         */
        if (state.btnUsageRefreshEl)
            state.btnUsageRefreshEl.disabled = false;
        if (state.btnProgressRefreshEl)
            state.btnProgressRefreshEl.disabled = false;
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
        const reply = await call(constants_1.MSG.sessionUsage);
        if (state.snapshot) {
            state.snapshot.usage = (_a = reply === null || reply === void 0 ? void 0 : reply.usage) !== null && _a !== void 0 ? _a : null;
            // ⚠ 读失败的原因有两处可能给：主进程的 note，或者这条请求本身抛了（error）
            state.snapshot.usageNote = (_c = (_b = reply === null || reply === void 0 ? void 0 : reply.note) !== null && _b !== void 0 ? _b : reply === null || reply === void 0 ? void 0 : reply.error) !== null && _c !== void 0 ? _c : null;
            /**
             * 同一条请求也带回了进度 —— 两个抽屉打的是**同一个**主进程方法（同一次读盘）。
             * 所以谁点的「刷新」都会把两边一起更新，不存在「用量是新的、清单是旧的」。
             */
            state.snapshot.progress = (_d = reply === null || reply === void 0 ? void 0 : reply.progress) !== null && _d !== void 0 ? _d : null;
            state.snapshot.progressNote = (_f = (_e = reply === null || reply === void 0 ? void 0 : reply.progressNote) !== null && _e !== void 0 ? _e : reply === null || reply === void 0 ? void 0 : reply.error) !== null && _f !== void 0 ? _f : null;
        }
    }
    catch (error) {
        if (state.snapshot) {
            state.snapshot.usage = null;
            state.snapshot.usageNote = `读用量失败：${String(error)}`;
            state.snapshot.progress = null;
            state.snapshot.progressNote = `读进度失败：${String(error)}`;
        }
    }
    finally {
        state.usageBusy = false;
        if (state.btnUsageRefreshEl)
            state.btnUsageRefreshEl.disabled = false;
        if (state.btnProgressRefreshEl)
            state.btnProgressRefreshEl.disabled = false;
        renderUsageChip(state);
        renderProgressChip(state);
        if (state.usageOpen)
            renderUsage(state);
        if (state.progressOpen)
            renderProgress(state);
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
function progressFreshness(progress) {
    const parts = [];
    if (progress.todosSource === 'events' && progress.todos !== null)
        parts.push('清单来自实时事件（agent 每写一次就到）');
    else if (progress.todosSource === 'checkpoint')
        parts.push('清单来自会话投影缓存');
    if (progress.currentTurn > 0)
        parts.push(`现在第 ${progress.currentTurn} 轮`);
    if (progress.turns.length > 0 || progress.goal) {
        if (progress.seq !== null)
            parts.push(`目标与回合目录来自会话投影缓存（水位第 ${progress.seq} 条事件）`);
        else
            parts.push('目标与回合目录来自会话投影缓存');
    }
    if (progress.behind !== null)
        parts.push(progress.behind > 0 ? `落后 ${progress.behind} 条` : '已跟上');
    if (progress.updatedAt > 0)
        parts.push(`写于 ${formatTime(progress.updatedAt)}`);
    return parts.join(' · ');
}
/** 画那颗 chip（没清单就整颗藏起来，绝不显示 `0/0`）。 */
function renderProgressChip(state) {
    var _a, _b, _c;
    const chip = state.progressChip;
    if (!chip)
        return;
    const progress = (_b = (_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.progress) !== null && _b !== void 0 ? _b : null;
    const text = (0, progress_1.progressChipText)(progress);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    chip.dataset.tone = (progress === null || progress === void 0 ? void 0 : progress.stale) ? 'stale' : '';
    const counts = (0, progress_1.todoCounts)((_c = progress === null || progress === void 0 ? void 0 : progress.todos) !== null && _c !== void 0 ? _c : []);
    const parts = [];
    parts.push(counts.total > 0 ? `完成 ${counts.done} / 共 ${counts.total}` : '清单是空的');
    if (counts.active > 0)
        parts.push(`进行中 ${counts.active}`);
    if (progress === null || progress === void 0 ? void 0 : progress.stale)
        parts.push(`这是第 ${progress.todosTurn} 轮写的，本轮还没写新的`);
    if ((progress === null || progress === void 0 ? void 0 : progress.todosSource) === 'checkpoint')
        parts.push('来自检查点（不是实时事件）');
    chip.title = `${parts.join(' · ')}\n点开看清单 / 目标 / 回合目录`;
}
/** 清单那一条（标记 + 文本）。 */
function todoItem(todo) {
    const item = el('div', 'dsh-todo-item');
    item.dataset.status = todo.status;
    item.appendChild(el('span', 'dsh-todo-mark', progress_1.TODO_MARK[todo.status]));
    item.appendChild(el('span', 'dsh-todo-text', todo.content));
    return item;
}
/**
 * 回合目录里的一条。
 *
 * 能跳的用 `<button>`（键盘也能用），跳不了的用 `<div>` —— 形状本身就在说
 * 「这一条点不动」，比画成按钮再弹一句「点不动」好。
 */
function turnItem(state, turn, current) {
    const jumpable = turn.entrySeq !== null;
    const item = el(jumpable ? 'button' : 'div', 'dsh-turn');
    item.dataset.jump = jumpable ? 'true' : 'false';
    if (current)
        item.dataset.current = 'true';
    const head = el('div', 'dsh-turn-head');
    head.appendChild(el('span', 'dsh-turn-no', `第 ${turn.turn} 轮`));
    // 每一行都自己说清「这条点不点得动」—— 让用户去翻底部的说明太绕
    head.appendChild(el('span', '', (0, progress_1.turnHeadHint)(jumpable)));
    item.appendChild(head);
    if (turn.prompt)
        item.appendChild(el('div', 'dsh-turn-prompt', turn.prompt));
    if (turn.response)
        item.appendChild(el('div', 'dsh-turn-response', turn.response));
    else if (current)
        item.appendChild(el('div', 'dsh-turn-response', '（这一轮还没结束）'));
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
function jumpToTurn(state, turn) {
    const target = turn.entrySeq;
    if (target === null) {
        setBanner(state, `第 ${turn.turn} 轮的正文已经不在面板的转写窗口里了（只保留最近 600 条）。`, 'info', undefined, 6000);
        return;
    }
    if (!state.els.has(target)) {
        setBanner(state, `第 ${turn.turn} 轮的正文刚刚被挤出转写窗口（面板只保留最近 600 条条目）—— 点「刷新」再看一眼目录。`, 'info', undefined, 6000);
        return;
    }
    toggleProgress(state, false);
    state.jumpTo = target;
    applyJump(state);
}
/**
 * 画进度抽屉（每次整块重建，理由与用量抽屉相同：内容是「读一次的答案」）。
 */
function renderProgress(state) {
    var _a, _b, _c, _d, _e;
    const body = state.progressBody;
    if (!body)
        return;
    body.textContent = '';
    const progress = (_b = (_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.progress) !== null && _b !== void 0 ? _b : null;
    const note = (_d = (_c = state.snapshot) === null || _c === void 0 ? void 0 : _c.progressNote) !== null && _d !== void 0 ? _d : null;
    if (state.progressNoteEl) {
        state.progressNoteEl.textContent = note !== null && note !== void 0 ? note : (progress ? progressFreshness(progress) : '');
        state.progressNoteEl.dataset.tone = note ? 'warn' : '';
    }
    if (!progress) {
        /**
         * 「没有数字可画」的两种来路不许混（与用量抽屉同一条纪律）：
         * 读失败 → 原因在上面那行；还没有读数 → 说清楚进度什么时候才有。
         */
        body.appendChild(el('div', 'dsh-usage-source', note
            ? '这里没有东西可画 —— 原因见上面那行。点「刷新」可以再读一次。'
            : '还没有进度 —— 清单要等 agent 写第一份待办，目标与回合目录来自会话投影缓存（agent 没在跑也能读）。'));
        return;
    }
    // ---- ① 待办清单（这一块是实时的）----
    const todos = progress.todos;
    const block = el('div', 'dsh-usage-block');
    block.appendChild(el('div', 'dsh-usage-block-title', '待办清单'));
    if (todos === null || todos.length === 0) {
        block.appendChild(el('div', 'dsh-usage-source', todos === null
            ? '这一轮 agent 还没有写清单（DSH 的投影在每一轮开始时把清单归零）。'
            : 'agent 明确写了一份空清单（是它自己写的，不是读不到）。'));
    }
    else {
        const counts = (0, progress_1.todoCounts)(todos);
        block.appendChild(el('div', 'dsh-todo-count', `完成 ${counts.done} / 共 ${counts.total}` +
            (counts.active > 0 ? ` · 进行中 ${counts.active}` : '') +
            (counts.total - counts.done - counts.active > 0 ? ` · 还没开始 ${counts.total - counts.done - counts.active}` : '')));
        const list = el('div', 'dsh-todo');
        for (const todo of todos)
            list.appendChild(todoItem(todo));
        block.appendChild(list);
    }
    /**
     * 两句必须说的话，按情况出现（顺序有意义：先说「这是哪一轮的」再说「数据从哪来」）。
     */
    if (progress.stale) {
        block.appendChild(el('div', 'dsh-usage-source', `⚠ 这份清单是第 ${progress.todosTurn} 轮写的 —— 第 ${progress.currentTurn} 轮开始后 DSH 已经把清单归零了，` +
            '也就是说「本轮 agent 还没写新清单」——下面这些不是现在正在做的事。'));
    }
    if (progress.todosSource === 'checkpoint') {
        block.appendChild(el('div', 'dsh-usage-source', '这一份来自会话投影缓存（不是实时事件）：它攒够 200 条事件或 5 秒才写一次，可能比面板上真实发生的事慢几秒。'));
    }
    body.appendChild(block);
    // ---- ② 目标（有才画）----
    if (progress.goal) {
        const goal = progress.goal;
        const lines = [];
        lines.push(usageLine('目标', goal.objective));
        lines.push(usageLine('阶段', `${(_e = progress_1.GOAL_PHASE_TEXT[goal.phase]) !== null && _e !== void 0 ? _e : goal.phase}` +
            (goal.maxGoalRounds > 0 ? ` · 已跑 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮` : '')));
        if (goal.blockedReason)
            lines.push(usageLine('卡住的原因', goal.blockedReason));
        body.appendChild(usageBlock('目标（goal 模式）', lines));
    }
    // ---- ③ 回合目录（整个日志，能点的就点）----
    if (progress.turns.length > 0) {
        const turnsBlock = el('div', 'dsh-usage-block');
        const hidden = progress.turnsTotal - progress.turns.length;
        turnsBlock.appendChild(el('div', 'dsh-usage-block-title', `回合目录（${progress.turnsTotal} 轮${hidden > 0 ? `，只列最近 ${progress.turns.length} 轮` : ''}）`));
        const list = el('div', 'dsh-todo');
        for (const turn of progress.turns)
            list.appendChild(turnItem(state, turn, turn.turn === progress.currentTurn));
        turnsBlock.appendChild(list);
        /**
         * 正在写的那一轮的草稿：它**还没定稿**，所以单独一行、斜体、低对比度 ——
         * 混进上面那份「已经结束的轮次」里会让人以为这一轮已经答完了。
         */
        if (progress.draft)
            turnsBlock.appendChild(el('div', 'dsh-turn-draft', `正在写：${progress.draft}`));
        turnsBlock.appendChild(el('div', 'dsh-usage-source', '目录是整个日志的（缓存折出来的）；能不能点取决于那一轮的正文还在不在面板的转写里 —— 面板只保留最近 600 条条目。'));
        body.appendChild(turnsBlock);
    }
    else {
        /**
         * ⚠ 这一块**必须**画出来，哪怕目录是空的：三块里缺一块而**什么都不说**，
         * 用户看到的是「面板上没有回合目录」——分不清「这条会话没有回合」与
         * 「缓存里没有这一行」。两句话完全不同（前者是事实，后者是数据源缺了一块）。
         */
        body.appendChild(usageBlock('回合目录', [
            el('div', 'dsh-usage-source', progress.currentTurn > 0
                ? `缓存里没有回合大纲（事件流显示已经到第 ${progress.currentTurn} 轮了）—— 这一块只有会话投影缓存给得出（agent 没在跑、或者缓存里没这一行时就看不到）。`
                : '这条会话还没有回合（还没发过消息）。'),
        ]));
    }
    // ---- ④ 口径说明 ----
    if (progress.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of progress.notes)
            notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}
/** 开/关进度抽屉（打开时顺手要一次新读数，理由与用量抽屉相同）。 */
function toggleProgress(state, open) {
    const next = open !== null && open !== void 0 ? open : !state.progressOpen;
    state.progressOpen = next;
    if (state.progressHost)
        state.progressHost.hidden = !next;
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
const ACTIVITY_POLL_MS = 4000;
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
async function readActivity(state, options = {}) {
    var _a, _b, _c;
    if (state.activityBusy)
        return;
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
    if (state.btnActivityRefreshEl)
        state.btnActivityRefreshEl.disabled = true;
    if (state.activityNoteEl && state.activityOpen) {
        state.activityNoteEl.textContent = '读取中…';
        state.activityNoteEl.dataset.tone = '';
    }
    try {
        const reply = await call(constants_1.MSG.panelActivity);
        state.activity = (_a = reply === null || reply === void 0 ? void 0 : reply.activity) !== null && _a !== void 0 ? _a : null;
        state.activityAt = Date.now();
        state.activityNote = (reply === null || reply === void 0 ? void 0 : reply.ok) ? null : `读活动失败：${(_b = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _b !== void 0 ? _b : '未知原因'}`;
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok) && !options.quiet) {
            setBanner(state, `读活动失败：${(_c = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _c !== void 0 ? _c : '未知原因'}`, 'error', undefined, 6000);
        }
    }
    catch (error) {
        state.activity = null;
        state.activityAt = Date.now();
        state.activityNote = `读活动失败：${String(error)}`;
        if (!options.quiet)
            setBanner(state, `读活动失败：${String(error)}`, 'error', undefined, 6000);
    }
    finally {
        state.activityBusy = false;
        if (state.btnActivityRefreshEl)
            state.btnActivityRefreshEl.disabled = false;
        renderActivity(state);
        renderActivityChip(state);
    }
}
/** 这颗 chip 该不该亮 + 亮什么（**没事就整个藏起来**，不写 0）。 */
function activityChipText(activity) {
    if (!activity)
        return '';
    const jobs = activity.jobs.length;
    const subs = activity.subagents.length;
    if (jobs === 0 && subs === 0)
        return '';
    const parts = [];
    if (jobs > 0)
        parts.push(`后台 ${jobs}`);
    if (subs > 0)
        parts.push(`子 ${subs}`);
    return parts.join(' · ');
}
/** 有东西还在跑吗（决定 chip 用不用强调色）。 */
function activityBusyNow(activity) {
    if (!activity)
        return false;
    return (activity.jobs.some((job) => job.status === 'running' || job.status === 'stopping') ||
        activity.subagents.some((row) => row.status === 'running'));
}
/** 画那颗 chip（没东西就藏起来 —— 与前两颗 chip 同一条纪律）。 */
function renderActivityChip(state) {
    var _a, _b;
    const chip = state.activityChip;
    if (!chip)
        return;
    const text = activityChipText(state.activity);
    if (!text) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.textContent = text;
    chip.dataset.tone = activityBusyNow(state.activity) ? 'busy' : '';
    const notes = [];
    notes.push(`点开看后台任务与子 agent（读到 ${formatTime((_b = (_a = state.activity) === null || _a === void 0 ? void 0 : _a.at) !== null && _b !== void 0 ? _b : 0)}）`);
    if (activityBusyNow(state.activity))
        notes.push('还有东西在跑');
    chip.title = notes.join(' · ');
}
/** job 状态的中文与色调（认不出的原值是「不明」，不是「在跑」）。 */
const JOB_STATUS_TEXT = {
    running: { text: '运行中', tone: 'busy' },
    stopping: { text: '正在停', tone: 'busy' },
    completed: { text: '已完成', tone: 'done' },
    killed: { text: '已终止', tone: 'warn' },
    failed: { text: '失败', tone: 'error' },
    unknown: { text: '状态不明', tone: 'warn' },
};
/** 子 agent 忙闲的中文（`ready` = 只在磁盘上，可以接着聊）。 */
const SUBAGENT_STATUS_TEXT = {
    running: '运行中',
    idle: '空闲',
    ready: '可继续',
};
/** 后台任务那一行。 */
function jobItem(job, currentSessionId) {
    var _a;
    const item = el('div', 'dsh-activity-item dsh-job');
    const status = (_a = JOB_STATUS_TEXT[job.status]) !== null && _a !== void 0 ? _a : JOB_STATUS_TEXT.unknown;
    item.dataset.tone = status.tone;
    const head = el('div', 'dsh-activity-item-head');
    head.appendChild(el('span', 'dsh-activity-badge', status.text));
    if (job.kind)
        head.appendChild(el('span', 'dsh-activity-kind', job.kind));
    head.appendChild(el('span', 'dsh-activity-id', job.id));
    item.appendChild(head);
    // label 可能是整条命令原文（pwsh 就是这么传的）：原样画，靠 CSS 换行，不做二次加工
    item.appendChild(el('div', 'dsh-activity-label', job.label || '（这条任务没有说明）'));
    const meta = [];
    if (job.startedAt)
        meta.push(`起于 ${formatTime(job.startedAt)}`);
    if (job.finishedAt)
        meta.push(`结束于 ${formatTime(job.finishedAt)}`);
    if (job.detail)
        meta.push(job.detail);
    // 子 agent 起的任务归子 agent —— 不标出来的话，用户会以为「我这条会话怎么多了个任务」
    if (job.ownerSessionId && currentSessionId && job.ownerSessionId !== currentSessionId) {
        meta.push(`属于子 agent ${job.ownerSessionId.slice(0, 8)}…${job.depth === null ? '' : `（第 ${job.depth} 层）`}`);
    }
    if (meta.length > 0)
        item.appendChild(el('div', 'dsh-activity-meta', meta.join(' · ')));
    return item;
}
/** 子 agent 那一行（带一个「中断当前一轮」按钮）。 */
function subagentItem(state, row) {
    var _a, _b;
    const item = el('div', 'dsh-activity-item dsh-subagent');
    item.dataset.tone = row.status === 'running' ? 'busy' : row.kind === 'diagnostic' ? 'warn' : 'idle';
    const head = el('div', 'dsh-activity-item-head');
    head.appendChild(el('span', 'dsh-activity-badge', (_a = SUBAGENT_STATUS_TEXT[row.status]) !== null && _a !== void 0 ? _a : row.status));
    head.appendChild(el('span', 'dsh-activity-kind', row.mode === 'continuable' ? '可继续' : '一次性'));
    if (row.depth !== null)
        head.appendChild(el('span', 'dsh-activity-id', `第 ${row.depth} 层`));
    /**
     * 「中断」只对**活着的**子 agent 有意义（`ready` = 它只在磁盘上，运行时里没有它的 agent）。
     * 按钮做不出来的时候不画一个禁用的假按钮 —— 直接不画。
     */
    if (row.status !== 'ready') {
        const stop = el('button', 'dsh-btn dsh-activity-stop', '中断当前一轮');
        stop.title = '只停它当前这一轮 —— 会话与上下文都留着（同「停止本轮」）';
        stop.addEventListener('click', () => {
            stop.disabled = true;
            void (async () => {
                var _a;
                try {
                    const reply = await call(constants_1.MSG.subagentInterrupt, { subagentId: row.id });
                    if (!(reply === null || reply === void 0 ? void 0 : reply.ok))
                        setBanner(state, `中断失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error', undefined, 6000);
                }
                catch (error) {
                    setBanner(state, `中断失败：${String(error)}`, 'error', undefined, 6000);
                }
                finally {
                    stop.disabled = false;
                    void readActivity(state, { quiet: true });
                }
            })();
        });
        head.appendChild(stop);
    }
    item.appendChild(head);
    item.appendChild(el('div', 'dsh-activity-label', row.label || `（这条子 agent 没给说明）${row.id.slice(0, 8)}…`));
    const meta = [`${row.id.slice(0, 8)}…`];
    if (row.hasChildren)
        meta.push('它自己还带了下级');
    if (row.kind === 'diagnostic')
        meta.push(`这条记录本身有问题：${(_b = row.reason) !== null && _b !== void 0 ? _b : '原因不明'}`);
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
function renderActivity(state) {
    var _a, _b, _c;
    const body = state.activityBody;
    if (!body)
        return;
    body.textContent = '';
    const activity = state.activity;
    if (state.activityNoteEl) {
        // 三句话的优先级：**读不出来 / 没起 agent 的原因** > 读到几点 > 还没有读数
        const note = (_a = state.activityNote) !== null && _a !== void 0 ? _a : (activity ? `读到 ${formatTime(activity.at)} · 这两块只活在运行时进程的内存里（agent 停掉就没了）` : '');
        state.activityNoteEl.textContent = note;
        state.activityNoteEl.dataset.tone = state.activityNote ? 'warn' : '';
    }
    if (!activity) {
        body.appendChild(el('div', 'dsh-usage-source', '还没有读数 —— 点上面的「刷新」，或者先让 agent 跑起来（这两块在内存里）。'));
        return;
    }
    // ---- 上半块：后台任务
    body.appendChild(usageBlock('后台任务', activityAvailableLines(activity, 'jobs')));
    if (activity.jobsAvailable) {
        if (activity.jobs.length === 0) {
            body.appendChild(el('div', 'dsh-usage-source', '现在没有后台任务。'));
        }
        else {
            const list = el('div', 'dsh-activity-list');
            for (const job of activity.jobs)
                list.appendChild(jobItem(job, (_c = (_b = state.snapshot) === null || _b === void 0 ? void 0 : _b.sessionId) !== null && _c !== void 0 ? _c : null));
            body.appendChild(list);
            // ⚠ 这句是「如实说明」而不是免责：用户最想看的恰恰是输出
            body.appendChild(el('div', 'dsh-usage-source', '看不到任务的输出 —— 每个后台任务只有一个消费游标，面板读一次就会把模型的 job_output 变成「(no new output)」。' +
                '想看输出就在对话里让模型调 job_output。'));
        }
    }
    // ---- 下半块：子 agent
    body.appendChild(usageBlock('子 agent', activityAvailableLines(activity, 'subagents')));
    if (activity.subagentsAvailable) {
        if (activity.subagents.length === 0) {
            body.appendChild(el('div', 'dsh-usage-source', '没有子 agent。'));
        }
        else {
            const list = el('div', 'dsh-activity-list');
            for (const row of activity.subagents)
                list.appendChild(subagentItem(state, row));
            body.appendChild(list);
            body.appendChild(el('div', 'dsh-usage-source', '「一次性」的子 agent 结构上不能再发消息（只有「可继续」的能接着聊）；「中断」只停它当前这一轮，会话与上下文都留着。'));
        }
    }
    if (activity.notes.length > 0) {
        const notes = el('div', 'dsh-usage-notes');
        for (const text of activity.notes)
            notes.appendChild(el('div', 'dsh-usage-notes-item', text));
        body.appendChild(notes);
    }
}
/**
 * 一块的「不可用」那几行（服务没挂时说清是哪个服务，而不是画一个空列表）。
 *
 * @returns 可直接塞进 `usageBlock` 的元素数组（可用时是空数组）。
 */
function activityAvailableLines(activity, which) {
    const available = which === 'jobs' ? activity.jobsAvailable : activity.subagentsAvailable;
    if (available)
        return [];
    const reason = which === 'jobs' ? activity.jobsReason : activity.subagentsReason;
    return [el('div', 'dsh-usage-source', reason !== null && reason !== void 0 ? reason : `这个 profile 没挂 ${which} 服务，所以看不到。`)];
}
/** 开/关活动抽屉（打开时顺手问一次 —— 它没有任何后台推送，不问就永远是空的）。 */
function toggleActivity(state, open) {
    const next = open !== null && open !== void 0 ? open : !state.activityOpen;
    state.activityOpen = next;
    if (state.activityHost)
        state.activityHost.hidden = !next;
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
function shouldPollActivity(state) {
    var _a;
    if (state.activityBusy)
        return false;
    if (Date.now() - state.activityAt < ACTIVITY_POLL_MS)
        return false;
    if (state.activityOpen)
        return true;
    if ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running)
        return true;
    return state.activityChip !== null && state.activityChip.hidden === false;
}
/** 当前「正在干什么」（状态行左半边）。 */
function liveText(state) {
    var _a, _b;
    const snapshot = state.snapshot;
    if (!snapshot)
        return { text: '读取状态…', tone: 'idle' };
    if (snapshot.status === 'error')
        return { text: (_a = snapshot.lastError) !== null && _a !== void 0 ? _a : '出错', tone: 'error' };
    if (snapshot.running) {
        // 最后一个还没结果的工具 = 当前在跑的那个
        let runningTool = '';
        for (const entry of state.entries.values()) {
            if (entry.kind === 'tool' && entry.tool && !entry.tool.done)
                runningTool = entry.tool.name;
        }
        return { text: runningTool ? `运行中：${runningTool}` : '思考中…', tone: 'busy' };
    }
    return { text: (_b = STATUS_TEXT[snapshot.status]) !== null && _b !== void 0 ? _b : snapshot.status, tone: 'idle' };
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
function interactionSignature(list, sent) {
    return JSON.stringify([
        [...sent].sort(),
        list.map((view) => { var _a; return [view.id, view.kind, ((_a = view.questions) !== null && _a !== void 0 ? _a : []).map((question) => question.id).join(',')]; }),
    ]);
}
/** 卡片里某道题的「其他」输入框当前值（没写就是空串）。 */
function customValueOf(card, questionId) {
    for (const input of card.querySelectorAll('.dsh-interaction-input')) {
        if (input.dataset.question === questionId)
            return input.value.trim();
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
function collectAnswers(card, view) {
    var _a, _b;
    const out = [];
    for (const question of (_a = view.questions) !== null && _a !== void 0 ? _a : []) {
        const selected = [];
        for (const button of card.querySelectorAll('.dsh-interaction-option')) {
            if (button.dataset.question === question.id && button.dataset.on === '1')
                selected.push((_b = button.textContent) !== null && _b !== void 0 ? _b : '');
        }
        const custom = customValueOf(card, question.id);
        if (selected.length === 0 && !custom)
            continue;
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
async function answerInteraction(state, view, decision) {
    var _a;
    if (state.interactionSent.has(view.id))
        return;
    state.interactionSent.add(view.id);
    renderInteractions(state);
    try {
        const reply = await call(constants_1.MSG.interactionAnswer, decision);
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            state.interactionSent.delete(view.id);
            renderInteractions(state);
            setBanner(state, (_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '回答没有送出去', 'error', [], BANNER_HOLD.ERROR);
        }
    }
    catch (error) {
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
function buildInteractionCard(state, view) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const sent = state.interactionSent.has(view.id);
    const questions = (_a = view.questions) !== null && _a !== void 0 ? _a : [];
    const planReview = view.kind === 'question' && ((_c = (_b = questions[0]) === null || _b === void 0 ? void 0 : _b.intent) === null || _c === void 0 ? void 0 : _c.kind) === 'plan-review';
    const card = el('div', 'dsh-interaction-card');
    card.dataset.kind = view.kind === 'approval' ? 'approval' : planReview ? 'plan' : 'question';
    const head = el('div', 'dsh-interaction-head');
    head.appendChild(el('span', 'dsh-interaction-badge', view.kind === 'approval' ? '需要你批准' : planReview ? '计划评审' : '模型在等你回答'));
    const source = (_d = view.toolName) !== null && _d !== void 0 ? _d : (view.agentId ? `agent ${view.agentId.length > 16 ? view.agentId.slice(0, 8) : view.agentId}` : '');
    if (source) {
        const tag = el('span', 'dsh-interaction-source', source);
        tag.title = `${view.agentId ? `agent ${view.agentId}` : ''}${view.sessionId ? `\n会话 ${view.sessionId}` : ''}`;
        head.appendChild(tag);
    }
    const close = el('button', 'dsh-icon-btn', '✕');
    close.title = view.kind === 'approval' ? '关掉这次授权请求（按「取消」处理）' : '关掉不回答（模型会当作「你要插话」，本轮结束）';
    close.disabled = sent;
    close.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'dismiss' }));
    head.appendChild(close);
    card.appendChild(head);
    /** 单选 + 只有一道题 = 点一下就是答案（最常见的形态，少一次点击）。 */
    const single = questions.length === 1 && questions[0].multiSelect !== true;
    /** 单选那道题的「其他」输入框（它的内容决定要不要露出「提交回答」）。 */
    let singleInput = null;
    const body = el('div', 'dsh-interaction-body');
    if (view.kind === 'approval') {
        body.appendChild(el('div', 'dsh-interaction-question', `要执行：${(_e = view.toolName) !== null && _e !== void 0 ? _e : '(未知工具)'}`));
        if (view.reason)
            body.appendChild(el('div', 'dsh-interaction-reason', view.reason));
    }
    else {
        for (const question of questions) {
            const block = el('div', 'dsh-interaction-question-block');
            if (question.header)
                block.appendChild(el('div', 'dsh-interaction-header', question.header));
            block.appendChild(el('div', 'dsh-interaction-question', question.question));
            if (question.detail) {
                const detail = el('div', 'dsh-interaction-detail');
                (0, markdown_1.renderMarkdown)(detail, question.detail);
                block.appendChild(detail);
            }
            const options = el('div', 'dsh-interaction-options');
            for (const option of (_f = question.options) !== null && _f !== void 0 ? _f : []) {
                const button = el('button', 'dsh-interaction-option', option.label);
                button.dataset.question = question.id;
                button.dataset.on = '0';
                if (option.description)
                    button.title = option.description;
                // 「批准」那一项标绿：intent 用**名字**指定，面板不许按顺序猜（同 DSH 口径）
                if (((_g = question.intent) === null || _g === void 0 ? void 0 : _g.approve) === option.label)
                    button.dataset.role = 'approve';
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
            if (((_h = question.options) !== null && _h !== void 0 ? _h : []).length > 0)
                block.appendChild(options);
            const input = el('input', 'dsh-interaction-input');
            input.type = 'text';
            input.spellcheck = false;
            input.disabled = sent;
            input.dataset.question = question.id;
            input.placeholder = ((_j = question.options) !== null && _j !== void 0 ? _j : []).length > 0 ? '其他（可留空 —— 想自己写一句就填这里）' : '写下你的回答';
            block.appendChild(input);
            if (single)
                singleInput = input;
            body.appendChild(block);
        }
    }
    card.appendChild(body);
    const actions = el('div', 'dsh-interaction-actions');
    if (view.kind === 'approval') {
        const allow = el('button', 'dsh-btn dsh-interaction-allow', '允许一次');
        allow.title = '只批准这一次（DSH 的 allowed-once：授权不跨调用保留）';
        allow.disabled = sent;
        allow.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'answer', outcome: 'allowed-once' }));
        const deny = el('button', 'dsh-btn', '拒绝');
        deny.disabled = sent;
        deny.addEventListener('click', () => void answerInteraction(state, view, { id: view.id, action: 'answer', outcome: 'rejected' }));
        actions.appendChild(allow);
        actions.appendChild(deny);
    }
    else {
        const submit = el('button', 'dsh-btn dsh-interaction-submit', sent ? '已提交…' : '提交回答');
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
                var _a;
                const typed = ((_a = singleInput === null || singleInput === void 0 ? void 0 : singleInput.value.trim()) !== null && _a !== void 0 ? _a : '') !== '';
                if (typed && !actions.contains(submit))
                    actions.appendChild(submit);
                if (!typed && actions.contains(submit))
                    submit.remove();
            };
            singleInput === null || singleInput === void 0 ? void 0 : singleInput.addEventListener('input', sync);
            sync();
        }
        else {
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
function renderInteractions(state) {
    var _a;
    const host = state.interactionHost;
    if (!host)
        return;
    const list = (_a = state.interactions) !== null && _a !== void 0 ? _a : [];
    // 已经消失的交互，把「刚提交过」的记号一起清掉（否则同一个 id 复用时会误禁用）
    for (const id of [...state.interactionSent]) {
        if (!list.some((view) => view.id === id))
            state.interactionSent.delete(id);
    }
    const sig = interactionSignature(list, state.interactionSent);
    if (sig === state.interactionSig)
        return;
    state.interactionSig = sig;
    host.textContent = '';
    host.hidden = list.length === 0;
    for (const view of list)
        host.appendChild(buildInteractionCard(state, view));
}
/** 拉一次状态（状态点、头顶两行、状态行、横幅、空态、外观）。 */
async function refreshState(state) {
    var _a, _b, _c, _d, _e, _f, _g;
    let reply;
    try {
        reply = await call(constants_1.MSG.getState);
    }
    catch {
        return; // 主进程忙/面板刚挂载：下一轮再说
    }
    if (!(reply === null || reply === void 0 ? void 0 : reply.ok) || !reply.agent)
        return;
    state.snapshot = reply.agent;
    state.interactions = Array.isArray(reply.agent.interactions) ? reply.agent.interactions : [];
    if (reply.settings)
        state.settings = reply.settings;
    applyAppearance(state);
    if (state.dot) {
        state.dot.dataset.state = reply.agent.status;
        state.dot.title = (_a = STATUS_TEXT[reply.agent.status]) !== null && _a !== void 0 ? _a : reply.agent.status;
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
        state.title.textContent = title || `DSH · ${constants_1.PROFILE_NAME}`;
        state.title.title = title ? `会话标题：${title}` : `DSH · ${constants_1.PROFILE_NAME}（这条会话还没有标题）`;
    }
    if (state.sub) {
        const parts = [];
        if (settings)
            parts.push(`${settings.provider}/${settings.model}`);
        if (reply.agent.status === 'ready' && reply.agent.lastBootMs) {
            parts.push(`启动 ${(reply.agent.lastBootMs / 1000).toFixed(1)}s`);
        }
        if (reply.agent.pid)
            parts.push(`pid ${reply.agent.pid}`);
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
        const parts = [];
        if (settings)
            parts.push(`effort ${settings.reasoningEffort || '默认'}`);
        if (reply.agent.sessionId)
            parts.push(`会话 ${reply.agent.sessionId.slice(0, 8)}`);
        if (state.entries.size > 0)
            parts.push(`${state.entries.size} 条`);
        const text = parts.join(' · ');
        state.meta.textContent = text;
        state.meta.title = text;
    }
    // 状态行那颗「上下文 xx%」：数据是主进程随快照一起发下来的（`usage` / `usageNote`）
    renderUsageChip(state);
    // 那颗「待办 x/y」同理（数据来自 `progress` / `progressNote`）
    renderProgressChip(state);
    // 抽屉开着就一直跟着刷新（回合结束/跑完命令时主进程会重读并广播；清单是实时广播的）
    if (state.usageOpen)
        renderUsage(state);
    if (state.progressOpen)
        renderProgress(state);
    // 按钮可用性：发送要就绪，新会话要就绪，「启动/停止」按状态变形，重启只在跑着时才有意义
    const ready = reply.agent.status === 'ready';
    const settled = reply.agent.status === 'stopped' || reply.agent.status === 'error';
    if (state.sendButton)
        state.sendButton.disabled = !ready;
    const btnNew = (_b = state.root) === null || _b === void 0 ? void 0 : _b.querySelector('#btn-new');
    if (btnNew)
        btnNew.disabled = !ready;
    /**
     * 一个按钮干两件事：没跑时是「启动」，跑着时是「停止」。
     *
     * 之前只有「停止」一个状态 —— 用户把 agent 停掉之后**没有任何办法再起来**
     * （唯一的入口是重开面板 / 重启编辑器，`autoStart` 还只在「从没起过」时才触发），
     * 这就是「停止后没有重启按钮」这个坑的来源。
     */
    const btnStop = (_c = state.root) === null || _c === void 0 ? void 0 : _c.querySelector('#btn-stop');
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
    const btnInterrupt = (_d = state.root) === null || _d === void 0 ? void 0 : _d.querySelector('#btn-interrupt');
    if (btnInterrupt) {
        btnInterrupt.title =
            '中断当前这一轮（DSH 的 Agent.cancel：停掉这一轮，会话与上下文都保留，可以接着说）\n' +
                '想连 agent 进程一起停，用右上角的「停止」。';
    }
    syncInterruptButton(state);
    const btnRestart = (_e = state.root) === null || _e === void 0 ? void 0 : _e.querySelector('#btn-restart');
    if (btnRestart) {
        btnRestart.disabled = !ready;
        btnRestart.title = ready ? '重启 agent（重启后会自动接上上次的会话）' : '先启动 agent 才能重启';
    }
    if (state.resumeButton)
        state.resumeButton.disabled = !ready;
    renderHistoryBar(state);
    // 交互块：广播是主路，这里兜一次（面板刚打开时靠它把「已经在等的那一问」画出来）
    renderInteractions(state);
    if (reply.profile && reply.profile.ok === false) {
        // profile 同步失败会直接导致 agent 起不来（或起来的是旧插件），必须显眼。
        setBanner(state, `dsh profile 同步失败：${(_f = reply.profile.error) !== null && _f !== void 0 ? _f : '未知原因'}\n（agent 会用到 $DSH_HOME/profiles/cocos；可点下面按钮重试）`, 'error', [
            { label: '修复 profile', run: () => void repairProfile(state) },
            { label: '重试启动', run: () => void startAgent(state) },
        ]);
    }
    else if (reply.agent.status === 'error' && reply.agent.lastError) {
        setBanner(state, reply.agent.lastError, 'error', [{ label: '重试', run: () => void startAgent(state) }]);
    }
    else if (reply.agent.status !== 'starting' && Date.now() >= state.bannerUntil) {
        setBanner(state, null);
    }
    // 空态跟着状态走
    if (state.entries.size === 0) {
        if (state.emptyEl)
            state.emptyEl.remove();
        state.emptyEl = null;
        renderEmpty(state, reply.agent.status === 'ready' ? 'no-messages' : 'no-agent');
    }
    syncTyping(state);
    syncLiveBlocks(state);
    // 设置里的自动启动：只在「确实没起过」时触发
    if (reply.agent.status === 'stopped' && ((_g = reply.settings) === null || _g === void 0 ? void 0 : _g.autoStart) && !state.startRequested && state.entries.size === 0) {
        void startAgent(state);
    }
}
/** 拉一次增量转写。@returns 是否拿到新条目（决定要不要顺带刷状态）。 */
async function pollOnce(state) {
    try {
        const reply = await call(constants_1.MSG.getEvents, {
            since: state.maxRev,
        });
        // 代数变了 = 主进程换了会话/回放了历史：先整块重画，再收这一批
        if ((reply === null || reply === void 0 ? void 0 : reply.ok) && typeof reply.generation === 'number' && reply.generation !== state.generation) {
            resetUi(state, reply.generation);
        }
        if ((reply === null || reply === void 0 ? void 0 : reply.ok) && typeof reply.revision === 'number')
            state.maxRev = Math.max(state.maxRev, reply.revision);
        if ((reply === null || reply === void 0 ? void 0 : reply.ok) && Array.isArray(reply.entries) && reply.entries.length > 0) {
            applyEntries(state, reply.entries);
            return true;
        }
    }
    catch {
        /* 下一轮再说 */
    }
    return false;
}
/** 合并一批条目：贴底时跟着滚，不然保持用户的位置。 */
function applyEntries(state, entries) {
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
    if (changed)
        applyJump(state);
}
/** 应用广播推来的更新（与轮询走同一套合并逻辑）。 */
function applyBroadcast(state, update) {
    var _a, _b, _c, _d;
    const payload = update;
    if (!payload)
        return;
    if (payload.running !== undefined && state.snapshot)
        state.snapshot.running = payload.running;
    if (payload.status && state.snapshot)
        state.snapshot.status = payload.status;
    // 广播也可能带来「换会话」（清空 + 代数为证），处理口径与轮询一致
    if (typeof payload.generation === 'number' && payload.generation !== state.generation) {
        resetUi(state, payload.generation);
    }
    if (Array.isArray(payload.entries) && payload.entries.length > 0)
        applyEntries(state, payload.entries);
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
            state.title.textContent = payload.title || `DSH · ${constants_1.PROFILE_NAME}`;
            state.title.title = payload.title ? `会话标题：${payload.title}` : `DSH · ${constants_1.PROFILE_NAME}`;
        }
    }
    // 广播只带增量，revision 用它推游标；漏掉的部分靠轮询补齐
    if (typeof payload.revision === 'number' && payload.revision > state.maxRev)
        state.maxRev = payload.revision;
    // 用量也是整份来的（`null` = 明确「现在没有读数」）。走广播的理由：它是**回合结束**才刷的，
    // 而全量状态轮询是「每 5 跳」（空闲 4 秒）—— 靠它的话数字会晚好几秒才变。
    if (payload.usage !== undefined && state.snapshot) {
        state.snapshot.usage = (_a = payload.usage) !== null && _a !== void 0 ? _a : null;
        state.snapshot.usageNote = (_b = payload.usageNote) !== null && _b !== void 0 ? _b : null;
        renderUsageChip(state);
        if (state.usageOpen)
            renderUsage(state);
    }
    // 进度也是整份来的。它比用量更值得走广播：清单是 agent 在**回合中间**写的，
    // 而标记的正是「我现在做到哪一步」—— 靠轮询会明显迟到。
    if (payload.progress !== undefined && state.snapshot) {
        state.snapshot.progress = (_c = payload.progress) !== null && _c !== void 0 ? _c : null;
        state.snapshot.progressNote = (_d = payload.progressNote) !== null && _d !== void 0 ? _d : null;
        renderProgressChip(state);
        if (state.progressOpen)
            renderProgress(state);
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
function syncInterruptButton(state) {
    var _a, _b;
    const running = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running) === true;
    // 这一轮真的收尾之后，「正在中断」这个临时态自己复位（不必等谁去清）
    if (!running)
        state.interrupting = false;
    const button = (_b = state.root) === null || _b === void 0 ? void 0 : _b.querySelector('#btn-interrupt');
    if (!button)
        return;
    const shouldHide = !running;
    if (button.hidden !== shouldHide)
        button.hidden = shouldHide;
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
function closePopup(state) {
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
function renderPopup(state) {
    const host = state.popup;
    if (!host)
        return;
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
            row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                state.popupIndex = index;
                acceptPopup(state);
            });
            row.appendChild(el('span', 'dsh-popup-label', item.label));
            if (item.detail)
                row.appendChild(el('span', 'dsh-popup-detail', item.detail));
            if (item.disabled) {
                row.disabled = true;
                row.dataset.disabled = 'true';
            }
            host.appendChild(row);
        });
    }
    // 高亮每次都重算（幂等、便宜），这样「重建」与「只换高亮」两条路共用同一段代码
    const rows = host.querySelectorAll('.dsh-popup-item');
    rows.forEach((row, index) => {
        if (index === state.popupIndex)
            row.dataset.active = 'true';
        else
            delete row.dataset.active;
    });
}
/**
 * 输入框内容变了之后重算弹出块（`/` 命令 与 `@` 路径）。
 *
 * @param state - 面板状态。
 */
function refreshPopup(state) {
    var _a;
    const value = state.input.value;
    const caret = (_a = state.input.selectionStart) !== null && _a !== void 0 ? _a : value.length;
    // ① 命令：整行以 `/` 开头、还没出现空白（见 `commandDraft` 的口径）
    const draft = (0, mention_1.commandDraft)(value, caret);
    if (draft) {
        openCommandPopup(state, draft.query);
        return;
    }
    // ② `@` 路径：光标处那个活动 token
    const { line, col } = (0, mention_1.lineAt)(value, caret);
    const token = (0, mention_1.activeAtToken)(line, col);
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
function openCommandPopup(state, query) {
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
async function loadCommands(state) {
    var _a;
    // 先占位，避免同一次输入里连打几发（`null` 只表示"还没拉过"）
    state.commands = [];
    try {
        const reply = await call(constants_1.MSG.commandList);
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            setBanner(state, `读不到斜杠命令表：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'info', [], BANNER_HOLD.INFO);
            return;
        }
        state.commands = Array.isArray(reply.commands) ? reply.commands : [];
        // 拉回来时用户可能已经打完了命令名 —— 重算一次
        refreshPopup(state);
    }
    catch (error) {
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
function openMentionPopup(state, token) {
    const cached = state.mentionCache.get(token.query);
    if (cached) {
        showMentionItems(state, token, cached);
        return;
    }
    const seq = ++state.mentionSeq;
    void (async () => {
        try {
            const reply = await call(constants_1.MSG.fileReference, {
                query: token.query,
            });
            if (seq !== state.mentionSeq)
                return;
            if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
                // 这条**不弹横幅**：`@` 是边打字边问的，服务没挂时每敲一个字符弹一次红条会淹掉面板。
                closePopup(state);
                return;
            }
            const candidates = Array.isArray(reply.candidates) ? reply.candidates : [];
            state.mentionCache.set(token.query, candidates);
            // 缓存上限：`@` 是**每敲一个字符**换一个查询串的，一次会话能攒下几百个 key
            // （每个都是一个候选数组）。超了就整个清掉 —— 反正下一次查询会重新问，
            // 而且提供方那边本来就有索引缓存（我们这层只是省一次 IPC）。
            if (state.mentionCache.size > MENTION_CACHE_LIMIT)
                state.mentionCache.clear();
            showMentionItems(state, token, candidates);
        }
        catch {
            if (seq === state.mentionSeq)
                closePopup(state);
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
function showMentionItems(state, token, candidates) {
    const items = candidates
        .slice(0, POPUP_LIMIT)
        .map((candidate) => {
        const insertion = (0, mention_1.formatFileMention)(candidate, token.quoted);
        return {
            label: candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path,
            detail: candidate.kind === 'directory' ? '目录（继续往下钻）' : '文件',
            disabled: insertion === undefined,
            apply: () => {
                var _a;
                if (insertion === undefined)
                    return;
                const caret = (_a = state.input.selectionStart) !== null && _a !== void 0 ? _a : state.input.value.length;
                // ⚠ 用**当前**光标位置重算 token，而不是用发起查询时那个：
                // 异步回来时用户可能又打了几个字符（那时 token 已经变长）。
                // 拿不到活动 token 就不改任何东西（`replaceToken` 也会再兜一层）。
                const { line, col } = (0, mention_1.lineAt)(state.input.value, caret);
                const live = (0, mention_1.activeAtToken)(line, col);
                if (!live)
                    return;
                const next = (0, mention_1.replaceToken)(state.input.value, caret, live, insertion);
                state.input.value = next.value;
                state.input.focus();
                state.input.setSelectionRange(next.caret, next.caret);
                autoGrow(state.input);
                saveDraft(state.input.value);
                // 目录选中后**留在菜单里**（继续往下钻），文件选中即收工
                if (candidate.kind === 'directory')
                    refreshPopup(state);
                else
                    closePopup(state);
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
function movePopup(state, delta) {
    if (state.popupKind === null || state.popupItems.length === 0)
        return;
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
function acceptPopup(state) {
    if (state.popupKind === null)
        return false;
    const item = state.popupItems[state.popupIndex];
    if (!item)
        return false;
    if (item.disabled)
        return true;
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
function handlePopupKey(state, event) {
    if (state.popupKind === null)
        return false;
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
            if (event.isComposing)
                return false;
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
async function runCommandLine(state, line) {
    var _a, _b;
    if (((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.status) !== 'ready') {
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
    if (state.sendButton)
        state.sendButton.disabled = true;
    try {
        const reply = await call(constants_1.MSG.commandRun, { line });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            // 结果那条 note 由主进程写；这里只提示 + 把命令行放回去让用户改
            setBanner(state, (_b = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _b !== void 0 ? _b : '命令没有执行', 'error', [], BANNER_HOLD.ERROR);
            state.input.value = line;
            autoGrow(state.input);
            saveDraft(line);
        }
        else {
            setBanner(state, null);
        }
    }
    catch (error) {
        setBanner(state, `命令没有执行：${String(error)}`, 'error', [], BANNER_HOLD.ERROR);
        state.input.value = line;
        autoGrow(state.input);
        saveDraft(line);
    }
    finally {
        if (state.sendButton)
            state.sendButton.disabled = false;
        void pollOnce(state);
        void refreshState(state);
    }
}
/** 发送。 */
async function send(state) {
    var _a, _b;
    const text = state.input.value.trim();
    // `/开头的整行输入是**命令**，不是给模型的消息（见本节顶部第 3 条口径）。
    // 判据只看首字节 —— 与 `dsh-commands` 的 `parseCommand` 一致。
    if (text.startsWith('/') && state.attachments.length === 0) {
        await runCommandLine(state, text);
        return;
    }
    const attachments = state.attachments;
    // 只有图没有字也允许（模型只看图）；两样都空才是没得发
    if (!text && attachments.length === 0)
        return;
    if (((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.status) !== 'ready') {
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
    if (state.sendButton)
        state.sendButton.disabled = true;
    try {
        const result = await call(constants_1.MSG.sendMessage, {
            text,
            // 只把协议需要的三个字段送出去（thumb/width/height 是面板自己的事）
            images: attachments.map((item) => ({ mimeType: item.mimeType, data: item.data, name: item.name })),
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
            setBanner(state, (_b = result === null || result === void 0 ? void 0 : result.error) !== null && _b !== void 0 ? _b : '发送失败', 'error', [], BANNER_HOLD.ERROR);
            // 失败时**把图和文字都留着**：用户的输入不能因为一次网络/校验错误就没了
            restoreDraft(state, text, attachments);
        }
        else {
            setBanner(state, null);
            rememberSentThumbs(state, attachments);
            state.attachments = [];
            renderAttachments(state);
        }
    }
    catch (error) {
        setBanner(state, `发送失败：${String(error)}`, 'error', [], BANNER_HOLD.ERROR);
        restoreDraft(state, text, attachments);
    }
    finally {
        if (state.sendButton)
            state.sendButton.disabled = false;
        void pollOnce(state);
        // 立刻刷一次状态：`running` 翻真后轮询才会切到 300ms（流式就是靠它顺起来的）
        void refreshState(state);
    }
}
/** 发送失败后把没发出去的东西放回输入区（只在用户还没开始打新内容时）。 */
function restoreDraft(state, text, attachments) {
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
function rememberSentThumbs(state, attachments) {
    for (const item of attachments) {
        state.sentThumbs.set(item.name, item.thumb);
        while (state.sentThumbs.size > 12) {
            const oldest = state.sentThumbs.keys().next();
            if (oldest.done)
                break;
            state.sentThumbs.delete(oldest.value);
        }
    }
}
/** 输入框按内容长高（最多 8 行，再多就滚）。 */
function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}
/** 草稿读写（面板关掉再开不丢）。 */
function saveDraft(text) {
    try {
        if (text)
            localStorage.setItem(DRAFT_KEY, text);
        else
            localStorage.removeItem(DRAFT_KEY);
    }
    catch {
        /* 隐私模式/被禁就没草稿，不影响用 */
    }
}
function loadDraft() {
    var _a;
    try {
        return (_a = localStorage.getItem(DRAFT_KEY)) !== null && _a !== void 0 ? _a : '';
    }
    catch {
        return '';
    }
}
/** 外观按钮：auto → dark → light 循环。 */
async function cycleTheme(state) {
    var _a, _b;
    const current = (_b = (_a = state.settings) === null || _a === void 0 ? void 0 : _a.theme) !== null && _b !== void 0 ? _b : 'auto';
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    const saved = await call(constants_1.MSG.updateSettings, { theme: next });
    if (saved === null || saved === void 0 ? void 0 : saved.settings)
        state.settings = saved.settings;
    applyAppearance(state);
    updateThemeButton(state);
}
/** 外观按钮的图标/提示跟着当前档位走。 */
function updateThemeButton(state) {
    var _a, _b, _c;
    const button = (_a = state.root) === null || _a === void 0 ? void 0 : _a.querySelector('#btn-theme');
    if (!button)
        return;
    const mode = (_c = (_b = state.settings) === null || _b === void 0 ? void 0 : _b.theme) !== null && _c !== void 0 ? _c : 'auto';
    button.textContent = THEME_GLYPH[mode];
    button.title = `外观：${THEME_LABEL[mode]}（点击切换）`;
}
/** 设置面板（就地编辑 + 保存）。 */
function toggleSettings(state) {
    const host = state.settingsHost;
    if (!host) {
        console.warn('[dsh_chat] 面板里找不到设置容器 #settings（选择器没解析出来？）');
        return;
    }
    state.settingsOpen = !state.settingsOpen;
    host.hidden = !state.settingsOpen;
    if (!state.settingsOpen)
        return;
    const settings = state.settings;
    host.textContent = '';
    if (!settings) {
        host.textContent = '还没读到设置，稍后再试。';
        return;
    }
    const draft = { ...settings };
    /** 一个文本/数字输入行。 */
    const addInput = (group, key, label, type) => {
        var _a;
        if (group)
            host.appendChild(el('div', 'dsh-settings-group', group));
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const input = el('input');
        input.type = type;
        input.value = String((_a = settings[key]) !== null && _a !== void 0 ? _a : '');
        input.addEventListener('input', () => {
            draft[key] = type === 'number' ? Number(input.value) : input.value;
        });
        row.appendChild(input);
        host.appendChild(row);
    };
    /** 一个下拉行。 */
    const addSelect = (key, label, options) => {
        var _a;
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const select = el('select');
        for (const [value, text] of options) {
            const option = el('option', undefined, text);
            option.value = value;
            select.appendChild(option);
        }
        select.value = String((_a = settings[key]) !== null && _a !== void 0 ? _a : '');
        select.addEventListener('change', () => {
            draft[key] = select.value;
        });
        row.appendChild(select);
        host.appendChild(row);
    };
    /** 一个勾选行。 */
    const addCheckbox = (key, label) => {
        const row = el('div', 'dsh-field');
        row.appendChild(el('label', undefined, label));
        const input = el('input');
        input.type = 'checkbox';
        input.checked = Boolean(settings[key]);
        input.addEventListener('change', () => {
            draft[key] = input.checked;
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
        const saved = await call(constants_1.MSG.updateSettings, draft);
        if (saved === null || saved === void 0 ? void 0 : saved.settings)
            state.settings = saved.settings;
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
function mount(ctx) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12;
    const $ = (_a = ctx.$) !== null && _a !== void 0 ? _a : {};
    // 面板根节点：拿到它就能在里面按选择器补查（见下面 pick 的说明）。
    const root = (_g = (_e = (_b = $.root) !== null && _b !== void 0 ? _b : (_d = (_c = $.body) === null || _c === void 0 ? void 0 : _c.closest) === null || _d === void 0 ? void 0 : _d.call(_c, '.dsh-root')) !== null && _e !== void 0 ? _e : (_f = $.body) === null || _f === void 0 ? void 0 : _f.parentElement) !== null && _g !== void 0 ? _g : null;
    /**
     * 取元素：先信编辑器给的 `$`，拿不到再**在面板根节点里按同一个选择器查一次**。
     *
     * 为什么要这道兜底：`document.getElementById` 在这个环境里拿不到面板元素（实测），
     * 说明面板 DOM 不一定挂在模块所处的那个 document 上；而 `$` 偶尔漏一个键时，
     * 从根节点 scope 查询仍然能命中。两道都不行就返回 null，由调用方降级（只 warn 不抛）。
     */
    const pick = (key) => {
        const direct = $[key];
        if (direct)
            return direct;
        const selector = SELECTORS[key];
        if (!selector || !root)
            return null;
        try {
            return root.querySelector(selector);
        }
        catch {
            return null;
        }
    };
    const missing = Object.keys(SELECTORS).filter((key) => !pick(key));
    if (missing.length > 0) {
        // 只 warn 不抛：面板少个元素也要能开，否则用户在编辑器里只看到一条红错。
        console.warn(`[dsh_chat] 面板里没找到这些元素：${missing.join(', ')}（对应选择器 ${missing
            .map((k) => SELECTORS[k])
            .join(', ')}）`);
    }
    const state = {
        root,
        dot: pick('dot'),
        title: pick('title'),
        sub: pick('sub'),
        banner: pick('banner'),
        settingsHost: pick('settings'),
        body: pick('body'),
        input: pick('input'),
        sendButton: pick('btnSend'),
        live: pick('live'),
        meta: pick('meta'),
        historyBar: pick('historyBar'),
        historyBarText: pick('historyBarText'),
        history: pick('history'),
        historyList: pick('historyList'),
        historyNote: pick('historyNote'),
        historySearchEl: pick('historySearch'),
        btnHistorySearch: pick('btnHistorySearch'),
        btnHistoryBack: pick('btnHistoryBack'),
        btnHistoryRefreshEl: pick('btnHistoryRefresh'),
        resumeButton: pick('btnResume'),
        usageOpen: false,
        usageHost: pick('usage'),
        usageBody: pick('usageBody'),
        usageNoteEl: pick('usageNote'),
        usageChip: pick('btnUsage'),
        btnUsageRefreshEl: pick('btnUsageRefresh'),
        usageBusy: false,
        // ---- 进度（待办清单 / 目标 / 回合目录）----
        progressOpen: false,
        progressHost: pick('progress'),
        progressBody: pick('progressBody'),
        progressNoteEl: pick('progressNote'),
        progressChip: pick('btnProgress'),
        btnProgressRefreshEl: pick('btnProgressRefresh'),
        // ---- 活动（后台任务 / 子 agent）----
        activityOpen: false,
        activityHost: pick('activity'),
        activityBody: pick('activityBody'),
        activityNoteEl: pick('activityNote'),
        activityChip: pick('btnActivity'),
        btnActivityRefreshEl: pick('btnActivityRefresh'),
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
        imageButton: pick('btnImage'),
        imageBusy: 0,
        picker: pick('picker'),
        pickerList: pick('pickerList'),
        pickerNote: pick('pickerNote'),
        pickerSearch: pick('pickerSearch'),
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
    (_h = state.sendButton) === null || _h === void 0 ? void 0 : _h.addEventListener('click', () => void send(state));
    state.input.addEventListener('input', () => {
        autoGrow(state.input);
        saveDraft(state.input.value);
        // 输入触发器（`/` 命令 与 `@` 路径）：每敲一个字符重算一次。
        // 这里是**唯一**触发点 —— 光标移动 / 点击不该重开菜单（那会把方向键抢走）。
        refreshPopup(state);
    });
    state.input.addEventListener('keydown', (event) => {
        // 弹出块优先吃键（↑↓ 选 / Enter·Tab 认 / Esc 关）——
        // 否则 Enter 会被下面的「发送」抢走，候选永远选不上。
        if (handlePopupKey(state, event))
            return;
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
    const onPaste = (event) => {
        const images = imagesFromClipboard(event.clipboardData);
        if (images.length === 0)
            return;
        event.preventDefault();
        event.stopPropagation();
        reportProbe({ kind: 'paste', images: images.length, types: images.map((item) => item.blob.type) });
        void attachBlobs(state, images, 'clipboard');
    };
    (root !== null && root !== void 0 ? root : state.body).addEventListener('paste', onPaste);
    state.input.addEventListener('paste', onPaste);
    // 拖进来也算「加图」：三个来源（粘贴/选择器/拖拽）都落到 attachBlobs 这一条路上
    (root !== null && root !== void 0 ? root : state.body).addEventListener('dragover', (event) => {
        var _a, _b;
        if ((_b = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types) === null || _b === void 0 ? void 0 : _b.includes('Files')) {
            event.preventDefault();
            if (root)
                root.dataset.drag = 'true';
        }
    });
    (root !== null && root !== void 0 ? root : state.body).addEventListener('dragleave', () => {
        if (root)
            delete root.dataset.drag;
    });
    (root !== null && root !== void 0 ? root : state.body).addEventListener('drop', (event) => {
        var _a;
        if (root)
            delete root.dataset.drag;
        const files = ((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.files) ? Array.from(event.dataTransfer.files) : [];
        const images = files
            .filter((file) => file.type.toLowerCase().startsWith('image/'))
            .map((file, index) => ({ blob: file, name: file.name || `拖进来的图片-${index + 1}` }));
        if (images.length === 0)
            return;
        event.preventDefault();
        void attachBlobs(state, images, 'drop');
    });
    // 图片按钮与选择器
    (_j = state.imageButton) === null || _j === void 0 ? void 0 : _j.addEventListener('click', () => togglePicker(state));
    (_k = pick('btnPickerClose')) === null || _k === void 0 ? void 0 : _k.addEventListener('click', () => togglePicker(state, false));
    (_l = pick('btnPickerRefresh')) === null || _l === void 0 ? void 0 : _l.addEventListener('click', () => {
        state.pickerThumbs.clear();
        state.pickerFailed.clear();
        void ensurePickerList(state, true);
    });
    (_m = pick('btnPickerPaste')) === null || _m === void 0 ? void 0 : _m.addEventListener('click', () => void pasteFromClipboardApi(state));
    (_o = state.pickerSearch) === null || _o === void 0 ? void 0 : _o.addEventListener('input', () => {
        var _a, _b;
        state.pickerQuery = (_b = (_a = state.pickerSearch) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : '';
        renderPickerList(state);
    });
    (_p = state.pickerSearch) === null || _p === void 0 ? void 0 : _p.addEventListener('keydown', (event) => {
        if (event.key === 'Escape')
            togglePicker(state, false);
    });
    (_q = pick('btnNew')) === null || _q === void 0 ? void 0 : _q.addEventListener('click', async () => {
        // 主进程会清转写并把代数 +1；面板不自己清 DOM（清空只有一个真源，见 resetUi）
        await call(constants_1.MSG.newSession);
        await refreshState(state);
        await pollOnce(state);
    });
    (_r = pick('btnStop')) === null || _r === void 0 ? void 0 : _r.addEventListener('click', async () => {
        var _a, _b;
        const settled = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.status) === 'stopped' || ((_b = state.snapshot) === null || _b === void 0 ? void 0 : _b.status) === 'error';
        if (settled) {
            // 没跑的时候这个按钮是「启动」—— 之前根本没有这个入口（见 refreshState 里的说明）
            await startAgent(state);
            return;
        }
        setBanner(state, '正在停止 agent…', 'info');
        await call(constants_1.MSG.stopAgent);
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
    (_s = pick('btnInterrupt')) === null || _s === void 0 ? void 0 : _s.addEventListener('click', async () => {
        var _a;
        state.interrupting = true;
        syncInterruptButton(state);
        if (state.live) {
            state.live.textContent = '正在中断这一轮…';
            state.live.dataset.tone = 'busy';
        }
        try {
            const reply = await call(constants_1.MSG.interrupt);
            if (!(reply === null || reply === void 0 ? void 0 : reply.ok))
                setBanner(state, `中断失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`, 'error');
        }
        catch (error) {
            setBanner(state, `中断失败：${String(error)}`, 'error');
        }
        await refreshState(state);
        await pollOnce(state);
    });
    (_t = pick('btnRestart')) === null || _t === void 0 ? void 0 : _t.addEventListener('click', async () => {
        setBanner(state, '正在重启 agent…（重启后会自动接上上次的会话）', 'info');
        try {
            await call(constants_1.MSG.stopAgent);
        }
        catch (error) {
            console.warn(`[dsh_chat] 重启时 stop 失败（继续 start）：${String(error)}`);
        }
        await startAgent(state);
    });
    (_u = pick('btnHistory')) === null || _u === void 0 ? void 0 : _u.addEventListener('click', () => void openHistory(state));
    (_v = state.btnHistoryRefreshEl) === null || _v === void 0 ? void 0 : _v.addEventListener('click', () => void refreshHistory(state));
    (_w = pick('btnHistoryClose')) === null || _w === void 0 ? void 0 : _w.addEventListener('click', () => closeHistory(state));
    (_x = state.resumeButton) === null || _x === void 0 ? void 0 : _x.addEventListener('click', () => void resumeHistory(state));
    // 用量：状态行那颗 chip 开关抽屉；抽屉里刷新 / 关闭
    (_y = state.usageChip) === null || _y === void 0 ? void 0 : _y.addEventListener('click', () => toggleUsage(state));
    (_z = pick('btnUsageClose')) === null || _z === void 0 ? void 0 : _z.addEventListener('click', () => toggleUsage(state, false));
    (_0 = state.btnUsageRefreshEl) === null || _0 === void 0 ? void 0 : _0.addEventListener('click', () => {
        if (state.btnUsageRefreshEl)
            state.btnUsageRefreshEl.disabled = true;
        if (state.btnProgressRefreshEl)
            state.btnProgressRefreshEl.disabled = true;
        void readUsage(state);
    });
    // 进度：同一套摆法（那颗 chip 也一样，没清单时整颗藏起来）
    (_1 = state.progressChip) === null || _1 === void 0 ? void 0 : _1.addEventListener('click', () => toggleProgress(state));
    (_2 = pick('btnProgressClose')) === null || _2 === void 0 ? void 0 : _2.addEventListener('click', () => toggleProgress(state, false));
    // ---- 活动（后台任务 / 子 agent）：与另外两个抽屉同一套交互
    (_3 = state.activityChip) === null || _3 === void 0 ? void 0 : _3.addEventListener('click', () => toggleActivity(state));
    (_4 = pick('btnActivityClose')) === null || _4 === void 0 ? void 0 : _4.addEventListener('click', () => toggleActivity(state, false));
    (_5 = pick('btnActivityRefresh')) === null || _5 === void 0 ? void 0 : _5.addEventListener('click', () => {
        // 用户主动点的：**必须看到刚读的**（轮询的节流不参与这条路）
        state.activityAt = 0;
        void readActivity(state);
    });
    (_6 = state.btnProgressRefreshEl) === null || _6 === void 0 ? void 0 : _6.addEventListener('click', () => {
        // 两颗「刷新」一起禁用：它们打的是同一次读盘（见 `readUsage`）
        if (state.btnProgressRefreshEl)
            state.btnProgressRefreshEl.disabled = true;
        if (state.btnUsageRefreshEl)
            state.btnUsageRefreshEl.disabled = true;
        void readUsage(state);
    });
    /**
     * 抽屉里的搜索框：**边打字边筛标题**（本地、零成本），Enter 才去读磁盘搜全文。
     *
     * 两条路分开的理由写在 `runHistorySearch` 上：一个是在手边这几条里挑，
     * 一个是有预算的磁盘扫描。清空输入框 = 回到列表（不用再点一下「返回列表」）。
     */
    (_7 = state.historySearchEl) === null || _7 === void 0 ? void 0 : _7.addEventListener('input', () => {
        var _a, _b;
        state.historyQuery = (_b = (_a = state.historySearchEl) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : '';
        if (!state.historyQuery.trim() && state.historySearch) {
            state.historySearch = null;
            syncHistoryControls(state);
            void loadHistoryList(state);
            return;
        }
        if (!state.historySearch)
            void loadHistoryList(state);
    });
    (_8 = state.historySearchEl) === null || _8 === void 0 ? void 0 : _8.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void runHistorySearch(state, state.historyQuery);
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            if (state.historySearchEl)
                state.historySearchEl.value = '';
            state.historyQuery = '';
            state.historySearch = null;
            syncHistoryControls(state);
            void loadHistoryList(state);
        }
    });
    (_9 = state.btnHistorySearch) === null || _9 === void 0 ? void 0 : _9.addEventListener('click', () => void runHistorySearch(state, state.historyQuery));
    (_10 = state.btnHistoryBack) === null || _10 === void 0 ? void 0 : _10.addEventListener('click', () => {
        state.historySearch = null;
        syncHistoryControls(state);
        void loadHistoryList(state);
    });
    (_11 = pick('btnSettings')) === null || _11 === void 0 ? void 0 : _11.addEventListener('click', () => toggleSettings(state));
    (_12 = pick('btnTheme')) === null || _12 === void 0 ? void 0 : _12.addEventListener('click', () => void cycleTheme(state));
    // ⚠ **轮询在这里起，不等 `listeners.show`**（见 POLL_INTERVAL_MS 上方的说明）
    resume(state, 'mount');
    return state;
}
/** 面板显示/挂载：起轮询 + 接广播（**幂等**，`mount` 与 `listeners.show` 都会调）。 */
function resume(state, source) {
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
function attachBroadcast(state) {
    if (state.broadcastHandler)
        return true;
    try {
        const bus = Editor.Message.__protected__;
        if (!(bus === null || bus === void 0 ? void 0 : bus.addBroadcastListener))
            return false;
        const handler = (update) => applyBroadcast(state, update);
        bus.addBroadcastListener(constants_1.BROADCAST_CHANNEL, handler);
        state.broadcastHandler = handler;
        return true;
    }
    catch {
        return false;
    }
}
/** 排下一跳轮询。跑动时密一点（流式主要靠这一路显示出来）。 */
function schedulePoll(state) {
    var _a;
    if (!state.polling)
        return;
    if (state.timer)
        clearTimeout(state.timer);
    const delay = ((_a = state.snapshot) === null || _a === void 0 ? void 0 : _a.running) ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_MS;
    state.timer = setTimeout(() => void tick(state), delay);
}
/** 一跳：拉转写 →（有新条目或到了周期）刷状态 → 排下一跳。 */
async function tick(state) {
    if (!state.polling)
        return;
    state.tick += 1;
    const changed = await pollOnce(state);
    if (changed || state.tick % STATE_EVERY_TICKS === 0)
        await refreshState(state);
    /**
     * 活动（后台任务 / 子 agent）：**唯一一块要面板自己按节流去问的东西**。
     *
     * 别的读数都有推送 —— 用量/进度由主进程在回合结束与命令之后自己读并广播；而这两块
     * 只活在运行时内存里、没有可订阅的变化事件，所以只能在「有东西可看」时按节流问
     * （判据在 `shouldPollActivity`，空闲时一次都不问）。
     */
    if (shouldPollActivity(state))
        void readActivity(state, { quiet: true });
    schedulePoll(state);
}
/**
 * 面板此刻是否真的看得见（量 DOM，不信编辑器的钩子）。
 *
 * 用途只有一个：`hide` 钩子的兜底 —— 钩子说「藏起来了」但面板明明占着位置时，
 * 宁可继续轮询（多一次 IPC 而已），也不能把刷新停掉（停了就是「内容不更新」这个 bug）。
 * 判据故意宽松：量不出来时**当作可见**（误判方向必须偏向「继续轮询」）。
 */
function panelVisible(state) {
    const root = state.root;
    if (!root)
        return true;
    try {
        return root.getClientRects().length > 0 && root.offsetHeight > 0;
    }
    catch {
        return true;
    }
}
/** 面板隐藏：停轮询（广播也摘掉，避免看不见时还在重绘）。 */
function pause(state, source = 'hide') {
    var _a;
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
            const bus = Editor.Message.__protected__;
            (_a = bus === null || bus === void 0 ? void 0 : bus.removeBroadcastListener) === null || _a === void 0 ? void 0 : _a.call(bus, constants_1.BROADCAST_CHANNEL, state.broadcastHandler);
        }
        catch {
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
        show() {
            const state = resolveState(this);
            if (state)
                resume(state, 'show');
        },
        hide() {
            const state = resolveState(this);
            if (state)
                pause(state, 'hide');
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
    ready() {
        var _a;
        let state;
        try {
            state = mount(this);
        }
        catch (error) {
            const stack = error instanceof Error ? ((_a = error.stack) !== null && _a !== void 0 ? _a : error.message) : String(error);
            console.error(`[dsh_chat] 面板挂载失败：${stack}`);
            reportProbe({ kind: 'mount-error', stack: stack.slice(0, 800) });
            return;
        }
        uiByPanel.set(this, state);
        liveStates.add(state);
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOENHOztBQUVILDJCQUFrQztBQUNsQywrQkFBNEI7QUFFNUIsK0NBZ0N5QjtBQUN6Qix5Q0FRc0I7QUFDdEIseUNBQTRDO0FBQzVDLHVDQUFpRztBQUNqRyx5Q0FBb0c7QUFDcEcsaUNBQW9DO0FBQ3BDLDJDQUEwRDtBQUUxRCxhQUFhO0FBQ2IsTUFBTSxXQUFXLEdBQUcsSUFBQSxXQUFJLEVBQUMsU0FBUyxFQUFFLGlCQUFpQixDQUFDLENBQUM7QUFFdkQsbUJBQW1CO0FBQ25CLFNBQVMsVUFBVSxDQUFDLFlBQW9CO0lBQ3BDLE9BQU8sSUFBQSxpQkFBWSxFQUFDLElBQUEsV0FBSSxFQUFDLFdBQVcsRUFBRSxZQUFZLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNsRSxDQUFDO0FBRUQ7Ozs7Ozs7OztHQVNHO0FBQ0gsU0FBUyxTQUFTO0lBQ2QsT0FBTyxHQUFHLFVBQVUsQ0FBQyw4QkFBOEIsQ0FBQyxLQUFLLFVBQVUsQ0FBQyx5QkFBeUIsQ0FBQyxLQUFLLFVBQVUsQ0FDekcsZ0NBQWdDLENBQ25DLEVBQUUsQ0FBQztBQUNSLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLGdCQUFnQixHQUFHLEdBQUcsQ0FBQztBQUU3QixvQkFBb0I7QUFDcEIsTUFBTSx1QkFBdUIsR0FBRyxHQUFHLENBQUM7QUFFcEMsdUNBQXVDO0FBQ3ZDLE1BQU0saUJBQWlCLEdBQUcsQ0FBQyxDQUFDO0FBRTVCLGtDQUFrQztBQUNsQyxNQUFNLFNBQVMsR0FBRyxHQUFHLDBCQUFjLFFBQVEsQ0FBQztBQUU1Qzs7Ozs7Ozs7O0dBU0c7QUFDSCxNQUFNLFlBQVksR0FBRztJQUNqQixTQUFTLEVBQUUs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Q0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSztnQkFBRSxLQUFLLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3BDLENBQUM7S0FDSjtJQUVELFFBQVEsRUFBRSxVQUFVLENBQUMsNkJBQTZCLENBQUM7SUFDbkQsS0FBSyxFQUFFLFNBQVMsRUFBRTtJQUVsQixrQ0FBa0M7SUFDbEMsdURBQXVEO0lBQ3ZELHNEQUFzRDtJQUN0RCxDQUFDLEVBQUUsU0FBUztJQUVaLE9BQU8sRUFBRSxFQUFFO0lBRVg7Ozs7OztPQU1HO0lBQ0gsS0FBSzs7UUFDRCxJQUFJLEtBQWMsQ0FBQztRQUNuQixJQUFJLENBQUM7WUFDRCxLQUFLLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hCLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2IsTUFBTSxLQUFLLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFBLEtBQUssQ0FBQyxLQUFLLG1DQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3RGLE9BQU8sQ0FBQyxLQUFLLENBQUMscUJBQXFCLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDNUMsV0FBVyxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ2pFLE9BQU87UUFDWCxDQUFDO1FBQ0QsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDM0IsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMxQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEU0gg5a+56K+d6Z2i5p2/77yI5riy5p+T6L+b56iL77yJ44CCXG4gKlxuICogIyMg5a6D5piv5LuA5LmIXG4gKlxuICog5YGc6Z2g5ZyoIEluc3BlY3RvciDml4HovrnnmoTkuIDkuKrogYrlpKnmoYbvvJror7TnmoTmr4/lj6Xor53kuqTnu5nkuLvov5vnqIvmiZjnrqHnmoTpgqPlj6ogRFNIIGFnZW5077yMXG4gKiBhZ2VudCDlj4jog73pgJrov4cgYGNvY29zX2V4ZWN1dGVfY29kZWAg55u05o6l5pON5L2cKirkvaDmraPlvIDnnYDnmoTov5nkuKrnvJbovpHlmagqKuOAglxuICpcbiAqICMjIOinguaEn+WPo+W+hO+8muaKhCBEU0jvvIzkuI3ltYwgRFNIXG4gKlxuICog5pu+6K+E5Lyw6L+H44CM5oqKIGBkc2ggd2ViYCDnlKggaWZyYW1lIOW1jOi/m+mdouadv+OAjeKAlOKAlCDlkKblhrPjgILnkIbnlLHmmK/noaznmoTvvJrpgqPlpZfliY3nq6/mmK9cbiAqIHdlYnNlcnZlciArIFdTICsg5a6i5oi356uv5qih5Z2X5Yqo5oCB5Yqg6L2955qE5LiA5pW05aWXIGhvc3TvvIh3ZWIgcHJvZmlsZSDmnIkgNTcg5Liq5o+S5Lu277yJ77yMXG4gKiDltYzov5vmnaXlsLHnrYnkuo7lho3otbfkuIDku70gYWdlbnTvvIjkvJror53jgIHorr7nva7jgIHlt6XlhbflhajliIblrrbvvInvvIzogIzkuJTlroPnmoQgQ1NTIOmHjFxuICogKirkuIDmnaHlk43lupTlvI/lqpLkvZPmn6Xor6Lpg73msqHmnIkqKu+8iOWPquaciSBwcmVmZXJzLXJlZHVjZWQtbW90aW9u77yJ77yM5LiJ5qCP5bqU55So5aGe6L+bXG4gKiDpnaLmnb/lrr3luqblv4XnhLbmjKTjgILmiYDku6XotbDjgIzpnaLmnb/oh6rnu5ggKyDmioTlroPnmoTorr7orqHns7vnu5/jgI3vvJpcbiAqXG4gKiAxLiAqKuiuvuiuoSB0b2tlbiDnm7TmjqXmir0qKu+8mmBzdGF0aWMvc3R5bGUvZGVmYXVsdC9kc3ctdG9rZW5zLmNzc2Ag55SxXG4gKiAgICBgc2NyaXB0cy9leHRyYWN0LWRzdy10b2tlbnMuanNgIOS7jiBgQGRlZXBzZWVrLWFpL2RzaC1jbGllbnQtdWktdGhlbWVgIOmHjOaKoOWHuuadpVxuICogICAg77yI6Imy5p2/IOKGkiDor63kuYnliKvlkI3jgIHmmI7mmpfkuKTlpZfjgIHlrZflj7fpmLbmoq/jgIFlbGV2YXRpb27jgIHmu5rliqjmnaHvvInvvIzkuIDmnaHkuI3miYvmioTvvJtcbiAqIDIuICoq5riy5p+T5qih5Z6L54Wn5oqEKirvvJrnlKjmiLfmsJTms6EgLyDliqnmiYsgbWFya2Rvd24gLyDmipjlj6DnmoTmgJ3ogIPlnZcgLyDmjInlt6XlhbflkI3liIbnsbvnmoTlt6XlhbfljaHniYdcbiAqICAgIO+8iOingSBgdG9vbC1jYXJkLnRzYO+8iS8g5Zub5oCB5LiO6ICX5pe2IC8g5Luj56CB5Z2X5bimIGJhbm5lciDkuI7lpI3liLYg4oCU4oCUIOi/meS6m+ato+aYryBEU0ggd2ViIOWuouaIt+err1xuICogICAg55qE5a+56K+d5Yy65Zyo5YGa55qE5LqL77yM6ICM5oiR5Lus5ZCD55qE5pivKirlkIzkuIDmnaHkuovku7bmtYEqKu+8iGBTZXNzaW9uRXZlbnRMaWtlRW50cnlg77yJ44CCXG4gKlxuICogIyMg5LqU5p2h5a6e546w5Y+j5b6EXG4gKlxuICogMS4gKirpm7bkvp3otZYqKu+8muS4jeW8lSBWdWUvUmVhY3TvvIzlj6rnlKggRE9N44CC5aSa5Ye65p2l55qE5Lik5Liq5YWE5byf5paH5Lu277yIYG1hcmtkb3duLnRzYCAvXG4gKiAgICBgdG9vbC1jYXJkLnRzYO+8ieeUqOebuOWvuSByZXF1aXJlIOW8le+8iOmdouadvyBkaXN0IOaYryBDb21tb25KU++8jOiDveino+aekOWQjOe6p+aWh+S7tu+8ieOAglxuICogMi4gKirlhYPntKDkuIDlvovotbAgYEVkaXRvci5QYW5lbC5kZWZpbmVgIOeahCBgJGAg6YCJ5oup5ZmoKirvvIhgY3R4LiQueHh4YO+8ieOAglxuICogICAg4pqgICoq6Lip6L+H55qE5Z2RKirvvJpgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jhbm5lcicpYCDlnKjov5nkuKrnjq/looPph4wqKui/lOWbniBudWxsKirvvIjmqKHmnb/kuI3lnKhcbiAqICAgIOaZrumAmuaWh+aho+agkemHjO+8jGBnZXRFbGVtZW50QnlJZGAg5om+5LiN5Yiw77yJ77yM6ICMIGAkYCDmmK/nvJbovpHlmajlnKjpnaLmnb/lrZDmoJHph4zop6PmnpDnmoTjgIHlj6/pnaDjgIJcbiAqICAgIOesrOS4gOeJiOeUqCBgZ2V0RWxlbWVudEJ5SWRgIOaLv+eKtuaAgeeCuS/mqKrluYUg4oaSIOS4gOi/m+mdouadvyBgcmVmcmVzaFN0YXRlYCDlsLHmiptcbiAqICAgIGBDYW5ub3Qgc2V0IHByb3BlcnRpZXMgb2YgbnVsbCAoc2V0dGluZyAndGV4dENvbnRlbnQnKWDvvIzmlbTlnZcgVUkg5YW25a6e5piv5q2755qE44CCXG4gKiAgICAqKue7k+iuuu+8mumdouadv+mHjOS4jeimgeeUqCBgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQvcXVlcnlTZWxlY3RvcmAg5om+6Z2i5p2/5YWD57Sg44CCKipcbiAqICAgIO+8iOWFg+e0oCoq5YaF6YOoKirmn6Xor6Llj6/ku6XvvJpgZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcuZHNoLXRoaW5rJylgIOaYr+aLv+WcqOiHquW3seaJi+mHjOeahOWtkOagkeOAgu+8iVxuICogMy4gKirkuKTmnaHmm7TmlrDot68qKu+8muS4u+i/m+eoi+W5v+aSre+8iGBkc2hfY2hhdDpldmVudGDvvIzlv6vvvIkgKiorKiog6L2u6K+iIGBnZXQtZXZlbnRzYO+8iOeos++8ieOAglxuICogICAg5Lik5p2h6Lev6YO95bm26L+b5ZCM5LiA5Lu9IGBNYXA8c2VxLCBFbnRyeT5g77yM6Z2gIGBzZXFgIC8gYHJldmAg5bmC562J44CCXG4gKiA0LiAqKuWPqumHjee7mOWPmOWMlueahOadoeebrioq77yaYHNlcSDihpIg5YWD57SgYCDkuIDkuIDlr7nlupTvvIzmtYHlvI/lop7ph4/ljp/lnLDmm7/mjaLor6XmnaHnm67nmoTlhoXlrrnvvIxcbiAqICAgIOS4jeaVtOWxj+mHjeaOku+8iOWQpuWImei+k+WFpeeEpueCueWSjOa7muWKqOS9jee9rumDveS8mui3s++8ieOAguWxleW8gC/mlLbotbfov5nnsbsqKuS6pOS6kueKtuaAgSoq5Y+m5a2Y5ZyoXG4gKiAgICBgTWFwPHNlcSwgYm9vbGVhbj5gIOmHjO+8jOi3qOmHjee7mOS/neeVmeOAglxuICogNS4gKirlj5bkuI3liLDlhYPntKDkuZ/lj6ogd2FybiDkuI3mipvvvIzlubbmioroh6rmo4DmiqXnu5nkuLvov5vnqIsqKu+8iGBwYW5lbC1wcm9iZWDvvInvvJrpnaLmnb/mipvplJnkvJrmsaHmn5NcbiAqICAgIOe8lui+keWZqOaOp+WItuWPsO+8jOiAjOeUqOaIt+aLv+S4jeWIsOS7u+S9leWPr+eUqOS/oeaBr++8m+iHquajgOWbnuS8oOiuqeOAjOmdouadv+mHjOWIsOW6leaAjuS5iOS6huOAjeiDveiiq+WklumDqOivu+WIsOOAglxuICpcbiAqICMjIOi3r+W+hOWPo+W+hFxuICpcbiAqIOe8luivkeS6p+eJqeWcqCBgZGlzdC9wYW5lbHMvZGVmYXVsdC9pbmRleC5qc2DvvIzmiYDku6XpnZnmgIHotYTmupDku44gYF9fZGlybmFtZWAg5b6A5LiK5LiJ57qn5Zue5omp5bGV5qC577yMXG4gKiDlho3ov5sgYHN0YXRpYy9g44CC5pS555uu5b2V57uT5p6E5pe26L+Z5Yeg5LiqIGpvaW4g6KaB5LiA6LW35pS544CCXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQge1xuICAgIEJST0FEQ0FTVF9DSEFOTkVMLFxuICAgIEVYVEVOU0lPTl9OQU1FLFxuICAgIE1TRyxcbiAgICBQUk9GSUxFX05BTUUsXG4gICAgdHlwZSBBY3Rpdml0eVZpZXcsXG4gICAgdHlwZSBBZ2VudFNuYXBzaG90LFxuICAgIHR5cGUgQWdlbnRTdGF0dXMsXG4gICAgdHlwZSBDb21tYW5kVmlldyxcbiAgICB0eXBlIENvbnRleHRUaW1lbGluZVZpZXcsXG4gICAgdHlwZSBEc2hDaGF0U2V0dGluZ3MsXG4gICAgdHlwZSBFbnRyeSxcbiAgICB0eXBlIEVudHJ5SW1hZ2UsXG4gICAgdHlwZSBIaXN0b3J5U2VhcmNoSGl0VmlldyxcbiAgICB0eXBlIEhpc3RvcnlTZXNzaW9uVmlldyxcbiAgICB0eXBlIEhvc3RVcGRhdGVWaWV3LFxuICAgIHR5cGUgSW1hZ2VNaW1lVHlwZSxcbiAgICB0eXBlIEludGVyYWN0aW9uQW5zd2VySXRlbSxcbiAgICB0eXBlIEludGVyYWN0aW9uRGVjaXNpb24sXG4gICAgdHlwZSBJbnRlcmFjdGlvblZpZXcsXG4gICAgdHlwZSBKb2JWaWV3LFxuICAgIHR5cGUgUGFuZWxUaGVtZSxcbiAgICB0eXBlIFJlZmVyZW5jZUNhbmRpZGF0ZSxcbiAgICB0eXBlIFNlc3Npb25Vc2FnZSxcbiAgICB0eXBlIFByb2dyZXNzVmlldyxcbiAgICB0eXBlIFN1YmFnZW50VmlldyxcbiAgICB0eXBlIFRpbWVsaW5lUG9pbnRWaWV3LFxuICAgIHR5cGUgVG9kb1ZpZXcsXG4gICAgdHlwZSBUdXJuVmlldyxcbiAgICBmb3JtYXREdXJhdGlvbixcbiAgICBmb3JtYXRUb2tlbnMsXG4gICAgdGltZWxpbmVUZXh0T2YsXG59IGZyb20gJy4uLy4uL2NvbnN0YW50cyc7XG5pbXBvcnQge1xuICAgIElNQUdFX01JTUVfQllfRVhULFxuICAgIE1BWF9JTUFHRV9CWVRFUyxcbiAgICBNQVhfSU1BR0VTX1BFUl9NRVNTQUdFLFxuICAgIE1BWF9MSVNURURfSU1BR0VTLFxuICAgIGZpbHRlclByb2plY3RJbWFnZXMsXG4gICAgZm9ybWF0Qnl0ZXMsXG4gICAgdHlwZSBQcm9qZWN0SW1hZ2UsXG59IGZyb20gJy4uLy4uL2ltYWdlcyc7XG5pbXBvcnQgeyByZW5kZXJNYXJrZG93biB9IGZyb20gJy4vbWFya2Rvd24nO1xuaW1wb3J0IHsgYWN0aXZlQXRUb2tlbiwgY29tbWFuZERyYWZ0LCBmb3JtYXRGaWxlTWVudGlvbiwgbGluZUF0LCByZXBsYWNlVG9rZW4gfSBmcm9tICcuL21lbnRpb24nO1xuaW1wb3J0IHsgR09BTF9QSEFTRV9URVhULCBUT0RPX01BUkssIHByb2dyZXNzQ2hpcFRleHQsIHRvZG9Db3VudHMsIHR1cm5IZWFkSGludCB9IGZyb20gJy4vcHJvZ3Jlc3MnO1xuaW1wb3J0IHsgY29zdFRleHRPZiB9IGZyb20gJy4vY29zdCc7XG5pbXBvcnQgeyBjcmVhdGVUb29sQ2FyZCwgZGVmYXVsdE9wZW4gfSBmcm9tICcuL3Rvb2wtY2FyZCc7XG5cbi8qKiDpnZnmgIHotYTmupDmoLnjgIIgKi9cbmNvbnN0IFNUQVRJQ19ST09UID0gam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMnKTtcblxuLyoqIOS7juaJqeWxleagueivu+S4gOS7vemdmeaAgeaWh+S7tuOAgiAqL1xuZnVuY3Rpb24gcmVhZFN0YXRpYyhyZWxhdGl2ZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyhqb2luKFNUQVRJQ19ST09ULCByZWxhdGl2ZVBhdGgpLCAndXRmLTgnKTtcbn1cblxuLyoqXG4gKiDpnaLmnb/moLflvI8gPSAqKnRva2VuIOWxgiArIOe7hOS7tuWxgiArIOmFjeiJsuimhuebluWxgioq44CCXG4gKlxuICogdG9rZW4g5bGC5piv6ISa5pys5LuO5bey5a6J6KOF55qEIERTSCDph4zmir3lh7rmnaXnmoTvvIjop4EgYHNjcmlwdHMvZXh0cmFjdC1kc3ctdG9rZW5zLmpzYO+8ie+8jFxuICog57uE5Lu25bGC5piv5omL5YaZ55qE44CB5Y+q5raI6LS5IHRva2Vu44CC5YiG5byA55qE55CG55Sx77yaRFNIIOWNh+eJiOacrOaXtumHjei3keiEmuacrOWNs+WPr++8jFxuICog5omL5YaZ55qE57uE5Lu25qC35byP5LiN5Lya6KKr6KaG55uW44CCXG4gKlxuICog56ys5LiJ5Lu9IGBlZGl0b3ItdGhlbWUuY3NzYCDmmK8qKuWPqumHjeWumuS5ieWPmOmHjyoq55qE6YWN6Imy6KaG55uW77yIYHBhbGV0dGUgPSBlZGl0b3JgIOaXtueUn+aViO+8ieKAlOKAlFxuICog5a6D5LiN6IO95YaZ6L+bIHRva2VuIOWxgu+8iOmCo+S7veaYr+eUn+aIkOeJqe+8jOS8muiiq+aVtOS7veimhueblu+8ie+8jOS5n+S4jeivpea3t+i/m+e7hOS7tuWxgu+8iOmCo+WxgumbtuehrOe8lueggeiJsu+8ieOAglxuICovXG5mdW5jdGlvbiByZWFkU3R5bGUoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7cmVhZFN0YXRpYygnc3R5bGUvZGVmYXVsdC9kc3ctdG9rZW5zLmNzcycpfVxcbiR7cmVhZFN0YXRpYygnc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKX1cXG4ke3JlYWRTdGF0aWMoXG4gICAgICAgICdzdHlsZS9kZWZhdWx0L2VkaXRvci10aGVtZS5jc3MnLFxuICAgICl9YDtcbn1cblxuLyoqXG4gKiDimqAgKirkuKTmnaHot6/nmoTlnLDkvY0qKu+8iOi4qei/h+eahOWdke+8jOingeaWh+S7tuWktOesrCAzIOadoe+8ie+8mui9ruivouaYryoq5Li76LevKirvvIzlub/mkq3mmK/liqDpgJ/jgIJcbiAqIOmdouadvyoq5b+F6aG76Ieq5bex5ZyoIGBtb3VudGAg6YeM5oqK6L2u6K+i6LW36LW35p2lKiog4oCU4oCUIOabvue7j+WPquaMguWcqCBgbGlzdGVuZXJzLnNob3dgIOS4iu+8jFxuICog57uT5p6c6YKj5Liq6ZKp5a2Q5rKh5ZyoIGByZWFkeWAg5LmL5ZCO6Kem5Y+R77yM6L2u6K+i5qC55pys5rKh6LeR77yM55eH54q25piv44CM5LiK5LiA6L2u55qE5Zue5aSN6KaB562J5LiL5LiA5qyh5Y+R6YCBXG4gKiDmiY3mlbTmrrXlhpLlh7rmnaXjgI3vvIhgc2VuZCgpYCDph4zpgqPmrKEgYHBvbGxPbmNlYCDmiJDkuobllK/kuIDnmoTliLfmlrDngrnvvInjgIJcbiAqIOepuumXsiA4MDBtc+OAgei3keWKqCAzMDBtc++8mui3keWKqOaXtuWvhuS4gOeCuea1geW8j+aJjemhuu+8iOaooeWei+Wunua1iyB+MjAwIOWtly8yNTBtc++8ieOAglxuICovXG5jb25zdCBQT0xMX0lOVEVSVkFMX01TID0gODAwO1xuXG4vKiog6LeR5Yqo5pe255qE6L2u6K+i6Ze06ZqU77yI5q+r56eS77yJ44CCICovXG5jb25zdCBQT0xMX0lOVEVSVkFMX0FDVElWRV9NUyA9IDMwMDtcblxuLyoqIOavj+WHoOasoei9ruivoumhuuW4puWIt+S4gOasoeeKtuaAge+8iOavlOaLiei9rOWGmei0teS4gOeCue+8ie+8m+acieaWsOadoeebruaXtuW9k+i9ruWwseWIt+OAgiAqL1xuY29uc3QgU1RBVEVfRVZFUllfVElDS1MgPSA1O1xuXG4vKiog6I2J56i/5a2Y5Zyo5rWP6KeI5Zmo5pys5Zyw77yI5oyJ5omp5bGV5ZCN5YiG6ZSu77yJ77yM6Z2i5p2/5YWz5o6J5YaN5byA5LiN5Lii44CCICovXG5jb25zdCBEUkFGVF9LRVkgPSBgJHtFWFRFTlNJT05fTkFNRX06ZHJhZnRgO1xuXG4vKipcbiAqIOWbvueJh+eahOWbm+S4qumihOeul+aVsOWtl++8iCoq5LiOIGBzb3VyY2UvaW1hZ2VzLnRzYCAvIERTSCDpmYTku7blupPlkIzlj6PlvoQqKu+8jOWPquaciei/meS4gOWkhOaUue+8ieOAglxuICpcbiAqIHwg5pWw5a2XIHwg5Li65LuA5LmI5piv6L+Z5Liq5YC8IHxcbiAqIHwtLS18LS0tfFxuICogfCBgbWF4UGl4ZWxzYCAyMDQ4w5cyMDQ4IHwgRFNIIOW9kuS4gOWMluWQjuWwseaYr+i/meS4qumihOeul++8iGBub3JtYWxpemVkSW1hZ2VNYXhQaXhlbHNg77yJ44CCKirpnaLmnb/lhYjnvKnliLDkvY0qKu+8jOWIq+aKiiA0SyDmiKrlm77mlbTkuKrloZ7ov5sgSVBDIOWGjeiuqeWug+e8qSDigJTigJQg6YKj5piv5Y2B5YegIE1CIOeahOWtl+espuS4su+8jOmdouadv+WSjOWtkOi/m+eoi+mDveimgeeZveaJm+S4gOmBjSB8XG4gKiB8IGBtYXhTaWRlYCA0MDk2IHwg5p6B56uv6ZW/5p2h5Zu+77yIMjcwMMOXMjAwMDAg55qE5oiq5Zu+77yJ5oyJ5YOP57Sg6aKE566X57yp5a6M6L+Y5Ymp5b6I6ZW/55qE6L6577yM5YaN5aS55LiA6YGTIHxcbiAqIHwgYG5vcm1hbGl6ZWRNYXhCeXRlc2AgNE1CIHwgRFNIIOW9kuS4gOWMluWQjueahOe8lueggeebruagh++8iGBub3JtYWxpemVkSW1hZ2VNYXhCeXRlc2DvvInjgILotoXkuoblsLHlvoDkuIvotbAgd2VicCAvIEpQRUcg6LSo6YeP5qKv5a2Q77yI6KeBIGBlbmNvZGVDYW52YXNg77yJIHxcbiAqIHwgYHRodW1iU2lkZWAgMTI4IHwg6L6T5YWl5Yy6L+mAieaLqeWZqOmHjOeahOe8qeeVpeWbvui+uemVv++8jOWPquW9seWTjeinguaEn+S4juWGheWtmCB8XG4gKi9cbmNvbnN0IElNQUdFX0JVREdFVCA9IHtcbiAgICBtYXhQaXhlbHM6IDIwNDggKiAyMDQ4LFxuICAgIG1heFNpZGU6IDQwOTYsXG4gICAgbm9ybWFsaXplZE1heEJ5dGVzOiA0ICogMTAyNCAqIDEwMjQsXG4gICAgdGh1bWJTaWRlOiAxMjgsXG59IGFzIGNvbnN0O1xuXG4vKiogSlBFRyDotKjph4/moq/lrZDvvIjkvp3mrKHor5XvvIzlj5bnrKzkuIDkuKrov5vpooTnrpfnmoTvvInjgILlj6rlnKjjgIxQTkcg5aSq5aSn44CN5oiW5rqQ5pys5p2l5bCx5pivIEpQRUcg5pe255So44CCICovXG5jb25zdCBKUEVHX0xBRERFUiA9IFswLjkyLCAwLjgsIDAuNywgMC42XTtcblxuLyoqIOmAieaLqeWZqOmHjOacgOWkmuWQjOWHoOi3r+ivu+Wbvu+8iOavj+W8oOmDveaYr+S4gOasoSBJUEMgKyDkuIDmrKHop6PnoIHvvIzlubblj5Hpq5jkuobpnaLmnb/kvJrljaHvvInjgIIgKi9cbmNvbnN0IFRIVU1CX0NPTkNVUlJFTkNZID0gMztcblxuLyoqIOe8qeeVpeWbvue8k+WtmOadoeaVsOS4iumZkO+8iOavj+adoeaYr+S4gOS4quWwjyBkYXRhIFVSTO+8jOWHoOWNgSBLQiDnuqfliKvvvInjgIIgKi9cbmNvbnN0IFRIVU1CX0NBQ0hFX0xJTUlUID0gMjAwO1xuXG4vKipcbiAqIOaPkOekuuadoeeahCoq5pyA55+t5YGc55WZ5pe26Ze0KirvvIjmr6vnp5LvvInigJTigJQg6KeBIGBzZXRCYW5uZXJgIOeahCBgaG9sZE1zYOOAglxuICpcbiAqIOWIhuW8gOS4pOaho+eahOeQhueUse+8mumUmeivr+imgeivu+WIsO+8iDEycyDlpJ/nnIvmuIXjgIHlj4jkuI3kvJrkuIDnm7TmjILlnKjpgqPlhL/vvInvvIxcbiAqIOiAjOOAjOW3sue7j+WcqOWIl+ihqOmHjOS6huOAjei/meexu+ehruiupOS/oeaBryA0IOenkui2s+Wkn+OAglxuICovXG5jb25zdCBCQU5ORVJfSE9MRCA9IHsgSU5GTzogNDAwMCwgRVJST1I6IDEyXzAwMCB9IGFzIGNvbnN0O1xuXG4vKiog54q25oCB54K5L+aWh+ahiOOAgiAqL1xuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxBZ2VudFN0YXR1cywgc3RyaW5nPiA9IHtcbiAgICBzdG9wcGVkOiAn5pyq5ZCv5YqoJyxcbiAgICBpbnN0YWxsaW5nOiAn5YeG5aSHIHByb2ZpbGXigKYnLFxuICAgIHN0YXJ0aW5nOiAn5ZCv5Yqo5Lit4oCmJyxcbiAgICByZWFkeTogJ+Wwsee7qicsXG4gICAgc3RvcHBpbmc6ICflgZzmraLkuK3igKYnLFxuICAgIGVycm9yOiAn5Ye66ZSZJyxcbn07XG5cbi8qKiDlpJbop4LmjInpkq7kuIrnmoTkuInmoaPlvqrnjq/vvIh0aXRsZSDnlKjvvInjgIIgKi9cbmNvbnN0IFRIRU1FX0NZQ0xFOiBQYW5lbFRoZW1lW10gPSBbJ2F1dG8nLCAnZGFyaycsICdsaWdodCddO1xuLyoqXG4gKiDimqAg5paH5qGI6KaB6LefKirooYzkuLoqKuS4gOiHtO+8mmBhdXRvYCDnmoTlrp7pmYXooYzkuLrmmK/jgIzog73orqTlh7rnvJbovpHlmajkuLvpopjlsLHot5/nvJbovpHlmajvvIzorqTkuI3lh7rmiY3ot5/ns7vnu5/jgI1cbiAqIO+8iGByZXNvbHZlVGhlbWVg77yJ77yM5Y6f5p2l5YaZ55qE5piv44CM6Lef6ZqP57O757uf44CN4oCU4oCUIOmCo+aYr+aKiuWbnuiQveaho+W9k+aIkOS6huS4u+aho++8jOWunua1i+WvueS4jeS4iuOAglxuICovXG5jb25zdCBUSEVNRV9MQUJFTDogUmVjb3JkPFBhbmVsVGhlbWUsIHN0cmluZz4gPSB7IGF1dG86ICfot5/pmo/nvJbovpHlmagnLCBkYXJrOiAn5rex6ImyJywgbGlnaHQ6ICfmtYXoibInIH07XG5jb25zdCBUSEVNRV9HTFlQSDogUmVjb3JkPFBhbmVsVGhlbWUsIHN0cmluZz4gPSB7IGF1dG86ICfil5AnLCBkYXJrOiAn4pePJywgbGlnaHQ6ICfil4snIH07XG5cbi8qKiDkuLvov5vnqIvov5Tlm57nmoTnirbmgIHljIXjgIIgKi9cbmludGVyZmFjZSBTdGF0ZVJlcGx5IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBleHRlbnNpb24/OiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyByb290Pzogc3RyaW5nIH07XG4gICAgYWdlbnQ/OiBBZ2VudFNuYXBzaG90O1xuICAgIHNldHRpbmdzPzogRHNoQ2hhdFNldHRpbmdzO1xuICAgIC8qKiDmnIDov5HkuIDmrKHmioogYGRzaC1wcm9maWxlL2Ag5ZCM5q2l5YiwIGAkRFNIX0hPTUVgIOeahOe7k+aenOOAgiAqL1xuICAgIHByb2ZpbGU/OiB7IG9rOiBib29sZWFuOyBwcm9maWxlRGlyPzogc3RyaW5nOyB2ZXJzaW9uPzogc3RyaW5nOyBjaGFuZ2VzPzogc3RyaW5nW107IGVycm9yPzogc3RyaW5nIH07XG4gICAgLyoqIOmdouadv+iHquajgOWOhuWPsu+8iOS4u+i/m+eoi+aUtueahO+8jOingSBgcGFuZWxQcm9iZWDvvInjgIIgKi9cbiAgICBwYW5lbD86IEFycmF5PHsgYXQ6IG51bWJlcjsgZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfT47XG59XG5cbi8qKlxuICog6L6T5YWl5Yy66YeMKirlvoXlj5HpgIEqKueahOS4gOW8oOWbvuOAglxuICpcbiAqIOS4jiBgY29uc3RhbnRzLnRzYCDnmoQgYFNlbmRJbWFnZWAg55qE5Yy65Yir77ya6YKj5LiA5Liq5piv44CM5Y2P6K6u5LiK55yf5q2j5Lya5Lyg5Ye65Y6755qE5Lic6KW/44CN77yI5Lik5Liq5a2X5q6177yJ77yMXG4gKiDov5nkuIDkuKrov5jluKbnnYDpnaLmnb/oh6rlt7HopoHnlKjnmoTkuJzopb8g4oCU4oCUIOe8qeeVpeWbvuOAgeWDj+e0oOWwuuWvuOOAgeadpea6kOOAgioq5aSa5Ye65p2l55qE5a2X5q615LiA5b6L5LiN6L+bIElQQyDnmoTlm74qKuOAglxuICovXG5pbnRlcmZhY2UgQXR0YWNobWVudCB7XG4gICAgLyoqIOmdouadv+acrOWcsOi6q+S7ve+8iOWOu+mHjS/liKDpmaTnlKjvvJvlkIzlkI3nmoTkuKTlvKDliarotLTmnb/lm77kuI3og73kupLnm7jpobbmjonvvInjgIIgKi9cbiAgICBpZDogc3RyaW5nO1xuICAgIC8qKiDmmL7npLrlkI3vvIjlt6XnqIvlm77mmK/mlofku7blkI3vvIzliarotLTmnb/lm77mmK/jgIzliarotLTmnb/lm77niYctMS5wbmfjgI3vvInjgIIgKi9cbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgbWltZVR5cGU6IEltYWdlTWltZVR5cGU7XG4gICAgLyoqICoq6KeE6IyDKiogYmFzZTY077yI5pegIGBkYXRhOmAg5YmN57yA44CB5peg5o2i6KGM77yJ4oCU4oCUIOmZhOS7tuW6k+eahOino+eggeWZqOWPquiupOi/meS4gOenjeOAgiAqL1xuICAgIGRhdGE6IHN0cmluZztcbiAgICAvKiog6Kej56CB5ZCO55qE5a2X6IqC5pWw44CCICovXG4gICAgYnl0ZXM6IG51bWJlcjtcbiAgICB3aWR0aDogbnVtYmVyO1xuICAgIGhlaWdodDogbnVtYmVyO1xuICAgIC8qKiDlsI/lm74gZGF0YSBVUkzvvIjlj6rnlKjkuo7mmL7npLrvvInjgIIgKi9cbiAgICB0aHVtYjogc3RyaW5nO1xuICAgIG9yaWdpbjogJ2NsaXBib2FyZCcgfCAncHJvamVjdCcgfCAnZHJvcCc7XG4gICAgLyoqIOW9kuS4gOWMluaXtuWBmui/h+S7gOS5iO+8iOOAjOW3sue8qeWIsCAyMDQ4w5cxMTUy44CN44CMUE5HIOKGkiBKUEVH44CN77yJ77yM5pi+56S65Zyo56KO54mH5LiK57uZ5Lq65LiA5Liq5Lqk5Luj44CCICovXG4gICAgbm90ZT86IHN0cmluZztcbn1cblxuLyoqIOS4gOasoemdouadv+WunuS+i+eahOWFqOmDqOWPr+WPmOeKtuaAgeOAguWFg+e0oOW8leeUqOWFqOmDqOadpeiHqiBgJGDvvIjop4Hmlofku7blpLTnrKwgMiDmnaHvvInjgIIgKi9cbmludGVyZmFjZSBVaVN0YXRlIHtcbiAgICByb290OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgZG90OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgdGl0bGU6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBzdWI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBiYW5uZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBzZXR0aW5nc0hvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBib2R5OiBIVE1MRWxlbWVudDtcbiAgICBpbnB1dDogSFRNTFRleHRBcmVhRWxlbWVudDtcbiAgICBzZW5kQnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgbGl2ZTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIG1ldGE6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBlbHM6IE1hcDxudW1iZXIsIEhUTUxFbGVtZW50PjtcbiAgICBlbnRyaWVzOiBNYXA8bnVtYmVyLCBFbnRyeT47XG4gICAgLyoqIOWxleW8gC/mlLbotbfvvJrlt6XlhbfljaHniYfkuI7mgJ3ogIPlnZfvvIjmjIkgc2VxIOiusO+8jOi3qOmHjee7mOS/neeVme+8ieOAgiAqL1xuICAgIG9wZW5Ub29sczogTWFwPG51bWJlciwgYm9vbGVhbj47XG4gICAgY29sbGFwc2VkVGhpbms6IE1hcDxudW1iZXIsIGJvb2xlYW4+O1xuICAgIG1heFJldjogbnVtYmVyO1xuICAgIG1heFNlcTogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIOi9rOWGmeS7o+aVsCDigJTigJQg5Li76L+b56iL6YKj6L65IGByZXNldFRyYW5zY3JpcHQoKWAg5LyaICsx77yI5o2i5Lya6K+d44CB5Zue5pS+5Y6G5Y+y77yJ44CCXG4gICAgICpcbiAgICAgKiDpnaLmnb/lj6rmjIkgYHJldmAg5Y+W5aKe6YeP77yM44CM5p+Q5p2h6KKr5Yig5o6J44CN6L+Z5Lu25LqL6KGo6L6+5LiN5Ye65p2l77yM5omA5Lul5riF56m65b+F6aG75pyJ54us56uL6K6w5Y+377yaXG4gICAgICog5Luj5pWw5a+55LiN5LiK5bCxKirmlbTlnZfph43nlLsqKu+8iOiAjOS4jeaYr+aKiuaWsOaXp+adoeebrua3t+WcqOS4gOi1t++8ieOAglxuICAgICAqL1xuICAgIGdlbmVyYXRpb246IG51bWJlcjtcbiAgICB0aWNrOiBudW1iZXI7XG4gICAgLyoqIOS4i+S4gOi9rui9ruivoueahOWumuaXtuWZqO+8iOiHquiwg+W6pu+8mui3keWKqC/nqbrpl7LnlKjkuI3lkIzpl7TpmpTvvInjgIIgKi9cbiAgICB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsO1xuICAgIC8qKiDmmK/lkKblnKjova7or6LvvIhgdGltZXJgIOWPquaYr+W9k+WJjei/meS4gOi3s++8jOeUqOWug+ihqOi+vuOAjOW8gOedgC/lgZzkuobjgI3vvInjgIIgKi9cbiAgICBwb2xsaW5nOiBib29sZWFuO1xuICAgIC8qKiDlj6rlnKjnrKzkuIDmrKEgcmVzdW1lIOaXtuWbnuS8oOS4gOasoeiHquajgO+8jOWFjeW+l+WIt+Wxj+OAgiAqL1xuICAgIHJlcG9ydGVkUmVzdW1lOiBib29sZWFuO1xuICAgIHNuYXBzaG90OiBBZ2VudFNuYXBzaG90IHwgbnVsbDtcbiAgICBzZXR0aW5nczogRHNoQ2hhdFNldHRpbmdzIHwgbnVsbDtcbiAgICBzZXR0aW5nc09wZW46IGJvb2xlYW47XG4gICAgLyoqIOWOhuWPsuS8muivneaKveWxieaYr+WQpuaJk+W8gOOAgiAqL1xuICAgIGhpc3RvcnlPcGVuOiBib29sZWFuO1xuICAgIHN0YXJ0UmVxdWVzdGVkOiBib29sZWFuO1xuICAgIC8qKlxuICAgICAqIOW3sue7j+WPkeWHuuOAjOWBnOatouacrOi9ruOAjeOAgeS9hiBgdHVybi9lbmRgIOi/mOayoeWIsOeahOmCo+S4gOauteOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB6K6w77yaYEFnZW50LmNhbmNlbCgpYCDmmK8qKuivt+axgioq5LiN5piv5Y2z5pe255Sf5pWIIOKAlOKAlCDmqKHlnovkvJrmiorlt7Lnu4/nlJ/miJDnmoTpgqPkuIDlsI/mrrVcbiAgICAgKiDlkJDlrozjgIHlnKjpo57nmoTlt6XlhbfosIPnlKjkuZ/lj6/og73lho3lm57kuIDmnaHnu5PmnpzvvIzov5nmnJ/pl7QgYHJ1bm5pbmdgIOS7jeaYryB0cnVl44CCXG4gICAgICog5LiN6K6w6L+Z5Liq5qCH5b+X55qE6K+d5oyJ6ZKu5Lya56uL5Yi75oGi5aSN5Y+v54K577yM55So5oi36L+e54K55Yeg5LiL562J5LqO6YeN5aSN5Y+R5Y+W5raI6K+35rGC44CCXG4gICAgICovXG4gICAgaW50ZXJydXB0aW5nOiBib29sZWFuO1xuICAgIC8qKlxuICAgICAqIOaPkOekuuadoeeahOacgOefreWBnOeVmeaIquatouaXtuWIu++8iOingSBgc2V0QmFubmVyYCDnmoQgYGhvbGRNc2DvvInjgIJcbiAgICAgKiBgcmVmcmVzaFN0YXRlYCDph4zpgqPlj6XjgIzmsqHkuovlsLHmiormqKrluYXmlLbotbfmnaXjgI3opoHlhYjpl67ov4flroPjgIJcbiAgICAgKi9cbiAgICBiYW5uZXJVbnRpbDogbnVtYmVyO1xuICAgIGVtcHR5RWw6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICB0eXBpbmdFbDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDkuIrkuIDkuKrlh7rnjrDnmoTnlKjmiLfmtojmga8gc2Vx77yI55So5p2l5Zyo5Zue5ZCI5LmL6Ze05ouJ5YiG6ZqU57q/77yJ44CCICovXG4gICAgbGFzdFVzZXJTZXE6IG51bWJlcjtcbiAgICAvKiog5Y6G5Y+y5Lya6K+d5oq95bGJ5LiO44CM57un57ut5q2k5Lya6K+d44CN5qiq5bmF77yI5YWD57Sg6KeBIHN0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWzvvInjgIIgKi9cbiAgICBoaXN0b3J5QmFyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgaGlzdG9yeUJhclRleHQ6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBoaXN0b3J5OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgaGlzdG9yeUxpc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBoaXN0b3J5Tm90ZTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDmir3lsYnph4znmoTmoIfpopjnrZvpgInmoYbvvIhFbnRlciA9IOaQnOWFqOaWh++8jEVzYyA9IOWbnuWIl+ihqO+8ieOAgiAqL1xuICAgIGhpc3RvcnlTZWFyY2hFbDogSFRNTElucHV0RWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOOAjOaQnOWFqOaWh+OAjeaMiemSru+8iOaQnOe0ouS4reaYvuekuuOAjOaQnOe0ouS4reKApuOAjeW5tuemgeeUqCDigJTigJQg6L+e54K55Lya5byA5aW95Yeg5LiqIG5vZGUg6L+b56iL77yJ44CCICovXG4gICAgYnRuSGlzdG9yeVNlYXJjaDogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDjgIzov5Tlm57liJfooajjgI3mjInpkq7vvIjlj6rlnKjmkJzntKLnu5Pmnpzph4zlh7rnjrDvvInjgIIgKi9cbiAgICBidG5IaXN0b3J5QmFjazogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDjgIzliLfmlrDjgI3mjInpkq7vvIjmkJzntKLkuK3kuIDlubbnpoHnlKjvvInjgIIgKi9cbiAgICBidG5IaXN0b3J5UmVmcmVzaEVsOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgcmVzdW1lQnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgLyoqXG4gICAgICog5Y6G5Y+y5oq95bGJ6YeM55qE5pCc57Si5qGG5b2T5YmN55qE5paH5pys77yIKirlj6rnrZvmoIfpopgvaWQqKu+8jOe6r+acrOWcsO+8jOWNs+aXtueUn+aViO+8ieOAglxuICAgICAqXG4gICAgICog5LiOIGBoaXN0b3J5U2VhcmNoYCDliIblvIDnmoTnkIbnlLHvvJrov5nmmK/jgIzlnKjmiYvovrnov5nlh6DmnaHph4zmib7jgI3vvIzpgqPmmK/jgIzlnKjno4Hnm5jkuIrmiYDmnInkvJror53ph4zmib7jgI3jgIJcbiAgICAgKiDliY3ogIXpm7bmiJDmnKzjgIHlkI7ogIXmnInpooTnrpfvvIzmt7fmiJDkuIDkuKrmjqfku7bkvJrorqnkurrliIbkuI3muIXjgIzkuLrku4DkuYjliJrmiY3np5Llh7rjgIHov5nmrKHopoHnrYnkuKTnp5LjgI3jgIJcbiAgICAgKi9cbiAgICBoaXN0b3J5UXVlcnk6IHN0cmluZztcbiAgICAvKiog5LiK5LiA5qyh5YiX6KGo5o6l5Y+j57uZ5Zue5p2l55qE5Lya6K+d77yI6YeN55S75pe26KaB5a6D77yM5LiN54S25q+P5qyh5pS55pCc57Si6K+N6YO96KaB6YeN6K+756OB55uY77yJ44CCICovXG4gICAgaGlzdG9yeVNlc3Npb25zOiBIaXN0b3J5U2Vzc2lvblZpZXdbXTtcbiAgICAvKiog5YWo5paH5pCc57Si55qE57uT5p6c77yb6Z2eIG51bGwg6KGo56S65oq95bGJ546w5Zyo5pi+56S655qE5pivKirmkJzntKLnu5PmnpwqKuiAjOS4jeaYr+WIl+ihqOOAgiAqL1xuICAgIGhpc3RvcnlTZWFyY2g6IEhpc3RvcnlTZWFyY2hTdGF0ZSB8IG51bGw7XG4gICAgLyoqIOato+WcqOi3keS4gOasoeWFqOaWh+aQnOe0ou+8iOaMiemSruimgeemgeeUqO+8jOS4jeeEtui/nueCueS8muW8gOWlveWHoOS4qui/m+eoi++8ieOAgiAqL1xuICAgIGhpc3RvcnlCdXN5OiBib29sZWFuO1xuICAgIC8qKiDmraPlnKjnrYnkuozmrKHnoa7orqTliKDpmaTnmoTpgqPmnaHkvJror53vvIjlrZggZHJ5LXJ1biDmiqXlh7rmnaXnmoTmuIXljZXvvInjgIIgKi9cbiAgICBoaXN0b3J5Q29uZmlybTogSGlzdG9yeUNvbmZpcm1TdGF0ZSB8IG51bGw7XG4gICAgLyoqIOWbnuaUvuWujOimgea7mui/h+WOu+eahCoq6L2s5YaZ5p2h55uu5Y+3KirvvIjlhajmlofmkJzntKLlkb3kuK3ml7bnlLHkuLvov5vnqIvmjaLnrpflpb3nu5nlm57mnaXvvInjgIIgKi9cbiAgICBqdW1wVG86IG51bWJlciB8IG51bGw7XG4gICAgLyoqIOmrmOS6rumCo+S4quWumuaXtuWZqO+8iDQg56eS5ZCO5oqK5qCH6K6w5pGY5o6J77yJ44CCICovXG4gICAganVtcFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG4gICAgLy8gLS0tLSDnlKjph4/vvIh0b2tlbiAvIOS4iuS4i+aWh+WNoOeUqO+8iS0tLS1cbiAgICAvKiog55So6YeP5oq95bGJ5piv5ZCm5omT5byA44CCICovXG4gICAgdXNhZ2VPcGVuOiBib29sZWFuO1xuICAgIC8qKiDmir3lsYnmnKzkvZPvvIhgI3VzYWdlYO+8ieOAguWtl+auteWQjeW4piBIb3N0IOWQjue8gO+8jOWFjeW+l+S4juW/q+eFp+mHjOmCo+S7vSBgdXNhZ2Vg77yI5pWw5a2X77yJ55yL5re344CCICovXG4gICAgdXNhZ2VIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOaKveWxiemHjOeahOWGheWuueWuv+S4u++8iOavj+asoemHjeeUu+mDvea4heepuumHjeW7uiDigJTigJQg5YaF5a655piv44CM6K+75LiA5qyh55qE562U5qGI44CN77yM5rKh5pyJ6ZyA6KaB5L+d5L2P55qE54q25oCB77yJ44CCICovXG4gICAgdXNhZ2VCb2R5OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOaKveWxieWktOmDqOmCo+ihjOaPkOekuu+8iOivu+Wksei0pSAvIOi/mOayoeivu+aVsOaXtueahOWOn+WboO+8m+aIkOWKn+aXtuWGmeaVsOaNruadpea6kOS4juawtOS9je+8ieOAgiAqL1xuICAgIHVzYWdlTm90ZUVsOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOeKtuaAgeihjOmCo+mil+OAjOS4iuS4i+aWhyB4eCXjgI3vvJvmsqHmlbDmja7ml7bmlbTpopfol4/otbfmnaXjgIIgKi9cbiAgICB1c2FnZUNoaXA6IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgICAvKiog5oq95bGJ5aS06YOo55qE44CM5Yi35paw44CN77yI6K+755qE5pe25YCZ56aB55So77yM6L+e54K55Lya6K+75aW95Yeg6YGN55uY77yJ44CCICovXG4gICAgYnRuVXNhZ2VSZWZyZXNoRWw6IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiDmraPlnKjnrYnkuIDmrKEqKuivu+aVsCoq77yI55So6YePICsg6L+b5bqm5piv5ZCM5LiA5qyh6K+755uY77yM5omA5Lul5Lik5Liq5oq95bGJ5YWx55So6L+Z5LiA5Liq6Ze477yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjlkIjmiJDkuIDkuKrpl7jvvJrkuKTkuKrmir3lsYnnmoTjgIzliLfmlrDjgI3miZPnmoTmmK8qKuWQjOS4gOS4qioq5Li76L+b56iL5pa55rOV77yM5Li76L+b56iL6YKj6L655bCx5pivXG4gICAgICog6K+75LiA6YGN5ZCM5LiA5Liq5paH5Lu244CC5YiG5oiQ5Lik5Liq6Ze455qE6K+d77yM5Lik5Liq5oq95bGJ6YO95byA552A5pe26L+e54K55Lik5LiL5Lya6K+75Lik6YGN5ZCM5LiA5Liq5paH5Lu277yMXG4gICAgICog6ICM5LiU5Lik5Lu95Zue5omn55qE5paw5pen5Y+v6IO95Lqk6ZSZ77yI6Z2i5p2/5LiK5bCx5Lya5Ye6546w44CM55So6YeP5piv5paw55qE44CB5riF5Y2V5piv5pen55qE44CN77yJ44CCXG4gICAgICovXG4gICAgdXNhZ2VCdXN5OiBib29sZWFuO1xuICAgIC8vIC0tLS0g6L+b5bqm77yI5b6F5Yqe5riF5Y2VIC8g55uu5qCHIC8g5Zue5ZCI55uu5b2V77yJLS0tLVxuICAgIC8qKiDov5vluqbmir3lsYnmmK/lkKbmiZPlvIDjgIIgKi9cbiAgICBwcm9ncmVzc09wZW46IGJvb2xlYW47XG4gICAgLyoqIOaKveWxieacrOS9k++8iGAjcHJvZ3Jlc3Ng77yJ44CCICovXG4gICAgcHJvZ3Jlc3NIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOaKveWxiemHjOeahOWGheWuueWuv+S4u++8iOavj+asoemHjeeUu+mDvea4heepuumHjeW7uu+8ieOAgiAqL1xuICAgIHByb2dyZXNzQm9keTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDmir3lsYnlpLTpg6jpgqPooYzmj5DnpLrvvIjor7vlpLHotKXnmoTljp/lm6AgLyDmlbDmja7mnaXmupDkuI7msLTkvY3vvInjgIIgKi9cbiAgICBwcm9ncmVzc05vdGVFbDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDnirbmgIHooYzpgqPpopfjgIzlvoXlip4geC9544CN77yb5rKh5pyJ5riF5Y2V5pe25pW06aKX6JeP6LW35p2l44CCICovXG4gICAgcHJvZ3Jlc3NDaGlwOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOaKveWxieWktOmDqOeahOOAjOWIt+aWsOOAje+8iOS4pOS4quaKveWxieaJk+eahOaYryoq5ZCM5LiA5LiqKirkuLvov5vnqIvmlrnms5XvvIzmiYDku6XkuZ/pg73mmK/kuIDmrKHor7vnm5jvvInjgIIgKi9cbiAgICBidG5Qcm9ncmVzc1JlZnJlc2hFbDogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuXG4gICAgLy8gLS0tLSDmtLvliqjvvIjlkI7lj7Dku7vliqEgam9icyAvIOWtkCBhZ2VudCBzdWJhZ2VudHPvvIktLS0tXG4gICAgLyoqIOa0u+WKqOaKveWxieaYr+WQpuaJk+W8gOOAgiAqL1xuICAgIGFjdGl2aXR5T3BlbjogYm9vbGVhbjtcbiAgICAvKiog5oq95bGJ5pys5L2T77yIYCNhY3Rpdml0eWDvvInjgIIgKi9cbiAgICBhY3Rpdml0eUhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAvKiog5oq95bGJ6YeM55qE5YaF5a655a6/5Li777yI5q+P5qyh6YeN55S76YO95riF56m66YeN5bu677yJ44CCICovXG4gICAgYWN0aXZpdHlCb2R5OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOaKveWxieWktOmDqOmCo+ihjOaPkOekuu+8iOivu+WIsOWHoOeCueeahCAvIOacjeWKoeayoeaMgueahOWOn+WboO+8ieOAgiAqL1xuICAgIGFjdGl2aXR5Tm90ZUVsOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgLyoqIOeKtuaAgeihjOmCo+mil+OAjOWQjuWPsCB4IMK3IOWtkCB544CN77ybKirmsqHkuovml7bmlbTpopfol4/otbfmnaUqKuOAgiAqL1xuICAgIGFjdGl2aXR5Q2hpcDogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDmir3lsYnlpLTpg6jnmoTjgIzliLfmlrDjgI3jgIIgKi9cbiAgICBidG5BY3Rpdml0eVJlZnJlc2hFbDogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKlxuICAgICAqIOacgOi/keS4gOasoeivu+WIsOeahOa0u+WKqOmCo+S4gOS7ve+8iGBudWxsYCA9IOi/mOayoeivu+i/h++8ieOAglxuICAgICAqXG4gICAgICog4pqgIOWugyoq5LiN5ZyoIGBBZ2VudFNuYXBzaG90YCDph4wqKu+8jOS4jueUqOmHjy/ov5vluqbpgqPkuKTlnZfliLvmhI/kuI3lkIzvvJrpgqPkuKTkuKrmnaXoh6rno4Hnm5jkuIrnmoTmo4Dmn6XngrnnvJPlrZhcbiAgICAgKiDvvIjkuLvov5vnqIvpobrmiYvor7vkuIDmrKHlsLHog73loZ7ov5vnirbmgIHlv6vnhafvvInvvIzogIzov5nkuKTlnZflj6rmtLvlnKjov5DooYzml7bov5vnqIvnmoTlhoXlrZjph4zvvIxcbiAgICAgKiDopoEqKuS4k+mXqOaJk+S4gOadoeaOp+WItuW4pyoq5Y676ZeuIOKAlOKAlCDmiYDku6XnlLHpnaLmnb/oh6rlt7HlhrPlrprku4DkuYjml7blgJnpl67vvIjmiZPlvIDmir3lsYkgLyDot5HliqjkuK3mjInoioLmtYHpl67vvInjgIJcbiAgICAgKi9cbiAgICBhY3Rpdml0eTogQWN0aXZpdHlWaWV3IHwgbnVsbDtcbiAgICAvKiog5LiK5LiA5qyh6Zeu5rS75Yqo55qE5pe25Yi777yI6IqC5rWB55So77yb6L+Z5Lik5Liq5pyN5Yqh5rKh5pyJ5Y+Y5YyW6YCa55+l5Y+v6K6i6ZiF77yM5Y+q6IO96Zeu77yJ44CCICovXG4gICAgYWN0aXZpdHlBdDogbnVtYmVyO1xuICAgIC8qKiDmraPlnKjnrYnkuIDmrKHmtLvliqjlm57miafvvIjpgb/lhY3lj6DnnYDpl67vvInjgIIgKi9cbiAgICBhY3Rpdml0eUJ1c3k6IGJvb2xlYW47XG4gICAgLyoqXG4gICAgICog5oq95bGJ5aS06YOo6YKj5Y+l6K+d77yIKiror7vkuI3lh7rmnaUgLyDmsqHotbcgYWdlbnQqKiDnmoTljp/lm6DvvInjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOWNleeLrOS4gOS4quWtl+auteiAjOS4jeaYr+ebtOaOpeWGmei/myBET03vvJrpgqPlj6Xor53ljp/mnKzmmK/jgIzor7vnmoTml7blgJnlhpnov5vlhYPntKDjgIHnlLvnmoTml7blgJnlho3ku45cbiAgICAgKiDlhYPntKDph4zor7vlm57mnaXjgI3igJTigJQg6YKj5pivKiror7voh6rlt7HnmoQgRE9NIOW9k+eKtuaAgSoq77yM5LiA5pemIGByZW5kZXJBY3Rpdml0eWAg5YWI6LeR5LiA5q2l5bCx5Lya5oqKXG4gICAgICog5a6D5b2T56m655qE6YeN55S75LiA6YGN77yI55eH54q25piv5Y6f5Zug6YKj5Y+l5pe25pyJ5pe25peg77yJ44CC54q25oCB5b2S54q25oCB44CBRE9NIOW9kiBET00g5piv6L+Z6Z2i5p2/55qE6ICB6KeE55+p44CCXG4gICAgICovXG4gICAgYWN0aXZpdHlOb3RlOiBzdHJpbmcgfCBudWxsO1xuXG4gICAgYnJvYWRjYXN0SGFuZGxlcjogKCh1cGRhdGU6IHVua25vd24pID0+IHZvaWQpIHwgbnVsbDtcblxuICAgIC8vIC0tLS0g5Lqk5LqS77yI5qih5Z6L55qE5o+Q6ZeuIC8g5o6I5p2D6K+35rGCIC8g6K6h5YiS6K+E5a6h77yJLS0tLVxuICAgIC8qKiDmib/ovb3kuqTkupLljaHniYfnmoTlrrnlmajvvIjmqKHmnb/ph4znmoQgYCNpbnRlcmFjdGlvbmDvvInjgIIgKi9cbiAgICBpbnRlcmFjdGlvbkhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAvKiog5Li76L+b56iL5oql55qE44CB5b2T5YmN5Zyo562J55qE5Lqk5LqS77yI5pW05Lu95b+r54Wn77yM5LiN5piv5aKe6YeP77yJ44CCICovXG4gICAgaW50ZXJhY3Rpb25zOiBJbnRlcmFjdGlvblZpZXdbXTtcbiAgICAvKipcbiAgICAgKiDlt7Lnu4/mj5DkuqTov4flm57nrZTnmoTkuqTkupIgaWTjgIJcbiAgICAgKlxuICAgICAqIOaPkOS6pOWIsOWNoeeJh+a2iOWkseS5i+mXtOacieS4gOWwj+aute+8iOS4u+i/m+eoiyDihpIg5o+S5Lu2IOKGkiDlm57miacg4oaSIOW5v+aSre+8ie+8jOi/meauteaXtumXtOaMiemSruW/hemhu+emgeeUqO+8jFxuICAgICAqIOWQpuWImei/nueCueS4pOS4i+S8muWPkeS4pOasoeWbnuetlO+8iOesrOS6jOasoeS8muiiq+aPkuS7tuW9k+ernuaAgeaLkuaOie+8jOS9hueUqOaIt+eci+WIsOeahOaYr1wi54K55LqG5rKh5Y+N5bqUXCLvvInjgIJcbiAgICAgKi9cbiAgICBpbnRlcmFjdGlvblNlbnQ6IFNldDxzdHJpbmc+O1xuICAgIC8qKlxuICAgICAqIOS4iuS4gOasoeeUu+WHuuadpeeahOS6pOS6kuOAjOetvuWQjeOAjeOAglxuICAgICAqXG4gICAgICogKirkuLrku4DkuYjopoHmnInlroMqKu+8mmByZWZyZXNoU3RhdGVgIOavjyA4MDBtc++8iOi3keWKqOaXtiAzMDBtc++8ieWwseS8mui3keS4gOasoe+8jOiAjOmdouadv+eahOS6pOS6kuWdl+mHjFxuICAgICAqIOacieWNlemAieahhueKtuaAgeWSjCoq5q2j5Zyo6L6T5YWl55qE6Ieq5a6a5LmJ5Zue562UKiog4oCU4oCUIOavj+asoemDvemHjeW7uiBET00g5Lya5oqK55So5oi35Yia5pWy55qE5a2X5oq55o6J44CCXG4gICAgICog562+5ZCN5rKh5Y+Y5bCx5LiA5Liq5a2X6IqC6YO95LiN5Yqo77yI5Y+q55SxIGBpbnRlcmFjdGlvblNlbnRgIOS4juS6pOS6kumbhuWQiOacrOi6q+WGs+Wumu+8ieOAglxuICAgICAqL1xuICAgIGludGVyYWN0aW9uU2lnOiBzdHJpbmc7XG5cbiAgICAvLyAtLS0tIOi+k+WFpeinpuWPkeWZqO+8iGAvYCDmlpzmnaDlkb3ku6QgwrcgYEBgIOi3r+W+hOW8leeUqO+8iS0tLS1cbiAgICAvKiog5om/6L295by55Ye65Z2X55qE5a655Zmo77yI5qih5p2/6YeM55qEIGAjcG9wdXBg77yJ44CCICovXG4gICAgcG9wdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiDlvLnlh7rlnZfnjrDlnKjmmK/lk6rnp43vvJpgY29tbWFuZGAgPSDmlpzmnaDlkb3ku6TooajvvIxgbWVudGlvbmAgPSBgQGAg6Lev5b6E5YCZ6YCJ77yMYG51bGxgID0g5YWz552A44CCXG4gICAgICpcbiAgICAgKiDkuKTnp43lhbHnlKjkuIDkuKrlrrnlmajvvIjlkIzkuIDml7bliLvkuI3kvJrmnInnrKzkuoznp43vvInjgIHlhbHnlKjkuIDkuKrplK7nm5jljY/orq7vvIjihpHihpMg6YCJ44CBRW50ZXIvVGFiIOiupOOAgVxuICAgICAqIEVzYyDlhbPvvInvvIzmiYDku6XnlKjkuIDkuKrlrZfmrrXogIzkuI3mmK/kuKTkuKogYm9vbOOAglxuICAgICAqL1xuICAgIHBvcHVwS2luZDogJ2NvbW1hbmQnIHwgJ21lbnRpb24nIHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiDlvLnlh7rlnZfph4wqKuW9k+WJjei/meS7vSoq5YCZ6YCJ77yI55S75Ye65p2l55qE5piv5a6D77yM5Lmf5pivIOKGkeKGkyDkuI4gRW50ZXIg5L2c55So55qE6YKj5Liq5pWw57uE77yJ44CCXG4gICAgICpcbiAgICAgKiDmr4/kuIDpobnoh6rlt7HluKYgYGFwcGx5KClg77ya5ZG95Luk55qEIGFwcGx5IOaYr+OAjOaKiuWRveS7pOihjOWhq+i/m+i+k+WFpeahhuOAje+8jFxuICAgICAqIOi3r+W+hOeahCBhcHBseSDmmK/jgIzmm7/mjaLlhYnmoIflpITpgqPkuKogdG9rZW7jgI3jgILov5nmoLfplK7nm5jkuI7pvKDmoIfkuKTmnaHot6/otbDnmoTmmK/lkIzkuIDmrrXku6PnoIHjgIJcbiAgICAgKi9cbiAgICBwb3B1cEl0ZW1zOiBBcnJheTx7IGxhYmVsOiBzdHJpbmc7IGRldGFpbDogc3RyaW5nOyBkaXNhYmxlZD86IGJvb2xlYW47IGFwcGx5OiAoKSA9PiB2b2lkIH0+O1xuICAgIC8qKiDplK7nm5jpq5jkuq7nmoTlgJnpgInkuIvmoIfjgIIgKi9cbiAgICBwb3B1cEluZGV4OiBudW1iZXI7XG4gICAgLyoqXG4gICAgICog5ZG95Luk6KGo77yIKirmjInkvJror53nvJPlrZgqKu+8muWRveS7pOaYr+aMiSBhZ2VudCDmn6XnmoTvvIzmjaLkvJror53opoHph43mi4nvvInjgIJcbiAgICAgKlxuICAgICAqIGBudWxsYCA9IOi/mOayoeaLiei/h+OAguaLieWksei0peS8mueVmeS4gOadoeepuuaVsOe7hCArIOaoquW5he+8iOS4jeWPjeWkjemHjeivle+8jOWQpuWImeavj+aVsuS4gOS4quWtl+esplxuICAgICAqIOWwseW+gOS4u+i/m+eoi+aJk+S4gOWPke+8ieOAglxuICAgICAqL1xuICAgIGNvbW1hbmRzOiBDb21tYW5kVmlld1tdIHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiBgQGAg5YCZ6YCJ55qE57yT5a2Y77ya5p+l6K+i5LiyIOKGkiDlgJnpgInjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOimgeacie+8mmBAYCDooaXlhagqKuavj+aVsuS4gOS4quWtl+espuWwseafpeS4gOasoSoq77yM6ICM5o+Q5L6b5pa555qE56ys5LiA5qyh44CM6KO45p+l6K+i44CN6KaB5oqKXG4gICAgICog5pW05Liq5bel5L2c5Yy657Si5byV5LiA6YGN44CC5ZCM5LiA5Liq5p+l6K+i5Liy6YeN5aSN6Zeu5rKh5pyJ5oSP5LmJ77yI5q+U5aaC6YCA5qC85YaN5omT5Zue5p2l77yJ44CCXG4gICAgICovXG4gICAgbWVudGlvbkNhY2hlOiBNYXA8c3RyaW5nLCBSZWZlcmVuY2VDYW5kaWRhdGVbXT47XG4gICAgLyoqIOWcqOmjnueahOmCo+asoSBgQGAg5p+l6K+i55qE5bqP5Y+377ya5Zue5p2l5pe25a+55LiN5LiK5bCx5Lii5o6J77yI6Ziy5pen57uT5p6c55uW5paw57uT5p6c77yJ44CCICovXG4gICAgbWVudGlvblNlcTogbnVtYmVyO1xuXG4gICAgLy8gLS0tLSDlm77niYfvvIjnspjotLTliarotLTmnb8gLyDku47lt6XnqIvph4zpgInvvIktLS0tXG4gICAgLyoqIOW+heWPkemAgeeahOWbvueJh++8iOWPkemAgeaIkOWKn+aJjea4heepuu+8m+Wksei0peeVmeedgOiuqeeUqOaIt+mHjeivle+8ieOAgiAqL1xuICAgIGF0dGFjaG1lbnRzOiBBdHRhY2htZW50W107XG4gICAgLyoqIOi+k+WFpeWMuuS4iuaWuemCo+aOkueijueJh+OAgiAqL1xuICAgIGF0dGFjaEhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBpbWFnZUJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDmraPlnKjlvZLkuIDljJbvvIjop6PnoIEgKyDnvKnmlL4gKyDnvJbnoIHvvInnmoTlm77niYfmlbAg4oCU4oCUIOWkp+S6jiAwIOaXtuaMiemSrui9rOWciOOAgeWbnui9puS4jeaKouWPkeOAgiAqL1xuICAgIGltYWdlQnVzeTogbnVtYmVyO1xuICAgIC8qKiDlm77niYfpgInmi6nlmajvvIjlt6XnqIvlm77niYfmtY/op4jlmajvvInjgIIgKi9cbiAgICBwaWNrZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBwaWNrZXJMaXN0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgcGlja2VyTm90ZTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIHBpY2tlclNlYXJjaDogSFRNTElucHV0RWxlbWVudCB8IG51bGw7XG4gICAgcGlja2VyT3BlbjogYm9vbGVhbjtcbiAgICAvKiog5bel56iL5Zu+54mH5riF5Y2V77yI5omT5byA6YCJ5oup5Zmo5pe25ouJ5LiA5qyh77yM5LmL5ZCO57yT5a2Y5Zyo6Z2i5p2/6YeM77ybYHJlZnJlc2hgIOW8uuWItumHjeaLie+8ieOAgiAqL1xuICAgIHBpY2tlckltYWdlczogUHJvamVjdEltYWdlW10gfCBudWxsO1xuICAgIC8qKiDov5nku73muIXljZXmmK/ku47lk6rmnaXnmoTvvIhgYXNzZXQtZGJgID0g6LWE5rqQ5bqT77yMYHNjYW5gID0g5omr55uu5b2V5YWc5bqV77yJ44CCICovXG4gICAgcGlja2VyU291cmNlOiBzdHJpbmc7XG4gICAgLyoqIOmAieaLqeWZqOmHjOeahOaQnOe0ouivje+8iOi3qOmHjee7mOS/neeVme+8ieOAgiAqL1xuICAgIHBpY2tlclF1ZXJ5OiBzdHJpbmc7XG4gICAgLyoqIOe8qeeVpeWbvue8k+WtmO+8muWbvueJh+i3r+W+hCDihpIgZGF0YSBVUkzvvIjpgInmi6nlmajlhbPmjonlho3lvIDkuI3ph43or7vvvInjgIIgKi9cbiAgICBwaWNrZXJUaHVtYnM6IE1hcDxzdHJpbmcsIHN0cmluZz47XG4gICAgLyoqIOivu+S4jeWHuue8qeeVpeWbvueahOi3r+W+hO+8iOWIq+WPjeWkjemHjeivle+8jOWQpuWImea7muWKqOS4gOasoeWwseWIt+S4gOS4siBJUEPvvInjgIIgKi9cbiAgICBwaWNrZXJGYWlsZWQ6IFNldDxzdHJpbmc+O1xuICAgIC8qKiDmraPlnKjor7vnmoTot6/lvoTvvIjljrvph43vvInjgIIgKi9cbiAgICBwaWNrZXJMb2FkaW5nOiBTZXQ8c3RyaW5nPjtcbiAgICAvKiog562J5b6F6K+757yp55Wl5Zu+55qE6Zif5YiX77yI6KeBIGBUSFVNQl9DT05DVVJSRU5DWWDvvInjgIIgKi9cbiAgICBwaWNrZXJRdWV1ZTogQXJyYXk8eyBpbWFnZTogUHJvamVjdEltYWdlOyB0YXJnZXQ6IEhUTUxJbWFnZUVsZW1lbnQgfT47XG4gICAgLyoqIOWPr+ingeWNs+WKoOi9ve+8iOmVv+a4heWNlemHjOWPquivu+ecvOWJjei/meWHoOW8oO+8ieOAgiAqL1xuICAgIHBpY2tlck9ic2VydmVyOiBJbnRlcnNlY3Rpb25PYnNlcnZlciB8IG51bGw7XG4gICAgLyoqXG4gICAgICog5Yia5Y+R5Ye65Y6755qE6YKj5Yeg5byg5Zu+55qE57yp55Wl5Zu+77yI5ZCN5a2XIOKGkiBkYXRhIFVSTO+8ieOAglxuICAgICAqXG4gICAgICog5Y+q5Li65LqG6K6pKiroh6rlt7HpgqPmnaHnlKjmiLfmtojmga8qKumHjOaYvuekuuecn+Wbvu+8mui9rOWGmemHjOWPquacieWFg+aVsOaNru+8iOingSBgRW50cnlJbWFnZWDvvInvvIxcbiAgICAgKiDogIzjgIzmiJHliJrmiY3otLTnmoTmmK/lk6rlvKDjgI3ov5nku7bkuovlv4XpobvkuIDnnLzog73noa7orqTjgILlj6rnlZnmnIDov5EgMTIg5byg77yMRklGTyDmt5jmsbDjgIJcbiAgICAgKi9cbiAgICBzZW50VGh1bWJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5jb25zdCB1aUJ5UGFuZWwgPSBuZXcgV2Vha01hcDxvYmplY3QsIFVpU3RhdGU+KCk7XG5cbi8qKlxuICog5omA5pyJ5rS7552A55qE6Z2i5p2/5a6e5L6L44CCXG4gKlxuICog5a2Y5Zyo55CG55Sx77yaYGxpc3RlbmVycy5zaG93L2hpZGVgIOaUtuWIsOeahCBgdGhpc2Ag5YG25bCU5a+55LiN5LiKIGByZWFkeWAg6YKj5qyh77yI5oiW6ZKp5a2Q5YWI5LqOIGByZWFkeWAg5Yiw6L6+77yJ77yMXG4gKiDov5nml7bmjIkgYHRoaXNgIOafpSBXZWFrTWFwIOS8mioq6Z2Z6buY5aSx6LSlKirjgILlj6rmnInkuIDkuKrpnaLmnb/lrp7kvovml7bvvIjluLjmgIHvvInnm7TmjqXkvZznlKjlnKjlroPouqvkuIrmm7Tlj6/pnaDjgIJcbiAqL1xuY29uc3QgbGl2ZVN0YXRlcyA9IG5ldyBTZXQ8VWlTdGF0ZT4oKTtcblxuLyoqIOaJvuWIsOmSqeWtkOivpeS9nOeUqOeahOmdouadv+eKtuaAge+8muWFiOaMiSBgdGhpc2DvvIzlho3pgIDliLDjgIzllK/kuIDlrp7kvovjgI3jgIIgKi9cbmZ1bmN0aW9uIHJlc29sdmVTdGF0ZShzZWxmOiBvYmplY3QpOiBVaVN0YXRlIHwgbnVsbCB7XG4gICAgY29uc3QgZGlyZWN0ID0gdWlCeVBhbmVsLmdldChzZWxmKTtcbiAgICBpZiAoZGlyZWN0KSByZXR1cm4gZGlyZWN0O1xuICAgIGlmIChsaXZlU3RhdGVzLnNpemUgPT09IDEpIHJldHVybiBbLi4ubGl2ZVN0YXRlc11bMF07XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICog6Z2i5p2/5YWD57Sg55qE6YCJ5oup5Zmo6KGoIOKAlOKAlCAqKuWUr+S4gOecn+a6kCoq77yaYCRgIOihqOS4juWFnOW6leihpeafpemDveeUqOWug+OAglxuICpcbiAqIOWKoOWFg+e0oOaXtuWPquaUuei/memHjO+8iOWkluWKoCBgc3RhdGljL3RlbXBsYXRlL2RlZmF1bHQvaW5kZXguaHRtbGDvvInjgIJcbiAqL1xuY29uc3QgU0VMRUNUT1JTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIHJvb3Q6ICcuZHNoLXJvb3QnLFxuICAgIGRvdDogJyNkb3QnLFxuICAgIHRpdGxlOiAnI3RpdGxlJyxcbiAgICBzdWI6ICcjc3ViJyxcbiAgICBiYW5uZXI6ICcjYmFubmVyJyxcbiAgICBzZXR0aW5nczogJyNzZXR0aW5ncycsXG4gICAgYm9keTogJyNib2R5JyxcbiAgICBpbnB1dDogJyNpbnB1dCcsXG4gICAgYnRuU2VuZDogJyNidG4tc2VuZCcsXG4gICAgLyoqIOOAjOWBnOatouacrOi9ruOAje+8muWPquWcqCBgcnVubmluZ2Ag5pe25Y+v6KeB77yI6KeBIGByZWZyZXNoU3RhdGVg77yJ44CCICovXG4gICAgYnRuSW50ZXJydXB0OiAnI2J0bi1pbnRlcnJ1cHQnLFxuICAgIGJ0bk5ldzogJyNidG4tbmV3JyxcbiAgICBidG5TdG9wOiAnI2J0bi1zdG9wJyxcbiAgICBidG5SZXN0YXJ0OiAnI2J0bi1yZXN0YXJ0JyxcbiAgICBidG5IaXN0b3J5OiAnI2J0bi1oaXN0b3J5JyxcbiAgICBidG5SZXN1bWU6ICcjYnRuLXJlc3VtZScsXG4gICAgaGlzdG9yeUJhcjogJyNoaXN0b3J5LWJhcicsXG4gICAgaGlzdG9yeUJhclRleHQ6ICcjaGlzdG9yeS1iYXItdGV4dCcsXG4gICAgaGlzdG9yeTogJyNoaXN0b3J5JyxcbiAgICBoaXN0b3J5TGlzdDogJyNoaXN0b3J5LWxpc3QnLFxuICAgIGhpc3RvcnlOb3RlOiAnI2hpc3Rvcnktbm90ZScsXG4gICAgaGlzdG9yeVNlYXJjaDogJyNoaXN0b3J5LXNlYXJjaCcsXG4gICAgYnRuSGlzdG9yeUNsb3NlOiAnI2J0bi1oaXN0b3J5LWNsb3NlJyxcbiAgICBidG5IaXN0b3J5UmVmcmVzaDogJyNidG4taGlzdG9yeS1yZWZyZXNoJyxcbiAgICBidG5IaXN0b3J5U2VhcmNoOiAnI2J0bi1oaXN0b3J5LXNlYXJjaCcsXG4gICAgYnRuSGlzdG9yeUJhY2s6ICcjYnRuLWhpc3RvcnktYmFjaycsXG4gICAgYnRuU2V0dGluZ3M6ICcjYnRuLXNldHRpbmdzJyxcbiAgICBidG5UaGVtZTogJyNidG4tdGhlbWUnLFxuICAgIGxpdmU6ICcjbGl2ZScsXG4gICAgbWV0YTogJyNtZXRhJyxcbiAgICAvLyDnlKjph4/vvJrnirbmgIHooYzpgqPpopcgY2hpcCArIOaKveWxiVxuICAgIGJ0blVzYWdlOiAnI2J0bi11c2FnZScsXG4gICAgdXNhZ2U6ICcjdXNhZ2UnLFxuICAgIHVzYWdlQm9keTogJyN1c2FnZS1ib2R5JyxcbiAgICB1c2FnZU5vdGU6ICcjdXNhZ2Utbm90ZScsXG4gICAgYnRuVXNhZ2VSZWZyZXNoOiAnI2J0bi11c2FnZS1yZWZyZXNoJyxcbiAgICBidG5Vc2FnZUNsb3NlOiAnI2J0bi11c2FnZS1jbG9zZScsXG4gICAgLy8g6L+b5bqm77yI5b6F5Yqe5riF5Y2VIC8g55uu5qCHIC8g5Zue5ZCI55uu5b2V77yJ77ya5ZCM5qC35piv44CM54q25oCB6KGM5LiA6aKXIGNoaXAgKyDkuIDkuKrmir3lsYnjgI1cbiAgICBidG5Qcm9ncmVzczogJyNidG4tcHJvZ3Jlc3MnLFxuICAgIHByb2dyZXNzOiAnI3Byb2dyZXNzJyxcbiAgICBwcm9ncmVzc0JvZHk6ICcjcHJvZ3Jlc3MtYm9keScsXG4gICAgcHJvZ3Jlc3NOb3RlOiAnI3Byb2dyZXNzLW5vdGUnLFxuICAgIGJ0blByb2dyZXNzUmVmcmVzaDogJyNidG4tcHJvZ3Jlc3MtcmVmcmVzaCcsXG4gICAgYnRuUHJvZ3Jlc3NDbG9zZTogJyNidG4tcHJvZ3Jlc3MtY2xvc2UnLFxuICAgIC8vIOa0u+WKqO+8iOWQjuWPsOS7u+WKoSAvIOWtkCBhZ2VudO+8ie+8muWQjOagt+aYr+OAjOeKtuaAgeihjOS4gOmilyBjaGlwICsg5LiA5Liq5oq95bGJ44CNXG4gICAgYnRuQWN0aXZpdHk6ICcjYnRuLWFjdGl2aXR5JyxcbiAgICBhY3Rpdml0eTogJyNhY3Rpdml0eScsXG4gICAgYWN0aXZpdHlCb2R5OiAnI2FjdGl2aXR5LWJvZHknLFxuICAgIGFjdGl2aXR5Tm90ZTogJyNhY3Rpdml0eS1ub3RlJyxcbiAgICBidG5BY3Rpdml0eVJlZnJlc2g6ICcjYnRuLWFjdGl2aXR5LXJlZnJlc2gnLFxuICAgIGJ0bkFjdGl2aXR5Q2xvc2U6ICcjYnRuLWFjdGl2aXR5LWNsb3NlJyxcbiAgICAvKiog5Lqk5LqS5Z2X77yI5qih5Z6L55qE5o+Q6ZeuIC8g5o6I5p2D6K+35rGCIC8g6K6h5YiS6K+E5a6h77yJ77ya5YaF5a6555SxIGByZW5kZXJJbnRlcmFjdGlvbnNgIOeOsOW7uuOAgiAqL1xuICAgIGludGVyYWN0aW9uOiAnI2ludGVyYWN0aW9uJyxcbiAgICAvKipcbiAgICAgKiDovpPlhaXop6blj5HlmajlvLnlh7rlnZfvvIhgL2Ag5ZG95Luk6KGoIOS4jiBgQGAg6Lev5b6E5YCZ6YCJ5YWx55So5LiA5Z2X77yJ44CCXG4gICAgICpcbiAgICAgKiDkuI7ljoblj7Lmir3lsYkgLyDpgInmi6nlmajlkIzkuIDkuKrmkYbms5XvvJpgLmRzaC1yb290YCDnmoTnm7TmjqXlrZDlhYPntKDjgIHlpLnlnKjlr7nor53ljLrkuI7ovpPlhaXljLrkuYvpl7Qg4oCU4oCUXG4gICAgICogKirkuI3lgZrmta7lsYIqKuOAgueqhOmdouadv+mHjOa1ruWxguimgeiHquW3seeul+S9jee9ru+8iOi+k+WFpeahhuS8mumVv+mrmOOAgemdouadv+S8mua7muWKqO+8ie+8jOiAjOS4lOS8muebluS9j+WvueivneWGheWuueOAglxuICAgICAqL1xuICAgIHBvcHVwOiAnI3BvcHVwJyxcbiAgICAvLyAtLS0tIOWbvueJh++8iOeymOi0tCAvIOmAieWbvu+8iS0tLS1cbiAgICBhdHRhY2htZW50czogJyNhdHRhY2htZW50cycsXG4gICAgYnRuSW1hZ2U6ICcjYnRuLWltYWdlJyxcbiAgICBwaWNrZXI6ICcjcGlja2VyJyxcbiAgICBidG5QaWNrZXJDbG9zZTogJyNidG4tcGlja2VyLWNsb3NlJyxcbiAgICBidG5QaWNrZXJSZWZyZXNoOiAnI2J0bi1waWNrZXItcmVmcmVzaCcsXG4gICAgYnRuUGlja2VyUGFzdGU6ICcjYnRuLXBpY2tlci1wYXN0ZScsXG4gICAgcGlja2VyU2VhcmNoOiAnI3BpY2tlci1zZWFyY2gnLFxuICAgIHBpY2tlck5vdGU6ICcjcGlja2VyLW5vdGUnLFxuICAgIHBpY2tlckxpc3Q6ICcjcGlja2VyLWxpc3QnLFxufTtcblxuLyoqIOiwg+S4u+i/m+eoi+eahOaWueazleOAguWksei0peS4gOW+i+aUtuaVm+aIkOaKm+e7meiwg+eUqOaWueeahCBQcm9taXNl77yM6Z2i5p2/6Ieq5bexIHRyeS9jYXRjaOOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbDxUID0gYW55PihtZXNzYWdlOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8VD4ge1xuICAgIHJldHVybiAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChFWFRFTlNJT05fTkFNRSwgbWVzc2FnZSwgLi4uYXJncykpIGFzIFQ7XG59XG5cbi8qKiDlu7rlhYPntKDlsI/lt6XlhbfjgIIgKi9cbmZ1bmN0aW9uIGVsPEsgZXh0ZW5kcyBrZXlvZiBIVE1MRWxlbWVudFRhZ05hbWVNYXA+KHRhZzogSywgY2xhc3NOYW1lPzogc3RyaW5nLCB0ZXh0Pzogc3RyaW5nKTogSFRNTEVsZW1lbnRUYWdOYW1lTWFwW0tdIHtcbiAgICBjb25zdCBub2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgIGlmIChjbGFzc05hbWUpIG5vZGUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgIGlmICh0ZXh0ICE9PSB1bmRlZmluZWQpIG5vZGUudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIHJldHVybiBub2RlO1xufVxuXG4vKipcbiAqIOaKiumdouadv+iHquajgOaKpee7meS4u+i/m+eoi++8iOivu+S4jeWIsOS5n+aXoOaJgOiwk++8jOe6r+iviuaWre+8ieOAglxuICpcbiAqIOS4jeS+nei1liBzdGF0Ze+8mmBtb3VudGAg5Y2K6Lev5oqb6ZSZ5pe25a6D5Lmf6IO955So77yI6YKj5pe26L+Y5rKh5pyJIHN0YXRl77yJ44CCXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFByb2JlKHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGVuZGluZyA9IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoRVhURU5TSU9OX05BTUUsIE1TRy5wYW5lbFByb2JlLCB7XG4gICAgICAgICAgICAuLi5wYXlsb2FkLFxuICAgICAgICAgICAgYXQ6IERhdGUubm93KCksXG4gICAgICAgIH0pIGFzIFByb21pc2U8dW5rbm93bj47XG4gICAgICAgIHZvaWQgcGVuZGluZz8uY2F0Y2g/LigoKSA9PiB1bmRlZmluZWQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDor4rmlq3lpLHotKXkuI3orrjlvbHlk43pnaLmnb8gKi9cbiAgICB9XG59XG5cbi8qKiDmj5DnpLrmnaHvvJrmloflrZcgKyDlj6/pgInliqjkvZzmjInpkq7jgILlhYPntKDnvLrlpLHml7blj6ogd2Fybu+8iOe7neS4jeiuqSBVSSDmipvplJnvvInjgIIgKi9cbmZ1bmN0aW9uIHNldEJhbm5lcihcbiAgICBzdGF0ZTogVWlTdGF0ZSxcbiAgICB0ZXh0OiBzdHJpbmcgfCBudWxsLFxuICAgIHRvbmU6ICdlcnJvcicgfCAnaW5mbycgPSAnZXJyb3InLFxuICAgIGFjdGlvbnM6IEFycmF5PHsgbGFiZWw6IHN0cmluZzsgcnVuOiAoKSA9PiB2b2lkIH0+ID0gW10sXG4gICAgLyoqXG4gICAgICog5pyA55+t5YGc55WZ5pe26Ze077yI5q+r56eS77yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjpnIDopoHlroPvvJpgcmVmcmVzaFN0YXRlYCDph4zmnInkuIDlj6XjgIzkuIDliIfmraPluLjlsLHmiormqKrluYXmlLbotbfmnaXjgI3vvIzogIzlroPlnKhcbiAgICAgKiAqKuavj+asoeacieaWsOadoeebruaXtuOAgeS7peWPiuavjyA1IOi3s+i9ruivouaXtioq6YO95Lya6LeR77yI6LeR5Yqo5pe2IDMwMG1zIOS4gOi3s++8ieKAlOKAlCDkuo7mmK9cbiAgICAgKiDjgIzotLTlm77lpLHotKUv5Y+R6YCB5aSx6LSl44CN6L+Z57G7KirnlLHnlKjmiLfliqjkvZzkuqfnlJ8qKueahOaPkOekuuW5s+Wdh+WPquiDvea0u+WHoOeZvuavq+enku+8jFxuICAgICAqIOeUqOaIt+agueacrOivu+S4jeWujO+8iGBzZW5kKClgIOe7k+Wwvui/mOeri+WIuyBgcmVmcmVzaFN0YXRlKClgIOS4gOasoe+8jOetieS6juW9k+WcuuaKueaOie+8ieOAglxuICAgICAqIOWKqOS9nOexu+aPkOekuuS4gOW+i+W4piBgaG9sZE1zYO+8jOeKtuaAgeexu+aPkOekuu+8iHByb2ZpbGUg5ZCM5q2l5aSx6LSl44CBYWdlbnQg5Ye66ZSZ77yJ5LiN55So5bim77yaXG4gICAgICog6YKj5Lqb5pys5p2l5bCx5Lya5Zyo5q+P5LiA6L2u54q25oCB6YeM6KKr6YeN5paw5YaZ5Ye65p2l44CCXG4gICAgICovXG4gICAgaG9sZE1zID0gMCxcbik6IHZvaWQge1xuICAgIGNvbnN0IG5vZGUgPSBzdGF0ZS5iYW5uZXI7XG4gICAgaWYgKCFub2RlKSByZXR1cm47XG4gICAgbm9kZS50ZXh0Q29udGVudCA9ICcnO1xuICAgIGlmICghdGV4dCkge1xuICAgICAgICBub2RlLmhpZGRlbiA9IHRydWU7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3RhdGUuYmFubmVyVW50aWwgPSBEYXRlLm5vdygpICsgTWF0aC5tYXgoMCwgaG9sZE1zKTtcbiAgICBub2RlLmhpZGRlbiA9IGZhbHNlO1xuICAgIG5vZGUuZGF0YXNldC50b25lID0gdG9uZTtcbiAgICBub2RlLmFwcGVuZENoaWxkKGVsKCdkaXYnLCB1bmRlZmluZWQsIHRleHQpKTtcbiAgICBpZiAoYWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IHJvdyA9IGVsKCdkaXYnLCAnZHNoLWJhbm5lci1hY3Rpb25zJyk7XG4gICAgICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIGFjdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsKCdidXR0b24nLCAnZHNoLWJ0bicsIGFjdGlvbi5sYWJlbCk7XG4gICAgICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhY3Rpb24ucnVuKTtcbiAgICAgICAgICAgIHJvdy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgICAgICB9XG4gICAgICAgIG5vZGUuYXBwZW5kQ2hpbGQocm93KTtcbiAgICB9XG59XG5cbi8qKlxuICog5Li76aKY77yaYGF1dG9gIOWFiOeci+iDveS4jeiDveiupOWHuue8lui+keWZqOS4u+mimO+8jOiupOS4jeWHuuWGjei3n+ezu+e7n+OAglxuICpcbiAqIOmdouadv+W+iOWPr+iDvei3keWcqOeLrOeri+aWh+aho+mHjO+8iOi/meS5n+aYryBgZ2V0RWxlbWVudEJ5SWRgIOaLv+S4jeWIsOmdouadv+WFg+e0oOeahOWOn+WboO+8ie+8jFxuICog6YKj5pe2IGBkb2N1bWVudEVsZW1lbnQuY2xhc3NOYW1lYCDmmK/miJHku6zoh6rlt7HnmoTjgIHorqTkuI3lh7rnvJbovpHlmagg4oCU4oCUIOS6juaYr+WbnuiQveezu+e7n+WBj+WlveOAglxuICovXG5mdW5jdGlvbiByZXNvbHZlVGhlbWUobW9kZTogUGFuZWxUaGVtZSk6ICdkYXJrJyB8ICdsaWdodCcge1xuICAgIGlmIChtb2RlID09PSAnZGFyaycgfHwgbW9kZSA9PT0gJ2xpZ2h0JykgcmV0dXJuIG1vZGU7XG4gICAgY29uc3QgaGludCA9IGAke2RvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uY2xhc3NOYW1lID8/ICcnfSAke2RvY3VtZW50LmJvZHk/LmNsYXNzTmFtZSA/PyAnJ30gJHtcbiAgICAgICAgZG9jdW1lbnQuYm9keT8uZGF0YXNldD8udGhlbWUgPz8gJydcbiAgICB9YDtcbiAgICBpZiAoL2RhcmsvaS50ZXN0KGhpbnQpKSByZXR1cm4gJ2RhcmsnO1xuICAgIGlmICgvbGlnaHQvaS50ZXN0KGhpbnQpKSByZXR1cm4gJ2xpZ2h0JztcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gd2luZG93Lm1hdGNoTWVkaWE/LignKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKScpLm1hdGNoZXMgPyAnZGFyaycgOiAnbGlnaHQnO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gJ2RhcmsnO1xuICAgIH1cbn1cblxuLyoqXG4gKiDmiorlpJbop4Lorr7nva7okL3liLDmoLnoioLngrnvvIjkuLvpopggKyDphY3oibIgKyDlrZflj7fvvInjgIJcbiAqXG4gKiBgZGF0YS10aGVtZWAg566hKirmmI7mmpcqKu+8jGBkYXRhLXBhbGV0dGVgIOeuoSoq6YWN6ImyKirvvIjop4EgYHN0YXRpYy9zdHlsZS9kZWZhdWx0L2VkaXRvci10aGVtZS5jc3Ng77yJ77yaXG4gKiDkuKTkuKrnu7TluqbmraPkuqQg4oCU4oCUIOmFjeiJsuWxguaMguWcqCBgW2RhdGEtcGFsZXR0ZT0nZWRpdG9yJ11bZGF0YS10aGVtZT0nZGFyayddYCDkuIrvvIxcbiAqIOaJgOS7peOAjOe8lui+keWZqOmFjeiJsiArIOa1heiJsuOAjeS4jeS8muWRveS4re+8iOe8lui+keWZqOa3seiJsuaJjeaYr+W4uOmpu+W9ouaAge+8ieOAglxuICovXG5mdW5jdGlvbiBhcHBseUFwcGVhcmFuY2Uoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCByb290ID0gc3RhdGUucm9vdDtcbiAgICBpZiAoIXJvb3QpIHJldHVybjtcbiAgICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3M/LnRoZW1lID8/ICdhdXRvJztcbiAgICByb290LmRhdGFzZXQudGhlbWUgPSByZXNvbHZlVGhlbWUobW9kZSk7XG4gICAgcm9vdC5kYXRhc2V0LnBhbGV0dGUgPSBzdGF0ZS5zZXR0aW5ncz8ucGFsZXR0ZSA9PT0gJ2VkaXRvcicgPyAnZWRpdG9yJyA6ICdkc3cnO1xuICAgIGNvbnN0IHNpemUgPSBOdW1iZXIoc3RhdGUuc2V0dGluZ3M/LmZvbnRTaXplID8/IDApO1xuICAgIGlmIChzaXplID49IDEyICYmIHNpemUgPD0gMTcpIHJvb3Quc3R5bGUuc2V0UHJvcGVydHkoJy0tZHNoLWNvbnRlbnQtZm9udC1zaXplJywgYCR7c2l6ZX1weGApO1xuICAgIGVsc2Ugcm9vdC5zdHlsZS5yZW1vdmVQcm9wZXJ0eSgnLS1kc2gtY29udGVudC1mb250LXNpemUnKTtcbn1cblxuLyoqXG4gKiDluIPlsYDoh6rmo4DvvJrpnaLmnb/nmoTpq5jluqbku47lk6rmnaXjgIJcbiAqXG4gKiDogIHniYjmoLflvI/pnaAgYGh0bWwsYm9keXtoZWlnaHQ6MTAwJX1gIOaSkei1t+adpSDigJTigJQg6YKj5p2h6KeE5YiZ5Lya5pS55Yiw57yW6L6R5Zmo6Ieq5bex55qE6aG16Z2i77yMXG4gKiDmiYDku6XmlrDniYjmiorlroPliKDkuobvvIzmlLnmiJDov5nph4zph4/kuIDmrKHvvJpgLmRzaC1yb290YCDpq5jluqbloYzkuobvvIg8IDQwcHjvvInlsLHmjInmg4XlhrXlhZzlupXjgIJcbiAqIOmdouadv+WIsOW6leeLrOWNoOS4gOS4quaWh+aho+i/mOaYr+S4jue8lui+keWZqOWFseeUqO+8jOWQhOeJiOacrOe8lui+keWZqOS4jeS4gOagt++8jOmHj+WHuuadpeeahOe7k+aenOS8muWbnuS8oOe7meS4u+i/m+eoi+OAglxuICovXG5mdW5jdGlvbiBlbnN1cmVMYXlvdXQoc3RhdGU6IFVpU3RhdGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgcm9vdCA9IHN0YXRlLnJvb3Q7XG4gICAgaWYgKCFyb290KSByZXR1cm4geyByb290OiAnbWlzc2luZycgfTtcbiAgICBjb25zdCByZWN0ID0gcm9vdC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBjb25zdCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAga2luZDogJ2xheW91dCcsXG4gICAgICAgIHJvb3RIZWlnaHQ6IE1hdGgucm91bmQocmVjdC5oZWlnaHQpLFxuICAgICAgICByb290V2lkdGg6IE1hdGgucm91bmQocmVjdC53aWR0aCksXG4gICAgICAgIHBhcmVudDogcm9vdC5wYXJlbnRFbGVtZW50Py50YWdOYW1lID8/IG51bGwsXG4gICAgICAgIGh0bWxIZWlnaHQ6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uY2xpZW50SGVpZ2h0ID8/IC0xLFxuICAgICAgICBib2R5SGVpZ2h0OiBkb2N1bWVudC5ib2R5Py5jbGllbnRIZWlnaHQgPz8gLTEsXG4gICAgICAgIGJvZHlDaGlsZHJlbjogZG9jdW1lbnQuYm9keT8uY2hpbGRyZW4/Lmxlbmd0aCA/PyAtMSxcbiAgICAgICAgYm9keU1hcmdpbjogZG9jdW1lbnQuYm9keSA/IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkubWFyZ2luIDogJycsXG4gICAgICAgIHRoZW1lOiByb290LmRhdGFzZXQudGhlbWUsXG4gICAgfTtcbiAgICAvLyDpnaLmnb/ni6zljaDov5nkuKrmlofmoaPvvIhib2R5IOmHjOWPquacieaIkeS7rO+8ieaXtu+8jOa4heaOiSBib2R5IOeahOm7mOiupOWklui+uei3neaYr+WuieWFqOeahFxuICAgIGNvbnN0IG93bnNEb2N1bWVudCA9IEJvb2xlYW4oZG9jdW1lbnQuYm9keSkgJiYgZG9jdW1lbnQuYm9keS5jaGlsZHJlbi5sZW5ndGggPD0gMSAmJiBkb2N1bWVudC5ib2R5LmNvbnRhaW5zKHJvb3QpO1xuICAgIGluZm8ub3duc0RvY3VtZW50ID0gb3duc0RvY3VtZW50O1xuICAgIGlmIChvd25zRG9jdW1lbnQgJiYgZG9jdW1lbnQuYm9keSkge1xuICAgICAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm1hcmdpbiA9ICcwJztcbiAgICAgICAgZG9jdW1lbnQuYm9keS5zdHlsZS5wYWRkaW5nID0gJzAnO1xuICAgICAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc3R5bGUuaGVpZ2h0ID0gJzEwMCUnO1xuICAgICAgICBkb2N1bWVudC5ib2R5LnN0eWxlLmhlaWdodCA9ICcxMDAlJztcbiAgICAgICAgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdyA9ICdoaWRkZW4nO1xuICAgICAgICBjb25zdCBhZnRlciA9IHJvb3QuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgIGluZm8ucm9vdEhlaWdodEFmdGVyUmVzZXQgPSBNYXRoLnJvdW5kKGFmdGVyLmhlaWdodCk7XG4gICAgICAgIGlmIChhZnRlci5oZWlnaHQgPCA0MCkge1xuICAgICAgICAgICAgcm9vdC5zdHlsZS5wb3NpdGlvbiA9ICdhYnNvbHV0ZSc7XG4gICAgICAgICAgICByb290LnN0eWxlLmluc2V0ID0gJzAnO1xuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChyZWN0LmhlaWdodCA8IDQwKSB7XG4gICAgICAgIGluZm8ud2FybmluZyA9ICfpq5jluqbloYzkuobkvYbkuI3mmK/ni6zljaDmlofmoaMg4oCU4oCUIOayoeacieiHquWKqOWFnOW6le+8jOivt+aKiui/meadoeaKpee7meaJqeWxleS9nOiAhSc7XG4gICAgfVxuICAgIHJldHVybiBpbmZvO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOadoeebrua4suafk1xuXG4vKipcbiAqIOeUqOaIt+awlOazoemHjOeahOWbvueJh+eijueJh+OAglxuICpcbiAqICoq5YOP57Sg5LiN6L+b6L2s5YaZKirvvIjop4EgYGNvbnN0YW50cy50c2Ag55qEIGBFbnRyeUltYWdlYCDms6jph4rvvInvvJrov5nph4zlj6rmnInlhYPmlbDmja4g4oCU4oCUIOWbvuWQjeOAgeWwuuWvuOOAgVxuICog5aSn5bCP44CC5Yia5YiaKirnlLHmnKzpnaLmnb/lj5Hlh7rljrsqKueahOmCo+WHoOW8oOS+i+Wklu+8mumCo+aXtueijueJh+S4iueahOe8qeeVpeWbvui/mOWcqOaJi+i+ue+8iGBzZW50VGh1bWJzYO+8ie+8jFxuICog5bCx6aG65omL5pi+56S655yf5Zu+77yM6K6p44CM5oiR5Yia5omN6LS055qE5piv6L+Z5byg44CN5LiA55y86IO956Gu6K6k44CC5Zue5pS+5Y6G5Y+y5pe25pel5b+X6YeM5rKh5pyJ5YOP57Sg77yMXG4gKiBgc2VudFRodW1ic2Ag5Lmf5pep5bey6L2u56m677yM5LqO5piv5Zue6JC95oiQ44CM8J+WvCDlm77lkI3vvIjlsLrlr7jvvInjgI3jgIJcbiAqL1xuZnVuY3Rpb24gcmVuZGVyRW50cnlJbWFnZXMoc3RhdGU6IFVpU3RhdGUsIGltYWdlczogRW50cnlJbWFnZVtdKTogSFRNTEVsZW1lbnQge1xuICAgIGNvbnN0IHdyYXAgPSBlbCgnZGl2JywgJ2RzaC1tc2ctaW1hZ2VzJyk7XG4gICAgZm9yIChjb25zdCBpbWFnZSBvZiBpbWFnZXMpIHtcbiAgICAgICAgY29uc3QgY2hpcCA9IGVsKCdzcGFuJywgJ2RzaC1tc2ctaW1hZ2UnKTtcbiAgICAgICAgY29uc3QgdGh1bWIgPSBpbWFnZS5uYW1lID8gc3RhdGUuc2VudFRodW1icy5nZXQoaW1hZ2UubmFtZSkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0aHVtYikge1xuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGVsKCdpbWcnLCAnZHNoLW1zZy1pbWFnZS10aHVtYicpO1xuICAgICAgICAgICAgbm9kZS5zcmMgPSB0aHVtYjtcbiAgICAgICAgICAgIG5vZGUuYWx0ID0gaW1hZ2UubmFtZSA/PyAnJztcbiAgICAgICAgICAgIGNoaXAuYXBwZW5kQ2hpbGQobm9kZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjaGlwLmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1tc2ctaW1hZ2UtZ2x5cGgnLCAn8J+WvCcpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBkaW1zID0gaW1hZ2Uud2lkdGggJiYgaW1hZ2UuaGVpZ2h0ID8gYCR7aW1hZ2Uud2lkdGh9w5cke2ltYWdlLmhlaWdodH1gIDogJyc7XG4gICAgICAgIGNvbnN0IHNpemUgPSBpbWFnZS5ieXRlcyA/IGZvcm1hdEJ5dGVzKGltYWdlLmJ5dGVzKSA6ICcnO1xuICAgICAgICBjaGlwLmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1tc2ctaW1hZ2UtbmFtZScsIGltYWdlLm5hbWUgfHwgJ+WbvueJhycpKTtcbiAgICAgICAgY29uc3QgbWV0YSA9IFtkaW1zLCBzaXplXS5maWx0ZXIoQm9vbGVhbikuam9pbignIMK3ICcpO1xuICAgICAgICBpZiAobWV0YSkgY2hpcC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtbXNnLWltYWdlLW1ldGEnLCBtZXRhKSk7XG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQoY2hpcCk7XG4gICAgfVxuICAgIHJldHVybiB3cmFwO1xufVxuXG4vKiog5oCd6ICD5Z2X77yI6buY6K6k5oqY5Y+g77yb5rWB5byP6YKj5LiA5Z2X6Ieq5Yqo5bGV5byA77yJ44CCICovZnVuY3Rpb24gcmVuZGVyVGhpbmtpbmcoc3RhdGU6IFVpU3RhdGUsIGhvc3Q6IEhUTUxFbGVtZW50LCBlbnRyeTogRW50cnkpOiB2b2lkIHtcbiAgICBjb25zdCBleHBsaWNpdCA9IHN0YXRlLmNvbGxhcHNlZFRoaW5rLmdldChlbnRyeS5zZXEpO1xuICAgIGNvbnN0IGlzTGl2ZSA9IHN0YXRlLnNuYXBzaG90Py5ydW5uaW5nID09PSB0cnVlICYmIGVudHJ5LnNlcSA9PT0gc3RhdGUubWF4U2VxO1xuICAgIGNvbnN0IGNvbGxhcHNlZCA9IGV4cGxpY2l0ID09PSB1bmRlZmluZWQgPyAhaXNMaXZlIDogZXhwbGljaXQ7XG5cbiAgICBjb25zdCBib3ggPSBlbCgnZGl2JywgJ2RzaC10aGluaycpO1xuICAgIGJveC5kYXRhc2V0LmNvbGxhcHNlZCA9IGNvbGxhcHNlZCA/ICd0cnVlJyA6ICdmYWxzZSc7XG4gICAgY29uc3QgaGVhZCA9IGVsKCdkaXYnLCAnZHNoLXRoaW5rLWhlYWQnKTtcbiAgICBoZWFkLmFwcGVuZChlbCgnc3BhbicsICdkc2gtdGhpbmstY2FyZXQnLCAn4pa4JyksIGVsKCdzcGFuJywgdW5kZWZpbmVkLCBpc0xpdmUgPyAn5oCd6ICD5Lit4oCmJyA6ICfmgJ3ogIPov4fnqIsnKSk7XG4gICAgY29uc3QgYm9keSA9IGVsKCdkaXYnLCAnZHNoLXRoaW5rLWJvZHknLCBlbnRyeS50ZXh0ID8/ICcnKTtcbiAgICBoZWFkLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb25zdCBuZXh0ID0gYm94LmRhdGFzZXQuY29sbGFwc2VkICE9PSAndHJ1ZSc7XG4gICAgICAgIGJveC5kYXRhc2V0LmNvbGxhcHNlZCA9IG5leHQgPyAndHJ1ZScgOiAnZmFsc2UnO1xuICAgICAgICBzdGF0ZS5jb2xsYXBzZWRUaGluay5zZXQoZW50cnkuc2VxLCBuZXh0KTtcbiAgICB9KTtcbiAgICBib3guYXBwZW5kKGhlYWQsIGJvZHkpO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQoYm94KTtcbn1cblxuLyoqIOW3peWFt+WNoeeJh+OAgiAqL1xuZnVuY3Rpb24gcmVuZGVyVG9vbChzdGF0ZTogVWlTdGF0ZSwgaG9zdDogSFRNTEVsZW1lbnQsIGVudHJ5OiBFbnRyeSk6IHZvaWQge1xuICAgIGNvbnN0IGV4cGxpY2l0ID0gc3RhdGUub3BlblRvb2xzLmdldChlbnRyeS5zZXEpO1xuICAgIGNvbnN0IG9wZW4gPSBleHBsaWNpdCA9PT0gdW5kZWZpbmVkID8gZGVmYXVsdE9wZW4oZW50cnkpIDogZXhwbGljaXQ7XG4gICAgY29uc3QgY2FyZCA9IGNyZWF0ZVRvb2xDYXJkKGVudHJ5LCBvcGVuLCAobmV4dCkgPT4gc3RhdGUub3BlblRvb2xzLnNldChlbnRyeS5zZXEsIG5leHQpKTtcbiAgICBob3N0LmFwcGVuZENoaWxkKGNhcmQucm9vdCk7XG59XG5cbi8qKiDmjInmnaHnm67np43nsbvmuLLmn5PlhoXlrrnvvIjlhYPntKDlt7LooqvmuIXnqbrvvInjgIIgKi9cbmZ1bmN0aW9uIHBhaW50RW50cnkoc3RhdGU6IFVpU3RhdGUsIGVsZW1lbnQ6IEhUTUxFbGVtZW50LCBlbnRyeTogRW50cnkpOiB2b2lkIHtcbiAgICBlbGVtZW50LmNsYXNzTmFtZSA9ICcnO1xuICAgIGVsZW1lbnQudGV4dENvbnRlbnQgPSAnJztcbiAgICBzd2l0Y2ggKGVudHJ5LmtpbmQpIHtcbiAgICAgICAgY2FzZSAndXNlcic6IHtcbiAgICAgICAgICAgIGVsZW1lbnQuY2xhc3NOYW1lID0gJ2RzaC1tc2ctdXNlcic7XG4gICAgICAgICAgICAvLyDnuq/lm77niYfmtojmga/msqHmnInmloflrZcg4oCU4oCUIOmCo+WwseWPqueUu+eijueJh++8iOWIq+eVmeS4gOS4quepuuawlOazoe+8iVxuICAgICAgICAgICAgaWYgKGVudHJ5LnRleHQpIGVsZW1lbnQuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtbXNnLXRleHQnLCBlbnRyeS50ZXh0KSk7XG4gICAgICAgICAgICBpZiAoZW50cnkuaW1hZ2VzICYmIGVudHJ5LmltYWdlcy5sZW5ndGggPiAwKSBlbGVtZW50LmFwcGVuZENoaWxkKHJlbmRlckVudHJ5SW1hZ2VzKHN0YXRlLCBlbnRyeS5pbWFnZXMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjYXNlICdhZ2VudCc6IHtcbiAgICAgICAgICAgIGVsZW1lbnQuY2xhc3NOYW1lID0gJ2RzaC1tc2ctYWdlbnQnO1xuICAgICAgICAgICAgY29uc3QgbWQgPSBlbCgnZGl2JywgJ2RzaC1tZCcpO1xuICAgICAgICAgICAgcmVuZGVyTWFya2Rvd24obWQsIGVudHJ5LnRleHQgPz8gKHN0YXRlLnNuYXBzaG90Py5ydW5uaW5nID8gJ+KApicgOiAnJykpO1xuICAgICAgICAgICAgZWxlbWVudC5hcHBlbmRDaGlsZChtZCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAndGhpbmtpbmcnOiB7XG4gICAgICAgICAgICByZW5kZXJUaGlua2luZyhzdGF0ZSwgZWxlbWVudCwgZW50cnkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNhc2UgJ3Rvb2wnOiB7XG4gICAgICAgICAgICByZW5kZXJUb29sKHN0YXRlLCBlbGVtZW50LCBlbnRyeSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAnZXJyb3InOiB7XG4gICAgICAgICAgICBlbGVtZW50LmNsYXNzTmFtZSA9ICdkc2gtZXJyb3InO1xuICAgICAgICAgICAgZWxlbWVudC50ZXh0Q29udGVudCA9IGVudHJ5LnRleHQgPz8gJ+WHuumUmSc7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc05hbWUgPSAnZHNoLW5vdGUnO1xuICAgICAgICAgICAgaWYgKChlbnRyeS50ZXh0ID8/ICcnKS5zdGFydHNXaXRoKCdzdGRlcnI6JykpIGVsZW1lbnQuZGF0YXNldC5raW5kID0gJ3N0ZGVycic7XG4gICAgICAgICAgICBlbGVtZW50LnRleHRDb250ZW50ID0gZW50cnkudGV4dCA/PyAnJztcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqIOepuuaAge+8mummluasoeaJk+W8gOaXtuWRiuivieeUqOaIt+i/meaYr+S7gOS5iOOAgeaAjuS5iOW8gOWni+OAgiAqL1xuZnVuY3Rpb24gcmVuZGVyRW1wdHkoc3RhdGU6IFVpU3RhdGUsIHJlYXNvbjogJ25vLWFnZW50JyB8ICduby1tZXNzYWdlcycpOiB2b2lkIHtcbiAgICBjb25zdCB3cmFwID0gZWwoJ2RpdicsICdkc2gtZW1wdHknKTtcbiAgICBpZiAocmVhc29uID09PSAnbm8tYWdlbnQnKSB7XG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtZW1wdHktdGl0bGUnLCAnRFNIIOi/mOayoeWQr+WKqCcpKTtcbiAgICAgICAgY29uc3QgbGluZXMgPSBlbCgnZGl2JywgJ2RzaC1lbXB0eS1saW5lcycpO1xuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IHN0YXRlLnNuYXBzaG90O1xuICAgICAgICBjb25zdCB0ZXh0ID0gW1xuICAgICAgICAgICAgJ+mdouadv+S8muWcqOe8lui+keWZqOmHjOi3keS4gOS4queLrOeri+eahCBkc2ggcHJvZmlsZe+8iGNvY29z77yJ77ya6IO96K+75bel56iL6YeM55qE5paH5Lu25LiOIHNraWxs77yMJyxcbiAgICAgICAgICAgICflubbpgJrov4cgY29jb3NfZXhlY3V0ZV9jb2RlIOebtOaOpeaTjeS9nOS9oOato+W8gOedgOeahOe8lui+keWZqO+8iOW3peWFt+i1sOi/m+eoi+mXtOmAmumBk++8jOS4jeWNoOerr+WPo++8ieOAgicsXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgICfpppbmrKHlkK/liqjopoHlh6DljYHnp5Ig4oCU4oCUIOimgeWKoOi9veaVtOajtSBEU0gg5o+S5Lu25qCR44CCJyxcbiAgICAgICAgICAgIHNuYXBzaG90ID8gYG5vZGXvvJoke3NuYXBzaG90LnJ1bnRpbWUubm9kZUV4ZSA/PyAn5pyq5om+5YiwJ33vvIgke3NuYXBzaG90LnJ1bnRpbWUubm9kZVNvdXJjZX3vvIlgIDogJycsXG4gICAgICAgICAgICBzbmFwc2hvdCA/IGBkc2gg77yaJHtzbmFwc2hvdC5ydW50aW1lLmRzaEJpbiA/PyAn5pyq5om+5YiwJ33vvIgke3NuYXBzaG90LnJ1bnRpbWUuZHNoU291cmNlfe+8iWAgOiAnJyxcbiAgICAgICAgXVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLmpvaW4oJ1xcbicpO1xuICAgICAgICBsaW5lcy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQobGluZXMpO1xuICAgICAgICBjb25zdCBidXR0b24gPSBlbCgnYnV0dG9uJywgJ2RzaC1zZW5kLXByaW1hcnknLCAn5ZCv5YqoIGFnZW50Jyk7XG4gICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgc3RhcnRBZ2VudChzdGF0ZSkpO1xuICAgICAgICB3cmFwLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgd3JhcC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1lbXB0eS10aXRsZScsICfor7Tngrnku4DkuYjlvIDlp4snKSk7XG4gICAgICAgIGNvbnN0IGxpbmVzID0gZWwoJ2RpdicsICdkc2gtZW1wdHktbGluZXMnKTtcbiAgICAgICAgbGluZXMudGV4dENvbnRlbnQgPSAn5q+U5aaC77ya44CM55yL5LiA55y85b2T5YmN5Zy65pmv77yM5oqKIENhbnZhcyDkuIvnmoToioLngrnliJflh7rmnaXjgI3jgIInO1xuICAgICAgICB3cmFwLmFwcGVuZENoaWxkKGxpbmVzKTtcbiAgICB9XG4gICAgc3RhdGUuYm9keS5hcHBlbmRDaGlsZCh3cmFwKTtcbiAgICBzdGF0ZS5lbXB0eUVsID0gd3JhcDtcbn1cblxuLyoqIOOAjOato+WcqOWbnuWkjeOAjeeahOS4ieS4queCue+8iOWPquWcqOi3keeahOaXtuWAmeaMguWcqOacgOWQju+8ieOAgiAqL1xuZnVuY3Rpb24gc3luY1R5cGluZyhzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IHJ1bm5pbmcgPSBzdGF0ZS5zbmFwc2hvdD8ucnVubmluZyA9PT0gdHJ1ZTtcbiAgICBpZiAoIXJ1bm5pbmcpIHtcbiAgICAgICAgaWYgKHN0YXRlLnR5cGluZ0VsKSB7XG4gICAgICAgICAgICBzdGF0ZS50eXBpbmdFbC5yZW1vdmUoKTtcbiAgICAgICAgICAgIHN0YXRlLnR5cGluZ0VsID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghc3RhdGUudHlwaW5nRWwpIHtcbiAgICAgICAgY29uc3QgZG90cyA9IGVsKCdkaXYnLCAnZHNoLXR5cGluZycpO1xuICAgICAgICBkb3RzLmFwcGVuZChlbCgnc3BhbicpLCBlbCgnc3BhbicpLCBlbCgnc3BhbicpKTtcbiAgICAgICAgc3RhdGUudHlwaW5nRWwgPSBkb3RzO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuYm9keS5sYXN0RWxlbWVudENoaWxkICE9PSBzdGF0ZS50eXBpbmdFbCkgc3RhdGUuYm9keS5hcHBlbmRDaGlsZChzdGF0ZS50eXBpbmdFbCk7XG59XG5cbi8qKiDmtYHlvI/nirbmgIHlj5jkuobkuYvlkI7vvIzph43nrpfjgIzmgJ3ogIPlnZfor6XkuI3or6XlsZXlvIDjgI3vvIjnlKjmiLfmiYvliqjngrnov4fnmoTku6XnlKjmiLfkuLrlh4bvvInjgIIgKi9cbmZ1bmN0aW9uIHN5bmNMaXZlQmxvY2tzKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGF0ZS5lbnRyaWVzLnZhbHVlcygpKSB7XG4gICAgICAgIGlmIChlbnRyeS5raW5kICE9PSAndGhpbmtpbmcnKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHN0YXRlLmNvbGxhcHNlZFRoaW5rLmhhcyhlbnRyeS5zZXEpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZWxlbWVudCA9IHN0YXRlLmVscy5nZXQoZW50cnkuc2VxKTtcbiAgICAgICAgY29uc3QgYm94ID0gZWxlbWVudD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5kc2gtdGhpbmsnKTtcbiAgICAgICAgaWYgKCFib3gpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBpc0xpdmUgPSBzdGF0ZS5zbmFwc2hvdD8ucnVubmluZyA9PT0gdHJ1ZSAmJiBlbnRyeS5zZXEgPT09IHN0YXRlLm1heFNlcTtcbiAgICAgICAgYm94LmRhdGFzZXQuY29sbGFwc2VkID0gaXNMaXZlID8gJ2ZhbHNlJyA6ICd0cnVlJztcbiAgICB9XG59XG5cbi8qKlxuICog5riF56m65a+56K+d5Yy677yI5o2i5Lya6K+dIC8g5Zue5pS+5Y6G5Y+y5pe277yJ44CCXG4gKlxuICog55SxKirkuLvov5vnqIvnmoTovazlhpnku6PmlbAqKumpseWKqO+8iGBnZW5lcmF0aW9uYCDlr7nkuI3kuIrlsLHosIPkuIDmrKHvvInvvIzogIzkuI3mmK/lkIToh6rmjInpkq7ph4zmiYvlhpnkuIDpgY0g4oCU4oCUXG4gKiDov5nmoLfjgIzosIHmuIXnqbrnmoTjgI3lj6rmnInkuIDkuKrnnJ/mupDvvIzkuI3kvJrlh7rnjrDjgIzmjInpkq7muIXkuobjgIHova7or6Llj4jmiorml6fmnaHnm67ngYzlm57mnaXjgI3jgIJcbiAqXG4gKiBAcGFyYW0gZ2VuZXJhdGlvbiAtIOS4u+i/m+eoi+e7meeahOaWsOS7o+aVsO+8iOS4jeS8oOWwseWPqua4hSBET03vvInjgIJcbiAqL1xuZnVuY3Rpb24gcmVzZXRVaShzdGF0ZTogVWlTdGF0ZSwgZ2VuZXJhdGlvbj86IG51bWJlcik6IHZvaWQge1xuICAgIHN0YXRlLmVudHJpZXMuY2xlYXIoKTtcbiAgICBzdGF0ZS5lbHMuY2xlYXIoKTtcbiAgICBzdGF0ZS5vcGVuVG9vbHMuY2xlYXIoKTtcbiAgICBzdGF0ZS5jb2xsYXBzZWRUaGluay5jbGVhcigpO1xuICAgIHN0YXRlLmJvZHkudGV4dENvbnRlbnQgPSAnJztcbiAgICBzdGF0ZS5lbXB0eUVsID0gbnVsbDtcbiAgICBzdGF0ZS50eXBpbmdFbCA9IG51bGw7XG4gICAgLy8g44CM6KaB5rua5Yiw55qE6YKj5LiA5p2h44CN5bGe5LqO5LiK5LiA5Liq5Lya6K+d55qE6L2s5YaZ77ya5Luj5pWw5Y+Y5LqG5bCx562J5LqO5rKh5LqG77yI5ZCm5YiZ5Lya5rua5Yiw5LiA5LiqXG4gICAgLy8g5oGw5aW95aSN55So5LqG5ZCM5LiA5LiqIHNlcSDnmoTml6DlhbPmnaHnm67kuIrvvIlcbiAgICBzdGF0ZS5qdW1wVG8gPSBudWxsO1xuICAgIGlmIChzdGF0ZS5qdW1wVGltZXIpIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHN0YXRlLmp1bXBUaW1lcik7XG4gICAgICAgIHN0YXRlLmp1bXBUaW1lciA9IG51bGw7XG4gICAgfVxuICAgIC8vIG1heFJldiDlvZLpm7bvvJrku6PmlbDlj5jkuobvvIzkuYvliY3pgqPmibnmnaHnm67lnKjkuLvov5vnqIvph4zlt7Lnu4/kuI3lrZjlnKjvvIzph43mi4nkuIDpgY3kuI3kvJrph43lpI1cbiAgICBzdGF0ZS5tYXhSZXYgPSAwO1xuICAgIHN0YXRlLm1heFNlcSA9IDA7XG4gICAgc3RhdGUubGFzdFVzZXJTZXEgPSAwO1xuICAgIC8vIOS6pOS6kuWdl+S4jei3n+edgOS8muivnei1sO+8iOWug+WxnuS6juOAjOaPkuS7tuWcqOetieeahOmCo+S4gOmXruOAje+8jOaNouS8muivneS5n+imgeeVmeedgO+8ie+8jOS9huiusOWPt+imgemHjeeul1xuICAgIHN0YXRlLmludGVyYWN0aW9uU2lnID0gJyc7XG4gICAgcmVuZGVySW50ZXJhY3Rpb25zKHN0YXRlKTtcbiAgICAvLyDmjaLkvJror50gPSDmjaIgYWdlbnQg5LiK5LiL5paH77ya5ZG95Luk6KGo6KaB6YeN5ouJ77yI5ZG95Luk5pivKirmjIkgYWdlbnQqKiDmn6XnmoTvvIzms6jlhozooajmlK/mjIHmjIkgYWdlbnQg6YGu6JS977yJ77yMXG4gICAgLy8gYEBgIOWAmemAieWPluiHqiBhZ2VudCDnmoTlt6XkvZznm67lvZXvvIzlkIznkIbkvZzlup/jgIJcbiAgICBzdGF0ZS5jb21tYW5kcyA9IG51bGw7XG4gICAgc3RhdGUubWVudGlvbkNhY2hlLmNsZWFyKCk7XG4gICAgY2xvc2VQb3B1cChzdGF0ZSk7XG4gICAgaWYgKHR5cGVvZiBnZW5lcmF0aW9uID09PSAnbnVtYmVyJykgc3RhdGUuZ2VuZXJhdGlvbiA9IGdlbmVyYXRpb247XG4gICAgaWYgKHN0YXRlLmVudHJpZXMuc2l6ZSA9PT0gMCkgcmVuZGVyRW1wdHkoc3RhdGUsIHN0YXRlLnNuYXBzaG90Py5zdGF0dXMgPT09ICdyZWFkeScgPyAnbm8tbWVzc2FnZXMnIDogJ25vLWFnZW50Jyk7XG59XG5cbi8qKiDmjIkgc2VxIOWQiOW5tuadoeebru+8iOWQjOS4gCBzZXEg5Y6f5Zyw5pu05paw77yJ44CCICovXG5mdW5jdGlvbiBtZXJnZUVudHJpZXMoc3RhdGU6IFVpU3RhdGUsIGVudHJpZXM6IEVudHJ5W10pOiBib29sZWFuIHtcbiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICBjb25zdCBwcmV2aW91cyA9IHN0YXRlLmVudHJpZXMuZ2V0KGVudHJ5LnNlcSk7XG4gICAgICAgIHN0YXRlLmVudHJpZXMuc2V0KGVudHJ5LnNlcSwgZW50cnkpO1xuICAgICAgICBpZiAoZW50cnkuc2VxID4gc3RhdGUubWF4U2VxKSBzdGF0ZS5tYXhTZXEgPSBlbnRyeS5zZXE7XG4gICAgICAgIGxldCBlbGVtZW50ID0gc3RhdGUuZWxzLmdldChlbnRyeS5zZXEpO1xuICAgICAgICBpZiAoIWVsZW1lbnQpIHtcbiAgICAgICAgICAgIC8vIOaWsOWbnuWQiO+8iOWPiOS4gOadoeeUqOaIt+a2iOaBr++8ieWJjemdouaLieS4gOadoeWIhumalOe6v++8jOWPquWcqOS4jeaYr+esrOS4gOadoeaXtuaLiVxuICAgICAgICAgICAgaWYgKGVudHJ5LmtpbmQgPT09ICd1c2VyJyAmJiBzdGF0ZS5lbHMuc2l6ZSA+IDAgJiYgZW50cnkuc2VxICE9PSBzdGF0ZS5sYXN0VXNlclNlcSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlcCA9IGVsKCdkaXYnLCAnZHNoLXR1cm4tc2VwJyk7XG4gICAgICAgICAgICAgICAgc3RhdGUuYm9keS5hcHBlbmRDaGlsZChzZXApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGVudHJ5LmtpbmQgPT09ICd1c2VyJykgc3RhdGUubGFzdFVzZXJTZXEgPSBlbnRyeS5zZXE7XG4gICAgICAgICAgICBlbGVtZW50ID0gZWwoJ2RpdicpO1xuICAgICAgICAgICAgc3RhdGUuZWxzLnNldChlbnRyeS5zZXEsIGVsZW1lbnQpO1xuICAgICAgICAgICAgc3RhdGUuYm9keS5hcHBlbmRDaGlsZChlbGVtZW50KTtcbiAgICAgICAgICAgIGNoYW5nZWQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKHByZXZpb3VzICYmIHByZXZpb3VzLnJldiA9PT0gZW50cnkucmV2KSB7XG4gICAgICAgICAgICBjb250aW51ZTsgLy8g5rKh5Y+YXG4gICAgICAgIH1cbiAgICAgICAgcGFpbnRFbnRyeShzdGF0ZSwgZWxlbWVudCwgZW50cnkpO1xuICAgICAgICBjaGFuZ2VkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5Zu+54mH6ZmE5Lu2XG5cbi8qKlxuICog5Zu+54mH6L+Z5p2h6ZO+6Lev5ZyoKirpnaLmnb/kvqcqKuimgeWBmueahOS6i++8jOWSjOWug+eahOWbm+adoeWPo+W+hOOAglxuICpcbiAqIDEuICoq5YWI5b2S5LiA5YyW5YaN6L+bIElQQyoq77ya5Ymq6LS05p2/L+W3peeoi+mHjOeahOWbvuWPr+iDveaYr+S7u+aEj+WwuuWvuOOAgeS7u+aEj+agvOW8j++8iEJNUC/miKrlsY/lt6Xlhbfkuqflh7rnmoQgVElGRuKApu+8ie+8jFxuICogICAg6ICMIERTSCDpmYTku7blupPlj6rmlLYgcG5nL2pwZWcvd2VicC9naWYg5Zub56eN44CB5LiU5Lya5ou/5a2X6IqC6aqM5LiA6YGN5aOw5piO55qEIE1JTUXjgILmiYDku6XpnaLmnb/lhYhcbiAqICAgIOOAjOino+eggSDihpIg5oyJ6aKE566X57yp5pS+IOKGkiDnvJbnoIHmiJDnmb3lkI3ljZXph4znmoTkuIDnp40g4oaSIOinhOiMgyBiYXNlNjTjgI3jgILov5nkuZ/pobrmiYvmioogSVBDIOS4iueahOS9k+enr1xuICogICAg5LuO44CMNEsg5oiq5Zu+55qE5Y2B5YegIE1C44CN5Y6L5Yiw5YegIE1CIOS7peWGhe+8iOWDj+e0oOmihOeul+S4jue8lueggemihOeul+mDveeFp+mZhOS7tuW6k+eahOWPo+W+hOadpe+8jOingSBgSU1BR0VfQlVER0VUYO+8ieOAglxuICogMi4gKirnvKnnlaXlm77mmK/pnaLmnb/oh6rlt7HnlLvnmoQqKu+8mmA8aW1nIHNyYz1cImRhdGE6Li4uXCI+YCDkuIDlvKAgMTI4cHgg55qEIFBORyDlj6rmnInlh6AgS0LvvIxcbiAqICAgIOiAjOWOn+WbvuimgeWHoCBNQiDigJTigJQg6L6T5YWl5Yy655qE56KO54mH5ZKM6YCJ5oup5Zmo55qE5qC85a2Q6YO95Y+q55yL57yp55Wl5Zu+77yI5Y6f5Zu+5Y+q55WZ5ZyoIGBkYXRhYCDph4znrYnnnYDlj5HvvInjgIJcbiAqIDMuICoq5Y+R6YCB5YmN5LiN6JC955uY44CB5LiN5YaZ6I2J56i/KirvvJrlm77niYflj6rlnKjlhoXlrZjph4zvvIzpnaLmnb/lhbPmjonljbPkuKLvvIjojYnnqL/lj6rlrZjmloflrZfvvInjgIJcbiAqICAgIOeQhueUse+8mmxvY2FsU3RvcmFnZSDmnIkgNU1CIOmFjemine+8jOS4gOW8oOWbvuWwseiDveaKiuWug+aSkeeIhu+8jOiAjOOAjOmFjemineeIhuS6huOAjeeahOihqOeOsOaYr1xuICogICAgKirmlbTkuKrojYnnqL/lip/og73pnZnpu5jlpLHmlYgqKu+8iOi/nuW4puaWh+Wtl+S4gOi1t+S4ou+8ie+8jOi/meS4quS7o+S7t+aNouS4jeadpeOAjOiusOS9j+S4iuasoei0tOeahOWbvuOAjeOAglxuICogNC4gKirlpLHotKXopoHor7Tkurror50qKu+8muivu+S4jeWIsC/lpKrlpKcv5qC85byP5LiN6K6k77yM5LiA5b6L5Y+Y5oiQ6L6T5YWl5Yy65LiK5pa55qiq5bmF6YeM55qE5LiA5Y+l5Lit5paH77yMXG4gKiAgICDnu53kuI3pnZnpu5jkuKLlm77vvIjpnZnpu5jkuKLlm77nmoTooajnjrDmmK/jgIzmiJHotLTkuobkvYblroPmsqHlj5Hlh7rljrvjgI3vvIzmnIDpmr7mn6XvvInjgIJcbiAqL1xubGV0IGF0dGFjaFNlcSA9IDA7XG5cbi8qKiDnmb3lkI3ljZUgTUlNRSDpm4blkIjvvIjku44gYElNQUdFX01JTUVfQllfRVhUYCDmjqjvvIzliKvmiYvmioTnrKzkuozku73vvInjgIIgKi9cbmNvbnN0IEFDQ0VQVEVEX01JTUUgPSBuZXcgU2V0PHN0cmluZz4oT2JqZWN0LnZhbHVlcyhJTUFHRV9NSU1FX0JZX0VYVCkpO1xuXG4vKiogTUlNRSDihpIg5omp5bGV5ZCN77yI5ou85pi+56S65ZCN55So77yJ44CCICovXG5mdW5jdGlvbiBleHRPZk1pbWUobWltZVR5cGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKG1pbWVUeXBlID09PSAnaW1hZ2UvanBlZycpIHJldHVybiAnanBnJztcbiAgICByZXR1cm4gbWltZVR5cGUucmVwbGFjZSgvXmltYWdlXFwvLywgJycpIHx8ICdwbmcnO1xufVxuXG4vKipcbiAqIOaYvuekuuWQjeS/neivgeW4pioq5q2j56GuKirnmoTmianlsZXlkI3jgIJcbiAqXG4gKiDkuKTku7bkuovpg73opoHlgZrvvJrmsqHmnInmianlsZXlkI3lsLHooaXvvIjliarotLTmnb/mnaXnmoTlm77msqHmnInlkI3lrZfvvInvvIzmianlsZXlkI3kuI3lr7nlsLEqKuaNouaOiSoqIOKAlOKAlFxuICog5Y+q55yL44CM5pyJ5rKh5pyJ5omp5bGV5ZCN44CN5Lya5b6X5YiwIGBzY3JlZW5zaG90LmJtcC5wbmdgIOi/meenjeWQjeWtl++8iGJtcCDkuI3lnKjnmb3lkI3ljZXph4zvvIxcbiAqIOS9huWOi+e8qeS6p+eJqeaYryBQTkfvvInvvIzlj5Hlh7rljrvkuYvlkI7oh6rlt7HkuZ/nnIvkuI3lh7rliLDlupXlrZjnmoTmmK/lk6rnp43moLzlvI/jgIJcbiAqL1xuZnVuY3Rpb24gd2l0aEV4dChuYW1lOiBzdHJpbmcsIG1pbWVUeXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHdhbnRlZCA9IGAuJHtleHRPZk1pbWUobWltZVR5cGUpfWA7XG4gICAgY29uc3QgdHJpbW1lZCA9IChuYW1lLnRyaW0oKSB8fCAn5Zu+54mHJykucmVwbGFjZSgvW1xcXFwvOio/XCI8PnxdKy9nLCAnXycpO1xuICAgIGlmICh0cmltbWVkLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgod2FudGVkKSkgcmV0dXJuIHRyaW1tZWQ7XG4gICAgY29uc3Qgd2l0aG91dE9sZEV4dCA9IHRyaW1tZWQucmVwbGFjZSgvXFwuW2EtejAtOV17MSw1fSQvaSwgJycpO1xuICAgIHJldHVybiBgJHt3aXRob3V0T2xkRXh0IHx8ICflm77niYcnfSR7d2FudGVkfWA7XG59XG5cbi8qKiBiYXNlNjQg4oaSIOWtl+iKguaVsO+8iOmdouadv+mHjOWPquS4uuaYvuekuu+8jOS4jeW8lSBCdWZmZXLvvInjgIIgKi9cbmZ1bmN0aW9uIGJhc2U2NEJ5dGVzKGRhdGE6IHN0cmluZyk6IG51bWJlciB7XG4gICAgY29uc3QgcGFkZGluZyA9IGRhdGEuZW5kc1dpdGgoJz09JykgPyAyIDogZGF0YS5lbmRzV2l0aCgnPScpID8gMSA6IDA7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKGRhdGEubGVuZ3RoICogMykgLyA0KSAtIHBhZGRpbmcpO1xufVxuXG4vKipcbiAqIOaMiemihOeul+eul+ebruagh+WwuuWvuCDigJTigJQgKirkuI4gRFNIIOmZhOS7tuW6k+eahCBgcmVxdWVzdEltYWdlRGltZW5zaW9uc2Ag5ZCM5LiA5aWX566X5rOVKirjgIJcbiAqXG4gKiDnrpfms5XkuIDoh7TnmoTmhI/kuYnvvJrpnaLmnb/nrpflh7rmnaXnmoTlsLrlr7jlsLHmmK/pmYTku7blupMqKuacrOadpeS5n+S8mue8qeWIsCoq55qE5bC65a+477yM5omA5Lul6L+Z5LiA5q2l5LiN5byV5YWlXG4gKiDku7vkvZXpop3lpJbmjZ/lpLHvvIzlj6rmmK/miorjgIzljYHlh6AgTUIg55qE5Y6f5Zu+44CN5o+Q5YmN5o2i5o6J44CCKirlj6rnvKnkuI3mlL4qKu+8iOWwj+WbvuS4jeWKqO+8ieOAglxuICpcbiAqIEBwYXJhbSB3aWR0aCAtIOWOn+Wni+WuveOAglxuICogQHBhcmFtIGhlaWdodCAtIOWOn+Wni+mrmOOAglxuICogQHJldHVybnMg55uu5qCH5bC65a+477yI5pW05pWw77yM6Iez5bCRIDHvvInjgIJcbiAqL1xuZnVuY3Rpb24gZml0V2l0aGluKHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgc2NhbGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IHsgbWF4UGl4ZWxzLCBtYXhTaWRlIH0gPSBJTUFHRV9CVURHRVQ7XG4gICAgbGV0IHNjYWxlID0gTWF0aC5taW4oMSwgTWF0aC5zcXJ0KG1heFBpeGVscyAvICh3aWR0aCAqIGhlaWdodCkpKTtcbiAgICBpZiAoTWF0aC5tYXgod2lkdGgsIGhlaWdodCkgKiBzY2FsZSA+IG1heFNpZGUpIHNjYWxlID0gbWF4U2lkZSAvIE1hdGgubWF4KHdpZHRoLCBoZWlnaHQpO1xuICAgIGlmIChzY2FsZSA+PSAxKSByZXR1cm4geyB3aWR0aCwgaGVpZ2h0LCBzY2FsZWQ6IGZhbHNlIH07XG4gICAgbGV0IHByb2plY3RlZFdpZHRoID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZCh3aWR0aCAqIHNjYWxlKSk7XG4gICAgbGV0IHByb2plY3RlZEhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoaGVpZ2h0ICogc2NhbGUpKTtcbiAgICB3aGlsZSAocHJvamVjdGVkV2lkdGggKiBwcm9qZWN0ZWRIZWlnaHQgPiBtYXhQaXhlbHMgJiYgcHJvamVjdGVkV2lkdGggPiAxKSB7XG4gICAgICAgIHByb2plY3RlZFdpZHRoIC09IDE7XG4gICAgICAgIHByb2plY3RlZEhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKHByb2plY3RlZFdpZHRoICogaGVpZ2h0KSAvIHdpZHRoKSk7XG4gICAgfVxuICAgIHJldHVybiB7IHdpZHRoOiBwcm9qZWN0ZWRXaWR0aCwgaGVpZ2h0OiBwcm9qZWN0ZWRIZWlnaHQsIHNjYWxlZDogdHJ1ZSB9O1xufVxuXG4vKiog6Kej56CB5ZCO55qE5Zu+77yIYEltYWdlQml0bWFwYCDkuI4gYDxpbWc+YCDpg73og70gYGRyYXdJbWFnZWDvvIzmiYDku6Xnu5/kuIDmiJDov5nkuKrlvaLnirbvvInjgIIgKi9cbmludGVyZmFjZSBEZWNvZGVkSW1hZ2Uge1xuICAgIHNvdXJjZTogQ2FudmFzSW1hZ2VTb3VyY2U7XG4gICAgd2lkdGg6IG51bWJlcjtcbiAgICBoZWlnaHQ6IG51bWJlcjtcbiAgICByZWxlYXNlOiAoKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIOino+eggeS4gOauteWbvueJh+Wtl+iKguOAglxuICpcbiAqIOS4pOadoei3r++8mmBjcmVhdGVJbWFnZUJpdG1hcGDvvIjlv6vjgIHlvILmraXjgIHog73nm7TmjqXlho3nvJbnoIHvvInkuI4gYDxpbWc+YCArIG9iamVjdCBVUkzvvIjlhZzlupXvvInjgIJcbiAqIOWQjuiAheW/hemhuyBgcmV2b2tlT2JqZWN0VVJMYO+8jOWQpuWImeavj+i0tOS4gOW8oOWbvuWwsea8j+S4gOS4qiBibG9i44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlY29kZUJsb2IoYmxvYjogQmxvYik6IFByb21pc2U8RGVjb2RlZEltYWdlPiB7XG4gICAgaWYgKHR5cGVvZiBjcmVhdGVJbWFnZUJpdG1hcCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgYml0bWFwID0gYXdhaXQgY3JlYXRlSW1hZ2VCaXRtYXAoYmxvYik7XG4gICAgICAgICAgICByZXR1cm4geyBzb3VyY2U6IGJpdG1hcCwgd2lkdGg6IGJpdG1hcC53aWR0aCwgaGVpZ2h0OiBiaXRtYXAuaGVpZ2h0LCByZWxlYXNlOiAoKSA9PiBiaXRtYXAuY2xvc2U/LigpIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog6Kej56CB5aSx6LSlL+S4jeaUr+aMge+8muiQveWIsCA8aW1nPiDpgqPmnaHot6/vvIzorqnlroPnu5nlh7rmm7TmuIXmpZrnmoTplJnor68gKi9cbiAgICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpO1xuICAgIGNvbnN0IGltYWdlID0gbmV3IEltYWdlKCk7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xuICAgICAgICAgICAgaW1hZ2Uub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ+i/meS4quaWh+S7tuS4jeaYr+iDveino+eggeeahOWbvueJhycpKTtcbiAgICAgICAgICAgIGltYWdlLnNyYyA9IHVybDtcbiAgICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gICAgcmV0dXJuIHsgc291cmNlOiBpbWFnZSwgd2lkdGg6IGltYWdlLm5hdHVyYWxXaWR0aCwgaGVpZ2h0OiBpbWFnZS5uYXR1cmFsSGVpZ2h0LCByZWxlYXNlOiAoKSA9PiBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCkgfTtcbn1cblxuLyoqIOaKiuino+eggee7k+aenOeUu+WIsCBjYW52YXPvvIhgZmlsbFdoaXRlYCDnlKjkuo7opoHovawgSlBFRyDnmoTlnLrlkIjvvJrpgI/mmI7ljLrlnKggSlBFRyDph4zkvJrlj5jpu5HvvInjgIIgKi9cbmZ1bmN0aW9uIGRyYXdUbyhkZWNvZGVkOiBEZWNvZGVkSW1hZ2UsIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyLCBmaWxsV2hpdGUgPSBmYWxzZSk6IEhUTUxDYW52YXNFbGVtZW50IHtcbiAgICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICBjYW52YXMud2lkdGggPSB3aWR0aDtcbiAgICBjYW52YXMuaGVpZ2h0ID0gaGVpZ2h0O1xuICAgIGNvbnN0IGNvbnRleHQgPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKTtcbiAgICBpZiAoIWNvbnRleHQpIHRocm93IG5ldyBFcnJvcign5ou/5LiN5YiwIGNhbnZhcyAyZCDkuIrkuIvmlocnKTtcbiAgICBpZiAoZmlsbFdoaXRlKSB7XG4gICAgICAgIGNvbnRleHQuZmlsbFN0eWxlID0gJyNmZmZmZmYnO1xuICAgICAgICBjb250ZXh0LmZpbGxSZWN0KDAsIDAsIHdpZHRoLCBoZWlnaHQpO1xuICAgIH1cbiAgICBjb250ZXh0LmRyYXdJbWFnZShkZWNvZGVkLnNvdXJjZSwgMCwgMCwgd2lkdGgsIGhlaWdodCk7XG4gICAgcmV0dXJuIGNhbnZhcztcbn1cblxuLyoqIGNhbnZhcyDihpIgSlBFR++8iOi0qOmHj+air+WtkO+8jOWPluesrOS4gOS4qui/m+mihOeul+eahO+8m+mDveS4jeihjOWwseWPluacgOWwj+eahOmCo+S4qu+8ieOAgiAqL1xuZnVuY3Rpb24gZW5jb2RlSnBlZyhjYW52YXM6IEhUTUxDYW52YXNFbGVtZW50KTogeyBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTsgZGF0YVVybDogc3RyaW5nIH0ge1xuICAgIGxldCBiZXN0OiB7IG1pbWVUeXBlOiBJbWFnZU1pbWVUeXBlOyBkYXRhVXJsOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcXVhbGl0eSBvZiBKUEVHX0xBRERFUikge1xuICAgICAgICBjb25zdCBkYXRhVXJsID0gY2FudmFzLnRvRGF0YVVSTCgnaW1hZ2UvanBlZycsIHF1YWxpdHkpO1xuICAgICAgICBjb25zdCBieXRlcyA9IGJhc2U2NEJ5dGVzKGRhdGFVcmwuc2xpY2UoZGF0YVVybC5pbmRleE9mKCcsJykgKyAxKSk7XG4gICAgICAgIGlmICghYmVzdCB8fCBieXRlcyA8IGJlc3QuYnl0ZXMpIGJlc3QgPSB7IG1pbWVUeXBlOiAnaW1hZ2UvanBlZycsIGRhdGFVcmwsIGJ5dGVzIH07XG4gICAgICAgIGlmIChieXRlcyA8PSBJTUFHRV9CVURHRVQubm9ybWFsaXplZE1heEJ5dGVzKSBicmVhaztcbiAgICB9XG4gICAgaWYgKCFiZXN0KSB0aHJvdyBuZXcgRXJyb3IoJ0pQRUcg57yW56CB5aSx6LSlJyk7XG4gICAgcmV0dXJuIHsgbWltZVR5cGU6IGJlc3QubWltZVR5cGUsIGRhdGFVcmw6IGJlc3QuZGF0YVVybCB9O1xufVxuXG4vKipcbiAqIGNhbnZhcyDihpIgd2VicO+8iOi0qOmHj+air+WtkO+8ieOAglxuICpcbiAqIOKaoCAqKuW/hemhu+mqjOS4gOS4i+WbnuadpeeahOaYr+S4jeaYr+ecnyB3ZWJwKirvvJrmtY/op4jlmajkuI3mlK/mjIHmn5Dnp43nvJbnoIHml7bvvIxgdG9EYXRhVVJMYCDkvJoqKumdmem7mOWbnuiQveaIkCBQTkcqKlxuICog77yI5LiN5oql6ZSZ77yJ44CC6Iul5LiN6aqM77yM5oiR5Lus5Lya5oqKIFBORyDnmoTlrZfoioLlvZPmiJAgYGltYWdlL3dlYnBgIOWjsOaYjuWHuuWOuyDigJTigJQg6ZmE5Lu25bqT5Lya5ou/5a2X6IqC6aqM57G75Z6L77yMXG4gKiDkuo7mmK/miqXkuIDkuKrlvojpmr7mh4LnmoTplJnjgIJcbiAqXG4gKiBAcmV0dXJucyB3ZWJwIOeahCBkYXRhIFVSTO+8m+a1j+iniOWZqOS4jeaUr+aMgee8lueggSB3ZWJwIOaXtui/lOWbniBudWxs44CCXG4gKi9cbmZ1bmN0aW9uIGVuY29kZVdlYnAoY2FudmFzOiBIVE1MQ2FudmFzRWxlbWVudCk6IHsgbWltZVR5cGU6IEltYWdlTWltZVR5cGU7IGRhdGFVcmw6IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgbGV0IGJlc3Q6IHsgbWltZVR5cGU6IEltYWdlTWltZVR5cGU7IGRhdGFVcmw6IHN0cmluZzsgYnl0ZXM6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBxdWFsaXR5IG9mIEpQRUdfTEFEREVSKSB7XG4gICAgICAgIGNvbnN0IGRhdGFVcmwgPSBjYW52YXMudG9EYXRhVVJMKCdpbWFnZS93ZWJwJywgcXVhbGl0eSk7XG4gICAgICAgIGlmICghZGF0YVVybC5zdGFydHNXaXRoKCdkYXRhOmltYWdlL3dlYnAnKSkgcmV0dXJuIG51bGw7XG4gICAgICAgIGNvbnN0IGJ5dGVzID0gYmFzZTY0Qnl0ZXMoZGF0YVVybC5zbGljZShkYXRhVXJsLmluZGV4T2YoJywnKSArIDEpKTtcbiAgICAgICAgaWYgKCFiZXN0IHx8IGJ5dGVzIDwgYmVzdC5ieXRlcykgYmVzdCA9IHsgbWltZVR5cGU6ICdpbWFnZS93ZWJwJywgZGF0YVVybCwgYnl0ZXMgfTtcbiAgICAgICAgaWYgKGJ5dGVzIDw9IElNQUdFX0JVREdFVC5ub3JtYWxpemVkTWF4Qnl0ZXMpIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gYmVzdCA/IHsgbWltZVR5cGU6IGJlc3QubWltZVR5cGUsIGRhdGFVcmw6IGJlc3QuZGF0YVVybCB9IDogbnVsbDtcbn1cblxuLyoqXG4gKiBjYW52YXMg4oaSIOeZveWQjeWNlemHjOeahOS4gOenjee8luegge+8jOW5tuS4lCoq5Y6L6L+b5b2S5LiA5YyW6aKE566XKirjgIJcbiAqXG4gKiDpobrluo/mmK/nhacgRFNIIOmZhOS7tuW6k+iHquW3seeahOair+WtkOadpeeahO+8iGBbXCJhbHBoYTp3ZWJwXCIsIFwib3BhcXVlOmpwZWdcIl1g77yJ77yaXG4gKiAqKlBORyDihpIgd2VicCDihpIgSlBFRyoq44CC55CG55Sx77yaUE5HIOS/neecn+S9huWOi+S4jeWKqO+8jOS4gOW8oCA0SyDmiKrlm77og73liLDljYHlh6AgTULvvIzogIzpmYTku7blupPpgqPovrlcbiAqIOi2hemihOeul+eFp+agt+S8mumHjeWOi+S4gOmBje+8iGBub3JtYWxpemVkSW1hZ2VNYXhCeXRlc2AgNE1C77yJ4oCU4oCUIOS4juWFtuiuqeWNgeWHoCBNQiDnmoQgYmFzZTY0XG4gKiDotbDkuIDotp8gSVBDIOWGjeiiq+WOi+aOie+8jOS4jeWmguWcqOmdouadv+mHjOWwseWOi+WlveOAgndlYnAg5ZyoKirmnInpgI/mmI7pgJrpgZMqKuaXtuaYjuaYvuS8mOS6jiBKUEVHXG4gKiDvvIhKUEVHIOS8muaKiumAj+aYjuWMuueUu+aIkOm7keWdl++8ie+8jOaJgOS7peWug+aOkuWcqCBKUEVHIOWJjemdou+8m0pQRUcg6YKj5LiA5qGj6KaB5YWI6ZO655m95bqV44CCXG4gKlxuICogQHBhcmFtIGNhbnZhcyAtIOW3sue7j+eUu+Wlveebruagh+WwuuWvuOeahOeUu+W4g+OAglxuICogQHJldHVybnMg57yW56CB57uT5p6c5LiO5LiA5Y+l44CM5YGa5LqG5LuA5LmI44CN55qE6K+05piO77yIYG5vdGVg77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGVuY29kZUNhbnZhcyhjYW52YXM6IEhUTUxDYW52YXNFbGVtZW50KTogeyBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTsgZGF0YVVybDogc3RyaW5nOyBub3RlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IHBuZyA9IGNhbnZhcy50b0RhdGFVUkwoJ2ltYWdlL3BuZycpO1xuICAgIGlmIChiYXNlNjRCeXRlcyhwbmcuc2xpY2UocG5nLmluZGV4T2YoJywnKSArIDEpKSA8PSBJTUFHRV9CVURHRVQubm9ybWFsaXplZE1heEJ5dGVzKSB7XG4gICAgICAgIHJldHVybiB7IG1pbWVUeXBlOiAnaW1hZ2UvcG5nJywgZGF0YVVybDogcG5nIH07XG4gICAgfVxuICAgIGNvbnN0IHdlYnAgPSBlbmNvZGVXZWJwKGNhbnZhcyk7XG4gICAgaWYgKHdlYnAgJiYgYmFzZTY0Qnl0ZXMod2VicC5kYXRhVXJsLnNsaWNlKHdlYnAuZGF0YVVybC5pbmRleE9mKCcsJykgKyAxKSkgPD0gSU1BR0VfQlVER0VULm5vcm1hbGl6ZWRNYXhCeXRlcykge1xuICAgICAgICByZXR1cm4geyAuLi53ZWJwLCBub3RlOiAnUE5HIOWOi+S4jei/m+mihOeulyDihpIgd2VicCcgfTtcbiAgICB9XG4gICAgLy8g6ZO655m95bqV5YaN57yWIEpQRUfvvJrpgI/mmI7ljLrlnKggSlBFRyDph4zmmK/pu5HnmoTvvIznm7TmjqXnvJbkvJrlvpfliLDkuIDlvKDjgIzpu5HlupXlm77jgI1cbiAgICBjb25zdCBmbGF0dGVuZWQgPSBkcmF3VG8oeyBzb3VyY2U6IGNhbnZhcywgd2lkdGg6IGNhbnZhcy53aWR0aCwgaGVpZ2h0OiBjYW52YXMuaGVpZ2h0LCByZWxlYXNlOiAoKSA9PiB1bmRlZmluZWQgfSwgY2FudmFzLndpZHRoLCBjYW52YXMuaGVpZ2h0LCB0cnVlKTtcbiAgICBjb25zdCBqcGVnID0gZW5jb2RlSnBlZyhmbGF0dGVuZWQpO1xuICAgIGlmIChiYXNlNjRCeXRlcyhqcGVnLmRhdGFVcmwuc2xpY2UoanBlZy5kYXRhVXJsLmluZGV4T2YoJywnKSArIDEpKSA8PSBJTUFHRV9CVURHRVQubm9ybWFsaXplZE1heEJ5dGVzKSB7XG4gICAgICAgIHJldHVybiB7IC4uLmpwZWcsIG5vdGU6ICdQTkcg5Y6L5LiN6L+b6aKE566XIOKGkiBKUEVHJyB9O1xuICAgIH1cbiAgICAvLyDov57otKjph4/moq/lrZDpg73ljovkuI3ov5vvvIjmnoHnq6/lpKflm77vvInvvJrkuqTlm57nu5npmYTku7blupPvvIzorqnlroPmjInoh6rlt7HnmoTnrZbnlaXlpITnkIZcbiAgICByZXR1cm4geyAuLi5qcGVnLCBub3RlOiAn5Y6L5LiN6L+b6aKE566X77yM5Lqk57uZ6ZmE5Lu25bqT5b2S5LiA5YyWJyB9O1xufVxuXG4vKiog57yp55Wl5Zu+77ya4omkMTI4cHgg55qEIFBORyBkYXRhIFVSTO+8iOWHoCBLQu+8jOmaj+S+v+Whnui/myBET03vvInjgIIgKi9cbmZ1bmN0aW9uIG1ha2VUaHVtYihkZWNvZGVkOiBEZWNvZGVkSW1hZ2UpOiBzdHJpbmcge1xuICAgIGNvbnN0IHNpZGUgPSBJTUFHRV9CVURHRVQudGh1bWJTaWRlO1xuICAgIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgc2lkZSAvIE1hdGgubWF4KGRlY29kZWQud2lkdGgsIGRlY29kZWQuaGVpZ2h0KSk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGRlY29kZWQud2lkdGggKiBzY2FsZSkpO1xuICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoZGVjb2RlZC5oZWlnaHQgKiBzY2FsZSkpO1xuICAgIHJldHVybiBkcmF3VG8oZGVjb2RlZCwgd2lkdGgsIGhlaWdodCkudG9EYXRhVVJMKCdpbWFnZS9wbmcnKTtcbn1cblxuLyoqIEJsb2Ig4oaSIOinhOiMgyBiYXNlNjTvvIhgcmVhZEFzRGF0YVVSTGAg57uZ55qE5q2j5piv6KeE6IyD5b2i5byP77yM5Y675YmN57yA5Y2z5Y+v77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBibG9iVG9CYXNlNjQoYmxvYjogQmxvYik6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgZGF0YVVybCA9IGF3YWl0IG5ldyBQcm9taXNlPHN0cmluZz4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpO1xuICAgICAgICByZWFkZXIub25sb2FkID0gKCkgPT4gcmVzb2x2ZShTdHJpbmcocmVhZGVyLnJlc3VsdCA/PyAnJykpO1xuICAgICAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ+ivu+S4jeWHuui/meW8oOWbvueahOaVsOaNricpKTtcbiAgICAgICAgcmVhZGVyLnJlYWRBc0RhdGFVUkwoYmxvYik7XG4gICAgfSk7XG4gICAgY29uc3QgY29tbWEgPSBkYXRhVXJsLmluZGV4T2YoJywnKTtcbiAgICBpZiAoY29tbWEgPCAwKSB0aHJvdyBuZXcgRXJyb3IoJ+i/meW8oOWbvueahOaVsOaNruS4jeaYryBkYXRhIFVSTCcpO1xuICAgIHJldHVybiBkYXRhVXJsLnNsaWNlKGNvbW1hICsgMSk7XG59XG5cbi8qKlxuICog5b2S5LiA5YyW5LiA5byg5Zu+IOKGkiDlj6/nm7TmjqXlj5HpgIHnmoQgYEF0dGFjaG1lbnRg44CCXG4gKlxuICogQHBhcmFtIGJsb2IgLSDlm77niYflrZfoioLvvIjliarotLTmnb8v5bel56iL6K+75Y+WL+aLluaLveS4ieS4quadpea6kOmDveaYr+Wug++8ieOAglxuICogQHBhcmFtIG5hbWUgLSDmmL7npLrlkI3vvIjlj6/ku6XmsqHmnInmianlsZXlkI3vvInjgIJcbiAqIEBwYXJhbSBvcmlnaW4gLSDmnaXmupDvvIzlj6rnlKjkuo7mmL7npLrkuI7mjpLmn6XjgIJcbiAqIEByZXR1cm5zIOmZhOS7tu+8jOaIluS4gOWPpeS6uuivneeahOWksei0peWOn+WboOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBidWlsZEF0dGFjaG1lbnQoXG4gICAgYmxvYjogQmxvYixcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgb3JpZ2luOiBBdHRhY2htZW50WydvcmlnaW4nXSxcbik6IFByb21pc2U8eyBhdHRhY2htZW50OiBBdHRhY2htZW50IH0gfCB7IGVycm9yOiBzdHJpbmcgfT4ge1xuICAgIGlmIChibG9iLnNpemUgPiBNQVhfSU1BR0VfQllURVMpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGAke25hbWV95pyJICR7Zm9ybWF0Qnl0ZXMoYmxvYi5zaXplKX3vvIzotoXov4fljZXlvKDkuIrpmZAgJHtmb3JtYXRCeXRlcyhNQVhfSU1BR0VfQllURVMpfe+8iOmZhOS7tuW6k+aYr+aLkuaUtuiAjOS4jeaYr+WOi+e8qe+8ieOAgmAgfTtcbiAgICB9XG4gICAgbGV0IGRlY29kZWQ6IERlY29kZWRJbWFnZTtcbiAgICB0cnkge1xuICAgICAgICBkZWNvZGVkID0gYXdhaXQgZGVjb2RlQmxvYihibG9iKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBlcnJvcjogYCR7bmFtZX0g6Kej5LiN5byA77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCB9O1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAoIWRlY29kZWQud2lkdGggfHwgIWRlY29kZWQuaGVpZ2h0KSByZXR1cm4geyBlcnJvcjogYCR7bmFtZX0g55qE5YOP57Sg5bC65a+45pivIDDvvIzor7vkuI3lh7rlhoXlrrnjgIJgIH07XG5cbiAgICAgICAgY29uc3Qgc291cmNlTWltZSA9IChibG9iLnR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGZpdFdpdGhpbihkZWNvZGVkLndpZHRoLCBkZWNvZGVkLmhlaWdodCk7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDlv6vot6/vvIjljp/moLflj5HvvInnmoTkuInkuKrmnaHku7bvvIznvLrkuIDkuI3lj6/vvJpcbiAgICAgICAgICog4pGgIOWjsOaYjueahCBNSU1FIOWcqOeZveWQjeWNlemHjO+8iOmZhOS7tuW6k+WPquaUtumCo+Wbm+enje+8ie+8m1xuICAgICAgICAgKiDikaEg5bC65a+45Zyo5YOP57Sg6aKE566X5YaF77yI5ZCm5YiZ6KaB57yp77yJ77ybXG4gICAgICAgICAqIOKRoiDlrZfoioLlnKjlvZLkuIDljJbpooTnrpflhoUg4oCU4oCUIOi2heS6humZhOS7tuW6k+WPjeato+S5n+S8mumHjeWOi+S4gOmBje+8jOmCo+WwsSoq5Zyo6Z2i5p2/6YeM5Y6LKipcbiAgICAgICAgICogICAg77yI5Y2B5YegIE1CIOeahCBiYXNlNjQg6LWw5LiA6LafIElQQyDmmK/nuq/mtarotLnvvInjgIJcbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IHJldXNhYmxlID1cbiAgICAgICAgICAgIEFDQ0VQVEVEX01JTUUuaGFzKHNvdXJjZU1pbWUpICYmICF0YXJnZXQuc2NhbGVkICYmIGJsb2Iuc2l6ZSA8PSBJTUFHRV9CVURHRVQubm9ybWFsaXplZE1heEJ5dGVzO1xuICAgICAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcblxuICAgICAgICBsZXQgbWltZVR5cGU6IEltYWdlTWltZVR5cGU7XG4gICAgICAgIGxldCBkYXRhOiBzdHJpbmc7XG4gICAgICAgIGlmIChyZXVzYWJsZSkge1xuICAgICAgICAgICAgbWltZVR5cGUgPSBzb3VyY2VNaW1lIGFzIEltYWdlTWltZVR5cGU7XG4gICAgICAgICAgICBkYXRhID0gYXdhaXQgYmxvYlRvQmFzZTY0KGJsb2IpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgY2FudmFzID0gZHJhd1RvKGRlY29kZWQsIHRhcmdldC53aWR0aCwgdGFyZ2V0LmhlaWdodCk7XG4gICAgICAgICAgICBjb25zdCBlbmNvZGVkID0gZW5jb2RlQ2FudmFzKGNhbnZhcyk7XG4gICAgICAgICAgICBtaW1lVHlwZSA9IGVuY29kZWQubWltZVR5cGU7XG4gICAgICAgICAgICBkYXRhID0gZW5jb2RlZC5kYXRhVXJsLnNsaWNlKGVuY29kZWQuZGF0YVVybC5pbmRleE9mKCcsJykgKyAxKTtcbiAgICAgICAgICAgIGlmICh0YXJnZXQuc2NhbGVkKSBub3Rlcy5wdXNoKGDlt7LnvKnliLAgJHt0YXJnZXQud2lkdGh9w5cke3RhcmdldC5oZWlnaHR9YCk7XG4gICAgICAgICAgICBpZiAoIUFDQ0VQVEVEX01JTUUuaGFzKHNvdXJjZU1pbWUpKSBub3Rlcy5wdXNoKGAke3NvdXJjZU1pbWUgfHwgJ+acquefpeagvOW8jyd9IOKGkiAke2V4dE9mTWltZShtaW1lVHlwZSl9YCk7XG4gICAgICAgICAgICBpZiAoZW5jb2RlZC5ub3RlKSBub3Rlcy5wdXNoKGVuY29kZWQubm90ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBieXRlcyA9IGJhc2U2NEJ5dGVzKGRhdGEpO1xuICAgICAgICBpZiAoYnl0ZXMgPiBNQVhfSU1BR0VfQllURVMpIHtcbiAgICAgICAgICAgIHJldHVybiB7IGVycm9yOiBgJHtuYW1lfSDlvZLkuIDljJblkI7ku43mnIkgJHtmb3JtYXRCeXRlcyhieXRlcyl977yM6LaF6L+H5Y2V5byg5LiK6ZmQICR7Zm9ybWF0Qnl0ZXMoTUFYX0lNQUdFX0JZVEVTKX3jgIJgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGF0dGFjaG1lbnQ6IHtcbiAgICAgICAgICAgICAgICBpZDogYGltZ18keysrYXR0YWNoU2VxfWAsXG4gICAgICAgICAgICAgICAgbmFtZTogd2l0aEV4dChuYW1lLCBtaW1lVHlwZSksXG4gICAgICAgICAgICAgICAgbWltZVR5cGUsXG4gICAgICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgICAgICBieXRlcyxcbiAgICAgICAgICAgICAgICB3aWR0aDogZGVjb2RlZC53aWR0aCxcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IGRlY29kZWQuaGVpZ2h0LFxuICAgICAgICAgICAgICAgIHRodW1iOiBtYWtlVGh1bWIoZGVjb2RlZCksXG4gICAgICAgICAgICAgICAgb3JpZ2luLFxuICAgICAgICAgICAgICAgIG5vdGU6IG5vdGVzLmpvaW4oJyDCtyAnKSB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGRlY29kZWQucmVsZWFzZSgpO1xuICAgIH1cbn1cblxuLyoqIOeUu+i+k+WFpeWMuuS4iuaWuemCo+aOkuWbvueJh+eijueJh+OAgiAqL1xuZnVuY3Rpb24gcmVuZGVyQXR0YWNobWVudHMoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBob3N0ID0gc3RhdGUuYXR0YWNoSG9zdDtcbiAgICBpZiAoIWhvc3QpIHJldHVybjtcbiAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG4gICAgaG9zdC5oaWRkZW4gPSBzdGF0ZS5hdHRhY2htZW50cy5sZW5ndGggPT09IDA7XG4gICAgZm9yIChjb25zdCBhdHRhY2htZW50IG9mIHN0YXRlLmF0dGFjaG1lbnRzKSB7XG4gICAgICAgIGNvbnN0IGNoaXAgPSBlbCgnZGl2JywgJ2RzaC1hdHRhY2gnKTtcbiAgICAgICAgY29uc3QgdGh1bWIgPSBlbCgnaW1nJywgJ2RzaC1hdHRhY2gtdGh1bWInKTtcbiAgICAgICAgdGh1bWIuc3JjID0gYXR0YWNobWVudC50aHVtYjtcbiAgICAgICAgdGh1bWIuYWx0ID0gYXR0YWNobWVudC5uYW1lO1xuICAgICAgICBjb25zdCBtZXRhID0gZWwoJ2RpdicsICdkc2gtYXR0YWNoLW1ldGEnKTtcbiAgICAgICAgbWV0YS5hcHBlbmQoXG4gICAgICAgICAgICBlbCgnZGl2JywgJ2RzaC1hdHRhY2gtbmFtZScsIGF0dGFjaG1lbnQubmFtZSksXG4gICAgICAgICAgICBlbChcbiAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAnZHNoLWF0dGFjaC1zaXplJyxcbiAgICAgICAgICAgICAgICBgJHthdHRhY2htZW50LndpZHRofcOXJHthdHRhY2htZW50LmhlaWdodH0gwrcgJHtmb3JtYXRCeXRlcyhhdHRhY2htZW50LmJ5dGVzKX1gICtcbiAgICAgICAgICAgICAgICAgICAgKGF0dGFjaG1lbnQubm90ZSA/IGAgwrcgJHthdHRhY2htZW50Lm5vdGV9YCA6ICcnKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IHJlbW92ZSA9IGVsKCdidXR0b24nLCAnZHNoLWF0dGFjaC1kZWwnLCAn4pyVJyk7XG4gICAgICAgIHJlbW92ZS50aXRsZSA9ICfnp7vpmaTov5nlvKDlm74nO1xuICAgICAgICByZW1vdmUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBzdGF0ZS5hdHRhY2htZW50cyA9IHN0YXRlLmF0dGFjaG1lbnRzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5pZCAhPT0gYXR0YWNobWVudC5pZCk7XG4gICAgICAgICAgICByZW5kZXJBdHRhY2htZW50cyhzdGF0ZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBjaGlwLmFwcGVuZCh0aHVtYiwgbWV0YSwgcmVtb3ZlKTtcbiAgICAgICAgaG9zdC5hcHBlbmRDaGlsZChjaGlwKTtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmltYWdlQnV0dG9uKSB7XG4gICAgICAgIHN0YXRlLmltYWdlQnV0dG9uLmRhdGFzZXQuY291bnQgPSBTdHJpbmcoc3RhdGUuYXR0YWNobWVudHMubGVuZ3RoKTtcbiAgICAgICAgc3RhdGUuaW1hZ2VCdXR0b24udGl0bGUgPVxuICAgICAgICAgICAgc3RhdGUuaW1hZ2VCdXR0b24uZGF0YXNldC5jb3VudCA9PT0gJzAnXG4gICAgICAgICAgICAgICAgPyAn5re75Yqg5Zu+54mH77yaQ3RybCtWIOeymOi0tOWJqui0tOadv++8jOaIluWcqOi/memHjOmAieW3peeoi+mHjOeahOWbvidcbiAgICAgICAgICAgICAgICA6IGDlt7LpmYQgJHtzdGF0ZS5hdHRhY2htZW50cy5sZW5ndGh9IOW8oOWbvu+8iOeCueWHu+e7p+e7rea3u+WKoO+8iWA7XG4gICAgfVxufVxuXG4vKiog5oqK5LiA5om5IGBBdHRhY2htZW50YCDmiJbkuIDlj6XplJnor6/lj43mmKDliLDpnaLmnb/kuIrvvIjllK/kuIDlhaXlj6PvvIzliKvlnKjkuKTlpITlkITlhpnkuIDpgY3vvInjgIIgKi9cbmZ1bmN0aW9uIGFkZEF0dGFjaG1lbnRzKHN0YXRlOiBVaVN0YXRlLCBhdHRhY2htZW50czogQXR0YWNobWVudFtdKTogdm9pZCB7XG4gICAgaWYgKGF0dGFjaG1lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IHJvb20gPSBNQVhfSU1BR0VTX1BFUl9NRVNTQUdFIC0gc3RhdGUuYXR0YWNobWVudHMubGVuZ3RoO1xuICAgIGNvbnN0IGFjY2VwdGVkID0gYXR0YWNobWVudHMuc2xpY2UoMCwgTWF0aC5tYXgoMCwgcm9vbSkpO1xuICAgIGlmIChhY2NlcHRlZC5sZW5ndGggPCBhdHRhY2htZW50cy5sZW5ndGgpIHtcbiAgICAgICAgc2V0QmFubmVyKFxuICAgICAgICAgICAgc3RhdGUsXG4gICAgICAgICAgICBg5LiA5p2h5raI5oGv5pyA5aSa5bimICR7TUFYX0lNQUdFU19QRVJfTUVTU0FHRX0g5byg5Zu+77yM5aSa5Ye65p2l55qEICR7YXR0YWNobWVudHMubGVuZ3RoIC0gYWNjZXB0ZWQubGVuZ3RofSDlvKDmsqHmnInliqDkuIrjgIJgLFxuICAgICAgICAgICAgJ2luZm8nLFxuICAgICAgICAgICAgW10sXG4gICAgICAgICAgICBCQU5ORVJfSE9MRC5JTkZPLFxuICAgICAgICApO1xuICAgIH1cbiAgICBzdGF0ZS5hdHRhY2htZW50cyA9IFsuLi5zdGF0ZS5hdHRhY2htZW50cywgLi4uYWNjZXB0ZWRdO1xuICAgIHJlbmRlckF0dGFjaG1lbnRzKHN0YXRlKTtcbiAgICByZXBvcnRQcm9iZSh7XG4gICAgICAgIGtpbmQ6ICdhdHRhY2gnLFxuICAgICAgICBjb3VudDogc3RhdGUuYXR0YWNobWVudHMubGVuZ3RoLFxuICAgICAgICBieXRlczogc3RhdGUuYXR0YWNobWVudHMucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIGl0ZW0uYnl0ZXMsIDApLFxuICAgICAgICBtaW1lczogWy4uLm5ldyBTZXQoc3RhdGUuYXR0YWNobWVudHMubWFwKChpdGVtKSA9PiBpdGVtLm1pbWVUeXBlKSldLFxuICAgIH0pO1xufVxuXG4vKipcbiAqIOOAjOaKiui/meWHoOW8oOWbvuWKoOS4iuOAjeKAlOKAlOeymOi0tOOAgeaLluaLveOAgemAieWbvuS4ieadoei3r+WFseeUqOeahOWFpeWPo+OAglxuICpcbiAqIOWksei0peS4gOW+i+i/m+aoquW5he+8iOS4jeaKm++8ie+8mumdouadv+aKm+mUmeS8muaxoeafk+e8lui+keWZqOaOp+WItuWPsOS4lOeUqOaIt+S7gOS5iOmDveeci+S4jeWIsO+8iOingeaWh+S7tuWktOesrCA1IOadoe+8ieOAglxuICpcbiAqIEBwYXJhbSBibG9icyAtIOS4gOaJueWbvueJh+Wtl+iKgiArIOWQjeWtl+OAglxuICogQHBhcmFtIG9yaWdpbiAtIOadpea6kOagh+iusOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBhdHRhY2hCbG9icyhzdGF0ZTogVWlTdGF0ZSwgYmxvYnM6IEFycmF5PHsgYmxvYjogQmxvYjsgbmFtZTogc3RyaW5nIH0+LCBvcmlnaW46IEF0dGFjaG1lbnRbJ29yaWdpbiddKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGJsb2JzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIHN0YXRlLmltYWdlQnVzeSArPSAxO1xuICAgIGlmIChzdGF0ZS5pbWFnZUJ1dHRvbikgc3RhdGUuaW1hZ2VCdXR0b24uZGF0YXNldC5idXN5ID0gJ3RydWUnO1xuICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBidWlsdDogQXR0YWNobWVudFtdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGJsb2JzKSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBidWlsZEF0dGFjaG1lbnQoaXRlbS5ibG9iLCBpdGVtLm5hbWUsIG9yaWdpbik7XG4gICAgICAgICAgICBpZiAoJ2F0dGFjaG1lbnQnIGluIHJlc3VsdCkgYnVpbHQucHVzaChyZXN1bHQuYXR0YWNobWVudCk7XG4gICAgICAgICAgICBlbHNlIGVycm9ycy5wdXNoKHJlc3VsdC5lcnJvcik7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBlcnJvcnMucHVzaChg5aSE55CG5Zu+54mH5pe25Ye66ZSZ77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgc3RhdGUuaW1hZ2VCdXN5IC09IDE7XG4gICAgICAgIGlmIChzdGF0ZS5pbWFnZUJ1dHRvbikgc3RhdGUuaW1hZ2VCdXR0b24uZGF0YXNldC5idXN5ID0gc3RhdGUuaW1hZ2VCdXN5ID4gMCA/ICd0cnVlJyA6ICdmYWxzZSc7XG4gICAgfVxuICAgIGFkZEF0dGFjaG1lbnRzKHN0YXRlLCBidWlsdCk7XG4gICAgaWYgKGVycm9ycy5sZW5ndGggPiAwKSBzZXRCYW5uZXIoc3RhdGUsIGVycm9ycy5qb2luKCdcXG4nKSwgJ2Vycm9yJywgW10sIEJBTk5FUl9IT0xELkVSUk9SKTtcbiAgICBlbHNlIGlmIChidWlsdC5sZW5ndGggPiAwKSBzZXRCYW5uZXIoc3RhdGUsIG51bGwpO1xufVxuXG4vKipcbiAqIOWJqui0tOadv+mHjOacieayoeacieWbviDigJTigJQg5Lik56eN5p2l5rqQ6YO96KaB6K6k44CCXG4gKlxuICogfCDmnaXmupAgfCDlvaLnirYgfFxuICogfC0tLXwtLS18XG4gKiB8IOaIquWbvi/lpI3liLblm77niYfvvIhFeHBsb3JlcuOAgeW+ruS/oeOAgVFR4oCm77yJIHwgYERhdGFUcmFuc2Zlckl0ZW0ua2luZCA9PT0gJ2ZpbGUnYO+8jGB0eXBlYCDmmK8gYGltYWdlLypgIHxcbiAqIHwg5LuO5rWP6KeI5ZmoL+e9kemhtemHjOWkjeWItiB8IOe9kemhteWPr+iDveWPquaUviBgdGV4dC9odG1sYO+8jOS9hiBDaHJvbWl1bSDkuIDoiKzkuZ/kvJrluKYgYGltYWdlL3BuZ2Ag55qEIGZpbGUg6aG5IHxcbiAqXG4gKiDlj6rmnIkqKuehruiupOacieWbvioq5omNIGBwcmV2ZW50RGVmYXVsdCgpYO+8mue6r+aWh+Wtl+eymOi0tOW/hemhu+WOn+agt+S6pOe7mSB0ZXh0YXJlYe+8jOWQpuWImeOAjOeymOi0tOS4gOauteaWh+Wtl+OAjVxuICog5Lya6KKr5oiR5Lus5ZCD5o6J77yI6YKj5piv5pyA5bi46KeB55qE5pON5L2c77yM57ud5LiN6IO956Kw77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGltYWdlc0Zyb21DbGlwYm9hcmQoZGF0YTogRGF0YVRyYW5zZmVyIHwgbnVsbCk6IEFycmF5PHsgYmxvYjogQmxvYjsgbmFtZTogc3RyaW5nIH0+IHtcbiAgICBjb25zdCBvdXQ6IEFycmF5PHsgYmxvYjogQmxvYjsgbmFtZTogc3RyaW5nIH0+ID0gW107XG4gICAgaWYgKCFkYXRhKSByZXR1cm4gb3V0O1xuICAgIGNvbnN0IGl0ZW1zID0gZGF0YS5pdGVtcyA/IEFycmF5LmZyb20oZGF0YS5pdGVtcykgOiBbXTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgICAgaWYgKGl0ZW0ua2luZCAhPT0gJ2ZpbGUnKSBjb250aW51ZTtcbiAgICAgICAgaWYgKCFpdGVtLnR5cGUgfHwgIWl0ZW0udHlwZS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ2ltYWdlLycpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZmlsZSA9IGl0ZW0uZ2V0QXNGaWxlKCk7XG4gICAgICAgIGlmICghZmlsZSkgY29udGludWU7XG4gICAgICAgIG91dC5wdXNoKHsgYmxvYjogZmlsZSwgbmFtZTogZmlsZS5uYW1lICYmIGZpbGUubmFtZSAhPT0gJ2ltYWdlLnBuZycgPyBmaWxlLm5hbWUgOiBg5Ymq6LS05p2/5Zu+54mHLSR7b3V0Lmxlbmd0aCArIDF9YCB9KTtcbiAgICB9XG4gICAgaWYgKG91dC5sZW5ndGggPT09IDAgJiYgZGF0YS5maWxlcyAmJiBkYXRhLmZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8g5pyJ5Lqb5p2l5rqQ5LiN5ZyoIGl0ZW1zIOmHjOOAgeWPquWcqCBmaWxlcyDph4xcbiAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIEFycmF5LmZyb20oZGF0YS5maWxlcykpIHtcbiAgICAgICAgICAgIGlmIChmaWxlLnR5cGUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKCdpbWFnZS8nKSkge1xuICAgICAgICAgICAgICAgIG91dC5wdXNoKHsgYmxvYjogZmlsZSwgbmFtZTogZmlsZS5uYW1lIHx8IGDliarotLTmnb/lm77niYctJHtvdXQubGVuZ3RoICsgMX1gIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5Zu+54mH6YCJ5oup5Zmo77yI5bel56iL5Zu+54mH77yJXG5cbi8qKiBgbGlzdC1pbWFnZXNgIOeahOWbnuaJp+OAgiAqL1xuaW50ZXJmYWNlIExpc3RJbWFnZXNSZXBseSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgc291cmNlPzogc3RyaW5nO1xuICAgIHRvdGFsPzogbnVtYmVyO1xuICAgIGltYWdlcz86IFByb2plY3RJbWFnZVtdO1xuICAgIGVycm9yPzogc3RyaW5nO1xufVxuXG4vKiogYHJlYWQtaW1hZ2VgIOeahOWbnuaJp+OAgiAqL1xuaW50ZXJmYWNlIFJlYWRJbWFnZVJlcGx5IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBuYW1lPzogc3RyaW5nO1xuICAgIHBhdGg/OiBzdHJpbmc7XG4gICAgdXJsPzogc3RyaW5nO1xuICAgIG1pbWVUeXBlPzogc3RyaW5nO1xuICAgIGJ5dGVzPzogbnVtYmVyO1xuICAgIGRhdGE/OiBzdHJpbmc7XG4gICAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8qKiDmi4nkuIDmrKHlt6XnqIvlm77niYfmuIXljZXvvIjluKbnvJPlrZjvvJtgZm9yY2VgIOaXtumHjeaLie+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5zdXJlUGlja2VyTGlzdChzdGF0ZTogVWlTdGF0ZSwgZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5waWNrZXJJbWFnZXMgJiYgIWZvcmNlKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnBpY2tlck5vdGUpIHtcbiAgICAgICAgc3RhdGUucGlja2VyTm90ZS50ZXh0Q29udGVudCA9ICfmraPlnKjor7vlt6XnqIvnmoTotYTmupDlupPigKYnO1xuICAgICAgICBzdGF0ZS5waWNrZXJOb3RlLmRhdGFzZXQudG9uZSA9ICcnO1xuICAgIH1cbiAgICBsZXQgcmVwbHk6IExpc3RJbWFnZXNSZXBseTtcbiAgICB0cnkge1xuICAgICAgICByZXBseSA9IGF3YWl0IGNhbGw8TGlzdEltYWdlc1JlcGx5PihNU0cubGlzdEltYWdlcyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmVwbHkgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnJvcikgfTtcbiAgICB9XG4gICAgaWYgKCFyZXBseT8ub2spIHtcbiAgICAgICAgc3RhdGUucGlja2VySW1hZ2VzID0gW107XG4gICAgICAgIGlmIChzdGF0ZS5waWNrZXJOb3RlKSB7XG4gICAgICAgICAgICBzdGF0ZS5waWNrZXJOb3RlLnRleHRDb250ZW50ID0gYOivu+S4jeWIsOW3peeoi+WbvueJh++8miR7cmVwbHk/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWA7XG4gICAgICAgICAgICBzdGF0ZS5waWNrZXJOb3RlLmRhdGFzZXQudG9uZSA9ICdlcnJvcic7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5waWNrZXJJbWFnZXMgPSByZXBseS5pbWFnZXMgPz8gW107XG4gICAgc3RhdGUucGlja2VyU291cmNlID0gcmVwbHkuc291cmNlID8/ICcnO1xuICAgIHJlbmRlclBpY2tlckxpc3Qoc3RhdGUpO1xufVxuXG4vKiog55S76YCJ5oup5Zmo6YeM55qE5qC85a2Q77yI5oyJ5pCc57Si6K+N6L+H5ruk5ZCO77yJ44CCICovXG5mdW5jdGlvbiByZW5kZXJQaWNrZXJMaXN0KHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgbGlzdCA9IHN0YXRlLnBpY2tlckxpc3Q7XG4gICAgaWYgKCFsaXN0KSByZXR1cm47XG4gICAgY29uc3QgYWxsID0gc3RhdGUucGlja2VySW1hZ2VzID8/IFtdO1xuICAgIGNvbnN0IHNob3duID0gZmlsdGVyUHJvamVjdEltYWdlcyhhbGwsIHN0YXRlLnBpY2tlclF1ZXJ5KS5zbGljZSgwLCBNQVhfTElTVEVEX0lNQUdFUyk7XG4gICAgbGlzdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIHN0YXRlLnBpY2tlck9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG4gICAgc3RhdGUucGlja2VyT2JzZXJ2ZXIgPSBudWxsO1xuICAgIHN0YXRlLnBpY2tlclF1ZXVlID0gW107XG5cbiAgICBpZiAoc3RhdGUucGlja2VyTm90ZSkge1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBzdGF0ZS5waWNrZXJTb3VyY2UgPT09ICdzY2FuJyA/ICfvvIjotYTmupDlupPmsqHnu5nlh7rnu5PmnpzvvIzov5nmmK/miasgYXNzZXRzIOebruW9leW+l+WIsOeahO+8iScgOiAnJztcbiAgICAgICAgc3RhdGUucGlja2VyTm90ZS50ZXh0Q29udGVudCA9XG4gICAgICAgICAgICBhbGwubGVuZ3RoID09PSAwXG4gICAgICAgICAgICAgICAgPyAn6L+Z5Liq5bel56iL6YeM5rKh5om+5Yiw5Zu+54mH77yI5Y+q6K6kIHBuZyAvIGpwZyAvIGpwZWcgLyB3ZWJwIC8gZ2lm77yJ44CCJ1xuICAgICAgICAgICAgICAgIDogYOWFsSAke2FsbC5sZW5ndGh9IOW8oCR7b3JpZ2lufSR7c3RhdGUucGlja2VyUXVlcnkgPyBg77yM562b5Ye6ICR7c2hvd24ubGVuZ3RofSDlvKBgIDogJyd9IMK3IOeCueS4gOW8oOWwseWKoOS4imA7XG4gICAgICAgIHN0YXRlLnBpY2tlck5vdGUuZGF0YXNldC50b25lID0gYWxsLmxlbmd0aCA9PT0gMCA/ICdlcnJvcicgOiAnJztcbiAgICB9XG5cbiAgICBjb25zdCBvYnNlcnZlciA9XG4gICAgICAgIHR5cGVvZiBJbnRlcnNlY3Rpb25PYnNlcnZlciA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgPyBuZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXIoXG4gICAgICAgICAgICAgICAgICAoZW50cmllcykgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWVudHJ5LmlzSW50ZXJzZWN0aW5nKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGVudHJ5LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgb2JzZXJ2ZXIudW5vYnNlcnZlKG5vZGUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpbWFnZSA9IGFsbC5maW5kKChpdGVtKSA9PiBpdGVtLnBhdGggPT09IG5vZGUuZGF0YXNldC5wYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGFyZ2V0ID0gbm9kZS5xdWVyeVNlbGVjdG9yKCdpbWcnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGltYWdlICYmIHRhcmdldCkgcXVldWVUaHVtYihzdGF0ZSwgaW1hZ2UsIHRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHsgcm9vdDogbGlzdCwgcm9vdE1hcmdpbjogJzE2MHB4JyB9LFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICA6IG51bGw7XG4gICAgc3RhdGUucGlja2VyT2JzZXJ2ZXIgPSBvYnNlcnZlcjtcblxuICAgIGZvciAoY29uc3QgaW1hZ2Ugb2Ygc2hvd24pIHtcbiAgICAgICAgY29uc3QgaXRlbSA9IGVsKCdidXR0b24nLCAnZHNoLXBpY2staXRlbScpO1xuICAgICAgICBpdGVtLnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgaXRlbS5kYXRhc2V0LnBhdGggPSBpbWFnZS5wYXRoO1xuICAgICAgICBpdGVtLnRpdGxlID0gYCR7aW1hZ2UubmFtZX1cXG4ke2ltYWdlLnJlbCB8fCBpbWFnZS51cmx9JHtpbWFnZS5ieXRlcyA/IGBcXG4ke2Zvcm1hdEJ5dGVzKGltYWdlLmJ5dGVzKX1gIDogJyd9YDtcbiAgICAgICAgY29uc3QgdGh1bWIgPSBlbCgnaW1nJywgJ2RzaC1waWNrLXRodW1iJyk7XG4gICAgICAgIHRodW1iLmFsdCA9ICcnO1xuICAgICAgICAvLyDnvJPlrZjph4zmnInlsLHnm7TmjqXnu5nvvIjlhbPmjonlho3lvIDkuI3ph43or7vvvInvvIzmsqHmnInliJnmjILkuIrop4Llr5/ogIXmjInpnIDor7tcbiAgICAgICAgY29uc3QgY2FjaGVkID0gc3RhdGUucGlja2VyVGh1bWJzLmdldChpbWFnZS5wYXRoKTtcbiAgICAgICAgaWYgKGNhY2hlZCkgdGh1bWIuc3JjID0gY2FjaGVkO1xuICAgICAgICBjb25zdCB0ZXh0ID0gZWwoJ3NwYW4nLCAnZHNoLXBpY2stdGV4dCcpO1xuICAgICAgICB0ZXh0LmFwcGVuZChlbCgnc3BhbicsICdkc2gtcGljay1uYW1lJywgaW1hZ2UubmFtZSksIGVsKCdzcGFuJywgJ2RzaC1waWNrLXBhdGgnLCBpbWFnZS5yZWwgfHwgaW1hZ2UudXJsKSk7XG4gICAgICAgIGl0ZW0uYXBwZW5kKHRodW1iLCB0ZXh0KTtcbiAgICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgYXR0YWNoUHJvamVjdEltYWdlKHN0YXRlLCBpbWFnZSkpO1xuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGl0ZW0pO1xuICAgICAgICBpZiAoIWNhY2hlZCAmJiBvYnNlcnZlcikgb2JzZXJ2ZXIub2JzZXJ2ZShpdGVtKTtcbiAgICAgICAgZWxzZSBpZiAoIWNhY2hlZCAmJiBzaG93bi5pbmRleE9mKGltYWdlKSA8IDI0KSBxdWV1ZVRodW1iKHN0YXRlLCBpbWFnZSwgdGh1bWIpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDnvKnnlaXlm77mjInpnIDor7vvvJrkuIDmrKEgSVBDICsg5LiA5qyh6Kej56CB77yM5omA5LulKirlkIzlsY/mnIDlpJogYFRIVU1CX0NPTkNVUlJFTkNZYCDot68qKu+8jOivu+WujOWNs+WHuumYn+OAglxuICog6K+75LiN5Ye65p2l55qE6Lev5b6E6K6w6L+bIGBwaWNrZXJGYWlsZWRg77yM5YWN5b6X5rua5Yqo5LiA5qyh5bCx6YeN6K+V5LiA5pW05Liy44CCXG4gKi9cbmZ1bmN0aW9uIHF1ZXVlVGh1bWIoc3RhdGU6IFVpU3RhdGUsIGltYWdlOiBQcm9qZWN0SW1hZ2UsIHRhcmdldDogSFRNTEltYWdlRWxlbWVudCk6IHZvaWQge1xuICAgIGlmIChzdGF0ZS5waWNrZXJUaHVtYnMuaGFzKGltYWdlLnBhdGgpIHx8IHN0YXRlLnBpY2tlckZhaWxlZC5oYXMoaW1hZ2UucGF0aCkpIHJldHVybjtcbiAgICBpZiAoc3RhdGUucGlja2VyTG9hZGluZy5oYXMoaW1hZ2UucGF0aCkpIHJldHVybjtcbiAgICBzdGF0ZS5waWNrZXJRdWV1ZS5wdXNoKHsgaW1hZ2UsIHRhcmdldCB9KTtcbiAgICB2b2lkIHB1bXBUaHVtYnMoc3RhdGUpO1xufVxuXG4vKiog5o6o57yp55Wl5Zu+6Zif5YiX77yI6Ieq5bim5bm25Y+R5LiK6ZmQ77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBwdW1wVGh1bWJzKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgd2hpbGUgKHN0YXRlLnBpY2tlckxvYWRpbmcuc2l6ZSA8IFRIVU1CX0NPTkNVUlJFTkNZICYmIHN0YXRlLnBpY2tlclF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLnBpY2tlclF1ZXVlLnNoaWZ0KCk7XG4gICAgICAgIGlmICghbmV4dCkgYnJlYWs7XG4gICAgICAgIGNvbnN0IHsgaW1hZ2UsIHRhcmdldCB9ID0gbmV4dDtcbiAgICAgICAgaWYgKHN0YXRlLnBpY2tlclRodW1icy5oYXMoaW1hZ2UucGF0aCkgfHwgc3RhdGUucGlja2VyTG9hZGluZy5oYXMoaW1hZ2UucGF0aCkpIGNvbnRpbnVlO1xuICAgICAgICBzdGF0ZS5waWNrZXJMb2FkaW5nLmFkZChpbWFnZS5wYXRoKTtcbiAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHJlYWRQcm9qZWN0SW1hZ2UoaW1hZ2UpO1xuICAgICAgICAgICAgICAgIGlmICghcmVwbHkub2sgfHwgIXJlcGx5LmRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGlja2VyRmFpbGVkLmFkZChpbWFnZS5wYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LmRhdGFzZXQuZmFpbGVkID0gJ3RydWUnO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbYmFzZTY0VG9CdWZmZXIocmVwbHkuZGF0YSldLCB7IHR5cGU6IHJlcGx5Lm1pbWVUeXBlID8/ICdpbWFnZS9wbmcnIH0pO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRlY29kZWQgPSBhd2FpdCBkZWNvZGVCbG9iKGJsb2IpO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRodW1iID0gbWFrZVRodW1iKGRlY29kZWQpO1xuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5waWNrZXJUaHVtYnMuc2V0KGltYWdlLnBhdGgsIHRodW1iKTtcbiAgICAgICAgICAgICAgICAgICAgd2hpbGUgKHN0YXRlLnBpY2tlclRodW1icy5zaXplID4gVEhVTUJfQ0FDSEVfTElNSVQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9sZGVzdCA9IHN0YXRlLnBpY2tlclRodW1icy5rZXlzKCkubmV4dCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9sZGVzdC5kb25lKSBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXRlLnBpY2tlclRodW1icy5kZWxldGUob2xkZXN0LnZhbHVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAodGFyZ2V0LmlzQ29ubmVjdGVkKSB0YXJnZXQuc3JjID0gdGh1bWI7XG4gICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgICAgZGVjb2RlZC5yZWxlYXNlKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgc3RhdGUucGlja2VyRmFpbGVkLmFkZChpbWFnZS5wYXRoKTtcbiAgICAgICAgICAgICAgICB0YXJnZXQuZGF0YXNldC5mYWlsZWQgPSAndHJ1ZSc7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHN0YXRlLnBpY2tlckxvYWRpbmcuZGVsZXRlKGltYWdlLnBhdGgpO1xuICAgICAgICAgICAgICAgIHZvaWQgcHVtcFRodW1icyhzdGF0ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKCk7XG4gICAgfVxufVxuXG4vKipcbiAqIGJhc2U2NCDihpIgYEFycmF5QnVmZmVyYO+8iOimgeS6pOe7mSBgQmxvYmAg5YaN6Kej56CB77yM5omA5Lul5Y+q6IO96Ieq5bex6L2s77ybYGF0b2JgIOaYr+agh+WHhiBBUEnvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjov5Tlm54gYEFycmF5QnVmZmVyYCDogIzkuI3mmK8gYFVpbnQ4QXJyYXlg77yaYG5ldyBCbG9iKFtieXRlc10pYCDnmoQgVFMg57G75Z6L6KaB5rGCXG4gKiBgQXJyYXlCdWZmZXJWaWV3PEFycmF5QnVmZmVyPmDvvIzogIwgYFVpbnQ4QXJyYXlgIOeahCBgYnVmZmVyYCDmmK8gYEFycmF5QnVmZmVyTGlrZWBcbiAqIO+8iOWPr+iDveiiq+aOqOaIkCBgU2hhcmVkQXJyYXlCdWZmZXJg77yJ4oCU4oCUIOebtOaOpeS8oOS8muiiq+exu+Wei+ajgOafpeaLpuS4i+OAgue7mSBgQXJyYXlCdWZmZXJgIOacgOecgeS6i+OAglxuICovXG5mdW5jdGlvbiBiYXNlNjRUb0J1ZmZlcihkYXRhOiBzdHJpbmcpOiBBcnJheUJ1ZmZlciB7XG4gICAgY29uc3QgYmluYXJ5ID0gYXRvYihkYXRhKTtcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoYmluYXJ5Lmxlbmd0aCk7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBiaW5hcnkubGVuZ3RoOyBpbmRleCArPSAxKSBieXRlc1tpbmRleF0gPSBiaW5hcnkuY2hhckNvZGVBdChpbmRleCk7XG4gICAgcmV0dXJuIGJ1ZmZlcjtcbn1cblxuLyoqIOivu+S4gOW8oOW3peeoi+Wbvu+8iOmAieaLqeWZqOeCueW8gOOAgeaLlui/m+adpeOAgeWKoOmZhOS7tumDvei1sOWug++8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFByb2plY3RJbWFnZShpbWFnZTogUHJvamVjdEltYWdlKTogUHJvbWlzZTxSZWFkSW1hZ2VSZXBseT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBjYWxsPFJlYWRJbWFnZVJlcGx5PihNU0cucmVhZEltYWdlLCB7IHVybDogaW1hZ2UudXJsLCBwYXRoOiBpbWFnZS5wYXRoIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnJvcikgfTtcbiAgICB9XG59XG5cbi8qKiDngrnkuIDlvKDlt6XnqIvlm74gPSDor7vljp/lm74g4oaSIOW9kuS4gOWMliDihpIg6L+b56KO54mH5Yy644CCICovXG5hc3luYyBmdW5jdGlvbiBhdHRhY2hQcm9qZWN0SW1hZ2Uoc3RhdGU6IFVpU3RhdGUsIGltYWdlOiBQcm9qZWN0SW1hZ2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoc3RhdGUuYXR0YWNobWVudHMuc29tZSgoaXRlbSkgPT4gaXRlbS5uYW1lID09PSBpbWFnZS5uYW1lICYmIGl0ZW0ub3JpZ2luID09PSAncHJvamVjdCcpKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOOAjCR7aW1hZ2UubmFtZX3jgI3lt7Lnu4/lnKjlvoXlj5HpgIHliJfooajph4zkuobjgIJgLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZXBseSA9IGF3YWl0IHJlYWRQcm9qZWN0SW1hZ2UoaW1hZ2UpO1xuICAgIGlmICghcmVwbHkub2sgfHwgIXJlcGx5LmRhdGEpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg6K+75LiN5Yiw44CMJHtpbWFnZS5uYW1lfeOAje+8miR7cmVwbHkuZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YCwgJ2Vycm9yJywgW10sIEJBTk5FUl9IT0xELkVSUk9SKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW2Jhc2U2NFRvQnVmZmVyKHJlcGx5LmRhdGEpXSwgeyB0eXBlOiByZXBseS5taW1lVHlwZSA/PyAnaW1hZ2UvcG5nJyB9KTtcbiAgICBhd2FpdCBhdHRhY2hCbG9icyhzdGF0ZSwgW3sgYmxvYiwgbmFtZTogcmVwbHkubmFtZSA/PyBpbWFnZS5uYW1lIH1dLCAncHJvamVjdCcpO1xufVxuXG4vKiog5omT5byAL+WFs+aOieWbvueJh+mAieaLqeWZqOOAgiAqL1xuZnVuY3Rpb24gdG9nZ2xlUGlja2VyKHN0YXRlOiBVaVN0YXRlLCBvcGVuPzogYm9vbGVhbik6IHZvaWQge1xuICAgIGNvbnN0IG5leHQgPSBvcGVuID8/ICFzdGF0ZS5waWNrZXJPcGVuO1xuICAgIHN0YXRlLnBpY2tlck9wZW4gPSBuZXh0O1xuICAgIGlmIChzdGF0ZS5waWNrZXIpIHN0YXRlLnBpY2tlci5oaWRkZW4gPSAhbmV4dDtcbiAgICAvLyDpgInmi6nlmajkuI7ovpPlhaXlvLnlh7rlnZcqKuaKouWQjOS4gOWdl+eJiOmdoioq77yI6YO95Zyo5a+56K+d5Yy65LiO6L6T5YWl5Yy65LmL6Ze077yJ77ya5byA5LiA5Liq5bCx5pS25Y+m5LiA5LiqXG4gICAgaWYgKG5leHQpIGNsb3NlUG9wdXAoc3RhdGUpO1xuICAgIGlmIChuZXh0KSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDnvJPlrZjlkb3kuK3ml7YqKuW/hemhu+mHjeeUu+S4gOasoSoq77ya5YWz5oq95bGJ5pe25oqKIGBJbnRlcnNlY3Rpb25PYnNlcnZlcmAg5pGY5o6J5LqG77yMXG4gICAgICAgICAqIOiAjOayoeivu+WIsOeahOmCo+S6m+agvOWtkOato+aYr+mdoOWug+aOkumYn+eahCDigJTigJQg5LiN6YeN5oyC55qE6K+d77yM56ys5LqM5qyh5omT5byA5pe26YKj5Lqb5qC85a2QXG4gICAgICAgICAqIOawuOi/nOaYr+epuueahO+8iOWbvueJh+acrOi6q+ayoeWPmOOAgee8k+WtmOS5n+WcqO+8jOWPquaYr+ayoeS6uuWGjeWOu+ivu++8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgaWYgKHN0YXRlLnBpY2tlckltYWdlcykgcmVuZGVyUGlja2VyTGlzdChzdGF0ZSk7XG4gICAgICAgIHZvaWQgZW5zdXJlUGlja2VyTGlzdChzdGF0ZSk7XG4gICAgICAgIC8vIOaJk+W8gOWwseaKiueEpueCuee7meaQnOe0ouahhu+8mumUruebmOa1geOAjOaJk+W8gCDihpIg5omT5Yeg5Liq5a2XIOKGkiDngrnkuIDlvKDjgI3kuIDmsJTlkbXmiJBcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiBzdGF0ZS5waWNrZXJTZWFyY2g/LmZvY3VzKCksIDApO1xuICAgIH0gZWxzZSBpZiAoc3RhdGUucGlja2VyT2JzZXJ2ZXIpIHtcbiAgICAgICAgc3RhdGUucGlja2VyT2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgICAgICBzdGF0ZS5waWNrZXJPYnNlcnZlciA9IG51bGw7XG4gICAgfVxufVxuXG4vKiog44CM6K+75Ymq6LS05p2/44CN5oyJ6ZKu77ya5ou/5LiN5Yiw5p2D6ZmQ5pe257uZ5LiA5p2h5Y+v5pON5L2c55qE5o+Q56S677yI5Yir5Y+q6K+05aSx6LSl77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBwYXN0ZUZyb21DbGlwYm9hcmRBcGkoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjbGlwYm9hcmQgPSBuYXZpZ2F0b3IuY2xpcGJvYXJkIGFzIENsaXBib2FyZCB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWNsaXBib2FyZD8ucmVhZCkge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfov5nkuKrpnaLmnb/mi7/kuI3liLDliarotLTmnb/or7vlj5bmjqXlj6Mg4oCU4oCUIOaKiuWFieagh+aUvui/m+i+k+WFpeahhuaMiSBDdHJsK1Yg5Y2z5Y+v44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaXRlbXMgPSBhd2FpdCBjbGlwYm9hcmQucmVhZCgpO1xuICAgICAgICBjb25zdCBibG9iczogQXJyYXk8eyBibG9iOiBCbG9iOyBuYW1lOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gaXRlbS50eXBlcy5maW5kKChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5zdGFydHNXaXRoKCdpbWFnZS8nKSk7XG4gICAgICAgICAgICBpZiAoIXR5cGUpIGNvbnRpbnVlO1xuICAgICAgICAgICAgYmxvYnMucHVzaCh7IGJsb2I6IGF3YWl0IGl0ZW0uZ2V0VHlwZSh0eXBlKSwgbmFtZTogYOWJqui0tOadv+WbvueJhy0ke2Jsb2JzLmxlbmd0aCArIDF9YCB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYmxvYnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfliarotLTmnb/ph4zmsqHmnInlm77niYfvvIjlj6rmnInmloflrZfvvInjgIInLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBhdHRhY2hCbG9icyhzdGF0ZSwgYmxvYnMsICdjbGlwYm9hcmQnKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzZXRCYW5uZXIoXG4gICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgIGDor7vliarotLTmnb/lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX3vvIjmiorlhYnmoIfmlL7ov5vovpPlhaXmoYbmjIkgQ3RybCtWIOS5n+S4gOagt+iDveeUqO+8ieOAgmAsXG4gICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICBbXSxcbiAgICAgICAgICAgIEJBTk5FUl9IT0xELklORk8sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWKqOS9nFxuXG4vKiog5ZCv5YqoIGFnZW50IOW5tuaKiue7k+aenOWPjeaYoOWIsOaoquW5heS4iuOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RhcnRBZ2VudChzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5zdGFydFJlcXVlc3RlZCkgcmV0dXJuO1xuICAgIHN0YXRlLnN0YXJ0UmVxdWVzdGVkID0gdHJ1ZTtcbiAgICBzZXRCYW5uZXIoc3RhdGUsICfmraPlnKjlkK/liqggYWdlbnTigKbvvIjpppbmrKHlh6DljYHnp5LvvIzor7fnqI3nrYnvvIknLCAnaW5mbycpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLnN0YXJ0QWdlbnQpO1xuICAgICAgICBpZiAoIXJlc3VsdD8ub2spIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgcmVzdWx0Py5lcnJvciA/PyAn5ZCv5Yqo5aSx6LSlJywgJ2Vycm9yJywgW3sgbGFiZWw6ICfph43or5UnLCBydW46ICgpID0+IHZvaWQgc3RhcnRBZ2VudChzdGF0ZSkgfV0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBudWxsKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOWQr+WKqOWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBzdGF0ZS5zdGFydFJlcXVlc3RlZCA9IGZhbHNlO1xuICAgICAgICB2b2lkIHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgfVxufVxuXG4vKiog6YeN5paw5ZCM5q2lIHByb2ZpbGUg5bm25oqK57uT5p6c5pi+56S65Ye65p2l44CCICovXG5hc3luYyBmdW5jdGlvbiByZXBhaXJQcm9maWxlKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2V0QmFubmVyKHN0YXRlLCAn5q2j5Zyo5ZCM5q2lIHByb2ZpbGXigKYnLCAnaW5mbycpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgcHJvZmlsZURpcj86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmc7IGNoYW5nZXM/OiBzdHJpbmdbXSB9PihcbiAgICAgICAgICAgIE1TRy5pbnN0YWxsUHJvZmlsZSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHJlcG9ydD8ub2spIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihcbiAgICAgICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgICAgICBgcHJvZmlsZSDlt7LlsLHkvY3vvJoke3JlcG9ydC5wcm9maWxlRGlyfVxcbiR7cmVwb3J0LmNoYW5nZXM/Lmxlbmd0aCA/IHJlcG9ydC5jaGFuZ2VzLmpvaW4oJ1xcbicpIDogJ++8iOaXoOWPmOabtO+8iSd9YCxcbiAgICAgICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5L+u5aSN5aSx6LSl77yaJHtyZXBvcnQ/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWAsICdlcnJvcicpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5L+u5aSN5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWAsICdlcnJvcicpO1xuICAgIH1cbiAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWOhuWPsuS8muivnVxuXG4vKiogYGhpc3RvcnktbGlzdGAg55qE5Zue5omn44CCICovXG5pbnRlcmZhY2UgSGlzdG9yeUxpc3RSZXBseSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgc2Vzc2lvbnM/OiBIaXN0b3J5U2Vzc2lvblZpZXdbXTtcbiAgICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqIGBoaXN0b3J5LXNlYXJjaGAg55qE5Zue5omn77yI5a2X5q615LiOIGBjb25zdGFudHMudHNgIOeahCBgSGlzdG9yeVNlYXJjaFZpZXdgIOWQjOW9ou+8ieOAgiAqL1xuaW50ZXJmYWNlIEhpc3RvcnlTZWFyY2hSZXBseSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgcXVlcnk/OiBzdHJpbmc7XG4gICAgaGl0cz86IEhpc3RvcnlTZWFyY2hIaXRWaWV3W107XG4gICAgc2Nhbm5lZD86IG51bWJlcjtcbiAgICBhdmFpbGFibGU/OiBudW1iZXI7XG4gICAgcGFydGlhbD86IGJvb2xlYW47XG4gICAgc3RvcHBlZEJ5Pzogc3RyaW5nIHwgbnVsbDtcbiAgICBlbGFwc2VkTXM/OiBudW1iZXI7XG4gICAgc2Nhbm5lZEJ5dGVzPzogbnVtYmVyO1xufVxuXG4vKiog5oq95bGJ6YeM44CM5b2T5YmN5pi+56S655qE5piv5LiA5Lu95pCc57Si57uT5p6c44CN6L+Z5Lu25LqL77yI6L+e5ZCM6KaG55uW546H5LiA6LW35a2Y77yJ44CCICovXG5pbnRlcmZhY2UgSGlzdG9yeVNlYXJjaFN0YXRlIHtcbiAgICBxdWVyeTogc3RyaW5nO1xuICAgIGhpdHM6IEhpc3RvcnlTZWFyY2hIaXRWaWV3W107XG4gICAgc2Nhbm5lZDogbnVtYmVyO1xuICAgIGF2YWlsYWJsZTogbnVtYmVyO1xuICAgIHBhcnRpYWw6IGJvb2xlYW47XG4gICAgc3RvcHBlZEJ5OiBzdHJpbmcgfCBudWxsO1xuICAgIGVsYXBzZWRNczogbnVtYmVyO1xuICAgIHNjYW5uZWRCeXRlczogbnVtYmVyO1xufVxuXG4vKiog5Yig5LiA5p2h5Lya6K+d55qEKirkuozmrKHnoa7orqQqKu+8muesrOS4gOasoeeCueWHu+aLv+WIsOi/meS7vea4heWNle+8jOesrOS6jOasoeeCueWHu+aJjeecn+WIoOOAgiAqL1xuaW50ZXJmYWNlIEhpc3RvcnlDb25maXJtU3RhdGUge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgZmlsZUNvdW50OiBudW1iZXI7XG4gICAgYnl0ZXM6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiDov5nkuIDotp/opoHkuI3opoHpobrluKblm57mlLbml6DlvJXnlKjpmYTku7bvvIgqKum7mOiupCBmYWxzZSoq77yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjopoHmiorov5nkuKrpgInmi6kqKuW4pui/m+a4heWNlSoq77ya5YCZ6YCJ5pWw5Lya6ZqP5a6D5Y+Y77yI5Yu+5LiK5LmL5ZCO6KaB6LeR5LiA5qyh5YWo5bqT5omr5o+P5omN55+l6YGTXG4gICAgICog44CM5pyJ5Yeg5Liq5bey5peg5byV55So44CN77yJ77yM6ICM55So5oi35piv5oyJ552A5riF5Y2V5LiK6YKj5Liq5pWw5Yaz5a6a6KaB5LiN6KaB5oyJ44CM56Gu6K6k5Yig6Zmk44CN55qE44CCXG4gICAgICog5Y+q5a2Y5LiA5Liq5biD5bCU44CB5riF5Y2V54Wn5pen55qE6K+d77yM6YKj5Y+l6K+d5bCx5piv6ZSZ55qE44CCXG4gICAgICovXG4gICAgcmVjbGFpbT86IGJvb2xlYW47XG59XG5cbi8qKlxuICog5pe26Ze05oizIOKGkiBgMDktMzAgMDA6MzZg77yI6Z2i5p2/56qE77yM5LiN5bim5bm05Lu977yJ44CCXG4gKlxuICog5a2X6IqC5pWw5oCO5LmI5pi+56S66KeBIGBpbWFnZXMudHNgIOeahCBgZm9ybWF0Qnl0ZXNgIOKAlOKAlCAqKuWPquaciemCo+S4gOS7vSoq77yI5Y6G5Y+y5oq95bGJ55qE5L2T56ev44CBXG4gKiDlm77niYfnoo7niYfnmoTlpKflsI/pg73otbDlroPvvIzliKvlnKjpnaLmnb/ph4zlho3mioTkuIDkuKrvvInjgIJcbiAqL1xuZnVuY3Rpb24gZm9ybWF0VGltZShtczogbnVtYmVyKTogc3RyaW5nIHtcbiAgICBjb25zdCBkYXRlID0gbmV3IERhdGUobXMpO1xuICAgIGNvbnN0IHBhZCA9ICh2YWx1ZTogbnVtYmVyKTogc3RyaW5nID0+IFN0cmluZyh2YWx1ZSkucGFkU3RhcnQoMiwgJzAnKTtcbiAgICByZXR1cm4gYCR7cGFkKGRhdGUuZ2V0TW9udGgoKSArIDEpfS0ke3BhZChkYXRlLmdldERhdGUoKSl9ICR7cGFkKGRhdGUuZ2V0SG91cnMoKSl9OiR7cGFkKGRhdGUuZ2V0TWludXRlcygpKX1gO1xufVxuXG4vKipcbiAqIOOAjOW9k+WJjeWvueivneWMuuaYr+S4jeaYr+S4gOadoeWOhuWPsuS8muivneOAjeeahOaoquW5heOAglxuICpcbiAqIOS4pOenjeeKtuaAge+8mioq5Y+q6K+75Zue5pS+KirvvIjov5jmsqHmjqXkuIrvvIznu5njgIznu6fnu63mraTkvJror53jgI3mjInpkq7vvInkuI4qKuW3suaOpeS4iioq77yI6IO95o6l552A6IGK77yMXG4gKiDmjInpkq7mlLbotbfmnaXvvInjgILov5nmmK/pnaLmnb/kuIrllK/kuIDkvJrlkYror4nnlKjmiLfjgIzkvaDnjrDlnKjnnIvnmoTkuI3mmK/mtLvkvJror53jgI3nmoTlnLDmlrnvvIzliKvnnIHjgIJcbiAqL1xuZnVuY3Rpb24gcmVuZGVySGlzdG9yeUJhcihzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGJhciA9IHN0YXRlLmhpc3RvcnlCYXI7XG4gICAgaWYgKCFiYXIpIHJldHVybjtcbiAgICBjb25zdCBoaXN0b3J5ID0gc3RhdGUuc25hcHNob3Q/Lmhpc3RvcnkgPz8gbnVsbDtcbiAgICBpZiAoIWhpc3RvcnkpIHtcbiAgICAgICAgYmFyLmhpZGRlbiA9IHRydWU7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYmFyLmhpZGRlbiA9IGZhbHNlO1xuICAgIGJhci5kYXRhc2V0LmxpdmUgPSBoaXN0b3J5LmxpdmUgPyAndHJ1ZScgOiAnZmFsc2UnO1xuICAgIGNvbnN0IHdoZW4gPSBoaXN0b3J5LmNyZWF0ZWRBdCA/IGZvcm1hdFRpbWUoaGlzdG9yeS5jcmVhdGVkQXQpIDogJ+aXtumXtOacquefpSc7XG4gICAgaWYgKHN0YXRlLmhpc3RvcnlCYXJUZXh0KSB7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlCYXJUZXh0LnRleHRDb250ZW50ID0gaGlzdG9yeS5saXZlXG4gICAgICAgICAgICA/IGDlt7LmjqXkuIrljoblj7LkvJror50gJHtoaXN0b3J5LnNlc3Npb25JZC5zbGljZSgwLCA4KX3igKbvvIgke3doZW5977yJwrcg5o6l5LiL5p2l55qE5raI5oGv5bim552A5a6D55qE5LiK5LiL5paHYFxuICAgICAgICAgICAgOiBg5Y6G5Y+y5Lya6K+d77yI5Y+q6K+75Zue5pS+77yJ77yaJHtoaXN0b3J5LnRpdGxlfe+8iCR7d2hlbn0gwrcgJHtoaXN0b3J5Lm1lc3NhZ2VDb3VudH0g5p2h6K6w5b2V77yJYDtcbiAgICB9XG4gICAgaWYgKHN0YXRlLnJlc3VtZUJ1dHRvbikgc3RhdGUucmVzdW1lQnV0dG9uLmhpZGRlbiA9IGhpc3RvcnkubGl2ZSA9PT0gdHJ1ZTtcbn1cblxuLyoqIOaJk+W8gC/liLfmlrDljoblj7Lmir3lsYnvvIgqKuaAu+aYr+WbnuWIsOWIl+ihqCoq77ya5pCc57Si54q25oCB5bGe5LqO5LiA5qyh5Lqk5LqS77yM5LiN6K+l6Leo5byA5YWz5rS7552A77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBvcGVuSGlzdG9yeShzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHN0YXRlLmhpc3RvcnlPcGVuID0gdHJ1ZTtcbiAgICBpZiAoc3RhdGUuaGlzdG9yeSkgc3RhdGUuaGlzdG9yeS5oaWRkZW4gPSBmYWxzZTtcbiAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoID0gbnVsbDtcbiAgICBzdGF0ZS5oaXN0b3J5Q29uZmlybSA9IG51bGw7XG4gICAgc3luY0hpc3RvcnlDb250cm9scyhzdGF0ZSk7XG4gICAgYXdhaXQgcmVmcmVzaEhpc3Rvcnkoc3RhdGUpO1xufVxuXG4vKiog5oq95bGJ5aS06YOo6YKj5Yeg5Liq5o6n5Lu26Lef552A44CM5b2T5YmN5piv5YiX6KGo6L+Y5piv5pCc57Si57uT5p6cIC8g5pyJ5rKh5pyJ5Zyo5b+Z44CN6LCD5pW044CCICovXG5mdW5jdGlvbiBzeW5jSGlzdG9yeUNvbnRyb2xzKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3Qgc2VhcmNoaW5nID0gc3RhdGUuaGlzdG9yeVNlYXJjaCAhPT0gbnVsbDtcbiAgICBpZiAoc3RhdGUuYnRuSGlzdG9yeVNlYXJjaCkge1xuICAgICAgICBzdGF0ZS5idG5IaXN0b3J5U2VhcmNoLmRpc2FibGVkID0gc3RhdGUuaGlzdG9yeUJ1c3k7XG4gICAgICAgIHN0YXRlLmJ0bkhpc3RvcnlTZWFyY2gudGV4dENvbnRlbnQgPSBzdGF0ZS5oaXN0b3J5QnVzeSA/ICfmkJzntKLkuK3igKYnIDogJ+aQnOWFqOaWhyc7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5idG5IaXN0b3J5QmFjaykgc3RhdGUuYnRuSGlzdG9yeUJhY2suaGlkZGVuID0gIXNlYXJjaGluZztcbiAgICBpZiAoc3RhdGUuaGlzdG9yeVNlYXJjaEVsKSBzdGF0ZS5oaXN0b3J5U2VhcmNoRWwucGxhY2Vob2xkZXIgPSBzZWFyY2hpbmcgPyAn562b6YCJ5qCH6aKY4oCm77yIRXNjIOi/lOWbnuWIl+ihqO+8iScgOiAn562b6YCJ5qCH6aKY4oCm77yIRW50ZXIgPSDmkJzlhajmlofvvIknO1xuICAgIGlmIChzdGF0ZS5idG5IaXN0b3J5UmVmcmVzaEVsKSBzdGF0ZS5idG5IaXN0b3J5UmVmcmVzaEVsLmRpc2FibGVkID0gc3RhdGUuaGlzdG9yeUJ1c3k7XG59XG5cbi8qKiDph43mlrDor7vkuIDpgY3liJfooajvvIjkuI3liqjmkJzntKLnirbmgIHvvInjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIGxvYWRIaXN0b3J5TGlzdChzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSkge1xuICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS50ZXh0Q29udGVudCA9ICfor7vlj5bkuK3igKbvvIjnm7TmjqXor7sgJERTSF9IT01FL3Nlc3Npb25z77yM5LiN6ZyA6KaBIGFnZW50IOWcqOi3ke+8iSc7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLmRhdGFzZXQudG9uZSA9ICcnO1xuICAgIH1cbiAgICBsZXQgcmVwbHk6IEhpc3RvcnlMaXN0UmVwbHk7XG4gICAgdHJ5IHtcbiAgICAgICAgcmVwbHkgPSBhd2FpdCBjYWxsPEhpc3RvcnlMaXN0UmVwbHk+KE1TRy5oaXN0b3J5TGlzdCwgeyBsaW1pdDogMzAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmVwbHkgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnJvcikgfTtcbiAgICB9XG4gICAgc3RhdGUuaGlzdG9yeVNlc3Npb25zID0gcmVwbHkuc2Vzc2lvbnMgPz8gW107XG4gICAgcmVuZGVySGlzdG9yeUxpc3Qoc3RhdGUsIHJlcGx5KTtcbn1cblxuLyoqIOaMieOAjOW9k+WJjeaYr+WIl+ihqOi/mOaYr+aQnOe0oue7k+aenOOAjemHjeeUu+aKveWxie+8iOWIoOWujCAvIOWvvOWHuuWujOiwg+eUqOWug++8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEhpc3Rvcnkoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoc3RhdGUuaGlzdG9yeVNlYXJjaCkge1xuICAgICAgICBhd2FpdCBydW5IaXN0b3J5U2VhcmNoKHN0YXRlLCBzdGF0ZS5oaXN0b3J5U2VhcmNoLnF1ZXJ5LCB0cnVlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCBsb2FkSGlzdG9yeUxpc3Qoc3RhdGUpO1xufVxuXG4vKipcbiAqIOeUu+WOhuWPsuWIl+ihqO+8iOaMieaQnOe0ouahhumHjOeahOivjSoq5Y+q562b5qCH6aKY5ZKMIGlkKirvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjmnKzlnLDnrZvogIzkuI3mmK/orqnkuLvov5vnqIvnrZvvvJrov5nkuIDmoaPmmK/jgIzlnKjmiJHmiYvovrnov5nlh6DmnaHph4zmjJHkuIDmnaHjgI3vvIznuq/lrZfnrKbkuLLljLnphY3vvIxcbiAqIOmbtuW7tui/n++8m+ecn+ato+mcgOimgeivu+ejgeebmOeahOaYryBg5pCc5YWo5paHYO+8iOWPpuS4gOS4quaMiemSruOAgeWPpuS4gOS7vemihOeul+OAgeWPpuS4gOWll+ivmuWunueahOimhueblueOh+ivtOaYju+8ieOAglxuICovXG5mdW5jdGlvbiByZW5kZXJIaXN0b3J5TGlzdChzdGF0ZTogVWlTdGF0ZSwgcmVwbHk6IEhpc3RvcnlMaXN0UmVwbHkpOiB2b2lkIHtcbiAgICBjb25zdCBsaXN0ID0gc3RhdGUuaGlzdG9yeUxpc3Q7XG4gICAgaWYgKCFsaXN0KSByZXR1cm47XG4gICAgbGlzdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGNvbnN0IGFsbCA9IHJlcGx5LnNlc3Npb25zID8/IFtdO1xuICAgIGNvbnN0IHNob3duID0gZmlsdGVyU2Vzc2lvbnMoYWxsLCBzdGF0ZS5oaXN0b3J5UXVlcnkpO1xuXG4gICAgaWYgKHN0YXRlLmhpc3RvcnlOb3RlKSB7XG4gICAgICAgIGlmICghcmVwbHkub2spIHtcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLnRleHRDb250ZW50ID0gYOivu+WPluWksei0pe+8miR7cmVwbHkuZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YDtcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLmRhdGFzZXQudG9uZSA9ICdlcnJvcic7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS50ZXh0Q29udGVudCA9XG4gICAgICAgICAgICAgICAgYCR7YWxsLmxlbmd0aH0g5p2h5Lya6K+d77yI5oyJ5pyA5ZCO5L+u5pS55pe26Ze05YCS5bqP77yJYCArXG4gICAgICAgICAgICAgICAgKHN0YXRlLmhpc3RvcnlRdWVyeSA/IGAgwrcg5qCH6aKY562b5Ye6ICR7c2hvd24ubGVuZ3RofSDmnaFgIDogJycpICtcbiAgICAgICAgICAgICAgICAnIMK3IOeCueS4gOadoeWPquivu+WbnuaUvu+8jOWPs+S4i+inkuWPr+S7peWvvOWHuiAvIOWIoOmZpCc7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS5kYXRhc2V0LnRvbmUgPSAnJztcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoIXJlcGx5Lm9rKSByZXR1cm47XG5cbiAgICBmb3IgKGNvbnN0IHNlc3Npb24gb2Ygc2hvd24pIGxpc3QuYXBwZW5kQ2hpbGQoaGlzdG9yeVJvdyhzdGF0ZSwgc2Vzc2lvbikpO1xuICAgIGlmIChzaG93bi5sZW5ndGggPT09IDApIHtcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIGVsKCdkaXYnLCAnZHNoLWhpc3RvcnktZW1wdHknLCBhbGwubGVuZ3RoID09PSAwID8gJ+i/meS4quW3peeoi+i/mOayoeacieWOhuWPsuS8muivneOAgicgOiAn5rKh5pyJ5qCH6aKY5Yy56YWN55qE5Lya6K+dIOKAlOKAlCDor5Xor5XjgIzmkJzlhajmlofjgI3vvIjlroPov57lhoXlrrnkuIDotbfmkJzvvInjgIInKSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKiDmkJzntKLmoYbph4znmoTor40g4oaSIOWRveS4reeahOS8muivne+8iOWkp+Wwj+WGmeS4jeaVj+aEn++8jOagh+mimOS4jiBpZCDpg73nrpfvvInjgIIgKi9cbmZ1bmN0aW9uIGZpbHRlclNlc3Npb25zKHNlc3Npb25zOiBIaXN0b3J5U2Vzc2lvblZpZXdbXSwgcXVlcnk6IHN0cmluZyk6IEhpc3RvcnlTZXNzaW9uVmlld1tdIHtcbiAgICBjb25zdCBuZWVkbGUgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIW5lZWRsZSkgcmV0dXJuIHNlc3Npb25zO1xuICAgIHJldHVybiBzZXNzaW9ucy5maWx0ZXIoXG4gICAgICAgIChzZXNzaW9uKSA9PiBzZXNzaW9uLnRpdGxlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlKSB8fCBzZXNzaW9uLmlkLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlKSxcbiAgICApO1xufVxuXG4vKipcbiAqIOeUu+S4gOadoeS8muivne+8iOWIl+ihqOS4juaQnOe0oue7k+aenOWFseeUqO+8ieOAglxuICpcbiAqIOKaoCDooYwqKuS4jeiDvSoq5pW05Liq5piv5LiA6aKXIGA8YnV0dG9uPmDvvJrph4zpnaLmnInlr7zlh7ov5Yig6Zmk5oyJ6ZKu77yM5oyJ6ZKu5aWX5oyJ6ZKu5pei5piv6Z2e5rOVIEhUTUzvvIxcbiAqIOeCueWHu+S6i+S7tuS5n+S8muS6kuebuOaJk+aetuOAguaJgOS7peWkluWjs+aYryBgZGl2YO+8jOWPr+eCueeahOmDqOWIhuaYr+mHjOmdoumCo+milyBgLmRzaC1oaXN0b3J5LW9wZW5g44CCXG4gKi9cbmZ1bmN0aW9uIGhpc3RvcnlSb3coc3RhdGU6IFVpU3RhdGUsIHNlc3Npb246IEhpc3RvcnlTZXNzaW9uVmlldyk6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCByb3cgPSBlbCgnZGl2JywgJ2RzaC1oaXN0b3J5LWl0ZW0nKTtcbiAgICByb3cuZGF0YXNldC5jdXJyZW50ID0gc2Vzc2lvbi5jdXJyZW50ID8gJ3RydWUnIDogJ2ZhbHNlJztcbiAgICByb3cuZGF0YXNldC5pZCA9IHNlc3Npb24uaWQ7XG5cbiAgICBjb25zdCBvcGVuID0gZWwoJ2J1dHRvbicsICdkc2gtaGlzdG9yeS1vcGVuJyk7XG4gICAgb3Blbi50eXBlID0gJ2J1dHRvbic7XG4gICAgb3Blbi50aXRsZSA9IHNlc3Npb24uaWQ7XG4gICAgb3Blbi5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1oaXN0b3J5LWl0ZW0tdGl0bGUnLCBzZXNzaW9uLnRpdGxlIHx8ICco5peg5qCH6aKYKScpKTtcbiAgICBvcGVuLmFwcGVuZENoaWxkKFxuICAgICAgICBlbChcbiAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgJ2RzaC1oaXN0b3J5LWl0ZW0tbWV0YScsXG4gICAgICAgICAgICBgJHtmb3JtYXRUaW1lKHNlc3Npb24udXBkYXRlZEF0KX0gwrcgJHtzZXNzaW9uLnR1cm5zfSDova4gwrcgJHtmb3JtYXRCeXRlcyhzZXNzaW9uLmJ5dGVzKX1gICtcbiAgICAgICAgICAgICAgICAoc2Vzc2lvbi5jdXJyZW50ID8gJyDCtyDmraPlnKjmmL7npLonIDogJycpLFxuICAgICAgICApLFxuICAgICk7XG4gICAgb3Blbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgb3Blbkhpc3RvcnlTZXNzaW9uKHN0YXRlLCBzZXNzaW9uLmlkKSk7XG4gICAgcm93LmFwcGVuZENoaWxkKG9wZW4pO1xuICAgIHJvdy5hcHBlbmRDaGlsZChoaXN0b3J5QWN0aW9ucyhzdGF0ZSwgc2Vzc2lvbi5pZCkpO1xuICAgIHJldHVybiByb3c7XG59XG5cbi8qKlxuICog5LiA5p2h5Lya6K+d5Y+z5LiL6KeS6YKj5Yeg5Liq5Yqo5L2c77ya5a+85Ye6IG1kIC8g5a+85Ye6IGpzb25sIC8g5a+85Ye6IFpJUCAvIOWIoOmZpOOAglxuICpcbiAqIOWIoOmZpOaYryoq5Lik5q615byPKirvvIhgaGlzdG9yeUNvbmZpcm1g77yJ77ya56ys5LiA5LiL5Y+q5ou/5riF5Y2V77yM56ys5LqM5LiL5omN55yf5Yig44CCXG4gKiDliJLph43ngrnnmoTljp/lm6DvvJrliKDkvJror53mmK/kuI3lj6/pgIbnmoTvvIzogIzlroPnprvjgIzngrnlvIDnnIvnnIvjgI3lj6rlt67ljYHlh6DkuKrlg4/ntKDjgIJcbiAqXG4gKiAjIyDkuInkuKrlr7zlh7rkuLrku4DkuYjmmK/kuInkuKrmjInpkq7vvIzogIzkuI3mmK/jgIzlr7zlh7ogKyDkuKTkuKrlvIDlhbPjgI1cbiAqXG4gKiDlroPku6wqKuS4jeaYr+WQjOS4gOS7tuS6i+eahOS4ieenjeagvOW8jyoq77yM6ICM5piv5LiJ56eN55So6YCU77yaXG4gKiBgbWRgIOe7meS6uuivu+OAgWBqc29ubGAg57uZ5bel5YW35ZCD77yI6Kej5Y6L5ZCO5Y6f5qC377yJ44CBYHppcGAgKirlr7npvZAgRFNIIOWumOaWueWvvOWHuioqXG4gKiDvvIhgc2Vzc2lvbi5qc29ubGAgKyBgc3ViYWdlbnRzLzxpZD4vc2Vzc2lvbi5qc29ubGAgKyBgbWVkaWEvPGhleD4uPGV4dD5g77yJ44CCXG4gKiDlkI7ogIUqKum7mOiupOWwseW4puWtkOWtmeS4jumZhOS7tuWDj+e0oCoq77yI6YKj5Lu95biD5bGA5pys5p2l5bCx5piv6L+Z5LiJ5qC377yJ77yM6ICM5LiUKirmhaLlvpflpJoqKiDigJTigJRcbiAqIOWBmuaIkOW8gOWFs+eahOivne+8jOeUqOaIt+S8muS7peS4uuOAjOWvvOWHuiArIOWLvumAiSA9IOi/mOaYr+WQjOS4gOS4quaWh+S7tuOAje+8jOiAjOS4jeaYr+OAjOWkmui3keS4gOi2n+WHoOWIhumSn+eahOa0u+OAjeOAglxuICovXG5mdW5jdGlvbiBoaXN0b3J5QWN0aW9ucyhzdGF0ZTogVWlTdGF0ZSwgc2Vzc2lvbklkOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gICAgY29uc3QgYm94ID0gZWwoJ2RpdicsICdkc2gtaGlzdG9yeS1hY3Rpb25zJyk7XG4gICAgY29uc3QgY29uZmlybSA9IHN0YXRlLmhpc3RvcnlDb25maXJtICYmIHN0YXRlLmhpc3RvcnlDb25maXJtLmlkID09PSBzZXNzaW9uSWQgPyBzdGF0ZS5oaXN0b3J5Q29uZmlybSA6IG51bGw7XG5cbiAgICBpZiAoY29uZmlybSkge1xuICAgICAgICBib3guZGF0YXNldC5jb25maXJtID0gJ3RydWUnO1xuICAgICAgICAvKipcbiAgICAgICAgICog56Gu6K6k5p2h5LiK55qE6YKj5Y+l6K+d5pivKirmi7zlh7rmnaUqKueahO+8jOS4jeaYr+S4gOWPpeWbuuWumuaWh+ahiO+8muWLvuS6huOAjOmhuuW4puWbnuaUtumZhOS7tuOAjeS5i+WQju+8jFxuICAgICAgICAgKiDnlKjmiLfopoHnnIvliLDnmoTmmK/jgIzkvJrnrYnlpJrkuYXjgIHov5nkuIDotp/lpKfmpoLopoHlubLku4DkuYjjgI3igJTigJQg6ICM5Zue5pS25pivKirliIbpkp/nuqcqKueahFxuICAgICAgICAgKiDvvIjmnKzmnLogNDk4IOadoeS8muivnSAvIDU2OSBNQiDlhajlupPmiavmj4/vvJrop6PljosgNjAuOCDnp5IgKyDop6PmnpAgOC4yIOenku+8ie+8jFxuICAgICAgICAgKiDkuI3lhYjor7TmuIXmpZrnmoTor53vvIzmjInkuIvljrvkuYvlkI7pgqPlh6DliIbpkp/nnIvotbfmnaXlsLHlg4/ljaHmrbvkuobjgIJcbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IHBhcnRzID0gW2DliKDpmaTov5nmnaHkvJror53vvJ8ke2NvbmZpcm0uZmlsZUNvdW50fSDkuKrmlofku7YgwrcgJHtmb3JtYXRCeXRlcyhjb25maXJtLmJ5dGVzKX1gXTtcbiAgICAgICAgcGFydHMucHVzaCgn5Zu+54mH6ZmE5Lu26buY6K6k5LiN6Lef552A5YigJyk7XG4gICAgICAgIGlmIChjb25maXJtLnJlY2xhaW0pIHBhcnRzLnB1c2goJ+mhuuW4puWbnuaUtuaXoOW8leeUqOmZhOS7tu+8iOimgeWFqOW6k+aJq+S4gOmBje+8jOmAmuW4uCAxfjIg5YiG6ZKf77yJJyk7XG4gICAgICAgIGJveC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtaGlzdG9yeS1jb25maXJtLXRleHQnLCBwYXJ0cy5qb2luKCcgwrcgJykpKTtcblxuICAgICAgICAvKipcbiAgICAgICAgICog44CM6aG65bim5Zue5pS26ZmE5Lu244CN55qE5Yu+77yaKirpu5jorqTkuI3li74qKuOAglxuICAgICAgICAgKlxuICAgICAgICAgKiDkuLrku4DkuYjkuI3pu5jorqTvvJrpmYTku7bmmK8qKuS4jeWPr+mHjeW7uioq55qE77yIYGRzaC1hdHRhY2htZW50LWxvY2FsL1JFQURNRS5tZGDvvJoqXCJJbWFnZXMgYXJlIGtlcHRcbiAgICAgICAgICogZm9yZXZlciDigKYgbm90aGluZyBjb2xsZWN0cyB1bnJlZmVyZW5jZWQgb2JqZWN0c1wiKu+8ie+8jOiAjOaIkeS7rOeahOWbnuaUtuacieS4gOadoeehrOWPo+W+hOaYr1xuICAgICAgICAgKiDjgIzlhajlupPmiavmj4/otoXpooTnrpcg4oeSIOS4gOS4qumDveS4jeaQrOOAjeOAguaJgOS7peWug+W/hemhu+aYryoq55So5oi35piO56Gu6KaBKirnmoTkuovvvIxcbiAgICAgICAgICog6ICM5LiN5piv5Yig6Zmk5pe26aG65omL5Y+R55Sf55qE5LqL44CCXG4gICAgICAgICAqIOWLvuS4ii/lj5bmtojpg73lj6rliqggYGhpc3RvcnlDb25maXJtLnJlY2xhaW1gIOKAlOKAlCAqKua4heWNleimgemHjeaLvyoq77yI5YCZ6YCJ5pWw5Lya5Y+Y77yJ77yMXG4gICAgICAgICAqIOaJgOS7pei/memHjOWGjei3keS4gOasoSBkcnktcnVu77yM6ICM5LiN5piv5bCx5Zyw5pS55Liq5biD5bCU44CCXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCByZWNsYWltTGFiZWwgPSBlbCgnbGFiZWwnLCAnZHNoLWhpc3RvcnktcmVjbGFpbScpO1xuICAgICAgICBjb25zdCByZWNsYWltQm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICAgICAgcmVjbGFpbUJveC50eXBlID0gJ2NoZWNrYm94JztcbiAgICAgICAgcmVjbGFpbUJveC5jaGVja2VkID0gY29uZmlybS5yZWNsYWltID09PSB0cnVlO1xuICAgICAgICByZWNsYWltQm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIHZvaWQgZGVsZXRlSGlzdG9yeVNlc3Npb24oc3RhdGUsIHNlc3Npb25JZCwgdHJ1ZSwgcmVjbGFpbUJveC5jaGVja2VkKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJlY2xhaW1MYWJlbC5hcHBlbmQocmVjbGFpbUJveCwgZWwoJ3NwYW4nLCAnJywgJ+mhuuW4puWbnuaUtuaXoOW8leeUqOmZhOS7ticpKTtcblxuICAgICAgICBjb25zdCB5ZXMgPSBlbCgnYnV0dG9uJywgJ2RzaC1taW5pLWJ0biBkc2gtbWluaS1kYW5nZXInLCAn56Gu6K6k5Yig6ZmkJyk7XG4gICAgICAgIHllcy50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIHllcy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgZGVsZXRlSGlzdG9yeVNlc3Npb24oc3RhdGUsIHNlc3Npb25JZCwgZmFsc2UsIGNvbmZpcm0ucmVjbGFpbSA9PT0gdHJ1ZSkpO1xuICAgICAgICBjb25zdCBubyA9IGVsKCdidXR0b24nLCAnZHNoLW1pbmktYnRuJywgJ+WPlua2iCcpO1xuICAgICAgICBuby50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIG5vLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgc3RhdGUuaGlzdG9yeUNvbmZpcm0gPSBudWxsO1xuICAgICAgICAgICAgdm9pZCByZWZyZXNoSGlzdG9yeShzdGF0ZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBib3guYXBwZW5kKHJlY2xhaW1MYWJlbCwgeWVzLCBubyk7XG4gICAgICAgIHJldHVybiBib3g7XG4gICAgfVxuXG4gICAgY29uc3QgbWQgPSBlbCgnYnV0dG9uJywgJ2RzaC1taW5pLWJ0bicsICdtZCcpO1xuICAgIG1kLnR5cGUgPSAnYnV0dG9uJztcbiAgICBtZC50aXRsZSA9ICflr7zlh7rmiJAgbWFya2Rvd24g6L2s5YaZ77yI6JC95ZyoICREU0hfSE9NRS9leHBvcnRzLzzlt6XnqIvplK4+L++8iSc7XG4gICAgbWQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIGV4cG9ydEhpc3RvcnlTZXNzaW9uKHN0YXRlLCBzZXNzaW9uSWQsICdtZCcpKTtcblxuICAgIGNvbnN0IGpzb25sID0gZWwoJ2J1dHRvbicsICdkc2gtbWluaS1idG4nLCAnanNvbmwnKTtcbiAgICBqc29ubC50eXBlID0gJ2J1dHRvbic7XG4gICAganNvbmwudGl0bGUgPSAn5a+85Ye65oiQ5Y6f5aeL5pel5b+X77yI6Kej5Y6L5ZCO5LiA6KGM5LiA5LqL5Lu277yM5LiN5oqV5b2x5LiN5oiq5pat77yJJztcbiAgICBqc29ubC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgZXhwb3J0SGlzdG9yeVNlc3Npb24oc3RhdGUsIHNlc3Npb25JZCwgJ2pzb25sJykpO1xuXG4gICAgY29uc3QgemlwID0gZWwoJ2J1dHRvbicsICdkc2gtbWluaS1idG4nLCAnemlwJyk7XG4gICAgemlwLnR5cGUgPSAnYnV0dG9uJztcbiAgICB6aXAudGl0bGUgPVxuICAgICAgICAn5a+85Ye65oiQIFpJUO+8iOWvuem9kCBEU0gg5a6Y5pa56YKj5LiA5Lu977yac2Vzc2lvbi5qc29ubCArIHN1YmFnZW50cy88aWQ+L3Nlc3Npb24uanNvbmwgKyBtZWRpYS886ZmE5Lu2Pu+8ie+8jCcgK1xuICAgICAgICAn5ZCr5a2Q5Lya6K+d5LiO6ZmE5Lu25YOP57Sg77yM5q+U5Y+m5aSW5Lik56eN5oWiJztcbiAgICB6aXAuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIGV4cG9ydEhpc3RvcnlTZXNzaW9uKHN0YXRlLCBzZXNzaW9uSWQsICd6aXAnKSk7XG5cbiAgICBjb25zdCByZW1vdmUgPSBlbCgnYnV0dG9uJywgJ2RzaC1taW5pLWJ0biBkc2gtbWluaS1kYW5nZXInLCAn5YigJyk7XG4gICAgcmVtb3ZlLnR5cGUgPSAnYnV0dG9uJztcbiAgICByZW1vdmUudGl0bGUgPSAn5Yig6Zmk6L+Z5p2h5Lya6K+d77yI5Lya5YWI6Zeu5LiA5qyh77yM5bm25oql5Ye66KaB5Yig5Yeg5Liq5paH5Lu277yJJztcbiAgICByZW1vdmUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIGRlbGV0ZUhpc3RvcnlTZXNzaW9uKHN0YXRlLCBzZXNzaW9uSWQsIHRydWUpKTtcblxuICAgIGJveC5hcHBlbmQobWQsIGpzb25sLCB6aXAsIHJlbW92ZSk7XG4gICAgcmV0dXJuIGJveDtcbn1cblxuLyoqIOWFs+mXreWOhuWPsuaKveWxieOAgiAqL1xuZnVuY3Rpb24gY2xvc2VIaXN0b3J5KHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgc3RhdGUuaGlzdG9yeU9wZW4gPSBmYWxzZTtcbiAgICBzdGF0ZS5oaXN0b3J5Q29uZmlybSA9IG51bGw7XG4gICAgaWYgKHN0YXRlLmhpc3RvcnkpIHN0YXRlLmhpc3RvcnkuaGlkZGVuID0gdHJ1ZTtcbn1cblxuLyoqXG4gKiDngrnkuIDmnaHljoblj7LkvJror53vvJrorqnkuLvov5vnqIvor7vml6Xlv5flubblm57mlL7vvIjlj6ror7vvvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAqIEBwYXJhbSBqdW1wVG8gLSDlj6/pgInvvIzlm57mlL7lrozmu5rliLDov5nmnaEqKuS6i+S7tiBzZXEqKu+8iOWFqOaWh+aQnOe0ouWRveS4reaXtueUqO+8ieOAglxuICovXG5hc3luYyBmdW5jdGlvbiBvcGVuSGlzdG9yeVNlc3Npb24oc3RhdGU6IFVpU3RhdGUsIHNlc3Npb25JZDogc3RyaW5nLCBqdW1wVG8/OiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoc3RhdGUuaGlzdG9yeU5vdGUpIHN0YXRlLmhpc3RvcnlOb3RlLnRleHRDb250ZW50ID0gJ+ato+WcqOivu+aXpeW/l+W5tuWbnuaUvuKApu+8iOWkp+aXpeW/l+S8mueojeaFou+8iSc7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBjYWxsPHsgb2s6IGJvb2xlYW47IGV2ZW50cz86IG51bWJlcjsgZW50cnlTZXE/OiBudW1iZXI7IGVycm9yPzogc3RyaW5nIH0+KE1TRy5oaXN0b3J5T3Blbiwge1xuICAgICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgICAganVtcFRvLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyZXBseT8ub2spIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSkge1xuICAgICAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLnRleHRDb250ZW50ID0gYOWbnuaUvuWksei0pe+8miR7cmVwbHk/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWA7XG4gICAgICAgICAgICAgICAgc3RhdGUuaGlzdG9yeU5vdGUuZGF0YXNldC50b25lID0gJ2Vycm9yJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjbG9zZUhpc3Rvcnkoc3RhdGUpO1xuICAgICAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xuICAgICAgICAvLyDlm57mlL7mmK/jgIzkuLvov5vnqIvovazlhpnku6PmlbAgKzHjgI3nmoTlia/kvZznlKjvvIzov5nph4zkuLvliqjmi4nkuIDmrKHvvIzliKvorqnnlKjmiLfnm6/nnYDnqbrnmb3nrYnova7or6LjgIJcbiAgICAgICAgLy8g6L+Z5LiA5ouJ5Lya6aG65bimIGByZXNldFVpYCDigJTigJQg5omA5Lul44CM6KaB5rua5Yiw55qE6YKj5LiA5p2h44CN5b+F6aG7KirlnKjov5nkuIDmraXkuYvlkI4qKuaJjeijheS4iu+8jFxuICAgICAgICAvLyDlkKbliJnkvJrooqsgYHJlc2V0VWlgIOW9k+Wcuua4heaOie+8iOmCo+ato+aYr+Wug+ivpeWBmueahO+8mua4heaOieeahOaYr+S4iuS4gOS4quS8muivneeahOaXp+ebruagh++8ieOAglxuICAgICAgICBhd2FpdCBwb2xsT25jZShzdGF0ZSk7XG4gICAgICAgIGlmICh0eXBlb2YgcmVwbHkuZW50cnlTZXEgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAvLyDmjaLnrpflpb3nmoQqKui9rOWGmeadoeebruWPtyoq77yI5pel5b+X5LqL5Lu25LiO6Z2i5p2/5p2h55uu5piv5Lik5aWX57yW5Y+377yM5Lit6Ze06ZqU552A5LiA5bGC5oqV5b2x77yaXG4gICAgICAgICAgICAvLyBgdG9vbC9yZXN1bHRgIOWPquaKiue7k+aenOihpei/m+W3suacieWNoeeJh+OAgWBzZXNzaW9uL3RpdGxlYCDmoLnmnKzkuI3kuIrlsY/vvIlcbiAgICAgICAgICAgIHN0YXRlLmp1bXBUbyA9IHJlcGx5LmVudHJ5U2VxO1xuICAgICAgICAgICAgYXBwbHlKdW1wKHN0YXRlKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSkge1xuICAgICAgICAgICAgc3RhdGUuaGlzdG9yeU5vdGUudGV4dENvbnRlbnQgPSBg5Zue5pS+5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWA7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS5kYXRhc2V0LnRvbmUgPSAnZXJyb3InO1xuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqIOi3keS4gOasoeWFqOaWh+aQnOe0ou+8iOivu+ejgeebmO+8jOaciemihOeul++8ieOAglxuICpcbiAqIEBwYXJhbSBzdGF0ZSAtIOmdouadv+eKtuaAgeOAglxuICogQHBhcmFtIHF1ZXJ5IC0g5p+l6K+i5Liy44CCXG4gKiBAcGFyYW0gc2lsZW50IC0g6Z2Z6buY6YeN6LeR77yI5Yig5a6ML+WvvOWHuuWujOWIt+aWsOaXtueUqO+8muS4jeaKiiBub3RlIOaUueaIkOOAjOaQnOe0ouS4reKApuOAje+8ieOAglxuICovXG5hc3luYyBmdW5jdGlvbiBydW5IaXN0b3J5U2VhcmNoKHN0YXRlOiBVaVN0YXRlLCBxdWVyeTogc3RyaW5nLCBzaWxlbnQgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHRleHQgPSBxdWVyeS50cmltKCk7XG4gICAgaWYgKCF0ZXh0KSB7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlTZWFyY2ggPSBudWxsO1xuICAgICAgICBzeW5jSGlzdG9yeUNvbnRyb2xzKHN0YXRlKTtcbiAgICAgICAgYXdhaXQgbG9hZEhpc3RvcnlMaXN0KHN0YXRlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuaGlzdG9yeUJ1c3kpIHJldHVybjtcbiAgICBzdGF0ZS5oaXN0b3J5QnVzeSA9IHRydWU7XG4gICAgc3RhdGUuaGlzdG9yeUNvbmZpcm0gPSBudWxsO1xuICAgIHN5bmNIaXN0b3J5Q29udHJvbHMoc3RhdGUpO1xuICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSAmJiAhc2lsZW50KSB7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLnRleHRDb250ZW50ID0gYOato+WcqOaQnOOAjCR7dGV4dH3jgI3igKbvvIjnm7TmjqXor7vnm5jvvJvkvJror53lpJrnmoTml7blgJnmnIDlpJrlh6Dnp5LvvIlgO1xuICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS5kYXRhc2V0LnRvbmUgPSAnJztcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBjYWxsPEhpc3RvcnlTZWFyY2hSZXBseT4oTVNHLmhpc3RvcnlTZWFyY2gsIHtcbiAgICAgICAgICAgIHF1ZXJ5OiB0ZXh0LFxuICAgICAgICAgICAgLy8g6aKE566X5pivKirpnaLmnb8qKue7meeahO+8muWug+efpemBk+iHquW3seWcqOetieWkmuS5heOAguS4iumZkOeUseS4u+i/m+eoi+WGjeWkueS4gOmBk+OAglxuICAgICAgICAgICAgbGltaXQ6IDIwLFxuICAgICAgICAgICAgcGVyU2Vzc2lvbjogMyxcbiAgICAgICAgICAgIG1heFNlc3Npb25zOiAxNTAsXG4gICAgICAgICAgICBidWRnZXRNczogNjAwMCxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVwbHk/Lm9rKSB7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoID0gbnVsbDtcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlCdXN5ID0gZmFsc2U7XG4gICAgICAgICAgICBzeW5jSGlzdG9yeUNvbnRyb2xzKHN0YXRlKTtcbiAgICAgICAgICAgIHJlbmRlckhpc3RvcnlMaXN0KHN0YXRlLCB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJyB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoID0ge1xuICAgICAgICAgICAgcXVlcnk6IHJlcGx5LnF1ZXJ5ID8/IHRleHQsXG4gICAgICAgICAgICBoaXRzOiByZXBseS5oaXRzID8/IFtdLFxuICAgICAgICAgICAgc2Nhbm5lZDogcmVwbHkuc2Nhbm5lZCA/PyAwLFxuICAgICAgICAgICAgYXZhaWxhYmxlOiByZXBseS5hdmFpbGFibGUgPz8gMCxcbiAgICAgICAgICAgIHBhcnRpYWw6IHJlcGx5LnBhcnRpYWwgPT09IHRydWUsXG4gICAgICAgICAgICBzdG9wcGVkQnk6IHJlcGx5LnN0b3BwZWRCeSA/PyBudWxsLFxuICAgICAgICAgICAgZWxhcHNlZE1zOiByZXBseS5lbGFwc2VkTXMgPz8gMCxcbiAgICAgICAgICAgIHNjYW5uZWRCeXRlczogcmVwbHkuc2Nhbm5lZEJ5dGVzID8/IDAsXG4gICAgICAgIH07XG4gICAgICAgIHJlbmRlclNlYXJjaFJlc3VsdHMoc3RhdGUpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlTZWFyY2ggPSBudWxsO1xuICAgICAgICByZW5kZXJIaXN0b3J5TGlzdChzdGF0ZSwgeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyb3IpIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlCdXN5ID0gZmFsc2U7XG4gICAgICAgIHN5bmNIaXN0b3J5Q29udHJvbHMoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqIOWBnOatouWOn+WboOaYr+e7meS6uueci+eahOS4gOWPpeivne+8iOivtOS4jea4heWwseS4jeivtO+8jOWIq+e8lu+8ieOAgiAqL1xuZnVuY3Rpb24gc3RvcHBlZFRleHQoc3RvcHBlZEJ5OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgICBzd2l0Y2ggKHN0b3BwZWRCeSkge1xuICAgICAgICBjYXNlICdsaW1pdCc6XG4gICAgICAgICAgICByZXR1cm4gJ+W3sue7j+aJvuWkn+i/meS5iOWkmuadoeWwseaUtuW3peS6hu+8iOabtOiAgeeahOi/mOayoeeci++8iSc7XG4gICAgICAgIGNhc2UgJ3Nlc3Npb25zJzpcbiAgICAgICAgICAgIHJldHVybiAn5Yiw44CM5pyA5aSa55yL5Yeg5Liq5Lya6K+d44CN55qE5LiK6ZmQ5bCx5YGc5LqGJztcbiAgICAgICAgY2FzZSAnYnl0ZXMnOlxuICAgICAgICAgICAgcmV0dXJuICfliLDjgIzmnIDlpJror7vlpJrlsJHlrZfoioLjgI3nmoTkuIrpmZDlsLHlgZzkuoYnO1xuICAgICAgICBjYXNlICd0aW1lJzpcbiAgICAgICAgICAgIHJldHVybiBg5Yiw5pe26Ze06aKE566X5bCx5YGc5LqGYDtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHJldHVybiAnJztcbiAgICB9XG59XG5cbi8qKlxuICog55S75pCc57Si57uT5p6c44CCXG4gKlxuICog4pqgIOimhueblueOh+mCo+S4gOihjOaYryoq6L+Z5Liq5Yqf6IO96YeM5pyA6KaB57Sn55qE5LiA5Y+lKirvvJrmkJzntKLmmK/mnInpooTnrpfnmoTvvIzjgIzmib7liLAgMyDmnaHjgI3kuI5cbiAqIOOAjOWcqCAxMDcg5Liq5Lya6K+d6YeM5om+5YiwIDMg5p2h44CN5piv5a6M5YWo5LiN5ZCM55qE5Lik5Lu25LqL44CC5YGc5q2i5Y6f5ZugICsg5omr5LqG5aSa5bCRICsg6Iqx5LqG5aSa5LmFICtcbiAqIOivu+S6huWkmuWwkeWtl+iKguWFqOWGmeWHuuadpe+8jOeUqOaIt+aJjeefpemBk+ivpeS4jeivpeaKiuWFs+mUruivjeWGmee7huS4gOeCueWGjeaQnOS4gOasoeOAglxuICovXG5mdW5jdGlvbiByZW5kZXJTZWFyY2hSZXN1bHRzKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgbGlzdCA9IHN0YXRlLmhpc3RvcnlMaXN0O1xuICAgIGNvbnN0IGZvdW5kID0gc3RhdGUuaGlzdG9yeVNlYXJjaDtcbiAgICBpZiAoIWxpc3QgfHwgIWZvdW5kKSByZXR1cm47XG4gICAgbGlzdC50ZXh0Q29udGVudCA9ICcnO1xuXG4gICAgaWYgKHN0YXRlLmhpc3RvcnlOb3RlKSB7XG4gICAgICAgIGNvbnN0IGNvdmVyZWQgPSBg5omr5LqGICR7Zm91bmQuc2Nhbm5lZH0vJHtmb3VuZC5hdmFpbGFibGV9IOS4quS8muivnSDCtyAke2Zvcm1hdEJ5dGVzKGZvdW5kLnNjYW5uZWRCeXRlcyl9IMK3ICR7Zm91bmQuZWxhcHNlZE1zfSBtc2A7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLnRleHRDb250ZW50ID0gZm91bmQucGFydGlhbFxuICAgICAgICAgICAgPyBg44CMJHtmb3VuZC5xdWVyeX3jgI3lkb3kuK0gJHtmb3VuZC5oaXRzLmxlbmd0aH0g5p2hIOKAlOKAlCDimqAg5rKh5pCc5a6M77yaJHtzdG9wcGVkVGV4dChmb3VuZC5zdG9wcGVkQnkpfe+8iCR7Y292ZXJlZH3vvInjgILlhbPplK7or43lhpnnu4bkuIDngrnog73mkJzlvpfmm7Tlv6vmm7Tlh4bjgIJgXG4gICAgICAgICAgICA6IGDjgIwke2ZvdW5kLnF1ZXJ5feOAjeWRveS4rSAke2ZvdW5kLmhpdHMubGVuZ3RofSDmnaEgwrcg5pW05Liq5bel56iL6YO95omr6L+H5LqG77yIJHtjb3ZlcmVkfe+8iWA7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLmRhdGFzZXQudG9uZSA9IGZvdW5kLnBhcnRpYWwgPyAnd2FybicgOiAnJztcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGhpdCBvZiBmb3VuZC5oaXRzKSBsaXN0LmFwcGVuZENoaWxkKHNlYXJjaEhpdFJvdyhzdGF0ZSwgaGl0KSk7XG4gICAgaWYgKGZvdW5kLmhpdHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICBlbChcbiAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAnZHNoLWhpc3RvcnktZW1wdHknLFxuICAgICAgICAgICAgICAgIGZvdW5kLnBhcnRpYWxcbiAgICAgICAgICAgICAgICAgICAgPyAn6L+Z5Yeg5p2h6YeM5rKh5pyJIOKAlOKAlCDkvYbkuI3mmK/jgIzmlbTkuKrlt6XnqIvpg73msqHmnInjgI3vvJrov5nmrKHmsqHmkJzlrozvvIjop4HkuIrpnaLpgqPooYzvvInjgIInXG4gICAgICAgICAgICAgICAgICAgIDogJ+aVtOS4quW3peeoi+mDveayoeaciei/meS4quivjeOAgicsXG4gICAgICAgICAgICApLFxuICAgICAgICApO1xuICAgIH1cbn1cblxuLyoqIOeUu+S4gOadoeaQnOe0ouWRveS4re+8iOagh+mimCArIOWFg+S/oeaBryArIOeJh+autSArIOWQjOS4gOWll+WKqOS9nOaMiemSru+8ieOAgiAqL1xuZnVuY3Rpb24gc2VhcmNoSGl0Um93KHN0YXRlOiBVaVN0YXRlLCBoaXQ6IEhpc3RvcnlTZWFyY2hIaXRWaWV3KTogSFRNTEVsZW1lbnQge1xuICAgIGNvbnN0IHJvdyA9IGVsKCdkaXYnLCAnZHNoLWhpc3RvcnktaXRlbSBkc2gtaGlzdG9yeS1oaXQnKTtcblxuICAgIGNvbnN0IG9wZW4gPSBlbCgnYnV0dG9uJywgJ2RzaC1oaXN0b3J5LW9wZW4nKTtcbiAgICBvcGVuLnR5cGUgPSAnYnV0dG9uJztcbiAgICBvcGVuLnRpdGxlID0gYCR7aGl0LmlkfVxcbueCueS4gOS4i+WPquivu+WbnuaUvu+8jOW5tua7muWIsOWRveS4reeahOmCo+S4gOadoWA7XG4gICAgb3Blbi5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1oaXN0b3J5LWl0ZW0tdGl0bGUnLCBoaXQudGl0bGUgfHwgJyjml6DmoIfpopgpJykpO1xuICAgIG9wZW4uYXBwZW5kQ2hpbGQoXG4gICAgICAgIGVsKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICAnZHNoLWhpc3RvcnktaXRlbS1tZXRhJyxcbiAgICAgICAgICAgIGAke2Zvcm1hdFRpbWUoaGl0LnVwZGF0ZWRBdCl9IMK3ICR7aGl0LnR1cm5zfSDova4gwrcgJHtmb3JtYXRCeXRlcyhoaXQuYnl0ZXMpfSDCtyDlkb3kuK0gJHtoaXQuaGl0c30g5qyhYCxcbiAgICAgICAgKSxcbiAgICApO1xuICAgIC8vIOeCuee7k+aenCA9IOaJk+W8gCArIOa7muWIsOWRveS4reeahOmCo+S4gOadoe+8iGBzZXFgIOaYryoq5LqL5Lu2Kirlj7fvvIzkuLvov5vnqIvlm57mlL7ml7bmjaLnrpfmiJDmnaHnm67lj7fvvIlcbiAgICBvcGVuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBvcGVuSGlzdG9yeVNlc3Npb24oc3RhdGUsIGhpdC5pZCwgaGl0LnNlcSkpO1xuICAgIHJvdy5hcHBlbmRDaGlsZChvcGVuKTtcblxuICAgIGNvbnN0IHNuaXBwZXRzID0gZWwoJ2RpdicsICdkc2gtaGlzdG9yeS1zbmlwcGV0cycpO1xuICAgIGZvciAoY29uc3Qgc25pcHBldCBvZiBoaXQuc25pcHBldHMpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGVsKCdkaXYnLCAnZHNoLWhpc3Rvcnktc25pcHBldCcpO1xuICAgICAgICBsaW5lLmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1oaXN0b3J5LXNuaXBwZXQtbGFiZWwnLCBzbmlwcGV0LmxhYmVsKSk7XG4gICAgICAgIGxpbmUuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLWhpc3Rvcnktc25pcHBldC10ZXh0Jywgc25pcHBldC5zbmlwcGV0KSk7XG4gICAgICAgIHNuaXBwZXRzLmFwcGVuZENoaWxkKGxpbmUpO1xuICAgIH1cbiAgICByb3cuYXBwZW5kQ2hpbGQoc25pcHBldHMpO1xuICAgIHJvdy5hcHBlbmRDaGlsZChoaXN0b3J5QWN0aW9ucyhzdGF0ZSwgaGl0LmlkKSk7XG4gICAgcmV0dXJuIHJvdztcbn1cblxuLyoqIOOAjOe7p+e7reatpOS8muivneOAje+8muiuqeaPkuS7tueUqCBgYWdlbnRzLnJlc3VtZWAg55yf5o6l5LiK77yI5LmL5ZCO6IO95o6l552A6IGK77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiByZXN1bWVIaXN0b3J5KHN0YXRlOiBVaVN0YXRlLCBzZXNzaW9uSWQ/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBzZXRCYW5uZXIoc3RhdGUsICfmraPlnKjmjqXkuIrkvJror53igKbvvIhEU0gg5L6nIGFnZW50cy5yZXN1bWXvvIzopoHliqDovb3ov5nmrrXljoblj7LvvIknLCAnaW5mbycpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+KFxuICAgICAgICAgICAgTVNHLmhpc3RvcnlSZXN1bWUsXG4gICAgICAgICAgICBzZXNzaW9uSWQgPyB7IHNlc3Npb25JZCB9IDogdW5kZWZpbmVkLFxuICAgICAgICApO1xuICAgICAgICBpZiAoIXJlcGx5Py5vaykgc2V0QmFubmVyKHN0YXRlLCBg5o6l5LiK5aSx6LSl77yaJHtyZXBseT8uZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YCwgJ2Vycm9yJyk7XG4gICAgICAgIGVsc2Ugc2V0QmFubmVyKHN0YXRlLCBudWxsKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDmjqXkuIrlpLHotKXvvJoke1N0cmluZyhlcnJvcil9YCwgJ2Vycm9yJyk7XG4gICAgfVxuICAgIGF3YWl0IHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG59XG5cbi8qKlxuICog5a+85Ye677yI5oiW5Yig6Zmk77yJ5LmL5ZCO55qE6YKj5Y+l5o+Q56S644CCXG4gKlxuICog5Li65LuA5LmI6LWwKirpobbpg6jmqKrluYUqKuiAjOS4jeaYr+aKveWxiemHjOeahCBub3Rl77ya5oq95bGJ6ams5LiK6KaB6YeN55S777yI5Yi35paw5YiX6KGo77yJ77yMXG4gKiDlhpnov5sgbm90ZSDnmoTpgqPlj6Xor53kvJrooqvkuIvkuIDmrKEgYHJlbmRlckhpc3RvcnlMaXN0YCDopobnm5bmjonvvJvogIzjgIzmlofku7blhpnlk6rlhL/kuobjgI1cbiAqIOaYr+eUqOaIt+mprOS4iuimgeeUqOeahOS4nOilv++8iOWOu+i1hOa6kOeuoeeQhuWZqOmHjOaJvuWug++8ie+8jOW/hemhu+acieWcsOaWueeVmeW+l+S9j+OAglxuICovXG5mdW5jdGlvbiBoaXN0b3J5QmFubmVyKHN0YXRlOiBVaVN0YXRlLCB0ZXh0OiBzdHJpbmcsIHRvbmU6ICdpbmZvJyB8ICdlcnJvcicpOiB2b2lkIHtcbiAgICBzZXRCYW5uZXIoc3RhdGUsIHRleHQsIHRvbmUsIHVuZGVmaW5lZCwgMTJfMDAwKTtcbn1cblxuLyoqXG4gKiDlr7zlh7rov5nmnaHkvJror53jgIJcbiAqXG4gKiDlr7zlh7rnianokL3lnKggYDxEU0hfSE9NRT4vZXhwb3J0cy885bel56iL6ZSuPi9g77yIKirkuI3lvoDlt6XnqIvph4zlhpkqKu+8muWug+aYr+OAjOeci+S4gOecvOWwseWIoOOAjeeahOS4nOilv++8jFxuICog5omU6L+b5bel56iL5Y+q5Lya5rGh5p+TIGdpdO+8ie+8jOaJgOS7pei/memHjOimgeaKiue7neWvuei3r+W+hOaYvuekuuWHuuadpSDigJTigJQg5ZCm5YiZ55So5oi35qC55pys5om+5LiN5Yiw5paH5Lu244CCXG4gKlxuICogIyMg5LiJ56eN5qC85byP55qE5qiq5bmF6K+d5pyv5LiN5ZCM77yIYG1kYCAvIGBqc29ubGAgLyBgemlwYO+8iVxuICpcbiAqIOWJjeS4pOenjeaYr+OAjOS4gOS4quaWh+S7tuOAgeWHoOS4h+adoeS6i+S7tuOAje+8jOS4gOWPpeivneWwseWkn+OAgmB6aXBgICoq5LiN5pivKirvvJpcbiAqIOWug+WQq+WtkOWtmeS8muivneS4jumZhOS7tuWDj+e0oO+8jOiAjOS4lOacieS4ieS7tuW/hemhu+S4gOi1t+ivtOWHuuadpeeahOS6iyDigJTigJRcbiAqIOKRoCDph4zpnaLliLDlupXoo4Xkuobku4DkuYjvvIjlrZDlrZnlh6DkuKrjgIEqKuWFtuS4reWtkCBhZ2VudCDkuI4gZm9yayDlkITlh6DkuKoqKuOAgemZhOS7tuWHoOS4qu+8ie+8m1xuICog4pGhIOiEmuacrOS6pOS7o+eahOazqOaEj+S6i+mhue+8iOWwpOWFtuOAjOW9k+WJjea0u+i3g+S8muivneWPr+iDveWwkeacgOWQjuWHoOadoeOAje+8mkRTSCDlr7zlh7rliY3kvJrlhYggZmx1c2jvvIzmiJHku6zlgZrkuI3liLDvvInvvJtcbiAqIOKRoiDmnInlvJXnlKjkvYbor7vkuI3liLDmlofku7bnmoTpmYTku7bvvIhgbWlzc2luZ01lZGlhYO+8ieKAlOKAlCDpgqPmmK8qKue8uuS6huS4nOilvyoq77yM5LiN5piv44CM5pys5p2l5bCx5rKh5pyJ44CN44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4cG9ydEhpc3RvcnlTZXNzaW9uKHN0YXRlOiBVaVN0YXRlLCBzZXNzaW9uSWQ6IHN0cmluZywgZm9ybWF0OiAnbWQnIHwgJ2pzb25sJyB8ICd6aXAnKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2xvdyA9IGZvcm1hdCA9PT0gJ3ppcCc7XG4gICAgaGlzdG9yeUJhbm5lcihcbiAgICAgICAgc3RhdGUsXG4gICAgICAgIHNsb3cgPyAn5q2j5Zyo5a+85Ye6IFpJUOKApu+8iOimgeino+WOi+WtkOWtmeS8muivneaXpeW/l+OAgeivu+mZhOS7tuWDj+e0oO+8jOWkp+S8muivneS8muaFou+8iScgOiBg5q2j5Zyo5a+85Ye6ICR7Zm9ybWF0feKApu+8iOWkp+aXpeW/l+imgeivu+WujOaVtOS7ve+8iWAsXG4gICAgICAgICdpbmZvJyxcbiAgICApO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7XG4gICAgICAgICAgICBvazogYm9vbGVhbjtcbiAgICAgICAgICAgIHBhdGg/OiBzdHJpbmc7XG4gICAgICAgICAgICBieXRlcz86IG51bWJlcjtcbiAgICAgICAgICAgIGV2ZW50cz86IG51bWJlcjtcbiAgICAgICAgICAgIGVycm9yPzogc3RyaW5nO1xuICAgICAgICAgICAgc3ViYWdlbnRzPzogeyB0b3RhbDogbnVtYmVyOyBzdWJhZ2VudENvdW50OiBudW1iZXI7IGZvcmtDb3VudDogbnVtYmVyOyBtYXhEZXB0aDogbnVtYmVyIHwgbnVsbDsgZGFuZ2xpbmc6IHN0cmluZ1tdOyBpbmNvbXBsZXRlOiBib29sZWFuIH07XG4gICAgICAgICAgICBtZWRpYT86IHsgY291bnQ6IG51bWJlcjsgbWlzc2luZzogbnVtYmVyOyBuYW1pbmdEZXZpYXRpb246IHN0cmluZyB8IG51bGwgfTtcbiAgICAgICAgICAgIG1pc3NpbmdNZWRpYT86IHN0cmluZ1tdO1xuICAgICAgICAgICAgbm90ZXM/OiBzdHJpbmdbXTtcbiAgICAgICAgfT4oTVNHLmhpc3RvcnlFeHBvcnQsIHsgc2Vzc2lvbklkLCBmb3JtYXQgfSk7XG4gICAgICAgIGlmICghcmVwbHk/Lm9rKSB7XG4gICAgICAgICAgICBoaXN0b3J5QmFubmVyKHN0YXRlLCBg5a+85Ye65aSx6LSl77yaJHtyZXBseT8uZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YCwgJ2Vycm9yJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaGVhZCA9IGDlt7Llr7zlh7ogJHtyZXBseS5ldmVudHMgPz8gMH0g5p2h77yIJHtmb3JtYXRCeXRlcyhyZXBseS5ieXRlcyA/PyAwKX3vvInihpIgJHtyZXBseS5wYXRoID8/ICc/J31gO1xuICAgICAgICBpZiAoIXNsb3cpIHtcbiAgICAgICAgICAgIGhpc3RvcnlCYW5uZXIoc3RhdGUsIGhlYWQsICdpbmZvJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZmFjdHM6IHN0cmluZ1tdID0gW2hlYWRdO1xuICAgICAgICBpZiAocmVwbHkuc3ViYWdlbnRzKSB7XG4gICAgICAgICAgICBjb25zdCBiaXRzID0gW2DlrZDlrZkgJHtyZXBseS5zdWJhZ2VudHMudG90YWx9IOS4qmBdO1xuICAgICAgICAgICAgLy8g4pqgIOWtkCBhZ2VudCDkuI4gZm9yayDliIblvIDor7TvvJrnlKjmiLflhbPlv4PnmoTmmK/jgIzlh6DkuKrmmK/miJHmtL7lh7rljrvnmoQgYWdlbnTjgI1cbiAgICAgICAgICAgIGJpdHMucHVzaChg5YW25Lit5a2QIGFnZW50ICR7cmVwbHkuc3ViYWdlbnRzLnN1YmFnZW50Q291bnR9IMK3IGZvcmsgJHtyZXBseS5zdWJhZ2VudHMuZm9ya0NvdW50fWApO1xuICAgICAgICAgICAgaWYgKHJlcGx5LnN1YmFnZW50cy5tYXhEZXB0aCAhPT0gbnVsbCkgYml0cy5wdXNoKGDmnIDmt7HnrKwgJHtyZXBseS5zdWJhZ2VudHMubWF4RGVwdGh9IOWxgmApO1xuICAgICAgICAgICAgaWYgKHJlcGx5LnN1YmFnZW50cy5kYW5nbGluZy5sZW5ndGggPiAwKSBiaXRzLnB1c2goYOaciSAke3JlcGx5LnN1YmFnZW50cy5kYW5nbGluZy5sZW5ndGh9IOS4queahOeItue6p+WcqOe0ouW8lemHjOaJvuS4jeWIsGApO1xuICAgICAgICAgICAgaWYgKHJlcGx5LnN1YmFnZW50cy5pbmNvbXBsZXRlKSBiaXRzLnB1c2goJ+e0ouW8leaJq+aPj+i2hemihOeul++8jOWtkOWtmeWPr+iDveS4jeWFqCcpO1xuICAgICAgICAgICAgZmFjdHMucHVzaChgWklQIOmHjOeahOS8muivne+8miR7Yml0cy5qb2luKCcgwrcgJyl9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcGx5Lm1lZGlhKSB7XG4gICAgICAgICAgICBmYWN0cy5wdXNoKFxuICAgICAgICAgICAgICAgIGBaSVAg6YeM55qE6ZmE5Lu277yaJHtyZXBseS5tZWRpYS5jb3VudH0g5LiqJHtyZXBseS5tZWRpYS5taXNzaW5nID4gMCA/IGDvvIjlj6bmnIkgJHtyZXBseS5tZWRpYS5taXNzaW5nfSDkuKrlvJXnlKjor7vkuI3liLDmlofku7bvvIlgIDogJyd9YCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcGx5Lm1pc3NpbmdNZWRpYSAmJiByZXBseS5taXNzaW5nTWVkaWEubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZmFjdHMucHVzaChg6K+75LiN5Yiw5paH5Lu255qE6ZmE5Lu277yaJHtyZXBseS5taXNzaW5nTWVkaWEuc2xpY2UoMCwgMykubWFwKChpZCkgPT4gaWQuc2xpY2UoMCwgMTQpKS5qb2luKCfjgIEnKX3igKZgKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVwbHkubm90ZXMgPz8gW10pIGZhY3RzLnB1c2gobGluZSk7XG4gICAgICAgIGhpc3RvcnlCYW5uZXIoc3RhdGUsIGZhY3RzLmpvaW4oJ1xcbicpLCAnaW5mbycpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhpc3RvcnlCYW5uZXIoc3RhdGUsIGDlr7zlh7rlpLHotKXvvJoke1N0cmluZyhlcnJvcil9YCwgJ2Vycm9yJyk7XG4gICAgfVxufVxuXG4vKipcbiAqIOWIoOmZpOi/meadoeS8muivneOAglxuICpcbiAqIGBkcnlSdW46IHRydWVgIOaYryoq56ys5LiA5LiLKirvvJrlj6rorqnkuLvov5vnqIvmiorjgIzopoHliKDlh6DkuKrmlofku7bjgIHlpJrlpKfjgI3miqXlm57mnaXvvIznhLblkI4qKuWcqOihjOWGhSoqXG4gKiDmjaLmiJDnoa7orqTmnaHjgILnrKzkuozkuIvvvIhgZHJ5UnVuOiBmYWxzZWDvvInmiY3nnJ/liKDjgILov5nmoLfljbPkvb/or6/ngrnvvIzmjZ/lpLHnmoTkuZ/lj6rmmK/lpJrnnIvkuIDnnLzjgIJcbiAqXG4gKiBgcmVjbGFpbWAg5piv44CM6aG65bim5Zue5pS25peg5byV55So6ZmE5Lu244CN77yIKirpu5jorqTlhbMqKu+8jOingSBgaGlzdG9yeUFjdGlvbnNgIOmHjOmCo+S4quWLvueahOivtOaYju+8ieOAglxuICog5Lik5p2h5Y+j5b6E77yaXG4gKiAxLiAqKmRyeS1ydW4g5Lmf6KaB5bim5LiK5a6DKiog4oCU4oCUIOWQpuWImeWLvuS4iuS5i+WQjueUqOaIt+eci+S4jeWIsOOAjOWAmemAieWHoOS4qiAvIOiiq+W8leeUqOWHoOS4quOAje+8jFxuICogICAg6ICM6YKj5q2j5piv5Yik5pat44CM6L+Z5LiA6Laf5YC85LiN5YC85b6X562J44CN55qE5ZSv5LiA5L6d5o2u77ybXG4gKiAyLiAqKuecn+WIoOmCo+S4gOi2n+eahOaoquW5heW/hemhu+aKiuWbnuaUtue7k+aenOivtOWFqCoq77ya5YCZ6YCJIC8g5LuN6KKr5byV55SoIC8g5peg5byV55SoIC8g5pCs6LWw5Yeg5Liq77yMXG4gKiAgICDov5jmnInjgIzotoXpooTnrpcg4oeSIOS4gOS4qumDveayoeaQrOOAjeOAguWwkeivtOS4gOWPpemDveS8muiiq+ivu+aIkOOAjOWKn+iDveWdj+S6huOAjeaIluOAjOS4gOmUruiFvuepuumXtOOAjeOAglxuICovXG5hc3luYyBmdW5jdGlvbiBkZWxldGVIaXN0b3J5U2Vzc2lvbihcbiAgICBzdGF0ZTogVWlTdGF0ZSxcbiAgICBzZXNzaW9uSWQ6IHN0cmluZyxcbiAgICBkcnlSdW46IGJvb2xlYW4sXG4gICAgcmVjbGFpbSA9IGZhbHNlLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBjYWxsPHtcbiAgICAgICAgICAgIG9rOiBib29sZWFuO1xuICAgICAgICAgICAgcmVtb3ZlZD86IGJvb2xlYW47XG4gICAgICAgICAgICBmaWxlQ291bnQ/OiBudW1iZXI7XG4gICAgICAgICAgICBieXRlcz86IG51bWJlcjtcbiAgICAgICAgICAgIGNsZWFyZWQ/OiBib29sZWFuO1xuICAgICAgICAgICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgICAgICAgICByZWNsYWltPzoge1xuICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXM6IG51bWJlcjtcbiAgICAgICAgICAgICAgICByZWZlcmVuY2VkOiBudW1iZXI7XG4gICAgICAgICAgICAgICAgb3JwaGFuczogbnVtYmVyO1xuICAgICAgICAgICAgICAgIHRyYXNoZWQ6IG51bWJlcjtcbiAgICAgICAgICAgICAgICBieXRlc0ZyZWVkOiBudW1iZXI7XG4gICAgICAgICAgICAgICAgaW5jb21wbGV0ZTogYm9vbGVhbjtcbiAgICAgICAgICAgICAgICBpbmNvbXBsZXRlUmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICAgICAgICAgIHNjYW5uZWQ6IHsgc2Vzc2lvbnM6IG51bWJlcjsgYnl0ZXM6IG51bWJlcjsgZWxhcHNlZE1zOiBudW1iZXIgfTtcbiAgICAgICAgICAgICAgICBza2lwcGVkOiBBcnJheTx7IGlkOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfT4oTVNHLmhpc3RvcnlEZWxldGUsIHsgc2Vzc2lvbklkLCBkcnlSdW4sIHJlY2xhaW0gfSk7XG5cbiAgICAgICAgaWYgKCFyZXBseT8ub2spIHtcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlDb25maXJtID0gbnVsbDtcbiAgICAgICAgICAgIGhpc3RvcnlCYW5uZXIoc3RhdGUsIGDliKDpmaTlpLHotKXvvJoke3JlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gLCAnZXJyb3InKTtcbiAgICAgICAgICAgIGF3YWl0IHJlZnJlc2hIaXN0b3J5KHN0YXRlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Q29uZmlybSA9IHtcbiAgICAgICAgICAgICAgICBpZDogc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgIGZpbGVDb3VudDogcmVwbHkuZmlsZUNvdW50ID8/IDAsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IHJlcGx5LmJ5dGVzID8/IDAsXG4gICAgICAgICAgICAgICAgcmVjbGFpbSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhd2FpdCByZWZyZXNoSGlzdG9yeShzdGF0ZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBzdGF0ZS5oaXN0b3J5Q29uZmlybSA9IG51bGw7XG4gICAgICAgIGNvbnN0IGxpbmVzID0gW1xuICAgICAgICAgICAgYOW3suWIoOmZpOS8muivnSAke3Nlc3Npb25JZC5zbGljZSgwLCA4KX3igKbvvIgke3JlcGx5LmZpbGVDb3VudCA/PyAwfSDkuKrmlofku7YgwrcgJHtmb3JtYXRCeXRlcyhyZXBseS5ieXRlcyA/PyAwKX3vvIlgLFxuICAgICAgICBdO1xuICAgICAgICBpZiAocmVwbHkucmVjbGFpbSkge1xuICAgICAgICAgICAgY29uc3QgciA9IHJlcGx5LnJlY2xhaW07XG4gICAgICAgICAgICBsaW5lcy5wdXNoKFxuICAgICAgICAgICAgICAgIGDpmYTku7blm57mlLbvvJrlgJnpgIkgJHtyLmNhbmRpZGF0ZXN9IOS4qiDihpIgJHtyLnJlZmVyZW5jZWR9IOS4quS7jeiiq+WIq+eahOS8muivneW8leeUqOOAgSR7ci5vcnBoYW5zfSDkuKrlt7Lml6DlvJXnlKgg4oaSIOaQrOi/m+Wik+eikSAke3IudHJhc2hlZH0g5Liq77yIJHtmb3JtYXRCeXRlcyhyLmJ5dGVzRnJlZWQpfe+8iWAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgbGluZXMucHVzaChcbiAgICAgICAgICAgICAgICBg5YWo5bqT5omr5LqGICR7ci5zY2FubmVkLnNlc3Npb25zfSDmnaHkvJror53vvIgke2Zvcm1hdEJ5dGVzKHIuc2Nhbm5lZC5ieXRlcyl9IC8gJHtNYXRoLnJvdW5kKHIuc2Nhbm5lZC5lbGFwc2VkTXMgLyAxMDAwKX0g56eS77yJYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoci5pbmNvbXBsZXRlKSB7XG4gICAgICAgICAgICAgICAgbGluZXMucHVzaChg5Zue5pS26KKr5Lit5pat77yIJHtyLmluY29tcGxldGVSZWFzb24gPz8gJ+i2hemihOeulyd977yJ4oCU4oCUIOS4gOS4qumDveayoeaQrO+8muWIpOaNruS4jeWFqOaXtuivr+WIoOS4jeWPr+mAhu+8jOi/meaYr+acieaEj+eahGApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyLnRyYXNoZWQgPT09IDApIHtcbiAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKCfov5nmrKHmsqHmnInlj6/lm57mlLbnmoTpmYTku7bvvIjlgJnpgInph4zmr4/kuIDkuKrpg73ov5jooqvliKvnmoTkvJror53lvJXnlKjnnYDvvIknKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNraXBwZWQgPSByLnNraXBwZWQuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkucmVhc29uICE9PSAnc3RpbGwtcmVmZXJlbmNlZCcpO1xuICAgICAgICAgICAgaWYgKHNraXBwZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goYOi3s+i/hyAke3NraXBwZWQubGVuZ3RofSDkuKrvvIjkuI3mmK9cIui/mOWcqOeUqFwi77yM5piv5Yir55qE5a6I5Y2r5oum5LiL55qE77yJ77yaJHtza2lwcGVkLnNsaWNlKDAsIDMpLm1hcCgoZW50cnkpID0+IGVudHJ5LnJlYXNvbikuam9pbign44CBJyl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKCflm77niYfpmYTku7bmmK/lhajlsYDljrvph43nmoTvvIzkuI3pmo/kvJror53liKDpmaTvvIjli77jgIzpobrluKblm57mlLbml6DlvJXnlKjpmYTku7bjgI3miY3kvJrljrvmn6XkuIDpgY3vvIknKTtcbiAgICAgICAgfVxuICAgICAgICBoaXN0b3J5QmFubmVyKHN0YXRlLCBsaW5lcy5qb2luKCdcXG4nKSwgJ2luZm8nKTtcbiAgICAgICAgaWYgKHJlcGx5LmNsZWFyZWQpIHNldEJhbm5lcihzdGF0ZSwgYOW3suWIoOmZpOato+WcqOWbnuaUvueahOmCo+adoeS8muivne+8iCR7c2Vzc2lvbklkLnNsaWNlKDAsIDgpfeKApu+8ieKAlOKAlCDlr7nor53ljLrlt7LmuIXnqbrjgIJgLCAnaW5mbycsIHVuZGVmaW5lZCwgOF8wMDApO1xuICAgICAgICBhd2FpdCByZWZyZXNoSGlzdG9yeShzdGF0ZSk7XG4gICAgICAgIGF3YWl0IHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgICAgIGF3YWl0IHBvbGxPbmNlKHN0YXRlKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzdGF0ZS5oaXN0b3J5Q29uZmlybSA9IG51bGw7XG4gICAgICAgIGhpc3RvcnlCYW5uZXIoc3RhdGUsIGDliKDpmaTlpLHotKXvvJoke1N0cmluZyhlcnJvcil9YCwgJ2Vycm9yJyk7XG4gICAgICAgIGF3YWl0IHJlZnJlc2hIaXN0b3J5KHN0YXRlKTtcbiAgICB9XG59XG5cbi8qKlxuICog44CM5pCc5Yiw55qE5bCx5piv6L+Z5LiA5p2h44CN77ya5Zue5pS+5a6M5rua6L+H5Y675bm26auY5Lqu5Yeg56eS44CCXG4gKlxuICog55SxIGBhcHBseUVudHJpZXNgIOWcqCoq5p2h55uu55yf55qE5Yiw5LqG6Z2i5p2/5LiKKirkuYvlkI7osIPvvIjlm57mlL7mmK/kuLvov5vnqIvnmoTlia/kvZznlKjvvIxcbiAqIOadoeebruimgeetieS4i+S4gOasoSBgZ2V0LWV2ZW50c2Ag5omN5Zue5p2l77yM5omA5Lul5LiN6IO95Zyo6L+Z6YeM5a6a5pe2562J77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGFwcGx5SnVtcChzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGlmIChzdGF0ZS5qdW1wVG8gPT09IG51bGwpIHJldHVybjtcbiAgICBjb25zdCBlbGVtZW50ID0gc3RhdGUuZWxzLmdldChzdGF0ZS5qdW1wVG8pO1xuICAgIGlmICghZWxlbWVudCkgcmV0dXJuO1xuICAgIHN0YXRlLmp1bXBUbyA9IG51bGw7XG4gICAgZWxlbWVudC5kYXRhc2V0LmhpdCA9ICd0cnVlJztcbiAgICBlbGVtZW50LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6ICdjZW50ZXInIH0pO1xuICAgIGlmIChzdGF0ZS5qdW1wVGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5qdW1wVGltZXIpO1xuICAgIHN0YXRlLmp1bXBUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBkZWxldGUgZWxlbWVudC5kYXRhc2V0LmhpdDtcbiAgICAgICAgc3RhdGUuanVtcFRpbWVyID0gbnVsbDtcbiAgICB9LCA0MDAwKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDnlKjph49cbi8vXG4vLyDmlbDmja7lhajpg6jmnaXoh6oqKuS4u+i/m+eoi+ivu+WbnuadpeeahCoq6YKj5LiA5Lu9IGBTZXNzaW9uVXNhZ2Vg77yI6K+755qE5pivIERTSCDnmoTkvJror53mipXlvbHnvJPlrZjvvIxcbi8vIOingSBgc291cmNlL3N0YXRzLnRzYO+8ieOAgumdouadv+i/meS4gOS+p+WPquacieS4ieadoee6quW+i++8mlxuLy9cbi8vIDEuICoq5Y+q55S75LiN566XKirvvJrljaDnlKjnjofjgIHnvKnlhpnjgIHml7bplb/pg73mmK/kuLvov5vnqIvnu5nnmoTmlbDkuI4gYGNvbnN0YW50cy50c2Ag6YeM55qE5Lik5Liq5qC85byP5YyW5Ye95pWw44CCXG4vLyAgICDpnaLmnb/oh6rlt7Hlho3nrpfkuIDpgY3lv4XnhLbkuI7kuLvov5vnqIvnmoTlj6PlvoTmvILnp7vvvIjogIzkuJTkuKTlpITpg71cIueci+i1t+adpeWvuVwi77yJ44CCXG4vLyAyLiAqKm51bGwg55S75oiQ44CM4oCU44CN5bm26K+05piOKirvvIznu53kuI3ooaUgMCDigJTigJQgMCUg5Y2g55So5ZKM44CM5LiN55+l6YGT5Y2g55So5aSa5bCR44CN5piv5Lik5Lu25LqL77yMXG4vLyAgICDov5nkuKrpnaLmnb/kuIrmnIDkuI3og73lh7rnjrDnmoTosI7lsLHmmK/lroPjgIJcbi8vIDMuICoq5Y+j5b6E6K+05piO6Lef552A5pWw5a2X5LiA6LW35pi+56S6KirvvJrpgqPkupsgbm90ZXMg5LiN5piv6KOF6aWw77yM5piv6K6p5pWw5a2X5Y+v5Yik6K+755qE6YOo5YiGXG4vLyAgICDvvIjmo4Dmn6XngrnmmK/mlJLnnYDlhpnnmoTjgIHnu4TmiJDmmK/kvLDnrpfnmoTjgIHoirHotLnopoHor7vkuKTkuKrmlofku7bvvInjgIJcblxuLyoqIOWNoOeUqOeOh+eahOminOiJsuaho++8mjYwJSDotbfmj5DphpLjgIE4NSUg6LW35oql6K2m77yI6YO95piv44CM6K+l5oOz5oOz5Y6L57yp5LqG44CN55qE5L+h5Y+377yJ44CCICovXG5mdW5jdGlvbiB1c2FnZVRvbmUocmF0aW86IG51bWJlciB8IG51bGwpOiAnJyB8ICd3YXJuJyB8ICdkYW5nZXInIHtcbiAgICBpZiAocmF0aW8gPT09IG51bGwgfHwgIU51bWJlci5pc0Zpbml0ZShyYXRpbykpIHJldHVybiAnJztcbiAgICBpZiAocmF0aW8gPj0gMC44NSkgcmV0dXJuICdkYW5nZXInO1xuICAgIGlmIChyYXRpbyA+PSAwLjYpIHJldHVybiAnd2Fybic7XG4gICAgcmV0dXJuICcnO1xufVxuXG4vKipcbiAqIOeKtuaAgeihjOmCo+milyBjaGlwIOS4iuWGmeS7gOS5iO+8iOWGmeS4jeWHuuS4nOilv+Wwsei/lOWbniBudWxsID0g5pW06aKX6JeP6LW35p2l77yJ44CCXG4gKlxuICog5LyY5YWI57qn77yaKirljaDnlKjnjocqKu+8iOS4gOecvOiDveavlOWkp+Wwj++8ieKGkiDpgIDliLDjgIzntK/orqHov5vlh7rjgI3vvIjoh7PlsJHor7TmmI7mnInmlbDmja7vvInihpIg5LuA5LmI6YO95rKh5pyJ44CCXG4gKiDkuLrku4DkuYjkuI3mmL7npLogYDAlYO+8mmBwcm9qZWN0ZWRgIOaYryBudWxsIOaXtuWNoOeUqOeOh+aYryoq5LiN55+l6YGTKirvvIzkuI3mmK8gMOOAglxuICovXG5mdW5jdGlvbiB1c2FnZUNoaXBUZXh0KHVzYWdlOiBTZXNzaW9uVXNhZ2UgfCBudWxsKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgaWYgKCF1c2FnZSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgeyByYXRpbywgd2luZG93LCBwcm9qZWN0ZWQgfSA9IHVzYWdlLmNvbnRleHQ7XG4gICAgaWYgKHJhdGlvICE9PSBudWxsICYmIHdpbmRvdyAhPT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gYOS4iuS4i+aWhyAkeyhyYXRpbyAqIDEwMCkudG9GaXhlZCgxKX0lYDtcbiAgICB9XG4gICAgY29uc3QgdG90YWxzID0gdXNhZ2UudXNhZ2UudG90YWxzO1xuICAgIGlmICh0b3RhbHMpIHJldHVybiBg4oaRJHtmb3JtYXRUb2tlbnModG90YWxzLmlucHV0KX0g4oaTJHtmb3JtYXRUb2tlbnModG90YWxzLm91dHB1dCl9YDtcbiAgICBpZiAocHJvamVjdGVkICE9PSBudWxsKSByZXR1cm4gYOS4iuS4i+aWhyAke2Zvcm1hdFRva2Vucyhwcm9qZWN0ZWQpfWA7XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiDnlLvnirbmgIHooYzpgqPpopcgY2hpcO+8iOavj+asoeWIt+eKtuaAgeS4juavj+asoeW5v+aSremDveiwg++8jOW+iOS+v+WunO+8ieOAgiAqL1xuZnVuY3Rpb24gcmVuZGVyVXNhZ2VDaGlwKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgY2hpcCA9IHN0YXRlLnVzYWdlQ2hpcDtcbiAgICBpZiAoIWNoaXApIHJldHVybjtcbiAgICBjb25zdCB1c2FnZSA9IHN0YXRlLnNuYXBzaG90Py51c2FnZSA/PyBudWxsO1xuICAgIGNvbnN0IHRleHQgPSB1c2FnZUNoaXBUZXh0KHVzYWdlKTtcbiAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgY2hpcC5oaWRkZW4gPSB0cnVlO1xuICAgICAgICBjaGlwLnRleHRDb250ZW50ID0gJyc7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2hpcC5oaWRkZW4gPSBmYWxzZTtcbiAgICBjaGlwLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICBjb25zdCB0b25lID0gdXNhZ2VUb25lKHVzYWdlPy5jb250ZXh0LnJhdGlvID8/IG51bGwpO1xuICAgIGNoaXAuZGF0YXNldC50b25lID0gdG9uZTtcbiAgICBjb25zdCByYXRpbyA9IHVzYWdlPy5jb250ZXh0LnJhdGlvID8/IG51bGw7XG4gICAgY29uc3QgcGVyY2VudCA9IHJhdGlvID09PSBudWxsID8gJ+WNoOeUqOeOh+acquefpScgOiBg5Y2g55So546HICR7KHJhdGlvICogMTAwKS50b0ZpeGVkKDEpfSVgO1xuICAgIGNoaXAudGl0bGUgPVxuICAgICAgICBgJHtwZXJjZW50fe+8iOmihOS8sCAke2Zvcm1hdFRva2Vucyh1c2FnZT8uY29udGV4dC5wcm9qZWN0ZWQgPz8gbnVsbCl9IC8g56qX5Y+jICR7Zm9ybWF0VG9rZW5zKHVzYWdlPy5jb250ZXh0LndpbmRvdyA/PyBudWxsKX3vvIlcXG5gICtcbiAgICAgICAgJ+eCueW8gOeci+aYjue7hu+8iHRva2VuIOe0r+iuoSAvIOe7hOaIkCAvIOiAl+aXtiAvIOiKsei0ue+8iSc7XG59XG5cbi8qKiDkuIDooYzjgIzmoIfnrb4g5YC844CN77yb5YC85LiN5piv5pWw5bCx55S744CM4oCU44CN5bm25oqK5a6D5YGa5oiQ54Gw6Imy55qE77yIYG51bGxgIOaYr+acieivneimgeivtOeahO+8jOS4jeaYr+epuueZve+8ieOAgiAqL1xuZnVuY3Rpb24gdXNhZ2VMaW5lKGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcsIG1vbm8gPSBmYWxzZSk6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCBsaW5lID0gZWwoJ2RpdicsICdkc2gtdXNhZ2UtbGluZScpO1xuICAgIGxpbmUuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLXVzYWdlLWxhYmVsJywgbGFiZWwpKTtcbiAgICBjb25zdCB2YWx1ZUVsID0gZWwoJ3NwYW4nLCAnZHNoLXVzYWdlLXZhbHVlJywgdmFsdWUgfHwgJ+KAlCcpO1xuICAgIGlmIChtb25vKSB2YWx1ZUVsLmRhdGFzZXQubW9ubyA9ICd0cnVlJztcbiAgICBsaW5lLmFwcGVuZENoaWxkKHZhbHVlRWwpO1xuICAgIHJldHVybiBsaW5lO1xufVxuXG4vKiog5LiA5Z2X5bim5qCH6aKY55qE6K+05piO44CCICovXG5mdW5jdGlvbiB1c2FnZUJsb2NrKHRpdGxlOiBzdHJpbmcsIGxpbmVzOiBIVE1MRWxlbWVudFtdKTogSFRNTEVsZW1lbnQge1xuICAgIGNvbnN0IGJsb2NrID0gZWwoJ2RpdicsICdkc2gtdXNhZ2UtYmxvY2snKTtcbiAgICBibG9jay5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC11c2FnZS1ibG9jay10aXRsZScsIHRpdGxlKSk7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSBibG9jay5hcHBlbmRDaGlsZChsaW5lKTtcbiAgICByZXR1cm4gYmxvY2s7XG59XG5cbi8qKiDjgIwxLjBNIC8gMS4wTeOAjei/meenjee7meS6uueci+eahOWGmeazle+8iOeql+WPo+acquefpeaXtuS4jeWGmeWBh+eahO+8ieOAgiAqL1xuZnVuY3Rpb24gdXNhZ2VBbW91bnQodmFsdWU6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICAgIHJldHVybiB2YWx1ZSA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0VG9rZW5zKHZhbHVlKTtcbn1cblxuLyoqXG4gKiDoirHotLnpgqPkuIDlnZfnmoTlh6DooYzjgIJcbiAqXG4gKiDkuInku7bkuovliIblvIDnlLvvvIwqKuS4gOS7tumDveS4jeiuuOWQiOW5tioq77yI5ZCI5bm25Ye65p2l55qE5pWw5a2X5rKh5rOV5Yik6K+777yJ77yaXG4gKiDikaAg6LCB6Iqx55qEICsg5pi+56S65oiQ5aSa5bCR6ZKx77yI5biB56eN5LiO5rGH546H5p2l6IeqIGBkc2gtY29zdC1tZXRlcmAg55qE6LSm5pys77yM6Z2i5p2/5LiN6Ieq5bex5o2i566X77yJ77ybXG4gKiDikaEg6LSm5pys5Y6f5YC877yIKirmgZLkuLrnvo7lhYMqKu+8ieS4juaooeWei+iwg+eUqOasoeaVsCDigJTigJQg44CM5oqY566X5piv5oCO5LmI5p2l55qE44CN5b+F6aG755yL5b6X6KeB77ybXG4gKiDikaIg44CM5LuK5pel44CN6YKj5LiA6KGMKirmmK/ov5nlj7DmnLrlmajkuIrmiYDmnInlt6XnqIvliqDotbfmnaXnmoQqKu+8iOi0puacrOWFseS6q++8ie+8jOaJgOS7peagh+etvumHjOWwseWGmeedgOOAglxuICpcbiAqIOS4gOS4qumHkeminemDveayoeacieaXtioq5LiN55S7IDAqKu+8mumCo+WPpeOAjOS4uuS7gOS5iOayoeacieOAjeeUsSBgY29zdC50c2Ag55qEIGBub1JlY29yZE5vdGVgIOWHulxuICog77yI5LiJ56eN5p2l6LevIOKAlOKAlCDkvJror53lpKrogIEgLyDov5nkuKogcHJvZmlsZSDmsqHoo4XpgqPkuKogYnVuZGxlIC8g5Yir55qEIHByb2ZpbGUg55qE5Lya6K+dIOKAlOKAlCDlkITkuIDlj6XvvInvvIxcbiAqIOmdouadv+i/meS4gOWxgioq5LiA5Y+l6K+d6YO95LiN6Ieq5bex57yWKirvvIzlj6rotJ/otKPmiorlroPnlLvlh7rmnaXjgIJcbiAqL1xuZnVuY3Rpb24gY29zdExpbmVzKHVzYWdlOiBTZXNzaW9uVXNhZ2UpOiBIVE1MRWxlbWVudFtdIHtcbiAgICBjb25zdCB0ZXh0ID0gY29zdFRleHRPZih7XG4gICAgICAgIGNvc3Q6IHVzYWdlLmNvc3QsXG4gICAgICAgIGRpc3BsYXk6IHVzYWdlLmNvc3REaXNwbGF5LFxuICAgICAgICBsZWRnZXI6IHVzYWdlLmNvc3RMZWRnZXIsXG4gICAgICAgIG5vdGU6IHVzYWdlLmNvc3ROb3RlLFxuICAgICAgICBtb3VudGVkOiB1c2FnZS5jb3N0TW91bnRlZCxcbiAgICAgICAgYnVuZGxlOiB1c2FnZS5jb3N0QnVuZGxlLFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmVzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgaWYgKHRleHQuYW1vdW50ICE9PSBudWxsKSB7XG4gICAgICAgIGxpbmVzLnB1c2godXNhZ2VMaW5lKHRleHQuaGVhZCwgdGV4dC5hbW91bnQsIHRydWUpKTtcbiAgICAgICAgaWYgKHRleHQudXNkICE9PSBudWxsKSBsaW5lcy5wdXNoKHVzYWdlTGluZSgn6LSm5pys5Y6f5YC877yI576O5YWD77yJJywgdGV4dC51c2QsIHRydWUpKTtcbiAgICAgICAgaWYgKHRleHQuY2FsbHMgIT09IG51bGwpIGxpbmVzLnB1c2godXNhZ2VMaW5lKCfmqKHlnovosIPnlKgnLCB0ZXh0LmNhbGxzKSk7XG4gICAgICAgIGlmICh0ZXh0LnRvZGF5ICE9PSBudWxsKSB7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKHVzYWdlTGluZShg5LuK5pel77yIJHt1c2FnZS5jb3N0TGVkZ2VyPy50b2RheUtleSA/PyAn5LuK5aSpJ33vvIzlhajpg6jlt6XnqIvvvIlgLCB0ZXh0LnRvZGF5LCB0cnVlKSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBub3RlIG9mIHRleHQubm90ZXMpIGxpbmVzLnB1c2goZWwoJ2RpdicsICdkc2gtdXNhZ2Utc291cmNlJywgbm90ZSkpO1xuICAgIHJldHVybiBsaW5lcztcbn1cblxuLyoqXG4gKiDkuIrkuIvmloflop7plb/mm7Lnur/vvJoqKuS4gOagueafsSA9IOS4gOasoeaooeWei+iwg+eUqCoq77yI54K55aSq5aSa5pe25piv5LiA5Liq5Zue5ZCI77yJ77yM5p+x6auY5oyJ5pyA5aSn5YC85b2S5LiA44CCXG4gKlxuICog6L+Z5LiA5Z2X55qE5YWo6YOo5paH5a2X77yI5ZOq5p2h5piv5a6e5rWL44CB5ZOq5p2h5piv5Lyw566X44CB5Li65LuA5LmI5rKh55S744CB6IGa5ZCI5LqG5rKh5pyJ44CBYXJjaGl2ZUZsb29yIOmCo+WPpe+8iVxuICog6YO95ZyoIGBjb25zdGFudHMudHNgIOeahCBgdGltZWxpbmVUZXh0T2ZgIOmHjCDigJTigJQg6YKj5pivKirnuq/lh73mlbAqKu+8jOacieW3suefpeetlOahiOihqFxuICog77yIYHNjcmlwdHMvdmVyaWZ5LXN0YXRzLmpzYCDmi7/lroPot5HvvInvvIzpnaLmnb/ov5nkuIDlsYLlj6rotJ/otKPmiorlroPnlLvlh7rmnaUgKyDmiormn7HlrZDmkYblr7njgIJcbiAqXG4gKiDkuInmnaHlrp7njrDlj6PlvoTvvJpcbiAqIDEuICoq5qiq5ZCR5rua5Yqo44CB5p+x5a695Zu65a6aKirvvJrmn7Hlrr3nlLHosIPnlKjmrKHmlbDlhrPlrprjgIHlrrnlmaggYG92ZXJmbG93LXg6IGF1dG9gXG4gKiAgICDigJTigJQg6K6p5a655Zmo5Y675oyk5p+x5a2Q55qE55S75rOV5Lya5oqK6JC95beu5oq55bmz77yI6ICM6JC95beu5bCx5piv6L+Z5byg5Zu+6KaB55yL55qE5Lic6KW/77yJ77ybXG4gKiAyLiAqKuWOi+e8qeeCueeUu+erlue6vyArIGDinIJgKirvvIzpkonlnKjjgIzljovnvKnkuYvlkI7nmoTpgqPkuIDmoLnmn7HjgI3kuIrvvIjot5/lrr/kuLsgd2lyZSB2aWV3IOeahOaMgui9veinhOWImeS4gOiHtO+8ie+8m1xuICogICAg5ZCM5LiA5qC55p+x5LiK5pyJ5aW95Yeg5aSE5Y6L57yp5pe25Y+q55S75LiA5LiqIGDinIJg77yI5a6D5Lus5piv5ZCM5LiA5p2h56uW57q/77yJ77yM5piO57uG5ZyoIHRpcCDph4zvvJtcbiAqIDMuICoq5Zue5ZCI5YiG5bimKirvvJrmn7HlrZDkuIrmlrnpgqPkuIDmnaHmmK8qKuWbnuWQiOW4pioq77yI5Lqk5pu/5bqV6ImyICsg56ysIE4g6L2u77yJ77yM5omA5Lul44CM5ZOq5LiA5q615piv5ZOq5LiA6L2u44CNXG4gKiAgICDkuIDnnLzog73nnIvlh7rmnaUg4oCU4oCUIOi/meS4gOatpe+8iOesrCAxIOatpeeahOmCo+S4quWbnuW9ku+8ieato+aYr+acgOWuueaYk+eci+S4jeWHuuadpeeahOWcsOaWueOAglxuICpcbiAqIOKaoCDpnaLmnb/ov5nkuIDlsYIqKuS4jeihpeS7u+S9lSAwKirvvJrmn7Hpq5jnlKjnmoTmlbDkuI7lvZLkuIDljJbnmoTliIbmr43pg73mmK8gYFNlc3Npb25Vc2FnZS50aW1lbGluZWAg57uZ55qE77yMXG4gKiDorqTkuI3lh7rnmoTor7fmsYLlnKjor7vlj5blmajph4zlsLHooqvkuKLmjonkuobvvIjlubblnKjor7TmmI7ph4zmiqXlh7rmnaHmlbDvvInjgIJcbiAqL1xuXG4vKiog5LiA5qC55p+x55qE5qiq5ZCR5YOP57Sg77yI5LiA5qyh6LCD55So77yJ44CCKirlm7rlrpoqKu+8muafseWtkOS4jemaj+WuueWZqOS8uOe8qeOAgiAqL1xuY29uc3QgVElNRUxJTkVfU0xPVF9QWCA9IDY7XG5cbi8qKiDogZrlkIjkuYvlkI7nmoTmn7Hlrr3kuIrpmZDvvIjmjInmraXmlbDliqDlrr3vvIzkvYbliKvlrr3liLDkuIDlsY/lj6rliankuKTkuInmoLnvvInjgIIgKi9cbmNvbnN0IFRJTUVMSU5FX1NMT1RfTUFYX1NURVBTID0gNDtcblxuLyoqXG4gKiDkuIDmoLnmn7HljaDnmoTmqKrlkJHlg4/ntKDvvIjlkKsgMXB4IOmXtOmalO+8ieOAglxuICpcbiAqIOKaoCDkuIrpnaLpgqPmjpIqKuWbnuWQiOW4pioq5b+F6aG755SoKirlkIzkuIDkuKoqKuWHveaVsOeul+WuveW6pu+8jOWQpuWImeS4pOaOkuS8mui2iuW3rui2iui/nFxuICog77yI5pyA5ZCO5LiA5qC55p+x5a+55LiN5LiK5a6D55qE5Zue5ZCI5bim77yM6ICM6YKj5q2j5piv44CM5ZOq5LiA5q615piv5ZOq5LiA6L2u44CN55qE5ZSv5LiA5L6d5o2u77yJ44CCXG4gKi9cbmZ1bmN0aW9uIHRpbWVsaW5lU2xvdFdpZHRoKHBvaW50OiBUaW1lbGluZVBvaW50Vmlldyk6IG51bWJlciB7XG4gICAgY29uc3Qgc3RlcHMgPSBNYXRoLm1pbihNYXRoLm1heChwb2ludC5zdGVwcywgMSksIFRJTUVMSU5FX1NMT1RfTUFYX1NURVBTKTtcbiAgICByZXR1cm4gVElNRUxJTkVfU0xPVF9QWCAqIHN0ZXBzICsgMTtcbn1cblxuLyoqIOafseWtkOeahCB0aXDvvJrov5nkuIDmoLnnmoTlhajpg6jkuovlrp7vvIjova7liLDlk6rjgIHlrp7mtYvlpJrlsJHjgIHkvLDnrpflpJrlsJHjgIHljovnvKnkuoblh6DlpITvvInjgIIgKi9cbmZ1bmN0aW9uIHRpbWVsaW5lUG9pbnRUaXRsZShwb2ludDogVGltZWxpbmVQb2ludFZpZXcsIGNvbnRleHRXaW5kb3c6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHdoZXJlID1cbiAgICAgICAgcG9pbnQudHVybiA9PT0gbnVsbFxuICAgICAgICAgICAgPyBg56ysICR7cG9pbnQuaW5kZXh9IOagueafsWBcbiAgICAgICAgICAgIDogYOesrCAke3BvaW50LnR1cm59IOWbnuWQiCDCtyDnrKwgJHtwb2ludC5zdGVwID8/ICc/J30g5q2l77yI56ysICR7cG9pbnQuaW5kZXh9IOagueafse+8iWA7XG4gICAgbGluZXMucHVzaCh3aGVyZSArIChwb2ludC5zdGVwcyA+IDEgPyBgIOKAlOKAlCDov5nkuIDmoLnlkIjlubbkuoYgJHtwb2ludC5zdGVwc30g5q2lYCA6ICcnKSk7XG4gICAgbGluZXMucHVzaChcbiAgICAgICAgYCR7cG9pbnQuZXN0aW1hdGVkID8gJ+S8sOeulycgOiAn5a6e5rWLJ30gJHtmb3JtYXRUb2tlbnMocG9pbnQudG9rZW5zKX0gdG9rZW5gICtcbiAgICAgICAgICAgIChjb250ZXh0V2luZG93ID09PSBudWxsID8gJycgOiBg77yI5Y2g56qX5Y+jICR7KHBvaW50LnRva2VucyAvIGNvbnRleHRXaW5kb3cgKiAxMDApLnRvRml4ZWQoMSl9Je+8iWApLFxuICAgICk7XG4gICAgaWYgKHBvaW50LnByb21wdCAhPT0gbnVsbCAmJiBwb2ludC50b3RhbCAhPT0gbnVsbCkge1xuICAgICAgICBsaW5lcy5wdXNoKGDlrp7mtYsgcHJvbXB0ICR7Zm9ybWF0VG9rZW5zKHBvaW50LnByb21wdCl9IMK3IOS8sOeulyB0b3RhbCAke2Zvcm1hdFRva2Vucyhwb2ludC50b3RhbCl9YCk7XG4gICAgfSBlbHNlIGlmIChwb2ludC50b3RhbCAhPT0gbnVsbCkge1xuICAgICAgICBsaW5lcy5wdXNoKGDlj6rmnInkvLDnrpfnmoQgdG90YWwgJHtmb3JtYXRUb2tlbnMocG9pbnQudG90YWwpfe+8iHByb3ZpZGVyIOayoeaKpei/measoeiwg+eUqOeahCB1c2FnZe+8iWApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGN1dCBvZiBwb2ludC5jdXRzKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgICAgICBg4pyCICR7Y3V0LmtpbmQgPT09ICdjb21wYWN0aW9uJyA/ICfljovnvKknIDogJ+ijgeWJqid977ya5YeA6YeK5pS+ICR7Zm9ybWF0VG9rZW5zKGN1dC50b2tlbnMpfSB0b2tlbmAgK1xuICAgICAgICAgICAgICAgIChjdXQuY291bnQgPT09IG51bGwgPyAnJyA6IGAgwrcg5raJ5Y+KICR7Y3V0LmNvdW50fSDmnaHorrDlvZVgKSArXG4gICAgICAgICAgICAgICAgKGN1dC5tZXJnZWQgPiAxID8gYCDCtyDlkIzkuIDlpITov57lj5HkuoYgJHtjdXQubWVyZ2VkfSDmnaHvvIjlt7LlkIjlubbmiJDkuIDkuKrmoIforrDvvIlgIDogJycpICtcbiAgICAgICAgICAgICAgICAoY3V0LnRpbWUgPT09IG51bGwgPyAnJyA6IGAgwrcgJHtmb3JtYXRUaW1lKGN1dC50aW1lKX1gKSxcbiAgICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xufVxuXG4vKipcbiAqIOeUu+absue6v+acrOi6q++8mioq5Zue5ZCI5bimICsg5p+x5p6XKirvvIzkuKTmjpLoo7nlnKjlkIzkuIDkuKrmqKrlkJHmu5rliqjlrrnlmajph4zjgIJcbiAqXG4gKiDkuLrku4DkuYjkuKTmjpLopoHmlL7lnKjlkIzkuIDkuKrmu5rliqjlrrnlmajph4zvvJrliIblvIDkuKTkuKrlrrnlmajnmoTor53vvIzmu5rliqjlhbbkuK3kuIDkuKrlj6bkuIDkuKrkuI3liqgg4oCU4oCUXG4gKiDogIzjgIzlk6rkuIDmoLnmn7HlsZ7kuo7lk6rkuIDova7jgI3lsLHpnaDlroPku6zlr7npvZDvvIzmu5rotbfmnaXplJnkvY3nrYnkuo7msqHmnInlm57lkIjluKbjgIJcbiAqL1xuZnVuY3Rpb24gdGltZWxpbmVDaGFydCh2aWV3OiBDb250ZXh0VGltZWxpbmVWaWV3KTogSFRNTEVsZW1lbnQge1xuICAgIGNvbnN0IHNjcm9sbCA9IGVsKCdkaXYnLCAnZHNoLXRpbWVsaW5lLXNjcm9sbCcpO1xuXG4gICAgLy8gLS0tLSDikaAg5Zue5ZCI5bim77yaKirkuIDmlbTova7kuIDmnaHluKYqKu+8iOWuveW6piA9IOi/meS4gOi9ruaJgOacieafseeahOWuveW6puWSjO+8ie+8jOS6pOabv+W6leiJsiAtLS0tXG4gICAgY29uc3QgYmFuZHMgPSBlbCgnZGl2JywgJ2RzaC10aW1lbGluZS1iYW5kcycpO1xuICAgIGNvbnN0IHJ1bnM6IHsgdHVybjogbnVtYmVyIHwgbnVsbDsgd2lkdGg6IG51bWJlciB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHBvaW50IG9mIHZpZXcucG9pbnRzKSB7XG4gICAgICAgIGNvbnN0IHdpZHRoID0gdGltZWxpbmVTbG90V2lkdGgocG9pbnQpO1xuICAgICAgICBjb25zdCBsYXN0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdO1xuICAgICAgICBpZiAobGFzdCAmJiBsYXN0LnR1cm4gPT09IHBvaW50LnR1cm4pIGxhc3Qud2lkdGggKz0gd2lkdGg7XG4gICAgICAgIGVsc2UgcnVucy5wdXNoKHsgdHVybjogcG9pbnQudHVybiwgd2lkdGggfSk7XG4gICAgfVxuICAgIHJ1bnMuZm9yRWFjaCgocnVuLCBpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBiYW5kID0gZWwoJ2RpdicsICdkc2gtdGltZWxpbmUtYmFuZCcpO1xuICAgICAgICBiYW5kLmRhdGFzZXQuYWx0ID0gaW5kZXggJSAyID09PSAwID8gJ2ZhbHNlJyA6ICd0cnVlJztcbiAgICAgICAgLy8g56qE5bim6YeM55qE5a2X5Lya6KKrIENTUyDoo4HmjonvvIhlbGxpcHNpc++8ie+8jOaJgOS7peWujOaVtOeahOi9ruasoeWQjOaXtuWGmeWcqCB0aXRsZSDph4xcbiAgICAgICAgYmFuZC50aXRsZSA9IHJ1bi50dXJuID09PSBudWxsID8gJ+i/meS4gOauteeahOi9ruasoeWPt+ivu+WPluS4jeWHuuadpScgOiBg56ysICR7cnVuLnR1cm59IOi9rmA7XG4gICAgICAgIGJhbmQuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLXRpbWVsaW5lLWJhbmQtbGFiZWwnLCBydW4udHVybiA9PT0gbnVsbCA/ICfova7mrKHmnKrnn6UnIDogYOesrCAke3J1bi50dXJufSDova5gKSk7XG4gICAgICAgIGJhbmQuc3R5bGUud2lkdGggPSBgJHtydW4ud2lkdGh9cHhgO1xuICAgICAgICBiYW5kcy5hcHBlbmRDaGlsZChiYW5kKTtcbiAgICB9KTtcbiAgICBzY3JvbGwuYXBwZW5kQ2hpbGQoYmFuZHMpO1xuXG4gICAgLy8gLS0tLSDikaEg5p+x5p6XIC0tLS1cbiAgICBjb25zdCBwbG90ID0gZWwoJ2RpdicsICdkc2gtdGltZWxpbmUtcGxvdCcpO1xuICAgIGZvciAoY29uc3QgcG9pbnQgb2Ygdmlldy5wb2ludHMpIHtcbiAgICAgICAgY29uc3Qgc2xvdCA9IGVsKCdkaXYnLCAnZHNoLXRpbWVsaW5lLXNsb3QnKTtcbiAgICAgICAgc2xvdC5zdHlsZS53aWR0aCA9IGAke3RpbWVsaW5lU2xvdFdpZHRoKHBvaW50KX1weGA7XG4gICAgICAgIHNsb3QudGl0bGUgPSB0aW1lbGluZVBvaW50VGl0bGUocG9pbnQsIHZpZXcuY29udGV4dFdpbmRvdyk7XG4gICAgICAgIGNvbnN0IGJhciA9IGVsKCdkaXYnLCAnZHNoLXRpbWVsaW5lLWJhcicpO1xuICAgICAgICAvLyDlvZLkuIDljJbvvJpgbWF4YCDmmK/or7vlj5blmajnu5nnmoTvvIhwb2ludHMg6YeM5pyA5aSn55qE6YKj5LiqIHRva2Vuc++8ie+8m21heCDmmK8gMCDml7blhajpg6jnlLvmiJAgMCDpq5hcbiAgICAgICAgYmFyLnN0eWxlLmhlaWdodCA9IHZpZXcubWF4ID4gMCA/IGAkeyhwb2ludC50b2tlbnMgLyB2aWV3Lm1heCkgKiAxMDB9JWAgOiAnMCUnO1xuICAgICAgICBpZiAocG9pbnQuZXN0aW1hdGVkKSBiYXIuZGF0YXNldC5lc3RpbWF0ZWQgPSAndHJ1ZSc7XG4gICAgICAgIGlmIChwb2ludC5jdXRzLmxlbmd0aCA+IDApIGJhci5kYXRhc2V0LmN1dCA9ICd0cnVlJztcbiAgICAgICAgc2xvdC5hcHBlbmRDaGlsZChiYXIpO1xuICAgICAgICBpZiAocG9pbnQuY3V0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIOWOi+e8qeeCue+8mioq5LiA5p2h56uW57q/ICsg5LiA5LiqIOKcgioq44CC5ZCM5LiA5qC55p+x5LiK5pyJ5aW95Yeg5aSE5Y6L57yp5pe25pivKirlkIzkuIDmnaHnq5bnur8qKlxuICAgICAgICAgICAgICog77yI5qiq5Z2Q5qCH55u45ZCM77yJ77yM5omA5Lul5Y+q55S75LiA5LiqIGDinIJg77yM5Yeg5aSE44CB5ZCE6YeK5pS+5aSa5bCR5YWo5ZyoIHRpcCDph4wg4oCU4oCUIOeUuyBOIOS4qlxuICAgICAgICAgICAgICog5Lya5ZyoIDZweCDlrr3nmoTmn7HlrZDkuIrns4rmiJDkuIDlm6LvvIzpgqPmraPmmK/ov5nlnZfmnIDlrrnmmJPlh7rnjrDnmoTns4rms5XjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgY29uc3QgY3V0ID0gZWwoJ2RpdicsICdkc2gtdGltZWxpbmUtY3V0Jyk7XG4gICAgICAgICAgICBjdXQuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLXRpbWVsaW5lLWN1dC1tYXJrJywgJ+KcgicpKTtcbiAgICAgICAgICAgIHNsb3QuYXBwZW5kQ2hpbGQoY3V0KTtcbiAgICAgICAgfVxuICAgICAgICBwbG90LmFwcGVuZENoaWxkKHNsb3QpO1xuICAgIH1cbiAgICBzY3JvbGwuYXBwZW5kQ2hpbGQocGxvdCk7XG4gICAgcmV0dXJuIHNjcm9sbDtcbn1cblxuLyoqXG4gKiDjgIzkuIrkuIvmloflop7plb/jgI3pgqPkuIDlnZfopoHnlLvnmoTooYzvvIhET00g55SxIGByZW5kZXJVc2FnZWAg5oyC5LiK5Y6777yJ44CCXG4gKlxuICog5rKh55S75puy57q/5pe277yIYHRpbWVsaW5lID09PSBudWxsYO+8iSoq5Y+q55S76K+05piOKirvvJrpgqPlh6Dlj6Xor53liIblm5vnp43mnaXot6/vvIjniYjmnKzkuI3orqTor4YgLyDlrr/kuLvkvY7kuo5cbiAqIOWfuue6vyAvIOi/mOayoeacieivt+axguiusOW9lSAvIOi/meS4gOihjOWOi+agueS4jeWtmOWcqCDigJTigJQg5pyA5ZCO5LiA56eN5pivKirluLjmgIEqKu+8jOWboOS4uuazqOWGjOiAheaYr+esrOS4ieaWue+8ie+8jFxuICog5Zub5Y+l5Y6f5paH6YO955SxIGB0aW1lbGluZVRleHRPZmAg57uZ77yM6Z2i5p2/5LiA5Y+l6YO95LiN6Ieq5bex57yW44CCXG4gKi9cbmZ1bmN0aW9uIHRpbWVsaW5lTGluZXModXNhZ2U6IFNlc3Npb25Vc2FnZSk6IEhUTUxFbGVtZW50W10ge1xuICAgIGNvbnN0IHRleHQgPSB0aW1lbGluZVRleHRPZih7IHRpbWVsaW5lOiB1c2FnZS50aW1lbGluZSwgbm90ZTogdXNhZ2UudGltZWxpbmVOb3RlIH0pO1xuICAgIGNvbnN0IGxpbmVzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgaWYgKHVzYWdlLnRpbWVsaW5lKSB7XG4gICAgICAgIGlmICh0ZXh0LmhlYWRsaW5lKSBsaW5lcy5wdXNoKGVsKCdkaXYnLCAnZHNoLXRpbWVsaW5lLWhlYWQnLCB0ZXh0LmhlYWRsaW5lKSk7XG4gICAgICAgIGxpbmVzLnB1c2godGltZWxpbmVDaGFydCh1c2FnZS50aW1lbGluZSkpO1xuICAgIH1cbiAgICBpZiAodGV4dC5sZWdlbmQubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBsZWdlbmQgPSBlbCgnZGl2JywgJ2RzaC10aW1lbGluZS1sZWdlbmQnKTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHRleHQubGVnZW5kKSB7XG4gICAgICAgICAgICBjb25zdCByb3cgPSBlbCgnZGl2JywgJ2RzaC10aW1lbGluZS1sZWdlbmQtaXRlbScpO1xuICAgICAgICAgICAgY29uc3Qgc3dhdGNoID0gZWwoJ3NwYW4nLCAnZHNoLXRpbWVsaW5lLXN3YXRjaCcsIGl0ZW0uc3dhdGNoID09PSAnY3V0JyA/ICfinIInIDogJycpO1xuICAgICAgICAgICAgc3dhdGNoLmRhdGFzZXQuc3dhdGNoID0gaXRlbS5zd2F0Y2g7XG4gICAgICAgICAgICByb3cuYXBwZW5kQ2hpbGQoc3dhdGNoKTtcbiAgICAgICAgICAgIHJvdy5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtdGltZWxpbmUtbGVnZW5kLXRleHQnLCBpdGVtLmxhYmVsKSk7XG4gICAgICAgICAgICBsZWdlbmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgICAgICAgfVxuICAgICAgICBsaW5lcy5wdXNoKGxlZ2VuZCk7XG4gICAgfVxuICAgIGZvciAoY29uc3Qgbm90ZSBvZiB0ZXh0Lm5vdGVzKSBsaW5lcy5wdXNoKGVsKCdkaXYnLCAnZHNoLXVzYWdlLXNvdXJjZScsIG5vdGUpKTtcbiAgICByZXR1cm4gbGluZXM7XG59XG5cbi8qKlxuICog44CM6L+Z5Lqb5pWw5a2X5pyJ5aSa5paw44CN4oCU4oCU5oq95bGJ5aS06YOo6YKj5LiA6KGM77yI5rKh5pyJ6K+75pWw5pe25o2i5oiQ5Y6f5Zug77yM6KeBIGByZW5kZXJVc2FnZWDvvInjgIJcbiAqXG4gKiDlm5vkuKrkuovlrp7vvIznvLrkuIDkuKrpg73kvJrorqnkurror6/liKTvvJoqKuadpea6kCoq77yI5qOA5p+l54K55LiN5piv5a6e5pe25rWB77yJ44CBKirmsLTkvY0qKu+8iOiusOWIsOesrOWHoOadoeS6i+S7tu+8ieOAgVxuICogKirokL3lkI7lpJrlsJHmnaEqKuOAgSoq5YaZ5LqO5L2V5pe2KirjgILov5nkuIDooYzmmK/mlbTlnZfnlKjph4/ph4zmnIDlrrnmmJPooqvnnIHnlaXjgIHkuZ/mnIDkuI3or6XnnIHnlaXnmoTkuJzopb8g4oCU4oCUXG4gKiDkuIDku73jgIwxMiUg5Y2g55So44CN5Zyo6JC95ZCO5LiA5LiH5p2h5LqL5Lu25pe25piv5a6M5YWo5rKh5pyJ5oSP5LmJ55qE44CCXG4gKi9cbmZ1bmN0aW9uIHVzYWdlRnJlc2huZXNzKHVzYWdlOiBTZXNzaW9uVXNhZ2UpOiBzdHJpbmcge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFsn5p2l6Ieq5Lya6K+d5oqV5b2x57yT5a2Y77yI5qOA5p+l54K577yM5LiN5piv5a6e5pe25rWB77yJJ107XG4gICAgaWYgKHVzYWdlLnNlcSAhPT0gbnVsbCkgcGFydHMucHVzaChg5rC05L2N56ysICR7dXNhZ2Uuc2VxfSDmnaHkuovku7ZgKTtcbiAgICBpZiAodXNhZ2UuYmVoaW5kICE9PSBudWxsKSBwYXJ0cy5wdXNoKHVzYWdlLmJlaGluZCA+IDAgPyBg6JC95ZCOICR7dXNhZ2UuYmVoaW5kfSDmnaFgIDogJ+W3sui3n+S4iicpO1xuICAgIGVsc2UgcGFydHMucHVzaCgn5rKh5pyJ5a6e5pe25rC05L2N5Y+v5q+UJyk7XG4gICAgaWYgKHVzYWdlLnVwZGF0ZWRBdCA+IDApIHBhcnRzLnB1c2goYOWGmeS6jiAke2Zvcm1hdFRpbWUodXNhZ2UudXBkYXRlZEF0KX1gKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignIMK3ICcpO1xufVxuXG4vKipcbiAqIOeUu+eUqOmHj+aKveWxieOAglxuICpcbiAqIOS4uuS7gOS5iOavj+asoeaVtOWdl+mHjeW7uuiAjOS4jeaYr+WwseWcsOabtOaWsO+8muWGheWuueaYr+OAjOivu+S4gOasoeeahOetlOahiOOAje+8jOS4jemcgOimgeS/neS9j+S7u+S9lei+k+WFpeeKtuaAgVxuICog77yI5a+55q+U77ya5Lqk5LqS5Y2h54mH6YeM5pyJ55So5oi35q2j5Zyo5pWy55qE5a2X77yM5omA5Lul6YKj6L655b+F6aG75oyJ562+5ZCN6Lez6L+H6YeN55S777yJ44CCXG4gKiDkuIDnnLzog73or7vlroznmoTljYHlh6DooYzvvIzph43lu7rmr5Tnu7TmiqTlop7ph4/kvr/lrpzlvpflpJrjgIJcbiAqL1xuZnVuY3Rpb24gcmVuZGVyVXNhZ2Uoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBib2R5ID0gc3RhdGUudXNhZ2VCb2R5O1xuICAgIGlmICghYm9keSkgcmV0dXJuO1xuICAgIGJvZHkudGV4dENvbnRlbnQgPSAnJztcblxuICAgIGNvbnN0IHVzYWdlID0gc3RhdGUuc25hcHNob3Q/LnVzYWdlID8/IG51bGw7XG4gICAgY29uc3Qgbm90ZSA9IHN0YXRlLnNuYXBzaG90Py51c2FnZU5vdGUgPz8gbnVsbDtcblxuICAgIGlmIChzdGF0ZS51c2FnZU5vdGVFbCkge1xuICAgICAgICAvKipcbiAgICAgICAgICog5oq95bGJ5aS06YOo6YKj5LiA6KGMKirmsLjov5wqKuacieivneivtO+8jOiAjOS4lOaYr+S4pOenjeWGheWuueS5i+S4gO+8mlxuICAgICAgICAgKlxuICAgICAgICAgKiAtIOivu+Wksei0pS/ov5jmsqHor7vmlbAg4oaSICoq5Y6f5ZugKirvvIjluKborablkYroibLvvInvvJtcbiAgICAgICAgICogLSDmnInmlbDlrZcg4oaSICoq44CM6L+Z5Lqb5pWw5a2X5pyJ5aSa5paw44CNKirvvJrmnaXmupDjgIHorrDlvZXmsLTkvY3jgIHokL3lkI7lpJrlsJHmnaHjgIHnvJPlrZjlhpnkuo7kvZXml7bjgIJcbiAgICAgICAgICpcbiAgICAgICAgICog5Li65LuA5LmI5oqK44CM5paw6bKc5bqm44CN5pS+6L+Z5LiA6KGM6ICM5LiN5piv5pS+5Yiw5YaF5a655pyr5bC+77ya5oq95bGJ5pyJIGBtYXgtaGVpZ2h0OiA2MiVg77yMXG4gICAgICAgICAqIOWGheWuuea7oeeahOaXtuWAmeaYr+imgea7mueahCDigJTigJQg6ICM6L+Z5LiA6KGM5oGw5oGw5pivKirkuI3nnIvlsLHmsqHms5XliKTor7vpgqPkupvmlbDlrZcqKueahOS4nOilv1xuICAgICAgICAgKiDvvIhgLmRzaC11c2FnZS1oZWFkYCDmmK8gc3RpY2t577yM5rC46L+c5Zyo6KeG6YeO6YeM77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBzdGF0ZS51c2FnZU5vdGVFbC50ZXh0Q29udGVudCA9IG5vdGUgPz8gKHVzYWdlID8gdXNhZ2VGcmVzaG5lc3ModXNhZ2UpIDogJycpO1xuICAgICAgICBzdGF0ZS51c2FnZU5vdGVFbC5kYXRhc2V0LnRvbmUgPSBub3RlID8gJ3dhcm4nIDogJyc7XG4gICAgfVxuXG4gICAgaWYgKCF1c2FnZSkge1xuICAgICAgICAvKipcbiAgICAgICAgICog44CM5rKh5pyJ5pWw5a2X5Y+v55S744CN5pyJ5Lik56eN5p2l6Lev77yMKirkuI3og73mt7fmiJDkuIDlj6Xor50qKu+8mlxuICAgICAgICAgKiDor7vlpLHotKXvvIjljp/lm6DlnKjkuIrpnaLpgqPooYzvvIzluKborablkYroibLvvInkuI7jgIzov5nmnaHkvJror53ov5jmsqHmnInnlKjph4/jgI3jgIJcbiAgICAgICAgICog6Z2i5p2/5YiG5LiN5riF5YW35L2T5piv5ZOq56eN77yI6YKj5piv5Li76L+b56iL55qE5LqL77yJ77yM5omA5Lul5Y+q6K+05LiA5Y+l5Lik56eN5oOF5Ya15LiL6YO95oiQ56uL55qE6K+dICtcbiAgICAgICAgICog5LiA5Liq5Y+v5pON5L2c55qE5Yqo5L2c77yM6ICMKirljp/lm6DmsLjov5znlLHkuIrpnaLpgqPkuIDooYzotJ/otKMqKuOAglxuICAgICAgICAgKi9cbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICdkc2gtdXNhZ2Utc291cmNlJyxcbiAgICAgICAgICAgICAgICBub3RlXG4gICAgICAgICAgICAgICAgICAgID8gJ+i/memHjOayoeacieaVsOWtl+WPr+eUuyDigJTigJQg5Y6f5Zug6KeB5LiK6Z2i6YKj6KGM44CC54K544CM5Yi35paw44CN5Y+v5Lul5YaN6K+75LiA5qyh44CCJ1xuICAgICAgICAgICAgICAgICAgICA6ICfov5jmsqHmnInor7vmlbAg4oCU4oCUIOeUqOmHj+WcqCBhZ2VudCDlkK/liqjjgIHlj5Hlh7rnrKzkuIDmnaHmtojmga/kuYvlkI7miY3mnInvvIjmlbDmja7mnaXoh6ogRFNIIOeahOS8muivneaKleW9see8k+WtmO+8jGFnZW50IOayoeWcqOi3keS5n+iDveivu++8ieOAgicsXG4gICAgICAgICAgICApLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgeyBjb250ZXh0IH0gPSB1c2FnZTtcblxuICAgIC8vIC0tLS0g4pGgIOWNoOeUqOadoe+8iOWPquWbnuetlOOAjOS4i+S4gOasoeivt+axguWkp+amguWNoOWkmuWwkeOAje+8iS0tLS1cbiAgICBpZiAoY29udGV4dC5wcm9qZWN0ZWQgIT09IG51bGwgJiYgY29udGV4dC53aW5kb3cgIT09IG51bGwgJiYgY29udGV4dC5yYXRpbyAhPT0gbnVsbCkge1xuICAgICAgICBjb25zdCBiYXIgPSBlbCgnZGl2JywgJ2RzaC11c2FnZS1iYXInKTtcbiAgICAgICAgY29uc3QgZmlsbCA9IGVsKCdkaXYnLCAnZHNoLXVzYWdlLWZpbGwnKTtcbiAgICAgICAgLy8g6LaF6L+H56qX5Y+j5pe25p2h55S75ruh77yM5L2G55m+5YiG5q+U54Wn5a6e5YaZ77yI5LiN6K645oKE5oKE6ZKz5oiQIDEwMCXvvIlcbiAgICAgICAgZmlsbC5zdHlsZS53aWR0aCA9IGAke01hdGgubWluKDEwMCwgTWF0aC5tYXgoMCwgY29udGV4dC5yYXRpbyAqIDEwMCkpfSVgO1xuICAgICAgICBmaWxsLmRhdGFzZXQudG9uZSA9IHVzYWdlVG9uZShjb250ZXh0LnJhdGlvKTtcbiAgICAgICAgYmFyLmFwcGVuZENoaWxkKGZpbGwpO1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKGJhcik7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICB1c2FnZUxpbmUoXG4gICAgICAgICAgICAgICAgJ+S4i+S4gOasoeivt+axgumihOS8sCcsXG4gICAgICAgICAgICAgICAgYCR7dXNhZ2VBbW91bnQoY29udGV4dC5wcm9qZWN0ZWQpfSAvICR7dXNhZ2VBbW91bnQoY29udGV4dC53aW5kb3cpfe+8iCR7KGNvbnRleHQucmF0aW8gKiAxMDApLnRvRml4ZWQoMSl9Je+8iWAsXG4gICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRleHRMaW5lczogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnRleHRMaW5lcy5wdXNoKHVzYWdlTGluZSgn5LiK5LiA5qyh6K+35rGC5a6e5rWLJywgdXNhZ2VBbW91bnQoY29udGV4dC5wcmVzc3VyZSksIHRydWUpKTtcbiAgICBpZiAoY29udGV4dC53aW5kb3cgPT09IG51bGwpIGNvbnRleHRMaW5lcy5wdXNoKHVzYWdlTGluZSgn56qX5Y+j5LiK6ZmQJywgJ+S4jeefpemBk++8iERTSCDov5jmsqHorrDliLDvvIknKSk7XG4gICAgaWYgKGNvbnRleHQucHJvamVjdGVkID09PSBudWxsICYmIGNvbnRleHQucmF0aW8gPT09IG51bGwgJiYgY29udGV4dC53aW5kb3cgIT09IG51bGwpIHtcbiAgICAgICAgY29udGV4dExpbmVzLnB1c2godXNhZ2VMaW5lKCfljaDnlKjnjocnLCAn566X5LiN5Ye65p2l77yI57y6IHByb21wdCDkvqfnmoTlrp7mtYvvvIknKSk7XG4gICAgfVxuICAgIGJvZHkuYXBwZW5kQ2hpbGQodXNhZ2VCbG9jaygn5LiK5LiL5paHJywgY29udGV4dExpbmVzKSk7XG5cbiAgICAvLyAtLS0tIOKRoSDkvLDnrpfnu4TmiJDvvJoqKuWNleeLrOS4gOWdlyoq77yM5bm25piO6K+05a6D5LiN5Y+C5LiO5LiK6Z2i6YKj5p2hIC0tLS1cbiAgICBpZiAoY29udGV4dC5zeXN0ZW0gIT09IG51bGwgfHwgY29udGV4dC50b29scyAhPT0gbnVsbCB8fCBjb250ZXh0Lm1lc3NhZ2VzICE9PSBudWxsKSB7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICB1c2FnZUJsb2NrKCfkuIrkuIvmlofnu4TmiJDvvIjkvLDnrpfvvIknLCBbXG4gICAgICAgICAgICAgICAgdXNhZ2VMaW5lKCfns7vnu5/mj5DnpLonLCB1c2FnZUFtb3VudChjb250ZXh0LnN5c3RlbSksIHRydWUpLFxuICAgICAgICAgICAgICAgIHVzYWdlTGluZSgn5bel5YW36KGoJywgdXNhZ2VBbW91bnQoY29udGV4dC50b29scyksIHRydWUpLFxuICAgICAgICAgICAgICAgIHVzYWdlTGluZSgn5a+56K+dJywgdXNhZ2VBbW91bnQoY29udGV4dC5tZXNzYWdlcyksIHRydWUpLFxuICAgICAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAgICAgJ2RzaC11c2FnZS1zb3VyY2UnLFxuICAgICAgICAgICAgICAgICAgICAn6L+Z5LiA5Z2X5piv5oyJ44CM5Zub5a2X56ym5LiA5LiqIHRva2Vu44CN5Lyw55qE77ya5Lit5paH5LiOIEpTT04gc2NoZW1hIOS8muaYjuaYvuS9juS8sO+8jCcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgJ+S4ieS4quaVsOWKoOi1t+adpeS5n+WSjOS4iumdoumCo+adoeWNoOeUqOeOh+WvueS4jeS4iiDigJTigJQg5omA5Lul5a6D5Y+q55So5p2l5q+U55u45a+55aSn5bCP44CCJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgXSksXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSDikaIg5pys5Lya6K+d57Sv6K6hIC0tLS1cbiAgICBjb25zdCB0b3RhbHMgPSB1c2FnZS51c2FnZS50b3RhbHM7XG4gICAgaWYgKHRvdGFscykge1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKFxuICAgICAgICAgICAgdXNhZ2VCbG9jaygn5pys5Lya6K+d57Sv6K6hJywgW1xuICAgICAgICAgICAgICAgIHVzYWdlTGluZSgn6L6T5YWl77yI5pyq5ZG95Lit57yT5a2Y77yJJywgZm9ybWF0VG9rZW5zKHRvdGFscy5pbnB1dCksIHRydWUpLFxuICAgICAgICAgICAgICAgIHVzYWdlTGluZSgn6L6T5Ye6JywgZm9ybWF0VG9rZW5zKHRvdGFscy5vdXRwdXQpLCB0cnVlKSxcbiAgICAgICAgICAgICAgICB1c2FnZUxpbmUoJ+e8k+WtmOivuycsIGZvcm1hdFRva2Vucyh0b3RhbHMuY2FjaGVSZWFkKSwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgdXNhZ2VMaW5lKCfnvJPlrZjlhpknLCBmb3JtYXRUb2tlbnModG90YWxzLmNhY2hlV3JpdGUpLCB0cnVlKSxcbiAgICAgICAgICAgIF0pLFxuICAgICAgICApO1xuICAgIH1cbiAgICBpZiAodXNhZ2UudXNhZ2UubGFzdCkge1xuICAgICAgICBjb25zdCBsYXN0ID0gdXNhZ2UudXNhZ2UubGFzdDtcbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIHVzYWdlQmxvY2soYOacgOi/keS4gOatpe+8iOesrCAke2xhc3QudHVybn0g5Zue5ZCIIC8g56ysICR7bGFzdC5zdGVwfSDmraXvvIlgLCBbXG4gICAgICAgICAgICAgICAgdXNhZ2VMaW5lKFxuICAgICAgICAgICAgICAgICAgICAn6L+Z5LiA5q2lJyxcbiAgICAgICAgICAgICAgICAgICAgYOi+k+WFpSAke2Zvcm1hdFRva2VucyhsYXN0LmJ1Y2tldHMuaW5wdXQpfSDCtyDovpPlh7ogJHtmb3JtYXRUb2tlbnMobGFzdC5idWNrZXRzLm91dHB1dCl9IMK3IOe8k+WtmOivuyAke2Zvcm1hdFRva2VucyhsYXN0LmJ1Y2tldHMuY2FjaGVSZWFkKX1gLFxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoyDlm57lkIjkuI7ogJfml7bvvIhgc2Vzc2lvblN0YXRzYO+8iS0tLS1cbiAgICBjb25zdCBzZXNzaW9uTGluZXM6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgICBpZiAodXNhZ2Uuc2Vzc2lvbi50dXJucyAhPT0gbnVsbCB8fCB1c2FnZS5zZXNzaW9uLnN0ZXBzICE9PSBudWxsKSB7XG4gICAgICAgIHNlc3Npb25MaW5lcy5wdXNoKHVzYWdlTGluZSgn5Zue5ZCIIC8g5q2lJywgYCR7dXNhZ2Uuc2Vzc2lvbi50dXJucyA/PyAn4oCUJ30g5Zue5ZCIIMK3ICR7dXNhZ2Uuc2Vzc2lvbi5zdGVwcyA/PyAn4oCUJ30g5q2lYCkpO1xuICAgIH1cbiAgICBpZiAodXNhZ2Uuc2Vzc2lvbi5sbG1NcyAhPT0gbnVsbCkgc2Vzc2lvbkxpbmVzLnB1c2godXNhZ2VMaW5lKCfmqKHlnovogJfml7YnLCBmb3JtYXREdXJhdGlvbih1c2FnZS5zZXNzaW9uLmxsbU1zKSkpO1xuICAgIGlmICh1c2FnZS5zZXNzaW9uLnRvb2xNcyAhPT0gbnVsbCkgc2Vzc2lvbkxpbmVzLnB1c2godXNhZ2VMaW5lKCflt6XlhbfogJfml7YnLCBmb3JtYXREdXJhdGlvbih1c2FnZS5zZXNzaW9uLnRvb2xNcykpKTtcbiAgICBpZiAodXNhZ2Uuc2Vzc2lvbi50dGZ0TXMgIT09IG51bGwgJiYgdXNhZ2Uuc2Vzc2lvbi50dGZ0U3RlcHMpIHtcbiAgICAgICAgc2Vzc2lvbkxpbmVzLnB1c2goXG4gICAgICAgICAgICB1c2FnZUxpbmUoJ+mmluWtl+W7tui/n+Wdh+WAvCcsIGAke2Zvcm1hdER1cmF0aW9uKHVzYWdlLnNlc3Npb24udHRmdE1zIC8gdXNhZ2Uuc2Vzc2lvbi50dGZ0U3RlcHMpfe+8iCR7dXNhZ2Uuc2Vzc2lvbi50dGZ0U3RlcHN9IOatpe+8iWApLFxuICAgICAgICApO1xuICAgIH1cbiAgICBpZiAodXNhZ2Uuc2Vzc2lvbi5kZWNvZGVNcyAhPT0gbnVsbCAmJiB1c2FnZS5zZXNzaW9uLmRlY29kZVRva2VucyAhPT0gbnVsbCAmJiB1c2FnZS5zZXNzaW9uLmRlY29kZU1zID4gMCkge1xuICAgICAgICBjb25zdCBwZXJTZWNvbmQgPSAodXNhZ2Uuc2Vzc2lvbi5kZWNvZGVUb2tlbnMgLyB1c2FnZS5zZXNzaW9uLmRlY29kZU1zKSAqIDEwMDA7XG4gICAgICAgIHNlc3Npb25MaW5lcy5wdXNoKFxuICAgICAgICAgICAgdXNhZ2VMaW5lKCfnlJ/miJDpgJ/luqYnLCBgJHtwZXJTZWNvbmQudG9GaXhlZCgxKX0gdG9rL3PvvIgke2Zvcm1hdFRva2Vucyh1c2FnZS5zZXNzaW9uLmRlY29kZVRva2Vucyl9IOS4qui+k+WHuiB0b2tlbu+8iWApLFxuICAgICAgICApO1xuICAgIH1cbiAgICBpZiAoc2Vzc2lvbkxpbmVzLmxlbmd0aCA+IDApIGJvZHkuYXBwZW5kQ2hpbGQodXNhZ2VCbG9jaygn6L+Z5LiA5bGAJywgc2Vzc2lvbkxpbmVzKSk7XG5cbiAgICAvLyAtLS0tIOKRpCDkuIrkuIvmloflop7plb/vvJoqKui/meS4gOWdl+mAmuW4uOayoeacieabsue6vyoq77yI5rOo5YaM6ICF5piv56ys5LiJ5pa577yM5pysIHByb2ZpbGUg5LiN5oyC5a6D77yJLS0tLVxuICAgIC8vIOS4juiKsei0uemCo+S4gOWdl+WQjOS4gOWll+inhOefqe+8muayoeacieWwseivtOa4heaYryoq5ZOq5LiA56eN5rKh5pyJKirvvIznu53kuI3nlLvkuIDmnaHnqbrnmoTlnZDmoIfovbTlhYXmlbDjgIJcbiAgICBib2R5LmFwcGVuZENoaWxkKHVzYWdlQmxvY2soJ+S4iuS4i+aWh+WinumVvycsIHRpbWVsaW5lTGluZXModXNhZ2UpKSk7XG5cbiAgICAvLyAtLS0tIOKRpSDoirHotLnvvJoqKuayoeacieWwseivtOayoeaciSoq77yM57ud5LiN5pi+56S6IDAgLS0tLVxuICAgIGJvZHkuYXBwZW5kQ2hpbGQodXNhZ2VCbG9jaygn6Iqx6LS5JywgY29zdExpbmVzKHVzYWdlKSkpO1xuXG4gICAgLy8gLS0tLSDikaYg5Y+j5b6E6K+05piO77yI5LiA5p2h6YO95LiN6K645ZCe77yJLS0tLVxuICAgIC8vIOaVsOaNruadpea6kOS4juawtOS9jeWcqCoq5aS06YOo6YKj5LiA6KGMKirvvIhgI3VzYWdlLW5vdGVg77yMc3RpY2t544CB5rC46L+c5Y+v6KeB77yJ77yM6L+Z6YeM5Y+q5pS+6K+05piO44CCXG4gICAgaWYgKHVzYWdlLm5vdGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3Qgbm90ZXMgPSBlbCgnZGl2JywgJ2RzaC11c2FnZS1ub3RlcycpO1xuICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgdXNhZ2Uubm90ZXMpIG5vdGVzLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXVzYWdlLW5vdGVzLWl0ZW0nLCB0ZXh0KSk7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQobm90ZXMpO1xuICAgIH1cbn1cblxuLyoqIOW8gC/lhbPnlKjph4/mir3lsYnjgILmiZPlvIDml7YqKumhuuaJi+imgeS4gOasoeaWsOivu+aVsCoq77yI57yT5a2Y5piv5pSS552A5YaZ55qE77yM5pen6K+75pWw5Y+v6IO96L+H5pe25LqG77yJ44CCICovXG5mdW5jdGlvbiB0b2dnbGVVc2FnZShzdGF0ZTogVWlTdGF0ZSwgb3Blbj86IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBjb25zdCBuZXh0ID0gb3BlbiA/PyAhc3RhdGUudXNhZ2VPcGVuO1xuICAgIHN0YXRlLnVzYWdlT3BlbiA9IG5leHQ7XG4gICAgaWYgKHN0YXRlLnVzYWdlSG9zdCkgc3RhdGUudXNhZ2VIb3N0LmhpZGRlbiA9ICFuZXh0O1xuICAgIGlmIChuZXh0KSB7XG4gICAgICAgIHJlbmRlclVzYWdlKHN0YXRlKTtcbiAgICAgICAgdm9pZCByZWFkVXNhZ2Uoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDpl67kuIDmrKHkuLvov5vnqIvopoHmnIDmlrDor7vmlbDvvIgqKueUqOmHjyArIOi/m+W6pioq77ya5Li76L+b56iL6K+75LiA6YGN5ZCM5LiA5Liq5paH5Lu277yM5Lik6L655LiA5qyh57uZ5YWo77yJ44CCXG4gKlxuICog5bmz5pe25LiN6ZyA6KaB6Z2i5p2/5YKs77ya5Li76L+b56iL5ZyoKirlm57lkIjnu5PmnZ8qKuS4jioq6LeR5a6M5pac5p2g5ZG95LukKirkuYvlkI7oh6rlt7HkvJror7vlubbotbDlub/mkq3mjqjov4fmnaVcbiAqIO+8iOa4heWNlemCo+S4gOi3r+abtOW/qyDigJTigJQgYWdlbnQg5q+P5YaZ5LiA5qyhIGB0b2RvX3dyaXRlYCDlsLHmjqjkuIDmrKHvvInjgIJcbiAqIOi/meS4gOadoeWPquacjeWKoeOAjOaJk+W8gOaKveWxieOAjeS4juOAjOeCueWIt+aWsOOAjeS4pOS4quWKqOS9nCDigJTigJQg55So5oi35Li75Yqo55yL55qE5pe25YCZ77yM5b+F6aG755yL5Yiw5Yia6K+755qE44CCXG4gKlxuICog4pqgIOS4pOS4quaKveWxieWFseeUqOi/meS4gOS4quWHveaVsOS4jui/meS4gOS4qumXuO+8iGB1c2FnZUJ1c3lg77yJ77ya5a6D5Lus5omT55qE5piv5ZCM5LiA5Liq5Li76L+b56iL5pa55rOV44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRVc2FnZShzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS51c2FnZUJ1c3kpIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOW3sue7j+acieS4gOasoeWcqOivu++8mioq5LiN6YeN5aSN6K+755uYKirvvIzkvYbopoHmiorkuKTpopfjgIzliLfmlrDjgI3mjInpkq7pg73lpI3ljp8g4oCU4oCUXG4gICAgICAgICAqIOiwg+eUqOaWue+8iOWTquS4gOmil+aMiemSrumDveWPr+iDveaYr++8ieWcqOiwg+S5i+WJjeWFiOaKiuWug+emgeeUqOS6hu+8jOaXqemAgOS4jei/mOWOn+eahOivneWug+S8mioq5rC46L+c56aB552AKipcbiAgICAgICAgICog77yI5Y+q5Zyo5byA5ZCv5oq95bGJ6YKj5LiA6Lev5bey57uP5Zyo6K+75pe254K55Yi35paw5omN5Lya5pKe5LiK77yM5L2G5pKe5LiK5bCx5piv5q275oyJ6ZKu77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBpZiAoc3RhdGUuYnRuVXNhZ2VSZWZyZXNoRWwpIHN0YXRlLmJ0blVzYWdlUmVmcmVzaEVsLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGlmIChzdGF0ZS5idG5Qcm9ncmVzc1JlZnJlc2hFbCkgc3RhdGUuYnRuUHJvZ3Jlc3NSZWZyZXNoRWwuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS51c2FnZUJ1c3kgPSB0cnVlO1xuICAgIGlmIChzdGF0ZS51c2FnZU5vdGVFbCAmJiBzdGF0ZS51c2FnZU9wZW4pIHtcbiAgICAgICAgc3RhdGUudXNhZ2VOb3RlRWwudGV4dENvbnRlbnQgPSAn6K+75Y+W5Lit4oCmJztcbiAgICAgICAgc3RhdGUudXNhZ2VOb3RlRWwuZGF0YXNldC50b25lID0gJyc7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5wcm9ncmVzc05vdGVFbCAmJiBzdGF0ZS5wcm9ncmVzc09wZW4pIHtcbiAgICAgICAgc3RhdGUucHJvZ3Jlc3NOb3RlRWwudGV4dENvbnRlbnQgPSAn6K+75Y+W5Lit4oCmJztcbiAgICAgICAgc3RhdGUucHJvZ3Jlc3NOb3RlRWwuZGF0YXNldC50b25lID0gJyc7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7XG4gICAgICAgICAgICBvazogYm9vbGVhbjtcbiAgICAgICAgICAgIHVzYWdlPzogU2Vzc2lvblVzYWdlIHwgbnVsbDtcbiAgICAgICAgICAgIG5vdGU/OiBzdHJpbmcgfCBudWxsO1xuICAgICAgICAgICAgcHJvZ3Jlc3M/OiBQcm9ncmVzc1ZpZXcgfCBudWxsO1xuICAgICAgICAgICAgcHJvZ3Jlc3NOb3RlPzogc3RyaW5nIHwgbnVsbDtcbiAgICAgICAgICAgIGVycm9yPzogc3RyaW5nO1xuICAgICAgICB9PihNU0cuc2Vzc2lvblVzYWdlKTtcbiAgICAgICAgaWYgKHN0YXRlLnNuYXBzaG90KSB7XG4gICAgICAgICAgICBzdGF0ZS5zbmFwc2hvdC51c2FnZSA9IHJlcGx5Py51c2FnZSA/PyBudWxsO1xuICAgICAgICAgICAgLy8g4pqgIOivu+Wksei0peeahOWOn+WboOacieS4pOWkhOWPr+iDvee7me+8muS4u+i/m+eoi+eahCBub3Rl77yM5oiW6ICF6L+Z5p2h6K+35rGC5pys6Lqr5oqb5LqG77yIZXJyb3LvvIlcbiAgICAgICAgICAgIHN0YXRlLnNuYXBzaG90LnVzYWdlTm90ZSA9IHJlcGx5Py5ub3RlID8/IHJlcGx5Py5lcnJvciA/PyBudWxsO1xuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiDlkIzkuIDmnaHor7fmsYLkuZ/luKblm57kuobov5vluqYg4oCU4oCUIOS4pOS4quaKveWxieaJk+eahOaYryoq5ZCM5LiA5LiqKirkuLvov5vnqIvmlrnms5XvvIjlkIzkuIDmrKHor7vnm5jvvInjgIJcbiAgICAgICAgICAgICAqIOaJgOS7peiwgeeCueeahOOAjOWIt+aWsOOAjemDveS8muaKiuS4pOi+ueS4gOi1t+abtOaWsO+8jOS4jeWtmOWcqOOAjOeUqOmHj+aYr+aWsOeahOOAgea4heWNleaYr+aXp+eahOOAjeOAglxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBzdGF0ZS5zbmFwc2hvdC5wcm9ncmVzcyA9IHJlcGx5Py5wcm9ncmVzcyA/PyBudWxsO1xuICAgICAgICAgICAgc3RhdGUuc25hcHNob3QucHJvZ3Jlc3NOb3RlID0gcmVwbHk/LnByb2dyZXNzTm90ZSA/PyByZXBseT8uZXJyb3IgPz8gbnVsbDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChzdGF0ZS5zbmFwc2hvdCkge1xuICAgICAgICAgICAgc3RhdGUuc25hcHNob3QudXNhZ2UgPSBudWxsO1xuICAgICAgICAgICAgc3RhdGUuc25hcHNob3QudXNhZ2VOb3RlID0gYOivu+eUqOmHj+Wksei0pe+8miR7U3RyaW5nKGVycm9yKX1gO1xuICAgICAgICAgICAgc3RhdGUuc25hcHNob3QucHJvZ3Jlc3MgPSBudWxsO1xuICAgICAgICAgICAgc3RhdGUuc25hcHNob3QucHJvZ3Jlc3NOb3RlID0gYOivu+i/m+W6puWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gO1xuICAgICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgc3RhdGUudXNhZ2VCdXN5ID0gZmFsc2U7XG4gICAgICAgIGlmIChzdGF0ZS5idG5Vc2FnZVJlZnJlc2hFbCkgc3RhdGUuYnRuVXNhZ2VSZWZyZXNoRWwuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKHN0YXRlLmJ0blByb2dyZXNzUmVmcmVzaEVsKSBzdGF0ZS5idG5Qcm9ncmVzc1JlZnJlc2hFbC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICByZW5kZXJVc2FnZUNoaXAoc3RhdGUpO1xuICAgICAgICByZW5kZXJQcm9ncmVzc0NoaXAoc3RhdGUpO1xuICAgICAgICBpZiAoc3RhdGUudXNhZ2VPcGVuKSByZW5kZXJVc2FnZShzdGF0ZSk7XG4gICAgICAgIGlmIChzdGF0ZS5wcm9ncmVzc09wZW4pIHJlbmRlclByb2dyZXNzKHN0YXRlKTtcbiAgICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6L+b5bqm77yI5riF5Y2VIC8g55uu5qCHIC8g5Zue5ZCI55uu5b2V77yJXG4vL1xuLy8g5pWw5o2u5pivKirlrr/kuLvlkIjlubblpb3nmoTmiJDlk4EqKu+8iGBQcm9ncmVzc1ZpZXdg77yJ77ya5riF5Y2V5LyY5YWI5Y+W5a6e5pe25LqL5Lu244CB57yT5a2Y6KGl5rSe77yMXG4vLyDlm57lkIjnm67lvZXlj6rmnInnvJPlrZjpgqPkuIDot6/vvIjkuovku7bmtYHph4zmsqHmnInjgIzmlbTkuKrml6Xlv5fjgI3ov5nkuKrmpoLlv7XvvInjgIJcbi8vIOmdouadv+i/meS4gOS+p+eahOe6quW+i+S4jueUqOmHj+aKveWxieS4gOagt++8mioq5Y+q55S75LiN566XKiog4oCU4oCUIOi/m+W6pumCo+eCueeul+acr++8iOWujOaIkOWHoOadoeOAgeS4gOWFseWHoOadoeOAgVxuLy8gY2hpcCDkuIrlhpnku4DkuYjvvInlhajlnKggYC4vcHJvZ3Jlc3NgIOmCo+S4que6r+WHveaVsOaooeWdl+mHjO+8iOmCo+mHjOiDvei3keW3suefpeetlOahiO+8jOingeivpeaWh+S7tuWktOazqOmHiu+8ie+8m1xuLy8g5Yeh5raJ5Y+K44CM6L+Z5LiA6L2u566X5LiN566X57uT5p2f5LqG44CN6L+Z57G75Yik5pat77yM5LiA5b6L55So5a6/5Li757uZ55qEIGBzdGFsZWDvvIzpnaLmnb/kuI3oh6rlt7HmjqjjgIJcbi8vXG4vLyDkuInlj6Xlv4Xpobvor7Tlh7rmnaXnmoTor53vvIjmr4/kuIDlj6Xpg73mmK/jgIzkuI3or7TlsLHkvJror6/lr7zjgI3nmoTpgqPnp43vvInvvJpcbi8vIDEuICoq5riF5Y2V5Y+v6IO95piv5LiK5LiA6L2u55qEKiog4oCU4oCUIERTSCDnmoTmipXlvbHlj6PlvoTmmK/jgIzmr4/kuIDmrKEgYHR1cm4vc3RhcnRgIOa4heWNleW9kumbtuOAje+8jFxuLy8gICAg5omA5Lul5pys6L2uIGFnZW50IOi/mOayoeWGmeaWsOihqOaXtu+8jOmdouadv+S4iui/meS4gOS7veWxnuS6juS4iuS4gOi9ru+8jOW/hemhu+agh+WHuuadpe+8m1xuLy8gMi4gKirmuIXljZXpgqPkuIDot6/mmK/lrp7ml7bnmoTjgIHnm67moIflkozlm57lkIjnm67lvZXmmK/nvJPlrZjnu5nnmoQqKu+8iOWQjuiAheacgOWkmuiQveWQjuWHoOadoeS6i+S7tu+8ieKAlOKAlFxuLy8gICAg5LiJ5Z2X5re35Zyo5LiA6LW35pe277yM55So5oi35Lya5Lul5Li65a6D5Lus5LiA5qC35paw77ybXG4vLyAzLiAqKuabtOaXqeeahOWbnuWQiOeCueS4jeWKqCoqIOKAlOKAlCDpnaLmnb/ovazlhpnlj6rnlZnmnIDov5EgNjAwIOadoe+8jOmCo+S4gOi9ruW3sue7j+iiq+aMpOaOieaXtuivtOa4healmu+8jFxuLy8gICAg6ICM5LiN5piv54K55LqG5rKh5Y+N5bqU77yI6Z2Z6buY5aSx6LSl5piv6L+Z6Z2i5p2/5LiK5pyA5LiN6IO95Ye6546w55qE5Lic6KW/77yJ44CCXG5cbi8qKlxuICog5oq95bGJ5aS06YOo6YKj5LiA6KGM77yIKirmsLjov5wqKuacieivneivtO+8ieOAglxuICpcbiAqIOS4jueUqOmHj+aKveWxieWQjOS4gOadoee6quW+i++8muivu+Wksei0pS/msqHor7vmlbDml7bnu5kqKuWOn+WboCoq77yM5pyJ5pWw5o2u5pe257uZKirmlrDpspzluqYqKuOAglxuICog6L+b5bqm6L+Z6YeM5pu06bq754Om5LiA54K577yM5Zug5Li65a6D55qE5LiJ5Z2XKirmnaXmupDkuI3lkIwqKu+8iOa4heWNleWunuaXtuOAgeebruagh+S4juWbnuWQiOebruW9leadpeiHque8k+WtmO+8ie+8jFxuICog5omA5Lul6L+Z5LiA6KGM6KaB5oqK44CM5ZOq5Yeg5Z2X5piv57yT5a2Y55qE44CB6K6w5Yiw56ys5Yeg5p2h5LqL5Lu244CN6K+05riF5qWaIOKAlOKAlCDlj6ror7TkuIDlj6XjgIzmnaXoh6rnvJPlrZjjgI1cbiAqIOS8muiuqeS6uuS7peS4uua4heWNleS5n+aYr+aUkuedgOWGmeeahO+8iOWug+S4jeaYr++8jOWug+aYr+WunuaXtueahO+8ieOAglxuICovXG5mdW5jdGlvbiBwcm9ncmVzc0ZyZXNobmVzcyhwcm9ncmVzczogUHJvZ3Jlc3NWaWV3KTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAocHJvZ3Jlc3MudG9kb3NTb3VyY2UgPT09ICdldmVudHMnICYmIHByb2dyZXNzLnRvZG9zICE9PSBudWxsKSBwYXJ0cy5wdXNoKCfmuIXljZXmnaXoh6rlrp7ml7bkuovku7bvvIhhZ2VudCDmr4/lhpnkuIDmrKHlsLHliLDvvIknKTtcbiAgICBlbHNlIGlmIChwcm9ncmVzcy50b2Rvc1NvdXJjZSA9PT0gJ2NoZWNrcG9pbnQnKSBwYXJ0cy5wdXNoKCfmuIXljZXmnaXoh6rkvJror53mipXlvbHnvJPlrZgnKTtcbiAgICBpZiAocHJvZ3Jlc3MuY3VycmVudFR1cm4gPiAwKSBwYXJ0cy5wdXNoKGDnjrDlnKjnrKwgJHtwcm9ncmVzcy5jdXJyZW50VHVybn0g6L2uYCk7XG4gICAgaWYgKHByb2dyZXNzLnR1cm5zLmxlbmd0aCA+IDAgfHwgcHJvZ3Jlc3MuZ29hbCkge1xuICAgICAgICBpZiAocHJvZ3Jlc3Muc2VxICE9PSBudWxsKSBwYXJ0cy5wdXNoKGDnm67moIfkuI7lm57lkIjnm67lvZXmnaXoh6rkvJror53mipXlvbHnvJPlrZjvvIjmsLTkvY3nrKwgJHtwcm9ncmVzcy5zZXF9IOadoeS6i+S7tu+8iWApO1xuICAgICAgICBlbHNlIHBhcnRzLnB1c2goJ+ebruagh+S4juWbnuWQiOebruW9leadpeiHquS8muivneaKleW9see8k+WtmCcpO1xuICAgIH1cbiAgICBpZiAocHJvZ3Jlc3MuYmVoaW5kICE9PSBudWxsKSBwYXJ0cy5wdXNoKHByb2dyZXNzLmJlaGluZCA+IDAgPyBg6JC95ZCOICR7cHJvZ3Jlc3MuYmVoaW5kfSDmnaFgIDogJ+W3sui3n+S4iicpO1xuICAgIGlmIChwcm9ncmVzcy51cGRhdGVkQXQgPiAwKSBwYXJ0cy5wdXNoKGDlhpnkuo4gJHtmb3JtYXRUaW1lKHByb2dyZXNzLnVwZGF0ZWRBdCl9YCk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJyDCtyAnKTtcbn1cblxuLyoqIOeUu+mCo+milyBjaGlw77yI5rKh5riF5Y2V5bCx5pW06aKX6JeP6LW35p2l77yM57ud5LiN5pi+56S6IGAwLzBg77yJ44CCICovXG5mdW5jdGlvbiByZW5kZXJQcm9ncmVzc0NoaXAoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBjaGlwID0gc3RhdGUucHJvZ3Jlc3NDaGlwO1xuICAgIGlmICghY2hpcCkgcmV0dXJuO1xuICAgIGNvbnN0IHByb2dyZXNzID0gc3RhdGUuc25hcHNob3Q/LnByb2dyZXNzID8/IG51bGw7XG4gICAgY29uc3QgdGV4dCA9IHByb2dyZXNzQ2hpcFRleHQocHJvZ3Jlc3MpO1xuICAgIGlmICghdGV4dCkge1xuICAgICAgICBjaGlwLmhpZGRlbiA9IHRydWU7XG4gICAgICAgIGNoaXAudGV4dENvbnRlbnQgPSAnJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjaGlwLmhpZGRlbiA9IGZhbHNlO1xuICAgIGNoaXAudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIGNoaXAuZGF0YXNldC50b25lID0gcHJvZ3Jlc3M/LnN0YWxlID8gJ3N0YWxlJyA6ICcnO1xuICAgIGNvbnN0IGNvdW50cyA9IHRvZG9Db3VudHMocHJvZ3Jlc3M/LnRvZG9zID8/IFtdKTtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBwYXJ0cy5wdXNoKGNvdW50cy50b3RhbCA+IDAgPyBg5a6M5oiQICR7Y291bnRzLmRvbmV9IC8g5YWxICR7Y291bnRzLnRvdGFsfWAgOiAn5riF5Y2V5piv56m655qEJyk7XG4gICAgaWYgKGNvdW50cy5hY3RpdmUgPiAwKSBwYXJ0cy5wdXNoKGDov5vooYzkuK0gJHtjb3VudHMuYWN0aXZlfWApO1xuICAgIGlmIChwcm9ncmVzcz8uc3RhbGUpIHBhcnRzLnB1c2goYOi/meaYr+esrCAke3Byb2dyZXNzLnRvZG9zVHVybn0g6L2u5YaZ55qE77yM5pys6L2u6L+Y5rKh5YaZ5paw55qEYCk7XG4gICAgaWYgKHByb2dyZXNzPy50b2Rvc1NvdXJjZSA9PT0gJ2NoZWNrcG9pbnQnKSBwYXJ0cy5wdXNoKCfmnaXoh6rmo4Dmn6XngrnvvIjkuI3mmK/lrp7ml7bkuovku7bvvIknKTtcbiAgICBjaGlwLnRpdGxlID0gYCR7cGFydHMuam9pbignIMK3ICcpfVxcbueCueW8gOeci+a4heWNlSAvIOebruaghyAvIOWbnuWQiOebruW9lWA7XG59XG5cbi8qKiDmuIXljZXpgqPkuIDmnaHvvIjmoIforrAgKyDmlofmnKzvvInjgIIgKi9cbmZ1bmN0aW9uIHRvZG9JdGVtKHRvZG86IFRvZG9WaWV3KTogSFRNTEVsZW1lbnQge1xuICAgIGNvbnN0IGl0ZW0gPSBlbCgnZGl2JywgJ2RzaC10b2RvLWl0ZW0nKTtcbiAgICBpdGVtLmRhdGFzZXQuc3RhdHVzID0gdG9kby5zdGF0dXM7XG4gICAgaXRlbS5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtdG9kby1tYXJrJywgVE9ET19NQVJLW3RvZG8uc3RhdHVzXSkpO1xuICAgIGl0ZW0uYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLXRvZG8tdGV4dCcsIHRvZG8uY29udGVudCkpO1xuICAgIHJldHVybiBpdGVtO1xufVxuXG4vKipcbiAqIOWbnuWQiOebruW9lemHjOeahOS4gOadoeOAglxuICpcbiAqIOiDvei3s+eahOeUqCBgPGJ1dHRvbj5g77yI6ZSu55uY5Lmf6IO955So77yJ77yM6Lez5LiN5LqG55qE55SoIGA8ZGl2PmAg4oCU4oCUIOW9oueKtuacrOi6q+WwseWcqOivtFxuICog44CM6L+Z5LiA5p2h54K55LiN5Yqo44CN77yM5q+U55S75oiQ5oyJ6ZKu5YaN5by55LiA5Y+l44CM54K55LiN5Yqo44CN5aW944CCXG4gKi9cbmZ1bmN0aW9uIHR1cm5JdGVtKHN0YXRlOiBVaVN0YXRlLCB0dXJuOiBUdXJuVmlldywgY3VycmVudDogYm9vbGVhbik6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCBqdW1wYWJsZSA9IHR1cm4uZW50cnlTZXEgIT09IG51bGw7XG4gICAgY29uc3QgaXRlbSA9IGVsKGp1bXBhYmxlID8gJ2J1dHRvbicgOiAnZGl2JywgJ2RzaC10dXJuJyk7XG4gICAgaXRlbS5kYXRhc2V0Lmp1bXAgPSBqdW1wYWJsZSA/ICd0cnVlJyA6ICdmYWxzZSc7XG4gICAgaWYgKGN1cnJlbnQpIGl0ZW0uZGF0YXNldC5jdXJyZW50ID0gJ3RydWUnO1xuXG4gICAgY29uc3QgaGVhZCA9IGVsKCdkaXYnLCAnZHNoLXR1cm4taGVhZCcpO1xuICAgIGhlYWQuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLXR1cm4tbm8nLCBg56ysICR7dHVybi50dXJufSDova5gKSk7XG4gICAgLy8g5q+P5LiA6KGM6YO96Ieq5bex6K+05riF44CM6L+Z5p2h54K55LiN54K55b6X5Yqo44CN4oCU4oCUIOiuqeeUqOaIt+WOu+e/u+W6lemDqOeahOivtOaYjuWkque7lVxuICAgIGhlYWQuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnJywgdHVybkhlYWRIaW50KGp1bXBhYmxlKSkpO1xuICAgIGl0ZW0uYXBwZW5kQ2hpbGQoaGVhZCk7XG5cbiAgICBpZiAodHVybi5wcm9tcHQpIGl0ZW0uYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtdHVybi1wcm9tcHQnLCB0dXJuLnByb21wdCkpO1xuICAgIGlmICh0dXJuLnJlc3BvbnNlKSBpdGVtLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXR1cm4tcmVzcG9uc2UnLCB0dXJuLnJlc3BvbnNlKSk7XG4gICAgZWxzZSBpZiAoY3VycmVudCkgaXRlbS5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC10dXJuLXJlc3BvbnNlJywgJ++8iOi/meS4gOi9rui/mOayoee7k+adn++8iScpKTtcblxuICAgIGlmIChqdW1wYWJsZSkge1xuICAgICAgICBpdGVtLnRpdGxlID0gYOi3s+WIsOesrCAke3R1cm4udHVybn0g6L2uYDtcbiAgICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGp1bXBUb1R1cm4oc3RhdGUsIHR1cm4pKTtcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW07XG59XG5cbi8qKlxuICog6Lez5Yiw5p+Q5LiA6L2u55qE6L2s5YaZ5L2N572u44CCXG4gKlxuICog4pqgIOS4juOAjOaQnOWFqOaWh+WRveS4reWQjui3s+i/h+WOu+OAjemCo+adoei3r++8iGBhcHBseUp1bXBg77yJ5YiG5byA5YaZ77ya6YKj5p2h6Lev55qE5aSx5omL5pivKirlronpnZkqKueahFxuICog77yI5ZG95Lit5aSq6Z2g5YmN5pe25Li76L+b56iL5bey57uP57uZ6L+H5LiA5Y+l5o+Q56S65LqG77yJ77yM6ICM6L+Z5LiA5p2h5b+F6aG76Ieq5bex6K+06K+dIOKAlOKAlFxuICog55So5oi35pivKirkuLvliqjngrkqKueahO+8jOeCueS6huayoeWPjeW6lOetieS6jumdouadv+Wdj+S6huOAglxuICovXG5mdW5jdGlvbiBqdW1wVG9UdXJuKHN0YXRlOiBVaVN0YXRlLCB0dXJuOiBUdXJuVmlldyk6IHZvaWQge1xuICAgIGNvbnN0IHRhcmdldCA9IHR1cm4uZW50cnlTZXE7XG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCkge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDnrKwgJHt0dXJuLnR1cm59IOi9rueahOato+aWh+W3sue7j+S4jeWcqOmdouadv+eahOi9rOWGmeeql+WPo+mHjOS6hu+8iOWPquS/neeVmeacgOi/kSA2MDAg5p2h77yJ44CCYCwgJ2luZm8nLCB1bmRlZmluZWQsIDZfMDAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIXN0YXRlLmVscy5oYXModGFyZ2V0KSkge1xuICAgICAgICBzZXRCYW5uZXIoXG4gICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgIGDnrKwgJHt0dXJuLnR1cm59IOi9rueahOato+aWh+WImuWImuiiq+aMpOWHuui9rOWGmeeql+WPo++8iOmdouadv+WPquS/neeVmeacgOi/kSA2MDAg5p2h5p2h55uu77yJ4oCU4oCUIOeCueOAjOWIt+aWsOOAjeWGjeeci+S4gOecvOebruW9leOAgmAsXG4gICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICA2XzAwMCxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0b2dnbGVQcm9ncmVzcyhzdGF0ZSwgZmFsc2UpO1xuICAgIHN0YXRlLmp1bXBUbyA9IHRhcmdldDtcbiAgICBhcHBseUp1bXAoc3RhdGUpO1xufVxuXG4vKipcbiAqIOeUu+i/m+W6puaKveWxie+8iOavj+asoeaVtOWdl+mHjeW7uu+8jOeQhueUseS4jueUqOmHj+aKveWxieebuOWQjO+8muWGheWuueaYr+OAjOivu+S4gOasoeeahOetlOahiOOAje+8ieOAglxuICovXG5mdW5jdGlvbiByZW5kZXJQcm9ncmVzcyhzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGJvZHkgPSBzdGF0ZS5wcm9ncmVzc0JvZHk7XG4gICAgaWYgKCFib2R5KSByZXR1cm47XG4gICAgYm9keS50ZXh0Q29udGVudCA9ICcnO1xuXG4gICAgY29uc3QgcHJvZ3Jlc3MgPSBzdGF0ZS5zbmFwc2hvdD8ucHJvZ3Jlc3MgPz8gbnVsbDtcbiAgICBjb25zdCBub3RlID0gc3RhdGUuc25hcHNob3Q/LnByb2dyZXNzTm90ZSA/PyBudWxsO1xuXG4gICAgaWYgKHN0YXRlLnByb2dyZXNzTm90ZUVsKSB7XG4gICAgICAgIHN0YXRlLnByb2dyZXNzTm90ZUVsLnRleHRDb250ZW50ID0gbm90ZSA/PyAocHJvZ3Jlc3MgPyBwcm9ncmVzc0ZyZXNobmVzcyhwcm9ncmVzcykgOiAnJyk7XG4gICAgICAgIHN0YXRlLnByb2dyZXNzTm90ZUVsLmRhdGFzZXQudG9uZSA9IG5vdGUgPyAnd2FybicgOiAnJztcbiAgICB9XG5cbiAgICBpZiAoIXByb2dyZXNzKSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDjgIzmsqHmnInmlbDlrZflj6/nlLvjgI3nmoTkuKTnp43mnaXot6/kuI3orrjmt7fvvIjkuI7nlKjph4/mir3lsYnlkIzkuIDmnaHnuqrlvovvvInvvJpcbiAgICAgICAgICog6K+75aSx6LSlIOKGkiDljp/lm6DlnKjkuIrpnaLpgqPooYzvvJvov5jmsqHmnInor7vmlbAg4oaSIOivtOa4healmui/m+W6puS7gOS5iOaXtuWAmeaJjeacieOAglxuICAgICAgICAgKi9cbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICdkc2gtdXNhZ2Utc291cmNlJyxcbiAgICAgICAgICAgICAgICBub3RlXG4gICAgICAgICAgICAgICAgICAgID8gJ+i/memHjOayoeacieS4nOilv+WPr+eUuyDigJTigJQg5Y6f5Zug6KeB5LiK6Z2i6YKj6KGM44CC54K544CM5Yi35paw44CN5Y+v5Lul5YaN6K+75LiA5qyh44CCJ1xuICAgICAgICAgICAgICAgICAgICA6ICfov5jmsqHmnInov5vluqYg4oCU4oCUIOa4heWNleimgeetiSBhZ2VudCDlhpnnrKzkuIDku73lvoXlip7vvIznm67moIfkuI7lm57lkIjnm67lvZXmnaXoh6rkvJror53mipXlvbHnvJPlrZjvvIhhZ2VudCDmsqHlnKjot5HkuZ/og73or7vvvInjgIInLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIC0tLS0g4pGgIOW+heWKnua4heWNle+8iOi/meS4gOWdl+aYr+WunuaXtueahO+8iS0tLS1cbiAgICBjb25zdCB0b2RvcyA9IHByb2dyZXNzLnRvZG9zO1xuICAgIGNvbnN0IGJsb2NrID0gZWwoJ2RpdicsICdkc2gtdXNhZ2UtYmxvY2snKTtcbiAgICBibG9jay5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC11c2FnZS1ibG9jay10aXRsZScsICflvoXlip7muIXljZUnKSk7XG4gICAgaWYgKHRvZG9zID09PSBudWxsIHx8IHRvZG9zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBibG9jay5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICdkc2gtdXNhZ2Utc291cmNlJyxcbiAgICAgICAgICAgICAgICB0b2RvcyA9PT0gbnVsbFxuICAgICAgICAgICAgICAgICAgICA/ICfov5nkuIDova4gYWdlbnQg6L+Y5rKh5pyJ5YaZ5riF5Y2V77yIRFNIIOeahOaKleW9seWcqOavj+S4gOi9ruW8gOWni+aXtuaKiua4heWNleW9kumbtu+8ieOAgidcbiAgICAgICAgICAgICAgICAgICAgOiAnYWdlbnQg5piO56Gu5YaZ5LqG5LiA5Lu956m65riF5Y2V77yI5piv5a6D6Ieq5bex5YaZ55qE77yM5LiN5piv6K+75LiN5Yiw77yJ44CCJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgY291bnRzID0gdG9kb0NvdW50cyh0b2Rvcyk7XG4gICAgICAgIGJsb2NrLmFwcGVuZENoaWxkKFxuICAgICAgICAgICAgZWwoXG4gICAgICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICAgICAgJ2RzaC10b2RvLWNvdW50JyxcbiAgICAgICAgICAgICAgICBg5a6M5oiQICR7Y291bnRzLmRvbmV9IC8g5YWxICR7Y291bnRzLnRvdGFsfWAgK1xuICAgICAgICAgICAgICAgICAgICAoY291bnRzLmFjdGl2ZSA+IDAgPyBgIMK3IOi/m+ihjOS4rSAke2NvdW50cy5hY3RpdmV9YCA6ICcnKSArXG4gICAgICAgICAgICAgICAgICAgIChjb3VudHMudG90YWwgLSBjb3VudHMuZG9uZSAtIGNvdW50cy5hY3RpdmUgPiAwID8gYCDCtyDov5jmsqHlvIDlp4sgJHtjb3VudHMudG90YWwgLSBjb3VudHMuZG9uZSAtIGNvdW50cy5hY3RpdmV9YCA6ICcnKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGxpc3QgPSBlbCgnZGl2JywgJ2RzaC10b2RvJyk7XG4gICAgICAgIGZvciAoY29uc3QgdG9kbyBvZiB0b2RvcykgbGlzdC5hcHBlbmRDaGlsZCh0b2RvSXRlbSh0b2RvKSk7XG4gICAgICAgIGJsb2NrLmFwcGVuZENoaWxkKGxpc3QpO1xuICAgIH1cbiAgICAvKipcbiAgICAgKiDkuKTlj6Xlv4Xpobvor7TnmoTor53vvIzmjInmg4XlhrXlh7rnjrDvvIjpobrluo/mnInmhI/kuYnvvJrlhYjor7TjgIzov5nmmK/lk6rkuIDova7nmoTjgI3lho3or7TjgIzmlbDmja7ku47lk6rmnaXjgI3vvInjgIJcbiAgICAgKi9cbiAgICBpZiAocHJvZ3Jlc3Muc3RhbGUpIHtcbiAgICAgICAgYmxvY2suYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICBlbChcbiAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAnZHNoLXVzYWdlLXNvdXJjZScsXG4gICAgICAgICAgICAgICAgYOKaoCDov5nku73muIXljZXmmK/nrKwgJHtwcm9ncmVzcy50b2Rvc1R1cm59IOi9ruWGmeeahCDigJTigJQg56ysICR7cHJvZ3Jlc3MuY3VycmVudFR1cm59IOi9ruW8gOWni+WQjiBEU0gg5bey57uP5oqK5riF5Y2V5b2S6Zu25LqG77yMYCArXG4gICAgICAgICAgICAgICAgICAgICfkuZ/lsLHmmK/or7TjgIzmnKzova4gYWdlbnQg6L+Y5rKh5YaZ5paw5riF5Y2V44CN4oCU4oCU5LiL6Z2i6L+Z5Lqb5LiN5piv546w5Zyo5q2j5Zyo5YGa55qE5LqL44CCJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9ncmVzcy50b2Rvc1NvdXJjZSA9PT0gJ2NoZWNrcG9pbnQnKSB7XG4gICAgICAgIGJsb2NrLmFwcGVuZENoaWxkKFxuICAgICAgICAgICAgZWwoJ2RpdicsICdkc2gtdXNhZ2Utc291cmNlJywgJ+i/meS4gOS7veadpeiHquS8muivneaKleW9see8k+WtmO+8iOS4jeaYr+WunuaXtuS6i+S7tu+8ie+8muWug+aUkuWknyAyMDAg5p2h5LqL5Lu25oiWIDUg56eS5omN5YaZ5LiA5qyh77yM5Y+v6IO95q+U6Z2i5p2/5LiK55yf5a6e5Y+R55Sf55qE5LqL5oWi5Yeg56eS44CCJyksXG4gICAgICAgICk7XG4gICAgfVxuICAgIGJvZHkuYXBwZW5kQ2hpbGQoYmxvY2spO1xuXG4gICAgLy8gLS0tLSDikaEg55uu5qCH77yI5pyJ5omN55S777yJLS0tLVxuICAgIGlmIChwcm9ncmVzcy5nb2FsKSB7XG4gICAgICAgIGNvbnN0IGdvYWwgPSBwcm9ncmVzcy5nb2FsO1xuICAgICAgICBjb25zdCBsaW5lczogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgICAgICBsaW5lcy5wdXNoKHVzYWdlTGluZSgn55uu5qCHJywgZ29hbC5vYmplY3RpdmUpKTtcbiAgICAgICAgbGluZXMucHVzaChcbiAgICAgICAgICAgIHVzYWdlTGluZShcbiAgICAgICAgICAgICAgICAn6Zi25q61JyxcbiAgICAgICAgICAgICAgICBgJHtHT0FMX1BIQVNFX1RFWFRbZ29hbC5waGFzZV0gPz8gZ29hbC5waGFzZX1gICtcbiAgICAgICAgICAgICAgICAgICAgKGdvYWwubWF4R29hbFJvdW5kcyA+IDAgPyBgIMK3IOW3sui3kSAke2dvYWwucm91bmRzU3RhcnRlZH0vJHtnb2FsLm1heEdvYWxSb3VuZHN9IOi9rmAgOiAnJyksXG4gICAgICAgICAgICApLFxuICAgICAgICApO1xuICAgICAgICBpZiAoZ29hbC5ibG9ja2VkUmVhc29uKSBsaW5lcy5wdXNoKHVzYWdlTGluZSgn5Y2h5L2P55qE5Y6f5ZugJywgZ29hbC5ibG9ja2VkUmVhc29uKSk7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQodXNhZ2VCbG9jaygn55uu5qCH77yIZ29hbCDmqKHlvI/vvIknLCBsaW5lcykpO1xuICAgIH1cblxuICAgIC8vIC0tLS0g4pGiIOWbnuWQiOebruW9le+8iOaVtOS4quaXpeW/l++8jOiDveeCueeahOWwseeCue+8iS0tLS1cbiAgICBpZiAocHJvZ3Jlc3MudHVybnMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCB0dXJuc0Jsb2NrID0gZWwoJ2RpdicsICdkc2gtdXNhZ2UtYmxvY2snKTtcbiAgICAgICAgY29uc3QgaGlkZGVuID0gcHJvZ3Jlc3MudHVybnNUb3RhbCAtIHByb2dyZXNzLnR1cm5zLmxlbmd0aDtcbiAgICAgICAgdHVybnNCbG9jay5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICdkc2gtdXNhZ2UtYmxvY2stdGl0bGUnLFxuICAgICAgICAgICAgICAgIGDlm57lkIjnm67lvZXvvIgke3Byb2dyZXNzLnR1cm5zVG90YWx9IOi9riR7aGlkZGVuID4gMCA/IGDvvIzlj6rliJfmnIDov5EgJHtwcm9ncmVzcy50dXJucy5sZW5ndGh9IOi9rmAgOiAnJ33vvIlgLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgbGlzdCA9IGVsKCdkaXYnLCAnZHNoLXRvZG8nKTtcbiAgICAgICAgZm9yIChjb25zdCB0dXJuIG9mIHByb2dyZXNzLnR1cm5zKSBsaXN0LmFwcGVuZENoaWxkKHR1cm5JdGVtKHN0YXRlLCB0dXJuLCB0dXJuLnR1cm4gPT09IHByb2dyZXNzLmN1cnJlbnRUdXJuKSk7XG4gICAgICAgIHR1cm5zQmxvY2suYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDmraPlnKjlhpnnmoTpgqPkuIDova7nmoTojYnnqL/vvJrlroMqKui/mOayoeWumueovyoq77yM5omA5Lul5Y2V54us5LiA6KGM44CB5pac5L2T44CB5L2O5a+55q+U5bqmIOKAlOKAlFxuICAgICAgICAgKiDmt7fov5vkuIrpnaLpgqPku73jgIzlt7Lnu4/nu5PmnZ/nmoTova7mrKHjgI3ph4zkvJrorqnkurrku6XkuLrov5nkuIDova7lt7Lnu4/nrZTlrozkuobjgIJcbiAgICAgICAgICovXG4gICAgICAgIGlmIChwcm9ncmVzcy5kcmFmdCkgdHVybnNCbG9jay5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC10dXJuLWRyYWZ0JywgYOato+WcqOWGme+8miR7cHJvZ3Jlc3MuZHJhZnR9YCkpO1xuICAgICAgICB0dXJuc0Jsb2NrLmFwcGVuZENoaWxkKFxuICAgICAgICAgICAgZWwoXG4gICAgICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICAgICAgJ2RzaC11c2FnZS1zb3VyY2UnLFxuICAgICAgICAgICAgICAgICfnm67lvZXmmK/mlbTkuKrml6Xlv5fnmoTvvIjnvJPlrZjmipjlh7rmnaXnmoTvvInvvJvog73kuI3og73ngrnlj5blhrPkuo7pgqPkuIDova7nmoTmraPmlofov5jlnKjkuI3lnKjpnaLmnb/nmoTovazlhpnph4wg4oCU4oCUIOmdouadv+WPquS/neeVmeacgOi/kSA2MDAg5p2h5p2h55uu44CCJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQodHVybnNCbG9jayk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOKaoCDov5nkuIDlnZcqKuW/hemhuyoq55S75Ye65p2l77yM5ZOq5oCV55uu5b2V5piv56m655qE77ya5LiJ5Z2X6YeM57y65LiA5Z2X6ICMKirku4DkuYjpg73kuI3or7QqKu+8jFxuICAgICAgICAgKiDnlKjmiLfnnIvliLDnmoTmmK/jgIzpnaLmnb/kuIrmsqHmnInlm57lkIjnm67lvZXjgI3igJTigJTliIbkuI3muIXjgIzov5nmnaHkvJror53msqHmnInlm57lkIjjgI3kuI5cbiAgICAgICAgICog44CM57yT5a2Y6YeM5rKh5pyJ6L+Z5LiA6KGM44CN44CC5Lik5Y+l6K+d5a6M5YWo5LiN5ZCM77yI5YmN6ICF5piv5LqL5a6e77yM5ZCO6ICF5piv5pWw5o2u5rqQ57y65LqG5LiA5Z2X77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKFxuICAgICAgICAgICAgdXNhZ2VCbG9jaygn5Zue5ZCI55uu5b2VJywgW1xuICAgICAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAgICAgJ2RzaC11c2FnZS1zb3VyY2UnLFxuICAgICAgICAgICAgICAgICAgICBwcm9ncmVzcy5jdXJyZW50VHVybiA+IDBcbiAgICAgICAgICAgICAgICAgICAgICAgID8gYOe8k+WtmOmHjOayoeacieWbnuWQiOWkp+e6su+8iOS6i+S7tua1geaYvuekuuW3sue7j+WIsOesrCAke3Byb2dyZXNzLmN1cnJlbnRUdXJufSDova7kuobvvInigJTigJQg6L+Z5LiA5Z2X5Y+q5pyJ5Lya6K+d5oqV5b2x57yT5a2Y57uZ5b6X5Ye677yIYWdlbnQg5rKh5Zyo6LeR44CB5oiW6ICF57yT5a2Y6YeM5rKh6L+Z5LiA6KGM5pe25bCx55yL5LiN5Yiw77yJ44CCYFxuICAgICAgICAgICAgICAgICAgICAgICAgOiAn6L+Z5p2h5Lya6K+d6L+Y5rKh5pyJ5Zue5ZCI77yI6L+Y5rKh5Y+R6L+H5raI5oGv77yJ44CCJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgXSksXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSDikaMg5Y+j5b6E6K+05piOIC0tLS1cbiAgICBpZiAocHJvZ3Jlc3Mubm90ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBub3RlcyA9IGVsKCdkaXYnLCAnZHNoLXVzYWdlLW5vdGVzJyk7XG4gICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBwcm9ncmVzcy5ub3Rlcykgbm90ZXMuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtdXNhZ2Utbm90ZXMtaXRlbScsIHRleHQpKTtcbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChub3Rlcyk7XG4gICAgfVxufVxuXG4vKiog5byAL+WFs+i/m+W6puaKveWxie+8iOaJk+W8gOaXtumhuuaJi+imgeS4gOasoeaWsOivu+aVsO+8jOeQhueUseS4jueUqOmHj+aKveWxieebuOWQjO+8ieOAgiAqL1xuZnVuY3Rpb24gdG9nZ2xlUHJvZ3Jlc3Moc3RhdGU6IFVpU3RhdGUsIG9wZW4/OiBib29sZWFuKTogdm9pZCB7XG4gICAgY29uc3QgbmV4dCA9IG9wZW4gPz8gIXN0YXRlLnByb2dyZXNzT3BlbjtcbiAgICBzdGF0ZS5wcm9ncmVzc09wZW4gPSBuZXh0O1xuICAgIGlmIChzdGF0ZS5wcm9ncmVzc0hvc3QpIHN0YXRlLnByb2dyZXNzSG9zdC5oaWRkZW4gPSAhbmV4dDtcbiAgICBpZiAobmV4dCkge1xuICAgICAgICByZW5kZXJQcm9ncmVzcyhzdGF0ZSk7XG4gICAgICAgIHZvaWQgcmVhZFVzYWdlKHN0YXRlKTtcbiAgICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5rS75Yqo77yI5ZCO5Y+w5Lu75YqhIC8g5a2QIGFnZW5077yJXG5cbi8qKlxuICog6Z2i5p2/5LiK44CM5rS75Yqo44CN6YKj5p2h5o6n5Yi25bin55qE6IqC5rWB6Ze06ZqU77yI5q+r56eS77yJ44CCXG4gKlxuICog5Li65LuA5LmI5pivKirova7or6IqKuiAjOS4jeaYr+etieaOqOmAge+8mui/meS4pOS4quacjeWKoSoq5rKh5pyJ5Y+v6K6i6ZiF55qE5Y+Y5YyW5LqL5Lu2Kiog4oCU4oCUXG4gKiBgam9icy5vbkpvYnNDaGFuZ2VkYCDlj6rlnKjjgIzpm4blkIjlj5jkuobjgI3ml7blk43vvIjms6jlhowgLyBraWxsIC8gc2V0dGxlIC8g5oul5pyJ6ICF6ZSA5q+B77yJ77yMXG4gKiAqKui+k+WHuuWinumVv+S4jeinpuWPkSoq77yb5a2QIGFnZW50IOmCo+i+ueWPquaciSBgc3ViYWdlbnQvc3RhcnR8ZW5kYCDkuKTkuKrnspfkuovku7bjgIJcbiAqIOaJgOS7peaDs+imgeOAjOWQjuWPsOi/mOWcqOi3keS7gOS5iOOAjei/meS7tuS6i+aYr+aWsOeahO+8jOWwseWPquiDveaMieiKgua1gemXruOAglxuICpcbiAqIDQg56eS6L+Z5Liq5pWw77yaam9iIOeahOeykuW6puaYr+OAjOS4gOadoeWRveS7pOi3keWHoOenkuWIsOWHoOWIhumSn+OAje+8jDQg56eS6Laz5aSf55yL5Ye65a6D57uT5p2f5LqG77ybXG4gKiDogIzkuJTlroMqKuWPquWcqOacieS4nOilv+WPr+eci+aXtuaJjei9ruivoioq77yI6KeBIGBzaG91bGRQb2xsQWN0aXZpdHlg77yJ4oCU4oCUIOepuumXsuaXtuS4gOasoemDveS4jemXruOAglxuICovXG5jb25zdCBBQ1RJVklUWV9QT0xMX01TID0gNF8wMDA7XG5cbi8qKlxuICog6Zeu5LiA5qyh5Li76L+b56iL6KaB44CM5rS75Yqo44CN6YKj5LiA5Lu977yI5ZCO5Y+w5Lu75YqhICsg5a2QIGFnZW5077yJ44CCXG4gKlxuICog4pqgIOS4jueUqOmHjy/ov5vluqbpgqPkuKTlnZcqKuacgOimgee0p+eahOWMuuWIqyoq77ya6YKj5Lik5Liq6K+755qE5piv56OB55uY5LiK55qE5qOA5p+l54K577yIYWdlbnQg5rKh5Zyo6LeR54Wn5qC36IO955yL77yJ77yMXG4gKiDogIzov5nkuKTlnZflj6rmtLvlnKgqKui/kOihjOaXtui/m+eoi+eahOWGheWtmOmHjCoqIOKAlOKAlCBhZ2VudCDmsqHotbflsLHnnJ/nmoTku4DkuYjpg73nnIvkuI3liLDvvIxcbiAqIOaJgOS7pei/memHjOWksei0pS/kuLrnqbrml7bor7TnmoTor53kuI7lj6blpJbkuKTkuKrmir3lsYnkuI3kuIDmoLfvvIjkuI3orrjor7TmiJDjgIzor7vnm5jlpLHotKXjgI3vvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSBvcHRpb25zLnF1aWV0IC0g6Z2Z6buY5qih5byP77yI5ZCO5Y+w6L2u6K+i55So77yJ77ya5aSx6LSl5LiN5by55qiq5bmF77yM5Y+q5oqK5Y6f5Zug5YaZ6L+b5oq95bGJ5aS06YOo44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRBY3Rpdml0eShzdGF0ZTogVWlTdGF0ZSwgb3B0aW9uczogeyBxdWlldD86IGJvb2xlYW4gfSA9IHt9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN0YXRlLmFjdGl2aXR5QnVzeSkgcmV0dXJuO1xuICAgIGNvbnN0IHNuYXBzaG90ID0gc3RhdGUuc25hcHNob3Q7XG4gICAgaWYgKCFzbmFwc2hvdCB8fCBzbmFwc2hvdC5zdGF0dXMgIT09ICdyZWFkeScpIHtcbiAgICAgICAgLy8g5rKh6LW3IGFnZW50IOWwseayoeacieWGheWtmOmHjOeahOS4nOilv+WPr+eciyDigJTigJQg6L+Z5LiA5p2h6KaBKirlvZPlnLror7Tlh7rmnaUqKu+8jOWIq+eVmeS4gOS4quepuuaKveWxiVxuICAgICAgICBzdGF0ZS5hY3Rpdml0eSA9IG51bGw7XG4gICAgICAgIHN0YXRlLmFjdGl2aXR5QXQgPSBEYXRlLm5vdygpO1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eU5vdGUgPSAnYWdlbnQg5rKh5Zyo6LeR77ya5ZCO5Y+w5Lu75Yqh5LiO5a2QIGFnZW50IOWPqua0u+WcqOi/kOihjOaXtui/m+eoi+mHjO+8jOWBnOaOieS5i+WQjuWwseayoeS6hu+8iOWOhuWPsuS8muivneS5n+eci+S4jeWIsOWug+S7rO+8ieOAgic7XG4gICAgICAgIHJlbmRlckFjdGl2aXR5KHN0YXRlKTtcbiAgICAgICAgcmVuZGVyQWN0aXZpdHlDaGlwKHN0YXRlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5hY3Rpdml0eUJ1c3kgPSB0cnVlO1xuICAgIGlmIChzdGF0ZS5idG5BY3Rpdml0eVJlZnJlc2hFbCkgc3RhdGUuYnRuQWN0aXZpdHlSZWZyZXNoRWwuZGlzYWJsZWQgPSB0cnVlO1xuICAgIGlmIChzdGF0ZS5hY3Rpdml0eU5vdGVFbCAmJiBzdGF0ZS5hY3Rpdml0eU9wZW4pIHtcbiAgICAgICAgc3RhdGUuYWN0aXZpdHlOb3RlRWwudGV4dENvbnRlbnQgPSAn6K+75Y+W5Lit4oCmJztcbiAgICAgICAgc3RhdGUuYWN0aXZpdHlOb3RlRWwuZGF0YXNldC50b25lID0gJyc7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBhY3Rpdml0eT86IEFjdGl2aXR5VmlldzsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLnBhbmVsQWN0aXZpdHkpO1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eSA9IHJlcGx5Py5hY3Rpdml0eSA/PyBudWxsO1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eUF0ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgc3RhdGUuYWN0aXZpdHlOb3RlID0gcmVwbHk/Lm9rID8gbnVsbCA6IGDor7vmtLvliqjlpLHotKXvvJoke3JlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gO1xuICAgICAgICBpZiAoIXJlcGx5Py5vayAmJiAhb3B0aW9ucy5xdWlldCkge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg6K+75rS75Yqo5aSx6LSl77yaJHtyZXBseT8uZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YCwgJ2Vycm9yJywgdW5kZWZpbmVkLCA2XzAwMCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eSA9IG51bGw7XG4gICAgICAgIHN0YXRlLmFjdGl2aXR5QXQgPSBEYXRlLm5vdygpO1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eU5vdGUgPSBg6K+75rS75Yqo5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWA7XG4gICAgICAgIGlmICghb3B0aW9ucy5xdWlldCkgc2V0QmFubmVyKHN0YXRlLCBg6K+75rS75Yqo5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWAsICdlcnJvcicsIHVuZGVmaW5lZCwgNl8wMDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIHN0YXRlLmFjdGl2aXR5QnVzeSA9IGZhbHNlO1xuICAgICAgICBpZiAoc3RhdGUuYnRuQWN0aXZpdHlSZWZyZXNoRWwpIHN0YXRlLmJ0bkFjdGl2aXR5UmVmcmVzaEVsLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIHJlbmRlckFjdGl2aXR5KHN0YXRlKTtcbiAgICAgICAgcmVuZGVyQWN0aXZpdHlDaGlwKHN0YXRlKTtcbiAgICB9XG59XG5cbi8qKiDov5npopcgY2hpcCDor6XkuI3or6Xkuq4gKyDkuq7ku4DkuYjvvIgqKuayoeS6i+WwseaVtOS4quiXj+i1t+adpSoq77yM5LiN5YaZIDDvvInjgIIgKi9cbmZ1bmN0aW9uIGFjdGl2aXR5Q2hpcFRleHQoYWN0aXZpdHk6IEFjdGl2aXR5VmlldyB8IG51bGwpOiBzdHJpbmcge1xuICAgIGlmICghYWN0aXZpdHkpIHJldHVybiAnJztcbiAgICBjb25zdCBqb2JzID0gYWN0aXZpdHkuam9icy5sZW5ndGg7XG4gICAgY29uc3Qgc3VicyA9IGFjdGl2aXR5LnN1YmFnZW50cy5sZW5ndGg7XG4gICAgaWYgKGpvYnMgPT09IDAgJiYgc3VicyA9PT0gMCkgcmV0dXJuICcnO1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChqb2JzID4gMCkgcGFydHMucHVzaChg5ZCO5Y+wICR7am9ic31gKTtcbiAgICBpZiAoc3VicyA+IDApIHBhcnRzLnB1c2goYOWtkCAke3N1YnN9YCk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJyDCtyAnKTtcbn1cblxuLyoqIOacieS4nOilv+i/mOWcqOi3keWQl++8iOWGs+WumiBjaGlwIOeUqOS4jeeUqOW8uuiwg+iJsu+8ieOAgiAqL1xuZnVuY3Rpb24gYWN0aXZpdHlCdXN5Tm93KGFjdGl2aXR5OiBBY3Rpdml0eVZpZXcgfCBudWxsKTogYm9vbGVhbiB7XG4gICAgaWYgKCFhY3Rpdml0eSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAoXG4gICAgICAgIGFjdGl2aXR5LmpvYnMuc29tZSgoam9iKSA9PiBqb2Iuc3RhdHVzID09PSAncnVubmluZycgfHwgam9iLnN0YXR1cyA9PT0gJ3N0b3BwaW5nJykgfHxcbiAgICAgICAgYWN0aXZpdHkuc3ViYWdlbnRzLnNvbWUoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gJ3J1bm5pbmcnKVxuICAgICk7XG59XG5cbi8qKiDnlLvpgqPpopcgY2hpcO+8iOayoeS4nOilv+WwseiXj+i1t+adpSDigJTigJQg5LiO5YmN5Lik6aKXIGNoaXAg5ZCM5LiA5p2h57qq5b6L77yJ44CCICovXG5mdW5jdGlvbiByZW5kZXJBY3Rpdml0eUNoaXAoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBjaGlwID0gc3RhdGUuYWN0aXZpdHlDaGlwO1xuICAgIGlmICghY2hpcCkgcmV0dXJuO1xuICAgIGNvbnN0IHRleHQgPSBhY3Rpdml0eUNoaXBUZXh0KHN0YXRlLmFjdGl2aXR5KTtcbiAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgY2hpcC5oaWRkZW4gPSB0cnVlO1xuICAgICAgICBjaGlwLnRleHRDb250ZW50ID0gJyc7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2hpcC5oaWRkZW4gPSBmYWxzZTtcbiAgICBjaGlwLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICBjaGlwLmRhdGFzZXQudG9uZSA9IGFjdGl2aXR5QnVzeU5vdyhzdGF0ZS5hY3Rpdml0eSkgPyAnYnVzeScgOiAnJztcbiAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICBub3Rlcy5wdXNoKGDngrnlvIDnnIvlkI7lj7Dku7vliqHkuI7lrZAgYWdlbnTvvIjor7vliLAgJHtmb3JtYXRUaW1lKHN0YXRlLmFjdGl2aXR5Py5hdCA/PyAwKX3vvIlgKTtcbiAgICBpZiAoYWN0aXZpdHlCdXN5Tm93KHN0YXRlLmFjdGl2aXR5KSkgbm90ZXMucHVzaCgn6L+Y5pyJ5Lic6KW/5Zyo6LeRJyk7XG4gICAgY2hpcC50aXRsZSA9IG5vdGVzLmpvaW4oJyDCtyAnKTtcbn1cblxuLyoqIGpvYiDnirbmgIHnmoTkuK3mlofkuI7oibLosIPvvIjorqTkuI3lh7rnmoTljp/lgLzmmK/jgIzkuI3mmI7jgI3vvIzkuI3mmK/jgIzlnKjot5HjgI3vvInjgIIgKi9cbmNvbnN0IEpPQl9TVEFUVVNfVEVYVDogUmVjb3JkPEpvYlZpZXdbJ3N0YXR1cyddLCB7IHRleHQ6IHN0cmluZzsgdG9uZTogc3RyaW5nIH0+ID0ge1xuICAgIHJ1bm5pbmc6IHsgdGV4dDogJ+i/kOihjOS4rScsIHRvbmU6ICdidXN5JyB9LFxuICAgIHN0b3BwaW5nOiB7IHRleHQ6ICfmraPlnKjlgZwnLCB0b25lOiAnYnVzeScgfSxcbiAgICBjb21wbGV0ZWQ6IHsgdGV4dDogJ+W3suWujOaIkCcsIHRvbmU6ICdkb25lJyB9LFxuICAgIGtpbGxlZDogeyB0ZXh0OiAn5bey57uI5q2iJywgdG9uZTogJ3dhcm4nIH0sXG4gICAgZmFpbGVkOiB7IHRleHQ6ICflpLHotKUnLCB0b25lOiAnZXJyb3InIH0sXG4gICAgdW5rbm93bjogeyB0ZXh0OiAn54q25oCB5LiN5piOJywgdG9uZTogJ3dhcm4nIH0sXG59O1xuXG4vKiog5a2QIGFnZW50IOW/memXsueahOS4reaWh++8iGByZWFkeWAgPSDlj6rlnKjno4Hnm5jkuIrvvIzlj6/ku6XmjqXnnYDogYrvvInjgIIgKi9cbmNvbnN0IFNVQkFHRU5UX1NUQVRVU19URVhUOiBSZWNvcmQ8U3ViYWdlbnRWaWV3WydzdGF0dXMnXSwgc3RyaW5nPiA9IHtcbiAgICBydW5uaW5nOiAn6L+Q6KGM5LitJyxcbiAgICBpZGxlOiAn56m66ZeyJyxcbiAgICByZWFkeTogJ+WPr+e7p+e7rScsXG59O1xuXG4vKiog5ZCO5Y+w5Lu75Yqh6YKj5LiA6KGM44CCICovXG5mdW5jdGlvbiBqb2JJdGVtKGpvYjogSm9iVmlldywgY3VycmVudFNlc3Npb25JZDogc3RyaW5nIHwgbnVsbCk6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCBpdGVtID0gZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktaXRlbSBkc2gtam9iJyk7XG4gICAgY29uc3Qgc3RhdHVzID0gSk9CX1NUQVRVU19URVhUW2pvYi5zdGF0dXNdID8/IEpPQl9TVEFUVVNfVEVYVC51bmtub3duO1xuICAgIGl0ZW0uZGF0YXNldC50b25lID0gc3RhdHVzLnRvbmU7XG5cbiAgICBjb25zdCBoZWFkID0gZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktaXRlbS1oZWFkJyk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtYWN0aXZpdHktYmFkZ2UnLCBzdGF0dXMudGV4dCkpO1xuICAgIGlmIChqb2Iua2luZCkgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtYWN0aXZpdHkta2luZCcsIGpvYi5raW5kKSk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtYWN0aXZpdHktaWQnLCBqb2IuaWQpKTtcbiAgICBpdGVtLmFwcGVuZENoaWxkKGhlYWQpO1xuXG4gICAgLy8gbGFiZWwg5Y+v6IO95piv5pW05p2h5ZG95Luk5Y6f5paH77yIcHdzaCDlsLHmmK/ov5nkuYjkvKDnmoTvvInvvJrljp/moLfnlLvvvIzpnaAgQ1NTIOaNouihjO+8jOS4jeWBmuS6jOasoeWKoOW3pVxuICAgIGl0ZW0uYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktbGFiZWwnLCBqb2IubGFiZWwgfHwgJ++8iOi/meadoeS7u+WKoeayoeacieivtOaYju+8iScpKTtcblxuICAgIGNvbnN0IG1ldGE6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGpvYi5zdGFydGVkQXQpIG1ldGEucHVzaChg6LW35LqOICR7Zm9ybWF0VGltZShqb2Iuc3RhcnRlZEF0KX1gKTtcbiAgICBpZiAoam9iLmZpbmlzaGVkQXQpIG1ldGEucHVzaChg57uT5p2f5LqOICR7Zm9ybWF0VGltZShqb2IuZmluaXNoZWRBdCl9YCk7XG4gICAgaWYgKGpvYi5kZXRhaWwpIG1ldGEucHVzaChqb2IuZGV0YWlsKTtcbiAgICAvLyDlrZAgYWdlbnQg6LW355qE5Lu75Yqh5b2S5a2QIGFnZW50IOKAlOKAlCDkuI3moIflh7rmnaXnmoTor53vvIznlKjmiLfkvJrku6XkuLrjgIzmiJHov5nmnaHkvJror53mgI7kuYjlpJrkuobkuKrku7vliqHjgI1cbiAgICBpZiAoam9iLm93bmVyU2Vzc2lvbklkICYmIGN1cnJlbnRTZXNzaW9uSWQgJiYgam9iLm93bmVyU2Vzc2lvbklkICE9PSBjdXJyZW50U2Vzc2lvbklkKSB7XG4gICAgICAgIG1ldGEucHVzaChg5bGe5LqO5a2QIGFnZW50ICR7am9iLm93bmVyU2Vzc2lvbklkLnNsaWNlKDAsIDgpfeKApiR7am9iLmRlcHRoID09PSBudWxsID8gJycgOiBg77yI56ysICR7am9iLmRlcHRofSDlsYLvvIlgfWApO1xuICAgIH1cbiAgICBpZiAobWV0YS5sZW5ndGggPiAwKSBpdGVtLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWFjdGl2aXR5LW1ldGEnLCBtZXRhLmpvaW4oJyDCtyAnKSkpO1xuICAgIHJldHVybiBpdGVtO1xufVxuXG4vKiog5a2QIGFnZW50IOmCo+S4gOihjO+8iOW4puS4gOS4quOAjOS4reaWreW9k+WJjeS4gOi9ruOAjeaMiemSru+8ieOAgiAqL1xuZnVuY3Rpb24gc3ViYWdlbnRJdGVtKHN0YXRlOiBVaVN0YXRlLCByb3c6IFN1YmFnZW50Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCBpdGVtID0gZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktaXRlbSBkc2gtc3ViYWdlbnQnKTtcbiAgICBpdGVtLmRhdGFzZXQudG9uZSA9IHJvdy5zdGF0dXMgPT09ICdydW5uaW5nJyA/ICdidXN5JyA6IHJvdy5raW5kID09PSAnZGlhZ25vc3RpYycgPyAnd2FybicgOiAnaWRsZSc7XG5cbiAgICBjb25zdCBoZWFkID0gZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktaXRlbS1oZWFkJyk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtYWN0aXZpdHktYmFkZ2UnLCBTVUJBR0VOVF9TVEFUVVNfVEVYVFtyb3cuc3RhdHVzXSA/PyByb3cuc3RhdHVzKSk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtYWN0aXZpdHkta2luZCcsIHJvdy5tb2RlID09PSAnY29udGludWFibGUnID8gJ+WPr+e7p+e7rScgOiAn5LiA5qyh5oCnJykpO1xuICAgIGlmIChyb3cuZGVwdGggIT09IG51bGwpIGhlYWQuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLWFjdGl2aXR5LWlkJywgYOesrCAke3Jvdy5kZXB0aH0g5bGCYCkpO1xuICAgIC8qKlxuICAgICAqIOOAjOS4reaWreOAjeWPquWvuSoq5rS7552A55qEKirlrZAgYWdlbnQg5pyJ5oSP5LmJ77yIYHJlYWR5YCA9IOWug+WPquWcqOejgeebmOS4iu+8jOi/kOihjOaXtumHjOayoeacieWug+eahCBhZ2VudO+8ieOAglxuICAgICAqIOaMiemSruWBmuS4jeWHuuadpeeahOaXtuWAmeS4jeeUu+S4gOS4quemgeeUqOeahOWBh+aMiemSriDigJTigJQg55u05o6l5LiN55S744CCXG4gICAgICovXG4gICAgaWYgKHJvdy5zdGF0dXMgIT09ICdyZWFkeScpIHtcbiAgICAgICAgY29uc3Qgc3RvcCA9IGVsKCdidXR0b24nLCAnZHNoLWJ0biBkc2gtYWN0aXZpdHktc3RvcCcsICfkuK3mlq3lvZPliY3kuIDova4nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICAgICAgc3RvcC50aXRsZSA9ICflj6rlgZzlroPlvZPliY3ov5nkuIDova4g4oCU4oCUIOS8muivneS4juS4iuS4i+aWh+mDveeVmeedgO+8iOWQjOOAjOWBnOatouacrOi9ruOAje+8iSc7XG4gICAgICAgIHN0b3AuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBzdG9wLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLnN1YmFnZW50SW50ZXJydXB0LCB7IHN1YmFnZW50SWQ6IHJvdy5pZCB9KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZXBseT8ub2spIHNldEJhbm5lcihzdGF0ZSwgYOS4reaWreWksei0pe+8miR7cmVwbHk/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWAsICdlcnJvcicsIHVuZGVmaW5lZCwgNl8wMDApO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOS4reaWreWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InLCB1bmRlZmluZWQsIDZfMDAwKTtcbiAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgICBzdG9wLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIHZvaWQgcmVhZEFjdGl2aXR5KHN0YXRlLCB7IHF1aWV0OiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgIH0pO1xuICAgICAgICBoZWFkLmFwcGVuZENoaWxkKHN0b3ApO1xuICAgIH1cbiAgICBpdGVtLmFwcGVuZENoaWxkKGhlYWQpO1xuXG4gICAgaXRlbS5hcHBlbmRDaGlsZChcbiAgICAgICAgZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktbGFiZWwnLCByb3cubGFiZWwgfHwgYO+8iOi/meadoeWtkCBhZ2VudCDmsqHnu5nor7TmmI7vvIkke3Jvdy5pZC5zbGljZSgwLCA4KX3igKZgKSxcbiAgICApO1xuXG4gICAgY29uc3QgbWV0YTogc3RyaW5nW10gPSBbYCR7cm93LmlkLnNsaWNlKDAsIDgpfeKApmBdO1xuICAgIGlmIChyb3cuaGFzQ2hpbGRyZW4pIG1ldGEucHVzaCgn5a6D6Ieq5bex6L+Y5bim5LqG5LiL57qnJyk7XG4gICAgaWYgKHJvdy5raW5kID09PSAnZGlhZ25vc3RpYycpIG1ldGEucHVzaChg6L+Z5p2h6K6w5b2V5pys6Lqr5pyJ6Zeu6aKY77yaJHtyb3cucmVhc29uID8/ICfljp/lm6DkuI3mmI4nfWApO1xuICAgIC8vIOKaoCDkuKTkuKrlrZfmrrXpg73lnKjvvIzkvYblkKvkuYnlrozlhajkuI3lkIzvvIzmiYDku6Xpg73opoHor7Tlh7rmnaVcbiAgICBtZXRhLnB1c2gocm93LmFjdGl2aXR5ID09PSAncnVubmluZycgPyAn5Lya6K+d6K6w5b2V5Zyo5YaF5a2Y6YeMJyA6ICfkvJror53orrDlvZXlj6rlnKjno4Hnm5jkuIonKTtcbiAgICBpdGVtLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWFjdGl2aXR5LW1ldGEnLCBtZXRhLmpvaW4oJyDCtyAnKSkpO1xuICAgIHJldHVybiBpdGVtO1xufVxuXG4vKipcbiAqIOeUu+a0u+WKqOaKveWxie+8iOavj+asoeaVtOWdl+mHjeW7uu+8jOeQhueUseS4juWPpuWkluS4pOS4quaKveWxieebuOWQjO+8muWGheWuueaYr+OAjOmXruS4gOasoeeahOetlOahiOOAje+8ieOAglxuICpcbiAqICMjIOS4ieWPpeW/hemhu+eUu+WHuuadpeeahOivnVxuICpcbiAqIDEuICoq5ZCO5Y+w5Lu75Yqh55qE6L6T5Ye655yL5LiN5YiwKiog4oCU4oCUIOS4jeaYr+ayoeWBmu+8jOaYryoq5LiN6IO95YGaKirvvJrmr4/kuKogam9iIOWPquacieS4gOS4qua2iOi0uea4uOagh++8jFxuICogICAg6Z2i5p2/6K+75LiA5qyh5bCx5Lya6K6p5qih5Z6L55qEIGBqb2Jfb3V0cHV0YCDlj5jmiJAgYChubyBuZXcgb3V0cHV0KWDjgIJcbiAqIDIuICoq6L+Z5Lqb5pWw5a2X5Y+q5rS75Zyo5YaF5a2Y6YeMKiog4oCU4oCUIGFnZW50IOWBnOaOieS5i+WQjuWwseafpeaXoOatpOeJqe+8iOWOhuWPsuS8muivneeci+S4jeWIsOWug+S7rO+8ieOAglxuICogMy4gKirmnI3liqHmsqHmjILml7bor7TmuIXmmK/lk6rkuKrmnI3liqEqKiDigJTigJQg5LiO44CM6K+75aSx6LSl44CN5YiG5byA6K+044CCXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckFjdGl2aXR5KHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgYm9keSA9IHN0YXRlLmFjdGl2aXR5Qm9keTtcbiAgICBpZiAoIWJvZHkpIHJldHVybjtcbiAgICBib2R5LnRleHRDb250ZW50ID0gJyc7XG5cbiAgICBjb25zdCBhY3Rpdml0eSA9IHN0YXRlLmFjdGl2aXR5O1xuICAgIGlmIChzdGF0ZS5hY3Rpdml0eU5vdGVFbCkge1xuICAgICAgICAvLyDkuInlj6Xor53nmoTkvJjlhYjnuqfvvJoqKuivu+S4jeWHuuadpSAvIOayoei1tyBhZ2VudCDnmoTljp/lm6AqKiA+IOivu+WIsOWHoOeCuSA+IOi/mOayoeacieivu+aVsFxuICAgICAgICBjb25zdCBub3RlID0gc3RhdGUuYWN0aXZpdHlOb3RlID8/IChhY3Rpdml0eSA/IGDor7vliLAgJHtmb3JtYXRUaW1lKGFjdGl2aXR5LmF0KX0gwrcg6L+Z5Lik5Z2X5Y+q5rS75Zyo6L+Q6KGM5pe26L+b56iL55qE5YaF5a2Y6YeM77yIYWdlbnQg5YGc5o6J5bCx5rKh5LqG77yJYCA6ICcnKTtcbiAgICAgICAgc3RhdGUuYWN0aXZpdHlOb3RlRWwudGV4dENvbnRlbnQgPSBub3RlO1xuICAgICAgICBzdGF0ZS5hY3Rpdml0eU5vdGVFbC5kYXRhc2V0LnRvbmUgPSBzdGF0ZS5hY3Rpdml0eU5vdGUgPyAnd2FybicgOiAnJztcbiAgICB9XG5cbiAgICBpZiAoIWFjdGl2aXR5KSB7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICBlbCgnZGl2JywgJ2RzaC11c2FnZS1zb3VyY2UnLCAn6L+Y5rKh5pyJ6K+75pWwIOKAlOKAlCDngrnkuIrpnaLnmoTjgIzliLfmlrDjgI3vvIzmiJbogIXlhYjorqkgYWdlbnQg6LeR6LW35p2l77yI6L+Z5Lik5Z2X5Zyo5YaF5a2Y6YeM77yJ44CCJyksXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyAtLS0tIOS4iuWNiuWdl++8muWQjuWPsOS7u+WKoVxuICAgIGJvZHkuYXBwZW5kQ2hpbGQodXNhZ2VCbG9jaygn5ZCO5Y+w5Lu75YqhJywgYWN0aXZpdHlBdmFpbGFibGVMaW5lcyhhY3Rpdml0eSwgJ2pvYnMnKSkpO1xuICAgIGlmIChhY3Rpdml0eS5qb2JzQXZhaWxhYmxlKSB7XG4gICAgICAgIGlmIChhY3Rpdml0eS5qb2JzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgYm9keS5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC11c2FnZS1zb3VyY2UnLCAn546w5Zyo5rKh5pyJ5ZCO5Y+w5Lu75Yqh44CCJykpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgbGlzdCA9IGVsKCdkaXYnLCAnZHNoLWFjdGl2aXR5LWxpc3QnKTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qgam9iIG9mIGFjdGl2aXR5LmpvYnMpIGxpc3QuYXBwZW5kQ2hpbGQoam9iSXRlbShqb2IsIHN0YXRlLnNuYXBzaG90Py5zZXNzaW9uSWQgPz8gbnVsbCkpO1xuICAgICAgICAgICAgYm9keS5hcHBlbmRDaGlsZChsaXN0KTtcbiAgICAgICAgICAgIC8vIOKaoCDov5nlj6XmmK/jgIzlpoLlrp7or7TmmI7jgI3ogIzkuI3mmK/lhY3otKPvvJrnlKjmiLfmnIDmg7PnnIvnmoTmgbDmgbDmmK/ovpPlh7pcbiAgICAgICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICAgICAgZWwoXG4gICAgICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICAgICAnZHNoLXVzYWdlLXNvdXJjZScsXG4gICAgICAgICAgICAgICAgICAgICfnnIvkuI3liLDku7vliqHnmoTovpPlh7og4oCU4oCUIOavj+S4quWQjuWPsOS7u+WKoeWPquacieS4gOS4qua2iOi0uea4uOagh++8jOmdouadv+ivu+S4gOasoeWwseS8muaKiuaooeWei+eahCBqb2Jfb3V0cHV0IOWPmOaIkOOAjChubyBuZXcgb3V0cHV0KeOAjeOAgicgK1xuICAgICAgICAgICAgICAgICAgICAgICAgJ+aDs+eci+i+k+WHuuWwseWcqOWvueivnemHjOiuqeaooeWei+iwgyBqb2Jfb3V0cHV044CCJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0g5LiL5Y2K5Z2X77ya5a2QIGFnZW50XG4gICAgYm9keS5hcHBlbmRDaGlsZCh1c2FnZUJsb2NrKCflrZAgYWdlbnQnLCBhY3Rpdml0eUF2YWlsYWJsZUxpbmVzKGFjdGl2aXR5LCAnc3ViYWdlbnRzJykpKTtcbiAgICBpZiAoYWN0aXZpdHkuc3ViYWdlbnRzQXZhaWxhYmxlKSB7XG4gICAgICAgIGlmIChhY3Rpdml0eS5zdWJhZ2VudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBib2R5LmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXVzYWdlLXNvdXJjZScsICfmsqHmnInlrZAgYWdlbnTjgIInKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBsaXN0ID0gZWwoJ2RpdicsICdkc2gtYWN0aXZpdHktbGlzdCcpO1xuICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2YgYWN0aXZpdHkuc3ViYWdlbnRzKSBsaXN0LmFwcGVuZENoaWxkKHN1YmFnZW50SXRlbShzdGF0ZSwgcm93KSk7XG4gICAgICAgICAgICBib2R5LmFwcGVuZENoaWxkKGxpc3QpO1xuICAgICAgICAgICAgYm9keS5hcHBlbmRDaGlsZChcbiAgICAgICAgICAgICAgICBlbChcbiAgICAgICAgICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICAgICAgICAgICdkc2gtdXNhZ2Utc291cmNlJyxcbiAgICAgICAgICAgICAgICAgICAgJ+OAjOS4gOasoeaAp+OAjeeahOWtkCBhZ2VudCDnu5PmnoTkuIrkuI3og73lho3lj5Hmtojmga/vvIjlj6rmnInjgIzlj6/nu6fnu63jgI3nmoTog73mjqXnnYDogYrvvInvvJvjgIzkuK3mlq3jgI3lj6rlgZzlroPlvZPliY3ov5nkuIDova7vvIzkvJror53kuI7kuIrkuIvmlofpg73nlZnnnYDjgIInLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGFjdGl2aXR5Lm5vdGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3Qgbm90ZXMgPSBlbCgnZGl2JywgJ2RzaC11c2FnZS1ub3RlcycpO1xuICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgYWN0aXZpdHkubm90ZXMpIG5vdGVzLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXVzYWdlLW5vdGVzLWl0ZW0nLCB0ZXh0KSk7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQobm90ZXMpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDkuIDlnZfnmoTjgIzkuI3lj6/nlKjjgI3pgqPlh6DooYzvvIjmnI3liqHmsqHmjILml7bor7TmuIXmmK/lk6rkuKrmnI3liqHvvIzogIzkuI3mmK/nlLvkuIDkuKrnqbrliJfooajvvInjgIJcbiAqXG4gKiBAcmV0dXJucyDlj6/nm7TmjqXloZ7ov5sgYHVzYWdlQmxvY2tgIOeahOWFg+e0oOaVsOe7hO+8iOWPr+eUqOaXtuaYr+epuuaVsOe7hO+8ieOAglxuICovXG5mdW5jdGlvbiBhY3Rpdml0eUF2YWlsYWJsZUxpbmVzKGFjdGl2aXR5OiBBY3Rpdml0eVZpZXcsIHdoaWNoOiAnam9icycgfCAnc3ViYWdlbnRzJyk6IEhUTUxFbGVtZW50W10ge1xuICAgIGNvbnN0IGF2YWlsYWJsZSA9IHdoaWNoID09PSAnam9icycgPyBhY3Rpdml0eS5qb2JzQXZhaWxhYmxlIDogYWN0aXZpdHkuc3ViYWdlbnRzQXZhaWxhYmxlO1xuICAgIGlmIChhdmFpbGFibGUpIHJldHVybiBbXTtcbiAgICBjb25zdCByZWFzb24gPSB3aGljaCA9PT0gJ2pvYnMnID8gYWN0aXZpdHkuam9ic1JlYXNvbiA6IGFjdGl2aXR5LnN1YmFnZW50c1JlYXNvbjtcbiAgICByZXR1cm4gW2VsKCdkaXYnLCAnZHNoLXVzYWdlLXNvdXJjZScsIHJlYXNvbiA/PyBg6L+Z5LiqIHByb2ZpbGUg5rKh5oyCICR7d2hpY2h9IOacjeWKoe+8jOaJgOS7peeci+S4jeWIsOOAgmApXTtcbn1cblxuLyoqIOW8gC/lhbPmtLvliqjmir3lsYnvvIjmiZPlvIDml7bpobrmiYvpl67kuIDmrKEg4oCU4oCUIOWug+ayoeacieS7u+S9leWQjuWPsOaOqOmAge+8jOS4jemXruWwseawuOi/nOaYr+epuueahO+8ieOAgiAqL1xuZnVuY3Rpb24gdG9nZ2xlQWN0aXZpdHkoc3RhdGU6IFVpU3RhdGUsIG9wZW4/OiBib29sZWFuKTogdm9pZCB7XG4gICAgY29uc3QgbmV4dCA9IG9wZW4gPz8gIXN0YXRlLmFjdGl2aXR5T3BlbjtcbiAgICBzdGF0ZS5hY3Rpdml0eU9wZW4gPSBuZXh0O1xuICAgIGlmIChzdGF0ZS5hY3Rpdml0eUhvc3QpIHN0YXRlLmFjdGl2aXR5SG9zdC5oaWRkZW4gPSAhbmV4dDtcbiAgICBpZiAobmV4dCkge1xuICAgICAgICByZW5kZXJBY3Rpdml0eShzdGF0ZSk7XG4gICAgICAgIHZvaWQgcmVhZEFjdGl2aXR5KHN0YXRlKTtcbiAgICB9XG59XG5cbi8qKlxuICog546w5Zyo6K+l5LiN6K+l6Zeu5LiA5qyh5rS75Yqo44CCXG4gKlxuICog5LiJ5Liq5p2h5Lu25Lu75oSP5LiA5Liq5oiQ56uL5bCx6Zeu77yM5ZCm5YiZKirkuIDmrKHpg73kuI3pl64qKu+8iOepuumXsuaXtuecgSBJUEPvvInvvJpcbiAqIOKRoCDmir3lsYnlvIDnnYDvvIjnlKjmiLfmraPlnKjnnIvvvIzlv4XpobvmlrDvvInvvJvikaEg6L+Z5LiA6L2u5Zyo6LeR77yI6ZqP5pe25Y+v6IO95pyJ5paw5Lu75Yqh77yJ77ybXG4gKiDikaIg6Iqv54mH6L+Y5Lqu552A77yI5pyJ5Lic6KW/5rKh57uT5p2fIOKAlOKAlCDot5HlrozkuYvlkI7kuZ/lvpfnu6fnu63pl67vvIzlkKbliJnoiq/niYfkvJrkuIDnm7Tkuq7nnYDkuIDkuKrml6nlsLHnu5PmnZ/nmoTku7vliqHvvInjgIJcbiAqL1xuZnVuY3Rpb24gc2hvdWxkUG9sbEFjdGl2aXR5KHN0YXRlOiBVaVN0YXRlKTogYm9vbGVhbiB7XG4gICAgaWYgKHN0YXRlLmFjdGl2aXR5QnVzeSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChEYXRlLm5vdygpIC0gc3RhdGUuYWN0aXZpdHlBdCA8IEFDVElWSVRZX1BPTExfTVMpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoc3RhdGUuYWN0aXZpdHlPcGVuKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBzdGF0ZS5hY3Rpdml0eUNoaXAgIT09IG51bGwgJiYgc3RhdGUuYWN0aXZpdHlDaGlwLmhpZGRlbiA9PT0gZmFsc2U7XG59XG5cbi8qKiDlvZPliY3jgIzmraPlnKjlubLku4DkuYjjgI3vvIjnirbmgIHooYzlt6bljYrovrnvvInjgIIgKi9cbmZ1bmN0aW9uIGxpdmVUZXh0KHN0YXRlOiBVaVN0YXRlKTogeyB0ZXh0OiBzdHJpbmc7IHRvbmU6ICdidXN5JyB8ICdlcnJvcicgfCAnaWRsZScgfSB7XG4gICAgY29uc3Qgc25hcHNob3QgPSBzdGF0ZS5zbmFwc2hvdDtcbiAgICBpZiAoIXNuYXBzaG90KSByZXR1cm4geyB0ZXh0OiAn6K+75Y+W54q25oCB4oCmJywgdG9uZTogJ2lkbGUnIH07XG4gICAgaWYgKHNuYXBzaG90LnN0YXR1cyA9PT0gJ2Vycm9yJykgcmV0dXJuIHsgdGV4dDogc25hcHNob3QubGFzdEVycm9yID8/ICflh7rplJknLCB0b25lOiAnZXJyb3InIH07XG4gICAgaWYgKHNuYXBzaG90LnJ1bm5pbmcpIHtcbiAgICAgICAgLy8g5pyA5ZCO5LiA5Liq6L+Y5rKh57uT5p6c55qE5bel5YW3ID0g5b2T5YmN5Zyo6LeR55qE6YKj5LiqXG4gICAgICAgIGxldCBydW5uaW5nVG9vbCA9ICcnO1xuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHN0YXRlLmVudHJpZXMudmFsdWVzKCkpIHtcbiAgICAgICAgICAgIGlmIChlbnRyeS5raW5kID09PSAndG9vbCcgJiYgZW50cnkudG9vbCAmJiAhZW50cnkudG9vbC5kb25lKSBydW5uaW5nVG9vbCA9IGVudHJ5LnRvb2wubmFtZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyB0ZXh0OiBydW5uaW5nVG9vbCA/IGDov5DooYzkuK3vvJoke3J1bm5pbmdUb29sfWAgOiAn5oCd6ICD5Lit4oCmJywgdG9uZTogJ2J1c3knIH07XG4gICAgfVxuICAgIHJldHVybiB7IHRleHQ6IFNUQVRVU19URVhUW3NuYXBzaG90LnN0YXR1c10gPz8gc25hcHNob3Quc3RhdHVzLCB0b25lOiAnaWRsZScgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDkuqTkupLvvIjkurrmnLrkuYvpl7TpgqPkuIDpl67vvIlcblxuLyoqXG4gKiDkuqTkupLlnZfnmoTjgIznrb7lkI3jgI3vvJrkuqTkupLpm4blkIggKyDlt7Lmj5DkuqTpm4blkIjjgIJcbiAqXG4gKiDkuLrku4DkuYjopoHnrb7lkI3ogIzkuI3mmK/mr4/mrKHpg73ph43nlLvvvJpgcmVmcmVzaFN0YXRlYCDmr48gODAwbXPvvIjot5Hliqjml7YgMzAwbXPvvInot5HkuIDmrKHvvIzogIzov5nlnZdcbiAqIOmHjOmdouaciSoq55So5oi35q2j5Zyo5pWy55qE6Ieq5a6a5LmJ5Zue562UKirkuI7liJrngrnlh7rmnaXnmoTpgInkuK3mgIEg4oCU4oCUIOmHjeW7uiBET00g5Lya5oqK5a6D5Lus5oq55o6J44CCXG4gKiDlj6rmnInjgIzpl67kuobku4DkuYjjgI3miJbjgIzmj5DkuqTov4fmsqHmnInjgI3lj5jkuobmiY3ph43nlLvjgIJcbiAqXG4gKiBAcGFyYW0gbGlzdCAtIOW9k+WJjeWcqOetieeahOS6pOS6kuOAglxuICogQHBhcmFtIHNlbnQgLSDlt7Lmj5DkuqTlm57nrZTnmoQgaWTjgIJcbiAqIEByZXR1cm5zIOWPr+avlOi+g+eahOWtl+espuS4suOAglxuICovXG5mdW5jdGlvbiBpbnRlcmFjdGlvblNpZ25hdHVyZShsaXN0OiBJbnRlcmFjdGlvblZpZXdbXSwgc2VudDogU2V0PHN0cmluZz4pOiBzdHJpbmcge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbXG4gICAgICAgIFsuLi5zZW50XS5zb3J0KCksXG4gICAgICAgIGxpc3QubWFwKCh2aWV3KSA9PiBbdmlldy5pZCwgdmlldy5raW5kLCAodmlldy5xdWVzdGlvbnMgPz8gW10pLm1hcCgocXVlc3Rpb24pID0+IHF1ZXN0aW9uLmlkKS5qb2luKCcsJyldKSxcbiAgICBdKTtcbn1cblxuLyoqIOWNoeeJh+mHjOafkOmBk+mimOeahOOAjOWFtuS7luOAjei+k+WFpeahhuW9k+WJjeWAvO+8iOayoeWGmeWwseaYr+epuuS4su+8ieOAgiAqL1xuZnVuY3Rpb24gY3VzdG9tVmFsdWVPZihjYXJkOiBIVE1MRWxlbWVudCwgcXVlc3Rpb25JZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGlucHV0IG9mIGNhcmQucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignLmRzaC1pbnRlcmFjdGlvbi1pbnB1dCcpKSB7XG4gICAgICAgIGlmIChpbnB1dC5kYXRhc2V0LnF1ZXN0aW9uID09PSBxdWVzdGlvbklkKSByZXR1cm4gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIH1cbiAgICByZXR1cm4gJyc7XG59XG5cbi8qKlxuICog5oqK5Y2h54mH5LiK55qE6YCJ5Lit5oCB5LiO6Ieq5a6a5LmJ6L6T5YWl5pS25oiQ562U5qGI77yIKirku44gRE9NIOivuyoq77yM5LiN5Y+m5a2Y5LiA5Lu954q25oCB77yJ44CCXG4gKlxuICog5LuOIERPTSDor7vnmoTnkIbnlLHvvJpET00g5bCx5piv55So5oi355yL5Yiw55qE6YKj5Liq55yf55u477yM5Y+m5a2Y5LiA5Lu95b+F54S25Ye6546w44CM5pi+56S65LiO5a6e6ZmF5LiN5LiA6Ie044CNXG4gKiDvvIjmuLLmn5Pooqvot7Pov4cgLyDph43nlLvml7bmnLrkuI3lkIzmraXvvInjgILku6Pku7fmmK/lv4XpobvlnKjph43lu7rliY3or7sg4oCU4oCUIOaJgOS7peaPkOS6pOS4jumHjeW7uuaYr+WIhuW8gOeahOS4pOatpeOAglxuICpcbiAqIEBwYXJhbSBjYXJkIC0g5Y2h54mH5YWD57Sg44CCXG4gKiBAcGFyYW0gdmlldyAtIOWug+WvueW6lOeahOS6pOS6kuOAglxuICogQHJldHVybnMg5ZCI5rOV562U5qGI77yI56m65pWw57uEID0g55So5oi35LuA5LmI6YO95rKh6YCJ5Lmf5rKh5YaZ77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGNvbGxlY3RBbnN3ZXJzKGNhcmQ6IEhUTUxFbGVtZW50LCB2aWV3OiBJbnRlcmFjdGlvblZpZXcpOiBJbnRlcmFjdGlvbkFuc3dlckl0ZW1bXSB7XG4gICAgY29uc3Qgb3V0OiBJbnRlcmFjdGlvbkFuc3dlckl0ZW1bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgcXVlc3Rpb24gb2Ygdmlldy5xdWVzdGlvbnMgPz8gW10pIHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgYnV0dG9uIG9mIGNhcmQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJy5kc2gtaW50ZXJhY3Rpb24tb3B0aW9uJykpIHtcbiAgICAgICAgICAgIGlmIChidXR0b24uZGF0YXNldC5xdWVzdGlvbiA9PT0gcXVlc3Rpb24uaWQgJiYgYnV0dG9uLmRhdGFzZXQub24gPT09ICcxJykgc2VsZWN0ZWQucHVzaChidXR0b24udGV4dENvbnRlbnQgPz8gJycpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGN1c3RvbSA9IGN1c3RvbVZhbHVlT2YoY2FyZCwgcXVlc3Rpb24uaWQpO1xuICAgICAgICBpZiAoc2VsZWN0ZWQubGVuZ3RoID09PSAwICYmICFjdXN0b20pIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaCh7IGlkOiBxdWVzdGlvbi5pZCwgc2VsZWN0ZWQsIC4uLihjdXN0b20gPyB7IGN1c3RvbSB9IDoge30pIH0pO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIOaKiuWGs+WumuS6pOe7meS4u+i/m+eoi++8iOWGjeeUseWug+i9rOe7meaPkuS7tu+8ieOAglxuICpcbiAqIOS4ieadoeWPo+W+hO+8mlxuICogMS4gKirlhYjorrAgYGludGVyYWN0aW9uU2VudGAg5YaN5Y+RKiog4oCU4oCUIOaPkOS6pOWIsOWNoeeJh+a2iOWkseS5i+mXtOacieS4gOWwj+aute+8iOS4u+i/m+eoiyDihpIg5o+S5Lu2IOKGkiDlm57miadcbiAqICAgIOKGkiDlub/mkq3vvInvvIzkuI3npoHnlKjmjInpkq7nmoTor53ov57ngrnkuKTkuIvkvJrlj5HkuKTmrKHvvIjnrKzkuozmrKHooqvmj5Lku7blvZPnq57mgIHmi5LmjonvvIznlKjmiLfnnIvliLDnmoTmmK9cbiAqICAgIOOAjOeCueS6huayoeWPjeW6lOOAje+8ie+8m1xuICogMi4gKirlpLHotKXopoHmiororrDlj7fpgIDmjokqKiDigJTigJQg5ZCm5YiZ5Y2h54mH5rC46L+c5Y2h5Zyo44CM5bey5o+Q5Lqk4oCm44CN5LiK77yM6ICM5YW25a6e5LuA5LmI6YO95rKh5Y+R55Sf77ybXG4gKiAzLiAqKuS4jeeMnOe7k+aenCoq77ya5Y2h54mH55Sx5Li76L+b56iL5bm/5pKt55qE5paw54q25oCB5pS25o6J77yM6Z2i5p2/5LiN6Ieq5bex5Yig77yI5ZCm5YiZ5o+S5Lu255qEIHNldHRsZWQg5LiOXG4gKiAgICDpnaLmnb/nmoTkuZDop4LliKDpmaTkvJrmiZPmnrbvvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSB2aWV3IC0g6KaB5Zue562U55qE5Lqk5LqS44CCXG4gKiBAcGFyYW0gZGVjaXNpb24gLSDlhrPlrprvvIhhbnN3ZXIgLyBkaXNtaXNzIC8gZGVsZWdhdGXvvInjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gYW5zd2VySW50ZXJhY3Rpb24oc3RhdGU6IFVpU3RhdGUsIHZpZXc6IEludGVyYWN0aW9uVmlldywgZGVjaXNpb246IEludGVyYWN0aW9uRGVjaXNpb24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoc3RhdGUuaW50ZXJhY3Rpb25TZW50Lmhhcyh2aWV3LmlkKSkgcmV0dXJuO1xuICAgIHN0YXRlLmludGVyYWN0aW9uU2VudC5hZGQodmlldy5pZCk7XG4gICAgcmVuZGVySW50ZXJhY3Rpb25zKHN0YXRlKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLmludGVyYWN0aW9uQW5zd2VyLCBkZWNpc2lvbik7XG4gICAgICAgIGlmICghcmVwbHk/Lm9rKSB7XG4gICAgICAgICAgICBzdGF0ZS5pbnRlcmFjdGlvblNlbnQuZGVsZXRlKHZpZXcuaWQpO1xuICAgICAgICAgICAgcmVuZGVySW50ZXJhY3Rpb25zKHN0YXRlKTtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgcmVwbHk/LmVycm9yID8/ICflm57nrZTmsqHmnInpgIHlh7rljrsnLCAnZXJyb3InLCBbXSwgQkFOTkVSX0hPTEQuRVJST1IpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc3RhdGUuaW50ZXJhY3Rpb25TZW50LmRlbGV0ZSh2aWV3LmlkKTtcbiAgICAgICAgcmVuZGVySW50ZXJhY3Rpb25zKHN0YXRlKTtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5Zue562U5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCwgJ2Vycm9yJywgW10sIEJBTk5FUl9IT0xELkVSUk9SKTtcbiAgICB9XG59XG5cbi8qKlxuICog55S75LiA5byg5Lqk5LqS5Y2h54mH44CCXG4gKlxuICog5LiJ56eN5qC35a2Q77yM5LiA5Lu95pWw5o2u77yaXG4gKiAtIGBhcHByb3ZhbGDvvIjmjojmnYPor7fmsYLvvInvvJrlt6XlhbflkI0gKyDnkIbnlLEgKyDjgIzlhYHorrjkuIDmrKEgLyDmi5Lnu53jgI3vvJtcbiAqIC0gYHBsYW4tcmV2aWV3YO+8iOiuoeWIkuivhOWuoe+8ie+8muWug+WwseaYr+W4piBgaW50ZW50YCDnmoTkuIDpgZPpopjvvIxgZGV0YWlsYCDmmK/pgqPku73orqHliJIgbWFya2Rvd27vvJtcbiAqIC0g5pmu6YCa5o+Q6Zeu77ya6Zeu6aKYICsg6YCJ6aG577yI5Y+v5aSa6YCJ77yJKyDoh6rlrprkuYnovpPlhaXjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSB2aWV3IC0g5Lqk5LqS44CCXG4gKiBAcmV0dXJucyDljaHniYflhYPntKDjgIJcbiAqL1xuZnVuY3Rpb24gYnVpbGRJbnRlcmFjdGlvbkNhcmQoc3RhdGU6IFVpU3RhdGUsIHZpZXc6IEludGVyYWN0aW9uVmlldyk6IEhUTUxFbGVtZW50IHtcbiAgICBjb25zdCBzZW50ID0gc3RhdGUuaW50ZXJhY3Rpb25TZW50Lmhhcyh2aWV3LmlkKTtcbiAgICBjb25zdCBxdWVzdGlvbnMgPSB2aWV3LnF1ZXN0aW9ucyA/PyBbXTtcbiAgICBjb25zdCBwbGFuUmV2aWV3ID0gdmlldy5raW5kID09PSAncXVlc3Rpb24nICYmIHF1ZXN0aW9uc1swXT8uaW50ZW50Py5raW5kID09PSAncGxhbi1yZXZpZXcnO1xuXG4gICAgY29uc3QgY2FyZCA9IGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLWNhcmQnKTtcbiAgICBjYXJkLmRhdGFzZXQua2luZCA9IHZpZXcua2luZCA9PT0gJ2FwcHJvdmFsJyA/ICdhcHByb3ZhbCcgOiBwbGFuUmV2aWV3ID8gJ3BsYW4nIDogJ3F1ZXN0aW9uJztcblxuICAgIGNvbnN0IGhlYWQgPSBlbCgnZGl2JywgJ2RzaC1pbnRlcmFjdGlvbi1oZWFkJyk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChlbCgnc3BhbicsICdkc2gtaW50ZXJhY3Rpb24tYmFkZ2UnLCB2aWV3LmtpbmQgPT09ICdhcHByb3ZhbCcgPyAn6ZyA6KaB5L2g5om55YeGJyA6IHBsYW5SZXZpZXcgPyAn6K6h5YiS6K+E5a6hJyA6ICfmqKHlnovlnKjnrYnkvaDlm57nrZQnKSk7XG4gICAgY29uc3Qgc291cmNlID0gdmlldy50b29sTmFtZSA/PyAodmlldy5hZ2VudElkID8gYGFnZW50ICR7dmlldy5hZ2VudElkLmxlbmd0aCA+IDE2ID8gdmlldy5hZ2VudElkLnNsaWNlKDAsIDgpIDogdmlldy5hZ2VudElkfWAgOiAnJyk7XG4gICAgaWYgKHNvdXJjZSkge1xuICAgICAgICBjb25zdCB0YWcgPSBlbCgnc3BhbicsICdkc2gtaW50ZXJhY3Rpb24tc291cmNlJywgc291cmNlKTtcbiAgICAgICAgdGFnLnRpdGxlID0gYCR7dmlldy5hZ2VudElkID8gYGFnZW50ICR7dmlldy5hZ2VudElkfWAgOiAnJ30ke3ZpZXcuc2Vzc2lvbklkID8gYFxcbuS8muivnSAke3ZpZXcuc2Vzc2lvbklkfWAgOiAnJ31gO1xuICAgICAgICBoZWFkLmFwcGVuZENoaWxkKHRhZyk7XG4gICAgfVxuICAgIGNvbnN0IGNsb3NlID0gZWwoJ2J1dHRvbicsICdkc2gtaWNvbi1idG4nLCAn4pyVJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgY2xvc2UudGl0bGUgPSB2aWV3LmtpbmQgPT09ICdhcHByb3ZhbCcgPyAn5YWz5o6J6L+Z5qyh5o6I5p2D6K+35rGC77yI5oyJ44CM5Y+W5raI44CN5aSE55CG77yJJyA6ICflhbPmjonkuI3lm57nrZTvvIjmqKHlnovkvJrlvZPkvZzjgIzkvaDopoHmj5Lor53jgI3vvIzmnKzova7nu5PmnZ/vvIknO1xuICAgIGNsb3NlLmRpc2FibGVkID0gc2VudDtcbiAgICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgYW5zd2VySW50ZXJhY3Rpb24oc3RhdGUsIHZpZXcsIHsgaWQ6IHZpZXcuaWQsIGFjdGlvbjogJ2Rpc21pc3MnIH0pKTtcbiAgICBoZWFkLmFwcGVuZENoaWxkKGNsb3NlKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKGhlYWQpO1xuXG4gICAgLyoqIOWNlemAiSArIOWPquacieS4gOmBk+mimCA9IOeCueS4gOS4i+WwseaYr+etlOahiO+8iOacgOW4uOingeeahOW9ouaAge+8jOWwkeS4gOasoeeCueWHu++8ieOAgiAqL1xuICAgIGNvbnN0IHNpbmdsZSA9IHF1ZXN0aW9ucy5sZW5ndGggPT09IDEgJiYgcXVlc3Rpb25zWzBdLm11bHRpU2VsZWN0ICE9PSB0cnVlO1xuICAgIC8qKiDljZXpgInpgqPpgZPpopjnmoTjgIzlhbbku5bjgI3ovpPlhaXmoYbvvIjlroPnmoTlhoXlrrnlhrPlrpropoHkuI3opoHpnLLlh7rjgIzmj5DkuqTlm57nrZTjgI3vvInjgIIgKi9cbiAgICBsZXQgc2luZ2xlSW5wdXQ6IEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuICAgIGNvbnN0IGJvZHkgPSBlbCgnZGl2JywgJ2RzaC1pbnRlcmFjdGlvbi1ib2R5Jyk7XG4gICAgaWYgKHZpZXcua2luZCA9PT0gJ2FwcHJvdmFsJykge1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLXF1ZXN0aW9uJywgYOimgeaJp+ihjO+8miR7dmlldy50b29sTmFtZSA/PyAnKOacquefpeW3peWFtyknfWApKTtcbiAgICAgICAgaWYgKHZpZXcucmVhc29uKSBib2R5LmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLXJlYXNvbicsIHZpZXcucmVhc29uKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgZm9yIChjb25zdCBxdWVzdGlvbiBvZiBxdWVzdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gZWwoJ2RpdicsICdkc2gtaW50ZXJhY3Rpb24tcXVlc3Rpb24tYmxvY2snKTtcbiAgICAgICAgICAgIGlmIChxdWVzdGlvbi5oZWFkZXIpIGJsb2NrLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLWhlYWRlcicsIHF1ZXN0aW9uLmhlYWRlcikpO1xuICAgICAgICAgICAgYmxvY2suYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtaW50ZXJhY3Rpb24tcXVlc3Rpb24nLCBxdWVzdGlvbi5xdWVzdGlvbikpO1xuICAgICAgICAgICAgaWYgKHF1ZXN0aW9uLmRldGFpbCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRldGFpbCA9IGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLWRldGFpbCcpO1xuICAgICAgICAgICAgICAgIHJlbmRlck1hcmtkb3duKGRldGFpbCwgcXVlc3Rpb24uZGV0YWlsKTtcbiAgICAgICAgICAgICAgICBibG9jay5hcHBlbmRDaGlsZChkZXRhaWwpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGVsKCdkaXYnLCAnZHNoLWludGVyYWN0aW9uLW9wdGlvbnMnKTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qgb3B0aW9uIG9mIHF1ZXN0aW9uLm9wdGlvbnMgPz8gW10pIHtcbiAgICAgICAgICAgICAgICBjb25zdCBidXR0b24gPSBlbCgnYnV0dG9uJywgJ2RzaC1pbnRlcmFjdGlvbi1vcHRpb24nLCBvcHRpb24ubGFiZWwpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgICAgICAgICAgICAgIGJ1dHRvbi5kYXRhc2V0LnF1ZXN0aW9uID0gcXVlc3Rpb24uaWQ7XG4gICAgICAgICAgICAgICAgYnV0dG9uLmRhdGFzZXQub24gPSAnMCc7XG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbi5kZXNjcmlwdGlvbikgYnV0dG9uLnRpdGxlID0gb3B0aW9uLmRlc2NyaXB0aW9uO1xuICAgICAgICAgICAgICAgIC8vIOOAjOaJueWHhuOAjemCo+S4gOmhueagh+e7v++8mmludGVudCDnlKgqKuWQjeWtlyoq5oyH5a6a77yM6Z2i5p2/5LiN6K645oyJ6aG65bqP54yc77yI5ZCMIERTSCDlj6PlvoTvvIlcbiAgICAgICAgICAgICAgICBpZiAocXVlc3Rpb24uaW50ZW50Py5hcHByb3ZlID09PSBvcHRpb24ubGFiZWwpIGJ1dHRvbi5kYXRhc2V0LnJvbGUgPSAnYXBwcm92ZSc7XG4gICAgICAgICAgICAgICAgYnV0dG9uLmRpc2FibGVkID0gc2VudDtcbiAgICAgICAgICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzaW5nbGUgJiYgIWN1c3RvbVZhbHVlT2YoY2FyZCwgcXVlc3Rpb24uaWQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2b2lkIGFuc3dlckludGVyYWN0aW9uKHN0YXRlLCB2aWV3LCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHZpZXcuaWQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWN0aW9uOiAnYW5zd2VyJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbnN3ZXJzOiBbeyBpZDogcXVlc3Rpb24uaWQsIHNlbGVjdGVkOiBbb3B0aW9uLmxhYmVsXSB9XSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJ1dHRvbi5kYXRhc2V0Lm9uID0gYnV0dG9uLmRhdGFzZXQub24gPT09ICcxJyA/ICcwJyA6ICcxJztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBvcHRpb25zLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoKHF1ZXN0aW9uLm9wdGlvbnMgPz8gW10pLmxlbmd0aCA+IDApIGJsb2NrLmFwcGVuZENoaWxkKG9wdGlvbnMpO1xuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbCgnaW5wdXQnLCAnZHNoLWludGVyYWN0aW9uLWlucHV0JykgYXMgSFRNTElucHV0RWxlbWVudDtcbiAgICAgICAgICAgIGlucHV0LnR5cGUgPSAndGV4dCc7XG4gICAgICAgICAgICBpbnB1dC5zcGVsbGNoZWNrID0gZmFsc2U7XG4gICAgICAgICAgICBpbnB1dC5kaXNhYmxlZCA9IHNlbnQ7XG4gICAgICAgICAgICBpbnB1dC5kYXRhc2V0LnF1ZXN0aW9uID0gcXVlc3Rpb24uaWQ7XG4gICAgICAgICAgICBpbnB1dC5wbGFjZWhvbGRlciA9IChxdWVzdGlvbi5vcHRpb25zID8/IFtdKS5sZW5ndGggPiAwID8gJ+WFtuS7lu+8iOWPr+eVmeepuiDigJTigJQg5oOz6Ieq5bex5YaZ5LiA5Y+l5bCx5aGr6L+Z6YeM77yJJyA6ICflhpnkuIvkvaDnmoTlm57nrZQnO1xuICAgICAgICAgICAgYmxvY2suYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICAgICAgICAgICAgaWYgKHNpbmdsZSkgc2luZ2xlSW5wdXQgPSBpbnB1dDtcbiAgICAgICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoYmxvY2spO1xuICAgICAgICB9XG4gICAgfVxuICAgIGNhcmQuYXBwZW5kQ2hpbGQoYm9keSk7XG5cbiAgICBjb25zdCBhY3Rpb25zID0gZWwoJ2RpdicsICdkc2gtaW50ZXJhY3Rpb24tYWN0aW9ucycpO1xuICAgIGlmICh2aWV3LmtpbmQgPT09ICdhcHByb3ZhbCcpIHtcbiAgICAgICAgY29uc3QgYWxsb3cgPSBlbCgnYnV0dG9uJywgJ2RzaC1idG4gZHNoLWludGVyYWN0aW9uLWFsbG93JywgJ+WFgeiuuOS4gOasoScpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgICAgICBhbGxvdy50aXRsZSA9ICflj6rmibnlh4bov5nkuIDmrKHvvIhEU0gg55qEIGFsbG93ZWQtb25jZe+8muaOiOadg+S4jei3qOiwg+eUqOS/neeVme+8iSc7XG4gICAgICAgIGFsbG93LmRpc2FibGVkID0gc2VudDtcbiAgICAgICAgYWxsb3cuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIGFuc3dlckludGVyYWN0aW9uKHN0YXRlLCB2aWV3LCB7IGlkOiB2aWV3LmlkLCBhY3Rpb246ICdhbnN3ZXInLCBvdXRjb21lOiAnYWxsb3dlZC1vbmNlJyB9KSk7XG4gICAgICAgIGNvbnN0IGRlbnkgPSBlbCgnYnV0dG9uJywgJ2RzaC1idG4nLCAn5ouS57udJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgICAgIGRlbnkuZGlzYWJsZWQgPSBzZW50O1xuICAgICAgICBkZW55LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBhbnN3ZXJJbnRlcmFjdGlvbihzdGF0ZSwgdmlldywgeyBpZDogdmlldy5pZCwgYWN0aW9uOiAnYW5zd2VyJywgb3V0Y29tZTogJ3JlamVjdGVkJyB9KSk7XG4gICAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYWxsb3cpO1xuICAgICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGRlbnkpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHN1Ym1pdCA9IGVsKCdidXR0b24nLCAnZHNoLWJ0biBkc2gtaW50ZXJhY3Rpb24tc3VibWl0Jywgc2VudCA/ICflt7Lmj5DkuqTigKYnIDogJ+aPkOS6pOWbnuetlCcpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgICAgICBzdWJtaXQuZGlzYWJsZWQgPSBzZW50O1xuICAgICAgICBzdWJtaXQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhbnN3ZXJzID0gY29sbGVjdEFuc3dlcnMoY2FyZCwgdmlldyk7XG4gICAgICAgICAgICBpZiAoYW5zd2Vycy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfpgInkuIDkuKrpgInpobnvvIzmiJbogIXlhpnkuIDlj6Xoh6rlrprkuYnlm57nrZTjgIInLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2b2lkIGFuc3dlckludGVyYWN0aW9uKHN0YXRlLCB2aWV3LCB7IGlkOiB2aWV3LmlkLCBhY3Rpb246ICdhbnN3ZXInLCBhbnN3ZXJzIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHNpbmdsZSkge1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAqIOWNlemAie+8mueCuemAiemhueacrOi6q+WwseaYr+etlOahiO+8jOaJgOS7pSoq6buY6K6k5LiN57uZ44CM5o+Q5Lqk5Zue562U44CN5oyJ6ZKuKirvvIjorqHliJLor4TlrqHkuIrlpJrkuIDkuKrmjInpkq5cbiAgICAgICAgICAgICAqIOWPquS8muiuqeS6uueKueixq+eCueWTquS4qu+8ieOAguS9huOAjOWFtuS7luOAjeahhuS4gOaXpuWGmeS6huWtl+WwseW+l+acieWcsOaWueaMiSDigJTigJQg5ZCm5YiZ55So5oi35pWy5a6MXG4gICAgICAgICAgICAgKiDml6DlpITmj5DkuqTvvIzogIzngrnpgInpobnlj4jkvJrmiorliJrlhpnnmoTlrZfkuKLmjonvvIjop4EgYGNvbGxlY3RBbnN3ZXJzYCDnmoTlj6PlvoTvvInjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgY29uc3Qgc3luYyA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB0eXBlZCA9IChzaW5nbGVJbnB1dD8udmFsdWUudHJpbSgpID8/ICcnKSAhPT0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVkICYmICFhY3Rpb25zLmNvbnRhaW5zKHN1Ym1pdCkpIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3VibWl0KTtcbiAgICAgICAgICAgICAgICBpZiAoIXR5cGVkICYmIGFjdGlvbnMuY29udGFpbnMoc3VibWl0KSkgc3VibWl0LnJlbW92ZSgpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHNpbmdsZUlucHV0Py5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHN5bmMpO1xuICAgICAgICAgICAgc3luYygpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdWJtaXQpO1xuICAgICAgICB9XG4gICAgfVxuICAgIGNhcmQuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gICAgcmV0dXJuIGNhcmQ7XG59XG5cbi8qKlxuICog55S75YWo6YOo5Lqk5LqS5Z2X77yIMCDmnaHml7bmlbTlnZfmlLbotbfvvIzkuI3ljaDkvY3vvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqL1xuZnVuY3Rpb24gcmVuZGVySW50ZXJhY3Rpb25zKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IHN0YXRlLmludGVyYWN0aW9uSG9zdDtcbiAgICBpZiAoIWhvc3QpIHJldHVybjtcbiAgICBjb25zdCBsaXN0ID0gc3RhdGUuaW50ZXJhY3Rpb25zID8/IFtdO1xuICAgIC8vIOW3sue7j+a2iOWkseeahOS6pOS6ku+8jOaKiuOAjOWImuaPkOS6pOi/h+OAjeeahOiusOWPt+S4gOi1t+a4heaOie+8iOWQpuWImeWQjOS4gOS4qiBpZCDlpI3nlKjml7bkvJror6/npoHnlKjvvIlcbiAgICBmb3IgKGNvbnN0IGlkIG9mIFsuLi5zdGF0ZS5pbnRlcmFjdGlvblNlbnRdKSB7XG4gICAgICAgIGlmICghbGlzdC5zb21lKCh2aWV3KSA9PiB2aWV3LmlkID09PSBpZCkpIHN0YXRlLmludGVyYWN0aW9uU2VudC5kZWxldGUoaWQpO1xuICAgIH1cbiAgICBjb25zdCBzaWcgPSBpbnRlcmFjdGlvblNpZ25hdHVyZShsaXN0LCBzdGF0ZS5pbnRlcmFjdGlvblNlbnQpO1xuICAgIGlmIChzaWcgPT09IHN0YXRlLmludGVyYWN0aW9uU2lnKSByZXR1cm47XG4gICAgc3RhdGUuaW50ZXJhY3Rpb25TaWcgPSBzaWc7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGhvc3QuaGlkZGVuID0gbGlzdC5sZW5ndGggPT09IDA7XG4gICAgZm9yIChjb25zdCB2aWV3IG9mIGxpc3QpIGhvc3QuYXBwZW5kQ2hpbGQoYnVpbGRJbnRlcmFjdGlvbkNhcmQoc3RhdGUsIHZpZXcpKTtcbn1cblxuLyoqIOaLieS4gOasoeeKtuaAge+8iOeKtuaAgeeCueOAgeWktOmhtuS4pOihjOOAgeeKtuaAgeihjOOAgeaoquW5heOAgeepuuaAgeOAgeWkluingu+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaFN0YXRlKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgbGV0IHJlcGx5OiBTdGF0ZVJlcGx5O1xuICAgIHRyeSB7XG4gICAgICAgIHJlcGx5ID0gYXdhaXQgY2FsbDxTdGF0ZVJlcGx5PihNU0cuZ2V0U3RhdGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm47IC8vIOS4u+i/m+eoi+W/mS/pnaLmnb/liJrmjILovb3vvJrkuIvkuIDova7lho3or7RcbiAgICB9XG4gICAgaWYgKCFyZXBseT8ub2sgfHwgIXJlcGx5LmFnZW50KSByZXR1cm47XG4gICAgc3RhdGUuc25hcHNob3QgPSByZXBseS5hZ2VudDtcbiAgICBzdGF0ZS5pbnRlcmFjdGlvbnMgPSBBcnJheS5pc0FycmF5KHJlcGx5LmFnZW50LmludGVyYWN0aW9ucykgPyByZXBseS5hZ2VudC5pbnRlcmFjdGlvbnMgOiBbXTtcbiAgICBpZiAocmVwbHkuc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gcmVwbHkuc2V0dGluZ3M7XG4gICAgYXBwbHlBcHBlYXJhbmNlKHN0YXRlKTtcblxuICAgIGlmIChzdGF0ZS5kb3QpIHtcbiAgICAgICAgc3RhdGUuZG90LmRhdGFzZXQuc3RhdGUgPSByZXBseS5hZ2VudC5zdGF0dXM7XG4gICAgICAgIHN0YXRlLmRvdC50aXRsZSA9IFNUQVRVU19URVhUW3JlcGx5LmFnZW50LnN0YXR1c10gPz8gcmVwbHkuYWdlbnQuc3RhdHVzO1xuICAgIH1cbiAgICBjb25zdCBzZXR0aW5ncyA9IHN0YXRlLnNldHRpbmdzO1xuICAgIGlmIChzdGF0ZS50aXRsZSkge1xuICAgICAgICAvKipcbiAgICAgICAgICog5qCH6aKY5qCP77ya5pyJ5Lya6K+d5qCH6aKY5bCx5pi+56S65a6D77yM5rKh5pyJ5omN5pi+56S65ZOB54mM5ZCN44CCXG4gICAgICAgICAqXG4gICAgICAgICAqIOagh+mimOadpeiHquS8muivneaXpeW/l+mHjOeahCBgc2Vzc2lvbi90aXRsZWAg5LqL5Lu277yIYGRzaC1zZXNzaW9uLXRpdGxlYCDov73liqDnmoTku4Xlhpnml6Xlv5fkuovku7bvvInjgIJcbiAgICAgICAgICog5a6DKirlhYjnspflkI7nu4YqKuWcsOi3s+S4gOasoeaYr+ato+W4uOeahO+8muehruWumuaAp+WbnumAgO+8iOmmluadoeeUqOaIt+a2iOaBr+eahOWJjeWHoOS4quivje+8ieWQjOatpeWwseacie+8jFxuICAgICAgICAgKiBgc2Vzc2lvbi10aXRsZS1sbG1g77yI5pysIHByb2ZpbGUg5bey6YeN5paw5ZCv55So77yJ6KaB5Y+m5Y+R5LiA5qyh5qih5Z6L6K+35rGC44CB5pma5LiA5Lik56eS5omN6KaG55uW5a6D44CCXG4gICAgICAgICAqIOWujOaVtOagh+mimOaUviBgdGl0bGVgIOWxnuaAp+mHjCDigJTigJQg56qE6Z2i5p2/5LiA6KGM5pS+5LiN5LiL77yM5L2G6byg5qCH5YGc5LiK5Y676KaB6IO955yL5YWo44CCXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCB0aXRsZSA9IHJlcGx5LmFnZW50LnRpdGxlO1xuICAgICAgICBzdGF0ZS50aXRsZS50ZXh0Q29udGVudCA9IHRpdGxlIHx8IGBEU0ggwrcgJHtQUk9GSUxFX05BTUV9YDtcbiAgICAgICAgc3RhdGUudGl0bGUudGl0bGUgPSB0aXRsZSA/IGDkvJror53moIfpopjvvJoke3RpdGxlfWAgOiBgRFNIIMK3ICR7UFJPRklMRV9OQU1Ffe+8iOi/meadoeS8muivnei/mOayoeacieagh+mimO+8iWA7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5zdWIpIHtcbiAgICAgICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmIChzZXR0aW5ncykgcGFydHMucHVzaChgJHtzZXR0aW5ncy5wcm92aWRlcn0vJHtzZXR0aW5ncy5tb2RlbH1gKTtcbiAgICAgICAgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiByZXBseS5hZ2VudC5sYXN0Qm9vdE1zKSB7XG4gICAgICAgICAgICBwYXJ0cy5wdXNoKGDlkK/liqggJHsocmVwbHkuYWdlbnQubGFzdEJvb3RNcyAvIDEwMDApLnRvRml4ZWQoMSl9c2ApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXBseS5hZ2VudC5waWQpIHBhcnRzLnB1c2goYHBpZCAke3JlcGx5LmFnZW50LnBpZH1gKTtcbiAgICAgICAgY29uc3QgdGV4dCA9IHBhcnRzLmpvaW4oJyDCtyAnKSB8fCBTVEFUVVNfVEVYVFtyZXBseS5hZ2VudC5zdGF0dXNdIHx8ICcnO1xuICAgICAgICBzdGF0ZS5zdWIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgICBzdGF0ZS5zdWIudGl0bGUgPSB0ZXh0O1xuICAgIH1cbiAgICBpZiAoc3RhdGUubGl2ZSkge1xuICAgICAgICBjb25zdCBsaXZlID0gbGl2ZVRleHQoc3RhdGUpO1xuICAgICAgICBzdGF0ZS5saXZlLnRleHRDb250ZW50ID0gbGl2ZS50ZXh0O1xuICAgICAgICBzdGF0ZS5saXZlLmRhdGFzZXQudG9uZSA9IGxpdmUudG9uZSA9PT0gJ2J1c3knID8gJ2J1c3knIDogbGl2ZS50b25lID09PSAnZXJyb3InID8gJ2Vycm9yJyA6ICcnO1xuICAgICAgICBzdGF0ZS5saXZlLnRpdGxlID0gbGl2ZS50ZXh0O1xuICAgIH1cbiAgICBpZiAoc3RhdGUubWV0YSkge1xuICAgICAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKHNldHRpbmdzKSBwYXJ0cy5wdXNoKGBlZmZvcnQgJHtzZXR0aW5ncy5yZWFzb25pbmdFZmZvcnQgfHwgJ+m7mOiupCd9YCk7XG4gICAgICAgIGlmIChyZXBseS5hZ2VudC5zZXNzaW9uSWQpIHBhcnRzLnB1c2goYOS8muivnSAke3JlcGx5LmFnZW50LnNlc3Npb25JZC5zbGljZSgwLCA4KX1gKTtcbiAgICAgICAgaWYgKHN0YXRlLmVudHJpZXMuc2l6ZSA+IDApIHBhcnRzLnB1c2goYCR7c3RhdGUuZW50cmllcy5zaXplfSDmnaFgKTtcbiAgICAgICAgY29uc3QgdGV4dCA9IHBhcnRzLmpvaW4oJyDCtyAnKTtcbiAgICAgICAgc3RhdGUubWV0YS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICAgIHN0YXRlLm1ldGEudGl0bGUgPSB0ZXh0O1xuICAgIH1cbiAgICAvLyDnirbmgIHooYzpgqPpopfjgIzkuIrkuIvmlocgeHgl44CN77ya5pWw5o2u5piv5Li76L+b56iL6ZqP5b+r54Wn5LiA6LW35Y+R5LiL5p2l55qE77yIYHVzYWdlYCAvIGB1c2FnZU5vdGVg77yJXG4gICAgcmVuZGVyVXNhZ2VDaGlwKHN0YXRlKTtcbiAgICAvLyDpgqPpopfjgIzlvoXlip4geC9544CN5ZCM55CG77yI5pWw5o2u5p2l6IeqIGBwcm9ncmVzc2AgLyBgcHJvZ3Jlc3NOb3RlYO+8iVxuICAgIHJlbmRlclByb2dyZXNzQ2hpcChzdGF0ZSk7XG4gICAgLy8g5oq95bGJ5byA552A5bCx5LiA55u06Lef552A5Yi35paw77yI5Zue5ZCI57uT5p2fL+i3keWujOWRveS7pOaXtuS4u+i/m+eoi+S8mumHjeivu+W5tuW5v+aSre+8m+a4heWNleaYr+WunuaXtuW5v+aSreeahO+8iVxuICAgIGlmIChzdGF0ZS51c2FnZU9wZW4pIHJlbmRlclVzYWdlKHN0YXRlKTtcbiAgICBpZiAoc3RhdGUucHJvZ3Jlc3NPcGVuKSByZW5kZXJQcm9ncmVzcyhzdGF0ZSk7XG5cbiAgICAvLyDmjInpkq7lj6/nlKjmgKfvvJrlj5HpgIHopoHlsLHnu6rvvIzmlrDkvJror53opoHlsLHnu6rvvIzjgIzlkK/liqgv5YGc5q2i44CN5oyJ54q25oCB5Y+Y5b2i77yM6YeN5ZCv5Y+q5Zyo6LeR552A5pe25omN5pyJ5oSP5LmJXG4gICAgY29uc3QgcmVhZHkgPSByZXBseS5hZ2VudC5zdGF0dXMgPT09ICdyZWFkeSc7XG4gICAgY29uc3Qgc2V0dGxlZCA9IHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3N0b3BwZWQnIHx8IHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ2Vycm9yJztcbiAgICBpZiAoc3RhdGUuc2VuZEJ1dHRvbikgc3RhdGUuc2VuZEJ1dHRvbi5kaXNhYmxlZCA9ICFyZWFkeTtcbiAgICBjb25zdCBidG5OZXcgPSBzdGF0ZS5yb290Py5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignI2J0bi1uZXcnKTtcbiAgICBpZiAoYnRuTmV3KSBidG5OZXcuZGlzYWJsZWQgPSAhcmVhZHk7XG5cbiAgICAvKipcbiAgICAgKiDkuIDkuKrmjInpkq7lubLkuKTku7bkuovvvJrmsqHot5Hml7bmmK/jgIzlkK/liqjjgI3vvIzot5HnnYDml7bmmK/jgIzlgZzmraLjgI3jgIJcbiAgICAgKlxuICAgICAqIOS5i+WJjeWPquacieOAjOWBnOatouOAjeS4gOS4queKtuaAgSDigJTigJQg55So5oi35oqKIGFnZW50IOWBnOaOieS5i+WQjioq5rKh5pyJ5Lu75L2V5Yqe5rOV5YaN6LW35p2lKipcbiAgICAgKiDvvIjllK/kuIDnmoTlhaXlj6PmmK/ph43lvIDpnaLmnb8gLyDph43lkK/nvJbovpHlmajvvIxgYXV0b1N0YXJ0YCDov5jlj6rlnKjjgIzku47msqHotbfov4fjgI3ml7bmiY3op6blj5HvvInvvIxcbiAgICAgKiDov5nlsLHmmK/jgIzlgZzmraLlkI7msqHmnInph43lkK/mjInpkq7jgI3ov5nkuKrlnZHnmoTmnaXmupDjgIJcbiAgICAgKi9cbiAgICBjb25zdCBidG5TdG9wID0gc3RhdGUucm9vdD8ucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJyNidG4tc3RvcCcpO1xuICAgIGlmIChidG5TdG9wKSB7XG4gICAgICAgIGJ0blN0b3AudGV4dENvbnRlbnQgPSBzZXR0bGVkID8gJ+WQr+WKqCcgOiAn5YGc5q2iJztcbiAgICAgICAgYnRuU3RvcC50aXRsZSA9IHNldHRsZWRcbiAgICAgICAgICAgID8gJ+WQr+WKqCBhZ2VudO+8iOS8muiHquWKqOaOpeS4iuS4iuasoeeahOS8muivne+8iSdcbiAgICAgICAgICAgIDogJ+WBnOaOieaVtOS4qiBhZ2VudCDov5vnqIvvvIjlj6rmg7PmiZPmlq3ov5nkuIDova7or7fnlKjovpPlhaXmoYbml4HnmoTjgIzlgZzmraLmnKzova7jgI3vvIknO1xuICAgICAgICBidG5TdG9wLmRpc2FibGVkID0gcmVwbHkuYWdlbnQuc3RhdHVzID09PSAnc3RhcnRpbmcnIHx8IHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3N0b3BwaW5nJyB8fCByZXBseS5hZ2VudC5zdGF0dXMgPT09ICdpbnN0YWxsaW5nJztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDjgIzlgZzmraLmnKzova7jgI3vvJoqKuWPquWcqOecn+eahOWcqOi3keeahOaXtuWAmeWHuueOsCoq44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjkuI3mmK/luLjpqbvnva7ngbDvvJrpnaLmnb/lrr3luqbmnIDlsI8gMzgwcHjvvIzovpPlhaXljLrlt7Lnu4/lvojmjKTvvJvogIzkuJTov5nkuKrmjInpkq5cbiAgICAgKiDjgIznjrDlnKjmsqHnlKjjgI3nmoTor63kuYnlvojlvLrvvIjmsqHlnKjot5HlsLHmmK/msqHlvpflgZzvvInjgILmt6HlhaXmt6Hlh7rkuqTnu5kgYGhpZGRlbmDvvIzkuI3ljaDkvY3jgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOS4jeaYr+OAjOWPkemAgeOAjeaMiemSruWPmOiEuO+8muWPkemAgeS4juS4reaWreaYr+S4pOS7tuS6i++8jGBmb2xsb3d1cGAg5YWB6K645Zyo6LeR55qE5pe25YCZXG4gICAgICog5YaN5o6S5LiA5Y+l77yI5Lya5Zyo6L+Z5LiA6L2u5LmL5ZCO5omn6KGM77yJ44CC5oqK5Y+R6YCB5oyJ6ZKu5pS55oiQ5Lit5pat5LyaKirpobrmiYvmi7/otbDmjpLpmJ/nmoTog73lipsqKuOAglxuICAgICAqL1xuICAgIGNvbnN0IGJ0bkludGVycnVwdCA9IHN0YXRlLnJvb3Q/LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYnRuLWludGVycnVwdCcpO1xuICAgIGlmIChidG5JbnRlcnJ1cHQpIHtcbiAgICAgICAgYnRuSW50ZXJydXB0LnRpdGxlID1cbiAgICAgICAgICAgICfkuK3mlq3lvZPliY3ov5nkuIDova7vvIhEU0gg55qEIEFnZW50LmNhbmNlbO+8muWBnOaOiei/meS4gOi9ru+8jOS8muivneS4juS4iuS4i+aWh+mDveS/neeVme+8jOWPr+S7peaOpeedgOivtO+8iVxcbicgK1xuICAgICAgICAgICAgJ+aDs+i/niBhZ2VudCDov5vnqIvkuIDotbflgZzvvIznlKjlj7PkuIrop5LnmoTjgIzlgZzmraLjgI3jgIInO1xuICAgIH1cbiAgICBzeW5jSW50ZXJydXB0QnV0dG9uKHN0YXRlKTtcbiAgICBjb25zdCBidG5SZXN0YXJ0ID0gc3RhdGUucm9vdD8ucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJyNidG4tcmVzdGFydCcpO1xuICAgIGlmIChidG5SZXN0YXJ0KSB7XG4gICAgICAgIGJ0blJlc3RhcnQuZGlzYWJsZWQgPSAhcmVhZHk7XG4gICAgICAgIGJ0blJlc3RhcnQudGl0bGUgPSByZWFkeSA/ICfph43lkK8gYWdlbnTvvIjph43lkK/lkI7kvJroh6rliqjmjqXkuIrkuIrmrKHnmoTkvJror53vvIknIDogJ+WFiOWQr+WKqCBhZ2VudCDmiY3og73ph43lkK8nO1xuICAgIH1cbiAgICBpZiAoc3RhdGUucmVzdW1lQnV0dG9uKSBzdGF0ZS5yZXN1bWVCdXR0b24uZGlzYWJsZWQgPSAhcmVhZHk7XG5cbiAgICByZW5kZXJIaXN0b3J5QmFyKHN0YXRlKTtcbiAgICAvLyDkuqTkupLlnZfvvJrlub/mkq3mmK/kuLvot6/vvIzov5nph4zlhZzkuIDmrKHvvIjpnaLmnb/liJrmiZPlvIDml7bpnaDlroPmiorjgIzlt7Lnu4/lnKjnrYnnmoTpgqPkuIDpl67jgI3nlLvlh7rmnaXvvIlcbiAgICByZW5kZXJJbnRlcmFjdGlvbnMoc3RhdGUpO1xuXG4gICAgaWYgKHJlcGx5LnByb2ZpbGUgJiYgcmVwbHkucHJvZmlsZS5vayA9PT0gZmFsc2UpIHtcbiAgICAgICAgLy8gcHJvZmlsZSDlkIzmraXlpLHotKXkvJrnm7TmjqXlr7zoh7QgYWdlbnQg6LW35LiN5p2l77yI5oiW6LW35p2l55qE5piv5pen5o+S5Lu277yJ77yM5b+F6aG75pi+55y844CCXG4gICAgICAgIHNldEJhbm5lcihcbiAgICAgICAgICAgIHN0YXRlLFxuICAgICAgICAgICAgYGRzaCBwcm9maWxlIOWQjOatpeWksei0pe+8miR7cmVwbHkucHJvZmlsZS5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31cXG7vvIhhZ2VudCDkvJrnlKjliLAgJERTSF9IT01FL3Byb2ZpbGVzL2NvY29z77yb5Y+v54K55LiL6Z2i5oyJ6ZKu6YeN6K+V77yJYCxcbiAgICAgICAgICAgICdlcnJvcicsXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogJ+S/ruWkjSBwcm9maWxlJywgcnVuOiAoKSA9PiB2b2lkIHJlcGFpclByb2ZpbGUoc3RhdGUpIH0sXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogJ+mHjeivleWQr+WKqCcsIHJ1bjogKCkgPT4gdm9pZCBzdGFydEFnZW50KHN0YXRlKSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ2Vycm9yJyAmJiByZXBseS5hZ2VudC5sYXN0RXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCByZXBseS5hZ2VudC5sYXN0RXJyb3IsICdlcnJvcicsIFt7IGxhYmVsOiAn6YeN6K+VJywgcnVuOiAoKSA9PiB2b2lkIHN0YXJ0QWdlbnQoc3RhdGUpIH1dKTtcbiAgICB9IGVsc2UgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyAhPT0gJ3N0YXJ0aW5nJyAmJiBEYXRlLm5vdygpID49IHN0YXRlLmJhbm5lclVudGlsKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgbnVsbCk7XG4gICAgfVxuXG4gICAgLy8g56m65oCB6Lef552A54q25oCB6LWwXG4gICAgaWYgKHN0YXRlLmVudHJpZXMuc2l6ZSA9PT0gMCkge1xuICAgICAgICBpZiAoc3RhdGUuZW1wdHlFbCkgc3RhdGUuZW1wdHlFbC5yZW1vdmUoKTtcbiAgICAgICAgc3RhdGUuZW1wdHlFbCA9IG51bGw7XG4gICAgICAgIHJlbmRlckVtcHR5KHN0YXRlLCByZXBseS5hZ2VudC5zdGF0dXMgPT09ICdyZWFkeScgPyAnbm8tbWVzc2FnZXMnIDogJ25vLWFnZW50Jyk7XG4gICAgfVxuXG4gICAgc3luY1R5cGluZyhzdGF0ZSk7XG4gICAgc3luY0xpdmVCbG9ja3Moc3RhdGUpO1xuXG4gICAgLy8g6K6+572u6YeM55qE6Ieq5Yqo5ZCv5Yqo77ya5Y+q5Zyo44CM56Gu5a6e5rKh6LW36L+H44CN5pe26Kem5Y+RXG4gICAgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3N0b3BwZWQnICYmIHJlcGx5LnNldHRpbmdzPy5hdXRvU3RhcnQgJiYgIXN0YXRlLnN0YXJ0UmVxdWVzdGVkICYmIHN0YXRlLmVudHJpZXMuc2l6ZSA9PT0gMCkge1xuICAgICAgICB2b2lkIHN0YXJ0QWdlbnQoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqIOaLieS4gOasoeWinumHj+i9rOWGmeOAgkByZXR1cm5zIOaYr+WQpuaLv+WIsOaWsOadoeebru+8iOWGs+WumuimgeS4jeimgemhuuW4puWIt+eKtuaAge+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcG9sbE9uY2Uoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZW50cmllcz86IEVudHJ5W107IHJldmlzaW9uPzogbnVtYmVyOyBnZW5lcmF0aW9uPzogbnVtYmVyIH0+KE1TRy5nZXRFdmVudHMsIHtcbiAgICAgICAgICAgIHNpbmNlOiBzdGF0ZS5tYXhSZXYsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDku6PmlbDlj5jkuoYgPSDkuLvov5vnqIvmjaLkuobkvJror50v5Zue5pS+5LqG5Y6G5Y+y77ya5YWI5pW05Z2X6YeN55S777yM5YaN5pS26L+Z5LiA5om5XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgdHlwZW9mIHJlcGx5LmdlbmVyYXRpb24gPT09ICdudW1iZXInICYmIHJlcGx5LmdlbmVyYXRpb24gIT09IHN0YXRlLmdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIHJlc2V0VWkoc3RhdGUsIHJlcGx5LmdlbmVyYXRpb24pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgdHlwZW9mIHJlcGx5LnJldmlzaW9uID09PSAnbnVtYmVyJykgc3RhdGUubWF4UmV2ID0gTWF0aC5tYXgoc3RhdGUubWF4UmV2LCByZXBseS5yZXZpc2lvbik7XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgQXJyYXkuaXNBcnJheShyZXBseS5lbnRyaWVzKSAmJiByZXBseS5lbnRyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGFwcGx5RW50cmllcyhzdGF0ZSwgcmVwbHkuZW50cmllcyk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDkuIvkuIDova7lho3or7QgKi9cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiog5ZCI5bm25LiA5om55p2h55uu77ya6LS05bqV5pe26Lef552A5rua77yM5LiN54S25L+d5oyB55So5oi355qE5L2N572u44CCICovXG5mdW5jdGlvbiBhcHBseUVudHJpZXMoc3RhdGU6IFVpU3RhdGUsIGVudHJpZXM6IEVudHJ5W10pOiB2b2lkIHtcbiAgICBjb25zdCBib2R5ID0gc3RhdGUuYm9keTtcbiAgICBjb25zdCBwaW5uZWQgPSBib2R5LnNjcm9sbFRvcCArIGJvZHkuY2xpZW50SGVpZ2h0ID49IGJvZHkuc2Nyb2xsSGVpZ2h0IC0gNDg7XG4gICAgaWYgKHN0YXRlLmVtcHR5RWwgJiYgZW50cmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHN0YXRlLmVtcHR5RWwucmVtb3ZlKCk7XG4gICAgICAgIHN0YXRlLmVtcHR5RWwgPSBudWxsO1xuICAgIH1cbiAgICBjb25zdCBwZW5kaW5nSnVtcCA9IHN0YXRlLmp1bXBUbyAhPT0gbnVsbDtcbiAgICBjb25zdCBjaGFuZ2VkID0gbWVyZ2VFbnRyaWVzKHN0YXRlLCBlbnRyaWVzKTtcbiAgICAvLyDimqAg5pyJ44CM6KaB5rua5Yiw55qE6YKj5LiA5p2h44CN5pe25LiN6K646LS05bqV77ya55+t5Lya6K+d5Lya6KKr6L+Z5Y+lIGBzY3JvbGxUb3AgPSBzY3JvbGxIZWlnaHRgIOmhtuWIsOacgOWQju+8jFxuICAgIC8vIOS6juaYr+WImuWImiBgc2Nyb2xsSW50b1ZpZXdgIOi/h+WOu+eahOS9jee9ruW9k+Wcuuiiq+imhueblu+8iGBhcHBseUp1bXBgIOWcqOS4i+mdoui3ke+8ieOAglxuICAgIGlmIChjaGFuZ2VkICYmIHBpbm5lZCAmJiAhcGVuZGluZ0p1bXApIHtcbiAgICAgICAgLy8g562J5LiA5bin5YaN5rua77ya5Yia5o+S5YWl55qE5YaF5a656L+Y5rKh6YeP6auY5bqmXG4gICAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICBib2R5LnNjcm9sbFRvcCA9IGJvZHkuc2Nyb2xsSGVpZ2h0O1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgLy8g44CM5pCc5Yiw55qE5bCx5piv6L+Z5LiA5p2h44CN77ya5p2h55uu55yf55qE5Yiw5LqG6Z2i5p2/5LiK5omN5rua5b6X5Yqo77yI5Zue5pS+5piv5Li76L+b56iL55qE5Ymv5L2c55So77yJXG4gICAgaWYgKGNoYW5nZWQpIGFwcGx5SnVtcChzdGF0ZSk7XG59XG5cbi8qKiDlupTnlKjlub/mkq3mjqjmnaXnmoTmm7TmlrDvvIjkuI7ova7or6LotbDlkIzkuIDlpZflkIjlubbpgLvovpHvvInjgIIgKi9cbmZ1bmN0aW9uIGFwcGx5QnJvYWRjYXN0KHN0YXRlOiBVaVN0YXRlLCB1cGRhdGU6IHVua25vd24pOiB2b2lkIHtcbiAgICBjb25zdCBwYXlsb2FkID0gdXBkYXRlIGFzIEhvc3RVcGRhdGVWaWV3IHwgdW5kZWZpbmVkO1xuICAgIGlmICghcGF5bG9hZCkgcmV0dXJuO1xuICAgIGlmIChwYXlsb2FkLnJ1bm5pbmcgIT09IHVuZGVmaW5lZCAmJiBzdGF0ZS5zbmFwc2hvdCkgc3RhdGUuc25hcHNob3QucnVubmluZyA9IHBheWxvYWQucnVubmluZztcbiAgICBpZiAocGF5bG9hZC5zdGF0dXMgJiYgc3RhdGUuc25hcHNob3QpIHN0YXRlLnNuYXBzaG90LnN0YXR1cyA9IHBheWxvYWQuc3RhdHVzO1xuICAgIC8vIOW5v+aSreS5n+WPr+iDveW4puadpeOAjOaNouS8muivneOAje+8iOa4heepuiArIOS7o+aVsOS4uuivge+8ie+8jOWkhOeQhuWPo+W+hOS4jui9ruivouS4gOiHtFxuICAgIGlmICh0eXBlb2YgcGF5bG9hZC5nZW5lcmF0aW9uID09PSAnbnVtYmVyJyAmJiBwYXlsb2FkLmdlbmVyYXRpb24gIT09IHN0YXRlLmdlbmVyYXRpb24pIHtcbiAgICAgICAgcmVzZXRVaShzdGF0ZSwgcGF5bG9hZC5nZW5lcmF0aW9uKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGF5bG9hZC5lbnRyaWVzKSAmJiBwYXlsb2FkLmVudHJpZXMubGVuZ3RoID4gMCkgYXBwbHlFbnRyaWVzKHN0YXRlLCBwYXlsb2FkLmVudHJpZXMgYXMgRW50cnlbXSk7XG4gICAgLy8g5Lqk5LqS5piv5pW05Lu95p2l55qE77yI5LiN5piv5aKe6YeP77yJ77ya5LiA6Zeu5LiA562U5bCx5piv44CM546w5Zyo5b+F6aG754K55LiA5LiL44CN77yM562J6L2u6K+i5pyA5Z2P6KaB5oWi6L+R5LiA56eSXG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGF5bG9hZC5pbnRlcmFjdGlvbnMpKSB7XG4gICAgICAgIHN0YXRlLmludGVyYWN0aW9ucyA9IHBheWxvYWQuaW50ZXJhY3Rpb25zO1xuICAgICAgICByZW5kZXJJbnRlcmFjdGlvbnMoc3RhdGUpO1xuICAgIH1cbiAgICAvLyDmoIfpopjkuZ/mmK/mlbTku73mnaXnmoTjgILkuLrku4DkuYjlgLzlvpfotbDlub/mkq3vvJrlroMqKuW8guatpSoq5Yiw77yIYHNlc3Npb24tdGl0bGUtbGxtYCDopoHlj6blj5HkuIDmrKFcbiAgICAvLyDmqKHlnovor7fmsYLvvInvvIzpnaAgODAwbXMg55qE6L2u6K+i5Lya5piO5pi+6L+f5YiwIOKAlOKAlCDogIxcIuagh+mimOWFiOeyl+WQjue7huWcsOi3s+S4gOasoVwi5q2j5piv5a6D6K+l5pyJ55qE5qC35a2Q44CCXG4gICAgaWYgKHBheWxvYWQudGl0bGUgIT09IHVuZGVmaW5lZCAmJiBzdGF0ZS5zbmFwc2hvdCkge1xuICAgICAgICBzdGF0ZS5zbmFwc2hvdC50aXRsZSA9IHBheWxvYWQudGl0bGU7XG4gICAgICAgIGlmIChzdGF0ZS50aXRsZSkge1xuICAgICAgICAgICAgc3RhdGUudGl0bGUudGV4dENvbnRlbnQgPSBwYXlsb2FkLnRpdGxlIHx8IGBEU0ggwrcgJHtQUk9GSUxFX05BTUV9YDtcbiAgICAgICAgICAgIHN0YXRlLnRpdGxlLnRpdGxlID0gcGF5bG9hZC50aXRsZSA/IGDkvJror53moIfpopjvvJoke3BheWxvYWQudGl0bGV9YCA6IGBEU0ggwrcgJHtQUk9GSUxFX05BTUV9YDtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyDlub/mkq3lj6rluKblop7ph4/vvIxyZXZpc2lvbiDnlKjlroPmjqjmuLjmoIfvvJvmvI/mjonnmoTpg6jliIbpnaDova7or6LooaXpvZBcbiAgICBpZiAodHlwZW9mIHBheWxvYWQucmV2aXNpb24gPT09ICdudW1iZXInICYmIHBheWxvYWQucmV2aXNpb24gPiBzdGF0ZS5tYXhSZXYpIHN0YXRlLm1heFJldiA9IHBheWxvYWQucmV2aXNpb247XG4gICAgLy8g55So6YeP5Lmf5piv5pW05Lu95p2l55qE77yIYG51bGxgID0g5piO56Gu44CM546w5Zyo5rKh5pyJ6K+75pWw44CN77yJ44CC6LWw5bm/5pKt55qE55CG55Sx77ya5a6D5pivKirlm57lkIjnu5PmnZ8qKuaJjeWIt+eahO+8jFxuICAgIC8vIOiAjOWFqOmHj+eKtuaAgei9ruivouaYr+OAjOavjyA1IOi3s+OAje+8iOepuumXsiA0IOenku+8ieKAlOKAlCDpnaDlroPnmoTor53mlbDlrZfkvJrmmZrlpb3lh6Dnp5LmiY3lj5jjgIJcbiAgICBpZiAocGF5bG9hZC51c2FnZSAhPT0gdW5kZWZpbmVkICYmIHN0YXRlLnNuYXBzaG90KSB7XG4gICAgICAgIHN0YXRlLnNuYXBzaG90LnVzYWdlID0gcGF5bG9hZC51c2FnZSA/PyBudWxsO1xuICAgICAgICBzdGF0ZS5zbmFwc2hvdC51c2FnZU5vdGUgPSBwYXlsb2FkLnVzYWdlTm90ZSA/PyBudWxsO1xuICAgICAgICByZW5kZXJVc2FnZUNoaXAoc3RhdGUpO1xuICAgICAgICBpZiAoc3RhdGUudXNhZ2VPcGVuKSByZW5kZXJVc2FnZShzdGF0ZSk7XG4gICAgfVxuICAgIC8vIOi/m+W6puS5n+aYr+aVtOS7veadpeeahOOAguWug+avlOeUqOmHj+abtOWAvOW+l+i1sOW5v+aSre+8mua4heWNleaYryBhZ2VudCDlnKgqKuWbnuWQiOS4remXtCoq5YaZ55qE77yMXG4gICAgLy8g6ICM5qCH6K6w55qE5q2j5piv44CM5oiR546w5Zyo5YGa5Yiw5ZOq5LiA5q2l44CN4oCU4oCUIOmdoOi9ruivouS8muaYjuaYvui/n+WIsOOAglxuICAgIGlmIChwYXlsb2FkLnByb2dyZXNzICE9PSB1bmRlZmluZWQgJiYgc3RhdGUuc25hcHNob3QpIHtcbiAgICAgICAgc3RhdGUuc25hcHNob3QucHJvZ3Jlc3MgPSBwYXlsb2FkLnByb2dyZXNzID8/IG51bGw7XG4gICAgICAgIHN0YXRlLnNuYXBzaG90LnByb2dyZXNzTm90ZSA9IHBheWxvYWQucHJvZ3Jlc3NOb3RlID8/IG51bGw7XG4gICAgICAgIHJlbmRlclByb2dyZXNzQ2hpcChzdGF0ZSk7XG4gICAgICAgIGlmIChzdGF0ZS5wcm9ncmVzc09wZW4pIHJlbmRlclByb2dyZXNzKHN0YXRlKTtcbiAgICB9XG4gICAgLy8g6L+Q6KGM54q25oCB5piv5bm/5pKt6YeM5pyA5paw55qE77yM56uL5Yi75Y+N5pig5Yiw54q25oCB6KGM5LiO44CM5q2j5Zyo5Zue5aSN44CN5LiKXG4gICAgaWYgKHN0YXRlLmxpdmUpIHtcbiAgICAgICAgY29uc3QgbGl2ZSA9IGxpdmVUZXh0KHN0YXRlKTtcbiAgICAgICAgc3RhdGUubGl2ZS50ZXh0Q29udGVudCA9IGxpdmUudGV4dDtcbiAgICAgICAgc3RhdGUubGl2ZS5kYXRhc2V0LnRvbmUgPSBsaXZlLnRvbmUgPT09ICdidXN5JyA/ICdidXN5JyA6IGxpdmUudG9uZSA9PT0gJ2Vycm9yJyA/ICdlcnJvcicgOiAnJztcbiAgICB9XG4gICAgc3luY1R5cGluZyhzdGF0ZSk7XG4gICAgc3luY0xpdmVCbG9ja3Moc3RhdGUpO1xuICAgIHN5bmNJbnRlcnJ1cHRCdXR0b24oc3RhdGUpO1xufVxuXG4vKipcbiAqIOOAjOWBnOatouacrOi9ruOAjeaMiemSrueahOaYvumakCDigJTigJQgKirlub/mkq3kuI7ova7or6LkuKTmnaHot6/pg73opoHosIMqKuOAglxuICpcbiAqIOWPquaUvuWcqCBgcmVmcmVzaFN0YXRlYCDph4zkvJrmhaLljYrmi43vvJrpnaLmnb/lnKjot5HnmoTml7blgJnpnaDlub/mkq3mjqjlop7ph4/vvIzogIwgYHJlZnJlc2hTdGF0ZWBcbiAqIOWPquWcqOOAjOacieaWsOadoeebruOAjeaIluavjyBOIOi3s+aJjei3keS4gOasoe+8jOS6juaYr+OAjOaooeWei+WImuW8gOWni+aDsyDihpIg5oyJ6ZKu6K+l5Ye6546w44CN5Lya5pma5Yeg55m+5q+r56eS44CCXG4gKiDogIwgYHBheWxvYWQucnVubmluZ2Ag5oGw5aW95bCx5Zyo5q+P5LiA5qyh5bm/5pKt6YeM77yM6aG65omL5ZCM5q2l5piv5pyA5L6/5a6c55qE44CCXG4gKlxuICogQHBhcmFtIHN0YXRlIC0g6Z2i5p2/54q25oCB44CCXG4gKi9cbmZ1bmN0aW9uIHN5bmNJbnRlcnJ1cHRCdXR0b24oc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBydW5uaW5nID0gc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcgPT09IHRydWU7XG4gICAgLy8g6L+Z5LiA6L2u55yf55qE5pS25bC+5LmL5ZCO77yM44CM5q2j5Zyo5Lit5pat44CN6L+Z5Liq5Li05pe25oCB6Ieq5bex5aSN5L2N77yI5LiN5b+F562J6LCB5Y675riF77yJXG4gICAgaWYgKCFydW5uaW5nKSBzdGF0ZS5pbnRlcnJ1cHRpbmcgPSBmYWxzZTtcbiAgICBjb25zdCBidXR0b24gPSBzdGF0ZS5yb290Py5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignI2J0bi1pbnRlcnJ1cHQnKTtcbiAgICBpZiAoIWJ1dHRvbikgcmV0dXJuO1xuICAgIGNvbnN0IHNob3VsZEhpZGUgPSAhcnVubmluZztcbiAgICBpZiAoYnV0dG9uLmhpZGRlbiAhPT0gc2hvdWxkSGlkZSkgYnV0dG9uLmhpZGRlbiA9IHNob3VsZEhpZGU7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gIXJ1bm5pbmcgfHwgc3RhdGUuaW50ZXJydXB0aW5nID09PSB0cnVlO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOi+k+WFpeinpuWPkeWZqFxuLy9cbi8vIGAvYCDmlpzmnaDlkb3ku6Qg5LiOIGBAYCDot6/lvoTlvJXnlKgg4oCU4oCUIOS4pOagt+iDveWKmyoq6YO95Zyo5a6/5Li76YeMKirvvIhgY3R4LmNvbW1hbmRzYCAvXG4vLyBgY3R4LmZpbGVSZWZlcmVuY2VzYO+8ie+8jFNESyDljY/orq7kuIDkuKrpg73ooajovr7kuI3kuobvvIzmiYDku6Xnu4/mj5Lku7bmjqfliLbluKflgJ/ov4fmnaVcbi8vIO+8iOingSBgZHNoLWhvc3QudHNgIOeahOOAjOacjeWKoemAmumBk+OAjeS4gOiKgu+8ieOAglxuLy9cbi8vICMjIOS4ieadoeWPo+W+hO+8iOmDveaYr+i4qei/h+eahOmCo+enje+8iVxuLy9cbi8vIDEuICoq5LiA5Liq5a655Zmo44CB5LiA5aWX6ZSu55uY5Y2P6K6uKirvvJrkuKTogIXmsLjov5zkuI3kvJrlkIzml7blh7rnjrDvvIzlhbHnlKjkuIDkuKogYCNwb3B1cGAg5LiOXG4vLyAgICDihpHihpMg6YCJIC8gRW50ZXLCt1RhYiDorqQgLyBFc2Mg5YWz44CC5Lik5aWX5a6e546w5b+F54S25Zyo5YW25Lit5LiA5aWX5LiK5ryP5o6J5LiA5Liq6ZSu44CCXG4vLyAyLiAqKuS4jeWBmua1ruWxgioq77yI5LiO5Y6G5Y+y5oq95bGJ44CB5Zu+54mH6YCJ5oup5Zmo5ZCM5LiA5pGG5rOV77yJ77ya56qE6Z2i5p2/6YeM5rWu5bGC6KaB6Ieq5bex566X5L2N572u77yMXG4vLyAgICDogIzovpPlhaXmoYbkvJrplb/pq5jjgIHlr7nor53ljLrkvJrmu5rliqgg4oCU4oCUIOe7k+aenOWwseaYr1wi6I+c5Y2V6aOY5Yiw5Yir5aSEXCLjgILmjKTlnKjovpPlhaXljLrkuIrmlrnkuIDlnZfvvIxcbi8vICAgIOS9jee9ruawuOi/nOaYr+WvueeahO+8jOS7o+S7t+WPquaYr+aKiuWvueivneWMuuaMpOefruS4gOeCueOAglxuLy8gMy4gKipgL+W8gOWktOeahOaVtOihjOi+k+WFpeS4jei1sOaooeWeiyoq77ya5a6D5piv5ZG95Luk77yM6LWwIGBjb21tYW5kcy9ydW5g44CC6L+Z5p2h5LiN5piv5LyY5YyW77yMXG4vLyAgICDmmK/or63kuYkg4oCU4oCUIOaKiiBgL2NvbXBhY3RgIOW9k+aZrumAmua2iOaBr+WPkee7meaooeWei++8jOaooeWei+WPquS8muS4gOiEuOiMq+eEtuWcsOWbnuS9oOS4gOauteivneOAglxuXG4vKiog5by55Ye65Z2X5pyA5aSa55S75Yeg5p2h77yI5YaN5aSa5Lmf55yL5LiN5a6M77yM6L+Y5Lya5oqK5a+56K+d5Yy65oyk5rKh77yJ44CCICovXG5jb25zdCBQT1BVUF9MSU1JVCA9IDEyO1xuXG4vKipcbiAqIGBAYCDlgJnpgInnvJPlrZjnmoQga2V5IOS4iumZkOOAglxuICpcbiAqIGBAYCDooaXlhajmmK8qKuavj+aVsuS4gOS4quWtl+espuaNouS4gOS4quafpeivouS4sioq77yM5LiA5qyh5Lya6K+d6IO95pSS5LiL5Yeg55m+5LiqIGtlee+8iOavj+S4qumDveaYr+S4gOS4quWAmemAieaVsOe7hO+8ieOAglxuICog6LaF5LqG5bCx5pW05Liq5riF5o6JIOKAlOKAlCDlj43mraPkuIvkuIDmrKHmn6Xor6LkvJrph43mlrDpl67vvIzogIzmj5DkvpvmlrnpgqPovrnmnKzmnaXlsLHmnInoh6rlt7HnmoTntKLlvJXnvJPlrZhcbiAqIO+8iOaIkeS7rOi/meWxguWPquaYr+ecgeS4gOasoSBJUEPvvInjgIJcbiAqL1xuY29uc3QgTUVOVElPTl9DQUNIRV9MSU1JVCA9IDIwMDtcblxuLyoqXG4gKiDlhbPmjonlvLnlh7rlnZfjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqL1xuZnVuY3Rpb24gY2xvc2VQb3B1cChzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIHN0YXRlLnBvcHVwS2luZCA9IG51bGw7XG4gICAgc3RhdGUucG9wdXBJdGVtcyA9IFtdO1xuICAgIHN0YXRlLnBvcHVwSW5kZXggPSAwO1xuICAgIGlmIChzdGF0ZS5wb3B1cCkge1xuICAgICAgICBzdGF0ZS5wb3B1cC5oaWRkZW4gPSB0cnVlO1xuICAgICAgICBzdGF0ZS5wb3B1cC50ZXh0Q29udGVudCA9ICcnO1xuICAgICAgICBkZWxldGUgc3RhdGUucG9wdXAuZGF0YXNldC5raW5kO1xuICAgIH1cbn1cblxuLyoqXG4gKiDnlLvlvLnlh7rlnZfjgIJcbiAqXG4gKiDlj6rlnKgqKuWGheWuueWPmOS6hioq55qE5pe25YCZ6YeN5bu6IERPTe+8iGBwb3B1cEtpbmRgICsg5YCZ6YCJ5qCH562+55qE562+5ZCN77yJ4oCU4oCUXG4gKiDkuI7kuqTkupLljaHniYflkIzkuIDkuKrnkIbnlLHvvJrov5nkuKrlnZflnKjovpPlhaXov4fnqIvkuK3kvJrooqvlj43lpI3op6blj5HvvIzph43lu7ogRE9NIOS8muaKiumUruebmOmrmOS6ruS4jlxuICog6byg5qCH5oKs5YGc54q25oCB5LiA6LW35oq55o6J44CCXG4gKlxuICogQHBhcmFtIHN0YXRlIC0g6Z2i5p2/54q25oCB44CCXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclBvcHVwKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IHN0YXRlLnBvcHVwO1xuICAgIGlmICghaG9zdCkgcmV0dXJuO1xuICAgIGlmIChzdGF0ZS5wb3B1cEtpbmQgPT09IG51bGwgfHwgc3RhdGUucG9wdXBJdGVtcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY2xvc2VQb3B1cChzdGF0ZSk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8g562+5ZCNKirlj6rlkKvjgIzlk6rkupvlgJnpgInjgI0qKu+8jOS4jeWQq+mrmOS6ruS4i+aghyDigJTigJQg6auY5Lqu5piv5q+P5LiA5bin6YO96KaB6YeN566X55qE5L6/5a6c5rS777yMXG4gICAgLy8g6ICM6YeN5bu6IERPTSDkvJrmiorpvKDmoIfmgqzlgZwv5rua5Yqo5L2N572u5LiA6LW35riF5o6J44CC5oqKIGluZGV4IOaUvui/m+etvuWQjeWwseetieS6juavj+aMieS4gOasoVxuICAgIC8vIOS4iuS4i+mUrumHjeW7uuaVtOS4quWIl+ihqO+8iOesrOS4gOeJiOWwseaYr+i/meS5iOWGmeeahO+8jOazqOmHiui/mOWGmeedgFwi5Y+q5Yqo6auY5LquXCLvvIzlrp7pmYXpgqPmnaHot6/moLnmnKzotbDkuI3liLDvvInjgIJcbiAgICBjb25zdCBzaWduYXR1cmUgPSBgJHtzdGF0ZS5wb3B1cEtpbmR9OiR7c3RhdGUucG9wdXBJdGVtcy5tYXAoKGl0ZW0pID0+IGAke2l0ZW0ubGFiZWx9XFx1MDAwMCR7aXRlbS5kZXRhaWx9YCkuam9pbignXFx1MDAwMScpfWA7XG4gICAgaWYgKGhvc3QuZGF0YXNldC5zaWcgIT09IHNpZ25hdHVyZSkge1xuICAgICAgICBob3N0LmRhdGFzZXQuc2lnID0gc2lnbmF0dXJlO1xuICAgICAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG4gICAgICAgIGhvc3QuaGlkZGVuID0gZmFsc2U7XG4gICAgICAgIGhvc3QuZGF0YXNldC5raW5kID0gc3RhdGUucG9wdXBLaW5kO1xuICAgICAgICBzdGF0ZS5wb3B1cEl0ZW1zLmZvckVhY2goKGl0ZW0sIGluZGV4KSA9PiB7XG4gICAgICAgICAgICBjb25zdCByb3cgPSBlbCgnYnV0dG9uJywgJ2RzaC1wb3B1cC1pdGVtJyk7XG4gICAgICAgICAgICByb3cudHlwZSA9ICdidXR0b24nO1xuICAgICAgICAgICAgLy8gYG1vdXNlZG93bmAg6ICM5LiN5pivIGBjbGlja2DvvJpjbGljayDkuYvliY3ovpPlhaXmoYbkvJrlhYjlpLHnhKbvvIzogIzlpLHnhKbkvJrlhbPmjonoj5zljZVcbiAgICAgICAgICAgIC8vIO+8iGBibHVyYCDpgqPmnaHot6/op4EgYG1vdW50YCDph4znmoTnm5HlkKzvvInigJTigJTnlKggbW91c2Vkb3duIOaKouWcqOWug+WJjemdouOAglxuICAgICAgICAgICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIChldmVudDogTW91c2VFdmVudCkgPT4ge1xuICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICAgICAgc3RhdGUucG9wdXBJbmRleCA9IGluZGV4O1xuICAgICAgICAgICAgICAgIGFjY2VwdFBvcHVwKHN0YXRlKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcm93LmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1wb3B1cC1sYWJlbCcsIGl0ZW0ubGFiZWwpKTtcbiAgICAgICAgICAgIGlmIChpdGVtLmRldGFpbCkgcm93LmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1wb3B1cC1kZXRhaWwnLCBpdGVtLmRldGFpbCkpO1xuICAgICAgICAgICAgaWYgKGl0ZW0uZGlzYWJsZWQpIHtcbiAgICAgICAgICAgICAgICByb3cuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJvdy5kYXRhc2V0LmRpc2FibGVkID0gJ3RydWUnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaG9zdC5hcHBlbmRDaGlsZChyb3cpO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgLy8g6auY5Lqu5q+P5qyh6YO96YeN566X77yI5bmC562J44CB5L6/5a6c77yJ77yM6L+Z5qC344CM6YeN5bu644CN5LiO44CM5Y+q5o2i6auY5Lqu44CN5Lik5p2h6Lev5YWx55So5ZCM5LiA5q615Luj56CBXG4gICAgY29uc3Qgcm93cyA9IGhvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJy5kc2gtcG9wdXAtaXRlbScpO1xuICAgIHJvd3MuZm9yRWFjaCgocm93LCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAoaW5kZXggPT09IHN0YXRlLnBvcHVwSW5kZXgpIHJvdy5kYXRhc2V0LmFjdGl2ZSA9ICd0cnVlJztcbiAgICAgICAgZWxzZSBkZWxldGUgcm93LmRhdGFzZXQuYWN0aXZlO1xuICAgIH0pO1xufVxuXG4vKipcbiAqIOi+k+WFpeahhuWGheWuueWPmOS6huS5i+WQjumHjeeul+W8ueWHuuWdl++8iGAvYCDlkb3ku6Qg5LiOIGBAYCDot6/lvoTvvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqL1xuZnVuY3Rpb24gcmVmcmVzaFBvcHVwKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgdmFsdWUgPSBzdGF0ZS5pbnB1dC52YWx1ZTtcbiAgICBjb25zdCBjYXJldCA9IHN0YXRlLmlucHV0LnNlbGVjdGlvblN0YXJ0ID8/IHZhbHVlLmxlbmd0aDtcblxuICAgIC8vIOKRoCDlkb3ku6TvvJrmlbTooYzku6UgYC9gIOW8gOWktOOAgei/mOayoeWHuueOsOepuueZve+8iOingSBgY29tbWFuZERyYWZ0YCDnmoTlj6PlvoTvvIlcbiAgICBjb25zdCBkcmFmdCA9IGNvbW1hbmREcmFmdCh2YWx1ZSwgY2FyZXQpO1xuICAgIGlmIChkcmFmdCkge1xuICAgICAgICBvcGVuQ29tbWFuZFBvcHVwKHN0YXRlLCBkcmFmdC5xdWVyeSk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyDikaEgYEBgIOi3r+W+hO+8muWFieagh+WkhOmCo+S4qua0u+WKqCB0b2tlblxuICAgIGNvbnN0IHsgbGluZSwgY29sIH0gPSBsaW5lQXQodmFsdWUsIGNhcmV0KTtcbiAgICBjb25zdCB0b2tlbiA9IGFjdGl2ZUF0VG9rZW4obGluZSwgY29sKTtcbiAgICBpZiAodG9rZW4pIHtcbiAgICAgICAgb3Blbk1lbnRpb25Qb3B1cChzdGF0ZSwgdG9rZW4pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2xvc2VQb3B1cChzdGF0ZSk7XG59XG5cbi8qKlxuICog5omT5byA5pac5p2g5ZG95Luk6KGo44CCXG4gKlxuICog5ZG95Luk6KGoKirmjInkvJror53nvJPlrZgqKu+8iGBzdGF0ZS5jb21tYW5kc2DvvInvvIznrKzkuIDmrKHmlbIgYC9gIOaJjeaLiSDigJTigJQg6Z2i5p2/5oyC6L295pe25bCx5Y675ouJ5piv5rWq6LS577yaXG4gKiDlpKflpJrmlbDkvJror53ku47lpLTliLDlsL7kuI3nlKjlkb3ku6TvvIzogIzmi4nkuIDmrKHopoHotbAgSVBDIOWIsOaPkuS7tuWGjeafpeazqOWGjOihqOOAglxuICpcbiAqIEBwYXJhbSBzdGF0ZSAtIOmdouadv+eKtuaAgeOAglxuICogQHBhcmFtIHF1ZXJ5IC0gYC9gIOS5i+WQjuW3sue7j+aVsueahOmCo+S4gOaute+8iOeUqOadpei/h+a7pO+8ieOAglxuICovXG5mdW5jdGlvbiBvcGVuQ29tbWFuZFBvcHVwKHN0YXRlOiBVaVN0YXRlLCBxdWVyeTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKHN0YXRlLmNvbW1hbmRzID09PSBudWxsKSB7XG4gICAgICAgIHZvaWQgbG9hZENvbW1hbmRzKHN0YXRlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBuZWVkbGUgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IGl0ZW1zID0gc3RhdGUuY29tbWFuZHNcbiAgICAgICAgLmZpbHRlcigoY29tbWFuZCkgPT4gIW5lZWRsZSB8fCBjb21tYW5kLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpKVxuICAgICAgICAuc2xpY2UoMCwgUE9QVVBfTElNSVQpXG4gICAgICAgIC5tYXAoKGNvbW1hbmQpID0+ICh7XG4gICAgICAgICAgICBsYWJlbDogYC8ke2NvbW1hbmQubmFtZX1gLFxuICAgICAgICAgICAgZGV0YWlsOiBgJHtjb21tYW5kLmRlc2NyaXB0aW9ufSR7Y29tbWFuZC5oaW50ID8gYCAgJHtjb21tYW5kLmhpbnR9YCA6ICcnfWAsXG4gICAgICAgICAgICBhcHBseTogKCkgPT4ge1xuICAgICAgICAgICAgICAgIC8vIOWRveS7pOihpeWFqOWPquaKiioq5ZG95Luk6KGMKirloavov5vovpPlhaXmoYbvvIzkuI3nm7TmjqXmiafooYzvvJpcbiAgICAgICAgICAgICAgICAvLyBgL3BsYW5gIOi/meexu+WRveS7pOWQjumdoui/mOimgeWGmeWPguaVsO+8iGAvcGxhbiDmiorphY3ooajov4Hnp7vliLDmlrDlj6PlvoRg77yJ77yMXG4gICAgICAgICAgICAgICAgLy8g6Ieq5Yqo5omn6KGM562J5LqO5pu/55So5oi35oyJ5LqG5Zue6L2m44CCXG4gICAgICAgICAgICAgICAgc3RhdGUuaW5wdXQudmFsdWUgPSBgLyR7Y29tbWFuZC5uYW1lfSR7Y29tbWFuZC5oaW50ID8gJyAnIDogJyd9YDtcbiAgICAgICAgICAgICAgICBzdGF0ZS5pbnB1dC5mb2N1cygpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVuZCA9IHN0YXRlLmlucHV0LnZhbHVlLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBzdGF0ZS5pbnB1dC5zZXRTZWxlY3Rpb25SYW5nZShlbmQsIGVuZCk7XG4gICAgICAgICAgICAgICAgYXV0b0dyb3coc3RhdGUuaW5wdXQpO1xuICAgICAgICAgICAgICAgIHNhdmVEcmFmdChzdGF0ZS5pbnB1dC52YWx1ZSk7XG4gICAgICAgICAgICAgICAgY2xvc2VQb3B1cChzdGF0ZSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICB9KSk7XG4gICAgaWYgKGl0ZW1zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyDmiZPkuobkuIDljYrmsqHljLnphY3vvJoqKuWFs+aOiSoq6ICM5LiN5piv55WZ5LiA5Liq56m65qGG77yI56m65qGG55yL6LW35p2l5YOP6Z2i5p2/5Y2h5LqG77yJXG4gICAgICAgIGNsb3NlUG9wdXAoc3RhdGUpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHN0YXRlLnBvcHVwS2luZCA9ICdjb21tYW5kJztcbiAgICBzdGF0ZS5wb3B1cEl0ZW1zID0gaXRlbXM7XG4gICAgc3RhdGUucG9wdXBJbmRleCA9IE1hdGgubWluKHN0YXRlLnBvcHVwSW5kZXgsIGl0ZW1zLmxlbmd0aCAtIDEpO1xuICAgIHJlbmRlclBvcHVwKHN0YXRlKTtcbn1cblxuLyoqXG4gKiDmi4nkuIDmrKHlkb3ku6TooajvvIjlj6rmi4nkuIDmrKHvvIzlpLHotKXlsLHnlZnnqbrooajlubbmj5DnpLrvvInjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9hZENvbW1hbmRzKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8g5YWI5Y2g5L2N77yM6YG/5YWN5ZCM5LiA5qyh6L6T5YWl6YeM6L+e5omT5Yeg5Y+R77yIYG51bGxgIOWPquihqOekulwi6L+Y5rKh5ouJ6L+HXCLvvIlcbiAgICBzdGF0ZS5jb21tYW5kcyA9IFtdO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBjb21tYW5kcz86IENvbW1hbmRWaWV3W107IGVycm9yPzogc3RyaW5nIH0+KE1TRy5jb21tYW5kTGlzdCk7XG4gICAgICAgIGlmICghcmVwbHk/Lm9rKSB7XG4gICAgICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDor7vkuI3liLDmlpzmnaDlkb3ku6TooajvvJoke3JlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzdGF0ZS5jb21tYW5kcyA9IEFycmF5LmlzQXJyYXkocmVwbHkuY29tbWFuZHMpID8gcmVwbHkuY29tbWFuZHMgOiBbXTtcbiAgICAgICAgLy8g5ouJ5Zue5p2l5pe255So5oi35Y+v6IO95bey57uP5omT5a6M5LqG5ZG95Luk5ZCNIOKAlOKAlCDph43nrpfkuIDmrKFcbiAgICAgICAgcmVmcmVzaFBvcHVwKHN0YXRlKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDor7vkuI3liLDmlpzmnaDlkb3ku6TooajvvJoke1N0cmluZyhlcnJvcil9YCwgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgfVxufVxuXG4vKipcbiAqIOaJk+W8gCBgQGAg6Lev5b6E5YCZ6YCJ44CCXG4gKlxuICog5LiJ5p2h57uG6IqC77yaXG4gKiAxLiAqKue8k+WtmOaMieafpeivouS4sioq77yaYEBgIOihpeWFqOavj+aVsuS4gOS4quWtl+espumXruS4gOasoe+8jOiAjOaPkOS+m+aWueeahOesrOS4gOasoeOAjOijuOafpeivouOAjeimgeaKiuW3peS9nOWMulxuICogICAg57Si5byV5LiA6YGN77yb5ZCM5LiA5Liq5p+l6K+i5Liy77yI6YCA5qC85YaN5omT5Zue5p2l77yJ55u05o6l5ZCD57yT5a2Y44CCXG4gKiAyLiAqKuW6j+WPt+mYsuS5seW6jyoq77ya5byC5q2l5Zue5p2l55qE57uT5p6c5bim5Y+R6LW35pe255qE5bqP5Y+377yM5a+55LiN5LiK5bCx5LiiIOKAlOKAlCDlkKbliJnmiZPlrZflv6vnmoTml7blgJlcbiAqICAgIOaXp+e7k+aenOS8muebluaOieaWsOe7k+aenO+8jOiPnOWNlemHjOeahOWAmemAieeci+i1t+adpeOAjOi3s+WbnuS6huS4iuS4gOS4quWtl+espuOAjeOAglxuICogMy4gKirlgJnpgInkuLrnqbrml7blhbPmjonoj5zljZUqKu+8mueVmeS4gOS4quepuuahhuavlOayoeacieahhuabtOiuqeS6uuWbsOaDkeOAglxuICpcbiAqIEBwYXJhbSBzdGF0ZSAtIOmdouadv+eKtuaAgeOAglxuICogQHBhcmFtIHRva2VuIC0gYGFjdGl2ZUF0VG9rZW5gIOe7meeahCB0b2tlbuOAglxuICovXG5mdW5jdGlvbiBvcGVuTWVudGlvblBvcHVwKHN0YXRlOiBVaVN0YXRlLCB0b2tlbjogeyBwcmVmaXg6IHN0cmluZzsgcXVlcnk6IHN0cmluZzsgcXVvdGVkOiBib29sZWFuIH0pOiB2b2lkIHtcbiAgICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5tZW50aW9uQ2FjaGUuZ2V0KHRva2VuLnF1ZXJ5KTtcbiAgICBpZiAoY2FjaGVkKSB7XG4gICAgICAgIHNob3dNZW50aW9uSXRlbXMoc3RhdGUsIHRva2VuLCBjYWNoZWQpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHNlcSA9ICsrc3RhdGUubWVudGlvblNlcTtcbiAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgY2FuZGlkYXRlcz86IFJlZmVyZW5jZUNhbmRpZGF0ZVtdOyBlcnJvcj86IHN0cmluZyB9PihNU0cuZmlsZVJlZmVyZW5jZSwge1xuICAgICAgICAgICAgICAgIHF1ZXJ5OiB0b2tlbi5xdWVyeSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKHNlcSAhPT0gc3RhdGUubWVudGlvblNlcSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKCFyZXBseT8ub2spIHtcbiAgICAgICAgICAgICAgICAvLyDov5nmnaEqKuS4jeW8ueaoquW5hSoq77yaYEBgIOaYr+i+ueaJk+Wtl+i+uemXrueahO+8jOacjeWKoeayoeaMguaXtuavj+aVsuS4gOS4quWtl+espuW8ueS4gOasoee6ouadoeS8mua3ueaOiemdouadv+OAglxuICAgICAgICAgICAgICAgIGNsb3NlUG9wdXAoc3RhdGUpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBBcnJheS5pc0FycmF5KHJlcGx5LmNhbmRpZGF0ZXMpID8gcmVwbHkuY2FuZGlkYXRlcyA6IFtdO1xuICAgICAgICAgICAgc3RhdGUubWVudGlvbkNhY2hlLnNldCh0b2tlbi5xdWVyeSwgY2FuZGlkYXRlcyk7XG4gICAgICAgICAgICAvLyDnvJPlrZjkuIrpmZDvvJpgQGAg5pivKirmr4/mlbLkuIDkuKrlrZfnrKYqKuaNouS4gOS4quafpeivouS4sueahO+8jOS4gOasoeS8muivneiDveaUkuS4i+WHoOeZvuS4qiBrZXlcbiAgICAgICAgICAgIC8vIO+8iOavj+S4qumDveaYr+S4gOS4quWAmemAieaVsOe7hO+8ieOAgui2heS6huWwseaVtOS4qua4heaOiSDigJTigJQg5Y+N5q2j5LiL5LiA5qyh5p+l6K+i5Lya6YeN5paw6Zeu77yMXG4gICAgICAgICAgICAvLyDogIzkuJTmj5DkvpvmlrnpgqPovrnmnKzmnaXlsLHmnInntKLlvJXnvJPlrZjvvIjmiJHku6zov5nlsYLlj6rmmK/nnIHkuIDmrKEgSVBD77yJ44CCXG4gICAgICAgICAgICBpZiAoc3RhdGUubWVudGlvbkNhY2hlLnNpemUgPiBNRU5USU9OX0NBQ0hFX0xJTUlUKSBzdGF0ZS5tZW50aW9uQ2FjaGUuY2xlYXIoKTtcbiAgICAgICAgICAgIHNob3dNZW50aW9uSXRlbXMoc3RhdGUsIHRva2VuLCBjYW5kaWRhdGVzKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBpZiAoc2VxID09PSBzdGF0ZS5tZW50aW9uU2VxKSBjbG9zZVBvcHVwKHN0YXRlKTtcbiAgICAgICAgfVxuICAgIH0pKCk7XG59XG5cbi8qKlxuICog5oqK5LiA5om5IGBAYCDlgJnpgInnlLvlh7rmnaXjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSB0b2tlbiAtIOinpuWPkei/measoeafpeivoueahCB0b2tlbu+8iOW6lOeUqOihpeWFqOaXtuimgeaLv+Wug+abv+aNou+8ieOAglxuICogQHBhcmFtIGNhbmRpZGF0ZXMgLSDlgJnpgInjgIJcbiAqL1xuZnVuY3Rpb24gc2hvd01lbnRpb25JdGVtcyhzdGF0ZTogVWlTdGF0ZSwgdG9rZW46IHsgcHJlZml4OiBzdHJpbmc7IHF1ZXJ5OiBzdHJpbmc7IHF1b3RlZDogYm9vbGVhbiB9LCBjYW5kaWRhdGVzOiBSZWZlcmVuY2VDYW5kaWRhdGVbXSk6IHZvaWQge1xuICAgIGNvbnN0IGl0ZW1zID0gY2FuZGlkYXRlc1xuICAgICAgICAuc2xpY2UoMCwgUE9QVVBfTElNSVQpXG4gICAgICAgIC5tYXAoKGNhbmRpZGF0ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgaW5zZXJ0aW9uID0gZm9ybWF0RmlsZU1lbnRpb24oY2FuZGlkYXRlLCB0b2tlbi5xdW90ZWQpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBsYWJlbDogY2FuZGlkYXRlLmtpbmQgPT09ICdkaXJlY3RvcnknID8gYCR7Y2FuZGlkYXRlLnBhdGh9L2AgOiBjYW5kaWRhdGUucGF0aCxcbiAgICAgICAgICAgICAgICBkZXRhaWw6IGNhbmRpZGF0ZS5raW5kID09PSAnZGlyZWN0b3J5JyA/ICfnm67lvZXvvIjnu6fnu63lvoDkuIvpkrvvvIknIDogJ+aWh+S7ticsXG4gICAgICAgICAgICAgICAgZGlzYWJsZWQ6IGluc2VydGlvbiA9PT0gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIGFwcGx5OiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpbnNlcnRpb24gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYXJldCA9IHN0YXRlLmlucHV0LnNlbGVjdGlvblN0YXJ0ID8/IHN0YXRlLmlucHV0LnZhbHVlLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgICAgLy8g4pqgIOeUqCoq5b2T5YmNKirlhYnmoIfkvY3nva7ph43nrpcgdG9rZW7vvIzogIzkuI3mmK/nlKjlj5Hotbfmn6Xor6Lml7bpgqPkuKrvvJpcbiAgICAgICAgICAgICAgICAgICAgLy8g5byC5q2l5Zue5p2l5pe255So5oi35Y+v6IO95Y+I5omT5LqG5Yeg5Liq5a2X56ym77yI6YKj5pe2IHRva2VuIOW3sue7j+WPmOmVv++8ieOAglxuICAgICAgICAgICAgICAgICAgICAvLyDmi7/kuI3liLDmtLvliqggdG9rZW4g5bCx5LiN5pS55Lu75L2V5Lic6KW/77yIYHJlcGxhY2VUb2tlbmAg5Lmf5Lya5YaN5YWc5LiA5bGC77yJ44CCXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHsgbGluZSwgY29sIH0gPSBsaW5lQXQoc3RhdGUuaW5wdXQudmFsdWUsIGNhcmV0KTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbGl2ZSA9IGFjdGl2ZUF0VG9rZW4obGluZSwgY29sKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaXZlKSByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5leHQgPSByZXBsYWNlVG9rZW4oc3RhdGUuaW5wdXQudmFsdWUsIGNhcmV0LCBsaXZlLCBpbnNlcnRpb24pO1xuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5pbnB1dC52YWx1ZSA9IG5leHQudmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLmlucHV0LmZvY3VzKCk7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLmlucHV0LnNldFNlbGVjdGlvblJhbmdlKG5leHQuY2FyZXQsIG5leHQuY2FyZXQpO1xuICAgICAgICAgICAgICAgICAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgICAgICAgICAgICAgICAgIHNhdmVEcmFmdChzdGF0ZS5pbnB1dC52YWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIOebruW9lemAieS4reWQjioq55WZ5Zyo6I+c5Y2V6YeMKirvvIjnu6fnu63lvoDkuIvpkrvvvInvvIzmlofku7bpgInkuK3ljbPmlLblt6VcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZS5raW5kID09PSAnZGlyZWN0b3J5JykgcmVmcmVzaFBvcHVwKHN0YXRlKTtcbiAgICAgICAgICAgICAgICAgICAgZWxzZSBjbG9zZVBvcHVwKHN0YXRlKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgaWYgKGl0ZW1zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjbG9zZVBvcHVwKHN0YXRlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5wb3B1cEtpbmQgPSAnbWVudGlvbic7XG4gICAgc3RhdGUucG9wdXBJdGVtcyA9IGl0ZW1zO1xuICAgIHN0YXRlLnBvcHVwSW5kZXggPSAwO1xuICAgIHJlbmRlclBvcHVwKHN0YXRlKTtcbn1cblxuLyoqXG4gKiDplK7nm5jnp7vliqjpq5jkuq7jgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSBkZWx0YSAtICsxIOW+gOS4i++8jC0xIOW+gOS4iu+8iOmmluWwvuW+queOr++8ieOAglxuICovXG5mdW5jdGlvbiBtb3ZlUG9wdXAoc3RhdGU6IFVpU3RhdGUsIGRlbHRhOiBudW1iZXIpOiB2b2lkIHtcbiAgICBpZiAoc3RhdGUucG9wdXBLaW5kID09PSBudWxsIHx8IHN0YXRlLnBvcHVwSXRlbXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgY291bnQgPSBzdGF0ZS5wb3B1cEl0ZW1zLmxlbmd0aDtcbiAgICBzdGF0ZS5wb3B1cEluZGV4ID0gKHN0YXRlLnBvcHVwSW5kZXggKyBkZWx0YSArIGNvdW50KSAlIGNvdW50O1xuICAgIHJlbmRlclBvcHVwKHN0YXRlKTtcbn1cblxuLyoqXG4gKiDorqTkuIvlvZPliY3pq5jkuq7nmoTpgqPkuIDmnaHjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEByZXR1cm5zIOaYr+WQpua2iOi0ueS6hui/measoeWbnui9pi9UYWLvvIjmtojotLnkuoblsLHkuI3or6Xlho3otbDjgIzlj5HpgIHjgI3vvInjgIJcbiAqL1xuZnVuY3Rpb24gYWNjZXB0UG9wdXAoc3RhdGU6IFVpU3RhdGUpOiBib29sZWFuIHtcbiAgICBpZiAoc3RhdGUucG9wdXBLaW5kID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgaXRlbSA9IHN0YXRlLnBvcHVwSXRlbXNbc3RhdGUucG9wdXBJbmRleF07XG4gICAgaWYgKCFpdGVtKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGl0ZW0uZGlzYWJsZWQpIHJldHVybiB0cnVlO1xuICAgIGl0ZW0uYXBwbHkoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiDovpPlhaXop6blj5Hlmagv5by55Ye65Z2X55qE6ZSu55uY5Y2P6K6u44CC6L+U5ZueIGB0cnVlYCA9IOi/measoeaMiemUruW3sue7j+iiq+Wug+WQg+aOieOAglxuICpcbiAqIOS4uuS7gOS5iOimgeWcqCoq5o2V6I63KirpmLbmrrXlpITnkIbvvIhgbW91bnRgIOmHjOaMgiBga2V5ZG93bmAg55qE6YKj5LiA5q6177yJ77yaXG4gKiBFbnRlciDpu5jorqTmmK/jgIzlj5HpgIHjgI3vvIzogIzlvLnlh7rlnZfmiZPlvIDml7YgRW50ZXIg5bqU6K+l5piv44CM6K6k5LiL5YCZ6YCJ44CN44CC5Lik6ICF6YO95ZyoIGtleWRvd24g5LiK77yMXG4gKiDosIHlhYjnnIvliLDosIHor7Tkuobnrpcg4oCU4oCUIOeUsei/memHjOe7n+S4gOWGs+aWre+8jGBzZW5kYCDpgqPmnaHot6/kuI3lho3oh6rlt7HliKTjgIJcbiAqXG4gKiBAcGFyYW0gc3RhdGUgLSDpnaLmnb/nirbmgIHjgIJcbiAqIEBwYXJhbSBldmVudCAtIOmUruebmOS6i+S7tuOAglxuICogQHJldHVybnMg5piv5ZCm5bey6KKr5by55Ye65Z2X5raI6LS544CCXG4gKi9cbmZ1bmN0aW9uIGhhbmRsZVBvcHVwS2V5KHN0YXRlOiBVaVN0YXRlLCBldmVudDogS2V5Ym9hcmRFdmVudCk6IGJvb2xlYW4ge1xuICAgIGlmIChzdGF0ZS5wb3B1cEtpbmQgPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICBzd2l0Y2ggKGV2ZW50LmtleSkge1xuICAgICAgICBjYXNlICdBcnJvd0Rvd24nOlxuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIG1vdmVQb3B1cChzdGF0ZSwgMSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgY2FzZSAnQXJyb3dVcCc6XG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgbW92ZVBvcHVwKHN0YXRlLCAtMSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgY2FzZSAnVGFiJzpcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBhY2NlcHRQb3B1cChzdGF0ZSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgY2FzZSAnRW50ZXInOlxuICAgICAgICAgICAgLy8g57uE5ZCI6L6T5YWl77yI5Lit5paH6L6T5YWl5rOV77yJ5pe255qE5Zue6L2m5piv5Zyo6YCJ5a2X77yM5LiN5piv6K6k5YCZ6YCJXG4gICAgICAgICAgICBpZiAoZXZlbnQuaXNDb21wb3NpbmcpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBhY2NlcHRQb3B1cChzdGF0ZSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgY2FzZSAnRXNjYXBlJzpcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBjbG9zZVBvcHVwKHN0YXRlKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLyoqXG4gKiDmiafooYzkuIDmnaHmlpzmnaDlkb3ku6TooYzvvIgqKuS4jei1sOaooeWeiyoq77yJ44CCXG4gKlxuICog57uT5p6c55SxKirkuLvov5vnqIsqKuWGmei/m+i9rOWGme+8iOS4gOadoSBub3Rl77yJ77yM5omA5Lul6L+Z6YeM5LiN6Ieq5bex6YCg5p2h55uuIOKAlOKAlCDlj6rmnInkuIDkuKrnnJ/mupDvvIxcbiAqIOiAjOS4lOmdouadv+WIt+aWsCAvIOaNouS8muivnSAvIOWbnuaUvuS5i+WQjuWug+i/mOWcqO+8iOWbnuaUvumCo+adoeWIhuaUr+ingSBgaGFuZGxlU2Vzc2lvbkV2ZW50YO+8ieOAglxuICog6L+Z6YeM5Y+q6LSf6LSj77ya5riF56m66L6T5YWl44CB5aSx6LSl5pe25o+Q56S644CB5oqK5rKh5Y+R5Ye65Y6755qE5ZG95Luk5pS+5Zue5Y6744CCXG4gKlxuICogQHBhcmFtIHN0YXRlIC0g6Z2i5p2/54q25oCB44CCXG4gKiBAcGFyYW0gbGluZSAtIOWujOaVtOWRveS7pOihjOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBydW5Db21tYW5kTGluZShzdGF0ZTogVWlTdGF0ZSwgbGluZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN0YXRlLnNuYXBzaG90Py5zdGF0dXMgIT09ICdyZWFkeScpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAnYWdlbnQg6L+Y5rKh5bCx57uq77yM5ZG95Luk6KaB6L+e5LiK5Lya6K+d5omN6IO95omn6KGM44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmF0dGFjaG1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8g5ZG95Luk6Z2i546w5Zyo5rKh5pyJ5Zu+54mH5YWl5Y+j77yI5o+S5Lu255qEIGBjb21tYW5kcy9ydW5gIOS4gOW+i+S8oOepuuWbvueJh+aVsOe7hO+8ieKAlOKAlFxuICAgICAgICAvLyDkuI7lhbbpnZnpu5jkuKLmjonnlKjmiLfotLTnmoTlm77vvIzkuI3lpoLnm7Tor7TjgIJcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAn5pac5p2g5ZG95Luk5pqC5LiN5pSv5oyB5bim5Zu+54mH6ZmE5Lu277yI5YWI5oqK5Zu+5Y675o6J77yM5oiW6ICF5Zyo5pmu6YCa5raI5oGv6YeM5Y+R77yJ44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2xvc2VQb3B1cChzdGF0ZSk7XG4gICAgc3RhdGUuaW5wdXQudmFsdWUgPSAnJztcbiAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgc2F2ZURyYWZ0KCcnKTtcbiAgICBpZiAoc3RhdGUuc2VuZEJ1dHRvbikgc3RhdGUuc2VuZEJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBjYWxsPHsgb2s6IGJvb2xlYW47IGtub3duPzogYm9vbGVhbjsga2luZD86IHN0cmluZzsgdGV4dD86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLmNvbW1hbmRSdW4sIHsgbGluZSB9KTtcbiAgICAgICAgaWYgKCFyZXBseT8ub2spIHtcbiAgICAgICAgICAgIC8vIOe7k+aenOmCo+adoSBub3RlIOeUseS4u+i/m+eoi+WGme+8m+i/memHjOWPquaPkOekuiArIOaKiuWRveS7pOihjOaUvuWbnuWOu+iuqeeUqOaIt+aUuVxuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCByZXBseT8uZXJyb3IgPz8gJ+WRveS7pOayoeacieaJp+ihjCcsICdlcnJvcicsIFtdLCBCQU5ORVJfSE9MRC5FUlJPUik7XG4gICAgICAgICAgICBzdGF0ZS5pbnB1dC52YWx1ZSA9IGxpbmU7XG4gICAgICAgICAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgICAgICAgICBzYXZlRHJhZnQobGluZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIG51bGwpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5ZG95Luk5rKh5pyJ5omn6KGM77yaJHtTdHJpbmcoZXJyb3IpfWAsICdlcnJvcicsIFtdLCBCQU5ORVJfSE9MRC5FUlJPUik7XG4gICAgICAgIHN0YXRlLmlucHV0LnZhbHVlID0gbGluZTtcbiAgICAgICAgYXV0b0dyb3coc3RhdGUuaW5wdXQpO1xuICAgICAgICBzYXZlRHJhZnQobGluZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHN0YXRlLnNlbmRCdXR0b24pIHN0YXRlLnNlbmRCdXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBwb2xsT25jZShzdGF0ZSk7XG4gICAgICAgIHZvaWQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICB9XG59XG5cbi8qKiDlj5HpgIHjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIHNlbmQoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB0ZXh0ID0gc3RhdGUuaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIC8vIGAv5byA5aS055qE5pW06KGM6L6T5YWl5pivKirlkb3ku6QqKu+8jOS4jeaYr+e7meaooeWei+eahOa2iOaBr++8iOingeacrOiKgumhtumDqOesrCAzIOadoeWPo+W+hO+8ieOAglxuICAgIC8vIOWIpOaNruWPqueci+mmluWtl+iKgiDigJTigJQg5LiOIGBkc2gtY29tbWFuZHNgIOeahCBgcGFyc2VDb21tYW5kYCDkuIDoh7TjgIJcbiAgICBpZiAodGV4dC5zdGFydHNXaXRoKCcvJykgJiYgc3RhdGUuYXR0YWNobWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGF3YWl0IHJ1bkNvbW1hbmRMaW5lKHN0YXRlLCB0ZXh0KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBhdHRhY2htZW50cyA9IHN0YXRlLmF0dGFjaG1lbnRzO1xuICAgIC8vIOWPquacieWbvuayoeacieWtl+S5n+WFgeiuuO+8iOaooeWei+WPqueci+Wbvu+8ie+8m+S4pOagt+mDveepuuaJjeaYr+ayoeW+l+WPkVxuICAgIGlmICghdGV4dCAmJiBhdHRhY2htZW50cy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBpZiAoc3RhdGUuc25hcHNob3Q/LnN0YXR1cyAhPT0gJ3JlYWR5Jykge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICdhZ2VudCDov5jmsqHlsLHnu6rvvIzlhYjnrYnlroPlkK/liqjlrozmiJDjgIInLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuaW1hZ2VCdXN5ID4gMCkge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICflm77niYfov5jlnKjlpITnkIbvvIjop6PnoIEv57yp5pS+77yJ5Lit77yM56iN562J5LiA5LiL5YaN5Y+R44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3RhdGUuaW5wdXQudmFsdWUgPSAnJztcbiAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgc2F2ZURyYWZ0KCcnKTtcbiAgICBpZiAoc3RhdGUuc2VuZEJ1dHRvbikgc3RhdGUuc2VuZEJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9PihNU0cuc2VuZE1lc3NhZ2UsIHtcbiAgICAgICAgICAgIHRleHQsXG4gICAgICAgICAgICAvLyDlj6rmiorljY/orq7pnIDopoHnmoTkuInkuKrlrZfmrrXpgIHlh7rljrvvvIh0aHVtYi93aWR0aC9oZWlnaHQg5piv6Z2i5p2/6Ieq5bex55qE5LqL77yJXG4gICAgICAgICAgICBpbWFnZXM6IGF0dGFjaG1lbnRzLm1hcCgoaXRlbSkgPT4gKHsgbWltZVR5cGU6IGl0ZW0ubWltZVR5cGUsIGRhdGE6IGl0ZW0uZGF0YSwgbmFtZTogaXRlbS5uYW1lIH0pKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVzdWx0Py5vaykge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCByZXN1bHQ/LmVycm9yID8/ICflj5HpgIHlpLHotKUnLCAnZXJyb3InLCBbXSwgQkFOTkVSX0hPTEQuRVJST1IpO1xuICAgICAgICAgICAgLy8g5aSx6LSl5pe2Kirmiorlm77lkozmloflrZfpg73nlZnnnYAqKu+8mueUqOaIt+eahOi+k+WFpeS4jeiDveWboOS4uuS4gOasoee9kee7nC/moKHpqozplJnor6/lsLHmsqHkuoZcbiAgICAgICAgICAgIHJlc3RvcmVEcmFmdChzdGF0ZSwgdGV4dCwgYXR0YWNobWVudHMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBudWxsKTtcbiAgICAgICAgICAgIHJlbWVtYmVyU2VudFRodW1icyhzdGF0ZSwgYXR0YWNobWVudHMpO1xuICAgICAgICAgICAgc3RhdGUuYXR0YWNobWVudHMgPSBbXTtcbiAgICAgICAgICAgIHJlbmRlckF0dGFjaG1lbnRzKHN0YXRlKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOWPkemAgeWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InLCBbXSwgQkFOTkVSX0hPTEQuRVJST1IpO1xuICAgICAgICByZXN0b3JlRHJhZnQoc3RhdGUsIHRleHQsIGF0dGFjaG1lbnRzKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAoc3RhdGUuc2VuZEJ1dHRvbikgc3RhdGUuc2VuZEJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICB2b2lkIHBvbGxPbmNlKHN0YXRlKTtcbiAgICAgICAgLy8g56uL5Yi75Yi35LiA5qyh54q25oCB77yaYHJ1bm5pbmdgIOe/u+ecn+WQjui9ruivouaJjeS8muWIh+WIsCAzMDBtc++8iOa1geW8j+WwseaYr+mdoOWug+mhuui1t+adpeeahO+8iVxuICAgICAgICB2b2lkIHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgfVxufVxuXG4vKiog5Y+R6YCB5aSx6LSl5ZCO5oqK5rKh5Y+R5Ye65Y6755qE5Lic6KW/5pS+5Zue6L6T5YWl5Yy677yI5Y+q5Zyo55So5oi36L+Y5rKh5byA5aeL5omT5paw5YaF5a655pe277yJ44CCICovXG5mdW5jdGlvbiByZXN0b3JlRHJhZnQoc3RhdGU6IFVpU3RhdGUsIHRleHQ6IHN0cmluZywgYXR0YWNobWVudHM6IEF0dGFjaG1lbnRbXSk6IHZvaWQge1xuICAgIGlmICh0ZXh0ICYmICFzdGF0ZS5pbnB1dC52YWx1ZS50cmltKCkpIHtcbiAgICAgICAgc3RhdGUuaW5wdXQudmFsdWUgPSB0ZXh0O1xuICAgICAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgICAgIHNhdmVEcmFmdCh0ZXh0KTtcbiAgICB9XG4gICAgaWYgKGF0dGFjaG1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgc3RhdGUuYXR0YWNobWVudHMgPSBhdHRhY2htZW50cztcbiAgICAgICAgcmVuZGVyQXR0YWNobWVudHMoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqIOiusOS4i+WPkeWHuuWOu+mCo+WHoOW8oOWbvueahOe8qeeVpeWbvu+8iOeUqOaIt+awlOazoemHjOaYvuekuuecn+WbvueUqO+8jOingSBgcmVuZGVyRW50cnlJbWFnZXNg77yJ44CCICovXG5mdW5jdGlvbiByZW1lbWJlclNlbnRUaHVtYnMoc3RhdGU6IFVpU3RhdGUsIGF0dGFjaG1lbnRzOiBBdHRhY2htZW50W10pOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgYXR0YWNobWVudHMpIHtcbiAgICAgICAgc3RhdGUuc2VudFRodW1icy5zZXQoaXRlbS5uYW1lLCBpdGVtLnRodW1iKTtcbiAgICAgICAgd2hpbGUgKHN0YXRlLnNlbnRUaHVtYnMuc2l6ZSA+IDEyKSB7XG4gICAgICAgICAgICBjb25zdCBvbGRlc3QgPSBzdGF0ZS5zZW50VGh1bWJzLmtleXMoKS5uZXh0KCk7XG4gICAgICAgICAgICBpZiAob2xkZXN0LmRvbmUpIGJyZWFrO1xuICAgICAgICAgICAgc3RhdGUuc2VudFRodW1icy5kZWxldGUob2xkZXN0LnZhbHVlKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqIOi+k+WFpeahhuaMieWGheWuuemVv+mrmO+8iOacgOWkmiA4IOihjO+8jOWGjeWkmuWwsea7mu+8ieOAgiAqL1xuZnVuY3Rpb24gYXV0b0dyb3coaW5wdXQ6IEhUTUxUZXh0QXJlYUVsZW1lbnQpOiB2b2lkIHtcbiAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSAnYXV0byc7XG4gICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gYCR7TWF0aC5taW4oaW5wdXQuc2Nyb2xsSGVpZ2h0LCAxNjgpfXB4YDtcbn1cblxuLyoqIOiNieeov+ivu+WGme+8iOmdouadv+WFs+aOieWGjeW8gOS4jeS4ou+8ieOAgiAqL1xuZnVuY3Rpb24gc2F2ZURyYWZ0KHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0ZXh0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEUkFGVF9LRVksIHRleHQpO1xuICAgICAgICBlbHNlIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKERSQUZUX0tFWSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOmakOengeaooeW8jy/ooqvnpoHlsLHmsqHojYnnqL/vvIzkuI3lvbHlk43nlKggKi9cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvYWREcmFmdCgpOiBzdHJpbmcge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEUkFGVF9LRVkpID8/ICcnO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gJyc7XG4gICAgfVxufVxuXG4vKiog5aSW6KeC5oyJ6ZKu77yaYXV0byDihpIgZGFyayDihpIgbGlnaHQg5b6q546v44CCICovXG5hc3luYyBmdW5jdGlvbiBjeWNsZVRoZW1lKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY3VycmVudCA9IHN0YXRlLnNldHRpbmdzPy50aGVtZSA/PyAnYXV0byc7XG4gICAgY29uc3QgbmV4dCA9IFRIRU1FX0NZQ0xFWyhUSEVNRV9DWUNMRS5pbmRleE9mKGN1cnJlbnQpICsgMSkgJSBUSEVNRV9DWUNMRS5sZW5ndGhdO1xuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBzZXR0aW5ncz86IERzaENoYXRTZXR0aW5ncyB9PihNU0cudXBkYXRlU2V0dGluZ3MsIHsgdGhlbWU6IG5leHQgfSk7XG4gICAgaWYgKHNhdmVkPy5zZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzYXZlZC5zZXR0aW5ncztcbiAgICBhcHBseUFwcGVhcmFuY2Uoc3RhdGUpO1xuICAgIHVwZGF0ZVRoZW1lQnV0dG9uKHN0YXRlKTtcbn1cblxuLyoqIOWkluinguaMiemSrueahOWbvuaghy/mj5DnpLrot5/nnYDlvZPliY3moaPkvY3otbDjgIIgKi9cbmZ1bmN0aW9uIHVwZGF0ZVRoZW1lQnV0dG9uKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgYnV0dG9uID0gc3RhdGUucm9vdD8ucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJyNidG4tdGhlbWUnKTtcbiAgICBpZiAoIWJ1dHRvbikgcmV0dXJuO1xuICAgIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncz8udGhlbWUgPz8gJ2F1dG8nO1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IFRIRU1FX0dMWVBIW21vZGVdO1xuICAgIGJ1dHRvbi50aXRsZSA9IGDlpJbop4LvvJoke1RIRU1FX0xBQkVMW21vZGVdfe+8iOeCueWHu+WIh+aNou+8iWA7XG59XG5cbi8qKiDorr7nva7pnaLmnb/vvIjlsLHlnLDnvJbovpEgKyDkv53lrZjvvInjgIIgKi9cbmZ1bmN0aW9uIHRvZ2dsZVNldHRpbmdzKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IHN0YXRlLnNldHRpbmdzSG9zdDtcbiAgICBpZiAoIWhvc3QpIHtcbiAgICAgICAgY29uc29sZS53YXJuKCdbZHNoX2NoYXRdIOmdouadv+mHjOaJvuS4jeWIsOiuvue9ruWuueWZqCAjc2V0dGluZ3PvvIjpgInmi6nlmajmsqHop6PmnpDlh7rmnaXvvJ/vvIknKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5zZXR0aW5nc09wZW4gPSAhc3RhdGUuc2V0dGluZ3NPcGVuO1xuICAgIGhvc3QuaGlkZGVuID0gIXN0YXRlLnNldHRpbmdzT3BlbjtcbiAgICBpZiAoIXN0YXRlLnNldHRpbmdzT3BlbikgcmV0dXJuO1xuXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBzdGF0ZS5zZXR0aW5ncztcbiAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG4gICAgaWYgKCFzZXR0aW5ncykge1xuICAgICAgICBob3N0LnRleHRDb250ZW50ID0gJ+i/mOayoeivu+WIsOiuvue9ru+8jOeojeWQjuWGjeivleOAgic7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBkcmFmdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLnNldHRpbmdzIH07XG5cbiAgICAvKiog5LiA5Liq5paH5pysL+aVsOWtl+i+k+WFpeihjOOAgiAqL1xuICAgIGNvbnN0IGFkZElucHV0ID0gKGdyb3VwOiBzdHJpbmcgfCBudWxsLCBrZXk6IGtleW9mIERzaENoYXRTZXR0aW5ncywgbGFiZWw6IHN0cmluZywgdHlwZTogJ3RleHQnIHwgJ251bWJlcicpOiB2b2lkID0+IHtcbiAgICAgICAgaWYgKGdyb3VwKSBob3N0LmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXNldHRpbmdzLWdyb3VwJywgZ3JvdXApKTtcbiAgICAgICAgY29uc3Qgcm93ID0gZWwoJ2RpdicsICdkc2gtZmllbGQnKTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGVsKCdsYWJlbCcsIHVuZGVmaW5lZCwgbGFiZWwpKTtcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbCgnaW5wdXQnKTtcbiAgICAgICAgaW5wdXQudHlwZSA9IHR5cGU7XG4gICAgICAgIGlucHV0LnZhbHVlID0gU3RyaW5nKHNldHRpbmdzW2tleV0gPz8gJycpO1xuICAgICAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgICAgICAgIGRyYWZ0W2tleSBhcyBzdHJpbmddID0gdHlwZSA9PT0gJ251bWJlcicgPyBOdW1iZXIoaW5wdXQudmFsdWUpIDogaW5wdXQudmFsdWU7XG4gICAgICAgIH0pO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICAgICAgICBob3N0LmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfTtcblxuICAgIC8qKiDkuIDkuKrkuIvmi4nooYzjgIIgKi9cbiAgICBjb25zdCBhZGRTZWxlY3QgPSAoa2V5OiBrZXlvZiBEc2hDaGF0U2V0dGluZ3MsIGxhYmVsOiBzdHJpbmcsIG9wdGlvbnM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KTogdm9pZCA9PiB7XG4gICAgICAgIGNvbnN0IHJvdyA9IGVsKCdkaXYnLCAnZHNoLWZpZWxkJyk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChlbCgnbGFiZWwnLCB1bmRlZmluZWQsIGxhYmVsKSk7XG4gICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsKCdzZWxlY3QnKTtcbiAgICAgICAgZm9yIChjb25zdCBbdmFsdWUsIHRleHRdIG9mIG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IGVsKCdvcHRpb24nLCB1bmRlZmluZWQsIHRleHQpO1xuICAgICAgICAgICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICAgICAgfVxuICAgICAgICBzZWxlY3QudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Nba2V5XSA/PyAnJyk7XG4gICAgICAgIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBkcmFmdFtrZXkgYXMgc3RyaW5nXSA9IHNlbGVjdC52YWx1ZTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChzZWxlY3QpO1xuICAgICAgICBob3N0LmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfTtcblxuICAgIC8qKiDkuIDkuKrli77pgInooYzjgIIgKi9cbiAgICBjb25zdCBhZGRDaGVja2JveCA9IChrZXk6IGtleW9mIERzaENoYXRTZXR0aW5ncywgbGFiZWw6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCByb3cgPSBlbCgnZGl2JywgJ2RzaC1maWVsZCcpO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoZWwoJ2xhYmVsJywgdW5kZWZpbmVkLCBsYWJlbCkpO1xuICAgICAgICBjb25zdCBpbnB1dCA9IGVsKCdpbnB1dCcpO1xuICAgICAgICBpbnB1dC50eXBlID0gJ2NoZWNrYm94JztcbiAgICAgICAgaW5wdXQuY2hlY2tlZCA9IEJvb2xlYW4oc2V0dGluZ3Nba2V5XSk7XG4gICAgICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGRyYWZ0W2tleSBhcyBzdHJpbmddID0gaW5wdXQuY2hlY2tlZDtcbiAgICAgICAgfSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChpbnB1dCk7XG4gICAgICAgIGhvc3QuYXBwZW5kQ2hpbGQocm93KTtcbiAgICB9O1xuXG4gICAgaG9zdC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1zZXR0aW5ncy1ncm91cCcsICflpJbop4InKSk7XG4gICAgYWRkU2VsZWN0KCd0aGVtZScsICfkuLvpopgnLCBbXG4gICAgICAgIFsnYXV0bycsICfot5/pmo/nvJbovpHlmagnXSxcbiAgICAgICAgWydkYXJrJywgJ+a3seiJsiddLFxuICAgICAgICBbJ2xpZ2h0JywgJ+a1heiJsiddLFxuICAgIF0pO1xuICAgIC8vIOmFjeiJsuS4juaYjuaalyoq5q2j5LqkKirvvJrmmI7mmpfnrqEgZGF0YS10aGVtZe+8jOmFjeiJsueuoSBkYXRhLXBhbGV0dGXvvIjopobnm5blsYLop4EgZWRpdG9yLXRoZW1lLmNzc++8iVxuICAgIGFkZFNlbGVjdCgncGFsZXR0ZScsICfphY3oibInLCBbXG4gICAgICAgIFsnZHN3JywgJ0RTSCDpu5jorqQnXSxcbiAgICAgICAgWydlZGl0b3InLCAn6Lef6ZqPIENvY29zIOe8lui+keWZqO+8iOa3seiJsu+8iSddLFxuICAgIF0pO1xuICAgIGFkZFNlbGVjdCgnZm9udFNpemUnLCAn5q2j5paH5a2X5Y+3JywgW1xuICAgICAgICBbJzAnLCAn6buY6K6k77yIMTRweO+8iSddLFxuICAgICAgICBbJzEyJywgJzEycHgnXSxcbiAgICAgICAgWycxMycsICcxM3B4J10sXG4gICAgICAgIFsnMTQnLCAnMTRweCddLFxuICAgICAgICBbJzE1JywgJzE1cHgnXSxcbiAgICAgICAgWycxNicsICcxNnB4J10sXG4gICAgICAgIFsnMTcnLCAnMTdweCddLFxuICAgIF0pO1xuXG4gICAgaG9zdC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1zZXR0aW5ncy1ncm91cCcsICfmqKHlnosnKSk7XG4gICAgYWRkSW5wdXQobnVsbCwgJ3Byb3ZpZGVyJywgJ3Byb3ZpZGVyJywgJ3RleHQnKTtcbiAgICBhZGRJbnB1dChudWxsLCAnbW9kZWwnLCAnbW9kZWwnLCAndGV4dCcpO1xuICAgIGFkZElucHV0KG51bGwsICdyZWFzb25pbmdFZmZvcnQnLCAn5o6o55CG5qGj5L2NJywgJ3RleHQnKTtcbiAgICBhZGRJbnB1dChudWxsLCAnbWF4VG9rZW5zJywgJ21heFRva2VucycsICdudW1iZXInKTtcblxuICAgIGhvc3QuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtc2V0dGluZ3MtZ3JvdXAnLCAn6L+Q6KGM5pe2JykpO1xuICAgIGFkZElucHV0KG51bGwsICd3b3JrZGlyJywgJ+W3peS9nOebruW9lScsICd0ZXh0Jyk7XG4gICAgYWRkSW5wdXQobnVsbCwgJ25vZGVQYXRoJywgJ25vZGUg6Lev5b6EJywgJ3RleHQnKTtcbiAgICBhZGRJbnB1dChudWxsLCAnZHNoQmluJywgJ2RzaCBiaW4uanMnLCAndGV4dCcpO1xuICAgIGFkZENoZWNrYm94KCdhdXRvU3RhcnQnLCAn6Ieq5Yqo5ZCv5YqoJyk7XG4gICAgYWRkQ2hlY2tib3goJ3Nob3dTdGRlcnJOb3RlcycsICfmmL7npLogc3RkZXJyJyk7XG5cbiAgICBjb25zdCBoaW50ID0gZWwoJ2RpdicsICdkc2gtaGludCcpO1xuICAgIGhpbnQudGV4dENvbnRlbnQgPVxuICAgICAgICAn55WZ56m6ID0g6Ieq5Yqo5o6i5rWL77yIbm9kZSDotbAgUEFUSO+8jGRzaCDku44gUEFUSCDkuIrnmoQgZHNoL25wbSDmjqjlr7zvvInjgILmlLnlrozngrnkv53lrZjvvJsnICtcbiAgICAgICAgJ25vZGUvZHNoIOi3r+W+hOaUueS6huS8mueri+WNs+mHjeaWsOaOoua1i++8iOato+WcqOi3keeahCBhZ2VudCDkuI3lj5flvbHlk43vvIzph43lkK/lkI7nlJ/mlYjvvInjgIInO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQoaGludCk7XG5cbiAgICBjb25zdCBhY3Rpb25zID0gZWwoJ2RpdicsICdkc2gtYmFubmVyLWFjdGlvbnMnKTtcbiAgICBjb25zdCBzYXZlID0gZWwoJ2J1dHRvbicsICdkc2gtYnRuJywgJ+S/neWtmCcpO1xuICAgIHNhdmUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBzZXR0aW5ncz86IERzaENoYXRTZXR0aW5ncyB9PihNU0cudXBkYXRlU2V0dGluZ3MsIGRyYWZ0KTtcbiAgICAgICAgaWYgKHNhdmVkPy5zZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzYXZlZC5zZXR0aW5ncztcbiAgICAgICAgYXBwbHlBcHBlYXJhbmNlKHN0YXRlKTtcbiAgICAgICAgdXBkYXRlVGhlbWVCdXR0b24oc3RhdGUpO1xuICAgICAgICBzdGF0ZS5zZXR0aW5nc09wZW4gPSBmYWxzZTtcbiAgICAgICAgaG9zdC5oaWRkZW4gPSB0cnVlO1xuICAgICAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xuICAgICAgICB0b2dnbGVTZXR0aW5ncyhzdGF0ZSk7XG4gICAgfSk7XG4gICAgY29uc3QgcmVwYWlyID0gZWwoJ2J1dHRvbicsICdkc2gtYnRuJywgJ+S/ruWkjSBwcm9maWxlJyk7XG4gICAgcmVwYWlyLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCByZXBhaXJQcm9maWxlKHN0YXRlKSk7XG4gICAgY29uc3QgY2xvc2UgPSBlbCgnYnV0dG9uJywgJ2RzaC1idG4nLCAn5YWz6ZetJyk7XG4gICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0b2dnbGVTZXR0aW5ncyhzdGF0ZSkpO1xuICAgIGFjdGlvbnMuYXBwZW5kKHNhdmUsIHJlcGFpciwgY2xvc2UpO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5oyC6L29XG5cbi8qKiDnu4Too4XpnaLmnb/nmoTkuqTkupLvvIjmr4/kuKrpnaLmnb/lrp7kvovkuIDmrKHvvInjgIIgKi9cbmZ1bmN0aW9uIG1vdW50KGN0eDogYW55KTogVWlTdGF0ZSB7XG4gICAgY29uc3QgJCA9IGN0eC4kID8/IHt9O1xuXG4gICAgLy8g6Z2i5p2/5qC56IqC54K577ya5ou/5Yiw5a6D5bCx6IO95Zyo6YeM6Z2i5oyJ6YCJ5oup5Zmo6KGl5p+l77yI6KeB5LiL6Z2iIHBpY2sg55qE6K+05piO77yJ44CCXG4gICAgY29uc3Qgcm9vdDogSFRNTEVsZW1lbnQgfCBudWxsID1cbiAgICAgICAgKCQucm9vdCBhcyBIVE1MRWxlbWVudCkgPz9cbiAgICAgICAgKCQuYm9keSBhcyBIVE1MRWxlbWVudCk/LmNsb3Nlc3Q/LignLmRzaC1yb290JykgPz9cbiAgICAgICAgKCQuYm9keSBhcyBIVE1MRWxlbWVudCk/LnBhcmVudEVsZW1lbnQgPz9cbiAgICAgICAgbnVsbDtcblxuICAgIC8qKlxuICAgICAqIOWPluWFg+e0oO+8muWFiOS/oee8lui+keWZqOe7meeahCBgJGDvvIzmi7/kuI3liLDlho0qKuWcqOmdouadv+agueiKgueCuemHjOaMieWQjOS4gOS4qumAieaLqeWZqOafpeS4gOasoSoq44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjopoHov5npgZPlhZzlupXvvJpgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWRgIOWcqOi/meS4queOr+Wig+mHjOaLv+S4jeWIsOmdouadv+WFg+e0oO+8iOWunua1i++8ie+8jFxuICAgICAqIOivtOaYjumdouadvyBET00g5LiN5LiA5a6a5oyC5Zyo5qih5Z2X5omA5aSE55qE6YKj5LiqIGRvY3VtZW50IOS4iu+8m+iAjCBgJGAg5YG25bCU5ryP5LiA5Liq6ZSu5pe277yMXG4gICAgICog5LuO5qC56IqC54K5IHNjb3BlIOafpeivouS7jeeEtuiDveWRveS4reOAguS4pOmBk+mDveS4jeihjOWwsei/lOWbniBudWxs77yM55Sx6LCD55So5pa56ZmN57qn77yI5Y+qIHdhcm4g5LiN5oqb77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgcGljayA9IChrZXk6IHN0cmluZyk6IEhUTUxFbGVtZW50IHwgbnVsbCA9PiB7XG4gICAgICAgIGNvbnN0IGRpcmVjdCA9ICRba2V5XSBhcyBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKGRpcmVjdCkgcmV0dXJuIGRpcmVjdDtcbiAgICAgICAgY29uc3Qgc2VsZWN0b3IgPSBTRUxFQ1RPUlNba2V5XTtcbiAgICAgICAgaWYgKCFzZWxlY3RvciB8fCAhcm9vdCkgcmV0dXJuIG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gcm9vdC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihzZWxlY3Rvcik7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgbWlzc2luZyA9IE9iamVjdC5rZXlzKFNFTEVDVE9SUykuZmlsdGVyKChrZXkpID0+ICFwaWNrKGtleSkpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8g5Y+qIHdhcm4g5LiN5oqb77ya6Z2i5p2/5bCR5Liq5YWD57Sg5Lmf6KaB6IO95byA77yM5ZCm5YiZ55So5oi35Zyo57yW6L6R5Zmo6YeM5Y+q55yL5Yiw5LiA5p2h57qi6ZSZ44CCXG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICAgIGBbZHNoX2NoYXRdIOmdouadv+mHjOayoeaJvuWIsOi/meS6m+WFg+e0oO+8miR7bWlzc2luZy5qb2luKCcsICcpfe+8iOWvueW6lOmAieaLqeWZqCAke21pc3NpbmdcbiAgICAgICAgICAgICAgICAubWFwKChrKSA9PiBTRUxFQ1RPUlNba10pXG4gICAgICAgICAgICAgICAgLmpvaW4oJywgJyl977yJYCxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGF0ZTogVWlTdGF0ZSA9IHtcbiAgICAgICAgcm9vdCxcbiAgICAgICAgZG90OiBwaWNrKCdkb3QnKSxcbiAgICAgICAgdGl0bGU6IHBpY2soJ3RpdGxlJyksXG4gICAgICAgIHN1YjogcGljaygnc3ViJyksXG4gICAgICAgIGJhbm5lcjogcGljaygnYmFubmVyJyksXG4gICAgICAgIHNldHRpbmdzSG9zdDogcGljaygnc2V0dGluZ3MnKSxcbiAgICAgICAgYm9keTogcGljaygnYm9keScpIGFzIEhUTUxFbGVtZW50LFxuICAgICAgICBpbnB1dDogcGljaygnaW5wdXQnKSBhcyBIVE1MVGV4dEFyZWFFbGVtZW50LFxuICAgICAgICBzZW5kQnV0dG9uOiBwaWNrKCdidG5TZW5kJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsLFxuICAgICAgICBsaXZlOiBwaWNrKCdsaXZlJyksXG4gICAgICAgIG1ldGE6IHBpY2soJ21ldGEnKSxcbiAgICAgICAgaGlzdG9yeUJhcjogcGljaygnaGlzdG9yeUJhcicpLFxuICAgICAgICBoaXN0b3J5QmFyVGV4dDogcGljaygnaGlzdG9yeUJhclRleHQnKSxcbiAgICAgICAgaGlzdG9yeTogcGljaygnaGlzdG9yeScpLFxuICAgICAgICBoaXN0b3J5TGlzdDogcGljaygnaGlzdG9yeUxpc3QnKSxcbiAgICAgICAgaGlzdG9yeU5vdGU6IHBpY2soJ2hpc3RvcnlOb3RlJyksXG4gICAgICAgIGhpc3RvcnlTZWFyY2hFbDogcGljaygnaGlzdG9yeVNlYXJjaCcpIGFzIEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsLFxuICAgICAgICBidG5IaXN0b3J5U2VhcmNoOiBwaWNrKCdidG5IaXN0b3J5U2VhcmNoJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsLFxuICAgICAgICBidG5IaXN0b3J5QmFjazogcGljaygnYnRuSGlzdG9yeUJhY2snKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgICAgIGJ0bkhpc3RvcnlSZWZyZXNoRWw6IHBpY2soJ2J0bkhpc3RvcnlSZWZyZXNoJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsLFxuICAgICAgICByZXN1bWVCdXR0b246IHBpY2soJ2J0blJlc3VtZScpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCxcbiAgICAgICAgdXNhZ2VPcGVuOiBmYWxzZSxcbiAgICAgICAgdXNhZ2VIb3N0OiBwaWNrKCd1c2FnZScpLFxuICAgICAgICB1c2FnZUJvZHk6IHBpY2soJ3VzYWdlQm9keScpLFxuICAgICAgICB1c2FnZU5vdGVFbDogcGljaygndXNhZ2VOb3RlJyksXG4gICAgICAgIHVzYWdlQ2hpcDogcGljaygnYnRuVXNhZ2UnKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgICAgIGJ0blVzYWdlUmVmcmVzaEVsOiBwaWNrKCdidG5Vc2FnZVJlZnJlc2gnKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgICAgIHVzYWdlQnVzeTogZmFsc2UsXG4gICAgLy8gLS0tLSDov5vluqbvvIjlvoXlip7muIXljZUgLyDnm67moIcgLyDlm57lkIjnm67lvZXvvIktLS0tXG4gICAgcHJvZ3Jlc3NPcGVuOiBmYWxzZSxcbiAgICBwcm9ncmVzc0hvc3Q6IHBpY2soJ3Byb2dyZXNzJyksXG4gICAgcHJvZ3Jlc3NCb2R5OiBwaWNrKCdwcm9ncmVzc0JvZHknKSxcbiAgICBwcm9ncmVzc05vdGVFbDogcGljaygncHJvZ3Jlc3NOb3RlJyksXG4gICAgcHJvZ3Jlc3NDaGlwOiBwaWNrKCdidG5Qcm9ncmVzcycpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCxcbiAgICBidG5Qcm9ncmVzc1JlZnJlc2hFbDogcGljaygnYnRuUHJvZ3Jlc3NSZWZyZXNoJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsLFxuICAgIC8vIC0tLS0g5rS75Yqo77yI5ZCO5Y+w5Lu75YqhIC8g5a2QIGFnZW5077yJLS0tLVxuICAgIGFjdGl2aXR5T3BlbjogZmFsc2UsXG4gICAgYWN0aXZpdHlIb3N0OiBwaWNrKCdhY3Rpdml0eScpLFxuICAgIGFjdGl2aXR5Qm9keTogcGljaygnYWN0aXZpdHlCb2R5JyksXG4gICAgYWN0aXZpdHlOb3RlRWw6IHBpY2soJ2FjdGl2aXR5Tm90ZScpLFxuICAgIGFjdGl2aXR5Q2hpcDogcGljaygnYnRuQWN0aXZpdHknKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgYnRuQWN0aXZpdHlSZWZyZXNoRWw6IHBpY2soJ2J0bkFjdGl2aXR5UmVmcmVzaCcpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCxcbiAgICAvLyDpnaLmnb/oh6rlt7HmjIHmnInvvIgqKuS4jeWcqCBBZ2VudFNuYXBzaG90IOmHjCoq77ya6L+Z5Lik5Z2X6KaB5LiT6Zeo5omT5o6n5Yi25bin5Y676Zeu77yM6KeBIFVpU3RhdGUg55qE5rOo6YeK77yJXG4gICAgYWN0aXZpdHk6IG51bGwsXG4gICAgYWN0aXZpdHlBdDogMCxcbiAgICBhY3Rpdml0eUJ1c3k6IGZhbHNlLFxuICAgIGFjdGl2aXR5Tm90ZTogbnVsbCxcbiAgICAgICAgaGlzdG9yeVF1ZXJ5OiAnJyxcbiAgICAgICAgaGlzdG9yeVNlc3Npb25zOiBbXSxcbiAgICAgICAgaGlzdG9yeVNlYXJjaDogbnVsbCxcbiAgICAgICAgaGlzdG9yeUJ1c3k6IGZhbHNlLFxuICAgICAgICBoaXN0b3J5Q29uZmlybTogbnVsbCxcbiAgICAgICAganVtcFRvOiBudWxsLFxuICAgICAgICBqdW1wVGltZXI6IG51bGwsXG4gICAgICAgIGVsczogbmV3IE1hcCgpLFxuICAgICAgICBlbnRyaWVzOiBuZXcgTWFwKCksXG4gICAgICAgIG9wZW5Ub29sczogbmV3IE1hcCgpLFxuICAgICAgICBjb2xsYXBzZWRUaGluazogbmV3IE1hcCgpLFxuICAgICAgICBtYXhSZXY6IDAsXG4gICAgICAgIG1heFNlcTogMCxcbiAgICAgICAgZ2VuZXJhdGlvbjogMCxcbiAgICAgICAgdGljazogMCxcbiAgICAgICAgdGltZXI6IG51bGwsXG4gICAgICAgIHBvbGxpbmc6IGZhbHNlLFxuICAgICAgICByZXBvcnRlZFJlc3VtZTogZmFsc2UsXG4gICAgICAgIGludGVycnVwdGluZzogZmFsc2UsXG4gICAgICAgIHNuYXBzaG90OiBudWxsLFxuICAgICAgICBzZXR0aW5nczogbnVsbCxcbiAgICAgICAgc2V0dGluZ3NPcGVuOiBmYWxzZSxcbiAgICAgICAgaGlzdG9yeU9wZW46IGZhbHNlLFxuICAgICAgICBzdGFydFJlcXVlc3RlZDogZmFsc2UsXG4gICAgICAgIGJhbm5lclVudGlsOiAwLFxuICAgICAgICBlbXB0eUVsOiBudWxsLFxuICAgICAgICB0eXBpbmdFbDogbnVsbCxcbiAgICAgICAgbGFzdFVzZXJTZXE6IDAsXG4gICAgICAgIGJyb2FkY2FzdEhhbmRsZXI6IG51bGwsXG4gICAgICAgIGludGVyYWN0aW9uSG9zdDogcGljaygnaW50ZXJhY3Rpb24nKSxcbiAgICAgICAgaW50ZXJhY3Rpb25zOiBbXSxcbiAgICAgICAgaW50ZXJhY3Rpb25TZW50OiBuZXcgU2V0KCksXG4gICAgICAgIGludGVyYWN0aW9uU2lnOiAnJyxcbiAgICAgICAgcG9wdXA6IHBpY2soJ3BvcHVwJyksXG4gICAgICAgIHBvcHVwS2luZDogbnVsbCxcbiAgICAgICAgcG9wdXBJdGVtczogW10sXG4gICAgICAgIHBvcHVwSW5kZXg6IDAsXG4gICAgICAgIGNvbW1hbmRzOiBudWxsLFxuICAgICAgICBtZW50aW9uQ2FjaGU6IG5ldyBNYXAoKSxcbiAgICAgICAgbWVudGlvblNlcTogMCxcbiAgICAgICAgYXR0YWNobWVudHM6IFtdLFxuICAgICAgICBhdHRhY2hIb3N0OiBwaWNrKCdhdHRhY2htZW50cycpLFxuICAgICAgICBpbWFnZUJ1dHRvbjogcGljaygnYnRuSW1hZ2UnKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgICAgIGltYWdlQnVzeTogMCxcbiAgICAgICAgcGlja2VyOiBwaWNrKCdwaWNrZXInKSxcbiAgICAgICAgcGlja2VyTGlzdDogcGljaygncGlja2VyTGlzdCcpLFxuICAgICAgICBwaWNrZXJOb3RlOiBwaWNrKCdwaWNrZXJOb3RlJyksXG4gICAgICAgIHBpY2tlclNlYXJjaDogcGljaygncGlja2VyU2VhcmNoJykgYXMgSFRNTElucHV0RWxlbWVudCB8IG51bGwsXG4gICAgICAgIHBpY2tlck9wZW46IGZhbHNlLFxuICAgICAgICBwaWNrZXJJbWFnZXM6IG51bGwsXG4gICAgICAgIHBpY2tlclNvdXJjZTogJycsXG4gICAgICAgIHBpY2tlclF1ZXJ5OiAnJyxcbiAgICAgICAgcGlja2VyVGh1bWJzOiBuZXcgTWFwKCksXG4gICAgICAgIHBpY2tlckZhaWxlZDogbmV3IFNldCgpLFxuICAgICAgICBwaWNrZXJMb2FkaW5nOiBuZXcgU2V0KCksXG4gICAgICAgIHBpY2tlclF1ZXVlOiBbXSxcbiAgICAgICAgcGlja2VyT2JzZXJ2ZXI6IG51bGwsXG4gICAgICAgIHNlbnRUaHVtYnM6IG5ldyBNYXAoKSxcbiAgICB9O1xuXG4gICAgaWYgKCFzdGF0ZS5ib2R5IHx8ICFzdGF0ZS5pbnB1dCkge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1tkc2hfY2hhdF0g6Z2i5p2/57y65bCRICNib2R5IOaIliAjaW5wdXTvvIxVSSDml6Dms5Xlt6XkvZzvvIjor7fmo4Dmn6Ugc3RhdGljL3RlbXBsYXRlL2RlZmF1bHQvaW5kZXguaHRtbO+8iScpO1xuICAgICAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdmYXRhbCcsIG1pc3NpbmcsIGhhc0JvZHk6IEJvb2xlYW4oc3RhdGUuYm9keSksIGhhc0lucHV0OiBCb29sZWFuKHN0YXRlLmlucHV0KSB9KTtcbiAgICAgICAgcmV0dXJuIHN0YXRlO1xuICAgIH1cblxuICAgIC8vIOS4u+mimOWFiOaMieOAjOi3n+maj+ezu+e7n+OAjeeUu+S4iu+8jOmBv+WFjeS4gOi/m+adpeaYr+eZveW6leWGjei3s+aIkOm7keW6lVxuICAgIGFwcGx5QXBwZWFyYW5jZShzdGF0ZSk7XG4gICAgdXBkYXRlVGhlbWVCdXR0b24oc3RhdGUpO1xuXG4gICAgLy8g5biD5bGA6Ieq5qOA77yI57uT5p6c5Zue5Lyg5Li76L+b56iL77yM6Z2i5p2/6auY5bqm5aGM5LqG5Lmf6L+Y6IO95oql5LiK5p2l77yJXG4gICAgY29uc3QgbGF5b3V0ID0gZW5zdXJlTGF5b3V0KHN0YXRlKTtcbiAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdyZWFkeScsIG1pc3NpbmcsIGxheW91dCB9KTtcblxuICAgIHJlbmRlckVtcHR5KHN0YXRlLCAnbm8tYWdlbnQnKTtcblxuICAgIC8vIOiNieeov+WbnuWhq1xuICAgIGNvbnN0IGRyYWZ0ID0gbG9hZERyYWZ0KCk7XG4gICAgaWYgKGRyYWZ0KSB7XG4gICAgICAgIHN0YXRlLmlucHV0LnZhbHVlID0gZHJhZnQ7XG4gICAgICAgIGF1dG9Hcm93KHN0YXRlLmlucHV0KTtcbiAgICB9XG5cbiAgICBzdGF0ZS5zZW5kQnV0dG9uPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgc2VuZChzdGF0ZSkpO1xuICAgIHN0YXRlLmlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgICAgIHNhdmVEcmFmdChzdGF0ZS5pbnB1dC52YWx1ZSk7XG4gICAgICAgIC8vIOi+k+WFpeinpuWPkeWZqO+8iGAvYCDlkb3ku6Qg5LiOIGBAYCDot6/lvoTvvInvvJrmr4/mlbLkuIDkuKrlrZfnrKbph43nrpfkuIDmrKHjgIJcbiAgICAgICAgLy8g6L+Z6YeM5pivKirllK/kuIAqKuinpuWPkeeCuSDigJTigJQg5YWJ5qCH56e75YqoIC8g54K55Ye75LiN6K+l6YeN5byA6I+c5Y2V77yI6YKj5Lya5oqK5pa55ZCR6ZSu5oqi6LWw77yJ44CCXG4gICAgICAgIHJlZnJlc2hQb3B1cChzdGF0ZSk7XG4gICAgfSk7XG4gICAgc3RhdGUuaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudDogS2V5Ym9hcmRFdmVudCkgPT4ge1xuICAgICAgICAvLyDlvLnlh7rlnZfkvJjlhYjlkIPplK7vvIjihpHihpMg6YCJIC8gRW50ZXLCt1RhYiDorqQgLyBFc2Mg5YWz77yJ4oCU4oCUXG4gICAgICAgIC8vIOWQpuWImSBFbnRlciDkvJrooqvkuIvpnaLnmoTjgIzlj5HpgIHjgI3miqLotbDvvIzlgJnpgInmsLjov5zpgInkuI3kuIrjgIJcbiAgICAgICAgaWYgKGhhbmRsZVBvcHVwS2V5KHN0YXRlLCBldmVudCkpIHJldHVybjtcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJyAmJiAhZXZlbnQuc2hpZnRLZXkgJiYgIWV2ZW50LmlzQ29tcG9zaW5nKSB7XG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgdm9pZCBzZW5kKHN0YXRlKTtcbiAgICAgICAgfVxuICAgIH0pO1xuICAgIC8qKlxuICAgICAqIOWkseeEpuaXtuaUtuaOieiPnOWNleOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB5pS277ya5by55Ye65Z2XKirkuI3mmK/mta7lsYIqKu+8iOWug+WNoOedgOWvueivneWMuuS4iuaWueeahOS4gOWdl+eJiOmdou+8ie+8jOi+k+WFpeahhuS4jeWcqOeEpueCueS4iuaXtlxuICAgICAqIOmCo+S4gOWdl+WwseaYr+eZveWNoOWcsOaWueOAgueCueWAmemAiei1sOeahOaYryBgbW91c2Vkb3duYO+8iOaKouWcqOWkseeEpuWJjemdou+8ie+8jOaJgOS7pei/meadoeS4jeS8muaJk+aWremAieaLqeOAglxuICAgICAqL1xuICAgIHN0YXRlLmlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiBjbG9zZVBvcHVwKHN0YXRlKSk7XG5cbiAgICAvKipcbiAgICAgKiDnspjotLTvvJoqKuWPquiupOWbvioq44CCXG4gICAgICpcbiAgICAgKiBgcHJldmVudERlZmF1bHQoKWAg5Y+q5Zyo44CM5Ymq6LS05p2/6YeM56Gu5a6e5pyJ5Zu+44CN5pe25omN6LCDIOKAlOKAlCDlkKbliJnnspjotLTkuIDmrrXmloflrZfkvJrooqvmiJHku6zlkIPmjonvvIxcbiAgICAgKiDogIzpgqPmmK/ov5nkuKrovpPlhaXmoYbmnIDluLjnlKjnmoTmk43kvZzjgILnm5HlkKzmjILlnKgqKumdouadv+agueiKgueCuSoq5LiK77yI5LiN5Y+q5pivIHRleHRhcmVh77yJ77yaXG4gICAgICog54Sm54K55Zyo6L6T5YWl5qGG6YeM5piv5bi45oCB77yM5L2G5Yia54K55a6M5Zu+54mH6YCJ5oup5Zmo5pe254Sm54K55Y+v6IO95Zyo5Yir5aSE77yM6YKj5pe2IEN0cmwrViDkuZ/or6Xog73nlKjjgIJcbiAgICAgKiDkuovku7blhpLms6HliLDmoLnoioLngrnljbPlj6/vvIzmiYDku6Xlj6rmjILkuIDlpITjgIJcbiAgICAgKi9cbiAgICBjb25zdCBvblBhc3RlID0gKGV2ZW50OiBDbGlwYm9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCBpbWFnZXMgPSBpbWFnZXNGcm9tQ2xpcGJvYXJkKGV2ZW50LmNsaXBib2FyZERhdGEpO1xuICAgICAgICBpZiAoaW1hZ2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgcmVwb3J0UHJvYmUoeyBraW5kOiAncGFzdGUnLCBpbWFnZXM6IGltYWdlcy5sZW5ndGgsIHR5cGVzOiBpbWFnZXMubWFwKChpdGVtKSA9PiBpdGVtLmJsb2IudHlwZSkgfSk7XG4gICAgICAgIHZvaWQgYXR0YWNoQmxvYnMoc3RhdGUsIGltYWdlcywgJ2NsaXBib2FyZCcpO1xuICAgIH07XG4gICAgKHJvb3QgPz8gc3RhdGUuYm9keSkuYWRkRXZlbnRMaXN0ZW5lcigncGFzdGUnLCBvblBhc3RlIGFzIEV2ZW50TGlzdGVuZXIpO1xuICAgIHN0YXRlLmlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ3Bhc3RlJywgb25QYXN0ZSBhcyBFdmVudExpc3RlbmVyKTtcblxuICAgIC8vIOaLlui/m+adpeS5n+eul+OAjOWKoOWbvuOAje+8muS4ieS4quadpea6kO+8iOeymOi0tC/pgInmi6nlmagv5ouW5ou977yJ6YO96JC95YiwIGF0dGFjaEJsb2JzIOi/meS4gOadoei3r+S4ilxuICAgIChyb290ID8/IHN0YXRlLmJvZHkpLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgKGV2ZW50OiBEcmFnRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGV2ZW50LmRhdGFUcmFuc2Zlcj8udHlwZXM/LmluY2x1ZGVzKCdGaWxlcycpKSB7XG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgaWYgKHJvb3QpIHJvb3QuZGF0YXNldC5kcmFnID0gJ3RydWUnO1xuICAgICAgICB9XG4gICAgfSk7XG4gICAgKHJvb3QgPz8gc3RhdGUuYm9keSkuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgKCkgPT4ge1xuICAgICAgICBpZiAocm9vdCkgZGVsZXRlIHJvb3QuZGF0YXNldC5kcmFnO1xuICAgIH0pO1xuICAgIChyb290ID8/IHN0YXRlLmJvZHkpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCAoZXZlbnQ6IERyYWdFdmVudCkgPT4ge1xuICAgICAgICBpZiAocm9vdCkgZGVsZXRlIHJvb3QuZGF0YXNldC5kcmFnO1xuICAgICAgICBjb25zdCBmaWxlcyA9IGV2ZW50LmRhdGFUcmFuc2Zlcj8uZmlsZXMgPyBBcnJheS5mcm9tKGV2ZW50LmRhdGFUcmFuc2Zlci5maWxlcykgOiBbXTtcbiAgICAgICAgY29uc3QgaW1hZ2VzID0gZmlsZXNcbiAgICAgICAgICAgIC5maWx0ZXIoKGZpbGUpID0+IGZpbGUudHlwZS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ2ltYWdlLycpKVxuICAgICAgICAgICAgLm1hcCgoZmlsZSwgaW5kZXgpID0+ICh7IGJsb2I6IGZpbGUgYXMgQmxvYiwgbmFtZTogZmlsZS5uYW1lIHx8IGDmi5bov5vmnaXnmoTlm77niYctJHtpbmRleCArIDF9YCB9KSk7XG4gICAgICAgIGlmIChpbWFnZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHZvaWQgYXR0YWNoQmxvYnMoc3RhdGUsIGltYWdlcywgJ2Ryb3AnKTtcbiAgICB9KTtcblxuICAgIC8vIOWbvueJh+aMiemSruS4jumAieaLqeWZqFxuICAgIHN0YXRlLmltYWdlQnV0dG9uPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZVBpY2tlcihzdGF0ZSkpO1xuICAgIHBpY2soJ2J0blBpY2tlckNsb3NlJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlUGlja2VyKHN0YXRlLCBmYWxzZSkpO1xuICAgIHBpY2soJ2J0blBpY2tlclJlZnJlc2gnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHN0YXRlLnBpY2tlclRodW1icy5jbGVhcigpO1xuICAgICAgICBzdGF0ZS5waWNrZXJGYWlsZWQuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBlbnN1cmVQaWNrZXJMaXN0KHN0YXRlLCB0cnVlKTtcbiAgICB9KTtcbiAgICBwaWNrKCdidG5QaWNrZXJQYXN0ZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgcGFzdGVGcm9tQ2xpcGJvYXJkQXBpKHN0YXRlKSk7XG4gICAgc3RhdGUucGlja2VyU2VhcmNoPy5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgICAgc3RhdGUucGlja2VyUXVlcnkgPSBzdGF0ZS5waWNrZXJTZWFyY2g/LnZhbHVlID8/ICcnO1xuICAgICAgICByZW5kZXJQaWNrZXJMaXN0KHN0YXRlKTtcbiAgICB9KTtcbiAgICBzdGF0ZS5waWNrZXJTZWFyY2g/LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHRvZ2dsZVBpY2tlcihzdGF0ZSwgZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgcGljaygnYnRuTmV3Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyDkuLvov5vnqIvkvJrmuIXovazlhpnlubbmiorku6PmlbAgKzHvvJvpnaLmnb/kuI3oh6rlt7HmuIUgRE9N77yI5riF56m65Y+q5pyJ5LiA5Liq55yf5rqQ77yM6KeBIHJlc2V0VWnvvIlcbiAgICAgICAgYXdhaXQgY2FsbChNU0cubmV3U2Vzc2lvbik7XG4gICAgICAgIGF3YWl0IHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgICAgIGF3YWl0IHBvbGxPbmNlKHN0YXRlKTtcbiAgICB9KTtcblxuICAgIHBpY2soJ2J0blN0b3AnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHNldHRsZWQgPSBzdGF0ZS5zbmFwc2hvdD8uc3RhdHVzID09PSAnc3RvcHBlZCcgfHwgc3RhdGUuc25hcHNob3Q/LnN0YXR1cyA9PT0gJ2Vycm9yJztcbiAgICAgICAgaWYgKHNldHRsZWQpIHtcbiAgICAgICAgICAgIC8vIOayoei3keeahOaXtuWAmei/meS4quaMiemSruaYr+OAjOWQr+WKqOOAjeKAlOKAlCDkuYvliY3moLnmnKzmsqHmnInov5nkuKrlhaXlj6PvvIjop4EgcmVmcmVzaFN0YXRlIOmHjOeahOivtOaYju+8iVxuICAgICAgICAgICAgYXdhaXQgc3RhcnRBZ2VudChzdGF0ZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAn5q2j5Zyo5YGc5q2iIGFnZW504oCmJywgJ2luZm8nKTtcbiAgICAgICAgYXdhaXQgY2FsbChNU0cuc3RvcEFnZW50KTtcbiAgICAgICAgYXdhaXQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICB9KTtcblxuICAgIC8qKlxuICAgICAqIOOAjOWBnOatouacrOi9ruOAjeKAlOKAlCDkuK3mlq3lvZPliY3ov5nkuIDova7vvIwqKuS4jeWKqCBhZ2VudOOAgeS4jeWKqOS8muivnSoq44CCXG4gICAgICpcbiAgICAgKiDkuInmnaHnnLzliY3og73nnIvliLDnmoTlj43ppojvvIjkuI3nhLbnlKjmiLfkvJrku6XkuLrmjInpkq7msqHnlJ/mlYjvvIzlm6DkuLrmqKHlnovov5jkvJrmiorlt7LnlJ/miJDnmoRcbiAgICAgKiDpgqPkuIDlsI/mrrXmloflrZflkJDlrozjgIHlt6Xlhbfnu5PmnpzkuZ/lj6/og73lho3mnaXkuIDmnaHvvInvvJpcbiAgICAgKiDikaAg56uL5Yi75oqK54q25oCB6KGM5pS55oiQ44CM5q2j5Zyo5Lit5pat4oCm44CN5bm256aB55So5oyJ6ZKu77yb4pGhIOS4u+i/m+eoi+S8muiusOS4gOadoSBub3Rl77ybXG4gICAgICog4pGiIGB0dXJuL2VuZGAg55qEIGBhYm9ydGVkYCDliLDkuobkuYvlkI7nirbmgIHooYzoh6rlt7HkvJrlj5jlm57nqbrpl7LjgIJcbiAgICAgKi9cbiAgICBwaWNrKCdidG5JbnRlcnJ1cHQnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIHN0YXRlLmludGVycnVwdGluZyA9IHRydWU7XG4gICAgICAgIHN5bmNJbnRlcnJ1cHRCdXR0b24oc3RhdGUpO1xuICAgICAgICBpZiAoc3RhdGUubGl2ZSkge1xuICAgICAgICAgICAgc3RhdGUubGl2ZS50ZXh0Q29udGVudCA9ICfmraPlnKjkuK3mlq3ov5nkuIDova7igKYnO1xuICAgICAgICAgICAgc3RhdGUubGl2ZS5kYXRhc2V0LnRvbmUgPSAnYnVzeSc7XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBjYW5jZWxsZWQ/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9PihNU0cuaW50ZXJydXB0KTtcbiAgICAgICAgICAgIGlmICghcmVwbHk/Lm9rKSBzZXRCYW5uZXIoc3RhdGUsIGDkuK3mlq3lpLHotKXvvJoke3JlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gLCAnZXJyb3InKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOS4reaWreWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xuICAgICAgICBhd2FpdCBwb2xsT25jZShzdGF0ZSk7XG4gICAgfSk7XG5cbiAgICBwaWNrKCdidG5SZXN0YXJ0Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfmraPlnKjph43lkK8gYWdlbnTigKbvvIjph43lkK/lkI7kvJroh6rliqjmjqXkuIrkuIrmrKHnmoTkvJror53vvIknLCAnaW5mbycpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgY2FsbChNU0cuc3RvcEFnZW50KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSDph43lkK/ml7Ygc3RvcCDlpLHotKXvvIjnu6fnu60gc3RhcnTvvInvvJoke1N0cmluZyhlcnJvcil9YCk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgc3RhcnRBZ2VudChzdGF0ZSk7XG4gICAgfSk7XG5cbiAgICBwaWNrKCdidG5IaXN0b3J5Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBvcGVuSGlzdG9yeShzdGF0ZSkpO1xuICAgIHN0YXRlLmJ0bkhpc3RvcnlSZWZyZXNoRWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCByZWZyZXNoSGlzdG9yeShzdGF0ZSkpO1xuICAgIHBpY2soJ2J0bkhpc3RvcnlDbG9zZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGNsb3NlSGlzdG9yeShzdGF0ZSkpO1xuICAgIHN0YXRlLnJlc3VtZUJ1dHRvbj8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIHJlc3VtZUhpc3Rvcnkoc3RhdGUpKTtcblxuICAgIC8vIOeUqOmHj++8mueKtuaAgeihjOmCo+milyBjaGlwIOW8gOWFs+aKveWxie+8m+aKveWxiemHjOWIt+aWsCAvIOWFs+mXrVxuICAgIHN0YXRlLnVzYWdlQ2hpcD8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0b2dnbGVVc2FnZShzdGF0ZSkpO1xuICAgIHBpY2soJ2J0blVzYWdlQ2xvc2UnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0b2dnbGVVc2FnZShzdGF0ZSwgZmFsc2UpKTtcbiAgICBzdGF0ZS5idG5Vc2FnZVJlZnJlc2hFbD8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGlmIChzdGF0ZS5idG5Vc2FnZVJlZnJlc2hFbCkgc3RhdGUuYnRuVXNhZ2VSZWZyZXNoRWwuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBpZiAoc3RhdGUuYnRuUHJvZ3Jlc3NSZWZyZXNoRWwpIHN0YXRlLmJ0blByb2dyZXNzUmVmcmVzaEVsLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgdm9pZCByZWFkVXNhZ2Uoc3RhdGUpO1xuICAgIH0pO1xuXG4gICAgLy8g6L+b5bqm77ya5ZCM5LiA5aWX5pGG5rOV77yI6YKj6aKXIGNoaXAg5Lmf5LiA5qC377yM5rKh5riF5Y2V5pe25pW06aKX6JeP6LW35p2l77yJXG4gICAgc3RhdGUucHJvZ3Jlc3NDaGlwPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZVByb2dyZXNzKHN0YXRlKSk7XG4gICAgcGljaygnYnRuUHJvZ3Jlc3NDbG9zZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZVByb2dyZXNzKHN0YXRlLCBmYWxzZSkpO1xuICAgIC8vIC0tLS0g5rS75Yqo77yI5ZCO5Y+w5Lu75YqhIC8g5a2QIGFnZW5077yJ77ya5LiO5Y+m5aSW5Lik5Liq5oq95bGJ5ZCM5LiA5aWX5Lqk5LqSXG4gICAgc3RhdGUuYWN0aXZpdHlDaGlwPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZUFjdGl2aXR5KHN0YXRlKSk7XG4gICAgcGljaygnYnRuQWN0aXZpdHlDbG9zZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZUFjdGl2aXR5KHN0YXRlLCBmYWxzZSkpO1xuICAgIHBpY2soJ2J0bkFjdGl2aXR5UmVmcmVzaCcpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgLy8g55So5oi35Li75Yqo54K555qE77yaKirlv4XpobvnnIvliLDliJror7vnmoQqKu+8iOi9ruivoueahOiKgua1geS4jeWPguS4jui/meadoei3r++8iVxuICAgICAgICBzdGF0ZS5hY3Rpdml0eUF0ID0gMDtcbiAgICAgICAgdm9pZCByZWFkQWN0aXZpdHkoc3RhdGUpO1xuICAgIH0pO1xuICAgIHN0YXRlLmJ0blByb2dyZXNzUmVmcmVzaEVsPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgLy8g5Lik6aKX44CM5Yi35paw44CN5LiA6LW356aB55So77ya5a6D5Lus5omT55qE5piv5ZCM5LiA5qyh6K+755uY77yI6KeBIGByZWFkVXNhZ2Vg77yJXG4gICAgICAgIGlmIChzdGF0ZS5idG5Qcm9ncmVzc1JlZnJlc2hFbCkgc3RhdGUuYnRuUHJvZ3Jlc3NSZWZyZXNoRWwuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBpZiAoc3RhdGUuYnRuVXNhZ2VSZWZyZXNoRWwpIHN0YXRlLmJ0blVzYWdlUmVmcmVzaEVsLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgdm9pZCByZWFkVXNhZ2Uoc3RhdGUpO1xuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICog5oq95bGJ6YeM55qE5pCc57Si5qGG77yaKirovrnmiZPlrZfovrnnrZvmoIfpopgqKu+8iOacrOWcsOOAgembtuaIkOacrO+8ie+8jEVudGVyIOaJjeWOu+ivu+ejgeebmOaQnOWFqOaWh+OAglxuICAgICAqXG4gICAgICog5Lik5p2h6Lev5YiG5byA55qE55CG55Sx5YaZ5ZyoIGBydW5IaXN0b3J5U2VhcmNoYCDkuIrvvJrkuIDkuKrmmK/lnKjmiYvovrnov5nlh6DmnaHph4zmjJHvvIxcbiAgICAgKiDkuIDkuKrmmK/mnInpooTnrpfnmoTno4Hnm5jmiavmj4/jgILmuIXnqbrovpPlhaXmoYYgPSDlm57liLDliJfooajvvIjkuI3nlKjlho3ngrnkuIDkuIvjgIzov5Tlm57liJfooajjgI3vvInjgIJcbiAgICAgKi9cbiAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoRWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgICBzdGF0ZS5oaXN0b3J5UXVlcnkgPSBzdGF0ZS5oaXN0b3J5U2VhcmNoRWw/LnZhbHVlID8/ICcnO1xuICAgICAgICBpZiAoIXN0YXRlLmhpc3RvcnlRdWVyeS50cmltKCkgJiYgc3RhdGUuaGlzdG9yeVNlYXJjaCkge1xuICAgICAgICAgICAgc3RhdGUuaGlzdG9yeVNlYXJjaCA9IG51bGw7XG4gICAgICAgICAgICBzeW5jSGlzdG9yeUNvbnRyb2xzKHN0YXRlKTtcbiAgICAgICAgICAgIHZvaWQgbG9hZEhpc3RvcnlMaXN0KHN0YXRlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXN0YXRlLmhpc3RvcnlTZWFyY2gpIHZvaWQgbG9hZEhpc3RvcnlMaXN0KHN0YXRlKTtcbiAgICB9KTtcbiAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoRWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIHZvaWQgcnVuSGlzdG9yeVNlYXJjaChzdGF0ZSwgc3RhdGUuaGlzdG9yeVF1ZXJ5KTtcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLmhpc3RvcnlTZWFyY2hFbCkgc3RhdGUuaGlzdG9yeVNlYXJjaEVsLnZhbHVlID0gJyc7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5UXVlcnkgPSAnJztcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlTZWFyY2ggPSBudWxsO1xuICAgICAgICAgICAgc3luY0hpc3RvcnlDb250cm9scyhzdGF0ZSk7XG4gICAgICAgICAgICB2b2lkIGxvYWRIaXN0b3J5TGlzdChzdGF0ZSk7XG4gICAgICAgIH1cbiAgICB9KTtcbiAgICBzdGF0ZS5idG5IaXN0b3J5U2VhcmNoPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgcnVuSGlzdG9yeVNlYXJjaChzdGF0ZSwgc3RhdGUuaGlzdG9yeVF1ZXJ5KSk7XG4gICAgc3RhdGUuYnRuSGlzdG9yeUJhY2s/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBzdGF0ZS5oaXN0b3J5U2VhcmNoID0gbnVsbDtcbiAgICAgICAgc3luY0hpc3RvcnlDb250cm9scyhzdGF0ZSk7XG4gICAgICAgIHZvaWQgbG9hZEhpc3RvcnlMaXN0KHN0YXRlKTtcbiAgICB9KTtcblxuICAgIHBpY2soJ2J0blNldHRpbmdzJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlU2V0dGluZ3Moc3RhdGUpKTtcbiAgICBwaWNrKCdidG5UaGVtZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgY3ljbGVUaGVtZShzdGF0ZSkpO1xuXG4gICAgLy8g4pqgICoq6L2u6K+i5Zyo6L+Z6YeM6LW377yM5LiN562JIGBsaXN0ZW5lcnMuc2hvd2AqKu+8iOingSBQT0xMX0lOVEVSVkFMX01TIOS4iuaWueeahOivtOaYju+8iVxuICAgIHJlc3VtZShzdGF0ZSwgJ21vdW50Jyk7XG5cbiAgICByZXR1cm4gc3RhdGU7XG59XG5cbi8qKiDpnaLmnb/mmL7npLov5oyC6L2977ya6LW36L2u6K+iICsg5o6l5bm/5pKt77yIKirluYLnrYkqKu+8jGBtb3VudGAg5LiOIGBsaXN0ZW5lcnMuc2hvd2Ag6YO95Lya6LCD77yJ44CCICovXG5mdW5jdGlvbiByZXN1bWUoc3RhdGU6IFVpU3RhdGUsIHNvdXJjZTogJ21vdW50JyB8ICdzaG93Jyk6IHZvaWQge1xuICAgIGNvbnN0IGF0dGFjaGVkID0gYXR0YWNoQnJvYWRjYXN0KHN0YXRlKTtcbiAgICBzdGF0ZS5wb2xsaW5nID0gdHJ1ZTtcbiAgICBzY2hlZHVsZVBvbGwoc3RhdGUpO1xuICAgIGlmICghc3RhdGUucmVwb3J0ZWRSZXN1bWUpIHtcbiAgICAgICAgc3RhdGUucmVwb3J0ZWRSZXN1bWUgPSB0cnVlO1xuICAgICAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdyZXN1bWVkJywgc291cmNlLCBicm9hZGNhc3Q6IGF0dGFjaGVkLCBwb2xsTXM6IFBPTExfSU5URVJWQUxfTVMgfSk7XG4gICAgfVxuICAgIC8vIOeri+WIu+aLieS4gOasoeW5tuWIt+eKtuaAge+8jOWIq+etieesrOS4gOS4qumXtOmalO+8iOS5n+iuqeOAjOaJk+W8gOmdouadv+OAjeeri+WIu+eci+WIsOacgOaWsOWGheWuue+8iVxuICAgIHZvaWQgcG9sbE9uY2Uoc3RhdGUpO1xuICAgIHZvaWQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbn1cblxuLyoqIOaOpeW5v+aSre+8iOW/q+i3r++8ieOAguaLv+S4jeWIsOe8lui+keWZqOS/neaKpOaOpeWPo+S5n+S4jeW9seWTjeeUqCDigJTigJQg6L2u6K+i5omN5piv5Li76Lev44CCICovXG5mdW5jdGlvbiBhdHRhY2hCcm9hZGNhc3Qoc3RhdGU6IFVpU3RhdGUpOiBib29sZWFuIHtcbiAgICBpZiAoc3RhdGUuYnJvYWRjYXN0SGFuZGxlcikgcmV0dXJuIHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYnVzID0gKFxuICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2UgYXMgdW5rbm93biBhcyB7XG4gICAgICAgICAgICAgICAgX19wcm90ZWN0ZWRfXz86IHsgYWRkQnJvYWRjYXN0TGlzdGVuZXI/OiAobTogc3RyaW5nLCBmOiAodTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZCB9O1xuICAgICAgICAgICAgfVxuICAgICAgICApLl9fcHJvdGVjdGVkX187XG4gICAgICAgIGlmICghYnVzPy5hZGRCcm9hZGNhc3RMaXN0ZW5lcikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKHVwZGF0ZTogdW5rbm93bik6IHZvaWQgPT4gYXBwbHlCcm9hZGNhc3Qoc3RhdGUsIHVwZGF0ZSk7XG4gICAgICAgIGJ1cy5hZGRCcm9hZGNhc3RMaXN0ZW5lcihCUk9BRENBU1RfQ0hBTk5FTCwgaGFuZGxlcik7XG4gICAgICAgIHN0YXRlLmJyb2FkY2FzdEhhbmRsZXIgPSBoYW5kbGVyO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLyoqIOaOkuS4i+S4gOi3s+i9ruivouOAgui3keWKqOaXtuWvhuS4gOeCue+8iOa1geW8j+S4u+imgemdoOi/meS4gOi3r+aYvuekuuWHuuadpe+8ieOAgiAqL1xuZnVuY3Rpb24gc2NoZWR1bGVQb2xsKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgaWYgKCFzdGF0ZS5wb2xsaW5nKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUudGltZXIpO1xuICAgIGNvbnN0IGRlbGF5ID0gc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcgPyBQT0xMX0lOVEVSVkFMX0FDVElWRV9NUyA6IFBPTExfSU5URVJWQUxfTVM7XG4gICAgc3RhdGUudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHZvaWQgdGljayhzdGF0ZSksIGRlbGF5KTtcbn1cblxuLyoqIOS4gOi3s++8muaLiei9rOWGmSDihpLvvIjmnInmlrDmnaHnm67miJbliLDkuoblkajmnJ/vvInliLfnirbmgIEg4oaSIOaOkuS4i+S4gOi3s+OAgiAqL1xuYXN5bmMgZnVuY3Rpb24gdGljayhzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghc3RhdGUucG9sbGluZykgcmV0dXJuO1xuICAgIHN0YXRlLnRpY2sgKz0gMTtcbiAgICBjb25zdCBjaGFuZ2VkID0gYXdhaXQgcG9sbE9uY2Uoc3RhdGUpO1xuICAgIGlmIChjaGFuZ2VkIHx8IHN0YXRlLnRpY2sgJSBTVEFURV9FVkVSWV9USUNLUyA9PT0gMCkgYXdhaXQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICAvKipcbiAgICAgKiDmtLvliqjvvIjlkI7lj7Dku7vliqEgLyDlrZAgYWdlbnTvvInvvJoqKuWUr+S4gOS4gOWdl+imgemdouadv+iHquW3seaMieiKgua1geWOu+mXrueahOS4nOilvyoq44CCXG4gICAgICpcbiAgICAgKiDliKvnmoTor7vmlbDpg73mnInmjqjpgIEg4oCU4oCUIOeUqOmHjy/ov5vluqbnlLHkuLvov5vnqIvlnKjlm57lkIjnu5PmnZ/kuI7lkb3ku6TkuYvlkI7oh6rlt7Hor7vlubblub/mkq3vvJvogIzov5nkuKTlnZdcbiAgICAgKiDlj6rmtLvlnKjov5DooYzml7blhoXlrZjph4zjgIHmsqHmnInlj6/orqLpmIXnmoTlj5jljJbkuovku7bvvIzmiYDku6Xlj6rog73lnKjjgIzmnInkuJzopb/lj6/nnIvjgI3ml7bmjInoioLmtYHpl65cbiAgICAgKiDvvIjliKTmja7lnKggYHNob3VsZFBvbGxBY3Rpdml0eWDvvIznqbrpl7Lml7bkuIDmrKHpg73kuI3pl67vvInjgIJcbiAgICAgKi9cbiAgICBpZiAoc2hvdWxkUG9sbEFjdGl2aXR5KHN0YXRlKSkgdm9pZCByZWFkQWN0aXZpdHkoc3RhdGUsIHsgcXVpZXQ6IHRydWUgfSk7XG4gICAgc2NoZWR1bGVQb2xsKHN0YXRlKTtcbn1cblxuLyoqXG4gKiDpnaLmnb/mraTliLvmmK/lkKbnnJ/nmoTnnIvlvpfop4HvvIjph48gRE9N77yM5LiN5L+h57yW6L6R5Zmo55qE6ZKp5a2Q77yJ44CCXG4gKlxuICog55So6YCU5Y+q5pyJ5LiA5Liq77yaYGhpZGVgIOmSqeWtkOeahOWFnOW6lSDigJTigJQg6ZKp5a2Q6K+044CM6JeP6LW35p2l5LqG44CN5L2G6Z2i5p2/5piO5piO5Y2g552A5L2N572u5pe277yMXG4gKiDlroHlj6/nu6fnu63ova7or6LvvIjlpJrkuIDmrKEgSVBDIOiAjOW3su+8ie+8jOS5n+S4jeiDveaKiuWIt+aWsOWBnOaOie+8iOWBnOS6huWwseaYr+OAjOWGheWuueS4jeabtOaWsOOAjei/meS4qiBidWfvvInjgIJcbiAqIOWIpOaNruaVheaEj+Wuveadvu+8mumHj+S4jeWHuuadpeaXtioq5b2T5L2c5Y+v6KeBKirvvIjor6/liKTmlrnlkJHlv4XpobvlgY/lkJHjgIznu6fnu63ova7or6LjgI3vvInjgIJcbiAqL1xuZnVuY3Rpb24gcGFuZWxWaXNpYmxlKHN0YXRlOiBVaVN0YXRlKTogYm9vbGVhbiB7XG4gICAgY29uc3Qgcm9vdCA9IHN0YXRlLnJvb3Q7XG4gICAgaWYgKCFyb290KSByZXR1cm4gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gcm9vdC5nZXRDbGllbnRSZWN0cygpLmxlbmd0aCA+IDAgJiYgcm9vdC5vZmZzZXRIZWlnaHQgPiAwO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG59XG5cbi8qKiDpnaLmnb/pmpDol4/vvJrlgZzova7or6LvvIjlub/mkq3kuZ/mkZjmjonvvIzpgb/lhY3nnIvkuI3op4Hml7bov5jlnKjph43nu5jvvInjgIIgKi9cbmZ1bmN0aW9uIHBhdXNlKHN0YXRlOiBVaVN0YXRlLCBzb3VyY2U6ICdoaWRlJyB8ICdtYW51YWwnID0gJ2hpZGUnKTogdm9pZCB7XG4gICAgaWYgKHNvdXJjZSA9PT0gJ2hpZGUnICYmIHBhbmVsVmlzaWJsZShzdGF0ZSkpIHtcbiAgICAgICAgLy8g6ZKp5a2Q5LiO5Zyw6Z2i55yf55u45omT5p6277ya5Lul5Zyw6Z2i55yf55u45Li65YeG77yM57un57ut6L2u6K+iXG4gICAgICAgIHJlcG9ydFByb2JlKHsga2luZDogJ2hpZGUtaWdub3JlZCcsIHJlYXNvbjogJ+mdouadv+S7jeWPr+inge+8jOe7p+e7rei9ruivoicgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3RhdGUucG9sbGluZyA9IGZhbHNlO1xuICAgIGlmIChzdGF0ZS50aW1lcikge1xuICAgICAgICBjbGVhclRpbWVvdXQoc3RhdGUudGltZXIpO1xuICAgICAgICBzdGF0ZS50aW1lciA9IG51bGw7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5icm9hZGNhc3RIYW5kbGVyKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBidXMgPSAoXG4gICAgICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2UgYXMgdW5rbm93biBhcyB7XG4gICAgICAgICAgICAgICAgICAgIF9fcHJvdGVjdGVkX18/OiB7IHJlbW92ZUJyb2FkY2FzdExpc3RlbmVyPzogKG06IHN0cmluZywgZjogKHU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApLl9fcHJvdGVjdGVkX187XG4gICAgICAgICAgICBidXM/LnJlbW92ZUJyb2FkY2FzdExpc3RlbmVyPy4oQlJPQURDQVNUX0NIQU5ORUwsIHN0YXRlLmJyb2FkY2FzdEhhbmRsZXIpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICB9XG4gICAgICAgIHN0YXRlLmJyb2FkY2FzdEhhbmRsZXIgPSBudWxsO1xuICAgIH1cbiAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdwYXVzZWQnLCBzb3VyY2UgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRWRpdG9yLlBhbmVsLmRlZmluZSh7XG4gICAgbGlzdGVuZXJzOiB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBgc2hvd2AgLyBgaGlkZWAg5Y+q5pivKirkvJjljJYqKu+8iOWIh+WIsOWIq+eahCB0YWIg5pe255yB54K56L2u6K+i77yJ77yM5LiN5piv5b+F6ZyA55qE77yaXG4gICAgICAgICAqIOi9ruivouWcqCBgcmVhZHlgL2Btb3VudGAg6YeM5bey57uP6LW35p2l5LqG44CCXG4gICAgICAgICAqXG4gICAgICAgICAqIOKaoCDlrp7mtYvvvIjkuZ/mmK/ov5nmrKHjgIzkuI3mtYHlvI/jgI3nmoTmoLnlm6DvvInvvJrlr7kqKue8lui+keWZqOWQr+WKqOaXtuaBouWkjeeahOWBnOmdoOmdouadvyoq77yMXG4gICAgICAgICAqIOi/meS4pOS4qumSqeWtkOS4jeS/neivgeWcqCBgcmVhZHlgIOS5i+WQjuinpuWPkSDigJTigJQg6YKj5pe2IFdlYWtNYXAg6YeM6L+Y5rKh5pyJIHN0YXRl77yMXG4gICAgICAgICAqIOiAgeWGmeazle+8iGB1aUJ5UGFuZWwuZ2V0KHRoaXMpPy5yZXN1bWUoKWDvvInkvJoqKumdmem7mOS7gOS5iOmDveS4jeWBmioq44CCXG4gICAgICAgICAqIOaJgOS7pei/memHjOWKoOS6huWFnOW6le+8mmB0aGlzYCDmn6XkuI3liLDml7bvvIzoi6Xlj6rmnInkuIDkuKrpnaLmnb/lrp7kvovlsLHkvZznlKjlnKjlroPouqvkuIrjgIJcbiAgICAgICAgICovXG4gICAgICAgIHNob3codGhpczogb2JqZWN0KSB7XG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHJlc29sdmVTdGF0ZSh0aGlzKTtcbiAgICAgICAgICAgIGlmIChzdGF0ZSkgcmVzdW1lKHN0YXRlLCAnc2hvdycpO1xuICAgICAgICB9LFxuICAgICAgICBoaWRlKHRoaXM6IG9iamVjdCkge1xuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSByZXNvbHZlU3RhdGUodGhpcyk7XG4gICAgICAgICAgICBpZiAoc3RhdGUpIHBhdXNlKHN0YXRlLCAnaGlkZScpO1xuICAgICAgICB9LFxuICAgIH0sXG5cbiAgICB0ZW1wbGF0ZTogcmVhZFN0YXRpYygndGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksXG4gICAgc3R5bGU6IHJlYWRTdHlsZSgpLFxuXG4gICAgLy8g4pqgIOWFqOmDqOWFg+e0oOW8leeUqOmDveS7jui/memHjOaLv++8mmAkYCDnlLHnvJbovpHlmajlnKjpnaLmnb/lrZDmoJHph4zop6PmnpDvvIxcbiAgICAvLyAgICDogIwgYGRvY3VtZW50LmdldEVsZW1lbnRCeUlkYCDlnKjov5nkuKrnjq/looPph4zmi7/kuI3liLDvvIjlrp7mtYvov5Tlm54gbnVsbO+8ieOAglxuICAgIC8vICAgIOi/meS7veihqOS4juaWh+S7tumhtumDqCBTRUxFQ1RPUlMg5piv5ZCM5LiA5Lu96ZSu77yIU0VMRUNUT1JTIOaYr+ecn+a6kO+8jOi/memHjOWWgue7mee8lui+keWZqO+8ieOAglxuICAgICQ6IFNFTEVDVE9SUyxcblxuICAgIG1ldGhvZHM6IHt9LFxuXG4gICAgLyoqXG4gICAgICog6Z2i5p2/5oyC6L295a6M5oiQ5pe255Sx57yW6L6R5Zmo6LCD55So77yIKirkuI3mmK8qKiBgbWV0aG9kc2Ag6YeM55qE5pa55rOVIOKAlOKAlCDnvJbovpHlmajlr7nlroPlsLHmmK/mjInpobblsYLpkqnlrZDosIPnmoTvvIxcbiAgICAgKiDmlL7ov5sgYG1ldGhvZHNgIOmHjOawuOi/nOS4jeS8muiiq+iwg+WIsO+8jOWunua1i+i/h++8ieOAglxuICAgICAqXG4gICAgICog5YyF5LiA5bGCIHRyeS9jYXRjaO+8mmBtb3VudGAg5Y2K6Lev5oqb6ZSZ5LyaKirov57luKYqKuS4ouaOiSBgdWlCeVBhbmVsYCDnmoTnmbvorrDvvIjkuo7mmK8gYHNob3dgL2BoaWRlYFxuICAgICAqIOWFqOaIkOS6huepuuaTjeS9nO+8jOeXh+eKtuaYr+mdouadv+eci+edgOacieOAgeWGheWuueawuOi/nOS4jeWIt+aWsO+8ie+8jOiHs+WwkeaKiumUmeaKpee7meS4u+i/m+eoi+OAglxuICAgICAqL1xuICAgIHJlYWR5KHRoaXM6IG9iamVjdCkge1xuICAgICAgICBsZXQgc3RhdGU6IFVpU3RhdGU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzdGF0ZSA9IG1vdW50KHRoaXMpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc3Qgc3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gKGVycm9yLnN0YWNrID8/IGVycm9yLm1lc3NhZ2UpIDogU3RyaW5nKGVycm9yKTtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtkc2hfY2hhdF0g6Z2i5p2/5oyC6L295aSx6LSl77yaJHtzdGFja31gKTtcbiAgICAgICAgICAgIHJlcG9ydFByb2JlKHsga2luZDogJ21vdW50LWVycm9yJywgc3RhY2s6IHN0YWNrLnNsaWNlKDAsIDgwMCkgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdWlCeVBhbmVsLnNldCh0aGlzLCBzdGF0ZSk7XG4gICAgICAgIGxpdmVTdGF0ZXMuYWRkKHN0YXRlKTtcbiAgICB9LFxufSk7XG4iXX0=