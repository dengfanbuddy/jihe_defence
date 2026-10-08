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

import type { InputEvent, WebContents } from 'electron';
import { findSceneView, listContents, type ContentInfo } from './capture';

/** 一次真发出去的事件（回执里给模型看的"我到底发了什么"）。 */
export interface SentEvent {
    type: string;
    x?: number;
    y?: number;
    button?: string;
    clickCount?: number;
    keyCode?: string;
    modifiers?: string[];
}

/** 输入动作的回执（失败也回，不抛）。 */
export interface InputOutcome {
    ok: boolean;
    /** 失败原因（人话） */
    error?: string;
    /** 打到了哪一页 */
    target?: ContentInfo;
    /** 靠什么认出的那一页（`href` = 场景脚本报的地址，最确定） */
    matchedBy?: string;
    /** 真发出去的事件（按顺序） */
    events: SentEvent[];
    /** 目标页当前有没有**键盘焦点**（拿不到就是 null；**本模块不抢网页内的焦点**） */
    focused?: boolean | null;
    /**
     * 装这一页的那个**窗口**的焦点情况。
     *
     * ⚠ 它是"这一下到底送没送进去"的**前提条件**（Electron 的声明里明写要有窗口焦点）：
     * `focused:false` + 没有 `focusedByUs` ⇒ 回执里的 `note` 会直说"可能没被送达"。
     */
    window?: { id: number | null; focused: boolean | null; focusedByUs: boolean; note?: string };
    /** 失败时的现场：当时有哪些 webContents（打错窗口时唯一有用的证据） */
    contents?: ContentInfo[];
}

/** 鼠标动作的开关。 */
export interface ClickOptions {
    /** 默认 `left` */
    button?: 'left' | 'right' | 'middle';
    /** 连击次数：2 = 双击（第二次按下带 `clickCount: 2`，Chromium 据此合成 `dblclick`） */
    clickCount?: number;
    /** 修饰键（`shift` / `control` / `alt` / `meta`，`ctrl`/`cmd`/`command` 是别名） */
    modifiers?: string[];
    /** 按下与抬起之间等多久（毫秒）—— 有些控件要看到"按下"那一帧才有反馈 */
    pressMs?: number;
    /** 先发一次 `mouseMove` 到位（默认 true；悬停态/rollover 靠它） */
    moveFirst?: boolean;
    /** 窗口没焦点时把它提到前台（默认 true）。这是 `sendInputEvent` 能生效的前提。 */
    focusWindow?: boolean;
}

/** 键盘动作：`key`（发按/抬）与 `text`（逐字发 `char`）可以一起给。 */
export interface KeyOptions {
    /** Electron 加速键名：`'A'` / `'Enter'` / `'Escape'` / `'Space'` / `'F5'` … */
    key?: string;
    /** 修饰键（与鼠标同一张词表） */
    modifiers?: string[];
    /** 要**输入**的文字（逐字发 `char`；上限见 `MAX_TEXT_CHARS`） */
    text?: string;
    /** 每次按下与抬起之间等多久（毫秒） */
    pressMs?: number;
    /** 窗口没焦点时把它提到前台（默认 true）。 */
    focusWindow?: boolean;
}

/**
 * 修饰键白名单 —— 只放行 Electron 认的那几个（拼错的直接报错，别静默丢掉）。
 *
 * 值与别名都取自 Electron 自己的声明（`InputEvent.modifiers`）：
 * `shift` / `control`(=`ctrl`) / `alt` / `meta`(=`command` / `cmd`)。
 * 别名在这里**归一成规范值**再发出去 —— 收下 `ctrl` 却原样发 `ctrl`（而不是 `control`）是另一回事，
 * 不如统一，回执里的 `events` 就永远是规范名。
 */
