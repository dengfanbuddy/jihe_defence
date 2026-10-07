/**
 * 场景进程脚本 —— Code Mode 的「引擎侧执行器」。
 *
 * 这个文件跑在 **引擎场景进程** 里（不是扩展主进程），所以能直接拿到 `cc` 模块：
 * `Node` / `Component` / `Asset` / `director` / 场景树，全是真的运行时对象。
 *
 * 主进程通过
 * `Editor.Message.request('scene', 'execute-scene-script', { name, method, args })`
 * 调到这里（见 core/scene-bridge.ts）。
 *
 * ## 执行策略：`vm.runInThisContext` 优先，`new Function` 兜底
 *
 * 这里有个**必须讲清楚的取舍**。主进程那边用 `vm.createContext` 做隔离沙箱，
 * 但引擎进程不能照搬 —— 隔离上下文会新建一整套 realm 内建对象，
 * 沙箱里造出来的 `{}` / `[]` 在引擎代码的 `instanceof Object` / `instanceof Array`
 * 判断下会**为假**，那会让一堆引擎 API 出现难以排查的诡异行为。
 *
 * 所以要的是「**同一个 realm，但能超时**」—— 正好是 `vm.runInThisContext(code, { timeout })`：
 * - 代码跑在**宿主 realm**，内建对象与引擎完全一致，`instanceof` 语义安全；
 * - `timeout` 对**同步执行段**生效，于是 `while(true){}` 能被掐断
 *   （这一点很关键：场景进程里卡死一个同步死循环 = 整个 Cocos Creator 冻住，
 *   只能强杀，未保存的场景改动全丢）。
 *
 * 代价是 `runInThisContext` 的代码**看不到局部作用域**，全局量只能通过 `globalThis` 传递，
 * 执行完再还原（见 {@link injectGlobals}）。
 *
 * 如果引擎进程里拿不到 `vm`，回落到 `new Function(...names, body)`：
 * 用显式形参传全局量，零依赖、不碰 `globalThis`，但**同步死循环无法被超时救回**。
 * 两条路径的用户代码写法完全一致（裸标识符 + 顶层 return/await）。
 *
 * ## 这个文件只暴露 3 个方法，不是 30 个
 *
 * `runCode` 里注入了 `dump` / `nodeByUuid` / `tree` / `snapshot` 等**助手函数**，
 * 它们活在沙箱里而不是变成独立 tool —— 这是 Code Mode 的核心口径：
 * 工具列表要短，能力靠代码组合。主进程侧只看到 3 个工具，
 * 引擎能力却有无限组合。
 *
 * ## 两个「不这么做就会被误导」的实测坑
 *
 * 1. **场景树里 97% 的节点不是你的内容**。编辑器把坐标轴 gizmo、网格、参考图都挂在
 *    同一个 scene 下（实测空场景 128 个节点，真实内容只有 2 个）。
 *    `eachNode` / `tree()` 默认按 `HideInHierarchy` 剪枝 —— 判据的推导过程见
 *    {@link makeHelpers} 里 `isEditorNode` 上方的注释（**按 layer 滤是错的**）。
 * 2. **`cc.find` 找不到名字里含 `/` 的节点**，而且**静默返回 null**。
 *    工程里实测存在 `internal/editor/grid-2d`。{@link makeHelpers} 里
 *    `resolvePathBySegments` 用「贪心按段匹配」兜住了这一类。
 */

import { join } from 'path';

/** 执行超时的哨兵错误 */
interface TimeoutMarker {
    __dshTimeout: true;
}

function timeoutError(ms: number): Error & TimeoutMarker {
    const err = new Error(`场景代码执行超时（${ms}ms）`) as Error & TimeoutMarker;
    err.__dshTimeout = true;
    return err;
}

/**
 * 判断是不是超时。
 *
 * 要认两种：
 * 1. 我们自己的哨兵（外层计时器抛的）—— `__dshTimeout`
 * 2. **vm 自己抛的同步超时** —— `ERR_SCRIPT_EXECUTION_TIMEOUT`，
 *    信息形如 `Script execution timed out after 300ms`
 *
 * 第 2 种特别容易漏：漏了的话死循环虽然被掐断了，
 * 但对外报的是「普通异常」而不是「超时」，使用者看不出该去改什么。
 */
