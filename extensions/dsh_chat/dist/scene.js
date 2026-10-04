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
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOENHOzs7QUFFSCwrQkFBNEI7QUFPNUIsU0FBUyxZQUFZLENBQUMsRUFBVTtJQUM1QixNQUFNLEdBQUcsR0FBRyxJQUFJLEtBQUssQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUEwQixDQUFDO0lBQ3BFLEdBQUcsQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLE9BQU8sR0FBRyxDQUFDO0FBQ2YsQ0FBQztBQUVEOzs7Ozs7Ozs7O0dBVUc7QUFDSCxTQUFTLFNBQVMsQ0FBQyxHQUFZO0lBQzNCLElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ2xELE1BQU0sTUFBTSxHQUFHLEdBQW9FLENBQUM7SUFDcEYsSUFBSSxNQUFNLENBQUMsWUFBWTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3JDLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyw4QkFBOEI7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNoRSxPQUFPLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRLElBQUksNkJBQTZCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNwRyxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsR0FBWTtJQUMzQixJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNqQyxNQUFNLE1BQU0sR0FBRyxHQUE2RCxDQUFDO1FBQzdFLE9BQU87WUFDSCxJQUFJLEVBQUUsT0FBTyxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTztZQUM3RCxP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QztJQUVELHFCQUFxQjtJQUNyQixLQUFLLENBQUMsV0FBVyxDQUFDLE9BQTJCO1FBQ3pDLElBQUksQ0FBQztZQUNELE1BQU0sRUFBRSxHQUFHLEtBQUssRUFBRSxDQUFDO1lBQ25CLE9BQU8sZ0JBQWdCLENBQUMsRUFBRSxFQUFFLE9BQU8sSUFBSSxFQUFFLENBQUMsQ0FBQztRQUMvQyxDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNYLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoRCxDQUFDO0lBQ0wsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOWcuuaZr+i/m+eoi+iEmuacrCDigJTigJQgQ29kZSBNb2RlIOeahOOAjOW8leaTjuS+p+aJp+ihjOWZqOOAjeOAglxuICpcbiAqIOi/meS4quaWh+S7tui3keWcqCAqKuW8leaTjuWcuuaZr+i/m+eoiyoqIOmHjO+8iOS4jeaYr+aJqeWxleS4u+i/m+eoi++8ie+8jOaJgOS7peiDveebtOaOpeaLv+WIsCBgY2NgIOaooeWdl++8mlxuICogYE5vZGVgIC8gYENvbXBvbmVudGAgLyBgQXNzZXRgIC8gYGRpcmVjdG9yYCAvIOWcuuaZr+agke+8jOWFqOaYr+ecn+eahOi/kOihjOaXtuWvueixoeOAglxuICpcbiAqIOS4u+i/m+eoi+mAmui/h1xuICogYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0JywgeyBuYW1lLCBtZXRob2QsIGFyZ3MgfSlgXG4gKiDosIPliLDov5nph4zvvIjop4EgY29yZS9zY2VuZS1icmlkZ2UudHPvvInjgIJcbiAqXG4gKiAjIyDmiafooYznrZbnlaXvvJpgdm0ucnVuSW5UaGlzQ29udGV4dGAg5LyY5YWI77yMYG5ldyBGdW5jdGlvbmAg5YWc5bqVXG4gKlxuICog6L+Z6YeM5pyJ5LiqKirlv4XpobvorrLmuIXmpZrnmoTlj5boiI0qKuOAguS4u+i/m+eoi+mCo+i+ueeUqCBgdm0uY3JlYXRlQ29udGV4dGAg5YGa6ZqU56a75rKZ566x77yMXG4gKiDkvYblvJXmk47ov5vnqIvkuI3og73nhafmkKwg4oCU4oCUIOmalOemu+S4iuS4i+aWh+S8muaWsOW7uuS4gOaVtOWllyByZWFsbSDlhoXlu7rlr7nosaHvvIxcbiAqIOaymeeusemHjOmAoOWHuuadpeeahCBge31gIC8gYFtdYCDlnKjlvJXmk47ku6PnoIHnmoQgYGluc3RhbmNlb2YgT2JqZWN0YCAvIGBpbnN0YW5jZW9mIEFycmF5YFxuICog5Yik5pat5LiL5LyaKirkuLrlgYcqKu+8jOmCo+S8muiuqeS4gOWghuW8leaTjiBBUEkg5Ye6546w6Zq+5Lul5o6S5p+l55qE6K+h5byC6KGM5Li644CCXG4gKlxuICog5omA5Lul6KaB55qE5piv44CMKirlkIzkuIDkuKogcmVhbG3vvIzkvYbog73otoXml7YqKuOAjeKAlOKAlCDmraPlpb3mmK8gYHZtLnJ1bkluVGhpc0NvbnRleHQoY29kZSwgeyB0aW1lb3V0IH0pYO+8mlxuICogLSDku6PnoIHot5HlnKgqKuWuv+S4uyByZWFsbSoq77yM5YaF5bu65a+56LGh5LiO5byV5pOO5a6M5YWo5LiA6Ie077yMYGluc3RhbmNlb2ZgIOivreS5ieWuieWFqO+8m1xuICogLSBgdGltZW91dGAg5a+5KirlkIzmraXmiafooYzmrrUqKueUn+aViO+8jOS6juaYryBgd2hpbGUodHJ1ZSl7fWAg6IO96KKr5o6Q5patXG4gKiAgIO+8iOi/meS4gOeCueW+iOWFs+mUru+8muWcuuaZr+i/m+eoi+mHjOWNoeatu+S4gOS4quWQjOatpeatu+W+queOryA9IOaVtOS4qiBDb2NvcyBDcmVhdG9yIOWGu+S9j++8jFxuICogICDlj6rog73lvLrmnYDvvIzmnKrkv53lrZjnmoTlnLrmma/mlLnliqjlhajkuKLvvInjgIJcbiAqXG4gKiDku6Pku7fmmK8gYHJ1bkluVGhpc0NvbnRleHRgIOeahOS7o+eggSoq55yL5LiN5Yiw5bGA6YOo5L2c55So5Z+fKirvvIzlhajlsYDph4/lj6rog73pgJrov4cgYGdsb2JhbFRoaXNgIOS8oOmAku+8jFxuICog5omn6KGM5a6M5YaN6L+Y5Y6f77yI6KeBIHtAbGluayBpbmplY3RHbG9iYWxzfe+8ieOAglxuICpcbiAqIOWmguaenOW8leaTjui/m+eoi+mHjOaLv+S4jeWIsCBgdm1g77yM5Zue6JC95YiwIGBuZXcgRnVuY3Rpb24oLi4ubmFtZXMsIGJvZHkpYO+8mlxuICog55So5pi+5byP5b2i5Y+C5Lyg5YWo5bGA6YeP77yM6Zu25L6d6LWW44CB5LiN56KwIGBnbG9iYWxUaGlzYO+8jOS9hioq5ZCM5q2l5q275b6q546v5peg5rOV6KKr6LaF5pe25pWR5ZueKirjgIJcbiAqIOS4pOadoei3r+W+hOeahOeUqOaIt+S7o+eggeWGmeazleWujOWFqOS4gOiHtO+8iOijuOagh+ivhuespiArIOmhtuWxgiByZXR1cm4vYXdhaXTvvInjgIJcbiAqXG4gKiAjIyDov5nkuKrmlofku7blj6rmmrTpnLIgMyDkuKrmlrnms5XvvIzkuI3mmK8gMzAg5LiqXG4gKlxuICogYHJ1bkNvZGVgIOmHjOazqOWFpeS6hiBgZHVtcGAgLyBgbm9kZUJ5VXVpZGAgLyBgdHJlZWAgLyBgc25hcHNob3RgIOetiSoq5Yqp5omL5Ye95pWwKirvvIxcbiAqIOWug+S7rOa0u+WcqOaymeeusemHjOiAjOS4jeaYr+WPmOaIkOeLrOeriyB0b29sIOKAlOKAlCDov5nmmK8gQ29kZSBNb2RlIOeahOaguOW/g+WPo+W+hO+8mlxuICog5bel5YW35YiX6KGo6KaB55+t77yM6IO95Yqb6Z2g5Luj56CB57uE5ZCI44CC5Li76L+b56iL5L6n5Y+q55yL5YiwIDMg5Liq5bel5YW377yMXG4gKiDlvJXmk47og73lipvljbTmnInml6DpmZDnu4TlkIjjgIJcbiAqXG4gKiAjIyDkuKTkuKrjgIzkuI3ov5nkuYjlgZrlsLHkvJrooqvor6/lr7zjgI3nmoTlrp7mtYvlnZFcbiAqXG4gKiAxLiAqKuWcuuaZr+agkemHjCA5NyUg55qE6IqC54K55LiN5piv5L2g55qE5YaF5a65KirjgILnvJbovpHlmajmiorlnZDmoIfovbQgZ2l6bW/jgIHnvZHmoLzjgIHlj4LogIPlm77pg73mjILlnKhcbiAqICAgIOWQjOS4gOS4qiBzY2VuZSDkuIvvvIjlrp7mtYvnqbrlnLrmma8gMTI4IOS4quiKgueCue+8jOecn+WunuWGheWuueWPquaciSAyIOS4qu+8ieOAglxuICogICAgYGVhY2hOb2RlYCAvIGB0cmVlKClgIOm7mOiupOaMiSBgSGlkZUluSGllcmFyY2h5YCDliarmnp0g4oCU4oCUIOWIpOaNrueahOaOqOWvvOi/h+eoi+ingVxuICogICAge0BsaW5rIG1ha2VIZWxwZXJzfSDph4wgYGlzRWRpdG9yTm9kZWAg5LiK5pa555qE5rOo6YeK77yIKirmjIkgbGF5ZXIg5ruk5piv6ZSZ55qEKirvvInjgIJcbiAqIDIuICoqYGNjLmZpbmRgIOaJvuS4jeWIsOWQjeWtl+mHjOWQqyBgL2Ag55qE6IqC54K5KirvvIzogIzkuJQqKumdmem7mOi/lOWbniBudWxsKirjgIJcbiAqICAgIOW3peeoi+mHjOWunua1i+WtmOWcqCBgaW50ZXJuYWwvZWRpdG9yL2dyaWQtMmRg44CCe0BsaW5rIG1ha2VIZWxwZXJzfSDph4xcbiAqICAgIGByZXNvbHZlUGF0aEJ5U2VnbWVudHNgIOeUqOOAjOi0quW/g+aMieauteWMuemFjeOAjeWFnOS9j+S6hui/meS4gOexu+OAglxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuLyoqIOaJp+ihjOi2heaXtueahOWTqOWFtemUmeivryAqL1xuaW50ZXJmYWNlIFRpbWVvdXRNYXJrZXIge1xuICAgIF9fZHNoVGltZW91dDogdHJ1ZTtcbn1cblxuZnVuY3Rpb24gdGltZW91dEVycm9yKG1zOiBudW1iZXIpOiBFcnJvciAmIFRpbWVvdXRNYXJrZXIge1xuICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcihg5Zy65pmv5Luj56CB5omn6KGM6LaF5pe277yIJHttc31tc++8iWApIGFzIEVycm9yICYgVGltZW91dE1hcmtlcjtcbiAgICBlcnIuX19kc2hUaW1lb3V0ID0gdHJ1ZTtcbiAgICByZXR1cm4gZXJyO1xufVxuXG4vKipcbiAqIOWIpOaWreaYr+S4jeaYr+i2heaXtuOAglxuICpcbiAqIOimgeiupOS4pOenje+8mlxuICogMS4g5oiR5Lus6Ieq5bex55qE5ZOo5YW177yI5aSW5bGC6K6h5pe25Zmo5oqb55qE77yJ4oCU4oCUIGBfX2RzaFRpbWVvdXRgXG4gKiAyLiAqKnZtIOiHquW3seaKm+eahOWQjOatpei2heaXtioqIOKAlOKAlCBgRVJSX1NDUklQVF9FWEVDVVRJT05fVElNRU9VVGDvvIxcbiAqICAgIOS/oeaBr+W9ouWmgiBgU2NyaXB0IGV4ZWN1dGlvbiB0aW1lZCBvdXQgYWZ0ZXIgMzAwbXNgXG4gKlxuICog56ysIDIg56eN54m55Yir5a655piT5ryP77ya5ryP5LqG55qE6K+d5q275b6q546v6Jm954S26KKr5o6Q5pat5LqG77yMXG4gKiDkvYblr7nlpJbmiqXnmoTmmK/jgIzmma7pgJrlvILluLjjgI3ogIzkuI3mmK/jgIzotoXml7bjgI3vvIzkvb/nlKjogIXnnIvkuI3lh7ror6XljrvmlLnku4DkuYjjgIJcbiAqL1xuZnVuY3Rpb24gaXNUaW1lb3V0KGVycjogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIGlmICghZXJyIHx8IHR5cGVvZiBlcnIgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgYW55RXJyID0gZXJyIGFzIHsgX19kc2hUaW1lb3V0PzogYm9vbGVhbjsgY29kZT86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgaWYgKGFueUVyci5fX2RzaFRpbWVvdXQpIHJldHVybiB0cnVlO1xuICAgIGlmIChhbnlFcnIuY29kZSA9PT0gJ0VSUl9TQ1JJUFRfRVhFQ1VUSU9OX1RJTUVPVVQnKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gdHlwZW9mIGFueUVyci5tZXNzYWdlID09PSAnc3RyaW5nJyAmJiAvU2NyaXB0IGV4ZWN1dGlvbiB0aW1lZCBvdXQvaS50ZXN0KGFueUVyci5tZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gZXJyb3JJbmZvKGVycjogdW5rbm93bik6IHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmc7IHN0YWNrPzogc3RyaW5nIH0ge1xuICAgIGlmIChlcnIgJiYgdHlwZW9mIGVyciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3QgYW55RXJyID0gZXJyIGFzIHsgbmFtZT86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duOyBzdGFjaz86IHVua25vd24gfTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IHR5cGVvZiBhbnlFcnIubmFtZSA9PT0gJ3N0cmluZycgPyBhbnlFcnIubmFtZSA6ICdFcnJvcicsXG4gICAgICAgICAgICBtZXNzYWdlOiB0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnID8gYW55RXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICAgIHN0YWNrOiB0eXBlb2YgYW55RXJyLnN0YWNrID09PSAnc3RyaW5nJyA/IGFueUVyci5zdGFjayA6IHVuZGVmaW5lZCxcbiAgICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogU3RyaW5nKGVycikgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlvJXmk47mqKHlnZfmh5LliqDovb1cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5sZXQgY2NDYWNoZTogYW55ID0gbnVsbDtcbmxldCBjY0Vycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiDmi7/liLAgYGNjYCDmqKHlnZfjgIJcbiAqXG4gKiBgbW9kdWxlLnBhdGhzLnB1c2goRWRpdG9yLkFwcC5wYXRoICsgJy9ub2RlX21vZHVsZXMnKWAg5piv5b+F6ZyA55qE77yaXG4gKiDlnLrmma/ohJrmnKzoh6rouqvnmoTmqKHlnZfop6PmnpDot6/lvoTph4zmsqHmnInlvJXmk47ljIXvvIzkuI3mjqjov5nkuIDkuIsgYHJlcXVpcmUoJ2NjJylgIOS8miBNT0RVTEVfTk9UX0ZPVU5E44CCXG4gKi9cbmZ1bmN0aW9uIGdldENjKCk6IGFueSB7XG4gICAgaWYgKGNjQ2FjaGUpIHJldHVybiBjY0NhY2hlO1xuICAgIGlmIChjY0Vycm9yKSB0aHJvdyBuZXcgRXJyb3IoY2NFcnJvcik7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZW5naW5lTm9kZU1vZHVsZXMgPSBqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpO1xuICAgICAgICBpZiAoIW1vZHVsZS5wYXRocy5pbmNsdWRlcyhlbmdpbmVOb2RlTW9kdWxlcykpIHtcbiAgICAgICAgICAgIG1vZHVsZS5wYXRocy5wdXNoKGVuZ2luZU5vZGVNb2R1bGVzKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICBjY0NhY2hlID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgcmV0dXJuIGNjQ2FjaGU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNjRXJyb3IgPSBg5peg5rOV5Yqg6L295byV5pOO5qih5Z2XIGNj77yaJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfWA7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihjY0Vycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGN1cnJlbnRTY2VuZShjYzogYW55KTogYW55IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlY2lwZSDmqKHlnZcg4oCU4oCUIOS4juS4u+i/m+eoi+WFseS6q+WQjOS4gOS7veWunueOsFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiDmianlsZXljIXlkI3vvIzkuI4gY29uc3RhbnRzLnRzIOeahCBFWFRFTlNJT05fTkFNRSDkuIDoh7TvvIjmraTlpITkuI3og70gaW1wb3J077yM5Y6f5Zug6KeB5LiL77yJICovXG5jb25zdCBFWFRFTlNJT05fTkFNRSA9ICdkc2hfY2hhdCc7XG5cbmxldCByZWNpcGVzTW9kdWxlOiBhbnkgPSBudWxsO1xubGV0IHJlY2lwZXNNb2R1bGVFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICog5Yqg6L295YWx5Lqr55qEIHJlY2lwZSDmqKHlnZfvvIhgZGlzdC9jb3JlL3JlY2lwZXMuanNg77yJ44CCXG4gKlxuICog4pqgICoq5b+F6aG75oyJ57ud5a+56Lev5b6EIHJlcXVpcmXvvIznm7jlr7not6/lvoTkuI3pgJoqKuOAguWunua1i+WcuuaZr+iEmuacrOmHjCBgX19kaXJuYW1lYCDmmK9cbiAqIGAuLi5cXHJlc291cmNlc1xcZWxlY3Ryb24uYXNhclxccmVuZGVyZXJg77yI5LiN5piv5omp5bGV55qEIGBkaXN0L2DvvInvvIxcbiAqIOaJgOS7pSBgcmVxdWlyZSgnLi9jb3JlL3JlY2lwZXMnKWAg55u05o6lIE1PRFVMRV9OT1RfRk9VTkTjgIJcbiAqXG4gKiDmraPop6PmmK/pl67nvJbovpHlmajopoHmianlsZXmoLnvvJpgRWRpdG9yLlBhY2thZ2UuZ2V0UGF0aCgnZHNoX2NoYXQnKWBcbiAqIOKGkiBgLi4uXFxleHRlbnNpb25zXFxkc2hfY2hhdGDvvIzlho3mi7wgYGRpc3QvY29yZS9yZWNpcGVzLmpzYO+8iOWunua1i+WPr+ihjO+8ieOAglxuICpcbiAqIOmhuuW4puivtOaYjuS4gOS4quehrOe6puadn++8muacrOmhueebrioq5rKh5pyJ5omT5YyF5ZmoKirvvIjmnoTlu7rlsLHmmK8gYHRzY2DvvInvvIxcbiAqIOaJgOS7pSBgZGlzdC9gIOeahOebruW9lee7k+aehOaYr+i3qOi/m+eoi+eahOehrOWlkee6pu+8jOaUuSBgb3V0RGlyYCDmiJbmjKogYGNvcmUvYCDkvJrmiZPmlq3lroPjgIJcbiAqL1xuZnVuY3Rpb24gZ2V0UmVjaXBlc01vZHVsZSgpOiBhbnkge1xuICAgIGlmIChyZWNpcGVzTW9kdWxlKSByZXR1cm4gcmVjaXBlc01vZHVsZTtcbiAgICBpZiAocmVjaXBlc01vZHVsZUVycm9yKSB0aHJvdyBuZXcgRXJyb3IocmVjaXBlc01vZHVsZUVycm9yKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByb290ID0gRWRpdG9yLlBhY2thZ2UuZ2V0UGF0aChFWFRFTlNJT05fTkFNRSk7XG4gICAgICAgIGlmICghcm9vdCkgdGhyb3cgbmV3IEVycm9yKGBFZGl0b3IuUGFja2FnZS5nZXRQYXRoKCcke0VYVEVOU0lPTl9OQU1FfScpIOi/lOWbnuepumApO1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICByZWNpcGVzTW9kdWxlID0gcmVxdWlyZShqb2luKHJvb3QsICdkaXN0JywgJ2NvcmUnLCAncmVjaXBlcy5qcycpKTtcbiAgICAgICAgcmV0dXJuIHJlY2lwZXNNb2R1bGU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJlY2lwZXNNb2R1bGVFcnJvciA9IGDml6Dms5XliqDovb0gcmVjaXBlIOaooeWdl++8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocmVjaXBlc01vZHVsZUVycm9yKTtcbiAgICB9XG59XG5cbi8qKiDlvZPliY3lt6XnqIvmoLnvvJvmi7/kuI3liLDlsLHov5Tlm57nqbrkuLLvvIhyZWNpcGUg5Yqp5omL5Lya6YCA5YyW5oiQ44CM5rKh5pyJIHJlY2lwZeOAjeiAjOS4jeaYr+aKpemUme+8iSAqL1xuZnVuY3Rpb24gY3VycmVudFByb2plY3RQYXRoKCk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIEVkaXRvci5Qcm9qZWN0LnBhdGggfHwgJyc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnJztcbiAgICB9XG59XG5cbi8qKiByZWNpcGUg5a2Y5pS+55uu5b2VIOKAlOKAlCDlj6rnu5kgYGRlc2NyaWJlX2FwaWAg5Zue5pi+55So77yM5ou/5LiN5Yiw5bCxIG51bGwgKi9cbmZ1bmN0aW9uIHJlY2lwZXNSb290SGludCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IGN1cnJlbnRQcm9qZWN0UGF0aCgpO1xuICAgICAgICBpZiAoIXByb2plY3RQYXRoKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGdldFJlY2lwZXNNb2R1bGUoKS5yZWNpcGVzUm9vdChwcm9qZWN0UGF0aCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDliqnmiYvlh73mlbAg4oCU4oCUIOazqOWFpeaymeeuse+8jOS4jeaatOmcsuS4uiB0b29sXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIOa3seW6puS8mOWFiOmBjeWOhuaVtOajteWtkOagke+8iOi/reS7o+WunueOsO+8jOmBv+WFjea3seWxguWcuuaZr+eIhuagiO+8iSAqL1xuZnVuY3Rpb24gZWFjaE5vZGUocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGlmICghcm9vdCkgcmV0dXJuO1xuICAgIGNvbnN0IHN0YWNrOiBhbnlbXSA9IFtyb290XTtcbiAgICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBub2RlID0gc3RhY2sucG9wKCk7XG4gICAgICAgIHZpc2l0KG5vZGUpO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgICAgIGZvciAobGV0IGkgPSBjaGlsZHJlbi5sZW5ndGggLSAxOyBpID49IDA7IGkgLT0gMSkgc3RhY2sucHVzaChjaGlsZHJlbltpXSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzaG9ydE5vZGUobm9kZTogYW55KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgdXVpZDogbm9kZS51dWlkLFxuICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlSW5IaWVyYXJjaHkgIT09IHVuZGVmaW5lZCA/IG5vZGUuYWN0aXZlSW5IaWVyYXJjaHkgOiBub2RlLmFjdGl2ZSxcbiAgICB9O1xufVxuXG4vKiog5oqK5YC85o6o5pat5oiQIFRTIOexu+Wei+WQje+8jOeUqOS6jueUn+aIkOexu+WumuS5iSAqL1xuZnVuY3Rpb24gaW5mZXJUc1R5cGUodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gJ2FueSc7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5sZW5ndGggPiAwID8gYCR7aW5mZXJUc1R5cGUodmFsdWVbMF0pfVtdYCA6ICdhbnlbXSc7XG4gICAgfVxuICAgIHN3aXRjaCAodHlwZW9mIHZhbHVlKSB7XG4gICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICByZXR1cm4gJ251bWJlcic7XG4gICAgICAgIGNhc2UgJ3N0cmluZyc6XG4gICAgICAgICAgICByZXR1cm4gJ3N0cmluZyc7XG4gICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgcmV0dXJuICdib29sZWFuJztcbiAgICAgICAgY2FzZSAnZnVuY3Rpb24nOlxuICAgICAgICAgICAgcmV0dXJuICdGdW5jdGlvbic7XG4gICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHJldHVybiAnYW55JztcbiAgICB9XG4gICAgY29uc3Qgb2JqID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgbGV0IGN0b3JOYW1lID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY3RvciA9IChvYmogYXMgeyBjb25zdHJ1Y3Rvcj86IHsgbmFtZT86IHN0cmluZyB9IH0pLmNvbnN0cnVjdG9yO1xuICAgICAgICBjdG9yTmFtZSA9IGN0b3IgJiYgdHlwZW9mIGN0b3IubmFtZSA9PT0gJ3N0cmluZycgPyBjdG9yLm5hbWUgOiAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgY3Rvck5hbWUgPSAnJztcbiAgICB9XG4gICAgaWYgKCFjdG9yTmFtZSB8fCBjdG9yTmFtZSA9PT0gJ09iamVjdCcpIHJldHVybiAnb2JqZWN0JztcbiAgICAvLyDlvJXmk47mlbDlraYv6LWE5rqQ57G75Z6L6YO95bimIGNjLiDliY3nvIDmm7TliKnkuo4gQUkg5YaZ5Luj56CBXG4gICAgaWYgKHR5cGVvZiBvYmoudXVpZCA9PT0gJ3N0cmluZycpIHJldHVybiBgY2MuJHtjdG9yTmFtZX0gLyogYXNzZXQgKi9gO1xuICAgIHJldHVybiBgY2MuJHtjdG9yTmFtZX1gO1xufVxuXG4vKiog5Y+W5LiA5Liq5a+56LGh5LiK55qE5Y+v5p6a5Li+6Ieq5pyJ6ZSu77yIZ2V0dGVyIOaKm+W8guW4uOaXtui3s+i/h++8iSAqL1xuZnVuY3Rpb24gc2FmZUtleXModGFyZ2V0OiBhbnkpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKHRhcmdldCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhZmVSZWFkKHRhcmdldDogYW55LCBrZXk6IHN0cmluZyk6IHsgb2s6IGJvb2xlYW47IHZhbHVlPzogdW5rbm93biB9IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHRhcmdldFtrZXldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgIH1cbn1cblxuLyoqIOe7hOS7tueahOW6j+WIl+WMluWxnuaAp+WQjeWIl+ihqO+8muS8mOWFiOeUqCBDb2NvcyDnmoQgYF9fcHJvcHNfX2AgKi9cbmZ1bmN0aW9uIGNvbXBvbmVudFByb3BOYW1lcyhjb21wOiBhbnkpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgY3RvciA9IGNvbXAgJiYgY29tcC5jb25zdHJ1Y3RvcjtcbiAgICBjb25zdCBkZWNsYXJlZCA9IGN0b3IgJiYgQXJyYXkuaXNBcnJheShjdG9yLl9fcHJvcHNfXykgPyAoY3Rvci5fX3Byb3BzX18gYXMgc3RyaW5nW10pIDogbnVsbDtcbiAgICBpZiAoZGVjbGFyZWQgJiYgZGVjbGFyZWQubGVuZ3RoID4gMCkgcmV0dXJuIGRlY2xhcmVkLnNsaWNlKCk7XG4gICAgcmV0dXJuIHNhZmVLZXlzKGNvbXApLmZpbHRlcigoaykgPT4gayAhPT0gJ25vZGUnICYmIGsgIT09ICd1dWlkJyAmJiAhay5zdGFydHNXaXRoKCdfJykpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWcuuaZr+inhuWbvuaIquWbvu+8iGNhcHR1cmVWaWV3IOeahOWunueOsO+8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8g5Li65LuA5LmI6KaB6L+Z5Liq6IO95Yqb77ya5pS55a6M6IqC54K55qCRL+W4g+WxgOS5i+WQju+8jCoq5Z2Q5qCH5pWw5a2X55yL5LiN5Ye644CM5Y+g5Zyo5LiA6LW344CN44CM6LS05Zu+5piv56m655qE44CNXG4vLyDjgIzkuIDlsY/lj6rmnInkuKrop5LjgI0qKuOAguacieS6huWug++8jEFJIOWPr+S7peiHquW3seeci+S4gOecvOeUu+mdouWGjeWGs+WumuS4i+S4gOatpe+8jOiAjOS4jeaYr+aLv+S4gOS4siByZWN0XG4vLyDljrvnjJzvvIzkuZ/kuI3mmK/miornlKjmiLflvZPpqozlm77lt6XlhbfjgIJcbi8vXG4vLyDkuKTmnaHlrp7njrDlj6PlvoTvvJpcbi8vIDEuICoq5Zyo5byV5pOO55S75a6M6L+Z5LiA5bin5LmL5ZCO6K+75YOP57SgKirvvIhgRVZFTlRfQUZURVJfRFJBV2DvvInjgIJXZWJHTCDnmoTnu5jliLbnvJPlhrLlnKjlkIjmiJDlkI5cbi8vICAgIOWNs+WkseaViO+8iGBwcmVzZXJ2ZURyYXdpbmdCdWZmZXJgIOm7mOiupCBmYWxzZe+8ie+8jOW4p+Wkluivu+WPquS8muW+l+WIsOS4gOW8oOepuuWbvuOAglxuLy8gMi4gKirkvJjlhYjoh6rlt7HokL3nm5gqKu+8muacrOaWh+S7tuaYr+WcuuaZr+i/m+eoi+mHjOeahCBDSlMg5qih5Z2X77yMYGZzYCDlnKgqKuaooeWdl+S9nOeUqOWfnyoq6YeM5Y+v6KeBXG4vLyAgICDvvIjmspnnrrHph4znnIvkuI3liLAgYHJlcXVpcmVg77yM5L2G5Yqp5omL5Ye95pWw55qE6Zet5YyF55yL5b6X5Yiw77yJ44CC5YaZ5LiN5LqG55uY5omN5Zue6JC944CM5YiG5Z2X5Zue5Lyg44CN77yMXG4vLyAgICDnlLHkuLvov5vnqIvmi7zlm57ljrvokL3nm5gg4oCU4oCUIOWboOS4uuaymeeusei/lOWbnuWAvOacieOAjOWNleWtl+espuS4siA0MDAwIOWtl+OAjeeahOS4iumZkOOAglxuXG4vKiogTm9kZSDkvqfmqKHlnZfvvIjmi7/kuI3liLDlsLHov5Tlm54gbnVsbO+8jOiwg+eUqOaWueWbnuiQveWIsOWIhuWdl+WbnuS8oO+8ieOAgiAqL1xubGV0IG5vZGVNb2R1bGVzQ2FjaGU6IHsgZnM6IGFueTsgcGF0aDogYW55OyBvczogYW55IH0gfCBudWxsIHwgdW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBnZXROb2RlTW9kdWxlcygpOiB7IGZzOiBhbnk7IHBhdGg6IGFueTsgb3M6IGFueSB9IHwgbnVsbCB7XG4gICAgaWYgKG5vZGVNb2R1bGVzQ2FjaGUgIT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vZGVNb2R1bGVzQ2FjaGU7XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbiAgICAgICAgbm9kZU1vZHVsZXNDYWNoZSA9IHsgZnM6IHJlcXVpcmUoJ2ZzJyksIHBhdGg6IHJlcXVpcmUoJ3BhdGgnKSwgb3M6IHJlcXVpcmUoJ29zJykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgbm9kZU1vZHVsZXNDYWNoZSA9IG51bGw7XG4gICAgfVxuICAgIHJldHVybiBub2RlTW9kdWxlc0NhY2hlO1xufVxuXG4vKiog5Zy65pmv6KeG5Zu+55qE6YKj5Z2X55S75biD77ya5LyY5YWI5byV5pOO6Ieq5bex55qEIGNhbnZhc++8jOWFtuasoemhtemdouS4iumdouenr+acgOWkp+eahCBjYW52YXPjgIIgKi9cbmZ1bmN0aW9uIGZpbmRWaWV3Q2FudmFzKGNjOiBhbnkpOiBhbnkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IGFueVtdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNjLmdhbWUgJiYgY2MuZ2FtZS5jYW52YXMpIGNhbmRpZGF0ZXMucHVzaChjYy5nYW1lLmNhbnZhcyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpe+8muW8leaTjueJiOacrOW3ruW8giAqL1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIGRvY3VtZW50ICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKC4uLkFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnY2FudmFzJykpKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlv73nlaXvvJrkuI3mmK/mtY/op4jlmajnjq/looMgKi9cbiAgICB9XG4gICAgY29uc3QgdXNhYmxlID0gY2FuZGlkYXRlcy5maWx0ZXIoXG4gICAgICAgIChjKSA9PiBjICYmIHR5cGVvZiBjLmdldENvbnRleHQgPT09ICdmdW5jdGlvbicgJiYgYy53aWR0aCA+IDAgJiYgYy5oZWlnaHQgPiAwLFxuICAgICk7XG4gICAgaWYgKHVzYWJsZS5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgIHJldHVybiB1c2FibGUuc29ydCgoYSwgYikgPT4gYi53aWR0aCAqIGIuaGVpZ2h0IC0gYS53aWR0aCAqIGEuaGVpZ2h0KVswXTtcbn1cblxuLyoqXG4gKiDmiqXlh7rjgIzlnLrmma/op4blm77njrDlnKjmmK/mgI7kuYjlj5bmma/nmoTjgI3igJTigJQgKirnqbrnmb3luKfnmoTkuIDljYrnrZTmoYjlnKjov5nph4wqKuOAglxuICpcbiAqIOS4uuS7gOS5iOimgeacieWug++8muWunua1i+WHuui/h+S4gOasoeS6i+aVhe+8iDIwMjYtMDktMzAgMDA6NDkg6YKj5p2h5Lya6K+d77yJ77yM5qih5Z6L5Li65LqG44CM5qih5ouf6K6+5aSH6auY5bqm6aqM6YCC6YWN44CNXG4gKiDosIPkuoYgYGNjLnZpZXcuc2V0RGVzaWduUmVzb2x1dGlvblNpemVg77yM5oqK57yW6L6R5ZmoKirlnLrmma/op4blm77nmoTorr7lpIfmqKHmi5/miZPmjokqKuS6hu+8mlxuICogYHZpc2libGVgIOS7jiA3NTDDlzEzMzQg5Y+Y5oiQIDc1MMOXNTU5LjM177yM5q2k5ZCO5q+P5LiA5qyhIGBjYXB0dXJlX3ZpZXdgIOmDveWPquaLv+WIsCBgYmxhbmtSYXRpbzogMWBcbiAqIOeahOeZvee6uCDigJTigJQg6ICMKirov5nkuKrlt67lvILmmK/lj6/ku6Xnm7TmjqXph4/lh7rmnaXnmoQqKuOAguaKiuWug+aKpeWHuuadpe+8jOaooeWei+WwseS4jeeUqOmdoOeMnO+8jFxuICog5Lmf5LiN55So5YOP6YKj5qyh5LiA5qC36Ieq5bu65LiA5aWX56a75bGP5riy5p+T5Zmo77yIMTYg5q2l77yJ5Y675pu/5Luj5LiA5LiqXCLooqvoh6rlt7HlvITlnY9cIueahOmAmumBk+OAglxuICpcbiAqIEBwYXJhbSBjYyAtIOW8leaTjuaooeWdl+OAglxuICogQHBhcmFtIGNhbnZhcyAtIOWcuuaZr+inhuWbvueUu+W4g+OAglxuICogQHJldHVybnMg6KeG5Zu+54q25oCB77yb5Y+W5LiN5Yiw55qE6aG55LiN5Ye6546w77yI5byV5pOO54mI5pys5beu5byC5LiN6Zi75pat5oiq5Zu+5pys6Lqr77yJ44CCXG4gKi9cbmZ1bmN0aW9uIHJlYWRWaWV3U3RhdGUoY2M6IGFueSwgY2FudmFzOiBhbnkpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgcm91bmQgPSAodmFsdWU6IHVua25vd24pOiBudW1iZXIgfCBudWxsID0+XG4gICAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgucm91bmQodmFsdWUgKiAxMDApIC8gMTAwIDogbnVsbDtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmlldyA9IGNjLnZpZXc7XG4gICAgICAgIGlmICh2aWV3KSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZpZXcuZ2V0VmlzaWJsZVNpemUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzaXplID0gdmlldy5nZXRWaXNpYmxlU2l6ZSgpO1xuICAgICAgICAgICAgICAgIGlmIChzaXplKSBvdXQudmlzaWJsZVNpemUgPSB7IHdpZHRoOiByb3VuZChzaXplLndpZHRoKSwgaGVpZ2h0OiByb3VuZChzaXplLmhlaWdodCkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2Ygdmlldy5nZXREZXNpZ25SZXNvbHV0aW9uU2l6ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNpemUgPSB2aWV3LmdldERlc2lnblJlc29sdXRpb25TaXplKCk7XG4gICAgICAgICAgICAgICAgaWYgKHNpemUpIG91dC5kZXNpZ25SZXNvbHV0aW9uID0geyB3aWR0aDogcm91bmQoc2l6ZS53aWR0aCksIGhlaWdodDogcm91bmQoc2l6ZS5oZWlnaHQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIHZpZXcuZ2V0U2NhbGVYID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgb3V0LnNjYWxlID0geyB4OiByb3VuZCh2aWV3LmdldFNjYWxlWCgpKSwgeTogcm91bmQodmlldy5nZXRTY2FsZVkoKSkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlvJXmk47niYjmnKzlt67lvILvvJrmi7/kuI3liLDlsLHkuI3miqXvvIzkuI3lvbHlk43miKrlm74gKi9cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNhbnZhcykgb3V0LmNhbnZhcyA9IHsgd2lkdGg6IGNhbnZhcy53aWR0aCwgaGVpZ2h0OiBjYW52YXMuaGVpZ2h0IH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICAvKiog5LiO6K6+6K6h5YiG6L6o546H5LiN5LiA6Ie0ID0g5ri45oiP5L6n5Y+W5pmv5LiN5piv6K6+6K6h5qGj77yI4pqgIOWcuuaZr+inhuWbvuaYr+iHqueUseebuOacuu+8jOeUqOaIt+e8qeaUvuS5n+S8muiuqeWug+WPmO+8jOaJgOS7pei/meWPquaYr+e6v+e0ouS4jeaYr+WIpOaNru+8iSAqL1xuICAgIGNvbnN0IHZpc2libGUgPSBvdXQudmlzaWJsZVNpemUgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRlc2lnbiA9IG91dC5kZXNpZ25SZXNvbHV0aW9uIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IHVuZGVmaW5lZDtcbiAgICBpZiAodmlzaWJsZSAmJiBkZXNpZ24gJiYgdHlwZW9mIGRlc2lnbi5oZWlnaHQgPT09ICdudW1iZXInICYmIGRlc2lnbi5oZWlnaHQgPiAwKSB7XG4gICAgICAgIG91dC52aXNpYmxlTWF0Y2hlc0Rlc2lnbiA9IE1hdGguYWJzKHZpc2libGUuaGVpZ2h0IC0gZGVzaWduLmhlaWdodCkgLyBkZXNpZ24uaGVpZ2h0IDw9IDAuMDU7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog562J5byV5pOO55S75a6M5LiA5bin77yM54S25ZCO5LuO6buY6K6k5bin57yT5Yay6K+75Zue5YOP57Sg44CCXG4gKlxuICogQHBhcmFtIHdhaXRNcyDnrYnkuI3liLAgYEVWRU5UX0FGVEVSX0RSQVdgIOaXtueahOWFnOW6leS4iumZkO+8iOWcuuaZr+inhuWbvuWPr+iDveayoeWcqOa4suafk++8iVxuICovXG5mdW5jdGlvbiByZWFkVmlld1BpeGVscyhcbiAgICBjYzogYW55LFxuICAgIGNhbnZhczogYW55LFxuICAgIHdhaXRNczogbnVtYmVyLFxuKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBwaXhlbHM6IFVpbnQ4QXJyYXkgfT4ge1xuICAgIGNvbnN0IGdyYWIgPSAoKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgcGl4ZWxzOiBVaW50OEFycmF5IH0gPT4ge1xuICAgICAgICBjb25zdCBnbCA9XG4gICAgICAgICAgICBjYW52YXMuZ2V0Q29udGV4dCgnd2ViZ2wyJykgfHxcbiAgICAgICAgICAgIGNhbnZhcy5nZXRDb250ZXh0KCd3ZWJnbCcpIHx8XG4gICAgICAgICAgICBjYW52YXMuZ2V0Q29udGV4dCgnZXhwZXJpbWVudGFsLXdlYmdsJyk7XG4gICAgICAgIGlmICghZ2wpIHRocm93IG5ldyBFcnJvcign55S75biD5LiK5rKh5pyJIFdlYkdMIOS4iuS4i+aWh++8iDJEIOeUu+W4g+S4jeaUr+aMgei/meS5iOaIquWbvu+8iScpO1xuICAgICAgICBjb25zdCB3aWR0aCA9IGdsLmRyYXdpbmdCdWZmZXJXaWR0aCB8fCBjYW52YXMud2lkdGg7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IGdsLmRyYXdpbmdCdWZmZXJIZWlnaHQgfHwgY2FudmFzLmhlaWdodDtcbiAgICAgICAgaWYgKCF3aWR0aCB8fCAhaGVpZ2h0KSB0aHJvdyBuZXcgRXJyb3IoJ+eUu+W4g+WwuuWvuOS4uiAw77yM5oiq5LiN5Yiw5Lic6KW/Jyk7XG4gICAgICAgIGNvbnN0IHBpeGVscyA9IG5ldyBVaW50OEFycmF5KHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICAgIC8vIOW8leaTjuWPr+iDveeVmeedgOWIq+eahCBGQk8g57uR5a6aIOKAlOKAlCDor7vpu5jorqTluKfnvJPlhrLliY3mmL7lvI/op6Pnu5FcbiAgICAgICAgZ2wuYmluZEZyYW1lYnVmZmVyKGdsLkZSQU1FQlVGRkVSLCBudWxsKTtcbiAgICAgICAgZ2wucmVhZFBpeGVscygwLCAwLCB3aWR0aCwgaGVpZ2h0LCBnbC5SR0JBLCBnbC5VTlNJR05FRF9CWVRFLCBwaXhlbHMpO1xuICAgICAgICByZXR1cm4geyB3aWR0aCwgaGVpZ2h0LCBwaXhlbHMgfTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgICAgY29uc3Qgc2V0dGxlID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGZuKCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGV2ZW50ID0gY2MuRGlyZWN0b3IgJiYgY2MuRGlyZWN0b3IuRVZFTlRfQUZURVJfRFJBVztcbiAgICAgICAgICAgIGlmIChldmVudCAmJiBjYy5kaXJlY3RvciAmJiB0eXBlb2YgY2MuZGlyZWN0b3Iub25jZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNjLmRpcmVjdG9yLm9uY2UoZXZlbnQsICgpID0+IHNldHRsZSgoKSA9PiByZXNvbHZlKGdyYWIoKSkpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlm57okL3vvJrnm7TmjqXmipPlvZPliY3nvJPlhrIgKi9cbiAgICAgICAgfVxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHNldHRsZSgoKSA9PiByZXNvbHZlKGdyYWIoKSkpLCB3YWl0TXMpO1xuICAgIH0pO1xufVxuXG4vKiog5oq95qC35Lyw566X44CM5Yeg5LmO5piv56m65Zu+44CN55qE5q+U5L6L77yI5YWo6YCP5piO5oiW57qv6buR6YO9566X56m677yJ4oCU4oCUIOeUqOadpeWPkeeOsFwi5oiq5Ye65p2l5piv5byg55m957q4XCLjgIIgKi9cbmZ1bmN0aW9uIHNhbXBsZUJsYW5rUmF0aW8ocGl4ZWxzOiBVaW50OEFycmF5KTogbnVtYmVyIHtcbiAgICBjb25zdCB0b3RhbCA9IE1hdGguZmxvb3IocGl4ZWxzLmxlbmd0aCAvIDQpO1xuICAgIGlmICh0b3RhbCA8PSAwKSByZXR1cm4gMTtcbiAgICBjb25zdCBzdGVwID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcih0b3RhbCAvIDUxMikpO1xuICAgIGxldCBzYW1wbGVkID0gMDtcbiAgICBsZXQgYmxhbmsgPSAwO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWw7IGkgKz0gc3RlcCkge1xuICAgICAgICBjb25zdCBvID0gaSAqIDQ7XG4gICAgICAgIHNhbXBsZWQgKz0gMTtcbiAgICAgICAgaWYgKHBpeGVsc1tvICsgM10gPT09IDAgfHwgKHBpeGVsc1tvXSA9PT0gMCAmJiBwaXhlbHNbbyArIDFdID09PSAwICYmIHBpeGVsc1tvICsgMl0gPT09IDApKSBibGFuayArPSAxO1xuICAgIH1cbiAgICByZXR1cm4gc2FtcGxlZCA+IDAgPyBNYXRoLnJvdW5kKChibGFuayAvIHNhbXBsZWQpICogMTAwMCkgLyAxMDAwIDogMTtcbn1cblxuLyoqIOaKiiBSR0JBIOWDj+e0oOe8lueggeaIkCBkYXRhIFVSTO+8iFdlYkdMIOWOn+eCueWcqOW3puS4i++8jOmcgOimgee/u+ihjO+8ieOAgiAqL1xuZnVuY3Rpb24gZW5jb2RlRnJhbWVUb0RhdGFVcmwoXG4gICAgcGl4ZWxzOiBVaW50OEFycmF5LFxuICAgIHdpZHRoOiBudW1iZXIsXG4gICAgaGVpZ2h0OiBudW1iZXIsXG4gICAgb3B0czogeyBtYXhXaWR0aDogbnVtYmVyOyBtaW1lOiBzdHJpbmc7IHF1YWxpdHk6IG51bWJlciB9LFxuKTogeyBkYXRhVXJsOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0ge1xuICAgIGlmICh0eXBlb2YgZG9jdW1lbnQgPT09ICd1bmRlZmluZWQnIHx8IHR5cGVvZiBkb2N1bWVudC5jcmVhdGVFbGVtZW50ICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN546v5aKD5rKh5pyJIGRvY3VtZW50LmNyZWF0ZUVsZW1lbnTvvIzml6Dms5Xmiorlg4/ntKDnvJbnoIHmiJDlm77niYcnKTtcbiAgICB9XG4gICAgY29uc3Qgc3JjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgc3JjLndpZHRoID0gd2lkdGg7XG4gICAgc3JjLmhlaWdodCA9IGhlaWdodDtcbiAgICBjb25zdCBjdHggPSBzcmMuZ2V0Q29udGV4dCgnMmQnKTtcbiAgICBpZiAoIWN0eCkgdGhyb3cgbmV3IEVycm9yKCfmi7/kuI3liLAgMkQg55S75biD5LiK5LiL5paHJyk7XG5cbiAgICBjb25zdCBpbWFnZSA9IGN0eC5jcmVhdGVJbWFnZURhdGEod2lkdGgsIGhlaWdodCk7XG4gICAgY29uc3Qgcm93Qnl0ZXMgPSB3aWR0aCAqIDQ7XG4gICAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkgKz0gMSkge1xuICAgICAgICBjb25zdCBmcm9tID0gKGhlaWdodCAtIDEgLSB5KSAqIHJvd0J5dGVzO1xuICAgICAgICBpbWFnZS5kYXRhLnNldChwaXhlbHMuc3ViYXJyYXkoZnJvbSwgZnJvbSArIHJvd0J5dGVzKSwgeSAqIHJvd0J5dGVzKTtcbiAgICB9XG4gICAgY3R4LnB1dEltYWdlRGF0YShpbWFnZSwgMCwgMCk7XG5cbiAgICBsZXQgb3V0OiBhbnkgPSBzcmM7XG4gICAgaWYgKG9wdHMubWF4V2lkdGggPiAwICYmIHdpZHRoID4gb3B0cy5tYXhXaWR0aCkge1xuICAgICAgICBjb25zdCBzY2FsZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICAgICAgc2NhbGVkLndpZHRoID0gb3B0cy5tYXhXaWR0aDtcbiAgICAgICAgc2NhbGVkLmhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKGhlaWdodCAqIG9wdHMubWF4V2lkdGgpIC8gd2lkdGgpKTtcbiAgICAgICAgY29uc3Qgc2N0eCA9IHNjYWxlZC5nZXRDb250ZXh0KCcyZCcpO1xuICAgICAgICBpZiAoc2N0eCkge1xuICAgICAgICAgICAgc2N0eC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBzY3R4LmltYWdlU21vb3RoaW5nUXVhbGl0eSA9ICdoaWdoJztcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8qIOiAgea1j+iniOWZqOS4jeaUr+aMgeWwseeul+S6hiAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2N0eC5kcmF3SW1hZ2Uoc3JjLCAwLCAwLCBzY2FsZWQud2lkdGgsIHNjYWxlZC5oZWlnaHQpO1xuICAgICAgICAgICAgb3V0ID0gc2NhbGVkO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IGRhdGFVcmw6IG91dC50b0RhdGFVUkwob3B0cy5taW1lLCBvcHRzLnF1YWxpdHkpLCB3aWR0aDogb3V0LndpZHRoLCBoZWlnaHQ6IG91dC5oZWlnaHQgfTtcbn1cblxuaW50ZXJmYWNlIEhlbHBlckJ1bmRsZSB7XG4gICAgaGVscGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgc3RhdGU6IHsgc25hcHNob3RSZXF1ZXN0ZWQ6IGJvb2xlYW4gfTtcbn1cblxuLyoqXG4gKiDmnoTpgKDms6jlhaXmspnnrrHnmoTliqnmiYvlh73mlbDjgIJcbiAqXG4gKiDov5nkupvmmK/jgIxBSSDlhpnku6PnoIHml7bnmoTotbfmiYvlvI/jgI3igJTigJTmsqHmnInlroPku6zvvIzmqKHlnovmr4/mrKHpg73opoHku45cbiAqIGBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpYCDlvIDlp4vmiYvmkJPpgY3ljobvvIzml6LotLkgdG9rZW4g5Y+I5a655piT5YaZ6ZSZ44CCXG4gKi9cbmZ1bmN0aW9uIG1ha2VIZWxwZXJzKGNjOiBhbnksIG9wdGlvbnM/OiB7IHByb2plY3RQYXRoPzogc3RyaW5nIH0pOiBIZWxwZXJCdW5kbGUge1xuICAgIGNvbnN0IHN0YXRlID0geyBzbmFwc2hvdFJlcXVlc3RlZDogZmFsc2UgfTtcblxuICAgIGNvbnN0IGhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgICAvKipcbiAgICAgKiDlt6XnqIvmoLkg4oCU4oCUICoq5LyY5YWI55So5Li76L+b56iL6ZqPIHBheWxvYWQg5Lyg6L+b5p2l55qE6YKj5LiqKirvvIhgRWRpdG9yLlByb2plY3QucGF0aGDvvInvvIxcbiAgICAgKiDmi7/kuI3liLDlho3pgIDlm54gYGN1cnJlbnRQcm9qZWN0UGF0aCgpYO+8iOWcuuaZr+i/m+eoi+mHjOeahCBgRWRpdG9yYCDlhajlsYDph4/vvInjgIJcbiAgICAgKiDkuKTkuKrpg73msqHmnInml7blj6rlvbHlk43jgIzmjInot6/lvoTop6PmnpDotYTmupDjgI3ov5nkuIDku7bkuovvvIzlhbbkvZnliqnmiYvnhafluLjjgIJcbiAgICAgKi9cbiAgICBjb25zdCBwcm9qZWN0Um9vdCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgICAgICBjb25zdCBmcm9tUGF5bG9hZCA9IHR5cGVvZiBvcHRpb25zPy5wcm9qZWN0UGF0aCA9PT0gJ3N0cmluZycgPyBvcHRpb25zLnByb2plY3RQYXRoIDogJyc7XG4gICAgICAgIHJldHVybiBmcm9tUGF5bG9hZCB8fCBjdXJyZW50UHJvamVjdFBhdGgoKTtcbiAgICB9O1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyDnvJbovpHlmajoo4XppbDoioLngrnliKTmja4g4oCU4oCUIOWcuuaZr+agkemHjCA5NyUg55qE6IqC54K55LiN5piv5L2g55qE5YaF5a65XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvL1xuICAgIC8vIOWcuuaZr+i/m+eoi+mHjCBgZGlyZWN0b3IuZ2V0U2NlbmUoKWAg5ou/5Yiw55qE5qCRKirljIXlkKvnvJbovpHlmajoh6rlt7HmjILnmoQgZ2l6bW8gLyDnvZHmoLwgL1xuICAgIC8vIOWPguiAg+Wbvioq44CC5a6e5rWL77yIQ29jb3MgMy44LjbvvIzkuIDkuKrlj6rmnIkgQ2FudmFzIOeahOepuuWcuuaZr++8ie+8mlxuICAgIC8vXG4gICAgLy8gICAgIOaAu+iKgueCuSAxMjhcbiAgICAvLyAgICAg4pSc4pSAIENhbnZhcyAgICAgICAgICAgICAgICAgICAgICAgIDIgICDihpAg5ZSv5LiA55qE55yf5a6e5YaF5a65XG4gICAgLy8gICAgIOKUnOKUgCBFZGl0b3IgU2NlbmUgRm9yZWdyb3VuZCAgICAgMTE3ICAg4oaQIOWdkOagh+i9tCBnaXptbyAvIOe9keagvCAvIOWQhOenjeaOp+WItuWZqFxuICAgIC8vICAgICDilJTilIAgRWRpdG9yIFNjZW5lIEJhY2tncm91bmQgICAgICAgOCAgIOKGkCDog4zmma/kuI7lj4LogIPlm75cbiAgICAvL1xuICAgIC8vIOS4jea7pOaOieeahOivnSBgZWFjaE5vZGVgIC8gYHRyZWUoKWAg6YeMIDk3JSDmmK/lmarlo7DvvIzmqKHlnovkvJrnhafnnYAgZ2l6bW8g55qE6IqC54K55ZCNXG4gICAgLy8g77yIYHhBeGlzYCAvIGBSZWN0YW5nbGVgIC8gYFBsYW5lYCAvIGBMaW5lc05vZGVg4oCm77yJ5Y675o6o5pat5ri45oiP57uT5p6E44CCXG4gICAgLy9cbiAgICAvLyAjIyDkuKTmnaHooqvlrp7mtYvlkKbmjonnmoTnm7Top4lcbiAgICAvL1xuICAgIC8vIOKdjCAqKuaMiSBsYXllciDmjqnnoIHmu6QqKu+8muS4jeihjOOAgue8lui+keWZqOaguSBgRWRpdG9yIFNjZW5lIEZvcmVncm91bmRgIOS4juecn+WunuebuOaculxuICAgIC8vICAgIGBDYW52YXMvQ2FtZXJhYCAqKuWQjOS4uiBgTGF5ZXJzLkRFRkFVTFRgKDEwNzM3NDE4MjQpKirvvJtHSVpNT1MvRURJVE9SIOS9jeWPquimhuebllxuICAgIC8vICAgIOWtkOagkeeahOS4gOmDqOWIhu+8iOi/mOaciSA1MjQyODgw44CBMTY3NzcyMTYg562J5re35ZCI5YC877yJ4oCU4oCUIOaMieWxgua7pOS8muivr+S8pOecn+WunuiKgueCueOAglxuICAgIC8vIOKdjCAqKuaMiSBgZ2l6bW9Sb290YCDov5nnsbvlkI3lrZfmu6QqKu+8muS4jeihjOOAguWQjeWtl+aYr+WunueOsOe7huiKgu+8jOiAjOS4lOimhuebluS4jeS6hiBCYWNrZ3JvdW5kIOmCo+ajteOAglxuICAgIC8vXG4gICAgLy8g4pyFICoq5oyJIGBIaWRlSW5IaWVyYXJjaHlgIOS9jea7pCoq77yIPSDnvJbovpHlmajoh6rlt7HjgIzliKvlnKjlsYLnuqfpnaLmnb/ph4zmmL7npLrmiJHjgI3nmoTmoIforrDvvIxcbiAgICAvLyAgICDor63kuYnmraPlpb3lsLHmmK/opoHnmoTov5nkuKrvvInjgILlrp7mtYvkuKTkuKrnvJbovpHlmajmoLnnmoQgYG9iakZsYWdzYCDpg73mmK9cbiAgICAvLyAgICBgMTA5NiA9IEhpZGVJbkhpZXJhcmNoeXxEb250RGVzdHJveXxEb250U2F2ZWDvvIzogIznnJ/lrp7oioLngrnvvIjlkKsgQ2FtZXJh77yJ5pivIDDjgIJcbiAgICAvL1xuICAgIC8vIOKaoCDlhbPplK7nu4boioLvvJrov5nkuKrkvY0qKuWPquWcqOS4pOS4quagueS4iioq77yMYGdpem1vUm9vdGAg6Ieq6Lqr55qEIGBvYmpGbGFnc2Ag5pivIDAg4oCU4oCUXG4gICAgLy8gICAg5omA5Lul5Yik5o2u5b+F6aG755So5ZyoKirliarmnp0qKuS4iu+8iOWJquaOieague+8jOaVtOajteWtkOagkeiHqueEtumDveayoeS6hu+8ie+8jFxuICAgIC8vICAgIOiAjOS4jeaYr+mAkOiKgueCuei/h+a7pO+8iOmAkOiKgueCueS8mueVmeS4iyBnaXptb1Jvb3Qg6YKj5LiA5pW05qO177yJ44CCXG4gICAgY29uc3QgaGlkZUluSGllcmFyY2h5ID0gKCgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGZsYWdzID0gY2MuQ0NPYmplY3QgJiYgY2MuQ0NPYmplY3QuRmxhZ3M7XG4gICAgICAgICAgICBpZiAoZmxhZ3MgJiYgdHlwZW9mIGZsYWdzLkhpZGVJbkhpZXJhcmNoeSA9PT0gJ251bWJlcicpIHJldHVybiBmbGFncy5IaWRlSW5IaWVyYXJjaHk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5byV5pOO54mI5pys5Y+Y5Yqo5pe25Zue6JC95YiwIDMuOC42IOeahOWunua1i+WAvCAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiAxMDI0O1xuICAgIH0pKCk7XG5cbiAgICAvKiog5ZCN5a2X5YWc5bqV77ya5LiH5LiA5ZOq5aSpIGBGbGFncy5IaWRlSW5IaWVyYXJjaHlgIOaMquS9jeS6hu+8jOi/meS4pOS4quaguei/mOiDveiiq+iupOWHuuadpSAqL1xuICAgIGNvbnN0IGVkaXRvclJvb3ROYW1lcyA9IFsnRWRpdG9yIFNjZW5lIEZvcmVncm91bmQnLCAnRWRpdG9yIFNjZW5lIEJhY2tncm91bmQnXTtcblxuICAgIGNvbnN0IGlzRWRpdG9yTm9kZSA9IChub2RlOiBhbnkpOiBib29sZWFuID0+IHtcbiAgICAgICAgaWYgKCFub2RlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBgaGlkZUZsYWdzYCDmmK8gQ0NPYmplY3Qg55qE5YWs5byA6K6/6Zeu5Zmo77yI5YaF6YOo5beyICYgQWxsSGlkZU1hc2tz77yJ77yM5LyY5YWI55So5a6DXG4gICAgICAgICAgICBjb25zdCBmbGFncyA9XG4gICAgICAgICAgICAgICAgdHlwZW9mIG5vZGUuaGlkZUZsYWdzID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgICAgICA/IG5vZGUuaGlkZUZsYWdzXG4gICAgICAgICAgICAgICAgICAgIDogdHlwZW9mIG5vZGUuX29iakZsYWdzID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgICAgICAgID8gbm9kZS5fb2JqRmxhZ3NcbiAgICAgICAgICAgICAgICAgICAgICA6IDA7XG4gICAgICAgICAgICBpZiAoKGZsYWdzICYgaGlkZUluSGllcmFyY2h5KSAhPT0gMCkgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5Y+W5LiN5Yiw5qCH5b+X5L2N5bCx5Y+q5Ymp5ZCN5a2X5YWc5bqVICovXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGVkaXRvclJvb3ROYW1lcy5pbmRleE9mKG5vZGUubmFtZSkgPj0gMDtcbiAgICB9O1xuXG4gICAgLyoqIOWtkOiKgueCuemHjOWxnuS6juOAjOecn+WunuWGheWuueOAjeeahOmCo+S6myAqL1xuICAgIGNvbnN0IGNvbnRlbnRDaGlsZHJlbiA9IChub2RlOiBhbnkpOiBhbnlbXSA9PiB7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuOiBhbnlbXSA9IChub2RlICYmIG5vZGUuY2hpbGRyZW4pIHx8IFtdO1xuICAgICAgICByZXR1cm4gY2hpbGRyZW4uZmlsdGVyKChjaGlsZDogYW55KSA9PiAhaXNFZGl0b3JOb2RlKGNoaWxkKSk7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOaMiSBgL2Ag5YiG5q616Kej5p6Q6Lev5b6E44CCXG4gICAgICpcbiAgICAgKiAqKuS4uuS7gOS5iOS4jeiDveWPqueUqCBgY2MuZmluZGAqKu+8mmBjYy5maW5kKCdhL2InKWAg5piv5oyJIGAvYCDliIflvIDpgJDlsYLmib7lrZDoioLngrnvvIxcbiAgICAgKiDkuo7mmK8qKuiKgueCueWQjemHjOWQqyBgL2Ag55qE6Lev5b6E5rC46L+c5om+5LiN5YiwKirjgILlrp7mtYvlt6XnqIvph4zlsLHlrZjlnKhcbiAgICAgKiBgaW50ZXJuYWwvZWRpdG9yL2dyaWQtMmRgIOS4jiBgaW50ZXJuYWwvZWRpdG9yL2dyaWRgIOi/meenjeWQjeWtl1xuICAgICAqIO+8iOe8lui+keWZqOiHquW3seeUn+aIkOeahO+8ie+8jGBjYy5maW5kYCDlr7nlroPku6zkuIDlvovov5Tlm54gbnVsbCDigJTigJQg6ICM5LiUKirpnZnpu5jov5Tlm54gbnVsbCoq77yMXG4gICAgICog6LCD55So5pa55Y+q5Lya5Lul5Li6XCLoioLngrnkuI3lrZjlnKhcIuOAglxuICAgICAqXG4gICAgICog6L+Z6YeM5pS55oiQKirotKrlv4PmjInmrrXljLnphY0qKu+8muavj+WxguS7juOAjOacgOmVv+eahOS4gOauteOAjeW8gOWni+ivle+8jOWFiOaKiiBgaW50ZXJuYWwvZWRpdG9yL2dyaWQtMmRgXG4gICAgICog5pW05L2T5b2T5oiQ5LiA5Liq6IqC54K55ZCN5Y676K+V77yM5LiN6KGM5YaN6YCA5YyW5oiQIGBpbnRlcm5hbGAg4oaSIGBlZGl0b3JgIOKGkiBgZ3JpZC0yZGAg5LiJ5bGC44CCXG4gICAgICog5Lik56eN5Zy65pmv6YO96IO96Kej5p6Q77yM5Luj5Lu35piv55CG6K665LiK5a2Y5Zyo5q2n5LmJ77yI5ZCM5pe25a2Y5Zyo5ZCN5Li6IGBhL2JgIOeahOiKgueCueS4jiBgYWAg5LiL55qEIGBiYO+8ieKAlOKAlFxuICAgICAqIOmCo+enjeaDheWGteS8mOWFiOiupOOAjOWQjeWtl+abtOmVv+OAjeeahOmCo+S4qu+8jOespuWQiOebtOinieOAglxuICAgICAqL1xuICAgIGNvbnN0IHJlc29sdmVQYXRoQnlTZWdtZW50cyA9IChwYXRoOiBzdHJpbmcpOiBhbnkgPT4ge1xuICAgICAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghc2NlbmUpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBzZWdtZW50cyA9IFN0cmluZyhwYXRoKVxuICAgICAgICAgICAgLnNwbGl0KCcvJylcbiAgICAgICAgICAgIC5maWx0ZXIoKHNlZ21lbnQ6IHN0cmluZykgPT4gc2VnbWVudC5sZW5ndGggPiAwKTtcbiAgICAgICAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHNjZW5lO1xuXG4gICAgICAgIC8vIOWFgeiuuOaKiuWcuuaZr+iHquW3seeahOWQjeWtl+WGmeWcqOacgOWJjemdolxuICAgICAgICBpZiAoc2VnbWVudHNbMF0gPT09IHNjZW5lLm5hbWUpIHNlZ21lbnRzLnNoaWZ0KCk7XG4gICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDApIHJldHVybiBzY2VuZTtcblxuICAgICAgICBsZXQgY3Vyc29yOiBhbnkgPSBzY2VuZTtcbiAgICAgICAgbGV0IGluZGV4ID0gMDtcbiAgICAgICAgd2hpbGUgKGluZGV4IDwgc2VnbWVudHMubGVuZ3RoKSB7XG4gICAgICAgICAgICBsZXQgZm91bmQ6IGFueSA9IG51bGw7XG4gICAgICAgICAgICBmb3IgKGxldCBlbmQgPSBzZWdtZW50cy5sZW5ndGg7IGVuZCA+IGluZGV4OyBlbmQgLT0gMSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHNlZ21lbnRzLnNsaWNlKGluZGV4LCBlbmQpLmpvaW4oJy8nKTtcbiAgICAgICAgICAgICAgICBsZXQgY2hpbGQ6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQgPSBjdXJzb3IuZ2V0Q2hpbGRCeU5hbWUoY2FuZGlkYXRlKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoY2hpbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgZm91bmQgPSBjaGlsZDtcbiAgICAgICAgICAgICAgICAgICAgaW5kZXggPSBlbmQ7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghZm91bmQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgY3Vyc29yID0gZm91bmQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGN1cnNvcjtcbiAgICB9O1xuXG4gICAgLyoqIOaMiSB1dWlkIOaJvuiKgueCue+8iOWFiOi1sOW8leaTjuW/q+i3r+W+hO+8jOaJvuS4jeWIsOWGjeaVtOagkeaJq++8iSAqL1xuICAgIGhlbHBlcnMubm9kZUJ5VXVpZCA9ICh1dWlkOiBzdHJpbmcpOiBhbnkgPT4ge1xuICAgICAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghc2NlbmUpIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoc2NlbmUudXVpZCA9PT0gdXVpZCkgcmV0dXJuIHNjZW5lO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZmFzdCA9IHNjZW5lLmdldENoaWxkQnlVdWlkKHV1aWQpO1xuICAgICAgICAgICAgaWYgKGZhc3QpIHJldHVybiBmYXN0O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW8leaTjuWGhemDqOWunueOsOWPmOWKqOaXtuWbnuiQveWIsOaVtOagkeaJq+aPjyAqL1xuICAgICAgICB9XG4gICAgICAgIGxldCBmb3VuZDogYW55ID0gbnVsbDtcbiAgICAgICAgZWFjaE5vZGUoc2NlbmUsIChuOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICghZm91bmQgJiYgbi51dWlkID09PSB1dWlkKSBmb3VuZCA9IG47XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZm91bmQ7XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOaMiei3r+W+hOaJvuiKgueCue+8jOWmgiBgJ0NhbnZhcy9za2lsbF9kZXRhaWxzJ2DjgIJcbiAgICAgKlxuICAgICAqIOWFiOe7meW8leaTjueahCBgY2MuZmluZGAg6K+V77yI5a6D6K6k5b6XIGAuLmAg5LmL57G755qE6L656KeS6K+t5LmJ77yJ77yM5aSx6LSl5YaN6Ieq5bex5oyJ5q616Kej5p6QIOKAlOKAlFxuICAgICAqIOWQjuiAheaJjeiDveWkhOeQhioq5ZCN5a2X6YeM5ZCrIGAvYCoqIOeahOiKgueCue+8iOWunua1i+WtmOWcqCBgaW50ZXJuYWwvZWRpdG9yL2dyaWQtMmRg77yJ44CCXG4gICAgICog57yW6L6R5Zmo6KOF6aWw6IqC54K5KirnhafmoLfmib7lvpfliLAqKu+8iOaYvuW8j+eCueWQjeWwseS4jeivpeiiq+iXj++8ieOAglxuICAgICAqL1xuICAgIGhlbHBlcnMubm9kZUJ5UGF0aCA9IChwYXRoOiBzdHJpbmcpOiBhbnkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZmFzdCA9IGNjLmZpbmQocGF0aCk7XG4gICAgICAgICAgICBpZiAoZmFzdCkgcmV0dXJuIGZhc3Q7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5Zue6JC9ICovXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc29sdmVQYXRoQnlTZWdtZW50cyhwYXRoKTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog6YGN5Y6G5Zy65pmv5qCR77yI6buY6K6kKirot7Pov4fnvJbovpHlmajoo4XppbDoioLngrkqKu+8ieOAglxuICAgICAqXG4gICAgICogQHBhcmFtIHZpc2l0IOiuv+mXruWHveaVsFxuICAgICAqIEBwYXJhbSByb290IOi1t+Wni+iKgueCue+8jOm7mOiupOWcuuaZr+aguVxuICAgICAqIEBwYXJhbSBvcHRpb25zLmluY2x1ZGVFZGl0b3Ig5Li6IHRydWUg5pe26L+eIGdpem1vL+e9keagvC/lj4LogIPlm77kuIDotbfpgY3ljoZcbiAgICAgKi9cbiAgICBoZWxwZXJzLmVhY2hOb2RlID0gKFxuICAgICAgICB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCxcbiAgICAgICAgcm9vdD86IGFueSxcbiAgICAgICAgb3B0aW9ucz86IHsgaW5jbHVkZUVkaXRvcj86IGJvb2xlYW4gfSxcbiAgICApOiB2b2lkID0+IHtcbiAgICAgICAgY29uc3Qgc3RhcnQgPSByb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghc3RhcnQpIHJldHVybjtcbiAgICAgICAgY29uc3QgaW5jbHVkZUVkaXRvciA9IEJvb2xlYW4ob3B0aW9ucyAmJiBvcHRpb25zLmluY2x1ZGVFZGl0b3IpO1xuICAgICAgICAvLyDov63ku6PlvI/mt7HluqbkvJjlhYjvvJvliarmnp3lj5HnlJ/lnKjjgIzlhaXmoIjjgI3ov5nkuIDmraXvvIjot7Pov4fnvJbovpHlmajmoLnvvIzmlbTmo7XlrZDmoJHlsLHmsqHkuobvvIlcbiAgICAgICAgY29uc3Qgc3RhY2s6IGFueVtdID0gW3N0YXJ0XTtcbiAgICAgICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBzdGFjay5wb3AoKTtcbiAgICAgICAgICAgIHZpc2l0KG5vZGUpO1xuICAgICAgICAgICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gbm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSBjaGlsZHJlbi5sZW5ndGggLSAxOyBpID49IDA7IGkgLT0gMSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNoaWxkID0gY2hpbGRyZW5baV07XG4gICAgICAgICAgICAgICAgaWYgKCFpbmNsdWRlRWRpdG9yICYmIGlzRWRpdG9yTm9kZShjaGlsZCkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIHN0YWNrLnB1c2goY2hpbGQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOWcuuaZr+agkeamguiniCDigJTigJQg5LiA5qyh5ou/5Yiw5bGC57qn6aqo5p6277yM5q+UIGByZXR1cm4gc2NlbmVgIOacieeUqOW+l+WkmuOAglxuICAgICAqXG4gICAgICog6buY6K6kKirot7Pov4fnvJbovpHlmajoo4XppbDoioLngrkqKu+8iOingSB7QGxpbmsgaXNFZGl0b3JOb2RlfSDnmoTor7TmmI7vvInvvJtcbiAgICAgKiDpnIDopoHov54gZ2l6bW8g5LiA6LW355yL5bCx5LygIGBpbmNsdWRlRWRpdG9yOiB0cnVlYOOAglxuICAgICAqXG4gICAgICogQHBhcmFtIG9wdGlvbnMubWF4RGVwdGgg6buY6K6kIDNcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy53aXRoQ29tcG9uZW50cyDmmK/lkKbluKbkuIrmr4/kuKroioLngrnnmoTnu4Tku7bnsbvlnovlkI1cbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5pbmNsdWRlRWRpdG9yIOaYr+WQpuWMheWQq+e8lui+keWZqCBnaXptby/nvZHmoLwv5Y+C6ICD5Zu+77yM6buY6K6kIGZhbHNlXG4gICAgICovXG4gICAgaGVscGVycy50cmVlID0gKFxuICAgICAgICBvcHRpb25zPzogeyByb290PzogYW55OyBtYXhEZXB0aD86IG51bWJlcjsgd2l0aENvbXBvbmVudHM/OiBib29sZWFuOyBpbmNsdWRlRWRpdG9yPzogYm9vbGVhbiB9LFxuICAgICk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9PiB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICBjb25zdCByb290ID0gb3B0cy5yb290IHx8IGN1cnJlbnRTY2VuZShjYyk7XG4gICAgICAgIGlmICghcm9vdCkgcmV0dXJuIG51bGw7XG4gICAgICAgIGNvbnN0IG1heERlcHRoID0gdHlwZW9mIG9wdHMubWF4RGVwdGggPT09ICdudW1iZXInID8gb3B0cy5tYXhEZXB0aCA6IDM7XG4gICAgICAgIGNvbnN0IGluY2x1ZGVFZGl0b3IgPSBCb29sZWFuKG9wdHMuaW5jbHVkZUVkaXRvcik7XG5cbiAgICAgICAgY29uc3QgYnVpbGQgPSAobm9kZTogYW55LCBkZXB0aDogbnVtYmVyKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgdXVpZDogbm9kZS51dWlkLFxuICAgICAgICAgICAgICAgIGFjdGl2ZTogbm9kZS5hY3RpdmUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgaWYgKG9wdHMud2l0aENvbXBvbmVudHMpIHtcbiAgICAgICAgICAgICAgICBvdXQuY29tcG9uZW50cyA9IChub2RlLmNvbXBvbmVudHMgfHwgW10pLm1hcCgoYzogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyB0eXBlOiBjYy5qcy5nZXRDbGFzc05hbWUoYyksIGVuYWJsZWQ6IGMuZW5hYmxlZCB9O1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IHR5cGU6ICd1bmtub3duJyB9O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBhbGxDaGlsZHJlbjogYW55W10gPSBub2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgICAgICAgICAgY29uc3QgY2hpbGRyZW4gPSBpbmNsdWRlRWRpdG9yXG4gICAgICAgICAgICAgICAgPyBhbGxDaGlsZHJlblxuICAgICAgICAgICAgICAgIDogYWxsQ2hpbGRyZW4uZmlsdGVyKChjaGlsZDogYW55KSA9PiAhaXNFZGl0b3JOb2RlKGNoaWxkKSk7XG4gICAgICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIG91dC5jaGlsZENvdW50ID0gY2hpbGRyZW4ubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGlmIChkZXB0aCA8IG1heERlcHRoKSB7XG4gICAgICAgICAgICAgICAgICAgIG91dC5jaGlsZHJlbiA9IGNoaWxkcmVuLm1hcCgoYzogYW55KSA9PiBidWlsZChjLCBkZXB0aCArIDEpKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBvdXQuY2hpbGRyZW4gPSBjaGlsZHJlbi5tYXAoKGM6IGFueSkgPT4gKHsgbmFtZTogYy5uYW1lLCB1dWlkOiBjLnV1aWQgfSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIOiXj+S6huS4nOilv+WwseivtOS4gOWjsO+8jOWIq+iuqeiwg+eUqOaWueS7peS4uuagkeWwsei/meS5iOWkp1xuICAgICAgICAgICAgY29uc3QgaGlkZGVuID0gYWxsQ2hpbGRyZW4ubGVuZ3RoIC0gY2hpbGRyZW4ubGVuZ3RoO1xuICAgICAgICAgICAgaWYgKGhpZGRlbiA+IDApIG91dC5lZGl0b3JDaGlsZHJlbkhpZGRlbiA9IGhpZGRlbjtcbiAgICAgICAgICAgIHJldHVybiBvdXQ7XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBidWlsZChyb290LCAwKTtcbiAgICB9O1xuXG4gICAgLyoqIOi/meS4quiKgueCueaYr+S4jeaYr+e8lui+keWZqOiHquW3seeahOijhemlsO+8iGdpem1vIC8g572R5qC8IC8g5Y+C6ICD5Zu+77yJICovXG4gICAgaGVscGVycy5pc0VkaXRvck5vZGUgPSAobm9kZTogYW55KTogYm9vbGVhbiA9PiBpc0VkaXRvck5vZGUobm9kZSk7XG5cbiAgICAvKiog55yf5a6e5YaF5a655a2Q6IqC54K577yI5bey5ruk5o6J57yW6L6R5Zmo6KOF6aWw77yJICovXG4gICAgaGVscGVycy5jb250ZW50Q2hpbGRyZW4gPSAobm9kZT86IGFueSk6IGFueVtdID0+IGNvbnRlbnRDaGlsZHJlbihub2RlIHx8IGN1cnJlbnRTY2VuZShjYykpO1xuXG4gICAgLyoqXG4gICAgICog5bGV5byA5LiA5Liq6IqC54K55oiW57uE5Lu25Li657qv5pWw5o2u5a+56LGh44CCXG4gICAgICpcbiAgICAgKiDov5nmmK8gYGVuZ2luZU9iamVjdFRhZ2Ag5pGY6KaB55qE44CM6YCD55Sf6Iix44CN77ya6L+U5Zue5YC85bqP5YiX5YyW5pe26buY6K6k5oqKIGNjIOWvueixoeWOi+aIkFxuICAgICAqIGBbTm9kZSBuYW1lPXggdXVpZD15XWDvvIzmg7PnnIvnu4boioLlsLHlvpfotbAgYGR1bXAoKWDvvIzlroPkvJoqKuaYvuW8j+WPluWtl+autSoq77yMXG4gICAgICog5LqO5piv5pei5ou/5b6X5Yiw5pWw5o2u77yM5Y+I5LiN5Lya5Zug5Li65b6q546v5byV55So54K45o6J44CCXG4gICAgICovXG4gICAgaGVscGVycy5kdW1wID0gKHRhcmdldDogYW55KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsID0+IHtcbiAgICAgICAgaWYgKCF0YXJnZXQpIHJldHVybiBudWxsO1xuXG4gICAgICAgIC8vIOaYr+e7hOS7tu+8iOaciSBub2RlIOWtl+auteS4lOiHqui6q+S4jeaYryBOb2Rl77yJXG4gICAgICAgIGlmICh0YXJnZXQubm9kZSAmJiAhdGFyZ2V0LmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICAgICAgICAgIF9fa2luZDogJ2NvbXBvbmVudCcsXG4gICAgICAgICAgICAgICAgdHlwZTogKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBjYy5qcy5nZXRDbGFzc05hbWUodGFyZ2V0KTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGFyZ2V0LmNvbnN0cnVjdG9yICYmIHRhcmdldC5jb25zdHJ1Y3Rvci5uYW1lO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkoKSxcbiAgICAgICAgICAgICAgICBub2RlOiBzaG9ydE5vZGUodGFyZ2V0Lm5vZGUpLFxuICAgICAgICAgICAgICAgIGVuYWJsZWQ6IHRhcmdldC5lbmFibGVkLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IHByb3BzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgY29tcG9uZW50UHJvcE5hbWVzKHRhcmdldCkpIHtcbiAgICAgICAgICAgICAgICBjb25zdCByZWFkID0gc2FmZVJlYWQodGFyZ2V0LCBrZXkpO1xuICAgICAgICAgICAgICAgIGlmIChyZWFkLm9rKSBwcm9wc1trZXldID0gcmVhZC52YWx1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG91dC5wcm9wcyA9IHByb3BzO1xuICAgICAgICAgICAgcmV0dXJuIG91dDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOaYr+iKgueCuVxuICAgICAgICBpZiAodGFyZ2V0LmNoaWxkcmVuICYmIHR5cGVvZiB0YXJnZXQudXVpZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY29tcCBvZiB0YXJnZXQuY29tcG9uZW50cyB8fCBbXSkge1xuICAgICAgICAgICAgICAgIGxldCB0eXBlTmFtZSA9ICd1bmtub3duJztcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICB0eXBlTmFtZSA9IGNjLmpzLmdldENsYXNzTmFtZShjb21wKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZU5hbWUgPSAoY29tcC5jb25zdHJ1Y3RvciAmJiBjb21wLmNvbnN0cnVjdG9yLm5hbWUpIHx8ICd1bmtub3duJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvcHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgY29tcG9uZW50UHJvcE5hbWVzKGNvbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlYWQgPSBzYWZlUmVhZChjb21wLCBrZXkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVhZC5vaykgcHJvcHNba2V5XSA9IHJlYWQudmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHMucHVzaCh7IHR5cGU6IHR5cGVOYW1lLCBlbmFibGVkOiBjb21wLmVuYWJsZWQsIHByb3BzIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBfX2tpbmQ6ICdub2RlJyxcbiAgICAgICAgICAgICAgICBuYW1lOiB0YXJnZXQubmFtZSxcbiAgICAgICAgICAgICAgICB1dWlkOiB0YXJnZXQudXVpZCxcbiAgICAgICAgICAgICAgICBhY3RpdmU6IHRhcmdldC5hY3RpdmUsXG4gICAgICAgICAgICAgICAgYWN0aXZlSW5IaWVyYXJjaHk6IHRhcmdldC5hY3RpdmVJbkhpZXJhcmNoeSxcbiAgICAgICAgICAgICAgICBsYXllcjogdGFyZ2V0LmxheWVyLFxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0YXJnZXQucG9zaXRpb24sXG4gICAgICAgICAgICAgICAgcm90YXRpb246IHRhcmdldC5yb3RhdGlvbixcbiAgICAgICAgICAgICAgICBzY2FsZTogdGFyZ2V0LnNjYWxlLFxuICAgICAgICAgICAgICAgIHBhcmVudDogc2hvcnROb2RlKHRhcmdldC5wYXJlbnQpLFxuICAgICAgICAgICAgICAgIGNoaWxkcmVuOiAodGFyZ2V0LmNoaWxkcmVuIHx8IFtdKS5tYXAoKGM6IGFueSkgPT4gc2hvcnROb2RlKGMpKSxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IF9fa2luZDogJ3BsYWluJywgdmFsdWU6IHRhcmdldCB9O1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDor7fmsYLkuIDmrKHmkqTplIDlv6vnhafjgIJcbiAgICAgKlxuICAgICAqIOacrOWHveaVsCoq5Y+q572u5qCH5b+X5L2NKirvvIznnJ/mraPnmoQgYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywnc25hcHNob3QnKWBcbiAgICAgKiDnlLHkuLvov5vnqIvlnKjmi7/liLDov5Tlm57lgLzkuYvlkI7miafooYwg4oCU4oCUIOWOn+WboO+8muWcuuaZr+iEmuacrOiHquW3sei3keWcqCBzY2VuZSDov5vnqIvph4zvvIxcbiAgICAgKiDku44gc2NlbmUg6L+b56iL5YaNIGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIC4uLilgIOaYr+e7meiHquW3seWPkea2iOaBr++8jFxuICAgICAqIOi9u+WImeaOkumYn+mHjeWImeiHqumUgeOAgui3qOi/m+eoi+eahOS6i+S6pOe7meWPkei1t+aWueWBmuOAglxuICAgICAqL1xuICAgIGhlbHBlcnMuc25hcHNob3QgPSAoKTogdm9pZCA9PiB7XG4gICAgICAgIHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkID0gdHJ1ZTtcbiAgICB9O1xuXG4gICAgLyoqIOedoeecoOaMh+Wumuavq+enku+8iOmFjeWQiCBgYXdhaXRgIOWBmui9ruivou+8jOavlOiuqeaooeWei+WcqCB0b29sIGNhbGwg5LmL6Ze05bmy562J55yB5b6X5aSa77yJICovXG4gICAgaGVscGVycy5zbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICAgICAgc2V0VGltZW91dChyZXNvbHZlLCBNYXRoLm1heCgwLCBNYXRoLm1pbig2MDAwMCwgbXMgfCAwKSkpO1xuICAgICAgICB9KTtcblxuICAgIC8qKlxuICAgICAqIOaIquWPlioq57yW6L6R5Zmo5Zy65pmv6KeG5Zu+KirlvZPliY3kuIDluKfvvIzlrZjmiJAgUE5HL0pQRUfjgIJcbiAgICAgKlxuICAgICAqIOaJgOingeWNs+aJgOW+l++8iOWQq+e9keagvOS4jiBnaXptb++8ie+8jOeUqOadpeOAjOeci+S4gOecvOeUu+mdouOAjeiAjOS4jeaYr+OAjOivu+S4gOS4suWdkOagh+OAjeKAlOKAlFxuICAgICAqIOW4g+WxgOWPoOWtl+OAgei0tOWbvuepuueZveOAgeiKgueCuei3keWHuuWxj+W5lei/meexu+mXrumimO+8jOeci+eUu+mdouS4gOenkuWwseiDveWPkeeOsOOAglxuICAgICAqXG4gICAgICogQHBhcmFtIG9wdGlvbnMuc2F2ZVBhdGgg55uu5qCH5paH5Lu2Kirnu53lr7not6/lvoQqKuOAgue7meS6huWwseiHquW3seiQveebmO+8jOi/lOWbnuWAvOWPquW4pui3r+W+hO+8iOWwj++8ie+8m1xuICAgICAqICAg5LiN57uZ44CB5oiW5pys546v5aKD5YaZ5LiN5LqG55uY77yM5Zue6JC944CM5YiG5Z2X5Zue5Lyg44CN77yM55Sx5Li76L+b56iL5ou85Zue5p2l6JC955uY44CCXG4gICAgICogQHBhcmFtIG9wdGlvbnMubWF4V2lkdGgg57yp5Yiw5LiN6LaF6L+H6L+Z5Liq5a695bqm77yM6buY6K6kIDY0MO+8iOi2iuWwj+i2iuW/q+OAgeWbnuS8oOi2iuWwj++8iVxuICAgICAqIEBwYXJhbSBvcHRpb25zLmZvcm1hdCBgJ3BuZydg77yI6buY6K6k77yM5peg5o2f77yJ5oiWIGAnanBlZydg77yI5L2T56ev5bCP77yJXG4gICAgICogQHBhcmFtIG9wdGlvbnMucXVhbGl0eSBqcGVnIOi0qOmHjyAwLjF+Me+8jOm7mOiupCAwLjlcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy53YWl0TXMg562J5LiL5LiA5bin55qE5LiK6ZmQ77yM6buY6K6kIDgwMG1z77yI5Zy65pmv6KeG5Zu+5rKh5Zyo5riy5p+T5pe25YWc5bqV55u05o6l5oqT5b2T5YmN57yT5Yay77yJXG4gICAgICovXG4gICAgaGVscGVycy5jYXB0dXJlVmlldyA9IGFzeW5jIChcbiAgICAgICAgb3B0aW9ucz86IHtcbiAgICAgICAgICAgIHNhdmVQYXRoPzogc3RyaW5nO1xuICAgICAgICAgICAgbWF4V2lkdGg/OiBudW1iZXI7XG4gICAgICAgICAgICBmb3JtYXQ/OiBzdHJpbmc7XG4gICAgICAgICAgICBxdWFsaXR5PzogbnVtYmVyO1xuICAgICAgICAgICAgd2FpdE1zPzogbnVtYmVyO1xuICAgICAgICB9LFxuICAgICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0+IHtcbiAgICAgICAgY29uc3Qgb3B0cyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgIGNvbnN0IGZvcm1hdCA9IG9wdHMuZm9ybWF0ID09PSAnanBlZycgfHwgb3B0cy5mb3JtYXQgPT09ICdqcGcnID8gJ2pwZWcnIDogJ3BuZyc7XG4gICAgICAgIGNvbnN0IG1pbWUgPSBmb3JtYXQgPT09ICdqcGVnJyA/ICdpbWFnZS9qcGVnJyA6ICdpbWFnZS9wbmcnO1xuICAgICAgICBjb25zdCBxdWFsaXR5ID0gdHlwZW9mIG9wdHMucXVhbGl0eSA9PT0gJ251bWJlcicgPyBNYXRoLm1pbigxLCBNYXRoLm1heCgwLjEsIG9wdHMucXVhbGl0eSkpIDogMC45O1xuICAgICAgICBjb25zdCBtYXhXaWR0aCA9IHR5cGVvZiBvcHRzLm1heFdpZHRoID09PSAnbnVtYmVyJyAmJiBvcHRzLm1heFdpZHRoID4gMCA/IE1hdGguZmxvb3Iob3B0cy5tYXhXaWR0aCkgOiA2NDA7XG4gICAgICAgIGNvbnN0IHdhaXRNcyA9IHR5cGVvZiBvcHRzLndhaXRNcyA9PT0gJ251bWJlcicgPyBNYXRoLm1heCgwLCBNYXRoLm1pbig1MDAwLCBvcHRzLndhaXRNcykpIDogODAwO1xuXG4gICAgICAgIGNvbnN0IGNhbnZhcyA9IGZpbmRWaWV3Q2FudmFzKGNjKTtcbiAgICAgICAgaWYgKCFjYW52YXMpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfmib7kuI3liLDlnLrmma/op4blm77nmoTnlLvluIPvvJpzY2VuZSDov5vnqIvph4zmsqHmnInlj6/nlKjnmoQgY2FudmFz44CCJyB9O1xuXG4gICAgICAgIGxldCBmcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgcGl4ZWxzOiBVaW50OEFycmF5IH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBmcmFtZSA9IGF3YWl0IHJlYWRWaWV3UGl4ZWxzKGNjLCBjYW52YXMsIHdhaXRNcyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOivu+WPlueUu+mdouWksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZW5jb2RlZDogeyBkYXRhVXJsOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBlbmNvZGVkID0gZW5jb2RlRnJhbWVUb0RhdGFVcmwoZnJhbWUucGl4ZWxzLCBmcmFtZS53aWR0aCwgZnJhbWUuaGVpZ2h0LCB7XG4gICAgICAgICAgICAgICAgbWF4V2lkdGgsXG4gICAgICAgICAgICAgICAgbWltZSxcbiAgICAgICAgICAgICAgICBxdWFsaXR5LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOe8lueggeWbvueJh+Wksei0pe+8miR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjb21tYSA9IGVuY29kZWQuZGF0YVVybC5pbmRleE9mKCcsJyk7XG4gICAgICAgIGNvbnN0IGJhc2U2NCA9IGNvbW1hID49IDAgPyBlbmNvZGVkLmRhdGFVcmwuc2xpY2UoY29tbWEgKyAxKSA6ICcnO1xuICAgICAgICBjb25zdCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgd2lkdGg6IGVuY29kZWQud2lkdGgsXG4gICAgICAgICAgICBoZWlnaHQ6IGVuY29kZWQuaGVpZ2h0LFxuICAgICAgICAgICAgc291cmNlV2lkdGg6IGZyYW1lLndpZHRoLFxuICAgICAgICAgICAgc291cmNlSGVpZ2h0OiBmcmFtZS5oZWlnaHQsXG4gICAgICAgICAgICBmb3JtYXQsXG4gICAgICAgICAgICBieXRlczogTWF0aC5mbG9vcigoYmFzZTY0Lmxlbmd0aCAqIDMpIC8gNCksXG4gICAgICAgICAgICBibGFua1JhdGlvOiBzYW1wbGVCbGFua1JhdGlvKGZyYW1lLnBpeGVscyksXG4gICAgICAgICAgICAvLyDnqbrlm77ml7bov5nkuIDlnZflsLHmmK/nrZTmoYjnmoTkuIDljYrvvJrop4EgcmVhZFZpZXdTdGF0ZSDnmoTms6jph4rvvIjorr7lpIfmqKHmi5/ooqvmiZPmjonnmoTpgqPmrKHkuovmlYXvvIlcbiAgICAgICAgICAgIHZpZXc6IHJlYWRWaWV3U3RhdGUoY2MsIGNhbnZhcyksXG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3Qgc2F2ZVBhdGggPSB0eXBlb2Ygb3B0cy5zYXZlUGF0aCA9PT0gJ3N0cmluZycgJiYgb3B0cy5zYXZlUGF0aC50cmltKCkgPyBvcHRzLnNhdmVQYXRoLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBub2RlID0gZ2V0Tm9kZU1vZHVsZXMoKTtcbiAgICAgICAgaWYgKHNhdmVQYXRoICYmIG5vZGUpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZGlyID0gbm9kZS5wYXRoLmRpcm5hbWUoc2F2ZVBhdGgpO1xuICAgICAgICAgICAgICAgIGlmIChkaXIpIG5vZGUuZnMubWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgICAgICAgbm9kZS5mcy53cml0ZUZpbGVTeW5jKHNhdmVQYXRoLCBCdWZmZXIuZnJvbShiYXNlNjQsICdiYXNlNjQnKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgLi4uaW5mbywgdHJhbnNwb3J0OiAnZmlsZScsIHBhdGg6IHNhdmVQYXRoIH07XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAvLyDlhpnkuI3ov5vljrvkuZ/opoHorqnosIPnlKjmlrnmi7/liLDlm74g4oCU4oCUIOWbnuiQveWIhuWdl1xuICAgICAgICAgICAgICAgIGluZm8uc2F2ZUVycm9yID0gZXJyb3JJbmZvKGVycikubWVzc2FnZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNodW5rU2l6ZSA9IDMwMDA7IC8vIOaymeeuseWNleWtl+espuS4suS4iumZkCA0MDAw77yM55WZ5Ye65L2Z6YePXG4gICAgICAgIGNvbnN0IGNodW5rczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXNlNjQubGVuZ3RoOyBpICs9IGNodW5rU2l6ZSkgY2h1bmtzLnB1c2goYmFzZTY0LnNsaWNlKGksIGkgKyBjaHVua1NpemUpKTtcbiAgICAgICAgaWYgKGNodW5rcy5sZW5ndGggPiA5MCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAuLi5pbmZvLFxuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjpcbiAgICAgICAgICAgICAgICAgICAgYOaIquWbvuWkquWkp++8jOmcgOimgeWbnuS8oCAke2NodW5rcy5sZW5ndGh9IOWdl++8iOS4iumZkCA5MO+8ie+8muaKiiBtYXhXaWR0aCDosIPlsI9gICtcbiAgICAgICAgICAgICAgICAgICAgYO+8iOW9k+WJjSAke21heFdpZHRofe+8ieOAgeaNoiBqcGVn77yM5oiW57uZ5LiA5Liq5Y+v5YaZ55qEIHNhdmVQYXRo44CCYCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgLi4uaW5mbywgdHJhbnNwb3J0OiAnY2h1bmtzJywgY2h1bmtTaXplLCBjaHVua3MsIGNodW5rQ291bnQ6IGNodW5rcy5sZW5ndGggfTtcbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICog5oqK44CM6LWE5rqQ5byV55So44CN6Kej5p6Q5oiQIGBTcHJpdGVGcmFtZWAg4oCU4oCUICoq5Yir5YaN5omL5pCTIHV1aWTvvIzkuZ/liKvnlKggYGNjLnJlc291cmNlcy5sb2FkYCoq44CCXG4gICAgICpcbiAgICAgKiAjIyDkuLrku4DkuYjov5nkuKrliqnmiYvlv4XpobvlrZjlnKjvvIjkuKTmrKHlrp7mtYvku6Pku7fvvIlcbiAgICAgKlxuICAgICAqIOe8lui+keWZqOWcuuaZr+S4iuS4i+aWh+mHjOOAjOe7meS4gOS4qiBTcHJpdGUg6LWL5Zu+54mH44CN6L+Z5Lu25LqL77yMKirkuInmnaHnm7Top4nlhajmmK/plJnnmoQqKu+8mlxuICAgICAqXG4gICAgICogfCDnm7Top4nlhpnms5UgfCDlrp7mtYvnu5PmnpwgfFxuICAgICAqIHwtLS18LS0tfFxuICAgICAqIHwgYGNjLnJlc291cmNlcy5sb2FkKCd0ZXh0dXJlcy94L3Nwcml0ZUZyYW1lJywgY2MuU3ByaXRlRnJhbWUsIGNiKWAgfCBgQ2FuIG5vdCBwYXJzZSB0aGlzIGlucHV0OiB7XCJwYXRoXCI64oCmLFwiYnVuZGxlXCI6XCJcIn1gIOKAlOKAlCDnvJbovpHlmajlnLrmma/ph4wgYGNjLnJlc291cmNlc2Ag6L+Z5LiA5qGj5rKh6KKr5q2j56Gu5Yid5aeL5YyWIHxcbiAgICAgKiB8IGBxdWVyeS1hc3NldHMoe3BhdHRlcm46J2RiOi8vYXNzZXRzL+KApi94LnBuZy9zcHJpdGVGcmFtZSd9KWAgfCAqKumdmem7mOi/lOWbnuepuuaVsOe7hCoq77yI5LiN5oql6ZSZ77yJ4oaSIOS7peS4uuOAjOayoeaciei/meS4quWtkOi1hOa6kOOAjSB8XG4gICAgICogfCDnm7TmjqXmiorlm77niYcgdXVpZCDlvZMgU3ByaXRlRnJhbWUg55SoIHwg5ou/5Yiw55qE5pivIGBUZXh0dXJlMkRg77yMYFNwcml0ZS5zcHJpdGVGcmFtZWAg6LWL5YC85LiN5oql6ZSZ5L2GKirnlLvkuI3lh7rmnaUqKiB8XG4gICAgICpcbiAgICAgKiDmraPnoa7nmoTkuIDmnaHmmK/jgIzlm77niYcgdXVpZCArIGBAZjk5NDFgIOWtkOi1hOa6kOmUriDihpIgYGFzc2V0TWFuYWdlci5sb2FkQW55KHt1dWlkfSlg44CN77yMXG4gICAgICog5L2G6YKj5LiqIGBmOTk0MWAg5piv6LWE5rqQ5bqT55Sf5oiQ55qE77yM5LiN6K+l55Sx5qih5Z6L5Y675ou844CC6L+Z6YeM5oqK5pW05p2h6Lev5pS26L+b5LiA5Liq5Ye95pWw77yaXG4gICAgICpcbiAgICAgKiBgYGBcbiAgICAgKiBjb25zdCBzZiA9IGF3YWl0IGxvYWRGcmFtZSgnZGI6Ly9hc3NldHMvcmVzb3VyY2VzL3RleHR1cmVzL2NvbW1vbi9yZWN0X3JkXzIwLnBuZycpO1xuICAgICAqIGNvbnN0IHNwcml0ZSA9IG5vZGUuYWRkQ29tcG9uZW50KGNjLlNwcml0ZSk7XG4gICAgICogc3ByaXRlLnNpemVNb2RlID0gY2MuU3ByaXRlLlNpemVNb2RlLkNVU1RPTTsgICAvLyDihpAg5b+F6aG75YWI5LqOIHNwcml0ZUZyYW1l77yI6KeB5Y+m5LiA5p2h5Z2R77yJXG4gICAgICogc3ByaXRlLnNwcml0ZUZyYW1lID0gc2Y7XG4gICAgICogYGBgXG4gICAgICpcbiAgICAgKiAjIyDmjqXlj5fnmoTkuInnp43lvJXnlKhcbiAgICAgKlxuICAgICAqIDEuIGBkYjovL2Fzc2V0cy8uLi4veC5wbmdg77yIKirmjqjojZAqKu+8m+WGmeaIkCBgLi4uL3gucG5nL3Nwcml0ZUZyYW1lYCDkuZ/ooYzvvIzlkI7nvIDkvJrooqvljrvmjonvvInigJTigJRcbiAgICAgKiAgICDotbAqKuejgeebmOS4iueahCBgLm1ldGFgKirvvJpgYXNzZXRzLzznm7jlr7not6/lvoQ+Lm1ldGFgIOmHjCBgc3ViTWV0YXNgIOS4rSBgbmFtZSA9PT0gJ3Nwcml0ZUZyYW1lJ2BcbiAgICAgKiAgICDpgqPkuIDmnaHnmoQgYHV1aWRgIOWwseaYryBgPOWbviB1dWlkPkBmOTk0MWDjgIJgLm1ldGFgIOaYr+i1hOa6kOW6k+iHquW3seWGmeeahO+8jOemu+e6v+WPr+ivu++8jFxuICAgICAqICAgIOS4jeS+nei1liBgRWRpdG9yYCDlnKjkuI3lnKjjgIHkuZ/kuI3pnIDopoHlho3ljrsgZWRpdG9yIOS4iuS4i+aWh+afpeS4gOasoeOAglxuICAgICAqIDIuIGB1dWlkQGY5OTQxYO+8iOWtkOi1hOa6kCB1dWlk77yJ4oCU4oCUIOebtOaOpeeUqOOAglxuICAgICAqIDMuIOijuOWbvueJhyB1dWlkIOKAlOKAlCDlhYjmjInljp/moLfliqDovb3vvJvmi7/liLAgYFRleHR1cmUyRGAg5pe2Kirlho3or5XkuIDmrKEgYEBmOTk0MWAqKlxuICAgICAqICAgIO+8iENyZWF0b3IgMy54IOeahCBzcHJpdGUtZnJhbWUg5a2Q6LWE5rqQ6ZSu5bCx5piv6L+Z5Liq5bi46YeP77yJ77yM5bm25aaC5a6e6K+05piO5piv54yc55qE44CCXG4gICAgICpcbiAgICAgKiDop6PmnpDnu5PmnpzlnKjlkIzkuIDmrrXohJrmnKzph4zkvJrnvJPlrZjvvIjlkIzkuIDkuKrlvJXnlKjph43lpI3lj5bkuI3kvJrph43lpI3liqDovb3vvInjgIJcbiAgICAgKiDmi7/kuI3liLDml7YqKuaKm+WHuuivtOW+l+a4heeahOmUmeivryoq77yI6K+V6L+H5ZOq5Lqb5YCZ6YCJ44CB5q+P5Liq5YCZ6YCJ5ou/5Yiw5LqG5LuA5LmI57G75Z6L77yJ77yMXG4gICAgICog6ICM5LiN5piv5Zue5LiA5LiqIGBudWxsYCDorqnosIPnlKjmlrnljrvnjJzjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSByZWYgLSDkuIrpnaLkuInnp43lvJXnlKjkuYvkuIDjgIJcbiAgICAgKiBAcmV0dXJucyDor6XotYTmupDnmoQgYFNwcml0ZUZyYW1lYOOAglxuICAgICAqL1xuICAgIGNvbnN0IGZyYW1lQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xuICAgIGhlbHBlcnMubG9hZEZyYW1lID0gYXN5bmMgKHJlZjogdW5rbm93bik6IFByb21pc2U8YW55PiA9PiB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHR5cGVvZiByZWYgPT09ICdzdHJpbmcnID8gcmVmLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIXJhdykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwibG9hZEZyYW1lKHJlZinvvJpyZWYg5piv56m655qE44CC55So5rOV77yabG9hZEZyYW1lKCdkYjovL2Fzc2V0cy9yZXNvdXJjZXMvdGV4dHVyZXMvY29tbW9uL3JlY3RfcmRfMjAucG5nJylcIiArXG4gICAgICAgICAgICAgICAgICAgIFwi77yI5Zu+54mH6Lev5b6E77yM5Y+v55yBIC9zcHJpdGVGcmFtZe+8ieaIliBsb2FkRnJhbWUoJzx1dWlkPkBmOTk0MScp44CCXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChmcmFtZUNhY2hlLmhhcyhyYXcpKSByZXR1cm4gZnJhbWVDYWNoZS5nZXQocmF3KTtcblxuICAgICAgICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcblxuICAgICAgICAvKiog5Yqg6L295LiA5LiqIHV1aWTvvIjlm57osIPlvI/vvIzkuI7nvJbovpHlmajph4zlrp7mtYvog73nlKjnmoTpgqPmnaHot6/kuIDoh7TvvInjgIIgKi9cbiAgICAgICAgY29uc3QgbG9hZEFueSA9ICh1dWlkOiBzdHJpbmcpOiBQcm9taXNlPGFueT4gPT5cbiAgICAgICAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjYy5hc3NldE1hbmFnZXIubG9hZEFueSh7IHV1aWQgfSwgKGVycjogYW55LCBhc3NldDogYW55KSA9PlxuICAgICAgICAgICAgICAgICAgICAgICAgZXJyID8gcmVqZWN0KG5ldyBFcnJvcihlcnIubWVzc2FnZSA/IFN0cmluZyhlcnIubWVzc2FnZSkgOiBTdHJpbmcoZXJyKSkpIDogcmVzb2x2ZShhc3NldCksXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoZXJyb3JJbmZvKGVycikubWVzc2FnZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIGlmICgvQC8udGVzdChyYXcpKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGVzLnB1c2gocmF3KTtcbiAgICAgICAgfSBlbHNlIGlmIChyYXcuaW5kZXhPZignZGI6Ly8nKSA9PT0gMCkge1xuICAgICAgICAgICAgaWYgKHJhdy5pbmRleE9mKCdkYjovL2Fzc2V0cy8nKSAhPT0gMCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYGxvYWRGcmFtZSDlj6rorqQgZGI6Ly9hc3NldHMvIOS4i+eahOi1hOa6kO+8iOaUtuWIsCAke3Jhd33vvInjgIJgICtcbiAgICAgICAgICAgICAgICAgICAgICAgICdkYjovL2ludGVybmFsIOaYr+W8leaTjuiHquW4pui1hOa6kOOAgeaYoOWwhOS4jeWIsOW3peeoi+ebruW9le+8m+WGhee9riBVSSDlm77or7fmjIkgc2tpbGwg6YeM55qE6Lev5b6E6KGo55SoIGxvYWRBbnkoe3V1aWR9KSDpgqPmnaHvvIh1dWlkIOS7jiBhc3NldC1kYiDmn6XvvInjgIInLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCByZWwgPSByYXcuc2xpY2UoJ2RiOi8vYXNzZXRzLycubGVuZ3RoKS5yZXBsYWNlKC9cXC8oc3ByaXRlRnJhbWV8dGV4dHVyZSkkLywgJycpO1xuICAgICAgICAgICAgY29uc3Qgcm9vdCA9IHByb2plY3RSb290KCk7XG4gICAgICAgICAgICBjb25zdCBub2RlTW9kcyA9IGdldE5vZGVNb2R1bGVzKCk7XG4gICAgICAgICAgICBpZiAoIXJvb3QgfHwgIW5vZGVNb2RzKSB7XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICAgICAgYOaLv+S4jeWIsOW3peeoi+ague+8iEVkaXRvci5Qcm9qZWN0LnBhdGjvvInmiJYgbm9kZSDmqKHlnZfvvIzmiYDku6XmsqHog73or7sgJHtyZWx9Lm1ldGEg4oCU4oCUIGAgK1xuICAgICAgICAgICAgICAgICAgICAgICAgJ+aUueeUqCBsb2FkRnJhbWUoXCI8dXVpZD5AZjk5NDFcIinvvIh1dWlkIOS7jiBlZGl0b3Ig5LiK5LiL5paHIHF1ZXJ5LWFzc2V0cyDmi7/vvInjgIInLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IG1ldGFGaWxlID0gYCR7bm9kZU1vZHMucGF0aC5qb2luKHJvb3QsICdhc3NldHMnLCByZWwpfS5tZXRhYDtcbiAgICAgICAgICAgICAgICBsZXQgbWV0YTogYW55ID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBtZXRhID0gSlNPTi5wYXJzZShub2RlTW9kcy5mcy5yZWFkRmlsZVN5bmMobWV0YUZpbGUsICd1dGYtOCcpKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChg6K+75LiN5YiwICR7cmVsfS5tZXRh77yIJHtlcnJvckluZm8oZXJyKS5tZXNzYWdlfe+8iWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBzdWJNZXRhcyA9IG1ldGEgJiYgdHlwZW9mIG1ldGEuc3ViTWV0YXMgPT09ICdvYmplY3QnICYmIG1ldGEuc3ViTWV0YXMgPyBtZXRhLnN1Yk1ldGFzIDogbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAoc3ViTWV0YXMpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoc3ViTWV0YXMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBlbnRyeSA9IHN1Yk1ldGFzW2tleV0gfHwge307XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpc1Nwcml0ZUZyYW1lID1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRyeS5uYW1lID09PSAnc3ByaXRlRnJhbWUnIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50cnkuaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50cnkuaW1wb3J0ZXIgPT09ICdzcHJpdGVGcmFtZSc7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzU3ByaXRlRnJhbWUpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8g5a2Q6LWE5rqQ55qEIHV1aWQg5a2X5q615pys6Lqr5bCx5bimIGBAa2V5YO+8m+ayoeacieWwseiHquW3seaLvFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHR5cGVvZiBlbnRyeS51dWlkID09PSAnc3RyaW5nJyAmJiBlbnRyeS51dWlkID8gZW50cnkudXVpZCA6IGAke21ldGEudXVpZH1AJHtrZXl9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYCR7cmVsfS5tZXRhIOmHjOayoeaciSBzcHJpdGVGcmFtZSDlrZDotYTmupDvvIjlroPlj6/og73kuI3mmK/lm77niYfvvIzmiJbov5jmsqHooqvotYTmupDlupPlr7zlhaXvvIlgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICgvXlswLTlhLWZBLUYtXXszMiw0MH0kLy50ZXN0KHJhdykpIHtcbiAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaChyYXcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIGBsb2FkRnJhbWUg6K6k5LiN5Ye66L+Z5Liq5byV55So77yaJHtyYXd944CC57uZIGRiOi8vYXNzZXRzL+KApiDnmoTlm77niYfot6/lvoTjgIF1dWlkQOWtkOi1hOa6kOmUru+8jOaIluijuCB1dWlk44CCYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGFzdCA9ICcnO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNhbmRpZGF0ZXMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGNhbmRpZGF0ZXNbaV07XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgbG9hZEFueShjYW5kaWRhdGUpO1xuICAgICAgICAgICAgICAgIGlmIChhc3NldCAmJiBjYy5TcHJpdGVGcmFtZSAmJiBhc3NldCBpbnN0YW5jZW9mIGNjLlNwcml0ZUZyYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgIGZyYW1lQ2FjaGUuc2V0KHJhdywgYXNzZXQpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXNzZXQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGtpbmQgPSBhc3NldCAmJiBhc3NldC5jb25zdHJ1Y3RvciAmJiBhc3NldC5jb25zdHJ1Y3Rvci5uYW1lID8gYXNzZXQuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBhc3NldDtcbiAgICAgICAgICAgICAgICBsYXN0ID0gYCR7Y2FuZGlkYXRlfSDihpIgJHtraW5kfWA7XG4gICAgICAgICAgICAgICAgLy8g5ou/5YiwIFRleHR1cmUyRO+8muihpeS4gOasoeagh+WHhueahCBzcHJpdGVGcmFtZSDlrZDotYTmupDplK7vvIjlj6rooaXkuIDmrKHvvIzliKvmioroh6rlt7Hnu5Xov5vmrbvlvqrnjq/vvIlcbiAgICAgICAgICAgICAgICBpZiAoa2luZCA9PT0gJ1RleHR1cmUyRCcgJiYgY2FuZGlkYXRlLmluZGV4T2YoJ0AnKSA8IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKGAke2NhbmRpZGF0ZX1AZjk5NDFgKTtcbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChg6KO4IHV1aWQg5ou/5Yiw55qE6LWE5rqQ5pivIFRleHR1cmUyRO+8jOivleS6huS4gOasoeagh+WHhueahCBAZjk5NDEg5a2Q6LWE5rqQ6ZSuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgbGFzdCA9IGAke2NhbmRpZGF0ZX0g4oaSICR7ZXJyb3JJbmZvKGVycikubWVzc2FnZX1gO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGxvYWRGcmFtZSgnJHtyYXd9Jykg5rKh6IO95ou/5YiwIFNwcml0ZUZyYW1l44CCJHtsYXN0ID8gYOacgOWQjuS4gOasoe+8miR7bGFzdH3jgIJgIDogJyd9YCArXG4gICAgICAgICAgICAgICAgKG5vdGVzLmxlbmd0aCA+IDAgPyBg5Y+m5aSW77yaJHtub3Rlcy5qb2luKCfvvJsnKX3jgIJgIDogJycpICtcbiAgICAgICAgICAgICAgICBcIiDmjqjojZDlhpnms5XvvJpsb2FkRnJhbWUoJ2RiOi8vYXNzZXRzL3Jlc291cmNlcy90ZXh0dXJlcy9jb21tb24vcmVjdF9yZF8yMC5wbmcnKeOAglwiLFxuICAgICAgICApO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDlj5boioLngrnnmoQgYFVJVHJhbnNmb3JtYO+8iOaLv+S4jeWIsOWwsSBudWxs77yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjopoHljIXkuIDlsYLvvJpgY2MuVUlUcmFuc2Zvcm1gIOacrOi6q+WPr+iDveWPluS4jeWIsO+8iOW8leaTjueJiOacrC/pnZ4gVUkg6IqC54K577yJ77yMXG4gICAgICog6L+Z5pe2IGBnZXRDb21wb25lbnQodW5kZWZpbmVkKWAg5pyJ55qE54mI5pys5Lya5oqbIOKAlOKAlCDluIPlsYDorqHnrpfkuI3or6Xlm6DkuLrlj5bkuI3liLDlsLrlr7jogIzmlbTmnaHmjILmjonvvIxcbiAgICAgKiDlrr3pq5jmjIkgMCDnrpfjgIHmiorlnZDmoIfnhafluLjmiqXlh7rljrvmm7TmnInnlKjvvIjosIPnlKjmlrnnnIvliLAgYHdpZHRoOiAwYCDoh6rnhLbnn6XpgZPmmK/msqHph4/liLDvvInjgIJcbiAgICAgKi9cbiAgICBjb25zdCB1aVRyYW5zZm9ybU9mID0gKG5vZGU6IGFueSk6IGFueSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIW5vZGUgfHwgdHlwZW9mIG5vZGUuZ2V0Q29tcG9uZW50ICE9PSAnZnVuY3Rpb24nKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGlmICghY2MuVUlUcmFuc2Zvcm0pIHJldHVybiBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKSB8fCBudWxsO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIOiKgueCueWcqCoq57yW6L6R5oCB5LiL5Y+v5L+h55qEKirkuJbnlYznn6nlvaIg4oCU4oCUIOWIq+eUqCBgVUlUcmFuc2Zvcm0uZ2V0Qm91bmRpbmdCb3hUb1dvcmxkKClg44CCXG4gICAgICpcbiAgICAgKiAjIyDkuLrku4DkuYjkuI3og73nlKjlvJXmk47pgqPkuKpcbiAgICAgKlxuICAgICAqIOWunua1i++8iENvY29zIDMuOC42IOe8lui+keaAge+8ie+8muWQjOS4gOajteagkemHjCBgdmlld2DvvIhgY29udGVudFNpemVgIDcxMMOXMTA3NOOAgXBvc2l0aW9uICgwLDAp77yJXG4gICAgICog6KKrIGBnZXRCb3VuZGluZ0JveFRvV29ybGQoKWAg5oql5oiQICoqNzEww5cxMTcwKirvvIzogIwgMTE3MCDmgbDlpb3mmK/lroPlrZDoioLngrkgYGNvbnRlbnRgIOeahOmrmOW6pu+8m1xuICAgICAqIGBjb250ZW50YCDnmoQgeCDkuZ/ooqvmiqXlgY/jgIIqKuWug+e7meeahOaYr+iHquebuOefm+ebvueahOWAvCoq77yM6ICM5biD5bGA6aqM5pS25YWo6Z2g6L+Z5Liq5pWw44CCXG4gICAgICpcbiAgICAgKiAjIyDov5nph4znmoTnrpfms5XvvIjkuI4gYGNvbnRlbnRTaXplYCDoh6rmtL3vvIzog73miYvlt6XmoLjlr7nvvIlcbiAgICAgKlxuICAgICAqIOeItuiKgueCueeahCoq6ZSa54K5KirlsLHmmK/lrZDoioLngrnlsYDpg6jlnZDmoIfnmoTljp/ngrnvvIzkuo7mmK/oh6rkuIvogIzkuIrntK/liqDvvJpcbiAgICAgKlxuICAgICAqIGBgYFxuICAgICAqIOmUmueCueS4lueVjOWdkOaghyhuKSA9IOmUmueCueS4lueVjOWdkOaghyhwYXJlbnQpICsgc2NhbGXpk74obikg4oqZIG4ucG9zaXRpb25cbiAgICAgKiDkuK3lv4PkuJbnlYzlnZDmoIcobikgPSDplJrngrnkuJbnlYzlnZDmoIcobikgKyBzY2FsZemTvihuKSDiipkgKCgwLjUtYXgpwrd3LCAoMC41LWF5KcK3aClcbiAgICAgKiDkuJbnlYzlsLrlr7gobikgICAgID0gc2NhbGXpk74obikg4oqZICh3LCBoKSAgICAgICAgLy8g5LiN6ICD6JmR5peL6L2sXG4gICAgICogYGBgXG4gICAgICpcbiAgICAgKiBgc2NhbGXpk74obilgID0gbiAqKuaJgOacieelluWFiCoq77yI5LiN5ZCr6Ieq5bex77yJ55qEIHNjYWxlIOS5mOenr++8m2Byb290YCDmnKzouqvkuI3lj4LkuI7ntK/liqDvvIxcbiAgICAgKiDmiYDku6Xnu5kgYHJvb3RgIOaXtui/lOWbnuWAvOWwseaYryoq5LulIHJvb3Qg55qE6ZSa54K55Li65Y6f54K5KirnmoTlnZDmoIfvvIjov5nmraPmmK9cIui/meW8oOWNoeWcqCBDYW52YXMg6YeMXG4gICAgICog5YGP5LqG5aSa5bCRXCLopoHnmoTpgqPkuKrmlbDvvInjgILkuI3nu5kgYHJvb3RgIOWwseS4gOi3r+e0r+WKoOWIsOWcuuaZr+agueOAglxuICAgICAqXG4gICAgICogQHBhcmFtIG5vZGUgLSDnm67moIfoioLngrnjgIJcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5yb290IC0g57Sv5Yqg55qE57uI54K577yI6L+U5Zue5Z2Q5qCH5Lul5a6D55qE6ZSa54K55Li65Y6f54K577yJ77yb6buY6K6k5Zy65pmv5qC544CCXG4gICAgICogQHJldHVybnMgYHtjeCwgY3ksIHdpZHRoLCBoZWlnaHQsIGxlZnQsIHJpZ2h0LCBib3R0b20sIHRvcCwgYW5jaG9yWCwgYW5jaG9yWSwgc2NhbGVYLCBzY2FsZVl9YFxuICAgICAqICAg4oCU4oCUIGBsZWZ0L3JpZ2h0L2JvdHRvbS90b3BgIOaYr+efqeW9oueahOWbm+adoei+ue+8jGBjeC9jeWAg5piv5Lit5b+D44CCKirlnZDmoIfns7vkuLrjgIwreCDlkJHlj7PjgIEreSDlkJHkuIrjgI0qKuOAglxuICAgICAqL1xuICAgIGhlbHBlcnMud29ybGRSZWN0ID0gKFxuICAgICAgICBub2RlOiBhbnksXG4gICAgICAgIG9wdGlvbnM/OiB7IHJvb3Q/OiBhbnkgfSxcbiAgICApOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgICAgIGlmICghbm9kZSkgdGhyb3cgbmV3IEVycm9yKCd3b3JsZFJlY3Qobm9kZSnvvJpub2RlIOaYr+epuueahOOAgicpO1xuICAgICAgICBjb25zdCBzdG9wQXQgPSBvcHRpb25zICYmIG9wdGlvbnMucm9vdCA/IG9wdGlvbnMucm9vdCA6IG51bGw7XG5cbiAgICAgICAgLy8g4pGgIOWFiOiHquS4i+iAjOS4iuaUtumbhumTvui3r++8mltub2RlLCBwYXJlbnQsIOKApiwgKHN0b3BBdCB8IOWcuuaZr+aguSldXG4gICAgICAgIGNvbnN0IGNoYWluOiBhbnlbXSA9IFtdO1xuICAgICAgICBmb3IgKGxldCBjdXJzb3IgPSBub2RlOyBjdXJzb3I7IGN1cnNvciA9IGN1cnNvci5wYXJlbnQpIHtcbiAgICAgICAgICAgIGNoYWluLnB1c2goY3Vyc29yKTtcbiAgICAgICAgICAgIGlmIChzdG9wQXQgJiYgY3Vyc29yID09PSBzdG9wQXQpIGJyZWFrO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g4pGhIOS7jumTvui3r+mhtuerr+W+gOS4i+e0r+WKoOOAgumhtuerr++8iHN0b3BBdCDmiJblnLrmma/moLnvvInnmoTplJrngrnlsLHmmK/ljp/ngrnvvJphbmNob3I9KDAsMCnjgIFTPSgxLDEpXG4gICAgICAgIGxldCBhbmNob3JYID0gMDtcbiAgICAgICAgbGV0IGFuY2hvclkgPSAwO1xuICAgICAgICBsZXQgc3ggPSAxO1xuICAgICAgICBsZXQgc3kgPSAxO1xuICAgICAgICBmb3IgKGxldCBpID0gY2hhaW4ubGVuZ3RoIC0gMjsgaSA+PSAwOyBpIC09IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkID0gY2hhaW5baV07XG4gICAgICAgICAgICBjb25zdCBwYXJlbnQgPSBjaGFpbltpICsgMV07XG4gICAgICAgICAgICBjb25zdCBwcyA9IHBhcmVudC5zY2FsZSB8fCB7IHg6IDEsIHk6IDEgfTtcbiAgICAgICAgICAgIHN4ICo9IHR5cGVvZiBwcy54ID09PSAnbnVtYmVyJyA/IHBzLnggOiAxO1xuICAgICAgICAgICAgc3kgKj0gdHlwZW9mIHBzLnkgPT09ICdudW1iZXInID8gcHMueSA6IDE7XG4gICAgICAgICAgICBjb25zdCBwb3MgPSBjaGlsZC5wb3NpdGlvbiB8fCB7IHg6IDAsIHk6IDAgfTtcbiAgICAgICAgICAgIGFuY2hvclggKz0gc3ggKiBwb3MueDtcbiAgICAgICAgICAgIGFuY2hvclkgKz0gc3kgKiBwb3MueTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOKRoiDplJrngrkg4oaSIOS4reW/g++8iOmUmueCueWBj+enu+S5n+imgei3n+edgOmTvuS4iueahOe8qeaUvuS4gOi1t+e8qeaUvu+8iVxuICAgICAgICBjb25zdCB1dCA9IHVpVHJhbnNmb3JtT2Yobm9kZSk7XG4gICAgICAgIGNvbnN0IHdpZHRoID0gdXQgPyB1dC53aWR0aCA6IDA7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IHV0ID8gdXQuaGVpZ2h0IDogMDtcbiAgICAgICAgY29uc3QgYXggPSB1dCA/IHV0LmFuY2hvclggOiAwLjU7XG4gICAgICAgIGNvbnN0IGF5ID0gdXQgPyB1dC5hbmNob3JZIDogMC41O1xuICAgICAgICBjb25zdCBjeCA9IGFuY2hvclggKyBzeCAqICgwLjUgLSBheCkgKiB3aWR0aDtcbiAgICAgICAgY29uc3QgY3kgPSBhbmNob3JZICsgc3kgKiAoMC41IC0gYXkpICogaGVpZ2h0O1xuICAgICAgICBjb25zdCBoYWxmVyA9IChzeCAqIHdpZHRoKSAvIDI7XG4gICAgICAgIGNvbnN0IGhhbGZIID0gKHN5ICogaGVpZ2h0KSAvIDI7XG4gICAgICAgIGNvbnN0IHJvdW5kID0gKHZhbHVlOiBudW1iZXIpOiBudW1iZXIgPT4gTWF0aC5yb3VuZCh2YWx1ZSAqIDEwMDApIC8gMTAwMDtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgIGN4OiByb3VuZChjeCksXG4gICAgICAgICAgICBjeTogcm91bmQoY3kpLFxuICAgICAgICAgICAgd2lkdGg6IHJvdW5kKHN4ICogd2lkdGgpLFxuICAgICAgICAgICAgaGVpZ2h0OiByb3VuZChzeSAqIGhlaWdodCksXG4gICAgICAgICAgICBsZWZ0OiByb3VuZChjeCAtIGhhbGZXKSxcbiAgICAgICAgICAgIHJpZ2h0OiByb3VuZChjeCArIGhhbGZXKSxcbiAgICAgICAgICAgIGJvdHRvbTogcm91bmQoY3kgLSBoYWxmSCksXG4gICAgICAgICAgICB0b3A6IHJvdW5kKGN5ICsgaGFsZkgpLFxuICAgICAgICAgICAgYW5jaG9yWDogYXgsXG4gICAgICAgICAgICBhbmNob3JZOiBheSxcbiAgICAgICAgICAgIHNjYWxlWDogcm91bmQoc3gpLFxuICAgICAgICAgICAgc2NhbGVZOiByb3VuZChzeSksXG4gICAgICAgICAgICAvKiog5Z2Q5qCH57O75Y+j5b6E77yI5YaZ6L+b57uT5p6c6YeM77yM5YWN5b6X6LCD55So5pa56Ieq5bex54yc5Y6f54K55Zyo5ZOq77yJICovXG4gICAgICAgICAgICBvcmlnaW46IHN0b3BBdCA/IGDku6UgJHtzdG9wQXQubmFtZX0g55qE6ZSa54K55Li65Y6f54K577yIK3gg5ZCR5Y+zIC8gK3kg5ZCR5LiK77yJYCA6ICfku6XlnLrmma/moLnplJrngrnkuLrljp/ngrnvvIgreCDlkJHlj7MgLyAreSDlkJHkuIrvvIknLFxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICAvKiog5YiX5Ye65b2T5YmN5Y+v55So55qE5Yqp5omL5Ye95pWwIOKAlOKAlCDorqkgQUkg6Ieq5bex5Y+R546w6IO95Yqb77yM6ICM5LiN5piv6Z2gIHRvb2wg5paH5qGj56Gs6IOMICovXG4gICAgaGVscGVycy5oZWxwZXJOYW1lcyA9ICgpOiBzdHJpbmdbXSA9PiBPYmplY3Qua2V5cyhoZWxwZXJzKS5zb3J0KCk7XG4gICAgcmV0dXJuIHsgaGVscGVycywgc3RhdGUgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDmspnnrrHmiafooYxcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgU2NlbmVMb2dFbnRyeSB7XG4gICAgbGV2ZWw6IHN0cmluZztcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXRNczogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgUnVuQ29kZVBheWxvYWQge1xuICAgIGNvZGU/OiBzdHJpbmc7XG4gICAgYXJncz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRpbWVvdXRNcz86IG51bWJlcjtcbiAgICBtYXhMb2dzPzogbnVtYmVyO1xuICAgIG1heExvZ0xlbmd0aD86IG51bWJlcjtcbiAgICAvKiog5bel56iL5qC5IOKAlOKAlCDkuLvov5vnqIvvvIhlZGl0b3Ig5L6n77yJ57uZ55qE77yMYGxvYWRGcmFtZWAg6K+7IGAubWV0YWAg6KaB55So77yI6KeBIGBtYWtlSGVscGVyc2DvvInjgIIgKi9cbiAgICBwcm9qZWN0UGF0aD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gbWFrZUNhcHR1cmVkQ29uc29sZShcbiAgICBzaW5rOiBTY2VuZUxvZ0VudHJ5W10sXG4gICAgc3RhcnRlZEF0OiBudW1iZXIsXG4gICAgbWF4TG9nczogbnVtYmVyLFxuICAgIG1heExvZ0xlbmd0aDogbnVtYmVyLFxuKTogeyBjb25zb2xlOiBSZWNvcmQ8c3RyaW5nLCAoLi4ucGFydHM6IHVua25vd25bXSkgPT4gdm9pZD47IHdhc1RydW5jYXRlZDogKCkgPT4gYm9vbGVhbiB9IHtcbiAgICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgY29uc3Qgc3RyaW5naWZ5ID0gKHZhbHVlOiB1bmtub3duKTogc3RyaW5nID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICAgICAgICAoX2ssIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnZnVuY3Rpb24nKSByZXR1cm4gYFtGdW5jdGlvbiAke3YubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnYmlnaW50JykgcmV0dXJuIGAke3Z9bmA7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2O1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgMCxcbiAgICAgICAgICAgICkgPz8gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgfVxuICAgIH07XG4gICAgY29uc3QgcHVzaCA9IChsZXZlbDogc3RyaW5nKSA9PiAoLi4ucGFydHM6IHVua25vd25bXSkgPT4ge1xuICAgICAgICBpZiAoc2luay5sZW5ndGggPj0gbWF4TG9ncykge1xuICAgICAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBsZXQgdGV4dCA9IHBhcnRzLm1hcChzdHJpbmdpZnkpLmpvaW4oJyAnKTtcbiAgICAgICAgaWYgKHRleHQubGVuZ3RoID4gbWF4TG9nTGVuZ3RoKSB0ZXh0ID0gYCR7dGV4dC5zbGljZSgwLCBtYXhMb2dMZW5ndGgpfeKApmA7XG4gICAgICAgIHNpbmsucHVzaCh7IGxldmVsLCB0ZXh0LCBhdE1zOiBEYXRlLm5vdygpIC0gc3RhcnRlZEF0IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY29uc29sZToge1xuICAgICAgICAgICAgbG9nOiBwdXNoKCdsb2cnKSxcbiAgICAgICAgICAgIGluZm86IHB1c2goJ2luZm8nKSxcbiAgICAgICAgICAgIHdhcm46IHB1c2goJ3dhcm4nKSxcbiAgICAgICAgICAgIGVycm9yOiBwdXNoKCdlcnJvcicpLFxuICAgICAgICAgICAgZGVidWc6IHB1c2goJ2RlYnVnJyksXG4gICAgICAgICAgICB0cmFjZTogcHVzaCgnZGVidWcnKSxcbiAgICAgICAgICAgIGRpcjogcHVzaCgnbG9nJyksXG4gICAgICAgIH0sXG4gICAgICAgIHdhc1RydW5jYXRlZDogKCkgPT4gdHJ1bmNhdGVkLFxuICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5Lik56eN5omn6KGM562W55WlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxubGV0IHZtTW9kdWxlOiBhbnkgPSBudWxsO1xubGV0IHZtVW5hdmFpbGFibGUgPSBmYWxzZTtcblxuLyoqIOaLvyBgdm1gIOaooeWdl++8m+W8leaTjui/m+eoi+mHjOaLv+S4jeWIsOWwsei/lOWbniBudWxs77yI6LCD55So5pa55Zue6JC95YiwIG5ldyBGdW5jdGlvbu+8iSAqL1xuZnVuY3Rpb24gZ2V0Vm1Nb2R1bGUoKTogYW55IHtcbiAgICBpZiAodm1Nb2R1bGUpIHJldHVybiB2bU1vZHVsZTtcbiAgICBpZiAodm1VbmF2YWlsYWJsZSkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbiAgICAgICAgY29uc3QgbW9kID0gcmVxdWlyZSgndm0nKTtcbiAgICAgICAgaWYgKG1vZCAmJiB0eXBlb2YgbW9kLnJ1bkluVGhpc0NvbnRleHQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHZtTW9kdWxlID0gbW9kO1xuICAgICAgICAgICAgcmV0dXJuIG1vZDtcbiAgICAgICAgfVxuICAgICAgICB2bVVuYXZhaWxhYmxlID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHZtVW5hdmFpbGFibGUgPSB0cnVlO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8qKlxuICog5rOo5YWl55So55qE5ZSv5LiA5YWo5bGA5ZCN44CCXG4gKlxuICog5Li65LuA5LmI5piv44CM5LiA5Liq5ZG95ZCN56m66Ze044CN6ICM5LiN5piv44CM5Y2B5Yeg5Liq6KO45YWo5bGA44CN77ya6KeBIHtAbGluayBidWlsZFNjZW5lU291cmNlfeOAglxuICovXG5jb25zdCBJTkpFQ1RfR0xPQkFMX0tFWSA9ICdfX2RzaFNjZW5lQ29udGV4dCc7XG5cbi8qKlxuICog5p6E6YCg5a6e6ZmF5omn6KGM55qE5rqQ56CB44CCXG4gKlxuICogIyMg5Li65LuA5LmI6KaB57uV6L+Z5LiA5LiLXG4gKlxuICogYHZtLnJ1bkluVGhpc0NvbnRleHRgIOeahOS7o+eggeeci+S4jeWIsOWxgOmDqOS9nOeUqOWfn++8iOi/meato+aYr+Wug+iDveeVmeWcqOWuv+S4uyByZWFsbSDnmoTljp/lm6DvvInvvIxcbiAqIOaJgOS7peWFqOWxgOmHj+W/hemhu+e7j+eUsSBgZ2xvYmFsVGhpc2Ag5Lyg6L+b5Y6744CC5pyA55u06KeJ55qE5YGa5rOV5piv5oqKIGBjY2AgLyBgY29uc29sZWAgLyBgZHVtcGAg4oCmXG4gKiDpgJDkuKrmjILliLAgYGdsb2JhbFRoaXNgIOS4iu+8jOS9humCo+agt+aciSoq5Lik5Liq55yf5a6e5Y2x5a6zKirvvJpcbiAqXG4gKiAxLiAqKumBruiUveWuv+S4u+iHquW3seeahOWFqOWxgCoq77ya5rOo5YWl5pyf6Ze0IGBnbG9iYWxUaGlzLmNvbnNvbGVgIOiiq+aNouaIkOaNleiOt+eJiO+8jFxuICogICAg5LqO5piv5byV5pOOL+e8lui+keWZqOiHquW3sei/meWHoOavq+enku+8iOeUmuiHs+W8guatpei2heaXtuWQjuiiq+aUvuW8g+S7o+eggei/mOa0u+edgOeahOWHoOWNgeenku+8iemHjOeahOaXpeW/l1xuICogICAg5YWo6KKr5ZCe6L+b5oiR5Lus55qE57yT5YayIOKAlOKAlCDnvJbovpHlmajmjqfliLblj7DkvJror6HlvILlnLDlronpnZnkuIvmnaXjgIJcbiAqICAgICrvvIjov5nkuKrlnZHlrp7mtYvouKnliLDov4fvvJrpqozor4HohJrmnKzot5HliLDkuIDljYrovpPlh7rmtojlpLHvvIzlsLHmmK/lroPjgILvvIkqXG4gKiAyLiAqKuimgei/mOWOn+WNgeWHoOS4quWQjeWtlyoq77yM5Lu75L2V5LiA5Liq5ZCN5a2X5Zyo5byV5pOO6YeM5piv5LiN5Y+v6YWN572u5bGe5oCn5bCx5Lya6L+Y5Y6f5aSx6LSl77yM6ZW/5pyf5rGh5p+T44CCXG4gKlxuICog5pS55oiQ5Y+q5rOo5YWl5LiA5LiqIGBfX2RzaFNjZW5lQ29udGV4dGDvvIzlho3lnKjljIXoo4Xlmajpobbpg6jmiorlroPnmoTlrZfmrrUqKuWPluaIkOWxgOmDqCBgbGV0YCDnu5HlrpoqKu+8mlxuICogLSBgZ2xvYmFsVGhpc2Ag5Y+q6KKr5Yqo5LiA5Liq5ZCN5a2X77yM6L+Y5Y6f5piv5Y6f5a2Q55qE44CB5Y+v5LulKirnq4vliLvlgZoqKu+8m1xuICogLSDnlKjmiLfku6PnoIHph4znmoQgYGNvbnNvbGUubG9nYCDotbDlsYDpg6jnu5HlrprvvIwqKuecn+ato+eahOWFqOWxgCBjb25zb2xlIOS7juacquiiq+eisOi/hyoq77ybXG4gKiAtIOWxgOmDqOe7keWumuWcqOW8guatpeWHveaVsOW8gOWktOWQjOatpeaxguWAvO+8jOaJgOS7peWNs+S9v+WQjumdoiBhd2FpdCDlvojkuYXvvIxcbiAqICAg6KKr5pS+5byD55qE5Luj56CB5Lmf5LuN54S25o+h552A6Ieq5bex55qE5byV55SoIOKAlOKAlCDov5jljp/kuI3kvJrmiorlroPlvITlnY/jgIJcbiAqXG4gKiDnlKggYGxldGAg6ICM5LiN5pivIGBjb25zdGDvvJrnlKjmiLfku6PnoIHph4znu5nov5nkupvlkI3lrZfph43mlrDotYvlgLzkuI3kvJrngrjjgIJcbiAqIOS7o+S7t+aYr+eUqOaIt+S7o+eggeS4jeiDveWGjeeUqCBgbGV0IGNjID0gLi4uYCDpga7olL3vvIjkvJrmiqXph43lpI3lo7DmmI7vvInigJTigJQg5LiOIGBuZXcgRnVuY3Rpb25gXG4gKiDkvKDlvaLlj4LnmoTml6flhpnms5XpmZDliLbkuIDoh7TvvIzlsZ7kuo7lj6/mjqXlj5fnmoTnuqblrprjgIJcbiAqXG4gKiDimqAg6KGM5Y+35YGP56e777ya55So5oi35Luj56CB5LuO56ysIDIg6KGM5byA5aeL77yM5omA5Lul5oql6ZSZ6KGM5Y+35q+U5rqQ56CB6KGM5Y+35aSnIDHjgIJcbiAqL1xuZnVuY3Rpb24gYnVpbGRTY2VuZVNvdXJjZShnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgY29kZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuYW1lcyA9IE9iamVjdC5rZXlzKGdsb2JhbHMpO1xuICAgIC8vIOazqOaEj++8mmBsZXRgIOWFs+mUruWtl+WPquiDveWHuueOsOS4gOasoeOAguWGmeaIkCBgbGV0IGEgPSAxLCBsZXQgYiA9IDJgIOS8muaKpVxuICAgIC8vIFwibGV0IGlzIGRpc2FsbG93ZWQgYXMgYSBsZXhpY2FsbHkgYm91bmQgbmFtZVwi77yI6Lip6L+H77yJ44CCXG4gICAgY29uc3QgZGVjbGFyYXRpb25zID0gYGxldCAke25hbWVzLm1hcCgobmFtZSkgPT4gYCR7bmFtZX0gPSBfX2RzaEN0eC4ke25hbWV9YCkuam9pbignLCAnKX1gO1xuICAgIHJldHVybiBgKGFzeW5jICgpID0+IHsgY29uc3QgX19kc2hDdHggPSBnbG9iYWxUaGlzLiR7SU5KRUNUX0dMT0JBTF9LRVl9OyAke2RlY2xhcmF0aW9uc307XFxuJHtjb2RlfVxcbn0pKCk7YDtcbn1cblxudHlwZSBGaW5pc2hGbiA9IChleHRyYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4vKiog562W55Wl5LiA77yaYHZtLnJ1bkluVGhpc0NvbnRleHRgIOKAlOKAlCDlkIwgcmVhbG0gKyDlkIzmraXotoXml7bvvIjpppbpgInvvIkgKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1blZpYVJ1bkluVGhpc0NvbnRleHQoXG4gICAgdm1Nb2Q6IGFueSxcbiAgICBnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4gICAgZmluaXNoOiBGaW5pc2hGbixcbiAgICBzdGF0ZTogeyBzbmFwc2hvdFJlcXVlc3RlZDogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHRhcmdldCA9IGdsb2JhbFRoaXMgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBoYWRQcmV2aW91cyA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChnbG9iYWxUaGlzLCBJTkpFQ1RfR0xPQkFMX0tFWSk7XG4gICAgY29uc3QgcHJldmlvdXNWYWx1ZSA9IGhhZFByZXZpb3VzID8gdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXSA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IHJlc3RvcmUgPSAoKTogdm9pZCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoaGFkUHJldmlvdXMpIHRhcmdldFtJTkpFQ1RfR0xPQkFMX0tFWV0gPSBwcmV2aW91c1ZhbHVlO1xuICAgICAgICAgICAgZWxzZSBkZWxldGUgdGFyZ2V0W0lOSkVDVF9HTE9CQUxfS0VZXTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDov5jljp/lpLHotKXkuI3oh7Tlkb3vvJrkuIvkuIDmrKHmiafooYzkvJrph43mlrDopobnm5YgKi9cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICAgIHRhcmdldFtJTkpFQ1RfR0xPQkFMX0tFWV0gPSBnbG9iYWxzO1xuICAgICAgICBjb25zdCByYXcgPSB2bU1vZC5ydW5JblRoaXNDb250ZXh0KGJ1aWxkU2NlbmVTb3VyY2UoZ2xvYmFscywgY29kZSksIHtcbiAgICAgICAgICAgIGZpbGVuYW1lOiAnZHNoLXNjZW5lLWNvZGUuanMnLFxuICAgICAgICAgICAgdGltZW91dDogdGltZW91dE1zLFxuICAgICAgICAgICAgZGlzcGxheUVycm9yczogdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8g5ZCM5q2l5q615bey57uP6LeR5a6M77yI55So5oi35Luj56CB5byA5aS055qEIGxldCDnu5Hlrprlt7Lnu4/msYLlgLzvvInvvIxcbiAgICAgICAgLy8g5omA5Lul6L+Z6YeM5Y+v5Lul56uL5Yi76L+Y5Y6fIOKAlOKAlCDlkI7pnaLnmoTlvILmraXmrrXmjIHmnInnmoTmmK/oh6rlt7HnmoTlsYDpg6jlvJXnlKjvvIzkuI3lj5flvbHlk43jgIJcbiAgICAgICAgcmVzdG9yZSgpO1xuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICBQcm9taXNlLnJlc29sdmUocmF3KSxcbiAgICAgICAgICAgIG5ldyBQcm9taXNlKChfcmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdCh0aW1lb3V0RXJyb3IodGltZW91dE1zKSksIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogdHJ1ZSwgcmVzdWx0LCBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goe1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9ySW5mbyhlcnIpLFxuICAgICAgICAgICAgdGltZWRPdXQ6IGlzVGltZW91dChlcnIpLFxuICAgICAgICAgICAgc25hcHNob3RSZXF1ZXN0ZWQ6IHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkLFxuICAgICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHJlc3RvcmUoKTtcbiAgICB9XG59XG5cbi8qKlxuICog562W55Wl5LqM77yaYG5ldyBGdW5jdGlvbmAg4oCU4oCUIOWFnOW6leOAglxuICpcbiAqIOWFqOWxgOmHj+i1sCoq5pi+5byP5b2i5Y+CKirvvIzkuI3norAgYGdsb2JhbFRoaXNg77yM5Lu75L2VIEpTIOeOr+Wig+mDveiDveeUqOOAglxuICog5Luj5Lu377yaYHRpbWVvdXRgIOWPqueUseWkluWxguiuoeaXtuWZqOWunueOsO+8jCoq5o6Q5LiN5pat5ZCM5q2l5q275b6q546vKirjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuVmlhTmV3RnVuY3Rpb24oXG4gICAgZ2xvYmFsczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgY29kZTogc3RyaW5nLFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuICAgIGZpbmlzaDogRmluaXNoRm4sXG4gICAgc3RhdGU6IHsgc25hcHNob3RSZXF1ZXN0ZWQ6IGJvb2xlYW4gfSxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBuYW1lcyA9IE9iamVjdC5rZXlzKGdsb2JhbHMpO1xuICAgIGNvbnN0IHZhbHVlcyA9IG5hbWVzLm1hcCgobikgPT4gZ2xvYmFsc1tuXSk7XG5cbiAgICBsZXQgZm46ICguLi5mbkFyZ3M6IHVua25vd25bXSkgPT4gdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgICBmbiA9IG5ldyBGdW5jdGlvbiguLi5uYW1lcywgYHJldHVybiAoYXN5bmMgKCkgPT4ge1xcbiR7Y29kZX1cXG59KSgpO2ApIGFzIHR5cGVvZiBmbjtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH0pO1xuICAgIH1cblxuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShmbiguLi52YWx1ZXMpKSxcbiAgICAgICAgICAgIG5ldyBQcm9taXNlKChfcmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdCh0aW1lb3V0RXJyb3IodGltZW91dE1zKSksIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogdHJ1ZSwgcmVzdWx0LCBzbmFwc2hvdFJlcXVlc3RlZDogc3RhdGUuc25hcHNob3RSZXF1ZXN0ZWQgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goe1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9ySW5mbyhlcnIpLFxuICAgICAgICAgICAgdGltZWRPdXQ6IGlzVGltZW91dChlcnIpLFxuICAgICAgICAgICAgc25hcHNob3RSZXF1ZXN0ZWQ6IHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkLFxuICAgICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlU2NlbmVDb2RlKFxuICAgIHBheWxvYWQ6IFJ1bkNvZGVQYXlsb2FkLFxuICAgIGRlcHRoID0gMCxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGxvZ3M6IFNjZW5lTG9nRW50cnlbXSA9IFtdO1xuICAgIGNvbnN0IGNvZGUgPSB0eXBlb2YgcGF5bG9hZC5jb2RlID09PSAnc3RyaW5nJyA/IHBheWxvYWQuY29kZSA6ICcnO1xuICAgIGNvbnN0IG1heExvZ3MgPSB0eXBlb2YgcGF5bG9hZC5tYXhMb2dzID09PSAnbnVtYmVyJyA/IHBheWxvYWQubWF4TG9ncyA6IDIwMDtcbiAgICBjb25zdCBtYXhMb2dMZW5ndGggPSB0eXBlb2YgcGF5bG9hZC5tYXhMb2dMZW5ndGggPT09ICdudW1iZXInID8gcGF5bG9hZC5tYXhMb2dMZW5ndGggOiA0MDAwO1xuICAgIGNvbnN0IHRpbWVvdXRNcyA9IHR5cGVvZiBwYXlsb2FkLnRpbWVvdXRNcyA9PT0gJ251bWJlcicgPyBwYXlsb2FkLnRpbWVvdXRNcyA6IDE1MDAwO1xuXG4gICAgY29uc3QgeyBjb25zb2xlOiBjYXB0dXJlZENvbnNvbGUsIHdhc1RydW5jYXRlZCB9ID0gbWFrZUNhcHR1cmVkQ29uc29sZShcbiAgICAgICAgbG9ncyxcbiAgICAgICAgc3RhcnRlZEF0LFxuICAgICAgICBtYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGgsXG4gICAgKTtcblxuICAgIGNvbnN0IGZpbmlzaCA9IChleHRyYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoe1xuICAgICAgICBsb2dzLFxuICAgICAgICBsb2dzVHJ1bmNhdGVkOiB3YXNUcnVuY2F0ZWQoKSxcbiAgICAgICAgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdCxcbiAgICAgICAgLi4uZXh0cmEsXG4gICAgfSk7XG5cbiAgICBpZiAoIWNvZGUudHJpbSgpKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogZmFsc2UsIGVycm9yOiB7IG5hbWU6ICdFcnJvcicsIG1lc3NhZ2U6ICdjb2RlIOS4jeiDveS4uuepuicgfSB9KTtcbiAgICB9XG5cbiAgICBsZXQgY2M6IGFueTtcbiAgICB0cnkge1xuICAgICAgICBjYyA9IGdldENjKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBmaW5pc2goeyBvazogZmFsc2UsIGVycm9yOiBlcnJvckluZm8oZXJyKSB9KTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGhlbHBlcnMsIHN0YXRlIH0gPSBtYWtlSGVscGVycyhjYywgeyBwcm9qZWN0UGF0aDogcGF5bG9hZC5wcm9qZWN0UGF0aCB9KTtcbiAgICBjb25zdCBzY2VuZSA9IGN1cnJlbnRTY2VuZShjYyk7XG5cbiAgICAvLyByZWNpcGUg5LqU5Lu25aWXIOKAlOKAlCDkuI4gZWRpdG9yIOS4iuS4i+aWhyoq5ZCM5LiA5Lu95a6e546wKirvvIjot6jov5vnqIsgcmVxdWlyZSBkaXN0L2NvcmUvcmVjaXBlcy5qc++8ieOAglxuICAgIC8vIOWKoOi9veWksei0peS4jeiuqeaVtOS4qiBleGVjdXRlX2NvZGUg5oyC5o6J77yM6ICM5piv6ZmN57qn5oiQ44CM5LqU5Liq6YO96L+U5Zue6ZSZ6K+v44CN44CCXG4gICAgbGV0IHJlY2lwZUhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlY2lwZXMgPSBnZXRSZWNpcGVzTW9kdWxlKCk7XG4gICAgICAgIHJlY2lwZUhlbHBlcnMgPSByZWNpcGVzLmJ1aWxkUmVjaXBlSGVscGVycyh7XG4gICAgICAgICAgICBwcm9qZWN0UGF0aDogY3VycmVudFByb2plY3RQYXRoKCksXG4gICAgICAgICAgICBjb250ZXh0OiAnc2NlbmUnLFxuICAgICAgICAgICAgZGVmYXVsdFRpbWVvdXRNczogdGltZW91dE1zLFxuICAgICAgICAgICAgLy8g5oOw5oCn5ou/5omn6KGM5Zmo77yacmVjaXBlIOWKqeaJi+imgeiDvVwi6LeR5LiA5q615Luj56CBXCLvvIzogIzpgqPmrrXku6PnoIHlj4jpnIDopoHlkIzmoLfnmoTlhajlsYDph49cbiAgICAgICAgICAgIC8vIO+8iOWMheaLrCByZWNpcGUg5Yqp5omL6Ieq5bex77yJ4oCU4oCUIOS6kuebuOW8leeUqO+8jOW/hemhu+aZmue7keWumuOAglxuICAgICAgICAgICAgZ2V0UnVubmVyOiAoKSA9PiBhc3luYyAoXG4gICAgICAgICAgICAgICAgcmVjaXBlQ29kZTogc3RyaW5nLFxuICAgICAgICAgICAgICAgIHJlY2lwZUFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICAgICAgICAgIG5lc3RlZFRpbWVvdXRNczogbnVtYmVyLFxuICAgICAgICAgICAgKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmVzdGVkID0gYXdhaXQgZXhlY3V0ZVNjZW5lQ29kZShcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29kZTogcmVjaXBlQ29kZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3M6IHJlY2lwZUFyZ3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyDltYzlpZfmiafooYzkuI7mnKzmrKHmiafooYwqKuWFseS6q+WkluWxgiB2bSDnmoTlkIzmraXotoXml7bpooTnrpcqKu+8iOWkluWxgiB3YXRjaGRvZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8g5bey57uP5Zyo6K6h5pe25LqG77yJ77yM5omA5Lul5LiN5YWB6K645a2QIHJlY2lwZSDmiorotoXml7borr7lvpfmr5TlpJblsYLov5jplb8g4oCU4oCUXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyDlkKbliJnmiqXlh7rmnaXnmoTmmK/lpJblsYLnmoTotoXml7bvvIzmjpLmn6Xml7bkuIDohLjpl67lj7fjgIJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRpbWVvdXRNczogTWF0aC5taW4obmVzdGVkVGltZW91dE1zLCB0aW1lb3V0TXMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWF4TG9ncyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heExvZ0xlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgZGVwdGggKyAxLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgLy8gcmVjaXBlIOmHjOiwgyBzbmFwc2hvdCgpIOS5n+imgeiDveeZu+iusOWIsOacrOasoeaJp+ihjOeahOaSpOmUgOW/q+eFp+S4ilxuICAgICAgICAgICAgICAgIGlmIChuZXN0ZWQuc25hcHNob3RSZXF1ZXN0ZWQpIHN0YXRlLnNuYXBzaG90UmVxdWVzdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXN0ZWRMb2dzID0gQXJyYXkuaXNBcnJheShuZXN0ZWQubG9ncykgPyAobmVzdGVkLmxvZ3MgYXMgU2NlbmVMb2dFbnRyeVtdKSA6IFtdO1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIG9rOiBCb29sZWFuKG5lc3RlZC5vayksXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdDogbmVzdGVkLnJlc3VsdCxcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IG5lc3RlZC5lcnJvcixcbiAgICAgICAgICAgICAgICAgICAgbG9nczpcbiAgICAgICAgICAgICAgICAgICAgICAgIG5lc3RlZExvZ3MubGVuZ3RoID4gMFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gbmVzdGVkTG9ncy5tYXAoKGVudHJ5KSA9PiBgWyR7ZW50cnkubGV2ZWx9XSAke2VudHJ5LnRleHR9YClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgZHVyYXRpb25NczogdHlwZW9mIG5lc3RlZC5kdXJhdGlvbk1zID09PSAnbnVtYmVyJyA/IG5lc3RlZC5kdXJhdGlvbk1zIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICB0aW1lZE91dDogQm9vbGVhbihuZXN0ZWQudGltZWRPdXQpLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9LFxuICAgICAgICB9KS5oZWxwZXJzO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JJbmZvKGVycikubWVzc2FnZTtcbiAgICAgICAgY29uc3QgZmFpbCA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoeyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH0pO1xuICAgICAgICByZWNpcGVIZWxwZXJzID0ge1xuICAgICAgICAgICAgZmluZFJlY2lwZXM6IGZhaWwsXG4gICAgICAgICAgICByZWFkUmVjaXBlOiBmYWlsLFxuICAgICAgICAgICAgc2F2ZVJlY2lwZTogZmFpbCxcbiAgICAgICAgICAgIHJ1blJlY2lwZTogZmFpbCxcbiAgICAgICAgICAgIGRlbGV0ZVJlY2lwZTogZmFpbCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBnbG9iYWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgY2MsXG4gICAgICAgIGNvY29zOiBjYyxcbiAgICAgICAgRWRpdG9yLFxuICAgICAgICBkaXJlY3RvcjogY2MuZGlyZWN0b3IsXG4gICAgICAgIHNjZW5lLFxuICAgICAgICBqczogY2MuanMsXG4gICAgICAgIGZpbmQ6IGNjLmZpbmQsXG4gICAgICAgIGFyZ3M6IHBheWxvYWQuYXJncyAmJiB0eXBlb2YgcGF5bG9hZC5hcmdzID09PSAnb2JqZWN0JyA/IHBheWxvYWQuYXJncyA6IHt9LFxuICAgICAgICBjb25zb2xlOiBjYXB0dXJlZENvbnNvbGUsXG4gICAgICAgIC4uLmhlbHBlcnMsXG4gICAgICAgIC4uLnJlY2lwZUhlbHBlcnMsXG4gICAgfTtcblxuICAgIC8vIOmmlumAiSB2bS5ydW5JblRoaXNDb250ZXh077yI5ZCMIHJlYWxtICsg5ZCM5q2l6LaF5pe277yJ77yb5byV5pOO6L+b56iL6YeM5ou/5LiN5YiwIHZtIOaJjeWbnuiQveOAglxuICAgIC8vIOS4pOadoei3r+W+hOWvueeUqOaIt+S7o+eggeeahOWGmeazleimgeaxguWujOWFqOS4gOiHtOOAglxuICAgIGNvbnN0IHZtTW9kID0gZ2V0Vm1Nb2R1bGUoKTtcbiAgICBpZiAodm1Nb2QpIHtcbiAgICAgICAgcmV0dXJuIHJ1blZpYVJ1bkluVGhpc0NvbnRleHQodm1Nb2QsIGdsb2JhbHMsIGNvZGUsIHRpbWVvdXRNcywgZmluaXNoLCBzdGF0ZSk7XG4gICAgfVxuICAgIHJldHVybiBydW5WaWFOZXdGdW5jdGlvbihnbG9iYWxzLCBjb2RlLCB0aW1lb3V0TXMsIGZpbmlzaCwgc3RhdGUpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFQSSDmj4/ov7DvvIhkaXNjb3ZlciDnmoTkuIDljYrvvIlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgRGVzY3JpYmVBcGlQYXlsb2FkIHtcbiAgICB0YXJnZXQ/OiBzdHJpbmc7XG4gICAgbm9kZVV1aWQ/OiBzdHJpbmc7XG4gICAgbGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKiDnlJ/miJDmn5DkuKrnsbvnmoTjgIxUUyDpo47moLzlrprkuYnjgI3vvIzluKblrp7ml7blgLwgKi9cbmZ1bmN0aW9uIGRlc2NyaWJlQ2xhc3MoY2M6IGFueSwgQ2xzOiBhbnksIGluc3RhbmNlOiBhbnksIGNsYXNzTmFtZTogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogc3RyaW5nIHtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBwcm9wcyA9IGNvbXBvbmVudFByb3BOYW1lcyhpbnN0YW5jZSB8fCB7IGNvbnN0cnVjdG9yOiBDbHMgfSk7XG4gICAgbGV0IHBhcmVudE5hbWUgPSAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJlbnQgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoQ2xzLnByb3RvdHlwZSk7XG4gICAgICAgIGlmIChwYXJlbnQgJiYgcGFyZW50LmNvbnN0cnVjdG9yICYmIHBhcmVudC5jb25zdHJ1Y3Rvci5uYW1lKSB7XG4gICAgICAgICAgICBwYXJlbnROYW1lID0gcGFyZW50LmNvbnN0cnVjdG9yLm5hbWU7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcGFyZW50TmFtZSA9ICcnO1xuICAgIH1cblxuICAgIGxpbmVzLnB1c2goYC8vICR7Y2xhc3NOYW1lfSR7cGFyZW50TmFtZSA/IGAgIGV4dGVuZHMgJHtwYXJlbnROYW1lfWAgOiAnJ31gKTtcbiAgICBpZiAoaW5zdGFuY2UpIHtcbiAgICAgICAgbGluZXMucHVzaChgLy8g5p2l6Ieq5a6e5pe25a6e5L6L77yI6IqC54K5ICR7aW5zdGFuY2Uubm9kZSA/IGluc3RhbmNlLm5vZGUubmFtZSA6ICc/J33vvIlgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsaW5lcy5wdXNoKCcvLyDmnKrmj5Dkvpsgbm9kZVV1aWTvvIzml6Dlrp7ml7blgLzvvJvlsZ7mgKflkI3lj5boh6rnsbvlo7DmmI4nKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChgZXhwb3J0IGNsYXNzICR7Y2xhc3NOYW1lLnNwbGl0KCcuJykucG9wKCl9IHtgKTtcblxuICAgIGNvbnN0IHNob3duID0gcHJvcHMuc2xpY2UoMCwgbGltaXQpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIHNob3duKSB7XG4gICAgICAgIGxldCB0eXBlTmFtZSA9ICdhbnknO1xuICAgICAgICBsZXQgY3VycmVudCA9ICcnO1xuICAgICAgICBpZiAoaW5zdGFuY2UpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlYWQgPSBzYWZlUmVhZChpbnN0YW5jZSwga2V5KTtcbiAgICAgICAgICAgIGlmIChyZWFkLm9rKSB7XG4gICAgICAgICAgICAgICAgdHlwZU5hbWUgPSBpbmZlclRzVHlwZShyZWFkLnZhbHVlKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50ID0gKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdiA9IHJlYWQudmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICh2ID09PSBudWxsIHx8IHYgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFN0cmluZyh2KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ1tvYmplY3RdJztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gU3RyaW5nKHYpO1xuICAgICAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnQubGVuZ3RoID4gNjApIGN1cnJlbnQgPSBgJHtjdXJyZW50LnNsaWNlKDAsIDYwKX3igKZgO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGxpbmVzLnB1c2goYCAgICAke2tleX06ICR7dHlwZU5hbWV9OyR7Y3VycmVudCA/IGAgIC8vIOW9k+WJjSA9ICR7Y3VycmVudH1gIDogJyd9YCk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5sZW5ndGggPiBzaG93bi5sZW5ndGgpIHtcbiAgICAgICAgbGluZXMucHVzaChgICAgIC8vIOKApuWPpuaciSAke3Byb3BzLmxlbmd0aCAtIHNob3duLmxlbmd0aH0g5Liq5bGe5oCnYCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goJ30nKTtcblxuICAgIC8vIOWOn+Wei+aWueazle+8muWRiuiviSBBSeOAjOi/meS4que7hOS7tuiDveiwg+S7gOS5iOOAjVxuICAgIGNvbnN0IG1ldGhvZHM6IHN0cmluZ1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKENscy5wcm90b3R5cGUpKSB7XG4gICAgICAgICAgICBpZiAobmFtZSA9PT0gJ2NvbnN0cnVjdG9yJyB8fCBwcm9wcy5pbmNsdWRlcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgICAgICBsZXQgaXNGbiA9IGZhbHNlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpc0ZuID0gdHlwZW9mIENscy5wcm90b3R5cGVbbmFtZV0gPT09ICdmdW5jdGlvbic7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpc0ZuID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNGbikgbWV0aG9kcy5wdXNoKG5hbWUpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOW/veeVpSAqL1xuICAgIH1cbiAgICBpZiAobWV0aG9kcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goJycpO1xuICAgICAgICBsaW5lcy5wdXNoKGAvLyDlj6/osIPnlKjmlrnms5XvvIjliY0gJHtNYXRoLm1pbig2MCwgbWV0aG9kcy5sZW5ndGgpfSDkuKrvvInvvJpgKTtcbiAgICAgICAgbGluZXMucHVzaChgLy8gJHttZXRob2RzLnNsaWNlKDAsIDYwKS5qb2luKCcsICcpfWApO1xuICAgIH1cbiAgICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8qKiBgY2NgIOaooeWdl+eahOmhtuWxguWvvOWHuua4heWNle+8iOWkp+WGmeW8gOWktOaIluWHveaVsO+8jOWkn+eUqOadpeW9k+e0ouW8leeUqO+8iSAqL1xuZnVuY3Rpb24gbGlzdENjRXhwb3J0cyhjYzogYW55LCBsaW1pdDogbnVtYmVyKTogeyB0b3RhbDogbnVtYmVyOyBuYW1lczogc3RyaW5nW10gfSB7XG4gICAgY29uc3QgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2MpKSB7XG4gICAgICAgICAgICBpZiAoL15bQS1aXS8udGVzdChrZXkpIHx8IHR5cGVvZiBjY1trZXldID09PSAnZnVuY3Rpb24nKSBuYW1lcy5wdXNoKGtleSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5b+955WlICovXG4gICAgfVxuICAgIHJldHVybiB7IHRvdGFsOiBuYW1lcy5sZW5ndGgsIG5hbWVzOiBuYW1lcy5zbGljZSgwLCBsaW1pdCkgfTtcbn1cblxuLyoqIOWcuuaZr+S+p+aAu+iniOi9veiNt++8iOaXoCB0YXJnZXQg5LiOIHRhcmdldD09PSdjYycg5YWx55So77yJICovXG5mdW5jdGlvbiBidWlsZFNjZW5lSW5kZXgoY2M6IGFueSwgbGltaXQ6IG51bWJlciwgd2l0aEhpbnQ6IGJvb2xlYW4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgZXhwb3J0cyA9IGxpc3RDY0V4cG9ydHMoY2MsIGxpbWl0KTtcbiAgICBjb25zdCB7IGhlbHBlcnMgfSA9IG1ha2VIZWxwZXJzKGNjKTtcblxuICAgIGxldCByZWNpcGVIZWxwZXJOYW1lczogc3RyaW5nW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICByZWNpcGVIZWxwZXJOYW1lcyA9IChnZXRSZWNpcGVzTW9kdWxlKCkuUkVDSVBFX0hFTFBFUl9TSUdOQVRVUkVTIGFzIHN0cmluZ1tdKS5tYXAoKHNpZ25hdHVyZSkgPT5cbiAgICAgICAgICAgIHNpZ25hdHVyZS5zbGljZSgwLCBzaWduYXR1cmUuaW5kZXhPZignKCcpKSxcbiAgICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmVjaXBlSGVscGVyTmFtZXMgPSBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGtpbmQ6ICdpbmRleCcsXG4gICAgICAgIGhlbHBlckZ1bmN0aW9uczogT2JqZWN0LmtleXMoaGVscGVycykuc29ydCgpLFxuICAgICAgICByZWNpcGVIZWxwZXJGdW5jdGlvbnM6IHJlY2lwZUhlbHBlck5hbWVzLFxuICAgICAgICByZWNpcGVEaXI6IHJlY2lwZXNSb290SGludCgpLFxuICAgICAgICBjY0V4cG9ydENvdW50OiBleHBvcnRzLnRvdGFsLFxuICAgICAgICBjY0V4cG9ydHM6IGV4cG9ydHMubmFtZXMsXG4gICAgfTtcbiAgICBpZiAod2l0aEhpbnQpIHtcbiAgICAgICAgcGF5bG9hZC5oaW50ID1cbiAgICAgICAgICAgICfnlKggZGVzY3JpYmVfYXBpKHsgY29udGV4dDpcInNjZW5lXCIsIHRhcmdldDpcImNjLkNhbWVyYVwiIH0pIOeci+afkOS4quexu+eahOWumuS5ie+8mycgK1xuICAgICAgICAgICAgJ+W4piBub2RlVXVpZCDliJnnlKjoioLngrnkuIrnmoTlrp7ml7blrp7kvovooaXlh7rnnJ/lrp7nsbvlnovkuI7lvZPliY3lgLzjgIInICtcbiAgICAgICAgICAgICdkZXNjcmliZV9hcGkoeyBjb250ZXh0Olwic2NlbmVcIiwgdGFyZ2V0OlwiaGVscGVyc1wiIH0pIOeci+WFqOmDqOWKqeaJi+WHveaVsOetvuWQjeOAgic7XG4gICAgfVxuICAgIHJldHVybiBwYXlsb2FkO1xufVxuXG5mdW5jdGlvbiBkZXNjcmliZVNjZW5lQXBpKGNjOiBhbnksIHBheWxvYWQ6IERlc2NyaWJlQXBpUGF5bG9hZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCB0YXJnZXQgPSB0eXBlb2YgcGF5bG9hZC50YXJnZXQgPT09ICdzdHJpbmcnID8gcGF5bG9hZC50YXJnZXQudHJpbSgpIDogJyc7XG4gICAgY29uc3QgbGltaXQgPSB0eXBlb2YgcGF5bG9hZC5saW1pdCA9PT0gJ251bWJlcicgPyBNYXRoLm1heCgxLCBNYXRoLm1pbig1MDAsIHBheWxvYWQubGltaXQpKSA6IDgwO1xuXG4gICAgLy8gMSkg5rKh5pyJIHRhcmdldO+8mue7meWHuuOAjOi1t+aJi+W8j+OAjea4heWNlSArIGNjIOaooeWdl+eahOmhtuWxguWFpeWPo1xuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgIHJldHVybiBidWlsZFNjZW5lSW5kZXgoY2MsIGxpbWl0LCB0cnVlKTtcbiAgICB9XG5cbiAgICAvLyAyKSDmmL7lvI/pl67liqnmiYvlh73mlbBcbiAgICBpZiAodGFyZ2V0ID09PSAnaGVscGVycycgfHwgdGFyZ2V0ID09PSAnaGVscGVyJykge1xuICAgICAgICBjb25zdCB7IGhlbHBlcnMgfSA9IG1ha2VIZWxwZXJzKGNjKTtcbiAgICAgICAgY29uc3QgZG9jczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgICAgIG5vZGVCeVV1aWQ6ICdub2RlQnlVdWlkKHV1aWQpIOKGkiBOb2RlIHwgbnVsbCcsXG4gICAgICAgICAgICBub2RlQnlQYXRoOiBcIm5vZGVCeVBhdGgoJ0NhbnZhcy9QYW5lbCcpIOKGkiBOb2RlIHwgbnVsbCAgLy8g6K6k5b6X5ZCN5a2X6YeM5ZCrICcvJyDnmoToioLngrlcIixcbiAgICAgICAgICAgIGVhY2hOb2RlOiAnZWFjaE5vZGUodmlzaXQsIHJvb3Q/LCB7aW5jbHVkZUVkaXRvcn0/KSDihpIgdm9pZCAgLy8g6buY6K6k6Lez6L+H57yW6L6R5ZmoIGdpem1vJyxcbiAgICAgICAgICAgIGNvbnRlbnRDaGlsZHJlbjogJ2NvbnRlbnRDaGlsZHJlbihub2RlPykg4oaSIE5vZGVbXSAgLy8g55yf5a6e5YaF5a655a2Q6IqC54K577yI5bey5ruk5o6J57yW6L6R5Zmo6KOF6aWw77yJJyxcbiAgICAgICAgICAgIGlzRWRpdG9yTm9kZTogJ2lzRWRpdG9yTm9kZShub2RlKSDihpIgYm9vbGVhbiAgLy8g5piv5LiN5piv57yW6L6R5Zmo6Ieq5bex55qEIGdpem1vL+e9keagvC/lj4LogIPlm74nLFxuICAgICAgICAgICAgdHJlZTogJ3RyZWUoeyByb290PywgbWF4RGVwdGg/LCB3aXRoQ29tcG9uZW50cz8sIGluY2x1ZGVFZGl0b3I/IH0pIOKGkiDlsYLnuqfpqqjmnrblr7nosaEnLFxuICAgICAgICAgICAgZHVtcDogJ2R1bXAobm9kZU9yQ29tcG9uZW50KSDihpIg5pi+5byP5Y+W5a2X5q615ZCO55qE57qv5pWw5o2u5a+56LGhJyxcbiAgICAgICAgICAgIHNuYXBzaG90OiAnc25hcHNob3QoKSDihpIgdm9pZCAgLy8g5qCH6K6w5pys5qyh5omn6KGM6KaB5rOo5YaM5pKk6ZSA5b+r54WnJyxcbiAgICAgICAgICAgIHNsZWVwOiAnc2xlZXAobXMpIOKGkiBQcm9taXNlICAvLyDova7or6LnrYnlvoUnLFxuICAgICAgICAgICAgY2FwdHVyZVZpZXc6XG4gICAgICAgICAgICAgICAgXCJjYXB0dXJlVmlldyh7IHNhdmVQYXRoPywgbWF4V2lkdGg/LCBmb3JtYXQ/LCBxdWFsaXR5Pywgd2FpdE1zPyB9KSDihpIgUHJvbWlzZTx7b2ssIHBhdGg/LCBjaHVua3M/LCB3aWR0aCwgaGVpZ2h0LCBieXRlcywgYmxhbmtSYXRpb30+ICAvLyDmiKrlnLrmma/op4blm77lvZPliY3kuIDluKfvvIjlkKvnvZHmoLwvZ2l6bW/vvInlrZjmiJAgcG5nL2pwZWdcIixcbiAgICAgICAgICAgIGxvYWRGcmFtZTpcbiAgICAgICAgICAgICAgICBcImxvYWRGcmFtZSgnZGI6Ly9hc3NldHMvLi4uL3gucG5nJyB8ICc8dXVpZD5AZjk5NDEnIHwgJzx1dWlkPicpIOKGkiBQcm9taXNlPFNwcml0ZUZyYW1lPiAgLy8g5Y+W5Zu+54mH55qEIFNwcml0ZUZyYW1l77yb5Yir5YaN5omL5pCTIEBmOTk0Me+8jOS5n+WIq+eUqCBjYy5yZXNvdXJjZXMubG9hZO+8iOe8lui+keWZqOWcuuaZr+mHjOW/heWksei0pe+8iVwiLFxuICAgICAgICAgICAgd29ybGRSZWN0OlxuICAgICAgICAgICAgICAgICd3b3JsZFJlY3Qobm9kZSwgeyByb290PyB9KSDihpIge2N4LCBjeSwgd2lkdGgsIGhlaWdodCwgbGVmdCwgcmlnaHQsIGJvdHRvbSwgdG9wfSAgLy8g57yW6L6R5oCB5Y+v5L+h55qE5LiW55WM55+p5b2i77yIcG9zaXRpb24rYW5jaG9yK2NvbnRlbnRTaXplIOiHqua0vee0r+WKoO+8ie+8m+WIq+eUqCBnZXRCb3VuZGluZ0JveFRvV29ybGQnLFxuICAgICAgICAgICAgaGVscGVyTmFtZXM6ICdoZWxwZXJOYW1lcygpIOKGkiBzdHJpbmdbXScsXG4gICAgICAgIH07XG4gICAgICAgIGxldCByZWNpcGVIZWxwZXJzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc2lnbmF0dXJlOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZSA9IGdldFJlY2lwZXNNb2R1bGUoKTtcbiAgICAgICAgICAgIHJlY2lwZUhlbHBlcnMgPSAobW9kdWxlLlJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyBhcyBzdHJpbmdbXSkubWFwKChzaWduYXR1cmUpID0+ICh7XG4gICAgICAgICAgICAgICAgbmFtZTogc2lnbmF0dXJlLnNsaWNlKDAsIHNpZ25hdHVyZS5pbmRleE9mKCcoJykpLFxuICAgICAgICAgICAgICAgIHNpZ25hdHVyZSxcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZWNpcGVIZWxwZXJzID0gW107XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAga2luZDogJ2hlbHBlcnMnLFxuICAgICAgICAgICAgaGVscGVyczogW1xuICAgICAgICAgICAgICAgIC4uLk9iamVjdC5rZXlzKGhlbHBlcnMpXG4gICAgICAgICAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgobmFtZSkgPT4gKHsgbmFtZSwgc2lnbmF0dXJlOiBkb2NzW25hbWVdIHx8IG5hbWUgfSkpLFxuICAgICAgICAgICAgICAgIC4uLnJlY2lwZUhlbHBlcnMsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVjaXBlRGlyOiByZWNpcGVzUm9vdEhpbnQoKSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyAzKSDop6PmnpAgY2MuWHh4Lll5eVxuICAgIGNvbnN0IHBhcnRzID0gdGFyZ2V0LnNwbGl0KCcuJykuZmlsdGVyKEJvb2xlYW4pO1xuICAgIGlmIChwYXJ0c1swXSAhPT0gJ2NjJykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGBzY2VuZSDkuIrkuIvmloflj6rorqQgJ2NjLionIOaIliAnaGVscGVycyfvvIzmlLbliLDvvJoke3RhcmdldH1gLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIOaOkOaOieW8gOWktOeahCAnY2Mn77ya6LW354K55pys5p2l5bCx5pivIGNjIOaooeWdl++8jOiuqSBwYXJ0c1swXSDlho3otbDkuIDmrKHkvJrlj5bliLAgYGNjLmNjYO+8iHVuZGVmaW5lZO+8ie+8jFxuICAgIC8vIOS6juaYr+aJgOaciSAnY2MuWHh4JyDpg73kvJror6/miqXjgIzlnKggWHh4IOWkhOaWremTvuOAje+8iOi4qei/h++8ieOAglxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhcnRzLnNsaWNlKDEpO1xuICAgIGlmIChwYXRoUGFydHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiBidWlsZFNjZW5lSW5kZXgoY2MsIGxpbWl0LCBmYWxzZSk7XG4gICAgfVxuXG4gICAgbGV0IG5vZGU6IGFueSA9IGNjO1xuICAgIGZvciAoY29uc3QgcGFydCBvZiBwYXRoUGFydHMpIHtcbiAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fe+8iOWcqCAke3BhcnR9IOWkhOaWremTvu+8iWAgfTtcbiAgICAgICAgfVxuICAgICAgICBub2RlID0gKG5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW3BhcnRdO1xuICAgIH1cbiAgICBpZiAobm9kZSA9PT0gbnVsbCB8fCBub2RlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsCAke3RhcmdldH1gIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBub2RlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIOS4jeaYr+exu++8muebtOaOpeaPj+i/sOi/meS4quWAvFxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBraW5kOiAndmFsdWUnLFxuICAgICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgICAgdHlwZTogaW5mZXJUc1R5cGUobm9kZSksXG4gICAgICAgICAgICB0ZXh0OiBkZXNjcmliZUNsYXNzKGNjLCBub2RlLmNvbnN0cnVjdG9yIHx8IE9iamVjdCwgbnVsbCwgdGFyZ2V0LCBsaW1pdCksXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gNCkg5piv57G7IOKAlOKAlCDkvJjlhYjnlKjoioLngrnkuIrnmoTlrp7ml7blrp7kvovooaXnsbvlnotcbiAgICBsZXQgaW5zdGFuY2U6IGFueSA9IG51bGw7XG4gICAgbGV0IGluc3RhbmNlTm90ZSA9ICcnO1xuICAgIGlmIChwYXlsb2FkLm5vZGVVdWlkKSB7XG4gICAgICAgIGNvbnN0IHNjZW5lID0gY3VycmVudFNjZW5lKGNjKTtcbiAgICAgICAgY29uc3QgaG9zdCA9IHNjZW5lID8gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQocGF5bG9hZC5ub2RlVXVpZCkgOiBudWxsO1xuICAgICAgICBpZiAoaG9zdCkge1xuICAgICAgICAgICAgaW5zdGFuY2UgPSBob3N0LmdldENvbXBvbmVudChub2RlKTtcbiAgICAgICAgICAgIGlmICghaW5zdGFuY2UpIGluc3RhbmNlTm90ZSA9IGDoioLngrkgJHtob3N0Lm5hbWV9IOS4iuayoeaciSAke3RhcmdldH0g57uE5Lu2YDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGluc3RhbmNlTm90ZSA9IGDmib7kuI3liLDoioLngrkgJHtwYXlsb2FkLm5vZGVVdWlkfWA7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAga2luZDogJ2NsYXNzJyxcbiAgICAgICAgdGFyZ2V0LFxuICAgICAgICBjbGFzc05hbWU6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYy5qcy5nZXRDbGFzc05hbWUobm9kZSk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGFyZ2V0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSgpLFxuICAgICAgICBpbnN0YW5jZUZvdW5kOiBCb29sZWFuKGluc3RhbmNlKSxcbiAgICAgICAgbm90ZTogaW5zdGFuY2VOb3RlIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgZGVmaW5pdGlvbjogZGVzY3JpYmVDbGFzcyhjYywgbm9kZSwgaW5zdGFuY2UsIHRhcmdldCwgbGltaXQpLFxuICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5a+55aSW5pa55rOVXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IHsgW2tleTogc3RyaW5nXTogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnkgfSA9IHtcbiAgICAvKiog5o6i5rS777ya5Li76L+b56iL55So5a6D5Yik5pat5Zy65pmv6ISa5pys5piv5ZCm5bey5Yqg6L29ICovXG4gICAgcGluZygpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRzOiBEYXRlLm5vdygpIH07XG4gICAgfSxcblxuICAgIC8qKiDlnKjlvJXmk47kuIrkuIvmlofmiafooYznlKjmiLfku6PnoIEgKi9cbiAgICBhc3luYyBydW5Db2RlKHBheWxvYWQ6IFJ1bkNvZGVQYXlsb2FkKSB7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVDb2RlKHBheWxvYWQgfHwge30pO1xuICAgIH0sXG5cbiAgICAvKiog5riQ6L+b5byP5oqr6Zyy77ya5o+P6L+w5byV5pOOIEFQSSAqL1xuICAgIGFzeW5jIGRlc2NyaWJlQXBpKHBheWxvYWQ6IERlc2NyaWJlQXBpUGF5bG9hZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2MgPSBnZXRDYygpO1xuICAgICAgICAgICAgcmV0dXJuIGRlc2NyaWJlU2NlbmVBcGkoY2MsIHBheWxvYWQgfHwge30pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9ySW5mbyhlcnIpIH07XG4gICAgICAgIH1cbiAgICB9LFxufTtcbiJdfQ==