"use strict";
/**
 * 主进程侧的**真输入**：把一次鼠标点击 / 一串按键真发给编辑器里的那一页。
 *
 * ## 为什么要有这条路（"整屏交互只能人肉验收"是当前最大的盲区）
 *
 * `cocos_execute_code` 能改节点、`cocos_capture_view` 能看到画面，但**点不动**：
 * 按钮的 `onClick`、列表项的选中、拖拽排序、EditBox 的聚焦 —— 这些只有真事件才触发。
 * 于是"这个按钮点下去有没有反应"一直只能请人去点。
 *
 * 这条路补的就是它：`webContents.sendInputEvent()` 把事件交给 **Chromium 自己的输入管线**，
 * 页面收到的是**真事件**（和真人点没区别，经过命中测试、`pointer-events`、焦点那一套），
 * 而不是"悄悄调一下那个回调"。
 *
 * ## 坐标口径（**只此一处**，与 `capture.ts` 的表是同一套）
 *
 * | 量 | 单位 / 原点 |
 * |---|---|
 * | 场景脚本报来的节点矩形（`viewMetrics` 的 `node.rect`） | **页面 CSS 像素**，页面左上角 |
 * | `capturePage()` 抓到的图 | **DIP**（= CSS 像素） |
 * | `sendInputEvent({x, y})` | **目标 webContents 自己的坐标**（页面 CSS 像素，左上角） |
 *
 * 三行是同一个空间，所以「按投影算出来的点」**原样**发出去就是对的 —— 不乘 dpr、不加偏移。
 * ⚠ 这一条**没有官方文档背书**：Electron 的声明里 `x` / `y` 只写了 `number`，没有坐标系说明
 * （本机 `electron.d.ts` 全文搜过，未见）。所以真机第一次用要**点前后各截一张图**确认落点 ——
 * 静态推断只保证"我们发的是这个数"，保证不了"Chromium 把它落在哪"。
 *
 * ## ⚠ 窗口焦点：**不报告焦点就是假绿**
 *
 * Electron 的 `sendInputEvent` 声明里明写：
 * "The `BrowserWindow` containing the contents needs to be focused for `sendInputEvent()` to work."
 * 所以窗口没焦点时，"事件发出去了"与"页面收到了"是两件事。这里的做法：
 *
 * 1. 先**如实量**窗口有没有焦点，写进回执的 `window.focused`；
 * 2. 没焦点且调用方没关掉（`focusWindow:false`）时，把窗口提到前台，并写 `window.focusedByUs:true`；
 * 3. 做完仍然没焦点 → `window.note` 明说「这一下**可能没被送达**」，不假装成功。
 *
 * ## 这里刻意不做的事
 *
 * 不认识"节点"（那是场景脚本的事）、不判"点对了没有"（那是调用方的判据）、
 * **不抢网页内的键盘焦点**（`contents.focus()` 会把用户正在输入的地方顶掉；要抢得显式说）、不重试。
 * 它只干一件事：**如实发出这几个事件，并把"到底发了什么、当时什么状态"记下来**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TEXT_CHARS = void 0;
exports.clickAt = clickAt;
exports.sendKeys = sendKeys;
const capture_1 = require("./capture");
/**
 * 修饰键白名单 —— 只放行 Electron 认的那几个（拼错的直接报错，别静默丢掉）。
 *
 * 值与别名都取自 Electron 自己的声明（`InputEvent.modifiers`）：
 * `shift` / `control`(=`ctrl`) / `alt` / `meta`(=`command` / `cmd`)。
 * 别名在这里**归一成规范值**再发出去 —— 收下 `ctrl` 却原样发 `ctrl`（而不是 `control`）是另一回事，
 * 不如统一，回执里的 `events` 就永远是规范名。
 */
const MODIFIER_ALIASES = {
    shift: 'shift',
    control: 'control',
    ctrl: 'control',
    alt: 'alt',
    meta: 'meta',
    command: 'meta',
    cmd: 'meta',
};
/** 鼠标按键白名单。 */
const BUTTONS = ['left', 'right', 'middle'];
/** 一次 `text` 最多输入多少字（挡住"把一整份日志打进去"这种事故）。 */
exports.MAX_TEXT_CHARS = 200;
/** 默认按下时长（毫秒）：够 Chromium 合成一次「按下 → 抬起」，也不至于让调用方等太久。 */
const DEFAULT_PRESS_MS = 40;
function describe(error) {
    if (error instanceof Error)
        return error.message;
    if (error && typeof error === 'object') {
        const anyErr = error;
        if (typeof anyErr.message === 'string')
            return anyErr.message;
    }
    return String(error);
}
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.min(2000, ms)));
});
/** 夹一个整数（越界就夹，不给 NaN）。 */
function clampInt(value, min, max, fallback) {
    const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, raw));
}
/** 只留合法修饰键（别名归一）；有非法项时**抛错**（静默丢掉会让"我明明发了 ctrl"变成假话）。 */
function normalizeModifiers(raw) {
    if (raw === undefined || raw === null)
        return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const item of list) {
        const name = String(item).trim().toLowerCase();
        if (!name)
            continue;
        const canonical = MODIFIER_ALIASES[name];
        if (!canonical) {
            throw new Error(`修饰键只认 ${Object.keys(MODIFIER_ALIASES).join(' / ')}，收到 ${JSON.stringify(item)}`);
        }
        if (out.indexOf(canonical) < 0)
            out.push(canonical);
    }
    return out;
}
/** 键盘焦点（拿不到就是 null —— 不假装知道）。 */
function focusState(contents) {
    try {
        return typeof contents.isFocused === 'function' ? contents.isFocused() : null;
    }
    catch {
        return null;
    }
}
/**
 * 窗口焦点：**先如实量，必要时提到前台，再量一次**。
 *
 * 为什么要 `focus()` 而不是只报一句"没焦点就别发了"：这个工具的用途就是"帮我点一下"，
 * 而用户在编辑器里等结果时窗口本来就是前台；真正会踩的是**agent 在后台跑**那种情况 ——
 * 那时"点不动"会被误读成"这个按钮坏了"。所以默认提一次前台，但**一定写进回执**
 * （`focusedByUs: true`），并且默认可以被 `focusWindow:false` 关掉。
 */
function ensureWindowFocus(contents, allowFocus) {
    var _a;
    let win = null;
    try {
        win = contents.getOwnerBrowserWindow();
    }
    catch {
        win = null;
    }
    if (!win)
        return { id: null, focused: null, focusedByUs: false, note: '拿不到这一页所在的窗口（判不了窗口焦点）' };
    let focused = null;
    try {
        focused = typeof win.isFocused === 'function' ? win.isFocused() : null;
    }
    catch {
        focused = null;
    }
    let focusedByUs = false;
    if (focused === false && allowFocus) {
        try {
            if (typeof win.focus === 'function') {
                win.focus();
                focusedByUs = true;
                focused = typeof win.isFocused === 'function' ? win.isFocused() : null;
            }
        }
        catch {
            /* 提不上来就按原样报 */
        }
    }
    const out = { id: (_a = win.id) !== null && _a !== void 0 ? _a : null, focused, focusedByUs };
    if (focused === false) {
        out.note =
            '编辑器窗口当时**没有焦点** —— Electron 明说 `sendInputEvent` 需要窗口有焦点，所以这一下**可能根本没被送达**。' +
                '（`focusWindow:false` 是关掉自动提前台的那个开关；要确认生效，请点前后各截一张图对比。）';
    }
    return out;
}
/**
 * 在一个点按下并抬起（**真事件**）。
 *
 * @param x - 页面 CSS 像素（左上角原点）—— 与场景脚本报的节点矩形同一空间。
 * @param y - 同上。
 * @param options - 按键 / 连击 / 修饰键 / 按下时长。
 * @param href - 场景脚本报来的 `location.href`（首选判据，见 `capture.ts` 的 `findSceneView`）。
 * @returns 回执；`events` 是**真发出去的那几条**（按顺序）。
 */