function isTimeout(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { __dshTimeout?: boolean; code?: unknown; message?: unknown };
    if (anyErr.__dshTimeout) return true;
    if (anyErr.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return true;
    return typeof anyErr.message === 'string' && /Script execution timed out/i.test(anyErr.message);
}

function errorInfo(err: unknown): { name: string; message: string; stack?: string } {
    if (err && typeof err === 'object') {
        const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
        return {
            name: typeof anyErr.name === 'string' ? anyErr.name : 'Error',
            message: typeof anyErr.message === 'string' ? anyErr.message : String(err),
            stack: typeof anyErr.stack === 'string' ? anyErr.stack : undefined,
        };
    }
    return { name: 'Error', message: String(err) };
}

// ---------------------------------------------------------------------------
// 引擎模块懒加载
// ---------------------------------------------------------------------------

let ccCache: any = null;
let ccError: string | null = null;

/**
 * 拿到 `cc` 模块。
 *
 * `module.paths.push(Editor.App.path + '/node_modules')` 是必需的：
 * 场景脚本自身的模块解析路径里没有引擎包，不推这一下 `require('cc')` 会 MODULE_NOT_FOUND。
 */
function getCc(): any {
    if (ccCache) return ccCache;
    if (ccError) throw new Error(ccError);
    try {
        const engineNodeModules = join(Editor.App.path, 'node_modules');
        if (!module.paths.includes(engineNodeModules)) {
            module.paths.push(engineNodeModules);
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ccCache = require('cc');
        return ccCache;
    } catch (err) {
        ccError = `无法加载引擎模块 cc：${errorInfo(err).message}`;
        throw new Error(ccError);
    }
}

function currentScene(cc: any): any {
    try {
        return cc.director.getScene();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// recipe 模块 —— 与主进程共享同一份实现
// ---------------------------------------------------------------------------

/** 扩展包名，与 constants.ts 的 EXTENSION_NAME 一致（此处不能 import，原因见下） */
const EXTENSION_NAME = 'dsh_chat';

let recipesModule: any = null;
let recipesModuleError: string | null = null;

/**
 * 加载共享的 recipe 模块（`dist/core/recipes.js`）。
 *
 * ⚠ **必须按绝对路径 require，相对路径不通**。实测场景脚本里 `__dirname` 是
 * `...\resources\electron.asar\renderer`（不是扩展的 `dist/`），
 * 所以 `require('./core/recipes')` 直接 MODULE_NOT_FOUND。
 *
 * 正解是问编辑器要扩展根：`Editor.Package.getPath('dsh_chat')`
 * → `...\extensions\dsh_chat`，再拼 `dist/core/recipes.js`（实测可行）。
 *
 * 顺带说明一个硬约束：本项目**没有打包器**（构建就是 `tsc`），
 * 所以 `dist/` 的目录结构是跨进程的硬契约，改 `outDir` 或挪 `core/` 会打断它。
 */
function getRecipesModule(): any {
    if (recipesModule) return recipesModule;
    if (recipesModuleError) throw new Error(recipesModuleError);
    try {
        const root = Editor.Package.getPath(EXTENSION_NAME);
        if (!root) throw new Error(`Editor.Package.getPath('${EXTENSION_NAME}') 返回空`);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        recipesModule = require(join(root, 'dist', 'core', 'recipes.js'));
        return recipesModule;
    } catch (err) {
        recipesModuleError = `无法加载 recipe 模块：${errorInfo(err).message}`;
        throw new Error(recipesModuleError);
    }
}

/** 当前工程根；拿不到就返回空串（recipe 助手会退化成「没有 recipe」而不是报错） */
function currentProjectPath(): string {
    try {
        return Editor.Project.path || '';
    } catch {
        return '';
    }
}

/** recipe 存放目录 —— 只给 `describe_api` 回显用，拿不到就 null */
function recipesRootHint(): string | null {
    try {
        const projectPath = currentProjectPath();
        if (!projectPath) return null;
        return getRecipesModule().recipesRoot(projectPath);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 助手函数 —— 注入沙箱，不暴露为 tool
// ---------------------------------------------------------------------------

/** 深度优先遍历整棵子树（迭代实现，避免深层场景爆栈） */
function eachNode(root: any, visit: (node: any) => void): void {
    if (!root) return;
    const stack: any[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        visit(node);
        const children = node.children || [];
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
}

function shortNode(node: any): Record<string, unknown> | null {
    if (!node) return null;
    return {
        name: node.name,
        uuid: node.uuid,
        active: node.activeInHierarchy !== undefined ? node.activeInHierarchy : node.active,
    };
}

/** 把值推断成 TS 类型名，用于生成类定义 */
function inferTsType(value: unknown): string {
    if (value === null || value === undefined) return 'any';
    if (Array.isArray(value)) {
        return value.length > 0 ? `${inferTsType(value[0])}[]` : 'any[]';
    }
    switch (typeof value) {
        case 'number':
            return 'number';
        case 'string':
            return 'string';
        case 'boolean':
            return 'boolean';
        case 'function':
            return 'Function';
        case 'object':
            break;
        default:
            return 'any';
    }
    const obj = value as Record<string, unknown>;
    let ctorName = '';
    try {
        const ctor = (obj as { constructor?: { name?: string } }).constructor;
        ctorName = ctor && typeof ctor.name === 'string' ? ctor.name : '';
    } catch {
        ctorName = '';
    }
    if (!ctorName || ctorName === 'Object') return 'object';
    // 引擎数学/资源类型都带 cc. 前缀更利于 AI 写代码
    if (typeof obj.uuid === 'string') return `cc.${ctorName} /* asset */`;
    return `cc.${ctorName}`;
}

/** 取一个对象上的可枚举自有键（getter 抛异常时跳过） */
function safeKeys(target: any): string[] {
    try {
        return Object.keys(target);
    } catch {
        return [];
    }
}

function safeRead(target: any, key: string): { ok: boolean; value?: unknown } {
    try {
        return { ok: true, value: target[key] };
    } catch {
        return { ok: false };
    }
}

/** 组件的序列化属性名列表：优先用 Cocos 的 `__props__` */
function componentPropNames(comp: any): string[] {
    const ctor = comp && comp.constructor;
    const declared = ctor && Array.isArray(ctor.__props__) ? (ctor.__props__ as string[]) : null;
    if (declared && declared.length > 0) return declared.slice();
    return safeKeys(comp).filter((k) => k !== 'node' && k !== 'uuid' && !k.startsWith('_'));
}

// ---------------------------------------------------------------------------
// 场景视图截图（captureView 的实现）
// ---------------------------------------------------------------------------
//
// 为什么要这个能力：改完节点树/布局之后，**坐标数字看不出「叠在一起」「贴图是空的」
// 「一屏只有个角」**。有了它，AI 可以自己看一眼画面再决定下一步，而不是拿一串 rect
// 去猜，也不是把用户当验图工具。
//
// 两条实现口径：
// 1. **在引擎画完这一帧之后读像素**（`EVENT_AFTER_DRAW`）。WebGL 的绘制缓冲在合成后
//    即失效（`preserveDrawingBuffer` 默认 false），帧外读只会得到一张空图。
// 2. **优先自己落盘**：本文件是场景进程里的 CJS 模块，`fs` 在**模块作用域**里可见
//    （沙箱里看不到 `require`，但助手函数的闭包看得到）。写不了盘才回落「分块回传」，
//    由主进程拼回去落盘 —— 因为沙箱返回值有「单字符串 4000 字」的上限。

/** Node 侧模块（拿不到就返回 null，调用方回落到分块回传）。 */
let nodeModulesCache: { fs: any; path: any; os: any } | null | undefined;

function getNodeModules(): { fs: any; path: any; os: any } | null {
    if (nodeModulesCache !== undefined) return nodeModulesCache;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nodeModulesCache = { fs: require('fs'), path: require('path'), os: require('os') };
    } catch {
        nodeModulesCache = null;
    }
    return nodeModulesCache;
}

/** 场景视图的那块画布：优先引擎自己的 canvas，其次页面上面积最大的 canvas。 */
function findViewCanvas(cc: any): any {
    const candidates: any[] = [];
    try {
        if (cc.game && cc.game.canvas) candidates.push(cc.game.canvas);
    } catch {
        /* 忽略：引擎版本差异 */
    }
    try {
        if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
            candidates.push(...Array.from(document.querySelectorAll('canvas')));
        }
    } catch {
        /* 忽略：不是浏览器环境 */
    }
    const usable = candidates.filter(
        (c) => c && typeof c.getContext === 'function' && c.width > 0 && c.height > 0,
    );
    if (usable.length === 0) return null;
    return usable.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

/**
 * 报出「场景视图现在是怎么取景的」—— **空白帧的一半答案在这里**。
 *
 * 为什么要有它：实测出过一次事故（2026-09-30 00:49 那条会话），模型为了「模拟设备高度验适配」
 * 调了 `cc.view.setDesignResolutionSize`，把编辑器**场景视图的设备模拟打掉**了：
 * `visible` 从 750×1334 变成 750×559.35，此后每一次 `capture_view` 都只拿到 `blankRatio: 1`
 * 的白纸 —— 而**这个差异是可以直接量出来的**。把它报出来，模型就不用靠猜，
 * 也不用像那次一样自建一套离屏渲染器（16 步）去替代一个"被自己弄坏"的通道。
 *
 * @param cc - 引擎模块。
 * @param canvas - 场景视图画布。
 * @returns 视图状态；取不到的项不出现（引擎版本差异不阻断截图本身）。
 */
function readViewState(cc: any, canvas: any): Record<string, unknown> {
    const round = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const out: Record<string, unknown> = {};
    try {
        const view = cc.view;
        if (view) {
            if (typeof view.getVisibleSize === 'function') {
                const size = view.getVisibleSize();
                if (size) out.visibleSize = { width: round(size.width), height: round(size.height) };
            }
            if (typeof view.getDesignResolutionSize === 'function') {
                const size = view.getDesignResolutionSize();
                if (size) out.designResolution = { width: round(size.width), height: round(size.height) };
            }
            if (typeof view.getScaleX === 'function') {
                out.scale = { x: round(view.getScaleX()), y: round(view.getScaleY()) };
            }
        }
    } catch {
        /* 引擎版本差异：拿不到就不报，不影响截图 */
    }
    try {
        if (canvas) out.canvas = { width: canvas.width, height: canvas.height };
    } catch {
        /* 忽略 */
    }
    /** 与设计分辨率不一致 = 游戏侧取景不是设计档（⚠ 场景视图是自由相机，用户缩放也会让它变，所以这只是线索不是判据） */
    const visible = out.visibleSize as { width: number; height: number } | undefined;
    const design = out.designResolution as { width: number; height: number } | undefined;
    if (visible && design && typeof design.height === 'number' && design.height > 0) {
        out.visibleMatchesDesign = Math.abs(visible.height - design.height) / design.height <= 0.05;
    }
    return out;
}

/**
 * 等引擎画完一帧，然后从默认帧缓冲读回像素。
 *
 * @param waitMs 等不到 `EVENT_AFTER_DRAW` 时的兜底上限（场景视图可能没在渲染）
 */
function readViewPixels(
    cc: any,
    canvas: any,
    waitMs: number,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
    const grab = (): { width: number; height: number; pixels: Uint8Array } => {
        const gl =
            canvas.getContext('webgl2') ||
            canvas.getContext('webgl') ||
            canvas.getContext('experimental-webgl');
        if (!gl) throw new Error('画布上没有 WebGL 上下文（2D 画布不支持这么截图）');
        const width = gl.drawingBufferWidth || canvas.width;
        const height = gl.drawingBufferHeight || canvas.height;
        if (!width || !height) throw new Error('画布尺寸为 0，截不到东西');
        const pixels = new Uint8Array(width * height * 4);
        // 引擎可能留着别的 FBO 绑定 —— 读默认帧缓冲前显式解绑
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { width, height, pixels };
    };

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            try {
                fn();
            } catch (err) {
                reject(err);
            }
        };
        try {
            const event = cc.Director && cc.Director.EVENT_AFTER_DRAW;
            if (event && cc.director && typeof cc.director.once === 'function') {
                cc.director.once(event, () => settle(() => resolve(grab())));
            }
        } catch {
            /* 回落：直接抓当前缓冲 */
        }
        setTimeout(() => settle(() => resolve(grab())), waitMs);
    });
}

/** 抽样估算「几乎是空图」的比例（全透明或纯黑都算空）—— 用来发现"截出来是张白纸"。 */
function sampleBlankRatio(pixels: Uint8Array): number {
    const total = Math.floor(pixels.length / 4);
    if (total <= 0) return 1;
    const step = Math.max(1, Math.floor(total / 512));
    let sampled = 0;
    let blank = 0;
    for (let i = 0; i < total; i += step) {
        const o = i * 4;
        sampled += 1;
        if (pixels[o + 3] === 0 || (pixels[o] === 0 && pixels[o + 1] === 0 && pixels[o + 2] === 0)) blank += 1;
    }
    return sampled > 0 ? Math.round((blank / sampled) * 1000) / 1000 : 1;
}

/** 把 RGBA 像素编码成 data URL（WebGL 原点在左下，需要翻行）。 */
function encodeFrameToDataUrl(
    pixels: Uint8Array,
    width: number,
    height: number,
    opts: { maxWidth: number; mime: string; quality: number },
): { dataUrl: string; width: number; height: number } {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        throw new Error('当前环境没有 document.createElement，无法把像素编码成图片');
    }
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    const ctx = src.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 画布上下文');

    const image = ctx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
        const from = (height - 1 - y) * rowBytes;
        image.data.set(pixels.subarray(from, from + rowBytes), y * rowBytes);
    }
    ctx.putImageData(image, 0, 0);

    let out: any = src;
    if (opts.maxWidth > 0 && width > opts.maxWidth) {
        const scaled = document.createElement('canvas');
        scaled.width = opts.maxWidth;
        scaled.height = Math.max(1, Math.round((height * opts.maxWidth) / width));
        const sctx = scaled.getContext('2d');
        if (sctx) {
            sctx.imageSmoothingEnabled = true;
            try {
                sctx.imageSmoothingQuality = 'high';
            } catch {
                /* 老浏览器不支持就算了 */
            }
            sctx.drawImage(src, 0, 0, scaled.width, scaled.height);
            out = scaled;
        }
    }
    return { dataUrl: out.toDataURL(opts.mime, opts.quality), width: out.width, height: out.height };
}

// ---------------------------------------------------------------------------
// 场景视图几何 —— 给主进程的 Electron 截图用（这里只「量」，不读像素）
// ---------------------------------------------------------------------------
//
// 分工（**为什么要分**）：像素由主进程的 `webContents.capturePage()` 抓 —— 它读的是
// Chromium **合成后的 surface**，不受 `preserveDrawingBuffer: false` 影响，还能
// `invalidate()` 逼出一帧；这两件正是老的 `gl.readPixels` 做不到的（见 `capture.ts` 头部）。
// 而「抓哪一块」只有场景进程答得上，因为它手里有编辑器相机。
//
// 于是本文件只回答三个数：
// 1. 页面（= webview 那一页）的 CSS 尺寸与 URL；
// 2. 画布在页面里的位置与尺寸；
// 3. 节点的矩形（**页面 CSS 像素、左上角原点**）。
//
// ## 坐标口径（只在这里换算一次，主进程那边不再换算）
//
// `Camera.worldToScreen` 给的是**屏幕空间**：**左下角为原点、y 向上**，
// 单位是**相机渲染目标的像素**（也就是画布的 device 像素，不是 CSS 像素）。
// 换成「页面 CSS 像素、左上角原点」要两步：**除以 dpr**，再把 y **翻过来**。

/** 保留三位小数（几何量够用，且回执里可读）。 */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/** 取一个可能抛异常的数值 getter。 */
function safeNumber(read: () => unknown): number | null {
    try {
        const value = read();
        return typeof value === 'number' && Number.isFinite(value) ? round3(value) : null;
    } catch {
        return null;
    }
}

/** 把可能来自 IPC 的数值夹到 `[min, max]`（不是数就用 `fallback`）。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, num));
}

/**
 * 页面（webview）的 CSS 几何 + 它自己的 URL。
 *
 * `href` 是**主进程定位这个 webContents 的首选判据**：编辑器里可能同时有好几个
 * webview（场景视图、游戏预览…），按 URL 精确匹配比按「类型是 webview」猜可靠得多。
 */
function pageGeometry(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    try {
        if (typeof window !== 'undefined' && window.location) {
            out.href = window.location.href;
            out.cssWidth = window.innerWidth;
            out.cssHeight = window.innerHeight;
            out.dpr = window.devicePixelRatio || 1;
        }
    } catch {
        /* 不是浏览器环境就算了：主进程会退回到按 URL 特征找 */
    }
    return out;
}

/** 画布在页面里的位置（CSS 像素）+ 它的 device 像素尺寸。 */
function canvasGeometry(canvas: any): Record<string, unknown> | null {
    if (!canvas) return null;
    const out: Record<string, unknown> = {};
    try {
        if (typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            out.left = round3(rect.left);
            out.top = round3(rect.top);
            out.cssWidth = round3(rect.width);
            out.cssHeight = round3(rect.height);
        }
    } catch {
        /* 忽略：量不到就少一项，不影响别的 */
    }
    try {
        out.deviceWidth = canvas.width;
        out.deviceHeight = canvas.height;
    } catch {
        /* 忽略 */
    }
    return out;
}

/**
 * 编辑器相机。
 *
 * `cce.Camera` 是场景页里的**全局单例**（`declare global { namespace cce }`，
 * 见编辑器的 `@cocos/creator-types/editor/packages/scene/@types/scene.d.ts`），
 * 它的 `.camera` 就是 `EditorCameraComponent` —— **本身就是 `cc.Camera`**，
 * 所以 `worldToScreen` 可以直接用，2D / 3D 视图都认。
 *
 * 这就是「节点截图」缺的那一块：老实现只知道整张画布，不知道节点画在哪。
 */
function editorCamera(): { manager: any; cam: any; is2D: boolean | null; note?: string } {
    try {
        const manager = (globalThis as any).cce && (globalThis as any).cce.Camera;
        if (!manager) return { manager: null, cam: null, is2D: null, note: '这个进程里没有 cce.Camera（场景页才有）' };
        const cam = manager.camera;
        if (!cam || !cam.camera) {
            return { manager, cam: null, is2D: null, note: 'cce.Camera.camera 还没初始化（场景视图刚打开时会有这一瞬）' };
        }
        let is2D: boolean | null = null;
        try {
            if (typeof manager.is2D === 'boolean') is2D = manager.is2D;
        } catch {
            /* 忽略 */
        }
        return { manager, cam, is2D };
    } catch (err) {
        return { manager: null, cam: null, is2D: null, note: `读 cce.Camera 失败：${errorInfo(err).message}` };
    }
}

/**
 * 节点的矩形 —— **页面 CSS 像素、左上角为原点**。
 *
 * 做法：把节点世界矩形的 4 个角喂给编辑器相机的 `worldToScreen`，取包围盒。
 * 于是「视图缩放了 / 平移了 / 节点自己转了」都不用手工推 —— 相机全都知道。
 *
 * 两点诚实的边界：
 * - 世界矩形用的是轴对齐包围盒（`contentSize × worldScale`，**不旋转**），
 *   所以节点自身带旋转时是一个**近似**（屏幕上仍是包围盒，不是外接多边形）；
 * - 没有 `UITransform` 的节点（纯 3D 空节点）没有尺寸，**给不出矩形**，
 *   这时如实回 `rect: null`，由主进程退成整张视图，而不是裁一个瞎猜的框。
 */
function projectNodeRect(
    cc: any,
    cam: any,
    node: any,
    canvas: any,
): { rect: Record<string, number> | null; canvasRect: Record<string, number> | null; note?: string } {
    const ut = typeof node.getComponent === 'function' ? node.getComponent(cc.UITransform) : null;
    if (!ut) return { rect: null, canvasRect: null, note: '节点没有 UITransform（没有 contentSize），算不出矩形' };

    let width = 0;
    let height = 0;
    let anchorX = 0.5;
    let anchorY = 0.5;
    try {
        width = ut.width || 0;
        height = ut.height || 0;
        anchorX = typeof ut.anchorX === 'number' ? ut.anchorX : 0.5;
        anchorY = typeof ut.anchorY === 'number' ? ut.anchorY : 0.5;
    } catch {
        /* 忽略：保持默认 */
    }

    let scaleX = 1;
    let scaleY = 1;
    try {
        const ws = node.worldScale;
        if (ws) {
            scaleX = Math.abs(ws.x) || 1;
            scaleY = Math.abs(ws.y) || 1;
        }
    } catch {
        /* 忽略 */
    }
    const worldWidth = width * scaleX;
    const worldHeight = height * scaleY;
    if (worldWidth <= 0 || worldHeight <= 0) {
        return { rect: null, canvasRect: null, note: `节点尺寸为 0（contentSize ${width}×${height}），算不出矩形` };
    }

    let wx = 0;
    let wy = 0;
    let wz = 0;
    try {
        const wp = node.worldPosition;
        wx = wp.x;
        wy = wp.y;
        wz = wp.z;
    } catch {
        return { rect: null, canvasRect: null, note: '读不到节点的 worldPosition' };
    }
    // 锚点偏移：worldPosition 是**锚点**的位置，矩形中心要按锚点补回来
    const cx = wx + (0.5 - anchorX) * worldWidth;
    const cy = wy + (0.5 - anchorY) * worldHeight;

    return projectWorldBox(cc, cam, canvas, { cx, cy, wz, width: worldWidth, height: worldHeight });
}

/** 一个**轴对齐的世界矩形**（+ 一个 z；投影要三维点）。 */
interface WorldBox {
    /** 矩形中心（世界坐标） */
    cx: number;
    cy: number;
    /** 投影用的深度（2D 正交与它无关，3D 透视有关系） */
    wz: number;
    width: number;
    height: number;
}

/**
 * 世界矩形 → **页面 CSS 像素**矩形（左上角原点）。
 *
 * 四角喂给 `worldToScreen` 再取包围盒 —— 这是全工程**唯一**一处做这个换算的地方，
 * 「节点矩形」与「取景覆盖判据」都走它（两处若各写一份，迟早会对不上）。
 *
 * @returns `rect`（页面左上角原点）、`canvasRect`（画布内、相对画布左上角）；
 *   量不到相机高度/dpr、或 `worldToScreen` 抛异常时 `rect` 为 null。
 */
function projectWorldBox(
    cc: any,
    cam: any,
    canvas: any,
    box: WorldBox,
): { rect: Record<string, number> | null; canvasRect: Record<string, number> | null; note?: string } {
    /** 几何基准：y 翻转用相机自己的高度（相机像素），dpr 从画布推（CSS ← device） */
    const canvasBox = canvasGeometry(canvas) || {};
    const camHeight = safeNumber(() => cam.camera.height) || (canvasBox.deviceHeight as number) || 0;
    const canvasCssWidth = (canvasBox.cssWidth as number) || 0;
    const canvasDeviceWidth = (canvasBox.deviceWidth as number) || 0;
    const dpr = canvasCssWidth > 0 && canvasDeviceWidth > 0 ? canvasDeviceWidth / canvasCssWidth : pageDpr();
    if (!camHeight || !dpr) {
        return { rect: null, canvasRect: null, note: '量不到相机高度或 dpr，无法把屏幕空间换成 CSS 像素' };
    }

    const Vec3 = cc.Vec3;
    const xs: number[] = [];
    const ys: number[] = [];
    try {
        for (const dx of [-0.5, 0.5]) {
            for (const dy of [-0.5, 0.5]) {
                const point = cam.worldToScreen(new Vec3(box.cx + dx * box.width, box.cy + dy * box.height, box.wz));
                xs.push(point.x / dpr);
                // 左下原点、y 向上 → 左上原点、y 向下
                ys.push((camHeight - point.y) / dpr);
            }
        }
    } catch (err) {
        return { rect: null, canvasRect: null, note: `worldToScreen 失败：${errorInfo(err).message}` };
    }

    const raw = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
    const left = (canvasBox.left as number) || 0;
    const top = (canvasBox.top as number) || 0;
    const canvasRect = {
        x: round3(raw.x),
        y: round3(raw.y),
        width: round3(raw.width),
        height: round3(raw.height),
    };
    const rect = {
        x: round3(raw.x + left),
        y: round3(raw.y + top),
        width: round3(raw.width),
        height: round3(raw.height),
    };

    /** 自检：算出来的框应当落在画布内。越界说明上面那条口径在这台机器上不成立，如实报出来 */
    const outside =
        canvasCssWidth > 0 &&
        (rect.x + rect.width < 0 ||
            rect.y + rect.height < 0 ||
            rect.x > left + canvasCssWidth ||
            rect.y > top + ((canvasBox.cssHeight as number) || 0));
    return {
        rect,
        canvasRect,
        note: outside
            ? '⚠ 投影出来的矩形落在画布外（相机或 dpr 口径可能不成立）—— 请核对 camera / canvas 字段'
            : undefined,
    };
}

/** 页面自己的 dpr（拿不到画布尺寸时的兜底）。 */
function pageDpr(): number {
    try {
        if (typeof window !== 'undefined') return window.devicePixelRatio || 1;
    } catch {
        /* 忽略 */
    }
    return 1;
}

// ---------------------------------------------------------------------------
// Label 排版度量 —— `labelFit` 的算术基础（常数全是**实测**来的，不是抄文档）
// ---------------------------------------------------------------------------
//
// Cocos Creator 3.8.6，用一个**游离 Label**（`new cc.Node()`，从不进场景）+
// `updateRenderData(true)` 量的。三条结论：
//
// 1. **节点内容高**（`overflow = NONE / RESIZE_HEIGHT`，即引擎自己撑高时）：
//
//        contentHeight = (行数 − 1) × 行进给 + 行进给 × 1.26
//
//    八组样本全中：fs14/lh0/框宽 100 得两行 → 31.64（= 14 + 17.64）；
//    fs20/lh0/框宽 100 得两行 → 45.2（= 20 + 25.2）；lh40 一行 → 50.4；
//    lh66 一行 → 83.16；lh20/fs20 一行 → 25.2。也就是说
//    **最后一行比别的行多 0.26 倍行进给**。
// 2. **行进给**（每多一行往下走多少）= `lineHeight > 0 ? lineHeight : fontSize`。
//    ⚠ `_lineHeight = 0` 时引擎回落到 **`fontSize`**，不是 `fontSize × 1.26`；
//    而 `label.lineHeight` 这个 getter 会**原样回 0** —— 所以它**不能**当度量用
//    （踩过：拿它算出"能放 3 行"，实际只放得下 2 行）。
// 3. **字符宽度**（Arial，em 倍数）：CJK 与全角标点 `1.000`、大写 `0.667`、
//    小写与数字 `0.556`、空格 `0.278`。「CJK = 1em」是量出来的（`'啊'` 在 fs20 下宽 20.0）。
//
// ⚠ 一条诚实的边界：上面第 1 条的公式是从「引擎撑出来的节点高」反推的，
// 而 `CLAMP` 的**截断阈值**我用了同一条公式的逆（`最多行数 = floor(框高 / 行进给 − 0.26)`）。
// 它**复现了实测的两个现场**（框高 44 / 行进给 20.8 → 第 2 行整行被裁掉；
// 框高 72 / 行进给 24 → 2 行放得下、3 行要 78.24 放不下），但引擎内部真正用哪条判据
// **没有读源码确认**。所以 `labelFit` 把用到的公式**原样写进回执**（`formula` 字段），
// 别把它当黑箱。

/** 引擎撑高时「最后一行」的额外系数 —— 见上面第 1 条（8 组样本实测）。 */
const LABEL_LAST_LINE_FACTOR = 1.26;

/** 字符宽度的兜底表（em 倍数）。页面上有 DOM 时优先走 canvas `measureText`，这张表只作兜底。 */
const EM_WIDTH: Record<string, number> = { cjk: 1, upper: 0.667, lower: 0.556, digit: 0.556, space: 0.278 };

/** 一个字符属于哪一类（决定兜底宽度）。 */
function emClassOf(ch: string): string {
    const code = ch.codePointAt(0) || 0;
    if (ch === ' ' || ch === '\t') return 'space';
    if (code >= 0x30 && code <= 0x39) return 'digit';
    if (code >= 0x41 && code <= 0x5a) return 'upper';
    if (code >= 0x61 && code <= 0x7a) return 'lower';
    if (code < 0x2e80) return 'lower'; // 拉丁标点/符号按小写宽度近似
    return 'cjk'; // CJK / 全角标点 / 假名 / 韩文 —— 一律 1em
}

/** 量文字用的 2D 上下文（模块级缓存；取不到就 null，调用方走兜底表）。 */
let measureCtxCache: any = null;

/**
 * 拿一个 2D 上下文来量字。
 *
 * ⚠ **只缓存成功的结果**：失败时每次都重试。踩过的理由很实在 —— 场景页刚打开的那一瞬
 * `document` 可能还没就绪，如果那时把「没有上下文」缓存下来，之后**一整局都量不了字**，
 * 而症状是「宽度悄悄退化成估算」——很难查。重试的代价只是一次 `createElement`。
 */
function measureContext(): any {
    if (measureCtxCache) return measureCtxCache;
    try {
        const doc = (globalThis as any).document;
        if (doc && typeof doc.createElement === 'function') {
            const canvas = doc.createElement('canvas');
            measureCtxCache = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        }
    } catch {
        measureCtxCache = null;
    }
    return measureCtxCache;
}

/**
 * 一段文字的宽度（px）。
 *
 * **有 DOM 就真量**（`ctx.measureText`，与引擎 TTF 排版同一把尺子），没有才用兜底表估。
 * 回执里带 `method`，调用方一眼看得出这个数是量出来的还是估出来的。
 */
function measureTextWidth(
    text: string,
    fontSize: number,
    fontFamily: string,
): { width: number; method: 'canvas' | 'estimate' } {
    const s = String(text == null ? '' : text);
    if (s.length === 0 || !(fontSize > 0)) return { width: 0, method: 'estimate' };
    const ctx = measureContext();
    if (ctx) {
        try {
            ctx.font = `${fontSize}px ${fontFamily || 'Arial'}`;
            const width = ctx.measureText(s).width;
            if (typeof width === 'number' && Number.isFinite(width)) return { width, method: 'canvas' };
        } catch {
            /* 落到兜底表 */
        }
    }
    let total = 0;
    for (const ch of s) total += (EM_WIDTH[emClassOf(ch)] || 0.556) * fontSize;
    return { width: total, method: 'estimate' };
}

/**
 * 快照仓 —— **必须是模块级的**。
 *
 * `makeHelpers()` 每跑一段代码就重建一次闭包，放在闭包里的东西下一段代码就看不见了；
 * 而「改之前存一份、改之后 diff」天生跨两次调用。所以存在模块作用域，按 `label` 取用。
 */
const snapshotStore = new Map<string, Record<string, unknown>>();

/** 最多留几份快照（超了淘汰最旧的）。够「before/after」用，又不会把场景进程撑胖。 */
const SNAPSHOT_KEEP = 12;

// ---------------------------------------------------------------------------
// 取景（framing）—— 「把要拍的东西先框进画布，截完再还原视角」
// ---------------------------------------------------------------------------
//
// ## 为什么必须有这一段
//
// `capturePage()` 抓的是**屏幕上现在这一帧**。于是用户把场景视图缩放/平移过之后，
// 抓到的就只是他当时看的那块地方 —— 想截「整个场景」时那不是全貌
// （实测：720×1560 的设计分辨率，用户缩到 200% 看一张卡，截图里就只有那张卡）。
//
// 而场景进程手里有编辑器相机，**能改它的取景**：先框住要拍的东西 → 截图 → 还原。
//
// ## 三级取景：按「谁的方法更正统」排序，逐级**量着验**，验不过才降级
//
// | step | 做法 | 为什么排这个位置 |
// |---|---|---|
// | 0 | `cce.Camera.focus(uuids, undefined, true)` | 编辑器自己的「F 聚焦」。它内部会同步 2D/3D 控制器的状态（网格/标尺/后续交互都不会错位），**首选** |
// | 1 | `controller2D._adjustToCenter(margin, rect, true)` | 2D 控制器自己的「适配内容」，显式传我们算出来的矩形 —— 绕开 focus 那套包围盒口径 |
// | 2 | **手工**（仅 2D 正交） | 量出「像素/世界单位」再把 `orthoHeight` 与相机位置算回去。⚠ 它会**绕过控制器**，控制器内部记的视角与真实视角会暂时不一致 —— 所以只在 0/1 都框不全时才用 |
//
// 每级做完都要**重新量一遍**（`viewMetrics` 的 `framing`）：判据是「目标的矩形是不是
// 整个落在画布里」，量不过就降级。这样就不必猜编辑器内部怎么算的 —— 第一级能成就不会用到第二级。
//
// ## 还原是**必须**的
//
// 用户视角不能被我们留在别处。`fitView({action:'end'})` 先试编辑器自己的
// `focus(null, savedInfo, true)`，不行再把相机字段直接写回，两条都不行就如实回
// `restored:false`（**别假装还原了** —— 那会让用户以为画面没动过）。
//
// ## 坐标系
//
// 目标的矩形统一用**世界坐标**（y 向上）描述，投影只走 `projectWorldBox` 一处；
// 判「拍全了没有」用的是**页面 CSS 像素**的矩形与画布矩形（`canvasGeometry`），
// 与裁切/落盘那条链路同一口径。

/** 取景时内容四周留的空白比例（相对画布短边）—— 贴边会让描边/阴影被切掉。 */
const FIT_MARGIN = 0.08;

/** 相机像素里允许的「没拍全」容差：投影与真实渲染之间的舍入不值得判成失败。 */
const COVERAGE_TOLERANCE_PX = 2;

/** 手工取景时量斜率的探针长度（世界单位）—— 取大一点躲开浮点噪声。 */
const PROBE_UNITS = 100;

/** `fit` 的目标描述（主进程只说要拍「场景」还是「某个节点」）。 */
interface FitSpec {
    kind: 'scene' | 'node';
    /** `kind: 'node'` 时的节点引用（uuid 或路径） */
    ref: string;
}

/** 解析主进程传来的 `fit` 字段；认不出就回 null（= 不取景）。 */
function normalizeFitSpec(raw: unknown): FitSpec | null {
    const value = raw as { kind?: unknown; ref?: unknown } | null;
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'node' ? 'node' : value.kind === 'scene' ? 'scene' : null;
    if (!kind) return null;
    return { kind, ref: typeof value.ref === 'string' ? value.ref.trim() : '' };
}

/** 页面上画布的位置与尺寸（**页面 CSS 像素**）—— 「拍全了没有」的参照系。 */
function viewportOf(canvas: any): { x: number; y: number; width: number; height: number } | null {
    const box = canvasGeometry(canvas);
    if (!box) return null;
    const width = (box.cssWidth as number) || 0;
    const height = (box.cssHeight as number) || 0;
    if (width <= 0 || height <= 0) return null;
    return { x: (box.left as number) || 0, y: (box.top as number) || 0, width, height };
}

/**
 * 「这个矩形拍全了没有」—— 取景链的**唯一判据**。
 *
 * @param pageRect - 目标矩形（页面 CSS 像素）。
 * @param viewport - 画布矩形（页面 CSS 像素）。
 * @returns `covered`（四边都在画布内，容差 2px）、`edges`（四边的**内侧余量**，负数 = 超出多少）、
 *   `areaRatio`（与画布的**交集**面积占比 —— 跑出屏幕的内容不能拿自己的面积充数）。
 */
function coverageOf(
    pageRect: Record<string, number>,
    viewport: { x: number; y: number; width: number; height: number },
): Record<string, unknown> {
    const edges = {
        left: round3(pageRect.x - viewport.x),
        right: round3(viewport.x + viewport.width - (pageRect.x + pageRect.width)),
        top: round3(pageRect.y - viewport.y),
        bottom: round3(viewport.y + viewport.height - (pageRect.y + pageRect.height)),
    };
    const covered =
        edges.left >= -COVERAGE_TOLERANCE_PX &&
        edges.right >= -COVERAGE_TOLERANCE_PX &&
        edges.top >= -COVERAGE_TOLERANCE_PX &&
        edges.bottom >= -COVERAGE_TOLERANCE_PX;
    const ix = Math.max(
        0,
        Math.min(pageRect.x + pageRect.width, viewport.x + viewport.width) - Math.max(pageRect.x, viewport.x),
    );
    const iy = Math.max(
        0,
        Math.min(pageRect.y + pageRect.height, viewport.y + viewport.height) - Math.max(pageRect.y, viewport.y),
    );
    const viewArea = viewport.width * viewport.height;
    return {
        covered,
        areaRatio: viewArea > 0 ? Math.round(((ix * iy) / viewArea) * 1000) / 1000 : 0,
        edges,
    };
}

/** 取景的目标：要装进画布的那块世界矩形 + 交给编辑器聚焦的 uuid。 */
interface FitTarget {
    spec: FitSpec;
    /** 目标的世界矩形；算不出来时为 null（不瞎编一个框） */
    world: { cx: number; cy: number; width: number; height: number } | null;
    /** 交给 `focus()` 的 uuid（内容根节点 / 目标节点自己） */
    uuids: string[];
    /** 这块矩形是从哪来的（回执里写清楚「取景量的到底是哪块」） */
    source: string;
    note?: string;
}

/**
 * 把 `{kind, ref}` 解析成「一块世界矩形 + 一串 uuid」。
 *
 * - `scene`：`helpers.contentBounds()`（真实内容的并集，见它的注释）；
 * - `node`：目标节点自己的 `worldRect`。
 */
function fitTargetOf(helpers: Record<string, any>, spec: FitSpec, node: any): FitTarget {
    if (spec.kind === 'node') {
        if (!node) {
            return { spec, world: null, uuids: [], source: 'node', note: `没找到节点「${spec.ref}」` };
        }
        let rect: Record<string, any> | null = null;
        try {
            rect = helpers.worldRect(node) as Record<string, any>;
        } catch (err) {
            return { spec, world: null, uuids: [], source: 'node.worldRect', note: `算节点矩形失败：${errorInfo(err).message}` };
        }
        const width = typeof rect.width === 'number' ? rect.width : 0;
        const height = typeof rect.height === 'number' ? rect.height : 0;
        if (width <= 0 || height <= 0) {
            return {
                spec,
                world: null,
                uuids: node.uuid ? [node.uuid] : [],
                source: 'node.worldRect',
                note: `节点没有尺寸（${width}×${height}），没法取景`,
            };
        }
        return {
            spec,
            world: { cx: rect.cx, cy: rect.cy, width, height },
            uuids: node.uuid ? [node.uuid] : [],
            source: 'node.worldRect',
        };
    }

    let bounds: Record<string, any> | null = null;
    try {
        bounds = helpers.contentBounds() as Record<string, any>;
    } catch (err) {
        return { spec, world: null, uuids: [], source: 'contentBounds', note: `算内容包围盒失败：${errorInfo(err).message}` };
    }
    const width = typeof bounds.width === 'number' ? bounds.width : 0;
    const height = typeof bounds.height === 'number' ? bounds.height : 0;
    const uuids = Array.isArray(bounds.uuids) ? bounds.uuids.filter((u: unknown) => typeof u === 'string') : [];
    if (width <= 0 || height <= 0) {
        return {
            spec,
            world: null,
            uuids,
            source: 'contentBounds',
            note: '场景里没有带 UITransform 的内容节点，量不出内容范围（取景跳过）',
        };
    }
    return {
        spec,
        world: { cx: bounds.cx, cy: bounds.cy, width, height },
        uuids,
        source: 'contentBounds',
        note: typeof bounds.note === 'string' ? bounds.note : undefined,
    };
}

/** 相机的「视角签名」—— 回执里给它，还原成功与否也用它判。 */
function cameraSignature(cam: any): Record<string, any> {
    const out: Record<string, any> = {};
    const node = cam && cam.node ? cam.node : null;
    if (node) {
        try {
            const p = node.worldPosition;
            if (p) out.position = { x: round3(p.x), y: round3(p.y), z: round3(p.z) };
        } catch {
            /* 忽略 */
        }
        try {
            const r = node.worldRotation;
            if (r) out.rotation = { x: round3(r.x), y: round3(r.y), z: round3(r.z), w: round3(r.w) };
        } catch {
            /* 忽略 */
        }
    }
    const orthoHeight = safeNumber(() => cam.orthoHeight);
    if (orthoHeight !== null) out.orthoHeight = orthoHeight;
    const fov = safeNumber(() => cam.fov);
    if (fov !== null) out.fov = fov;
    const projection = safeNumber(() => cam.projection);
    if (projection !== null) out.projection = projection;
    return out;
}

/** 两个视角签名是不是「同一个视角」（容差放宽到「肉眼分不出」的量级）。 */
function sameCamera(a: Record<string, any> | null, b: Record<string, any> | null): boolean {
    if (!a || !b) return false;
    const pa = a.position;
    const pb = b.position;
    if (pa && pb) {
        if (Math.abs(pa.x - pb.x) > 0.5 || Math.abs(pa.y - pb.y) > 0.5 || Math.abs(pa.z - pb.z) > 0.5) return false;
    } else if (Boolean(pa) !== Boolean(pb)) {
        return false;
    }
    const ha = a.orthoHeight;
    const hb = b.orthoHeight;
    if (typeof ha === 'number' || typeof hb === 'number') {
        if (typeof ha !== 'number' || typeof hb !== 'number') return false;
        const scale = Math.max(Math.abs(ha), Math.abs(hb), 1e-6);
        if (Math.abs(ha - hb) / scale > 0.005) return false;
    }
    if (typeof a.fov === 'number' && typeof b.fov === 'number' && Math.abs(a.fov - b.fov) > 0.01) return false;
    const ra = a.rotation;
    const rb = b.rotation;
    if (ra && rb) {
        const dot = ra.x * rb.x + ra.y * rb.y + ra.z * rb.z + ra.w * rb.w;
        if (Math.abs(dot) < 0.9999) return false;
    }
    return true;
}

/** 取景前的相机状态（还原的来源）。 */
interface SavedCamera {
    signature: Record<string, any>;
    /** 编辑器自己的视角信息（`cce.Camera.getCurCameraInfo()`）—— 还原的首选输入 */
    info: any | null;
    /** 相机字段（`focus` 还原不了时的兜底来源） */
    raw: { orthoHeight: number | null; fov: number | null; projection: number | null };
}

function saveCameraState(manager: any, cam: any): SavedCamera {
    let info: any = null;
    try {
        if (typeof manager.getCurCameraInfo === 'function') info = manager.getCurCameraInfo();
    } catch {
        info = null;
    }
    return {
        signature: cameraSignature(cam),
        info,
        raw: {
            orthoHeight: safeNumber(() => cam.orthoHeight),
            fov: safeNumber(() => cam.fov),
            projection: safeNumber(() => cam.projection),
        },
    };
}

/** 直接把相机字段写回去（兜底还原）。@returns 出问题时的说明；顺利则 null。 */
function writeBackCamera(cam: any, saved: SavedCamera): string | null {
    const problems: string[] = [];
    const node = cam && cam.node ? cam.node : null;
    const sig = saved.signature;
    if (node && sig.position) {
        try {
            const p = sig.position;
            if (typeof node.setWorldPosition === 'function') node.setWorldPosition(p.x, p.y, p.z);
            else node.worldPosition = p;
        } catch (err) {
            problems.push(`位置写回失败（${errorInfo(err).message}）`);
        }
    }
    if (node && sig.rotation) {
        try {
            const r = sig.rotation;
            if (typeof node.setWorldRotation === 'function') {
                const Quat = (getCc() as any).Quat;
                node.setWorldRotation(new Quat(r.x, r.y, r.z, r.w));
            }
        } catch (err) {
            problems.push(`朝向写回失败（${errorInfo(err).message}）`);
        }
    }
    if (saved.raw.orthoHeight !== null) {
        try {
            cam.orthoHeight = saved.raw.orthoHeight;
        } catch (err) {
            problems.push(`orthoHeight 写回失败（${errorInfo(err).message}）`);
        }
    }
    if (saved.raw.fov !== null) {
        try {
            cam.fov = saved.raw.fov;
        } catch {
            /* 2D 相机没有 fov 是正常的 */
        }
    }
    if (saved.raw.projection !== null) {
        try {
            cam.projection = saved.raw.projection;
        } catch {
            /* 同上 */
        }
    }
    return problems.length > 0 ? problems.join('；') : null;
}

/**
 * 还原视角：先走编辑器自己的通道，不行再直接写回相机字段。
 *
 * 两条路都失败时**如实回 `restored:false`** —— 调用方会把它写进回执，
 * 用户就知道"我的视角被留在取景后的位置了，按 F 或双击节点可以回去"。
 */
function restoreCameraState(
    manager: any,
    cam: any,
    saved: SavedCamera,
): { restored: boolean; method: 'info' | 'raw' | null; after: Record<string, any>; note?: string } {
    const notes: string[] = [];
    if (saved.info) {
        try {
            manager.focus(null, saved.info, true);
        } catch (err) {
            notes.push(`focus(null, info) 还原失败：${errorInfo(err).message}`);
        }
        const afterInfo = cameraSignature(cam);
        if (sameCamera(afterInfo, saved.signature)) return { restored: true, method: 'info', after: afterInfo };
        notes.push('focus(null, info) 没能把视角还原回原样');
    } else {
        notes.push('拿不到编辑器视角信息（getCurCameraInfo 不可用），只能直接写回相机字段');
    }

    const writeNote = writeBackCamera(cam, saved);
    if (writeNote) notes.push(writeNote);
    const afterRaw = cameraSignature(cam);
    if (sameCamera(afterRaw, saved.signature)) return { restored: true, method: 'raw', after: afterRaw };
    notes.push('直接写回相机字段也没能还原');
    return { restored: false, method: null, after: afterRaw, note: notes.join('；') };
}

/**
 * 手工取景（**仅 2D 正交**）：量出「相机像素 / 世界单位」再把相机摆回去。
 *
 * 两步，都不假设引擎内部怎么算的：
 * 1. **缩放**：`orthoHeight` 与「像素/世界单位」成反比（正交投影里可见世界高度 = 2·orthoHeight），
 *    所以按**量出来的**比值缩一下即可 —— 不用知道它到底是半高还是全高；
 * 2. **对中**：把内容中心投到屏幕上，看它离视口中心差多少像素，再按斜率换成世界单位挪相机。
 *    **斜率是量出来的**（投影两个相距 100 世界单位的点），所以"相机朝哪边看 / 屏幕 y 朝哪边"
 *    都不用假设；量一次纠一次，两次就收敛。
 */
function manualOrthoFit(
    cc: any,
    cam: any,
    world: { cx: number; cy: number; width: number; height: number },
    margin: number,
): { ok: boolean; note?: string; detail?: Record<string, unknown> } {
    const width = safeNumber(() => cam.camera.width) || 0;
    const height = safeNumber(() => cam.camera.height) || 0;
    const orthoHeight = safeNumber(() => cam.orthoHeight);
    const node = cam && cam.node ? cam.node : null;
    if (!width || !height || !orthoHeight || !node) {
        return { ok: false, note: '量不到相机尺寸/orthoHeight 或拿不到相机节点，手工取景跳过' };
    }

    const Vec3 = cc.Vec3;
    const project = (x: number, y: number): { x: number; y: number } | null => {
        try {
            const point = cam.worldToScreen(new Vec3(x, y, 0));
            return { x: point.x, y: point.y };
        } catch {
            return null;
        }
    };

    const probe = (): { kx: number; ky: number; center: { x: number; y: number } } | null => {
        const p0 = project(world.cx, world.cy);
        const px = project(world.cx + PROBE_UNITS, world.cy);
        const py = project(world.cx, world.cy + PROBE_UNITS);
        if (!p0 || !px || !py) return null;
        const kx = (px.x - p0.x) / PROBE_UNITS;
        const ky = (py.y - p0.y) / PROBE_UNITS;
        if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx === 0 || ky === 0) return null;
        return { kx, ky, center: p0 };
    };

    const first = probe();
    if (!first) return { ok: false, note: 'worldToScreen 量不出「像素/世界单位」（相机可能还没准备好）' };

    /** ① 缩放：让目标矩形在留白之后刚好装进画布 */
    const wantK = Math.min(
        (width * (1 - margin * 2)) / (world.width > 0 ? world.width : 1),
        (height * (1 - margin * 2)) / (world.height > 0 ? world.height : 1),
    );
    try {
        cam.orthoHeight = orthoHeight * (first.kx / wantK);
    } catch (err) {
        return { ok: false, note: `写 orthoHeight 失败：${errorInfo(err).message}` };
    }

    /** ② 对中：量残余 → 按斜率挪相机，两次（正交是线性的，两次足够收敛到亚像素） */
    let residual: { x: number; y: number } | null = null;
    for (let i = 0; i < 2; i += 1) {
        const measured = probe();
        if (!measured) break;
        residual = { x: width / 2 - measured.center.x, y: height / 2 - measured.center.y };
        // ∂screen/∂相机位置 = −(∂screen/∂世界位置)，所以除以 −k
        const dx = residual.x / -measured.kx;
        const dy = residual.y / -measured.ky;
        try {
            const pos = node.worldPosition;
            if (typeof node.setWorldPosition === 'function') node.setWorldPosition(pos.x + dx, pos.y + dy, pos.z);
            else node.worldPosition = { x: pos.x + dx, y: pos.y + dy, z: pos.z };
        } catch (err) {
            return { ok: false, note: `挪相机失败：${errorInfo(err).message}` };
        }
    }

    return {
        ok: true,
        detail: {
            scale: round3(orthoHeight * (first.kx / wantK)),
            pxPerUnitBefore: round3(first.kx),
            pxPerUnitWanted: round3(wantK),
            centerResidualPx: residual ? { x: round3(residual.x), y: round3(residual.y) } : null,
        },
    };
}

