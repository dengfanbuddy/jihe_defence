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
};
