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
        const record = { label, tree, hash: hashOf(json), bytes: json.length, at: tree.at };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOENHOzs7QUFFSCwrQkFBNEI7QUFPNUIsU0FBUyxZQUFZLENBQUMsRUFBVTtJQUM1QixNQUFNLEdBQUcsR0FBRyxJQUFJLEtBQUssQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUEwQixDQUFDO0lBQ3BFLEdBQUcsQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLE9BQU8sR0FBRyxDQUFDO0FBQ2YsQ0FBQztBQUVEOzs7Ozs7Ozs7O0dBVUc7QUFDSCxTQUFTLFNBQVMsQ0FBQyxHQUFZO0lBQzNCLElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ2xELE1BQU0sTUFBTSxHQUFHLEdBQW9FLENBQUM7SUFDcEYsSUFBSSxNQUFNLENBQUMsWUFBWTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3JDLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyw4QkFBOEI7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNoRSxPQUFPLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRLElBQUksNkJBQTZCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNwRyxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsR0FBWTtJQUMzQixJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNqQyxNQUFNLE1BQU0sR0FBRyxHQUE2RCxDQUFDO1FBQzdFLE9BQU87WUFDSCxJQUFJLEVBQUUsT0FBTyxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTztZQUM3RCxP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QUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDL0MsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUNQLElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDN0IsSUFBSSxDQUFDO2dCQUFFLEdBQUcsQ0FBQyxRQUFRLEdBQUcsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQzdFLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztRQUNELElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDN0IsSUFBSSxDQUFDO2dCQUFFLEdBQUcsQ0FBQyxRQUFRLEdBQUcsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQzdGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxRQUFRO1FBQ1osQ0FBQztJQUNMLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ3RELElBQUksV0FBVyxLQUFLLElBQUk7UUFBRSxHQUFHLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztJQUN4RCxNQUFNLEdBQUcsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLElBQUksR0FBRyxL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QUMsRUFBRSxDQUFDLENBQUM7UUFDdkMsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLEdBQUcsV0FBVyxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNyRCxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFBRSxHQUFHLFdBQVcsQ0FBQyxDQUFDO1FBQ3JELElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDbkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUM7UUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUM7UUFDdkMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN0RixPQUFPLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFLENBQUM7SUFDbEMsQ0FBQyxDQUFDO0lBRUYsTUFBTSxLQUFLLEdBQUcsS0FBSyxFQUFFLENBQUM7SUFDdEIsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsdUNBQXVDLEVBQUUsQ0FBQztJQUVoRiw0QkFBNEI7SUFDNUIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FDbEIsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsS0FBSyxH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LENBQUM7WUFDNUIsTUFBTSxLQUFLLEdBQTRCLEVBQUUsQ0FBQztZQUMxQyxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBUyxDQUFDLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3JFLEtBQUssTUFBTSxJQUFJLElBQUksSUFBSSxFQUFFLENBQUM7Z0JBQ3RCLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ25DLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ25DLElBQUksRUFBRSxLQUFLLEVBQUU7b0JBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQzlILENBQUM7WUFDRCxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUM7Z0JBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQzs7Z0JBQ2pFLFNBQVMsSUFBSSxDQUFDLENBQUM7UUFDeEIsQ0FBQztRQUNELEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7WUFBRSxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDO2dC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TSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssRUFBRTtnQkFDckgsd0NBQXdDO2dCQUN4QyxLQUFLLEVBQUUsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVMsRUFBRTtnQkFDbkUsTUFBTSxFQUFFLGVBQWUsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDO2FBQ3RDLENBQUM7UUFDTixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNYLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoRCxDQUFDO0lBQ0wsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOWcuuaZr+i/m+eoi+iEmuacrCDigJTigJQgQ29kZSBNb2RlIOeahOOAjOW8leaTjuS+p+aJp+ihjOWZqOOAjeOAglxuICpcbiAqIOi/meS4quaWh+S7tui3keWcqCAqKuW8leaTjuWcuuaZr+i/m+eoiyoqIOmHjO+8iOS4jeaYr+aJqeWxleS4u+i/m+eoi++8ie+8jOaJgOS7peiDveebtOaOpeaLv+WIsCBgY2NgIOaooeWdl++8mlxuICogYE5vZGVgIC8gYENvbXBvbmVudGAgLyBgQXNzZXRgIC8gYGRpcmVjdG9yYCAvIOWcuuaZr+agke+8jOWFqOaYr+ecn+eahOi/kOihjOaXtuWvueixoeOAglxuICpcbiAqIOS4u+i/m+eoi+mAmui/h1xuICogYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0JywgeyBuYW1lLCBtZXRob2QsIGFyZ3MgfSlgXG4gKiDosIPliLDov5nph4zvvIjop4EgY29yZS9zY2VuZS1icmlkZ2UudHPvvInjgIJcbiAqXG4gKiAjIyDmiafooYznrZbnlaXvvJpgdm0ucnVuSW5UaGlzQ29udGV4dGAg5LyY5YWI77yMYG5ldyBGdW5jdGlvbmAg5YWc5bqVXG4gKlxuICog6L+Z6YeM5pyJ5LiqKirlv4XpobvorrLmuIXmpZrnmoTlj5boiI0qKuOAguS4u+i/m+eoi+mCo+i+ueeUqCBgdm0uY3JlYXRlQ29udGV4dGAg5YGa6ZqU56a75rKZ566x77yMXG4gKiDkvYblvJXmk47ov5vnqIvkuI3og73nhafmkKwg4oCU4oCUIOmalOemu+S4iuS4i+aWh+S8muaWsOW7uuS4gOaVtOWllyByZWFsbSDlhoXlu7rlr7nosaHvvIxcbiAqIOaymeeusemHjOmAoOWHuuadpeeahCBge31gIC8gYFtdYCDlnKjlvJXmk47ku6PnoIHnmoQgYGluc3RhbmNlb2YgT2JqZWN0YCAvIGBpbnN0YW5jZW9mIEFycmF5YFxuICog5Yik5pat5LiL5LyaKirkuLrlgYcqKu+8jOmCo+S8muiuqeS4gOWghuW8leaTjiBBUEkg5Ye6546w6Zq+5Lul5o6S5p+l55qE6K+h5byC6KGM5Li644CCXG4gKlxuICog5omA5Lul6KaB55qE5piv44CMKirlkIzkuIDkuKogcmVhbG3vvIzkvYbog73otoXml7YqKuOAjeKAlOKAlCDmraPlpb3mmK8gYHZtLnJ1bkluVGhpc0NvbnRleHQoY29kZSwgeyB0aW1lb3V0IH0pYO+8mlxuICogLSDku6PnoIHot5HlnKgqKuWuv+S4uyByZWFsbSoq77yM5YaF5bu65a+56LGh5LiO5byV5pOO5a6M5YWo5LiA6Ie077yMYGluc3RhbmNlb2ZgIOivreS5ieWuieWFqO+8m1xuICogLSBgdGltZW91dGAg5a+5KirlkIzmraXmiafooYzmrrUqKueUn+aViO+8jOS6juaYryBgd2hpbGUodHJ1ZSl7fWAg6IO96KKr5o6Q5patXG4gKiAgIO+8iOi/meS4gOeCueW+iOWFs+mUru+8muWcuuaZr+i/m+eoi+mHjOWNoeatu+S4gOS4quWQjOatpeatu+W+queOryA9IOaVtOS4qiBDb2NvcyBDcmVhdG9yIOWGu+S9j++8jFxuICogICDlj6rog73lvLrmnYDvvIzmnKrkv53lrZjnmoTlnLrmma/mlLnliqjlhajkuKLvvInjgIJcbiAqXG4gKiDku6Pku7fmmK8gYHJ1bkluVGhpc0NvbnRleHRgIOeahOS7o+eggSoq55yL5LiN5Yiw5bGA6YOo5L2c55So5Z+fKirvvIzlhajlsYDph4/lj6rog73pgJrov4cgYGdsb2JhbFRoaXNgIOS8oOmAku+8jFxuICog5omn6KGM5a6M5YaN6L+Y5Y6f77yI6KeBIHtAbGluayBpbmplY3RHbG9iYWxzfe+8ieOAglxuICpcbiAqIOWmguaenOW8leaTjui/m+eoi+mHjOaLv+S4jeWIsCBgdm1g77yM5Zue6JC95YiwIGBuZXcgRnVuY3Rpb24oLi4ubmFtZXMsIGJvZHkpYO+8mlxuICog55So5pi+5byP5b2i5Y+C5Lyg5YWo5bGA6YeP77yM6Zu25L6d6LWW44CB5LiN56KwIGBnbG9iYWxUaGlzYO+8jOS9hioq5ZCM5q2l5q275b6q546v5peg5rOV6KKr6LaF5pe25pWR5ZueKirjgIJcbiAqIOS4pOadoei3r+W+hOeahOeUqOaIt+S7o+eggeWGmeazleWujOWFqOS4gOiHtO+8iOijuOagh+ivhuespiArIOmhtuWxgiByZXR1cm4vYXdhaXTvvInjgIJcbiAqXG4gKiAjIyDov5nkuKrmlofku7blj6rmmrTpnLIgMyDkuKrmlrnms5XvvIzkuI3mmK8gMzAg5LiqXG4gKlxuICogYHJ1bkNvZGVgIOmHjOazqOWFpeS6hiBgZHVtcGAgLyBgbm9kZUJ5VXVpZGAgLyBgdHJlZWAgLyBgc25hcHNob3RgIOetiSoq5Yqp5omL5Ye95pWwKirvvIxcbiAqIOWug+S7rOa0u+WcqOaymeeusemHjOiAjOS4jeaYr+WPmOaIkOeLrOeriyB0b29sIOKAlOKAlCDov5nmmK8gQ29kZSBNb2RlIOeahOaguOW/g+WPo+W+hO+8mlxuICog5bel5YW35YiX6KGo6KaB55+t77yM6IO95Yqb6Z2g5Luj56CB57uE5ZCI44CC5Li76L+b56iL5L6n5Y+q55yL5YiwIDMg5Liq5bel5YW377yMXG4gKiDlvJXmk47og73lipvljbTmnInml6DpmZDnu4TlkIjjgIJcbiAqXG4gKiAjIyDkuKTkuKrjgIzkuI3ov5nkuYjlgZrlsLHkvJrooqvor6/lr7zjgI3nmoTlrp7mtYvlnZFcbiAqXG4gKiAxLiAqKuWcuuaZr+agkemHjCA5NyUg55qE6IqC54K55LiN5piv5L2g55qE5YaF5a65KirjgILnvJbovpHlmajmiorlnZDmoIfovbQgZ2l6bW/jgIHnvZHmoLzjgIHlj4LogIPlm77pg73mjILlnKhcbiAqICAgIOWQjOS4gOS4qiBzY2VuZSDkuIvvvIjlrp7mtYvnqbrlnLrmma8gMTI4IOS4quiKgueCue+8jOecn+WunuWGheWuueWPquaciSAyIOS4qu+8ieOAglxuICogICAgYGVhY2hOb2RlYCAvIGB0cmVlKClgIOm7mOiupOaMiSBgSGlkZUluSGllcmFyY2h5YCDliarmnp0g4oCU4oCUIOWIpOaNrueahOaOqOWvvOi/h+eoi+ingVxuICogICAge0BsaW5rIG1ha2VIZWxwZXJzfSDph4wgYGlzRWRpdG9yTm9kZWAg5LiK5pa555qE5rOo6YeK77yIKirmjIkgbGF5ZXIg5ruk5piv6ZSZ55qEKirvvInjgIJcbiAqIDIuICoqYGNjLmZpbmRgIOaJvuS4jeWIsOWQjeWtl+mHjOWQqyBgL2Ag55qE6IqC54K5KirvvIzogIzkuJQqKumdmem7mOi/lOWbniBudWxsKirjgIJcbiAqICAgIOW3peeoi+mHjOWunua1i+WtmOWcqCBgaW50ZXJuYWwvZWRpdG9yL2dyaWQtMmRg44CCe0BsaW5rIG1ha2VIZWxwZXJzfSDph4xcbiAqICAgIGByZXNvbHZlUGF0aEJ5U2VnbWVudHNgIOeUqOOAjOi0quW/g+aMieauteWMuemFjeOAjeWFnOS9j+S6hui/meS4gOexu+OAglxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuLyoqIOaJp+ihjOi2heaXtueahOWTqOWFtemUmeivryAqL1xuaW50ZXJmYWNlIFRpbWVvdXRNYXJrZXIge1xuICAgIF9fZHNoVGltZW91dDogdHJ1ZTtcbn1cblxuZnVuY3Rpb24gdGltZW91dEVycm9yKG1zOiBudW1iZXIpOiBFcnJvciAmIFRpbWVvdXRNYXJrZXIge1xuICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcihg5Zy65pmv5Luj56CB5omn6KGM6LaF5pe277yIJHttc31tc++8iWApIGFzIEVycm9yICYgVGltZW91dE1hcmtlcjtcbiAgICBlcnIuX19kc2hUaW1lb3V0ID0gdHJ1ZTtcbiAgICByZXR1cm4gZXJyO1xufVxuXG4vKipcbiAqIOWIpOaWreaYr+S4jeaYr+i2heaXtuOAglxuICpcbiAqIOimgeiupOS4pOenje+8mlxuICogMS4g5oiR5Lus6Ieq5bex55qE5ZOo5YW177yI5aSW5bGC6K6h5pe25Zmo5oqb55qE77yJ4oCU4oCUIGBfX2RzaFRpbWVvdXRgXG4gKiAyLiAqKnZtIOiHquW3seaKm+eahOWQjOatpei2heaXtioqIOKAlOKAlCBgRVJSX1NDUklQVF9FWEVDVVRJT05fVElNRU9VVGDvvIxcbiAqICAgIOS/oeaBr+W9ouWmgiBgU2NyaXB0IGV4ZWN1dGlvbiB0aW1lZCBvdXQgYWZ0ZXIgMzAwbXNgXG4gKlxuICog56ysIDIg56eN54m55Yir5a655piT5ryP77ya5ryP5LqG55qE6K+d5q275b6q546v6Jm954S26KKr5o6Q5pat5LqG77yMXG4gKiDkvYblr7nlpJbmiqXnmoTmmK/jgIzmma7pgJrlvILluLjjgI3ogIzkuI3mmK/jgIzotoXml7bjgI3vvIzkvb/nlKjogIXnnIvkuI3lh7ror6XljrvmlLnku4DkuYjjgIJcbiAqL1xuZnVuY3Rpb24gaXNUaW1lb3V0KGVycjogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIGlmICghZXJyIHx8IHR5cGVvZiBlcnIgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgYW55RXJyID0gZXJyIGFzIHsgX19kc2hUaW1lb3V0PzogYm9vbGVhbjsgY29kZT86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgaWYgKGFueUVyci5fX2RzaFRpbWVvdXQpIHJldHVybiB0cnVlO1xuICAgIGlmIChhbnlFcnIuY29kZSA9PT0gJ0VSUl9TQ1JJUFRfRVhFQ1VUSU9OX1RJTUVPVVQnKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gdHlwZW9mIGFueUVyci5tZXNzYWdlID09PSAnc3RyaW5nJyAmJiAvU2NyaXB0IGV4ZWN1dGlvbiB0aW1lZCBvdXQvaS50ZXN0KGFueUVyci5tZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gZXJyb3JJbmZvKGVycjogdW5rbm93bik6IHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmc7IHN0YWNrPzogc3RyaW5nIH0ge1xuICAgIGlmIChlcnIgJiYgdHlwZW9mIGVyciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3QgYW55RXJyID0gZXJyIGFzIHsgbmFtZT86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duOyBzdGFjaz86IHVua25vd24gfTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IHR5cGVvZiBhbnlFcnIubmFtZSA9PT0gJ3N0cmluZycgPyBhbnlFcnIubmFtZSA6ICdFcnJvcicsXG4gICAgICAgICAgICBtZXNzYWdlOiB0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnID8gYW55RXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICAgIHN0YWNrOiB0eXBlb2YgYW55RXJyLnN0YWNrID09PSAnc3RyaW5nJyA/IGFueUVyci5zdGFjayA6IHVuZGVmaW5lZCxcbiAgICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogU3RyaW5nKGVycikgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlvJXmk47mqKHlnZfmh5LliqDovb1cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5sZXQgY2NDYWNoZTogYW55ID0gbnVsbDtcbmxldCBjY0Vycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiDmi7/liLAgYGNjYCDmqKHlnZfjgIJcbiAqXG4gKiBgbW9kdWxlLnBhdGhzLnB1c2goRWRpdG9yLkFwcC5wYXRoICsgJy9ub2RlX21vZHVsZXMnKWAg5piv5b+F6ZyA55qE77yaXG4gKiDlnLrmma/ohJrmnKzoh6rouqvnmoTmqKHlnZfop6PmnpDot6/lvoTph4zmsqHmnInlvJXmk47ljIXvvIzkuI3mjqjov5nkuIDkuIsgYHJlcXVpcmUoJ2NjJylgIOS8miBNT0RVTEVfTk9UX0ZPVU5E44CCXG4gKi9cbmZ1bmN0aW9uIGdldENjKCk6IGFueSB7XG4gICAgaWYgKGNjQ2FjaGUpIHJldHVybiBjY0NhY2hlO1xuICAgIGlmIChjY0Vycm9yKSB0aHJvdyBuZXcgRXJyb3IoY2NFcnJvcik7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZW5naW5lTm9kZU1vZHVsZXMgPSBqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpO1xuICAgICAgICBpZiAoIW1vZHVsZS5wYXRocy5pbmNsdWRlcyhlbmdpbmVOb2RlTW9kdWxlcykpIHtcbiAgICAgICAgICAgIG1vZHVsZS5wYXRocy5wdXNoKGVuZ2luZU5vZGVNb2R1bGVzKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICBjY0NhY2hlID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgcmV0dXJuIGNjQ2FjaGU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNjRXJyb3IgPSBg5peg5rOV5Yqg6L295byV5pOO5qih5Z2XIGNj77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWA7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihjY0Vycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGN1cnJlbnRTY2VuZShjYzogYW55KTogYW55IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlY2lwZSDmqKHlnZcg4oCU4oCUIOS4juS4u+i/m+eoi+WFseS6q+WQjOS4gOS7veWunueOsFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiDmianlsZXljIXlkI3vvIzkuI4gY29uc3RhbnRzLnRzIOeahCBFWFRFTlNJT05fTkFNRSDkuIDoh7TvvIjmraTlpITkuI3og70gaW1wb3J077yM5Y6f5Zug6KeB5LiL77yJICovXG5jb25zdCBFWFRFTlNJT05fTkFNRSA9ICdkc2hfY2hhdCc7XG5cbmxldCByZWNpcGVzTW9kdWxlOiBhbnkgPSBudWxsO1xubGV0IHJlY2lwZXNNb2R1bGVFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICog5Yqg6L295YWx5Lqr55qEIHJlY2lwZSDmqKHlnZfvvIhgZGlzdC9jb3JlL3JlY2lwZXMuanNg77yJ44CCXG4gKlxuICog4pqgICoq5b+F6aG75oyJ57ud5a+56Lev5b6EIHJlcXVpcmXvvIznm7jlr7not6/lvoTkuI3pgJoqKuOAguWunua1i+WcuuaZr+iEmuacrOmHjCBgX19kaXJuYW1lYCDmmK9cbiAqIGAuLi5cXHJlc291cmNlc1xcZWxlY3Ryb24uYXNhclxccmVuZGVyZXJg77yI5LiN5piv5omp5bGV55qEIGBkaXN0L2DvvInvvIxcbiAqIOaJgOS7pSBgcmVxdWlyZSgnLi9jb3JlL3JlY2lwZXMnKWAg55u05o6lIE1PRFVMRV9OT1RfRk9VTkTjgIJcbiAqXG4gKiDmraPop6PmmK/pl67nvJbovpHlmajopoHmianlsZXmoLnvvJpgRWRpdG9yLlBhY2thZ2UuZ2V0UGF0aCgnZHNoX2NoYXQnKWBcbiAqIOKGkiBgLi4uXFxleHRlbnNpb25zXFxkc2hfY2hhdGDvvIzlho3mi7wgYGRpc3QvY29yZS9yZWNpcGVzLmpzYO+8iOWunua1i+WPr+ihjO+8ieOAglxuICpcbiAqIOmhuuW4puivtOaYjuS4gOS4quehrOe6puadn++8muacrOmhueebrioq5rKh5pyJ5omT5YyF5ZmoKirvvIjmnoTlu7rlsLHmmK8gYHRzY2DvvInvvIxcbiAqIOaJgOS7pSBgZGlzdC9gIOeahOebruW9lee7k+aehOaYr+i3qOi/m+eoi+eahOehrOWlkee6pu+8jOaUuSBgb3V0RGlyYCDmiJbmjKogYGNvcmUvYCDkvJrmiZPmlq3lroPjgIJcbiAqL1xuZnVuY3Rpb24gZ2V0UmVjaXBlc01vZHVsZSgpOiBhbnkge1xuICAgIGlmIChyZWNpcGVzTW9kdWxlKSByZXR1cm4gcmVjaXBlc01vZHVsZTtcbiAgICBpZiAocmVjaXBlc01vZHVsZUVycm9yKSB0aHJvdyBuZXcgRXJyb3IocmVjaXBlc01vZHVsZUVycm9yKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByb290ID0gRWRpdG9yLlBhY2thZ2UuZ2V0UGF0aChFWFRFTlNJT05fTkFNRSk7XG4gICAgICAgIGlmICghcm9vdCkgdGhyb3cgbmV3IEVycm9yKGBFZGl0b3IuUGFja2FnZS5nZXRQYXRoKCcke0VYVEVOU0lPTl9OQU1FfScpIOi/lOWbnuepumApO1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICByZWNpcGVzTW9kdWxlID0gcmVxdWlyZShqb2luKHJvb3QsICdkaXN0JywgJ2NvcmUnLCAncmVjaXBlcy5qcycpKTtcbiAgICAgICAgcmV0dXJuIHJlY2lwZXNNb2R1bGU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJlY2lwZXNNb2R1bGVFcnJvciA9IGDml6Dms5XliqDovb0gcmVjaXBlIOaooeWdl++8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocmVjaXBlc01vZHVsZUVycm9yKTtcbiAgICB9XG59XG5cbi8qKiDlvZPliY3lt6XnqIvmoLnvvJvmi7/kuI3liLDlsLHov5Tlm57nqbrkuLLvvIhyZWNpcGUg5Yqp5omL5Lya6YCA5YyW5oiQ44CM5rKh5pyJIHJlY2lwZeOAjeiAjOS4jeaYr+aKpemUme+8iSAqL1xuZnVuY3Rpb24gY3VycmVudFByb2plY3RQYXRoKCk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIEVkaXRvci5Qcm9qZWN0LnBhdGggfHwgJyc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnJztcbiAgICB9XG59XG5cbi8qKiByZWNpcGUg5a2Y5pS+55uu5b2VIOKAlOKAlCDlj6rnu5kgYGRlc2NyaWJlX2FwaWAg5Zue5pi+55So77yM5ou/5LiN5Yiw5bCxIG51bGwgKi9cbmZ1bmN0aW9uIHJlY2lwZXNSb290SGludCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IGN1cnJlbnRQcm9qZWN0UGF0aCgpO1xuICAgICAgICBpZiAoIXByb2plY3RQYXRoKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGdldFJlY2lwZXNNb2R1bGUoKS5yZWNpcGVzUm9vdChwcm9qZWN0UGF0aCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDliqnmiYvlh73mlbAg4oCU4oCUIOazqOWFpeaymeeuse+8jOS4jeaatOmcsuS4uiB0b29sXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIOa3seW6puS8mOWFiOmBjeWOhuaVtOajteWtkOagke+8iOi/reS7o+WunueOsO+8jOmBv+WFjea3seWxguWcuuaZr+eIhuagiO+8iSAqL1xuZnVuY3Rpb24gZWFjaE5vZGUocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGlmICghcm9vdCkgcmV0dXJuO1xuICAgIGNvbnN0IHN0YWNrOiBhbnlbXSA9IFtyb290XTtcbiAgICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBub2RlID0gc3RhY2sucG9wKCk7XG4gICAgICAgIHZpc2l0KG5vZGUpO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgICAgIGZvciAobGV0IGkgPSBjaGlsZHJlbi5sZW5ndGggLSAxOyBpID49IDA7IGkgLT0gMSkgc3RhY2sucHVzaChjaGlsZHJlbltpXSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzaG9ydE5vZGUobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgdXVpZDogbm9kZS51dWlkLFxuICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlSW5IaWVyYXJjaHkgIT09IHVuZGVmaW5lZCA/IG5vZGUuYWN0aXZlSW5IaWVyYXJjaHkgOiBub2RlLmFjdGl2ZSxcbiAgICB9O1xufVxuXG4vKiog5oqK5YC85o6o5pat5oiQIFRTIOexu+Wei+WQje+8jOeUqOS6jueUn+aIkOexu+WumuS5iSAqL1xuZnVuY3Rpb24gaW5mZXJUc1R5cGUodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gJ2FueSc7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5sZW5ndGggPiAwID8gYCR7aW5mZXJUc1R5cGUodmFsdWVbMF0pfVtdYCA6ICdhbnlbXSc7XG4gICAgfVxuICAgIHN3aXRjaCAodHlwZW9mIHZhbHVlKSB7XG4gICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICByZXR1cm4gJ251bWJlcic7XG4gICAgICAgIGNhc2UgJ3N0cmluZyc6XG4gICAgICAgICAgICByZXR1cm4gJ3N0cmluZyc7XG4gICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgcmV0dXJuICdib29sZWFuJztcbiAgICAgICAgY2FzZSAnZnVuY3Rpb24nOlxuICAgICAgICAgICAgcmV0dXJuICdGdW5jdGlvbic7XG4gICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHJldHVybiAnYW55JztcbiAgICB9XG4gICAgY29uc3Qgb2JqID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgbGV0IGN0b3JOYW1lID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY3RvciA9IChvYmogYXMgeyBjb25zdHJ1Y3Rvcj86IHsgbmFtZT86IHN0cmluZyB9IH0pLmNvbnN0cnVjdG9yO1xuICAgICAgICBjdG9yTmFtZSA9IGN0b3IgJiYgdHlwZW9mIGN0b3IubmFtZSA9PT0gJ3N0cmluZycgPyBjdG9yLm5hbWUgOiAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgY3Rvck5hbWUgPSAnJztcbiAgICB9XG4gICAgaWYgKCFjdG9yTmFtZSB8fCBjdG9yTmFtZSA9PT0gJ09iamVjdCcpIHJldHVybiAnb2JqZWN0JztcbiAgICAvLyDlvJXmk47mlbDlraYv6LWE5rqQ57G75Z6L6YO95bimIGNjLiDliY3nvIDmm7TliKnkuo4gQUkg5YaZ5Luj56CBXG4gICAgaWYgKHR5cGVvZiBvYmoudXVpZCA9PT0gJ3N0cmluZycpIHJldHVybiBgY2MuJHtjdG9yTmFtZX0gLyogYXNzZXQgKi9gO1xuICAgIHJldHVybiBgY2MuJHtjdG9yTmFtZX1gO1xufVxuXG4vKiog5Y+W5LiA5Liq5a+56LGh5LiK55qE5Y+v5p6a5Li+6Ieq5pyJ6ZSu77yIZ2V0dGVyIOaKm+W8guW4uOaXtui3s+i/h++8iSAqL1xuZnVuY3Rpb24gc2FmZUtleXModGFyZ2V0OiBhbnkpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKHRhcmdldCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhZmVSZWFkKHRhcmdldDogYW55LCBrZXk6IHN0cmluZyk6IHsgb2s6IGJvb2xlYW47IHZhbHVlPzogdW5rbm93biB9IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHRhcmdldFtrZXldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgIH1cbn1cblxuLyoqIOe7hOS7tueahOW6j+WIl+WMluWxnuaAp+WQjeWIl+ihqO+8muS8mOWFiOeUqCBDb2NvcyDnmoQgYF9fcHJvcHNfX2AgKi9cbmZ1bmN0aW9uIGNvbXBvbmVudFByb3BOYW1lcyhjb21wOiBhbnkpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgY3RvciA9IGNvbXAgJiYgY29tcC5jb25zdHJ1Y3RvcjtcbiAgICBjb25zdCBkZWNsYXJlZCA9IGN0b3IgJiYgQXJyYXkuaXNBcnJheShjdG9yLl9fcHJvcHNfXykgPyAoY3Rvci5fX3Byb3BzX18gYXMgc3RyaW5nW10pIDogbnVsbDtcbiAgICBpZiAoZGVjbGFyZWQgJiYgZGVjbGFyZWQubGVuZ3RoID4gMCkgcmV0dXJuIGRlY2xhcmVkLnNsaWNlKCk7XG4gICAgcmV0dXJuIHNhZmVLZXlzKGNvbXApLmZpbHRlcigoaykgPT4gayAhPT0gJ25vZGUnICYmIGsgIT09ICd1dWlkJyAmJiAhay5zdGFydHNXaXRoKCdfJykpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWcuuaZr+inhuWbvuaIquWbvu+8iGNhcHR1cmVWaWV3IOeahOWunueOsO+8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8g5Li65LuA5LmI6KaB6L+Z5Liq6IO95Yqb77ya5pS55a6M6IqC54K55qCRL+W4g+WxgOS5i+WQju+8jCoq5Z2Q5qCH5pWw5a2X55yL5LiN5Ye644CM5Y+g5Zyo5LiA6LW344CN44CM6LS05Zu+5piv56m655qE44CNXG4vLyDjgIzkuIDlsY/lj6rmnInkuKrop5LjgI0qKuOAguacieS6huWug++8jEFJIOWPr+S7peiHquW3seeci+S4gOecvOeUu+mdouWGjeWGs+WumuS4i+S4gOatpe+8jOiAjOS4jeaYr+aLv+S4gOS4siByZWN0XG4vLyDljrvnjJzvvIzkuZ/kuI3mmK/miornlKjmiLflvZPpqozlm77lt6XlhbfjgIJcbi8vXG4vLyDkuKTmnaHlrp7njrDlj6PlvoTvvJpcbi8vIDEuICoq5Zyo5byV5pOO55S75a6M6L+Z5LiA5bin5LmL5ZCO6K+75YOP57SgKirvvIhgRVZFTlRfQUZURVJfRFJBV2DvvInjgIJXZWJHTCDnmoTnu5jliLbnvJPlhrLlnKjlkIjmiJDlkI5cbi8vICAgIOWNs+WkseaViO+8iGBwcmVzZXJ2ZURyYXdpbmdCdWZmZXJgIOm7mOiupCBmYWxzZe+8ie+8jOW4p+Wkluivu+WPquS8muW+l+WIsOS4gOW8oOepuuWbvuOAglxuLy8gMi4gKirkvJjlhYjoh6rlt7HokL3nm5gqKu+8muacrOaWh+S7tuaYr+WcuuaZr+i/m+eoi+mHjOeahCBDSlMg5qih5Z2X77yMYGZzYCDlnKgqKuaooeWdl+S9nOeUqOWfnyoq6YeM5Y+v6KeBXG4vLyAgICDvvIjmspnnrrHph4znnIvkuI3liLAgYHJlcXVpcmVg77yM5L2G5Yqp5omL5Ye95pWw55qE6Zet5YyF55yL5b6X5Yiw77yJ44CC5YaZ5LiN5LqG55uY5omN5Zue6JC944CM5YiG5Z2X5Zue5Lyg44CN77yMXG4vLyAgICDnlLHkuLvov5vnqIvmi7zlm57ljrvokL3nm5gg4oCU4oCUIOWboOS4uuaymeeusei/lOWbnuWAvOacieOAjOWNleWtl+espuS4siA0MDAwIOWtl+OAjeeahOS4iumZkOOAglxuXG4vKiogTm9kZSDkvqfmqKHlnZfvvIjmi7/kuI3liLDlsLHov5Tlm54gbnVsbO+8jOiwg+eUqOaWueWbnuiQveWIsOWIhuWdl+WbnuS8oO+8ieOAgiAqL1xubGV0IG5vZGVNb2R1bGVzQ2FjaGU6IHsgZnM6IGFueTsgcGF0aDogYW55OyBvczogYW55IH0gfCBudWxsIHwgdW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBnZXROb2RlTW9kdWxlcygpOiB7IGZzOiBhbnk7IHBhdGg6IGFueTsgb3M6IGFueSB9IHwgbnVsbCB7XG4gICAgaWYgKG5vZGVNb2R1bGVzQ2FjaGUgIT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vZGVNb2R1bGVzQ2FjaGU7XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbiAgICAgICAgbm9kZU1vZHVsZXNDYWNoZSA9IHsgZnM6IHJlcXVpcmUoJ2ZzJyksIHBhdGg6IHJlcXVpcmUoJ3BhdGgnKSwgb3M6IHJlcXVpcmUoJ29zJykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgbm9kZU1vZHVsZXNDYWNoZSA9IG51bGw7XG4gICAgfVxuICAgIHJldHVybiBub2RlTW9kdWxlc0NhY2hlO1xufVxuXG4vKiog5Zy65pmv6KeG5Zu+55qE6YKj5Z2X55S75biD77ya5LyY5YWI5byV5pOO6Ieq5bex55qEIGNhbnZhc++8jOWFtuasoemhtemdouS4iumdouenr+acgOWkp+eahCBjYW52YXPjgIIgKi9cbmZ1bmN0aW9uIGZpbmRWaWV3Q2FudmFzKGNjOiBhbnkpOiBhbnkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IGFueVtdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNjLmdhbWUgJiYgY2MuZ2FtZS5jYW52YXMpIGNhbmRpZGF0ZXMucHVzaChjYy5nYW1lLmNhbnZhcyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpe+8muW8leaTjueJiOacrOW3ruW8giAqL1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIGRvY3VtZW50ICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKC4uLkFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnY2FudmFzJykpKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaXvvJrkuI3mmK/mtY/op4jlmajnjq/looMgKi9cbiAgICB9XG4gICAgY29uc3QgdXNhYmxlID0gY2FuZGlkYXRlcy5maWx0ZXIoXG4gICAgICAgIChjKSA9PiBjICYmIHR5cGVvZiBjLmdldENvbnRleHQgPT09ICdmdW5jdGlvbicgJiYgYy53aWR0aCA+IDAgJiYgYy5oZWlnaHQgPiAwLFxuICAgICk7XG4gICAgaWYgKHVzYWJsZS5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgIHJldHVybiB1c2FibGUuc29ydCgoYSwgYikgPT4gYi53aWR0aCAqIGIuaGVpZ2h0IC0gYS53aWR0aCAqIGEuaGVpZ2h0KVswXTtcbn1cblxuLyoqXG4gKiDmiqXlh7rjgIzlnLrmma/op4blm77njrDlnKjmmK/mgI7kuYjlj5bmma/nmoTjgI3igJTigJQgKirnqbrnmb3luKfnmoTkuIDljYrnrZTmoYjlnKjov5nph4wqKuOAglxuICpcbiAqIOS4uuS7gOS5iOimgeacieWug++8muWunua1i+WHuui/h+S4gOasoeS6i+aVhe+8iDIwMjYtMDktMzAgMDA6NDkg6YKj5p2h5Lya6K+d77yJ77yM5qih5Z6L5Li65LqG44CM5qih5ouf6K6+5aSH6auY5bqm6aqM6YCC6YWN44CNXG4gKiDosIPkuoYgYGNjLnZpZXcuc2V0RGVzaWduUmVzb2x1dGlvblNpemVg77yM5oqK57yW6L6R5ZmoKirlnLrmma/op4blm77nmoTorr7lpIfmqKHmi5/miZPmjokqKuS6hu+8mlxuICogYHZpc2libGVgIOS7jiA3NTDDlzEzMzQg5Y+Y5oiQIDc1MMOXNTU5LjM177yM5q2k5ZCO5q+P5LiA5qyhIGBjYXB0dXJlX3ZpZXdgIOmDveWPquaLv+WIsCBgYmxhbmtSYXRpbzogMWBcbiAqIOeahOeZvee6uCDigJTigJQg6ICMKirov5nkuKrlt67lvILmmK/lj6/ku6Xnm7TmjqXph4/lh7rmnaXnmoQqKuOAguaKiuWug+aKpeWHuuadpe+8jOaooeWei+WwseS4jeeUqOmdoOeMnO+8jFxuICog5Lmf5LiN55So5YOP6YKj5qyh5LiA5qC36Ieq5bu65LiA5aWX56a75bGP5riy5p+T5Zmo77yIMTYg5q2l77yJ5Y675pu/5Luj5LiA5LiqXCLooqvoh6rlt7HlvITlnY9cIueahOmAmumBk+OAglxuICpcbiAqIEBwYXJhbSBjYyAtIOW8leaTjuaooeWdl+OAglxuICogQHBhcmFtIGNhbnZhcyAtIOWcuuaZr+inhuWbvueUu+W4g+OAglxuICogQHJldHVybnMg6KeG5Zu+54q25oCB77yb5Y+W5LiN5Yiw55qE6aG55LiN5Ye6546w77yI5byV5pOO54mI5pys5beu5byC5LiN6Zi75pat5oiq5Zu+5pys6Lqr77yJ44CCXG4gKi9cbmZ1bmN0aW9uIHJlYWRWaWV3U3RhdGUoY2M6IGFueSwgY2FudmFzOiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgcm91bmQgPSAodmFsdWU6IHVua25vd24pOiBudW1iZXIgfCBudWxsID0+XG4gICAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgucm91bmQodmFsdWUgKiAxMDApIC8gMTAwIDogbnVsbDtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmlldyA9IGNjLnZpZXc7XG4gICAgICAgIGlmICh2aWV3KSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZpZXcuZ2V0VmlzaWJsZVNpemUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzaXplID0gdmlldy5nZXRWaXNpYmxlU2l6ZSgpO1xuICAgICAgICAgICAgICAgIGlmIChzaXplKSBvdXQudmlzaWJsZVNpemUgPSB7IHdpZHRoOiByb3VuZChzaXplLndpZHRoKSwgaGVpZ2h0OiByb3VuZChzaXplLmhlaWdodCkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2Ygdmlldy5nZXREZXNpZ25SZXNvbHV0aW9uU2l6ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNpemUgPSB2aWV3LmdldERlc2lnblJlc29sdXRpb25TaXplKCk7XG4gICAgICAgICAgICAgICAgaWYgKHNpemUpIG91dC5kZXNpZ25SZXNvbHV0aW9uID0geyB3aWR0aDogcm91bmQoc2l6ZS53aWR0aCksIGhlaWdodDogcm91bmQoc2l6ZS5oZWlnaHQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZpZXcuZ2V0U2NhbGVYID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgb3V0LnNjYWxlID0geyB4OiByb3VuZCh2aWV3LmdldFNjYWxlWCgpKSwgeTogcm91bmQodmlldy5nZXRTY2FsZVkoKSkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlvJXmk47niYjmnKzlt67lvILvvJrmi7/kuI3liLDlsLHkuI3miqXvvIzkuI3lvbHlk43miKrlm74gKi9cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNhbnZhcykgb3V0LmNhbnZhcyA9IHsgd2lkdGg6IGNhbnZhcy53aWR0aCwgaGVpZ2h0OiBjYW52YXMuaGVpZ2h0IH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICAvKiog5LiO6K6+6K6h5YiG6L6o546H5LiN5LiA6Ie0ID0g5ri45oiP5L6n5Y+W5pmv5LiN5piv6K6+6K6h5qGj77yI4pqgIOWcuuaZr+inhuWbvuaYr+iHqueUseebuOacuu+8jOeUqOaIt+e8qeaUvuS5n+S8muiuqeWug+WPmO+8jOaJgOS7pei/meWPquaYr+e6v+e0ouS4jeaYr+WIpOaNru+8iSAqL1xuICAgIGNvbnN0IHZpc2libGUgPSBvdXQudmlzaWJsZVNpemUgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRlc2lnbiA9IG91dC5kZXNpZ25SZXNvbHV0aW9uIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IHVuZGVmaW5lZDtcbiAgICBpZiAodmlzaWJsZSAmJiBkZXNpZ24gJiYgdHlwZW9mIGRlc2lnbi5oZWlnaHQgPT09ICdudW1iZXInICYmIGRlc2lnbi5oZWlnaHQgPiAwKSB7XG4gICAgICAgIG91dC52aXNpYmxlTWF0Y2hlc0Rlc2lnbiA9IE1hdGguYWJzKHZpc2libGUuaGVpZ2h0IC0gZGVzaWduLmhlaWdodCkgLyBkZXNpZ24uaGVpZ2h0IDw9IDAuMDU7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog562J5byV5pOO55S75a6M5LiA5bin77yM54S25ZCO5LuO6buY6K6k5bin57yT5Yay6K+75Zue5YOP57Sg44CCXG4gKlxuICogQHBhcmFtIHdhaXRNcyDnrYnkuI3liLAgYEVWRU5UX0FGVEVSX0RSQVdgIOaXtueahOWFnOW6leS4iumZkO+8iOWcuuaZr+inhuWbvuWPr+iDveayoeWcqOa4suafk++8iVxuICovXG5mdW5jdGlvbiByZWFkVmlld1BpeGVscyhcbiAgICBjYzogYW55LFxuICAgIGNhbnZhczogYW55LFxuICAgIHdhaXRNczogbnVtYmVyLFxuKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBwaXhlbHM6IFVpbnQ4QXJyYXkgfT4ge1xuICAgIGNvbnN0IGdyYWIgPSAoKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgcGl4ZWxzOiBVaW50OEFycmF5IH0gPT4ge1xuICAgICAgICBjb25zdCBnbCA9XG4gICAgICAgICAgICBjYW52YXMuZ2V0Q29udGV4dCgnd2ViZ2wyJykgfHxcbiAgICAgICAgICAgIGNhbnZhcy5nZXRDb250ZXh0KCd3ZWJnbCcpIHx8XG4gICAgICAgICAgICBjYW52YXMuZ2V0Q29udGV4dCgnZXhwZXJpbWVudGFsLXdlYmdsJyk7XG4gICAgICAgIGlmICghZ2wpIHRocm93IG5ldyBFcnJvcign55S75biD5LiK5rKh5pyJIFdlYkdMIOS4iuS4i+aWh++8iDJEIOeUu+W4g+S4jeaUr+aMgei/meS5iOaIquWbvu+8iScpO1xuICAgICAgICBjb25zdCB3aWR0aCA9IGdsLmRyYXdpbmdCdWZmZXJXaWR0aCB8fCBjYW52YXMud2lkdGg7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IGdsLmRyYXdpbmdCdWZmZXJIZWlnaHQgfHwgY2FudmFzLmhlaWdodDtcbiAgICAgICAgaWYgKCF3aWR0aCB8fCAhaGVpZ2h0KSB0aHJvdyBuZXcgRXJyb3IoJ+eUu+W4g+WwuuWvuOS4uiAw77yM5oiq5LiN5Yiw5Lic6KW/Jyk7XG4gICAgICAgIGNvbnN0IHBpeGVscyA9IG5ldyBVaW50OEFycmF5KHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICAgIC8vIOW8leaTjuWPr+iDveeVmeedgOWIq+eahCBGQk8g57uR5a6aIOKAlOKAlCDor7vpu5jorqTluKfnvJPlhrLliY3mmL7lvI/op6Pnu5FcbiAgICAgICAgZ2wuYmluZEZyYW1lYnVmZmVyKGdsLkZSQU1FQlVGRkVSLCBudWxsKTtcbiAgICAgICAgZ2wucmVhZFBpeGVscygwLCAwLCB3aWR0aCwgaGVpZ2h0LCBnbC5SR0JBLCBnbC5VTlNJR05FRF9CWVRFLCBwaXhlbHMpO1xuICAgICAgICByZXR1cm4geyB3aWR0aCwgaGVpZ2h0LCBwaXhlbHMgfTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgICAgY29uc3Qgc2V0dGxlID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGZuKCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGV2ZW50ID0gY2MuRGlyZWN0b3IgJiYgY2MuRGlyZWN0b3IuRVZFTlRfQUZURVJfRFJBVztcbiAgICAgICAgICAgIGlmIChldmVudCAmJiBjYy5kaXJlY3RvciAmJiB0eXBlb2YgY2MuZGlyZWN0b3Iub25jZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNjLmRpcmVjdG9yLm9uY2UoZXZlbnQsICgpID0+IHNldHRsZSgoKSA9PiByZXNvbHZlKGdyYWIoKSkpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlm57okL3vvJrnm7TmjqXmipPlvZPliY3nvJPlhrIgKi9cbiAgICAgICAgfVxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHNldHRsZSgoKSA9PiByZXNvbHZlKGdyYWIoKSkpLCB3YWl0TXMpO1xuICAgIH0pO1xufVxuXG4vKiog5oq95qC35Lyw566X44CM5Yeg5LmO5piv56m65Zu+44CN55qE5q+U5L6L77yI5YWo6YCP5piO5oiW57qv6buR6YO9566X56m677yJ4oCU4oCUIOeUqOadpeWPkeeOsFwi5oiq5Ye65p2l5piv5byg55m957q4XCLjgIIgKi9cbmZ1bmN0aW9uIHNhbXBsZUJsYW5rUmF0aW8ocGl4ZWxzOiBVaW50OEFycmF5KTogbnVtYmVyIHtcbiAgICBjb25zdCB0b3RhbCA9IE1hdGguZmxvb3IocGl4ZWxzLmxlbmd0aCAvIDQpO1xuICAgIGlmICh0b3RhbCA8PSAwKSByZXR1cm4gMTtcbiAgICBjb25zdCBzdGVwID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcih0b3RhbCAvIDUxMikpO1xuICAgIGxldCBzYW1wbGVkID0gMDtcbiAgICBsZXQgYmxhbmsgPSAwO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWw7IGkgKz0gc3RlcCkge1xuICAgICAgICBjb25zdCBvID0gaSAqIDQ7XG4gICAgICAgIHNhbXBsZWQgKz0gMTtcbiAgICAgICAgaWYgKHBpeGVsc1tvICsgM10gPT09IDAgfHwgKHBpeGVsc1tvXSA9PT0gMCAmJiBwaXhlbHNbbyArIDFdID09PSAwICYmIHBpeGVsc1tvICsgMl0gPT09IDApKSBibGFuayArPSAxO1xuICAgIH1cbiAgICByZXR1cm4gc2FtcGxlZCA+IDAgPyBNYXRoLnJvdW5kKChibGFuayAvIHNhbXBsZWQpICogMTAwMCkgLyAxMDAwIDogMTtcbn1cblxuLyoqIOaKiiBSR0JBIOWDj+e0oOe8lueggeaIkCBkYXRhIFVSTO+8iFdlYkdMIOWOn+eCueWcqOW3puS4i++8jOmcgOimgee/u+ihjO+8ieOAgiAqL1xuZnVuY3Rpb24gZW5jb2RlRnJhbWVUb0RhdGFVcmwoXG4gICAgcGl4ZWxzOiBVaW50OEFycmF5LFxuICAgIHdpZHRoOiBudW1iZXIsXG4gICAgaGVpZ2h0OiBudW1iZXIsXG4gICAgb3B0czogeyBtYXhXaWR0aDogbnVtYmVyOyBtaW1lOiBzdHJpbmc7IHF1YWxpdHk6IG51bWJlciB9LFxuKTogeyBkYXRhVXJsOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0ge1xuICAgIGlmICh0eXBlb2YgZG9jdW1lbnQgPT09ICd1bmRlZmluZWQnIHx8IHR5cGVvZiBkb2N1bWVudC5jcmVhdGVFbGVtZW50ICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN546v5aKD5rKh5pyJIGRvY3VtZW50LmNyZWF0ZUVsZW1lbnTvvIzml6Dms5Xmiorlg4/ntKDnvJbnoIHmiJDlm77niYcnKTtcbiAgICB9XG4gICAgY29uc3Qgc3JjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgc3JjLndpZHRoID0gd2lkdGg7XG4gICAgc3JjLmhlaWdodCA9IGhlaWdodDtcbiAgICBjb25zdCBjdHggPSBzcmMuZ2V0Q29udGV4dCgnMmQnKTtcbiAgICBpZiAoIWN0eCkgdGhyb3cgbmV3IEVycm9yKCfmi7/kuI3liLAgMkQg55S75biD5LiK5LiL5paHJyk7XG5cbiAgICBjb25zdCBpbWFnZSA9IGN0eC5jcmVhdGVJbWFnZURhdGEod2lkdGgsIGhlaWdodCk7XG4gICAgY29uc3Qgcm93Qnl0ZXMgPSB3aWR0aCAqIDQ7XG4gICAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkgKz0gMSkge1xuICAgICAgICBjb25zdCBmcm9tID0gKGhlaWdodCAtIDEgLSB5KSAqIHJvd0J5dGVzO1xuICAgICAgICBpbWFnZS5kYXRhLnNldChwaXhlbHMuc3ViYXJyYXkoZnJvbSwgZnJvbSArIHJvd0J5dGVzKSwgeSAqIHJvd0J5dGVzKTtcbiAgICB9XG4gICAgY3R4LnB1dEltYWdlRGF0YShpbWFnZSwgMCwgMCk7XG5cbiAgICBsZXQgb3V0OiBhbnkgPSBzcmM7XG4gICAgaWYgKG9wdHMubWF4V2lkdGggPiAwICYmIHdpZHRoID4gb3B0cy5tYXhXaWR0aCkge1xuICAgICAgICBjb25zdCBzY2FsZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICAgICAgc2NhbGVkLndpZHRoID0gb3B0cy5tYXhXaWR0aDtcbiAgICAgICAgc2NhbGVkLmhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKGhlaWdodCAqIG9wdHMubWF4V2lkdGgpIC8gd2lkdGgpKTtcbiAgICAgICAgY29uc3Qgc2N0eCA9IHNjYWxlZC5nZXRDb250ZXh0KCcyZCcpO1xuICAgICAgICBpZiAoc2N0eCkge1xuICAgICAgICAgICAgc2N0eC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBzY3R4LmltYWdlU21vb3RoaW5nUXVhbGl0eSA9ICdoaWdoJztcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOiAgea1j+iniOWZqOS4jeaUr+aMgeWwseeul+S6hiAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2N0eC5kcmF3SW1hZ2Uoc3JjLCAwLCAwLCBzY2FsZWQud2lkdGgsIHNjYWxlZC5oZWlnaHQpO1xuICAgICAgICAgICAgb3V0ID0gc2NhbGVkO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IGRhdGFVcmw6IG91dC50b0RhdGFVUkwob3B0cy5taW1lLCBvcHRzLnF1YWxpdHkpLCB3aWR0aDogb3V0LndpZHRoLCBoZWlnaHQ6IG91dC5oZWlnaHQgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlnLrmma/op4blm77lh6DkvZUg4oCU4oCUIOe7meS4u+i/m+eoi+eahCBFbGVjdHJvbiDmiKrlm77nlKjvvIjov5nph4zlj6rjgIzph4/jgI3vvIzkuI3or7vlg4/ntKDvvIlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy9cbi8vIOWIhuW3pe+8iCoq5Li65LuA5LmI6KaB5YiGKirvvInvvJrlg4/ntKDnlLHkuLvov5vnqIvnmoQgYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgIOaKkyDigJTigJQg5a6D6K+755qE5pivXG4vLyBDaHJvbWl1bSAqKuWQiOaIkOWQjueahCBzdXJmYWNlKirvvIzkuI3lj5cgYHByZXNlcnZlRHJhd2luZ0J1ZmZlcjogZmFsc2VgIOW9seWTje+8jOi/mOiDvVxuLy8gYGludmFsaWRhdGUoKWAg6YC85Ye65LiA5bin77yb6L+Z5Lik5Lu25q2j5piv6ICB55qEIGBnbC5yZWFkUGl4ZWxzYCDlgZrkuI3liLDnmoTvvIjop4EgYGNhcHR1cmUudHNgIOWktOmDqO+8ieOAglxuLy8g6ICM44CM5oqT5ZOq5LiA5Z2X44CN5Y+q5pyJ5Zy65pmv6L+b56iL562U5b6X5LiK77yM5Zug5Li65a6D5omL6YeM5pyJ57yW6L6R5Zmo55u45py644CCXG4vL1xuLy8g5LqO5piv5pys5paH5Lu25Y+q5Zue562U5LiJ5Liq5pWw77yaXG4vLyAxLiDpobXpnaLvvIg9IHdlYnZpZXcg6YKj5LiA6aG177yJ55qEIENTUyDlsLrlr7jkuI4gVVJM77ybXG4vLyAyLiDnlLvluIPlnKjpobXpnaLph4znmoTkvY3nva7kuI7lsLrlr7jvvJtcbi8vIDMuIOiKgueCueeahOefqeW9ou+8iCoq6aG16Z2iIENTUyDlg4/ntKDjgIHlt6bkuIrop5Lljp/ngrkqKu+8ieOAglxuLy9cbi8vICMjIOWdkOagh+WPo+W+hO+8iOWPquWcqOi/memHjOaNoueul+S4gOasoe+8jOS4u+i/m+eoi+mCo+i+ueS4jeWGjeaNoueul++8iVxuLy9cbi8vIGBDYW1lcmEud29ybGRUb1NjcmVlbmAg57uZ55qE5pivKirlsY/luZXnqbrpl7QqKu+8mioq5bem5LiL6KeS5Li65Y6f54K544CBeSDlkJHkuIoqKu+8jFxuLy8g5Y2V5L2N5pivKirnm7jmnLrmuLLmn5Pnm67moIfnmoTlg4/ntKAqKu+8iOS5n+WwseaYr+eUu+W4g+eahCBkZXZpY2Ug5YOP57Sg77yM5LiN5pivIENTUyDlg4/ntKDvvInjgIJcbi8vIOaNouaIkOOAjOmhtemdoiBDU1Mg5YOP57Sg44CB5bem5LiK6KeS5Y6f54K544CN6KaB5Lik5q2l77yaKirpmaTku6UgZHByKirvvIzlho3mioogeSAqKue/u+i/h+adpSoq44CCXG5cbi8qKiDkv53nlZnkuInkvY3lsI/mlbDvvIjlh6DkvZXph4/lpJ/nlKjvvIzkuJTlm57miafph4zlj6/or7vvvInjgIIgKi9cbmZ1bmN0aW9uIHJvdW5kMyh2YWx1ZTogbnVtYmVyKTogbnVtYmVyIHtcbiAgICByZXR1cm4gTWF0aC5yb3VuZCh2YWx1ZSAqIDEwMDApIC8gMTAwMDtcbn1cblxuLyoqIOWPluS4gOS4quWPr+iDveaKm+W8guW4uOeahOaVsOWAvCBnZXR0ZXLjgIIgKi9cbmZ1bmN0aW9uIHNhZmVOdW1iZXIocmVhZDogKCkgPT4gdW5rbm93bik6IG51bWJlciB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVhZCgpO1xuICAgICAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gcm91bmQzKHZhbHVlKSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn1cblxuLyoqIOaKiuWPr+iDveadpeiHqiBJUEMg55qE5pWw5YC85aS55YiwIGBbbWluLCBtYXhdYO+8iOS4jeaYr+aVsOWwseeUqCBgZmFsbGJhY2tg77yJ44CCICovXG5mdW5jdGlvbiBjbGFtcE51bWJlcih2YWx1ZTogdW5rbm93biwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgICBjb25zdCBudW0gPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IGZhbGxiYWNrO1xuICAgIHJldHVybiBNYXRoLm1pbihtYXgsIE1hdGgubWF4KG1pbiwgbnVtKSk7XG59XG5cbi8qKlxuICog6aG16Z2i77yId2Vidmlld++8ieeahCBDU1Mg5Yeg5L2VICsg5a6D6Ieq5bex55qEIFVSTOOAglxuICpcbiAqIGBocmVmYCDmmK8qKuS4u+i/m+eoi+WumuS9jei/meS4qiB3ZWJDb250ZW50cyDnmoTpppbpgInliKTmja4qKu+8mue8lui+keWZqOmHjOWPr+iDveWQjOaXtuacieWlveWHoOS4qlxuICogd2Vidmlld++8iOWcuuaZr+inhuWbvuOAgea4uOaIj+mihOiniOKApu+8ie+8jOaMiSBVUkwg57K+56Gu5Yy56YWN5q+U5oyJ44CM57G75Z6L5pivIHdlYnZpZXfjgI3njJzlj6/pnaDlvpflpJrjgIJcbiAqL1xuZnVuY3Rpb24gcGFnZUdlb21ldHJ5KCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnICYmIHdpbmRvdy5sb2NhdGlvbikge1xuICAgICAgICAgICAgb3V0LmhyZWYgPSB3aW5kb3cubG9jYXRpb24uaHJlZjtcbiAgICAgICAgICAgIG91dC5jc3NXaWR0aCA9IHdpbmRvdy5pbm5lcldpZHRoO1xuICAgICAgICAgICAgb3V0LmNzc0hlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcbiAgICAgICAgICAgIG91dC5kcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOS4jeaYr+a1j+iniOWZqOeOr+Wig+Wwseeul+S6hu+8muS4u+i/m+eoi+S8mumAgOWbnuWIsOaMiSBVUkwg54m55b6B5om+ICovXG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDnlLvluIPlnKjpobXpnaLph4znmoTkvY3nva7vvIhDU1Mg5YOP57Sg77yJKyDlroPnmoQgZGV2aWNlIOWDj+e0oOWwuuWvuOOAgiAqL1xuZnVuY3Rpb24gY2FudmFzR2VvbWV0cnkoY2FudmFzOiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICAgIGlmICghY2FudmFzKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjb25zdCByZWN0ID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgICAgb3V0LmxlZnQgPSByb3VuZDMocmVjdC5sZWZ0KTtcbiAgICAgICAgICAgIG91dC50b3AgPSByb3VuZDMocmVjdC50b3ApO1xuICAgICAgICAgICAgb3V0LmNzc1dpZHRoID0gcm91bmQzKHJlY3Qud2lkdGgpO1xuICAgICAgICAgICAgb3V0LmNzc0hlaWdodCA9IHJvdW5kMyhyZWN0LmhlaWdodCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955Wl77ya6YeP5LiN5Yiw5bCx5bCR5LiA6aG577yM5LiN5b2x5ZON5Yir55qEICovXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIG91dC5kZXZpY2VXaWR0aCA9IGNhbnZhcy53aWR0aDtcbiAgICAgICAgb3V0LmRldmljZUhlaWdodCA9IGNhbnZhcy5oZWlnaHQ7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIOe8lui+keWZqOebuOacuuOAglxuICpcbiAqIGBjY2UuQ2FtZXJhYCDmmK/lnLrmma/pobXph4znmoQqKuWFqOWxgOWNleS+iyoq77yIYGRlY2xhcmUgZ2xvYmFsIHsgbmFtZXNwYWNlIGNjZSB9YO+8jFxuICog6KeB57yW6L6R5Zmo55qEIGBAY29jb3MvY3JlYXRvci10eXBlcy9lZGl0b3IvcGFja2FnZXMvc2NlbmUvQHR5cGVzL3NjZW5lLmQudHNg77yJ77yMXG4gKiDlroPnmoQgYC5jYW1lcmFgIOWwseaYryBgRWRpdG9yQ2FtZXJhQ29tcG9uZW50YCDigJTigJQgKirmnKzouqvlsLHmmK8gYGNjLkNhbWVyYWAqKu+8jFxuICog5omA5LulIGB3b3JsZFRvU2NyZWVuYCDlj6/ku6Xnm7TmjqXnlKjvvIwyRCAvIDNEIOinhuWbvumDveiupOOAglxuICpcbiAqIOi/meWwseaYr+OAjOiKgueCueaIquWbvuOAjee8uueahOmCo+S4gOWdl++8muiAgeWunueOsOWPquefpemBk+aVtOW8oOeUu+W4g++8jOS4jeefpemBk+iKgueCueeUu+WcqOWTquOAglxuICovXG5mdW5jdGlvbiBlZGl0b3JDYW1lcmEoKTogeyBtYW5hZ2VyOiBhbnk7IGNhbTogYW55OyBpczJEOiBib29sZWFuIHwgbnVsbDsgbm90ZT86IHN0cmluZyB9IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBtYW5hZ2VyID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2UgJiYgKGdsb2JhbFRoaXMgYXMgYW55KS5jY2UuQ2FtZXJhO1xuICAgICAgICBpZiAoIW1hbmFnZXIpIHJldHVybiB7IG1hbmFnZXI6IG51bGwsIGNhbTogbnVsbCwgaXMyRDogbnVsbCwgbm90ZTogJ+i/meS4qui/m+eoi+mHjOayoeaciSBjY2UuQ2FtZXJh77yI5Zy65pmv6aG15omN5pyJ77yJJyB9O1xuICAgICAgICBjb25zdCBjYW0gPSBtYW5hZ2VyLmNhbWVyYTtcbiAgICAgICAgaWYgKCFjYW0gfHwgIWNhbS5jYW1lcmEpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG1hbmFnZXIsIGNhbTogbnVsbCwgaXMyRDogbnVsbCwgbm90ZTogJ2NjZS5DYW1lcmEuY2FtZXJhIOi/mOayoeWIneWni+WMlu+8iOWcuuaZr+inhuWbvuWImuaJk+W8gOaXtuS8muaciei/meS4gOeerO+8iScgfTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgaXMyRDogYm9vbGVhbiB8IG51bGwgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBtYW5hZ2VyLmlzMkQgPT09ICdib29sZWFuJykgaXMyRCA9IG1hbmFnZXIuaXMyRDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBtYW5hZ2VyLCBjYW0sIGlzMkQgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHsgbWFuYWdlcjogbnVsbCwgY2FtOiBudWxsLCBpczJEOiBudWxsLCBub3RlOiBg6K+7IGNjZS5DYW1lcmEg5aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICB9XG59XG5cbi8qKlxuICog6IqC54K555qE55+p5b2iIOKAlOKAlCAqKumhtemdoiBDU1Mg5YOP57Sg44CB5bem5LiK6KeS5Li65Y6f54K5KirjgIJcbiAqXG4gKiDlgZrms5XvvJrmioroioLngrnkuJbnlYznn6nlvaLnmoQgNCDkuKrop5LlloLnu5nnvJbovpHlmajnm7jmnLrnmoQgYHdvcmxkVG9TY3JlZW5g77yM5Y+W5YyF5Zu055uS44CCXG4gKiDkuo7mmK/jgIzop4blm77nvKnmlL7kuoYgLyDlubPnp7vkuoYgLyDoioLngrnoh6rlt7HovazkuobjgI3pg73kuI3nlKjmiYvlt6Xmjqgg4oCU4oCUIOebuOacuuWFqOmDveefpemBk+OAglxuICpcbiAqIOS4pOeCueivmuWunueahOi+ueeVjO+8mlxuICogLSDkuJbnlYznn6nlvaLnlKjnmoTmmK/ovbTlr7npvZDljIXlm7Tnm5LvvIhgY29udGVudFNpemUgw5cgd29ybGRTY2FsZWDvvIwqKuS4jeaXi+i9rCoq77yJ77yMXG4gKiAgIOaJgOS7peiKgueCueiHqui6q+W4puaXi+i9rOaXtuaYr+S4gOS4qioq6L+R5Ly8KirvvIjlsY/luZXkuIrku43mmK/ljIXlm7Tnm5LvvIzkuI3mmK/lpJbmjqXlpJrovrnlvaLvvInvvJtcbiAqIC0g5rKh5pyJIGBVSVRyYW5zZm9ybWAg55qE6IqC54K577yI57qvIDNEIOepuuiKgueCue+8ieayoeacieWwuuWvuO+8jCoq57uZ5LiN5Ye655+p5b2iKirvvIxcbiAqICAg6L+Z5pe25aaC5a6e5ZueIGByZWN0OiBudWxsYO+8jOeUseS4u+i/m+eoi+mAgOaIkOaVtOW8oOinhuWbvu+8jOiAjOS4jeaYr+ijgeS4gOS4queejueMnOeahOahhuOAglxuICovXG5mdW5jdGlvbiBwcm9qZWN0Tm9kZVJlY3QoXG4gICAgY2M6IGFueSxcbiAgICBjYW06IGFueSxcbiAgICBub2RlOiBhbnksXG4gICAgY2FudmFzOiBhbnksXG4pOiB7IHJlY3Q6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsOyBjYW52YXNSZWN0OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IHwgbnVsbDsgbm90ZT86IHN0cmluZyB9IHtcbiAgICBjb25zdCB1dCA9IHR5cGVvZiBub2RlLmdldENvbXBvbmVudCA9PT0gJ2Z1bmN0aW9uJyA/IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKSA6IG51bGw7XG4gICAgaWYgKCF1dCkgcmV0dXJuIHsgcmVjdDogbnVsbCwgY2FudmFzUmVjdDogbnVsbCwgbm90ZTogJ+iKgueCueayoeaciSBVSVRyYW5zZm9ybe+8iOayoeaciSBjb250ZW50U2l6Ze+8ie+8jOeul+S4jeWHuuefqeW9oicgfTtcblxuICAgIGxldCB3aWR0aCA9IDA7XG4gICAgbGV0IGhlaWdodCA9IDA7XG4gICAgbGV0IGFuY2hvclggPSAwLjU7XG4gICAgbGV0IGFuY2hvclkgPSAwLjU7XG4gICAgdHJ5IHtcbiAgICAgICAgd2lkdGggPSB1dC53aWR0aCB8fCAwO1xuICAgICAgICBoZWlnaHQgPSB1dC5oZWlnaHQgfHwgMDtcbiAgICAgICAgYW5jaG9yWCA9IHR5cGVvZiB1dC5hbmNob3JYID09PSAnbnVtYmVyJyA/IHV0LmFuY2hvclggOiAwLjU7XG4gICAgICAgIGFuY2hvclkgPSB0eXBlb2YgdXQuYW5jaG9yWSA9PT0gJ251bWJlcicgPyB1dC5hbmNob3JZIDogMC41O1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaXvvJrkv53mjIHpu5jorqQgKi9cbiAgICB9XG5cbiAgICBsZXQgc2NhbGVYID0gMTtcbiAgICBsZXQgc2NhbGVZID0gMTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB3cyA9IG5vZGUud29ybGRTY2FsZTtcbiAgICAgICAgaWYgKHdzKSB7XG4gICAgICAgICAgICBzY2FsZVggPSBNYXRoLmFicyh3cy54KSB8fCAxO1xuICAgICAgICAgICAgc2NhbGVZID0gTWF0aC5hYnMod3MueSkgfHwgMTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaUgKi9cbiAgICB9XG4gICAgY29uc3Qgd29ybGRXaWR0aCA9IHdpZHRoICogc2NhbGVYO1xuICAgIGNvbnN0IHdvcmxkSGVpZ2h0ID0gaGVpZ2h0ICogc2NhbGVZO1xuICAgIGlmICh3b3JsZFdpZHRoIDw9IDAgfHwgd29ybGRIZWlnaHQgPD0gMCkge1xuICAgICAgICByZXR1cm4geyByZWN0OiBudWxsLCBjYW52YXNSZWN0OiBudWxsLCBub3RlOiBg6IqC54K55bC65a+45Li6IDDvvIhjb250ZW50U2l6ZSAke3dpZHRofcOXJHtoZWlnaHR977yJ77yM566X5LiN5Ye655+p5b2iYCB9O1xuICAgIH1cblxuICAgIGxldCB3eCA9IDA7XG4gICAgbGV0IHd5ID0gMDtcbiAgICBsZXQgd3ogPSAwO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHdwID0gbm9kZS53b3JsZFBvc2l0aW9uO1xuICAgICAgICB3eCA9IHdwLng7XG4gICAgICAgIHd5ID0gd3AueTtcbiAgICAgICAgd3ogPSB3cC56O1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4geyByZWN0OiBudWxsLCBjYW52YXNSZWN0OiBudWxsLCBub3RlOiAn6K+75LiN5Yiw6IqC54K555qEIHdvcmxkUG9zaXRpb24nIH07XG4gICAgfVxuICAgIC8vIOmUmueCueWBj+enu++8mndvcmxkUG9zaXRpb24g5pivKirplJrngrkqKueahOS9jee9ru+8jOefqeW9ouS4reW/g+imgeaMiemUmueCueihpeWbnuadpVxuICAgIGNvbnN0IGN4ID0gd3ggKyAoMC41IC0gYW5jaG9yWCkgKiB3b3JsZFdpZHRoO1xuICAgIGNvbnN0IGN5ID0gd3kgKyAoMC41IC0gYW5jaG9yWSkgKiB3b3JsZEhlaWdodDtcblxuICAgIHJldHVybiBwcm9qZWN0V29ybGRCb3goY2MsIGNhbSwgY2FudmFzLCB7IGN4LCBjeSwgd3osIHdpZHRoOiB3b3JsZFdpZHRoLCBoZWlnaHQ6IHdvcmxkSGVpZ2h0IH0pO1xufVxuXG4vKiog5LiA5LiqKirovbTlr7npvZDnmoTkuJbnlYznn6nlvaIqKu+8iCsg5LiA5LiqIHrvvJvmipXlvbHopoHkuInnu7TngrnvvInjgIIgKi9cbmludGVyZmFjZSBXb3JsZEJveCB7XG4gICAgLyoqIOefqeW9ouS4reW/g++8iOS4lueVjOWdkOagh++8iSAqL1xuICAgIGN4OiBudW1iZXI7XG4gICAgY3k6IG51bWJlcjtcbiAgICAvKiog5oqV5b2x55So55qE5rex5bqm77yIMkQg5q2j5Lqk5LiO5a6D5peg5YWz77yMM0Qg6YCP6KeG5pyJ5YWz57O777yJICovXG4gICAgd3o6IG51bWJlcjtcbiAgICB3aWR0aDogbnVtYmVyO1xuICAgIGhlaWdodDogbnVtYmVyO1xufVxuXG4vKipcbiAqIOS4lueVjOefqeW9oiDihpIgKirpobXpnaIgQ1NTIOWDj+e0oCoq55+p5b2i77yI5bem5LiK6KeS5Y6f54K577yJ44CCXG4gKlxuICog5Zub6KeS5ZaC57uZIGB3b3JsZFRvU2NyZWVuYCDlho3lj5bljIXlm7Tnm5Ig4oCU4oCUIOi/meaYr+WFqOW3peeoiyoq5ZSv5LiAKirkuIDlpITlgZrov5nkuKrmjaLnrpfnmoTlnLDmlrnvvIxcbiAqIOOAjOiKgueCueefqeW9ouOAjeS4juOAjOWPluaZr+imhuebluWIpOaNruOAjemDvei1sOWug++8iOS4pOWkhOiLpeWQhOWGmeS4gOS7ve+8jOi/n+aXqeS8muWvueS4jeS4iu+8ieOAglxuICpcbiAqIEByZXR1cm5zIGByZWN0YO+8iOmhtemdouW3puS4iuinkuWOn+eCue+8ieOAgWBjYW52YXNSZWN0YO+8iOeUu+W4g+WGheOAgeebuOWvueeUu+W4g+W3puS4iuinku+8ie+8m1xuICogICDph4/kuI3liLDnm7jmnLrpq5jluqYvZHBy44CB5oiWIGB3b3JsZFRvU2NyZWVuYCDmipvlvILluLjml7YgYHJlY3RgIOS4uiBudWxs44CCXG4gKi9cbmZ1bmN0aW9uIHByb2plY3RXb3JsZEJveChcbiAgICBjYzogYW55LFxuICAgIGNhbTogYW55LFxuICAgIGNhbnZhczogYW55LFxuICAgIGJveDogV29ybGRCb3gsXG4pOiB7IHJlY3Q6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsOyBjYW52YXNSZWN0OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IHwgbnVsbDsgbm90ZT86IHN0cmluZyB9IHtcbiAgICAvKiog5Yeg5L2V5Z+65YeG77yaeSDnv7vovaznlKjnm7jmnLroh6rlt7HnmoTpq5jluqbvvIjnm7jmnLrlg4/ntKDvvInvvIxkcHIg5LuO55S75biD5o6o77yIQ1NTIOKGkCBkZXZpY2XvvIkgKi9cbiAgICBjb25zdCBjYW52YXNCb3ggPSBjYW52YXNHZW9tZXRyeShjYW52YXMpIHx8IHt9O1xuICAgIGNvbnN0IGNhbUhlaWdodCA9IHNhZmVOdW1iZXIoKCkgPT4gY2FtLmNhbWVyYS5oZWlnaHQpIHx8IChjYW52YXNCb3guZGV2aWNlSGVpZ2h0IGFzIG51bWJlcikgfHwgMDtcbiAgICBjb25zdCBjYW52YXNDc3NXaWR0aCA9IChjYW52YXNCb3guY3NzV2lkdGggYXMgbnVtYmVyKSB8fCAwO1xuICAgIGNvbnN0IGNhbnZhc0RldmljZVdpZHRoID0gKGNhbnZhc0JveC5kZXZpY2VXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgY29uc3QgZHByID0gY2FudmFzQ3NzV2lkdGggPiAwICYmIGNhbnZhc0RldmljZVdpZHRoID4gMCA/IGNhbnZhc0RldmljZVdpZHRoIC8gY2FudmFzQ3NzV2lkdGggOiBwYWdlRHByKCk7XG4gICAgaWYgKCFjYW1IZWlnaHQgfHwgIWRwcikge1xuICAgICAgICByZXR1cm4geyByZWN0OiBudWxsLCBjYW52YXNSZWN0OiBudWxsLCBub3RlOiAn6YeP5LiN5Yiw55u45py66auY5bqm5oiWIGRwcu+8jOaXoOazleaKiuWxj+W5leepuumXtOaNouaIkCBDU1Mg5YOP57SgJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IFZlYzMgPSBjYy5WZWMzO1xuICAgIGNvbnN0IHhzOiBudW1iZXJbXSA9IFtdO1xuICAgIGNvbnN0IHlzOiBudW1iZXJbXSA9IFtdO1xuICAgIHRyeSB7XG4gICAgICAgIGZvciAoY29uc3QgZHggb2YgWy0wLjUsIDAuNV0pIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZHkgb2YgWy0wLjUsIDAuNV0pIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwb2ludCA9IGNhbS53b3JsZFRvU2NyZWVuKG5ldyBWZWMzKGJveC5jeCArIGR4ICogYm94LndpZHRoLCBib3guY3kgKyBkeSAqIGJveC5oZWlnaHQsIGJveC53eikpO1xuICAgICAgICAgICAgICAgIHhzLnB1c2gocG9pbnQueCAvIGRwcik7XG4gICAgICAgICAgICAgICAgLy8g5bem5LiL5Y6f54K544CBeSDlkJHkuIog4oaSIOW3puS4iuWOn+eCueOAgXkg5ZCR5LiLXG4gICAgICAgICAgICAgICAgeXMucHVzaCgoY2FtSGVpZ2h0IC0gcG9pbnQueSkgLyBkcHIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IHJlY3Q6IG51bGwsIGNhbnZhc1JlY3Q6IG51bGwsIG5vdGU6IGB3b3JsZFRvU2NyZWVuIOWksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgfVxuXG4gICAgY29uc3QgcmF3ID0ge1xuICAgICAgICB4OiBNYXRoLm1pbiguLi54cyksXG4gICAgICAgIHk6IE1hdGgubWluKC4uLnlzKSxcbiAgICAgICAgd2lkdGg6IE1hdGgubWF4KC4uLnhzKSAtIE1hdGgubWluKC4uLnhzKSxcbiAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCguLi55cykgLSBNYXRoLm1pbiguLi55cyksXG4gICAgfTtcbiAgICBjb25zdCBsZWZ0ID0gKGNhbnZhc0JveC5sZWZ0IGFzIG51bWJlcikgfHwgMDtcbiAgICBjb25zdCB0b3AgPSAoY2FudmFzQm94LnRvcCBhcyBudW1iZXIpIHx8IDA7XG4gICAgY29uc3QgY2FudmFzUmVjdCA9IHtcbiAgICAgICAgeDogcm91bmQzKHJhdy54KSxcbiAgICAgICAgeTogcm91bmQzKHJhdy55KSxcbiAgICAgICAgd2lkdGg6IHJvdW5kMyhyYXcud2lkdGgpLFxuICAgICAgICBoZWlnaHQ6IHJvdW5kMyhyYXcuaGVpZ2h0KSxcbiAgICB9O1xuICAgIGNvbnN0IHJlY3QgPSB7XG4gICAgICAgIHg6IHJvdW5kMyhyYXcueCArIGxlZnQpLFxuICAgICAgICB5OiByb3VuZDMocmF3LnkgKyB0b3ApLFxuICAgICAgICB3aWR0aDogcm91bmQzKHJhdy53aWR0aCksXG4gICAgICAgIGhlaWdodDogcm91bmQzKHJhdy5oZWlnaHQpLFxuICAgIH07XG5cbiAgICAvKiog6Ieq5qOA77ya566X5Ye65p2l55qE5qGG5bqU5b2T6JC95Zyo55S75biD5YaF44CC6LaK55WM6K+05piO5LiK6Z2i6YKj5p2h5Y+j5b6E5Zyo6L+Z5Y+w5py65Zmo5LiK5LiN5oiQ56uL77yM5aaC5a6e5oql5Ye65p2lICovXG4gICAgY29uc3Qgb3V0c2lkZSA9XG4gICAgICAgIGNhbnZhc0Nzc1dpZHRoID4gMCAmJlxuICAgICAgICAocmVjdC54ICsgcmVjdC53aWR0aCA8IDAgfHxcbiAgICAgICAgICAgIHJlY3QueSArIHJlY3QuaGVpZ2h0IDwgMCB8fFxuICAgICAgICAgICAgcmVjdC54ID4gbGVmdCArIGNhbnZhc0Nzc1dpZHRoIHx8XG4gICAgICAgICAgICByZWN0LnkgPiB0b3AgKyAoKGNhbnZhc0JveC5jc3NIZWlnaHQgYXMgbnVtYmVyKSB8fCAwKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgcmVjdCxcbiAgICAgICAgY2FudmFzUmVjdCxcbiAgICAgICAgbm90ZTogb3V0c2lkZVxuICAgICAgICAgICAgPyAn4pqgIOaKleW9seWHuuadpeeahOefqeW9ouiQveWcqOeUu+W4g+Wklu+8iOebuOacuuaIliBkcHIg5Y+j5b6E5Y+v6IO95LiN5oiQ56uL77yJ4oCU4oCUIOivt+aguOWvuSBjYW1lcmEgLyBjYW52YXMg5a2X5q61J1xuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgfTtcbn1cblxuLyoqIOmhtemdouiHquW3seeahCBkcHLvvIjmi7/kuI3liLDnlLvluIPlsLrlr7jml7bnmoTlhZzlupXvvInjgIIgKi9cbmZ1bmN0aW9uIHBhZ2VEcHIoKTogbnVtYmVyIHtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcpIHJldHVybiB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaUgKi9cbiAgICB9XG4gICAgcmV0dXJuIDE7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTGFiZWwg5o6S54mI5bqm6YePIOKAlOKAlCBgbGFiZWxGaXRgIOeahOeul+acr+WfuuehgO+8iOW4uOaVsOWFqOaYryoq5a6e5rWLKirmnaXnmoTvvIzkuI3mmK/mioTmlofmoaPvvIlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy9cbi8vIENvY29zIENyZWF0b3IgMy44LjbvvIznlKjkuIDkuKoqKua4uOemuyBMYWJlbCoq77yIYG5ldyBjYy5Ob2RlKClg77yM5LuO5LiN6L+b5Zy65pmv77yJK1xuLy8gYHVwZGF0ZVJlbmRlckRhdGEodHJ1ZSlgIOmHj+eahOOAguS4ieadoee7k+iuuu+8mlxuLy9cbi8vIDEuICoq6IqC54K55YaF5a656auYKirvvIhgb3ZlcmZsb3cgPSBOT05FIC8gUkVTSVpFX0hFSUdIVGDvvIzljbPlvJXmk47oh6rlt7HmkpHpq5jml7bvvInvvJpcbi8vXG4vLyAgICAgICAgY29udGVudEhlaWdodCA9ICjooYzmlbAg4oiSIDEpIMOXIOihjOi/m+e7mSArIOihjOi/m+e7mSDDlyAxLjI2XG4vL1xuLy8gICAg5YWr57uE5qC35pys5YWo5Lit77yaZnMxNC9saDAv5qGG5a69IDEwMCDlvpfkuKTooYwg4oaSIDMxLjY077yIPSAxNCArIDE3LjY077yJ77ybXG4vLyAgICBmczIwL2xoMC/moYblrr0gMTAwIOW+l+S4pOihjCDihpIgNDUuMu+8iD0gMjAgKyAyNS4y77yJ77ybbGg0MCDkuIDooYwg4oaSIDUwLjTvvJtcbi8vICAgIGxoNjYg5LiA6KGMIOKGkiA4My4xNu+8m2xoMjAvZnMyMCDkuIDooYwg4oaSIDI1LjLjgILkuZ/lsLHmmK/or7Rcbi8vICAgICoq5pyA5ZCO5LiA6KGM5q+U5Yir55qE6KGM5aSaIDAuMjYg5YCN6KGM6L+b57uZKirjgIJcbi8vIDIuICoq6KGM6L+b57uZKirvvIjmr4/lpJrkuIDooYzlvoDkuIvotbDlpJrlsJHvvIk9IGBsaW5lSGVpZ2h0ID4gMCA/IGxpbmVIZWlnaHQgOiBmb250U2l6ZWDjgIJcbi8vICAgIOKaoCBgX2xpbmVIZWlnaHQgPSAwYCDml7blvJXmk47lm57okL3liLAgKipgZm9udFNpemVgKirvvIzkuI3mmK8gYGZvbnRTaXplIMOXIDEuMjZg77ybXG4vLyAgICDogIwgYGxhYmVsLmxpbmVIZWlnaHRgIOi/meS4qiBnZXR0ZXIg5LyaKirljp/moLflm54gMCoqIOKAlOKAlCDmiYDku6XlroMqKuS4jeiDvSoq5b2T5bqm6YeP55SoXG4vLyAgICDvvIjouKnov4fvvJrmi7/lroPnrpflh7pcIuiDveaUviAzIOihjFwi77yM5a6e6ZmF5Y+q5pS+5b6X5LiLIDIg6KGM77yJ44CCXG4vLyAzLiAqKuWtl+espuWuveW6pioq77yIQXJpYWzvvIxlbSDlgI3mlbDvvInvvJpDSksg5LiO5YWo6KeS5qCH54K5IGAxLjAwMGDjgIHlpKflhpkgYDAuNjY3YOOAgVxuLy8gICAg5bCP5YaZ5LiO5pWw5a2XIGAwLjU1NmDjgIHnqbrmoLwgYDAuMjc4YOOAguOAjENKSyA9IDFlbeOAjeaYr+mHj+WHuuadpeeahO+8iGAn5ZWKJ2Ag5ZyoIGZzMjAg5LiL5a69IDIwLjDvvInjgIJcbi8vXG4vLyDimqAg5LiA5p2h6K+a5a6e55qE6L6555WM77ya5LiK6Z2i56ysIDEg5p2h55qE5YWs5byP5piv5LuO44CM5byV5pOO5pKR5Ye65p2l55qE6IqC54K56auY44CN5Y+N5o6o55qE77yMXG4vLyDogIwgYENMQU1QYCDnmoQqKuaIquaWremYiOWAvCoq5oiR55So5LqG5ZCM5LiA5p2h5YWs5byP55qE6YCG77yIYOacgOWkmuihjOaVsCA9IGZsb29yKOahhumrmCAvIOihjOi/m+e7mSDiiJIgMC4yNilg77yJ44CCXG4vLyDlroMqKuWkjeeOsOS6huWunua1i+eahOS4pOS4queOsOWcuioq77yI5qGG6auYIDQ0IC8g6KGM6L+b57uZIDIwLjgg4oaSIOesrCAyIOihjOaVtOihjOiiq+ijgeaOie+8m1xuLy8g5qGG6auYIDcyIC8g6KGM6L+b57uZIDI0IOKGkiAyIOihjOaUvuW+l+S4i+OAgTMg6KGM6KaBIDc4LjI0IOaUvuS4jeS4i++8ie+8jOS9huW8leaTjuWGhemDqOecn+ato+eUqOWTquadoeWIpOaNrlxuLy8gKirmsqHmnInor7vmupDnoIHnoa7orqQqKuOAguaJgOS7pSBgbGFiZWxGaXRgIOaKiueUqOWIsOeahOWFrOW8jyoq5Y6f5qC35YaZ6L+b5Zue5omnKirvvIhgZm9ybXVsYWAg5a2X5q6177yJ77yMXG4vLyDliKvmiorlroPlvZPpu5HnrrHjgIJcblxuLyoqIOW8leaTjuaSkemrmOaXtuOAjOacgOWQjuS4gOihjOOAjeeahOmineWkluezu+aVsCDigJTigJQg6KeB5LiK6Z2i56ysIDEg5p2h77yIOCDnu4TmoLfmnKzlrp7mtYvvvInjgIIgKi9cbmNvbnN0IExBQkVMX0xBU1RfTElORV9GQUNUT1IgPSAxLjI2O1xuXG4vKiog5a2X56ym5a695bqm55qE5YWc5bqV6KGo77yIZW0g5YCN5pWw77yJ44CC6aG16Z2i5LiK5pyJIERPTSDml7bkvJjlhYjotbAgY2FudmFzIGBtZWFzdXJlVGV4dGDvvIzov5nlvKDooajlj6rkvZzlhZzlupXjgIIgKi9cbmNvbnN0IEVNX1dJRFRIOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0geyBjams6IDEsIHVwcGVyOiAwLjY2NywgbG93ZXI6IDAuNTU2LCBkaWdpdDogMC41NTYsIHNwYWNlOiAwLjI3OCB9O1xuXG4vKiog5LiA5Liq5a2X56ym5bGe5LqO5ZOq5LiA57G777yI5Yaz5a6a5YWc5bqV5a695bqm77yJ44CCICovXG5mdW5jdGlvbiBlbUNsYXNzT2YoY2g6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgY29kZSA9IGNoLmNvZGVQb2ludEF0KDApIHx8IDA7XG4gICAgaWYgKGNoID09PSAnICcgfHwgY2ggPT09ICdcXHQnKSByZXR1cm4gJ3NwYWNlJztcbiAgICBpZiAoY29kZSA+PSAweDMwICYmIGNvZGUgPD0gMHgzOSkgcmV0dXJuICdkaWdpdCc7XG4gICAgaWYgKGNvZGUgPj0gMHg0MSAmJiBjb2RlIDw9IDB4NWEpIHJldHVybiAndXBwZXInO1xuICAgIGlmIChjb2RlID49IDB4NjEgJiYgY29kZSA8PSAweDdhKSByZXR1cm4gJ2xvd2VyJztcbiAgICBpZiAoY29kZSA8IDB4MmU4MCkgcmV0dXJuICdsb3dlcic7IC8vIOaLieS4geagh+eCuS/nrKblj7fmjInlsI/lhpnlrr3luqbov5HkvLxcbiAgICByZXR1cm4gJ2Nqayc7IC8vIENKSyAvIOWFqOinkuagh+eCuSAvIOWBh+WQjSAvIOmfqeaWhyDigJTigJQg5LiA5b6LIDFlbVxufVxuXG4vKiog6YeP5paH5a2X55So55qEIDJEIOS4iuS4i+aWh++8iOaooeWdl+e6p+e8k+WtmO+8m+WPluS4jeWIsOWwsSBudWxs77yM6LCD55So5pa56LWw5YWc5bqV6KGo77yJ44CCICovXG5sZXQgbWVhc3VyZUN0eENhY2hlOiBhbnkgPSBudWxsO1xuXG4vKipcbiAqIOaLv+S4gOS4qiAyRCDkuIrkuIvmlofmnaXph4/lrZfjgIJcbiAqXG4gKiDimqAgKirlj6rnvJPlrZjmiJDlip/nmoTnu5PmnpwqKu+8muWksei0peaXtuavj+asoemDvemHjeivleOAgui4qei/h+eahOeQhueUseW+iOWunuWcqCDigJTigJQg5Zy65pmv6aG15Yia5omT5byA55qE6YKj5LiA556sXG4gKiBgZG9jdW1lbnRgIOWPr+iDvei/mOayoeWwsee7qu+8jOWmguaenOmCo+aXtuaKiuOAjOayoeacieS4iuS4i+aWh+OAjee8k+WtmOS4i+adpe+8jOS5i+WQjioq5LiA5pW05bGA6YO96YeP5LiN5LqG5a2XKirvvIxcbiAqIOiAjOeXh+eKtuaYr+OAjOWuveW6puaChOaChOmAgOWMluaIkOS8sOeul+OAjeKAlOKAlOW+iOmavuafpeOAgumHjeivleeahOS7o+S7t+WPquaYr+S4gOasoSBgY3JlYXRlRWxlbWVudGDjgIJcbiAqL1xuZnVuY3Rpb24gbWVhc3VyZUNvbnRleHQoKTogYW55IHtcbiAgICBpZiAobWVhc3VyZUN0eENhY2hlKSByZXR1cm4gbWVhc3VyZUN0eENhY2hlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGRvYyA9IChnbG9iYWxUaGlzIGFzIGFueSkuZG9jdW1lbnQ7XG4gICAgICAgIGlmIChkb2MgJiYgdHlwZW9mIGRvYy5jcmVhdGVFbGVtZW50ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjb25zdCBjYW52YXMgPSBkb2MuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgICAgICAgICBtZWFzdXJlQ3R4Q2FjaGUgPSBjYW52YXMgJiYgdHlwZW9mIGNhbnZhcy5nZXRDb250ZXh0ID09PSAnZnVuY3Rpb24nID8gY2FudmFzLmdldENvbnRleHQoJzJkJykgOiBudWxsO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIG1lYXN1cmVDdHhDYWNoZSA9IG51bGw7XG4gICAgfVxuICAgIHJldHVybiBtZWFzdXJlQ3R4Q2FjaGU7XG59XG5cbi8qKlxuICog5LiA5q615paH5a2X55qE5a695bqm77yIcHjvvInjgIJcbiAqXG4gKiAqKuaciSBET00g5bCx55yf6YePKirvvIhgY3R4Lm1lYXN1cmVUZXh0YO+8jOS4juW8leaTjiBUVEYg5o6S54mI5ZCM5LiA5oqK5bC65a2Q77yJ77yM5rKh5pyJ5omN55So5YWc5bqV6KGo5Lyw44CCXG4gKiDlm57miafph4zluKYgYG1ldGhvZGDvvIzosIPnlKjmlrnkuIDnnLznnIvlvpflh7rov5nkuKrmlbDmmK/ph4/lh7rmnaXnmoTov5jmmK/kvLDlh7rmnaXnmoTjgIJcbiAqL1xuZnVuY3Rpb24gbWVhc3VyZVRleHRXaWR0aChcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZm9udFNpemU6IG51bWJlcixcbiAgICBmb250RmFtaWx5OiBzdHJpbmcsXG4pOiB7IHdpZHRoOiBudW1iZXI7IG1ldGhvZDogJ2NhbnZhcycgfCAnZXN0aW1hdGUnIH0ge1xuICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCA9PSBudWxsID8gJycgOiB0ZXh0KTtcbiAgICBpZiAocy5sZW5ndGggPT09IDAgfHwgIShmb250U2l6ZSA+IDApKSByZXR1cm4geyB3aWR0aDogMCwgbWV0aG9kOiAnZXN0aW1hdGUnIH07XG4gICAgY29uc3QgY3R4ID0gbWVhc3VyZUNvbnRleHQoKTtcbiAgICBpZiAoY3R4KSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjdHguZm9udCA9IGAke2ZvbnRTaXplfXB4ICR7Zm9udEZhbWlseSB8fCAnQXJpYWwnfWA7XG4gICAgICAgICAgICBjb25zdCB3aWR0aCA9IGN0eC5tZWFzdXJlVGV4dChzKS53aWR0aDtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygd2lkdGggPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh3aWR0aCkpIHJldHVybiB7IHdpZHRoLCBtZXRob2Q6ICdjYW52YXMnIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog6JC95Yiw5YWc5bqV6KGoICovXG4gICAgICAgIH1cbiAgICB9XG4gICAgbGV0IHRvdGFsID0gMDtcbiAgICBmb3IgKGNvbnN0IGNoIG9mIHMpIHRvdGFsICs9IChFTV9XSURUSFtlbUNsYXNzT2YoY2gpXSB8fCAwLjU1NikgKiBmb250U2l6ZTtcbiAgICByZXR1cm4geyB3aWR0aDogdG90YWwsIG1ldGhvZDogJ2VzdGltYXRlJyB9O1xufVxuXG4vKipcbiAqIOW/q+eFp+S7kyDigJTigJQgKirlv4XpobvmmK/mqKHlnZfnuqfnmoQqKuOAglxuICpcbiAqIGBtYWtlSGVscGVycygpYCDmr4/ot5HkuIDmrrXku6PnoIHlsLHph43lu7rkuIDmrKHpl63ljIXvvIzmlL7lnKjpl63ljIXph4znmoTkuJzopb/kuIvkuIDmrrXku6PnoIHlsLHnnIvkuI3op4HkuobvvJtcbiAqIOiAjOOAjOaUueS5i+WJjeWtmOS4gOS7veOAgeaUueS5i+WQjiBkaWZm44CN5aSp55Sf6Leo5Lik5qyh6LCD55So44CC5omA5Lul5a2Y5Zyo5qih5Z2X5L2c55So5Z+f77yM5oyJIGBsYWJlbGAg5Y+W55So44CCXG4gKi9cbmNvbnN0IHNuYXBzaG90U3RvcmUgPSBuZXcgTWFwPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCk7XG5cbi8qKiDmnIDlpJrnlZnlh6Dku73lv6vnhafvvIjotoXkuobmt5jmsbDmnIDml6fnmoTvvInjgILlpJ/jgIxiZWZvcmUvYWZ0ZXLjgI3nlKjvvIzlj4jkuI3kvJrmiorlnLrmma/ov5vnqIvmkpHog5bjgIIgKi9cbmNvbnN0IFNOQVBTSE9UX0tFRVAgPSAxMjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlj5bmma/vvIhmcmFtaW5n77yJ4oCU4oCUIOOAjOaKiuimgeaLjeeahOS4nOilv+WFiOahhui/m+eUu+W4g++8jOaIquWujOWGjei/mOWOn+inhuinkuOAjVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gIyMg5Li65LuA5LmI5b+F6aG75pyJ6L+Z5LiA5q61XG4vL1xuLy8gYGNhcHR1cmVQYWdlKClgIOaKk+eahOaYryoq5bGP5bmV5LiK546w5Zyo6L+Z5LiA5binKirjgILkuo7mmK/nlKjmiLfmiorlnLrmma/op4blm77nvKnmlL4v5bmz56e76L+H5LmL5ZCO77yMXG4vLyDmipPliLDnmoTlsLHlj6rmmK/ku5blvZPml7bnnIvnmoTpgqPlnZflnLDmlrkg4oCU4oCUIOaDs+aIquOAjOaVtOS4quWcuuaZr+OAjeaXtumCo+S4jeaYr+WFqOiyjFxuLy8g77yI5a6e5rWL77yaNzIww5cxNTYwIOeahOiuvuiuoeWIhui+qOeOh++8jOeUqOaIt+e8qeWIsCAyMDAlIOeci+S4gOW8oOWNoe+8jOaIquWbvumHjOWwseWPquaciemCo+W8oOWNoe+8ieOAglxuLy9cbi8vIOiAjOWcuuaZr+i/m+eoi+aJi+mHjOaciee8lui+keWZqOebuOacuu+8jCoq6IO95pS55a6D55qE5Y+W5pmvKirvvJrlhYjmoYbkvY/opoHmi43nmoTkuJzopb8g4oaSIOaIquWbviDihpIg6L+Y5Y6f44CCXG4vL1xuLy8gIyMg5LiJ57qn5Y+W5pmv77ya5oyJ44CM6LCB55qE5pa55rOV5pu05q2j57uf44CN5o6S5bqP77yM6YCQ57qnKirph4/nnYDpqowqKu+8jOmqjOS4jei/h+aJjemZjee6p1xuLy9cbi8vIHwgc3RlcCB8IOWBmuazlSB8IOS4uuS7gOS5iOaOkui/meS4quS9jee9riB8XG4vLyB8LS0tfC0tLXwtLS18XG4vLyB8IDAgfCBgY2NlLkNhbWVyYS5mb2N1cyh1dWlkcywgdW5kZWZpbmVkLCB0cnVlKWAgfCDnvJbovpHlmajoh6rlt7HnmoTjgIxGIOiBmueEpuOAjeOAguWug+WGhemDqOS8muWQjOatpSAyRC8zRCDmjqfliLblmajnmoTnirbmgIHvvIjnvZHmoLwv5qCH5bC6L+WQjue7reS6pOS6kumDveS4jeS8mumUmeS9je+8ie+8jCoq6aaW6YCJKiogfFxuLy8gfCAxIHwgYGNvbnRyb2xsZXIyRC5fYWRqdXN0VG9DZW50ZXIobWFyZ2luLCByZWN0LCB0cnVlKWAgfCAyRCDmjqfliLblmajoh6rlt7HnmoTjgIzpgILphY3lhoXlrrnjgI3vvIzmmL7lvI/kvKDmiJHku6znrpflh7rmnaXnmoTnn6nlvaIg4oCU4oCUIOe7leW8gCBmb2N1cyDpgqPlpZfljIXlm7Tnm5Llj6PlvoQgfFxuLy8gfCAyIHwgKirmiYvlt6UqKu+8iOS7hSAyRCDmraPkuqTvvIkgfCDph4/lh7rjgIzlg4/ntKAv5LiW55WM5Y2V5L2N44CN5YaN5oqKIGBvcnRob0hlaWdodGAg5LiO55u45py65L2N572u566X5Zue5Y6744CC4pqgIOWug+S8mioq57uV6L+H5o6n5Yi25ZmoKirvvIzmjqfliLblmajlhoXpg6jorrDnmoTop4bop5LkuI7nnJ/lrp7op4bop5LkvJrmmoLml7bkuI3kuIDoh7Qg4oCU4oCUIOaJgOS7peWPquWcqCAwLzEg6YO95qGG5LiN5YWo5pe25omN55SoIHxcbi8vXG4vLyDmr4/nuqflgZrlrozpg73opoEqKumHjeaWsOmHj+S4gOmBjSoq77yIYHZpZXdNZXRyaWNzYCDnmoQgYGZyYW1pbmdg77yJ77ya5Yik5o2u5piv44CM55uu5qCH55qE55+p5b2i5piv5LiN5pivXG4vLyDmlbTkuKrokL3lnKjnlLvluIPph4zjgI3vvIzph4/kuI3ov4flsLHpmY3nuqfjgILov5nmoLflsLHkuI3lv4XnjJznvJbovpHlmajlhoXpg6jmgI7kuYjnrpfnmoQg4oCU4oCUIOesrOS4gOe6p+iDveaIkOWwseS4jeS8mueUqOWIsOesrOS6jOe6p+OAglxuLy9cbi8vICMjIOi/mOWOn+aYryoq5b+F6aG7KirnmoRcbi8vXG4vLyDnlKjmiLfop4bop5LkuI3og73ooqvmiJHku6znlZnlnKjliKvlpITjgIJgZml0Vmlldyh7YWN0aW9uOidlbmQnfSlgIOWFiOivlee8lui+keWZqOiHquW3seeahFxuLy8gYGZvY3VzKG51bGwsIHNhdmVkSW5mbywgdHJ1ZSlg77yM5LiN6KGM5YaN5oqK55u45py65a2X5q6155u05o6l5YaZ5Zue77yM5Lik5p2h6YO95LiN6KGM5bCx5aaC5a6e5ZueXG4vLyBgcmVzdG9yZWQ6ZmFsc2Vg77yIKirliKvlgYfoo4Xov5jljp/kuoYqKiDigJTigJQg6YKj5Lya6K6p55So5oi35Lul5Li655S76Z2i5rKh5Yqo6L+H77yJ44CCXG4vL1xuLy8gIyMg5Z2Q5qCH57O7XG4vL1xuLy8g55uu5qCH55qE55+p5b2i57uf5LiA55SoKirkuJbnlYzlnZDmoIcqKu+8iHkg5ZCR5LiK77yJ5o+P6L+w77yM5oqV5b2x5Y+q6LWwIGBwcm9qZWN0V29ybGRCb3hgIOS4gOWkhO+8m1xuLy8g5Yik44CM5ouN5YWo5LqG5rKh5pyJ44CN55So55qE5pivKirpobXpnaIgQ1NTIOWDj+e0oCoq55qE55+p5b2i5LiO55S75biD55+p5b2i77yIYGNhbnZhc0dlb21ldHJ5YO+8ie+8jFxuLy8g5LiO6KOB5YiHL+iQveebmOmCo+adoemTvui3r+WQjOS4gOWPo+W+hOOAglxuXG4vKiog5Y+W5pmv5pe25YaF5a655Zub5ZGo55WZ55qE56m655m95q+U5L6L77yI55u45a+555S75biD55+t6L6577yJ4oCU4oCUIOi0tOi+ueS8muiuqeaPj+i+uS/pmLTlvbHooqvliIfmjonjgIIgKi9cbmNvbnN0IEZJVF9NQVJHSU4gPSAwLjA4O1xuXG4vKiog55u45py65YOP57Sg6YeM5YWB6K6455qE44CM5rKh5ouN5YWo44CN5a655beu77ya5oqV5b2x5LiO55yf5a6e5riy5p+T5LmL6Ze055qE6IiN5YWl5LiN5YC85b6X5Yik5oiQ5aSx6LSl44CCICovXG5jb25zdCBDT1ZFUkFHRV9UT0xFUkFOQ0VfUFggPSAyO1xuXG4vKiog5omL5bel5Y+W5pmv5pe26YeP5pac546H55qE5o6i6ZKI6ZW/5bqm77yI5LiW55WM5Y2V5L2N77yJ4oCU4oCUIOWPluWkp+S4gOeCuei6suW8gOa1rueCueWZquWjsOOAgiAqL1xuY29uc3QgUFJPQkVfVU5JVFMgPSAxMDA7XG5cbi8qKiBgZml0YCDnmoTnm67moIfmj4/ov7DvvIjkuLvov5vnqIvlj6ror7TopoHmi43jgIzlnLrmma/jgI3ov5jmmK/jgIzmn5DkuKroioLngrnjgI3vvInjgIIgKi9cbmludGVyZmFjZSBGaXRTcGVjIHtcbiAgICBraW5kOiAnc2NlbmUnIHwgJ25vZGUnO1xuICAgIC8qKiBga2luZDogJ25vZGUnYCDml7bnmoToioLngrnlvJXnlKjvvIh1dWlkIOaIlui3r+W+hO+8iSAqL1xuICAgIHJlZjogc3RyaW5nO1xufVxuXG4vKiog6Kej5p6Q5Li76L+b56iL5Lyg5p2l55qEIGBmaXRgIOWtl+aute+8m+iupOS4jeWHuuWwseWbniBudWxs77yIPSDkuI3lj5bmma/vvInjgIIgKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUZpdFNwZWMocmF3OiB1bmtub3duKTogRml0U3BlYyB8IG51bGwge1xuICAgIGNvbnN0IHZhbHVlID0gcmF3IGFzIHsga2luZD86IHVua25vd247IHJlZj86IHVua25vd24gfSB8IG51bGw7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBraW5kID0gdmFsdWUua2luZCA9PT0gJ25vZGUnID8gJ25vZGUnIDogdmFsdWUua2luZCA9PT0gJ3NjZW5lJyA/ICdzY2VuZScgOiBudWxsO1xuICAgIGlmICgha2luZCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHsga2luZCwgcmVmOiB0eXBlb2YgdmFsdWUucmVmID09PSAnc3RyaW5nJyA/IHZhbHVlLnJlZi50cmltKCkgOiAnJyB9O1xufVxuXG4vKiog6aG16Z2i5LiK55S75biD55qE5L2N572u5LiO5bC65a+477yIKirpobXpnaIgQ1NTIOWDj+e0oCoq77yJ4oCU4oCUIOOAjOaLjeWFqOS6huayoeacieOAjeeahOWPgueFp+ezu+OAgiAqL1xuZnVuY3Rpb24gdmlld3BvcnRPZihjYW52YXM6IGFueSk6IHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBjb25zdCBib3ggPSBjYW52YXNHZW9tZXRyeShjYW52YXMpO1xuICAgIGlmICghYm94KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB3aWR0aCA9IChib3guY3NzV2lkdGggYXMgbnVtYmVyKSB8fCAwO1xuICAgIGNvbnN0IGhlaWdodCA9IChib3guY3NzSGVpZ2h0IGFzIG51bWJlcikgfHwgMDtcbiAgICBpZiAod2lkdGggPD0gMCB8fCBoZWlnaHQgPD0gMCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHsgeDogKGJveC5sZWZ0IGFzIG51bWJlcikgfHwgMCwgeTogKGJveC50b3AgYXMgbnVtYmVyKSB8fCAwLCB3aWR0aCwgaGVpZ2h0IH07XG59XG5cbi8qKlxuICog44CM6L+Z5Liq55+p5b2i5ouN5YWo5LqG5rKh5pyJ44CN4oCU4oCUIOWPluaZr+mTvueahCoq5ZSv5LiA5Yik5o2uKirjgIJcbiAqXG4gKiBAcGFyYW0gcGFnZVJlY3QgLSDnm67moIfnn6nlvaLvvIjpobXpnaIgQ1NTIOWDj+e0oO+8ieOAglxuICogQHBhcmFtIHZpZXdwb3J0IC0g55S75biD55+p5b2i77yI6aG16Z2iIENTUyDlg4/ntKDvvInjgIJcbiAqIEByZXR1cm5zIGBjb3ZlcmVkYO+8iOWbm+i+uemDveWcqOeUu+W4g+WGhe+8jOWuueW3riAycHjvvInjgIFgZWRnZXNg77yI5Zub6L6555qEKirlhoXkvqfkvZnph48qKu+8jOi0n+aVsCA9IOi2heWHuuWkmuWwke+8ieOAgVxuICogICBgYXJlYVJhdGlvYO+8iOS4jueUu+W4g+eahCoq5Lqk6ZuGKirpnaLnp6/ljaDmr5Qg4oCU4oCUIOi3keWHuuWxj+W5leeahOWGheWuueS4jeiDveaLv+iHquW3seeahOmdouenr+WFheaVsO+8ieOAglxuICovXG5mdW5jdGlvbiBjb3ZlcmFnZU9mKFxuICAgIHBhZ2VSZWN0OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LFxuICAgIHZpZXdwb3J0OiB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9LFxuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGVkZ2VzID0ge1xuICAgICAgICBsZWZ0OiByb3VuZDMocGFnZVJlY3QueCAtIHZpZXdwb3J0LngpLFxuICAgICAgICByaWdodDogcm91bmQzKHZpZXdwb3J0LnggKyB2aWV3cG9ydC53aWR0aCAtIChwYWdlUmVjdC54ICsgcGFnZVJlY3Qud2lkdGgpKSxcbiAgICAgICAgdG9wOiByb3VuZDMocGFnZVJlY3QueSAtIHZpZXdwb3J0LnkpLFxuICAgICAgICBib3R0b206IHJvdW5kMyh2aWV3cG9ydC55ICsgdmlld3BvcnQuaGVpZ2h0IC0gKHBhZ2VSZWN0LnkgKyBwYWdlUmVjdC5oZWlnaHQpKSxcbiAgICB9O1xuICAgIGNvbnN0IGNvdmVyZWQgPVxuICAgICAgICBlZGdlcy5sZWZ0ID49IC1DT1ZFUkFHRV9UT0xFUkFOQ0VfUFggJiZcbiAgICAgICAgZWRnZXMucmlnaHQgPj0gLUNPVkVSQUdFX1RPTEVSQU5DRV9QWCAmJlxuICAgICAgICBlZGdlcy50b3AgPj0gLUNPVkVSQUdFX1RPTEVSQU5DRV9QWCAmJlxuICAgICAgICBlZGdlcy5ib3R0b20gPj0gLUNPVkVSQUdFX1RPTEVSQU5DRV9QWDtcbiAgICBjb25zdCBpeCA9IE1hdGgubWF4KFxuICAgICAgICAwLFxuICAgICAgICBNYXRoLm1pbihwYWdlUmVjdC54ICsgcGFnZVJlY3Qud2lkdGgsIHZpZXdwb3J0LnggKyB2aWV3cG9ydC53aWR0aCkgLSBNYXRoLm1heChwYWdlUmVjdC54LCB2aWV3cG9ydC54KSxcbiAgICApO1xuICAgIGNvbnN0IGl5ID0gTWF0aC5tYXgoXG4gICAgICAgIDAsXG4gICAgICAgIE1hdGgubWluKHBhZ2VSZWN0LnkgKyBwYWdlUmVjdC5oZWlnaHQsIHZpZXdwb3J0LnkgKyB2aWV3cG9ydC5oZWlnaHQpIC0gTWF0aC5tYXgocGFnZVJlY3QueSwgdmlld3BvcnQueSksXG4gICAgKTtcbiAgICBjb25zdCB2aWV3QXJlYSA9IHZpZXdwb3J0LndpZHRoICogdmlld3BvcnQuaGVpZ2h0O1xuICAgIHJldHVybiB7XG4gICAgICAgIGNvdmVyZWQsXG4gICAgICAgIGFyZWFSYXRpbzogdmlld0FyZWEgPiAwID8gTWF0aC5yb3VuZCgoKGl4ICogaXkpIC8gdmlld0FyZWEpICogMTAwMCkgLyAxMDAwIDogMCxcbiAgICAgICAgZWRnZXMsXG4gICAgfTtcbn1cblxuLyoqIOWPluaZr+eahOebruagh++8muimgeijhei/m+eUu+W4g+eahOmCo+Wdl+S4lueVjOefqeW9oiArIOS6pOe7mee8lui+keWZqOiBmueEpueahCB1dWlk44CCICovXG5pbnRlcmZhY2UgRml0VGFyZ2V0IHtcbiAgICBzcGVjOiBGaXRTcGVjO1xuICAgIC8qKiDnm67moIfnmoTkuJbnlYznn6nlvaLvvJvnrpfkuI3lh7rmnaXml7bkuLogbnVsbO+8iOS4jeeejue8luS4gOS4quahhu+8iSAqL1xuICAgIHdvcmxkOiB7IGN4OiBudW1iZXI7IGN5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gfCBudWxsO1xuICAgIC8qKiDkuqTnu5kgYGZvY3VzKClgIOeahCB1dWlk77yI5YaF5a655qC56IqC54K5IC8g55uu5qCH6IqC54K56Ieq5bex77yJICovXG4gICAgdXVpZHM6IHN0cmluZ1tdO1xuICAgIC8qKiDov5nlnZfnn6nlvaLmmK/ku47lk6rmnaXnmoTvvIjlm57miafph4zlhpnmuIXmpZrjgIzlj5bmma/ph4/nmoTliLDlupXmmK/lk6rlnZfjgI3vvIkgKi9cbiAgICBzb3VyY2U6IHN0cmluZztcbiAgICBub3RlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIOaKiiBge2tpbmQsIHJlZn1gIOino+aekOaIkOOAjOS4gOWdl+S4lueVjOefqeW9oiArIOS4gOS4siB1dWlk44CN44CCXG4gKlxuICogLSBgc2NlbmVg77yaYGhlbHBlcnMuY29udGVudEJvdW5kcygpYO+8iOecn+WunuWGheWuueeahOW5tumbhu+8jOingeWug+eahOazqOmHiu+8ie+8m1xuICogLSBgbm9kZWDvvJrnm67moIfoioLngrnoh6rlt7HnmoQgYHdvcmxkUmVjdGDjgIJcbiAqL1xuZnVuY3Rpb24gZml0VGFyZ2V0T2YoaGVscGVyczogUmVjb3JkPHN0cmluZywgYW55Piwgc3BlYzogRml0U3BlYywgbm9kZTogYW55KTogRml0VGFyZ2V0IHtcbiAgICBpZiAoc3BlYy5raW5kID09PSAnbm9kZScpIHtcbiAgICAgICAgaWYgKCFub2RlKSB7XG4gICAgICAgICAgICByZXR1cm4geyBzcGVjLCB3b3JsZDogbnVsbCwgdXVpZHM6IFtdLCBzb3VyY2U6ICdub2RlJywgbm90ZTogYOayoeaJvuWIsOiKgueCueOAjCR7c3BlYy5yZWZ944CNYCB9O1xuICAgICAgICB9XG4gICAgICAgIGxldCByZWN0OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZWN0ID0gaGVscGVycy53b3JsZFJlY3Qobm9kZSkgYXMgUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBzcGVjLCB3b3JsZDogbnVsbCwgdXVpZHM6IFtdLCBzb3VyY2U6ICdub2RlLndvcmxkUmVjdCcsIG5vdGU6IGDnrpfoioLngrnnn6nlvaLlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHdpZHRoID0gdHlwZW9mIHJlY3Qud2lkdGggPT09ICdudW1iZXInID8gcmVjdC53aWR0aCA6IDA7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IHR5cGVvZiByZWN0LmhlaWdodCA9PT0gJ251bWJlcicgPyByZWN0LmhlaWdodCA6IDA7XG4gICAgICAgIGlmICh3aWR0aCA8PSAwIHx8IGhlaWdodCA8PSAwKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHNwZWMsXG4gICAgICAgICAgICAgICAgd29ybGQ6IG51bGwsXG4gICAgICAgICAgICAgICAgdXVpZHM6IG5vZGUudXVpZCA/IFtub2RlLnV1aWRdIDogW10sXG4gICAgICAgICAgICAgICAgc291cmNlOiAnbm9kZS53b3JsZFJlY3QnLFxuICAgICAgICAgICAgICAgIG5vdGU6IGDoioLngrnmsqHmnInlsLrlr7jvvIgke3dpZHRofcOXJHtoZWlnaHR977yJ77yM5rKh5rOV5Y+W5pmvYCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHNwZWMsXG4gICAgICAgICAgICB3b3JsZDogeyBjeDogcmVjdC5jeCwgY3k6IHJlY3QuY3ksIHdpZHRoLCBoZWlnaHQgfSxcbiAgICAgICAgICAgIHV1aWRzOiBub2RlLnV1aWQgPyBbbm9kZS51dWlkXSA6IFtdLFxuICAgICAgICAgICAgc291cmNlOiAnbm9kZS53b3JsZFJlY3QnLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGxldCBib3VuZHM6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBib3VuZHMgPSBoZWxwZXJzLmNvbnRlbnRCb3VuZHMoKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBzcGVjLCB3b3JsZDogbnVsbCwgdXVpZHM6IFtdLCBzb3VyY2U6ICdjb250ZW50Qm91bmRzJywgbm90ZTogYOeul+WGheWuueWMheWbtOebkuWksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgfVxuICAgIGNvbnN0IHdpZHRoID0gdHlwZW9mIGJvdW5kcy53aWR0aCA9PT0gJ251bWJlcicgPyBib3VuZHMud2lkdGggOiAwO1xuICAgIGNvbnN0IGhlaWdodCA9IHR5cGVvZiBib3VuZHMuaGVpZ2h0ID09PSAnbnVtYmVyJyA/IGJvdW5kcy5oZWlnaHQgOiAwO1xuICAgIGNvbnN0IHV1aWRzID0gQXJyYXkuaXNBcnJheShib3VuZHMudXVpZHMpID8gYm91bmRzLnV1aWRzLmZpbHRlcigodTogdW5rbm93bikgPT4gdHlwZW9mIHUgPT09ICdzdHJpbmcnKSA6IFtdO1xuICAgIGlmICh3aWR0aCA8PSAwIHx8IGhlaWdodCA8PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzcGVjLFxuICAgICAgICAgICAgd29ybGQ6IG51bGwsXG4gICAgICAgICAgICB1dWlkcyxcbiAgICAgICAgICAgIHNvdXJjZTogJ2NvbnRlbnRCb3VuZHMnLFxuICAgICAgICAgICAgbm90ZTogJ+WcuuaZr+mHjOayoeacieW4piBVSVRyYW5zZm9ybSDnmoTlhoXlrrnoioLngrnvvIzph4/kuI3lh7rlhoXlrrnojIPlm7TvvIjlj5bmma/ot7Pov4fvvIknLFxuICAgICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgICBzcGVjLFxuICAgICAgICB3b3JsZDogeyBjeDogYm91bmRzLmN4LCBjeTogYm91bmRzLmN5LCB3aWR0aCwgaGVpZ2h0IH0sXG4gICAgICAgIHV1aWRzLFxuICAgICAgICBzb3VyY2U6ICdjb250ZW50Qm91bmRzJyxcbiAgICAgICAgbm90ZTogdHlwZW9mIGJvdW5kcy5ub3RlID09PSAnc3RyaW5nJyA/IGJvdW5kcy5ub3RlIDogdW5kZWZpbmVkLFxuICAgIH07XG59XG5cbi8qKiDnm7jmnLrnmoTjgIzop4bop5Lnrb7lkI3jgI3igJTigJQg5Zue5omn6YeM57uZ5a6D77yM6L+Y5Y6f5oiQ5Yqf5LiO5ZCm5Lmf55So5a6D5Yik44CCICovXG5mdW5jdGlvbiBjYW1lcmFTaWduYXR1cmUoY2FtOiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcbiAgICBjb25zdCBub2RlID0gY2FtICYmIGNhbS5ub2RlID8gY2FtLm5vZGUgOiBudWxsO1xuICAgIGlmIChub2RlKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwID0gbm9kZS53b3JsZFBvc2l0aW9uO1xuICAgICAgICAgICAgaWYgKHApIG91dC5wb3NpdGlvbiA9IHsgeDogcm91bmQzKHAueCksIHk6IHJvdW5kMyhwLnkpLCB6OiByb3VuZDMocC56KSB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByID0gbm9kZS53b3JsZFJvdGF0aW9uO1xuICAgICAgICAgICAgaWYgKHIpIG91dC5yb3RhdGlvbiA9IHsgeDogcm91bmQzKHIueCksIHk6IHJvdW5kMyhyLnkpLCB6OiByb3VuZDMoci56KSwgdzogcm91bmQzKHIudykgfTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBvcnRob0hlaWdodCA9IHNhZmVOdW1iZXIoKCkgPT4gY2FtLm9ydGhvSGVpZ2h0KTtcbiAgICBpZiAob3J0aG9IZWlnaHQgIT09IG51bGwpIG91dC5vcnRob0hlaWdodCA9IG9ydGhvSGVpZ2h0O1xuICAgIGNvbnN0IGZvdiA9IHNhZmVOdW1iZXIoKCkgPT4gY2FtLmZvdik7XG4gICAgaWYgKGZvdiAhPT0gbnVsbCkgb3V0LmZvdiA9IGZvdjtcbiAgICBjb25zdCBwcm9qZWN0aW9uID0gc2FmZU51bWJlcigoKSA9PiBjYW0ucHJvamVjdGlvbik7XG4gICAgaWYgKHByb2plY3Rpb24gIT09IG51bGwpIG91dC5wcm9qZWN0aW9uID0gcHJvamVjdGlvbjtcbiAgICByZXR1cm4gb3V0O1xufVxuXG4vKiog5Lik5Liq6KeG6KeS562+5ZCN5piv5LiN5piv44CM5ZCM5LiA5Liq6KeG6KeS44CN77yI5a655beu5pS+5a695Yiw44CM6IKJ55y85YiG5LiN5Ye644CN55qE6YeP57qn77yJ44CCICovXG5mdW5jdGlvbiBzYW1lQ2FtZXJhKGE6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsLCBiOiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbCk6IGJvb2xlYW4ge1xuICAgIGlmICghYSB8fCAhYikgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHBhID0gYS5wb3NpdGlvbjtcbiAgICBjb25zdCBwYiA9IGIucG9zaXRpb247XG4gICAgaWYgKHBhICYmIHBiKSB7XG4gICAgICAgIGlmIChNYXRoLmFicyhwYS54IC0gcGIueCkgPiAwLjUgfHwgTWF0aC5hYnMocGEueSAtIHBiLnkpID4gMC41IHx8IE1hdGguYWJzKHBhLnogLSBwYi56KSA+IDAuNSkgcmV0dXJuIGZhbHNlO1xuICAgIH0gZWxzZSBpZiAoQm9vbGVhbihwYSkgIT09IEJvb2xlYW4ocGIpKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgaGEgPSBhLm9ydGhvSGVpZ2h0O1xuICAgIGNvbnN0IGhiID0gYi5vcnRob0hlaWdodDtcbiAgICBpZiAodHlwZW9mIGhhID09PSAnbnVtYmVyJyB8fCB0eXBlb2YgaGIgPT09ICdudW1iZXInKSB7XG4gICAgICAgIGlmICh0eXBlb2YgaGEgIT09ICdudW1iZXInIHx8IHR5cGVvZiBoYiAhPT0gJ251bWJlcicpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3Qgc2NhbGUgPSBNYXRoLm1heChNYXRoLmFicyhoYSksIE1hdGguYWJzKGhiKSwgMWUtNik7XG4gICAgICAgIGlmIChNYXRoLmFicyhoYSAtIGhiKSAvIHNjYWxlID4gMC4wMDUpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBhLmZvdiA9PT0gJ251bWJlcicgJiYgdHlwZW9mIGIuZm92ID09PSAnbnVtYmVyJyAmJiBNYXRoLmFicyhhLmZvdiAtIGIuZm92KSA+IDAuMDEpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCByYSA9IGEucm90YXRpb247XG4gICAgY29uc3QgcmIgPSBiLnJvdGF0aW9uO1xuICAgIGlmIChyYSAmJiByYikge1xuICAgICAgICBjb25zdCBkb3QgPSByYS54ICogcmIueCArIHJhLnkgKiByYi55ICsgcmEueiAqIHJiLnogKyByYS53ICogcmIudztcbiAgICAgICAgaWYgKE1hdGguYWJzKGRvdCkgPCAwLjk5OTkpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiDlj5bmma/liY3nmoTnm7jmnLrnirbmgIHvvIjov5jljp/nmoTmnaXmupDvvInjgIIgKi9cbmludGVyZmFjZSBTYXZlZENhbWVyYSB7XG4gICAgc2lnbmF0dXJlOiBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgIC8qKiDnvJbovpHlmajoh6rlt7HnmoTop4bop5Lkv6Hmga/vvIhgY2NlLkNhbWVyYS5nZXRDdXJDYW1lcmFJbmZvKClg77yJ4oCU4oCUIOi/mOWOn+eahOmmlumAiei+k+WFpSAqL1xuICAgIGluZm86IGFueSB8IG51bGw7XG4gICAgLyoqIOebuOacuuWtl+aute+8iGBmb2N1c2Ag6L+Y5Y6f5LiN5LqG5pe255qE5YWc5bqV5p2l5rqQ77yJICovXG4gICAgcmF3OiB7IG9ydGhvSGVpZ2h0OiBudW1iZXIgfCBudWxsOyBmb3Y6IG51bWJlciB8IG51bGw7IHByb2plY3Rpb246IG51bWJlciB8IG51bGwgfTtcbn1cblxuZnVuY3Rpb24gc2F2ZUNhbWVyYVN0YXRlKG1hbmFnZXI6IGFueSwgY2FtOiBhbnkpOiBTYXZlZENhbWVyYSB7XG4gICAgbGV0IGluZm86IGFueSA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBtYW5hZ2VyLmdldEN1ckNhbWVyYUluZm8gPT09ICdmdW5jdGlvbicpIGluZm8gPSBtYW5hZ2VyLmdldEN1ckNhbWVyYUluZm8oKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgaW5mbyA9IG51bGw7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIHNpZ25hdHVyZTogY2FtZXJhU2lnbmF0dXJlKGNhbSksXG4gICAgICAgIGluZm8sXG4gICAgICAgIHJhdzoge1xuICAgICAgICAgICAgb3J0aG9IZWlnaHQ6IHNhZmVOdW1iZXIoKCkgPT4gY2FtLm9ydGhvSGVpZ2h0KSxcbiAgICAgICAgICAgIGZvdjogc2FmZU51bWJlcigoKSA9PiBjYW0uZm92KSxcbiAgICAgICAgICAgIHByb2plY3Rpb246IHNhZmVOdW1iZXIoKCkgPT4gY2FtLnByb2plY3Rpb24pLFxuICAgICAgICB9LFxuICAgIH07XG59XG5cbi8qKiDnm7TmjqXmiornm7jmnLrlrZfmrrXlhpnlm57ljrvvvIjlhZzlupXov5jljp/vvInjgIJAcmV0dXJucyDlh7rpl67popjml7bnmoTor7TmmI7vvJvpobrliKnliJkgbnVsbOOAgiAqL1xuZnVuY3Rpb24gd3JpdGVCYWNrQ2FtZXJhKGNhbTogYW55LCBzYXZlZDogU2F2ZWRDYW1lcmEpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBwcm9ibGVtczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBub2RlID0gY2FtICYmIGNhbS5ub2RlID8gY2FtLm5vZGUgOiBudWxsO1xuICAgIGNvbnN0IHNpZyA9IHNhdmVkLnNpZ25hdHVyZTtcbiAgICBpZiAobm9kZSAmJiBzaWcucG9zaXRpb24pIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHAgPSBzaWcucG9zaXRpb247XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5vZGUuc2V0V29ybGRQb3NpdGlvbiA9PT0gJ2Z1bmN0aW9uJykgbm9kZS5zZXRXb3JsZFBvc2l0aW9uKHAueCwgcC55LCBwLnopO1xuICAgICAgICAgICAgZWxzZSBub2RlLndvcmxkUG9zaXRpb24gPSBwO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHByb2JsZW1zLnB1c2goYOS9jee9ruWGmeWbnuWksei0pe+8iCR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX3vvIlgKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAobm9kZSAmJiBzaWcucm90YXRpb24pIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBzaWcucm90YXRpb247XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5vZGUuc2V0V29ybGRSb3RhdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IFF1YXQgPSAoZ2V0Q2MoKSBhcyBhbnkpLlF1YXQ7XG4gICAgICAgICAgICAgICAgbm9kZS5zZXRXb3JsZFJvdGF0aW9uKG5ldyBRdWF0KHIueCwgci55LCByLnosIHIudykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHByb2JsZW1zLnB1c2goYOacneWQkeWGmeWbnuWksei0pe+8iCR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX3vvIlgKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoc2F2ZWQucmF3Lm9ydGhvSGVpZ2h0ICE9PSBudWxsKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjYW0ub3J0aG9IZWlnaHQgPSBzYXZlZC5yYXcub3J0aG9IZWlnaHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcHJvYmxlbXMucHVzaChgb3J0aG9IZWlnaHQg5YaZ5Zue5aSx6LSl77yIJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfe+8iWApO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChzYXZlZC5yYXcuZm92ICE9PSBudWxsKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjYW0uZm92ID0gc2F2ZWQucmF3LmZvdjtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiAyRCDnm7jmnLrmsqHmnIkgZm92IOaYr+ato+W4uOeahCAqL1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChzYXZlZC5yYXcucHJvamVjdGlvbiAhPT0gbnVsbCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2FtLnByb2plY3Rpb24gPSBzYXZlZC5yYXcucHJvamVjdGlvbjtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlkIzkuIogKi9cbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcHJvYmxlbXMubGVuZ3RoID4gMCA/IHByb2JsZW1zLmpvaW4oJ++8mycpIDogbnVsbDtcbn1cblxuLyoqXG4gKiDov5jljp/op4bop5LvvJrlhYjotbDnvJbovpHlmajoh6rlt7HnmoTpgJrpgZPvvIzkuI3ooYzlho3nm7TmjqXlhpnlm57nm7jmnLrlrZfmrrXjgIJcbiAqXG4gKiDkuKTmnaHot6/pg73lpLHotKXml7YqKuWmguWunuWbniBgcmVzdG9yZWQ6ZmFsc2VgKiog4oCU4oCUIOiwg+eUqOaWueS8muaKiuWug+WGmei/m+WbnuaJp++8jFxuICog55So5oi35bCx55+l6YGTXCLmiJHnmoTop4bop5LooqvnlZnlnKjlj5bmma/lkI7nmoTkvY3nva7kuobvvIzmjIkgRiDmiJblj4zlh7voioLngrnlj6/ku6Xlm57ljrtcIuOAglxuICovXG5mdW5jdGlvbiByZXN0b3JlQ2FtZXJhU3RhdGUoXG4gICAgbWFuYWdlcjogYW55LFxuICAgIGNhbTogYW55LFxuICAgIHNhdmVkOiBTYXZlZENhbWVyYSxcbik6IHsgcmVzdG9yZWQ6IGJvb2xlYW47IG1ldGhvZDogJ2luZm8nIHwgJ3JhdycgfCBudWxsOyBhZnRlcjogUmVjb3JkPHN0cmluZywgYW55Pjsgbm90ZT86IHN0cmluZyB9IHtcbiAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoc2F2ZWQuaW5mbykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbWFuYWdlci5mb2N1cyhudWxsLCBzYXZlZC5pbmZvLCB0cnVlKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGBmb2N1cyhudWxsLCBpbmZvKSDov5jljp/lpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYWZ0ZXJJbmZvID0gY2FtZXJhU2lnbmF0dXJlKGNhbSk7XG4gICAgICAgIGlmIChzYW1lQ2FtZXJhKGFmdGVySW5mbywgc2F2ZWQuc2lnbmF0dXJlKSkgcmV0dXJuIHsgcmVzdG9yZWQ6IHRydWUsIG1ldGhvZDogJ2luZm8nLCBhZnRlcjogYWZ0ZXJJbmZvIH07XG4gICAgICAgIG5vdGVzLnB1c2goJ2ZvY3VzKG51bGwsIGluZm8pIOayoeiDveaKiuinhuinkui/mOWOn+WbnuWOn+agtycpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG5vdGVzLnB1c2goJ+aLv+S4jeWIsOe8lui+keWZqOinhuinkuS/oeaBr++8iGdldEN1ckNhbWVyYUluZm8g5LiN5Y+v55So77yJ77yM5Y+q6IO955u05o6l5YaZ5Zue55u45py65a2X5q61Jyk7XG4gICAgfVxuXG4gICAgY29uc3Qgd3JpdGVOb3RlID0gd3JpdGVCYWNrQ2FtZXJhKGNhbSwgc2F2ZWQpO1xuICAgIGlmICh3cml0ZU5vdGUpIG5vdGVzLnB1c2god3JpdGVOb3RlKTtcbiAgICBjb25zdCBhZnRlclJhdyA9IGNhbWVyYVNpZ25hdHVyZShjYW0pO1xuICAgIGlmIChzYW1lQ2FtZXJhKGFmdGVyUmF3LCBzYXZlZC5zaWduYXR1cmUpKSByZXR1cm4geyByZXN0b3JlZDogdHJ1ZSwgbWV0aG9kOiAncmF3JywgYWZ0ZXI6IGFmdGVyUmF3IH07XG4gICAgbm90ZXMucHVzaCgn55u05o6l5YaZ5Zue55u45py65a2X5q615Lmf5rKh6IO96L+Y5Y6fJyk7XG4gICAgcmV0dXJuIHsgcmVzdG9yZWQ6IGZhbHNlLCBtZXRob2Q6IG51bGwsIGFmdGVyOiBhZnRlclJhdywgbm90ZTogbm90ZXMuam9pbign77ybJykgfTtcbn1cblxuLyoqXG4gKiDmiYvlt6Xlj5bmma/vvIgqKuS7hSAyRCDmraPkuqQqKu+8ie+8mumHj+WHuuOAjOebuOacuuWDj+e0oCAvIOS4lueVjOWNleS9jeOAjeWGjeaKiuebuOacuuaRhuWbnuWOu+OAglxuICpcbiAqIOS4pOatpe+8jOmDveS4jeWBh+iuvuW8leaTjuWGhemDqOaAjuS5iOeul+eahO+8mlxuICogMS4gKirnvKnmlL4qKu+8mmBvcnRob0hlaWdodGAg5LiO44CM5YOP57SgL+S4lueVjOWNleS9jeOAjeaIkOWPjeavlO+8iOato+S6pOaKleW9semHjOWPr+ingeS4lueVjOmrmOW6piA9IDLCt29ydGhvSGVpZ2h077yJ77yMXG4gKiAgICDmiYDku6XmjIkqKumHj+WHuuadpeeahCoq5q+U5YC857yp5LiA5LiL5Y2z5Y+vIOKAlOKAlCDkuI3nlKjnn6XpgZPlroPliLDlupXmmK/ljYrpq5jov5jmmK/lhajpq5jvvJtcbiAqIDIuICoq5a+55LitKirvvJrmiorlhoXlrrnkuK3lv4PmipXliLDlsY/luZXkuIrvvIznnIvlroPnprvop4blj6PkuK3lv4Plt67lpJrlsJHlg4/ntKDvvIzlho3mjInmlpznjofmjaLmiJDkuJbnlYzljZXkvY3mjKrnm7jmnLrjgIJcbiAqICAgICoq5pac546H5piv6YeP5Ye65p2l55qEKirvvIjmipXlvbHkuKTkuKrnm7jot50gMTAwIOS4lueVjOWNleS9jeeahOeCue+8ie+8jOaJgOS7pVwi55u45py65pyd5ZOq6L6555yLIC8g5bGP5bmVIHkg5pyd5ZOq6L65XCJcbiAqICAgIOmDveS4jeeUqOWBh+iuvu+8m+mHj+S4gOasoee6oOS4gOasoe+8jOS4pOasoeWwseaUtuaVm+OAglxuICovXG5mdW5jdGlvbiBtYW51YWxPcnRob0ZpdChcbiAgICBjYzogYW55LFxuICAgIGNhbTogYW55LFxuICAgIHdvcmxkOiB7IGN4OiBudW1iZXI7IGN5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0sXG4gICAgbWFyZ2luOiBudW1iZXIsXG4pOiB7IG9rOiBib29sZWFuOyBub3RlPzogc3RyaW5nOyBkZXRhaWw/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9IHtcbiAgICBjb25zdCB3aWR0aCA9IHNhZmVOdW1iZXIoKCkgPT4gY2FtLmNhbWVyYS53aWR0aCkgfHwgMDtcbiAgICBjb25zdCBoZWlnaHQgPSBzYWZlTnVtYmVyKCgpID0+IGNhbS5jYW1lcmEuaGVpZ2h0KSB8fCAwO1xuICAgIGNvbnN0IG9ydGhvSGVpZ2h0ID0gc2FmZU51bWJlcigoKSA9PiBjYW0ub3J0aG9IZWlnaHQpO1xuICAgIGNvbnN0IG5vZGUgPSBjYW0gJiYgY2FtLm5vZGUgPyBjYW0ubm9kZSA6IG51bGw7XG4gICAgaWYgKCF3aWR0aCB8fCAhaGVpZ2h0IHx8ICFvcnRob0hlaWdodCB8fCAhbm9kZSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIG5vdGU6ICfph4/kuI3liLDnm7jmnLrlsLrlr7gvb3J0aG9IZWlnaHQg5oiW5ou/5LiN5Yiw55u45py66IqC54K577yM5omL5bel5Y+W5pmv6Lez6L+HJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IFZlYzMgPSBjYy5WZWMzO1xuICAgIGNvbnN0IHByb2plY3QgPSAoeDogbnVtYmVyLCB5OiBudW1iZXIpOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfCBudWxsID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHBvaW50ID0gY2FtLndvcmxkVG9TY3JlZW4obmV3IFZlYzMoeCwgeSwgMCkpO1xuICAgICAgICAgICAgcmV0dXJuIHsgeDogcG9pbnQueCwgeTogcG9pbnQueSB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IHByb2JlID0gKCk6IHsga3g6IG51bWJlcjsga3k6IG51bWJlcjsgY2VudGVyOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfSB8IG51bGwgPT4ge1xuICAgICAgICBjb25zdCBwMCA9IHByb2plY3Qod29ybGQuY3gsIHdvcmxkLmN5KTtcbiAgICAgICAgY29uc3QgcHggPSBwcm9qZWN0KHdvcmxkLmN4ICsgUFJPQkVfVU5JVFMsIHdvcmxkLmN5KTtcbiAgICAgICAgY29uc3QgcHkgPSBwcm9qZWN0KHdvcmxkLmN4LCB3b3JsZC5jeSArIFBST0JFX1VOSVRTKTtcbiAgICAgICAgaWYgKCFwMCB8fCAhcHggfHwgIXB5KSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3Qga3ggPSAocHgueCAtIHAwLngpIC8gUFJPQkVfVU5JVFM7XG4gICAgICAgIGNvbnN0IGt5ID0gKHB5LnkgLSBwMC55KSAvIFBST0JFX1VOSVRTO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShreCkgfHwgIU51bWJlci5pc0Zpbml0ZShreSkgfHwga3ggPT09IDAgfHwga3kgPT09IDApIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4geyBreCwga3ksIGNlbnRlcjogcDAgfTtcbiAgICB9O1xuXG4gICAgY29uc3QgZmlyc3QgPSBwcm9iZSgpO1xuICAgIGlmICghZmlyc3QpIHJldHVybiB7IG9rOiBmYWxzZSwgbm90ZTogJ3dvcmxkVG9TY3JlZW4g6YeP5LiN5Ye644CM5YOP57SgL+S4lueVjOWNleS9jeOAje+8iOebuOacuuWPr+iDvei/mOayoeWHhuWkh+Wlve+8iScgfTtcblxuICAgIC8qKiDikaAg57yp5pS+77ya6K6p55uu5qCH55+p5b2i5Zyo55WZ55m95LmL5ZCO5Yia5aW96KOF6L+b55S75biDICovXG4gICAgY29uc3Qgd2FudEsgPSBNYXRoLm1pbihcbiAgICAgICAgKHdpZHRoICogKDEgLSBtYXJnaW4gKiAyKSkgLyAod29ybGQud2lkdGggPiAwID8gd29ybGQud2lkdGggOiAxKSxcbiAgICAgICAgKGhlaWdodCAqICgxIC0gbWFyZ2luICogMikpIC8gKHdvcmxkLmhlaWdodCA+IDAgPyB3b3JsZC5oZWlnaHQgOiAxKSxcbiAgICApO1xuICAgIHRyeSB7XG4gICAgICAgIGNhbS5vcnRob0hlaWdodCA9IG9ydGhvSGVpZ2h0ICogKGZpcnN0Lmt4IC8gd2FudEspO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIG5vdGU6IGDlhpkgb3J0aG9IZWlnaHQg5aSx6LSl77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICB9XG5cbiAgICAvKiog4pGhIOWvueS4re+8mumHj+aui+S9mSDihpIg5oyJ5pac546H5oyq55u45py677yM5Lik5qyh77yI5q2j5Lqk5piv57q/5oCn55qE77yM5Lik5qyh6Laz5aSf5pS25pWb5Yiw5Lqa5YOP57Sg77yJICovXG4gICAgbGV0IHJlc2lkdWFsOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDI7IGkgKz0gMSkge1xuICAgICAgICBjb25zdCBtZWFzdXJlZCA9IHByb2JlKCk7XG4gICAgICAgIGlmICghbWVhc3VyZWQpIGJyZWFrO1xuICAgICAgICByZXNpZHVhbCA9IHsgeDogd2lkdGggLyAyIC0gbWVhc3VyZWQuY2VudGVyLngsIHk6IGhlaWdodCAvIDIgLSBtZWFzdXJlZC5jZW50ZXIueSB9O1xuICAgICAgICAvLyDiiIJzY3JlZW4v4oiC55u45py65L2N572uID0g4oiSKOKIgnNjcmVlbi/iiILkuJbnlYzkvY3nva4p77yM5omA5Lul6Zmk5LulIOKIkmtcbiAgICAgICAgY29uc3QgZHggPSByZXNpZHVhbC54IC8gLW1lYXN1cmVkLmt4O1xuICAgICAgICBjb25zdCBkeSA9IHJlc2lkdWFsLnkgLyAtbWVhc3VyZWQua3k7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwb3MgPSBub2RlLndvcmxkUG9zaXRpb247XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5vZGUuc2V0V29ybGRQb3NpdGlvbiA9PT0gJ2Z1bmN0aW9uJykgbm9kZS5zZXRXb3JsZFBvc2l0aW9uKHBvcy54ICsgZHgsIHBvcy55ICsgZHksIHBvcy56KTtcbiAgICAgICAgICAgIGVsc2Ugbm9kZS53b3JsZFBvc2l0aW9uID0geyB4OiBwb3MueCArIGR4LCB5OiBwb3MueSArIGR5LCB6OiBwb3MueiB9O1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbm90ZTogYOaMquebuOacuuWksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgICBzY2FsZTogcm91bmQzKG9ydGhvSGVpZ2h0ICogKGZpcnN0Lmt4IC8gd2FudEspKSxcbiAgICAgICAgICAgIHB4UGVyVW5pdEJlZm9yZTogcm91bmQzKGZpcnN0Lmt4KSxcbiAgICAgICAgICAgIHB4UGVyVW5pdFdhbnRlZDogcm91bmQzKHdhbnRLKSxcbiAgICAgICAgICAgIGNlbnRlclJlc2lkdWFsUHg6IHJlc2lkdWFsID8geyB4OiByb3VuZDMocmVzaWR1YWwueCksIHk6IHJvdW5kMyhyZXNpZHVhbC55KSB9IDogbnVsbCxcbiAgICAgICAgfSxcbiAgICB9O1xufVxuXG4vKiog5LiA5qyh5Y+W5pmv55qE546w5Zy677yI562J552A6KKr6L+Y5Y6f55qE6KeG6KeS77yJ44CC5ZCM5LiA5pe25Yi75Y+q5YWB6K645LiA5LiqIOKAlOKAlCDmiKrlm77mmK/kuLLooYznmoTjgIIgKi9cbmxldCBwZW5kaW5nRml0OiB7IHRva2VuOiBzdHJpbmc7IHNhdmVkOiBTYXZlZENhbWVyYTsgc3RhcnRlZEF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuXG4vKiog5Y+W5pmv546w5Zy66LaF6L+H6L+Z5Liq5pe26Ze06L+Y5rKh6KKr6L+Y5Y6f5bCx5L2c5bqf77yI5Yir5oqK5Yeg5YiG6ZKf5YmN55qE5pen6KeG6KeS55uW5Zue55So5oi36IS45LiK77yJ44CCICovXG5jb25zdCBGSVRfU1RBVEVfVFRMX01TID0gNjBfMDAwO1xuXG4vKiog5Y+W5pmvIHRva2VuIOeahOiHquWinuWwvuW3tO+8iOWQjOS4gOavq+enkuWGheWkmuasoeWPluaZr+S5n+iDveWMuuWIhu+8ieOAgiAqL1xubGV0IGZpdENvdW50ZXIgPSAwO1xuXG5pbnRlcmZhY2UgRml0Vmlld1BheWxvYWQge1xuICAgIC8qKiBgJ2ZpdCdg77yI6buY6K6k77yJ5pGG5LiA57qn5Y+W5pmvIC8gYCdlbmQnYCDov5jljp/op4bop5IgKi9cbiAgICBhY3Rpb24/OiB1bmtub3duO1xuICAgIC8qKiDlj5bmma/nuqfliKvvvIgwID0g57yW6L6R5ZmoIGZvY3VzIC8gMSA9IOaOp+WItuWZqOmAgumFjSAvIDIgPSDmiYvlt6XvvIkgKi9cbiAgICBzdGVwPzogdW5rbm93bjtcbiAgICAvKiog5Y+W5pmv55uu5qCHIGB7a2luZDonc2NlbmUnfCdub2RlJywgcmVmP31gICovXG4gICAgZml0PzogdW5rbm93bjtcbiAgICAvKiogYGtpbmQ6J25vZGUnYCDml7bnmoToioLngrnlvJXnlKjvvIjkuZ/lj6/lhpnlnKggYGZpdC5yZWZgIOmHjO+8iSAqL1xuICAgIG5vZGU/OiB1bmtub3duO1xuICAgIHByb2plY3RQYXRoPzogdW5rbm93bjtcbn1cblxuLyoqIOaJp+ihjOesrCBgc3RlcGAg57qn5Y+W5pmv44CCQHJldHVybnMgYG1ldGhvZDogbnVsbGAgPSDov5nkuIDnuqfmsqHlgZrmiJDvvIjljp/lm6DlnKggbm90Ze+8iSAqL1xuZnVuY3Rpb24gYXBwbHlGaXRTdGVwKFxuICAgIGNjOiBhbnksXG4gICAgbWFuYWdlcjogYW55LFxuICAgIGNhbTogYW55LFxuICAgIHN0ZXA6IG51bWJlcixcbiAgICB0YXJnZXQ6IEZpdFRhcmdldCxcbiAgICBpczJEOiBib29sZWFuIHwgbnVsbCxcbik6IHsgbWV0aG9kOiAnZm9jdXMnIHwgJ2FkanVzdCcgfCAnbWFudWFsJyB8IG51bGw7IG5vdGU/OiBzdHJpbmc7IGRldGFpbD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0ge1xuICAgIGlmICghdGFyZ2V0LndvcmxkKSByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6IHRhcmdldC5ub3RlIHx8ICfmsqHmnInlj6/nlKjnmoTkuJbnlYznn6nlvaLvvIzlj5bmma/ot7Pov4cnIH07XG5cbiAgICBpZiAoc3RlcCA9PT0gMCkge1xuICAgICAgICBpZiAodHlwZW9mIG1hbmFnZXIuZm9jdXMgIT09ICdmdW5jdGlvbicpIHJldHVybiB7IG1ldGhvZDogbnVsbCwgbm90ZTogJ2NjZS5DYW1lcmEuZm9jdXMg5LiN5a2Y5Zyo77yI57yW6L6R5Zmo54mI5pys5beu5byC77yJJyB9O1xuICAgICAgICBpZiAodGFyZ2V0LnV1aWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiAn5rKh5pyJ5Y+v6IGa54Sm55qEIHV1aWTvvIjlhoXlrrnoioLngrnmsqHmnIkgdXVpZO+8n++8iScgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG1hbmFnZXIuZm9jdXModGFyZ2V0LnV1aWRzLCB1bmRlZmluZWQsIHRydWUpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG1ldGhvZDogbnVsbCwgbm90ZTogYGNjZS5DYW1lcmEuZm9jdXMg5oqb5byC5bi477yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBtZXRob2Q6ICdmb2N1cycgfTtcbiAgICB9XG5cbiAgICBpZiAoc3RlcCA9PT0gMSkge1xuICAgICAgICBpZiAoaXMyRCAhPT0gdHJ1ZSkgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiAn6Z2eIDJEIOinhuWbvuayoeaciSBfYWRqdXN0VG9DZW50ZXLvvIgzRCDlj6rotbAgZm9jdXPvvIknIH07XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBtYW5hZ2VyLmNvbnRyb2xsZXIyRDtcbiAgICAgICAgaWYgKCFjb250cm9sbGVyIHx8IHR5cGVvZiBjb250cm9sbGVyLl9hZGp1c3RUb0NlbnRlciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiAnY2NlLkNhbWVyYS5jb250cm9sbGVyMkQuX2FkanVzdFRvQ2VudGVyIOS4jeWtmOWcqO+8iOe8lui+keWZqOeJiOacrOW3ruW8gu+8iScgfTtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVjdCA9IG5ldyBjYy5SZWN0KFxuICAgICAgICAgICAgICAgIHRhcmdldC53b3JsZC5jeCAtIHRhcmdldC53b3JsZC53aWR0aCAvIDIsXG4gICAgICAgICAgICAgICAgdGFyZ2V0LndvcmxkLmN5IC0gdGFyZ2V0LndvcmxkLmhlaWdodCAvIDIsXG4gICAgICAgICAgICAgICAgdGFyZ2V0LndvcmxkLndpZHRoLFxuICAgICAgICAgICAgICAgIHRhcmdldC53b3JsZC5oZWlnaHQsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY29udHJvbGxlci5fYWRqdXN0VG9DZW50ZXIoRklUX01BUkdJTiwgcmVjdCwgdHJ1ZSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgbWV0aG9kOiBudWxsLCBub3RlOiBgX2FkanVzdFRvQ2VudGVyIOaKm+W8guW4uO+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgbWV0aG9kOiAnYWRqdXN0JyB9O1xuICAgIH1cblxuICAgIGlmIChzdGVwID09PSAyKSB7XG4gICAgICAgIGlmIChpczJEICE9PSB0cnVlKSByZXR1cm4geyBtZXRob2Q6IG51bGwsIG5vdGU6ICfmiYvlt6Xlj5bmma/lj6rlrp7njrDkuoYgMkQg5q2j5Lqk77yIM0Qg6KaB5YqoIEZPVi/ot53nprvvvIzlhYjkuI3lgZrvvIknIH07XG4gICAgICAgIGNvbnN0IGFwcGxpZWQgPSBtYW51YWxPcnRob0ZpdChjYywgY2FtLCB0YXJnZXQud29ybGQsIEZJVF9NQVJHSU4pO1xuICAgICAgICByZXR1cm4geyBtZXRob2Q6IGFwcGxpZWQub2sgPyAnbWFudWFsJyA6IG51bGwsIG5vdGU6IGFwcGxpZWQubm90ZSwgZGV0YWlsOiBhcHBsaWVkLmRldGFpbCB9O1xuICAgIH1cblxuICAgIHJldHVybiB7IG1ldGhvZDogbnVsbCwgbm90ZTogYOayoeacieesrCAke3N0ZXB9IOe6p+WPluaZr2AgfTtcbn1cblxuLyoqIDJEIOiDveeUqOS4iee6p++8jDNEIOWPquaciSBmb2N1cyDkuIDnuqfvvIjlhbbkvZnkuKTnuqfpg73msqHlrp7njrAv5LiN6YCC55So77yJ44CCICovXG5mdW5jdGlvbiBtYXhGaXRTdGVwcyhpczJEOiBib29sZWFuIHwgbnVsbCk6IG51bWJlciB7XG4gICAgcmV0dXJuIGlzMkQgPT09IHRydWUgPyAzIDogMTtcbn1cblxuaW50ZXJmYWNlIFZpZXdNZXRyaWNzUGF5bG9hZCB7XG4gICAgLyoqIOiKgueCuSB1dWlkIOaIlui3r+W+hO+8iOWmgiBgJ0NhbnZhcy9za2lsbF9kZXRhaWxzJ2DvvInvvJvkuI3nu5nlsLHlj6rlm57op4blm77lh6DkvZUgKi9cbiAgICBub2RlPzogdW5rbm93bjtcbiAgICBwcm9qZWN0UGF0aD86IHVua25vd247XG4gICAgLyoqIOimgeOAjOaLjeWFqOOAjeeahOebruagh++8iGB7a2luZDonc2NlbmUnfCdub2RlJywgcmVmP31g77yJ4oCU4oCUIOWGs+WumiBgZnJhbWluZ2Ag6YeP55qE5piv5ZOq5Z2X55+p5b2iICovXG4gICAgZml0PzogdW5rbm93bjtcbn1cblxuLyoqXG4gKiDlnLrmma/op4blm77lh6DkvZXvvIhgY29udHJpYnV0aW9ucy5zY2VuZWAg55qEIGB2aWV3TWV0cmljc2DvvInjgIJcbiAqXG4gKiBAcmV0dXJucyBge29rLCBwYWdlLCBjYW52YXMsIHZpZXcsIGNhbWVyYSwgbm9kZT8sIGZyYW1pbmc/fWAg4oCU4oCUIOS4u+i/m+eoi+aLv+Wug+WumuS9jVxuICogICB3ZWJDb250ZW50c+OAgeaNoueul+ijgeWIh+efqeW9ou+8m2Bub2RlLnJlY3RgIOaYryoq6aG16Z2iIENTUyDlg4/ntKAqKu+8iOW3puS4iuinkuWOn+eCue+8ie+8m1xuICogICDnu5nkuoYgYGZpdGAg5pe25YaN5aSa5LiA6aG5IGBmcmFtaW5nYO+8mioq55uu5qCH5pyJ5rKh5pyJ5pW05Liq6JC95Zyo55S75biD6YeMKirvvIjlj5bmma/pk77nmoTliKTmja7vvInjgIJcbiAqL1xuZnVuY3Rpb24gY29sbGVjdFZpZXdNZXRyaWNzKGNjOiBhbnksIHBheWxvYWQ6IFZpZXdNZXRyaWNzUGF5bG9hZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBjYW52YXMgPSBmaW5kVmlld0NhbnZhcyhjYyk7XG4gICAgY29uc3QgY2FtZXJhID0gZWRpdG9yQ2FtZXJhKCk7XG4gICAgY29uc3QgY2FtID0gY2FtZXJhLmNhbTtcblxuICAgIGNvbnN0IG1ldHJpY3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgcGFnZTogcGFnZUdlb21ldHJ5KCksXG4gICAgICAgIGNhbnZhczogY2FudmFzR2VvbWV0cnkoY2FudmFzKSxcbiAgICAgICAgdmlldzogY2FudmFzID8gcmVhZFZpZXdTdGF0ZShjYywgY2FudmFzKSA6IG51bGwsXG4gICAgICAgIGNhbWVyYToge1xuICAgICAgICAgICAgYXZhaWxhYmxlOiBCb29sZWFuKGNhbSksXG4gICAgICAgICAgICBpczJEOiBjYW1lcmEuaXMyRCxcbiAgICAgICAgICAgIG5vdGU6IGNhbWVyYS5ub3RlLFxuICAgICAgICAgICAgLi4uKGNhbVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzYWZlTnVtYmVyKCgpID0+IGNhbS5jYW1lcmEud2lkdGgpLFxuICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc2FmZU51bWJlcigoKSA9PiBjYW0uY2FtZXJhLmhlaWdodCksXG4gICAgICAgICAgICAgICAgICAgICAgb3J0aG9IZWlnaHQ6IHNhZmVOdW1iZXIoKCkgPT4gY2FtLm9ydGhvSGVpZ2h0KSxcbiAgICAgICAgICAgICAgICAgICAgICBzY3JlZW5TY2FsZTogc2FmZU51bWJlcigoKSA9PiBjYW0uc2NyZWVuU2NhbGUpLFxuICAgICAgICAgICAgICAgICAgICAgIHNpZ25hdHVyZTogY2FtZXJhU2lnbmF0dXJlKGNhbSksXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlZiA9IHR5cGVvZiBwYXlsb2FkLm5vZGUgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5ub2RlLnRyaW0oKSA6ICcnO1xuICAgIGNvbnN0IGZpdFNwZWMgPSBub3JtYWxpemVGaXRTcGVjKHBheWxvYWQuZml0KTtcbiAgICBpZiAoIXJlZiAmJiAhZml0U3BlYykgcmV0dXJuIG1ldHJpY3M7XG5cbiAgICBjb25zdCBoZWxwZXJzID0gbWFrZUhlbHBlcnMoY2MsIHtcbiAgICAgICAgcHJvamVjdFBhdGg6IHR5cGVvZiBwYXlsb2FkLnByb2plY3RQYXRoID09PSAnc3RyaW5nJyA/IHBheWxvYWQucHJvamVjdFBhdGggOiAnJyxcbiAgICB9KS5oZWxwZXJzIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgICBsZXQgbm9kZTogYW55ID0gbnVsbDtcbiAgICBpZiAocmVmKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBub2RlID0gaGVscGVycy5ub2RlQnlVdWlkKHJlZikgfHwgaGVscGVycy5ub2RlQnlQYXRoKHJlZikgfHwgbnVsbDtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBtZXRyaWNzLm5vZGUgPSB7IHJlZiwgZm91bmQ6IGZhbHNlLCBub3RlOiBg5oyJIHV1aWQv6Lev5b6E5om+6IqC54K55pe25Ye66ZSZ77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWAgfTtcbiAgICAgICAgICAgIHJldHVybiBtZXRyaWNzO1xuICAgICAgICB9XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgbWV0cmljcy5ub2RlID0ge1xuICAgICAgICAgICAgICAgIHJlZixcbiAgICAgICAgICAgICAgICBmb3VuZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgbm90ZTogJ+aMiSB1dWlkIOS4jui3r+W+hOmDveayoeaJvuWIsOi/meS4quiKgueCue+8iHV1aWQg55SoIG5vZGUudXVpZO+8jOi3r+W+hOWmgiBDYW52YXMvc2tpbGxfZGV0YWlsc++8iScsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcmV0dXJuIG1ldHJpY3M7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgcmVmLCBmb3VuZDogdHJ1ZSwgdXVpZDogbm9kZS51dWlkLCBuYW1lOiBub2RlLm5hbWUgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGluZm8ud29ybGRSZWN0ID0gaGVscGVycy53b3JsZFJlY3Qobm9kZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5b+955Wl77ya5LiW55WM55+p5b2i5Y+q5piv6ZmE5bim5L+h5oGvICovXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFjYW0pIHtcbiAgICAgICAgICAgIGluZm8ucmVjdCA9IG51bGw7XG4gICAgICAgICAgICBpbmZvLm5vdGUgPSBgJHtjYW1lcmEubm90ZSB8fCAn57yW6L6R5Zmo55u45py65LiN5Y+v55SoJ33vvJrnrpfkuI3lh7roioLngrnlnKjop4blm77ph4znmoTnn6nlvaLvvIjkvJrpgIDmiJDmlbTlvKDop4blm77vvIlgO1xuICAgICAgICAgICAgbWV0cmljcy5ub2RlID0gaW5mbztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3ROb2RlUmVjdChjYywgY2FtLCBub2RlLCBjYW52YXMpO1xuICAgICAgICAgICAgaW5mby5yZWN0ID0gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgICAgICBpbmZvLmNhbnZhc1JlY3QgPSBwcm9qZWN0ZWQuY2FudmFzUmVjdDtcbiAgICAgICAgICAgIGlmIChwcm9qZWN0ZWQubm90ZSkgaW5mby5ub3RlID0gcHJvamVjdGVkLm5vdGU7XG4gICAgICAgICAgICBtZXRyaWNzLm5vZGUgPSBpbmZvO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqIOWPluaZr+aKpeWRiu+8muebruagh+efqeW9oiB2cyDnlLvluIPnn6nlvaLvvIjjgIzmi43lhajkuobmsqHmnInjgI3vvIkgKi9cbiAgICBpZiAoZml0U3BlYykge1xuICAgICAgICBjb25zdCB2aWV3cG9ydCA9IHZpZXdwb3J0T2YoY2FudmFzKTtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZml0VGFyZ2V0T2YoaGVscGVycywgZml0U3BlYywgbm9kZSk7XG4gICAgICAgIGNvbnN0IGZyYW1pbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICAgICAgdGFyZ2V0OiB7XG4gICAgICAgICAgICAgICAga2luZDogZml0U3BlYy5raW5kLFxuICAgICAgICAgICAgICAgIHJlZjogZml0U3BlYy5yZWYgfHwgbnVsbCxcbiAgICAgICAgICAgICAgICAvKiog6L+Z5Z2X55+p5b2i5piv5LuO5ZOq5p2l55qEIOKAlOKAlCDlj5bmma/ph4/plJnkuobvvIznnIvlroPlsLHlpJ/kuoYgKi9cbiAgICAgICAgICAgICAgICBzb3VyY2U6IHRhcmdldC5zb3VyY2UsXG4gICAgICAgICAgICAgICAgLyoqIOS6pOe7mSBmb2N1cyDnmoQgdXVpZO+8iOS4quaVsOWwseWkn+WumuS9jemXrumimOS6hu+8iSAqL1xuICAgICAgICAgICAgICAgIHV1aWRzOiB0YXJnZXQudXVpZHMubGVuZ3RoLFxuICAgICAgICAgICAgICAgIHdvcmxkOiB0YXJnZXQud29ybGQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgdmlld3BvcnQsXG4gICAgICAgICAgICBjb3ZlcmVkOiBmYWxzZSxcbiAgICAgICAgICAgIGFyZWFSYXRpbzogMCxcbiAgICAgICAgICAgIG5vdGU6IHRhcmdldC5ub3RlLFxuICAgICAgICB9O1xuICAgICAgICBpZiAoIXZpZXdwb3J0KSB7XG4gICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSAn6YeP5LiN5Yiw55S75biD55+p5b2i77yI55S75biD6L+Y5rKh6ZO65byA77yJ77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgfSBlbHNlIGlmICghY2FtKSB7XG4gICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSBjYW1lcmEubm90ZSB8fCAn57yW6L6R5Zmo55u45py65LiN5Y+v55So77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8qKiDnm67moIfnn6nlvaLvvJroioLngrnnm67moIfnm7TmjqXnlKgqKuW3sue7j+eul+WlveeahCoq6IqC54K555+p5b2i77yI5ZCM5LiA5Lu95oqV5b2x77yM5LiN6YeN5aSN6LWw5LiA6YGN77yJICovXG4gICAgICAgICAgICBjb25zdCBub2RlUmVjdCA9IG1ldHJpY3Mubm9kZSA/ICgobWV0cmljcy5ub2RlIGFzIFJlY29yZDxzdHJpbmcsIGFueT4pLnJlY3QgYXMgUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwpIDogbnVsbDtcbiAgICAgICAgICAgIGxldCBwYWdlUmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGZpdFNwZWMua2luZCA9PT0gJ25vZGUnKSB7XG4gICAgICAgICAgICAgICAgcGFnZVJlY3QgPSBub2RlUmVjdCAmJiB0eXBlb2Ygbm9kZVJlY3Qud2lkdGggPT09ICdudW1iZXInID8gbm9kZVJlY3QgOiBudWxsO1xuICAgICAgICAgICAgICAgIGlmICghcGFnZVJlY3QpIGZyYW1pbmcubm90ZSA9IGZyYW1pbmcubm90ZSB8fCAn6IqC54K5566X5LiN5Ye655+p5b2i77yM5Yik5pat5LiN5LqG5ouN5YWo5rKh5pyJJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LndvcmxkKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvamVjdGVkID0gcHJvamVjdFdvcmxkQm94KGNjLCBjYW0sIGNhbnZhcywge1xuICAgICAgICAgICAgICAgICAgICBjeDogdGFyZ2V0LndvcmxkLmN4LFxuICAgICAgICAgICAgICAgICAgICBjeTogdGFyZ2V0LndvcmxkLmN5LFxuICAgICAgICAgICAgICAgICAgICB3ejogMCxcbiAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHRhcmdldC53b3JsZC53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiB0YXJnZXQud29ybGQuaGVpZ2h0LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHBhZ2VSZWN0ID0gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgICAgICAgICAgaWYgKCFwYWdlUmVjdCAmJiBwcm9qZWN0ZWQubm90ZSkgZnJhbWluZy5ub3RlID0gZnJhbWluZy5ub3RlIHx8IHByb2plY3RlZC5ub3RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHBhZ2VSZWN0KSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY292ZXJhZ2UgPSBjb3ZlcmFnZU9mKHBhZ2VSZWN0LCB2aWV3cG9ydCk7XG4gICAgICAgICAgICAgICAgZnJhbWluZy5jb3ZlcmVkID0gY292ZXJhZ2UuY292ZXJlZDtcbiAgICAgICAgICAgICAgICBmcmFtaW5nLmFyZWFSYXRpbyA9IGNvdmVyYWdlLmFyZWFSYXRpbztcbiAgICAgICAgICAgICAgICBmcmFtaW5nLmVkZ2VzID0gY292ZXJhZ2UuZWRnZXM7XG4gICAgICAgICAgICAgICAgZnJhbWluZy50YXJnZXRQYWdlID0gcGFnZVJlY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5mcmFtaW5nID0gZnJhbWluZztcbiAgICB9XG5cbiAgICByZXR1cm4gbWV0cmljcztcbn1cbmludGVyZmFjZSBIZWxwZXJCdW5kbGUge1xuICAgIGhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHN0YXRlOiB7IHNuYXBzaG90UmVxdWVzdGVkOiBib29sZWFuIH07XG59XG5cbi8qKlxuICog5p6E6YCg5rOo5YWl5rKZ566x55qE5Yqp5omL5Ye95pWw44CCXG4gKlxuICog6L+Z5Lqb5piv44CMQUkg5YaZ5Luj56CB5pe255qE6LW35omL5byP44CN4oCU4oCU5rKh5pyJ5a6D5Lus77yM5qih5Z6L5q+P5qyh6YO96KaB5LuOXG4gKiBgY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKWAg5byA5aeL5omL5pCT6YGN5Y6G77yM5pei6LS5IHRva2VuIOWPiOWuueaYk+WGmemUmeOAglxuICovXG5mdW5jdGlvbiBtYWtlSGVscGVycyhjYzogYW55LCBvcHRpb25zPzogeyBwcm9qZWN0UGF0aD86IHN0cmluZyB9KTogSGVscGVyQnVuZGxlIHtcbiAgICBjb25zdCBzdGF0ZSA9IHsgc25hcHNob3RSZXF1ZXN0ZWQ6IGZhbHNlIH07XG5cbiAgICBjb25zdCBoZWxwZXJzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gICAgLyoqXG4gICAgICog5bel56iL5qC5IOKAlOKAlCAqKuS8mOWFiOeUqOS4u+i/m+eoi+majyBwYXlsb2FkIOS8oOi/m+adpeeahOmCo+S4qioq77yIYEVkaXRvci5Qcm9qZWN0LnBhdGhg77yJ77yMXG4gICAgICog5ou/5LiN5Yiw5YaN6YCA5ZueIGBjdXJyZW50UHJvamVjdFBhdGgoKWDvvIjlnLrmma/ov5vnqIvph4znmoQgYEVkaXRvcmAg5YWo5bGA6YeP77yJ44CCXG4gICAgICog5Lik5Liq6YO95rKh5pyJ5pe25Y+q5b2x5ZON44CM5oyJ6Lev5b6E6Kej5p6Q6LWE5rqQ44CN6L+Z5LiA5Lu25LqL77yM5YW25L2Z5Yqp5omL54Wn5bi444CCXG4gICAgICovXG4gICAgY29uc3QgcHJvamVjdFJvb3QgPSAoKTogc3RyaW5nID0+IHtcbiAgICAgICAgY29uc3QgZnJvbVBheWxvYWQgPSB0eXBlb2Ygb3B0aW9ucz8ucHJvamVjdFBhdGggPT09ICdzdHJpbmcnID8gb3B0aW9ucy5wcm9qZWN0UGF0aCA6ICcnO1xuICAgICAgICByZXR1cm4gZnJvbVBheWxvYWQgfHwgY3VycmVudFByb2plY3RQYXRoKCk7XG4gICAgfTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8g57yW6L6R5Zmo6KOF6aWw6IqC54K55Yik5o2uIOKAlOKAlCDlnLrmma/moJHph4wgOTclIOeahOiKgueCueS4jeaYr+S9oOeahOWGheWuuVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy9cbiAgICAvLyDlnLrmma/ov5vnqIvph4wgYGRpcmVjdG9yLmdldFNjZW5lKClgIOaLv+WIsOeahOagkSoq5YyF5ZCr57yW6L6R5Zmo6Ieq5bex5oyC55qEIGdpem1vIC8g572R5qC8IC9cbiAgICAvLyDlj4LogIPlm74qKuOAguWunua1i++8iENvY29zIDMuOC4277yM5LiA5Liq5Y+q5pyJIENhbnZhcyDnmoTnqbrlnLrmma/vvInvvJpcbiAgICAvL1xuICAgIC8vICAgICDmgLvoioLngrkgMTI4XG4gICAgLy8gICAgIOKUnOKUgCBDYW52YXMgICAgICAgICAgICAgICAgICAgICAgICAyICAg4oaQIOWUr+S4gOeahOecn+WunuWGheWuuVxuICAgIC8vICAgICDilJzilIAgRWRpdG9yIFNjZW5lIEZvcmVncm91bmQgICAgIDExNyAgIOKGkCDlnZDmoIfovbQgZ2l6bW8gLyDnvZHmoLwgLyDlkITnp43mjqfliLblmahcbiAgICAvLyAgICAg4pSU4pSAIEVkaXRvciBTY2VuZSBCYWNrZ3JvdW5kICAgICAgIDggICDihpAg6IOM5pmv5LiO5Y+C6ICD5Zu+XG4gICAgLy9cbiAgICAvLyDkuI3mu6TmjonnmoTor50gYGVhY2hOb2RlYCAvIGB0cmVlKClgIOmHjCA5NyUg5piv5Zmq5aOw77yM5qih5Z6L5Lya54Wn552AIGdpem1vIOeahOiKgueCueWQjVxuICAgIC8vIO+8iGB4QXhpc2AgLyBgUmVjdGFuZ2xlYCAvIGBQbGFuZWAgLyBgTGluZXNOb2RlYOKApu+8ieWOu+aOqOaWrea4uOaIj+e7k+aehOOAglxuICAgIC8vXG4gICAgLy8gIyMg5Lik5p2h6KKr5a6e5rWL5ZCm5o6J55qE55u06KeJXG4gICAgLy9cbiAgICAvLyDinYwgKirmjIkgbGF5ZXIg5o6p56CB5rukKirvvJrkuI3ooYzjgILnvJbovpHlmajmoLkgYEVkaXRvciBTY2VuZSBGb3JlZ3JvdW5kYCDkuI7nnJ/lrp7nm7jmnLpcbiAgICAvLyAgICBgQ2FudmFzL0NhbWVyYWAgKirlkIzkuLogYExheWVycy5ERUZBVUxUYCgxMDczNzQxODI0KSoq77ybR0laTU9TL0VESVRPUiDkvY3lj6ropobnm5ZcbiAgICAvLyAgICDlrZDmoJHnmoTkuIDpg6jliIbvvIjov5jmnIkgNTI0Mjg4MOOAgTE2Nzc3MjE2IOetiea3t+WQiOWAvO+8ieKAlOKAlCDmjInlsYLmu6TkvJror6/kvKTnnJ/lrp7oioLngrnjgIJcbiAgICAvLyDinYwgKirmjIkgYGdpem1vUm9vdGAg6L+Z57G75ZCN5a2X5rukKirvvJrkuI3ooYzjgILlkI3lrZfmmK/lrp7njrDnu4boioLvvIzogIzkuJTopobnm5bkuI3kuoYgQmFja2dyb3VuZCDpgqPmo7XjgIJcbiAgICAvL1xuICAgIC8vIOKchSAqKuaMiSBgSGlkZUluSGllcmFyY2h5YCDkvY3mu6QqKu+8iD0g57yW6L6R5Zmo6Ieq5bex44CM5Yir5Zyo5bGC57qn6Z2i5p2/6YeM5pi+56S65oiR44CN55qE5qCH6K6w77yMXG4gICAgLy8gICAg6K+t5LmJ5q2j5aW95bCx5piv6KaB55qE6L+Z5Liq77yJ44CC5a6e5rWL5Lik5Liq57yW6L6R5Zmo5qC555qEIGBvYmpGbGFnc2Ag6YO95pivXG4gICAgLy8gICAgYDEwOTYgPSBIaWRlSW5IaWVyYXJjaHl8RG9udERlc3Ryb3l8RG9udFNhdmVg77yM6ICM55yf5a6e6IqC54K577yI5ZCrIENhbWVyYe+8ieaYryAw44CCXG4gICAgLy9cbiAgICAvLyDimqAg5YWz6ZSu57uG6IqC77ya6L+Z5Liq5L2NKirlj6rlnKjkuKTkuKrmoLnkuIoqKu+8jGBnaXptb1Jvb3RgIOiHqui6q+eahCBgb2JqRmxhZ3NgIOaYryAwIOKAlOKAlFxuICAgIC8vICAgIOaJgOS7peWIpOaNruW/hemhu+eUqOWcqCoq5Ymq5p6dKirkuIrvvIjliarmjonmoLnvvIzmlbTmo7XlrZDmoJHoh6rnhLbpg73msqHkuobvvInvvIxcbiAgICAvLyAgICDogIzkuI3mmK/pgJDoioLngrnov4fmu6TvvIjpgJDoioLngrnkvJrnlZnkuIsgZ2l6bW9Sb290IOmCo+S4gOaVtOajte+8ieOAglxuICAgIGNvbnN0IGhpZGVJbkhpZXJhcmNoeSA9ICgoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBmbGFncyA9IGNjLkNDT2JqZWN0ICYmIGNjLkNDT2JqZWN0LkZsYWdzO1xuICAgICAgICAgICAgaWYgKGZsYWdzICYmIHR5cGVvZiBmbGFncy5IaWRlSW5IaWVyYXJjaHkgPT09ICdudW1iZXInKSByZXR1cm4gZmxhZ3MuSGlkZUluSGllcmFyY2h5O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW8leaTjueJiOacrOWPmOWKqOaXtuWbnuiQveWIsCAzLjguNiDnmoTlrp7mtYvlgLwgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gMTAyNDtcbiAgICB9KSgpO1xuXG4gICAgLyoqIOWQjeWtl+WFnOW6le+8muS4h+S4gOWTquWkqSBgRmxhZ3MuSGlkZUluSGllcmFyY2h5YCDmjKrkvY3kuobvvIzov5nkuKTkuKrmoLnov5jog73ooqvorqTlh7rmnaUgKi9cbiAgICBjb25zdCBlZGl0b3JSb290TmFtZXMgPSBbJ0VkaXRvciBTY2VuZSBGb3JlZ3JvdW5kJywgJ0VkaXRvciBTY2VuZSBCYWNrZ3JvdW5kJ107XG5cbiAgICBjb25zdCBpc0VkaXRvck5vZGUgPSAobm9kZTogYW55KTogYm9vbGVhbiA9PiB7XG4gICAgICAgIGlmICghbm9kZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gYGhpZGVGbGFnc2Ag5pivIENDT2JqZWN0IOeahOWFrOW8gOiuv+mXruWZqO+8iOWGhemDqOW3siAmIEFsbEhpZGVNYXNrc++8ie+8jOS8mOWFiOeUqOWug1xuICAgICAgICAgICAgY29uc3QgZmxhZ3MgPVxuICAgICAgICAgICAgICAgIHR5cGVvZiBub2RlLmhpZGVGbGFncyA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgPyBub2RlLmhpZGVGbGFnc1xuICAgICAgICAgICAgICAgICAgICA6IHR5cGVvZiBub2RlLl9vYmpGbGFncyA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgICA/IG5vZGUuX29iakZsYWdzXG4gICAgICAgICAgICAgICAgICAgICAgOiAwO1xuICAgICAgICAgICAgaWYgKChmbGFncyAmIGhpZGVJbkhpZXJhcmNoeSkgIT09IDApIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWPluS4jeWIsOagh+W/l+S9jeWwseWPquWJqeWQjeWtl+WFnOW6lSAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBlZGl0b3JSb290TmFtZXMuaW5kZXhPZihub2RlLm5hbWUpID49IDA7XG4gICAgfTtcblxuICAgIC8qKiDlrZDoioLngrnph4zlsZ7kuo7jgIznnJ/lrp7lhoXlrrnjgI3nmoTpgqPkupsgKi9cbiAgICBjb25zdCBjb250ZW50Q2hpbGRyZW4gPSAobm9kZTogYW55KTogYW55W10gPT4ge1xuICAgICAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSAobm9kZSAmJiBub2RlLmNoaWxkcmVuKSB8fCBbXTtcbiAgICAgICAgcmV0dXJuIGNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT4gIWlzRWRpdG9yTm9kZShjaGlsZCkpO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDmjIkgYC9gIOWIhuauteino+aekOi3r+W+hOOAglxuICAgICAqXG4gICAgICogKirkuLrku4DkuYjkuI3og73lj6rnlKggYGNjLmZpbmRgKirvvJpgY2MuZmluZCgnYS9iJylgIOaYr+aMiSBgL2Ag5YiH5byA6YCQ5bGC5om+5a2Q6IqC54K577yMXG4gICAgICog5LqO5pivKiroioLngrnlkI3ph4zlkKsgYC9gIOeahOi3r+W+hOawuOi/nOaJvuS4jeWIsCoq44CC5a6e5rWL5bel56iL6YeM5bCx5a2Y5ZyoXG4gICAgICogYGludGVybmFsL2VkaXRvci9ncmlkLTJkYCDkuI4gYGludGVybmFsL2VkaXRvci9ncmlkYCDov5nnp43lkI3lrZdcbiAgICAgKiDvvIjnvJbovpHlmajoh6rlt7HnlJ/miJDnmoTvvInvvIxgY2MuZmluZGAg5a+55a6D5Lus5LiA5b6L6L+U5ZueIG51bGwg4oCU4oCUIOiAjOS4lCoq6Z2Z6buY6L+U5ZueIG51bGwqKu+8jFxuICAgICAqIOiwg+eUqOaWueWPquS8muS7peS4ulwi6IqC54K55LiN5a2Y5ZyoXCLjgIJcbiAgICAgKlxuICAgICAqIOi/memHjOaUueaIkCoq6LSq5b+D5oyJ5q615Yy56YWNKirvvJrmr4/lsYLku47jgIzmnIDplb/nmoTkuIDmrrXjgI3lvIDlp4vor5XvvIzlhYjmioogYGludGVybmFsL2VkaXRvci9ncmlkLTJkYFxuICAgICAqIOaVtOS9k+W9k+aIkOS4gOS4quiKgueCueWQjeWOu+ivle+8jOS4jeihjOWGjemAgOWMluaIkCBgaW50ZXJuYWxgIOKGkiBgZWRpdG9yYCDihpIgYGdyaWQtMmRgIOS4ieWxguOAglxuICAgICAqIOS4pOenjeWcuuaZr+mDveiDveino+aekO+8jOS7o+S7t+aYr+eQhuiuuuS4iuWtmOWcqOatp+S5ie+8iOWQjOaXtuWtmOWcqOWQjeS4uiBgYS9iYCDnmoToioLngrnkuI4gYGFgIOS4i+eahCBgYmDvvInigJTigJRcbiAgICAgKiDpgqPnp43mg4XlhrXkvJjlhYjorqTjgIzlkI3lrZfmm7Tplb/jgI3nmoTpgqPkuKrvvIznrKblkIjnm7Top4njgIJcbiAgICAgKi9cbiAgICBjb25zdCByZXNvbHZlUGF0aEJ5U2VnbWVudHMgPSAocGF0aDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4gbnVsbDtcbiAgICAgICAgY29uc3Qgc2VnbWVudHMgPSBTdHJpbmcocGF0aClcbiAgICAgICAgICAgIC5zcGxpdCgnLycpXG4gICAgICAgICAgICAuZmlsdGVyKChzZWdtZW50OiBzdHJpbmcpID0+IHNlZ21lbnQubGVuZ3RoID4gMCk7XG4gICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDApIHJldHVybiBzY2VuZTtcblxuICAgICAgICAvLyDlhYHorrjmiorlnLrmma/oh6rlt7HnmoTlkI3lrZflhpnlnKjmnIDliY3pnaJcbiAgICAgICAgaWYgKHNlZ21lbnRzWzBdID09PSBzY2VuZS5uYW1lKSBzZWdtZW50cy5zaGlmdCgpO1xuICAgICAgICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gc2NlbmU7XG5cbiAgICAgICAgbGV0IGN1cnNvcjogYW55ID0gc2NlbmU7XG4gICAgICAgIGxldCBpbmRleCA9IDA7XG4gICAgICAgIHdoaWxlIChpbmRleCA8IHNlZ21lbnRzLmxlbmd0aCkge1xuICAgICAgICAgICAgbGV0IGZvdW5kOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgZm9yIChsZXQgZW5kID0gc2VnbWVudHMubGVuZ3RoOyBlbmQgPiBpbmRleDsgZW5kIC09IDEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBzZWdtZW50cy5zbGljZShpbmRleCwgZW5kKS5qb2luKCcvJyk7XG4gICAgICAgICAgICAgICAgbGV0IGNoaWxkOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNoaWxkID0gY3Vyc29yLmdldENoaWxkQnlOYW1lKGNhbmRpZGF0ZSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIGNoaWxkID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGNoaWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kID0gY2hpbGQ7XG4gICAgICAgICAgICAgICAgICAgIGluZGV4ID0gZW5kO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWZvdW5kKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGN1cnNvciA9IGZvdW5kO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJzb3I7XG4gICAgfTtcblxuICAgIC8qKiDmjIkgdXVpZCDmib7oioLngrnvvIjlhYjotbDlvJXmk47lv6vot6/lvoTvvIzmib7kuI3liLDlho3mlbTmoJHmiavvvIkgKi9cbiAgICBoZWxwZXJzLm5vZGVCeVV1aWQgPSAodXVpZDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKHNjZW5lLnV1aWQgPT09IHV1aWQpIHJldHVybiBzY2VuZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGZhc3QgPSBzY2VuZS5nZXRDaGlsZEJ5VXVpZCh1dWlkKTtcbiAgICAgICAgICAgIGlmIChmYXN0KSByZXR1cm4gZmFzdDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlvJXmk47lhoXpg6jlrp7njrDlj5jliqjml7blm57okL3liLDmlbTmoJHmiavmj48gKi9cbiAgICAgICAgfVxuICAgICAgICBsZXQgZm91bmQ6IGFueSA9IG51bGw7XG4gICAgICAgIGVhY2hOb2RlKHNjZW5lLCAobjogYW55KSA9PiB7XG4gICAgICAgICAgICBpZiAoIWZvdW5kICYmIG4udXVpZCA9PT0gdXVpZCkgZm91bmQgPSBuO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDmjInot6/lvoTmib7oioLngrnvvIzlpoIgYCdDYW52YXMvc2tpbGxfZGV0YWlscydg44CCXG4gICAgICpcbiAgICAgKiDlhYjnu5nlvJXmk47nmoQgYGNjLmZpbmRgIOivle+8iOWug+iupOW+lyBgLi5gIOS5i+exu+eahOi+ueinkuivreS5ie+8ie+8jOWksei0peWGjeiHquW3seaMieauteino+aekCDigJTigJRcbiAgICAgKiDlkI7ogIXmiY3og73lpITnkIYqKuWQjeWtl+mHjOWQqyBgL2AqKiDnmoToioLngrnvvIjlrp7mtYvlrZjlnKggYGludGVybmFsL2VkaXRvci9ncmlkLTJkYO+8ieOAglxuICAgICAqIOe8lui+keWZqOijhemlsOiKgueCuSoq54Wn5qC35om+5b6X5YiwKirvvIjmmL7lvI/ngrnlkI3lsLHkuI3or6Xooqvol4/vvInjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLm5vZGVCeVBhdGggPSAocGF0aDogc3RyaW5nKTogYW55ID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGZhc3QgPSBjYy5maW5kKHBhdGgpO1xuICAgICAgICAgICAgaWYgKGZhc3QpIHJldHVybiBmYXN0O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWbnuiQvSAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNvbHZlUGF0aEJ5U2VnbWVudHMocGF0aCk7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOmBjeWOhuWcuuaZr+agke+8iOm7mOiupCoq6Lez6L+H57yW6L6R5Zmo6KOF6aWw6IqC54K5KirvvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSB2aXNpdCDorr/pl67lh73mlbBcbiAgICAgKiBAcGFyYW0gcm9vdCDotbflp4voioLngrnvvIzpu5jorqTlnLrmma/moLlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5pbmNsdWRlRWRpdG9yIOS4uiB0cnVlIOaXtui/niBnaXptby/nvZHmoLwv5Y+C6ICD5Zu+5LiA6LW36YGN5Y6GXG4gICAgICovXG4gICAgaGVscGVycy5lYWNoTm9kZSA9IChcbiAgICAgICAgdmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQsXG4gICAgICAgIHJvb3Q/OiBhbnksXG4gICAgICAgIG9wdGlvbnM/OiB7IGluY2x1ZGVFZGl0b3I/OiBib29sZWFuIH0sXG4gICAgKTogdm9pZCA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXJ0ID0gcm9vdCB8fCBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXN0YXJ0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IGluY2x1ZGVFZGl0b3IgPSBCb29sZWFuKG9wdGlvbnMgJiYgb3B0aW9ucy5pbmNsdWRlRWRpdG9yKTtcbiAgICAgICAgLy8g6L+t5Luj5byP5rex5bqm5LyY5YWI77yb5Ymq5p6d5Y+R55Sf5Zyo44CM5YWl5qCI44CN6L+Z5LiA5q2l77yI6Lez6L+H57yW6L6R5Zmo5qC577yM5pW05qO15a2Q5qCR5bCx5rKh5LqG77yJXG4gICAgICAgIGNvbnN0IHN0YWNrOiBhbnlbXSA9IFtzdGFydF07XG4gICAgICAgIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBub2RlID0gc3RhY2sucG9wKCk7XG4gICAgICAgICAgICB2aXNpdChub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkcmVuOiBhbnlbXSA9IG5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgaSA+PSAwOyBpIC09IDEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjaGlsZCA9IGNoaWxkcmVuW2ldO1xuICAgICAgICAgICAgICAgIGlmICghaW5jbHVkZUVkaXRvciAmJiBpc0VkaXRvck5vZGUoY2hpbGQpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBzdGFjay5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDlnLrmma/moJHmpoLop4gg4oCU4oCUIOS4gOasoeaLv+WIsOWxgue6p+mqqOaetu+8jOavlCBgcmV0dXJuIHNjZW5lYCDmnInnlKjlvpflpJrjgIJcbiAgICAgKlxuICAgICAqIOm7mOiupCoq6Lez6L+H57yW6L6R5Zmo6KOF6aWw6IqC54K5KirvvIjop4Ege0BsaW5rIGlzRWRpdG9yTm9kZX0g55qE6K+05piO77yJ77ybXG4gICAgICog6ZyA6KaB6L+eIGdpem1vIOS4gOi1t+eci+WwseS8oCBgaW5jbHVkZUVkaXRvcjogdHJ1ZWDjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBvcHRpb25zLm1heERlcHRoIOm7mOiupCAzXG4gICAgICogQHBhcmFtIG9wdGlvbnMud2l0aENvbXBvbmVudHMg5piv5ZCm5bim5LiK5q+P5Liq6IqC54K555qE57uE5Lu257G75Z6L5ZCNXG4gICAgICogQHBhcmFtIG9wdGlvbnMuaW5jbHVkZUVkaXRvciDmmK/lkKbljIXlkKvnvJbovpHlmaggZ2l6bW8v572R5qC8L+WPguiAg+Wbvu+8jOm7mOiupCBmYWxzZVxuICAgICAqL1xuICAgIGhlbHBlcnMudHJlZSA9IChcbiAgICAgICAgb3B0aW9ucz86IHsgcm9vdD86IGFueTsgbWF4RGVwdGg/OiBudW1iZXI7IHdpdGhDb21wb25lbnRzPzogYm9vbGVhbjsgaW5jbHVkZUVkaXRvcj86IGJvb2xlYW4gfSxcbiAgICApOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPT4ge1xuICAgICAgICBjb25zdCBvcHRzID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3Qgcm9vdCA9IG9wdHMucm9vdCB8fCBjdXJyZW50U2NlbmUoY2MpO1xuICAgICAgICBpZiAoIXJvb3QpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBtYXhEZXB0aCA9IHR5cGVvZiBvcHRzLm1heERlcHRoID09PSAnbnVtYmVyJyA/IG9wdHMubWF4RGVwdGggOiAzO1xuICAgICAgICBjb25zdCBpbmNsdWRlRWRpdG9yID0gQm9vbGVhbihvcHRzLmluY2x1ZGVFZGl0b3IpO1xuXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gKG5vZGU6IGFueSwgZGVwdGg6IG51bWJlcik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgIHV1aWQ6IG5vZGUudXVpZCxcbiAgICAgICAgICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmIChvcHRzLndpdGhDb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgb3V0LmNvbXBvbmVudHMgPSAobm9kZS5jb21wb25lbnRzIHx8IFtdKS5tYXAoKGM6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgdHlwZTogY2MuanMuZ2V0Q2xhc3NOYW1lKGMpLCBlbmFibGVkOiBjLmVuYWJsZWQgfTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyB0eXBlOiAndW5rbm93bicgfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYWxsQ2hpbGRyZW46IGFueVtdID0gbm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkcmVuID0gaW5jbHVkZUVkaXRvclxuICAgICAgICAgICAgICAgID8gYWxsQ2hpbGRyZW5cbiAgICAgICAgICAgICAgICA6IGFsbENoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT4gIWlzRWRpdG9yTm9kZShjaGlsZCkpO1xuICAgICAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBvdXQuY2hpbGRDb3VudCA9IGNoaWxkcmVuLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBpZiAoZGVwdGggPCBtYXhEZXB0aCkge1xuICAgICAgICAgICAgICAgICAgICBvdXQuY2hpbGRyZW4gPSBjaGlsZHJlbi5tYXAoKGM6IGFueSkgPT4gYnVpbGQoYywgZGVwdGggKyAxKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgb3V0LmNoaWxkcmVuID0gY2hpbGRyZW4ubWFwKChjOiBhbnkpID0+ICh7IG5hbWU6IGMubmFtZSwgdXVpZDogYy51dWlkIH0pKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyDol4/kuobkuJzopb/lsLHor7TkuIDlo7DvvIzliKvorqnosIPnlKjmlrnku6XkuLrmoJHlsLHov5nkuYjlpKdcbiAgICAgICAgICAgIGNvbnN0IGhpZGRlbiA9IGFsbENoaWxkcmVuLmxlbmd0aCAtIGNoaWxkcmVuLmxlbmd0aDtcbiAgICAgICAgICAgIGlmIChoaWRkZW4gPiAwKSBvdXQuZWRpdG9yQ2hpbGRyZW5IaWRkZW4gPSBoaWRkZW47XG4gICAgICAgICAgICByZXR1cm4gb3V0O1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gYnVpbGQocm9vdCwgMCk7XG4gICAgfTtcblxuICAgIC8qKiDov5nkuKroioLngrnmmK/kuI3mmK/nvJbovpHlmajoh6rlt7HnmoToo4XppbDvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8iSAqL1xuICAgIGhlbHBlcnMuaXNFZGl0b3JOb2RlID0gKG5vZGU6IGFueSk6IGJvb2xlYW4gPT4gaXNFZGl0b3JOb2RlKG5vZGUpO1xuXG4gICAgLyoqIOecn+WunuWGheWuueWtkOiKgueCue+8iOW3sua7pOaOiee8lui+keWZqOijhemlsO+8iSAqL1xuICAgIGhlbHBlcnMuY29udGVudENoaWxkcmVuID0gKG5vZGU/OiBhbnkpOiBhbnlbXSA9PiBjb250ZW50Q2hpbGRyZW4obm9kZSB8fCBjdXJyZW50U2NlbmUoY2MpKTtcblxuICAgIC8qKlxuICAgICAqIOWxleW8gOS4gOS4quiKgueCueaIlue7hOS7tuS4uue6r+aVsOaNruWvueixoeOAglxuICAgICAqXG4gICAgICog6L+Z5pivIGBlbmdpbmVPYmplY3RUYWdgIOaRmOimgeeahOOAjOmAg+eUn+iIseOAje+8mui/lOWbnuWAvOW6j+WIl+WMluaXtum7mOiupOaKiiBjYyDlr7nosaHljovmiJBcbiAgICAgKiBgW05vZGUgbmFtZT14IHV1aWQ9eV1g77yM5oOz55yL57uG6IqC5bCx5b6X6LWwIGBkdW1wKClg77yM5a6D5LyaKirmmL7lvI/lj5blrZfmrrUqKu+8jFxuICAgICAqIOS6juaYr+aXouaLv+W+l+WIsOaVsOaNru+8jOWPiOS4jeS8muWboOS4uuW+queOr+W8leeUqOeCuOaOieOAglxuICAgICAqL1xuICAgIGhlbHBlcnMuZHVtcCA9ICh0YXJnZXQ6IGFueSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9PiB7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm4gbnVsbDtcblxuICAgICAgICAvLyDmmK/nu4Tku7bvvIjmnIkgbm9kZSDlrZfmrrXkuJToh6rouqvkuI3mmK8gTm9kZe+8iVxuICAgICAgICBpZiAodGFyZ2V0Lm5vZGUgJiYgIXRhcmdldC5jaGlsZHJlbikge1xuICAgICAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICBfX2tpbmQ6ICdjb21wb25lbnQnLFxuICAgICAgICAgICAgICAgIHR5cGU6ICgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2MuanMuZ2V0Q2xhc3NOYW1lKHRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRhcmdldC5jb25zdHJ1Y3RvciAmJiB0YXJnZXQuY29uc3RydWN0b3IubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pKCksXG4gICAgICAgICAgICAgICAgbm9kZTogc2hvcnROb2RlKHRhcmdldC5ub2RlKSxcbiAgICAgICAgICAgICAgICBlbmFibGVkOiB0YXJnZXQuZW5hYmxlZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIGNvbXBvbmVudFByb3BOYW1lcyh0YXJnZXQpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVhZCA9IHNhZmVSZWFkKHRhcmdldCwga2V5KTtcbiAgICAgICAgICAgICAgICBpZiAocmVhZC5vaykgcHJvcHNba2V5XSA9IHJlYWQudmFsdWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvdXQucHJvcHMgPSBwcm9wcztcbiAgICAgICAgICAgIHJldHVybiBvdXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDmmK/oioLngrlcbiAgICAgICAgaWYgKHRhcmdldC5jaGlsZHJlbiAmJiB0eXBlb2YgdGFyZ2V0LnV1aWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNvbXAgb2YgdGFyZ2V0LmNvbXBvbmVudHMgfHwgW10pIHtcbiAgICAgICAgICAgICAgICBsZXQgdHlwZU5hbWUgPSAndW5rbm93bic7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZU5hbWUgPSBjYy5qcy5nZXRDbGFzc05hbWUoY29tcCk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGVOYW1lID0gKGNvbXAuY29uc3RydWN0b3IgJiYgY29tcC5jb25zdHJ1Y3Rvci5uYW1lKSB8fCAndW5rbm93bic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIGNvbXBvbmVudFByb3BOYW1lcyhjb21wKSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCByZWFkID0gc2FmZVJlYWQoY29tcCwga2V5KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlYWQub2spIHByb3BzW2tleV0gPSByZWFkLnZhbHVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLnB1c2goeyB0eXBlOiB0eXBlTmFtZSwgZW5hYmxlZDogY29tcC5lbmFibGVkLCBwcm9wcyB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgX19raW5kOiAnbm9kZScsXG4gICAgICAgICAgICAgICAgbmFtZTogdGFyZ2V0Lm5hbWUsXG4gICAgICAgICAgICAgICAgdXVpZDogdGFyZ2V0LnV1aWQsXG4gICAgICAgICAgICAgICAgYWN0aXZlOiB0YXJnZXQuYWN0aXZlLFxuICAgICAgICAgICAgICAgIGFjdGl2ZUluSGllcmFyY2h5OiB0YXJnZXQuYWN0aXZlSW5IaWVyYXJjaHksXG4gICAgICAgICAgICAgICAgbGF5ZXI6IHRhcmdldC5sYXllcixcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdGFyZ2V0LnBvc2l0aW9uLFxuICAgICAgICAgICAgICAgIHJvdGF0aW9uOiB0YXJnZXQucm90YXRpb24sXG4gICAgICAgICAgICAgICAgc2NhbGU6IHRhcmdldC5zY2FsZSxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHNob3J0Tm9kZSh0YXJnZXQucGFyZW50KSxcbiAgICAgICAgICAgICAgICBjaGlsZHJlbjogKHRhcmdldC5jaGlsZHJlbiB8fCBbXSkubWFwKChjOiBhbnkpID0+IHNob3J0Tm9kZShjKSksXG4gICAgICAgICAgICAgICAgY29tcG9uZW50cyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBfX2tpbmQ6ICdwbGFpbicsIHZhbHVlOiB0YXJnZXQgfTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog6K+35rGC5LiA5qyh5pKk6ZSA5b+r54Wn44CCXG4gICAgICpcbiAgICAgKiDmnKzlh73mlbAqKuWPque9ruagh+W/l+S9jSoq77yM55yf5q2j55qEIGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsJ3NuYXBzaG90JylgXG4gICAgICog55Sx5Li76L+b56iL5Zyo5ou/5Yiw6L+U5Zue5YC85LmL5ZCO5omn6KGMIOKAlOKAlCDljp/lm6DvvJrlnLrmma/ohJrmnKzoh6rlt7Hot5HlnKggc2NlbmUg6L+b56iL6YeM77yMXG4gICAgICog5LuOIHNjZW5lIOi/m+eoi+WGjSBgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAuLi4pYCDmmK/nu5noh6rlt7Hlj5Hmtojmga/vvIxcbiAgICAgKiDovbvliJnmjpLpmJ/ph43liJnoh6rplIHjgILot6jov5vnqIvnmoTkuovkuqTnu5nlj5HotbfmlrnlgZrjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLnNuYXBzaG90ID0gKCk6IHZvaWQgPT4ge1xuICAgICAgICBzdGF0ZS5zbmFwc2hvdFJlcXVlc3RlZCA9IHRydWU7XG4gICAgfTtcblxuICAgIC8qKiDnnaHnnKDmjIflrprmr6vnp5LvvIjphY3lkIggYGF3YWl0YCDlgZrova7or6LvvIzmr5TorqnmqKHlnovlnKggdG9vbCBjYWxsIOS5i+mXtOW5suetieecgeW+l+Wkmu+8iSAqL1xuICAgIGhlbHBlcnMuc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNjAwMDAsIG1zIHwgMCkpKTtcbiAgICAgICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiDmiKrlj5YqKue8lui+keWZqOWcuuaZr+inhuWbvioq5b2T5YmN5LiA5bin77yM5a2Y5oiQIFBORy9KUEVH44CCXG4gICAgICpcbiAgICAgKiDmiYDop4HljbPmiYDlvpfvvIjlkKvnvZHmoLzkuI4gZ2l6bW/vvInvvIznlKjmnaXjgIznnIvkuIDnnLznlLvpnaLjgI3ogIzkuI3mmK/jgIzor7vkuIDkuLLlnZDmoIfjgI3igJTigJRcbiAgICAgKiDluIPlsYDlj6DlrZfjgIHotLTlm77nqbrnmb3jgIHoioLngrnot5Hlh7rlsY/luZXov5nnsbvpl67popjvvIznnIvnlLvpnaLkuIDnp5LlsLHog73lj5HnjrDjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBvcHRpb25zLnNhdmVQYXRoIOebruagh+aWh+S7tioq57ud5a+56Lev5b6EKirjgILnu5nkuoblsLHoh6rlt7HokL3nm5jvvIzov5Tlm57lgLzlj6rluKbot6/lvoTvvIjlsI/vvInvvJtcbiAgICAgKiAgIOS4jee7meOAgeaIluacrOeOr+Wig+WGmeS4jeS6huebmO+8jOWbnuiQveOAjOWIhuWdl+WbnuS8oOOAje+8jOeUseS4u+i/m+eoi+aLvOWbnuadpeiQveebmOOAglxuICAgICAqIEBwYXJhbSBvcHRpb25zLm1heFdpZHRoIOe8qeWIsOS4jei2hei/h+i/meS4quWuveW6pu+8jOm7mOiupCA2NDDvvIjotorlsI/otorlv6vjgIHlm57kvKDotorlsI/vvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5mb3JtYXQgYCdwbmcnYO+8iOm7mOiupO+8jOaXoOaNn++8ieaIliBgJ2pwZWcnYO+8iOS9k+enr+Wwj++8iVxuICAgICAqIEBwYXJhbSBvcHRpb25zLnF1YWxpdHkganBlZyDotKjph48gMC4xfjHvvIzpu5jorqQgMC45XG4gICAgICogQHBhcmFtIG9wdGlvbnMud2FpdE1zIOetieS4i+S4gOW4p+eahOS4iumZkO+8jOm7mOiupCA4MDBtc++8iOWcuuaZr+inhuWbvuayoeWcqOa4suafk+aXtuWFnOW6leebtOaOpeaKk+W9k+WJjee8k+WGsu+8iVxuICAgICAqL1xuICAgIGhlbHBlcnMuY2FwdHVyZVZpZXcgPSBhc3luYyAoXG4gICAgICAgIG9wdGlvbnM/OiB7XG4gICAgICAgICAgICBzYXZlUGF0aD86IHN0cmluZztcbiAgICAgICAgICAgIG1heFdpZHRoPzogbnVtYmVyO1xuICAgICAgICAgICAgZm9ybWF0Pzogc3RyaW5nO1xuICAgICAgICAgICAgcXVhbGl0eT86IG51bWJlcjtcbiAgICAgICAgICAgIHdhaXRNcz86IG51bWJlcjtcbiAgICAgICAgfSxcbiAgICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9PiB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICBjb25zdCBmb3JtYXQgPSBvcHRzLmZvcm1hdCA9PT0gJ2pwZWcnIHx8IG9wdHMuZm9ybWF0ID09PSAnanBnJyA/ICdqcGVnJyA6ICdwbmcnO1xuICAgICAgICBjb25zdCBtaW1lID0gZm9ybWF0ID09PSAnanBlZycgPyAnaW1hZ2UvanBlZycgOiAnaW1hZ2UvcG5nJztcbiAgICAgICAgY29uc3QgcXVhbGl0eSA9IHR5cGVvZiBvcHRzLnF1YWxpdHkgPT09ICdudW1iZXInID8gTWF0aC5taW4oMSwgTWF0aC5tYXgoMC4xLCBvcHRzLnF1YWxpdHkpKSA6IDAuOTtcbiAgICAgICAgY29uc3QgbWF4V2lkdGggPSB0eXBlb2Ygb3B0cy5tYXhXaWR0aCA9PT0gJ251bWJlcicgJiYgb3B0cy5tYXhXaWR0aCA+IDAgPyBNYXRoLmZsb29yKG9wdHMubWF4V2lkdGgpIDogNjQwO1xuICAgICAgICBjb25zdCB3YWl0TXMgPSB0eXBlb2Ygb3B0cy53YWl0TXMgPT09ICdudW1iZXInID8gTWF0aC5tYXgoMCwgTWF0aC5taW4oNTAwMCwgb3B0cy53YWl0TXMpKSA6IDgwMDtcblxuICAgICAgICBjb25zdCBjYW52YXMgPSBmaW5kVmlld0NhbnZhcyhjYyk7XG4gICAgICAgIGlmICghY2FudmFzKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5om+5LiN5Yiw5Zy65pmv6KeG5Zu+55qE55S75biD77yac2NlbmUg6L+b56iL6YeM5rKh5pyJ5Y+v55So55qEIGNhbnZhc+OAgicgfTtcblxuICAgICAgICBsZXQgZnJhbWU6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHBpeGVsczogVWludDhBcnJheSB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZnJhbWUgPSBhd2FpdCByZWFkVmlld1BpeGVscyhjYywgY2FudmFzLCB3YWl0TXMpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDor7vlj5bnlLvpnaLlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGVuY29kZWQ6IHsgZGF0YVVybDogc3RyaW5nOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZW5jb2RlZCA9IGVuY29kZUZyYW1lVG9EYXRhVXJsKGZyYW1lLnBpeGVscywgZnJhbWUud2lkdGgsIGZyYW1lLmhlaWdodCwge1xuICAgICAgICAgICAgICAgIG1heFdpZHRoLFxuICAgICAgICAgICAgICAgIG1pbWUsXG4gICAgICAgICAgICAgICAgcXVhbGl0eSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDnvJbnoIHlm77niYflpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY29tbWEgPSBlbmNvZGVkLmRhdGFVcmwuaW5kZXhPZignLCcpO1xuICAgICAgICBjb25zdCBiYXNlNjQgPSBjb21tYSA+PSAwID8gZW5jb2RlZC5kYXRhVXJsLnNsaWNlKGNvbW1hICsgMSkgOiAnJztcbiAgICAgICAgY29uc3QgaW5mbzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIHdpZHRoOiBlbmNvZGVkLndpZHRoLFxuICAgICAgICAgICAgaGVpZ2h0OiBlbmNvZGVkLmhlaWdodCxcbiAgICAgICAgICAgIHNvdXJjZVdpZHRoOiBmcmFtZS53aWR0aCxcbiAgICAgICAgICAgIHNvdXJjZUhlaWdodDogZnJhbWUuaGVpZ2h0LFxuICAgICAgICAgICAgZm9ybWF0LFxuICAgICAgICAgICAgYnl0ZXM6IE1hdGguZmxvb3IoKGJhc2U2NC5sZW5ndGggKiAzKSAvIDQpLFxuICAgICAgICAgICAgYmxhbmtSYXRpbzogc2FtcGxlQmxhbmtSYXRpbyhmcmFtZS5waXhlbHMpLFxuICAgICAgICAgICAgLy8g56m65Zu+5pe26L+Z5LiA5Z2X5bCx5piv562U5qGI55qE5LiA5Y2K77ya6KeBIHJlYWRWaWV3U3RhdGUg55qE5rOo6YeK77yI6K6+5aSH5qih5ouf6KKr5omT5o6J55qE6YKj5qyh5LqL5pWF77yJXG4gICAgICAgICAgICB2aWV3OiByZWFkVmlld1N0YXRlKGNjLCBjYW52YXMpLFxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IHNhdmVQYXRoID0gdHlwZW9mIG9wdHMuc2F2ZVBhdGggPT09ICdzdHJpbmcnICYmIG9wdHMuc2F2ZVBhdGgudHJpbSgpID8gb3B0cy5zYXZlUGF0aC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3Qgbm9kZSA9IGdldE5vZGVNb2R1bGVzKCk7XG4gICAgICAgIGlmIChzYXZlUGF0aCAmJiBub2RlKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRpciA9IG5vZGUucGF0aC5kaXJuYW1lKHNhdmVQYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGlyKSBub2RlLmZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIG5vZGUuZnMud3JpdGVGaWxlU3luYyhzYXZlUGF0aCwgQnVmZmVyLmZyb20oYmFzZTY0LCAnYmFzZTY0JykpO1xuICAgICAgICAgICAgICAgIHJldHVybiB7IC4uLmluZm8sIHRyYW5zcG9ydDogJ2ZpbGUnLCBwYXRoOiBzYXZlUGF0aCB9O1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgLy8g5YaZ5LiN6L+b5Y675Lmf6KaB6K6p6LCD55So5pa55ou/5Yiw5Zu+IOKAlOKAlCDlm57okL3liIblnZdcbiAgICAgICAgICAgICAgICBpbmZvLnNhdmVFcnJvciA9IGVycm9ySW5mbyhlcnIpLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjaHVua1NpemUgPSAzMDAwOyAvLyDmspnnrrHljZXlrZfnrKbkuLLkuIrpmZAgNDAwMO+8jOeVmeWHuuS9memHj1xuICAgICAgICBjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFzZTY0Lmxlbmd0aDsgaSArPSBjaHVua1NpemUpIGNodW5rcy5wdXNoKGJhc2U2NC5zbGljZShpLCBpICsgY2h1bmtTaXplKSk7XG4gICAgICAgIGlmIChjaHVua3MubGVuZ3RoID4gOTApIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgLi4uaW5mbyxcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6XG4gICAgICAgICAgICAgICAgICAgIGDmiKrlm77lpKrlpKfvvIzpnIDopoHlm57kvKAgJHtjaHVua3MubGVuZ3RofSDlnZfvvIjkuIrpmZAgOTDvvInvvJrmioogbWF4V2lkdGgg6LCD5bCPYCArXG4gICAgICAgICAgICAgICAgICAgIGDvvIjlvZPliY0gJHttYXhXaWR0aH3vvInjgIHmjaIganBlZ++8jOaIlue7meS4gOS4quWPr+WGmeeahCBzYXZlUGF0aOOAgmAsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IC4uLmluZm8sIHRyYW5zcG9ydDogJ2NodW5rcycsIGNodW5rU2l6ZSwgY2h1bmtzLCBjaHVua0NvdW50OiBjaHVua3MubGVuZ3RoIH07XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOaKiuOAjOi1hOa6kOW8leeUqOOAjeino+aekOaIkCBgU3ByaXRlRnJhbWVgIOKAlOKAlCAqKuWIq+WGjeaJi+aQkyB1dWlk77yM5Lmf5Yir55SoIGBjYy5yZXNvdXJjZXMubG9hZGAqKuOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI6L+Z5Liq5Yqp5omL5b+F6aG75a2Y5Zyo77yI5Lik5qyh5a6e5rWL5Luj5Lu377yJXG4gICAgICpcbiAgICAgKiDnvJbovpHlmajlnLrmma/kuIrkuIvmlofph4zjgIznu5nkuIDkuKogU3ByaXRlIOi1i+WbvueJh+OAjei/meS7tuS6i++8jCoq5LiJ5p2h55u06KeJ5YWo5piv6ZSZ55qEKirvvJpcbiAgICAgKlxuICAgICAqIHwg55u06KeJ5YaZ5rOVIHwg5a6e5rWL57uT5p6cIHxcbiAgICAgKiB8LS0tfC0tLXxcbiAgICAgKiB8IGBjYy5yZXNvdXJjZXMubG9hZCgndGV4dHVyZXMveC9zcHJpdGVGcmFtZScsIGNjLlNwcml0ZUZyYW1lLCBjYilgIHwgYENhbiBub3QgcGFyc2UgdGhpcyBpbnB1dDoge1wicGF0aFwiOuKApixcImJ1bmRsZVwiOlwiXCJ9YCDigJTigJQg57yW6L6R5Zmo5Zy65pmv6YeMIGBjYy5yZXNvdXJjZXNgIOi/meS4gOaho+ayoeiiq+ato+ehruWIneWni+WMliB8XG4gICAgICogfCBgcXVlcnktYXNzZXRzKHtwYXR0ZXJuOidkYjovL2Fzc2V0cy/igKYveC5wbmcvc3ByaXRlRnJhbWUnfSlgIHwgKirpnZnpu5jov5Tlm57nqbrmlbDnu4QqKu+8iOS4jeaKpemUme+8ieKGkiDku6XkuLrjgIzmsqHmnInov5nkuKrlrZDotYTmupDjgI0gfFxuICAgICAqIHwg55u05o6l5oqK5Zu+54mHIHV1aWQg5b2TIFNwcml0ZUZyYW1lIOeUqCB8IOaLv+WIsOeahOaYryBgVGV4dHVyZTJEYO+8jGBTcHJpdGUuc3ByaXRlRnJhbWVgIOi1i+WAvOS4jeaKpemUmeS9hioq55S75LiN5Ye65p2lKiogfFxuICAgICAqXG4gICAgICog5q2j56Gu55qE5LiA5p2h5piv44CM5Zu+54mHIHV1aWQgKyBgQGY5OTQxYCDlrZDotYTmupDplK4g4oaSIGBhc3NldE1hbmFnZXIubG9hZEFueSh7dXVpZH0pYOOAje+8jFxuICAgICAqIOS9humCo+S4qiBgZjk5NDFgIOaYr+i1hOa6kOW6k+eUn+aIkOeahO+8jOS4jeivpeeUseaooeWei+WOu+aLvOOAgui/memHjOaKiuaVtOadoei3r+aUtui/m+S4gOS4quWHveaVsO+8mlxuICAgICAqXG4gICAgICogYGBgXG4gICAgICogY29uc3Qgc2YgPSBhd2FpdCBsb2FkRnJhbWUoJ2RiOi8vYXNzZXRzL3Jlc291cmNlcy90ZXh0dXJlcy9jb21tb24vcmVjdF9yZF8yMC5wbmcnKTtcbiAgICAgKiBjb25zdCBzcHJpdGUgPSBub2RlLmFkZENvbXBvbmVudChjYy5TcHJpdGUpO1xuICAgICAqIHNwcml0ZS5zaXplTW9kZSA9IGNjLlNwcml0ZS5TaXplTW9kZS5DVVNUT007ICAgLy8g4oaQIOW/hemhu+WFiOS6jiBzcHJpdGVGcmFtZe+8iOingeWPpuS4gOadoeWdke+8iVxuICAgICAqIHNwcml0ZS5zcHJpdGVGcmFtZSA9IHNmO1xuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogIyMg5o6l5Y+X55qE5LiJ56eN5byV55SoXG4gICAgICpcbiAgICAgKiAxLiBgZGI6Ly9hc3NldHMvLi4uL3gucG5nYO+8iCoq5o6o6I2QKirvvJvlhpnmiJAgYC4uLi94LnBuZy9zcHJpdGVGcmFtZWAg5Lmf6KGM77yM5ZCO57yA5Lya6KKr5Y675o6J77yJ4oCU4oCUXG4gICAgICogICAg6LWwKirno4Hnm5jkuIrnmoQgYC5tZXRhYCoq77yaYGFzc2V0cy8855u45a+56Lev5b6EPi5tZXRhYCDph4wgYHN1Yk1ldGFzYCDkuK0gYG5hbWUgPT09ICdzcHJpdGVGcmFtZSdgXG4gICAgICogICAg6YKj5LiA5p2h55qEIGB1dWlkYCDlsLHmmK8gYDzlm74gdXVpZD5AZjk5NDFg44CCYC5tZXRhYCDmmK/otYTmupDlupPoh6rlt7HlhpnnmoTvvIznprvnur/lj6/or7vvvIxcbiAgICAgKiAgICDkuI3kvp3otZYgYEVkaXRvcmAg5Zyo5LiN5Zyo44CB5Lmf5LiN6ZyA6KaB5YaN5Y67IGVkaXRvciDkuIrkuIvmlofmn6XkuIDmrKHjgIJcbiAgICAgKiAyLiBgdXVpZEBmOTk0MWDvvIjlrZDotYTmupAgdXVpZO+8ieKAlOKAlCDnm7TmjqXnlKjjgIJcbiAgICAgKiAzLiDoo7jlm77niYcgdXVpZCDigJTigJQg5YWI5oyJ5Y6f5qC35Yqg6L2977yb5ou/5YiwIGBUZXh0dXJlMkRgIOaXtioq5YaN6K+V5LiA5qyhIGBAZjk5NDFgKipcbiAgICAgKiAgICDvvIhDcmVhdG9yIDMueCDnmoQgc3ByaXRlLWZyYW1lIOWtkOi1hOa6kOmUruWwseaYr+i/meS4quW4uOmHj++8ie+8jOW5tuWmguWunuivtOaYjuaYr+eMnOeahOOAglxuICAgICAqXG4gICAgICog6Kej5p6Q57uT5p6c5Zyo5ZCM5LiA5q616ISa5pys6YeM5Lya57yT5a2Y77yI5ZCM5LiA5Liq5byV55So6YeN5aSN5Y+W5LiN5Lya6YeN5aSN5Yqg6L2977yJ44CCXG4gICAgICog5ou/5LiN5Yiw5pe2Kirmipvlh7ror7TlvpfmuIXnmoTplJnor68qKu+8iOivlei/h+WTquS6m+WAmemAieOAgeavj+S4quWAmemAieaLv+WIsOS6huS7gOS5iOexu+Wei++8ie+8jFxuICAgICAqIOiAjOS4jeaYr+WbnuS4gOS4qiBgbnVsbGAg6K6p6LCD55So5pa55Y6754yc44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcmVmIC0g5LiK6Z2i5LiJ56eN5byV55So5LmL5LiA44CCXG4gICAgICogQHJldHVybnMg6K+l6LWE5rqQ55qEIGBTcHJpdGVGcmFtZWDjgIJcbiAgICAgKi9cbiAgICBjb25zdCBmcmFtZUNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcbiAgICBoZWxwZXJzLmxvYWRGcmFtZSA9IGFzeW5jIChyZWY6IHVua25vd24pOiBQcm9taXNlPGFueT4gPT4ge1xuICAgICAgICBjb25zdCByYXcgPSB0eXBlb2YgcmVmID09PSAnc3RyaW5nJyA/IHJlZi50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFyYXcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcImxvYWRGcmFtZShyZWYp77yacmVmIOaYr+epuueahOOAgueUqOazle+8mmxvYWRGcmFtZSgnZGI6Ly9hc3NldHMvcmVzb3VyY2VzL3RleHR1cmVzL2NvbW1vbi9yZWN0X3JkXzIwLnBuZycpXCIgK1xuICAgICAgICAgICAgICAgICAgICBcIu+8iOWbvueJh+i3r+W+hO+8jOWPr+ecgSAvc3ByaXRlRnJhbWXvvInmiJYgbG9hZEZyYW1lKCc8dXVpZD5AZjk5NDEnKeOAglwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZnJhbWVDYWNoZS5oYXMocmF3KSkgcmV0dXJuIGZyYW1lQ2FjaGUuZ2V0KHJhdyk7XG5cbiAgICAgICAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG5cbiAgICAgICAgLyoqIOWKoOi9veS4gOS4qiB1dWlk77yI5Zue6LCD5byP77yM5LiO57yW6L6R5Zmo6YeM5a6e5rWL6IO955So55qE6YKj5p2h6Lev5LiA6Ie077yJ44CCICovXG4gICAgICAgIGNvbnN0IGxvYWRBbnkgPSAodXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+ID0+XG4gICAgICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY2MuYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnI6IGFueSwgYXNzZXQ6IGFueSkgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVyciA/IHJlamVjdChuZXcgRXJyb3IoZXJyLm1lc3NhZ2UgPyBTdHJpbmcoZXJyLm1lc3NhZ2UpIDogU3RyaW5nKGVycikpKSA6IHJlc29sdmUoYXNzZXQpLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGVycm9ySW5mbyhlcnIpLm1lc3NhZ2UpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICBpZiAoL0AvLnRlc3QocmF3KSkge1xuICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHJhdyk7XG4gICAgICAgIH0gZWxzZSBpZiAocmF3LmluZGV4T2YoJ2RiOi8vJykgPT09IDApIHtcbiAgICAgICAgICAgIGlmIChyYXcuaW5kZXhPZignZGI6Ly9hc3NldHMvJykgIT09IDApIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBsb2FkRnJhbWUg5Y+q6K6kIGRiOi8vYXNzZXRzLyDkuIvnmoTotYTmupDvvIjmlLbliLAgJHtyYXd977yJ44CCYCArXG4gICAgICAgICAgICAgICAgICAgICAgICAnZGI6Ly9pbnRlcm5hbCDmmK/lvJXmk47oh6rluKbotYTmupDjgIHmmKDlsITkuI3liLDlt6XnqIvnm67lvZXvvJvlhoXnva4gVUkg5Zu+6K+35oyJIHNraWxsIOmHjOeahOi3r+W+hOihqOeUqCBsb2FkQW55KHt1dWlkfSkg6YKj5p2h77yIdXVpZCDku44gYXNzZXQtZGIg5p+l77yJ44CCJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgcmVsID0gcmF3LnNsaWNlKCdkYjovL2Fzc2V0cy8nLmxlbmd0aCkucmVwbGFjZSgvXFwvKHNwcml0ZUZyYW1lfHRleHR1cmUpJC8sICcnKTtcbiAgICAgICAgICAgIGNvbnN0IHJvb3QgPSBwcm9qZWN0Um9vdCgpO1xuICAgICAgICAgICAgY29uc3Qgbm9kZU1vZHMgPSBnZXROb2RlTW9kdWxlcygpO1xuICAgICAgICAgICAgaWYgKCFyb290IHx8ICFub2RlTW9kcykge1xuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgICAgIGDmi7/kuI3liLDlt6XnqIvmoLnvvIhFZGl0b3IuUHJvamVjdC5wYXRo77yJ5oiWIG5vZGUg5qih5Z2X77yM5omA5Lul5rKh6IO96K+7ICR7cmVsfS5tZXRhIOKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAgICAgICAgICfmlLnnlKggbG9hZEZyYW1lKFwiPHV1aWQ+QGY5OTQxXCIp77yIdXVpZCDku44gZWRpdG9yIOS4iuS4i+aWhyBxdWVyeS1hc3NldHMg5ou/77yJ44CCJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZXRhRmlsZSA9IGAke25vZGVNb2RzLnBhdGguam9pbihyb290LCAnYXNzZXRzJywgcmVsKX0ubWV0YWA7XG4gICAgICAgICAgICAgICAgbGV0IG1ldGE6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgbWV0YSA9IEpTT04ucGFyc2Uobm9kZU1vZHMuZnMucmVhZEZpbGVTeW5jKG1ldGFGaWxlLCAndXRmLTgnKSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYOivu+S4jeWIsCAke3JlbH0ubWV0Ye+8iCR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX3vvIlgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3Qgc3ViTWV0YXMgPSBtZXRhICYmIHR5cGVvZiBtZXRhLnN1Yk1ldGFzID09PSAnb2JqZWN0JyAmJiBtZXRhLnN1Yk1ldGFzID8gbWV0YS5zdWJNZXRhcyA6IG51bGw7XG4gICAgICAgICAgICAgICAgaWYgKHN1Yk1ldGFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHN1Yk1ldGFzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZW50cnkgPSBzdWJNZXRhc1trZXldIHx8IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaXNTcHJpdGVGcmFtZSA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50cnkubmFtZSA9PT0gJ3Nwcml0ZUZyYW1lJyB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5LmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5LmltcG9ydGVyID09PSAnc3ByaXRlRnJhbWUnO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1Nwcml0ZUZyYW1lKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIOWtkOi1hOa6kOeahCB1dWlkIOWtl+auteacrOi6q+WwseW4piBgQGtleWDvvJvmsqHmnInlsLHoh6rlt7Hmi7xcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaCh0eXBlb2YgZW50cnkudXVpZCA9PT0gJ3N0cmluZycgJiYgZW50cnkudXVpZCA/IGVudHJ5LnV1aWQgOiBgJHttZXRhLnV1aWR9QCR7a2V5fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKGAke3JlbH0ubWV0YSDph4zmsqHmnIkgc3ByaXRlRnJhbWUg5a2Q6LWE5rqQ77yI5a6D5Y+v6IO95LiN5piv5Zu+54mH77yM5oiW6L+Y5rKh6KKr6LWE5rqQ5bqT5a+85YWl77yJYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoL15bMC05YS1mQS1GLV17MzIsNDB9JC8udGVzdChyYXcpKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGVzLnB1c2gocmF3KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBgbG9hZEZyYW1lIOiupOS4jeWHuui/meS4quW8leeUqO+8miR7cmF3feOAgue7mSBkYjovL2Fzc2V0cy/igKYg55qE5Zu+54mH6Lev5b6E44CBdXVpZEDlrZDotYTmupDplK7vvIzmiJboo7ggdXVpZOOAgmAsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxhc3QgPSAnJztcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjYW5kaWRhdGVzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBjYW5kaWRhdGVzW2ldO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IGxvYWRBbnkoY2FuZGlkYXRlKTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQgJiYgY2MuU3ByaXRlRnJhbWUgJiYgYXNzZXQgaW5zdGFuY2VvZiBjYy5TcHJpdGVGcmFtZSkge1xuICAgICAgICAgICAgICAgICAgICBmcmFtZUNhY2hlLnNldChyYXcsIGFzc2V0KTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBraW5kID0gYXNzZXQgJiYgYXNzZXQuY29uc3RydWN0b3IgJiYgYXNzZXQuY29uc3RydWN0b3IubmFtZSA/IGFzc2V0LmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgYXNzZXQ7XG4gICAgICAgICAgICAgICAgbGFzdCA9IGAke2NhbmRpZGF0ZX0g4oaSICR7a2luZH1gO1xuICAgICAgICAgICAgICAgIC8vIOaLv+WIsCBUZXh0dXJlMkTvvJrooaXkuIDmrKHmoIflh4bnmoQgc3ByaXRlRnJhbWUg5a2Q6LWE5rqQ6ZSu77yI5Y+q6KGl5LiA5qyh77yM5Yir5oqK6Ieq5bex57uV6L+b5q275b6q546v77yJXG4gICAgICAgICAgICAgICAgaWYgKGtpbmQgPT09ICdUZXh0dXJlMkQnICYmIGNhbmRpZGF0ZS5pbmRleE9mKCdAJykgPCAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaChgJHtjYW5kaWRhdGV9QGY5OTQxYCk7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYOijuCB1dWlkIOaLv+WIsOeahOi1hOa6kOaYryBUZXh0dXJlMkTvvIzor5XkuobkuIDmrKHmoIflh4bnmoQgQGY5OTQxIOWtkOi1hOa6kOmUrmApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGxhc3QgPSBgJHtjYW5kaWRhdGV9IOKGkiAke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBsb2FkRnJhbWUoJyR7cmF3fScpIOayoeiDveaLv+WIsCBTcHJpdGVGcmFtZeOAgiR7bGFzdCA/IGDmnIDlkI7kuIDmrKHvvJoke2xhc3R944CCYCA6ICcnfWAgK1xuICAgICAgICAgICAgICAgIChub3Rlcy5sZW5ndGggPiAwID8gYOWPpuWklu+8miR7bm90ZXMuam9pbign77ybJyl944CCYCA6ICcnKSArXG4gICAgICAgICAgICAgICAgXCIg5o6o6I2Q5YaZ5rOV77yabG9hZEZyYW1lKCdkYjovL2Fzc2V0cy9yZXNvdXJjZXMvdGV4dHVyZXMvY29tbW9uL3JlY3RfcmRfMjAucG5nJynjgIJcIixcbiAgICAgICAgKTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog5Y+W6IqC54K555qEIGBVSVRyYW5zZm9ybWDvvIjmi7/kuI3liLDlsLEgbnVsbO+8ieOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB5YyF5LiA5bGC77yaYGNjLlVJVHJhbnNmb3JtYCDmnKzouqvlj6/og73lj5bkuI3liLDvvIjlvJXmk47niYjmnKwv6Z2eIFVJIOiKgueCue+8ie+8jFxuICAgICAqIOi/meaXtiBgZ2V0Q29tcG9uZW50KHVuZGVmaW5lZClgIOacieeahOeJiOacrOS8muaKmyDigJTigJQg5biD5bGA6K6h566X5LiN6K+l5Zug5Li65Y+W5LiN5Yiw5bC65a+46ICM5pW05p2h5oyC5o6J77yMXG4gICAgICog5a696auY5oyJIDAg566X44CB5oqK5Z2Q5qCH54Wn5bi45oql5Ye65Y675pu05pyJ55So77yI6LCD55So5pa555yL5YiwIGB3aWR0aDogMGAg6Ieq54S255+l6YGT5piv5rKh6YeP5Yiw77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgdWlUcmFuc2Zvcm1PZiA9IChub2RlOiBhbnkpOiBhbnkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFub2RlIHx8IHR5cGVvZiBub2RlLmdldENvbXBvbmVudCAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAoIWNjLlVJVHJhbnNmb3JtKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIHJldHVybiBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSkgfHwgbnVsbDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDoioLngrnlnKgqKue8lui+keaAgeS4i+WPr+S/oeeahCoq5LiW55WM55+p5b2iIOKAlOKAlCDliKvnlKggYFVJVHJhbnNmb3JtLmdldEJvdW5kaW5nQm94VG9Xb3JsZCgpYOOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI5LiN6IO955So5byV5pOO6YKj5LiqXG4gICAgICpcbiAgICAgKiDlrp7mtYvvvIhDb2NvcyAzLjguNiDnvJbovpHmgIHvvInvvJrlkIzkuIDmo7XmoJHph4wgYHZpZXdg77yIYGNvbnRlbnRTaXplYCA3MTDDlzEwNzTjgIFwb3NpdGlvbiAoMCwwKe+8iVxuICAgICAqIOiiqyBgZ2V0Qm91bmRpbmdCb3hUb1dvcmxkKClgIOaKpeaIkCAqKjcxMMOXMTE3MCoq77yM6ICMIDExNzAg5oGw5aW95piv5a6D5a2Q6IqC54K5IGBjb250ZW50YCDnmoTpq5jluqbvvJtcbiAgICAgKiBgY29udGVudGAg55qEIHgg5Lmf6KKr5oql5YGP44CCKirlroPnu5nnmoTmmK/oh6rnm7jnn5vnm77nmoTlgLwqKu+8jOiAjOW4g+WxgOmqjOaUtuWFqOmdoOi/meS4quaVsOOAglxuICAgICAqXG4gICAgICogIyMg6L+Z6YeM55qE566X5rOV77yI5LiOIGBjb250ZW50U2l6ZWAg6Ieq5rS977yM6IO95omL5bel5qC45a+577yJXG4gICAgICpcbiAgICAgKiDniLboioLngrnnmoQqKumUmueCuSoq5bCx5piv5a2Q6IqC54K55bGA6YOo5Z2Q5qCH55qE5Y6f54K577yM5LqO5piv6Ieq5LiL6ICM5LiK57Sv5Yqg77yaXG4gICAgICpcbiAgICAgKiBgYGBcbiAgICAgKiDplJrngrnkuJbnlYzlnZDmoIcobikgPSDplJrngrnkuJbnlYzlnZDmoIcocGFyZW50KSArIHNjYWxl6ZO+KG4pIOKKmSBuLnBvc2l0aW9uXG4gICAgICog5Lit5b+D5LiW55WM5Z2Q5qCHKG4pID0g6ZSa54K55LiW55WM5Z2Q5qCHKG4pICsgc2NhbGXpk74obikg4oqZICgoMC41LWF4KcK3dywgKDAuNS1heSnCt2gpXG4gICAgICog5LiW55WM5bC65a+4KG4pICAgICA9IHNjYWxl6ZO+KG4pIOKKmSAodywgaCkgICAgICAgIC8vIOS4jeiAg+iZkeaXi+i9rFxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogYHNjYWxl6ZO+KG4pYCA9IG4gKirmiYDmnInnpZblhYgqKu+8iOS4jeWQq+iHquW3se+8ieeahCBzY2FsZSDkuZjnp6/vvJtgcm9vdGAg5pys6Lqr5LiN5Y+C5LiO57Sv5Yqg77yMXG4gICAgICog5omA5Lul57uZIGByb290YCDml7bov5Tlm57lgLzlsLHmmK8qKuS7pSByb290IOeahOmUmueCueS4uuWOn+eCuSoq55qE5Z2Q5qCH77yI6L+Z5q2j5pivXCLov5nlvKDljaHlnKggQ2FudmFzIOmHjFxuICAgICAqIOWBj+S6huWkmuWwkVwi6KaB55qE6YKj5Liq5pWw77yJ44CC5LiN57uZIGByb290YCDlsLHkuIDot6/ntK/liqDliLDlnLrmma/moLnjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBub2RlIC0g55uu5qCH6IqC54K544CCXG4gICAgICogQHBhcmFtIG9wdGlvbnMucm9vdCAtIOe0r+WKoOeahOe7iOeCue+8iOi/lOWbnuWdkOagh+S7peWug+eahOmUmueCueS4uuWOn+eCue+8ie+8m+m7mOiupOWcuuaZr+agueOAglxuICAgICAqIEByZXR1cm5zIGB7Y3gsIGN5LCB3aWR0aCwgaGVpZ2h0LCBsZWZ0LCByaWdodCwgYm90dG9tLCB0b3AsIGFuY2hvclgsIGFuY2hvclksIHNjYWxlWCwgc2NhbGVZfWBcbiAgICAgKiAgIOKAlOKAlCBgbGVmdC9yaWdodC9ib3R0b20vdG9wYCDmmK/nn6nlvaLnmoTlm5vmnaHovrnvvIxgY3gvY3lgIOaYr+S4reW/g+OAgioq5Z2Q5qCH57O75Li644CMK3gg5ZCR5Y+z44CBK3kg5ZCR5LiK44CNKirjgIJcbiAgICAgKi9cbiAgICBoZWxwZXJzLndvcmxkUmVjdCA9IChcbiAgICAgICAgbm9kZTogYW55LFxuICAgICAgICBvcHRpb25zPzogeyByb290PzogYW55IH0sXG4gICAgKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBpZiAoIW5vZGUpIHRocm93IG5ldyBFcnJvcignd29ybGRSZWN0KG5vZGUp77yabm9kZSDmmK/nqbrnmoTjgIInKTtcbiAgICAgICAgY29uc3Qgc3RvcEF0ID0gb3B0aW9ucyAmJiBvcHRpb25zLnJvb3QgPyBvcHRpb25zLnJvb3QgOiBudWxsO1xuXG4gICAgICAgIC8vIOKRoCDlhYjoh6rkuIvogIzkuIrmlLbpm4bpk77ot6/vvJpbbm9kZSwgcGFyZW50LCDigKYsIChzdG9wQXQgfCDlnLrmma/moLkpXVxuICAgICAgICBjb25zdCBjaGFpbjogYW55W10gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgY3Vyc29yID0gbm9kZTsgY3Vyc29yOyBjdXJzb3IgPSBjdXJzb3IucGFyZW50KSB7XG4gICAgICAgICAgICBjaGFpbi5wdXNoKGN1cnNvcik7XG4gICAgICAgICAgICBpZiAoc3RvcEF0ICYmIGN1cnNvciA9PT0gc3RvcEF0KSBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOKRoSDku47pk77ot6/pobbnq6/lvoDkuIvntK/liqDjgILpobbnq6/vvIhzdG9wQXQg5oiW5Zy65pmv5qC577yJ55qE6ZSa54K55bCx5piv5Y6f54K577yaYW5jaG9yPSgwLDAp44CBUz0oMSwxKVxuICAgICAgICBsZXQgYW5jaG9yWCA9IDA7XG4gICAgICAgIGxldCBhbmNob3JZID0gMDtcbiAgICAgICAgbGV0IHN4ID0gMTtcbiAgICAgICAgbGV0IHN5ID0gMTtcbiAgICAgICAgZm9yIChsZXQgaSA9IGNoYWluLmxlbmd0aCAtIDI7IGkgPj0gMDsgaSAtPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBjaGlsZCA9IGNoYWluW2ldO1xuICAgICAgICAgICAgY29uc3QgcGFyZW50ID0gY2hhaW5baSArIDFdO1xuICAgICAgICAgICAgY29uc3QgcHMgPSBwYXJlbnQuc2NhbGUgfHwgeyB4OiAxLCB5OiAxIH07XG4gICAgICAgICAgICBzeCAqPSB0eXBlb2YgcHMueCA9PT0gJ251bWJlcicgPyBwcy54IDogMTtcbiAgICAgICAgICAgIHN5ICo9IHR5cGVvZiBwcy55ID09PSAnbnVtYmVyJyA/IHBzLnkgOiAxO1xuICAgICAgICAgICAgY29uc3QgcG9zID0gY2hpbGQucG9zaXRpb24gfHwgeyB4OiAwLCB5OiAwIH07XG4gICAgICAgICAgICBhbmNob3JYICs9IHN4ICogcG9zLng7XG4gICAgICAgICAgICBhbmNob3JZICs9IHN5ICogcG9zLnk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDikaIg6ZSa54K5IOKGkiDkuK3lv4PvvIjplJrngrnlgY/np7vkuZ/opoHot5/nnYDpk77kuIrnmoTnvKnmlL7kuIDotbfnvKnmlL7vvIlcbiAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICBjb25zdCB3aWR0aCA9IHV0ID8gdXQud2lkdGggOiAwO1xuICAgICAgICBjb25zdCBoZWlnaHQgPSB1dCA/IHV0LmhlaWdodCA6IDA7XG4gICAgICAgIGNvbnN0IGF4ID0gdXQgPyB1dC5hbmNob3JYIDogMC41O1xuICAgICAgICBjb25zdCBheSA9IHV0ID8gdXQuYW5jaG9yWSA6IDAuNTtcbiAgICAgICAgY29uc3QgY3ggPSBhbmNob3JYICsgc3ggKiAoMC41IC0gYXgpICogd2lkdGg7XG4gICAgICAgIGNvbnN0IGN5ID0gYW5jaG9yWSArIHN5ICogKDAuNSAtIGF5KSAqIGhlaWdodDtcbiAgICAgICAgY29uc3QgaGFsZlcgPSAoc3ggKiB3aWR0aCkgLyAyO1xuICAgICAgICBjb25zdCBoYWxmSCA9IChzeSAqIGhlaWdodCkgLyAyO1xuICAgICAgICBjb25zdCByb3VuZCA9ICh2YWx1ZTogbnVtYmVyKTogbnVtYmVyID0+IE1hdGgucm91bmQodmFsdWUgKiAxMDAwKSAvIDEwMDA7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICBjeDogcm91bmQoY3gpLFxuICAgICAgICAgICAgY3k6IHJvdW5kKGN5KSxcbiAgICAgICAgICAgIHdpZHRoOiByb3VuZChzeCAqIHdpZHRoKSxcbiAgICAgICAgICAgIGhlaWdodDogcm91bmQoc3kgKiBoZWlnaHQpLFxuICAgICAgICAgICAgbGVmdDogcm91bmQoY3ggLSBoYWxmVyksXG4gICAgICAgICAgICByaWdodDogcm91bmQoY3ggKyBoYWxmVyksXG4gICAgICAgICAgICBib3R0b206IHJvdW5kKGN5IC0gaGFsZkgpLFxuICAgICAgICAgICAgdG9wOiByb3VuZChjeSArIGhhbGZIKSxcbiAgICAgICAgICAgIGFuY2hvclg6IGF4LFxuICAgICAgICAgICAgYW5jaG9yWTogYXksXG4gICAgICAgICAgICBzY2FsZVg6IHJvdW5kKHN4KSxcbiAgICAgICAgICAgIHNjYWxlWTogcm91bmQoc3kpLFxuICAgICAgICAgICAgLyoqIOWdkOagh+ezu+WPo+W+hO+8iOWGmei/m+e7k+aenOmHjO+8jOWFjeW+l+iwg+eUqOaWueiHquW3seeMnOWOn+eCueWcqOWTqu+8iSAqL1xuICAgICAgICAgICAgb3JpZ2luOiBzdG9wQXQgPyBg5LulICR7c3RvcEF0Lm5hbWV9IOeahOmUmueCueS4uuWOn+eCue+8iCt4IOWQkeWPsyAvICt5IOWQkeS4iu+8iWAgOiAn5Lul5Zy65pmv5qC56ZSa54K55Li65Y6f54K577yIK3gg5ZCR5Y+zIC8gK3kg5ZCR5LiK77yJJyxcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog5Zy65pmvKirnnJ/lrp7lhoXlrrkqKueahOS4lueVjOWMheWbtOebku+8iOaKiuavj+S4quW4piBgVUlUcmFuc2Zvcm1gIOeahOWGheWuueiKgueCueW5tui1t+adpe+8ieOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI5LiN6IO96Z2g6YGN5Y6G5YWo5L2T6IqC54K5XG4gICAgICpcbiAgICAgKiDnvJbovpHlmajlnLrmma/moJHph4wgOTclIOeahOiKgueCueaYr+e8lui+keWZqOiHquW3seeahOijhemlsO+8iOWunua1i++8muS4gOS4quWPquaciSBDYW52YXMg55qE56m65Zy65pmvXG4gICAgICog5YWxIDEyOCDkuKroioLngrnvvIzlhbbkuK0gMiDkuKrmmK/lhoXlrrnjgIExMTcg5Liq5ZyoIGBFZGl0b3IgU2NlbmUgRm9yZWdyb3VuZGDjgIE4IOS4quWcqCBgQmFja2dyb3VuZGDvvInjgIJcbiAgICAgKiDkuI3liarmjonpgqPkuKTmo7XvvIznrpflh7rmnaXnmoRcIuWcuuaZr+iMg+WbtFwi5Lya5piv5pW05byg572R5qC844CCXG4gICAgICog5Ymq5p6d5Yik5o2u5LiOIGBlYWNoTm9kZWAg5a6M5YWo5LiA6Ie077yIYGlzRWRpdG9yTm9kZWDvvInjgIJcbiAgICAgKlxuICAgICAqICMjIOWug+acieS4pOS4qua2iOi0ueiAhVxuICAgICAqXG4gICAgICogMS4gKirmiKrlm77lj5bmma8qKu+8iGBmaXRWaWV3YCAvIGB2aWV3TWV0cmljcy5mcmFtaW5nYO+8ieKAlOKAlCDjgIzmlbTkuKrlnLrmma/jgI3liLDlupXmjIflk6rlnZfnn6nlvaLvvIxcbiAgICAgKiAgICDliKTmja7lv4XpobvmmK/lkIzkuIDkuKrvvIzlkKbliJnkvJrlh7rnjrBcIuWPluaZr+ahhiBB44CB6aqM5pS255yLIEJcIu+8m1xuICAgICAqIDIuIOaooeWei+iHquW3semXruOAjOaIkeeahOWcuuaZr+WGheWuueWkmuWkp+OAgei3keWIsOWTquWEv+WOu+S6huOAjeOAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtsZWZ0LCByaWdodCwgYm90dG9tLCB0b3AsIGN4LCBjeSwgd2lkdGgsIGhlaWdodCwgY291bnQsIHV1aWRzLCBub3RlP31gXG4gICAgICogICDigJTigJQgYHV1aWRzYCDmmK8qKuS6pOe7mee8lui+keWZqCBgZm9jdXMoKWAg55So55qE6YKj5LiyKirvvIjmr4/kuIDmnaHmlK/ot6/kuIrmnIDmtYXnmoTjgIHnnJ/mnInlsLrlr7jnmoToioLngrnvvIxcbiAgICAgKiAgIOmAmuW4uOWwseaYryBgQ2FudmFzYO+8ie+8jOacgOWkmiA4IOS4qu+8m+WGheWuueWFqOaYr+epuuiKgueCueaXtiBgd2lkdGgvaGVpZ2h0YCDkuLogMO+8iOWmguWunuWbniAw77yM5LiN57yW5qGG77yJ44CCXG4gICAgICovXG4gICAgaGVscGVycy5jb250ZW50Qm91bmRzID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICAgICAgY29uc3Qgcm91bmQgPSAodmFsdWU6IG51bWJlcik6IG51bWJlciA9PiBNYXRoLnJvdW5kKHZhbHVlICogMTAwMCkgLyAxMDAwO1xuICAgICAgICAvKiogYGhlbHBlcnNgIOiHquW3seeahOexu+Wei+aYryBgUmVjb3JkPHN0cmluZywgdW5rbm93bj5g77yM6L+Z6YeM5oyJ562+5ZCN5Y+W5Ye65p2l55So77yI5ZCMIGB3b3JsZFJlY3RgIOWGhemDqOeahOWBmuazle+8iSAqL1xuICAgICAgICBjb25zdCBlYWNoID0gaGVscGVycy5lYWNoTm9kZSBhcyAodmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgICAgIGNvbnN0IHJlY3RPZiA9IGhlbHBlcnMud29ybGRSZWN0IGFzIChub2RlOiBhbnksIG9wdGlvbnM/OiB7IHJvb3Q/OiBhbnkgfSkgPT4gUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgbGV0IGxlZnQgPSBJbmZpbml0eTtcbiAgICAgICAgbGV0IHJpZ2h0ID0gLUluZmluaXR5O1xuICAgICAgICBsZXQgYm90dG9tID0gSW5maW5pdHk7XG4gICAgICAgIGxldCB0b3AgPSAtSW5maW5pdHk7XG4gICAgICAgIGxldCBjb3VudCA9IDA7XG5cbiAgICAgICAgZWFjaCgobm9kZTogYW55KSA9PiB7XG4gICAgICAgICAgICBjb25zdCB1dCA9IHVpVHJhbnNmb3JtT2Yobm9kZSk7XG4gICAgICAgICAgICBpZiAoIXV0IHx8ICEodXQud2lkdGggPiAwKSB8fCAhKHV0LmhlaWdodCA+IDApKSByZXR1cm47XG4gICAgICAgICAgICBsZXQgcmVjdDogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVjdCA9IHJlY3RPZihub2RlKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJldHVybjsgLy8g5Y2V5Liq6IqC54K56YeP5LiN5Ye65p2l5LiN6K+l6K6p5pW05byg6KGo5oyC5o6JXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIVtyZWN0LmxlZnQsIHJlY3QucmlnaHQsIHJlY3QuYm90dG9tLCByZWN0LnRvcF0uZXZlcnkoKHYpID0+IHR5cGVvZiB2ID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodikpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY291bnQgKz0gMTtcbiAgICAgICAgICAgIGlmIChyZWN0LmxlZnQgPCBsZWZ0KSBsZWZ0ID0gcmVjdC5sZWZ0O1xuICAgICAgICAgICAgaWYgKHJlY3QucmlnaHQgPiByaWdodCkgcmlnaHQgPSByZWN0LnJpZ2h0O1xuICAgICAgICAgICAgaWYgKHJlY3QuYm90dG9tIDwgYm90dG9tKSBib3R0b20gPSByZWN0LmJvdHRvbTtcbiAgICAgICAgICAgIGlmIChyZWN0LnRvcCA+IHRvcCkgdG9wID0gcmVjdC50b3A7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8qKiDkuqTnu5kgYGZvY3VzKClgIOeahCB1dWlk77ya5q+P5LiA5p2h5pSv6Lev5LiKKirmnIDmtYXnmoQqKumCo+S4quecn+acieWwuuWvuOeahOiKgueCue+8iOmAmuW4uOWwseaYryBDYW52YXPvvIkgKi9cbiAgICAgICAgY29uc3QgdXVpZHM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGNvbnN0IGZvY3VzV2FsayA9IChub2RlOiBhbnkpOiB2b2lkID0+IHtcbiAgICAgICAgICAgIGlmICh1dWlkcy5sZW5ndGggPj0gOCkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICAgICAgaWYgKHV0ICYmIHV0LndpZHRoID4gMCAmJiB1dC5oZWlnaHQgPiAwKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vZGUudXVpZCkgdXVpZHMucHVzaChub2RlLnV1aWQpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY29udGVudENoaWxkcmVuKG5vZGUpKSBmb2N1c1dhbGsoY2hpbGQpO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmIChzY2VuZSkge1xuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIGNvbnRlbnRDaGlsZHJlbihzY2VuZSkpIGZvY3VzV2Fsayhyb290KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb3VudCA9PT0gMCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBsZWZ0OiAwLFxuICAgICAgICAgICAgICAgIHJpZ2h0OiAwLFxuICAgICAgICAgICAgICAgIGJvdHRvbTogMCxcbiAgICAgICAgICAgICAgICB0b3A6IDAsXG4gICAgICAgICAgICAgICAgY3g6IDAsXG4gICAgICAgICAgICAgICAgY3k6IDAsXG4gICAgICAgICAgICAgICAgd2lkdGg6IDAsXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiAwLFxuICAgICAgICAgICAgICAgIGNvdW50LFxuICAgICAgICAgICAgICAgIHV1aWRzLFxuICAgICAgICAgICAgICAgIG5vdGU6ICflnLrmma/ph4zmsqHmnInluKYgVUlUcmFuc2Zvcm0g5LiU5bC65a+45aSn5LqOIDAg55qE5YaF5a656IqC54K577yI6YeP5LiN5Ye65YaF5a656IyD5Zu077yJJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB3aWR0aCA9IHJpZ2h0IC0gbGVmdDtcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gdG9wIC0gYm90dG9tO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbGVmdDogcm91bmQobGVmdCksXG4gICAgICAgICAgICByaWdodDogcm91bmQocmlnaHQpLFxuICAgICAgICAgICAgYm90dG9tOiByb3VuZChib3R0b20pLFxuICAgICAgICAgICAgdG9wOiByb3VuZCh0b3ApLFxuICAgICAgICAgICAgY3g6IHJvdW5kKChsZWZ0ICsgcmlnaHQpIC8gMiksXG4gICAgICAgICAgICBjeTogcm91bmQoKGJvdHRvbSArIHRvcCkgLyAyKSxcbiAgICAgICAgICAgIHdpZHRoOiByb3VuZCh3aWR0aCksXG4gICAgICAgICAgICBoZWlnaHQ6IHJvdW5kKGhlaWdodCksXG4gICAgICAgICAgICBjb3VudCxcbiAgICAgICAgICAgIHV1aWRzLFxuICAgICAgICAgICAgLyoqIOWdkOagh+ezu+WPo+W+hOWGmei/m+e7k+aenO+8jOiwg+eUqOaWueS4jeeUqOeMnOWOn+eCuSAqL1xuICAgICAgICAgICAgb3JpZ2luOiAn5Lul5Zy65pmv5qC56ZSa54K55Li65Y6f54K577yIK3gg5ZCR5Y+zIC8gK3kg5ZCR5LiK77yJJyxcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyDlm5vkuKrjgIzmiorkuIDova7or5XplJnljovmiJDkuIDmrKHosIPnlKjjgI3nmoTliqnmiYtcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vXG4gICAgLy8g5a6D5Lus5LiN5piv6JaE5YyF6KOF44CC5q+P5Liq6YO95a+55bqUKirkuIDmrKHlrp7mtYvnmoTlvK/ot68qKu+8jOiAjOS4lOWFseWQjOa7oei2s+S4gOS4quWIpOaNru+8mlxuICAgIC8vICoqbmFpdmUg5YaZ5rOV6KaB5LmI5Lya566X6ZSZ44CB6KaB5LmI5pyJ5Ymv5L2c55So44CB6KaB5LmI6KaBIE4g6L2u5omN5ou/5b6X5Yiw57uT6K66KirjgIJcbiAgICAvL1xuICAgIC8vIHwg5Yqp5omLIHwg5a6D5pu/5Luj5o6J55qE5byv6LevIHxcbiAgICAvLyB8LS0tfC0tLXxcbiAgICAvLyB8IGBwaWNrYCB8IOOAjOaIquWbvumHjOacieS4que0q+aWueWdlyDihpIg5p6a5Li+5a2Q5qCRIOKGkiDpopzoibLnm7Tmlrnlm74g4oaSIOWPjeeul+WdkOaghyDihpIgZ3JlcCDpooTliLbku7bjgI0xNiDova7vvIznu5PorrrmmK/lroPmmK/nvJbovpHlmaggZ2l6bW8gfFxuICAgIC8vIHwgYGxhYmVsRml0YCB8IOOAjOi/meS4quahhuaUvuS4jeaUvuW+l+S4i+i/meihjOWtl+OAjemdoOaUueecnyBMYWJlbCArIOW7uuaOoumSiOWNoeaIquWbvu+8jOivleS6hiAzIOi9ru+8iOi/mOi/neWPjeS6hlwi5Yir5Zyo55yf5a6e5Zy65pmv6YeM5YGa5a6e6aqMXCLvvIkgfFxuICAgIC8vIHwgYHNuYXBzaG90VHJlZWAvYGRpZmZUcmVlYCB8IOOAjOaIkeWIsOW6leaUueS6huS7gOS5iOOAjemdoOiusOW/hu+8jOa8j+aOieS6huiHquW3seeVmeS4i+eahOaOoumSiOiKgueCuSB8XG4gICAgLy9cbiAgICAvLyDlj6bkuIDmnaHlhbHlkIzlj6PlvoTvvJoqKuiDvemXruWPjeS6i+WunioqIOKAlOKAlCBgcGlja2Ag6ZeuXCLov5nkuKrlg4/ntKDkuIrnjrDlnKjmmK/osIFcIu+8jFxuICAgIC8vIGBsYWJlbEZpdGAg6ZeuXCLmoYbmlLnmiJAgMjEwIOaUvuS4jeaUvuW+l+S4i1wi44CC5Y+N5LqL5a6e5p+l6K+iKirpm7blia/kvZznlKgqKu+8jFxuICAgIC8vIOiAjOWcqOatpOS5i+WJjeWUr+S4gOeahOivlemUmeWKnuazleWwseaYr+WKqOecn+WcuuaZr+OAglxuXG4gICAgLyoqIOa4suafk+S8mOWFiOe6p++8iOWPluS4jeWIsOaMiSAw77yJ4oCU4oCUIOWQjOe6p+aOkuW6j+eUqOOAgiAqL1xuICAgIGNvbnN0IHJlYWROb2RlUHJpb3JpdHkgPSAobm9kZTogYW55KTogbnVtYmVyID0+IHtcbiAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHV0ICYmIHR5cGVvZiB1dC5wcmlvcml0eSA9PT0gJ251bWJlcicpIHJldHVybiB1dC5wcmlvcml0eTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gMDtcbiAgICB9O1xuXG4gICAgLyoqIOeCueaYr+S4jeaYr+iQveWcqOefqeW9oumHjO+8iCoq6aG16Z2iIENTUyDlg4/ntKDjgIF5IOWQkeS4iyoq77yJ44CCICovXG4gICAgY29uc3QgcG9pbnRJbkNzc1JlY3QgPSAocmVjdDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiwgeDogbnVtYmVyLCB5OiBudW1iZXIpOiBib29sZWFuID0+XG4gICAgICAgIHggPj0gcmVjdC54ICYmIHggPD0gcmVjdC54ICsgcmVjdC53aWR0aCAmJiB5ID49IHJlY3QueSAmJiB5IDw9IHJlY3QueSArIHJlY3QuaGVpZ2h0O1xuXG4gICAgLyoqIOiKgueCueS4iuOAjOeUu+W+l+WHuuadpeOAjeeahOe7hOS7tu+8iOaMieW8leaTjumHjOecn+WunuWtmOWcqOeahOexu+Wei+WPlu+8m+WPluS4jeWIsOeahOexu+Wei+i3s+i/h++8ieOAgiAqL1xuICAgIGNvbnN0IHZpc3VhbENvbXBvbmVudEVudHJpZXMgPSAobm9kZTogYW55KTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbXA6IGFueSB9PiA9PiB7XG4gICAgICAgIGNvbnN0IG91dDogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbXA6IGFueSB9PiA9IFtdO1xuICAgICAgICBjb25zdCBwYWlyczogQXJyYXk8W3N0cmluZywgYW55XT4gPSBbXG4gICAgICAgICAgICBbJ1Nwcml0ZScsIGNjLlNwcml0ZV0sXG4gICAgICAgICAgICBbJ0xhYmVsJywgY2MuTGFiZWxdLFxuICAgICAgICAgICAgWydSaWNoVGV4dCcsIGNjLlJpY2hUZXh0XSxcbiAgICAgICAgICAgIFsnR3JhcGhpY3MnLCBjYy5HcmFwaGljc10sXG4gICAgICAgICAgICBbJ01hc2snLCBjYy5NYXNrXSxcbiAgICAgICAgXTtcbiAgICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBhaXJzKSB7XG4gICAgICAgICAgICBjb25zdCBuYW1lID0gcGFpclswXTtcbiAgICAgICAgICAgIGNvbnN0IGN0b3IgPSBwYWlyWzFdO1xuICAgICAgICAgICAgaWYgKCFjdG9yIHx8ICFub2RlIHx8IHR5cGVvZiBub2RlLmdldENvbXBvbmVudCAhPT0gJ2Z1bmN0aW9uJykgY29udGludWU7XG4gICAgICAgICAgICBsZXQgY29tcDogYW55ID0gbnVsbDtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29tcCA9IG5vZGUuZ2V0Q29tcG9uZW50KGN0b3IpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgY29tcCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoY29tcCkgb3V0LnB1c2goeyBuYW1lLCBjb21wIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOi/meS4quiKgueCueOAjOeUu+S4jeeUu+W+l+WHuuS4nOilv+OAjeOAglxuICAgICAqXG4gICAgICog5Yi75oSP5Y+q5YGaKirpnZnmgIHlj6/liKQqKueahOmCo+WHoOenje+8mmBTcHJpdGVgIOayoeiuvuWbviAvIGBjb2xvci5hID0gMGAgLyDnqbogTGFiZWzjgIJcbiAgICAgKiBgR3JhcGhpY3NgIOS4jiBgTWFza2Ag5Yik5LiN5LqG77yI6KaB55+l6YGT5a6D55S75Yiw5ZOq5bCx5b6X6YeN5pS+5oyH5Luk5rWB77yJ77yM5omA5Lul566X44CM5Y+v6KeB44CNXG4gICAgICog5bm25ZyoIGBjYXZlYXRzYCDph4zor7TmmI4g4oCU4oCUIOaKpeWunuaDhe+8jOS4jeWBh+ijheefpemBk+OAglxuICAgICAqL1xuICAgIGNvbnN0IHZpc3VhbFN0YXRlT2YgPSAobm9kZTogYW55KTogeyB2aXNpYmxlOiBib29sZWFuOyBuYW1lczogc3RyaW5nW107IHJlYXNvbj86IHN0cmluZzsgY2F2ZWF0czogc3RyaW5nW10gfSA9PiB7XG4gICAgICAgIGNvbnN0IGVudHJpZXMgPSB2aXN1YWxDb21wb25lbnRFbnRyaWVzKG5vZGUpO1xuICAgICAgICBjb25zdCBuYW1lcyA9IGVudHJpZXMubWFwKChlKSA9PiBlLm5hbWUpO1xuICAgICAgICBjb25zdCBjYXZlYXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiAn5rKh5pyJ5Lu75L2V5riy5p+T57uE5Lu277yI5Y+q5piv5a655Zmo77yJJywgY2F2ZWF0cyB9O1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgY29uc3QgY29tcCA9IGVudHJ5LmNvbXA7XG4gICAgICAgICAgICBsZXQgYWxwaGEgPSAyNTU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmIChjb21wLmNvbG9yICYmIHR5cGVvZiBjb21wLmNvbG9yLmEgPT09ICdudW1iZXInKSBhbHBoYSA9IGNvbXAuY29sb3IuYTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGFscGhhIDw9IDApIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiBgJHtlbnRyeS5uYW1lfSDnmoQgY29sb3IuYSA9IDBgLCBjYXZlYXRzIH07XG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ1Nwcml0ZScpIHtcbiAgICAgICAgICAgICAgICBsZXQgZnJhbWU6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgZnJhbWUgPSBjb21wLnNwcml0ZUZyYW1lO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICBmcmFtZSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICghZnJhbWUpIHJldHVybiB7IHZpc2libGU6IGZhbHNlLCBuYW1lcywgcmVhc29uOiAnU3ByaXRlIOayoeiuviBzcHJpdGVGcmFtZScsIGNhdmVhdHMgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnTGFiZWwnIHx8IGVudHJ5Lm5hbWUgPT09ICdSaWNoVGV4dCcpIHtcbiAgICAgICAgICAgICAgICBsZXQgdGV4dCA9ICcnO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIHRleHQgPSBTdHJpbmcoY29tcC5zdHJpbmcgPT0gbnVsbCA/ICcnIDogY29tcC5zdHJpbmcpO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICB0ZXh0ID0gJyc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh0ZXh0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgdmlzaWJsZTogZmFsc2UsIG5hbWVzLCByZWFzb246IGAke2VudHJ5Lm5hbWV9IOeahCBzdHJpbmcg5piv56m65LiyYCwgY2F2ZWF0cyB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdHcmFwaGljcycgfHwgZW50cnkubmFtZSA9PT0gJ01hc2snKSB7XG4gICAgICAgICAgICAgICAgY2F2ZWF0cy5wdXNoKGAke2VudHJ5Lm5hbWV9IOeahOWPr+ingeiMg+WbtOmdmeaAgeWIpOS4jeS6hu+8iOimgemHjeaUvuaMh+S7pOa1ge+8ieKAlOKAlCDlroPlnKjliJfooajph4zlj6rku6PooahcIuaciei/meS4que7hOS7tlwiYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdmlzaWJsZTogdHJ1ZSwgbmFtZXMsIGNhdmVhdHMgfTtcbiAgICB9O1xuXG4gICAgLyoqIOeItumTvuS4iuaJgOaciSBgVUlPcGFjaXR5YCDnmoTkuZjnp6/vvIgyNTUgPSDlhajkuI3pgI/mmI7vvInjgIIgKi9cbiAgICBjb25zdCBvcGFjaXR5Q2hhaW5PZiA9IChub2RlOiBhbnkpOiBudW1iZXIgPT4ge1xuICAgICAgICBsZXQgcHJvZHVjdCA9IDI1NTtcbiAgICAgICAgbGV0IGN1cnNvciA9IG5vZGU7XG4gICAgICAgIHdoaWxlIChjdXJzb3IpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKGNjLlVJT3BhY2l0eSAmJiB0eXBlb2YgY3Vyc29yLmdldENvbXBvbmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBvcCA9IGN1cnNvci5nZXRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG9wICYmIHR5cGVvZiBvcC5vcGFjaXR5ID09PSAnbnVtYmVyJykgcHJvZHVjdCA9IChwcm9kdWN0ICogb3Aub3BhY2l0eSkgLyAyNTU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3IucGFyZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKHByb2R1Y3QpO1xuICAgIH07XG5cbiAgICAvKiog56WW5YWI6YeM55qEIGBNYXNrYCDlkI3lrZfvvIgqKuS4jeWIpOaWreeCueaYr+WQpuWcqOaooeadv+WGhSoq77yM5Y+q5oql44CM6KKr6LCB572p552A44CN77yJ44CCICovXG4gICAgY29uc3QgbWFza0FuY2VzdG9yc09mID0gKG5vZGU6IGFueSk6IHN0cmluZ1tdID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBsZXQgY3Vyc29yID0gbm9kZSA/IG5vZGUucGFyZW50IDogbnVsbDtcbiAgICAgICAgd2hpbGUgKGN1cnNvcikge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoY2MuTWFzayAmJiB0eXBlb2YgY3Vyc29yLmdldENvbXBvbmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXNrID0gY3Vyc29yLmdldENvbXBvbmVudChjYy5NYXNrKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hc2sgJiYgbWFzay5lbmFibGVkSW5IaWVyYXJjaHkgIT09IGZhbHNlKSBvdXQucHVzaChTdHJpbmcoY3Vyc29yLm5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvci5wYXJlbnQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICogKirkuIDkuKrlsY/luZXngrnkuIrmmK/lk6rkuKroioLngrkqKiDigJTigJQg44CM5oiq5Zu+6YeM6YKj5Lic6KW/5piv5LuA5LmI44CN55qE5LiA5qyh6LCD55So54mI44CCXG4gICAgICpcbiAgICAgKiAjIyDlroPmm7/ku6PmjonnmoTlvK/ot6/vvIjlrp7mtYsgMTYg6L2u77yJXG4gICAgICpcbiAgICAgKiDmiKrlm77ph4zmnInkuKrntKvoibLmlrnlnZfvvIzkuo7mmK/vvJrmnprkuL4gYGFjaGl2ZW1lbnRzYCDlrZDmoJHph4zmiYDmnIkgU3ByaXRlL0dyYXBoaWNzL0xhYmVsIOKGklxuICAgICAqIOaMieminOiJsuWBmuebtOaWueWbviDihpIg5Y+N566X5YOP57Sg5YyF5Zu055uSIOKGkiDlm57pooTliLbku7bph4wgZ3JlcCDoibLlgLwg4oaSICoq5YWo6YO95a+55LiN5LiKKirjgIJcbiAgICAgKiDnu5PorrrmmK/pgqPnjqnmhI/lhL8qKuagueacrOS4jeaYr+WcuuaZr+mHjOeahOiKgueCuSoq77yM5piv57yW6L6R5Zmo56e75YqoIGdpem1vIOeahCBYWSDlubPpnaLmiYvmn4TjgIJcbiAgICAgKlxuICAgICAqIOeXh+e7k+S4jeWcqOS6jlwi566X5LiN5Ye6XCLvvIzogIzlnKjkuo7vvJpg56m6YO+8iOi/meS4queCueS4iuayoeacieWGheWuueiKgueCue+8iSoq5pys6Lqr5bCx5piv5LiA5Liq57uT6K66KirvvIxcbiAgICAgKiDlj6/miYvlt6XmnprkuL7ml7bmsqHkurrmlaLkv6HkuIDkuKrnqbrliJfooajvvIzkuo7mmK/mjaLkuKrop5Lluqblho3mnprkuL7kuIDpgY3jgILov5nkuKrliqnmiYvmiorjgIznqbrjgI1cbiAgICAgKiDlj5jmiJAqKuacieadg+WogeeahOWIpOivjSoqIOKAlOKAlCDlroPlt7Lnu4/mm7/osIPnlKjmlrnnrpfov4fmtLvot4PmgIHjgIHnvJbovpHlmajoo4XppbDjgIHlsLrlr7jjgIHpopzoibIgYWxwaGEg5LqG44CCXG4gICAgICpcbiAgICAgKiAjIyDkuInkuKrmobbvvIjov5nmraPmmK/lroPmr5TmiYvlt6XmnprkuL7lvLrnmoTlnLDmlrnvvIlcbiAgICAgKlxuICAgICAqIC0gYGhpdHNgIOKAlOKAlCDlkb3kuK3ov5nkuIDngrnnmoQqKuWGheWuuSoq6IqC54K577yM5oyJ55S75bqPKirku47kuIrliLDkuIsqKuaOklxuICAgICAqIC0gYGludmlzaWJsZWAg4oCU4oCUIOebluS9j+S6hui/meS4gOeCueS9hioq55yL5LiN6KeBKirnmoToioLngrkgKyDljp/lm6DvvIhgYWN0aXZlPWZhbHNlYCAvXG4gICAgICogICBgY29sb3IuYT0wYCAvIOepuiBMYWJlbCAvIOeItumTviBgVUlPcGFjaXR5PTBg77yJ44CC44CM6L+Z6YeM5oCO5LmI5LuA5LmI6YO95rKh55S75Ye65p2l44CN55u05o6l55yL5a6DXG4gICAgICogLSBgZWRpdG9ySGl0c2Ag4oCU4oCUIOebluS9j+i/meS4gOeCueeahCoq57yW6L6R5Zmo6Ieq5bex55qEKiroo4XppbDoioLngrnvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8iVxuICAgICAqXG4gICAgICogYHZlcmRpY3RgIOaKiuS4ieahtuaPieaIkOS4gOWPpeivne+8mmBjb250ZW50YCAvIGBlZGl0b3Itb3ZlcmxheWAgLyBgZW1wdHlg44CCXG4gICAgICog5ou/5YiwIGBlZGl0b3Itb3ZlcmxheWAg5bCx5Yir5YaN5Y676IqC54K55qCR5oiW6aKE5Yi25Lu26YeM5om+5LqG44CCXG4gICAgICpcbiAgICAgKiAjIyDlnZDmoIflj6PlvoTvvIjkuI4gYGNhcHR1cmVWaWV3YCDlhbHnlKjkuIDlpZfvvIwqKuWIq+iHquW3seWPjeeulyoq77yJXG4gICAgICpcbiAgICAgKiAtIGBzcGFjZTogJ3ZpZXcnYO+8iOm7mOiupO+8ieKAlOKAlCAqKumhtemdoiBDU1Mg5YOP57Sg44CB5bem5LiK6KeS5Y6f54K5KirvvJtcbiAgICAgKiAtIGBzcGFjZTogJ3V2J2Ag4oCU4oCUIDB+MSDlvZLkuIDljJbvvIhcIuWkp+e6puWcqOWbvuaoquWQkSA3OCXjgIHnurXlkJEgMjIlXCLvvInjgIJcbiAgICAgKiAgIGBjYXB0dXJlVmlld2Ag57uZ5LqGIGBtYXhXaWR0aGAg5pe25Zu+5Lya562J5q+U57yp5bCP77yM5Zu+5LiK5YOP57SgIOKJoCBDU1Mg5YOP57Sg77yMXG4gICAgICogICDov5nml7bnlKggYHV2YCAqKuS4jemcgOimgeefpemBk+WbvuWkmuWkpyoq77ybXG4gICAgICogLSBgc3BhY2U6ICd3b3JsZCdgIOKAlOKAlCDnm7TmjqXnu5nkuJbnlYzlnZDmoIfvvIh5IOWQkeS4iu+8ieOAglxuICAgICAqXG4gICAgICogIyMg6K+a5a6e55qE6L6555WMXG4gICAgICpcbiAgICAgKiAtICoq55S75bqPKirmjInjgIzlkIznuqflhYjmjIkgYFVJVHJhbnNmb3JtLnByaW9yaXR5YOOAgeWGjeaMieWtkOiKgueCuemhuuW6j++8jOeItuWcqOiHquW3seWtkOiKgueCueS5i+WJjeOAjeeul++8jFxuICAgICAqICAg5pivIDJEIFVJIOeahOW4uOinhOWPo+W+hO+8myoq6LeoIENhbnZhcyAvIOi3qOebuOacuioq55qE5YWI5ZCO5a6D566h5LiN552A77yI5Zue5omn6YeMIGBvcmRlclJ1bGVgIOWGmeedgO+8ieOAglxuICAgICAqIC0gKirpga7nvakqKuWPquaKpSBgbWFza2VkQnlg77yI56WW5YWIIGBNYXNrYCDnmoTlkI3lrZfvvInvvIwqKuS4jeWIpOaWremCo+S4queCueWcqOS4jeWcqOaooeadv+mHjCoq44CCXG4gICAgICogLSBgR3JhcGhpY3NgIOWPquaMieOAjOaciee7hOS7tuOAjeeul++8jOmHjeaUvuaMh+S7pOa1geaJjeefpemBk+Wug+eUu+WIsOWTquOAglxuICAgICAqIC0g5Y+W5LiN5Yiw57yW6L6R5Zmo55u45py677yI5Zy65pmv6KeG5Zu+5rKh5byAIC8gYGNjZS5DYW1lcmFgIOayoeWwsee7qu+8ieaXtioq55u05o6l5oqb6ZSZKirvvIxcbiAgICAgKiAgIOS4jee7meS4gOS4qumdmem7mOepuue7k+aenCDigJTigJQg6YKj5q2j5piv44CM56m65YiX6KGo5Y+v5LiN5Y+v5L+h44CN55qE6ICB6Zeu6aKY44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0geCDmqKrlnZDmoIfvvIjlkKvkuYnnlLEgYHNwYWNlYCDlhrPlrprvvIlcbiAgICAgKiBAcGFyYW0geSDnurXlnZDmoIdcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5zcGFjZSBgJ3ZpZXcnYO+8iOm7mOiupO+8iS8gYCd1didgIC8gYCd3b3JsZCdgXG4gICAgICogQHBhcmFtIG9wdGlvbnMucm9vdCDlj6rlnKjov5nmo7XlrZDmoJHph4zmib7vvIjpu5jorqTmlbTlnLrmma/vvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5saW1pdCDmnIDlpJrlm57lh6DkuKrlhoXlrrnlkb3kuK3vvIjpu5jorqQgMTLvvIlcbiAgICAgKi9cbiAgICBoZWxwZXJzLnBpY2sgPSAoeDogbnVtYmVyLCB5OiBudW1iZXIsIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3Qgc3BhY2UgPSB0eXBlb2Ygb3B0cy5zcGFjZSA9PT0gJ3N0cmluZycgPyBvcHRzLnNwYWNlIDogJ3ZpZXcnO1xuICAgICAgICBjb25zdCBsaW1pdCA9IGNsYW1wTnVtYmVyKG9wdHMubGltaXQsIDEsIDY0LCAxMik7XG4gICAgICAgIGlmIChzcGFjZSAhPT0gJ3ZpZXcnICYmIHNwYWNlICE9PSAndXYnICYmIHNwYWNlICE9PSAnd29ybGQnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgYHBpY2soeCwgeSwgeyBzcGFjZSB9Ke+8mnNwYWNlIOWPquiupCAndmlldyfvvIjpobXpnaIgQ1NTIOWDj+e0oO+8jOm7mOiupO+8iS8gJ3V2J++8iDB+Me+8iS8gJ3dvcmxkJ++8jOaUtuWIsCAnJHtzcGFjZX0n44CCYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbnggPSBOdW1iZXIoeCk7XG4gICAgICAgIGNvbnN0IG55ID0gTnVtYmVyKHkpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShueCkgfHwgIU51bWJlci5pc0Zpbml0ZShueSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcGljayh4LCB5Ke+8muWdkOagh+imgemDveaYr+aciemZkOaVsO+8jOaUtuWIsCAke0pTT04uc3RyaW5naWZ5KHgpfSAvICR7SlNPTi5zdHJpbmdpZnkoeSl944CCYCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjYW1JbmZvID0gZWRpdG9yQ2FtZXJhKCk7XG4gICAgICAgIGlmICghY2FtSW5mby5jYW0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBgcGljayDopoHmiorkuJbnlYzlnZDmoIfmipXliLDlsY/luZXkuIrvvIzkvYbnjrDlnKjmi7/kuI3liLDnvJbovpHlmajnm7jmnLrvvJoke2NhbUluZm8ubm90ZSB8fCAn5pyq55+l5Y6f5ZugJ33jgIJgICtcbiAgICAgICAgICAgICAgICAgICAgJ++8iOWcuuaZr+inhuWbvuayoeaJk+W8gOOAgeaIluiAheWImuaJk+W8gOi/mOayoeWwsee7qiDigJTigJQg5LiN5pivXCLov5nkuKrngrnkuIrmsqHmnInoioLngrlcIuOAgu+8iScsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNhbSA9IGNhbUluZm8uY2FtO1xuICAgICAgICBjb25zdCBjYW52YXMgPSBmaW5kVmlld0NhbnZhcyhjYyk7XG4gICAgICAgIGNvbnN0IGNhbnZhc0JveCA9IChjYW52YXNHZW9tZXRyeShjYW52YXMpIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICBjb25zdCBwYWdlID0gcGFnZUdlb21ldHJ5KCk7XG4gICAgICAgIGNvbnN0IGNzc1dpZHRoID0gdHlwZW9mIHBhZ2UuY3NzV2lkdGggPT09ICdudW1iZXInID8gcGFnZS5jc3NXaWR0aCA6IDA7XG4gICAgICAgIGNvbnN0IGNzc0hlaWdodCA9IHR5cGVvZiBwYWdlLmNzc0hlaWdodCA9PT0gJ251bWJlcicgPyBwYWdlLmNzc0hlaWdodCA6IDA7XG4gICAgICAgIGNvbnN0IGNhbnZhc0Nzc1dpZHRoID0gKGNhbnZhc0JveC5jc3NXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgICAgIGNvbnN0IGNhbnZhc0RldmljZVdpZHRoID0gKGNhbnZhc0JveC5kZXZpY2VXaWR0aCBhcyBudW1iZXIpIHx8IDA7XG4gICAgICAgIGNvbnN0IGRwciA9IGNhbnZhc0Nzc1dpZHRoID4gMCAmJiBjYW52YXNEZXZpY2VXaWR0aCA+IDAgPyBjYW52YXNEZXZpY2VXaWR0aCAvIGNhbnZhc0Nzc1dpZHRoIDogcGFnZURwcigpO1xuICAgICAgICBjb25zdCBjYW1IZWlnaHQgPSBzYWZlTnVtYmVyKCgpID0+IGNhbS5jYW1lcmEuaGVpZ2h0KSB8fCAoY2FudmFzQm94LmRldmljZUhlaWdodCBhcyBudW1iZXIpIHx8IDA7XG5cbiAgICAgICAgLy8g4pGgIOi+k+WFpSDihpIg6aG16Z2iIENTUyDlg4/ntKDvvIjlt6bkuIrop5Lljp/ngrnvvIlcbiAgICAgICAgbGV0IHB4ID0gbng7XG4gICAgICAgIGxldCBweSA9IG55O1xuICAgICAgICBsZXQgd29ybGRQb2ludDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPSBudWxsO1xuICAgICAgICBpZiAoc3BhY2UgPT09ICd1dicpIHtcbiAgICAgICAgICAgIGlmICghY3NzV2lkdGggfHwgIWNzc0hlaWdodCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncGljayhzcGFjZTpcInV2XCIpIOimgeaMiemhtemdouWwuuWvuOaKmOeul++8jOS9huWcuuaZr+mhtemHjOayoemHj+WIsCB3aW5kb3cuaW5uZXJXaWR0aC9pbm5lckhlaWdodOOAguaUueeUqCBzcGFjZTpcInZpZXdcIiDoh6rlt7HkuZjjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHB4ID0gbnggKiBjc3NXaWR0aDtcbiAgICAgICAgICAgIHB5ID0gbnkgKiBjc3NIZWlnaHQ7XG4gICAgICAgIH0gZWxzZSBpZiAoc3BhY2UgPT09ICd3b3JsZCcpIHtcbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3RXb3JsZEJveChjYywgY2FtLCBjYW52YXMsIHsgY3g6IG54LCBjeTogbnksIHd6OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH0pO1xuICAgICAgICAgICAgaWYgKCFwcm9qZWN0ZWQucmVjdCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcGljayhzcGFjZTpcIndvcmxkXCIpIOaKleS4jeWIsOWxj+W5leS4iu+8miR7cHJvamVjdGVkLm5vdGUgfHwgJ+acquefpeWOn+WboCd944CCYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBweCA9IHByb2plY3RlZC5yZWN0Lng7XG4gICAgICAgICAgICBweSA9IHByb2plY3RlZC5yZWN0Lnk7XG4gICAgICAgICAgICB3b3JsZFBvaW50ID0geyB4OiByb3VuZDMobngpLCB5OiByb3VuZDMobnkpIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyDikaEg6aG65bim5oqK5LiW55WM5Z2Q5qCH5Lmf566X5Ye65p2l77yIdmlldy91diDotbDlj43mipXlvbHvvInigJTigJQg5Zue5omn6YeM5bim5LiK77yM55yB5b6X6LCD55So5pa56Ieq5bex5YaN5o2i566X5LiA5qyhXG4gICAgICAgIGlmICghd29ybGRQb2ludCAmJiBkcHIgPiAwICYmIGNhbUhlaWdodCA+IDApIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxYID0gcHggLSAoKGNhbnZhc0JveC5sZWZ0IGFzIG51bWJlcikgfHwgMCk7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxZID0gcHkgLSAoKGNhbnZhc0JveC50b3AgYXMgbnVtYmVyKSB8fCAwKTtcbiAgICAgICAgICAgICAgICBjb25zdCB3ID0gY2FtLnNjcmVlblRvV29ybGQobmV3IGNjLlZlYzMobG9jYWxYICogZHByLCBjYW1IZWlnaHQgLSBsb2NhbFkgKiBkcHIsIDApKTtcbiAgICAgICAgICAgICAgICBpZiAodyAmJiB0eXBlb2Ygdy54ID09PSAnbnVtYmVyJyAmJiB0eXBlb2Ygdy55ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICB3b3JsZFBvaW50ID0geyB4OiByb3VuZDMody54KSwgeTogcm91bmQzKHcueSkgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICB3b3JsZFBvaW50ID0gbnVsbDsgLy8g5Y+N5oqV5b2x5LiN5oiQ56uL5bCx5aaC5a6e5ZueIG51bGzvvIzkuI3nvJbkuIDkuKpcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJvb3ROb2RlID0gb3B0cy5yb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghcm9vdE5vZGUpIHRocm93IG5ldyBFcnJvcigncGlja++8muW9k+WJjeayoeacieaJk+W8gOeahOWcuuaZr++8iOS5n+ayoee7mSByb29077yJ44CCJyk7XG5cbiAgICAgICAgY29uc3Qgd29ybGRSZWN0T2YgPSBoZWxwZXJzLndvcmxkUmVjdCBhcyAobm9kZTogYW55LCBvcHRpb25zPzogeyByb290PzogYW55IH0pID0+IFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgICAgICAgLyoqIOeUu+W6j+ihqO+8muWQjOe6p+aMiSBwcmlvcml0eeOAgeWGjeaMieWtkOiKgueCuemhuuW6j++8jOeItuWcqOiHquW3seWtkOiKgueCueS5i+WJjeOAgiAqL1xuICAgICAgICBjb25zdCBkcmF3SW5kZXggPSBuZXcgTWFwPGFueSwgbnVtYmVyPigpO1xuICAgICAgICB7XG4gICAgICAgICAgICBsZXQgY291bnRlciA9IDA7XG4gICAgICAgICAgICBjb25zdCB3YWxrT3JkZXIgPSAobjogYW55KTogdm9pZCA9PiB7XG4gICAgICAgICAgICAgICAgZHJhd0luZGV4LnNldChuLCBjb3VudGVyKTtcbiAgICAgICAgICAgICAgICBjb3VudGVyICs9IDE7XG4gICAgICAgICAgICAgICAgY29uc3Qga2lkczogYW55W10gPSAobiAmJiBuLmNoaWxkcmVuKSB8fCBbXTtcbiAgICAgICAgICAgICAgICBjb25zdCBwYWlycyA9IGtpZHMubWFwKChrOiBhbnksIGk6IG51bWJlcikgPT4gKHsgaywgaSwgcDogcmVhZE5vZGVQcmlvcml0eShrKSB9KSk7XG4gICAgICAgICAgICAgICAgcGFpcnMuc29ydCgoYSwgYikgPT4gYS5wIC0gYi5wIHx8IGEuaSAtIGIuaSk7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBhaXJzKSB3YWxrT3JkZXIocGFpci5rKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB3YWxrT3JkZXIocm9vdE5vZGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqIOiKgueCueeahOmhtemdoiBDU1Mg55+p5b2i77yI6LWwIGB3b3JsZFJlY3RgICsgYHByb2plY3RXb3JsZEJveGDvvIzkuI7miKrlm77lkIzkuIDlpZfmjaLnrpfvvInjgIIgKi9cbiAgICAgICAgY29uc3QgcHJvamVjdE5vZGVDc3MgPSAobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPT4ge1xuICAgICAgICAgICAgbGV0IHJlY3Q6IFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJlY3QgPSB3b3JsZFJlY3RPZihub2RlKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCEocmVjdC53aWR0aCA+IDApIHx8ICEocmVjdC5oZWlnaHQgPiAwKSkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBsZXQgd3ogPSAwO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCB3cCA9IG5vZGUud29ybGRQb3NpdGlvbjtcbiAgICAgICAgICAgICAgICBpZiAod3AgJiYgdHlwZW9mIHdwLnogPT09ICdudW1iZXInKSB3eiA9IHdwLno7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlv73nlaXvvJoyRCDmraPkuqTkuIsgeiDkuI3lvbHlk43nu5PmnpwgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3RXb3JsZEJveChjYywgY2FtLCBjYW52YXMsIHtcbiAgICAgICAgICAgICAgICBjeDogcmVjdC5jeCxcbiAgICAgICAgICAgICAgICBjeTogcmVjdC5jeSxcbiAgICAgICAgICAgICAgICB3eixcbiAgICAgICAgICAgICAgICB3aWR0aDogcmVjdC53aWR0aCxcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IHJlY3QuaGVpZ2h0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gcHJvamVjdGVkLnJlY3Q7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgaGl0czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gICAgICAgIGNvbnN0IGludmlzaWJsZTogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gICAgICAgIGNvbnN0IGVkaXRvckhpdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICAgICAgICBjb25zdCBjYXZlYXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBsZXQgc2Nhbm5lZENvbnRlbnQgPSAwO1xuICAgICAgICBsZXQgc2Nhbm5lZEVkaXRvciA9IDA7XG5cbiAgICAgICAgY29uc3QgdmlzaXROb2RlID0gKG5vZGU6IGFueSwgcGFyZW50UGF0aDogc3RyaW5nLCB1bmRlckVkaXRvcjogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBlZGl0b3JIZXJlID0gdW5kZXJFZGl0b3IgfHwgaXNFZGl0b3JOb2RlKG5vZGUpO1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9IG5vZGUgPT09IHJvb3ROb2RlID8gJycgOiBwYXJlbnRQYXRoID8gYCR7cGFyZW50UGF0aH0vJHtub2RlLm5hbWV9YCA6IFN0cmluZyhub2RlLm5hbWUpO1xuICAgICAgICAgICAgY29uc3QgdXQgPSB1aVRyYW5zZm9ybU9mKG5vZGUpO1xuICAgICAgICAgICAgaWYgKHV0ICYmIHV0LndpZHRoID4gMCAmJiB1dC5oZWlnaHQgPiAwKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY3NzUmVjdCA9IHByb2plY3ROb2RlQ3NzKG5vZGUpO1xuICAgICAgICAgICAgICAgIGlmIChjc3NSZWN0ICYmIHBvaW50SW5Dc3NSZWN0KGNzc1JlY3QsIHB4LCBweSkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgcm93OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgICAgICByZWN0OiBjc3NSZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJlYTogTWF0aC5yb3VuZChjc3NSZWN0LndpZHRoICogY3NzUmVjdC5oZWlnaHQpLFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICBpZiAoZWRpdG9ySGVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2Nhbm5lZEVkaXRvciArPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVkaXRvckhpdHMubGVuZ3RoIDwgOCkgZWRpdG9ySGl0cy5wdXNoKHJvdyk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FubmVkQ29udGVudCArPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmlzdWFsID0gdmlzdWFsU3RhdGVPZihub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wYWNpdHkgPSBvcGFjaXR5Q2hhaW5PZihub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hc2tlZEJ5ID0gbWFza0FuY2VzdG9yc09mKG5vZGUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiDog73kuI3og73nnIvop4HvvIzkuInnp43mg4XlhrUqKuWIhuW8gOaKpSoq77yaXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOe6r+WuueWZqO+8iOayoeacieS7u+S9lea4suafk+e7hOS7tu+8ieKGkiDml6LkuI3nrpflkb3kuK3jgIHkuZ/kuI3nrpdcIueci+S4jeingVwi77yI5a6D5pys5p2l5bCx5LiN6K+l55S75Lic6KW/77yJXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOaciea4suafk+e7hOS7tuS9huayoeaYvuekuuWHuuadpSDihpIg6L+bIGBpbnZpc2libGVgIOW5tuW4puS4iioq5Y6f5ZugKirvvIjov5nmiY3mmK9cIui/memHjOaAjuS5iOS7gOS5iOmDveayoeeUu1wi55qE562U5qGI77yJXG4gICAgICAgICAgICAgICAgICAgICAgICAgKiAtIOWFtuS9mSDihpIg5ZG95LitXG4gICAgICAgICAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFjdGl2ZUluSGllcmFyY2h5ID1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLmFjdGl2ZUluSGllcmFyY2h5ICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBub2RlLmFjdGl2ZUluSGllcmFyY2h5ICE9PSBmYWxzZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IG5vZGUuYWN0aXZlICE9PSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2aXN1YWwubmFtZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYWN0aXZlSW5IaWVyYXJjaHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGludmlzaWJsZS5sZW5ndGggPCBsaW1pdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnJlYXNvbiA9ICdhY3RpdmUgPSBmYWxzZe+8iOaIlueItumTvuS4iuaciSBpbmFjdGl2Ze+8iSc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cudmlzdWFsID0gdmlzdWFsLm5hbWVzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW52aXNpYmxlLnB1c2gocm93KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIXZpc3VhbC52aXNpYmxlIHx8IG9wYWNpdHkgPD0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW52aXNpYmxlLmxlbmd0aCA8IGxpbWl0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cucmVhc29uID0gb3BhY2l0eSA8PSAwID8gJ+eItumTviBVSU9wYWNpdHkg5ZCI6LW35p2l5pivIDAnIDogdmlzdWFsLnJlYXNvbjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJvdy52aXN1YWwgPSB2aXN1YWwubmFtZXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbnZpc2libGUucHVzaChyb3cpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnZpc3VhbCA9IHZpc3VhbC5uYW1lcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93Lm9wYWNpdHkgPSBvcGFjaXR5O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb3cubWFza2VkQnkgPSBtYXNrZWRCeTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93LnByaW9yaXR5ID0gcmVhZE5vZGVQcmlvcml0eShub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcm93Lm9yZGVyID0gZHJhd0luZGV4Lmhhcyhub2RlKSA/IGRyYXdJbmRleC5nZXQobm9kZSkgOiAtMTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGl0cy5wdXNoKHJvdyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2F2ZWF0IG9mIHZpc3VhbC5jYXZlYXRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2F2ZWF0cy5pbmRleE9mKGNhdmVhdCkgPCAwKSBjYXZlYXRzLnB1c2goY2F2ZWF0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGtpZHM6IGFueVtdID0gKG5vZGUgJiYgbm9kZS5jaGlsZHJlbikgfHwgW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGtpZHMpIHZpc2l0Tm9kZShjaGlsZCwgcGF0aCwgZWRpdG9ySGVyZSk7XG4gICAgICAgIH07XG4gICAgICAgIHZpc2l0Tm9kZShyb290Tm9kZSwgJycsIGZhbHNlKTtcblxuICAgICAgICBoaXRzLnNvcnQoKGEsIGIpID0+IChiLm9yZGVyIGFzIG51bWJlcikgLSAoYS5vcmRlciBhcyBudW1iZXIpKTtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IGhpdHMubGVuZ3RoID4gMCA/ICdjb250ZW50JyA6IGVkaXRvckhpdHMubGVuZ3RoID4gMCA/ICdlZGl0b3Itb3ZlcmxheScgOiAnZW1wdHknO1xuXG4gICAgICAgIGxldCBub3RlID0gJyc7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSAnZWRpdG9yLW92ZXJsYXknKSB7XG4gICAgICAgICAgICBub3RlID1cbiAgICAgICAgICAgICAgICAn6L+Z5Liq54K55LiKKirmsqHmnInku7vkvZXlhoXlrrnoioLngrkqKu+8jOS9huaciee8lui+keWZqOiHquW3seeahOijhemlsOiKgueCueimhuebliDigJTigJQg5Z+65pys5Y+v5Lul56Gu5a6a5pivIGdpem1vIC8g572R5qC8IC8g5Y+C6ICD5Zu+44CCJyArXG4gICAgICAgICAgICAgICAgJ+aIquWbvumHjOeci+WIsOeahOS4nOilv+iLpeaYr+i/meS4quminOiJsu+8jOWugyoq5LiN5Zyo5Zy65pmv5pWw5o2u6YeMKirvvIzliKvljrvoioLngrnmoJHmiJbpooTliLbku7bph4zmib7lroPjgIInO1xuICAgICAgICB9IGVsc2UgaWYgKHZlcmRpY3QgPT09ICdlbXB0eScpIHtcbiAgICAgICAgICAgIG5vdGUgPSAn6L+Z5Liq54K55LiK5pei5rKh5pyJ5YaF5a656IqC54K544CB5Lmf5rKh5pyJ57yW6L6R5Zmo6KOF6aWw77yI5Y+v6IO95piv5riF5bGP6ImyIC8g6Z2i5p2/5bqV6Imy77yJ44CCJztcbiAgICAgICAgfSBlbHNlIGlmIChoaXRzLmxlbmd0aCA+IGxpbWl0KSB7XG4gICAgICAgICAgICBub3RlID0gYOWRveS4rSAke2hpdHMubGVuZ3RofSDkuKrlhoXlrrnoioLngrnvvIzlj6rlm57kuobmnIDkuIrpnaIgJHtsaW1pdH0g5Liq77yI6KaB5pu05aSa5bCx6LCD5aSnIGxpbWl077yJ44CCYDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB4OiBueCxcbiAgICAgICAgICAgIHk6IG55LFxuICAgICAgICAgICAgc3BhY2UsXG4gICAgICAgICAgICBwYWdlQ3NzOiB7IHg6IHJvdW5kMyhweCksIHk6IHJvdW5kMyhweSksIGNzc1dpZHRoLCBjc3NIZWlnaHQsIGRwciwgaHJlZjogcGFnZS5ocmVmIH0sXG4gICAgICAgICAgICBjYW52YXM6IGNhbnZhc0JveCxcbiAgICAgICAgICAgIHdvcmxkOiB3b3JsZFBvaW50LFxuICAgICAgICAgICAgaGl0czogaGl0cy5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgICAgICBoaXQ6IGhpdHMubGVuZ3RoID4gMCA/IGhpdHNbMF0gOiBudWxsLFxuICAgICAgICAgICAgaGlkZGVuQ291bnQ6IGludmlzaWJsZS5sZW5ndGgsXG4gICAgICAgICAgICBpbnZpc2libGUsXG4gICAgICAgICAgICBlZGl0b3JIaXRzLFxuICAgICAgICAgICAgdmVyZGljdCxcbiAgICAgICAgICAgIHNjYW5uZWQ6IHsgY29udGVudDogc2Nhbm5lZENvbnRlbnQsIGVkaXRvcjogc2Nhbm5lZEVkaXRvciB9LFxuICAgICAgICAgICAgb3JkZXJSdWxlOiAn5ZCM57qn5YWI5oyJIFVJVHJhbnNmb3JtLnByaW9yaXR544CB5YaN5oyJ5a2Q6IqC54K56aG65bqP77yb54i25Zyo6Ieq5bex5a2Q6IqC54K55LmL5YmN44CC6LeoIENhbnZhcy/ot6jnm7jmnLrnmoTlhYjlkI7nrqHkuI3nnYDjgIInLFxuICAgICAgICAgICAgY2F2ZWF0cyxcbiAgICAgICAgICAgIG5vdGUsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqICoq6L+Z5LiqIExhYmVsIOaUvuS4jeaUvuW+l+S4i+Wug+iHquW3seeahOWtlyoqIOKAlOKAlCDlsKTlhbbmmK/jgIzkvJrkuI3kvJrooqvoo4HmjonjgI3jgIJcbiAgICAgKlxuICAgICAqICMjIOWug+abv+S7o+aOieeahOW8r+i3r++8iOS4pOWkhOecnyBidWfjgIHlhbEgNH41IOi9ru+8iVxuICAgICAqXG4gICAgICogMS4g5oiQ5bCx5Y2h5o+P6L+wIGBkZXRhaWxg77yIMjIww5c0NOOAgWZzMTbjgIFgQ0xBTVBgICsg5o2i6KGM77yJ77ya5pyA6ZW/55qE5LiA5p2h5o+P6L+w5oqY5oiQIDIg6KGM77yMXG4gICAgICogICAg56ysIDIg6KGM77yI6L+b5bqmIGAyMC8yMGDvvIkqKuaVtOihjOiiq+ijgeaOie+8jOeVjOmdouS4iuS4gOS4quWtl+mDveeci+S4jeingSoq44CCXG4gICAgICogMi4g5pWI5p6c5ZCNIGBwcm9wZXJ0eS9uYW1lYCDlj6rmnIkgNTZweCDlrr3vvIzogIwgNiDkuKrmsYnlrZfnmoTor43opoEgODRweCDigJTigJQg5ZCN5a2X6KKr5oiq44CCXG4gICAgICpcbiAgICAgKiDkuKTmrKHpg73pnaDjgIzlj6blu7rkuIDlvKDmjqLpkojljaEgKyDmiKrlm77jgI3miY3nnIvlh7rmnaXvvIzkuK3pgJTov5jlhYjmlLnkuobnnJ/oioLngrnnmoQgYGFjdGl2ZWBcbiAgICAgKiDvvIgqKui/neWPjeS6huiHquW3seWGmeeahOe6quW+iyoq77yJ44CC6L+Z5Liq5Yqp5omL5oqK5a6D5Y+Y5oiQ5LiA5qyhKirnuq/nrpfmnK8qKuiwg+eUqOOAglxuICAgICAqXG4gICAgICogIyMg6IO96Zeu5Y+N5LqL5a6e77yI6L+Z5omN5piv5a6D55yf5q2j5YC86ZKx55qE5Zyw5pa577yJXG4gICAgICpcbiAgICAgKiDnrKzkuozkuKrlj4LmlbDopobnm5bku7vmhI/lrZfmrrXvvIzkuo7mmK/jgIwqKuWmguaenCoq5oiR5oqK5qGG5pS55oiQIDIxMMOXNzIg6L+Y6KOB5LiN6KOB44CN5LiN55So5pS55Zy65pmv5bCx6IO96Zeu77yaXG4gICAgICpcbiAgICAgKiBgYGBqc1xuICAgICAqIGNvbnN0IG4gPSBub2RlQnlQYXRoKCdDYW52YXMv4oCmL2RldGFpbC9MYWJlbCcpO1xuICAgICAqIGxhYmVsRml0KG4pOyAgICAgICAgICAgICAgICAgLy8g546w5Zyo6KOB5LiN6KOBXG4gICAgICogbGFiZWxGaXQobiwgeyBoZWlnaHQ6IDcyIH0pOyAvLyDmoYbliqDpq5jliLAgNzIg5ZGiXG4gICAgICogbGFiZWxGaXQoeyB0ZXh0OiAn5Zyo5Ye75p2A5ZWG5bqX6LSt5Lmw6L+H5LiN5ZCM56eN57G755qEQnVmZu+8iOWFsTIw56eN77yJ44CCJywgZm9udFNpemU6IDE2LCB3aWR0aDogMjEwLCBoZWlnaHQ6IDcyLCBsaW5lSGVpZ2h0OiAyNCB9KTtcbiAgICAgKiBgYGBcbiAgICAgKlxuICAgICAqICMjIOWbnuaJp+mHjOS4uuS7gOS5iOW4piBgZm9ybXVsYWBcbiAgICAgKlxuICAgICAqIOaIquaWremYiOWAvOmCo+adoeWFrOW8j+aYryoq5LuO5a6e5rWL5Y+N5o6oKirnmoTvvIjop4Hmlofku7bph4wgYExBQkVMX0xBU1RfTElORV9GQUNUT1JgIOS4iuaWuemCo+auteivtOaYju+8ie+8jFxuICAgICAqIOS4jeaYr+ivu+W8leaTjua6kOeggeehruiupOeahOOAguaJgOS7peaKiuWBh+WumueahOWFrOW8j+WOn+agt+S6pOWHuuWOuyDigJTigJQg5pWw5a2X5a+55LiN5LiK5pe25LiA55y855yL5b6X5Ye65pivXG4gICAgICogKirlhazlvI8qKumUmeS6hui/mOaYryoq55So5rOVKirplJnkuobvvIzogIzkuI3mmK/lj4jljrvnjJzjgIJcbiAgICAgKlxuICAgICAqICMjIOivmuWunueahOi+ueeVjFxuICAgICAqXG4gICAgICogLSDmjaLooYzmjIkqKumAkOWtl+espui0quW/gyoq77yIQ0pLIOeahOW4uOinhOihjOS4uu+8ieOAguWQq+epuuagvOeahOmVv+aLieS4geS4suW8leaTjuaMiSoq6K+NKirmjaLooYzvvIxcbiAgICAgKiAgIOmCo+S8muavlOi/memHjCoq5aSaKirljaDooYwg4oCU4oCUIOWbnuaJp+eahCBgd3JhcE1vZGVgIC8gYGNvbmZpZGVuY2VgIC8gYHJlYXNvbnNgIOS8muivtOaYjuOAglxuICAgICAqIC0g5pyJIERPTSDml7blrr3luqbotbAgY2FudmFzIGBtZWFzdXJlVGV4dGDvvIgqKuecn+mHjyoq77yM5LiO5byV5pOOIFRURiDmjpLniYjlkIzkuIDmiorlsLrlrZDvvInvvJtcbiAgICAgKiAgIOayoeacieWImeeUqOWunua1i+eahCBlbSDooajkvLDvvIxgbWV0aG9kYCDlrZfmrrXlhpnmmI7mmK/lk6rnp43jgIJcbiAgICAgKiAtIOWvjOaWh+acrOagh+etvuOAgeWtl+mXtOi3neOAgWBib2xkYC9gb3V0bGluZWAg5bim5p2l55qE5a695bqm5Y+Y5YyWKirmsqHnrpcqKuOAglxuICAgICAqXG4gICAgICogQHBhcmFtIHRhcmdldCDkuIDkuKroioLngrkgLyDkuIDkuKogTGFiZWwg57uE5Lu2IC8g5LiA5LiqIHNwZWMg5a+56LGh77yIYHt0ZXh0LCBmb250U2l6ZSwgd2lkdGgsIGhlaWdodCwgbGluZUhlaWdodCwgb3ZlcmZsb3csIHdyYXB9YO+8iVxuICAgICAqIEBwYXJhbSBvdmVycmlkZSDopobnm5bku7vmhI/lrZfmrrUg4oCU4oCUIOeUqOadpemXruOAjOaUueaIkOi/meagt+S8muS4jeS8muWlveOAjVxuICAgICAqL1xuICAgIGhlbHBlcnMubGFiZWxGaXQgPSAodGFyZ2V0PzogYW55LCBvdmVycmlkZT86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgICAgIGNvbnN0IG92OiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3ZlcnJpZGUgfHwge307XG4gICAgICAgIGxldCBub2RlOiBhbnkgPSBudWxsO1xuICAgICAgICBsZXQgYmFnOiBhbnkgPSBudWxsO1xuICAgICAgICBpZiAodGFyZ2V0ICYmIHR5cGVvZiB0YXJnZXQuZ2V0Q29tcG9uZW50ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBub2RlID0gdGFyZ2V0O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBiYWcgPSBjYy5MYWJlbCA/IHRhcmdldC5nZXRDb21wb25lbnQoY2MuTGFiZWwpIDogbnVsbDtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGJhZyA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWJhZykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYGxhYmVsRml0KG5vZGUp77ya6IqC54K544CMJHt0YXJnZXQubmFtZX3jgI3kuIrmsqHmnIkgY2MuTGFiZWwg57uE5Lu244CCYCArXG4gICAgICAgICAgICAgICAgICAgICAgICBcIuimgemXruWPjeS6i+WunuWwseebtOaOpeS8oCBzcGVjIOWvueixoe+8jOS+i+WmgiBsYWJlbEZpdCh7IHRleHQ6ICfigKYnLCBmb250U2l6ZTogMTYsIHdpZHRoOiAyMTAsIGhlaWdodDogNzIsIGxpbmVIZWlnaHQ6IDI0IH0p44CCXCIsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQgJiYgdHlwZW9mIHRhcmdldCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGJhZyA9IHRhcmdldDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAnbGFiZWxGaXQodGFyZ2V0Ke+8mnRhcmdldCDopoHmmK/kuIDkuKroioLngrkgLyDkuIDkuKogTGFiZWwg57uE5Lu2IC8g5LiA5LiqIHNwZWMg5a+56LGhJyArXG4gICAgICAgICAgICAgICAgICAgIFwi77yI5aaCIHsgdGV4dCwgZm9udFNpemUsIHdpZHRoLCBoZWlnaHQsIGxpbmVIZWlnaHQgfe+8ieOAglwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlYWQgPSAoa2V5OiBzdHJpbmcpOiBhbnkgPT4ge1xuICAgICAgICAgICAgaWYgKG92W2tleV0gIT09IHVuZGVmaW5lZCkgcmV0dXJuIG92W2tleV07XG4gICAgICAgICAgICBpZiAoYmFnKSB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhZ1trZXldICE9PSB1bmRlZmluZWQpIHJldHVybiBiYWdba2V5XTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCB1dCA9IG5vZGUgPyB1aVRyYW5zZm9ybU9mKG5vZGUpIDogbnVsbDtcbiAgICAgICAgY29uc3QgdGV4dCA9IFN0cmluZyhcbiAgICAgICAgICAgIHJlYWQoJ3RleHQnKSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgPyByZWFkKCd0ZXh0JylcbiAgICAgICAgICAgICAgICA6IHJlYWQoJ3N0cmluZycpICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgID8gcmVhZCgnc3RyaW5nJylcbiAgICAgICAgICAgICAgICAgIDogJycsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGZvbnRTaXplID0gTnVtYmVyKHJlYWQoJ2ZvbnRTaXplJykgIT09IHVuZGVmaW5lZCA/IHJlYWQoJ2ZvbnRTaXplJykgOiAxNCkgfHwgMTQ7XG4gICAgICAgIGNvbnN0IGxpbmVIZWlnaHRSYXcgPSBOdW1iZXIocmVhZCgnbGluZUhlaWdodCcpICE9PSB1bmRlZmluZWQgPyByZWFkKCdsaW5lSGVpZ2h0JykgOiAwKSB8fCAwO1xuICAgICAgICBjb25zdCBmb250RmFtaWx5ID0gU3RyaW5nKHJlYWQoJ2ZvbnRGYW1pbHknKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnZm9udEZhbWlseScpIDogJ0FyaWFsJykgfHwgJ0FyaWFsJztcbiAgICAgICAgY29uc3Qgd3JhcE9uID0gcmVhZCgnd3JhcCcpICE9PSB1bmRlZmluZWQgPyBCb29sZWFuKHJlYWQoJ3dyYXAnKSkgOiByZWFkKCdlbmFibGVXcmFwVGV4dCcpICE9PSB1bmRlZmluZWQgPyBCb29sZWFuKHJlYWQoJ2VuYWJsZVdyYXBUZXh0JykpIDogdHJ1ZTtcbiAgICAgICAgY29uc3QgYm94V2lkdGggPSBOdW1iZXIocmVhZCgnd2lkdGgnKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnd2lkdGgnKSA6IHV0ID8gdXQud2lkdGggOiAwKSB8fCAwO1xuICAgICAgICBjb25zdCBib3hIZWlnaHQgPSBOdW1iZXIocmVhZCgnaGVpZ2h0JykgIT09IHVuZGVmaW5lZCA/IHJlYWQoJ2hlaWdodCcpIDogdXQgPyB1dC5oZWlnaHQgOiAwKSB8fCAwO1xuXG4gICAgICAgIGNvbnN0IE9WRVJGTE9XX05BTUVTID0gWydOT05FJywgJ0NMQU1QJywgJ1NIUklOSycsICdSRVNJWkVfSEVJR0hUJ107XG4gICAgICAgIGNvbnN0IHJhd092ZXJmbG93ID0gcmVhZCgnb3ZlcmZsb3cnKSAhPT0gdW5kZWZpbmVkID8gcmVhZCgnb3ZlcmZsb3cnKSA6ICdDTEFNUCc7XG4gICAgICAgIGxldCBvdmVyZmxvd05hbWUgPSAnQ0xBTVAnO1xuICAgICAgICBpZiAodHlwZW9mIHJhd092ZXJmbG93ID09PSAnbnVtYmVyJykgb3ZlcmZsb3dOYW1lID0gT1ZFUkZMT1dfTkFNRVNbcmF3T3ZlcmZsb3ddIHx8ICdDTEFNUCc7XG4gICAgICAgIGVsc2UgaWYgKHR5cGVvZiByYXdPdmVyZmxvdyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IHVwcGVyID0gcmF3T3ZlcmZsb3cudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBvdmVyZmxvd05hbWUgPSBPVkVSRkxPV19OQU1FUy5pbmRleE9mKHVwcGVyKSA+PSAwID8gdXBwZXIgOiAnQ0xBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqIGBvdmVyZmxvdyA9IE5PTkVgIOaXtuW8leaTjuS4jeaKmOihjO+8m+WFtuS9meS4ieenjemDveS8mu+8iOWPquimgeW8gOS6hiBlbmFibGVXcmFwVGV4dO+8ieOAgiAqL1xuICAgICAgICBjb25zdCB3cmFwcyA9IHdyYXBPbiAmJiBvdmVyZmxvd05hbWUgIT09ICdOT05FJztcbiAgICAgICAgY29uc3QgbWV0aG9kcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgICAgIC8qKiDmjInmn5DkuKrlrZflj7fmjpLkuIDpgY3niYgg4oCU4oCUIFNIUklOSyDopoHmi7/lroPkuozliIbvvIzmiYDku6Xmir3miJDlh73mlbDjgIIgKi9cbiAgICAgICAgY29uc3QgbGF5b3V0QXQgPSAoZnM6IG51bWJlcik6IHsgbGluZXM6IHN0cmluZ1tdOyB3aWR0aHM6IG51bWJlcltdOyBtYXhMaW5lV2lkdGg6IG51bWJlcjsgY29udGVudEhlaWdodDogbnVtYmVyOyBhZHZhbmNlOiBudW1iZXIgfSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhZHZhbmNlID0gbGluZUhlaWdodFJhdyA+IDAgPyBsaW5lSGVpZ2h0UmF3IDogZnM7XG4gICAgICAgICAgICBjb25zdCBtZWFzID0gKHM6IHN0cmluZyk6IG51bWJlciA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gbWVhc3VyZVRleHRXaWR0aChzLCBmcywgZm9udEZhbWlseSk7XG4gICAgICAgICAgICAgICAgbWV0aG9kcy5hZGQocmVzdWx0Lm1ldGhvZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC53aWR0aDtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcGFyYWdyYXBoIG9mIHRleHQuc3BsaXQoJ1xcbicpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCF3cmFwcyB8fCAhKGJveFdpZHRoID4gMCkpIHtcbiAgICAgICAgICAgICAgICAgICAgbGluZXMucHVzaChwYXJhZ3JhcGgpO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnQgPSAnJztcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNoIG9mIHBhcmFncmFwaCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBjdXJyZW50ICsgY2g7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjdXJyZW50Lmxlbmd0aCA+IDAgJiYgbWVhcyhjYW5kaWRhdGUpID4gYm94V2lkdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goY3VycmVudCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gY2g7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gY2FuZGlkYXRlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goY3VycmVudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB3aWR0aHMgPSBsaW5lcy5tYXAoKGxpbmUpID0+IG1lYXMobGluZSkpO1xuICAgICAgICAgICAgY29uc3QgY291bnQgPSBsaW5lcy5sZW5ndGg7XG4gICAgICAgICAgICBjb25zdCBjb250ZW50SGVpZ2h0ID0gY291bnQgPT09IDAgPyAwIDogKGNvdW50IC0gMSkgKiBhZHZhbmNlICsgYWR2YW5jZSAqIExBQkVMX0xBU1RfTElORV9GQUNUT1I7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGxpbmVzLFxuICAgICAgICAgICAgICAgIHdpZHRocyxcbiAgICAgICAgICAgICAgICBtYXhMaW5lV2lkdGg6IHdpZHRocy5sZW5ndGggPiAwID8gTWF0aC5tYXgoLi4ud2lkdGhzKSA6IDAsXG4gICAgICAgICAgICAgICAgY29udGVudEhlaWdodCxcbiAgICAgICAgICAgICAgICBhZHZhbmNlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcblxuICAgICAgICAvKiog5qGG6auY5o2i566X5oiQ44CM5pyA5aSa5pS+5b6X5LiL5Yeg6KGM44CN77yI5LiK6Z2iIGBjb250ZW50SGVpZ2h0YCDlhazlvI/nmoTpgIbvvInjgIIgKi9cbiAgICAgICAgY29uc3QgY2FwYWNpdHlPZiA9IChhZHZhbmNlOiBudW1iZXIpOiBudW1iZXIgPT5cbiAgICAgICAgICAgIGFkdmFuY2UgPiAwICYmIGJveEhlaWdodCA+IDBcbiAgICAgICAgICAgICAgICA/IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoYm94SGVpZ2h0IC8gYWR2YW5jZSAtIChMQUJFTF9MQVNUX0xJTkVfRkFDVE9SIC0gMSkpKVxuICAgICAgICAgICAgICAgIDogMDtcblxuICAgICAgICBjb25zdCBiYXNlID0gbGF5b3V0QXQoZm9udFNpemUpO1xuICAgICAgICBjb25zdCBtYXhMaW5lc0ZpdCA9IGNhcGFjaXR5T2YoYmFzZS5hZHZhbmNlKTtcbiAgICAgICAgY29uc3QgbGluZUNvdW50ID0gYmFzZS5saW5lcy5sZW5ndGg7XG4gICAgICAgIGNvbnN0IHZpc2libGVMaW5lcyA9IG92ZXJmbG93TmFtZSA9PT0gJ0NMQU1QJyA/IE1hdGgubWluKGxpbmVDb3VudCwgbWF4TGluZXNGaXQpIDogbGluZUNvdW50O1xuICAgICAgICBjb25zdCBjbGlwcGVkVGV4dCA9IG92ZXJmbG93TmFtZSA9PT0gJ0NMQU1QJyAmJiBsaW5lQ291bnQgPiBtYXhMaW5lc0ZpdCA/IGJhc2UubGluZXMuc2xpY2UobWF4TGluZXNGaXQpLmpvaW4oJycpIDogJyc7XG4gICAgICAgIGNvbnN0IG92ZXJmbG93WCA9IE1hdGgubWF4KDAsIGJhc2UubWF4TGluZVdpZHRoIC0gYm94V2lkdGgpO1xuICAgICAgICBjb25zdCBmaXRzV2lkdGggPSBvdmVyZmxvd1ggPD0gMC41OyAvLyDljYrlg4/ntKDlrrnlt65cbiAgICAgICAgY29uc3QgZml0c0hlaWdodCA9IGxpbmVDb3VudCA8PSBtYXhMaW5lc0ZpdDtcblxuICAgICAgICBsZXQgc2hyaW5rVG86IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgICAgICBpZiAob3ZlcmZsb3dOYW1lID09PSAnU0hSSU5LJykge1xuICAgICAgICAgICAgbGV0IGxvID0gMTtcbiAgICAgICAgICAgIGxldCBoaSA9IGZvbnRTaXplO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMiAmJiBoaSAtIGxvID4gMC4yNTsgaSArPSAxKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWlkID0gKGxvICsgaGkpIC8gMjtcbiAgICAgICAgICAgICAgICBjb25zdCBsYWlkID0gbGF5b3V0QXQobWlkKTtcbiAgICAgICAgICAgICAgICBpZiAobGFpZC5saW5lcy5sZW5ndGggPD0gY2FwYWNpdHlPZihsYWlkLmFkdmFuY2UpICYmIGxhaWQubWF4TGluZVdpZHRoIDw9IGJveFdpZHRoICsgMC41KSBsbyA9IG1pZDtcbiAgICAgICAgICAgICAgICBlbHNlIGhpID0gbWlkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2hyaW5rVG8gPSBNYXRoLnJvdW5kKGxvICogMTAwKSAvIDEwMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlYXNvbnM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGxldCBjb25maWRlbmNlID0gJ2hpZ2gnO1xuICAgICAgICBpZiAobWV0aG9kcy5oYXMoJ2VzdGltYXRlJykpIHtcbiAgICAgICAgICAgIGNvbmZpZGVuY2UgPSAnbG93JztcbiAgICAgICAgICAgIHJlYXNvbnMucHVzaCgn5a695bqm5pivKirkvLAqKueahO+8iOi/meS4queOr+Wig+mHjOayoeaciSBET00g6YeP5LiN5LqG5a2X77yJ77yM5Lit6Iux5re35o6S5Y+v6IO95beu5Yeg5Liq5YOP57SgJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGJveFdpZHRoID4gMCAmJiBiYXNlLm1heExpbmVXaWR0aCA+IGJveFdpZHRoICogMC45OCAmJiBiYXNlLm1heExpbmVXaWR0aCA8PSBib3hXaWR0aCkge1xuICAgICAgICAgICAgaWYgKGNvbmZpZGVuY2UgPT09ICdoaWdoJykgY29uZmlkZW5jZSA9ICdib3JkZXJsaW5lJztcbiAgICAgICAgICAgIHJlYXNvbnMucHVzaCgn5pyA6ZW/5LiA6KGM5Yeg5LmO6aG25Yiw5qGG5a6977yIPjk4Je+8ieKAlOKAlCDlho3lrr3kuIDngrnngrnlsLHkvJrlpJrljaDkuIDooYwnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAod3JhcHMgJiYgL1xccy8udGVzdCh0ZXh0KSkge1xuICAgICAgICAgICAgcmVhc29ucy5wdXNoKCfmlofmnKzlkKvnqbrmoLzvvJrlvJXmk47mjIkqKuivjSoq5oqY6KGM44CB6L+Z6YeM5oyJKirlrZfnrKYqKuaKmCDigJTigJQg5byV5pOO5a6e6ZmF5Y2g55qE6KGMKirlj6/og73mm7TlpJoqKicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHNvdXJjZTogbm9kZSA/IGBub2RlOiR7bm9kZS5uYW1lfWAgOiAnc3BlYycsXG4gICAgICAgICAgICB0ZXh0LFxuICAgICAgICAgICAgZm9udFNpemUsXG4gICAgICAgICAgICBsaW5lSGVpZ2h0OiBsaW5lSGVpZ2h0UmF3LFxuICAgICAgICAgICAgYWR2YW5jZTogcm91bmQzKGJhc2UuYWR2YW5jZSksXG4gICAgICAgICAgICBhZHZhbmNlU291cmNlOiBsaW5lSGVpZ2h0UmF3ID4gMCA/ICdub2RlLmxpbmVIZWlnaHQnIDogJ2VuZ2luZS1kZWZhdWx0KD0gZm9udFNpemXvvIzlm6DkuLogbGluZUhlaWdodCA8PSAwKScsXG4gICAgICAgICAgICB3cmFwOiB3cmFwcyxcbiAgICAgICAgICAgIG92ZXJmbG93OiBvdmVyZmxvd05hbWUsXG4gICAgICAgICAgICBmb250RmFtaWx5LFxuICAgICAgICAgICAgYm94OiB7IHdpZHRoOiByb3VuZDMoYm94V2lkdGgpLCBoZWlnaHQ6IHJvdW5kMyhib3hIZWlnaHQpIH0sXG4gICAgICAgICAgICBsaW5lczogYmFzZS5saW5lcy5tYXAoKGxpbmUsIGkpID0+ICh7IGluZGV4OiBpICsgMSwgdGV4dDogbGluZSwgd2lkdGg6IHJvdW5kMyhiYXNlLndpZHRoc1tpXSkgfSkpLFxuICAgICAgICAgICAgbGluZUNvdW50LFxuICAgICAgICAgICAgbWF4TGluZVdpZHRoOiByb3VuZDMoYmFzZS5tYXhMaW5lV2lkdGgpLFxuICAgICAgICAgICAgY29udGVudEhlaWdodDogcm91bmQzKGJhc2UuY29udGVudEhlaWdodCksXG4gICAgICAgICAgICBtYXhMaW5lc0ZpdCxcbiAgICAgICAgICAgIHZpc2libGVMaW5lcyxcbiAgICAgICAgICAgIGNsaXBwZWRMaW5lQ291bnQ6IE1hdGgubWF4KDAsIGxpbmVDb3VudCAtIHZpc2libGVMaW5lcyksXG4gICAgICAgICAgICBjbGlwcGVkVGV4dCxcbiAgICAgICAgICAgIGZpdHM6IGZpdHNXaWR0aCAmJiBmaXRzSGVpZ2h0LFxuICAgICAgICAgICAgZml0c1dpZHRoLFxuICAgICAgICAgICAgZml0c0hlaWdodCxcbiAgICAgICAgICAgIG92ZXJmbG93WDogcm91bmQzKG92ZXJmbG93WCksXG4gICAgICAgICAgICBzaG9ydGZhbGxQeDogcm91bmQzKE1hdGgubWF4KDAsIGJhc2UuY29udGVudEhlaWdodCAtIGJveEhlaWdodCkpLFxuICAgICAgICAgICAgc2hyaW5rVG8sXG4gICAgICAgICAgICByZXNpemVUbzogb3ZlcmZsb3dOYW1lID09PSAnUkVTSVpFX0hFSUdIVCcgPyB7IGhlaWdodDogcm91bmQzKGJhc2UuY29udGVudEhlaWdodCkgfSA6IG51bGwsXG4gICAgICAgICAgICBtZXRob2Q6IG1ldGhvZHMuaGFzKCdjYW52YXMnKSA/ICdjYW52YXMnIDogJ2VzdGltYXRlJyxcbiAgICAgICAgICAgIHdyYXBNb2RlOiB3cmFwcyA/ICdjaGFyLWdyZWVkeScgOiAnbm9uZScsXG4gICAgICAgICAgICBjb25maWRlbmNlLFxuICAgICAgICAgICAgcmVhc29ucyxcbiAgICAgICAgICAgIGZvcm11bGE6ICdjb250ZW50SGVpZ2h0ID0gKOihjOaVsC0xKcOX6KGM6L+b57uZICsg6KGM6L+b57uZw5cxLjI277yb5pyA5aSa6KGM5pWwID0gZmxvb3Io5qGG6auYL+ihjOi/m+e7mSDiiJIgMC4yNinvvJvooYzov5vnu5kgPSBsaW5lSGVpZ2h0PjAgPyBsaW5lSGVpZ2h0IDogZm9udFNpemUnLFxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIOW/q+eFpyAvIOW3ruW8giDigJTigJQg44CM5oiR5Yiw5bqV5pS55LqG5LuA5LmI44CNXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8qKiDmr4/kuKrnu4Tku7borrDlk6rkupvlrZfmrrXvvIjnmb3lkI3ljZXvvInjgIIqKuS4jeiuvueZveWQjeWNleeahOivneWZquWjsOS8mua3ueaOieecn+ato+eahOaUueWKqCoq44CCICovXG4gICAgY29uc3QgU05BUFNIT1RfQ09NUE9ORU5UX1BST1BTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7XG4gICAgICAgIFNwcml0ZTogWydzcHJpdGVGcmFtZScsICdjb2xvcicsICd0eXBlJywgJ3NpemVNb2RlJywgJ2ZpbGxUeXBlJywgJ2ZpbGxSYW5nZScsICdncmF5c2NhbGUnLCAndHJpbSddLFxuICAgICAgICBMYWJlbDogW1xuICAgICAgICAgICAgJ3N0cmluZycsXG4gICAgICAgICAgICAnZm9udFNpemUnLFxuICAgICAgICAgICAgJ2xpbmVIZWlnaHQnLFxuICAgICAgICAgICAgJ292ZXJmbG93JyxcbiAgICAgICAgICAgICdlbmFibGVXcmFwVGV4dCcsXG4gICAgICAgICAgICAnY29sb3InLFxuICAgICAgICAgICAgJ2hvcml6b250YWxBbGlnbicsXG4gICAgICAgICAgICAndmVydGljYWxBbGlnbicsXG4gICAgICAgICAgICAnaXNCb2xkJyxcbiAgICAgICAgICAgICd1c2VTeXN0ZW1Gb250JyxcbiAgICAgICAgICAgICdmb250RmFtaWx5JyxcbiAgICAgICAgXSxcbiAgICAgICAgUmljaFRleHQ6IFsnc3RyaW5nJywgJ2ZvbnRTaXplJywgJ2xpbmVIZWlnaHQnLCAnbWF4V2lkdGgnLCAnaG9yaXpvbnRhbEFsaWduJ10sXG4gICAgICAgIFVJT3BhY2l0eTogWydvcGFjaXR5J10sXG4gICAgICAgIFdpZGdldDogW1xuICAgICAgICAgICAgJ2lzQWxpZ25Ub3AnLFxuICAgICAgICAgICAgJ2lzQWxpZ25Cb3R0b20nLFxuICAgICAgICAgICAgJ2lzQWxpZ25MZWZ0JyxcbiAgICAgICAgICAgICdpc0FsaWduUmlnaHQnLFxuICAgICAgICAgICAgJ2lzQWxpZ25Ib3Jpem9udGFsQ2VudGVyJyxcbiAgICAgICAgICAgICdpc0FsaWduVmVydGljYWxDZW50ZXInLFxuICAgICAgICAgICAgJ3RvcCcsXG4gICAgICAgICAgICAnYm90dG9tJyxcbiAgICAgICAgICAgICdsZWZ0JyxcbiAgICAgICAgICAgICdyaWdodCcsXG4gICAgICAgICAgICAnaG9yaXpvbnRhbENlbnRlcicsXG4gICAgICAgICAgICAndmVydGljYWxDZW50ZXInLFxuICAgICAgICAgICAgJ2FsaWduTW9kZScsXG4gICAgICAgIF0sXG4gICAgICAgIEJ1dHRvbjogWyd0cmFuc2l0aW9uJywgJ2ludGVyYWN0YWJsZScsICdub3JtYWxDb2xvcicsICdwcmVzc2VkQ29sb3InLCAnaG92ZXJDb2xvcicsICdkaXNhYmxlZENvbG9yJywgJ3pvb21TY2FsZSddLFxuICAgICAgICBMYXlvdXQ6IFtcbiAgICAgICAgICAgICd0eXBlJyxcbiAgICAgICAgICAgICdyZXNpemVNb2RlJyxcbiAgICAgICAgICAgICdjZWxsU2l6ZScsXG4gICAgICAgICAgICAnc3BhY2luZ1gnLFxuICAgICAgICAgICAgJ3NwYWNpbmdZJyxcbiAgICAgICAgICAgICdwYWRkaW5nTGVmdCcsXG4gICAgICAgICAgICAncGFkZGluZ1JpZ2h0JyxcbiAgICAgICAgICAgICdwYWRkaW5nVG9wJyxcbiAgICAgICAgICAgICdwYWRkaW5nQm90dG9tJyxcbiAgICAgICAgICAgICdhZmZlY3RlZEJ5U2NhbGUnLFxuICAgICAgICBdLFxuICAgIH07XG5cbiAgICAvKiogYENvbG9yYCDihpIgYCNycmdnYmJhYWDvvIjmr5TovoPnlKjvvIzmr5TkuIDkuLLlrZfmrrXlpb3or7vkuZ/lpb0gZGlmZu+8ieOAgiAqL1xuICAgIGNvbnN0IGNvbG91ckhleCA9IChjb2xvcjogYW55KTogc3RyaW5nIHwgbnVsbCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWNvbG9yKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSAodjogYW55KTogc3RyaW5nID0+XG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoMCwgTWF0aC5taW4oMjU1LCBNYXRoLnJvdW5kKE51bWJlcih2KSB8fCAwKSkpXG4gICAgICAgICAgICAgICAgICAgIC50b1N0cmluZygxNilcbiAgICAgICAgICAgICAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyk7XG4gICAgICAgICAgICByZXR1cm4gYCMke3BhcnQoY29sb3Iucil9JHtwYXJ0KGNvbG9yLmcpfSR7cGFydChjb2xvci5iKX0ke3BhcnQoY29sb3IuYSl9YDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICAvKiog5oqK5LiA5Liq5bGe5oCn5YC85Y6L5oiQKirlj6/mr5Tlj6/or7sqKueahOe6r+mHj++8iOW/q+eFp+imgeiDvSBKU09OIOWMlu+8jOS5n+S4jeiDveiiqyBjYyDlr7nosaHmi5bniIbvvInjgIIgKi9cbiAgICBjb25zdCBzbmFwc2hvdFZhbHVlID0gKHZhbHVlOiBhbnkpOiB1bmtub3duID0+IHtcbiAgICAgICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBraW5kID0gdHlwZW9mIHZhbHVlO1xuICAgICAgICBpZiAoa2luZCA9PT0gJ3N0cmluZycgfHwga2luZCA9PT0gJ251bWJlcicgfHwga2luZCA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gdmFsdWU7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSA4ID8gdmFsdWUubWFwKCh2KSA9PiBzbmFwc2hvdFZhbHVlKHYpKSA6IGBbQXJyYXkoJHt2YWx1ZS5sZW5ndGh9KV1gO1xuICAgICAgICB9XG4gICAgICAgIGlmIChraW5kID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZS51dWlkID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgdmFsdWUubmFtZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYGFzc2V0OiR7dmFsdWUubmFtZX1AJHt2YWx1ZS51dWlkLnNsaWNlKDAsIDgpfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlLndpZHRoID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgdmFsdWUuaGVpZ2h0ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgIHJldHVybiBgJHtyb3VuZDModmFsdWUud2lkdGgpfSwke3JvdW5kMyh2YWx1ZS5oZWlnaHQpfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlLnggPT09ICdudW1iZXInICYmIHR5cGVvZiB2YWx1ZS55ID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZS53ID09PSB1bmRlZmluZWQgJiYgdmFsdWUueiA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm91bmQzKHZhbHVlLngpfSwke3JvdW5kMyh2YWx1ZS55KX1gXG4gICAgICAgICAgICAgICAgICAgIDogYCR7cm91bmQzKHZhbHVlLngpfSwke3JvdW5kMyh2YWx1ZS55KX0sJHtyb3VuZDModmFsdWUueiB8fCAwKX1gO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGA8JHsodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IubmFtZSkgfHwgJ09iamVjdCd9PmA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGA8JHtraW5kfT5gO1xuICAgIH07XG5cbiAgICAvKiog5LiA5Liq6IqC54K555qE5b+r54Wn5bGe5oCn77yI55m95ZCN5Y2VICsg5Y6L5bmz77yJ44CCICovXG4gICAgY29uc3Qgc25hcHNob3ROb2RlUHJvcHMgPSAobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIG91dC5hY3RpdmUgPSBub2RlLmFjdGl2ZSAhPT0gZmFsc2U7XG4gICAgICAgIG91dC5wb3NpdGlvbiA9IHNuYXBzaG90VmFsdWUobm9kZS5wb3NpdGlvbik7XG4gICAgICAgIG91dC5zY2FsZSA9IHNuYXBzaG90VmFsdWUobm9kZS5zY2FsZSk7XG4gICAgICAgIGlmICh0eXBlb2Ygbm9kZS5sYXllciA9PT0gJ251bWJlcicpIG91dC5sYXllciA9IG5vZGUubGF5ZXI7XG4gICAgICAgIGNvbnN0IHV0ID0gdWlUcmFuc2Zvcm1PZihub2RlKTtcbiAgICAgICAgaWYgKHV0KSB7XG4gICAgICAgICAgICBvdXQuY29udGVudFNpemUgPSBzbmFwc2hvdFZhbHVlKHV0KTtcbiAgICAgICAgICAgIG91dC5hbmNob3IgPSBgJHtyb3VuZDModXQuYW5jaG9yWCl9LCR7cm91bmQzKHV0LmFuY2hvclkpfWA7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdXQucHJpb3JpdHkgPT09ICdudW1iZXInKSBvdXQucHJpb3JpdHkgPSB1dC5wcmlvcml0eTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5vZGUuZ2V0U2libGluZ0luZGV4ID09PSAnZnVuY3Rpb24nKSBvdXQuc2libGluZ0luZGV4ID0gbm9kZS5nZXRTaWJsaW5nSW5kZXgoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaXN0OiBhbnlbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobm9kZS5jb21wb25lbnRzKSkgbGlzdCA9IG5vZGUuY29tcG9uZW50cztcbiAgICAgICAgICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkobm9kZS5fY29tcG9uZW50cykpIGxpc3QgPSBub2RlLl9jb21wb25lbnRzO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGxpc3QgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBjb21wIG9mIGxpc3QpIHtcbiAgICAgICAgICAgIGlmICghY29tcCkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCB0eXBlTmFtZSA9IFN0cmluZygoY29tcC5jb25zdHJ1Y3RvciAmJiBjb21wLmNvbnN0cnVjdG9yLm5hbWUpIHx8ICdDb21wb25lbnQnKTtcbiAgICAgICAgICAgIG5hbWVzLnB1c2godHlwZU5hbWUpO1xuICAgICAgICAgICAgY29uc3Qgd2FudGVkID0gU05BUFNIT1RfQ09NUE9ORU5UX1BST1BTW3R5cGVOYW1lXTtcbiAgICAgICAgICAgIGlmICghd2FudGVkKSBjb250aW51ZTtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog57uE5Lu25a2X5q61KirmkYrlubPmiJAgYFR5cGUuZmllbGRgIOS4gOS4qumUrioq77yM6ICM5LiN5piv5bWM5oiQIGB7TGFiZWw6IHvigKZ9fWAg4oCU4oCUXG4gICAgICAgICAgICAgKiDlkKbliJnmlLnkuIDkuKrlrZfkvZPkvJrmiormlbTkuKogTGFiZWwg55qE5a2X5q616KKL5oql5oiQIGZyb20vdG/vvIxcbiAgICAgICAgICAgICAqIOOAjOWTquS4gOadoeWPmOS6huOAjeWwseeci+S4jeWHuuadpeS6hu+8iOWunua1i+esrOS4gOeJiOWwseaYr+i/meagt++8jGRpZmYg5Zue5omn5LiA5bGP5YWo5piv5Zmq5aOw77yJ44CCXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIHdhbnRlZCkge1xuICAgICAgICAgICAgICAgIGxldCByYXc6IGFueTtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICByYXcgPSBjb21wW2tleV07XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIG91dFtgJHt0eXBlTmFtZX0uJHtrZXl9YF0gPVxuICAgICAgICAgICAgICAgICAgICByYXcgJiYgdHlwZW9mIHJhdyA9PT0gJ29iamVjdCcgJiYgdHlwZW9mIHJhdy5yID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgcmF3LmEgPT09ICdudW1iZXInXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGNvbG91ckhleChyYXcpXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHNuYXBzaG90VmFsdWUocmF3KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBvdXQuY29tcG9uZW50cyA9IG5hbWVzLnNvcnQoKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9O1xuXG4gICAgLyoqIEZOVi0xYe+8iDMyIOS9je+8ieKAlOKAlCDlj6rnlKjmnaXjgIzkuKTku73lv6vnhafmmK/kuI3mmK/lkIzkuIDku73jgI3vvIzkuI3lgZrlronlhajnlKjpgJTjgIIgKi9cbiAgICBjb25zdCBoYXNoT2YgPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICAgICAgbGV0IGhhc2ggPSAweDgxMWM5ZGM1O1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgIGhhc2ggXj0gdGV4dC5jaGFyQ29kZUF0KGkpO1xuICAgICAgICAgICAgaGFzaCA9IChoYXNoICsgKChoYXNoIDw8IDEpICsgKGhhc2ggPDwgNCkgKyAoaGFzaCA8PCA3KSArIChoYXNoIDw8IDgpICsgKGhhc2ggPDwgMjQpKSkgPj4+IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGhhc2gudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDgsICcwJyk7XG4gICAgfTtcblxuICAgIC8qKiDokL3nm5jvvIjmi7/kuI3liLAgYGZzYCDlsLHlpoLlrp7lm54gbnVsbO+8jOS4jeWBh+ijheWGmeS6hu+8ieOAgiAqL1xuICAgIGNvbnN0IHdyaXRlVGV4dEZpbGUgPSAoc2F2ZVBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfCBudWxsOyBlcnJvcj86IHN0cmluZyB9ID0+IHtcbiAgICAgICAgY29uc3Qgbm9kZU1vZHMgPSBnZXROb2RlTW9kdWxlcygpO1xuICAgICAgICBpZiAoIW5vZGVNb2RzKSByZXR1cm4geyBwYXRoOiBudWxsLCBlcnJvcjogJ+i/meS4qui/m+eoi+mHjOaLv+S4jeWIsCBmc++8jOWGmeS4jeS6huebmCcgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGRpciA9IG5vZGVNb2RzLnBhdGguZGlybmFtZShzYXZlUGF0aCk7XG4gICAgICAgICAgICBpZiAoZGlyKSBub2RlTW9kcy5mcy5ta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIG5vZGVNb2RzLmZzLndyaXRlRmlsZVN5bmMoc2F2ZVBhdGgsIHRleHQsICd1dGYtOCcpO1xuICAgICAgICAgICAgcmV0dXJuIHsgcGF0aDogc2F2ZVBhdGggfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBwYXRoOiBudWxsLCBlcnJvcjogYOWGmSAke3NhdmVQYXRofSDlpLHotKXvvJoke2Vycm9ySW5mbyhlcnIpLm1lc3NhZ2V9YCB9O1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqICoq57uZ5LiA5qO15a2Q5qCR5ouN5LiA5Lu957qv5pWw5o2u5b+r54WnKirvvIjmjInoioLngrnot6/lvoTlgZrplK7vvInigJTigJQg44CM5oiR5Yiw5bqV5pS55LqG5LuA5LmI44CN55qE5YmN5LiA5Y2K44CCXG4gICAgICpcbiAgICAgKiAjIyDkuLrku4DkuYjkuI3og73pnaAgYGR1bXAobm9kZSlgIOaIluaIquWbvlxuICAgICAqXG4gICAgICogLSBgZHVtcGAg5Zue55qE5pivIGNjIOWvueixoeaRmOimge+8jCoq5a2Y5LiN5LiL5p2l5Lmf5rKh5rOV5q+UKirvvJvogIzkuJTov5Tlm57lgLzmnIkgNDAwMCDlrZfkuIrpmZDvvIxcbiAgICAgKiAgIDMwNiDkuKroioLngrnmoLnmnKzlm57kuI3mnaXvvJtcbiAgICAgKiAtIOaIquWbvuWPquiDveWRiuivieS9oFwi55yL6LW35p2l5LiN5LiA5qC35LqGXCLvvIzlkYrkuI3lh7pcIuWTquS4quWxnuaAp+S7juWHoOWPmOaIkOWHoFwi44CCXG4gICAgICpcbiAgICAgKiAjIyDkuInmnaHorr7orqHlj6PlvoRcbiAgICAgKlxuICAgICAqIDEuICoq6ZSu5piv6IqC54K56Lev5b6E77yM5LiN5pivIHV1aWQqKuOAgue8lui+keWZqOWtmOebmC/ph43mlrDlr7zlhaXlkI7oioLngrkgdXVpZCAqKuS8muWPmCoqXG4gICAgICogICDvvIjlrp7mtYvmr4/mrKHkv53lrZjpg73mjaLkuIDmibnvvInigJTigJQg5oyJIHV1aWQg5YGa6ZSu55qE6K+dIGJlZm9yZS9hZnRlciDkvJrlhajmmK/jgIzliKDkuoYgMzA2IOS4quOAgeWKoOS6hiAzMDYg5Liq44CN44CCXG4gICAgICogMi4gKirlsZ7mgKfotbDnmb3lkI3ljZUqKu+8iGBTTkFQU0hPVF9DT01QT05FTlRfUFJPUFNg77yJ44CC5YWo6YePIGR1bXAg55qE6K+d77yMXG4gICAgICogICAgYF9fcHJlbG9hZGAv6L+Q6KGM5pe257yT5a2Y5a2X5q615q+P5p2h6YO95Zyo5Y+Y77yM55yf5q2j55qE5pS55Yqo5Lya6KKr5Zmq5aOw5re55o6J44CCXG4gICAgICogMy4gKirmlbTku73nlZnlnKjlnLrmma/ov5vnqIvph4wqKu+8jOi/lOWbnuWAvOWPque7meOAjOaRmOimgSArIOWTiOW4jCArIOWtmOS6huayoeOAjeKAlOKAlFxuICAgICAqICAgIGBNYXBgIOaMguWcqOaooeWdl+S9nOeUqOWfn++8jOaJgOS7pei3qOS4pOasoSBgZXhlY3V0ZV9jb2RlYCDosIPnlKjkuZ/lnKjvvIjop4EgYHNuYXBzaG90U3RvcmVgIOazqOmHiu+8ieOAglxuICAgICAqXG4gICAgICogIyMg55So5rOVXG4gICAgICpcbiAgICAgKiBgYGBqc1xuICAgICAqIHNuYXBzaG90VHJlZShudWxsLCB7IGxhYmVsOiAnYmVmb3JlJyB9KTsgICAvLyDliqjmiYvliY1cbiAgICAgKiAvLyDigKbmlLnigKZcbiAgICAgKiBzbmFwc2hvdFRyZWUobnVsbCwgeyBsYWJlbDogJ2FmdGVyJyB9KTtcbiAgICAgKiBkaWZmVHJlZSgnYmVmb3JlJywgJ2FmdGVyJyk7ICAgICAgICAgICAgICAgLy8g4oaSIOWPquWbnuecn+ato+WPmOS6hueahOmCo+WHoOadoVxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICogQHBhcmFtIHJvb3Qg5ouN5ZOq5qO15a2Q5qCR77yI6buY6K6k5pW05Liq5Zy65pmv77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMubGFiZWwg6L+Z5Lu95b+r54Wn55qE5ZCN5a2X77yIYGRpZmZUcmVlYCDnlKjlroPlvJXnlKjvvJvkuI3nu5nlsLHoh6rliqjnlJ/miJDvvIlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5zYXZlVG8g6aG65L6/5oqK5a6M5pW05b+r54Wn5YaZ5Yiw6L+Z5Liq6Lev5b6EXG4gICAgICogQHBhcmFtIG9wdGlvbnMubWF4Tm9kZXMg6IqC54K55pWw5LiK6ZmQ77yI6buY6K6kIDIwMDAw77yM6Ziy5ZGG77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMuaW5jbHVkZUVkaXRvciDov57nvJbovpHlmaggZ2l6bW8v572R5qC85LiA6LW35ouN77yI6buY6K6kIGZhbHNlIOKAlOKAlCDlroPku6zmmK/nvJbovpHlmajoh6rlt7Hph43lu7rnmoTvvIzkvJrpgKDlgYcgZGlmZu+8iVxuICAgICAqL1xuICAgIGhlbHBlcnMuc25hcHNob3RUcmVlID0gKHJvb3Q/OiBhbnksIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3QgbGFiZWwgPVxuICAgICAgICAgICAgdHlwZW9mIG9wdHMubGFiZWwgPT09ICdzdHJpbmcnICYmIG9wdHMubGFiZWwudHJpbSgpID8gb3B0cy5sYWJlbC50cmltKCkgOiBgc25hcC0ke3NuYXBzaG90U3RvcmUuc2l6ZSArIDF9YDtcbiAgICAgICAgY29uc3QgbWF4Tm9kZXMgPSBjbGFtcE51bWJlcihvcHRzLm1heE5vZGVzLCAxLCAyMDAwMDAsIDIwMDAwKTtcbiAgICAgICAgY29uc3Qgc3RhcnQgPSByb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghc3RhcnQpIHRocm93IG5ldyBFcnJvcignc25hcHNob3RUcmVlKHJvb3Qp77ya5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmv77yI5Lmf5rKh57uZIHJvb3TvvInjgIInKTtcblxuICAgICAgICBjb25zdCBub2RlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgY29uc3QgaW5jbHVkZUVkaXRvciA9IEJvb2xlYW4ob3B0cy5pbmNsdWRlRWRpdG9yKTtcbiAgICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgICAgbGV0IHRydW5jYXRlZCA9IDA7XG4gICAgICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IGFueSwgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgICAgICAgICBpZiAoY291bnQgPj0gbWF4Tm9kZXMpIHtcbiAgICAgICAgICAgICAgICB0cnVuY2F0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBub2Rlc1twYXRoXSA9IHNuYXBzaG90Tm9kZVByb3BzKG5vZGUpO1xuICAgICAgICAgICAgY291bnQgKz0gMTtcbiAgICAgICAgICAgIGNvbnN0IGtpZHM6IGFueVtdID0gKG5vZGUgJiYgbm9kZS5jaGlsZHJlbikgfHwgW107XG4gICAgICAgICAgICBjb25zdCBwYWlycyA9IGtpZHMubWFwKChrOiBhbnksIGk6IG51bWJlcikgPT4gKHsgaywgaSwgcDogcmVhZE5vZGVQcmlvcml0eShrKSB9KSk7XG4gICAgICAgICAgICBwYWlycy5zb3J0KChhLCBiKSA9PiBhLnAgLSBiLnAgfHwgYS5pIC0gYi5pKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcGFpciBvZiBwYWlycykge1xuICAgICAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICAgICAqIOm7mOiupCoq5Ymq5o6J57yW6L6R5Zmo6KOF6aWwKirvvIhnaXptbyAvIOe9keagvCAvIOWPguiAg+Wbvu+8ieOAguS4jeWPquaYr+ecgeS9k+enr++8mlxuICAgICAgICAgICAgICAgICAqIOmCo+S6m+iKgueCueaYr+e8lui+keWZqCoq6Ieq5bex6YeN5bu6KirnmoTvvIzlkI3lrZfkuI7lsYLnuqfkvJrpmo/op4bop5Iv6YCJ5Lit5oCB5Y+Y77yMXG4gICAgICAgICAgICAgICAgICog55WZ552A5a6D5Lus5Lya6K6pIGRpZmYg6YeM5YaS5Ye65LiA5aCGXCLmlrDlop4v5Yig6Zmk5LqGIHhBeGlzXCLnmoTlgYfkv6Hlj7cg4oCU4oCUXG4gICAgICAgICAgICAgICAgICog5LiA5Liq5Lya5ZaK54u85p2l5LqG55qEIGRpZmYg5q+U5rKh5pyJIGRpZmYg5pu057Of44CCXG4gICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgaWYgKCFpbmNsdWRlRWRpdG9yICYmIGlzRWRpdG9yTm9kZShwYWlyLmspKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gU3RyaW5nKHBhaXIuay5uYW1lKTtcbiAgICAgICAgICAgICAgICB2aXNpdChwYWlyLmssIHBhdGggPyBgJHtwYXRofS8ke25hbWV9YCA6IG5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB2aXNpdChzdGFydCwgJy4nKTtcblxuICAgICAgICBjb25zdCB0cmVlID0geyByb290OiBTdHJpbmcoc3RhcnQubmFtZSB8fCAnc2NlbmUnKSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgbm9kZXMgfTtcbiAgICAgICAgY29uc3QganNvbiA9IEpTT04uc3RyaW5naWZ5KHRyZWUpO1xuICAgICAgICBjb25zdCByZWNvcmQgPSB7IGxhYmVsLCB0cmVlLCBoYXNoOiBoYXNoT2YoanNvbiksIGJ5dGVzOiBqc29uLmxlbmd0aCwgYXQ6IHRyZWUuYXQgfTtcblxuICAgICAgICAvLyDmt5jmsbDmnIDml6fnmoTvvIhNYXAg5L+d5oyB5o+S5YWl5bqP77yJXG4gICAgICAgIHNuYXBzaG90U3RvcmUuc2V0KGxhYmVsLCByZWNvcmQpO1xuICAgICAgICB3aGlsZSAoc25hcHNob3RTdG9yZS5zaXplID4gU05BUFNIT1RfS0VFUCkge1xuICAgICAgICAgICAgY29uc3Qgb2xkZXN0ID0gc25hcHNob3RTdG9yZS5rZXlzKCkubmV4dCgpO1xuICAgICAgICAgICAgaWYgKG9sZGVzdC5kb25lKSBicmVhaztcbiAgICAgICAgICAgIHNuYXBzaG90U3RvcmUuZGVsZXRlKG9sZGVzdC52YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2F2ZWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgICBsZXQgc2F2ZUVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0eXBlb2Ygb3B0cy5zYXZlVG8gPT09ICdzdHJpbmcnICYmIG9wdHMuc2F2ZVRvLnRyaW0oKSkge1xuICAgICAgICAgICAgY29uc3Qgd3JpdHRlbiA9IHdyaXRlVGV4dEZpbGUob3B0cy5zYXZlVG8udHJpbSgpLCBKU09OLnN0cmluZ2lmeShyZWNvcmQsIG51bGwsIDIpKTtcbiAgICAgICAgICAgIHNhdmVkID0gd3JpdHRlbi5wYXRoO1xuICAgICAgICAgICAgc2F2ZUVycm9yID0gd3JpdHRlbi5lcnJvcjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAodHJ1bmNhdGVkID4gMCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICBg6IqC54K55pWw6LaF6L+HIG1heE5vZGVzPSR7bWF4Tm9kZXN977yM6L+Z5Lu95b+r54WnKirkuI3lrozmlbQqKiDigJTigJQgZGlmZiDkvJrmiormsqHmi43liLDnmoToioLngrnlvZPmiJBcIuiiq+WIoOS6hlwi44CCYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgbm90ZXMucHVzaCgn5Yqo5omL5YmN5ouN5LiA5Lu944CB5pS55a6M5YaN5ouN5LiA5Lu977yM54S25ZCOIGRpZmZUcmVlKGJlZm9yZSwgYWZ0ZXIpIOWwseefpemBk+iHquW3seWIsOW6leWKqOS6huS7gOS5iOOAgicpO1xuICAgICAgICBub3Rlcy5wdXNoKCfoioLngrkv57uE5Lu255qE6ZSu5pivKirot6/lvoQqKu+8jOe8lui+keWZqOWtmOebmOaNoiB1dWlkIOS4jeW9seWTjeavlOWvueOAgicpO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBsYWJlbCxcbiAgICAgICAgICAgIHJvb3Q6IHRyZWUucm9vdCxcbiAgICAgICAgICAgIG5vZGVDb3VudDogT2JqZWN0LmtleXMobm9kZXMpLmxlbmd0aCxcbiAgICAgICAgICAgIGJ5dGVzOiBqc29uLmxlbmd0aCxcbiAgICAgICAgICAgIGhhc2g6IHJlY29yZC5oYXNoLFxuICAgICAgICAgICAgYXQ6IHRyZWUuYXQsXG4gICAgICAgICAgICBzYXZlZCxcbiAgICAgICAgICAgIHNhdmVFcnJvcixcbiAgICAgICAgICAgIHRydW5jYXRlZCxcbiAgICAgICAgICAgIGtlcHQ6IEFycmF5LmZyb20oc25hcHNob3RTdG9yZS5rZXlzKCkpLFxuICAgICAgICAgICAgbm90ZTogbm90ZXMuam9pbignICcpLFxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiAqKuS4pOS7veW/q+eFp+eahOW3ruW8gioqIOKAlOKAlCDjgIzmiJHliLDlupXmlLnkuobku4DkuYjjgI3nmoTlkI7kuIDljYrjgIJcbiAgICAgKlxuICAgICAqIOWPquWbnioq55yf5q2j5Y+Y5LqGKirnmoToioLngrnlkozlsZ7mgKfvvIhge2Zyb20sIHRvfWAg5oiQ5a+557uZ77yJ77yM5omA5Lul5Zue5omn5aSp54S25b6I5bCP77yMXG4gICAgICog5LiN5Lya6KKrIDQwMDAg5a2X5LiK6ZmQ5oiq5patIOKAlOKAlCDlrozmlbTmiqXlkYrmg7PnlZnmoaPlsLHkvKAgYHNhdmVUb2DjgIJcbiAgICAgKlxuICAgICAqIOmhuuW4puS8muaMkeWHuiBgc3VzcGVjdExlYWtzYO+8muaWsOWinuiKgueCuemHjOWQjeWtl+WDj+S4tOaXtuWAmemAieeJqeeahFxuICAgICAqIO+8iGBfX2AgLyBgcHJvYmVgIC8gYHRtcGAgLyBgdGVzdGDvvInigJTigJQgKirlrp7mtYvouKnov4fkuIDmrKEqKu+8muaOoumSiOWNoeeJh+WSjCBgZGV0YWlsYC9gbmFtZWBcbiAgICAgKiDnmoTlrp7pqozoioLngrnnlZnlnKjpooTliLbku7bph4zlv5jkuobliKDvvIzlhajpnaDkuIvkuIDmrKHlvIDnvJbovpHlmajml7bkurrlt6Xlj5HnjrDjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBiZWZvcmUg5b+r54WnIGxhYmVs77yM5oiW5LiA5Lu95b+r54Wn5a+56LGhXG4gICAgICogQHBhcmFtIGFmdGVyIOWQjOS4ilxuICAgICAqIEBwYXJhbSBvcHRpb25zLmxpbWl0IOavj+exu+acgOWkmuWbnuWHoOadoe+8iOm7mOiupCA0MO+8iVxuICAgICAqIEBwYXJhbSBvcHRpb25zLnNhdmVUbyDmiooqKuWujOaVtCoq5oql5ZGK5YaZ5Yiw6L+Z5Liq6Lev5b6EXG4gICAgICovXG4gICAgaGVscGVycy5kaWZmVHJlZSA9IChcbiAgICAgICAgYmVmb3JlPzogYW55LFxuICAgICAgICBhZnRlcj86IGFueSxcbiAgICAgICAgb3B0aW9ucz86IFJlY29yZDxzdHJpbmcsIGFueT4sXG4gICAgKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3QgbGltaXQgPSBjbGFtcE51bWJlcihvcHRzLmxpbWl0LCAxLCA1MDAwLCA0MCk7XG4gICAgICAgIGNvbnN0IHJlc29sdmVTbmFwID0gKHJlZjogYW55LCBzaWRlOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0+IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgcmVmID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGZvdW5kID0gc25hcHNob3RTdG9yZS5nZXQocmVmKTtcbiAgICAgICAgICAgICAgICBpZiAoIWZvdW5kKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBkaWZmVHJlZe+8muayoeacieWQjeS4uiAnJHtyZWZ9JyDnmoTlv6vnhafvvIgke3NpZGV977yJ44CC5bey5pyJ55qE77yaJHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBBcnJheS5mcm9tKHNuYXBzaG90U3RvcmUua2V5cygpKS5qb2luKCcsICcpIHx8ICfvvIjkuIDku73pg73msqHmnInvvIknXG4gICAgICAgICAgICAgICAgICAgICAgICB944CC5YWI55SoIHNuYXBzaG90VHJlZShudWxsLCB7IGxhYmVsOiAnJHtyZWZ9JyB9KSDmi43kuIDku73jgIJgLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZm91bmQgYXMgUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZWYgJiYgdHlwZW9mIHJlZiA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0cmVlID0gKHJlZiBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KS50cmVlIHx8IHJlZjtcbiAgICAgICAgICAgICAgICBpZiAodHJlZSAmJiB0eXBlb2YgdHJlZSA9PT0gJ29iamVjdCcgJiYgKHRyZWUgYXMgUmVjb3JkPHN0cmluZywgYW55Pikubm9kZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlZiBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgZGlmZlRyZWXvvJoke3NpZGV9IOaXouS4jeaYr+W/q+eFpyBsYWJlbO+8jOS5n+S4jeaYr+S4gOS7veW/q+eFp+Wvueixoe+8iOimgeaciSAudHJlZS5ub2RlcyDmiJYgLm5vZGVz77yJ44CCYCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3Qgc25hcEEgPSByZXNvbHZlU25hcChiZWZvcmUsICdiZWZvcmUnKTtcbiAgICAgICAgY29uc3Qgc25hcEIgPSByZXNvbHZlU25hcChhZnRlciwgJ2FmdGVyJyk7XG4gICAgICAgIGNvbnN0IG5vZGVzQSA9IChzbmFwQS50cmVlID8gc25hcEEudHJlZS5ub2RlcyA6IHNuYXBBLm5vZGVzKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICBjb25zdCBub2Rlc0IgPSAoc25hcEIudHJlZSA/IHNuYXBCLnRyZWUubm9kZXMgOiBzbmFwQi5ub2RlcykgYXMgUmVjb3JkPHN0cmluZywgYW55PjtcblxuICAgICAgICBjb25zdCBjaGFuZ2VkOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgICAgICAgY29uc3QgYWRkZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGNvbnN0IHJlbW92ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGxldCB1bmNoYW5nZWQgPSAwO1xuXG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKG5vZGVzQikpIHtcbiAgICAgICAgICAgIGlmICghKGtleSBpbiBub2Rlc0EpKSB7XG4gICAgICAgICAgICAgICAgYWRkZWQucHVzaChrZXkpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYSA9IG5vZGVzQVtrZXldIHx8IHt9O1xuICAgICAgICAgICAgY29uc3QgYiA9IG5vZGVzQltrZXldIHx8IHt9O1xuICAgICAgICAgICAgY29uc3QgcHJvcHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgICAgICBjb25zdCBrZXlzID0gbmV3IFNldDxzdHJpbmc+KFsuLi5PYmplY3Qua2V5cyhhKSwgLi4uT2JqZWN0LmtleXMoYildKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcHJvcCBvZiBrZXlzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYXYgPSBKU09OLnN0cmluZ2lmeShhW3Byb3BdKTtcbiAgICAgICAgICAgICAgICBjb25zdCBidiA9IEpTT04uc3RyaW5naWZ5KGJbcHJvcF0pO1xuICAgICAgICAgICAgICAgIGlmIChhdiAhPT0gYnYpIHByb3BzW3Byb3BdID0geyBmcm9tOiBhW3Byb3BdID09PSB1bmRlZmluZWQgPyBudWxsIDogYVtwcm9wXSwgdG86IGJbcHJvcF0gPT09IHVuZGVmaW5lZCA/IG51bGwgOiBiW3Byb3BdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoT2JqZWN0LmtleXMocHJvcHMpLmxlbmd0aCA+IDApIGNoYW5nZWQucHVzaCh7IHBhdGg6IGtleSwgcHJvcHMgfSk7XG4gICAgICAgICAgICBlbHNlIHVuY2hhbmdlZCArPSAxO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKG5vZGVzQSkpIGlmICghKGtleSBpbiBub2Rlc0IpKSByZW1vdmVkLnB1c2goa2V5KTtcblxuICAgICAgICBjb25zdCByZXBvcnQgPSB7XG4gICAgICAgICAgICBiZWZvcmU6IHNuYXBBLmxhYmVsIHx8ICcob2JqZWN0KScsXG4gICAgICAgICAgICBhZnRlcjogc25hcEIubGFiZWwgfHwgJyhvYmplY3QpJyxcbiAgICAgICAgICAgIGNvdW50czoge1xuICAgICAgICAgICAgICAgIGJlZm9yZU5vZGVzOiBPYmplY3Qua2V5cyhub2Rlc0EpLmxlbmd0aCxcbiAgICAgICAgICAgICAgICBhZnRlck5vZGVzOiBPYmplY3Qua2V5cyhub2Rlc0IpLmxlbmd0aCxcbiAgICAgICAgICAgICAgICBjaGFuZ2VkOiBjaGFuZ2VkLmxlbmd0aCxcbiAgICAgICAgICAgICAgICBhZGRlZDogYWRkZWQubGVuZ3RoLFxuICAgICAgICAgICAgICAgIHJlbW92ZWQ6IHJlbW92ZWQubGVuZ3RoLFxuICAgICAgICAgICAgICAgIHVuY2hhbmdlZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjaGFuZ2VkLFxuICAgICAgICAgICAgYWRkZWQsXG4gICAgICAgICAgICByZW1vdmVkLFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBzYXZlZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGxldCBzYXZlRXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHR5cGVvZiBvcHRzLnNhdmVUbyA9PT0gJ3N0cmluZycgJiYgb3B0cy5zYXZlVG8udHJpbSgpKSB7XG4gICAgICAgICAgICBjb25zdCB3cml0dGVuID0gd3JpdGVUZXh0RmlsZShvcHRzLnNhdmVUby50cmltKCksIEpTT04uc3RyaW5naWZ5KHJlcG9ydCwgbnVsbCwgMikpO1xuICAgICAgICAgICAgc2F2ZWQgPSB3cml0dGVuLnBhdGg7XG4gICAgICAgICAgICBzYXZlRXJyb3IgPSB3cml0dGVuLmVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc3VzcGVjdExlYWtzID0gYWRkZWQuZmlsdGVyKChwKSA9PiAvX198cHJvYmV8dG1wfHRlbXB8dGVzdC9pLnRlc3QocCkpO1xuICAgICAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKGNoYW5nZWQubGVuZ3RoID09PSAwICYmIGFkZGVkLmxlbmd0aCA9PT0gMCAmJiByZW1vdmVkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaCgn5Lik5Lu95b+r54Wn5LiA5qih5LiA5qC3IOKAlOKAlCDopoHkuYjnnJ/msqHmlLnliqjvvIzopoHkuYjmlLnlrowqKuayoeWtmOebmCoq77yI57yW6L6R5oCB5pS55LqG5LiN5a2Y77yM5Zy65pmv5pWw5o2u5bCx5piv5rKh5Y+Y77yJ44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN1c3BlY3RMZWFrcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgICAgIGDimqAg5paw5aKe6IqC54K56YeM5pyJICR7c3VzcGVjdExlYWtzLmxlbmd0aH0g5Liq5ZCN5a2X5YOP5Li05pe25o6i6ZKI77yIJHtzdXNwZWN0TGVha3Muc2xpY2UoMCwgNSkuam9pbignLCAnKX3vvInigJTigJQg56Gu6K6k5LiA5LiL5piv5LiN5piv5b+Y5LqG5Yig44CCYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0cnVuY2F0ZWQgPSBjaGFuZ2VkLmxlbmd0aCA+IGxpbWl0IHx8IGFkZGVkLmxlbmd0aCA+IGxpbWl0IHx8IHJlbW92ZWQubGVuZ3RoID4gbGltaXQ7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBiZWZvcmU6IHJlcG9ydC5iZWZvcmUsXG4gICAgICAgICAgICBhZnRlcjogcmVwb3J0LmFmdGVyLFxuICAgICAgICAgICAgY291bnRzOiByZXBvcnQuY291bnRzLFxuICAgICAgICAgICAgY2hhbmdlZDogY2hhbmdlZC5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgICAgICBhZGRlZDogYWRkZWQuc2xpY2UoMCwgbGltaXQpLFxuICAgICAgICAgICAgcmVtb3ZlZDogcmVtb3ZlZC5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgICAgICBzdXNwZWN0TGVha3MsXG4gICAgICAgICAgICB0cnVuY2F0ZWQsXG4gICAgICAgICAgICBzYXZlZCxcbiAgICAgICAgICAgIHNhdmVFcnJvcixcbiAgICAgICAgICAgIG5vdGU6IHRydW5jYXRlZCA/IGAke25vdGVzLmpvaW4oJyAnKX0g5q+P57G75Y+q5Zue5LqG5YmNICR7bGltaXR9IOadoe+8iOWujOaVtOaKpeWRiuingSBzYXZlVG/vvInjgIJgIDogbm90ZXMuam9pbignICcpLFxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICAvKiog5YiX5Ye65b2T5YmN5Y+v55So55qE5Yqp5omL5Ye95pWwIOKAlOKAlCDorqkgQUkg6Ieq5bex5Y+R546w6IO95Yqb77yM6ICM5LiN5piv6Z2gIHRvb2wg5paH5qGj56Gs6IOMICovXG4gICAgaGVscGVycy5oZWxwZXJOYW1lcyA9ICgpOiBzdHJpbmdbXSA9PiBPYmplY3Qua2V5cyhoZWxwZXJzKS5zb3J0KCk7XG4gICAgcmV0dXJuIHsgaGVscGVycywgc3RhdGUgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDmspnnrrHmiafooYxcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgU2NlbmVMb2dFbnRyeSB7XG4gICAgbGV2ZWw6IHN0cmluZztcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXRNczogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgUnVuQ29kZVBheWxvYWQge1xuICAgIGNvZGU/OiBzdHJpbmc7XG4gICAgYXJncz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRpbWVvdXRNcz86IG51bWJlcjtcbiAgICBtYXhMb2dzPzogbnVtYmVyO1xuICAgIG1heExvZ0xlbmd0aD86IG51bWJlcjtcbiAgICAvKiog5bel56iL5qC5IOKAlOKAlCDkuLvov5vnqIvvvIhlZGl0b3Ig5L6n77yJ57uZ55qE77yMYGxvYWRGcmFtZWAg6K+7IGAubWV0YWAg6KaB55So77yI6KeBIGBtYWtlSGVscGVyc2DvvInjgIIgKi9cbiAgICBwcm9qZWN0UGF0aD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gbWFrZUNhcHR1cmVkQ29uc29sZShcbiAgICBzaW5rOiBTY2VuZUxvZ0VudHJ5W10sXG4gICAgc3RhcnRlZEF0OiBudW1iZXIsXG4gICAgbWF4TG9nczogbnVtYmVyLFxuICAgIG1heExvZ0xlbmd0aDogbnVtYmVyLFxuKTogeyBjb25zb2xlOiBSZWNvcmQ8c3RyaW5nLCAoLi4ucGFydHM6IHVua25vd25bXSkgPT4gdm9pZD47IHdhc1RydW5jYXRlZDogKCkgPT4gYm9vbGVhbiB9IHtcbiAgICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgY29uc3Qgc3RyaW5naWZ5ID0gKHZhbHVlOiB1bmtub3duKTogc3RyaW5nID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAoX2ssIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnZnVuY3Rpb24nKSByZXR1cm4gYFtGdW5jdGlvbiAke3YubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnYmlnaW50JykgcmV0dXJuIGAke3Z9bmA7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2O1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgMCxcbiAgICAgICAgICAgICkgPz8gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgfVxuICAgIH07XG4gICAgY29uc3QgcHVzaCA9IChsZXZlbDogc3RyaW5nKSA9PiAoLi4ucGFydHM6IHVua25vd25bXSkgPT4ge1xuICAgICAgICBpZiAoc2luay5sZW5ndGggPj0gbWF4TG9ncykge1xuICAgICAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBsZXQgdGV4dCA9IHBhcnRzLm1hcChzdHJpbmdpZnkpLmpvaW4oJyAnKTtcbiAgICAgICAgaWYgKHRleHQubGVuZ3RoID4gbWF4TG9nTGVuZ3RoKSB0ZXh0ID0gYCR7dGV4dC5zbGljZSgwLCBtYXhMb2dMZW5ndGgpfeKApmA7XG4gICAgICAgIHNpbmsucHVzaCh7IGxldmVsLCB0ZXh0LCBhdE1zOiBEYXRlLm5vdygpIC0gc3RhcnRlZEF0IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY29uc29sZToge1xuICAgICAgICAgICAgbG9nOiBwdXNoKCdsb2cnKSxcbiAgICAgICAgICAgIGluZm86IHB1c2goJ2luZm8nKSxcbiAgICAgICAgICAgIHdhcm46IHB1c2goJ3dhcm4nKSxcbiAgICAgICAgICAgIGVycm9yOiBwdXNoKCdlcnJvcicpLFxuICAgICAgICAgICAgZGVidWc6IHB1c2goJ2RlYnVnJyksXG4gICAgICAgICAgICB0cmFjZTogcHVzaCgnZGVidWcnKSxcbiAgICAgICAgICAgIGRpcjogcHVzaCgnbG9nJyksXG4gICAgICAgIH0sXG4gICAgICAgIHdhc1RydW5jYXRlZDogKCkgPT4gdHJ1bmNhdGVkLFxuICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5Lik56eN5omn6KGM562W55WlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxubGV0IHZtTW9kdWxlOiBhbnkgPSBudWxsO1xubGV0IHZtVW5hdmFpbGFibGUgPSBmYWxzZTtcblxuLyoqIOaLvyBgdm1gIOaooeWdl++8m+W8leaTjui/m+eoi+mHjOaLv+S4jeWIsOWwsei/lOWbniBudWxs77yI6LCD55So5pa55Zue6JC95YiwIG5ldyBGdW5jdGlvbu+8iSAqL1xuZnVuY3Rpb24gZ2V0Vm1Nb2R1bGUoKTogYW55IHtcbiAgICBpZiAodm1Nb2R1bGUpIHJldHVybiB2bU1vZHVsZTtcbiAgICBpZiAodm1VbmF2YWlsYWJsZSkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbiAgICAgICAgY29uc3QgbW9kID0gcmVxdWlyZSgndm0nKTtcbiAgICAgICAgaWYgKG1vZCAmJiB0eXBlb2YgbW9kLnJ1bkluVGhpc0NvbnRleHQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHZtTW9kdWxlID0gbW9kO1xuICAgICAgICAgICAgcmV0dXJuIG1vZDtcbiAgICAgICAgfVxuICAgICAgICB2bVVuYXZhaWxhYmxlID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHZtVW5hdmFpbGFibGUgPSB0cnVlO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8qKlxuICog5rOo5YWl55So55qE5ZSv5LiA5YWo5bGA5ZCN44CCXG4gKlxuICog5Li65LuA5LmI5piv44CM5LiA5Liq5ZG95ZCN56m66Ze044CN6ICM5LiN5piv44CM5Y2B5Yeg5Liq6KO45YWo5bGA44CN77ya6KeBIHtAbGluayBidWlsZFNjZW5lU291cmNlfeOAglxuICovXG5jb25zdCBJTkpFQ1RfR0xPQkFMX0tFWSA9ICdfX2RzaFNjZW5lQ29udGV4dCc7XG5cbi8qKlxuICog5p6E6YCg5a6e6ZmF5omn6KGM55qE5rqQ56CB44CCXG4gKlxuICogIyMg5Li65LuA5LmI6KaB57uV6L+Z5LiA5LiLXG4gKlxuICogYHZtLnJ1bkluVGhpc0NvbnRleHRgIOeahOS7o+eggeeci+S4jeWIsOWxgOmDqOS9nOeUqOWfn++8iOi/meato+aYr+Wug+iDveeVmeWcqOWuv+S4uyByZWFsbSDnmoTljp/lm6DvvInvvIxcbiAqIOaJgOS7peWFqOWxgOmHj+W/hemhu+e7j+eUsSBgZ2xvYmFsVGhpc2Ag5Lyg6L+b5Y6744CC5pyA55u06KeJ55qE5YGa5rOV5piv5oqKIGBjY2AgLyBgY29uc29sZWAgLyBgZHVtcGAg4oCmXG4gKiDpgJDkuKrmjILliLAgYGdsb2JhbFRoaXNgIOS4iu+8jOS9humCo+agt+aciSoq5Lik5Liq55yf5a6e5Y2x5a6zKirvvJpcbiAqXG4gKiAxLiAqKumBruiUveWuv+S4u+iHquW3seeahOWFqOWxgCoq77ya5rOo5YWl5pyf6Ze0IGBnbG9iYWxUaGlzLmNvbnNvbGVgIOiiq+aNouaIkOaNleiOt+eJiO+8jFxuICogICAg5LqO5piv5byV5pOOL+e8lui+keWZqOiHquW3sei/meWHoOavq+enku+8iOeUmuiHs+W8guatpei2heaXtuWQjuiiq+aUvuW8g+S7o+eggei/mOa0u+edgOeahOWHoOWNgeenku+8iemHjOeahOaXpeW/l1xuICogICAg5YWo6KKr5ZCe6L+b5oiR5Lus55qE57yT5YayIOKAlOKAlCDnvJbovpHlmajmjqfliLblj7DkvJror6HlvILlnLDlronpnZnkuIvmnaXjgIJcbiAqICAgICrvvIjov5nkuKrlnZHlrp7mtYvouKnliLDov4fvvJrpqozor4HohJrmnKzot5HliLDkuIDljYrovpPlh7rmtojlpLHvvIzlsLHmmK/lroPjgILvvIkqXG4gKiAyLiAqKuimgei/mOWOn+WNgeWHoOS4quWQjeWtlyoq77yM5Lu75L2V5LiA5Liq5ZCN5a2X5Zyo5byV5pOO6YeM5piv5LiN5Y+v6YWN572u5bGe5oCn5bCx5Lya6L+Y5Y6f5aSx6LSl77yM6ZW/5pyf5rGh5p+T44CCXG4gKlxuICog5pS55oiQ5Y+q5rOo5YWl5LiA5LiqIGBfX2RzaFNjZW5lQ29udGV4dGDvvIzlho3lnKjljIXoo4Xlmajpobbpg6jmiorlroPnmoTlrZfmrrUqKuWPluaIkOWxgOmDqCBgbGV0YCDnu5HlrpoqKu+8mlxuICogLSBgZ2xvYmFsVGhpc2Ag5Y+q6KKr5Yqo5LiA5Liq5ZCN5a2X77yM6L+Y5Y6f5piv5Y6f5a2Q55qE44CB5Y+v5LulKirnq4vliLvlgZoqKu+8m1xuICogLSDnlKjmiLfku6PnoIHph4znmoQgYGNvbnNvbGUubG9nYCDotbDlsYDpg6jnu5HlrprvvIwqKuecn+ato+eahOWFqOWxgCBjb25zb2xlIOS7juacquiiq+eisOi/hyoq77ybXG4gKiAtIOWxgOmDqOe7keWumuWcqOW8guatpeWHveaVsOW8gOWktOWQjOatpeaxguWAvO+8jOaJgOS7peWNs+S9v+WQjumdoiBhd2FpdCDlvojkuYXvvIxcbiAqICAg6KKr5pS+5byD55qE5Luj56CB5Lmf5LuN54S25o+h552A6Ieq5bex55qE5byV55SoIOKAlOKAlCDov5jljp/kuI3kvJrmiorlroPlvITlnY/jgIJcbiAqXG4gKiDnlKggYGxldGAg6ICM5LiN5pivIGBjb25zdGDvvJrnlKjmiLfku6PnoIHph4znu5nov5nkupvlkI3lrZfph43mlrDotYvlgLzkuI3kvJrngrjjgIJcbiAqIOS7o+S7t+aYr+eUqOaIt+S7o+eggeS4jeiDveWGjeeUqCBgbGV0IGNjID0gLi4uYCDpga7olL3vvIjkvJrmiqXph43lpI3lo7DmmI7vvInigJTigJQg5LiOIGBuZXcgRnVuY3Rpb25gXG4gKiDkvKDlvaLlj4LnmoTml6flhpnms5XpmZDliLbkuIDoh7TvvIzlsZ7kuo7lj6/mjqXlj5fnmoTnuqblrprjgIJcbiAqXG4gKiDimqAg6KGM5Y+35YGP56e777ya55So5oi35Luj56CB5LuO56ysIDIg6KGM5byA5aeL77yM5omA5Lul5oql6ZSZ6KGM5Y+35q+U5rqQ56CB6KGM5Y+35aSnIDHjgIJcbiAqL1xuZnVuY3Rpb24gYnVpbGRTY2VuZVNvdXJjZShnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgY29kZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuYW1lcyA9IE9iamVjdC5rZXlzKGdsb2JhbHMpO1xuICAgIC8vIOazqOaEj++8mmBsZXRgIOWFs+mUruWtl+WPquiDveWHuueOsOS4gOasoeOAguWGmeaIkCBgbGV0IGEgPSAxLCBsZXQgYiA9IDJgIOS8muaKpVxuICAgIC8vIFwibGV0IGlzIGRpc2FsbG93ZWQgYXMgYSBsZXhpY2FsbHkgYm91bmQgbmFtZVwi77yI6Lip6L+H77yJ44CCXG4gICAgY29uc3QgZGVjbGFyYXRpb25zID0gYGxldCAke25hbWVzLm1hcCgobmFtZSkgPT4gYCR7bmFtZX0gPSBfX2RzaEN0eC4ke25hbWV9YCkuam9pbignLCAnKX1gO1xuICAgIHJldHVybiBgKGFzeW5jICgpID0+IHsgY29uc3QgX19kc2hDdHggPSBnbG9iYWxUaGlzLiR7SU5KRUNUX0dMT0JBTF9LRVl9OyAke2RlY2xhcmF0aW9uc307XFxuJHtjb2RlfVxcbn0pKCk7YDtcbn1cblxudHlwZSBGaW5pc2hGbiA9IChleHRyYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4vKiog562W55Wl5LiA77yaYHZtLnJ1bkluVGhpc0NvbnRleHRgIOKAlOKAlCDlkIwgcmVhbG0gKyDlkIzmraXotoXml7bvvIjpppbpgInvvIkgKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1blZpYVJ1bkluVGhpc0NvbnRleHQoXG4gICAgdm1Nb2Q6IGFueSxcbiAgICBnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4gICAgZmluaXNoOiBGaW5pc2hGbixcbiAgICBzdGF0ZTogeyBzbmFwc2hvdFJlcXVlc3RlZDogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHRhcmdldCA9IGdsb2JhbFRoaXMgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBoYWRQcmV2aW91cyA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChnbG9iYWxUaGlzLCBJTkpFQ1RfR0xPQkFMX0tFWSk7XG4gICAgY29uc3QgcHJldmlvdXNWYWx1ZSA9IGhhZFByZXZpb3VzID8gdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXSA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IHJlc3RvcmUgPSAoKTogdm9pZCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoaGFkUHJldmlvdXMpIHRhcmdldFtJTkpFQ1RfR0xPQkFMX0tFWV0gPSBwcmV2aW91c1ZhbHVlO1xuICAgICAgICAgICAgZWxzZSBkZWxldGUgdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDov5jljp/lpLHotKXkuI3oh7Tlkb3vvJrkuIvkuIDmrKHmiafooYzkvJrph43mlrDopobnm5YgKi9cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICAgIHRhcmdldFtJTkpFQ1RfR0xPQkFMX0tFWV0gPSBnbG9iYWxzO1xuICAgICAgICBjb25zdCByYXcgPSB2bU1vZC5ydW5JblRoaXNDb250ZXh0KGJ1aWxkU2NlbmVTb3VyY2UoZ2xvYmFscywgY29kZSksIHtcbiAgICAgICAgICAgIGZpbGVuYW1lOiAnZHNoLXNjZW5lLWNvZGUuanMnLFxuICAgICAgICAgICAgdGltZW91dDogdGltZW91dE1zLFxuICAgICAgICAgICAgZGlzcGxheUVycm9yczogdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8g5ZCM5q2l5q615bey57uP6LeR5a6M77yI55So5oi35Luj56CB5byA5aS055qEIGxldCDnu5Hlrprlt7Lnu4/msYLlgLzvvInvvIxcbiAgICAgICAgLy8g5omA5Lul6L+Z6YeM5Y+v5Lul56uL5Yi76L+Y5Y6fIOKAlOKAlCDlkI7pnaLnmoTlvILmraXmrrXmjIHmnInnmoTmmK/oh6rlt7HnmoTlsYDpg6jlvJXnlKjvvIzkuI3lj5flvbHlk43jgIJcbiAgICAgICAgcmVzdG9yZSgpO1xuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICBQcm9taXNlLnJlc29sdmUocmF3KSxcbiAgICAgICAgICAgIG5ldyBQcm9taXNlKChfcmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdCh0aW1lb3V0RXJyb3IodGltZW91dE1zKSksIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogdHJ1ZSwgcmVzdWx0LCBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goe1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9ySW5mbyhlcnIpLFxuICAgICAgICAgICAgdGltZWRPdXQ6IGlzVGltZW91dChlcnIpLFxuICAgICAgICAgICAgc25hcHNob3RSZXF1ZXN0ZWQ6IHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkLFxuICAgICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHJlc3RvcmUoKTtcbiAgICB9XG59XG5cbi8qKlxuICog562W55Wl5LqM77yaYG5ldyBGdW5jdGlvbmAg4oCU4oCUIOWFnOW6leOAglxuICpcbiAqIOWFqOWxgOmHj+i1sCoq5pi+5byP5b2i5Y+CKirvvIzkuI3norAgYGdsb2JhbFRoaXNg77yM5Lu75L2VIEpTIOeOr+Wig+mDveiDveeUqOOAglxuICog5Luj5Lu377yaYHRpbWVvdXRgIOWPqueUseWkluWxguiuoeaXtuWZqOWunueOsO+8jCoq5o6Q5LiN5pat5ZCM5q2l5q275b6q546vKirjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuVmlhTmV3RnVuY3Rpb24oXG4gICAgZ2xvYmFsczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgY29kZTogc3RyaW5nLFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuICAgIGZpbmlzaDogRmluaXNoRm4sXG4gICAgc3RhdGU6IHsgc25hcHNob3RSZXF1ZXN0ZWQ6IGJvb2xlYW4gfSxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBuYW1lcyA9IE9iamVjdC5rZXlzKGdsb2JhbHMpO1xuICAgIGNvbnN0IHZhbHVlcyA9IG5hbWVzLm1hcCgobikgPT4gZ2xvYmFsc1tuXSk7XG5cbiAgICBsZXQgZm46ICguLi5mbkFyZ3M6IHVua25vd25bXSkgPT4gdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgICBmbiA9IG5ldyBGdW5jdGlvbiguLi5uYW1lcywgYHJldHVybiAoYXN5bmMgKCkgPT4ge1xcbiR7Y29kZX1cXG59KSgpO2ApIGFzIHR5cGVvZiBmbjtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH0pO1xuICAgIH1cblxuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShmbiguLi52YWx1ZXMpKSxcbiAgICAgICAgICAgIG5ldyBQcm9taXNlKChfcmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdCh0aW1lb3V0RXJyb3IodGltZW91dE1zKSksIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogdHJ1ZSwgcmVzdWx0LCBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goe1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9ySW5mbyhlcnIpLFxuICAgICAgICAgICAgdGltZWRPdXQ6IGlzVGltZW91dChlcnIpLFxuICAgICAgICAgICAgc25hcHNob3RSZXF1ZXN0ZWQ6IHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkLFxuICAgICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlU2NlbmVDb2RlKFxuICAgIHBheWxvYWQ6IFJ1bkNvZGVQYXlsb2FkLFxuICAgIGRlcHRoID0gMCxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGxvZ3M6IFNjZW5lTG9nRW50cnlbXSA9IFtdO1xuICAgIGNvbnN0IGNvZGUgPSB0eXBlb2YgcGF5bG9hZC5jb2RlID09PSAnc3RyaW5nJyA/IHBheWxvYWQuY29kZSA6ICcnO1xuICAgIGNvbnN0IG1heExvZ3MgPSB0eXBlb2YgcGF5bG9hZC5tYXhMb2dzID09PSAnbnVtYmVyJyA/IHBheWxvYWQubWF4TG9ncyA6IDIwMDtcbiAgICBjb25zdCBtYXhMb2dMZW5ndGggPSB0eXBlb2YgcGF5bG9hZC5tYXhMb2dMZW5ndGggPT09ICdudW1iZXInID8gcGF5bG9hZC5tYXhMb2dMZW5ndGggOiA0MDAwO1xuICAgIGNvbnN0IHRpbWVvdXRNcyA9IHR5cGVvZiBwYXlsb2FkLnRpbWVvdXRNcyA9PT0gJ251bWJlcicgPyBwYXlsb2FkLnRpbWVvdXRNcyA6IDE1MDAwO1xuXG4gICAgY29uc3QgeyBjb25zb2xlOiBjYXB0dXJlZENvbnNvbGUsIHdhc1RydW5jYXRlZCB9ID0gbWFrZUNhcHR1cmVkQ29uc29sZShcbiAgICAgICAgbG9ncyxcbiAgICAgICAgc3RhcnRlZEF0LFxuICAgICAgICBtYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGgsXG4gICAgKTtcblxuICAgIGNvbnN0IGZpbmlzaCA9IChleHRyYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoe1xuICAgICAgICBsb2dzLFxuICAgICAgICBsb2dzVHJ1bmNhdGVkOiB3YXNUcnVuY2F0ZWQoKSxcbiAgICAgICAgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdCxcbiAgICAgICAgLi4uZXh0cmEsXG4gICAgfSk7XG5cbiAgICBpZiAoIWNvZGUudHJpbSgpKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogZmFsc2UsIGVycm9yOiB7IG5hbWU6ICdFcnJvcicsIG1lc3NhZ2U6ICdjb2RlIOS4jeiDveS4uuepuicgfSB9KTtcbiAgICB9XG5cbiAgICBsZXQgY2M6IGFueTtcbiAgICB0cnkge1xuICAgICAgICBjYyA9IGdldENjKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogZmFsc2UsIGVycm9yOiBlcnJvckluZm8oZXJyKSB9KTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGhlbHBlcnMsIHN0YXRlIH0gPSBtYWtlSGVscGVycyhjYywgeyBwcm9qZWN0UGF0aDogcGF5bG9hZC5wcm9qZWN0UGF0aCB9KTtcbiAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG5cbiAgICAvLyByZWNpcGUg5LqU5Lu25aWXIOKAlOKAlCDkuI4gZWRpdG9yIOS4iuS4i+aWhyoq5ZCM5LiA5Lu95a6e546wKirvvIjot6jov5vnqIsgcmVxdWlyZSBkaXN0L2NvcmUvcmVjaXBlcy5qc++8ieOAglxuICAgIC8vIOWKoOi9veWksei0peS4jeiuqeaVtOS4qiBleGVjdXRlX2NvZGUg5oyC5o6J77yM6ICM5piv6ZmN57qn5oiQ44CM5LqU5Liq6YO96L+U5Zue6ZSZ6K+v44CN44CCXG4gICAgbGV0IHJlY2lwZUhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlY2lwZXMgPSBnZXRSZWNpcGVzTW9kdWxlKCk7XG4gICAgICAgIHJlY2lwZUhlbHBlcnMgPSByZWNpcGVzLmJ1aWxkUmVjaXBlSGVscGVycyh7XG4gICAgICAgICAgICBwcm9qZWN0UGF0aDogY3VycmVudFByb2plY3RQYXRoKCksXG4gICAgICAgICAgICBjb250ZXh0OiAnc2NlbmUnLFxuICAgICAgICAgICAgZGVmYXVsdFRpbWVvdXRNczogdGltZW91dE1zLFxuICAgICAgICAgICAgLy8g5oOw5oCn5ou/5omn6KGM5Zmo77yacmVjaXBlIOWKqeaJi+imgeiDvVwi6LeR5LiA5q615Luj56CBXCLvvIzogIzpgqPmrrXku6PnoIHlj4jpnIDopoHlkIzmoLfnmoTlhajlsYDph49cbiAgICAgICAgICAgIC8vIO+8iOWMheaLrCByZWNpcGUg5Yqp5omL6Ieq5bex77yJ4oCU4oCUIOS6kuebuOW8leeUqO+8jOW/hemhu+aZmue7keWumuOAglxuICAgICAgICAgICAgZ2V0UnVubmVyOiAoKSA9PiBhc3luYyAoXG4gICAgICAgICAgICAgICAgcmVjaXBlQ29kZTogc3RyaW5nLFxuICAgICAgICAgICAgICAgIHJlY2lwZUFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICAgICAgICAgIG5lc3RlZFRpbWVvdXRNczogbnVtYmVyLFxuICAgICAgICAgICAgKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmVzdGVkID0gYXdhaXQgZXhlY3V0ZVNjZW5lQ29kZShcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29kZTogcmVjaXBlQ29kZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3M6IHJlY2lwZUFyZ3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyDltYzlpZfmiafooYzkuI7mnKzmrKHmiafooYwqKuWFseS6q+WkluWxgiB2bSDnmoTlkIzmraXotoXml7bpooTnrpcqKu+8iOWkluWxgiB3YXRjaGRvZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8g5bey57uP5Zyo6K6h5pe25LqG77yJ77yM5omA5Lul5LiN5YWB6K645a2QIHJlY2lwZSDmiorotoXml7borr7lvpfmr5TlpJblsYLov5jplb8g4oCU4oCUXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyDlkKbliJnmiqXlh7rmnaXnmoTmmK/lpJblsYLnmoTotoXml7bvvIzmjpLmn6Xml7bkuIDohLjpl67lj7fjgIJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRpbWVvdXRNczogTWF0aC5taW4obmVzdGVkVGltZW91dE1zLCB0aW1lb3V0TXMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWF4TG9ncyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heExvZ0xlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgZGVwdGggKyAxLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgLy8gcmVjaXBlIOmHjOiwgyBzbmFwc2hvdCgpIOS5n+imgeiDveeZu+iusOWIsOacrOasoeaJp+ihjOeahOaSpOmUgOW/q+eFp+S4ilxuICAgICAgICAgICAgICAgIGlmIChuZXN0ZWQuc25hcHNob3RSZXF1ZXN0ZWQpIHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXN0ZWRMb2dzID0gQXJyYXkuaXNBcnJheShuZXN0ZWQubG9ncykgPyAobmVzdGVkLmxvZ3MgYXMgU2NlbmVMb2dFbnRyeVtdKSA6IFtdO1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIG9rOiBCb29sZWFuKG5lc3RlZC5vayksXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdDogbmVzdGVkLnJlc3VsdCxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IG5lc3RlZC5lcnJvcixcbiAgICAgICAgICAgICAgICAgICAgbG9nczpcbiAgICAgICAgICAgICAgICAgICAgICAgIG5lc3RlZExvZ3MubGVuZ3RoID4gMFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gbmVzdGVkTG9ncy5tYXAoKGVudHJ5KSA9PiBgWyR7ZW50cnkubGV2ZWx9XSAke2VudHJ5LnRleHR9YClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgZHVyYXRpb25NczogdHlwZW9mIG5lc3RlZC5kdXJhdGlvbk1zID09PSAnbnVtYmVyJyA/IG5lc3RlZC5kdXJhdGlvbk1zIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICB0aW1lZE91dDogQm9vbGVhbihuZXN0ZWQudGltZWRPdXQpLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9LFxuICAgICAgICB9KS5oZWxwZXJzO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JJbmZvKGVycikubWVzc2FnZTtcbiAgICAgICAgY29uc3QgZmFpbCA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoeyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH0pO1xuICAgICAgICByZWNpcGVIZWxwZXJzID0ge1xuICAgICAgICAgICAgZmluZFJlY2lwZXM6IGZhaWwsXG4gICAgICAgICAgICByZWFkUmVjaXBlOiBmYWlsLFxuICAgICAgICAgICAgc2F2ZVJlY2lwZTogZmFpbCxcbiAgICAgICAgICAgIHJ1blJlY2lwZTogZmFpbCxcbiAgICAgICAgICAgIGRlbGV0ZVJlY2lwZTogZmFpbCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgY2MsXG4gICAgICAgIGNvY29zOiBjYyxcbiAgICAgICAgRWRpdG9yLFxuICAgICAgICBkaXJlY3RvcjogY2MuZGlyZWN0b3IsXG4gICAgICAgIHNjZW5lLFxuICAgICAgICBqczogY2MuanMsXG4gICAgICAgIGZpbmQ6IGNjLmZpbmQsXG4gICAgICAgIGFyZ3M6IHBheWxvYWQuYXJncyAmJiB0eXBlb2YgcGF5bG9hZC5hcmdzID09PSAnb2JqZWN0JyA/IHBheWxvYWQuYXJncyA6IHt9LFxuICAgICAgICBjb25zb2xlOiBjYXB0dXJlZENvbnNvbGUsXG4gICAgICAgIC4uLmhlbHBlcnMsXG4gICAgICAgIC4uLnJlY2lwZUhlbHBlcnMsXG4gICAgfTtcblxuICAgIC8vIOmmlumAiSB2bS5ydW5JblRoaXNDb250ZXh077yI5ZCMIHJlYWxtICsg5ZCM5q2l6LaF5pe277yJ77yb5byV5pOO6L+b56iL6YeM5ou/5LiN5YiwIHZtIOaJjeWbnuiQveOAglxuICAgIC8vIOS4pOadoei3r+W+hOWvueeUqOaIt+S7o+eggeeahOWGmeazleimgeaxguWujOWFqOS4gOiHtOOAglxuICAgIGNvbnN0IHZtTW9kID0gZ2V0Vm1Nb2R1bGUoKTtcbiAgICBpZiAodm1Nb2QpIHtcbiAgICAgICAgcmV0dXJuIHJ1blZpYVJ1bkluVGhpc0NvbnRleHQodm1Nb2QsIGdsb2JhbHMsIGNvZGUsIHRpbWVvdXRNcywgZmluaXNoLCBzdGF0ZSk7XG4gICAgfVxuICAgIHJldHVybiBydW5WaWFOZXdGdW5jdGlvbihnbG9iYWxzLCBjb2RlLCB0aW1lb3V0TXMsIGZpbmlzaCwgc3RhdGUpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFQSSDmj4/ov7DvvIhkaXNjb3ZlciDnmoTkuIDljYrvvIlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgRGVzY3JpYmVBcGlQYXlsb2FkIHtcbiAgICB0YXJnZXQ/OiBzdHJpbmc7XG4gICAgbm9kZVV1aWQ/OiBzdHJpbmc7XG4gICAgbGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKiDnlJ/miJDmn5DkuKrnsbvnmoTjgIxUUyDpo47moLzlrprkuYnjgI3vvIzluKblrp7ml7blgLwgKi9cbmZ1bmN0aW9uIGRlc2NyaWJlQ2xhc3MoY2M6IGFueSwgQ2xzOiBhbnksIGluc3RhbmNlOiBhbnksIGNsYXNzTmFtZTogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBwcm9wcyA9IGNvbXBvbmVudFByb3BOYW1lcyhpbnN0YW5jZSB8fCB7IGNvbnN0cnVjdG9yOiBDbHMgfSk7XG4gICAgbGV0IHBhcmVudE5hbWUgPSAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJlbnQgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoQ2xzLnByb3RvdHlwZSk7XG4gICAgICAgIGlmIChwYXJlbnQgJiYgcGFyZW50LmNvbnN0cnVjdG9yICYmIHBhcmVudC5jb25zdHJ1Y3Rvci5uYW1lKSB7XG4gICAgICAgICAgICBwYXJlbnROYW1lID0gcGFyZW50LmNvbnN0cnVjdG9yLm5hbWU7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcGFyZW50TmFtZSA9ICcnO1xuICAgIH1cblxuICAgIGxpbmVzLnB1c2goYC8vICR7Y2xhc3NOYW1lfSR7cGFyZW50TmFtZSA/IGAgIGV4dGVuZHMgJHtwYXJlbnROYW1lfWAgOiAnJ31gKTtcbiAgICBpZiAoaW5zdGFuY2UpIHtcbiAgICAgICAgbGluZXMucHVzaChgLy8g5p2l6Ieq5a6e5pe25a6e5L6L77yI6IqC54K5ICR7aW5zdGFuY2Uubm9kZSA/IGluc3RhbmNlLm5vZGUubmFtZSA6ICc/J33vvIlgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsaW5lcy5wdXNoKCcvLyDmnKrmj5Dkvpsgbm9kZVV1aWTvvIzml6Dlrp7ml7blgLzvvJvlsZ7mgKflkI3lj5boh6rnsbvlo7DmmI4nKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChgZXhwb3J0IGNsYXNzICR7Y2xhc3NOYW1lLnNwbGl0KCcuJykucG9wKCl9IHtgKTtcblxuICAgIGNvbnN0IHNob3duID0gcHJvcHMuc2xpY2UoMCwgbGltaXQpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIHNob3duKSB7XG4gICAgICAgIGxldCB0eXBlTmFtZSA9ICdhbnknO1xuICAgICAgICBsZXQgY3VycmVudCA9ICcnO1xuICAgICAgICBpZiAoaW5zdGFuY2UpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlYWQgPSBzYWZlUmVhZChpbnN0YW5jZSwga2V5KTtcbiAgICAgICAgICAgIGlmIChyZWFkLm9rKSB7XG4gICAgICAgICAgICAgICAgdHlwZU5hbWUgPSBpbmZlclRzVHlwZShyZWFkLnZhbHVlKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50ID0gKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdiA9IHJlYWQudmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICh2ID09PSBudWxsIHx8IHYgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFN0cmluZyh2KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ1tvYmplY3RdJztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gU3RyaW5nKHYpO1xuICAgICAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnQubGVuZ3RoID4gNjApIGN1cnJlbnQgPSBgJHtjdXJyZW50LnNsaWNlKDAsIDYwKX3igKZgO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGxpbmVzLnB1c2goYCAgICAke2tleX06ICR7dHlwZU5hbWV9OyR7Y3VycmVudCA/IGAgIC8vIOW9k+WJjSA9ICR7Y3VycmVudH1gIDogJyd9YCk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5sZW5ndGggPiBzaG93bi5sZW5ndGgpIHtcbiAgICAgICAgbGluZXMucHVzaChgICAgIC8vIOKApuWPpuaciSAke3Byb3BzLmxlbmd0aCAtIHNob3duLmxlbmd0aH0g5Liq5bGe5oCnYCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goJ30nKTtcblxuICAgIC8vIOWOn+Wei+aWueazle+8muWRiuiviSBBSeOAjOi/meS4que7hOS7tuiDveiwg+S7gOS5iOOAjVxuICAgIGNvbnN0IG1ldGhvZHM6IHN0cmluZ1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKENscy5wcm90b3R5cGUpKSB7XG4gICAgICAgICAgICBpZiAobmFtZSA9PT0gJ2NvbnN0cnVjdG9yJyB8fCBwcm9wcy5pbmNsdWRlcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgICAgICBsZXQgaXNGbiA9IGZhbHNlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpc0ZuID0gdHlwZW9mIENscy5wcm90b3R5cGVbbmFtZV0gPT09ICdmdW5jdGlvbic7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpc0ZuID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNGbikgbWV0aG9kcy5wdXNoKG5hbWUpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICBpZiAobWV0aG9kcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goJycpO1xuICAgICAgICBsaW5lcy5wdXNoKGAvLyDlj6/osIPnlKjmlrnms5XvvIjliY0gJHtNYXRoLm1pbig2MCwgbWV0aG9kcy5sZW5ndGgpfSDkuKrvvInvvJpgKTtcbiAgICAgICAgbGluZXMucHVzaChgLy8gJHttZXRob2RzLnNsaWNlKDAsIDYwKS5qb2luKCcsICcpfWApO1xuICAgIH1cbiAgICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8qKiBgY2NgIOaooeWdl+eahOmhtuWxguWvvOWHuua4heWNle+8iOWkp+WGmeW8gOWktOaIluWHveaVsO+8jOWkn+eUqOadpeW9k+e0ouW8leeUqO+8iSAqL1xuZnVuY3Rpb24gbGlzdENjRXhwb3J0cyhjYzogYW55LCBsaW1pdDogbnVtYmVyKTogeyB0b3RhbDogbnVtYmVyOyBuYW1lczogc3RyaW5nW10gfSB7XG4gICAgY29uc3QgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2MpKSB7XG4gICAgICAgICAgICBpZiAoL15bQS1aXS8udGVzdChrZXkpIHx8IHR5cGVvZiBjY1trZXldID09PSAnZnVuY3Rpb24nKSBuYW1lcy5wdXNoKGtleSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955WlICovXG4gICAgfVxuICAgIHJldHVybiB7IHRvdGFsOiBuYW1lcy5sZW5ndGgsIG5hbWVzOiBuYW1lcy5zbGljZSgwLCBsaW1pdCkgfTtcbn1cblxuLyoqIOWcuuaZr+S+p+aAu+iniOi9veiNt++8iOaXoCB0YXJnZXQg5LiOIHRhcmdldD09PSdjYycg5YWx55So77yJICovXG5mdW5jdGlvbiBidWlsZFNjZW5lSW5kZXgoY2M6IGFueSwgbGltaXQ6IG51bWJlciwgd2l0aEhpbnQ6IGJvb2xlYW4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgZXhwb3J0cyA9IGxpc3RDY0V4cG9ydHMoY2MsIGxpbWl0KTtcbiAgICBjb25zdCB7IGhlbHBlcnMgfSA9IG1ha2VIZWxwZXJzKGNjKTtcblxuICAgIGxldCByZWNpcGVIZWxwZXJOYW1lczogc3RyaW5nW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICByZWNpcGVIZWxwZXJOYW1lcyA9IChnZXRSZWNpcGVzTW9kdWxlKCkuUkVDSVBFX0hFTFBFUl9TSUdOQVRVUkVTIGFzIHN0cmluZ1tdKS5tYXAoKHNpZ25hdHVyZSkgPT5cbiAgICAgICAgICAgIHNpZ25hdHVyZS5zbGljZSgwLCBzaWduYXR1cmUuaW5kZXhPZignKCcpKSxcbiAgICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmVjaXBlSGVscGVyTmFtZXMgPSBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGtpbmQ6ICdpbmRleCcsXG4gICAgICAgIGhlbHBlckZ1bmN0aW9uczogT2JqZWN0LmtleXMoaGVscGVycykuc29ydCgpLFxuICAgICAgICByZWNpcGVIZWxwZXJGdW5jdGlvbnM6IHJlY2lwZUhlbHBlck5hbWVzLFxuICAgICAgICByZWNpcGVEaXI6IHJlY2lwZXNSb290SGludCgpLFxuICAgICAgICBjY0V4cG9ydENvdW50OiBleHBvcnRzLnRvdGFsLFxuICAgICAgICBjY0V4cG9ydHM6IGV4cG9ydHMubmFtZXMsXG4gICAgfTtcbiAgICBpZiAod2l0aEhpbnQpIHtcbiAgICAgICAgcGF5bG9hZC5oaW50ID1cbiAgICAgICAgICAgICfnlKggZGVzY3JpYmVfYXBpKHsgY29udGV4dDpcInNjZW5lXCIsIHRhcmdldDpcImNjLkNhbWVyYVwiIH0pIOeci+afkOS4quexu+eahOWumuS5ie+8mycgK1xuICAgICAgICAgICAgJ+W4piBub2RlVXVpZCDliJnnlKjoioLngrnkuIrnmoTlrp7ml7blrp7kvovooaXlh7rnnJ/lrp7nsbvlnovkuI7lvZPliY3lgLzjgIInICtcbiAgICAgICAgICAgICdkZXNjcmliZV9hcGkoeyBjb250ZXh0Olwic2NlbmVcIiwgdGFyZ2V0OlwiaGVscGVyc1wiIH0pIOeci+WFqOmDqOWKqeaJi+WHveaVsOetvuWQjeOAgic7XG4gICAgfVxuICAgIHJldHVybiBwYXlsb2FkO1xufVxuXG5mdW5jdGlvbiBkZXNjcmliZVNjZW5lQXBpKGNjOiBhbnksIHBheWxvYWQ6IERlc2NyaWJlQXBpUGF5bG9hZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCB0YXJnZXQgPSB0eXBlb2YgcGF5bG9hZC50YXJnZXQgPT09ICdzdHJpbmcnID8gcGF5bG9hZC50YXJnZXQudHJpbSgpIDogJyc7XG4gICAgY29uc3QgbGltaXQgPSB0eXBlb2YgcGF5bG9hZC5saW1pdCA9PT0gJ251bWJlcicgPyBNYXRoLm1heCgxLCBNYXRoLm1pbig1MDAsIHBheWxvYWQubGltaXQpKSA6IDgwO1xuXG4gICAgLy8gMSkg5rKh5pyJIHRhcmdldO+8mue7meWHuuOAjOi1t+aJi+W8j+OAjea4heWNlSArIGNjIOaooeWdl+eahOmhtuWxguWFpeWPo1xuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgIHJldHVybiBidWlsZFNjZW5lSW5kZXgoY2MsIGxpbWl0LCB0cnVlKTtcbiAgICB9XG5cbiAgICAvLyAyKSDmmL7lvI/pl67liqnmiYvlh73mlbBcbiAgICBpZiAodGFyZ2V0ID09PSAnaGVscGVycycgfHwgdGFyZ2V0ID09PSAnaGVscGVyJykge1xuICAgICAgICBjb25zdCB7IGhlbHBlcnMgfSA9IG1ha2VIZWxwZXJzKGNjKTtcbiAgICAgICAgY29uc3QgZG9jczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgICAgIG5vZGVCeVV1aWQ6ICdub2RlQnlVdWlkKHV1aWQpIOKGkiBOb2RlIHwgbnVsbCcsXG4gICAgICAgICAgICBub2RlQnlQYXRoOiBcIm5vZGVCeVBhdGgoJ0NhbnZhcy9QYW5lbCcpIOKGkiBOb2RlIHwgbnVsbCAgLy8g6K6k5b6X5ZCN5a2X6YeM5ZCrICcvJyDnmoToioLngrlcIixcbiAgICAgICAgICAgIGVhY2hOb2RlOiAnZWFjaE5vZGUodmlzaXQsIHJvb3Q/LCB7aW5jbHVkZUVkaXRvcn0/KSDihpIgdm9pZCAgLy8g6buY6K6k6Lez6L+H57yW6L6R5ZmoIGdpem1vJyxcbiAgICAgICAgICAgIGNvbnRlbnRDaGlsZHJlbjogJ2NvbnRlbnRDaGlsZHJlbihub2RlPykg4oaSIE5vZGVbXSAgLy8g55yf5a6e5YaF5a655a2Q6IqC54K577yI5bey5ruk5o6J57yW6L6R5Zmo6KOF6aWw77yJJyxcbiAgICAgICAgICAgIGlzRWRpdG9yTm9kZTogJ2lzRWRpdG9yTm9kZShub2RlKSDihpIgYm9vbGVhbiAgLy8g5piv5LiN5piv57yW6L6R5Zmo6Ieq5bex55qEIGdpem1vL+e9keagvC/lj4LogIPlm74nLFxuICAgICAgICAgICAgdHJlZTogJ3RyZWUoeyByb290PywgbWF4RGVwdGg/LCB3aXRoQ29tcG9uZW50cz8sIGluY2x1ZGVFZGl0b3I/IH0pIOKGkiDlsYLnuqfpqqjmnrblr7nosaEnLFxuICAgICAgICAgICAgZHVtcDogJ2R1bXAobm9kZU9yQ29tcG9uZW50KSDihpIg5pi+5byP5Y+W5a2X5q615ZCO55qE57qv5pWw5o2u5a+56LGhJyxcbiAgICAgICAgICAgIHNuYXBzaG90OiAnc25hcHNob3QoKSDihpIgdm9pZCAgLy8g5qCH6K6w5pys5qyh5omn6KGM6KaB5rOo5YaM5pKk6ZSA5b+r54WnJyxcbiAgICAgICAgICAgIHNsZWVwOiAnc2xlZXAobXMpIOKGkiBQcm9taXNlICAvLyDova7or6LnrYnlvoUnLFxuICAgICAgICAgICAgY2FwdHVyZVZpZXc6XG4gICAgICAgICAgICAgICAgXCJjYXB0dXJlVmlldyh7IHNhdmVQYXRoPywgbWF4V2lkdGg/LCBmb3JtYXQ/LCBxdWFsaXR5Pywgd2FpdE1zPyB9KSDihpIgUHJvbWlzZTx7b2ssIHBhdGg/LCBjaHVua3M/LCB3aWR0aCwgaGVpZ2h0LCBieXRlcywgYmxhbmtSYXRpb30+ICAvLyDmiKrlnLrmma/op4blm77lvZPliY3kuIDluKfvvIjlkKvnvZHmoLwvZ2l6bW/vvInlrZjmiJAgcG5nL2pwZWdcIixcbiAgICAgICAgICAgIGxvYWRGcmFtZTpcbiAgICAgICAgICAgICAgICBcImxvYWRGcmFtZSgnZGI6Ly9hc3NldHMvLi4uL3gucG5nJyB8ICc8dXVpZD5AZjk5NDEnIHwgJzx1dWlkPicpIOKGkiBQcm9taXNlPFNwcml0ZUZyYW1lPiAgLy8g5Y+W5Zu+54mH55qEIFNwcml0ZUZyYW1l77yb5Yir5YaN5omL5pCTIEBmOTk0Me+8jOS5n+WIq+eUqCBjYy5yZXNvdXJjZXMubG9hZO+8iOe8lui+keWZqOWcuuaZr+mHjOW/heWksei0pe+8iVwiLFxuICAgICAgICAgICAgd29ybGRSZWN0OlxuICAgICAgICAgICAgICAgICd3b3JsZFJlY3Qobm9kZSwgeyByb290PyB9KSDihpIge2N4LCBjeSwgd2lkdGgsIGhlaWdodCwgbGVmdCwgcmlnaHQsIGJvdHRvbSwgdG9wfSAgLy8g57yW6L6R5oCB5Y+v5L+h55qE5LiW55WM55+p5b2i77yIcG9zaXRpb24rYW5jaG9yK2NvbnRlbnRTaXplIOiHqua0vee0r+WKoO+8ie+8m+WIq+eUqCBnZXRCb3VuZGluZ0JveFRvV29ybGQnLFxuICAgICAgICAgICAgY29udGVudEJvdW5kczpcbiAgICAgICAgICAgICAgICAnY29udGVudEJvdW5kcygpIOKGkiB7bGVmdCwgcmlnaHQsIGJvdHRvbSwgdG9wLCBjeCwgY3ksIHdpZHRoLCBoZWlnaHQsIGNvdW50LCB1dWlkc30gIC8vIOWcuuaZryoq55yf5a6e5YaF5a65KirnmoTkuJbnlYzljIXlm7Tnm5LvvIjlt7Lmu6TmjonnvJbovpHlmaggZ2l6bW8v572R5qC877yJ77yb5oiq5Zu+5Y+W5pmv6YeP55qE5bCx5piv5a6DJyxcbiAgICAgICAgICAgIHBpY2s6IFwicGljayh4LCB5LCB7IHNwYWNlPywgcm9vdD8sIGxpbWl0PyB9KSDihpIgeyB2ZXJkaWN0LCBoaXRzW10sIGhpdCwgaW52aXNpYmxlW10sIGVkaXRvckhpdHNbXSwgd29ybGQsIHBhZ2VDc3MgfSAgLy8gKirkuIDkuKrlsY/luZXngrnkuIrmmK/lk6rkuKroioLngrkqKuOAgnNwYWNlOiAndmlldyfvvIjpobXpnaJDU1Plg4/ntKDvvIzpu5jorqTvvIkvJ3V2J++8iDB+Me+8jOaIquWbvue8qei/h+WwseeUqOWug++8iS8nd29ybGQn44CCdmVyZGljdD0nZWRpdG9yLW92ZXJsYXknID0g6YKj6YeM5rKh5pyJ5Lu75L2V5YaF5a656IqC54K544CB5piv57yW6L6R5ZmoIGdpem1vIOKAlOKAlCDmiKrlm77ph4zpgqPkuJzopb/kuI3lnKjlnLrmma/mlbDmja7ph4zvvIzliKvljrvoioLngrnmoJHmib5cIixcbiAgICAgICAgICAgIGxhYmVsRml0OlxuICAgICAgICAgICAgICAgICdsYWJlbEZpdChub2RlIHwge3RleHQsZm9udFNpemUsd2lkdGgsaGVpZ2h0LGxpbmVIZWlnaHQsb3ZlcmZsb3csd3JhcH0sIG92ZXJyaWRlPykg4oaSIHsgZml0cywgbGluZUNvdW50LCBtYXhMaW5lc0ZpdCwgY2xpcHBlZFRleHQsIG92ZXJmbG93WCwgc2hvcnRmYWxsUHgsIG1ldGhvZCwgZm9ybXVsYSB9ICAvLyAqKui/meS4qiBMYWJlbCDkvJrkuI3kvJroo4HlrZcqKuOAguesrOS6jOWPguimhuebluS7u+aEj+Wtl+autSA9IOmXruWPjeS6i+Wunu+8iGxhYmVsRml0KG4sIHtoZWlnaHQ6NzJ9Ke+8ie+8jCoq6Zu25Ymv5L2c55SoKirvvIzliKvpnaDmlLnnnJ/oioLngrkr5oiq5Zu+6K+VJyxcbiAgICAgICAgICAgIHNuYXBzaG90VHJlZTpcbiAgICAgICAgICAgICAgICAnc25hcHNob3RUcmVlKHJvb3Q/LCB7IGxhYmVsPywgc2F2ZVRvPywgbWF4Tm9kZXM/IH0pIOKGkiB7bGFiZWwsIG5vZGVDb3VudCwgaGFzaCwga2VwdH0gIC8vIOaLjeS4gOS7vee6r+aVsOaNruW/q+eFp++8iOmUrj3oioLngrkqKui3r+W+hCoq77yM5a2Y55uY5o2iIHV1aWQg5Lmf5LiN5b2x5ZON5q+U5a+577yJ77yb5a2Y5Zyo5Zy65pmv6L+b56iL6YeM77yM6Leo6LCD55So6L+Y5ZyoJyxcbiAgICAgICAgICAgIGRpZmZUcmVlOlxuICAgICAgICAgICAgICAgICdkaWZmVHJlZShiZWZvcmVMYWJlbCwgYWZ0ZXJMYWJlbCwgeyBsaW1pdD8sIHNhdmVUbz8gfSkg4oaSIHtjb3VudHMsIGNoYW5nZWQ6W3twYXRoLCBwcm9wczp7azp7ZnJvbSx0b319fV0sIGFkZGVkLCByZW1vdmVkLCBzdXNwZWN0TGVha3N9ICAvLyAqKuaIkeWIsOW6leaUueS6huS7gOS5iCoq77ybc3VzcGVjdExlYWtzID0g5paw5aKe6IqC54K56YeM5ZCN5a2X5YOP5Li05pe25o6i6ZKI55qEJyxcbiAgICAgICAgICAgIGhlbHBlck5hbWVzOiAnaGVscGVyTmFtZXMoKSDihpIgc3RyaW5nW10nLFxuICAgICAgICB9O1xuICAgICAgICBsZXQgcmVjaXBlSGVscGVyczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNpZ25hdHVyZTogc3RyaW5nIH0+ID0gW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBtb2R1bGUgPSBnZXRSZWNpcGVzTW9kdWxlKCk7XG4gICAgICAgICAgICByZWNpcGVIZWxwZXJzID0gKG1vZHVsZS5SRUNJUEVfSEVMUEVSX1NJR05BVFVSRVMgYXMgc3RyaW5nW10pLm1hcCgoc2lnbmF0dXJlKSA9PiAoe1xuICAgICAgICAgICAgICAgIG5hbWU6IHNpZ25hdHVyZS5zbGljZSgwLCBzaWduYXR1cmUuaW5kZXhPZignKCcpKSxcbiAgICAgICAgICAgICAgICBzaWduYXR1cmUsXG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmVjaXBlSGVscGVycyA9IFtdO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGtpbmQ6ICdoZWxwZXJzJyxcbiAgICAgICAgICAgIGhlbHBlcnM6IFtcbiAgICAgICAgICAgICAgICAuLi5PYmplY3Qua2V5cyhoZWxwZXJzKVxuICAgICAgICAgICAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKG5hbWUpID0+ICh7IG5hbWUsIHNpZ25hdHVyZTogZG9jc1tuYW1lXSB8fCBuYW1lIH0pKSxcbiAgICAgICAgICAgICAgICAuLi5yZWNpcGVIZWxwZXJzLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlY2lwZURpcjogcmVjaXBlc1Jvb3RIaW50KCksXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gMykg6Kej5p6QIGNjLlh4eC5ZeXlcbiAgICBjb25zdCBwYXJ0cyA9IHRhcmdldC5zcGxpdCgnLicpLmZpbHRlcihCb29sZWFuKTtcbiAgICBpZiAocGFydHNbMF0gIT09ICdjYycpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBgc2NlbmUg5LiK5LiL5paH5Y+q6K6kICdjYy4qJyDmiJYgJ2hlbHBlcnMn77yM5pS25Yiw77yaJHt0YXJnZXR9YCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyDmjpDmjonlvIDlpLTnmoQgJ2NjJ++8mui1t+eCueacrOadpeWwseaYryBjYyDmqKHlnZfvvIzorqkgcGFydHNbMF0g5YaN6LWw5LiA5qyh5Lya5Y+W5YiwIGBjYy5jY2DvvIh1bmRlZmluZWTvvInvvIxcbiAgICAvLyDkuo7mmK/miYDmnIkgJ2NjLlh4eCcg6YO95Lya6K+v5oql44CM5ZyoIFh4eCDlpITmlq3pk77jgI3vvIjouKnov4fvvInjgIJcbiAgICBjb25zdCBwYXRoUGFydHMgPSBwYXJ0cy5zbGljZSgxKTtcbiAgICBpZiAocGF0aFBhcnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gYnVpbGRTY2VuZUluZGV4KGNjLCBsaW1pdCwgZmFsc2UpO1xuICAgIH1cblxuICAgIGxldCBub2RlOiBhbnkgPSBjYztcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGF0aFBhcnRzKSB7XG4gICAgICAgIGlmIChub2RlID09PSBudWxsIHx8IG5vZGUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsCAke3RhcmdldH3vvIjlnKggJHtwYXJ0fSDlpITmlq3pk77vvIlgIH07XG4gICAgICAgIH1cbiAgICAgICAgbm9kZSA9IChub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtwYXJ0XTtcbiAgICB9XG4gICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDmib7kuI3liLAgJHt0YXJnZXR9YCB9O1xuICAgIH1cblxuICAgIGlmICh0eXBlb2Ygbm9kZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAvLyDkuI3mmK/nsbvvvJrnm7TmjqXmj4/ov7Dov5nkuKrlgLxcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAga2luZDogJ3ZhbHVlJyxcbiAgICAgICAgICAgIHRhcmdldCxcbiAgICAgICAgICAgIHR5cGU6IGluZmVyVHNUeXBlKG5vZGUpLFxuICAgICAgICAgICAgdGV4dDogZGVzY3JpYmVDbGFzcyhjYywgbm9kZS5jb25zdHJ1Y3RvciB8fCBPYmplY3QsIG51bGwsIHRhcmdldCwgbGltaXQpLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIDQpIOaYr+exuyDigJTigJQg5LyY5YWI55So6IqC54K55LiK55qE5a6e5pe25a6e5L6L6KGl57G75Z6LXG4gICAgbGV0IGluc3RhbmNlOiBhbnkgPSBudWxsO1xuICAgIGxldCBpbnN0YW5jZU5vdGUgPSAnJztcbiAgICBpZiAocGF5bG9hZC5ub2RlVXVpZCkge1xuICAgICAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGNvbnN0IGhvc3QgPSBzY2VuZSA/IHNjZW5lLmdldENoaWxkQnlVdWlkKHBheWxvYWQubm9kZVV1aWQpIDogbnVsbDtcbiAgICAgICAgaWYgKGhvc3QpIHtcbiAgICAgICAgICAgIGluc3RhbmNlID0gaG9zdC5nZXRDb21wb25lbnQobm9kZSk7XG4gICAgICAgICAgICBpZiAoIWluc3RhbmNlKSBpbnN0YW5jZU5vdGUgPSBg6IqC54K5ICR7aG9zdC5uYW1lfSDkuIrmsqHmnIkgJHt0YXJnZXR9IOe7hOS7tmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpbnN0YW5jZU5vdGUgPSBg5om+5LiN5Yiw6IqC54K5ICR7cGF5bG9hZC5ub2RlVXVpZH1gO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGtpbmQ6ICdjbGFzcycsXG4gICAgICAgIHRhcmdldCxcbiAgICAgICAgY2xhc3NOYW1lOiAoKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2MuanMuZ2V0Q2xhc3NOYW1lKG5vZGUpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRhcmdldDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkoKSxcbiAgICAgICAgaW5zdGFuY2VGb3VuZDogQm9vbGVhbihpbnN0YW5jZSksXG4gICAgICAgIG5vdGU6IGluc3RhbmNlTm90ZSB8fCB1bmRlZmluZWQsXG4gICAgICAgIGRlZmluaXRpb246IGRlc2NyaWJlQ2xhc3MoY2MsIG5vZGUsIGluc3RhbmNlLCB0YXJnZXQsIGxpbWl0KSxcbiAgICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWvueWkluaWueazlVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjb25zdCBtZXRob2RzOiB7IFtrZXk6IHN0cmluZ106ICguLi5hcmdzOiBhbnlbXSkgPT4gYW55IH0gPSB7XG4gICAgLyoqIOaOoua0u++8muS4u+i/m+eoi+eUqOWug+WIpOaWreWcuuaZr+iEmuacrOaYr+WQpuW3suWKoOi9vSAqL1xuICAgIHBpbmcoKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0czogRGF0ZS5ub3coKSB9O1xuICAgIH0sXG5cbiAgICAvKiog5Zyo5byV5pOO5LiK5LiL5paH5omn6KGM55So5oi35Luj56CBICovXG4gICAgYXN5bmMgcnVuQ29kZShwYXlsb2FkOiBSdW5Db2RlUGF5bG9hZCkge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lQ29kZShwYXlsb2FkIHx8IHt9KTtcbiAgICB9LFxuXG4gICAgLyoqIOa4kOi/m+W8j+aKq+mcsu+8muaPj+i/sOW8leaTjiBBUEkgKi9cbiAgICBhc3luYyBkZXNjcmliZUFwaShwYXlsb2FkOiBEZXNjcmliZUFwaVBheWxvYWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNjID0gZ2V0Q2MoKTtcbiAgICAgICAgICAgIHJldHVybiBkZXNjcmliZVNjZW5lQXBpKGNjLCBwYXlsb2FkIHx8IHt9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBlcnJvckluZm8oZXJyKSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWcuuaZr+inhuWbvuWHoOS9lSDigJTigJQgKirmiKrlm77pk77ot6/ph4zjgIzph4/jgI3nmoTpgqPkuIDljYoqKu+8iOingeaWh+S7tumHjCBgcHJvamVjdE5vZGVSZWN0YCDkuIDoioLvvInjgIJcbiAgICAgKlxuICAgICAqIOS4u+i/m+eoi+eahCBFbGVjdHJvbiDmiKrlm77opoHpnaDlroPvvJrikaAg5oyJIGBwYWdlLmhyZWZgIOeyvuehruWumuS9jeWcuuaZr+inhuWbvumCo+S4qiB3ZWJDb250ZW50c++8m1xuICAgICAqIOKRoSDmjIkgYHBhZ2UvY3NzYCDmiorlm77niYflg4/ntKDmjaLmiJAgQ1NTIOWDj+e0oO+8m+KRoiDopoHmiKrmn5DkuKroioLngrnml7bvvIznlKggYG5vZGUucmVjdGAg6KOB77ybXG4gICAgICog4pGjIOW4puS6hiBgZml0YCDml7bov5jopoHlm57nrZTjgIznm67moIfmi43lhajkuobmsqHmnInjgI3vvIhgZnJhbWluZ2DvvInjgIJcbiAgICAgKi9cbiAgICBhc3luYyB2aWV3TWV0cmljcyhwYXlsb2FkOiBWaWV3TWV0cmljc1BheWxvYWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNjID0gZ2V0Q2MoKTtcbiAgICAgICAgICAgIHJldHVybiBjb2xsZWN0Vmlld01ldHJpY3MoY2MsIHBheWxvYWQgfHwge30pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5Y+W5pmvIC8g6L+Y5Y6f6KeG6KeSIOKAlOKAlCAqKuaIquWbvumTvui3r+mHjOOAjOaRhuebuOacuuOAjeeahOmCo+S4gOWNiioq77yI6KeB5paH5Lu26YeM44CM5Y+W5pmv44CN5LiA6IqC77yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjnlLHkuLvov5vnqIvpqbHliqjogIzkuI3mmK/ov5nph4zkuIDmiormoq3vvJrlj5bmma/kuYvlkI4qKuW/hemhu+iuqemhtemdoumHjeeUu+S4gOW4pyoqXG4gICAgICog77yI55u45py65Yqo5LqG5L2G55S76Z2i5rKh6YeN55S755qE6K+d77yMYGNhcHR1cmVQYWdlKClgIOaKk+WIsOeahOi/mOaYr+aXp+WPluaZr++8ie+8jFxuICAgICAqIOiAjOOAjOaOkuS4gOasoemHjee7mOOAjeWPquacieS4u+i/m+eoi+iDveWBmuWIsO+8iGB3ZWJDb250ZW50cy5pbnZhbGlkYXRlKClg77yJ44CCXG4gICAgICog5omA5Lul6L+Z6YeM5Y+q5YGa44CM5pGG5LiA5q2lIOKGkiDkuLvov5vnqIvpgLzkuIDluKcg4oaSIOWGjemHj+S4gOatpeOAjemHjOeahOmCo+S4pOatpe+8jFxuICAgICAqIOeUseS4u+i/m+eoi+aMiSBgc3RlcGAg6YCQ57qn5o6o6L+b77yI5q+P5LiA57qn6YO95piv6YeP552A6aqM77yM6aqM5LiN6L+H5omN6ZmN57qn77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcGF5bG9hZCAtIGB7YWN0aW9uLCBzdGVwPywgZml0Pywgbm9kZT8sIHByb2plY3RQYXRoP31g77yaXG4gICAgICogICBgYWN0aW9uOidmaXQnYCDmkYbnrKwgYHN0ZXBgIOe6p+WPluaZr++8iDAgPSDnvJbovpHlmaggZm9jdXMgLyAxID0g5o6n5Yi25Zmo6YCC6YWNIC8gMiA9IOaJi+W3pe+8ie+8jFxuICAgICAqICAgYGFjdGlvbjonZW5kJ2Ag6L+Y5Y6f6KeG6KeS44CCXG4gICAgICogQHJldHVybnMgYHtvaywgdG9rZW4sIHN0ZXAsIG1ldGhvZCwgbmV4dFN0ZXAsIHNhdmVkLCBjYW1lcmF9YO+8m1xuICAgICAqICAgYGFjdGlvbjonZW5kJ2Ag5ZueIGB7b2ssIHJlc3RvcmVkLCBtZXRob2QsIGFmdGVyfWAg4oCU4oCUICoq6L+Y5Y6f5aSx6LSl5Lya5aaC5a6e5ZueIGByZXN0b3JlZDpmYWxzZWAqKuOAglxuICAgICAqXG4gICAgICog4pqgIOWQjOS4gOaXtuWIu+WPqueVmeS4gOS7veW+hei/mOWOn+eahOinhuinku+8iOaIquWbvuaYr+S4suihjOeahO+8ie+8m+S4gOS7vei2hei/hyA2MHMg5rKh6KKr6L+Y5Y6f5bCx5b2T5a6D5L2c5bqfXG4gICAgICog77yI5Yir5oqK5Yeg5YiG6ZKf5YmN55qE5pen6KeG6KeS55uW5Zue55So5oi36IS45LiK77yJ44CCXG4gICAgICovXG4gICAgYXN5bmMgZml0VmlldyhwYXlsb2FkOiBGaXRWaWV3UGF5bG9hZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2MgPSBnZXRDYygpO1xuICAgICAgICAgICAgY29uc3QgY2FtZXJhID0gZWRpdG9yQ2FtZXJhKCk7XG4gICAgICAgICAgICBjb25zdCBhY3Rpb24gPSBwYXlsb2FkICYmIHBheWxvYWQuYWN0aW9uID09PSAnZW5kJyA/ICdlbmQnIDogJ2ZpdCc7XG5cbiAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdlbmQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFwZW5kaW5nRml0KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5b6F6L+Y5Y6f55qE6KeG6KeS77yI5Y+v6IO95bey57uP6KKr6L+Y5Y6f6L+H5LqG77yJJyB9O1xuICAgICAgICAgICAgICAgIGlmICghY2FtZXJhLmNhbSB8fCAhY2FtZXJhLm1hbmFnZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYWJhbmRvbmVkID0gcGVuZGluZ0ZpdDtcbiAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0ZpdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGNhbWVyYS5ub3RlIHx8ICfnvJbovpHlmajnm7jmnLrkuI3lj6/nlKjvvIzov5jkuI3kuobljp8nLCB0b2tlbjogYWJhbmRvbmVkLnRva2VuIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcGVuZGluZ0ZpdDtcbiAgICAgICAgICAgICAgICBwZW5kaW5nRml0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN0b3JlZCA9IHJlc3RvcmVDYW1lcmFTdGF0ZShjYW1lcmEubWFuYWdlciwgY2FtZXJhLmNhbSwgc3RhdGUuc2F2ZWQpO1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICB0b2tlbjogc3RhdGUudG9rZW4sXG4gICAgICAgICAgICAgICAgICAgIHJlc3RvcmVkOiByZXN0b3JlZC5yZXN0b3JlZCxcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiByZXN0b3JlZC5tZXRob2QsXG4gICAgICAgICAgICAgICAgICAgIGFmdGVyOiByZXN0b3JlZC5hZnRlcixcbiAgICAgICAgICAgICAgICAgICAgZXhwZWN0ZWQ6IHN0YXRlLnNhdmVkLnNpZ25hdHVyZSxcbiAgICAgICAgICAgICAgICAgICAgbm90ZTogcmVzdG9yZWQubm90ZSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhbWVyYS5jYW0gfHwgIWNhbWVyYS5tYW5hZ2VyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogY2FtZXJhLm5vdGUgfHwgJ+e8lui+keWZqOebuOacuuS4jeWPr+eUqO+8jOWPluS4jeS6huaZrycgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHN0ZXAgPSBjbGFtcE51bWJlcihwYXlsb2FkICYmIHBheWxvYWQuc3RlcCwgMCwgMiwgMCk7XG4gICAgICAgICAgICBjb25zdCBzcGVjID0gbm9ybWFsaXplRml0U3BlYyhwYXlsb2FkICYmIHBheWxvYWQuZml0KTtcbiAgICAgICAgICAgIGlmICghc3BlYykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYGZpdFZpZXcg5LiN6K6k5b6XIGZpdCDlj4LmlbDvvJoke0pTT04uc3RyaW5naWZ5KHBheWxvYWQgJiYgcGF5bG9hZC5maXQpfWAgfTtcblxuICAgICAgICAgICAgY29uc3QgaGVscGVycyA9IG1ha2VIZWxwZXJzKGNjLCB7XG4gICAgICAgICAgICAgICAgcHJvamVjdFBhdGg6IHR5cGVvZiBwYXlsb2FkLnByb2plY3RQYXRoID09PSAnc3RyaW5nJyA/IHBheWxvYWQucHJvamVjdFBhdGggOiAnJyxcbiAgICAgICAgICAgIH0pLmhlbHBlcnMgYXMgUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICAgIGNvbnN0IHJlZiA9IHNwZWMua2luZCA9PT0gJ25vZGUnID8gc3BlYy5yZWYgfHwgKHR5cGVvZiBwYXlsb2FkLm5vZGUgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5ub2RlLnRyaW0oKSA6ICcnKSA6ICcnO1xuICAgICAgICAgICAgbGV0IG5vZGU6IGFueSA9IG51bGw7XG4gICAgICAgICAgICBpZiAocmVmKSB7XG4gICAgICAgICAgICAgICAgbm9kZSA9IGhlbHBlcnMubm9kZUJ5VXVpZChyZWYpIHx8IGhlbHBlcnMubm9kZUJ5UGF0aChyZWYpIHx8IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB0YXJnZXQgPSBmaXRUYXJnZXRPZihoZWxwZXJzLCBzcGVjLCBub2RlKTtcblxuICAgICAgICAgICAgLyoqIOinhuinkuWPquWtmCoq5LiA5qyhKirvvIjnrKzkuIDmrKHlj5bmma/kuYvliY3vvInigJTigJQg5ZCO6Z2i5Yeg57qn6ZmN57qn6YO95Zyo5ZCM5LiA5Liq5Y6f5aeL6KeG6KeS5LmL5LiKICovXG4gICAgICAgICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgICAgICAgICAgY29uc3Qgc3RhbGUgPSBCb29sZWFuKHBlbmRpbmdGaXQpICYmIG5vdyAtIChwZW5kaW5nRml0IGFzIHsgc3RhcnRlZEF0OiBudW1iZXIgfSkuc3RhcnRlZEF0ID4gRklUX1NUQVRFX1RUTF9NUztcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcGVuZGluZ0ZpdCAmJiAhc3RhbGUgPyBwZW5kaW5nRml0LnNhdmVkIDogc2F2ZUNhbWVyYVN0YXRlKGNhbWVyYS5tYW5hZ2VyLCBjYW1lcmEuY2FtKTtcbiAgICAgICAgICAgIGNvbnN0IHRva2VuID0gcGVuZGluZ0ZpdCAmJiAhc3RhbGUgPyBwZW5kaW5nRml0LnRva2VuIDogYGZpdC0ke25vd30tJHsoZml0Q291bnRlciArPSAxKX1gO1xuXG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gYXBwbHlGaXRTdGVwKGNjLCBjYW1lcmEubWFuYWdlciwgY2FtZXJhLmNhbSwgc3RlcCwgdGFyZ2V0LCBjYW1lcmEuaXMyRCk7XG4gICAgICAgICAgICBwZW5kaW5nRml0ID0geyB0b2tlbiwgc2F2ZWQsIHN0YXJ0ZWRBdDogbm93IH07XG5cbiAgICAgICAgICAgIGNvbnN0IG1heFN0ZXAgPSBtYXhGaXRTdGVwcyhjYW1lcmEuaXMyRCk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG9rOiBhcHBsaWVkLm1ldGhvZCAhPT0gbnVsbCxcbiAgICAgICAgICAgICAgICB0b2tlbixcbiAgICAgICAgICAgICAgICBzdGVwLFxuICAgICAgICAgICAgICAgIG1ldGhvZDogYXBwbGllZC5tZXRob2QsXG4gICAgICAgICAgICAgICAgbm90ZTogYXBwbGllZC5ub3RlLFxuICAgICAgICAgICAgICAgIGRldGFpbDogYXBwbGllZC5kZXRhaWwsXG4gICAgICAgICAgICAgICAgLyoqIOS4i+S4gOe6p++8iOayoeacieWwsSBudWxs77yJ4oCU4oCUIOS4u+i/m+eoi+aMieWug+WGs+WumuimgeS4jeimgee7p+e7remZjee6pyAqL1xuICAgICAgICAgICAgICAgIG5leHRTdGVwOiBhcHBsaWVkLm1ldGhvZCAhPT0gbnVsbCAmJiBzdGVwICsgMSA8IG1heFN0ZXAgPyBzdGVwICsgMSA6IG51bGwsXG4gICAgICAgICAgICAgICAgbWF4U3RlcCxcbiAgICAgICAgICAgICAgICBpczJEOiBjYW1lcmEuaXMyRCxcbiAgICAgICAgICAgICAgICByZXBsYWNlZFN0YWxlOiBzdGFsZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHsga2luZDogc3BlYy5raW5kLCByZWY6IHJlZiB8fCBudWxsLCBzb3VyY2U6IHRhcmdldC5zb3VyY2UsIHV1aWRzOiB0YXJnZXQudXVpZHMubGVuZ3RoLCB3b3JsZDogdGFyZ2V0LndvcmxkIH0sXG4gICAgICAgICAgICAgICAgLyoqIOWOn+Wni+inhuinku+8iOi/mOWOn+eahOWHreaNru+8ieKAlOKAlCDlm57miafph4zluKbkuIrvvIznlKjmiLfog73moLjlr7lcIuehruWunui/mOWbnuWOu+S6hlwiICovXG4gICAgICAgICAgICAgICAgc2F2ZWQ6IHsgaGFzSW5mbzogQm9vbGVhbihzYXZlZC5pbmZvKSwgc2lnbmF0dXJlOiBzYXZlZC5zaWduYXR1cmUgfSxcbiAgICAgICAgICAgICAgICBjYW1lcmE6IGNhbWVyYVNpZ25hdHVyZShjYW1lcmEuY2FtKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3JJbmZvKGVycikgfTtcbiAgICAgICAgfVxuICAgIH0sXG59O1xuIl19