/** 一次取景的现场（等着被还原的视角）。同一时刻只允许一个 —— 截图是串行的。 */
let pendingFit: { token: string; saved: SavedCamera; startedAt: number } | null = null;

/** 取景现场超过这个时间还没被还原就作废（别把几分钟前的旧视角盖回用户脸上）。 */
const FIT_STATE_TTL_MS = 60_000;

/** 取景 token 的自增尾巴（同一毫秒内多次取景也能区分）。 */
let fitCounter = 0;

interface FitViewPayload {
    /** `'fit'`（默认）摆一级取景 / `'end'` 还原视角 */
    action?: unknown;
    /** 取景级别（0 = 编辑器 focus / 1 = 控制器适配 / 2 = 手工） */
    step?: unknown;
    /** 取景目标 `{kind:'scene'|'node', ref?}` */
    fit?: unknown;
    /** `kind:'node'` 时的节点引用（也可写在 `fit.ref` 里） */
    node?: unknown;
    projectPath?: unknown;
}

/** 执行第 `step` 级取景。@returns `method: null` = 这一级没做成（原因在 note） */
function applyFitStep(
    cc: any,
    manager: any,
    cam: any,
    step: number,
    target: FitTarget,
    is2D: boolean | null,
): { method: 'focus' | 'adjust' | 'manual' | null; note?: string; detail?: Record<string, unknown> } {
    if (!target.world) return { method: null, note: target.note || '没有可用的世界矩形，取景跳过' };

    if (step === 0) {
        if (typeof manager.focus !== 'function') return { method: null, note: 'cce.Camera.focus 不存在（编辑器版本差异）' };
        if (target.uuids.length === 0) return { method: null, note: '没有可聚焦的 uuid（内容节点没有 uuid？）' };
        try {
            manager.focus(target.uuids, undefined, true);
        } catch (err) {
            return { method: null, note: `cce.Camera.focus 抛异常：${errorInfo(err).message}` };
        }
        return { method: 'focus' };
    }

    if (step === 1) {
        if (is2D !== true) return { method: null, note: '非 2D 视图没有 _adjustToCenter（3D 只走 focus）' };
        const controller = manager.controller2D;
        if (!controller || typeof controller._adjustToCenter !== 'function') {
            return { method: null, note: 'cce.Camera.controller2D._adjustToCenter 不存在（编辑器版本差异）' };
        }
        try {
            const rect = new cc.Rect(
                target.world.cx - target.world.width / 2,
                target.world.cy - target.world.height / 2,
                target.world.width,
                target.world.height,
            );
            controller._adjustToCenter(FIT_MARGIN, rect, true);
        } catch (err) {
            return { method: null, note: `_adjustToCenter 抛异常：${errorInfo(err).message}` };
        }
        return { method: 'adjust' };
    }

    if (step === 2) {
        if (is2D !== true) return { method: null, note: '手工取景只实现了 2D 正交（3D 要动 FOV/距离，先不做）' };
        const applied = manualOrthoFit(cc, cam, target.world, FIT_MARGIN);
        return { method: applied.ok ? 'manual' : null, note: applied.note, detail: applied.detail };
    }

    return { method: null, note: `没有第 ${step} 级取景` };
}

/** 2D 能用三级，3D 只有 focus 一级（其余两级都没实现/不适用）。 */
function maxFitSteps(is2D: boolean | null): number {
    return is2D === true ? 3 : 1;
}

interface ViewMetricsPayload {
    /** 节点 uuid 或路径（如 `'Canvas/skill_details'`）；不给就只回视图几何 */
    node?: unknown;
    projectPath?: unknown;
    /** 要「拍全」的目标（`{kind:'scene'|'node', ref?}`）—— 决定 `framing` 量的是哪块矩形 */
    fit?: unknown;
}

/**
 * 场景视图几何（`contributions.scene` 的 `viewMetrics`）。
 *
 * @returns `{ok, page, canvas, view, camera, node?, framing?}` —— 主进程拿它定位
 *   webContents、换算裁切矩形；`node.rect` 是**页面 CSS 像素**（左上角原点）；
 *   给了 `fit` 时再多一项 `framing`：**目标有没有整个落在画布里**（取景链的判据）。
 */
function collectViewMetrics(cc: any, payload: ViewMetricsPayload): Record<string, unknown> {
    const canvas = findViewCanvas(cc);
    const camera = editorCamera();
    const cam = camera.cam;

    const metrics: Record<string, unknown> = {
        ok: true,
        page: pageGeometry(),
        canvas: canvasGeometry(canvas),
        view: canvas ? readViewState(cc, canvas) : null,
        camera: {
            available: Boolean(cam),
            is2D: camera.is2D,
            note: camera.note,
            ...(cam
                ? {
                      width: safeNumber(() => cam.camera.width),
                      height: safeNumber(() => cam.camera.height),
                      orthoHeight: safeNumber(() => cam.orthoHeight),
                      screenScale: safeNumber(() => cam.screenScale),
                      signature: cameraSignature(cam),
                  }
                : {}),
        },
    };

    const ref = typeof payload.node === 'string' ? payload.node.trim() : '';
    const fitSpec = normalizeFitSpec(payload.fit);
    if (!ref && !fitSpec) return metrics;

    const helpers = makeHelpers(cc, {
        projectPath: typeof payload.projectPath === 'string' ? payload.projectPath : '',
    }).helpers as Record<string, any>;

    let node: any = null;
    if (ref) {
        try {
            node = helpers.nodeByUuid(ref) || helpers.nodeByPath(ref) || null;
        } catch (err) {
            metrics.node = { ref, found: false, note: `按 uuid/路径找节点时出错：${errorInfo(err).message}` };
            return metrics;
        }
        if (!node) {
            metrics.node = {
                ref,
                found: false,
                note: '按 uuid 与路径都没找到这个节点（uuid 用 node.uuid，路径如 Canvas/skill_details）',
            };
            return metrics;
        }

        const info: Record<string, unknown> = { ref, found: true, uuid: node.uuid, name: node.name };
        try {
            info.worldRect = helpers.worldRect(node);
        } catch {
            /* 忽略：世界矩形只是附带信息 */
        }
        if (!cam) {
            info.rect = null;
            info.note = `${camera.note || '编辑器相机不可用'}：算不出节点在视图里的矩形（会退成整张视图）`;
            metrics.node = info;
        } else {
            const projected = projectNodeRect(cc, cam, node, canvas);
            info.rect = projected.rect;
            info.canvasRect = projected.canvasRect;
            if (projected.note) info.note = projected.note;
            metrics.node = info;
        }
    }

    /** 取景报告：目标矩形 vs 画布矩形（「拍全了没有」） */
    if (fitSpec) {
        const viewport = viewportOf(canvas);
        const target = fitTargetOf(helpers, fitSpec, node);
        const framing: Record<string, unknown> = {
            target: {
                kind: fitSpec.kind,
                ref: fitSpec.ref || null,
                /** 这块矩形是从哪来的 —— 取景量错了，看它就够了 */
                source: target.source,
                /** 交给 focus 的 uuid（个数就够定位问题了） */
                uuids: target.uuids.length,
                world: target.world,
            },
            viewport,
            covered: false,
            areaRatio: 0,
            note: target.note,
        };
        if (!viewport) {
            framing.note = '量不到画布矩形（画布还没铺开），判断不了拍全没有';
        } else if (!cam) {
            framing.note = camera.note || '编辑器相机不可用，判断不了拍全没有';
        } else {
            /** 目标矩形：节点目标直接用**已经算好的**节点矩形（同一份投影，不重复走一遍） */
            const nodeRect = metrics.node ? ((metrics.node as Record<string, any>).rect as Record<string, number> | null) : null;
            let pageRect: Record<string, number> | null = null;
            if (fitSpec.kind === 'node') {
                pageRect = nodeRect && typeof nodeRect.width === 'number' ? nodeRect : null;
                if (!pageRect) framing.note = framing.note || '节点算不出矩形，判断不了拍全没有';
            } else if (target.world) {
                const projected = projectWorldBox(cc, cam, canvas, {
                    cx: target.world.cx,
                    cy: target.world.cy,
                    wz: 0,
                    width: target.world.width,
                    height: target.world.height,
                });
                pageRect = projected.rect;
                if (!pageRect && projected.note) framing.note = framing.note || projected.note;
            }
            if (pageRect) {
                const coverage = coverageOf(pageRect, viewport);
                framing.covered = coverage.covered;
                framing.areaRatio = coverage.areaRatio;
                framing.edges = coverage.edges;
                framing.targetPage = pageRect;
            }
        }
        metrics.framing = framing;
    }

    return metrics;
}
interface HelperBundle {
    helpers: Record<string, unknown>;
    state: { snapshotRequested: boolean };
}

/**
 * 构造注入沙箱的助手函数。
 *
 * 这些是「AI 写代码时的起手式」——没有它们，模型每次都要从
 * `cc.director.getScene()` 开始手搓遍历，既费 token 又容易写错。
 */
