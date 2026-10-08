/**
 * 本扩展**实际用到**的那几个 Electron API 的环境声明。
 *
 * 为什么不 `import type` 整份 electron.d.ts：编辑器自带的那份是 66 万字符的
 * Electron 13 全量声明（`@cocos/creator-types/editor/electron.d.ts`），
 * 而本扩展只用得上「枚举 webContents + 抓一张图 + 编码」这四五个方法。
 * 写在这儿比拉进来一整份更容易读，也让「我们依赖了 Electron 什么」一眼可见——
 * 和 `editor.d.ts` 同一个口径。
 *
 * ⚠ 这里是**手写**的：要用的 API 不在下面时请**补声明**，不要图省事写
 * `(require('electron') as any)` —— 那样编译期就失去了唯一的把关。
 *
 * ## 为什么这个能力必须放在主进程
 *
 * `webContents` / `BrowserWindow` 这类对象**只有主进程有**（渲染进程里
 * `require('electron')` 只拿得到 ipcRenderer 那一组）。本扩展的 `main`
 * 恰好就跑在编辑器主进程里，所以 `capture.ts` 能直接用它们。
 */

declare module 'electron' {
    /** 矩形：`capturePage(rect)` / `nativeImage.crop(rect)` 都用它（单位 = DIP，即 CSS 像素）。 */
    export interface Rectangle {
        x: number;
        y: number;
        width: number;
        height: number;
    }

    /**
     * 一张抓到的图。
     *
     * ⚠ `toPNG()` / `toBitmap()` 的 `scaleFactor` **默认 1**，也就是按 DIP（CSS 像素）出图；
     * 高 DPI 屏下 `getScaleFactor()` 可能是 2，但我们一律按 1 出图 —— 口径统一，
     * 于是「CSS 像素矩形 → crop 矩形」是 1:1 的（见 capture.ts 里的换算）。
     */
    export interface NativeImage {
        /** DIP 尺寸（= CSS 像素） */
        getSize(scaleFactor?: number): { width: number; height: number };
        /** 屏幕缩放（高 DPI 屏 > 1）；只用于写进回执，不参与坐标换算 */
        getScaleFactor(): number;
        isEmpty(): boolean;
        /** BGRA 原始像素（判断空图用；`modify` 之类的接口一概不用） */
        toBitmap(options?: { scaleFactor?: number }): Buffer;
        toPNG(options?: { scaleFactor?: number }): Buffer;
        toJPEG(quality: number): Buffer;
        crop(rect: Rectangle): NativeImage;
        /** ⚠ 只给 width **不会**等比缩放（height 默认取原图高度），等比要自己算另一个边 */
        resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImage;
    }

    /** 一个网页实例：主窗口、webview 里的场景视图、DevTools… 每块都是独立一个。 */
    export interface WebContents {
        readonly id: number;
        /** `'window'` | `'webview'` | `'browserView'` | `'backgroundPage'` | `'devtools'` … */
        getType(): string;
        getURL(): string;
        getTitle(): string;
        isDestroyed(): boolean;
        getZoomFactor(): number;
        /** 排一次重绘 —— 场景视图没在画的时候（窗口被遮挡 / 页签被切走）靠它逼出一帧 */
        invalidate(): void;
        /**
         * 把一次**真输入**发给这一页（走 Chromium 自己的输入管线，页面收到的是真事件）。
         *
         * ⚠ 坐标是**目标 webContents 自己的坐标**（页面 CSS 像素、左上角原点），
         * 与场景脚本报出来的节点矩形同一空间 —— 见 `source/input.ts` 的口径表。
         * ⚠ 这里**不是**「模拟给页面调个函数」：它是真事件，所以 `pointer-events: none`
         * 的层、被遮挡的控件、需要焦点的输入框，行为与真人点一模一样。
         */
        sendInputEvent(event: InputEvent): void;
        /** 这个页有没有键盘焦点（**不主动抢**，只如实报）。 */
        isFocused?(): boolean;
        /** 抢键盘焦点。本扩展默认**不调**它（会打断用户正在别处打字），要显式要求才用。 */
        focus?(): void;
        /**
         * 抓当前**合成后**的一帧（不是 GL 后备缓冲，所以不受 `preserveDrawingBuffer: false` 影响）。
         *
         * @param rect 只抓这一块（DIP）。不传就是整页。
         */
        capturePage(rect?: Rectangle, opts?: { stayHidden?: boolean; stayAwake?: boolean }): Promise<NativeImage>;
        getOwnerBrowserWindow(): {
            id: number;
            getTitle(): string;
            isVisible(): boolean;
            isMinimized(): boolean;
            /**
             * 这个窗口有没有焦点。
             *
             * ⚠ **它决定 `sendInputEvent` 到底送不送得进去** —— Electron 的类型声明里那句原文是
             * "The `BrowserWindow` containing the contents needs to be focused for
             * `sendInputEvent()` to work."（`electron.d.ts` 的 `sendInputEvent` 注释）。
             * 所以回执里必须如实报出来：没焦点时的"点成功"是假绿。
             */
            isFocused?(): boolean;
            /** 把窗口提到前台（**本扩展默认会做**，并如实写进回执；`focusWindow:false` 可关）。 */
            focus?(): void;
        } | null;
    }

    /**
     * 鼠标事件。
     *
     * 只声明本扩展真会发的四种 `type`（其余如 `gestureScrollBegin` 用不上）。
     * `x` / `y` 是**页面 CSS 像素**（= DIP，Chromium 的输入坐标口径），
     * 与 `capturePage()` 的 DIP、场景脚本报的 CSS 矩形三者同一空间。
     */
    export interface MouseInputEvent {
        type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave';
        x: number;
        y: number;
        /** 默认 `'left'` */
        button?: 'left' | 'middle' | 'right';
        /** 连击计数：双击的第二次要传 2（Chromium 据此合成 `dblclick`） */
        clickCount?: number;
        /** `'shift'` / `'control'` / `'alt'` / `'meta'` …（Electron 的修饰键词表） */
        modifiers?: string[];
    }

    /**
     * 键盘事件。
     *
     * `keyCode` 收的是 **Electron 的加速键名**（`'A'` / `'Enter'` / `'Escape'` / `'F5'` / `'Space'` …），
     * 不是 DOM 的 `event.key`；要真的**输入文字**得发 `type: 'char'`。
     */
    export interface KeyboardInputEvent {
        type: 'keyDown' | 'keyUp' | 'char';
        keyCode: string;
        modifiers?: string[];
    }

    /** `sendInputEvent` 收的种类（本扩展只用鼠标/键盘这两种）。 */
    export type InputEvent = MouseInputEvent | KeyboardInputEvent;

    /**
     * 这就是我们要的全部。
     *
     * 用 `require('electron')` 而不是顶层 `import`：普通 Node（verify 脚本、DSH 子进程）
     * 里没有这个模块，顶层 require 会让整个模块 import 就炸（见 capture.ts 的 `getElectron`）。
     */
    export const webContents: {
        /** 包含**所有窗口、webview**、DevTools —— 场景视图就在里面 */
        getAllWebContents(): WebContents[];
        fromId(id: number): WebContents | undefined;
    };
}
