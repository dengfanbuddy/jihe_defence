"use strict";
/**
 * 编辑器执行引擎 —— dsh_chat 自己的「代码沙箱」，不再借 dfan_mcp2。
 *
 * ## 这一层在哪、干什么
 *
 * ```
 * DSH 子进程 --fork IPC--> 本扩展主进程(cocos-tools) --> 本模块
 *                                                     ├─ editor 上下文：vm 沙箱（core/sandbox）
 *                                                     └─ scene 上下文：本扩展的场景脚本（source/scene.ts）
 * ```
 *
 * 全程**不经过 loopback HTTP**（对比 MCP 的 127.0.0.1:8731），也不经过第二个扩展：
 * 场景脚本是本扩展 `contributions.scene` 自己注册的（`dist/scene.js`），
 * 主进程侧的执行器就是本文件。能力面与原先复用的那套**逐条对齐**：
 * 同一套超时口径、同一套序列化上限、同一套助手（`eachNode` / `tree` / `nodeByPath` /
 * `dump` / `snapshot` / recipe 五件套 …），所以模型的用法一个字都不用改。
 *
 * ## 为什么 editor 与 scene 的执行方式不同（不能统一）
 *
 * - **editor（本模块）**：`vm.createContext` 隔离沙箱。主进程里跑，隔离越严越好。
 * - **scene（source/scene.ts）**：`vm.runInThisContext` 同 realm + 同步超时。
 *   引擎进程**不能**换 realm —— 沙箱里造出来的 `{}` / `[]` 在引擎的 `instanceof` 判断下为假，
 *   会让一堆引擎 API 出现难查的诡异行为。细节见 scene.ts 头部注释。
 *
 * ## 超时的诚实边界
 *
 * `vm` 的 `timeout` 只管同步段；异步靠 `Promise.race` 计时器 —— 它只让**调用方**不再等，
 * **不会真的杀掉**已经在跑的异步代码（Node 没有抢占式取消）。
 * 所以别在沙箱里写 `await new Promise(() => {})` 这种不可结束的等待。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEditorCode = runEditorCode;
exports.runSceneCode = runSceneCode;
exports.executeCode = executeCode;
exports.captureView = captureView;
exports.pingSceneScript = pingSceneScript;
exports.readNodeGeometry = readNodeGeometry;
exports.readSceneRuntime = readSceneRuntime;
exports.describeSceneApi = describeSceneApi;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const capture_1 = require("../capture");
const recipes_1 = require("./recipes");
const scene_bridge_1 = require("./scene-bridge");
const sandbox_1 = require("./sandbox");
const serialize_1 = require("./serialize");
/** 扩展包根目录（`dist/core/engine.js` 往上两级）。 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
/** 沙箱默认值（原先在 dfan_mcp2 的设置面板里调；本扩展不设面板，改成常量 + 单处可改）。 */
const SANDBOX_DEFAULTS = {
    /** `cocos_execute_code` 没传 timeoutMs 时的默认超时 */
    timeoutMs: 15000,
    maxLogs: 200,
    maxLogLength: 4000,
};
/** 返回值序列化上限：深度 6 / 数组 100 / 对象 60 键 / 单字符串 4000 字（与工具描述里写的一致）。 */
const SERIALIZE_OPTIONS = {
    maxDepth: 6,
    maxArrayLength: 100,
    maxObjectKeys: 60,
    maxStringLength: 4000,
};
/** 场景脚本注册的方法名（与 package.json 的 `contributions.scene.methods` 对齐）。 */
const SCENE_METHOD = {
    ping: 'ping',
    runCode: 'runCode',
    describeApi: 'describeApi',
    /** 场景视图几何：Electron 截图靠它定位 webContents 并换算裁切矩形 */
    viewMetrics: 'viewMetrics',
    /** 取景 / 还原视角：「把整个场景塞进画布再截」靠它（见 captureView 的 fit 参数） */
    fitView: 'fitView',
};
/** 把任意异常收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
// ---------------------------------------------------------------------------
// editor 上下文的沙箱全局量
// ---------------------------------------------------------------------------
/**
 * 暴露给沙箱的 `process` 视图。
 *
 * 刻意裁掉 `exit` / `kill` / `env`：
 * - `exit` 会让编辑器主进程直接挂掉（AI 手滑一次就得重启编辑器，还可能丢未保存的场景）；
 * - `env` 里常有 token/密钥，默认不给它顺手抄进模型上下文的机会。
 *
 * 需要的话 `require('process')` 仍然拿得到真的 —— 这是**防手滑，不是防越权**。
 */
function buildSafeProcess() {
    return {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        versions: { ...process.versions },
        pid: process.pid,
        cwd: () => process.cwd(),
        uptime: () => process.uptime(),
        memoryUsage: () => process.memoryUsage(),
        hrtime: (time) => process.hrtime(time),
    };
}
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.min(60000, Math.trunc(Number(ms)) || 0)));
});
/**
 * 图片像素探针 —— **素材级事实**：这张图到底长什么样、能不能染色。
 *
 * ## 为什么它必须在 editor 侧、靠 Electron
 *
 * 「这张图中心的 alpha 是不是 0」「主体是不是白的（能不能用 `Sprite.color` 染色）」
 * 这类问题是**看图**，不是看场景。而：
 *
 * - **场景进程**里拿不到可靠解码路径（要自己上 canvas，且图集子帧/压缩格式各不一样）；
 * - **Node 没有内置 PNG 解码器** —— 在 editor 沙箱里 `fs.readFileSync` 拿到的是一堆字节，
 *   自己解析 IDAT/zlib 是几千行且白干；
 * - ✅ **Electron 主进程的 `nativeImage.createFromPath()` + `toBitmap()`** 一次给到
 *   BGRA 原始像素 —— 零依赖、任意常见格式、任意尺寸。`capture.ts` 抓图已经在用同一套。
 *
 * ## 它替掉的是什么
 *
 * 实测反复出现的三个问题，原先只能靠「打开图片看」或者**猜**：
 *
 * | 问题 | 原答案 | 现在 |
 * |---|---|---|
 * | `rect_rd_10.png` 存不存在 | 拼路径猜、读目录看一眼 | 一次调用，还给**相近名字** |
 * | `rect_board_rd_10` 中心是空的（是"环"不是"板"） | 把白字放上去才发现看不见 | `center.a` = 0 |
 * | `achivement.png` 是深色图形（**染不了色**） | 染了没用，再猜一轮 | `tint.whiteish = false` |
 *
 * ## 诚实的边界
 *
 * - 只吃**磁盘上的图片文件**。`db://internal/…`（引擎内置）不在工程目录，会明说而不是静默失败。
 * - `.meta` 里读不到 uuid 时 `uuid` 为 null（**不影响像素结论**）。
 * - 图集里的**子帧**：这里给的是**整张图**的坐标，要子帧自己用 SpriteFrame 的 `rect` 换算。
 *
 * @param ref 图片路径：`db://assets/…` / 工程相对 / 绝对，三者都行
 * @param options.x 要精确读的那个像素的 x（**整图像素坐标**，原点左上）
 * @param options.y 同上
 */
function probeImage(ref, options) {
    const opts = options || {};
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) {
        throw new Error("probe(ref)：要一个图片路径，例如 probe('db://assets/resources/textures/common/rect_rd_20.png')。");
    }
    let file = raw;
    if (raw.indexOf('db://assets/') === 0) {
        file = path.join(Editor.Project.path, 'assets', raw.slice('db://assets/'.length));
    }
    else if (raw.indexOf('db://') === 0) {
        throw new Error(`probe：'${raw}' 指向的不是工程 assets 里的文件（db://internal 之类是引擎内置资源，磁盘上不在工程目录）。`);
    }
    if (!path.isAbsolute(file))
        file = path.join(Editor.Project.path, file);
    if (!fs.existsSync(file)) {
        // 路径写错是最常见的原因 —— 顺手把同目录下名字相近的列出来，省一轮 listDir
        let nearby = [];
        try {
            const base = path.basename(file).replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase();
            const stem = base.slice(0, Math.min(6, base.length));
            nearby = fs
                .readdirSync(path.dirname(file))
                .filter((name) => name.toLowerCase().indexOf(stem) >= 0)
                .slice(0, 8);
        }
        catch {
            nearby = [];
        }
        return { ok: false, path: file, exists: false, error: `文件不存在：${file}`, nearby };
    }
    let uuid = null;
    try {
        const metaFile = `${file}.meta`;
        if (fs.existsSync(metaFile)) {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            if (meta && typeof meta.uuid === 'string')
                uuid = meta.uuid;
        }
    }
    catch {
        /* 读不到就算了：像素结论不依赖它 */
    }
    /** 与 `audit:ui` 的 P4 同一条判据：引擎内置贴图 uuid 前缀 */
    const engineBuiltin = Boolean(uuid && uuid.indexOf('7d8f9b89') === 0);
    const electron = (0, capture_1.getElectron)();
    if (!electron || !electron.nativeImage || typeof electron.nativeImage.createFromPath !== 'function') {
        return {
            ok: false,
            path: file,
            exists: true,
            uuid,
            error: `拿不到 Electron 的 nativeImage（${(0, capture_1.electronUnavailableReason)() || '当前不在主进程？'}），读不了像素。`,
        };
    }
    let image;
    let size = { width: 0, height: 0 };
    let bitmap;
    try {
        image = electron.nativeImage.createFromPath(file);
        size = image.getSize();
        if (!size.width || !size.height) {
            return { ok: false, path: file, exists: true, uuid, error: 'nativeImage 解不开这张图（格式不认识？）。' };
        }
        bitmap = image.toBitmap(); // BGRA
    }
    catch (err) {
        return {
            ok: false,
            path: file,
            exists: true,
            uuid,
            error: `解像素失败：${err instanceof Error ? err.message : String(err)}`,
        };
    }
    /** BGRA → 一个像素。越界回 null（不抛）。 */
    const pixelAt = (x, y) => {
        if (!(x >= 0 && y >= 0 && x < size.width && y < size.height))
            return null;
        const o = (y * size.width + x) * 4;
        if (o + 3 >= bitmap.length)
            return null;
        return { r: bitmap[o + 2], g: bitmap[o + 1], b: bitmap[o], a: bitmap[o + 3] };
    };
    const toHex = (px) => px ? `#${[px.r, px.g, px.b, px.a].map((v) => v.toString(16).padStart(2, '0')).join('')}` : null;
    // 全图统计（抽样，够下判断且不会被大图拖慢）
    const total = size.width * size.height;
    const step = Math.max(1, Math.floor(total / 20000));
    let sampled = 0;
    let transparent = 0;
    let alphaMin = 255;
    let alphaMax = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let opaqueCount = 0;
    let whiteishCount = 0;
    const colourTally = new Map();
    for (let i = 0; i < total; i += step) {
        const px = pixelAt(i % size.width, Math.floor(i / size.width));
        if (!px)
            continue;
        sampled += 1;
        if (px.a < alphaMin)
            alphaMin = px.a;
        if (px.a > alphaMax)
            alphaMax = px.a;
        if (px.a === 0) {
            transparent += 1;
            continue;
        }
        opaqueCount += 1;
        sumR += px.r;
        sumG += px.g;
        sumB += px.b;
        const maxC = Math.max(px.r, px.g, px.b);
        const minC = Math.min(px.r, px.g, px.b);
        if (px.a >= 200 && minC >= 200 && maxC - minC <= 24)
            whiteishCount += 1;
        const key = `${px.r >> 5},${px.g >> 5},${px.b >> 5}`;
        colourTally.set(key, (colourTally.get(key) || 0) + 1);
    }
    const meanOf = (sum) => (opaqueCount > 0 ? Math.round(sum / opaqueCount) : 0);
    const meanRGB = [meanOf(sumR), meanOf(sumG), meanOf(sumB)];
    const whiteishRatio = opaqueCount > 0 ? Math.round((whiteishCount / opaqueCount) * 100) / 100 : 0;
    const topColours = Array.from(colourTally.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map((entry) => {
        const parts = entry[0].split(',').map((v) => (Number(v) << 5) | 16);
        return {
            hex: `#${parts.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`,
            share: opaqueCount > 0 ? Math.round((entry[1] / opaqueCount) * 100) / 100 : 0,
        };
    });
    const center = pixelAt(Math.floor(size.width / 2), Math.floor(size.height / 2));
    const corners = {
        tl: toHex(pixelAt(0, 0)),
        tr: toHex(pixelAt(size.width - 1, 0)),
        bl: toHex(pixelAt(0, size.height - 1)),
        br: toHex(pixelAt(size.width - 1, size.height - 1)),
    };
    const cornerAlphas = [
        pixelAt(0, 0),
        pixelAt(size.width - 1, 0),
        pixelAt(0, size.height - 1),
        pixelAt(size.width - 1, size.height - 1),
    ].map((px) => (px ? px.a : null));
    /** 真正的那个问题：「这图能不能用 `Sprite.color` 染成任意色」 */
    const canvasLike = cornerAlphas.every((a) => a === 0);
    const tintNote = !canvasLike
        ? '四角不全是透明 —— 它大概是一张**不透明底**的图（或圆角没铺满），染色会染到整块背景。'
        : whiteishRatio >= 0.9
            ? '主体接近白/灰且四角透明 —— 典型的**可染色**图标（`Sprite.color` 能把它变成任意颜色）。'
            : whiteishRatio >= 0.4
                ? '主体是浅色但不够纯白 —— 染色后**颜色会偏**（原色会透出来）。'
                : '主体是**彩色/深色**的 —— 用 `Sprite.color` 染不出想要的颜色（深色只会更黑），要么换图要么别染。';
    const out = {
        ok: true,
        path: file,
        exists: true,
        uuid,
        engineBuiltin,
        bytes: (() => {
            try {
                return fs.statSync(file).size;
            }
            catch {
                return null;
            }
        })(),
        width: size.width,
        height: size.height,
        alpha: {
            min: alphaMin,
            max: alphaMax,
            transparentRatio: sampled > 0 ? Math.round((transparent / sampled) * 100) / 100 : 0,
        },
        center: { rgba: center, hex: toHex(center) },
        corners,
        cornerAlphas,
        fullBleed: cornerAlphas.every((a) => a !== null && a > 0),
        meanRGB,
        whiteishRatio,
        tint: { canvasLike, whiteish: whiteishRatio >= 0.9, note: tintNote },
        topColours,
        sampledPixels: sampled,
        note: '坐标都是**整张图**的像素（原点左上）；图集子帧要自己用 SpriteFrame 的 rect 换算。',
    };
    const wantX = Number(opts.x);
    const wantY = Number(opts.y);
    if (Number.isFinite(wantX) && Number.isFinite(wantY)) {
        const px = pixelAt(Math.round(wantX), Math.round(wantY));
        out.at = { x: Math.round(wantX), y: Math.round(wantY), rgba: px, hex: toHex(px) };
        if (!px)
            out.atNote = `(${wantX}, ${wantY}) 越界了（图是 ${size.width}×${size.height}）`;
    }
    return out;
}
/**
 * editor 起手式助手的签名清单 —— 同一份内容既注入沙箱、也用于 `describe_api` 展示。
 *
 * recipe 那五条也在这里：它们**是助手、不是工具**，工具列表只有四个
 * （`cocos_execute_code` / `cocos_describe_api` / `cocos_editor_state` / `cocos_capture_view`）。
 */
const EDITOR_HELPER_SIGNATURES = [
    'sleep(ms) → Promise',
    'extensionRoot → string（本插件目录）',
    'projectPath() → string',
    'resolveProjectPath(p) → string（相对路径按工程根解析）',
    'listDir(dir) → string[]',
    'readJson(file) → any',
    "probe(ref, {x?, y?}) → {width, height, center, corners, alpha, whiteishRatio, tint, topColours, engineBuiltin, nearby}  // **图片的像素级事实**：读某个像素/中心/四角、透明比例、主体是不是白色（= 能不能用 Sprite.color 染色）、是不是引擎内置贴图。ref 收 'db://assets/…' / 工程相对 / 绝对；文件不存在会顺手列出名字相近的",
    ...recipes_1.RECIPE_HELPER_SIGNATURES,
];
/** editor 上下文的起手式助手（recipe 五件套由 `runEditorContext` 另加）。 */
function buildEditorHelpers() {
    return {
        sleep,
        /** 扩展包根目录 —— 想读本插件源码时用 */
        extensionRoot: EXTENSION_ROOT,
        /** 当前工程根目录 */
        projectPath: () => Editor.Project.path,
        /** 把相对/绝对路径统一成绝对路径（相对工程的路径按工程根解析） */
        resolveProjectPath: (p) => (path.isAbsolute(p) ? p : path.join(Editor.Project.path, p)),
        /** 列目录（只返回名字，避免一次吐太多） */
        listDir: (dir) => {
            const abs = path.isAbsolute(dir) ? dir : path.join(Editor.Project.path, dir);
            return fs.readdirSync(abs);
        },
        /** 读 JSON（配表脚本经常要干这个） */
        readJson: (file) => {
            const abs = path.isAbsolute(file) ? file : path.join(Editor.Project.path, file);
            return JSON.parse(fs.readFileSync(abs, 'utf-8'));
        },
        /** 图片像素探针 —— 见 {@link probeImage} 的说明（「这图能不能染色」靠它一句话答） */
        probe: (ref, options) => probeImage(ref, options),
        helperNames: () => [...EDITOR_HELPER_SIGNATURES],
    };
}
/** 把沙箱日志行转成响应里的字符串数组 */
function formatLogLines(logs) {
    return logs.map((l) => `[${l.level}] ${l.text}`);
}
/** 夹一个调用方传进来的超时（模型与面板都可能给脏值） */
function clampTimeout(value, fallback) {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(100, Math.min(300000, Math.trunc(raw)));
}
/** 整数夹取（截图参数用）。 */
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, n));
}
// ---------------------------------------------------------------------------
// editor 上下文执行
// ---------------------------------------------------------------------------
/**
 * 在**编辑器主进程**里执行一段代码（隔离沙箱）。
 *
 * 返回的 `data` 就是给模型看的那个信封 `{ok, context, durationMs, result|error, logs, notes…}`；
 * `text` 是它的 JSON 文本。**信封形状必须保持稳定** —— `cocos_editor_state` 之类的调用方
 * 靠 `'result' in envelope` 解包（见 cocos-tools 的 `unwrapSandboxResult`）。
 */