function makeHelpers(cc: any, options?: { projectPath?: string }): HelperBundle {
    const state = { snapshotRequested: false };

    const helpers: Record<string, unknown> = {};

    /**
     * 工程根 —— **优先用主进程随 payload 传进来的那个**（`Editor.Project.path`），
     * 拿不到再退回 `currentProjectPath()`（场景进程里的 `Editor` 全局量）。
     * 两个都没有时只影响「按路径解析资源」这一件事，其余助手照常。
     */
    const projectRoot = (): string => {
        const fromPayload = typeof options?.projectPath === 'string' ? options.projectPath : '';
        return fromPayload || currentProjectPath();
    };

    // -----------------------------------------------------------------------
    // 编辑器装饰节点判据 —— 场景树里 97% 的节点不是你的内容
    // -----------------------------------------------------------------------
    //
    // 场景进程里 `director.getScene()` 拿到的树**包含编辑器自己挂的 gizmo / 网格 /
    // 参考图**。实测（Cocos 3.8.6，一个只有 Canvas 的空场景）：
    //
    //     总节点 128
    //     ├─ Canvas                        2   ← 唯一的真实内容
    //     ├─ Editor Scene Foreground     117   ← 坐标轴 gizmo / 网格 / 各种控制器
    //     └─ Editor Scene Background       8   ← 背景与参考图
    //
    // 不滤掉的话 `eachNode` / `tree()` 里 97% 是噪声，模型会照着 gizmo 的节点名
    // （`xAxis` / `Rectangle` / `Plane` / `LinesNode`…）去推断游戏结构。
    //
    // ## 两条被实测否掉的直觉
    //
    // ❌ **按 layer 掩码滤**：不行。编辑器根 `Editor Scene Foreground` 与真实相机
    //    `Canvas/Camera` **同为 `Layers.DEFAULT`(1073741824)**；GIZMOS/EDITOR 位只覆盖
    //    子树的一部分（还有 5242880、16777216 等混合值）—— 按层滤会误伤真实节点。
    // ❌ **按 `gizmoRoot` 这类名字滤**：不行。名字是实现细节，而且覆盖不了 Background 那棵。
    //
    // ✅ **按 `HideInHierarchy` 位滤**（= 编辑器自己「别在层级面板里显示我」的标记，
    //    语义正好就是要的这个）。实测两个编辑器根的 `objFlags` 都是
    //    `1096 = HideInHierarchy|DontDestroy|DontSave`，而真实节点（含 Camera）是 0。
    //
    // ⚠ 关键细节：这个位**只在两个根上**，`gizmoRoot` 自身的 `objFlags` 是 0 ——
    //    所以判据必须用在**剪枝**上（剪掉根，整棵子树自然都没了），
    //    而不是逐节点过滤（逐节点会留下 gizmoRoot 那一整棵）。
    const hideInHierarchy = (() => {
        try {
            const flags = cc.CCObject && cc.CCObject.Flags;
            if (flags && typeof flags.HideInHierarchy === 'number') return flags.HideInHierarchy;
        } catch {
            /* 引擎版本变动时回落到 3.8.6 的实测值 */
        }
        return 1024;
    })();

    /** 名字兜底：万一哪天 `Flags.HideInHierarchy` 挪位了，这两个根还能被认出来 */
    const editorRootNames = ['Editor Scene Foreground', 'Editor Scene Background'];

    const isEditorNode = (node: any): boolean => {
        if (!node) return false;
        try {
            // `hideFlags` 是 CCObject 的公开访问器（内部已 & AllHideMasks），优先用它
            const flags =
                typeof node.hideFlags === 'number'
                    ? node.hideFlags
                    : typeof node._objFlags === 'number'
                      ? node._objFlags
                      : 0;
            if ((flags & hideInHierarchy) !== 0) return true;
        } catch {
            /* 取不到标志位就只剩名字兜底 */
        }
        return editorRootNames.indexOf(node.name) >= 0;
    };

    /** 子节点里属于「真实内容」的那些 */
    const contentChildren = (node: any): any[] => {
        const children: any[] = (node && node.children) || [];
        return children.filter((child: any) => !isEditorNode(child));
    };

    /**
     * 按 `/` 分段解析路径。
     *
     * **为什么不能只用 `cc.find`**：`cc.find('a/b')` 是按 `/` 切开逐层找子节点，
     * 于是**节点名里含 `/` 的路径永远找不到**。实测工程里就存在
     * `internal/editor/grid-2d` 与 `internal/editor/grid` 这种名字
     * （编辑器自己生成的），`cc.find` 对它们一律返回 null —— 而且**静默返回 null**，
     * 调用方只会以为"节点不存在"。
     *
     * 这里改成**贪心按段匹配**：每层从「最长的一段」开始试，先把 `internal/editor/grid-2d`
     * 整体当成一个节点名去试，不行再退化成 `internal` → `editor` → `grid-2d` 三层。
     * 两种场景都能解析，代价是理论上存在歧义（同时存在名为 `a/b` 的节点与 `a` 下的 `b`）——
     * 那种情况优先认「名字更长」的那个，符合直觉。
     */
    const resolvePathBySegments = (path: string): any => {
        const scene = currentScene(cc);
        if (!scene) return null;
        const segments = String(path)
            .split('/')
            .filter((segment: string) => segment.length > 0);
        if (segments.length === 0) return scene;

        // 允许把场景自己的名字写在最前面
        if (segments[0] === scene.name) segments.shift();
        if (segments.length === 0) return scene;

        let cursor: any = scene;
        let index = 0;
        while (index < segments.length) {
            let found: any = null;
            for (let end = segments.length; end > index; end -= 1) {
                const candidate = segments.slice(index, end).join('/');
                let child: any = null;
                try {
                    child = cursor.getChildByName(candidate);
                } catch {
                    child = null;
                }
                if (child) {
                    found = child;
                    index = end;
                    break;
                }
            }
            if (!found) return null;
            cursor = found;
        }
        return cursor;
    };

    /** 按 uuid 找节点（先走引擎快路径，找不到再整树扫） */
    helpers.nodeByUuid = (uuid: string): any => {
        const scene = currentScene(cc);
        if (!scene) return null;
        if (scene.uuid === uuid) return scene;
        try {
            const fast = scene.getChildByUuid(uuid);
            if (fast) return fast;
        } catch {
            /* 引擎内部实现变动时回落到整树扫描 */
        }
        let found: any = null;
        eachNode(scene, (n: any) => {
            if (!found && n.uuid === uuid) found = n;
        });
        return found;
    };

    /**
     * 按路径找节点，如 `'Canvas/skill_details'`。
     *
     * 先给引擎的 `cc.find` 试（它认得 `..` 之类的边角语义），失败再自己按段解析 ——
     * 后者才能处理**名字里含 `/`** 的节点（实测存在 `internal/editor/grid-2d`）。
     * 编辑器装饰节点**照样找得到**（显式点名就不该被藏）。
     */
    helpers.nodeByPath = (path: string): any => {
        try {
            const fast = cc.find(path);
            if (fast) return fast;
        } catch {
            /* 回落 */
        }
        return resolvePathBySegments(path);
    };

    /**
     * 遍历场景树（默认**跳过编辑器装饰节点**）。
     *
     * @param visit 访问函数
     * @param root 起始节点，默认场景根
     * @param options.includeEditor 为 true 时连 gizmo/网格/参考图一起遍历
     */
    helpers.eachNode = (
        visit: (node: any) => void,
        root?: any,
        options?: { includeEditor?: boolean },
    ): void => {
        const start = root || currentScene(cc);
        if (!start) return;
        const includeEditor = Boolean(options && options.includeEditor);
        // 迭代式深度优先；剪枝发生在「入栈」这一步（跳过编辑器根，整棵子树就没了）
        const stack: any[] = [start];
        while (stack.length > 0) {
            const node = stack.pop();
            visit(node);
            const children: any[] = node.children || [];
            for (let i = children.length - 1; i >= 0; i -= 1) {
                const child = children[i];
                if (!includeEditor && isEditorNode(child)) continue;
                stack.push(child);
            }
        }
    };

    /**
     * 场景树概览 —— 一次拿到层级骨架，比 `return scene` 有用得多。
     *
     * 默认**跳过编辑器装饰节点**（见 {@link isEditorNode} 的说明）；
     * 需要连 gizmo 一起看就传 `includeEditor: true`。
     *
     * @param options.maxDepth 默认 3
     * @param options.withComponents 是否带上每个节点的组件类型名
     * @param options.includeEditor 是否包含编辑器 gizmo/网格/参考图，默认 false
     */
    helpers.tree = (
        options?: { root?: any; maxDepth?: number; withComponents?: boolean; includeEditor?: boolean },
    ): Record<string, unknown> | null => {
        const opts = options || {};
        const root = opts.root || currentScene(cc);
        if (!root) return null;
        const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 3;
        const includeEditor = Boolean(opts.includeEditor);

        const build = (node: any, depth: number): Record<string, unknown> => {
            const out: Record<string, unknown> = {
                name: node.name,
                uuid: node.uuid,
                active: node.active,
            };
            if (opts.withComponents) {
                out.components = (node.components || []).map((c: any) => {
                    try {
                        return { type: cc.js.getClassName(c), enabled: c.enabled };
                    } catch {
                        return { type: 'unknown' };
                    }
                });
            }
            const allChildren: any[] = node.children || [];
            const children = includeEditor
                ? allChildren
                : allChildren.filter((child: any) => !isEditorNode(child));
            if (children.length > 0) {
                out.childCount = children.length;
                if (depth < maxDepth) {
                    out.children = children.map((c: any) => build(c, depth + 1));
                } else {
                    out.children = children.map((c: any) => ({ name: c.name, uuid: c.uuid }));
                }
            }
            // 藏了东西就说一声，别让调用方以为树就这么大
            const hidden = allChildren.length - children.length;
            if (hidden > 0) out.editorChildrenHidden = hidden;
            return out;
        };
        return build(root, 0);
    };

    /** 这个节点是不是编辑器自己的装饰（gizmo / 网格 / 参考图） */
    helpers.isEditorNode = (node: any): boolean => isEditorNode(node);

    /** 真实内容子节点（已滤掉编辑器装饰） */
    helpers.contentChildren = (node?: any): any[] => contentChildren(node || currentScene(cc));

    /**
     * 展开一个节点或组件为纯数据对象。
     *
     * 这是 `engineObjectTag` 摘要的「逃生舱」：返回值序列化时默认把 cc 对象压成
     * `[Node name=x uuid=y]`，想看细节就得走 `dump()`，它会**显式取字段**，
     * 于是既拿得到数据，又不会因为循环引用炸掉。
     */
    helpers.dump = (target: any): Record<string, unknown> | null => {
        if (!target) return null;

        // 是组件（有 node 字段且自身不是 Node）
        if (target.node && !target.children) {
            const out: Record<string, unknown> = {
                __kind: 'component',
                type: (() => {
                    try {
                        return cc.js.getClassName(target);
                    } catch {
                        return target.constructor && target.constructor.name;
                    }
                })(),
                node: shortNode(target.node),
                enabled: target.enabled,
            };
            const props: Record<string, unknown> = {};
            for (const key of componentPropNames(target)) {
                const read = safeRead(target, key);
                if (read.ok) props[key] = read.value;
            }
            out.props = props;
            return out;
        }

        // 是节点
        if (target.children && typeof target.uuid === 'string') {
            const components: Record<string, unknown>[] = [];
            for (const comp of target.components || []) {
                let typeName = 'unknown';
                try {
                    typeName = cc.js.getClassName(comp);
                } catch {
                    typeName = (comp.constructor && comp.constructor.name) || 'unknown';
                }
                const props: Record<string, unknown> = {};
                for (const key of componentPropNames(comp)) {
                    const read = safeRead(comp, key);
                    if (read.ok) props[key] = read.value;
                }
                components.push({ type: typeName, enabled: comp.enabled, props });
            }
            return {
                __kind: 'node',
                name: target.name,
                uuid: target.uuid,
                active: target.active,
                activeInHierarchy: target.activeInHierarchy,
                layer: target.layer,
                position: target.position,
                rotation: target.rotation,
                scale: target.scale,
                parent: shortNode(target.parent),
                children: (target.children || []).map((c: any) => shortNode(c)),
                components,
            };
        }

        return { __kind: 'plain', value: target };
    };

    /**
     * 请求一次撤销快照。
     *
     * 本函数**只置标志位**，真正的 `Editor.Message.request('scene','snapshot')`
     * 由主进程在拿到返回值之后执行 —— 原因：场景脚本自己跑在 scene 进程里，
     * 从 scene 进程再 `Editor.Message.request('scene', ...)` 是给自己发消息，
     * 轻则排队重则自锁。跨进程的事交给发起方做。
     */
    helpers.snapshot = (): void => {
        state.snapshotRequested = true;
    };

    /** 睡眠指定毫秒（配合 `await` 做轮询，比让模型在 tool call 之间干等省得多） */
    helpers.sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, Math.max(0, Math.min(60000, ms | 0)));
        });

    /**
     * 截取**编辑器场景视图**当前一帧，存成 PNG/JPEG。
     *
     * 所见即所得（含网格与 gizmo），用来「看一眼画面」而不是「读一串坐标」——
     * 布局叠字、贴图空白、节点跑出屏幕这类问题，看画面一秒就能发现。
     *
     * @param options.savePath 目标文件**绝对路径**。给了就自己落盘，返回值只带路径（小）；
     *   不给、或本环境写不了盘，回落「分块回传」，由主进程拼回来落盘。
     * @param options.maxWidth 缩到不超过这个宽度，默认 640（越小越快、回传越小）
     * @param options.format `'png'`（默认，无损）或 `'jpeg'`（体积小）
     * @param options.quality jpeg 质量 0.1~1，默认 0.9
     * @param options.waitMs 等下一帧的上限，默认 800ms（场景视图没在渲染时兜底直接抓当前缓冲）
     */
    helpers.captureView = async (
        options?: {
            savePath?: string;
            maxWidth?: number;
            format?: string;
            quality?: number;
            waitMs?: number;
        },
    ): Promise<Record<string, unknown>> => {
        const opts = options || {};
        const format = opts.format === 'jpeg' || opts.format === 'jpg' ? 'jpeg' : 'png';
        const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = typeof opts.quality === 'number' ? Math.min(1, Math.max(0.1, opts.quality)) : 0.9;
        const maxWidth = typeof opts.maxWidth === 'number' && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 640;
        const waitMs = typeof opts.waitMs === 'number' ? Math.max(0, Math.min(5000, opts.waitMs)) : 800;

        const canvas = findViewCanvas(cc);
        if (!canvas) return { ok: false, error: '找不到场景视图的画布：scene 进程里没有可用的 canvas。' };

        let frame: { width: number; height: number; pixels: Uint8Array };
        try {
            frame = await readViewPixels(cc, canvas, waitMs);
        } catch (err) {
            return { ok: false, error: `读取画面失败：${errorInfo(err).message}` };
        }

        let encoded: { dataUrl: string; width: number; height: number };
        try {
            encoded = encodeFrameToDataUrl(frame.pixels, frame.width, frame.height, {
                maxWidth,
                mime,
                quality,
            });
        } catch (err) {
            return { ok: false, error: `编码图片失败：${errorInfo(err).message}` };
        }

        const comma = encoded.dataUrl.indexOf(',');
        const base64 = comma >= 0 ? encoded.dataUrl.slice(comma + 1) : '';
        const info: Record<string, unknown> = {
            ok: true,
            width: encoded.width,
            height: encoded.height,
            sourceWidth: frame.width,
            sourceHeight: frame.height,
            format,
            bytes: Math.floor((base64.length * 3) / 4),
            blankRatio: sampleBlankRatio(frame.pixels),
            // 空图时这一块就是答案的一半：见 readViewState 的注释（设备模拟被打掉的那次事故）
            view: readViewState(cc, canvas),
        };

        const savePath = typeof opts.savePath === 'string' && opts.savePath.trim() ? opts.savePath.trim() : '';
        const node = getNodeModules();
        if (savePath && node) {
            try {
                const dir = node.path.dirname(savePath);
                if (dir) node.fs.mkdirSync(dir, { recursive: true });
                node.fs.writeFileSync(savePath, Buffer.from(base64, 'base64'));
                return { ...info, transport: 'file', path: savePath };
            } catch (err) {
                // 写不进去也要让调用方拿到图 —— 回落分块
                info.saveError = errorInfo(err).message;
            }
        }

        const chunkSize = 3000; // 沙箱单字符串上限 4000，留出余量
        const chunks: string[] = [];
        for (let i = 0; i < base64.length; i += chunkSize) chunks.push(base64.slice(i, i + chunkSize));
        if (chunks.length > 90) {
            return {
                ...info,
                ok: false,
                error:
                    `截图太大，需要回传 ${chunks.length} 块（上限 90）：把 maxWidth 调小` +
                    `（当前 ${maxWidth}）、换 jpeg，或给一个可写的 savePath。`,
            };
        }
        return { ...info, transport: 'chunks', chunkSize, chunks, chunkCount: chunks.length };
    };

    /**
     * 把「资源引用」解析成 `SpriteFrame` —— **别再手搓 uuid，也别用 `cc.resources.load`**。
     *
     * ## 为什么这个助手必须存在（两次实测代价）
     *
     * 编辑器场景上下文里「给一个 Sprite 赋图片」这件事，**三条直觉全是错的**：
     *
     * | 直觉写法 | 实测结果 |
     * |---|---|
     * | `cc.resources.load('textures/x/spriteFrame', cc.SpriteFrame, cb)` | `Can not parse this input: {"path":…,"bundle":""}` —— 编辑器场景里 `cc.resources` 这一档没被正确初始化 |
     * | `query-assets({pattern:'db://assets/…/x.png/spriteFrame'})` | **静默返回空数组**（不报错）→ 以为「没有这个子资源」 |
     * | 直接把图片 uuid 当 SpriteFrame 用 | 拿到的是 `Texture2D`，`Sprite.spriteFrame` 赋值不报错但**画不出来** |
     *
     * 正确的一条是「图片 uuid + `@f9941` 子资源键 → `assetManager.loadAny({uuid})`」，
     * 但那个 `f9941` 是资源库生成的，不该由模型去拼。这里把整条路收进一个函数：
     *
     * ```
     * const sf = await loadFrame('db://assets/resources/textures/common/rect_rd_20.png');
     * const sprite = node.addComponent(cc.Sprite);
     * sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;   // ← 必须先于 spriteFrame（见另一条坑）
     * sprite.spriteFrame = sf;
     * ```
     *
     * ## 接受的三种引用
     *
     * 1. `db://assets/.../x.png`（**推荐**；写成 `.../x.png/spriteFrame` 也行，后缀会被去掉）——
     *    走**磁盘上的 `.meta`**：`assets/<相对路径>.meta` 里 `subMetas` 中 `name === 'spriteFrame'`
     *    那一条的 `uuid` 就是 `<图 uuid>@f9941`。`.meta` 是资源库自己写的，离线可读，
     *    不依赖 `Editor` 在不在、也不需要再去 editor 上下文查一次。
     * 2. `uuid@f9941`（子资源 uuid）—— 直接用。
     * 3. 裸图片 uuid —— 先按原样加载；拿到 `Texture2D` 时**再试一次 `@f9941`**
     *    （Creator 3.x 的 sprite-frame 子资源键就是这个常量），并如实说明是猜的。
     *
     * 解析结果在同一段脚本里会缓存（同一个引用重复取不会重复加载）。
     * 拿不到时**抛出说得清的错误**（试过哪些候选、每个候选拿到了什么类型），
     * 而不是回一个 `null` 让调用方去猜。
     *
     * @param ref - 上面三种引用之一。
     * @returns 该资源的 `SpriteFrame`。
     */
    const frameCache = new Map<string, any>();
    helpers.loadFrame = async (ref: unknown): Promise<any> => {
        const raw = typeof ref === 'string' ? ref.trim() : '';
        if (!raw) {
            throw new Error(
                "loadFrame(ref)：ref 是空的。用法：loadFrame('db://assets/resources/textures/common/rect_rd_20.png')" +
                    "（图片路径，可省 /spriteFrame）或 loadFrame('<uuid>@f9941')。",
            );
        }
        if (frameCache.has(raw)) return frameCache.get(raw);

        const candidates: string[] = [];
        const notes: string[] = [];

        /** 加载一个 uuid（回调式，与编辑器里实测能用的那条路一致）。 */
        const loadAny = (uuid: string): Promise<any> =>
            new Promise((resolve, reject) => {
                try {
                    cc.assetManager.loadAny({ uuid }, (err: any, asset: any) =>
                        err ? reject(new Error(err.message ? String(err.message) : String(err))) : resolve(asset),
                    );
                } catch (err) {
                    reject(new Error(errorInfo(err).message));
                }
            });

        if (/@/.test(raw)) {
            candidates.push(raw);
        } else if (raw.indexOf('db://') === 0) {
            if (raw.indexOf('db://assets/') !== 0) {
                throw new Error(
                    `loadFrame 只认 db://assets/ 下的资源（收到 ${raw}）。` +
                        'db://internal 是引擎自带资源、映射不到工程目录；内置 UI 图请按 skill 里的路径表用 loadAny({uuid}) 那条（uuid 从 asset-db 查）。',
                );
            }
            const rel = raw.slice('db://assets/'.length).replace(/\/(spriteFrame|texture)$/, '');
            const root = projectRoot();
            const nodeMods = getNodeModules();
            if (!root || !nodeMods) {
                notes.push(
                    `拿不到工程根（Editor.Project.path）或 node 模块，所以没能读 ${rel}.meta —— ` +
                        '改用 loadFrame("<uuid>@f9941")（uuid 从 editor 上下文 query-assets 拿）。',
                );
            } else {
                const metaFile = `${nodeMods.path.join(root, 'assets', rel)}.meta`;
                let meta: any = null;
                try {
                    meta = JSON.parse(nodeMods.fs.readFileSync(metaFile, 'utf-8'));
                } catch (err) {
                    notes.push(`读不到 ${rel}.meta（${errorInfo(err).message}）`);
                }
                const subMetas = meta && typeof meta.subMetas === 'object' && meta.subMetas ? meta.subMetas : null;
                if (subMetas) {
                    for (const key of Object.keys(subMetas)) {
                        const entry = subMetas[key] || {};
                        const isSpriteFrame =
                            entry.name === 'spriteFrame' ||
                            entry.importer === 'sprite-frame' ||
                            entry.importer === 'spriteFrame';
                        if (!isSpriteFrame) continue;
                        // 子资源的 uuid 字段本身就带 `@key`；没有就自己拼
                        candidates.push(typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `${meta.uuid}@${key}`);
                        break;
                    }
                    if (candidates.length === 0) {
                        notes.push(`${rel}.meta 里没有 spriteFrame 子资源（它可能不是图片，或还没被资源库导入）`);
                    }
                }
            }
        } else if (/^[0-9a-fA-F-]{32,40}$/.test(raw)) {
            candidates.push(raw);
        } else {
            throw new Error(
                `loadFrame 认不出这个引用：${raw}。给 db://assets/… 的图片路径、uuid@子资源键，或裸 uuid。`,
            );
        }

        let last = '';
        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            try {
                const asset = await loadAny(candidate);
                if (asset && cc.SpriteFrame && asset instanceof cc.SpriteFrame) {
                    frameCache.set(raw, asset);
                    return asset;
                }
                const kind = asset && asset.constructor && asset.constructor.name ? asset.constructor.name : typeof asset;
                last = `${candidate} → ${kind}`;
                // 拿到 Texture2D：补一次标准的 spriteFrame 子资源键（只补一次，别把自己绕进死循环）
                if (kind === 'Texture2D' && candidate.indexOf('@') < 0) {
                    candidates.push(`${candidate}@f9941`);
                    notes.push(`裸 uuid 拿到的资源是 Texture2D，试了一次标准的 @f9941 子资源键`);
                }
            } catch (err) {
                last = `${candidate} → ${errorInfo(err).message}`;
            }
        }

        throw new Error(
            `loadFrame('${raw}') 没能拿到 SpriteFrame。${last ? `最后一次：${last}。` : ''}` +
                (notes.length > 0 ? `另外：${notes.join('；')}。` : '') +
                " 推荐写法：loadFrame('db://assets/resources/textures/common/rect_rd_20.png')。",
        );
    };

    /**
     * 取节点的 `UITransform`（拿不到就 null）。
     *
     * 为什么要包一层：`cc.UITransform` 本身可能取不到（引擎版本/非 UI 节点），
     * 这时 `getComponent(undefined)` 有的版本会抛 —— 布局计算不该因为取不到尺寸而整条挂掉，
     * 宽高按 0 算、把坐标照常报出去更有用（调用方看到 `width: 0` 自然知道是没量到）。
     */
    const uiTransformOf = (node: any): any => {
        try {
            if (!node || typeof node.getComponent !== 'function') return null;
            if (!cc.UITransform) return null;
            return node.getComponent(cc.UITransform) || null;
        } catch {
            return null;
        }
    };

    /**
     * 节点在**编辑态下可信的**世界矩形 —— 别用 `UITransform.getBoundingBoxToWorld()`。
     *
     * ## 为什么不能用引擎那个
     *
     * 实测（Cocos 3.8.6 编辑态）：同一棵树里 `view`（`contentSize` 710×1074、position (0,0)）
     * 被 `getBoundingBoxToWorld()` 报成 **710×1170**，而 1170 恰好是它子节点 `content` 的高度；
     * `content` 的 x 也被报偏。**它给的是自相矛盾的值**，而布局验收全靠这个数。
     *
     * ## 这里的算法（与 `contentSize` 自洽，能手工核对）
     *
     * 父节点的**锚点**就是子节点局部坐标的原点，于是自下而上累加：
     *
     * ```
     * 锚点世界坐标(n) = 锚点世界坐标(parent) + scale链(n) ⊙ n.position
     * 中心世界坐标(n) = 锚点世界坐标(n) + scale链(n) ⊙ ((0.5-ax)·w, (0.5-ay)·h)
     * 世界尺寸(n)     = scale链(n) ⊙ (w, h)        // 不考虑旋转
     * ```
     *
     * `scale链(n)` = n **所有祖先**（不含自己）的 scale 乘积；`root` 本身不参与累加，
     * 所以给 `root` 时返回值就是**以 root 的锚点为原点**的坐标（这正是"这张卡在 Canvas 里
     * 偏了多少"要的那个数）。不给 `root` 就一路累加到场景根。
     *
     * @param node - 目标节点。
     * @param options.root - 累加的终点（返回坐标以它的锚点为原点）；默认场景根。
     * @returns `{cx, cy, width, height, left, right, bottom, top, anchorX, anchorY, scaleX, scaleY}`
     *   —— `left/right/bottom/top` 是矩形的四条边，`cx/cy` 是中心。**坐标系为「+x 向右、+y 向上」**。
     */
    helpers.worldRect = (
        node: any,
        options?: { root?: any },
    ): Record<string, unknown> => {
        if (!node) throw new Error('worldRect(node)：node 是空的。');
        const stopAt = options && options.root ? options.root : null;

        // ① 先自下而上收集链路：[node, parent, …, (stopAt | 场景根)]
        const chain: any[] = [];
        for (let cursor = node; cursor; cursor = cursor.parent) {
            chain.push(cursor);
            if (stopAt && cursor === stopAt) break;
        }

        // ② 从链路顶端往下累加。顶端（stopAt 或场景根）的锚点就是原点：anchor=(0,0)、S=(1,1)
        let anchorX = 0;
        let anchorY = 0;
        let sx = 1;
        let sy = 1;
        for (let i = chain.length - 2; i >= 0; i -= 1) {
            const child = chain[i];
            const parent = chain[i + 1];
            const ps = parent.scale || { x: 1, y: 1 };
            sx *= typeof ps.x === 'number' ? ps.x : 1;
            sy *= typeof ps.y === 'number' ? ps.y : 1;
            const pos = child.position || { x: 0, y: 0 };
            anchorX += sx * pos.x;
            anchorY += sy * pos.y;
        }

        // ③ 锚点 → 中心（锚点偏移也要跟着链上的缩放一起缩放）
        const ut = uiTransformOf(node);
        const width = ut ? ut.width : 0;
        const height = ut ? ut.height : 0;
        const ax = ut ? ut.anchorX : 0.5;
        const ay = ut ? ut.anchorY : 0.5;
        const cx = anchorX + sx * (0.5 - ax) * width;
        const cy = anchorY + sy * (0.5 - ay) * height;
        const halfW = (sx * width) / 2;
        const halfH = (sy * height) / 2;
        const round = (value: number): number => Math.round(value * 1000) / 1000;
        return {
            name: node.name,
            cx: round(cx),
            cy: round(cy),
            width: round(sx * width),
            height: round(sy * height),
            left: round(cx - halfW),
            right: round(cx + halfW),
            bottom: round(cy - halfH),
            top: round(cy + halfH),
            anchorX: ax,
            anchorY: ay,
            scaleX: round(sx),
            scaleY: round(sy),
            /** 坐标系口径（写进结果里，免得调用方自己猜原点在哪） */
            origin: stopAt ? `以 ${stopAt.name} 的锚点为原点（+x 向右 / +y 向上）` : '以场景根锚点为原点（+x 向右 / +y 向上）',
        };
    };

    /**
     * 场景**真实内容**的世界包围盒（把每个带 `UITransform` 的内容节点并起来）。
     *
     * ## 为什么不能靠遍历全体节点
     *
     * 编辑器场景树里 97% 的节点是编辑器自己的装饰（实测：一个只有 Canvas 的空场景
     * 共 128 个节点，其中 2 个是内容、117 个在 `Editor Scene Foreground`、8 个在 `Background`）。
     * 不剪掉那两棵，算出来的"场景范围"会是整张网格。
     * 剪枝判据与 `eachNode` 完全一致（`isEditorNode`）。
     *
     * ## 它有两个消费者
     *
     * 1. **截图取景**（`fitView` / `viewMetrics.framing`）—— 「整个场景」到底指哪块矩形，
     *    判据必须是同一个，否则会出现"取景框 A、验收看 B"；
     * 2. 模型自己问「我的场景内容多大、跑到哪儿去了」。
     *
     * @returns `{left, right, bottom, top, cx, cy, width, height, count, uuids, note?}`
     *   —— `uuids` 是**交给编辑器 `focus()` 用的那串**（每一条支路上最浅的、真有尺寸的节点，
     *   通常就是 `Canvas`），最多 8 个；内容全是空节点时 `width/height` 为 0（如实回 0，不编框）。
     */
    helpers.contentBounds = (): Record<string, unknown> => {
        const round = (value: number): number => Math.round(value * 1000) / 1000;
        /** `helpers` 自己的类型是 `Record<string, unknown>`，这里按签名取出来用（同 `worldRect` 内部的做法） */
        const each = helpers.eachNode as (visit: (node: any) => void) => void;
        const rectOf = helpers.worldRect as (node: any, options?: { root?: any }) => Record<string, any>;
        let left = Infinity;
        let right = -Infinity;
        let bottom = Infinity;
        let top = -Infinity;
        let count = 0;

        each((node: any) => {
            const ut = uiTransformOf(node);
            if (!ut || !(ut.width > 0) || !(ut.height > 0)) return;
            let rect: Record<string, any>;
            try {
                rect = rectOf(node);
            } catch {
                return; // 单个节点量不出来不该让整张表挂掉
            }
            if (![rect.left, rect.right, rect.bottom, rect.top].every((v) => typeof v === 'number' && Number.isFinite(v))) {
                return;
            }
            count += 1;
            if (rect.left < left) left = rect.left;
            if (rect.right > right) right = rect.right;
            if (rect.bottom < bottom) bottom = rect.bottom;
            if (rect.top > top) top = rect.top;
        });

        /** 交给 `focus()` 的 uuid：每一条支路上**最浅的**那个真有尺寸的节点（通常就是 Canvas） */
        const uuids: string[] = [];
        const focusWalk = (node: any): void => {
            if (uuids.length >= 8) return;
            const ut = uiTransformOf(node);
            if (ut && ut.width > 0 && ut.height > 0) {
                if (node.uuid) uuids.push(node.uuid);
                return;
            }
            for (const child of contentChildren(node)) focusWalk(child);
        };
        const scene = currentScene(cc);
        if (scene) {
            for (const root of contentChildren(scene)) focusWalk(root);
        }

        if (count === 0) {
            return {
                left: 0,
                right: 0,
                bottom: 0,
                top: 0,
                cx: 0,
                cy: 0,
                width: 0,
                height: 0,
                count,
                uuids,
                note: '场景里没有带 UITransform 且尺寸大于 0 的内容节点（量不出内容范围）',
            };
        }

        const width = right - left;
        const height = top - bottom;
        return {
            left: round(left),
            right: round(right),
            bottom: round(bottom),
            top: round(top),
            cx: round((left + right) / 2),
            cy: round((bottom + top) / 2),
            width: round(width),
            height: round(height),
            count,
            uuids,
            /** 坐标系口径写进结果，调用方不用猜原点 */
            origin: '以场景根锚点为原点（+x 向右 / +y 向上）',
        };
    };

    // -----------------------------------------------------------------------
    // 四个「把一轮试错压成一次调用」的助手
    // -----------------------------------------------------------------------
    //
    // 它们不是薄包装。每个都对应**一次实测的弯路**，而且共同满足一个判据：
    // **naive 写法要么会算错、要么有副作用、要么要 N 轮才拿得到结论**。
    //
    // | 助手 | 它替代掉的弯路 |
    // |---|---|
    // | `pick` | 「截图里有个紫方块 → 枚举子树 → 颜色直方图 → 反算坐标 → grep 预制件」16 轮，结论是它是编辑器 gizmo |
    // | `labelFit` | 「这个框放不放得下这行字」靠改真 Label + 建探针卡截图，试了 3 轮（还违反了"别在真实场景里做实验"） |
    // | `snapshotTree`/`diffTree` | 「我到底改了什么」靠记忆，漏掉了自己留下的探针节点 |
    //
    // 另一条共同口径：**能问反事实** —— `pick` 问"这个像素上现在是谁"，
    // `labelFit` 问"框改成 210 放不放得下"。反事实查询**零副作用**，
    // 而在此之前唯一的试错办法就是动真场景。

    /** 渲染优先级（取不到按 0）—— 同级排序用。 */
    const readNodePriority = (node: any): number => {
        const ut = uiTransformOf(node);
        try {
            if (ut && typeof ut.priority === 'number') return ut.priority;
        } catch {
            /* 忽略 */
        }
        return 0;
    };

    /** 点是不是落在矩形里（**页面 CSS 像素、y 向下**）。 */
    const pointInCssRect = (rect: Record<string, number>, x: number, y: number): boolean =>
        x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

    /** 节点上「画得出来」的组件（按引擎里真实存在的类型取；取不到的类型跳过）。 */
    const visualComponentEntries = (node: any): Array<{ name: string; comp: any }> => {
        const out: Array<{ name: string; comp: any }> = [];
        const pairs: Array<[string, any]> = [
            ['Sprite', cc.Sprite],
            ['Label', cc.Label],
            ['RichText', cc.RichText],
            ['Graphics', cc.Graphics],
            ['Mask', cc.Mask],
        ];
        for (const pair of pairs) {
            const name = pair[0];
            const ctor = pair[1];
            if (!ctor || !node || typeof node.getComponent !== 'function') continue;
            let comp: any = null;
            try {
                comp = node.getComponent(ctor);
            } catch {
                comp = null;
            }
            if (comp) out.push({ name, comp });
        }
        return out;
    };

    /**
     * 这个节点「画不画得出东西」。
     *
     * 刻意只做**静态可判**的那几种：`Sprite` 没设图 / `color.a = 0` / 空 Label。
     * `Graphics` 与 `Mask` 判不了（要知道它画到哪就得重放指令流），所以算「可见」
     * 并在 `caveats` 里说明 —— 报实情，不假装知道。
     */
    const visualStateOf = (node: any): { visible: boolean; names: string[]; reason?: string; caveats: string[] } => {
        const entries = visualComponentEntries(node);
        const names = entries.map((e) => e.name);
        const caveats: string[] = [];
        if (entries.length === 0) {
            return { visible: false, names, reason: '没有任何渲染组件（只是容器）', caveats };
        }
        for (const entry of entries) {
            const comp = entry.comp;
            let alpha = 255;
            try {
                if (comp.color && typeof comp.color.a === 'number') alpha = comp.color.a;
            } catch {
                /* 忽略 */
            }
            if (alpha <= 0) return { visible: false, names, reason: `${entry.name} 的 color.a = 0`, caveats };
            if (entry.name === 'Sprite') {
                let frame: any = null;
                try {
                    frame = comp.spriteFrame;
                } catch {
                    frame = null;
                }
                if (!frame) return { visible: false, names, reason: 'Sprite 没设 spriteFrame', caveats };
            }
            if (entry.name === 'Label' || entry.name === 'RichText') {
                let text = '';
                try {
                    text = String(comp.string == null ? '' : comp.string);
                } catch {
                    text = '';
                }
                if (text.length === 0) return { visible: false, names, reason: `${entry.name} 的 string 是空串`, caveats };
            }
            if (entry.name === 'Graphics' || entry.name === 'Mask') {
                caveats.push(`${entry.name} 的可见范围静态判不了（要重放指令流）—— 它在列表里只代表"有这个组件"`);
            }
        }
        return { visible: true, names, caveats };
    };

    /** 父链上所有 `UIOpacity` 的乘积（255 = 全不透明）。 */
    const opacityChainOf = (node: any): number => {
        let product = 255;
        let cursor = node;
        while (cursor) {
            try {
                if (cc.UIOpacity && typeof cursor.getComponent === 'function') {
                    const op = cursor.getComponent(cc.UIOpacity);
                    if (op && typeof op.opacity === 'number') product = (product * op.opacity) / 255;
                }
            } catch {
                /* 忽略 */
            }
            cursor = cursor.parent;
        }
        return Math.round(product);
    };

    /** 祖先里的 `Mask` 名字（**不判断点是否在模板内**，只报「被谁罩着」）。 */
    const maskAncestorsOf = (node: any): string[] => {
        const out: string[] = [];
        let cursor = node ? node.parent : null;
        while (cursor) {
            try {
                if (cc.Mask && typeof cursor.getComponent === 'function') {
                    const mask = cursor.getComponent(cc.Mask);
                    if (mask && mask.enabledInHierarchy !== false) out.push(String(cursor.name));
                }
            } catch {
                /* 忽略 */
            }
            cursor = cursor.parent;
        }
        return out;
    };

    /**
     * **一个屏幕点上是哪个节点** —— 「截图里那东西是什么」的一次调用版。
     *
     * ## 它替代掉的弯路（实测 16 轮）
     *
     * 截图里有个紫色方块，于是：枚举 `achivements` 子树里所有 Sprite/Graphics/Label →
     * 按颜色做直方图 → 反算像素包围盒 → 回预制件里 grep 色值 → **全都对不上**。
     * 结论是那玩意儿**根本不是场景里的节点**，是编辑器移动 gizmo 的 XY 平面手柄。
     *
     * 症结不在于"算不出"，而在于：`空`（这个点上没有内容节点）**本身就是一个结论**，
     * 可手工枚举时没人敢信一个空列表，于是换个角度再枚举一遍。这个助手把「空」
     * 变成**有权威的判词** —— 它已经替调用方算过活跃态、编辑器装饰、尺寸、颜色 alpha 了。
     *
     * ## 三个桶（这正是它比手工枚举强的地方）
     *
     * - `hits` —— 命中这一点的**内容**节点，按画序**从上到下**排
     * - `invisible` —— 盖住了这一点但**看不见**的节点 + 原因（`active=false` /
     *   `color.a=0` / 空 Label / 父链 `UIOpacity=0`）。「这里怎么什么都没画出来」直接看它
     * - `editorHits` —— 盖住这一点的**编辑器自己的**装饰节点（gizmo / 网格 / 参考图）
     *
     * `verdict` 把三桶揉成一句话：`content` / `editor-overlay` / `empty`。
     * 拿到 `editor-overlay` 就别再去节点树或预制件里找了。
     *
     * ## 坐标口径（与 `captureView` 共用一套，**别自己反算**）
     *
     * - `space: 'view'`（默认）—— **页面 CSS 像素、左上角原点**；
     * - `space: 'uv'` —— 0~1 归一化（"大约在图横向 78%、纵向 22%"）。
     *   `captureView` 给了 `maxWidth` 时图会等比缩小，图上像素 ≠ CSS 像素，
     *   这时用 `uv` **不需要知道图多大**；
     * - `space: 'world'` —— 直接给世界坐标（y 向上）。
     *
     * ## 诚实的边界
     *
     * - **画序**按「同级先按 `UITransform.priority`、再按子节点顺序，父在自己子节点之前」算，
     *   是 2D UI 的常规口径；**跨 Canvas / 跨相机**的先后它管不着（回执里 `orderRule` 写着）。
     * - **遮罩**只报 `maskedBy`（祖先 `Mask` 的名字），**不判断那个点在不在模板里**。
     * - `Graphics` 只按「有组件」算，重放指令流才知道它画到哪。
     * - 取不到编辑器相机（场景视图没开 / `cce.Camera` 没就绪）时**直接抛错**，
     *   不给一个静默空结果 —— 那正是「空列表可不可信」的老问题。
     *
     * @param x 横坐标（含义由 `space` 决定）
     * @param y 纵坐标
     * @param options.space `'view'`（默认）/ `'uv'` / `'world'`
     * @param options.root 只在这棵子树里找（默认整场景）
     * @param options.limit 最多回几个内容命中（默认 12）
     */
    helpers.pick = (x: number, y: number, options?: Record<string, any>): Record<string, unknown> => {
        const opts: Record<string, any> = options || {};
        const space = typeof opts.space === 'string' ? opts.space : 'view';
        const limit = clampNumber(opts.limit, 1, 64, 12);
        if (space !== 'view' && space !== 'uv' && space !== 'world') {
            throw new Error(
                `pick(x, y, { space })：space 只认 'view'（页面 CSS 像素，默认）/ 'uv'（0~1）/ 'world'，收到 '${space}'。`,
            );
        }
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            throw new Error(`pick(x, y)：坐标要都是有限数，收到 ${JSON.stringify(x)} / ${JSON.stringify(y)}。`);
        }

        const camInfo = editorCamera();
        if (!camInfo.cam) {
            throw new Error(
                `pick 要把世界坐标投到屏幕上，但现在拿不到编辑器相机：${camInfo.note || '未知原因'}。` +
                    '（场景视图没打开、或者刚打开还没就绪 —— 不是"这个点上没有节点"。）',
            );
        }
        const cam = camInfo.cam;
        const canvas = findViewCanvas(cc);
        const canvasBox = (canvasGeometry(canvas) || {}) as Record<string, any>;
        const page = pageGeometry();
        const cssWidth = typeof page.cssWidth === 'number' ? page.cssWidth : 0;
        const cssHeight = typeof page.cssHeight === 'number' ? page.cssHeight : 0;
        const canvasCssWidth = (canvasBox.cssWidth as number) || 0;
        const canvasDeviceWidth = (canvasBox.deviceWidth as number) || 0;
        const dpr = canvasCssWidth > 0 && canvasDeviceWidth > 0 ? canvasDeviceWidth / canvasCssWidth : pageDpr();
        const camHeight = safeNumber(() => cam.camera.height) || (canvasBox.deviceHeight as number) || 0;

        // ① 输入 → 页面 CSS 像素（左上角原点）
        let px = nx;
        let py = ny;
        let worldPoint: Record<string, number> | null = null;
        if (space === 'uv') {
            if (!cssWidth || !cssHeight) {
                throw new Error('pick(space:"uv") 要按页面尺寸折算，但场景页里没量到 window.innerWidth/innerHeight。改用 space:"view" 自己乘。');
            }
            px = nx * cssWidth;
            py = ny * cssHeight;
        } else if (space === 'world') {
            const projected = projectWorldBox(cc, cam, canvas, { cx: nx, cy: ny, wz: 0, width: 0, height: 0 });
            if (!projected.rect) {
                throw new Error(`pick(space:"world") 投不到屏幕上：${projected.note || '未知原因'}。`);
            }
            px = projected.rect.x;
            py = projected.rect.y;
            worldPoint = { x: round3(nx), y: round3(ny) };
        }

        // ② 顺带把世界坐标也算出来（view/uv 走反投影）—— 回执里带上，省得调用方自己再换算一次
        if (!worldPoint && dpr > 0 && camHeight > 0) {
            try {
                const localX = px - ((canvasBox.left as number) || 0);
                const localY = py - ((canvasBox.top as number) || 0);
                const w = cam.screenToWorld(new cc.Vec3(localX * dpr, camHeight - localY * dpr, 0));
                if (w && typeof w.x === 'number' && typeof w.y === 'number') {
                    worldPoint = { x: round3(w.x), y: round3(w.y) };
                }
            } catch {
                worldPoint = null; // 反投影不成立就如实回 null，不编一个
            }
        }

        const rootNode = opts.root || currentScene(cc);
        if (!rootNode) throw new Error('pick：当前没有打开的场景（也没给 root）。');

        const worldRectOf = helpers.worldRect as (node: any, options?: { root?: any }) => Record<string, any>;

        /** 画序表：同级按 priority、再按子节点顺序，父在自己子节点之前。 */
        const drawIndex = new Map<any, number>();
        {
            let counter = 0;
            const walkOrder = (n: any): void => {
                drawIndex.set(n, counter);
                counter += 1;
                const kids: any[] = (n && n.children) || [];
                const pairs = kids.map((k: any, i: number) => ({ k, i, p: readNodePriority(k) }));
                pairs.sort((a, b) => a.p - b.p || a.i - b.i);
                for (const pair of pairs) walkOrder(pair.k);
            };
            walkOrder(rootNode);
        }

        /** 节点的页面 CSS 矩形（走 `worldRect` + `projectWorldBox`，与截图同一套换算）。 */
        const projectNodeCss = (node: any): Record<string, number> | null => {
            let rect: Record<string, any>;
            try {
                rect = worldRectOf(node);
            } catch {
                return null;
            }
            if (!(rect.width > 0) || !(rect.height > 0)) return null;
            let wz = 0;
            try {
                const wp = node.worldPosition;
                if (wp && typeof wp.z === 'number') wz = wp.z;
            } catch {
                /* 忽略：2D 正交下 z 不影响结果 */
            }
            const projected = projectWorldBox(cc, cam, canvas, {
                cx: rect.cx,
                cy: rect.cy,
                wz,
                width: rect.width,
                height: rect.height,
            });
            return projected.rect;
        };

        const hits: Array<Record<string, unknown>> = [];
        const invisible: Array<Record<string, unknown>> = [];
        const editorHits: Array<Record<string, unknown>> = [];
        const caveats: string[] = [];
        let scannedContent = 0;
        let scannedEditor = 0;

        const visitNode = (node: any, parentPath: string, underEditor: boolean): void => {
            if (!node) return;
            const editorHere = underEditor || isEditorNode(node);
            const path = node === rootNode ? '' : parentPath ? `${parentPath}/${node.name}` : String(node.name);
            const ut = uiTransformOf(node);
            if (ut && ut.width > 0 && ut.height > 0) {
                const cssRect = projectNodeCss(node);
                if (cssRect && pointInCssRect(cssRect, px, py)) {
                    const row: Record<string, unknown> = {
                        path,
                        name: node.name,
                        uuid: node.uuid,
                        rect: cssRect,
                        area: Math.round(cssRect.width * cssRect.height),
                    };
                    if (editorHere) {
                        scannedEditor += 1;
                        if (editorHits.length < 8) editorHits.push(row);
                    } else {
                        scannedContent += 1;
                        const visual = visualStateOf(node);
                        const opacity = opacityChainOf(node);
                        const maskedBy = maskAncestorsOf(node);
                        /**
                         * 能不能看见，三种情况**分开报**：
                         * - 纯容器（没有任何渲染组件）→ 既不算命中、也不算"看不见"（它本来就不该画东西）
                         * - 有渲染组件但没显示出来 → 进 `invisible` 并带上**原因**（这才是"这里怎么什么都没画"的答案）
                         * - 其余 → 命中
                         */
                        const activeInHierarchy =
                            node.activeInHierarchy !== undefined
                                ? node.activeInHierarchy !== false
                                : node.active !== false;
                        if (visual.names.length > 0) {
                            if (!activeInHierarchy) {
                                if (invisible.length < limit) {
                                    row.reason = 'active = false（或父链上有 inactive）';
                                    row.visual = visual.names;
                                    invisible.push(row);
                                }
                            } else if (!visual.visible || opacity <= 0) {
                                if (invisible.length < limit) {
                                    row.reason = opacity <= 0 ? '父链 UIOpacity 合起来是 0' : visual.reason;
                                    row.visual = visual.names;
                                    invisible.push(row);
                                }
                            } else {
                                row.visual = visual.names;
                                row.opacity = opacity;
                                row.maskedBy = maskedBy;
                                row.priority = readNodePriority(node);
                                row.order = drawIndex.has(node) ? drawIndex.get(node) : -1;
                                hits.push(row);
                                for (const caveat of visual.caveats) {
                                    if (caveats.indexOf(caveat) < 0) caveats.push(caveat);
                                }
                            }
                        }
                    }
                }
            }
            const kids: any[] = (node && node.children) || [];
            for (const child of kids) visitNode(child, path, editorHere);
        };
        visitNode(rootNode, '', false);

        hits.sort((a, b) => (b.order as number) - (a.order as number));
        const verdict = hits.length > 0 ? 'content' : editorHits.length > 0 ? 'editor-overlay' : 'empty';

        let note = '';
        if (verdict === 'editor-overlay') {
            note =
                '这个点上**没有任何内容节点**，但有编辑器自己的装饰节点覆盖 —— 基本可以确定是 gizmo / 网格 / 参考图。' +
                '截图里看到的东西若是这个颜色，它**不在场景数据里**，别去节点树或预制件里找它。';
        } else if (verdict === 'empty') {
            note = '这个点上既没有内容节点、也没有编辑器装饰（可能是清屏色 / 面板底色）。';
        } else if (hits.length > limit) {
            note = `命中 ${hits.length} 个内容节点，只回了最上面 ${limit} 个（要更多就调大 limit）。`;
        }

        return {
            x: nx,
            y: ny,
            space,
            pageCss: { x: round3(px), y: round3(py), cssWidth, cssHeight, dpr, href: page.href },
            canvas: canvasBox,
            world: worldPoint,
            hits: hits.slice(0, limit),
            hit: hits.length > 0 ? hits[0] : null,
            hiddenCount: invisible.length,
            invisible,
            editorHits,
            verdict,
            scanned: { content: scannedContent, editor: scannedEditor },
            orderRule: '同级先按 UITransform.priority、再按子节点顺序；父在自己子节点之前。跨 Canvas/跨相机的先后管不着。',
            caveats,
            note,
        };
    };

    /**
     * **这个 Label 放不放得下它自己的字** —— 尤其是「会不会被裁掉」。
     *
     * ## 它替代掉的弯路（两处真 bug、共 4~5 轮）
     *
     * 1. 成就卡描述 `detail`（220×44、fs16、`CLAMP` + 换行）：最长的一条描述折成 2 行，
     *    第 2 行（进度 `20/20`）**整行被裁掉，界面上一个字都看不见**。
     * 2. 效果名 `property/name` 只有 56px 宽，而 6 个汉字的词要 84px —— 名字被截。
     *
     * 两次都靠「另建一张探针卡 + 截图」才看出来，中途还先改了真节点的 `active`
     * （**违反了自己写的纪律**）。这个助手把它变成一次**纯算术**调用。
     *
     * ## 能问反事实（这才是它真正值钱的地方）
     *
     * 第二个参数覆盖任意字段，于是「**如果**我把框改成 210×72 还裁不裁」不用改场景就能问：
     *
     * ```js
     * const n = nodeByPath('Canvas/…/detail/Label');
     * labelFit(n);                 // 现在裁不裁
     * labelFit(n, { height: 72 }); // 框加高到 72 呢
     * labelFit({ text: '在击杀商店购买过不同种类的Buff（共20种）。', fontSize: 16, width: 210, height: 72, lineHeight: 24 });
     * ```
     *
     * ## 回执里为什么带 `formula`
     *
     * 截断阈值那条公式是**从实测反推**的（见文件里 `LABEL_LAST_LINE_FACTOR` 上方那段说明），
     * 不是读引擎源码确认的。所以把假定的公式原样交出去 —— 数字对不上时一眼看得出是
     * **公式**错了还是**用法**错了，而不是又去猜。
     *
     * ## 诚实的边界
     *
     * - 换行按**逐字符贪心**（CJK 的常规行为）。含空格的长拉丁串引擎按**词**换行，
     *   那会比这里**多**占行 —— 回执的 `wrapMode` / `confidence` / `reasons` 会说明。
     * - 有 DOM 时宽度走 canvas `measureText`（**真量**，与引擎 TTF 排版同一把尺子）；
     *   没有则用实测的 em 表估，`method` 字段写明是哪种。
     * - 富文本标签、字间距、`bold`/`outline` 带来的宽度变化**没算**。
     *
     * @param target 一个节点 / 一个 Label 组件 / 一个 spec 对象（`{text, fontSize, width, height, lineHeight, overflow, wrap}`）
     * @param override 覆盖任意字段 —— 用来问「改成这样会不会好」
     */
    helpers.labelFit = (target?: any, override?: Record<string, any>): Record<string, unknown> => {
        const ov: Record<string, any> = override || {};
        let node: any = null;
        let bag: any = null;
        if (target && typeof target.getComponent === 'function') {
            node = target;
            try {
                bag = cc.Label ? target.getComponent(cc.Label) : null;
            } catch {
                bag = null;
            }
            if (!bag) {
                throw new Error(
                    `labelFit(node)：节点「${target.name}」上没有 cc.Label 组件。` +
                        "要问反事实就直接传 spec 对象，例如 labelFit({ text: '…', fontSize: 16, width: 210, height: 72, lineHeight: 24 })。",
                );
            }
        } else if (target && typeof target === 'object') {
            bag = target;
        } else {
            throw new Error(
                'labelFit(target)：target 要是一个节点 / 一个 Label 组件 / 一个 spec 对象' +
                    "（如 { text, fontSize, width, height, lineHeight }）。",
            );
        }

        const read = (key: string): any => {
            if (ov[key] !== undefined) return ov[key];
            if (bag) {
                try {
                    if (bag[key] !== undefined) return bag[key];
                } catch {
                    /* 忽略 */
                }
            }
            return undefined;
        };

        const ut = node ? uiTransformOf(node) : null;
        const text = String(
            read('text') !== undefined
                ? read('text')
                : read('string') !== undefined
                  ? read('string')
                  : '',
        );
        const fontSize = Number(read('fontSize') !== undefined ? read('fontSize') : 14) || 14;
        const lineHeightRaw = Number(read('lineHeight') !== undefined ? read('lineHeight') : 0) || 0;
        const fontFamily = String(read('fontFamily') !== undefined ? read('fontFamily') : 'Arial') || 'Arial';
        const wrapOn = read('wrap') !== undefined ? Boolean(read('wrap')) : read('enableWrapText') !== undefined ? Boolean(read('enableWrapText')) : true;
        const boxWidth = Number(read('width') !== undefined ? read('width') : ut ? ut.width : 0) || 0;
        const boxHeight = Number(read('height') !== undefined ? read('height') : ut ? ut.height : 0) || 0;

        const OVERFLOW_NAMES = ['NONE', 'CLAMP', 'SHRINK', 'RESIZE_HEIGHT'];
        const rawOverflow = read('overflow') !== undefined ? read('overflow') : 'CLAMP';
        let overflowName = 'CLAMP';
        if (typeof rawOverflow === 'number') overflowName = OVERFLOW_NAMES[rawOverflow] || 'CLAMP';
        else if (typeof rawOverflow === 'string') {
            const upper = rawOverflow.trim().toUpperCase();
            overflowName = OVERFLOW_NAMES.indexOf(upper) >= 0 ? upper : 'CLAMP';
        }

        /** `overflow = NONE` 时引擎不折行；其余三种都会（只要开了 enableWrapText）。 */
        const wraps = wrapOn && overflowName !== 'NONE';
        const methods = new Set<string>();

        /** 按某个字号排一遍版 —— SHRINK 要拿它二分，所以抽成函数。 */
        const layoutAt = (fs: number): { lines: string[]; widths: number[]; maxLineWidth: number; contentHeight: number; advance: number } => {
            const advance = lineHeightRaw > 0 ? lineHeightRaw : fs;
            const meas = (s: string): number => {
                const result = measureTextWidth(s, fs, fontFamily);
                methods.add(result.method);
                return result.width;
            };
            const lines: string[] = [];
            for (const paragraph of text.split('\n')) {
                if (!wraps || !(boxWidth > 0)) {
                    lines.push(paragraph);
                    continue;
                }
                let current = '';
                for (const ch of paragraph) {
                    const candidate = current + ch;
                    if (current.length > 0 && meas(candidate) > boxWidth) {
                        lines.push(current);
                        current = ch;
                    } else {
                        current = candidate;
                    }
                }
                lines.push(current);
            }
            const widths = lines.map((line) => meas(line));
            const count = lines.length;
            const contentHeight = count === 0 ? 0 : (count - 1) * advance + advance * LABEL_LAST_LINE_FACTOR;
            return {
                lines,
                widths,
                maxLineWidth: widths.length > 0 ? Math.max(...widths) : 0,
                contentHeight,
                advance,
            };
        };

        /** 框高换算成「最多放得下几行」（上面 `contentHeight` 公式的逆）。 */
        const capacityOf = (advance: number): number =>
            advance > 0 && boxHeight > 0
                ? Math.max(0, Math.floor(boxHeight / advance - (LABEL_LAST_LINE_FACTOR - 1)))
                : 0;

        const base = layoutAt(fontSize);
        const maxLinesFit = capacityOf(base.advance);
        const lineCount = base.lines.length;
        const visibleLines = overflowName === 'CLAMP' ? Math.min(lineCount, maxLinesFit) : lineCount;
        const clippedText = overflowName === 'CLAMP' && lineCount > maxLinesFit ? base.lines.slice(maxLinesFit).join('') : '';
        const overflowX = Math.max(0, base.maxLineWidth - boxWidth);
        const fitsWidth = overflowX <= 0.5; // 半像素容差
        const fitsHeight = lineCount <= maxLinesFit;

        let shrinkTo: number | null = null;
        if (overflowName === 'SHRINK') {
            let lo = 1;
            let hi = fontSize;
            for (let i = 0; i < 12 && hi - lo > 0.25; i += 1) {
                const mid = (lo + hi) / 2;
                const laid = layoutAt(mid);
                if (laid.lines.length <= capacityOf(laid.advance) && laid.maxLineWidth <= boxWidth + 0.5) lo = mid;
                else hi = mid;
            }
            shrinkTo = Math.round(lo * 100) / 100;
        }

        const reasons: string[] = [];
        let confidence = 'high';
        if (methods.has('estimate')) {
            confidence = 'low';
            reasons.push('宽度是**估**的（这个环境里没有 DOM 量不了字），中英混排可能差几个像素');
        }
        if (boxWidth > 0 && base.maxLineWidth > boxWidth * 0.98 && base.maxLineWidth <= boxWidth) {
            if (confidence === 'high') confidence = 'borderline';
            reasons.push('最长一行几乎顶到框宽（>98%）—— 再宽一点点就会多占一行');
        }
        if (wraps && /\s/.test(text)) {
            reasons.push('文本含空格：引擎按**词**折行、这里按**字符**折 —— 引擎实际占的行**可能更多**');
        }

        return {
            source: node ? `node:${node.name}` : 'spec',
            text,
            fontSize,
            lineHeight: lineHeightRaw,
            advance: round3(base.advance),
            advanceSource: lineHeightRaw > 0 ? 'node.lineHeight' : 'engine-default(= fontSize，因为 lineHeight <= 0)',
            wrap: wraps,
            overflow: overflowName,
            fontFamily,
            box: { width: round3(boxWidth), height: round3(boxHeight) },
            lines: base.lines.map((line, i) => ({ index: i + 1, text: line, width: round3(base.widths[i]) })),
            lineCount,
            maxLineWidth: round3(base.maxLineWidth),
            contentHeight: round3(base.contentHeight),
            maxLinesFit,
            visibleLines,
            clippedLineCount: Math.max(0, lineCount - visibleLines),
            clippedText,
            fits: fitsWidth && fitsHeight,
            fitsWidth,
            fitsHeight,
            overflowX: round3(overflowX),
            shortfallPx: round3(Math.max(0, base.contentHeight - boxHeight)),
            shrinkTo,
            resizeTo: overflowName === 'RESIZE_HEIGHT' ? { height: round3(base.contentHeight) } : null,
            method: methods.has('canvas') ? 'canvas' : 'estimate',
            wrapMode: wraps ? 'char-greedy' : 'none',
            confidence,
            reasons,
            formula: 'contentHeight = (行数-1)×行进给 + 行进给×1.26；最多行数 = floor(框高/行进给 − 0.26)；行进给 = lineHeight>0 ? lineHeight : fontSize',
        };
    };

    // -----------------------------------------------------------------------
    // 快照 / 差异 —— 「我到底改了什么」
    // -----------------------------------------------------------------------

    /** 每个组件记哪些字段（白名单）。**不设白名单的话噪声会淹掉真正的改动**。 */
    const SNAPSHOT_COMPONENT_PROPS: Record<string, string[]> = {
        Sprite: ['spriteFrame', 'color', 'type', 'sizeMode', 'fillType', 'fillRange', 'grayscale', 'trim'],
        Label: [
            'string',
            'fontSize',
            'lineHeight',
            'overflow',
            'enableWrapText',
            'color',
            'horizontalAlign',
            'verticalAlign',
            'isBold',
            'useSystemFont',
            'fontFamily',
        ],
        RichText: ['string', 'fontSize', 'lineHeight', 'maxWidth', 'horizontalAlign'],
        UIOpacity: ['opacity'],
        Widget: [
            'isAlignTop',
            'isAlignBottom',
            'isAlignLeft',
            'isAlignRight',
            'isAlignHorizontalCenter',
            'isAlignVerticalCenter',
            'top',
            'bottom',
            'left',
            'right',
            'horizontalCenter',
            'verticalCenter',
            'alignMode',
        ],
        Button: ['transition', 'interactable', 'normalColor', 'pressedColor', 'hoverColor', 'disabledColor', 'zoomScale'],
        Layout: [
            'type',
            'resizeMode',
            'cellSize',
            'spacingX',
            'spacingY',
            'paddingLeft',
            'paddingRight',
            'paddingTop',
            'paddingBottom',
            'affectedByScale',
        ],
    };

    /** `Color` → `#rrggbbaa`（比较用，比一串字段好读也好 diff）。 */
    const colourHex = (color: any): string | null => {
        try {
            if (!color) return null;
            const part = (v: any): string =>
                Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
                    .toString(16)
                    .padStart(2, '0');
            return `#${part(color.r)}${part(color.g)}${part(color.b)}${part(color.a)}`;
        } catch {
            return null;
        }
    };

    /** 把一个属性值压成**可比可读**的纯量（快照要能 JSON 化，也不能被 cc 对象拖爆）。 */
    const snapshotValue = (value: any): unknown => {
        if (value === null || value === undefined) return null;
        const kind = typeof value;
        if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
        if (Array.isArray(value)) {
            return value.length <= 8 ? value.map((v) => snapshotValue(v)) : `[Array(${value.length})]`;
        }
        if (kind === 'object') {
            if (typeof value.uuid === 'string' && typeof value.name === 'string') {
                return `asset:${value.name}@${value.uuid.slice(0, 8)}`;
            }
            if (typeof value.width === 'number' && typeof value.height === 'number') {
                return `${round3(value.width)},${round3(value.height)}`;
            }
            if (typeof value.x === 'number' && typeof value.y === 'number') {
                return value.w === undefined && value.z === undefined
                    ? `${round3(value.x)},${round3(value.y)}`
                    : `${round3(value.x)},${round3(value.y)},${round3(value.z || 0)}`;
            }
            return `<${(value.constructor && value.constructor.name) || 'Object'}>`;
        }
        return `<${kind}>`;
    };

    /** 一个节点的快照属性（白名单 + 压平）。 */
    const snapshotNodeProps = (node: any): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        out.active = node.active !== false;
        out.position = snapshotValue(node.position);
        out.scale = snapshotValue(node.scale);
        if (typeof node.layer === 'number') out.layer = node.layer;
        const ut = uiTransformOf(node);
        if (ut) {
            out.contentSize = snapshotValue(ut);
            out.anchor = `${round3(ut.anchorX)},${round3(ut.anchorY)}`;
            try {
                if (typeof ut.priority === 'number') out.priority = ut.priority;
            } catch {
                /* 忽略 */
            }
        }
        try {
            if (typeof node.getSiblingIndex === 'function') out.siblingIndex = node.getSiblingIndex();
        } catch {
            /* 忽略 */
        }

        let list: any[] = [];
        try {
            if (Array.isArray(node.components)) list = node.components;
            else if (Array.isArray(node._components)) list = node._components;
        } catch {
            list = [];
        }
        const names: string[] = [];
        for (const comp of list) {
            if (!comp) continue;
            const typeName = String((comp.constructor && comp.constructor.name) || 'Component');
            names.push(typeName);
            const wanted = SNAPSHOT_COMPONENT_PROPS[typeName];
            if (!wanted) continue;
            /**
             * 组件字段**摊平成 `Type.field` 一个键**，而不是嵌成 `{Label: {…}}` ——
             * 否则改一个字体会把整个 Label 的字段袋报成 from/to，
             * 「哪一条变了」就看不出来了（实测第一版就是这样，diff 回执一屏全是噪声）。
             */
            for (const key of wanted) {
                let raw: any;
                try {
                    raw = comp[key];
                } catch {
                    continue;
                }
                if (raw === undefined) continue;
                out[`${typeName}.${key}`] =
                    raw && typeof raw === 'object' && typeof raw.r === 'number' && typeof raw.a === 'number'
                        ? colourHex(raw)
                        : snapshotValue(raw);
            }
        }
        out.components = names.sort();
        return out;
    };

    /** FNV-1a（32 位）—— 只用来「两份快照是不是同一份」，不做安全用途。 */
    const hashOf = (text: string): string => {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    };

    /** 落盘（拿不到 `fs` 就如实回 null，不假装写了）。 */
    const writeTextFile = (savePath: string, text: string): { path: string | null; error?: string } => {
        const nodeMods = getNodeModules();
        if (!nodeMods) return { path: null, error: '这个进程里拿不到 fs，写不了盘' };
        try {
            const dir = nodeMods.path.dirname(savePath);
            if (dir) nodeMods.fs.mkdirSync(dir, { recursive: true });
            nodeMods.fs.writeFileSync(savePath, text, 'utf-8');
            return { path: savePath };
        } catch (err) {
            return { path: null, error: `写 ${savePath} 失败：${errorInfo(err).message}` };
        }
    };

    /**
     * **给一棵子树拍一份纯数据快照**（按节点路径做键）—— 「我到底改了什么」的前一半。
     *
     * ## 为什么不能靠 `dump(node)` 或截图
     *
     * - `dump` 回的是 cc 对象摘要，**存不下来也没法比**；而且返回值有 4000 字上限，
     *   306 个节点根本回不来；
     * - 截图只能告诉你"看起来不一样了"，告不出"哪个属性从几变成几"。
     *
     * ## 三条设计口径
     *
     * 1. **键是节点路径，不是 uuid**。编辑器存盘/重新导入后节点 uuid **会变**
     *   （实测每次保存都换一批）—— 按 uuid 做键的话 before/after 会全是「删了 306 个、加了 306 个」。
     * 2. **属性走白名单**（`SNAPSHOT_COMPONENT_PROPS`）。全量 dump 的话，
     *    `__preload`/运行时缓存字段每条都在变，真正的改动会被噪声淹掉。
     * 3. **整份留在场景进程里**，返回值只给「摘要 + 哈希 + 存了没」——
     *    `Map` 挂在模块作用域，所以跨两次 `execute_code` 调用也在（见 `snapshotStore` 注释）。
     *
     * ## 用法
     *
     * ```js
     * snapshotTree(null, { label: 'before' });   // 动手前
     * // …改…
     * snapshotTree(null, { label: 'after' });
     * diffTree('before', 'after');               // → 只回真正变了的那几条
     * ```
     *
     * @param root 拍哪棵子树（默认整个场景）
     * @param options.label 这份快照的名字（`diffTree` 用它引用；不给就自动生成）
     * @param options.saveTo 顺便把完整快照写到这个路径
     * @param options.maxNodes 节点数上限（默认 20000，防呆）
     * @param options.includeEditor 连编辑器 gizmo/网格一起拍（默认 false —— 它们是编辑器自己重建的，会造假 diff）
     */
    helpers.snapshotTree = (root?: any, options?: Record<string, any>): Record<string, unknown> => {
        const opts: Record<string, any> = options || {};
        const label =
            typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : `snap-${snapshotStore.size + 1}`;
        const maxNodes = clampNumber(opts.maxNodes, 1, 200000, 20000);
        const start = root || currentScene(cc);
        if (!start) throw new Error('snapshotTree(root)：当前没有打开的场景（也没给 root）。');

        const nodes: Record<string, unknown> = {};
        const includeEditor = Boolean(opts.includeEditor);
        let count = 0;
        let truncated = 0;
        const visit = (node: any, path: string): void => {
            if (count >= maxNodes) {
                truncated += 1;
                return;
            }
            nodes[path] = snapshotNodeProps(node);
            count += 1;
            const kids: any[] = (node && node.children) || [];
            const pairs = kids.map((k: any, i: number) => ({ k, i, p: readNodePriority(k) }));
            pairs.sort((a, b) => a.p - b.p || a.i - b.i);
            for (const pair of pairs) {
                /**
                 * 默认**剪掉编辑器装饰**（gizmo / 网格 / 参考图）。不只是省体积：
                 * 那些节点是编辑器**自己重建**的，名字与层级会随视角/选中态变，
                 * 留着它们会让 diff 里冒出一堆"新增/删除了 xAxis"的假信号 ——
                 * 一个会喊狼来了的 diff 比没有 diff 更糟。
                 */
                if (!includeEditor && isEditorNode(pair.k)) continue;
                const name = String(pair.k.name);
                visit(pair.k, path ? `${path}/${name}` : name);
            }
        };
        visit(start, '.');

        const tree = { root: String(start.name || 'scene'), at: new Date().toISOString(), nodes };
        const json = JSON.stringify(tree);
        const record = { label, tree, hash: hashOf(json), bytes: json.length, at: tree.at };

        // 淘汰最旧的（Map 保持插入序）
        snapshotStore.set(label, record);
        while (snapshotStore.size > SNAPSHOT_KEEP) {
            const oldest = snapshotStore.keys().next();
            if (oldest.done) break;
            snapshotStore.delete(oldest.value);
        }

        let saved: string | null = null;
        let saveError: string | undefined;
        if (typeof opts.saveTo === 'string' && opts.saveTo.trim()) {
            const written = writeTextFile(opts.saveTo.trim(), JSON.stringify(record, null, 2));
            saved = written.path;
            saveError = written.error;
        }

        const notes: string[] = [];
        if (truncated > 0) {
            notes.push(
                `节点数超过 maxNodes=${maxNodes}，这份快照**不完整** —— diff 会把没拍到的节点当成"被删了"。`,
            );
        }
        notes.push('动手前拍一份、改完再拍一份，然后 diffTree(before, after) 就知道自己到底动了什么。');
        notes.push('节点/组件的键是**路径**，编辑器存盘换 uuid 不影响比对。');

        return {
            label,
            root: tree.root,
            nodeCount: Object.keys(nodes).length,
            bytes: json.length,
            hash: record.hash,
            at: tree.at,
            saved,
            saveError,
            truncated,
            kept: Array.from(snapshotStore.keys()),
            note: notes.join(' '),
        };
    };

    /**
     * **两份快照的差异** —— 「我到底改了什么」的后一半。
     *
     * 只回**真正变了**的节点和属性（`{from, to}` 成对给），所以回执天然很小，
     * 不会被 4000 字上限截断 —— 完整报告想留档就传 `saveTo`。
     *
     * 顺带会挑出 `suspectLeaks`：新增节点里名字像临时候选物的
     * （`__` / `probe` / `tmp` / `test`）—— **实测踩过一次**：探针卡片和 `detail`/`name`
     * 的实验节点留在预制件里忘了删，全靠下一次开编辑器时人工发现。
     *
     * @param before 快照 label，或一份快照对象
     * @param after 同上
     * @param options.limit 每类最多回几条（默认 40）
     * @param options.saveTo 把**完整**报告写到这个路径
     */
    helpers.diffTree = (
        before?: any,
        after?: any,
        options?: Record<string, any>,
    ): Record<string, unknown> => {
        const opts: Record<string, any> = options || {};
        const limit = clampNumber(opts.limit, 1, 5000, 40);
        const resolveSnap = (ref: any, side: string): Record<string, any> => {
            if (typeof ref === 'string') {
                const found = snapshotStore.get(ref);
                if (!found) {
                    throw new Error(
                        `diffTree：没有名为 '${ref}' 的快照（${side}）。已有的：${
                            Array.from(snapshotStore.keys()).join(', ') || '（一份都没有）'
                        }。先用 snapshotTree(null, { label: '${ref}' }) 拍一份。`,
                    );
                }
                return found as Record<string, any>;
            }
            if (ref && typeof ref === 'object') {
                const tree = (ref as Record<string, any>).tree || ref;
                if (tree && typeof tree === 'object' && (tree as Record<string, any>).nodes) {
                    return ref as Record<string, any>;
                }
            }
            throw new Error(`diffTree：${side} 既不是快照 label，也不是一份快照对象（要有 .tree.nodes 或 .nodes）。`);
        };

        const snapA = resolveSnap(before, 'before');
        const snapB = resolveSnap(after, 'after');
        const nodesA = (snapA.tree ? snapA.tree.nodes : snapA.nodes) as Record<string, any>;
        const nodesB = (snapB.tree ? snapB.tree.nodes : snapB.nodes) as Record<string, any>;

        const changed: Array<Record<string, unknown>> = [];
        const added: string[] = [];
        const removed: string[] = [];
        let unchanged = 0;

        for (const key of Object.keys(nodesB)) {
            if (!(key in nodesA)) {
                added.push(key);
                continue;
            }
            const a = nodesA[key] || {};
            const b = nodesB[key] || {};
            const props: Record<string, unknown> = {};
            const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
            for (const prop of keys) {
                const av = JSON.stringify(a[prop]);
                const bv = JSON.stringify(b[prop]);
                if (av !== bv) props[prop] = { from: a[prop] === undefined ? null : a[prop], to: b[prop] === undefined ? null : b[prop] };
            }
            if (Object.keys(props).length > 0) changed.push({ path: key, props });
            else unchanged += 1;
        }
        for (const key of Object.keys(nodesA)) if (!(key in nodesB)) removed.push(key);

        const report = {
            before: snapA.label || '(object)',
            after: snapB.label || '(object)',
            counts: {
                beforeNodes: Object.keys(nodesA).length,
                afterNodes: Object.keys(nodesB).length,
                changed: changed.length,
                added: added.length,
                removed: removed.length,
                unchanged,
            },
            changed,
            added,
            removed,
        };

        let saved: string | null = null;
        let saveError: string | undefined;
        if (typeof opts.saveTo === 'string' && opts.saveTo.trim()) {
            const written = writeTextFile(opts.saveTo.trim(), JSON.stringify(report, null, 2));
            saved = written.path;
            saveError = written.error;
        }

        const suspectLeaks = added.filter((p) => /__|probe|tmp|temp|test/i.test(p));
        const notes: string[] = [];
        if (changed.length === 0 && added.length === 0 && removed.length === 0) {
            notes.push('两份快照一模一样 —— 要么真没改动，要么改完**没存盘**（编辑态改了不存，场景数据就是没变）。');
        }
        if (suspectLeaks.length > 0) {
            notes.push(
                `⚠ 新增节点里有 ${suspectLeaks.length} 个名字像临时探针（${suspectLeaks.slice(0, 5).join(', ')}）—— 确认一下是不是忘了删。`,
            );
        }

        const truncated = changed.length > limit || added.length > limit || removed.length > limit;
        return {
            before: report.before,
            after: report.after,
            counts: report.counts,
            changed: changed.slice(0, limit),
            added: added.slice(0, limit),
            removed: removed.slice(0, limit),
            suspectLeaks,
            truncated,
            saved,
            saveError,
            note: truncated ? `${notes.join(' ')} 每类只回了前 ${limit} 条（完整报告见 saveTo）。` : notes.join(' '),
        };
    };

    /** 列出当前可用的助手函数 —— 让 AI 自己发现能力，而不是靠 tool 文档硬背 */
    helpers.helperNames = (): string[] => Object.keys(helpers).sort();
    return { helpers, state };
}