const MODIFIER_ALIASES: Record<string, string> = {
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
export const MAX_TEXT_CHARS = 200;

/** 默认按下时长（毫秒）：够 Chromium 合成一次「按下 → 抬起」，也不至于让调用方等太久。 */
const DEFAULT_PRESS_MS = 40;

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
        const anyErr = error as { message?: unknown };
        if (typeof anyErr.message === 'string') return anyErr.message;
    }
    return String(error);
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Math.min(2000, ms)));
    });

/** 夹一个整数（越界就夹，不给 NaN）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, raw));
}

/** 只留合法修饰键（别名归一）；有非法项时**抛错**（静默丢掉会让"我明明发了 ctrl"变成假话）。 */
function normalizeModifiers(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out: string[] = [];
    for (const item of list) {
        const name = String(item).trim().toLowerCase();
        if (!name) continue;
        const canonical = MODIFIER_ALIASES[name];
        if (!canonical) {
            throw new Error(`修饰键只认 ${Object.keys(MODIFIER_ALIASES).join(' / ')}，收到 ${JSON.stringify(item)}`);
        }
        if (out.indexOf(canonical) < 0) out.push(canonical);
    }
    return out;
}

/** 键盘焦点（拿不到就是 null —— 不假装知道）。 */
function focusState(contents: WebContents): boolean | null {
    try {
        return typeof contents.isFocused === 'function' ? contents.isFocused() : null;
    } catch {
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
function ensureWindowFocus(contents: WebContents, allowFocus: boolean): NonNullable<InputOutcome['window']> {
    let win: ReturnType<WebContents['getOwnerBrowserWindow']> = null;
    try {
        win = contents.getOwnerBrowserWindow();
    } catch {
        win = null;
    }
    if (!win) return { id: null, focused: null, focusedByUs: false, note: '拿不到这一页所在的窗口（判不了窗口焦点）' };

    let focused: boolean | null = null;
    try {
        focused = typeof win.isFocused === 'function' ? win.isFocused() : null;
    } catch {
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
        } catch {
            /* 提不上来就按原样报 */
        }
    }
    const out: NonNullable<InputOutcome['window']> = { id: win.id ?? null, focused, focusedByUs };
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
export async function clickAt(
    x: number,
    y: number,
    options: ClickOptions = {},
    href?: string,
): Promise<InputOutcome> {
    const events: SentEvent[] = [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: `点击坐标要都是有限数，收到 ${JSON.stringify(x)} / ${JSON.stringify(y)}`, events };
    }

    const button = options.button === undefined ? 'left' : String(options.button).toLowerCase();
    if (BUTTONS.indexOf(button) < 0) {
        return { ok: false, error: `button 只认 ${BUTTONS.join(' / ')}，收到 ${JSON.stringify(options.button)}`, events };
    }
    let modifiers: string[];
    try {
        modifiers = normalizeModifiers(options.modifiers);
    } catch (err) {
        return { ok: false, error: describe(err), events };
    }

    const clickCount = clampInt(options.clickCount, 1, 3, 1);
    const pressMs = clampInt(options.pressMs, 0, 1000, DEFAULT_PRESS_MS);

    const hit = findSceneView(href);
    if (!hit) {
        return {
            ok: false,
            error: '没有找到场景视图的 webContents（编辑器里可能还没有打开任何场景视图面板）。',
            events,
            contents: listContents(),
        };
    }

    const contents = hit.contents;
    const px = Math.round(x);
    const py = Math.round(y);
    /** ⚠ 先处理窗口焦点（Electron 明说 `sendInputEvent` 需要窗口有焦点）—— 它决定这一下到底送不送得进去 */
    const window = ensureWindowFocus(contents, options.focusWindow !== false);
    /** 把一次事件发出去并记一笔 —— 记的是**真传下去的那个对象**，不是我们打算发的那个 */
    const send = (event: InputEvent & { type: string }): SentEvent => {
        contents.sendInputEvent(event);
        const row: SentEvent = { type: event.type };
        const anyEvent = event as unknown as Record<string, unknown>;
        if (typeof anyEvent.x === 'number') row.x = anyEvent.x;
        if (typeof anyEvent.y === 'number') row.y = anyEvent.y;
        if (typeof anyEvent.button === 'string') row.button = anyEvent.button;
        if (typeof anyEvent.clickCount === 'number') row.clickCount = anyEvent.clickCount;
        if (typeof anyEvent.keyCode === 'string') row.keyCode = anyEvent.keyCode;
        if (Array.isArray(anyEvent.modifiers) && anyEvent.modifiers.length > 0) row.modifiers = anyEvent.modifiers as string[];
        events.push(row);
        return row;
    };

    try {
        if (options.moveFirst !== false) {
            send({ type: 'mouseMove', x: px, y: py, modifiers } as InputEvent);
        }
        for (let index = 1; index <= clickCount; index += 1) {
            send({ type: 'mouseDown', x: px, y: py, button, clickCount: index, modifiers } as InputEvent);
            if (pressMs > 0) await sleep(pressMs);
            send({ type: 'mouseUp', x: px, y: py, button, clickCount: index, modifiers } as InputEvent);
            if (index < clickCount && pressMs > 0) await sleep(pressMs);
        }
    } catch (err) {
        return {
            ok: false,
            error: `sendInputEvent 失败：${describe(err)}`,
            events,
            target: hit.info,
            matchedBy: hit.matchedBy,
            window,
            contents: listContents(),
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
export async function sendKeys(options: KeyOptions = {}, href?: string): Promise<InputOutcome> {
    const events: SentEvent[] = [];
    const key = typeof options.key === 'string' ? options.key.trim() : '';
    const text = typeof options.text === 'string' ? options.text : '';
    if (!key && !text) {
        return { ok: false, error: 'key 与 text 至少给一个（key = 按一下某个键；text = 输入一段字）', events };
    }
    if (text.length > MAX_TEXT_CHARS) {
        return { ok: false, error: `text 最多 ${MAX_TEXT_CHARS} 个字符，收到 ${text.length} 个`, events };
    }

    let modifiers: string[];
    try {
        modifiers = normalizeModifiers(options.modifiers);
    } catch (err) {
        return { ok: false, error: describe(err), events };
    }
    const pressMs = clampInt(options.pressMs, 0, 1000, DEFAULT_PRESS_MS);

    const hit = findSceneView(href);
    if (!hit) {
        return {
            ok: false,
            error: '没有找到场景视图的 webContents（编辑器里可能还没有打开任何场景视图面板）。',
            events,
            contents: listContents(),
        };
    }

    const contents = hit.contents;
    /** 键盘同理：窗口没焦点时 `sendInputEvent` 不生效（Electron 的声明明写） */
    const window = ensureWindowFocus(contents, options.focusWindow !== false);
    const send = (event: InputEvent & { type: string }): void => {
        contents.sendInputEvent(event);
        const row: SentEvent = { type: event.type };
        const anyEvent = event as unknown as Record<string, unknown>;
        if (typeof anyEvent.keyCode === 'string') row.keyCode = anyEvent.keyCode;
        if (Array.isArray(anyEvent.modifiers) && anyEvent.modifiers.length > 0) row.modifiers = anyEvent.modifiers as string[];
        events.push(row);
    };

    try {
        if (key) {
            send({ type: 'keyDown', keyCode: key, modifiers } as InputEvent);
            if (pressMs > 0) await sleep(pressMs);
            send({ type: 'keyUp', keyCode: key, modifiers } as InputEvent);
        }
        /** `char` 不带修饰键：它表达的是"这个字符"，修饰键走 `keyDown` 那条 */
        for (const character of text) {
            send({ type: 'char', keyCode: character } as InputEvent);
            if (pressMs > 0) await sleep(Math.min(pressMs, 20));
        }
    } catch (err) {
        return {
            ok: false,
            error: `sendInputEvent 失败：${describe(err)}`,
            events,
            target: hit.info,
            matchedBy: hit.matchedBy,
            window,
            contents: listContents(),
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
