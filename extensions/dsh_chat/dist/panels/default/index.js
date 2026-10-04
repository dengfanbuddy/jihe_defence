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
const tool_card_1 = require("./tool-card");
/** 静态资源根。 */
const STATIC_ROOT = (0, path_1.join)(__dirname, '../../../static');
/** 从扩展根读一份静态文件。 */
function readStatic(relativePath) {
    return (0, fs_1.readFileSync)((0, path_1.join)(STATIC_ROOT, relativePath), 'utf-8');
}
/**
 * 面板样式 = **token 层 + 组件层**。
 *
 * token 层是脚本从已安装的 DSH 里抽出来的（见 `scripts/extract-dsw-tokens.js`），
 * 组件层是手写的、只消费 token。分开的理由：DSH 升版本时重跑脚本即可，
 * 手写的组件样式不会被覆盖。
 */
function readStyle() {
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
const THEME_LABEL = { auto: '跟随系统', dark: '深色', light: '浅色' };
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
/** 把外观设置落到根节点（主题 + 字号）。 */
function applyAppearance(state) {
    var _a, _b, _c, _d;
    const root = state.root;
    if (!root)
        return;
    const mode = (_b = (_a = state.settings) === null || _a === void 0 ? void 0 : _a.theme) !== null && _b !== void 0 ? _b : 'auto';
    root.dataset.theme = resolveTheme(mode);
    const size = Number((_d = (_c = state.settings) === null || _c === void 0 ? void 0 : _c.fontSize) !== null && _d !== void 0 ? _d : 0);
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
    // maxRev 归零：代数变了，之前那批条目在主进程里已经不存在，重拉一遍不会重复
    state.maxRev = 0;
    state.maxSeq = 0;
    state.lastUserSeq = 0;
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
/** 打开/刷新历史抽屉。 */
async function openHistory(state) {
    state.historyOpen = true;
    if (state.history)
        state.history.hidden = false;
    if (state.historyList)
        state.historyList.textContent = '';
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
    renderHistoryList(state, reply);
}
/** 画历史列表。 */
function renderHistoryList(state, reply) {
    var _a, _b, _c, _d, _e;
    const list = state.historyList;
    if (!list)
        return;
    list.textContent = '';
    if (state.historyNote) {
        state.historyNote.textContent = reply.ok
            ? `${(_b = (_a = reply.sessions) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0} 条会话（按最后修改时间倒序）`
            : `读取失败：${(_c = reply.error) !== null && _c !== void 0 ? _c : '未知原因'}`;
        state.historyNote.dataset.tone = reply.ok ? '' : 'error';
    }
    if (!reply.ok)
        return;
    for (const session of (_d = reply.sessions) !== null && _d !== void 0 ? _d : []) {
        const item = el('button', 'dsh-history-item');
        item.dataset.current = session.current ? 'true' : 'false';
        item.title = session.id;
        item.appendChild(el('div', 'dsh-history-item-title', session.title || '(无标题)'));
        item.appendChild(el('div', 'dsh-history-item-meta', `${formatTime(session.updatedAt)} · ${session.turns} 轮 · ${(0, images_1.formatBytes)(session.bytes)}` +
            (session.current ? ' · 正在显示' : '')));
        item.addEventListener('click', () => void openHistorySession(state, session.id));
        list.appendChild(item);
    }
    if (((_e = reply.sessions) !== null && _e !== void 0 ? _e : []).length === 0) {
        list.appendChild(el('div', 'dsh-history-empty', '这个工程还没有历史会话。'));
    }
}
/** 关闭历史抽屉。 */
function closeHistory(state) {
    state.historyOpen = false;
    if (state.history)
        state.history.hidden = true;
}
/** 点一条历史会话：让主进程读日志并回放（只读）。 */
async function openHistorySession(state, sessionId) {
    var _a;
    if (state.historyNote)
        state.historyNote.textContent = '正在读日志并回放…（大日志会稍慢）';
    try {
        const reply = await call(constants_1.MSG.historyOpen, { sessionId });
        if (!(reply === null || reply === void 0 ? void 0 : reply.ok)) {
            if (state.historyNote) {
                state.historyNote.textContent = `回放失败：${(_a = reply === null || reply === void 0 ? void 0 : reply.error) !== null && _a !== void 0 ? _a : '未知原因'}`;
                state.historyNote.dataset.tone = 'error';
            }
            return;
        }
        closeHistory(state);
        await refreshState(state);
        // 回放是「主进程转写代数 +1」的副作用，这里主动拉一次，别让用户盯着空白等轮询
        await pollOnce(state);
    }
    catch (error) {
        if (state.historyNote) {
            state.historyNote.textContent = `回放失败：${String(error)}`;
            state.historyNote.dataset.tone = 'error';
        }
    }
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
    if (reply.settings)
        state.settings = reply.settings;
    applyAppearance(state);
    if (state.dot) {
        state.dot.dataset.state = reply.agent.status;
        state.dot.title = (_a = STATUS_TEXT[reply.agent.status]) !== null && _a !== void 0 ? _a : reply.agent.status;
    }
    const settings = state.settings;
    if (state.title)
        state.title.textContent = `DSH · ${constants_1.PROFILE_NAME}`;
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
    const changed = mergeEntries(state, entries);
    if (changed && pinned) {
        // 等一帧再滚：刚插入的内容还没量高度
        requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
        });
    }
}
/** 应用广播推来的更新（与轮询走同一套合并逻辑）。 */
function applyBroadcast(state, update) {
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
    // 广播只带增量，revision 用它推游标；漏掉的部分靠轮询补齐
    if (typeof payload.revision === 'number' && payload.revision > state.maxRev)
        state.maxRev = payload.revision;
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
/** 发送。 */
async function send(state) {
    var _a, _b;
    const text = state.input.value.trim();
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z;
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
        resumeButton: pick('btnResume'),
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
    });
    state.input.addEventListener('keydown', (event) => {
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
    (_v = pick('btnHistoryRefresh')) === null || _v === void 0 ? void 0 : _v.addEventListener('click', () => void openHistory(state));
    (_w = pick('btnHistoryClose')) === null || _w === void 0 ? void 0 : _w.addEventListener('click', () => closeHistory(state));
    (_x = state.resumeButton) === null || _x === void 0 ? void 0 : _x.addEventListener('click', () => void resumeHistory(state));
    (_y = pick('btnSettings')) === null || _y === void 0 ? void 0 : _y.addEventListener('click', () => toggleSettings(state));
    (_z = pick('btnTheme')) === null || _z === void 0 ? void 0 : _z.addEventListener('click', () => void cycleTheme(state));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOENHOztBQUVILDJCQUFrQztBQUNsQywrQkFBNEI7QUFFNUIsK0NBY3lCO0FBQ3pCLHlDQVFzQjtBQUN0Qix5Q0FBNEM7QUFDNUMsMkNBQTBEO0FBRTFELGFBQWE7QUFDYixNQUFNLFdBQVcsR0FBRyxJQUFBLFdBQUksRUFBQyxTQUFTLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztBQUV2RCxtQkFBbUI7QUFDbkIsU0FBUyxVQUFVLENBQUMsWUFBb0I7SUFDcEMsT0FBTyxJQUFBLGlCQUFZLEVBQUMsSUFBQSxXQUFJLEVBQUMsV0FBVyxFQUFFLFlBQVksQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ2xFLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFTLFNBQVM7SUFDZCxPQUFPLEdBQUcsVUFBVSxDQUFDLDhCQUE4QixDQUFDLEtBQUssVUFBVSxDQUFDLHlCQUF5QixDQUFDLEVBQUUsQ0FBQztBQUNyRyxDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsTUFBTSxnQkFBZ0IsR0FBRyxHQUFHLENBQUM7QUFFN0Isb0JBQW9CO0FBQ3BCLE1BQU0sdUJBQXVCLEdBQUcsR0FBRyxDQUFDO0FBRXBDLHVDQUF1QztBQUN2QyxNQUFNLGlCQUFpQixHQUFHLENBQUMsQ0FBQztBQUU1QixrQ0FBa0M7QUFDbEMsTUFBTSxTQUFTLEdBQUcsR0FBRywwQkFBYyxRQUFRLENBQUM7QUFFNUM7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBTSxZQUFZLEdBQUc7SUFDakIsU0FBUyxFQUFFLElBQUksR0FBRyxJQUFJO0lBQ3RCLE9BQU8sRUFBRSxJQUFJO0lBQ2Isa0JBQWtCLEVBQUUsQ0FBQyxHQUFHLElBQUksR0FB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QUk7UUFBRSxPQUFPLEdBQUcsQ0FBQztJQUN0QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3ZELEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7UUFDdkIsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU07WUFBRSxTQUFTO1FBQ25DLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDO1lBQUUsU0FBUztRQUMxRSxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDOUIsSUFBSSxDQUFDLElBQUk7WUFBRSxTQUFTO1FBQ3BCLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssV0FBVyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxTQUFTLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ25ILENBQUM7SUFDRCxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxJQUFJLElBQUksQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDMUQsNEJBQTRCO1FBQzVCLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUN4QyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7Z0JBQy9DLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxJQUFJLFNBQVMsR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDM0UsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDO0lBQ0QsT0FBTyxHQUFHLENBQUM7QUFDZixDQUFDO0FBeUJELGtDQUFrQztBQUNsQyxLQUFLLFVBQVUsZ0JBQWdCLENBQUMsS0FBYyxFQUFFLEtBQUssR0FBRyxLQUFLOztJQUN6RCxJQUFJLEtBQUssQ0FBQyxZQUFZLElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTztJQUN6QyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUNuQixLQUFLLENBQUMsVUFBVSxDQUFDLFdBQVcsR0FBRyxZQUFZLENBQUM7UUFDNUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsSUFBSSxHQUFHLEVBQUUsQ0FBQztJQUN2QyxDQUFDO0lBQ0QsSUFBSSxLQUFzQixDQUFDO0lBQzNCLElBQUksQ0FBQztRQUNELEtBQUssR0FBRyxNQUFNLElBQUksQ0FBa0IsZUFBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsS0FBSyxHQUFHLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7SUFDaEQsQ0FBQztJQUNELElBQUksQ0FBQyxDQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxFQUFFLENBQUEsRUFBRSxDQUFDO1FBQ2IsS0FBSyxDQUFDLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDeEIsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDbkIsS0FBSyxDQUFDLFVBQVUsQ0FBQyxXQUFXLEdBQUcsV0FBVyxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxLQUFLLG1DQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ25FLEtBQUssQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxPQUFPLENBQUM7UUFDNUMsQ0FBQztRQUNELE9BQU87SUFDWCxDQUFDO0lBQ0QsS0FBSyxDQUFDLFlBQVksR0FBRyxNQUFBLEtBQUssQ0FBQyxNQUFNLG1DQUFJLEVBQUUsQ0FBQztJQUN4QyxLQUFLLENBQUMsWUFBWSxHQUFHLE1BQUEsS0FBSyxDQUFDLE1BQU0sbUNBQUksRUFBRSxDQUFDO0lBQ3hDLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzVCLENBQUM7QUFFRCx5QkFBeUI7QUFDekIsU0FBUyxnQkFBZ0IsQ0FBQyxLQUFjOztJQUNwQyxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDO0lBQzlCLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTztJQUNsQixNQUFNLEdBQUcsR0FBRyxNQUFBLEtBQUssQ0FBQyxZQUFZLG1DQUFJLEVBQUUsQ0FBQztJQUNyQyxNQUFNLEtBQUssR0FBRyxJQUFBLDRCQUFtQixFQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSwwQkFBaUIsQ0FBQyxDQUFDO0lBQ3RGLElBQUksQ0FBQyxXQUFXLEdBQUcsRUFBRSxDQUFDO0lBQ3RCLE1BQUEsS0FBSyxDQUFDLGNBQWMsMENBQUUsVUFBVSxFQUFFLENBQUM7SUFDbkMsS0FBSyxDQUFDLGNBQWMsR0FBRyxJQUFJLENBQUM7SUFDNUIsS0FBSyxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7SUFFdkIsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDbkIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFlBQVksS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLDZCQUE2QixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDbEYsS0FBSyxDQUFDLFVBQVUsQ0FBQyxXQUFXO1lBQ3hCLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQztnQkFDWixDQUFDLENBQUMsK0NBQStDO2dCQUNqRCxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsTUFBTSxLQUFLLE1BQU0sR0FBRyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxXQUFXLENBQUM7UUFDbkcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsSUFBSSxHQUFHLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNwRSxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQ1YsT0FBTyxvQkFBb0IsS0FBSyxVQUFVO1FBQ3RDLENBQUMsQ0FBQyxJQUFJLG9CQUFvQixDQUNwQixDQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ1IsS0FBSyxNQUFNLEtBQUssSUFBSSxPQUFPLEVBQUUsQ0FBQztnQkFDMUIsSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjO29CQUFFLFNBQVM7Z0JBQ3BDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxNQUFxQixDQUFDO2dCQUN6QyxRQUFRLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN6QixNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ2xFLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ3pDLElBQUksS0FBSyxJQUFJLE1BQU07b0JBQUUsVUFBVSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDMUQsQ0FBQztRQUNMLENBQUMsRUFDRCxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxDQUN0QztRQUNILENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDZixLQUFLLENBQUMsY0FBYyxHQUFHLFFBQVEsQ0FBQztJQUVoQyxLQUFLLE1BQU0sS0FBSyxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ3hCLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsZUFBZSxDQUFDLENBQUM7UUFDM0MsSUFBSSxDQUFDLElBQUksR0FBRyxRQUFRLENBQUM7UUFDckIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQztRQUMvQixJQUFJLENBQUMsS0FBSyxHQUFHLEdBQUcsS0FBSyxDQUFDLElBQUksS0FBSyxLQUFLLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFBLG9CQUFXLEVBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQzdHLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztRQUMxQyxLQUFLLENBQUMsR0FBRyxHQUFHLEVBQUUsQ0FBQztRQUNmLGdDQUFnQztRQUNoQyxNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbEQsSUFBSSxNQUFNO1lBQUUsS0FBSyxDQUFDLEdBQUcsR0FBRyxNQUFNLENBQUM7UUFDL0IsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLE1BQU0sRUFBRSxlQUFlLENBQUMsQ0FBQztRQUN6QyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsZUFBZSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsTUFBTSxFQUFFLGVBQWUsRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzFHLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3pCLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsS0FBSyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztRQUM1RSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxNQUFNLElBQUksUUFBUTtZQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7YUFDM0MsSUFBSSxDQUFDLE1BQU0sSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7WUFBRSxVQUFVLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztJQUNuRixDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsVUFBVSxDQUFDLEtBQWMsRUFBRSxLQUFtQixFQUFFLE1BQXdCO0lBQzdFLElBQUksS0FBSyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7UUFBRSxPQUFPO0lBQ3JGLElBQUksS0FBSyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztRQUFFLE9BQU87SUFDaEQsS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUMxQyxLQUFLLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMzQixDQUFDO0FBRUQsc0JBQXNCO0FBQ3RCLEtBQUssVUFBVSxVQUFVLENBQUMsS0FBYztJQUNwQyxPQUFPLEtBQUssQ0FBQyxhQUFhLENBQUMsSUFBSSxHQUFHLGlCQUFpQixJQUFJLEtBQUssQ0FBQyxXQUFXLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2xGLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDdkMsSUFBSSxDQUFDLElBQUk7WUFBRSxNQUFNO1FBQ2pCLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDO1FBQy9CLElBQUksS0FBSyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7WUFBRSxTQUFTO1FBQ3hGLEtBQUssQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNwQyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUU7O1lBQ2IsSUFBSSxDQUFDO2dCQUNELE1BQU0sS0FBSyxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQzVDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO29CQUMzQixLQUFLLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ25DLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztvQkFDL0IsT0FBTztnQkFDWCxDQUFDO2dCQUNELE1BQU0sSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQUEsS0FBSyxDQUFDLFFBQVEsbUNBQUksV0FBVyxFQUFFLENBQUMsQ0FBQztnQkFDN0YsTUFBTSxPQUFPLEdBQUcsTUFBTSxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3ZDLElBQUksQ0FBQztvQkFDRCxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUM7b0JBQ2pDLEtBQUssQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7b0JBQzFDLE9BQU8sS0FBSyxDQUFDLFlBQVksQ0FBQyxJQUFJLEdBQUcsaUJBQWlCLEVBQUUsQ0FBQzt3QkFDakQsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQzt3QkFDaEQsSUFBSSxNQUFNLENBQUMsSUFBSTs0QkFBRSxNQUFNO3dCQUN2QixLQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7b0JBQzVDLENBQUM7b0JBQ0QsSUFBSSxNQUFNLENBQUMsV0FBVzt3QkFBRSxNQUFNLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQztnQkFDL0MsQ0FBQzt3QkFBUyxDQUFDO29CQUNQLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDdEIsQ0FBQztZQUNMLENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsS0FBSyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNuQyxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7WUFDbkMsQ0FBQztvQkFBUyxDQUFDO2dCQUNQLEtBQUssQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDdkMsS0FBSyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDM0IsQ0FBQztRQUNMLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDVCxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQVMsY0FBYyxDQUFDLElBQVk7SUFDaEMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzFCLE1BQU0sTUFBTSxHQUFHLElBQUksV0FBVyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUM5QyxNQUFNLEtBQUssR0FBRyxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNyQyxLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQztRQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQy9GLE9BQU8sTUFBTSxDQUFDO0FBQ2xCLENBQUM7QUFFRCxnQ0FBZ0M7QUFDaEMsS0FBSyxVQUFVLGdCQUFnQixDQUFDLEtBQW1CO0lBQy9DLElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxJQUFJLENBQWlCLGVBQUcsQ0FBQyxTQUFTLEVBQUUsRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7SUFDM0YsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDYixPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7SUFDL0MsQ0FBQztBQUNMLENBQUM7QUFFRCxpQ0FBaUM7QUFDakMsS0FBSyxVQUFVLGtCQUFrQixDQUFDLEtBQWMsRUFBRSxLQUFtQjs7SUFDakUsSUFBSSxLQUFLLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxLQUFLLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUMxRixTQUFTLENBQUMsS0FBSyxFQUFFLElBQUksS0FBSyxDQUFDLElBQUksY0FBYyxFQUFFLE1BQU0sRUFBRSxFQUFFLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzdFLE9BQU87SUFDWCxDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1QyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUMzQixTQUFTLENBQUMsS0FBSyxFQUFFLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxNQUFBLEtBQUssQ0FBQyxLQUFLLG1DQUFJLE1BQU0sRUFBRSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2hHLE9BQU87SUFDWCxDQUFDO0lBQ0QsTUFBTSxJQUFJLEdBQUcsSUFBSSxJQUFJLENBQUMsQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBQSxLQUFLLENBQUMsUUFBUSxtQ0FBSSxXQUFXLEVBQUUsQ0FBQyxDQUFDO0lBQzdGLE1BQU0sV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxNQUFBLEtBQUssQ0FBQyxJQUFJLG1DQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBQ3BGLENBQUM7QUFFRCxrQkFBa0I7QUFDbEIsU0FBUyxZQUFZLENBQUMsS0FBYyxFQUFFLElBQWM7SUFDaEQsTUFBTSxJQUFJLEdBQUcsSUFBSSxhQUFKLElBQUksY0FBSixJQUFJLEdBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDO0lBQ3ZDLEtBQUssQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLElBQUksS0FBSyxDQUFDLE1BQU07UUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksQ0FBQztJQUM5QyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ1A7Ozs7V0FJRztRQUNILElBQUksS0FBSyxDQUFDLFlBQVk7WUFBRSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNoRCxLQUFLLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzdCLHNDQUFzQztRQUN0QyxVQUFVLENBQUMsR0FBRyxFQUFFLFdBQUMsT0FBQSxNQUFBLEtBQUssQ0FBQyxZQUFZLDBDQUFFLEtBQUssRUFBRSxDQUFBLEVBQUEsRUFBRSxDQUFDLENBQUMsQ0FBQztJQUNyRCxDQUFDO1NBQU0sSUFBSSxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDOUIsS0FBSyxDQUFDLGNBQWMsQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUNsQyxLQUFLLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQztJQUNoQyxDQUFDO0FBQ0wsQ0FBQztBQUVELHVDQUF1QztBQUN2QyxLQUFLLFVBQVUscUJBQXFCLENBQUMsS0FBYztJQUMvQyxNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsU0FBa0MsQ0FBQztJQUMvRCxJQUFJLENBQUMsQ0FBQSxTQUFTLGFBQVQsU0FBUyx1QkFBVCxTQUFTLENBQUUsSUFBSSxDQUFBLEVBQUUsQ0FBQztRQUNuQixTQUFTLENBQUMsS0FBSyxFQUFFLHdDQUF3QyxFQUFFLE1BQU0sRUFBRSxFQUFFLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pGLE9BQU87SUFDWCxDQUFDO0lBQ0QsSUFBSSxDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDckMsTUFBTSxLQUFLLEdBQXdDLEVBQUUsQ0FBQztRQUN0RCxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7WUFDNUUsSUFBSSxDQUFDLElBQUk7Z0JBQUUsU0FBUztZQUNwQixLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsU0FBUyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUN0RixDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3JCLFNBQVMsQ0FBQyxLQUFLLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDbEUsT0FBTztRQUNYLENBQUM7UUFDRCxNQUFNLFdBQVcsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLFdBQVcsQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsU0FBUyxDQUNMLEtBQUssRUFDTCxVQUFVLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsMkJBQTJCLEVBQzNGLE1BQU0sRUFDTixFQUFFLEVBQ0YsV0FBVyxDQUFDLElBQUksQ0FDbkIsQ0FBQztJQUNOLENBQUM7QUFDTCxDQUFDO0FBRUQsc0VBQXNFO0FBRXRFLDJCQUEyQjtBQUMzQixLQUFLLFVBQVUsVUFBVSxDQUFDLEtBQWM7O0lBQ3BDLElBQUksS0FBSyxDQUFDLGNBQWM7UUFBRSxPQUFPO0lBQ2pDLEtBQUssQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDO0lBQzVCLFNBQVMsQ0FBQyxLQUFLLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQWtDLGVBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUMzRSxJQUFJLENBQUMsQ0FBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsRUFBRSxDQUFBLEVBQUUsQ0FBQztZQUNkLFNBQVMsQ0FBQyxLQUFLLEVBQUUsTUFBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsS0FBSyxtQ0FBSSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLFVBQVUsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUM3RyxDQUFDO2FBQU0sQ0FBQztZQUNKLFNBQVMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDM0IsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3ZELENBQUM7WUFBUyxDQUFDO1FBQ1AsS0FBSyxDQUFDLGNBQWMsR0FBRyxLQUFLLENBQUM7UUFDN0IsS0FBSyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDN0IsQ0FBQztBQUNMLENBQUM7QUFFRCw2QkFBNkI7QUFDN0IsS0FBSyxVQUFVLGFBQWEsQ0FBQyxLQUFjOztJQUN2QyxTQUFTLENBQUMsS0FBSyxFQUFFLGVBQWUsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUMxQyxJQUFJLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FDckIsZUFBRyxDQUFDLGNBQWMsQ0FDckIsQ0FBQztRQUNGLElBQUksTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLEVBQUUsRUFBRSxDQUFDO1lBQ2IsU0FBUyxDQUNMLEtBQUssRUFDTCxlQUFlLE1BQU0sQ0FBQyxVQUFVLEtBQUssQ0FBQSxNQUFBLE1BQU0sQ0FBQyxPQUFPLDBDQUFFLE1BQU0sRUFBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUNuRyxNQUFNLENBQ1QsQ0FBQztRQUNOLENBQUM7YUFBTSxDQUFDO1lBQ0osU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLE1BQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLEtBQUssbUNBQUksTUFBTSxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDakUsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3ZELENBQUM7SUFDRCxNQUFNLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM5QixDQUFDO0FBV0Q7Ozs7O0dBS0c7QUFDSCxTQUFTLFVBQVUsQ0FBQyxFQUFVO0lBQzFCLE1BQU0sSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzFCLE1BQU0sR0FBRyxHQUFHLENBQUMsS0FBYSxFQUFVLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUN0RSxPQUFPLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsRUFBRSxDQUFDO0FBQ2xILENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQVMsZ0JBQWdCLENBQUMsS0FBYzs7SUFDcEMsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQztJQUM3QixJQUFJLENBQUMsR0FBRztRQUFFLE9BQU87SUFDakIsTUFBTSxPQUFPLEdBQUcsTUFBQSxNQUFBLEtBQUssQ0FBQyxRQUFRLDBDQUFFLE9BQU8sbUNBQUksSUFBSSxDQUFDO0lBQ2hELElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNYLEdBQUcsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2xCLE9BQU87SUFDWCxDQUFDO0lBQ0QsR0FBRyxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7SUFDbkIsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7SUFDbkQsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3hFLElBQUksS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQ3ZCLEtBQUssQ0FBQyxjQUFjLENBQUMsV0FBVyxHQUFHLE9BQU8sQ0FBQyxJQUFJO1lBQzNDLENBQUMsQ0FBQyxXQUFXLE9BQU8sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsS0FBSyxJQUFJLGtCQUFrQjtZQUNyRSxDQUFDLENBQUMsY0FBYyxPQUFPLENBQUMsS0FBSyxJQUFJLElBQUksTUFBTSxPQUFPLENBQUMsWUFBWSxPQUFPLENBQUM7SUFDL0UsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLFlBQVk7UUFBRSxLQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQztBQUM5RSxDQUFDO0FBRUQsaUJBQWlCO0FBQ2pCLEtBQUssVUFBVSxXQUFXLENBQUMsS0FBYztJQUNyQyxLQUFLLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztJQUN6QixJQUFJLEtBQUssQ0FBQyxPQUFPO1FBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO0lBQ2hELElBQUksS0FBSyxDQUFDLFdBQVc7UUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7SUFDMUQsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLENBQUM7UUFDcEIsS0FBSyxDQUFDLFdBQVcsQ0FBQyxXQUFXLEdBQUcsMkNBQTJDLENBQUM7UUFDNUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsSUFBSSxHQUFHLEVBQUUsQ0FBQztJQUN4QyxDQUFDO0lBQ0QsSUFBSSxLQUF1QixDQUFDO0lBQzVCLElBQUksQ0FBQztRQUNELEtBQUssR0FBRyxNQUFNLElBQUksQ0FBbUIsZUFBRyxDQUFDLFdBQVcsRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3pFLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsS0FBSyxHQUFHLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7SUFDaEQsQ0FBQztJQUNELGlCQUFpQixDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUNwQyxDQUFDO0FBRUQsYUFBYTtBQUNiLFNBQVMsaUJBQWlCLENBQUMsS0FBYyxFQUFFLEtBQXVCOztJQUM5RCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsV0FBVyxDQUFDO0lBQy9CLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTztJQUNsQixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztJQUN0QixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUNwQixLQUFLLENBQUMsV0FBVyxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUMsRUFBRTtZQUNwQyxDQUFDLENBQUMsR0FBRyxNQUFBLE1BQUEsS0FBSyxDQUFDLFFBQVEsMENBQUUsTUFBTSxtQ0FBSSxDQUFDLGlCQUFpQjtZQUNqRCxDQUFDLENBQUMsUUFBUSxNQUFBLEtBQUssQ0FBQyxLQUFLLG1DQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3RDLEtBQUssQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztJQUM3RCxDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO1FBQUUsT0FBTztJQUV0QixLQUFLLE1BQU0sT0FBTyxJQUFJLE1BQUEsS0FBSyxDQUFDLFFBQVEsbUNBQUksRUFBRSxFQUFFLENBQUM7UUFDekMsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLFFBQVEsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDO1FBQzlDLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO1FBQzFELElBQUksQ0FBQyxLQUFLLEdBQUcsT0FBTyxDQUFDLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEVBQUUsd0JBQXdCLEVBQUUsT0FBTyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDO1FBQ2hGLElBQUksQ0FBQyxXQUFXLENBQ1osRUFBRSxDQUNFLEtBQUssRUFDTCx1QkFBdUIsRUFDdkIsR0FBRyxVQUFVLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxNQUFNLE9BQU8sQ0FBQyxLQUFLLFFBQVEsSUFBQSxvQkFBVyxFQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUNuRixDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQ3pDLENBQ0osQ0FBQztRQUNGLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsS0FBSyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDakYsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBQ0QsSUFBSSxDQUFDLE1BQUEsS0FBSyxDQUFDLFFBQVEsbUNBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3RDLElBQUksQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLEtBQUssRUFBRSxtQkFBbUIsRUFBRSxjQUFjLENBQUMsQ0FBQyxDQUFDO0lBQ3JFLENBQUM7QUFDTCxDQUFDO0FBRUQsY0FBYztBQUNkLFNBQVMsWUFBWSxDQUFDLEtBQWM7SUFDaEMsS0FBSyxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUM7SUFDMUIsSUFBSSxLQUFLLENBQUMsT0FBTztRQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztBQUNuRCxDQUFDO0FBRUQsOEJBQThCO0FBQzlCLEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxLQUFjLEVBQUUsU0FBaUI7O0lBQy9ELElBQUksS0FBSyxDQUFDLFdBQVc7UUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLFdBQVcsR0FBRyxtQkFBbUIsQ0FBQztJQUMzRSxJQUFJLENBQUM7UUFDRCxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBbUQsZUFBRyxDQUFDLFdBQVcsRUFBRSxFQUFFLFNBQVMsRUFBRSxDQUFDLENBQUM7UUFDM0csSUFBSSxDQUFDLENBQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLEVBQUUsQ0FBQSxFQUFFLENBQUM7WUFDYixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFDcEIsS0FBSyxDQUFDLFdBQVcsQ0FBQyxXQUFXLEdBQUcsUUFBUSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxLQUFLLG1DQUFJLE1BQU0sRUFBRSxDQUFDO2dCQUNqRSxLQUFLLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsT0FBTyxDQUFDO1lBQzdDLENBQUM7WUFDRCxPQUFPO1FBQ1gsQ0FBQztRQUNELFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNwQixNQUFNLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQiwwQ0FBMEM7UUFDMUMsTUFBTSxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDMUIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDYixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNwQixLQUFLLENBQUMsV0FBVyxDQUFDLFdBQVcsR0FBRyxRQUFRLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3hELEtBQUssQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxPQUFPLENBQUM7UUFDN0MsQ0FBQztJQUNMLENBQUM7QUFDTCxDQUFDO0FBRUQsZ0RBQWdEO0FBQ2hELEtBQUssVUFBVSxhQUFhLENBQUMsS0FBYyxFQUFFLFNBQWtCOztJQUMzRCxTQUFTLENBQUMsS0FBSyxFQUFFLHNDQUFzQyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2pFLElBQUksQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUNwQixlQUFHLENBQUMsYUFBYSxFQUNqQixTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FDeEMsQ0FBQztRQUNGLElBQUksQ0FBQyxDQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxFQUFFLENBQUE7WUFBRSxTQUFTLENBQUMsS0FBSyxFQUFFLFFBQVEsTUFBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsS0FBSyxtQ0FBSSxNQUFNLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQzs7WUFDdkUsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLFNBQVMsQ0FBQyxLQUFLLEVBQUUsUUFBUSxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN2RCxDQUFDO0lBQ0QsTUFBTSxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDOUIsQ0FBQztBQUVELHlCQUF5QjtBQUN6QixTQUFTLFFBQVEsQ0FBQyxLQUFjOztJQUM1QixNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDO0lBQ2hDLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3RELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxPQUFPO1FBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFBLFFBQVEsQ0FBQyxTQUFTLG1DQUFJLElBQUksRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLENBQUM7SUFDNUYsSUFBSSxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDbkIsd0JBQXdCO1FBQ3hCLElBQUksV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUNyQixLQUFLLE1BQU0sS0FBSyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQztZQUN6QyxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssTUFBTSxJQUFJLEtBQUssQ0FBQyxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUk7Z0JBQUUsV0FBVyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQy9GLENBQUM7UUFDRCxPQUFPLEVBQUUsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUMsT0FBTyxXQUFXLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUMvRSxDQUFDO0lBQ0QsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFBLFdBQVcsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLG1DQUFJLFFBQVEsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDO0FBQ25GLENBQUM7QUFFRCxvQ0FBb0M7QUFDcEMsS0FBSyxVQUFVLFlBQVksQ0FBQyxLQUFjOztJQUN0QyxJQUFJLEtBQWlCLENBQUM7SUFDdEIsSUFBSSxDQUFDO1FBQ0QsS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFhLGVBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNqRCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxDQUFDLG1CQUFtQjtJQUMvQixDQUFDO0lBQ0QsSUFBSSxDQUFDLENBQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLEVBQUUsQ0FBQSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUs7UUFBRSxPQUFPO0lBQ3ZDLEtBQUssQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQztJQUM3QixJQUFJLEtBQUssQ0FBQyxRQUFRO1FBQUUsS0FBSyxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDO0lBQ3BELGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUV2QixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNaLEtBQUssQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUM3QyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssR0FBRyxNQUFBLFdBQVcsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxtQ0FBSSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUM1RSxDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQztJQUNoQyxJQUFJLEtBQUssQ0FBQyxLQUFLO1FBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQyxXQUFXLEdBQUcsU0FBUyx3QkFBWSxFQUFFLENBQUM7SUFDbkUsSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDWixNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7UUFDM0IsSUFBSSxRQUFRO1lBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxRQUFRLElBQUksUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDbkUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxPQUFPLElBQUksS0FBSyxDQUFDLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUMzRCxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3BFLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRztZQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDMUQsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxXQUFXLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDeEUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDO1FBQzdCLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQztJQUMzQixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDYixNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDN0IsS0FBSyxDQUFDLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQztRQUNuQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQy9GLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDakMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2IsTUFBTSxLQUFLLEdBQWEsRUFBRSxDQUFDO1FBQzNCLElBQUksUUFBUTtZQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsVUFBVSxRQUFRLENBQUMsZUFBZSxJQUFJLElBQUksRUFBRSxDQUFDLENBQUM7UUFDdkUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVM7WUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDakYsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxDQUFDO1lBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQztRQUNsRSxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQy9CLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztRQUM5QixLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7SUFDNUIsQ0FBQztJQUVELDhDQUE4QztJQUM5QyxNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxPQUFPLENBQUM7SUFDN0MsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxLQUFLLENBQUMsTUFBTSxLQUFLLE9BQU8sQ0FBQztJQUNuRixJQUFJLEtBQUssQ0FBQyxVQUFVO1FBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxRQUFRLEdBQUcsQ0FBQyxLQUFLLENBQUM7SUFDekQsTUFBTSxNQUFNLEdBQUcsTUFBQSxLQUFLLENBQUMsSUFBSSwwQ0FBRSxhQUFhLENBQW9CLFVBQVUsQ0FBQyxDQUFDO0lBQ3hFLElBQUksTUFBTTtRQUFFLE1BQU0sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxLQUFLLENBQUM7SUFFckM7Ozs7OztPQU1HO0lBQ0gsTUFBTSxPQUFPLEdBQUcsTUFBQSxLQUFLLENBQUMsSUFBSSwwQ0FBRSxhQUFhLENBQW9CLFdBQVcsQ0FBQyxDQUFDO0lBQzFFLElBQUksT0FBTyxFQUFFLENBQUM7UUFDVixPQUFPLENBQUMsV0FBVyxHQUFHLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDNUMsT0FBTyxDQUFDLEtBQUssR0FBRyxPQUFPO1lBQ25CLENBQUMsQ0FBQyxzQkFBc0I7WUFDeEIsQ0FBQyxDQUFDLHFDQUFxQyxDQUFDO1FBQzVDLE9BQU8sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssVUFBVSxJQUFJLEtBQUssQ0FBQyxLQUFLLENBQUMsTUFBTSxLQUFLLFVBQVUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxZQUFZLENBQUM7SUFDckksQ0FBQztJQUVEOzs7Ozs7OztPQVFHO0lBQ0gsTUFBTSxZQUFZLEdBQUcsTUFBQSxLQUFLLENBQUMsSUFBSSwwQ0FBRSxhQUFhLENBQW9CLGdCQUFnQixDQUFDLENBQUM7SUFDcEYsSUFBSSxZQUFZLEVBQUUsQ0FBQztRQUNmLFlBQVksQ0FBQyxLQUFLO1lBQ2QscURBQXFEO2dCQUNyRCwyQkFBMkIsQ0FBQztJQUNwQyxDQUFDO0lBQ0QsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0IsTUFBTSxVQUFVLEdBQUcsTUFBQSxLQUFLLENBQUMsSUFBSSwwQ0FBRSxhQUFhLENBQW9CLGNBQWMsQ0FBQyxDQUFDO0lBQ2hGLElBQUksVUFBVSxFQUFFLENBQUM7UUFDYixVQUFVLENBQUMsUUFBUSxHQUFHLENBQUMsS0FBSyxDQUFDO1FBQzdCLFVBQVUsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUM7SUFDNUUsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLFlBQVk7UUFBRSxLQUFLLENBQUMsWUFBWSxDQUFDLFFBQVEsR0FBRyxDQUFDLEtBQUssQ0FBQztJQUU3RCxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUV4QixJQUFJLEtBQUssQ0FBQyxPQUFPLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEtBQUssS0FBSyxFQUFFLENBQUM7UUFDOUMsOENBQThDO1FBQzlDLFNBQVMsQ0FDTCxLQUFLLEVBQ0wsb0JBQW9CLE1BQUEsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLG1DQUFJLE1BQU0saURBQWlELEVBQ2xHLE9BQU8sRUFDUDtZQUNJLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUMsS0FBSyxhQUFhLENBQUMsS0FBSyxDQUFDLEVBQUU7WUFDN0QsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLFVBQVUsQ0FBQyxLQUFLLENBQUMsRUFBRTtTQUN2RCxDQUNKLENBQUM7SUFDTixDQUFDO1NBQU0sSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxPQUFPLElBQUksS0FBSyxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUNqRSxTQUFTLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBUyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUMsS0FBSyxVQUFVLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDM0csQ0FBQztTQUFNLElBQUksS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssVUFBVSxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLENBQUM7UUFDOUUsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBRUQsVUFBVTtJQUNWLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLENBQUMsT0FBTztZQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDMUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUM7UUFDckIsV0FBVyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxPQUFPLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDcEYsQ0FBQztJQUVELFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNsQixjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7SUFFdEIsd0JBQXdCO0lBQ3hCLElBQUksS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssU0FBUyxLQUFJLE1BQUEsS0FBSyxDQUFDLFFBQVEsMENBQUUsU0FBUyxDQUFBLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3JILEtBQUssVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzNCLENBQUM7QUFDTCxDQUFDO0FBRUQsNENBQTRDO0FBQzVDLEtBQUssVUFBVSxRQUFRLENBQUMsS0FBYztJQUNsQyxJQUFJLENBQUM7UUFDRCxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBNkUsZUFBRyxDQUFDLFNBQVMsRUFBRTtZQUNoSCxLQUFLLEVBQUUsS0FBSyxDQUFDLE1BQU07U0FDdEIsQ0FBQyxDQUFDO1FBQ0gsbUNBQW1DO1FBQ25DLElBQUksQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsRUFBRSxLQUFJLE9BQU8sS0FBSyxDQUFDLFVBQVUsS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLFVBQVUsS0FBSyxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDN0YsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDckMsQ0FBQztRQUNELElBQUksQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsRUFBRSxLQUFJLE9BQU8sS0FBSyxDQUFDLFFBQVEsS0FBSyxRQUFRO1lBQUUsS0FBSyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzNHLElBQUksQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsRUFBRSxLQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3hFLFlBQVksQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ25DLE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7SUFDTCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsV0FBVztJQUNmLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDO0FBRUQsK0JBQStCO0FBQy9CLFNBQVMsWUFBWSxDQUFDLEtBQWMsRUFBRSxPQUFnQjtJQUNsRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDO0lBQ3hCLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFlBQVksSUFBSSxJQUFJLENBQUMsWUFBWSxHQUFHLEVBQUUsQ0FBQztJQUM1RSxJQUFJLEtBQUssQ0FBQyxPQUFPLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN0QyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3ZCLEtBQUssQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDO0lBQ3pCLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxZQUFZLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQzdDLElBQUksT0FBTyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3BCLG9CQUFvQjtRQUNwQixxQkFBcUIsQ0FBQyxHQUFHLEVBQUU7WUFDdkIsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztBQUNMLENBQUM7QUFFRCw4QkFBOEI7QUFDOUIsU0FBUyxjQUFjLENBQUMsS0FBYyxFQUFFLE1BQWU7SUFDbkQsTUFBTSxPQUFPLEdBQUcsTUFBb0MsQ0FBQztJQUNyRCxJQUFJLENBQUMsT0FBTztRQUFFLE9BQU87SUFDckIsSUFBSSxPQUFPLENBQUMsT0FBTyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsUUFBUTtRQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUM7SUFDOUYsSUFBSSxPQUFPLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRO1FBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQztJQUM3RSxvQ0FBb0M7SUFDcEMsSUFBSSxPQUFPLE9BQU8sQ0FBQyxVQUFVLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxVQUFVLEtBQUssS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQ3BGLE9BQU8sQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3ZDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxZQUFZLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxPQUFrQixDQUFDLENBQUM7SUFDbEgsbUNBQW1DO0lBQ25DLElBQUksT0FBTyxPQUFPLENBQUMsUUFBUSxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxNQUFNO1FBQUUsS0FBSyxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUMsUUFBUSxDQUFDO0lBQzdHLCtCQUErQjtJQUMvQixJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNiLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM3QixLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ25DLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDbkcsQ0FBQztJQUNELFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNsQixjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdEIsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDL0IsQ0FBQztBQUVEOzs7Ozs7OztHQVFHO0FBQ0gsU0FBUyxtQkFBbUIsQ0FBQyxLQUFjOztJQUN2QyxNQUFNLE9BQU8sR0FBRyxDQUFBLE1BQUEsS0FBSyxDQUFDLFFBQVEsMENBQUUsT0FBTyxNQUFLLElBQUksQ0FBQztJQUNqRCxvQ0FBb0M7SUFDcEMsSUFBSSxDQUFDLE9BQU87UUFBRSxLQUFLLENBQUMsWUFBWSxHQUFHLEtBQUssQ0FBQztJQUN6QyxNQUFNLE1BQU0sR0FBRyxNQUFBLEtBQUssQ0FBQyxJQUFJLDBDQUFFLGFBQWEsQ0FBb0IsZ0JBQWdCLENBQUMsQ0FBQztJQUM5RSxJQUFJLENBQUMsTUFBTTtRQUFFLE9BQU87SUFDcEIsTUFBTSxVQUFVLEdBQUcsQ0FBQyxPQUFPLENBQUM7SUFDNUIsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLFVBQVU7UUFBRSxNQUFNLENBQUMsTUFBTSxHQUFHLFVBQVUsQ0FBQztJQUM3RCxNQUFNLENBQUMsUUFBUSxHQUFHLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxZQUFZLEtBQUssSUFBSSxDQUFDO0FBQzlELENBQUM7QUFFRCxVQUFVO0FBQ1YsS0FBSyxVQUFVLElBQUksQ0FBQyxLQUFjOztJQUM5QixNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUN0QyxNQUFNLFdBQVcsR0FBRyxLQUFLLENBQUMsV0FBVyxDQUFDO0lBQ3RDLDZCQUE2QjtJQUM3QixJQUFJLENBQUMsSUFBSSxJQUFJLFdBQVcsQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU87SUFDOUMsSUFBSSxDQUFBLE1BQUEsS0FBSyxDQUFDLFFBQVEsMENBQUUsTUFBTSxNQUFLLE9BQU8sRUFBRSxDQUFDO1FBQ3JDLFNBQVMsQ0FBQyxLQUFLLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDdEUsT0FBTztJQUNYLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxTQUFTLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDdEIsU0FBUyxDQUFDLEtBQUssRUFBRSx3QkFBd0IsRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN6RSxPQUFPO0lBQ1gsQ0FBQztJQUNELEtBQUssQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztJQUN2QixRQUFRLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3RCLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNkLElBQUksS0FBSyxDQUFDLFVBQVU7UUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUM7SUFDdkQsSUFBSSxDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQWtDLGVBQUcsQ0FBQyxXQUFXLEVBQUU7WUFDeEUsSUFBSTtZQUNKLDZDQUE2QztZQUM3QyxNQUFNLEVBQUUsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztTQUNyRyxDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsQ0FBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsRUFBRSxDQUFBLEVBQUUsQ0FBQztZQUNkLFNBQVMsQ0FBQyxLQUFLLEVBQUUsTUFBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsS0FBSyxtQ0FBSSxNQUFNLEVBQUUsT0FBTyxFQUFFLEVBQUUsRUFBRSxXQUFXLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDMUUsd0NBQXdDO1lBQ3hDLFlBQVksQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQzNDLENBQUM7YUFBTSxDQUFDO1lBQ0osU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQztZQUN2QixrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDLENBQUM7WUFDdkMsS0FBSyxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7WUFDdkIsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDN0IsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFFLFlBQVksQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDO0lBQzNDLENBQUM7WUFBUyxDQUFDO1FBQ1AsSUFBSSxLQUFLLENBQUMsVUFBVTtZQUFFLEtBQUssQ0FBQyxVQUFVLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQztRQUN4RCxLQUFLLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQixnREFBZ0Q7UUFDaEQsS0FBSyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDN0IsQ0FBQztBQUNMLENBQUM7QUFFRCx5Q0FBeUM7QUFDekMsU0FBUyxZQUFZLENBQUMsS0FBYyxFQUFFLElBQVksRUFBRSxXQUF5QjtJQUN6RSxJQUFJLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUM7UUFDcEMsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO1FBQ3pCLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3BCLENBQUM7SUFDRCxJQUFJLFdBQVcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDekIsS0FBSyxDQUFDLFdBQVcsR0FBRyxXQUFXLENBQUM7UUFDaEMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDN0IsQ0FBQztBQUNMLENBQUM7QUFFRCx1REFBdUQ7QUFDdkQsU0FBUyxrQkFBa0IsQ0FBQyxLQUFjLEVBQUUsV0FBeUI7SUFDakUsS0FBSyxNQUFNLElBQUksSUFBSSxXQUFXLEVBQUUsQ0FBQztRQUM3QixLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM1QyxPQUFPLEtBQUssQ0FBQyxVQUFVLENBQUMsSUFBSSxHQUFHLEVBQUUsRUFBRSxDQUFDO1lBQ2hDLE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDOUMsSUFBSSxNQUFNLENBQUMsSUFBSTtnQkFBRSxNQUFNO1lBQ3ZCLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQyxDQUFDO0lBQ0wsQ0FBQztBQUNMLENBQUM7QUFFRCw2QkFBNkI7QUFDN0IsU0FBUyxRQUFRLENBQUMsS0FBMEI7SUFDeEMsS0FBSyxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQzVCLEtBQUssQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFDbEUsQ0FBQztBQUVELHNCQUFzQjtBQUN0QixTQUFTLFNBQVMsQ0FBQyxJQUFZO0lBQzNCLElBQUksQ0FBQztRQUNELElBQUksSUFBSTtZQUFFLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDOztZQUMzQyxZQUFZLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxzQkFBc0I7SUFDMUIsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLFNBQVM7O0lBQ2QsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFBLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLG1DQUFJLEVBQUUsQ0FBQztJQUNqRCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxFQUFFLENBQUM7SUFDZCxDQUFDO0FBQ0wsQ0FBQztBQUVELG1DQUFtQztBQUNuQyxLQUFLLFVBQVUsVUFBVSxDQUFDLEtBQWM7O0lBQ3BDLE1BQU0sT0FBTyxHQUFHLE1BQUEsTUFBQSxLQUFLLENBQUMsUUFBUSwwQ0FBRSxLQUFLLG1DQUFJLE1BQU0sQ0FBQztJQUNoRCxNQUFNLElBQUksR0FBRyxXQUFXLENBQUMsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNsRixNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBOEMsZUFBRyxDQUFDLGNBQWMsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzNHLElBQUksS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLFFBQVE7UUFBRSxLQUFLLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUM7SUFDckQsZUFBZSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3ZCLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzdCLENBQUM7QUFFRCx5QkFBeUI7QUFDekIsU0FBUyxpQkFBaUIsQ0FBQyxLQUFjOztJQUNyQyxNQUFNLE1BQU0sR0FBRyxNQUFBLEtBQUssQ0FBQyxJQUFJLDBDQUFFLGFBQWEsQ0FBb0IsWUFBWSxDQUFDLENBQUM7SUFDMUUsSUFBSSxDQUFDLE1BQU07UUFBRSxPQUFPO0lBQ3BCLE1BQU0sSUFBSSxHQUFHLE1BQUEsTUFBQSxLQUFLLENBQUMsUUFBUSwwQ0FBRSxLQUFLLG1DQUFJLE1BQU0sQ0FBQztJQUM3QyxNQUFNLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QyxNQUFNLENBQUMsS0FBSyxHQUFHLE1BQU0sV0FBVyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7QUFDbkQsQ0FBQztBQUVELHVCQUF1QjtBQUN2QixTQUFTLGNBQWMsQ0FBQyxLQUFjO0lBQ2xDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxZQUFZLENBQUM7SUFDaEMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ1IsT0FBTyxDQUFDLElBQUksQ0FBQyw0Q0FBNEMsQ0FBQyxDQUFDO1FBQzNELE9BQU87SUFDWCxDQUFDO0lBQ0QsS0FBSyxDQUFDLFlBQVksR0FBRyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUM7SUFDekMsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUM7SUFDbEMsSUFBSSxDQUFDLEtBQUssQ0FBQyxZQUFZO1FBQUUsT0FBTztJQUVoQyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDO0lBQ2hDLElBQUksQ0FBQyxXQUFXLEdBQUcsRUFBRSxDQUFDO0lBQ3RCLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNaLElBQUksQ0FBQyxXQUFXLEdBQUcsY0FBYyxDQUFDO1FBQ2xDLE9BQU87SUFDWCxDQUFDO0lBRUQsTUFBTSxLQUFLLEdBQTRCLEVBQUUsR0FBRyxRQUFRLEVBQUUsQ0FBQztJQUV2RCxrQkFBa0I7SUFDbEIsTUFBTSxRQUFRLEdBQUcsQ0FBQyxLQUFvQixFQUFFLEdBQTBCLEVBQUUsS0FBYSxFQUFFLElBQXVCLEVBQVEsRUFBRTs7UUFDaEgsSUFBSSxLQUFLO1lBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsS0FBSyxFQUFFLG9CQUFvQixFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDcEUsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLEtBQUssRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNuQyxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDL0MsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzFCLEtBQUssQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2xCLEtBQUssQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQUEsUUFBUSxDQUFDLEdBQUcsQ0FBQyxtQ0FBSSxFQUFFLENBQUMsQ0FBQztRQUMxQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRTtZQUNqQyxLQUFLLENBQUMsR0FBYSxDQUFDLEdBQUcsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQztRQUNqRixDQUFDLENBQUMsQ0FBQztRQUNILEdBQUcsQ0FBQyxXQUFXLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQixDQUFDLENBQUM7SUFFRixhQUFhO0lBQ2IsTUFBTSxTQUFTLEdBQUcsQ0FBQyxHQUEwQixFQUFFLEtBQWEsRUFBRSxPQUFnQyxFQUFRLEVBQUU7O1FBQ3BHLE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDbkMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQy9DLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM1QixLQUFLLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksT0FBTyxFQUFFLENBQUM7WUFDbEMsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDN0MsTUFBTSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7WUFDckIsTUFBTSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUMvQixDQUFDO1FBQ0QsTUFBTSxDQUFDLEtBQUssR0FBRyxNQUFNLENBQUMsTUFBQSxRQUFRLENBQUMsR0FBRyxDQUFDLG1DQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQzNDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFO1lBQ25DLEtBQUssQ0FBQyxHQUFhLENBQUMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO1FBQ3hDLENBQUMsQ0FBQyxDQUFDO1FBQ0gsR0FBRyxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN4QixJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQztJQUVGLGFBQWE7SUFDYixNQUFNLFdBQVcsR0FBRyxDQUFDLEdBQTBCLEVBQUUsS0FBYSxFQUFRLEVBQUU7UUFDcEUsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLEtBQUssRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNuQyxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDL0MsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzFCLEtBQUssQ0FBQyxJQUFJLEdBQUcsVUFBVSxDQUFDO1FBQ3hCLEtBQUssQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQ3ZDLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFO1lBQ2xDLEtBQUssQ0FBQyxHQUFhLENBQUMsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQ3pDLENBQUMsQ0FBQyxDQUFDO1FBQ0gsR0FBRyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QixJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQztJQUVGLElBQUksQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLEtBQUssRUFBRSxvQkFBb0IsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQ3hELFNBQVMsQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFO1FBQ3JCLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQztRQUNoQixDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUM7UUFDZCxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUM7S0FDbEIsQ0FBQyxDQUFDO0lBQ0gsU0FBUyxDQUFDLFVBQVUsRUFBRSxNQUFNLEVBQUU7UUFDMUIsQ0FBQyxHQUFHLEVBQUUsVUFBVSxDQUFDO1FBQ2pCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztRQUNkLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztRQUNkLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztRQUNkLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztRQUNkLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztRQUNkLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztLQUNqQixDQUFDLENBQUM7SUFFSCxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEVBQUUsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUN4RCxRQUFRLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDL0MsUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ3pDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2xELFFBQVEsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxRQUFRLENBQUMsQ0FBQztJQUVuRCxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEVBQUUsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN6RCxRQUFRLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDMUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQzlDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLFlBQVksRUFBRSxNQUFNLENBQUMsQ0FBQztJQUMvQyxXQUFXLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2pDLFdBQVcsQ0FBQyxpQkFBaUIsRUFBRSxXQUFXLENBQUMsQ0FBQztJQUU1QyxNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQ25DLElBQUksQ0FBQyxXQUFXO1FBQ1osd0RBQXdEO1lBQ3hELDhDQUE4QyxDQUFDO0lBQ25ELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFdkIsTUFBTSxPQUFPLEdBQUcsRUFBRSxDQUFDLEtBQUssRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO0lBQ2hELE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzNDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsS0FBSyxJQUFJLEVBQUU7UUFDdEMsTUFBTSxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQThDLGVBQUcsQ0FBQyxjQUFjLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDakcsSUFBSSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsUUFBUTtZQUFFLEtBQUssQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQztRQUNyRCxlQUFlLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkIsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDekIsS0FBSyxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUM7UUFDM0IsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUM7UUFDbkIsTUFBTSxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDMUIsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQyxDQUFDO0lBQ0gsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsWUFBWSxDQUFDLENBQUM7SUFDckQsTUFBTSxDQUFDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ2xFLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzVDLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDN0QsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ3BDLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDOUIsQ0FBQztBQUVELHNFQUFzRTtBQUV0RSx5QkFBeUI7QUFDekIsU0FBUyxLQUFLLENBQUMsR0FBUTs7SUFDbkIsTUFBTSxDQUFDLEdBQUcsTUFBQSxHQUFHLENBQUMsQ0FBQyxtQ0FBSSxFQUFFLENBQUM7SUFFdEIsc0NBQXNDO0lBQ3RDLE1BQU0sSUFBSSxHQUNOLE1BQUEsTUFBQSxNQUFDLENBQUMsQ0FBQyxJQUFvQixtQ0FDdkIsTUFBQSxNQUFDLENBQUMsQ0FBQyxJQUFvQiwwQ0FBRSxPQUFPLG1EQUFHLFdBQVcsQ0FBQyxtQ0FDL0MsTUFBQyxDQUFDLENBQUMsSUFBb0IsMENBQUUsYUFBYSxtQ0FDdEMsSUFBSSxDQUFDO0lBRVQ7Ozs7OztPQU1HO0lBQ0gsTUFBTSxJQUFJLEdBQUcsQ0FBQyxHQUFXLEVBQXNCLEVBQUU7UUFDN0MsTUFBTSxNQUFNLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBNEIsQ0FBQztRQUNqRCxJQUFJLE1BQU07WUFBRSxPQUFPLE1BQU0sQ0FBQztRQUMxQixNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDaEMsSUFBSSxDQUFDLFFBQVEsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPLElBQUksQ0FBQztRQUNwQyxJQUFJLENBQUM7WUFDRCxPQUFPLElBQUksQ0FBQyxhQUFhLENBQWMsUUFBUSxDQUFDLENBQUM7UUFDckQsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7SUFDTCxDQUFDLENBQUM7SUFFRixNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUNuRSxJQUFJLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDckIseUNBQXlDO1FBQ3pDLE9BQU8sQ0FBQyxJQUFJLENBQ1IseUJBQXlCLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsT0FBTzthQUN2RCxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQzthQUN4QixJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FDckIsQ0FBQztJQUNOLENBQUM7SUFFRCxNQUFNLEtBQUssR0FBWTtRQUNuQixJQUFJO1FBQ0osR0FBRyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDaEIsS0FBSyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUM7UUFDcEIsR0FBRyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDaEIsTUFBTSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUM7UUFDdEIsWUFBWSxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUM7UUFDOUIsSUFBSSxFQUFFLElBQUksQ0FBQyxNQUFNLENBQWdCO1FBQ2pDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUF3QjtRQUMzQyxVQUFVLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBNkI7UUFDdkQsSUFBSSxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUM7UUFDbEIsSUFBSSxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUM7UUFDbEIsVUFBVSxFQUFFLElBQUksQ0FBQyxZQUFZLENBQUM7UUFDOUIsY0FBYyxFQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQztRQUN0QyxPQUFPLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUN4QixXQUFXLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQztRQUNoQyxXQUFXLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQztRQUNoQyxZQUFZLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBNkI7UUFDM0QsR0FBRyxFQUFFLElBQUksR0FBRyxFQUFFO1FBQ2QsT0FBTyxFQUFFLElBQUksR0FBRyxFQUFFO1FBQ2xCLFNBQVMsRUFBRSxJQUFJLEdBQUcsRUFBRTtRQUNwQixjQUFjLEVBQUUsSUFBSSxHQUFHLEVBQUU7UUFDekIsTUFBTSxFQUFFLENBQUM7UUFDVCxNQUFNLEVBQUUsQ0FBQztRQUNULFVBQVUsRUFBRSxDQUFDO1FBQ2IsSUFBSSxFQUFFLENBQUM7UUFDUCxLQUFLLEVBQUUsSUFBSTtRQUNYLE9BQU8sRUFBRSxLQUFLO1FBQ2QsY0FBYyxFQUFFLEtBQUs7UUFDckIsWUFBWSxFQUFFLEtBQUs7UUFDbkIsUUFBUSxFQUFFLElBQUk7UUFDZCxRQUFRLEVBQUUsSUFBSTtRQUNkLFlBQVksRUFBRSxLQUFLO1FBQ25CLFdBQVcsRUFBRSxLQUFLO1FBQ2xCLGNBQWMsRUFBRSxLQUFLO1FBQ3JCLFdBQVcsRUFBRSxDQUFDO1FBQ2QsT0FBTyxFQUFFLElBQUk7UUFDYixRQUFRLEVBQUUsSUFBSTtRQUNkLFdBQVcsRUFBRSxDQUFDO1FBQ2QsZ0JBQWdCLEVBQUUsSUFBSTtRQUN0QixXQUFXLEVBQUUsRUFBRTtRQUNmLFVBQVUsRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDO1FBQy9CLFdBQVcsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUE2QjtRQUN6RCxTQUFTLEVBQUUsQ0FBQztRQUNaLE1BQU0sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDO1FBQ3RCLFVBQVUsRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQzlCLFVBQVUsRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQzlCLFlBQVksRUFBRSxJQUFJLENBQUMsY0FBYyxDQUE0QjtRQUM3RCxVQUFVLEVBQUUsS0FBSztRQUNqQixZQUFZLEVBQUUsSUFBSTtRQUNsQixZQUFZLEVBQUUsRUFBRTtRQUNoQixXQUFXLEVBQUUsRUFBRTtRQUNmLFlBQVksRUFBRSxJQUFJLEdBQUcsRUFBRTtRQUN2QixZQUFZLEVBQUUsSUFBSSxHQUFHLEVBQUU7UUFDdkIsYUFBYSxFQUFFLElBQUksR0FBRyxFQUFFO1FBQ3hCLFdBQVcsRUFBRSxFQUFFO1FBQ2YsY0FBYyxFQUFFLElBQUk7UUFDcEIsVUFBVSxFQUFFLElBQUksR0FBRyxFQUFFO0tBQ3hCLENBQUM7SUFFRixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUM5QixPQUFPLENBQUMsSUFBSSxDQUFDLGdGQUFnRixDQUFDLENBQUM7UUFDL0YsV0FBVyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsUUFBUSxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3RHLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7SUFFRCw2QkFBNkI7SUFDN0IsZUFBZSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3ZCLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRXpCLDZCQUE2QjtJQUM3QixNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbkMsV0FBVyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUVoRCxXQUFXLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBRS9CLE9BQU87SUFDUCxNQUFNLEtBQUssR0FBRyxTQUFTLEVBQUUsQ0FBQztJQUMxQixJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ1IsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQzFCLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDMUIsQ0FBQztJQUVELE1BQUEsS0FBSyxDQUFDLFVBQVUsMENBQUUsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDcEUsS0FBSyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFO1FBQ3ZDLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsU0FBUyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakMsQ0FBQyxDQUFDLENBQUM7SUFDSCxLQUFLLENBQUMsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFNBQVMsRUFBRSxDQUFDLEtBQW9CLEVBQUUsRUFBRTtRQUM3RCxJQUFJLEtBQUssQ0FBQyxHQUFHLEtBQUssT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxDQUFDLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNqRSxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDdkIsS0FBSyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDckIsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUg7Ozs7Ozs7T0FPRztJQUNILE1BQU0sT0FBTyxHQUFHLENBQUMsS0FBcUIsRUFBUSxFQUFFO1FBQzVDLE1BQU0sTUFBTSxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUN4RCxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQztZQUFFLE9BQU87UUFDaEMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQ3ZCLEtBQUssQ0FBQyxlQUFlLEVBQUUsQ0FBQztRQUN4QixXQUFXLENBQUMsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNuRyxLQUFLLFdBQVcsQ0FBQyxLQUFLLEVBQUUsTUFBTSxFQUFFLFdBQVcsQ0FBQyxDQUFDO0lBQ2pELENBQUMsQ0FBQztJQUNGLENBQUMsSUFBSSxhQUFKLElBQUksY0FBSixJQUFJLEdBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxPQUF3QixDQUFDLENBQUM7SUFDekUsS0FBSyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsT0FBd0IsQ0FBQyxDQUFDO0lBRWhFLGlEQUFpRDtJQUNqRCxDQUFDLElBQUksYUFBSixJQUFJLGNBQUosSUFBSSxHQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxLQUFnQixFQUFFLEVBQUU7O1FBQ25FLElBQUksTUFBQSxNQUFBLEtBQUssQ0FBQyxZQUFZLDBDQUFFLEtBQUssMENBQUUsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDL0MsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3ZCLElBQUksSUFBSTtnQkFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksR0FBRyxNQUFNLENBQUM7UUFDekMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0gsQ0FBQyxJQUFJLGFBQUosSUFBSSxjQUFKLElBQUksR0FBSSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsZ0JBQWdCLENBQUMsV0FBVyxFQUFFLEdBQUcsRUFBRTtRQUNwRCxJQUFJLElBQUk7WUFBRSxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO0lBQ3ZDLENBQUMsQ0FBQyxDQUFDO0lBQ0gsQ0FBQyxJQUFJLGFBQUosSUFBSSxjQUFKLElBQUksR0FBSSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxFQUFFLENBQUMsS0FBZ0IsRUFBRSxFQUFFOztRQUMvRCxJQUFJLElBQUk7WUFBRSxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1FBQ25DLE1BQU0sS0FBSyxHQUFHLENBQUEsTUFBQSxLQUFLLENBQUMsWUFBWSwwQ0FBRSxLQUFLLEVBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3BGLE1BQU0sTUFBTSxHQUFHLEtBQUs7YUFDZixNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxDQUFDO2FBQzlELEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBWSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxJQUFJLFVBQVUsS0FBSyxHQUFHLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzlGLElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTztRQUNoQyxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDdkIsS0FBSyxXQUFXLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztJQUM1QyxDQUFDLENBQUMsQ0FBQztJQUVILFdBQVc7SUFDWCxNQUFBLEtBQUssQ0FBQyxXQUFXLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN4RSxNQUFBLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQywwQ0FBRSxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3BGLE1BQUEsSUFBSSxDQUFDLGtCQUFrQixDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7UUFDckQsS0FBSyxDQUFDLFlBQVksQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUMzQixLQUFLLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQzNCLEtBQUssZ0JBQWdCLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ3ZDLENBQUMsQ0FBQyxDQUFDO0lBQ0gsTUFBQSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsMENBQUUsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDLEtBQUsscUJBQXFCLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUMzRixNQUFBLEtBQUssQ0FBQyxZQUFZLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7O1FBQy9DLEtBQUssQ0FBQyxXQUFXLEdBQUcsTUFBQSxNQUFBLEtBQUssQ0FBQyxZQUFZLDBDQUFFLEtBQUssbUNBQUksRUFBRSxDQUFDO1FBQ3BELGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzVCLENBQUMsQ0FBQyxDQUFDO0lBQ0gsTUFBQSxLQUFLLENBQUMsWUFBWSwwQ0FBRSxnQkFBZ0IsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxLQUFvQixFQUFFLEVBQUU7UUFDckUsSUFBSSxLQUFLLENBQUMsR0FBRyxLQUFLLFFBQVE7WUFBRSxZQUFZLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzNELENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBQSxJQUFJLENBQUMsUUFBUSxDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxLQUFLLElBQUksRUFBRTtRQUNqRCxnREFBZ0Q7UUFDaEQsTUFBTSxJQUFJLENBQUMsZUFBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzNCLE1BQU0sWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLE1BQU0sUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBQSxJQUFJLENBQUMsU0FBUyxDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxLQUFLLElBQUksRUFBRTs7UUFDbEQsTUFBTSxPQUFPLEdBQUcsQ0FBQSxNQUFBLEtBQUssQ0FBQyxRQUFRLDBDQUFFLE1BQU0sTUFBSyxTQUFTLElBQUksQ0FBQSxNQUFBLEtBQUssQ0FBQyxRQUFRLDBDQUFFLE1BQU0sTUFBSyxPQUFPLENBQUM7UUFDM0YsSUFBSSxPQUFPLEVBQUUsQ0FBQztZQUNWLG1EQUFtRDtZQUNuRCxNQUFNLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN4QixPQUFPO1FBQ1gsQ0FBQztRQUNELFNBQVMsQ0FBQyxLQUFLLEVBQUUsYUFBYSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3hDLE1BQU0sSUFBSSxDQUFDLGVBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxQixNQUFNLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixDQUFDLENBQUMsQ0FBQztJQUVIOzs7Ozs7O09BT0c7SUFDSCxNQUFBLElBQUksQ0FBQyxjQUFjLENBQUMsMENBQUUsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLEtBQUssSUFBSSxFQUFFOztRQUN2RCxLQUFLLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQztRQUMxQixtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMzQixJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNiLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxHQUFHLFVBQVUsQ0FBQztZQUNwQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsTUFBTSxDQUFDO1FBQ3JDLENBQUM7UUFDRCxJQUFJLENBQUM7WUFDRCxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBdUQsZUFBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQzlGLElBQUksQ0FBQyxDQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxFQUFFLENBQUE7Z0JBQUUsU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLE1BQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLEtBQUssbUNBQUksTUFBTSxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDaEYsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDYixTQUFTLENBQUMsS0FBSyxFQUFFLFFBQVEsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDdkQsQ0FBQztRQUNELE1BQU0sWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLE1BQU0sUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBQSxJQUFJLENBQUMsWUFBWSxDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxLQUFLLElBQUksRUFBRTtRQUNyRCxTQUFTLENBQUMsS0FBSyxFQUFFLDRCQUE0QixFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3ZELElBQUksQ0FBQztZQUNELE1BQU0sSUFBSSxDQUFDLGVBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM5QixDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNiLE9BQU8sQ0FBQyxJQUFJLENBQUMsb0NBQW9DLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdEUsQ0FBQztRQUNELE1BQU0sVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzVCLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBQSxJQUFJLENBQUMsWUFBWSxDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzdFLE1BQUEsSUFBSSxDQUFDLG1CQUFtQixDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3BGLE1BQUEsSUFBSSxDQUFDLGlCQUFpQixDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUM5RSxNQUFBLEtBQUssQ0FBQyxZQUFZLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBRS9FLE1BQUEsSUFBSSxDQUFDLGFBQWEsQ0FBQywwQ0FBRSxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDNUUsTUFBQSxJQUFJLENBQUMsVUFBVSxDQUFDLDBDQUFFLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFLLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBRTFFLDZEQUE2RDtJQUM3RCxNQUFNLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBRXZCLE9BQU8sS0FBSyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxnRUFBZ0U7QUFDaEUsU0FBUyxNQUFNLENBQUMsS0FBYyxFQUFFLE1BQXdCO0lBQ3BELE1BQU0sUUFBUSxHQUFHLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN4QyxLQUFLLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQztJQUNyQixZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEIsSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjLEVBQUUsQ0FBQztRQUN4QixLQUFLLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQztRQUM1QixXQUFXLENBQUMsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxnQkFBZ0IsRUFBRSxDQUFDLENBQUM7SUFDNUYsQ0FBQztJQUNELHNDQUFzQztJQUN0QyxLQUFLLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNyQixLQUFLLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM3QixDQUFDO0FBRUQseUNBQXlDO0FBQ3pDLFNBQVMsZUFBZSxDQUFDLEtBQWM7SUFDbkMsSUFBSSxLQUFLLENBQUMsZ0JBQWdCO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDeEMsSUFBSSxDQUFDO1FBQ0QsTUFBTSxHQUFHLEdBQ0wsTUFBTSxDQUFDLE9BR1YsQ0FBQyxhQUFhLENBQUM7UUFDaEIsSUFBSSxDQUFDLENBQUEsR0FBRyxhQUFILEdBQUcsdUJBQUgsR0FBRyxDQUFFLG9CQUFvQixDQUFBO1lBQUUsT0FBTyxLQUFLLENBQUM7UUFDN0MsTUFBTSxPQUFPLEdBQUcsQ0FBQyxNQUFlLEVBQVEsRUFBRSxDQUFDLGNBQWMsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFDekUsR0FBRyxDQUFDLG9CQUFvQixDQUFDLDZCQUFpQixFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ3JELEtBQUssQ0FBQyxnQkFBZ0IsR0FBRyxPQUFPLENBQUM7UUFDakMsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7QUFDTCxDQUFDO0FBRUQsbUNBQW1DO0FBQ25DLFNBQVMsWUFBWSxDQUFDLEtBQWM7O0lBQ2hDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTztRQUFFLE9BQU87SUFDM0IsSUFBSSxLQUFLLENBQUMsS0FBSztRQUFFLFlBQVksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0MsTUFBTSxLQUFLLEdBQUcsQ0FBQSxNQUFBLEtBQUssQ0FBQyxRQUFRLDBDQUFFLE9BQU8sRUFBQyxDQUFDLENBQUMsdUJBQXVCLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDO0lBQ25GLEtBQUssQ0FBQyxLQUFLLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBQzVELENBQUM7QUFFRCxxQ0FBcUM7QUFDckMsS0FBSyxVQUFVLElBQUksQ0FBQyxLQUFjO0lBQzlCLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTztRQUFFLE9BQU87SUFDM0IsS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUM7SUFDaEIsTUFBTSxPQUFPLEdBQUcsTUFBTSxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdEMsSUFBSSxPQUFPLElBQUksS0FBSyxDQUFDLElBQUksR0FBRyxpQkFBaUIsS0FBSyxDQUFDO1FBQUUsTUFBTSxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDL0UsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3hCLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFTLFlBQVksQ0FBQyxLQUFjO0lBQ2hDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7SUFDeEIsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDRCxPQUFPLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxZQUFZLEdBQUcsQ0FBQyxDQUFDO0lBQ3JFLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0FBQ0wsQ0FBQztBQUVELGtDQUFrQztBQUNsQyxTQUFTLEtBQUssQ0FBQyxLQUFjLEVBQUUsU0FBNEIsTUFBTTs7SUFDN0QsSUFBSSxNQUFNLEtBQUssTUFBTSxJQUFJLFlBQVksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzNDLHlCQUF5QjtRQUN6QixXQUFXLENBQUMsRUFBRSxJQUFJLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFDO1FBQzVELE9BQU87SUFDWCxDQUFDO0lBQ0QsS0FBSyxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUM7SUFDdEIsSUFBSSxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDZCxZQUFZLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLEtBQUssQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO0lBQ3ZCLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3pCLElBQUksQ0FBQztZQUNELE1BQU0sR0FBRyxHQUNMLE1BQU0sQ0FBQyxPQUdWLENBQUMsYUFBYSxDQUFDO1lBQ2hCLE1BQUEsR0FBRyxhQUFILEdBQUcsdUJBQUgsR0FBRyxDQUFFLHVCQUF1QixvREFBRyw2QkFBaUIsRUFBRSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUM5RSxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsUUFBUTtRQUNaLENBQUM7UUFDRCxLQUFLLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQ2xDLENBQUM7SUFDRCxXQUFXLENBQUMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFDNUMsQ0FBQztBQUVELE1BQU0sQ0FBQyxPQUFPLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDakMsU0FBUyxFQUFFO1FBQ1A7Ozs7Ozs7O1dBUUc7UUFDSCxJQUFJO1lBQ0EsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSztnQkFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3JDLENBQUM7UUFDRCxJQUFJO1lBQ0EsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSztnQkFBRSxLQUFLLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3BDLENBQUM7S0FDSjtJQUVELFFBQVEsRUFBRSxVQUFVLENBQUMsNkJBQTZCLENBQUM7SUFDbkQsS0FBSyxFQUFFLFNBQVMsRUFBRTtJQUVsQixrQ0FBa0M7SUFDbEMsdURBQXVEO0lBQ3ZELHNEQUFzRDtJQUN0RCxDQUFDLEVBQUUsU0FBUztJQUVaLE9BQU8sRUFBRSxFQUFFO0lBRVg7Ozs7OztPQU1HO0lBQ0gsS0FBSzs7UUFDRCxJQUFJLEtBQWMsQ0FBQztRQUNuQixJQUFJLENBQUM7WUFDRCxLQUFLLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hCLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2IsTUFBTSxLQUFLLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFBLEtBQUssQ0FBQyxLQUFLLG1DQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3RGLE9BQU8sQ0FBQyxLQUFLLENBQUMscUJBQXFCLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDNUMsV0FBVyxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ2pFLE9BQU87UUFDWCxDQUFDO1FBQ0QsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDM0IsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMxQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEU0gg5a+56K+d6Z2i5p2/77yI5riy5p+T6L+b56iL77yJ44CCXG4gKlxuICogIyMg5a6D5piv5LuA5LmIXG4gKlxuICog5YGc6Z2g5ZyoIEluc3BlY3RvciDml4HovrnnmoTkuIDkuKrogYrlpKnmoYbvvJror7TnmoTmr4/lj6Xor53kuqTnu5nkuLvov5vnqIvmiZjnrqHnmoTpgqPlj6ogRFNIIGFnZW5077yMXG4gKiBhZ2VudCDlj4jog73pgJrov4cgYGNvY29zX2V4ZWN1dGVfY29kZWAg55u05o6l5pON5L2cKirkvaDmraPlvIDnnYDnmoTov5nkuKrnvJbovpHlmagqKuOAglxuICpcbiAqICMjIOinguaEn+WPo+W+hO+8muaKhCBEU0jvvIzkuI3ltYwgRFNIXG4gKlxuICog5pu+6K+E5Lyw6L+H44CM5oqKIGBkc2ggd2ViYCDnlKggaWZyYW1lIOW1jOi/m+mdouadv+OAjeKAlOKAlCDlkKblhrPjgILnkIbnlLHmmK/noaznmoTvvJrpgqPlpZfliY3nq6/mmK9cbiAqIHdlYnNlcnZlciArIFdTICsg5a6i5oi356uv5qih5Z2X5Yqo5oCB5Yqg6L2955qE5LiA5pW05aWXIGhvc3TvvIh3ZWIgcHJvZmlsZSDmnIkgNTcg5Liq5o+S5Lu277yJ77yMXG4gKiDltYzov5vmnaXlsLHnrYnkuo7lho3otbfkuIDku70gYWdlbnTvvIjkvJror53jgIHorr7nva7jgIHlt6XlhbflhajliIblrrbvvInvvIzogIzkuJTlroPnmoQgQ1NTIOmHjFxuICogKirkuIDmnaHlk43lupTlvI/lqpLkvZPmn6Xor6Lpg73msqHmnIkqKu+8iOWPquaciSBwcmVmZXJzLXJlZHVjZWQtbW90aW9u77yJ77yM5LiJ5qCP5bqU55So5aGe6L+bXG4gKiDpnaLmnb/lrr3luqblv4XnhLbmjKTjgILmiYDku6XotbDjgIzpnaLmnb/oh6rnu5ggKyDmioTlroPnmoTorr7orqHns7vnu5/jgI3vvJpcbiAqXG4gKiAxLiAqKuiuvuiuoSB0b2tlbiDnm7TmjqXmir0qKu+8mmBzdGF0aWMvc3R5bGUvZGVmYXVsdC9kc3ctdG9rZW5zLmNzc2Ag55SxXG4gKiAgICBgc2NyaXB0cy9leHRyYWN0LWRzdy10b2tlbnMuanNgIOS7jiBgQGRlZXBzZWVrLWFpL2RzaC1jbGllbnQtdWktdGhlbWVgIOmHjOaKoOWHuuadpVxuICogICAg77yI6Imy5p2/IOKGkiDor63kuYnliKvlkI3jgIHmmI7mmpfkuKTlpZfjgIHlrZflj7fpmLbmoq/jgIFlbGV2YXRpb27jgIHmu5rliqjmnaHvvInvvIzkuIDmnaHkuI3miYvmioTvvJtcbiAqIDIuICoq5riy5p+T5qih5Z6L54Wn5oqEKirvvJrnlKjmiLfmsJTms6EgLyDliqnmiYsgbWFya2Rvd24gLyDmipjlj6DnmoTmgJ3ogIPlnZcgLyDmjInlt6XlhbflkI3liIbnsbvnmoTlt6XlhbfljaHniYdcbiAqICAgIO+8iOingSBgdG9vbC1jYXJkLnRzYO+8iS8g5Zub5oCB5LiO6ICX5pe2IC8g5Luj56CB5Z2X5bimIGJhbm5lciDkuI7lpI3liLYg4oCU4oCUIOi/meS6m+ato+aYryBEU0ggd2ViIOWuouaIt+err1xuICogICAg55qE5a+56K+d5Yy65Zyo5YGa55qE5LqL77yM6ICM5oiR5Lus5ZCD55qE5pivKirlkIzkuIDmnaHkuovku7bmtYEqKu+8iGBTZXNzaW9uRXZlbnRMaWtlRW50cnlg77yJ44CCXG4gKlxuICogIyMg5LqU5p2h5a6e546w5Y+j5b6EXG4gKlxuICogMS4gKirpm7bkvp3otZYqKu+8muS4jeW8lSBWdWUvUmVhY3TvvIzlj6rnlKggRE9N44CC5aSa5Ye65p2l55qE5Lik5Liq5YWE5byf5paH5Lu277yIYG1hcmtkb3duLnRzYCAvXG4gKiAgICBgdG9vbC1jYXJkLnRzYO+8ieeUqOebuOWvuSByZXF1aXJlIOW8le+8iOmdouadvyBkaXN0IOaYryBDb21tb25KU++8jOiDveino+aekOWQjOe6p+aWh+S7tu+8ieOAglxuICogMi4gKirlhYPntKDkuIDlvovotbAgYEVkaXRvci5QYW5lbC5kZWZpbmVgIOeahCBgJGAg6YCJ5oup5ZmoKirvvIhgY3R4LiQueHh4YO+8ieOAglxuICogICAg4pqgICoq6Lip6L+H55qE5Z2RKirvvJpgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jhbm5lcicpYCDlnKjov5nkuKrnjq/looPph4wqKui/lOWbniBudWxsKirvvIjmqKHmnb/kuI3lnKhcbiAqICAgIOaZrumAmuaWh+aho+agkemHjO+8jGBnZXRFbGVtZW50QnlJZGAg5om+5LiN5Yiw77yJ77yM6ICMIGAkYCDmmK/nvJbovpHlmajlnKjpnaLmnb/lrZDmoJHph4zop6PmnpDnmoTjgIHlj6/pnaDjgIJcbiAqICAgIOesrOS4gOeJiOeUqCBgZ2V0RWxlbWVudEJ5SWRgIOaLv+eKtuaAgeeCuS/mqKrluYUg4oaSIOS4gOi/m+mdouadvyBgcmVmcmVzaFN0YXRlYCDlsLHmiptcbiAqICAgIGBDYW5ub3Qgc2V0IHByb3BlcnRpZXMgb2YgbnVsbCAoc2V0dGluZyAndGV4dENvbnRlbnQnKWDvvIzmlbTlnZcgVUkg5YW25a6e5piv5q2755qE44CCXG4gKiAgICAqKue7k+iuuu+8mumdouadv+mHjOS4jeimgeeUqCBgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQvcXVlcnlTZWxlY3RvcmAg5om+6Z2i5p2/5YWD57Sg44CCKipcbiAqICAgIO+8iOWFg+e0oCoq5YaF6YOoKirmn6Xor6Llj6/ku6XvvJpgZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcuZHNoLXRoaW5rJylgIOaYr+aLv+WcqOiHquW3seaJi+mHjOeahOWtkOagkeOAgu+8iVxuICogMy4gKirkuKTmnaHmm7TmlrDot68qKu+8muS4u+i/m+eoi+W5v+aSre+8iGBkc2hfY2hhdDpldmVudGDvvIzlv6vvvIkgKiorKiog6L2u6K+iIGBnZXQtZXZlbnRzYO+8iOeos++8ieOAglxuICogICAg5Lik5p2h6Lev6YO95bm26L+b5ZCM5LiA5Lu9IGBNYXA8c2VxLCBFbnRyeT5g77yM6Z2gIGBzZXFgIC8gYHJldmAg5bmC562J44CCXG4gKiA0LiAqKuWPqumHjee7mOWPmOWMlueahOadoeebrioq77yaYHNlcSDihpIg5YWD57SgYCDkuIDkuIDlr7nlupTvvIzmtYHlvI/lop7ph4/ljp/lnLDmm7/mjaLor6XmnaHnm67nmoTlhoXlrrnvvIxcbiAqICAgIOS4jeaVtOWxj+mHjeaOku+8iOWQpuWImei+k+WFpeeEpueCueWSjOa7muWKqOS9jee9rumDveS8mui3s++8ieOAguWxleW8gC/mlLbotbfov5nnsbsqKuS6pOS6kueKtuaAgSoq5Y+m5a2Y5ZyoXG4gKiAgICBgTWFwPHNlcSwgYm9vbGVhbj5gIOmHjO+8jOi3qOmHjee7mOS/neeVmeOAglxuICogNS4gKirlj5bkuI3liLDlhYPntKDkuZ/lj6ogd2FybiDkuI3mipvvvIzlubbmioroh6rmo4DmiqXnu5nkuLvov5vnqIsqKu+8iGBwYW5lbC1wcm9iZWDvvInvvJrpnaLmnb/mipvplJnkvJrmsaHmn5NcbiAqICAgIOe8lui+keWZqOaOp+WItuWPsO+8jOiAjOeUqOaIt+aLv+S4jeWIsOS7u+S9leWPr+eUqOS/oeaBr++8m+iHquajgOWbnuS8oOiuqeOAjOmdouadv+mHjOWIsOW6leaAjuS5iOS6huOAjeiDveiiq+WklumDqOivu+WIsOOAglxuICpcbiAqICMjIOi3r+W+hOWPo+W+hFxuICpcbiAqIOe8luivkeS6p+eJqeWcqCBgZGlzdC9wYW5lbHMvZGVmYXVsdC9pbmRleC5qc2DvvIzmiYDku6XpnZnmgIHotYTmupDku44gYF9fZGlybmFtZWAg5b6A5LiK5LiJ57qn5Zue5omp5bGV5qC577yMXG4gKiDlho3ov5sgYHN0YXRpYy9g44CC5pS555uu5b2V57uT5p6E5pe26L+Z5Yeg5LiqIGpvaW4g6KaB5LiA6LW35pS544CCXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQge1xuICAgIEJST0FEQ0FTVF9DSEFOTkVMLFxuICAgIEVYVEVOU0lPTl9OQU1FLFxuICAgIE1TRyxcbiAgICBQUk9GSUxFX05BTUUsXG4gICAgdHlwZSBBZ2VudFNuYXBzaG90LFxuICAgIHR5cGUgQWdlbnRTdGF0dXMsXG4gICAgdHlwZSBEc2hDaGF0U2V0dGluZ3MsXG4gICAgdHlwZSBFbnRyeSxcbiAgICB0eXBlIEVudHJ5SW1hZ2UsXG4gICAgdHlwZSBIaXN0b3J5U2Vzc2lvblZpZXcsXG4gICAgdHlwZSBIb3N0VXBkYXRlVmlldyxcbiAgICB0eXBlIEltYWdlTWltZVR5cGUsXG4gICAgdHlwZSBQYW5lbFRoZW1lLFxufSBmcm9tICcuLi8uLi9jb25zdGFudHMnO1xuaW1wb3J0IHtcbiAgICBJTUFHRV9NSU1FX0JZX0VYVCxcbiAgICBNQVhfSU1BR0VfQllURVMsXG4gICAgTUFYX0lNQUdFU19QRVJfTUVTU0FHRSxcbiAgICBNQVhfTElTVEVEX0lNQUdFUyxcbiAgICBmaWx0ZXJQcm9qZWN0SW1hZ2VzLFxuICAgIGZvcm1hdEJ5dGVzLFxuICAgIHR5cGUgUHJvamVjdEltYWdlLFxufSBmcm9tICcuLi8uLi9pbWFnZXMnO1xuaW1wb3J0IHsgcmVuZGVyTWFya2Rvd24gfSBmcm9tICcuL21hcmtkb3duJztcbmltcG9ydCB7IGNyZWF0ZVRvb2xDYXJkLCBkZWZhdWx0T3BlbiB9IGZyb20gJy4vdG9vbC1jYXJkJztcblxuLyoqIOmdmeaAgei1hOa6kOagueOAgiAqL1xuY29uc3QgU1RBVElDX1JPT1QgPSBqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYycpO1xuXG4vKiog5LuO5omp5bGV5qC56K+75LiA5Lu96Z2Z5oCB5paH5Lu244CCICovXG5mdW5jdGlvbiByZWFkU3RhdGljKHJlbGF0aXZlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGpvaW4oU1RBVElDX1JPT1QsIHJlbGF0aXZlUGF0aCksICd1dGYtOCcpO1xufVxuXG4vKipcbiAqIOmdouadv+agt+W8jyA9ICoqdG9rZW4g5bGCICsg57uE5Lu25bGCKirjgIJcbiAqXG4gKiB0b2tlbiDlsYLmmK/ohJrmnKzku47lt7Llronoo4XnmoQgRFNIIOmHjOaKveWHuuadpeeahO+8iOingSBgc2NyaXB0cy9leHRyYWN0LWRzdy10b2tlbnMuanNg77yJ77yMXG4gKiDnu4Tku7blsYLmmK/miYvlhpnnmoTjgIHlj6rmtojotLkgdG9rZW7jgILliIblvIDnmoTnkIbnlLHvvJpEU0gg5Y2H54mI5pys5pe26YeN6LeR6ISa5pys5Y2z5Y+v77yMXG4gKiDmiYvlhpnnmoTnu4Tku7bmoLflvI/kuI3kvJrooqvopobnm5bjgIJcbiAqL1xuZnVuY3Rpb24gcmVhZFN0eWxlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke3JlYWRTdGF0aWMoJ3N0eWxlL2RlZmF1bHQvZHN3LXRva2Vucy5jc3MnKX1cXG4ke3JlYWRTdGF0aWMoJ3N0eWxlL2RlZmF1bHQvaW5kZXguY3NzJyl9YDtcbn1cblxuLyoqXG4gKiDimqAgKirkuKTmnaHot6/nmoTlnLDkvY0qKu+8iOi4qei/h+eahOWdke+8jOingeaWh+S7tuWktOesrCAzIOadoe+8ie+8mui9ruivouaYryoq5Li76LevKirvvIzlub/mkq3mmK/liqDpgJ/jgIJcbiAqIOmdouadvyoq5b+F6aG76Ieq5bex5ZyoIGBtb3VudGAg6YeM5oqK6L2u6K+i6LW36LW35p2lKiog4oCU4oCUIOabvue7j+WPquaMguWcqCBgbGlzdGVuZXJzLnNob3dgIOS4iu+8jFxuICog57uT5p6c6YKj5Liq6ZKp5a2Q5rKh5ZyoIGByZWFkeWAg5LmL5ZCO6Kem5Y+R77yM6L2u6K+i5qC55pys5rKh6LeR77yM55eH54q25piv44CM5LiK5LiA6L2u55qE5Zue5aSN6KaB562J5LiL5LiA5qyh5Y+R6YCBXG4gKiDmiY3mlbTmrrXlhpLlh7rmnaXjgI3vvIhgc2VuZCgpYCDph4zpgqPmrKEgYHBvbGxPbmNlYCDmiJDkuobllK/kuIDnmoTliLfmlrDngrnvvInjgIJcbiAqIOepuumXsiA4MDBtc+OAgei3keWKqCAzMDBtc++8mui3keWKqOaXtuWvhuS4gOeCuea1geW8j+aJjemhuu+8iOaooeWei+Wunua1iyB+MjAwIOWtly8yNTBtc++8ieOAglxuICovXG5jb25zdCBQT0xMX0lOVEVSVkFMX01TID0gODAwO1xuXG4vKiog6LeR5Yqo5pe255qE6L2u6K+i6Ze06ZqU77yI5q+r56eS77yJ44CCICovXG5jb25zdCBQT0xMX0lOVEVSVkFMX0FDVElWRV9NUyA9IDMwMDtcblxuLyoqIOavj+WHoOasoei9ruivoumhuuW4puWIt+S4gOasoeeKtuaAge+8iOavlOaLiei9rOWGmei0teS4gOeCue+8ie+8m+acieaWsOadoeebruaXtuW9k+i9ruWwseWIt+OAgiAqL1xuY29uc3QgU1RBVEVfRVZFUllfVElDS1MgPSA1O1xuXG4vKiog6I2J56i/5a2Y5Zyo5rWP6KeI5Zmo5pys5Zyw77yI5oyJ5omp5bGV5ZCN5YiG6ZSu77yJ77yM6Z2i5p2/5YWz5o6J5YaN5byA5LiN5Lii44CCICovXG5jb25zdCBEUkFGVF9LRVkgPSBgJHtFWFRFTlNJT05fTkFNRX06ZHJhZnRgO1xuXG4vKipcbiAqIOWbvueJh+eahOWbm+S4qumihOeul+aVsOWtl++8iCoq5LiOIGBzb3VyY2UvaW1hZ2VzLnRzYCAvIERTSCDpmYTku7blupPlkIzlj6PlvoQqKu+8jOWPquaciei/meS4gOWkhOaUue+8ieOAglxuICpcbiAqIHwg5pWw5a2XIHwg5Li65LuA5LmI5piv6L+Z5Liq5YC8IHxcbiAqIHwtLS18LS0tfFxuICogfCBgbWF4UGl4ZWxzYCAyMDQ4w5cyMDQ4IHwgRFNIIOW9kuS4gOWMluWQjuWwseaYr+i/meS4qumihOeul++8iGBub3JtYWxpemVkSW1hZ2VNYXhQaXhlbHNg77yJ44CCKirpnaLmnb/lhYjnvKnliLDkvY0qKu+8jOWIq+aKiiA0SyDmiKrlm77mlbTkuKrloZ7ov5sgSVBDIOWGjeiuqeWug+e8qSDigJTigJQg6YKj5piv5Y2B5YegIE1CIOeahOWtl+espuS4su+8jOmdouadv+WSjOWtkOi/m+eoi+mDveimgeeZveaJm+S4gOmBjSB8XG4gKiB8IGBtYXhTaWRlYCA0MDk2IHwg5p6B56uv6ZW/5p2h5Zu+77yIMjcwMMOXMjAwMDAg55qE5oiq5Zu+77yJ5oyJ5YOP57Sg6aKE566X57yp5a6M6L+Y5Ymp5b6I6ZW/55qE6L6577yM5YaN5aS55LiA6YGTIHxcbiAqIHwgYG5vcm1hbGl6ZWRNYXhCeXRlc2AgNE1CIHwgRFNIIOW9kuS4gOWMluWQjueahOe8lueggeebruagh++8iGBub3JtYWxpemVkSW1hZ2VNYXhCeXRlc2DvvInjgILotoXkuoblsLHlvoDkuIvotbAgd2VicCAvIEpQRUcg6LSo6YeP5qKv5a2Q77yI6KeBIGBlbmNvZGVDYW52YXNg77yJIHxcbiAqIHwgYHRodW1iU2lkZWAgMTI4IHwg6L6T5YWl5Yy6L+mAieaLqeWZqOmHjOeahOe8qeeVpeWbvui+uemVv++8jOWPquW9seWTjeinguaEn+S4juWGheWtmCB8XG4gKi9cbmNvbnN0IElNQUdFX0JVREdFVCA9IHtcbiAgICBtYXhQaXhlbHM6IDIwNDggKiAyMDQ4LFxuICAgIG1heFNpZGU6IDQwOTYsXG4gICAgbm9ybWFsaXplZE1heEJ5dGVzOiA0ICogMTAyNCAqIDEwMjQsXG4gICAgdGh1bWJTaWRlOiAxMjgsXG59IGFzIGNvbnN0O1xuXG4vKiogSlBFRyDotKjph4/moq/lrZDvvIjkvp3mrKHor5XvvIzlj5bnrKzkuIDkuKrov5vpooTnrpfnmoTvvInjgILlj6rlnKjjgIxQTkcg5aSq5aSn44CN5oiW5rqQ5pys5p2l5bCx5pivIEpQRUcg5pe255So44CCICovXG5jb25zdCBKUEVHX0xBRERFUiA9IFswLjkyLCAwLjgsIDAuNywgMC42XTtcblxuLyoqIOmAieaLqeWZqOmHjOacgOWkmuWQjOWHoOi3r+ivu+Wbvu+8iOavj+W8oOmDveaYr+S4gOasoSBJUEMgKyDkuIDmrKHop6PnoIHvvIzlubblj5Hpq5jkuobpnaLmnb/kvJrljaHvvInjgIIgKi9cbmNvbnN0IFRIVU1CX0NPTkNVUlJFTkNZID0gMztcblxuLyoqIOe8qeeVpeWbvue8k+WtmOadoeaVsOS4iumZkO+8iOavj+adoeaYr+S4gOS4quWwjyBkYXRhIFVSTO+8jOWHoOWNgSBLQiDnuqfliKvvvInjgIIgKi9cbmNvbnN0IFRIVU1CX0NBQ0hFX0xJTUlUID0gMjAwO1xuXG4vKipcbiAqIOaPkOekuuadoeeahCoq5pyA55+t5YGc55WZ5pe26Ze0KirvvIjmr6vnp5LvvInigJTigJQg6KeBIGBzZXRCYW5uZXJgIOeahCBgaG9sZE1zYOOAglxuICpcbiAqIOWIhuW8gOS4pOaho+eahOeQhueUse+8mumUmeivr+imgeivu+WIsO+8iDEycyDlpJ/nnIvmuIXjgIHlj4jkuI3kvJrkuIDnm7TmjILlnKjpgqPlhL/vvInvvIxcbiAqIOiAjOOAjOW3sue7j+WcqOWIl+ihqOmHjOS6huOAjei/meexu+ehruiupOS/oeaBryA0IOenkui2s+Wkn+OAglxuICovXG5jb25zdCBCQU5ORVJfSE9MRCA9IHsgSU5GTzogNDAwMCwgRVJST1I6IDEyXzAwMCB9IGFzIGNvbnN0O1xuXG4vKiog54q25oCB54K5L+aWh+ahiOOAgiAqL1xuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxBZ2VudFN0YXR1cywgc3RyaW5nPiA9IHtcbiAgICBzdG9wcGVkOiAn5pyq5ZCv5YqoJyxcbiAgICBpbnN0YWxsaW5nOiAn5YeG5aSHIHByb2ZpbGXigKYnLFxuICAgIHN0YXJ0aW5nOiAn5ZCv5Yqo5Lit4oCmJyxcbiAgICByZWFkeTogJ+Wwsee7qicsXG4gICAgc3RvcHBpbmc6ICflgZzmraLkuK3igKYnLFxuICAgIGVycm9yOiAn5Ye66ZSZJyxcbn07XG5cbi8qKiDlpJbop4LmjInpkq7kuIrnmoTkuInmoaPlvqrnjq/vvIh0aXRsZSDnlKjvvInjgIIgKi9cbmNvbnN0IFRIRU1FX0NZQ0xFOiBQYW5lbFRoZW1lW10gPSBbJ2F1dG8nLCAnZGFyaycsICdsaWdodCddO1xuY29uc3QgVEhFTUVfTEFCRUw6IFJlY29yZDxQYW5lbFRoZW1lLCBzdHJpbmc+ID0geyBhdXRvOiAn6Lef6ZqP57O757ufJywgZGFyazogJ+a3seiJsicsIGxpZ2h0OiAn5rWF6ImyJyB9O1xuY29uc3QgVEhFTUVfR0xZUEg6IFJlY29yZDxQYW5lbFRoZW1lLCBzdHJpbmc+ID0geyBhdXRvOiAn4peQJywgZGFyazogJ+KXjycsIGxpZ2h0OiAn4peLJyB9O1xuXG4vKiog5Li76L+b56iL6L+U5Zue55qE54q25oCB5YyF44CCICovXG5pbnRlcmZhY2UgU3RhdGVSZXBseSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgZXh0ZW5zaW9uPzogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgcm9vdD86IHN0cmluZyB9O1xuICAgIGFnZW50PzogQWdlbnRTbmFwc2hvdDtcbiAgICBzZXR0aW5ncz86IERzaENoYXRTZXR0aW5ncztcbiAgICAvKiog5pyA6L+R5LiA5qyh5oqKIGBkc2gtcHJvZmlsZS9gIOWQjOatpeWIsCBgJERTSF9IT01FYCDnmoTnu5PmnpzjgIIgKi9cbiAgICBwcm9maWxlPzogeyBvazogYm9vbGVhbjsgcHJvZmlsZURpcj86IHN0cmluZzsgdmVyc2lvbj86IHN0cmluZzsgY2hhbmdlcz86IHN0cmluZ1tdOyBlcnJvcj86IHN0cmluZyB9O1xuICAgIC8qKiDpnaLmnb/oh6rmo4Dljoblj7LvvIjkuLvov5vnqIvmlLbnmoTvvIzop4EgYHBhbmVsUHJvYmVg77yJ44CCICovXG4gICAgcGFuZWw/OiBBcnJheTx7IGF0OiBudW1iZXI7IGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0+O1xufVxuXG4vKipcbiAqIOi+k+WFpeWMuumHjCoq5b6F5Y+R6YCBKirnmoTkuIDlvKDlm77jgIJcbiAqXG4gKiDkuI4gYGNvbnN0YW50cy50c2Ag55qEIGBTZW5kSW1hZ2VgIOeahOWMuuWIq++8mumCo+S4gOS4quaYr+OAjOWNj+iuruS4iuecn+ato+S8muS8oOWHuuWOu+eahOS4nOilv+OAje+8iOS4pOS4quWtl+aute+8ie+8jFxuICog6L+Z5LiA5Liq6L+Y5bim552A6Z2i5p2/6Ieq5bex6KaB55So55qE5Lic6KW/IOKAlOKAlCDnvKnnlaXlm77jgIHlg4/ntKDlsLrlr7jjgIHmnaXmupDjgIIqKuWkmuWHuuadpeeahOWtl+auteS4gOW+i+S4jei/myBJUEMg55qE5Zu+KirjgIJcbiAqL1xuaW50ZXJmYWNlIEF0dGFjaG1lbnQge1xuICAgIC8qKiDpnaLmnb/mnKzlnLDouqvku73vvIjljrvph40v5Yig6Zmk55So77yb5ZCM5ZCN55qE5Lik5byg5Ymq6LS05p2/5Zu+5LiN6IO95LqS55u46aG25o6J77yJ44CCICovXG4gICAgaWQ6IHN0cmluZztcbiAgICAvKiog5pi+56S65ZCN77yI5bel56iL5Zu+5piv5paH5Lu25ZCN77yM5Ymq6LS05p2/5Zu+5piv44CM5Ymq6LS05p2/5Zu+54mHLTEucG5n44CN77yJ44CCICovXG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG1pbWVUeXBlOiBJbWFnZU1pbWVUeXBlO1xuICAgIC8qKiAqKuinhOiMgyoqIGJhc2U2NO+8iOaXoCBgZGF0YTpgIOWJjee8gOOAgeaXoOaNouihjO+8ieKAlOKAlCDpmYTku7blupPnmoTop6PnoIHlmajlj6rorqTov5nkuIDnp43jgIIgKi9cbiAgICBkYXRhOiBzdHJpbmc7XG4gICAgLyoqIOino+eggeWQjueahOWtl+iKguaVsOOAgiAqL1xuICAgIGJ5dGVzOiBudW1iZXI7XG4gICAgd2lkdGg6IG51bWJlcjtcbiAgICBoZWlnaHQ6IG51bWJlcjtcbiAgICAvKiog5bCP5Zu+IGRhdGEgVVJM77yI5Y+q55So5LqO5pi+56S677yJ44CCICovXG4gICAgdGh1bWI6IHN0cmluZztcbiAgICBvcmlnaW46ICdjbGlwYm9hcmQnIHwgJ3Byb2plY3QnIHwgJ2Ryb3AnO1xuICAgIC8qKiDlvZLkuIDljJbml7blgZrov4fku4DkuYjvvIjjgIzlt7LnvKnliLAgMjA0OMOXMTE1MuOAjeOAjFBORyDihpIgSlBFR+OAje+8ie+8jOaYvuekuuWcqOeijueJh+S4iue7meS6uuS4gOS4quS6pOS7o+OAgiAqL1xuICAgIG5vdGU/OiBzdHJpbmc7XG59XG5cbi8qKiDkuIDmrKHpnaLmnb/lrp7kvovnmoTlhajpg6jlj6/lj5jnirbmgIHjgILlhYPntKDlvJXnlKjlhajpg6jmnaXoh6ogYCRg77yI6KeB5paH5Lu25aS056ysIDIg5p2h77yJ44CCICovXG5pbnRlcmZhY2UgVWlTdGF0ZSB7XG4gICAgcm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGRvdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIHRpdGxlOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgc3ViOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgYmFubmVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgc2V0dGluZ3NIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgYm9keTogSFRNTEVsZW1lbnQ7XG4gICAgaW5wdXQ6IEhUTUxUZXh0QXJlYUVsZW1lbnQ7XG4gICAgc2VuZEJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIGxpdmU6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBtZXRhOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgZWxzOiBNYXA8bnVtYmVyLCBIVE1MRWxlbWVudD47XG4gICAgZW50cmllczogTWFwPG51bWJlciwgRW50cnk+O1xuICAgIC8qKiDlsZXlvIAv5pS26LW377ya5bel5YW35Y2h54mH5LiO5oCd6ICD5Z2X77yI5oyJIHNlcSDorrDvvIzot6jph43nu5jkv53nlZnvvInjgIIgKi9cbiAgICBvcGVuVG9vbHM6IE1hcDxudW1iZXIsIGJvb2xlYW4+O1xuICAgIGNvbGxhcHNlZFRoaW5rOiBNYXA8bnVtYmVyLCBib29sZWFuPjtcbiAgICBtYXhSZXY6IG51bWJlcjtcbiAgICBtYXhTZXE6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiDovazlhpnku6PmlbAg4oCU4oCUIOS4u+i/m+eoi+mCo+i+uSBgcmVzZXRUcmFuc2NyaXB0KClgIOS8miArMe+8iOaNouS8muivneOAgeWbnuaUvuWOhuWPsu+8ieOAglxuICAgICAqXG4gICAgICog6Z2i5p2/5Y+q5oyJIGByZXZgIOWPluWinumHj++8jOOAjOafkOadoeiiq+WIoOaOieOAjei/meS7tuS6i+ihqOi+vuS4jeWHuuadpe+8jOaJgOS7pea4heepuuW/hemhu+acieeLrOeri+iusOWPt++8mlxuICAgICAqIOS7o+aVsOWvueS4jeS4iuWwsSoq5pW05Z2X6YeN55S7KirvvIjogIzkuI3mmK/miormlrDml6fmnaHnm67mt7flnKjkuIDotbfvvInjgIJcbiAgICAgKi9cbiAgICBnZW5lcmF0aW9uOiBudW1iZXI7XG4gICAgdGljazogbnVtYmVyO1xuICAgIC8qKiDkuIvkuIDova7ova7or6LnmoTlrprml7blmajvvIjoh6rosIPluqbvvJrot5Hliqgv56m66Zey55So5LiN5ZCM6Ze06ZqU77yJ44CCICovXG4gICAgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbDtcbiAgICAvKiog5piv5ZCm5Zyo6L2u6K+i77yIYHRpbWVyYCDlj6rmmK/lvZPliY3ov5nkuIDot7PvvIznlKjlroPooajovr7jgIzlvIDnnYAv5YGc5LqG44CN77yJ44CCICovXG4gICAgcG9sbGluZzogYm9vbGVhbjtcbiAgICAvKiog5Y+q5Zyo56ys5LiA5qyhIHJlc3VtZSDml7blm57kvKDkuIDmrKHoh6rmo4DvvIzlhY3lvpfliLflsY/jgIIgKi9cbiAgICByZXBvcnRlZFJlc3VtZTogYm9vbGVhbjtcbiAgICBzbmFwc2hvdDogQWdlbnRTbmFwc2hvdCB8IG51bGw7XG4gICAgc2V0dGluZ3M6IERzaENoYXRTZXR0aW5ncyB8IG51bGw7XG4gICAgc2V0dGluZ3NPcGVuOiBib29sZWFuO1xuICAgIC8qKiDljoblj7LkvJror53mir3lsYnmmK/lkKbmiZPlvIDjgIIgKi9cbiAgICBoaXN0b3J5T3BlbjogYm9vbGVhbjtcbiAgICBzdGFydFJlcXVlc3RlZDogYm9vbGVhbjtcbiAgICAvKipcbiAgICAgKiDlt7Lnu4/lj5Hlh7rjgIzlgZzmraLmnKzova7jgI3jgIHkvYYgYHR1cm4vZW5kYCDov5jmsqHliLDnmoTpgqPkuIDmrrXjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOimgeiusO+8mmBBZ2VudC5jYW5jZWwoKWAg5pivKiror7fmsYIqKuS4jeaYr+WNs+aXtueUn+aViCDigJTigJQg5qih5Z6L5Lya5oqK5bey57uP55Sf5oiQ55qE6YKj5LiA5bCP5q61XG4gICAgICog5ZCQ5a6M44CB5Zyo6aOe55qE5bel5YW36LCD55So5Lmf5Y+v6IO95YaN5Zue5LiA5p2h57uT5p6c77yM6L+Z5pyf6Ze0IGBydW5uaW5nYCDku43mmK8gdHJ1ZeOAglxuICAgICAqIOS4jeiusOi/meS4quagh+W/l+eahOivneaMiemSruS8mueri+WIu+aBouWkjeWPr+eCue+8jOeUqOaIt+i/nueCueWHoOS4i+etieS6jumHjeWkjeWPkeWPlua2iOivt+axguOAglxuICAgICAqL1xuICAgIGludGVycnVwdGluZzogYm9vbGVhbjtcbiAgICAvKipcbiAgICAgKiDmj5DnpLrmnaHnmoTmnIDnn63lgZznlZnmiKrmraLml7bliLvvvIjop4EgYHNldEJhbm5lcmAg55qEIGBob2xkTXNg77yJ44CCXG4gICAgICogYHJlZnJlc2hTdGF0ZWAg6YeM6YKj5Y+l44CM5rKh5LqL5bCx5oqK5qiq5bmF5pS26LW35p2l44CN6KaB5YWI6Zeu6L+H5a6D44CCXG4gICAgICovXG4gICAgYmFubmVyVW50aWw6IG51bWJlcjtcbiAgICBlbXB0eUVsOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgdHlwaW5nRWw6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAvKiog5LiK5LiA5Liq5Ye6546w55qE55So5oi35raI5oGvIHNlce+8iOeUqOadpeWcqOWbnuWQiOS5i+mXtOaLieWIhumalOe6v++8ieOAgiAqL1xuICAgIGxhc3RVc2VyU2VxOiBudW1iZXI7XG4gICAgLyoqIOWOhuWPsuS8muivneaKveWxieS4juOAjOe7p+e7reatpOS8muivneOAjeaoquW5he+8iOWFg+e0oOingSBzdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1s77yJ44CCICovXG4gICAgaGlzdG9yeUJhcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGhpc3RvcnlCYXJUZXh0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgaGlzdG9yeTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGhpc3RvcnlMaXN0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgaGlzdG9yeU5vdGU6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICByZXN1bWVCdXR0b246IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgICBicm9hZGNhc3RIYW5kbGVyOiAoKHVwZGF0ZTogdW5rbm93bikgPT4gdm9pZCkgfCBudWxsO1xuXG4gICAgLy8gLS0tLSDlm77niYfvvIjnspjotLTliarotLTmnb8gLyDku47lt6XnqIvph4zpgInvvIktLS0tXG4gICAgLyoqIOW+heWPkemAgeeahOWbvueJh++8iOWPkemAgeaIkOWKn+aJjea4heepuu+8m+Wksei0peeVmeedgOiuqeeUqOaIt+mHjeivle+8ieOAgiAqL1xuICAgIGF0dGFjaG1lbnRzOiBBdHRhY2htZW50W107XG4gICAgLyoqIOi+k+WFpeWMuuS4iuaWuemCo+aOkueijueJh+OAgiAqL1xuICAgIGF0dGFjaEhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBpbWFnZUJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIC8qKiDmraPlnKjlvZLkuIDljJbvvIjop6PnoIEgKyDnvKnmlL4gKyDnvJbnoIHvvInnmoTlm77niYfmlbAg4oCU4oCUIOWkp+S6jiAwIOaXtuaMiemSrui9rOWciOOAgeWbnui9puS4jeaKouWPkeOAgiAqL1xuICAgIGltYWdlQnVzeTogbnVtYmVyO1xuICAgIC8qKiDlm77niYfpgInmi6nlmajvvIjlt6XnqIvlm77niYfmtY/op4jlmajvvInjgIIgKi9cbiAgICBwaWNrZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBwaWNrZXJMaXN0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgcGlja2VyTm90ZTogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIHBpY2tlclNlYXJjaDogSFRNTElucHV0RWxlbWVudCB8IG51bGw7XG4gICAgcGlja2VyT3BlbjogYm9vbGVhbjtcbiAgICAvKiog5bel56iL5Zu+54mH5riF5Y2V77yI5omT5byA6YCJ5oup5Zmo5pe25ouJ5LiA5qyh77yM5LmL5ZCO57yT5a2Y5Zyo6Z2i5p2/6YeM77ybYHJlZnJlc2hgIOW8uuWItumHjeaLie+8ieOAgiAqL1xuICAgIHBpY2tlckltYWdlczogUHJvamVjdEltYWdlW10gfCBudWxsO1xuICAgIC8qKiDov5nku73muIXljZXmmK/ku47lk6rmnaXnmoTvvIhgYXNzZXQtZGJgID0g6LWE5rqQ5bqT77yMYHNjYW5gID0g5omr55uu5b2V5YWc5bqV77yJ44CCICovXG4gICAgcGlja2VyU291cmNlOiBzdHJpbmc7XG4gICAgLyoqIOmAieaLqeWZqOmHjOeahOaQnOe0ouivje+8iOi3qOmHjee7mOS/neeVme+8ieOAgiAqL1xuICAgIHBpY2tlclF1ZXJ5OiBzdHJpbmc7XG4gICAgLyoqIOe8qeeVpeWbvue8k+WtmO+8muWbvueJh+i3r+W+hCDihpIgZGF0YSBVUkzvvIjpgInmi6nlmajlhbPmjonlho3lvIDkuI3ph43or7vvvInjgIIgKi9cbiAgICBwaWNrZXJUaHVtYnM6IE1hcDxzdHJpbmcsIHN0cmluZz47XG4gICAgLyoqIOivu+S4jeWHuue8qeeVpeWbvueahOi3r+W+hO+8iOWIq+WPjeWkjemHjeivle+8jOWQpuWImea7muWKqOS4gOasoeWwseWIt+S4gOS4siBJUEPvvInjgIIgKi9cbiAgICBwaWNrZXJGYWlsZWQ6IFNldDxzdHJpbmc+O1xuICAgIC8qKiDmraPlnKjor7vnmoTot6/lvoTvvIjljrvph43vvInjgIIgKi9cbiAgICBwaWNrZXJMb2FkaW5nOiBTZXQ8c3RyaW5nPjtcbiAgICAvKiog562J5b6F6K+757yp55Wl5Zu+55qE6Zif5YiX77yI6KeBIGBUSFVNQl9DT05DVVJSRU5DWWDvvInjgIIgKi9cbiAgICBwaWNrZXJRdWV1ZTogQXJyYXk8eyBpbWFnZTogUHJvamVjdEltYWdlOyB0YXJnZXQ6IEhUTUxJbWFnZUVsZW1lbnQgfT47XG4gICAgLyoqIOWPr+ingeWNs+WKoOi9ve+8iOmVv+a4heWNlemHjOWPquivu+ecvOWJjei/meWHoOW8oO+8ieOAgiAqL1xuICAgIHBpY2tlck9ic2VydmVyOiBJbnRlcnNlY3Rpb25PYnNlcnZlciB8IG51bGw7XG4gICAgLyoqXG4gICAgICog5Yia5Y+R5Ye65Y6755qE6YKj5Yeg5byg5Zu+55qE57yp55Wl5Zu+77yI5ZCN5a2XIOKGkiBkYXRhIFVSTO+8ieOAglxuICAgICAqXG4gICAgICog5Y+q5Li65LqG6K6pKiroh6rlt7HpgqPmnaHnlKjmiLfmtojmga8qKumHjOaYvuekuuecn+Wbvu+8mui9rOWGmemHjOWPquacieWFg+aVsOaNru+8iOingSBgRW50cnlJbWFnZWDvvInvvIxcbiAgICAgKiDogIzjgIzmiJHliJrmiY3otLTnmoTmmK/lk6rlvKDjgI3ov5nku7bkuovlv4XpobvkuIDnnLzog73noa7orqTjgILlj6rnlZnmnIDov5EgMTIg5byg77yMRklGTyDmt5jmsbDjgIJcbiAgICAgKi9cbiAgICBzZW50VGh1bWJzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5jb25zdCB1aUJ5UGFuZWwgPSBuZXcgV2Vha01hcDxvYmplY3QsIFVpU3RhdGU+KCk7XG5cbi8qKlxuICog5omA5pyJ5rS7552A55qE6Z2i5p2/5a6e5L6L44CCXG4gKlxuICog5a2Y5Zyo55CG55Sx77yaYGxpc3RlbmVycy5zaG93L2hpZGVgIOaUtuWIsOeahCBgdGhpc2Ag5YG25bCU5a+55LiN5LiKIGByZWFkeWAg6YKj5qyh77yI5oiW6ZKp5a2Q5YWI5LqOIGByZWFkeWAg5Yiw6L6+77yJ77yMXG4gKiDov5nml7bmjIkgYHRoaXNgIOafpSBXZWFrTWFwIOS8mioq6Z2Z6buY5aSx6LSlKirjgILlj6rmnInkuIDkuKrpnaLmnb/lrp7kvovml7bvvIjluLjmgIHvvInnm7TmjqXkvZznlKjlnKjlroPouqvkuIrmm7Tlj6/pnaDjgIJcbiAqL1xuY29uc3QgbGl2ZVN0YXRlcyA9IG5ldyBTZXQ8VWlTdGF0ZT4oKTtcblxuLyoqIOaJvuWIsOmSqeWtkOivpeS9nOeUqOeahOmdouadv+eKtuaAge+8muWFiOaMiSBgdGhpc2DvvIzlho3pgIDliLDjgIzllK/kuIDlrp7kvovjgI3jgIIgKi9cbmZ1bmN0aW9uIHJlc29sdmVTdGF0ZShzZWxmOiBvYmplY3QpOiBVaVN0YXRlIHwgbnVsbCB7XG4gICAgY29uc3QgZGlyZWN0ID0gdWlCeVBhbmVsLmdldChzZWxmKTtcbiAgICBpZiAoZGlyZWN0KSByZXR1cm4gZGlyZWN0O1xuICAgIGlmIChsaXZlU3RhdGVzLnNpemUgPT09IDEpIHJldHVybiBbLi4ubGl2ZVN0YXRlc11bMF07XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICog6Z2i5p2/5YWD57Sg55qE6YCJ5oup5Zmo6KGoIOKAlOKAlCAqKuWUr+S4gOecn+a6kCoq77yaYCRgIOihqOS4juWFnOW6leihpeafpemDveeUqOWug+OAglxuICpcbiAqIOWKoOWFg+e0oOaXtuWPquaUuei/memHjO+8iOWkluWKoCBgc3RhdGljL3RlbXBsYXRlL2RlZmF1bHQvaW5kZXguaHRtbGDvvInjgIJcbiAqL1xuY29uc3QgU0VMRUNUT1JTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIHJvb3Q6ICcuZHNoLXJvb3QnLFxuICAgIGRvdDogJyNkb3QnLFxuICAgIHRpdGxlOiAnI3RpdGxlJyxcbiAgICBzdWI6ICcjc3ViJyxcbiAgICBiYW5uZXI6ICcjYmFubmVyJyxcbiAgICBzZXR0aW5nczogJyNzZXR0aW5ncycsXG4gICAgYm9keTogJyNib2R5JyxcbiAgICBpbnB1dDogJyNpbnB1dCcsXG4gICAgYnRuU2VuZDogJyNidG4tc2VuZCcsXG4gICAgLyoqIOOAjOWBnOatouacrOi9ruOAje+8muWPquWcqCBgcnVubmluZ2Ag5pe25Y+v6KeB77yI6KeBIGByZWZyZXNoU3RhdGVg77yJ44CCICovXG4gICAgYnRuSW50ZXJydXB0OiAnI2J0bi1pbnRlcnJ1cHQnLFxuICAgIGJ0bk5ldzogJyNidG4tbmV3JyxcbiAgICBidG5TdG9wOiAnI2J0bi1zdG9wJyxcbiAgICBidG5SZXN0YXJ0OiAnI2J0bi1yZXN0YXJ0JyxcbiAgICBidG5IaXN0b3J5OiAnI2J0bi1oaXN0b3J5JyxcbiAgICBidG5SZXN1bWU6ICcjYnRuLXJlc3VtZScsXG4gICAgaGlzdG9yeUJhcjogJyNoaXN0b3J5LWJhcicsXG4gICAgaGlzdG9yeUJhclRleHQ6ICcjaGlzdG9yeS1iYXItdGV4dCcsXG4gICAgaGlzdG9yeTogJyNoaXN0b3J5JyxcbiAgICBoaXN0b3J5TGlzdDogJyNoaXN0b3J5LWxpc3QnLFxuICAgIGhpc3RvcnlOb3RlOiAnI2hpc3Rvcnktbm90ZScsXG4gICAgYnRuSGlzdG9yeUNsb3NlOiAnI2J0bi1oaXN0b3J5LWNsb3NlJyxcbiAgICBidG5IaXN0b3J5UmVmcmVzaDogJyNidG4taGlzdG9yeS1yZWZyZXNoJyxcbiAgICBidG5TZXR0aW5nczogJyNidG4tc2V0dGluZ3MnLFxuICAgIGJ0blRoZW1lOiAnI2J0bi10aGVtZScsXG4gICAgbGl2ZTogJyNsaXZlJyxcbiAgICBtZXRhOiAnI21ldGEnLFxuICAgIC8vIC0tLS0g5Zu+54mH77yI57KY6LS0IC8g6YCJ5Zu+77yJLS0tLVxuICAgIGF0dGFjaG1lbnRzOiAnI2F0dGFjaG1lbnRzJyxcbiAgICBidG5JbWFnZTogJyNidG4taW1hZ2UnLFxuICAgIHBpY2tlcjogJyNwaWNrZXInLFxuICAgIGJ0blBpY2tlckNsb3NlOiAnI2J0bi1waWNrZXItY2xvc2UnLFxuICAgIGJ0blBpY2tlclJlZnJlc2g6ICcjYnRuLXBpY2tlci1yZWZyZXNoJyxcbiAgICBidG5QaWNrZXJQYXN0ZTogJyNidG4tcGlja2VyLXBhc3RlJyxcbiAgICBwaWNrZXJTZWFyY2g6ICcjcGlja2VyLXNlYXJjaCcsXG4gICAgcGlja2VyTm90ZTogJyNwaWNrZXItbm90ZScsXG4gICAgcGlja2VyTGlzdDogJyNwaWNrZXItbGlzdCcsXG59O1xuXG4vKiog6LCD5Li76L+b56iL55qE5pa55rOV44CC5aSx6LSl5LiA5b6L5pS25pWb5oiQ5oqb57uZ6LCD55So5pa555qEIFByb21pc2XvvIzpnaLmnb/oh6rlt7EgdHJ5L2NhdGNo44CCICovXG5hc3luYyBmdW5jdGlvbiBjYWxsPFQgPSBhbnk+KG1lc3NhZ2U6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKTogUHJvbWlzZTxUPiB7XG4gICAgcmV0dXJuIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEVYVEVOU0lPTl9OQU1FLCBtZXNzYWdlLCAuLi5hcmdzKSkgYXMgVDtcbn1cblxuLyoqIOW7uuWFg+e0oOWwj+W3peWFt+OAgiAqL1xuZnVuY3Rpb24gZWw8SyBleHRlbmRzIGtleW9mIEhUTUxFbGVtZW50VGFnTmFtZU1hcD4odGFnOiBLLCBjbGFzc05hbWU/OiBzdHJpbmcsIHRleHQ/OiBzdHJpbmcpOiBIVE1MRWxlbWVudFRhZ05hbWVNYXBbS10ge1xuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XG4gICAgaWYgKGNsYXNzTmFtZSkgbm9kZS5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gICAgaWYgKHRleHQgIT09IHVuZGVmaW5lZCkgbm9kZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgcmV0dXJuIG5vZGU7XG59XG5cbi8qKlxuICog5oqK6Z2i5p2/6Ieq5qOA5oql57uZ5Li76L+b56iL77yI6K+75LiN5Yiw5Lmf5peg5omA6LCT77yM57qv6K+K5pat77yJ44CCXG4gKlxuICog5LiN5L6d6LWWIHN0YXRl77yaYG1vdW50YCDljYrot6/mipvplJnml7blroPkuZ/og73nlKjvvIjpgqPml7bov5jmsqHmnIkgc3RhdGXvvInjgIJcbiAqL1xuZnVuY3Rpb24gcmVwb3J0UHJvYmUocGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwZW5kaW5nID0gRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChFWFRFTlNJT05fTkFNRSwgTVNHLnBhbmVsUHJvYmUsIHtcbiAgICAgICAgICAgIC4uLnBheWxvYWQsXG4gICAgICAgICAgICBhdDogRGF0ZS5ub3coKSxcbiAgICAgICAgfSkgYXMgUHJvbWlzZTx1bmtub3duPjtcbiAgICAgICAgdm9pZCBwZW5kaW5nPy5jYXRjaD8uKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOiviuaWreWksei0peS4jeiuuOW9seWTjemdouadvyAqL1xuICAgIH1cbn1cblxuLyoqIOaPkOekuuadoe+8muaWh+WtlyArIOWPr+mAieWKqOS9nOaMiemSruOAguWFg+e0oOe8uuWkseaXtuWPqiB3YXJu77yI57ud5LiN6K6pIFVJIOaKm+mUme+8ieOAgiAqL1xuZnVuY3Rpb24gc2V0QmFubmVyKFxuICAgIHN0YXRlOiBVaVN0YXRlLFxuICAgIHRleHQ6IHN0cmluZyB8IG51bGwsXG4gICAgdG9uZTogJ2Vycm9yJyB8ICdpbmZvJyA9ICdlcnJvcicsXG4gICAgYWN0aW9uczogQXJyYXk8eyBsYWJlbDogc3RyaW5nOyBydW46ICgpID0+IHZvaWQgfT4gPSBbXSxcbiAgICAvKipcbiAgICAgKiDmnIDnn63lgZznlZnml7bpl7TvvIjmr6vnp5LvvInjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOmcgOimgeWug++8mmByZWZyZXNoU3RhdGVgIOmHjOacieS4gOWPpeOAjOS4gOWIh+ato+W4uOWwseaKiuaoquW5heaUtui1t+adpeOAje+8jOiAjOWug+WcqFxuICAgICAqICoq5q+P5qyh5pyJ5paw5p2h55uu5pe244CB5Lul5Y+K5q+PIDUg6Lez6L2u6K+i5pe2Kirpg73kvJrot5HvvIjot5Hliqjml7YgMzAwbXMg5LiA6Lez77yJ4oCU4oCUIOS6juaYr1xuICAgICAqIOOAjOi0tOWbvuWksei0pS/lj5HpgIHlpLHotKXjgI3ov5nnsbsqKueUseeUqOaIt+WKqOS9nOS6p+eUnyoq55qE5o+Q56S65bmz5Z2H5Y+q6IO95rS75Yeg55m+5q+r56eS77yMXG4gICAgICog55So5oi35qC55pys6K+75LiN5a6M77yIYHNlbmQoKWAg57uT5bC+6L+Y56uL5Yi7IGByZWZyZXNoU3RhdGUoKWAg5LiA5qyh77yM562J5LqO5b2T5Zy65oq55o6J77yJ44CCXG4gICAgICog5Yqo5L2c57G75o+Q56S65LiA5b6L5bimIGBob2xkTXNg77yM54q25oCB57G75o+Q56S677yIcHJvZmlsZSDlkIzmraXlpLHotKXjgIFhZ2VudCDlh7rplJnvvInkuI3nlKjluKbvvJpcbiAgICAgKiDpgqPkupvmnKzmnaXlsLHkvJrlnKjmr4/kuIDova7nirbmgIHph4zooqvph43mlrDlhpnlh7rmnaXjgIJcbiAgICAgKi9cbiAgICBob2xkTXMgPSAwLFxuKTogdm9pZCB7XG4gICAgY29uc3Qgbm9kZSA9IHN0YXRlLmJhbm5lcjtcbiAgICBpZiAoIW5vZGUpIHJldHVybjtcbiAgICBub2RlLnRleHRDb250ZW50ID0gJyc7XG4gICAgaWYgKCF0ZXh0KSB7XG4gICAgICAgIG5vZGUuaGlkZGVuID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5iYW5uZXJVbnRpbCA9IERhdGUubm93KCkgKyBNYXRoLm1heCgwLCBob2xkTXMpO1xuICAgIG5vZGUuaGlkZGVuID0gZmFsc2U7XG4gICAgbm9kZS5kYXRhc2V0LnRvbmUgPSB0b25lO1xuICAgIG5vZGUuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsIHVuZGVmaW5lZCwgdGV4dCkpO1xuICAgIGlmIChhY3Rpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3Qgcm93ID0gZWwoJ2RpdicsICdkc2gtYmFubmVyLWFjdGlvbnMnKTtcbiAgICAgICAgZm9yIChjb25zdCBhY3Rpb24gb2YgYWN0aW9ucykge1xuICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gZWwoJ2J1dHRvbicsICdkc2gtYnRuJywgYWN0aW9uLmxhYmVsKTtcbiAgICAgICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFjdGlvbi5ydW4pO1xuICAgICAgICAgICAgcm93LmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgICAgIH1cbiAgICAgICAgbm9kZS5hcHBlbmRDaGlsZChyb3cpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDkuLvpopjvvJpgYXV0b2Ag5YWI55yL6IO95LiN6IO96K6k5Ye657yW6L6R5Zmo5Li76aKY77yM6K6k5LiN5Ye65YaN6Lef57O757uf44CCXG4gKlxuICog6Z2i5p2/5b6I5Y+v6IO96LeR5Zyo54us56uL5paH5qGj6YeM77yI6L+Z5Lmf5pivIGBnZXRFbGVtZW50QnlJZGAg5ou/5LiN5Yiw6Z2i5p2/5YWD57Sg55qE5Y6f5Zug77yJ77yMXG4gKiDpgqPml7YgYGRvY3VtZW50RWxlbWVudC5jbGFzc05hbWVgIOaYr+aIkeS7rOiHquW3seeahOOAgeiupOS4jeWHuue8lui+keWZqCDigJTigJQg5LqO5piv5Zue6JC957O757uf5YGP5aW944CCXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVUaGVtZShtb2RlOiBQYW5lbFRoZW1lKTogJ2RhcmsnIHwgJ2xpZ2h0JyB7XG4gICAgaWYgKG1vZGUgPT09ICdkYXJrJyB8fCBtb2RlID09PSAnbGlnaHQnKSByZXR1cm4gbW9kZTtcbiAgICBjb25zdCBoaW50ID0gYCR7ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Py5jbGFzc05hbWUgPz8gJyd9ICR7ZG9jdW1lbnQuYm9keT8uY2xhc3NOYW1lID8/ICcnfSAke1xuICAgICAgICBkb2N1bWVudC5ib2R5Py5kYXRhc2V0Py50aGVtZSA/PyAnJ1xuICAgIH1gO1xuICAgIGlmICgvZGFyay9pLnRlc3QoaGludCkpIHJldHVybiAnZGFyayc7XG4gICAgaWYgKC9saWdodC9pLnRlc3QoaGludCkpIHJldHVybiAnbGlnaHQnO1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiB3aW5kb3cubWF0Y2hNZWRpYT8uKCcocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspJykubWF0Y2hlcyA/ICdkYXJrJyA6ICdsaWdodCc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnZGFyayc7XG4gICAgfVxufVxuXG4vKiog5oqK5aSW6KeC6K6+572u6JC95Yiw5qC56IqC54K577yI5Li76aKYICsg5a2X5Y+377yJ44CCICovXG5mdW5jdGlvbiBhcHBseUFwcGVhcmFuY2Uoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCByb290ID0gc3RhdGUucm9vdDtcbiAgICBpZiAoIXJvb3QpIHJldHVybjtcbiAgICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3M/LnRoZW1lID8/ICdhdXRvJztcbiAgICByb290LmRhdGFzZXQudGhlbWUgPSByZXNvbHZlVGhlbWUobW9kZSk7XG4gICAgY29uc3Qgc2l6ZSA9IE51bWJlcihzdGF0ZS5zZXR0aW5ncz8uZm9udFNpemUgPz8gMCk7XG4gICAgaWYgKHNpemUgPj0gMTIgJiYgc2l6ZSA8PSAxNykgcm9vdC5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kc2gtY29udGVudC1mb250LXNpemUnLCBgJHtzaXplfXB4YCk7XG4gICAgZWxzZSByb290LnN0eWxlLnJlbW92ZVByb3BlcnR5KCctLWRzaC1jb250ZW50LWZvbnQtc2l6ZScpO1xufVxuXG4vKipcbiAqIOW4g+WxgOiHquajgO+8mumdouadv+eahOmrmOW6puS7juWTquadpeOAglxuICpcbiAqIOiAgeeJiOagt+W8j+mdoCBgaHRtbCxib2R5e2hlaWdodDoxMDAlfWAg5pKR6LW35p2lIOKAlOKAlCDpgqPmnaHop4TliJnkvJrmlLnliLDnvJbovpHlmajoh6rlt7HnmoTpobXpnaLvvIxcbiAqIOaJgOS7peaWsOeJiOaKiuWug+WIoOS6hu+8jOaUueaIkOi/memHjOmHj+S4gOasoe+8mmAuZHNoLXJvb3RgIOmrmOW6puWhjOS6hu+8iDwgNDBweO+8ieWwseaMieaDheWGteWFnOW6leOAglxuICog6Z2i5p2/5Yiw5bqV54us5Y2g5LiA5Liq5paH5qGj6L+Y5piv5LiO57yW6L6R5Zmo5YWx55So77yM5ZCE54mI5pys57yW6L6R5Zmo5LiN5LiA5qC377yM6YeP5Ye65p2l55qE57uT5p6c5Lya5Zue5Lyg57uZ5Li76L+b56iL44CCXG4gKi9cbmZ1bmN0aW9uIGVuc3VyZUxheW91dChzdGF0ZTogVWlTdGF0ZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCByb290ID0gc3RhdGUucm9vdDtcbiAgICBpZiAoIXJvb3QpIHJldHVybiB7IHJvb3Q6ICdtaXNzaW5nJyB9O1xuICAgIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIGNvbnN0IGluZm86IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBraW5kOiAnbGF5b3V0JyxcbiAgICAgICAgcm9vdEhlaWdodDogTWF0aC5yb3VuZChyZWN0LmhlaWdodCksXG4gICAgICAgIHJvb3RXaWR0aDogTWF0aC5yb3VuZChyZWN0LndpZHRoKSxcbiAgICAgICAgcGFyZW50OiByb290LnBhcmVudEVsZW1lbnQ/LnRhZ05hbWUgPz8gbnVsbCxcbiAgICAgICAgaHRtbEhlaWdodDogZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Py5jbGllbnRIZWlnaHQgPz8gLTEsXG4gICAgICAgIGJvZHlIZWlnaHQ6IGRvY3VtZW50LmJvZHk/LmNsaWVudEhlaWdodCA/PyAtMSxcbiAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5Py5jaGlsZHJlbj8ubGVuZ3RoID8/IC0xLFxuICAgICAgICBib2R5TWFyZ2luOiBkb2N1bWVudC5ib2R5ID8gZ2V0Q29tcHV0ZWRTdHlsZShkb2N1bWVudC5ib2R5KS5tYXJnaW4gOiAnJyxcbiAgICAgICAgdGhlbWU6IHJvb3QuZGF0YXNldC50aGVtZSxcbiAgICB9O1xuICAgIC8vIOmdouadv+eLrOWNoOi/meS4quaWh+aho++8iGJvZHkg6YeM5Y+q5pyJ5oiR5Lus77yJ5pe277yM5riF5o6JIGJvZHkg55qE6buY6K6k5aSW6L656Led5piv5a6J5YWo55qEXG4gICAgY29uc3Qgb3duc0RvY3VtZW50ID0gQm9vbGVhbihkb2N1bWVudC5ib2R5KSAmJiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCA8PSAxICYmIGRvY3VtZW50LmJvZHkuY29udGFpbnMocm9vdCk7XG4gICAgaW5mby5vd25zRG9jdW1lbnQgPSBvd25zRG9jdW1lbnQ7XG4gICAgaWYgKG93bnNEb2N1bWVudCAmJiBkb2N1bWVudC5ib2R5KSB7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuc3R5bGUubWFyZ2luID0gJzAnO1xuICAgICAgICBkb2N1bWVudC5ib2R5LnN0eWxlLnBhZGRpbmcgPSAnMCc7XG4gICAgICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zdHlsZS5oZWlnaHQgPSAnMTAwJSc7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuc3R5bGUuaGVpZ2h0ID0gJzEwMCUnO1xuICAgICAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93ID0gJ2hpZGRlbic7XG4gICAgICAgIGNvbnN0IGFmdGVyID0gcm9vdC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgaW5mby5yb290SGVpZ2h0QWZ0ZXJSZXNldCA9IE1hdGgucm91bmQoYWZ0ZXIuaGVpZ2h0KTtcbiAgICAgICAgaWYgKGFmdGVyLmhlaWdodCA8IDQwKSB7XG4gICAgICAgICAgICByb290LnN0eWxlLnBvc2l0aW9uID0gJ2Fic29sdXRlJztcbiAgICAgICAgICAgIHJvb3Quc3R5bGUuaW5zZXQgPSAnMCc7XG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJlY3QuaGVpZ2h0IDwgNDApIHtcbiAgICAgICAgaW5mby53YXJuaW5nID0gJ+mrmOW6puWhjOS6huS9huS4jeaYr+eLrOWNoOaWh+ahoyDigJTigJQg5rKh5pyJ6Ieq5Yqo5YWc5bqV77yM6K+35oqK6L+Z5p2h5oql57uZ5omp5bGV5L2c6ICFJztcbiAgICB9XG4gICAgcmV0dXJuIGluZm87XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5p2h55uu5riy5p+TXG5cbi8qKlxuICog55So5oi35rCU5rOh6YeM55qE5Zu+54mH56KO54mH44CCXG4gKlxuICogKirlg4/ntKDkuI3ov5vovazlhpkqKu+8iOingSBgY29uc3RhbnRzLnRzYCDnmoQgYEVudHJ5SW1hZ2VgIOazqOmHiu+8ie+8mui/memHjOWPquacieWFg+aVsOaNriDigJTigJQg5Zu+5ZCN44CB5bC65a+444CBXG4gKiDlpKflsI/jgILliJrliJoqKueUseacrOmdouadv+WPkeWHuuWOuyoq55qE6YKj5Yeg5byg5L6L5aSW77ya6YKj5pe256KO54mH5LiK55qE57yp55Wl5Zu+6L+Y5Zyo5omL6L6577yIYHNlbnRUaHVtYnNg77yJ77yMXG4gKiDlsLHpobrmiYvmmL7npLrnnJ/lm77vvIzorqnjgIzmiJHliJrmiY3otLTnmoTmmK/ov5nlvKDjgI3kuIDnnLzog73noa7orqTjgILlm57mlL7ljoblj7Lml7bml6Xlv5fph4zmsqHmnInlg4/ntKDvvIxcbiAqIGBzZW50VGh1bWJzYCDkuZ/ml6nlt7Lova7nqbrvvIzkuo7mmK/lm57okL3miJDjgIzwn5a8IOWbvuWQje+8iOWwuuWvuO+8ieOAjeOAglxuICovXG5mdW5jdGlvbiByZW5kZXJFbnRyeUltYWdlcyhzdGF0ZTogVWlTdGF0ZSwgaW1hZ2VzOiBFbnRyeUltYWdlW10pOiBIVE1MRWxlbWVudCB7XG4gICAgY29uc3Qgd3JhcCA9IGVsKCdkaXYnLCAnZHNoLW1zZy1pbWFnZXMnKTtcbiAgICBmb3IgKGNvbnN0IGltYWdlIG9mIGltYWdlcykge1xuICAgICAgICBjb25zdCBjaGlwID0gZWwoJ3NwYW4nLCAnZHNoLW1zZy1pbWFnZScpO1xuICAgICAgICBjb25zdCB0aHVtYiA9IGltYWdlLm5hbWUgPyBzdGF0ZS5zZW50VGh1bWJzLmdldChpbWFnZS5uYW1lKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHRodW1iKSB7XG4gICAgICAgICAgICBjb25zdCBub2RlID0gZWwoJ2ltZycsICdkc2gtbXNnLWltYWdlLXRodW1iJyk7XG4gICAgICAgICAgICBub2RlLnNyYyA9IHRodW1iO1xuICAgICAgICAgICAgbm9kZS5hbHQgPSBpbWFnZS5uYW1lID8/ICcnO1xuICAgICAgICAgICAgY2hpcC5hcHBlbmRDaGlsZChub2RlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNoaXAuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLW1zZy1pbWFnZS1nbHlwaCcsICfwn5a8JykpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGRpbXMgPSBpbWFnZS53aWR0aCAmJiBpbWFnZS5oZWlnaHQgPyBgJHtpbWFnZS53aWR0aH3DlyR7aW1hZ2UuaGVpZ2h0fWAgOiAnJztcbiAgICAgICAgY29uc3Qgc2l6ZSA9IGltYWdlLmJ5dGVzID8gZm9ybWF0Qnl0ZXMoaW1hZ2UuYnl0ZXMpIDogJyc7XG4gICAgICAgIGNoaXAuYXBwZW5kQ2hpbGQoZWwoJ3NwYW4nLCAnZHNoLW1zZy1pbWFnZS1uYW1lJywgaW1hZ2UubmFtZSB8fCAn5Zu+54mHJykpO1xuICAgICAgICBjb25zdCBtZXRhID0gW2RpbXMsIHNpemVdLmZpbHRlcihCb29sZWFuKS5qb2luKCcgwrcgJyk7XG4gICAgICAgIGlmIChtZXRhKSBjaGlwLmFwcGVuZENoaWxkKGVsKCdzcGFuJywgJ2RzaC1tc2ctaW1hZ2UtbWV0YScsIG1ldGEpKTtcbiAgICAgICAgd3JhcC5hcHBlbmRDaGlsZChjaGlwKTtcbiAgICB9XG4gICAgcmV0dXJuIHdyYXA7XG59XG5cbi8qKiDmgJ3ogIPlnZfvvIjpu5jorqTmipjlj6DvvJvmtYHlvI/pgqPkuIDlnZfoh6rliqjlsZXlvIDvvInjgIIgKi9mdW5jdGlvbiByZW5kZXJUaGlua2luZyhzdGF0ZTogVWlTdGF0ZSwgaG9zdDogSFRNTEVsZW1lbnQsIGVudHJ5OiBFbnRyeSk6IHZvaWQge1xuICAgIGNvbnN0IGV4cGxpY2l0ID0gc3RhdGUuY29sbGFwc2VkVGhpbmsuZ2V0KGVudHJ5LnNlcSk7XG4gICAgY29uc3QgaXNMaXZlID0gc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcgPT09IHRydWUgJiYgZW50cnkuc2VxID09PSBzdGF0ZS5tYXhTZXE7XG4gICAgY29uc3QgY29sbGFwc2VkID0gZXhwbGljaXQgPT09IHVuZGVmaW5lZCA/ICFpc0xpdmUgOiBleHBsaWNpdDtcblxuICAgIGNvbnN0IGJveCA9IGVsKCdkaXYnLCAnZHNoLXRoaW5rJyk7XG4gICAgYm94LmRhdGFzZXQuY29sbGFwc2VkID0gY29sbGFwc2VkID8gJ3RydWUnIDogJ2ZhbHNlJztcbiAgICBjb25zdCBoZWFkID0gZWwoJ2RpdicsICdkc2gtdGhpbmstaGVhZCcpO1xuICAgIGhlYWQuYXBwZW5kKGVsKCdzcGFuJywgJ2RzaC10aGluay1jYXJldCcsICfilrgnKSwgZWwoJ3NwYW4nLCB1bmRlZmluZWQsIGlzTGl2ZSA/ICfmgJ3ogIPkuK3igKYnIDogJ+aAneiAg+i/h+eoiycpKTtcbiAgICBjb25zdCBib2R5ID0gZWwoJ2RpdicsICdkc2gtdGhpbmstYm9keScsIGVudHJ5LnRleHQgPz8gJycpO1xuICAgIGhlYWQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IG5leHQgPSBib3guZGF0YXNldC5jb2xsYXBzZWQgIT09ICd0cnVlJztcbiAgICAgICAgYm94LmRhdGFzZXQuY29sbGFwc2VkID0gbmV4dCA/ICd0cnVlJyA6ICdmYWxzZSc7XG4gICAgICAgIHN0YXRlLmNvbGxhcHNlZFRoaW5rLnNldChlbnRyeS5zZXEsIG5leHQpO1xuICAgIH0pO1xuICAgIGJveC5hcHBlbmQoaGVhZCwgYm9keSk7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChib3gpO1xufVxuXG4vKiog5bel5YW35Y2h54mH44CCICovXG5mdW5jdGlvbiByZW5kZXJUb29sKHN0YXRlOiBVaVN0YXRlLCBob3N0OiBIVE1MRWxlbWVudCwgZW50cnk6IEVudHJ5KTogdm9pZCB7XG4gICAgY29uc3QgZXhwbGljaXQgPSBzdGF0ZS5vcGVuVG9vbHMuZ2V0KGVudHJ5LnNlcSk7XG4gICAgY29uc3Qgb3BlbiA9IGV4cGxpY2l0ID09PSB1bmRlZmluZWQgPyBkZWZhdWx0T3BlbihlbnRyeSkgOiBleHBsaWNpdDtcbiAgICBjb25zdCBjYXJkID0gY3JlYXRlVG9vbENhcmQoZW50cnksIG9wZW4sIChuZXh0KSA9PiBzdGF0ZS5vcGVuVG9vbHMuc2V0KGVudHJ5LnNlcSwgbmV4dCkpO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQoY2FyZC5yb290KTtcbn1cblxuLyoqIOaMieadoeebruenjeexu+a4suafk+WGheWuue+8iOWFg+e0oOW3suiiq+a4heepuu+8ieOAgiAqL1xuZnVuY3Rpb24gcGFpbnRFbnRyeShzdGF0ZTogVWlTdGF0ZSwgZWxlbWVudDogSFRNTEVsZW1lbnQsIGVudHJ5OiBFbnRyeSk6IHZvaWQge1xuICAgIGVsZW1lbnQuY2xhc3NOYW1lID0gJyc7XG4gICAgZWxlbWVudC50ZXh0Q29udGVudCA9ICcnO1xuICAgIHN3aXRjaCAoZW50cnkua2luZCkge1xuICAgICAgICBjYXNlICd1c2VyJzoge1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc05hbWUgPSAnZHNoLW1zZy11c2VyJztcbiAgICAgICAgICAgIC8vIOe6r+WbvueJh+a2iOaBr+ayoeacieaWh+WtlyDigJTigJQg6YKj5bCx5Y+q55S756KO54mH77yI5Yir55WZ5LiA5Liq56m65rCU5rOh77yJXG4gICAgICAgICAgICBpZiAoZW50cnkudGV4dCkgZWxlbWVudC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1tc2ctdGV4dCcsIGVudHJ5LnRleHQpKTtcbiAgICAgICAgICAgIGlmIChlbnRyeS5pbWFnZXMgJiYgZW50cnkuaW1hZ2VzLmxlbmd0aCA+IDApIGVsZW1lbnQuYXBwZW5kQ2hpbGQocmVuZGVyRW50cnlJbWFnZXMoc3RhdGUsIGVudHJ5LmltYWdlcykpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNhc2UgJ2FnZW50Jzoge1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc05hbWUgPSAnZHNoLW1zZy1hZ2VudCc7XG4gICAgICAgICAgICBjb25zdCBtZCA9IGVsKCdkaXYnLCAnZHNoLW1kJyk7XG4gICAgICAgICAgICByZW5kZXJNYXJrZG93bihtZCwgZW50cnkudGV4dCA/PyAoc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcgPyAn4oCmJyA6ICcnKSk7XG4gICAgICAgICAgICBlbGVtZW50LmFwcGVuZENoaWxkKG1kKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjYXNlICd0aGlua2luZyc6IHtcbiAgICAgICAgICAgIHJlbmRlclRoaW5raW5nKHN0YXRlLCBlbGVtZW50LCBlbnRyeSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAndG9vbCc6IHtcbiAgICAgICAgICAgIHJlbmRlclRvb2woc3RhdGUsIGVsZW1lbnQsIGVudHJ5KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjYXNlICdlcnJvcic6IHtcbiAgICAgICAgICAgIGVsZW1lbnQuY2xhc3NOYW1lID0gJ2RzaC1lcnJvcic7XG4gICAgICAgICAgICBlbGVtZW50LnRleHRDb250ZW50ID0gZW50cnkudGV4dCA/PyAn5Ye66ZSZJztcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgICBlbGVtZW50LmNsYXNzTmFtZSA9ICdkc2gtbm90ZSc7XG4gICAgICAgICAgICBpZiAoKGVudHJ5LnRleHQgPz8gJycpLnN0YXJ0c1dpdGgoJ3N0ZGVycjonKSkgZWxlbWVudC5kYXRhc2V0LmtpbmQgPSAnc3RkZXJyJztcbiAgICAgICAgICAgIGVsZW1lbnQudGV4dENvbnRlbnQgPSBlbnRyeS50ZXh0ID8/ICcnO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgfVxufVxuXG4vKiog56m65oCB77ya6aaW5qyh5omT5byA5pe25ZGK6K+J55So5oi36L+Z5piv5LuA5LmI44CB5oCO5LmI5byA5aeL44CCICovXG5mdW5jdGlvbiByZW5kZXJFbXB0eShzdGF0ZTogVWlTdGF0ZSwgcmVhc29uOiAnbm8tYWdlbnQnIHwgJ25vLW1lc3NhZ2VzJyk6IHZvaWQge1xuICAgIGNvbnN0IHdyYXAgPSBlbCgnZGl2JywgJ2RzaC1lbXB0eScpO1xuICAgIGlmIChyZWFzb24gPT09ICduby1hZ2VudCcpIHtcbiAgICAgICAgd3JhcC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1lbXB0eS10aXRsZScsICdEU0gg6L+Y5rKh5ZCv5YqoJykpO1xuICAgICAgICBjb25zdCBsaW5lcyA9IGVsKCdkaXYnLCAnZHNoLWVtcHR5LWxpbmVzJyk7XG4gICAgICAgIGNvbnN0IHNuYXBzaG90ID0gc3RhdGUuc25hcHNob3Q7XG4gICAgICAgIGNvbnN0IHRleHQgPSBbXG4gICAgICAgICAgICAn6Z2i5p2/5Lya5Zyo57yW6L6R5Zmo6YeM6LeR5LiA5Liq54us56uL55qEIGRzaCBwcm9maWxl77yIY29jb3PvvInvvJrog73or7vlt6XnqIvph4znmoTmlofku7bkuI4gc2tpbGzvvIwnLFxuICAgICAgICAgICAgJ+W5tumAmui/hyBjb2Nvc19leGVjdXRlX2NvZGUg55u05o6l5pON5L2c5L2g5q2j5byA552A55qE57yW6L6R5Zmo77yI5bel5YW36LWw6L+b56iL6Ze06YCa6YGT77yM5LiN5Y2g56uv5Y+j77yJ44CCJyxcbiAgICAgICAgICAgICcnLFxuICAgICAgICAgICAgJ+mmluasoeWQr+WKqOimgeWHoOWNgeenkiDigJTigJQg6KaB5Yqg6L295pW05qO1IERTSCDmj5Lku7bmoJHjgIInLFxuICAgICAgICAgICAgc25hcHNob3QgPyBgbm9kZe+8miR7c25hcHNob3QucnVudGltZS5ub2RlRXhlID8/ICfmnKrmib7liLAnfe+8iCR7c25hcHNob3QucnVudGltZS5ub2RlU291cmNlfe+8iWAgOiAnJyxcbiAgICAgICAgICAgIHNuYXBzaG90ID8gYGRzaCDvvJoke3NuYXBzaG90LnJ1bnRpbWUuZHNoQmluID8/ICfmnKrmib7liLAnfe+8iCR7c25hcHNob3QucnVudGltZS5kc2hTb3VyY2V977yJYCA6ICcnLFxuICAgICAgICBdXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgICAgICAuam9pbignXFxuJyk7XG4gICAgICAgIGxpbmVzLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgICAgd3JhcC5hcHBlbmRDaGlsZChsaW5lcyk7XG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsKCdidXR0b24nLCAnZHNoLXNlbmQtcHJpbWFyeScsICflkK/liqggYWdlbnQnKTtcbiAgICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBzdGFydEFnZW50KHN0YXRlKSk7XG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB3cmFwLmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLWVtcHR5LXRpdGxlJywgJ+ivtOeCueS7gOS5iOW8gOWniycpKTtcbiAgICAgICAgY29uc3QgbGluZXMgPSBlbCgnZGl2JywgJ2RzaC1lbXB0eS1saW5lcycpO1xuICAgICAgICBsaW5lcy50ZXh0Q29udGVudCA9ICfmr5TlpoLvvJrjgIznnIvkuIDnnLzlvZPliY3lnLrmma/vvIzmioogQ2FudmFzIOS4i+eahOiKgueCueWIl+WHuuadpeOAjeOAgic7XG4gICAgICAgIHdyYXAuYXBwZW5kQ2hpbGQobGluZXMpO1xuICAgIH1cbiAgICBzdGF0ZS5ib2R5LmFwcGVuZENoaWxkKHdyYXApO1xuICAgIHN0YXRlLmVtcHR5RWwgPSB3cmFwO1xufVxuXG4vKiog44CM5q2j5Zyo5Zue5aSN44CN55qE5LiJ5Liq54K577yI5Y+q5Zyo6LeR55qE5pe25YCZ5oyC5Zyo5pyA5ZCO77yJ44CCICovXG5mdW5jdGlvbiBzeW5jVHlwaW5nKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgcnVubmluZyA9IHN0YXRlLnNuYXBzaG90Py5ydW5uaW5nID09PSB0cnVlO1xuICAgIGlmICghcnVubmluZykge1xuICAgICAgICBpZiAoc3RhdGUudHlwaW5nRWwpIHtcbiAgICAgICAgICAgIHN0YXRlLnR5cGluZ0VsLnJlbW92ZSgpO1xuICAgICAgICAgICAgc3RhdGUudHlwaW5nRWwgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFzdGF0ZS50eXBpbmdFbCkge1xuICAgICAgICBjb25zdCBkb3RzID0gZWwoJ2RpdicsICdkc2gtdHlwaW5nJyk7XG4gICAgICAgIGRvdHMuYXBwZW5kKGVsKCdzcGFuJyksIGVsKCdzcGFuJyksIGVsKCdzcGFuJykpO1xuICAgICAgICBzdGF0ZS50eXBpbmdFbCA9IGRvdHM7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5ib2R5Lmxhc3RFbGVtZW50Q2hpbGQgIT09IHN0YXRlLnR5cGluZ0VsKSBzdGF0ZS5ib2R5LmFwcGVuZENoaWxkKHN0YXRlLnR5cGluZ0VsKTtcbn1cblxuLyoqIOa1geW8j+eKtuaAgeWPmOS6huS5i+WQju+8jOmHjeeul+OAjOaAneiAg+Wdl+ivpeS4jeivpeWxleW8gOOAje+8iOeUqOaIt+aJi+WKqOeCuei/h+eahOS7peeUqOaIt+S4uuWHhu+8ieOAgiAqL1xuZnVuY3Rpb24gc3luY0xpdmVCbG9ja3Moc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHN0YXRlLmVudHJpZXMudmFsdWVzKCkpIHtcbiAgICAgICAgaWYgKGVudHJ5LmtpbmQgIT09ICd0aGlua2luZycpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkVGhpbmsuaGFzKGVudHJ5LnNlcSkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBlbGVtZW50ID0gc3RhdGUuZWxzLmdldChlbnRyeS5zZXEpO1xuICAgICAgICBjb25zdCBib3ggPSBlbGVtZW50Py5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLmRzaC10aGluaycpO1xuICAgICAgICBpZiAoIWJveCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGlzTGl2ZSA9IHN0YXRlLnNuYXBzaG90Py5ydW5uaW5nID09PSB0cnVlICYmIGVudHJ5LnNlcSA9PT0gc3RhdGUubWF4U2VxO1xuICAgICAgICBib3guZGF0YXNldC5jb2xsYXBzZWQgPSBpc0xpdmUgPyAnZmFsc2UnIDogJ3RydWUnO1xuICAgIH1cbn1cblxuLyoqXG4gKiDmuIXnqbrlr7nor53ljLrvvIjmjaLkvJror50gLyDlm57mlL7ljoblj7Lml7bvvInjgIJcbiAqXG4gKiDnlLEqKuS4u+i/m+eoi+eahOi9rOWGmeS7o+aVsCoq6amx5Yqo77yIYGdlbmVyYXRpb25gIOWvueS4jeS4iuWwseiwg+S4gOasoe+8ie+8jOiAjOS4jeaYr+WQhOiHquaMiemSrumHjOaJi+WGmeS4gOmBjSDigJTigJRcbiAqIOi/meagt+OAjOiwgea4heepuueahOOAjeWPquacieS4gOS4quecn+a6kO+8jOS4jeS8muWHuueOsOOAjOaMiemSrua4heS6huOAgei9ruivouWPiOaKiuaXp+adoeebrueBjOWbnuadpeOAjeOAglxuICpcbiAqIEBwYXJhbSBnZW5lcmF0aW9uIC0g5Li76L+b56iL57uZ55qE5paw5Luj5pWw77yI5LiN5Lyg5bCx5Y+q5riFIERPTe+8ieOAglxuICovXG5mdW5jdGlvbiByZXNldFVpKHN0YXRlOiBVaVN0YXRlLCBnZW5lcmF0aW9uPzogbnVtYmVyKTogdm9pZCB7XG4gICAgc3RhdGUuZW50cmllcy5jbGVhcigpO1xuICAgIHN0YXRlLmVscy5jbGVhcigpO1xuICAgIHN0YXRlLm9wZW5Ub29scy5jbGVhcigpO1xuICAgIHN0YXRlLmNvbGxhcHNlZFRoaW5rLmNsZWFyKCk7XG4gICAgc3RhdGUuYm9keS50ZXh0Q29udGVudCA9ICcnO1xuICAgIHN0YXRlLmVtcHR5RWwgPSBudWxsO1xuICAgIHN0YXRlLnR5cGluZ0VsID0gbnVsbDtcbiAgICAvLyBtYXhSZXYg5b2S6Zu277ya5Luj5pWw5Y+Y5LqG77yM5LmL5YmN6YKj5om55p2h55uu5Zyo5Li76L+b56iL6YeM5bey57uP5LiN5a2Y5Zyo77yM6YeN5ouJ5LiA6YGN5LiN5Lya6YeN5aSNXG4gICAgc3RhdGUubWF4UmV2ID0gMDtcbiAgICBzdGF0ZS5tYXhTZXEgPSAwO1xuICAgIHN0YXRlLmxhc3RVc2VyU2VxID0gMDtcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRpb24gPT09ICdudW1iZXInKSBzdGF0ZS5nZW5lcmF0aW9uID0gZ2VuZXJhdGlvbjtcbiAgICBpZiAoc3RhdGUuZW50cmllcy5zaXplID09PSAwKSByZW5kZXJFbXB0eShzdGF0ZSwgc3RhdGUuc25hcHNob3Q/LnN0YXR1cyA9PT0gJ3JlYWR5JyA/ICduby1tZXNzYWdlcycgOiAnbm8tYWdlbnQnKTtcbn1cblxuLyoqIOaMiSBzZXEg5ZCI5bm25p2h55uu77yI5ZCM5LiAIHNlcSDljp/lnLDmm7TmlrDvvInjgIIgKi9cbmZ1bmN0aW9uIG1lcmdlRW50cmllcyhzdGF0ZTogVWlTdGF0ZSwgZW50cmllczogRW50cnlbXSk6IGJvb2xlYW4ge1xuICAgIGxldCBjaGFuZ2VkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzID0gc3RhdGUuZW50cmllcy5nZXQoZW50cnkuc2VxKTtcbiAgICAgICAgc3RhdGUuZW50cmllcy5zZXQoZW50cnkuc2VxLCBlbnRyeSk7XG4gICAgICAgIGlmIChlbnRyeS5zZXEgPiBzdGF0ZS5tYXhTZXEpIHN0YXRlLm1heFNlcSA9IGVudHJ5LnNlcTtcbiAgICAgICAgbGV0IGVsZW1lbnQgPSBzdGF0ZS5lbHMuZ2V0KGVudHJ5LnNlcSk7XG4gICAgICAgIGlmICghZWxlbWVudCkge1xuICAgICAgICAgICAgLy8g5paw5Zue5ZCI77yI5Y+I5LiA5p2h55So5oi35raI5oGv77yJ5YmN6Z2i5ouJ5LiA5p2h5YiG6ZqU57q/77yM5Y+q5Zyo5LiN5piv56ys5LiA5p2h5pe25ouJXG4gICAgICAgICAgICBpZiAoZW50cnkua2luZCA9PT0gJ3VzZXInICYmIHN0YXRlLmVscy5zaXplID4gMCAmJiBlbnRyeS5zZXEgIT09IHN0YXRlLmxhc3RVc2VyU2VxKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2VwID0gZWwoJ2RpdicsICdkc2gtdHVybi1zZXAnKTtcbiAgICAgICAgICAgICAgICBzdGF0ZS5ib2R5LmFwcGVuZENoaWxkKHNlcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZW50cnkua2luZCA9PT0gJ3VzZXInKSBzdGF0ZS5sYXN0VXNlclNlcSA9IGVudHJ5LnNlcTtcbiAgICAgICAgICAgIGVsZW1lbnQgPSBlbCgnZGl2Jyk7XG4gICAgICAgICAgICBzdGF0ZS5lbHMuc2V0KGVudHJ5LnNlcSwgZWxlbWVudCk7XG4gICAgICAgICAgICBzdGF0ZS5ib2R5LmFwcGVuZENoaWxkKGVsZW1lbnQpO1xuICAgICAgICAgICAgY2hhbmdlZCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAocHJldmlvdXMgJiYgcHJldmlvdXMucmV2ID09PSBlbnRyeS5yZXYpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlOyAvLyDmsqHlj5hcbiAgICAgICAgfVxuICAgICAgICBwYWludEVudHJ5KHN0YXRlLCBlbGVtZW50LCBlbnRyeSk7XG4gICAgICAgIGNoYW5nZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gY2hhbmdlZDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlm77niYfpmYTku7ZcblxuLyoqXG4gKiDlm77niYfov5nmnaHpk77ot6/lnKgqKumdouadv+S+pyoq6KaB5YGa55qE5LqL77yM5ZKM5a6D55qE5Zub5p2h5Y+j5b6E44CCXG4gKlxuICogMS4gKirlhYjlvZLkuIDljJblho3ov5sgSVBDKirvvJrliarotLTmnb8v5bel56iL6YeM55qE5Zu+5Y+v6IO95piv5Lu75oSP5bC65a+444CB5Lu75oSP5qC85byP77yIQk1QL+aIquWxj+W3peWFt+S6p+WHuueahCBUSUZG4oCm77yJ77yMXG4gKiAgICDogIwgRFNIIOmZhOS7tuW6k+WPquaUtiBwbmcvanBlZy93ZWJwL2dpZiDlm5vnp43jgIHkuJTkvJrmi7/lrZfoioLpqozkuIDpgY3lo7DmmI7nmoQgTUlNReOAguaJgOS7pemdouadv+WFiFxuICogICAg44CM6Kej56CBIOKGkiDmjInpooTnrpfnvKnmlL4g4oaSIOe8lueggeaIkOeZveWQjeWNlemHjOeahOS4gOenjSDihpIg6KeE6IyDIGJhc2U2NOOAjeOAgui/meS5n+mhuuaJi+aKiiBJUEMg5LiK55qE5L2T56evXG4gKiAgICDku47jgIw0SyDmiKrlm77nmoTljYHlh6AgTULjgI3ljovliLDlh6AgTUIg5Lul5YaF77yI5YOP57Sg6aKE566X5LiO57yW56CB6aKE566X6YO954Wn6ZmE5Lu25bqT55qE5Y+j5b6E5p2l77yM6KeBIGBJTUFHRV9CVURHRVRg77yJ44CCXG4gKiAyLiAqKue8qeeVpeWbvuaYr+mdouadv+iHquW3seeUu+eahCoq77yaYDxpbWcgc3JjPVwiZGF0YTouLi5cIj5gIOS4gOW8oCAxMjhweCDnmoQgUE5HIOWPquacieWHoCBLQu+8jFxuICogICAg6ICM5Y6f5Zu+6KaB5YegIE1CIOKAlOKAlCDovpPlhaXljLrnmoTnoo7niYflkozpgInmi6nlmajnmoTmoLzlrZDpg73lj6rnnIvnvKnnlaXlm77vvIjljp/lm77lj6rnlZnlnKggYGRhdGFgIOmHjOetieedgOWPke+8ieOAglxuICogMy4gKirlj5HpgIHliY3kuI3okL3nm5jjgIHkuI3lhpnojYnnqL8qKu+8muWbvueJh+WPquWcqOWGheWtmOmHjO+8jOmdouadv+WFs+aOieWNs+S4ou+8iOiNieeov+WPquWtmOaWh+Wtl++8ieOAglxuICogICAg55CG55Sx77yabG9jYWxTdG9yYWdlIOaciSA1TUIg6YWN6aKd77yM5LiA5byg5Zu+5bCx6IO95oqK5a6D5pKR54iG77yM6ICM44CM6YWN6aKd54iG5LqG44CN55qE6KGo546w5pivXG4gKiAgICAqKuaVtOS4quiNieeov+WKn+iDvemdmem7mOWkseaViCoq77yI6L+e5bim5paH5a2X5LiA6LW35Lii77yJ77yM6L+Z5Liq5Luj5Lu35o2i5LiN5p2l44CM6K6w5L2P5LiK5qyh6LS055qE5Zu+44CN44CCXG4gKiA0LiAqKuWksei0peimgeivtOS6uuivnSoq77ya6K+75LiN5YiwL+WkquWkpy/moLzlvI/kuI3orqTvvIzkuIDlvovlj5jmiJDovpPlhaXljLrkuIrmlrnmqKrluYXph4znmoTkuIDlj6XkuK3mlofvvIxcbiAqICAgIOe7neS4jemdmem7mOS4ouWbvu+8iOmdmem7mOS4ouWbvueahOihqOeOsOaYr+OAjOaIkei0tOS6huS9huWug+ayoeWPkeWHuuWOu+OAje+8jOacgOmavuafpe+8ieOAglxuICovXG5sZXQgYXR0YWNoU2VxID0gMDtcblxuLyoqIOeZveWQjeWNlSBNSU1FIOmbhuWQiO+8iOS7jiBgSU1BR0VfTUlNRV9CWV9FWFRgIOaOqO+8jOWIq+aJi+aKhOesrOS6jOS7ve+8ieOAgiAqL1xuY29uc3QgQUNDRVBURURfTUlNRSA9IG5ldyBTZXQ8c3RyaW5nPihPYmplY3QudmFsdWVzKElNQUdFX01JTUVfQllfRVhUKSk7XG5cbi8qKiBNSU1FIOKGkiDmianlsZXlkI3vvIjmi7zmmL7npLrlkI3nlKjvvInjgIIgKi9cbmZ1bmN0aW9uIGV4dE9mTWltZShtaW1lVHlwZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobWltZVR5cGUgPT09ICdpbWFnZS9qcGVnJykgcmV0dXJuICdqcGcnO1xuICAgIHJldHVybiBtaW1lVHlwZS5yZXBsYWNlKC9eaW1hZ2VcXC8vLCAnJykgfHwgJ3BuZyc7XG59XG5cbi8qKlxuICog5pi+56S65ZCN5L+d6K+B5bimKirmraPnoa4qKueahOaJqeWxleWQjeOAglxuICpcbiAqIOS4pOS7tuS6i+mDveimgeWBmu+8muayoeacieaJqeWxleWQjeWwseihpe+8iOWJqui0tOadv+adpeeahOWbvuayoeacieWQjeWtl++8ie+8jOaJqeWxleWQjeS4jeWvueWwsSoq5o2i5o6JKiog4oCU4oCUXG4gKiDlj6rnnIvjgIzmnInmsqHmnInmianlsZXlkI3jgI3kvJrlvpfliLAgYHNjcmVlbnNob3QuYm1wLnBuZ2Ag6L+Z56eN5ZCN5a2X77yIYm1wIOS4jeWcqOeZveWQjeWNlemHjO+8jFxuICog5L2G5Y6L57yp5Lqn54mp5pivIFBOR++8ie+8jOWPkeWHuuWOu+S5i+WQjuiHquW3seS5n+eci+S4jeWHuuWIsOW6leWtmOeahOaYr+WTquenjeagvOW8j+OAglxuICovXG5mdW5jdGlvbiB3aXRoRXh0KG5hbWU6IHN0cmluZywgbWltZVR5cGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgd2FudGVkID0gYC4ke2V4dE9mTWltZShtaW1lVHlwZSl9YDtcbiAgICBjb25zdCB0cmltbWVkID0gKG5hbWUudHJpbSgpIHx8ICflm77niYcnKS5yZXBsYWNlKC9bXFxcXC86Kj9cIjw+fF0rL2csICdfJyk7XG4gICAgaWYgKHRyaW1tZWQudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCh3YW50ZWQpKSByZXR1cm4gdHJpbW1lZDtcbiAgICBjb25zdCB3aXRob3V0T2xkRXh0ID0gdHJpbW1lZC5yZXBsYWNlKC9cXC5bYS16MC05XXsxLDV9JC9pLCAnJyk7XG4gICAgcmV0dXJuIGAke3dpdGhvdXRPbGRFeHQgfHwgJ+WbvueJhyd9JHt3YW50ZWR9YDtcbn1cblxuLyoqIGJhc2U2NCDihpIg5a2X6IqC5pWw77yI6Z2i5p2/6YeM5Y+q5Li65pi+56S677yM5LiN5byVIEJ1ZmZlcu+8ieOAgiAqL1xuZnVuY3Rpb24gYmFzZTY0Qnl0ZXMoZGF0YTogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBjb25zdCBwYWRkaW5nID0gZGF0YS5lbmRzV2l0aCgnPT0nKSA/IDIgOiBkYXRhLmVuZHNXaXRoKCc9JykgPyAxIDogMDtcbiAgICByZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoZGF0YS5sZW5ndGggKiAzKSAvIDQpIC0gcGFkZGluZyk7XG59XG5cbi8qKlxuICog5oyJ6aKE566X566X55uu5qCH5bC65a+4IOKAlOKAlCAqKuS4jiBEU0gg6ZmE5Lu25bqT55qEIGByZXF1ZXN0SW1hZ2VEaW1lbnNpb25zYCDlkIzkuIDlpZfnrpfms5UqKuOAglxuICpcbiAqIOeul+azleS4gOiHtOeahOaEj+S5ie+8mumdouadv+eul+WHuuadpeeahOWwuuWvuOWwseaYr+mZhOS7tuW6kyoq5pys5p2l5Lmf5Lya57yp5YiwKirnmoTlsLrlr7jvvIzmiYDku6Xov5nkuIDmraXkuI3lvJXlhaVcbiAqIOS7u+S9lemineWkluaNn+Wkse+8jOWPquaYr+aKiuOAjOWNgeWHoCBNQiDnmoTljp/lm77jgI3mj5DliY3mjaLmjonjgIIqKuWPque8qeS4jeaUvioq77yI5bCP5Zu+5LiN5Yqo77yJ44CCXG4gKlxuICogQHBhcmFtIHdpZHRoIC0g5Y6f5aeL5a6944CCXG4gKiBAcGFyYW0gaGVpZ2h0IC0g5Y6f5aeL6auY44CCXG4gKiBAcmV0dXJucyDnm67moIflsLrlr7jvvIjmlbTmlbDvvIzoh7PlsJEgMe+8ieOAglxuICovXG5mdW5jdGlvbiBmaXRXaXRoaW4od2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBzY2FsZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgeyBtYXhQaXhlbHMsIG1heFNpZGUgfSA9IElNQUdFX0JVREdFVDtcbiAgICBsZXQgc2NhbGUgPSBNYXRoLm1pbigxLCBNYXRoLnNxcnQobWF4UGl4ZWxzIC8gKHdpZHRoICogaGVpZ2h0KSkpO1xuICAgIGlmIChNYXRoLm1heCh3aWR0aCwgaGVpZ2h0KSAqIHNjYWxlID4gbWF4U2lkZSkgc2NhbGUgPSBtYXhTaWRlIC8gTWF0aC5tYXgod2lkdGgsIGhlaWdodCk7XG4gICAgaWYgKHNjYWxlID49IDEpIHJldHVybiB7IHdpZHRoLCBoZWlnaHQsIHNjYWxlZDogZmFsc2UgfTtcbiAgICBsZXQgcHJvamVjdGVkV2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKHdpZHRoICogc2NhbGUpKTtcbiAgICBsZXQgcHJvamVjdGVkSGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChoZWlnaHQgKiBzY2FsZSkpO1xuICAgIHdoaWxlIChwcm9qZWN0ZWRXaWR0aCAqIHByb2plY3RlZEhlaWdodCA+IG1heFBpeGVscyAmJiBwcm9qZWN0ZWRXaWR0aCA+IDEpIHtcbiAgICAgICAgcHJvamVjdGVkV2lkdGggLT0gMTtcbiAgICAgICAgcHJvamVjdGVkSGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZCgocHJvamVjdGVkV2lkdGggKiBoZWlnaHQpIC8gd2lkdGgpKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgd2lkdGg6IHByb2plY3RlZFdpZHRoLCBoZWlnaHQ6IHByb2plY3RlZEhlaWdodCwgc2NhbGVkOiB0cnVlIH07XG59XG5cbi8qKiDop6PnoIHlkI7nmoTlm77vvIhgSW1hZ2VCaXRtYXBgIOS4jiBgPGltZz5gIOmDveiDvSBgZHJhd0ltYWdlYO+8jOaJgOS7pee7n+S4gOaIkOi/meS4quW9oueKtu+8ieOAgiAqL1xuaW50ZXJmYWNlIERlY29kZWRJbWFnZSB7XG4gICAgc291cmNlOiBDYW52YXNJbWFnZVNvdXJjZTtcbiAgICB3aWR0aDogbnVtYmVyO1xuICAgIGhlaWdodDogbnVtYmVyO1xuICAgIHJlbGVhc2U6ICgpID0+IHZvaWQ7XG59XG5cbi8qKlxuICog6Kej56CB5LiA5q615Zu+54mH5a2X6IqC44CCXG4gKlxuICog5Lik5p2h6Lev77yaYGNyZWF0ZUltYWdlQml0bWFwYO+8iOW/q+OAgeW8guatpeOAgeiDveebtOaOpeWGjee8luegge+8ieS4jiBgPGltZz5gICsgb2JqZWN0IFVSTO+8iOWFnOW6le+8ieOAglxuICog5ZCO6ICF5b+F6aG7IGByZXZva2VPYmplY3RVUkxg77yM5ZCm5YiZ5q+P6LS05LiA5byg5Zu+5bCx5ryP5LiA5LiqIGJsb2LjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVjb2RlQmxvYihibG9iOiBCbG9iKTogUHJvbWlzZTxEZWNvZGVkSW1hZ2U+IHtcbiAgICBpZiAodHlwZW9mIGNyZWF0ZUltYWdlQml0bWFwID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBiaXRtYXAgPSBhd2FpdCBjcmVhdGVJbWFnZUJpdG1hcChibG9iKTtcbiAgICAgICAgICAgIHJldHVybiB7IHNvdXJjZTogYml0bWFwLCB3aWR0aDogYml0bWFwLndpZHRoLCBoZWlnaHQ6IGJpdG1hcC5oZWlnaHQsIHJlbGVhc2U6ICgpID0+IGJpdG1hcC5jbG9zZT8uKCkgfTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDop6PnoIHlpLHotKUv5LiN5pSv5oyB77ya6JC95YiwIDxpbWc+IOmCo+adoei3r++8jOiuqeWug+e7meWHuuabtOa4healmueahOmUmeivryAqL1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7XG4gICAgY29uc3QgaW1hZ2UgPSBuZXcgSW1hZ2UoKTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICBpbWFnZS5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKCk7XG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6L+Z5Liq5paH5Lu25LiN5piv6IO96Kej56CB55qE5Zu+54mHJykpO1xuICAgICAgICAgICAgaW1hZ2Uuc3JjID0gdXJsO1xuICAgICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICByZXR1cm4geyBzb3VyY2U6IGltYWdlLCB3aWR0aDogaW1hZ2UubmF0dXJhbFdpZHRoLCBoZWlnaHQ6IGltYWdlLm5hdHVyYWxIZWlnaHQsIHJlbGVhc2U6ICgpID0+IFVSTC5yZXZva2VPYmplY3RVUkwodXJsKSB9O1xufVxuXG4vKiog5oqK6Kej56CB57uT5p6c55S75YiwIGNhbnZhc++8iGBmaWxsV2hpdGVgIOeUqOS6juimgei9rCBKUEVHIOeahOWcuuWQiO+8mumAj+aYjuWMuuWcqCBKUEVHIOmHjOS8muWPmOm7ke+8ieOAgiAqL1xuZnVuY3Rpb24gZHJhd1RvKGRlY29kZWQ6IERlY29kZWRJbWFnZSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIsIGZpbGxXaGl0ZSA9IGZhbHNlKTogSFRNTENhbnZhc0VsZW1lbnQge1xuICAgIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgIGNhbnZhcy53aWR0aCA9IHdpZHRoO1xuICAgIGNhbnZhcy5oZWlnaHQgPSBoZWlnaHQ7XG4gICAgY29uc3QgY29udGV4dCA9IGNhbnZhcy5nZXRDb250ZXh0KCcyZCcpO1xuICAgIGlmICghY29udGV4dCkgdGhyb3cgbmV3IEVycm9yKCfmi7/kuI3liLAgY2FudmFzIDJkIOS4iuS4i+aWhycpO1xuICAgIGlmIChmaWxsV2hpdGUpIHtcbiAgICAgICAgY29udGV4dC5maWxsU3R5bGUgPSAnI2ZmZmZmZic7XG4gICAgICAgIGNvbnRleHQuZmlsbFJlY3QoMCwgMCwgd2lkdGgsIGhlaWdodCk7XG4gICAgfVxuICAgIGNvbnRleHQuZHJhd0ltYWdlKGRlY29kZWQuc291cmNlLCAwLCAwLCB3aWR0aCwgaGVpZ2h0KTtcbiAgICByZXR1cm4gY2FudmFzO1xufVxuXG4vKiogY2FudmFzIOKGkiBKUEVH77yI6LSo6YeP5qKv5a2Q77yM5Y+W56ys5LiA5Liq6L+b6aKE566X55qE77yb6YO95LiN6KGM5bCx5Y+W5pyA5bCP55qE6YKj5Liq77yJ44CCICovXG5mdW5jdGlvbiBlbmNvZGVKcGVnKGNhbnZhczogSFRNTENhbnZhc0VsZW1lbnQpOiB7IG1pbWVUeXBlOiBJbWFnZU1pbWVUeXBlOyBkYXRhVXJsOiBzdHJpbmcgfSB7XG4gICAgbGV0IGJlc3Q6IHsgbWltZVR5cGU6IEltYWdlTWltZVR5cGU7IGRhdGFVcmw6IHN0cmluZzsgYnl0ZXM6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBxdWFsaXR5IG9mIEpQRUdfTEFEREVSKSB7XG4gICAgICAgIGNvbnN0IGRhdGFVcmwgPSBjYW52YXMudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgcXVhbGl0eSk7XG4gICAgICAgIGNvbnN0IGJ5dGVzID0gYmFzZTY0Qnl0ZXMoZGF0YVVybC5zbGljZShkYXRhVXJsLmluZGV4T2YoJywnKSArIDEpKTtcbiAgICAgICAgaWYgKCFiZXN0IHx8IGJ5dGVzIDwgYmVzdC5ieXRlcykgYmVzdCA9IHsgbWltZVR5cGU6ICdpbWFnZS9qcGVnJywgZGF0YVVybCwgYnl0ZXMgfTtcbiAgICAgICAgaWYgKGJ5dGVzIDw9IElNQUdFX0JVREdFVC5ub3JtYWxpemVkTWF4Qnl0ZXMpIGJyZWFrO1xuICAgIH1cbiAgICBpZiAoIWJlc3QpIHRocm93IG5ldyBFcnJvcignSlBFRyDnvJbnoIHlpLHotKUnKTtcbiAgICByZXR1cm4geyBtaW1lVHlwZTogYmVzdC5taW1lVHlwZSwgZGF0YVVybDogYmVzdC5kYXRhVXJsIH07XG59XG5cbi8qKlxuICogY2FudmFzIOKGkiB3ZWJw77yI6LSo6YeP5qKv5a2Q77yJ44CCXG4gKlxuICog4pqgICoq5b+F6aG76aqM5LiA5LiL5Zue5p2l55qE5piv5LiN5piv55yfIHdlYnAqKu+8mua1j+iniOWZqOS4jeaUr+aMgeafkOenjee8lueggeaXtu+8jGB0b0RhdGFVUkxgIOS8mioq6Z2Z6buY5Zue6JC95oiQIFBORyoqXG4gKiDvvIjkuI3miqXplJnvvInjgILoi6XkuI3pqozvvIzmiJHku6zkvJrmioogUE5HIOeahOWtl+iKguW9k+aIkCBgaW1hZ2Uvd2VicGAg5aOw5piO5Ye65Y67IOKAlOKAlCDpmYTku7blupPkvJrmi7/lrZfoioLpqoznsbvlnovvvIxcbiAqIOS6juaYr+aKpeS4gOS4quW+iOmavuaHgueahOmUmeOAglxuICpcbiAqIEByZXR1cm5zIHdlYnAg55qEIGRhdGEgVVJM77yb5rWP6KeI5Zmo5LiN5pSv5oyB57yW56CBIHdlYnAg5pe26L+U5ZueIG51bGzjgIJcbiAqL1xuZnVuY3Rpb24gZW5jb2RlV2VicChjYW52YXM6IEhUTUxDYW52YXNFbGVtZW50KTogeyBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTsgZGF0YVVybDogc3RyaW5nIH0gfCBudWxsIHtcbiAgICBsZXQgYmVzdDogeyBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTsgZGF0YVVybDogc3RyaW5nOyBieXRlczogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHF1YWxpdHkgb2YgSlBFR19MQURERVIpIHtcbiAgICAgICAgY29uc3QgZGF0YVVybCA9IGNhbnZhcy50b0RhdGFVUkwoJ2ltYWdlL3dlYnAnLCBxdWFsaXR5KTtcbiAgICAgICAgaWYgKCFkYXRhVXJsLnN0YXJ0c1dpdGgoJ2RhdGE6aW1hZ2Uvd2VicCcpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3QgYnl0ZXMgPSBiYXNlNjRCeXRlcyhkYXRhVXJsLnNsaWNlKGRhdGFVcmwuaW5kZXhPZignLCcpICsgMSkpO1xuICAgICAgICBpZiAoIWJlc3QgfHwgYnl0ZXMgPCBiZXN0LmJ5dGVzKSBiZXN0ID0geyBtaW1lVHlwZTogJ2ltYWdlL3dlYnAnLCBkYXRhVXJsLCBieXRlcyB9O1xuICAgICAgICBpZiAoYnl0ZXMgPD0gSU1BR0VfQlVER0VULm5vcm1hbGl6ZWRNYXhCeXRlcykgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiBiZXN0ID8geyBtaW1lVHlwZTogYmVzdC5taW1lVHlwZSwgZGF0YVVybDogYmVzdC5kYXRhVXJsIH0gOiBudWxsO1xufVxuXG4vKipcbiAqIGNhbnZhcyDihpIg55m95ZCN5Y2V6YeM55qE5LiA56eN57yW56CB77yM5bm25LiUKirljovov5vlvZLkuIDljJbpooTnrpcqKuOAglxuICpcbiAqIOmhuuW6j+aYr+eFpyBEU0gg6ZmE5Lu25bqT6Ieq5bex55qE5qKv5a2Q5p2l55qE77yIYFtcImFscGhhOndlYnBcIiwgXCJvcGFxdWU6anBlZ1wiXWDvvInvvJpcbiAqICoqUE5HIOKGkiB3ZWJwIOKGkiBKUEVHKirjgILnkIbnlLHvvJpQTkcg5L+d55yf5L2G5Y6L5LiN5Yqo77yM5LiA5bygIDRLIOaIquWbvuiDveWIsOWNgeWHoCBNQu+8jOiAjOmZhOS7tuW6k+mCo+i+uVxuICog6LaF6aKE566X54Wn5qC35Lya6YeN5Y6L5LiA6YGN77yIYG5vcm1hbGl6ZWRJbWFnZU1heEJ5dGVzYCA0TULvvInigJTigJQg5LiO5YW26K6p5Y2B5YegIE1CIOeahCBiYXNlNjRcbiAqIOi1sOS4gOi2nyBJUEMg5YaN6KKr5Y6L5o6J77yM5LiN5aaC5Zyo6Z2i5p2/6YeM5bCx5Y6L5aW944CCd2VicCDlnKgqKuaciemAj+aYjumAmumBkyoq5pe25piO5pi+5LyY5LqOIEpQRUdcbiAqIO+8iEpQRUcg5Lya5oqK6YCP5piO5Yy655S75oiQ6buR5Z2X77yJ77yM5omA5Lul5a6D5o6S5ZyoIEpQRUcg5YmN6Z2i77ybSlBFRyDpgqPkuIDmoaPopoHlhYjpk7rnmb3lupXjgIJcbiAqXG4gKiBAcGFyYW0gY2FudmFzIC0g5bey57uP55S75aW955uu5qCH5bC65a+455qE55S75biD44CCXG4gKiBAcmV0dXJucyDnvJbnoIHnu5PmnpzkuI7kuIDlj6XjgIzlgZrkuobku4DkuYjjgI3nmoTor7TmmI7vvIhgbm90ZWDvvInjgIJcbiAqL1xuZnVuY3Rpb24gZW5jb2RlQ2FudmFzKGNhbnZhczogSFRNTENhbnZhc0VsZW1lbnQpOiB7IG1pbWVUeXBlOiBJbWFnZU1pbWVUeXBlOyBkYXRhVXJsOiBzdHJpbmc7IG5vdGU/OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgcG5nID0gY2FudmFzLnRvRGF0YVVSTCgnaW1hZ2UvcG5nJyk7XG4gICAgaWYgKGJhc2U2NEJ5dGVzKHBuZy5zbGljZShwbmcuaW5kZXhPZignLCcpICsgMSkpIDw9IElNQUdFX0JVREdFVC5ub3JtYWxpemVkTWF4Qnl0ZXMpIHtcbiAgICAgICAgcmV0dXJuIHsgbWltZVR5cGU6ICdpbWFnZS9wbmcnLCBkYXRhVXJsOiBwbmcgfTtcbiAgICB9XG4gICAgY29uc3Qgd2VicCA9IGVuY29kZVdlYnAoY2FudmFzKTtcbiAgICBpZiAod2VicCAmJiBiYXNlNjRCeXRlcyh3ZWJwLmRhdGFVcmwuc2xpY2Uod2VicC5kYXRhVXJsLmluZGV4T2YoJywnKSArIDEpKSA8PSBJTUFHRV9CVURHRVQubm9ybWFsaXplZE1heEJ5dGVzKSB7XG4gICAgICAgIHJldHVybiB7IC4uLndlYnAsIG5vdGU6ICdQTkcg5Y6L5LiN6L+b6aKE566XIOKGkiB3ZWJwJyB9O1xuICAgIH1cbiAgICAvLyDpk7rnmb3lupXlho3nvJYgSlBFR++8mumAj+aYjuWMuuWcqCBKUEVHIOmHjOaYr+m7keeahO+8jOebtOaOpee8luS8muW+l+WIsOS4gOW8oOOAjOm7keW6leWbvuOAjVxuICAgIGNvbnN0IGZsYXR0ZW5lZCA9IGRyYXdUbyh7IHNvdXJjZTogY2FudmFzLCB3aWR0aDogY2FudmFzLndpZHRoLCBoZWlnaHQ6IGNhbnZhcy5oZWlnaHQsIHJlbGVhc2U6ICgpID0+IHVuZGVmaW5lZCB9LCBjYW52YXMud2lkdGgsIGNhbnZhcy5oZWlnaHQsIHRydWUpO1xuICAgIGNvbnN0IGpwZWcgPSBlbmNvZGVKcGVnKGZsYXR0ZW5lZCk7XG4gICAgaWYgKGJhc2U2NEJ5dGVzKGpwZWcuZGF0YVVybC5zbGljZShqcGVnLmRhdGFVcmwuaW5kZXhPZignLCcpICsgMSkpIDw9IElNQUdFX0JVREdFVC5ub3JtYWxpemVkTWF4Qnl0ZXMpIHtcbiAgICAgICAgcmV0dXJuIHsgLi4uanBlZywgbm90ZTogJ1BORyDljovkuI3ov5vpooTnrpcg4oaSIEpQRUcnIH07XG4gICAgfVxuICAgIC8vIOi/nui0qOmHj+air+WtkOmDveWOi+S4jei/m++8iOaegeerr+Wkp+Wbvu+8ie+8muS6pOWbnue7memZhOS7tuW6k++8jOiuqeWug+aMieiHquW3seeahOetlueVpeWkhOeQhlxuICAgIHJldHVybiB7IC4uLmpwZWcsIG5vdGU6ICfljovkuI3ov5vpooTnrpfvvIzkuqTnu5npmYTku7blupPlvZLkuIDljJYnIH07XG59XG5cbi8qKiDnvKnnlaXlm77vvJriiaQxMjhweCDnmoQgUE5HIGRhdGEgVVJM77yI5YegIEtC77yM6ZqP5L6/5aGe6L+bIERPTe+8ieOAgiAqL1xuZnVuY3Rpb24gbWFrZVRodW1iKGRlY29kZWQ6IERlY29kZWRJbWFnZSk6IHN0cmluZyB7XG4gICAgY29uc3Qgc2lkZSA9IElNQUdFX0JVREdFVC50aHVtYlNpZGU7XG4gICAgY29uc3Qgc2NhbGUgPSBNYXRoLm1pbigxLCBzaWRlIC8gTWF0aC5tYXgoZGVjb2RlZC53aWR0aCwgZGVjb2RlZC5oZWlnaHQpKTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoZGVjb2RlZC53aWR0aCAqIHNjYWxlKSk7XG4gICAgY29uc3QgaGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChkZWNvZGVkLmhlaWdodCAqIHNjYWxlKSk7XG4gICAgcmV0dXJuIGRyYXdUbyhkZWNvZGVkLCB3aWR0aCwgaGVpZ2h0KS50b0RhdGFVUkwoJ2ltYWdlL3BuZycpO1xufVxuXG4vKiogQmxvYiDihpIg6KeE6IyDIGJhc2U2NO+8iGByZWFkQXNEYXRhVVJMYCDnu5nnmoTmraPmmK/op4TojIPlvaLlvI/vvIzljrvliY3nvIDljbPlj6/vvInjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIGJsb2JUb0Jhc2U2NChibG9iOiBCbG9iKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBkYXRhVXJsID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGNvbnN0IHJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG4gICAgICAgIHJlYWRlci5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKFN0cmluZyhyZWFkZXIucmVzdWx0ID8/ICcnKSk7XG4gICAgICAgIHJlYWRlci5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6K+75LiN5Ye66L+Z5byg5Zu+55qE5pWw5o2uJykpO1xuICAgICAgICByZWFkZXIucmVhZEFzRGF0YVVSTChibG9iKTtcbiAgICB9KTtcbiAgICBjb25zdCBjb21tYSA9IGRhdGFVcmwuaW5kZXhPZignLCcpO1xuICAgIGlmIChjb21tYSA8IDApIHRocm93IG5ldyBFcnJvcign6L+Z5byg5Zu+55qE5pWw5o2u5LiN5pivIGRhdGEgVVJMJyk7XG4gICAgcmV0dXJuIGRhdGFVcmwuc2xpY2UoY29tbWEgKyAxKTtcbn1cblxuLyoqXG4gKiDlvZLkuIDljJbkuIDlvKDlm74g4oaSIOWPr+ebtOaOpeWPkemAgeeahCBgQXR0YWNobWVudGDjgIJcbiAqXG4gKiBAcGFyYW0gYmxvYiAtIOWbvueJh+Wtl+iKgu+8iOWJqui0tOadvy/lt6XnqIvor7vlj5Yv5ouW5ou95LiJ5Liq5p2l5rqQ6YO95piv5a6D77yJ44CCXG4gKiBAcGFyYW0gbmFtZSAtIOaYvuekuuWQje+8iOWPr+S7peayoeacieaJqeWxleWQje+8ieOAglxuICogQHBhcmFtIG9yaWdpbiAtIOadpea6kO+8jOWPqueUqOS6juaYvuekuuS4juaOkuafpeOAglxuICogQHJldHVybnMg6ZmE5Lu277yM5oiW5LiA5Y+l5Lq66K+d55qE5aSx6LSl5Y6f5Zug44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkQXR0YWNobWVudChcbiAgICBibG9iOiBCbG9iLFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBvcmlnaW46IEF0dGFjaG1lbnRbJ29yaWdpbiddLFxuKTogUHJvbWlzZTx7IGF0dGFjaG1lbnQ6IEF0dGFjaG1lbnQgfSB8IHsgZXJyb3I6IHN0cmluZyB9PiB7XG4gICAgaWYgKGJsb2Iuc2l6ZSA+IE1BWF9JTUFHRV9CWVRFUykge1xuICAgICAgICByZXR1cm4geyBlcnJvcjogYCR7bmFtZX3mnIkgJHtmb3JtYXRCeXRlcyhibG9iLnNpemUpfe+8jOi2hei/h+WNleW8oOS4iumZkCAke2Zvcm1hdEJ5dGVzKE1BWF9JTUFHRV9CWVRFUyl977yI6ZmE5Lu25bqT5piv5ouS5pS26ICM5LiN5piv5Y6L57yp77yJ44CCYCB9O1xuICAgIH1cbiAgICBsZXQgZGVjb2RlZDogRGVjb2RlZEltYWdlO1xuICAgIHRyeSB7XG4gICAgICAgIGRlY29kZWQgPSBhd2FpdCBkZWNvZGVCbG9iKGJsb2IpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7IGVycm9yOiBgJHtuYW1lfSDop6PkuI3lvIDvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gIH07XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGlmICghZGVjb2RlZC53aWR0aCB8fCAhZGVjb2RlZC5oZWlnaHQpIHJldHVybiB7IGVycm9yOiBgJHtuYW1lfSDnmoTlg4/ntKDlsLrlr7jmmK8gMO+8jOivu+S4jeWHuuWGheWuueOAgmAgfTtcblxuICAgICAgICBjb25zdCBzb3VyY2VNaW1lID0gKGJsb2IudHlwZSB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZml0V2l0aGluKGRlY29kZWQud2lkdGgsIGRlY29kZWQuaGVpZ2h0KTtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOW/q+i3r++8iOWOn+agt+WPke+8ieeahOS4ieS4quadoeS7tu+8jOe8uuS4gOS4jeWPr++8mlxuICAgICAgICAgKiDikaAg5aOw5piO55qEIE1JTUUg5Zyo55m95ZCN5Y2V6YeM77yI6ZmE5Lu25bqT5Y+q5pS26YKj5Zub56eN77yJ77ybXG4gICAgICAgICAqIOKRoSDlsLrlr7jlnKjlg4/ntKDpooTnrpflhoXvvIjlkKbliJnopoHnvKnvvInvvJtcbiAgICAgICAgICog4pGiIOWtl+iKguWcqOW9kuS4gOWMlumihOeul+WGhSDigJTigJQg6LaF5LqG6ZmE5Lu25bqT5Y+N5q2j5Lmf5Lya6YeN5Y6L5LiA6YGN77yM6YKj5bCxKirlnKjpnaLmnb/ph4zljosqKlxuICAgICAgICAgKiAgICDvvIjljYHlh6AgTUIg55qEIGJhc2U2NCDotbDkuIDotp8gSVBDIOaYr+e6r+a1qui0ue+8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3QgcmV1c2FibGUgPVxuICAgICAgICAgICAgQUNDRVBURURfTUlNRS5oYXMoc291cmNlTWltZSkgJiYgIXRhcmdldC5zY2FsZWQgJiYgYmxvYi5zaXplIDw9IElNQUdFX0JVREdFVC5ub3JtYWxpemVkTWF4Qnl0ZXM7XG4gICAgICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgICAgIGxldCBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTtcbiAgICAgICAgbGV0IGRhdGE6IHN0cmluZztcbiAgICAgICAgaWYgKHJldXNhYmxlKSB7XG4gICAgICAgICAgICBtaW1lVHlwZSA9IHNvdXJjZU1pbWUgYXMgSW1hZ2VNaW1lVHlwZTtcbiAgICAgICAgICAgIGRhdGEgPSBhd2FpdCBibG9iVG9CYXNlNjQoYmxvYik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBjYW52YXMgPSBkcmF3VG8oZGVjb2RlZCwgdGFyZ2V0LndpZHRoLCB0YXJnZXQuaGVpZ2h0KTtcbiAgICAgICAgICAgIGNvbnN0IGVuY29kZWQgPSBlbmNvZGVDYW52YXMoY2FudmFzKTtcbiAgICAgICAgICAgIG1pbWVUeXBlID0gZW5jb2RlZC5taW1lVHlwZTtcbiAgICAgICAgICAgIGRhdGEgPSBlbmNvZGVkLmRhdGFVcmwuc2xpY2UoZW5jb2RlZC5kYXRhVXJsLmluZGV4T2YoJywnKSArIDEpO1xuICAgICAgICAgICAgaWYgKHRhcmdldC5zY2FsZWQpIG5vdGVzLnB1c2goYOW3sue8qeWIsCAke3RhcmdldC53aWR0aH3DlyR7dGFyZ2V0LmhlaWdodH1gKTtcbiAgICAgICAgICAgIGlmICghQUNDRVBURURfTUlNRS5oYXMoc291cmNlTWltZSkpIG5vdGVzLnB1c2goYCR7c291cmNlTWltZSB8fCAn5pyq55+l5qC85byPJ30g4oaSICR7ZXh0T2ZNaW1lKG1pbWVUeXBlKX1gKTtcbiAgICAgICAgICAgIGlmIChlbmNvZGVkLm5vdGUpIG5vdGVzLnB1c2goZW5jb2RlZC5ub3RlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGJ5dGVzID0gYmFzZTY0Qnl0ZXMoZGF0YSk7XG4gICAgICAgIGlmIChieXRlcyA+IE1BWF9JTUFHRV9CWVRFUykge1xuICAgICAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGAke25hbWV9IOW9kuS4gOWMluWQjuS7jeaciSAke2Zvcm1hdEJ5dGVzKGJ5dGVzKX3vvIzotoXov4fljZXlvKDkuIrpmZAgJHtmb3JtYXRCeXRlcyhNQVhfSU1BR0VfQllURVMpfeOAgmAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYXR0YWNobWVudDoge1xuICAgICAgICAgICAgICAgIGlkOiBgaW1nXyR7KythdHRhY2hTZXF9YCxcbiAgICAgICAgICAgICAgICBuYW1lOiB3aXRoRXh0KG5hbWUsIG1pbWVUeXBlKSxcbiAgICAgICAgICAgICAgICBtaW1lVHlwZSxcbiAgICAgICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgICAgIGJ5dGVzLFxuICAgICAgICAgICAgICAgIHdpZHRoOiBkZWNvZGVkLndpZHRoLFxuICAgICAgICAgICAgICAgIGhlaWdodDogZGVjb2RlZC5oZWlnaHQsXG4gICAgICAgICAgICAgICAgdGh1bWI6IG1ha2VUaHVtYihkZWNvZGVkKSxcbiAgICAgICAgICAgICAgICBvcmlnaW4sXG4gICAgICAgICAgICAgICAgbm90ZTogbm90ZXMuam9pbignIMK3ICcpIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgZGVjb2RlZC5yZWxlYXNlKCk7XG4gICAgfVxufVxuXG4vKiog55S76L6T5YWl5Yy65LiK5pa56YKj5o6S5Zu+54mH56KO54mH44CCICovXG5mdW5jdGlvbiByZW5kZXJBdHRhY2htZW50cyhzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBzdGF0ZS5hdHRhY2hIb3N0O1xuICAgIGlmICghaG9zdCkgcmV0dXJuO1xuICAgIGhvc3QudGV4dENvbnRlbnQgPSAnJztcbiAgICBob3N0LmhpZGRlbiA9IHN0YXRlLmF0dGFjaG1lbnRzLmxlbmd0aCA9PT0gMDtcbiAgICBmb3IgKGNvbnN0IGF0dGFjaG1lbnQgb2Ygc3RhdGUuYXR0YWNobWVudHMpIHtcbiAgICAgICAgY29uc3QgY2hpcCA9IGVsKCdkaXYnLCAnZHNoLWF0dGFjaCcpO1xuICAgICAgICBjb25zdCB0aHVtYiA9IGVsKCdpbWcnLCAnZHNoLWF0dGFjaC10aHVtYicpO1xuICAgICAgICB0aHVtYi5zcmMgPSBhdHRhY2htZW50LnRodW1iO1xuICAgICAgICB0aHVtYi5hbHQgPSBhdHRhY2htZW50Lm5hbWU7XG4gICAgICAgIGNvbnN0IG1ldGEgPSBlbCgnZGl2JywgJ2RzaC1hdHRhY2gtbWV0YScpO1xuICAgICAgICBtZXRhLmFwcGVuZChcbiAgICAgICAgICAgIGVsKCdkaXYnLCAnZHNoLWF0dGFjaC1uYW1lJywgYXR0YWNobWVudC5uYW1lKSxcbiAgICAgICAgICAgIGVsKFxuICAgICAgICAgICAgICAgICdkaXYnLFxuICAgICAgICAgICAgICAgICdkc2gtYXR0YWNoLXNpemUnLFxuICAgICAgICAgICAgICAgIGAke2F0dGFjaG1lbnQud2lkdGh9w5cke2F0dGFjaG1lbnQuaGVpZ2h0fSDCtyAke2Zvcm1hdEJ5dGVzKGF0dGFjaG1lbnQuYnl0ZXMpfWAgK1xuICAgICAgICAgICAgICAgICAgICAoYXR0YWNobWVudC5ub3RlID8gYCDCtyAke2F0dGFjaG1lbnQubm90ZX1gIDogJycpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gZWwoJ2J1dHRvbicsICdkc2gtYXR0YWNoLWRlbCcsICfinJUnKTtcbiAgICAgICAgcmVtb3ZlLnRpdGxlID0gJ+enu+mZpOi/meW8oOWbvic7XG4gICAgICAgIHJlbW92ZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHN0YXRlLmF0dGFjaG1lbnRzID0gc3RhdGUuYXR0YWNobWVudHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmlkICE9PSBhdHRhY2htZW50LmlkKTtcbiAgICAgICAgICAgIHJlbmRlckF0dGFjaG1lbnRzKHN0YXRlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNoaXAuYXBwZW5kKHRodW1iLCBtZXRhLCByZW1vdmUpO1xuICAgICAgICBob3N0LmFwcGVuZENoaWxkKGNoaXApO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuaW1hZ2VCdXR0b24pIHtcbiAgICAgICAgc3RhdGUuaW1hZ2VCdXR0b24uZGF0YXNldC5jb3VudCA9IFN0cmluZyhzdGF0ZS5hdHRhY2htZW50cy5sZW5ndGgpO1xuICAgICAgICBzdGF0ZS5pbWFnZUJ1dHRvbi50aXRsZSA9XG4gICAgICAgICAgICBzdGF0ZS5pbWFnZUJ1dHRvbi5kYXRhc2V0LmNvdW50ID09PSAnMCdcbiAgICAgICAgICAgICAgICA/ICfmt7vliqDlm77niYfvvJpDdHJsK1Yg57KY6LS05Ymq6LS05p2/77yM5oiW5Zyo6L+Z6YeM6YCJ5bel56iL6YeM55qE5Zu+J1xuICAgICAgICAgICAgICAgIDogYOW3sumZhCAke3N0YXRlLmF0dGFjaG1lbnRzLmxlbmd0aH0g5byg5Zu+77yI54K55Ye757un57ut5re75Yqg77yJYDtcbiAgICB9XG59XG5cbi8qKiDmiorkuIDmibkgYEF0dGFjaG1lbnRgIOaIluS4gOWPpemUmeivr+WPjeaYoOWIsOmdouadv+S4iu+8iOWUr+S4gOWFpeWPo++8jOWIq+WcqOS4pOWkhOWQhOWGmeS4gOmBje+8ieOAgiAqL1xuZnVuY3Rpb24gYWRkQXR0YWNobWVudHMoc3RhdGU6IFVpU3RhdGUsIGF0dGFjaG1lbnRzOiBBdHRhY2htZW50W10pOiB2b2lkIHtcbiAgICBpZiAoYXR0YWNobWVudHMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgcm9vbSA9IE1BWF9JTUFHRVNfUEVSX01FU1NBR0UgLSBzdGF0ZS5hdHRhY2htZW50cy5sZW5ndGg7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBhdHRhY2htZW50cy5zbGljZSgwLCBNYXRoLm1heCgwLCByb29tKSk7XG4gICAgaWYgKGFjY2VwdGVkLmxlbmd0aCA8IGF0dGFjaG1lbnRzLmxlbmd0aCkge1xuICAgICAgICBzZXRCYW5uZXIoXG4gICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgIGDkuIDmnaHmtojmga/mnIDlpJrluKYgJHtNQVhfSU1BR0VTX1BFUl9NRVNTQUdFfSDlvKDlm77vvIzlpJrlh7rmnaXnmoQgJHthdHRhY2htZW50cy5sZW5ndGggLSBhY2NlcHRlZC5sZW5ndGh9IOW8oOayoeacieWKoOS4iuOAgmAsXG4gICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICBbXSxcbiAgICAgICAgICAgIEJBTk5FUl9IT0xELklORk8sXG4gICAgICAgICk7XG4gICAgfVxuICAgIHN0YXRlLmF0dGFjaG1lbnRzID0gWy4uLnN0YXRlLmF0dGFjaG1lbnRzLCAuLi5hY2NlcHRlZF07XG4gICAgcmVuZGVyQXR0YWNobWVudHMoc3RhdGUpO1xuICAgIHJlcG9ydFByb2JlKHtcbiAgICAgICAga2luZDogJ2F0dGFjaCcsXG4gICAgICAgIGNvdW50OiBzdGF0ZS5hdHRhY2htZW50cy5sZW5ndGgsXG4gICAgICAgIGJ5dGVzOiBzdGF0ZS5hdHRhY2htZW50cy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgaXRlbS5ieXRlcywgMCksXG4gICAgICAgIG1pbWVzOiBbLi4ubmV3IFNldChzdGF0ZS5hdHRhY2htZW50cy5tYXAoKGl0ZW0pID0+IGl0ZW0ubWltZVR5cGUpKV0sXG4gICAgfSk7XG59XG5cbi8qKlxuICog44CM5oqK6L+Z5Yeg5byg5Zu+5Yqg5LiK44CN4oCU4oCU57KY6LS044CB5ouW5ou944CB6YCJ5Zu+5LiJ5p2h6Lev5YWx55So55qE5YWl5Y+j44CCXG4gKlxuICog5aSx6LSl5LiA5b6L6L+b5qiq5bmF77yI5LiN5oqb77yJ77ya6Z2i5p2/5oqb6ZSZ5Lya5rGh5p+T57yW6L6R5Zmo5o6n5Yi25Y+w5LiU55So5oi35LuA5LmI6YO955yL5LiN5Yiw77yI6KeB5paH5Lu25aS056ysIDUg5p2h77yJ44CCXG4gKlxuICogQHBhcmFtIGJsb2JzIC0g5LiA5om55Zu+54mH5a2X6IqCICsg5ZCN5a2X44CCXG4gKiBAcGFyYW0gb3JpZ2luIC0g5p2l5rqQ5qCH6K6w44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGF0dGFjaEJsb2JzKHN0YXRlOiBVaVN0YXRlLCBibG9iczogQXJyYXk8eyBibG9iOiBCbG9iOyBuYW1lOiBzdHJpbmcgfT4sIG9yaWdpbjogQXR0YWNobWVudFsnb3JpZ2luJ10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoYmxvYnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgc3RhdGUuaW1hZ2VCdXN5ICs9IDE7XG4gICAgaWYgKHN0YXRlLmltYWdlQnV0dG9uKSBzdGF0ZS5pbWFnZUJ1dHRvbi5kYXRhc2V0LmJ1c3kgPSAndHJ1ZSc7XG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGJ1aWx0OiBBdHRhY2htZW50W10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgYmxvYnMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGJ1aWxkQXR0YWNobWVudChpdGVtLmJsb2IsIGl0ZW0ubmFtZSwgb3JpZ2luKTtcbiAgICAgICAgICAgIGlmICgnYXR0YWNobWVudCcgaW4gcmVzdWx0KSBidWlsdC5wdXNoKHJlc3VsdC5hdHRhY2htZW50KTtcbiAgICAgICAgICAgIGVsc2UgZXJyb3JzLnB1c2gocmVzdWx0LmVycm9yKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGDlpITnkIblm77niYfml7blh7rplJnvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBzdGF0ZS5pbWFnZUJ1c3kgLT0gMTtcbiAgICAgICAgaWYgKHN0YXRlLmltYWdlQnV0dG9uKSBzdGF0ZS5pbWFnZUJ1dHRvbi5kYXRhc2V0LmJ1c3kgPSBzdGF0ZS5pbWFnZUJ1c3kgPiAwID8gJ3RydWUnIDogJ2ZhbHNlJztcbiAgICB9XG4gICAgYWRkQXR0YWNobWVudHMoc3RhdGUsIGJ1aWx0KTtcbiAgICBpZiAoZXJyb3JzLmxlbmd0aCA+IDApIHNldEJhbm5lcihzdGF0ZSwgZXJyb3JzLmpvaW4oJ1xcbicpLCAnZXJyb3InLCBbXSwgQkFOTkVSX0hPTEQuRVJST1IpO1xuICAgIGVsc2UgaWYgKGJ1aWx0Lmxlbmd0aCA+IDApIHNldEJhbm5lcihzdGF0ZSwgbnVsbCk7XG59XG5cbi8qKlxuICog5Ymq6LS05p2/6YeM5pyJ5rKh5pyJ5Zu+IOKAlOKAlCDkuKTnp43mnaXmupDpg73opoHorqTjgIJcbiAqXG4gKiB8IOadpea6kCB8IOW9oueKtiB8XG4gKiB8LS0tfC0tLXxcbiAqIHwg5oiq5Zu+L+WkjeWItuWbvueJh++8iEV4cGxvcmVy44CB5b6u5L+h44CBUVHigKbvvIkgfCBgRGF0YVRyYW5zZmVySXRlbS5raW5kID09PSAnZmlsZSdg77yMYHR5cGVgIOaYryBgaW1hZ2UvKmAgfFxuICogfCDku47mtY/op4jlmagv572R6aG16YeM5aSN5Yi2IHwg572R6aG15Y+v6IO95Y+q5pS+IGB0ZXh0L2h0bWxg77yM5L2GIENocm9taXVtIOS4gOiIrOS5n+S8muW4piBgaW1hZ2UvcG5nYCDnmoQgZmlsZSDpobkgfFxuICpcbiAqIOWPquaciSoq56Gu6K6k5pyJ5Zu+KirmiY0gYHByZXZlbnREZWZhdWx0KClg77ya57qv5paH5a2X57KY6LS05b+F6aG75Y6f5qC35Lqk57uZIHRleHRhcmVh77yM5ZCm5YiZ44CM57KY6LS05LiA5q615paH5a2X44CNXG4gKiDkvJrooqvmiJHku6zlkIPmjonvvIjpgqPmmK/mnIDluLjop4HnmoTmk43kvZzvvIznu53kuI3og73norDvvInjgIJcbiAqL1xuZnVuY3Rpb24gaW1hZ2VzRnJvbUNsaXBib2FyZChkYXRhOiBEYXRhVHJhbnNmZXIgfCBudWxsKTogQXJyYXk8eyBibG9iOiBCbG9iOyBuYW1lOiBzdHJpbmcgfT4ge1xuICAgIGNvbnN0IG91dDogQXJyYXk8eyBibG9iOiBCbG9iOyBuYW1lOiBzdHJpbmcgfT4gPSBbXTtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBvdXQ7XG4gICAgY29uc3QgaXRlbXMgPSBkYXRhLml0ZW1zID8gQXJyYXkuZnJvbShkYXRhLml0ZW1zKSA6IFtdO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgICBpZiAoaXRlbS5raW5kICE9PSAnZmlsZScpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoIWl0ZW0udHlwZSB8fCAhaXRlbS50eXBlLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aCgnaW1hZ2UvJykpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBmaWxlID0gaXRlbS5nZXRBc0ZpbGUoKTtcbiAgICAgICAgaWYgKCFmaWxlKSBjb250aW51ZTtcbiAgICAgICAgb3V0LnB1c2goeyBibG9iOiBmaWxlLCBuYW1lOiBmaWxlLm5hbWUgJiYgZmlsZS5uYW1lICE9PSAnaW1hZ2UucG5nJyA/IGZpbGUubmFtZSA6IGDliarotLTmnb/lm77niYctJHtvdXQubGVuZ3RoICsgMX1gIH0pO1xuICAgIH1cbiAgICBpZiAob3V0Lmxlbmd0aCA9PT0gMCAmJiBkYXRhLmZpbGVzICYmIGRhdGEuZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyDmnInkupvmnaXmupDkuI3lnKggaXRlbXMg6YeM44CB5Y+q5ZyoIGZpbGVzIOmHjFxuICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgQXJyYXkuZnJvbShkYXRhLmZpbGVzKSkge1xuICAgICAgICAgICAgaWYgKGZpbGUudHlwZS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ2ltYWdlLycpKSB7XG4gICAgICAgICAgICAgICAgb3V0LnB1c2goeyBibG9iOiBmaWxlLCBuYW1lOiBmaWxlLm5hbWUgfHwgYOWJqui0tOadv+WbvueJhy0ke291dC5sZW5ndGggKyAxfWAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlm77niYfpgInmi6nlmajvvIjlt6XnqIvlm77niYfvvIlcblxuLyoqIGBsaXN0LWltYWdlc2Ag55qE5Zue5omn44CCICovXG5pbnRlcmZhY2UgTGlzdEltYWdlc1JlcGx5IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBzb3VyY2U/OiBzdHJpbmc7XG4gICAgdG90YWw/OiBudW1iZXI7XG4gICAgaW1hZ2VzPzogUHJvamVjdEltYWdlW107XG4gICAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8qKiBgcmVhZC1pbWFnZWAg55qE5Zue5omn44CCICovXG5pbnRlcmZhY2UgUmVhZEltYWdlUmVwbHkge1xuICAgIG9rOiBib29sZWFuO1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgcGF0aD86IHN0cmluZztcbiAgICB1cmw/OiBzdHJpbmc7XG4gICAgbWltZVR5cGU/OiBzdHJpbmc7XG4gICAgYnl0ZXM/OiBudW1iZXI7XG4gICAgZGF0YT86IHN0cmluZztcbiAgICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqIOaLieS4gOasoeW3peeoi+WbvueJh+a4heWNle+8iOW4pue8k+WtmO+8m2Bmb3JjZWAg5pe26YeN5ouJ77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVQaWNrZXJMaXN0KHN0YXRlOiBVaVN0YXRlLCBmb3JjZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN0YXRlLnBpY2tlckltYWdlcyAmJiAhZm9yY2UpIHJldHVybjtcbiAgICBpZiAoc3RhdGUucGlja2VyTm90ZSkge1xuICAgICAgICBzdGF0ZS5waWNrZXJOb3RlLnRleHRDb250ZW50ID0gJ+ato+WcqOivu+W3peeoi+eahOi1hOa6kOW6k+KApic7XG4gICAgICAgIHN0YXRlLnBpY2tlck5vdGUuZGF0YXNldC50b25lID0gJyc7XG4gICAgfVxuICAgIGxldCByZXBseTogTGlzdEltYWdlc1JlcGx5O1xuICAgIHRyeSB7XG4gICAgICAgIHJlcGx5ID0gYXdhaXQgY2FsbDxMaXN0SW1hZ2VzUmVwbHk+KE1TRy5saXN0SW1hZ2VzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXBseSA9IHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycm9yKSB9O1xuICAgIH1cbiAgICBpZiAoIXJlcGx5Py5vaykge1xuICAgICAgICBzdGF0ZS5waWNrZXJJbWFnZXMgPSBbXTtcbiAgICAgICAgaWYgKHN0YXRlLnBpY2tlck5vdGUpIHtcbiAgICAgICAgICAgIHN0YXRlLnBpY2tlck5vdGUudGV4dENvbnRlbnQgPSBg6K+75LiN5Yiw5bel56iL5Zu+54mH77yaJHtyZXBseT8uZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YDtcbiAgICAgICAgICAgIHN0YXRlLnBpY2tlck5vdGUuZGF0YXNldC50b25lID0gJ2Vycm9yJztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHN0YXRlLnBpY2tlckltYWdlcyA9IHJlcGx5LmltYWdlcyA/PyBbXTtcbiAgICBzdGF0ZS5waWNrZXJTb3VyY2UgPSByZXBseS5zb3VyY2UgPz8gJyc7XG4gICAgcmVuZGVyUGlja2VyTGlzdChzdGF0ZSk7XG59XG5cbi8qKiDnlLvpgInmi6nlmajph4znmoTmoLzlrZDvvIjmjInmkJzntKLor43ov4fmu6TlkI7vvInjgIIgKi9cbmZ1bmN0aW9uIHJlbmRlclBpY2tlckxpc3Qoc3RhdGU6IFVpU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBsaXN0ID0gc3RhdGUucGlja2VyTGlzdDtcbiAgICBpZiAoIWxpc3QpIHJldHVybjtcbiAgICBjb25zdCBhbGwgPSBzdGF0ZS5waWNrZXJJbWFnZXMgPz8gW107XG4gICAgY29uc3Qgc2hvd24gPSBmaWx0ZXJQcm9qZWN0SW1hZ2VzKGFsbCwgc3RhdGUucGlja2VyUXVlcnkpLnNsaWNlKDAsIE1BWF9MSVNURURfSU1BR0VTKTtcbiAgICBsaXN0LnRleHRDb250ZW50ID0gJyc7XG4gICAgc3RhdGUucGlja2VyT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICBzdGF0ZS5waWNrZXJPYnNlcnZlciA9IG51bGw7XG4gICAgc3RhdGUucGlja2VyUXVldWUgPSBbXTtcblxuICAgIGlmIChzdGF0ZS5waWNrZXJOb3RlKSB7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IHN0YXRlLnBpY2tlclNvdXJjZSA9PT0gJ3NjYW4nID8gJ++8iOi1hOa6kOW6k+ayoee7meWHuue7k+aenO+8jOi/meaYr+aJqyBhc3NldHMg55uu5b2V5b6X5Yiw55qE77yJJyA6ICcnO1xuICAgICAgICBzdGF0ZS5waWNrZXJOb3RlLnRleHRDb250ZW50ID1cbiAgICAgICAgICAgIGFsbC5sZW5ndGggPT09IDBcbiAgICAgICAgICAgICAgICA/ICfov5nkuKrlt6XnqIvph4zmsqHmib7liLDlm77niYfvvIjlj6rorqQgcG5nIC8ganBnIC8ganBlZyAvIHdlYnAgLyBnaWbvvInjgIInXG4gICAgICAgICAgICAgICAgOiBg5YWxICR7YWxsLmxlbmd0aH0g5bygJHtvcmlnaW59JHtzdGF0ZS5waWNrZXJRdWVyeSA/IGDvvIznrZvlh7ogJHtzaG93bi5sZW5ndGh9IOW8oGAgOiAnJ30gwrcg54K55LiA5byg5bCx5Yqg5LiKYDtcbiAgICAgICAgc3RhdGUucGlja2VyTm90ZS5kYXRhc2V0LnRvbmUgPSBhbGwubGVuZ3RoID09PSAwID8gJ2Vycm9yJyA6ICcnO1xuICAgIH1cblxuICAgIGNvbnN0IG9ic2VydmVyID1cbiAgICAgICAgdHlwZW9mIEludGVyc2VjdGlvbk9ic2VydmVyID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICA/IG5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcihcbiAgICAgICAgICAgICAgICAgIChlbnRyaWVzKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZW50cnkuaXNJbnRlcnNlY3RpbmcpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZW50cnkudGFyZ2V0IGFzIEhUTUxFbGVtZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgICBvYnNlcnZlci51bm9ic2VydmUobm9kZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlID0gYWxsLmZpbmQoKGl0ZW0pID0+IGl0ZW0ucGF0aCA9PT0gbm9kZS5kYXRhc2V0LnBhdGgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0YXJnZXQgPSBub2RlLnF1ZXJ5U2VsZWN0b3IoJ2ltZycpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW1hZ2UgJiYgdGFyZ2V0KSBxdWV1ZVRodW1iKHN0YXRlLCBpbWFnZSwgdGFyZ2V0KTtcbiAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgeyByb290OiBsaXN0LCByb290TWFyZ2luOiAnMTYwcHgnIH0sXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIDogbnVsbDtcbiAgICBzdGF0ZS5waWNrZXJPYnNlcnZlciA9IG9ic2VydmVyO1xuXG4gICAgZm9yIChjb25zdCBpbWFnZSBvZiBzaG93bikge1xuICAgICAgICBjb25zdCBpdGVtID0gZWwoJ2J1dHRvbicsICdkc2gtcGljay1pdGVtJyk7XG4gICAgICAgIGl0ZW0udHlwZSA9ICdidXR0b24nO1xuICAgICAgICBpdGVtLmRhdGFzZXQucGF0aCA9IGltYWdlLnBhdGg7XG4gICAgICAgIGl0ZW0udGl0bGUgPSBgJHtpbWFnZS5uYW1lfVxcbiR7aW1hZ2UucmVsIHx8IGltYWdlLnVybH0ke2ltYWdlLmJ5dGVzID8gYFxcbiR7Zm9ybWF0Qnl0ZXMoaW1hZ2UuYnl0ZXMpfWAgOiAnJ31gO1xuICAgICAgICBjb25zdCB0aHVtYiA9IGVsKCdpbWcnLCAnZHNoLXBpY2stdGh1bWInKTtcbiAgICAgICAgdGh1bWIuYWx0ID0gJyc7XG4gICAgICAgIC8vIOe8k+WtmOmHjOacieWwseebtOaOpee7me+8iOWFs+aOieWGjeW8gOS4jemHjeivu++8ie+8jOayoeacieWImeaMguS4iuinguWvn+iAheaMiemcgOivu1xuICAgICAgICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5waWNrZXJUaHVtYnMuZ2V0KGltYWdlLnBhdGgpO1xuICAgICAgICBpZiAoY2FjaGVkKSB0aHVtYi5zcmMgPSBjYWNoZWQ7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlbCgnc3BhbicsICdkc2gtcGljay10ZXh0Jyk7XG4gICAgICAgIHRleHQuYXBwZW5kKGVsKCdzcGFuJywgJ2RzaC1waWNrLW5hbWUnLCBpbWFnZS5uYW1lKSwgZWwoJ3NwYW4nLCAnZHNoLXBpY2stcGF0aCcsIGltYWdlLnJlbCB8fCBpbWFnZS51cmwpKTtcbiAgICAgICAgaXRlbS5hcHBlbmQodGh1bWIsIHRleHQpO1xuICAgICAgICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBhdHRhY2hQcm9qZWN0SW1hZ2Uoc3RhdGUsIGltYWdlKSk7XG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoaXRlbSk7XG4gICAgICAgIGlmICghY2FjaGVkICYmIG9ic2VydmVyKSBvYnNlcnZlci5vYnNlcnZlKGl0ZW0pO1xuICAgICAgICBlbHNlIGlmICghY2FjaGVkICYmIHNob3duLmluZGV4T2YoaW1hZ2UpIDwgMjQpIHF1ZXVlVGh1bWIoc3RhdGUsIGltYWdlLCB0aHVtYik7XG4gICAgfVxufVxuXG4vKipcbiAqIOe8qeeVpeWbvuaMiemcgOivu++8muS4gOasoSBJUEMgKyDkuIDmrKHop6PnoIHvvIzmiYDku6UqKuWQjOWxj+acgOWkmiBgVEhVTUJfQ09OQ1VSUkVOQ1lgIOi3ryoq77yM6K+75a6M5Y2z5Ye66Zif44CCXG4gKiDor7vkuI3lh7rmnaXnmoTot6/lvoTorrDov5sgYHBpY2tlckZhaWxlZGDvvIzlhY3lvpfmu5rliqjkuIDmrKHlsLHph43or5XkuIDmlbTkuLLjgIJcbiAqL1xuZnVuY3Rpb24gcXVldWVUaHVtYihzdGF0ZTogVWlTdGF0ZSwgaW1hZ2U6IFByb2plY3RJbWFnZSwgdGFyZ2V0OiBIVE1MSW1hZ2VFbGVtZW50KTogdm9pZCB7XG4gICAgaWYgKHN0YXRlLnBpY2tlclRodW1icy5oYXMoaW1hZ2UucGF0aCkgfHwgc3RhdGUucGlja2VyRmFpbGVkLmhhcyhpbWFnZS5wYXRoKSkgcmV0dXJuO1xuICAgIGlmIChzdGF0ZS5waWNrZXJMb2FkaW5nLmhhcyhpbWFnZS5wYXRoKSkgcmV0dXJuO1xuICAgIHN0YXRlLnBpY2tlclF1ZXVlLnB1c2goeyBpbWFnZSwgdGFyZ2V0IH0pO1xuICAgIHZvaWQgcHVtcFRodW1icyhzdGF0ZSk7XG59XG5cbi8qKiDmjqjnvKnnlaXlm77pmJ/liJfvvIjoh6rluKblubblj5HkuIrpmZDvvInjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIHB1bXBUaHVtYnMoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB3aGlsZSAoc3RhdGUucGlja2VyTG9hZGluZy5zaXplIDwgVEhVTUJfQ09OQ1VSUkVOQ1kgJiYgc3RhdGUucGlja2VyUXVldWUubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUucGlja2VyUXVldWUuc2hpZnQoKTtcbiAgICAgICAgaWYgKCFuZXh0KSBicmVhaztcbiAgICAgICAgY29uc3QgeyBpbWFnZSwgdGFyZ2V0IH0gPSBuZXh0O1xuICAgICAgICBpZiAoc3RhdGUucGlja2VyVGh1bWJzLmhhcyhpbWFnZS5wYXRoKSB8fCBzdGF0ZS5waWNrZXJMb2FkaW5nLmhhcyhpbWFnZS5wYXRoKSkgY29udGludWU7XG4gICAgICAgIHN0YXRlLnBpY2tlckxvYWRpbmcuYWRkKGltYWdlLnBhdGgpO1xuICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgcmVhZFByb2plY3RJbWFnZShpbWFnZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXBseS5vayB8fCAhcmVwbHkuZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5waWNrZXJGYWlsZWQuYWRkKGltYWdlLnBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB0YXJnZXQuZGF0YXNldC5mYWlsZWQgPSAndHJ1ZSc7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgYmxvYiA9IG5ldyBCbG9iKFtiYXNlNjRUb0J1ZmZlcihyZXBseS5kYXRhKV0sIHsgdHlwZTogcmVwbHkubWltZVR5cGUgPz8gJ2ltYWdlL3BuZycgfSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVjb2RlZCA9IGF3YWl0IGRlY29kZUJsb2IoYmxvYik7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdGh1bWIgPSBtYWtlVGh1bWIoZGVjb2RlZCk7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnBpY2tlclRodW1icy5zZXQoaW1hZ2UucGF0aCwgdGh1bWIpO1xuICAgICAgICAgICAgICAgICAgICB3aGlsZSAoc3RhdGUucGlja2VyVGh1bWJzLnNpemUgPiBUSFVNQl9DQUNIRV9MSU1JVCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkZXN0ID0gc3RhdGUucGlja2VyVGh1bWJzLmtleXMoKS5uZXh0KCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAob2xkZXN0LmRvbmUpIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdGUucGlja2VyVGh1bWJzLmRlbGV0ZShvbGRlc3QudmFsdWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmICh0YXJnZXQuaXNDb25uZWN0ZWQpIHRhcmdldC5zcmMgPSB0aHVtYjtcbiAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgICBkZWNvZGVkLnJlbGVhc2UoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBzdGF0ZS5waWNrZXJGYWlsZWQuYWRkKGltYWdlLnBhdGgpO1xuICAgICAgICAgICAgICAgIHRhcmdldC5kYXRhc2V0LmZhaWxlZCA9ICd0cnVlJztcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgc3RhdGUucGlja2VyTG9hZGluZy5kZWxldGUoaW1hZ2UucGF0aCk7XG4gICAgICAgICAgICAgICAgdm9pZCBwdW1wVGh1bWJzKHN0YXRlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkoKTtcbiAgICB9XG59XG5cbi8qKlxuICogYmFzZTY0IOKGkiBgQXJyYXlCdWZmZXJg77yI6KaB5Lqk57uZIGBCbG9iYCDlho3op6PnoIHvvIzmiYDku6Xlj6rog73oh6rlt7HovazvvJtgYXRvYmAg5piv5qCH5YeGIEFQSe+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOi/lOWbniBgQXJyYXlCdWZmZXJgIOiAjOS4jeaYryBgVWludDhBcnJheWDvvJpgbmV3IEJsb2IoW2J5dGVzXSlgIOeahCBUUyDnsbvlnovopoHmsYJcbiAqIGBBcnJheUJ1ZmZlclZpZXc8QXJyYXlCdWZmZXI+YO+8jOiAjCBgVWludDhBcnJheWAg55qEIGBidWZmZXJgIOaYryBgQXJyYXlCdWZmZXJMaWtlYFxuICog77yI5Y+v6IO96KKr5o6o5oiQIGBTaGFyZWRBcnJheUJ1ZmZlcmDvvInigJTigJQg55u05o6l5Lyg5Lya6KKr57G75Z6L5qOA5p+l5oum5LiL44CC57uZIGBBcnJheUJ1ZmZlcmAg5pyA55yB5LqL44CCXG4gKi9cbmZ1bmN0aW9uIGJhc2U2NFRvQnVmZmVyKGRhdGE6IHN0cmluZyk6IEFycmF5QnVmZmVyIHtcbiAgICBjb25zdCBiaW5hcnkgPSBhdG9iKGRhdGEpO1xuICAgIGNvbnN0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcihiaW5hcnkubGVuZ3RoKTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGJpbmFyeS5sZW5ndGg7IGluZGV4ICs9IDEpIGJ5dGVzW2luZGV4XSA9IGJpbmFyeS5jaGFyQ29kZUF0KGluZGV4KTtcbiAgICByZXR1cm4gYnVmZmVyO1xufVxuXG4vKiog6K+75LiA5byg5bel56iL5Zu+77yI6YCJ5oup5Zmo54K55byA44CB5ouW6L+b5p2l44CB5Yqg6ZmE5Lu26YO96LWw5a6D77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiByZWFkUHJvamVjdEltYWdlKGltYWdlOiBQcm9qZWN0SW1hZ2UpOiBQcm9taXNlPFJlYWRJbWFnZVJlcGx5PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGNhbGw8UmVhZEltYWdlUmVwbHk+KE1TRy5yZWFkSW1hZ2UsIHsgdXJsOiBpbWFnZS51cmwsIHBhdGg6IGltYWdlLnBhdGggfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycm9yKSB9O1xuICAgIH1cbn1cblxuLyoqIOeCueS4gOW8oOW3peeoi+WbviA9IOivu+WOn+WbviDihpIg5b2S5LiA5YyWIOKGkiDov5vnoo7niYfljLrjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIGF0dGFjaFByb2plY3RJbWFnZShzdGF0ZTogVWlTdGF0ZSwgaW1hZ2U6IFByb2plY3RJbWFnZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5hdHRhY2htZW50cy5zb21lKChpdGVtKSA9PiBpdGVtLm5hbWUgPT09IGltYWdlLm5hbWUgJiYgaXRlbS5vcmlnaW4gPT09ICdwcm9qZWN0JykpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg44CMJHtpbWFnZS5uYW1lfeOAjeW3sue7j+WcqOW+heWPkemAgeWIl+ihqOmHjOS6huOAgmAsICdpbmZvJywgW10sIEJBTk5FUl9IT0xELklORk8pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgcmVhZFByb2plY3RJbWFnZShpbWFnZSk7XG4gICAgaWYgKCFyZXBseS5vayB8fCAhcmVwbHkuZGF0YSkge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDor7vkuI3liLDjgIwke2ltYWdlLm5hbWV944CN77yaJHtyZXBseS5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gLCAnZXJyb3InLCBbXSwgQkFOTkVSX0hPTEQuRVJST1IpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbYmFzZTY0VG9CdWZmZXIocmVwbHkuZGF0YSldLCB7IHR5cGU6IHJlcGx5Lm1pbWVUeXBlID8/ICdpbWFnZS9wbmcnIH0pO1xuICAgIGF3YWl0IGF0dGFjaEJsb2JzKHN0YXRlLCBbeyBibG9iLCBuYW1lOiByZXBseS5uYW1lID8/IGltYWdlLm5hbWUgfV0sICdwcm9qZWN0Jyk7XG59XG5cbi8qKiDmiZPlvIAv5YWz5o6J5Zu+54mH6YCJ5oup5Zmo44CCICovXG5mdW5jdGlvbiB0b2dnbGVQaWNrZXIoc3RhdGU6IFVpU3RhdGUsIG9wZW4/OiBib29sZWFuKTogdm9pZCB7XG4gICAgY29uc3QgbmV4dCA9IG9wZW4gPz8gIXN0YXRlLnBpY2tlck9wZW47XG4gICAgc3RhdGUucGlja2VyT3BlbiA9IG5leHQ7XG4gICAgaWYgKHN0YXRlLnBpY2tlcikgc3RhdGUucGlja2VyLmhpZGRlbiA9ICFuZXh0O1xuICAgIGlmIChuZXh0KSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDnvJPlrZjlkb3kuK3ml7YqKuW/hemhu+mHjeeUu+S4gOasoSoq77ya5YWz5oq95bGJ5pe25oqKIGBJbnRlcnNlY3Rpb25PYnNlcnZlcmAg5pGY5o6J5LqG77yMXG4gICAgICAgICAqIOiAjOayoeivu+WIsOeahOmCo+S6m+agvOWtkOato+aYr+mdoOWug+aOkumYn+eahCDigJTigJQg5LiN6YeN5oyC55qE6K+d77yM56ys5LqM5qyh5omT5byA5pe26YKj5Lqb5qC85a2QXG4gICAgICAgICAqIOawuOi/nOaYr+epuueahO+8iOWbvueJh+acrOi6q+ayoeWPmOOAgee8k+WtmOS5n+WcqO+8jOWPquaYr+ayoeS6uuWGjeWOu+ivu++8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgaWYgKHN0YXRlLnBpY2tlckltYWdlcykgcmVuZGVyUGlja2VyTGlzdChzdGF0ZSk7XG4gICAgICAgIHZvaWQgZW5zdXJlUGlja2VyTGlzdChzdGF0ZSk7XG4gICAgICAgIC8vIOaJk+W8gOWwseaKiueEpueCuee7meaQnOe0ouahhu+8mumUruebmOa1geOAjOaJk+W8gCDihpIg5omT5Yeg5Liq5a2XIOKGkiDngrnkuIDlvKDjgI3kuIDmsJTlkbXmiJBcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiBzdGF0ZS5waWNrZXJTZWFyY2g/LmZvY3VzKCksIDApO1xuICAgIH0gZWxzZSBpZiAoc3RhdGUucGlja2VyT2JzZXJ2ZXIpIHtcbiAgICAgICAgc3RhdGUucGlja2VyT2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgICAgICBzdGF0ZS5waWNrZXJPYnNlcnZlciA9IG51bGw7XG4gICAgfVxufVxuXG4vKiog44CM6K+75Ymq6LS05p2/44CN5oyJ6ZKu77ya5ou/5LiN5Yiw5p2D6ZmQ5pe257uZ5LiA5p2h5Y+v5pON5L2c55qE5o+Q56S677yI5Yir5Y+q6K+05aSx6LSl77yJ44CCICovXG5hc3luYyBmdW5jdGlvbiBwYXN0ZUZyb21DbGlwYm9hcmRBcGkoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjbGlwYm9hcmQgPSBuYXZpZ2F0b3IuY2xpcGJvYXJkIGFzIENsaXBib2FyZCB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWNsaXBib2FyZD8ucmVhZCkge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfov5nkuKrpnaLmnb/mi7/kuI3liLDliarotLTmnb/or7vlj5bmjqXlj6Mg4oCU4oCUIOaKiuWFieagh+aUvui/m+i+k+WFpeahhuaMiSBDdHJsK1Yg5Y2z5Y+v44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaXRlbXMgPSBhd2FpdCBjbGlwYm9hcmQucmVhZCgpO1xuICAgICAgICBjb25zdCBibG9iczogQXJyYXk8eyBibG9iOiBCbG9iOyBuYW1lOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gaXRlbS50eXBlcy5maW5kKChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5zdGFydHNXaXRoKCdpbWFnZS8nKSk7XG4gICAgICAgICAgICBpZiAoIXR5cGUpIGNvbnRpbnVlO1xuICAgICAgICAgICAgYmxvYnMucHVzaCh7IGJsb2I6IGF3YWl0IGl0ZW0uZ2V0VHlwZSh0eXBlKSwgbmFtZTogYOWJqui0tOadv+WbvueJhy0ke2Jsb2JzLmxlbmd0aCArIDF9YCB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYmxvYnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfliarotLTmnb/ph4zmsqHmnInlm77niYfvvIjlj6rmnInmloflrZfvvInjgIInLCAnaW5mbycsIFtdLCBCQU5ORVJfSE9MRC5JTkZPKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBhdHRhY2hCbG9icyhzdGF0ZSwgYmxvYnMsICdjbGlwYm9hcmQnKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzZXRCYW5uZXIoXG4gICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgIGDor7vliarotLTmnb/lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX3vvIjmiorlhYnmoIfmlL7ov5vovpPlhaXmoYbmjIkgQ3RybCtWIOS5n+S4gOagt+iDveeUqO+8ieOAgmAsXG4gICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICBbXSxcbiAgICAgICAgICAgIEJBTk5FUl9IT0xELklORk8sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWKqOS9nFxuXG4vKiog5ZCv5YqoIGFnZW50IOW5tuaKiue7k+aenOWPjeaYoOWIsOaoquW5heS4iuOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RhcnRBZ2VudChzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5zdGFydFJlcXVlc3RlZCkgcmV0dXJuO1xuICAgIHN0YXRlLnN0YXJ0UmVxdWVzdGVkID0gdHJ1ZTtcbiAgICBzZXRCYW5uZXIoc3RhdGUsICfmraPlnKjlkK/liqggYWdlbnTigKbvvIjpppbmrKHlh6DljYHnp5LvvIzor7fnqI3nrYnvvIknLCAnaW5mbycpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLnN0YXJ0QWdlbnQpO1xuICAgICAgICBpZiAoIXJlc3VsdD8ub2spIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgcmVzdWx0Py5lcnJvciA/PyAn5ZCv5Yqo5aSx6LSlJywgJ2Vycm9yJywgW3sgbGFiZWw6ICfph43or5UnLCBydW46ICgpID0+IHZvaWQgc3RhcnRBZ2VudChzdGF0ZSkgfV0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBudWxsKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOWQr+WKqOWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBzdGF0ZS5zdGFydFJlcXVlc3RlZCA9IGZhbHNlO1xuICAgICAgICB2b2lkIHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgfVxufVxuXG4vKiog6YeN5paw5ZCM5q2lIHByb2ZpbGUg5bm25oqK57uT5p6c5pi+56S65Ye65p2l44CCICovXG5hc3luYyBmdW5jdGlvbiByZXBhaXJQcm9maWxlKHN0YXRlOiBVaVN0YXRlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2V0QmFubmVyKHN0YXRlLCAn5q2j5Zyo5ZCM5q2lIHByb2ZpbGXigKYnLCAnaW5mbycpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgcHJvZmlsZURpcj86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmc7IGNoYW5nZXM/OiBzdHJpbmdbXSB9PihcbiAgICAgICAgICAgIE1TRy5pbnN0YWxsUHJvZmlsZSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHJlcG9ydD8ub2spIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihcbiAgICAgICAgICAgICAgICBzdGF0ZSxcbiAgICAgICAgICAgICAgICBgcHJvZmlsZSDlt7LlsLHkvY3vvJoke3JlcG9ydC5wcm9maWxlRGlyfVxcbiR7cmVwb3J0LmNoYW5nZXM/Lmxlbmd0aCA/IHJlcG9ydC5jaGFuZ2VzLmpvaW4oJ1xcbicpIDogJ++8iOaXoOWPmOabtO+8iSd9YCxcbiAgICAgICAgICAgICAgICAnaW5mbycsXG4gICAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5L+u5aSN5aSx6LSl77yaJHtyZXBvcnQ/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWAsICdlcnJvcicpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5L+u5aSN5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWAsICdlcnJvcicpO1xuICAgIH1cbiAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWOhuWPsuS8muivnVxuXG4vKiogYGhpc3RvcnktbGlzdGAg55qE5Zue5omn44CCICovXG5pbnRlcmZhY2UgSGlzdG9yeUxpc3RSZXBseSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgc2Vzc2lvbnM/OiBIaXN0b3J5U2Vzc2lvblZpZXdbXTtcbiAgICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqXG4gKiDml7bpl7TmiLMg4oaSIGAwOS0zMCAwMDozNmDvvIjpnaLmnb/nqoTvvIzkuI3luKblubTku73vvInjgIJcbiAqXG4gKiDlrZfoioLmlbDmgI7kuYjmmL7npLrop4EgYGltYWdlcy50c2Ag55qEIGBmb3JtYXRCeXRlc2Ag4oCU4oCUICoq5Y+q5pyJ6YKj5LiA5Lu9KirvvIjljoblj7Lmir3lsYnnmoTkvZPnp6/jgIFcbiAqIOWbvueJh+eijueJh+eahOWkp+Wwj+mDvei1sOWug++8jOWIq+WcqOmdouadv+mHjOWGjeaKhOS4gOS4qu+8ieOAglxuICovXG5mdW5jdGlvbiBmb3JtYXRUaW1lKG1zOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShtcyk7XG4gICAgY29uc3QgcGFkID0gKHZhbHVlOiBudW1iZXIpOiBzdHJpbmcgPT4gU3RyaW5nKHZhbHVlKS5wYWRTdGFydCgyLCAnMCcpO1xuICAgIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRNb250aCgpICsgMSl9LSR7cGFkKGRhdGUuZ2V0RGF0ZSgpKX0gJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKlxuICog44CM5b2T5YmN5a+56K+d5Yy65piv5LiN5piv5LiA5p2h5Y6G5Y+y5Lya6K+d44CN55qE5qiq5bmF44CCXG4gKlxuICog5Lik56eN54q25oCB77yaKirlj6ror7vlm57mlL4qKu+8iOi/mOayoeaOpeS4iu+8jOe7meOAjOe7p+e7reatpOS8muivneOAjeaMiemSru+8ieS4jioq5bey5o6l5LiKKirvvIjog73mjqXnnYDogYrvvIxcbiAqIOaMiemSruaUtui1t+adpe+8ieOAgui/meaYr+mdouadv+S4iuWUr+S4gOS8muWRiuivieeUqOaIt+OAjOS9oOeOsOWcqOeci+eahOS4jeaYr+a0u+S8muivneOAjeeahOWcsOaWue+8jOWIq+ecgeOAglxuICovXG5mdW5jdGlvbiByZW5kZXJIaXN0b3J5QmFyKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgYmFyID0gc3RhdGUuaGlzdG9yeUJhcjtcbiAgICBpZiAoIWJhcikgcmV0dXJuO1xuICAgIGNvbnN0IGhpc3RvcnkgPSBzdGF0ZS5zbmFwc2hvdD8uaGlzdG9yeSA/PyBudWxsO1xuICAgIGlmICghaGlzdG9yeSkge1xuICAgICAgICBiYXIuaGlkZGVuID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBiYXIuaGlkZGVuID0gZmFsc2U7XG4gICAgYmFyLmRhdGFzZXQubGl2ZSA9IGhpc3RvcnkubGl2ZSA/ICd0cnVlJyA6ICdmYWxzZSc7XG4gICAgY29uc3Qgd2hlbiA9IGhpc3RvcnkuY3JlYXRlZEF0ID8gZm9ybWF0VGltZShoaXN0b3J5LmNyZWF0ZWRBdCkgOiAn5pe26Ze05pyq55+lJztcbiAgICBpZiAoc3RhdGUuaGlzdG9yeUJhclRleHQpIHtcbiAgICAgICAgc3RhdGUuaGlzdG9yeUJhclRleHQudGV4dENvbnRlbnQgPSBoaXN0b3J5LmxpdmVcbiAgICAgICAgICAgID8gYOW3suaOpeS4iuWOhuWPsuS8muivnSAke2hpc3Rvcnkuc2Vzc2lvbklkLnNsaWNlKDAsIDgpfeKApu+8iCR7d2hlbn3vvInCtyDmjqXkuIvmnaXnmoTmtojmga/luKbnnYDlroPnmoTkuIrkuIvmlodgXG4gICAgICAgICAgICA6IGDljoblj7LkvJror53vvIjlj6ror7vlm57mlL7vvInvvJoke2hpc3RvcnkudGl0bGV977yIJHt3aGVufSDCtyAke2hpc3RvcnkubWVzc2FnZUNvdW50fSDmnaHorrDlvZXvvIlgO1xuICAgIH1cbiAgICBpZiAoc3RhdGUucmVzdW1lQnV0dG9uKSBzdGF0ZS5yZXN1bWVCdXR0b24uaGlkZGVuID0gaGlzdG9yeS5saXZlID09PSB0cnVlO1xufVxuXG4vKiog5omT5byAL+WIt+aWsOWOhuWPsuaKveWxieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gb3Blbkhpc3Rvcnkoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBzdGF0ZS5oaXN0b3J5T3BlbiA9IHRydWU7XG4gICAgaWYgKHN0YXRlLmhpc3RvcnkpIHN0YXRlLmhpc3RvcnkuaGlkZGVuID0gZmFsc2U7XG4gICAgaWYgKHN0YXRlLmhpc3RvcnlMaXN0KSBzdGF0ZS5oaXN0b3J5TGlzdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSkge1xuICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS50ZXh0Q29udGVudCA9ICfor7vlj5bkuK3igKbvvIjnm7TmjqXor7sgJERTSF9IT01FL3Nlc3Npb25z77yM5LiN6ZyA6KaBIGFnZW50IOWcqOi3ke+8iSc7XG4gICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLmRhdGFzZXQudG9uZSA9ICcnO1xuICAgIH1cbiAgICBsZXQgcmVwbHk6IEhpc3RvcnlMaXN0UmVwbHk7XG4gICAgdHJ5IHtcbiAgICAgICAgcmVwbHkgPSBhd2FpdCBjYWxsPEhpc3RvcnlMaXN0UmVwbHk+KE1TRy5oaXN0b3J5TGlzdCwgeyBsaW1pdDogMzAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmVwbHkgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnJvcikgfTtcbiAgICB9XG4gICAgcmVuZGVySGlzdG9yeUxpc3Qoc3RhdGUsIHJlcGx5KTtcbn1cblxuLyoqIOeUu+WOhuWPsuWIl+ihqOOAgiAqL1xuZnVuY3Rpb24gcmVuZGVySGlzdG9yeUxpc3Qoc3RhdGU6IFVpU3RhdGUsIHJlcGx5OiBIaXN0b3J5TGlzdFJlcGx5KTogdm9pZCB7XG4gICAgY29uc3QgbGlzdCA9IHN0YXRlLmhpc3RvcnlMaXN0O1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIGxpc3QudGV4dENvbnRlbnQgPSAnJztcbiAgICBpZiAoc3RhdGUuaGlzdG9yeU5vdGUpIHtcbiAgICAgICAgc3RhdGUuaGlzdG9yeU5vdGUudGV4dENvbnRlbnQgPSByZXBseS5va1xuICAgICAgICAgICAgPyBgJHtyZXBseS5zZXNzaW9ucz8ubGVuZ3RoID8/IDB9IOadoeS8muivne+8iOaMieacgOWQjuS/ruaUueaXtumXtOWAkuW6j++8iWBcbiAgICAgICAgICAgIDogYOivu+WPluWksei0pe+8miR7cmVwbHkuZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YDtcbiAgICAgICAgc3RhdGUuaGlzdG9yeU5vdGUuZGF0YXNldC50b25lID0gcmVwbHkub2sgPyAnJyA6ICdlcnJvcic7XG4gICAgfVxuICAgIGlmICghcmVwbHkub2spIHJldHVybjtcblxuICAgIGZvciAoY29uc3Qgc2Vzc2lvbiBvZiByZXBseS5zZXNzaW9ucyA/PyBbXSkge1xuICAgICAgICBjb25zdCBpdGVtID0gZWwoJ2J1dHRvbicsICdkc2gtaGlzdG9yeS1pdGVtJyk7XG4gICAgICAgIGl0ZW0uZGF0YXNldC5jdXJyZW50ID0gc2Vzc2lvbi5jdXJyZW50ID8gJ3RydWUnIDogJ2ZhbHNlJztcbiAgICAgICAgaXRlbS50aXRsZSA9IHNlc3Npb24uaWQ7XG4gICAgICAgIGl0ZW0uYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtaGlzdG9yeS1pdGVtLXRpdGxlJywgc2Vzc2lvbi50aXRsZSB8fCAnKOaXoOagh+mimCknKSk7XG4gICAgICAgIGl0ZW0uYXBwZW5kQ2hpbGQoXG4gICAgICAgICAgICBlbChcbiAgICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgICAnZHNoLWhpc3RvcnktaXRlbS1tZXRhJyxcbiAgICAgICAgICAgICAgICBgJHtmb3JtYXRUaW1lKHNlc3Npb24udXBkYXRlZEF0KX0gwrcgJHtzZXNzaW9uLnR1cm5zfSDova4gwrcgJHtmb3JtYXRCeXRlcyhzZXNzaW9uLmJ5dGVzKX1gICtcbiAgICAgICAgICAgICAgICAgICAgKHNlc3Npb24uY3VycmVudCA/ICcgwrcg5q2j5Zyo5pi+56S6JyA6ICcnKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICAgIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIG9wZW5IaXN0b3J5U2Vzc2lvbihzdGF0ZSwgc2Vzc2lvbi5pZCkpO1xuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGl0ZW0pO1xuICAgIH1cbiAgICBpZiAoKHJlcGx5LnNlc3Npb25zID8/IFtdKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1oaXN0b3J5LWVtcHR5JywgJ+i/meS4quW3peeoi+i/mOayoeacieWOhuWPsuS8muivneOAgicpKTtcbiAgICB9XG59XG5cbi8qKiDlhbPpl63ljoblj7Lmir3lsYnjgIIgKi9cbmZ1bmN0aW9uIGNsb3NlSGlzdG9yeShzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIHN0YXRlLmhpc3RvcnlPcGVuID0gZmFsc2U7XG4gICAgaWYgKHN0YXRlLmhpc3RvcnkpIHN0YXRlLmhpc3RvcnkuaGlkZGVuID0gdHJ1ZTtcbn1cblxuLyoqIOeCueS4gOadoeWOhuWPsuS8muivne+8muiuqeS4u+i/m+eoi+ivu+aXpeW/l+W5tuWbnuaUvu+8iOWPquivu++8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gb3Blbkhpc3RvcnlTZXNzaW9uKHN0YXRlOiBVaVN0YXRlLCBzZXNzaW9uSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdGF0ZS5oaXN0b3J5Tm90ZSkgc3RhdGUuaGlzdG9yeU5vdGUudGV4dENvbnRlbnQgPSAn5q2j5Zyo6K+75pel5b+X5bm25Zue5pS+4oCm77yI5aSn5pel5b+X5Lya56iN5oWi77yJJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXZlbnRzPzogbnVtYmVyOyBlcnJvcj86IHN0cmluZyB9PihNU0cuaGlzdG9yeU9wZW4sIHsgc2Vzc2lvbklkIH0pO1xuICAgICAgICBpZiAoIXJlcGx5Py5vaykge1xuICAgICAgICAgICAgaWYgKHN0YXRlLmhpc3RvcnlOb3RlKSB7XG4gICAgICAgICAgICAgICAgc3RhdGUuaGlzdG9yeU5vdGUudGV4dENvbnRlbnQgPSBg5Zue5pS+5aSx6LSl77yaJHtyZXBseT8uZXJyb3IgPz8gJ+acquefpeWOn+WboCd9YDtcbiAgICAgICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS5kYXRhc2V0LnRvbmUgPSAnZXJyb3InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNsb3NlSGlzdG9yeShzdGF0ZSk7XG4gICAgICAgIGF3YWl0IHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgICAgIC8vIOWbnuaUvuaYr+OAjOS4u+i/m+eoi+i9rOWGmeS7o+aVsCArMeOAjeeahOWJr+S9nOeUqO+8jOi/memHjOS4u+WKqOaLieS4gOasoe+8jOWIq+iuqeeUqOaIt+ebr+edgOepuueZveetiei9ruivolxuICAgICAgICBhd2FpdCBwb2xsT25jZShzdGF0ZSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHN0YXRlLmhpc3RvcnlOb3RlKSB7XG4gICAgICAgICAgICBzdGF0ZS5oaXN0b3J5Tm90ZS50ZXh0Q29udGVudCA9IGDlm57mlL7lpLHotKXvvJoke1N0cmluZyhlcnJvcil9YDtcbiAgICAgICAgICAgIHN0YXRlLmhpc3RvcnlOb3RlLmRhdGFzZXQudG9uZSA9ICdlcnJvcic7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKiDjgIznu6fnu63mraTkvJror53jgI3vvJrorqnmj5Lku7bnlKggYGFnZW50cy5yZXN1bWVgIOecn+aOpeS4iu+8iOS5i+WQjuiDveaOpeedgOiBiu+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzdW1lSGlzdG9yeShzdGF0ZTogVWlTdGF0ZSwgc2Vzc2lvbklkPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2V0QmFubmVyKHN0YXRlLCAn5q2j5Zyo5o6l5LiK5Lya6K+d4oCm77yIRFNIIOS+pyBhZ2VudHMucmVzdW1l77yM6KaB5Yqg6L296L+Z5q615Y6G5Y+y77yJJywgJ2luZm8nKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PihcbiAgICAgICAgICAgIE1TRy5oaXN0b3J5UmVzdW1lLFxuICAgICAgICAgICAgc2Vzc2lvbklkID8geyBzZXNzaW9uSWQgfSA6IHVuZGVmaW5lZCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFyZXBseT8ub2spIHNldEJhbm5lcihzdGF0ZSwgYOaOpeS4iuWksei0pe+8miR7cmVwbHk/LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWAsICdlcnJvcicpO1xuICAgICAgICBlbHNlIHNldEJhbm5lcihzdGF0ZSwgbnVsbCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCBg5o6l5LiK5aSx6LSl77yaJHtTdHJpbmcoZXJyb3IpfWAsICdlcnJvcicpO1xuICAgIH1cbiAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xufVxuXG4vKiog5b2T5YmN44CM5q2j5Zyo5bmy5LuA5LmI44CN77yI54q25oCB6KGM5bem5Y2K6L6577yJ44CCICovXG5mdW5jdGlvbiBsaXZlVGV4dChzdGF0ZTogVWlTdGF0ZSk6IHsgdGV4dDogc3RyaW5nOyB0b25lOiAnYnVzeScgfCAnZXJyb3InIHwgJ2lkbGUnIH0ge1xuICAgIGNvbnN0IHNuYXBzaG90ID0gc3RhdGUuc25hcHNob3Q7XG4gICAgaWYgKCFzbmFwc2hvdCkgcmV0dXJuIHsgdGV4dDogJ+ivu+WPlueKtuaAgeKApicsIHRvbmU6ICdpZGxlJyB9O1xuICAgIGlmIChzbmFwc2hvdC5zdGF0dXMgPT09ICdlcnJvcicpIHJldHVybiB7IHRleHQ6IHNuYXBzaG90Lmxhc3RFcnJvciA/PyAn5Ye66ZSZJywgdG9uZTogJ2Vycm9yJyB9O1xuICAgIGlmIChzbmFwc2hvdC5ydW5uaW5nKSB7XG4gICAgICAgIC8vIOacgOWQjuS4gOS4qui/mOayoee7k+aenOeahOW3peWFtyA9IOW9k+WJjeWcqOi3keeahOmCo+S4qlxuICAgICAgICBsZXQgcnVubmluZ1Rvb2wgPSAnJztcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGF0ZS5lbnRyaWVzLnZhbHVlcygpKSB7XG4gICAgICAgICAgICBpZiAoZW50cnkua2luZCA9PT0gJ3Rvb2wnICYmIGVudHJ5LnRvb2wgJiYgIWVudHJ5LnRvb2wuZG9uZSkgcnVubmluZ1Rvb2wgPSBlbnRyeS50b29sLm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdGV4dDogcnVubmluZ1Rvb2wgPyBg6L+Q6KGM5Lit77yaJHtydW5uaW5nVG9vbH1gIDogJ+aAneiAg+S4reKApicsIHRvbmU6ICdidXN5JyB9O1xuICAgIH1cbiAgICByZXR1cm4geyB0ZXh0OiBTVEFUVVNfVEVYVFtzbmFwc2hvdC5zdGF0dXNdID8/IHNuYXBzaG90LnN0YXR1cywgdG9uZTogJ2lkbGUnIH07XG59XG5cbi8qKiDmi4nkuIDmrKHnirbmgIHvvIjnirbmgIHngrnjgIHlpLTpobbkuKTooYzjgIHnirbmgIHooYzjgIHmqKrluYXjgIHnqbrmgIHjgIHlpJbop4LvvInjgIIgKi9cbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hTdGF0ZShzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCByZXBseTogU3RhdGVSZXBseTtcbiAgICB0cnkge1xuICAgICAgICByZXBseSA9IGF3YWl0IGNhbGw8U3RhdGVSZXBseT4oTVNHLmdldFN0YXRlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuOyAvLyDkuLvov5vnqIvlv5kv6Z2i5p2/5Yia5oyC6L2977ya5LiL5LiA6L2u5YaN6K+0XG4gICAgfVxuICAgIGlmICghcmVwbHk/Lm9rIHx8ICFyZXBseS5hZ2VudCkgcmV0dXJuO1xuICAgIHN0YXRlLnNuYXBzaG90ID0gcmVwbHkuYWdlbnQ7XG4gICAgaWYgKHJlcGx5LnNldHRpbmdzKSBzdGF0ZS5zZXR0aW5ncyA9IHJlcGx5LnNldHRpbmdzO1xuICAgIGFwcGx5QXBwZWFyYW5jZShzdGF0ZSk7XG5cbiAgICBpZiAoc3RhdGUuZG90KSB7XG4gICAgICAgIHN0YXRlLmRvdC5kYXRhc2V0LnN0YXRlID0gcmVwbHkuYWdlbnQuc3RhdHVzO1xuICAgICAgICBzdGF0ZS5kb3QudGl0bGUgPSBTVEFUVVNfVEVYVFtyZXBseS5hZ2VudC5zdGF0dXNdID8/IHJlcGx5LmFnZW50LnN0YXR1cztcbiAgICB9XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBzdGF0ZS5zZXR0aW5ncztcbiAgICBpZiAoc3RhdGUudGl0bGUpIHN0YXRlLnRpdGxlLnRleHRDb250ZW50ID0gYERTSCDCtyAke1BST0ZJTEVfTkFNRX1gO1xuICAgIGlmIChzdGF0ZS5zdWIpIHtcbiAgICAgICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmIChzZXR0aW5ncykgcGFydHMucHVzaChgJHtzZXR0aW5ncy5wcm92aWRlcn0vJHtzZXR0aW5ncy5tb2RlbH1gKTtcbiAgICAgICAgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiByZXBseS5hZ2VudC5sYXN0Qm9vdE1zKSB7XG4gICAgICAgICAgICBwYXJ0cy5wdXNoKGDlkK/liqggJHsocmVwbHkuYWdlbnQubGFzdEJvb3RNcyAvIDEwMDApLnRvRml4ZWQoMSl9c2ApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXBseS5hZ2VudC5waWQpIHBhcnRzLnB1c2goYHBpZCAke3JlcGx5LmFnZW50LnBpZH1gKTtcbiAgICAgICAgY29uc3QgdGV4dCA9IHBhcnRzLmpvaW4oJyDCtyAnKSB8fCBTVEFUVVNfVEVYVFtyZXBseS5hZ2VudC5zdGF0dXNdIHx8ICcnO1xuICAgICAgICBzdGF0ZS5zdWIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgICBzdGF0ZS5zdWIudGl0bGUgPSB0ZXh0O1xuICAgIH1cbiAgICBpZiAoc3RhdGUubGl2ZSkge1xuICAgICAgICBjb25zdCBsaXZlID0gbGl2ZVRleHQoc3RhdGUpO1xuICAgICAgICBzdGF0ZS5saXZlLnRleHRDb250ZW50ID0gbGl2ZS50ZXh0O1xuICAgICAgICBzdGF0ZS5saXZlLmRhdGFzZXQudG9uZSA9IGxpdmUudG9uZSA9PT0gJ2J1c3knID8gJ2J1c3knIDogbGl2ZS50b25lID09PSAnZXJyb3InID8gJ2Vycm9yJyA6ICcnO1xuICAgICAgICBzdGF0ZS5saXZlLnRpdGxlID0gbGl2ZS50ZXh0O1xuICAgIH1cbiAgICBpZiAoc3RhdGUubWV0YSkge1xuICAgICAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKHNldHRpbmdzKSBwYXJ0cy5wdXNoKGBlZmZvcnQgJHtzZXR0aW5ncy5yZWFzb25pbmdFZmZvcnQgfHwgJ+m7mOiupCd9YCk7XG4gICAgICAgIGlmIChyZXBseS5hZ2VudC5zZXNzaW9uSWQpIHBhcnRzLnB1c2goYOS8muivnSAke3JlcGx5LmFnZW50LnNlc3Npb25JZC5zbGljZSgwLCA4KX1gKTtcbiAgICAgICAgaWYgKHN0YXRlLmVudHJpZXMuc2l6ZSA+IDApIHBhcnRzLnB1c2goYCR7c3RhdGUuZW50cmllcy5zaXplfSDmnaFgKTtcbiAgICAgICAgY29uc3QgdGV4dCA9IHBhcnRzLmpvaW4oJyDCtyAnKTtcbiAgICAgICAgc3RhdGUubWV0YS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICAgIHN0YXRlLm1ldGEudGl0bGUgPSB0ZXh0O1xuICAgIH1cblxuICAgIC8vIOaMiemSruWPr+eUqOaAp++8muWPkemAgeimgeWwsee7qu+8jOaWsOS8muivneimgeWwsee7qu+8jOOAjOWQr+WKqC/lgZzmraLjgI3mjInnirbmgIHlj5jlvaLvvIzph43lkK/lj6rlnKjot5HnnYDml7bmiY3mnInmhI/kuYlcbiAgICBjb25zdCByZWFkeSA9IHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3JlYWR5JztcbiAgICBjb25zdCBzZXR0bGVkID0gcmVwbHkuYWdlbnQuc3RhdHVzID09PSAnc3RvcHBlZCcgfHwgcmVwbHkuYWdlbnQuc3RhdHVzID09PSAnZXJyb3InO1xuICAgIGlmIChzdGF0ZS5zZW5kQnV0dG9uKSBzdGF0ZS5zZW5kQnV0dG9uLmRpc2FibGVkID0gIXJlYWR5O1xuICAgIGNvbnN0IGJ0bk5ldyA9IHN0YXRlLnJvb3Q/LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYnRuLW5ldycpO1xuICAgIGlmIChidG5OZXcpIGJ0bk5ldy5kaXNhYmxlZCA9ICFyZWFkeTtcblxuICAgIC8qKlxuICAgICAqIOS4gOS4quaMiemSruW5suS4pOS7tuS6i++8muayoei3keaXtuaYr+OAjOWQr+WKqOOAje+8jOi3keedgOaXtuaYr+OAjOWBnOatouOAjeOAglxuICAgICAqXG4gICAgICog5LmL5YmN5Y+q5pyJ44CM5YGc5q2i44CN5LiA5Liq54q25oCBIOKAlOKAlCDnlKjmiLfmioogYWdlbnQg5YGc5o6J5LmL5ZCOKirmsqHmnInku7vkvZXlip7ms5Xlho3otbfmnaUqKlxuICAgICAqIO+8iOWUr+S4gOeahOWFpeWPo+aYr+mHjeW8gOmdouadvyAvIOmHjeWQr+e8lui+keWZqO+8jGBhdXRvU3RhcnRgIOi/mOWPquWcqOOAjOS7juayoei1t+i/h+OAjeaXtuaJjeinpuWPke+8ie+8jFxuICAgICAqIOi/meWwseaYr+OAjOWBnOatouWQjuayoeaciemHjeWQr+aMiemSruOAjei/meS4quWdkeeahOadpea6kOOAglxuICAgICAqL1xuICAgIGNvbnN0IGJ0blN0b3AgPSBzdGF0ZS5yb290Py5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignI2J0bi1zdG9wJyk7XG4gICAgaWYgKGJ0blN0b3ApIHtcbiAgICAgICAgYnRuU3RvcC50ZXh0Q29udGVudCA9IHNldHRsZWQgPyAn5ZCv5YqoJyA6ICflgZzmraInO1xuICAgICAgICBidG5TdG9wLnRpdGxlID0gc2V0dGxlZFxuICAgICAgICAgICAgPyAn5ZCv5YqoIGFnZW5077yI5Lya6Ieq5Yqo5o6l5LiK5LiK5qyh55qE5Lya6K+d77yJJ1xuICAgICAgICAgICAgOiAn5YGc5o6J5pW05LiqIGFnZW50IOi/m+eoi++8iOWPquaDs+aJk+aWrei/meS4gOi9ruivt+eUqOi+k+WFpeahhuaXgeeahOOAjOWBnOatouacrOi9ruOAje+8iSc7XG4gICAgICAgIGJ0blN0b3AuZGlzYWJsZWQgPSByZXBseS5hZ2VudC5zdGF0dXMgPT09ICdzdGFydGluZycgfHwgcmVwbHkuYWdlbnQuc3RhdHVzID09PSAnc3RvcHBpbmcnIHx8IHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ2luc3RhbGxpbmcnO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOOAjOWBnOatouacrOi9ruOAje+8mioq5Y+q5Zyo55yf55qE5Zyo6LeR55qE5pe25YCZ5Ye6546wKirjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOS4jeaYr+W4uOmpu+e9rueBsO+8mumdouadv+WuveW6puacgOWwjyAzODBweO+8jOi+k+WFpeWMuuW3sue7j+W+iOaMpO+8m+iAjOS4lOi/meS4quaMiemSrlxuICAgICAqIOOAjOeOsOWcqOayoeeUqOOAjeeahOivreS5ieW+iOW8uu+8iOayoeWcqOi3keWwseaYr+ayoeW+l+WBnO+8ieOAgua3oeWFpea3oeWHuuS6pOe7mSBgaGlkZGVuYO+8jOS4jeWNoOS9jeOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI5LiN5piv44CM5Y+R6YCB44CN5oyJ6ZKu5Y+Y6IS477ya5Y+R6YCB5LiO5Lit5pat5piv5Lik5Lu25LqL77yMYGZvbGxvd3VwYCDlhYHorrjlnKjot5HnmoTml7blgJlcbiAgICAgKiDlho3mjpLkuIDlj6XvvIjkvJrlnKjov5nkuIDova7kuYvlkI7miafooYzvvInjgILmiorlj5HpgIHmjInpkq7mlLnmiJDkuK3mlq3kvJoqKumhuuaJi+aLv+i1sOaOkumYn+eahOiDveWKmyoq44CCXG4gICAgICovXG4gICAgY29uc3QgYnRuSW50ZXJydXB0ID0gc3RhdGUucm9vdD8ucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJyNidG4taW50ZXJydXB0Jyk7XG4gICAgaWYgKGJ0bkludGVycnVwdCkge1xuICAgICAgICBidG5JbnRlcnJ1cHQudGl0bGUgPVxuICAgICAgICAgICAgJ+S4reaWreW9k+WJjei/meS4gOi9ru+8iERTSCDnmoQgQWdlbnQuY2FuY2Vs77ya5YGc5o6J6L+Z5LiA6L2u77yM5Lya6K+d5LiO5LiK5LiL5paH6YO95L+d55WZ77yM5Y+v5Lul5o6l552A6K+077yJXFxuJyArXG4gICAgICAgICAgICAn5oOz6L+eIGFnZW50IOi/m+eoi+S4gOi1t+WBnO+8jOeUqOWPs+S4iuinkueahOOAjOWBnOatouOAjeOAgic7XG4gICAgfVxuICAgIHN5bmNJbnRlcnJ1cHRCdXR0b24oc3RhdGUpO1xuICAgIGNvbnN0IGJ0blJlc3RhcnQgPSBzdGF0ZS5yb290Py5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignI2J0bi1yZXN0YXJ0Jyk7XG4gICAgaWYgKGJ0blJlc3RhcnQpIHtcbiAgICAgICAgYnRuUmVzdGFydC5kaXNhYmxlZCA9ICFyZWFkeTtcbiAgICAgICAgYnRuUmVzdGFydC50aXRsZSA9IHJlYWR5ID8gJ+mHjeWQryBhZ2VudO+8iOmHjeWQr+WQjuS8muiHquWKqOaOpeS4iuS4iuasoeeahOS8muivne+8iScgOiAn5YWI5ZCv5YqoIGFnZW50IOaJjeiDvemHjeWQryc7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5yZXN1bWVCdXR0b24pIHN0YXRlLnJlc3VtZUJ1dHRvbi5kaXNhYmxlZCA9ICFyZWFkeTtcblxuICAgIHJlbmRlckhpc3RvcnlCYXIoc3RhdGUpO1xuXG4gICAgaWYgKHJlcGx5LnByb2ZpbGUgJiYgcmVwbHkucHJvZmlsZS5vayA9PT0gZmFsc2UpIHtcbiAgICAgICAgLy8gcHJvZmlsZSDlkIzmraXlpLHotKXkvJrnm7TmjqXlr7zoh7QgYWdlbnQg6LW35LiN5p2l77yI5oiW6LW35p2l55qE5piv5pen5o+S5Lu277yJ77yM5b+F6aG75pi+55y844CCXG4gICAgICAgIHNldEJhbm5lcihcbiAgICAgICAgICAgIHN0YXRlLFxuICAgICAgICAgICAgYGRzaCBwcm9maWxlIOWQjOatpeWksei0pe+8miR7cmVwbHkucHJvZmlsZS5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31cXG7vvIhhZ2VudCDkvJrnlKjliLAgJERTSF9IT01FL3Byb2ZpbGVzL2NvY29z77yb5Y+v54K55LiL6Z2i5oyJ6ZKu6YeN6K+V77yJYCxcbiAgICAgICAgICAgICdlcnJvcicsXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogJ+S/ruWkjSBwcm9maWxlJywgcnVuOiAoKSA9PiB2b2lkIHJlcGFpclByb2ZpbGUoc3RhdGUpIH0sXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogJ+mHjeivleWQr+WKqCcsIHJ1bjogKCkgPT4gdm9pZCBzdGFydEFnZW50KHN0YXRlKSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ2Vycm9yJyAmJiByZXBseS5hZ2VudC5sYXN0RXJyb3IpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCByZXBseS5hZ2VudC5sYXN0RXJyb3IsICdlcnJvcicsIFt7IGxhYmVsOiAn6YeN6K+VJywgcnVuOiAoKSA9PiB2b2lkIHN0YXJ0QWdlbnQoc3RhdGUpIH1dKTtcbiAgICB9IGVsc2UgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyAhPT0gJ3N0YXJ0aW5nJyAmJiBEYXRlLm5vdygpID49IHN0YXRlLmJhbm5lclVudGlsKSB7XG4gICAgICAgIHNldEJhbm5lcihzdGF0ZSwgbnVsbCk7XG4gICAgfVxuXG4gICAgLy8g56m65oCB6Lef552A54q25oCB6LWwXG4gICAgaWYgKHN0YXRlLmVudHJpZXMuc2l6ZSA9PT0gMCkge1xuICAgICAgICBpZiAoc3RhdGUuZW1wdHlFbCkgc3RhdGUuZW1wdHlFbC5yZW1vdmUoKTtcbiAgICAgICAgc3RhdGUuZW1wdHlFbCA9IG51bGw7XG4gICAgICAgIHJlbmRlckVtcHR5KHN0YXRlLCByZXBseS5hZ2VudC5zdGF0dXMgPT09ICdyZWFkeScgPyAnbm8tbWVzc2FnZXMnIDogJ25vLWFnZW50Jyk7XG4gICAgfVxuXG4gICAgc3luY1R5cGluZyhzdGF0ZSk7XG4gICAgc3luY0xpdmVCbG9ja3Moc3RhdGUpO1xuXG4gICAgLy8g6K6+572u6YeM55qE6Ieq5Yqo5ZCv5Yqo77ya5Y+q5Zyo44CM56Gu5a6e5rKh6LW36L+H44CN5pe26Kem5Y+RXG4gICAgaWYgKHJlcGx5LmFnZW50LnN0YXR1cyA9PT0gJ3N0b3BwZWQnICYmIHJlcGx5LnNldHRpbmdzPy5hdXRvU3RhcnQgJiYgIXN0YXRlLnN0YXJ0UmVxdWVzdGVkICYmIHN0YXRlLmVudHJpZXMuc2l6ZSA9PT0gMCkge1xuICAgICAgICB2b2lkIHN0YXJ0QWdlbnQoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqIOaLieS4gOasoeWinumHj+i9rOWGmeOAgkByZXR1cm5zIOaYr+WQpuaLv+WIsOaWsOadoeebru+8iOWGs+WumuimgeS4jeimgemhuuW4puWIt+eKtuaAge+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gcG9sbE9uY2Uoc3RhdGU6IFVpU3RhdGUpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZW50cmllcz86IEVudHJ5W107IHJldmlzaW9uPzogbnVtYmVyOyBnZW5lcmF0aW9uPzogbnVtYmVyIH0+KE1TRy5nZXRFdmVudHMsIHtcbiAgICAgICAgICAgIHNpbmNlOiBzdGF0ZS5tYXhSZXYsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDku6PmlbDlj5jkuoYgPSDkuLvov5vnqIvmjaLkuobkvJror50v5Zue5pS+5LqG5Y6G5Y+y77ya5YWI5pW05Z2X6YeN55S777yM5YaN5pS26L+Z5LiA5om5XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgdHlwZW9mIHJlcGx5LmdlbmVyYXRpb24gPT09ICdudW1iZXInICYmIHJlcGx5LmdlbmVyYXRpb24gIT09IHN0YXRlLmdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIHJlc2V0VWkoc3RhdGUsIHJlcGx5LmdlbmVyYXRpb24pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgdHlwZW9mIHJlcGx5LnJldmlzaW9uID09PSAnbnVtYmVyJykgc3RhdGUubWF4UmV2ID0gTWF0aC5tYXgoc3RhdGUubWF4UmV2LCByZXBseS5yZXZpc2lvbik7XG4gICAgICAgIGlmIChyZXBseT8ub2sgJiYgQXJyYXkuaXNBcnJheShyZXBseS5lbnRyaWVzKSAmJiByZXBseS5lbnRyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGFwcGx5RW50cmllcyhzdGF0ZSwgcmVwbHkuZW50cmllcyk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDkuIvkuIDova7lho3or7QgKi9cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiog5ZCI5bm25LiA5om55p2h55uu77ya6LS05bqV5pe26Lef552A5rua77yM5LiN54S25L+d5oyB55So5oi355qE5L2N572u44CCICovXG5mdW5jdGlvbiBhcHBseUVudHJpZXMoc3RhdGU6IFVpU3RhdGUsIGVudHJpZXM6IEVudHJ5W10pOiB2b2lkIHtcbiAgICBjb25zdCBib2R5ID0gc3RhdGUuYm9keTtcbiAgICBjb25zdCBwaW5uZWQgPSBib2R5LnNjcm9sbFRvcCArIGJvZHkuY2xpZW50SGVpZ2h0ID49IGJvZHkuc2Nyb2xsSGVpZ2h0IC0gNDg7XG4gICAgaWYgKHN0YXRlLmVtcHR5RWwgJiYgZW50cmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHN0YXRlLmVtcHR5RWwucmVtb3ZlKCk7XG4gICAgICAgIHN0YXRlLmVtcHR5RWwgPSBudWxsO1xuICAgIH1cbiAgICBjb25zdCBjaGFuZ2VkID0gbWVyZ2VFbnRyaWVzKHN0YXRlLCBlbnRyaWVzKTtcbiAgICBpZiAoY2hhbmdlZCAmJiBwaW5uZWQpIHtcbiAgICAgICAgLy8g562J5LiA5bin5YaN5rua77ya5Yia5o+S5YWl55qE5YaF5a656L+Y5rKh6YeP6auY5bqmXG4gICAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICBib2R5LnNjcm9sbFRvcCA9IGJvZHkuc2Nyb2xsSGVpZ2h0O1xuICAgICAgICB9KTtcbiAgICB9XG59XG5cbi8qKiDlupTnlKjlub/mkq3mjqjmnaXnmoTmm7TmlrDvvIjkuI7ova7or6LotbDlkIzkuIDlpZflkIjlubbpgLvovpHvvInjgIIgKi9cbmZ1bmN0aW9uIGFwcGx5QnJvYWRjYXN0KHN0YXRlOiBVaVN0YXRlLCB1cGRhdGU6IHVua25vd24pOiB2b2lkIHtcbiAgICBjb25zdCBwYXlsb2FkID0gdXBkYXRlIGFzIEhvc3RVcGRhdGVWaWV3IHwgdW5kZWZpbmVkO1xuICAgIGlmICghcGF5bG9hZCkgcmV0dXJuO1xuICAgIGlmIChwYXlsb2FkLnJ1bm5pbmcgIT09IHVuZGVmaW5lZCAmJiBzdGF0ZS5zbmFwc2hvdCkgc3RhdGUuc25hcHNob3QucnVubmluZyA9IHBheWxvYWQucnVubmluZztcbiAgICBpZiAocGF5bG9hZC5zdGF0dXMgJiYgc3RhdGUuc25hcHNob3QpIHN0YXRlLnNuYXBzaG90LnN0YXR1cyA9IHBheWxvYWQuc3RhdHVzO1xuICAgIC8vIOW5v+aSreS5n+WPr+iDveW4puadpeOAjOaNouS8muivneOAje+8iOa4heepuiArIOS7o+aVsOS4uuivge+8ie+8jOWkhOeQhuWPo+W+hOS4jui9ruivouS4gOiHtFxuICAgIGlmICh0eXBlb2YgcGF5bG9hZC5nZW5lcmF0aW9uID09PSAnbnVtYmVyJyAmJiBwYXlsb2FkLmdlbmVyYXRpb24gIT09IHN0YXRlLmdlbmVyYXRpb24pIHtcbiAgICAgICAgcmVzZXRVaShzdGF0ZSwgcGF5bG9hZC5nZW5lcmF0aW9uKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGF5bG9hZC5lbnRyaWVzKSAmJiBwYXlsb2FkLmVudHJpZXMubGVuZ3RoID4gMCkgYXBwbHlFbnRyaWVzKHN0YXRlLCBwYXlsb2FkLmVudHJpZXMgYXMgRW50cnlbXSk7XG4gICAgLy8g5bm/5pKt5Y+q5bim5aKe6YeP77yMcmV2aXNpb24g55So5a6D5o6o5ri45qCH77yb5ryP5o6J55qE6YOo5YiG6Z2g6L2u6K+i6KGl6b2QXG4gICAgaWYgKHR5cGVvZiBwYXlsb2FkLnJldmlzaW9uID09PSAnbnVtYmVyJyAmJiBwYXlsb2FkLnJldmlzaW9uID4gc3RhdGUubWF4UmV2KSBzdGF0ZS5tYXhSZXYgPSBwYXlsb2FkLnJldmlzaW9uO1xuICAgIC8vIOi/kOihjOeKtuaAgeaYr+W5v+aSremHjOacgOaWsOeahO+8jOeri+WIu+WPjeaYoOWIsOeKtuaAgeihjOS4juOAjOato+WcqOWbnuWkjeOAjeS4ilxuICAgIGlmIChzdGF0ZS5saXZlKSB7XG4gICAgICAgIGNvbnN0IGxpdmUgPSBsaXZlVGV4dChzdGF0ZSk7XG4gICAgICAgIHN0YXRlLmxpdmUudGV4dENvbnRlbnQgPSBsaXZlLnRleHQ7XG4gICAgICAgIHN0YXRlLmxpdmUuZGF0YXNldC50b25lID0gbGl2ZS50b25lID09PSAnYnVzeScgPyAnYnVzeScgOiBsaXZlLnRvbmUgPT09ICdlcnJvcicgPyAnZXJyb3InIDogJyc7XG4gICAgfVxuICAgIHN5bmNUeXBpbmcoc3RhdGUpO1xuICAgIHN5bmNMaXZlQmxvY2tzKHN0YXRlKTtcbiAgICBzeW5jSW50ZXJydXB0QnV0dG9uKHN0YXRlKTtcbn1cblxuLyoqXG4gKiDjgIzlgZzmraLmnKzova7jgI3mjInpkq7nmoTmmL7pmpAg4oCU4oCUICoq5bm/5pKt5LiO6L2u6K+i5Lik5p2h6Lev6YO96KaB6LCDKirjgIJcbiAqXG4gKiDlj6rmlL7lnKggYHJlZnJlc2hTdGF0ZWAg6YeM5Lya5oWi5Y2K5ouN77ya6Z2i5p2/5Zyo6LeR55qE5pe25YCZ6Z2g5bm/5pKt5o6o5aKe6YeP77yM6ICMIGByZWZyZXNoU3RhdGVgXG4gKiDlj6rlnKjjgIzmnInmlrDmnaHnm67jgI3miJbmr48gTiDot7PmiY3ot5HkuIDmrKHvvIzkuo7mmK/jgIzmqKHlnovliJrlvIDlp4vmg7Mg4oaSIOaMiemSruivpeWHuueOsOOAjeS8muaZmuWHoOeZvuavq+enkuOAglxuICog6ICMIGBwYXlsb2FkLnJ1bm5pbmdgIOaBsOWlveWwseWcqOavj+S4gOasoeW5v+aSremHjO+8jOmhuuaJi+WQjOatpeaYr+acgOS+v+WunOeahOOAglxuICpcbiAqIEBwYXJhbSBzdGF0ZSAtIOmdouadv+eKtuaAgeOAglxuICovXG5mdW5jdGlvbiBzeW5jSW50ZXJydXB0QnV0dG9uKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgcnVubmluZyA9IHN0YXRlLnNuYXBzaG90Py5ydW5uaW5nID09PSB0cnVlO1xuICAgIC8vIOi/meS4gOi9ruecn+eahOaUtuWwvuS5i+WQju+8jOOAjOato+WcqOS4reaWreOAjei/meS4quS4tOaXtuaAgeiHquW3seWkjeS9je+8iOS4jeW/heetieiwgeWOu+a4he+8iVxuICAgIGlmICghcnVubmluZykgc3RhdGUuaW50ZXJydXB0aW5nID0gZmFsc2U7XG4gICAgY29uc3QgYnV0dG9uID0gc3RhdGUucm9vdD8ucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJyNidG4taW50ZXJydXB0Jyk7XG4gICAgaWYgKCFidXR0b24pIHJldHVybjtcbiAgICBjb25zdCBzaG91bGRIaWRlID0gIXJ1bm5pbmc7XG4gICAgaWYgKGJ1dHRvbi5oaWRkZW4gIT09IHNob3VsZEhpZGUpIGJ1dHRvbi5oaWRkZW4gPSBzaG91bGRIaWRlO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9ICFydW5uaW5nIHx8IHN0YXRlLmludGVycnVwdGluZyA9PT0gdHJ1ZTtcbn1cblxuLyoqIOWPkemAgeOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VuZChzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHRleHQgPSBzdGF0ZS5pbnB1dC52YWx1ZS50cmltKCk7XG4gICAgY29uc3QgYXR0YWNobWVudHMgPSBzdGF0ZS5hdHRhY2htZW50cztcbiAgICAvLyDlj6rmnInlm77msqHmnInlrZfkuZ/lhYHorrjvvIjmqKHlnovlj6rnnIvlm77vvInvvJvkuKTmoLfpg73nqbrmiY3mmK/msqHlvpflj5FcbiAgICBpZiAoIXRleHQgJiYgYXR0YWNobWVudHMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnNuYXBzaG90Py5zdGF0dXMgIT09ICdyZWFkeScpIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAnYWdlbnQg6L+Y5rKh5bCx57uq77yM5YWI562J5a6D5ZCv5Yqo5a6M5oiQ44CCJywgJ2luZm8nLCBbXSwgQkFOTkVSX0hPTEQuSU5GTyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmltYWdlQnVzeSA+IDApIHtcbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAn5Zu+54mH6L+Y5Zyo5aSE55CG77yI6Kej56CBL+e8qeaUvu+8ieS4re+8jOeojeetieS4gOS4i+WGjeWPkeOAgicsICdpbmZvJywgW10sIEJBTk5FUl9IT0xELklORk8pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHN0YXRlLmlucHV0LnZhbHVlID0gJyc7XG4gICAgYXV0b0dyb3coc3RhdGUuaW5wdXQpO1xuICAgIHNhdmVEcmFmdCgnJyk7XG4gICAgaWYgKHN0YXRlLnNlbmRCdXR0b24pIHN0YXRlLnNlbmRCdXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4oTVNHLnNlbmRNZXNzYWdlLCB7XG4gICAgICAgICAgICB0ZXh0LFxuICAgICAgICAgICAgLy8g5Y+q5oqK5Y2P6K6u6ZyA6KaB55qE5LiJ5Liq5a2X5q616YCB5Ye65Y6777yIdGh1bWIvd2lkdGgvaGVpZ2h0IOaYr+mdouadv+iHquW3seeahOS6i++8iVxuICAgICAgICAgICAgaW1hZ2VzOiBhdHRhY2htZW50cy5tYXAoKGl0ZW0pID0+ICh7IG1pbWVUeXBlOiBpdGVtLm1pbWVUeXBlLCBkYXRhOiBpdGVtLmRhdGEsIG5hbWU6IGl0ZW0ubmFtZSB9KSksXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdD8ub2spIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgcmVzdWx0Py5lcnJvciA/PyAn5Y+R6YCB5aSx6LSlJywgJ2Vycm9yJywgW10sIEJBTk5FUl9IT0xELkVSUk9SKTtcbiAgICAgICAgICAgIC8vIOWksei0peaXtioq5oqK5Zu+5ZKM5paH5a2X6YO955WZ552AKirvvJrnlKjmiLfnmoTovpPlhaXkuI3og73lm6DkuLrkuIDmrKHnvZHnu5wv5qCh6aqM6ZSZ6K+v5bCx5rKh5LqGXG4gICAgICAgICAgICByZXN0b3JlRHJhZnQoc3RhdGUsIHRleHQsIGF0dGFjaG1lbnRzKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgbnVsbCk7XG4gICAgICAgICAgICByZW1lbWJlclNlbnRUaHVtYnMoc3RhdGUsIGF0dGFjaG1lbnRzKTtcbiAgICAgICAgICAgIHN0YXRlLmF0dGFjaG1lbnRzID0gW107XG4gICAgICAgICAgICByZW5kZXJBdHRhY2htZW50cyhzdGF0ZSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsIGDlj5HpgIHlpLHotKXvvJoke1N0cmluZyhlcnJvcil9YCwgJ2Vycm9yJywgW10sIEJBTk5FUl9IT0xELkVSUk9SKTtcbiAgICAgICAgcmVzdG9yZURyYWZ0KHN0YXRlLCB0ZXh0LCBhdHRhY2htZW50cyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHN0YXRlLnNlbmRCdXR0b24pIHN0YXRlLnNlbmRCdXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBwb2xsT25jZShzdGF0ZSk7XG4gICAgICAgIC8vIOeri+WIu+WIt+S4gOasoeeKtuaAge+8mmBydW5uaW5nYCDnv7vnnJ/lkI7ova7or6LmiY3kvJrliIfliLAgMzAwbXPvvIjmtYHlvI/lsLHmmK/pnaDlroPpobrotbfmnaXnmoTvvIlcbiAgICAgICAgdm9pZCByZWZyZXNoU3RhdGUoc3RhdGUpO1xuICAgIH1cbn1cblxuLyoqIOWPkemAgeWksei0peWQjuaKiuayoeWPkeWHuuWOu+eahOS4nOilv+aUvuWbnui+k+WFpeWMuu+8iOWPquWcqOeUqOaIt+i/mOayoeW8gOWni+aJk+aWsOWGheWuueaXtu+8ieOAgiAqL1xuZnVuY3Rpb24gcmVzdG9yZURyYWZ0KHN0YXRlOiBVaVN0YXRlLCB0ZXh0OiBzdHJpbmcsIGF0dGFjaG1lbnRzOiBBdHRhY2htZW50W10pOiB2b2lkIHtcbiAgICBpZiAodGV4dCAmJiAhc3RhdGUuaW5wdXQudmFsdWUudHJpbSgpKSB7XG4gICAgICAgIHN0YXRlLmlucHV0LnZhbHVlID0gdGV4dDtcbiAgICAgICAgYXV0b0dyb3coc3RhdGUuaW5wdXQpO1xuICAgICAgICBzYXZlRHJhZnQodGV4dCk7XG4gICAgfVxuICAgIGlmIChhdHRhY2htZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHN0YXRlLmF0dGFjaG1lbnRzID0gYXR0YWNobWVudHM7XG4gICAgICAgIHJlbmRlckF0dGFjaG1lbnRzKHN0YXRlKTtcbiAgICB9XG59XG5cbi8qKiDorrDkuIvlj5Hlh7rljrvpgqPlh6DlvKDlm77nmoTnvKnnlaXlm77vvIjnlKjmiLfmsJTms6Hph4zmmL7npLrnnJ/lm77nlKjvvIzop4EgYHJlbmRlckVudHJ5SW1hZ2VzYO+8ieOAgiAqL1xuZnVuY3Rpb24gcmVtZW1iZXJTZW50VGh1bWJzKHN0YXRlOiBVaVN0YXRlLCBhdHRhY2htZW50czogQXR0YWNobWVudFtdKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGF0dGFjaG1lbnRzKSB7XG4gICAgICAgIHN0YXRlLnNlbnRUaHVtYnMuc2V0KGl0ZW0ubmFtZSwgaXRlbS50aHVtYik7XG4gICAgICAgIHdoaWxlIChzdGF0ZS5zZW50VGh1bWJzLnNpemUgPiAxMikge1xuICAgICAgICAgICAgY29uc3Qgb2xkZXN0ID0gc3RhdGUuc2VudFRodW1icy5rZXlzKCkubmV4dCgpO1xuICAgICAgICAgICAgaWYgKG9sZGVzdC5kb25lKSBicmVhaztcbiAgICAgICAgICAgIHN0YXRlLnNlbnRUaHVtYnMuZGVsZXRlKG9sZGVzdC52YWx1ZSk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKiDovpPlhaXmoYbmjInlhoXlrrnplb/pq5jvvIjmnIDlpJogOCDooYzvvIzlho3lpJrlsLHmu5rvvInjgIIgKi9cbmZ1bmN0aW9uIGF1dG9Hcm93KGlucHV0OiBIVE1MVGV4dEFyZWFFbGVtZW50KTogdm9pZCB7XG4gICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gJ2F1dG8nO1xuICAgIGlucHV0LnN0eWxlLmhlaWdodCA9IGAke01hdGgubWluKGlucHV0LnNjcm9sbEhlaWdodCwgMTY4KX1weGA7XG59XG5cbi8qKiDojYnnqL/or7vlhpnvvIjpnaLmnb/lhbPmjonlho3lvIDkuI3kuKLvvInjgIIgKi9cbmZ1bmN0aW9uIHNhdmVEcmFmdCh0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgICBpZiAodGV4dCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oRFJBRlRfS0VZLCB0ZXh0KTtcbiAgICAgICAgZWxzZSBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShEUkFGVF9LRVkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDpmpDnp4HmqKHlvI8v6KKr56aB5bCx5rKh6I2J56i/77yM5LiN5b2x5ZON55SoICovXG4gICAgfVxufVxuXG5mdW5jdGlvbiBsb2FkRHJhZnQoKTogc3RyaW5nIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gbG9jYWxTdG9yYWdlLmdldEl0ZW0oRFJBRlRfS0VZKSA/PyAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cbn1cblxuLyoqIOWkluinguaMiemSru+8mmF1dG8g4oaSIGRhcmsg4oaSIGxpZ2h0IOW+queOr+OAgiAqL1xuYXN5bmMgZnVuY3Rpb24gY3ljbGVUaGVtZShzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzdGF0ZS5zZXR0aW5ncz8udGhlbWUgPz8gJ2F1dG8nO1xuICAgIGNvbnN0IG5leHQgPSBUSEVNRV9DWUNMRVsoVEhFTUVfQ1lDTEUuaW5kZXhPZihjdXJyZW50KSArIDEpICUgVEhFTUVfQ1lDTEUubGVuZ3RoXTtcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgc2V0dGluZ3M/OiBEc2hDaGF0U2V0dGluZ3MgfT4oTVNHLnVwZGF0ZVNldHRpbmdzLCB7IHRoZW1lOiBuZXh0IH0pO1xuICAgIGlmIChzYXZlZD8uc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2F2ZWQuc2V0dGluZ3M7XG4gICAgYXBwbHlBcHBlYXJhbmNlKHN0YXRlKTtcbiAgICB1cGRhdGVUaGVtZUJ1dHRvbihzdGF0ZSk7XG59XG5cbi8qKiDlpJbop4LmjInpkq7nmoTlm77moIcv5o+Q56S66Lef552A5b2T5YmN5qGj5L2N6LWw44CCICovXG5mdW5jdGlvbiB1cGRhdGVUaGVtZUJ1dHRvbihzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGJ1dHRvbiA9IHN0YXRlLnJvb3Q/LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYnRuLXRoZW1lJyk7XG4gICAgaWYgKCFidXR0b24pIHJldHVybjtcbiAgICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3M/LnRoZW1lID8/ICdhdXRvJztcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBUSEVNRV9HTFlQSFttb2RlXTtcbiAgICBidXR0b24udGl0bGUgPSBg5aSW6KeC77yaJHtUSEVNRV9MQUJFTFttb2RlXX3vvIjngrnlh7vliIfmjaLvvIlgO1xufVxuXG4vKiog6K6+572u6Z2i5p2/77yI5bCx5Zyw57yW6L6RICsg5L+d5a2Y77yJ44CCICovXG5mdW5jdGlvbiB0b2dnbGVTZXR0aW5ncyhzdGF0ZTogVWlTdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBzdGF0ZS5zZXR0aW5nc0hvc3Q7XG4gICAgaWYgKCFob3N0KSB7XG4gICAgICAgIGNvbnNvbGUud2FybignW2RzaF9jaGF0XSDpnaLmnb/ph4zmib7kuI3liLDorr7nva7lrrnlmaggI3NldHRpbmdz77yI6YCJ5oup5Zmo5rKh6Kej5p6Q5Ye65p2l77yf77yJJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3RhdGUuc2V0dGluZ3NPcGVuID0gIXN0YXRlLnNldHRpbmdzT3BlbjtcbiAgICBob3N0LmhpZGRlbiA9ICFzdGF0ZS5zZXR0aW5nc09wZW47XG4gICAgaWYgKCFzdGF0ZS5zZXR0aW5nc09wZW4pIHJldHVybjtcblxuICAgIGNvbnN0IHNldHRpbmdzID0gc3RhdGUuc2V0dGluZ3M7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGlmICghc2V0dGluZ3MpIHtcbiAgICAgICAgaG9zdC50ZXh0Q29udGVudCA9ICfov5jmsqHor7vliLDorr7nva7vvIznqI3lkI7lho3or5XjgIInO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZHJhZnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5zZXR0aW5ncyB9O1xuXG4gICAgLyoqIOS4gOS4quaWh+acrC/mlbDlrZfovpPlhaXooYzjgIIgKi9cbiAgICBjb25zdCBhZGRJbnB1dCA9IChncm91cDogc3RyaW5nIHwgbnVsbCwga2V5OiBrZXlvZiBEc2hDaGF0U2V0dGluZ3MsIGxhYmVsOiBzdHJpbmcsIHR5cGU6ICd0ZXh0JyB8ICdudW1iZXInKTogdm9pZCA9PiB7XG4gICAgICAgIGlmIChncm91cCkgaG9zdC5hcHBlbmRDaGlsZChlbCgnZGl2JywgJ2RzaC1zZXR0aW5ncy1ncm91cCcsIGdyb3VwKSk7XG4gICAgICAgIGNvbnN0IHJvdyA9IGVsKCdkaXYnLCAnZHNoLWZpZWxkJyk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChlbCgnbGFiZWwnLCB1bmRlZmluZWQsIGxhYmVsKSk7XG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWwoJ2lucHV0Jyk7XG4gICAgICAgIGlucHV0LnR5cGUgPSB0eXBlO1xuICAgICAgICBpbnB1dC52YWx1ZSA9IFN0cmluZyhzZXR0aW5nc1trZXldID8/ICcnKTtcbiAgICAgICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7XG4gICAgICAgICAgICBkcmFmdFtrZXkgYXMgc3RyaW5nXSA9IHR5cGUgPT09ICdudW1iZXInID8gTnVtYmVyKGlucHV0LnZhbHVlKSA6IGlucHV0LnZhbHVlO1xuICAgICAgICB9KTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGlucHV0KTtcbiAgICAgICAgaG9zdC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIH07XG5cbiAgICAvKiog5LiA5Liq5LiL5ouJ6KGM44CCICovXG4gICAgY29uc3QgYWRkU2VsZWN0ID0gKGtleToga2V5b2YgRHNoQ2hhdFNldHRpbmdzLCBsYWJlbDogc3RyaW5nLCBvcHRpb25zOiBBcnJheTxbc3RyaW5nLCBzdHJpbmddPik6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCByb3cgPSBlbCgnZGl2JywgJ2RzaC1maWVsZCcpO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoZWwoJ2xhYmVsJywgdW5kZWZpbmVkLCBsYWJlbCkpO1xuICAgICAgICBjb25zdCBzZWxlY3QgPSBlbCgnc2VsZWN0Jyk7XG4gICAgICAgIGZvciAoY29uc3QgW3ZhbHVlLCB0ZXh0XSBvZiBvcHRpb25zKSB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBlbCgnb3B0aW9uJywgdW5kZWZpbmVkLCB0ZXh0KTtcbiAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHZhbHVlO1xuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZWN0LnZhbHVlID0gU3RyaW5nKHNldHRpbmdzW2tleV0gPz8gJycpO1xuICAgICAgICBzZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgZHJhZnRba2V5IGFzIHN0cmluZ10gPSBzZWxlY3QudmFsdWU7XG4gICAgICAgIH0pO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoc2VsZWN0KTtcbiAgICAgICAgaG9zdC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIH07XG5cbiAgICAvKiog5LiA5Liq5Yu+6YCJ6KGM44CCICovXG4gICAgY29uc3QgYWRkQ2hlY2tib3ggPSAoa2V5OiBrZXlvZiBEc2hDaGF0U2V0dGluZ3MsIGxhYmVsOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgICAgY29uc3Qgcm93ID0gZWwoJ2RpdicsICdkc2gtZmllbGQnKTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGVsKCdsYWJlbCcsIHVuZGVmaW5lZCwgbGFiZWwpKTtcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbCgnaW5wdXQnKTtcbiAgICAgICAgaW5wdXQudHlwZSA9ICdjaGVja2JveCc7XG4gICAgICAgIGlucHV0LmNoZWNrZWQgPSBCb29sZWFuKHNldHRpbmdzW2tleV0pO1xuICAgICAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBkcmFmdFtrZXkgYXMgc3RyaW5nXSA9IGlucHV0LmNoZWNrZWQ7XG4gICAgICAgIH0pO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICAgICAgICBob3N0LmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfTtcblxuICAgIGhvc3QuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtc2V0dGluZ3MtZ3JvdXAnLCAn5aSW6KeCJykpO1xuICAgIGFkZFNlbGVjdCgndGhlbWUnLCAn5Li76aKYJywgW1xuICAgICAgICBbJ2F1dG8nLCAn6Lef6ZqP57O757ufJ10sXG4gICAgICAgIFsnZGFyaycsICfmt7HoibInXSxcbiAgICAgICAgWydsaWdodCcsICfmtYXoibInXSxcbiAgICBdKTtcbiAgICBhZGRTZWxlY3QoJ2ZvbnRTaXplJywgJ+ato+aWh+Wtl+WPtycsIFtcbiAgICAgICAgWycwJywgJ+m7mOiupO+8iDE0cHjvvIknXSxcbiAgICAgICAgWycxMicsICcxMnB4J10sXG4gICAgICAgIFsnMTMnLCAnMTNweCddLFxuICAgICAgICBbJzE0JywgJzE0cHgnXSxcbiAgICAgICAgWycxNScsICcxNXB4J10sXG4gICAgICAgIFsnMTYnLCAnMTZweCddLFxuICAgICAgICBbJzE3JywgJzE3cHgnXSxcbiAgICBdKTtcblxuICAgIGhvc3QuYXBwZW5kQ2hpbGQoZWwoJ2RpdicsICdkc2gtc2V0dGluZ3MtZ3JvdXAnLCAn5qih5Z6LJykpO1xuICAgIGFkZElucHV0KG51bGwsICdwcm92aWRlcicsICdwcm92aWRlcicsICd0ZXh0Jyk7XG4gICAgYWRkSW5wdXQobnVsbCwgJ21vZGVsJywgJ21vZGVsJywgJ3RleHQnKTtcbiAgICBhZGRJbnB1dChudWxsLCAncmVhc29uaW5nRWZmb3J0JywgJ+aOqOeQhuaho+S9jScsICd0ZXh0Jyk7XG4gICAgYWRkSW5wdXQobnVsbCwgJ21heFRva2VucycsICdtYXhUb2tlbnMnLCAnbnVtYmVyJyk7XG5cbiAgICBob3N0LmFwcGVuZENoaWxkKGVsKCdkaXYnLCAnZHNoLXNldHRpbmdzLWdyb3VwJywgJ+i/kOihjOaXticpKTtcbiAgICBhZGRJbnB1dChudWxsLCAnd29ya2RpcicsICflt6XkvZznm67lvZUnLCAndGV4dCcpO1xuICAgIGFkZElucHV0KG51bGwsICdub2RlUGF0aCcsICdub2RlIOi3r+W+hCcsICd0ZXh0Jyk7XG4gICAgYWRkSW5wdXQobnVsbCwgJ2RzaEJpbicsICdkc2ggYmluLmpzJywgJ3RleHQnKTtcbiAgICBhZGRDaGVja2JveCgnYXV0b1N0YXJ0JywgJ+iHquWKqOWQr+WKqCcpO1xuICAgIGFkZENoZWNrYm94KCdzaG93U3RkZXJyTm90ZXMnLCAn5pi+56S6IHN0ZGVycicpO1xuXG4gICAgY29uc3QgaGludCA9IGVsKCdkaXYnLCAnZHNoLWhpbnQnKTtcbiAgICBoaW50LnRleHRDb250ZW50ID1cbiAgICAgICAgJ+eVmeepuiA9IOiHquWKqOaOoua1i++8iG5vZGUg6LWwIFBBVEjvvIxkc2gg5LuOIFBBVEgg5LiK55qEIGRzaC9ucG0g5o6o5a+877yJ44CC5pS55a6M54K55L+d5a2Y77ybJyArXG4gICAgICAgICdub2RlL2RzaCDot6/lvoTmlLnkuobkvJrnq4vljbPph43mlrDmjqLmtYvvvIjmraPlnKjot5HnmoQgYWdlbnQg5LiN5Y+X5b2x5ZON77yM6YeN5ZCv5ZCO55Sf5pWI77yJ44CCJztcbiAgICBob3N0LmFwcGVuZENoaWxkKGhpbnQpO1xuXG4gICAgY29uc3QgYWN0aW9ucyA9IGVsKCdkaXYnLCAnZHNoLWJhbm5lci1hY3Rpb25zJyk7XG4gICAgY29uc3Qgc2F2ZSA9IGVsKCdidXR0b24nLCAnZHNoLWJ0bicsICfkv53lrZgnKTtcbiAgICBzYXZlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGNhbGw8eyBvazogYm9vbGVhbjsgc2V0dGluZ3M/OiBEc2hDaGF0U2V0dGluZ3MgfT4oTVNHLnVwZGF0ZVNldHRpbmdzLCBkcmFmdCk7XG4gICAgICAgIGlmIChzYXZlZD8uc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2F2ZWQuc2V0dGluZ3M7XG4gICAgICAgIGFwcGx5QXBwZWFyYW5jZShzdGF0ZSk7XG4gICAgICAgIHVwZGF0ZVRoZW1lQnV0dG9uKHN0YXRlKTtcbiAgICAgICAgc3RhdGUuc2V0dGluZ3NPcGVuID0gZmFsc2U7XG4gICAgICAgIGhvc3QuaGlkZGVuID0gdHJ1ZTtcbiAgICAgICAgYXdhaXQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICAgICAgdG9nZ2xlU2V0dGluZ3Moc3RhdGUpO1xuICAgIH0pO1xuICAgIGNvbnN0IHJlcGFpciA9IGVsKCdidXR0b24nLCAnZHNoLWJ0bicsICfkv67lpI0gcHJvZmlsZScpO1xuICAgIHJlcGFpci5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgcmVwYWlyUHJvZmlsZShzdGF0ZSkpO1xuICAgIGNvbnN0IGNsb3NlID0gZWwoJ2J1dHRvbicsICdkc2gtYnRuJywgJ+WFs+mXrScpO1xuICAgIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlU2V0dGluZ3Moc3RhdGUpKTtcbiAgICBhY3Rpb25zLmFwcGVuZChzYXZlLCByZXBhaXIsIGNsb3NlKTtcbiAgICBob3N0LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOaMgui9vVxuXG4vKiog57uE6KOF6Z2i5p2/55qE5Lqk5LqS77yI5q+P5Liq6Z2i5p2/5a6e5L6L5LiA5qyh77yJ44CCICovXG5mdW5jdGlvbiBtb3VudChjdHg6IGFueSk6IFVpU3RhdGUge1xuICAgIGNvbnN0ICQgPSBjdHguJCA/PyB7fTtcblxuICAgIC8vIOmdouadv+agueiKgueCue+8muaLv+WIsOWug+WwseiDveWcqOmHjOmdouaMiemAieaLqeWZqOihpeafpe+8iOingeS4i+mdoiBwaWNrIOeahOivtOaYju+8ieOAglxuICAgIGNvbnN0IHJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbCA9XG4gICAgICAgICgkLnJvb3QgYXMgSFRNTEVsZW1lbnQpID8/XG4gICAgICAgICgkLmJvZHkgYXMgSFRNTEVsZW1lbnQpPy5jbG9zZXN0Py4oJy5kc2gtcm9vdCcpID8/XG4gICAgICAgICgkLmJvZHkgYXMgSFRNTEVsZW1lbnQpPy5wYXJlbnRFbGVtZW50ID8/XG4gICAgICAgIG51bGw7XG5cbiAgICAvKipcbiAgICAgKiDlj5blhYPntKDvvJrlhYjkv6HnvJbovpHlmajnu5nnmoQgYCRg77yM5ou/5LiN5Yiw5YaNKirlnKjpnaLmnb/moLnoioLngrnph4zmjInlkIzkuIDkuKrpgInmi6nlmajmn6XkuIDmrKEqKuOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB6L+Z6YGT5YWc5bqV77yaYGRvY3VtZW50LmdldEVsZW1lbnRCeUlkYCDlnKjov5nkuKrnjq/looPph4zmi7/kuI3liLDpnaLmnb/lhYPntKDvvIjlrp7mtYvvvInvvIxcbiAgICAgKiDor7TmmI7pnaLmnb8gRE9NIOS4jeS4gOWumuaMguWcqOaooeWdl+aJgOWkhOeahOmCo+S4qiBkb2N1bWVudCDkuIrvvJvogIwgYCRgIOWBtuWwlOa8j+S4gOS4qumUruaXtu+8jFxuICAgICAqIOS7juagueiKgueCuSBzY29wZSDmn6Xor6Lku43nhLbog73lkb3kuK3jgILkuKTpgZPpg73kuI3ooYzlsLHov5Tlm54gbnVsbO+8jOeUseiwg+eUqOaWuemZjee6p++8iOWPqiB3YXJuIOS4jeaKm++8ieOAglxuICAgICAqL1xuICAgIGNvbnN0IHBpY2sgPSAoa2V5OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB8IG51bGwgPT4ge1xuICAgICAgICBjb25zdCBkaXJlY3QgPSAkW2tleV0gYXMgSFRNTEVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChkaXJlY3QpIHJldHVybiBkaXJlY3Q7XG4gICAgICAgIGNvbnN0IHNlbGVjdG9yID0gU0VMRUNUT1JTW2tleV07XG4gICAgICAgIGlmICghc2VsZWN0b3IgfHwgIXJvb3QpIHJldHVybiBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIHJvb3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oc2VsZWN0b3IpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IG1pc3NpbmcgPSBPYmplY3Qua2V5cyhTRUxFQ1RPUlMpLmZpbHRlcigoa2V5KSA9PiAhcGljayhrZXkpKTtcbiAgICBpZiAobWlzc2luZy5sZW5ndGggPiAwKSB7XG4gICAgICAgIC8vIOWPqiB3YXJuIOS4jeaKm++8mumdouadv+WwkeS4quWFg+e0oOS5n+imgeiDveW8gO+8jOWQpuWImeeUqOaIt+WcqOe8lui+keWZqOmHjOWPqueci+WIsOS4gOadoee6oumUmeOAglxuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgICBgW2RzaF9jaGF0XSDpnaLmnb/ph4zmsqHmib7liLDov5nkupvlhYPntKDvvJoke21pc3Npbmcuam9pbignLCAnKX3vvIjlr7nlupTpgInmi6nlmaggJHttaXNzaW5nXG4gICAgICAgICAgICAgICAgLm1hcCgoaykgPT4gU0VMRUNUT1JTW2tdKVxuICAgICAgICAgICAgICAgIC5qb2luKCcsICcpfe+8iWAsXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGU6IFVpU3RhdGUgPSB7XG4gICAgICAgIHJvb3QsXG4gICAgICAgIGRvdDogcGljaygnZG90JyksXG4gICAgICAgIHRpdGxlOiBwaWNrKCd0aXRsZScpLFxuICAgICAgICBzdWI6IHBpY2soJ3N1YicpLFxuICAgICAgICBiYW5uZXI6IHBpY2soJ2Jhbm5lcicpLFxuICAgICAgICBzZXR0aW5nc0hvc3Q6IHBpY2soJ3NldHRpbmdzJyksXG4gICAgICAgIGJvZHk6IHBpY2soJ2JvZHknKSBhcyBIVE1MRWxlbWVudCxcbiAgICAgICAgaW5wdXQ6IHBpY2soJ2lucHV0JykgYXMgSFRNTFRleHRBcmVhRWxlbWVudCxcbiAgICAgICAgc2VuZEJ1dHRvbjogcGljaygnYnRuU2VuZCcpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCxcbiAgICAgICAgbGl2ZTogcGljaygnbGl2ZScpLFxuICAgICAgICBtZXRhOiBwaWNrKCdtZXRhJyksXG4gICAgICAgIGhpc3RvcnlCYXI6IHBpY2soJ2hpc3RvcnlCYXInKSxcbiAgICAgICAgaGlzdG9yeUJhclRleHQ6IHBpY2soJ2hpc3RvcnlCYXJUZXh0JyksXG4gICAgICAgIGhpc3Rvcnk6IHBpY2soJ2hpc3RvcnknKSxcbiAgICAgICAgaGlzdG9yeUxpc3Q6IHBpY2soJ2hpc3RvcnlMaXN0JyksXG4gICAgICAgIGhpc3RvcnlOb3RlOiBwaWNrKCdoaXN0b3J5Tm90ZScpLFxuICAgICAgICByZXN1bWVCdXR0b246IHBpY2soJ2J0blJlc3VtZScpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCxcbiAgICAgICAgZWxzOiBuZXcgTWFwKCksXG4gICAgICAgIGVudHJpZXM6IG5ldyBNYXAoKSxcbiAgICAgICAgb3BlblRvb2xzOiBuZXcgTWFwKCksXG4gICAgICAgIGNvbGxhcHNlZFRoaW5rOiBuZXcgTWFwKCksXG4gICAgICAgIG1heFJldjogMCxcbiAgICAgICAgbWF4U2VxOiAwLFxuICAgICAgICBnZW5lcmF0aW9uOiAwLFxuICAgICAgICB0aWNrOiAwLFxuICAgICAgICB0aW1lcjogbnVsbCxcbiAgICAgICAgcG9sbGluZzogZmFsc2UsXG4gICAgICAgIHJlcG9ydGVkUmVzdW1lOiBmYWxzZSxcbiAgICAgICAgaW50ZXJydXB0aW5nOiBmYWxzZSxcbiAgICAgICAgc25hcHNob3Q6IG51bGwsXG4gICAgICAgIHNldHRpbmdzOiBudWxsLFxuICAgICAgICBzZXR0aW5nc09wZW46IGZhbHNlLFxuICAgICAgICBoaXN0b3J5T3BlbjogZmFsc2UsXG4gICAgICAgIHN0YXJ0UmVxdWVzdGVkOiBmYWxzZSxcbiAgICAgICAgYmFubmVyVW50aWw6IDAsXG4gICAgICAgIGVtcHR5RWw6IG51bGwsXG4gICAgICAgIHR5cGluZ0VsOiBudWxsLFxuICAgICAgICBsYXN0VXNlclNlcTogMCxcbiAgICAgICAgYnJvYWRjYXN0SGFuZGxlcjogbnVsbCxcbiAgICAgICAgYXR0YWNobWVudHM6IFtdLFxuICAgICAgICBhdHRhY2hIb3N0OiBwaWNrKCdhdHRhY2htZW50cycpLFxuICAgICAgICBpbWFnZUJ1dHRvbjogcGljaygnYnRuSW1hZ2UnKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwsXG4gICAgICAgIGltYWdlQnVzeTogMCxcbiAgICAgICAgcGlja2VyOiBwaWNrKCdwaWNrZXInKSxcbiAgICAgICAgcGlja2VyTGlzdDogcGljaygncGlja2VyTGlzdCcpLFxuICAgICAgICBwaWNrZXJOb3RlOiBwaWNrKCdwaWNrZXJOb3RlJyksXG4gICAgICAgIHBpY2tlclNlYXJjaDogcGljaygncGlja2VyU2VhcmNoJykgYXMgSFRNTElucHV0RWxlbWVudCB8IG51bGwsXG4gICAgICAgIHBpY2tlck9wZW46IGZhbHNlLFxuICAgICAgICBwaWNrZXJJbWFnZXM6IG51bGwsXG4gICAgICAgIHBpY2tlclNvdXJjZTogJycsXG4gICAgICAgIHBpY2tlclF1ZXJ5OiAnJyxcbiAgICAgICAgcGlja2VyVGh1bWJzOiBuZXcgTWFwKCksXG4gICAgICAgIHBpY2tlckZhaWxlZDogbmV3IFNldCgpLFxuICAgICAgICBwaWNrZXJMb2FkaW5nOiBuZXcgU2V0KCksXG4gICAgICAgIHBpY2tlclF1ZXVlOiBbXSxcbiAgICAgICAgcGlja2VyT2JzZXJ2ZXI6IG51bGwsXG4gICAgICAgIHNlbnRUaHVtYnM6IG5ldyBNYXAoKSxcbiAgICB9O1xuXG4gICAgaWYgKCFzdGF0ZS5ib2R5IHx8ICFzdGF0ZS5pbnB1dCkge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1tkc2hfY2hhdF0g6Z2i5p2/57y65bCRICNib2R5IOaIliAjaW5wdXTvvIxVSSDml6Dms5Xlt6XkvZzvvIjor7fmo4Dmn6Ugc3RhdGljL3RlbXBsYXRlL2RlZmF1bHQvaW5kZXguaHRtbO+8iScpO1xuICAgICAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdmYXRhbCcsIG1pc3NpbmcsIGhhc0JvZHk6IEJvb2xlYW4oc3RhdGUuYm9keSksIGhhc0lucHV0OiBCb29sZWFuKHN0YXRlLmlucHV0KSB9KTtcbiAgICAgICAgcmV0dXJuIHN0YXRlO1xuICAgIH1cblxuICAgIC8vIOS4u+mimOWFiOaMieOAjOi3n+maj+ezu+e7n+OAjeeUu+S4iu+8jOmBv+WFjeS4gOi/m+adpeaYr+eZveW6leWGjei3s+aIkOm7keW6lVxuICAgIGFwcGx5QXBwZWFyYW5jZShzdGF0ZSk7XG4gICAgdXBkYXRlVGhlbWVCdXR0b24oc3RhdGUpO1xuXG4gICAgLy8g5biD5bGA6Ieq5qOA77yI57uT5p6c5Zue5Lyg5Li76L+b56iL77yM6Z2i5p2/6auY5bqm5aGM5LqG5Lmf6L+Y6IO95oql5LiK5p2l77yJXG4gICAgY29uc3QgbGF5b3V0ID0gZW5zdXJlTGF5b3V0KHN0YXRlKTtcbiAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdyZWFkeScsIG1pc3NpbmcsIGxheW91dCB9KTtcblxuICAgIHJlbmRlckVtcHR5KHN0YXRlLCAnbm8tYWdlbnQnKTtcblxuICAgIC8vIOiNieeov+WbnuWhq1xuICAgIGNvbnN0IGRyYWZ0ID0gbG9hZERyYWZ0KCk7XG4gICAgaWYgKGRyYWZ0KSB7XG4gICAgICAgIHN0YXRlLmlucHV0LnZhbHVlID0gZHJhZnQ7XG4gICAgICAgIGF1dG9Hcm93KHN0YXRlLmlucHV0KTtcbiAgICB9XG5cbiAgICBzdGF0ZS5zZW5kQnV0dG9uPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgc2VuZChzdGF0ZSkpO1xuICAgIHN0YXRlLmlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgICBhdXRvR3JvdyhzdGF0ZS5pbnB1dCk7XG4gICAgICAgIHNhdmVEcmFmdChzdGF0ZS5pbnB1dC52YWx1ZSk7XG4gICAgfSk7XG4gICAgc3RhdGUuaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudDogS2V5Ym9hcmRFdmVudCkgPT4ge1xuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInICYmICFldmVudC5zaGlmdEtleSAmJiAhZXZlbnQuaXNDb21wb3NpbmcpIHtcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB2b2lkIHNlbmQoc3RhdGUpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiDnspjotLTvvJoqKuWPquiupOWbvioq44CCXG4gICAgICpcbiAgICAgKiBgcHJldmVudERlZmF1bHQoKWAg5Y+q5Zyo44CM5Ymq6LS05p2/6YeM56Gu5a6e5pyJ5Zu+44CN5pe25omN6LCDIOKAlOKAlCDlkKbliJnnspjotLTkuIDmrrXmloflrZfkvJrooqvmiJHku6zlkIPmjonvvIxcbiAgICAgKiDogIzpgqPmmK/ov5nkuKrovpPlhaXmoYbmnIDluLjnlKjnmoTmk43kvZzjgILnm5HlkKzmjILlnKgqKumdouadv+agueiKgueCuSoq5LiK77yI5LiN5Y+q5pivIHRleHRhcmVh77yJ77yaXG4gICAgICog54Sm54K55Zyo6L6T5YWl5qGG6YeM5piv5bi45oCB77yM5L2G5Yia54K55a6M5Zu+54mH6YCJ5oup5Zmo5pe254Sm54K55Y+v6IO95Zyo5Yir5aSE77yM6YKj5pe2IEN0cmwrViDkuZ/or6Xog73nlKjjgIJcbiAgICAgKiDkuovku7blhpLms6HliLDmoLnoioLngrnljbPlj6/vvIzmiYDku6Xlj6rmjILkuIDlpITjgIJcbiAgICAgKi9cbiAgICBjb25zdCBvblBhc3RlID0gKGV2ZW50OiBDbGlwYm9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgICAgICBjb25zdCBpbWFnZXMgPSBpbWFnZXNGcm9tQ2xpcGJvYXJkKGV2ZW50LmNsaXBib2FyZERhdGEpO1xuICAgICAgICBpZiAoaW1hZ2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgcmVwb3J0UHJvYmUoeyBraW5kOiAncGFzdGUnLCBpbWFnZXM6IGltYWdlcy5sZW5ndGgsIHR5cGVzOiBpbWFnZXMubWFwKChpdGVtKSA9PiBpdGVtLmJsb2IudHlwZSkgfSk7XG4gICAgICAgIHZvaWQgYXR0YWNoQmxvYnMoc3RhdGUsIGltYWdlcywgJ2NsaXBib2FyZCcpO1xuICAgIH07XG4gICAgKHJvb3QgPz8gc3RhdGUuYm9keSkuYWRkRXZlbnRMaXN0ZW5lcigncGFzdGUnLCBvblBhc3RlIGFzIEV2ZW50TGlzdGVuZXIpO1xuICAgIHN0YXRlLmlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ3Bhc3RlJywgb25QYXN0ZSBhcyBFdmVudExpc3RlbmVyKTtcblxuICAgIC8vIOaLlui/m+adpeS5n+eul+OAjOWKoOWbvuOAje+8muS4ieS4quadpea6kO+8iOeymOi0tC/pgInmi6nlmagv5ouW5ou977yJ6YO96JC95YiwIGF0dGFjaEJsb2JzIOi/meS4gOadoei3r+S4ilxuICAgIChyb290ID8/IHN0YXRlLmJvZHkpLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgKGV2ZW50OiBEcmFnRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGV2ZW50LmRhdGFUcmFuc2Zlcj8udHlwZXM/LmluY2x1ZGVzKCdGaWxlcycpKSB7XG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgaWYgKHJvb3QpIHJvb3QuZGF0YXNldC5kcmFnID0gJ3RydWUnO1xuICAgICAgICB9XG4gICAgfSk7XG4gICAgKHJvb3QgPz8gc3RhdGUuYm9keSkuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgKCkgPT4ge1xuICAgICAgICBpZiAocm9vdCkgZGVsZXRlIHJvb3QuZGF0YXNldC5kcmFnO1xuICAgIH0pO1xuICAgIChyb290ID8/IHN0YXRlLmJvZHkpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCAoZXZlbnQ6IERyYWdFdmVudCkgPT4ge1xuICAgICAgICBpZiAocm9vdCkgZGVsZXRlIHJvb3QuZGF0YXNldC5kcmFnO1xuICAgICAgICBjb25zdCBmaWxlcyA9IGV2ZW50LmRhdGFUcmFuc2Zlcj8uZmlsZXMgPyBBcnJheS5mcm9tKGV2ZW50LmRhdGFUcmFuc2Zlci5maWxlcykgOiBbXTtcbiAgICAgICAgY29uc3QgaW1hZ2VzID0gZmlsZXNcbiAgICAgICAgICAgIC5maWx0ZXIoKGZpbGUpID0+IGZpbGUudHlwZS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ2ltYWdlLycpKVxuICAgICAgICAgICAgLm1hcCgoZmlsZSwgaW5kZXgpID0+ICh7IGJsb2I6IGZpbGUgYXMgQmxvYiwgbmFtZTogZmlsZS5uYW1lIHx8IGDmi5bov5vmnaXnmoTlm77niYctJHtpbmRleCArIDF9YCB9KSk7XG4gICAgICAgIGlmIChpbWFnZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHZvaWQgYXR0YWNoQmxvYnMoc3RhdGUsIGltYWdlcywgJ2Ryb3AnKTtcbiAgICB9KTtcblxuICAgIC8vIOWbvueJh+aMiemSruS4jumAieaLqeWZqFxuICAgIHN0YXRlLmltYWdlQnV0dG9uPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZVBpY2tlcihzdGF0ZSkpO1xuICAgIHBpY2soJ2J0blBpY2tlckNsb3NlJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlUGlja2VyKHN0YXRlLCBmYWxzZSkpO1xuICAgIHBpY2soJ2J0blBpY2tlclJlZnJlc2gnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHN0YXRlLnBpY2tlclRodW1icy5jbGVhcigpO1xuICAgICAgICBzdGF0ZS5waWNrZXJGYWlsZWQuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBlbnN1cmVQaWNrZXJMaXN0KHN0YXRlLCB0cnVlKTtcbiAgICB9KTtcbiAgICBwaWNrKCdidG5QaWNrZXJQYXN0ZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgcGFzdGVGcm9tQ2xpcGJvYXJkQXBpKHN0YXRlKSk7XG4gICAgc3RhdGUucGlja2VyU2VhcmNoPy5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgICAgc3RhdGUucGlja2VyUXVlcnkgPSBzdGF0ZS5waWNrZXJTZWFyY2g/LnZhbHVlID8/ICcnO1xuICAgICAgICByZW5kZXJQaWNrZXJMaXN0KHN0YXRlKTtcbiAgICB9KTtcbiAgICBzdGF0ZS5waWNrZXJTZWFyY2g/LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHRvZ2dsZVBpY2tlcihzdGF0ZSwgZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgcGljaygnYnRuTmV3Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyDkuLvov5vnqIvkvJrmuIXovazlhpnlubbmiorku6PmlbAgKzHvvJvpnaLmnb/kuI3oh6rlt7HmuIUgRE9N77yI5riF56m65Y+q5pyJ5LiA5Liq55yf5rqQ77yM6KeBIHJlc2V0VWnvvIlcbiAgICAgICAgYXdhaXQgY2FsbChNU0cubmV3U2Vzc2lvbik7XG4gICAgICAgIGF3YWl0IHJlZnJlc2hTdGF0ZShzdGF0ZSk7XG4gICAgICAgIGF3YWl0IHBvbGxPbmNlKHN0YXRlKTtcbiAgICB9KTtcblxuICAgIHBpY2soJ2J0blN0b3AnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHNldHRsZWQgPSBzdGF0ZS5zbmFwc2hvdD8uc3RhdHVzID09PSAnc3RvcHBlZCcgfHwgc3RhdGUuc25hcHNob3Q/LnN0YXR1cyA9PT0gJ2Vycm9yJztcbiAgICAgICAgaWYgKHNldHRsZWQpIHtcbiAgICAgICAgICAgIC8vIOayoei3keeahOaXtuWAmei/meS4quaMiemSruaYr+OAjOWQr+WKqOOAjeKAlOKAlCDkuYvliY3moLnmnKzmsqHmnInov5nkuKrlhaXlj6PvvIjop4EgcmVmcmVzaFN0YXRlIOmHjOeahOivtOaYju+8iVxuICAgICAgICAgICAgYXdhaXQgc3RhcnRBZ2VudChzdGF0ZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2V0QmFubmVyKHN0YXRlLCAn5q2j5Zyo5YGc5q2iIGFnZW504oCmJywgJ2luZm8nKTtcbiAgICAgICAgYXdhaXQgY2FsbChNU0cuc3RvcEFnZW50KTtcbiAgICAgICAgYXdhaXQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICB9KTtcblxuICAgIC8qKlxuICAgICAqIOOAjOWBnOatouacrOi9ruOAjeKAlOKAlCDkuK3mlq3lvZPliY3ov5nkuIDova7vvIwqKuS4jeWKqCBhZ2VudOOAgeS4jeWKqOS8muivnSoq44CCXG4gICAgICpcbiAgICAgKiDkuInmnaHnnLzliY3og73nnIvliLDnmoTlj43ppojvvIjkuI3nhLbnlKjmiLfkvJrku6XkuLrmjInpkq7msqHnlJ/mlYjvvIzlm6DkuLrmqKHlnovov5jkvJrmiorlt7LnlJ/miJDnmoRcbiAgICAgKiDpgqPkuIDlsI/mrrXmloflrZflkJDlrozjgIHlt6Xlhbfnu5PmnpzkuZ/lj6/og73lho3mnaXkuIDmnaHvvInvvJpcbiAgICAgKiDikaAg56uL5Yi75oqK54q25oCB6KGM5pS55oiQ44CM5q2j5Zyo5Lit5pat4oCm44CN5bm256aB55So5oyJ6ZKu77yb4pGhIOS4u+i/m+eoi+S8muiusOS4gOadoSBub3Rl77ybXG4gICAgICog4pGiIGB0dXJuL2VuZGAg55qEIGBhYm9ydGVkYCDliLDkuobkuYvlkI7nirbmgIHooYzoh6rlt7HkvJrlj5jlm57nqbrpl7LjgIJcbiAgICAgKi9cbiAgICBwaWNrKCdidG5JbnRlcnJ1cHQnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIHN0YXRlLmludGVycnVwdGluZyA9IHRydWU7XG4gICAgICAgIHN5bmNJbnRlcnJ1cHRCdXR0b24oc3RhdGUpO1xuICAgICAgICBpZiAoc3RhdGUubGl2ZSkge1xuICAgICAgICAgICAgc3RhdGUubGl2ZS50ZXh0Q29udGVudCA9ICfmraPlnKjkuK3mlq3ov5nkuIDova7igKYnO1xuICAgICAgICAgICAgc3RhdGUubGl2ZS5kYXRhc2V0LnRvbmUgPSAnYnVzeSc7XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgY2FsbDx7IG9rOiBib29sZWFuOyBjYW5jZWxsZWQ/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9PihNU0cuaW50ZXJydXB0KTtcbiAgICAgICAgICAgIGlmICghcmVwbHk/Lm9rKSBzZXRCYW5uZXIoc3RhdGUsIGDkuK3mlq3lpLHotKXvvJoke3JlcGx5Py5lcnJvciA/PyAn5pyq55+l5Y6f5ZugJ31gLCAnZXJyb3InKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHNldEJhbm5lcihzdGF0ZSwgYOS4reaWreWksei0pe+8miR7U3RyaW5nKGVycm9yKX1gLCAnZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCByZWZyZXNoU3RhdGUoc3RhdGUpO1xuICAgICAgICBhd2FpdCBwb2xsT25jZShzdGF0ZSk7XG4gICAgfSk7XG5cbiAgICBwaWNrKCdidG5SZXN0YXJ0Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBzZXRCYW5uZXIoc3RhdGUsICfmraPlnKjph43lkK8gYWdlbnTigKbvvIjph43lkK/lkI7kvJroh6rliqjmjqXkuIrkuIrmrKHnmoTkvJror53vvIknLCAnaW5mbycpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgY2FsbChNU0cuc3RvcEFnZW50KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSDph43lkK/ml7Ygc3RvcCDlpLHotKXvvIjnu6fnu60gc3RhcnTvvInvvJoke1N0cmluZyhlcnJvcil9YCk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgc3RhcnRBZ2VudChzdGF0ZSk7XG4gICAgfSk7XG5cbiAgICBwaWNrKCdidG5IaXN0b3J5Jyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBvcGVuSGlzdG9yeShzdGF0ZSkpO1xuICAgIHBpY2soJ2J0bkhpc3RvcnlSZWZyZXNoJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCBvcGVuSGlzdG9yeShzdGF0ZSkpO1xuICAgIHBpY2soJ2J0bkhpc3RvcnlDbG9zZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGNsb3NlSGlzdG9yeShzdGF0ZSkpO1xuICAgIHN0YXRlLnJlc3VtZUJ1dHRvbj8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIHJlc3VtZUhpc3Rvcnkoc3RhdGUpKTtcblxuICAgIHBpY2soJ2J0blNldHRpbmdzJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlU2V0dGluZ3Moc3RhdGUpKTtcbiAgICBwaWNrKCdidG5UaGVtZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHZvaWQgY3ljbGVUaGVtZShzdGF0ZSkpO1xuXG4gICAgLy8g4pqgICoq6L2u6K+i5Zyo6L+Z6YeM6LW377yM5LiN562JIGBsaXN0ZW5lcnMuc2hvd2AqKu+8iOingSBQT0xMX0lOVEVSVkFMX01TIOS4iuaWueeahOivtOaYju+8iVxuICAgIHJlc3VtZShzdGF0ZSwgJ21vdW50Jyk7XG5cbiAgICByZXR1cm4gc3RhdGU7XG59XG5cbi8qKiDpnaLmnb/mmL7npLov5oyC6L2977ya6LW36L2u6K+iICsg5o6l5bm/5pKt77yIKirluYLnrYkqKu+8jGBtb3VudGAg5LiOIGBsaXN0ZW5lcnMuc2hvd2Ag6YO95Lya6LCD77yJ44CCICovXG5mdW5jdGlvbiByZXN1bWUoc3RhdGU6IFVpU3RhdGUsIHNvdXJjZTogJ21vdW50JyB8ICdzaG93Jyk6IHZvaWQge1xuICAgIGNvbnN0IGF0dGFjaGVkID0gYXR0YWNoQnJvYWRjYXN0KHN0YXRlKTtcbiAgICBzdGF0ZS5wb2xsaW5nID0gdHJ1ZTtcbiAgICBzY2hlZHVsZVBvbGwoc3RhdGUpO1xuICAgIGlmICghc3RhdGUucmVwb3J0ZWRSZXN1bWUpIHtcbiAgICAgICAgc3RhdGUucmVwb3J0ZWRSZXN1bWUgPSB0cnVlO1xuICAgICAgICByZXBvcnRQcm9iZSh7IGtpbmQ6ICdyZXN1bWVkJywgc291cmNlLCBicm9hZGNhc3Q6IGF0dGFjaGVkLCBwb2xsTXM6IFBPTExfSU5URVJWQUxfTVMgfSk7XG4gICAgfVxuICAgIC8vIOeri+WIu+aLieS4gOasoeW5tuWIt+eKtuaAge+8jOWIq+etieesrOS4gOS4qumXtOmalO+8iOS5n+iuqeOAjOaJk+W8gOmdouadv+OAjeeri+WIu+eci+WIsOacgOaWsOWGheWuue+8iVxuICAgIHZvaWQgcG9sbE9uY2Uoc3RhdGUpO1xuICAgIHZvaWQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbn1cblxuLyoqIOaOpeW5v+aSre+8iOW/q+i3r++8ieOAguaLv+S4jeWIsOe8lui+keWZqOS/neaKpOaOpeWPo+S5n+S4jeW9seWTjeeUqCDigJTigJQg6L2u6K+i5omN5piv5Li76Lev44CCICovXG5mdW5jdGlvbiBhdHRhY2hCcm9hZGNhc3Qoc3RhdGU6IFVpU3RhdGUpOiBib29sZWFuIHtcbiAgICBpZiAoc3RhdGUuYnJvYWRjYXN0SGFuZGxlcikgcmV0dXJuIHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYnVzID0gKFxuICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2UgYXMgdW5rbm93biBhcyB7XG4gICAgICAgICAgICAgICAgX19wcm90ZWN0ZWRfXz86IHsgYWRkQnJvYWRjYXN0TGlzdGVuZXI/OiAobTogc3RyaW5nLCBmOiAodTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZCB9O1xuICAgICAgICAgICAgfVxuICAgICAgICApLl9fcHJvdGVjdGVkX187XG4gICAgICAgIGlmICghYnVzPy5hZGRCcm9hZGNhc3RMaXN0ZW5lcikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKHVwZGF0ZTogdW5rbm93bik6IHZvaWQgPT4gYXBwbHlCcm9hZGNhc3Qoc3RhdGUsIHVwZGF0ZSk7XG4gICAgICAgIGJ1cy5hZGRCcm9hZGNhc3RMaXN0ZW5lcihCUk9BRENBU1RfQ0hBTk5FTCwgaGFuZGxlcik7XG4gICAgICAgIHN0YXRlLmJyb2FkY2FzdEhhbmRsZXIgPSBoYW5kbGVyO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLyoqIOaOkuS4i+S4gOi3s+i9ruivouOAgui3keWKqOaXtuWvhuS4gOeCue+8iOa1geW8j+S4u+imgemdoOi/meS4gOi3r+aYvuekuuWHuuadpe+8ieOAgiAqL1xuZnVuY3Rpb24gc2NoZWR1bGVQb2xsKHN0YXRlOiBVaVN0YXRlKTogdm9pZCB7XG4gICAgaWYgKCFzdGF0ZS5wb2xsaW5nKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUudGltZXIpO1xuICAgIGNvbnN0IGRlbGF5ID0gc3RhdGUuc25hcHNob3Q/LnJ1bm5pbmcgPyBQT0xMX0lOVEVSVkFMX0FDVElWRV9NUyA6IFBPTExfSU5URVJWQUxfTVM7XG4gICAgc3RhdGUudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHZvaWQgdGljayhzdGF0ZSksIGRlbGF5KTtcbn1cblxuLyoqIOS4gOi3s++8muaLiei9rOWGmSDihpLvvIjmnInmlrDmnaHnm67miJbliLDkuoblkajmnJ/vvInliLfnirbmgIEg4oaSIOaOkuS4i+S4gOi3s+OAgiAqL1xuYXN5bmMgZnVuY3Rpb24gdGljayhzdGF0ZTogVWlTdGF0ZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghc3RhdGUucG9sbGluZykgcmV0dXJuO1xuICAgIHN0YXRlLnRpY2sgKz0gMTtcbiAgICBjb25zdCBjaGFuZ2VkID0gYXdhaXQgcG9sbE9uY2Uoc3RhdGUpO1xuICAgIGlmIChjaGFuZ2VkIHx8IHN0YXRlLnRpY2sgJSBTVEFURV9FVkVSWV9USUNLUyA9PT0gMCkgYXdhaXQgcmVmcmVzaFN0YXRlKHN0YXRlKTtcbiAgICBzY2hlZHVsZVBvbGwoc3RhdGUpO1xufVxuXG4vKipcbiAqIOmdouadv+atpOWIu+aYr+WQpuecn+eahOeci+W+l+inge+8iOmHjyBET03vvIzkuI3kv6HnvJbovpHlmajnmoTpkqnlrZDvvInjgIJcbiAqXG4gKiDnlKjpgJTlj6rmnInkuIDkuKrvvJpgaGlkZWAg6ZKp5a2Q55qE5YWc5bqVIOKAlOKAlCDpkqnlrZDor7TjgIzol4/otbfmnaXkuobjgI3kvYbpnaLmnb/mmI7mmI7ljaDnnYDkvY3nva7ml7bvvIxcbiAqIOWugeWPr+e7p+e7rei9ruivou+8iOWkmuS4gOasoSBJUEMg6ICM5bey77yJ77yM5Lmf5LiN6IO95oqK5Yi35paw5YGc5o6J77yI5YGc5LqG5bCx5piv44CM5YaF5a655LiN5pu05paw44CN6L+Z5LiqIGJ1Z++8ieOAglxuICog5Yik5o2u5pWF5oSP5a695p2+77ya6YeP5LiN5Ye65p2l5pe2KirlvZPkvZzlj6/op4EqKu+8iOivr+WIpOaWueWQkeW/hemhu+WBj+WQkeOAjOe7p+e7rei9ruivouOAje+8ieOAglxuICovXG5mdW5jdGlvbiBwYW5lbFZpc2libGUoc3RhdGU6IFVpU3RhdGUpOiBib29sZWFuIHtcbiAgICBjb25zdCByb290ID0gc3RhdGUucm9vdDtcbiAgICBpZiAoIXJvb3QpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiByb290LmdldENsaWVudFJlY3RzKCkubGVuZ3RoID4gMCAmJiByb290Lm9mZnNldEhlaWdodCA+IDA7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuLyoqIOmdouadv+makOiXj++8muWBnOi9ruivou+8iOW5v+aSreS5n+aRmOaOie+8jOmBv+WFjeeci+S4jeingeaXtui/mOWcqOmHjee7mO+8ieOAgiAqL1xuZnVuY3Rpb24gcGF1c2Uoc3RhdGU6IFVpU3RhdGUsIHNvdXJjZTogJ2hpZGUnIHwgJ21hbnVhbCcgPSAnaGlkZScpOiB2b2lkIHtcbiAgICBpZiAoc291cmNlID09PSAnaGlkZScgJiYgcGFuZWxWaXNpYmxlKHN0YXRlKSkge1xuICAgICAgICAvLyDpkqnlrZDkuI7lnLDpnaLnnJ/nm7jmiZPmnrbvvJrku6XlnLDpnaLnnJ/nm7jkuLrlh4bvvIznu6fnu63ova7or6JcbiAgICAgICAgcmVwb3J0UHJvYmUoeyBraW5kOiAnaGlkZS1pZ25vcmVkJywgcmVhc29uOiAn6Z2i5p2/5LuN5Y+v6KeB77yM57un57ut6L2u6K+iJyB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdGF0ZS5wb2xsaW5nID0gZmFsc2U7XG4gICAgaWYgKHN0YXRlLnRpbWVyKSB7XG4gICAgICAgIGNsZWFyVGltZW91dChzdGF0ZS50aW1lcik7XG4gICAgICAgIHN0YXRlLnRpbWVyID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmJyb2FkY2FzdEhhbmRsZXIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGJ1cyA9IChcbiAgICAgICAgICAgICAgICBFZGl0b3IuTWVzc2FnZSBhcyB1bmtub3duIGFzIHtcbiAgICAgICAgICAgICAgICAgICAgX19wcm90ZWN0ZWRfXz86IHsgcmVtb3ZlQnJvYWRjYXN0TGlzdGVuZXI/OiAobTogc3RyaW5nLCBmOiAodTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZCB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICkuX19wcm90ZWN0ZWRfXztcbiAgICAgICAgICAgIGJ1cz8ucmVtb3ZlQnJvYWRjYXN0TGlzdGVuZXI/LihCUk9BRENBU1RfQ0hBTk5FTCwgc3RhdGUuYnJvYWRjYXN0SGFuZGxlcik7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgIH1cbiAgICAgICAgc3RhdGUuYnJvYWRjYXN0SGFuZGxlciA9IG51bGw7XG4gICAgfVxuICAgIHJlcG9ydFByb2JlKHsga2luZDogJ3BhdXNlZCcsIHNvdXJjZSB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcbiAgICBsaXN0ZW5lcnM6IHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIGBzaG93YCAvIGBoaWRlYCDlj6rmmK8qKuS8mOWMlioq77yI5YiH5Yiw5Yir55qEIHRhYiDml7bnnIHngrnova7or6LvvInvvIzkuI3mmK/lv4XpnIDnmoTvvJpcbiAgICAgICAgICog6L2u6K+i5ZyoIGByZWFkeWAvYG1vdW50YCDph4zlt7Lnu4/otbfmnaXkuobjgIJcbiAgICAgICAgICpcbiAgICAgICAgICog4pqgIOWunua1i++8iOS5n+aYr+i/measoeOAjOS4jea1geW8j+OAjeeahOagueWboO+8ie+8muWvuSoq57yW6L6R5Zmo5ZCv5Yqo5pe25oGi5aSN55qE5YGc6Z2g6Z2i5p2/KirvvIxcbiAgICAgICAgICog6L+Z5Lik5Liq6ZKp5a2Q5LiN5L+d6K+B5ZyoIGByZWFkeWAg5LmL5ZCO6Kem5Y+RIOKAlOKAlCDpgqPml7YgV2Vha01hcCDph4zov5jmsqHmnIkgc3RhdGXvvIxcbiAgICAgICAgICog6ICB5YaZ5rOV77yIYHVpQnlQYW5lbC5nZXQodGhpcyk/LnJlc3VtZSgpYO+8ieS8mioq6Z2Z6buY5LuA5LmI6YO95LiN5YGaKirjgIJcbiAgICAgICAgICog5omA5Lul6L+Z6YeM5Yqg5LqG5YWc5bqV77yaYHRoaXNgIOafpeS4jeWIsOaXtu+8jOiLpeWPquacieS4gOS4qumdouadv+WunuS+i+WwseS9nOeUqOWcqOWug+i6q+S4iuOAglxuICAgICAgICAgKi9cbiAgICAgICAgc2hvdyh0aGlzOiBvYmplY3QpIHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcmVzb2x2ZVN0YXRlKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlKSByZXN1bWUoc3RhdGUsICdzaG93Jyk7XG4gICAgICAgIH0sXG4gICAgICAgIGhpZGUodGhpczogb2JqZWN0KSB7XG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHJlc29sdmVTdGF0ZSh0aGlzKTtcbiAgICAgICAgICAgIGlmIChzdGF0ZSkgcGF1c2Uoc3RhdGUsICdoaWRlJyk7XG4gICAgICAgIH0sXG4gICAgfSxcblxuICAgIHRlbXBsYXRlOiByZWFkU3RhdGljKCd0ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSxcbiAgICBzdHlsZTogcmVhZFN0eWxlKCksXG5cbiAgICAvLyDimqAg5YWo6YOo5YWD57Sg5byV55So6YO95LuO6L+Z6YeM5ou/77yaYCRgIOeUsee8lui+keWZqOWcqOmdouadv+WtkOagkemHjOino+aekO+8jFxuICAgIC8vICAgIOiAjCBgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWRgIOWcqOi/meS4queOr+Wig+mHjOaLv+S4jeWIsO+8iOWunua1i+i/lOWbniBudWxs77yJ44CCXG4gICAgLy8gICAg6L+Z5Lu96KGo5LiO5paH5Lu26aG26YOoIFNFTEVDVE9SUyDmmK/lkIzkuIDku73plK7vvIhTRUxFQ1RPUlMg5piv55yf5rqQ77yM6L+Z6YeM5ZaC57uZ57yW6L6R5Zmo77yJ44CCXG4gICAgJDogU0VMRUNUT1JTLFxuXG4gICAgbWV0aG9kczoge30sXG5cbiAgICAvKipcbiAgICAgKiDpnaLmnb/mjILovb3lrozmiJDml7bnlLHnvJbovpHlmajosIPnlKjvvIgqKuS4jeaYryoqIGBtZXRob2RzYCDph4znmoTmlrnms5Ug4oCU4oCUIOe8lui+keWZqOWvueWug+WwseaYr+aMiemhtuWxgumSqeWtkOiwg+eahO+8jFxuICAgICAqIOaUvui/myBgbWV0aG9kc2Ag6YeM5rC46L+c5LiN5Lya6KKr6LCD5Yiw77yM5a6e5rWL6L+H77yJ44CCXG4gICAgICpcbiAgICAgKiDljIXkuIDlsYIgdHJ5L2NhdGNo77yaYG1vdW50YCDljYrot6/mipvplJnkvJoqKui/nuW4pioq5Lii5o6JIGB1aUJ5UGFuZWxgIOeahOeZu+iusO+8iOS6juaYryBgc2hvd2AvYGhpZGVgXG4gICAgICog5YWo5oiQ5LqG56m65pON5L2c77yM55eH54q25piv6Z2i5p2/55yL552A5pyJ44CB5YaF5a655rC46L+c5LiN5Yi35paw77yJ77yM6Iez5bCR5oqK6ZSZ5oql57uZ5Li76L+b56iL44CCXG4gICAgICovXG4gICAgcmVhZHkodGhpczogb2JqZWN0KSB7XG4gICAgICAgIGxldCBzdGF0ZTogVWlTdGF0ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHN0YXRlID0gbW91bnQodGhpcyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zdCBzdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyAoZXJyb3Iuc3RhY2sgPz8gZXJyb3IubWVzc2FnZSkgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW2RzaF9jaGF0XSDpnaLmnb/mjILovb3lpLHotKXvvJoke3N0YWNrfWApO1xuICAgICAgICAgICAgcmVwb3J0UHJvYmUoeyBraW5kOiAnbW91bnQtZXJyb3InLCBzdGFjazogc3RhY2suc2xpY2UoMCwgODAwKSB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB1aUJ5UGFuZWwuc2V0KHRoaXMsIHN0YXRlKTtcbiAgICAgICAgbGl2ZVN0YXRlcy5hZGQoc3RhdGUpO1xuICAgIH0sXG59KTtcbiJdfQ==