// ---------------------------------------------------------------------------
// 沙箱执行
// ---------------------------------------------------------------------------

interface SceneLogEntry {
    level: string;
    text: string;
    atMs: number;
}

interface RunCodePayload {
    code?: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
    maxLogs?: number;
    maxLogLength?: number;
    /** 工程根 —— 主进程（editor 侧）给的，`loadFrame` 读 `.meta` 要用（见 `makeHelpers`）。 */
    projectPath?: string;
}

function makeCapturedConsole(
    sink: SceneLogEntry[],
    startedAt: number,
    maxLogs: number,
    maxLogLength: number,
): { console: Record<string, (...parts: unknown[]) => void>; wasTruncated: () => boolean } {
    let truncated = false;
    const stringify = (value: unknown): string => {
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(
                value,
                (_k, v) => {
                    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
                    if (typeof v === 'bigint') return `${v}n`;
                    return v;
                },
                0,
            ) ?? String(value);
        } catch {
            return String(value);
        }
    };
    const push = (level: string) => (...parts: unknown[]) => {
        if (sink.length >= maxLogs) {
            truncated = true;
            return;
        }
        let text = parts.map(stringify).join(' ');
        if (text.length > maxLogLength) text = `${text.slice(0, maxLogLength)}…`;
        sink.push({ level, text, atMs: Date.now() - startedAt });
    };
    return {
        console: {
            log: push('log'),
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
            trace: push('debug'),
            dir: push('log'),
        },
        wasTruncated: () => truncated,
    };
}