async function runEditorCode(code, args, timeoutMs) {
    var _a, _b, _c, _d;
    // 惰性持有执行器：recipe 助手要能调「跑一段代码」，而那段代码又需要同样的全局量
    // （包括 recipe 助手自己）—— 互相引用，所以必须晚绑定。
    const runnerRef = { current: null };
    const { helpers: recipeHelpers } = (0, recipes_1.buildRecipeHelpers)({
        projectPath: Editor.Project.path,
        context: 'editor',
        defaultTimeoutMs: timeoutMs,
        getRunner: () => {
            const runner = runnerRef.current;
            if (!runner)
                throw new Error('recipe 执行器尚未就绪');
            return runner;
        },
    });
    const globals = {
        Editor,
        require,
        module,
        exports,
        __dirname,
        __filename,
        fs,
        path,
        os,
        Buffer,
        process: buildSafeProcess(),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        setImmediate,
        args,
        ...buildEditorHelpers(),
        ...recipeHelpers,
    };
    const sandboxOptions = {
        maxLogs: SANDBOX_DEFAULTS.maxLogs,
        maxLogLength: SANDBOX_DEFAULTS.maxLogLength,
    };
    /** recipe 的执行器：同一个沙箱机制，独立的超时与日志缓冲 */
    runnerRef.current = async (recipeCode, recipeArgs, nestedTimeoutMs) => {
        const nested = await (0, sandbox_1.runInSandbox)({
            code: recipeCode,
            globals: { ...globals, args: recipeArgs },
            label: 'dsh-editor-recipe',
            ...sandboxOptions,
            timeoutMs: nestedTimeoutMs,
        });
        return {
            ok: nested.ok,
            result: nested.result,
            error: nested.error,
            logs: nested.logs.length > 0 ? formatLogLines(nested.logs) : undefined,
            durationMs: nested.durationMs,
            timedOut: nested.timedOut,
        };
    };
    const run = await (0, sandbox_1.runInSandbox)({
        code,
        globals,
        label: 'dsh-editor',
        ...sandboxOptions,
        timeoutMs,
    });
    const serialized = (0, serialize_1.safeSerialize)(run.result, SERIALIZE_OPTIONS);
    // 「上下文选错了」不能只回一句 cc is not defined（见 explainError 里记的实测代价）
    const error = run.ok ? null : explainError((_a = run.error) !== null && _a !== void 0 ? _a : { name: 'Error', message: '编辑器侧执行失败' }, 'editor');
    const envelope = {
        ok: run.ok,
        context: 'editor',
        durationMs: run.durationMs,
        ...(run.ok ? { result: serialized.value } : { error }),
    };
    if (run.logs.length > 0)
        envelope.logs = formatLogLines(run.logs);
    if (run.logsTruncated)
        envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (run.timedOut)
        envelope.timedOut = true;
    if (serialized.truncated) {
        const notes = (_b = envelope.notes) !== null && _b !== void 0 ? _b : [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }
    const text = JSON.stringify(envelope, null, 2);
    return run.ok
        ? { ok: true, text, data: envelope }
        : {
            ok: false,
            text,
            error: `${(_c = error === null || error === void 0 ? void 0 : error.name) !== null && _c !== void 0 ? _c : 'Error'}: ${(_d = error === null || error === void 0 ? void 0 : error.message) !== null && _d !== void 0 ? _d : '编辑器侧执行失败'}`,
            data: envelope,
        };
}
// ---------------------------------------------------------------------------
// scene 上下文执行
// ---------------------------------------------------------------------------
/**
 * 在**引擎场景进程**里执行一段代码（转发给本扩展的场景脚本）。
 *
 * @param wantSnapshot - 调用方显式要求登记一次撤销快照（脚本内 `snapshot()` 也会置同一个标志）。
 */
async function runSceneCode(code, args, timeoutMs, wantSnapshot) {
    var _a, _b, _c, _d, _e, _f, _g;
    let sceneResult;
    try {
        sceneResult = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.runCode, [
            {
                code,
                args,
                timeoutMs,
                maxLogs: SANDBOX_DEFAULTS.maxLogs,
                maxLogLength: SANDBOX_DEFAULTS.maxLogLength,
                // 工程根**由主进程给**（这里拿得到 Editor.Project.path）：场景进程里的
                // `Editor` 是编辑器注入的全局量，未必每个版本都实到能读 Project.path ——
                // `loadFrame` 要靠它去读 `.meta`（见 scene.ts 里 loadFrame 的说明），
                // 少这一个字段就会退化成「只有 uuid 能用」。
                projectPath: Editor.Project.path,
            },
        ]);
    }
    catch (err) {
        const message = err instanceof scene_bridge_1.SceneUnavailableError ? err.message : describe(err);
        const envelope = { ok: false, context: 'scene', error: message };
        return { ok: false, text: JSON.stringify(envelope, null, 2), error: message, data: envelope };
    }
    const ok = sceneResult.ok === true;
    // 场景侧返回的是引擎里的活对象，必须过一遍序列化再进响应
    const serialized = (0, serialize_1.safeSerialize)(sceneResult.result, SERIALIZE_OPTIONS);
    // 快照登记：脚本内 snapshot() 置位，或调用方显式要求
    let snapshotTaken;
    if (ok && (sceneResult.snapshotRequested === true || wantSnapshot)) {
        snapshotTaken = await requestSceneSnapshot();
    }
    const rawError = sceneResult.error;
    const error = ok ? null : explainError({ name: (_a = rawError === null || rawError === void 0 ? void 0 : rawError.name) !== null && _a !== void 0 ? _a : 'Error', message: (_b = rawError === null || rawError === void 0 ? void 0 : rawError.message) !== null && _b !== void 0 ? _b : '场景执行失败' }, 'scene');
    const envelope = {
        ok,
        context: 'scene',
        durationMs: (_c = sceneResult.durationMs) !== null && _c !== void 0 ? _c : 0,
        ...(ok ? { result: serialized.value } : { error }),
    };
    const sceneLogs = Array.isArray(sceneResult.logs)
        ? sceneResult.logs
        : [];
    if (sceneLogs.length > 0)
        envelope.logs = formatLogLines(sceneLogs);
    if (sceneResult.logsTruncated)
        envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (sceneResult.timedOut)
        envelope.timedOut = true;
    if (snapshotTaken !== undefined)
        envelope.undoSnapshot = snapshotTaken;
    if (serialized.truncated) {
        const notes = (_d = envelope.notes) !== null && _d !== void 0 ? _d : [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }
    /**
     * 改完场景之后**提醒存 recipe** —— 这条不是装饰。
     *
     * 基准里最稳定的一条差评就是「复用 0 项」：一整段跑通的建树代码（实测 52KB 发往编辑器、
     * 50 步里 35 步是 `cocos_execute_code`）如果没存成 recipe，下次换会话就**从零再来一遍**
     * （历史上「做一个登录界面预制件」被做了 3 次真跑 + 1 次夭折，约 131 分钟）。
     *
     * 触发条件刻意收窄，免得变成每条回执都贴的废话：
     * ① 这一轮真的改了场景（登记了撤销快照）；② 代码够长（≥1200 字，短探针不必存）；
     * ③ 没超时（超时的那次往往没跑完，存下来是个坑）。
     */
    if (ok && snapshotTaken === true && !sceneResult.timedOut && code.length >= 1200) {
        const notes = (_e = envelope.notes) !== null && _e !== void 0 ? _e : [];
        notes.push(`这次改动真生效了（已登记撤销快照），而且代码有 ${code.length} 字 —— ` +
            '如果以后还会用（建树 / 按契约搭 UI / 批量改节点 / 存预制件），' +
            '把**同一段代码**用 saveRecipe(名字, <这段代码>, {description, params, returns}) 存下来：' +
            '下次开工 findRecipes 就能找到它，不用从零再写一遍。' +
            '（一次性的探索直接 return 就行，别存。）');
        envelope.notes = notes;
    }
    const text = JSON.stringify(envelope, null, 2);
    return ok
        ? { ok: true, text, data: envelope }
        : {
            ok: false,
            text,
            error: `${(_f = error === null || error === void 0 ? void 0 : error.name) !== null && _f !== void 0 ? _f : 'Error'}: ${(_g = error === null || error === void 0 ? void 0 : error.message) !== null && _g !== void 0 ? _g : '场景执行失败'}`,
            data: envelope,
        };
}
/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
async function requestSceneSnapshot() {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 「这段代码只能在 scene 跑」的判据 —— 一个个都是**只在场景上下文存在的裸标识符**。
 *
 * 为什么要有一份清单：`context` 漏给时，旧实现在 `cocos-tools`/这里都是
 * `params.context === 'scene' ? 'scene' : 'editor'` —— 也就是**静默当成 editor**，
 * 而 editor 沙箱里没有 `cc`，于是模型拿到的是：
 *
 * ```
 * ReferenceError: cc is not defined
 * ```
 *
 * 实测代价（2026-09-30 17:45 那条会话）：模型完全不知道这是「上下文选错了」，
 * 于是连着 10 步在做对照实验 —— 怀疑 `args` 改变了执行环境、怀疑代码太长被截断、
 * 怀疑 scene 进程丢了 `cc`、怀疑是 `snapshot: true` 的副作用（**这条是错的，见下**），
 * 一步都没往「我没写 context」上想。整条会话 50 步里有 10 步花在这上面。
 *
 * ⚠ **`snapshot: true` 不是原因**（skill 里曾这么记，已更正）：`snapshot` 只是
 * 「跑完之后额外登记一次撤销快照」，代码仍跑在 scene 沙箱里，`cc` 照样在
 * （`scripts/verify-cocos-engine.js` 里有一条断言就是 `context:'scene' + snapshot:true` 跑通的）。
 * 真正的判据只有「有没有给 context」。
 */
const SCENE_ONLY_MARKERS = [
    { pattern: /(^|[^A-Za-z0-9_$.])cc\s*[.[(]/, name: 'cc' },
    { pattern: /(^|[^A-Za-z0-9_$.])director\s*[.[(]/, name: 'director' },
    { pattern: /(^|[^A-Za-z0-9_$.])(nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|findViewCanvas)\s*\(/, name: '场景助手（nodeByPath 等）' },
    { pattern: /(^|[^A-Za-z0-9_$.])(tree|dump|captureView|loadFrame|worldRect)\s*\(/, name: 'tree/dump/captureView/loadFrame/worldRect' },
    {
        pattern: /(^|[^A-Za-z0-9_$.])(pick|labelFit|snapshotTree|diffTree)\s*\(/,
        name: 'pick/labelFit/snapshotTree/diffTree',
    },
];
/** 「这段代码只能在 editor 跑」的判据。 */
const EDITOR_ONLY_MARKERS = [
    { pattern: /(^|[^A-Za-z0-9_$.])Editor\s*[.[]/, name: 'Editor' },
    { pattern: /(^|[^A-Za-z0-9_$.])(resolveProjectPath|listDir|readJson|projectPath|extensionRoot)\s*\(?/, name: '编辑器助手（projectPath 等）' },
    { pattern: /(^|[^A-Za-z0-9_$.])probe\s*\(/, name: 'probe（图片像素探针）' },
];
/**
 * **弱判据**：场景侧独有的标识符，被当成普通标识符用到就算（`typeof cc`、`!!cc`、`if (eachNode)`…）。
 *
 * 为什么强判据不够：实测那段把模型坑了 10 步的代码确实是 `cc.Layers.Enum.UI_2D`（强判据能命中），
 * 但「旁边一句 `return { ccLoaded: !!cc }`」这种写法同样表明「我要的是场景」，
 * 而它既没有 `cc.`、也没有 `nodeByPath(`。弱判据只在**没有编辑器强判据**时才生效，
 * 所以 `Editor.Message.request('asset-db', …)` 那种代码不会被抢走。
 */
const WEAK_SCENE_NAMES = /\b(cc|cocos|director|nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|worldRect|loadFrame|captureView|pick|labelFit|snapshotTree|diffTree)\b/;
/** 命中清单里的哪几个（给回执里的人话说明用）。 */
function markersOf(code, markers) {
    const hit = [];
    for (const marker of markers) {
        if (marker.pattern.test(code) && hit.indexOf(marker.name) < 0)
            hit.push(marker.name);
    }
    return hit;
}
/**
 * 推断 `context`（只在调用方**没给**的时候用）。
 *
 * 四级，先强后弱：
 * 1. 强场景判据（`cc.` / `nodeByPath(` / `tree(` …）→ scene；
 * 2. 强编辑器判据（`Editor.` / `projectPath()` …）→ editor；
 * 3. 弱场景判据（裸标识符 `cc` / `eachNode` …）→ scene；
 * 4. 都没有 → editor（**无副作用**的那一侧：读盘/查库不会动用户的场景）。
 *
 * @param code - 用户代码。
 * @returns `{context, sceneMarkers, editorMarkers}`；`markers` 非空表示「推断有依据」。
 */
function inferContext(code) {
    const sceneMarkers = markersOf(code, SCENE_ONLY_MARKERS);
    const editorMarkers = markersOf(code, EDITOR_ONLY_MARKERS);
    if (sceneMarkers.length > 0)
        return { context: 'scene', sceneMarkers, editorMarkers };
    if (editorMarkers.length > 0)
        return { context: 'editor', sceneMarkers, editorMarkers };
    if (WEAK_SCENE_NAMES.test(code)) {
        return { context: 'scene', sceneMarkers: ['cc / 场景助手（裸标识符）'], editorMarkers };
    }
    return { context: 'editor', sceneMarkers, editorMarkers };
}
/**
 * 把「上下文选错」这类错误翻译成**可执行的一句话**。
 *
 * `ReferenceError: cc is not defined` 本身没错，错的是一点线索都不给 ——
 * 模型面对它只会去做对照实验（见 {@link SCENE_ONLY_MARKERS} 里的实测代价）。
 * 这里把已知的几个裸标识符认出来，直接说清「你跑在哪个上下文、该改成什么」。
 *
 * @param error - 沙箱错误信息。
 * @param context - 实际跑在哪个上下文。
 * @returns 翻译后的错误信息。
 */
function explainError(error, context) {
    var _a, _b, _c;
    if (error.name !== 'ReferenceError')
        return error;
    const missed = (_c = (_b = (_a = /^(?<id>[A-Za-z_$][\w$]*) is not defined$/.exec(error.message.trim())) === null || _a === void 0 ? void 0 : _a.groups) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
    if (!missed)
        return error;
    const sceneGlobals = ['cc', 'cocos', 'director', 'scene', 'js', 'nodeByPath', 'nodeByUuid', 'eachNode', 'contentChildren', 'isEditorNode', 'tree', 'dump', 'captureView', 'find'];
    const editorGlobals = ['Editor', 'require', 'module', 'exports', '__dirname', '__filename', 'fs', 'path', 'os', 'Buffer', 'projectPath', 'resolveProjectPath', 'listDir', 'readJson', 'extensionRoot'];
    if (context === 'editor' && sceneGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message: `${error.message}\n` +
                `↑ 「${missed}」是**场景上下文**才有的（这次跑在 editor 沙箱里，那里只有 Editor / require / fs）。\n` +
                `改法：cocos_execute_code({ context: 'scene', code: … })。\n` +
                `下次也可以只写 context，两边通用：改节点/组件 → 'scene'；资源库/工程设置/读盘 → 'editor'。`,
        };
    }
    if (context === 'scene' && editorGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message: `${error.message}\n` +
                `↑ 「${missed}」是**编辑器主进程**才有的（这次跑在场景进程里）。\n` +
                `改法：cocos_execute_code({ context: 'editor', code: … }) —— 资源库（asset-db）、工程设置、构建都走它。`,
        };
    }
    return error;
}
/** `cocos_execute_code` 的实现：一次执行里完成「取数据 → 改状态 → 返回结论」。 */
async function executeCode(params) {
    var _a;
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code.trim()) {
        return { ok: false, text: 'execute_code：code 是空的。', error: 'code 不能为空' };
    }
    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args)
        ? params.args
        : {};
    /**
     * `context` 的三种情况，**都要说清是哪一种**：
     * ① 显式给了 → 照做（后面出错时按这个上下文翻译错误）；
     * ② 没给 → 按代码里的标识符推断，并在回执里注明 `contextInferred: true`
     *    （悄悄替模型做决定但不告诉它，下次它还是会漏写）；
     * ③ 推断也不成立 → editor（无副作用的那个）。
     */
    const explicit = params.context === 'scene' ? 'scene' : params.context === 'editor' ? 'editor' : null;
    const inferred = explicit === null ? inferContext(code) : null;
    const context = explicit !== null && explicit !== void 0 ? explicit : inferred.context;
    const reply = context === 'scene'
        ? await runSceneCode(code, args, timeoutMs, params.snapshot === true)
        : await runEditorCode(code, args, timeoutMs);
    /**
     * 没给 context 的那次：把「我替你选了哪个、凭什么」写进回执。
     *
     * 写在**信封**（`data`）里而不是只写在文本里，是为了 `unwrapSandboxResult` 之外的调用方
     * （面板、日志）也看得到；文本里同样会出现 —— 模型只读文本。
     */
    if (inferred) {
        const envelope = reply.data;
        if (envelope) {
            envelope.contextInferred = true;
            const why = context === 'scene'
                ? `代码里出现了 ${inferred.sceneMarkers.join(' / ')}`
                : inferred.editorMarkers.length > 0
                    ? `代码里出现了 ${inferred.editorMarkers.join(' / ')}`
                    : '代码里没有只属于某一侧的标识符';
            const notes = (_a = envelope.notes) !== null && _a !== void 0 ? _a : [];
            notes.push(`没给 context，按「${why}」推断为 '${context}'（下次请显式传 context）`);
            envelope.notes = notes;
            const text = typeof reply.text === 'string' ? reply.text : '';
            reply.text = text.replace(/\n$/, `\n// context 未给，按「${why}」推断为 '${context}'\n`);
        }
    }
    return reply;
}
/** 场景侧截图助手固定走这一行（真正的实现在 source/scene.ts 的 `captureView` 里）。 */
const CAPTURE_VIEW_SCENE_CODE = 'return await captureView(args);';
/** 截图默认落盘目录：系统临时目录，与具体工程无关。 */
function defaultCapturePath(format) {
    const dir = path.join(os.tmpdir(), 'dsh-cocos-captures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `scene-view-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
}
/** 截图失败时的统一回执（不抛，让模型看到可读的原因）。 */
function captureFail(message, extra) {
    const payload = { ok: false, error: message, ...(extra !== null && extra !== void 0 ? extra : {}) };
    return { ok: false, text: JSON.stringify(payload, null, 2), error: message, data: payload };
}
/** 拿到图之后的标准下一句。 */
const CAPTURE_READ_HINT = '用图片读取能力打开 path 看一眼画面，再决定下一步。';
/**
 * 空图时**必须给退路**（不是"再试一次"）。
 *
 * 历史（2026-09-30 04:23 会话）：`capture_view` 老老实实回了 `blankRatio: 1`，
 * 但只配了一句「接近 1 说明基本是空图」—— 模型于是自己往下试：重试 `waitMs` →
 * `select`/`focus-camera` → `cc.RenderTexture` 离屏 → 最后用节点数据 + Canvas2D 手绘布局对照图，
 * **整整 16 步**。这个坑现在由 Electron 通道从根上堵住（见 `capture.ts` 头部），
 * 但真到这一步说明**连合成后的 surface 都是空的** —— 那时更不该重试。
 */
const CAPTURE_BLANK_HINT = '这是空图（blankRatio≈1），**别再重试截图** —— 本扩展**不调 `invalidate()`**（不碰合成器，' +
    '理由见 `source/capture.ts` 文件头与 `docs/冻结诊断.md`），' +
    '换 waitMs / 重新聚焦 / 换 maxWidth 都不会变。先看 `view` 再决定，按顺序做：' +
    '① `view.visibleMatchesDesign === false`：编辑器场景视图的**设备模拟被改过**（历史上是有人调了 `cc.view.setDesignResolutionSize`）—— 在场景视图工具栏重新选一次设备分辨率即可恢复，纯视图设置、不影响场景与预制件数据；' +
    '② `view.visibleMatchesDesign === true` 却仍然空：说明**这个环境当下确实取不到画面**（编辑器最小化、场景视图面板被折叠或从未渲染）—— 不要自建离屏渲染器（历史上有人为此花了 16 步），直接转数值判据；' +
    '③ 画面验收改用**数值判据**：`worldRect(node)` 拿真实世界矩形 / 自己算重叠与越界 / 逐节点读 color·contentSize；' +
    '④ 确实需要肉眼确认时，按节点真实数据出一张布局对照图（历史做法：`worldRect` 导出行 → 脚本画 PNG → 图片读取），并在交付里**如实声明「真实渲染截图未完成」**。';
/**
 * 解析 `view` 参数。
 *
 * `'preview'` 按 `game` 理解（读者多半是想说"跑起来那个画面"），但会**多写一句**说明
 * 它有两种读法 —— 浏览器/模拟器预览是另一个应用的另一个进程，本扩展够不着。
 */
function normalizeViewTarget(raw) {
    if (raw === undefined || raw === null || raw === '' || raw === 'auto')
        return { mode: 'auto' };
    if (raw === 'scene' || raw === 'game')
        return { mode: raw };
    if (raw === 'preview') {
        return {
            mode: 'game',
            note: '`view:"preview"` 按 `game`（编辑器内运行预览）理解。若你指的是**浏览器/模拟器预览**，' +
                '那是编辑器之外的另一个应用，本工具截不到它 —— 那种情况请自己在那个窗口里截图。',
        };
    }
    return { mode: 'auto', note: `view 只认 auto/scene/game，收到 ${JSON.stringify(raw)}，按 auto 处理` };
}
/**
 * `auto` 模式下「内容小得看不清」的判据：内容与画布交集面积占比低于它就顺手取景。
 *
 * 为什么要这一条：只在「没拍全」时取景是**不够**的 —— 用户缩到 10% 看全局时内容**确实全在画里**，
 * 但截图里那一小块根本看不清（实测：720×1560 的设计分辨率缩到 10%，在画布里只有 72×156）。
 * 0.15 是「小到勉强能认出轮廓」的量级，不是精确阈值；回执里如实报 `areaRatio`，
 * 想按原样截就传 `fit:'none'`。
 */
const FIT_SMALL_RATIO = 0.15;
/** 取景每一步之后等它落定（毫秒）—— `focus()` 可能带补间，`invalidate()` 也要等一帧。 */
const FIT_SETTLE_MS = 200;
/** 同一级取景最多量两次（第一次可能正赶上补间中间）。 */
const FIT_MEASURES_PER_STEP = 2;
/** 各级取景的说明（回执里 `framing.method` 用人话再讲一遍）。 */
const FIT_METHOD_LABEL = {
    focus: '编辑器自己的聚焦（cce.Camera.focus）',
    adjust: '2D 控制器的适配内容（controller2D._adjustToCenter）',
    manual: '手工摆相机（按量出来的「像素/世界单位」改 orthoHeight 与位置）',
};
/** 解析 `fit` 参数（不认的值回 `auto` 并留一句说明）。 */
function normalizeFitMode(raw) {
    if (raw === undefined || raw === null || raw === '')
        return { mode: 'auto' };
    if (raw === 'auto' || raw === 'scene' || raw === 'node' || raw === 'none')
        return { mode: raw };
    return { mode: 'auto', note: `fit 只认 auto/scene/node/none，收到 ${JSON.stringify(raw)}，按 auto 处理` };
}
/** 从一次几何回执里取出「拍全了没有」那几项。 */
function pickCoverage(metrics) {
    var _a, _b, _c, _d, _e;
    const framing = metrics && metrics.framing;
    if (!framing || typeof framing !== 'object')
        return null;
    return {
        covered: framing.covered === true,
        areaRatio: (_a = framing.areaRatio) !== null && _a !== void 0 ? _a : null,
        edges: (_b = framing.edges) !== null && _b !== void 0 ? _b : null,
        targetPage: (_c = framing.targetPage) !== null && _c !== void 0 ? _c : null,
        viewport: (_d = framing.viewport) !== null && _d !== void 0 ? _d : null,
        target: (_e = framing.target) !== null && _e !== void 0 ? _e : null,
        note: framing.note,
    };
}
/**
 * 要不要取景。
 *
 * @param mode - 用户要的取景模式。
 * @param before - 取景前的覆盖情况（`null` = 量不到，那就别乱动相机）。
 * @returns `null` = 不取景；否则是要框的目标。
 */
function decideFit(mode, nodeRef, before) {
    if (mode === 'none')
        return null;
    if (mode === 'scene')
        return 'scene';
    if (mode === 'node')
        return nodeRef ? 'node' : null;
    /** auto */
    if (!before)
        return null;
    if (nodeRef) {
        /** 截节点：只有「节点没被拍全」才动相机 —— 节点在图里时按原样裁，不改用户视角 */
        return before.covered === true ? null : 'node';
    }
    /** 截整张视图：没拍全，或者拍全了但小得看不清 */
    const area = typeof before.areaRatio === 'number' ? before.areaRatio : 1;
    return before.covered === true && area >= FIT_SMALL_RATIO ? null : 'scene';
}
/**
 * 跑取景链：**摆一级 → 逼一帧 → 量一遍 → 验不过就降级**。
 *
 * 三级取景（编辑器 focus → 2D 控制器适配 → 手工摆相机）与「为什么是这个顺序」
 * 写在 `source/scene.ts` 的「取景」一节；这里只管推进与记账。
 *
 * 判据是**量出来的**（`framing.covered` = 目标矩形整个落在画布里），所以不必知道
 * 编辑器内部怎么算的 —— 第一级能成就不会用到第二级。
 *
 * ⚠ 相机动过之后**必须重算节点矩形**（相机变了，矩形就变了），所以返回的最后一次
 * `metrics` 一定要拿回去用，不能再用取景前那份。
 *
 * @returns `{framing, metrics, fitNote}`。
 */
async function runFitChain(kind, nodeRef, projectPath, firstMetrics, href) {
    const framing = {
        applied: kind,
        method: null,
        step: null,
        before: pickCoverage(firstMetrics),
    };
    let metrics = firstMetrics;
    let fitNote;
    let token = '';
    /**
     * 只要**尝试过**取景就要还原 —— 不能只在"成功"时还原：
     * 第三级是**手工摆相机**（先写 `orthoHeight` 再挪位置），它可能写了一半才失败
     * （`method` 仍然是 null），那时相机已经被动过了。还原一次是幂等的，多还一次不会有副作用。
     */
    let attempted = false;
    /** 一次「摆 + 逼一帧 + 等落定 + 量」；`step === null` 表示只重量一遍（不重摆） */
    const round = async (step) => {
        var _a, _b;
        if (step !== null) {
            attempted = true;
            const applied = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.fitView, [
                { action: 'fit', step, fit: { kind, ref: nodeRef }, node: nodeRef, projectPath },
            ]);
            token = typeof applied.token === 'string' ? applied.token : token;
            framing.step = step;
            framing.method = (_a = applied.method) !== null && _a !== void 0 ? _a : null;
            if (applied.detail)
                framing.detail = applied.detail;
            if (applied.target)
                framing.target = applied.target;
            if (applied.saved && applied.saved.signature)
                framing.savedCamera = applied.saved.signature;
            if (applied.maxStep)
                framing.maxStep = applied.maxStep;
            framing.nextStep = (_b = applied.nextStep) !== null && _b !== void 0 ? _b : null;
            if (applied.ok !== true) {
                fitNote = applied.note || applied.error || `第 ${step} 级取景没做成`;
                return null;
            }
            if (applied.note)
                fitNote = applied.note;
        }
        /**
         * ⛔ 这里曾经有一句 `invalidateSceneView(href)`（"相机动了，逼一帧再量"）。
         * 2026-10-08 之后**删掉了**：本扩展一次 `invalidate()` 都不调（见 `source/capture.ts` 文件头）。
         * 代价如实说：相机刚动完就量，读到的**可能是重画前的那一帧** ——
         * 所以下面这一量与主进程侧的取景链会**多量几轮**，而不是靠逼一帧来"保证新鲜"。
         */
        await sleep(FIT_SETTLE_MS);
        const measured = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.viewMetrics, [
            { node: nodeRef || undefined, fit: { kind, ref: nodeRef }, projectPath },
        ]);
        if (measured && measured.ok === true)
            metrics = measured;
        return metrics;
    };
    let covered = false;
    try {
        for (let step = 0; step < 3; step += 1) {
            let appliedOk = false;
            for (let measure = 0; measure < FIT_MEASURES_PER_STEP; measure += 1) {
                const measured = await round(measure === 0 ? step : null);
                if (!measured)
                    break;
                appliedOk = true;
                covered = Boolean(measured.framing && measured.framing.covered === true);
                if (covered)
                    break;
            }
            if (covered || !appliedOk)
                break;
            if (framing.nextStep === null || framing.nextStep === undefined)
                break;
        }
        framing.methodLabel = framing.method ? FIT_METHOD_LABEL[framing.method] || framing.method : null;
        framing.after = pickCoverage(metrics);
        if (fitNote)
            framing.note = fitNote;
        if (!covered) {
            const prefix = framing.note ? `${framing.note}；` : '';
            framing.note = `${prefix}⚠ 取景没能把目标整个装进画布（${framing.method ? FIT_METHOD_LABEL[framing.method] || framing.method : '没有可用的取景手段'}）—— 这张图**可能仍然不是全景**`;
        }
    }
    finally {
        /**
         * 还原视角：**只要动过（或可能动过）相机就一定要还**（用户视角不该被我们留在别处）。
         * 放在 `finally` 里 —— 取景途中出任何岔子（IPC 断了、场景脚本抛了、写相机写了一半）也要还。
         */
        if (attempted) {
            try {
                const restored = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.fitView, [
                    { action: 'end', token },
                ]);
                /** 「压根没存过视角」（取景连第一步都没走到）不算失败 —— 相机本来也没动 */
                const nothingToRestore = restored && restored.ok === false && /没有待还原的视角/.test(String(restored.error || ''));
                framing.restored = nothingToRestore ? null : restored && restored.restored === true;
                framing.restoreMethod = (restored && restored.method) || null;
                if (restored && restored.after)
                    framing.cameraAfterRestore = restored.after;
                if (restored && restored.note)
                    framing.restoreNote = restored.note;
                if (nothingToRestore)
                    framing.restoreNote = '没有存过视角（取景没走到会动相机的那一步），相机没动';
                if (framing.restored === false) {
                    const prefix = framing.note ? `${framing.note}；` : '';
                    framing.note = `${prefix}⚠ **视角没有还原成功** —— 编辑器场景视图现在停在取景后的位置（按 F / 双击节点可以回去）`;
                }
            }
            catch (err) {
                framing.restored = false;
                framing.restoreNote = describe(err);
                const prefix = framing.note ? `${framing.note}；` : '';
                framing.note = `${prefix}⚠ 还原视角时出错：${describe(err)}（场景视图可能停在取景后的位置）`;
            }
        }
    }
    return { framing, metrics, fitNote };
}
/**
 * **Electron 通道**：主进程自己把场景视图抓下来。
 *
 * 为什么主进程能抓：编辑器就是 Electron，本扩展的 `main` 跑在主进程里，
 * 而场景视图是一个 `<webview>` 页（`builtin/scene/static/template/3d-webview.html`）——
 * `webContents.getAllWebContents()` 会把它列出来，`capturePage()` 抓的是
 * **合成后的 surface**（不受 `preserveDrawingBuffer: false` 影响）。
 * 细节与坐标口径见 `source/capture.ts`。
 *
 * 场景脚本在这里干两件事：**量**（`viewMetrics`：页面 href / 画布几何 / 节点矩形 /
 * 拍全了没有）与**摆相机**（`fitView`：取景 / 还原视角，见 {@link runFitChain}）。
 *
 * @returns 成功/失败都回 `{reply}`；**该退回老路时**回 `{fallback: 原因}`。
 */
async function captureViewViaElectron(options) {
    var _a, _b, _c, _d, _e;
    if (!(0, capture_1.getElectron)()) {
        return { fallback: `本环境没有 Electron 的 webContents（${(0, capture_1.electronUnavailableReason)() || '未知原因'}）` };
    }
    /** 取景要框谁：`kind` 是「场景内容」还是「这个节点」 */
    const kind = options.nodeRef ? 'node' : 'scene';
    // ① 先问场景脚本要几何（顺带问「目标拍全了没有」）。它拿不到 = 场景进程不可用 →
    //    退回老路，让老路去报那句「先打开一个场景」（两个通道的失败文案必须一致）。
    let metrics;
    try {
        metrics = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.viewMetrics, [
            {
                node: options.nodeRef || undefined,
                fit: { kind, ref: options.nodeRef || '' },
                projectPath: options.projectPath,
            },
        ]);
    }
    catch (err) {
        return { fallback: `场景脚本 viewMetrics 不可用：${describe(err)}` };
    }
    if (!metrics || metrics.ok !== true) {
        return { fallback: `场景脚本 viewMetrics 没给出几何：${describe((metrics && metrics.error) || '空返回')}` };
    }
    const page = (metrics.page || {});
    let href = typeof page.href === 'string' ? page.href : '';
    /**
     * 这一页现在画的是**编辑器场景**还是**跑着的游戏** —— 由场景脚本报上来（`viewMetrics.runtime`，
     * 见 `source/scene.ts` 的 `readSceneMode`）。「运行态」有两条硬后果（下面 ② 与 ④ 各一条）：
     * 取景与裁节点都建立在**编辑器相机**上，而运行态的渲染相机是**游戏自己的**。
     */
    const runtime = (metrics.runtime || {});
    const running = runtime.running === true;
    const actualMode = typeof runtime.mode === 'string' ? runtime.mode : 'unknown';
    /**
     * 「没给出正确模式」时的如实说明。
     *
     * 约定：`note` 非空 = 有事。这里只在**调用方要的那一种与实际那一种不一致**时才写，
     * 而且写的是事实（"这张图是 X"），不是安慰（"可能不是你要的"）。
     */
    let viewNote;
    if (options.view === 'game' && !running) {
        viewNote =
            '要的是**运行态**（game view）画面，但编辑器现在**不在**运行预览里 —— 这张图是**编辑器场景**。' +
                '本扩展**已经开不了预览了**（那条能力 2026-10-08 撤掉了，理由见 `cocos_runtime` 的说明）：' +
                '要看游戏画面，请**自己在编辑器工具栏按那颗播放键**，回来再截。';
    }
    else if (options.view === 'scene' && running) {
        viewNote =
            '要的是**编辑器场景**，但编辑器现在正在跑运行预览 —— 这张图是**游戏画面**。' +
                '想要编辑器场景：请**自己在编辑器工具栏按停止**再截。';
    }
    else if (options.view !== 'auto' && runtime.mode === 'unknown' && runtime.note) {
        /**
         * ⚠ 只在调用方**明确要了某一种**时才说这句话。
         * `view:"auto"` 的调用方没问模式，把"我判不出来"塞进 `note` 会盖掉更要紧的那条
         * （比如"节点找不到，退回整张视图"）—— 「note 非空 = 有事」这条约定就被噪声用掉了。
         * 判不出来这件事本身**照样如实报**：`mode.actual` 就是 `unknown`，理由在 `mode.note` 里。
         */
        viewNote = `要的是「${options.view}」，但判断不了这一页画的是场景还是游戏：${runtime.note}`;
    }
    // ② 取景（`fit`）：用户缩放/平移过之后，屏幕上那一帧未必是「全景」——
    //    按需要把目标框进画布，截完再还原视角（见 runFitChain）。
    /**
     * ⚠ **运行态一律不取景**（不管调用方传了什么 `fit`）。
     *
     * 理由不是"取景失败"，而是"取景在那一刻**没有意义**"：`runFitChain` 摆的是
     * `cce.Camera`（编辑器相机），而运行态的画面是**游戏自己的相机**渲染的
     * （`PreviewPlay.hideEditorCamera()`）—— 摆了也不会改变画面一根像素，
     * 反而会**白动一次用户的编辑器视角**。
     */
    let fitMode = options.fit;
    /** 运行态下「取景被忽略」的说明 —— 它属于**取景账本**（`framing.note`），不是「拿错画面」那一类 */
    let fitOverrideNote;
    if (running && fitMode !== 'none') {
        fitMode = 'none';
        fitOverrideNote =
            '运行态下不取景：`fit` 摆的是编辑器相机，而画面由游戏自己的相机渲染，摆了也不会改变这张图（这次按原样截）。';
    }
    let framing = {
        requested: fitMode,
        applied: null,
        method: null,
        before: pickCoverage(metrics),
        after: pickCoverage(metrics),
    };
    let fitNote;
    const wanted = decideFit(fitMode, options.nodeRef, framing.before);
    if (wanted) {
        try {
            const result = await runFitChain(wanted, options.nodeRef, options.projectPath, metrics, href);
            framing = { requested: fitMode, ...result.framing };
            /** ⚠ 相机动过 → 节点矩形必须用**新的**那一份（旧的已经不成立了） */
            metrics = result.metrics;
            fitNote = result.fitNote;
            const newPage = (metrics.page || {});
            if (typeof newPage.href === 'string' && newPage.href)
                href = newPage.href;
        }
        catch (err) {
            /** 取景是**加分项**：它失败不该让截图失败 —— 如实记一笔，继续按当前取景截 */
            framing.requested = fitMode;
            framing.applied = wanted;
            framing.note = `取景没做成（${describe(err)}）—— 回执里这张图是**当前视角**那一帧`;
            fitNote = framing.note;
        }
    }
    else if (fitMode === 'none' && framing.before && framing.before.covered !== true) {
        framing.note = '`fit:"none"` 按原样截 —— 但量下来目标**没有被拍全**，想拍全就传 `fit:"scene"`';
    }
    else if (fitMode === 'node' && !options.nodeRef) {
        framing.note = '`fit:"node"` 需要同时给 `node`（这次没给）—— 按当前视角原样截';
    }
    else if (fitMode === 'auto' && !options.nodeRef && framing.before) {
        /**
         * 「不用取景」是**正常情况**，所以不写 `note`（约定：`note` 非空 = 有事）——
         * 把"为什么没动相机"记在 `why` 里，需要解释时看得到。
         */
        framing.why =
            framing.before.covered === true
                ? `内容已经整个在画布里（areaRatio ${framing.before.areaRatio} ≥ ${FIT_SMALL_RATIO}）—— 按原样截，没动相机`
                : '量不到覆盖情况';
    }
    /** 运行态那条说明落在**取景账本**里（要找"为什么没动相机"，就看这一格） */
    if (fitOverrideNote && !framing.note)
        framing.note = fitOverrideNote;
    // ③ 抓图（**只读**：一次 `capturePage()`，不排重绘 —— 见 capture.ts 文件头那条硬口径）
    const outcome = await (0, capture_1.captureSceneView)(href);
    if (!outcome.ok) {
        return { fallback: outcome.error };
    }
    // ④ 要截节点就裁 —— 矩形来自编辑器相机的投影（页面 CSS 像素）
    const nodeInfo = (metrics.node || null);
    const padding = options.padding;
    let image = outcome.image;
    let cropRect = null;
    let cropNote;
    if (options.nodeRef) {
        if (running) {
            /**
             * ⚠ **运行态不裁节点**：`node.rect` 是拿**编辑器相机**投出来的，而那一刻画面由
             * 游戏自己的相机渲染 —— 按它裁会得到一块**错位的图**（比整页图更坑：看着像成功了）。
             * 所以这里如实退回整页，并把"怎么办"一起说了。
             */
            cropNote =
                '运行态（game view）下**不按节点裁图**：节点矩形是用编辑器相机投出来的，' +
                    '而运行态的画面由游戏自己的相机渲染，两者不是同一个取景 —— 按它裁会给你一块错位的图。' +
                    '现在给的是**整张画面**；要按节点裁请先**自己在编辑器工具栏按停止**回到编辑态。';
        }
        else if (!nodeInfo || nodeInfo.found !== true) {
            cropNote = `没找到节点「${options.nodeRef}」${nodeInfo && nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 回执里给的是**整张场景视图**`;
        }
        else if (!nodeInfo.rect) {
            cropNote = `节点「${nodeInfo.name || options.nodeRef}」算不出矩形${nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 回执里给的是**整张场景视图**`;
        }
        else {
            const rect = nodeInfo.rect;
            cropRect = {
                x: rect.x - padding,
                y: rect.y - padding,
                width: rect.width + padding * 2,
                height: rect.height + padding * 2,
            };
        }
    }
    const pageCss = {
        width: typeof page.cssWidth === 'number' && page.cssWidth > 0 ? page.cssWidth : outcome.sourceWidth,
        height: typeof page.cssHeight === 'number' && page.cssHeight > 0 ? page.cssHeight : outcome.sourceHeight,
    };
    let appliedCrop = null;
    if (cropRect) {
        const cropped = (0, capture_1.cropToCssRect)(image, cropRect, pageCss);
        image = cropped.image;
        appliedCrop = cropped.rect;
        if (!appliedCrop)
            cropNote = '裁切失败（矩形退化或越界）—— 回执里给的是**整张场景视图**';
    }
    // ④ 缩到 maxWidth 再编码（等比；Electron 的 resize 只给 width 不是等比，见 capture.ts）
    image = (0, capture_1.downscaleToWidth)(image, options.maxWidth);
    const finalSize = (0, capture_1.imageSizeOf)(image);
    let buffer;
    try {
        buffer = (0, capture_1.encodeImage)(image, options.format, options.quality);
    }
    catch (err) {
        return { reply: captureFail(`编码图片失败：${describe(err)}`, { target: outcome.target }) };
    }
    try {
        const dir = path.dirname(options.savePath);
        if (dir)
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(options.savePath, buffer);
    }
    catch (err) {
        return { reply: captureFail(`写入截图文件失败：${describe(err)}`, { path: options.savePath, target: outcome.target }) };
    }
    let bytes = buffer.length;
    try {
        bytes = fs.statSync(options.savePath).size;
    }
    catch {
        /* 尺寸读不到不影响使用 */
    }
    const blank = outcome.blankRatio >= 0.95;
    const payload = {
        ok: true,
        /**
         * 这次是谁抓的图。`electron` = 主进程 `capturePage`（**当前的正路**）；
         * `scene-gl` = 老路（场景进程 `gl.readPixels`，只在 Electron 通道不可用时用）。
         */
        method: 'electron',
        path: options.savePath,
        width: finalSize.width,
        height: finalSize.height,
        // 抓到的整页原图尺寸（未裁未缩），与老回执同一含义
        sourceWidth: outcome.sourceWidth,
        sourceHeight: outcome.sourceHeight,
        format: options.format,
        bytes,
        blankRatio: outcome.blankRatio,
        // 视图状态（visibleSize / designResolution / canvas / visibleMatchesDesign）
        view: (_a = metrics.view) !== null && _a !== void 0 ? _a : null,
        /**
         * 这张图**画的是哪一种画面** —— 运行态（game view 跑着游戏）还是编辑态（编辑器场景）。
         *
         * 为什么不并进 `view`：那个字段早就是「视图状态」（visibleSize / designResolution），
         * 含义已经占住了；而这一格回答的是另一个问题："我到底截到了什么"。
         * `requested` / `actual` 两个都摆出来 —— 要的和拿的不是一回事时，这里一眼看得见。
         */
        mode: {
            requested: options.view,
            actual: actualMode,
            running,
            /** 预览自己是不是被冻住了（`PreviewPlay._state === 'pause'`；判不了就是 null） */
            paused: typeof runtime.paused === 'boolean' ? runtime.paused : null,
            sources: (_b = runtime.sources) !== null && _b !== void 0 ? _b : null,
            note: viewNote,
        },
        // 抓的是哪一个 webContents —— 编辑器里可能同时有场景视图与游戏预览，抓错时靠它一眼看出来
        contents: outcome.target,
        matchedBy: outcome.matchedBy,
        transport: 'electron',
        target: options.nodeRef
            ? {
                kind: 'node',
                ref: options.nodeRef,
                uuid: nodeInfo && nodeInfo.uuid ? nodeInfo.uuid : null,
                name: nodeInfo && nodeInfo.name ? nodeInfo.name : null,
                /** 场景侧算出来的节点矩形（页面 CSS 像素）；给 padding 时这里是**未加 padding** 的原矩形 */
                rect: nodeInfo && nodeInfo.rect ? nodeInfo.rect : null,
                /** 真正拿去裁切的矩形（含 padding，已换算到图片像素） */
                crop: appliedCrop,
                worldRect: nodeInfo && nodeInfo.worldRect ? nodeInfo.worldRect : null,
            }
            : { kind: 'view' },
        // 场景视图几何与编辑器相机：诊断「矩形为什么在那儿」用
        page: (_c = metrics.page) !== null && _c !== void 0 ? _c : null,
        canvas: (_d = metrics.canvas) !== null && _d !== void 0 ? _d : null,
        camera: (_e = metrics.camera) !== null && _e !== void 0 ? _e : null,
        /**
         * 取景账本：**这张图是全景还是当前视角**，看它就够。
         * `before/after` 是「目标拍全了没有」的两次实测（`covered` / `areaRatio` / 四边余量）。
         */
        framing,
    };
    if (cropNote)
        payload.note = cropNote;
    if (nodeInfo && nodeInfo.rect && nodeInfo.note)
        payload.nodeNote = nodeInfo.note;
    /** 取景的说明优先落在 `framing.note` 里（它带着覆盖率数据）；这里只在它缺位时补一句 */
    if (fitNote && !framing.note && !cropNote)
        payload.note = fitNote;
    else if (fitOverrideNote && !cropNote && !payload.note)
        payload.note = fitOverrideNote;
    /**
     * ⚠ 「要的那种画面没拿到」**压过**上面两条。
     *
     * 它说的不是"这张图小瑕疵"，而是"这张图根本不是你要的那个东西" ——
     * 被 `framing.note` 或裁剪说明盖掉的话，调用方会拿着一张错画面的图继续往下走
     * （这正是最难查的一类错：工具没报错，图也在，就是不对）。
     */
    if (viewNote)
        payload.note = viewNote;
    payload.hint = blank ? CAPTURE_BLANK_HINT : CAPTURE_READ_HINT;
    return { reply: { ok: true, text: JSON.stringify(payload, null, 2), data: payload } };
}
/**
 * 截一张**场景视图**（`cocos_capture_view` 的实现）。
 *
 * 为什么单独一条通道：图片是二进制/大字符串，塞不进 `execute_code` 的返回值上限
 * （单字符串 4000 字）—— 所以它必须是「工具 → 落盘 → 回路径」。
 *
 * ## 两条路，先好后老
 *
 * 1. **Electron 通道**（{@link captureViewViaElectron}，**正路**）：主进程
 *    `webContents.capturePage()` 抓**合成后的 surface**（**只读**，一次抓图，不排重绘 ——
 *    见 `source/capture.ts` 文件头那条硬口径）。
 *    老实现读的是 GL 后备缓冲、且**没法让编辑器重画**，于是实测恒回 `blankRatio: 1`
 *    （`docs/agent-notes/UI与表现层.md`）—— 这条路就是从根上换掉那个读取源。
 *    顺带支持**节点级截图**（`node` 参数，矩形由编辑器相机投影，见场景脚本 `viewMetrics`）
 *    与**取景**（`fit` 参数：先把目标框进画布，截完还原视角，见 `runFitChain`）。
 * 2. **场景进程读像素**（老的 `capture_view`，**兜底**）：Electron 拿不到 / 场景脚本
 *    版本旧（没有 `viewMetrics`）/ 抓图失败时才走，保证这个工具在任何情况下都比"没有"强。
 *    ⚠ 兜底路**不取景**（它读的是 GL 后备缓冲，`fit` 只对 Electron 那条路生效）。
 *
 * ## `fit` 是干什么的（**用户缩放过之后，屏幕上那一帧未必是全景**）
 *
 * `capturePage()` 抓的是屏幕上现在这一帧。用户把场景视图缩放/平移过之后，
 * 抓到的就只是他当时看的那块地方。`fit` 会在抓之前把相机摆到「框住目标」的位置，
 * 抓完**立刻还原**（回执 `framing.restored` 说明还原成功没有）：
 *
 * | fit | 行为 |
 * |---|---|
 * | `auto`（默认） | 截整张视图：内容没拍全 **或** 内容小得看不清（占比 < 0.15）才取景；截节点：只在节点没被拍全时取景 |
 * | `scene` | 强制框住**整个场景内容** |
 * | `node` | 强制框住**目标节点**（要同时给 `node`） |
 * | `none` | 不动相机，就截现在这一帧（回执里仍会告诉你拍全没有） |
 *
 * ## `view` 是干什么的（**同一块画布，两种画面**）
 *
 * 编辑器里那块场景视图**同一时刻只画一样东西**：编辑态的编辑器场景，或者运行预览
 * （game view）跑着的游戏画面 —— 两者用**不同的相机**。所以：
 *
 * | view | 行为 |
 * |---|---|
 * | `auto`（默认） | 不管，截现在这一帧；回执 `mode.actual` 说明**截到的到底是哪一种** |
 * | `scene` | 要编辑器场景；拿到运行态画面时**明说不对**（`note` + `mode.running`） |
 * | `game` | 要跑着的游戏；运行态下**不取景、不裁节点**（两者都建立在编辑器相机上），并说明为什么 |
 *
 * `view:"preview"` 按 `game` 理解并附一句说明（浏览器/模拟器预览是另一个应用，够不着）。
 *
 * @param params - `{savePath?, maxWidth?, format?, quality?, node?, padding?, fit?, view?, waitMs?, timeoutMs?}`。
 * @returns `data.path` 是图片绝对路径，可直接喂给图片读取工具；
 *   `data.framing` 是取景账本（取景前/后的覆盖率、用了哪一级、还回去没有）；
 *   `data.mode` 是"这张图到底画的是哪一种画面"（`requested` / `actual` / `running`）。
 */
async function captureView(params) {
    var _a, _b;
    const format = params.format === 'jpeg' || params.format === 'jpg' ? 'jpeg' : 'png';
    const savePath = typeof params.savePath === 'string' && params.savePath.trim()
        ? path.resolve(params.savePath.trim())
        : defaultCapturePath(format);
    const maxWidth = clampInt(params.maxWidth, 32, 4096, 640);
    const quality = typeof params.quality === 'number' && Number.isFinite(params.quality)
        ? Math.min(1, Math.max(0.1, params.quality))
        : 0.9;
    const waitMs = clampInt(params.waitMs, 0, 5000, 800);
    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    /** 节点引用：uuid 或路径（`Canvas/skill_details`）。给了就只截这个节点。 */
    const nodeRef = typeof params.node === 'string' ? params.node.trim() : '';
    /** 节点截图时向外扩几像素（CSS 像素），默认 0 —— 描边/阴影贴边时用它留白。 */
    const padding = clampInt(params.padding, 0, 400, 0);
    /** 取景：见上面的表；不认的值按 auto 处理（回执里会说一声）。 */
    const fit = normalizeFitMode(params.fit);
    /** 要哪一种画面（`auto` / `scene` / `game`）—— 见 {@link ViewTarget}。 */
    const view = normalizeViewTarget(params.view);
    // ---- ① Electron 通道（正路）----
    const viaElectron = await captureViewViaElectron({
        savePath,
        maxWidth,
        format,
        quality,
        nodeRef,
        padding,
        projectPath: Editor.Project.path,
        fit: fit.mode,
        view: view.mode,
    });
    if ('reply' in viaElectron) {
        /** fit / view 参数写错了就说一声（不阻断截图） */
        if (viaElectron.reply.data) {
            const data = viaElectron.reply.data;
            if (fit.note)
                data.fitNote = fit.note;
            if (view.note) {
                data.viewNote = view.note;
                /** 这是"解读你的参数"的一句话，比裁剪/取景那些细节更该被看见 */
                data.note = data.note ? `${view.note}（另有：${data.note}）` : view.note;
            }
        }
        return viaElectron.reply;
    }
    // ---- ② 兜底：老的场景进程读像素 ----
    /**
     * 兜底通道读的是场景进程的 GL 后备缓冲，**没法摆相机**（取景那条链要靠主进程逐级量、`fitView` 才排得上），
     * 所以 `fit` 在这条路上**不生效** —— 不管这一步成败都要说清，否则用户会以为拿到的是全景。
     */
    const withFitNote = (reply) => {
        const data = reply.data;
        const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
        if (payload && !payload.viewMode) {
            /**
             * 兜底路**量不到模式**（它不经过 `viewMetrics`）—— 但那正是最要说清的一句：
             * 这条路上拿到的可能是场景、也可能是跑着的游戏，而回执里没有任何字段能区分。
             */
            payload.viewMode = {
                requested: view.mode,
                actual: 'unknown',
                note: '这条兜底通道判断不了这一页画的是场景还是游戏（它不经过主通道的几何探针）',
            };
        }
        if (view.note) {
            if (payload)
                payload.viewNote = view.note;
            return reply;
        }
        if (fit.mode === 'none')
            return reply;
        if (!payload || payload.fitIgnored)
            return reply;
        payload.fitIgnored =
            '这条兜底通道（场景进程读像素）不取景 —— 回执里这张图是**当前视角**那一帧；想拍全就修好主通道（看 electronFallback），或先自己把视角调好再截';
        return reply;
    };
    const run = await runSceneCode(CAPTURE_VIEW_SCENE_CODE, { savePath, maxWidth, format, quality, waitMs }, timeoutMs, false);
    const envelope = run.data;
    if (!envelope || envelope.ok !== true) {
        // 场景侧已经把原因说清楚了（没开场景 / 执行报错），原样传回去
        return withFitNote(run);
    }
    const captured = envelope.result;
    if (!captured || captured.ok !== true) {
        return withFitNote(captureFail(String((captured && captured.error) || '截图失败（场景侧没有返回图片）'), {
            scene: captured !== null && captured !== void 0 ? captured : null,
            electronFallback: viaElectron.fallback,
        }));
    }
    // 场景侧能落盘就落盘了（返回 path）；否则回传分块 base64，这里拼回来写盘 ——
    // 沙箱返回值有「单字符串 4000 字」上限，整张图塞不进一个字段。
    const filePath = typeof captured.path === 'string' && captured.path ? captured.path : savePath;
    if (captured.transport !== 'file') {
        const chunks = Array.isArray(captured.chunks) ? captured.chunks.map((c) => String(c)) : [];
        const base64 = chunks.join('');
        if (!base64)
            return withFitNote(captureFail('截图没有产出图片数据', { scene: captured }));
        try {
            const dir = path.dirname(filePath);
            if (dir)
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        }
        catch (err) {
            return withFitNote(captureFail(`写入截图文件失败：${describe(err)}`, { path: filePath, scene: captured }));
        }
    }
    let bytes = typeof captured.bytes === 'number' ? captured.bytes : 0;
    try {
        bytes = fs.statSync(filePath).size;
    }
    catch {
        /* 尺寸读不到不影响使用 */
    }
    const blankRatio = typeof captured.blankRatio === 'number' ? captured.blankRatio : null;
    const blank = blankRatio !== null && blankRatio >= 0.95;
    const payload = {
        ok: true,
        /** 见 captureView 的注释：这一条是**兜底路**（场景进程读 GL 后备缓冲） */
        method: 'scene-gl',
        path: filePath,
        width: captured.width,
        height: captured.height,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        format: (_a = captured.format) !== null && _a !== void 0 ? _a : format,
        bytes,
        blankRatio,
        // 视图状态（visibleSize / designResolution / canvas / visibleMatchesDesign）——
        // 空白帧时用来判断「是不是编辑器场景视图的设备模拟被改过」
        view: (_b = captured.view) !== null && _b !== void 0 ? _b : null,
        transport: captured.transport === 'file' ? 'scene' : 'editor',
        /** Electron 通道为什么没接手 —— 只回「老路的图」，但必须说清为什么退回来了 */
        electronFallback: viaElectron.fallback,
        electronContents: (0, capture_1.getElectron)() ? (0, capture_1.listContents)() : null,
        hint: blank ? CAPTURE_BLANK_HINT : CAPTURE_READ_HINT,
    };
    if (captured.saveError)
        payload.sceneWriteError = captured.saveError;
    if (fit.note)
        payload.fitNote = fit.note;
    return withFitNote({ ok: true, text: JSON.stringify(payload, null, 2), data: payload });
}
/** 探活：场景进程里本扩展的脚本加载了吗（`cocos_editor_state` 用它说明「能不能动场景」）。 */
async function pingSceneScript() {
    try {
        const value = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.ping);
        return value && value.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    }
    catch (err) {
        return { available: false, reason: describe(err) };
    }
}
/**
 * 一个节点在**页面上的位置**（点它 / 裁它 / 量它都要的那一份几何）。
 *
 * 复用截图那条路的同一份投影（`viewMetrics`）：这样「截图裁出来的矩形」与「点击落下的点」
 * 天然是同一套坐标 —— 两处各算一次的话，迟早出现"截到的和点到的差半个节点"。
 *
 * @param nodeRef - 节点 uuid 或路径；空串 = 只要页面几何（不要节点矩形）。
 * @returns `{ok, page, canvas, camera, runtime, node?, error?}`；拿不到就是 `{ok:false, error}`（不抛）。
 */
async function readNodeGeometry(nodeRef) {
    try {
        const metrics = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.viewMetrics, [
            { node: nodeRef || undefined, projectPath: Editor.Project.path },
        ]);
        if (!metrics || metrics.ok !== true) {
            return { ok: false, error: describe((metrics && metrics.error) || 'viewMetrics 没给出几何') };
        }
        return metrics;
    }
    catch (err) {
        return { ok: false, error: describe(err) };
    }
}
/**
 * 运行态探针：问场景脚本「这一页现在画的是编辑器场景，还是跑着的游戏」。
 *
 * 取的是 `viewMetrics` 的 `runtime` 那一块（见 `source/scene.ts` 的 `readSceneMode`）——
 * **不在主进程另抄一份判定**：模式是从场景进程里那几个 `cce` 单例读出来的，
 * 抄一份的下场是两处对同一个编辑器状态各说各话。
 *
 * 只带 `{}` 参数（不要节点矩形、不要取景），所以它很轻：一次场景进程往返。
 *
 * @returns 拿到就是 `{ok:true, runtime}`；场景不可用就 `{ok:false, error}`（不抛）。
 */
async function readSceneRuntime() {
    try {
        const metrics = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.viewMetrics, [{}]);
        if (!metrics || metrics.ok !== true) {
            return { ok: false, error: describe((metrics && metrics.error) || 'viewMetrics 没给出结果') };
        }
        const runtime = (metrics.runtime || null);
        if (!runtime) {
            return { ok: false, error: '场景脚本没有报 runtime（这个版本的本扩展脚本比主进程旧？）' };
        }
        return { ok: true, runtime };
    }
    catch (err) {
        return { ok: false, error: describe(err) };
    }
}
/**
 * 场景侧的反射 —— 转发给本扩展的场景脚本（那 200 多行「从 `__props__` + 实时实例读属性名」
 * 的逻辑一行都不用重写）。
 */
async function describeSceneApi(target, nodeUuid, limit) {
    const value = (await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.describeApi, [
        { target, nodeUuid: nodeUuid || undefined, limit },
    ]));
    if (!value || typeof value !== 'object') {
        throw new Error('场景脚本 describeApi 没有返回结果。');
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5naW5lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL2NvcmUvZW5naW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E2Qkc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBa1pILHNDQXlHQztBQVdELG9DQTRGQztBQTZKRCxrQ0FvREM7QUFtb0JELGtDQW1KQztBQUdELDBDQU9DO0FBV0QsNENBWUM7QUFhRCw0Q0FjQztBQU1ELDRDQWFDO0FBdHBERCx1Q0FBeUI7QUFDekIsdUNBQXlCO0FBQ3pCLDJDQUE2QjtBQUc3Qix3Q0FTb0I7QUFDcEIsdUNBS21CO0FBQ25CLGlEQUF3RTtBQUN4RSx1Q0FBeUM7QUFDekMsMkNBQWlGO0FBSWpGLDBDQUEwQztBQUMxQyxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFFM0Qsd0RBQXdEO0FBQ3hELE1BQU0sZ0JBQWdCLEdBQUc7SUFDckIsK0NBQStDO0lBQy9DLFNBQVMsRUFBRSxLQUFLO0lBQ2hCLE9BQU8sRUFBRSxHQUFHO0lBQ1osWUFBWSxFQUFFLElBQUk7Q0FDckIsQ0FBQztBQUVGLGtFQUFrRTtBQUNsRSxNQUFNLGlCQUFpQixHQUE4QjtJQUNqRCxRQUFRLEVBQUUsQ0FBQztJQUNYLGNBQWMsRUFBRSxHQUFHO0lBQ25CLGFBQWEsRUFBRSxFQUFFO0lBQ2pCLGVBQWUsRUFBRSxJQUFJO0NBQ3hCLENBQUM7QUFFRixxRUFBcUU7QUFDckUsTUFBTSxZQUFZLEdBQUc7SUFDakIsSUFBSSxFQUFFLE1BQU07SUFDWixPQUFPLEVBQUUsU0FBUztJQUNsQixXQUFXLEVBQUUsYUFBYTtJQUMxQixpREFBaUQ7SUFDakQsV0FBVyxFQUFFLGFBQWE7SUFDMUIsd0RBQXdEO0lBQ3hELE9BQU8sRUFBRSxTQUFTO0NBQ1osQ0FB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LEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDckQsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQzFELENBQUM7SUFFRCxNQUFNLE1BQU0sR0FBRyxDQUFDLEdBQVcsRUFBVSxFQUFFLENBQUMsQ0FBQyxXQUFXLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDOUYsTUFBTSxPQUFPLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQzNELE1BQU0sYUFBYSxHQUFHLFdBQVcsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxhQUFhLEdBQUcsV0FBVyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbEcsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxFQUFFLENBQUM7U0FDL0MsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUMzQixLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztTQUNYLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQ1gsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENB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QyxPQUFPLElBQUksT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLG1CQUFtQixDQUFDLEVBQUUsQ0FBQztRQUM3RixDQUFDO1FBQ0QsTUFBTSxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsT0FBTyxJQUFJLElBQUksQ0FBbUMsQ0FBQztRQUM1RSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDWCxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsbUNBQW1DLEVBQUUsQ0FBQztRQUNyRSxDQUFDO1FBQ0QsT0FBTyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDWCxPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7SUFDL0MsQ0FBQztBQUNMLENBQUM7QUFFRDs7O0dBR0c7QUFDSSxLQUFLLFVBQVUsZ0JBQWdCLENBQ2xDLE1BQWMsRUFDZCxRQUFnQixFQUNoQixLQUFhO0lBRWIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxNQUFNLElBQUEsOEJBQWUsRUFBMEIsWUFBWSxDQUFDLFdBQVcsRUFBRTtRQUNwRixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsUUFBUSxJQUFJLFNBQVMsRUFBRSxLQUFLLEVBQUU7S0FDckQsQ0FBQyxDQUF3QyxDQUFDO0lBRTNDLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDnvJbovpHlmajmiafooYzlvJXmk44g4oCU4oCUIGRzaF9jaGF0IOiHquW3seeahOOAjOS7o+eggeaymeeuseOAje+8jOS4jeWGjeWAnyBkZmFuX21jcDLjgIJcbiAqXG4gKiAjIyDov5nkuIDlsYLlnKjlk6rjgIHlubLku4DkuYhcbiAqXG4gKiBgYGBcbiAqIERTSCDlrZDov5vnqIsgLS1mb3JrIElQQy0tPiDmnKzmianlsZXkuLvov5vnqIsoY29jb3MtdG9vbHMpIC0tPiDmnKzmqKHlnZdcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilJzilIAgZWRpdG9yIOS4iuS4i+aWh++8mnZtIOaymeeuse+8iGNvcmUvc2FuZGJveO+8iVxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlOKUgCBzY2VuZSDkuIrkuIvmlofvvJrmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvIhzb3VyY2Uvc2NlbmUudHPvvIlcbiAqIGBgYFxuICpcbiAqIOWFqOeoiyoq5LiN57uP6L+HIGxvb3BiYWNrIEhUVFAqKu+8iOWvueavlCBNQ1Ag55qEIDEyNy4wLjAuMTo4NzMx77yJ77yM5Lmf5LiN57uP6L+H56ys5LqM5Liq5omp5bGV77yaXG4gKiDlnLrmma/ohJrmnKzmmK/mnKzmianlsZUgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOiHquW3seazqOWGjOeahO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxuICog5Li76L+b56iL5L6n55qE5omn6KGM5Zmo5bCx5piv5pys5paH5Lu244CC6IO95Yqb6Z2i5LiO5Y6f5YWI5aSN55So55qE6YKj5aWXKirpgJDmnaHlr7npvZAqKu+8mlxuICog5ZCM5LiA5aWX6LaF5pe25Y+j5b6E44CB5ZCM5LiA5aWX5bqP5YiX5YyW5LiK6ZmQ44CB5ZCM5LiA5aWX5Yqp5omL77yIYGVhY2hOb2RlYCAvIGB0cmVlYCAvIGBub2RlQnlQYXRoYCAvXG4gKiBgZHVtcGAgLyBgc25hcHNob3RgIC8gcmVjaXBlIOS6lOS7tuWllyDigKbvvInvvIzmiYDku6XmqKHlnovnmoTnlKjms5XkuIDkuKrlrZfpg73kuI3nlKjmlLnjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYggZWRpdG9yIOS4jiBzY2VuZSDnmoTmiafooYzmlrnlvI/kuI3lkIzvvIjkuI3og73nu5/kuIDvvIlcbiAqXG4gKiAtICoqZWRpdG9y77yI5pys5qih5Z2X77yJKirvvJpgdm0uY3JlYXRlQ29udGV4dGAg6ZqU56a75rKZ566x44CC5Li76L+b56iL6YeM6LeR77yM6ZqU56a76LaK5Lil6LaK5aW944CCXG4gKiAtICoqc2NlbmXvvIhzb3VyY2Uvc2NlbmUudHPvvIkqKu+8mmB2bS5ydW5JblRoaXNDb250ZXh0YCDlkIwgcmVhbG0gKyDlkIzmraXotoXml7bjgIJcbiAqICAg5byV5pOO6L+b56iLKirkuI3og70qKuaNoiByZWFsbSDigJTigJQg5rKZ566x6YeM6YCg5Ye65p2l55qEIGB7fWAgLyBgW11gIOWcqOW8leaTjueahCBgaW5zdGFuY2VvZmAg5Yik5pat5LiL5Li65YGH77yMXG4gKiAgIOS8muiuqeS4gOWghuW8leaTjiBBUEkg5Ye6546w6Zq+5p+l55qE6K+h5byC6KGM5Li644CC57uG6IqC6KeBIHNjZW5lLnRzIOWktOmDqOazqOmHiuOAglxuICpcbiAqICMjIOi2heaXtueahOivmuWunui+ueeVjFxuICpcbiAqIGB2bWAg55qEIGB0aW1lb3V0YCDlj6rnrqHlkIzmraXmrrXvvJvlvILmraXpnaAgYFByb21pc2UucmFjZWAg6K6h5pe25ZmoIOKAlOKAlCDlroPlj6rorqkqKuiwg+eUqOaWuSoq5LiN5YaN562J77yMXG4gKiAqKuS4jeS8muecn+eahOadgOaOiSoq5bey57uP5Zyo6LeR55qE5byC5q2l5Luj56CB77yITm9kZSDmsqHmnInmiqLljaDlvI/lj5bmtojvvInjgIJcbiAqIOaJgOS7peWIq+WcqOaymeeusemHjOWGmSBgYXdhaXQgbmV3IFByb21pc2UoKCkgPT4ge30pYCDov5nnp43kuI3lj6/nu5PmnZ/nmoTnrYnlvoXjgIJcbiAqL1xuXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgKiBhcyBvcyBmcm9tICdvcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQgeyB0eXBlIFRvb2xSZXBseSB9IGZyb20gJy4uL2NvbnN0YW50cyc7XG5pbXBvcnQge1xuICAgIGNhcHR1cmVTY2VuZVZpZXcsXG4gICAgY3JvcFRvQ3NzUmVjdCxcbiAgICBkb3duc2NhbGVUb1dpZHRoLFxuICAgIGVsZWN0cm9uVW5hdmFpbGFibGVSZWFzb24sXG4gICAgZW5jb2RlSW1hZ2UsXG4gICAgZ2V0RWxlY3Ryb24sXG4gICAgaW1hZ2VTaXplT2YsXG4gICAgbGlzdENvbnRlbnRzLFxufSBmcm9tICcuLi9jYXB0dXJlJztcbmltcG9ydCB7XG4gICAgYnVpbGRSZWNpcGVIZWxwZXJzLFxuICAgIFJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyxcbiAgICB0eXBlIFJlY2lwZVJ1bm5lcixcbiAgICB0eXBlIFJlY2lwZVJ1bk91dGNvbWUsXG59IGZyb20gJy4vcmVjaXBlcyc7XG5pbXBvcnQgeyBjYWxsU2NlbmVTY3JpcHQsIFNjZW5lVW5hdmFpbGFibGVFcnJvciB9IGZyb20gJy4vc2NlbmUtYnJpZGdlJztcbmltcG9ydCB7IHJ1bkluU2FuZGJveCB9IGZyb20gJy4vc2FuZGJveCc7XG5pbXBvcnQgeyBmb3JtYXRJbmxpbmUsIHNhZmVTZXJpYWxpemUsIHR5cGUgU2VyaWFsaXplT3B0aW9ucyB9IGZyb20gJy4vc2VyaWFsaXplJztcblxuZXhwb3J0IHR5cGUgQ29kZUNvbnRleHQgPSAnZWRpdG9yJyB8ICdzY2VuZSc7XG5cbi8qKiDmianlsZXljIXmoLnnm67lvZXvvIhgZGlzdC9jb3JlL2VuZ2luZS5qc2Ag5b6A5LiK5Lik57qn77yJ44CCICovXG5jb25zdCBFWFRFTlNJT05fUk9PVCA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuLicsICcuLicpO1xuXG4vKiog5rKZ566x6buY6K6k5YC877yI5Y6f5YWI5ZyoIGRmYW5fbWNwMiDnmoTorr7nva7pnaLmnb/ph4zosIPvvJvmnKzmianlsZXkuI3orr7pnaLmnb/vvIzmlLnmiJDluLjph48gKyDljZXlpITlj6/mlLnvvInjgIIgKi9cbmNvbnN0IFNBTkRCT1hfREVGQVVMVFMgPSB7XG4gICAgLyoqIGBjb2Nvc19leGVjdXRlX2NvZGVgIOayoeS8oCB0aW1lb3V0TXMg5pe255qE6buY6K6k6LaF5pe2ICovXG4gICAgdGltZW91dE1zOiAxNTAwMCxcbiAgICBtYXhMb2dzOiAyMDAsXG4gICAgbWF4TG9nTGVuZ3RoOiA0MDAwLFxufTtcblxuLyoqIOi/lOWbnuWAvOW6j+WIl+WMluS4iumZkO+8mua3seW6piA2IC8g5pWw57uEIDEwMCAvIOWvueixoSA2MCDplK4gLyDljZXlrZfnrKbkuLIgNDAwMCDlrZfvvIjkuI7lt6Xlhbfmj4/ov7Dph4zlhpnnmoTkuIDoh7TvvInjgIIgKi9cbmNvbnN0IFNFUklBTElaRV9PUFRJT05TOiBQYXJ0aWFsPFNlcmlhbGl6ZU9wdGlvbnM+ID0ge1xuICAgIG1heERlcHRoOiA2LFxuICAgIG1heEFycmF5TGVuZ3RoOiAxMDAsXG4gICAgbWF4T2JqZWN0S2V5czogNjAsXG4gICAgbWF4U3RyaW5nTGVuZ3RoOiA0MDAwLFxufTtcblxuLyoqIOWcuuaZr+iEmuacrOazqOWGjOeahOaWueazleWQje+8iOS4jiBwYWNrYWdlLmpzb24g55qEIGBjb250cmlidXRpb25zLnNjZW5lLm1ldGhvZHNgIOWvuem9kO+8ieOAgiAqL1xuY29uc3QgU0NFTkVfTUVUSE9EID0ge1xuICAgIHBpbmc6ICdwaW5nJyxcbiAgICBydW5Db2RlOiAncnVuQ29kZScsXG4gICAgZGVzY3JpYmVBcGk6ICdkZXNjcmliZUFwaScsXG4gICAgLyoqIOWcuuaZr+inhuWbvuWHoOS9le+8mkVsZWN0cm9uIOaIquWbvumdoOWug+WumuS9jSB3ZWJDb250ZW50cyDlubbmjaLnrpfoo4HliIfnn6nlvaIgKi9cbiAgICB2aWV3TWV0cmljczogJ3ZpZXdNZXRyaWNzJyxcbiAgICAvKiog5Y+W5pmvIC8g6L+Y5Y6f6KeG6KeS77ya44CM5oqK5pW05Liq5Zy65pmv5aGe6L+b55S75biD5YaN5oiq44CN6Z2g5a6D77yI6KeBIGNhcHR1cmVWaWV3IOeahCBmaXQg5Y+C5pWw77yJICovXG4gICAgZml0VmlldzogJ2ZpdFZpZXcnLFxufSBhcyBjb25zdDtcblxuLyoqIOaKiuS7u+aEj+W8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZWRpdG9yIOS4iuS4i+aWh+eahOaymeeuseWFqOWxgOmHj1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog5pq06Zyy57uZ5rKZ566x55qEIGBwcm9jZXNzYCDop4blm77jgIJcbiAqXG4gKiDliLvmhI/oo4HmjokgYGV4aXRgIC8gYGtpbGxgIC8gYGVudmDvvJpcbiAqIC0gYGV4aXRgIOS8muiuqee8lui+keWZqOS4u+i/m+eoi+ebtOaOpeaMguaOie+8iEFJIOaJi+a7keS4gOasoeWwseW+l+mHjeWQr+e8lui+keWZqO+8jOi/mOWPr+iDveS4ouacquS/neWtmOeahOWcuuaZr++8ie+8m1xuICogLSBgZW52YCDph4zluLjmnIkgdG9rZW4v5a+G6ZKl77yM6buY6K6k5LiN57uZ5a6D6aG65omL5oqE6L+b5qih5Z6L5LiK5LiL5paH55qE5py65Lya44CCXG4gKlxuICog6ZyA6KaB55qE6K+dIGByZXF1aXJlKCdwcm9jZXNzJylgIOS7jeeEtuaLv+W+l+WIsOecn+eahCDigJTigJQg6L+Z5pivKirpmLLmiYvmu5HvvIzkuI3mmK/pmLLotormnYMqKuOAglxuICovXG5mdW5jdGlvbiBidWlsZFNhZmVQcm9jZXNzKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICBwbGF0Zm9ybTogcHJvY2Vzcy5wbGF0Zm9ybSxcbiAgICAgICAgYXJjaDogcHJvY2Vzcy5hcmNoLFxuICAgICAgICB2ZXJzaW9uOiBwcm9jZXNzLnZlcnNpb24sXG4gICAgICAgIHZlcnNpb25zOiB7IC4uLnByb2Nlc3MudmVyc2lvbnMgfSxcbiAgICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgICAgY3dkOiAoKSA9PiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICB1cHRpbWU6ICgpID0+IHByb2Nlc3MudXB0aW1lKCksXG4gICAgICAgIG1lbW9yeVVzYWdlOiAoKSA9PiBwcm9jZXNzLm1lbW9yeVVzYWdlKCksXG4gICAgICAgIGhydGltZTogKHRpbWU/OiBbbnVtYmVyLCBudW1iZXJdKSA9PiBwcm9jZXNzLmhydGltZSh0aW1lKSxcbiAgICB9O1xufVxuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNjAwMDAsIE1hdGgudHJ1bmMoTnVtYmVyKG1zKSkgfHwgMCkpKTtcbiAgICB9KTtcblxuLyoqXG4gKiDlm77niYflg4/ntKDmjqLpkogg4oCU4oCUICoq57Sg5p2Q57qn5LqL5a6eKirvvJrov5nlvKDlm77liLDlupXplb/ku4DkuYjmoLfjgIHog73kuI3og73mn5PoibLjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjlroPlv4XpobvlnKggZWRpdG9yIOS+p+OAgemdoCBFbGVjdHJvblxuICpcbiAqIOOAjOi/meW8oOWbvuS4reW/g+eahCBhbHBoYSDmmK/kuI3mmK8gMOOAjeOAjOS4u+S9k+aYr+S4jeaYr+eZveeahO+8iOiDveS4jeiDveeUqCBgU3ByaXRlLmNvbG9yYCDmn5PoibLvvInjgI1cbiAqIOi/meexu+mXrumimOaYryoq55yL5Zu+KirvvIzkuI3mmK/nnIvlnLrmma/jgILogIzvvJpcbiAqXG4gKiAtICoq5Zy65pmv6L+b56iLKirph4zmi7/kuI3liLDlj6/pnaDop6PnoIHot6/lvoTvvIjopoHoh6rlt7HkuIogY2FudmFz77yM5LiU5Zu+6ZuG5a2Q5binL+WOi+e8qeagvOW8j+WQhOS4jeS4gOagt++8ie+8m1xuICogLSAqKk5vZGUg5rKh5pyJ5YaF572uIFBORyDop6PnoIHlmagqKiDigJTigJQg5ZyoIGVkaXRvciDmspnnrrHph4wgYGZzLnJlYWRGaWxlU3luY2Ag5ou/5Yiw55qE5piv5LiA5aCG5a2X6IqC77yMXG4gKiAgIOiHquW3seino+aekCBJREFUL3psaWIg5piv5Yeg5Y2D6KGM5LiU55m95bmy77ybXG4gKiAtIOKchSAqKkVsZWN0cm9uIOS4u+i/m+eoi+eahCBgbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGgoKWAgKyBgdG9CaXRtYXAoKWAqKiDkuIDmrKHnu5nliLBcbiAqICAgQkdSQSDljp/lp4vlg4/ntKAg4oCU4oCUIOmbtuS+nei1luOAgeS7u+aEj+W4uOingeagvOW8j+OAgeS7u+aEj+WwuuWvuOOAgmBjYXB0dXJlLnRzYCDmipPlm77lt7Lnu4/lnKjnlKjlkIzkuIDlpZfjgIJcbiAqXG4gKiAjIyDlroPmm7/mjonnmoTmmK/ku4DkuYhcbiAqXG4gKiDlrp7mtYvlj43lpI3lh7rnjrDnmoTkuInkuKrpl67popjvvIzljp/lhYjlj6rog73pnaDjgIzmiZPlvIDlm77niYfnnIvjgI3miJbogIUqKueMnCoq77yaXG4gKlxuICogfCDpl67popggfCDljp/nrZTmoYggfCDnjrDlnKggfFxuICogfC0tLXwtLS18LS0tfFxuICogfCBgcmVjdF9yZF8xMC5wbmdgIOWtmOS4jeWtmOWcqCB8IOaLvOi3r+W+hOeMnOOAgeivu+ebruW9leeci+S4gOecvCB8IOS4gOasoeiwg+eUqO+8jOi/mOe7mSoq55u46L+R5ZCN5a2XKiogfFxuICogfCBgcmVjdF9ib2FyZF9yZF8xMGAg5Lit5b+D5piv56m655qE77yI5pivXCLnjq9cIuS4jeaYr1wi5p2/XCLvvIkgfCDmiornmb3lrZfmlL7kuIrljrvmiY3lj5HnjrDnnIvkuI3op4EgfCBgY2VudGVyLmFgID0gMCB8XG4gKiB8IGBhY2hpdmVtZW50LnBuZ2Ag5piv5rex6Imy5Zu+5b2i77yIKirmn5PkuI3kuoboibIqKu+8iSB8IOafk+S6huayoeeUqO+8jOWGjeeMnOS4gOi9riB8IGB0aW50LndoaXRlaXNoID0gZmFsc2VgIHxcbiAqXG4gKiAjIyDor5rlrp7nmoTovrnnlYxcbiAqXG4gKiAtIOWPquWQgyoq56OB55uY5LiK55qE5Zu+54mH5paH5Lu2KirjgIJgZGI6Ly9pbnRlcm5hbC/igKZg77yI5byV5pOO5YaF572u77yJ5LiN5Zyo5bel56iL55uu5b2V77yM5Lya5piO6K+06ICM5LiN5piv6Z2Z6buY5aSx6LSl44CCXG4gKiAtIGAubWV0YWAg6YeM6K+75LiN5YiwIHV1aWQg5pe2IGB1dWlkYCDkuLogbnVsbO+8iCoq5LiN5b2x5ZON5YOP57Sg57uT6K66KirvvInjgIJcbiAqIC0g5Zu+6ZuG6YeM55qEKirlrZDluKcqKu+8mui/memHjOe7meeahOaYryoq5pW05byg5Zu+KirnmoTlnZDmoIfvvIzopoHlrZDluKfoh6rlt7HnlKggU3ByaXRlRnJhbWUg55qEIGByZWN0YCDmjaLnrpfjgIJcbiAqXG4gKiBAcGFyYW0gcmVmIOWbvueJh+i3r+W+hO+8mmBkYjovL2Fzc2V0cy/igKZgIC8g5bel56iL55u45a+5IC8g57ud5a+577yM5LiJ6ICF6YO96KGMXG4gKiBAcGFyYW0gb3B0aW9ucy54IOimgeeyvuehruivu+eahOmCo+S4quWDj+e0oOeahCB477yIKirmlbTlm77lg4/ntKDlnZDmoIcqKu+8jOWOn+eCueW3puS4iu+8iVxuICogQHBhcmFtIG9wdGlvbnMueSDlkIzkuIpcbiAqL1xuZnVuY3Rpb24gcHJvYmVJbWFnZShyZWY6IHVua25vd24sIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IG9wdGlvbnMgfHwge307XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHJlZiA9PT0gJ3N0cmluZycgPyByZWYudHJpbSgpIDogJyc7XG4gICAgaWYgKCFyYXcpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicHJvYmUocmVmKe+8muimgeS4gOS4quWbvueJh+i3r+W+hO+8jOS+i+WmgiBwcm9iZSgnZGI6Ly9hc3NldHMvcmVzb3VyY2VzL3RleHR1cmVzL2NvbW1vbi9yZWN0X3JkXzIwLnBuZycp44CCXCIpO1xuICAgIH1cblxuICAgIGxldCBmaWxlID0gcmF3O1xuICAgIGlmIChyYXcuaW5kZXhPZignZGI6Ly9hc3NldHMvJykgPT09IDApIHtcbiAgICAgICAgZmlsZSA9IHBhdGguam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJywgcmF3LnNsaWNlKCdkYjovL2Fzc2V0cy8nLmxlbmd0aCkpO1xuICAgIH0gZWxzZSBpZiAocmF3LmluZGV4T2YoJ2RiOi8vJykgPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHByb2Jl77yaJyR7cmF3fScg5oyH5ZCR55qE5LiN5piv5bel56iLIGFzc2V0cyDph4znmoTmlofku7bvvIhkYjovL2ludGVybmFsIOS5i+exu+aYr+W8leaTjuWGhee9rui1hOa6kO+8jOejgeebmOS4iuS4jeWcqOW3peeoi+ebruW9le+8ieOAgmAsXG4gICAgICAgICk7XG4gICAgfVxuICAgIGlmICghcGF0aC5pc0Fic29sdXRlKGZpbGUpKSBmaWxlID0gcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGZpbGUpO1xuXG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKGZpbGUpKSB7XG4gICAgICAgIC8vIOi3r+W+hOWGmemUmeaYr+acgOW4uOingeeahOWOn+WboCDigJTigJQg6aG65omL5oqK5ZCM55uu5b2V5LiL5ZCN5a2X55u46L+R55qE5YiX5Ye65p2l77yM55yB5LiA6L2uIGxpc3REaXJcbiAgICAgICAgbGV0IG5lYXJieTogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGJhc2UgPSBwYXRoLmJhc2VuYW1lKGZpbGUpLnJlcGxhY2UoL1xcLihwbmd8anBlP2d8d2VicCkkL2ksICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgY29uc3Qgc3RlbSA9IGJhc2Uuc2xpY2UoMCwgTWF0aC5taW4oNiwgYmFzZS5sZW5ndGgpKTtcbiAgICAgICAgICAgIG5lYXJieSA9IGZzXG4gICAgICAgICAgICAgICAgLnJlYWRkaXJTeW5jKHBhdGguZGlybmFtZShmaWxlKSlcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChuYW1lKSA9PiBuYW1lLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihzdGVtKSA+PSAwKVxuICAgICAgICAgICAgICAgIC5zbGljZSgwLCA4KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBuZWFyYnkgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHBhdGg6IGZpbGUsIGV4aXN0czogZmFsc2UsIGVycm9yOiBg5paH5Lu25LiN5a2Y5Zyo77yaJHtmaWxlfWAsIG5lYXJieSB9O1xuICAgIH1cblxuICAgIGxldCB1dWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBtZXRhRmlsZSA9IGAke2ZpbGV9Lm1ldGFgO1xuICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhtZXRhRmlsZSkpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhtZXRhRmlsZSwgJ3V0Zi04JykpIGFzIHsgdXVpZD86IHVua25vd24gfTtcbiAgICAgICAgICAgIGlmIChtZXRhICYmIHR5cGVvZiBtZXRhLnV1aWQgPT09ICdzdHJpbmcnKSB1dWlkID0gbWV0YS51dWlkO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOivu+S4jeWIsOWwseeul+S6hu+8muWDj+e0oOe7k+iuuuS4jeS+nei1luWugyAqL1xuICAgIH1cbiAgICAvKiog5LiOIGBhdWRpdDp1aWAg55qEIFA0IOWQjOS4gOadoeWIpOaNru+8muW8leaTjuWGhee9rui0tOWbviB1dWlkIOWJjee8gCAqL1xuICAgIGNvbnN0IGVuZ2luZUJ1aWx0aW4gPSBCb29sZWFuKHV1aWQgJiYgdXVpZC5pbmRleE9mKCc3ZDhmOWI4OScpID09PSAwKTtcblxuICAgIGNvbnN0IGVsZWN0cm9uID0gZ2V0RWxlY3Ryb24oKSBhcyB7IG5hdGl2ZUltYWdlPzogeyBjcmVhdGVGcm9tUGF0aChwOiBzdHJpbmcpOiBhbnkgfSB9IHwgbnVsbDtcbiAgICBpZiAoIWVsZWN0cm9uIHx8ICFlbGVjdHJvbi5uYXRpdmVJbWFnZSB8fCB0eXBlb2YgZWxlY3Ryb24ubmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGggIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIHBhdGg6IGZpbGUsXG4gICAgICAgICAgICBleGlzdHM6IHRydWUsXG4gICAgICAgICAgICB1dWlkLFxuICAgICAgICAgICAgZXJyb3I6IGDmi7/kuI3liLAgRWxlY3Ryb24g55qEIG5hdGl2ZUltYWdl77yIJHtlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCkgfHwgJ+W9k+WJjeS4jeWcqOS4u+i/m+eoi++8nyd977yJ77yM6K+75LiN5LqG5YOP57Sg44CCYCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBsZXQgaW1hZ2U6IGFueTtcbiAgICBsZXQgc2l6ZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0geyB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XG4gICAgbGV0IGJpdG1hcDogQnVmZmVyO1xuICAgIHRyeSB7XG4gICAgICAgIGltYWdlID0gZWxlY3Ryb24ubmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGgoZmlsZSk7XG4gICAgICAgIHNpemUgPSBpbWFnZS5nZXRTaXplKCk7XG4gICAgICAgIGlmICghc2l6ZS53aWR0aCB8fCAhc2l6ZS5oZWlnaHQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcGF0aDogZmlsZSwgZXhpc3RzOiB0cnVlLCB1dWlkLCBlcnJvcjogJ25hdGl2ZUltYWdlIOino+S4jeW8gOi/meW8oOWbvu+8iOagvOW8j+S4jeiupOivhu+8n++8ieOAgicgfTtcbiAgICAgICAgfVxuICAgICAgICBiaXRtYXAgPSBpbWFnZS50b0JpdG1hcCgpOyAvLyBCR1JBXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBwYXRoOiBmaWxlLFxuICAgICAgICAgICAgZXhpc3RzOiB0cnVlLFxuICAgICAgICAgICAgdXVpZCxcbiAgICAgICAgICAgIGVycm9yOiBg6Kej5YOP57Sg5aSx6LSl77yaJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiogQkdSQSDihpIg5LiA5Liq5YOP57Sg44CC6LaK55WM5ZueIG51bGzvvIjkuI3mipvvvInjgIIgKi9cbiAgICBjb25zdCBwaXhlbEF0ID0gKHg6IG51bWJlciwgeTogbnVtYmVyKTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPT4ge1xuICAgICAgICBpZiAoISh4ID49IDAgJiYgeSA+PSAwICYmIHggPCBzaXplLndpZHRoICYmIHkgPCBzaXplLmhlaWdodCkpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBvID0gKHkgKiBzaXplLndpZHRoICsgeCkgKiA0O1xuICAgICAgICBpZiAobyArIDMgPj0gYml0bWFwLmxlbmd0aCkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiB7IHI6IGJpdG1hcFtvICsgMl0sIGc6IGJpdG1hcFtvICsgMV0sIGI6IGJpdG1hcFtvXSwgYTogYml0bWFwW28gKyAzXSB9O1xuICAgIH07XG4gICAgY29uc3QgdG9IZXggPSAocHg6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgICBweCA/IGAjJHtbcHguciwgcHguZywgcHguYiwgcHguYV0ubWFwKCh2KSA9PiB2LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKX1gIDogbnVsbDtcblxuICAgIC8vIOWFqOWbvue7n+iuoe+8iOaKveagt++8jOWkn+S4i+WIpOaWreS4lOS4jeS8muiiq+Wkp+WbvuaLluaFou+8iVxuICAgIGNvbnN0IHRvdGFsID0gc2l6ZS53aWR0aCAqIHNpemUuaGVpZ2h0O1xuICAgIGNvbnN0IHN0ZXAgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHRvdGFsIC8gMjAwMDApKTtcbiAgICBsZXQgc2FtcGxlZCA9IDA7XG4gICAgbGV0IHRyYW5zcGFyZW50ID0gMDtcbiAgICBsZXQgYWxwaGFNaW4gPSAyNTU7XG4gICAgbGV0IGFscGhhTWF4ID0gMDtcbiAgICBsZXQgc3VtUiA9IDA7XG4gICAgbGV0IHN1bUcgPSAwO1xuICAgIGxldCBzdW1CID0gMDtcbiAgICBsZXQgb3BhcXVlQ291bnQgPSAwO1xuICAgIGxldCB3aGl0ZWlzaENvdW50ID0gMDtcbiAgICBjb25zdCBjb2xvdXJUYWxseSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b3RhbDsgaSArPSBzdGVwKSB7XG4gICAgICAgIGNvbnN0IHB4ID0gcGl4ZWxBdChpICUgc2l6ZS53aWR0aCwgTWF0aC5mbG9vcihpIC8gc2l6ZS53aWR0aCkpO1xuICAgICAgICBpZiAoIXB4KSBjb250aW51ZTtcbiAgICAgICAgc2FtcGxlZCArPSAxO1xuICAgICAgICBpZiAocHguYSA8IGFscGhhTWluKSBhbHBoYU1pbiA9IHB4LmE7XG4gICAgICAgIGlmIChweC5hID4gYWxwaGFNYXgpIGFscGhhTWF4ID0gcHguYTtcbiAgICAgICAgaWYgKHB4LmEgPT09IDApIHtcbiAgICAgICAgICAgIHRyYW5zcGFyZW50ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBvcGFxdWVDb3VudCArPSAxO1xuICAgICAgICBzdW1SICs9IHB4LnI7XG4gICAgICAgIHN1bUcgKz0gcHguZztcbiAgICAgICAgc3VtQiArPSBweC5iO1xuICAgICAgICBjb25zdCBtYXhDID0gTWF0aC5tYXgocHguciwgcHguZywgcHguYik7XG4gICAgICAgIGNvbnN0IG1pbkMgPSBNYXRoLm1pbihweC5yLCBweC5nLCBweC5iKTtcbiAgICAgICAgaWYgKHB4LmEgPj0gMjAwICYmIG1pbkMgPj0gMjAwICYmIG1heEMgLSBtaW5DIDw9IDI0KSB3aGl0ZWlzaENvdW50ICs9IDE7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke3B4LnIgPj4gNX0sJHtweC5nID4+IDV9LCR7cHguYiA+PiA1fWA7XG4gICAgICAgIGNvbG91clRhbGx5LnNldChrZXksIChjb2xvdXJUYWxseS5nZXQoa2V5KSB8fCAwKSArIDEpO1xuICAgIH1cblxuICAgIGNvbnN0IG1lYW5PZiA9IChzdW06IG51bWJlcik6IG51bWJlciA9PiAob3BhcXVlQ291bnQgPiAwID8gTWF0aC5yb3VuZChzdW0gLyBvcGFxdWVDb3VudCkgOiAwKTtcbiAgICBjb25zdCBtZWFuUkdCID0gW21lYW5PZihzdW1SKSwgbWVhbk9mKHN1bUcpLCBtZWFuT2Yoc3VtQildO1xuICAgIGNvbnN0IHdoaXRlaXNoUmF0aW8gPSBvcGFxdWVDb3VudCA+IDAgPyBNYXRoLnJvdW5kKCh3aGl0ZWlzaENvdW50IC8gb3BhcXVlQ291bnQpICogMTAwKSAvIDEwMCA6IDA7XG4gICAgY29uc3QgdG9wQ29sb3VycyA9IEFycmF5LmZyb20oY29sb3VyVGFsbHkuZW50cmllcygpKVxuICAgICAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgICAgIC5zbGljZSgwLCA1KVxuICAgICAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGFydHMgPSBlbnRyeVswXS5zcGxpdCgnLCcpLm1hcCgodikgPT4gKE51bWJlcih2KSA8PCA1KSB8IDE2KTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaGV4OiBgIyR7cGFydHMubWFwKCh2KSA9PiBNYXRoLm1pbigyNTUsIHYpLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKX1gLFxuICAgICAgICAgICAgICAgIHNoYXJlOiBvcGFxdWVDb3VudCA+IDAgPyBNYXRoLnJvdW5kKChlbnRyeVsxXSAvIG9wYXF1ZUNvdW50KSAqIDEwMCkgLyAxMDAgOiAwLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICBjb25zdCBjZW50ZXIgPSBwaXhlbEF0KE1hdGguZmxvb3Ioc2l6ZS53aWR0aCAvIDIpLCBNYXRoLmZsb29yKHNpemUuaGVpZ2h0IC8gMikpO1xuICAgIGNvbnN0IGNvcm5lcnMgPSB7XG4gICAgICAgIHRsOiB0b0hleChwaXhlbEF0KDAsIDApKSxcbiAgICAgICAgdHI6IHRvSGV4KHBpeGVsQXQoc2l6ZS53aWR0aCAtIDEsIDApKSxcbiAgICAgICAgYmw6IHRvSGV4KHBpeGVsQXQoMCwgc2l6ZS5oZWlnaHQgLSAxKSksXG4gICAgICAgIGJyOiB0b0hleChwaXhlbEF0KHNpemUud2lkdGggLSAxLCBzaXplLmhlaWdodCAtIDEpKSxcbiAgICB9O1xuICAgIGNvbnN0IGNvcm5lckFscGhhcyA9IFtcbiAgICAgICAgcGl4ZWxBdCgwLCAwKSxcbiAgICAgICAgcGl4ZWxBdChzaXplLndpZHRoIC0gMSwgMCksXG4gICAgICAgIHBpeGVsQXQoMCwgc2l6ZS5oZWlnaHQgLSAxKSxcbiAgICAgICAgcGl4ZWxBdChzaXplLndpZHRoIC0gMSwgc2l6ZS5oZWlnaHQgLSAxKSxcbiAgICBdLm1hcCgocHgpID0+IChweCA/IHB4LmEgOiBudWxsKSk7XG5cbiAgICAvKiog55yf5q2j55qE6YKj5Liq6Zeu6aKY77ya44CM6L+Z5Zu+6IO95LiN6IO955SoIGBTcHJpdGUuY29sb3JgIOafk+aIkOS7u+aEj+iJsuOAjSAqL1xuICAgIGNvbnN0IGNhbnZhc0xpa2UgPSBjb3JuZXJBbHBoYXMuZXZlcnkoKGEpID0+IGEgPT09IDApO1xuICAgIGNvbnN0IHRpbnROb3RlID0gIWNhbnZhc0xpa2VcbiAgICAgICAgPyAn5Zub6KeS5LiN5YWo5piv6YCP5piOIOKAlOKAlCDlroPlpKfmpoLmmK/kuIDlvKAqKuS4jemAj+aYjuW6lSoq55qE5Zu+77yI5oiW5ZyG6KeS5rKh6ZO65ruh77yJ77yM5p+T6Imy5Lya5p+T5Yiw5pW05Z2X6IOM5pmv44CCJ1xuICAgICAgICA6IHdoaXRlaXNoUmF0aW8gPj0gMC45XG4gICAgICAgICAgPyAn5Li75L2T5o6l6L+R55m9L+eBsOS4lOWbm+inkumAj+aYjiDigJTigJQg5YW45Z6L55qEKirlj6/mn5PoibIqKuWbvuagh++8iGBTcHJpdGUuY29sb3JgIOiDveaKiuWug+WPmOaIkOS7u+aEj+minOiJsu+8ieOAgidcbiAgICAgICAgICA6IHdoaXRlaXNoUmF0aW8gPj0gMC40XG4gICAgICAgICAgICA/ICfkuLvkvZPmmK/mtYXoibLkvYbkuI3lpJ/nuq/nmb0g4oCU4oCUIOafk+iJsuWQjioq6aKc6Imy5Lya5YGPKirvvIjljp/oibLkvJrpgI/lh7rmnaXvvInjgIInXG4gICAgICAgICAgICA6ICfkuLvkvZPmmK8qKuW9qeiJsi/mt7HoibIqKueahCDigJTigJQg55SoIGBTcHJpdGUuY29sb3JgIOafk+S4jeWHuuaDs+imgeeahOminOiJsu+8iOa3seiJsuWPquS8muabtOm7ke+8ie+8jOimgeS5iOaNouWbvuimgeS5iOWIq+afk+OAgic7XG5cbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgcGF0aDogZmlsZSxcbiAgICAgICAgZXhpc3RzOiB0cnVlLFxuICAgICAgICB1dWlkLFxuICAgICAgICBlbmdpbmVCdWlsdGluLFxuICAgICAgICBieXRlczogKCgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZzLnN0YXRTeW5jKGZpbGUpLnNpemU7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkoKSxcbiAgICAgICAgd2lkdGg6IHNpemUud2lkdGgsXG4gICAgICAgIGhlaWdodDogc2l6ZS5oZWlnaHQsXG4gICAgICAgIGFscGhhOiB7XG4gICAgICAgICAgICBtaW46IGFscGhhTWluLFxuICAgICAgICAgICAgbWF4OiBhbHBoYU1heCxcbiAgICAgICAgICAgIHRyYW5zcGFyZW50UmF0aW86IHNhbXBsZWQgPiAwID8gTWF0aC5yb3VuZCgodHJhbnNwYXJlbnQgLyBzYW1wbGVkKSAqIDEwMCkgLyAxMDAgOiAwLFxuICAgICAgICB9LFxuICAgICAgICBjZW50ZXI6IHsgcmdiYTogY2VudGVyLCBoZXg6IHRvSGV4KGNlbnRlcikgfSxcbiAgICAgICAgY29ybmVycyxcbiAgICAgICAgY29ybmVyQWxwaGFzLFxuICAgICAgICBmdWxsQmxlZWQ6IGNvcm5lckFscGhhcy5ldmVyeSgoYSkgPT4gYSAhPT0gbnVsbCAmJiBhID4gMCksXG4gICAgICAgIG1lYW5SR0IsXG4gICAgICAgIHdoaXRlaXNoUmF0aW8sXG4gICAgICAgIHRpbnQ6IHsgY2FudmFzTGlrZSwgd2hpdGVpc2g6IHdoaXRlaXNoUmF0aW8gPj0gMC45LCBub3RlOiB0aW50Tm90ZSB9LFxuICAgICAgICB0b3BDb2xvdXJzLFxuICAgICAgICBzYW1wbGVkUGl4ZWxzOiBzYW1wbGVkLFxuICAgICAgICBub3RlOiAn5Z2Q5qCH6YO95pivKirmlbTlvKDlm74qKueahOWDj+e0oO+8iOWOn+eCueW3puS4iu+8ie+8m+WbvumbhuWtkOW4p+imgeiHquW3seeUqCBTcHJpdGVGcmFtZSDnmoQgcmVjdCDmjaLnrpfjgIInLFxuICAgIH07XG5cbiAgICBjb25zdCB3YW50WCA9IE51bWJlcihvcHRzLngpO1xuICAgIGNvbnN0IHdhbnRZID0gTnVtYmVyKG9wdHMueSk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh3YW50WCkgJiYgTnVtYmVyLmlzRmluaXRlKHdhbnRZKSkge1xuICAgICAgICBjb25zdCBweCA9IHBpeGVsQXQoTWF0aC5yb3VuZCh3YW50WCksIE1hdGgucm91bmQod2FudFkpKTtcbiAgICAgICAgb3V0LmF0ID0geyB4OiBNYXRoLnJvdW5kKHdhbnRYKSwgeTogTWF0aC5yb3VuZCh3YW50WSksIHJnYmE6IHB4LCBoZXg6IHRvSGV4KHB4KSB9O1xuICAgICAgICBpZiAoIXB4KSBvdXQuYXROb3RlID0gYCgke3dhbnRYfSwgJHt3YW50WX0pIOi2iueVjOS6hu+8iOWbvuaYryAke3NpemUud2lkdGh9w5cke3NpemUuaGVpZ2h0fe+8iWA7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogZWRpdG9yIOi1t+aJi+W8j+WKqeaJi+eahOetvuWQjea4heWNlSDigJTigJQg5ZCM5LiA5Lu95YaF5a655pei5rOo5YWl5rKZ566x44CB5Lmf55So5LqOIGBkZXNjcmliZV9hcGlgIOWxleekuuOAglxuICpcbiAqIHJlY2lwZSDpgqPkupTmnaHkuZ/lnKjov5nph4zvvJrlroPku6wqKuaYr+WKqeaJi+OAgeS4jeaYr+W3peWFtyoq77yM5bel5YW35YiX6KGo5Y+q5pyJ5Zub5LiqXG4gKiDvvIhgY29jb3NfZXhlY3V0ZV9jb2RlYCAvIGBjb2Nvc19kZXNjcmliZV9hcGlgIC8gYGNvY29zX2VkaXRvcl9zdGF0ZWAgLyBgY29jb3NfY2FwdHVyZV92aWV3YO+8ieOAglxuICovXG5jb25zdCBFRElUT1JfSEVMUEVSX1NJR05BVFVSRVMgPSBbXG4gICAgJ3NsZWVwKG1zKSDihpIgUHJvbWlzZScsXG4gICAgJ2V4dGVuc2lvblJvb3Qg4oaSIHN0cmluZ++8iOacrOaPkuS7tuebruW9le+8iScsXG4gICAgJ3Byb2plY3RQYXRoKCkg4oaSIHN0cmluZycsXG4gICAgJ3Jlc29sdmVQcm9qZWN0UGF0aChwKSDihpIgc3RyaW5n77yI55u45a+56Lev5b6E5oyJ5bel56iL5qC56Kej5p6Q77yJJyxcbiAgICAnbGlzdERpcihkaXIpIOKGkiBzdHJpbmdbXScsXG4gICAgJ3JlYWRKc29uKGZpbGUpIOKGkiBhbnknLFxuICAgIFwicHJvYmUocmVmLCB7eD8sIHk/fSkg4oaSIHt3aWR0aCwgaGVpZ2h0LCBjZW50ZXIsIGNvcm5lcnMsIGFscGhhLCB3aGl0ZWlzaFJhdGlvLCB0aW50LCB0b3BDb2xvdXJzLCBlbmdpbmVCdWlsdGluLCBuZWFyYnl9ICAvLyAqKuWbvueJh+eahOWDj+e0oOe6p+S6i+Wunioq77ya6K+75p+Q5Liq5YOP57SgL+S4reW/gy/lm5vop5LjgIHpgI/mmI7mr5TkvovjgIHkuLvkvZPmmK/kuI3mmK/nmb3oibLvvIg9IOiDveS4jeiDveeUqCBTcHJpdGUuY29sb3Ig5p+T6Imy77yJ44CB5piv5LiN5piv5byV5pOO5YaF572u6LS05Zu+44CCcmVmIOaUtiAnZGI6Ly9hc3NldHMv4oCmJyAvIOW3peeoi+ebuOWvuSAvIOe7neWvue+8m+aWh+S7tuS4jeWtmOWcqOS8mumhuuaJi+WIl+WHuuWQjeWtl+ebuOi/keeahFwiLFxuICAgIC4uLlJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyxcbl0gYXMgY29uc3Q7XG5cbi8qKiBlZGl0b3Ig5LiK5LiL5paH55qE6LW35omL5byP5Yqp5omL77yIcmVjaXBlIOS6lOS7tuWll+eUsSBgcnVuRWRpdG9yQ29udGV4dGAg5Y+m5Yqg77yJ44CCICovXG5mdW5jdGlvbiBidWlsZEVkaXRvckhlbHBlcnMoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHNsZWVwLFxuICAgICAgICAvKiog5omp5bGV5YyF5qC555uu5b2VIOKAlOKAlCDmg7Por7vmnKzmj5Lku7bmupDnoIHml7bnlKggKi9cbiAgICAgICAgZXh0ZW5zaW9uUm9vdDogRVhURU5TSU9OX1JPT1QsXG4gICAgICAgIC8qKiDlvZPliY3lt6XnqIvmoLnnm67lvZUgKi9cbiAgICAgICAgcHJvamVjdFBhdGg6ICgpID0+IEVkaXRvci5Qcm9qZWN0LnBhdGgsXG4gICAgICAgIC8qKiDmiornm7jlr7kv57ud5a+56Lev5b6E57uf5LiA5oiQ57ud5a+56Lev5b6E77yI55u45a+55bel56iL55qE6Lev5b6E5oyJ5bel56iL5qC56Kej5p6Q77yJICovXG4gICAgICAgIHJlc29sdmVQcm9qZWN0UGF0aDogKHA6IHN0cmluZykgPT4gKHBhdGguaXNBYnNvbHV0ZShwKSA/IHAgOiBwYXRoLmpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgcCkpLFxuICAgICAgICAvKiog5YiX55uu5b2V77yI5Y+q6L+U5Zue5ZCN5a2X77yM6YG/5YWN5LiA5qyh5ZCQ5aSq5aSa77yJICovXG4gICAgICAgIGxpc3REaXI6IChkaXI6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFicyA9IHBhdGguaXNBYnNvbHV0ZShkaXIpID8gZGlyIDogcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGRpcik7XG4gICAgICAgICAgICByZXR1cm4gZnMucmVhZGRpclN5bmMoYWJzKTtcbiAgICAgICAgfSxcbiAgICAgICAgLyoqIOivuyBKU09O77yI6YWN6KGo6ISa5pys57uP5bi46KaB5bmy6L+Z5Liq77yJICovXG4gICAgICAgIHJlYWRKc29uOiAoZmlsZTogc3RyaW5nKTogdW5rbm93biA9PiB7XG4gICAgICAgICAgICBjb25zdCBhYnMgPSBwYXRoLmlzQWJzb2x1dGUoZmlsZSkgPyBmaWxlIDogcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGZpbGUpO1xuICAgICAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKGFicywgJ3V0Zi04JykpO1xuICAgICAgICB9LFxuICAgICAgICAvKiog5Zu+54mH5YOP57Sg5o6i6ZKIIOKAlOKAlCDop4Ege0BsaW5rIHByb2JlSW1hZ2V9IOeahOivtOaYju+8iOOAjOi/meWbvuiDveS4jeiDveafk+iJsuOAjemdoOWug+S4gOWPpeivneetlO+8iSAqL1xuICAgICAgICBwcm9iZTogKHJlZjogdW5rbm93biwgb3B0aW9ucz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBwcm9iZUltYWdlKHJlZiwgb3B0aW9ucyksXG4gICAgICAgIGhlbHBlck5hbWVzOiAoKSA9PiBbLi4uRURJVE9SX0hFTFBFUl9TSUdOQVRVUkVTXSxcbiAgICB9O1xufVxuXG4vKiog5oqK5rKZ566x5pel5b+X6KGM6L2s5oiQ5ZON5bqU6YeM55qE5a2X56ym5Liy5pWw57uEICovXG5mdW5jdGlvbiBmb3JtYXRMb2dMaW5lcyhsb2dzOiBBcnJheTx7IGxldmVsOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9Pik6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gbG9ncy5tYXAoKGwpID0+IGBbJHtsLmxldmVsfV0gJHtsLnRleHR9YCk7XG59XG5cbi8qKiDlpLnkuIDkuKrosIPnlKjmlrnkvKDov5vmnaXnmoTotoXml7bvvIjmqKHlnovkuI7pnaLmnb/pg73lj6/og73nu5nohI/lgLzvvIkgKi9cbmZ1bmN0aW9uIGNsYW1wVGltZW91dCh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgoMTAwLCBNYXRoLm1pbigzMDAwMDAsIE1hdGgudHJ1bmMocmF3KSkpO1xufVxuXG4vKiog5pW05pWw5aS55Y+W77yI5oiq5Zu+5Y+C5pWw55So77yJ44CCICovXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogdW5rbm93biwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC50cnVuYyh2YWx1ZSkgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIG4pKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlZGl0b3Ig5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKue8lui+keWZqOS4u+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6ZqU56a75rKZ566x77yJ44CCXG4gKlxuICog6L+U5Zue55qEIGBkYXRhYCDlsLHmmK/nu5nmqKHlnovnnIvnmoTpgqPkuKrkv6HlsIEgYHtvaywgY29udGV4dCwgZHVyYXRpb25NcywgcmVzdWx0fGVycm9yLCBsb2dzLCBub3Rlc+KApn1g77ybXG4gKiBgdGV4dGAg5piv5a6D55qEIEpTT04g5paH5pys44CCKirkv6HlsIHlvaLnirblv4Xpobvkv53mjIHnqLPlrpoqKiDigJTigJQgYGNvY29zX2VkaXRvcl9zdGF0ZWAg5LmL57G755qE6LCD55So5pa5XG4gKiDpnaAgYCdyZXN1bHQnIGluIGVudmVsb3BlYCDop6PljIXvvIjop4EgY29jb3MtdG9vbHMg55qEIGB1bndyYXBTYW5kYm94UmVzdWx0YO+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRWRpdG9yQ29kZShcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIC8vIOaDsOaAp+aMgeacieaJp+ihjOWZqO+8mnJlY2lwZSDliqnmiYvopoHog73osIPjgIzot5HkuIDmrrXku6PnoIHjgI3vvIzogIzpgqPmrrXku6PnoIHlj4jpnIDopoHlkIzmoLfnmoTlhajlsYDph49cbiAgICAvLyDvvIjljIXmi6wgcmVjaXBlIOWKqeaJi+iHquW3se+8ieKAlOKAlCDkupLnm7jlvJXnlKjvvIzmiYDku6Xlv4XpobvmmZrnu5HlrprjgIJcbiAgICBjb25zdCBydW5uZXJSZWY6IHsgY3VycmVudDogUmVjaXBlUnVubmVyIHwgbnVsbCB9ID0geyBjdXJyZW50OiBudWxsIH07XG5cbiAgICBjb25zdCB7IGhlbHBlcnM6IHJlY2lwZUhlbHBlcnMgfSA9IGJ1aWxkUmVjaXBlSGVscGVycyh7XG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxuICAgICAgICBjb250ZXh0OiAnZWRpdG9yJyxcbiAgICAgICAgZGVmYXVsdFRpbWVvdXRNczogdGltZW91dE1zLFxuICAgICAgICBnZXRSdW5uZXI6ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJ1bm5lciA9IHJ1bm5lclJlZi5jdXJyZW50O1xuICAgICAgICAgICAgaWYgKCFydW5uZXIpIHRocm93IG5ldyBFcnJvcigncmVjaXBlIOaJp+ihjOWZqOWwmuacquWwsee7qicpO1xuICAgICAgICAgICAgcmV0dXJuIHJ1bm5lcjtcbiAgICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBFZGl0b3IsXG4gICAgICAgIHJlcXVpcmUsXG4gICAgICAgIG1vZHVsZSxcbiAgICAgICAgZXhwb3J0cyxcbiAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICBfX2ZpbGVuYW1lLFxuICAgICAgICBmcyxcbiAgICAgICAgcGF0aCxcbiAgICAgICAgb3MsXG4gICAgICAgIEJ1ZmZlcixcbiAgICAgICAgcHJvY2VzczogYnVpbGRTYWZlUHJvY2VzcygpLFxuICAgICAgICBzZXRUaW1lb3V0LFxuICAgICAgICBjbGVhclRpbWVvdXQsXG4gICAgICAgIHNldEludGVydmFsLFxuICAgICAgICBjbGVhckludGVydmFsLFxuICAgICAgICBzZXRJbW1lZGlhdGUsXG4gICAgICAgIGFyZ3MsXG4gICAgICAgIC4uLmJ1aWxkRWRpdG9ySGVscGVycygpLFxuICAgICAgICAuLi5yZWNpcGVIZWxwZXJzLFxuICAgIH07XG5cbiAgICBjb25zdCBzYW5kYm94T3B0aW9ucyA9IHtcbiAgICAgICAgbWF4TG9nczogU0FOREJPWF9ERUZBVUxUUy5tYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgIH07XG5cbiAgICAvKiogcmVjaXBlIOeahOaJp+ihjOWZqO+8muWQjOS4gOS4quaymeeuseacuuWItu+8jOeLrOeri+eahOi2heaXtuS4juaXpeW/l+e8k+WGsiAqL1xuICAgIHJ1bm5lclJlZi5jdXJyZW50ID0gYXN5bmMgKFxuICAgICAgICByZWNpcGVDb2RlOiBzdHJpbmcsXG4gICAgICAgIHJlY2lwZUFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICBuZXN0ZWRUaW1lb3V0TXM6IG51bWJlcixcbiAgICApOiBQcm9taXNlPFJlY2lwZVJ1bk91dGNvbWU+ID0+IHtcbiAgICAgICAgY29uc3QgbmVzdGVkID0gYXdhaXQgcnVuSW5TYW5kYm94KHtcbiAgICAgICAgICAgIGNvZGU6IHJlY2lwZUNvZGUsXG4gICAgICAgICAgICBnbG9iYWxzOiB7IC4uLmdsb2JhbHMsIGFyZ3M6IHJlY2lwZUFyZ3MgfSxcbiAgICAgICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvci1yZWNpcGUnLFxuICAgICAgICAgICAgLi4uc2FuZGJveE9wdGlvbnMsXG4gICAgICAgICAgICB0aW1lb3V0TXM6IG5lc3RlZFRpbWVvdXRNcyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogbmVzdGVkLm9rLFxuICAgICAgICAgICAgcmVzdWx0OiBuZXN0ZWQucmVzdWx0LFxuICAgICAgICAgICAgZXJyb3I6IG5lc3RlZC5lcnJvcixcbiAgICAgICAgICAgIGxvZ3M6IG5lc3RlZC5sb2dzLmxlbmd0aCA+IDAgPyBmb3JtYXRMb2dMaW5lcyhuZXN0ZWQubG9ncykgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBkdXJhdGlvbk1zOiBuZXN0ZWQuZHVyYXRpb25NcyxcbiAgICAgICAgICAgIHRpbWVkT3V0OiBuZXN0ZWQudGltZWRPdXQsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGNvbnN0IHJ1biA9IGF3YWl0IHJ1bkluU2FuZGJveCh7XG4gICAgICAgIGNvZGUsXG4gICAgICAgIGdsb2JhbHMsXG4gICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvcicsXG4gICAgICAgIC4uLnNhbmRib3hPcHRpb25zLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShydW4ucmVzdWx0LCBTRVJJQUxJWkVfT1BUSU9OUyk7XG4gICAgLy8g44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN5LiN6IO95Y+q5Zue5LiA5Y+lIGNjIGlzIG5vdCBkZWZpbmVk77yI6KeBIGV4cGxhaW5FcnJvciDph4zorrDnmoTlrp7mtYvku6Pku7fvvIlcbiAgICBjb25zdCBlcnJvciA9IHJ1bi5vayA/IG51bGwgOiBleHBsYWluRXJyb3IocnVuLmVycm9yID8/IHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogJ+e8lui+keWZqOS+p+aJp+ihjOWksei0pScgfSwgJ2VkaXRvcicpO1xuICAgIGNvbnN0IGVudmVsb3BlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHJ1bi5vayxcbiAgICAgICAgY29udGV4dDogJ2VkaXRvcicsXG4gICAgICAgIGR1cmF0aW9uTXM6IHJ1bi5kdXJhdGlvbk1zLFxuICAgICAgICAuLi4ocnVuLm9rID8geyByZXN1bHQ6IHNlcmlhbGl6ZWQudmFsdWUgfSA6IHsgZXJyb3IgfSksXG4gICAgfTtcbiAgICBpZiAocnVuLmxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHJ1bi5sb2dzKTtcbiAgICBpZiAocnVuLmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAocnVuLnRpbWVkT3V0KSBlbnZlbG9wZS50aW1lZE91dCA9IHRydWU7XG4gICAgaWYgKHNlcmlhbGl6ZWQudHJ1bmNhdGVkKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChg6L+U5Zue5YC86KKr5oiq5pat77yI5ZG95Lit6ZmQ5Yi277yaJHtzZXJpYWxpemVkLmxpbWl0cy5qb2luKCcsICcpfe+8iWApO1xuICAgICAgICBlbnZlbG9wZS5ub3RlcyA9IG5vdGVzO1xuICAgIH1cblxuICAgIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShlbnZlbG9wZSwgbnVsbCwgMik7XG4gICAgcmV0dXJuIHJ1bi5va1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICfnvJbovpHlmajkvqfmiafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2NlbmUg5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKuW8leaTjuWcuuaZr+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yJ44CCXG4gKlxuICogQHBhcmFtIHdhbnRTbmFwc2hvdCAtIOiwg+eUqOaWueaYvuW8j+imgeaxgueZu+iusOS4gOasoeaSpOmUgOW/q+eFp++8iOiEmuacrOWGhSBgc25hcHNob3QoKWAg5Lmf5Lya572u5ZCM5LiA5Liq5qCH5b+X77yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5TY2VuZUNvZGUoXG4gICAgY29kZTogc3RyaW5nLFxuICAgIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuICAgIHdhbnRTbmFwc2hvdDogYm9vbGVhbixcbik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgbGV0IHNjZW5lUmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgICBzY2VuZVJlc3VsdCA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oU0NFTkVfTUVUSE9ELnJ1bkNvZGUsIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBjb2RlLFxuICAgICAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgICAgICAgdGltZW91dE1zLFxuICAgICAgICAgICAgICAgIG1heExvZ3M6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9ncyxcbiAgICAgICAgICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgICAgICAgICAgICAgIC8vIOW3peeoi+aguSoq55Sx5Li76L+b56iL57uZKirvvIjov5nph4zmi7/lvpfliLAgRWRpdG9yLlByb2plY3QucGF0aO+8ie+8muWcuuaZr+i/m+eoi+mHjOeahFxuICAgICAgICAgICAgICAgIC8vIGBFZGl0b3JgIOaYr+e8lui+keWZqOazqOWFpeeahOWFqOWxgOmHj++8jOacquW/heavj+S4queJiOacrOmDveWunuWIsOiDveivuyBQcm9qZWN0LnBhdGgg4oCU4oCUXG4gICAgICAgICAgICAgICAgLy8gYGxvYWRGcmFtZWAg6KaB6Z2g5a6D5Y676K+7IGAubWV0YWDvvIjop4Egc2NlbmUudHMg6YeMIGxvYWRGcmFtZSDnmoTor7TmmI7vvInvvIxcbiAgICAgICAgICAgICAgICAvLyDlsJHov5nkuIDkuKrlrZfmrrXlsLHkvJrpgIDljJbmiJDjgIzlj6rmnIkgdXVpZCDog73nlKjjgI3jgIJcbiAgICAgICAgICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgU2NlbmVVbmF2YWlsYWJsZUVycm9yID8gZXJyLm1lc3NhZ2UgOiBkZXNjcmliZShlcnIpO1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHsgb2s6IGZhbHNlLCBjb250ZXh0OiAnc2NlbmUnLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KGVudmVsb3BlLCBudWxsLCAyKSwgZXJyb3I6IG1lc3NhZ2UsIGRhdGE6IGVudmVsb3BlIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb2sgPSBzY2VuZVJlc3VsdC5vayA9PT0gdHJ1ZTtcbiAgICAvLyDlnLrmma/kvqfov5Tlm57nmoTmmK/lvJXmk47ph4znmoTmtLvlr7nosaHvvIzlv4Xpobvov4fkuIDpgY3luo/liJfljJblho3ov5vlk43lupRcbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShzY2VuZVJlc3VsdC5yZXN1bHQsIFNFUklBTElaRV9PUFRJT05TKTtcblxuICAgIC8vIOW/q+eFp+eZu+iusO+8muiEmuacrOWGhSBzbmFwc2hvdCgpIOe9ruS9je+8jOaIluiwg+eUqOaWueaYvuW8j+imgeaxglxuICAgIGxldCBzbmFwc2hvdFRha2VuOiBib29sZWFuIHwgdW5kZWZpbmVkO1xuICAgIGlmIChvayAmJiAoc2NlbmVSZXN1bHQuc25hcHNob3RSZXF1ZXN0ZWQgPT09IHRydWUgfHwgd2FudFNuYXBzaG90KSkge1xuICAgICAgICBzbmFwc2hvdFRha2VuID0gYXdhaXQgcmVxdWVzdFNjZW5lU25hcHNob3QoKTtcbiAgICB9XG5cbiAgICBjb25zdCByYXdFcnJvciA9IHNjZW5lUmVzdWx0LmVycm9yIGFzIHsgbmFtZT86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGVycm9yID0gb2sgPyBudWxsIDogZXhwbGFpbkVycm9yKHsgbmFtZTogcmF3RXJyb3I/Lm5hbWUgPz8gJ0Vycm9yJywgbWVzc2FnZTogcmF3RXJyb3I/Lm1lc3NhZ2UgPz8gJ+WcuuaZr+aJp+ihjOWksei0pScgfSwgJ3NjZW5lJyk7XG5cbiAgICBjb25zdCBlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIG9rLFxuICAgICAgICBjb250ZXh0OiAnc2NlbmUnLFxuICAgICAgICBkdXJhdGlvbk1zOiBzY2VuZVJlc3VsdC5kdXJhdGlvbk1zID8/IDAsXG4gICAgICAgIC4uLihvayA/IHsgcmVzdWx0OiBzZXJpYWxpemVkLnZhbHVlIH0gOiB7IGVycm9yIH0pLFxuICAgIH07XG4gICAgY29uc3Qgc2NlbmVMb2dzID0gQXJyYXkuaXNBcnJheShzY2VuZVJlc3VsdC5sb2dzKVxuICAgICAgICA/IChzY2VuZVJlc3VsdC5sb2dzIGFzIEFycmF5PHsgbGV2ZWw6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0+KVxuICAgICAgICA6IFtdO1xuICAgIGlmIChzY2VuZUxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHNjZW5lTG9ncyk7XG4gICAgaWYgKHNjZW5lUmVzdWx0LmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAoc2NlbmVSZXN1bHQudGltZWRPdXQpIGVudmVsb3BlLnRpbWVkT3V0ID0gdHJ1ZTtcbiAgICBpZiAoc25hcHNob3RUYWtlbiAhPT0gdW5kZWZpbmVkKSBlbnZlbG9wZS51bmRvU25hcHNob3QgPSBzbmFwc2hvdFRha2VuO1xuICAgIGlmIChzZXJpYWxpemVkLnRydW5jYXRlZCkge1xuICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgIG5vdGVzLnB1c2goYOi/lOWbnuWAvOiiq+aIquaWre+8iOWRveS4remZkOWItu+8miR7c2VyaWFsaXplZC5saW1pdHMuam9pbignLCAnKX3vvIlgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDmlLnlrozlnLrmma/kuYvlkI4qKuaPkOmGkuWtmCByZWNpcGUqKiDigJTigJQg6L+Z5p2h5LiN5piv6KOF6aWw44CCXG4gICAgICpcbiAgICAgKiDln7rlh4bph4zmnIDnqLPlrprnmoTkuIDmnaHlt67or4TlsLHmmK/jgIzlpI3nlKggMCDpobnjgI3vvJrkuIDmlbTmrrXot5HpgJrnmoTlu7rmoJHku6PnoIHvvIjlrp7mtYsgNTJLQiDlj5HlvoDnvJbovpHlmajjgIFcbiAgICAgKiA1MCDmraXph4wgMzUg5q2l5pivIGBjb2Nvc19leGVjdXRlX2NvZGVg77yJ5aaC5p6c5rKh5a2Y5oiQIHJlY2lwZe+8jOS4i+asoeaNouS8muivneWwsSoq5LuO6Zu25YaN5p2l5LiA6YGNKipcbiAgICAgKiDvvIjljoblj7LkuIrjgIzlgZrkuIDkuKrnmbvlvZXnlYzpnaLpooTliLbku7bjgI3ooqvlgZrkuoYgMyDmrKHnnJ/ot5EgKyAxIOasoeWkreaKmO+8jOe6piAxMzEg5YiG6ZKf77yJ44CCXG4gICAgICpcbiAgICAgKiDop6blj5HmnaHku7bliLvmhI/mlLbnqoTvvIzlhY3lvpflj5jmiJDmr4/mnaHlm57miafpg73otLTnmoTlup/or53vvJpcbiAgICAgKiDikaAg6L+Z5LiA6L2u55yf55qE5pS55LqG5Zy65pmv77yI55m76K6w5LqG5pKk6ZSA5b+r54Wn77yJ77yb4pGhIOS7o+eggeWkn+mVv++8iOKJpTEyMDAg5a2X77yM55+t5o6i6ZKI5LiN5b+F5a2Y77yJ77ybXG4gICAgICog4pGiIOayoei2heaXtu+8iOi2heaXtueahOmCo+asoeW+gOW+gOayoei3keWujO+8jOWtmOS4i+adpeaYr+S4quWdke+8ieOAglxuICAgICAqL1xuICAgIGlmIChvayAmJiBzbmFwc2hvdFRha2VuID09PSB0cnVlICYmICFzY2VuZVJlc3VsdC50aW1lZE91dCAmJiBjb2RlLmxlbmd0aCA+PSAxMjAwKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgIGDov5nmrKHmlLnliqjnnJ/nlJ/mlYjkuobvvIjlt7LnmbvorrDmkqTplIDlv6vnhafvvInvvIzogIzkuJTku6PnoIHmnIkgJHtjb2RlLmxlbmd0aH0g5a2XIOKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAn5aaC5p6c5Lul5ZCO6L+Y5Lya55So77yI5bu65qCRIC8g5oyJ5aWR57qm5pCtIFVJIC8g5om56YeP5pS56IqC54K5IC8g5a2Y6aKE5Yi25Lu277yJ77yMJyArXG4gICAgICAgICAgICAgICAgJ+aKiioq5ZCM5LiA5q615Luj56CBKirnlKggc2F2ZVJlY2lwZSjlkI3lrZcsIDzov5nmrrXku6PnoIE+LCB7ZGVzY3JpcHRpb24sIHBhcmFtcywgcmV0dXJuc30pIOWtmOS4i+adpe+8micgK1xuICAgICAgICAgICAgICAgICfkuIvmrKHlvIDlt6UgZmluZFJlY2lwZXMg5bCx6IO95om+5Yiw5a6D77yM5LiN55So5LuO6Zu25YaN5YaZ5LiA6YGN44CCJyArXG4gICAgICAgICAgICAgICAgJ++8iOS4gOasoeaAp+eahOaOoue0ouebtOaOpSByZXR1cm4g5bCx6KGM77yM5Yir5a2Y44CC77yJJyxcbiAgICAgICAgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZW52ZWxvcGUsIG51bGwsIDIpO1xuICAgIHJldHVybiBva1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICflnLrmma/miafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8qKlxuICog6K+35rGC5LiA5qyh5Zy65pmv5pKk6ZSA5b+r54Wn44CCXG4gKlxuICog5Zy65pmv6ISa5pys6YeM55qEIGBzbmFwc2hvdCgpYCDlj6rnva7moIflv5fkvY3vvIznnJ/mraPnmoTlv6vnhafnlLHov5nph4zlj5Hotbcg4oCU4oCUXG4gKiDlv4XpobvnlLHkuLvov5vnqIvosIPvvIzlm6DkuLrku44gc2NlbmUg6L+b56iL57uZIHNjZW5lIOWMheWPkea2iOaBr+aYr+iHqueOr+OAglxuICovXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0U2NlbmVTbmFwc2hvdCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlr7nlpJbvvJpleGVjdXRlX2NvZGUgLyBjYXB0dXJlX3ZpZXcgLyDmjqLmtLsgLyDlnLrmma/kvqcgZGVzY3JpYmVfYXBpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBFeGVjdXRlQ29kZVBhcmFtcyB7XG4gICAgY29kZT86IHVua25vd247XG4gICAgY29udGV4dD86IHVua25vd247XG4gICAgYXJncz86IHVua25vd247XG4gICAgdGltZW91dE1zPzogdW5rbm93bjtcbiAgICBzbmFwc2hvdD86IHVua25vd247XG59XG5cbi8qKlxuICog44CM6L+Z5q615Luj56CB5Y+q6IO95ZyoIHNjZW5lIOi3keOAjeeahOWIpOaNriDigJTigJQg5LiA5Liq5Liq6YO95pivKirlj6rlnKjlnLrmma/kuIrkuIvmloflrZjlnKjnmoToo7jmoIfor4bnrKYqKuOAglxuICpcbiAqIOS4uuS7gOS5iOimgeacieS4gOS7vea4heWNle+8mmBjb250ZXh0YCDmvI/nu5nml7bvvIzml6flrp7njrDlnKggYGNvY29zLXRvb2xzYC/ov5nph4zpg73mmK9cbiAqIGBwYXJhbXMuY29udGV4dCA9PT0gJ3NjZW5lJyA/ICdzY2VuZScgOiAnZWRpdG9yJ2Ag4oCU4oCUIOS5n+WwseaYryoq6Z2Z6buY5b2T5oiQIGVkaXRvcioq77yMXG4gKiDogIwgZWRpdG9yIOaymeeusemHjOayoeaciSBgY2Ng77yM5LqO5piv5qih5Z6L5ou/5Yiw55qE5piv77yaXG4gKlxuICogYGBgXG4gKiBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRcbiAqIGBgYFxuICpcbiAqIOWunua1i+S7o+S7t++8iDIwMjYtMDktMzAgMTc6NDUg6YKj5p2h5Lya6K+d77yJ77ya5qih5Z6L5a6M5YWo5LiN55+l6YGT6L+Z5piv44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN77yMXG4gKiDkuo7mmK/ov57nnYAgMTAg5q2l5Zyo5YGa5a+554Wn5a6e6aqMIOKAlOKAlCDmgIDnlpEgYGFyZ3NgIOaUueWPmOS6huaJp+ihjOeOr+Wig+OAgeaAgOeWkeS7o+eggeWkqumVv+iiq+aIquaWreOAgVxuICog5oCA55aRIHNjZW5lIOi/m+eoi+S4ouS6hiBgY2Ng44CB5oCA55aR5pivIGBzbmFwc2hvdDogdHJ1ZWAg55qE5Ymv5L2c55So77yIKirov5nmnaHmmK/plJnnmoTvvIzop4HkuIsqKu+8ie+8jFxuICog5LiA5q2l6YO95rKh5b6A44CM5oiR5rKh5YaZIGNvbnRleHTjgI3kuIrmg7PjgILmlbTmnaHkvJror50gNTAg5q2l6YeM5pyJIDEwIOatpeiKseWcqOi/meS4iumdouOAglxuICpcbiAqIOKaoCAqKmBzbmFwc2hvdDogdHJ1ZWAg5LiN5piv5Y6f5ZugKirvvIhza2lsbCDph4zmm77ov5nkuYjorrDvvIzlt7Lmm7TmraPvvInvvJpgc25hcHNob3RgIOWPquaYr1xuICog44CM6LeR5a6M5LmL5ZCO6aKd5aSW55m76K6w5LiA5qyh5pKk6ZSA5b+r54Wn44CN77yM5Luj56CB5LuN6LeR5ZyoIHNjZW5lIOaymeeusemHjO+8jGBjY2Ag54Wn5qC35ZyoXG4gKiDvvIhgc2NyaXB0cy92ZXJpZnktY29jb3MtZW5naW5lLmpzYCDph4zmnInkuIDmnaHmlq3oqIDlsLHmmK8gYGNvbnRleHQ6J3NjZW5lJyArIHNuYXBzaG90OnRydWVgIOi3kemAmueahO+8ieOAglxuICog55yf5q2j55qE5Yik5o2u5Y+q5pyJ44CM5pyJ5rKh5pyJ57uZIGNvbnRleHTjgI3jgIJcbiAqL1xuY29uc3QgU0NFTkVfT05MWV9NQVJLRVJTOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSljY1xccypbLlsoXS8sIG5hbWU6ICdjYycgfSxcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pZGlyZWN0b3JcXHMqWy5bKF0vLCBuYW1lOiAnZGlyZWN0b3InIH0sXG4gICAgeyBwYXR0ZXJuOiAvKF58W15BLVphLXowLTlfJC5dKShub2RlQnlQYXRofG5vZGVCeVV1aWR8ZWFjaE5vZGV8Y29udGVudENoaWxkcmVufGlzRWRpdG9yTm9kZXxmaW5kVmlld0NhbnZhcylcXHMqXFwoLywgbmFtZTogJ+WcuuaZr+WKqeaJi++8iG5vZGVCeVBhdGgg562J77yJJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSkodHJlZXxkdW1wfGNhcHR1cmVWaWV3fGxvYWRGcmFtZXx3b3JsZFJlY3QpXFxzKlxcKC8sIG5hbWU6ICd0cmVlL2R1bXAvY2FwdHVyZVZpZXcvbG9hZEZyYW1lL3dvcmxkUmVjdCcgfSxcbiAgICB7XG4gICAgICAgIHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pKHBpY2t8bGFiZWxGaXR8c25hcHNob3RUcmVlfGRpZmZUcmVlKVxccypcXCgvLFxuICAgICAgICBuYW1lOiAncGljay9sYWJlbEZpdC9zbmFwc2hvdFRyZWUvZGlmZlRyZWUnLFxuICAgIH0sXG5dO1xuXG4vKiog44CM6L+Z5q615Luj56CB5Y+q6IO95ZyoIGVkaXRvciDot5HjgI3nmoTliKTmja7jgIIgKi9cbmNvbnN0IEVESVRPUl9PTkxZX01BUktFUlM6IEFycmF5PHsgcGF0dGVybjogUmVnRXhwOyBuYW1lOiBzdHJpbmcgfT4gPSBbXG4gICAgeyBwYXR0ZXJuOiAvKF58W15BLVphLXowLTlfJC5dKUVkaXRvclxccypbLltdLywgbmFtZTogJ0VkaXRvcicgfSxcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pKHJlc29sdmVQcm9qZWN0UGF0aHxsaXN0RGlyfHJlYWRKc29ufHByb2plY3RQYXRofGV4dGVuc2lvblJvb3QpXFxzKlxcKD8vLCBuYW1lOiAn57yW6L6R5Zmo5Yqp5omL77yIcHJvamVjdFBhdGgg562J77yJJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSlwcm9iZVxccypcXCgvLCBuYW1lOiAncHJvYmXvvIjlm77niYflg4/ntKDmjqLpkojvvIknIH0sXG5dO1xuXG4vKipcbiAqICoq5byx5Yik5o2uKirvvJrlnLrmma/kvqfni6zmnInnmoTmoIfor4bnrKbvvIzooqvlvZPmiJDmma7pgJrmoIfor4bnrKbnlKjliLDlsLHnrpfvvIhgdHlwZW9mIGNjYOOAgWAhIWNjYOOAgWBpZiAoZWFjaE5vZGUpYOKApu+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOW8uuWIpOaNruS4jeWkn++8muWunua1i+mCo+auteaKiuaooeWei+WdkeS6hiAxMCDmraXnmoTku6PnoIHnoa7lrp7mmK8gYGNjLkxheWVycy5FbnVtLlVJXzJEYO+8iOW8uuWIpOaNruiDveWRveS4re+8ie+8jFxuICog5L2G44CM5peB6L655LiA5Y+lIGByZXR1cm4geyBjY0xvYWRlZDogISFjYyB9YOOAjei/meenjeWGmeazleWQjOagt+ihqOaYjuOAjOaIkeimgeeahOaYr+WcuuaZr+OAje+8jFxuICog6ICM5a6D5pei5rKh5pyJIGBjYy5g44CB5Lmf5rKh5pyJIGBub2RlQnlQYXRoKGDjgILlvLHliKTmja7lj6rlnKgqKuayoeaciee8lui+keWZqOW8uuWIpOaNrioq5pe25omN55Sf5pWI77yMXG4gKiDmiYDku6UgYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywg4oCmKWAg6YKj56eN5Luj56CB5LiN5Lya6KKr5oqi6LWw44CCXG4gKi9cbmNvbnN0IFdFQUtfU0NFTkVfTkFNRVMgPVxuICAgIC9cXGIoY2N8Y29jb3N8ZGlyZWN0b3J8bm9kZUJ5UGF0aHxub2RlQnlVdWlkfGVhY2hOb2RlfGNvbnRlbnRDaGlsZHJlbnxpc0VkaXRvck5vZGV8d29ybGRSZWN0fGxvYWRGcmFtZXxjYXB0dXJlVmlld3xwaWNrfGxhYmVsRml0fHNuYXBzaG90VHJlZXxkaWZmVHJlZSlcXGIvO1xuXG4vKiog5ZG95Lit5riF5Y2V6YeM55qE5ZOq5Yeg5Liq77yI57uZ5Zue5omn6YeM55qE5Lq66K+d6K+05piO55So77yJ44CCICovXG5mdW5jdGlvbiBtYXJrZXJzT2YoY29kZTogc3RyaW5nLCBtYXJrZXJzOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+KTogc3RyaW5nW10ge1xuICAgIGNvbnN0IGhpdDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICAgIGlmIChtYXJrZXIucGF0dGVybi50ZXN0KGNvZGUpICYmIGhpdC5pbmRleE9mKG1hcmtlci5uYW1lKSA8IDApIGhpdC5wdXNoKG1hcmtlci5uYW1lKTtcbiAgICB9XG4gICAgcmV0dXJuIGhpdDtcbn1cblxuLyoqXG4gKiDmjqjmlq0gYGNvbnRleHRg77yI5Y+q5Zyo6LCD55So5pa5KirmsqHnu5kqKueahOaXtuWAmeeUqO+8ieOAglxuICpcbiAqIOWbm+e6p++8jOWFiOW8uuWQjuW8se+8mlxuICogMS4g5by65Zy65pmv5Yik5o2u77yIYGNjLmAgLyBgbm9kZUJ5UGF0aChgIC8gYHRyZWUoYCDigKbvvInihpIgc2NlbmXvvJtcbiAqIDIuIOW8uue8lui+keWZqOWIpOaNru+8iGBFZGl0b3IuYCAvIGBwcm9qZWN0UGF0aCgpYCDigKbvvInihpIgZWRpdG9y77ybXG4gKiAzLiDlvLHlnLrmma/liKTmja7vvIjoo7jmoIfor4bnrKYgYGNjYCAvIGBlYWNoTm9kZWAg4oCm77yJ4oaSIHNjZW5l77ybXG4gKiA0LiDpg73msqHmnIkg4oaSIGVkaXRvcu+8iCoq5peg5Ymv5L2c55SoKirnmoTpgqPkuIDkvqfvvJror7vnm5gv5p+l5bqT5LiN5Lya5Yqo55So5oi355qE5Zy65pmv77yJ44CCXG4gKlxuICogQHBhcmFtIGNvZGUgLSDnlKjmiLfku6PnoIHjgIJcbiAqIEByZXR1cm5zIGB7Y29udGV4dCwgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzfWDvvJtgbWFya2Vyc2Ag6Z2e56m66KGo56S644CM5o6o5pat5pyJ5L6d5o2u44CN44CCXG4gKi9cbmZ1bmN0aW9uIGluZmVyQ29udGV4dChjb2RlOiBzdHJpbmcpOiB7XG4gICAgY29udGV4dDogQ29kZUNvbnRleHQ7XG4gICAgc2NlbmVNYXJrZXJzOiBzdHJpbmdbXTtcbiAgICBlZGl0b3JNYXJrZXJzOiBzdHJpbmdbXTtcbn0ge1xuICAgIGNvbnN0IHNjZW5lTWFya2VycyA9IG1hcmtlcnNPZihjb2RlLCBTQ0VORV9PTkxZX01BUktFUlMpO1xuICAgIGNvbnN0IGVkaXRvck1hcmtlcnMgPSBtYXJrZXJzT2YoY29kZSwgRURJVE9SX09OTFlfTUFSS0VSUyk7XG4gICAgaWYgKHNjZW5lTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnMsIGVkaXRvck1hcmtlcnMgfTtcbiAgICBpZiAoZWRpdG9yTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG4gICAgaWYgKFdFQUtfU0NFTkVfTkFNRVMudGVzdChjb2RlKSkge1xuICAgICAgICByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnM6IFsnY2MgLyDlnLrmma/liqnmiYvvvIjoo7jmoIfor4bnrKbvvIknXSwgZWRpdG9yTWFya2VycyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG59XG5cbi8qKlxuICog5oqK44CM5LiK5LiL5paH6YCJ6ZSZ44CN6L+Z57G76ZSZ6K+v57+76K+R5oiQKirlj6/miafooYznmoTkuIDlj6Xor50qKuOAglxuICpcbiAqIGBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRgIOacrOi6q+ayoemUme+8jOmUmeeahOaYr+S4gOeCuee6v+e0oumDveS4jee7mSDigJTigJRcbiAqIOaooeWei+mdouWvueWug+WPquS8muWOu+WBmuWvueeFp+WunumqjO+8iOingSB7QGxpbmsgU0NFTkVfT05MWV9NQVJLRVJTfSDph4znmoTlrp7mtYvku6Pku7fvvInjgIJcbiAqIOi/memHjOaKiuW3suefpeeahOWHoOS4quijuOagh+ivhuespuiupOWHuuadpe+8jOebtOaOpeivtOa4heOAjOS9oOi3keWcqOWTquS4quS4iuS4i+aWh+OAgeivpeaUueaIkOS7gOS5iOOAjeOAglxuICpcbiAqIEBwYXJhbSBlcnJvciAtIOaymeeusemUmeivr+S/oeaBr+OAglxuICogQHBhcmFtIGNvbnRleHQgLSDlrp7pmYXot5HlnKjlk6rkuKrkuIrkuIvmlofjgIJcbiAqIEByZXR1cm5zIOe/u+ivkeWQjueahOmUmeivr+S/oeaBr+OAglxuICovXG5mdW5jdGlvbiBleHBsYWluRXJyb3IoZXJyb3I6IHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfSwgY29udGV4dDogQ29kZUNvbnRleHQpOiB7IG5hbWU6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICAgIGlmIChlcnJvci5uYW1lICE9PSAnUmVmZXJlbmNlRXJyb3InKSByZXR1cm4gZXJyb3I7XG4gICAgY29uc3QgbWlzc2VkID0gL14oPzxpZD5bQS1aYS16XyRdW1xcdyRdKikgaXMgbm90IGRlZmluZWQkLy5leGVjKGVycm9yLm1lc3NhZ2UudHJpbSgpKT8uZ3JvdXBzPy5pZCA/PyAnJztcbiAgICBpZiAoIW1pc3NlZCkgcmV0dXJuIGVycm9yO1xuXG4gICAgY29uc3Qgc2NlbmVHbG9iYWxzID0gWydjYycsICdjb2NvcycsICdkaXJlY3RvcicsICdzY2VuZScsICdqcycsICdub2RlQnlQYXRoJywgJ25vZGVCeVV1aWQnLCAnZWFjaE5vZGUnLCAnY29udGVudENoaWxkcmVuJywgJ2lzRWRpdG9yTm9kZScsICd0cmVlJywgJ2R1bXAnLCAnY2FwdHVyZVZpZXcnLCAnZmluZCddO1xuICAgIGNvbnN0IGVkaXRvckdsb2JhbHMgPSBbJ0VkaXRvcicsICdyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJywgJ19fZGlybmFtZScsICdfX2ZpbGVuYW1lJywgJ2ZzJywgJ3BhdGgnLCAnb3MnLCAnQnVmZmVyJywgJ3Byb2plY3RQYXRoJywgJ3Jlc29sdmVQcm9qZWN0UGF0aCcsICdsaXN0RGlyJywgJ3JlYWRKc29uJywgJ2V4dGVuc2lvblJvb3QnXTtcblxuICAgIGlmIChjb250ZXh0ID09PSAnZWRpdG9yJyAmJiBzY2VuZUdsb2JhbHMuaW5kZXhPZihtaXNzZWQpID49IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IGVycm9yLm5hbWUsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICAgIGAke2Vycm9yLm1lc3NhZ2V9XFxuYCArXG4gICAgICAgICAgICAgICAgYOKGkSDjgIwke21pc3NlZH3jgI3mmK8qKuWcuuaZr+S4iuS4i+aWhyoq5omN5pyJ55qE77yI6L+Z5qyh6LeR5ZyoIGVkaXRvciDmspnnrrHph4zvvIzpgqPph4zlj6rmnIkgRWRpdG9yIC8gcmVxdWlyZSAvIGZz77yJ44CCXFxuYCArXG4gICAgICAgICAgICAgICAgYOaUueazle+8mmNvY29zX2V4ZWN1dGVfY29kZSh7IGNvbnRleHQ6ICdzY2VuZScsIGNvZGU6IOKApiB9KeOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDkuIvmrKHkuZ/lj6/ku6Xlj6rlhpkgY29udGV4dO+8jOS4pOi+uemAmueUqO+8muaUueiKgueCuS/nu4Tku7Yg4oaSICdzY2VuZSfvvJvotYTmupDlupMv5bel56iL6K6+572uL+ivu+ebmCDihpIgJ2VkaXRvcifjgIJgLFxuICAgICAgICB9O1xuICAgIH1cbiAgICBpZiAoY29udGV4dCA9PT0gJ3NjZW5lJyAmJiBlZGl0b3JHbG9iYWxzLmluZGV4T2YobWlzc2VkKSA+PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBlcnJvci5uYW1lLFxuICAgICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgICAgICBgJHtlcnJvci5tZXNzYWdlfVxcbmAgK1xuICAgICAgICAgICAgICAgIGDihpEg44CMJHttaXNzZWR944CN5pivKirnvJbovpHlmajkuLvov5vnqIsqKuaJjeacieeahO+8iOi/measoei3keWcqOWcuuaZr+i/m+eoi+mHjO+8ieOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDmlLnms5XvvJpjb2Nvc19leGVjdXRlX2NvZGUoeyBjb250ZXh0OiAnZWRpdG9yJywgY29kZTog4oCmIH0pIOKAlOKAlCDotYTmupDlupPvvIhhc3NldC1kYu+8ieOAgeW3peeoi+iuvue9ruOAgeaehOW7uumDvei1sOWug+OAgmAsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiBlcnJvcjtcbn1cblxuLyoqIGBjb2Nvc19leGVjdXRlX2NvZGVgIOeahOWunueOsO+8muS4gOasoeaJp+ihjOmHjOWujOaIkOOAjOWPluaVsOaNriDihpIg5pS554q25oCBIOKGkiDov5Tlm57nu5PorrrjgI3jgIIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlQ29kZShwYXJhbXM6IEV4ZWN1dGVDb2RlUGFyYW1zKTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBjb25zdCBjb2RlID0gdHlwZW9mIHBhcmFtcy5jb2RlID09PSAnc3RyaW5nJyA/IHBhcmFtcy5jb2RlIDogJyc7XG4gICAgaWYgKCFjb2RlLnRyaW0oKSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6ICdleGVjdXRlX2NvZGXvvJpjb2RlIOaYr+epuueahOOAgicsIGVycm9yOiAnY29kZSDkuI3og73kuLrnqbonIH07XG4gICAgfVxuXG4gICAgY29uc3QgdGltZW91dE1zID0gY2xhbXBUaW1lb3V0KHBhcmFtcy50aW1lb3V0TXMsIFNBTkRCT1hfREVGQVVMVFMudGltZW91dE1zKTtcbiAgICBjb25zdCBhcmdzID1cbiAgICAgICAgcGFyYW1zLmFyZ3MgJiYgdHlwZW9mIHBhcmFtcy5hcmdzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShwYXJhbXMuYXJncylcbiAgICAgICAgICAgID8gKHBhcmFtcy5hcmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgICAgICAgOiB7fTtcblxuICAgIC8qKlxuICAgICAqIGBjb250ZXh0YCDnmoTkuInnp43mg4XlhrXvvIwqKumDveimgeivtOa4heaYr+WTquS4gOenjSoq77yaXG4gICAgICog4pGgIOaYvuW8j+e7meS6hiDihpIg54Wn5YGa77yI5ZCO6Z2i5Ye66ZSZ5pe25oyJ6L+Z5Liq5LiK5LiL5paH57+76K+R6ZSZ6K+v77yJ77ybXG4gICAgICog4pGhIOayoee7mSDihpIg5oyJ5Luj56CB6YeM55qE5qCH6K+G56ym5o6o5pat77yM5bm25Zyo5Zue5omn6YeM5rOo5piOIGBjb250ZXh0SW5mZXJyZWQ6IHRydWVgXG4gICAgICogICAg77yI5oKE5oKE5pu/5qih5Z6L5YGa5Yaz5a6a5L2G5LiN5ZGK6K+J5a6D77yM5LiL5qyh5a6D6L+Y5piv5Lya5ryP5YaZ77yJ77ybXG4gICAgICog4pGiIOaOqOaWreS5n+S4jeaIkOeriyDihpIgZWRpdG9y77yI5peg5Ymv5L2c55So55qE6YKj5Liq77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgZXhwbGljaXQ6IENvZGVDb250ZXh0IHwgbnVsbCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6IHBhcmFtcy5jb250ZXh0ID09PSAnZWRpdG9yJyA/ICdlZGl0b3InIDogbnVsbDtcbiAgICBjb25zdCBpbmZlcnJlZCA9IGV4cGxpY2l0ID09PSBudWxsID8gaW5mZXJDb250ZXh0KGNvZGUpIDogbnVsbDtcbiAgICBjb25zdCBjb250ZXh0OiBDb2RlQ29udGV4dCA9IGV4cGxpY2l0ID8/IGluZmVycmVkIS5jb250ZXh0O1xuXG4gICAgY29uc3QgcmVwbHkgPVxuICAgICAgICBjb250ZXh0ID09PSAnc2NlbmUnXG4gICAgICAgICAgICA/IGF3YWl0IHJ1blNjZW5lQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMsIHBhcmFtcy5zbmFwc2hvdCA9PT0gdHJ1ZSlcbiAgICAgICAgICAgIDogYXdhaXQgcnVuRWRpdG9yQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMpO1xuXG4gICAgLyoqXG4gICAgICog5rKh57uZIGNvbnRleHQg55qE6YKj5qyh77ya5oqK44CM5oiR5pu/5L2g6YCJ5LqG5ZOq5Liq44CB5Yet5LuA5LmI44CN5YaZ6L+b5Zue5omn44CCXG4gICAgICpcbiAgICAgKiDlhpnlnKgqKuS/oeWwgSoq77yIYGRhdGFg77yJ6YeM6ICM5LiN5piv5Y+q5YaZ5Zyo5paH5pys6YeM77yM5piv5Li65LqGIGB1bndyYXBTYW5kYm94UmVzdWx0YCDkuYvlpJbnmoTosIPnlKjmlrlcbiAgICAgKiDvvIjpnaLmnb/jgIHml6Xlv5fvvInkuZ/nnIvlvpfliLDvvJvmlofmnKzph4zlkIzmoLfkvJrlh7rnjrAg4oCU4oCUIOaooeWei+WPquivu+aWh+acrOOAglxuICAgICAqL1xuICAgIGlmIChpbmZlcnJlZCkge1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHJlcGx5LmRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChlbnZlbG9wZSkge1xuICAgICAgICAgICAgZW52ZWxvcGUuY29udGV4dEluZmVycmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IHdoeSA9XG4gICAgICAgICAgICAgICAgY29udGV4dCA9PT0gJ3NjZW5lJ1xuICAgICAgICAgICAgICAgICAgICA/IGDku6PnoIHph4zlh7rnjrDkuoYgJHtpbmZlcnJlZC5zY2VuZU1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICA6IGluZmVycmVkLmVkaXRvck1hcmtlcnMubGVuZ3RoID4gMFxuICAgICAgICAgICAgICAgICAgICAgID8gYOS7o+eggemHjOWHuueOsOS6hiAke2luZmVycmVkLmVkaXRvck1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICAgIDogJ+S7o+eggemHjOayoeacieWPquWxnuS6juafkOS4gOS+p+eahOagh+ivhuespic7XG4gICAgICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGDmsqHnu5kgY29udGV4dO+8jOaMieOAjCR7d2h5feOAjeaOqOaWreS4uiAnJHtjb250ZXh0fSfvvIjkuIvmrKHor7fmmL7lvI/kvKAgY29udGV4dO+8iWApO1xuICAgICAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgcmVwbHkudGV4dCA9PT0gJ3N0cmluZycgPyByZXBseS50ZXh0IDogJyc7XG4gICAgICAgICAgICByZXBseS50ZXh0ID0gdGV4dC5yZXBsYWNlKC9cXG4kLywgYFxcbi8vIGNvbnRleHQg5pyq57uZ77yM5oyJ44CMJHt3aHl944CN5o6o5pat5Li6ICcke2NvbnRleHR9J1xcbmApO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXBseTtcbn1cblxuLyoqIOWcuuaZr+S+p+aIquWbvuWKqeaJi+WbuuWumui1sOi/meS4gOihjO+8iOecn+ato+eahOWunueOsOWcqCBzb3VyY2Uvc2NlbmUudHMg55qEIGBjYXB0dXJlVmlld2Ag6YeM77yJ44CCICovXG5jb25zdCBDQVBUVVJFX1ZJRVdfU0NFTkVfQ09ERSA9ICdyZXR1cm4gYXdhaXQgY2FwdHVyZVZpZXcoYXJncyk7JztcblxuLyoqIOaIquWbvum7mOiupOiQveebmOebruW9le+8muezu+e7n+S4tOaXtuebruW9le+8jOS4juWFt+S9k+W3peeoi+aXoOWFs+OAgiAqL1xuZnVuY3Rpb24gZGVmYXVsdENhcHR1cmVQYXRoKGZvcm1hdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBkaXIgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksICdkc2gtY29jb3MtY2FwdHVyZXMnKTtcbiAgICBjb25zdCBzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csICctJyk7XG4gICAgcmV0dXJuIHBhdGguam9pbihkaXIsIGBzY2VuZS12aWV3LSR7c3RhbXB9LiR7Zm9ybWF0ID09PSAnanBlZycgPyAnanBnJyA6ICdwbmcnfWApO1xufVxuXG4vKiog5oiq5Zu+5aSx6LSl5pe255qE57uf5LiA5Zue5omn77yI5LiN5oqb77yM6K6p5qih5Z6L55yL5Yiw5Y+v6K+755qE5Y6f5Zug77yJ44CCICovXG5mdW5jdGlvbiBjYXB0dXJlRmFpbChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUb29sUmVwbHkge1xuICAgIGNvbnN0IHBheWxvYWQgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UsIC4uLihleHRyYSA/PyB7fSkgfTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBlcnJvcjogbWVzc2FnZSwgZGF0YTogcGF5bG9hZCB9O1xufVxuXG4vKiog5ou/5Yiw5Zu+5LmL5ZCO55qE5qCH5YeG5LiL5LiA5Y+l44CCICovXG5jb25zdCBDQVBUVVJFX1JFQURfSElOVCA9ICfnlKjlm77niYfor7vlj5bog73lipvmiZPlvIAgcGF0aCDnnIvkuIDnnLznlLvpnaLvvIzlho3lhrPlrprkuIvkuIDmraXjgIInO1xuXG4vKipcbiAqIOepuuWbvuaXtioq5b+F6aG757uZ6YCA6LevKirvvIjkuI3mmK9cIuWGjeivleS4gOasoVwi77yJ44CCXG4gKlxuICog5Y6G5Y+y77yIMjAyNi0wOS0zMCAwNDoyMyDkvJror53vvInvvJpgY2FwdHVyZV92aWV3YCDogIHogIHlrp7lrp7lm57kuoYgYGJsYW5rUmF0aW86IDFg77yMXG4gKiDkvYblj6rphY3kuobkuIDlj6XjgIzmjqXov5EgMSDor7TmmI7ln7rmnKzmmK/nqbrlm77jgI3igJTigJQg5qih5Z6L5LqO5piv6Ieq5bex5b6A5LiL6K+V77ya6YeN6K+VIGB3YWl0TXNgIOKGklxuICogYHNlbGVjdGAvYGZvY3VzLWNhbWVyYWAg4oaSIGBjYy5SZW5kZXJUZXh0dXJlYCDnprvlsY8g4oaSIOacgOWQjueUqOiKgueCueaVsOaNriArIENhbnZhczJEIOaJi+e7mOW4g+WxgOWvueeFp+Wbvu+8jFxuICogKirmlbTmlbQgMTYg5q2lKirjgILov5nkuKrlnZHnjrDlnKjnlLEgRWxlY3Ryb24g6YCa6YGT5LuO5qC55LiK5aC15L2P77yI6KeBIGBjYXB0dXJlLnRzYCDlpLTpg6jvvInvvIxcbiAqIOS9huecn+WIsOi/meS4gOatpeivtOaYjioq6L+e5ZCI5oiQ5ZCO55qEIHN1cmZhY2Ug6YO95piv56m655qEKiog4oCU4oCUIOmCo+aXtuabtOS4jeivpemHjeivleOAglxuICovXG5jb25zdCBDQVBUVVJFX0JMQU5LX0hJTlQgPVxuICAgICfov5nmmK/nqbrlm77vvIhibGFua1JhdGlv4omIMe+8ie+8jCoq5Yir5YaN6YeN6K+V5oiq5Zu+Kiog4oCU4oCUIOacrOaJqeWxlSoq5LiN6LCDIGBpbnZhbGlkYXRlKClgKirvvIjkuI3norDlkIjmiJDlmajvvIwnICtcbiAgICAn55CG55Sx6KeBIGBzb3VyY2UvY2FwdHVyZS50c2Ag5paH5Lu25aS05LiOIGBkb2NzL+WGu+e7k+iviuaWrS5tZGDvvInvvIwnICtcbiAgICAn5o2iIHdhaXRNcyAvIOmHjeaWsOiBmueEpiAvIOaNoiBtYXhXaWR0aCDpg73kuI3kvJrlj5jjgILlhYjnnIsgYHZpZXdgIOWGjeWGs+Wumu+8jOaMiemhuuW6j+WBmu+8micgK1xuICAgICfikaAgYHZpZXcudmlzaWJsZU1hdGNoZXNEZXNpZ24gPT09IGZhbHNlYO+8mue8lui+keWZqOWcuuaZr+inhuWbvueahCoq6K6+5aSH5qih5ouf6KKr5pS56L+HKirvvIjljoblj7LkuIrmmK/mnInkurrosIPkuoYgYGNjLnZpZXcuc2V0RGVzaWduUmVzb2x1dGlvblNpemVg77yJ4oCU4oCUIOWcqOWcuuaZr+inhuWbvuW3peWFt+agj+mHjeaWsOmAieS4gOasoeiuvuWkh+WIhui+qOeOh+WNs+WPr+aBouWkje+8jOe6r+inhuWbvuiuvue9ruOAgeS4jeW9seWTjeWcuuaZr+S4jumihOWItuS7tuaVsOaNru+8mycgK1xuICAgICfikaEgYHZpZXcudmlzaWJsZU1hdGNoZXNEZXNpZ24gPT09IHRydWVgIOWNtOS7jeeEtuepuu+8muivtOaYjioq6L+Z5Liq546v5aKD5b2T5LiL56Gu5a6e5Y+W5LiN5Yiw55S76Z2iKirvvIjnvJbovpHlmajmnIDlsI/ljJbjgIHlnLrmma/op4blm77pnaLmnb/ooqvmipjlj6DmiJbku47mnKrmuLLmn5PvvInigJTigJQg5LiN6KaB6Ieq5bu656a75bGP5riy5p+T5Zmo77yI5Y6G5Y+y5LiK5pyJ5Lq65Li65q2k6Iqx5LqGIDE2IOatpe+8ie+8jOebtOaOpei9rOaVsOWAvOWIpOaNru+8mycgK1xuICAgICfikaIg55S76Z2i6aqM5pS25pS555SoKirmlbDlgLzliKTmja4qKu+8mmB3b3JsZFJlY3Qobm9kZSlgIOaLv+ecn+WunuS4lueVjOefqeW9oiAvIOiHquW3seeul+mHjeWPoOS4jui2iueVjCAvIOmAkOiKgueCueivuyBjb2xvcsK3Y29udGVudFNpemXvvJsnICtcbiAgICAn4pGjIOehruWunumcgOimgeiCieecvOehruiupOaXtu+8jOaMieiKgueCueecn+WunuaVsOaNruWHuuS4gOW8oOW4g+WxgOWvueeFp+Wbvu+8iOWOhuWPsuWBmuazle+8mmB3b3JsZFJlY3RgIOWvvOWHuuihjCDihpIg6ISa5pys55S7IFBORyDihpIg5Zu+54mH6K+75Y+W77yJ77yM5bm25Zyo5Lqk5LuY6YeMKirlpoLlrp7lo7DmmI7jgIznnJ/lrp7muLLmn5PmiKrlm77mnKrlrozmiJDjgI0qKuOAgic7XG5cbi8qKiBFbGVjdHJvbiDpgJrpgZPnu5nkuLvov5vnqIvlm57miafnlKjnmoTlhaXlj4LjgIIgKi9cbmludGVyZmFjZSBFbGVjdHJvbkNhcHR1cmVPcHRpb25zIHtcbiAgICBzYXZlUGF0aDogc3RyaW5nO1xuICAgIG1heFdpZHRoOiBudW1iZXI7XG4gICAgZm9ybWF0OiAncG5nJyB8ICdqcGVnJztcbiAgICBxdWFsaXR5OiBudW1iZXI7XG4gICAgLyoqIOiKgueCuSB1dWlkIOaIlui3r+W+hO+8m+epuuS4siA9IOaIquaVtOW8oOWcuuaZr+inhuWbviAqL1xuICAgIG5vZGVSZWY6IHN0cmluZztcbiAgICBwYWRkaW5nOiBudW1iZXI7XG4gICAgcHJvamVjdFBhdGg6IHN0cmluZztcbiAgICAvKiog5Y+W5pmv6KaB5rGC77yaYGF1dG9g77yI6buY6K6k77yJLyBgc2NlbmVgIC8gYG5vZGVgIC8gYG5vbmVg77yM6K+t5LmJ6KeBIHtAbGluayBjYXB0dXJlVmlld30gKi9cbiAgICBmaXQ6IEZpdE1vZGU7XG4gICAgLyoqIOOAjOaDs+imgeWTquS4gOenjeeUu+mdouOAje+8mmBhdXRvYO+8iOS4jeeuoe+8iS8gYHNjZW5lYO+8iOe8lui+keWZqOWcuuaZr++8iS8gYGdhbWVg77yI6LeR552A55qE5ri45oiP77yJ77yM6KeBIHtAbGluayBWaWV3VGFyZ2V0fSAqL1xuICAgIHZpZXc6IFZpZXdUYXJnZXQ7XG59XG5cbi8qKlxuICog5Y+W5pmv5qih5byP77yIYGNhcHR1cmVfdmlld2Ag55qEIGBmaXRgIOWPguaVsO+8ieOAglxuICpcbiAqIC0gYGF1dG9g77yI6buY6K6k77yJ77yaKirpnIDopoHml7bmiY3lj5bmma8qKuOAguaIquaVtOW8oOinhuWbvuaXtuOAjOWGheWuueayoeaLjeWFqOOAjeaIluOAjOWGheWuueWwj+W+l+eci+S4jea4heOAjeWwseWPluaZr++8m1xuICogICDmiKroioLngrnml7blj6rlnKgqKuiKgueCueayoeiiq+aLjeWFqCoq77yI6KOB5Ye65p2l5Lya57y65LiA5Z2X44CB5oiW5Y6L5qC55Zyo5Zu+5aSW77yJ5pe25Y+W5pmv44CCXG4gKiAtIGBzY2VuZWDvvJrlvLrliLbmiooqKuaVtOS4quWcuuaZr+WGheWuuSoq5qGG6L+b55S75biD5YaN5oiq44CCXG4gKiAtIGBub2RlYO+8muW8uuWItuaKiioq55uu5qCH6IqC54K5KirmoYbov5vnlLvluIPlho3miKrvvIjopoHlkIzml7bnu5kgYG5vZGVg77yJ44CCXG4gKiAtIGBub25lYO+8mioq5LiN5Yqo55u45py6KirvvIzlsLHmiKrnjrDlnKjov5nkuIDluKfvvIjogIHooYzkuLrvvJvlm57miafph4zku43kvJrlkYror4nkvaDmi43lhajmsqHmnInvvInjgIJcbiAqL1xudHlwZSBGaXRNb2RlID0gJ2F1dG8nIHwgJ3NjZW5lJyB8ICdub2RlJyB8ICdub25lJztcblxuLyoqXG4gKiDjgIzmg7PopoHlk6rkuIDnp43nlLvpnaLjgI3vvIhgY2FwdHVyZV92aWV3YCDnmoQgYHZpZXdgIOWPguaVsO+8ieOAglxuICpcbiAqIOe8lui+keWZqOmHjOmCo+Wdl+WcuuaZr+inhuWbvioq5ZCM5LiA5pe25Yi75Y+q55S75LiA5qC35Lic6KW/KirvvJrnvJbovpHmgIHnmoTnvJbovpHlmajlnLrmma/vvIzmiJbogIXov5DooYzpooTop4hcbiAqIO+8iGdhbWUgdmlld++8jOe8lui+keWZqOW3peWFt+agj+mCo+mil+aSreaUvumUru+8iei3keedgOeahCoq5ri45oiP55S76Z2iKirjgILkuKTogIXnlKjnmoTmmK8qKuS4jeWQjOeahOebuOacuioqXG4gKiDvvIjop4EgYHNvdXJjZS9zY2VuZS50c2Ag55qEIGByZWFkU2NlbmVNb2RlYO+8ie+8jOaJgOS7pVwi5oiR6KaB55qE5piv5ZOq5LiA56eNXCLlv4XpobvnlLHosIPnlKjmlrnor7TmuIXmpZog4oCU4oCUXG4gKiDlkKbliJnlm57miafph4zpgqPlvKDlm77liLDlupXmmK/lnLrmma/ov5jmmK/muLjmiI/vvIzlj6rmnInlm77oh6rlt7Hnn6XpgZPjgIJcbiAqXG4gKiAtIGBhdXRvYO+8iOm7mOiupO+8ie+8muS4jeeuoe+8jOaKk+eOsOWcqOi/meS4gOW4pyDigJTigJQg5L2G5Zue5omn6YeMKirnhafmoLcqKuS8muivtOa4heaKk+WIsOeahOaYr+WTquS4gOenje+8iGBtb2RlYO+8ieOAglxuICogLSBgc2NlbmVg77ya6KaB57yW6L6R5Zmo5Zy65pmv44CC5ou/5Yiw55qE5piv6L+Q6KGM5oCB55S76Z2i5pe25LyaKirmmI7or7TkuI3lr7kqKu+8iOS4jeWBh+ijheaIkOWKn++8ieOAglxuICogLSBgZ2FtZWDvvJropoHot5HnnYDnmoTmuLjmiI/jgIIqKui/kOihjOaAgeS4i+S4jeWGjeWPluaZr+OAgeS4jeWGjeijgeiKgueCuSoq77yI5Lik6ICF6YO95bu656uL5Zyo57yW6L6R5Zmo55u45py65LiK77yMXG4gKiAgIOiAjOmCo+aXtuWcqOa4suafk+eahOaYr+a4uOaIj+ebuOacuiDigJTigJQg5pGG5LqG5Lmf5LiN5Lya5pS55Y+Y55S76Z2i77yJ44CCXG4gKi9cbnR5cGUgVmlld1RhcmdldCA9ICdhdXRvJyB8ICdzY2VuZScgfCAnZ2FtZSc7XG5cbi8qKlxuICog6Kej5p6QIGB2aWV3YCDlj4LmlbDjgIJcbiAqXG4gKiBgJ3ByZXZpZXcnYCDmjIkgYGdhbWVgIOeQhuino++8iOivu+iAheWkmuWNiuaYr+aDs+ivtFwi6LeR6LW35p2l6YKj5Liq55S76Z2iXCLvvInvvIzkvYbkvJoqKuWkmuWGmeS4gOWPpSoq6K+05piOXG4gKiDlroPmnInkuKTnp43or7vms5Ug4oCU4oCUIOa1j+iniOWZqC/mqKHmi5/lmajpooTop4jmmK/lj6bkuIDkuKrlupTnlKjnmoTlj6bkuIDkuKrov5vnqIvvvIzmnKzmianlsZXlpJ/kuI3nnYDjgIJcbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplVmlld1RhcmdldChyYXc6IHVua25vd24pOiB7IG1vZGU6IFZpZXdUYXJnZXQ7IG5vdGU/OiBzdHJpbmcgfSB7XG4gICAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdyA9PT0gbnVsbCB8fCByYXcgPT09ICcnIHx8IHJhdyA9PT0gJ2F1dG8nKSByZXR1cm4geyBtb2RlOiAnYXV0bycgfTtcbiAgICBpZiAocmF3ID09PSAnc2NlbmUnIHx8IHJhdyA9PT0gJ2dhbWUnKSByZXR1cm4geyBtb2RlOiByYXcgfTtcbiAgICBpZiAocmF3ID09PSAncHJldmlldycpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG1vZGU6ICdnYW1lJyxcbiAgICAgICAgICAgIG5vdGU6XG4gICAgICAgICAgICAgICAgJ2B2aWV3OlwicHJldmlld1wiYCDmjIkgYGdhbWVg77yI57yW6L6R5Zmo5YaF6L+Q6KGM6aKE6KeI77yJ55CG6Kej44CC6Iul5L2g5oyH55qE5pivKirmtY/op4jlmagv5qih5ouf5Zmo6aKE6KeIKirvvIwnICtcbiAgICAgICAgICAgICAgICAn6YKj5piv57yW6L6R5Zmo5LmL5aSW55qE5Y+m5LiA5Liq5bqU55So77yM5pys5bel5YW35oiq5LiN5Yiw5a6DIOKAlOKAlCDpgqPnp43mg4XlhrXor7foh6rlt7HlnKjpgqPkuKrnqpflj6Pph4zmiKrlm77jgIInLFxuICAgICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4geyBtb2RlOiAnYXV0bycsIG5vdGU6IGB2aWV3IOWPquiupCBhdXRvL3NjZW5lL2dhbWXvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShyYXcpfe+8jOaMiSBhdXRvIOWkhOeQhmAgfTtcbn1cblxuLyoqXG4gKiBgYXV0b2Ag5qih5byP5LiL44CM5YaF5a655bCP5b6X55yL5LiN5riF44CN55qE5Yik5o2u77ya5YaF5a655LiO55S75biD5Lqk6ZuG6Z2i56ev5Y2g5q+U5L2O5LqO5a6D5bCx6aG65omL5Y+W5pmv44CCXG4gKlxuICog5Li65LuA5LmI6KaB6L+Z5LiA5p2h77ya5Y+q5Zyo44CM5rKh5ouN5YWo44CN5pe25Y+W5pmv5pivKirkuI3lpJ8qKueahCDigJTigJQg55So5oi357yp5YiwIDEwJSDnnIvlhajlsYDml7blhoXlrrkqKuehruWunuWFqOWcqOeUu+mHjCoq77yMXG4gKiDkvYbmiKrlm77ph4zpgqPkuIDlsI/lnZfmoLnmnKznnIvkuI3muIXvvIjlrp7mtYvvvJo3MjDDlzE1NjAg55qE6K6+6K6h5YiG6L6o546H57yp5YiwIDEwJe+8jOWcqOeUu+W4g+mHjOWPquaciSA3MsOXMTU277yJ44CCXG4gKiAwLjE1IOaYr+OAjOWwj+WIsOWLieW8uuiDveiupOWHuui9ruW7k+OAjeeahOmHj+e6p++8jOS4jeaYr+eyvuehrumYiOWAvO+8m+WbnuaJp+mHjOWmguWunuaKpSBgYXJlYVJhdGlvYO+8jFxuICog5oOz5oyJ5Y6f5qC35oiq5bCx5LygIGBmaXQ6J25vbmUnYOOAglxuICovXG5jb25zdCBGSVRfU01BTExfUkFUSU8gPSAwLjE1O1xuXG4vKiog5Y+W5pmv5q+P5LiA5q2l5LmL5ZCO562J5a6D6JC95a6a77yI5q+r56eS77yJ4oCU4oCUIGBmb2N1cygpYCDlj6/og73luKbooaXpl7TvvIxgaW52YWxpZGF0ZSgpYCDkuZ/opoHnrYnkuIDluKfjgIIgKi9cbmNvbnN0IEZJVF9TRVRUTEVfTVMgPSAyMDA7XG5cbi8qKiDlkIzkuIDnuqflj5bmma/mnIDlpJrph4/kuKTmrKHvvIjnrKzkuIDmrKHlj6/og73mraPotbbkuIrooaXpl7TkuK3pl7TvvInjgIIgKi9cbmNvbnN0IEZJVF9NRUFTVVJFU19QRVJfU1RFUCA9IDI7XG5cbi8qKiDlkITnuqflj5bmma/nmoTor7TmmI7vvIjlm57miafph4wgYGZyYW1pbmcubWV0aG9kYCDnlKjkurror53lho3orrLkuIDpgY3vvInjgIIgKi9cbmNvbnN0IEZJVF9NRVRIT0RfTEFCRUw6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgZm9jdXM6ICfnvJbovpHlmajoh6rlt7HnmoTogZrnhKbvvIhjY2UuQ2FtZXJhLmZvY3Vz77yJJyxcbiAgICBhZGp1c3Q6ICcyRCDmjqfliLblmajnmoTpgILphY3lhoXlrrnvvIhjb250cm9sbGVyMkQuX2FkanVzdFRvQ2VudGVy77yJJyxcbiAgICBtYW51YWw6ICfmiYvlt6XmkYbnm7jmnLrvvIjmjInph4/lh7rmnaXnmoTjgIzlg4/ntKAv5LiW55WM5Y2V5L2N44CN5pS5IG9ydGhvSGVpZ2h0IOS4juS9jee9ru+8iScsXG59O1xuXG4vKiog6Kej5p6QIGBmaXRgIOWPguaVsO+8iOS4jeiupOeahOWAvOWbniBgYXV0b2Ag5bm255WZ5LiA5Y+l6K+05piO77yJ44CCICovXG5mdW5jdGlvbiBub3JtYWxpemVGaXRNb2RlKHJhdzogdW5rbm93bik6IHsgbW9kZTogRml0TW9kZTsgbm90ZT86IHN0cmluZyB9IHtcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gJycpIHJldHVybiB7IG1vZGU6ICdhdXRvJyB9O1xuICAgIGlmIChyYXcgPT09ICdhdXRvJyB8fCByYXcgPT09ICdzY2VuZScgfHwgcmF3ID09PSAnbm9kZScgfHwgcmF3ID09PSAnbm9uZScpIHJldHVybiB7IG1vZGU6IHJhdyB9O1xuICAgIHJldHVybiB7IG1vZGU6ICdhdXRvJywgbm90ZTogYGZpdCDlj6rorqQgYXV0by9zY2VuZS9ub2RlL25vbmXvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShyYXcpfe+8jOaMiSBhdXRvIOWkhOeQhmAgfTtcbn1cblxuLyoqIOS7juS4gOasoeWHoOS9leWbnuaJp+mHjOWPluWHuuOAjOaLjeWFqOS6huayoeacieOAjemCo+WHoOmhueOAgiAqL1xuZnVuY3Rpb24gcGlja0NvdmVyYWdlKG1ldHJpY3M6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsKTogUmVjb3JkPHN0cmluZywgYW55PiB8IG51bGwge1xuICAgIGNvbnN0IGZyYW1pbmcgPSBtZXRyaWNzICYmIG1ldHJpY3MuZnJhbWluZztcbiAgICBpZiAoIWZyYW1pbmcgfHwgdHlwZW9mIGZyYW1pbmcgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb3ZlcmVkOiBmcmFtaW5nLmNvdmVyZWQgPT09IHRydWUsXG4gICAgICAgIGFyZWFSYXRpbzogZnJhbWluZy5hcmVhUmF0aW8gPz8gbnVsbCxcbiAgICAgICAgZWRnZXM6IGZyYW1pbmcuZWRnZXMgPz8gbnVsbCxcbiAgICAgICAgdGFyZ2V0UGFnZTogZnJhbWluZy50YXJnZXRQYWdlID8/IG51bGwsXG4gICAgICAgIHZpZXdwb3J0OiBmcmFtaW5nLnZpZXdwb3J0ID8/IG51bGwsXG4gICAgICAgIHRhcmdldDogZnJhbWluZy50YXJnZXQgPz8gbnVsbCxcbiAgICAgICAgbm90ZTogZnJhbWluZy5ub3RlLFxuICAgIH07XG59XG5cbi8qKlxuICog6KaB5LiN6KaB5Y+W5pmv44CCXG4gKlxuICogQHBhcmFtIG1vZGUgLSDnlKjmiLfopoHnmoTlj5bmma/mqKHlvI/jgIJcbiAqIEBwYXJhbSBiZWZvcmUgLSDlj5bmma/liY3nmoTopobnm5bmg4XlhrXvvIhgbnVsbGAgPSDph4/kuI3liLDvvIzpgqPlsLHliKvkubHliqjnm7jmnLrvvInjgIJcbiAqIEByZXR1cm5zIGBudWxsYCA9IOS4jeWPluaZr++8m+WQpuWImeaYr+imgeahhueahOebruagh+OAglxuICovXG5mdW5jdGlvbiBkZWNpZGVGaXQobW9kZTogRml0TW9kZSwgbm9kZVJlZjogc3RyaW5nLCBiZWZvcmU6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsKTogJ3NjZW5lJyB8ICdub2RlJyB8IG51bGwge1xuICAgIGlmIChtb2RlID09PSAnbm9uZScpIHJldHVybiBudWxsO1xuICAgIGlmIChtb2RlID09PSAnc2NlbmUnKSByZXR1cm4gJ3NjZW5lJztcbiAgICBpZiAobW9kZSA9PT0gJ25vZGUnKSByZXR1cm4gbm9kZVJlZiA/ICdub2RlJyA6IG51bGw7XG4gICAgLyoqIGF1dG8gKi9cbiAgICBpZiAoIWJlZm9yZSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKG5vZGVSZWYpIHtcbiAgICAgICAgLyoqIOaIquiKgueCue+8muWPquacieOAjOiKgueCueayoeiiq+aLjeWFqOOAjeaJjeWKqOebuOacuiDigJTigJQg6IqC54K55Zyo5Zu+6YeM5pe25oyJ5Y6f5qC36KOB77yM5LiN5pS555So5oi36KeG6KeSICovXG4gICAgICAgIHJldHVybiBiZWZvcmUuY292ZXJlZCA9PT0gdHJ1ZSA/IG51bGwgOiAnbm9kZSc7XG4gICAgfVxuICAgIC8qKiDmiKrmlbTlvKDop4blm77vvJrmsqHmi43lhajvvIzmiJbogIXmi43lhajkuobkvYblsI/lvpfnnIvkuI3muIUgKi9cbiAgICBjb25zdCBhcmVhID0gdHlwZW9mIGJlZm9yZS5hcmVhUmF0aW8gPT09ICdudW1iZXInID8gYmVmb3JlLmFyZWFSYXRpbyA6IDE7XG4gICAgcmV0dXJuIGJlZm9yZS5jb3ZlcmVkID09PSB0cnVlICYmIGFyZWEgPj0gRklUX1NNQUxMX1JBVElPID8gbnVsbCA6ICdzY2VuZSc7XG59XG5cbi8qKlxuICog6LeR5Y+W5pmv6ZO+77yaKirmkYbkuIDnuqcg4oaSIOmAvOS4gOW4pyDihpIg6YeP5LiA6YGNIOKGkiDpqozkuI3ov4flsLHpmY3nuqcqKuOAglxuICpcbiAqIOS4iee6p+WPluaZr++8iOe8lui+keWZqCBmb2N1cyDihpIgMkQg5o6n5Yi25Zmo6YCC6YWNIOKGkiDmiYvlt6XmkYbnm7jmnLrvvInkuI7jgIzkuLrku4DkuYjmmK/ov5nkuKrpobrluo/jgI1cbiAqIOWGmeWcqCBgc291cmNlL3NjZW5lLnRzYCDnmoTjgIzlj5bmma/jgI3kuIDoioLvvJvov5nph4zlj6rnrqHmjqjov5vkuI7orrDotKbjgIJcbiAqXG4gKiDliKTmja7mmK8qKumHj+WHuuadpeeahCoq77yIYGZyYW1pbmcuY292ZXJlZGAgPSDnm67moIfnn6nlvaLmlbTkuKrokL3lnKjnlLvluIPph4zvvInvvIzmiYDku6XkuI3lv4Xnn6XpgZNcbiAqIOe8lui+keWZqOWGhemDqOaAjuS5iOeul+eahCDigJTigJQg56ys5LiA57qn6IO95oiQ5bCx5LiN5Lya55So5Yiw56ys5LqM57qn44CCXG4gKlxuICog4pqgIOebuOacuuWKqOi/h+S5i+WQjioq5b+F6aG76YeN566X6IqC54K555+p5b2iKirvvIjnm7jmnLrlj5jkuobvvIznn6nlvaLlsLHlj5jkuobvvInvvIzmiYDku6Xov5Tlm57nmoTmnIDlkI7kuIDmrKFcbiAqIGBtZXRyaWNzYCDkuIDlrpropoHmi7/lm57ljrvnlKjvvIzkuI3og73lho3nlKjlj5bmma/liY3pgqPku73jgIJcbiAqXG4gKiBAcmV0dXJucyBge2ZyYW1pbmcsIG1ldHJpY3MsIGZpdE5vdGV9YOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBydW5GaXRDaGFpbihcbiAgICBraW5kOiAnc2NlbmUnIHwgJ25vZGUnLFxuICAgIG5vZGVSZWY6IHN0cmluZyxcbiAgICBwcm9qZWN0UGF0aDogc3RyaW5nLFxuICAgIGZpcnN0TWV0cmljczogUmVjb3JkPHN0cmluZywgYW55PixcbiAgICBocmVmOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgZnJhbWluZzogUmVjb3JkPHN0cmluZywgYW55PjsgbWV0cmljczogUmVjb3JkPHN0cmluZywgYW55PjsgZml0Tm90ZT86IHN0cmluZyB9PiB7XG4gICAgY29uc3QgZnJhbWluZzogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICAgICAgYXBwbGllZDoga2luZCxcbiAgICAgICAgbWV0aG9kOiBudWxsLFxuICAgICAgICBzdGVwOiBudWxsLFxuICAgICAgICBiZWZvcmU6IHBpY2tDb3ZlcmFnZShmaXJzdE1ldHJpY3MpLFxuICAgIH07XG4gICAgbGV0IG1ldHJpY3MgPSBmaXJzdE1ldHJpY3M7XG4gICAgbGV0IGZpdE5vdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgdG9rZW4gPSAnJztcbiAgICAvKipcbiAgICAgKiDlj6ropoEqKuWwneivlei/hyoq5Y+W5pmv5bCx6KaB6L+Y5Y6fIOKAlOKAlCDkuI3og73lj6rlnKhcIuaIkOWKn1wi5pe26L+Y5Y6f77yaXG4gICAgICog56ys5LiJ57qn5pivKirmiYvlt6XmkYbnm7jmnLoqKu+8iOWFiOWGmSBgb3J0aG9IZWlnaHRgIOWGjeaMquS9jee9ru+8ie+8jOWug+WPr+iDveWGmeS6huS4gOWNiuaJjeWksei0pVxuICAgICAqIO+8iGBtZXRob2RgIOS7jeeEtuaYryBudWxs77yJ77yM6YKj5pe255u45py65bey57uP6KKr5Yqo6L+H5LqG44CC6L+Y5Y6f5LiA5qyh5piv5bmC562J55qE77yM5aSa6L+Y5LiA5qyh5LiN5Lya5pyJ5Ymv5L2c55So44CCXG4gICAgICovXG4gICAgbGV0IGF0dGVtcHRlZCA9IGZhbHNlO1xuXG4gICAgLyoqIOS4gOasoeOAjOaRhiArIOmAvOS4gOW4pyArIOetieiQveWumiArIOmHj+OAje+8m2BzdGVwID09PSBudWxsYCDooajnpLrlj6rph43ph4/kuIDpgY3vvIjkuI3ph43mkYbvvIkgKi9cbiAgICBjb25zdCByb3VuZCA9IGFzeW5jIChzdGVwOiBudW1iZXIgfCBudWxsKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbD4gPT4ge1xuICAgICAgICBpZiAoc3RlcCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgYXR0ZW1wdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8UmVjb3JkPHN0cmluZywgYW55Pj4oU0NFTkVfTUVUSE9ELmZpdFZpZXcsIFtcbiAgICAgICAgICAgICAgICB7IGFjdGlvbjogJ2ZpdCcsIHN0ZXAsIGZpdDogeyBraW5kLCByZWY6IG5vZGVSZWYgfSwgbm9kZTogbm9kZVJlZiwgcHJvamVjdFBhdGggfSxcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgdG9rZW4gPSB0eXBlb2YgYXBwbGllZC50b2tlbiA9PT0gJ3N0cmluZycgPyBhcHBsaWVkLnRva2VuIDogdG9rZW47XG4gICAgICAgICAgICBmcmFtaW5nLnN0ZXAgPSBzdGVwO1xuICAgICAgICAgICAgZnJhbWluZy5tZXRob2QgPSBhcHBsaWVkLm1ldGhvZCA/PyBudWxsO1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQuZGV0YWlsKSBmcmFtaW5nLmRldGFpbCA9IGFwcGxpZWQuZGV0YWlsO1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQudGFyZ2V0KSBmcmFtaW5nLnRhcmdldCA9IGFwcGxpZWQudGFyZ2V0O1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQuc2F2ZWQgJiYgYXBwbGllZC5zYXZlZC5zaWduYXR1cmUpIGZyYW1pbmcuc2F2ZWRDYW1lcmEgPSBhcHBsaWVkLnNhdmVkLnNpZ25hdHVyZTtcbiAgICAgICAgICAgIGlmIChhcHBsaWVkLm1heFN0ZXApIGZyYW1pbmcubWF4U3RlcCA9IGFwcGxpZWQubWF4U3RlcDtcbiAgICAgICAgICAgIGZyYW1pbmcubmV4dFN0ZXAgPSBhcHBsaWVkLm5leHRTdGVwID8/IG51bGw7XG4gICAgICAgICAgICBpZiAoYXBwbGllZC5vayAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIGZpdE5vdGUgPSBhcHBsaWVkLm5vdGUgfHwgYXBwbGllZC5lcnJvciB8fCBg56ysICR7c3RlcH0g57qn5Y+W5pmv5rKh5YGa5oiQYDtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhcHBsaWVkLm5vdGUpIGZpdE5vdGUgPSBhcHBsaWVkLm5vdGU7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIOKblCDov5nph4zmm77nu4/mnInkuIDlj6UgYGludmFsaWRhdGVTY2VuZVZpZXcoaHJlZilg77yIXCLnm7jmnLrliqjkuobvvIzpgLzkuIDluKflho3ph49cIu+8ieOAglxuICAgICAgICAgKiAyMDI2LTEwLTA4IOS5i+WQjioq5Yig5o6J5LqGKirvvJrmnKzmianlsZXkuIDmrKEgYGludmFsaWRhdGUoKWAg6YO95LiN6LCD77yI6KeBIGBzb3VyY2UvY2FwdHVyZS50c2Ag5paH5Lu25aS077yJ44CCXG4gICAgICAgICAqIOS7o+S7t+WmguWunuivtO+8muebuOacuuWImuWKqOWujOWwsemHj++8jOivu+WIsOeahCoq5Y+v6IO95piv6YeN55S75YmN55qE6YKj5LiA5binKiog4oCU4oCUXG4gICAgICAgICAqIOaJgOS7peS4i+mdoui/meS4gOmHj+S4juS4u+i/m+eoi+S+p+eahOWPluaZr+mTvuS8mioq5aSa6YeP5Yeg6L2uKirvvIzogIzkuI3mmK/pnaDpgLzkuIDluKfmnaVcIuS/neivgeaWsOmynFwi44CCXG4gICAgICAgICAqL1xuICAgICAgICBhd2FpdCBzbGVlcChGSVRfU0VUVExFX01TKTtcbiAgICAgICAgY29uc3QgbWVhc3VyZWQgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8UmVjb3JkPHN0cmluZywgYW55Pj4oU0NFTkVfTUVUSE9ELnZpZXdNZXRyaWNzLCBbXG4gICAgICAgICAgICB7IG5vZGU6IG5vZGVSZWYgfHwgdW5kZWZpbmVkLCBmaXQ6IHsga2luZCwgcmVmOiBub2RlUmVmIH0sIHByb2plY3RQYXRoIH0sXG4gICAgICAgIF0pO1xuICAgICAgICBpZiAobWVhc3VyZWQgJiYgbWVhc3VyZWQub2sgPT09IHRydWUpIG1ldHJpY3MgPSBtZWFzdXJlZDtcbiAgICAgICAgcmV0dXJuIG1ldHJpY3M7XG4gICAgfTtcblxuICAgIGxldCBjb3ZlcmVkID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgICAgZm9yIChsZXQgc3RlcCA9IDA7IHN0ZXAgPCAzOyBzdGVwICs9IDEpIHtcbiAgICAgICAgICAgIGxldCBhcHBsaWVkT2sgPSBmYWxzZTtcbiAgICAgICAgICAgIGZvciAobGV0IG1lYXN1cmUgPSAwOyBtZWFzdXJlIDwgRklUX01FQVNVUkVTX1BFUl9TVEVQOyBtZWFzdXJlICs9IDEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZWFzdXJlZCA9IGF3YWl0IHJvdW5kKG1lYXN1cmUgPT09IDAgPyBzdGVwIDogbnVsbCk7XG4gICAgICAgICAgICAgICAgaWYgKCFtZWFzdXJlZCkgYnJlYWs7XG4gICAgICAgICAgICAgICAgYXBwbGllZE9rID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb3ZlcmVkID0gQm9vbGVhbihtZWFzdXJlZC5mcmFtaW5nICYmIG1lYXN1cmVkLmZyYW1pbmcuY292ZXJlZCA9PT0gdHJ1ZSk7XG4gICAgICAgICAgICAgICAgaWYgKGNvdmVyZWQpIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNvdmVyZWQgfHwgIWFwcGxpZWRPaykgYnJlYWs7XG4gICAgICAgICAgICBpZiAoZnJhbWluZy5uZXh0U3RlcCA9PT0gbnVsbCB8fCBmcmFtaW5nLm5leHRTdGVwID09PSB1bmRlZmluZWQpIGJyZWFrO1xuICAgICAgICB9XG5cbiAgICAgICAgZnJhbWluZy5tZXRob2RMYWJlbCA9IGZyYW1pbmcubWV0aG9kID8gRklUX01FVEhPRF9MQUJFTFtmcmFtaW5nLm1ldGhvZF0gfHwgZnJhbWluZy5tZXRob2QgOiBudWxsO1xuICAgICAgICBmcmFtaW5nLmFmdGVyID0gcGlja0NvdmVyYWdlKG1ldHJpY3MpO1xuICAgICAgICBpZiAoZml0Tm90ZSkgZnJhbWluZy5ub3RlID0gZml0Tm90ZTtcbiAgICAgICAgaWYgKCFjb3ZlcmVkKSB7XG4gICAgICAgICAgICBjb25zdCBwcmVmaXggPSBmcmFtaW5nLm5vdGUgPyBgJHtmcmFtaW5nLm5vdGV977ybYCA6ICcnO1xuICAgICAgICAgICAgZnJhbWluZy5ub3RlID0gYCR7cHJlZml4feKaoCDlj5bmma/msqHog73miornm67moIfmlbTkuKroo4Xov5vnlLvluIPvvIgke1xuICAgICAgICAgICAgICAgIGZyYW1pbmcubWV0aG9kID8gRklUX01FVEhPRF9MQUJFTFtmcmFtaW5nLm1ldGhvZF0gfHwgZnJhbWluZy5tZXRob2QgOiAn5rKh5pyJ5Y+v55So55qE5Y+W5pmv5omL5q61J1xuICAgICAgICAgICAgfe+8ieKAlOKAlCDov5nlvKDlm74qKuWPr+iDveS7jeeEtuS4jeaYr+WFqOaZryoqYDtcbiAgICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDov5jljp/op4bop5LvvJoqKuWPquimgeWKqOi/h++8iOaIluWPr+iDveWKqOi/h++8ieebuOacuuWwseS4gOWumuimgei/mCoq77yI55So5oi36KeG6KeS5LiN6K+l6KKr5oiR5Lus55WZ5Zyo5Yir5aSE77yJ44CCXG4gICAgICAgICAqIOaUvuWcqCBgZmluYWxseWAg6YeMIOKAlOKAlCDlj5bmma/pgJTkuK3lh7rku7vkvZXlspTlrZDvvIhJUEMg5pat5LqG44CB5Zy65pmv6ISa5pys5oqb5LqG44CB5YaZ55u45py65YaZ5LqG5LiA5Y2K77yJ5Lmf6KaB6L+Y44CCXG4gICAgICAgICAqL1xuICAgICAgICBpZiAoYXR0ZW1wdGVkKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3RvcmVkID0gYXdhaXQgY2FsbFNjZW5lU2NyaXB0PFJlY29yZDxzdHJpbmcsIGFueT4+KFNDRU5FX01FVEhPRC5maXRWaWV3LCBbXG4gICAgICAgICAgICAgICAgICAgIHsgYWN0aW9uOiAnZW5kJywgdG9rZW4gfSxcbiAgICAgICAgICAgICAgICBdKTtcbiAgICAgICAgICAgICAgICAvKiog44CM5Y6L5qC55rKh5a2Y6L+H6KeG6KeS44CN77yI5Y+W5pmv6L+e56ys5LiA5q2l6YO95rKh6LWw5Yiw77yJ5LiN566X5aSx6LSlIOKAlOKAlCDnm7jmnLrmnKzmnaXkuZ/msqHliqggKi9cbiAgICAgICAgICAgICAgICBjb25zdCBub3RoaW5nVG9SZXN0b3JlID0gcmVzdG9yZWQgJiYgcmVzdG9yZWQub2sgPT09IGZhbHNlICYmIC/msqHmnInlvoXov5jljp/nmoTop4bop5IvLnRlc3QoU3RyaW5nKHJlc3RvcmVkLmVycm9yIHx8ICcnKSk7XG4gICAgICAgICAgICAgICAgZnJhbWluZy5yZXN0b3JlZCA9IG5vdGhpbmdUb1Jlc3RvcmUgPyBudWxsIDogcmVzdG9yZWQgJiYgcmVzdG9yZWQucmVzdG9yZWQgPT09IHRydWU7XG4gICAgICAgICAgICAgICAgZnJhbWluZy5yZXN0b3JlTWV0aG9kID0gKHJlc3RvcmVkICYmIHJlc3RvcmVkLm1ldGhvZCkgfHwgbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAocmVzdG9yZWQgJiYgcmVzdG9yZWQuYWZ0ZXIpIGZyYW1pbmcuY2FtZXJhQWZ0ZXJSZXN0b3JlID0gcmVzdG9yZWQuYWZ0ZXI7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3RvcmVkICYmIHJlc3RvcmVkLm5vdGUpIGZyYW1pbmcucmVzdG9yZU5vdGUgPSByZXN0b3JlZC5ub3RlO1xuICAgICAgICAgICAgICAgIGlmIChub3RoaW5nVG9SZXN0b3JlKSBmcmFtaW5nLnJlc3RvcmVOb3RlID0gJ+ayoeacieWtmOi/h+inhuinku+8iOWPluaZr+ayoei1sOWIsOS8muWKqOebuOacuueahOmCo+S4gOatpe+8ie+8jOebuOacuuayoeWKqCc7XG4gICAgICAgICAgICAgICAgaWYgKGZyYW1pbmcucmVzdG9yZWQgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHByZWZpeCA9IGZyYW1pbmcubm90ZSA/IGAke2ZyYW1pbmcubm90ZX3vvJtgIDogJyc7XG4gICAgICAgICAgICAgICAgICAgIGZyYW1pbmcubm90ZSA9IGAke3ByZWZpeH3imqAgKirop4bop5LmsqHmnInov5jljp/miJDlip8qKiDigJTigJQg57yW6L6R5Zmo5Zy65pmv6KeG5Zu+546w5Zyo5YGc5Zyo5Y+W5pmv5ZCO55qE5L2N572u77yI5oyJIEYgLyDlj4zlh7voioLngrnlj6/ku6Xlm57ljrvvvIlgO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGZyYW1pbmcucmVzdG9yZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBmcmFtaW5nLnJlc3RvcmVOb3RlID0gZGVzY3JpYmUoZXJyKTtcbiAgICAgICAgICAgICAgICBjb25zdCBwcmVmaXggPSBmcmFtaW5nLm5vdGUgPyBgJHtmcmFtaW5nLm5vdGV977ybYCA6ICcnO1xuICAgICAgICAgICAgICAgIGZyYW1pbmcubm90ZSA9IGAke3ByZWZpeH3imqAg6L+Y5Y6f6KeG6KeS5pe25Ye66ZSZ77yaJHtkZXNjcmliZShlcnIpfe+8iOWcuuaZr+inhuWbvuWPr+iDveWBnOWcqOWPluaZr+WQjueahOS9jee9ru+8iWA7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4geyBmcmFtaW5nLCBtZXRyaWNzLCBmaXROb3RlIH07XG59XG5cbi8qKlxuICogKipFbGVjdHJvbiDpgJrpgZMqKu+8muS4u+i/m+eoi+iHquW3seaKiuWcuuaZr+inhuWbvuaKk+S4i+adpeOAglxuICpcbiAqIOS4uuS7gOS5iOS4u+i/m+eoi+iDveaKk++8mue8lui+keWZqOWwseaYryBFbGVjdHJvbu+8jOacrOaJqeWxleeahCBgbWFpbmAg6LeR5Zyo5Li76L+b56iL6YeM77yMXG4gKiDogIzlnLrmma/op4blm77mmK/kuIDkuKogYDx3ZWJ2aWV3PmAg6aG177yIYGJ1aWx0aW4vc2NlbmUvc3RhdGljL3RlbXBsYXRlLzNkLXdlYnZpZXcuaHRtbGDvvInigJTigJRcbiAqIGB3ZWJDb250ZW50cy5nZXRBbGxXZWJDb250ZW50cygpYCDkvJrmiorlroPliJflh7rmnaXvvIxgY2FwdHVyZVBhZ2UoKWAg5oqT55qE5pivXG4gKiAqKuWQiOaIkOWQjueahCBzdXJmYWNlKirvvIjkuI3lj5cgYHByZXNlcnZlRHJhd2luZ0J1ZmZlcjogZmFsc2VgIOW9seWTje+8ieOAglxuICog57uG6IqC5LiO5Z2Q5qCH5Y+j5b6E6KeBIGBzb3VyY2UvY2FwdHVyZS50c2DjgIJcbiAqXG4gKiDlnLrmma/ohJrmnKzlnKjov5nph4zlubLkuKTku7bkuovvvJoqKumHjyoq77yIYHZpZXdNZXRyaWNzYO+8mumhtemdoiBocmVmIC8g55S75biD5Yeg5L2VIC8g6IqC54K555+p5b2iIC9cbiAqIOaLjeWFqOS6huayoeacie+8ieS4jioq5pGG55u45py6KirvvIhgZml0Vmlld2DvvJrlj5bmma8gLyDov5jljp/op4bop5LvvIzop4Ege0BsaW5rIHJ1bkZpdENoYWlufe+8ieOAglxuICpcbiAqIEByZXR1cm5zIOaIkOWKny/lpLHotKXpg73lm54gYHtyZXBseX1g77ybKiror6XpgIDlm57ogIHot6/ml7YqKuWbniBge2ZhbGxiYWNrOiDljp/lm6B9YOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBjYXB0dXJlVmlld1ZpYUVsZWN0cm9uKFxuICAgIG9wdGlvbnM6IEVsZWN0cm9uQ2FwdHVyZU9wdGlvbnMsXG4pOiBQcm9taXNlPHsgcmVwbHk6IFRvb2xSZXBseSB9IHwgeyBmYWxsYmFjazogc3RyaW5nIH0+IHtcbiAgICBpZiAoIWdldEVsZWN0cm9uKCkpIHtcbiAgICAgICAgcmV0dXJuIHsgZmFsbGJhY2s6IGDmnKznjq/looPmsqHmnIkgRWxlY3Ryb24g55qEIHdlYkNvbnRlbnRz77yIJHtlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCkgfHwgJ+acquefpeWOn+WboCd977yJYCB9O1xuICAgIH1cblxuICAgIC8qKiDlj5bmma/opoHmoYbosIHvvJpga2luZGAg5piv44CM5Zy65pmv5YaF5a6544CN6L+Y5piv44CM6L+Z5Liq6IqC54K544CNICovXG4gICAgY29uc3Qga2luZDogJ3NjZW5lJyB8ICdub2RlJyA9IG9wdGlvbnMubm9kZVJlZiA/ICdub2RlJyA6ICdzY2VuZSc7XG5cbiAgICAvLyDikaAg5YWI6Zeu5Zy65pmv6ISa5pys6KaB5Yeg5L2V77yI6aG65bim6Zeu44CM55uu5qCH5ouN5YWo5LqG5rKh5pyJ44CN77yJ44CC5a6D5ou/5LiN5YiwID0g5Zy65pmv6L+b56iL5LiN5Y+v55SoIOKGklxuICAgIC8vICAgIOmAgOWbnuiAgei3r++8jOiuqeiAgei3r+WOu+aKpemCo+WPpeOAjOWFiOaJk+W8gOS4gOS4quWcuuaZr+OAje+8iOS4pOS4qumAmumBk+eahOWksei0peaWh+ahiOW/hemhu+S4gOiHtO+8ieOAglxuICAgIGxldCBtZXRyaWNzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgIHRyeSB7XG4gICAgICAgIG1ldHJpY3MgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8UmVjb3JkPHN0cmluZywgYW55Pj4oU0NFTkVfTUVUSE9ELnZpZXdNZXRyaWNzLCBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbm9kZTogb3B0aW9ucy5ub2RlUmVmIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBmaXQ6IHsga2luZCwgcmVmOiBvcHRpb25zLm5vZGVSZWYgfHwgJycgfSxcbiAgICAgICAgICAgICAgICBwcm9qZWN0UGF0aDogb3B0aW9ucy5wcm9qZWN0UGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBmYWxsYmFjazogYOWcuuaZr+iEmuacrCB2aWV3TWV0cmljcyDkuI3lj6/nlKjvvJoke2Rlc2NyaWJlKGVycil9YCB9O1xuICAgIH1cbiAgICBpZiAoIW1ldHJpY3MgfHwgbWV0cmljcy5vayAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4geyBmYWxsYmFjazogYOWcuuaZr+iEmuacrCB2aWV3TWV0cmljcyDmsqHnu5nlh7rlh6DkvZXvvJoke2Rlc2NyaWJlKChtZXRyaWNzICYmIG1ldHJpY3MuZXJyb3IpIHx8ICfnqbrov5Tlm54nKX1gIH07XG4gICAgfVxuXG4gICAgY29uc3QgcGFnZSA9IChtZXRyaWNzLnBhZ2UgfHwge30pIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgbGV0IGhyZWYgPSB0eXBlb2YgcGFnZS5ocmVmID09PSAnc3RyaW5nJyA/IHBhZ2UuaHJlZiA6ICcnO1xuXG4gICAgLyoqXG4gICAgICog6L+Z5LiA6aG1546w5Zyo55S755qE5pivKirnvJbovpHlmajlnLrmma8qKui/mOaYryoq6LeR552A55qE5ri45oiPKiog4oCU4oCUIOeUseWcuuaZr+iEmuacrOaKpeS4iuadpe+8iGB2aWV3TWV0cmljcy5ydW50aW1lYO+8jFxuICAgICAqIOingSBgc291cmNlL3NjZW5lLnRzYCDnmoQgYHJlYWRTY2VuZU1vZGVg77yJ44CC44CM6L+Q6KGM5oCB44CN5pyJ5Lik5p2h56Gs5ZCO5p6c77yI5LiL6Z2iIOKRoSDkuI4g4pGjIOWQhOS4gOadoe+8ie+8mlxuICAgICAqIOWPluaZr+S4juijgeiKgueCuemDveW7uueri+WcqCoq57yW6L6R5Zmo55u45py6KirkuIrvvIzogIzov5DooYzmgIHnmoTmuLLmn5Pnm7jmnLrmmK8qKua4uOaIj+iHquW3seeahCoq44CCXG4gICAgICovXG4gICAgY29uc3QgcnVudGltZSA9IChtZXRyaWNzLnJ1bnRpbWUgfHwge30pIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgY29uc3QgcnVubmluZyA9IHJ1bnRpbWUucnVubmluZyA9PT0gdHJ1ZTtcbiAgICBjb25zdCBhY3R1YWxNb2RlID0gdHlwZW9mIHJ1bnRpbWUubW9kZSA9PT0gJ3N0cmluZycgPyBydW50aW1lLm1vZGUgOiAndW5rbm93bic7XG5cbiAgICAvKipcbiAgICAgKiDjgIzmsqHnu5nlh7rmraPnoa7mqKHlvI/jgI3ml7bnmoTlpoLlrp7or7TmmI7jgIJcbiAgICAgKlxuICAgICAqIOe6puWumu+8mmBub3RlYCDpnZ7nqbogPSDmnInkuovjgILov5nph4zlj6rlnKgqKuiwg+eUqOaWueimgeeahOmCo+S4gOenjeS4juWunumZhemCo+S4gOenjeS4jeS4gOiHtCoq5pe25omN5YaZ77yMXG4gICAgICog6ICM5LiU5YaZ55qE5piv5LqL5a6e77yIXCLov5nlvKDlm77mmK8gWFwi77yJ77yM5LiN5piv5a6J5oWw77yIXCLlj6/og73kuI3mmK/kvaDopoHnmoRcIu+8ieOAglxuICAgICAqL1xuICAgIGxldCB2aWV3Tm90ZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGlmIChvcHRpb25zLnZpZXcgPT09ICdnYW1lJyAmJiAhcnVubmluZykge1xuICAgICAgICB2aWV3Tm90ZSA9XG4gICAgICAgICAgICAn6KaB55qE5pivKirov5DooYzmgIEqKu+8iGdhbWUgdmlld++8ieeUu+mdou+8jOS9hue8lui+keWZqOeOsOWcqCoq5LiN5ZyoKirov5DooYzpooTop4jph4wg4oCU4oCUIOi/meW8oOWbvuaYryoq57yW6L6R5Zmo5Zy65pmvKirjgIInICtcbiAgICAgICAgICAgICfmnKzmianlsZUqKuW3sue7j+W8gOS4jeS6humihOiniOS6hioq77yI6YKj5p2h6IO95YqbIDIwMjYtMTAtMDgg5pKk5o6J5LqG77yM55CG55Sx6KeBIGBjb2Nvc19ydW50aW1lYCDnmoTor7TmmI7vvInvvJonICtcbiAgICAgICAgICAgICfopoHnnIvmuLjmiI/nlLvpnaLvvIzor7cqKuiHquW3seWcqOe8lui+keWZqOW3peWFt+agj+aMiemCo+mil+aSreaUvumUrioq77yM5Zue5p2l5YaN5oiq44CCJztcbiAgICB9IGVsc2UgaWYgKG9wdGlvbnMudmlldyA9PT0gJ3NjZW5lJyAmJiBydW5uaW5nKSB7XG4gICAgICAgIHZpZXdOb3RlID1cbiAgICAgICAgICAgICfopoHnmoTmmK8qKue8lui+keWZqOWcuuaZryoq77yM5L2G57yW6L6R5Zmo546w5Zyo5q2j5Zyo6LeR6L+Q6KGM6aKE6KeIIOKAlOKAlCDov5nlvKDlm77mmK8qKua4uOaIj+eUu+mdoioq44CCJyArXG4gICAgICAgICAgICAn5oOz6KaB57yW6L6R5Zmo5Zy65pmv77ya6K+3Kiroh6rlt7HlnKjnvJbovpHlmajlt6XlhbfmoI/mjInlgZzmraIqKuWGjeaIquOAgic7XG4gICAgfSBlbHNlIGlmIChvcHRpb25zLnZpZXcgIT09ICdhdXRvJyAmJiBydW50aW1lLm1vZGUgPT09ICd1bmtub3duJyAmJiBydW50aW1lLm5vdGUpIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOKaoCDlj6rlnKjosIPnlKjmlrkqKuaYjuehruimgeS6huafkOS4gOenjSoq5pe25omN6K+06L+Z5Y+l6K+d44CCXG4gICAgICAgICAqIGB2aWV3OlwiYXV0b1wiYCDnmoTosIPnlKjmlrnmsqHpl67mqKHlvI/vvIzmiopcIuaIkeWIpOS4jeWHuuadpVwi5aGe6L+bIGBub3RlYCDkvJrnm5bmjonmm7TopoHntKfnmoTpgqPmnaFcbiAgICAgICAgICog77yI5q+U5aaCXCLoioLngrnmib7kuI3liLDvvIzpgIDlm57mlbTlvKDop4blm75cIu+8ieKAlOKAlCDjgIxub3RlIOmdnuepuiA9IOacieS6i+OAjei/meadoee6puWumuWwseiiq+WZquWjsOeUqOaOieS6huOAglxuICAgICAgICAgKiDliKTkuI3lh7rmnaXov5nku7bkuovmnKzouqsqKueFp+agt+WmguWunuaKpSoq77yaYG1vZGUuYWN0dWFsYCDlsLHmmK8gYHVua25vd25g77yM55CG55Sx5ZyoIGBtb2RlLm5vdGVgIOmHjOOAglxuICAgICAgICAgKi9cbiAgICAgICAgdmlld05vdGUgPSBg6KaB55qE5piv44CMJHtvcHRpb25zLnZpZXd944CN77yM5L2G5Yik5pat5LiN5LqG6L+Z5LiA6aG155S755qE5piv5Zy65pmv6L+Y5piv5ri45oiP77yaJHtydW50aW1lLm5vdGV9YDtcbiAgICB9XG5cbiAgICAvLyDikaEg5Y+W5pmv77yIYGZpdGDvvInvvJrnlKjmiLfnvKnmlL4v5bmz56e76L+H5LmL5ZCO77yM5bGP5bmV5LiK6YKj5LiA5bin5pyq5b+F5piv44CM5YWo5pmv44CN4oCU4oCUXG4gICAgLy8gICAg5oyJ6ZyA6KaB5oqK55uu5qCH5qGG6L+b55S75biD77yM5oiq5a6M5YaN6L+Y5Y6f6KeG6KeS77yI6KeBIHJ1bkZpdENoYWlu77yJ44CCXG4gICAgLyoqXG4gICAgICog4pqgICoq6L+Q6KGM5oCB5LiA5b6L5LiN5Y+W5pmvKirvvIjkuI3nrqHosIPnlKjmlrnkvKDkuobku4DkuYggYGZpdGDvvInjgIJcbiAgICAgKlxuICAgICAqIOeQhueUseS4jeaYr1wi5Y+W5pmv5aSx6LSlXCLvvIzogIzmmK9cIuWPluaZr+WcqOmCo+S4gOWIuyoq5rKh5pyJ5oSP5LmJKipcIu+8mmBydW5GaXRDaGFpbmAg5pGG55qE5pivXG4gICAgICogYGNjZS5DYW1lcmFg77yI57yW6L6R5Zmo55u45py677yJ77yM6ICM6L+Q6KGM5oCB55qE55S76Z2i5pivKirmuLjmiI/oh6rlt7HnmoTnm7jmnLoqKua4suafk+eahFxuICAgICAqIO+8iGBQcmV2aWV3UGxheS5oaWRlRWRpdG9yQ2FtZXJhKClg77yJ4oCU4oCUIOaRhuS6huS5n+S4jeS8muaUueWPmOeUu+mdouS4gOagueWDj+e0oO+8jFxuICAgICAqIOWPjeiAjOS8mioq55m95Yqo5LiA5qyh55So5oi355qE57yW6L6R5Zmo6KeG6KeSKirjgIJcbiAgICAgKi9cbiAgICBsZXQgZml0TW9kZTogRml0TW9kZSA9IG9wdGlvbnMuZml0O1xuICAgIC8qKiDov5DooYzmgIHkuIvjgIzlj5bmma/ooqvlv73nlaXjgI3nmoTor7TmmI4g4oCU4oCUIOWug+WxnuS6jioq5Y+W5pmv6LSm5pysKirvvIhgZnJhbWluZy5ub3RlYO+8ie+8jOS4jeaYr+OAjOaLv+mUmeeUu+mdouOAjemCo+S4gOexuyAqL1xuICAgIGxldCBmaXRPdmVycmlkZU5vdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBpZiAocnVubmluZyAmJiBmaXRNb2RlICE9PSAnbm9uZScpIHtcbiAgICAgICAgZml0TW9kZSA9ICdub25lJztcbiAgICAgICAgZml0T3ZlcnJpZGVOb3RlID1cbiAgICAgICAgICAgICfov5DooYzmgIHkuIvkuI3lj5bmma/vvJpgZml0YCDmkYbnmoTmmK/nvJbovpHlmajnm7jmnLrvvIzogIznlLvpnaLnlLHmuLjmiI/oh6rlt7HnmoTnm7jmnLrmuLLmn5PvvIzmkYbkuobkuZ/kuI3kvJrmlLnlj5jov5nlvKDlm77vvIjov5nmrKHmjInljp/moLfmiKrvvInjgIInO1xuICAgIH1cblxuICAgIGxldCBmcmFtaW5nOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgICAgICByZXF1ZXN0ZWQ6IGZpdE1vZGUsXG4gICAgICAgIGFwcGxpZWQ6IG51bGwsXG4gICAgICAgIG1ldGhvZDogbnVsbCxcbiAgICAgICAgYmVmb3JlOiBwaWNrQ292ZXJhZ2UobWV0cmljcyksXG4gICAgICAgIGFmdGVyOiBwaWNrQ292ZXJhZ2UobWV0cmljcyksXG4gICAgfTtcbiAgICBsZXQgZml0Tm90ZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHdhbnRlZCA9IGRlY2lkZUZpdChmaXRNb2RlLCBvcHRpb25zLm5vZGVSZWYsIGZyYW1pbmcuYmVmb3JlKTtcbiAgICBpZiAod2FudGVkKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GaXRDaGFpbih3YW50ZWQsIG9wdGlvbnMubm9kZVJlZiwgb3B0aW9ucy5wcm9qZWN0UGF0aCwgbWV0cmljcywgaHJlZik7XG4gICAgICAgICAgICBmcmFtaW5nID0geyByZXF1ZXN0ZWQ6IGZpdE1vZGUsIC4uLnJlc3VsdC5mcmFtaW5nIH07XG4gICAgICAgICAgICAvKiog4pqgIOebuOacuuWKqOi/hyDihpIg6IqC54K555+p5b2i5b+F6aG755SoKirmlrDnmoQqKumCo+S4gOS7ve+8iOaXp+eahOW3sue7j+S4jeaIkOeri+S6hu+8iSAqL1xuICAgICAgICAgICAgbWV0cmljcyA9IHJlc3VsdC5tZXRyaWNzO1xuICAgICAgICAgICAgZml0Tm90ZSA9IHJlc3VsdC5maXROb3RlO1xuICAgICAgICAgICAgY29uc3QgbmV3UGFnZSA9IChtZXRyaWNzLnBhZ2UgfHwge30pIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgICAgICAgICBpZiAodHlwZW9mIG5ld1BhZ2UuaHJlZiA9PT0gJ3N0cmluZycgJiYgbmV3UGFnZS5ocmVmKSBocmVmID0gbmV3UGFnZS5ocmVmO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIC8qKiDlj5bmma/mmK8qKuWKoOWIhumhuSoq77ya5a6D5aSx6LSl5LiN6K+l6K6p5oiq5Zu+5aSx6LSlIOKAlOKAlCDlpoLlrp7orrDkuIDnrJTvvIznu6fnu63mjInlvZPliY3lj5bmma/miKogKi9cbiAgICAgICAgICAgIGZyYW1pbmcucmVxdWVzdGVkID0gZml0TW9kZTtcbiAgICAgICAgICAgIGZyYW1pbmcuYXBwbGllZCA9IHdhbnRlZDtcbiAgICAgICAgICAgIGZyYW1pbmcubm90ZSA9IGDlj5bmma/msqHlgZrmiJDvvIgke2Rlc2NyaWJlKGVycil977yJ4oCU4oCUIOWbnuaJp+mHjOi/meW8oOWbvuaYryoq5b2T5YmN6KeG6KeSKirpgqPkuIDluKdgO1xuICAgICAgICAgICAgZml0Tm90ZSA9IGZyYW1pbmcubm90ZTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZml0TW9kZSA9PT0gJ25vbmUnICYmIGZyYW1pbmcuYmVmb3JlICYmIGZyYW1pbmcuYmVmb3JlLmNvdmVyZWQgIT09IHRydWUpIHtcbiAgICAgICAgZnJhbWluZy5ub3RlID0gJ2BmaXQ6XCJub25lXCJgIOaMieWOn+agt+aIqiDigJTigJQg5L2G6YeP5LiL5p2l55uu5qCHKirmsqHmnInooqvmi43lhagqKu+8jOaDs+aLjeWFqOWwseS8oCBgZml0Olwic2NlbmVcImAnO1xuICAgIH0gZWxzZSBpZiAoZml0TW9kZSA9PT0gJ25vZGUnICYmICFvcHRpb25zLm5vZGVSZWYpIHtcbiAgICAgICAgZnJhbWluZy5ub3RlID0gJ2BmaXQ6XCJub2RlXCJgIOmcgOimgeWQjOaXtue7mSBgbm9kZWDvvIjov5nmrKHmsqHnu5nvvInigJTigJQg5oyJ5b2T5YmN6KeG6KeS5Y6f5qC35oiqJztcbiAgICB9IGVsc2UgaWYgKGZpdE1vZGUgPT09ICdhdXRvJyAmJiAhb3B0aW9ucy5ub2RlUmVmICYmIGZyYW1pbmcuYmVmb3JlKSB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDjgIzkuI3nlKjlj5bmma/jgI3mmK8qKuato+W4uOaDheWGtSoq77yM5omA5Lul5LiN5YaZIGBub3RlYO+8iOe6puWumu+8mmBub3RlYCDpnZ7nqbogPSDmnInkuovvvInigJTigJRcbiAgICAgICAgICog5oqKXCLkuLrku4DkuYjmsqHliqjnm7jmnLpcIuiusOWcqCBgd2h5YCDph4zvvIzpnIDopoHop6Pph4rml7bnnIvlvpfliLDjgIJcbiAgICAgICAgICovXG4gICAgICAgIGZyYW1pbmcud2h5ID1cbiAgICAgICAgICAgIGZyYW1pbmcuYmVmb3JlLmNvdmVyZWQgPT09IHRydWVcbiAgICAgICAgICAgICAgICA/IGDlhoXlrrnlt7Lnu4/mlbTkuKrlnKjnlLvluIPph4zvvIhhcmVhUmF0aW8gJHtmcmFtaW5nLmJlZm9yZS5hcmVhUmF0aW99IOKJpSAke0ZJVF9TTUFMTF9SQVRJT33vvInigJTigJQg5oyJ5Y6f5qC35oiq77yM5rKh5Yqo55u45py6YFxuICAgICAgICAgICAgICAgIDogJ+mHj+S4jeWIsOimhuebluaDheWGtSc7XG4gICAgfVxuICAgIC8qKiDov5DooYzmgIHpgqPmnaHor7TmmI7okL3lnKgqKuWPluaZr+i0puacrCoq6YeM77yI6KaB5om+XCLkuLrku4DkuYjmsqHliqjnm7jmnLpcIu+8jOWwseeci+i/meS4gOagvO+8iSAqL1xuICAgIGlmIChmaXRPdmVycmlkZU5vdGUgJiYgIWZyYW1pbmcubm90ZSkgZnJhbWluZy5ub3RlID0gZml0T3ZlcnJpZGVOb3RlO1xuXG4gICAgLy8g4pGiIOaKk+Wbvu+8iCoq5Y+q6K+7KirvvJrkuIDmrKEgYGNhcHR1cmVQYWdlKClg77yM5LiN5o6S6YeN57uYIOKAlOKAlCDop4EgY2FwdHVyZS50cyDmlofku7blpLTpgqPmnaHnoazlj6PlvoTvvIlcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgY2FwdHVyZVNjZW5lVmlldyhocmVmKTtcbiAgICBpZiAoIW91dGNvbWUub2spIHtcbiAgICAgICAgcmV0dXJuIHsgZmFsbGJhY2s6IG91dGNvbWUuZXJyb3IgfTtcbiAgICB9XG5cbiAgICAvLyDikaMg6KaB5oiq6IqC54K55bCx6KOBIOKAlOKAlCDnn6nlvaLmnaXoh6rnvJbovpHlmajnm7jmnLrnmoTmipXlvbHvvIjpobXpnaIgQ1NTIOWDj+e0oO+8iVxuICAgIGNvbnN0IG5vZGVJbmZvID0gKG1ldHJpY3Mubm9kZSB8fCBudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbDtcbiAgICBjb25zdCBwYWRkaW5nID0gb3B0aW9ucy5wYWRkaW5nO1xuICAgIGxldCBpbWFnZSA9IG91dGNvbWUuaW1hZ2U7XG4gICAgbGV0IGNyb3BSZWN0OiB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGNyb3BOb3RlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgaWYgKG9wdGlvbnMubm9kZVJlZikge1xuICAgICAgICBpZiAocnVubmluZykge1xuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiDimqAgKirov5DooYzmgIHkuI3oo4HoioLngrkqKu+8mmBub2RlLnJlY3RgIOaYr+aLvyoq57yW6L6R5Zmo55u45py6KirmipXlh7rmnaXnmoTvvIzogIzpgqPkuIDliLvnlLvpnaLnlLFcbiAgICAgICAgICAgICAqIOa4uOaIj+iHquW3seeahOebuOacuua4suafkyDigJTigJQg5oyJ5a6D6KOB5Lya5b6X5Yiw5LiA5Z2XKirplJnkvY3nmoTlm74qKu+8iOavlOaVtOmhteWbvuabtOWdke+8mueci+edgOWDj+aIkOWKn+S6hu+8ieOAglxuICAgICAgICAgICAgICog5omA5Lul6L+Z6YeM5aaC5a6e6YCA5Zue5pW06aG177yM5bm25oqKXCLmgI7kuYjlip5cIuS4gOi1t+ivtOS6huOAglxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBjcm9wTm90ZSA9XG4gICAgICAgICAgICAgICAgJ+i/kOihjOaAge+8iGdhbWUgdmlld++8ieS4iyoq5LiN5oyJ6IqC54K56KOB5Zu+KirvvJroioLngrnnn6nlvaLmmK/nlKjnvJbovpHlmajnm7jmnLrmipXlh7rmnaXnmoTvvIwnICtcbiAgICAgICAgICAgICAgICAn6ICM6L+Q6KGM5oCB55qE55S76Z2i55Sx5ri45oiP6Ieq5bex55qE55u45py65riy5p+T77yM5Lik6ICF5LiN5piv5ZCM5LiA5Liq5Y+W5pmvIOKAlOKAlCDmjInlroPoo4HkvJrnu5nkvaDkuIDlnZfplJnkvY3nmoTlm77jgIInICtcbiAgICAgICAgICAgICAgICAn546w5Zyo57uZ55qE5pivKirmlbTlvKDnlLvpnaIqKu+8m+imgeaMieiKgueCueijgeivt+WFiCoq6Ieq5bex5Zyo57yW6L6R5Zmo5bel5YW35qCP5oyJ5YGc5q2iKirlm57liLDnvJbovpHmgIHjgIInO1xuICAgICAgICB9IGVsc2UgaWYgKCFub2RlSW5mbyB8fCBub2RlSW5mby5mb3VuZCAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgY3JvcE5vdGUgPSBg5rKh5om+5Yiw6IqC54K544CMJHtvcHRpb25zLm5vZGVSZWZ944CNJHtub2RlSW5mbyAmJiBub2RlSW5mby5ub3RlID8gYO+8iCR7bm9kZUluZm8ubm90ZX3vvIlgIDogJyd9IOKAlOKAlCDlm57miafph4znu5nnmoTmmK8qKuaVtOW8oOWcuuaZr+inhuWbvioqYDtcbiAgICAgICAgfSBlbHNlIGlmICghbm9kZUluZm8ucmVjdCkge1xuICAgICAgICAgICAgY3JvcE5vdGUgPSBg6IqC54K544CMJHtub2RlSW5mby5uYW1lIHx8IG9wdGlvbnMubm9kZVJlZn3jgI3nrpfkuI3lh7rnn6nlvaIke25vZGVJbmZvLm5vdGUgPyBg77yIJHtub2RlSW5mby5ub3Rlfe+8iWAgOiAnJ30g4oCU4oCUIOWbnuaJp+mHjOe7meeahOaYryoq5pW05byg5Zy65pmv6KeG5Zu+KipgO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcmVjdCA9IG5vZGVJbmZvLnJlY3QgYXMgeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfTtcbiAgICAgICAgICAgIGNyb3BSZWN0ID0ge1xuICAgICAgICAgICAgICAgIHg6IHJlY3QueCAtIHBhZGRpbmcsXG4gICAgICAgICAgICAgICAgeTogcmVjdC55IC0gcGFkZGluZyxcbiAgICAgICAgICAgICAgICB3aWR0aDogcmVjdC53aWR0aCArIHBhZGRpbmcgKiAyLFxuICAgICAgICAgICAgICAgIGhlaWdodDogcmVjdC5oZWlnaHQgKyBwYWRkaW5nICogMixcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwYWdlQ3NzID0ge1xuICAgICAgICB3aWR0aDogdHlwZW9mIHBhZ2UuY3NzV2lkdGggPT09ICdudW1iZXInICYmIHBhZ2UuY3NzV2lkdGggPiAwID8gcGFnZS5jc3NXaWR0aCA6IG91dGNvbWUuc291cmNlV2lkdGgsXG4gICAgICAgIGhlaWdodDogdHlwZW9mIHBhZ2UuY3NzSGVpZ2h0ID09PSAnbnVtYmVyJyAmJiBwYWdlLmNzc0hlaWdodCA+IDAgPyBwYWdlLmNzc0hlaWdodCA6IG91dGNvbWUuc291cmNlSGVpZ2h0LFxuICAgIH07XG4gICAgbGV0IGFwcGxpZWRDcm9wOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGNyb3BSZWN0KSB7XG4gICAgICAgIGNvbnN0IGNyb3BwZWQgPSBjcm9wVG9Dc3NSZWN0KGltYWdlLCBjcm9wUmVjdCwgcGFnZUNzcyk7XG4gICAgICAgIGltYWdlID0gY3JvcHBlZC5pbWFnZTtcbiAgICAgICAgYXBwbGllZENyb3AgPSBjcm9wcGVkLnJlY3Q7XG4gICAgICAgIGlmICghYXBwbGllZENyb3ApIGNyb3BOb3RlID0gJ+ijgeWIh+Wksei0pe+8iOefqeW9oumAgOWMluaIlui2iueVjO+8ieKAlOKAlCDlm57miafph4znu5nnmoTmmK8qKuaVtOW8oOWcuuaZr+inhuWbvioqJztcbiAgICB9XG5cbiAgICAvLyDikaMg57yp5YiwIG1heFdpZHRoIOWGjee8luegge+8iOetieavlO+8m0VsZWN0cm9uIOeahCByZXNpemUg5Y+q57uZIHdpZHRoIOS4jeaYr+etieavlO+8jOingSBjYXB0dXJlLnRz77yJXG4gICAgaW1hZ2UgPSBkb3duc2NhbGVUb1dpZHRoKGltYWdlLCBvcHRpb25zLm1heFdpZHRoKTtcbiAgICBjb25zdCBmaW5hbFNpemUgPSBpbWFnZVNpemVPZihpbWFnZSk7XG4gICAgbGV0IGJ1ZmZlcjogQnVmZmVyO1xuICAgIHRyeSB7XG4gICAgICAgIGJ1ZmZlciA9IGVuY29kZUltYWdlKGltYWdlLCBvcHRpb25zLmZvcm1hdCwgb3B0aW9ucy5xdWFsaXR5KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHsgcmVwbHk6IGNhcHR1cmVGYWlsKGDnvJbnoIHlm77niYflpLHotKXvvJoke2Rlc2NyaWJlKGVycil9YCwgeyB0YXJnZXQ6IG91dGNvbWUudGFyZ2V0IH0pIH07XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZGlyID0gcGF0aC5kaXJuYW1lKG9wdGlvbnMuc2F2ZVBhdGgpO1xuICAgICAgICBpZiAoZGlyKSBmcy5ta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhvcHRpb25zLnNhdmVQYXRoLCBidWZmZXIpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyByZXBseTogY2FwdHVyZUZhaWwoYOWGmeWFpeaIquWbvuaWh+S7tuWksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLCB7IHBhdGg6IG9wdGlvbnMuc2F2ZVBhdGgsIHRhcmdldDogb3V0Y29tZS50YXJnZXQgfSkgfTtcbiAgICB9XG5cbiAgICBsZXQgYnl0ZXMgPSBidWZmZXIubGVuZ3RoO1xuICAgIHRyeSB7XG4gICAgICAgIGJ5dGVzID0gZnMuc3RhdFN5bmMob3B0aW9ucy5zYXZlUGF0aCkuc2l6ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5bC65a+46K+75LiN5Yiw5LiN5b2x5ZON5L2/55SoICovXG4gICAgfVxuXG4gICAgY29uc3QgYmxhbmsgPSBvdXRjb21lLmJsYW5rUmF0aW8gPj0gMC45NTtcbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIC8qKlxuICAgICAgICAgKiDov5nmrKHmmK/osIHmipPnmoTlm77jgIJgZWxlY3Ryb25gID0g5Li76L+b56iLIGBjYXB0dXJlUGFnZWDvvIgqKuW9k+WJjeeahOato+i3ryoq77yJ77ybXG4gICAgICAgICAqIGBzY2VuZS1nbGAgPSDogIHot6/vvIjlnLrmma/ov5vnqIsgYGdsLnJlYWRQaXhlbHNg77yM5Y+q5ZyoIEVsZWN0cm9uIOmAmumBk+S4jeWPr+eUqOaXtueUqO+8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgbWV0aG9kOiAnZWxlY3Ryb24nLFxuICAgICAgICBwYXRoOiBvcHRpb25zLnNhdmVQYXRoLFxuICAgICAgICB3aWR0aDogZmluYWxTaXplLndpZHRoLFxuICAgICAgICBoZWlnaHQ6IGZpbmFsU2l6ZS5oZWlnaHQsXG4gICAgICAgIC8vIOaKk+WIsOeahOaVtOmhteWOn+WbvuWwuuWvuO+8iOacquijgeacque8qe+8ie+8jOS4juiAgeWbnuaJp+WQjOS4gOWQq+S5iVxuICAgICAgICBzb3VyY2VXaWR0aDogb3V0Y29tZS5zb3VyY2VXaWR0aCxcbiAgICAgICAgc291cmNlSGVpZ2h0OiBvdXRjb21lLnNvdXJjZUhlaWdodCxcbiAgICAgICAgZm9ybWF0OiBvcHRpb25zLmZvcm1hdCxcbiAgICAgICAgYnl0ZXMsXG4gICAgICAgIGJsYW5rUmF0aW86IG91dGNvbWUuYmxhbmtSYXRpbyxcbiAgICAgICAgLy8g6KeG5Zu+54q25oCB77yIdmlzaWJsZVNpemUgLyBkZXNpZ25SZXNvbHV0aW9uIC8gY2FudmFzIC8gdmlzaWJsZU1hdGNoZXNEZXNpZ27vvIlcbiAgICAgICAgdmlldzogbWV0cmljcy52aWV3ID8/IG51bGwsXG4gICAgICAgIC8qKlxuICAgICAgICAgKiDov5nlvKDlm74qKueUu+eahOaYr+WTquS4gOenjeeUu+mdoioqIOKAlOKAlCDov5DooYzmgIHvvIhnYW1lIHZpZXcg6LeR552A5ri45oiP77yJ6L+Y5piv57yW6L6R5oCB77yI57yW6L6R5Zmo5Zy65pmv77yJ44CCXG4gICAgICAgICAqXG4gICAgICAgICAqIOS4uuS7gOS5iOS4jeW5tui/myBgdmlld2DvvJrpgqPkuKrlrZfmrrXml6nlsLHmmK/jgIzop4blm77nirbmgIHjgI3vvIh2aXNpYmxlU2l6ZSAvIGRlc2lnblJlc29sdXRpb27vvInvvIxcbiAgICAgICAgICog5ZCr5LmJ5bey57uP5Y2g5L2P5LqG77yb6ICM6L+Z5LiA5qC85Zue562U55qE5piv5Y+m5LiA5Liq6Zeu6aKY77yaXCLmiJHliLDlupXmiKrliLDkuobku4DkuYhcIuOAglxuICAgICAgICAgKiBgcmVxdWVzdGVkYCAvIGBhY3R1YWxgIOS4pOS4qumDveaRhuWHuuadpSDigJTigJQg6KaB55qE5ZKM5ou/55qE5LiN5piv5LiA5Zue5LqL5pe277yM6L+Z6YeM5LiA55y855yL5b6X6KeB44CCXG4gICAgICAgICAqL1xuICAgICAgICBtb2RlOiB7XG4gICAgICAgICAgICByZXF1ZXN0ZWQ6IG9wdGlvbnMudmlldyxcbiAgICAgICAgICAgIGFjdHVhbDogYWN0dWFsTW9kZSxcbiAgICAgICAgICAgIHJ1bm5pbmcsXG4gICAgICAgICAgICAvKiog6aKE6KeI6Ieq5bex5piv5LiN5piv6KKr5Ya75L2P5LqG77yIYFByZXZpZXdQbGF5Ll9zdGF0ZSA9PT0gJ3BhdXNlJ2DvvJvliKTkuI3kuoblsLHmmK8gbnVsbO+8iSAqL1xuICAgICAgICAgICAgcGF1c2VkOiB0eXBlb2YgcnVudGltZS5wYXVzZWQgPT09ICdib29sZWFuJyA/IHJ1bnRpbWUucGF1c2VkIDogbnVsbCxcbiAgICAgICAgICAgIHNvdXJjZXM6IHJ1bnRpbWUuc291cmNlcyA/PyBudWxsLFxuICAgICAgICAgICAgbm90ZTogdmlld05vdGUsXG4gICAgICAgIH0sXG4gICAgICAgIC8vIOaKk+eahOaYr+WTquS4gOS4qiB3ZWJDb250ZW50cyDigJTigJQg57yW6L6R5Zmo6YeM5Y+v6IO95ZCM5pe25pyJ5Zy65pmv6KeG5Zu+5LiO5ri45oiP6aKE6KeI77yM5oqT6ZSZ5pe26Z2g5a6D5LiA55y855yL5Ye65p2lXG4gICAgICAgIGNvbnRlbnRzOiBvdXRjb21lLnRhcmdldCxcbiAgICAgICAgbWF0Y2hlZEJ5OiBvdXRjb21lLm1hdGNoZWRCeSxcbiAgICAgICAgdHJhbnNwb3J0OiAnZWxlY3Ryb24nLFxuICAgICAgICB0YXJnZXQ6IG9wdGlvbnMubm9kZVJlZlxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICBraW5kOiAnbm9kZScsXG4gICAgICAgICAgICAgICAgICByZWY6IG9wdGlvbnMubm9kZVJlZixcbiAgICAgICAgICAgICAgICAgIHV1aWQ6IG5vZGVJbmZvICYmIG5vZGVJbmZvLnV1aWQgPyBub2RlSW5mby51dWlkIDogbnVsbCxcbiAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGVJbmZvICYmIG5vZGVJbmZvLm5hbWUgPyBub2RlSW5mby5uYW1lIDogbnVsbCxcbiAgICAgICAgICAgICAgICAgIC8qKiDlnLrmma/kvqfnrpflh7rmnaXnmoToioLngrnnn6nlvaLvvIjpobXpnaIgQ1NTIOWDj+e0oO+8ie+8m+e7mSBwYWRkaW5nIOaXtui/memHjOaYryoq5pyq5YqgIHBhZGRpbmcqKiDnmoTljp/nn6nlvaIgKi9cbiAgICAgICAgICAgICAgICAgIHJlY3Q6IG5vZGVJbmZvICYmIG5vZGVJbmZvLnJlY3QgPyBub2RlSW5mby5yZWN0IDogbnVsbCxcbiAgICAgICAgICAgICAgICAgIC8qKiDnnJ/mraPmi7/ljrvoo4HliIfnmoTnn6nlvaLvvIjlkKsgcGFkZGluZ++8jOW3suaNoueul+WIsOWbvueJh+WDj+e0oO+8iSAqL1xuICAgICAgICAgICAgICAgICAgY3JvcDogYXBwbGllZENyb3AsXG4gICAgICAgICAgICAgICAgICB3b3JsZFJlY3Q6IG5vZGVJbmZvICYmIG5vZGVJbmZvLndvcmxkUmVjdCA/IG5vZGVJbmZvLndvcmxkUmVjdCA6IG51bGwsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogeyBraW5kOiAndmlldycgfSxcbiAgICAgICAgLy8g5Zy65pmv6KeG5Zu+5Yeg5L2V5LiO57yW6L6R5Zmo55u45py677ya6K+K5pat44CM55+p5b2i5Li65LuA5LmI5Zyo6YKj5YS/44CN55SoXG4gICAgICAgIHBhZ2U6IG1ldHJpY3MucGFnZSA/PyBudWxsLFxuICAgICAgICBjYW52YXM6IG1ldHJpY3MuY2FudmFzID8/IG51bGwsXG4gICAgICAgIGNhbWVyYTogbWV0cmljcy5jYW1lcmEgPz8gbnVsbCxcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOWPluaZr+i0puacrO+8mioq6L+Z5byg5Zu+5piv5YWo5pmv6L+Y5piv5b2T5YmN6KeG6KeSKirvvIznnIvlroPlsLHlpJ/jgIJcbiAgICAgICAgICogYGJlZm9yZS9hZnRlcmAg5piv44CM55uu5qCH5ouN5YWo5LqG5rKh5pyJ44CN55qE5Lik5qyh5a6e5rWL77yIYGNvdmVyZWRgIC8gYGFyZWFSYXRpb2AgLyDlm5vovrnkvZnph4/vvInjgIJcbiAgICAgICAgICovXG4gICAgICAgIGZyYW1pbmcsXG4gICAgfTtcbiAgICBpZiAoY3JvcE5vdGUpIHBheWxvYWQubm90ZSA9IGNyb3BOb3RlO1xuICAgIGlmIChub2RlSW5mbyAmJiBub2RlSW5mby5yZWN0ICYmIG5vZGVJbmZvLm5vdGUpIHBheWxvYWQubm9kZU5vdGUgPSBub2RlSW5mby5ub3RlO1xuICAgIC8qKiDlj5bmma/nmoTor7TmmI7kvJjlhYjokL3lnKggYGZyYW1pbmcubm90ZWAg6YeM77yI5a6D5bim552A6KaG55uW546H5pWw5o2u77yJ77yb6L+Z6YeM5Y+q5Zyo5a6D57y65L2N5pe26KGl5LiA5Y+lICovXG4gICAgaWYgKGZpdE5vdGUgJiYgIWZyYW1pbmcubm90ZSAmJiAhY3JvcE5vdGUpIHBheWxvYWQubm90ZSA9IGZpdE5vdGU7XG4gICAgZWxzZSBpZiAoZml0T3ZlcnJpZGVOb3RlICYmICFjcm9wTm90ZSAmJiAhcGF5bG9hZC5ub3RlKSBwYXlsb2FkLm5vdGUgPSBmaXRPdmVycmlkZU5vdGU7XG4gICAgLyoqXG4gICAgICog4pqgIOOAjOimgeeahOmCo+enjeeUu+mdouayoeaLv+WIsOOAjSoq5Y6L6L+HKirkuIrpnaLkuKTmnaHjgIJcbiAgICAgKlxuICAgICAqIOWug+ivtOeahOS4jeaYr1wi6L+Z5byg5Zu+5bCP55GV55a1XCLvvIzogIzmmK9cIui/meW8oOWbvuagueacrOS4jeaYr+S9oOimgeeahOmCo+S4quS4nOilv1wiIOKAlOKAlFxuICAgICAqIOiiqyBgZnJhbWluZy5ub3RlYCDmiJboo4Hliaror7TmmI7nm5bmjonnmoTor53vvIzosIPnlKjmlrnkvJrmi7/nnYDkuIDlvKDplJnnlLvpnaLnmoTlm77nu6fnu63lvoDkuIvotbBcbiAgICAgKiDvvIjov5nmraPmmK/mnIDpmr7mn6XnmoTkuIDnsbvplJnvvJrlt6XlhbfmsqHmiqXplJnvvIzlm77kuZ/lnKjvvIzlsLHmmK/kuI3lr7nvvInjgIJcbiAgICAgKi9cbiAgICBpZiAodmlld05vdGUpIHBheWxvYWQubm90ZSA9IHZpZXdOb3RlO1xuICAgIHBheWxvYWQuaGludCA9IGJsYW5rID8gQ0FQVFVSRV9CTEFOS19ISU5UIDogQ0FQVFVSRV9SRUFEX0hJTlQ7XG5cbiAgICByZXR1cm4geyByZXBseTogeyBvazogdHJ1ZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGRhdGE6IHBheWxvYWQgfSB9O1xufVxuXG4vKipcbiAqIOaIquS4gOW8oCoq5Zy65pmv6KeG5Zu+KirvvIhgY29jb3NfY2FwdHVyZV92aWV3YCDnmoTlrp7njrDvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjljZXni6zkuIDmnaHpgJrpgZPvvJrlm77niYfmmK/kuozov5vliLYv5aSn5a2X56ym5Liy77yM5aGe5LiN6L+bIGBleGVjdXRlX2NvZGVgIOeahOi/lOWbnuWAvOS4iumZkFxuICog77yI5Y2V5a2X56ym5LiyIDQwMDAg5a2X77yJ4oCU4oCUIOaJgOS7peWug+W/hemhu+aYr+OAjOW3peWFtyDihpIg6JC955uYIOKGkiDlm57ot6/lvoTjgI3jgIJcbiAqXG4gKiAjIyDkuKTmnaHot6/vvIzlhYjlpb3lkI7ogIFcbiAqXG4gKiAxLiAqKkVsZWN0cm9uIOmAmumBkyoq77yIe0BsaW5rIGNhcHR1cmVWaWV3VmlhRWxlY3Ryb25977yMKirmraPot68qKu+8ie+8muS4u+i/m+eoi1xuICogICAgYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgIOaKkyoq5ZCI5oiQ5ZCO55qEIHN1cmZhY2UqKu+8iCoq5Y+q6K+7KirvvIzkuIDmrKHmipPlm77vvIzkuI3mjpLph43nu5gg4oCU4oCUXG4gKiAgICDop4EgYHNvdXJjZS9jYXB0dXJlLnRzYCDmlofku7blpLTpgqPmnaHnoazlj6PlvoTvvInjgIJcbiAqICAgIOiAgeWunueOsOivu+eahOaYryBHTCDlkI7lpIfnvJPlhrLjgIHkuJQqKuayoeazleiuqee8lui+keWZqOmHjeeUuyoq77yM5LqO5piv5a6e5rWL5oGS5ZueIGBibGFua1JhdGlvOiAxYFxuICogICAg77yIYGRvY3MvYWdlbnQtbm90ZXMvVUnkuI7ooajnjrDlsYIubWRg77yJ4oCU4oCUIOi/meadoei3r+WwseaYr+S7juagueS4iuaNouaOiemCo+S4quivu+WPlua6kOOAglxuICogICAg6aG65bim5pSv5oyBKiroioLngrnnuqfmiKrlm74qKu+8iGBub2RlYCDlj4LmlbDvvIznn6nlvaLnlLHnvJbovpHlmajnm7jmnLrmipXlvbHvvIzop4HlnLrmma/ohJrmnKwgYHZpZXdNZXRyaWNzYO+8iVxuICogICAg5LiOKirlj5bmma8qKu+8iGBmaXRgIOWPguaVsO+8muWFiOaKiuebruagh+ahhui/m+eUu+W4g++8jOaIquWujOi/mOWOn+inhuinku+8jOingSBgcnVuRml0Q2hhaW5g77yJ44CCXG4gKiAyLiAqKuWcuuaZr+i/m+eoi+ivu+WDj+e0oCoq77yI6ICB55qEIGBjYXB0dXJlX3ZpZXdg77yMKirlhZzlupUqKu+8ie+8mkVsZWN0cm9uIOaLv+S4jeWIsCAvIOWcuuaZr+iEmuacrFxuICogICAg54mI5pys5pen77yI5rKh5pyJIGB2aWV3TWV0cmljc2DvvIkvIOaKk+WbvuWksei0peaXtuaJjei1sO+8jOS/neivgei/meS4quW3peWFt+WcqOS7u+S9leaDheWGteS4i+mDveavlFwi5rKh5pyJXCLlvLrjgIJcbiAqICAgIOKaoCDlhZzlupXot68qKuS4jeWPluaZryoq77yI5a6D6K+755qE5pivIEdMIOWQjuWkh+e8k+WGsu+8jGBmaXRgIOWPquWvuSBFbGVjdHJvbiDpgqPmnaHot6/nlJ/mlYjvvInjgIJcbiAqXG4gKiAjIyBgZml0YCDmmK/lubLku4DkuYjnmoTvvIgqKueUqOaIt+e8qeaUvui/h+S5i+WQju+8jOWxj+W5leS4iumCo+S4gOW4p+acquW/heaYr+WFqOaZryoq77yJXG4gKlxuICogYGNhcHR1cmVQYWdlKClgIOaKk+eahOaYr+Wxj+W5leS4iueOsOWcqOi/meS4gOW4p+OAgueUqOaIt+aKiuWcuuaZr+inhuWbvue8qeaUvi/lubPnp7vov4fkuYvlkI7vvIxcbiAqIOaKk+WIsOeahOWwseWPquaYr+S7luW9k+aXtueci+eahOmCo+Wdl+WcsOaWueOAgmBmaXRgIOS8muWcqOaKk+S5i+WJjeaKiuebuOacuuaRhuWIsOOAjOahhuS9j+ebruagh+OAjeeahOS9jee9ru+8jFxuICog5oqT5a6MKirnq4vliLvov5jljp8qKu+8iOWbnuaJpyBgZnJhbWluZy5yZXN0b3JlZGAg6K+05piO6L+Y5Y6f5oiQ5Yqf5rKh5pyJ77yJ77yaXG4gKlxuICogfCBmaXQgfCDooYzkuLogfFxuICogfC0tLXwtLS18XG4gKiB8IGBhdXRvYO+8iOm7mOiupO+8iSB8IOaIquaVtOW8oOinhuWbvu+8muWGheWuueayoeaLjeWFqCAqKuaIlioqIOWGheWuueWwj+W+l+eci+S4jea4he+8iOWNoOavlCA8IDAuMTXvvInmiY3lj5bmma/vvJvmiKroioLngrnvvJrlj6rlnKjoioLngrnmsqHooqvmi43lhajml7blj5bmma8gfFxuICogfCBgc2NlbmVgIHwg5by65Yi25qGG5L2PKirmlbTkuKrlnLrmma/lhoXlrrkqKiB8XG4gKiB8IGBub2RlYCB8IOW8uuWItuahhuS9jyoq55uu5qCH6IqC54K5KirvvIjopoHlkIzml7bnu5kgYG5vZGVg77yJIHxcbiAqIHwgYG5vbmVgIHwg5LiN5Yqo55u45py677yM5bCx5oiq546w5Zyo6L+Z5LiA5bin77yI5Zue5omn6YeM5LuN5Lya5ZGK6K+J5L2g5ouN5YWo5rKh5pyJ77yJIHxcbiAqXG4gKiAjIyBgdmlld2Ag5piv5bmy5LuA5LmI55qE77yIKirlkIzkuIDlnZfnlLvluIPvvIzkuKTnp43nlLvpnaIqKu+8iVxuICpcbiAqIOe8lui+keWZqOmHjOmCo+Wdl+WcuuaZr+inhuWbvioq5ZCM5LiA5pe25Yi75Y+q55S75LiA5qC35Lic6KW/KirvvJrnvJbovpHmgIHnmoTnvJbovpHlmajlnLrmma/vvIzmiJbogIXov5DooYzpooTop4hcbiAqIO+8iGdhbWUgdmlld++8iei3keedgOeahOa4uOaIj+eUu+mdoiDigJTigJQg5Lik6ICF55SoKirkuI3lkIznmoTnm7jmnLoqKuOAguaJgOS7pe+8mlxuICpcbiAqIHwgdmlldyB8IOihjOS4uiB8XG4gKiB8LS0tfC0tLXxcbiAqIHwgYGF1dG9g77yI6buY6K6k77yJIHwg5LiN566h77yM5oiq546w5Zyo6L+Z5LiA5bin77yb5Zue5omnIGBtb2RlLmFjdHVhbGAg6K+05piOKirmiKrliLDnmoTliLDlupXmmK/lk6rkuIDnp40qKiB8XG4gKiB8IGBzY2VuZWAgfCDopoHnvJbovpHlmajlnLrmma/vvJvmi7/liLDov5DooYzmgIHnlLvpnaLml7YqKuaYjuivtOS4jeWvuSoq77yIYG5vdGVgICsgYG1vZGUucnVubmluZ2DvvIkgfFxuICogfCBgZ2FtZWAgfCDopoHot5HnnYDnmoTmuLjmiI/vvJvov5DooYzmgIHkuIsqKuS4jeWPluaZr+OAgeS4jeijgeiKgueCuSoq77yI5Lik6ICF6YO95bu656uL5Zyo57yW6L6R5Zmo55u45py65LiK77yJ77yM5bm26K+05piO5Li65LuA5LmIIHxcbiAqXG4gKiBgdmlldzpcInByZXZpZXdcImAg5oyJIGBnYW1lYCDnkIbop6PlubbpmYTkuIDlj6Xor7TmmI7vvIjmtY/op4jlmagv5qih5ouf5Zmo6aKE6KeI5piv5Y+m5LiA5Liq5bqU55So77yM5aSf5LiN552A77yJ44CCXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIGB7c2F2ZVBhdGg/LCBtYXhXaWR0aD8sIGZvcm1hdD8sIHF1YWxpdHk/LCBub2RlPywgcGFkZGluZz8sIGZpdD8sIHZpZXc/LCB3YWl0TXM/LCB0aW1lb3V0TXM/fWDjgIJcbiAqIEByZXR1cm5zIGBkYXRhLnBhdGhgIOaYr+WbvueJh+e7neWvuei3r+W+hO+8jOWPr+ebtOaOpeWWgue7meWbvueJh+ivu+WPluW3peWFt++8m1xuICogICBgZGF0YS5mcmFtaW5nYCDmmK/lj5bmma/otKbmnKzvvIjlj5bmma/liY0v5ZCO55qE6KaG55uW546H44CB55So5LqG5ZOq5LiA57qn44CB6L+Y5Zue5Y675rKh5pyJ77yJ77ybXG4gKiAgIGBkYXRhLm1vZGVgIOaYr1wi6L+Z5byg5Zu+5Yiw5bqV55S755qE5piv5ZOq5LiA56eN55S76Z2iXCLvvIhgcmVxdWVzdGVkYCAvIGBhY3R1YWxgIC8gYHJ1bm5pbmdg77yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlVmlldyhwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBjb25zdCBmb3JtYXQgPSBwYXJhbXMuZm9ybWF0ID09PSAnanBlZycgfHwgcGFyYW1zLmZvcm1hdCA9PT0gJ2pwZycgPyAnanBlZycgOiAncG5nJztcbiAgICBjb25zdCBzYXZlUGF0aCA9XG4gICAgICAgIHR5cGVvZiBwYXJhbXMuc2F2ZVBhdGggPT09ICdzdHJpbmcnICYmIHBhcmFtcy5zYXZlUGF0aC50cmltKClcbiAgICAgICAgICAgID8gcGF0aC5yZXNvbHZlKHBhcmFtcy5zYXZlUGF0aC50cmltKCkpXG4gICAgICAgICAgICA6IGRlZmF1bHRDYXB0dXJlUGF0aChmb3JtYXQpO1xuICAgIGNvbnN0IG1heFdpZHRoID0gY2xhbXBJbnQocGFyYW1zLm1heFdpZHRoLCAzMiwgNDA5NiwgNjQwKTtcbiAgICBjb25zdCBxdWFsaXR5ID1cbiAgICAgICAgdHlwZW9mIHBhcmFtcy5xdWFsaXR5ID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUocGFyYW1zLnF1YWxpdHkpXG4gICAgICAgICAgICA/IE1hdGgubWluKDEsIE1hdGgubWF4KDAuMSwgcGFyYW1zLnF1YWxpdHkpKVxuICAgICAgICAgICAgOiAwLjk7XG4gICAgY29uc3Qgd2FpdE1zID0gY2xhbXBJbnQocGFyYW1zLndhaXRNcywgMCwgNTAwMCwgODAwKTtcbiAgICBjb25zdCB0aW1lb3V0TXMgPSBjbGFtcFRpbWVvdXQocGFyYW1zLnRpbWVvdXRNcywgU0FOREJPWF9ERUZBVUxUUy50aW1lb3V0TXMpO1xuICAgIC8qKiDoioLngrnlvJXnlKjvvJp1dWlkIOaIlui3r+W+hO+8iGBDYW52YXMvc2tpbGxfZGV0YWlsc2DvvInjgILnu5nkuoblsLHlj6rmiKrov5nkuKroioLngrnjgIIgKi9cbiAgICBjb25zdCBub2RlUmVmID0gdHlwZW9mIHBhcmFtcy5ub2RlID09PSAnc3RyaW5nJyA/IHBhcmFtcy5ub2RlLnRyaW0oKSA6ICcnO1xuICAgIC8qKiDoioLngrnmiKrlm77ml7blkJHlpJbmianlh6Dlg4/ntKDvvIhDU1Mg5YOP57Sg77yJ77yM6buY6K6kIDAg4oCU4oCUIOaPj+i+uS/pmLTlvbHotLTovrnml7bnlKjlroPnlZnnmb3jgIIgKi9cbiAgICBjb25zdCBwYWRkaW5nID0gY2xhbXBJbnQocGFyYW1zLnBhZGRpbmcsIDAsIDQwMCwgMCk7XG4gICAgLyoqIOWPluaZr++8muingeS4iumdoueahOihqO+8m+S4jeiupOeahOWAvOaMiSBhdXRvIOWkhOeQhu+8iOWbnuaJp+mHjOS8muivtOS4gOWjsO+8ieOAgiAqL1xuICAgIGNvbnN0IGZpdCA9IG5vcm1hbGl6ZUZpdE1vZGUocGFyYW1zLmZpdCk7XG4gICAgLyoqIOimgeWTquS4gOenjeeUu+mdou+8iGBhdXRvYCAvIGBzY2VuZWAgLyBgZ2FtZWDvvInigJTigJQg6KeBIHtAbGluayBWaWV3VGFyZ2V0feOAgiAqL1xuICAgIGNvbnN0IHZpZXcgPSBub3JtYWxpemVWaWV3VGFyZ2V0KHBhcmFtcy52aWV3KTtcblxuICAgIC8vIC0tLS0g4pGgIEVsZWN0cm9uIOmAmumBk++8iOato+i3r++8iS0tLS1cbiAgICBjb25zdCB2aWFFbGVjdHJvbiA9IGF3YWl0IGNhcHR1cmVWaWV3VmlhRWxlY3Ryb24oe1xuICAgICAgICBzYXZlUGF0aCxcbiAgICAgICAgbWF4V2lkdGgsXG4gICAgICAgIGZvcm1hdCxcbiAgICAgICAgcXVhbGl0eSxcbiAgICAgICAgbm9kZVJlZixcbiAgICAgICAgcGFkZGluZyxcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXG4gICAgICAgIGZpdDogZml0Lm1vZGUsXG4gICAgICAgIHZpZXc6IHZpZXcubW9kZSxcbiAgICB9KTtcbiAgICBpZiAoJ3JlcGx5JyBpbiB2aWFFbGVjdHJvbikge1xuICAgICAgICAvKiogZml0IC8gdmlldyDlj4LmlbDlhpnplJnkuoblsLHor7TkuIDlo7DvvIjkuI3pmLvmlq3miKrlm77vvIkgKi9cbiAgICAgICAgaWYgKHZpYUVsZWN0cm9uLnJlcGx5LmRhdGEpIHtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSB2aWFFbGVjdHJvbi5yZXBseS5kYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgaWYgKGZpdC5ub3RlKSBkYXRhLmZpdE5vdGUgPSBmaXQubm90ZTtcbiAgICAgICAgICAgIGlmICh2aWV3Lm5vdGUpIHtcbiAgICAgICAgICAgICAgICBkYXRhLnZpZXdOb3RlID0gdmlldy5ub3RlO1xuICAgICAgICAgICAgICAgIC8qKiDov5nmmK9cIuino+ivu+S9oOeahOWPguaVsFwi55qE5LiA5Y+l6K+d77yM5q+U6KOB5YmqL+WPluaZr+mCo+S6m+e7huiKguabtOivpeiiq+eci+ingSAqL1xuICAgICAgICAgICAgICAgIGRhdGEubm90ZSA9IGRhdGEubm90ZSA/IGAke3ZpZXcubm90ZX3vvIjlj6bmnInvvJoke2RhdGEubm90ZX3vvIlgIDogdmlldy5ub3RlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2aWFFbGVjdHJvbi5yZXBseTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoSDlhZzlupXvvJrogIHnmoTlnLrmma/ov5vnqIvor7vlg4/ntKAgLS0tLVxuICAgIC8qKlxuICAgICAqIOWFnOW6lemAmumBk+ivu+eahOaYr+WcuuaZr+i/m+eoi+eahCBHTCDlkI7lpIfnvJPlhrLvvIwqKuayoeazleaRhuebuOacuioq77yI5Y+W5pmv6YKj5p2h6ZO+6KaB6Z2g5Li76L+b56iL6YCQ57qn6YeP44CBYGZpdFZpZXdgIOaJjeaOkuW+l+S4iu+8ie+8jFxuICAgICAqIOaJgOS7pSBgZml0YCDlnKjov5nmnaHot6/kuIoqKuS4jeeUn+aViCoqIOKAlOKAlCDkuI3nrqHov5nkuIDmraXmiJDotKXpg73opoHor7TmuIXvvIzlkKbliJnnlKjmiLfkvJrku6XkuLrmi7/liLDnmoTmmK/lhajmma/jgIJcbiAgICAgKi9cbiAgICBjb25zdCB3aXRoRml0Tm90ZSA9IChyZXBseTogVG9vbFJlcGx5KTogVG9vbFJlcGx5ID0+IHtcbiAgICAgICAgY29uc3QgZGF0YSA9IHJlcGx5LmRhdGE7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShkYXRhKSA/IChkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgICAgIGlmIChwYXlsb2FkICYmICFwYXlsb2FkLnZpZXdNb2RlKSB7XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIOWFnOW6lei3ryoq6YeP5LiN5Yiw5qih5byPKirvvIjlroPkuI3nu4/ov4cgYHZpZXdNZXRyaWNzYO+8ieKAlOKAlCDkvYbpgqPmraPmmK/mnIDopoHor7TmuIXnmoTkuIDlj6XvvJpcbiAgICAgICAgICAgICAqIOi/meadoei3r+S4iuaLv+WIsOeahOWPr+iDveaYr+WcuuaZr+OAgeS5n+WPr+iDveaYr+i3keedgOeahOa4uOaIj++8jOiAjOWbnuaJp+mHjOayoeacieS7u+S9leWtl+auteiDveWMuuWIhuOAglxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBwYXlsb2FkLnZpZXdNb2RlID0ge1xuICAgICAgICAgICAgICAgIHJlcXVlc3RlZDogdmlldy5tb2RlLFxuICAgICAgICAgICAgICAgIGFjdHVhbDogJ3Vua25vd24nLFxuICAgICAgICAgICAgICAgIG5vdGU6ICfov5nmnaHlhZzlupXpgJrpgZPliKTmlq3kuI3kuobov5nkuIDpobXnlLvnmoTmmK/lnLrmma/ov5jmmK/muLjmiI/vvIjlroPkuI3nu4/ov4fkuLvpgJrpgZPnmoTlh6DkvZXmjqLpkojvvIknLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodmlldy5ub3RlKSB7XG4gICAgICAgICAgICBpZiAocGF5bG9hZCkgcGF5bG9hZC52aWV3Tm90ZSA9IHZpZXcubm90ZTtcbiAgICAgICAgICAgIHJldHVybiByZXBseTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZml0Lm1vZGUgPT09ICdub25lJykgcmV0dXJuIHJlcGx5O1xuICAgICAgICBpZiAoIXBheWxvYWQgfHwgcGF5bG9hZC5maXRJZ25vcmVkKSByZXR1cm4gcmVwbHk7XG4gICAgICAgIHBheWxvYWQuZml0SWdub3JlZCA9XG4gICAgICAgICAgICAn6L+Z5p2h5YWc5bqV6YCa6YGT77yI5Zy65pmv6L+b56iL6K+75YOP57Sg77yJ5LiN5Y+W5pmvIOKAlOKAlCDlm57miafph4zov5nlvKDlm77mmK8qKuW9k+WJjeinhuinkioq6YKj5LiA5bin77yb5oOz5ouN5YWo5bCx5L+u5aW95Li76YCa6YGT77yI55yLIGVsZWN0cm9uRmFsbGJhY2vvvInvvIzmiJblhYjoh6rlt7Hmiorop4bop5LosIPlpb3lho3miKonO1xuICAgICAgICByZXR1cm4gcmVwbHk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJ1biA9IGF3YWl0IHJ1blNjZW5lQ29kZShDQVBUVVJFX1ZJRVdfU0NFTkVfQ09ERSwgeyBzYXZlUGF0aCwgbWF4V2lkdGgsIGZvcm1hdCwgcXVhbGl0eSwgd2FpdE1zIH0sIHRpbWVvdXRNcywgZmFsc2UpO1xuXG4gICAgY29uc3QgZW52ZWxvcGUgPSBydW4uZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWVudmVsb3BlIHx8IGVudmVsb3BlLm9rICE9PSB0cnVlKSB7XG4gICAgICAgIC8vIOWcuuaZr+S+p+W3sue7j+aKiuWOn+WboOivtOa4healmuS6hu+8iOayoeW8gOWcuuaZryAvIOaJp+ihjOaKpemUme+8ie+8jOWOn+agt+S8oOWbnuWOu1xuICAgICAgICByZXR1cm4gd2l0aEZpdE5vdGUocnVuKTtcbiAgICB9XG5cbiAgICBjb25zdCBjYXB0dXJlZCA9IGVudmVsb3BlLnJlc3VsdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWNhcHR1cmVkIHx8IGNhcHR1cmVkLm9rICE9PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiB3aXRoRml0Tm90ZShcbiAgICAgICAgICAgIGNhcHR1cmVGYWlsKFN0cmluZygoY2FwdHVyZWQgJiYgY2FwdHVyZWQuZXJyb3IpIHx8ICfmiKrlm77lpLHotKXvvIjlnLrmma/kvqfmsqHmnInov5Tlm57lm77niYfvvIknKSwge1xuICAgICAgICAgICAgICAgIHNjZW5lOiBjYXB0dXJlZCA/PyBudWxsLFxuICAgICAgICAgICAgICAgIGVsZWN0cm9uRmFsbGJhY2s6IHZpYUVsZWN0cm9uLmZhbGxiYWNrLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLy8g5Zy65pmv5L6n6IO96JC955uY5bCx6JC955uY5LqG77yI6L+U5ZueIHBhdGjvvInvvJvlkKbliJnlm57kvKDliIblnZcgYmFzZTY077yM6L+Z6YeM5ou85Zue5p2l5YaZ55uYIOKAlOKAlFxuICAgIC8vIOaymeeusei/lOWbnuWAvOacieOAjOWNleWtl+espuS4siA0MDAwIOWtl+OAjeS4iumZkO+8jOaVtOW8oOWbvuWhnuS4jei/m+S4gOS4quWtl+auteOAglxuICAgIGNvbnN0IGZpbGVQYXRoID0gdHlwZW9mIGNhcHR1cmVkLnBhdGggPT09ICdzdHJpbmcnICYmIGNhcHR1cmVkLnBhdGggPyBjYXB0dXJlZC5wYXRoIDogc2F2ZVBhdGg7XG4gICAgaWYgKGNhcHR1cmVkLnRyYW5zcG9ydCAhPT0gJ2ZpbGUnKSB7XG4gICAgICAgIGNvbnN0IGNodW5rcyA9IEFycmF5LmlzQXJyYXkoY2FwdHVyZWQuY2h1bmtzKSA/IGNhcHR1cmVkLmNodW5rcy5tYXAoKGMpID0+IFN0cmluZyhjKSkgOiBbXTtcbiAgICAgICAgY29uc3QgYmFzZTY0ID0gY2h1bmtzLmpvaW4oJycpO1xuICAgICAgICBpZiAoIWJhc2U2NCkgcmV0dXJuIHdpdGhGaXROb3RlKGNhcHR1cmVGYWlsKCfmiKrlm77msqHmnInkuqflh7rlm77niYfmlbDmja4nLCB7IHNjZW5lOiBjYXB0dXJlZCB9KSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBkaXIgPSBwYXRoLmRpcm5hbWUoZmlsZVBhdGgpO1xuICAgICAgICAgICAgaWYgKGRpcikgZnMubWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBCdWZmZXIuZnJvbShiYXNlNjQsICdiYXNlNjQnKSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcmV0dXJuIHdpdGhGaXROb3RlKGNhcHR1cmVGYWlsKGDlhpnlhaXmiKrlm77mlofku7blpLHotKXvvJoke2Rlc2NyaWJlKGVycil9YCwgeyBwYXRoOiBmaWxlUGF0aCwgc2NlbmU6IGNhcHR1cmVkIH0pKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGxldCBieXRlcyA9IHR5cGVvZiBjYXB0dXJlZC5ieXRlcyA9PT0gJ251bWJlcicgPyBjYXB0dXJlZC5ieXRlcyA6IDA7XG4gICAgdHJ5IHtcbiAgICAgICAgYnl0ZXMgPSBmcy5zdGF0U3luYyhmaWxlUGF0aCkuc2l6ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyog5bC65a+46K+75LiN5Yiw5LiN5b2x5ZON5L2/55SoICovXG4gICAgfVxuXG4gICAgY29uc3QgYmxhbmtSYXRpbyA9IHR5cGVvZiBjYXB0dXJlZC5ibGFua1JhdGlvID09PSAnbnVtYmVyJyA/IGNhcHR1cmVkLmJsYW5rUmF0aW8gOiBudWxsO1xuICAgIGNvbnN0IGJsYW5rID0gYmxhbmtSYXRpbyAhPT0gbnVsbCAmJiBibGFua1JhdGlvID49IDAuOTU7XG5cbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIC8qKiDop4EgY2FwdHVyZVZpZXcg55qE5rOo6YeK77ya6L+Z5LiA5p2h5pivKirlhZzlupXot68qKu+8iOWcuuaZr+i/m+eoi+ivuyBHTCDlkI7lpIfnvJPlhrLvvIkgKi9cbiAgICAgICAgbWV0aG9kOiAnc2NlbmUtZ2wnLFxuICAgICAgICBwYXRoOiBmaWxlUGF0aCxcbiAgICAgICAgd2lkdGg6IGNhcHR1cmVkLndpZHRoLFxuICAgICAgICBoZWlnaHQ6IGNhcHR1cmVkLmhlaWdodCxcbiAgICAgICAgc291cmNlV2lkdGg6IGNhcHR1cmVkLnNvdXJjZVdpZHRoLFxuICAgICAgICBzb3VyY2VIZWlnaHQ6IGNhcHR1cmVkLnNvdXJjZUhlaWdodCxcbiAgICAgICAgZm9ybWF0OiBjYXB0dXJlZC5mb3JtYXQgPz8gZm9ybWF0LFxuICAgICAgICBieXRlcyxcbiAgICAgICAgYmxhbmtSYXRpbyxcbiAgICAgICAgLy8g6KeG5Zu+54q25oCB77yIdmlzaWJsZVNpemUgLyBkZXNpZ25SZXNvbHV0aW9uIC8gY2FudmFzIC8gdmlzaWJsZU1hdGNoZXNEZXNpZ27vvInigJTigJRcbiAgICAgICAgLy8g56m655m95bin5pe255So5p2l5Yik5pat44CM5piv5LiN5piv57yW6L6R5Zmo5Zy65pmv6KeG5Zu+55qE6K6+5aSH5qih5ouf6KKr5pS56L+H44CNXG4gICAgICAgIHZpZXc6IGNhcHR1cmVkLnZpZXcgPz8gbnVsbCxcbiAgICAgICAgdHJhbnNwb3J0OiBjYXB0dXJlZC50cmFuc3BvcnQgPT09ICdmaWxlJyA/ICdzY2VuZScgOiAnZWRpdG9yJyxcbiAgICAgICAgLyoqIEVsZWN0cm9uIOmAmumBk+S4uuS7gOS5iOayoeaOpeaJiyDigJTigJQg5Y+q5Zue44CM6ICB6Lev55qE5Zu+44CN77yM5L2G5b+F6aG76K+05riF5Li65LuA5LmI6YCA5Zue5p2l5LqGICovXG4gICAgICAgIGVsZWN0cm9uRmFsbGJhY2s6IHZpYUVsZWN0cm9uLmZhbGxiYWNrLFxuICAgICAgICBlbGVjdHJvbkNvbnRlbnRzOiBnZXRFbGVjdHJvbigpID8gbGlzdENvbnRlbnRzKCkgOiBudWxsLFxuICAgICAgICBoaW50OiBibGFuayA/IENBUFRVUkVfQkxBTktfSElOVCA6IENBUFRVUkVfUkVBRF9ISU5ULFxuICAgIH07XG4gICAgaWYgKGNhcHR1cmVkLnNhdmVFcnJvcikgcGF5bG9hZC5zY2VuZVdyaXRlRXJyb3IgPSBjYXB0dXJlZC5zYXZlRXJyb3I7XG4gICAgaWYgKGZpdC5ub3RlKSBwYXlsb2FkLmZpdE5vdGUgPSBmaXQubm90ZTtcblxuICAgIHJldHVybiB3aXRoRml0Tm90ZSh7IG9rOiB0cnVlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZGF0YTogcGF5bG9hZCB9KTtcbn1cblxuLyoqIOaOoua0u++8muWcuuaZr+i/m+eoi+mHjOacrOaJqeWxleeahOiEmuacrOWKoOi9veS6huWQl++8iGBjb2Nvc19lZGl0b3Jfc3RhdGVgIOeUqOWug+ivtOaYjuOAjOiDveS4jeiDveWKqOWcuuaZr+OAje+8ieOAgiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBpbmdTY2VuZVNjcmlwdCgpOiBQcm9taXNlPHsgYXZhaWxhYmxlOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgY2FsbFNjZW5lU2NyaXB0PHsgb2s/OiBib29sZWFuIH0+KFNDRU5FX01FVEhPRC5waW5nKTtcbiAgICAgICAgcmV0dXJuIHZhbHVlICYmIHZhbHVlLm9rID8geyBhdmFpbGFibGU6IHRydWUgfSA6IHsgYXZhaWxhYmxlOiBmYWxzZSwgcmVhc29uOiAn5Zy65pmv6ISa5pys6L+U5Zue5byC5bi4JyB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBhdmFpbGFibGU6IGZhbHNlLCByZWFzb246IGRlc2NyaWJlKGVycikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog5LiA5Liq6IqC54K55ZyoKirpobXpnaLkuIrnmoTkvY3nva4qKu+8iOeCueWugyAvIOijgeWugyAvIOmHj+Wug+mDveimgeeahOmCo+S4gOS7veWHoOS9le+8ieOAglxuICpcbiAqIOWkjeeUqOaIquWbvumCo+adoei3r+eahOWQjOS4gOS7veaKleW9se+8iGB2aWV3TWV0cmljc2DvvInvvJrov5nmoLfjgIzmiKrlm77oo4Hlh7rmnaXnmoTnn6nlvaLjgI3kuI7jgIzngrnlh7vokL3kuIvnmoTngrnjgI1cbiAqIOWkqeeEtuaYr+WQjOS4gOWll+WdkOaghyDigJTigJQg5Lik5aSE5ZCE566X5LiA5qyh55qE6K+d77yM6L+f5pep5Ye6546wXCLmiKrliLDnmoTlkozngrnliLDnmoTlt67ljYrkuKroioLngrlcIuOAglxuICpcbiAqIEBwYXJhbSBub2RlUmVmIC0g6IqC54K5IHV1aWQg5oiW6Lev5b6E77yb56m65LiyID0g5Y+q6KaB6aG16Z2i5Yeg5L2V77yI5LiN6KaB6IqC54K555+p5b2i77yJ44CCXG4gKiBAcmV0dXJucyBge29rLCBwYWdlLCBjYW52YXMsIGNhbWVyYSwgcnVudGltZSwgbm9kZT8sIGVycm9yP31g77yb5ou/5LiN5Yiw5bCx5pivIGB7b2s6ZmFsc2UsIGVycm9yfWDvvIjkuI3mipvvvInjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWROb2RlR2VvbWV0cnkobm9kZVJlZjogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBhbnk+PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWV0cmljcyA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCBhbnk+PihTQ0VORV9NRVRIT0Qudmlld01ldHJpY3MsIFtcbiAgICAgICAgICAgIHsgbm9kZTogbm9kZVJlZiB8fCB1bmRlZmluZWQsIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoIH0sXG4gICAgICAgIF0pO1xuICAgICAgICBpZiAoIW1ldHJpY3MgfHwgbWV0cmljcy5vayAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoKG1ldHJpY3MgJiYgbWV0cmljcy5lcnJvcikgfHwgJ3ZpZXdNZXRyaWNzIOayoee7meWHuuWHoOS9lScpIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1ldHJpY3M7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGRlc2NyaWJlKGVycikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog6L+Q6KGM5oCB5o6i6ZKI77ya6Zeu5Zy65pmv6ISa5pys44CM6L+Z5LiA6aG1546w5Zyo55S755qE5piv57yW6L6R5Zmo5Zy65pmv77yM6L+Y5piv6LeR552A55qE5ri45oiP44CN44CCXG4gKlxuICog5Y+W55qE5pivIGB2aWV3TWV0cmljc2Ag55qEIGBydW50aW1lYCDpgqPkuIDlnZfvvIjop4EgYHNvdXJjZS9zY2VuZS50c2Ag55qEIGByZWFkU2NlbmVNb2RlYO+8ieKAlOKAlFxuICogKirkuI3lnKjkuLvov5vnqIvlj6bmioTkuIDku73liKTlrpoqKu+8muaooeW8j+aYr+S7juWcuuaZr+i/m+eoi+mHjOmCo+WHoOS4qiBgY2NlYCDljZXkvovor7vlh7rmnaXnmoTvvIxcbiAqIOaKhOS4gOS7veeahOS4i+WcuuaYr+S4pOWkhOWvueWQjOS4gOS4que8lui+keWZqOeKtuaAgeWQhOivtOWQhOivneOAglxuICpcbiAqIOWPquW4piBge31gIOWPguaVsO+8iOS4jeimgeiKgueCueefqeW9ouOAgeS4jeimgeWPluaZr++8ie+8jOaJgOS7peWug+W+iOi9u++8muS4gOasoeWcuuaZr+i/m+eoi+W+gOi/lOOAglxuICpcbiAqIEByZXR1cm5zIOaLv+WIsOWwseaYryBge29rOnRydWUsIHJ1bnRpbWV9YO+8m+WcuuaZr+S4jeWPr+eUqOWwsSBge29rOmZhbHNlLCBlcnJvcn1g77yI5LiN5oqb77yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkU2NlbmVSdW50aW1lKCk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgcnVudGltZT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWV0cmljcyA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCBhbnk+PihTQ0VORV9NRVRIT0Qudmlld01ldHJpY3MsIFt7fV0pO1xuICAgICAgICBpZiAoIW1ldHJpY3MgfHwgbWV0cmljcy5vayAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoKG1ldHJpY3MgJiYgbWV0cmljcy5lcnJvcikgfHwgJ3ZpZXdNZXRyaWNzIOayoee7meWHuue7k+aenCcpIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcnVudGltZSA9IChtZXRyaWNzLnJ1bnRpbWUgfHwgbnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsO1xuICAgICAgICBpZiAoIXJ1bnRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICflnLrmma/ohJrmnKzmsqHmnInmiqUgcnVudGltZe+8iOi/meS4queJiOacrOeahOacrOaJqeWxleiEmuacrOavlOS4u+i/m+eoi+aXp++8n++8iScgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcnVudGltZSB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnIpIH07XG4gICAgfVxufVxuXG4vKipcbiAqIOWcuuaZr+S+p+eahOWPjeWwhCDigJTigJQg6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yI6YKjIDIwMCDlpJrooYzjgIzku44gYF9fcHJvcHNfX2AgKyDlrp7ml7blrp7kvovor7vlsZ7mgKflkI3jgI1cbiAqIOeahOmAu+i+keS4gOihjOmDveS4jeeUqOmHjeWGme+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVzY3JpYmVTY2VuZUFwaShcbiAgICB0YXJnZXQ6IHN0cmluZyxcbiAgICBub2RlVXVpZDogc3RyaW5nLFxuICAgIGxpbWl0OiBudW1iZXIsXG4pOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgdmFsdWUgPSAoYXdhaXQgY2FsbFNjZW5lU2NyaXB0PFJlY29yZDxzdHJpbmcsIHVua25vd24+PihTQ0VORV9NRVRIT0QuZGVzY3JpYmVBcGksIFtcbiAgICAgICAgeyB0YXJnZXQsIG5vZGVVdWlkOiBub2RlVXVpZCB8fCB1bmRlZmluZWQsIGxpbWl0IH0sXG4gICAgXSkpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5Zy65pmv6ISa5pysIGRlc2NyaWJlQXBpIOayoeaciei/lOWbnue7k+aenOOAgicpO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iXX0=