async function clickAt(x, y, options = {}, href) {
    const events = [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: `点击坐标要都是有限数，收到 ${JSON.stringify(x)} / ${JSON.stringify(y)}`, events };
    }
    const button = options.button === undefined ? 'left' : String(options.button).toLowerCase();
    if (BUTTONS.indexOf(button) < 0) {
        return { ok: false, error: `button 只认 ${BUTTONS.join(' / ')}，收到 ${JSON.stringify(options.button)}`, events };
    }
    let modifiers;
    try {
        modifiers = normalizeModifiers(options.modifiers);
    }
    catch (err) {
        return { ok: false, error: describe(err), events };
    }
    const clickCount = clampInt(options.clickCount, 1, 3, 1);
    const pressMs = clampInt(options.pressMs, 0, 1000, DEFAULT_PRESS_MS);
    const hit = (0, capture_1.findSceneView)(href);
    if (!hit) {
        return {
            ok: false,
            error: '没有找到场景视图的 webContents（编辑器里可能还没有打开任何场景视图面板）。',
            events,
            contents: (0, capture_1.listContents)(),
        };
    }
    const contents = hit.contents;
    const px = Math.round(x);
    const py = Math.round(y);
    /** ⚠ 先处理窗口焦点（Electron 明说 `sendInputEvent` 需要窗口有焦点）—— 它决定这一下到底送不送得进去 */
    const window = ensureWindowFocus(contents, options.focusWindow !== false);
    /** 把一次事件发出去并记一笔 —— 记的是**真传下去的那个对象**，不是我们打算发的那个 */
    const send = (event) => {
        contents.sendInputEvent(event);
        const row = { type: event.type };
        const anyEvent = event;
        if (typeof anyEvent.x === 'number')
            row.x = anyEvent.x;
        if (typeof anyEvent.y === 'number')
            row.y = anyEvent.y;
        if (typeof anyEvent.button === 'string')
            row.button = anyEvent.button;
        if (typeof anyEvent.clickCount === 'number')
            row.clickCount = anyEvent.clickCount;
        if (typeof anyEvent.keyCode === 'string')
            row.keyCode = anyEvent.keyCode;
        if (Array.isArray(anyEvent.modifiers) && anyEvent.modifiers.length > 0)
            row.modifiers = anyEvent.modifiers;
        events.push(row);
        return row;
    };
    try {
        if (options.moveFirst !== false) {
            send({ type: 'mouseMove', x: px, y: py, modifiers });
        }
        for (let index = 1; index <= clickCount; index += 1) {
            send({ type: 'mouseDown', x: px, y: py, button, clickCount: index, modifiers });
            if (pressMs > 0)
                await sleep(pressMs);
            send({ type: 'mouseUp', x: px, y: py, button, clickCount: index, modifiers });
            if (index < clickCount && pressMs > 0)
                await sleep(pressMs);
        }
    }
    catch (err) {
        return {
            ok: false,
            error: `sendInputEvent 失败：${describe(err)}`,
            events,
            target: hit.info,
            matchedBy: hit.matchedBy,
            window,
            contents: (0, capture_1.listContents)(),
        };
    }
    return {
        ok: true,
        target: hit.info,
        matchedBy: hit.matchedBy,
        events,
        focused: focusState(contents),
        window,
    };
}
/**
 * 发一次键盘动作（**真事件**）。
 *
 * `key` 走 `keyDown` / `keyUp`（快捷键、方向键、Esc 这类"按一下"的动作）；
 * `text` 走 `char`（真的往输入框里打字）—— 两者是**两件事**，可以一起给。
 *
 * @param options - 见 {@link KeyOptions}。
 * @param href - 场景脚本报来的 `location.href`。
 * @returns 回执；`events` 是真发出去的那几条。
 */