// ---------------------------------------------------------------------------
// 两种执行策略
// ---------------------------------------------------------------------------

let vmModule: any = null;
let vmUnavailable = false;

/** 拿 `vm` 模块；引擎进程里拿不到就返回 null（调用方回落到 new Function） */
function getVmModule(): any {
    if (vmModule) return vmModule;
    if (vmUnavailable) return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('vm');
        if (mod && typeof mod.runInThisContext === 'function') {
            vmModule = mod;
            return mod;
        }
        vmUnavailable = true;
        return null;
    } catch {
        vmUnavailable = true;
        return null;
    }
}

/**
 * 注入用的唯一全局名。
 *
 * 为什么是「一个命名空间」而不是「十几个裸全局」：见 {@link buildSceneSource}。
 */
const INJECT_GLOBAL_KEY = '__dshSceneContext';

/**
 * 构造实际执行的源码。
 *
 * ## 为什么要绕这一下
 *
 * `vm.runInThisContext` 的代码看不到局部作用域（这正是它能留在宿主 realm 的原因），
 * 所以全局量必须经由 `globalThis` 传进去。最直觉的做法是把 `cc` / `console` / `dump` …
 * 逐个挂到 `globalThis` 上，但那样有**两个真实危害**：
 *
 * 1. **遮蔽宿主自己的全局**：注入期间 `globalThis.console` 被换成捕获版，
 *    于是引擎/编辑器自己这几毫秒（甚至异步超时后被放弃代码还活着的几十秒）里的日志
 *    全被吞进我们的缓冲 —— 编辑器控制台会诡异地安静下来。
 *    *（这个坑实测踩到过：验证脚本跑到一半输出消失，就是它。）*
 * 2. **要还原十几个名字**，任何一个名字在引擎里是不可配置属性就会还原失败，长期污染。
 *
 * 改成只注入一个 `__dshSceneContext`，再在包装器顶部把它的字段**取成局部 `let` 绑定**：
 * - `globalThis` 只被动一个名字，还原是原子的、可以**立刻做**；
 * - 用户代码里的 `console.log` 走局部绑定，**真正的全局 console 从未被碰过**；
 * - 局部绑定在异步函数开头同步求值，所以即使后面 await 很久，
 *   被放弃的代码也仍然握着自己的引用 —— 还原不会把它弄坏。
 *
 * 用 `let` 而不是 `const`：用户代码里给这些名字重新赋值不会炸。
 * 代价是用户代码不能再用 `let cc = ...` 遮蔽（会报重复声明）—— 与 `new Function`
 * 传形参的旧写法限制一致，属于可接受的约定。
 *
 * ⚠ 行号偏移：用户代码从第 2 行开始，所以报错行号比源码行号大 1。
 */
