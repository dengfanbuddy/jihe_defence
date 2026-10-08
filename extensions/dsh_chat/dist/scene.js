"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
const path_1 = require("path");
function timeoutError(ms) {
    const err = new Error(`场景代码执行超时（${ms}ms）`);
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
function isTimeout(err) {
    if (!err || typeof err !== 'object')
        return false;
    const anyErr = err;
    if (anyErr.__dshTimeout)
        return true;
    if (anyErr.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
        return true;
    return typeof anyErr.message === 'string' && /Script execution timed out/i.test(anyErr.message);
}
function errorInfo(err) {
    if (err && typeof err === 'object') {
        const anyErr = err;
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
let ccCache = null;
let ccError = null;
/**
 * 拿到 `cc` 模块。
 *
 * `module.paths.push(Editor.App.path + '/node_modules')` 是必需的：
 * 场景脚本自身的模块解析路径里没有引擎包，不推这一下 `require('cc')` 会 MODULE_NOT_FOUND。
 */
function getCc() {
    if (ccCache)
        return ccCache;
    if (ccError)
        throw new Error(ccError);
    try {
        const engineNodeModules = (0, path_1.join)(Editor.App.path, 'node_modules');
        if (!module.paths.includes(engineNodeModules)) {
            module.paths.push(engineNodeModules);
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ccCache = require('cc');
        return ccCache;
    }
    catch (err) {
        ccError = `无法加载引擎模块 cc：${errorInfo(err).message}`;
        throw new Error(ccError);
    }
}
function currentScene(cc) {
    try {
        return cc.director.getScene();
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// recipe 模块 —— 与主进程共享同一份实现
// ---------------------------------------------------------------------------
/** 扩展包名，与 constants.ts 的 EXTENSION_NAME 一致（此处不能 import，原因见下） */
const EXTENSION_NAME = 'dsh_chat';
let recipesModule = null;
let recipesModuleError = null;
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
function getRecipesModule() {
    if (recipesModule)
        return recipesModule;
    if (recipesModuleError)
        throw new Error(recipesModuleError);
    try {
        const root = Editor.Package.getPath(EXTENSION_NAME);
        if (!root)
            throw new Error(`Editor.Package.getPath('${EXTENSION_NAME}') 返回空`);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        recipesModule = require((0, path_1.join)(root, 'dist', 'core', 'recipes.js'));
        return recipesModule;
    }
    catch (err) {
        recipesModuleError = `无法加载 recipe 模块：${errorInfo(err).message}`;
        throw new Error(recipesModuleError);
    }
}
/** 当前工程根；拿不到就返回空串（recipe 助手会退化成「没有 recipe」而不是报错） */
function currentProjectPath() {
    try {
        return Editor.Project.path || '';
    }
    catch {
        return '';
    }
}
/** recipe 存放目录 —— 只给 `describe_api` 回显用，拿不到就 null */
function recipesRootHint() {
    try {
        const projectPath = currentProjectPath();
        if (!projectPath)
            return null;
        return getRecipesModule().recipesRoot(projectPath);
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// 助手函数 —— 注入沙箱，不暴露为 tool
// ---------------------------------------------------------------------------
/** 深度优先遍历整棵子树（迭代实现，避免深层场景爆栈） */
function eachNode(root, visit) {
    if (!root)
        return;
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        visit(node);
        const children = node.children || [];
        for (let i = children.length - 1; i >= 0; i -= 1)
            stack.push(children[i]);
    }
}
function shortNode(node) {
    if (!node)
        return null;
    return {
        name: node.name,
        uuid: node.uuid,
        active: node.activeInHierarchy !== undefined ? node.activeInHierarchy : node.active,
    };
}
/** 把值推断成 TS 类型名，用于生成类定义 */
function inferTsType(value) {
    if (value === null || value === undefined)
        return 'any';
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
    const obj = value;
    let ctorName = '';
    try {
        const ctor = obj.constructor;
        ctorName = ctor && typeof ctor.name === 'string' ? ctor.name : '';
    }
    catch {
        ctorName = '';
    }
    if (!ctorName || ctorName === 'Object')
        return 'object';
    // 引擎数学/资源类型都带 cc. 前缀更利于 AI 写代码
    if (typeof obj.uuid === 'string')
        return `cc.${ctorName} /* asset */`;
    return `cc.${ctorName}`;
}
/** 取一个对象上的可枚举自有键（getter 抛异常时跳过） */
function safeKeys(target) {
    try {
        return Object.keys(target);
    }
    catch {
        return [];
    }
}
function safeRead(target, key) {
    try {
        return { ok: true, value: target[key] };
    }
    catch {
        return { ok: false };
    }
}
/** 组件的序列化属性名列表：优先用 Cocos 的 `__props__` */
function componentPropNames(comp) {
    const ctor = comp && comp.constructor;
    const declared = ctor && Array.isArray(ctor.__props__) ? ctor.__props__ : null;
    if (declared && declared.length > 0)
        return declared.slice();
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
let nodeModulesCache;
function getNodeModules() {
    if (nodeModulesCache !== undefined)
        return nodeModulesCache;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nodeModulesCache = { fs: require('fs'), path: require('path'), os: require('os') };
    }
    catch {
        nodeModulesCache = null;
    }
    return nodeModulesCache;
}
/** 场景视图的那块画布：优先引擎自己的 canvas，其次页面上面积最大的 canvas。 */
function findViewCanvas(cc) {
    const candidates = [];
    try {
        if (cc.game && cc.game.canvas)
            candidates.push(cc.game.canvas);
    }
    catch {
        /* 忽略：引擎版本差异 */
    }
    try {
        if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
            candidates.push(...Array.from(document.querySelectorAll('canvas')));
        }
    }
    catch {
        /* 忽略：不是浏览器环境 */
    }
    const usable = candidates.filter((c) => c && typeof c.getContext === 'function' && c.width > 0 && c.height > 0);
    if (usable.length === 0)
        return null;
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
function readViewState(cc, canvas) {
    const round = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const out = {};
    try {
        const view = cc.view;
        if (view) {
            if (typeof view.getVisibleSize === 'function') {
                const size = view.getVisibleSize();
                if (size)
                    out.visibleSize = { width: round(size.width), height: round(size.height) };
            }
            if (typeof view.getDesignResolutionSize === 'function') {
                const size = view.getDesignResolutionSize();
                if (size)
                    out.designResolution = { width: round(size.width), height: round(size.height) };
            }
            if (typeof view.getScaleX === 'function') {
                out.scale = { x: round(view.getScaleX()), y: round(view.getScaleY()) };
            }
        }
    }
    catch {
        /* 引擎版本差异：拿不到就不报，不影响截图 */
    }
    try {
        if (canvas)
            out.canvas = { width: canvas.width, height: canvas.height };
    }
    catch {
        /* 忽略 */
    }
    /** 与设计分辨率不一致 = 游戏侧取景不是设计档（⚠ 场景视图是自由相机，用户缩放也会让它变，所以这只是线索不是判据） */
    const visible = out.visibleSize;
    const design = out.designResolution;
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
function readViewPixels(cc, canvas, waitMs) {
    const grab = () => {
        const gl = canvas.getContext('webgl2') ||
            canvas.getContext('webgl') ||
            canvas.getContext('experimental-webgl');
        if (!gl)
            throw new Error('画布上没有 WebGL 上下文（2D 画布不支持这么截图）');
        const width = gl.drawingBufferWidth || canvas.width;
        const height = gl.drawingBufferHeight || canvas.height;
        if (!width || !height)
            throw new Error('画布尺寸为 0，截不到东西');
        const pixels = new Uint8Array(width * height * 4);
        // 引擎可能留着别的 FBO 绑定 —— 读默认帧缓冲前显式解绑
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { width, height, pixels };
    };
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            try {
                fn();
            }
            catch (err) {
                reject(err);
            }
        };
        try {
            const event = cc.Director && cc.Director.EVENT_AFTER_DRAW;
            if (event && cc.director && typeof cc.director.once === 'function') {
                cc.director.once(event, () => settle(() => resolve(grab())));
            }
        }
        catch {
            /* 回落：直接抓当前缓冲 */
        }
        setTimeout(() => settle(() => resolve(grab())), waitMs);
    });
}
/** 抽样估算「几乎是空图」的比例（全透明或纯黑都算空）—— 用来发现"截出来是张白纸"。 */
function sampleBlankRatio(pixels) {
    const total = Math.floor(pixels.length / 4);
    if (total <= 0)
        return 1;
    const step = Math.max(1, Math.floor(total / 512));
    let sampled = 0;
    let blank = 0;
    for (let i = 0; i < total; i += step) {
        const o = i * 4;
        sampled += 1;
        if (pixels[o + 3] === 0 || (pixels[o] === 0 && pixels[o + 1] === 0 && pixels[o + 2] === 0))
            blank += 1;
    }
    return sampled > 0 ? Math.round((blank / sampled) * 1000) / 1000 : 1;
}
/** 把 RGBA 像素编码成 data URL（WebGL 原点在左下，需要翻行）。 */
function encodeFrameToDataUrl(pixels, width, height, opts) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        throw new Error('当前环境没有 document.createElement，无法把像素编码成图片');
    }
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    const ctx = src.getContext('2d');
    if (!ctx)
        throw new Error('拿不到 2D 画布上下文');
    const image = ctx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
        const from = (height - 1 - y) * rowBytes;
        image.data.set(pixels.subarray(from, from + rowBytes), y * rowBytes);
    }
    ctx.putImageData(image, 0, 0);
    let out = src;
    if (opts.maxWidth > 0 && width > opts.maxWidth) {
        const scaled = document.createElement('canvas');
        scaled.width = opts.maxWidth;
        scaled.height = Math.max(1, Math.round((height * opts.maxWidth) / width));
        const sctx = scaled.getContext('2d');
        if (sctx) {
            sctx.imageSmoothingEnabled = true;
            try {
                sctx.imageSmoothingQuality = 'high';
            }
            catch {
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
function round3(value) {
    return Math.round(value * 1000) / 1000;
}
/** 取一个可能抛异常的数值 getter。 */
function safeNumber(read) {
    try {
        const value = read();
        return typeof value === 'number' && Number.isFinite(value) ? round3(value) : null;
    }
    catch {
        return null;
    }
}
/** 把可能来自 IPC 的数值夹到 `[min, max]`（不是数就用 `fallback`）。 */
function clampNumber(value, min, max, fallback) {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, num));
}
/**
 * 页面（webview）的 CSS 几何 + 它自己的 URL。
 *
 * `href` 是**主进程定位这个 webContents 的首选判据**：编辑器里可能同时有好几个
 * webview（场景视图、游戏预览…），按 URL 精确匹配比按「类型是 webview」猜可靠得多。
 */
function pageGeometry() {
    const out = {};
    try {
        if (typeof window !== 'undefined' && window.location) {
            out.href = window.location.href;
            out.cssWidth = window.innerWidth;
            out.cssHeight = window.innerHeight;
            out.dpr = window.devicePixelRatio || 1;
        }
    }
    catch {
        /* 不是浏览器环境就算了：主进程会退回到按 URL 特征找 */
    }
    return out;
}
/** 画布在页面里的位置（CSS 像素）+ 它的 device 像素尺寸。 */
function canvasGeometry(canvas) {
    if (!canvas)
        return null;
    const out = {};
    try {
        if (typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            out.left = round3(rect.left);
            out.top = round3(rect.top);
            out.cssWidth = round3(rect.width);
            out.cssHeight = round3(rect.height);
        }
    }
    catch {
        /* 忽略：量不到就少一项，不影响别的 */
    }
    try {
        out.deviceWidth = canvas.width;
        out.deviceHeight = canvas.height;
    }
    catch {
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
function editorCamera() {
    try {
        const manager = globalThis.cce && globalThis.cce.Camera;
        if (!manager)
            return { manager: null, cam: null, is2D: null, note: '这个进程里没有 cce.Camera（场景页才有）' };
        const cam = manager.camera;
        if (!cam || !cam.camera) {
            return { manager, cam: null, is2D: null, note: 'cce.Camera.camera 还没初始化（场景视图刚打开时会有这一瞬）' };
        }
        let is2D = null;
        try {
            if (typeof manager.is2D === 'boolean')
                is2D = manager.is2D;
        }
        catch {
            /* 忽略 */
        }
        return { manager, cam, is2D };
    }
    catch (err) {
        return { manager: null, cam: null, is2D: null, note: `读 cce.Camera 失败：${errorInfo(err).message}` };
    }
}
/**
 * 场景进程现在处在哪个模式 —— **编辑器场景 / 运行预览 / 预制件编辑 / 动画编辑**。
 *
 * ## 为什么要在场景进程里问一次
 *
 * 「运行预览」（编辑器工具栏那颗播放键，编辑器自己的叫法是 game view / `i18n:preview.gameView`）
 * 时，画面由**游戏自己的相机**渲染，编辑器相机被 `PreviewPlay.hideEditorCamera()` 藏起来
 * （`@types/cce/3d/manager/preview-play/index.d.ts`）。于是「按编辑器相机投出来的节点矩形」
 * 在那一刻**不成立** —— 截图/裁节点/点节点都会落到错的地方。
 * 本函数就是把这件事**在唯一一处**说清楚：谁要动坐标，先问它。
 *
 * ## 判据顺序（**2026-11 真机实测之后重定的**，改之前请先读 `docs/对照-cocos-extensions.md` §9.7）
 *
 * | 序 | 来源 | 真机上的实情 |
 * |---|---|---|
 * | ① | `cce.PreviewPlay._state`（`'stop' / 'play' / 'pause'`） | **唯一会随运行态变的来源** —— 运行态只有它判得出来 |
 * | ② | `SceneFacadeManager.getCurrentFacade().modeName` | 预览**跑着**的时候它仍然是 `'general'`（实测），所以只能用来认「预制件/动画」这类**非运行**模式 |
 * | ③ | `SceneFacadeManager.queryMode()` | 同上 |
 * | ④ | `globalThis.isPreviewProcess` | 真机上恒 `false`（实测），当不了判据 |
 *
 * ⚠ `_state` 是**私有字段**：`preview-play/index.d.ts` 里公开的只有 `isPause()`。
 * 之所以还是用它 —— 真机上只有它说话算数；而**读不到时不许猜**：回退到旧口径，
 * 并把「读不到 `_state`」写进 `note`（编辑器哪天改了字段名，回执里立刻看得见）。
 *
 * ## 附带报出的量（判「冻住没有」只有帧计数能说话）
 *
 * `sources.totalFrames` / `directorPaused` / `gamePaused` —— 实测：`pause(true)` 之后
 * `frames` 1.5s 内 **+0**，`step()` **恰好 +1**。
 */
function readSceneMode(cc) {
    const out = { mode: 'unknown', running: false, paused: null, sources: {} };
    const sources = out.sources;
    const cceAny = globalThis.cce;
    /** ① PreviewPlay —— 运行态的唯一可信来源 */
    let previewState = null;
    try {
        const play = cceAny && cceAny.PreviewPlay;
        sources.previewPlayPresent = Boolean(play);
        if (play) {
            try {
                const rawState = play._state;
                previewState = typeof rawState === 'string' ? rawState : null;
                sources.previewState = previewState;
            }
            catch (err) {
                sources.previewStateError = errorInfo(err).message;
            }
            try {
                sources.previewIsPause = typeof play.isPause === 'function' ? play.isPause() : null;
            }
            catch (err) {
                sources.previewIsPauseError = errorInfo(err).message;
            }
        }
    }
    catch (err) {
        sources.previewPlayError = errorInfo(err).message;
    }
    /** ②③ facade 两条 —— 只用来认非运行模式（真机实测：预览跑着时它们是 general） */
    try {
        const manager = cceAny && cceAny.SceneFacadeManager;
        if (!manager) {
            out.note = '这个进程里没有 cce.SceneFacadeManager（场景页才有）';
        }
        else {
            try {
                const facade = typeof manager.getCurrentFacade === 'function' ? manager.getCurrentFacade() : null;
                sources.facadeMode = facade && typeof facade.modeName === 'string' ? facade.modeName : null;
            }
            catch (err) {
                sources.facadeModeError = errorInfo(err).message;
            }
            try {
                sources.queryMode = typeof manager.queryMode === 'function' ? manager.queryMode() : null;
            }
            catch (err) {
                sources.queryModeError = errorInfo(err).message;
            }
        }
    }
    catch (err) {
        out.note = `读 cce.SceneFacadeManager 失败：${errorInfo(err).message}`;
    }
    /** ④ 预览进程标志（真机恒 false；留着只为「原样报出」） */
    try {
        const flag = globalThis.isPreviewProcess;
        sources.isPreviewProcess = typeof flag === 'boolean' ? flag : null;
    }
    catch {
        sources.isPreviewProcess = null;
    }
    /** ⑤ 主循环的两面 + 帧计数 */
    if (cc) {
        try {
            sources.totalFrames = cc.director.getTotalFrames();
        }
        catch {
            /* 引擎还没起来就算了 */
        }
        try {
            sources.directorPaused = cc.director.isPaused();
        }
        catch {
            /* 同上 */
        }
        try {
            sources.gamePaused = cc.game.isPaused();
        }
        catch {
            /* 同上 */
        }
    }
    const known = ['general', 'prefab', 'animation', 'preview'];
    const raw = [sources.facadeMode, sources.queryMode].filter((value) => typeof value === 'string');
    const hit = raw.find((value) => known.indexOf(value) >= 0);
    if (previewState === 'play' || previewState === 'pause') {
        out.mode = 'preview';
        out.running = true;
        out.paused = previewState === 'pause';
    }
    else if (previewState === 'stop') {
        out.running = false;
        out.paused = false;
        if (hit && hit !== 'preview') {
            out.mode = hit;
        }
        else if (raw.length > 0) {
            out.note = `模式串认不出来（${JSON.stringify(raw)}）—— 原值已如实报出，这里不猜`;
        }
    }
    else {
        /**
         * 读不到 `_state`（编辑器改了字段名 / 这台机器上没有 PreviewPlay）—— **退回旧口径**，
         * 并明说这条判据可信度低：真机实测 facade 那几条判不出预览在跑。
         */
        out.paused = null;
        if (hit) {
            out.mode = hit;
            out.running = hit === 'preview';
        }
        else if (raw.length > 0) {
            out.note = `模式串认不出来（${JSON.stringify(raw)}）—— 原值已如实报出，这里不猜`;
        }
        const why = sources.previewPlayPresent
            ? '读不到 cce.PreviewPlay._state（编辑器可能改了字段名）'
            : '这个进程里没有 cce.PreviewPlay';
        out.note = `${why} —— 运行态只能按 facade 那几条猜，而真机实测它们**判不出预览在跑**（见 docs/对照-cocos-extensions.md §9.7）`;
    }
    return out;
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
function projectNodeRect(cc, cam, node, canvas) {
    const ut = typeof node.getComponent === 'function' ? node.getComponent(cc.UITransform) : null;
    if (!ut)
        return { rect: null, canvasRect: null, note: '节点没有 UITransform（没有 contentSize），算不出矩形' };
    let width = 0;
    let height = 0;
    let anchorX = 0.5;
    let anchorY = 0.5;
    try {
        width = ut.width || 0;
        height = ut.height || 0;
        anchorX = typeof ut.anchorX === 'number' ? ut.anchorX : 0.5;
        anchorY = typeof ut.anchorY === 'number' ? ut.anchorY : 0.5;
    }
    catch {
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
    }
    catch {
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
    }
    catch {
        return { rect: null, canvasRect: null, note: '读不到节点的 worldPosition' };
    }
    // 锚点偏移：worldPosition 是**锚点**的位置，矩形中心要按锚点补回来
    const cx = wx + (0.5 - anchorX) * worldWidth;
    const cy = wy + (0.5 - anchorY) * worldHeight;
    return projectWorldBox(cc, cam, canvas, { cx, cy, wz, width: worldWidth, height: worldHeight });
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
function projectWorldBox(cc, cam, canvas, box) {
    /** 几何基准：y 翻转用相机自己的高度（相机像素），dpr 从画布推（CSS ← device） */
    const canvasBox = canvasGeometry(canvas) || {};
    const camHeight = safeNumber(() => cam.camera.height) || canvasBox.deviceHeight || 0;
    const canvasCssWidth = canvasBox.cssWidth || 0;
    const canvasDeviceWidth = canvasBox.deviceWidth || 0;
    const dpr = canvasCssWidth > 0 && canvasDeviceWidth > 0 ? canvasDeviceWidth / canvasCssWidth : pageDpr();
    if (!camHeight || !dpr) {
        return { rect: null, canvasRect: null, note: '量不到相机高度或 dpr，无法把屏幕空间换成 CSS 像素' };
    }
    const Vec3 = cc.Vec3;
    const xs = [];
    const ys = [];
    try {
        for (const dx of [-0.5, 0.5]) {
            for (const dy of [-0.5, 0.5]) {
                const point = cam.worldToScreen(new Vec3(box.cx + dx * box.width, box.cy + dy * box.height, box.wz));
                xs.push(point.x / dpr);
                // 左下原点、y 向上 → 左上原点、y 向下
                ys.push((camHeight - point.y) / dpr);
            }
        }
    }
    catch (err) {
        return { rect: null, canvasRect: null, note: `worldToScreen 失败：${errorInfo(err).message}` };
    }
    const raw = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
    const left = canvasBox.left || 0;
    const top = canvasBox.top || 0;
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
    const outside = canvasCssWidth > 0 &&
        (rect.x + rect.width < 0 ||
            rect.y + rect.height < 0 ||
            rect.x > left + canvasCssWidth ||
            rect.y > top + (canvasBox.cssHeight || 0));
    return {
        rect,
        canvasRect,
        note: outside
            ? '⚠ 投影出来的矩形落在画布外（相机或 dpr 口径可能不成立）—— 请核对 camera / canvas 字段'
            : undefined,
    };
}
/** 页面自己的 dpr（拿不到画布尺寸时的兜底）。 */
function pageDpr() {
    try {
        if (typeof window !== 'undefined')
            return window.devicePixelRatio || 1;
    }
    catch {
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
const EM_WIDTH = { cjk: 1, upper: 0.667, lower: 0.556, digit: 0.556, space: 0.278 };
/** 一个字符属于哪一类（决定兜底宽度）。 */
function emClassOf(ch) {
    const code = ch.codePointAt(0) || 0;
    if (ch === ' ' || ch === '\t')
        return 'space';
    if (code >= 0x30 && code <= 0x39)
        return 'digit';
    if (code >= 0x41 && code <= 0x5a)
        return 'upper';
    if (code >= 0x61 && code <= 0x7a)
        return 'lower';
    if (code < 0x2e80)
        return 'lower'; // 拉丁标点/符号按小写宽度近似
    return 'cjk'; // CJK / 全角标点 / 假名 / 韩文 —— 一律 1em
}
/** 量文字用的 2D 上下文（模块级缓存；取不到就 null，调用方走兜底表）。 */
let measureCtxCache = null;
/**
 * 拿一个 2D 上下文来量字。
 *
 * ⚠ **只缓存成功的结果**：失败时每次都重试。踩过的理由很实在 —— 场景页刚打开的那一瞬
 * `document` 可能还没就绪，如果那时把「没有上下文」缓存下来，之后**一整局都量不了字**，
 * 而症状是「宽度悄悄退化成估算」——很难查。重试的代价只是一次 `createElement`。
 */
function measureContext() {
    if (measureCtxCache)
        return measureCtxCache;
    try {
        const doc = globalThis.document;
        if (doc && typeof doc.createElement === 'function') {
            const canvas = doc.createElement('canvas');
            measureCtxCache = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        }
    }
    catch {
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
function measureTextWidth(text, fontSize, fontFamily) {
    const s = String(text == null ? '' : text);
    if (s.length === 0 || !(fontSize > 0))
        return { width: 0, method: 'estimate' };
    const ctx = measureContext();
    if (ctx) {
        try {
            ctx.font = `${fontSize}px ${fontFamily || 'Arial'}`;
            const width = ctx.measureText(s).width;
            if (typeof width === 'number' && Number.isFinite(width))
                return { width, method: 'canvas' };
        }
        catch {
            /* 落到兜底表 */
        }
    }
    let total = 0;
    for (const ch of s)
        total += (EM_WIDTH[emClassOf(ch)] || 0.556) * fontSize;
    return { width: total, method: 'estimate' };
}
/**
 * 快照仓 —— **必须是模块级的**。
 *
 * `makeHelpers()` 每跑一段代码就重建一次闭包，放在闭包里的东西下一段代码就看不见了；
 * 而「改之前存一份、改之后 diff」天生跨两次调用。所以存在模块作用域，按 `label` 取用。
 */
const snapshotStore = new Map();
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
/** 解析主进程传来的 `fit` 字段；认不出就回 null（= 不取景）。 */
function normalizeFitSpec(raw) {
    const value = raw;
    if (!value || typeof value !== 'object')
        return null;
    const kind = value.kind === 'node' ? 'node' : value.kind === 'scene' ? 'scene' : null;
    if (!kind)
        return null;
    return { kind, ref: typeof value.ref === 'string' ? value.ref.trim() : '' };
}
/** 页面上画布的位置与尺寸（**页面 CSS 像素**）—— 「拍全了没有」的参照系。 */
function viewportOf(canvas) {
    const box = canvasGeometry(canvas);
    if (!box)
        return null;
    const width = box.cssWidth || 0;
    const height = box.cssHeight || 0;
    if (width <= 0 || height <= 0)
        return null;
    return { x: box.left || 0, y: box.top || 0, width, height };
}
/**
 * 「这个矩形拍全了没有」—— 取景链的**唯一判据**。
 *
 * @param pageRect - 目标矩形（页面 CSS 像素）。
 * @param viewport - 画布矩形（页面 CSS 像素）。
 * @returns `covered`（四边都在画布内，容差 2px）、`edges`（四边的**内侧余量**，负数 = 超出多少）、
 *   `areaRatio`（与画布的**交集**面积占比 —— 跑出屏幕的内容不能拿自己的面积充数）。
 */
function coverageOf(pageRect, viewport) {
    const edges = {
        left: round3(pageRect.x - viewport.x),
        right: round3(viewport.x + viewport.width - (pageRect.x + pageRect.width)),
        top: round3(pageRect.y - viewport.y),
        bottom: round3(viewport.y + viewport.height - (pageRect.y + pageRect.height)),
    };
    const covered = edges.left >= -COVERAGE_TOLERANCE_PX &&
        edges.right >= -COVERAGE_TOLERANCE_PX &&
        edges.top >= -COVERAGE_TOLERANCE_PX &&
        edges.bottom >= -COVERAGE_TOLERANCE_PX;
    const ix = Math.max(0, Math.min(pageRect.x + pageRect.width, viewport.x + viewport.width) - Math.max(pageRect.x, viewport.x));
    const iy = Math.max(0, Math.min(pageRect.y + pageRect.height, viewport.y + viewport.height) - Math.max(pageRect.y, viewport.y));
    const viewArea = viewport.width * viewport.height;
    return {
        covered,
        areaRatio: viewArea > 0 ? Math.round(((ix * iy) / viewArea) * 1000) / 1000 : 0,
        edges,
    };
}
/**
 * 把 `{kind, ref}` 解析成「一块世界矩形 + 一串 uuid」。
 *
 * - `scene`：`helpers.contentBounds()`（真实内容的并集，见它的注释）；
 * - `node`：目标节点自己的 `worldRect`。
 */
function fitTargetOf(helpers, spec, node) {
    if (spec.kind === 'node') {
        if (!node) {
            return { spec, world: null, uuids: [], source: 'node', note: `没找到节点「${spec.ref}」` };
        }
        let rect = null;
        try {
            rect = helpers.worldRect(node);
        }
        catch (err) {
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
    let bounds = null;
    try {
        bounds = helpers.contentBounds();
    }
    catch (err) {
        return { spec, world: null, uuids: [], source: 'contentBounds', note: `算内容包围盒失败：${errorInfo(err).message}` };
    }
    const width = typeof bounds.width === 'number' ? bounds.width : 0;
    const height = typeof bounds.height === 'number' ? bounds.height : 0;
    const uuids = Array.isArray(bounds.uuids) ? bounds.uuids.filter((u) => typeof u === 'string') : [];
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
function cameraSignature(cam) {
    const out = {};
    const node = cam && cam.node ? cam.node : null;
    if (node) {
        try {
            const p = node.worldPosition;
            if (p)
                out.position = { x: round3(p.x), y: round3(p.y), z: round3(p.z) };
        }
        catch {
            /* 忽略 */
        }
        try {
            const r = node.worldRotation;
            if (r)
                out.rotation = { x: round3(r.x), y: round3(r.y), z: round3(r.z), w: round3(r.w) };
        }
        catch {
            /* 忽略 */
        }
    }
    const orthoHeight = safeNumber(() => cam.orthoHeight);
    if (orthoHeight !== null)
        out.orthoHeight = orthoHeight;
    const fov = safeNumber(() => cam.fov);
    if (fov !== null)
        out.fov = fov;
    const projection = safeNumber(() => cam.projection);
    if (projection !== null)
        out.projection = projection;
    return out;
}
/** 两个视角签名是不是「同一个视角」（容差放宽到「肉眼分不出」的量级）。 */
function sameCamera(a, b) {
    if (!a || !b)
        return false;
    const pa = a.position;
    const pb = b.position;
    if (pa && pb) {
        if (Math.abs(pa.x - pb.x) > 0.5 || Math.abs(pa.y - pb.y) > 0.5 || Math.abs(pa.z - pb.z) > 0.5)
            return false;
    }
    else if (Boolean(pa) !== Boolean(pb)) {
        return false;
    }
    const ha = a.orthoHeight;
    const hb = b.orthoHeight;
    if (typeof ha === 'number' || typeof hb === 'number') {
        if (typeof ha !== 'number' || typeof hb !== 'number')
            return false;
        const scale = Math.max(Math.abs(ha), Math.abs(hb), 1e-6);
        if (Math.abs(ha - hb) / scale > 0.005)
            return false;
    }
    if (typeof a.fov === 'number' && typeof b.fov === 'number' && Math.abs(a.fov - b.fov) > 0.01)
        return false;
    const ra = a.rotation;
    const rb = b.rotation;
    if (ra && rb) {
        const dot = ra.x * rb.x + ra.y * rb.y + ra.z * rb.z + ra.w * rb.w;
        if (Math.abs(dot) < 0.9999)
            return false;
    }
    return true;
}
function saveCameraState(manager, cam) {
    let info = null;
    try {
        if (typeof manager.getCurCameraInfo === 'function')
            info = manager.getCurCameraInfo();
    }
    catch {
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
function writeBackCamera(cam, saved) {
    const problems = [];
    const node = cam && cam.node ? cam.node : null;
    const sig = saved.signature;
    if (node && sig.position) {
        try {
            const p = sig.position;
            if (typeof node.setWorldPosition === 'function')
                node.setWorldPosition(p.x, p.y, p.z);
            else
                node.worldPosition = p;
        }
        catch (err) {
            problems.push(`位置写回失败（${errorInfo(err).message}）`);
        }
    }
    if (node && sig.rotation) {
        try {
            const r = sig.rotation;
            if (typeof node.setWorldRotation === 'function') {
                const Quat = getCc().Quat;
                node.setWorldRotation(new Quat(r.x, r.y, r.z, r.w));
            }
        }
        catch (err) {
            problems.push(`朝向写回失败（${errorInfo(err).message}）`);
        }
    }
    if (saved.raw.orthoHeight !== null) {
        try {
            cam.orthoHeight = saved.raw.orthoHeight;
        }
        catch (err) {
            problems.push(`orthoHeight 写回失败（${errorInfo(err).message}）`);
        }
    }
    if (saved.raw.fov !== null) {
        try {
            cam.fov = saved.raw.fov;
        }
        catch {
            /* 2D 相机没有 fov 是正常的 */
        }
    }
    if (saved.raw.projection !== null) {
        try {
            cam.projection = saved.raw.projection;
        }
        catch {
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
function restoreCameraState(manager, cam, saved) {
    const notes = [];
    if (saved.info) {
        try {
            manager.focus(null, saved.info, true);
        }
        catch (err) {
            notes.push(`focus(null, info) 还原失败：${errorInfo(err).message}`);
        }
        const afterInfo = cameraSignature(cam);
        if (sameCamera(afterInfo, saved.signature))
            return { restored: true, method: 'info', after: afterInfo };
        notes.push('focus(null, info) 没能把视角还原回原样');
    }
    else {
        notes.push('拿不到编辑器视角信息（getCurCameraInfo 不可用），只能直接写回相机字段');
    }
    const writeNote = writeBackCamera(cam, saved);
    if (writeNote)
        notes.push(writeNote);
    const afterRaw = cameraSignature(cam);
    if (sameCamera(afterRaw, saved.signature))
        return { restored: true, method: 'raw', after: afterRaw };
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
function manualOrthoFit(cc, cam, world, margin) {
    const width = safeNumber(() => cam.camera.width) || 0;
    const height = safeNumber(() => cam.camera.height) || 0;
    const orthoHeight = safeNumber(() => cam.orthoHeight);
    const node = cam && cam.node ? cam.node : null;
    if (!width || !height || !orthoHeight || !node) {
        return { ok: false, note: '量不到相机尺寸/orthoHeight 或拿不到相机节点，手工取景跳过' };
    }
    const Vec3 = cc.Vec3;
    const project = (x, y) => {
        try {
            const point = cam.worldToScreen(new Vec3(x, y, 0));
            return { x: point.x, y: point.y };
        }
        catch {
            return null;
        }
    };
    const probe = () => {
        const p0 = project(world.cx, world.cy);
        const px = project(world.cx + PROBE_UNITS, world.cy);
        const py = project(world.cx, world.cy + PROBE_UNITS);
        if (!p0 || !px || !py)
            return null;
        const kx = (px.x - p0.x) / PROBE_UNITS;
        const ky = (py.y - p0.y) / PROBE_UNITS;
        if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx === 0 || ky === 0)
            return null;
        return { kx, ky, center: p0 };
    };
    const first = probe();
    if (!first)
        return { ok: false, note: 'worldToScreen 量不出「像素/世界单位」（相机可能还没准备好）' };
    /** ① 缩放：让目标矩形在留白之后刚好装进画布 */
    const wantK = Math.min((width * (1 - margin * 2)) / (world.width > 0 ? world.width : 1), (height * (1 - margin * 2)) / (world.height > 0 ? world.height : 1));
    try {
        cam.orthoHeight = orthoHeight * (first.kx / wantK);
    }
    catch (err) {
        return { ok: false, note: `写 orthoHeight 失败：${errorInfo(err).message}` };
    }
    /** ② 对中：量残余 → 按斜率挪相机，两次（正交是线性的，两次足够收敛到亚像素） */
    let residual = null;
    for (let i = 0; i < 2; i += 1) {
        const measured = probe();
        if (!measured)
            break;
        residual = { x: width / 2 - measured.center.x, y: height / 2 - measured.center.y };
        // ∂screen/∂相机位置 = −(∂screen/∂世界位置)，所以除以 −k
        const dx = residual.x / -measured.kx;
        const dy = residual.y / -measured.ky;
        try {
            const pos = node.worldPosition;
            if (typeof node.setWorldPosition === 'function')
                node.setWorldPosition(pos.x + dx, pos.y + dy, pos.z);
            else
                node.worldPosition = { x: pos.x + dx, y: pos.y + dy, z: pos.z };
        }
        catch (err) {
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
let pendingFit = null;
/** 取景现场超过这个时间还没被还原就作废（别把几分钟前的旧视角盖回用户脸上）。 */
const FIT_STATE_TTL_MS = 60000;
/** 取景 token 的自增尾巴（同一毫秒内多次取景也能区分）。 */
let fitCounter = 0;
/** 执行第 `step` 级取景。@returns `method: null` = 这一级没做成（原因在 note） */
function applyFitStep(cc, manager, cam, step, target, is2D) {
    if (!target.world)
        return { method: null, note: target.note || '没有可用的世界矩形，取景跳过' };
    if (step === 0) {
        if (typeof manager.focus !== 'function')
            return { method: null, note: 'cce.Camera.focus 不存在（编辑器版本差异）' };
        if (target.uuids.length === 0)
            return { method: null, note: '没有可聚焦的 uuid（内容节点没有 uuid？）' };
        try {
            manager.focus(target.uuids, undefined, true);
        }
        catch (err) {
            return { method: null, note: `cce.Camera.focus 抛异常：${errorInfo(err).message}` };
        }
        return { method: 'focus' };
    }
    if (step === 1) {
        if (is2D !== true)
            return { method: null, note: '非 2D 视图没有 _adjustToCenter（3D 只走 focus）' };
        const controller = manager.controller2D;
        if (!controller || typeof controller._adjustToCenter !== 'function') {
            return { method: null, note: 'cce.Camera.controller2D._adjustToCenter 不存在（编辑器版本差异）' };
        }
        try {
            const rect = new cc.Rect(target.world.cx - target.world.width / 2, target.world.cy - target.world.height / 2, target.world.width, target.world.height);
            controller._adjustToCenter(FIT_MARGIN, rect, true);
        }
        catch (err) {
            return { method: null, note: `_adjustToCenter 抛异常：${errorInfo(err).message}` };
        }
        return { method: 'adjust' };
    }
    if (step === 2) {
        if (is2D !== true)
            return { method: null, note: '手工取景只实现了 2D 正交（3D 要动 FOV/距离，先不做）' };
        const applied = manualOrthoFit(cc, cam, target.world, FIT_MARGIN);
        return { method: applied.ok ? 'manual' : null, note: applied.note, detail: applied.detail };
    }
    return { method: null, note: `没有第 ${step} 级取景` };
}
/** 2D 能用三级，3D 只有 focus 一级（其余两级都没实现/不适用）。 */
function maxFitSteps(is2D) {
    return is2D === true ? 3 : 1;
}
/**
 * 场景视图几何（`contributions.scene` 的 `viewMetrics`）。
 *
 * @returns `{ok, page, canvas, view, camera, node?, framing?}` —— 主进程拿它定位
 *   webContents、换算裁切矩形；`node.rect` 是**页面 CSS 像素**（左上角原点）；
 *   给了 `fit` 时再多一项 `framing`：**目标有没有整个落在画布里**（取景链的判据）。
 */
function collectViewMetrics(cc, payload) {
    const canvas = findViewCanvas(cc);
    const camera = editorCamera();
    const cam = camera.cam;
    const metrics = {
        ok: true,
        page: pageGeometry(),
        canvas: canvasGeometry(canvas),
        view: canvas ? readViewState(cc, canvas) : null,
        /**
         * 现在这一页画的是**编辑器场景**还是**跑着的游戏**（见 `readSceneMode`）。
         * 截图/点节点/裁矩形都要先看它：运行态下编辑器相机不是那台在渲染的相机。
         */
        runtime: readSceneMode(cc),
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
    if (!ref && !fitSpec)
        return metrics;
    const helpers = makeHelpers(cc, {
        projectPath: typeof payload.projectPath === 'string' ? payload.projectPath : '',
    }).helpers;
    let node = null;
    if (ref) {
        try {
            node = helpers.nodeByUuid(ref) || helpers.nodeByPath(ref) || null;
        }
        catch (err) {
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
        const info = { ref, found: true, uuid: node.uuid, name: node.name };
        try {
            info.worldRect = helpers.worldRect(node);
        }
        catch {
            /* 忽略：世界矩形只是附带信息 */
        }
        if (!cam) {
            info.rect = null;
            info.note = `${camera.note || '编辑器相机不可用'}：算不出节点在视图里的矩形（会退成整张视图）`;
            metrics.node = info;
        }
        else {
            const projected = projectNodeRect(cc, cam, node, canvas);
            info.rect = projected.rect;
            info.canvasRect = projected.canvasRect;
            if (projected.note)
                info.note = projected.note;
            metrics.node = info;
        }
    }
    /** 取景报告：目标矩形 vs 画布矩形（「拍全了没有」） */
    if (fitSpec) {
        const viewport = viewportOf(canvas);
        const target = fitTargetOf(helpers, fitSpec, node);
        const framing = {
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
        }
        else if (!cam) {
            framing.note = camera.note || '编辑器相机不可用，判断不了拍全没有';
        }
        else {
            /** 目标矩形：节点目标直接用**已经算好的**节点矩形（同一份投影，不重复走一遍） */
            const nodeRect = metrics.node ? metrics.node.rect : null;
            let pageRect = null;
            if (fitSpec.kind === 'node') {
                pageRect = nodeRect && typeof nodeRect.width === 'number' ? nodeRect : null;
                if (!pageRect)
                    framing.note = framing.note || '节点算不出矩形，判断不了拍全没有';
            }
            else if (target.world) {
                const projected = projectWorldBox(cc, cam, canvas, {
                    cx: target.world.cx,
                    cy: target.world.cy,
                    wz: 0,
                    width: target.world.width,
                    height: target.world.height,
                });
                pageRect = projected.rect;
                if (!pageRect && projected.note)
                    framing.note = framing.note || projected.note;
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
/**
 * 构造注入沙箱的助手函数。
 *
 * 这些是「AI 写代码时的起手式」——没有它们，模型每次都要从
 * `cc.director.getScene()` 开始手搓遍历，既费 token 又容易写错。
 */
function makeHelpers(cc, options) {
    const state = { snapshotRequested: false };
    const helpers = {};
    /**
     * 工程根 —— **优先用主进程随 payload 传进来的那个**（`Editor.Project.path`），
     * 拿不到再退回 `currentProjectPath()`（场景进程里的 `Editor` 全局量）。
     * 两个都没有时只影响「按路径解析资源」这一件事，其余助手照常。
     */
    const projectRoot = () => {
        const fromPayload = typeof (options === null || options === void 0 ? void 0 : options.projectPath) === 'string' ? options.projectPath : '';
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
            if (flags && typeof flags.HideInHierarchy === 'number')
                return flags.HideInHierarchy;
        }
        catch {
            /* 引擎版本变动时回落到 3.8.6 的实测值 */
        }
        return 1024;
    })();
    /** 名字兜底：万一哪天 `Flags.HideInHierarchy` 挪位了，这两个根还能被认出来 */
    const editorRootNames = ['Editor Scene Foreground', 'Editor Scene Background'];
    const isEditorNode = (node) => {
        if (!node)
            return false;
        try {
            // `hideFlags` 是 CCObject 的公开访问器（内部已 & AllHideMasks），优先用它
            const flags = typeof node.hideFlags === 'number'
                ? node.hideFlags
                : typeof node._objFlags === 'number'
                    ? node._objFlags
                    : 0;
            if ((flags & hideInHierarchy) !== 0)
                return true;
        }
        catch {
            /* 取不到标志位就只剩名字兜底 */
        }
        return editorRootNames.indexOf(node.name) >= 0;
    };
    /** 子节点里属于「真实内容」的那些 */
    const contentChildren = (node) => {
        const children = (node && node.children) || [];
        return children.filter((child) => !isEditorNode(child));
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
    const resolvePathBySegments = (path) => {
        const scene = currentScene(cc);
        if (!scene)
            return null;
        const segments = String(path)
            .split('/')
            .filter((segment) => segment.length > 0);
        if (segments.length === 0)
            return scene;
        // 允许把场景自己的名字写在最前面
        if (segments[0] === scene.name)
            segments.shift();
        if (segments.length === 0)
            return scene;
        let cursor = scene;
        let index = 0;
        while (index < segments.length) {
            let found = null;
            for (let end = segments.length; end > index; end -= 1) {
                const candidate = segments.slice(index, end).join('/');
                let child = null;
                try {
                    child = cursor.getChildByName(candidate);
                }
                catch {
                    child = null;
                }
                if (child) {
                    found = child;
                    index = end;
                    break;
                }
            }
            if (!found)
                return null;
            cursor = found;
        }
        return cursor;
    };
    /** 按 uuid 找节点（先走引擎快路径，找不到再整树扫） */
    helpers.nodeByUuid = (uuid) => {
        const scene = currentScene(cc);
        if (!scene)
            return null;
        if (scene.uuid === uuid)
            return scene;
        try {
            const fast = scene.getChildByUuid(uuid);
            if (fast)
                return fast;
        }
        catch {
            /* 引擎内部实现变动时回落到整树扫描 */
        }
        let found = null;
        eachNode(scene, (n) => {
            if (!found && n.uuid === uuid)
                found = n;
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
    helpers.nodeByPath = (path) => {
        try {
            const fast = cc.find(path);
            if (fast)
                return fast;
        }
        catch {
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
    helpers.eachNode = (visit, root, options) => {
        const start = root || currentScene(cc);
        if (!start)
            return;
        const includeEditor = Boolean(options && options.includeEditor);
        // 迭代式深度优先；剪枝发生在「入栈」这一步（跳过编辑器根，整棵子树就没了）
        const stack = [start];
        while (stack.length > 0) {
            const node = stack.pop();
            visit(node);
            const children = node.children || [];
            for (let i = children.length - 1; i >= 0; i -= 1) {
                const child = children[i];
                if (!includeEditor && isEditorNode(child))
                    continue;
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
    helpers.tree = (options) => {
        const opts = options || {};
        const root = opts.root || currentScene(cc);
        if (!root)
            return null;
        const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 3;
        const includeEditor = Boolean(opts.includeEditor);
        const build = (node, depth) => {
            const out = {
                name: node.name,
                uuid: node.uuid,
                active: node.active,
            };
            if (opts.withComponents) {
                out.components = (node.components || []).map((c) => {
                    try {
                        return { type: cc.js.getClassName(c), enabled: c.enabled };
                    }
                    catch {
                        return { type: 'unknown' };
                    }
                });
            }
            const allChildren = node.children || [];
            const children = includeEditor
                ? allChildren
                : allChildren.filter((child) => !isEditorNode(child));
            if (children.length > 0) {
                out.childCount = children.length;
                if (depth < maxDepth) {
                    out.children = children.map((c) => build(c, depth + 1));
                }
                else {
                    out.children = children.map((c) => ({ name: c.name, uuid: c.uuid }));
                }
            }
            // 藏了东西就说一声，别让调用方以为树就这么大
            const hidden = allChildren.length - children.length;
            if (hidden > 0)
                out.editorChildrenHidden = hidden;
            return out;
        };
        return build(root, 0);
    };
    /** 这个节点是不是编辑器自己的装饰（gizmo / 网格 / 参考图） */
    helpers.isEditorNode = (node) => isEditorNode(node);
    /** 真实内容子节点（已滤掉编辑器装饰） */
    helpers.contentChildren = (node) => contentChildren(node || currentScene(cc));
    /**
     * 展开一个节点或组件为纯数据对象。
     *
     * 这是 `engineObjectTag` 摘要的「逃生舱」：返回值序列化时默认把 cc 对象压成
     * `[Node name=x uuid=y]`，想看细节就得走 `dump()`，它会**显式取字段**，
     * 于是既拿得到数据，又不会因为循环引用炸掉。
     */
    helpers.dump = (target) => {
        if (!target)
            return null;
        // 是组件（有 node 字段且自身不是 Node）
        if (target.node && !target.children) {
            const out = {
                __kind: 'component',
                type: (() => {
                    try {
                        return cc.js.getClassName(target);
                    }
                    catch {
                        return target.constructor && target.constructor.name;
                    }
                })(),
                node: shortNode(target.node),
                enabled: target.enabled,
            };
            const props = {};
            for (const key of componentPropNames(target)) {
                const read = safeRead(target, key);
                if (read.ok)
                    props[key] = read.value;
            }
            out.props = props;
            return out;
        }
        // 是节点
        if (target.children && typeof target.uuid === 'string') {
            const components = [];
            for (const comp of target.components || []) {
                let typeName = 'unknown';
                try {
                    typeName = cc.js.getClassName(comp);
                }
                catch {
                    typeName = (comp.constructor && comp.constructor.name) || 'unknown';
                }
                const props = {};
                for (const key of componentPropNames(comp)) {
                    const read = safeRead(comp, key);
                    if (read.ok)
                        props[key] = read.value;
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
                children: (target.children || []).map((c) => shortNode(c)),
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
    helpers.snapshot = () => {
        state.snapshotRequested = true;
    };
    /** 睡眠指定毫秒（配合 `await` 做轮询，比让模型在 tool call 之间干等省得多） */
    helpers.sleep = (ms) => new Promise((resolve) => {
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
    helpers.captureView = async (options) => {
        const opts = options || {};
        const format = opts.format === 'jpeg' || opts.format === 'jpg' ? 'jpeg' : 'png';
        const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = typeof opts.quality === 'number' ? Math.min(1, Math.max(0.1, opts.quality)) : 0.9;
        const maxWidth = typeof opts.maxWidth === 'number' && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 640;
        const waitMs = typeof opts.waitMs === 'number' ? Math.max(0, Math.min(5000, opts.waitMs)) : 800;
        const canvas = findViewCanvas(cc);
        if (!canvas)
            return { ok: false, error: '找不到场景视图的画布：scene 进程里没有可用的 canvas。' };
        let frame;
        try {
            frame = await readViewPixels(cc, canvas, waitMs);
        }
        catch (err) {
            return { ok: false, error: `读取画面失败：${errorInfo(err).message}` };
        }
        let encoded;
        try {
            encoded = encodeFrameToDataUrl(frame.pixels, frame.width, frame.height, {
                maxWidth,
                mime,
                quality,
            });
        }
        catch (err) {
            return { ok: false, error: `编码图片失败：${errorInfo(err).message}` };
        }
        const comma = encoded.dataUrl.indexOf(',');
        const base64 = comma >= 0 ? encoded.dataUrl.slice(comma + 1) : '';
        const info = {
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
                if (dir)
                    node.fs.mkdirSync(dir, { recursive: true });
                node.fs.writeFileSync(savePath, Buffer.from(base64, 'base64'));
                return { ...info, transport: 'file', path: savePath };
            }
            catch (err) {
                // 写不进去也要让调用方拿到图 —— 回落分块
                info.saveError = errorInfo(err).message;
            }
        }
        const chunkSize = 3000; // 沙箱单字符串上限 4000，留出余量
        const chunks = [];
        for (let i = 0; i < base64.length; i += chunkSize)
            chunks.push(base64.slice(i, i + chunkSize));
        if (chunks.length > 90) {
            return {
                ...info,
                ok: false,
                error: `截图太大，需要回传 ${chunks.length} 块（上限 90）：把 maxWidth 调小` +
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
    const frameCache = new Map();
    helpers.loadFrame = async (ref) => {
        const raw = typeof ref === 'string' ? ref.trim() : '';
        if (!raw) {
            throw new Error("loadFrame(ref)：ref 是空的。用法：loadFrame('db://assets/resources/textures/common/rect_rd_20.png')" +
                "（图片路径，可省 /spriteFrame）或 loadFrame('<uuid>@f9941')。");
        }
        if (frameCache.has(raw))
            return frameCache.get(raw);
        const candidates = [];
        const notes = [];
        /** 加载一个 uuid（回调式，与编辑器里实测能用的那条路一致）。 */
        const loadAny = (uuid) => new Promise((resolve, reject) => {
            try {
                cc.assetManager.loadAny({ uuid }, (err, asset) => err ? reject(new Error(err.message ? String(err.message) : String(err))) : resolve(asset));
            }
            catch (err) {
                reject(new Error(errorInfo(err).message));
            }
        });
        if (/@/.test(raw)) {
            candidates.push(raw);
        }
        else if (raw.indexOf('db://') === 0) {
            if (raw.indexOf('db://assets/') !== 0) {
                throw new Error(`loadFrame 只认 db://assets/ 下的资源（收到 ${raw}）。` +
                    'db://internal 是引擎自带资源、映射不到工程目录；内置 UI 图请按 skill 里的路径表用 loadAny({uuid}) 那条（uuid 从 asset-db 查）。');
            }
            const rel = raw.slice('db://assets/'.length).replace(/\/(spriteFrame|texture)$/, '');
            const root = projectRoot();
            const nodeMods = getNodeModules();
            if (!root || !nodeMods) {
                notes.push(`拿不到工程根（Editor.Project.path）或 node 模块，所以没能读 ${rel}.meta —— ` +
                    '改用 loadFrame("<uuid>@f9941")（uuid 从 editor 上下文 query-assets 拿）。');
            }
            else {
                const metaFile = `${nodeMods.path.join(root, 'assets', rel)}.meta`;
                let meta = null;
                try {
                    meta = JSON.parse(nodeMods.fs.readFileSync(metaFile, 'utf-8'));
                }
                catch (err) {
                    notes.push(`读不到 ${rel}.meta（${errorInfo(err).message}）`);
                }
                const subMetas = meta && typeof meta.subMetas === 'object' && meta.subMetas ? meta.subMetas : null;
                if (subMetas) {
                    for (const key of Object.keys(subMetas)) {
                        const entry = subMetas[key] || {};
                        const isSpriteFrame = entry.name === 'spriteFrame' ||
                            entry.importer === 'sprite-frame' ||
                            entry.importer === 'spriteFrame';
                        if (!isSpriteFrame)
                            continue;
                        // 子资源的 uuid 字段本身就带 `@key`；没有就自己拼
                        candidates.push(typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `${meta.uuid}@${key}`);
                        break;
                    }
                    if (candidates.length === 0) {
                        notes.push(`${rel}.meta 里没有 spriteFrame 子资源（它可能不是图片，或还没被资源库导入）`);
                    }
                }
            }
        }
        else if (/^[0-9a-fA-F-]{32,40}$/.test(raw)) {
            candidates.push(raw);
        }
        else {
            throw new Error(`loadFrame 认不出这个引用：${raw}。给 db://assets/… 的图片路径、uuid@子资源键，或裸 uuid。`);
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
            }
            catch (err) {
                last = `${candidate} → ${errorInfo(err).message}`;
            }
        }
        throw new Error(`loadFrame('${raw}') 没能拿到 SpriteFrame。${last ? `最后一次：${last}。` : ''}` +
            (notes.length > 0 ? `另外：${notes.join('；')}。` : '') +
            " 推荐写法：loadFrame('db://assets/resources/textures/common/rect_rd_20.png')。");
    };
    /**
     * 取节点的 `UITransform`（拿不到就 null）。
     *
     * 为什么要包一层：`cc.UITransform` 本身可能取不到（引擎版本/非 UI 节点），
     * 这时 `getComponent(undefined)` 有的版本会抛 —— 布局计算不该因为取不到尺寸而整条挂掉，
     * 宽高按 0 算、把坐标照常报出去更有用（调用方看到 `width: 0` 自然知道是没量到）。
     */
    const uiTransformOf = (node) => {
        try {
            if (!node || typeof node.getComponent !== 'function')
                return null;
            if (!cc.UITransform)
                return null;
            return node.getComponent(cc.UITransform) || null;
        }
        catch {
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
    helpers.worldRect = (node, options) => {
        if (!node)
            throw new Error('worldRect(node)：node 是空的。');
        const stopAt = options && options.root ? options.root : null;
        // ① 先自下而上收集链路：[node, parent, …, (stopAt | 场景根)]
        const chain = [];
        for (let cursor = node; cursor; cursor = cursor.parent) {
            chain.push(cursor);
            if (stopAt && cursor === stopAt)
                break;
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
        const round = (value) => Math.round(value * 1000) / 1000;
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
    helpers.contentBounds = () => {
        const round = (value) => Math.round(value * 1000) / 1000;
        /** `helpers` 自己的类型是 `Record<string, unknown>`，这里按签名取出来用（同 `worldRect` 内部的做法） */
        const each = helpers.eachNode;
        const rectOf = helpers.worldRect;
        let left = Infinity;
        let right = -Infinity;
        let bottom = Infinity;
        let top = -Infinity;
        let count = 0;
        each((node) => {
            const ut = uiTransformOf(node);
            if (!ut || !(ut.width > 0) || !(ut.height > 0))
                return;
            let rect;
            try {
                rect = rectOf(node);
            }
            catch {
                return; // 单个节点量不出来不该让整张表挂掉
            }
            if (![rect.left, rect.right, rect.bottom, rect.top].every((v) => typeof v === 'number' && Number.isFinite(v))) {
                return;
            }
            count += 1;
            if (rect.left < left)
                left = rect.left;
            if (rect.right > right)
                right = rect.right;
            if (rect.bottom < bottom)
                bottom = rect.bottom;
            if (rect.top > top)
                top = rect.top;
        });
        /** 交给 `focus()` 的 uuid：每一条支路上**最浅的**那个真有尺寸的节点（通常就是 Canvas） */
        const uuids = [];
        const focusWalk = (node) => {
            if (uuids.length >= 8)
                return;
            const ut = uiTransformOf(node);
            if (ut && ut.width > 0 && ut.height > 0) {
                if (node.uuid)
                    uuids.push(node.uuid);
                return;
            }
            for (const child of contentChildren(node))
                focusWalk(child);
        };
        const scene = currentScene(cc);
        if (scene) {
            for (const root of contentChildren(scene))
                focusWalk(root);
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
    const readNodePriority = (node) => {
        const ut = uiTransformOf(node);
        try {
            if (ut && typeof ut.priority === 'number')
                return ut.priority;
        }
        catch {
            /* 忽略 */
        }
        return 0;
    };
    /** 点是不是落在矩形里（**页面 CSS 像素、y 向下**）。 */
    const pointInCssRect = (rect, x, y) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
    /** 节点上「画得出来」的组件（按引擎里真实存在的类型取；取不到的类型跳过）。 */
    const visualComponentEntries = (node) => {
        const out = [];
        const pairs = [
            ['Sprite', cc.Sprite],
            ['Label', cc.Label],
            ['RichText', cc.RichText],
            ['Graphics', cc.Graphics],
            ['Mask', cc.Mask],
        ];
        for (const pair of pairs) {
            const name = pair[0];
            const ctor = pair[1];
            if (!ctor || !node || typeof node.getComponent !== 'function')
                continue;
            let comp = null;
            try {
                comp = node.getComponent(ctor);
            }
            catch {
                comp = null;
            }
            if (comp)
                out.push({ name, comp });
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
    const visualStateOf = (node) => {
        const entries = visualComponentEntries(node);
        const names = entries.map((e) => e.name);
        const caveats = [];
        if (entries.length === 0) {
            return { visible: false, names, reason: '没有任何渲染组件（只是容器）', caveats };
        }
        for (const entry of entries) {
            const comp = entry.comp;
            let alpha = 255;
            try {
                if (comp.color && typeof comp.color.a === 'number')
                    alpha = comp.color.a;
            }
            catch {
                /* 忽略 */
            }
            if (alpha <= 0)
                return { visible: false, names, reason: `${entry.name} 的 color.a = 0`, caveats };
            if (entry.name === 'Sprite') {
                let frame = null;
                try {
                    frame = comp.spriteFrame;
                }
                catch {
                    frame = null;
                }
                if (!frame)
                    return { visible: false, names, reason: 'Sprite 没设 spriteFrame', caveats };
            }
            if (entry.name === 'Label' || entry.name === 'RichText') {
                let text = '';
                try {
                    text = String(comp.string == null ? '' : comp.string);
                }
                catch {
                    text = '';
                }
                if (text.length === 0)
                    return { visible: false, names, reason: `${entry.name} 的 string 是空串`, caveats };
            }
            if (entry.name === 'Graphics' || entry.name === 'Mask') {
                caveats.push(`${entry.name} 的可见范围静态判不了（要重放指令流）—— 它在列表里只代表"有这个组件"`);
            }
        }
        return { visible: true, names, caveats };
    };
    /** 父链上所有 `UIOpacity` 的乘积（255 = 全不透明）。 */
    const opacityChainOf = (node) => {
        let product = 255;
        let cursor = node;
        while (cursor) {
            try {
                if (cc.UIOpacity && typeof cursor.getComponent === 'function') {
                    const op = cursor.getComponent(cc.UIOpacity);
                    if (op && typeof op.opacity === 'number')
                        product = (product * op.opacity) / 255;
                }
            }
            catch {
                /* 忽略 */
            }
            cursor = cursor.parent;
        }
        return Math.round(product);
    };
    /** 祖先里的 `Mask` 名字（**不判断点是否在模板内**，只报「被谁罩着」）。 */
    const maskAncestorsOf = (node) => {
        const out = [];
        let cursor = node ? node.parent : null;
        while (cursor) {
            try {
                if (cc.Mask && typeof cursor.getComponent === 'function') {
                    const mask = cursor.getComponent(cc.Mask);
                    if (mask && mask.enabledInHierarchy !== false)
                        out.push(String(cursor.name));
                }
            }
            catch {
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
    helpers.pick = (x, y, options) => {
        const opts = options || {};
        const space = typeof opts.space === 'string' ? opts.space : 'view';
        const limit = clampNumber(opts.limit, 1, 64, 12);
        if (space !== 'view' && space !== 'uv' && space !== 'world') {
            throw new Error(`pick(x, y, { space })：space 只认 'view'（页面 CSS 像素，默认）/ 'uv'（0~1）/ 'world'，收到 '${space}'。`);
        }
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            throw new Error(`pick(x, y)：坐标要都是有限数，收到 ${JSON.stringify(x)} / ${JSON.stringify(y)}。`);
        }
        const camInfo = editorCamera();
        if (!camInfo.cam) {
            throw new Error(`pick 要把世界坐标投到屏幕上，但现在拿不到编辑器相机：${camInfo.note || '未知原因'}。` +
                '（场景视图没打开、或者刚打开还没就绪 —— 不是"这个点上没有节点"。）');
        }
        const cam = camInfo.cam;
        const canvas = findViewCanvas(cc);
        const canvasBox = (canvasGeometry(canvas) || {});
        const page = pageGeometry();
        const cssWidth = typeof page.cssWidth === 'number' ? page.cssWidth : 0;
        const cssHeight = typeof page.cssHeight === 'number' ? page.cssHeight : 0;
        const canvasCssWidth = canvasBox.cssWidth || 0;
        const canvasDeviceWidth = canvasBox.deviceWidth || 0;
        const dpr = canvasCssWidth > 0 && canvasDeviceWidth > 0 ? canvasDeviceWidth / canvasCssWidth : pageDpr();
        const camHeight = safeNumber(() => cam.camera.height) || canvasBox.deviceHeight || 0;
        // ① 输入 → 页面 CSS 像素（左上角原点）
        let px = nx;
        let py = ny;
        let worldPoint = null;
        if (space === 'uv') {
            if (!cssWidth || !cssHeight) {
                throw new Error('pick(space:"uv") 要按页面尺寸折算，但场景页里没量到 window.innerWidth/innerHeight。改用 space:"view" 自己乘。');
            }
            px = nx * cssWidth;
            py = ny * cssHeight;
        }
        else if (space === 'world') {
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
                const localX = px - (canvasBox.left || 0);
                const localY = py - (canvasBox.top || 0);
                const w = cam.screenToWorld(new cc.Vec3(localX * dpr, camHeight - localY * dpr, 0));
                if (w && typeof w.x === 'number' && typeof w.y === 'number') {
                    worldPoint = { x: round3(w.x), y: round3(w.y) };
                }
            }
            catch {
                worldPoint = null; // 反投影不成立就如实回 null，不编一个
            }
        }
        const rootNode = opts.root || currentScene(cc);
        if (!rootNode)
            throw new Error('pick：当前没有打开的场景（也没给 root）。');
        const worldRectOf = helpers.worldRect;
        /** 画序表：同级按 priority、再按子节点顺序，父在自己子节点之前。 */
        const drawIndex = new Map();
        {
            let counter = 0;
            const walkOrder = (n) => {
                drawIndex.set(n, counter);
                counter += 1;
                const kids = (n && n.children) || [];
                const pairs = kids.map((k, i) => ({ k, i, p: readNodePriority(k) }));
                pairs.sort((a, b) => a.p - b.p || a.i - b.i);
                for (const pair of pairs)
                    walkOrder(pair.k);
            };
            walkOrder(rootNode);
        }
        /** 节点的页面 CSS 矩形（走 `worldRect` + `projectWorldBox`，与截图同一套换算）。 */
        const projectNodeCss = (node) => {
            let rect;
            try {
                rect = worldRectOf(node);
            }
            catch {
                return null;
            }
            if (!(rect.width > 0) || !(rect.height > 0))
                return null;
            let wz = 0;
            try {
                const wp = node.worldPosition;
                if (wp && typeof wp.z === 'number')
                    wz = wp.z;
            }
            catch {
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
        const hits = [];
        const invisible = [];
        const editorHits = [];
        const caveats = [];
        let scannedContent = 0;
        let scannedEditor = 0;
        const visitNode = (node, parentPath, underEditor) => {
            if (!node)
                return;
            const editorHere = underEditor || isEditorNode(node);
            const path = node === rootNode ? '' : parentPath ? `${parentPath}/${node.name}` : String(node.name);
            const ut = uiTransformOf(node);
            if (ut && ut.width > 0 && ut.height > 0) {
                const cssRect = projectNodeCss(node);
                if (cssRect && pointInCssRect(cssRect, px, py)) {
                    const row = {
                        path,
                        name: node.name,
                        uuid: node.uuid,
                        rect: cssRect,
                        area: Math.round(cssRect.width * cssRect.height),
                    };
                    if (editorHere) {
                        scannedEditor += 1;
                        if (editorHits.length < 8)
                            editorHits.push(row);
                    }
                    else {
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
                        const activeInHierarchy = node.activeInHierarchy !== undefined
                            ? node.activeInHierarchy !== false
                            : node.active !== false;
                        if (visual.names.length > 0) {
                            if (!activeInHierarchy) {
                                if (invisible.length < limit) {
                                    row.reason = 'active = false（或父链上有 inactive）';
                                    row.visual = visual.names;
                                    invisible.push(row);
                                }
                            }
                            else if (!visual.visible || opacity <= 0) {
                                if (invisible.length < limit) {
                                    row.reason = opacity <= 0 ? '父链 UIOpacity 合起来是 0' : visual.reason;
                                    row.visual = visual.names;
                                    invisible.push(row);
                                }
                            }
                            else {
                                row.visual = visual.names;
                                row.opacity = opacity;
                                row.maskedBy = maskedBy;
                                row.priority = readNodePriority(node);
                                row.order = drawIndex.has(node) ? drawIndex.get(node) : -1;
                                hits.push(row);
                                for (const caveat of visual.caveats) {
                                    if (caveats.indexOf(caveat) < 0)
                                        caveats.push(caveat);
                                }
                            }
                        }
                    }
                }
            }
            const kids = (node && node.children) || [];
            for (const child of kids)
                visitNode(child, path, editorHere);
        };
        visitNode(rootNode, '', false);
        hits.sort((a, b) => b.order - a.order);
        const verdict = hits.length > 0 ? 'content' : editorHits.length > 0 ? 'editor-overlay' : 'empty';
        let note = '';
        if (verdict === 'editor-overlay') {
            note =
                '这个点上**没有任何内容节点**，但有编辑器自己的装饰节点覆盖 —— 基本可以确定是 gizmo / 网格 / 参考图。' +
                    '截图里看到的东西若是这个颜色，它**不在场景数据里**，别去节点树或预制件里找它。';
        }
        else if (verdict === 'empty') {
            note = '这个点上既没有内容节点、也没有编辑器装饰（可能是清屏色 / 面板底色）。';
        }
        else if (hits.length > limit) {
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
    helpers.labelFit = (target, override) => {
        const ov = override || {};
        let node = null;
        let bag = null;
        if (target && typeof target.getComponent === 'function') {
            node = target;
            try {
                bag = cc.Label ? target.getComponent(cc.Label) : null;
            }
            catch {
                bag = null;
            }
            if (!bag) {
                throw new Error(`labelFit(node)：节点「${target.name}」上没有 cc.Label 组件。` +
                    "要问反事实就直接传 spec 对象，例如 labelFit({ text: '…', fontSize: 16, width: 210, height: 72, lineHeight: 24 })。");
            }
        }
        else if (target && typeof target === 'object') {
            bag = target;
        }
        else {
            throw new Error('labelFit(target)：target 要是一个节点 / 一个 Label 组件 / 一个 spec 对象' +
                "（如 { text, fontSize, width, height, lineHeight }）。");
        }
        const read = (key) => {
            if (ov[key] !== undefined)
                return ov[key];
            if (bag) {
                try {
                    if (bag[key] !== undefined)
                        return bag[key];
                }
                catch {
                    /* 忽略 */
                }
            }
            return undefined;
        };
        const ut = node ? uiTransformOf(node) : null;
        const text = String(read('text') !== undefined
            ? read('text')
            : read('string') !== undefined
                ? read('string')
                : '');
        const fontSize = Number(read('fontSize') !== undefined ? read('fontSize') : 14) || 14;
        const lineHeightRaw = Number(read('lineHeight') !== undefined ? read('lineHeight') : 0) || 0;
        const fontFamily = String(read('fontFamily') !== undefined ? read('fontFamily') : 'Arial') || 'Arial';
        const wrapOn = read('wrap') !== undefined ? Boolean(read('wrap')) : read('enableWrapText') !== undefined ? Boolean(read('enableWrapText')) : true;
        const boxWidth = Number(read('width') !== undefined ? read('width') : ut ? ut.width : 0) || 0;
        const boxHeight = Number(read('height') !== undefined ? read('height') : ut ? ut.height : 0) || 0;
        const OVERFLOW_NAMES = ['NONE', 'CLAMP', 'SHRINK', 'RESIZE_HEIGHT'];
        const rawOverflow = read('overflow') !== undefined ? read('overflow') : 'CLAMP';
        let overflowName = 'CLAMP';
        if (typeof rawOverflow === 'number')
            overflowName = OVERFLOW_NAMES[rawOverflow] || 'CLAMP';
        else if (typeof rawOverflow === 'string') {
            const upper = rawOverflow.trim().toUpperCase();
            overflowName = OVERFLOW_NAMES.indexOf(upper) >= 0 ? upper : 'CLAMP';
        }
        /** `overflow = NONE` 时引擎不折行；其余三种都会（只要开了 enableWrapText）。 */
        const wraps = wrapOn && overflowName !== 'NONE';
        const methods = new Set();
        /** 按某个字号排一遍版 —— SHRINK 要拿它二分，所以抽成函数。 */
        const layoutAt = (fs) => {
            const advance = lineHeightRaw > 0 ? lineHeightRaw : fs;
            const meas = (s) => {
                const result = measureTextWidth(s, fs, fontFamily);
                methods.add(result.method);
                return result.width;
            };
            const lines = [];
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
                    }
                    else {
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
        const capacityOf = (advance) => advance > 0 && boxHeight > 0
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
        let shrinkTo = null;
        if (overflowName === 'SHRINK') {
            let lo = 1;
            let hi = fontSize;
            for (let i = 0; i < 12 && hi - lo > 0.25; i += 1) {
                const mid = (lo + hi) / 2;
                const laid = layoutAt(mid);
                if (laid.lines.length <= capacityOf(laid.advance) && laid.maxLineWidth <= boxWidth + 0.5)
                    lo = mid;
                else
                    hi = mid;
            }
            shrinkTo = Math.round(lo * 100) / 100;
        }
        const reasons = [];
        let confidence = 'high';
        if (methods.has('estimate')) {
            confidence = 'low';
            reasons.push('宽度是**估**的（这个环境里没有 DOM 量不了字），中英混排可能差几个像素');
        }
        if (boxWidth > 0 && base.maxLineWidth > boxWidth * 0.98 && base.maxLineWidth <= boxWidth) {
            if (confidence === 'high')
                confidence = 'borderline';
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
    const SNAPSHOT_COMPONENT_PROPS = {
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
    const colourHex = (color) => {
        try {
            if (!color)
                return null;
            const part = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
                .toString(16)
                .padStart(2, '0');
            return `#${part(color.r)}${part(color.g)}${part(color.b)}${part(color.a)}`;
        }
        catch {
            return null;
        }
    };
    /** 把一个属性值压成**可比可读**的纯量（快照要能 JSON 化，也不能被 cc 对象拖爆）。 */
    const snapshotValue = (value) => {
        if (value === null || value === undefined)
            return null;
        const kind = typeof value;
        if (kind === 'string' || kind === 'number' || kind === 'boolean')
            return value;
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
    const snapshotNodeProps = (node) => {
        const out = {};
        out.active = node.active !== false;
        out.position = snapshotValue(node.position);
        out.scale = snapshotValue(node.scale);
        if (typeof node.layer === 'number')
            out.layer = node.layer;
        const ut = uiTransformOf(node);
        if (ut) {
            out.contentSize = snapshotValue(ut);
            out.anchor = `${round3(ut.anchorX)},${round3(ut.anchorY)}`;
            try {
                if (typeof ut.priority === 'number')
                    out.priority = ut.priority;
            }
            catch {
                /* 忽略 */
            }
        }
        try {
            if (typeof node.getSiblingIndex === 'function')
                out.siblingIndex = node.getSiblingIndex();
        }
        catch {
            /* 忽略 */
        }
        let list = [];
        try {
            if (Array.isArray(node.components))
                list = node.components;
            else if (Array.isArray(node._components))
                list = node._components;
        }
        catch {
            list = [];
        }
        const names = [];
        for (const comp of list) {
            if (!comp)
                continue;
            const typeName = String((comp.constructor && comp.constructor.name) || 'Component');
            names.push(typeName);
            const wanted = SNAPSHOT_COMPONENT_PROPS[typeName];
            if (!wanted)
                continue;
            /**
             * 组件字段**摊平成 `Type.field` 一个键**，而不是嵌成 `{Label: {…}}` ——
             * 否则改一个字体会把整个 Label 的字段袋报成 from/to，
             * 「哪一条变了」就看不出来了（实测第一版就是这样，diff 回执一屏全是噪声）。
             */
            for (const key of wanted) {
                let raw;
                try {
                    raw = comp[key];
                }
                catch {
                    continue;
                }
                if (raw === undefined)
                    continue;
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
    const hashOf = (text) => {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    };
    /** 落盘（拿不到 `fs` 就如实回 null，不假装写了）。 */
    const writeTextFile = (savePath, text) => {
        const nodeMods = getNodeModules();
        if (!nodeMods)
            return { path: null, error: '这个进程里拿不到 fs，写不了盘' };
        try {
            const dir = nodeMods.path.dirname(savePath);
            if (dir)
                nodeMods.fs.mkdirSync(dir, { recursive: true });
            nodeMods.fs.writeFileSync(savePath, text, 'utf-8');
            return { path: savePath };
        }
        catch (err) {
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
    helpers.snapshotTree = (root, options) => {
        const opts = options || {};
        const label = typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : `snap-${snapshotStore.size + 1}`;
        const maxNodes = clampNumber(opts.maxNodes, 1, 200000, 20000);
        const start = root || currentScene(cc);
        if (!start)
            throw new Error('snapshotTree(root)：当前没有打开的场景（也没给 root）。');
        const nodes = {};
        const includeEditor = Boolean(opts.includeEditor);
        let count = 0;
        let truncated = 0;
        const visit = (node, path) => {
            if (count >= maxNodes) {
                truncated += 1;
                return;
            }
            nodes[path] = snapshotNodeProps(node);
            count += 1;
            const kids = (node && node.children) || [];
            const pairs = kids.map((k, i) => ({ k, i, p: readNodePriority(k) }));
            pairs.sort((a, b) => a.p - b.p || a.i - b.i);
            for (const pair of pairs) {
                /**
                 * 默认**剪掉编辑器装饰**（gizmo / 网格 / 参考图）。不只是省体积：
                 * 那些节点是编辑器**自己重建**的，名字与层级会随视角/选中态变，
                 * 留着它们会让 diff 里冒出一堆"新增/删除了 xAxis"的假信号 ——
                 * 一个会喊狼来了的 diff 比没有 diff 更糟。
                 */
                if (!includeEditor && isEditorNode(pair.k))
                    continue;
                const name = String(pair.k.name);
                visit(pair.k, path ? `${path}/${name}` : name);
            }
        };
        visit(start, '.');
        const tree = { root: String(start.name || 'scene'), at: new Date().toISOString(), nodes };
        const json = JSON.stringify(tree);
        /**
         * ⚠ 哈希**只取内容**（`root` + `nodes`），**不含 `at` 时间戳**。
         *
         * 原来是 `hashOf(json)` —— 连 `at` 一起哈希，于是"同一棵树连拍两次哈希相同"只在
         * **两次落在同一毫秒**时才成立（2026-11 被 verify 的计时抖动抓了个正着：
         * `{"same":false,"bytes":true,"nodeCount":6}`）。一个会随时间变的哈希当不了内容指纹，
         * 而"拍一次 → 改 → 再拍 → 比哈希"正是这个助手存在的理由。
         */
        const record = { label, tree, hash: hashOf(JSON.stringify({ root: tree.root, nodes })), bytes: json.length, at: tree.at };
        // 淘汰最旧的（Map 保持插入序）
        snapshotStore.set(label, record);
        while (snapshotStore.size > SNAPSHOT_KEEP) {
            const oldest = snapshotStore.keys().next();
            if (oldest.done)
                break;
            snapshotStore.delete(oldest.value);
        }
        let saved = null;
        let saveError;
        if (typeof opts.saveTo === 'string' && opts.saveTo.trim()) {
            const written = writeTextFile(opts.saveTo.trim(), JSON.stringify(record, null, 2));
            saved = written.path;
            saveError = written.error;
        }
        const notes = [];
        if (truncated > 0) {
            notes.push(`节点数超过 maxNodes=${maxNodes}，这份快照**不完整** —— diff 会把没拍到的节点当成"被删了"。`);
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
    helpers.diffTree = (before, after, options) => {
        const opts = options || {};
        const limit = clampNumber(opts.limit, 1, 5000, 40);
        const resolveSnap = (ref, side) => {
            if (typeof ref === 'string') {
                const found = snapshotStore.get(ref);
                if (!found) {
                    throw new Error(`diffTree：没有名为 '${ref}' 的快照（${side}）。已有的：${Array.from(snapshotStore.keys()).join(', ') || '（一份都没有）'}。先用 snapshotTree(null, { label: '${ref}' }) 拍一份。`);
                }
                return found;
            }
            if (ref && typeof ref === 'object') {
                const tree = ref.tree || ref;
                if (tree && typeof tree === 'object' && tree.nodes) {
                    return ref;
                }
            }
            throw new Error(`diffTree：${side} 既不是快照 label，也不是一份快照对象（要有 .tree.nodes 或 .nodes）。`);
        };
        const snapA = resolveSnap(before, 'before');
        const snapB = resolveSnap(after, 'after');
        const nodesA = (snapA.tree ? snapA.tree.nodes : snapA.nodes);
        const nodesB = (snapB.tree ? snapB.tree.nodes : snapB.nodes);
        const changed = [];
        const added = [];
        const removed = [];
        let unchanged = 0;
        for (const key of Object.keys(nodesB)) {
            if (!(key in nodesA)) {
                added.push(key);
                continue;
            }
            const a = nodesA[key] || {};
            const b = nodesB[key] || {};
            const props = {};
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            for (const prop of keys) {
                const av = JSON.stringify(a[prop]);
                const bv = JSON.stringify(b[prop]);
                if (av !== bv)
                    props[prop] = { from: a[prop] === undefined ? null : a[prop], to: b[prop] === undefined ? null : b[prop] };
            }
            if (Object.keys(props).length > 0)
                changed.push({ path: key, props });
            else
                unchanged += 1;
        }
        for (const key of Object.keys(nodesA))
            if (!(key in nodesB))
                removed.push(key);
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
        let saved = null;
        let saveError;
        if (typeof opts.saveTo === 'string' && opts.saveTo.trim()) {
            const written = writeTextFile(opts.saveTo.trim(), JSON.stringify(report, null, 2));
            saved = written.path;
            saveError = written.error;
        }
        const suspectLeaks = added.filter((p) => /__|probe|tmp|temp|test/i.test(p));
        const notes = [];
        if (changed.length === 0 && added.length === 0 && removed.length === 0) {
            notes.push('两份快照一模一样 —— 要么真没改动，要么改完**没存盘**（编辑态改了不存，场景数据就是没变）。');
        }
        if (suspectLeaks.length > 0) {
            notes.push(`⚠ 新增节点里有 ${suspectLeaks.length} 个名字像临时探针（${suspectLeaks.slice(0, 5).join(', ')}）—— 确认一下是不是忘了删。`);
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
    helpers.helperNames = () => Object.keys(helpers).sort();
    return { helpers, state };
}
function makeCapturedConsole(sink, startedAt, maxLogs, maxLogLength) {
    let truncated = false;
    const stringify = (value) => {
        var _a;
        if (typeof value === 'string')
            return value;
        try {
            return (_a = JSON.stringify(value, (_k, v) => {
                if (typeof v === 'function')
                    return `[Function ${v.name || 'anonymous'}]`;
                if (typeof v === 'bigint')
                    return `${v}n`;
                return v;
            }, 0)) !== null && _a !== void 0 ? _a : String(value);
        }
        catch {
            return String(value);
        }
    };
    const push = (level) => (...parts) => {
        if (sink.length >= maxLogs) {
            truncated = true;
            return;
        }
        let text = parts.map(stringify).join(' ');
        if (text.length > maxLogLength)
            text = `${text.slice(0, maxLogLength)}…`;
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
let vmModule = null;
let vmUnavailable = false;
/** 拿 `vm` 模块；引擎进程里拿不到就返回 null（调用方回落到 new Function） */
function getVmModule() {
    if (vmModule)
        return vmModule;
    if (vmUnavailable)
        return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('vm');
        if (mod && typeof mod.runInThisContext === 'function') {
            vmModule = mod;
            return mod;
        }
        vmUnavailable = true;
        return null;
    }
    catch {
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
function buildSceneSource(globals, code) {
    const names = Object.keys(globals);
    // 注意：`let` 关键字只能出现一次。写成 `let a = 1, let b = 2` 会报
    // "let is disallowed as a lexically bound name"（踩过）。
    const declarations = `let ${names.map((name) => `${name} = __dshCtx.${name}`).join(', ')}`;
    return `(async () => { const __dshCtx = globalThis.${INJECT_GLOBAL_KEY}; ${declarations};\n${code}\n})();`;
}
/** 策略一：`vm.runInThisContext` —— 同 realm + 同步超时（首选） */
async function runViaRunInThisContext(vmMod, globals, code, timeoutMs, finish, state) {
    const target = globalThis;
    const hadPrevious = Object.prototype.hasOwnProperty.call(globalThis, INJECT_GLOBAL_KEY);
    const previousValue = hadPrevious ? target[INJECT_GLOBAL_KEY] : undefined;
    const restore = () => {
        try {
            if (hadPrevious)
                target[INJECT_GLOBAL_KEY] = previousValue;
            else
                delete target[INJECT_GLOBAL_KEY];
        }
        catch {
            /* 还原失败不致命：下一次执行会重新覆盖 */
        }
    };
    let timer;
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
    }
    catch (err) {
        return finish({
            ok: false,
            error: errorInfo(err),
            timedOut: isTimeout(err),
            snapshotRequested: state.snapshotRequested,
        });
    }
    finally {
        if (timer)
            clearTimeout(timer);
        restore();
    }
}
/**
 * 策略二：`new Function` —— 兜底。
 *
 * 全局量走**显式形参**，不碰 `globalThis`，任何 JS 环境都能用。
 * 代价：`timeout` 只由外层计时器实现，**掐不断同步死循环**。
 */
async function runViaNewFunction(globals, code, timeoutMs, finish, state) {
    const names = Object.keys(globals);
    const values = names.map((n) => globals[n]);
    let fn;
    try {
        fn = new Function(...names, `return (async () => {\n${code}\n})();`);
    }
    catch (err) {
        return finish({ ok: false, error: errorInfo(err) });
    }
    let timer;
    try {
        const result = await Promise.race([
            Promise.resolve(fn(...values)),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
            }),
        ]);
        return finish({ ok: true, result, snapshotRequested: state.snapshotRequested });
    }
    catch (err) {
        return finish({
            ok: false,
            error: errorInfo(err),
            timedOut: isTimeout(err),
            snapshotRequested: state.snapshotRequested,
        });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function executeSceneCode(payload, depth = 0) {
    const startedAt = Date.now();
    const logs = [];
    const code = typeof payload.code === 'string' ? payload.code : '';
    const maxLogs = typeof payload.maxLogs === 'number' ? payload.maxLogs : 200;
    const maxLogLength = typeof payload.maxLogLength === 'number' ? payload.maxLogLength : 4000;
    const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 15000;
    const { console: capturedConsole, wasTruncated } = makeCapturedConsole(logs, startedAt, maxLogs, maxLogLength);
    const finish = (extra) => ({
        logs,
        logsTruncated: wasTruncated(),
        durationMs: Date.now() - startedAt,
        ...extra,
    });
    if (!code.trim()) {
        return finish({ ok: false, error: { name: 'Error', message: 'code 不能为空' } });
    }
    let cc;
    try {
        cc = getCc();
    }
    catch (err) {
        return finish({ ok: false, error: errorInfo(err) });
    }
    const { helpers, state } = makeHelpers(cc, { projectPath: payload.projectPath });
    const scene = currentScene(cc);
    // recipe 五件套 —— 与 editor 上下文**同一份实现**（跨进程 require dist/core/recipes.js）。
    // 加载失败不让整个 execute_code 挂掉，而是降级成「五个都返回错误」。
    let recipeHelpers;
    try {
        const recipes = getRecipesModule();
        recipeHelpers = recipes.buildRecipeHelpers({
            projectPath: currentProjectPath(),
            context: 'scene',
            defaultTimeoutMs: timeoutMs,
            // 惰性拿执行器：recipe 助手要能"跑一段代码"，而那段代码又需要同样的全局量
            // （包括 recipe 助手自己）—— 互相引用，必须晚绑定。
            getRunner: () => async (recipeCode, recipeArgs, nestedTimeoutMs) => {
                const nested = await executeSceneCode({
                    code: recipeCode,
                    args: recipeArgs,
                    // 嵌套执行与本次执行**共享外层 vm 的同步超时预算**（外层 watchdog
                    // 已经在计时了），所以不允许子 recipe 把超时设得比外层还长 ——
                    // 否则报出来的是外层的超时，排查时一脸问号。
                    timeoutMs: Math.min(nestedTimeoutMs, timeoutMs),
                    maxLogs,
                    maxLogLength,
                }, depth + 1);
                // recipe 里调 snapshot() 也要能登记到本次执行的撤销快照上
                if (nested.snapshotRequested)
                    state.snapshotRequested = true;
                const nestedLogs = Array.isArray(nested.logs) ? nested.logs : [];
                return {
                    ok: Boolean(nested.ok),
                    result: nested.result,
                    error: nested.error,
                    logs: nestedLogs.length > 0
                        ? nestedLogs.map((entry) => `[${entry.level}] ${entry.text}`)
                        : undefined,
                    durationMs: typeof nested.durationMs === 'number' ? nested.durationMs : undefined,
                    timedOut: Boolean(nested.timedOut),
                };
            },
        }).helpers;
    }
    catch (err) {
        const message = errorInfo(err).message;
        const fail = () => ({ ok: false, error: message });
        recipeHelpers = {
            findRecipes: fail,
            readRecipe: fail,
            saveRecipe: fail,
            runRecipe: fail,
            deleteRecipe: fail,
        };
    }
    const globals = {
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
/** 生成某个类的「TS 风格定义」，带实时值 */
function describeClass(cc, Cls, instance, className, limit) {
    const lines = [];
    const props = componentPropNames(instance || { constructor: Cls });
    let parentName = '';
    try {
        const parent = Object.getPrototypeOf(Cls.prototype);
        if (parent && parent.constructor && parent.constructor.name) {
            parentName = parent.constructor.name;
        }
    }
    catch {
        parentName = '';
    }
    lines.push(`// ${className}${parentName ? `  extends ${parentName}` : ''}`);
    if (instance) {
        lines.push(`// 来自实时实例（节点 ${instance.node ? instance.node.name : '?'}）`);
    }
    else {
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
                    if (v === null || v === undefined)
                        return String(v);
                    if (typeof v === 'object') {
                        try {
                            return JSON.stringify(v);
                        }
                        catch {
                            return '[object]';
                        }
                    }
                    return String(v);
                })();
                if (current.length > 60)
                    current = `${current.slice(0, 60)}…`;
            }
        }
        lines.push(`    ${key}: ${typeName};${current ? `  // 当前 = ${current}` : ''}`);
    }
    if (props.length > shown.length) {
        lines.push(`    // …另有 ${props.length - shown.length} 个属性`);
    }
    lines.push('}');
    // 原型方法：告诉 AI「这个组件能调什么」
    const methods = [];
    try {
        for (const name of Object.getOwnPropertyNames(Cls.prototype)) {
            if (name === 'constructor' || props.includes(name))
                continue;
            let isFn = false;
            try {
                isFn = typeof Cls.prototype[name] === 'function';
            }
            catch {
                isFn = false;
            }
            if (isFn)
                methods.push(name);
        }
    }
    catch {
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
function listCcExports(cc, limit) {
    const names = [];
    try {
        for (const key of Object.keys(cc)) {
            if (/^[A-Z]/.test(key) || typeof cc[key] === 'function')
                names.push(key);
        }
    }
    catch {
        /* 忽略 */
    }
    return { total: names.length, names: names.slice(0, limit) };
}
/** 场景侧总览载荷（无 target 与 target==='cc' 共用） */
function buildSceneIndex(cc, limit, withHint) {
    const exports = listCcExports(cc, limit);
    const { helpers } = makeHelpers(cc);
    let recipeHelperNames = [];
    try {
        recipeHelperNames = getRecipesModule().RECIPE_HELPER_SIGNATURES.map((signature) => signature.slice(0, signature.indexOf('(')));
    }
    catch {
        recipeHelperNames = [];
    }
    const payload = {
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
function describeSceneApi(cc, payload) {
    const target = typeof payload.target === 'string' ? payload.target.trim() : '';
    const limit = typeof payload.limit === 'number' ? Math.max(1, Math.min(500, payload.limit)) : 80;
    // 1) 没有 target：给出「起手式」清单 + cc 模块的顶层入口
    if (!target) {
        return buildSceneIndex(cc, limit, true);
    }
    // 2) 显式问助手函数
    if (target === 'helpers' || target === 'helper') {
        const { helpers } = makeHelpers(cc);
        const docs = {
            nodeByUuid: 'nodeByUuid(uuid) → Node | null',
            nodeByPath: "nodeByPath('Canvas/Panel') → Node | null  // 认得名字里含 '/' 的节点",
            eachNode: 'eachNode(visit, root?, {includeEditor}?) → void  // 默认跳过编辑器 gizmo',
            contentChildren: 'contentChildren(node?) → Node[]  // 真实内容子节点（已滤掉编辑器装饰）',
            isEditorNode: 'isEditorNode(node) → boolean  // 是不是编辑器自己的 gizmo/网格/参考图',
            tree: 'tree({ root?, maxDepth?, withComponents?, includeEditor? }) → 层级骨架对象',
            dump: 'dump(nodeOrComponent) → 显式取字段后的纯数据对象',
            snapshot: 'snapshot() → void  // 标记本次执行要注册撤销快照',
            sleep: 'sleep(ms) → Promise  // 轮询等待',
            captureView: "captureView({ savePath?, maxWidth?, format?, quality?, waitMs? }) → Promise<{ok, path?, chunks?, width, height, bytes, blankRatio}>  // 截场景视图当前一帧（含网格/gizmo）存成 png/jpeg",
            loadFrame: "loadFrame('db://assets/.../x.png' | '<uuid>@f9941' | '<uuid>') → Promise<SpriteFrame>  // 取图片的 SpriteFrame；别再手搓 @f9941，也别用 cc.resources.load（编辑器场景里必失败）",
            worldRect: 'worldRect(node, { root? }) → {cx, cy, width, height, left, right, bottom, top}  // 编辑态可信的世界矩形（position+anchor+contentSize 自洽累加）；别用 getBoundingBoxToWorld',
            contentBounds: 'contentBounds() → {left, right, bottom, top, cx, cy, width, height, count, uuids}  // 场景**真实内容**的世界包围盒（已滤掉编辑器 gizmo/网格）；截图取景量的就是它',
            pick: "pick(x, y, { space?, root?, limit? }) → { verdict, hits[], hit, invisible[], editorHits[], world, pageCss }  // **一个屏幕点上是哪个节点**。space: 'view'（页面CSS像素，默认）/'uv'（0~1，截图缩过就用它）/'world'。verdict='editor-overlay' = 那里没有任何内容节点、是编辑器 gizmo —— 截图里那东西不在场景数据里，别去节点树找",
            labelFit: 'labelFit(node | {text,fontSize,width,height,lineHeight,overflow,wrap}, override?) → { fits, lineCount, maxLinesFit, clippedText, overflowX, shortfallPx, method, formula }  // **这个 Label 会不会裁字**。第二参覆盖任意字段 = 问反事实（labelFit(n, {height:72})），**零副作用**，别靠改真节点+截图试',
            snapshotTree: 'snapshotTree(root?, { label?, saveTo?, maxNodes? }) → {label, nodeCount, hash, kept}  // 拍一份纯数据快照（键=节点**路径**，存盘换 uuid 也不影响比对）；存在场景进程里，跨调用还在',
            diffTree: 'diffTree(beforeLabel, afterLabel, { limit?, saveTo? }) → {counts, changed:[{path, props:{k:{from,to}}}], added, removed, suspectLeaks}  // **我到底改了什么**；suspectLeaks = 新增节点里名字像临时探针的',
            helperNames: 'helperNames() → string[]',
        };
        let recipeHelpers = [];
        try {
            const module = getRecipesModule();
            recipeHelpers = module.RECIPE_HELPER_SIGNATURES.map((signature) => ({
                name: signature.slice(0, signature.indexOf('(')),
                signature,
            }));
        }
        catch {
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
    let node = cc;
    for (const part of pathParts) {
        if (node === null || node === undefined) {
            return { ok: false, error: `找不到 ${target}（在 ${part} 处断链）` };
        }
        node = node[part];
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
    let instance = null;
    let instanceNote = '';
    if (payload.nodeUuid) {
        const scene = currentScene(cc);
        const host = scene ? scene.getChildByUuid(payload.nodeUuid) : null;
        if (host) {
            instance = host.getComponent(node);
            if (!instance)
                instanceNote = `节点 ${host.name} 上没有 ${target} 组件`;
        }
        else {
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
            }
            catch {
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
exports.methods = {
    /** 探活：主进程用它判断场景脚本是否已加载 */
    ping() {
        return { ok: true, ts: Date.now() };
    },
    /** 在引擎上下文执行用户代码 */
    async runCode(payload) {
        return executeSceneCode(payload || {});
    },
    /** 渐进式披露：描述引擎 API */
    async describeApi(payload) {
        try {
            const cc = getCc();
            return describeSceneApi(cc, payload || {});
        }
        catch (err) {
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
    async viewMetrics(payload) {
        try {
            const cc = getCc();
            return collectViewMetrics(cc, payload || {});
        }
        catch (err) {
            return { ok: false, error: errorInfo(err) };
        }
    },
    /**
     * 取景 / 还原视角 —— **截图链路里「摆相机」的那一半**（见文件里「取景」一节）。
     *
     * 为什么由主进程驱动而不是这里一把梭：摆完一步要**量一次**（覆盖够不够）、不够再降级摆下一步 ——
     * 量的判据（`viewMetrics.framing`）与相机都在这一侧，而「摆哪一级、要不要继续」是主进程的决定。
     *
     * ⚠ 曾经这里还配着一句「主进程 `invalidate()` 逼一帧再量」。**那一句已整体撤掉**
     * （2026-10-08 口径：本扩展不碰合成器，见 `source/capture.ts` 文件头）。代价如实说：
     * 相机刚动完就量，读到的**可能是重画前的那一帧** —— 所以主进程那边靠**多量几轮**、
     * 而不是靠逼一帧来"保证新鲜"。
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
    async fitView(payload) {
        try {
            const cc = getCc();
            const camera = editorCamera();
            const action = payload && payload.action === 'end' ? 'end' : 'fit';
            if (action === 'end') {
                if (!pendingFit)
                    return { ok: false, error: '没有待还原的视角（可能已经被还原过了）' };
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
            if (!spec)
                return { ok: false, error: `fitView 不认得 fit 参数：${JSON.stringify(payload && payload.fit)}` };
            const helpers = makeHelpers(cc, {
                projectPath: typeof payload.projectPath === 'string' ? payload.projectPath : '',
            }).helpers;
            const ref = spec.kind === 'node' ? spec.ref || (typeof payload.node === 'string' ? payload.node.trim() : '') : '';
            let node = null;
            if (ref) {
                node = helpers.nodeByUuid(ref) || helpers.nodeByPath(ref) || null;
            }
            const target = fitTargetOf(helpers, spec, node);
            /** 视角只存**一次**（第一次取景之前）—— 后面几级降级都在同一个原始视角之上 */
            const now = Date.now();
            const stale = Boolean(pendingFit) && now - pendingFit.startedAt > FIT_STATE_TTL_MS;
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
        }
        catch (err) {
            return { ok: false, error: errorInfo(err) };
        }
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOENHOzs7QUFFSCwrQkFBNEI7QUFPNUIsU0FBUyxZQUFZLENBQUMsRUFBVTtJQUM1QixNQUFNLEdBQUcsR0FBRyxJQUFJLEtBQUssQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUEwQixDQUFDO0lBQ3BFLEdBQUcsQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLE9BQU8sR0FBRyxDQUFDO0FBQ2YsQ0FBQztBQUVEOzs7Ozs7Ozs7O0dBVUc7QUFDSCxTQUFTLFNBQVMsQ0FBQyxHQUFZO0lBQzNCLElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ2xELE1BQU0sTUFBTSxHQUFHLEdBQW9FLENBQUM7SUFDcEYsSUFBSSxNQUFNLENBQUMsWUFBWTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3JDLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyw4QkFBOEI7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNoRSxPQUFPLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRLElBQUksNkJBQTZCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNwRyxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsR0FBWTtJQUMzQixJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNqQyxNQUFNLE1BQU0sR0FBRyxHQUE2RCxDQUFDO1FBQzdFLE9BQU87WUFDSCxJQUFJLEVBQUUsT0FBTyxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTztZQUM3RCxPQUFPLEVBQUUsT0FBTyxNQUFNLENBQUMsT0FBTyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQztZQUMxRSxLQUFLLEVBQUUsT0FBTyxNQUFNLENBQUMsS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUztTQUNyRSxDQUFDO0lBQ04sQ0FBQztJQUNELE9BQU8sRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztBQUNuRCxDQUFDO0FBRUQsOEVBQThFO0FBQzlFLFVBQVU7QUFDViw4RUFBOEU7QUFFOUUsSUFBSSxPQUFPLEdBQVEsSUFBSSxDQUFDO0FBQ3hCLElBQUksT0FBTyxHQUFrQixJQUFJLENBQUM7QUFFbEM7Ozs7O0dBS0c7QUFDSCxTQUFTLEtBQUs7SUFDVixJQUFJLE9BQU87UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUM1QixJQUFJLE9BQU87UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3RDLElBQUksQ0FBQztRQUNELE1BQU0saUJBQWlCLEdBQUcsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUM7UUFDaEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLGlCQUFpQixDQUFDLEVBQUUsQ0FBQztZQUM1QyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3pDLENBQUM7UUFDRCw4REFBOEQ7UUFDOUQsT0FBTyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4QixPQUFPLE9BQU8sQ0FBQztJQUNuQixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sR0FBRyxlQUFlLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNsRCxNQUFNLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzdCLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsRUFBTztJQUN6QixJQUFJLENBQUM7UUFDRCxPQUFPLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7SUFDbEMsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7QUFDTCxDQUFDO0FBRUQsOEVBQThFO0FBQzlFLDJCQUEyQjtBQUMzQiw4RUFBOEU7QUFFOUUsZ0VBQWdFO0FBQ2hFLE1BQU0sY0FBYyxHQUFHLFVBQVUsQ0FBQztBQUVsQyxJQUFJLGFBQWEsR0FBUSxJQUFJLENBQUM7QUFDOUIsSUFBSSxrQkFBa0IsR0FBa0IsSUFBSSxDQUFDO0FBRTdDOzs7Ozs7Ozs7Ozs7R0FZRztBQUNILFNBQVMsZ0JBQWdCO0lBQ3JCLElBQUksYUFBYTtRQUFFLE9BQU8sYUFBYSxDQUFDO0lBQ3hDLElBQUksa0JBQWtCO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0lBQzVELElBQUksQ0FBQztRQUNELE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQ3BELElBQUksQ0FBQyxJQUFJO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQywyQkFBMkIsY0FBYyxRQUFRLENBQUMsQ0FBQztRQUM5RSw4REFBOEQ7UUFDOUQsYUFBYSxHQUFHLE9BQU8sQ0FBQyxJQUFBLFdBQUksRUFBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxZQUFZLENBQUMsQ0FBQyxDQUFDO1FBQ2xFLE9BQU8sYUFBYSxDQUFDO0lBQ3pCLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsa0JBQWtCLEdBQUcsa0JBQWtCLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNoRSxNQUFNLElBQUksS0FBSyxDQUFDLGtCQUFrQixDQUFDLENBQUM7SUFDeEMsQ0FBQztBQUNMLENBQUM7QUFFRCxvREFBb0Q7QUFDcEQsU0FBUyxrQkFBa0I7SUFDdkIsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUM7SUFDckMsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sRUFBRSxDQUFDO0lBQ2QsQ0FBQztBQUNMLENBQUM7QUFFRCxxREFBcUQ7QUFDckQsU0FBUyxlQUFlO0lBQ3BCLElBQUksQ0FBQztRQUNELE1BQU0sV0FBVyxHQUFHLGtCQUFrQixFQUFFLENBQUM7UUFDekMsSUFBSSxDQUFDLFdBQVc7WUFBRSxPQUFPLElBQUksQ0FBQztRQUM5QixPQUFPLGdCQUFnQixFQUFFLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ3ZELENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0FBQ0wsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSx5QkFBeUI7QUFDekIsOEVBQThFO0FBRTlFLGdDQUFnQztBQUNoQyxTQUFTLFFBQVEsQ0FBQyxJQUFTLEVBQUUsS0FBMEI7SUFDbkQsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPO0lBQ2xCLE1BQU0sS0FBSyxHQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDNUIsT0FBTyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUN6QixLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDWixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQztRQUNyQyxLQUFLLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUM7WUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzlFLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsSUFBUztJQUN4QixJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3ZCLE9BQU87UUFDSCxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7UUFDZixJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7UUFDZixNQUFNLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTTtLQUN0RixDQUFDO0FBQ04sQ0FBQztBQUVELDJCQUEyQjtBQUMzQixTQUFTLFdBQVcsQ0FBQyxLQUFjO0lBQy9CLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3hELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3ZCLE9BQU8sS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztJQUNyRSxDQUFDO0lBQ0QsUUFBUSxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ25CLEtBQUssUUFBUTtZQUNULE9BQU8sUUFBUSxDQUFDO1FBQ3BCLEtBQUssUUFBUTtZQUNULE9BQU8sUUFBUSxDQUFDO1FBQ3BCLEtBQUssU0FBUztZQUNWLE9BQU8sU0FBUyxDQUFDO1FBQ3JCLEtBQUssVUFBVTtZQUNYLE9BQU8sVUFBVSxDQUFDO1FBQ3RCLEtBQUssUUFBUTtZQUNULE1BQU07UUFDVjtZQUNJLE9BQU8sS0FBSyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBRyxLQUFnQyxDQUFDO0lBQzdDLElBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQztJQUNsQixJQUFJLENBQUM7UUFDRCxNQUFNLElBQUksR0FBSSxHQUEyQyxDQUFDLFdBQVcsQ0FBQztRQUN0RSxRQUFRLEdBQUcsSUFBSSxJQUFJLE9BQU8sSUFBSSxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUN0RSxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsUUFBUSxHQUFHLEVBQUUsQ0FBQztJQUNsQixDQUFDO0lBQ0QsSUFBSSxDQUFDLFFBQVEsSUFBSSxRQUFRLEtBQUssUUFBUTtRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQ3hELCtCQUErQjtJQUMvQixJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxNQUFNLFFBQVEsY0FBYyxDQUFDO0lBQ3RFLE9BQU8sTUFBTSxRQUFRLEVBQUUsQ0FBQztBQUM1QixDQUFDO0FBRUQsbUNBQW1DO0FBQ25DLFNBQVMsUUFBUSxDQUFDLE1BQVc7SUFDekIsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQy9CLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEVBQUUsQ0FBQztJQUNkLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxRQUFRLENBQUMsTUFBVyxFQUFFLEdBQVc7SUFDdEMsSUFBSSxDQUFDO1FBQ0QsT0FBTyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO0lBQzVDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ3pCLENBQUM7QUFDTCxDQUFDO0FBRUQsMENBQTBDO0FBQzFDLFNBQVMsa0JBQWtCLENBQUMsSUFBUztJQUNqQyxNQUFNLElBQUksR0FBRyxJQUFJLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQztJQUN0QyxNQUFNLFFBQVEsR0FBRyxJQUFJLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFFLElBQUksQ0FBQyxTQUFzQixDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDN0YsSUFBSSxRQUFRLElBQUksUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDO1FBQUUsT0FBTyxRQUFRLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDN0QsT0FBTyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssTUFBTSxJQUFJLENBQUMsS0FBSyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDNUYsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSwwQkFBMEI7QUFDMUIsOEVBQThFO0FBQzlFLEVBQUU7QUFDRiw2Q0FBNkM7QUFDN0MsZ0RBQWdEO0FBQ2hELGtCQUFrQjtBQUNsQixFQUFFO0FBQ0YsVUFBVTtBQUNWLDJEQUEyRDtBQUMzRCx3REFBd0Q7QUFDeEQscURBQXFEO0FBQ3JELG1EQUFtRDtBQUNuRCw0Q0FBNEM7QUFFNUMsd0NBQXdDO0FBQ3hDLElBQUksZ0JBQW9FLENBQUM7QUFFekUsU0FBUyxjQUFjO0lBQ25CLElBQUksZ0JBQWdCLEtBQUssU0FBUztRQUFFLE9BQU8sZ0JBQWdCLENBQUM7SUFDNUQsSUFBSSxDQUFDO1FBQ0QsOERBQThEO1FBQzlELGdCQUFnQixHQUFHLEVBQUUsRUFBRSxFQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztJQUN2RixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQzVCLENBQUM7SUFDRCxPQUFPLGdCQUFnQixDQUFDO0FBQzVCLENBQUM7QUFFRCxrREFBa0Q7QUFDbEQsU0FBUyxjQUFjLENBQUMsRUFBTztJQUMzQixNQUFNLFVBQVUsR0FBVSxFQUFFLENBQUM7SUFDN0IsSUFBSSxDQUFDO1FBQ0QsSUFBSSxFQUFFLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTTtZQUFFLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNuRSxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsZUFBZTtJQUNuQixDQUFDO0lBQ0QsSUFBSSxDQUFDO1FBQ0QsSUFBSSxPQUFPLFFBQVEsS0FBSyxXQUFXLElBQUksT0FBTyxRQUFRLENBQUMsZ0JBQWdCLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDckYsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN4RSxDQUFDO0lBQ0wsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLGdCQUFnQjtJQUNwQixDQUFDO0lBQ0QsTUFBTSxNQUFNLEdBQUcsVUFBVSxDQUFDLE1BQU0sQ0FDNUIsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxVQUFVLEtBQUssVUFBVSxJQUFJLENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUNoRixDQUFDO0lBQ0YsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNyQyxPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0UsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7R0FZRztBQUNILFNBQVMsYUFBYSxDQUFDLEVBQU8sRUFBRSxNQUFXO0lBQ3ZDLE1BQU0sS0FBSyxHQUFHLENBQUMsS0FBYyxFQUFpQixFQUFFLENBQzVDLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMvRixNQUFNLEdBQUcsR0FBNEIsRUFBRSxDQUFDO0lBQ3hDLElBQUksQ0FBQztRQUNELE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUM7UUFDckIsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNQLElBQUksT0FBTyxJQUFJLENBQUMsY0FBYyxLQUFLLFVBQVUsRUFBRSxDQUFDO2dCQUM1QyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7Z0JBQ25DLElBQUksSUFBSTtvQkFBRSxHQUFHLENBQUMsV0FBVyxHQUFHLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUN6RixDQUFDO1lBQ0QsSUFBSSxPQUFPLElBQUksQ0FBQyx1QkFBdUIsS0FBSyxVQUFVLEVBQUUsQ0FBQztnQkFDckQsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLHVCQUF1QixFQUFFLENBQUM7Z0JBQzVDLElBQUksSUFBSTtvQkFBRSxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1lBQzlGLENBQUM7WUFDRCxJQUFJLE9BQU8sSUFBSSxDQUFDLFNBQVMsS0FBSyxVQUFVLEVBQUUsQ0FBQztnQkFDdkMsR0FBRyxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUMsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQzNFLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLHlCQUF5QjtJQUM3QixDQUFDO0lBQ0QsSUFBSSxDQUFDO1FBQ0QsSUFBSSxNQUFNO1lBQUUsR0FBRyxDQUFDLE1BQU0sR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDNUUsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLFFBQVE7SUFDWixDQUFDO0lBQ0QsZ0VBQWdFO0lBQ2hFLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxXQUE0RCxDQUFDO0lBQ2pGLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxnQkFBaUUsQ0FBQztJQUNyRixJQUFJLE9BQU8sSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQzlFLEdBQUcsQ0FBQyxvQkFBb0IsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDO0lBQ2hHLENBQUM7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBUyxjQUFjLENBQ25CLEVBQU8sRUFDUCxNQUFXLEVBQ1gsTUFBYztJQUVkLE1BQU0sSUFBSSxHQUFHLEdBQTBELEVBQUU7UUFDckUsTUFBTSxFQUFFLEdBQ0osTUFBTSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUM7WUFDM0IsTUFBTSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUM7WUFDMUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO1FBQzVDLElBQUksQ0FBQyxFQUFFO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQywrQkFBK0IsQ0FBQyxDQUFDO1FBQzFELE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxrQkFBa0IsSUFBSSxNQUFNLENBQUMsS0FBSyxDQUFDO1FBQ3BELE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxtQkFBbUIsSUFBSSxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ3ZELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxNQUFNO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUN4RCxNQUFNLE1BQU0sR0FBRyxJQUFJLFVBQVUsQ0FBQyxLQUFLLEdBQUcsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQ2xELGlDQUFpQztRQUNqQyxFQUFFLENBQUMsZUFBZSxDQUFDLEVBQUUsQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDekMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3RFLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3JDLENBQUMsQ0FBQztJQUVGLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxPQUFPLEdBQUcsS0FBSyxDQUFDO1FBQ3BCLE1BQU0sTUFBTSxHQUFHLENBQUMsRUFBYyxFQUFRLEVBQUU7WUFDcEMsSUFBSSxPQUFPO2dCQUFFLE9BQU87WUFDcEIsT0FBTyxHQUFHLElBQUksQ0FBQztZQUNmLElBQUksQ0FBQztnQkFDRCxFQUFFLEVBQUUsQ0FBQztZQUNULENBQUM7WUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO2dCQUNYLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoQixDQUFDO1FBQ0wsQ0FBQyxDQUFDO1FBQ0YsSUFBSSxDQUFDO1lBQ0QsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDO1lBQzFELElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQyxRQUFRLElBQUksT0FBTyxFQUFFLENBQUMsUUFBUSxDQUFDLElBQUksS0FBSyxVQUFVLEVBQUUsQ0FBQztnQkFDakUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDakUsQ0FBQztRQUNMLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxnQkFBZ0I7UUFDcEIsQ0FBQztRQUNELFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUM1RCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCxpREFBaUQ7QUFDakQsU0FBUyxnQkFBZ0IsQ0FBQyxNQUFrQjtJQUN4QyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDNUMsSUFBSSxLQUFLLElBQUksQ0FBQztRQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3pCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDbEQsSUFBSSxPQUFPLEdBQUcsQ0FBQyxDQUFDO0lBQ2hCLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ25DLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDaEIsT0FBTyxJQUFJLENBQUMsQ0FBQztRQUNiLElBQUksTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQUUsS0FBSyxJQUFJLENBQUMsQ0FBQztJQUMzRyxDQUFDO0lBQ0QsT0FBTyxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxHQUFHLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3pFLENBQUM7QUFFRCwrQ0FBK0M7QUFDL0MsU0FBUyxvQkFBb0IsQ0FDekIsTUFBa0IsRUFDbEIsS0FBYSxFQUNiLE1BQWMsRUFDZCxJQUF5RDtJQUV6RCxJQUFJLE9BQU8sUUFBUSxLQUFLLFdBQVcsSUFBSSxPQUFPLFFBQVEsQ0FBQyxhQUFhLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDbEYsTUFBTSxJQUFJLEtBQUssQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQzdDLEdBQUcsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ2xCLEdBQUcsQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3BCLE1BQU0sR0FBRyxHQUFHLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDakMsSUFBSSxDQUFDLEdBQUc7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0lBRTFDLE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxlQUFlLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2pELE1BQU0sUUFBUSxHQUFHLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDM0IsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDakMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQztRQUN6QyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxJQUFJLEdBQUcsUUFBUSxDQUFDLEVBQUUsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDO0lBQ3pFLENBQUM7SUFDRCxHQUFHLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFFOUIsSUFBSSxHQUFHLEdBQVEsR0FBRyxDQUFDO0lBQ25CLElBQUksSUFBSSxDQUFDLFFBQVEsR0FBRyxDQUFDLElBQUksS0FBSyxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUM3QyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ2hELE1BQU0sQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQztRQUM3QixNQUFNLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDMUUsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQyxJQUFJLElBQUksRUFBRSxDQUFDO1lBQ1AsSUFBSSxDQUFDLHFCQUFxQixHQUFHLElBQUksQ0FBQztZQUNsQyxJQUFJLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLHFCQUFxQixHQUFHLE1BQU0sQ0FBQztZQUN4QyxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLGdCQUFnQjtZQUNwQixDQUFDO1lBQ0QsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUN2RCxHQUFHLEdBQUcsTUFBTSxDQUFDO1FBQ2pCLENBQUM7SUFDTCxDQUFDO0lBQ0QsT0FBTyxFQUFFLE9BQU8sRUFBRSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUM7QUFDckcsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLEVBQUU7QUFDRiw4REFBOEQ7QUFDOUQsb0VBQW9FO0FBQ3BFLHVFQUF1RTtBQUN2RSxnQ0FBZ0M7QUFDaEMsRUFBRTtBQUNGLGVBQWU7QUFDZixxQ0FBcUM7QUFDckMsbUJBQW1CO0FBQ25CLGlDQUFpQztBQUNqQyxFQUFFO0FBQ0YsOEJBQThCO0FBQzlCLEVBQUU7QUFDRixzREFBc0Q7QUFDdEQsZ0RBQWdEO0FBQ2hELGtEQUFrRDtBQUVsRCw0QkFBNEI7QUFDNUIsU0FBUyxNQUFNLENBQUMsS0FBYTtJQUN6QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQztBQUMzQyxDQUFDO0FBRUQsMEJBQTBCO0FBQzFCLFNBQVMsVUFBVSxDQUFDLElBQW1CO0lBQ25DLElBQUksQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFHLElBQUksRUFBRSxDQUFDO1FBQ3JCLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ3RGLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0FBQ0wsQ0FBQztBQUVELHNEQUFzRDtBQUN0RCxTQUFTLFdBQVcsQ0FBQyxLQUFjLEVBQUUsR0FBVyxFQUFFLEdBQVcsRUFBRSxRQUFnQjtJQUMzRSxNQUFNLEdBQUcsR0FBRyxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7SUFDbkYsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzdDLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQVMsWUFBWTtJQUNqQixNQUFNLEdBQUcsR0FBNEIsRUFBRSxDQUFDO0lBQ3hDLElBQUksQ0FBQztRQUNELElBQUksT0FBTyxNQUFNLEtBQUssV0FBVyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNuRCxHQUFHLENBQUMsSUFBSSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO1lBQ2hDLEdBQUcsQ0FBQyxRQUFRLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQztZQUNqQyxHQUFHLENBQUMsU0FBUyxHQUFHLE1BQU0sQ0FBQyxXQUFXLENBQUM7WUFDbkMsR0FBRyxDQUFDLEdBQUcsR0FBRyxNQUFNLENBQUMsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO1FBQzNDLENBQUM7SUFDTCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsaUNBQWlDO0lBQ3JDLENBQUM7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFFRCx5Q0FBeUM7QUFDekMsU0FBUyxjQUFjLENBQUMsTUFBVztJQUMvQixJQUFJLENBQUMsTUFBTTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3pCLE1BQU0sR0FBRyxHQUE0QixFQUFFLENBQUM7SUFDeEMsSUFBSSxDQUFDO1FBQ0QsSUFBSSxPQUFPLE1BQU0sQ0FBQyxxQkFBcUIsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNyRCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMscUJBQXFCLEVBQUUsQ0FBQztZQUM1QyxHQUFHLENBQUMsSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDN0IsR0FBRyxDQUFDLEdBQUcsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQzNCLEdBQUcsQ0FBQyxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNsQyxHQUFHLENBQUMsU0FBUyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEMsQ0FBQztJQUNMLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxzQkFBc0I7SUFDMUIsQ0FBQztJQUNELElBQUksQ0FBQztRQUNELEdBQUcsQ0FBQyxXQUFXLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztRQUMvQixHQUFHLENBQUMsWUFBWSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDckMsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLFFBQVE7SUFDWixDQUFDO0lBQ0QsT0FBTyxHQUFHLENBQUM7QUFDZixDQUFDO0FBRUQ7Ozs7Ozs7OztHQVNHO0FBQ0gsU0FBUyxZQUFZO0lBQ2pCLElBQUksQ0FBQztRQUNELE1BQU0sT0FBTyxHQUFJLFVBQWtCLENBQUMsR0FBRyxJQUFLLFVBQWtCLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQztRQUMxRSxJQUFJLENBQUMsT0FBTztZQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsMkJBQTJCLEVBQUUsQ0FBQztRQUNqRyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO1FBQzNCLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDdEIsT0FBTyxFQUFFLE9BQU8sRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLHdDQUF3QyxFQUFFLENBQUM7UUFDOUYsQ0FBQztRQUNELElBQUksSUFBSSxHQUFtQixJQUFJLENBQUM7UUFDaEMsSUFBSSxDQUFDO1lBQ0QsSUFBSSxPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssU0FBUztnQkFBRSxJQUFJLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQztRQUMvRCxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsUUFBUTtRQUNaLENBQUM7UUFDRCxPQUFPLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUNsQyxDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsbUJBQW1CLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO0lBQ3ZHLENBQUM7QUFDTCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E0Qkc7QUFDSCxTQUFTLGFBQWEsQ0FBQyxFQUFRO0lBQzNCLE1BQU0sR0FBRyxHQUE0QixFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQztJQUNwRyxNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUMsT0FBa0MsQ0FBQztJQUN2RCxNQUFNLE1BQU0sR0FBSSxVQUFrQixDQUFDLEdBQUcsQ0FBQztJQUV2QyxrQ0FBa0M7SUFDbEMsSUFBSSxZQUFZLEdBQWtCLElBQUksQ0FBQztJQUN2QyxJQUFJLENBQUM7UUFDRCxNQUFNLElBQUksR0FBRyxNQUFNLElBQUksTUFBTSxDQUFDLFdBQVcsQ0FBQztRQUMxQyxPQUFPLENBQUMsa0JBQWtCLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzNDLElBQUksSUFBSSxFQUFFLENBQUM7WUFDUCxJQUFJLENBQUM7Z0JBQ0QsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQztnQkFDN0IsWUFBWSxHQUFHLE9BQU8sUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7Z0JBQzlELE9BQU8sQ0FBQyxZQUFZLEdBQUcsWUFBWSxDQUFDO1lBQ3hDLENBQUM7WUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO2dCQUNYLE9BQU8sQ0FBQyxpQkFBaUIsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDO1lBQ3ZELENBQUM7WUFDRCxJQUFJLENBQUM7Z0JBQ0QsT0FBTyxDQUFDLGNBQWMsR0FBRyxPQUFPLElBQUksQ0FBQyxPQUFPLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztZQUN4RixDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDWCxPQUFPLENBQUMsbUJBQW1CLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQztZQUN6RCxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsT0FBTyxDQUFDLGdCQUFnQixHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUM7SUFDdEQsQ0FBQztJQUVELHVEQUF1RDtJQUN2RCxJQUFJLENBQUM7UUFDRCxNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksTUFBTSxDQUFDLGtCQUFrQixDQUFDO1FBQ3BELElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNYLEdBQUcsQ0FBQyxJQUFJLEdBQUcsdUNBQXVDLENBQUM7UUFDdkQsQ0FBQzthQUFNLENBQUM7WUFDSixJQUFJLENBQUM7Z0JBQ0QsTUFBTSxNQUFNLEdBQUcsT0FBTyxPQUFPLENBQUMsZ0JBQWdCLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO2dCQUNsRyxPQUFPLENBQUMsVUFBVSxHQUFHLE1BQU0sSUFBSSxPQUFPLE1BQU0sQ0FBQyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7WUFDaEcsQ0FBQztZQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7Z0JBQ1gsT0FBTyxDQUFDLGVBQWUsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDO1lBQ3JELENBQUM7WUFDRCxJQUFJLENBQUM7Z0JBQ0QsT0FBTyxDQUFDLFNBQVMsR0FBRyxPQUFPLE9BQU8sQ0FBQyxTQUFTLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztZQUM3RixDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDWCxPQUFPLENBQUMsY0FBYyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUM7WUFDcEQsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLEdBQUcsQ0FBQyxJQUFJLEdBQUcsK0JBQStCLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQztJQUN2RSxDQUFDO0lBRUQscUNBQXFDO0lBQ3JDLElBQUksQ0FBQztRQUNELE1BQU0sSUFBSSxHQUFJLFVBQWtCLENBQUMsZ0JBQWdCLENBQUM7UUFDbEQsT0FBTyxDQUFDLGdCQUFnQixHQUFHLE9BQU8sSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDdkUsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUM7SUFDcEMsQ0FBQztJQUVELHFCQUFxQjtJQUNyQixJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ0wsSUFBSSxDQUFDO1lBQ0QsT0FBTyxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUMsUUFBUSxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQ3ZELENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxlQUFlO1FBQ25CLENBQUM7UUFDRCxJQUFJLENBQUM7WUFDRCxPQUFPLENBQUMsY0FBYyxHQUFHLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDcEQsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLFFBQVE7UUFDWixDQUFDO1FBQ0QsSUFBSSxDQUFDO1lBQ0QsT0FBTyxDQUFDLFVBQVUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQzVDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztJQUNMLENBQUM7SUFFRCxNQUFNLEtBQUssR0FBRyxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzVELE1BQU0sR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFtQixFQUFFLENBQUMsT0FBTyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUM7SUFDbEgsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUUzRCxJQUFJLFlBQVksS0FBSyxNQUFNLElBQUksWUFBWSxLQUFLLE9BQU8sRUFBRSxDQUFDO1FBQ3RELEdBQUcsQ0FBQyxJQUFJLEdBQUcsU0FBUyxDQUFDO1FBQ3JCLEdBQUcsQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDO1FBQ25CLEdBQUcsQ0FBQyxNQUFNLEdBQUcsWUFBWSxLQUFLLE9BQU8sQ0FBQztJQUMxQyxDQUFDO1NBQU0sSUFBSSxZQUFZLEtBQUssTUFBTSxFQUFFLENBQUM7UUFDakMsR0FBRyxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUM7UUFDcEIsR0FBRyxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLEdBQUcsQ0FBQyxJQUFJLEdBQUcsR0FBRyxDQUFDO1FBQ25CLENBQUM7YUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDeEIsR0FBRyxDQUFDLElBQUksR0FBRyxXQUFXLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDO1FBQ2hFLENBQUM7SUFDTCxDQUFDO1NBQU0sQ0FBQztRQUNKOzs7V0FHRztRQUNILEdBQUcsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2xCLElBQUksR0FBRyxFQUFFLENBQUM7WUFDTixHQUFHLENBQUMsSUFBSSxHQUFHLEdBQUcsQ0FBQztZQUNmLEdBQUcsQ0FBQyxPQUFPLEdBQUcsR0FBRyxLQUFLLFNBQVMsQ0FBQztRQUNwQyxDQUFDO2FBQU0sSUFBSSxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3hCLEdBQUcsQ0FBQyxJQUFJLEdBQUcsV0FBVyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQztRQUNoRSxDQUFDO1FBQ0QsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLGtCQUFrQjtZQUNsQyxDQUFDLENBQUMsd0NBQXdDO1lBQzFDLENBQUMsQ0FBQyx5QkFBeUIsQ0FBQztRQUNoQyxHQUFHLENBQUMsSUFBSSxHQUFHLEdBQUcsR0FBRywrRUFBK0UsQ0FBQztJQUNyRyxDQUFDO0lBQ0QsT0FBTyxHQUFHLENBQUM7QUFDZixDQUFDO0FBRUQ7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxTQUFTLGVBQWUsQ0FDcEIsRUFBTyxFQUNQLEdBQVEsRUFDUixJQUFTLEVBQ1QsTUFBVztJQUVYLE1BQU0sRUFBRSxHQUFHLE9BQU8sSUFBSSxDQUFDLFlBQVksS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDOUYsSUFBSSxDQUFDLEVBQUU7UUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSx3Q0FBd0MsRUFBRSxDQUFDO0lBRWpHLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNmLElBQUksT0FBTyxHQUFHLEdBQUcsQ0FBQztJQUNsQixJQUFJLE9BQU8sR0FBRyxHQUFHLENBQUM7SUFDbEIsSUFBSSxDQUFDO1FBQ0QsS0FBSyxHQUFHLEVBQUUsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDO1FBQ3RCLE1BQU0sR0FBRyxFQUFFLENBQUMsTUFBTSxJQUFJLENBQUMsQ0FBQztRQUN4QixPQUFPLEdBQUcsT0FBTyxFQUFFLENBQUMsT0FBTyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO1FBQzVELE9BQU8sR0FBRyxPQUFPLEVBQUUsQ0FBQyxPQUFPLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7SUFDaEUsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLGFBQWE7SUFDakIsQ0FBQztJQUVELElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNmLElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNmLElBQUksQ0FBQztRQUNELE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUM7UUFDM0IsSUFBSSxFQUFFLEVBQUUsQ0FBQztZQUNMLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDN0IsTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNqQyxDQUFDO0lBQ0wsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLFFBQVE7SUFDWixDQUFDO0lBQ0QsTUFBTSxVQUFVLEdBQUcsS0FBSyxHQUFHLE1BQU0sQ0FBQztJQUNsQyxNQUFNLFdBQVcsR0FBRyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3BDLElBQUksVUFBVSxJQUFJLENBQUMsSUFBSSxXQUFXLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDdEMsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsdUJBQXVCLEtBQUssSUFBSSxNQUFNLFNBQVMsRUFBRSxDQUFDO0lBQ25HLENBQUM7SUFFRCxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDWCxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDWCxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDWCxJQUFJLENBQUM7UUFDRCxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDO1FBQzlCLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ1YsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDVixFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQztJQUNkLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxzQkFBc0IsRUFBRSxDQUFDO0lBQzFFLENBQUM7SUFDRCw0Q0FBNEM7SUFDNUMsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLENBQUMsR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLFVBQVUsQ0FBQztJQUM3QyxNQUFNLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHLEdBQUcsT0FBTyxDQUFDLEdBQUcsV0FBVyxDQUFDO0lBRTlDLE9BQU8sZUFBZSxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLENBQUMsQ0FBQztBQUNwRyxDQUFDO0FBYUQ7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFTLGVBQWUsQ0FDcEIsRUFBTyxFQUNQLEdBQVEsRUFDUixNQUFXLEVBQ1gsR0FBYTtJQUViLHFEQUFxRDtJQUNyRCxNQUFNLFNBQVMsR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO0lBQy9DLE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFLLFNBQVMsQ0FBQyxZQUF1QixJQUFJLENBQUMsQ0FBQztJQUNqRyxNQUFNLGNBQWMsR0FBSSxTQUFTLENBQUMsUUFBbUIsSUFBSSxDQUFDLENBQUM7SUFDM0QsTUFBTSxpQkFBaUIsR0FBSSxTQUFTLENBQUMsV0FBc0IsSUFBSSxDQUFDLENBQUM7SUFDakUsTUFBTSxHQUFHLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixHQUFHLGNBQWMsQ0FBQyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUM7SUFDekcsSUFBSSxDQUFDLFNBQVMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ3JCLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLCtCQUErQixFQUFFLENBQUM7SUFDbkYsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUM7SUFDckIsTUFBTSxFQUFFLEdBQWEsRUFBRSxDQUFDO0lBQ3hCLE1BQU0sRUFBRSxHQUFhLEVBQUUsQ0FBQztJQUN4QixJQUFJLENBQUM7UUFDRCxLQUFLLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUMzQixLQUFLLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDM0IsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxHQUFHLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxHQUFHLEdBQUcsQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7Z0JBQ3JHLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQztnQkFDdkIsd0JBQXdCO2dCQUN4QixFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQztZQUN6QyxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsb0JBQW9CLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO0lBQ2hHLENBQUM7SUFFRCxNQUFNLEdBQUcsR0FBRztRQUNSLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUN4QyxNQUFNLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7S0FDNUMsQ0FBQztJQUNGLE1BQU0sSUFBSSxHQUFJLFNBQVMsQ0FBQyxJQUFlLElBQUksQ0FBQyxDQUFDO0lBQzdDLE1BQU0sR0FBRyxHQUFJLFNBQVMsQ0FBQyxHQUFjLElBQUksQ0FBQyxDQUFDO0lBQzNDLE1BQU0sVUFBVSxHQUFHO1FBQ2YsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQ2hCLENBQUMsRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNoQixLQUFLLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7UUFDeEIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDO0tBQzdCLENBQUM7SUFDRixNQUFNLElBQUksR0FBRztRQUNULENBQUMsRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUM7UUFDdkIsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEdBQUcsQ0FBQztRQUN0QixLQUFLLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7UUFDeEIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDO0tBQzdCLENBQUM7SUFFRixnREFBZ0Q7SUFDaEQsTUFBTSxPQUFPLEdBQ1QsY0FBYyxHQUFHLENBQUM7UUFDbEIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQztZQUNwQixJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQztZQUN4QixJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksR0FBRyxjQUFjO1lBQzlCLElBQUksQ0FBQyxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUUsU0FBUyxDQUFDLFNBQW9CLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvRCxPQUFPO1FBQ0gsSUFBSTtRQUNKLFVBQVU7UUFDVixJQUFJLEVBQUUsT0FBTztZQUNULENBQUMsQ0FBQywwREFBMEQ7WUFDNUQsQ0FBQyxDQUFDLFNBQVM7S0FDbEIsQ0FBQztBQUNOLENBQUM7QUFFRCw4QkFBOEI7QUFDOUIsU0FBUyxPQUFPO0lBQ1osSUFBSSxDQUFDO1FBQ0QsSUFBSSxPQUFPLE1BQU0sS0FBSyxXQUFXO1lBQUUsT0FBTyxNQUFNLENBQUMsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO0lBQzNFLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxRQUFRO0lBQ1osQ0FBQztJQUNELE9BQU8sQ0FBQyxDQUFDO0FBQ2IsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSxxREFBcUQ7QUFDckQsOEVBQThFO0FBQzlFLEVBQUU7QUFDRiw4REFBOEQ7QUFDOUQsb0NBQW9DO0FBQ3BDLEVBQUU7QUFDRiw0REFBNEQ7QUFDNUQsRUFBRTtBQUNGLHFEQUFxRDtBQUNyRCxFQUFFO0FBQ0YsdURBQXVEO0FBQ3ZELDZEQUE2RDtBQUM3RCw4Q0FBOEM7QUFDOUMsOEJBQThCO0FBQzlCLG1FQUFtRTtBQUNuRSxxRUFBcUU7QUFDckUsZ0VBQWdFO0FBQ2hFLG1DQUFtQztBQUNuQyx5REFBeUQ7QUFDekQsc0VBQXNFO0FBQ3RFLEVBQUU7QUFDRix3Q0FBd0M7QUFDeEMsa0VBQWtFO0FBQ2xFLGlEQUFpRDtBQUNqRCx1REFBdUQ7QUFDdkQsNERBQTREO0FBQzVELFVBQVU7QUFFViw2Q0FBNkM7QUFDN0MsTUFBTSxzQkFBc0IsR0FBRyxJQUFJLENBQUM7QUFFcEMsa0VBQWtFO0FBQ2xFLE1BQU0sUUFBUSxHQUEyQixFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDO0FBRTVHLHlCQUF5QjtBQUN6QixTQUFTLFNBQVMsQ0FBQyxFQUFVO0lBQ3pCLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3BDLElBQUksRUFBRSxLQUFLLEdBQUcsSUFBSSxFQUFFLEtBQUssSUFBSTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQzlDLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQ2pELElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQ2pELElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQ2pELElBQUksSUFBSSxHQUFHLE1BQU07UUFBRSxPQUFPLE9BQU8sQ0FBQyxDQUFDLGlCQUFpQjtJQUNwRCxPQUFPLEtBQUssQ0FBQyxDQUFDLGlDQUFpQztBQUNuRCxDQUFDO0FBRUQsNkNBQTZDO0FBQzdDLElBQUksZUFBZSxHQUFRLElBQUksQ0FBQztBQUVoQzs7Ozs7O0dBTUc7QUFDSCxTQUFTLGNBQWM7SUFDbkIsSUFBSSxlQUFlO1FBQUUsT0FBTyxlQUFlLENBQUM7SUFDNUMsSUFBSSxDQUFDO1FBQ0QsTUFBTSxHQUFHLEdBQUksVUFBa0IsQ0FBQyxRQUFRLENBQUM7UUFDekMsSUFBSSxHQUFHLElBQUksT0FBTyxHQUFHLENBQUMsYUFBYSxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQ2pELE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDM0MsZUFBZSxHQUFHLE1BQU0sSUFBSSxPQUFPLE1BQU0sQ0FBQyxVQUFVLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDekcsQ0FBQztJQUNMLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxlQUFlLEdBQUcsSUFBSSxDQUFDO0lBQzNCLENBQUM7SUFDRCxPQUFPLGVBQWUsQ0FBQztBQUMzQixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxTQUFTLGdCQUFnQixDQUNyQixJQUFZLEVBQ1osUUFBZ0IsRUFDaEIsVUFBa0I7SUFFbEIsTUFBTSxDQUFDLEdBQUcsTUFBTSxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDM0MsSUFBSSxDQUFDLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxHQUFHLENBQUMsQ0FBQztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsQ0FBQztJQUMvRSxNQUFNLEdBQUcsR0FBRyxjQUFjLEVBQUUsQ0FBQztJQUM3QixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ04sSUFBSSxDQUFDO1lBQ0QsR0FBRyxDQUFDLElBQUksR0FBRyxHQUFHLFFBQVEsTUFBTSxVQUFVLElBQUksT0FBTyxFQUFFLENBQUM7WUFDcEQsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDdkMsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUM7Z0JBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLENBQUM7UUFDaEcsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLFdBQVc7UUFDZixDQUFDO0lBQ0wsQ0FBQztJQUNELElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLEtBQUssTUFBTSxFQUFFLElBQUksQ0FBQztRQUFFLEtBQUssSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxRQUFRLENBQUM7SUFDM0UsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2hELENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxFQUFtQyxDQUFDO0FBRWpFLG9EQUFvRDtBQUNwRCxNQUFNLGFBQWEsR0FBRyxFQUFFLENBQUM7QUFFekIsOEVBQThFO0FBQzlFLHNDQUFzQztBQUN0Qyw4RUFBOEU7QUFDOUUsRUFBRTtBQUNGLGVBQWU7QUFDZixFQUFFO0FBQ0YscURBQXFEO0FBQ3JELG9DQUFvQztBQUNwQyxpREFBaUQ7QUFDakQsRUFBRTtBQUNGLCtDQUErQztBQUMvQyxFQUFFO0FBQ0Ysd0NBQXdDO0FBQ3hDLEVBQUU7QUFDRiwyQkFBMkI7QUFDM0IsZ0JBQWdCO0FBQ2hCLGdIQUFnSDtBQUNoSCwrR0FBK0c7QUFDL0csd0hBQXdIO0FBQ3hILEVBQUU7QUFDRiwwREFBMEQ7QUFDMUQsb0RBQW9EO0FBQ3BELEVBQUU7QUFDRixnQkFBZ0I7QUFDaEIsRUFBRTtBQUNGLG1EQUFtRDtBQUNuRCx3REFBd0Q7QUFDeEQsZ0RBQWdEO0FBQ2hELEVBQUU7QUFDRixTQUFTO0FBQ1QsRUFBRTtBQUNGLHNEQUFzRDtBQUN0RCxzREFBc0Q7QUFDdEQsa0JBQWtCO0FBRWxCLDRDQUE0QztBQUM1QyxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUM7QUFFeEIsMkNBQTJDO0FBQzNDLE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxDQUFDO0FBRWhDLHdDQUF3QztBQUN4QyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFTeEIsMkNBQTJDO0FBQzNDLFNBQVMsZ0JBQWdCLENBQUMsR0FBWTtJQUNsQyxNQUFNLEtBQUssR0FBRyxHQUErQyxDQUFDO0lBQzlELElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3JELE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUN0RixJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3ZCLE9BQU8sRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLE9BQU8sS0FBSyxDQUFDLEdBQUcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDO0FBQ2hGLENBQUM7QUFFRCxnREFBZ0Q7QUFDaEQsU0FBUyxVQUFVLENBQUMsTUFBVztJQUMzQixNQUFNLEdBQUcsR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDbkMsSUFBSSxDQUFDLEdBQUc7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN0QixNQUFNLEtBQUssR0FBSSxHQUFHLENBQUMsUUFBbUIsSUFBSSxDQUFDLENBQUM7SUFDNUMsTUFBTSxNQUFNLEdBQUksR0FBRyxDQUFDLFNBQW9CLElBQUksQ0FBQyxDQUFDO0lBQzlDLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxNQUFNLElBQUksQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNDLE9BQU8sRUFBRSxDQUFDLEVBQUcsR0FBRyxDQUFDLElBQWUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLEdBQUcsQ0FBQyxHQUFjLElBQUksQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsQ0FBQztBQUN4RixDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILFNBQVMsVUFBVSxDQUNmLFFBQWdDLEVBQ2hDLFFBQWlFO0lBRWpFLE1BQU0sS0FBSyxHQUFHO1FBQ1YsSUFBSSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFDckMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxRSxHQUFHLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUNwQyxNQUFNLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0tBQ2hGLENBQUM7SUFDRixNQUFNLE9BQU8sR0FDVCxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMscUJBQXFCO1FBQ3BDLEtBQUssQ0FBQyxLQUFLLElBQUksQ0FBQyxxQkFBcUI7UUFDckMsS0FBSyxDQUFDLEdBQUcsSUFBSSxDQUFDLHFCQUFxQjtRQUNuQyxLQUFLLENBQUMsTUFBTSxJQUFJLENBQUMscUJBQXFCLENBQUM7SUFDM0MsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FDZixDQUFDLEVBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FDeEcsQ0FBQztJQUNGLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQ2YsQ0FBQyxFQUNELElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQzFHLENBQUM7SUFDRixNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsS0FBSyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUM7SUFDbEQsT0FBTztRQUNILE9BQU87UUFDUCxTQUFTLEVBQUUsUUFBUSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM5RSxLQUFLO0tBQ1IsQ0FBQztBQUNOLENBQUM7QUFjRDs7Ozs7R0FLRztBQUNILFNBQVMsV0FBVyxDQUFDLE9BQTRCLEVBQUUsSUFBYSxFQUFFLElBQVM7SUFDdkUsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFNBQVMsSUFBSSxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUM7UUFDeEYsQ0FBQztRQUNELElBQUksSUFBSSxHQUErQixJQUFJLENBQUM7UUFDNUMsSUFBSSxDQUFDO1lBQ0QsSUFBSSxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUF3QixDQUFDO1FBQzFELENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsT0FBTyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLElBQUksRUFBRSxXQUFXLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQ2pILENBQUM7UUFDRCxNQUFNLEtBQUssR0FBRyxPQUFPLElBQUksQ0FBQyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDOUQsTUFBTSxNQUFNLEdBQUcsT0FBTyxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pFLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDNUIsT0FBTztnQkFDSCxJQUFJO2dCQUNKLEtBQUssRUFBRSxJQUFJO2dCQUNYLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtnQkFDbkMsTUFBTSxFQUFFLGdCQUFnQjtnQkFDeEIsSUFBSSxFQUFFLFVBQVUsS0FBSyxJQUFJLE1BQU0sUUFBUTthQUMxQyxDQUFDO1FBQ04sQ0FBQztRQUNELE9BQU87WUFDSCxJQUFJO1lBQ0osS0FBSyxFQUFFLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRTtZQUNsRCxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7WUFDbkMsTUFBTSxFQUFFLGdCQUFnQjtTQUMzQixDQUFDO0lBQ04sQ0FBQztJQUVELElBQUksTUFBTSxHQUErQixJQUFJLENBQUM7SUFDOUMsSUFBSSxDQUFDO1FBQ0QsTUFBTSxHQUFHLE9BQU8sQ0FBQyxhQUFhLEVBQXlCLENBQUM7SUFDNUQsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDWCxPQUFPLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxZQUFZLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO0lBQ2pILENBQUM7SUFDRCxNQUFNLEtBQUssR0FBRyxPQUFPLE1BQU0sQ0FBQyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbEUsTUFBTSxNQUFNLEdBQUcsT0FBTyxNQUFNLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3JFLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQVUsRUFBRSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUM1RyxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksTUFBTSxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQzVCLE9BQU87WUFDSCxJQUFJO1lBQ0osS0FBSyxFQUFFLElBQUk7WUFDWCxLQUFLO1lBQ0wsTUFBTSxFQUFFLGVBQWU7WUFDdkIsSUFBSSxFQUFFLHdDQUF3QztTQUNqRCxDQUFDO0lBQ04sQ0FBQztJQUNELE9BQU87UUFDSCxJQUFJO1FBQ0osS0FBSyxFQUFFLEVBQUUsRUFBRSxFQUFFLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLE1BQU0sQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRTtRQUN0RCxLQUFLO1FBQ0wsTUFBTSxFQUFFLGVBQWU7UUFDdkIsSUFBSSxFQUFFLE9BQU8sTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVM7S0FDbEUsQ0FBQztBQUNOLENBQUM7QUFFRCxvQ0FBb0M7QUFDcEMsU0FBUyxlQUFlLENBQUMsR0FBUTtJQUM3QixNQUFNLEdBQUcsR0FBd0IsRUFBRSxDQUFDO0lBQ3BDLE1BQU0sSUFBSSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDL0MsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUNQLElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDN0IsSUFBSSxDQUFDO2dCQUFFLEdBQUcsQ0FBQyxRQUFRLEdBQUcsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQzdFLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztRQUNELElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDN0IsSUFBSSxDQUFDO2dCQUFFLEdBQUcsQ0FBQyxRQUFRLEdBQUcsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQzdGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztJQUNMLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ3RELElBQUksV0FBVyxLQUFLLElBQUk7UUFBRSxHQUFHLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztJQUN4RCxNQUFNLEdBQUcsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLElBQUksR0FBRyxLQUFLLElBQUk7UUFBRSxHQUFHLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQztJQUNoQyxNQUFNLFVBQVUsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3BELElBQUksVUFBVSxLQUFLLElBQUk7UUFBRSxHQUFHLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQztJQUNyRCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFFRCx5Q0FBeUM7QUFDekMsU0FBUyxVQUFVLENBQUMsQ0FBNkIsRUFBRSxDQUE2QjtJQUM1RSxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQzNCLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUM7SUFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFFBQVEsQ0FBQztJQUN0QixJQUFJLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQztRQUNYLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHO1lBQUUsT0FBTyxLQUFLLENBQUM7SUFDaEgsQ0FBQztTQUFNLElBQUksT0FBTyxDQUFDLEVBQUUsQ0FBQyxLQUFLLE9BQU8sQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO1FBQ3JDLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7SUFDRCxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUMsV0FBVyxDQUFDO0lBQ3pCLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQyxXQUFXLENBQUM7SUFDekIsSUFBSSxPQUFPLEVBQUUsS0FBSyxRQUFRLElBQUksT0FBTyxFQUFFLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDbkQsSUFBSSxPQUFPLEVBQUUsS0FBSyxRQUFRLElBQUksT0FBTyxFQUFFLEtBQUssUUFBUTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ25FLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3pELElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLEdBQUcsS0FBSyxHQUFHLEtBQUs7WUFBRSxPQUFPLEtBQUssQ0FBQztJQUN4RCxDQUFDO0lBQ0QsSUFBSSxPQUFPLENBQUMsQ0FBQyxHQUFHLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxDQUFDLEdBQUcsS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDM0csTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFFBQVEsQ0FBQztJQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDO0lBQ3RCLElBQUksRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ1gsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ2xFLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNO1lBQUUsT0FBTyxLQUFLLENBQUM7SUFDN0MsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUM7QUFXRCxTQUFTLGVBQWUsQ0FBQyxPQUFZLEVBQUUsR0FBUTtJQUMzQyxJQUFJLElBQUksR0FBUSxJQUFJLENBQUM7SUFDckIsSUFBSSxDQUFDO1FBQ0QsSUFBSSxPQUFPLE9BQU8sQ0FBQyxnQkFBZ0IsS0FBSyxVQUFVO1lBQUUsSUFBSSxHQUFHLE9BQU8sQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO0lBQzFGLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUFDRCxPQUFPO1FBQ0gsU0FBUyxFQUFFLGVBQWUsQ0FBQyxHQUFHLENBQUM7UUFDL0IsSUFBSTtRQUNKLEdBQUcsRUFBRTtZQUNELFdBQVcsRUFBRSxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQztZQUM5QyxHQUFHLEVBQUUsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7WUFDOUIsVUFBVSxFQUFFLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDO1NBQy9DO0tBQ0osQ0FBQztBQUNOLENBQUM7QUFFRCxrREFBa0Q7QUFDbEQsU0FBUyxlQUFlLENBQUMsR0FBUSxFQUFFLEtBQWtCO0lBQ2pELE1BQU0sUUFBUSxHQUFhLEVBQUUsQ0FBQztJQUM5QixNQUFNLElBQUksR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQy9DLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxTQUFTLENBQUM7SUFDNUIsSUFBSSxJQUFJLElBQUksR0FBRyxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ3ZCLElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUM7WUFDdkIsSUFBSSxPQUFPLElBQUksQ0FBQyxnQkFBZ0IsS0FBSyxVQUFVO2dCQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDOztnQkFDakYsSUFBSSxDQUFDLGFBQWEsR0FBRyxDQUFDLENBQUM7UUFDaEMsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxRQUFRLENBQUMsSUFBSSxDQUFDLFVBQVUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sR0FBRyxDQUFDLENBQUM7UUFDdkQsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLElBQUksSUFBSSxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDdkIsSUFBSSxDQUFDO1lBQ0QsTUFBTSxDQUFDLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQztZQUN2QixJQUFJLE9BQU8sSUFBSSxDQUFDLGdCQUFnQixLQUFLLFVBQVUsRUFBRSxDQUFDO2dCQUM5QyxNQUFNLElBQUksR0FBSSxLQUFLLEVBQVUsQ0FBQyxJQUFJLENBQUM7Z0JBQ25DLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN4RCxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxRQUFRLENBQUMsSUFBSSxDQUFDLFVBQVUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sR0FBRyxDQUFDLENBQUM7UUFDdkQsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxHQUFHLENBQUMsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ2pDLElBQUksQ0FBQztZQUNELEdBQUcsQ0FBQyxXQUFXLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUM7UUFDNUMsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxRQUFRLENBQUMsSUFBSSxDQUFDLG9CQUFvQixTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxHQUFHLENBQUMsQ0FBQztRQUNqRSxDQUFDO0lBQ0wsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFDO1lBQ0QsR0FBRyxDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztRQUM1QixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsc0JBQXNCO1FBQzFCLENBQUM7SUFDTCxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsR0FBRyxDQUFDLFVBQVUsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNoQyxJQUFJLENBQUM7WUFDRCxHQUFHLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDO1FBQzFDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztJQUNMLENBQUM7SUFDRCxPQUFPLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDM0QsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsU0FBUyxrQkFBa0IsQ0FDdkIsT0FBWSxFQUNaLEdBQVEsRUFDUixLQUFrQjtJQUVsQixNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7SUFDM0IsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDYixJQUFJLENBQUM7WUFDRCxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQzFDLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsS0FBSyxDQUFDLElBQUksQ0FBQywwQkFBMEIsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDbkUsQ0FBQztRQUNELE1BQU0sU0FBUyxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN2QyxJQUFJLFVBQVUsQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVMsQ0FBQztZQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLFNBQVMsRUFBRSxDQUFDO1FBQ3hHLEtBQUssQ0FBQyxJQUFJLENBQUMsOEJBQThCLENBQUMsQ0FBQztJQUMvQyxDQUFDO1NBQU0sQ0FBQztRQUNKLEtBQUssQ0FBQyxJQUFJLENBQUMsNkNBQTZDLENBQUMsQ0FBQztJQUM5RCxDQUFDO0lBRUQsTUFBTSxTQUFTLEdBQUcsZUFBZSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUM5QyxJQUFJLFNBQVM7UUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3JDLE1BQU0sUUFBUSxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUN0QyxJQUFJLFVBQVUsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQ3JHLEtBQUssQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7SUFDNUIsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDckYsQ0FBQztBQUVEOzs7Ozs7Ozs7R0FTRztBQUNILFNBQVMsY0FBYyxDQUNuQixFQUFPLEVBQ1AsR0FBUSxFQUNSLEtBQWdFLEVBQ2hFLE1BQWM7SUFFZCxNQUFNLEtBQUssR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdEQsTUFBTSxNQUFNLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hELE1BQU0sV0FBVyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDdEQsTUFBTSxJQUFJLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMvQyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsV0FBVyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDN0MsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLHFDQUFxQyxFQUFFLENBQUM7SUFDdEUsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUM7SUFDckIsTUFBTSxPQUFPLEdBQUcsQ0FBQyxDQUFTLEVBQUUsQ0FBUyxFQUFtQyxFQUFFO1FBQ3RFLElBQUksQ0FBQztZQUNELE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ25ELE9BQU8sRUFBRSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3RDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsTUFBTSxLQUFLLEdBQUcsR0FBd0UsRUFBRTtRQUNwRixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdkMsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLEdBQUcsV0FBVyxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNyRCxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFBRSxHQUFHLFdBQVcsQ0FBQyxDQUFDO1FBQ3JELElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDbkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUM7UUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUM7UUFDdkMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN0RixPQUFPLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFLENBQUM7SUFDbEMsQ0FBQyxDQUFDO0lBRUYsTUFBTSxLQUFLLEdBQUcsS0FBSyxFQUFFLENBQUM7SUFDdEIsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsdUNBQXVDLEVBQUUsQ0FBQztJQUVoRiw0QkFBNEI7SUFDNUIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FDbEIsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQ2hFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxHQUFHLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUN0RSxDQUFDO0lBQ0YsSUFBSSxDQUFDO1FBQ0QsR0FBRyxDQUFDLFdBQVcsR0FBRyxXQUFXLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxHQUFHLEtBQUssQ0FBQyxDQUFDO0lBQ3ZELENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLG9CQUFvQixTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQztJQUM3RSxDQUFDO0lBRUQsOENBQThDO0lBQzlDLElBQUksUUFBUSxHQUFvQyxJQUFJLENBQUM7SUFDckQsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDNUIsTUFBTSxRQUFRLEdBQUcsS0FBSyxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFDLFFBQVE7WUFBRSxNQUFNO1FBQ3JCLFFBQVEsR0FBRyxFQUFFLENBQUMsRUFBRSxLQUFLLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxNQUFNLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDbkYsMkNBQTJDO1FBQzNDLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBQ3JDLElBQUksQ0FBQztZQUNELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDL0IsSUFBSSxPQUFPLElBQUksQ0FBQyxnQkFBZ0IsS0FBSyxVQUFVO2dCQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7O2dCQUNqRyxJQUFJLENBQUMsYUFBYSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3pFLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLFNBQVMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUM7UUFDbEUsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFPO1FBQ0gsRUFBRSxFQUFFLElBQUk7UUFDUixNQUFNLEVBQUU7WUFDSixLQUFLLEVBQUUsTUFBTSxDQUFDLFdBQVcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLEdBQUcsS0FBSyxDQUFDLENBQUM7WUFDL0MsZUFBZSxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2pDLGVBQWUsRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDO1lBQzlCLGdCQUFnQixFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJO1NBQ3ZGO0tBQ0osQ0FBQztBQUNOLENBQUM7QUFFRCw2Q0FBNkM7QUFDN0MsSUFBSSxVQUFVLEdBQW9FLElBQUksQ0FBQztBQUV2Riw0Q0FBNEM7QUFDNUMsTUFBTSxnQkFBZ0IsR0FBRyxLQUFNLENBQUM7QUFFaEMscUNBQXFDO0FBQ3JDLElBQUksVUFBVSxHQUFHLENBQUMsQ0FBQztBQWNuQixnRUFBZ0U7QUFDaEUsU0FBUyxZQUFZLENBQ2pCLEVBQU8sRUFDUCxPQUFZLEVBQ1osR0FBUSxFQUNSLElBQVksRUFDWixNQUFpQixFQUNqQixJQUFvQjtJQUVwQixJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUs7UUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksSUFBSSxnQkFBZ0IsRUFBRSxDQUFDO0lBRWxGLElBQUksSUFBSSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ2IsSUFBSSxPQUFPLE9BQU8sQ0FBQyxLQUFLLEtBQUssVUFBVTtZQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSwrQkFBK0IsRUFBRSxDQUFDO1FBQ3hHLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQztZQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSwyQkFBMkIsRUFBRSxDQUFDO1FBQzFGLElBQUksQ0FBQztZQUNELE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDakQsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsd0JBQXdCLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQ3BGLENBQUM7UUFDRCxPQUFPLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxDQUFDO0lBQy9CLENBQUM7SUFFRCxJQUFJLElBQUksS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNiLElBQUksSUFBSSxLQUFLLElBQUk7WUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsd0NBQXdDLEVBQUUsQ0FBQztRQUMzRixNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDO1FBQ3hDLElBQUksQ0FBQyxVQUFVLElBQUksT0FBTyxVQUFVLENBQUMsZUFBZSxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQ2xFLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxzREFBc0QsRUFBRSxDQUFDO1FBQzFGLENBQUM7UUFDRCxJQUFJLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQ3BCLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLENBQUMsRUFDeEMsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUN6QyxNQUFNLENBQUMsS0FBSyxDQUFDLEtBQUssRUFDbEIsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQ3RCLENBQUM7WUFDRixVQUFVLENBQUMsZUFBZSxDQUFDLFVBQVUsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDdkQsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsdUJBQXVCLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQ25GLENBQUM7UUFDRCxPQUFPLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQ2hDLENBQUM7SUFFRCxJQUFJLElBQUksS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNiLElBQUksSUFBSSxLQUFLLElBQUk7WUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsa0NBQWtDLEVBQUUsQ0FBQztRQUNyRixNQUFNLE9BQU8sR0FBRyxjQUFjLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBQ2xFLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztJQUNoRyxDQUFDO0lBRUQsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE9BQU8sSUFBSSxNQUFNLEVBQUUsQ0FBQztBQUNyRCxDQUFDO0FBRUQsNENBQTRDO0FBQzVDLFNBQVMsV0FBVyxDQUFDLElBQW9CO0lBQ3JDLE9BQU8sSUFBSSxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakMsQ0FBQztBQVVEOzs7Ozs7R0FNRztBQUNILFNBQVMsa0JBQWtCLENBQUMsRUFBTyxFQUFFLE9BQTJCO0lBQzVELE1BQU0sTUFBTSxHQUFHLGNBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNsQyxNQUFNLE1BQU0sR0FBRyxZQUFZLEVBQUUsQ0FBQztJQUM5QixNQUFNLEdBQUcsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDO0lBRXZCLE1BQU0sT0FBTyxHQUE0QjtRQUNyQyxFQUFFLEVBQUUsSUFBSTtRQUNSLElBQUksRUFBRSxZQUFZLEVBQUU7UUFDcEIsTUFBTSxFQUFFLGNBQWMsQ0FBQyxNQUFNLENBQUM7UUFDOUIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLEVBQUUsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUMvQzs7O1dBR0c7UUFDSCxPQUFPLEVBQUUsYUFBYSxDQUFDLEVBQUUsQ0FBQztRQUMxQixNQUFNLEVBQUU7WUFDSixTQUFTLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQztZQUN2QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7WUFDakIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO1lBQ2pCLEdBQUcsQ0FBQyxHQUFHO2dCQUNILENBQUMsQ0FBQztvQkFDSSxLQUFLLEVBQUUsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDO29CQUN6QyxNQUFNLEVBQUUsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO29CQUMzQyxXQUFXLEVBQUUsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUM7b0JBQzlDLFdBQVcsRUFBRSxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQztvQkFDOUMsU0FBUyxFQUFFLGVBQWUsQ0FBQyxHQUFHLENBQUM7aUJBQ2xDO2dCQUNILENBQUMsQ0FBQyxFQUFFLENBQUM7U0FDWjtLQUNKLENBQUM7SUFFRixNQUFNLEdBQUcsR0FBRyxPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDeEUsTUFBTSxPQUFPLEdBQUcsZ0JBQWdCLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzlDLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxPQUFPO1FBQUUsT0FBTyxPQUFPLENBQUM7SUFFckMsTUFBTSxPQUFPLEdBQUcsV0FBVyxDQUFDLEVBQUUsRUFBRTtRQUM1QixXQUFXLEVBQUUsT0FBTyxPQUFPLENBQUMsV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsRUFBRTtLQUNsRixDQUFDLENBQUMsT0FBOEIsQ0FBQztJQUVsQyxJQUFJLElBQUksR0FBUSxJQUFJLENBQUM7SUFDckIsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUNOLElBQUksQ0FBQztZQUNELElBQUksR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDO1FBQ3RFLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsT0FBTyxDQUFDLElBQUksR0FBRyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxtQkFBbUIsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUM7WUFDeEYsT0FBTyxPQUFPLENBQUM7UUFDbkIsQ0FBQztRQUNELElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sQ0FBQyxJQUFJLEdBQUc7Z0JBQ1gsR0FBRztnQkFDSCxLQUFLLEVBQUUsS0FBSztnQkFDWixJQUFJLEVBQUUsK0RBQStEO2FBQ3hFLENBQUM7WUFDRixPQUFPLE9BQU8sQ0FBQztRQUNuQixDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQTRCLEVBQUUsR0FBRyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM3RixJQUFJLENBQUM7WUFDRCxJQUFJLENBQUMsU0FBUyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDN0MsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLG1CQUFtQjtRQUN2QixDQUFDO1FBQ0QsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ1AsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7WUFDakIsSUFBSSxDQUFDLElBQUksR0FBRyxHQUFHLE1BQU0sQ0FBQyxJQUFJLElBQUksVUFBVSx3QkFBd0IsQ0FBQztZQUNqRSxPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztRQUN4QixDQUFDO2FBQU0sQ0FBQztZQUNKLE1BQU0sU0FBUyxHQUFHLGVBQWUsQ0FBQyxFQUFFLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQztZQUN6RCxJQUFJLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUM7WUFDM0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxTQUFTLENBQUMsVUFBVSxDQUFDO1lBQ3ZDLElBQUksU0FBUyxDQUFDLElBQUk7Z0JBQUUsSUFBSSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDO1lBQy9DLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ3hCLENBQUM7SUFDTCxDQUFDO0lBRUQsaUNBQWlDO0lBQ2pDLElBQUksT0FBTyxFQUFFLENBQUM7UUFDVixNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDcEMsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDbkQsTUFBTSxPQUFPLEdBQTRCO1lBQ3JDLE1BQU0sRUFBRTtnQkFDSixJQUFJLEVBQUUsT0FBTyxDQUFDLElBQUk7Z0JBQ2xCLEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRyxJQUFJLElBQUk7Z0JBQ3hCLCtCQUErQjtnQkFDL0IsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNO2dCQUNyQixpQ0FBaUM7Z0JBQ2pDLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU07Z0JBQzFCLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSzthQUN0QjtZQUNELFFBQVE7WUFDUixPQUFPLEVBQUUsS0FBSztZQUNkLFNBQVMsRUFBRSxDQUFDO1lBQ1osSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO1NBQ3BCLENBQUM7UUFDRixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDWixPQUFPLENBQUMsSUFBSSxHQUFHLDBCQUEwQixDQUFDO1FBQzlDLENBQUM7YUFBTSxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDZCxPQUFPLENBQUMsSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLElBQUksbUJBQW1CLENBQUM7UUFDdEQsQ0FBQzthQUFNLENBQUM7WUFDSiw4Q0FBOEM7WUFDOUMsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUcsT0FBTyxDQUFDLElBQTRCLENBQUMsSUFBc0MsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQ3JILElBQUksUUFBUSxHQUFrQyxJQUFJLENBQUM7WUFDbkQsSUFBSSxPQUFPLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO2dCQUMxQixRQUFRLEdBQUcsUUFBUSxJQUFJLE9BQU8sUUFBUSxDQUFDLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO2dCQUM1RSxJQUFJLENBQUMsUUFBUTtvQkFBRSxPQUFPLENBQUMsSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJLElBQUksa0JBQWtCLENBQUM7WUFDckUsQ0FBQztpQkFBTSxJQUFJLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztnQkFDdEIsTUFBTSxTQUFTLEdBQUcsZUFBZSxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFO29CQUMvQyxFQUFFLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFO29CQUNuQixFQUFFLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFO29CQUNuQixFQUFFLEVBQUUsQ0FBQztvQkFDTCxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLO29CQUN6QixNQUFNLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNO2lCQUM5QixDQUFDLENBQUM7Z0JBQ0gsUUFBUSxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUM7Z0JBQzFCLElBQUksQ0FBQyxRQUFRLElBQUksU0FBUyxDQUFDLElBQUk7b0JBQUUsT0FBTyxDQUFDLElBQUksR0FBRyxPQUFPLENBQUMsSUFBSSxJQUFJLFNBQVMsQ0FBQyxJQUFJLENBQUM7WUFDbkYsQ0FBQztZQUNELElBQUksUUFBUSxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxRQUFRLEdBQUcsVUFBVSxDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQztnQkFDaEQsT0FBTyxDQUFDLE9BQU8sR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDO2dCQUNuQyxPQUFPLENBQUMsU0FBUyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUM7Z0JBQ3ZDLE9BQU8sQ0FBQyxLQUFLLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQztnQkFDL0IsT0FBTyxDQUFDLFVBQVUsR0FBRyxRQUFRLENBQUM7WUFDbEMsQ0FBQztRQUNMLENBQUM7UUFDRCxPQUFPLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztJQUM5QixDQUFDO0lBRUQsT0FBTyxPQUFPLENBQUM7QUFDbkIsQ0FBQztBQU1EOzs7OztHQUtHO0FBQ0gsU0FBUyxXQUFXLENBQUMsRUFBTyxFQUFFLE9BQWtDO0lBQzVELE1BQU0sS0FBSyxHQUFHLEVBQUUsaUJBQWlCLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFFM0MsTUFBTSxPQUFPLEdBQTRCLEVBQUUsQ0FBQztJQUU1Qzs7OztPQUlHO0lBQ0gsTUFBTSxXQUFXLEdBQUcsR0FBVyxFQUFFO1FBQzdCLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsV0FBVyxDQUFBLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDeEYsT0FBTyxXQUFXLElBQUksa0JBQWtCLEVBQUUsQ0FBQztJQUMvQyxDQUFDLENBQUM7SUFFRiwwRUFBMEU7SUFDMUUsa0NBQWtDO0lBQ2xDLDBFQUEwRTtJQUMxRSxFQUFFO0lBQ0YsMkRBQTJEO0lBQzNELDBDQUEwQztJQUMxQyxFQUFFO0lBQ0YsY0FBYztJQUNkLHFEQUFxRDtJQUNyRCxvRUFBb0U7SUFDcEUsb0RBQW9EO0lBQ3BELEVBQUU7SUFDRix5REFBeUQ7SUFDekQsMkRBQTJEO0lBQzNELEVBQUU7SUFDRixnQkFBZ0I7SUFDaEIsRUFBRTtJQUNGLDREQUE0RDtJQUM1RCw0RUFBNEU7SUFDNUUsb0RBQW9EO0lBQ3BELDZEQUE2RDtJQUM3RCxFQUFFO0lBQ0YsdURBQXVEO0lBQ3ZELHlDQUF5QztJQUN6Qyx1RUFBdUU7SUFDdkUsRUFBRTtJQUNGLHlEQUF5RDtJQUN6RCxxQ0FBcUM7SUFDckMsc0NBQXNDO0lBQ3RDLE1BQU0sZUFBZSxHQUFHLENBQUMsR0FBRyxFQUFFO1FBQzFCLElBQUksQ0FBQztZQUNELE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUM7WUFDL0MsSUFBSSxLQUFLLElBQUksT0FBTyxLQUFLLENBQUMsZUFBZSxLQUFLLFFBQVE7Z0JBQUUsT0FBTyxLQUFLLENBQUMsZUFBZSxDQUFDO1FBQ3pGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCwyQkFBMkI7UUFDL0IsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFFTCx1REFBdUQ7SUFDdkQsTUFBTSxlQUFlLEdBQUcsQ0FBQyx5QkFBeUIsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO0lBRS9FLE1BQU0sWUFBWSxHQUFHLENBQUMsSUFBUyxFQUFXLEVBQUU7UUFDeEMsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUN4QixJQUFJLENBQUM7WUFDRCx5REFBeUQ7WUFDekQsTUFBTSxLQUFLLEdBQ1AsT0FBTyxJQUFJLENBQUMsU0FBUyxLQUFLLFFBQVE7Z0JBQzlCLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUztnQkFDaEIsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsS0FBSyxRQUFRO29CQUNsQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVM7b0JBQ2hCLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDZCxJQUFJLENBQUMsS0FBSyxHQUFHLGVBQWUsQ0FBQyxLQUFLLENBQUM7Z0JBQUUsT0FBTyxJQUFJLENBQUM7UUFDckQsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLG1CQUFtQjtRQUN2QixDQUFDO1FBQ0QsT0FBTyxlQUFlLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDbkQsQ0FBQyxDQUFDO0lBRUYsc0JBQXNCO0lBQ3RCLE1BQU0sZUFBZSxHQUFHLENBQUMsSUFBUyxFQUFTLEVBQUU7UUFDekMsTUFBTSxRQUFRLEdBQVUsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN0RCxPQUFPLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFVLEVBQUUsRUFBRSxDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDakUsQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7T0FhRztJQUNILE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxJQUFZLEVBQU8sRUFBRTtRQUNoRCxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0IsSUFBSSxDQUFDLEtBQUs7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN4QixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDO2FBQ3hCLEtBQUssQ0FBQyxHQUFHLENBQUM7YUFDVixNQUFNLENBQUMsQ0FBQyxPQUFlLEVBQUUsRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDckQsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUM7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUV4QyxrQkFBa0I7UUFDbEIsSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxDQUFDLElBQUk7WUFBRSxRQUFRLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDakQsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUM7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUV4QyxJQUFJLE1BQU0sR0FBUSxLQUFLLENBQUM7UUFDeEIsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO1FBQ2QsT0FBTyxLQUFLLEdBQUcsUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQzdCLElBQUksS0FBSyxHQUFRLElBQUksQ0FBQztZQUN0QixLQUFLLElBQUksR0FBRyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEVBQUUsR0FBRyxHQUFHLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7Z0JBQ3BELE1BQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDdkQsSUFBSSxLQUFLLEdBQVEsSUFBSSxDQUFDO2dCQUN0QixJQUFJLENBQUM7b0JBQ0QsS0FBSyxHQUFHLE1BQU0sQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDLENBQUM7Z0JBQzdDLENBQUM7Z0JBQUMsTUFBTSxDQUFDO29CQUNMLEtBQUssR0FBRyxJQUFJLENBQUM7Z0JBQ2pCLENBQUM7Z0JBQ0QsSUFBSSxLQUFLLEVBQUUsQ0FBQztvQkFDUixLQUFLLEdBQUcsS0FBSyxDQUFDO29CQUNkLEtBQUssR0FBRyxHQUFHLENBQUM7b0JBQ1osTUFBTTtnQkFDVixDQUFDO1lBQ0wsQ0FBQztZQUNELElBQUksQ0FBQyxLQUFLO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBQ3hCLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDbkIsQ0FBQztRQUNELE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUMsQ0FBQztJQUVGLGtDQUFrQztJQUNsQyxPQUFPLENBQUMsVUFBVSxHQUFHLENBQUMsSUFBWSxFQUFPLEVBQUU7UUFDdkMsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQy9CLElBQUksQ0FBQyxLQUFLO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDeEIsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLElBQUk7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUN0QyxJQUFJLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3hDLElBQUksSUFBSTtnQkFBRSxPQUFPLElBQUksQ0FBQztRQUMxQixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsc0JBQXNCO1FBQzFCLENBQUM7UUFDRCxJQUFJLEtBQUssR0FBUSxJQUFJLENBQUM7UUFDdEIsUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQU0sRUFBRSxFQUFFO1lBQ3ZCLElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDLElBQUksS0FBSyxJQUFJO2dCQUFFLEtBQUssR0FBRyxDQUFDLENBQUM7UUFDN0MsQ0FBQyxDQUFDLENBQUM7UUFDSCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDLENBQUM7SUFFRjs7Ozs7O09BTUc7SUFDSCxPQUFPLENBQUMsVUFBVSxHQUFHLENBQUMsSUFBWSxFQUFPLEVBQUU7UUFDdkMsSUFBSSxDQUFDO1lBQ0QsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUMzQixJQUFJLElBQUk7Z0JBQUUsT0FBTyxJQUFJLENBQUM7UUFDMUIsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLFFBQVE7UUFDWixDQUFDO1FBQ0QsT0FBTyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QyxDQUFDLENBQUM7SUFFRjs7Ozs7O09BTUc7SUFDSCxPQUFPLENBQUMsUUFBUSxHQUFHLENBQ2YsS0FBMEIsRUFDMUIsSUFBVSxFQUNWLE9BQXFDLEVBQ2pDLEVBQUU7UUFDTixNQUFNLEtBQUssR0FBRyxJQUFJLElBQUksWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxLQUFLO1lBQUUsT0FBTztRQUNuQixNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNoRSx1Q0FBdUM7UUFDdkMsTUFBTSxLQUFLLEdBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM3QixPQUFPLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDdEIsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3pCLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNaLE1BQU0sUUFBUSxHQUFVLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDO1lBQzVDLEtBQUssSUFBSSxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7Z0JBQy9DLE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDMUIsSUFBSSxDQUFDLGFBQWEsSUFBSSxZQUFZLENBQUMsS0FBSyxDQUFDO29CQUFFLFNBQVM7Z0JBQ3BELEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDdEIsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDLENBQUM7SUFFRjs7Ozs7Ozs7O09BU0c7SUFDSCxPQUFPLENBQUMsSUFBSSxHQUFHLENBQ1gsT0FBOEYsRUFDaEUsRUFBRTtRQUNoQyxNQUFNLElBQUksR0FBRyxPQUFPLElBQUksRUFBRSxDQUFDO1FBQzNCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLElBQUksWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzNDLElBQUksQ0FBQyxJQUFJO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDdkIsTUFBTSxRQUFRLEdBQUcsT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3ZFLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUM7UUFFbEQsTUFBTSxLQUFLLEdBQUcsQ0FBQyxJQUFTLEVBQUUsS0FBYSxFQUEyQixFQUFFO1lBQ2hFLE1BQU0sR0FBRyxHQUE0QjtnQkFDakMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJO2dCQUNmLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTtnQkFDZixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07YUFDdEIsQ0FBQztZQUNGLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO2dCQUN0QixHQUFHLENBQUMsVUFBVSxHQUFHLENBQUMsSUFBSSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRTtvQkFDcEQsSUFBSSxDQUFDO3dCQUNELE9BQU8sRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQztvQkFDL0QsQ0FBQztvQkFBQyxNQUFNLENBQUM7d0JBQ0wsT0FBTyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsQ0FBQztvQkFDL0IsQ0FBQztnQkFDTCxDQUFDLENBQUMsQ0FBQztZQUNQLENBQUM7WUFDRCxNQUFNLFdBQVcsR0FBVSxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQztZQUMvQyxNQUFNLFFBQVEsR0FBRyxhQUFhO2dCQUMxQixDQUFDLENBQUMsV0FBVztnQkFDYixDQUFDLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQVUsRUFBRSxFQUFFLENBQUMsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUMvRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQ3RCLEdBQUcsQ0FBQyxVQUFVLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQztnQkFDakMsSUFBSSxLQUFLLEdBQUcsUUFBUSxFQUFFLENBQUM7b0JBQ25CLEdBQUcsQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDakUsQ0FBQztxQkFBTSxDQUFDO29CQUNKLEdBQUcsQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUM5RSxDQUFDO1lBQ0wsQ0FBQztZQUNELHdCQUF3QjtZQUN4QixNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsTUFBTSxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUM7WUFDcEQsSUFBSSxNQUFNLEdBQUcsQ0FBQztnQkFBRSxHQUFHLENBQUMsb0JBQW9CLEdBQUcsTUFBTSxDQUFDO1lBQ2xELE9BQU8sR0FBRyxDQUFDO1FBQ2YsQ0FBQyxDQUFDO1FBQ0YsT0FBTyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQzFCLENBQUMsQ0FBQztJQUVGLHdDQUF3QztJQUN4QyxPQUFPLENBQUMsWUFBWSxHQUFHLENBQUMsSUFBUyxFQUFXLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFbEUsd0JBQXdCO0lBQ3hCLE9BQU8sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxJQUFVLEVBQVMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxJQUFJLElBQUksWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFFM0Y7Ozs7OztPQU1HO0lBQ0gsT0FBTyxDQUFDLElBQUksR0FBRyxDQUFDLE1BQVcsRUFBa0MsRUFBRTtRQUMzRCxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBRXpCLDJCQUEyQjtRQUMzQixJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbEMsTUFBTSxHQUFHLEdBQTRCO2dCQUNqQyxNQUFNLEVBQUUsV0FBVztnQkFDbkIsSUFBSSxFQUFFLENBQUMsR0FBRyxFQUFFO29CQUNSLElBQUksQ0FBQzt3QkFDRCxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO29CQUN0QyxDQUFDO29CQUFDLE1BQU0sQ0FBQzt3QkFDTCxPQUFPLE1BQU0sQ0FBQyxXQUFXLElBQUksTUFBTSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUM7b0JBQ3pELENBQUM7Z0JBQ0wsQ0FBQyxDQUFDLEVBQUU7Z0JBQ0osSUFBSSxFQUFFLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDO2dCQUM1QixPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU87YUFDMUIsQ0FBQztZQUNGLE1BQU0sS0FBSyxHQUE0QixFQUFFLENBQUM7WUFDMUMsS0FBSyxNQUFNLEdBQUcsSUFBSSxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO2dCQUMzQyxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDO2dCQUNuQyxJQUFJLElBQUksQ0FBQyxFQUFFO29CQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1lBQ3pDLENBQUM7WUFDRCxHQUFHLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztZQUNsQixPQUFPLEdBQUcsQ0FBQztRQUNmLENBQUM7UUFFRCxNQUFNO1FBQ04sSUFBSSxNQUFNLENBQUMsUUFBUSxJQUFJLE9BQU8sTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNyRCxNQUFNLFVBQVUsR0FBOEIsRUFBRSxDQUFDO1lBQ2pELEtBQUssTUFBTSxJQUFJLElBQUksTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLEVBQUUsQ0FBQztnQkFDekMsSUFBSSxRQUFRLEdBQUcsU0FBUyxDQUFDO2dCQUN6QixJQUFJLENBQUM7b0JBQ0QsUUFBUSxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN4QyxDQUFDO2dCQUFDLE1BQU0sQ0FBQztvQkFDTCxRQUFRLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksU0FBUyxDQUFDO2dCQUN4RSxDQUFDO2dCQUNELE1BQU0sS0FBSyxHQUE0QixFQUFFLENBQUM7Z0JBQzFDLEtBQUssTUFBTSxHQUFHLElBQUksa0JBQWtCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztvQkFDekMsTUFBTSxJQUFJLEdBQUcsUUFBUSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQztvQkFDakMsSUFBSSxJQUFJLENBQUMsRUFBRTt3QkFBRSxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztnQkFDekMsQ0FBQztnQkFDRCxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO1lBQ3RFLENBQUM7WUFDRCxPQUFPO2dCQUNILE1BQU0sRUFBRSxNQUFNO2dCQUNkLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSTtnQkFDakIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO2dCQUNqQixNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU07Z0JBQ3JCLGlCQUFpQixFQUFFLE1BQU0sQ0FBQyxpQkFBaUI7Z0JBQzNDLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztnQkFDbkIsUUFBUSxFQUFFLE1BQU0sQ0FBQyxRQUFRO2dCQUN6QixRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVE7Z0JBQ3pCLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztnQkFDbkIsTUFBTSxFQUFFLFNBQVMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO2dCQUNoQyxRQUFRLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMvRCxVQUFVO2FBQ2IsQ0FBQztRQUNOLENBQUM7UUFFRCxPQUFPLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUM7SUFDOUMsQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7T0FPRztJQUNILE9BQU8sQ0FBQyxRQUFRLEdBQUcsR0FBUyxFQUFFO1FBQzFCLEtBQUssQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7SUFDbkMsQ0FBQyxDQUFDO0lBRUYscURBQXFEO0lBQ3JELE9BQU8sQ0FBQyxLQUFLLEdBQUcsQ0FBQyxFQUFVLEVBQWlCLEVBQUUsQ0FDMUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtRQUNwQixVQUFVLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDOUQsQ0FBQyxDQUFDLENBQUM7SUFFUDs7Ozs7Ozs7Ozs7O09BWUc7SUFDSCxPQUFPLENBQUMsV0FBVyxHQUFHLEtBQUssRUFDdkIsT0FNQyxFQUMrQixFQUFFO1FBQ2xDLE1BQU0sSUFBSSxHQUFHLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDM0IsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sS0FBSyxNQUFNLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO1FBQ2hGLE1BQU0sSUFBSSxHQUFHLE1BQU0sS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDO1FBQzVELE1BQU0sT0FBTyxHQUFHLE9BQU8sSUFBSSxDQUFDLE9BQU8sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDbEcsTUFBTSxRQUFRLEdBQUcsT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztRQUMxRyxNQUFNLE1BQU0sR0FBRyxPQUFPLElBQUksQ0FBQyxNQUFNLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO1FBRWhHLE1BQU0sTUFBTSxHQUFHLGNBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNsQyxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxtQ0FBbUMsRUFBRSxDQUFDO1FBRTlFLElBQUksS0FBNEQsQ0FBQztRQUNqRSxJQUFJLENBQUM7WUFDRCxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUMsRUFBRSxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNyRCxDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNYLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxVQUFVLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQ3BFLENBQUM7UUFFRCxJQUFJLE9BQTJELENBQUM7UUFDaEUsSUFBSSxDQUFDO1lBQ0QsT0FBTyxHQUFHLG9CQUFvQixDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFO2dCQUNwRSxRQUFRO2dCQUNSLElBQUk7Z0JBQ0osT0FBTzthQUNWLENBQUMsQ0FBQztRQUNQLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLFVBQVUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUM7UUFDcEUsQ0FBQztRQUVELE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzNDLE1BQU0sTUFBTSxHQUFHLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ2xFLE1BQU0sSUFBSSxHQUE0QjtZQUNsQyxFQUFFLEVBQUUsSUFBSTtZQUNSLEtBQUssRUFBRSxPQUFPLENBQUMsS0FBSztZQUNwQixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU07WUFDdEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ3hCLFlBQVksRUFBRSxLQUFLLENBQUMsTUFBTTtZQUMxQixNQUFNO1lBQ04sS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUMxQyxVQUFVLEVBQUUsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztZQUMxQyxrREFBa0Q7WUFDbEQsSUFBSSxFQUFFLGFBQWEsQ0FBQyxFQUFFLEVBQUUsTUFBTSxDQUFDO1NBQ2xDLENBQUM7UUFFRixNQUFNLFFBQVEsR0FBRyxPQUFPLElBQUksQ0FBQyxRQUFRLEtBQUssUUFBUSxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUN2RyxNQUFNLElBQUksR0FBRyxjQUFjLEVBQUUsQ0FBQztRQUM5QixJQUFJLFFBQVEsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNuQixJQUFJLENBQUM7Z0JBQ0QsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ3hDLElBQUksR0FBRztvQkFBRSxJQUFJLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDckQsSUFBSSxDQUFDLEVBQUUsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7Z0JBQy9ELE9BQU8sRUFBRSxHQUFHLElBQUksRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsQ0FBQztZQUMxRCxDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDWCx3QkFBd0I7Z0JBQ3hCLElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQztZQUM1QyxDQUFDO1FBQ0wsQ0FBQztRQUVELE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtRQUM3QyxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUM7UUFDNUIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFJLFNBQVM7WUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxTQUFTLENBQUMsQ0FBQyxDQUFDO1FBQy9GLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxFQUFFLEVBQUUsQ0FBQztZQUNyQixPQUFPO2dCQUNILEdBQUcsSUFBSTtnQkFDUCxFQUFFLEVBQUUsS0FBSztnQkFDVCxLQUFLLEVBQ0QsYUFBYSxNQUFNLENBQUMsTUFBTSx5QkFBeUI7b0JBQ25ELE9BQU8sUUFBUSw0QkFBNEI7YUFDbEQsQ0FBQztRQUNOLENBQUM7UUFDRCxPQUFPLEVBQUUsR0FBRyxJQUFJLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDMUYsQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQXVDRztJQUNILE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxFQUFlLENBQUM7SUFDMUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxLQUFLLEVBQUUsR0FBWSxFQUFnQixFQUFFO1FBQ3JELE1BQU0sR0FBRyxHQUFHLE9BQU8sR0FBRyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDdEQsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ1AsTUFBTSxJQUFJLEtBQUssQ0FDWCw2RkFBNkY7Z0JBQ3pGLG9EQUFvRCxDQUMzRCxDQUFDO1FBQ04sQ0FBQztRQUNELElBQUksVUFBVSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7WUFBRSxPQUFPLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFcEQsTUFBTSxVQUFVLEdBQWEsRUFBRSxDQUFDO1FBQ2hDLE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztRQUUzQixzQ0FBc0M7UUFDdEMsTUFBTSxPQUFPLEdBQUcsQ0FBQyxJQUFZLEVBQWdCLEVBQUUsQ0FDM0MsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7WUFDNUIsSUFBSSxDQUFDO2dCQUNELEVBQUUsQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQyxHQUFRLEVBQUUsS0FBVSxFQUFFLEVBQUUsQ0FDdkQsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUM1RixDQUFDO1lBQ04sQ0FBQztZQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1lBQzlDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVQLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ2hCLFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDekIsQ0FBQzthQUFNLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNwQyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQ1gscUNBQXFDLEdBQUcsSUFBSTtvQkFDeEMsOEZBQThGLENBQ3JHLENBQUM7WUFDTixDQUFDO1lBQ0QsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLDBCQUEwQixFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ3JGLE1BQU0sSUFBSSxHQUFHLFdBQVcsRUFBRSxDQUFDO1lBQzNCLE1BQU0sUUFBUSxHQUFHLGNBQWMsRUFBRSxDQUFDO1lBQ2xDLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDckIsS0FBSyxDQUFDLElBQUksQ0FDTiw4Q0FBOEMsR0FBRyxXQUFXO29CQUN4RCxpRUFBaUUsQ0FDeEUsQ0FBQztZQUNOLENBQUM7aUJBQU0sQ0FBQztnQkFDSixNQUFNLFFBQVEsR0FBRyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQztnQkFDbkUsSUFBSSxJQUFJLEdBQVEsSUFBSSxDQUFDO2dCQUNyQixJQUFJLENBQUM7b0JBQ0QsSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQ25FLENBQUM7Z0JBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztvQkFDWCxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEdBQUcsQ0FBQyxDQUFDO2dCQUM3RCxDQUFDO2dCQUNELE1BQU0sUUFBUSxHQUFHLElBQUksSUFBSSxPQUFPLElBQUksQ0FBQyxRQUFRLEtBQUssUUFBUSxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQkFDbkcsSUFBSSxRQUFRLEVBQUUsQ0FBQztvQkFDWCxLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQzt3QkFDdEMsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQzt3QkFDbEMsTUFBTSxhQUFhLEdBQ2YsS0FBSyxDQUFDLElBQUksS0FBSyxhQUFhOzRCQUM1QixLQUFLLENBQUMsUUFBUSxLQUFLLGNBQWM7NEJBQ2pDLEtBQUssQ0FBQyxRQUFRLEtBQUssYUFBYSxDQUFDO3dCQUNyQyxJQUFJLENBQUMsYUFBYTs0QkFBRSxTQUFTO3dCQUM3QixpQ0FBaUM7d0JBQ2pDLFVBQVUsQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLENBQUMsSUFBSSxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxJQUFJLElBQUksR0FBRyxFQUFFLENBQUMsQ0FBQzt3QkFDbkcsTUFBTTtvQkFDVixDQUFDO29CQUNELElBQUksVUFBVSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQzt3QkFDMUIsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsOENBQThDLENBQUMsQ0FBQztvQkFDckUsQ0FBQztnQkFDTCxDQUFDO1lBQ0wsQ0FBQztRQUNMLENBQUM7YUFBTSxJQUFJLHVCQUF1QixDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzNDLFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDekIsQ0FBQzthQUFNLENBQUM7WUFDSixNQUFNLElBQUksS0FBSyxDQUNYLHFCQUFxQixHQUFHLDJDQUEyQyxDQUN0RSxDQUFDO1FBQ04sQ0FBQztRQUVELElBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUNkLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxVQUFVLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUM1QyxNQUFNLFNBQVMsR0FBRyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDaEMsSUFBSSxDQUFDO2dCQUNELE1BQU0sS0FBSyxHQUFHLE1BQU0sT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO2dCQUN2QyxJQUFJLEtBQUssSUFBSSxFQUFFLENBQUMsV0FBVyxJQUFJLEtBQUssWUFBWSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQzdELFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO29CQUMzQixPQUFPLEtBQUssQ0FBQztnQkFDakIsQ0FBQztnQkFDRCxNQUFNLElBQUksR0FBRyxLQUFLLElBQUksS0FBSyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sS0FBSyxDQUFDO2dCQUMxRyxJQUFJLEdBQUcsR0FBRyxTQUFTLE1BQU0sSUFBSSxFQUFFLENBQUM7Z0JBQ2hDLHVEQUF1RDtnQkFDdkQsSUFBSSxJQUFJLEtBQUssV0FBVyxJQUFJLFNBQVMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7b0JBQ3JELFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxTQUFTLFFBQVEsQ0FBQyxDQUFDO29CQUN0QyxLQUFLLENBQUMsSUFBSSxDQUFDLDZDQUE2QyxDQUFDLENBQUM7Z0JBQzlELENBQUM7WUFDTCxDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDWCxJQUFJLEdBQUcsR0FBRyxTQUFTLE1BQU0sU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ3RELENBQUM7UUFDTCxDQUFDO1FBRUQsTUFBTSxJQUFJLEtBQUssQ0FDWCxjQUFjLEdBQUcsdUJBQXVCLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFO1lBQ2pFLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDbEQsMEVBQTBFLENBQ2pGLENBQUM7SUFDTixDQUFDLENBQUM7SUFFRjs7Ozs7O09BTUc7SUFDSCxNQUFNLGFBQWEsR0FBRyxDQUFDLElBQVMsRUFBTyxFQUFFO1FBQ3JDLElBQUksQ0FBQztZQUNELElBQUksQ0FBQyxJQUFJLElBQUksT0FBTyxJQUFJLENBQUMsWUFBWSxLQUFLLFVBQVU7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDbEUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxXQUFXO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBQ2pDLE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLElBQUksSUFBSSxDQUFDO1FBQ3JELENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQTJCRztJQUNILE9BQU8sQ0FBQyxTQUFTLEdBQUcsQ0FDaEIsSUFBUyxFQUNULE9BQXdCLEVBQ0QsRUFBRTtRQUN6QixJQUFJLENBQUMsSUFBSTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMkJBQTJCLENBQUMsQ0FBQztRQUN4RCxNQUFNLE1BQU0sR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBRTdELGdEQUFnRDtRQUNoRCxNQUFNLEtBQUssR0FBVSxFQUFFLENBQUM7UUFDeEIsS0FBSyxJQUFJLE1BQU0sR0FBRyxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sR0FBRyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDckQsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNuQixJQUFJLE1BQU0sSUFBSSxNQUFNLEtBQUssTUFBTTtnQkFBRSxNQUFNO1FBQzNDLENBQUM7UUFFRCwwREFBMEQ7UUFDMUQsSUFBSSxPQUFPLEdBQUcsQ0FBQyxDQUFDO1FBQ2hCLElBQUksT0FBTyxHQUFHLENBQUMsQ0FBQztRQUNoQixJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDWCxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDWCxLQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQzVDLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN2QixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQzVCLE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztZQUMxQyxFQUFFLElBQUksT0FBTyxFQUFFLENBQUMsQ0FBQyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQzFDLEVBQUUsSUFBSSxPQUFPLEVBQUUsQ0FBQyxDQUFDLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDMUMsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQzdDLE9BQU8sSUFBSSxFQUFFLEdBQUcsR0FBRyxDQUFDLENBQUMsQ0FBQztZQUN0QixPQUFPLElBQUksRUFBRSxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDMUIsQ0FBQztRQUVELCtCQUErQjtRQUMvQixNQUFNLEVBQUUsR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDL0IsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDaEMsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEMsTUFBTSxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDakMsTUFBTSxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDakMsTUFBTSxFQUFFLEdBQUcsT0FBTyxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUM7UUFDN0MsTUFBTSxFQUFFLEdBQUcsT0FBTyxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUM7UUFDOUMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQy9CLE1BQU0sS0FBSyxHQUFHLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNoQyxNQUFNLEtBQUssR0FBRyxDQUFDLEtBQWEsRUFBVSxFQUFFLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsSUFBSSxDQUFDO1FBQ3pFLE9BQU87WUFDSCxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDZixFQUFFLEVBQUUsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNiLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2IsS0FBSyxFQUFFLEtBQUssQ0FBQyxFQUFFLEdBQUcsS0FBSyxDQUFDO1lBQ3hCLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQztZQUMxQixJQUFJLEVBQUUsS0FBSyxDQUFDLEVBQUUsR0FBRyxLQUFLLENBQUM7WUFDdkIsS0FBSyxFQUFFLEtBQUssQ0FBQyxFQUFFLEdBQUcsS0FBSyxDQUFDO1lBQ3hCLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxHQUFHLEtBQUssQ0FBQztZQUN6QixHQUFHLEVBQUUsS0FBSyxDQUFDLEVBQUUsR0FBRyxLQUFLLENBQUM7WUFDdEIsT0FBTyxFQUFFLEVBQUU7WUFDWCxPQUFPLEVBQUUsRUFBRTtZQUNYLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2pCLGdDQUFnQztZQUNoQyxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sQ0FBQyxJQUFJLHdCQUF3QixDQUFDLENBQUMsQ0FBQywwQkFBMEI7U0FDekYsQ0FBQztJQUNOLENBQUMsQ0FBQztJQUVGOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O09BbUJHO0lBQ0gsT0FBTyxDQUFDLGFBQWEsR0FBRyxHQUE0QixFQUFFO1FBQ2xELE1BQU0sS0FBSyxHQUFHLENBQUMsS0FBYSxFQUFVLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUM7UUFDekUsZ0ZBQWdGO1FBQ2hGLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxRQUFnRCxDQUFDO1FBQ3RFLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxTQUF5RSxDQUFDO1FBQ2pHLElBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQztRQUNwQixJQUFJLEtBQUssR0FBRyxDQUFDLFFBQVEsQ0FBQztRQUN0QixJQUFJLE1BQU0sR0FBRyxRQUFRLENBQUM7UUFDdEIsSUFBSSxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUM7UUFDcEIsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO1FBRWQsSUFBSSxDQUFDLENBQUMsSUFBUyxFQUFFLEVBQUU7WUFDZixNQUFNLEVBQUUsR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDL0IsSUFBSSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7Z0JBQUUsT0FBTztZQUN2RCxJQUFJLElBQXlCLENBQUM7WUFDOUIsSUFBSSxDQUFDO2dCQUNELElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDeEIsQ0FBQztZQUFDLE1BQU0sQ0FBQztnQkFDTCxPQUFPLENBQUMsbUJBQW1CO1lBQy9CLENBQUM7WUFDRCxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQzVHLE9BQU87WUFDWCxDQUFDO1lBQ0QsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLElBQUksSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJO2dCQUFFLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBQ3ZDLElBQUksSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLO2dCQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1lBQzNDLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNO2dCQUFFLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDO1lBQy9DLElBQUksSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHO2dCQUFFLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsOERBQThEO1FBQzlELE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztRQUMzQixNQUFNLFNBQVMsR0FBRyxDQUFDLElBQVMsRUFBUSxFQUFFO1lBQ2xDLElBQUksS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDO2dCQUFFLE9BQU87WUFDOUIsTUFBTSxFQUFFLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQy9CLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQ3RDLElBQUksSUFBSSxDQUFDLElBQUk7b0JBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3JDLE9BQU87WUFDWCxDQUFDO1lBQ0QsS0FBSyxNQUFNLEtBQUssSUFBSSxlQUFlLENBQUMsSUFBSSxDQUFDO2dCQUFFLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNoRSxDQUFDLENBQUM7UUFDRixNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0IsSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUNSLEtBQUssTUFBTSxJQUFJLElBQUksZUFBZSxDQUFDLEtBQUssQ0FBQztnQkFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDL0QsQ0FBQztRQUVELElBQUksS0FBSyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2QsT0FBTztnQkFDSCxJQUFJLEVBQUUsQ0FBQztnQkFDUCxLQUFLLEVBQUUsQ0FBQztnQkFDUixNQUFNLEVBQUUsQ0FBQztnQkFDVCxHQUFHLEVBQUUsQ0FBQztnQkFDTixFQUFFLEVBQUUsQ0FBQztnQkFDTCxFQUFFLEVBQUUsQ0FBQztnQkFDTCxLQUFLLEVBQUUsQ0FBQztnQkFDUixNQUFNLEVBQUUsQ0FBQztnQkFDVCxLQUFLO2dCQUNMLEtBQUs7Z0JBQ0wsSUFBSSxFQUFFLDJDQUEyQzthQUNwRCxDQUFDO1FBQ04sQ0FBQztRQUVELE1BQU0sS0FBSyxHQUFHLEtBQUssR0FBRyxJQUFJLENBQUM7UUFDM0IsTUFBTSxNQUFNLEdBQUcsR0FBRyxHQUFHLE1BQU0sQ0FBQztRQUM1QixPQUFPO1lBQ0gsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUM7WUFDakIsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUM7WUFDbkIsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUM7WUFDckIsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUM7WUFDZixFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM3QixFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUMsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM3QixLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQztZQUNuQixNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQztZQUNyQixLQUFLO1lBQ0wsS0FBSztZQUNMLHlCQUF5QjtZQUN6QixNQUFNLEVBQUUsMEJBQTBCO1NBQ3JDLENBQUM7SUFDTixDQUFDLENBQUM7SUFFRiwwRUFBMEU7SUFDMUUscUJBQXFCO0lBQ3JCLDBFQUEwRTtJQUMxRSxFQUFFO0lBQ0YsdUNBQXVDO0lBQ3ZDLDBDQUEwQztJQUMxQyxFQUFFO0lBQ0YsbUJBQW1CO0lBQ25CLFlBQVk7SUFDWiw4RUFBOEU7SUFDOUUsNEVBQTRFO0lBQzVFLDREQUE0RDtJQUM1RCxFQUFFO0lBQ0YsNENBQTRDO0lBQzVDLDZDQUE2QztJQUM3QyxzQkFBc0I7SUFFdEIsNkJBQTZCO0lBQzdCLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQyxJQUFTLEVBQVUsRUFBRTtRQUMzQyxNQUFNLEVBQUUsR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDL0IsSUFBSSxDQUFDO1lBQ0QsSUFBSSxFQUFFLElBQUksT0FBTyxFQUFFLENBQUMsUUFBUSxLQUFLLFFBQVE7Z0JBQUUsT0FBTyxFQUFFLENBQUMsUUFBUSxDQUFDO1FBQ2xFLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDO0lBQ2IsQ0FBQyxDQUFDO0lBRUYscUNBQXFDO0lBQ3JDLE1BQU0sY0FBYyxHQUFHLENBQUMsSUFBNEIsRUFBRSxDQUFTLEVBQUUsQ0FBUyxFQUFXLEVBQUUsQ0FDbkYsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDO0lBRXhGLDJDQUEyQztJQUMzQyxNQUFNLHNCQUFzQixHQUFHLENBQUMsSUFBUyxFQUFzQyxFQUFFO1FBQzdFLE1BQU0sR0FBRyxHQUF1QyxFQUFFLENBQUM7UUFDbkQsTUFBTSxLQUFLLEdBQXlCO1lBQ2hDLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUM7WUFDckIsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQztZQUNuQixDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDO1lBQ3pCLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxRQUFRLENBQUM7WUFDekIsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQztTQUNwQixDQUFDO1FBQ0YsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN2QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDckIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3JCLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksT0FBTyxJQUFJLENBQUMsWUFBWSxLQUFLLFVBQVU7Z0JBQUUsU0FBUztZQUN4RSxJQUFJLElBQUksR0FBUSxJQUFJLENBQUM7WUFDckIsSUFBSSxDQUFDO2dCQUNELElBQUksR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ25DLENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsSUFBSSxHQUFHLElBQUksQ0FBQztZQUNoQixDQUFDO1lBQ0QsSUFBSSxJQUFJO2dCQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUN2QyxDQUFDO1FBQ0QsT0FBTyxHQUFHLENBQUM7SUFDZixDQUFDLENBQUM7SUFFRjs7Ozs7O09BTUc7SUFDSCxNQUFNLGFBQWEsR0FBRyxDQUFDLElBQVMsRUFBNkUsRUFBRTtRQUMzRyxNQUFNLE9BQU8sR0FBRyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM3QyxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDekMsTUFBTSxPQUFPLEdBQWEsRUFBRSxDQUFDO1FBQzdCLElBQUksT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUN2QixPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLE9BQU8sRUFBRSxDQUFDO1FBQ3hFLENBQUM7UUFDRCxLQUFLLE1BQU0sS0FBSyxJQUFJLE9BQU8sRUFBRSxDQUFDO1lBQzFCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7WUFDeEIsSUFBSSxLQUFLLEdBQUcsR0FBRyxDQUFDO1lBQ2hCLElBQUksQ0FBQztnQkFDRCxJQUFJLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxRQUFRO29CQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUM3RSxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLFFBQVE7WUFDWixDQUFDO1lBQ0QsSUFBSSxLQUFLLElBQUksQ0FBQztnQkFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsS0FBSyxDQUFDLElBQUksZ0JBQWdCLEVBQUUsT0FBTyxFQUFFLENBQUM7WUFDakcsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO2dCQUMxQixJQUFJLEtBQUssR0FBUSxJQUFJLENBQUM7Z0JBQ3RCLElBQUksQ0FBQztvQkFDRCxLQUFLLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQztnQkFDN0IsQ0FBQztnQkFBQyxNQUFNLENBQUM7b0JBQ0wsS0FBSyxHQUFHLElBQUksQ0FBQztnQkFDakIsQ0FBQztnQkFDRCxJQUFJLENBQUMsS0FBSztvQkFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLHVCQUF1QixFQUFFLE9BQU8sRUFBRSxDQUFDO1lBQzNGLENBQUM7WUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssT0FBTyxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssVUFBVSxFQUFFLENBQUM7Z0JBQ3RELElBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztnQkFDZCxJQUFJLENBQUM7b0JBQ0QsSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7Z0JBQzFELENBQUM7Z0JBQUMsTUFBTSxDQUFDO29CQUNMLElBQUksR0FBRyxFQUFFLENBQUM7Z0JBQ2QsQ0FBQztnQkFDRCxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssQ0FBQztvQkFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsS0FBSyxDQUFDLElBQUksZUFBZSxFQUFFLE9BQU8sRUFBRSxDQUFDO1lBQzNHLENBQUM7WUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssVUFBVSxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7Z0JBQ3JELE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxLQUFLLENBQUMsSUFBSSx1Q0FBdUMsQ0FBQyxDQUFDO1lBQ3ZFLENBQUM7UUFDTCxDQUFDO1FBQ0QsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxDQUFDO0lBQzdDLENBQUMsQ0FBQztJQUVGLHlDQUF5QztJQUN6QyxNQUFNLGNBQWMsR0FBRyxDQUFDLElBQVMsRUFBVSxFQUFFO1FBQ3pDLElBQUksT0FBTyxHQUFHLEdBQUcsQ0FBQztRQUNsQixJQUFJLE1BQU0sR0FBRyxJQUFJLENBQUM7UUFDbEIsT0FBTyxNQUFNLEVBQUUsQ0FBQztZQUNaLElBQUksQ0FBQztnQkFDRCxJQUFJLEVBQUUsQ0FBQyxTQUFTLElBQUksT0FBTyxNQUFNLENBQUMsWUFBWSxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUM1RCxNQUFNLEVBQUUsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQztvQkFDN0MsSUFBSSxFQUFFLElBQUksT0FBTyxFQUFFLENBQUMsT0FBTyxLQUFLLFFBQVE7d0JBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsR0FBRyxHQUFHLENBQUM7Z0JBQ3JGLENBQUM7WUFDTCxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLFFBQVE7WUFDWixDQUFDO1lBQ0QsTUFBTSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7UUFDM0IsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUMvQixDQUFDLENBQUM7SUFFRiwrQ0FBK0M7SUFDL0MsTUFBTSxlQUFlLEdBQUcsQ0FBQyxJQUFTLEVBQVksRUFBRTtRQUM1QyxNQUFNLEdBQUcsR0FBYSxFQUFFLENBQUM7UUFDekIsSUFBSSxNQUFNLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDdkMsT0FBTyxNQUFNLEVBQUUsQ0FBQztZQUNaLElBQUksQ0FBQztnQkFDRCxJQUFJLEVBQUUsQ0FBQyxJQUFJLElBQUksT0FBTyxNQUFNLENBQUMsWUFBWSxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUN2RCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDMUMsSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLGtCQUFrQixLQUFLLEtBQUs7d0JBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ2pGLENBQUM7WUFDTCxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLFFBQVE7WUFDWixDQUFDO1lBQ0QsTUFBTSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7UUFDM0IsQ0FBQztRQUNELE9BQU8sR0FBRyxDQUFDO0lBQ2YsQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQTZDRztJQUNILE9BQU8sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFTLEVBQUUsQ0FBUyxFQUFFLE9BQTZCLEVBQTJCLEVBQUU7UUFDNUYsTUFBTSxJQUFJLEdBQXdCLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDaEQsTUFBTSxLQUFLLEdBQUcsT0FBTyxJQUFJLENBQUMsS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO1FBQ25FLE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUMsRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDakQsSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLE9BQU8sRUFBRSxDQUFDO1lBQzFELE1BQU0sSUFBSSxLQUFLLENBQ1gsK0VBQStFLEtBQUssSUFBSSxDQUMzRixDQUFDO1FBQ04sQ0FBQztRQUNELE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNyQixNQUFNLEVBQUUsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7WUFDL0MsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzRixDQUFDO1FBRUQsTUFBTSxPQUFPLEdBQUcsWUFBWSxFQUFFLENBQUM7UUFDL0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNmLE1BQU0sSUFBSSxLQUFLLENBQ1gsZ0NBQWdDLE9BQU8sQ0FBQyxJQUFJLElBQUksTUFBTSxHQUFHO2dCQUNyRCxzQ0FBc0MsQ0FDN0MsQ0FBQztRQUNOLENBQUM7UUFDRCxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDO1FBQ3hCLE1BQU0sTUFBTSxHQUFHLGNBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNsQyxNQUFNLFNBQVMsR0FBRyxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQXdCLENBQUM7UUFDeEUsTUFBTSxJQUFJLEdBQUcsWUFBWSxFQUFFLENBQUM7UUFDNUIsTUFBTSxRQUFRLEdBQUcsT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3ZFLE1BQU0sU0FBUyxHQUFHLE9BQU8sSUFBSSxDQUFDLFNBQVMsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUMxRSxNQUFNLGNBQWMsR0FBSSxTQUFTLENBQUMsUUFBbUIsSUFBSSxDQUFDLENBQUM7UUFDM0QsTUFBTSxpQkFBaUIsR0FBSSxTQUFTLENBQUMsV0FBc0IsSUFBSSxDQUFDLENBQUM7UUFDakUsTUFBTSxHQUFHLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixHQUFHLGNBQWMsQ0FBQyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDekcsTUFBTSxTQUFTLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUssU0FBUyxDQUFDLFlBQXVCLElBQUksQ0FBQyxDQUFDO1FBRWpHLDBCQUEwQjtRQUMxQixJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUM7UUFDWixJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUM7UUFDWixJQUFJLFVBQVUsR0FBa0MsSUFBSSxDQUFDO1FBQ3JELElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQ2pCLElBQUksQ0FBQyxRQUFRLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDMUIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1RkFBdUYsQ0FBQyxDQUFDO1lBQzdHLENBQUM7WUFDRCxFQUFFLEdBQUcsRUFBRSxHQUFHLFFBQVEsQ0FBQztZQUNuQixFQUFFLEdBQUcsRUFBRSxHQUFHLFNBQVMsQ0FBQztRQUN4QixDQUFDO2FBQU0sSUFBSSxLQUFLLEtBQUssT0FBTyxFQUFFLENBQUM7WUFDM0IsTUFBTSxTQUFTLEdBQUcsZUFBZSxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNuRyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNsQixNQUFNLElBQUksS0FBSyxDQUFDLDhCQUE4QixTQUFTLENBQUMsSUFBSSxJQUFJLE1BQU0sR0FBRyxDQUFDLENBQUM7WUFDL0UsQ0FBQztZQUNELEVBQUUsR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUN0QixFQUFFLEdBQUcsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDdEIsVUFBVSxHQUFHLEVBQUUsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7UUFDbEQsQ0FBQztRQUVELG1EQUFtRDtRQUNuRCxJQUFJLENBQUMsVUFBVSxJQUFJLEdBQUcsR0FBRyxDQUFDLElBQUksU0FBUyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzFDLElBQUksQ0FBQztnQkFDRCxNQUFNLE1BQU0sR0FBRyxFQUFFLEdBQUcsQ0FBRSxTQUFTLENBQUMsSUFBZSxJQUFJLENBQUMsQ0FBQyxDQUFDO2dCQUN0RCxNQUFNLE1BQU0sR0FBRyxFQUFFLEdBQUcsQ0FBRSxTQUFTLENBQUMsR0FBYyxJQUFJLENBQUMsQ0FBQyxDQUFDO2dCQUNyRCxNQUFNLENBQUMsR0FBRyxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxFQUFFLFNBQVMsR0FBRyxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3BGLElBQUksQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsRUFBRSxDQUFDO29CQUMxRCxVQUFVLEdBQUcsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNwRCxDQUFDO1lBQ0wsQ0FBQztZQUFDLE1BQU0sQ0FBQztnQkFDTCxVQUFVLEdBQUcsSUFBSSxDQUFDLENBQUMsdUJBQXVCO1lBQzlDLENBQUM7UUFDTCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLElBQUksSUFBSSxZQUFZLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0MsSUFBSSxDQUFDLFFBQVE7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDJCQUEyQixDQUFDLENBQUM7UUFFNUQsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLFNBQXlFLENBQUM7UUFFdEcsMENBQTBDO1FBQzFDLE1BQU0sU0FBUyxHQUFHLElBQUksR0FBRyxFQUFlLENBQUM7UUFDekMsQ0FBQztZQUNHLElBQUksT0FBTyxHQUFHLENBQUMsQ0FBQztZQUNoQixNQUFNLFNBQVMsR0FBRyxDQUFDLENBQU0sRUFBUSxFQUFFO2dCQUMvQixTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQztnQkFDMUIsT0FBTyxJQUFJLENBQUMsQ0FBQztnQkFDYixNQUFNLElBQUksR0FBVSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUM1QyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBTSxFQUFFLENBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUNsRixLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUM3QyxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUs7b0JBQUUsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNoRCxDQUFDLENBQUM7WUFDRixTQUFTLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDeEIsQ0FBQztRQUVELGdFQUFnRTtRQUNoRSxNQUFNLGNBQWMsR0FBRyxDQUFDLElBQVMsRUFBaUMsRUFBRTtZQUNoRSxJQUFJLElBQXlCLENBQUM7WUFDOUIsSUFBSSxDQUFDO2dCQUNELElBQUksR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDN0IsQ0FBQztZQUFDLE1BQU0sQ0FBQztnQkFDTCxPQUFPLElBQUksQ0FBQztZQUNoQixDQUFDO1lBQ0QsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDekQsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ1gsSUFBSSxDQUFDO2dCQUNELE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7Z0JBQzlCLElBQUksRUFBRSxJQUFJLE9BQU8sRUFBRSxDQUFDLENBQUMsS0FBSyxRQUFRO29CQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQ2xELENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsdUJBQXVCO1lBQzNCLENBQUM7WUFDRCxNQUFNLFNBQVMsR0FBRyxlQUFlLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUU7Z0JBQy9DLEVBQUUsRUFBRSxJQUFJLENBQUMsRUFBRTtnQkFDWCxFQUFFLEVBQUUsSUFBSSxDQUFDLEVBQUU7Z0JBQ1gsRUFBRTtnQkFDRixLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUs7Z0JBQ2pCLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTTthQUN0QixDQUFDLENBQUM7WUFDSCxPQUFPLFNBQVMsQ0FBQyxJQUFJLENBQUM7UUFDMUIsQ0FBQyxDQUFDO1FBRUYsTUFBTSxJQUFJLEdBQW1DLEVBQUUsQ0FBQztRQUNoRCxNQUFNLFNBQVMsR0FBbUMsRUFBRSxDQUFDO1FBQ3JELE1BQU0sVUFBVSxHQUFtQyxFQUFFLENBQUM7UUFDdEQsTUFBTSxPQUFPLEdBQWEsRUFBRSxDQUFDO1FBQzdCLElBQUksY0FBYyxHQUFHLENBQUMsQ0FBQztRQUN2QixJQUFJLGFBQWEsR0FBRyxDQUFDLENBQUM7UUFFdEIsTUFBTSxTQUFTLEdBQUcsQ0FBQyxJQUFTLEVBQUUsVUFBa0IsRUFBRSxXQUFvQixFQUFRLEVBQUU7WUFDNUUsSUFBSSxDQUFDLElBQUk7Z0JBQUUsT0FBTztZQUNsQixNQUFNLFVBQVUsR0FBRyxXQUFXLElBQUksWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3JELE1BQU0sSUFBSSxHQUFHLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxHQUFHLFVBQVUsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDcEcsTUFBTSxFQUFFLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQy9CLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQ3RDLE1BQU0sT0FBTyxHQUFHLGNBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDckMsSUFBSSxPQUFPLElBQUksY0FBYyxDQUFDLE9BQU8sRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFDLEVBQUUsQ0FBQztvQkFDN0MsTUFBTSxHQUFHLEdBQTRCO3dCQUNqQyxJQUFJO3dCQUNKLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTt3QkFDZixJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7d0JBQ2YsSUFBSSxFQUFFLE9BQU87d0JBQ2IsSUFBSSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO3FCQUNuRCxDQUFDO29CQUNGLElBQUksVUFBVSxFQUFFLENBQUM7d0JBQ2IsYUFBYSxJQUFJLENBQUMsQ0FBQzt3QkFDbkIsSUFBSSxVQUFVLENBQUMsTUFBTSxHQUFHLENBQUM7NEJBQUUsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFDcEQsQ0FBQzt5QkFBTSxDQUFDO3dCQUNKLGNBQWMsSUFBSSxDQUFDLENBQUM7d0JBQ3BCLE1BQU0sTUFBTSxHQUFHLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQzt3QkFDbkMsTUFBTSxPQUFPLEdBQUcsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDO3dCQUNyQyxNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7d0JBQ3ZDOzs7OzsyQkFLRzt3QkFDSCxNQUFNLGlCQUFpQixHQUNuQixJQUFJLENBQUMsaUJBQWlCLEtBQUssU0FBUzs0QkFDaEMsQ0FBQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsS0FBSyxLQUFLOzRCQUNsQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUM7d0JBQ2hDLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7NEJBQzFCLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO2dDQUNyQixJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsS0FBSyxFQUFFLENBQUM7b0NBQzNCLEdBQUcsQ0FBQyxNQUFNLEdBQUcsZ0NBQWdDLENBQUM7b0NBQzlDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztvQ0FDMUIsU0FBUyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztnQ0FDeEIsQ0FBQzs0QkFDTCxDQUFDO2lDQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxJQUFJLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztnQ0FDekMsSUFBSSxTQUFTLENBQUMsTUFBTSxHQUFHLEtBQUssRUFBRSxDQUFDO29DQUMzQixHQUFHLENBQUMsTUFBTSxHQUFHLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLHFCQUFxQixDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO29DQUNsRSxHQUFHLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUM7b0NBQzFCLFNBQVMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7Z0NBQ3hCLENBQUM7NEJBQ0wsQ0FBQztpQ0FBTSxDQUFDO2dDQUNKLEdBQUcsQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztnQ0FDMUIsR0FBRyxDQUFDLE9BQU8sR0FBRyxPQUFPLENBQUM7Z0NBQ3RCLEdBQUcsQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO2dDQUN4QixHQUFHLENBQUMsUUFBUSxHQUFHLGdCQUFnQixDQUFDLElBQUksQ0FBQyxDQUFDO2dDQUN0QyxHQUFHLENBQUMsS0FBSyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dDQUMzRCxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dDQUNmLEtBQUssTUFBTSxNQUFNLElBQUksTUFBTSxDQUFDLE9BQU8sRUFBRSxDQUFDO29DQUNsQyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQzt3Q0FBRSxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2dDQUMxRCxDQUFDOzRCQUNMLENBQUM7d0JBQ0wsQ0FBQztvQkFDTCxDQUFDO2dCQUNMLENBQUM7WUFDTCxDQUFDO1lBQ0QsTUFBTSxJQUFJLEdBQVUsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNsRCxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUk7Z0JBQUUsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDakUsQ0FBQyxDQUFDO1FBQ0YsU0FBUyxDQUFDLFFBQVEsRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFL0IsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFFLENBQUMsQ0FBQyxLQUFnQixHQUFJLENBQUMsQ0FBQyxLQUFnQixDQUFDLENBQUM7UUFDL0QsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7UUFFakcsSUFBSSxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ2QsSUFBSSxPQUFPLEtBQUssZ0JBQWdCLEVBQUUsQ0FBQztZQUMvQixJQUFJO2dCQUNBLDhEQUE4RDtvQkFDOUQsMkNBQTJDLENBQUM7UUFDcEQsQ0FBQzthQUFNLElBQUksT0FBTyxLQUFLLE9BQU8sRUFBRSxDQUFDO1lBQzdCLElBQUksR0FBRyxzQ0FBc0MsQ0FBQztRQUNsRCxDQUFDO2FBQU0sSUFBSSxJQUFJLENBQUMsTUFBTSxHQUFHLEtBQUssRUFBRSxDQUFDO1lBQzdCLElBQUksR0FBRyxNQUFNLElBQUksQ0FBQyxNQUFNLGlCQUFpQixLQUFLLG1CQUFtQixDQUFDO1FBQ3RFLENBQUM7UUFFRCxPQUFPO1lBQ0gsQ0FBQyxFQUFFLEVBQUU7WUFDTCxDQUFDLEVBQUUsRUFBRTtZQUNMLEtBQUs7WUFDTCxPQUFPLEVBQUUsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxNQUFNLENBQUMsRUFBRSxDQUFDLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUU7WUFDcEYsTUFBTSxFQUFFLFNBQVM7WUFDakIsS0FBSyxFQUFFLFVBQVU7WUFDakIsSUFBSSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQztZQUMxQixHQUFHLEVBQUUsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUNyQyxXQUFXLEVBQUUsU0FBUyxDQUFDLE1BQU07WUFDN0IsU0FBUztZQUNULFVBQVU7WUFDVixPQUFPO1lBQ1AsT0FBTyxFQUFFLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFO1lBQzNELFNBQVMsRUFBRSxpRUFBaUU7WUFDNUUsT0FBTztZQUNQLElBQUk7U0FDUCxDQUFDO0lBQ04sQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQXVDRztJQUNILE9BQU8sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxNQUFZLEVBQUUsUUFBOEIsRUFBMkIsRUFBRTtRQUN6RixNQUFNLEVBQUUsR0FBd0IsUUFBUSxJQUFJLEVBQUUsQ0FBQztRQUMvQyxJQUFJLElBQUksR0FBUSxJQUFJLENBQUM7UUFDckIsSUFBSSxHQUFHLEdBQVEsSUFBSSxDQUFDO1FBQ3BCLElBQUksTUFBTSxJQUFJLE9BQU8sTUFBTSxDQUFDLFlBQVksS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUN0RCxJQUFJLEdBQUcsTUFBTSxDQUFDO1lBQ2QsSUFBSSxDQUFDO2dCQUNELEdBQUcsR0FBRyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQzFELENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsR0FBRyxHQUFHLElBQUksQ0FBQztZQUNmLENBQUM7WUFDRCxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7Z0JBQ1AsTUFBTSxJQUFJLEtBQUssQ0FDWCxxQkFBcUIsTUFBTSxDQUFDLElBQUksbUJBQW1CO29CQUMvQyxxR0FBcUcsQ0FDNUcsQ0FBQztZQUNOLENBQUM7UUFDTCxDQUFDO2FBQU0sSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDOUMsR0FBRyxHQUFHLE1BQU0sQ0FBQztRQUNqQixDQUFDO2FBQU0sQ0FBQztZQUNKLE1BQU0sSUFBSSxLQUFLLENBQ1gsMkRBQTJEO2dCQUN2RCxvREFBb0QsQ0FDM0QsQ0FBQztRQUNOLENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxDQUFDLEdBQVcsRUFBTyxFQUFFO1lBQzlCLElBQUksRUFBRSxDQUFDLEdBQUcsQ0FBQyxLQUFLLFNBQVM7Z0JBQUUsT0FBTyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDMUMsSUFBSSxHQUFHLEVBQUUsQ0FBQztnQkFDTixJQUFJLENBQUM7b0JBQ0QsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssU0FBUzt3QkFBRSxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDaEQsQ0FBQztnQkFBQyxNQUFNLENBQUM7b0JBQ0wsUUFBUTtnQkFDWixDQUFDO1lBQ0wsQ0FBQztZQUNELE9BQU8sU0FBUyxDQUFDO1FBQ3JCLENBQUMsQ0FBQztRQUVGLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDN0MsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUNmLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxTQUFTO1lBQ3RCLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO1lBQ2QsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxTQUFTO2dCQUM1QixDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQztnQkFDaEIsQ0FBQyxDQUFDLEVBQUUsQ0FDYixDQUFDO1FBQ0YsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3RGLE1BQU0sYUFBYSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM3RixNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxPQUFPLENBQUM7UUFDdEcsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDbEosTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUYsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFbEcsTUFBTSxjQUFjLEdBQUcsQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxlQUFlLENBQUMsQ0FBQztRQUNwRSxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztRQUNoRixJQUFJLFlBQVksR0FBRyxPQUFPLENBQUM7UUFDM0IsSUFBSSxPQUFPLFdBQVcsS0FBSyxRQUFRO1lBQUUsWUFBWSxHQUFHLGNBQWMsQ0FBQyxXQUFXLENBQUMsSUFBSSxPQUFPLENBQUM7YUFDdEYsSUFBSSxPQUFPLFdBQVcsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QyxNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDL0MsWUFBWSxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztRQUN4RSxDQUFDO1FBRUQsNERBQTREO1FBQzVELE1BQU0sS0FBSyxHQUFHLE1BQU0sSUFBSSxZQUFZLEtBQUssTUFBTSxDQUFDO1FBQ2hELE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFFbEMsd0NBQXdDO1FBQ3hDLE1BQU0sUUFBUSxHQUFHLENBQUMsRUFBVSxFQUF1RyxFQUFFO1lBQ2pJLE1BQU0sT0FBTyxHQUFHLGFBQWEsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ3ZELE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBUyxFQUFVLEVBQUU7Z0JBQy9CLE1BQU0sTUFBTSxHQUFHLGdCQUFnQixDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsVUFBVSxDQUFDLENBQUM7Z0JBQ25ELE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2dCQUMzQixPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUM7WUFDeEIsQ0FBQyxDQUFDO1lBQ0YsTUFBTSxLQUFLLEdBQWEsRUFBRSxDQUFDO1lBQzNCLEtBQUssTUFBTSxTQUFTLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUN2QyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQyxRQUFRLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQztvQkFDNUIsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztvQkFDdEIsU0FBUztnQkFDYixDQUFDO2dCQUNELElBQUksT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDakIsS0FBSyxNQUFNLEVBQUUsSUFBSSxTQUFTLEVBQUUsQ0FBQztvQkFDekIsTUFBTSxTQUFTLEdBQUcsT0FBTyxHQUFHLEVBQUUsQ0FBQztvQkFDL0IsSUFBSSxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsUUFBUSxFQUFFLENBQUM7d0JBQ25ELEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7d0JBQ3BCLE9BQU8sR0FBRyxFQUFFLENBQUM7b0JBQ2pCLENBQUM7eUJBQU0sQ0FBQzt3QkFDSixPQUFPLEdBQUcsU0FBUyxDQUFDO29CQUN4QixDQUFDO2dCQUNMLENBQUM7Z0JBQ0QsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN4QixDQUFDO1lBQ0QsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDL0MsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztZQUMzQixNQUFNLGFBQWEsR0FBRyxLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxHQUFHLE9BQU8sR0FBRyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7WUFDakcsT0FBTztnQkFDSCxLQUFLO2dCQUNMLE1BQU07Z0JBQ04sWUFBWSxFQUFFLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3pELGFBQWE7Z0JBQ2IsT0FBTzthQUNWLENBQUM7UUFDTixDQUFDLENBQUM7UUFFRiwrQ0FBK0M7UUFDL0MsTUFBTSxVQUFVLEdBQUcsQ0FBQyxPQUFlLEVBQVUsRUFBRSxDQUMzQyxPQUFPLEdBQUcsQ0FBQyxJQUFJLFNBQVMsR0FBRyxDQUFDO1lBQ3hCLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsR0FBRyxPQUFPLEdBQUcsQ0FBQyxzQkFBc0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQzdFLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFFWixNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEMsTUFBTSxXQUFXLEdBQUcsVUFBVSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM3QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUNwQyxNQUFNLFlBQVksR0FBRyxZQUFZLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQzdGLE1BQU0sV0FBVyxHQUFHLFlBQVksS0FBSyxPQUFPLElBQUksU0FBUyxHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDdEgsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLFlBQVksR0FBRyxRQUFRLENBQUMsQ0FBQztRQUM1RCxNQUFNLFNBQVMsR0FBRyxTQUFTLElBQUksR0FBRyxDQUFDLENBQUMsUUFBUTtRQUM1QyxNQUFNLFVBQVUsR0FBRyxTQUFTLElBQUksV0FBVyxDQUFDO1FBRTVDLElBQUksUUFBUSxHQUFrQixJQUFJLENBQUM7UUFDbkMsSUFBSSxZQUFZLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDNUIsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ1gsSUFBSSxFQUFFLEdBQUcsUUFBUSxDQUFDO1lBQ2xCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUMvQyxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQzFCLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDM0IsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sSUFBSSxVQUFVLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLElBQUksQ0FBQyxZQUFZLElBQUksUUFBUSxHQUFHLEdBQUc7b0JBQUUsRUFBRSxHQUFHLEdBQUcsQ0FBQzs7b0JBQzlGLEVBQUUsR0FBRyxHQUFHLENBQUM7WUFDbEIsQ0FBQztZQUNELFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7UUFDMUMsQ0FBQztRQUVELE1BQU0sT0FBTyxHQUFhLEVBQUUsQ0FBQztRQUM3QixJQUFJLFVBQVUsR0FBRyxNQUFNLENBQUM7UUFDeEIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7WUFDMUIsVUFBVSxHQUFHLEtBQUssQ0FBQztZQUNuQixPQUFPLENBQUMsSUFBSSxDQUFDLHlDQUF5QyxDQUFDLENBQUM7UUFDNUQsQ0FBQztRQUNELElBQUksUUFBUSxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsWUFBWSxHQUFHLFFBQVEsR0FBRyxJQUFJLElBQUksSUFBSSxDQUFDLFlBQVksSUFBSSxRQUFRLEVBQUUsQ0FBQztZQUN2RixJQUFJLFVBQVUsS0FBSyxNQUFNO2dCQUFFLFVBQVUsR0FBRyxZQUFZLENBQUM7WUFDckQsT0FBTyxDQUFDLElBQUksQ0FBQyxnQ0FBZ0MsQ0FBQyxDQUFDO1FBQ25ELENBQUM7UUFDRCxJQUFJLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDM0IsT0FBTyxDQUFDLElBQUksQ0FBQyxnREFBZ0QsQ0FBQyxDQUFDO1FBQ25FLENBQUM7UUFFRCxPQUFPO1lBQ0gsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU07WUFDM0MsSUFBSTtZQUNKLFFBQVE7WUFDUixVQUFVLEVBQUUsYUFBYTtZQUN6QixPQUFPLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7WUFDN0IsYUFBYSxFQUFFLGFBQWEsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQywrQ0FBK0M7WUFDdEcsSUFBSSxFQUFFLEtBQUs7WUFDWCxRQUFRLEVBQUUsWUFBWTtZQUN0QixVQUFVO1lBQ1YsR0FBRyxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQyxFQUFFO1lBQzNELEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNqRyxTQUFTO1lBQ1QsWUFBWSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDO1lBQ3ZDLGFBQWEsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztZQUN6QyxXQUFXO1lBQ1gsWUFBWTtZQUNaLGdCQUFnQixFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLFNBQVMsR0FBRyxZQUFZLENBQUM7WUFDdkQsV0FBVztZQUNYLElBQUksRUFBRSxTQUFTLElBQUksVUFBVTtZQUM3QixTQUFTO1lBQ1QsVUFBVTtZQUNWLFNBQVMsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDO1lBQzVCLFdBQVcsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLGFBQWEsR0FBRyxTQUFTLENBQUMsQ0FBQztZQUNoRSxRQUFRO1lBQ1IsUUFBUSxFQUFFLFlBQVksS0FBSyxlQUFlLENBQUMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUMxRixNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxVQUFVO1lBQ3JELFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsTUFBTTtZQUN4QyxVQUFVO1lBQ1YsT0FBTztZQUNQLE9BQU8sRUFBRSw4R0FBOEc7U0FDMUgsQ0FBQztJQUNOLENBQUMsQ0FBQztJQUVGLDBFQUEwRTtJQUMxRSx1QkFBdUI7SUFDdkIsMEVBQTBFO0lBRTFFLDRDQUE0QztJQUM1QyxNQUFNLHdCQUF3QixHQUE2QjtRQUN2RCxNQUFNLEVBQUUsQ0FBQyxhQUFhLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsTUFBTSxDQUFDO1FBQ2xHLEtBQUssRUFBRTtZQUNILFFBQVE7WUFDUixVQUFVO1lBQ1YsWUFBWTtZQUNaLFVBQVU7WUFDVixnQkFBZ0I7WUFDaEIsT0FBTztZQUNQLGlCQUFpQjtZQUNqQixlQUFlO1lBQ2YsUUFBUTtZQUNSLGVBQWU7WUFDZixZQUFZO1NBQ2Y7UUFDRCxRQUFRLEVBQUUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLFlBQVksRUFBRSxVQUFVLEVBQUUsaUJBQWlCLENBQUM7UUFDN0UsU0FBUyxFQUFFLENBQUMsU0FBUyxDQUFDO1FBQ3RCLE1BQU0sRUFBRTtZQUNKLFlBQVk7WUFDWixlQUFlO1lBQ2YsYUFBYTtZQUNiLGNBQWM7WUFDZCx5QkFBeUI7WUFDekIsdUJBQXVCO1lBQ3ZCLEtBQUs7WUFDTCxRQUFRO1lBQ1IsTUFBTTtZQUNOLE9BQU87WUFDUCxrQkFBa0I7WUFDbEIsZ0JBQWdCO1lBQ2hCLFdBQVc7U0FDZDtRQUNELE1BQU0sRUFBRSxDQUFDLFlBQVksRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLGNBQWMsRUFBRSxZQUFZLEVBQUUsZUFBZSxFQUFFLFdBQVcsQ0FBQztRQUNqSCxNQUFNLEVBQUU7WUFDSixNQUFNO1lBQ04sWUFBWTtZQUNaLFVBQVU7WUFDVixVQUFVO1lBQ1YsVUFBVTtZQUNWLGFBQWE7WUFDYixjQUFjO1lBQ2QsWUFBWTtZQUNaLGVBQWU7WUFDZixpQkFBaUI7U0FDcEI7S0FDSixDQUFDO0lBRUYsaURBQWlEO0lBQ2pELE1BQU0sU0FBUyxHQUFHLENBQUMsS0FBVSxFQUFpQixFQUFFO1FBQzVDLElBQUksQ0FBQztZQUNELElBQUksQ0FBQyxLQUFLO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBQ3hCLE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBTSxFQUFVLEVBQUUsQ0FDNUIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztpQkFDakQsUUFBUSxDQUFDLEVBQUUsQ0FBQztpQkFDWixRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQzFCLE9BQU8sSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDL0UsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7SUFDTCxDQUFDLENBQUM7SUFFRixxREFBcUQ7SUFDckQsTUFBTSxhQUFhLEdBQUcsQ0FBQyxLQUFVLEVBQVcsRUFBRTtRQUMxQyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN2RCxNQUFNLElBQUksR0FBRyxPQUFPLEtBQUssQ0FBQztRQUMxQixJQUFJLElBQUksS0FBSyxRQUFRLElBQUksSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLEtBQUssU0FBUztZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQy9FLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQztRQUMvRixDQUFDO1FBQ0QsSUFBSSxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDcEIsSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLEtBQUssUUFBUSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDbkUsT0FBTyxTQUFTLEtBQUssQ0FBQyxJQUFJLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDM0QsQ0FBQztZQUNELElBQUksT0FBTyxLQUFLLENBQUMsS0FBSyxLQUFLLFFBQVEsSUFBSSxPQUFPLEtBQUssQ0FBQyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ3RFLE9BQU8sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUM1RCxDQUFDO1lBQ0QsSUFBSSxPQUFPLEtBQUssQ0FBQyxDQUFDLEtBQUssUUFBUSxJQUFJLE9BQU8sS0FBSyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDN0QsT0FBTyxLQUFLLENBQUMsQ0FBQyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxLQUFLLFNBQVM7b0JBQ2pELENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtvQkFDekMsQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDMUUsQ0FBQztZQUNELE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxXQUFXLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxRQUFRLEdBQUcsQ0FBQztRQUM1RSxDQUFDO1FBQ0QsT0FBTyxJQUFJLElBQUksR0FBRyxDQUFDO0lBQ3ZCLENBQUMsQ0FBQztJQUVGLDJCQUEyQjtJQUMzQixNQUFNLGlCQUFpQixHQUFHLENBQUMsSUFBUyxFQUEyQixFQUFFO1FBQzdELE1BQU0sR0FBRyxHQUE0QixFQUFFLENBQUM7UUFDeEMsR0FBRyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxLQUFLLEtBQUssQ0FBQztRQUNuQyxHQUFHLENBQUMsUUFBUSxHQUFHLGFBQWEsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDNUMsR0FBRyxDQUFDLEtBQUssR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RDLElBQUksT0FBTyxJQUFJLENBQUMsS0FBSyxLQUFLLFFBQVE7WUFBRSxHQUFHLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDM0QsTUFBTSxFQUFFLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQy9CLElBQUksRUFBRSxFQUFFLENBQUM7WUFDTCxHQUFHLENBQUMsV0FBVyxHQUFHLGFBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNwQyxHQUFHLENBQUMsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxNQUFNLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDM0QsSUFBSSxDQUFDO2dCQUNELElBQUksT0FBTyxFQUFFLENBQUMsUUFBUSxLQUFLLFFBQVE7b0JBQUUsR0FBRyxDQUFDLFFBQVEsR0FBRyxFQUFFLENBQUMsUUFBUSxDQUFDO1lBQ3BFLENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsUUFBUTtZQUNaLENBQUM7UUFDTCxDQUFDO1FBQ0QsSUFBSSxDQUFDO1lBQ0QsSUFBSSxPQUFPLElBQUksQ0FBQyxlQUFlLEtBQUssVUFBVTtnQkFBRSxHQUFHLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztRQUM5RixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsUUFBUTtRQUNaLENBQUM7UUFFRCxJQUFJLElBQUksR0FBVSxFQUFFLENBQUM7UUFDckIsSUFBSSxDQUFDO1lBQ0QsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7Z0JBQUUsSUFBSSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUM7aUJBQ3RELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDO2dCQUFFLElBQUksR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDO1FBQ3RFLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ2QsQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztRQUMzQixLQUFLLE1BQU0sSUFBSSxJQUFJLElBQUksRUFBRSxDQUFDO1lBQ3RCLElBQUksQ0FBQyxJQUFJO2dCQUFFLFNBQVM7WUFDcEIsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsSUFBSSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLFdBQVcsQ0FBQyxDQUFDO1lBQ3BGLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDckIsTUFBTSxNQUFNLEdBQUcsd0JBQXdCLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDbEQsSUFBSSxDQUFDLE1BQU07Z0JBQUUsU0FBUztZQUN0Qjs7OztlQUlHO1lBQ0gsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLEVBQUUsQ0FBQztnQkFDdkIsSUFBSSxHQUFRLENBQUM7Z0JBQ2IsSUFBSSxDQUFDO29CQUNELEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ3BCLENBQUM7Z0JBQUMsTUFBTSxDQUFDO29CQUNMLFNBQVM7Z0JBQ2IsQ0FBQztnQkFDRCxJQUFJLEdBQUcsS0FBSyxTQUFTO29CQUFFLFNBQVM7Z0JBQ2hDLEdBQUcsQ0FBQyxHQUFHLFFBQVEsSUFBSSxHQUFHLEVBQUUsQ0FBQztvQkFDckIsR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsSUFBSSxPQUFPLEdBQUcsQ0FBQyxDQUFDLEtBQUssUUFBUSxJQUFJLE9BQU8sR0FBRyxDQUFDLENBQUMsS0FBSyxRQUFRO3dCQUNwRixDQUFDLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQzt3QkFDaEIsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNqQyxDQUFDO1FBQ0wsQ0FBQztRQUNELEdBQUcsQ0FBQyxVQUFVLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQzlCLE9BQU8sR0FBRyxDQUFDO0lBQ2YsQ0FBQyxDQUFDO0lBRUYsNkNBQTZDO0lBQzdDLE1BQU0sTUFBTSxHQUFHLENBQUMsSUFBWSxFQUFVLEVBQUU7UUFDcEMsSUFBSSxJQUFJLEdBQUcsVUFBVSxDQUFDO1FBQ3RCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUN0QyxJQUFJLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUMzQixJQUFJLEdBQUcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pHLENBQUM7UUFDRCxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUM5QyxDQUFDLENBQUM7SUFFRixvQ0FBb0M7SUFDcEMsTUFBTSxhQUFhLEdBQUcsQ0FBQyxRQUFnQixFQUFFLElBQVksRUFBMkMsRUFBRTtRQUM5RixNQUFNLFFBQVEsR0FBRyxjQUFjLEVBQUUsQ0FBQztRQUNsQyxJQUFJLENBQUMsUUFBUTtZQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxrQkFBa0IsRUFBRSxDQUFDO1FBQ2hFLElBQUksQ0FBQztZQUNELE1BQU0sR0FBRyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQzVDLElBQUksR0FBRztnQkFBRSxRQUFRLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUN6RCxRQUFRLENBQUMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ25ELE9BQU8sRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLENBQUM7UUFDOUIsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxRQUFRLE9BQU8sU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUM7UUFDL0UsQ0FBQztJQUNMLENBQUMsQ0FBQztJQUVGOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQWdDRztJQUNILE9BQU8sQ0FBQyxZQUFZLEdBQUcsQ0FBQyxJQUFVLEVBQUUsT0FBNkIsRUFBMkIsRUFBRTtRQUMxRixNQUFNLElBQUksR0FBd0IsT0FBTyxJQUFJLEVBQUUsQ0FBQztRQUNoRCxNQUFNLEtBQUssR0FDUCxPQUFPLElBQUksQ0FBQyxLQUFLLEtBQUssUUFBUSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsYUFBYSxDQUFDLElBQUksR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUMvRyxNQUFNLFFBQVEsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzlELE1BQU0sS0FBSyxHQUFHLElBQUksSUFBSSxZQUFZLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdkMsSUFBSSxDQUFDLEtBQUs7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlDQUF5QyxDQUFDLENBQUM7UUFFdkUsTUFBTSxLQUFLLEdBQTRCLEVBQUUsQ0FBQztRQUMxQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ2xELElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztRQUNkLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztRQUNsQixNQUFNLEtBQUssR0FBRyxDQUFDLElBQVMsRUFBRSxJQUFZLEVBQVEsRUFBRTtZQUM1QyxJQUFJLEtBQUssSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDcEIsU0FBUyxJQUFJLENBQUMsQ0FBQztnQkFDZixPQUFPO1lBQ1gsQ0FBQztZQUNELEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN0QyxLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsTUFBTSxJQUFJLEdBQVUsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNsRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBTSxFQUFFLENBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQ2xGLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDN0MsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztnQkFDdkI7Ozs7O21CQUtHO2dCQUNILElBQUksQ0FBQyxhQUFhLElBQUksWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7b0JBQUUsU0FBUztnQkFDckQsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ2pDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ25ELENBQUM7UUFDTCxDQUFDLENBQUM7UUFDRixLQUFLLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBRWxCLE1BQU0sSUFBSSxHQUFHLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLE9BQU8sQ0FBQyxFQUFFLEVBQUUsRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxFQUFFLEtBQUssRUFBRSxDQUFDO1FBQzFGLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbEM7Ozs7Ozs7V0FPRztRQUNILE1BQU0sTUFBTSxHQUFHLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUUxSCxtQkFBbUI7UUFDbkIsYUFBYSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFDakMsT0FBTyxhQUFhLENBQUMsSUFBSSxHQUFHLGFBQWEsRUFBRSxDQUFDO1lBQ3hDLE1BQU0sTUFBTSxHQUFHLGFBQWEsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUMzQyxJQUFJLE1BQU0sQ0FBQyxJQUFJO2dCQUFFLE1BQU07WUFDdkIsYUFBYSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQztRQUVELElBQUksS0FBSyxHQUFrQixJQUFJLENBQUM7UUFDaEMsSUFBSSxTQUE2QixDQUFDO1FBQ2xDLElBQUksT0FBTyxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUM7WUFDeEQsTUFBTSxPQUFPLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDbkYsS0FBSyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDckIsU0FBUyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7UUFDOUIsQ0FBQztRQUVELE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztRQUMzQixJQUFJLFNBQVMsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUNoQixLQUFLLENBQUMsSUFBSSxDQUNOLGtCQUFrQixRQUFRLHVDQUF1QyxDQUNwRSxDQUFDO1FBQ04sQ0FBQztRQUNELEtBQUssQ0FBQyxJQUFJLENBQUMsdURBQXVELENBQUMsQ0FBQztRQUNwRSxLQUFLLENBQUMsSUFBSSxDQUFDLG1DQUFtQyxDQUFDLENBQUM7UUFFaEQsT0FBTztZQUNILEtBQUs7WUFDTCxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDZixTQUFTLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsTUFBTTtZQUNsQixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7WUFDakIsRUFBRSxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQ1gsS0FBSztZQUNMLFNBQVM7WUFDVCxTQUFTO1lBQ1QsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQztTQUN4QixDQUFDO0lBQ04sQ0FBQyxDQUFDO0lBRUY7Ozs7Ozs7Ozs7Ozs7O09BY0c7SUFDSCxPQUFPLENBQUMsUUFBUSxHQUFHLENBQ2YsTUFBWSxFQUNaLEtBQVcsRUFDWCxPQUE2QixFQUNOLEVBQUU7UUFDekIsTUFBTSxJQUFJLEdBQXdCLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDaEQsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQztRQUNuRCxNQUFNLFdBQVcsR0FBRyxDQUFDLEdBQVEsRUFBRSxJQUFZLEVBQXVCLEVBQUU7WUFDaEUsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDMUIsTUFBTSxLQUFLLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDckMsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO29CQUNULE1BQU0sSUFBSSxLQUFLLENBQ1gsa0JBQWtCLEdBQUcsU0FBUyxJQUFJLFNBQzlCLEtBQUssQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLFNBQ25ELG9DQUFvQyxHQUFHLFdBQVcsQ0FDckQsQ0FBQztnQkFDTixDQUFDO2dCQUNELE9BQU8sS0FBNEIsQ0FBQztZQUN4QyxDQUFDO1lBQ0QsSUFBSSxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ2pDLE1BQU0sSUFBSSxHQUFJLEdBQTJCLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQztnQkFDdEQsSUFBSSxJQUFJLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxJQUFLLElBQTRCLENBQUMsS0FBSyxFQUFFLENBQUM7b0JBQzFFLE9BQU8sR0FBMEIsQ0FBQztnQkFDdEMsQ0FBQztZQUNMLENBQUM7WUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLFlBQVksSUFBSSxrREFBa0QsQ0FBQyxDQUFDO1FBQ3hGLENBQUMsQ0FBQztRQUVGLE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDNUMsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsQ0FBQztRQUMxQyxNQUFNLE1BQU0sR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUF3QixDQUFDO1FBQ3BGLE1BQU0sTUFBTSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQXdCLENBQUM7UUFFcEYsTUFBTSxPQUFPLEdBQW1DLEVBQUUsQ0FBQztRQUNuRCxNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7UUFDM0IsTUFBTSxPQUFPLEdBQWEsRUFBRSxDQUFDO1FBQzdCLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztRQUVsQixLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUNwQyxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLEVBQUUsQ0FBQztnQkFDbkIsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDaEIsU0FBUztZQUNiLENBQUM7WUFDRCxNQUFNLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQzVCLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDNUIsTUFBTSxLQUFLLEdBQTRCLEVBQUUsQ0FBQztZQUMxQyxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBUyxDQUFDLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3JFLEtBQUssTUFBTSxJQUFJLElBQUksSUFBSSxFQUFFLENBQUM7Z0JBQ3RCLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ25DLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ25DLElBQUksRUFBRSxLQUFLLEVBQUU7b0JBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQzlILENBQUM7WUFDRCxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUM7Z0JBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQzs7Z0JBQ2pFLFNBQVMsSUFBSSxDQUFDLENBQUM7UUFDeEIsQ0FBQztRQUNELEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7WUFBRSxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDO2dCQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFL0UsTUFBTSxNQUFNLEdBQUc7WUFDWCxNQUFNLEVBQUUsS0FBSyxDQUFDLEtBQUssSUFBSSxVQUFVO1lBQ2pDLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxJQUFJLFVBQVU7WUFDaEMsTUFBTSxFQUFFO2dCQUNKLFdBQVcsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU07Z0JBQ3ZDLFVBQVUsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU07Z0JBQ3RDLE9BQU8sRUFBRSxPQUFPLENBQUMsTUFBTTtnQkFDdkIsS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNO2dCQUNuQixPQUFPLEVBQUUsT0FBTyxDQUFDLE1BQU07Z0JBQ3ZCLFNBQVM7YUFDWjtZQUNELE9BQU87WUFDUCxLQUFLO1lBQ0wsT0FBTztTQUNWLENBQUM7UUFFRixJQUFJLEtBQUssR0FBa0IsSUFBSSxDQUFDO1FBQ2hDLElBQUksU0FBNkIsQ0FBQztRQUNsQyxJQUFJLE9BQU8sSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQ3hELE1BQU0sT0FBTyxHQUFHLGFBQWEsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ25GLEtBQUssR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDO1lBQ3JCLFNBQVMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQzlCLENBQUM7UUFFRCxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyx5QkFBeUIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM1RSxNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7UUFDM0IsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3JFLEtBQUssQ0FBQyxJQUFJLENBQUMsbURBQW1ELENBQUMsQ0FBQztRQUNwRSxDQUFDO1FBQ0QsSUFBSSxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzFCLEtBQUssQ0FBQyxJQUFJLENBQ04sWUFBWSxZQUFZLENBQUMsTUFBTSxhQUFhLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQ25HLENBQUM7UUFDTixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLE1BQU0sR0FBRyxLQUFLLElBQUksS0FBSyxDQUFDLE1BQU0sR0FBRyxLQUFLLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDM0YsT0FBTztZQUNILE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTTtZQUNyQixLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUs7WUFDbkIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNO1lBQ3JCLE9BQU8sRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUM7WUFDaEMsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQztZQUM1QixPQUFPLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDO1lBQ2hDLFlBQVk7WUFDWixTQUFTO1lBQ1QsS0FBSztZQUNMLFNBQVM7WUFDVCxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFdBQVcsS0FBSyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7U0FDNUYsQ0FBQztJQUNOLENBQUMsQ0FBQztJQUVGLGdEQUFnRDtJQUNoRCxPQUFPLENBQUMsV0FBVyxHQUFHLEdBQWEsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDbEUsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztBQUM5QixDQUFDO0FBc0JELFNBQVMsbUJBQW1CLENBQ3hCLElBQXFCLEVBQ3JCLFNBQWlCLEVBQ2pCLE9BQWUsRUFDZixZQUFvQjtJQUVwQixJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUM7SUFDdEIsTUFBTSxTQUFTLEdBQUcsQ0FBQyxLQUFjLEVBQVUsRUFBRTs7UUFDekMsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1lBQUUsT0FBTyxLQUFLLENBQUM7UUFDNUMsSUFBSSxDQUFDO1lBQ0QsT0FBTyxNQUFBLElBQUksQ0FBQyxTQUFTLENBQ2pCLEtBQUssRUFDTCxDQUFDLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRTtnQkFDTixJQUFJLE9BQU8sQ0FBQyxLQUFLLFVBQVU7b0JBQUUsT0FBTyxhQUFhLENBQUMsQ0FBQyxJQUFJLElBQUksV0FBVyxHQUFHLENBQUM7Z0JBQzFFLElBQUksT0FBTyxDQUFDLEtBQUssUUFBUTtvQkFBRSxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUM7Z0JBQzFDLE9BQU8sQ0FBQyxDQUFDO1lBQ2IsQ0FBQyxFQUNELENBQUMsQ0FDSixtQ0FBSSxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkIsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3pCLENBQUM7SUFDTCxDQUFDLENBQUM7SUFDRixNQUFNLElBQUksR0FBRyxDQUFDLEtBQWEsRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLEtBQWdCLEVBQUUsRUFBRTtRQUNwRCxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksT0FBTyxFQUFFLENBQUM7WUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztZQUNqQixPQUFPO1FBQ1gsQ0FBQztRQUNELElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFDLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxZQUFZO1lBQUUsSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLEdBQUcsQ0FBQztRQUN6RSxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFNBQVMsRUFBRSxDQUFDLENBQUM7SUFDN0QsQ0FBQyxDQUFDO0lBQ0YsT0FBTztRQUNILE9BQU8sRUFBRTtZQUNMLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDO1lBQ2hCLElBQUksRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDO1lBQ2xCLElBQUksRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQ3BCLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQ3BCLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQ3BCLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDO1NBQ25CO1FBQ0QsWUFBWSxFQUFFLEdBQUcsRUFBRSxDQUFDLFNBQVM7S0FDaEMsQ0FBQztBQUNOLENBQUM7QUFFRCw4RUFBOEU7QUFDOUUsU0FBUztBQUNULDhFQUE4RTtBQUU5RSxJQUFJLFFBQVEsR0FBUSxJQUFJLENBQUM7QUFDekIsSUFBSSxhQUFhLEdBQUcsS0FBSyxDQUFDO0FBRTFCLHNEQUFzRDtBQUN0RCxTQUFTLFdBQVc7SUFDaEIsSUFBSSxRQUFRO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDOUIsSUFBSSxhQUFhO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDL0IsSUFBSSxDQUFDO1FBQ0QsOERBQThEO1FBQzlELE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUMxQixJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsQ0FBQyxnQkFBZ0IsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNwRCxRQUFRLEdBQUcsR0FBRyxDQUFDO1lBQ2YsT0FBTyxHQUFHLENBQUM7UUFDZixDQUFDO1FBQ0QsYUFBYSxHQUFHLElBQUksQ0FBQztRQUNyQixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsYUFBYSxHQUFHLElBQUksQ0FBQztRQUNyQixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLGlCQUFpQixHQUFHLG1CQUFtQixDQUFDO0FBRTlDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTBCRztBQUNILFNBQVMsZ0JBQWdCLENBQUMsT0FBZ0MsRUFBRSxJQUFZO0lBQ3BFLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbkMsa0RBQWtEO0lBQ2xELHFEQUFxRDtJQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLEdBQUcsSUFBSSxlQUFlLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7SUFDM0YsT0FBTyw4Q0FBOEMsaUJBQWlCLEtBQUssWUFBWSxNQUFNLElBQUksU0FBUyxDQUFDO0FBQy9HLENBQUM7QUFJRCxzREFBc0Q7QUFDdEQsS0FBSyxVQUFVLHNCQUFzQixDQUNqQyxLQUFVLEVBQ1YsT0FBZ0MsRUFDaEMsSUFBWSxFQUNaLFNBQWlCLEVBQ2pCLE1BQWdCLEVBQ2hCLEtBQXFDO0lBRXJDLE1BQU0sTUFBTSxHQUFHLFVBQWdELENBQUM7SUFDaEUsTUFBTSxXQUFXLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO0lBQ3hGLE1BQU0sYUFBYSxHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztJQUUxRSxNQUFNLE9BQU8sR0FBRyxHQUFTLEVBQUU7UUFDdkIsSUFBSSxDQUFDO1lBQ0QsSUFBSSxXQUFXO2dCQUFFLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLGFBQWEsQ0FBQzs7Z0JBQ3RELE9BQU8sTUFBTSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDMUMsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLHdCQUF3QjtRQUM1QixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsSUFBSSxLQUFnRCxDQUFDO0lBQ3JELElBQUksQ0FBQztRQUNELE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLE9BQU8sQ0FBQztRQUNwQyxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQ2hFLFFBQVEsRUFBRSxtQkFBbUI7WUFDN0IsT0FBTyxFQUFFLFNBQVM7WUFDbEIsYUFBYSxFQUFFLElBQUk7U0FDdEIsQ0FBQyxDQUFDO1FBRUgsK0JBQStCO1FBQy9CLHdDQUF3QztRQUN4QyxPQUFPLEVBQUUsQ0FBQztRQUVWLE1BQU0sTUFBTSxHQUFHLE1BQU0sT0FBTyxDQUFDLElBQUksQ0FBQztZQUM5QixPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQztZQUNwQixJQUFJLE9BQU8sQ0FBQyxDQUFDLFFBQVEsRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDN0IsS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7WUFDekUsQ0FBQyxDQUFDO1NBQ0wsQ0FBQyxDQUFDO1FBQ0gsT0FBTyxNQUFNLENBQUMsRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxpQkFBaUIsRUFBRSxLQUFLLENBQUMsaUJBQWlCLEVBQUUsQ0FBQyxDQUFDO0lBQ3BGLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsT0FBTyxNQUFNLENBQUM7WUFDVixFQUFFLEVBQUUsS0FBSztZQUNULEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDO1lBQ3JCLFFBQVEsRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDO1lBQ3hCLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxpQkFBaUI7U0FDN0MsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztZQUFTLENBQUM7UUFDUCxJQUFJLEtBQUs7WUFBRSxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDL0IsT0FBTyxFQUFFLENBQUM7SUFDZCxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsS0FBSyxVQUFVLGlCQUFpQixDQUM1QixPQUFnQyxFQUNoQyxJQUFZLEVBQ1osU0FBaUIsRUFDakIsTUFBZ0IsRUFDaEIsS0FBcUM7SUFFckMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNuQyxNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUU1QyxJQUFJLEVBQXFDLENBQUM7SUFDMUMsSUFBSSxDQUFDO1FBQ0QsRUFBRSxHQUFHLElBQUksUUFBUSxDQUFDLEdBQUcsS0FBSyxFQUFFLDBCQUEwQixJQUFJLFNBQVMsQ0FBYyxDQUFDO0lBQ3RGLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsT0FBTyxNQUFNLENBQUMsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFFRCxJQUFJLEtBQWdELENBQUM7SUFDckQsSUFBSSxDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxPQUFPLENBQUMsSUFBSSxDQUFDO1lBQzlCLE9BQU8sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUM7WUFDOUIsSUFBSSxPQUFPLENBQUMsQ0FBQyxRQUFRLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQzdCLEtBQUssR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ3pFLENBQUMsQ0FBQztTQUNMLENBQUMsQ0FBQztRQUNILE9BQU8sTUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQixFQUFFLENBQUMsQ0FBQztJQUNwRixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sTUFBTSxDQUFDO1lBQ1YsRUFBRSxFQUFFLEtBQUs7WUFDVCxLQUFLLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQztZQUNyQixRQUFRLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQztZQUN4QixpQkFBaUIsRUFBRSxLQUFLLENBQUMsaUJBQWlCO1NBQzdDLENBQUMsQ0FBQztJQUNQLENBQUM7WUFBUyxDQUFDO1FBQ1AsSUFBSSxLQUFLO1lBQUUsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ25DLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLGdCQUFnQixDQUMzQixPQUF1QixFQUN2QixLQUFLLEdBQUcsQ0FBQztJQUVULE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUM3QixNQUFNLElBQUksR0FBb0IsRUFBRSxDQUFDO0lBQ2pDLE1BQU0sSUFBSSxHQUFHLE9BQU8sT0FBTyxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNsRSxNQUFNLE9BQU8sR0FBRyxPQUFPLE9BQU8sQ0FBQyxPQUFPLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7SUFDNUUsTUFBTSxZQUFZLEdBQUcsT0FBTyxPQUFPLENBQUMsWUFBWSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQzVGLE1BQU0sU0FBUyxHQUFHLE9BQU8sT0FBTyxDQUFDLFNBQVMsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztJQUVwRixNQUFNLEVBQUUsT0FBTyxFQUFFLGVBQWUsRUFBRSxZQUFZLEVBQUUsR0FBRyxtQkFBbUIsQ0FDbEUsSUFBSSxFQUNKLFNBQVMsRUFDVCxPQUFPLEVBQ1AsWUFBWSxDQUNmLENBQUM7SUFFRixNQUFNLE1BQU0sR0FBRyxDQUFDLEtBQThCLEVBQTJCLEVBQUUsQ0FBQyxDQUFDO1FBQ3pFLElBQUk7UUFDSixhQUFhLEVBQUUsWUFBWSxFQUFFO1FBQzdCLFVBQVUsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsU0FBUztRQUNsQyxHQUFHLEtBQUs7S0FDWCxDQUFDLENBQUM7SUFFSCxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUM7UUFDZixPQUFPLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2pGLENBQUM7SUFFRCxJQUFJLEVBQU8sQ0FBQztJQUNaLElBQUksQ0FBQztRQUNELEVBQUUsR0FBRyxLQUFLLEVBQUUsQ0FBQztJQUNqQixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sTUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN4RCxDQUFDO0lBRUQsTUFBTSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsR0FBRyxXQUFXLENBQUMsRUFBRSxFQUFFLEVBQUUsV0FBVyxFQUFFLE9BQU8sQ0FBQyxXQUFXLEVBQUUsQ0FBQyxDQUFDO0lBQ2pGLE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUUvQix5RUFBeUU7SUFDekUsMkNBQTJDO0lBQzNDLElBQUksYUFBc0MsQ0FBQztJQUMzQyxJQUFJLENBQUM7UUFDRCxNQUFNLE9BQU8sR0FBRyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ25DLGFBQWEsR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUM7WUFDdkMsV0FBVyxFQUFFLGtCQUFrQixFQUFFO1lBQ2pDLE9BQU8sRUFBRSxPQUFPO1lBQ2hCLGdCQUFnQixFQUFFLFNBQVM7WUFDM0IsMkNBQTJDO1lBQzNDLGlDQUFpQztZQUNqQyxTQUFTLEVBQUUsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUNsQixVQUFrQixFQUNsQixVQUFtQyxFQUNuQyxlQUF1QixFQUN6QixFQUFFO2dCQUNBLE1BQU0sTUFBTSxHQUFHLE1BQU0sZ0JBQWdCLENBQ2pDO29CQUNJLElBQUksRUFBRSxVQUFVO29CQUNoQixJQUFJLEVBQUUsVUFBVTtvQkFDaEIsMkNBQTJDO29CQUMzQyxzQ0FBc0M7b0JBQ3RDLHdCQUF3QjtvQkFDeEIsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsZUFBZSxFQUFFLFNBQVMsQ0FBQztvQkFDL0MsT0FBTztvQkFDUCxZQUFZO2lCQUNmLEVBQ0QsS0FBSyxHQUFHLENBQUMsQ0FDWixDQUFDO2dCQUNGLHdDQUF3QztnQkFDeEMsSUFBSSxNQUFNLENBQUMsaUJBQWlCO29CQUFFLEtBQUssQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7Z0JBQzdELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBRSxNQUFNLENBQUMsSUFBd0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUN0RixPQUFPO29CQUNILEVBQUUsRUFBRSxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztvQkFDdEIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNO29CQUNyQixLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUs7b0JBQ25CLElBQUksRUFDQSxVQUFVLENBQUMsTUFBTSxHQUFHLENBQUM7d0JBQ2pCLENBQUMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxJQUFJLEtBQUssQ0FBQyxLQUFLLEtBQUssS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO3dCQUM3RCxDQUFDLENBQUMsU0FBUztvQkFDbkIsVUFBVSxFQUFFLE9BQU8sTUFBTSxDQUFDLFVBQVUsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLFNBQVM7b0JBQ2pGLFFBQVEsRUFBRSxPQUFPLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQztpQkFDckMsQ0FBQztZQUNOLENBQUM7U0FDSixDQUFDLENBQUMsT0FBTyxDQUFDO0lBQ2YsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDWCxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDO1FBQ3ZDLE1BQU0sSUFBSSxHQUFHLEdBQTRCLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUM1RSxhQUFhLEdBQUc7WUFDWixXQUFXLEVBQUUsSUFBSTtZQUNqQixVQUFVLEVBQUUsSUFBSTtZQUNoQixVQUFVLEVBQUUsSUFBSTtZQUNoQixTQUFTLEVBQUUsSUFBSTtZQUNmLFlBQVksRUFBRSxJQUFJO1NBQ3JCLENBQUM7SUFDTixDQUFDO0lBRUQsTUFBTSxPQUFPLEdBQTRCO1FBQ3JDLEVBQUU7UUFDRixLQUFLLEVBQUUsRUFBRTtRQUNULE1BQU07UUFDTixRQUFRLEVBQUUsRUFBRSxDQUFDLFFBQVE7UUFDckIsS0FBSztRQUNMLEVBQUUsRUFBRSxFQUFFLENBQUMsRUFBRTtRQUNULElBQUksRUFBRSxFQUFFLENBQUMsSUFBSTtRQUNiLElBQUksRUFBRSxPQUFPLENBQUMsSUFBSSxJQUFJLE9BQU8sT0FBTyxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUU7UUFDMUUsT0FBTyxFQUFFLGVBQWU7UUFDeEIsR0FBRyxPQUFPO1FBQ1YsR0FBRyxhQUFhO0tBQ25CLENBQUM7SUFFRiwwREFBMEQ7SUFDMUQsc0JBQXNCO0lBQ3RCLE1BQU0sS0FBSyxHQUFHLFdBQVcsRUFBRSxDQUFDO0lBQzVCLElBQUksS0FBSyxFQUFFLENBQUM7UUFDUixPQUFPLHNCQUFzQixDQUFDLEtBQUssRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDbEYsQ0FBQztJQUNELE9BQU8saUJBQWlCLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBQ3RFLENBQUM7QUFZRCwyQkFBMkI7QUFDM0IsU0FBUyxhQUFhLENBQUMsRUFBTyxFQUFFLEdBQVEsRUFBRSxRQUFhLEVBQUUsU0FBaUIsRUFBRSxLQUFhO0lBQ3JGLE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztJQUMzQixNQUFNLEtBQUssR0FBRyxrQkFBa0IsQ0FBQyxRQUFRLElBQUksRUFBRSxXQUFXLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUNuRSxJQUFJLFVBQVUsR0FBRyxFQUFFLENBQUM7SUFDcEIsSUFBSSxDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDcEQsSUFBSSxNQUFNLElBQUksTUFBTSxDQUFDLFdBQVcsSUFBSSxNQUFNLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQzFELFVBQVUsR0FBRyxNQUFNLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQztRQUN6QyxDQUFDO0lBQ0wsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLFVBQVUsR0FBRyxFQUFFLENBQUM7SUFDcEIsQ0FBQztJQUVELEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxTQUFTLEdBQUcsVUFBVSxDQUFDLENBQUMsQ0FBQyxhQUFhLFVBQVUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQzVFLElBQUksUUFBUSxFQUFFLENBQUM7UUFDWCxLQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQztJQUM1RSxDQUFDO1NBQU0sQ0FBQztRQUNKLEtBQUssQ0FBQyxJQUFJLENBQUMsK0JBQStCLENBQUMsQ0FBQztJQUNoRCxDQUFDO0lBQ0QsS0FBSyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsU0FBUyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFFM0QsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDcEMsS0FBSyxNQUFNLEdBQUcsSUFBSSxLQUFLLEVBQUUsQ0FBQztRQUN0QixJQUFJLFFBQVEsR0FBRyxLQUFLLENBQUM7UUFDckIsSUFBSSxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ2pCLElBQUksUUFBUSxFQUFFLENBQUM7WUFDWCxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3JDLElBQUksSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDO2dCQUNWLFFBQVEsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUNuQyxPQUFPLEdBQUcsQ0FBQyxHQUFHLEVBQUU7b0JBQ1osTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztvQkFDckIsSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsS0FBSyxTQUFTO3dCQUFFLE9BQU8sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUNwRCxJQUFJLE9BQU8sQ0FBQyxLQUFLLFFBQVEsRUFBRSxDQUFDO3dCQUN4QixJQUFJLENBQUM7NEJBQ0QsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUM3QixDQUFDO3dCQUFDLE1BQU0sQ0FBQzs0QkFDTCxPQUFPLFVBQVUsQ0FBQzt3QkFDdEIsQ0FBQztvQkFDTCxDQUFDO29CQUNELE9BQU8sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUNyQixDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNMLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxFQUFFO29CQUFFLE9BQU8sR0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUM7WUFDbEUsQ0FBQztRQUNMLENBQUM7UUFDRCxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sR0FBRyxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLGFBQWEsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDbkYsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDOUIsS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLEtBQUssQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sTUFBTSxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUNELEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFFaEIsdUJBQXVCO0lBQ3ZCLE1BQU0sT0FBTyxHQUFhLEVBQUUsQ0FBQztJQUM3QixJQUFJLENBQUM7UUFDRCxLQUFLLE1BQU0sSUFBSSxJQUFJLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUMzRCxJQUFJLElBQUksS0FBSyxhQUFhLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7Z0JBQUUsU0FBUztZQUM3RCxJQUFJLElBQUksR0FBRyxLQUFLLENBQUM7WUFDakIsSUFBSSxDQUFDO2dCQUNELElBQUksR0FBRyxPQUFPLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLEtBQUssVUFBVSxDQUFDO1lBQ3JELENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsSUFBSSxHQUFHLEtBQUssQ0FBQztZQUNqQixDQUFDO1lBQ0QsSUFBSSxJQUFJO2dCQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDakMsQ0FBQztJQUNMLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxRQUFRO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNyQixLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2YsS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDN0QsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM1QixDQUFDO0FBRUQsc0NBQXNDO0FBQ3RDLFNBQVMsYUFBYSxDQUFDLEVBQU8sRUFBRSxLQUFhO0lBQ3pDLE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztJQUMzQixJQUFJLENBQUM7UUFDRCxLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztZQUNoQyxJQUFJLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksT0FBTyxFQUFFLENBQUMsR0FBRyxDQUFDLEtBQUssVUFBVTtnQkFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzdFLENBQUM7SUFDTCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsUUFBUTtJQUNaLENBQUM7SUFDRCxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUM7QUFDakUsQ0FBQztBQUVELDJDQUEyQztBQUMzQyxTQUFTLGVBQWUsQ0FBQyxFQUFPLEVBQUUsS0FBYSxFQUFFLFFBQWlCO0lBQzlELE1BQU0sT0FBTyxHQUFHLGFBQWEsQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDekMsTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUVwQyxJQUFJLGlCQUFpQixHQUFhLEVBQUUsQ0FBQztJQUNyQyxJQUFJLENBQUM7UUFDRCxpQkFBaUIsR0FBSSxnQkFBZ0IsRUFBRSxDQUFDLHdCQUFxQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQzVGLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FDN0MsQ0FBQztJQUNOLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxpQkFBaUIsR0FBRyxFQUFFLENBQUM7SUFDM0IsQ0FBQztJQUVELE1BQU0sT0FBTyxHQUE0QjtRQUNyQyxFQUFFLEVBQUUsSUFBSTtRQUNSLElBQUksRUFBRSxPQUFPO1FBQ2IsZUFBZSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFO1FBQzVDLHFCQUFxQixFQUFFLGlCQUFpQjtRQUN4QyxTQUFTLEVBQUUsZUFBZSxFQUFFO1FBQzVCLGFBQWEsRUFBRSxPQUFPLENBQUMsS0FBSztRQUM1QixTQUFTLEVBQUUsT0FBTyxDQUFDLEtBQUs7S0FDM0IsQ0FBQztJQUNGLElBQUksUUFBUSxFQUFFLENBQUM7UUFDWCxPQUFPLENBQUMsSUFBSTtZQUNSLGtFQUFrRTtnQkFDbEUsa0NBQWtDO2dCQUNsQyxnRUFBZ0UsQ0FBQztJQUN6RSxDQUFDO0lBQ0QsT0FBTyxPQUFPLENBQUM7QUFDbkIsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsRUFBTyxFQUFFLE9BQTJCO0lBQzFELE1BQU0sTUFBTSxHQUFHLE9BQU8sT0FBTyxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUMvRSxNQUFNLEtBQUssR0FBRyxPQUFPLE9BQU8sQ0FBQyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBRWpHLHNDQUFzQztJQUN0QyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDVixPQUFPLGVBQWUsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFFRCxhQUFhO0lBQ2IsSUFBSSxNQUFNLEtBQUssU0FBUyxJQUFJLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUM5QyxNQUFNLEVBQUUsT0FBTyxFQUFFLEdBQUcsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3BDLE1BQU0sSUFBSSxHQUEyQjtZQUNqQyxVQUFVLEVBQUUsZ0NBQWdDO1lBQzVDLFVBQVUsRUFBRSw2REFBNkQ7WUFDekUsUUFBUSxFQUFFLG1FQUFtRTtZQUM3RSxlQUFlLEVBQUUsdURBQXVEO1lBQ3hFLFlBQVksRUFBRSx5REFBeUQ7WUFDdkUsSUFBSSxFQUFFLHNFQUFzRTtZQUM1RSxJQUFJLEVBQUUsc0NBQXNDO1lBQzVDLFFBQVEsRUFBRSxxQ0FBcUM7WUFDL0MsS0FBSyxFQUFFLDhCQUE4QjtZQUNyQyxXQUFXLEVBQ1AseUtBQXlLO1lBQzdLLFNBQVMsRUFDTCx5SkFBeUo7WUFDN0osU0FBUyxFQUNMLDBKQUEwSjtZQUM5SixhQUFhLEVBQ1QsbUlBQW1JO1lBQ3ZJLElBQUksRUFBRSw4UEFBOFA7WUFDcFEsUUFBUSxFQUNKLGtRQUFrUTtZQUN0USxZQUFZLEVBQ1IsNklBQTZJO1lBQ2pKLFFBQVEsRUFDSixxTEFBcUw7WUFDekwsV0FBVyxFQUFFLDBCQUEwQjtTQUMxQyxDQUFDO1FBQ0YsSUFBSSxhQUFhLEdBQStDLEVBQUUsQ0FBQztRQUNuRSxJQUFJLENBQUM7WUFDRCxNQUFNLE1BQU0sR0FBRyxnQkFBZ0IsRUFBRSxDQUFDO1lBQ2xDLGFBQWEsR0FBSSxNQUFNLENBQUMsd0JBQXFDLENBQUMsR0FBRyxDQUFDLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxDQUFDO2dCQUM5RSxJQUFJLEVBQUUsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDaEQsU0FBUzthQUNaLENBQUMsQ0FBQyxDQUFDO1FBQ1IsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLGFBQWEsR0FBRyxFQUFFLENBQUM7UUFDdkIsQ0FBQztRQUNELE9BQU87WUFDSCxFQUFFLEVBQUUsSUFBSTtZQUNSLElBQUksRUFBRSxTQUFTO1lBQ2YsT0FBTyxFQUFFO2dCQUNMLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7cUJBQ2xCLElBQUksRUFBRTtxQkFDTixHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUM3RCxHQUFHLGFBQWE7YUFDbkI7WUFDRCxTQUFTLEVBQUUsZUFBZSxFQUFFO1NBQy9CLENBQUM7SUFDTixDQUFDO0lBRUQsbUJBQW1CO0lBQ25CLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2hELElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BCLE9BQU87WUFDSCxFQUFFLEVBQUUsS0FBSztZQUNULEtBQUssRUFBRSxxQ0FBcUMsTUFBTSxFQUFFO1NBQ3ZELENBQUM7SUFDTixDQUFDO0lBRUQsaUVBQWlFO0lBQ2pFLHFDQUFxQztJQUNyQyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2pDLElBQUksU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixPQUFPLGVBQWUsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzdDLENBQUM7SUFFRCxJQUFJLElBQUksR0FBUSxFQUFFLENBQUM7SUFDbkIsS0FBSyxNQUFNLElBQUksSUFBSSxTQUFTLEVBQUUsQ0FBQztRQUMzQixJQUFJLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3RDLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxPQUFPLE1BQU0sTUFBTSxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQ2hFLENBQUM7UUFDRCxJQUFJLEdBQUksSUFBZ0MsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuRCxDQUFDO0lBQ0QsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN0QyxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxNQUFNLEVBQUUsRUFBRSxDQUFDO0lBQ2pELENBQUM7SUFFRCxJQUFJLE9BQU8sSUFBSSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQzdCLGNBQWM7UUFDZCxPQUFPO1lBQ0gsRUFBRSxFQUFFLElBQUk7WUFDUixJQUFJLEVBQUUsT0FBTztZQUNiLE1BQU07WUFDTixJQUFJLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQztZQUN2QixJQUFJLEVBQUUsYUFBYSxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsV0FBVyxJQUFJLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQztTQUMzRSxDQUFDO0lBQ04sQ0FBQztJQUVELDBCQUEwQjtJQUMxQixJQUFJLFFBQVEsR0FBUSxJQUFJLENBQUM7SUFDekIsSUFBSSxZQUFZLEdBQUcsRUFBRSxDQUFDO0lBQ3RCLElBQUksT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ25CLE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMvQixNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDbkUsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNQLFFBQVEsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ25DLElBQUksQ0FBQyxRQUFRO2dCQUFFLFlBQVksR0FBRyxNQUFNLElBQUksQ0FBQyxJQUFJLFFBQVEsTUFBTSxLQUFLLENBQUM7UUFDckUsQ0FBQzthQUFNLENBQUM7WUFDSixZQUFZLEdBQUcsU0FBUyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDL0MsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFPO1FBQ0gsRUFBRSxFQUFFLElBQUk7UUFDUixJQUFJLEVBQUUsT0FBTztRQUNiLE1BQU07UUFDTixTQUFTLEVBQUUsQ0FBQyxHQUFHLEVBQUU7WUFDYixJQUFJLENBQUM7Z0JBQ0QsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNwQyxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLE9BQU8sTUFBTSxDQUFDO1lBQ2xCLENBQUM7UUFDTCxDQUFDLENBQUMsRUFBRTtRQUNKLGFBQWEsRUFBRSxPQUFPLENBQUMsUUFBUSxDQUFDO1FBQ2hDLElBQUksRUFBRSxZQUFZLElBQUksU0FBUztRQUMvQixVQUFVLEVBQUUsYUFBYSxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUM7S0FDL0QsQ0FBQztBQUNOLENBQUM7QUFFRCw4RUFBOEU7QUFDOUUsT0FBTztBQUNQLDhFQUE4RTtBQUVqRSxRQUFBLE9BQU8sR0FBK0M7SUFDL0QsMEJBQTBCO0lBQzFCLElBQUk7UUFDQSxPQUFPLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUM7SUFDeEMsQ0FBQztJQUVELG1CQUFtQjtJQUNuQixLQUFLLENBQUMsT0FBTyxDQUFDLE9BQXVCO1FBQ2pDLE9BQU8sZ0JBQWdCLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFFRCxxQkFBcUI7SUFDckIsS0FBSyxDQUFDLFdBQVcsQ0FBQyxPQUEyQjtRQUN6QyxJQUFJLENBQUM7WUFDRCxNQUFNLEVBQUUsR0FBRyxLQUFLLEVBQUUsQ0FBQztZQUNuQixPQUFPLGdCQUFnQixDQUFDLEVBQUUsRUFBRSxPQUFPLElBQUksRUFBRSxDQUFDLENBQUM7UUFDL0MsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDaEQsQ0FBQztJQUNMLENBQUM7SUFFRDs7Ozs7O09BTUc7SUFDSCxLQUFLLENBQUMsV0FBVyxDQUFDLE9BQTJCO1FBQ3pDLElBQUksQ0FBQztZQUNELE1BQU0sRUFBRSxHQUFHLEtBQUssRUFBRSxDQUFDO1lBQ25CLE9BQU8sa0JBQWtCLENBQUMsRUFBRSxFQUFFLE9BQU8sSUFBSSxFQUFFLENBQUMsQ0FBQztRQUNqRCxDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNYLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoRCxDQUFDO0lBQ0wsQ0FBQztJQUdEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O09BbUJHO0lBQ0gsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUF1QjtRQUNqQyxJQUFJLENBQUM7WUFDRCxNQUFNLEVBQUUsR0FBRyxLQUFLLEVBQUUsQ0FBQztZQUNuQixNQUFNLE1BQU0sR0FBRyxZQUFZLEVBQUUsQ0FBQztZQUM5QixNQUFNLE1BQU0sR0FBRyxPQUFPLElBQUksT0FBTyxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO1lBRW5FLElBQUksTUFBTSxLQUFLLEtBQUssRUFBRSxDQUFDO2dCQUNuQixJQUFJLENBQUMsVUFBVTtvQkFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUscUJBQXFCLEVBQUUsQ0FBQztnQkFDcEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7b0JBQ2pDLE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQztvQkFDN0IsVUFBVSxHQUFHLElBQUksQ0FBQztvQkFDbEIsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxJQUFJLElBQUksZUFBZSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7Z0JBQ3hGLENBQUM7Z0JBQ0QsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDO2dCQUN6QixVQUFVLEdBQUcsSUFBSSxDQUFDO2dCQUNsQixNQUFNLFFBQVEsR0FBRyxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUM3RSxPQUFPO29CQUNILEVBQUUsRUFBRSxJQUFJO29CQUNSLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztvQkFDbEIsUUFBUSxFQUFFLFFBQVEsQ0FBQyxRQUFRO29CQUMzQixNQUFNLEVBQUUsUUFBUSxDQUFDLE1BQU07b0JBQ3ZCLEtBQUssRUFBRSxRQUFRLENBQUMsS0FBSztvQkFDckIsUUFBUSxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBUztvQkFDL0IsSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJO2lCQUN0QixDQUFDO1lBQ04sQ0FBQztZQUVELElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUNqQyxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLElBQUksSUFBSSxlQUFlLEVBQUUsQ0FBQztZQUNoRSxDQUFDO1lBQ0QsTUFBTSxJQUFJLEdBQUcsV0FBVyxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDM0QsTUFBTSxJQUFJLEdBQUcsZ0JBQWdCLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUN0RCxJQUFJLENBQUMsSUFBSTtnQkFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsc0JBQXNCLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxFQUFFLENBQUM7WUFFdkcsTUFBTSxPQUFPLEdBQUcsV0FBVyxDQUFDLEVBQUUsRUFBRTtnQkFDNUIsV0FBVyxFQUFFLE9BQU8sT0FBTyxDQUFDLFdBQVcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLEVBQUU7YUFDbEYsQ0FBQyxDQUFDLE9BQThCLENBQUM7WUFDbEMsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ2xILElBQUksSUFBSSxHQUFRLElBQUksQ0FBQztZQUNyQixJQUFJLEdBQUcsRUFBRSxDQUFDO2dCQUNOLElBQUksR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDO1lBQ3RFLENBQUM7WUFDRCxNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztZQUVoRCw4Q0FBOEM7WUFDOUMsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxHQUFHLEdBQUksVUFBb0MsQ0FBQyxTQUFTLEdBQUcsZ0JBQWdCLENBQUM7WUFDOUcsTUFBTSxLQUFLLEdBQUcsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDcEcsTUFBTSxLQUFLLEdBQUcsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLFVBQVUsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1lBRTFGLE1BQU0sT0FBTyxHQUFHLFlBQVksQ0FBQyxFQUFFLEVBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3hGLFVBQVUsR0FBRyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxDQUFDO1lBRTlDLE1BQU0sT0FBTyxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDekMsT0FBTztnQkFDSCxFQUFFLEVBQUUsT0FBTyxDQUFDLE1BQU0sS0FBSyxJQUFJO2dCQUMzQixLQUFLO2dCQUNMLElBQUk7Z0JBQ0osTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNO2dCQUN0QixJQUFJLEVBQUUsT0FBTyxDQUFDLElBQUk7Z0JBQ2xCLE1BQU0sRUFBRSxPQUFPLENBQUMsTUFBTTtnQkFDdEIscUNBQXFDO2dCQUNyQyxRQUFRLEVBQUUsT0FBTyxDQUFDLE1BQU0sS0FBSyxJQUFJLElBQUksSUFBSSxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUk7Z0JBQ3pFLE9BQU87Z0JBQ1AsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO2dCQUNqQixhQUFhLEVBQUUsS0FBSztnQkFDcEIsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFO2dCQUNySCx3Q0FBd0M7Z0JBQ3hDLEtBQUssRUFBRSxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUyxFQUFFO2dCQUNuRSxNQUFNLEVBQUUsZUFBZSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUM7YUFDdEMsQ0FBQztRQUNOLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ1gsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2hELENBQUM7SUFDTCxDQUFDO0NBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog5Zy65pmv6L+b56iL6ISa5pysIOKAlOKAlCBDb2RlIE1vZGUg55qE44CM5byV5pOO5L6n5omn6KGM5Zmo44CN44CCXG4gKlxuICog6L+Z5Liq5paH5Lu26LeR5ZyoICoq5byV5pOO5Zy65pmv6L+b56iLKiog6YeM77yI5LiN5piv5omp5bGV5Li76L+b56iL77yJ77yM5omA5Lul6IO955u05o6l5ou/5YiwIGBjY2Ag5qih5Z2X77yaXG4gKiBgTm9kZWAgLyBgQ29tcG9uZW50YCAvIGBBc3NldGAgLyBgZGlyZWN0b3JgIC8g5Zy65pmv5qCR77yM5YWo5piv55yf55qE6L+Q6KGM5pe25a+56LGh44CCXG4gKlxuICog5Li76L+b56iL6YCa6L+HXG4gKiBgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7IG5hbWUsIG1ldGhvZCwgYXJncyB9KWBcbiAqIOiwg+WIsOi/memHjO+8iOingSBjb3JlL3NjZW5lLWJyaWRnZS50c++8ieOAglxuICpcbiAqICMjIOaJp+ihjOetlueVpe+8mmB2bS5ydW5JblRoaXNDb250ZXh0YCDkvJjlhYjvvIxgbmV3IEZ1bmN0aW9uYCDlhZzlupVcbiAqXG4gKiDov5nph4zmnInkuKoqKuW/hemhu+iusua4healmueahOWPluiIjSoq44CC5Li76L+b56iL6YKj6L6555SoIGB2bS5jcmVhdGVDb250ZXh0YCDlgZrpmpTnprvmspnnrrHvvIxcbiAqIOS9huW8leaTjui/m+eoi+S4jeiDveeFp+aQrCDigJTigJQg6ZqU56a75LiK5LiL5paH5Lya5paw5bu65LiA5pW05aWXIHJlYWxtIOWGheW7uuWvueixoe+8jFxuICog5rKZ566x6YeM6YCg5Ye65p2l55qEIGB7fWAgLyBgW11gIOWcqOW8leaTjuS7o+eggeeahCBgaW5zdGFuY2VvZiBPYmplY3RgIC8gYGluc3RhbmNlb2YgQXJyYXlgXG4gKiDliKTmlq3kuIvkvJoqKuS4uuWBhyoq77yM6YKj5Lya6K6p5LiA5aCG5byV5pOOIEFQSSDlh7rnjrDpmr7ku6XmjpLmn6XnmoTor6HlvILooYzkuLrjgIJcbiAqXG4gKiDmiYDku6XopoHnmoTmmK/jgIwqKuWQjOS4gOS4qiByZWFsbe+8jOS9huiDvei2heaXtioq44CN4oCU4oCUIOato+WlveaYryBgdm0ucnVuSW5UaGlzQ29udGV4dChjb2RlLCB7IHRpbWVvdXQgfSlg77yaXG4gKiAtIOS7o+eggei3keWcqCoq5a6/5Li7IHJlYWxtKirvvIzlhoXlu7rlr7nosaHkuI7lvJXmk47lrozlhajkuIDoh7TvvIxgaW5zdGFuY2VvZmAg6K+t5LmJ5a6J5YWo77ybXG4gKiAtIGB0aW1lb3V0YCDlr7kqKuWQjOatpeaJp+ihjOautSoq55Sf5pWI77yM5LqO5pivIGB3aGlsZSh0cnVlKXt9YCDog73ooqvmjpDmlq1cbiAqICAg77yI6L+Z5LiA54K55b6I5YWz6ZSu77ya5Zy65pmv6L+b56iL6YeM5Y2h5q275LiA5Liq5ZCM5q2l5q275b6q546vID0g5pW05LiqIENvY29zIENyZWF0b3Ig5Ya75L2P77yMXG4gKiAgIOWPquiDveW8uuadgO+8jOacquS/neWtmOeahOWcuuaZr+aUueWKqOWFqOS4ou+8ieOAglxuICpcbiAqIOS7o+S7t+aYryBgcnVuSW5UaGlzQ29udGV4dGAg55qE5Luj56CBKirnnIvkuI3liLDlsYDpg6jkvZznlKjln58qKu+8jOWFqOWxgOmHj+WPquiDvemAmui/hyBgZ2xvYmFsVGhpc2Ag5Lyg6YCS77yMXG4gKiDmiafooYzlrozlho3ov5jljp/vvIjop4Ege0BsaW5rIGluamVjdEdsb2JhbHN977yJ44CCXG4gKlxuICog5aaC5p6c5byV5pOO6L+b56iL6YeM5ou/5LiN5YiwIGB2bWDvvIzlm57okL3liLAgYG5ldyBGdW5jdGlvbiguLi5uYW1lcywgYm9keSlg77yaXG4gKiDnlKjmmL7lvI/lvaLlj4LkvKDlhajlsYDph4/vvIzpm7bkvp3otZbjgIHkuI3norAgYGdsb2JhbFRoaXNg77yM5L2GKirlkIzmraXmrbvlvqrnjq/ml6Dms5XooqvotoXml7bmlZHlm54qKuOAglxuICog5Lik5p2h6Lev5b6E55qE55So5oi35Luj56CB5YaZ5rOV5a6M5YWo5LiA6Ie077yI6KO45qCH6K+G56ymICsg6aG25bGCIHJldHVybi9hd2FpdO+8ieOAglxuICpcbiAqICMjIOi/meS4quaWh+S7tuWPquaatOmcsiAzIOS4quaWueazle+8jOS4jeaYryAzMCDkuKpcbiAqXG4gKiBgcnVuQ29kZWAg6YeM5rOo5YWl5LqGIGBkdW1wYCAvIGBub2RlQnlVdWlkYCAvIGB0cmVlYCAvIGBzbmFwc2hvdGAg562JKirliqnmiYvlh73mlbAqKu+8jFxuICog5a6D5Lus5rS75Zyo5rKZ566x6YeM6ICM5LiN5piv5Y+Y5oiQ54us56uLIHRvb2wg4oCU4oCUIOi/meaYryBDb2RlIE1vZGUg55qE5qC45b+D5Y+j5b6E77yaXG4gKiDlt6XlhbfliJfooajopoHnn63vvIzog73lipvpnaDku6PnoIHnu4TlkIjjgILkuLvov5vnqIvkvqflj6rnnIvliLAgMyDkuKrlt6XlhbfvvIxcbiAqIOW8leaTjuiDveWKm+WNtOacieaXoOmZkOe7hOWQiOOAglxuICpcbiAqICMjIOS4pOS4quOAjOS4jei/meS5iOWBmuWwseS8muiiq+ivr+WvvOOAjeeahOWunua1i+WdkVxuICpcbiAqIDEuICoq5Zy65pmv5qCR6YeMIDk3JSDnmoToioLngrnkuI3mmK/kvaDnmoTlhoXlrrkqKuOAgue8lui+keWZqOaKiuWdkOagh+i9tCBnaXptb+OAgee9keagvOOAgeWPguiAg+WbvumDveaMguWcqFxuICogICAg5ZCM5LiA5LiqIHNjZW5lIOS4i++8iOWunua1i+epuuWcuuaZryAxMjgg5Liq6IqC54K577yM55yf5a6e5YaF5a655Y+q5pyJIDIg5Liq77yJ44CCXG4gKiAgICBgZWFjaE5vZGVgIC8gYHRyZWUoKWAg6buY6K6k5oyJIGBIaWRlSW5IaWVyYXJjaHlgIOWJquaenSDigJTigJQg5Yik5o2u55qE5o6o5a+86L+H56iL6KeBXG4gKiAgICB7QGxpbmsgbWFrZUhlbHBlcnN9IOmHjCBgaXNFZGl0b3JOb2RlYCDkuIrmlrnnmoTms6jph4rvvIgqKuaMiSBsYXllciDmu6TmmK/plJnnmoQqKu+8ieOAglxuICogMi4gKipgY2MuZmluZGAg5om+5LiN5Yiw5ZCN5a2X6YeM5ZCrIGAvYCDnmoToioLngrkqKu+8jOiAjOS4lCoq6Z2Z6buY6L+U5ZueIG51bGwqKuOAglxuICogICAg5bel56iL6YeM5a6e5rWL5a2Y5ZyoIGBpbnRlcm5hbC9lZGl0b3IvZ3JpZC0yZGDjgIJ7QGxpbmsgbWFrZUhlbHBlcnN9IOmHjFxuICogICAgYHJlc29sdmVQYXRoQnlTZWdtZW50c2Ag55So44CM6LSq5b+D5oyJ5q615Yy56YWN44CN5YWc5L2P5LqG6L+Z5LiA57G744CCXG4gKi9cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xuXG4vKiog5omn6KGM6LaF5pe255qE5ZOo5YW16ZSZ6K+vICovXG5pbnRlcmZhY2UgVGltZW91dE1hcmtlciB7XG4gICAgX19kc2hUaW1lb3V0OiB0cnVlO1xufVxuXG5mdW5jdGlvbiB0aW1lb3V0RXJyb3IobXM6IG51bWJlcik6IEVycm9yICYgVGltZW91dE1hcmtlciB7XG4gICAgY29uc3QgZXJyID0gbmV3IEVycm9yKGDlnLrmma/ku6PnoIHmiafooYzotoXml7bvvIgke21zfW1z77yJYCkgYXMgRXJyb3IgJiBUaW1lb3V0TWFya2VyO1xuICAgIGVyci5fX2RzaFRpbWVvdXQgPSB0cnVlO1xuICAgIHJldHVybiBlcnI7XG59XG5cbi8qKlxuICog5Yik5pat5piv5LiN5piv6LaF5pe244CCXG4gKlxuICog6KaB6K6k5Lik56eN77yaXG4gKiAxLiDmiJHku6zoh6rlt7HnmoTlk6jlhbXvvIjlpJblsYLorqHml7blmajmipvnmoTvvInigJTigJQgYF9fZHNoVGltZW91dGBcbiAqIDIuICoqdm0g6Ieq5bex5oqb55qE5ZCM5q2l6LaF5pe2Kiog4oCU4oCUIGBFUlJfU0NSSVBUX0VYRUNVVElPTl9USU1FT1VUYO+8jFxuICogICAg5L+h5oGv5b2i5aaCIGBTY3JpcHQgZXhlY3V0aW9uIHRpbWVkIG91dCBhZnRlciAzMDBtc2BcbiAqXG4gKiDnrKwgMiDnp43nibnliKvlrrnmmJPmvI/vvJrmvI/kuobnmoTor53mrbvlvqrnjq/omb3nhLbooqvmjpDmlq3kuobvvIxcbiAqIOS9huWvueWkluaKpeeahOaYr+OAjOaZrumAmuW8guW4uOOAjeiAjOS4jeaYr+OAjOi2heaXtuOAje+8jOS9v+eUqOiAheeci+S4jeWHuuivpeWOu+aUueS7gOS5iOOAglxuICovXG5mdW5jdGlvbiBpc1RpbWVvdXQoZXJyOiB1bmtub3duKTogYm9vbGVhbiB7XG4gICAgaWYgKCFlcnIgfHwgdHlwZW9mIGVyciAhPT0gJ29iamVjdCcpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBhbnlFcnIgPSBlcnIgYXMgeyBfX2RzaFRpbWVvdXQ/OiBib29sZWFuOyBjb2RlPzogdW5rbm93bjsgbWVzc2FnZT86IHVua25vd24gfTtcbiAgICBpZiAoYW55RXJyLl9fZHNoVGltZW91dCkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGFueUVyci5jb2RlID09PSAnRVJSX1NDUklQVF9FWEVDVVRJT05fVElNRU9VVCcpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiB0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnICYmIC9TY3JpcHQgZXhlY3V0aW9uIHRpbWVkIG91dC9pLnRlc3QoYW55RXJyLm1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBlcnJvckluZm8oZXJyOiB1bmtub3duKTogeyBuYW1lOiBzdHJpbmc7IG1lc3NhZ2U6IHN0cmluZzsgc3RhY2s/OiBzdHJpbmcgfSB7XG4gICAgaWYgKGVyciAmJiB0eXBlb2YgZXJyID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnIgYXMgeyBuYW1lPzogdW5rbm93bjsgbWVzc2FnZT86IHVua25vd247IHN0YWNrPzogdW5rbm93biB9O1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbmFtZTogdHlwZW9mIGFueUVyci5uYW1lID09PSAnc3RyaW5nJyA/IGFueUVyci5uYW1lIDogJ0Vycm9yJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6IHR5cGVvZiBhbnlFcnIubWVzc2FnZSA9PT0gJ3N0cmluZycgPyBhbnlFcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgc3RhY2s6IHR5cGVvZiBhbnlFcnIuc3RhY2sgPT09ICdzdHJpbmcnID8gYW55RXJyLnN0YWNrIDogdW5kZWZpbmVkLFxuICAgICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4geyBuYW1lOiAnRXJyb3InLCBtZXNzYWdlOiBTdHJpbmcoZXJyKSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOW8leaTjuaooeWdl+aHkuWKoOi9vVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmxldCBjY0NhY2hlOiBhbnkgPSBudWxsO1xubGV0IGNjRXJyb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKipcbiAqIOaLv+WIsCBgY2NgIOaooeWdl+OAglxuICpcbiAqIGBtb2R1bGUucGF0aHMucHVzaChFZGl0b3IuQXBwLnBhdGggKyAnL25vZGVfbW9kdWxlcycpYCDmmK/lv4XpnIDnmoTvvJpcbiAqIOWcuuaZr+iEmuacrOiHqui6q+eahOaooeWdl+ino+aekOi3r+W+hOmHjOayoeacieW8leaTjuWMhe+8jOS4jeaOqOi/meS4gOS4iyBgcmVxdWlyZSgnY2MnKWAg5LyaIE1PRFVMRV9OT1RfRk9VTkTjgIJcbiAqL1xuZnVuY3Rpb24gZ2V0Q2MoKTogYW55IHtcbiAgICBpZiAoY2NDYWNoZSkgcmV0dXJuIGNjQ2FjaGU7XG4gICAgaWYgKGNjRXJyb3IpIHRocm93IG5ldyBFcnJvcihjY0Vycm9yKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBlbmdpbmVOb2RlTW9kdWxlcyA9IGpvaW4oRWRpdG9yLkFwcC5wYXRoLCAnbm9kZV9tb2R1bGVzJyk7XG4gICAgICAgIGlmICghbW9kdWxlLnBhdGhzLmluY2x1ZGVzKGVuZ2luZU5vZGVNb2R1bGVzKSkge1xuICAgICAgICAgICAgbW9kdWxlLnBhdGhzLnB1c2goZW5naW5lTm9kZU1vZHVsZXMpO1xuICAgICAgICB9XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdmFyLXJlcXVpcmVzXG4gICAgICAgIGNjQ2FjaGUgPSByZXF1aXJlKCdjYycpO1xuICAgICAgICByZXR1cm4gY2NDYWNoZTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY2NFcnJvciA9IGDml6Dms5XliqDovb3lvJXmk47mqKHlnZcgY2PvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YDtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGNjRXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gY3VycmVudFNjZW5lKGNjOiBhbnkpOiBhbnkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcmVjaXBlIOaooeWdlyDigJTigJQg5LiO5Li76L+b56iL5YWx5Lqr5ZCM5LiA5Lu95a6e546wXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIOaJqeWxleWMheWQje+8jOS4jiBjb25zdGFudHMudHMg55qEIEVYVEVOU0lPTl9OQU1FIOS4gOiHtO+8iOatpOWkhOS4jeiDvSBpbXBvcnTvvIzljp/lm6Dop4HkuIvvvIkgKi9cbmNvbnN0IEVYVEVOU0lPTl9OQU1FID0gJ2RzaF9jaGF0JztcblxubGV0IHJlY2lwZXNNb2R1bGU6IGFueSA9IG51bGw7XG5sZXQgcmVjaXBlc01vZHVsZUVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiDliqDovb3lhbHkuqvnmoQgcmVjaXBlIOaooeWdl++8iGBkaXN0L2NvcmUvcmVjaXBlcy5qc2DvvInjgIJcbiAqXG4gKiDimqAgKirlv4XpobvmjInnu53lr7not6/lvoQgcmVxdWlyZe+8jOebuOWvuei3r+W+hOS4jemAmioq44CC5a6e5rWL5Zy65pmv6ISa5pys6YeMIGBfX2Rpcm5hbWVgIOaYr1xuICogYC4uLlxccmVzb3VyY2VzXFxlbGVjdHJvbi5hc2FyXFxyZW5kZXJlcmDvvIjkuI3mmK/mianlsZXnmoQgYGRpc3QvYO+8ie+8jFxuICog5omA5LulIGByZXF1aXJlKCcuL2NvcmUvcmVjaXBlcycpYCDnm7TmjqUgTU9EVUxFX05PVF9GT1VOROOAglxuICpcbiAqIOato+ino+aYr+mXrue8lui+keWZqOimgeaJqeWxleague+8mmBFZGl0b3IuUGFja2FnZS5nZXRQYXRoKCdkc2hfY2hhdCcpYFxuICog4oaSIGAuLi5cXGV4dGVuc2lvbnNcXGRzaF9jaGF0YO+8jOWGjeaLvCBgZGlzdC9jb3JlL3JlY2lwZXMuanNg77yI5a6e5rWL5Y+v6KGM77yJ44CCXG4gKlxuICog6aG65bim6K+05piO5LiA5Liq56Gs57qm5p2f77ya5pys6aG555uuKirmsqHmnInmiZPljIXlmagqKu+8iOaehOW7uuWwseaYryBgdHNjYO+8ie+8jFxuICog5omA5LulIGBkaXN0L2Ag55qE55uu5b2V57uT5p6E5piv6Leo6L+b56iL55qE56Gs5aWR57qm77yM5pS5IGBvdXREaXJgIOaIluaMqiBgY29yZS9gIOS8muaJk+aWreWug+OAglxuICovXG5mdW5jdGlvbiBnZXRSZWNpcGVzTW9kdWxlKCk6IGFueSB7XG4gICAgaWYgKHJlY2lwZXNNb2R1bGUpIHJldHVybiByZWNpcGVzTW9kdWxlO1xuICAgIGlmIChyZWNpcGVzTW9kdWxlRXJyb3IpIHRocm93IG5ldyBFcnJvcihyZWNpcGVzTW9kdWxlRXJyb3IpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJvb3QgPSBFZGl0b3IuUGFja2FnZS5nZXRQYXRoKEVYVEVOU0lPTl9OQU1FKTtcbiAgICAgICAgaWYgKCFyb290KSB0aHJvdyBuZXcgRXJyb3IoYEVkaXRvci5QYWNrYWdlLmdldFBhdGgoJyR7RVhURU5TSU9OX05BTUV9Jykg6L+U5Zue56m6YCk7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdmFyLXJlcXVpcmVzXG4gICAgICAgIHJlY2lwZXNNb2R1bGUgPSByZXF1aXJlKGpvaW4ocm9vdCwgJ2Rpc3QnLCAnY29yZScsICdyZWNpcGVzLmpzJykpO1xuICAgICAgICByZXR1cm4gcmVjaXBlc01vZHVsZTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVjaXBlc01vZHVsZUVycm9yID0gYOaXoOazleWKoOi9vSByZWNpcGUg5qih5Z2X77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWA7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihyZWNpcGVzTW9kdWxlRXJyb3IpO1xuICAgIH1cbn1cblxuLyoqIOW9k+WJjeW3peeoi+ague+8m+aLv+S4jeWIsOWwsei/lOWbnuepuuS4su+8iHJlY2lwZSDliqnmiYvkvJrpgIDljJbmiJDjgIzmsqHmnIkgcmVjaXBl44CN6ICM5LiN5piv5oql6ZSZ77yJICovXG5mdW5jdGlvbiBjdXJyZW50UHJvamVjdFBhdGgoKTogc3RyaW5nIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gRWRpdG9yLlByb2plY3QucGF0aCB8fCAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cbn1cblxuLyoqIHJlY2lwZSDlrZjmlL7nm67lvZUg4oCU4oCUIOWPque7mSBgZGVzY3JpYmVfYXBpYCDlm57mmL7nlKjvvIzmi7/kuI3liLDlsLEgbnVsbCAqL1xuZnVuY3Rpb24gcmVjaXBlc1Jvb3RIaW50KCk6IHN0cmluZyB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHByb2plY3RQYXRoID0gY3VycmVudFByb2plY3RQYXRoKCk7XG4gICAgICAgIGlmICghcHJvamVjdFBhdGgpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gZ2V0UmVjaXBlc01vZHVsZSgpLnJlY2lwZXNSb290KHByb2plY3RQYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWKqeaJi+WHveaVsCDigJTigJQg5rOo5YWl5rKZ566x77yM5LiN5pq06Zyy5Li6IHRvb2xcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiog5rex5bqm5LyY5YWI6YGN5Y6G5pW05qO15a2Q5qCR77yI6L+t5Luj5a6e546w77yM6YG/5YWN5rex5bGC5Zy65pmv54iG5qCI77yJICovXG5mdW5jdGlvbiBlYWNoTm9kZShyb290OiBhbnksIHZpc2l0OiAobm9kZTogYW55KSA9PiB2b2lkKTogdm9pZCB7XG4gICAgaWYgKCFyb290KSByZXR1cm47XG4gICAgY29uc3Qgc3RhY2s6IGFueVtdID0gW3Jvb3RdO1xuICAgIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBzdGFjay5wb3AoKTtcbiAgICAgICAgdmlzaXQobm9kZSk7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICAgICAgZm9yIChsZXQgaSA9IGNoaWxkcmVuLmxlbmd0aCAtIDE7IGkgPj0gMDsgaSAtPSAxKSBzdGFjay5wdXNoKGNoaWxkcmVuW2ldKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNob3J0Tm9kZShub2RlOiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICAgIGlmICghbm9kZSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgIGFjdGl2ZTogbm9kZS5hY3RpdmVJbkhpZXJhcmNoeSAhPT0gdW5kZWZpbmVkID8gbm9kZS5hY3RpdmVJbkhpZXJhcmNoeSA6IG5vZGUuYWN0aXZlLFxuICAgIH07XG59XG5cbi8qKiDmiorlgLzmjqjmlq3miJAgVFMg57G75Z6L5ZCN77yM55So5LqO55Sf5oiQ57G75a6a5LmJICovXG5mdW5jdGlvbiBpbmZlclRzVHlwZSh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiAnYW55JztcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA+IDAgPyBgJHtpbmZlclRzVHlwZSh2YWx1ZVswXSl9W11gIDogJ2FueVtdJztcbiAgICB9XG4gICAgc3dpdGNoICh0eXBlb2YgdmFsdWUpIHtcbiAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIHJldHVybiAnbnVtYmVyJztcbiAgICAgICAgY2FzZSAnc3RyaW5nJzpcbiAgICAgICAgICAgIHJldHVybiAnc3RyaW5nJztcbiAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICByZXR1cm4gJ2Jvb2xlYW4nO1xuICAgICAgICBjYXNlICdmdW5jdGlvbic6XG4gICAgICAgICAgICByZXR1cm4gJ0Z1bmN0aW9uJztcbiAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgcmV0dXJuICdhbnknO1xuICAgIH1cbiAgICBjb25zdCBvYmogPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBsZXQgY3Rvck5hbWUgPSAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBjdG9yID0gKG9iaiBhcyB7IGNvbnN0cnVjdG9yPzogeyBuYW1lPzogc3RyaW5nIH0gfSkuY29uc3RydWN0b3I7XG4gICAgICAgIGN0b3JOYW1lID0gY3RvciAmJiB0eXBlb2YgY3Rvci5uYW1lID09PSAnc3RyaW5nJyA/IGN0b3IubmFtZSA6ICcnO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBjdG9yTmFtZSA9ICcnO1xuICAgIH1cbiAgICBpZiAoIWN0b3JOYW1lIHx8IGN0b3JOYW1lID09PSAnT2JqZWN0JykgcmV0dXJuICdvYmplY3QnO1xuICAgIC8vIOW8leaTjuaVsOWtpi/otYTmupDnsbvlnovpg73luKYgY2MuIOWJjee8gOabtOWIqeS6jiBBSSDlhpnku6PnoIFcbiAgICBpZiAodHlwZW9mIG9iai51dWlkID09PSAnc3RyaW5nJykgcmV0dXJuIGBjYy4ke2N0b3JOYW1lfSAvKiBhc3NldCAqL2A7XG4gICAgcmV0dXJuIGBjYy4ke2N0b3JOYW1lfWA7XG59XG5cbi8qKiDlj5bkuIDkuKrlr7nosaHkuIrnmoTlj6/mnprkuL7oh6rmnInplK7vvIhnZXR0ZXIg5oqb5byC5bi45pe26Lez6L+H77yJICovXG5mdW5jdGlvbiBzYWZlS2V5cyh0YXJnZXQ6IGFueSk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gT2JqZWN0LmtleXModGFyZ2V0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gc2FmZVJlYWQodGFyZ2V0OiBhbnksIGtleTogc3RyaW5nKTogeyBvazogYm9vbGVhbjsgdmFsdWU/OiB1bmtub3duIH0ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdGFyZ2V0W2tleV0gfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgfVxufVxuXG4vKiog57uE5Lu255qE5bqP5YiX5YyW5bGe5oCn5ZCN5YiX6KGo77ya5LyY5YWI55SoIENvY29zIOeahCBgX19wcm9wc19fYCAqL1xuZnVuY3Rpb24gY29tcG9uZW50UHJvcE5hbWVzKGNvbXA6IGFueSk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCBjdG9yID0gY29tcCAmJiBjb21wLmNvbnN0cnVjdG9yO1xuICAgIGNvbnN0IGRlY2xhcmVkID0gY3RvciAmJiBBcnJheS5pc0FycmF5KGN0b3IuX19wcm9wc19fKSA/IChjdG9yLl9fcHJvcHNfXyBhcyBzdHJpbmdbXSkgOiBudWxsO1xuICAgIGlmIChkZWNsYXJlZCAmJiBkZWNsYXJlZC5sZW5ndGggPiAwKSByZXR1cm4gZGVjbGFyZWQuc2xpY2UoKTtcbiAgICByZXR1cm4gc2FmZUtleXMoY29tcCkuZmlsdGVyKChrKSA9PiBrICE9PSAnbm9kZScgJiYgayAhPT0gJ3V1aWQnICYmICFrLnN0YXJ0c1dpdGgoJ18nKSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5Zy65pmv6KeG5Zu+5oiq5Zu+77yIY2FwdHVyZVZpZXcg55qE5a6e546w77yJXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vXG4vLyDkuLrku4DkuYjopoHov5nkuKrog73lipvvvJrmlLnlrozoioLngrnmoJEv5biD5bGA5LmL5ZCO77yMKirlnZDmoIfmlbDlrZfnnIvkuI3lh7rjgIzlj6DlnKjkuIDotbfjgI3jgIzotLTlm77mmK/nqbrnmoTjgI1cbi8vIOOAjOS4gOWxj+WPquacieS4quinkuOAjSoq44CC5pyJ5LqG5a6D77yMQUkg5Y+v5Lul6Ieq5bex55yL5LiA55y855S76Z2i5YaN5Yaz5a6a5LiL5LiA5q2l77yM6ICM5LiN5piv5ou/5LiA5LiyIHJlY3Rcbi8vIOWOu+eMnO+8jOS5n+S4jeaYr+aKiueUqOaIt+W9k+mqjOWbvuW3peWFt+OAglxuLy9cbi8vIOS4pOadoeWunueOsOWPo+W+hO+8mlxuLy8gMS4gKirlnKjlvJXmk47nlLvlrozov5nkuIDluKfkuYvlkI7or7vlg4/ntKAqKu+8iGBFVkVOVF9BRlRFUl9EUkFXYO+8ieOAgldlYkdMIOeahOe7mOWItue8k+WGsuWcqOWQiOaIkOWQjlxuLy8gICAg5Y2z5aSx5pWI77yIYHByZXNlcnZlRHJhd2luZ0J1ZmZlcmAg6buY6K6kIGZhbHNl77yJ77yM5bin5aSW6K+75Y+q5Lya5b6X5Yiw5LiA5byg56m65Zu+44CCXG4vLyAyLiAqKuS8mOWFiOiHquW3seiQveebmCoq77ya5pys5paH5Lu25piv5Zy65pmv6L+b56iL6YeM55qEIENKUyDmqKHlnZfvvIxgZnNgIOWcqCoq5qih5Z2X5L2c55So5Z+fKirph4zlj6/op4Fcbi8vICAgIO+8iOaymeeusemHjOeci+S4jeWIsCBgcmVxdWlyZWDvvIzkvYbliqnmiYvlh73mlbDnmoTpl63ljIXnnIvlvpfliLDvvInjgILlhpnkuI3kuobnm5jmiY3lm57okL3jgIzliIblnZflm57kvKDjgI3vvIxcbi8vICAgIOeUseS4u+i/m+eoi+aLvOWbnuWOu+iQveebmCDigJTigJQg5Zug5Li65rKZ566x6L+U5Zue5YC85pyJ44CM5Y2V5a2X56ym5LiyIDQwMDAg5a2X44CN55qE5LiK6ZmQ44CCXG5cbi8qKiBOb2RlIOS+p+aooeWdl++8iOaLv+S4jeWIsOWwsei/lOWbniBudWxs77yM6LCD55So5pa55Zue6JC95Yiw5YiG5Z2X5Zue5Lyg77yJ44CCICovXG5sZXQgbm9kZU1vZHVsZXNDYWNoZTogeyBmczogYW55OyBwYXRoOiBhbnk7IG9zOiBhbnkgfSB8IG51bGwgfCB1bmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGdldE5vZGVNb2R1bGVzKCk6IHsgZnM6IGFueTsgcGF0aDogYW55OyBvczogYW55IH0gfCBudWxsIHtcbiAgICBpZiAobm9kZU1vZHVsZXNDYWNoZSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gbm9kZU1vZHVsZXNDYWNoZTtcbiAgICB0cnkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICBub2RlTW9kdWxlc0NhY2hlID0geyBmczogcmVxdWlyZSgnZnMnKSwgcGF0aDogcmVxdWlyZSgncGF0aCcpLCBvczogcmVxdWlyZSgnb3MnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBub2RlTW9kdWxlc0NhY2hlID0gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIG5vZGVNb2R1bGVzQ2FjaGU7XG59XG5cbi8qKiDlnLrmma/op4blm77nmoTpgqPlnZfnlLvluIPvvJrkvJjlhYjlvJXmk47oh6rlt7HnmoQgY2FudmFz77yM5YW25qyh6aG16Z2i5LiK6Z2i56ev5pyA5aSn55qEIGNhbnZhc+OAgiAqL1xuZnVuY3Rpb24gZmluZFZpZXdDYW52YXMoY2M6IGFueSk6IGFueSB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogYW55W10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBpZiAoY2MuZ2FtZSAmJiBjYy5nYW1lLmNhbnZhcykgY2FuZGlkYXRlcy5wdXNoKGNjLmdhbWUuY2FudmFzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955Wl77ya5byV5pOO54mI5pys5beu5byCICovXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgZG9jdW1lbnQgIT09ICd1bmRlZmluZWQnICYmIHR5cGVvZiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGVzLnB1c2goLi4uQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdjYW52YXMnKSkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpe+8muS4jeaYr+a1j+iniOWZqOeOr+WigyAqL1xuICAgIH1cbiAgICBjb25zdCB1c2FibGUgPSBjYW5kaWRhdGVzLmZpbHRlcihcbiAgICAgICAgKGMpID0+IGMgJiYgdHlwZW9mIGMuZ2V0Q29udGV4dCA9PT0gJ2Z1bmN0aW9uJyAmJiBjLndpZHRoID4gMCAmJiBjLmhlaWdodCA+IDAsXG4gICAgKTtcbiAgICBpZiAodXNhYmxlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHVzYWJsZS5zb3J0KChhLCBiKSA9PiBiLndpZHRoICogYi5oZWlnaHQgLSBhLndpZHRoICogYS5oZWlnaHQpWzBdO1xufVxuXG4vKipcbiAqIOaKpeWHuuOAjOWcuuaZr+inhuWbvueOsOWcqOaYr+aAjuS5iOWPluaZr+eahOOAjeKAlOKAlCAqKuepuueZveW4p+eahOS4gOWNiuetlOahiOWcqOi/memHjCoq44CCXG4gKlxuICog5Li65LuA5LmI6KaB5pyJ5a6D77ya5a6e5rWL5Ye66L+H5LiA5qyh5LqL5pWF77yIMjAyNi0wOS0zMCAwMDo0OSDpgqPmnaHkvJror53vvInvvIzmqKHlnovkuLrkuobjgIzmqKHmi5/orr7lpIfpq5jluqbpqozpgILphY3jgI1cbiAqIOiwg+S6hiBgY2Mudmlldy5zZXREZXNpZ25SZXNvbHV0aW9uU2l6ZWDvvIzmiornvJbovpHlmagqKuWcuuaZr+inhuWbvueahOiuvuWkh+aooeaLn+aJk+aOiSoq5LqG77yaXG4gKiBgdmlzaWJsZWAg5LuOIDc1MMOXMTMzNCDlj5jmiJAgNzUww5c1NTkuMzXvvIzmraTlkI7mr4/kuIDmrKEgYGNhcHR1cmVfdmlld2Ag6YO95Y+q5ou/5YiwIGBibGFua1JhdGlvOiAxYFxuICog55qE55m957q4IOKAlOKAlCDogIwqKui/meS4quW3ruW8guaYr+WPr+S7peebtOaOpemHj+WHuuadpeeahCoq44CC5oqK5a6D5oql5Ye65p2l77yM5qih5Z6L5bCx5LiN55So6Z2g54yc77yMXG4gKiDkuZ/kuI3nlKjlg4/pgqPmrKHkuIDmoLfoh6rlu7rkuIDlpZfnprvlsY/muLLmn5PlmajvvIgxNiDmraXvvInljrvmm7/ku6PkuIDkuKpcIuiiq+iHquW3seW8hOWdj1wi55qE6YCa6YGT44CCXG4gKlxuICogQHBhcmFtIGNjIC0g5byV5pOO5qih5Z2X44CCXG4gKiBAcGFyYW0gY2FudmFzIC0g5Zy65pmv6KeG5Zu+55S75biD44CCXG4gKiBAcmV0dXJucyDop4blm77nirbmgIHvvJvlj5bkuI3liLDnmoTpobnkuI3lh7rnjrDvvIjlvJXmk47niYjmnKzlt67lvILkuI3pmLvmlq3miKrlm77mnKzouqvvvInjgIJcbiAqL1xuZnVuY3Rpb24gcmVhZFZpZXdTdGF0ZShjYzogYW55LCBjYW52YXM6IGFueSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCByb3VuZCA9ICh2YWx1ZTogdW5rbm93bik6IG51bWJlciB8IG51bGwgPT5cbiAgICAgICAgdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC5yb3VuZCh2YWx1ZSAqIDEwMCkgLyAxMDAgOiBudWxsO1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB2aWV3ID0gY2MudmlldztcbiAgICAgICAgaWYgKHZpZXcpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygdmlldy5nZXRWaXNpYmxlU2l6ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNpemUgPSB2aWV3LmdldFZpc2libGVTaXplKCk7XG4gICAgICAgICAgICAgICAgaWYgKHNpemUpIG91dC52aXNpYmxlU2l6ZSA9IHsgd2lkdGg6IHJvdW5kKHNpemUud2lkdGgpLCBoZWlnaHQ6IHJvdW5kKHNpemUuaGVpZ2h0KSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZiB2aWV3LmdldERlc2lnblJlc29sdXRpb25TaXplID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2l6ZSA9IHZpZXcuZ2V0RGVzaWduUmVzb2x1dGlvblNpemUoKTtcbiAgICAgICAgICAgICAgICBpZiAoc2l6ZSkgb3V0LmRlc2lnblJlc29sdXRpb24gPSB7IHdpZHRoOiByb3VuZChzaXplLndpZHRoKSwgaGVpZ2h0OiByb3VuZChzaXplLmhlaWdodCkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2Ygdmlldy5nZXRTY2FsZVggPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBvdXQuc2NhbGUgPSB7IHg6IHJvdW5kKHZpZXcuZ2V0U2NhbGVYKCkpLCB5OiByb3VuZCh2aWV3LmdldFNjYWxlWSgpKSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW8leaTjueJiOacrOW3ruW8gu+8muaLv+S4jeWIsOWwseS4jeaKpe+8jOS4jeW9seWTjeaIquWbviAqL1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAoY2FudmFzKSBvdXQuY2FudmFzID0geyB3aWR0aDogY2FudmFzLndpZHRoLCBoZWlnaHQ6IGNhbnZhcy5oZWlnaHQgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955WlICovXG4gICAgfVxuICAgIC8qKiDkuI7orr7orqHliIbovqjnjofkuI3kuIDoh7QgPSDmuLjmiI/kvqflj5bmma/kuI3mmK/orr7orqHmoaPvvIjimqAg5Zy65pmv6KeG5Zu+5piv6Ieq55Sx55u45py677yM55So5oi357yp5pS+5Lmf5Lya6K6p5a6D5Y+Y77yM5omA5Lul6L+Z5Y+q5piv57q/57Si5LiN5piv5Yik5o2u77yJICovXG4gICAgY29uc3QgdmlzaWJsZSA9IG91dC52aXNpYmxlU2l6ZSBhcyB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gfCB1bmRlZmluZWQ7XG4gICAgY29uc3QgZGVzaWduID0gb3V0LmRlc2lnblJlc29sdXRpb24gYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuICAgIGlmICh2aXNpYmxlICYmIGRlc2lnbiAmJiB0eXBlb2YgZGVzaWduLmhlaWdodCA9PT0gJ251bWJlcicgJiYgZGVzaWduLmhlaWdodCA+IDApIHtcbiAgICAgICAgb3V0LnZpc2libGVNYXRjaGVzRGVzaWduID0gTWF0aC5hYnModmlzaWJsZS5oZWlnaHQgLSBkZXNpZ24uaGVpZ2h0KSAvIGRlc2lnbi5oZWlnaHQgPD0gMC4wNTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiDnrYnlvJXmk47nlLvlrozkuIDluKfvvIznhLblkI7ku47pu5jorqTluKfnvJPlhrLor7vlm57lg4/ntKDjgIJcbiAqXG4gKiBAcGFyYW0gd2FpdE1zIOetieS4jeWIsCBgRVZFTlRfQUZURVJfRFJBV2Ag5pe255qE5YWc5bqV5LiK6ZmQ77yI5Zy65pmv6KeG5Zu+5Y+v6IO95rKh5Zyo5riy5p+T77yJXG4gKi9cbmZ1bmN0aW9uIHJlYWRWaWV3UGl4ZWxzKFxuICAgIGNjOiBhbnksXG4gICAgY2FudmFzOiBhbnksXG4gICAgd2FpdE1zOiBudW1iZXIsXG4pOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHBpeGVsczogVWludDhBcnJheSB9PiB7XG4gICAgY29uc3QgZ3JhYiA9ICgpOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBwaXhlbHM6IFVpbnQ4QXJyYXkgfSA9PiB7XG4gICAgICAgIGNvbnN0IGdsID1cbiAgICAgICAgICAgIGNhbnZhcy5nZXRDb250ZXh0KCd3ZWJnbDInKSB8fFxuICAgICAgICAgICAgY2FudmFzLmdldENvbnRleHQoJ3dlYmdsJykgfHxcbiAgICAgICAgICAgIGNhbnZhcy5nZXRDb250ZXh0KCdleHBlcmltZW50YWwtd2ViZ2wnKTtcbiAgICAgICAgaWYgKCFnbCkgdGhyb3cgbmV3IEVycm9yKCfnlLvluIPkuIrmsqHmnIkgV2ViR0wg5LiK5LiL5paH77yIMkQg55S75biD5LiN5pSv5oyB6L+Z5LmI5oiq5Zu+77yJJyk7XG4gICAgICAgIGNvbnN0IHdpZHRoID0gZ2wuZHJhd2luZ0J1ZmZlcldpZHRoIHx8IGNhbnZhcy53aWR0aDtcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gZ2wuZHJhd2luZ0J1ZmZlckhlaWdodCB8fCBjYW52YXMuaGVpZ2h0O1xuICAgICAgICBpZiAoIXdpZHRoIHx8ICFoZWlnaHQpIHRocm93IG5ldyBFcnJvcign55S75biD5bC65a+45Li6IDDvvIzmiKrkuI3liLDkuJzopb8nKTtcbiAgICAgICAgY29uc3QgcGl4ZWxzID0gbmV3IFVpbnQ4QXJyYXkod2lkdGggKiBoZWlnaHQgKiA0KTtcbiAgICAgICAgLy8g5byV5pOO5Y+v6IO955WZ552A5Yir55qEIEZCTyDnu5Hlrpog4oCU4oCUIOivu+m7mOiupOW4p+e8k+WGsuWJjeaYvuW8j+ino+e7kVxuICAgICAgICBnbC5iaW5kRnJhbWVidWZmZXIoZ2wuRlJBTUVCVUZGRVIsIG51bGwpO1xuICAgICAgICBnbC5yZWFkUGl4ZWxzKDAsIDAsIHdpZHRoLCBoZWlnaHQsIGdsLlJHQkEsIGdsLlVOU0lHTkVEX0JZVEUsIHBpeGVscyk7XG4gICAgICAgIHJldHVybiB7IHdpZHRoLCBoZWlnaHQsIHBpeGVscyB9O1xuICAgIH07XG5cbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICAgICAgICBjb25zdCBzZXR0bGUgPSAoZm46ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcbiAgICAgICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZXZlbnQgPSBjYy5EaXJlY3RvciAmJiBjYy5EaXJlY3Rvci5FVkVOVF9BRlRFUl9EUkFXO1xuICAgICAgICAgICAgaWYgKGV2ZW50ICYmIGNjLmRpcmVjdG9yICYmIHR5cGVvZiBjYy5kaXJlY3Rvci5vbmNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgY2MuZGlyZWN0b3Iub25jZShldmVudCwgKCkgPT4gc2V0dGxlKCgpID0+IHJlc29sdmUoZ3JhYigpKSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWbnuiQve+8muebtOaOpeaKk+W9k+WJjee8k+WGsiAqL1xuICAgICAgICB9XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4gc2V0dGxlKCgpID0+IHJlc29sdmUoZ3JhYigpKSksIHdhaXRNcyk7XG4gICAgfSk7XG59XG5cbi8qKiDmir3moLfkvLDnrpfjgIzlh6DkuY7mmK/nqbrlm77jgI3nmoTmr5TkvovvvIjlhajpgI/mmI7miJbnuq/pu5Hpg73nrpfnqbrvvInigJTigJQg55So5p2l5Y+R546wXCLmiKrlh7rmnaXmmK/lvKDnmb3nurhcIuOAgiAqL1xuZnVuY3Rpb24gc2FtcGxlQmxhbmtSYXRpbyhwaXhlbHM6IFVpbnQ4QXJyYXkpOiBudW1iZXIge1xuICAgIGNvbnN0IHRvdGFsID0gTWF0aC5mbG9vcihwaXhlbHMubGVuZ3RoIC8gNCk7XG4gICAgaWYgKHRvdGFsIDw9IDApIHJldHVybiAxO1xuICAgIGNvbnN0IHN0ZXAgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHRvdGFsIC8gNTEyKSk7XG4gICAgbGV0IHNhbXBsZWQgPSAwO1xuICAgIGxldCBibGFuayA9IDA7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b3RhbDsgaSArPSBzdGVwKSB7XG4gICAgICAgIGNvbnN0IG8gPSBpICogNDtcbiAgICAgICAgc2FtcGxlZCArPSAxO1xuICAgICAgICBpZiAocGl4ZWxzW28gKyAzXSA9PT0gMCB8fCAocGl4ZWxzW29dID09PSAwICYmIHBpeGVsc1tvICsgMV0gPT09IDAgJiYgcGl4ZWxzW28gKyAyXSA9PT0gMCkpIGJsYW5rICs9IDE7XG4gICAgfVxuICAgIHJldHVybiBzYW1wbGVkID4gMCA/IE1hdGgucm91bmQoKGJsYW5rIC8gc2FtcGxlZCkgKiAxMDAwKSAvIDEwMDAgOiAxO1xufVxuXG4vKiog5oqKIFJHQkEg5YOP57Sg57yW56CB5oiQIGRhdGEgVVJM77yIV2ViR0wg5Y6f54K55Zyo5bem5LiL77yM6ZyA6KaB57+76KGM77yJ44CCICovXG5mdW5jdGlvbiBlbmNvZGVGcmFtZVRvRGF0YVVybChcbiAgICBwaXhlbHM6IFVpbnQ4QXJyYXksXG4gICAgd2lkdGg6IG51bWJlcixcbiAgICBoZWlnaHQ6IG51bWJlcixcbiAgICBvcHRzOiB7IG1heFdpZHRoOiBudW1iZXI7IG1pbWU6IHN0cmluZzsgcXVhbGl0eTogbnVtYmVyIH0sXG4pOiB7IGRhdGFVcmw6IHN0cmluZzsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB7XG4gICAgaWYgKHR5cGVvZiBkb2N1bWVudCA9PT0gJ3VuZGVmaW5lZCcgfHwgdHlwZW9mIGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3njq/looPmsqHmnIkgZG9jdW1lbnQuY3JlYXRlRWxlbWVudO+8jOaXoOazleaKiuWDj+e0oOe8lueggeaIkOWbvueJhycpO1xuICAgIH1cbiAgICBjb25zdCBzcmMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICBzcmMud2lkdGggPSB3aWR0aDtcbiAgICBzcmMuaGVpZ2h0ID0gaGVpZ2h0O1xuICAgIGNvbnN0IGN0eCA9IHNyYy5nZXRDb250ZXh0KCcyZCcpO1xuICAgIGlmICghY3R4KSB0aHJvdyBuZXcgRXJyb3IoJ+aLv+S4jeWIsCAyRCDnlLvluIPkuIrkuIvmlocnKTtcblxuICAgIGNvbnN0IGltYWdlID0gY3R4LmNyZWF0ZUltYWdlRGF0YSh3aWR0aCwgaGVpZ2h0KTtcbiAgICBjb25zdCByb3dCeXRlcyA9IHdpZHRoICogNDtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSArPSAxKSB7XG4gICAgICAgIGNvbnN0IGZyb20gPSAoaGVpZ2h0IC0gMSAtIHkpICogcm93Qnl0ZXM7XG4gICAgICAgIGltYWdlLmRhdGEuc2V0KHBpeGVscy5zdWJhcnJheShmcm9tLCBmcm9tICsgcm93Qnl0ZXMpLCB5ICogcm93Qnl0ZXMpO1xuICAgIH1cbiAgICBjdHgucHV0SW1hZ2VEYXRhKGltYWdlLCAwLCAwKTtcblxuICAgIGxldCBvdXQ6IGFueSA9IHNyYztcbiAgICBpZiAob3B0cy5tYXhXaWR0aCA+IDAgJiYgd2lkdGggPiBvcHRzLm1heFdpZHRoKSB7XG4gICAgICAgIGNvbnN0IHNjYWxlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgICAgICBzY2FsZWQud2lkdGggPSBvcHRzLm1heFdpZHRoO1xuICAgICAgICBzY2FsZWQuaGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZCgoaGVpZ2h0ICogb3B0cy5tYXhXaWR0aCkgLyB3aWR0aCkpO1xuICAgICAgICBjb25zdCBzY3R4ID0gc2NhbGVkLmdldENvbnRleHQoJzJkJyk7XG4gICAgICAgIGlmIChzY3R4KSB7XG4gICAgICAgICAgICBzY3R4LmltYWdlU21vb3RoaW5nRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHNjdHguaW1hZ2VTbW9vdGhpbmdRdWFsaXR5ID0gJ2hpZ2gnO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgLyog6ICB5rWP6KeI5Zmo5LiN5pSv5oyB5bCx566X5LqGICovXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzY3R4LmRyYXdJbWFnZShzcmMsIDAsIDAsIHNjYWxlZC53aWR0aCwgc2NhbGVkLmhlaWdodCk7XG4gICAgICAgICAgICBvdXQgPSBzY2FsZWQ7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgZGF0YVVybDogb3V0LnRvRGF0YVVSTChvcHRzLm1pbWUsIG9wdHMucXVhbGl0eSksIHdpZHRoOiBvdXQud2lkdGgsIGhlaWdodDogb3V0LmhlaWdodCB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWcuuaZr+inhuWbvuWHoOS9lSDigJTigJQg57uZ5Li76L+b56iL55qEIEVsZWN0cm9uIOaIquWbvueUqO+8iOi/memHjOWPquOAjOmHj+OAje+8jOS4jeivu+WDj+e0oO+8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8g5YiG5bel77yIKirkuLrku4DkuYjopoHliIYqKu+8ie+8muWDj+e0oOeUseS4u+i/m+eoi+eahCBgd2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKWAg5oqTIOKAlOKAlCDlroPor7vnmoTmmK9cbi8vIENocm9taXVtICoq5ZCI5oiQ5ZCO55qEIHN1cmZhY2UqKu+8jOS4jeWPlyBgcHJlc2VydmVEcmF3aW5nQnVmZmVyOiBmYWxzZWAg5b2x5ZON77yM6L+Y6IO9XG4vLyBgaW52YWxpZGF0ZSgpYCDpgLzlh7rkuIDluKfvvJvov5nkuKTku7bmraPmmK/ogIHnmoQgYGdsLnJlYWRQaXhlbHNgIOWBmuS4jeWIsOeahO+8iOingSBgY2FwdHVyZS50c2Ag5aS06YOo77yJ44CCXG4vLyDogIzjgIzmipPlk6rkuIDlnZfjgI3lj6rmnInlnLrmma/ov5vnqIvnrZTlvpfkuIrvvIzlm6DkuLrlroPmiYvph4zmnInnvJbovpHlmajnm7jmnLrjgIJcbi8vXG4vLyDkuo7mmK/mnKzmlofku7blj6rlm57nrZTkuInkuKrmlbDvvJpcbi8vIDEuIOmhtemdou+8iD0gd2VidmlldyDpgqPkuIDpobXvvInnmoQgQ1NTIOWwuuWvuOS4jiBVUkzvvJtcbi8vIDIuIOeUu+W4g+WcqOmhtemdoumHjOeahOS9jee9ruS4juWwuuWvuO+8m1xuLy8gMy4g6IqC54K555qE55+p5b2i77yIKirpobXpnaIgQ1NTIOWDj+e0oOOAgeW3puS4iuinkuWOn+eCuSoq77yJ44CCXG4vL1xuLy8gIyMg5Z2Q5qCH5Y+j5b6E77yI5Y+q5Zyo6L+Z6YeM5o2i566X5LiA5qyh77yM5Li76L+b56iL6YKj6L655LiN5YaN5o2i566X77yJXG4vL1xuLy8gYENhbWVyYS53b3JsZFRvU2NyZWVuYCDnu5nnmoTmmK8qKuWxj+W5leepuumXtCoq77yaKirlt6bkuIvop5LkuLrljp/ngrnjgIF5IOWQkeS4iioq77yMXG4vLyDljZXkvY3mmK8qKuebuOacuua4suafk+ebruagh+eahOWDj+e0oCoq77yI5Lmf5bCx5piv55S75biD55qEIGRldmljZSDlg4/ntKDvvIzkuI3mmK8gQ1NTIOWDj+e0oO+8ieOAglxuLy8g5o2i5oiQ44CM6aG16Z2iIENTUyDlg4/ntKDjgIHlt6bkuIrop5Lljp/ngrnjgI3opoHkuKTmraXvvJoqKumZpOS7pSBkcHIqKu+8jOWGjeaKiiB5ICoq57+76L+H5p2lKirjgIJcblxuLyoqIOS/neeVmeS4ieS9jeWwj+aVsO+8iOWHoOS9lemHj+Wkn+eUqO+8jOS4lOWbnuaJp+mHjOWPr+ivu++8ieOAgiAqL1xuZnVuY3Rpb24gcm91bmQzKHZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICAgIHJldHVybiBNYXRoLnJvdW5kKHZhbHVlICogMTAwMCkgLyAxMDAwO1xufVxuXG4vKiog5Y+W5LiA5Liq5Y+v6IO95oqb5byC5bi455qE5pWw5YC8IGdldHRlcuOAgiAqL1xuZnVuY3Rpb24gc2FmZU51bWJlcihyZWFkOiAoKSA9PiB1bmtub3duKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSByZWFkKCk7XG4gICAgICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyByb3VuZDModmFsdWUpIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vKiog5oqK5Y+v6IO95p2l6IeqIElQQyDnmoTmlbDlgLzlpLnliLAgYFttaW4sIG1heF1g77yI5LiN5piv5pWw5bCx55SoIGBmYWxsYmFja2DvvInjgIIgKi9cbmZ1bmN0aW9uIGNsYW1wTnVtYmVyKHZhbHVlOiB1bmtub3duLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICAgIGNvbnN0IG51bSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogZmFsbGJhY2s7XG4gICAgcmV0dXJuIE1hdGgubWluKG1heCwgTWF0aC5tYXgobWluLCBudW0pKTtcbn1cblxuLyoqXG4gKiDpobXpnaLvvIh3ZWJ2aWV377yJ55qEIENTUyDlh6DkvZUgKyDlroPoh6rlt7HnmoQgVVJM44CCXG4gKlxuICogYGhyZWZgIOaYryoq5Li76L+b56iL5a6a5L2N6L+Z5LiqIHdlYkNvbnRlbnRzIOeahOmmlumAieWIpOaNrioq77ya57yW6L6R5Zmo6YeM5Y+v6IO95ZCM5pe25pyJ5aW95Yeg5LiqXG4gKiB3ZWJ2aWV377yI5Zy65pmv6KeG5Zu+44CB5ri45oiP6aKE6KeI4oCm77yJ77yM5oyJIFVSTCDnsr7noa7ljLnphY3mr5TmjInjgIznsbvlnovmmK8gd2Vidmlld+OAjeeMnOWPr+mdoOW+l+WkmuOAglxuICovXG5mdW5jdGlvbiBwYWdlR2VvbWV0cnkoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcgJiYgd2luZG93LmxvY2F0aW9uKSB7XG4gICAgICAgICAgICBvdXQuaHJlZiA9IHdpbmRvdy5sb2NhdGlvbi5ocmVmO1xuICAgICAgICAgICAgb3V0LmNzc1dpZHRoID0gd2luZG93LmlubmVyV2lkdGg7XG4gICAgICAgICAgICBvdXQuY3NzSGVpZ2h0ID0gd2luZG93LmlubmVySGVpZ2h0O1xuICAgICAgICAgICAgb3V0LmRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5LiN5piv5rWP6KeI5Zmo546v5aKD5bCx566X5LqG77ya5Li76L+b56iL5Lya6YCA5Zue5Yiw5oyJIFVSTCDnibnlvoHmib4gKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbn1cblxuLyoqIOeUu+W4g+WcqOmhtemdoumHjOeahOS9jee9ru+8iENTUyDlg4/ntKDvvIkrIOWug+eahCBkZXZpY2Ug5YOP57Sg5bC65a+444CCICovXG5mdW5jdGlvbiBjYW52YXNHZW9tZXRyeShjYW52YXM6IGFueSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gICAgaWYgKCFjYW52YXMpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlY3QgPSBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgICBvdXQubGVmdCA9IHJvdW5kMyhyZWN0LmxlZnQpO1xuICAgICAgICAgICAgb3V0LnRvcCA9IHJvdW5kMyhyZWN0LnRvcCk7XG4gICAgICAgICAgICBvdXQuY3NzV2lkdGggPSByb3VuZDMocmVjdC53aWR0aCk7XG4gICAgICAgICAgICBvdXQuY3NzSGVpZ2h0ID0gcm91bmQzKHJlY3QuaGVpZ2h0KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaXvvJrph4/kuI3liLDlsLHlsJHkuIDpobnvvIzkuI3lvbHlk43liKvnmoQgKi9cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgb3V0LmRldmljZVdpZHRoID0gY2FudmFzLndpZHRoO1xuICAgICAgICBvdXQuZGV2aWNlSGVpZ2h0ID0gY2FudmFzLmhlaWdodDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955WlICovXG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog57yW6L6R5Zmo55u45py644CCXG4gKlxuICogYGNjZS5DYW1lcmFgIOaYr+WcuuaZr+mhtemHjOeahCoq5YWo5bGA5Y2V5L6LKirvvIhgZGVjbGFyZSBnbG9iYWwgeyBuYW1lc3BhY2UgY2NlIH1g77yMXG4gKiDop4HnvJbovpHlmajnmoQgYEBjb2Nvcy9jcmVhdG9yLXR5cGVzL2VkaXRvci9wYWNrYWdlcy9zY2VuZS9AdHlwZXMvc2NlbmUuZC50c2DvvInvvIxcbiAqIOWug+eahCBgLmNhbWVyYWAg5bCx5pivIGBFZGl0b3JDYW1lcmFDb21wb25lbnRgIOKAlOKAlCAqKuacrOi6q+WwseaYryBgY2MuQ2FtZXJhYCoq77yMXG4gKiDmiYDku6UgYHdvcmxkVG9TY3JlZW5gIOWPr+S7peebtOaOpeeUqO+8jDJEIC8gM0Qg6KeG5Zu+6YO96K6k44CCXG4gKlxuICog6L+Z5bCx5piv44CM6IqC54K55oiq5Zu+44CN57y655qE6YKj5LiA5Z2X77ya6ICB5a6e546w5Y+q55+l6YGT5pW05byg55S75biD77yM5LiN55+l6YGT6IqC54K555S75Zyo5ZOq44CCXG4gKi9cbmZ1bmN0aW9uIGVkaXRvckNhbWVyYSgpOiB7IG1hbmFnZXI6IGFueTsgY2FtOiBhbnk7IGlzMkQ6IGJvb2xlYW4gfCBudWxsOyBub3RlPzogc3RyaW5nIH0ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1hbmFnZXIgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZSAmJiAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZS5DYW1lcmE7XG4gICAgICAgIGlmICghbWFuYWdlcikgcmV0dXJuIHsgbWFuYWdlcjogbnVsbCwgY2FtOiBudWxsLCBpczJEOiBudWxsLCBub3RlOiAn6L+Z5Liq6L+b56iL6YeM5rKh5pyJIGNjZS5DYW1lcmHvvIjlnLrmma/pobXmiY3mnInvvIknIH07XG4gICAgICAgIGNvbnN0IGNhbSA9IG1hbmFnZXIuY2FtZXJhO1xuICAgICAgICBpZiAoIWNhbSB8fCAhY2FtLmNhbWVyYSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgbWFuYWdlciwgY2FtOiBudWxsLCBpczJEOiBudWxsLCBub3RlOiAnY2NlLkNhbWVyYS5jYW1lcmEg6L+Y5rKh5Yid5aeL5YyW77yI5Zy65pmv6KeG5Zu+5Yia5omT5byA5pe25Lya5pyJ6L+Z5LiA556s77yJJyB9O1xuICAgICAgICB9XG4gICAgICAgIGxldCBpczJEOiBib29sZWFuIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG1hbmFnZXIuaXMyRCA9PT0gJ2Jvb2xlYW4nKSBpczJEID0gbWFuYWdlci5pczJEO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1hbmFnZXIsIGNhbSwgaXMyRCB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBtYW5hZ2VyOiBudWxsLCBjYW06IG51bGwsIGlzMkQ6IG51bGwsIG5vdGU6IGDor7sgY2NlLkNhbWVyYSDlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDlnLrmma/ov5vnqIvnjrDlnKjlpITlnKjlk6rkuKrmqKHlvI8g4oCU4oCUICoq57yW6L6R5Zmo5Zy65pmvIC8g6L+Q6KGM6aKE6KeIIC8g6aKE5Yi25Lu257yW6L6RIC8g5Yqo55S757yW6L6RKirjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjopoHlnKjlnLrmma/ov5vnqIvph4zpl67kuIDmrKFcbiAqXG4gKiDjgIzov5DooYzpooTop4jjgI3vvIjnvJbovpHlmajlt6XlhbfmoI/pgqPpopfmkq3mlL7plK7vvIznvJbovpHlmajoh6rlt7HnmoTlj6vms5XmmK8gZ2FtZSB2aWV3IC8gYGkxOG46cHJldmlldy5nYW1lVmlld2DvvIlcbiAqIOaXtu+8jOeUu+mdoueUsSoq5ri45oiP6Ieq5bex55qE55u45py6KirmuLLmn5PvvIznvJbovpHlmajnm7jmnLrooqsgYFByZXZpZXdQbGF5LmhpZGVFZGl0b3JDYW1lcmEoKWAg6JeP6LW35p2lXG4gKiDvvIhgQHR5cGVzL2NjZS8zZC9tYW5hZ2VyL3ByZXZpZXctcGxheS9pbmRleC5kLnRzYO+8ieOAguS6juaYr+OAjOaMiee8lui+keWZqOebuOacuuaKleWHuuadpeeahOiKgueCueefqeW9ouOAjVxuICog5Zyo6YKj5LiA5Yi7KirkuI3miJDnq4sqKiDigJTigJQg5oiq5Zu+L+ijgeiKgueCuS/ngrnoioLngrnpg73kvJrokL3liLDplJnnmoTlnLDmlrnjgIJcbiAqIOacrOWHveaVsOWwseaYr+aKiui/meS7tuS6iyoq5Zyo5ZSv5LiA5LiA5aSEKiror7TmuIXmpZrvvJrosIHopoHliqjlnZDmoIfvvIzlhYjpl67lroPjgIJcbiAqXG4gKiAjIyDliKTmja7pobrluo/vvIgqKjIwMjYtMTEg55yf5py65a6e5rWL5LmL5ZCO6YeN5a6a55qEKirvvIzmlLnkuYvliY3or7flhYjor7sgYGRvY3Mv5a+554WnLWNvY29zLWV4dGVuc2lvbnMubWRgIMKnOS4377yJXG4gKlxuICogfCDluo8gfCDmnaXmupAgfCDnnJ/mnLrkuIrnmoTlrp7mg4UgfFxuICogfC0tLXwtLS18LS0tfFxuICogfCDikaAgfCBgY2NlLlByZXZpZXdQbGF5Ll9zdGF0ZWDvvIhgJ3N0b3AnIC8gJ3BsYXknIC8gJ3BhdXNlJ2DvvIkgfCAqKuWUr+S4gOS8mumaj+i/kOihjOaAgeWPmOeahOadpea6kCoqIOKAlOKAlCDov5DooYzmgIHlj6rmnInlroPliKTlvpflh7rmnaUgfFxuICogfCDikaEgfCBgU2NlbmVGYWNhZGVNYW5hZ2VyLmdldEN1cnJlbnRGYWNhZGUoKS5tb2RlTmFtZWAgfCDpooTop4gqKui3keedgCoq55qE5pe25YCZ5a6D5LuN54S25pivIGAnZ2VuZXJhbCdg77yI5a6e5rWL77yJ77yM5omA5Lul5Y+q6IO955So5p2l6K6k44CM6aKE5Yi25Lu2L+WKqOeUu+OAjei/meexuyoq6Z2e6L+Q6KGMKirmqKHlvI8gfFxuICogfCDikaIgfCBgU2NlbmVGYWNhZGVNYW5hZ2VyLnF1ZXJ5TW9kZSgpYCB8IOWQjOS4iiB8XG4gKiB8IOKRoyB8IGBnbG9iYWxUaGlzLmlzUHJldmlld1Byb2Nlc3NgIHwg55yf5py65LiK5oGSIGBmYWxzZWDvvIjlrp7mtYvvvInvvIzlvZPkuI3kuobliKTmja4gfFxuICpcbiAqIOKaoCBgX3N0YXRlYCDmmK8qKuengeacieWtl+autSoq77yaYHByZXZpZXctcGxheS9pbmRleC5kLnRzYCDph4zlhazlvIDnmoTlj6rmnIkgYGlzUGF1c2UoKWDjgIJcbiAqIOS5i+aJgOS7pei/mOaYr+eUqOWugyDigJTigJQg55yf5py65LiK5Y+q5pyJ5a6D6K+06K+d566X5pWw77yb6ICMKiror7vkuI3liLDml7bkuI3orrjnjJwqKu+8muWbnumAgOWIsOaXp+WPo+W+hO+8jFxuICog5bm25oqK44CM6K+75LiN5YiwIGBfc3RhdGVg44CN5YaZ6L+bIGBub3RlYO+8iOe8lui+keWZqOWTquWkqeaUueS6huWtl+auteWQje+8jOWbnuaJp+mHjOeri+WIu+eci+W+l+inge+8ieOAglxuICpcbiAqICMjIOmZhOW4puaKpeWHuueahOmHj++8iOWIpOOAjOWGu+S9j+ayoeacieOAjeWPquacieW4p+iuoeaVsOiDveivtOivne+8iVxuICpcbiAqIGBzb3VyY2VzLnRvdGFsRnJhbWVzYCAvIGBkaXJlY3RvclBhdXNlZGAgLyBgZ2FtZVBhdXNlZGAg4oCU4oCUIOWunua1i++8mmBwYXVzZSh0cnVlKWAg5LmL5ZCOXG4gKiBgZnJhbWVzYCAxLjVzIOWGhSAqKiswKirvvIxgc3RlcCgpYCAqKuaBsOWlvSArMSoq44CCXG4gKi9cbmZ1bmN0aW9uIHJlYWRTY2VuZU1vZGUoY2M/OiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbW9kZTogJ3Vua25vd24nLCBydW5uaW5nOiBmYWxzZSwgcGF1c2VkOiBudWxsLCBzb3VyY2VzOiB7fSB9O1xuICAgIGNvbnN0IHNvdXJjZXMgPSBvdXQuc291cmNlcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBjY2VBbnkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcblxuICAgIC8qKiDikaAgUHJldmlld1BsYXkg4oCU4oCUIOi/kOihjOaAgeeahOWUr+S4gOWPr+S/oeadpea6kCAqL1xuICAgIGxldCBwcmV2aWV3U3RhdGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBsYXkgPSBjY2VBbnkgJiYgY2NlQW55LlByZXZpZXdQbGF5O1xuICAgICAgICBzb3VyY2VzLnByZXZpZXdQbGF5UHJlc2VudCA9IEJvb2xlYW4ocGxheSk7XG4gICAgICAgIGlmIChwbGF5KSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJhd1N0YXRlID0gcGxheS5fc3RhdGU7XG4gICAgICAgICAgICAgICAgcHJldmlld1N0YXRlID0gdHlwZW9mIHJhd1N0YXRlID09PSAnc3RyaW5nJyA/IHJhd1N0YXRlIDogbnVsbDtcbiAgICAgICAgICAgICAgICBzb3VyY2VzLnByZXZpZXdTdGF0ZSA9IHByZXZpZXdTdGF0ZTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIHNvdXJjZXMucHJldmlld1N0YXRlRXJyb3IgPSBlcnJvckluZm8oZXJyKS5tZXNzYWdlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBzb3VyY2VzLnByZXZpZXdJc1BhdXNlID0gdHlwZW9mIHBsYXkuaXNQYXVzZSA9PT0gJ2Z1bmN0aW9uJyA/IHBsYXkuaXNQYXVzZSgpIDogbnVsbDtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIHNvdXJjZXMucHJldmlld0lzUGF1c2VFcnJvciA9IGVycm9ySW5mbyhlcnIpLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgc291cmNlcy5wcmV2aWV3UGxheUVycm9yID0gZXJyb3JJbmZvKGVycikubWVzc2FnZTtcbiAgICB9XG5cbiAgICAvKiog4pGh4pGiIGZhY2FkZSDkuKTmnaEg4oCU4oCUIOWPqueUqOadpeiupOmdnui/kOihjOaooeW8j++8iOecn+acuuWunua1i++8mumihOiniOi3keedgOaXtuWug+S7rOaYryBnZW5lcmFs77yJICovXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWFuYWdlciA9IGNjZUFueSAmJiBjY2VBbnkuU2NlbmVGYWNhZGVNYW5hZ2VyO1xuICAgICAgICBpZiAoIW1hbmFnZXIpIHtcbiAgICAgICAgICAgIG91dC5ub3RlID0gJ+i/meS4qui/m+eoi+mHjOayoeaciSBjY2UuU2NlbmVGYWNhZGVNYW5hZ2Vy77yI5Zy65pmv6aG15omN5pyJ77yJJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZmFjYWRlID0gdHlwZW9mIG1hbmFnZXIuZ2V0Q3VycmVudEZhY2FkZSA9PT0gJ2Z1bmN0aW9uJyA/IG1hbmFnZXIuZ2V0Q3VycmVudEZhY2FkZSgpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBzb3VyY2VzLmZhY2FkZU1vZGUgPSBmYWNhZGUgJiYgdHlwZW9mIGZhY2FkZS5tb2RlTmFtZSA9PT0gJ3N0cmluZycgPyBmYWNhZGUubW9kZU5hbWUgOiBudWxsO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgc291cmNlcy5mYWNhZGVNb2RlRXJyb3IgPSBlcnJvckluZm8oZXJyKS5tZXNzYWdlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBzb3VyY2VzLnF1ZXJ5TW9kZSA9IHR5cGVvZiBtYW5hZ2VyLnF1ZXJ5TW9kZSA9PT0gJ2Z1bmN0aW9uJyA/IG1hbmFnZXIucXVlcnlNb2RlKCkgOiBudWxsO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgc291cmNlcy5xdWVyeU1vZGVFcnJvciA9IGVycm9ySW5mbyhlcnIpLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgb3V0Lm5vdGUgPSBg6K+7IGNjZS5TY2VuZUZhY2FkZU1hbmFnZXIg5aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWA7XG4gICAgfVxuXG4gICAgLyoqIOKRoyDpooTop4jov5vnqIvmoIflv5fvvIjnnJ/mnLrmgZIgZmFsc2XvvJvnlZnnnYDlj6rkuLrjgIzljp/moLfmiqXlh7rjgI3vvIkgKi9cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBmbGFnID0gKGdsb2JhbFRoaXMgYXMgYW55KS5pc1ByZXZpZXdQcm9jZXNzO1xuICAgICAgICBzb3VyY2VzLmlzUHJldmlld1Byb2Nlc3MgPSB0eXBlb2YgZmxhZyA9PT0gJ2Jvb2xlYW4nID8gZmxhZyA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHNvdXJjZXMuaXNQcmV2aWV3UHJvY2VzcyA9IG51bGw7XG4gICAgfVxuXG4gICAgLyoqIOKRpCDkuLvlvqrnjq/nmoTkuKTpnaIgKyDluKforqHmlbAgKi9cbiAgICBpZiAoY2MpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHNvdXJjZXMudG90YWxGcmFtZXMgPSBjYy5kaXJlY3Rvci5nZXRUb3RhbEZyYW1lcygpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW8leaTjui/mOayoei1t+adpeWwseeul+S6hiAqL1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzb3VyY2VzLmRpcmVjdG9yUGF1c2VkID0gY2MuZGlyZWN0b3IuaXNQYXVzZWQoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlkIzkuIogKi9cbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgc291cmNlcy5nYW1lUGF1c2VkID0gY2MuZ2FtZS5pc1BhdXNlZCgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWQjOS4iiAqL1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qga25vd24gPSBbJ2dlbmVyYWwnLCAncHJlZmFiJywgJ2FuaW1hdGlvbicsICdwcmV2aWV3J107XG4gICAgY29uc3QgcmF3ID0gW3NvdXJjZXMuZmFjYWRlTW9kZSwgc291cmNlcy5xdWVyeU1vZGVdLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBzdHJpbmcgPT4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyk7XG4gICAgY29uc3QgaGl0ID0gcmF3LmZpbmQoKHZhbHVlKSA9PiBrbm93bi5pbmRleE9mKHZhbHVlKSA+PSAwKTtcblxuICAgIGlmIChwcmV2aWV3U3RhdGUgPT09ICdwbGF5JyB8fCBwcmV2aWV3U3RhdGUgPT09ICdwYXVzZScpIHtcbiAgICAgICAgb3V0Lm1vZGUgPSAncHJldmlldyc7XG4gICAgICAgIG91dC5ydW5uaW5nID0gdHJ1ZTtcbiAgICAgICAgb3V0LnBhdXNlZCA9IHByZXZpZXdTdGF0ZSA9PT0gJ3BhdXNlJztcbiAgICB9IGVsc2UgaWYgKHByZXZpZXdTdGF0ZSA9PT0gJ3N0b3AnKSB7XG4gICAgICAgIG91dC5ydW5uaW5nID0gZmFsc2U7XG4gICAgICAgIG91dC5wYXVzZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKGhpdCAmJiBoaXQgIT09ICdwcmV2aWV3Jykge1xuICAgICAgICAgICAgb3V0Lm1vZGUgPSBoaXQ7XG4gICAgICAgIH0gZWxzZSBpZiAocmF3Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIG91dC5ub3RlID0gYOaooeW8j+S4suiupOS4jeWHuuadpe+8iCR7SlNPTi5zdHJpbmdpZnkocmF3KX3vvInigJTigJQg5Y6f5YC85bey5aaC5a6e5oql5Ye677yM6L+Z6YeM5LiN54ycYDtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDor7vkuI3liLAgYF9zdGF0ZWDvvIjnvJbovpHlmajmlLnkuoblrZfmrrXlkI0gLyDov5nlj7DmnLrlmajkuIrmsqHmnIkgUHJldmlld1BsYXnvvInigJTigJQgKirpgIDlm57ml6flj6PlvoQqKu+8jFxuICAgICAgICAgKiDlubbmmI7or7Tov5nmnaHliKTmja7lj6/kv6HluqbkvY7vvJrnnJ/mnLrlrp7mtYsgZmFjYWRlIOmCo+WHoOadoeWIpOS4jeWHuumihOiniOWcqOi3keOAglxuICAgICAgICAgKi9cbiAgICAgICAgb3V0LnBhdXNlZCA9IG51bGw7XG4gICAgICAgIGlmIChoaXQpIHtcbiAgICAgICAgICAgIG91dC5tb2RlID0gaGl0O1xuICAgICAgICAgICAgb3V0LnJ1bm5pbmcgPSBoaXQgPT09ICdwcmV2aWV3JztcbiAgICAgICAgfSBlbHNlIGlmIChyYXcubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgb3V0Lm5vdGUgPSBg5qih5byP5Liy6K6k5LiN5Ye65p2l77yIJHtKU09OLnN0cmluZ2lmeShyYXcpfe+8ieKAlOKAlCDljp/lgLzlt7LlpoLlrp7miqXlh7rvvIzov5nph4zkuI3njJxgO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHdoeSA9IHNvdXJjZXMucHJldmlld1BsYXlQcmVzZW50XG4gICAgICAgICAgICA/ICfor7vkuI3liLAgY2NlLlByZXZpZXdQbGF5Ll9zdGF0Ze+8iOe8lui+keWZqOWPr+iDveaUueS6huWtl+auteWQje+8iSdcbiAgICAgICAgICAgIDogJ+i/meS4qui/m+eoi+mHjOayoeaciSBjY2UuUHJldmlld1BsYXknO1xuICAgICAgICBvdXQubm90ZSA9IGAke3doeX0g4oCU4oCUIOi/kOihjOaAgeWPquiDveaMiSBmYWNhZGUg6YKj5Yeg5p2h54yc77yM6ICM55yf5py65a6e5rWL5a6D5LusKirliKTkuI3lh7rpooTop4jlnKjot5EqKu+8iOingSBkb2NzL+WvueeFpy1jb2Nvcy1leHRlbnNpb25zLm1kIMKnOS4377yJYDtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiDoioLngrnnmoTnn6nlvaIg4oCU4oCUICoq6aG16Z2iIENTUyDlg4/ntKDjgIHlt6bkuIrop5LkuLrljp/ngrkqKuOAglxuICpcbiAqIOWBmuazle+8muaKiuiKgueCueS4lueVjOefqeW9oueahCA0IOS4quinkuWWgue7mee8lui+keWZqOebuOacuueahCBgd29ybGRUb1NjcmVlbmDvvIzlj5bljIXlm7Tnm5LjgIJcbiAqIOS6juaYr+OAjOinhuWbvue8qeaUvuS6hiAvIOW5s+enu+S6hiAvIOiKgueCueiHquW3sei9rOS6huOAjemDveS4jeeUqOaJi+W3peaOqCDigJTigJQg55u45py65YWo6YO955+l6YGT44CCXG4gKlxuICog5Lik54K56K+a5a6e55qE6L6555WM77yaXG4gKiAtIOS4lueVjOefqeW9oueUqOeahOaYr+i9tOWvuem9kOWMheWbtOebku+8iGBjb250ZW50U2l6ZSDDlyB3b3JsZFNjYWxlYO+8jCoq5LiN5peL6L2sKirvvInvvIxcbiAqICAg5omA5Lul6IqC54K56Ieq6Lqr5bim5peL6L2s5pe25piv5LiA5LiqKirov5HkvLwqKu+8iOWxj+W5leS4iuS7jeaYr+WMheWbtOebku+8jOS4jeaYr+WkluaOpeWkmui+ueW9ou+8ie+8m1xuICogLSDmsqHmnIkgYFVJVHJhbnNmb3JtYCDnmoToioLngrnvvIjnuq8gM0Qg56m66IqC54K577yJ5rKh5pyJ5bC65a+477yMKirnu5nkuI3lh7rnn6nlvaIqKu+8jFxuICogICDov5nml7blpoLlrp7lm54gYHJlY3Q6IG51bGxg77yM55Sx5Li76L+b56iL6YCA5oiQ5pW05byg6KeG5Zu+77yM6ICM5LiN5piv6KOB5LiA5Liq556O54yc55qE5qGG44CCXG4gKi9cbmZ1bmN0aW9uIHByb2plY3ROb2RlUmVjdChcbiAgICBjYzogYW55LFxuICAgIGNhbTogYW55LFxuICAgIG5vZGU6IGFueSxcbiAgICBjYW52YXM6IGFueSxcbik6IHsgcmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGw7IGNhbnZhc1JlY3Q6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsOyBub3RlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IHV0ID0gdHlwZW9mIG5vZGUuZ2V0Q29tcG9uZW50ID09PSAnZnVuY3Rpb24nID8gbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pIDogbnVsbDtcbiAgICBpZiAoIXV0KSByZXR1cm4geyByZWN0OiBudWxsLCBjYW52YXNSZWN0OiBudWxsLCBub3RlOiAn6IqC54K55rKh5pyJIFVJVHJhbnNmb3Jt77yI5rKh5pyJIGNvbnRlbnRTaXpl77yJ77yM566X5LiN5Ye655+p5b2iJyB9O1xuXG4gICAgbGV0IHdpZHRoID0gMDtcbiAgICBsZXQgaGVpZ2h0ID0gMDtcbiAgICBsZXQgYW5jaG9yWCA9IDAuNTtcbiAgICBsZXQgYW5jaG9yWSA9IDAuNTtcbiAgICB0cnkge1xuICAgICAgICB3aWR0aCA9IHV0LndpZHRoIHx8IDA7XG4gICAgICAgIGhlaWdodCA9IHV0LmhlaWdodCB8fCAwO1xuICAgICAgICBhbmNob3JYID0gdHlwZW9mIHV0LmFuY2hvclggPT09ICdudW1iZXInID8gdXQuYW5jaG9yWCA6IDAuNTtcbiAgICAgICAgYW5jaG9yWSA9IHR5cGVvZiB1dC5hbmNob3JZID09PSAnbnVtYmVyJyA/IHV0LmFuY2hvclkgOiAwLjU7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpe+8muS/neaMgem7mOiupCAqL1xuICAgIH1cblxuICAgIGxldCBzY2FsZVggPSAxO1xuICAgIGxldCBzY2FsZVkgPSAxO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHdzID0gbm9kZS53b3JsZFNjYWxlO1xuICAgICAgICBpZiAod3MpIHtcbiAgICAgICAgICAgIHNjYWxlWCA9IE1hdGguYWJzKHdzLngpIHx8IDE7XG4gICAgICAgICAgICBzY2FsZVkgPSBNYXRoLmFicyh3cy55KSB8fCAxO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICBjb25zdCB3b3JsZFdpZHRoID0gd2lkdGggKiBzY2FsZVg7XG4gICAgY29uc3Qgd29ybGRIZWlnaHQgPSBoZWlnaHQgKiBzY2FsZVk7XG4gICAgaWYgKHdvcmxkV2lkdGggPD0gMCB8fCB3b3JsZEhlaWdodCA8PSAwKSB7XG4gICAgICAgIHJldHVybiB7IHJlY3Q6IG51bGwsIGNhbnZhc1JlY3Q6IG51bGwsIG5vdGU6IGDoioLngrnlsLrlr7jkuLogMO+8iGNvbnRlbnRTaXplICR7d2lkdGh9w5cke2hlaWdodH3vvInvvIznrpfkuI3lh7rnn6nlvaJgIH07XG4gICAgfVxuXG4gICAgbGV0IHd4ID0gMDtcbiAgICBsZXQgd3kgPSAwO1xuICAgIGxldCB3eiA9IDA7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgd3AgPSBub2RlLndvcmxkUG9zaXRpb247XG4gICAgICAgIHd4ID0gd3AueDtcbiAgICAgICAgd3kgPSB3cC55O1xuICAgICAgICB3eiA9IHdwLno7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IHJlY3Q6IG51bGwsIGNhbnZhc1JlY3Q6IG51bGwsIG5vdGU6ICfor7vkuI3liLDoioLngrnnmoQgd29ybGRQb3NpdGlvbicgfTtcbiAgICB9XG4gICAgLy8g6ZSa54K55YGP56e777yad29ybGRQb3NpdGlvbiDmmK8qKumUmueCuSoq55qE5L2N572u77yM55+p5b2i5Lit5b+D6KaB5oyJ6ZSa54K56KGl5Zue5p2lXG4gICAgY29uc3QgY3ggPSB3eCArICgwLjUgLSBhbmNob3JYKSAqIHdvcmxkV2lkdGg7XG4gICAgY29uc3QgY3kgPSB3eSArICgwLjUgLSBhbmNob3JZKSAqIHdvcmxkSGVpZ2h0O1xuXG4gICAgcmV0dXJuIHByb2plY3RXb3JsZEJveChjYywgY2FtLCBjYW52YXMsIHsgY3gsIGN5LCB3eiwgd2lkdGg6IHdvcmxkV2lkdGgsIGhlaWdodDogd29ybGRIZWlnaHQgfSk7XG59XG5cbi8qKiDkuIDkuKoqKui9tOWvuem9kOeahOS4lueVjOefqeW9oioq77yIKyDkuIDkuKogeu+8m+aKleW9seimgeS4iee7tOeCue+8ieOAgiAqL1xuaW50ZXJmYWNlIFdvcmxkQm94IHtcbiAgICAvKiog55+p5b2i5Lit5b+D77yI5LiW55WM5Z2Q5qCH77yJICovXG4gICAgY3g6IG51bWJlcjtcbiAgICBjeTogbnVtYmVyO1xuICAgIC8qKiDmipXlvbHnlKjnmoTmt7HluqbvvIgyRCDmraPkuqTkuI7lroPml6DlhbPvvIwzRCDpgI/op4bmnInlhbPns7vvvIkgKi9cbiAgICB3ejogbnVtYmVyO1xuICAgIHdpZHRoOiBudW1iZXI7XG4gICAgaGVpZ2h0OiBudW1iZXI7XG59XG5cbi8qKlxuICog5LiW55WM55+p5b2iIOKGkiAqKumhtemdoiBDU1Mg5YOP57SgKirnn6nlvaLvvIjlt6bkuIrop5Lljp/ngrnvvInjgIJcbiAqXG4gKiDlm5vop5LlloLnu5kgYHdvcmxkVG9TY3JlZW5gIOWGjeWPluWMheWbtOebkiDigJTigJQg6L+Z5piv5YWo5bel56iLKirllK/kuIAqKuS4gOWkhOWBmui/meS4quaNoueul+eahOWcsOaWue+8jFxuICog44CM6IqC54K555+p5b2i44CN5LiO44CM5Y+W5pmv6KaG55uW5Yik5o2u44CN6YO96LWw5a6D77yI5Lik5aSE6Iul5ZCE5YaZ5LiA5Lu977yM6L+f5pep5Lya5a+55LiN5LiK77yJ44CCXG4gKlxuICogQHJldHVybnMgYHJlY3Rg77yI6aG16Z2i5bem5LiK6KeS5Y6f54K577yJ44CBYGNhbnZhc1JlY3Rg77yI55S75biD5YaF44CB55u45a+555S75biD5bem5LiK6KeS77yJ77ybXG4gKiAgIOmHj+S4jeWIsOebuOacuumrmOW6pi9kcHLjgIHmiJYgYHdvcmxkVG9TY3JlZW5gIOaKm+W8guW4uOaXtiBgcmVjdGAg5Li6IG51bGzjgIJcbiAqL1xuZnVuY3Rpb24gcHJvamVjdFdvcmxkQm94KFxuICAgIGNjOiBhbnksXG4gICAgY2FtOiBhbnksXG4gICAgY2FudmFzOiBhbnksXG4gICAgYm94OiBXb3JsZEJveCxcbik6IHsgcmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGw7IGNhbnZhc1JlY3Q6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsOyBub3RlPzogc3RyaW5nIH0ge1xuICAgIC8qKiDlh6DkvZXln7rlh4bvvJp5IOe/u+i9rOeUqOebuOacuuiHquW3seeahOmrmOW6pu+8iOebuOacuuWDj+e0oO+8ie+8jGRwciDku47nlLvluIPmjqjvvIhDU1Mg4oaQIGRldmljZe+8iSAqL1xuICAgIGNvbnN0IGNhbnZhc0JveCA9IGNhbnZhc0dlb21ldHJ5KGNhbnZhcykgfHwge307XG4gICAgY29uc3QgY2FtSGVpZ2h0ID0gc2FmZU51bWJlcigoKSA9PiBjYW0uY2FtZXJhLmhlaWdodCkgfHwgKGNhbnZhc0JveC5kZXZpY2VIZWlnaHQgYXMgbnVtYmVyKSB8fCAwO1xuICAgIGNvbnN0IGNhbnZhc0Nzc1dpZHRoID0gKGNhbnZhc0JveC5jc3NXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgY29uc3QgY2FudmFzRGV2aWNlV2lkdGggPSAoY2FudmFzQm94LmRldmljZVdpZHRoIGFzIG51bWJlcikgfHwgMDtcbiAgICBjb25zdCBkcHIgPSBjYW52YXNDc3NXaWR0aCA+IDAgJiYgY2FudmFzRGV2aWNlV2lkdGggPiAwID8gY2FudmFzRGV2aWNlV2lkdGggLyBjYW52YXNDc3NXaWR0aCA6IHBhZ2VEcHIoKTtcbiAgICBpZiAoIWNhbUhlaWdodCB8fCAhZHByKSB7XG4gICAgICAgIHJldHVybiB7IHJlY3Q6IG51bGwsIGNhbnZhc1JlY3Q6IG51bGwsIG5vdGU6ICfph4/kuI3liLDnm7jmnLrpq5jluqbmiJYgZHBy77yM5peg5rOV5oqK5bGP5bmV56m66Ze05o2i5oiQIENTUyDlg4/ntKAnIH07XG4gICAgfVxuXG4gICAgY29uc3QgVmVjMyA9IGNjLlZlYzM7XG4gICAgY29uc3QgeHM6IG51bWJlcltdID0gW107XG4gICAgY29uc3QgeXM6IG51bWJlcltdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBkeCBvZiBbLTAuNSwgMC41XSkge1xuICAgICAgICAgICAgZm9yIChjb25zdCBkeSBvZiBbLTAuNSwgMC41XSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvaW50ID0gY2FtLndvcmxkVG9TY3JlZW4obmV3IFZlYzMoYm94LmN4ICsgZHggKiBib3gud2lkdGgsIGJveC5jeSArIGR5ICogYm94LmhlaWdodCwgYm94Lnd6KSk7XG4gICAgICAgICAgICAgICAgeHMucHVzaChwb2ludC54IC8gZHByKTtcbiAgICAgICAgICAgICAgICAvLyDlt6bkuIvljp/ngrnjgIF5IOWQkeS4iiDihpIg5bem5LiK5Y6f54K544CBeSDlkJHkuItcbiAgICAgICAgICAgICAgICB5cy5wdXNoKChjYW1IZWlnaHQgLSBwb2ludC55KSAvIGRwcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHsgcmVjdDogbnVsbCwgY2FudmFzUmVjdDogbnVsbCwgbm90ZTogYHdvcmxkVG9TY3JlZW4g5aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICB9XG5cbiAgICBjb25zdCByYXcgPSB7XG4gICAgICAgIHg6IE1hdGgubWluKC4uLnhzKSxcbiAgICAgICAgeTogTWF0aC5taW4oLi4ueXMpLFxuICAgICAgICB3aWR0aDogTWF0aC5tYXgoLi4ueHMpIC0gTWF0aC5taW4oLi4ueHMpLFxuICAgICAgICBoZWlnaHQ6IE1hdGgubWF4KC4uLnlzKSAtIE1hdGgubWluKC4uLnlzKSxcbiAgICB9O1xuICAgIGNvbnN0IGxlZnQgPSAoY2FudmFzQm94LmxlZnQgYXMgbnVtYmVyKSB8fCAwO1xuICAgIGNvbnN0IHRvcCA9IChjYW52YXNCb3gudG9wIGFzIG51bWJlcikgfHwgMDtcbiAgICBjb25zdCBjYW52YXNSZWN0ID0ge1xuICAgICAgICB4OiByb3VuZDMocmF3LngpLFxuICAgICAgICB5OiByb3VuZDMocmF3LnkpLFxuICAgICAgICB3aWR0aDogcm91bmQzKHJhdy53aWR0aCksXG4gICAgICAgIGhlaWdodDogcm91bmQzKHJhdy5oZWlnaHQpLFxuICAgIH07XG4gICAgY29uc3QgcmVjdCA9IHtcbiAgICAgICAgeDogcm91bmQzKHJhdy54ICsgbGVmdCksXG4gICAgICAgIHk6IHJvdW5kMyhyYXcueSArIHRvcCksXG4gICAgICAgIHdpZHRoOiByb3VuZDMocmF3LndpZHRoKSxcbiAgICAgICAgaGVpZ2h0OiByb3VuZDMocmF3LmhlaWdodCksXG4gICAgfTtcblxuICAgIC8qKiDoh6rmo4DvvJrnrpflh7rmnaXnmoTmoYblupTlvZPokL3lnKjnlLvluIPlhoXjgILotornlYzor7TmmI7kuIrpnaLpgqPmnaHlj6PlvoTlnKjov5nlj7DmnLrlmajkuIrkuI3miJDnq4vvvIzlpoLlrp7miqXlh7rmnaUgKi9cbiAgICBjb25zdCBvdXRzaWRlID1cbiAgICAgICAgY2FudmFzQ3NzV2lkdGggPiAwICYmXG4gICAgICAgIChyZWN0LnggKyByZWN0LndpZHRoIDwgMCB8fFxuICAgICAgICAgICAgcmVjdC55ICsgcmVjdC5oZWlnaHQgPCAwIHx8XG4gICAgICAgICAgICByZWN0LnggPiBsZWZ0ICsgY2FudmFzQ3NzV2lkdGggfHxcbiAgICAgICAgICAgIHJlY3QueSA+IHRvcCArICgoY2FudmFzQm94LmNzc0hlaWdodCBhcyBudW1iZXIpIHx8IDApKTtcbiAgICByZXR1cm4ge1xuICAgICAgICByZWN0LFxuICAgICAgICBjYW52YXNSZWN0LFxuICAgICAgICBub3RlOiBvdXRzaWRlXG4gICAgICAgICAgICA/ICfimqAg5oqV5b2x5Ye65p2l55qE55+p5b2i6JC95Zyo55S75biD5aSW77yI55u45py65oiWIGRwciDlj6PlvoTlj6/og73kuI3miJDnq4vvvInigJTigJQg6K+35qC45a+5IGNhbWVyYSAvIGNhbnZhcyDlrZfmrrUnXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9O1xufVxuXG4vKiog6aG16Z2i6Ieq5bex55qEIGRwcu+8iOaLv+S4jeWIsOeUu+W4g+WwuuWvuOaXtueahOWFnOW6le+8ieOAgiAqL1xuZnVuY3Rpb24gcGFnZURwcigpOiBudW1iZXIge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJykgcmV0dXJuIHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICByZXR1cm4gMTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMYWJlbCDmjpLniYjluqbph48g4oCU4oCUIGBsYWJlbEZpdGAg55qE566X5pyv5Z+656GA77yI5bi45pWw5YWo5pivKirlrp7mtYsqKuadpeeahO+8jOS4jeaYr+aKhOaWh+aho++8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gQ29jb3MgQ3JlYXRvciAzLjguNu+8jOeUqOS4gOS4qioq5ri456a7IExhYmVsKirvvIhgbmV3IGNjLk5vZGUoKWDvvIzku47kuI3ov5vlnLrmma/vvIkrXG4vLyBgdXBkYXRlUmVuZGVyRGF0YSh0cnVlKWAg6YeP55qE44CC5LiJ5p2h57uT6K6677yaXG4vL1xuLy8gMS4gKiroioLngrnlhoXlrrnpq5gqKu+8iGBvdmVyZmxvdyA9IE5PTkUgLyBSRVNJWkVfSEVJR0hUYO+8jOWNs+W8leaTjuiHquW3seaSkemrmOaXtu+8ie+8mlxuLy9cbi8vICAgICAgICBjb250ZW50SGVpZ2h0ID0gKOihjOaVsCDiiJIgMSkgw5cg6KGM6L+b57uZICsg6KGM6L+b57uZIMOXIDEuMjZcbi8vXG4vLyAgICDlhavnu4TmoLfmnKzlhajkuK3vvJpmczE0L2xoMC/moYblrr0gMTAwIOW+l+S4pOihjCDihpIgMzEuNjTvvIg9IDE0ICsgMTcuNjTvvInvvJtcbi8vICAgIGZzMjAvbGgwL+ahhuWuvSAxMDAg5b6X5Lik6KGMIOKGkiA0NS4y77yIPSAyMCArIDI1LjLvvInvvJtsaDQwIOS4gOihjCDihpIgNTAuNO+8m1xuLy8gICAgbGg2NiDkuIDooYwg4oaSIDgzLjE277ybbGgyMC9mczIwIOS4gOihjCDihpIgMjUuMuOAguS5n+WwseaYr+ivtFxuLy8gICAgKirmnIDlkI7kuIDooYzmr5TliKvnmoTooYzlpJogMC4yNiDlgI3ooYzov5vnu5kqKuOAglxuLy8gMi4gKirooYzov5vnu5kqKu+8iOavj+WkmuS4gOihjOW+gOS4i+i1sOWkmuWwke+8iT0gYGxpbmVIZWlnaHQgPiAwID8gbGluZUhlaWdodCA6IGZvbnRTaXplYOOAglxuLy8gICAg4pqgIGBfbGluZUhlaWdodCA9IDBgIOaXtuW8leaTjuWbnuiQveWIsCAqKmBmb250U2l6ZWAqKu+8jOS4jeaYryBgZm9udFNpemUgw5cgMS4yNmDvvJtcbi8vICAgIOiAjCBgbGFiZWwubGluZUhlaWdodGAg6L+Z5LiqIGdldHRlciDkvJoqKuWOn+agt+WbniAwKiog4oCU4oCUIOaJgOS7peWugyoq5LiN6IO9KirlvZPluqbph4/nlKhcbi8vICAgIO+8iOi4qei/h++8muaLv+Wug+eul+WHulwi6IO95pS+IDMg6KGMXCLvvIzlrp7pmYXlj6rmlL7lvpfkuIsgMiDooYzvvInjgIJcbi8vIDMuICoq5a2X56ym5a695bqmKirvvIhBcmlhbO+8jGVtIOWAjeaVsO+8ie+8mkNKSyDkuI7lhajop5LmoIfngrkgYDEuMDAwYOOAgeWkp+WGmSBgMC42Njdg44CBXG4vLyAgICDlsI/lhpnkuI7mlbDlrZcgYDAuNTU2YOOAgeepuuagvCBgMC4yNzhg44CC44CMQ0pLID0gMWVt44CN5piv6YeP5Ye65p2l55qE77yIYCfllYonYCDlnKggZnMyMCDkuIvlrr0gMjAuMO+8ieOAglxuLy9cbi8vIOKaoCDkuIDmnaHor5rlrp7nmoTovrnnlYzvvJrkuIrpnaLnrKwgMSDmnaHnmoTlhazlvI/mmK/ku47jgIzlvJXmk47mkpHlh7rmnaXnmoToioLngrnpq5jjgI3lj43mjqjnmoTvvIxcbi8vIOiAjCBgQ0xBTVBgIOeahCoq5oiq5pat6ZiI5YC8KirmiJHnlKjkuoblkIzkuIDmnaHlhazlvI/nmoTpgIbvvIhg5pyA5aSa6KGM5pWwID0gZmxvb3Io5qGG6auYIC8g6KGM6L+b57uZIOKIkiAwLjI2KWDvvInjgIJcbi8vIOWugyoq5aSN546w5LqG5a6e5rWL55qE5Lik5Liq546w5Zy6KirvvIjmoYbpq5ggNDQgLyDooYzov5vnu5kgMjAuOCDihpIg56ysIDIg6KGM5pW06KGM6KKr6KOB5o6J77ybXG4vLyDmoYbpq5ggNzIgLyDooYzov5vnu5kgMjQg4oaSIDIg6KGM5pS+5b6X5LiL44CBMyDooYzopoEgNzguMjQg5pS+5LiN5LiL77yJ77yM5L2G5byV5pOO5YaF6YOo55yf5q2j55So5ZOq5p2h5Yik5o2uXG4vLyAqKuayoeacieivu+a6kOeggeehruiupCoq44CC5omA5LulIGBsYWJlbEZpdGAg5oqK55So5Yiw55qE5YWs5byPKirljp/moLflhpnov5vlm57miacqKu+8iGBmb3JtdWxhYCDlrZfmrrXvvInvvIxcbi8vIOWIq+aKiuWug+W9k+m7keeuseOAglxuXG4vKiog5byV5pOO5pKR6auY5pe244CM5pyA5ZCO5LiA6KGM44CN55qE6aKd5aSW57O75pWwIOKAlOKAlCDop4HkuIrpnaLnrKwgMSDmnaHvvIg4IOe7hOagt+acrOWunua1i++8ieOAgiAqL1xuY29uc3QgTEFCRUxfTEFTVF9MSU5FX0ZBQ1RPUiA9IDEuMjY7XG5cbi8qKiDlrZfnrKblrr3luqbnmoTlhZzlupXooajvvIhlbSDlgI3mlbDvvInjgILpobXpnaLkuIrmnIkgRE9NIOaXtuS8mOWFiOi1sCBjYW52YXMgYG1lYXN1cmVUZXh0YO+8jOi/meW8oOihqOWPquS9nOWFnOW6leOAgiAqL1xuY29uc3QgRU1fV0lEVEg6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IGNqazogMSwgdXBwZXI6IDAuNjY3LCBsb3dlcjogMC41NTYsIGRpZ2l0OiAwLjU1Niwgc3BhY2U6IDAuMjc4IH07XG5cbi8qKiDkuIDkuKrlrZfnrKblsZ7kuo7lk6rkuIDnsbvvvIjlhrPlrprlhZzlupXlrr3luqbvvInjgIIgKi9cbmZ1bmN0aW9uIGVtQ2xhc3NPZihjaDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBjb2RlID0gY2guY29kZVBvaW50QXQoMCkgfHwgMDtcbiAgICBpZiAoY2ggPT09ICcgJyB8fCBjaCA9PT0gJ1xcdCcpIHJldHVybiAnc3BhY2UnO1xuICAgIGlmIChjb2RlID49IDB4MzAgJiYgY29kZSA8PSAweDM5KSByZXR1cm4gJ2RpZ2l0JztcbiAgICBpZiAoY29kZSA+PSAweDQxICYmIGNvZGUgPD0gMHg1YSkgcmV0dXJuICd1cHBlcic7XG4gICAgaWYgKGNvZGUgPj0gMHg2MSAmJiBjb2RlIDw9IDB4N2EpIHJldHVybiAnbG93ZXInO1xuICAgIGlmIChjb2RlIDwgMHgyZTgwKSByZXR1cm4gJ2xvd2VyJzsgLy8g5ouJ5LiB5qCH54K5L+espuWPt+aMieWwj+WGmeWuveW6pui/keS8vFxuICAgIHJldHVybiAnY2prJzsgLy8gQ0pLIC8g5YWo6KeS5qCH54K5IC8g5YGH5ZCNIC8g6Z+p5paHIOKAlOKAlCDkuIDlvosgMWVtXG59XG5cbi8qKiDph4/mloflrZfnlKjnmoQgMkQg5LiK5LiL5paH77yI5qih5Z2X57qn57yT5a2Y77yb5Y+W5LiN5Yiw5bCxIG51bGzvvIzosIPnlKjmlrnotbDlhZzlupXooajvvInjgIIgKi9cbmxldCBtZWFzdXJlQ3R4Q2FjaGU6IGFueSA9IG51bGw7XG5cbi8qKlxuICog5ou/5LiA5LiqIDJEIOS4iuS4i+aWh+adpemHj+Wtl+OAglxuICpcbiAqIOKaoCAqKuWPque8k+WtmOaIkOWKn+eahOe7k+aenCoq77ya5aSx6LSl5pe25q+P5qyh6YO96YeN6K+V44CC6Lip6L+H55qE55CG55Sx5b6I5a6e5ZyoIOKAlOKAlCDlnLrmma/pobXliJrmiZPlvIDnmoTpgqPkuIDnnqxcbiAqIGBkb2N1bWVudGAg5Y+v6IO96L+Y5rKh5bCx57uq77yM5aaC5p6c6YKj5pe25oqK44CM5rKh5pyJ5LiK5LiL5paH44CN57yT5a2Y5LiL5p2l77yM5LmL5ZCOKirkuIDmlbTlsYDpg73ph4/kuI3kuoblrZcqKu+8jFxuICog6ICM55eH54q25piv44CM5a695bqm5oKE5oKE6YCA5YyW5oiQ5Lyw566X44CN4oCU4oCU5b6I6Zq+5p+l44CC6YeN6K+V55qE5Luj5Lu35Y+q5piv5LiA5qyhIGBjcmVhdGVFbGVtZW50YOOAglxuICovXG5mdW5jdGlvbiBtZWFzdXJlQ29udGV4dCgpOiBhbnkge1xuICAgIGlmIChtZWFzdXJlQ3R4Q2FjaGUpIHJldHVybiBtZWFzdXJlQ3R4Q2FjaGU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZG9jID0gKGdsb2JhbFRoaXMgYXMgYW55KS5kb2N1bWVudDtcbiAgICAgICAgaWYgKGRvYyAmJiB0eXBlb2YgZG9jLmNyZWF0ZUVsZW1lbnQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhbnZhcyA9IGRvYy5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICAgICAgICAgIG1lYXN1cmVDdHhDYWNoZSA9IGNhbnZhcyAmJiB0eXBlb2YgY2FudmFzLmdldENvbnRleHQgPT09ICdmdW5jdGlvbicgPyBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKSA6IG51bGw7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgbWVhc3VyZUN0eENhY2hlID0gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIG1lYXN1cmVDdHhDYWNoZTtcbn1cblxuLyoqXG4gKiDkuIDmrrXmloflrZfnmoTlrr3luqbvvIhweO+8ieOAglxuICpcbiAqICoq5pyJIERPTSDlsLHnnJ/ph48qKu+8iGBjdHgubWVhc3VyZVRleHRg77yM5LiO5byV5pOOIFRURiDmjpLniYjlkIzkuIDmiorlsLrlrZDvvInvvIzmsqHmnInmiY3nlKjlhZzlupXooajkvLDjgIJcbiAqIOWbnuaJp+mHjOW4piBgbWV0aG9kYO+8jOiwg+eUqOaWueS4gOecvOeci+W+l+WHuui/meS4quaVsOaYr+mHj+WHuuadpeeahOi/mOaYr+S8sOWHuuadpeeahOOAglxuICovXG5mdW5jdGlvbiBtZWFzdXJlVGV4dFdpZHRoKFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBmb250U2l6ZTogbnVtYmVyLFxuICAgIGZvbnRGYW1pbHk6IHN0cmluZyxcbik6IHsgd2lkdGg6IG51bWJlcjsgbWV0aG9kOiAnY2FudmFzJyB8ICdlc3RpbWF0ZScgfSB7XG4gICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0ID09IG51bGwgPyAnJyA6IHRleHQpO1xuICAgIGlmIChzLmxlbmd0aCA9PT0gMCB8fCAhKGZvbnRTaXplID4gMCkpIHJldHVybiB7IHdpZHRoOiAwLCBtZXRob2Q6ICdlc3RpbWF0ZScgfTtcbiAgICBjb25zdCBjdHggPSBtZWFzdXJlQ29udGV4dCgpO1xuICAgIGlmIChjdHgpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGN0eC5mb250ID0gYCR7Zm9udFNpemV9cHggJHtmb250RmFtaWx5IHx8ICdBcmlhbCd9YDtcbiAgICAgICAgICAgIGNvbnN0IHdpZHRoID0gY3R4Lm1lYXN1cmVUZXh0KHMpLndpZHRoO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB3aWR0aCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHdpZHRoKSkgcmV0dXJuIHsgd2lkdGgsIG1ldGhvZDogJ2NhbnZhcycgfTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDokL3liLDlhZzlupXooaggKi9cbiAgICAgICAgfVxuICAgIH1cbiAgICBsZXQgdG90YWwgPSAwO1xuICAgIGZvciAoY29uc3QgY2ggb2YgcykgdG90YWwgKz0gKEVNX1dJRFRIW2VtQ2xhc3NPZihjaCldIHx8IDAuNTU2KSAqIGZvbnRTaXplO1xuICAgIHJldHVybiB7IHdpZHRoOiB0b3RhbCwgbWV0aG9kOiAnZXN0aW1hdGUnIH07XG59XG5cbi8qKlxuICog5b+r54Wn5LuTIOKAlOKAlCAqKuW/hemhu+aYr+aooeWdl+e6p+eahCoq44CCXG4gKlxuICogYG1ha2VIZWxwZXJzKClgIOavj+i3keS4gOauteS7o+eggeWwsemHjeW7uuS4gOasoemXreWMhe+8jOaUvuWcqOmXreWMhemHjOeahOS4nOilv+S4i+S4gOauteS7o+eggeWwseeci+S4jeingeS6hu+8m1xuICog6ICM44CM5pS55LmL5YmN5a2Y5LiA5Lu944CB5pS55LmL5ZCOIGRpZmbjgI3lpKnnlJ/ot6jkuKTmrKHosIPnlKjjgILmiYDku6XlrZjlnKjmqKHlnZfkvZznlKjln5/vvIzmjIkgYGxhYmVsYCDlj5bnlKjjgIJcbiAqL1xuY29uc3Qgc25hcHNob3RTdG9yZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTtcblxuLyoqIOacgOWkmueVmeWHoOS7veW/q+eFp++8iOi2heS6hua3mOaxsOacgOaXp+eahO+8ieOAguWkn+OAjGJlZm9yZS9hZnRlcuOAjeeUqO+8jOWPiOS4jeS8muaKiuWcuuaZr+i/m+eoi+aSkeiDluOAgiAqL1xuY29uc3QgU05BUFNIT1RfS0VFUCA9IDEyO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWPluaZr++8iGZyYW1pbmfvvInigJTigJQg44CM5oqK6KaB5ouN55qE5Lic6KW/5YWI5qGG6L+b55S75biD77yM5oiq5a6M5YaN6L+Y5Y6f6KeG6KeS44CNXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vXG4vLyAjIyDkuLrku4DkuYjlv4XpobvmnInov5nkuIDmrrVcbi8vXG4vLyBgY2FwdHVyZVBhZ2UoKWAg5oqT55qE5pivKirlsY/luZXkuIrnjrDlnKjov5nkuIDluKcqKuOAguS6juaYr+eUqOaIt+aKiuWcuuaZr+inhuWbvue8qeaUvi/lubPnp7vov4fkuYvlkI7vvIxcbi8vIOaKk+WIsOeahOWwseWPquaYr+S7luW9k+aXtueci+eahOmCo+Wdl+WcsOaWuSDigJTigJQg5oOz5oiq44CM5pW05Liq5Zy65pmv44CN5pe26YKj5LiN5piv5YWo6LKMXG4vLyDvvIjlrp7mtYvvvJo3MjDDlzE1NjAg55qE6K6+6K6h5YiG6L6o546H77yM55So5oi357yp5YiwIDIwMCUg55yL5LiA5byg5Y2h77yM5oiq5Zu+6YeM5bCx5Y+q5pyJ6YKj5byg5Y2h77yJ44CCXG4vL1xuLy8g6ICM5Zy65pmv6L+b56iL5omL6YeM5pyJ57yW6L6R5Zmo55u45py677yMKirog73mlLnlroPnmoTlj5bmma8qKu+8muWFiOahhuS9j+imgeaLjeeahOS4nOilvyDihpIg5oiq5Zu+IOKGkiDov5jljp/jgIJcbi8vXG4vLyAjIyDkuInnuqflj5bmma/vvJrmjInjgIzosIHnmoTmlrnms5Xmm7TmraPnu5/jgI3mjpLluo/vvIzpgJDnuqcqKumHj+edgOmqjCoq77yM6aqM5LiN6L+H5omN6ZmN57qnXG4vL1xuLy8gfCBzdGVwIHwg5YGa5rOVIHwg5Li65LuA5LmI5o6S6L+Z5Liq5L2N572uIHxcbi8vIHwtLS18LS0tfC0tLXxcbi8vIHwgMCB8IGBjY2UuQ2FtZXJhLmZvY3VzKHV1aWRzLCB1bmRlZmluZWQsIHRydWUpYCB8IOe8lui+keWZqOiHquW3seeahOOAjEYg6IGa54Sm44CN44CC5a6D5YaF6YOo5Lya5ZCM5q2lIDJELzNEIOaOp+WItuWZqOeahOeKtuaAge+8iOe9keagvC/moIflsLov5ZCO57ut5Lqk5LqS6YO95LiN5Lya6ZSZ5L2N77yJ77yMKirpppbpgIkqKiB8XG4vLyB8IDEgfCBgY29udHJvbGxlcjJELl9hZGp1c3RUb0NlbnRlcihtYXJnaW4sIHJlY3QsIHRydWUpYCB8IDJEIOaOp+WItuWZqOiHquW3seeahOOAjOmAgumFjeWGheWuueOAje+8jOaYvuW8j+S8oOaIkeS7rOeul+WHuuadpeeahOefqeW9oiDigJTigJQg57uV5byAIGZvY3VzIOmCo+Wll+WMheWbtOebkuWPo+W+hCB8XG4vLyB8IDIgfCAqKuaJi+W3pSoq77yI5LuFIDJEIOato+S6pO+8iSB8IOmHj+WHuuOAjOWDj+e0oC/kuJbnlYzljZXkvY3jgI3lho3mioogYG9ydGhvSGVpZ2h0YCDkuI7nm7jmnLrkvY3nva7nrpflm57ljrvjgILimqAg5a6D5LyaKirnu5Xov4fmjqfliLblmagqKu+8jOaOp+WItuWZqOWGhemDqOiusOeahOinhuinkuS4juecn+WunuinhuinkuS8muaaguaXtuS4jeS4gOiHtCDigJTigJQg5omA5Lul5Y+q5ZyoIDAvMSDpg73moYbkuI3lhajml7bmiY3nlKggfFxuLy9cbi8vIOavj+e6p+WBmuWujOmDveimgSoq6YeN5paw6YeP5LiA6YGNKirvvIhgdmlld01ldHJpY3NgIOeahCBgZnJhbWluZ2DvvInvvJrliKTmja7mmK/jgIznm67moIfnmoTnn6nlvaLmmK/kuI3mmK9cbi8vIOaVtOS4quiQveWcqOeUu+W4g+mHjOOAje+8jOmHj+S4jei/h+WwsemZjee6p+OAgui/meagt+WwseS4jeW/heeMnOe8lui+keWZqOWGhemDqOaAjuS5iOeul+eahCDigJTigJQg56ys5LiA57qn6IO95oiQ5bCx5LiN5Lya55So5Yiw56ys5LqM57qn44CCXG4vL1xuLy8gIyMg6L+Y5Y6f5pivKirlv4XpobsqKueahFxuLy9cbi8vIOeUqOaIt+inhuinkuS4jeiDveiiq+aIkeS7rOeVmeWcqOWIq+WkhOOAgmBmaXRWaWV3KHthY3Rpb246J2VuZCd9KWAg5YWI6K+V57yW6L6R5Zmo6Ieq5bex55qEXG4vLyBgZm9jdXMobnVsbCwgc2F2ZWRJbmZvLCB0cnVlKWDvvIzkuI3ooYzlho3miornm7jmnLrlrZfmrrXnm7TmjqXlhpnlm57vvIzkuKTmnaHpg73kuI3ooYzlsLHlpoLlrp7lm55cbi8vIGByZXN0b3JlZDpmYWxzZWDvvIgqKuWIq+WBh+ijhei/mOWOn+S6hioqIOKAlOKAlCDpgqPkvJrorqnnlKjmiLfku6XkuLrnlLvpnaLmsqHliqjov4fvvInjgIJcbi8vXG4vLyAjIyDlnZDmoIfns7tcbi8vXG4vLyDnm67moIfnmoTnn6nlvaLnu5/kuIDnlKgqKuS4lueVjOWdkOaghyoq77yIeSDlkJHkuIrvvInmj4/ov7DvvIzmipXlvbHlj6rotbAgYHByb2plY3RXb3JsZEJveGAg5LiA5aSE77ybXG4vLyDliKTjgIzmi43lhajkuobmsqHmnInjgI3nlKjnmoTmmK8qKumhtemdoiBDU1Mg5YOP57SgKirnmoTnn6nlvaLkuI7nlLvluIPnn6nlvaLvvIhgY2FudmFzR2VvbWV0cnlg77yJ77yMXG4vLyDkuI7oo4HliIcv6JC955uY6YKj5p2h6ZO+6Lev5ZCM5LiA5Y+j5b6E44CCXG5cbi8qKiDlj5bmma/ml7blhoXlrrnlm5vlkajnlZnnmoTnqbrnmb3mr5TkvovvvIjnm7jlr7nnlLvluIPnn63ovrnvvInigJTigJQg6LS06L655Lya6K6p5o+P6L65L+mYtOW9seiiq+WIh+aOieOAgiAqL1xuY29uc3QgRklUX01BUkdJTiA9IDAuMDg7XG5cbi8qKiDnm7jmnLrlg4/ntKDph4zlhYHorrjnmoTjgIzmsqHmi43lhajjgI3lrrnlt67vvJrmipXlvbHkuI7nnJ/lrp7muLLmn5PkuYvpl7TnmoToiI3lhaXkuI3lgLzlvpfliKTmiJDlpLHotKXjgIIgKi9cbmNvbnN0IENPVkVSQUdFX1RPTEVSQU5DRV9QWCA9IDI7XG5cbi8qKiDmiYvlt6Xlj5bmma/ml7bph4/mlpznjofnmoTmjqLpkojplb/luqbvvIjkuJbnlYzljZXkvY3vvInigJTigJQg5Y+W5aSn5LiA54K56Lqy5byA5rWu54K55Zmq5aOw44CCICovXG5jb25zdCBQUk9CRV9VTklUUyA9IDEwMDtcblxuLyoqIGBmaXRgIOeahOebruagh+aPj+i/sO+8iOS4u+i/m+eoi+WPquivtOimgeaLjeOAjOWcuuaZr+OAjei/mOaYr+OAjOafkOS4quiKgueCueOAje+8ieOAgiAqL1xuaW50ZXJmYWNlIEZpdFNwZWMge1xuICAgIGtpbmQ6ICdzY2VuZScgfCAnbm9kZSc7XG4gICAgLyoqIGBraW5kOiAnbm9kZSdgIOaXtueahOiKgueCueW8leeUqO+8iHV1aWQg5oiW6Lev5b6E77yJICovXG4gICAgcmVmOiBzdHJpbmc7XG59XG5cbi8qKiDop6PmnpDkuLvov5vnqIvkvKDmnaXnmoQgYGZpdGAg5a2X5q6177yb6K6k5LiN5Ye65bCx5ZueIG51bGzvvIg9IOS4jeWPluaZr++8ieOAgiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplRml0U3BlYyhyYXc6IHVua25vd24pOiBGaXRTcGVjIHwgbnVsbCB7XG4gICAgY29uc3QgdmFsdWUgPSByYXcgYXMgeyBraW5kPzogdW5rbm93bjsgcmVmPzogdW5rbm93biB9IHwgbnVsbDtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGtpbmQgPSB2YWx1ZS5raW5kID09PSAnbm9kZScgPyAnbm9kZScgOiB2YWx1ZS5raW5kID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6IG51bGw7XG4gICAgaWYgKCFraW5kKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4geyBraW5kLCByZWY6IHR5cGVvZiB2YWx1ZS5yZWYgPT09ICdzdHJpbmcnID8gdmFsdWUucmVmLnRyaW0oKSA6ICcnIH07XG59XG5cbi8qKiDpobXpnaLkuIrnlLvluIPnmoTkvY3nva7kuI7lsLrlr7jvvIgqKumhtemdoiBDU1Mg5YOP57SgKirvvInigJTigJQg44CM5ouN5YWo5LqG5rKh5pyJ44CN55qE5Y+C54Wn57O744CCICovXG5mdW5jdGlvbiB2aWV3cG9ydE9mKGNhbnZhczogYW55KTogeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IG51bGwge1xuICAgIGNvbnN0IGJveCA9IGNhbnZhc0dlb21ldHJ5KGNhbnZhcyk7XG4gICAgaWYgKCFib3gpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHdpZHRoID0gKGJveC5jc3NXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgY29uc3QgaGVpZ2h0ID0gKGJveC5jc3NIZWlnaHQgYXMgbnVtYmVyKSB8fCAwO1xuICAgIGlmICh3aWR0aCA8PSAwIHx8IGhlaWdodCA8PSAwKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4geyB4OiAoYm94LmxlZnQgYXMgbnVtYmVyKSB8fCAwLCB5OiAoYm94LnRvcCBhcyBudW1iZXIpIHx8IDAsIHdpZHRoLCBoZWlnaHQgfTtcbn1cblxuLyoqXG4gKiDjgIzov5nkuKrnn6nlvaLmi43lhajkuobmsqHmnInjgI3igJTigJQg5Y+W5pmv6ZO+55qEKirllK/kuIDliKTmja4qKuOAglxuICpcbiAqIEBwYXJhbSBwYWdlUmVjdCAtIOebruagh+efqeW9ou+8iOmhtemdoiBDU1Mg5YOP57Sg77yJ44CCXG4gKiBAcGFyYW0gdmlld3BvcnQgLSDnlLvluIPnn6nlvaLvvIjpobXpnaIgQ1NTIOWDj+e0oO+8ieOAglxuICogQHJldHVybnMgYGNvdmVyZWRg77yI5Zub6L656YO95Zyo55S75biD5YaF77yM5a655beuIDJweO+8ieOAgWBlZGdlc2DvvIjlm5vovrnnmoQqKuWGheS+p+S9memHjyoq77yM6LSf5pWwID0g6LaF5Ye65aSa5bCR77yJ44CBXG4gKiAgIGBhcmVhUmF0aW9g77yI5LiO55S75biD55qEKirkuqTpm4YqKumdouenr+WNoOavlCDigJTigJQg6LeR5Ye65bGP5bmV55qE5YaF5a655LiN6IO95ou/6Ieq5bex55qE6Z2i56ev5YWF5pWw77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGNvdmVyYWdlT2YoXG4gICAgcGFnZVJlY3Q6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4sXG4gICAgdmlld3BvcnQ6IHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0sXG4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgZWRnZXMgPSB7XG4gICAgICAgIGxlZnQ6IHJvdW5kMyhwYWdlUmVjdC54IC0gdmlld3BvcnQueCksXG4gICAgICAgIHJpZ2h0OiByb3VuZDModmlld3BvcnQueCArIHZpZXdwb3J0LndpZHRoIC0gKHBhZ2VSZWN0LnggKyBwYWdlUmVjdC53aWR0aCkpLFxuICAgICAgICB0b3A6IHJvdW5kMyhwYWdlUmVjdC55IC0gdmlld3BvcnQueSksXG4gICAgICAgIGJvdHRvbTogcm91bmQzKHZpZXdwb3J0LnkgKyB2aWV3cG9ydC5oZWlnaHQgLSAocGFnZVJlY3QueSArIHBhZ2VSZWN0LmhlaWdodCkpLFxuICAgIH07XG4gICAgY29uc3QgY292ZXJlZCA9XG4gICAgICAgIGVkZ2VzLmxlZnQgPj0gLUNPVkVSQUdFX1RPTEVSQU5DRV9QWCAmJlxuICAgICAgICBlZGdlcy5yaWdodCA+PSAtQ09WRVJBR0VfVE9MRVJBTkNFX1BYICYmXG4gICAgICAgIGVkZ2VzLnRvcCA+PSAtQ09WRVJBR0VfVE9MRVJBTkNFX1BYICYmXG4gICAgICAgIGVkZ2VzLmJvdHRvbSA+PSAtQ09WRVJBR0VfVE9MRVJBTkNFX1BYO1xuICAgIGNvbnN0IGl4ID0gTWF0aC5tYXgoXG4gICAgICAgIDAsXG4gICAgICAgIE1hdGgubWluKHBhZ2VSZWN0LnggKyBwYWdlUmVjdC53aWR0aCwgdmlld3BvcnQueCArIHZpZXdwb3J0LndpZHRoKSAtIE1hdGgubWF4KHBhZ2VSZWN0LngsIHZpZXdwb3J0LngpLFxuICAgICk7XG4gICAgY29uc3QgaXkgPSBNYXRoLm1heChcbiAgICAgICAgMCxcbiAgICAgICAgTWF0aC5taW4ocGFnZVJlY3QueSArIHBhZ2VSZWN0LmhlaWdodCwgdmlld3BvcnQueSArIHZpZXdwb3J0LmhlaWdodCkgLSBNYXRoLm1heChwYWdlUmVjdC55LCB2aWV3cG9ydC55KSxcbiAgICApO1xuICAgIGNvbnN0IHZpZXdBcmVhID0gdmlld3BvcnQud2lkdGggKiB2aWV3cG9ydC5oZWlnaHQ7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY292ZXJlZCxcbiAgICAgICAgYXJlYVJhdGlvOiB2aWV3QXJlYSA+IDAgPyBNYXRoLnJvdW5kKCgoaXggKiBpeSkgLyB2aWV3QXJlYSkgKiAxMDAwKSAvIDEwMDAgOiAwLFxuICAgICAgICBlZGdlcyxcbiAgICB9O1xufVxuXG4vKiog5Y+W5pmv55qE55uu5qCH77ya6KaB6KOF6L+b55S75biD55qE6YKj5Z2X5LiW55WM55+p5b2iICsg5Lqk57uZ57yW6L6R5Zmo6IGa54Sm55qEIHV1aWTjgIIgKi9cbmludGVyZmFjZSBGaXRUYXJnZXQge1xuICAgIHNwZWM6IEZpdFNwZWM7XG4gICAgLyoqIOebruagh+eahOS4lueVjOefqeW9ou+8m+eul+S4jeWHuuadpeaXtuS4uiBudWxs77yI5LiN556O57yW5LiA5Liq5qGG77yJICovXG4gICAgd29ybGQ6IHsgY3g6IG51bWJlcjsgY3k6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IG51bGw7XG4gICAgLyoqIOS6pOe7mSBgZm9jdXMoKWAg55qEIHV1aWTvvIjlhoXlrrnmoLnoioLngrkgLyDnm67moIfoioLngrnoh6rlt7HvvIkgKi9cbiAgICB1dWlkczogc3RyaW5nW107XG4gICAgLyoqIOi/meWdl+efqeW9ouaYr+S7juWTquadpeeahO+8iOWbnuaJp+mHjOWGmea4healmuOAjOWPluaZr+mHj+eahOWIsOW6leaYr+WTquWdl+OAje+8iSAqL1xuICAgIHNvdXJjZTogc3RyaW5nO1xuICAgIG5vdGU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICog5oqKIGB7a2luZCwgcmVmfWAg6Kej5p6Q5oiQ44CM5LiA5Z2X5LiW55WM55+p5b2iICsg5LiA5LiyIHV1aWTjgI3jgIJcbiAqXG4gKiAtIGBzY2VuZWDvvJpgaGVscGVycy5jb250ZW50Qm91bmRzKClg77yI55yf5a6e5YaF5a6555qE5bm26ZuG77yM6KeB5a6D55qE5rOo6YeK77yJ77ybXG4gKiAtIGBub2RlYO+8muebruagh+iKgueCueiHquW3seeahCBgd29ybGRSZWN0YOOAglxuICovXG5mdW5jdGlvbiBmaXRUYXJnZXRPZihoZWxwZXJzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+LCBzcGVjOiBGaXRTcGVjLCBub2RlOiBhbnkpOiBGaXRUYXJnZXQge1xuICAgIGlmIChzcGVjLmtpbmQgPT09ICdub2RlJykge1xuICAgICAgICBpZiAoIW5vZGUpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHNwZWMsIHdvcmxkOiBudWxsLCB1dWlkczogW10sIHNvdXJjZTogJ25vZGUnLCBub3RlOiBg5rKh5om+5Yiw6IqC54K544CMJHtzcGVjLnJlZn3jgI1gIH07XG4gICAgICAgIH1cbiAgICAgICAgbGV0IHJlY3Q6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJlY3QgPSBoZWxwZXJzLndvcmxkUmVjdChub2RlKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHNwZWMsIHdvcmxkOiBudWxsLCB1dWlkczogW10sIHNvdXJjZTogJ25vZGUud29ybGRSZWN0Jywgbm90ZTogYOeul+iKgueCueefqeW9ouWksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgd2lkdGggPSB0eXBlb2YgcmVjdC53aWR0aCA9PT0gJ251bWJlcicgPyByZWN0LndpZHRoIDogMDtcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gdHlwZW9mIHJlY3QuaGVpZ2h0ID09PSAnbnVtYmVyJyA/IHJlY3QuaGVpZ2h0IDogMDtcbiAgICAgICAgaWYgKHdpZHRoIDw9IDAgfHwgaGVpZ2h0IDw9IDApIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3BlYyxcbiAgICAgICAgICAgICAgICB3b3JsZDogbnVsbCxcbiAgICAgICAgICAgICAgICB1dWlkczogbm9kZS51dWlkID8gW25vZGUudXVpZF0gOiBbXSxcbiAgICAgICAgICAgICAgICBzb3VyY2U6ICdub2RlLndvcmxkUmVjdCcsXG4gICAgICAgICAgICAgICAgbm90ZTogYOiKgueCueayoeacieWwuuWvuO+8iCR7d2lkdGh9w5cke2hlaWdodH3vvInvvIzmsqHms5Xlj5bmma9gLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3BlYyxcbiAgICAgICAgICAgIHdvcmxkOiB7IGN4OiByZWN0LmN4LCBjeTogcmVjdC5jeSwgd2lkdGgsIGhlaWdodCB9LFxuICAgICAgICAgICAgdXVpZHM6IG5vZGUudXVpZCA/IFtub2RlLnV1aWRdIDogW10sXG4gICAgICAgICAgICBzb3VyY2U6ICdub2RlLndvcmxkUmVjdCcsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgbGV0IGJvdW5kczogUmVjb3JkPHN0cmluZywgYW55PiB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGJvdW5kcyA9IGhlbHBlcnMuY29udGVudEJvdW5kcygpIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IHNwZWMsIHdvcmxkOiBudWxsLCB1dWlkczogW10sIHNvdXJjZTogJ2NvbnRlbnRCb3VuZHMnLCBub3RlOiBg566X5YaF5a655YyF5Zu055uS5aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICB9XG4gICAgY29uc3Qgd2lkdGggPSB0eXBlb2YgYm91bmRzLndpZHRoID09PSAnbnVtYmVyJyA/IGJvdW5kcy53aWR0aCA6IDA7XG4gICAgY29uc3QgaGVpZ2h0ID0gdHlwZW9mIGJvdW5kcy5oZWlnaHQgPT09ICdudW1iZXInID8gYm91bmRzLmhlaWdodCA6IDA7XG4gICAgY29uc3QgdXVpZHMgPSBBcnJheS5pc0FycmF5KGJvdW5kcy51dWlkcykgPyBib3VuZHMudXVpZHMuZmlsdGVyKCh1OiB1bmtub3duKSA9PiB0eXBlb2YgdSA9PT0gJ3N0cmluZycpIDogW107XG4gICAgaWYgKHdpZHRoIDw9IDAgfHwgaGVpZ2h0IDw9IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHNwZWMsXG4gICAgICAgICAgICB3b3JsZDogbnVsbCxcbiAgICAgICAgICAgIHV1aWRzLFxuICAgICAgICAgICAgc291cmNlOiAnY29udGVudEJvdW5kcycsXG4gICAgICAgICAgICBub3RlOiAn5Zy65pmv6YeM5rKh5pyJ5bimIFVJVHJhbnNmb3JtIOeahOWGheWuueiKgueCue+8jOmHj+S4jeWHuuWGheWuueiMg+WbtO+8iOWPluaZr+i3s+i/h++8iScsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIHNwZWMsXG4gICAgICAgIHdvcmxkOiB7IGN4OiBib3VuZHMuY3gsIGN5OiBib3VuZHMuY3ksIHdpZHRoLCBoZWlnaHQgfSxcbiAgICAgICAgdXVpZHMsXG4gICAgICAgIHNvdXJjZTogJ2NvbnRlbnRCb3VuZHMnLFxuICAgICAgICBub3RlOiB0eXBlb2YgYm91bmRzLm5vdGUgPT09ICdzdHJpbmcnID8gYm91bmRzLm5vdGUgOiB1bmRlZmluZWQsXG4gICAgfTtcbn1cblxuLyoqIOebuOacuueahOOAjOinhuinkuetvuWQjeOAjeKAlOKAlCDlm57miafph4znu5nlroPvvIzov5jljp/miJDlip/kuI7lkKbkuZ/nlKjlroPliKTjgIIgKi9cbmZ1bmN0aW9uIGNhbWVyYVNpZ25hdHVyZShjYW06IGFueSk6IFJlY29yZDxzdHJpbmcsIGFueT4ge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuICAgIGNvbnN0IG5vZGUgPSBjYW0gJiYgY2FtLm5vZGUgPyBjYW0ubm9kZSA6IG51bGw7XG4gICAgaWYgKG5vZGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHAgPSBub2RlLndvcmxkUG9zaXRpb247XG4gICAgICAgICAgICBpZiAocCkgb3V0LnBvc2l0aW9uID0geyB4OiByb3VuZDMocC54KSwgeTogcm91bmQzKHAueSksIHo6IHJvdW5kMyhwLnopIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBub2RlLndvcmxkUm90YXRpb247XG4gICAgICAgICAgICBpZiAocikgb3V0LnJvdGF0aW9uID0geyB4OiByb3VuZDMoci54KSwgeTogcm91bmQzKHIueSksIHo6IHJvdW5kMyhyLnopLCB3OiByb3VuZDMoci53KSB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG9ydGhvSGVpZ2h0ID0gc2FmZU51bWJlcigoKSA9PiBjYW0ub3J0aG9IZWlnaHQpO1xuICAgIGlmIChvcnRob0hlaWdodCAhPT0gbnVsbCkgb3V0Lm9ydGhvSGVpZ2h0ID0gb3J0aG9IZWlnaHQ7XG4gICAgY29uc3QgZm92ID0gc2FmZU51bWJlcigoKSA9PiBjYW0uZm92KTtcbiAgICBpZiAoZm92ICE9PSBudWxsKSBvdXQuZm92ID0gZm92O1xuICAgIGNvbnN0IHByb2plY3Rpb24gPSBzYWZlTnVtYmVyKCgpID0+IGNhbS5wcm9qZWN0aW9uKTtcbiAgICBpZiAocHJvamVjdGlvbiAhPT0gbnVsbCkgb3V0LnByb2plY3Rpb24gPSBwcm9qZWN0aW9uO1xuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDkuKTkuKrop4bop5Lnrb7lkI3mmK/kuI3mmK/jgIzlkIzkuIDkuKrop4bop5LjgI3vvIjlrrnlt67mlL7lrr3liLDjgIzogonnnLzliIbkuI3lh7rjgI3nmoTph4/nuqfvvInjgIIgKi9cbmZ1bmN0aW9uIHNhbWVDYW1lcmEoYTogUmVjb3JkPHN0cmluZywgYW55PiB8IG51bGwsIGI6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsKTogYm9vbGVhbiB7XG4gICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcGEgPSBhLnBvc2l0aW9uO1xuICAgIGNvbnN0IHBiID0gYi5wb3NpdGlvbjtcbiAgICBpZiAocGEgJiYgcGIpIHtcbiAgICAgICAgaWYgKE1hdGguYWJzKHBhLnggLSBwYi54KSA+IDAuNSB8fCBNYXRoLmFicyhwYS55IC0gcGIueSkgPiAwLjUgfHwgTWF0aC5hYnMocGEueiAtIHBiLnopID4gMC41KSByZXR1cm4gZmFsc2U7XG4gICAgfSBlbHNlIGlmIChCb29sZWFuKHBhKSAhPT0gQm9vbGVhbihwYikpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBoYSA9IGEub3J0aG9IZWlnaHQ7XG4gICAgY29uc3QgaGIgPSBiLm9ydGhvSGVpZ2h0O1xuICAgIGlmICh0eXBlb2YgaGEgPT09ICdudW1iZXInIHx8IHR5cGVvZiBoYiA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBoYSAhPT0gJ251bWJlcicgfHwgdHlwZW9mIGhiICE9PSAnbnVtYmVyJykgcmV0dXJuIGZhbHNlO1xuICAgICAgICBjb25zdCBzY2FsZSA9IE1hdGgubWF4KE1hdGguYWJzKGhhKSwgTWF0aC5hYnMoaGIpLCAxZS02KTtcbiAgICAgICAgaWYgKE1hdGguYWJzKGhhIC0gaGIpIC8gc2NhbGUgPiAwLjAwNSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGEuZm92ID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgYi5mb3YgPT09ICdudW1iZXInICYmIE1hdGguYWJzKGEuZm92IC0gYi5mb3YpID4gMC4wMSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHJhID0gYS5yb3RhdGlvbjtcbiAgICBjb25zdCByYiA9IGIucm90YXRpb247XG4gICAgaWYgKHJhICYmIHJiKSB7XG4gICAgICAgIGNvbnN0IGRvdCA9IHJhLnggKiByYi54ICsgcmEueSAqIHJiLnkgKyByYS56ICogcmIueiArIHJhLncgKiByYi53O1xuICAgICAgICBpZiAoTWF0aC5hYnMoZG90KSA8IDAuOTk5OSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIOWPluaZr+WJjeeahOebuOacuueKtuaAge+8iOi/mOWOn+eahOadpea6kO+8ieOAgiAqL1xuaW50ZXJmYWNlIFNhdmVkQ2FtZXJhIHtcbiAgICBzaWduYXR1cmU6IFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgLyoqIOe8lui+keWZqOiHquW3seeahOinhuinkuS/oeaBr++8iGBjY2UuQ2FtZXJhLmdldEN1ckNhbWVyYUluZm8oKWDvvInigJTigJQg6L+Y5Y6f55qE6aaW6YCJ6L6T5YWlICovXG4gICAgaW5mbzogYW55IHwgbnVsbDtcbiAgICAvKiog55u45py65a2X5q6177yIYGZvY3VzYCDov5jljp/kuI3kuobml7bnmoTlhZzlupXmnaXmupDvvIkgKi9cbiAgICByYXc6IHsgb3J0aG9IZWlnaHQ6IG51bWJlciB8IG51bGw7IGZvdjogbnVtYmVyIHwgbnVsbDsgcHJvamVjdGlvbjogbnVtYmVyIHwgbnVsbCB9O1xufVxuXG5mdW5jdGlvbiBzYXZlQ2FtZXJhU3RhdGUobWFuYWdlcjogYW55LCBjYW06IGFueSk6IFNhdmVkQ2FtZXJhIHtcbiAgICBsZXQgaW5mbzogYW55ID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIG1hbmFnZXIuZ2V0Q3VyQ2FtZXJhSW5mbyA9PT0gJ2Z1bmN0aW9uJykgaW5mbyA9IG1hbmFnZXIuZ2V0Q3VyQ2FtZXJhSW5mbygpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBpbmZvID0gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2lnbmF0dXJlOiBjYW1lcmFTaWduYXR1cmUoY2FtKSxcbiAgICAgICAgaW5mbyxcbiAgICAgICAgcmF3OiB7XG4gICAgICAgICAgICBvcnRob0hlaWdodDogc2FmZU51bWJlcigoKSA9PiBjYW0ub3J0aG9IZWlnaHQpLFxuICAgICAgICAgICAgZm92OiBzYWZlTnVtYmVyKCgpID0+IGNhbS5mb3YpLFxuICAgICAgICAgICAgcHJvamVjdGlvbjogc2FmZU51bWJlcigoKSA9PiBjYW0ucHJvamVjdGlvbiksXG4gICAgICAgIH0sXG4gICAgfTtcbn1cblxuLyoqIOebtOaOpeaKiuebuOacuuWtl+auteWGmeWbnuWOu++8iOWFnOW6lei/mOWOn++8ieOAgkByZXR1cm5zIOWHuumXrumimOaXtueahOivtOaYju+8m+mhuuWIqeWImSBudWxs44CCICovXG5mdW5jdGlvbiB3cml0ZUJhY2tDYW1lcmEoY2FtOiBhbnksIHNhdmVkOiBTYXZlZENhbWVyYSk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IHByb2JsZW1zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IG5vZGUgPSBjYW0gJiYgY2FtLm5vZGUgPyBjYW0ubm9kZSA6IG51bGw7XG4gICAgY29uc3Qgc2lnID0gc2F2ZWQuc2lnbmF0dXJlO1xuICAgIGlmIChub2RlICYmIHNpZy5wb3NpdGlvbikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcCA9IHNpZy5wb3NpdGlvbjtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRXb3JsZFBvc2l0aW9uID09PSAnZnVuY3Rpb24nKSBub2RlLnNldFdvcmxkUG9zaXRpb24ocC54LCBwLnksIHAueik7XG4gICAgICAgICAgICBlbHNlIG5vZGUud29ybGRQb3NpdGlvbiA9IHA7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg5L2N572u5YaZ5Zue5aSx6LSl77yIJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfe+8iWApO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChub2RlICYmIHNpZy5yb3RhdGlvbikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgciA9IHNpZy5yb3RhdGlvbjtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRXb3JsZFJvdGF0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgUXVhdCA9IChnZXRDYygpIGFzIGFueSkuUXVhdDtcbiAgICAgICAgICAgICAgICBub2RlLnNldFdvcmxkUm90YXRpb24obmV3IFF1YXQoci54LCByLnksIHIueiwgci53KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg5pyd5ZCR5YaZ5Zue5aSx6LSl77yIJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfe+8iWApO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChzYXZlZC5yYXcub3J0aG9IZWlnaHQgIT09IG51bGwpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNhbS5vcnRob0hlaWdodCA9IHNhdmVkLnJhdy5vcnRob0hlaWdodDtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBwcm9ibGVtcy5wdXNoKGBvcnRob0hlaWdodCDlhpnlm57lpLHotKXvvIgke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V977yJYCk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKHNhdmVkLnJhdy5mb3YgIT09IG51bGwpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNhbS5mb3YgPSBzYXZlZC5yYXcuZm92O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIDJEIOebuOacuuayoeaciSBmb3Yg5piv5q2j5bi455qEICovXG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKHNhdmVkLnJhdy5wcm9qZWN0aW9uICE9PSBudWxsKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjYW0ucHJvamVjdGlvbiA9IHNhdmVkLnJhdy5wcm9qZWN0aW9uO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWQjOS4iiAqL1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBwcm9ibGVtcy5sZW5ndGggPiAwID8gcHJvYmxlbXMuam9pbign77ybJykgOiBudWxsO1xufVxuXG4vKipcbiAqIOi/mOWOn+inhuinku+8muWFiOi1sOe8lui+keWZqOiHquW3seeahOmAmumBk++8jOS4jeihjOWGjeebtOaOpeWGmeWbnuebuOacuuWtl+auteOAglxuICpcbiAqIOS4pOadoei3r+mDveWksei0peaXtioq5aaC5a6e5ZueIGByZXN0b3JlZDpmYWxzZWAqKiDigJTigJQg6LCD55So5pa55Lya5oqK5a6D5YaZ6L+b5Zue5omn77yMXG4gKiDnlKjmiLflsLHnn6XpgZNcIuaIkeeahOinhuinkuiiq+eVmeWcqOWPluaZr+WQjueahOS9jee9ruS6hu+8jOaMiSBGIOaIluWPjOWHu+iKgueCueWPr+S7peWbnuWOu1wi44CCXG4gKi9cbmZ1bmN0aW9uIHJlc3RvcmVDYW1lcmFTdGF0ZShcbiAgICBtYW5hZ2VyOiBhbnksXG4gICAgY2FtOiBhbnksXG4gICAgc2F2ZWQ6IFNhdmVkQ2FtZXJhLFxuKTogeyByZXN0b3JlZDogYm9vbGVhbjsgbWV0aG9kOiAnaW5mbycgfCAncmF3JyB8IG51bGw7IGFmdGVyOiBSZWNvcmQ8c3RyaW5nLCBhbnk+OyBub3RlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChzYXZlZC5pbmZvKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBtYW5hZ2VyLmZvY3VzKG51bGwsIHNhdmVkLmluZm8sIHRydWUpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYGZvY3VzKG51bGwsIGluZm8pIOi/mOWOn+Wksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBhZnRlckluZm8gPSBjYW1lcmFTaWduYXR1cmUoY2FtKTtcbiAgICAgICAgaWYgKHNhbWVDYW1lcmEoYWZ0ZXJJbmZvLCBzYXZlZC5zaWduYXR1cmUpKSByZXR1cm4geyByZXN0b3JlZDogdHJ1ZSwgbWV0aG9kOiAnaW5mbycsIGFmdGVyOiBhZnRlckluZm8gfTtcbiAgICAgICAgbm90ZXMucHVzaCgnZm9jdXMobnVsbCwgaW5mbykg5rKh6IO95oqK6KeG6KeS6L+Y5Y6f5Zue5Y6f5qC3Jyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbm90ZXMucHVzaCgn5ou/5LiN5Yiw57yW6L6R5Zmo6KeG6KeS5L+h5oGv77yIZ2V0Q3VyQ2FtZXJhSW5mbyDkuI3lj6/nlKjvvInvvIzlj6rog73nm7TmjqXlhpnlm57nm7jmnLrlrZfmrrUnKTtcbiAgICB9XG5cbiAgICBjb25zdCB3cml0ZU5vdGUgPSB3cml0ZUJhY2tDYW1lcmEoY2FtLCBzYXZlZCk7XG4gICAgaWYgKHdyaXRlTm90ZSkgbm90ZXMucHVzaCh3cml0ZU5vdGUpO1xuICAgIGNvbnN0IGFmdGVyUmF3ID0gY2FtZXJhU2lnbmF0dXJlKGNhbSk7XG4gICAgaWYgKHNhbWVDYW1lcmEoYWZ0ZXJSYXcsIHNhdmVkLnNpZ25hdHVyZSkpIHJldHVybiB7IHJlc3RvcmVkOiB0cnVlLCBtZXRob2Q6ICdyYXcnLCBhZnRlcjogYWZ0ZXJSYXcgfTtcbiAgICBub3Rlcy5wdXNoKCfnm7TmjqXlhpnlm57nm7jmnLrlrZfmrrXkuZ/msqHog73ov5jljp8nKTtcbiAgICByZXR1cm4geyByZXN0b3JlZDogZmFsc2UsIG1ldGhvZDogbnVsbCwgYWZ0ZXI6IGFmdGVyUmF3LCBub3RlOiBub3Rlcy5qb2luKCfvvJsnKSB9O1xufVxuXG4vKipcbiAqIOaJi+W3peWPluaZr++8iCoq5LuFIDJEIOato+S6pCoq77yJ77ya6YeP5Ye644CM55u45py65YOP57SgIC8g5LiW55WM5Y2V5L2N44CN5YaN5oqK55u45py65pGG5Zue5Y6744CCXG4gKlxuICog5Lik5q2l77yM6YO95LiN5YGH6K6+5byV5pOO5YaF6YOo5oCO5LmI566X55qE77yaXG4gKiAxLiAqKue8qeaUvioq77yaYG9ydGhvSGVpZ2h0YCDkuI7jgIzlg4/ntKAv5LiW55WM5Y2V5L2N44CN5oiQ5Y+N5q+U77yI5q2j5Lqk5oqV5b2x6YeM5Y+v6KeB5LiW55WM6auY5bqmID0gMsK3b3J0aG9IZWlnaHTvvInvvIxcbiAqICAgIOaJgOS7peaMiSoq6YeP5Ye65p2l55qEKirmr5TlgLznvKnkuIDkuIvljbPlj68g4oCU4oCUIOS4jeeUqOefpemBk+Wug+WIsOW6leaYr+WNiumrmOi/mOaYr+WFqOmrmO+8m1xuICogMi4gKirlr7nkuK0qKu+8muaKiuWGheWuueS4reW/g+aKleWIsOWxj+W5leS4iu+8jOeci+Wug+emu+inhuWPo+S4reW/g+W3ruWkmuWwkeWDj+e0oO+8jOWGjeaMieaWnOeOh+aNouaIkOS4lueVjOWNleS9jeaMquebuOacuuOAglxuICogICAgKirmlpznjofmmK/ph4/lh7rmnaXnmoQqKu+8iOaKleW9seS4pOS4quebuOi3nSAxMDAg5LiW55WM5Y2V5L2N55qE54K577yJ77yM5omA5LulXCLnm7jmnLrmnJ3lk6rovrnnnIsgLyDlsY/luZUgeSDmnJ3lk6rovrlcIlxuICogICAg6YO95LiN55So5YGH6K6+77yb6YeP5LiA5qyh57qg5LiA5qyh77yM5Lik5qyh5bCx5pS25pWb44CCXG4gKi9cbmZ1bmN0aW9uIG1hbnVhbE9ydGhvRml0KFxuICAgIGNjOiBhbnksXG4gICAgY2FtOiBhbnksXG4gICAgd29ybGQ6IHsgY3g6IG51bWJlcjsgY3k6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcbiAgICBtYXJnaW46IG51bWJlcixcbik6IHsgb2s6IGJvb2xlYW47IG5vdGU/OiBzdHJpbmc7IGRldGFpbD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0ge1xuICAgIGNvbnN0IHdpZHRoID0gc2FmZU51bWJlcigoKSA9PiBjYW0uY2FtZXJhLndpZHRoKSB8fCAwO1xuICAgIGNvbnN0IGhlaWdodCA9IHNhZmVOdW1iZXIoKCkgPT4gY2FtLmNhbWVyYS5oZWlnaHQpIHx8IDA7XG4gICAgY29uc3Qgb3J0aG9IZWlnaHQgPSBzYWZlTnVtYmVyKCgpID0+IGNhbS5vcnRob0hlaWdodCk7XG4gICAgY29uc3Qgbm9kZSA9IGNhbSAmJiBjYW0ubm9kZSA/IGNhbS5ub2RlIDogbnVsbDtcbiAgICBpZiAoIXdpZHRoIHx8ICFoZWlnaHQgfHwgIW9ydGhvSGVpZ2h0IHx8ICFub2RlKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbm90ZTogJ+mHj+S4jeWIsOebuOacuuWwuuWvuC9vcnRob0hlaWdodCDmiJbmi7/kuI3liLDnm7jmnLroioLngrnvvIzmiYvlt6Xlj5bmma/ot7Pov4cnIH07XG4gICAgfVxuXG4gICAgY29uc3QgVmVjMyA9IGNjLlZlYzM7XG4gICAgY29uc3QgcHJvamVjdCA9ICh4OiBudW1iZXIsIHk6IG51bWJlcik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IG51bGwgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcG9pbnQgPSBjYW0ud29ybGRUb1NjcmVlbihuZXcgVmVjMyh4LCB5LCAwKSk7XG4gICAgICAgICAgICByZXR1cm4geyB4OiBwb2ludC54LCB5OiBwb2ludC55IH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgcHJvYmUgPSAoKTogeyBreDogbnVtYmVyOyBreTogbnVtYmVyOyBjZW50ZXI6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB9IHwgbnVsbCA9PiB7XG4gICAgICAgIGNvbnN0IHAwID0gcHJvamVjdCh3b3JsZC5jeCwgd29ybGQuY3kpO1xuICAgICAgICBjb25zdCBweCA9IHByb2plY3Qod29ybGQuY3ggKyBQUk9CRV9VTklUUywgd29ybGQuY3kpO1xuICAgICAgICBjb25zdCBweSA9IHByb2plY3Qod29ybGQuY3gsIHdvcmxkLmN5ICsgUFJPQkVfVU5JVFMpO1xuICAgICAgICBpZiAoIXAwIHx8ICFweCB8fCAhcHkpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBreCA9IChweC54IC0gcDAueCkgLyBQUk9CRV9VTklUUztcbiAgICAgICAgY29uc3Qga3kgPSAocHkueSAtIHAwLnkpIC8gUFJPQkVfVU5JVFM7XG4gICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGt4KSB8fCAhTnVtYmVyLmlzRmluaXRlKGt5KSB8fCBreCA9PT0gMCB8fCBreSA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiB7IGt4LCBreSwgY2VudGVyOiBwMCB9O1xuICAgIH07XG5cbiAgICBjb25zdCBmaXJzdCA9IHByb2JlKCk7XG4gICAgaWYgKCFmaXJzdCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBub3RlOiAnd29ybGRUb1NjcmVlbiDph4/kuI3lh7rjgIzlg4/ntKAv5LiW55WM5Y2V5L2N44CN77yI55u45py65Y+v6IO96L+Y5rKh5YeG5aSH5aW977yJJyB9O1xuXG4gICAgLyoqIOKRoCDnvKnmlL7vvJrorqnnm67moIfnn6nlvaLlnKjnlZnnmb3kuYvlkI7liJrlpb3oo4Xov5vnlLvluIMgKi9cbiAgICBjb25zdCB3YW50SyA9IE1hdGgubWluKFxuICAgICAgICAod2lkdGggKiAoMSAtIG1hcmdpbiAqIDIpKSAvICh3b3JsZC53aWR0aCA+IDAgPyB3b3JsZC53aWR0aCA6IDEpLFxuICAgICAgICAoaGVpZ2h0ICogKDEgLSBtYXJnaW4gKiAyKSkgLyAod29ybGQuaGVpZ2h0ID4gMCA/IHdvcmxkLmhlaWdodCA6IDEpLFxuICAgICk7XG4gICAgdHJ5IHtcbiAgICAgICAgY2FtLm9ydGhvSGVpZ2h0ID0gb3J0aG9IZWlnaHQgKiAoZmlyc3Qua3ggLyB3YW50Syk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbm90ZTogYOWGmSBvcnRob0hlaWdodCDlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgIH1cblxuICAgIC8qKiDikaEg5a+55Lit77ya6YeP5q6L5L2ZIOKGkiDmjInmlpznjofmjKrnm7jmnLrvvIzkuKTmrKHvvIjmraPkuqTmmK/nur/mgKfnmoTvvIzkuKTmrKHotrPlpJ/mlLbmlZvliLDkuprlg4/ntKDvvIkgKi9cbiAgICBsZXQgcmVzaWR1YWw6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjsgaSArPSAxKSB7XG4gICAgICAgIGNvbnN0IG1lYXN1cmVkID0gcHJvYmUoKTtcbiAgICAgICAgaWYgKCFtZWFzdXJlZCkgYnJlYWs7XG4gICAgICAgIHJlc2lkdWFsID0geyB4OiB3aWR0aCAvIDIgLSBtZWFzdXJlZC5jZW50ZXIueCwgeTogaGVpZ2h0IC8gMiAtIG1lYXN1cmVkLmNlbnRlci55IH07XG4gICAgICAgIC8vIOKIgnNjcmVlbi/iiILnm7jmnLrkvY3nva4gPSDiiJIo4oiCc2NyZWVuL+KIguS4lueVjOS9jee9rinvvIzmiYDku6XpmaTku6Ug4oiSa1xuICAgICAgICBjb25zdCBkeCA9IHJlc2lkdWFsLnggLyAtbWVhc3VyZWQua3g7XG4gICAgICAgIGNvbnN0IGR5ID0gcmVzaWR1YWwueSAvIC1tZWFzdXJlZC5reTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IG5vZGUud29ybGRQb3NpdGlvbjtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRXb3JsZFBvc2l0aW9uID09PSAnZnVuY3Rpb24nKSBub2RlLnNldFdvcmxkUG9zaXRpb24ocG9zLnggKyBkeCwgcG9zLnkgKyBkeSwgcG9zLnopO1xuICAgICAgICAgICAgZWxzZSBub2RlLndvcmxkUG9zaXRpb24gPSB7IHg6IHBvcy54ICsgZHgsIHk6IHBvcy55ICsgZHksIHo6IHBvcy56IH07XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBub3RlOiBg5oyq55u45py65aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICAgIHNjYWxlOiByb3VuZDMob3J0aG9IZWlnaHQgKiAoZmlyc3Qua3ggLyB3YW50SykpLFxuICAgICAgICAgICAgcHhQZXJVbml0QmVmb3JlOiByb3VuZDMoZmlyc3Qua3gpLFxuICAgICAgICAgICAgcHhQZXJVbml0V2FudGVkOiByb3VuZDMod2FudEspLFxuICAgICAgICAgICAgY2VudGVyUmVzaWR1YWxQeDogcmVzaWR1YWwgPyB7IHg6IHJvdW5kMyhyZXNpZHVhbC54KSwgeTogcm91bmQzKHJlc2lkdWFsLnkpIH0gOiBudWxsLFxuICAgICAgICB9LFxuICAgIH07XG59XG5cbi8qKiDkuIDmrKHlj5bmma/nmoTnjrDlnLrvvIjnrYnnnYDooqvov5jljp/nmoTop4bop5LvvInjgILlkIzkuIDml7bliLvlj6rlhYHorrjkuIDkuKog4oCU4oCUIOaIquWbvuaYr+S4suihjOeahOOAgiAqL1xubGV0IHBlbmRpbmdGaXQ6IHsgdG9rZW46IHN0cmluZzsgc2F2ZWQ6IFNhdmVkQ2FtZXJhOyBzdGFydGVkQXQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG5cbi8qKiDlj5bmma/njrDlnLrotoXov4fov5nkuKrml7bpl7Tov5jmsqHooqvov5jljp/lsLHkvZzlup/vvIjliKvmiorlh6DliIbpkp/liY3nmoTml6fop4bop5Lnm5blm57nlKjmiLfohLjkuIrvvInjgIIgKi9cbmNvbnN0IEZJVF9TVEFURV9UVExfTVMgPSA2MF8wMDA7XG5cbi8qKiDlj5bmma8gdG9rZW4g55qE6Ieq5aKe5bC+5be077yI5ZCM5LiA5q+r56eS5YaF5aSa5qyh5Y+W5pmv5Lmf6IO95Yy65YiG77yJ44CCICovXG5sZXQgZml0Q291bnRlciA9IDA7XG5cbmludGVyZmFjZSBGaXRWaWV3UGF5bG9hZCB7XG4gICAgLyoqIGAnZml0J2DvvIjpu5jorqTvvInmkYbkuIDnuqflj5bmma8gLyBgJ2VuZCdgIOi/mOWOn+inhuinkiAqL1xuICAgIGFjdGlvbj86IHVua25vd247XG4gICAgLyoqIOWPluaZr+e6p+WIq++8iDAgPSDnvJbovpHlmaggZm9jdXMgLyAxID0g5o6n5Yi25Zmo6YCC6YWNIC8gMiA9IOaJi+W3pe+8iSAqL1xuICAgIHN0ZXA/OiB1bmtub3duO1xuICAgIC8qKiDlj5bmma/nm67moIcgYHtraW5kOidzY2VuZSd8J25vZGUnLCByZWY/fWAgKi9cbiAgICBmaXQ/OiB1bmtub3duO1xuICAgIC8qKiBga2luZDonbm9kZSdgIOaXtueahOiKgueCueW8leeUqO+8iOS5n+WPr+WGmeWcqCBgZml0LnJlZmAg6YeM77yJICovXG4gICAgbm9kZT86IHVua25vd247XG4gICAgcHJvamVjdFBhdGg/OiB1bmtub3duO1xufVxuXG4vKiog5omn6KGM56ysIGBzdGVwYCDnuqflj5bmma/jgIJAcmV0dXJucyBgbWV0aG9kOiBudWxsYCA9IOi/meS4gOe6p+ayoeWBmuaIkO+8iOWOn+WboOWcqCBub3Rl77yJICovXG5mdW5jdGlvbiBhcHBseUZpdFN0ZXAoXG4gICAgY2M6IGFueSxcbiAgICBtYW5hZ2VyOiBhbnksXG4gICAgY2FtOiBhbnksXG4gICAgc3RlcDogbnVtYmVyLFxuICAgIHRhcmdldDogRml0VGFyZ2V0LFxuICAgIGlzMkQ6IGJvb2xlYW4gfCBudWxsLFxuKTogeyBtZXRob2Q6ICdmb2N1cycgfCAnYWRqdXN0JyB8ICdtYW51YWwnIHwgbnVsbDsgbm90ZT86IHN0cmluZzsgZGV0YWlsPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSB7XG4gICAgaWYgKCF0YXJnZXQud29ybGQpIHJldHVybiB7IG1ldGhvZDogbnVsbCwgbm90ZTogdGFyZ2V0Lm5vdGUgfHwgJ+ayoeacieWPr+eUqOeahOS4lueVjOefqeW9ou+8jOWPluaZr+i3s+i/hycgfTtcblxuICAgIGlmIChzdGVwID09PSAwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgbWFuYWdlci5mb2N1cyAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiAnY2NlLkNhbWVyYS5mb2N1cyDkuI3lrZjlnKjvvIjnvJbovpHlmajniYjmnKzlt67lvILvvIknIH07XG4gICAgICAgIGlmICh0YXJnZXQudXVpZHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6ICfmsqHmnInlj6/ogZrnhKbnmoQgdXVpZO+8iOWGheWuueiKgueCueayoeaciSB1dWlk77yf77yJJyB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbWFuYWdlci5mb2N1cyh0YXJnZXQudXVpZHMsIHVuZGVmaW5lZCwgdHJ1ZSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiBgY2NlLkNhbWVyYS5mb2N1cyDmipvlvILluLjvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1ldGhvZDogJ2ZvY3VzJyB9O1xuICAgIH1cblxuICAgIGlmIChzdGVwID09PSAxKSB7XG4gICAgICAgIGlmIChpczJEICE9PSB0cnVlKSByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6ICfpnZ4gMkQg6KeG5Zu+5rKh5pyJIF9hZGp1c3RUb0NlbnRlcu+8iDNEIOWPqui1sCBmb2N1c++8iScgfTtcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IG1hbmFnZXIuY29udHJvbGxlcjJEO1xuICAgICAgICBpZiAoIWNvbnRyb2xsZXIgfHwgdHlwZW9mIGNvbnRyb2xsZXIuX2FkanVzdFRvQ2VudGVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6ICdjY2UuQ2FtZXJhLmNvbnRyb2xsZXIyRC5fYWRqdXN0VG9DZW50ZXIg5LiN5a2Y5Zyo77yI57yW6L6R5Zmo54mI5pys5beu5byC77yJJyB9O1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZWN0ID0gbmV3IGNjLlJlY3QoXG4gICAgICAgICAgICAgICAgdGFyZ2V0LndvcmxkLmN4IC0gdGFyZ2V0LndvcmxkLndpZHRoIC8gMixcbiAgICAgICAgICAgICAgICB0YXJnZXQud29ybGQuY3kgLSB0YXJnZXQud29ybGQuaGVpZ2h0IC8gMixcbiAgICAgICAgICAgICAgICB0YXJnZXQud29ybGQud2lkdGgsXG4gICAgICAgICAgICAgICAgdGFyZ2V0LndvcmxkLmhlaWdodCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjb250cm9sbGVyLl9hZGp1c3RUb0NlbnRlcihGSVRfTUFSR0lOLCByZWN0LCB0cnVlKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6IGBfYWRqdXN0VG9DZW50ZXIg5oqb5byC5bi477yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBtZXRob2Q6ICdhZGp1c3QnIH07XG4gICAgfVxuXG4gICAgaWYgKHN0ZXAgPT09IDIpIHtcbiAgICAgICAgaWYgKGlzMkQgIT09IHRydWUpIHJldHVybiB7IG1ldGhvZDogbnVsbCwgbm90ZTogJ+aJi+W3peWPluaZr+WPquWunueOsOS6hiAyRCDmraPkuqTvvIgzRCDopoHliqggRk9WL+i3neemu++8jOWFiOS4jeWBmu+8iScgfTtcbiAgICAgICAgY29uc3QgYXBwbGllZCA9IG1hbnVhbE9ydGhvRml0KGNjLCBjYW0sIHRhcmdldC53b3JsZCwgRklUX01BUkdJTik7XG4gICAgICAgIHJldHVybiB7IG1ldGhvZDogYXBwbGllZC5vayA/ICdtYW51YWwnIDogbnVsbCwgbm90ZTogYXBwbGllZC5ub3RlLCBkZXRhaWw6IGFwcGxpZWQuZGV0YWlsIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiBg5rKh5pyJ56ysICR7c3RlcH0g57qn5Y+W5pmvYCB9O1xufVxuXG4vKiogMkQg6IO955So5LiJ57qn77yMM0Qg5Y+q5pyJIGZvY3VzIOS4gOe6p++8iOWFtuS9meS4pOe6p+mDveayoeWunueOsC/kuI3pgILnlKjvvInjgIIgKi9cbmZ1bmN0aW9uIG1heEZpdFN0ZXBzKGlzMkQ6IGJvb2xlYW4gfCBudWxsKTogbnVtYmVyIHtcbiAgICByZXR1cm4gaXMyRCA9PT0gdHJ1ZSA/IDMgOiAxO1xufVxuXG5pbnRlcmZhY2UgVmlld01ldHJpY3NQYXlsb2FkIHtcbiAgICAvKiog6IqC54K5IHV1aWQg5oiW6Lev5b6E77yI5aaCIGAnQ2FudmFzL3NraWxsX2RldGFpbHMnYO+8ie+8m+S4jee7meWwseWPquWbnuinhuWbvuWHoOS9lSAqL1xuICAgIG5vZGU/OiB1bmtub3duO1xuICAgIHByb2plY3RQYXRoPzogdW5rbm93bjtcbiAgICAvKiog6KaB44CM5ouN5YWo44CN55qE55uu5qCH77yIYHtraW5kOidzY2VuZSd8J25vZGUnLCByZWY/fWDvvInigJTigJQg5Yaz5a6aIGBmcmFtaW5nYCDph4/nmoTmmK/lk6rlnZfnn6nlvaIgKi9cbiAgICBmaXQ/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIOWcuuaZr+inhuWbvuWHoOS9le+8iGBjb250cmlidXRpb25zLnNjZW5lYCDnmoQgYHZpZXdNZXRyaWNzYO+8ieOAglxuICpcbiAqIEByZXR1cm5zIGB7b2ssIHBhZ2UsIGNhbnZhcywgdmlldywgY2FtZXJhLCBub2RlPywgZnJhbWluZz99YCDigJTigJQg5Li76L+b56iL5ou/5a6D5a6a5L2NXG4gKiAgIHdlYkNvbnRlbnRz44CB5o2i566X6KOB5YiH55+p5b2i77ybYG5vZGUucmVjdGAg5pivKirpobXpnaIgQ1NTIOWDj+e0oCoq77yI5bem5LiK6KeS5Y6f54K577yJ77ybXG4gKiAgIOe7meS6hiBgZml0YCDml7blho3lpJrkuIDpobkgYGZyYW1pbmdg77yaKirnm67moIfmnInmsqHmnInmlbTkuKrokL3lnKjnlLvluIPph4wqKu+8iOWPluaZr+mTvueahOWIpOaNru+8ieOAglxuICovXG5mdW5jdGlvbiBjb2xsZWN0Vmlld01ldHJpY3MoY2M6IGFueSwgcGF5bG9hZDogVmlld01ldHJpY3NQYXlsb2FkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGNhbnZhcyA9IGZpbmRWaWV3Q2FudmFzKGNjKTtcbiAgICBjb25zdCBjYW1lcmEgPSBlZGl0b3JDYW1lcmEoKTtcbiAgICBjb25zdCBjYW0gPSBjYW1lcmEuY2FtO1xuXG4gICAgY29uc3QgbWV0cmljczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBwYWdlOiBwYWdlR2VvbWV0cnkoKSxcbiAgICAgICAgY2FudmFzOiBjYW52YXNHZW9tZXRyeShjYW52YXMpLFxuICAgICAgICB2aWV3OiBjYW52YXMgPyByZWFkVmlld1N0YXRlKGNjLCBjYW52YXMpIDogbnVsbCxcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOeOsOWcqOi/meS4gOmhteeUu+eahOaYryoq57yW6L6R5Zmo5Zy65pmvKirov5jmmK8qKui3keedgOeahOa4uOaIjyoq77yI6KeBIGByZWFkU2NlbmVNb2RlYO+8ieOAglxuICAgICAgICAgKiDmiKrlm74v54K56IqC54K5L+ijgeefqeW9oumDveimgeWFiOeci+Wug++8mui/kOihjOaAgeS4i+e8lui+keWZqOebuOacuuS4jeaYr+mCo+WPsOWcqOa4suafk+eahOebuOacuuOAglxuICAgICAgICAgKi9cbiAgICAgICAgcnVudGltZTogcmVhZFNjZW5lTW9kZShjYyksXG4gICAgICAgIGNhbWVyYToge1xuICAgICAgICAgICAgYXZhaWxhYmxlOiBCb29sZWFuKGNhbSksXG4gICAgICAgICAgICBpczJEOiBjYW1lcmEuaXMyRCxcbiAgICAgICAgICAgIG5vdGU6IGNhbWVyYS5ub3RlLFxuICAgICAgICAgICAgLi4uKGNhbVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzYWZlTnVtYmVyKCgpID0+IGNhbS5jYW1lcmEud2lkdGgpLFxuICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc2FmZU51bWJlcigoKSA9PiBjYW0uY2FtZXJhLmhlaWdodCksXG4gICAgICAgICAgICAgICAgICAgICAgb3J0aG9IZWlnaHQ6IHNhZmVOdW1iZXIoKCkgPT4gY2FtLm9ydGhvSGVpZ2h0KSxcbiAgICAgICAgICAgICAgICAgICAgICBzY3JlZW5TY2FsZTogc2FmZU51bWJlcigoKSA9PiBjYW0uc2NyZWVuU2NhbGUpLFxuICAgICAgICAgICAgICAgICAgICAgIHNpZ25hdHVyZTogY2FtZXJhU2lnbmF0dXJlKGNhbSksXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlZiA9IHR5cGVvZiBwYXlsb2FkLm5vZGUgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5ub2RlLnRyaW0oKSA6ICcnO1xuICAgIGNvbnN0IGZpdFNwZWMgPSBub3JtYWxpemVGaXRTcGVjKHBheWxvYWQuZml0KTtcbiAgICBpZiAoIXJlZiAmJiAhZml0U3BlYykgcmV0dXJuIG1ldHJpY3M7XG5cbiAgICBjb25zdCBoZWxwZXJzID0gbWFrZUhlbHBlcnMoY2MsIHtcbiAgICAgICAgcHJvamVjdFBhdGg6IHR5cGVvZiBwYXlsb2FkLnByb2plY3RQYXRoID09PSAnc3RyaW5nJyA/IHBheWxvYWQucHJvamVjdFBhdGggOiAnJyxcbiAgICB9KS5oZWxwZXJzIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgICBsZXQgbm9kZTogYW55ID0gbnVsbDtcbiAgICBpZiAocmVmKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBub2RlID0gaGVscGVycy5ub2RlQnlVdWlkKHJlZikgfHwgaGVscGVycy5ub2RlQnlQYXRoKHJlZikgfHwgbnVsbDtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBtZXRyaWNzLm5vZGUgPSB7IHJlZiwgZm91bmQ6IGZhbHNlLCBub3RlOiBg5oyJIHV1aWQv6Lev5b6E5om+6IqC54K55pe25Ye66ZSZ77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICAgICAgICAgIHJldHVybiBtZXRyaWNzO1xuICAgICAgICB9XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgbWV0cmljcy5ub2RlID0ge1xuICAgICAgICAgICAgICAgIHJlZixcbiAgICAgICAgICAgICAgICBmb3VuZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgbm90ZTogJ+aMiSB1dWlkIOS4jui3r+W+hOmDveayoeaJvuWIsOi/meS4quiKgueCue+8iHV1aWQg55SoIG5vZGUudXVpZO+8jOi3r+W+hOWmgiBDYW52YXMvc2tpbGxfZGV0YWlsc++8iScsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcmV0dXJuIG1ldHJpY3M7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgcmVmLCBmb3VuZDogdHJ1ZSwgdXVpZDogbm9kZS51dWlkLCBuYW1lOiBub2RlLm5hbWUgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGluZm8ud29ybGRSZWN0ID0gaGVscGVycy53b3JsZFJlY3Qobm9kZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5b+955Wl77ya5LiW55WM55+p5b2i5Y+q5piv6ZmE5bim5L+h5oGvICovXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFjYW0pIHtcbiAgICAgICAgICAgIGluZm8ucmVjdCA9IG51bGw7XG4gICAgICAgICAgICBpbmZvLm5vdGUgPSBgJHtjYW1lcmEubm90ZSB8fCAn57yW6L6R5Zmo55u45py65LiN5Y+v55SoJ33vvJrnrpfkuI3lh7roioLngrnlnKjop4blm77ph4znmoTnn6nlvaLvvIjkvJrpgIDmiJDmlbTlvKDop4blm77vvIlgO1xuICAgICAgICAgICAgbWV0cmljcy5ub2RlID0gaW5mbztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3ROb2RlUmVjdChjYywgY2FtLCBub2RlLCBjYW52YXMpO1xuICAgICAgICAgICAgaW5mby5yZWN0ID0gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgICAgICBpbmZvLmNhbnZhc1JlY3QgPSBwcm9qZWN0ZWQuY2FudmFzUmVjdDtcbiAgICAgICAgICAgIGlmIChwcm9qZWN0ZWQubm90ZSkgaW5mby5ub3RlID0gcHJvamVjdGVkLm5vdGU7XG4gICAgICAgICAgICBtZXRyaWNzLm5vZGUgPSBpbmZvO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqIOWPluaZr+aKpeWRiu+8muebruagh+efqeW9oiB2cyDnlLvluIPnn6nlvaLvvIjjgIzmi43lhajkuobmsqHmnInjgI3vvIkgKi9cbiAgICBpZiAoZml0U3BlYykge1xuICAgICAgICBjb25zdCB2aWV3cG9ydCA9IHZpZXdwb3J0T2YoY2FudmFzKTtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZml0VGFyZ2V0T2YoaGVscGVycywgZml0U3BlYywgbm9kZSk7XG4gICAgICAgIGNvbnN0IGZyYW1pbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICAgICAgdGFyZ2V0OiB7XG4gICAgICAgICAgICAgICAga2luZDogZml0U3BlYy5raW5kLFxuICAgICAgICAgICAgICAgIHJlZjogZml0U3BlYy5yZWYgfHwgbnVsbCxcbiAgICAgICAgICAgICAgICAvKiog6L+Z5Z2X55+p5b2i5piv5LuO5ZOq5p2l55qEIOKAlOKAlCDlj5bmma/ph4/plJnkuobvvIznnIvlroPlsLHlpJ/kuoYgKi9cbiAgICAgICAgICAgICAgICBzb3VyY2U6IHRhcmdldC5zb3VyY2UsXG4gICAgICAgICAgICAgICAgLyoqIOS6pOe7mSBmb2N1cyDnmoQgdXVpZO+8iOS4quaVsOWwseWkn+WumuS9jemXrumimOS6hu+8iSAqL1xuICAgICAgICAgICAgICAgIHV1aWRzOiB0YXJnZXQudXVpZHMubGVuZ3RoLFxuICAgICAgICAgICAgICAgIHdvcmxkOiB0YXJnZXQud29ybGQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgdmlld3BvcnQsXG4gICAgICAgICAgICBjb3ZlcmVkOiBmYWxzZSxcbiAgICAgICAgICAgIGFyZWFSYXRpbzogMCxcbiAgICAgICAgICAgIG5vdGU6IHRhcmdldC5ub3RlLFxuICAgICAgICB9O1xuICAgICAgICBpZiAoIXZpZXdwb3J0KSB7XG4gICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSAn6YeP5LiN5Yiw55S75biD55+p5b2i77yI55S75biD6L+Y5rKh6ZO65byA77yJ77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgfSBlbHNlIGlmICghY2FtKSB7XG4gICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSBjYW1lcmEubm90ZSB8fCAn57yW6L6R5Zmo55u45py65LiN5Y+v55So77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8qKiDnm67moIfnn6nlvaLvvJroioLngrnnm67moIfnm7TmjqXnlKgqKuW3sue7j+eul+WlveeahCoq6IqC54K555+p5b2i77yI5ZCM5LiA5Lu95oqV5b2x77yM5LiN6YeN5aSN6LWw5LiA6YGN77yJICovXG4gICAgICAgICAgICBjb25zdCBub2RlUmVjdCA9IG1ldHJpY3Mubm9kZSA/ICgobWV0cmljcy5ub2RlIGFzIFJlY29yZDxzdHJpbmcsIGFueT4pLnJlY3QgYXMgUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwpIDogbnVsbDtcbiAgICAgICAgICAgIGxldCBwYWdlUmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGZpdFNwZWMua2luZCA9PT0gJ25vZGUnKSB7XG4gICAgICAgICAgICAgICAgcGFnZVJlY3QgPSBub2RlUmVjdCAmJiB0eXBlb2Ygbm9kZVJlY3Qud2lkdGggPT09ICdudW1iZXInID8gbm9kZVJlY3QgOiBudWxsO1xuICAgICAgICAgICAgICAgIGlmICghcGFnZVJlY3QpIGZyYW1pbmcubm90ZSA9IGZyYW1pbmcubm90ZSB8fCAn6IqC54K5566X5LiN5Ye655+p5b2i77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LndvcmxkKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvamVjdGVkID0gcHJvamVjdFdvcmxkQm94KGNjLCBjYW0sIGNhbnZhcywge1xuICAgICAgICAgICAgICAgICAgICBjeDogdGFyZ2V0LndvcmxkLmN4LFxuICAgICAgICAgICAgICAgICAgICBjeTogdGFyZ2V0LndvcmxkLmN5LFxuICAgICAgICAgICAgICAgICAgICB3ejogMCxcbiAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHRhcmdldC53b3JsZC53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiB0YXJnZXQud29ybGQuaGVpZ2h0LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHBhZ2VSZWN0ID0gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgICAgICAgICAgaWYgKCFwYWdlUmVjdCAmJiBwcm9qZWN0ZWQubm90ZSkgZnJhbWluZy5ub3RlID0gZnJhbWluZy5ub3RlIHx8IHByb2plY3RlZC5ub3RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHBhZ2VSZWN0KSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY292ZXJhZ2UgPSBjb3ZlcmFnZU9mKHBhZ2VSZWN0LCB2aWV3cG9ydCk7XG4gICAgICAgICAgICAgICAgZnJhbWluZy5jb3ZlcmVkID0gY292ZXJhZ2UuY292ZXJlZDtcbiAgICAgICAgICAgICAgICBmcmFtaW5nLmFyZWFSYXRpbyA9IGNvdmVyYWdlLmFyZWFSYXRpbztcbiAgICAgICAgICAgICAgICBmcmFtaW5nLmVkZ2VzID0gY292ZXJhZ2UuZWRnZXM7XG4gICAgICAgICAgICAgICAgZnJhbWluZy50YXJnZXRQYWdlID0gcGFnZVJlY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5mcmFtaW5nID0gZnJhbWluZztcbiAgICB9XG5cbiAgICByZXR1cm4gbWV0cmljcztcbn1cbmludGVyZmFjZSBIZWxwZXJCdW5kbGUge1xuICAgIGhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHN0YXRlOiB7IHNuYXBzaG90UmVxdWVzdGVkOiBib29sZWFuIH07XG59XG5cbi8qKlxuICog5p6E6YCg5rOo5YWl5rKZ566x55qE5Yqp5omL5Ye95pWw44CCXG4gKlxuICog6L+Z5Lqb5piv44CMQUkg5YaZ5Luj56CB5pe255qE6LW35omL5byP44CN4oCU4oCU5rKh5pyJ5a6D5Lus77yM5qih5Z6L5q+P5qyh6YO96KaB5LuOXG4gKiBgY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKWAg5byA5aeL5omL5pCT6YGN5Y6G77yM5pei6LS5IHRva2VuIOWPiOWuueaYk+WGmemUmeOAglxuICovXG5mdW5jdGlvbiBtYWtlSGVscGVycyhjYzogYW55LCBvcHRpb25zPzogeyBwcm9qZWN0UGF0aD86IHN0cmluZyB9KTogSGVscGVyQnVuZGxlIHtcbiAgICBjb25zdCBzdGF0ZSA9IHsgc25hcHNob3RSZXF1ZXN0ZWQ6IGZhbHNlIH07XG5cbiAgICBjb25zdCBoZWxwZXJzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gICAgLyoqXG4gICAgICog5bel56iL5qC5IOKAlOKAlCAqKuS8mOWFiOeUqOS4u+i/m+eoi+majyBwYXlsb2FkIOS8oOi/m+adpeeahOmCo+S4qioq77yIYEVkaXRvci5Qcm9qZWN0LnBhdGhg77yJ77yMXG4gICAgICog5ou/5LiN5Yiw5YaN6YCA5ZueIGBjdXJyZW50UHJvamVjdFBhdGgoKWDvvIjlnLrmma/ov5vnqIvph4znmoQgYEVkaXRvcmAg5YWo5bGA6YeP77yJ44CCXG4gICAgICog5Lik5Liq6YO95rKh5pyJ5pe25Y+q5b2x5ZON44CM5oyJ6Lev5b6E6Kej5p6Q6LWE5rqQ44CN6L+Z5LiA5Lu25LqL77yM5YW25L2Z5Yqp5omL54Wn5bi444CCXG4gICAgICovXG4gICAgY29uc3QgcHJvamVjdFJvb3QgPSAoKTogc3RyaW5nID0+IHtcbiAgICAgICAgY29uc3QgZnJvbVBheWxvYWQgPSB0eXBlb2Ygb3B0aW9ucz8ucHJvamVjdFBhdGggPT09ICdzdHJpbmcnID8gb3B0aW9ucy5wcm9qZWN0UGF0aCA6ICcnO1xuICAgICAgICByZXR1cm4gZnJvbVBheWxvYWQgfHwgY3VycmVudFByb2plY3RQYXRoKCk7XG4gICAgfTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8g57yW6L6R5Zmo6KOF6aWw6IqC54K55Yik5o2uIOKAlOKAlCDlnLrmma/moJHph4wgOTclIOeahOiKgueCueS4jeaYr+S9oOeahOWGheWuuVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy9cbiAgICAvLyDlnLrmma/ov5vnqIvph4wgYGRpcmVjdG9yLmdldFNjZW5lKClgIOaLv+WIsOeahOagkSoq5YyF5ZCr57yW6L6R5Zmo6Ieq5bex5oyC55qEIGdpem1vIC8g572R5qC8IC9cbiAgICAvLyDlj4LogIPlm74qKuOAguWunua1i++8iENvY29zIDMuOC4277yM5LiA5Liq5Y+q5pyJIENhbnZhcyDnmoTnqbrlnLrmma/vvInvvJpcbiAgICAvL1xuICAgIC8vICAgICDmgLvoioLngrkgMTI4XG4gICAgLy8gICAgIOKUnOKUgCBDYW52YXMgICAgICAgICAgICAgICAgICAgICAgICAyICAg4oaQIOWUr+S4gOeahOecn+WunuWGheWuuVxuICAgIC8vICAgICDilJzilIAgRWRpdG9yIFNjZW5lIEZvcmVncm91bmQgICAgIDExNyAgIOKGkCDlnZDmoIfovbQgZ2l6bW8gLyDnvZHmoLwgLyDlkITnp43mjqfliLblmahcbiAgICAvLyAgICAg4pSU4pSAIEVkaXRvciBTY2VuZSBCYWNrZ3JvdW5kICAgICAgIDggICDihpAg6IOM5pmv5LiO5Y+C6ICD5Zu+XG4gICAgLy9cbiAgICAvLyDkuI3mu6TmjonnmoTor50gYGVhY2hOb2RlYCAvIGB0cmVlKClgIOmHjCA5NyUg5piv5Zmq5aOw77yM5qih5Z6L5Lya54Wn552AIGdpem1vIOeahOiKgueCueWQjVxuICAgIC8vIO+8iGB4QXhpc2AgLyBgUmVjdGFuZ2xlYCAvIGBQbGFuZWAgLyBgTGluZXNOb2RlYOKApu+8ieWOu+aOqOaWrea4uOaIj+e7k+aehOOAglxuICAgIC8vXG4gICAgLy8gIyMg5Lik5p2h6KKr5a6e5rWL5ZCm5o6J55qE55u06KeJXG4gICAgLy9cbiAgICAvLyDinYwgKirmjIkgbGF5ZXIg5o6p56CB5rukKirvvJrkuI3ooYzjgILnvJbovpHlmajmoLkgYEVkaXRvciBTY2VuZSBGb3JlZ3JvdW5kYCDkuI7nnJ/lrp7nm7jmnLpcbiAgICAvLyAgICBgQ2FudmFzL0NhbWVyYWAgKirlkIzkuLogYExheWVycy5ERUZBVUxUYCgxMDczNzQxODI0KSoq77ybR0laTU9TL0VESVRPUiDkvY3lj6ropobnm5ZcbiAgICAvLyAgICDlrZDmoJHnmoTkuIDpg6jliIbvvIjov5jmnIkgNTI0Mjg4MOOAgTE2Nzc3MjE2IOetiea3t+WQiOWAvO+8ieKAlOKAlCDmjInlsYLmu6TkvJror6/kvKTnnJ/lrp7oioLngrnjgIJcbiAgICAvLyDinYwgKirmjIkgYGdpem1vUm9vdGAg6L+Z57G75ZCN5a2X5rukKirvvJrkuI3ooYzjgILlkI3lrZfmmK/lrp7njrDnu4boioLvvIzogIzkuJTopobnm5bkuI3kuoYgQmFja2dyb3VuZCDpgqPmo7XjgIJcbiAgICAvL1xuICAgIC8vIOKchSAqKuaMiSBgSGlkZUluSGllcmFyY2h5YCDkvY3mu6QqKu+8iD0g57yW6L6R5Zmo6Ieq5bex44CM5Yir5Zyo5bGC57qn6Z2i5p2/6YeM5pi+56S65oiR44CN55qE5qCH6K6w77yMXG4gICAgLy8gICAg6K+t5LmJ5q2j5aW95bCx5piv6KaB55qE6L+Z5Liq77yJ44CC5a6e5rWL5Lik5Liq57yW6L6R5Zmo5qC555qEIGBvYmpGbGFnc2Ag6YO95pivXG4gICAgLy8gICAgYDEwOTYgPSBIaWRlSW5IaWVyYXJjaHl8RG9udERlc3Ryb3l8RG9udFNhdmVg77yM6ICM55yf5a6e6IqC54K577yI5ZCrIENhbWVyYe+8ieaYryAw44CCXG4gICAgLy9cbiAgICAvLyDimqAg5YWz6ZSu57uG6IqC77ya6L+Z5Liq5L2NKirlj6rlnKjkuKTkuKrmoLnkuIoqKu+8jGBnaXptb1Jvb3RgIOiHqui6q+eahCBgb2JqRmxhZ3NgIOaYryAwIOKAlOKAlFxuICAgIC8vICAgIOaJgOS7peWIpOaNruW/hemhu+eUqOWcqCoq5Ymq5p6dKirkuIrvvIjliarmjonmoLnvvIzmlbTmo7XlrZDmoJHoh6rnhLbpg73msqHkuobvvInvvIxcbiAgICAvLyAgICDogIzkuI3mmK/pgJDoioLngrnov4fmu6TvvIjpgJDoioLngrnkvJrnlZnkuIsgZ2l6bW9Sb290IOmCo+S4gOaVtOajte+8ieOAglxuICAgIGNvbnN0IGhpZGVJbkhpZXJhcmNoeSA9ICgoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBmbGFncyA9IGNjLkNDT2JqZWN0ICYmIGNjLkNDT2JqZWN0LkZsYWdzO1xuICAgICAgICAgICAgaWYgKGZsYWdzICYmIHR5cGVvZiBmbGFncy5IaWRlSW5IaWVyYXJjaHkgPT09ICdudW1iZXInKSByZXR1cm4gZmxhZ3MuSGlkZUluSGllcmFyY2h5O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW8leaTjueJiOacrOWPmOWKqOaXtuWbnuiQveWIsCAzLjguNiDnmoTlrp7mtYvlgLwgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gMTAyNDtcbiAgICB9KSgpO1xuXG4gICAgLyoqIOWQjeWtl+WFnOW6le+8muS4h+S4gOWTquWkqSBgRmxhZ3MuSGlkZUluSGllcmFyY2h5YCDmjKrkvY3kuobvvIzov5nkuKTkuKrmoLnov5jog73ooqvorqTlh7rmnaUgKi9cbiAgICBjb25zdCBlZGl0b3JSb290TmFtZXMgPSBbJ0VkaXRvciBTY2VuZSBGb3JlZ3JvdW5kJywgJ0VkaXRvciBTY2VuZSBCYWNrZ3JvdW5kJ107XG5cbiAgICBjb25zdCBpc0VkaXRvck5vZGUgPSAobm9kZTogYW55KTogYm9vbGVhbiA9PiB7XG4gICAgICAgIGlmICghbm9kZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gYGhpZGVGbGFnc2Ag5pivIENDT2JqZWN0IOeahOWFrOW8gOiuv+mXruWZqO+8iOWGhemDqOW3siAmIEFsbEhpZGVNYXNrc++8ie+8jOS8mOWFiOeUqOWug1xuICAgICAgICAgICAgY29uc3QgZmxhZ3MgPVxuICAgICAgICAgICAgICAgIHR5cGVvZiBub2RlLmhpZGVGbGFncyA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgPyBub2RlLmhpZGVGbGFnc1xuICAgICAgICAgICAgICAgICAgICA6IHR5cGVvZiBub2RlLl9vYmpGbGFncyA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgICA/IG5vZGUuX29iakZsYWdzXG4gICAgICAgICAgICAgICAgICAgICAgOiAwO1xuICAgICAgICAgICAgaWYgKChmbGFncyAmIGhpZGVJbkhpZXJhcmNoeSkgIT09IDApIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWPluS4jeWIsOagh+W/l+S9jeWwseWPquWJqeWQjeWtl+WFnOW6lSAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBlZGl0b3JSb290TmFtZXMuaW5kZXhPZihub2RlLm5hbWUpID49IDA7XG4gICAgfTtcblxuICAgIC8qKiDlrZDoioLngrnph4zlsZ7kuo7jgIznnJ/lrp7lhoXlrrnjgI3nmoTpgqPkupsgKi9cbiAgICBjb25zdCBjb250ZW50Q2hpbGRyZW4gPSAobm9kZTogYW55KTogYW55W10gPT4ge1xuICAgICAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSAobm9kZSAmJiBub2RlLmNoaWxkcmVuKSB8fCBbXTtcbiAgICAgICAgcmV0dXJuIGNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT4gIWlzRWRpdG9yTm9kZShjaGlsZCkpO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDmjIkgYC9gIOWIhuauteino+aekOi3r+W+hOOAglxuICAgICAqXG4gICAgICogKirkuLrku4DkuYjkuI3og73lj6rnlKggYGNjLmZpbmRgKirvvJpgY2MuZmluZCgnYS9iJylgIOaYr+aMiSBgL2Ag5YiH5byA6YCQ5bGC5om+5a2Q6IqC54K577yMXG4gICAgICog5LqO5pivKiroioLngrnlkI3ph4zlkKsgYC9gIOeahOi3r+W+hOawuOi/nOaJvuS4jeWIsCoq44CC5a6e5rWL5bel56iL6YeM5bCx5a2Y5ZyoXG4gICAgICogYGludGVybmFsL2VkaXRvci9ncmlkLTJkYCDkuI4gYGludGVybmFsL2VkaXRvci9ncmlkYCDov5nnp43lkI3lrZdcbiAgICAgKiDvvIjnvJbovpHlmajoh6rlt7HnlJ/miJDnmoTvvInvvIxgY2MuZmluZGAg5a+55a6D5Lus5LiA5b6L6L+U5ZueIG51bGwg4oCU4oCUIOiAjOS4lCoq6Z2Z6buY6L+U5ZueIG51bGwqKu+8jFxuICAgICAqIOiwg+eUqOaWueWPquS8muS7peS4ulwi6IqC54K55LiN5a2Y5ZyoXCLjgIJcbiAgICAgKlxuICAgICAqIOi/memHjOaUueaIkCoq6LSq5b+D5oyJ5q615Yy56YWNKirvvJrmr4/lsYLku47jgIzmnIDplb/nmoTkuIDmrrXjgI3lvIDlp4vor5XvvIzlhYjmioogYGludGVybmFsL2VkaXRvci9ncmlkLTJkYFxuICAgICAqIOaVtOS9k+W9k+aIkOS4gOS4quiKgueCueWQjeWOu+ivle+8jOS4jeihjOWGjemAgOWMluaIkCBgaW50ZXJuYWxgIOKGkiBgZWRpdG9yYCDihpIgYGdyaWQtMmRgIOS4ieWxguOAglxuICAgICAqIOS4pOenjeWcuuaZr+mDveiDveino+aekO+8jOS7o+S7t+aYr+eQhuiuuuS4iuWtmOWcqOatp+S5ie+8iOWQjOaXtuWtmOWcqOWQjeS4uiBgYS9iYCDnmoToioLngrnkuI4gYGFgIOS4i+eahCBgYmDvvInigJTigJRcbiAgICAgKiDpgqPnp43mg4XlhrXkvJjlhYjorqTjgIzlkI3lrZfmm7Tplb/jgI3nmoTpgqPkuKrvvIznrKblkIjnm7Top4njgIJcbiAgICAgKi9cbiAgICBjb25zdCByZXNvbHZlUGF0aEJ5U2VnbWVudHMgPSAocGF0aDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3Qgc2VnbWVudHMgPSBTdHJpbmcocGF0aClcbiAgICAgICAgICAgIC5zcGxpdCgnLycpXG4gICAgICAgICAgICAuZmlsdGVyKChzZWdtZW50OiBzdHJpbmcpID0+IHNlZ21lbnQubGVuZ3RoID4gMCk7XG4gICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDApIHJldHVybiBzY2VuZTtcblxuICAgICAgICAvLyDlhYHorrjmiorlnLrmma/oh6rlt7HnmoTlkI3lrZflhpnlnKjmnIDliY3pnaJcbiAgICAgICAgaWYgKHNlZ21lbnRzWzBdID09PSBzY2VuZS5uYW1lKSBzZWdtZW50cy5zaGlmdCgpO1xuICAgICAgICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gc2NlbmU7XG5cbiAgICAgICAgbGV0IGN1cnNvcjogYW55ID0gc2NlbmU7XG4gICAgICAgIGxldCBpbmRleCA9IDA7XG4gICAgICAgIHdoaWxlIChpbmRleCA8IHNlZ21lbnRzLmxlbmd0aCkge1xuICAgICAgICAgICAgbGV0IGZvdW5kOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgZm9yIChsZXQgZW5kID0gc2VnbWVudHMubGVuZ3RoOyBlbmQgPiBpbmRleDsgZW5kIC09IDEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBzZWdtZW50cy5zbGljZShpbmRleCwgZW5kKS5qb2luKCcvJyk7XG4gICAgICAgICAgICAgICAgbGV0IGNoaWxkOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNoaWxkID0gY3Vyc29yLmdldENoaWxkQnlOYW1lKGNhbmRpZGF0ZSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIGNoaWxkID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGNoaWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kID0gY2hpbGQ7XG4gICAgICAgICAgICAgICAgICAgIGluZGV4ID0gZW5kO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWZvdW5kKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGN1cnNvciA9IGZvdW5kO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJzb3I7XG4gICAgfTtcblxuICAgIC8qKiDmjIkgdXVpZCDmib7oioLngrnvvIjlhYjotbDlvJXmk47lv6vot6/lvoTvvIzmib7kuI3liLDlho3mlbTmoJHmiavvvIkgKi9cbiAgICBoZWxwZXJzLm5vZGVCeVV1aWQgPSAodXVpZDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKHNjZW5lLnV1aWQgPT09IHV1aWQpIHJldHVybiBzY2VuZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGZhc3QgPSBzY2VuZS5nZXRDaGlsZEJ5VXVpZCh1dWlkKTtcbiAgICAgICAgICAgIGlmIChmYXN0KSByZXR1cm4gZmFzdDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlvJXmk47lhoXpg6jlrp7njrDlj5jliqjml7blm57okL3liLDmlbTmoJHmiavmj48gKi9cbiAgICAgICAgfVxuICAgICAgICBsZXQgZm91bmQ6IGFueSA9IG51bGw7XG4gICAgICAgIGVhY2hOb2RlKHNjZW5lLCAobjogYW55KSA9PiB7XG4gICAgICAgICAgICBpZiAoIWZvdW5kICYmIG4udXVpZCA9PT0gdXVpZCkgZm91bmQgPSBuO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDmjInot6/lvoTmib7oioLngrnvvIzlpoIgYCdDYW52YXMvc2tpbGxfZGV0YWlscydg44CCXG4gICAgICpcbiAgICAgKiDlhYjnu5nlvJXmk47nmoQgYGNjLmZpbmRgIOivle+8iOWug+iupOW+lyBgLi5gIOS5i+exu+eahOi+ueinkuivreS5ie+8ie+8jOWksei0peWGjeiHquW3seaMieauteino+aekCDigJTigJRcbiAgICAgKiDlkI7ogIXmiY3og73lpITnkIYqKuWQjeWtl+mHjOWQqyBgL2AqKiDnmoToioLngrnvvIjlrp7mtYvlrZjlnKggYGludGVybmFsL2VkaXRvci9ncmlkLTJkYO+8ieOAglxuICAgICAqIOe8lui+keWZqOijhemlsOiKgueCuSoq54Wn5qC35om+5b6X5YiwKirvvIjmmL7lvI/ngrnlkI3lsLHkuI3or6Xooqvol4/vvInjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLm5vZGVCeVBhdGggPSAocGF0aDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGZhc3QgPSBjYy5maW5kKHBhdGgpO1xuICAgICAgICAgICAgaWYgKGZhc3QpIHJldHVybiBmYXN0O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWbnuiQvSAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNvbHZlUGF0aEJ5U2VnbWVudHMocGF0aCk7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOmBjeWOhuWcuuaZr+agke+8iOm7mOiupCoq6Lez6L+H57yW6L6R5Zmo6KOF6aWw6IqC54K5KirvvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSB2aXNpdCDorr/pl67lh73mlbBcbiAgICAgKiBAcGFyYW0gcm9vdCDotbflp4voioLngrnvvIzpu5jorqTlnLrmma/moLlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5pbmNsdWRlRWRpdG9yIOS4uiB0cnVlIOaXtui/niBnaXptby/nvZHmoLwv5Y+C6ICD5Zu+5LiA6LW36YGN5Y6GXG4gICAgICovXG4gICAgaGVscGVycy5lYWNoTm9kZSA9IChcbiAgICAgICAgdmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQsXG4gICAgICAgIHJvb3Q/OiBhbnksXG4gICAgICAgIG9wdGlvbnM/OiB7IGluY2x1ZGVFZGl0b3I/OiBib29sZWFuIH0sXG4gICAgKTogdm9pZCA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXJ0ID0gcm9vdCB8fCBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXN0YXJ0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IGluY2x1ZGVFZGl0b3IgPSBCb29sZWFuKG9wdGlvbnMgJiYgb3B0aW9ucy5pbmNsdWRlRWRpdG9yKTtcbiAgICAgICAgLy8g6L+t5Luj5byP5rex5bqm5LyY5YWI77yb5Ymq5p6d5Y+R55Sf5Zyo44CM5YWl5qCI44CN6L+Z5LiA5q2l77yI6Lez6L+H57yW6L6R5Zmo5qC577yM5pW05qO15a2Q5qCR5bCx5rKh5LqG77yJXG4gICAgICAgIGNvbnN0IHN0YWNrOiBhbnlbXSA9IFtzdGFydF07XG4gICAgICAgIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBub2RlID0gc3RhY2sucG9wKCk7XG4gICAgICAgICAgICB2aXNpdChub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkcmVuOiBhbnlbXSA9IG5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgaSA+PSAwOyBpIC09IDEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjaGlsZCA9IGNoaWxkcmVuW2ldO1xuICAgICAgICAgICAgICAgIGlmICghaW5jbHVkZUVkaXRvciAmJiBpc0VkaXRvck5vZGUoY2hpbGQpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBzdGFjay5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDlnLrmma/moJHmpoLop4gg4oCU4oCUIOS4gOasoeaLv+WIsOWxgue6p+mqqOaetu+8jOavlCBgcmV0dXJuIHNjZW5lYCDmnInnlKjlvpflpJrjgIJcbiAgICAgKlxuICAgICAqIOm7mOiupCoq6Lez6L+H57yW6L6R5Zmo6KOF6aWw6IqC54K5KirvvIjop4Ege0BsaW5rIGlzRWRpdG9yTm9kZX0g55qE6K+05piO77yJ77ybXG4gICAgICog6ZyA6KaB6L+eIGdpem1vIOS4gOi1t+eci+WwseS8oCBgaW5jbHVkZUVkaXRvcjogdHJ1ZWDjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBvcHRpb25zLm1heERlcHRoIOm7mOiupCAzXG4gICAgICogQHBhcmFtIG9wdGlvbnMud2l0aENvbXBvbmVudHMg5piv5ZCm5bim5LiK5q+P5Liq6IqC54K555qE57uE5Lu257G75Z6L5ZCNXG4gICAgICogQHBhcmFtIG9wdGlvbnMuaW5jbHVkZUVkaXRvciDmmK/lkKbljIXlkKvnvJbovpHlmaggZ2l6bW8v572R5qC8L+WPguiAg+Wbvu+8jOm7mOiupCBmYWxzZVxuICAgICAqL1xuICAgIGhlbHBlcnMudHJlZSA9IChcbiAgICAgICAgb3B0aW9ucz86IHsgcm9vdD86IGFueTsgbWF4RGVwdGg/OiBudW1iZXI7IHdpdGhDb21wb25lbnRzPzogYm9vbGVhbjsgaW5jbHVkZUVkaXRvcj86IGJvb2xlYW4gfSxcbiAgICApOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPT4ge1xuICAgICAgICBjb25zdCBvcHRzID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3Qgcm9vdCA9IG9wdHMucm9vdCB8fCBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXJvb3QpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBtYXhEZXB0aCA9IHR5cGVvZiBvcHRzLm1heERlcHRoID09PSAnbnVtYmVyJyA/IG9wdHMubWF4RGVwdGggOiAzO1xuICAgICAgICBjb25zdCBpbmNsdWRlRWRpdG9yID0gQm9vbGVhbihvcHRzLmluY2x1ZGVFZGl0b3IpO1xuXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gKG5vZGU6IGFueSwgZGVwdGg6IG51bWJlcik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgIHV1aWQ6IG5vZGUudXVpZCxcbiAgICAgICAgICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmIChvcHRzLndpdGhDb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgb3V0LmNvbXBvbmVudHMgPSAobm9kZS5jb21wb25lbnRzIHx8IFtdKS5tYXAoKGM6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgdHlwZTogY2MuanMuZ2V0Q2xhc3NOYW1lKGMpLCBlbmFibGVkOiBjLmVuYWJsZWQgfTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyB0eXBlOiAndW5rbm93bicgfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYWxsQ2hpbGRyZW46IGFueVtdID0gbm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkcmVuID0gaW5jbHVkZUVkaXRvclxuICAgICAgICAgICAgICAgID8gYWxsQ2hpbGRyZW5cbiAgICAgICAgICAgICAgICA6IGFsbENoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT4gIWlzRWRpdG9yTm9kZShjaGlsZCkpO1xuICAgICAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBvdXQuY2hpbGRDb3VudCA9IGNoaWxkcmVuLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBpZiAoZGVwdGggPCBtYXhEZXB0aCkge1xuICAgICAgICAgICAgICAgICAgICBvdXQuY2hpbGRyZW4gPSBjaGlsZHJlbi5tYXAoKGM6IGFueSkgPT4gYnVpbGQoYywgZGVwdGggKyAxKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgb3V0LmNoaWxkcmVuID0gY2hpbGRyZW4ubWFwKChjOiBhbnkpID0+ICh7IG5hbWU6IGMubmFtZSwgdXVpZDogYy51dWlkIH0pKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyDol4/kuobkuJzopb/lsLHor7TkuIDlo7DvvIzliKvorqnosIPnlKjmlrnku6XkuLrmoJHlsLHov5nkuYjlpKdcbiAgICAgICAgICAgIGNvbnN0IGhpZGRlbiA9IGFsbENoaWxkcmVuLmxlbmd0aCAtIGNoaWxkcmVuLmxlbmd0aDtcbiAgICAgICAgICAgIGlmIChoaWRkZW4gPiAwKSBvdXQuZWRpdG9yQ2hpbGRyZW5IaWRkZW4gPSBoaWRkZW47XG4gICAgICAgICAgICByZXR1cm4gb3V0O1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gYnVpbGQocm9vdCwgMCk7XG4gICAgfTtcblxuICAgIC8qKiDov5nkuKroioLngrnmmK/kuI3mmK/nvJbovpHlmajoh6rlt7HnmoToo4XppbDvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8iSAqL1xuICAgIGhlbHBlcnMuaXNFZGl0b3JOb2RlID0gKG5vZGU6IGFueSk6IGJvb2xlYW4gPT4gaXNFZGl0b3JOb2RlKG5vZGUpO1xuXG4gICAgLyoqIOecn+WunuWGheWuueWtkOiKgueCue+8iOW3sua7pOaOiee8lui+keWZqOijhemlsO+8iSAqL1xuICAgIGhlbHBlcnMuY29udGVudENoaWxkcmVuID0gKG5vZGU/OiBhbnkpOiBhbnlbXSA9PiBjb250ZW50Q2hpbGRyZW4obm9kZSB8fCBjdXJyZW50U2NlbmUoY2MpKTtcblxuICAgIC8qKlxuICAgICAqIOWxleW8gOS4gOS4quiKgueCueaIlue7hOS7tuS4uue6r+aVsOaNruWvueixoeOAglxuICAgICAqXG4gICAgICog6L+Z5pivIGBlbmdpbmVPYmplY3RUYWdgIOaRmOimgeeahOOAjOmAg+eUn+iIseOAje+8mui/lOWbnuWAvOW6j+WIl+WMluaXtum7mOiupOaKiiBjYyDlr7nosaHljovmiJBcbiAgICAgKiBgW05vZGUgbmFtZT14IHV1aWQ9eV1g77yM5oOz55yL57uG6IqC5bCx5b6X6LWwIGBkdW1wKClg77yM5a6D5LyaKirmmL7lvI/lj5blrZfmrrUqKu+8jFxuICAgICAqIOS6juaYr+aXouaLv+W+l+WIsOaVsOaNru+8jOWPiOS4jeS8muWboOS4uuW+queOr+W8leeUqOeCuOaOieOAglxuICAgICAqL1xuICAgIGhlbHBlcnMuZHVtcCA9ICh0YXJnZXQ6IGFueSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9PiB7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm4gbnVsbDtcblxuICAgICAgICAvLyDmmK/nu4Tku7bvvIjmnIkgbm9kZSDlrZfmrrXkuJToh6rouqvkuI3mmK8gTm9kZe+8iVxuICAgICAgICBpZiAodGFyZ2V0Lm5vZGUgJiYgIXRhcmdldC5jaGlsZHJlbikge1xuICAgICAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICBfX2tpbmQ6ICdjb21wb25lbnQnLFxuICAgICAgICAgICAgICAgIHR5cGU6ICgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2MuanMuZ2V0Q2xhc3NOYW1lKHRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRhcmdldC5jb25zdHJ1Y3RvciAmJiB0YXJnZXQuY29uc3RydWN0b3IubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pKCksXG4gICAgICAgICAgICAgICAgbm9kZTogc2hvcnROb2RlKHRhcmdldC5ub2RlKSxcbiAgICAgICAgICAgICAgICBlbmFibGVkOiB0YXJnZXQuZW5hYmxlZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIGNvbXBvbmVudFByb3BOYW1lcyh0YXJnZXQpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVhZCA9IHNhZmVSZWFkKHRhcmdldCwga2V5KTtcbiAgICAgICAgICAgICAgICBpZiAocmVhZC5vaykgcHJvcHNba2V5XSA9IHJlYWQudmFsdWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvdXQucHJvcHMgPSBwcm9wcztcbiAgICAgICAgICAgIHJldHVybiBvdXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDmmK/oioLngrlcbiAgICAgICAgaWYgKHRhcmdldC5jaGlsZHJlbiAmJiB0eXBlb2YgdGFyZ2V0LnV1aWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNvbXAgb2YgdGFyZ2V0LmNvbXBvbmVudHMgfHwgW10pIHtcbiAgICAgICAgICAgICAgICBsZXQgdHlwZU5hbWUgPSAndW5rbm93bic7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZU5hbWUgPSBjYy5qcy5nZXRDbGFzc05hbWUoY29tcCk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGVOYW1lID0gKGNvbXAuY29uc3RydWN0b3IgJiYgY29tcC5jb25zdHJ1Y3Rvci5uYW1lKSB8fCAndW5rbm93bic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIGNvbXBvbmVudFByb3BOYW1lcyhjb21wKSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCByZWFkID0gc2FmZVJlYWQoY29tcCwga2V5KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlYWQub2spIHByb3BzW2tleV0gPSByZWFkLnZhbHVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLnB1c2goeyB0eXBlOiB0eXBlTmFtZSwgZW5hYmxlZDogY29tcC5lbmFibGVkLCBwcm9wcyB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgX19raW5kOiAnbm9kZScsXG4gICAgICAgICAgICAgICAgbmFtZTogdGFyZ2V0Lm5hbWUsXG4gICAgICAgICAgICAgICAgdXVpZDogdGFyZ2V0LnV1aWQsXG4gICAgICAgICAgICAgICAgYWN0aXZlOiB0YXJnZXQuYWN0aXZlLFxuICAgICAgICAgICAgICAgIGFjdGl2ZUluSGllcmFyY2h5OiB0YXJnZXQuYWN0aXZlSW5IaWVyYXJjaHksXG4gICAgICAgICAgICAgICAgbGF5ZXI6IHRhcmdldC5sYXllcixcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdGFyZ2V0LnBvc2l0aW9uLFxuICAgICAgICAgICAgICAgIHJvdGF0aW9uOiB0YXJnZXQucm90YXRpb24sXG4gICAgICAgICAgICAgICAgc2NhbGU6IHRhcmdldC5zY2FsZSxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHNob3J0Tm9kZSh0YXJnZXQucGFyZW50KSxcbiAgICAgICAgICAgICAgICBjaGlsZHJlbjogKHRhcmdldC5jaGlsZHJlbiB8fCBbXSkubWFwKChjOiBhbnkpID0+IHNob3J0Tm9kZShjKSksXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBfX2tpbmQ6ICdwbGFpbicsIHZhbHVlOiB0YXJnZXQgfTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog6K+35rGC5LiA5qyh5pKk6ZSA5b+r54Wn44CCXG4gICAgICpcbiAgICAgKiDmnKzlh73mlbAqKuWPque9ruagh+W/l+S9jSoq77yM55yf5q2j55qEIGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsJ3NuYXBzaG90JylgXG4gICAgICog55Sx5Li76L+b56iL5Zyo5ou/5Yiw6L+U5Zue5YC85LmL5ZCO5omn6KGMIOKAlOKAlCDljp/lm6DvvJrlnLrmma/ohJrmnKzoh6rlt7Hot5HlnKggc2NlbmUg6L+b56iL6YeM77yMXG4gICAgICog5LuOIHNjZW5lIOi/m+eoi+WGjSBgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAuLi4pYCDmmK/nu5noh6rlt7Hlj5Hmtojmga/vvIxcbiAgICAgKiDovbvliJnmjpLpmJ/ph43liJnoh6rplIHjgILot6jov5vnqIvnmoTkuovkuqTnu5nlj5HotbfmlrnlgZrjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLnNuYXBzaG90ID0gKCk6IHZvaWQgPT4ge1xuICAgICAgICBzdGF0ZS5zbmFwc2hvdFJlcXVlc3RlZCA9IHRydWU7XG4gICAgfTtcblxuICAgIC8qKiDnnaHnnKDmjIflrprmr6vnp5LvvIjphY3lkIggYGF3YWl0YCDlgZrova7or6LvvIzmr5TorqnmqKHlnovlnKggdG9vbCBjYWxsIOS5i+mXtOW5suetieecgeW+l+Wkmu+8iSAqL1xuICAgIGhlbHBlcnMuc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNjAwMDAsIG1zIHwgMCkpKTtcbiAgICAgICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiDmiKrlj5YqKue8lui+keWZqOWcuuaZr+inhuWbvioq5b2T5YmN5LiA5bin77yM5a2Y5oiQIFBORy9KUEVH44CCXG4gICAgICpcbiAgICAgKiDmiYDop4HljbPmiYDlvpfvvIjlkKvnvZHmoLzkuI4gZ2l6bW/vvInvvIznlKjmnaXjgIznnIvkuIDnnLznlLvpnaLjgI3ogIzkuI3mmK/jgIzor7vkuIDkuLLlnZDmoIfjgI3igJTigJRcbiAgICAgKiDluIPlsYDlj6DlrZfjgIHotLTlm77nqbrnmb3jgIHoioLngrnot5Hlh7rlsY/luZXov5nnsbvpl67popjvvIznnIvnlLvpnaLkuIDnp5LlsLHog73lj5HnjrDjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBvcHRpb25zLnNhdmVQYXRoIOebruagh+aWh+S7tioq57ud5a+56Lev5b6EKirjgILnu5nkuoblsLHoh6rlt7HokL3nm5jvvIzov5Tlm57lgLzlj6rluKbot6/lvoTvvIjlsI/vvInvvJtcbiAgICAgKiAgIOS4jee7meOAgeaIluacrOeOr+Wig+WGmeS4jeS6huebmO+8jOWbnuiQveOAjOWIhuWdl+WbnuS8oOOAje+8jOeUseS4u+i/m+eoi+aLvOWbnuadpeiQveebmOOAglxuICAgICAqIEBwYXJhbSBvcHRpb25zLm1heFdpZHRoIOe8qeWIsOS4jei2hei/h+i/meS4quWuveW6pu+8jOm7mOiupCA2NDDvvIjotorlsI/otorlv6vjgIHlm57kvKDotorlsI/vvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5mb3JtYXQgYCdwbmcnYO+8iOm7mOiupO+8jOaXoOaNn++8ieaIliBgJ2pwZWcnYO+8iOS9k+enr+Wwj++8iVxuICAgICAqIEBwYXJhbSBvcHRpb25zLnF1YWxpdHkganBlZyDotKjph48gMC4xfjHvvIzpu5jorqQgMC45XG4gICAgICogQHBhcmFtIG9wdGlvbnMud2FpdE1zIOetieS4i+S4gOW4p+eahOS4iumZkO+8jOm7mOiupCA4MDBtc++8iOWcuuaZr+inhuWbvuayoeWcqOa4suafk+aXtuWFnOW6leebtOaOpeaKk+W9k+WJjee8k+WGsu+8iVxuICAgICAqL1xuICAgIGhlbHBlcnMuY2FwdHVyZVZpZXcgPSBhc3luYyAoXG4gICAgICAgIG9wdGlvbnM/OiB7XG4gICAgICAgICAgICBzYXZlUGF0aD86IHN0cmluZztcbiAgICAgICAgICAgIG1heFdpZHRoPzogbnVtYmVyO1xuICAgICAgICAgICAgZm9ybWF0Pzogc3RyaW5nO1xuICAgICAgICAgICAgcXVhbGl0eT86IG51bWJlcjtcbiAgICAgICAgICAgIHdhaXRNcz86IG51bWJlcjtcbiAgICAgICAgfSxcbiAgICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9PiB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICBjb25zdCBmb3JtYXQgPSBvcHRzLmZvcm1hdCA9PT0gJ2pwZWcnIHx8IG9wdHMuZm9ybWF0ID09PSAnanBnJyA/ICdqcGVnJyA6ICdwbmcnO1xuICAgICAgICBjb25zdCBtaW1lID0gZm9ybWF0ID09PSAnanBlZycgPyAnaW1hZ2UvanBlZycgOiAnaW1hZ2UvcG5nJztcbiAgICAgICAgY29uc3QgcXVhbGl0eSA9IHR5cGVvZiBvcHRzLnF1YWxpdHkgPT09ICdudW1iZXInID8gTWF0aC5taW4oMSwgTWF0aC5tYXgoMC4xLCBvcHRzLnF1YWxpdHkpKSA6IDAuOTtcbiAgICAgICAgY29uc3QgbWF4V2lkdGggPSB0eXBlb2Ygb3B0cy5tYXhXaWR0aCA9PT0gJ251bWJlcicgJiYgb3B0cy5tYXhXaWR0aCA+IDAgPyBNYXRoLmZsb29yKG9wdHMubWF4V2lkdGgpIDogNjQwO1xuICAgICAgICBjb25zdCB3YWl0TXMgPSB0eXBlb2Ygb3B0cy53YWl0TXMgPT09ICdudW1iZXInID8gTWF0aC5tYXgoMCwgTWF0aC5taW4oNTAwMCwgb3B0cy53YWl0TXMpKSA6IDgwMDtcblxuICAgICAgICBjb25zdCBjYW52YXMgPSBmaW5kVmlld0NhbnZhcyhjYyk7XG4gICAgICAgIGlmICghY2FudmFzKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5om+5LiN5Yiw5Zy65pmv6KeG5Zu+55qE55S75biD77yac2NlbmUg6L+b56iL6YeM5rKh5pyJ5Y+v55So55qEIGNhbnZhc+OAgicgfTtcblxuICAgICAgICBsZXQgZnJhbWU6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHBpeGVsczogVWludDhBcnJheSB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZnJhbWUgPSBhd2FpdCByZWFkVmlld1BpeGVscyhjYywgY2FudmFzLCB3YWl0TXMpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDor7vlj5bnlLvpnaLlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGVuY29kZWQ6IHsgZGF0YVVybDogc3RyaW5nOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZW5jb2RlZCA9IGVuY29kZUZyYW1lVG9EYXRhVXJsKGZyYW1lLnBpeGVscywgZnJhbWUud2lkdGgsIGZyYW1lLmhlaWdodCwge1xuICAgICAgICAgICAgICAgIG1heFdpZHRoLFxuICAgICAgICAgICAgICAgIG1pbWUsXG4gICAgICAgICAgICAgICAgcXVhbGl0eSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDnvJbnoIHlm77niYflpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY29tbWEgPSBlbmNvZGVkLmRhdGFVcmwuaW5kZXhPZignLCcpO1xuICAgICAgICBjb25zdCBiYXNlNjQgPSBjb21tYSA+PSAwID8gZW5jb2RlZC5kYXRhVXJsLnNsaWNlKGNvbW1hICsgMSkgOiAnJztcbiAgICAgICAgY29uc3QgaW5mbzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIHdpZHRoOiBlbmNvZGVkLndpZHRoLFxuICAgICAgICAgICAgaGVpZ2h0OiBlbmNvZGVkLmhlaWdodCxcbiAgICAgICAgICAgIHNvdXJjZVdpZHRoOiBmcmFtZS53aWR0aCxcbiAgICAgICAgICAgIHNvdXJjZUhlaWdodDogZnJhbWUuaGVpZ2h0LFxuICAgICAgICAgICAgZm9ybWF0LFxuICAgICAgICAgICAgYnl0ZXM6IE1hdGguZmxvb3IoKGJhc2U2NC5sZW5ndGggKiAzKSAvIDQpLFxuICAgICAgICAgICAgYmxhbmtSYXRpbzogc2FtcGxlQmxhbmtSYXRpbyhmcmFtZS5waXhlbHMpLFxuICAgICAgICAgICAgLy8g56m65Zu+5pe26L+Z5LiA5Z2X5bCx5piv562U5qGI55qE5LiA5Y2K77ya6KeBIHJlYWRWaWV3U3RhdGUg55qE5rOo6YeK77yI6K6+5aSH5qih5ouf6KKr5omT5o6J55qE6YKj5qyh5LqL5pWF77yJXG4gICAgICAgICAgICB2aWV3OiByZWFkVmlld1N0YXRlKGNjLCBjYW52YXMpLFxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IHNhdmVQYXRoID0gdHlwZW9mIG9wdHMuc2F2ZVBhdGggPT09ICdzdHJpbmcnICYmIG9wdHMuc2F2ZVBhdGgudHJpbSgpID8gb3B0cy5zYXZlUGF0aC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3Qgbm9kZSA9IGdldE5vZGVNb2R1bGVzKCk7XG4gICAgICAgIGlmIChzYXZlUGF0aCAmJiBub2RlKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRpciA9IG5vZGUucGF0aC5kaXJuYW1lKHNhdmVQYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGlyKSBub2RlLmZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIG5vZGUuZnMud3JpdGVGaWxlU3luYyhzYXZlUGF0aCwgQnVmZmVyLmZyb20oYmFzZTY0LCAnYmFzZTY0JykpO1xuICAgICAgICAgICAgICAgIHJldHVybiB7IC4uLmluZm8sIHRyYW5zcG9ydDogJ2ZpbGUnLCBwYXRoOiBzYXZlUGF0aCB9O1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgLy8g5YaZ5LiN6L+b5Y675Lmf6KaB6K6p6LCD55So5pa55ou/5Yiw5Zu+IOKAlOKAlCDlm57okL3liIblnZdcbiAgICAgICAgICAgICAgICBpbmZvLnNhdmVFcnJvciA9IGVycm9ySW5mbyhlcnIpLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjaHVua1NpemUgPSAzMDAwOyAvLyDmspnnrrHljZXlrZfnrKbkuLLkuIrpmZAgNDAwMO+8jOeVmeWHuuS9memHj1xuICAgICAgICBjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFzZTY0Lmxlbmd0aDsgaSArPSBjaHVua1NpemUpIGNodW5rcy5wdXNoKGJhc2U2NC5zbGljZShpLCBpICsgY2h1bmtTaXplKSk7XG4gICAgICAgIGlmIChjaHVua3MubGVuZ3RoID4gOTApIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgLi4uaW5mbyxcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6XG4gICAgICAgICAgICAgICAgICAgIGDmiKrlm77lpKrlpKfvvIzpnIDopoHlm57kvKAgJHtjaHVua3MubGVuZ3RofSDlnZfvvIjkuIrpmZAgOTDvvInvvJrmioogbWF4V2lkdGgg6LCD5bCPYCArXG4gICAgICAgICAgICAgICAgICAgIGDvvIjlvZPliY0gJHttYXhXaWR0aH3vvInjgIHmjaIganBlZ++8jOaIlue7meS4gOS4quWPr+WGmeeahCBzYXZlUGF0aOOAgmAsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IC4uLmluZm8sIHRyYW5zcG9ydDogJ2NodW5rcycsIGNodW5rU2l6ZSwgY2h1bmtzLCBjaHVua0NvdW50OiBjaHVua3MubGVuZ3RoIH07XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOaKiuOAjOi1hOa6kOW8leeUqOOAjeino+aekOaIkCBgU3ByaXRlRnJhbWVgIOKAlOKAlCAqKuWIq+WGjeaJi+aQkyB1dWlk77yM5Lmf5Yir55SoIGBjYy5yZXNvdXJjZXMubG9hZGAqKuOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI6L+Z5Liq5Yqp5omL5b+F6aG75a2Y5Zyo77yI5Lik5qyh5a6e5rWL5Luj5Lu377yJXG4gICAgICpcbiAgICAgKiDnvJbovpHlmajlnLrmma/kuIrkuIvmlofph4zjgIznu5nkuIDkuKogU3ByaXRlIOi1i+WbvueJh+OAjei/meS7tuS6i++8jCoq5LiJ5p2h55u06KeJ5YWo5piv6ZSZ55qEKirvvJpcbiAgICAgKlxuICAgICAqIHwg55u06KeJ5YaZ5rOVIHwg5a6e5rWL57uT5p6cIHxcbiAgICAgKiB8LS0tfC0tLXxcbiAgICAgKiB8IGBjYy5yZXNvdXJjZXMubG9hZCgndGV4dHVyZXMveC9zcHJpdGVGcmFtZScsIGNjLlNwcml0ZUZyYW1lLCBjYilgIHwgYENhbiBub3QgcGFyc2UgdGhpcyBpbnB1dDoge1wicGF0aFwiOuKApixcImJ1bmRsZVwiOlwiXCJ9YCDigJTigJQg57yW6L6R5Zmo5Zy65pmv6YeMIGBjYy5yZXNvdXJjZXNgIOi/meS4gOaho+ayoeiiq+ato+ehruWIneWni+WMliB8XG4gICAgICogfCBgcXVlcnktYXNzZXRzKHtwYXR0ZXJuOidkYjovL2Fzc2V0cy/igKYveC5wbmcvc3ByaXRlRnJhbWUnfSlgIHwgKirpnZnpu5jov5Tlm57nqbrmlbDnu4QqKu+8iOS4jeaKpemUme+8ieKGkiDku6XkuLrjgIzmsqHmnInov5nkuKrlrZDotYTmupDjgI0gfFxuICAgICAqIHwg55u05o6l5oqK5Zu+54mHIHV1aWQg5b2TIFNwcml0ZUZyYW1lIOeUqCB8IOaLv+WIsOeahOaYryBgVGV4dHVyZTJEYO+8jGBTcHJpdGUuc3ByaXRlRnJhbWVgIOi1i+WAvOS4jeaKpemUmeS9hioq55S75LiN5Ye65p2lKiogfFxuICAgICAqXG4gICAgICog5q2j56Gu55qE5LiA5p2h5piv44CM5Zu+54mHIHV1aWQgKyBgQGY5OTQxYCDlrZDotYTmupDplK4g4oaSIGBhc3NldE1hbmFnZXIubG9hZEFueSh7dXVpZH0pYOOAje+8jFxuICAgICAqIOS9humCo+S4qiBgZjk5NDFgIOaYr+i1hOa6kOW6k+eUn+aIkOeahO+8jOS4jeivpeeUseaooeWei+WOu+aLvOOAgui/memHjOaKiuaVtOadoei3r+aUtui/m+S4gOS4quWHveaVsO+8mlxuICAgICAqXG4gICAgICogYGBgXG4gICAgICogY29uc3Qgc2YgPSBhd2FpdCBsb2FkRnJhbWUoJ2RiOi8vYXNzZXRzL3Jlc291cmNlcy90ZXh0dXJlcy9jb21tb24vcmVjdF9yZF8yMC5wbmcnKTtcbiAgICAgKiBjb25zdCBzcHJpdGUgPSBub2RlLmFkZENvbXBvbmVudChjYy5TcHJpdGUpO1xuICAgICAqIHNwcml0ZS5zaXplTW9kZSA9IGNjLlNwcml0ZS5TaXplTW9kZS5DVVNUT007ICAgLy8g4oaQIOW/hemhu+WFiOS6jiBzcHJpdGVGcmFtZe+8iOingeWPpuS4gOadoeWdke+8iVxuICAgICAqIHNwcml0ZS5zcHJpdGVGcmFtZSA9IHNmO1xuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogIyMg5o6l5Y+X55qE5LiJ56eN5byV55SoXG4gICAgICpcbiAgICAgKiAxLiBgZGI6Ly9hc3NldHMvLi4uL3gucG5nYO+8iCoq5o6o6I2QKirvvJvlhpnmiJAgYC4uLi94LnBuZy9zcHJpdGVGcmFtZWAg5Lmf6KGM77yM5ZCO57yA5Lya6KKr5Y675o6J77yJ4oCU4oCUXG4gICAgICogICAg6LWwKirno4Hnm5jkuIrnmoQgYC5tZXRhYCoq77yaYGFzc2V0cy8855u45a+56Lev5b6EPi5tZXRhYCDph4wgYHN1Yk1ldGFzYCDkuK0gYG5hbWUgPT09ICdzcHJpdGVGcmFtZSdgXG4gICAgICogICAg6YKj5LiA5p2h55qEIGB1dWlkYCDlsLHmmK8gYDzlm74gdXVpZD5AZjk5NDFg44CCYC5tZXRhYCDmmK/otYTmupDlupPoh6rlt7HlhpnnmoTvvIznprvnur/lj6/or7vvvIxcbiAgICAgKiAgICDkuI3kvp3otZYgYEVkaXRvcmAg5Zyo5LiN5Zyo44CB5Lmf5LiN6ZyA6KaB5YaN5Y67IGVkaXRvciDkuIrkuIvmlofmn6XkuIDmrKHjgIJcbiAgICAgKiAyLiBgdXVpZEBmOTk0MWDvvIjlrZDotYTmupAgdXVpZO+8ieKAlOKAlCDnm7TmjqXnlKjjgIJcbiAgICAgKiAzLiDoo7jlm77niYcgdXVpZCDigJTigJQg5YWI5oyJ5Y6f5qC35Yqg6L2977yb5ou/5YiwIGBUZXh0dXJlMkRgIOaXtioq5YaN6K+V5LiA5qyhIGBAZjk5NDFgKipcbiAgICAgKiAgICDvvIhDcmVhdG9yIDMueCDnmoQgc3ByaXRlLWZyYW1lIOWtkOi1hOa6kOmUruWwseaYr+i/meS4quW4uOmHj++8ie+8jOW5tuWmguWunuivtOaYjuaYr+eMnOeahOOAglxuICAgICAqXG4gICAgICog6Kej5p6Q57uT5p6c5Zyo5ZCM5LiA5q616ISa5pys6YeM5Lya57yT5a2Y77yI5ZCM5LiA5Liq5byV55So6YeN5aSN5Y+W5LiN5Lya6YeN5aSN5Yqg6L2977yJ44CCXG4gICAgICog5ou/5LiN5Yiw5pe2Kirmipvlh7ror7TlvpfmuIXnmoTplJnor68qKu+8iOivlei/h+WTquS6m+WAmemAieOAgeavj+S4quWAmemAieaLv+WIsOS6huS7gOS5iOexu+Wei++8ie+8jFxuICAgICAqIOiAjOS4jeaYr+WbnuS4gOS4qiBgbnVsbGAg6K6p6LCD55So5pa55Y6754yc44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcmVmIC0g5LiK6Z2i5LiJ56eN5byV55So5LmL5LiA44CCXG4gICAgICogQHJldHVybnMg6K+l6LWE5rqQ55qEIGBTcHJpdGVGcmFtZWDjgIJcbiAgICAgKi9cbiAgICBjb25zdCBmcmFtZUNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcbiAgICBoZWxwZXJzLmxvYWRGcmFtZSA9IGFzeW5jIChyZWY6IHVua25vd24pOiBQcm9taXNlPGFueT4gPT4ge1xuICAgICAgICBjb25zdCByYXcgPSB0eXBlb2YgcmVmID09PSAnc3RyaW5nJyA/IHJlZi50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFyYXcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcImxvYWRGcmFtZShyZWYp77yacmVmIOaYr+epuueahOOAgueUqOazle+8mmxvYWRGcmFtZSgnZGI6Ly9hc3NldHMvcmVzb3VyY2VzL3RleHR1cmVzL2NvbW1vbi9yZWN0X3JkXzIwLnBuZycpXCIgK1xuICAgICAgICAgICAgICAgICAgICBcIu+8iOWbvueJh+i3r+W+hO+8jOWPr+ecgSAvc3ByaXRlRnJhbWXvvInmiJYgbG9hZEZyYW1lKCc8dXVpZD5AZjk5NDEnKeOAglwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZnJhbWVDYWNoZS5oYXMocmF3KSkgcmV0dXJuIGZyYW1lQ2FjaGUuZ2V0KHJhdyk7XG5cbiAgICAgICAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICAgICAgLyoqIOWKoOi9veS4gOS4qiB1dWlk77yI5Zue6LCD5byP77yM5LiO57yW6L6R5Zmo6YeM5a6e5rWL6IO955So55qE6YKj5p2h6Lev5LiA6Ie077yJ44CCICovXG4gICAgICAgIGNvbnN0IGxvYWRBbnkgPSAodXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+ID0+XG4gICAgICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY2MuYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnI6IGFueSwgYXNzZXQ6IGFueSkgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVyciA/IHJlamVjdChuZXcgRXJyb3IoZXJyLm1lc3NhZ2UgPyBTdHJpbmcoZXJyLm1lc3NhZ2UpIDogU3RyaW5nKGVycikpKSA6IHJlc29sdmUoYXNzZXQpLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGVycm9ySW5mbyhlcnIpLm1lc3NhZ2UpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICBpZiAoL0AvLnRlc3QocmF3KSkge1xuICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHJhdyk7XG4gICAgICAgIH0gZWxzZSBpZiAocmF3LmluZGV4T2YoJ2RiOi8vJykgPT09IDApIHtcbiAgICAgICAgICAgIGlmIChyYXcuaW5kZXhPZignZGI6Ly9hc3NldHMvJykgIT09IDApIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBsb2FkRnJhbWUg5Y+q6K6kIGRiOi8vYXNzZXRzLyDkuIvnmoTotYTmupDvvIjmlLbliLAgJHtyYXd977yJ44CCYCArXG4gICAgICAgICAgICAgICAgICAgICAgICAnZGI6Ly9pbnRlcm5hbCDmmK/lvJXmk47oh6rluKbotYTmupDjgIHmmKDlsITkuI3liLDlt6XnqIvnm67lvZXvvJvlhoXnva4gVUkg5Zu+6K+35oyJIHNraWxsIOmHjOeahOi3r+W+hOihqOeUqCBsb2FkQW55KHt1dWlkfSkg6YKj5p2h77yIdXVpZCDku44gYXNzZXQtZGIg5p+l77yJ44CCJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgcmVsID0gcmF3LnNsaWNlKCdkYjovL2Fzc2V0cy8nLmxlbmd0aCkucmVwbGFjZSgvXFwvKHNwcml0ZUZyYW1lfHRleHR1cmUpJC8sICcnKTtcbiAgICAgICAgICAgIGNvbnN0IHJvb3QgPSBwcm9qZWN0Um9vdCgpO1xuICAgICAgICAgICAgY29uc3Qgbm9kZU1vZHMgPSBnZXROb2RlTW9kdWxlcygpO1xuICAgICAgICAgICAgaWYgKCFyb290IHx8ICFub2RlTW9kcykge1xuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgICAgIGDmi7/kuI3liLDlt6XnqIvmoLnvvIhFZGl0b3IuUHJvamVjdC5wYXRo77yJ5oiWIG5vZGUg5qih5Z2X77yM5omA5Lul5rKh6IO96K+7ICR7cmVsfS5tZXRhIOKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAgICAgICAgICfmlLnnlKggbG9hZEZyYW1lKFwiPHV1aWQ+QGY5OTQxXCIp77yIdXVpZCDku44gZWRpdG9yIOS4iuS4i+aWhyBxdWVyeS1hc3NldHMg5ou/77yJ44CCJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZXRhRmlsZSA9IGAke25vZGVNb2RzLnBhdGguam9pbihyb290LCAnYXNzZXRzJywgcmVsKX0ubWV0YWA7XG4gICAgICAgICAgICAgICAgbGV0IG1ldGE6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgbWV0YSA9IEpTT04ucGFyc2Uobm9kZU1vZHMuZnMucmVhZEZpbGVTeW5jKG1ldGFGaWxlLCAndXRmLTgnKSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYOivu+S4jeWIsCAke3JlbH0ubWV0Ye+8iCR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX3vvIlgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3Qgc3ViTWV0YXMgPSBtZXRhICYmIHR5cGVvZiBtZXRhLnN1Yk1ldGFzID09PSAnb2JqZWN0JyAmJiBtZXRhLnN1Yk1ldGFzID8gbWV0YS5zdWJNZXRhcyA6IG51bGw7XG4gICAgICAgICAgICAgICAgaWYgKHN1Yk1ldGFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHN1Yk1ldGFzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZW50cnkgPSBzdWJNZXRhc1trZXldIHx8IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaXNTcHJpdGVGcmFtZSA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50cnkubmFtZSA9PT0gJ3Nwcml0ZUZyYW1lJyB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5LmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5LmltcG9ydGVyID09PSAnc3ByaXRlRnJhbWUnO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1Nwcml0ZUZyYW1lKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIOWtkOi1hOa6kOeahCB1dWlkIOWtl+auteacrOi6q+WwseW4piBgQGtleWDvvJvmsqHmnInlsLHoh6rlt7Hmi7xcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaCh0eXBlb2YgZW50cnkudXVpZCA9PT0gJ3N0cmluZycgJiYgZW50cnkudXVpZCA/IGVudHJ5LnV1aWQgOiBgJHttZXRhLnV1aWR9QCR7a2V5fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKGAke3JlbH0ubWV0YSDph4zmsqHmnIkgc3ByaXRlRnJhbWUg5a2Q6LWE5rqQ77yI5a6D5Y+v6IO95LiN5piv5Zu+54mH77yM5oiW6L+Y5rKh6KKr6LWE5rqQ5bqT5a+85YWl77yJYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoL15bMC05YS1mQS1GLV17MzIsNDB9JC8udGVzdChyYXcpKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGVzLnB1c2gocmF3KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBgbG9hZEZyYW1lIOiupOS4jeWHuui/meS4quW8leeUqO+8miR7cmF3feOAgue7mSBkYjovL2Fzc2V0cy/igKYg55qE5Zu+54mH6Lev5b6E44CBdXVpZEDlrZDotYTmupDplK7vvIzmiJboo7ggdXVpZOOAgmAsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxhc3QgPSAnJztcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjYW5kaWRhdGVzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBjYW5kaWRhdGVzW2ldO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IGxvYWRBbnkoY2FuZGlkYXRlKTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQgJiYgY2MuU3ByaXRlRnJhbWUgJiYgYXNzZXQgaW5zdGFuY2VvZiBjYy5TcHJpdGVGcmFtZSkge1xuICAgICAgICAgICAgICAgICAgICBmcmFtZUNhY2hlLnNldChyYXcsIGFzc2V0KTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBraW5kID0gYXNzZXQgJiYgYXNzZXQuY29uc3RydWN0b3IgJiYgYXNzZXQuY29uc3RydWN0b3IubmFtZSA/IGFzc2V0LmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgYXNzZXQ7XG4gICAgICAgICAgICAgICAgbGFzdCA9IGAke2NhbmRpZGF0ZX0g4oaSICR7a2luZH1gO1xuICAgICAgICAgICAgICAgIC8vIOaLv+WIsCBUZXh0dXJlMkTvvJrooaXkuIDmrKHmoIflh4bnmoQgc3ByaXRlRnJhbWUg5a2Q6LWE5rqQ6ZSu77yI5Y+q6KGl5LiA5qyh77yM5Yir5oqK6Ieq5bex57uV6L+b5q275b6q546v77yJXG4gICAgICAgICAgICAgICAgaWYgKGtpbmQgPT09ICdUZXh0dXJlMkQnICYmIGNhbmRpZGF0ZS5pbmRleE9mKCdAJykgPCAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaChgJHtjYW5kaWRhdGV9QGY5OTQxYCk7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYOijuCB1dWlkIOaLv+WIsOeahOi1hOa6kOaYryBUZXh0dXJlMkTvvIzor5XkuobkuIDmrKHmoIflh4bnmoQgQGY5OTQxIOWtkOi1hOa6kOmUrmApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGxhc3QgPSBgJHtjYW5kaWRhdGV9IOKGkiAke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBsb2FkRnJhbWUoJyR7cmF3fScpIOayoeiDveaLv+WIsCBTcHJpdGVGcmFtZeOAgiR7bGFzdCA/IGDmnIDlkI7kuIDmrKHvvJoke2xhc3R944CCYCA6ICcnfWAgK1xuICAgICAgICAgICAgICAgIChub3Rlcy5sZW5ndGggPiAwID8gYOWPpuWklu+8miR7bm90ZXMuam9pbign77ybJyl944CCYCA6ICcnKSArXG4gICAgICAgICAgICAgICAgXCIg5o6o6I2Q5YaZ5rOV77yabG9hZEZyYW1lKCdkYjovL2Fzc2V0cy9yZXNvdXJjZXMvdGV4dHVyZXMvY29tbW9uL3JlY3RfcmRfMjAucG5nJynjgIJcIixcbiAgICAgICAgKTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog5Y+W6IqC54K555qEIGBVSVRyYW5zZm9ybWDvvIjmi7/kuI3liLDlsLEgbnVsbO+8ieOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB5YyF5LiA5bGC77yaYGNjLlVJVHJhbnNmb3JtYCDmnKzouqvlj6/og73lj5bkuI3liLDvvIjlvJXmk47niYjmnKwv6Z2eIFVJIOiKgueCue+8ie+8jFxuICAgICAqIOi/meaXtiBgZ2V0Q29tcG9uZW50KHVuZGVmaW5lZClgIOacieeahOeJiOacrOS8muaKmyDigJTigJQg5biD5bGA6K6h566X5LiN6K+l5Zug5Li65Y+W5LiN5Yiw5bC65a+46ICM5pW05p2h5oyC5o6J77yMXG4gICAgICog5a696auY5oyJIDAg566X44CB5oqK5Z2Q5qCH54Wn5bi45oql5Ye65Y675pu05pyJ55So77yI6LCD55So5pa555yL5YiwIGB3aWR0aDogMGAg6Ieq54S255+l6YGT5piv5rKh6YeP5Yiw77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgdWlUcmFuc2Zvcm1PZiA9IChub2RlOiBhbnkpOiBhbnkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFub2RlIHx8IHR5cGVvZiBub2RlLmdldENvbXBvbmVudCAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAoIWNjLlVJVHJhbnNmb3JtKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIHJldHVybiBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSkgfHwgbnVsbDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDoioLngrnlnKgqKue8lui+keaAgeS4i+WPr+S/oeeahCoq5LiW55WM55+p5b2iIOKAlOKAlCDliKvnlKggYFVJVHJhbnNmb3JtLmdldEJvdW5kaW5nQm94VG9Xb3JsZCgpYOOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI5LiN6IO955So5byV5pOO6YKj5LiqXG4gICAgICpcbiAgICAgKiDlrp7mtYvvvIhDb2NvcyAzLjguNiDnvJbovpHmgIHvvInvvJrlkIzkuIDmo7XmoJHph4wgYHZpZXdg77yIYGNvbnRlbnRTaXplYCA3MTDDlzEwNzTjgIFwb3NpdGlvbiAoMCwwKe+8iVxuICAgICAqIOiiqyBgZ2V0Qm91bmRpbmdCb3hUb1dvcmxkKClgIOaKpeaIkCAqKjcxMMOXMTE3MCoq77yM6ICMIDExNzAg5oGw5aW95piv5a6D5a2Q6IqC54K5IGBjb250ZW50YCDnmoTpq5jluqbvvJtcbiAgICAgKiBgY29udGVudGAg55qEIHgg5Lmf6KKr5oql5YGP44CCKirlroPnu5nnmoTmmK/oh6rnm7jnn5vnm77nmoTlgLwqKu+8jOiAjOW4g+WxgOmqjOaUtuWFqOmdoOi/meS4quaVsOOAglxuICAgICAqXG4gICAgICogIyMg6L+Z6YeM55qE566X5rOV77yI5LiOIGBjb250ZW50U2l6ZWAg6Ieq5rS977yM6IO95omL5bel5qC45a+577yJXG4gICAgICpcbiAgICAgKiDniLboioLngrnnmoQqKumUmueCuSoq5bCx5piv5a2Q6IqC54K55bGA6YOo5Z2Q5qCH55qE5Y6f54K577yM5LqO5piv6Ieq5LiL6ICM5LiK57Sv5Yqg77yaXG4gICAgICpcbiAgICAgKiBgYGBcbiAgICAgKiDplJrngrnkuJbnlYzlnZDmoIcobikgPSDplJrngrnkuJbnlYzlnZDmoIcocGFyZW50KSArIHNjYWxl6ZO+KG4pIOKKmSBuLnBvc2l0aW9uXG4gICAgICog5Lit5b+D5LiW55WM5Z2Q5qCHKG4pID0g6ZSa54K55LiW55WM5Z2Q5qCHKG4pICsgc2NhbGXpk74obikg4oqZICgoMC41LWF4KcK3dywgKDAuNS1heSnCt2gpXG4gICAgICog5LiW55WM5bC65a+4KG4pICAgICA9IHNjYWxl6ZO+KG4pIOKKmSAodywgaCkgICAgICAgIC8vIOS4jeiAg+iZkeaXi+i9rFxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogYHNjYWxl6ZO+KG4pYCA9IG4gKirmiYDmnInnpZblhYgqKu+8iOS4jeWQq+iHquW3se+8ieeahCBzY2FsZSDkuZjnp6/vvJtgcm9vdGAg5pys6Lqr5LiN5Y+C5LiO57Sv5Yqg77yMXG4gICAgICog5omA5Lul57uZIGByb290YCDml7bov5Tlm57lgLzlsLHmmK8qKuS7pSByb290IOeahOmUmueCueS4uuWOn+eCuSoq55qE5Z2Q5qCH77yI6L+Z5q2j5pivXCLov5nlvKDljaHlnKggQ2FudmFzIOmHjFxuICAgICAqIOWBj+S6huWkmuWwkVwi6KaB55qE6YKj5Liq5pWw77yJ44CC5LiN57uZIGByb290YCDlsLHkuIDot6/ntK/liqDliLDlnLrmma/moLnjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBub2RlIC0g55uu5qCH6IqC54K544CCXG4gICAgICogQHBhcmFtIG9wdGlvbnMucm9vdCAtIOe0r+WKoOeahOe7iOeCue+8iOi/lOWbnuWdkOagh+S7peWug+eahOmUmueCueS4uuWOn+eCue+8ie+8m+m7mOiupOWcuuaZr+agueOAglxuICAgICAqIEByZXR1cm5zIGB7Y3gsIGN5LCB3aWR0aCwgaGVpZ2h0LCBsZWZ0LCByaWdodCwgYm90dG9tLCB0b3AsIGFuY2hvclgsIGFuY2hvclksIHNjYWxlWCwgc2NhbGVZfWBcbiAgICAgKiAgIOKAlOKAlCBgbGVmdC9yaWdodC9ib3R0b20vdG9wYCDmmK/nn6nlvaLnmoTlm5vmnaHovrnvvIxgY3gvY3lgIOaYr+S4reW/g+OAgioq5Z2Q5qCH57O75Li644CMK3gg5ZCR5Y+z44CBK3kg5ZCR5LiK44CNKirjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLndvcmxkUmVjdCA9IChcbiAgICAgICAgbm9kZTogYW55LFxuICAgICAgICBvcHRpb25zPzogeyByb290PzogYW55IH0sXG4gICAgKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBpZiAoIW5vZGUpIHRocm93IG5ldyBFcnJvcignd29ybGRSZWN0KG5vZGUp77yabm9kZSDmmK/nqbrnmoTjgIInKTtcbiAgICAgICAgY29uc3Qgc3RvcEF0ID0gb3B0aW9ucyAmJiBvcHRpb25zLnJvb3QgPyBvcHRpb25zLnJvb3QgOiBudWxsO1xuXG4gICAgICAgIC8vIOKRoCDlhYjoh6rkuIvogIzkuIrmlLbpm4bpk77ot6/vvJpbbm9kZSwgcGFyZW50LCDigKYsIChzdG9wQXQgfCDlnLrmma/moLkpXVxuICAgICAgICBjb25zdCBjaGFpbjogYW55W10gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgY3Vyc29yID0gbm9kZTsgY3Vyc29yOyBjdXJzb3IgPSBjdXJzb3IucGFyZW50KSB7XG4gICAgICAgICAgICBjaGFpbi5wdXNoKGN1cnNvcik7XG4gICAgICAgICAgICBpZiAoc3RvcEF0ICYmIGN1cnNvciA9PT0gc3RvcEF0KSBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOKRoSDku47pk77ot6/pobbnq6/lvoDkuIvntK/liqDjgILpobbnq6/vvIhzdG9wQXQg5oiW5Zy65pmv5qC577yJ55qE6ZSa54K55bCx5piv5Y6f54K577yaYW5jaG9yPSgwLDAp44CBUz0oMSwxKVxuICAgICAgICBsZXQgYW5jaG9yWCA9IDA7XG4gICAgICAgIGxldCBhbmNob3JZID0gMDtcbiAgICAgICAgbGV0IHN4ID0gMTtcbiAgICAgICAgbGV0IHN5ID0gMTtcbiAgICAgICAgZm9yIChsZXQgaSA9IGNoYWluLmxlbmd0aCAtIDI7IGkgPj0gMDsgaSAtPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBjaGlsZCA9IGNoYWluW2ldO1xuICAgICAgICAgICAgY29uc3QgcGFyZW50ID0gY2hhaW5baSArIDFdO1xuICAgICAgICAgICAgY29uc3QgcHMgPSBwYXJlbnQuc2NhbGUgfHwgeyB4OiAxLCB5OiAxIH07XG4gICAgICAgICAgICBzeCAqPSB0eXBlb2YgcHMueCA9PT0gJ251bWJlcicgPyBwcy54IDogMTtcbiAgICAgICAgICAgIHN5ICo9IHR5cGVvZiBwcy55ID09PSAnbnVtYmVyJyA/IHBzLnkgOiAxO1xuICAgICAgICAgICAgY29uc3QgcG9zID0gY2hpbGQucG9zaXRpb24gfHwgeyB4OiAwLCB5OiAwIH07XG4gICAgICAgICAgICBhbmNob3JYICs9IHN4ICogcG9zLng7XG4gICAgICAgICAgICBhbmNob3JZICs9IHN5ICogcG9zLnk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDikaIg6ZSa54K5IOKGkiDkuK3lv4PvvIjplJrngrnlgY/np7vkuZ/opoHot5/nnYDpk77kuIrnmoTnvKnmlL7kuIDotbfnvKnmlL7vvIlcbiAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICBjb25zdCB3aWR0aCA9IHV0ID8gdXQud2lkdGggOiAwO1xuICAgICAgICBjb25zdCBoZWlnaHQgPSB1dCA/IHV0LmhlaWdodCA6IDA7XG4gICAgICAgIGNvbnN0IGF4ID0gdXQgPyB1dC5hbmNob3JYIDogMC41O1xuICAgICAgICBjb25zdCBheSA9IHV0ID8gdXQuYW5jaG9yWSA6IDAuNTtcbiAgICAgICAgY29uc3QgY3ggPSBhbmNob3JYICsgc3ggKiAoMC41IC0gYXgpICogd2lkdGg7XG4gICAgICAgIGNvbnN0IGN5ID0gYW5jaG9yWSArIHN5ICogKDAuNSAtIGF5KSAqIGhlaWdodDtcbiAgICAgICAgY29uc3QgaGFsZlcgPSAoc3ggKiB3aWR0aCkgLyAyO1xuICAgICAgICBjb25zdCBoYWxmSCA9IChzeSAqIGhlaWdodCkgLyAyO1xuICAgICAgICBjb25zdCByb3VuZCA9ICh2YWx1ZTogbnVtYmVyKTogbnVtYmVyID0+IE1hdGgucm91bmQodmFsdWUgKiAxMDAwKSAvIDEwMDA7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICBjeDogcm91bmQoY3gpLFxuICAgICAgICAgICAgY3k6IHJvdW5kKGN5KSxcbiAgICAgICAgICAgIHdpZHRoOiByb3VuZChzeCAqIHdpZHRoKSxcbiAgICAgICAgICAgIGhlaWdodDogcm91bmQoc3kgKiBoZWlnaHQpLFxuICAgICAgICAgICAgbGVmdDogcm91bmQoY3ggLSBoYWxmVyksXG4gICAgICAgICAgICByaWdodDogcm91bmQoY3ggKyBoYWxmVyksXG4gICAgICAgICAgICBib3R0b206IHJvdW5kKGN5IC0gaGFsZkgpLFxuICAgICAgICAgICAgdG9wOiByb3VuZChjeSArIGhhbGZIKSxcbiAgICAgICAgICAgIGFuY2hvclg6IGF4LFxuICAgICAgICAgICAgYW5jaG9yWTogYXksXG4gICAgICAgICAgICBzY2FsZVg6IHJvdW5kKHN4KSxcbiAgICAgICAgICAgIHNjYWxlWTogcm91bmQoc3kpLFxuICAgICAgICAgICAgLyoqIOWdkOagh+ezu+WPo+W+hO+8iOWGmei/m+e7k+aenOmHjO+8jOWFjeW+l+iwg+eUqOaWueiHquW3seeMnOWOn+eCueWcqOWTqu+8iSAqL1xuICAgICAgICAgICAgb3JpZ2luOiBzdG9wQXQgPyBg5LulICR7c3RvcEF0Lm5hbWV9IOeahOmUmueCueS4uuWOn+eCue+8iCt4IOWQkeWPsyAvICt5IOWQkeS4iu+8iWAgOiAn5Lul5Zy65pmv5qC56ZSa54K55Li65Y6f54K577yIK3gg5ZCR5Y+zIC8gK3kg5ZCR5LiK77yJJyxcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog5Zy65pmvKirnnJ/lrp7lhoXlrrkqKueahOS4lueVjOWMheWbtOebku+8iOaKiuavj+S4quW4piBgVUlUcmFuc2Zvcm1gIOeahOWGheWuueiKgueCueW5tui1t+adpe+8ieOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI5LiN6IO96Z2g6YGN5Y6G5YWo5L2T6IqC54K5XG4gICAgICpcbiAgICAgKiDnvJbovpHlmajlnLrmma/moJHph4wgOTclIOeahOiKgueCueaYr+e8lui+keWZqOiHquW3seeahOijhemlsO+8iOWunua1i++8muS4gOS4quWPquaciSBDYW52YXMg55qE56m65Zy65pmvXG4gICAgICog5YWxIDEyOCDkuKroioLngrnvvIzlhbbkuK0gMiDkuKrmmK/lhoXlrrnjgIExMTcg5Liq5ZyoIGBFZGl0b3IgU2NlbmUgRm9yZWdyb3VuZGDjgIE4IOS4quWcqCBgQmFja2dyb3VuZGDvvInjgIJcbiAgICAgKiDkuI3liarmjonpgqPkuKTmo7XvvIznrpflh7rmnaXnmoRcIuWcuuaZr+iMg+WbtFwi5Lya5piv5pW05byg572R5qC844CCXG4gICAgICog5Ymq5p6d5Yik5o2u5LiOIGBlYWNoTm9kZWAg5a6M5YWo5LiA6Ie077yIYGlzRWRpdG9yTm9kZWDvvInjgIJcbiAgICAgKlxuICAgICAqICMjIOWug+acieS4pOS4qua2iOi0ueiAhVxuICAgICAqXG4gICAgICogMS4gKirmiKrlm77lj5bmma8qKu+8iGBmaXRWaWV3YCAvIGB2aWV3TWV0cmljcy5mcmFtaW5nYO+8ieKAlOKAlCDjgIzmlbTkuKrlnLrmma/jgI3liLDlupXmjIflk6rlnZfnn6nlvaLvvIxcbiAgICAgKiAgICDliKTmja7lv4XpobvmmK/lkIzkuIDkuKrvvIzlkKbliJnkvJrlh7rnjrBcIuWPluaZr+ahhiBB44CB6aqM5pS255yLIEJcIu+8m1xuICAgICAqIDIuIOaooeWei+iHquW3semXruOAjOaIkeeahOWcuuaZr+WGheWuueWkmuWkp+OAgei3keWIsOWTquWEv+WOu+S6huOAjeOAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtsZWZ0LCByaWdodCwgYm90dG9tLCB0b3AsIGN4LCBjeSwgd2lkdGgsIGhlaWdodCwgY291bnQsIHV1aWRzLCBub3RlP31gXG4gICAgICogICDigJTigJQgYHV1aWRzYCDmmK8qKuS6pOe7mee8lui+keWZqCBgZm9jdXMoKWAg55So55qE6YKj5LiyKirvvIjmr4/kuIDmnaHmlK/ot6/kuIrmnIDmtYXnmoTjgIHnnJ/mnInlsLrlr7jnmoToioLngrnvvIxcbiAgICAgKiAgIOmAmuW4uOWwseaYryBgQ2FudmFzYO+8ie+8jOacgOWkmiA4IOS4qu+8m+WGheWuueWFqOaYr+epuuiKgueCueaXtiBgd2lkdGgvaGVpZ2h0YCDkuLogMO+8iOWmguWunuWbniAw77yM5LiN57yW5qGG77yJ44CCXG4gICAgICovXG4gICAgaGVscGVycy5jb250ZW50Qm91bmRzID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICAgICAgY29uc3Qgcm91bmQgPSAodmFsdWU6IG51bWJlcik6IG51bWJlciA9PiBNYXRoLnJvdW5kKHZhbHVlICogMTAwMCkgLyAxMDAwO1xuICAgICAgICAvKiogYGhlbHBlcnNgIOiHquW3seeahOexu+Wei+aYryBgUmVjb3JkPHN0cmluZywgdW5rbm93bj5g77yM6L+Z6YeM5oyJ562+5ZCN5Y+W5Ye65p2l55So77yI5ZCMIGB3b3JsZFJlY3RgIOWGhemDqOeahOWBmuazle+8iSAqL1xuICAgICAgICBjb25zdCBlYWNoID0gaGVscGVycy5lYWNoTm9kZSBhcyAodmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgICAgIGNvbnN0IHJlY3RPZiA9IGhlbHBlcnMud29ybGRSZWN0IGFzIChub2RlOiBhbnksIG9wdGlvbnM/OiB7IHJvb3Q/OiBhbnkgfSkgPT4gUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgbGV0IGxlZnQgPSBJbmZpbml0eTtcbiAgICAgICAgbGV0IHJpZ2h0ID0gLUluZmluaXR5O1xuICAgICAgICBsZXQgYm90dG9tID0gSW5maW5pdHk7XG4gICAgICAgIGxldCB0b3AgPSAtSW5maW5pdHk7XG4gICAgICAgIGxldCBjb3VudCA9IDA7XG5cbiAgICAgICAgZWFjaCgobm9kZTogYW55KSA9PiB7XG4gICAgICAgICAgICBjb25zdCB1dCA9IHVpVHJhbnNmb3JtT2Yobm9kZSk7XG4gICAgICAgICAgICBpZiAoIXV0IHx8ICEodXQud2lkdGggPiAwKSB8fCAhKHV0LmhlaWdodCA+IDApKSByZXR1cm47XG4gICAgICAgICAgICBsZXQgcmVjdDogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVjdCA9IHJlY3RPZihub2RlKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJldHVybjsgLy8g5Y2V5Liq6IqC54K56YeP5LiN5Ye65p2l5LiN6K+l6K6p5pW05byg6KGo5oyC5o6JXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIVtyZWN0LmxlZnQsIHJlY3QucmlnaHQsIHJlY3QuYm90dG9tLCByZWN0LnRvcF0uZXZlcnkoKHYpID0+IHR5cGVvZiB2ID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodikpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY291bnQgKz0gMTtcbiAgICAgICAgICAgIGlmIChyZWN0LmxlZnQgPCBsZWZ0KSBsZWZ0ID0gcmVjdC5sZWZ0O1xuICAgICAgICAgICAgaWYgKHJlY3QucmlnaHQgPiByaWdodCkgcmlnaHQgPSByZWN0LnJpZ2h0O1xuICAgICAgICAgICAgaWYgKHJlY3QuYm90dG9tIDwgYm90dG9tKSBib3R0b20gPSByZWN0LmJvdHRvbTtcbiAgICAgICAgICAgIGlmIChyZWN0LnRvcCA+IHRvcCkgdG9wID0gcmVjdC50b3A7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8qKiDkuqTnu5kgYGZvY3VzKClgIOeahCB1dWlk77ya5q+P5LiA5p2h5pSv6Lev5LiKKirmnIDmtYXnmoQqKumCo+S4quecn+acieWwuuWvuOeahOiKgueCue+8iOmAmuW4uOWwseaYryBDYW52YXPvvIkgKi9cbiAgICAgICAgY29uc3QgdXVpZHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGNvbnN0IGZvY3VzV2FsayA9IChub2RlOiBhbnkpOiB2b2lkID0+IHtcbiAgICAgICAgICAgIGlmICh1dWlkcy5sZW5ndGggPj0gOCkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICAgICAgaWYgKHV0ICYmIHV0LndpZHRoID4gMCAmJiB1dC5oZWlnaHQgPiAwKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vZGUudXVpZCkgdXVpZHMucHVzaChub2RlLnV1aWQpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY29udGVudENoaWxkcmVuKG5vZGUpKSBmb2N1c1dhbGsoY2hpbGQpO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmIChzY2VuZSkge1xuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIGNvbnRlbnRDaGlsZHJlbihzY2VuZSkpIGZvY3VzV2Fsayhyb290KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb3VudCA9PT0gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBsZWZ0OiAwLFxuICAgICAgICAgICAgICAgIHJpZ2h0OiAwLFxuICAgICAgICAgICAgICAgIGJvdHRvbTogMCxcbiAgICAgICAgICAgICAgICB0b3A6IDAsXG4gICAgICAgICAgICAgICAgY3g6IDAsXG4gICAgICAgICAgICAgICAgY3k6IDAsXG4gICAgICAgICAgICAgICAgd2lkdGg6IDAsXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiAwLFxuICAgICAgICAgICAgICAgIGNvdW50LFxuICAgICAgICAgICAgICAgIHV1aWRzLFxuICAgICAgICAgICAgICAgIG5vdGU6ICflnLrmma/ph4zmsqHmnInluKYgVUlUcmFuc2Zvcm0g5LiU5bC65a+45aSn5LqOIDAg55qE5YaF5a656IqC54K577yI6YeP5LiN5Ye65YaF5a656IyD5Zu077yJJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB3aWR0aCA9IHJpZ2h0IC0gbGVmdDtcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gdG9wIC0gYm90dG9tO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbGVmdDogcm91bmQobGVmdCksXG4gICAgICAgICAgICByaWdodDogcm91bmQocmlnaHQpLFxuICAgICAgICAgICAgYm90dG9tOiByb3VuZChib3R0b20pLFxuICAgICAgICAgICAgdG9wOiByb3VuZCh0b3ApLFxuICAgICAgICAgICAgY3g6IHJvdW5kKChsZWZ0ICsgcmlnaHQpIC8gMiksXG4gICAgICAgICAgICBjeTogcm91bmQoKGJvdHRvbSArIHRvcCkgLyAyKSxcbiAgICAgICAgICAgIHdpZHRoOiByb3VuZCh3aWR0aCksXG4gICAgICAgICAgICBoZWlnaHQ6IHJvdW5kKGhlaWdodCksXG4gICAgICAgICAgICBjb3VudCxcbiAgICAgICAgICAgIHV1aWRzLFxuICAgICAgICAgICAgLyoqIOWdkOagh+ezu+WPo+W+hOWGmei/m+e7k+aenO+8jOiwg+eUqOaWueS4jeeUqOeMnOWOn+eCuSAqL1xuICAgICAgICAgICAgb3JpZ2luOiAn5Lul5Zy65pmv5qC56ZSa54K55Li65Y6f54K577yIK3gg5ZCR5Y+zIC8gK3kg5ZCR5LiK77yJJyxcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyDlm5vkuKrjgIzmiorkuIDova7or5XplJnljovmiJDkuIDmrKHosIPnlKjjgI3nmoTliqnmiYtcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vXG4gICAgLy8g5a6D5Lus5LiN5piv6JaE5YyF6KOF44CC5q+P5Liq6YO95a+55bqUKirkuIDmrKHlrp7mtYvnmoTlvK/ot68qKu+8jOiAjOS4lOWFseWQjOa7oei2s+S4gOS4quWIpOaNru+8mlxuICAgIC8vICoqbmFpdmUg5YaZ5rOV6KaB5LmI5Lya566X6ZSZ44CB6KaB5LmI5pyJ5Ymv5L2c55So44CB6KaB5LmI6KaBIE4g6L2u5omN5ou/5b6X5Yiw57uT6K66KirjgIJcbiAgICAvL1xuICAgIC8vIHwg5Yqp5omLIHwg5a6D5pu/5Luj5o6J55qE5byv6LevIHxcbiAgICAvLyB8LS0tfC0tLXxcbiAgICAvLyB8IGBwaWNrYCB8IOOAjOaIquWbvumHjOacieS4que0q+aWueWdlyDihpIg5p6a5Li+5a2Q5qCRIOKGkiDpopzoibLnm7Tmlrnlm74g4oaSIOWPjeeul+WdkOaghyDihpIgZ3JlcCDpooTliLbku7bjgI0xNiDova7vvIznu5PorrrmmK/lroPmmK/nvJbovpHlmaggZ2l6bW8gfFxuICAgIC8vIHwgYGxhYmVsRml0YCB8IOOAjOi/meS4quahhuaUvuS4jeaUvuW+l+S4i+i/meihjOWtl+OAjemdoOaUueecnyBMYWJlbCArIOW7uuaOoumSiOWNoeaIquWbvu+8jOivleS6hiAzIOi9ru+8iOi/mOi/neWPjeS6hlwi5Yir5Zyo55yf5a6e5Zy65pmv6YeM5YGa5a6e6aqMXCLvvIkgfFxuICAgIC8vIHwgYHNuYXBzaG90VHJlZWAvYGRpZmZUcmVlYCB8IOOAjOaIkeWIsOW6leaUueS6huS7gOS5iOOAjemdoOiusOW/hu+8jOa8j+aOieS6huiHquW3seeVmeS4i+eahOaOoumSiOiKgueCuSB8XG4gICAgLy9cbiAgICAvLyDlj6bkuIDmnaHlhbHlkIzlj6PlvoTvvJoqKuiDvemXruWPjeS6i+WunioqIOKAlOKAlCBgcGlja2Ag6ZeuXCLov5nkuKrlg4/ntKDkuIrnjrDlnKjmmK/osIFcIu+8jFxuICAgIC8vIGBsYWJlbEZpdGAg6ZeuXCLmoYbmlLnmiJAgMjEwIOaUvuS4jeaUvuW+l+S4i1wi44CC5Y+N5LqL5a6e5p+l6K+iKirpm7blia/kvZznlKgqKu+8jFxuICAgIC8vIOiAjOWcqOatpOS5i+WJjeWUr+S4gOeahOivlemUmeWKnuazleWwseaYr+WKqOecn+WcuuaZr+OAglxuXG4gICAgLyoqIOa4suafk+S8mOWFiOe6p++8iOWPluS4jeWIsOaMiSAw77yJ4oCU4oCUIOWQjOe6p+aOkuW6j+eUqOOAgiAqL1xuICAgIGNvbnN0IHJlYWROb2RlUHJpb3JpdHkgPSAobm9kZTogYW55KTogbnVtYmVyID0+IHtcbiAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHV0ICYmIHR5cGVvZiB1dC5wcmlvcml0eSA9PT0gJ251bWJlcicpIHJldHVybiB1dC5wcmlvcml0eTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gMDtcbiAgICB9O1xuXG4gICAgLyoqIOeCueaYr+S4jeaYr+iQveWcqOefqeW9oumHjO+8iCoq6aG16Z2iIENTUyDlg4/ntKDjgIF5IOWQkeS4iyoq77yJ44CCICovXG4gICAgY29uc3QgcG9pbnRJbkNzc1JlY3QgPSAocmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiwgeDogbnVtYmVyLCB5OiBudW1iZXIpOiBib29sZWFuID0+XG4gICAgICAgIHggPj0gcmVjdC54ICYmIHggPD0gcmVjdC54ICsgcmVjdC53aWR0aCAmJiB5ID49IHJlY3QueSAmJiB5IDw9IHJlY3QueSArIHJlY3QuaGVpZ2h0O1xuXG4gICAgLyoqIOiKgueCueS4iuOAjOeUu+W+l+WHuuadpeOAjeeahOe7hOS7tu+8iOaMieW8leaTjumHjOecn+WunuWtmOWcqOeahOexu+Wei+WPlu+8m+WPluS4jeWIsOeahOexu+Wei+i3s+i/h++8ieOAgiAqL1xuICAgIGNvbnN0IHZpc3VhbENvbXBvbmVudEVudHJpZXMgPSAobm9kZTogYW55KTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbXA6IGFueSB9PiA9PiB7XG4gICAgICAgIGNvbnN0IG91dDogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbXA6IGFueSB9PiA9IFtdO1xuICAgICAgICBjb25zdCBwYWlyczogQXJyYXk8W3N0cmluZywgYW55XT4gPSBbXG4gICAgICAgICAgICBbJ1Nwcml0ZScsIGNjLlNwcml0ZV0sXG4gICAgICAgICAgICBbJ0xhYmVsJywgY2MuTGFiZWxdLFxuICAgICAgICAgICAgWydSaWNoVGV4dCcsIGNjLlJpY2hUZXh0XSxcbiAgICAgICAgICAgIFsnR3JhcGhpY3MnLCBjYy5HcmFwaGljc10sXG4gICAgICAgICAgICBbJ01hc2snLCBjYy5NYXNrXSxcbiAgICAgICAgXTtcbiAgICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBhaXJzKSB7XG4gICAgICAgICAgICBjb25zdCBuYW1lID0gcGFpclswXTtcbiAgICAgICAgICAgIGNvbnN0IGN0b3IgPSBwYWlyWzFdO1xuICAgICAgICAgICAgaWYgKCFjdG9yIHx8ICFub2RlIHx8IHR5cGVvZiBub2RlLmdldENvbXBvbmVudCAhPT0gJ2Z1bmN0aW9uJykgY29udGludWU7XG4gICAgICAgICAgICBsZXQgY29tcDogYW55ID0gbnVsbDtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29tcCA9IG5vZGUuZ2V0Q29tcG9uZW50KGN0b3IpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgY29tcCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoY29tcCkgb3V0LnB1c2goeyBuYW1lLCBjb21wIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOi/meS4quiKgueCueOAjOeUu+S4jeeUu+W+l+WHuuS4nOilv+OAjeOAglxuICAgICAqXG4gICAgICog5Yi75oSP5Y+q5YGaKirpnZnmgIHlj6/liKQqKueahOmCo+WHoOenje+8mmBTcHJpdGVgIOayoeiuvuWbviAvIGBjb2xvci5hID0gMGAgLyDnqbogTGFiZWzjgIJcbiAgICAgKiBgR3JhcGhpY3NgIOS4jiBgTWFza2Ag5Yik5LiN5LqG77yI6KaB55+l6YGT5a6D55S75Yiw5ZOq5bCx5b6X6YeN5pS+5oyH5Luk5rWB77yJ77yM5omA5Lul566X44CM5Y+v6KeB44CNXG4gICAgICog5bm25ZyoIGBjYXZlYXRzYCDph4zor7TmmI4g4oCU4oCUIOaKpeWunuaDhe+8jOS4jeWBh+ijheefpemBk+OAglxuICAgICAqL1xuICAgIGNvbnN0IHZpc3VhbFN0YXRlT2YgPSAobm9kZTogYW55KTogeyB2aXNpYmxlOiBib29sZWFuOyBuYW1lczogc3RyaW5nW107IHJlYXNvbj86IHN0cmluZzsgY2F2ZWF0czogc3RyaW5nW10gfSA9PiB7XG4gICAgICAgIGNvbnN0IGVudHJpZXMgPSB2aXN1YWxDb21wb25lbnRFbnRyaWVzKG5vZGUpO1xuICAgICAgICBjb25zdCBuYW1lcyA9IGVudHJpZXMubWFwKChlKSA9PiBlLm5hbWUpO1xuICAgICAgICBjb25zdCBjYXZlYXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiAn5rKh5pyJ5Lu75L2V5riy5p+T57uE5Lu277yI5Y+q5piv5a655Zmo77yJJywgY2F2ZWF0cyB9O1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgY29uc3QgY29tcCA9IGVudHJ5LmNvbXA7XG4gICAgICAgICAgICBsZXQgYWxwaGEgPSAyNTU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmIChjb21wLmNvbG9yICYmIHR5cGVvZiBjb21wLmNvbG9yLmEgPT09ICdudW1iZXInKSBhbHBoYSA9IGNvbXAuY29sb3IuYTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGFscGhhIDw9IDApIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiBgJHtlbnRyeS5uYW1lfSDnmoQgY29sb3IuYSA9IDBgLCBjYXZlYXRzIH07XG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ1Nwcml0ZScpIHtcbiAgICAgICAgICAgICAgICBsZXQgZnJhbWU6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgZnJhbWUgPSBjb21wLnNwcml0ZUZyYW1lO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICBmcmFtZSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICghZnJhbWUpIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiAnU3ByaXRlIOayoeiuviBzcHJpdGVGcmFtZScsIGNhdmVhdHMgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnTGFiZWwnIHx8IGVudHJ5Lm5hbWUgPT09ICdSaWNoVGV4dCcpIHtcbiAgICAgICAgICAgICAgICBsZXQgdGV4dCA9ICcnO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIHRleHQgPSBTdHJpbmcoY29tcC5zdHJpbmcgPT0gbnVsbCA/ICcnIDogY29tcC5zdHJpbmcpO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICB0ZXh0ID0gJyc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh0ZXh0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgdmlzaWJsZTogZmFsc2UsIG5hbWVzLCByZWFzb246IGAke2VudHJ5Lm5hbWV9IOeahCBzdHJpbmcg5piv56m65LiyYCwgY2F2ZWF0cyB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdHcmFwaGljcycgfHwgZW50cnkubmFtZSA9PT0gJ01hc2snKSB7XG4gICAgICAgICAgICAgICAgY2F2ZWF0cy5wdXNoKGAke2VudHJ5Lm5hbWV9IOeahOWPr+ingeiMg+WbtOmdmeaAgeWIpOS4jeS6hu+8iOimgemHjeaUvuaMh+S7pOa1ge+8ieKAlOKAlCDlroPlnKjliJfooajph4zlj6rku6PooahcIuaciei/meS4que7hOS7tlwiYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdmlzaWJsZTogdHJ1ZSwgbmFtZXMsIGNhdmVhdHMgfTtcbiAgICB9O1xuXG4gICAgLyoqIOeItumTvuS4iuaJgOaciSBgVUlPcGFjaXR5YCDnmoTkuZjnp6/vvIgyNTUgPSDlhajkuI3pgI/mmI7vvInjgIIgKi9cbiAgICBjb25zdCBvcGFjaXR5Q2hhaW5PZiA9IChub2RlOiBhbnkpOiBudW1iZXIgPT4ge1xuICAgICAgICBsZXQgcHJvZHVjdCA9IDI1NTtcbiAgICAgICAgbGV0IGN1cnNvciA9IG5vZGU7XG4gICAgICAgIHdoaWxlIChjdXJzb3IpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKGNjLlVJT3BhY2l0eSAmJiB0eXBlb2YgY3Vyc29yLmdldENvbXBvbmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGN1cnNvci5nZXRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG9wICYmIHR5cGVvZiBvcC5vcGFjaXR5ID09PSAnbnVtYmVyJykgcHJvZHVjdCA9IChwcm9kdWN0ICogb3Aub3BhY2l0eSkgLyAyNTU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3IucGFyZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKHByb2R1Y3QpO1xuICAgIH07XG5cbiAgICAvKiog56WW5YWI6YeM55qEIGBNYXNrYCDlkI3lrZfvvIgqKuS4jeWIpOaWreeCueaYr+WQpuWcqOaooeadv+WGhSoq77yM5Y+q5oql44CM6KKr6LCB572p552A44CN77yJ44CCICovXG4gICAgY29uc3QgbWFza0FuY2VzdG9yc09mID0gKG5vZGU6IGFueSk6IHN0cmluZ1tdID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBsZXQgY3Vyc29yID0gbm9kZSA/IG5vZGUucGFyZW50IDogbnVsbDtcbiAgICAgICAgd2hpbGUgKGN1cnNvcikge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoY2MuTWFzayAmJiB0eXBlb2YgY3Vyc29yLmdldENvbXBvbmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXNrID0gY3Vyc29yLmdldENvbXBvbmVudChjYy5NYXNrKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hc2sgJiYgbWFzay5lbmFibGVkSW5IaWVyYXJjaHkgIT09IGZhbHNlKSBvdXQucHVzaChTdHJpbmcoY3Vyc29yLm5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvci5wYXJlbnQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICogKirkuIDkuKrlsY/luZXngrnkuIrmmK/lk6rkuKroioLngrkqKiDigJTigJQg44CM5oiq5Zu+6YeM6YKj5Lic6KW/5piv5LuA5LmI44CN55qE5LiA5qyh6LCD55So54mI44CCXG4gICAgICpcbiAgICAgKiAjIyDlroPmm7/ku6PmjonnmoTlvK/ot6/vvIjlrp7mtYsgMTYg6L2u77yJXG4gICAgICpcbiAgICAgKiDmiKrlm77ph4zmnInkuKrntKvoibLmlrnlnZfvvIzkuo7mmK/vvJrmnprkuL4gYGFjaGl2ZW1lbnRzYCDlrZDmoJHph4zmiYDmnIkgU3ByaXRlL0dyYXBoaWNzL0xhYmVsIOKGklxuICAgICAqIOaMieminOiJsuWBmuebtOaWueWbviDihpIg5Y+N566X5YOP57Sg5YyF5Zu055uSIOKGkiDlm57pooTliLbku7bph4wgZ3JlcCDoibLlgLwg4oaSICoq5YWo6YO95a+55LiN5LiKKirjgIJcbiAgICAgKiDnu5PorrrmmK/pgqPnjqnmhI/lhL8qKuagueacrOS4jeaYr+WcuuaZr+mHjOeahOiKgueCuSoq77yM5piv57yW6L6R5Zmo56e75YqoIGdpem1vIOeahCBYWSDlubPpnaLmiYvmn4TjgIJcbiAgICAgKlxuICAgICAqIOeXh+e7k+S4jeWcqOS6jlwi566X5LiN5Ye6XCLvvIzogIzlnKjkuo7vvJpg56m6YO+8iOi/meS4queCueS4iuayoeacieWGheWuueiKgueCue+8iSoq5pys6Lqr5bCx5piv5LiA5Liq57uT6K66KirvvIxcbiAgICAgKiDlj6/miYvlt6XmnprkuL7ml7bmsqHkurrmlaLkv6HkuIDkuKrnqbrliJfooajvvIzkuo7mmK/mjaLkuKrop5Lluqblho3mnprkuL7kuIDpgY3jgILov5nkuKrliqnmiYvmiorjgIznqbrjgI1cbiAgICAgKiDlj5jmiJAqKuacieadg+WogeeahOWIpOivjSoqIOKAlOKAlCDlroPlt7Lnu4/mm7/osIPnlKjmlrnnrpfov4fmtLvot4PmgIHjgIHnvJbovpHlmajoo4XppbDjgIHlsLrlr7jjgIHpopzoibIgYWxwaGEg5LqG44CCXG4gICAgICpcbiAgICAgKiAjIyDkuInkuKrmobbvvIjov5nmraPmmK/lroPmr5TmiYvlt6XmnprkuL7lvLrnmoTlnLDmlrnvvIlcbiAgICAgKlxuICAgICAqIC0gYGhpdHNgIOKAlOKAlCDlkb3kuK3ov5nkuIDngrnnmoQqKuWGheWuuSoq6IqC54K577yM5oyJ55S75bqPKirku47kuIrliLDkuIsqKuaOklxuICAgICAqIC0gYGludmlzaWJsZWAg4oCU4oCUIOebluS9j+S6hui/meS4gOeCueS9hioq55yL5LiN6KeBKirnmoToioLngrkgKyDljp/lm6DvvIhgYWN0aXZlPWZhbHNlYCAvXG4gICAgICogICBgY29sb3IuYT0wYCAvIOepuiBMYWJlbCAvIOeItumTviBgVUlPcGFjaXR5PTBg77yJ44CC44CM6L+Z6YeM5oCO5LmI5LuA5LmI6YO95rKh55S75Ye65p2l44CN55u05o6l55yL5a6DXG4gICAgICogLSBgZWRpdG9ySGl0c2Ag4oCU4oCUIOebluS9j+i/meS4gOeCueeahCoq57yW6L6R5Zmo6Ieq5bex55qEKiroo4XppbDoioLngrnvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8iVxuICAgICAqXG4gICAgICogYHZlcmRpY3RgIOaKiuS4ieahtuaPieaIkOS4gOWPpeivne+8mmBjb250ZW50YCAvIGBlZGl0b3Itb3ZlcmxheWAgLyBgZW1wdHlg44CCXG4gICAgICog5ou/5YiwIGBlZGl0b3Itb3ZlcmxheWAg5bCx5Yir5YaN5Y676IqC54K55qCR5oiW6aKE5Yi25Lu26YeM5om+5LqG44CCXG4gICAgICpcbiAgICAgKiAjIyDlnZDmoIflj6PlvoTvvIjkuI4gYGNhcHR1cmVWaWV3YCDlhbHnlKjkuIDlpZfvvIwqKuWIq+iHquW3seWPjeeulyoq77yJXG4gICAgICpcbiAgICAgKiAtIGBzcGFjZTogJ3ZpZXcnYO+8iOm7mOiupO+8ieKAlOKAlCAqKumhtemdoiBDU1Mg5YOP57Sg44CB5bem5LiK6KeS5Y6f54K5KirvvJtcbiAgICAgKiAtIGBzcGFjZTogJ3V2J2Ag4oCU4oCUIDB+MSDlvZLkuIDljJbvvIhcIuWkp+e6puWcqOWbvuaoquWQkSA3OCXjgIHnurXlkJEgMjIlXCLvvInjgIJcbiAgICAgKiAgIGBjYXB0dXJlVmlld2Ag57uZ5LqGIGBtYXhXaWR0aGAg5pe25Zu+5Lya562J5q+U57yp5bCP77yM5Zu+5LiK5YOP57SgIOKJoCBDU1Mg5YOP57Sg77yMXG4gICAgICogICDov5nml7bnlKggYHV2YCAqKuS4jemcgOimgeefpemBk+WbvuWkmuWkpyoq77ybXG4gICAgICogLSBgc3BhY2U6ICd3b3JsZCdgIOKAlOKAlCDnm7TmjqXnu5nkuJbnlYzlnZDmoIfvvIh5IOWQkeS4iu+8ieOAglxuICAgICAqXG4gICAgICogIyMg6K+a5a6e55qE6L6555WMXG4gICAgICpcbiAgICAgKiAtICoq55S75bqPKirmjInjgIzlkIznuqflhYjmjIkgYFVJVHJhbnNmb3JtLnByaW9yaXR5YOOAgeWGjeaMieWtkOiKgueCuemhuuW6j++8jOeItuWcqOiHquW3seWtkOiKgueCueS5i+WJjeOAjeeul++8jFxuICAgICAqICAg5pivIDJEIFVJIOeahOW4uOinhOWPo+W+hO+8myoq6LeoIENhbnZhcyAvIOi3qOebuOacuioq55qE5YWI5ZCO5a6D566h5LiN552A77yI5Zue5omn6YeMIGBvcmRlclJ1bGVgIOWGmeedgO+8ieOAglxuICAgICAqIC0gKirpga7nvakqKuWPquaKpSBgbWFza2VkQnlg77yI56WW5YWIIGBNYXNrYCDnmoTlkI3lrZfvvInvvIwqKuS4jeWIpOaWremCo+S4queCueWcqOS4jeWcqOaooeadv+mHjCoq44CCXG4gICAgICogLSBgR3JhcGhpY3NgIOWPquaMieOAjOaciee7hOS7tuOAjeeul++8jOmHjeaUvuaMh+S7pOa1geaJjeefpemBk+Wug+eUu+WIsOWTquOAglxuICAgICAqIC0g5Y+W5LiN5Yiw57yW6L6R5Zmo55u45py677yI5Zy65pmv6KeG5Zu+5rKh5byAIC8gYGNjZS5DYW1lcmFgIOayoeWwsee7qu+8ieaXtioq55u05o6l5oqb6ZSZKirvvIxcbiAgICAgKiAgIOS4jee7meS4gOS4qumdmem7mOepuue7k+aenCDigJTigJQg6YKj5q2j5piv44CM56m65YiX6KGo5Y+v5LiN5Y+v5L+h44CN55qE6ICB6Zeu6aKY44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0geCDmqKrlnZDmoIfvvIjlkKvkuYnnlLEgYHNwYWNlYCDlhrPlrprvvIlcbiAgICAgKiBAcGFyYW0geSDnurXlnZDmoIdcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5zcGFjZSBgJ3ZpZXcnYO+8iOm7mOiupO+8iS8gYCd1didgIC8gYCd3b3JsZCdgXG4gICAgICogQHBhcmFtIG9wdGlvbnMucm9vdCDlj6rlnKjov5nmo7XlrZDmoJHph4zmib7vvIjpu5jorqTmlbTlnLrmma/vvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5saW1pdCDmnIDlpJrlm57lh6DkuKrlhoXlrrnlkb3kuK3vvIjpu5jorqQgMTLvvIlcbiAgICAgKi9cbiAgICBoZWxwZXJzLnBpY2sgPSAoeDogbnVtYmVyLCB5OiBudW1iZXIsIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3Qgc3BhY2UgPSB0eXBlb2Ygb3B0cy5zcGFjZSA9PT0gJ3N0cmluZycgPyBvcHRzLnNwYWNlIDogJ3ZpZXcnO1xuICAgICAgICBjb25zdCBsaW1pdCA9IGNsYW1wTnVtYmVyKG9wdHMubGltaXQsIDEsIDY0LCAxMik7XG4gICAgICAgIGlmIChzcGFjZSAhPT0gJ3ZpZXcnICYmIHNwYWNlICE9PSAndXYnICYmIHNwYWNlICE9PSAnd29ybGQnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgYHBpY2soeCwgeSwgeyBzcGFjZSB9Ke+8mnNwYWNlIOWPquiupCAndmlldyfvvIjpobXpnaIgQ1NTIOWDj+e0oO+8jOm7mOiupO+8iS8gJ3V2J++8iDB+Me+8iS8gJ3dvcmxkJ++8jOaUtuWIsCAnJHtzcGFjZX0n44CCYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbnggPSBOdW1iZXIoeCk7XG4gICAgICAgIGNvbnN0IG55ID0gTnVtYmVyKHkpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShueCkgfHwgIU51bWJlci5pc0Zpbml0ZShueSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcGljayh4LCB5Ke+8muWdkOagh+imgemDveaYr+aciemZkOaVsO+8jOaUtuWIsCAke0pTT04uc3RyaW5naWZ5KHgpfSAvICR7SlNPTi5zdHJpbmdpZnkoeSl944CCYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjYW1JbmZvID0gZWRpdG9yQ2FtZXJhKCk7XG4gICAgICAgIGlmICghY2FtSW5mby5jYW0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBgcGljayDopoHmiorkuJbnlYzlnZDmoIfmipXliLDlsY/luZXkuIrvvIzkvYbnjrDlnKjmi7/kuI3liLDnvJbovpHlmajnm7jmnLrvvJoke2NhbUluZm8ubm90ZSB8fCAn5pyq55+l5Y6f5ZugJ33jgIJgICtcbiAgICAgICAgICAgICAgICAgICAgJ++8iOWcuuaZr+inhuWbvuayoeaJk+W8gOOAgeaIluiAheWImuaJk+W8gOi/mOayoeWwsee7qiDigJTigJQg5LiN5pivXCLov5nkuKrngrnkuIrmsqHmnInoioLngrlcIuOAgu+8iScsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNhbSA9IGNhbUluZm8uY2FtO1xuICAgICAgICBjb25zdCBjYW52YXMgPSBmaW5kVmlld0NhbnZhcyhjYyk7XG4gICAgICAgIGNvbnN0IGNhbnZhc0JveCA9IChjYW52YXNHZW9tZXRyeShjYW52YXMpIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICBjb25zdCBwYWdlID0gcGFnZUdlb21ldHJ5KCk7XG4gICAgICAgIGNvbnN0IGNzc1dpZHRoID0gdHlwZW9mIHBhZ2UuY3NzV2lkdGggPT09ICdudW1iZXInID8gcGFnZS5jc3NXaWR0aCA6IDA7XG4gICAgICAgIGNvbnN0IGNzc0hlaWdodCA9IHR5cGVvZiBwYWdlLmNzc0hlaWdodCA9PT0gJ251bWJlcicgPyBwYWdlLmNzc0hlaWdodCA6IDA7XG4gICAgICAgIGNvbnN0IGNhbnZhc0Nzc1dpZHRoID0gKGNhbnZhc0JveC5jc3NXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgICAgIGNvbnN0IGNhbnZhc0RldmljZVdpZHRoID0gKGNhbnZhc0JveC5kZXZpY2VXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgICAgIGNvbnN0IGRwciA9IGNhbnZhc0Nzc1dpZHRoID4gMCAmJiBjYW52YXNEZXZpY2VXaWR0aCA+IDAgPyBjYW52YXNEZXZpY2VXaWR0aCAvIGNhbnZhc0Nzc1dpZHRoIDogcGFnZURwcigpO1xuICAgICAgICBjb25zdCBjYW1IZWlnaHQgPSBzYWZlTnVtYmVyKCgpID0+IGNhbS5jYW1lcmEuaGVpZ2h0KSB8fCAoY2FudmFzQm94LmRldmljZUhlaWdodCBhcyBudW1iZXIpIHx8IDA7XG5cbiAgICAgICAgLy8g4pGgIOi+k+WFpSDihpIg6aG16Z2iIENTUyDlg4/ntKDvvIjlt6bkuIrop5Lljp/ngrnvvIlcbiAgICAgICAgbGV0IHB4ID0gbng7XG4gICAgICAgIGxldCBweSA9IG55O1xuICAgICAgICBsZXQgd29ybGRQb2ludDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPSBudWxsO1xuICAgICAgICBpZiAoc3BhY2UgPT09ICd1dicpIHtcbiAgICAgICAgICAgIGlmICghY3NzV2lkdGggfHwgIWNzc0hlaWdodCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncGljayhzcGFjZTpcInV2XCIpIOimgeaMiemhtemdouWwuuWvuOaKmOeul++8jOS9huWcuuaZr+mhtemHjOayoemHj+WIsCB3aW5kb3cuaW5uZXJXaWR0aC9pbm5lckhlaWdodOOAguaUueeUqCBzcGFjZTpcInZpZXdcIiDoh6rlt7HkuZjjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHB4ID0gbnggKiBjc3NXaWR0aDtcbiAgICAgICAgICAgIHB5ID0gbnkgKiBjc3NIZWlnaHQ7XG4gICAgICAgIH0gZWxzZSBpZiAoc3BhY2UgPT09ICd3b3JsZCcpIHtcbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3RXb3JsZEJveChjYywgY2FtLCBjYW52YXMsIHsgY3g6IG54LCBjeTogbnksIHd6OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH0pO1xuICAgICAgICAgICAgaWYgKCFwcm9qZWN0ZWQucmVjdCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcGljayhzcGFjZTpcIndvcmxkXCIpIOaKleS4jeWIsOWxj+W5leS4iu+8miR7cHJvamVjdGVkLm5vdGUgfHwgJ+acquefpeWOn+WboCd944CCYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBweCA9IHByb2plY3RlZC5yZWN0Lng7XG4gICAgICAgICAgICBweSA9IHByb2plY3RlZC5yZWN0Lnk7XG4gICAgICAgICAgICB3b3JsZFBvaW50ID0geyB4OiByb3VuZDMobngpLCB5OiByb3VuZDMobnkpIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyDikaEg6aG65bim5oqK5LiW55WM5Z2Q5qCH5Lmf566X5Ye65p2l77yIdmlldy91diDotbDlj43mipXlvbHvvInigJTigJQg5Zue5omn6YeM5bim5LiK77yM55yB5b6X6LCD55So5pa56Ieq5bex5YaN5o2i566X5LiA5qyhXG4gICAgICAgIGlmICghd29ybGRQb2ludCAmJiBkcHIgPiAwICYmIGNhbUhlaWdodCA+IDApIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxYID0gcHggLSAoKGNhbnZhc0JveC5sZWZ0IGFzIG51bWJlcikgfHwgMCk7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxZID0gcHkgLSAoKGNhbnZhc0JveC50b3AgYXMgbnVtYmVyKSB8fCAwKTtcbiAgICAgICAgICAgICAgICBjb25zdCB3ID0gY2FtLnNjcmVlblRvV29ybGQobmV3IGNjLlZlYzMobG9jYWxYICogZHByLCBjYW1IZWlnaHQgLSBsb2NhbFkgKiBkcHIsIDApKTtcbiAgICAgICAgICAgICAgICBpZiAodyAmJiB0eXBlb2Ygdy54ID09PSAnbnVtYmVyJyAmJiB0eXBlb2Ygdy55ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICB3b3JsZFBvaW50ID0geyB4OiByb3VuZDMody54KSwgeTogcm91bmQzKHcueSkgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICB3b3JsZFBvaW50ID0gbnVsbDsgLy8g5Y+N5oqV5b2x5LiN5oiQ56uL5bCx5aaC5a6e5ZueIG51bGzvvIzkuI3nvJbkuIDkuKpcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJvb3ROb2RlID0gb3B0cy5yb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghcm9vdE5vZGUpIHRocm93IG5ldyBFcnJvcigncGlja++8muW9k+WJjeayoeacieaJk+W8gOeahOWcuuaZr++8iOS5n+ayoee7mSByb29077yJ44CCJyk7XG5cbiAgICAgICAgY29uc3Qgd29ybGRSZWN0T2YgPSBoZWxwZXJzLndvcmxkUmVjdCBhcyAobm9kZTogYW55LCBvcHRpb25zPzogeyByb290PzogYW55IH0pID0+IFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgICAgICAgLyoqIOeUu+W6j+ihqO+8muWQjOe6p+aMiSBwcmlvcml0eeOAgeWGjeaMieWtkOiKgueCuemhuuW6j++8jOeItuWcqOiHquW3seWtkOiKgueCueS5i+WJjeOAgiAqL1xuICAgICAgICBjb25zdCBkcmF3SW5kZXggPSBuZXcgTWFwPGFueSwgbnVtYmVyPigpO1xuICAgICAgICB7XG4gICAgICAgICAgICBsZXQgY291bnRlciA9IDA7XG4gICAgICAgICAgICBjb25zdCB3YWxrT3JkZXIgPSAobjogYW55KTogdm9pZCA9PiB7XG4gICAgICAgICAgICAgICAgZHJhd0luZGV4LnNldChuLCBjb3VudGVyKTtcbiAgICAgICAgICAgICAgICBjb3VudGVyICs9IDE7XG4gICAgICAgICAgICAgICAgY29uc3Qga2lkczogYW55W10gPSAobiAmJiBuLmNoaWxkcmVuKSB8fCBbXTtcbiAgICAgICAgICAgICAgICBjb25zdCBwYWlycyA9IGtpZHMubWFwKChrOiBhbnksIGk6IG51bWJlcikgPT4gKHsgaywgaSwgcDogcmVhZE5vZGVQcmlvcml0eShrKSB9KSk7XG4gICAgICAgICAgICAgICAgcGFpcnMuc29ydCgoYSwgYikgPT4gYS5wIC0gYi5wIHx8IGEuaSAtIGIuaSk7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBhaXJzKSB3YWxrT3JkZXIocGFpci5rKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB3YWxrT3JkZXIocm9vdE5vZGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqIOiKgueCueeahOmhtemdoiBDU1Mg55+p5b2i77yI6LWwIGB3b3JsZFJlY3RgICsgYHByb2plY3RXb3JsZEJveGDvvIzkuI7miKrlm77lkIzkuIDlpZfmjaLnrpfvvInjgIIgKi9cbiAgICAgICAgY29uc3QgcHJvamVjdE5vZGVDc3MgPSAobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPT4ge1xuICAgICAgICAgICAgbGV0IHJlY3Q6IFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJlY3QgPSB3b3JsZFJlY3RPZihub2RlKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCEocmVjdC53aWR0aCA+IDApIHx8ICEocmVjdC5oZWlnaHQgPiAwKSkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBsZXQgd3ogPSAwO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCB3cCA9IG5vZGUud29ybGRQb3NpdGlvbjtcbiAgICAgICAgICAgICAgICBpZiAod3AgJiYgdHlwZW9mIHdwLnogPT09ICdudW1iZXInKSB3eiA9IHdwLno7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlv73nlaXvvJoyRCDmraPkuqTkuIsgeiDkuI3lvbHlk43nu5PmnpwgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3RXb3JsZEJveChjYywgY2FtLCBjYW52YXMsIHtcbiAgICAgICAgICAgICAgICBjeDogcmVjdC5jeCxcbiAgICAgICAgICAgICAgICBjeTogcmVjdC5jeSxcbiAgICAgICAgICAgICAgICB3eixcbiAgICAgICAgICAgICAgICB3aWR0aDogcmVjdC53aWR0aCxcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IHJlY3QuaGVpZ2h0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgaGl0czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gICAgICAgIGNvbnN0IGludmlzaWJsZTogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gICAgICAgIGNvbnN0IGVkaXRvckhpdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICAgICAgICBjb25zdCBjYXZlYXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBsZXQgc2Nhbm5lZENvbnRlbnQgPSAwO1xuICAgICAgICBsZXQgc2Nhbm5lZEVkaXRvciA9IDA7XG5cbiAgICAgICAgY29uc3QgdmlzaXROb2RlID0gKG5vZGU6IGFueSwgcGFyZW50UGF0aDogc3RyaW5nLCB1bmRlckVkaXRvcjogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBlZGl0b3JIZXJlID0gdW5kZXJFZGl0b3IgfHwgaXNFZGl0b3JOb2RlKG5vZGUpO1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9IG5vZGUgPT09IHJvb3ROb2RlID8gJycgOiBwYXJlbnRQYXRoID8gYCR7cGFyZW50UGF0aH0vJHtub2RlLm5hbWV9YCA6IFN0cmluZyhub2RlLm5hbWUpO1xuICAgICAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICAgICAgaWYgKHV0ICYmIHV0LndpZHRoID4gMCAmJiB1dC5oZWlnaHQgPiAwKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY3NzUmVjdCA9IHByb2plY3ROb2RlQ3NzKG5vZGUpO1xuICAgICAgICAgICAgICAgIGlmIChjc3NSZWN0ICYmIHBvaW50SW5Dc3NSZWN0KGNzc1JlY3QsIHB4LCBweSkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgcm93OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgICAgICByZWN0OiBjc3NSZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJlYTogTWF0aC5yb3VuZChjc3NSZWN0LndpZHRoICogY3NzUmVjdC5oZWlnaHQpLFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICBpZiAoZWRpdG9ySGVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2Nhbm5lZEVkaXRvciArPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVkaXRvckhpdHMubGVuZ3RoIDwgOCkgZWRpdG9ySGl0cy5wdXNoKHJvdyk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FubmVkQ29udGVudCArPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmlzdWFsID0gdmlzdWFsU3RhdGVPZihub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wYWNpdHkgPSBvcGFjaXR5Q2hhaW5PZihub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hc2tlZEJ5ID0gbWFza0FuY2VzdG9yc09mKG5vZGUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiDog73kuI3og73nnIvop4HvvIzkuInnp43mg4XlhrUqKuWIhuW8gOaKpSoq77yaXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOe6r+WuueWZqO+8iOayoeacieS7u+S9lea4suafk+e7hOS7tu+8ieKGkiDml6LkuI3nrpflkb3kuK3jgIHkuZ/kuI3nrpdcIueci+S4jeingVwi77yI5a6D5pys5p2l5bCx5LiN6K+l55S75Lic6KW/77yJXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOaciea4suafk+e7hOS7tuS9huayoeaYvuekuuWHuuadpSDihpIg6L+bIGBpbnZpc2libGVgIOW5tuW4puS4iioq5Y6f5ZugKirvvIjov5nmiY3mmK9cIui/memHjOaAjuS5iOS7gOS5iOmDveayoeeUu1wi55qE562U5qGI77yJXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOWFtuS9mSDihpIg5ZG95LitXG4gICAgICAgICAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFjdGl2ZUluSGllcmFyY2h5ID1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLmFjdGl2ZUluSGllcmFyY2h5ICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBub2RlLmFjdGl2ZUluSGllcmFyY2h5ICE9PSBmYWxzZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IG5vZGUuYWN0aXZlICE9PSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2aXN1YWwubmFtZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYWN0aXZlSW5IaWVyYXJjaHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGludmlzaWJsZS5sZW5ndGggPCBsaW1pdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnJlYXNvbiA9ICdhY3RpdmUgPSBmYWxzZe+8iOaIlueItumTvuS4iuaciSBpbmFjdGl2Ze+8iSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cudmlzdWFsID0gdmlzdWFsLm5hbWVzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW52aXNpYmxlLnB1c2gocm93KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIXZpc3VhbC52aXNpYmxlIHx8IG9wYWNpdHkgPD0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW52aXNpYmxlLmxlbmd0aCA8IGxpbWl0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cucmVhc29uID0gb3BhY2l0eSA8PSAwID8gJ+eItumTviBVSU9wYWNpdHkg5ZCI6LW35p2l5pivIDAnIDogdmlzdWFsLnJlYXNvbjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJvdy52aXN1YWwgPSB2aXN1YWwubmFtZXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbnZpc2libGUucHVzaChyb3cpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnZpc3VhbCA9IHZpc3VhbC5uYW1lcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93Lm9wYWNpdHkgPSBvcGFjaXR5O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cubWFza2VkQnkgPSBtYXNrZWRCeTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnByaW9yaXR5ID0gcmVhZE5vZGVQcmlvcml0eShub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93Lm9yZGVyID0gZHJhd0luZGV4Lmhhcyhub2RlKSA/IGRyYXdJbmRleC5nZXQobm9kZSkgOiAtMTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGl0cy5wdXNoKHJvdyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2F2ZWF0IG9mIHZpc3VhbC5jYXZlYXRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2F2ZWF0cy5pbmRleE9mKGNhdmVhdCkgPCAwKSBjYXZlYXRzLnB1c2goY2F2ZWF0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGtpZHM6IGFueVtdID0gKG5vZGUgJiYgbm9kZS5jaGlsZHJlbikgfHwgW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGtpZHMpIHZpc2l0Tm9kZShjaGlsZCwgcGF0aCwgZWRpdG9ySGVyZSk7XG4gICAgICAgIH07XG4gICAgICAgIHZpc2l0Tm9kZShyb290Tm9kZSwgJycsIGZhbHNlKTtcblxuICAgICAgICBoaXRzLnNvcnQoKGEsIGIpID0+IChiLm9yZGVyIGFzIG51bWJlcikgLSAoYS5vcmRlciBhcyBudW1iZXIpKTtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IGhpdHMubGVuZ3RoID4gMCA/ICdjb250ZW50JyA6IGVkaXRvckhpdHMubGVuZ3RoID4gMCA/ICdlZGl0b3Itb3ZlcmxheScgOiAnZW1wdHknO1xuXG4gICAgICAgIGxldCBub3RlID0gJyc7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSAnZWRpdG9yLW92ZXJsYXknKSB7XG4gICAgICAgICAgICBub3RlID1cbiAgICAgICAgICAgICAgICAn6L+Z5Liq54K55LiKKirmsqHmnInku7vkvZXlhoXlrrnoioLngrkqKu+8jOS9huaciee8lui+keWZqOiHquW3seeahOijhemlsOiKgueCueimhuebliDigJTigJQg5Z+65pys5Y+v5Lul56Gu5a6a5pivIGdpem1vIC8g572R5qC8IC8g5Y+C6ICD5Zu+44CCJyArXG4gICAgICAgICAgICAgICAgJ+aIquWbvumHjOeci+WIsOeahOS4nOilv+iLpeaYr+i/meS4quminOiJsu+8jOWugyoq5LiN5Zyo5Zy65pmv5pWw5o2u6YeMKirvvIzliKvljrvoioLngrnmoJHmiJbpooTliLbku7bph4zmib7lroPjgIInO1xuICAgICAgICB9IGVsc2UgaWYgKHZlcmRpY3QgPT09ICdlbXB0eScpIHtcbiAgICAgICAgICAgIG5vdGUgPSAn6L+Z5Liq54K55LiK5pei5rKh5pyJ5YaF5a656IqC54K544CB5Lmf5rKh5pyJ57yW6L6R5Zmo6KOF6aWw77yI5Y+v6IO95piv5riF5bGP6ImyIC8g6Z2i5p2/5bqV6Imy77yJ44CCJztcbiAgICAgICAgfSBlbHNlIGlmIChoaXRzLmxlbmd0aCA+IGxpbWl0KSB7XG4gICAgICAgICAgICBub3RlID0gYOWRveS4rSAke2hpdHMubGVuZ3RofSDkuKrlhoXlrrnoioLngrnvvIzlj6rlm57kuobmnIDkuIrpnaIgJHtsaW1pdH0g5Liq77yI6KaB5pu05aSa5bCx6LCD5aSnIGxpbWl077yJ44CCYDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB4OiBueCxcbiAgICAgICAgICAgIHk6IG55LFxuICAgICAgICAgICAgc3BhY2UsXG4gICAgICAgICAgICBwYWdlQ3NzOiB7IHg6IHJvdW5kMyhweCksIHk6IHJvdW5kMyhweSksIGNzc1dpZHRoLCBjc3NIZWlnaHQsIGRwciwgaHJlZjogcGFnZS5ocmVmIH0sXG4gICAgICAgICAgICBjYW52YXM6IGNhbnZhc0JveCxcbiAgICAgICAgICAgIHdvcmxkOiB3b3JsZFBvaW50LFxuICAgICAgICAgICAgaGl0czogaGl0cy5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgICAgICBoaXQ6IGhpdHMubGVuZ3RoID4gMCA/IGhpdHNbMF0gOiBudWxsLFxuICAgICAgICAgICAgaGlkZGVuQ291bnQ6IGludmlzaWJsZS5sZW5ndGgsXG4gICAgICAgICAgICBpbnZpc2libGUsXG4gICAgICAgICAgICBlZGl0b3JIaXRzLFxuICAgICAgICAgICAgdmVyZGljdCxcbiAgICAgICAgICAgIHNjYW5uZWQ6IHsgY29udGVudDogc2Nhbm5lZENvbnRlbnQsIGVkaXRvcjogc2Nhbm5lZEVkaXRvciB9LFxuICAgICAgICAgICAgb3JkZXJSdWxlOiAn5ZCM57qn5YWI5oyJIFVJVHJhbnNmb3JtLnByaW9yaXR544CB5YaN5oyJ5a2Q6IqC54K56aG65bqP77yb54i25Zyo6Ieq5bex5a2Q6IqC54K55LmL5YmN44CC6LeoIENhbnZhcy/ot6jnm7jmnLrnmoTlhYjlkI7nrqHkuI3nnYDjgIInLFxuICAgICAgICAgICAgY2F2ZWF0cyxcbiAgICAgICAgICAgIG5vdGUsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqICoq6L+Z5LiqIExhYmVsIOaUvuS4jeaUvuW+l+S4i+Wug+iHquW3seeahOWtlyoqIOKAlOKAlCDlsKTlhbbmmK/jgIzkvJrkuI3kvJrooqvoo4HmjonjgI3jgIJcbiAgICAgKlxuICAgICAqICMjIOWug+abv+S7o+aOieeahOW8r+i3r++8iOS4pOWkhOecnyBidWfjgIHlhbEgNH41IOi9ru+8iVxuICAgICAqXG4gICAgICogMS4g5oiQ5bCx5Y2h5o+P6L+wIGBkZXRhaWxg77yIMjIww5c0NOOAgWZzMTbjgIFgQ0xBTVBgICsg5o2i6KGM77yJ77ya5pyA6ZW/55qE5LiA5p2h5o+P6L+w5oqY5oiQIDIg6KGM77yMXG4gICAgICogICAg56ysIDIg6KGM77yI6L+b5bqmIGAyMC8yMGDvvIkqKuaVtOihjOiiq+ijgeaOie+8jOeVjOmdouS4iuS4gOS4quWtl+mDveeci+S4jeingSoq44CCXG4gICAgICogMi4g5pWI5p6c5ZCNIGBwcm9wZXJ0eS9uYW1lYCDlj6rmnIkgNTZweCDlrr3vvIzogIwgNiDkuKrmsYnlrZfnmoTor43opoEgODRweCDigJTigJQg5ZCN5a2X6KKr5oiq44CCXG4gICAgICpcbiAgICAgKiDkuKTmrKHpg73pnaDjgIzlj6blu7rkuIDlvKDmjqLpkojljaEgKyDmiKrlm77jgI3miY3nnIvlh7rmnaXvvIzkuK3pgJTov5jlhYjmlLnkuobnnJ/oioLngrnnmoQgYGFjdGl2ZWBcbiAgICAgKiDvvIgqKui/neWPjeS6huiHquW3seWGmeeahOe6quW+iyoq77yJ44CC6L+Z5Liq5Yqp5omL5oqK5a6D5Y+Y5oiQ5LiA5qyhKirnuq/nrpfmnK8qKuiwg+eUqOOAglxuICAgICAqXG4gICAgICogIyMg6IO96Zeu5Y+N5LqL5a6e77yI6L+Z5omN5piv5a6D55yf5q2j5YC86ZKx55qE5Zyw5pa577yJXG4gICAgICpcbiAgICAgKiDnrKzkuozkuKrlj4LmlbDopobnm5bku7vmhI/lrZfmrrXvvIzkuo7mmK/jgIwqKuWmguaenCoq5oiR5oqK5qGG5pS55oiQIDIxMMOXNzIg6L+Y6KOB5LiN6KOB44CN5LiN55So5pS55Zy65pmv5bCx6IO96Zeu77yaXG4gICAgICpcbiAgICAgKiBgYGBqc1xuICAgICAqIGNvbnN0IG4gPSBub2RlQnlQYXRoKCdDYW52YXMv4oCmL2RldGFpbC9MYWJlbCcpO1xuICAgICAqIGxhYmVsRml0KG4pOyAgICAgICAgICAgICAgICAgLy8g546w5Zyo6KOB5LiN6KOBXG4gICAgICogbGFiZWxGaXQobiwgeyBoZWlnaHQ6IDcyIH0pOyAvLyDmoYbliqDpq5jliLAgNzIg5ZGiXG4gICAgICogbGFiZWxGaXQoeyB0ZXh0OiAn5Zyo5Ye75p2A5ZWG5bqX6LSt5Lmw6L+H5LiN5ZCM56eN57G755qEQnVmZu+8iOWFsTIw56eN77yJ44CCJywgZm9udFNpemU6IDE2LCB3aWR0aDogMjEwLCBoZWlnaHQ6IDcyLCBsaW5lSGVpZ2h0OiAyNCB9KTtcbiAgICAgKiBgYGBcbiAgICAgKlxuICAgICAqICMjIOWbnuaJp+mHjOS4uuS7gOS5iOW4piBgZm9ybXVsYWBcbiAgICAgKlxuICAgICAqIOaIquaWremYiOWAvOmCo+adoeWFrOW8j+aYryoq5LuO5a6e5rWL5Y+N5o6oKirnmoTvvIjop4Hmlofku7bph4wgYExBQkVMX0xBU1RfTElORV9GQUNUT1JgIOS4iuaWuemCo+auteivtOaYju+8ie+8jFxuICAgICAqIOS4jeaYr+ivu+W8leaTjua6kOeggeehruiupOeahOOAguaJgOS7peaKiuWBh+WumueahOWFrOW8j+WOn+agt+S6pOWHuuWOuyDigJTigJQg5pWw5a2X5a+55LiN5LiK5pe25LiA55y855yL5b6X5Ye65pivXG4gICAgICogKirlhazlvI8qKumUmeS6hui/mOaYryoq55So5rOVKirplJnkuobvvIzogIzkuI3mmK/lj4jljrvnjJzjgIJcbiAgICAgKlxuICAgICAqICMjIOivmuWunueahOi+ueeVjFxuICAgICAqXG4gICAgICogLSDmjaLooYzmjIkqKumAkOWtl+espui0quW/gyoq77yIQ0pLIOeahOW4uOinhOihjOS4uu+8ieOAguWQq+epuuagvOeahOmVv+aLieS4geS4suW8leaTjuaMiSoq6K+NKirmjaLooYzvvIxcbiAgICAgKiAgIOmCo+S8muavlOi/memHjCoq5aSaKirljaDooYwg4oCU4oCUIOWbnuaJp+eahCBgd3JhcE1vZGVgIC8gYGNvbmZpZGVuY2VgIC8gYHJlYXNvbnNgIOS8muivtOaYjuOAglxuICAgICAqIC0g5pyJIERPTSDml7blrr3luqbotbAgY2FudmFzIGBtZWFzdXJlVGV4dGDvvIgqKuecn+mHjyoq77yM5LiO5byV5pOOIFRURiDmjpLniYjlkIzkuIDmiorlsLrlrZDvvInvvJtcbiAgICAgKiAgIOayoeacieWImeeUqOWunua1i+eahCBlbSDooajkvLDvvIxgbWV0aG9kYCDlrZfmrrXlhpnmmI7mmK/lk6rnp43jgIJcbiAgICAgKiAtIOWvjOaWh+acrOagh+etvuOAgeWtl+mXtOi3neOAgWBib2xkYC9gb3V0bGluZWAg5bim5p2l55qE5a695bqm5Y+Y5YyWKirmsqHnrpcqKuOAglxuICAgICAqXG4gICAgICogQHBhcmFtIHRhcmdldCDkuIDkuKroioLngrkgLyDkuIDkuKogTGFiZWwg57uE5Lu2IC8g5LiA5LiqIHNwZWMg5a+56LGh77yIYHt0ZXh0LCBmb250U2l6ZSwgd2lkdGgsIGhlaWdodCwgbGluZUhlaWdodCwgb3ZlcmZsb3csIHdyYXB9YO+8iVxuICAgICAqIEBwYXJhbSBvdmVycmlkZSDopobnm5bku7vmhI/lrZfmrrUg4oCU4oCUIOeUqOadpemXruOAjOaUueaIkOi/meagt+S8muS4jeS8muWlveOAjVxuICAgICAqL1xuICAgIGhlbHBlcnMubGFiZWxGaXQgPSAodGFyZ2V0PzogYW55LCBvdmVycmlkZT86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgICAgIGNvbnN0IG92OiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3ZlcnJpZGUgfHwge307XG4gICAgICAgIGxldCBub2RlOiBhbnkgPSBudWxsO1xuICAgICAgICBsZXQgYmFnOiBhbnkgPSBudWxsO1xuICAgICAgICBpZiAodGFyZ2V0ICYmIHR5cGVvZiB0YXJnZXQuZ2V0Q29tcG9uZW50ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBub2RlID0gdGFyZ2V0O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBiYWcgPSBjYy5MYWJlbCA/IHRhcmdldC5nZXRDb21wb25lbnQoY2MuTGFiZWwpIDogbnVsbDtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGJhZyA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWJhZykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYGxhYmVsRml0KG5vZGUp77ya6IqC54K544CMJHt0YXJnZXQubmFtZX3jgI3kuIrmsqHmnIkgY2MuTGFiZWwg57uE5Lu244CCYCArXG4gICAgICAgICAgICAgICAgICAgICAgICBcIuimgemXruWPjeS6i+WunuWwseebtOaOpeS8oCBzcGVjIOWvueixoe+8jOS+i+WmgiBsYWJlbEZpdCh7IHRleHQ6ICfigKYnLCBmb250U2l6ZTogMTYsIHdpZHRoOiAyMTAsIGhlaWdodDogNzIsIGxpbmVIZWlnaHQ6IDI0IH0p44CCXCIsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQgJiYgdHlwZW9mIHRhcmdldCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGJhZyA9IHRhcmdldDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAnbGFiZWxGaXQodGFyZ2V0Ke+8mnRhcmdldCDopoHmmK/kuIDkuKroioLngrkgLyDkuIDkuKogTGFiZWwg57uE5Lu2IC8g5LiA5LiqIHNwZWMg5a+56LGhJyArXG4gICAgICAgICAgICAgICAgICAgIFwi77yI5aaCIHsgdGV4dCwgZm9udFNpemUsIHdpZHRoLCBoZWlnaHQsIGxpbmVIZWlnaHQgfe+8ieOAglwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlYWQgPSAoa2V5OiBzdHJpbmcpOiBhbnkgPT4ge1xuICAgICAgICAgICAgaWYgKG92W2tleV0gIT09IHVuZGVmaW5lZCkgcmV0dXJuIG92W2tleV07XG4gICAgICAgICAgICBpZiAoYmFnKSB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhZ1trZXldICE9PSB1bmRlZmluZWQpIHJldHVybiBiYWdba2V5XTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCB1dCA9IG5vZGUgPyB1aVRyYW5zZm9ybU9mKG5vZGUpIDogbnVsbDtcbiAgICAgICAgY29uc3QgdGV4dCA9IFN0cmluZyhcbiAgICAgICAgICAgIHJlYWQoJ3RleHQnKSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgPyByZWFkKCd0ZXh0JylcbiAgICAgICAgICAgICAgICA6IHJlYWQoJ3N0cmluZycpICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgID8gcmVhZCgnc3RyaW5nJylcbiAgICAgICAgICAgICAgICAgIDogJycsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGZvbnRTaXplID0gTnVtYmVyKHJlYWQoJ2ZvbnRTaXplJykgIT09IHVuZGVmaW5lZCA/IHJlYWQoJ2ZvbnRTaXplJykgOiAxNCkgfHwgMTQ7XG4gICAgICAgIGNvbnN0IGxpbmVIZWlnaHRSYXcgPSBOdW1iZXIocmVhZCgnbGluZUhlaWdodCcpICE9PSB1bmRlZmluZWQgPyByZWFkKCdsaW5lSGVpZ2h0JykgOiAwKSB8fCAwO1xuICAgICAgICBjb25zdCBmb250RmFtaWx5ID0gU3RyaW5nKHJlYWQoJ2ZvbnRGYW1pbHknKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnZm9udEZhbWlseScpIDogJ0FyaWFsJykgfHwgJ0FyaWFsJztcbiAgICAgICAgY29uc3Qgd3JhcE9uID0gcmVhZCgnd3JhcCcpICE9PSB1bmRlZmluZWQgPyBCb29sZWFuKHJlYWQoJ3dyYXAnKSkgOiByZWFkKCdlbmFibGVXcmFwVGV4dCcpICE9PSB1bmRlZmluZWQgPyBCb29sZWFuKHJlYWQoJ2VuYWJsZVdyYXBUZXh0JykpIDogdHJ1ZTtcbiAgICAgICAgY29uc3QgYm94V2lkdGggPSBOdW1iZXIocmVhZCgnd2lkdGgnKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnd2lkdGgnKSA6IHV0ID8gdXQud2lkdGggOiAwKSB8fCAwO1xuICAgICAgICBjb25zdCBib3hIZWlnaHQgPSBOdW1iZXIocmVhZCgnaGVpZ2h0JykgIT09IHVuZGVmaW5lZCA/IHJlYWQoJ2hlaWdodCcpIDogdXQgPyB1dC5oZWlnaHQgOiAwKSB8fCAwO1xuXG4gICAgICAgIGNvbnN0IE9WRVJGTE9XX05BTUVTID0gWydOT05FJywgJ0NMQU1QJywgJ1NIUklOSycsICdSRVNJWkVfSEVJR0hUJ107XG4gICAgICAgIGNvbnN0IHJhd092ZXJmbG93ID0gcmVhZCgnb3ZlcmZsb3cnKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnb3ZlcmZsb3cnKSA6ICdDTEFNUCc7XG4gICAgICAgIGxldCBvdmVyZmxvd05hbWUgPSAnQ0xBTVAnO1xuICAgICAgICBpZiAodHlwZW9mIHJhd092ZXJmbG93ID09PSAnbnVtYmVyJykgb3ZlcmZsb3dOYW1lID0gT1ZFUkZMT1dfTkFNRVNbcmF3T3ZlcmZsb3ddIHx8ICdDTEFNUCc7XG4gICAgICAgIGVsc2UgaWYgKHR5cGVvZiByYXdPdmVyZmxvdyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IHVwcGVyID0gcmF3T3ZlcmZsb3cudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBvdmVyZmxvd05hbWUgPSBPVkVSRkxPV19OQU1FUy5pbmRleE9mKHVwcGVyKSA+PSAwID8gdXBwZXIgOiAnQ0xBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqIGBvdmVyZmxvdyA9IE5PTkVgIOaXtuW8leaTjuS4jeaKmOihjO+8m+WFtuS9meS4ieenjemDveS8mu+8iOWPquimgeW8gOS6hiBlbmFibGVXcmFwVGV4dO+8ieOAgiAqL1xuICAgICAgICBjb25zdCB3cmFwcyA9IHdyYXBPbiAmJiBvdmVyZmxvd05hbWUgIT09ICdOT05FJztcbiAgICAgICAgY29uc3QgbWV0aG9kcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgICAgIC8qKiDmjInmn5DkuKrlrZflj7fmjpLkuIDpgY3niYgg4oCU4oCUIFNIUklOSyDopoHmi7/lroPkuozliIbvvIzmiYDku6Xmir3miJDlh73mlbDjgIIgKi9cbiAgICAgICAgY29uc3QgbGF5b3V0QXQgPSAoZnM6IG51bWJlcik6IHsgbGluZXM6IHN0cmluZ1tdOyB3aWR0aHM6IG51bWJlcltdOyBtYXhMaW5lV2lkdGg6IG51bWJlcjsgY29udGVudEhlaWdodDogbnVtYmVyOyBhZHZhbmNlOiBudW1iZXIgfSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhZHZhbmNlID0gbGluZUhlaWdodFJhdyA+IDAgPyBsaW5lSGVpZ2h0UmF3IDogZnM7XG4gICAgICAgICAgICBjb25zdCBtZWFzID0gKHM6IHN0cmluZyk6IG51bWJlciA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gbWVhc3VyZVRleHRXaWR0aChzLCBmcywgZm9udEZhbWlseSk7XG4gICAgICAgICAgICAgICAgbWV0aG9kcy5hZGQocmVzdWx0Lm1ldGhvZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC53aWR0aDtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcGFyYWdyYXBoIG9mIHRleHQuc3BsaXQoJ1xcbicpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCF3cmFwcyB8fCAhKGJveFdpZHRoID4gMCkpIHtcbiAgICAgICAgICAgICAgICAgICAgbGluZXMucHVzaChwYXJhZ3JhcGgpO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnQgPSAnJztcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNoIG9mIHBhcmFncmFwaCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBjdXJyZW50ICsgY2g7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjdXJyZW50Lmxlbmd0aCA+IDAgJiYgbWVhcyhjYW5kaWRhdGUpID4gYm94V2lkdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goY3VycmVudCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gY2g7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gY2FuZGlkYXRlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goY3VycmVudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB3aWR0aHMgPSBsaW5lcy5tYXAoKGxpbmUpID0+IG1lYXMobGluZSkpO1xuICAgICAgICAgICAgY29uc3QgY291bnQgPSBsaW5lcy5sZW5ndGg7XG4gICAgICAgICAgICBjb25zdCBjb250ZW50SGVpZ2h0ID0gY291bnQgPT09IDAgPyAwIDogKGNvdW50IC0gMSkgKiBhZHZhbmNlICsgYWR2YW5jZSAqIExBQkVMX0xBU1RfTElORV9GQUNUT1I7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGxpbmVzLFxuICAgICAgICAgICAgICAgIHdpZHRocyxcbiAgICAgICAgICAgICAgICBtYXhMaW5lV2lkdGg6IHdpZHRocy5sZW5ndGggPiAwID8gTWF0aC5tYXgoLi4ud2lkdGhzKSA6IDAsXG4gICAgICAgICAgICAgICAgY29udGVudEhlaWdodCxcbiAgICAgICAgICAgICAgICBhZHZhbmNlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcblxuICAgICAgICAvKiog5qGG6auY5o2i566X5oiQ44CM5pyA5aSa5pS+5b6X5LiL5Yeg6KGM44CN77yI5LiK6Z2iIGBjb250ZW50SGVpZ2h0YCDlhazlvI/nmoTpgIbvvInjgIIgKi9cbiAgICAgICAgY29uc3QgY2FwYWNpdHlPZiA9IChhZHZhbmNlOiBudW1iZXIpOiBudW1iZXIgPT5cbiAgICAgICAgICAgIGFkdmFuY2UgPiAwICYmIGJveEhlaWdodCA+IDBcbiAgICAgICAgICAgICAgICA/IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoYm94SGVpZ2h0IC8gYWR2YW5jZSAtIChMQUJFTF9MQVNUX0xJTkVfRkFDVE9SIC0gMSkpKVxuICAgICAgICAgICAgICAgIDogMDtcblxuICAgICAgICBjb25zdCBiYXNlID0gbGF5b3V0QXQoZm9udFNpemUpO1xuICAgICAgICBjb25zdCBtYXhMaW5lc0ZpdCA9IGNhcGFjaXR5T2YoYmFzZS5hZHZhbmNlKTtcbiAgICAgICAgY29uc3QgbGluZUNvdW50ID0gYmFzZS5saW5lcy5sZW5ndGg7XG4gICAgICAgIGNvbnN0IHZpc2libGVMaW5lcyA9IG92ZXJmbG93TmFtZSA9PT0gJ0NMQU1QJyA/IE1hdGgubWluKGxpbmVDb3VudCwgbWF4TGluZXNGaXQpIDogbGluZUNvdW50O1xuICAgICAgICBjb25zdCBjbGlwcGVkVGV4dCA9IG92ZXJmbG93TmFtZSA9PT0gJ0NMQU1QJyAmJiBsaW5lQ291bnQgPiBtYXhMaW5lc0ZpdCA/IGJhc2UubGluZXMuc2xpY2UobWF4TGluZXNGaXQpLmpvaW4oJycpIDogJyc7XG4gICAgICAgIGNvbnN0IG92ZXJmbG93WCA9IE1hdGgubWF4KDAsIGJhc2UubWF4TGluZVdpZHRoIC0gYm94V2lkdGgpO1xuICAgICAgICBjb25zdCBmaXRzV2lkdGggPSBvdmVyZmxvd1ggPD0gMC41OyAvLyDljYrlg4/ntKDlrrnlt65cbiAgICAgICAgY29uc3QgZml0c0hlaWdodCA9IGxpbmVDb3VudCA8PSBtYXhMaW5lc0ZpdDtcblxuICAgICAgICBsZXQgc2hyaW5rVG86IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgICAgICBpZiAob3ZlcmZsb3dOYW1lID09PSAnU0hSSU5LJykge1xuICAgICAgICAgICAgbGV0IGxvID0gMTtcbiAgICAgICAgICAgIGxldCBoaSA9IGZvbnRTaXplO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMiAmJiBoaSAtIGxvID4gMC4yNTsgaSArPSAxKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWlkID0gKGxvICsgaGkpIC8gMjtcbiAgICAgICAgICAgICAgICBjb25zdCBsYWlkID0gbGF5b3V0QXQobWlkKTtcbiAgICAgICAgICAgICAgICBpZiAobGFpZC5saW5lcy5sZW5ndGggPD0gY2FwYWNpdHlPZihsYWlkLmFkdmFuY2UpICYmIGxhaWQubWF4TGluZVdpZHRoIDw9IGJveFdpZHRoICsgMC41KSBsbyA9IG1pZDtcbiAgICAgICAgICAgICAgICBlbHNlIGhpID0gbWlkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2hyaW5rVG8gPSBNYXRoLnJvdW5kKGxvICogMTAwKSAvIDEwMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlYXNvbnM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGxldCBjb25maWRlbmNlID0gJ2hpZ2gnO1xuICAgICAgICBpZiAobWV0aG9kcy5oYXMoJ2VzdGltYXRlJykpIHtcbiAgICAgICAgICAgIGNvbmZpZGVuY2UgPSAnbG93JztcbiAgICAgICAgICAgIHJlYXNvbnMucHVzaCgn5a695bqm5pivKirkvLAqKueahO+8iOi/meS4queOr+Wig+mHjOayoeaciSBET00g6YeP5LiN5LqG5a2X77yJ77yM5Lit6Iux5re35o6S5Y+v6IO95beu5Yeg5Liq5YOP57SgJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGJveFdpZHRoID4gMCAmJiBiYXNlLm1heExpbmVXaWR0aCA+IGJveFdpZHRoICogMC45OCAmJiBiYXNlLm1heExpbmVXaWR0aCA8PSBib3hXaWR0aCkge1xuICAgICAgICAgICAgaWYgKGNvbmZpZGVuY2UgPT09ICdoaWdoJykgY29uZmlkZW5jZSA9ICdib3JkZXJsaW5lJztcbiAgICAgICAgICAgIHJlYXNvbnMucHVzaCgn5pyA6ZW/5LiA6KGM5Yeg5LmO6aG25Yiw5qGG5a6977yIPjk4Je+8ieKAlOKAlCDlho3lrr3kuIDngrnngrnlsLHkvJrlpJrljaDkuIDooYwnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAod3JhcHMgJiYgL1xccy8udGVzdCh0ZXh0KSkge1xuICAgICAgICAgICAgcmVhc29ucy5wdXNoKCfmlofmnKzlkKvnqbrmoLzvvJrlvJXmk47mjIkqKuivjSoq5oqY6KGM44CB6L+Z6YeM5oyJKirlrZfnrKYqKuaKmCDigJTigJQg5byV5pOO5a6e6ZmF5Y2g55qE6KGMKirlj6/og73mm7TlpJoqKicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHNvdXJjZTogbm9kZSA/IGBub2RlOiR7bm9kZS5uYW1lfWAgOiAnc3BlYycsXG4gICAgICAgICAgICB0ZXh0LFxuICAgICAgICAgICAgZm9udFNpemUsXG4gICAgICAgICAgICBsaW5lSGVpZ2h0OiBsaW5lSGVpZ2h0UmF3LFxuICAgICAgICAgICAgYWR2YW5jZTogcm91bmQzKGJhc2UuYWR2YW5jZSksXG4gICAgICAgICAgICBhZHZhbmNlU291cmNlOiBsaW5lSGVpZ2h0UmF3ID4gMCA/ICdub2RlLmxpbmVIZWlnaHQnIDogJ2VuZ2luZS1kZWZhdWx0KD0gZm9udFNpemXvvIzlm6DkuLogbGluZUhlaWdodCA8PSAwKScsXG4gICAgICAgICAgICB3cmFwOiB3cmFwcyxcbiAgICAgICAgICAgIG92ZXJmbG93OiBvdmVyZmxvd05hbWUsXG4gICAgICAgICAgICBmb250RmFtaWx5LFxuICAgICAgICAgICAgYm94OiB7IHdpZHRoOiByb3VuZDMoYm94V2lkdGgpLCBoZWlnaHQ6IHJvdW5kMyhib3hIZWlnaHQpIH0sXG4gICAgICAgICAgICBsaW5lczogYmFzZS5saW5lcy5tYXAoKGxpbmUsIGkpID0+ICh7IGluZGV4OiBpICsgMSwgdGV4dDogbGluZSwgd2lkdGg6IHJvdW5kMyhiYXNlLndpZHRoc1tpXSkgfSkpLFxuICAgICAgICAgICAgbGluZUNvdW50LFxuICAgICAgICAgICAgbWF4TGluZVdpZHRoOiByb3VuZDMoYmFzZS5tYXhMaW5lV2lkdGgpLFxuICAgICAgICAgICAgY29udGVudEhlaWdodDogcm91bmQzKGJhc2UuY29udGVudEhlaWdodCksXG4gICAgICAgICAgICBtYXhMaW5lc0ZpdCxcbiAgICAgICAgICAgIHZpc2libGVMaW5lcyxcbiAgICAgICAgICAgIGNsaXBwZWRMaW5lQ291bnQ6IE1hdGgubWF4KDAsIGxpbmVDb3VudCAtIHZpc2libGVMaW5lcyksXG4gICAgICAgICAgICBjbGlwcGVkVGV4dCxcbiAgICAgICAgICAgIGZpdHM6IGZpdHNXaWR0aCAmJiBmaXRzSGVpZ2h0LFxuICAgICAgICAgICAgZml0c1dpZHRoLFxuICAgICAgICAgICAgZml0c0hlaWdodCxcbiAgICAgICAgICAgIG92ZXJmbG93WDogcm91bmQzKG92ZXJmbG93WCksXG4gICAgICAgICAgICBzaG9ydGZhbGxQeDogcm91bmQzKE1hdGgubWF4KDAsIGJhc2UuY29udGVudEhlaWdodCAtIGJveEhlaWdodCkpLFxuICAgICAgICAgICAgc2hyaW5rVG8sXG4gICAgICAgICAgICByZXNpemVUbzogb3ZlcmZsb3dOYW1lID09PSAnUkVTSVpFX0hFSUdIVCcgPyB7IGhlaWdodDogcm91bmQzKGJhc2UuY29udGVudEhlaWdodCkgfSA6IG51bGwsXG4gICAgICAgICAgICBtZXRob2Q6IG1ldGhvZHMuaGFzKCdjYW52YXMnKSA/ICdjYW52YXMnIDogJ2VzdGltYXRlJyxcbiAgICAgICAgICAgIHdyYXBNb2RlOiB3cmFwcyA/ICdjaGFyLWdyZWVkeScgOiAnbm9uZScsXG4gICAgICAgICAgICBjb25maWRlbmNlLFxuICAgICAgICAgICAgcmVhc29ucyxcbiAgICAgICAgICAgIGZvcm11bGE6ICdjb250ZW50SGVpZ2h0ID0gKOihjOaVsC0xKcOX6KGM6L+b57uZICsg6KGM6L+b57uZw5cxLjI277yb5pyA5aSa6KGM5pWwID0gZmxvb3Io5qGG6auYL+ihjOi/m+e7mSDiiJIgMC4yNinvvJvooYzov5vnu5kgPSBsaW5lSGVpZ2h0PjAgPyBsaW5lSGVpZ2h0IDogZm9udFNpemUnLFxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIOW/q+eFpyAvIOW3ruW8giDigJTigJQg44CM5oiR5Yiw5bqV5pS55LqG5LuA5LmI44CNXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8qKiDmr4/kuKrnu4Tku7borrDlk6rkupvlrZfmrrXvvIjnmb3lkI3ljZXvvInjgIIqKuS4jeiuvueZveWQjeWNleeahOivneWZquWjsOS8mua3ueaOieecn+ato+eahOaUueWKqCoq44CCICovXG4gICAgY29uc3QgU05BUFNIT1RfQ09NUE9ORU5UX1BST1BTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7XG4gICAgICAgIFNwcml0ZTogWydzcHJpdGVGcmFtZScsICdjb2xvcicsICd0eXBlJywgJ3NpemVNb2RlJywgJ2ZpbGxUeXBlJywgJ2ZpbGxSYW5nZScsICdncmF5c2NhbGUnLCAndHJpbSddLFxuICAgICAgICBMYWJlbDogW1xuICAgICAgICAgICAgJ3N0cmluZycsXG4gICAgICAgICAgICAnZm9udFNpemUnLFxuICAgICAgICAgICAgJ2xpbmVIZWlnaHQnLFxuICAgICAgICAgICAgJ292ZXJmbG93JyxcbiAgICAgICAgICAgICdlbmFibGVXcmFwVGV4dCcsXG4gICAgICAgICAgICAnY29sb3InLFxuICAgICAgICAgICAgJ2hvcml6b250YWxBbGlnbicsXG4gICAgICAgICAgICAndmVydGljYWxBbGlnbicsXG4gICAgICAgICAgICAnaXNCb2xkJyxcbiAgICAgICAgICAgICd1c2VTeXN0ZW1Gb250JyxcbiAgICAgICAgICAgICdmb250RmFtaWx5JyxcbiAgICAgICAgXSxcbiAgICAgICAgUmljaFRleHQ6IFsnc3RyaW5nJywgJ2ZvbnRTaXplJywgJ2xpbmVIZWlnaHQnLCAnbWF4V2lkdGgnLCAnaG9yaXpvbnRhbEFsaWduJ10sXG4gICAgICAgIFVJT3BhY2l0eTogWydvcGFjaXR5J10sXG4gICAgICAgIFdpZGdldDogW1xuICAgICAgICAgICAgJ2lzQWxpZ25Ub3AnLFxuICAgICAgICAgICAgJ2lzQWxpZ25Cb3R0b20nLFxuICAgICAgICAgICAgJ2lzQWxpZ25MZWZ0JyxcbiAgICAgICAgICAgICdpc0FsaWduUmlnaHQnLFxuICAgICAgICAgICAgJ2lzQWxpZ25Ib3Jpem9udGFsQ2VudGVyJyxcbiAgICAgICAgICAgICdpc0FsaWduVmVydGljYWxDZW50ZXInLFxuICAgICAgICAgICAgJ3RvcCcsXG4gICAgICAgICAgICAnYm90dG9tJyxcbiAgICAgICAgICAgICdsZWZ0JyxcbiAgICAgICAgICAgICdyaWdodCcsXG4gICAgICAgICAgICAnaG9yaXpvbnRhbENlbnRlcicsXG4gICAgICAgICAgICAndmVydGljYWxDZW50ZXInLFxuICAgICAgICAgICAgJ2FsaWduTW9kZScsXG4gICAgICAgIF0sXG4gICAgICAgIEJ1dHRvbjogWyd0cmFuc2l0aW9uJywgJ2ludGVyYWN0YWJsZScsICdub3JtYWxDb2xvcicsICdwcmVzc2VkQ29sb3InLCAnaG92ZXJDb2xvcicsICdkaXNhYmxlZENvbG9yJywgJ3pvb21TY2FsZSddLFxuICAgICAgICBMYXlvdXQ6IFtcbiAgICAgICAgICAgICd0eXBlJyxcbiAgICAgICAgICAgICdyZXNpemVNb2RlJyxcbiAgICAgICAgICAgICdjZWxsU2l6ZScsXG4gICAgICAgICAgICAnc3BhY2luZ1gnLFxuICAgICAgICAgICAgJ3NwYWNpbmdZJyxcbiAgICAgICAgICAgICdwYWRkaW5nTGVmdCcsXG4gICAgICAgICAgICAncGFkZGluZ1JpZ2h0JyxcbiAgICAgICAgICAgICdwYWRkaW5nVG9wJyxcbiAgICAgICAgICAgICdwYWRkaW5nQm90dG9tJyxcbiAgICAgICAgICAgICdhZmZlY3RlZEJ5U2NhbGUnLFxuICAgICAgICBdLFxuICAgIH07XG5cbiAgICAvKiogYENvbG9yYCDihpIgYCNycmdnYmJhYWDvvIjmr5TovoPnlKjvvIzmr5TkuIDkuLLlrZfmrrXlpb3or7vkuZ/lpb0gZGlmZu+8ieOAgiAqL1xuICAgIGNvbnN0IGNvbG91ckhleCA9IChjb2xvcjogYW55KTogc3RyaW5nIHwgbnVsbCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWNvbG9yKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSAodjogYW55KTogc3RyaW5nID0+XG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoMCwgTWF0aC5taW4oMjU1LCBNYXRoLnJvdW5kKE51bWJlcih2KSB8fCAwKSkpXG4gICAgICAgICAgICAgICAgICAgIC50b1N0cmluZygxNilcbiAgICAgICAgICAgICAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyk7XG4gICAgICAgICAgICByZXR1cm4gYCMke3BhcnQoY29sb3Iucil9JHtwYXJ0KGNvbG9yLmcpfSR7cGFydChjb2xvci5iKX0ke3BhcnQoY29sb3IuYSl9YDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKiog5oqK5LiA5Liq5bGe5oCn5YC85Y6L5oiQKirlj6/mr5Tlj6/or7sqKueahOe6r+mHj++8iOW/q+eFp+imgeiDvSBKU09OIOWMlu+8jOS5n+S4jeiDveiiqyBjYyDlr7nosaHmi5bniIbvvInjgIIgKi9cbiAgICBjb25zdCBzbmFwc2hvdFZhbHVlID0gKHZhbHVlOiBhbnkpOiB1bmtub3duID0+IHtcbiAgICAgICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBraW5kID0gdHlwZW9mIHZhbHVlO1xuICAgICAgICBpZiAoa2luZCA9PT0gJ3N0cmluZycgfHwga2luZCA9PT0gJ251bWJlcicgfHwga2luZCA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gdmFsdWU7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSA4ID8gdmFsdWUubWFwKCh2KSA9PiBzbmFwc2hvdFZhbHVlKHYpKSA6IGBbQXJyYXkoJHt2YWx1ZS5sZW5ndGh9KV1gO1xuICAgICAgICB9XG4gICAgICAgIGlmIChraW5kID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZS51dWlkID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgdmFsdWUubmFtZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYGFzc2V0OiR7dmFsdWUubmFtZX1AJHt2YWx1ZS51dWlkLnNsaWNlKDAsIDgpfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlLndpZHRoID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgdmFsdWUuaGVpZ2h0ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgIHJldHVybiBgJHtyb3VuZDModmFsdWUud2lkdGgpfSwke3JvdW5kMyh2YWx1ZS5oZWlnaHQpfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlLnggPT09ICdudW1iZXInICYmIHR5cGVvZiB2YWx1ZS55ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS53ID09PSB1bmRlZmluZWQgJiYgdmFsdWUueiA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm91bmQzKHZhbHVlLngpfSwke3JvdW5kMyh2YWx1ZS55KX1gXG4gICAgICAgICAgICAgICAgICAgIDogYCR7cm91bmQzKHZhbHVlLngpfSwke3JvdW5kMyh2YWx1ZS55KX0sJHtyb3VuZDModmFsdWUueiB8fCAwKX1gO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGA8JHsodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IubmFtZSkgfHwgJ09iamVjdCd9PmA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGA8JHtraW5kfT5gO1xuICAgIH07XG5cbiAgICAvKiog5LiA5Liq6IqC54K555qE5b+r54Wn5bGe5oCn77yI55m95ZCN5Y2VICsg5Y6L5bmz77yJ44CCICovXG4gICAgY29uc3Qgc25hcHNob3ROb2RlUHJvcHMgPSAobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIG91dC5hY3RpdmUgPSBub2RlLmFjdGl2ZSAhPT0gZmFsc2U7XG4gICAgICAgIG91dC5wb3NpdGlvbiA9IHNuYXBzaG90VmFsdWUobm9kZS5wb3NpdGlvbik7XG4gICAgICAgIG91dC5zY2FsZSA9IHNuYXBzaG90VmFsdWUobm9kZS5zY2FsZSk7XG4gICAgICAgIGlmICh0eXBlb2Ygbm9kZS5sYXllciA9PT0gJ251bWJlcicpIG91dC5sYXllciA9IG5vZGUubGF5ZXI7XG4gICAgICAgIGNvbnN0IHV0ID0gdWlUcmFuc2Zvcm1PZihub2RlKTtcbiAgICAgICAgaWYgKHV0KSB7XG4gICAgICAgICAgICBvdXQuY29udGVudFNpemUgPSBzbmFwc2hvdFZhbHVlKHV0KTtcbiAgICAgICAgICAgIG91dC5hbmNob3IgPSBgJHtyb3VuZDModXQuYW5jaG9yWCl9LCR7cm91bmQzKHV0LmFuY2hvclkpfWA7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdXQucHJpb3JpdHkgPT09ICdudW1iZXInKSBvdXQucHJpb3JpdHkgPSB1dC5wcmlvcml0eTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5vZGUuZ2V0U2libGluZ0luZGV4ID09PSAnZnVuY3Rpb24nKSBvdXQuc2libGluZ0luZGV4ID0gbm9kZS5nZXRTaWJsaW5nSW5kZXgoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaXN0OiBhbnlbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobm9kZS5jb21wb25lbnRzKSkgbGlzdCA9IG5vZGUuY29tcG9uZW50cztcbiAgICAgICAgICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkobm9kZS5fY29tcG9uZW50cykpIGxpc3QgPSBub2RlLl9jb21wb25lbnRzO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGxpc3QgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBjb21wIG9mIGxpc3QpIHtcbiAgICAgICAgICAgIGlmICghY29tcCkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCB0eXBlTmFtZSA9IFN0cmluZygoY29tcC5jb25zdHJ1Y3RvciAmJiBjb21wLmNvbnN0cnVjdG9yLm5hbWUpIHx8ICdDb21wb25lbnQnKTtcbiAgICAgICAgICAgIG5hbWVzLnB1c2godHlwZU5hbWUpO1xuICAgICAgICAgICAgY29uc3Qgd2FudGVkID0gU05BUFNIT1RfQ09NUE9ORU5UX1BST1BTW3R5cGVOYW1lXTtcbiAgICAgICAgICAgIGlmICghd2FudGVkKSBjb250aW51ZTtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog57uE5Lu25a2X5q61KirmkYrlubPmiJAgYFR5cGUuZmllbGRgIOS4gOS4qumUrioq77yM6ICM5LiN5piv5bWM5oiQIGB7TGFiZWw6IHvigKZ9fWAg4oCU4oCUXG4gICAgICAgICAgICAgKiDlkKbliJnmlLnkuIDkuKrlrZfkvZPkvJrmiormlbTkuKogTGFiZWwg55qE5a2X5q616KKL5oql5oiQIGZyb20vdG/vvIxcbiAgICAgICAgICAgICAqIOOAjOWTquS4gOadoeWPmOS6huOAjeWwseeci+S4jeWHuuadpeS6hu+8iOWunua1i+esrOS4gOeJiOWwseaYr+i/meagt++8jGRpZmYg5Zue5omn5LiA5bGP5YWo5piv5Zmq5aOw77yJ44CCXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIHdhbnRlZCkge1xuICAgICAgICAgICAgICAgIGxldCByYXc6IGFueTtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICByYXcgPSBjb21wW2tleV07XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIG91dFtgJHt0eXBlTmFtZX0uJHtrZXl9YF0gPVxuICAgICAgICAgICAgICAgICAgICByYXcgJiYgdHlwZW9mIHJhdyA9PT0gJ29iamVjdCcgJiYgdHlwZW9mIHJhdy5yID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgcmF3LmEgPT09ICdudW1iZXInXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGNvbG91ckhleChyYXcpXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHNuYXBzaG90VmFsdWUocmF3KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBvdXQuY29tcG9uZW50cyA9IG5hbWVzLnNvcnQoKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9O1xuXG4gICAgLyoqIEZOVi0xYe+8iDMyIOS9je+8ieKAlOKAlCDlj6rnlKjmnaXjgIzkuKTku73lv6vnhafmmK/kuI3mmK/lkIzkuIDku73jgI3vvIzkuI3lgZrlronlhajnlKjpgJTjgIIgKi9cbiAgICBjb25zdCBoYXNoT2YgPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICAgICAgbGV0IGhhc2ggPSAweDgxMWM5ZGM1O1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgIGhhc2ggXj0gdGV4dC5jaGFyQ29kZUF0KGkpO1xuICAgICAgICAgICAgaGFzaCA9IChoYXNoICsgKChoYXNoIDw8IDEpICsgKGhhc2ggPDwgNCkgKyAoaGFzaCA8PCA3KSArIChoYXNoIDw8IDgpICsgKGhhc2ggPDwgMjQpKSkgPj4+IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGhhc2gudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDgsICcwJyk7XG4gICAgfTtcblxuICAgIC8qKiDokL3nm5jvvIjmi7/kuI3liLAgYGZzYCDlsLHlpoLlrp7lm54gbnVsbO+8jOS4jeWBh+ijheWGmeS6hu+8ieOAgiAqL1xuICAgIGNvbnN0IHdyaXRlVGV4dEZpbGUgPSAoc2F2ZVBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfCBudWxsOyBlcnJvcj86IHN0cmluZyB9ID0+IHtcbiAgICAgICAgY29uc3Qgbm9kZU1vZHMgPSBnZXROb2RlTW9kdWxlcygpO1xuICAgICAgICBpZiAoIW5vZGVNb2RzKSByZXR1cm4geyBwYXRoOiBudWxsLCBlcnJvcjogJ+i/meS4qui/m+eoi+mHjOaLv+S4jeWIsCBmc++8jOWGmeS4jeS6huebmCcgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGRpciA9IG5vZGVNb2RzLnBhdGguZGlybmFtZShzYXZlUGF0aCk7XG4gICAgICAgICAgICBpZiAoZGlyKSBub2RlTW9kcy5mcy5ta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIG5vZGVNb2RzLmZzLndyaXRlRmlsZVN5bmMoc2F2ZVBhdGgsIHRleHQsICd1dGYtOCcpO1xuICAgICAgICAgICAgcmV0dXJuIHsgcGF0aDogc2F2ZVBhdGggfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBwYXRoOiBudWxsLCBlcnJvcjogYOWGmSAke3NhdmVQYXRofSDlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqICoq57uZ5LiA5qO15a2Q5qCR5ouN5LiA5Lu957qv5pWw5o2u5b+r54WnKirvvIjmjInoioLngrnot6/lvoTlgZrplK7vvInigJTigJQg44CM5oiR5Yiw5bqV5pS55LqG5LuA5LmI44CN55qE5YmN5LiA5Y2K44CCXG4gICAgICpcbiAgICAgKiAjIyDkuLrku4DkuYjkuI3og73pnaAgYGR1bXAobm9kZSlgIOaIluaIquWbvlxuICAgICAqXG4gICAgICogLSBgZHVtcGAg5Zue55qE5pivIGNjIOWvueixoeaRmOimge+8jCoq5a2Y5LiN5LiL5p2l5Lmf5rKh5rOV5q+UKirvvJvogIzkuJTov5Tlm57lgLzmnIkgNDAwMCDlrZfkuIrpmZDvvIxcbiAgICAgKiAgIDMwNiDkuKroioLngrnmoLnmnKzlm57kuI3mnaXvvJtcbiAgICAgKiAtIOaIquWbvuWPquiDveWRiuivieS9oFwi55yL6LW35p2l5LiN5LiA5qC35LqGXCLvvIzlkYrkuI3lh7pcIuWTquS4quWxnuaAp+S7juWHoOWPmOaIkOWHoFwi44CCXG4gICAgICpcbiAgICAgKiAjIyDkuInmnaHorr7orqHlj6PlvoRcbiAgICAgKlxuICAgICAqIDEuICoq6ZSu5piv6IqC54K56Lev5b6E77yM5LiN5pivIHV1aWQqKuOAgue8lui+keWZqOWtmOebmC/ph43mlrDlr7zlhaXlkI7oioLngrkgdXVpZCAqKuS8muWPmCoqXG4gICAgICogICDvvIjlrp7mtYvmr4/mrKHkv53lrZjpg73mjaLkuIDmibnvvInigJTigJQg5oyJIHV1aWQg5YGa6ZSu55qE6K+dIGJlZm9yZS9hZnRlciDkvJrlhajmmK/jgIzliKDkuoYgMzA2IOS4quOAgeWKoOS6hiAzMDYg5Liq44CN44CCXG4gICAgICogMi4gKirlsZ7mgKfotbDnmb3lkI3ljZUqKu+8iGBTTkFQU0hPVF9DT01QT05FTlRfUFJPUFNg77yJ44CC5YWo6YePIGR1bXAg55qE6K+d77yMXG4gICAgICogICAgYF9fcHJlbG9hZGAv6L+Q6KGM5pe257yT5a2Y5a2X5q615q+P5p2h6YO95Zyo5Y+Y77yM55yf5q2j55qE5pS55Yqo5Lya6KKr5Zmq5aOw5re55o6J44CCXG4gICAgICogMy4gKirmlbTku73nlZnlnKjlnLrmma/ov5vnqIvph4wqKu+8jOi/lOWbnuWAvOWPque7meOAjOaRmOimgSArIOWTiOW4jCArIOWtmOS6huayoeOAjeKAlOKAlFxuICAgICAqICAgIGBNYXBgIOaMguWcqOaooeWdl+S9nOeUqOWfn++8jOaJgOS7pei3qOS4pOasoSBgZXhlY3V0ZV9jb2RlYCDosIPnlKjkuZ/lnKjvvIjop4EgYHNuYXBzaG90U3RvcmVgIOazqOmHiu+8ieOAglxuICAgICAqXG4gICAgICogIyMg55So5rOVXG4gICAgICpcbiAgICAgKiBgYGBqc1xuICAgICAqIHNuYXBzaG90VHJlZShudWxsLCB7IGxhYmVsOiAnYmVmb3JlJyB9KTsgICAvLyDliqjmiYvliY1cbiAgICAgKiAvLyDigKbmlLnigKZcbiAgICAgKiBzbmFwc2hvdFRyZWUobnVsbCwgeyBsYWJlbDogJ2FmdGVyJyB9KTtcbiAgICAgKiBkaWZmVHJlZSgnYmVmb3JlJywgJ2FmdGVyJyk7ICAgICAgICAgICAgICAgLy8g4oaSIOWPquWbnuecn+ato+WPmOS6hueahOmCo+WHoOadoVxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogQHBhcmFtIHJvb3Qg5ouN5ZOq5qO15a2Q5qCR77yI6buY6K6k5pW05Liq5Zy65pmv77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMubGFiZWwg6L+Z5Lu95b+r54Wn55qE5ZCN5a2X77yIYGRpZmZUcmVlYCDnlKjlroPlvJXnlKjvvJvkuI3nu5nlsLHoh6rliqjnlJ/miJDvvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5zYXZlVG8g6aG65L6/5oqK5a6M5pW05b+r54Wn5YaZ5Yiw6L+Z5Liq6Lev5b6EXG4gICAgICogQHBhcmFtIG9wdGlvbnMubWF4Tm9kZXMg6IqC54K55pWw5LiK6ZmQ77yI6buY6K6kIDIwMDAw77yM6Ziy5ZGG77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMuaW5jbHVkZUVkaXRvciDov57nvJbovpHlmaggZ2l6bW8v572R5qC85LiA6LW35ouN77yI6buY6K6kIGZhbHNlIOKAlOKAlCDlroPku6zmmK/nvJbovpHlmajoh6rlt7Hph43lu7rnmoTvvIzkvJrpgKDlgYcgZGlmZu+8iVxuICAgICAqL1xuICAgIGhlbHBlcnMuc25hcHNob3RUcmVlID0gKHJvb3Q/OiBhbnksIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3QgbGFiZWwgPVxuICAgICAgICAgICAgdHlwZW9mIG9wdHMubGFiZWwgPT09ICdzdHJpbmcnICYmIG9wdHMubGFiZWwudHJpbSgpID8gb3B0cy5sYWJlbC50cmltKCkgOiBgc25hcC0ke3NuYXBzaG90U3RvcmUuc2l6ZSArIDF9YDtcbiAgICAgICAgY29uc3QgbWF4Tm9kZXMgPSBjbGFtcE51bWJlcihvcHRzLm1heE5vZGVzLCAxLCAyMDAwMDAsIDIwMDAwKTtcbiAgICAgICAgY29uc3Qgc3RhcnQgPSByb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghc3RhcnQpIHRocm93IG5ldyBFcnJvcignc25hcHNob3RUcmVlKHJvb3Qp77ya5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmv77yI5Lmf5rKh57uZIHJvb3TvvInjgIInKTtcblxuICAgICAgICBjb25zdCBub2RlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgY29uc3QgaW5jbHVkZUVkaXRvciA9IEJvb2xlYW4ob3B0cy5pbmNsdWRlRWRpdG9yKTtcbiAgICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgICAgbGV0IHRydW5jYXRlZCA9IDA7XG4gICAgICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IGFueSwgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgICAgICAgICBpZiAoY291bnQgPj0gbWF4Tm9kZXMpIHtcbiAgICAgICAgICAgICAgICB0cnVuY2F0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBub2Rlc1twYXRoXSA9IHNuYXBzaG90Tm9kZVByb3BzKG5vZGUpO1xuICAgICAgICAgICAgY291bnQgKz0gMTtcbiAgICAgICAgICAgIGNvbnN0IGtpZHM6IGFueVtdID0gKG5vZGUgJiYgbm9kZS5jaGlsZHJlbikgfHwgW107XG4gICAgICAgICAgICBjb25zdCBwYWlycyA9IGtpZHMubWFwKChrOiBhbnksIGk6IG51bWJlcikgPT4gKHsgaywgaSwgcDogcmVhZE5vZGVQcmlvcml0eShrKSB9KSk7XG4gICAgICAgICAgICBwYWlycy5zb3J0KChhLCBiKSA9PiBhLnAgLSBiLnAgfHwgYS5pIC0gYi5pKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcGFpciBvZiBwYWlycykge1xuICAgICAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICAgICAqIOm7mOiupCoq5Ymq5o6J57yW6L6R5Zmo6KOF6aWwKirvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8ieOAguS4jeWPquaYr+ecgeS9k+enr++8mlxuICAgICAgICAgICAgICAgICAqIOmCo+S6m+iKgueCueaYr+e8lui+keWZqCoq6Ieq5bex6YeN5bu6KirnmoTvvIzlkI3lrZfkuI7lsYLnuqfkvJrpmo/op4bop5Iv6YCJ5Lit5oCB5Y+Y77yMXG4gICAgICAgICAgICAgICAgICog55WZ552A5a6D5Lus5Lya6K6pIGRpZmYg6YeM5YaS5Ye65LiA5aCGXCLmlrDlop4v5Yig6Zmk5LqGIHhBeGlzXCLnmoTlgYfkv6Hlj7cg4oCU4oCUXG4gICAgICAgICAgICAgICAgICog5LiA5Liq5Lya5ZaK54u85p2l5LqG55qEIGRpZmYg5q+U5rKh5pyJIGRpZmYg5pu057Of44CCXG4gICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgaWYgKCFpbmNsdWRlRWRpdG9yICYmIGlzRWRpdG9yTm9kZShwYWlyLmspKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gU3RyaW5nKHBhaXIuay5uYW1lKTtcbiAgICAgICAgICAgICAgICB2aXNpdChwYWlyLmssIHBhdGggPyBgJHtwYXRofS8ke25hbWV9YCA6IG5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB2aXNpdChzdGFydCwgJy4nKTtcblxuICAgICAgICBjb25zdCB0cmVlID0geyByb290OiBTdHJpbmcoc3RhcnQubmFtZSB8fCAnc2NlbmUnKSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgbm9kZXMgfTtcbiAgICAgICAgY29uc3QganNvbiA9IEpTT04uc3RyaW5naWZ5KHRyZWUpO1xuICAgICAgICAvKipcbiAgICAgICAgICog4pqgIOWTiOW4jCoq5Y+q5Y+W5YaF5a65KirvvIhgcm9vdGAgKyBgbm9kZXNg77yJ77yMKirkuI3lkKsgYGF0YCDml7bpl7TmiLMqKuOAglxuICAgICAgICAgKlxuICAgICAgICAgKiDljp/mnaXmmK8gYGhhc2hPZihqc29uKWAg4oCU4oCUIOi/niBgYXRgIOS4gOi1t+WTiOW4jO+8jOS6juaYr1wi5ZCM5LiA5qO15qCR6L+e5ouN5Lik5qyh5ZOI5biM55u45ZCMXCLlj6rlnKhcbiAgICAgICAgICogKirkuKTmrKHokL3lnKjlkIzkuIDmr6vnp5IqKuaXtuaJjeaIkOeri++8iDIwMjYtMTEg6KKrIHZlcmlmeSDnmoTorqHml7bmipbliqjmipPkuobkuKrmraPnnYDvvJpcbiAgICAgICAgICogYHtcInNhbWVcIjpmYWxzZSxcImJ5dGVzXCI6dHJ1ZSxcIm5vZGVDb3VudFwiOjZ9YO+8ieOAguS4gOS4quS8mumaj+aXtumXtOWPmOeahOWTiOW4jOW9k+S4jeS6huWGheWuueaMh+e6ue+8jFxuICAgICAgICAgKiDogIxcIuaLjeS4gOasoSDihpIg5pS5IOKGkiDlho3mi40g4oaSIOavlOWTiOW4jFwi5q2j5piv6L+Z5Liq5Yqp5omL5a2Y5Zyo55qE55CG55Sx44CCXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCByZWNvcmQgPSB7IGxhYmVsLCB0cmVlLCBoYXNoOiBoYXNoT2YoSlNPTi5zdHJpbmdpZnkoeyByb290OiB0cmVlLnJvb3QsIG5vZGVzIH0pKSwgYnl0ZXM6IGpzb24ubGVuZ3RoLCBhdDogdHJlZS5hdCB9O1xuXG4gICAgICAgIC8vIOa3mOaxsOacgOaXp+eahO+8iE1hcCDkv53mjIHmj5LlhaXluo/vvIlcbiAgICAgICAgc25hcHNob3RTdG9yZS5zZXQobGFiZWwsIHJlY29yZCk7XG4gICAgICAgIHdoaWxlIChzbmFwc2hvdFN0b3JlLnNpemUgPiBTTkFQU0hPVF9LRUVQKSB7XG4gICAgICAgICAgICBjb25zdCBvbGRlc3QgPSBzbmFwc2hvdFN0b3JlLmtleXMoKS5uZXh0KCk7XG4gICAgICAgICAgICBpZiAob2xkZXN0LmRvbmUpIGJyZWFrO1xuICAgICAgICAgICAgc25hcHNob3RTdG9yZS5kZWxldGUob2xkZXN0LnZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzYXZlZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGxldCBzYXZlRXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHR5cGVvZiBvcHRzLnNhdmVUbyA9PT0gJ3N0cmluZycgJiYgb3B0cy5zYXZlVG8udHJpbSgpKSB7XG4gICAgICAgICAgICBjb25zdCB3cml0dGVuID0gd3JpdGVUZXh0RmlsZShvcHRzLnNhdmVUby50cmltKCksIEpTT04uc3RyaW5naWZ5KHJlY29yZCwgbnVsbCwgMikpO1xuICAgICAgICAgICAgc2F2ZWQgPSB3cml0dGVuLnBhdGg7XG4gICAgICAgICAgICBzYXZlRXJyb3IgPSB3cml0dGVuLmVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmICh0cnVuY2F0ZWQgPiAwKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgICAgIGDoioLngrnmlbDotoXov4cgbWF4Tm9kZXM9JHttYXhOb2Rlc33vvIzov5nku73lv6vnhacqKuS4jeWujOaVtCoqIOKAlOKAlCBkaWZmIOS8muaKiuayoeaLjeWIsOeahOiKgueCueW9k+aIkFwi6KKr5Yig5LqGXCLjgIJgLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBub3Rlcy5wdXNoKCfliqjmiYvliY3mi43kuIDku73jgIHmlLnlrozlho3mi43kuIDku73vvIznhLblkI4gZGlmZlRyZWUoYmVmb3JlLCBhZnRlcikg5bCx55+l6YGT6Ieq5bex5Yiw5bqV5Yqo5LqG5LuA5LmI44CCJyk7XG4gICAgICAgIG5vdGVzLnB1c2goJ+iKgueCuS/nu4Tku7bnmoTplK7mmK8qKui3r+W+hCoq77yM57yW6L6R5Zmo5a2Y55uY5o2iIHV1aWQg5LiN5b2x5ZON5q+U5a+544CCJyk7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGxhYmVsLFxuICAgICAgICAgICAgcm9vdDogdHJlZS5yb290LFxuICAgICAgICAgICAgbm9kZUNvdW50OiBPYmplY3Qua2V5cyhub2RlcykubGVuZ3RoLFxuICAgICAgICAgICAgYnl0ZXM6IGpzb24ubGVuZ3RoLFxuICAgICAgICAgICAgaGFzaDogcmVjb3JkLmhhc2gsXG4gICAgICAgICAgICBhdDogdHJlZS5hdCxcbiAgICAgICAgICAgIHNhdmVkLFxuICAgICAgICAgICAgc2F2ZUVycm9yLFxuICAgICAgICAgICAgdHJ1bmNhdGVkLFxuICAgICAgICAgICAga2VwdDogQXJyYXkuZnJvbShzbmFwc2hvdFN0b3JlLmtleXMoKSksXG4gICAgICAgICAgICBub3RlOiBub3Rlcy5qb2luKCcgJyksXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqICoq5Lik5Lu95b+r54Wn55qE5beu5byCKiog4oCU4oCUIOOAjOaIkeWIsOW6leaUueS6huS7gOS5iOOAjeeahOWQjuS4gOWNiuOAglxuICAgICAqXG4gICAgICog5Y+q5ZueKirnnJ/mraPlj5jkuoYqKueahOiKgueCueWSjOWxnuaAp++8iGB7ZnJvbSwgdG99YCDmiJDlr7nnu5nvvInvvIzmiYDku6Xlm57miaflpKnnhLblvojlsI/vvIxcbiAgICAgKiDkuI3kvJrooqsgNDAwMCDlrZfkuIrpmZDmiKrmlq0g4oCU4oCUIOWujOaVtOaKpeWRiuaDs+eVmeaho+WwseS8oCBgc2F2ZVRvYOOAglxuICAgICAqXG4gICAgICog6aG65bim5Lya5oyR5Ye6IGBzdXNwZWN0TGVha3Ng77ya5paw5aKe6IqC54K56YeM5ZCN5a2X5YOP5Li05pe25YCZ6YCJ54mp55qEXG4gICAgICog77yIYF9fYCAvIGBwcm9iZWAgLyBgdG1wYCAvIGB0ZXN0YO+8ieKAlOKAlCAqKuWunua1i+i4qei/h+S4gOasoSoq77ya5o6i6ZKI5Y2h54mH5ZKMIGBkZXRhaWxgL2BuYW1lYFxuICAgICAqIOeahOWunumqjOiKgueCueeVmeWcqOmihOWItuS7tumHjOW/mOS6huWIoO+8jOWFqOmdoOS4i+S4gOasoeW8gOe8lui+keWZqOaXtuS6uuW3peWPkeeOsOOAglxuICAgICAqXG4gICAgICogQHBhcmFtIGJlZm9yZSDlv6vnhacgbGFiZWzvvIzmiJbkuIDku73lv6vnhaflr7nosaFcbiAgICAgKiBAcGFyYW0gYWZ0ZXIg5ZCM5LiKXG4gICAgICogQHBhcmFtIG9wdGlvbnMubGltaXQg5q+P57G75pyA5aSa5Zue5Yeg5p2h77yI6buY6K6kIDQw77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMuc2F2ZVRvIOaKiioq5a6M5pW0KirmiqXlkYrlhpnliLDov5nkuKrot6/lvoRcbiAgICAgKi9cbiAgICBoZWxwZXJzLmRpZmZUcmVlID0gKFxuICAgICAgICBiZWZvcmU/OiBhbnksXG4gICAgICAgIGFmdGVyPzogYW55LFxuICAgICAgICBvcHRpb25zPzogUmVjb3JkPHN0cmluZywgYW55PixcbiAgICApOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgICAgIGNvbnN0IG9wdHM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICBjb25zdCBsaW1pdCA9IGNsYW1wTnVtYmVyKG9wdHMubGltaXQsIDEsIDUwMDAsIDQwKTtcbiAgICAgICAgY29uc3QgcmVzb2x2ZVNuYXAgPSAocmVmOiBhbnksIHNpZGU6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIGFueT4gPT4ge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiByZWYgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZm91bmQgPSBzbmFwc2hvdFN0b3JlLmdldChyZWYpO1xuICAgICAgICAgICAgICAgIGlmICghZm91bmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYGRpZmZUcmVl77ya5rKh5pyJ5ZCN5Li6ICcke3JlZn0nIOeahOW/q+eFp++8iCR7c2lkZX3vvInjgILlt7LmnInnmoTvvJoke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEFycmF5LmZyb20oc25hcHNob3RTdG9yZS5rZXlzKCkpLmpvaW4oJywgJykgfHwgJ++8iOS4gOS7vemDveayoeacie+8iSdcbiAgICAgICAgICAgICAgICAgICAgICAgIH3jgILlhYjnlKggc25hcHNob3RUcmVlKG51bGwsIHsgbGFiZWw6ICcke3JlZn0nIH0pIOaLjeS4gOS7veOAgmAsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBmb3VuZCBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlZiAmJiB0eXBlb2YgcmVmID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRyZWUgPSAocmVmIGFzIFJlY29yZDxzdHJpbmcsIGFueT4pLnRyZWUgfHwgcmVmO1xuICAgICAgICAgICAgICAgIGlmICh0cmVlICYmIHR5cGVvZiB0cmVlID09PSAnb2JqZWN0JyAmJiAodHJlZSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KS5ub2Rlcykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVmIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkaWZmVHJlZe+8miR7c2lkZX0g5pei5LiN5piv5b+r54WnIGxhYmVs77yM5Lmf5LiN5piv5LiA5Lu95b+r54Wn5a+56LGh77yI6KaB5pyJIC50cmVlLm5vZGVzIOaIliAubm9kZXPvvInjgIJgKTtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCBzbmFwQSA9IHJlc29sdmVTbmFwKGJlZm9yZSwgJ2JlZm9yZScpO1xuICAgICAgICBjb25zdCBzbmFwQiA9IHJlc29sdmVTbmFwKGFmdGVyLCAnYWZ0ZXInKTtcbiAgICAgICAgY29uc3Qgbm9kZXNBID0gKHNuYXBBLnRyZWUgPyBzbmFwQS50cmVlLm5vZGVzIDogc25hcEEubm9kZXMpIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgICAgIGNvbnN0IG5vZGVzQiA9IChzbmFwQi50cmVlID8gc25hcEIudHJlZS5ub2RlcyA6IHNuYXBCLm5vZGVzKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuXG4gICAgICAgIGNvbnN0IGNoYW5nZWQ6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICAgICAgICBjb25zdCBhZGRlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgcmVtb3ZlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgbGV0IHVuY2hhbmdlZCA9IDA7XG5cbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZXNCKSkge1xuICAgICAgICAgICAgaWYgKCEoa2V5IGluIG5vZGVzQSkpIHtcbiAgICAgICAgICAgICAgICBhZGRlZC5wdXNoKGtleSk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBhID0gbm9kZXNBW2tleV0gfHwge307XG4gICAgICAgICAgICBjb25zdCBiID0gbm9kZXNCW2tleV0gfHwge307XG4gICAgICAgICAgICBjb25zdCBwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0PHN0cmluZz4oWy4uLk9iamVjdC5rZXlzKGEpLCAuLi5PYmplY3Qua2V5cyhiKV0pO1xuICAgICAgICAgICAgZm9yIChjb25zdCBwcm9wIG9mIGtleXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhdiA9IEpTT04uc3RyaW5naWZ5KGFbcHJvcF0pO1xuICAgICAgICAgICAgICAgIGNvbnN0IGJ2ID0gSlNPTi5zdHJpbmdpZnkoYltwcm9wXSk7XG4gICAgICAgICAgICAgICAgaWYgKGF2ICE9PSBidikgcHJvcHNbcHJvcF0gPSB7IGZyb206IGFbcHJvcF0gPT09IHVuZGVmaW5lZCA/IG51bGwgOiBhW3Byb3BdLCB0bzogYltwcm9wXSA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IGJbcHJvcF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhwcm9wcykubGVuZ3RoID4gMCkgY2hhbmdlZC5wdXNoKHsgcGF0aDoga2V5LCBwcm9wcyB9KTtcbiAgICAgICAgICAgIGVsc2UgdW5jaGFuZ2VkICs9IDE7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZXNBKSkgaWYgKCEoa2V5IGluIG5vZGVzQikpIHJlbW92ZWQucHVzaChrZXkpO1xuXG4gICAgICAgIGNvbnN0IHJlcG9ydCA9IHtcbiAgICAgICAgICAgIGJlZm9yZTogc25hcEEubGFiZWwgfHwgJyhvYmplY3QpJyxcbiAgICAgICAgICAgIGFmdGVyOiBzbmFwQi5sYWJlbCB8fCAnKG9iamVjdCknLFxuICAgICAgICAgICAgY291bnRzOiB7XG4gICAgICAgICAgICAgICAgYmVmb3JlTm9kZXM6IE9iamVjdC5rZXlzKG5vZGVzQSkubGVuZ3RoLFxuICAgICAgICAgICAgICAgIGFmdGVyTm9kZXM6IE9iamVjdC5rZXlzKG5vZGVzQikubGVuZ3RoLFxuICAgICAgICAgICAgICAgIGNoYW5nZWQ6IGNoYW5nZWQubGVuZ3RoLFxuICAgICAgICAgICAgICAgIGFkZGVkOiBhZGRlZC5sZW5ndGgsXG4gICAgICAgICAgICAgICAgcmVtb3ZlZDogcmVtb3ZlZC5sZW5ndGgsXG4gICAgICAgICAgICAgICAgdW5jaGFuZ2VkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGNoYW5nZWQsXG4gICAgICAgICAgICBhZGRlZCxcbiAgICAgICAgICAgIHJlbW92ZWQsXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHNhdmVkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgbGV0IHNhdmVFcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAodHlwZW9mIG9wdHMuc2F2ZVRvID09PSAnc3RyaW5nJyAmJiBvcHRzLnNhdmVUby50cmltKCkpIHtcbiAgICAgICAgICAgIGNvbnN0IHdyaXR0ZW4gPSB3cml0ZVRleHRGaWxlKG9wdHMuc2F2ZVRvLnRyaW0oKSwgSlNPTi5zdHJpbmdpZnkocmVwb3J0LCBudWxsLCAyKSk7XG4gICAgICAgICAgICBzYXZlZCA9IHdyaXR0ZW4ucGF0aDtcbiAgICAgICAgICAgIHNhdmVFcnJvciA9IHdyaXR0ZW4uZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzdXNwZWN0TGVha3MgPSBhZGRlZC5maWx0ZXIoKHApID0+IC9fX3xwcm9iZXx0bXB8dGVtcHx0ZXN0L2kudGVzdChwKSk7XG4gICAgICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAoY2hhbmdlZC5sZW5ndGggPT09IDAgJiYgYWRkZWQubGVuZ3RoID09PSAwICYmIHJlbW92ZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKCfkuKTku73lv6vnhafkuIDmqKHkuIDmoLcg4oCU4oCUIOimgeS5iOecn+ayoeaUueWKqO+8jOimgeS5iOaUueWujCoq5rKh5a2Y55uYKirvvIjnvJbovpHmgIHmlLnkuobkuI3lrZjvvIzlnLrmma/mlbDmja7lsLHmmK/msqHlj5jvvInjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3VzcGVjdExlYWtzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgYOKaoCDmlrDlop7oioLngrnph4zmnIkgJHtzdXNwZWN0TGVha3MubGVuZ3RofSDkuKrlkI3lrZflg4/kuLTml7bmjqLpkojvvIgke3N1c3BlY3RMZWFrcy5zbGljZSgwLCA1KS5qb2luKCcsICcpfe+8ieKAlOKAlCDnoa7orqTkuIDkuIvmmK/kuI3mmK/lv5jkuobliKDjgIJgLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRydW5jYXRlZCA9IGNoYW5nZWQubGVuZ3RoID4gbGltaXQgfHwgYWRkZWQubGVuZ3RoID4gbGltaXQgfHwgcmVtb3ZlZC5sZW5ndGggPiBsaW1pdDtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGJlZm9yZTogcmVwb3J0LmJlZm9yZSxcbiAgICAgICAgICAgIGFmdGVyOiByZXBvcnQuYWZ0ZXIsXG4gICAgICAgICAgICBjb3VudHM6IHJlcG9ydC5jb3VudHMsXG4gICAgICAgICAgICBjaGFuZ2VkOiBjaGFuZ2VkLnNsaWNlKDAsIGxpbWl0KSxcbiAgICAgICAgICAgIGFkZGVkOiBhZGRlZC5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgICAgICByZW1vdmVkOiByZW1vdmVkLnNsaWNlKDAsIGxpbWl0KSxcbiAgICAgICAgICAgIHN1c3BlY3RMZWFrcyxcbiAgICAgICAgICAgIHRydW5jYXRlZCxcbiAgICAgICAgICAgIHNhdmVkLFxuICAgICAgICAgICAgc2F2ZUVycm9yLFxuICAgICAgICAgICAgbm90ZTogdHJ1bmNhdGVkID8gYCR7bm90ZXMuam9pbignICcpfSDmr4/nsbvlj6rlm57kuobliY0gJHtsaW1pdH0g5p2h77yI5a6M5pW05oql5ZGK6KeBIHNhdmVUb++8ieOAgmAgOiBub3Rlcy5qb2luKCcgJyksXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIC8qKiDliJflh7rlvZPliY3lj6/nlKjnmoTliqnmiYvlh73mlbAg4oCU4oCUIOiuqSBBSSDoh6rlt7Hlj5HnjrDog73lipvvvIzogIzkuI3mmK/pnaAgdG9vbCDmlofmoaPnoazog4wgKi9cbiAgICBoZWxwZXJzLmhlbHBlck5hbWVzID0gKCk6IHN0cmluZ1tdID0+IE9iamVjdC5rZXlzKGhlbHBlcnMpLnNvcnQoKTtcbiAgICByZXR1cm4geyBoZWxwZXJzLCBzdGF0ZSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOaymeeuseaJp+ihjFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBTY2VuZUxvZ0VudHJ5IHtcbiAgICBsZXZlbDogc3RyaW5nO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBhdE1zOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBSdW5Db2RlUGF5bG9hZCB7XG4gICAgY29kZT86IHN0cmluZztcbiAgICBhcmdzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdGltZW91dE1zPzogbnVtYmVyO1xuICAgIG1heExvZ3M/OiBudW1iZXI7XG4gICAgbWF4TG9nTGVuZ3RoPzogbnVtYmVyO1xuICAgIC8qKiDlt6XnqIvmoLkg4oCU4oCUIOS4u+i/m+eoi++8iGVkaXRvciDkvqfvvInnu5nnmoTvvIxgbG9hZEZyYW1lYCDor7sgYC5tZXRhYCDopoHnlKjvvIjop4EgYG1ha2VIZWxwZXJzYO+8ieOAgiAqL1xuICAgIHByb2plY3RQYXRoPzogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBtYWtlQ2FwdHVyZWRDb25zb2xlKFxuICAgIHNpbms6IFNjZW5lTG9nRW50cnlbXSxcbiAgICBzdGFydGVkQXQ6IG51bWJlcixcbiAgICBtYXhMb2dzOiBudW1iZXIsXG4gICAgbWF4TG9nTGVuZ3RoOiBudW1iZXIsXG4pOiB7IGNvbnNvbGU6IFJlY29yZDxzdHJpbmcsICguLi5wYXJ0czogdW5rbm93bltdKSA9PiB2b2lkPjsgd2FzVHJ1bmNhdGVkOiAoKSA9PiBib29sZWFuIH0ge1xuICAgIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgICBjb25zdCBzdHJpbmdpZnkgPSAodmFsdWU6IHVua25vd24pOiBzdHJpbmcgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgcmV0dXJuIHZhbHVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgIHZhbHVlLFxuICAgICAgICAgICAgICAgIChfaywgdikgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgPT09ICdmdW5jdGlvbicpIHJldHVybiBgW0Z1bmN0aW9uICR7di5uYW1lIHx8ICdhbm9ueW1vdXMnfV1gO1xuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgPT09ICdiaWdpbnQnKSByZXR1cm4gYCR7dn1uYDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHY7XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAwLFxuICAgICAgICAgICAgKSA/PyBTdHJpbmcodmFsdWUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBTdHJpbmcodmFsdWUpO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBwdXNoID0gKGxldmVsOiBzdHJpbmcpID0+ICguLi5wYXJ0czogdW5rbm93bltdKSA9PiB7XG4gICAgICAgIGlmIChzaW5rLmxlbmd0aCA+PSBtYXhMb2dzKSB7XG4gICAgICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGxldCB0ZXh0ID0gcGFydHMubWFwKHN0cmluZ2lmeSkuam9pbignICcpO1xuICAgICAgICBpZiAodGV4dC5sZW5ndGggPiBtYXhMb2dMZW5ndGgpIHRleHQgPSBgJHt0ZXh0LnNsaWNlKDAsIG1heExvZ0xlbmd0aCl94oCmYDtcbiAgICAgICAgc2luay5wdXNoKHsgbGV2ZWwsIHRleHQsIGF0TXM6IERhdGUubm93KCkgLSBzdGFydGVkQXQgfSk7XG4gICAgfTtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb25zb2xlOiB7XG4gICAgICAgICAgICBsb2c6IHB1c2goJ2xvZycpLFxuICAgICAgICAgICAgaW5mbzogcHVzaCgnaW5mbycpLFxuICAgICAgICAgICAgd2FybjogcHVzaCgnd2FybicpLFxuICAgICAgICAgICAgZXJyb3I6IHB1c2goJ2Vycm9yJyksXG4gICAgICAgICAgICBkZWJ1ZzogcHVzaCgnZGVidWcnKSxcbiAgICAgICAgICAgIHRyYWNlOiBwdXNoKCdkZWJ1ZycpLFxuICAgICAgICAgICAgZGlyOiBwdXNoKCdsb2cnKSxcbiAgICAgICAgfSxcbiAgICAgICAgd2FzVHJ1bmNhdGVkOiAoKSA9PiB0cnVuY2F0ZWQsXG4gICAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDkuKTnp43miafooYznrZbnlaVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5sZXQgdm1Nb2R1bGU6IGFueSA9IG51bGw7XG5sZXQgdm1VbmF2YWlsYWJsZSA9IGZhbHNlO1xuXG4vKiog5ou/IGB2bWAg5qih5Z2X77yb5byV5pOO6L+b56iL6YeM5ou/5LiN5Yiw5bCx6L+U5ZueIG51bGzvvIjosIPnlKjmlrnlm57okL3liLAgbmV3IEZ1bmN0aW9u77yJICovXG5mdW5jdGlvbiBnZXRWbU1vZHVsZSgpOiBhbnkge1xuICAgIGlmICh2bU1vZHVsZSkgcmV0dXJuIHZtTW9kdWxlO1xuICAgIGlmICh2bVVuYXZhaWxhYmxlKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICBjb25zdCBtb2QgPSByZXF1aXJlKCd2bScpO1xuICAgICAgICBpZiAobW9kICYmIHR5cGVvZiBtb2QucnVuSW5UaGlzQ29udGV4dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdm1Nb2R1bGUgPSBtb2Q7XG4gICAgICAgICAgICByZXR1cm4gbW9kO1xuICAgICAgICB9XG4gICAgICAgIHZtVW5hdmFpbGFibGUgPSB0cnVlO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgdm1VbmF2YWlsYWJsZSA9IHRydWU7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn1cblxuLyoqXG4gKiDms6jlhaXnlKjnmoTllK/kuIDlhajlsYDlkI3jgIJcbiAqXG4gKiDkuLrku4DkuYjmmK/jgIzkuIDkuKrlkb3lkI3nqbrpl7TjgI3ogIzkuI3mmK/jgIzljYHlh6DkuKroo7jlhajlsYDjgI3vvJrop4Ege0BsaW5rIGJ1aWxkU2NlbmVTb3VyY2V944CCXG4gKi9cbmNvbnN0IElOSkVDVF9HTE9CQUxfS0VZID0gJ19fZHNoU2NlbmVDb250ZXh0JztcblxuLyoqXG4gKiDmnoTpgKDlrp7pmYXmiafooYznmoTmupDnoIHjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjopoHnu5Xov5nkuIDkuItcbiAqXG4gKiBgdm0ucnVuSW5UaGlzQ29udGV4dGAg55qE5Luj56CB55yL5LiN5Yiw5bGA6YOo5L2c55So5Z+f77yI6L+Z5q2j5piv5a6D6IO955WZ5Zyo5a6/5Li7IHJlYWxtIOeahOWOn+WboO+8ie+8jFxuICog5omA5Lul5YWo5bGA6YeP5b+F6aG757uP55SxIGBnbG9iYWxUaGlzYCDkvKDov5vljrvjgILmnIDnm7Top4nnmoTlgZrms5XmmK/mioogYGNjYCAvIGBjb25zb2xlYCAvIGBkdW1wYCDigKZcbiAqIOmAkOS4quaMguWIsCBgZ2xvYmFsVGhpc2Ag5LiK77yM5L2G6YKj5qC35pyJKirkuKTkuKrnnJ/lrp7ljbHlrrMqKu+8mlxuICpcbiAqIDEuICoq6YGu6JS95a6/5Li76Ieq5bex55qE5YWo5bGAKirvvJrms6jlhaXmnJ/pl7QgYGdsb2JhbFRoaXMuY29uc29sZWAg6KKr5o2i5oiQ5o2V6I6354mI77yMXG4gKiAgICDkuo7mmK/lvJXmk44v57yW6L6R5Zmo6Ieq5bex6L+Z5Yeg5q+r56eS77yI55Sa6Iez5byC5q2l6LaF5pe25ZCO6KKr5pS+5byD5Luj56CB6L+Y5rS7552A55qE5Yeg5Y2B56eS77yJ6YeM55qE5pel5b+XXG4gKiAgICDlhajooqvlkJ7ov5vmiJHku6znmoTnvJPlhrIg4oCU4oCUIOe8lui+keWZqOaOp+WItuWPsOS8muivoeW8guWcsOWuiemdmeS4i+adpeOAglxuICogICAgKu+8iOi/meS4quWdkeWunua1i+i4qeWIsOi/h++8mumqjOivgeiEmuacrOi3keWIsOS4gOWNiui+k+WHuua2iOWkse+8jOWwseaYr+Wug+OAgu+8iSpcbiAqIDIuICoq6KaB6L+Y5Y6f5Y2B5Yeg5Liq5ZCN5a2XKirvvIzku7vkvZXkuIDkuKrlkI3lrZflnKjlvJXmk47ph4zmmK/kuI3lj6/phY3nva7lsZ7mgKflsLHkvJrov5jljp/lpLHotKXvvIzplb/mnJ/msaHmn5PjgIJcbiAqXG4gKiDmlLnmiJDlj6rms6jlhaXkuIDkuKogYF9fZHNoU2NlbmVDb250ZXh0YO+8jOWGjeWcqOWMheijheWZqOmhtumDqOaKiuWug+eahOWtl+autSoq5Y+W5oiQ5bGA6YOoIGBsZXRgIOe7keWumioq77yaXG4gKiAtIGBnbG9iYWxUaGlzYCDlj6rooqvliqjkuIDkuKrlkI3lrZfvvIzov5jljp/mmK/ljp/lrZDnmoTjgIHlj6/ku6UqKueri+WIu+WBmioq77ybXG4gKiAtIOeUqOaIt+S7o+eggemHjOeahCBgY29uc29sZS5sb2dgIOi1sOWxgOmDqOe7keWumu+8jCoq55yf5q2j55qE5YWo5bGAIGNvbnNvbGUg5LuO5pyq6KKr56Kw6L+HKirvvJtcbiAqIC0g5bGA6YOo57uR5a6a5Zyo5byC5q2l5Ye95pWw5byA5aS05ZCM5q2l5rGC5YC877yM5omA5Lul5Y2z5L2/5ZCO6Z2iIGF3YWl0IOW+iOS5he+8jFxuICogICDooqvmlL7lvIPnmoTku6PnoIHkuZ/ku43nhLbmj6HnnYDoh6rlt7HnmoTlvJXnlKgg4oCU4oCUIOi/mOWOn+S4jeS8muaKiuWug+W8hOWdj+OAglxuICpcbiAqIOeUqCBgbGV0YCDogIzkuI3mmK8gYGNvbnN0YO+8mueUqOaIt+S7o+eggemHjOe7mei/meS6m+WQjeWtl+mHjeaWsOi1i+WAvOS4jeS8mueCuOOAglxuICog5Luj5Lu35piv55So5oi35Luj56CB5LiN6IO95YaN55SoIGBsZXQgY2MgPSAuLi5gIOmBruiUve+8iOS8muaKpemHjeWkjeWjsOaYju+8ieKAlOKAlCDkuI4gYG5ldyBGdW5jdGlvbmBcbiAqIOS8oOW9ouWPgueahOaXp+WGmeazlemZkOWItuS4gOiHtO+8jOWxnuS6juWPr+aOpeWPl+eahOe6puWumuOAglxuICpcbiAqIOKaoCDooYzlj7flgY/np7vvvJrnlKjmiLfku6PnoIHku47nrKwgMiDooYzlvIDlp4vvvIzmiYDku6XmiqXplJnooYzlj7fmr5TmupDnoIHooYzlj7flpKcgMeOAglxuICovXG5mdW5jdGlvbiBidWlsZFNjZW5lU291cmNlKGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBjb2RlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5hbWVzID0gT2JqZWN0LmtleXMoZ2xvYmFscyk7XG4gICAgLy8g5rOo5oSP77yaYGxldGAg5YWz6ZSu5a2X5Y+q6IO95Ye6546w5LiA5qyh44CC5YaZ5oiQIGBsZXQgYSA9IDEsIGxldCBiID0gMmAg5Lya5oqlXG4gICAgLy8gXCJsZXQgaXMgZGlzYWxsb3dlZCBhcyBhIGxleGljYWxseSBib3VuZCBuYW1lXCLvvIjouKnov4fvvInjgIJcbiAgICBjb25zdCBkZWNsYXJhdGlvbnMgPSBgbGV0ICR7bmFtZXMubWFwKChuYW1lKSA9PiBgJHtuYW1lfSA9IF9fZHNoQ3R4LiR7bmFtZX1gKS5qb2luKCcsICcpfWA7XG4gICAgcmV0dXJuIGAoYXN5bmMgKCkgPT4geyBjb25zdCBfX2RzaEN0eCA9IGdsb2JhbFRoaXMuJHtJTkpFQ1RfR0xPQkFMX0tFWX07ICR7ZGVjbGFyYXRpb25zfTtcXG4ke2NvZGV9XFxufSkoKTtgO1xufVxuXG50eXBlIEZpbmlzaEZuID0gKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbi8qKiDnrZbnlaXkuIDvvJpgdm0ucnVuSW5UaGlzQ29udGV4dGAg4oCU4oCUIOWQjCByZWFsbSArIOWQjOatpei2heaXtu+8iOmmlumAie+8iSAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuVmlhUnVuSW5UaGlzQ29udGV4dChcbiAgICB2bU1vZDogYW55LFxuICAgIGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIGNvZGU6IHN0cmluZyxcbiAgICB0aW1lb3V0TXM6IG51bWJlcixcbiAgICBmaW5pc2g6IEZpbmlzaEZuLFxuICAgIHN0YXRlOiB7IHNuYXBzaG90UmVxdWVzdGVkOiBib29sZWFuIH0sXG4pOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZ2xvYmFsVGhpcyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IGhhZFByZXZpb3VzID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGdsb2JhbFRoaXMsIElOSkVDVF9HTE9CQUxfS0VZKTtcbiAgICBjb25zdCBwcmV2aW91c1ZhbHVlID0gaGFkUHJldmlvdXMgPyB0YXJnZXRbSU5KRUNUX0dMT0JBTF9LRVldIDogdW5kZWZpbmVkO1xuXG4gICAgY29uc3QgcmVzdG9yZSA9ICgpOiB2b2lkID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChoYWRQcmV2aW91cykgdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXSA9IHByZXZpb3VzVmFsdWU7XG4gICAgICAgICAgICBlbHNlIGRlbGV0ZSB0YXJnZXRbSU5KRUNUX0dMT0JBTF9LRVldO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOi/mOWOn+Wksei0peS4jeiHtOWRve+8muS4i+S4gOasoeaJp+ihjOS8mumHjeaWsOimhuebliAqL1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXSA9IGdsb2JhbHM7XG4gICAgICAgIGNvbnN0IHJhdyA9IHZtTW9kLnJ1bkluVGhpc0NvbnRleHQoYnVpbGRTY2VuZVNvdXJjZShnbG9iYWxzLCBjb2RlKSwge1xuICAgICAgICAgICAgZmlsZW5hbWU6ICdkc2gtc2NlbmUtY29kZS5qcycsXG4gICAgICAgICAgICB0aW1lb3V0OiB0aW1lb3V0TXMsXG4gICAgICAgICAgICBkaXNwbGF5RXJyb3JzOiB0cnVlLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyDlkIzmraXmrrXlt7Lnu4/ot5HlrozvvIjnlKjmiLfku6PnoIHlvIDlpLTnmoQgbGV0IOe7keWumuW3sue7j+axguWAvO+8ie+8jFxuICAgICAgICAvLyDmiYDku6Xov5nph4zlj6/ku6Xnq4vliLvov5jljp8g4oCU4oCUIOWQjumdoueahOW8guatpeauteaMgeacieeahOaYr+iHquW3seeahOWxgOmDqOW8leeUqO+8jOS4jeWPl+W9seWTjeOAglxuICAgICAgICByZXN0b3JlKCk7XG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShyYXcpLFxuICAgICAgICAgICAgbmV3IFByb21pc2UoKF9yZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KHRpbWVvdXRFcnJvcih0aW1lb3V0TXMpKSwgdGltZW91dE1zKTtcbiAgICAgICAgICAgIH0pLFxuICAgICAgICBdKTtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiB0cnVlLCByZXN1bHQsIHNuYXBzaG90UmVxdWVzdGVkOiBzdGF0ZS5zbmFwc2hvdFJlcXVlc3RlZCB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogZXJyb3JJbmZvKGVyciksXG4gICAgICAgICAgICB0aW1lZE91dDogaXNUaW1lb3V0KGVyciksXG4gICAgICAgICAgICBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQsXG4gICAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzdG9yZSgpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDnrZbnlaXkuozvvJpgbmV3IEZ1bmN0aW9uYCDigJTigJQg5YWc5bqV44CCXG4gKlxuICog5YWo5bGA6YeP6LWwKirmmL7lvI/lvaLlj4IqKu+8jOS4jeeisCBgZ2xvYmFsVGhpc2DvvIzku7vkvZUgSlMg546v5aKD6YO96IO955So44CCXG4gKiDku6Pku7fvvJpgdGltZW91dGAg5Y+q55Sx5aSW5bGC6K6h5pe25Zmo5a6e546w77yMKirmjpDkuI3mlq3lkIzmraXmrbvlvqrnjq8qKuOAglxuICovXG5hc3luYyBmdW5jdGlvbiBydW5WaWFOZXdGdW5jdGlvbihcbiAgICBnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4gICAgZmluaXNoOiBGaW5pc2hGbixcbiAgICBzdGF0ZTogeyBzbmFwc2hvdFJlcXVlc3RlZDogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IG5hbWVzID0gT2JqZWN0LmtleXMoZ2xvYmFscyk7XG4gICAgY29uc3QgdmFsdWVzID0gbmFtZXMubWFwKChuKSA9PiBnbG9iYWxzW25dKTtcblxuICAgIGxldCBmbjogKC4uLmZuQXJnczogdW5rbm93bltdKSA9PiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICAgIGZuID0gbmV3IEZ1bmN0aW9uKC4uLm5hbWVzLCBgcmV0dXJuIChhc3luYyAoKSA9PiB7XFxuJHtjb2RlfVxcbn0pKCk7YCkgYXMgdHlwZW9mIGZuO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZmluaXNoKHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3JJbmZvKGVycikgfSk7XG4gICAgfVxuXG4gICAgbGV0IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICAgICAgUHJvbWlzZS5yZXNvbHZlKGZuKC4uLnZhbHVlcykpLFxuICAgICAgICAgICAgbmV3IFByb21pc2UoKF9yZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KHRpbWVvdXRFcnJvcih0aW1lb3V0TXMpKSwgdGltZW91dE1zKTtcbiAgICAgICAgICAgIH0pLFxuICAgICAgICBdKTtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiB0cnVlLCByZXN1bHQsIHNuYXBzaG90UmVxdWVzdGVkOiBzdGF0ZS5zbmFwc2hvdFJlcXVlc3RlZCB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogZXJyb3JJbmZvKGVyciksXG4gICAgICAgICAgICB0aW1lZE91dDogaXNUaW1lb3V0KGVyciksXG4gICAgICAgICAgICBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQsXG4gICAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTY2VuZUNvZGUoXG4gICAgcGF5bG9hZDogUnVuQ29kZVBheWxvYWQsXG4gICAgZGVwdGggPSAwLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgY29uc3QgbG9nczogU2NlbmVMb2dFbnRyeVtdID0gW107XG4gICAgY29uc3QgY29kZSA9IHR5cGVvZiBwYXlsb2FkLmNvZGUgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5jb2RlIDogJyc7XG4gICAgY29uc3QgbWF4TG9ncyA9IHR5cGVvZiBwYXlsb2FkLm1heExvZ3MgPT09ICdudW1iZXInID8gcGF5bG9hZC5tYXhMb2dzIDogMjAwO1xuICAgIGNvbnN0IG1heExvZ0xlbmd0aCA9IHR5cGVvZiBwYXlsb2FkLm1heExvZ0xlbmd0aCA9PT0gJ251bWJlcicgPyBwYXlsb2FkLm1heExvZ0xlbmd0aCA6IDQwMDA7XG4gICAgY29uc3QgdGltZW91dE1zID0gdHlwZW9mIHBheWxvYWQudGltZW91dE1zID09PSAnbnVtYmVyJyA/IHBheWxvYWQudGltZW91dE1zIDogMTUwMDA7XG5cbiAgICBjb25zdCB7IGNvbnNvbGU6IGNhcHR1cmVkQ29uc29sZSwgd2FzVHJ1bmNhdGVkIH0gPSBtYWtlQ2FwdHVyZWRDb25zb2xlKFxuICAgICAgICBsb2dzLFxuICAgICAgICBzdGFydGVkQXQsXG4gICAgICAgIG1heExvZ3MsXG4gICAgICAgIG1heExvZ0xlbmd0aCxcbiAgICApO1xuXG4gICAgY29uc3QgZmluaXNoID0gKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+ICh7XG4gICAgICAgIGxvZ3MsXG4gICAgICAgIGxvZ3NUcnVuY2F0ZWQ6IHdhc1RydW5jYXRlZCgpLFxuICAgICAgICBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRlZEF0LFxuICAgICAgICAuLi5leHRyYSxcbiAgICB9KTtcblxuICAgIGlmICghY29kZS50cmltKCkpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogJ2NvZGUg5LiN6IO95Li656m6JyB9IH0pO1xuICAgIH1cblxuICAgIGxldCBjYzogYW55O1xuICAgIHRyeSB7XG4gICAgICAgIGNjID0gZ2V0Q2MoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHsgaGVscGVycywgc3RhdGUgfSA9IG1ha2VIZWxwZXJzKGNjLCB7IHByb2plY3RQYXRoOiBwYXlsb2FkLnByb2plY3RQYXRoIH0pO1xuICAgIGNvbnN0IHNjZW5lID0gY3VycmVudFNjZW5lKGNjKTtcblxuICAgIC8vIHJlY2lwZSDkupTku7blpZcg4oCU4oCUIOS4jiBlZGl0b3Ig5LiK5LiL5paHKirlkIzkuIDku73lrp7njrAqKu+8iOi3qOi/m+eoiyByZXF1aXJlIGRpc3QvY29yZS9yZWNpcGVzLmpz77yJ44CCXG4gICAgLy8g5Yqg6L295aSx6LSl5LiN6K6p5pW05LiqIGV4ZWN1dGVfY29kZSDmjILmjonvvIzogIzmmK/pmY3nuqfmiJDjgIzkupTkuKrpg73ov5Tlm57plJnor6/jgI3jgIJcbiAgICBsZXQgcmVjaXBlSGVscGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVjaXBlcyA9IGdldFJlY2lwZXNNb2R1bGUoKTtcbiAgICAgICAgcmVjaXBlSGVscGVycyA9IHJlY2lwZXMuYnVpbGRSZWNpcGVIZWxwZXJzKHtcbiAgICAgICAgICAgIHByb2plY3RQYXRoOiBjdXJyZW50UHJvamVjdFBhdGgoKSxcbiAgICAgICAgICAgIGNvbnRleHQ6ICdzY2VuZScsXG4gICAgICAgICAgICBkZWZhdWx0VGltZW91dE1zOiB0aW1lb3V0TXMsXG4gICAgICAgICAgICAvLyDmg7DmgKfmi7/miafooYzlmajvvJpyZWNpcGUg5Yqp5omL6KaB6IO9XCLot5HkuIDmrrXku6PnoIFcIu+8jOiAjOmCo+auteS7o+eggeWPiOmcgOimgeWQjOagt+eahOWFqOWxgOmHj1xuICAgICAgICAgICAgLy8g77yI5YyF5ousIHJlY2lwZSDliqnmiYvoh6rlt7HvvInigJTigJQg5LqS55u45byV55So77yM5b+F6aG75pma57uR5a6a44CCXG4gICAgICAgICAgICBnZXRSdW5uZXI6ICgpID0+IGFzeW5jIChcbiAgICAgICAgICAgICAgICByZWNpcGVDb2RlOiBzdHJpbmcsXG4gICAgICAgICAgICAgICAgcmVjaXBlQXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgICAgICAgICAgbmVzdGVkVGltZW91dE1zOiBudW1iZXIsXG4gICAgICAgICAgICApID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXN0ZWQgPSBhd2FpdCBleGVjdXRlU2NlbmVDb2RlKFxuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb2RlOiByZWNpcGVDb2RlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJnczogcmVjaXBlQXJncyxcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIOW1jOWll+aJp+ihjOS4juacrOasoeaJp+ihjCoq5YWx5Lqr5aSW5bGCIHZtIOeahOWQjOatpei2heaXtumihOeulyoq77yI5aSW5bGCIHdhdGNoZG9nXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyDlt7Lnu4/lnKjorqHml7bkuobvvInvvIzmiYDku6XkuI3lhYHorrjlrZAgcmVjaXBlIOaKiui2heaXtuiuvuW+l+avlOWkluWxgui/mOmVvyDigJTigJRcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIOWQpuWImeaKpeWHuuadpeeahOaYr+WkluWxgueahOi2heaXtu+8jOaOkuafpeaXtuS4gOiEuOmXruWPt+OAglxuICAgICAgICAgICAgICAgICAgICAgICAgdGltZW91dE1zOiBNYXRoLm1pbihuZXN0ZWRUaW1lb3V0TXMsIHRpbWVvdXRNcyksXG4gICAgICAgICAgICAgICAgICAgICAgICBtYXhMb2dzLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWF4TG9nTGVuZ3RoLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBkZXB0aCArIDEsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAvLyByZWNpcGUg6YeM6LCDIHNuYXBzaG90KCkg5Lmf6KaB6IO955m76K6w5Yiw5pys5qyh5omn6KGM55qE5pKk6ZSA5b+r54Wn5LiKXG4gICAgICAgICAgICAgICAgaWYgKG5lc3RlZC5zbmFwc2hvdFJlcXVlc3RlZCkgc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5lc3RlZExvZ3MgPSBBcnJheS5pc0FycmF5KG5lc3RlZC5sb2dzKSA/IChuZXN0ZWQubG9ncyBhcyBTY2VuZUxvZ0VudHJ5W10pIDogW107XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgb2s6IEJvb2xlYW4obmVzdGVkLm9rKSxcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0OiBuZXN0ZWQucmVzdWx0LFxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogbmVzdGVkLmVycm9yLFxuICAgICAgICAgICAgICAgICAgICBsb2dzOlxuICAgICAgICAgICAgICAgICAgICAgICAgbmVzdGVkTG9ncy5sZW5ndGggPiAwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBuZXN0ZWRMb2dzLm1hcCgoZW50cnkpID0+IGBbJHtlbnRyeS5sZXZlbH1dICR7ZW50cnkudGV4dH1gKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBkdXJhdGlvbk1zOiB0eXBlb2YgbmVzdGVkLmR1cmF0aW9uTXMgPT09ICdudW1iZXInID8gbmVzdGVkLmR1cmF0aW9uTXMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIHRpbWVkT3V0OiBCb29sZWFuKG5lc3RlZC50aW1lZE91dCksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0pLmhlbHBlcnM7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvckluZm8oZXJyKS5tZXNzYWdlO1xuICAgICAgICBjb25zdCBmYWlsID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+ICh7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfSk7XG4gICAgICAgIHJlY2lwZUhlbHBlcnMgPSB7XG4gICAgICAgICAgICBmaW5kUmVjaXBlczogZmFpbCxcbiAgICAgICAgICAgIHJlYWRSZWNpcGU6IGZhaWwsXG4gICAgICAgICAgICBzYXZlUmVjaXBlOiBmYWlsLFxuICAgICAgICAgICAgcnVuUmVjaXBlOiBmYWlsLFxuICAgICAgICAgICAgZGVsZXRlUmVjaXBlOiBmYWlsLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBjYyxcbiAgICAgICAgY29jb3M6IGNjLFxuICAgICAgICBFZGl0b3IsXG4gICAgICAgIGRpcmVjdG9yOiBjYy5kaXJlY3RvcixcbiAgICAgICAgc2NlbmUsXG4gICAgICAgIGpzOiBjYy5qcyxcbiAgICAgICAgZmluZDogY2MuZmluZCxcbiAgICAgICAgYXJnczogcGF5bG9hZC5hcmdzICYmIHR5cGVvZiBwYXlsb2FkLmFyZ3MgPT09ICdvYmplY3QnID8gcGF5bG9hZC5hcmdzIDoge30sXG4gICAgICAgIGNvbnNvbGU6IGNhcHR1cmVkQ29uc29sZSxcbiAgICAgICAgLi4uaGVscGVycyxcbiAgICAgICAgLi4ucmVjaXBlSGVscGVycyxcbiAgICB9O1xuXG4gICAgLy8g6aaW6YCJIHZtLnJ1bkluVGhpc0NvbnRleHTvvIjlkIwgcmVhbG0gKyDlkIzmraXotoXml7bvvInvvJvlvJXmk47ov5vnqIvph4zmi7/kuI3liLAgdm0g5omN5Zue6JC944CCXG4gICAgLy8g5Lik5p2h6Lev5b6E5a+555So5oi35Luj56CB55qE5YaZ5rOV6KaB5rGC5a6M5YWo5LiA6Ie044CCXG4gICAgY29uc3Qgdm1Nb2QgPSBnZXRWbU1vZHVsZSgpO1xuICAgIGlmICh2bU1vZCkge1xuICAgICAgICByZXR1cm4gcnVuVmlhUnVuSW5UaGlzQ29udGV4dCh2bU1vZCwgZ2xvYmFscywgY29kZSwgdGltZW91dE1zLCBmaW5pc2gsIHN0YXRlKTtcbiAgICB9XG4gICAgcmV0dXJuIHJ1blZpYU5ld0Z1bmN0aW9uKGdsb2JhbHMsIGNvZGUsIHRpbWVvdXRNcywgZmluaXNoLCBzdGF0ZSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQVBJIOaPj+i/sO+8iGRpc2NvdmVyIOeahOS4gOWNiu+8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBEZXNjcmliZUFwaVBheWxvYWQge1xuICAgIHRhcmdldD86IHN0cmluZztcbiAgICBub2RlVXVpZD86IHN0cmluZztcbiAgICBsaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIOeUn+aIkOafkOS4quexu+eahOOAjFRTIOmjjuagvOWumuS5ieOAje+8jOW4puWunuaXtuWAvCAqL1xuZnVuY3Rpb24gZGVzY3JpYmVDbGFzcyhjYzogYW55LCBDbHM6IGFueSwgaW5zdGFuY2U6IGFueSwgY2xhc3NOYW1lOiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHByb3BzID0gY29tcG9uZW50UHJvcE5hbWVzKGluc3RhbmNlIHx8IHsgY29uc3RydWN0b3I6IENscyB9KTtcbiAgICBsZXQgcGFyZW50TmFtZSA9ICcnO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhcmVudCA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihDbHMucHJvdG90eXBlKTtcbiAgICAgICAgaWYgKHBhcmVudCAmJiBwYXJlbnQuY29uc3RydWN0b3IgJiYgcGFyZW50LmNvbnN0cnVjdG9yLm5hbWUpIHtcbiAgICAgICAgICAgIHBhcmVudE5hbWUgPSBwYXJlbnQuY29uc3RydWN0b3IubmFtZTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICBwYXJlbnROYW1lID0gJyc7XG4gICAgfVxuXG4gICAgbGluZXMucHVzaChgLy8gJHtjbGFzc05hbWV9JHtwYXJlbnROYW1lID8gYCAgZXh0ZW5kcyAke3BhcmVudE5hbWV9YCA6ICcnfWApO1xuICAgIGlmIChpbnN0YW5jZSkge1xuICAgICAgICBsaW5lcy5wdXNoKGAvLyDmnaXoh6rlrp7ml7blrp7kvovvvIjoioLngrkgJHtpbnN0YW5jZS5ub2RlID8gaW5zdGFuY2Uubm9kZS5uYW1lIDogJz8nfe+8iWApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGxpbmVzLnB1c2goJy8vIOacquaPkOS+myBub2RlVXVpZO+8jOaXoOWunuaXtuWAvO+8m+WxnuaAp+WQjeWPluiHquexu+WjsOaYjicpO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKGBleHBvcnQgY2xhc3MgJHtjbGFzc05hbWUuc3BsaXQoJy4nKS5wb3AoKX0ge2ApO1xuXG4gICAgY29uc3Qgc2hvd24gPSBwcm9wcy5zbGljZSgwLCBsaW1pdCk7XG4gICAgZm9yIChjb25zdCBrZXkgb2Ygc2hvd24pIHtcbiAgICAgICAgbGV0IHR5cGVOYW1lID0gJ2FueSc7XG4gICAgICAgIGxldCBjdXJyZW50ID0gJyc7XG4gICAgICAgIGlmIChpbnN0YW5jZSkge1xuICAgICAgICAgICAgY29uc3QgcmVhZCA9IHNhZmVSZWFkKGluc3RhbmNlLCBrZXkpO1xuICAgICAgICAgICAgaWYgKHJlYWQub2spIHtcbiAgICAgICAgICAgICAgICB0eXBlTmFtZSA9IGluZmVyVHNUeXBlKHJlYWQudmFsdWUpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnQgPSAoKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB2ID0gcmVhZC52YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHYgPT09IG51bGwgfHwgdiA9PT0gdW5kZWZpbmVkKSByZXR1cm4gU3RyaW5nKHYpO1xuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnW29iamVjdF0nO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBTdHJpbmcodik7XG4gICAgICAgICAgICAgICAgfSkoKTtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudC5sZW5ndGggPiA2MCkgY3VycmVudCA9IGAke2N1cnJlbnQuc2xpY2UoMCwgNjApfeKApmA7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbGluZXMucHVzaChgICAgICR7a2V5fTogJHt0eXBlTmFtZX07JHtjdXJyZW50ID8gYCAgLy8g5b2T5YmNID0gJHtjdXJyZW50fWAgOiAnJ31gKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLmxlbmd0aCA+IHNob3duLmxlbmd0aCkge1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLy8g4oCm5Y+m5pyJICR7cHJvcHMubGVuZ3RoIC0gc2hvd24ubGVuZ3RofSDkuKrlsZ7mgKdgKTtcbiAgICB9XG4gICAgbGluZXMucHVzaCgnfScpO1xuXG4gICAgLy8g5Y6f5Z6L5pa55rOV77ya5ZGK6K+JIEFJ44CM6L+Z5Liq57uE5Lu26IO96LCD5LuA5LmI44CNXG4gICAgY29uc3QgbWV0aG9kczogc3RyaW5nW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXMoQ2xzLnByb3RvdHlwZSkpIHtcbiAgICAgICAgICAgIGlmIChuYW1lID09PSAnY29uc3RydWN0b3InIHx8IHByb3BzLmluY2x1ZGVzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGxldCBpc0ZuID0gZmFsc2U7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlzRm4gPSB0eXBlb2YgQ2xzLnByb3RvdHlwZVtuYW1lXSA9PT0gJ2Z1bmN0aW9uJztcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGlzRm4gPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc0ZuKSBtZXRob2RzLnB1c2gobmFtZSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955WlICovXG4gICAgfVxuICAgIGlmIChtZXRob2RzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGluZXMucHVzaCgnJyk7XG4gICAgICAgIGxpbmVzLnB1c2goYC8vIOWPr+iwg+eUqOaWueazle+8iOWJjSAke01hdGgubWluKDYwLCBtZXRob2RzLmxlbmd0aCl9IOS4qu+8ie+8mmApO1xuICAgICAgICBsaW5lcy5wdXNoKGAvLyAke21ldGhvZHMuc2xpY2UoMCwgNjApLmpvaW4oJywgJyl9YCk7XG4gICAgfVxuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuLyoqIGBjY2Ag5qih5Z2X55qE6aG25bGC5a+85Ye65riF5Y2V77yI5aSn5YaZ5byA5aS05oiW5Ye95pWw77yM5aSf55So5p2l5b2T57Si5byV55So77yJICovXG5mdW5jdGlvbiBsaXN0Q2NFeHBvcnRzKGNjOiBhbnksIGxpbWl0OiBudW1iZXIpOiB7IHRvdGFsOiBudW1iZXI7IG5hbWVzOiBzdHJpbmdbXSB9IHtcbiAgICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhjYykpIHtcbiAgICAgICAgICAgIGlmICgvXltBLVpdLy50ZXN0KGtleSkgfHwgdHlwZW9mIGNjW2tleV0gPT09ICdmdW5jdGlvbicpIG5hbWVzLnB1c2goa2V5KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaUgKi9cbiAgICB9XG4gICAgcmV0dXJuIHsgdG90YWw6IG5hbWVzLmxlbmd0aCwgbmFtZXM6IG5hbWVzLnNsaWNlKDAsIGxpbWl0KSB9O1xufVxuXG4vKiog5Zy65pmv5L6n5oC76KeI6L296I2377yI5pegIHRhcmdldCDkuI4gdGFyZ2V0PT09J2NjJyDlhbHnlKjvvIkgKi9cbmZ1bmN0aW9uIGJ1aWxkU2NlbmVJbmRleChjYzogYW55LCBsaW1pdDogbnVtYmVyLCB3aXRoSGludDogYm9vbGVhbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBleHBvcnRzID0gbGlzdENjRXhwb3J0cyhjYywgbGltaXQpO1xuICAgIGNvbnN0IHsgaGVscGVycyB9ID0gbWFrZUhlbHBlcnMoY2MpO1xuXG4gICAgbGV0IHJlY2lwZUhlbHBlck5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIHRyeSB7XG4gICAgICAgIHJlY2lwZUhlbHBlck5hbWVzID0gKGdldFJlY2lwZXNNb2R1bGUoKS5SRUNJUEVfSEVMUEVSX1NJR05BVFVSRVMgYXMgc3RyaW5nW10pLm1hcCgoc2lnbmF0dXJlKSA9PlxuICAgICAgICAgICAgc2lnbmF0dXJlLnNsaWNlKDAsIHNpZ25hdHVyZS5pbmRleE9mKCcoJykpLFxuICAgICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZWNpcGVIZWxwZXJOYW1lcyA9IFtdO1xuICAgIH1cblxuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAga2luZDogJ2luZGV4JyxcbiAgICAgICAgaGVscGVyRnVuY3Rpb25zOiBPYmplY3Qua2V5cyhoZWxwZXJzKS5zb3J0KCksXG4gICAgICAgIHJlY2lwZUhlbHBlckZ1bmN0aW9uczogcmVjaXBlSGVscGVyTmFtZXMsXG4gICAgICAgIHJlY2lwZURpcjogcmVjaXBlc1Jvb3RIaW50KCksXG4gICAgICAgIGNjRXhwb3J0Q291bnQ6IGV4cG9ydHMudG90YWwsXG4gICAgICAgIGNjRXhwb3J0czogZXhwb3J0cy5uYW1lcyxcbiAgICB9O1xuICAgIGlmICh3aXRoSGludCkge1xuICAgICAgICBwYXlsb2FkLmhpbnQgPVxuICAgICAgICAgICAgJ+eUqCBkZXNjcmliZV9hcGkoeyBjb250ZXh0Olwic2NlbmVcIiwgdGFyZ2V0OlwiY2MuQ2FtZXJhXCIgfSkg55yL5p+Q5Liq57G755qE5a6a5LmJ77ybJyArXG4gICAgICAgICAgICAn5bimIG5vZGVVdWlkIOWImeeUqOiKgueCueS4iueahOWunuaXtuWunuS+i+ihpeWHuuecn+Wunuexu+Wei+S4juW9k+WJjeWAvOOAgicgK1xuICAgICAgICAgICAgJ2Rlc2NyaWJlX2FwaSh7IGNvbnRleHQ6XCJzY2VuZVwiLCB0YXJnZXQ6XCJoZWxwZXJzXCIgfSkg55yL5YWo6YOo5Yqp5omL5Ye95pWw562+5ZCN44CCJztcbiAgICB9XG4gICAgcmV0dXJuIHBheWxvYWQ7XG59XG5cbmZ1bmN0aW9uIGRlc2NyaWJlU2NlbmVBcGkoY2M6IGFueSwgcGF5bG9hZDogRGVzY3JpYmVBcGlQYXlsb2FkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHRhcmdldCA9IHR5cGVvZiBwYXlsb2FkLnRhcmdldCA9PT0gJ3N0cmluZycgPyBwYXlsb2FkLnRhcmdldC50cmltKCkgOiAnJztcbiAgICBjb25zdCBsaW1pdCA9IHR5cGVvZiBwYXlsb2FkLmxpbWl0ID09PSAnbnVtYmVyJyA/IE1hdGgubWF4KDEsIE1hdGgubWluKDUwMCwgcGF5bG9hZC5saW1pdCkpIDogODA7XG5cbiAgICAvLyAxKSDmsqHmnIkgdGFyZ2V077ya57uZ5Ye644CM6LW35omL5byP44CN5riF5Y2VICsgY2Mg5qih5Z2X55qE6aG25bGC5YWl5Y+jXG4gICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgcmV0dXJuIGJ1aWxkU2NlbmVJbmRleChjYywgbGltaXQsIHRydWUpO1xuICAgIH1cblxuICAgIC8vIDIpIOaYvuW8j+mXruWKqeaJi+WHveaVsFxuICAgIGlmICh0YXJnZXQgPT09ICdoZWxwZXJzJyB8fCB0YXJnZXQgPT09ICdoZWxwZXInKSB7XG4gICAgICAgIGNvbnN0IHsgaGVscGVycyB9ID0gbWFrZUhlbHBlcnMoY2MpO1xuICAgICAgICBjb25zdCBkb2NzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAgICAgbm9kZUJ5VXVpZDogJ25vZGVCeVV1aWQodXVpZCkg4oaSIE5vZGUgfCBudWxsJyxcbiAgICAgICAgICAgIG5vZGVCeVBhdGg6IFwibm9kZUJ5UGF0aCgnQ2FudmFzL1BhbmVsJykg4oaSIE5vZGUgfCBudWxsICAvLyDorqTlvpflkI3lrZfph4zlkKsgJy8nIOeahOiKgueCuVwiLFxuICAgICAgICAgICAgZWFjaE5vZGU6ICdlYWNoTm9kZSh2aXNpdCwgcm9vdD8sIHtpbmNsdWRlRWRpdG9yfT8pIOKGkiB2b2lkICAvLyDpu5jorqTot7Pov4fnvJbovpHlmaggZ2l6bW8nLFxuICAgICAgICAgICAgY29udGVudENoaWxkcmVuOiAnY29udGVudENoaWxkcmVuKG5vZGU/KSDihpIgTm9kZVtdICAvLyDnnJ/lrp7lhoXlrrnlrZDoioLngrnvvIjlt7Lmu6TmjonnvJbovpHlmajoo4XppbDvvIknLFxuICAgICAgICAgICAgaXNFZGl0b3JOb2RlOiAnaXNFZGl0b3JOb2RlKG5vZGUpIOKGkiBib29sZWFuICAvLyDmmK/kuI3mmK/nvJbovpHlmajoh6rlt7HnmoQgZ2l6bW8v572R5qC8L+WPguiAg+WbvicsXG4gICAgICAgICAgICB0cmVlOiAndHJlZSh7IHJvb3Q/LCBtYXhEZXB0aD8sIHdpdGhDb21wb25lbnRzPywgaW5jbHVkZUVkaXRvcj8gfSkg4oaSIOWxgue6p+mqqOaetuWvueixoScsXG4gICAgICAgICAgICBkdW1wOiAnZHVtcChub2RlT3JDb21wb25lbnQpIOKGkiDmmL7lvI/lj5blrZfmrrXlkI7nmoTnuq/mlbDmja7lr7nosaEnLFxuICAgICAgICAgICAgc25hcHNob3Q6ICdzbmFwc2hvdCgpIOKGkiB2b2lkICAvLyDmoIforrDmnKzmrKHmiafooYzopoHms6jlhozmkqTplIDlv6vnhacnLFxuICAgICAgICAgICAgc2xlZXA6ICdzbGVlcChtcykg4oaSIFByb21pc2UgIC8vIOi9ruivouetieW+hScsXG4gICAgICAgICAgICBjYXB0dXJlVmlldzpcbiAgICAgICAgICAgICAgICBcImNhcHR1cmVWaWV3KHsgc2F2ZVBhdGg/LCBtYXhXaWR0aD8sIGZvcm1hdD8sIHF1YWxpdHk/LCB3YWl0TXM/IH0pIOKGkiBQcm9taXNlPHtvaywgcGF0aD8sIGNodW5rcz8sIHdpZHRoLCBoZWlnaHQsIGJ5dGVzLCBibGFua1JhdGlvfT4gIC8vIOaIquWcuuaZr+inhuWbvuW9k+WJjeS4gOW4p++8iOWQq+e9keagvC9naXptb++8ieWtmOaIkCBwbmcvanBlZ1wiLFxuICAgICAgICAgICAgbG9hZEZyYW1lOlxuICAgICAgICAgICAgICAgIFwibG9hZEZyYW1lKCdkYjovL2Fzc2V0cy8uLi4veC5wbmcnIHwgJzx1dWlkPkBmOTk0MScgfCAnPHV1aWQ+Jykg4oaSIFByb21pc2U8U3ByaXRlRnJhbWU+ICAvLyDlj5blm77niYfnmoQgU3ByaXRlRnJhbWXvvJvliKvlho3miYvmkJMgQGY5OTQx77yM5Lmf5Yir55SoIGNjLnJlc291cmNlcy5sb2Fk77yI57yW6L6R5Zmo5Zy65pmv6YeM5b+F5aSx6LSl77yJXCIsXG4gICAgICAgICAgICB3b3JsZFJlY3Q6XG4gICAgICAgICAgICAgICAgJ3dvcmxkUmVjdChub2RlLCB7IHJvb3Q/IH0pIOKGkiB7Y3gsIGN5LCB3aWR0aCwgaGVpZ2h0LCBsZWZ0LCByaWdodCwgYm90dG9tLCB0b3B9ICAvLyDnvJbovpHmgIHlj6/kv6HnmoTkuJbnlYznn6nlvaLvvIhwb3NpdGlvbithbmNob3IrY29udGVudFNpemUg6Ieq5rS957Sv5Yqg77yJ77yb5Yir55SoIGdldEJvdW5kaW5nQm94VG9Xb3JsZCcsXG4gICAgICAgICAgICBjb250ZW50Qm91bmRzOlxuICAgICAgICAgICAgICAgICdjb250ZW50Qm91bmRzKCkg4oaSIHtsZWZ0LCByaWdodCwgYm90dG9tLCB0b3AsIGN4LCBjeSwgd2lkdGgsIGhlaWdodCwgY291bnQsIHV1aWRzfSAgLy8g5Zy65pmvKirnnJ/lrp7lhoXlrrkqKueahOS4lueVjOWMheWbtOebku+8iOW3sua7pOaOiee8lui+keWZqCBnaXptby/nvZHmoLzvvInvvJvmiKrlm77lj5bmma/ph4/nmoTlsLHmmK/lroMnLFxuICAgICAgICAgICAgcGljazogXCJwaWNrKHgsIHksIHsgc3BhY2U/LCByb290PywgbGltaXQ/IH0pIOKGkiB7IHZlcmRpY3QsIGhpdHNbXSwgaGl0LCBpbnZpc2libGVbXSwgZWRpdG9ySGl0c1tdLCB3b3JsZCwgcGFnZUNzcyB9ICAvLyAqKuS4gOS4quWxj+W5leeCueS4iuaYr+WTquS4quiKgueCuSoq44CCc3BhY2U6ICd2aWV3J++8iOmhtemdokNTU+WDj+e0oO+8jOm7mOiupO+8iS8ndXYn77yIMH4x77yM5oiq5Zu+57yp6L+H5bCx55So5a6D77yJLyd3b3JsZCfjgIJ2ZXJkaWN0PSdlZGl0b3Itb3ZlcmxheScgPSDpgqPph4zmsqHmnInku7vkvZXlhoXlrrnoioLngrnjgIHmmK/nvJbovpHlmaggZ2l6bW8g4oCU4oCUIOaIquWbvumHjOmCo+S4nOilv+S4jeWcqOWcuuaZr+aVsOaNrumHjO+8jOWIq+WOu+iKgueCueagkeaJvlwiLFxuICAgICAgICAgICAgbGFiZWxGaXQ6XG4gICAgICAgICAgICAgICAgJ2xhYmVsRml0KG5vZGUgfCB7dGV4dCxmb250U2l6ZSx3aWR0aCxoZWlnaHQsbGluZUhlaWdodCxvdmVyZmxvdyx3cmFwfSwgb3ZlcnJpZGU/KSDihpIgeyBmaXRzLCBsaW5lQ291bnQsIG1heExpbmVzRml0LCBjbGlwcGVkVGV4dCwgb3ZlcmZsb3dYLCBzaG9ydGZhbGxQeCwgbWV0aG9kLCBmb3JtdWxhIH0gIC8vICoq6L+Z5LiqIExhYmVsIOS8muS4jeS8muijgeWtlyoq44CC56ys5LqM5Y+C6KaG55uW5Lu75oSP5a2X5q61ID0g6Zeu5Y+N5LqL5a6e77yIbGFiZWxGaXQobiwge2hlaWdodDo3Mn0p77yJ77yMKirpm7blia/kvZznlKgqKu+8jOWIq+mdoOaUueecn+iKgueCuSvmiKrlm77or5UnLFxuICAgICAgICAgICAgc25hcHNob3RUcmVlOlxuICAgICAgICAgICAgICAgICdzbmFwc2hvdFRyZWUocm9vdD8sIHsgbGFiZWw/LCBzYXZlVG8/LCBtYXhOb2Rlcz8gfSkg4oaSIHtsYWJlbCwgbm9kZUNvdW50LCBoYXNoLCBrZXB0fSAgLy8g5ouN5LiA5Lu957qv5pWw5o2u5b+r54Wn77yI6ZSuPeiKgueCuSoq6Lev5b6EKirvvIzlrZjnm5jmjaIgdXVpZCDkuZ/kuI3lvbHlk43mr5Tlr7nvvInvvJvlrZjlnKjlnLrmma/ov5vnqIvph4zvvIzot6josIPnlKjov5jlnKgnLFxuICAgICAgICAgICAgZGlmZlRyZWU6XG4gICAgICAgICAgICAgICAgJ2RpZmZUcmVlKGJlZm9yZUxhYmVsLCBhZnRlckxhYmVsLCB7IGxpbWl0Pywgc2F2ZVRvPyB9KSDihpIge2NvdW50cywgY2hhbmdlZDpbe3BhdGgsIHByb3BzOntrOntmcm9tLHRvfX19XSwgYWRkZWQsIHJlbW92ZWQsIHN1c3BlY3RMZWFrc30gIC8vICoq5oiR5Yiw5bqV5pS55LqG5LuA5LmIKirvvJtzdXNwZWN0TGVha3MgPSDmlrDlop7oioLngrnph4zlkI3lrZflg4/kuLTml7bmjqLpkojnmoQnLFxuICAgICAgICAgICAgaGVscGVyTmFtZXM6ICdoZWxwZXJOYW1lcygpIOKGkiBzdHJpbmdbXScsXG4gICAgICAgIH07XG4gICAgICAgIGxldCByZWNpcGVIZWxwZXJzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc2lnbmF0dXJlOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZSA9IGdldFJlY2lwZXNNb2R1bGUoKTtcbiAgICAgICAgICAgIHJlY2lwZUhlbHBlcnMgPSAobW9kdWxlLlJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyBhcyBzdHJpbmdbXSkubWFwKChzaWduYXR1cmUpID0+ICh7XG4gICAgICAgICAgICAgICAgbmFtZTogc2lnbmF0dXJlLnNsaWNlKDAsIHNpZ25hdHVyZS5pbmRleE9mKCcoJykpLFxuICAgICAgICAgICAgICAgIHNpZ25hdHVyZSxcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZWNpcGVIZWxwZXJzID0gW107XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAga2luZDogJ2hlbHBlcnMnLFxuICAgICAgICAgICAgaGVscGVyczogW1xuICAgICAgICAgICAgICAgIC4uLk9iamVjdC5rZXlzKGhlbHBlcnMpXG4gICAgICAgICAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgobmFtZSkgPT4gKHsgbmFtZSwgc2lnbmF0dXJlOiBkb2NzW25hbWVdIHx8IG5hbWUgfSkpLFxuICAgICAgICAgICAgICAgIC4uLnJlY2lwZUhlbHBlcnMsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVjaXBlRGlyOiByZWNpcGVzUm9vdEhpbnQoKSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyAzKSDop6PmnpAgY2MuWHh4Lll5eVxuICAgIGNvbnN0IHBhcnRzID0gdGFyZ2V0LnNwbGl0KCcuJykuZmlsdGVyKEJvb2xlYW4pO1xuICAgIGlmIChwYXJ0c1swXSAhPT0gJ2NjJykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGBzY2VuZSDkuIrkuIvmloflj6rorqQgJ2NjLionIOaIliAnaGVscGVycyfvvIzmlLbliLDvvJoke3RhcmdldH1gLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIOaOkOaOieW8gOWktOeahCAnY2Mn77ya6LW354K55pys5p2l5bCx5pivIGNjIOaooeWdl++8jOiuqSBwYXJ0c1swXSDlho3otbDkuIDmrKHkvJrlj5bliLAgYGNjLmNjYO+8iHVuZGVmaW5lZO+8ie+8jFxuICAgIC8vIOS6juaYr+aJgOaciSAnY2MuWHh4JyDpg73kvJror6/miqXjgIzlnKggWHh4IOWkhOaWremTvuOAje+8iOi4qei/h++8ieOAglxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhcnRzLnNsaWNlKDEpO1xuICAgIGlmIChwYXRoUGFydHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiBidWlsZFNjZW5lSW5kZXgoY2MsIGxpbWl0LCBmYWxzZSk7XG4gICAgfVxuXG4gICAgbGV0IG5vZGU6IGFueSA9IGNjO1xuICAgIGZvciAoY29uc3QgcGFydCBvZiBwYXRoUGFydHMpIHtcbiAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fe+8iOWcqCAke3BhcnR9IOWkhOaWremTvu+8iWAgfTtcbiAgICAgICAgfVxuICAgICAgICBub2RlID0gKG5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW3BhcnRdO1xuICAgIH1cbiAgICBpZiAobm9kZSA9PT0gbnVsbCB8fCBub2RlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsCAke3RhcmdldH1gIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBub2RlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIOS4jeaYr+exu++8muebtOaOpeaPj+i/sOi/meS4quWAvFxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBraW5kOiAndmFsdWUnLFxuICAgICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgICAgdHlwZTogaW5mZXJUc1R5cGUobm9kZSksXG4gICAgICAgICAgICB0ZXh0OiBkZXNjcmliZUNsYXNzKGNjLCBub2RlLmNvbnN0cnVjdG9yIHx8IE9iamVjdCwgbnVsbCwgdGFyZ2V0LCBsaW1pdCksXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gNCkg5piv57G7IOKAlOKAlCDkvJjlhYjnlKjoioLngrnkuIrnmoTlrp7ml7blrp7kvovooaXnsbvlnotcbiAgICBsZXQgaW5zdGFuY2U6IGFueSA9IG51bGw7XG4gICAgbGV0IGluc3RhbmNlTm90ZSA9ICcnO1xuICAgIGlmIChwYXlsb2FkLm5vZGVVdWlkKSB7XG4gICAgICAgIGNvbnN0IHNjZW5lID0gY3VycmVudFNjZW5lKGNjKTtcbiAgICAgICAgY29uc3QgaG9zdCA9IHNjZW5lID8gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQocGF5bG9hZC5ub2RlVXVpZCkgOiBudWxsO1xuICAgICAgICBpZiAoaG9zdCkge1xuICAgICAgICAgICAgaW5zdGFuY2UgPSBob3N0LmdldENvbXBvbmVudChub2RlKTtcbiAgICAgICAgICAgIGlmICghaW5zdGFuY2UpIGluc3RhbmNlTm90ZSA9IGDoioLngrkgJHtob3N0Lm5hbWV9IOS4iuayoeaciSAke3RhcmdldH0g57uE5Lu2YDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGluc3RhbmNlTm90ZSA9IGDmib7kuI3liLDoioLngrkgJHtwYXlsb2FkLm5vZGVVdWlkfWA7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAga2luZDogJ2NsYXNzJyxcbiAgICAgICAgdGFyZ2V0LFxuICAgICAgICBjbGFzc05hbWU6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYy5qcy5nZXRDbGFzc05hbWUobm9kZSk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGFyZ2V0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSgpLFxuICAgICAgICBpbnN0YW5jZUZvdW5kOiBCb29sZWFuKGluc3RhbmNlKSxcbiAgICAgICAgbm90ZTogaW5zdGFuY2VOb3RlIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgZGVmaW5pdGlvbjogZGVzY3JpYmVDbGFzcyhjYywgbm9kZSwgaW5zdGFuY2UsIHRhcmdldCwgbGltaXQpLFxuICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5a+55aSW5pa55rOVXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IHsgW2tleTogc3RyaW5nXTogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnkgfSA9IHtcbiAgICAvKiog5o6i5rS777ya5Li76L+b56iL55So5a6D5Yik5pat5Zy65pmv6ISa5pys5piv5ZCm5bey5Yqg6L29ICovXG4gICAgcGluZygpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRzOiBEYXRlLm5vdygpIH07XG4gICAgfSxcblxuICAgIC8qKiDlnKjlvJXmk47kuIrkuIvmlofmiafooYznlKjmiLfku6PnoIEgKi9cbiAgICBhc3luYyBydW5Db2RlKHBheWxvYWQ6IFJ1bkNvZGVQYXlsb2FkKSB7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVDb2RlKHBheWxvYWQgfHwge30pO1xuICAgIH0sXG5cbiAgICAvKiog5riQ6L+b5byP5oqr6Zyy77ya5o+P6L+w5byV5pOOIEFQSSAqL1xuICAgIGFzeW5jIGRlc2NyaWJlQXBpKHBheWxvYWQ6IERlc2NyaWJlQXBpUGF5bG9hZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2MgPSBnZXRDYygpO1xuICAgICAgICAgICAgcmV0dXJuIGRlc2NyaWJlU2NlbmVBcGkoY2MsIHBheWxvYWQgfHwge30pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5Zy65pmv6KeG5Zu+5Yeg5L2VIOKAlOKAlCAqKuaIquWbvumTvui3r+mHjOOAjOmHj+OAjeeahOmCo+S4gOWNiioq77yI6KeB5paH5Lu26YeMIGBwcm9qZWN0Tm9kZVJlY3RgIOS4gOiKgu+8ieOAglxuICAgICAqXG4gICAgICog5Li76L+b56iL55qEIEVsZWN0cm9uIOaIquWbvuimgemdoOWug++8muKRoCDmjIkgYHBhZ2UuaHJlZmAg57K+56Gu5a6a5L2N5Zy65pmv6KeG5Zu+6YKj5LiqIHdlYkNvbnRlbnRz77ybXG4gICAgICog4pGhIOaMiSBgcGFnZS9jc3NgIOaKiuWbvueJh+WDj+e0oOaNouaIkCBDU1Mg5YOP57Sg77yb4pGiIOimgeaIquafkOS4quiKgueCueaXtu+8jOeUqCBgbm9kZS5yZWN0YCDoo4HvvJtcbiAgICAgKiDikaMg5bim5LqGIGBmaXRgIOaXtui/mOimgeWbnuetlOOAjOebruagh+aLjeWFqOS6huayoeacieOAje+8iGBmcmFtaW5nYO+8ieOAglxuICAgICAqL1xuICAgIGFzeW5jIHZpZXdNZXRyaWNzKHBheWxvYWQ6IFZpZXdNZXRyaWNzUGF5bG9hZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2MgPSBnZXRDYygpO1xuICAgICAgICAgICAgcmV0dXJuIGNvbGxlY3RWaWV3TWV0cmljcyhjYywgcGF5bG9hZCB8fCB7fSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3JJbmZvKGVycikgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cblxuICAgIC8qKlxuICAgICAqIOWPluaZryAvIOi/mOWOn+inhuinkiDigJTigJQgKirmiKrlm77pk77ot6/ph4zjgIzmkYbnm7jmnLrjgI3nmoTpgqPkuIDljYoqKu+8iOingeaWh+S7tumHjOOAjOWPluaZr+OAjeS4gOiKgu+8ieOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI55Sx5Li76L+b56iL6amx5Yqo6ICM5LiN5piv6L+Z6YeM5LiA5oqK5qKt77ya5pGG5a6M5LiA5q2l6KaBKirph4/kuIDmrKEqKu+8iOimhuebluWkn+S4jeWkn++8ieOAgeS4jeWkn+WGjemZjee6p+aRhuS4i+S4gOatpSDigJTigJRcbiAgICAgKiDph4/nmoTliKTmja7vvIhgdmlld01ldHJpY3MuZnJhbWluZ2DvvInkuI7nm7jmnLrpg73lnKjov5nkuIDkvqfvvIzogIzjgIzmkYblk6rkuIDnuqfjgIHopoHkuI3opoHnu6fnu63jgI3mmK/kuLvov5vnqIvnmoTlhrPlrprjgIJcbiAgICAgKlxuICAgICAqIOKaoCDmm77nu4/ov5nph4zov5jphY3nnYDkuIDlj6XjgIzkuLvov5vnqIsgYGludmFsaWRhdGUoKWAg6YC85LiA5bin5YaN6YeP44CN44CCKirpgqPkuIDlj6Xlt7LmlbTkvZPmkqTmjokqKlxuICAgICAqIO+8iDIwMjYtMTAtMDgg5Y+j5b6E77ya5pys5omp5bGV5LiN56Kw5ZCI5oiQ5Zmo77yM6KeBIGBzb3VyY2UvY2FwdHVyZS50c2Ag5paH5Lu25aS077yJ44CC5Luj5Lu35aaC5a6e6K+077yaXG4gICAgICog55u45py65Yia5Yqo5a6M5bCx6YeP77yM6K+75Yiw55qEKirlj6/og73mmK/ph43nlLvliY3nmoTpgqPkuIDluKcqKiDigJTigJQg5omA5Lul5Li76L+b56iL6YKj6L656Z2gKirlpJrph4/lh6Dova4qKuOAgVxuICAgICAqIOiAjOS4jeaYr+mdoOmAvOS4gOW4p+adpVwi5L+d6K+B5paw6bKcXCLjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXlsb2FkIC0gYHthY3Rpb24sIHN0ZXA/LCBmaXQ/LCBub2RlPywgcHJvamVjdFBhdGg/fWDvvJpcbiAgICAgKiAgIGBhY3Rpb246J2ZpdCdgIOaRhuesrCBgc3RlcGAg57qn5Y+W5pmv77yIMCA9IOe8lui+keWZqCBmb2N1cyAvIDEgPSDmjqfliLblmajpgILphY0gLyAyID0g5omL5bel77yJ77yMXG4gICAgICogICBgYWN0aW9uOidlbmQnYCDov5jljp/op4bop5LjgIJcbiAgICAgKiBAcmV0dXJucyBge29rLCB0b2tlbiwgc3RlcCwgbWV0aG9kLCBuZXh0U3RlcCwgc2F2ZWQsIGNhbWVyYX1g77ybXG4gICAgICogICBgYWN0aW9uOidlbmQnYCDlm54gYHtvaywgcmVzdG9yZWQsIG1ldGhvZCwgYWZ0ZXJ9YCDigJTigJQgKirov5jljp/lpLHotKXkvJrlpoLlrp7lm54gYHJlc3RvcmVkOmZhbHNlYCoq44CCXG4gICAgICpcbiAgICAgKiDimqAg5ZCM5LiA5pe25Yi75Y+q55WZ5LiA5Lu95b6F6L+Y5Y6f55qE6KeG6KeS77yI5oiq5Zu+5piv5Liy6KGM55qE77yJ77yb5LiA5Lu96LaF6L+HIDYwcyDmsqHooqvov5jljp/lsLHlvZPlroPkvZzlup9cbiAgICAgKiDvvIjliKvmiorlh6DliIbpkp/liY3nmoTml6fop4bop5Lnm5blm57nlKjmiLfohLjkuIrvvInjgIJcbiAgICAgKi9cbiAgICBhc3luYyBmaXRWaWV3KHBheWxvYWQ6IEZpdFZpZXdQYXlsb2FkKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYyA9IGdldENjKCk7XG4gICAgICAgICAgICBjb25zdCBjYW1lcmEgPSBlZGl0b3JDYW1lcmEoKTtcbiAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHBheWxvYWQgJiYgcGF5bG9hZC5hY3Rpb24gPT09ICdlbmQnID8gJ2VuZCcgOiAnZml0JztcblxuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ2VuZCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXBlbmRpbmdGaXQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfmsqHmnInlvoXov5jljp/nmoTop4bop5LvvIjlj6/og73lt7Lnu4/ooqvov5jljp/ov4fkuobvvIknIH07XG4gICAgICAgICAgICAgICAgaWYgKCFjYW1lcmEuY2FtIHx8ICFjYW1lcmEubWFuYWdlcikge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhYmFuZG9uZWQgPSBwZW5kaW5nRml0O1xuICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRml0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogY2FtZXJhLm5vdGUgfHwgJ+e8lui+keWZqOebuOacuuS4jeWPr+eUqO+8jOi/mOS4jeS6huWOnycsIHRva2VuOiBhYmFuZG9uZWQudG9rZW4gfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBwZW5kaW5nRml0O1xuICAgICAgICAgICAgICAgIHBlbmRpbmdGaXQgPSBudWxsO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3RvcmVkID0gcmVzdG9yZUNhbWVyYVN0YXRlKGNhbWVyYS5tYW5hZ2VyLCBjYW1lcmEuY2FtLCBzdGF0ZS5zYXZlZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHRva2VuOiBzdGF0ZS50b2tlbixcbiAgICAgICAgICAgICAgICAgICAgcmVzdG9yZWQ6IHJlc3RvcmVkLnJlc3RvcmVkLFxuICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IHJlc3RvcmVkLm1ldGhvZCxcbiAgICAgICAgICAgICAgICAgICAgYWZ0ZXI6IHJlc3RvcmVkLmFmdGVyLFxuICAgICAgICAgICAgICAgICAgICBleHBlY3RlZDogc3RhdGUuc2F2ZWQuc2lnbmF0dXJlLFxuICAgICAgICAgICAgICAgICAgICBub3RlOiByZXN0b3JlZC5ub3RlLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FtZXJhLmNhbSB8fCAhY2FtZXJhLm1hbmFnZXIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBjYW1lcmEubm90ZSB8fCAn57yW6L6R5Zmo55u45py65LiN5Y+v55So77yM5Y+W5LiN5LqG5pmvJyB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgc3RlcCA9IGNsYW1wTnVtYmVyKHBheWxvYWQgJiYgcGF5bG9hZC5zdGVwLCAwLCAyLCAwKTtcbiAgICAgICAgICAgIGNvbnN0IHNwZWMgPSBub3JtYWxpemVGaXRTcGVjKHBheWxvYWQgJiYgcGF5bG9hZC5maXQpO1xuICAgICAgICAgICAgaWYgKCFzcGVjKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgZml0VmlldyDkuI3orqTlvpcgZml0IOWPguaVsO+8miR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCAmJiBwYXlsb2FkLmZpdCl9YCB9O1xuXG4gICAgICAgICAgICBjb25zdCBoZWxwZXJzID0gbWFrZUhlbHBlcnMoY2MsIHtcbiAgICAgICAgICAgICAgICBwcm9qZWN0UGF0aDogdHlwZW9mIHBheWxvYWQucHJvamVjdFBhdGggPT09ICdzdHJpbmcnID8gcGF5bG9hZC5wcm9qZWN0UGF0aCA6ICcnLFxuICAgICAgICAgICAgfSkuaGVscGVycyBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICAgICAgY29uc3QgcmVmID0gc3BlYy5raW5kID09PSAnbm9kZScgPyBzcGVjLnJlZiB8fCAodHlwZW9mIHBheWxvYWQubm9kZSA9PT0gJ3N0cmluZycgPyBwYXlsb2FkLm5vZGUudHJpbSgpIDogJycpIDogJyc7XG4gICAgICAgICAgICBsZXQgbm9kZTogYW55ID0gbnVsbDtcbiAgICAgICAgICAgIGlmIChyZWYpIHtcbiAgICAgICAgICAgICAgICBub2RlID0gaGVscGVycy5ub2RlQnlVdWlkKHJlZikgfHwgaGVscGVycy5ub2RlQnlQYXRoKHJlZikgfHwgbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IGZpdFRhcmdldE9mKGhlbHBlcnMsIHNwZWMsIG5vZGUpO1xuXG4gICAgICAgICAgICAvKiog6KeG6KeS5Y+q5a2YKirkuIDmrKEqKu+8iOesrOS4gOasoeWPluaZr+S5i+WJje+8ieKAlOKAlCDlkI7pnaLlh6DnuqfpmY3nuqfpg73lnKjlkIzkuIDkuKrljp/lp4vop4bop5LkuYvkuIogKi9cbiAgICAgICAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICAgICAgICBjb25zdCBzdGFsZSA9IEJvb2xlYW4ocGVuZGluZ0ZpdCkgJiYgbm93IC0gKHBlbmRpbmdGaXQgYXMgeyBzdGFydGVkQXQ6IG51bWJlciB9KS5zdGFydGVkQXQgPiBGSVRfU1RBVEVfVFRMX01TO1xuICAgICAgICAgICAgY29uc3Qgc2F2ZWQgPSBwZW5kaW5nRml0ICYmICFzdGFsZSA/IHBlbmRpbmdGaXQuc2F2ZWQgOiBzYXZlQ2FtZXJhU3RhdGUoY2FtZXJhLm1hbmFnZXIsIGNhbWVyYS5jYW0pO1xuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBwZW5kaW5nRml0ICYmICFzdGFsZSA/IHBlbmRpbmdGaXQudG9rZW4gOiBgZml0LSR7bm93fS0keyhmaXRDb3VudGVyICs9IDEpfWA7XG5cbiAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSBhcHBseUZpdFN0ZXAoY2MsIGNhbWVyYS5tYW5hZ2VyLCBjYW1lcmEuY2FtLCBzdGVwLCB0YXJnZXQsIGNhbWVyYS5pczJEKTtcbiAgICAgICAgICAgIHBlbmRpbmdGaXQgPSB7IHRva2VuLCBzYXZlZCwgc3RhcnRlZEF0OiBub3cgfTtcblxuICAgICAgICAgICAgY29uc3QgbWF4U3RlcCA9IG1heEZpdFN0ZXBzKGNhbWVyYS5pczJEKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IGFwcGxpZWQubWV0aG9kICE9PSBudWxsLFxuICAgICAgICAgICAgICAgIHRva2VuLFxuICAgICAgICAgICAgICAgIHN0ZXAsXG4gICAgICAgICAgICAgICAgbWV0aG9kOiBhcHBsaWVkLm1ldGhvZCxcbiAgICAgICAgICAgICAgICBub3RlOiBhcHBsaWVkLm5vdGUsXG4gICAgICAgICAgICAgICAgZGV0YWlsOiBhcHBsaWVkLmRldGFpbCxcbiAgICAgICAgICAgICAgICAvKiog5LiL5LiA57qn77yI5rKh5pyJ5bCxIG51bGzvvInigJTigJQg5Li76L+b56iL5oyJ5a6D5Yaz5a6a6KaB5LiN6KaB57un57ut6ZmN57qnICovXG4gICAgICAgICAgICAgICAgbmV4dFN0ZXA6IGFwcGxpZWQubWV0aG9kICE9PSBudWxsICYmIHN0ZXAgKyAxIDwgbWF4U3RlcCA/IHN0ZXAgKyAxIDogbnVsbCxcbiAgICAgICAgICAgICAgICBtYXhTdGVwLFxuICAgICAgICAgICAgICAgIGlzMkQ6IGNhbWVyYS5pczJELFxuICAgICAgICAgICAgICAgIHJlcGxhY2VkU3RhbGU6IHN0YWxlLFxuICAgICAgICAgICAgICAgIHRhcmdldDogeyBraW5kOiBzcGVjLmtpbmQsIHJlZjogcmVmIHx8IG51bGwsIHNvdXJjZTogdGFyZ2V0LnNvdXJjZSwgdXVpZHM6IHRhcmdldC51dWlkcy5sZW5ndGgsIHdvcmxkOiB0YXJnZXQud29ybGQgfSxcbiAgICAgICAgICAgICAgICAvKiog5Y6f5aeL6KeG6KeS77yI6L+Y5Y6f55qE5Yet5o2u77yJ4oCU4oCUIOWbnuaJp+mHjOW4puS4iu+8jOeUqOaIt+iDveaguOWvuVwi56Gu5a6e6L+Y5Zue5Y675LqGXCIgKi9cbiAgICAgICAgICAgICAgICBzYXZlZDogeyBoYXNJbmZvOiBCb29sZWFuKHNhdmVkLmluZm8pLCBzaWduYXR1cmU6IHNhdmVkLnNpZ25hdHVyZSB9LFxuICAgICAgICAgICAgICAgIGNhbWVyYTogY2FtZXJhU2lnbmF0dXJlKGNhbWVyYS5jYW0pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBlcnJvckluZm8oZXJyKSB9O1xuICAgICAgICB9XG4gICAgfSxcbn07XG4iXX0=