async function sendKeys(options = {}, href) {
    const events = [];
    const key = typeof options.key === 'string' ? options.key.trim() : '';
    const text = typeof options.text === 'string' ? options.text : '';
    if (!key && !text) {
        return { ok: false, error: 'key 与 text 至少给一个（key = 按一下某个键；text = 输入一段字）', events };
    }
    if (text.length > exports.MAX_TEXT_CHARS) {
        return { ok: false, error: `text 最多 ${exports.MAX_TEXT_CHARS} 个字符，收到 ${text.length} 个`, events };
    }
    let modifiers;
    try {
        modifiers = normalizeModifiers(options.modifiers);
    }
    catch (err) {
        return { ok: false, error: describe(err), events };
    }
    const pressMs = clampInt(options.pressMs, 0, 1000, DEFAULT_PRESS_MS);
    const hit = (0, capture_1.findSceneView)(href);
    if (!hit) {
        return {
            ok: false,
            error: '没有找到场景视图的 webContents（编辑器里可能还没有打开任何场景视图面板）。',
            events,
            contents: (0, capture_1.listContents)(),
        };
    }
    const contents = hit.contents;
    /** 键盘同理：窗口没焦点时 `sendInputEvent` 不生效（Electron 的声明明写） */
    const window = ensureWindowFocus(contents, options.focusWindow !== false);
    const send = (event) => {
        contents.sendInputEvent(event);
        const row = { type: event.type };
        const anyEvent = event;
        if (typeof anyEvent.keyCode === 'string')
            row.keyCode = anyEvent.keyCode;
        if (Array.isArray(anyEvent.modifiers) && anyEvent.modifiers.length > 0)
            row.modifiers = anyEvent.modifiers;
        events.push(row);
    };
    try {
        if (key) {
            send({ type: 'keyDown', keyCode: key, modifiers });
            if (pressMs > 0)
                await sleep(pressMs);
            send({ type: 'keyUp', keyCode: key, modifiers });
        }
        /** `char` 不带修饰键：它表达的是"这个字符"，修饰键走 `keyDown` 那条 */
        for (const character of text) {
            send({ type: 'char', keyCode: character });
            if (pressMs > 0)
                await sleep(Math.min(pressMs, 20));
        }
    }
    catch (err) {
        return {
            ok: false,
            error: `sendInputEvent 失败：${describe(err)}`,
            events,
            target: hit.info,
            matchedBy: hit.matchedBy,
            window,
            contents: (0, capture_1.listContents)(),
        };
    }
    return {
        ok: true,
        target: hit.info,
        matchedBy: hit.matchedBy,
        events,
        focused: focusState(contents),
        window,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5wdXQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvaW5wdXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXlDRzs7O0FBb01ILDBCQXFGQztBQVlELDRCQXdFQztBQTFXRCx1Q0FBMEU7QUFtRTFFOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLGdCQUFnQixHQUEyQjtJQUM3QyxLQUFLLEVBQUUsT0FBTztJQUNkLE9BQU8sRUFBRSxTQUFTO0lBQ2xCLElBQUksRUFBRSxTQUFTO0lBQ2YsR0FBRyxFQUFFLEtBQUs7SUFDVixJQUFJLEVBQUUsTUFBTTtJQUNaLE9BQU8sRUFBRSxNQUFNO0lBQ2YsR0FBRyxFQUFFLE1BQU07Q0FDZCxDQUFDO0FBRUYsZUFBZTtBQUNmLE1BQU0sT0FBTyxHQUFHLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztBQUU1Qyw0Q0FBNEM7QUFDL0IsUUFBQSxjQUFjLEdBQUcsR0FBRyxDQUFDO0FBRWxDLHVEQUF1RDtBQUN2RCxNQUFNLGdCQUFnQixHQUFHLEVBQUUsQ0FBQztBQUU1QixTQUFTLFFBQVEsQ0FBQyxLQUFjO0lBQzVCLElBQUksS0FBSyxZQUFZLEtBQUs7UUFBRSxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUM7SUFDakQsSUFBSSxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDckMsTUFBTSxNQUFNLEdBQUcsS0FBOEIsQ0FBQztRQUM5QyxJQUFJLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRO1lBQUUsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDO0lBQ2xFLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsTUFBTSxLQUFLLEdBQUcsQ0FBQyxFQUFVLEVBQWlCLEVBQUUsQ0FDeEMsSUFBSSxPQUFPLENB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LElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBZ0IsQ0FBQyxDQUFDO1lBQ3pELElBQUksT0FBTyxHQUFHLENBQUM7Z0JBQUUsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUN4RCxDQUFDO0lBQ0wsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDWCxPQUFPO1lBQ0gsRUFBRSxFQUFFLEtBQUs7WUFDVCxLQUFLLEVBQUUscUJBQXFCLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFBRTtZQUMzQyxNQUFNO1lBQ04sTUFBTSxFQUFFLEdBQUcsQ0FBQyxJQUFJO1lBQ2hCLFNBQVMsRUFBRSxHQUFHLENBQUMsU0FBUztZQUN4QixNQUFNO1lBQ04sUUFBUSxFQUFFLElBQUEsc0JBQVksR0FBRTtTQUMzQixDQUFDO0lBQ04sQ0FBQztJQUVELE9BQU87UUFDSCxFQUFFLEVBQUUsSUFBSTtRQUNSLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSTtRQUNoQixTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVM7UUFDeEIsTUFBTTtRQUNOLE9BQU8sRUFBRSxVQUFVLENBQUMsUUFBUSxDQUFDO1FBQzdCLE1BQU07S0FDVCxDQUFDO0FBQ04sQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog5Li76L+b56iL5L6n55qEKirnnJ/ovpPlhaUqKu+8muaKiuS4gOasoem8oOagh+eCueWHuyAvIOS4gOS4suaMiemUruecn+WPkee7mee8lui+keWZqOmHjOeahOmCo+S4gOmhteOAglxuICpcbiAqICMjIOS4uuS7gOS5iOimgeaciei/meadoei3r++8iFwi5pW05bGP5Lqk5LqS5Y+q6IO95Lq66IKJ6aqM5pS2XCLmmK/lvZPliY3mnIDlpKfnmoTnm7LljLrvvIlcbiAqXG4gKiBgY29jb3NfZXhlY3V0ZV9jb2RlYCDog73mlLnoioLngrnjgIFgY29jb3NfY2FwdHVyZV92aWV3YCDog73nnIvliLDnlLvpnaLvvIzkvYYqKueCueS4jeWKqCoq77yaXG4gKiDmjInpkq7nmoQgYG9uQ2xpY2tg44CB5YiX6KGo6aG555qE6YCJ5Lit44CB5ouW5ou95o6S5bqP44CBRWRpdEJveCDnmoTogZrnhKYg4oCU4oCUIOi/meS6m+WPquacieecn+S6i+S7tuaJjeinpuWPkeOAglxuICog5LqO5pivXCLov5nkuKrmjInpkq7ngrnkuIvljrvmnInmsqHmnInlj43lupRcIuS4gOebtOWPquiDveivt+S6uuWOu+eCueOAglxuICpcbiAqIOi/meadoei3r+ihpeeahOWwseaYr+Wug++8mmB3ZWJDb250ZW50cy5zZW5kSW5wdXRFdmVudCgpYCDmiorkuovku7bkuqTnu5kgKipDaHJvbWl1bSDoh6rlt7HnmoTovpPlhaXnrqHnur8qKu+8jFxuICog6aG16Z2i5pS25Yiw55qE5pivKirnnJ/kuovku7YqKu+8iOWSjOecn+S6uueCueayoeWMuuWIq++8jOe7j+i/h+WRveS4rea1i+ivleOAgWBwb2ludGVyLWV2ZW50c2DjgIHnhKbngrnpgqPkuIDlpZfvvInvvIxcbiAqIOiAjOS4jeaYr1wi5oKE5oKE6LCD5LiA5LiL6YKj5Liq5Zue6LCDXCLjgIJcbiAqXG4gKiAjIyDlnZDmoIflj6PlvoTvvIgqKuWPquatpOS4gOWkhCoq77yM5LiOIGBjYXB0dXJlLnRzYCDnmoTooajmmK/lkIzkuIDlpZfvvIlcbiAqXG4gKiB8IOmHjyB8IOWNleS9jSAvIOWOn+eCuSB8XG4gKiB8LS0tfC0tLXxcbiAqIHwg5Zy65pmv6ISa5pys5oql5p2l55qE6IqC54K555+p5b2i77yIYHZpZXdNZXRyaWNzYCDnmoQgYG5vZGUucmVjdGDvvIkgfCAqKumhtemdoiBDU1Mg5YOP57SgKirvvIzpobXpnaLlt6bkuIrop5IgfFxuICogfCBgY2FwdHVyZVBhZ2UoKWAg5oqT5Yiw55qE5Zu+IHwgKipESVAqKu+8iD0gQ1NTIOWDj+e0oO+8iSB8XG4gKiB8IGBzZW5kSW5wdXRFdmVudCh7eCwgeX0pYCB8ICoq55uu5qCHIHdlYkNvbnRlbnRzIOiHquW3seeahOWdkOaghyoq77yI6aG16Z2iIENTUyDlg4/ntKDvvIzlt6bkuIrop5LvvIkgfFxuICpcbiAqIOS4ieihjOaYr+WQjOS4gOS4quepuumXtO+8jOaJgOS7peOAjOaMieaKleW9seeul+WHuuadpeeahOeCueOAjSoq5Y6f5qC3Kirlj5Hlh7rljrvlsLHmmK/lr7nnmoQg4oCU4oCUIOS4jeS5mCBkcHLjgIHkuI3liqDlgY/np7vjgIJcbiAqIOKaoCDov5nkuIDmnaEqKuayoeacieWumOaWueaWh+aho+iDjOS5pioq77yaRWxlY3Ryb24g55qE5aOw5piO6YeMIGB4YCAvIGB5YCDlj6rlhpnkuoYgYG51bWJlcmDvvIzmsqHmnInlnZDmoIfns7vor7TmmI5cbiAqIO+8iOacrOacuiBgZWxlY3Ryb24uZC50c2Ag5YWo5paH5pCc6L+H77yM5pyq6KeB77yJ44CC5omA5Lul55yf5py656ys5LiA5qyh55So6KaBKirngrnliY3lkI7lkITmiKrkuIDlvKDlm74qKuehruiupOiQveeCuSDigJTigJRcbiAqIOmdmeaAgeaOqOaWreWPquS/neivgVwi5oiR5Lus5Y+R55qE5piv6L+Z5Liq5pWwXCLvvIzkv53or4HkuI3kuoZcIkNocm9taXVtIOaKiuWug+iQveWcqOWTqlwi44CCXG4gKlxuICogIyMg4pqgIOeql+WPo+eEpueCue+8mioq5LiN5oql5ZGK54Sm54K55bCx5piv5YGH57u/KipcbiAqXG4gKiBFbGVjdHJvbiDnmoQgYHNlbmRJbnB1dEV2ZW50YCDlo7DmmI7ph4zmmI7lhpnvvJpcbiAqIFwiVGhlIGBCcm93c2VyV2luZG93YCBjb250YWluaW5nIHRoZSBjb250ZW50cyBuZWVkcyB0byBiZSBmb2N1c2VkIGZvciBgc2VuZElucHV0RXZlbnQoKWAgdG8gd29yay5cIlxuICog5omA5Lul56qX5Y+j5rKh54Sm54K55pe277yMXCLkuovku7blj5Hlh7rljrvkuoZcIuS4jlwi6aG16Z2i5pS25Yiw5LqGXCLmmK/kuKTku7bkuovjgILov5nph4znmoTlgZrms5XvvJpcbiAqXG4gKiAxLiDlhYgqKuWmguWunumHjyoq56qX5Y+j5pyJ5rKh5pyJ54Sm54K577yM5YaZ6L+b5Zue5omn55qEIGB3aW5kb3cuZm9jdXNlZGDvvJtcbiAqIDIuIOayoeeEpueCueS4lOiwg+eUqOaWueayoeWFs+aOie+8iGBmb2N1c1dpbmRvdzpmYWxzZWDvvInml7bvvIzmiornqpflj6Pmj5DliLDliY3lj7DvvIzlubblhpkgYHdpbmRvdy5mb2N1c2VkQnlVczp0cnVlYO+8m1xuICogMy4g5YGa5a6M5LuN54S25rKh54Sm54K5IOKGkiBgd2luZG93Lm5vdGVgIOaYjuivtOOAjOi/meS4gOS4iyoq5Y+v6IO95rKh6KKr6YCB6L6+KirjgI3vvIzkuI3lgYfoo4XmiJDlip/jgIJcbiAqXG4gKiAjIyDov5nph4zliLvmhI/kuI3lgZrnmoTkuotcbiAqXG4gKiDkuI3orqTor4ZcIuiKgueCuVwi77yI6YKj5piv5Zy65pmv6ISa5pys55qE5LqL77yJ44CB5LiN5YikXCLngrnlr7nkuobmsqHmnIlcIu+8iOmCo+aYr+iwg+eUqOaWueeahOWIpOaNru+8ieOAgVxuICogKirkuI3miqLnvZHpobXlhoXnmoTplK7nm5jnhKbngrkqKu+8iGBjb250ZW50cy5mb2N1cygpYCDkvJrmiornlKjmiLfmraPlnKjovpPlhaXnmoTlnLDmlrnpobbmjonvvJvopoHmiqLlvpfmmL7lvI/or7TvvInjgIHkuI3ph43or5XjgIJcbiAqIOWug+WPquW5suS4gOS7tuS6i++8mioq5aaC5a6e5Y+R5Ye66L+Z5Yeg5Liq5LqL5Lu277yM5bm25oqKXCLliLDlupXlj5Hkuobku4DkuYjjgIHlvZPml7bku4DkuYjnirbmgIFcIuiusOS4i+adpSoq44CCXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBJbnB1dEV2ZW50LCBXZWJDb250ZW50cyB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGZpbmRTY2VuZVZpZXcsIGxpc3RDb250ZW50cywgdHlwZSBDb250ZW50SW5mbyB9IGZyb20gJy4vY2FwdHVyZSc7XG5cbi8qKiDkuIDmrKHnnJ/lj5Hlh7rljrvnmoTkuovku7bvvIjlm57miafph4znu5nmqKHlnovnnIvnmoRcIuaIkeWIsOW6leWPkeS6huS7gOS5iFwi77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIFNlbnRFdmVudCB7XG4gICAgdHlwZTogc3RyaW5nO1xuICAgIHg/OiBudW1iZXI7XG4gICAgeT86IG51bWJlcjtcbiAgICBidXR0b24/OiBzdHJpbmc7XG4gICAgY2xpY2tDb3VudD86IG51bWJlcjtcbiAgICBrZXlDb2RlPzogc3RyaW5nO1xuICAgIG1vZGlmaWVycz86IHN0cmluZ1tdO1xufVxuXG4vKiog6L6T5YWl5Yqo5L2c55qE5Zue5omn77yI5aSx6LSl5Lmf5Zue77yM5LiN5oqb77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIElucHV0T3V0Y29tZSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgLyoqIOWksei0peWOn+WboO+8iOS6uuivne+8iSAqL1xuICAgIGVycm9yPzogc3RyaW5nO1xuICAgIC8qKiDmiZPliLDkuoblk6rkuIDpobUgKi9cbiAgICB0YXJnZXQ/OiBDb250ZW50SW5mbztcbiAgICAvKiog6Z2g5LuA5LmI6K6k5Ye655qE6YKj5LiA6aG177yIYGhyZWZgID0g5Zy65pmv6ISa5pys5oql55qE5Zyw5Z2A77yM5pyA56Gu5a6a77yJICovXG4gICAgbWF0Y2hlZEJ5Pzogc3RyaW5nO1xuICAgIC8qKiDnnJ/lj5Hlh7rljrvnmoTkuovku7bvvIjmjInpobrluo/vvIkgKi9cbiAgICBldmVudHM6IFNlbnRFdmVudFtdO1xuICAgIC8qKiDnm67moIfpobXlvZPliY3mnInmsqHmnIkqKumUruebmOeEpueCuSoq77yI5ou/5LiN5Yiw5bCx5pivIG51bGzvvJsqKuacrOaooeWdl+S4jeaKoue9kemhteWGheeahOeEpueCuSoq77yJICovXG4gICAgZm9jdXNlZD86IGJvb2xlYW4gfCBudWxsO1xuICAgIC8qKlxuICAgICAqIOijhei/meS4gOmhteeahOmCo+S4qioq56qX5Y+jKirnmoTnhKbngrnmg4XlhrXjgIJcbiAgICAgKlxuICAgICAqIOKaoCDlroPmmK9cIui/meS4gOS4i+WIsOW6lemAgeayoemAgei/m+WOu1wi55qEKirliY3mj5DmnaHku7YqKu+8iEVsZWN0cm9uIOeahOWjsOaYjumHjOaYjuWGmeimgeacieeql+WPo+eEpueCue+8ie+8mlxuICAgICAqIGBmb2N1c2VkOmZhbHNlYCArIOayoeaciSBgZm9jdXNlZEJ5VXNgIOKHkiDlm57miafph4znmoQgYG5vdGVgIOS8muebtOivtFwi5Y+v6IO95rKh6KKr6YCB6L6+XCLjgIJcbiAgICAgKi9cbiAgICB3aW5kb3c/OiB7IGlkOiBudW1iZXIgfCBudWxsOyBmb2N1c2VkOiBib29sZWFuIHwgbnVsbDsgZm9jdXNlZEJ5VXM6IGJvb2xlYW47IG5vdGU/OiBzdHJpbmcgfTtcbiAgICAvKiog5aSx6LSl5pe255qE546w5Zy677ya5b2T5pe25pyJ5ZOq5LqbIHdlYkNvbnRlbnRz77yI5omT6ZSZ56qX5Y+j5pe25ZSv5LiA5pyJ55So55qE6K+B5o2u77yJICovXG4gICAgY29udGVudHM/OiBDb250ZW50SW5mb1tdO1xufVxuXG4vKiog6byg5qCH5Yqo5L2c55qE5byA5YWz44CCICovXG5leHBvcnQgaW50ZXJmYWNlIENsaWNrT3B0aW9ucyB7XG4gICAgLyoqIOm7mOiupCBgbGVmdGAgKi9cbiAgICBidXR0b24/OiAnbGVmdCcgfCAncmlnaHQnIHwgJ21pZGRsZSc7XG4gICAgLyoqIOi/nuWHu+asoeaVsO+8mjIgPSDlj4zlh7vvvIjnrKzkuozmrKHmjInkuIvluKYgYGNsaWNrQ291bnQ6IDJg77yMQ2hyb21pdW0g5o2u5q2k5ZCI5oiQIGBkYmxjbGlja2DvvIkgKi9cbiAgICBjbGlja0NvdW50PzogbnVtYmVyO1xuICAgIC8qKiDkv67ppbDplK7vvIhgc2hpZnRgIC8gYGNvbnRyb2xgIC8gYGFsdGAgLyBgbWV0YWDvvIxgY3RybGAvYGNtZGAvYGNvbW1hbmRgIOaYr+WIq+WQje+8iSAqL1xuICAgIG1vZGlmaWVycz86IHN0cmluZ1tdO1xuICAgIC8qKiDmjInkuIvkuI7miqzotbfkuYvpl7TnrYnlpJrkuYXvvIjmr6vnp5LvvInigJTigJQg5pyJ5Lqb5o6n5Lu26KaB55yL5YiwXCLmjInkuItcIumCo+S4gOW4p+aJjeacieWPjemmiCAqL1xuICAgIHByZXNzTXM/OiBudW1iZXI7XG4gICAgLyoqIOWFiOWPkeS4gOasoSBgbW91c2VNb3ZlYCDliLDkvY3vvIjpu5jorqQgdHJ1Ze+8m+aCrOWBnOaAgS9yb2xsb3ZlciDpnaDlroPvvIkgKi9cbiAgICBtb3ZlRmlyc3Q/OiBib29sZWFuO1xuICAgIC8qKiDnqpflj6PmsqHnhKbngrnml7bmiorlroPmj5DliLDliY3lj7DvvIjpu5jorqQgdHJ1Ze+8ieOAgui/meaYryBgc2VuZElucHV0RXZlbnRgIOiDveeUn+aViOeahOWJjeaPkOOAgiAqL1xuICAgIGZvY3VzV2luZG93PzogYm9vbGVhbjtcbn1cblxuLyoqIOmUruebmOWKqOS9nO+8mmBrZXlg77yI5Y+R5oyJL+aKrO+8ieS4jiBgdGV4dGDvvIjpgJDlrZflj5EgYGNoYXJg77yJ5Y+v5Lul5LiA6LW357uZ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIEtleU9wdGlvbnMge1xuICAgIC8qKiBFbGVjdHJvbiDliqDpgJ/plK7lkI3vvJpgJ0EnYCAvIGAnRW50ZXInYCAvIGAnRXNjYXBlJ2AgLyBgJ1NwYWNlJ2AgLyBgJ0Y1J2Ag4oCmICovXG4gICAga2V5Pzogc3RyaW5nO1xuICAgIC8qKiDkv67ppbDplK7vvIjkuI7pvKDmoIflkIzkuIDlvKDor43ooajvvIkgKi9cbiAgICBtb2RpZmllcnM/OiBzdHJpbmdbXTtcbiAgICAvKiog6KaBKirovpPlhaUqKueahOaWh+Wtl++8iOmAkOWtl+WPkSBgY2hhcmDvvJvkuIrpmZDop4EgYE1BWF9URVhUX0NIQVJTYO+8iSAqL1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgLyoqIOavj+asoeaMieS4i+S4juaKrOi1t+S5i+mXtOetieWkmuS5he+8iOavq+enku+8iSAqL1xuICAgIHByZXNzTXM/OiBudW1iZXI7XG4gICAgLyoqIOeql+WPo+ayoeeEpueCueaXtuaKiuWug+aPkOWIsOWJjeWPsO+8iOm7mOiupCB0cnVl77yJ44CCICovXG4gICAgZm9jdXNXaW5kb3c/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIOS/rumlsOmUrueZveWQjeWNlSDigJTigJQg5Y+q5pS+6KGMIEVsZWN0cm9uIOiupOeahOmCo+WHoOS4qu+8iOaLvOmUmeeahOebtOaOpeaKpemUme+8jOWIq+mdmem7mOS4ouaOie+8ieOAglxuICpcbiAqIOWAvOS4juWIq+WQjemDveWPluiHqiBFbGVjdHJvbiDoh6rlt7HnmoTlo7DmmI7vvIhgSW5wdXRFdmVudC5tb2RpZmllcnNg77yJ77yaXG4gKiBgc2hpZnRgIC8gYGNvbnRyb2xgKD1gY3RybGApIC8gYGFsdGAgLyBgbWV0YWAoPWBjb21tYW5kYCAvIGBjbWRgKeOAglxuICog5Yir5ZCN5Zyo6L+Z6YeMKirlvZLkuIDmiJDop4TojIPlgLwqKuWGjeWPkeWHuuWOuyDigJTigJQg5pS25LiLIGBjdHJsYCDljbTljp/moLflj5EgYGN0cmxg77yI6ICM5LiN5pivIGBjb250cm9sYO+8ieaYr+WPpuS4gOWbnuS6i++8jFxuICog5LiN5aaC57uf5LiA77yM5Zue5omn6YeM55qEIGBldmVudHNgIOWwseawuOi/nOaYr+inhOiMg+WQjeOAglxuICovXG5jb25zdCBNT0RJRklFUl9BTElBU0VTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIHNoaWZ0OiAnc2hpZnQnLFxuICAgIGNvbnRyb2w6ICdjb250cm9sJyxcbiAgICBjdHJsOiAnY29udHJvbCcsXG4gICAgYWx0OiAnYWx0JyxcbiAgICBtZXRhOiAnbWV0YScsXG4gICAgY29tbWFuZDogJ21ldGEnLFxuICAgIGNtZDogJ21ldGEnLFxufTtcblxuLyoqIOm8oOagh+aMiemUrueZveWQjeWNleOAgiAqL1xuY29uc3QgQlVUVE9OUyA9IFsnbGVmdCcsICdyaWdodCcsICdtaWRkbGUnXTtcblxuLyoqIOS4gOasoSBgdGV4dGAg5pyA5aSa6L6T5YWl5aSa5bCR5a2X77yI5oyh5L2PXCLmiorkuIDmlbTku73ml6Xlv5fmiZPov5vljrtcIui/meenjeS6i+aVhe+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9URVhUX0NIQVJTID0gMjAwO1xuXG4vKiog6buY6K6k5oyJ5LiL5pe26ZW/77yI5q+r56eS77yJ77ya5aSfIENocm9taXVtIOWQiOaIkOS4gOasoeOAjOaMieS4iyDihpIg5oqs6LW344CN77yM5Lmf5LiN6Iez5LqO6K6p6LCD55So5pa5562J5aSq5LmF44CCICovXG5jb25zdCBERUZBVUxUX1BSRVNTX01TID0gNDA7XG5cbmZ1bmN0aW9uIGRlc2NyaWJlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XG4gICAgaWYgKGVycm9yICYmIHR5cGVvZiBlcnJvciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3QgYW55RXJyID0gZXJyb3IgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9O1xuICAgICAgICBpZiAodHlwZW9mIGFueUVyci5tZXNzYWdlID09PSAnc3RyaW5nJykgcmV0dXJuIGFueUVyci5tZXNzYWdlO1xuICAgIH1cbiAgICByZXR1cm4gU3RyaW5nKGVycm9yKTtcbn1cblxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBzZXRUaW1lb3V0KHJlc29sdmUsIE1hdGgubWF4KDAsIE1hdGgubWluKDIwMDAsIG1zKSkpO1xuICAgIH0pO1xuXG4vKiog5aS55LiA5Liq5pW05pWw77yI6LaK55WM5bCx5aS577yM5LiN57uZIE5hTu+8ieOAgiAqL1xuZnVuY3Rpb24gY2xhbXBJbnQodmFsdWU6IHVua25vd24sIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlciwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC50cnVuYyh2YWx1ZSkgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIHJhdykpO1xufVxuXG4vKiog5Y+q55WZ5ZCI5rOV5L+u6aWw6ZSu77yI5Yir5ZCN5b2S5LiA77yJ77yb5pyJ6Z2e5rOV6aG55pe2KirmipvplJkqKu+8iOmdmem7mOS4ouaOieS8muiuqVwi5oiR5piO5piO5Y+R5LqGIGN0cmxcIuWPmOaIkOWBh+ivne+8ieOAgiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplTW9kaWZpZXJzKHJhdzogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsKSByZXR1cm4gW107XG4gICAgY29uc3QgbGlzdCA9IEFycmF5LmlzQXJyYXkocmF3KSA/IHJhdyA6IFtyYXddO1xuICAgIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgbGlzdCkge1xuICAgICAgICBjb25zdCBuYW1lID0gU3RyaW5nKGl0ZW0pLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBpZiAoIW5hbWUpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBjYW5vbmljYWwgPSBNT0RJRklFUl9BTElBU0VTW25hbWVdO1xuICAgICAgICBpZiAoIWNhbm9uaWNhbCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDkv67ppbDplK7lj6rorqQgJHtPYmplY3Qua2V5cyhNT0RJRklFUl9BTElBU0VTKS5qb2luKCcgLyAnKX3vvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShpdGVtKX1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3V0LmluZGV4T2YoY2Fub25pY2FsKSA8IDApIG91dC5wdXNoKGNhbm9uaWNhbCk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDplK7nm5jnhKbngrnvvIjmi7/kuI3liLDlsLHmmK8gbnVsbCDigJTigJQg5LiN5YGH6KOF55+l6YGT77yJ44CCICovXG5mdW5jdGlvbiBmb2N1c1N0YXRlKGNvbnRlbnRzOiBXZWJDb250ZW50cyk6IGJvb2xlYW4gfCBudWxsIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gdHlwZW9mIGNvbnRlbnRzLmlzRm9jdXNlZCA9PT0gJ2Z1bmN0aW9uJyA/IGNvbnRlbnRzLmlzRm9jdXNlZCgpIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vKipcbiAqIOeql+WPo+eEpueCue+8mioq5YWI5aaC5a6e6YeP77yM5b+F6KaB5pe25o+Q5Yiw5YmN5Y+w77yM5YaN6YeP5LiA5qyhKirjgIJcbiAqXG4gKiDkuLrku4DkuYjopoEgYGZvY3VzKClgIOiAjOS4jeaYr+WPquaKpeS4gOWPpVwi5rKh54Sm54K55bCx5Yir5Y+R5LqGXCLvvJrov5nkuKrlt6XlhbfnmoTnlKjpgJTlsLHmmK9cIuW4ruaIkeeCueS4gOS4i1wi77yMXG4gKiDogIznlKjmiLflnKjnvJbovpHlmajph4znrYnnu5Pmnpzml7bnqpflj6PmnKzmnaXlsLHmmK/liY3lj7DvvJvnnJ/mraPkvJrouKnnmoTmmK8qKmFnZW50IOWcqOWQjuWPsOi3kSoq6YKj56eN5oOF5Ya1IOKAlOKAlFxuICog6YKj5pe2XCLngrnkuI3liqhcIuS8muiiq+ivr+ivu+aIkFwi6L+Z5Liq5oyJ6ZKu5Z2P5LqGXCLjgILmiYDku6Xpu5jorqTmj5DkuIDmrKHliY3lj7DvvIzkvYYqKuS4gOWumuWGmei/m+WbnuaJpyoqXG4gKiDvvIhgZm9jdXNlZEJ5VXM6IHRydWVg77yJ77yM5bm25LiU6buY6K6k5Y+v5Lul6KKrIGBmb2N1c1dpbmRvdzpmYWxzZWAg5YWz5o6J44CCXG4gKi9cbmZ1bmN0aW9uIGVuc3VyZVdpbmRvd0ZvY3VzKGNvbnRlbnRzOiBXZWJDb250ZW50cywgYWxsb3dGb2N1czogYm9vbGVhbik6IE5vbk51bGxhYmxlPElucHV0T3V0Y29tZVsnd2luZG93J10+IHtcbiAgICBsZXQgd2luOiBSZXR1cm5UeXBlPFdlYkNvbnRlbnRzWydnZXRPd25lckJyb3dzZXJXaW5kb3cnXT4gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIHdpbiA9IGNvbnRlbnRzLmdldE93bmVyQnJvd3NlcldpbmRvdygpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICB3aW4gPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXdpbikgcmV0dXJuIHsgaWQ6IG51bGwsIGZvY3VzZWQ6IG51bGwsIGZvY3VzZWRCeVVzOiBmYWxzZSwgbm90ZTogJ+aLv+S4jeWIsOi/meS4gOmhteaJgOWcqOeahOeql+WPo++8iOWIpOS4jeS6hueql+WPo+eEpueCue+8iScgfTtcblxuICAgIGxldCBmb2N1c2VkOiBib29sZWFuIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgZm9jdXNlZCA9IHR5cGVvZiB3aW4uaXNGb2N1c2VkID09PSAnZnVuY3Rpb24nID8gd2luLmlzRm9jdXNlZCgpIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgZm9jdXNlZCA9IG51bGw7XG4gICAgfVxuICAgIGxldCBmb2N1c2VkQnlVcyA9IGZhbHNlO1xuICAgIGlmIChmb2N1c2VkID09PSBmYWxzZSAmJiBhbGxvd0ZvY3VzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHdpbi5mb2N1cyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIHdpbi5mb2N1cygpO1xuICAgICAgICAgICAgICAgIGZvY3VzZWRCeVVzID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBmb2N1c2VkID0gdHlwZW9mIHdpbi5pc0ZvY3VzZWQgPT09ICdmdW5jdGlvbicgPyB3aW4uaXNGb2N1c2VkKCkgOiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOaPkOS4jeS4iuadpeWwseaMieWOn+agt+aKpSAqL1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG91dDogTm9uTnVsbGFibGU8SW5wdXRPdXRjb21lWyd3aW5kb3cnXT4gPSB7IGlkOiB3aW4uaWQgPz8gbnVsbCwgZm9jdXNlZCwgZm9jdXNlZEJ5VXMgfTtcbiAgICBpZiAoZm9jdXNlZCA9PT0gZmFsc2UpIHtcbiAgICAgICAgb3V0Lm5vdGUgPVxuICAgICAgICAgICAgJ+e8lui+keWZqOeql+WPo+W9k+aXtioq5rKh5pyJ54Sm54K5Kiog4oCU4oCUIEVsZWN0cm9uIOaYjuivtCBgc2VuZElucHV0RXZlbnRgIOmcgOimgeeql+WPo+acieeEpueCue+8jOaJgOS7pei/meS4gOS4iyoq5Y+v6IO95qC55pys5rKh6KKr6YCB6L6+KirjgIInICtcbiAgICAgICAgICAgICfvvIhgZm9jdXNXaW5kb3c6ZmFsc2VgIOaYr+WFs+aOieiHquWKqOaPkOWJjeWPsOeahOmCo+S4quW8gOWFs++8m+imgeehruiupOeUn+aViO+8jOivt+eCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlOOAgu+8iSc7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog5Zyo5LiA5Liq54K55oyJ5LiL5bm25oqs6LW377yIKirnnJ/kuovku7YqKu+8ieOAglxuICpcbiAqIEBwYXJhbSB4IC0g6aG16Z2iIENTUyDlg4/ntKDvvIjlt6bkuIrop5Lljp/ngrnvvInigJTigJQg5LiO5Zy65pmv6ISa5pys5oql55qE6IqC54K555+p5b2i5ZCM5LiA56m66Ze044CCXG4gKiBAcGFyYW0geSAtIOWQjOS4iuOAglxuICogQHBhcmFtIG9wdGlvbnMgLSDmjInplK4gLyDov57lh7sgLyDkv67ppbDplK4gLyDmjInkuIvml7bplb/jgIJcbiAqIEBwYXJhbSBocmVmIC0g5Zy65pmv6ISa5pys5oql5p2l55qEIGBsb2NhdGlvbi5ocmVmYO+8iOmmlumAieWIpOaNru+8jOingSBgY2FwdHVyZS50c2Ag55qEIGBmaW5kU2NlbmVWaWV3YO+8ieOAglxuICogQHJldHVybnMg5Zue5omn77ybYGV2ZW50c2Ag5pivKirnnJ/lj5Hlh7rljrvnmoTpgqPlh6DmnaEqKu+8iOaMiemhuuW6j++8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xpY2tBdChcbiAgICB4OiBudW1iZXIsXG4gICAgeTogbnVtYmVyLFxuICAgIG9wdGlvbnM6IENsaWNrT3B0aW9ucyA9IHt9LFxuICAgIGhyZWY/OiBzdHJpbmcsXG4pOiBQcm9taXNlPElucHV0T3V0Y29tZT4ge1xuICAgIGNvbnN0IGV2ZW50czogU2VudEV2ZW50W10gPSBbXTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh4KSB8fCAhTnVtYmVyLmlzRmluaXRlKHkpKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDngrnlh7vlnZDmoIfopoHpg73mmK/mnInpmZDmlbDvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeSh4KX0gLyAke0pTT04uc3RyaW5naWZ5KHkpfWAsIGV2ZW50cyB9O1xuICAgIH1cblxuICAgIGNvbnN0IGJ1dHRvbiA9IG9wdGlvbnMuYnV0dG9uID09PSB1bmRlZmluZWQgPyAnbGVmdCcgOiBTdHJpbmcob3B0aW9ucy5idXR0b24pLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKEJVVFRPTlMuaW5kZXhPZihidXR0b24pIDwgMCkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgYnV0dG9uIOWPquiupCAke0JVVFRPTlMuam9pbignIC8gJyl977yM5pS25YiwICR7SlNPTi5zdHJpbmdpZnkob3B0aW9ucy5idXR0b24pfWAsIGV2ZW50cyB9O1xuICAgIH1cbiAgICBsZXQgbW9kaWZpZXJzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgICBtb2RpZmllcnMgPSBub3JtYWxpemVNb2RpZmllcnMob3B0aW9ucy5tb2RpZmllcnMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnIpLCBldmVudHMgfTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGlja0NvdW50ID0gY2xhbXBJbnQob3B0aW9ucy5jbGlja0NvdW50LCAxLCAzLCAxKTtcbiAgICBjb25zdCBwcmVzc01zID0gY2xhbXBJbnQob3B0aW9ucy5wcmVzc01zLCAwLCAxMDAwLCBERUZBVUxUX1BSRVNTX01TKTtcblxuICAgIGNvbnN0IGhpdCA9IGZpbmRTY2VuZVZpZXcoaHJlZik7XG4gICAgaWYgKCFoaXQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiAn5rKh5pyJ5om+5Yiw5Zy65pmv6KeG5Zu+55qEIHdlYkNvbnRlbnRz77yI57yW6L6R5Zmo6YeM5Y+v6IO96L+Y5rKh5pyJ5omT5byA5Lu75L2V5Zy65pmv6KeG5Zu+6Z2i5p2/77yJ44CCJyxcbiAgICAgICAgICAgIGV2ZW50cyxcbiAgICAgICAgICAgIGNvbnRlbnRzOiBsaXN0Q29udGVudHMoKSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50cyA9IGhpdC5jb250ZW50cztcbiAgICBjb25zdCBweCA9IE1hdGgucm91bmQoeCk7XG4gICAgY29uc3QgcHkgPSBNYXRoLnJvdW5kKHkpO1xuICAgIC8qKiDimqAg5YWI5aSE55CG56qX5Y+j54Sm54K577yIRWxlY3Ryb24g5piO6K+0IGBzZW5kSW5wdXRFdmVudGAg6ZyA6KaB56qX5Y+j5pyJ54Sm54K577yJ4oCU4oCUIOWug+WGs+Wumui/meS4gOS4i+WIsOW6lemAgeS4jemAgeW+l+i/m+WOuyAqL1xuICAgIGNvbnN0IHdpbmRvdyA9IGVuc3VyZVdpbmRvd0ZvY3VzKGNvbnRlbnRzLCBvcHRpb25zLmZvY3VzV2luZG93ICE9PSBmYWxzZSk7XG4gICAgLyoqIOaKiuS4gOasoeS6i+S7tuWPkeWHuuWOu+W5tuiusOS4gOeslCDigJTigJQg6K6w55qE5pivKirnnJ/kvKDkuIvljrvnmoTpgqPkuKrlr7nosaEqKu+8jOS4jeaYr+aIkeS7rOaJk+eul+WPkeeahOmCo+S4qiAqL1xuICAgIGNvbnN0IHNlbmQgPSAoZXZlbnQ6IElucHV0RXZlbnQgJiB7IHR5cGU6IHN0cmluZyB9KTogU2VudEV2ZW50ID0+IHtcbiAgICAgICAgY29udGVudHMuc2VuZElucHV0RXZlbnQoZXZlbnQpO1xuICAgICAgICBjb25zdCByb3c6IFNlbnRFdmVudCA9IHsgdHlwZTogZXZlbnQudHlwZSB9O1xuICAgICAgICBjb25zdCBhbnlFdmVudCA9IGV2ZW50IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXZlbnQueCA9PT0gJ251bWJlcicpIHJvdy54ID0gYW55RXZlbnQueDtcbiAgICAgICAgaWYgKHR5cGVvZiBhbnlFdmVudC55ID09PSAnbnVtYmVyJykgcm93LnkgPSBhbnlFdmVudC55O1xuICAgICAgICBpZiAodHlwZW9mIGFueUV2ZW50LmJ1dHRvbiA9PT0gJ3N0cmluZycpIHJvdy5idXR0b24gPSBhbnlFdmVudC5idXR0b247XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXZlbnQuY2xpY2tDb3VudCA9PT0gJ251bWJlcicpIHJvdy5jbGlja0NvdW50ID0gYW55RXZlbnQuY2xpY2tDb3VudDtcbiAgICAgICAgaWYgKHR5cGVvZiBhbnlFdmVudC5rZXlDb2RlID09PSAnc3RyaW5nJykgcm93LmtleUNvZGUgPSBhbnlFdmVudC5rZXlDb2RlO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShhbnlFdmVudC5tb2RpZmllcnMpICYmIGFueUV2ZW50Lm1vZGlmaWVycy5sZW5ndGggPiAwKSByb3cubW9kaWZpZXJzID0gYW55RXZlbnQubW9kaWZpZXJzIGFzIHN0cmluZ1tdO1xuICAgICAgICBldmVudHMucHVzaChyb3cpO1xuICAgICAgICByZXR1cm4gcm93O1xuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgICBpZiAob3B0aW9ucy5tb3ZlRmlyc3QgIT09IGZhbHNlKSB7XG4gICAgICAgICAgICBzZW5kKHsgdHlwZTogJ21vdXNlTW92ZScsIHg6IHB4LCB5OiBweSwgbW9kaWZpZXJzIH0gYXMgSW5wdXRFdmVudCk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAxOyBpbmRleCA8PSBjbGlja0NvdW50OyBpbmRleCArPSAxKSB7XG4gICAgICAgICAgICBzZW5kKHsgdHlwZTogJ21vdXNlRG93bicsIHg6IHB4LCB5OiBweSwgYnV0dG9uLCBjbGlja0NvdW50OiBpbmRleCwgbW9kaWZpZXJzIH0gYXMgSW5wdXRFdmVudCk7XG4gICAgICAgICAgICBpZiAocHJlc3NNcyA+IDApIGF3YWl0IHNsZWVwKHByZXNzTXMpO1xuICAgICAgICAgICAgc2VuZCh7IHR5cGU6ICdtb3VzZVVwJywgeDogcHgsIHk6IHB5LCBidXR0b24sIGNsaWNrQ291bnQ6IGluZGV4LCBtb2RpZmllcnMgfSBhcyBJbnB1dEV2ZW50KTtcbiAgICAgICAgICAgIGlmIChpbmRleCA8IGNsaWNrQ291bnQgJiYgcHJlc3NNcyA+IDApIGF3YWl0IHNsZWVwKHByZXNzTXMpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogYHNlbmRJbnB1dEV2ZW50IOWksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLFxuICAgICAgICAgICAgZXZlbnRzLFxuICAgICAgICAgICAgdGFyZ2V0OiBoaXQuaW5mbyxcbiAgICAgICAgICAgIG1hdGNoZWRCeTogaGl0Lm1hdGNoZWRCeSxcbiAgICAgICAgICAgIHdpbmRvdyxcbiAgICAgICAgICAgIGNvbnRlbnRzOiBsaXN0Q29udGVudHMoKSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdGFyZ2V0OiBoaXQuaW5mbyxcbiAgICAgICAgbWF0Y2hlZEJ5OiBoaXQubWF0Y2hlZEJ5LFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGZvY3VzZWQ6IGZvY3VzU3RhdGUoY29udGVudHMpLFxuICAgICAgICB3aW5kb3csXG4gICAgfTtcbn1cblxuLyoqXG4gKiDlj5HkuIDmrKHplK7nm5jliqjkvZzvvIgqKuecn+S6i+S7tioq77yJ44CCXG4gKlxuICogYGtleWAg6LWwIGBrZXlEb3duYCAvIGBrZXlVcGDvvIjlv6vmjbfplK7jgIHmlrnlkJHplK7jgIFFc2Mg6L+Z57G7XCLmjInkuIDkuItcIueahOWKqOS9nO+8ie+8m1xuICogYHRleHRgIOi1sCBgY2hhcmDvvIjnnJ/nmoTlvoDovpPlhaXmoYbph4zmiZPlrZfvvInigJTigJQg5Lik6ICF5pivKirkuKTku7bkuosqKu+8jOWPr+S7peS4gOi1t+e7meOAglxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0g6KeBIHtAbGluayBLZXlPcHRpb25zfeOAglxuICogQHBhcmFtIGhyZWYgLSDlnLrmma/ohJrmnKzmiqXmnaXnmoQgYGxvY2F0aW9uLmhyZWZg44CCXG4gKiBAcmV0dXJucyDlm57miafvvJtgZXZlbnRzYCDmmK/nnJ/lj5Hlh7rljrvnmoTpgqPlh6DmnaHjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlbmRLZXlzKG9wdGlvbnM6IEtleU9wdGlvbnMgPSB7fSwgaHJlZj86IHN0cmluZyk6IFByb21pc2U8SW5wdXRPdXRjb21lPiB7XG4gICAgY29uc3QgZXZlbnRzOiBTZW50RXZlbnRbXSA9IFtdO1xuICAgIGNvbnN0IGtleSA9IHR5cGVvZiBvcHRpb25zLmtleSA9PT0gJ3N0cmluZycgPyBvcHRpb25zLmtleS50cmltKCkgOiAnJztcbiAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIG9wdGlvbnMudGV4dCA9PT0gJ3N0cmluZycgPyBvcHRpb25zLnRleHQgOiAnJztcbiAgICBpZiAoIWtleSAmJiAhdGV4dCkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAna2V5IOS4jiB0ZXh0IOiHs+Wwkee7meS4gOS4qu+8iGtleSA9IOaMieS4gOS4i+afkOS4qumUru+8m3RleHQgPSDovpPlhaXkuIDmrrXlrZfvvIknLCBldmVudHMgfTtcbiAgICB9XG4gICAgaWYgKHRleHQubGVuZ3RoID4gTUFYX1RFWFRfQ0hBUlMpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYHRleHQg5pyA5aSaICR7TUFYX1RFWFRfQ0hBUlN9IOS4quWtl+espu+8jOaUtuWIsCAke3RleHQubGVuZ3RofSDkuKpgLCBldmVudHMgfTtcbiAgICB9XG5cbiAgICBsZXQgbW9kaWZpZXJzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgICBtb2RpZmllcnMgPSBub3JtYWxpemVNb2RpZmllcnMob3B0aW9ucy5tb2RpZmllcnMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnIpLCBldmVudHMgfTtcbiAgICB9XG4gICAgY29uc3QgcHJlc3NNcyA9IGNsYW1wSW50KG9wdGlvbnMucHJlc3NNcywgMCwgMTAwMCwgREVGQVVMVF9QUkVTU19NUyk7XG5cbiAgICBjb25zdCBoaXQgPSBmaW5kU2NlbmVWaWV3KGhyZWYpO1xuICAgIGlmICghaGl0KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogJ+ayoeacieaJvuWIsOWcuuaZr+inhuWbvueahCB3ZWJDb250ZW50c++8iOe8lui+keWZqOmHjOWPr+iDvei/mOayoeacieaJk+W8gOS7u+S9leWcuuaZr+inhuWbvumdouadv++8ieOAgicsXG4gICAgICAgICAgICBldmVudHMsXG4gICAgICAgICAgICBjb250ZW50czogbGlzdENvbnRlbnRzKCksXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgY29udGVudHMgPSBoaXQuY29udGVudHM7XG4gICAgLyoqIOmUruebmOWQjOeQhu+8mueql+WPo+ayoeeEpueCueaXtiBgc2VuZElucHV0RXZlbnRgIOS4jeeUn+aViO+8iEVsZWN0cm9uIOeahOWjsOaYjuaYjuWGme+8iSAqL1xuICAgIGNvbnN0IHdpbmRvdyA9IGVuc3VyZVdpbmRvd0ZvY3VzKGNvbnRlbnRzLCBvcHRpb25zLmZvY3VzV2luZG93ICE9PSBmYWxzZSk7XG4gICAgY29uc3Qgc2VuZCA9IChldmVudDogSW5wdXRFdmVudCAmIHsgdHlwZTogc3RyaW5nIH0pOiB2b2lkID0+IHtcbiAgICAgICAgY29udGVudHMuc2VuZElucHV0RXZlbnQoZXZlbnQpO1xuICAgICAgICBjb25zdCByb3c6IFNlbnRFdmVudCA9IHsgdHlwZTogZXZlbnQudHlwZSB9O1xuICAgICAgICBjb25zdCBhbnlFdmVudCA9IGV2ZW50IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXZlbnQua2V5Q29kZSA9PT0gJ3N0cmluZycpIHJvdy5rZXlDb2RlID0gYW55RXZlbnQua2V5Q29kZTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoYW55RXZlbnQubW9kaWZpZXJzKSAmJiBhbnlFdmVudC5tb2RpZmllcnMubGVuZ3RoID4gMCkgcm93Lm1vZGlmaWVycyA9IGFueUV2ZW50Lm1vZGlmaWVycyBhcyBzdHJpbmdbXTtcbiAgICAgICAgZXZlbnRzLnB1c2gocm93KTtcbiAgICB9O1xuXG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgc2VuZCh7IHR5cGU6ICdrZXlEb3duJywga2V5Q29kZToga2V5LCBtb2RpZmllcnMgfSBhcyBJbnB1dEV2ZW50KTtcbiAgICAgICAgICAgIGlmIChwcmVzc01zID4gMCkgYXdhaXQgc2xlZXAocHJlc3NNcyk7XG4gICAgICAgICAgICBzZW5kKHsgdHlwZTogJ2tleVVwJywga2V5Q29kZToga2V5LCBtb2RpZmllcnMgfSBhcyBJbnB1dEV2ZW50KTtcbiAgICAgICAgfVxuICAgICAgICAvKiogYGNoYXJgIOS4jeW4puS/rumlsOmUru+8muWug+ihqOi+vueahOaYr1wi6L+Z5Liq5a2X56ymXCLvvIzkv67ppbDplK7otbAgYGtleURvd25gIOmCo+adoSAqL1xuICAgICAgICBmb3IgKGNvbnN0IGNoYXJhY3RlciBvZiB0ZXh0KSB7XG4gICAgICAgICAgICBzZW5kKHsgdHlwZTogJ2NoYXInLCBrZXlDb2RlOiBjaGFyYWN0ZXIgfSBhcyBJbnB1dEV2ZW50KTtcbiAgICAgICAgICAgIGlmIChwcmVzc01zID4gMCkgYXdhaXQgc2xlZXAoTWF0aC5taW4ocHJlc3NNcywgMjApKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGBzZW5kSW5wdXRFdmVudCDlpLHotKXvvJoke2Rlc2NyaWJlKGVycil9YCxcbiAgICAgICAgICAgIGV2ZW50cyxcbiAgICAgICAgICAgIHRhcmdldDogaGl0LmluZm8sXG4gICAgICAgICAgICBtYXRjaGVkQnk6IGhpdC5tYXRjaGVkQnksXG4gICAgICAgICAgICB3aW5kb3csXG4gICAgICAgICAgICBjb250ZW50czogbGlzdENvbnRlbnRzKCksXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHRhcmdldDogaGl0LmluZm8sXG4gICAgICAgIG1hdGNoZWRCeTogaGl0Lm1hdGNoZWRCeSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBmb2N1c2VkOiBmb2N1c1N0YXRlKGNvbnRlbnRzKSxcbiAgICAgICAgd2luZG93LFxuICAgIH07XG59XG4iXX0=