function buildSceneSource(globals: Record<string, unknown>, code: string): string {
    const names = Object.keys(globals);
    // 注意：`let` 关键字只能出现一次。写成 `let a = 1, let b = 2` 会报
    // "let is disallowed as a lexically bound name"（踩过）。
    const declarations = `let ${names.map((name) => `${name} = __dshCtx.${name}`).join(', ')}`;
    return `(async () => { const __dshCtx = globalThis.${INJECT_GLOBAL_KEY}; ${declarations};\n${code}\n})();`;
}

type FinishFn = (extra: Record<string, unknown>) => Record<string, unknown>;

/** 策略一：`vm.runInThisContext` —— 同 realm + 同步超时（首选） */
async function runViaRunInThisContext(
    vmMod: any,
    globals: Record<string, unknown>,
    code: string,
    timeoutMs: number,
    finish: FinishFn,
    state: { snapshotRequested: boolean },
): Promise<Record<string, unknown>> {
    const target = globalThis as unknown as Record<string, unknown>;
    const hadPrevious = Object.prototype.hasOwnProperty.call(globalThis, INJECT_GLOBAL_KEY);
    const previousValue = hadPrevious ? target[INJECT_GLOBAL_KEY] : undefined;

    const restore = (): void => {
        try {
            if (hadPrevious) target[INJECT_GLOBAL_KEY] = previousValue;
            else delete target[INJECT_GLOBAL_KEY];
        } catch {
            /* 还原失败不致命：下一次执行会重新覆盖 */
        }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        target[INJECT_GLOBAL_KEY] = globals;
        const raw = vmMod.runInThisContext(buildSceneSource(globals, code), {
            filename: 'dsh-scene-code.js',
            timeout: timeoutMs,
            displayErrors: true,
        });

        // 同步段已经跑完（用户代码开头的 let 绑定已经求值），
        // 所以这里可以立刻还原 —— 后面的异步段持有的是自己的局部引用，不受影响。
        restore();

        const result = await Promise.race([
            Promise.resolve(raw),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
            }),
        ]);
        return finish({ ok: true, result, snapshotRequested: state.snapshotRequested });
    } catch (err) {
        return finish({
            ok: false,
            error: errorInfo(err),
            timedOut: isTimeout(err),
            snapshotRequested: state.snapshotRequested,
        });
    } finally {
        if (timer) clearTimeout(timer);
        restore();
    }
}

/**
 * 策略二：`new Function` —— 兜底。
 *
 * 全局量走**显式形参**，不碰 `globalThis`，任何 JS 环境都能用。
 * 代价：`timeout` 只由外层计时器实现，**掐不断同步死循环**。
 */
async function runViaNewFunction(
    globals: Record<string, unknown>,
    code: string,
    timeoutMs: number,
    finish: FinishFn,
    state: { snapshotRequested: boolean },
): Promise<Record<string, unknown>> {
    const names = Object.keys(globals);
    const values = names.map((n) => globals[n]);

    let fn: (...fnArgs: unknown[]) => unknown;
    try {
        fn = new Function(...names, `return (async () => {\n${code}\n})();`) as typeof fn;
    } catch (err) {
        return finish({ ok: false, error: errorInfo(err) });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            Promise.resolve(fn(...values)),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
            }),
        ]);
        return finish({ ok: true, result, snapshotRequested: state.snapshotRequested });
    } catch (err) {
        return finish({
            ok: false,
            error: errorInfo(err),
            timedOut: isTimeout(err),
            snapshotRequested: state.snapshotRequested,
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function executeSceneCode(
    payload: RunCodePayload,
    depth = 0,
): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const logs: SceneLogEntry[] = [];
    const code = typeof payload.code === 'string' ? payload.code : '';
    const maxLogs = typeof payload.maxLogs === 'number' ? payload.maxLogs : 200;
    const maxLogLength = typeof payload.maxLogLength === 'number' ? payload.maxLogLength : 4000;
    const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 15000;

    const { console: capturedConsole, wasTruncated } = makeCapturedConsole(
        logs,
        startedAt,
        maxLogs,
        maxLogLength,
    );

    const finish = (extra: Record<string, unknown>): Record<string, unknown> => ({
        logs,
        logsTruncated: wasTruncated(),
        durationMs: Date.now() - startedAt,
        ...extra,
    });

    if (!code.trim()) {
        return finish({ ok: false, error: { name: 'Error', message: 'code 不能为空' } });
    }

    let cc: any;
    try {
        cc = getCc();
    } catch (err) {
        return finish({ ok: false, error: errorInfo(err) });
    }

    const { helpers, state } = makeHelpers(cc, { projectPath: payload.projectPath });
    const scene = currentScene(cc);

    // recipe 五件套 —— 与 editor 上下文**同一份实现**（跨进程 require dist/core/recipes.js）。
    // 加载失败不让整个 execute_code 挂掉，而是降级成「五个都返回错误」。
    let recipeHelpers: Record<string, unknown>;
    try {
        const recipes = getRecipesModule();
        recipeHelpers = recipes.buildRecipeHelpers({
            projectPath: currentProjectPath(),
            context: 'scene',
            defaultTimeoutMs: timeoutMs,
            // 惰性拿执行器：recipe 助手要能"跑一段代码"，而那段代码又需要同样的全局量
            // （包括 recipe 助手自己）—— 互相引用，必须晚绑定。
            getRunner: () => async (
                recipeCode: string,
                recipeArgs: Record<string, unknown>,
                nestedTimeoutMs: number,
            ) => {
                const nested = await executeSceneCode(
                    {
                        code: recipeCode,
                        args: recipeArgs,
                        // 嵌套执行与本次执行**共享外层 vm 的同步超时预算**（外层 watchdog
                        // 已经在计时了），所以不允许子 recipe 把超时设得比外层还长 ——
                        // 否则报出来的是外层的超时，排查时一脸问号。
                        timeoutMs: Math.min(nestedTimeoutMs, timeoutMs),
                        maxLogs,
                        maxLogLength,
                    },
                    depth + 1,
                );
                // recipe 里调 snapshot() 也要能登记到本次执行的撤销快照上
                if (nested.snapshotRequested) state.snapshotRequested = true;
                const nestedLogs = Array.isArray(nested.logs) ? (nested.logs as SceneLogEntry[]) : [];
                return {
                    ok: Boolean(nested.ok),
                    result: nested.result,
                    error: nested.error,
                    logs:
                        nestedLogs.length > 0
                            ? nestedLogs.map((entry) => `[${entry.level}] ${entry.text}`)
                            : undefined,
                    durationMs: typeof nested.durationMs === 'number' ? nested.durationMs : undefined,
                    timedOut: Boolean(nested.timedOut),
                };
            },
        }).helpers;
    } catch (err) {
        const message = errorInfo(err).message;
        const fail = (): Record<string, unknown> => ({ ok: false, error: message });
        recipeHelpers = {
            findRecipes: fail,
            readRecipe: fail,
            saveRecipe: fail,
            runRecipe: fail,
            deleteRecipe: fail,
        };
    }

    const globals: Record<string, unknown> = {
        cc,
        cocos: cc,
        Editor,
        director: cc.director,
        scene,
        js: cc.js,
        find: cc.find,
        args: payload.args && typeof payload.args === 'object' ? payload.args : {},
        console: capturedConsole,
        ...helpers,
        ...recipeHelpers,
    };

    // 首选 vm.runInThisContext（同 realm + 同步超时）；引擎进程里拿不到 vm 才回落。
    // 两条路径对用户代码的写法要求完全一致。
    const vmMod = getVmModule();
    if (vmMod) {
        return runViaRunInThisContext(vmMod, globals, code, timeoutMs, finish, state);
    }
    return runViaNewFunction(globals, code, timeoutMs, finish, state);
}

// ---------------------------------------------------------------------------
// API 描述（discover 的一半）
// ---------------------------------------------------------------------------

interface DescribeApiPayload {
    target?: string;
    nodeUuid?: string;
    limit?: number;
}

/** 生成某个类的「TS 风格定义」，带实时值 */
function describeClass(cc: any, Cls: any, instance: any, className: string, limit: number): string {
    const lines: string[] = [];
    const props = componentPropNames(instance || { constructor: Cls });
    let parentName = '';
    try {
        const parent = Object.getPrototypeOf(Cls.prototype);
        if (parent && parent.constructor && parent.constructor.name) {
            parentName = parent.constructor.name;
        }
    } catch {
        parentName = '';
    }

    lines.push(`// ${className}${parentName ? `  extends ${parentName}` : ''}`);
    if (instance) {
        lines.push(`// 来自实时实例（节点 ${instance.node ? instance.node.name : '?'}）`);
    } else {
        lines.push('// 未提供 nodeUuid，无实时值；属性名取自类声明');
    }
    lines.push(`export class ${className.split('.').pop()} {`);

    const shown = props.slice(0, limit);
    for (const key of shown) {
        let typeName = 'any';
        let current = '';
        if (instance) {
            const read = safeRead(instance, key);
            if (read.ok) {
                typeName = inferTsType(read.value);
                current = (() => {
                    const v = read.value;
                    if (v === null || v === undefined) return String(v);
                    if (typeof v === 'object') {
                        try {
                            return JSON.stringify(v);
                        } catch {
                            return '[object]';
                        }
                    }
                    return String(v);
                })();
                if (current.length > 60) current = `${current.slice(0, 60)}…`;
            }
        }
        lines.push(`    ${key}: ${typeName};${current ? `  // 当前 = ${current}` : ''}`);
    }
    if (props.length > shown.length) {
        lines.push(`    // …另有 ${props.length - shown.length} 个属性`);
    }
    lines.push('}');

    // 原型方法：告诉 AI「这个组件能调什么」
    const methods: string[] = [];
    try {
        for (const name of Object.getOwnPropertyNames(Cls.prototype)) {
            if (name === 'constructor' || props.includes(name)) continue;
            let isFn = false;
            try {
                isFn = typeof Cls.prototype[name] === 'function';
            } catch {
                isFn = false;
            }
            if (isFn) methods.push(name);
        }
    } catch {
        /* 忽略 */
    }
    if (methods.length > 0) {
        lines.push('');
        lines.push(`// 可调用方法（前 ${Math.min(60, methods.length)} 个）：`);
        lines.push(`// ${methods.slice(0, 60).join(', ')}`);
    }
    return lines.join('\n');
}

/** `cc` 模块的顶层导出清单（大写开头或函数，够用来当索引用） */
function listCcExports(cc: any, limit: number): { total: number; names: string[] } {
    const names: string[] = [];
    try {
        for (const key of Object.keys(cc)) {
            if (/^[A-Z]/.test(key) || typeof cc[key] === 'function') names.push(key);
        }
    } catch {
        /* 忽略 */
    }
    return { total: names.length, names: names.slice(0, limit) };
}

/** 场景侧总览载荷（无 target 与 target==='cc' 共用） */
function buildSceneIndex(cc: any, limit: number, withHint: boolean): Record<string, unknown> {
    const exports = listCcExports(cc, limit);
    const { helpers } = makeHelpers(cc);

    let recipeHelperNames: string[] = [];
    try {
        recipeHelperNames = (getRecipesModule().RECIPE_HELPER_SIGNATURES as string[]).map((signature) =>
            signature.slice(0, signature.indexOf('(')),
        );
    } catch {
        recipeHelperNames = [];
    }

    const payload: Record<string, unknown> = {
        ok: true,
        kind: 'index',
        helperFunctions: Object.keys(helpers).sort(),
        recipeHelperFunctions: recipeHelperNames,
        recipeDir: recipesRootHint(),
        ccExportCount: exports.total,
        ccExports: exports.names,
    };
    if (withHint) {
        payload.hint =
            '用 describe_api({ context:"scene", target:"cc.Camera" }) 看某个类的定义；' +
            '带 nodeUuid 则用节点上的实时实例补出真实类型与当前值。' +
            'describe_api({ context:"scene", target:"helpers" }) 看全部助手函数签名。';
    }
    return payload;
}

function describeSceneApi(cc: any, payload: DescribeApiPayload): Record<string, unknown> {
    const target = typeof payload.target === 'string' ? payload.target.trim() : '';
    const limit = typeof payload.limit === 'number' ? Math.max(1, Math.min(500, payload.limit)) : 80;

    // 1) 没有 target：给出「起手式」清单 + cc 模块的顶层入口
    if (!target) {
        return buildSceneIndex(cc, limit, true);
    }

    // 2) 显式问助手函数
    if (target === 'helpers' || target === 'helper') {
        const { helpers } = makeHelpers(cc);
        const docs: Record<string, string> = {
            nodeByUuid: 'nodeByUuid(uuid) → Node | null',
            nodeByPath: "nodeByPath('Canvas/Panel') → Node | null  // 认得名字里含 '/' 的节点",
            eachNode: 'eachNode(visit, root?, {includeEditor}?) → void  // 默认跳过编辑器 gizmo',
            contentChildren: 'contentChildren(node?) → Node[]  // 真实内容子节点（已滤掉编辑器装饰）',
            isEditorNode: 'isEditorNode(node) → boolean  // 是不是编辑器自己的 gizmo/网格/参考图',
            tree: 'tree({ root?, maxDepth?, withComponents?, includeEditor? }) → 层级骨架对象',
            dump: 'dump(nodeOrComponent) → 显式取字段后的纯数据对象',
            snapshot: 'snapshot() → void  // 标记本次执行要注册撤销快照',
            sleep: 'sleep(ms) → Promise  // 轮询等待',
            captureView:
                "captureView({ savePath?, maxWidth?, format?, quality?, waitMs? }) → Promise<{ok, path?, chunks?, width, height, bytes, blankRatio}>  // 截场景视图当前一帧（含网格/gizmo）存成 png/jpeg",
            loadFrame:
                "loadFrame('db://assets/.../x.png' | '<uuid>@f9941' | '<uuid>') → Promise<SpriteFrame>  // 取图片的 SpriteFrame；别再手搓 @f9941，也别用 cc.resources.load（编辑器场景里必失败）",
            worldRect:
                'worldRect(node, { root? }) → {cx, cy, width, height, left, right, bottom, top}  // 编辑态可信的世界矩形（position+anchor+contentSize 自洽累加）；别用 getBoundingBoxToWorld',
            contentBounds:
                'contentBounds() → {left, right, bottom, top, cx, cy, width, height, count, uuids}  // 场景**真实内容**的世界包围盒（已滤掉编辑器 gizmo/网格）；截图取景量的就是它',
            pick: "pick(x, y, { space?, root?, limit? }) → { verdict, hits[], hit, invisible[], editorHits[], world, pageCss }  // **一个屏幕点上是哪个节点**。space: 'view'（页面CSS像素，默认）/'uv'（0~1，截图缩过就用它）/'world'。verdict='editor-overlay' = 那里没有任何内容节点、是编辑器 gizmo —— 截图里那东西不在场景数据里，别去节点树找",
            labelFit:
                'labelFit(node | {text,fontSize,width,height,lineHeight,overflow,wrap}, override?) → { fits, lineCount, maxLinesFit, clippedText, overflowX, shortfallPx, method, formula }  // **这个 Label 会不会裁字**。第二参覆盖任意字段 = 问反事实（labelFit(n, {height:72})），**零副作用**，别靠改真节点+截图试',
            snapshotTree:
                'snapshotTree(root?, { label?, saveTo?, maxNodes? }) → {label, nodeCount, hash, kept}  // 拍一份纯数据快照（键=节点**路径**，存盘换 uuid 也不影响比对）；存在场景进程里，跨调用还在',
            diffTree:
                'diffTree(beforeLabel, afterLabel, { limit?, saveTo? }) → {counts, changed:[{path, props:{k:{from,to}}}], added, removed, suspectLeaks}  // **我到底改了什么**；suspectLeaks = 新增节点里名字像临时探针的',
            helperNames: 'helperNames() → string[]',
        };
        let recipeHelpers: Array<{ name: string; signature: string }> = [];
        try {
            const module = getRecipesModule();
            recipeHelpers = (module.RECIPE_HELPER_SIGNATURES as string[]).map((signature) => ({
                name: signature.slice(0, signature.indexOf('(')),
                signature,
            }));
        } catch {
            recipeHelpers = [];
        }
        return {
            ok: true,
            kind: 'helpers',
            helpers: [
                ...Object.keys(helpers)
                    .sort()
                    .map((name) => ({ name, signature: docs[name] || name })),
                ...recipeHelpers,
            ],
            recipeDir: recipesRootHint(),
        };
    }

    // 3) 解析 cc.Xxx.Yyy
    const parts = target.split('.').filter(Boolean);
    if (parts[0] !== 'cc') {
        return {
            ok: false,
            error: `scene 上下文只认 'cc.*' 或 'helpers'，收到：${target}`,
        };
    }

    // 掐掉开头的 'cc'：起点本来就是 cc 模块，让 parts[0] 再走一次会取到 `cc.cc`（undefined），
    // 于是所有 'cc.Xxx' 都会误报「在 Xxx 处断链」（踩过）。
    const pathParts = parts.slice(1);
    if (pathParts.length === 0) {
        return buildSceneIndex(cc, limit, false);
    }

    let node: any = cc;
    for (const part of pathParts) {
        if (node === null || node === undefined) {
            return { ok: false, error: `找不到 ${target}（在 ${part} 处断链）` };
        }
        node = (node as Record<string, unknown>)[part];
    }
    if (node === null || node === undefined) {
        return { ok: false, error: `找不到 ${target}` };
    }

    if (typeof node !== 'function') {
        // 不是类：直接描述这个值
        return {
            ok: true,
            kind: 'value',
            target,
            type: inferTsType(node),
            text: describeClass(cc, node.constructor || Object, null, target, limit),
        };
    }

    // 4) 是类 —— 优先用节点上的实时实例补类型
    let instance: any = null;
    let instanceNote = '';
    if (payload.nodeUuid) {
        const scene = currentScene(cc);
        const host = scene ? scene.getChildByUuid(payload.nodeUuid) : null;
        if (host) {
            instance = host.getComponent(node);
            if (!instance) instanceNote = `节点 ${host.name} 上没有 ${target} 组件`;
        } else {
            instanceNote = `找不到节点 ${payload.nodeUuid}`;
        }
    }

    return {
        ok: true,
        kind: 'class',
        target,
        className: (() => {
            try {
                return cc.js.getClassName(node);
            } catch {
                return target;
            }
        })(),
        instanceFound: Boolean(instance),
        note: instanceNote || undefined,
        definition: describeClass(cc, node, instance, target, limit),
    };
}

// ---------------------------------------------------------------------------
// 对外方法
// ---------------------------------------------------------------------------

export const methods: { [key: string]: (...args: any[]) => any } = {
    /** 探活：主进程用它判断场景脚本是否已加载 */
    ping() {
        return { ok: true, ts: Date.now() };
    },

    /** 在引擎上下文执行用户代码 */
    async runCode(payload: RunCodePayload) {
        return executeSceneCode(payload || {});
    },

    /** 渐进式披露：描述引擎 API */
    async describeApi(payload: DescribeApiPayload) {
        try {
            const cc = getCc();
            return describeSceneApi(cc, payload || {});
        } catch (err) {
            return { ok: false, error: errorInfo(err) };
        }
    },

    /**
     * 场景视图几何 —— **截图链路里「量」的那一半**（见文件里 `projectNodeRect` 一节）。
     *
     * 主进程的 Electron 截图要靠它：① 按 `page.href` 精确定位场景视图那个 webContents；
     * ② 按 `page/css` 把图片像素换成 CSS 像素；③ 要截某个节点时，用 `node.rect` 裁；
     * ④ 带了 `fit` 时还要回答「目标拍全了没有」（`framing`）。
     */
    async viewMetrics(payload: ViewMetricsPayload) {
        try {
            const cc = getCc();
            return collectViewMetrics(cc, payload || {});
        } catch (err) {
            return { ok: false, error: errorInfo(err) };
        }
    },

    /**
     * 取景 / 还原视角 —— **截图链路里「摆相机」的那一半**（见文件里「取景」一节）。
     *
     * 为什么由主进程驱动而不是这里一把梭：取景之后**必须让页面重画一帧**
     * （相机动了但画面没重画的话，`capturePage()` 抓到的还是旧取景），
     * 而「排一次重绘」只有主进程能做到（`webContents.invalidate()`）。
     * 所以这里只做「摆一步 → 主进程逼一帧 → 再量一步」里的那两步，
     * 由主进程按 `step` 逐级推进（每一级都是量着验，验不过才降级）。
     *
     * @param payload - `{action, step?, fit?, node?, projectPath?}`：
     *   `action:'fit'` 摆第 `step` 级取景（0 = 编辑器 focus / 1 = 控制器适配 / 2 = 手工），
     *   `action:'end'` 还原视角。
     * @returns `{ok, token, step, method, nextStep, saved, camera}`；
     *   `action:'end'` 回 `{ok, restored, method, after}` —— **还原失败会如实回 `restored:false`**。
     *
     * ⚠ 同一时刻只留一份待还原的视角（截图是串行的）；一份超过 60s 没被还原就当它作废
     * （别把几分钟前的旧视角盖回用户脸上）。
     */
    async fitView(payload: FitViewPayload) {
        try {
            const cc = getCc();
            const camera = editorCamera();
            const action = payload && payload.action === 'end' ? 'end' : 'fit';

            if (action === 'end') {
                if (!pendingFit) return { ok: false, error: '没有待还原的视角（可能已经被还原过了）' };
                if (!camera.cam || !camera.manager) {
                    const abandoned = pendingFit;
                    pendingFit = null;
                    return { ok: false, error: camera.note || '编辑器相机不可用，还不了原', token: abandoned.token };
                }
                const state = pendingFit;
                pendingFit = null;
                const restored = restoreCameraState(camera.manager, camera.cam, state.saved);
                return {
                    ok: true,
                    token: state.token,
                    restored: restored.restored,
                    method: restored.method,
                    after: restored.after,
                    expected: state.saved.signature,
                    note: restored.note,
                };
            }

            if (!camera.cam || !camera.manager) {
                return { ok: false, error: camera.note || '编辑器相机不可用，取不了景' };
            }
            const step = clampNumber(payload && payload.step, 0, 2, 0);
            const spec = normalizeFitSpec(payload && payload.fit);
            if (!spec) return { ok: false, error: `fitView 不认得 fit 参数：${JSON.stringify(payload && payload.fit)}` };

            const helpers = makeHelpers(cc, {
                projectPath: typeof payload.projectPath === 'string' ? payload.projectPath : '',
            }).helpers as Record<string, any>;
            const ref = spec.kind === 'node' ? spec.ref || (typeof payload.node === 'string' ? payload.node.trim() : '') : '';
            let node: any = null;
            if (ref) {
                node = helpers.nodeByUuid(ref) || helpers.nodeByPath(ref) || null;
            }
            const target = fitTargetOf(helpers, spec, node);

            /** 视角只存**一次**（第一次取景之前）—— 后面几级降级都在同一个原始视角之上 */
            const now = Date.now();
            const stale = Boolean(pendingFit) && now - (pendingFit as { startedAt: number }).startedAt > FIT_STATE_TTL_MS;
            const saved = pendingFit && !stale ? pendingFit.saved : saveCameraState(camera.manager, camera.cam);
            const token = pendingFit && !stale ? pendingFit.token : `fit-${now}-${(fitCounter += 1)}`;

            const applied = applyFitStep(cc, camera.manager, camera.cam, step, target, camera.is2D);
            pendingFit = { token, saved, startedAt: now };

            const maxStep = maxFitSteps(camera.is2D);
            return {
                ok: applied.method !== null,
                token,
                step,
                method: applied.method,
                note: applied.note,
                detail: applied.detail,
                /** 下一级（没有就 null）—— 主进程按它决定要不要继续降级 */
                nextStep: applied.method !== null && step + 1 < maxStep ? step + 1 : null,
                maxStep,
                is2D: camera.is2D,
                replacedStale: stale,
                target: { kind: spec.kind, ref: ref || null, source: target.source, uuids: target.uuids.length, world: target.world },
                /** 原始视角（还原的凭据）—— 回执里带上，用户能核对"确实还回去了" */
                saved: { hasInfo: Boolean(saved.info), signature: saved.signature },
                camera: cameraSignature(camera.cam),
            };
        } catch (err) {
            return { ok: false, error: errorInfo(err) };
        }
    },
};
