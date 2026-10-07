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
const CAPTURE_BLANK_HINT = '这是空图（blankRatio≈1），**别再重试截图** —— Electron 通道已经 `invalidate()` 逼过一次重绘，' +
    '换 waitMs / 重新聚焦 / 换 maxWidth 都不会变。先看 `view` 再决定，按顺序做：' +
    '① `view.visibleMatchesDesign === false`：编辑器场景视图的**设备模拟被改过**（历史上是有人调了 `cc.view.setDesignResolutionSize`）—— 在场景视图工具栏重新选一次设备分辨率即可恢复，纯视图设置、不影响场景与预制件数据；' +
    '② `view.visibleMatchesDesign === true` 却仍然空：说明**这个环境当下确实取不到画面**（编辑器最小化、场景视图面板被折叠或从未渲染）—— 不要自建离屏渲染器（历史上有人为此花了 16 步），直接转数值判据；' +
    '③ 画面验收改用**数值判据**：`worldRect(node)` 拿真实世界矩形 / 自己算重叠与越界 / 逐节点读 color·contentSize；' +
    '④ 确实需要肉眼确认时，按节点真实数据出一张布局对照图（历史做法：`worldRect` 导出行 → 脚本画 PNG → 图片读取），并在交付里**如实声明「真实渲染截图未完成」**。';
/**
 * `auto` 模式下「内容小得看不清」的判据：内容与画布的交集面积占比低于它就顺手取景。
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
        (0, capture_1.invalidateSceneView)(href);
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
    var _a, _b, _c, _d;
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
    // ② 取景（`fit`）：用户缩放/平移过之后，屏幕上那一帧未必是「全景」——
    //    按需要把目标框进画布，截完再还原视角（见 runFitChain）。
    let framing = {
        requested: options.fit,
        applied: null,
        method: null,
        before: pickCoverage(metrics),
        after: pickCoverage(metrics),
    };
    let fitNote;
    const wanted = decideFit(options.fit, options.nodeRef, framing.before);
    if (wanted) {
        try {
            const result = await runFitChain(wanted, options.nodeRef, options.projectPath, metrics, href);
            framing = { requested: options.fit, ...result.framing };
            /** ⚠ 相机动过 → 节点矩形必须用**新的**那一份（旧的已经不成立了） */
            metrics = result.metrics;
            fitNote = result.fitNote;
            const newPage = (metrics.page || {});
            if (typeof newPage.href === 'string' && newPage.href)
                href = newPage.href;
        }
        catch (err) {
            /** 取景是**加分项**：它失败不该让截图失败 —— 如实记一笔，继续按当前取景截 */
            framing.requested = options.fit;
            framing.applied = wanted;
            framing.note = `取景没做成（${describe(err)}）—— 回执里这张图是**当前视角**那一帧`;
            fitNote = framing.note;
        }
    }
    else if (options.fit === 'none' && framing.before && framing.before.covered !== true) {
        framing.note = '`fit:"none"` 按原样截 —— 但量下来目标**没有被拍全**，想拍全就传 `fit:"scene"`';
    }
    else if (options.fit === 'node' && !options.nodeRef) {
        framing.note = '`fit:"node"` 需要同时给 `node`（这次没给）—— 按当前视角原样截';
    }
    else if (options.fit === 'auto' && !options.nodeRef && framing.before) {
        /**
         * 「不用取景」是**正常情况**，所以不写 `note`（约定：`note` 非空 = 有事）——
         * 把"为什么没动相机"记在 `why` 里，需要解释时看得到。
         */
        framing.why =
            framing.before.covered === true
                ? `内容已经整个在画布里（areaRatio ${framing.before.areaRatio} ≥ ${FIT_SMALL_RATIO}）—— 按原样截，没动相机`
                : '量不到覆盖情况';
    }
    // ③ 抓图（空图会自动 invalidate 重抓一次，见 capture.ts）
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
        if (!nodeInfo || nodeInfo.found !== true) {
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
        // 抓的是哪一个 webContents —— 编辑器里可能同时有场景视图与游戏预览，抓错时靠它一眼看出来
        contents: outcome.target,
        matchedBy: outcome.matchedBy,
        /** 第一张是空图、靠 `invalidate()` 逼出第二张时为 true */
        useInvalidate: outcome.usedInvalidate,
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
        page: (_b = metrics.page) !== null && _b !== void 0 ? _b : null,
        canvas: (_c = metrics.canvas) !== null && _c !== void 0 ? _c : null,
        camera: (_d = metrics.camera) !== null && _d !== void 0 ? _d : null,
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
 *    `webContents.capturePage()` 抓**合成后的 surface**，空图时 `invalidate()` 逼一次重绘。
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
 * @param params - `{savePath?, maxWidth?, format?, quality?, node?, padding?, fit?, waitMs?, timeoutMs?}`。
 * @returns `data.path` 是图片绝对路径，可直接喂给图片读取工具；
 *   `data.framing` 是取景账本（取景前/后的覆盖率、用了哪一级、还回去没有）。
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
    });
    if ('reply' in viaElectron) {
        /** fit 参数写错了就说一声（不阻断截图） */
        if (fit.note && viaElectron.reply.data) {
            const data = viaElectron.reply.data;
            data.fitNote = fit.note;
        }
        return viaElectron.reply;
    }
    // ---- ② 兜底：老的场景进程读像素 ----
    /**
     * 兜底通道读的是场景进程的 GL 后备缓冲，**没法摆相机**（取景要靠主进程 `invalidate()` 逼帧配合），
     * 所以 `fit` 在这条路上**不生效** —— 不管这一步成败都要说清，否则用户会以为拿到的是全景。
     */
    const withFitNote = (reply) => {
        if (fit.mode === 'none')
            return reply;
        const data = reply.data;
        if (!data || typeof data !== 'object' || data.fitIgnored)
            return reply;
        data.fitIgnored =
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5naW5lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL2NvcmUvZW5naW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E2Qkc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBbVpILHNDQXlHQztBQVdELG9DQTRGQztBQTZKRCxrQ0FvREM7QUFrZkQsa0NBMkhDO0FBR0QsMENBT0M7QUFNRCw0Q0FhQztBQTU3Q0QsdUNBQXlCO0FBQ3pCLHVDQUF5QjtBQUN6QiwyQ0FBNkI7QUFHN0Isd0NBVW9CO0FBQ3BCLHVDQUttQjtBQUNuQixpREFBd0U7QUFDeEUsdUNBQXlDO0FBQ3pDLDJDQUFpRjtBQUlqRiwwQ0FBMEM7QUFDMUMsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBRTNELHdEQUF3RDtBQUN4RCxNQUFNLGdCQUFnQixHQUFHO0lBQ3JCLCtDQUErQztJQUMvQyxTQUFTLEVBQUUsS0FBSztJQUNoQixPQUFPLEVBQUUsR0FBRztJQUNaLFlBQVksRUFBRSxJQUFJO0NBQ3JCLENBQUM7QUFFRixrRUFBa0U7QUFDbEUsTUFBTSxpQkFBaUIsR0FBOEI7SUFDakQsUUFBUSxFQUFFLENBQUM7SUFDWCxjQUFjLEVBQUUsR0FBRztJQUNuQixhQUFhLEVBQUUsRUFBRTtJQUNqQixlQUFlLEVBQUUsSUFBSTtDQUN4QixDQUFDO0FBRUYscUVBQXFFO0FBQ3JFLE1BQU0sWUFBWSxHQUFHO0lBQ2pCLElBQUksRUFBRSxNQUFNO0lBQ1osT0FBTyxFQUFFLFNBQVM7SUFDbEIsV0FBVyxFQUFFLGFBQWE7SUFDMUIsaURBQWlEO0lBQ2pELFdBQVcsRUFBRSxhQUFhO0lBQzFCLHdEQUF3RDtJQUN4RCxPQUFPLEVBQUUsU0FBUztDQUNaLENBQUM7QUFFWCxtQkFBbUI7QUFDbkIsU0FB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QUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3JELFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUMxRCxDQUFDO0lBRUQsTUFBTSxNQUFNLEdBQUcsQ0FBQyxHQUFXLEVBQVUsRUFBRSxDQUFDLENBQUMsV0FBVyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEdBQUcsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzlGLE1BQU0sT0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUMzRCxNQUFNLGFBQWEsR0FBRyxXQUFXLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsYUFBYSxHQUFHLFdBQVcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xHLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxDQUFDO1NBQy9DLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDM0IsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7U0FDWCxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtRQUNYLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUs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LFNBQVMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO0lBQ3ZELENBQUM7QUFDTCxDQUFDO0FBRUQ7OztHQUdHO0FBQ0ksS0FBSyxVQUFVLGdCQUFnQixDQUNsQyxNQUFjLEVBQ2QsUUFBZ0IsRUFDaEIsS0FBYTtJQUViLE1BQU0sS0FBSyxHQUFHLENBQUMsTUFBTSxJQUFBLDhCQUFlLEVBQTBCLFlBQVksQ0FBQyxXQUFXLEVBQUU7UUFDcEYsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLFFBQVEsSUFBSSxTQUFTLEVBQUUsS0FBSyxFQUFFO0tBQ3JELENBQUMsQ0FBd0MsQ0FBQztJQUUzQyxJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ3RDLE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLENBQUMsQ0FBQztJQUNoRCxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog57yW6L6R5Zmo5omn6KGM5byV5pOOIOKAlOKAlCBkc2hfY2hhdCDoh6rlt7HnmoTjgIzku6PnoIHmspnnrrHjgI3vvIzkuI3lho3lgJ8gZGZhbl9tY3Ay44CCXG4gKlxuICogIyMg6L+Z5LiA5bGC5Zyo5ZOq44CB5bmy5LuA5LmIXG4gKlxuICogYGBgXG4gKiBEU0gg5a2Q6L+b56iLIC0tZm9yayBJUEMtLT4g5pys5omp5bGV5Li76L+b56iLKGNvY29zLXRvb2xzKSAtLT4g5pys5qih5Z2XXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSc4pSAIGVkaXRvciDkuIrkuIvmlofvvJp2bSDmspnnrrHvvIhjb3JlL3NhbmRib3jvvIlcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilJTilIAgc2NlbmUg5LiK5LiL5paH77ya5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yIc291cmNlL3NjZW5lLnRz77yJXG4gKiBgYGBcbiAqXG4gKiDlhajnqIsqKuS4jee7j+i/hyBsb29wYmFjayBIVFRQKirvvIjlr7nmr5QgTUNQIOeahCAxMjcuMC4wLjE6ODczMe+8ie+8jOS5n+S4jee7j+i/h+esrOS6jOS4quaJqeWxle+8mlxuICog5Zy65pmv6ISa5pys5piv5pys5omp5bGVIGBjb250cmlidXRpb25zLnNjZW5lYCDoh6rlt7Hms6jlhoznmoTvvIhgZGlzdC9zY2VuZS5qc2DvvInvvIxcbiAqIOS4u+i/m+eoi+S+p+eahOaJp+ihjOWZqOWwseaYr+acrOaWh+S7tuOAguiDveWKm+mdouS4juWOn+WFiOWkjeeUqOeahOmCo+Wllyoq6YCQ5p2h5a+56b2QKirvvJpcbiAqIOWQjOS4gOWll+i2heaXtuWPo+W+hOOAgeWQjOS4gOWll+W6j+WIl+WMluS4iumZkOOAgeWQjOS4gOWll+WKqeaJi++8iGBlYWNoTm9kZWAgLyBgdHJlZWAgLyBgbm9kZUJ5UGF0aGAgL1xuICogYGR1bXBgIC8gYHNuYXBzaG90YCAvIHJlY2lwZSDkupTku7blpZcg4oCm77yJ77yM5omA5Lul5qih5Z6L55qE55So5rOV5LiA5Liq5a2X6YO95LiN55So5pS544CCXG4gKlxuICogIyMg5Li65LuA5LmIIGVkaXRvciDkuI4gc2NlbmUg55qE5omn6KGM5pa55byP5LiN5ZCM77yI5LiN6IO957uf5LiA77yJXG4gKlxuICogLSAqKmVkaXRvcu+8iOacrOaooeWdl++8iSoq77yaYHZtLmNyZWF0ZUNvbnRleHRgIOmalOemu+aymeeuseOAguS4u+i/m+eoi+mHjOi3ke+8jOmalOemu+i2iuS4pei2iuWlveOAglxuICogLSAqKnNjZW5l77yIc291cmNlL3NjZW5lLnRz77yJKirvvJpgdm0ucnVuSW5UaGlzQ29udGV4dGAg5ZCMIHJlYWxtICsg5ZCM5q2l6LaF5pe244CCXG4gKiAgIOW8leaTjui/m+eoiyoq5LiN6IO9KirmjaIgcmVhbG0g4oCU4oCUIOaymeeusemHjOmAoOWHuuadpeeahCBge31gIC8gYFtdYCDlnKjlvJXmk47nmoQgYGluc3RhbmNlb2ZgIOWIpOaWreS4i+S4uuWBh++8jFxuICogICDkvJrorqnkuIDloIblvJXmk44gQVBJIOWHuueOsOmavuafpeeahOivoeW8guihjOS4uuOAgue7huiKguingSBzY2VuZS50cyDlpLTpg6jms6jph4rjgIJcbiAqXG4gKiAjIyDotoXml7bnmoTor5rlrp7ovrnnlYxcbiAqXG4gKiBgdm1gIOeahCBgdGltZW91dGAg5Y+q566h5ZCM5q2l5q6177yb5byC5q2l6Z2gIGBQcm9taXNlLnJhY2VgIOiuoeaXtuWZqCDigJTigJQg5a6D5Y+q6K6pKirosIPnlKjmlrkqKuS4jeWGjeetie+8jFxuICogKirkuI3kvJrnnJ/nmoTmnYDmjokqKuW3sue7j+WcqOi3keeahOW8guatpeS7o+egge+8iE5vZGUg5rKh5pyJ5oqi5Y2g5byP5Y+W5raI77yJ44CCXG4gKiDmiYDku6XliKvlnKjmspnnrrHph4zlhpkgYGF3YWl0IG5ldyBQcm9taXNlKCgpID0+IHt9KWAg6L+Z56eN5LiN5Y+v57uT5p2f55qE562J5b6F44CCXG4gKi9cblxuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgb3MgZnJvbSAnb3MnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuaW1wb3J0IHsgdHlwZSBUb29sUmVwbHkgfSBmcm9tICcuLi9jb25zdGFudHMnO1xuaW1wb3J0IHtcbiAgICBjYXB0dXJlU2NlbmVWaWV3LFxuICAgIGNyb3BUb0Nzc1JlY3QsXG4gICAgZG93bnNjYWxlVG9XaWR0aCxcbiAgICBlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uLFxuICAgIGVuY29kZUltYWdlLFxuICAgIGdldEVsZWN0cm9uLFxuICAgIGltYWdlU2l6ZU9mLFxuICAgIGludmFsaWRhdGVTY2VuZVZpZXcsXG4gICAgbGlzdENvbnRlbnRzLFxufSBmcm9tICcuLi9jYXB0dXJlJztcbmltcG9ydCB7XG4gICAgYnVpbGRSZWNpcGVIZWxwZXJzLFxuICAgIFJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyxcbiAgICB0eXBlIFJlY2lwZVJ1bm5lcixcbiAgICB0eXBlIFJlY2lwZVJ1bk91dGNvbWUsXG59IGZyb20gJy4vcmVjaXBlcyc7XG5pbXBvcnQgeyBjYWxsU2NlbmVTY3JpcHQsIFNjZW5lVW5hdmFpbGFibGVFcnJvciB9IGZyb20gJy4vc2NlbmUtYnJpZGdlJztcbmltcG9ydCB7IHJ1bkluU2FuZGJveCB9IGZyb20gJy4vc2FuZGJveCc7XG5pbXBvcnQgeyBmb3JtYXRJbmxpbmUsIHNhZmVTZXJpYWxpemUsIHR5cGUgU2VyaWFsaXplT3B0aW9ucyB9IGZyb20gJy4vc2VyaWFsaXplJztcblxuZXhwb3J0IHR5cGUgQ29kZUNvbnRleHQgPSAnZWRpdG9yJyB8ICdzY2VuZSc7XG5cbi8qKiDmianlsZXljIXmoLnnm67lvZXvvIhgZGlzdC9jb3JlL2VuZ2luZS5qc2Ag5b6A5LiK5Lik57qn77yJ44CCICovXG5jb25zdCBFWFRFTlNJT05fUk9PVCA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuLicsICcuLicpO1xuXG4vKiog5rKZ566x6buY6K6k5YC877yI5Y6f5YWI5ZyoIGRmYW5fbWNwMiDnmoTorr7nva7pnaLmnb/ph4zosIPvvJvmnKzmianlsZXkuI3orr7pnaLmnb/vvIzmlLnmiJDluLjph48gKyDljZXlpITlj6/mlLnvvInjgIIgKi9cbmNvbnN0IFNBTkRCT1hfREVGQVVMVFMgPSB7XG4gICAgLyoqIGBjb2Nvc19leGVjdXRlX2NvZGVgIOayoeS8oCB0aW1lb3V0TXMg5pe255qE6buY6K6k6LaF5pe2ICovXG4gICAgdGltZW91dE1zOiAxNTAwMCxcbiAgICBtYXhMb2dzOiAyMDAsXG4gICAgbWF4TG9nTGVuZ3RoOiA0MDAwLFxufTtcblxuLyoqIOi/lOWbnuWAvOW6j+WIl+WMluS4iumZkO+8mua3seW6piA2IC8g5pWw57uEIDEwMCAvIOWvueixoSA2MCDplK4gLyDljZXlrZfnrKbkuLIgNDAwMCDlrZfvvIjkuI7lt6Xlhbfmj4/ov7Dph4zlhpnnmoTkuIDoh7TvvInjgIIgKi9cbmNvbnN0IFNFUklBTElaRV9PUFRJT05TOiBQYXJ0aWFsPFNlcmlhbGl6ZU9wdGlvbnM+ID0ge1xuICAgIG1heERlcHRoOiA2LFxuICAgIG1heEFycmF5TGVuZ3RoOiAxMDAsXG4gICAgbWF4T2JqZWN0S2V5czogNjAsXG4gICAgbWF4U3RyaW5nTGVuZ3RoOiA0MDAwLFxufTtcblxuLyoqIOWcuuaZr+iEmuacrOazqOWGjOeahOaWueazleWQje+8iOS4jiBwYWNrYWdlLmpzb24g55qEIGBjb250cmlidXRpb25zLnNjZW5lLm1ldGhvZHNgIOWvuem9kO+8ieOAgiAqL1xuY29uc3QgU0NFTkVfTUVUSE9EID0ge1xuICAgIHBpbmc6ICdwaW5nJyxcbiAgICBydW5Db2RlOiAncnVuQ29kZScsXG4gICAgZGVzY3JpYmVBcGk6ICdkZXNjcmliZUFwaScsXG4gICAgLyoqIOWcuuaZr+inhuWbvuWHoOS9le+8mkVsZWN0cm9uIOaIquWbvumdoOWug+WumuS9jSB3ZWJDb250ZW50cyDlubbmjaLnrpfoo4HliIfnn6nlvaIgKi9cbiAgICB2aWV3TWV0cmljczogJ3ZpZXdNZXRyaWNzJyxcbiAgICAvKiog5Y+W5pmvIC8g6L+Y5Y6f6KeG6KeS77ya44CM5oqK5pW05Liq5Zy65pmv5aGe6L+b55S75biD5YaN5oiq44CN6Z2g5a6D77yI6KeBIGNhcHR1cmVWaWV3IOeahCBmaXQg5Y+C5pWw77yJICovXG4gICAgZml0VmlldzogJ2ZpdFZpZXcnLFxufSBhcyBjb25zdDtcblxuLyoqIOaKiuS7u+aEj+W8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZWRpdG9yIOS4iuS4i+aWh+eahOaymeeuseWFqOWxgOmHj1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog5pq06Zyy57uZ5rKZ566x55qEIGBwcm9jZXNzYCDop4blm77jgIJcbiAqXG4gKiDliLvmhI/oo4HmjokgYGV4aXRgIC8gYGtpbGxgIC8gYGVudmDvvJpcbiAqIC0gYGV4aXRgIOS8muiuqee8lui+keWZqOS4u+i/m+eoi+ebtOaOpeaMguaOie+8iEFJIOaJi+a7keS4gOasoeWwseW+l+mHjeWQr+e8lui+keWZqO+8jOi/mOWPr+iDveS4ouacquS/neWtmOeahOWcuuaZr++8ie+8m1xuICogLSBgZW52YCDph4zluLjmnIkgdG9rZW4v5a+G6ZKl77yM6buY6K6k5LiN57uZ5a6D6aG65omL5oqE6L+b5qih5Z6L5LiK5LiL5paH55qE5py65Lya44CCXG4gKlxuICog6ZyA6KaB55qE6K+dIGByZXF1aXJlKCdwcm9jZXNzJylgIOS7jeeEtuaLv+W+l+WIsOecn+eahCDigJTigJQg6L+Z5pivKirpmLLmiYvmu5HvvIzkuI3mmK/pmLLotormnYMqKuOAglxuICovXG5mdW5jdGlvbiBidWlsZFNhZmVQcm9jZXNzKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICBwbGF0Zm9ybTogcHJvY2Vzcy5wbGF0Zm9ybSxcbiAgICAgICAgYXJjaDogcHJvY2Vzcy5hcmNoLFxuICAgICAgICB2ZXJzaW9uOiBwcm9jZXNzLnZlcnNpb24sXG4gICAgICAgIHZlcnNpb25zOiB7IC4uLnByb2Nlc3MudmVyc2lvbnMgfSxcbiAgICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgICAgY3dkOiAoKSA9PiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICB1cHRpbWU6ICgpID0+IHByb2Nlc3MudXB0aW1lKCksXG4gICAgICAgIG1lbW9yeVVzYWdlOiAoKSA9PiBwcm9jZXNzLm1lbW9yeVVzYWdlKCksXG4gICAgICAgIGhydGltZTogKHRpbWU/OiBbbnVtYmVyLCBudW1iZXJdKSA9PiBwcm9jZXNzLmhydGltZSh0aW1lKSxcbiAgICB9O1xufVxuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNjAwMDAsIE1hdGgudHJ1bmMoTnVtYmVyKG1zKSkgfHwgMCkpKTtcbiAgICB9KTtcblxuLyoqXG4gKiDlm77niYflg4/ntKDmjqLpkogg4oCU4oCUICoq57Sg5p2Q57qn5LqL5a6eKirvvJrov5nlvKDlm77liLDlupXplb/ku4DkuYjmoLfjgIHog73kuI3og73mn5PoibLjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjlroPlv4XpobvlnKggZWRpdG9yIOS+p+OAgemdoCBFbGVjdHJvblxuICpcbiAqIOOAjOi/meW8oOWbvuS4reW/g+eahCBhbHBoYSDmmK/kuI3mmK8gMOOAjeOAjOS4u+S9k+aYr+S4jeaYr+eZveeahO+8iOiDveS4jeiDveeUqCBgU3ByaXRlLmNvbG9yYCDmn5PoibLvvInjgI1cbiAqIOi/meexu+mXrumimOaYryoq55yL5Zu+KirvvIzkuI3mmK/nnIvlnLrmma/jgILogIzvvJpcbiAqXG4gKiAtICoq5Zy65pmv6L+b56iLKirph4zmi7/kuI3liLDlj6/pnaDop6PnoIHot6/lvoTvvIjopoHoh6rlt7HkuIogY2FudmFz77yM5LiU5Zu+6ZuG5a2Q5binL+WOi+e8qeagvOW8j+WQhOS4jeS4gOagt++8ie+8m1xuICogLSAqKk5vZGUg5rKh5pyJ5YaF572uIFBORyDop6PnoIHlmagqKiDigJTigJQg5ZyoIGVkaXRvciDmspnnrrHph4wgYGZzLnJlYWRGaWxlU3luY2Ag5ou/5Yiw55qE5piv5LiA5aCG5a2X6IqC77yMXG4gKiAgIOiHquW3seino+aekCBJREFUL3psaWIg5piv5Yeg5Y2D6KGM5LiU55m95bmy77ybXG4gKiAtIOKchSAqKkVsZWN0cm9uIOS4u+i/m+eoi+eahCBgbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGgoKWAgKyBgdG9CaXRtYXAoKWAqKiDkuIDmrKHnu5nliLBcbiAqICAgQkdSQSDljp/lp4vlg4/ntKAg4oCU4oCUIOmbtuS+nei1luOAgeS7u+aEj+W4uOingeagvOW8j+OAgeS7u+aEj+WwuuWvuOOAgmBjYXB0dXJlLnRzYCDmipPlm77lt7Lnu4/lnKjnlKjlkIzkuIDlpZfjgIJcbiAqXG4gKiAjIyDlroPmm7/mjonnmoTmmK/ku4DkuYhcbiAqXG4gKiDlrp7mtYvlj43lpI3lh7rnjrDnmoTkuInkuKrpl67popjvvIzljp/lhYjlj6rog73pnaDjgIzmiZPlvIDlm77niYfnnIvjgI3miJbogIUqKueMnCoq77yaXG4gKlxuICogfCDpl67popggfCDljp/nrZTmoYggfCDnjrDlnKggfFxuICogfC0tLXwtLS18LS0tfFxuICogfCBgcmVjdF9yZF8xMC5wbmdgIOWtmOS4jeWtmOWcqCB8IOaLvOi3r+W+hOeMnOOAgeivu+ebruW9leeci+S4gOecvCB8IOS4gOasoeiwg+eUqO+8jOi/mOe7mSoq55u46L+R5ZCN5a2XKiogfFxuICogfCBgcmVjdF9ib2FyZF9yZF8xMGAg5Lit5b+D5piv56m655qE77yI5pivXCLnjq9cIuS4jeaYr1wi5p2/XCLvvIkgfCDmiornmb3lrZfmlL7kuIrljrvmiY3lj5HnjrDnnIvkuI3op4EgfCBgY2VudGVyLmFgID0gMCB8XG4gKiB8IGBhY2hpdmVtZW50LnBuZ2Ag5piv5rex6Imy5Zu+5b2i77yIKirmn5PkuI3kuoboibIqKu+8iSB8IOafk+S6huayoeeUqO+8jOWGjeeMnOS4gOi9riB8IGB0aW50LndoaXRlaXNoID0gZmFsc2VgIHxcbiAqXG4gKiAjIyDor5rlrp7nmoTovrnnlYxcbiAqXG4gKiAtIOWPquWQgyoq56OB55uY5LiK55qE5Zu+54mH5paH5Lu2KirjgIJgZGI6Ly9pbnRlcm5hbC/igKZg77yI5byV5pOO5YaF572u77yJ5LiN5Zyo5bel56iL55uu5b2V77yM5Lya5piO6K+06ICM5LiN5piv6Z2Z6buY5aSx6LSl44CCXG4gKiAtIGAubWV0YWAg6YeM6K+75LiN5YiwIHV1aWQg5pe2IGB1dWlkYCDkuLogbnVsbO+8iCoq5LiN5b2x5ZON5YOP57Sg57uT6K66KirvvInjgIJcbiAqIC0g5Zu+6ZuG6YeM55qEKirlrZDluKcqKu+8mui/memHjOe7meeahOaYryoq5pW05byg5Zu+KirnmoTlnZDmoIfvvIzopoHlrZDluKfoh6rlt7HnlKggU3ByaXRlRnJhbWUg55qEIGByZWN0YCDmjaLnrpfjgIJcbiAqXG4gKiBAcGFyYW0gcmVmIOWbvueJh+i3r+W+hO+8mmBkYjovL2Fzc2V0cy/igKZgIC8g5bel56iL55u45a+5IC8g57ud5a+577yM5LiJ6ICF6YO96KGMXG4gKiBAcGFyYW0gb3B0aW9ucy54IOimgeeyvuehruivu+eahOmCo+S4quWDj+e0oOeahCB477yIKirmlbTlm77lg4/ntKDlnZDmoIcqKu+8jOWOn+eCueW3puS4iu+8iVxuICogQHBhcmFtIG9wdGlvbnMueSDlkIzkuIpcbiAqL1xuZnVuY3Rpb24gcHJvYmVJbWFnZShyZWY6IHVua25vd24sIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBvcHRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IG9wdGlvbnMgfHwge307XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHJlZiA9PT0gJ3N0cmluZycgPyByZWYudHJpbSgpIDogJyc7XG4gICAgaWYgKCFyYXcpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicHJvYmUocmVmKe+8muimgeS4gOS4quWbvueJh+i3r+W+hO+8jOS+i+WmgiBwcm9iZSgnZGI6Ly9hc3NldHMvcmVzb3VyY2VzL3RleHR1cmVzL2NvbW1vbi9yZWN0X3JkXzIwLnBuZycp44CCXCIpO1xuICAgIH1cblxuICAgIGxldCBmaWxlID0gcmF3O1xuICAgIGlmIChyYXcuaW5kZXhPZignZGI6Ly9hc3NldHMvJykgPT09IDApIHtcbiAgICAgICAgZmlsZSA9IHBhdGguam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJywgcmF3LnNsaWNlKCdkYjovL2Fzc2V0cy8nLmxlbmd0aCkpO1xuICAgIH0gZWxzZSBpZiAocmF3LmluZGV4T2YoJ2RiOi8vJykgPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHByb2Jl77yaJyR7cmF3fScg5oyH5ZCR55qE5LiN5piv5bel56iLIGFzc2V0cyDph4znmoTmlofku7bvvIhkYjovL2ludGVybmFsIOS5i+exu+aYr+W8leaTjuWGhee9rui1hOa6kO+8jOejgeebmOS4iuS4jeWcqOW3peeoi+ebruW9le+8ieOAgmAsXG4gICAgICAgICk7XG4gICAgfVxuICAgIGlmICghcGF0aC5pc0Fic29sdXRlKGZpbGUpKSBmaWxlID0gcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGZpbGUpO1xuXG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKGZpbGUpKSB7XG4gICAgICAgIC8vIOi3r+W+hOWGmemUmeaYr+acgOW4uOingeeahOWOn+WboCDigJTigJQg6aG65omL5oqK5ZCM55uu5b2V5LiL5ZCN5a2X55u46L+R55qE5YiX5Ye65p2l77yM55yB5LiA6L2uIGxpc3REaXJcbiAgICAgICAgbGV0IG5lYXJieTogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGJhc2UgPSBwYXRoLmJhc2VuYW1lKGZpbGUpLnJlcGxhY2UoL1xcLihwbmd8anBlP2d8d2VicCkkL2ksICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgY29uc3Qgc3RlbSA9IGJhc2Uuc2xpY2UoMCwgTWF0aC5taW4oNiwgYmFzZS5sZW5ndGgpKTtcbiAgICAgICAgICAgIG5lYXJieSA9IGZzXG4gICAgICAgICAgICAgICAgLnJlYWRkaXJTeW5jKHBhdGguZGlybmFtZShmaWxlKSlcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChuYW1lKSA9PiBuYW1lLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihzdGVtKSA+PSAwKVxuICAgICAgICAgICAgICAgIC5zbGljZSgwLCA4KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBuZWFyYnkgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHBhdGg6IGZpbGUsIGV4aXN0czogZmFsc2UsIGVycm9yOiBg5paH5Lu25LiN5a2Y5Zyo77yaJHtmaWxlfWAsIG5lYXJieSB9O1xuICAgIH1cblxuICAgIGxldCB1dWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBtZXRhRmlsZSA9IGAke2ZpbGV9Lm1ldGFgO1xuICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhtZXRhRmlsZSkpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhtZXRhRmlsZSwgJ3V0Zi04JykpIGFzIHsgdXVpZD86IHVua25vd24gfTtcbiAgICAgICAgICAgIGlmIChtZXRhICYmIHR5cGVvZiBtZXRhLnV1aWQgPT09ICdzdHJpbmcnKSB1dWlkID0gbWV0YS51dWlkO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIOivu+S4jeWIsOWwseeul+S6hu+8muWDj+e0oOe7k+iuuuS4jeS+nei1luWugyAqL1xuICAgIH1cbiAgICAvKiog5LiOIGBhdWRpdDp1aWAg55qEIFA0IOWQjOS4gOadoeWIpOaNru+8muW8leaTjuWGhee9rui0tOWbviB1dWlkIOWJjee8gCAqL1xuICAgIGNvbnN0IGVuZ2luZUJ1aWx0aW4gPSBCb29sZWFuKHV1aWQgJiYgdXVpZC5pbmRleE9mKCc3ZDhmOWI4OScpID09PSAwKTtcblxuICAgIGNvbnN0IGVsZWN0cm9uID0gZ2V0RWxlY3Ryb24oKSBhcyB7IG5hdGl2ZUltYWdlPzogeyBjcmVhdGVGcm9tUGF0aChwOiBzdHJpbmcpOiBhbnkgfSB9IHwgbnVsbDtcbiAgICBpZiAoIWVsZWN0cm9uIHx8ICFlbGVjdHJvbi5uYXRpdmVJbWFnZSB8fCB0eXBlb2YgZWxlY3Ryb24ubmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGggIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIHBhdGg6IGZpbGUsXG4gICAgICAgICAgICBleGlzdHM6IHRydWUsXG4gICAgICAgICAgICB1dWlkLFxuICAgICAgICAgICAgZXJyb3I6IGDmi7/kuI3liLAgRWxlY3Ryb24g55qEIG5hdGl2ZUltYWdl77yIJHtlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCkgfHwgJ+W9k+WJjeS4jeWcqOS4u+i/m+eoi++8nyd977yJ77yM6K+75LiN5LqG5YOP57Sg44CCYCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBsZXQgaW1hZ2U6IGFueTtcbiAgICBsZXQgc2l6ZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0geyB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XG4gICAgbGV0IGJpdG1hcDogQnVmZmVyO1xuICAgIHRyeSB7XG4gICAgICAgIGltYWdlID0gZWxlY3Ryb24ubmF0aXZlSW1hZ2UuY3JlYXRlRnJvbVBhdGgoZmlsZSk7XG4gICAgICAgIHNpemUgPSBpbWFnZS5nZXRTaXplKCk7XG4gICAgICAgIGlmICghc2l6ZS53aWR0aCB8fCAhc2l6ZS5oZWlnaHQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcGF0aDogZmlsZSwgZXhpc3RzOiB0cnVlLCB1dWlkLCBlcnJvcjogJ25hdGl2ZUltYWdlIOino+S4jeW8gOi/meW8oOWbvu+8iOagvOW8j+S4jeiupOivhu+8n++8ieOAgicgfTtcbiAgICAgICAgfVxuICAgICAgICBiaXRtYXAgPSBpbWFnZS50b0JpdG1hcCgpOyAvLyBCR1JBXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBwYXRoOiBmaWxlLFxuICAgICAgICAgICAgZXhpc3RzOiB0cnVlLFxuICAgICAgICAgICAgdXVpZCxcbiAgICAgICAgICAgIGVycm9yOiBg6Kej5YOP57Sg5aSx6LSl77yaJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiogQkdSQSDihpIg5LiA5Liq5YOP57Sg44CC6LaK55WM5ZueIG51bGzvvIjkuI3mipvvvInjgIIgKi9cbiAgICBjb25zdCBwaXhlbEF0ID0gKHg6IG51bWJlciwgeTogbnVtYmVyKTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB8IG51bGwgPT4ge1xuICAgICAgICBpZiAoISh4ID49IDAgJiYgeSA+PSAwICYmIHggPCBzaXplLndpZHRoICYmIHkgPCBzaXplLmhlaWdodCkpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBvID0gKHkgKiBzaXplLndpZHRoICsgeCkgKiA0O1xuICAgICAgICBpZiAobyArIDMgPj0gYml0bWFwLmxlbmd0aCkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiB7IHI6IGJpdG1hcFtvICsgMl0sIGc6IGJpdG1hcFtvICsgMV0sIGI6IGJpdG1hcFtvXSwgYTogYml0bWFwW28gKyAzXSB9O1xuICAgIH07XG4gICAgY29uc3QgdG9IZXggPSAocHg6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCBudWxsKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgICBweCA/IGAjJHtbcHguciwgcHguZywgcHguYiwgcHguYV0ubWFwKCh2KSA9PiB2LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKX1gIDogbnVsbDtcblxuICAgIC8vIOWFqOWbvue7n+iuoe+8iOaKveagt++8jOWkn+S4i+WIpOaWreS4lOS4jeS8muiiq+Wkp+WbvuaLluaFou+8iVxuICAgIGNvbnN0IHRvdGFsID0gc2l6ZS53aWR0aCAqIHNpemUuaGVpZ2h0O1xuICAgIGNvbnN0IHN0ZXAgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHRvdGFsIC8gMjAwMDApKTtcbiAgICBsZXQgc2FtcGxlZCA9IDA7XG4gICAgbGV0IHRyYW5zcGFyZW50ID0gMDtcbiAgICBsZXQgYWxwaGFNaW4gPSAyNTU7XG4gICAgbGV0IGFscGhhTWF4ID0gMDtcbiAgICBsZXQgc3VtUiA9IDA7XG4gICAgbGV0IHN1bUcgPSAwO1xuICAgIGxldCBzdW1CID0gMDtcbiAgICBsZXQgb3BhcXVlQ291bnQgPSAwO1xuICAgIGxldCB3aGl0ZWlzaENvdW50ID0gMDtcbiAgICBjb25zdCBjb2xvdXJUYWxseSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b3RhbDsgaSArPSBzdGVwKSB7XG4gICAgICAgIGNvbnN0IHB4ID0gcGl4ZWxBdChpICUgc2l6ZS53aWR0aCwgTWF0aC5mbG9vcihpIC8gc2l6ZS53aWR0aCkpO1xuICAgICAgICBpZiAoIXB4KSBjb250aW51ZTtcbiAgICAgICAgc2FtcGxlZCArPSAxO1xuICAgICAgICBpZiAocHguYSA8IGFscGhhTWluKSBhbHBoYU1pbiA9IHB4LmE7XG4gICAgICAgIGlmIChweC5hID4gYWxwaGFNYXgpIGFscGhhTWF4ID0gcHguYTtcbiAgICAgICAgaWYgKHB4LmEgPT09IDApIHtcbiAgICAgICAgICAgIHRyYW5zcGFyZW50ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBvcGFxdWVDb3VudCArPSAxO1xuICAgICAgICBzdW1SICs9IHB4LnI7XG4gICAgICAgIHN1bUcgKz0gcHguZztcbiAgICAgICAgc3VtQiArPSBweC5iO1xuICAgICAgICBjb25zdCBtYXhDID0gTWF0aC5tYXgocHguciwgcHguZywgcHguYik7XG4gICAgICAgIGNvbnN0IG1pbkMgPSBNYXRoLm1pbihweC5yLCBweC5nLCBweC5iKTtcbiAgICAgICAgaWYgKHB4LmEgPj0gMjAwICYmIG1pbkMgPj0gMjAwICYmIG1heEMgLSBtaW5DIDw9IDI0KSB3aGl0ZWlzaENvdW50ICs9IDE7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke3B4LnIgPj4gNX0sJHtweC5nID4+IDV9LCR7cHguYiA+PiA1fWA7XG4gICAgICAgIGNvbG91clRhbGx5LnNldChrZXksIChjb2xvdXJUYWxseS5nZXQoa2V5KSB8fCAwKSArIDEpO1xuICAgIH1cblxuICAgIGNvbnN0IG1lYW5PZiA9IChzdW06IG51bWJlcik6IG51bWJlciA9PiAob3BhcXVlQ291bnQgPiAwID8gTWF0aC5yb3VuZChzdW0gLyBvcGFxdWVDb3VudCkgOiAwKTtcbiAgICBjb25zdCBtZWFuUkdCID0gW21lYW5PZihzdW1SKSwgbWVhbk9mKHN1bUcpLCBtZWFuT2Yoc3VtQildO1xuICAgIGNvbnN0IHdoaXRlaXNoUmF0aW8gPSBvcGFxdWVDb3VudCA+IDAgPyBNYXRoLnJvdW5kKCh3aGl0ZWlzaENvdW50IC8gb3BhcXVlQ291bnQpICogMTAwKSAvIDEwMCA6IDA7XG4gICAgY29uc3QgdG9wQ29sb3VycyA9IEFycmF5LmZyb20oY29sb3VyVGFsbHkuZW50cmllcygpKVxuICAgICAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgICAgIC5zbGljZSgwLCA1KVxuICAgICAgICAubWFwKChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGFydHMgPSBlbnRyeVswXS5zcGxpdCgnLCcpLm1hcCgodikgPT4gKE51bWJlcih2KSA8PCA1KSB8IDE2KTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaGV4OiBgIyR7cGFydHMubWFwKCh2KSA9PiBNYXRoLm1pbigyNTUsIHYpLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKX1gLFxuICAgICAgICAgICAgICAgIHNoYXJlOiBvcGFxdWVDb3VudCA+IDAgPyBNYXRoLnJvdW5kKChlbnRyeVsxXSAvIG9wYXF1ZUNvdW50KSAqIDEwMCkgLyAxMDAgOiAwLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSk7XG5cbiAgICBjb25zdCBjZW50ZXIgPSBwaXhlbEF0KE1hdGguZmxvb3Ioc2l6ZS53aWR0aCAvIDIpLCBNYXRoLmZsb29yKHNpemUuaGVpZ2h0IC8gMikpO1xuICAgIGNvbnN0IGNvcm5lcnMgPSB7XG4gICAgICAgIHRsOiB0b0hleChwaXhlbEF0KDAsIDApKSxcbiAgICAgICAgdHI6IHRvSGV4KHBpeGVsQXQoc2l6ZS53aWR0aCAtIDEsIDApKSxcbiAgICAgICAgYmw6IHRvSGV4KHBpeGVsQXQoMCwgc2l6ZS5oZWlnaHQgLSAxKSksXG4gICAgICAgIGJyOiB0b0hleChwaXhlbEF0KHNpemUud2lkdGggLSAxLCBzaXplLmhlaWdodCAtIDEpKSxcbiAgICB9O1xuICAgIGNvbnN0IGNvcm5lckFscGhhcyA9IFtcbiAgICAgICAgcGl4ZWxBdCgwLCAwKSxcbiAgICAgICAgcGl4ZWxBdChzaXplLndpZHRoIC0gMSwgMCksXG4gICAgICAgIHBpeGVsQXQoMCwgc2l6ZS5oZWlnaHQgLSAxKSxcbiAgICAgICAgcGl4ZWxBdChzaXplLndpZHRoIC0gMSwgc2l6ZS5oZWlnaHQgLSAxKSxcbiAgICBdLm1hcCgocHgpID0+IChweCA/IHB4LmEgOiBudWxsKSk7XG5cbiAgICAvKiog55yf5q2j55qE6YKj5Liq6Zeu6aKY77ya44CM6L+Z5Zu+6IO95LiN6IO955SoIGBTcHJpdGUuY29sb3JgIOafk+aIkOS7u+aEj+iJsuOAjSAqL1xuICAgIGNvbnN0IGNhbnZhc0xpa2UgPSBjb3JuZXJBbHBoYXMuZXZlcnkoKGEpID0+IGEgPT09IDApO1xuICAgIGNvbnN0IHRpbnROb3RlID0gIWNhbnZhc0xpa2VcbiAgICAgICAgPyAn5Zub6KeS5LiN5YWo5piv6YCP5piOIOKAlOKAlCDlroPlpKfmpoLmmK/kuIDlvKAqKuS4jemAj+aYjuW6lSoq55qE5Zu+77yI5oiW5ZyG6KeS5rKh6ZO65ruh77yJ77yM5p+T6Imy5Lya5p+T5Yiw5pW05Z2X6IOM5pmv44CCJ1xuICAgICAgICA6IHdoaXRlaXNoUmF0aW8gPj0gMC45XG4gICAgICAgICAgPyAn5Li75L2T5o6l6L+R55m9L+eBsOS4lOWbm+inkumAj+aYjiDigJTigJQg5YW45Z6L55qEKirlj6/mn5PoibIqKuWbvuagh++8iGBTcHJpdGUuY29sb3JgIOiDveaKiuWug+WPmOaIkOS7u+aEj+minOiJsu+8ieOAgidcbiAgICAgICAgICA6IHdoaXRlaXNoUmF0aW8gPj0gMC40XG4gICAgICAgICAgICA/ICfkuLvkvZPmmK/mtYXoibLkvYbkuI3lpJ/nuq/nmb0g4oCU4oCUIOafk+iJsuWQjioq6aKc6Imy5Lya5YGPKirvvIjljp/oibLkvJrpgI/lh7rmnaXvvInjgIInXG4gICAgICAgICAgICA6ICfkuLvkvZPmmK8qKuW9qeiJsi/mt7HoibIqKueahCDigJTigJQg55SoIGBTcHJpdGUuY29sb3JgIOafk+S4jeWHuuaDs+imgeeahOminOiJsu+8iOa3seiJsuWPquS8muabtOm7ke+8ie+8jOimgeS5iOaNouWbvuimgeS5iOWIq+afk+OAgic7XG5cbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgcGF0aDogZmlsZSxcbiAgICAgICAgZXhpc3RzOiB0cnVlLFxuICAgICAgICB1dWlkLFxuICAgICAgICBlbmdpbmVCdWlsdGluLFxuICAgICAgICBieXRlczogKCgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZzLnN0YXRTeW5jKGZpbGUpLnNpemU7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkoKSxcbiAgICAgICAgd2lkdGg6IHNpemUud2lkdGgsXG4gICAgICAgIGhlaWdodDogc2l6ZS5oZWlnaHQsXG4gICAgICAgIGFscGhhOiB7XG4gICAgICAgICAgICBtaW46IGFscGhhTWluLFxuICAgICAgICAgICAgbWF4OiBhbHBoYU1heCxcbiAgICAgICAgICAgIHRyYW5zcGFyZW50UmF0aW86IHNhbXBsZWQgPiAwID8gTWF0aC5yb3VuZCgodHJhbnNwYXJlbnQgLyBzYW1wbGVkKSAqIDEwMCkgLyAxMDAgOiAwLFxuICAgICAgICB9LFxuICAgICAgICBjZW50ZXI6IHsgcmdiYTogY2VudGVyLCBoZXg6IHRvSGV4KGNlbnRlcikgfSxcbiAgICAgICAgY29ybmVycyxcbiAgICAgICAgY29ybmVyQWxwaGFzLFxuICAgICAgICBmdWxsQmxlZWQ6IGNvcm5lckFscGhhcy5ldmVyeSgoYSkgPT4gYSAhPT0gbnVsbCAmJiBhID4gMCksXG4gICAgICAgIG1lYW5SR0IsXG4gICAgICAgIHdoaXRlaXNoUmF0aW8sXG4gICAgICAgIHRpbnQ6IHsgY2FudmFzTGlrZSwgd2hpdGVpc2g6IHdoaXRlaXNoUmF0aW8gPj0gMC45LCBub3RlOiB0aW50Tm90ZSB9LFxuICAgICAgICB0b3BDb2xvdXJzLFxuICAgICAgICBzYW1wbGVkUGl4ZWxzOiBzYW1wbGVkLFxuICAgICAgICBub3RlOiAn5Z2Q5qCH6YO95pivKirmlbTlvKDlm74qKueahOWDj+e0oO+8iOWOn+eCueW3puS4iu+8ie+8m+WbvumbhuWtkOW4p+imgeiHquW3seeUqCBTcHJpdGVGcmFtZSDnmoQgcmVjdCDmjaLnrpfjgIInLFxuICAgIH07XG5cbiAgICBjb25zdCB3YW50WCA9IE51bWJlcihvcHRzLngpO1xuICAgIGNvbnN0IHdhbnRZID0gTnVtYmVyKG9wdHMueSk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh3YW50WCkgJiYgTnVtYmVyLmlzRmluaXRlKHdhbnRZKSkge1xuICAgICAgICBjb25zdCBweCA9IHBpeGVsQXQoTWF0aC5yb3VuZCh3YW50WCksIE1hdGgucm91bmQod2FudFkpKTtcbiAgICAgICAgb3V0LmF0ID0geyB4OiBNYXRoLnJvdW5kKHdhbnRYKSwgeTogTWF0aC5yb3VuZCh3YW50WSksIHJnYmE6IHB4LCBoZXg6IHRvSGV4KHB4KSB9O1xuICAgICAgICBpZiAoIXB4KSBvdXQuYXROb3RlID0gYCgke3dhbnRYfSwgJHt3YW50WX0pIOi2iueVjOS6hu+8iOWbvuaYryAke3NpemUud2lkdGh9w5cke3NpemUuaGVpZ2h0fe+8iWA7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogZWRpdG9yIOi1t+aJi+W8j+WKqeaJi+eahOetvuWQjea4heWNlSDigJTigJQg5ZCM5LiA5Lu95YaF5a655pei5rOo5YWl5rKZ566x44CB5Lmf55So5LqOIGBkZXNjcmliZV9hcGlgIOWxleekuuOAglxuICpcbiAqIHJlY2lwZSDpgqPkupTmnaHkuZ/lnKjov5nph4zvvJrlroPku6wqKuaYr+WKqeaJi+OAgeS4jeaYr+W3peWFtyoq77yM5bel5YW35YiX6KGo5Y+q5pyJ5Zub5LiqXG4gKiDvvIhgY29jb3NfZXhlY3V0ZV9jb2RlYCAvIGBjb2Nvc19kZXNjcmliZV9hcGlgIC8gYGNvY29zX2VkaXRvcl9zdGF0ZWAgLyBgY29jb3NfY2FwdHVyZV92aWV3YO+8ieOAglxuICovXG5jb25zdCBFRElUT1JfSEVMUEVSX1NJR05BVFVSRVMgPSBbXG4gICAgJ3NsZWVwKG1zKSDihpIgUHJvbWlzZScsXG4gICAgJ2V4dGVuc2lvblJvb3Qg4oaSIHN0cmluZ++8iOacrOaPkuS7tuebruW9le+8iScsXG4gICAgJ3Byb2plY3RQYXRoKCkg4oaSIHN0cmluZycsXG4gICAgJ3Jlc29sdmVQcm9qZWN0UGF0aChwKSDihpIgc3RyaW5n77yI55u45a+56Lev5b6E5oyJ5bel56iL5qC56Kej5p6Q77yJJyxcbiAgICAnbGlzdERpcihkaXIpIOKGkiBzdHJpbmdbXScsXG4gICAgJ3JlYWRKc29uKGZpbGUpIOKGkiBhbnknLFxuICAgIFwicHJvYmUocmVmLCB7eD8sIHk/fSkg4oaSIHt3aWR0aCwgaGVpZ2h0LCBjZW50ZXIsIGNvcm5lcnMsIGFscGhhLCB3aGl0ZWlzaFJhdGlvLCB0aW50LCB0b3BDb2xvdXJzLCBlbmdpbmVCdWlsdGluLCBuZWFyYnl9ICAvLyAqKuWbvueJh+eahOWDj+e0oOe6p+S6i+Wunioq77ya6K+75p+Q5Liq5YOP57SgL+S4reW/gy/lm5vop5LjgIHpgI/mmI7mr5TkvovjgIHkuLvkvZPmmK/kuI3mmK/nmb3oibLvvIg9IOiDveS4jeiDveeUqCBTcHJpdGUuY29sb3Ig5p+T6Imy77yJ44CB5piv5LiN5piv5byV5pOO5YaF572u6LS05Zu+44CCcmVmIOaUtiAnZGI6Ly9hc3NldHMv4oCmJyAvIOW3peeoi+ebuOWvuSAvIOe7neWvue+8m+aWh+S7tuS4jeWtmOWcqOS8mumhuuaJi+WIl+WHuuWQjeWtl+ebuOi/keeahFwiLFxuICAgIC4uLlJFQ0lQRV9IRUxQRVJfU0lHTkFUVVJFUyxcbl0gYXMgY29uc3Q7XG5cbi8qKiBlZGl0b3Ig5LiK5LiL5paH55qE6LW35omL5byP5Yqp5omL77yIcmVjaXBlIOS6lOS7tuWll+eUsSBgcnVuRWRpdG9yQ29udGV4dGAg5Y+m5Yqg77yJ44CCICovXG5mdW5jdGlvbiBidWlsZEVkaXRvckhlbHBlcnMoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHNsZWVwLFxuICAgICAgICAvKiog5omp5bGV5YyF5qC555uu5b2VIOKAlOKAlCDmg7Por7vmnKzmj5Lku7bmupDnoIHml7bnlKggKi9cbiAgICAgICAgZXh0ZW5zaW9uUm9vdDogRVhURU5TSU9OX1JPT1QsXG4gICAgICAgIC8qKiDlvZPliY3lt6XnqIvmoLnnm67lvZUgKi9cbiAgICAgICAgcHJvamVjdFBhdGg6ICgpID0+IEVkaXRvci5Qcm9qZWN0LnBhdGgsXG4gICAgICAgIC8qKiDmiornm7jlr7kv57ud5a+56Lev5b6E57uf5LiA5oiQ57ud5a+56Lev5b6E77yI55u45a+55bel56iL55qE6Lev5b6E5oyJ5bel56iL5qC56Kej5p6Q77yJICovXG4gICAgICAgIHJlc29sdmVQcm9qZWN0UGF0aDogKHA6IHN0cmluZykgPT4gKHBhdGguaXNBYnNvbHV0ZShwKSA/IHAgOiBwYXRoLmpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgcCkpLFxuICAgICAgICAvKiog5YiX55uu5b2V77yI5Y+q6L+U5Zue5ZCN5a2X77yM6YG/5YWN5LiA5qyh5ZCQ5aSq5aSa77yJICovXG4gICAgICAgIGxpc3REaXI6IChkaXI6IHN0cmluZyk6IHN0cmluZ1tdID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFicyA9IHBhdGguaXNBYnNvbHV0ZShkaXIpID8gZGlyIDogcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGRpcik7XG4gICAgICAgICAgICByZXR1cm4gZnMucmVhZGRpclN5bmMoYWJzKTtcbiAgICAgICAgfSxcbiAgICAgICAgLyoqIOivuyBKU09O77yI6YWN6KGo6ISa5pys57uP5bi46KaB5bmy6L+Z5Liq77yJICovXG4gICAgICAgIHJlYWRKc29uOiAoZmlsZTogc3RyaW5nKTogdW5rbm93biA9PiB7XG4gICAgICAgICAgICBjb25zdCBhYnMgPSBwYXRoLmlzQWJzb2x1dGUoZmlsZSkgPyBmaWxlIDogcGF0aC5qb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGZpbGUpO1xuICAgICAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKGFicywgJ3V0Zi04JykpO1xuICAgICAgICB9LFxuICAgICAgICAvKiog5Zu+54mH5YOP57Sg5o6i6ZKIIOKAlOKAlCDop4Ege0BsaW5rIHByb2JlSW1hZ2V9IOeahOivtOaYju+8iOOAjOi/meWbvuiDveS4jeiDveafk+iJsuOAjemdoOWug+S4gOWPpeivneetlO+8iSAqL1xuICAgICAgICBwcm9iZTogKHJlZjogdW5rbm93biwgb3B0aW9ucz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBwcm9iZUltYWdlKHJlZiwgb3B0aW9ucyksXG4gICAgICAgIGhlbHBlck5hbWVzOiAoKSA9PiBbLi4uRURJVE9SX0hFTFBFUl9TSUdOQVRVUkVTXSxcbiAgICB9O1xufVxuXG4vKiog5oqK5rKZ566x5pel5b+X6KGM6L2s5oiQ5ZON5bqU6YeM55qE5a2X56ym5Liy5pWw57uEICovXG5mdW5jdGlvbiBmb3JtYXRMb2dMaW5lcyhsb2dzOiBBcnJheTx7IGxldmVsOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9Pik6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gbG9ncy5tYXAoKGwpID0+IGBbJHtsLmxldmVsfV0gJHtsLnRleHR9YCk7XG59XG5cbi8qKiDlpLnkuIDkuKrosIPnlKjmlrnkvKDov5vmnaXnmoTotoXml7bvvIjmqKHlnovkuI7pnaLmnb/pg73lj6/og73nu5nohI/lgLzvvIkgKi9cbmZ1bmN0aW9uIGNsYW1wVGltZW91dCh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgoMTAwLCBNYXRoLm1pbigzMDAwMDAsIE1hdGgudHJ1bmMocmF3KSkpO1xufVxuXG4vKiog5pW05pWw5aS55Y+W77yI5oiq5Zu+5Y+C5pWw55So77yJ44CCICovXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogdW5rbm93biwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC50cnVuYyh2YWx1ZSkgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIG4pKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlZGl0b3Ig5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKue8lui+keWZqOS4u+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6ZqU56a75rKZ566x77yJ44CCXG4gKlxuICog6L+U5Zue55qEIGBkYXRhYCDlsLHmmK/nu5nmqKHlnovnnIvnmoTpgqPkuKrkv6HlsIEgYHtvaywgY29udGV4dCwgZHVyYXRpb25NcywgcmVzdWx0fGVycm9yLCBsb2dzLCBub3Rlc+KApn1g77ybXG4gKiBgdGV4dGAg5piv5a6D55qEIEpTT04g5paH5pys44CCKirkv6HlsIHlvaLnirblv4Xpobvkv53mjIHnqLPlrpoqKiDigJTigJQgYGNvY29zX2VkaXRvcl9zdGF0ZWAg5LmL57G755qE6LCD55So5pa5XG4gKiDpnaAgYCdyZXN1bHQnIGluIGVudmVsb3BlYCDop6PljIXvvIjop4EgY29jb3MtdG9vbHMg55qEIGB1bndyYXBTYW5kYm94UmVzdWx0YO+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRWRpdG9yQ29kZShcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIC8vIOaDsOaAp+aMgeacieaJp+ihjOWZqO+8mnJlY2lwZSDliqnmiYvopoHog73osIPjgIzot5HkuIDmrrXku6PnoIHjgI3vvIzogIzpgqPmrrXku6PnoIHlj4jpnIDopoHlkIzmoLfnmoTlhajlsYDph49cbiAgICAvLyDvvIjljIXmi6wgcmVjaXBlIOWKqeaJi+iHquW3se+8ieKAlOKAlCDkupLnm7jlvJXnlKjvvIzmiYDku6Xlv4XpobvmmZrnu5HlrprjgIJcbiAgICBjb25zdCBydW5uZXJSZWY6IHsgY3VycmVudDogUmVjaXBlUnVubmVyIHwgbnVsbCB9ID0geyBjdXJyZW50OiBudWxsIH07XG5cbiAgICBjb25zdCB7IGhlbHBlcnM6IHJlY2lwZUhlbHBlcnMgfSA9IGJ1aWxkUmVjaXBlSGVscGVycyh7XG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxuICAgICAgICBjb250ZXh0OiAnZWRpdG9yJyxcbiAgICAgICAgZGVmYXVsdFRpbWVvdXRNczogdGltZW91dE1zLFxuICAgICAgICBnZXRSdW5uZXI6ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJ1bm5lciA9IHJ1bm5lclJlZi5jdXJyZW50O1xuICAgICAgICAgICAgaWYgKCFydW5uZXIpIHRocm93IG5ldyBFcnJvcigncmVjaXBlIOaJp+ihjOWZqOWwmuacquWwsee7qicpO1xuICAgICAgICAgICAgcmV0dXJuIHJ1bm5lcjtcbiAgICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBFZGl0b3IsXG4gICAgICAgIHJlcXVpcmUsXG4gICAgICAgIG1vZHVsZSxcbiAgICAgICAgZXhwb3J0cyxcbiAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICBfX2ZpbGVuYW1lLFxuICAgICAgICBmcyxcbiAgICAgICAgcGF0aCxcbiAgICAgICAgb3MsXG4gICAgICAgIEJ1ZmZlcixcbiAgICAgICAgcHJvY2VzczogYnVpbGRTYWZlUHJvY2VzcygpLFxuICAgICAgICBzZXRUaW1lb3V0LFxuICAgICAgICBjbGVhclRpbWVvdXQsXG4gICAgICAgIHNldEludGVydmFsLFxuICAgICAgICBjbGVhckludGVydmFsLFxuICAgICAgICBzZXRJbW1lZGlhdGUsXG4gICAgICAgIGFyZ3MsXG4gICAgICAgIC4uLmJ1aWxkRWRpdG9ySGVscGVycygpLFxuICAgICAgICAuLi5yZWNpcGVIZWxwZXJzLFxuICAgIH07XG5cbiAgICBjb25zdCBzYW5kYm94T3B0aW9ucyA9IHtcbiAgICAgICAgbWF4TG9nczogU0FOREJPWF9ERUZBVUxUUy5tYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgIH07XG5cbiAgICAvKiogcmVjaXBlIOeahOaJp+ihjOWZqO+8muWQjOS4gOS4quaymeeuseacuuWItu+8jOeLrOeri+eahOi2heaXtuS4juaXpeW/l+e8k+WGsiAqL1xuICAgIHJ1bm5lclJlZi5jdXJyZW50ID0gYXN5bmMgKFxuICAgICAgICByZWNpcGVDb2RlOiBzdHJpbmcsXG4gICAgICAgIHJlY2lwZUFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICBuZXN0ZWRUaW1lb3V0TXM6IG51bWJlcixcbiAgICApOiBQcm9taXNlPFJlY2lwZVJ1bk91dGNvbWU+ID0+IHtcbiAgICAgICAgY29uc3QgbmVzdGVkID0gYXdhaXQgcnVuSW5TYW5kYm94KHtcbiAgICAgICAgICAgIGNvZGU6IHJlY2lwZUNvZGUsXG4gICAgICAgICAgICBnbG9iYWxzOiB7IC4uLmdsb2JhbHMsIGFyZ3M6IHJlY2lwZUFyZ3MgfSxcbiAgICAgICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvci1yZWNpcGUnLFxuICAgICAgICAgICAgLi4uc2FuZGJveE9wdGlvbnMsXG4gICAgICAgICAgICB0aW1lb3V0TXM6IG5lc3RlZFRpbWVvdXRNcyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogbmVzdGVkLm9rLFxuICAgICAgICAgICAgcmVzdWx0OiBuZXN0ZWQucmVzdWx0LFxuICAgICAgICAgICAgZXJyb3I6IG5lc3RlZC5lcnJvcixcbiAgICAgICAgICAgIGxvZ3M6IG5lc3RlZC5sb2dzLmxlbmd0aCA+IDAgPyBmb3JtYXRMb2dMaW5lcyhuZXN0ZWQubG9ncykgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBkdXJhdGlvbk1zOiBuZXN0ZWQuZHVyYXRpb25NcyxcbiAgICAgICAgICAgIHRpbWVkT3V0OiBuZXN0ZWQudGltZWRPdXQsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGNvbnN0IHJ1biA9IGF3YWl0IHJ1bkluU2FuZGJveCh7XG4gICAgICAgIGNvZGUsXG4gICAgICAgIGdsb2JhbHMsXG4gICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvcicsXG4gICAgICAgIC4uLnNhbmRib3hPcHRpb25zLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShydW4ucmVzdWx0LCBTRVJJQUxJWkVfT1BUSU9OUyk7XG4gICAgLy8g44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN5LiN6IO95Y+q5Zue5LiA5Y+lIGNjIGlzIG5vdCBkZWZpbmVk77yI6KeBIGV4cGxhaW5FcnJvciDph4zorrDnmoTlrp7mtYvku6Pku7fvvIlcbiAgICBjb25zdCBlcnJvciA9IHJ1bi5vayA/IG51bGwgOiBleHBsYWluRXJyb3IocnVuLmVycm9yID8/IHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogJ+e8lui+keWZqOS+p+aJp+ihjOWksei0pScgfSwgJ2VkaXRvcicpO1xuICAgIGNvbnN0IGVudmVsb3BlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHJ1bi5vayxcbiAgICAgICAgY29udGV4dDogJ2VkaXRvcicsXG4gICAgICAgIGR1cmF0aW9uTXM6IHJ1bi5kdXJhdGlvbk1zLFxuICAgICAgICAuLi4ocnVuLm9rID8geyByZXN1bHQ6IHNlcmlhbGl6ZWQudmFsdWUgfSA6IHsgZXJyb3IgfSksXG4gICAgfTtcbiAgICBpZiAocnVuLmxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHJ1bi5sb2dzKTtcbiAgICBpZiAocnVuLmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAocnVuLnRpbWVkT3V0KSBlbnZlbG9wZS50aW1lZE91dCA9IHRydWU7XG4gICAgaWYgKHNlcmlhbGl6ZWQudHJ1bmNhdGVkKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChg6L+U5Zue5YC86KKr5oiq5pat77yI5ZG95Lit6ZmQ5Yi277yaJHtzZXJpYWxpemVkLmxpbWl0cy5qb2luKCcsICcpfe+8iWApO1xuICAgICAgICBlbnZlbG9wZS5ub3RlcyA9IG5vdGVzO1xuICAgIH1cblxuICAgIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShlbnZlbG9wZSwgbnVsbCwgMik7XG4gICAgcmV0dXJuIHJ1bi5va1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICfnvJbovpHlmajkvqfmiafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2NlbmUg5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKuW8leaTjuWcuuaZr+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yJ44CCXG4gKlxuICogQHBhcmFtIHdhbnRTbmFwc2hvdCAtIOiwg+eUqOaWueaYvuW8j+imgeaxgueZu+iusOS4gOasoeaSpOmUgOW/q+eFp++8iOiEmuacrOWGhSBgc25hcHNob3QoKWAg5Lmf5Lya572u5ZCM5LiA5Liq5qCH5b+X77yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5TY2VuZUNvZGUoXG4gICAgY29kZTogc3RyaW5nLFxuICAgIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuICAgIHdhbnRTbmFwc2hvdDogYm9vbGVhbixcbik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgbGV0IHNjZW5lUmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgICBzY2VuZVJlc3VsdCA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oU0NFTkVfTUVUSE9ELnJ1bkNvZGUsIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBjb2RlLFxuICAgICAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgICAgICAgdGltZW91dE1zLFxuICAgICAgICAgICAgICAgIG1heExvZ3M6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9ncyxcbiAgICAgICAgICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgICAgICAgICAgICAgIC8vIOW3peeoi+aguSoq55Sx5Li76L+b56iL57uZKirvvIjov5nph4zmi7/lvpfliLAgRWRpdG9yLlByb2plY3QucGF0aO+8ie+8muWcuuaZr+i/m+eoi+mHjOeahFxuICAgICAgICAgICAgICAgIC8vIGBFZGl0b3JgIOaYr+e8lui+keWZqOazqOWFpeeahOWFqOWxgOmHj++8jOacquW/heavj+S4queJiOacrOmDveWunuWIsOiDveivuyBQcm9qZWN0LnBhdGgg4oCU4oCUXG4gICAgICAgICAgICAgICAgLy8gYGxvYWRGcmFtZWAg6KaB6Z2g5a6D5Y676K+7IGAubWV0YWDvvIjop4Egc2NlbmUudHMg6YeMIGxvYWRGcmFtZSDnmoTor7TmmI7vvInvvIxcbiAgICAgICAgICAgICAgICAvLyDlsJHov5nkuIDkuKrlrZfmrrXlsLHkvJrpgIDljJbmiJDjgIzlj6rmnIkgdXVpZCDog73nlKjjgI3jgIJcbiAgICAgICAgICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgU2NlbmVVbmF2YWlsYWJsZUVycm9yID8gZXJyLm1lc3NhZ2UgOiBkZXNjcmliZShlcnIpO1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHsgb2s6IGZhbHNlLCBjb250ZXh0OiAnc2NlbmUnLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KGVudmVsb3BlLCBudWxsLCAyKSwgZXJyb3I6IG1lc3NhZ2UsIGRhdGE6IGVudmVsb3BlIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb2sgPSBzY2VuZVJlc3VsdC5vayA9PT0gdHJ1ZTtcbiAgICAvLyDlnLrmma/kvqfov5Tlm57nmoTmmK/lvJXmk47ph4znmoTmtLvlr7nosaHvvIzlv4Xpobvov4fkuIDpgY3luo/liJfljJblho3ov5vlk43lupRcbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShzY2VuZVJlc3VsdC5yZXN1bHQsIFNFUklBTElaRV9PUFRJT05TKTtcblxuICAgIC8vIOW/q+eFp+eZu+iusO+8muiEmuacrOWGhSBzbmFwc2hvdCgpIOe9ruS9je+8jOaIluiwg+eUqOaWueaYvuW8j+imgeaxglxuICAgIGxldCBzbmFwc2hvdFRha2VuOiBib29sZWFuIHwgdW5kZWZpbmVkO1xuICAgIGlmIChvayAmJiAoc2NlbmVSZXN1bHQuc25hcHNob3RSZXF1ZXN0ZWQgPT09IHRydWUgfHwgd2FudFNuYXBzaG90KSkge1xuICAgICAgICBzbmFwc2hvdFRha2VuID0gYXdhaXQgcmVxdWVzdFNjZW5lU25hcHNob3QoKTtcbiAgICB9XG5cbiAgICBjb25zdCByYXdFcnJvciA9IHNjZW5lUmVzdWx0LmVycm9yIGFzIHsgbmFtZT86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGVycm9yID0gb2sgPyBudWxsIDogZXhwbGFpbkVycm9yKHsgbmFtZTogcmF3RXJyb3I/Lm5hbWUgPz8gJ0Vycm9yJywgbWVzc2FnZTogcmF3RXJyb3I/Lm1lc3NhZ2UgPz8gJ+WcuuaZr+aJp+ihjOWksei0pScgfSwgJ3NjZW5lJyk7XG5cbiAgICBjb25zdCBlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIG9rLFxuICAgICAgICBjb250ZXh0OiAnc2NlbmUnLFxuICAgICAgICBkdXJhdGlvbk1zOiBzY2VuZVJlc3VsdC5kdXJhdGlvbk1zID8/IDAsXG4gICAgICAgIC4uLihvayA/IHsgcmVzdWx0OiBzZXJpYWxpemVkLnZhbHVlIH0gOiB7IGVycm9yIH0pLFxuICAgIH07XG4gICAgY29uc3Qgc2NlbmVMb2dzID0gQXJyYXkuaXNBcnJheShzY2VuZVJlc3VsdC5sb2dzKVxuICAgICAgICA/IChzY2VuZVJlc3VsdC5sb2dzIGFzIEFycmF5PHsgbGV2ZWw6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0+KVxuICAgICAgICA6IFtdO1xuICAgIGlmIChzY2VuZUxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHNjZW5lTG9ncyk7XG4gICAgaWYgKHNjZW5lUmVzdWx0LmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAoc2NlbmVSZXN1bHQudGltZWRPdXQpIGVudmVsb3BlLnRpbWVkT3V0ID0gdHJ1ZTtcbiAgICBpZiAoc25hcHNob3RUYWtlbiAhPT0gdW5kZWZpbmVkKSBlbnZlbG9wZS51bmRvU25hcHNob3QgPSBzbmFwc2hvdFRha2VuO1xuICAgIGlmIChzZXJpYWxpemVkLnRydW5jYXRlZCkge1xuICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgIG5vdGVzLnB1c2goYOi/lOWbnuWAvOiiq+aIquaWre+8iOWRveS4remZkOWItu+8miR7c2VyaWFsaXplZC5saW1pdHMuam9pbignLCAnKX3vvIlgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDmlLnlrozlnLrmma/kuYvlkI4qKuaPkOmGkuWtmCByZWNpcGUqKiDigJTigJQg6L+Z5p2h5LiN5piv6KOF6aWw44CCXG4gICAgICpcbiAgICAgKiDln7rlh4bph4zmnIDnqLPlrprnmoTkuIDmnaHlt67or4TlsLHmmK/jgIzlpI3nlKggMCDpobnjgI3vvJrkuIDmlbTmrrXot5HpgJrnmoTlu7rmoJHku6PnoIHvvIjlrp7mtYsgNTJLQiDlj5HlvoDnvJbovpHlmajjgIFcbiAgICAgKiA1MCDmraXph4wgMzUg5q2l5pivIGBjb2Nvc19leGVjdXRlX2NvZGVg77yJ5aaC5p6c5rKh5a2Y5oiQIHJlY2lwZe+8jOS4i+asoeaNouS8muivneWwsSoq5LuO6Zu25YaN5p2l5LiA6YGNKipcbiAgICAgKiDvvIjljoblj7LkuIrjgIzlgZrkuIDkuKrnmbvlvZXnlYzpnaLpooTliLbku7bjgI3ooqvlgZrkuoYgMyDmrKHnnJ/ot5EgKyAxIOasoeWkreaKmO+8jOe6piAxMzEg5YiG6ZKf77yJ44CCXG4gICAgICpcbiAgICAgKiDop6blj5HmnaHku7bliLvmhI/mlLbnqoTvvIzlhY3lvpflj5jmiJDmr4/mnaHlm57miafpg73otLTnmoTlup/or53vvJpcbiAgICAgKiDikaAg6L+Z5LiA6L2u55yf55qE5pS55LqG5Zy65pmv77yI55m76K6w5LqG5pKk6ZSA5b+r54Wn77yJ77yb4pGhIOS7o+eggeWkn+mVv++8iOKJpTEyMDAg5a2X77yM55+t5o6i6ZKI5LiN5b+F5a2Y77yJ77ybXG4gICAgICog4pGiIOayoei2heaXtu+8iOi2heaXtueahOmCo+asoeW+gOW+gOayoei3keWujO+8jOWtmOS4i+adpeaYr+S4quWdke+8ieOAglxuICAgICAqL1xuICAgIGlmIChvayAmJiBzbmFwc2hvdFRha2VuID09PSB0cnVlICYmICFzY2VuZVJlc3VsdC50aW1lZE91dCAmJiBjb2RlLmxlbmd0aCA+PSAxMjAwKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgIGDov5nmrKHmlLnliqjnnJ/nlJ/mlYjkuobvvIjlt7LnmbvorrDmkqTplIDlv6vnhafvvInvvIzogIzkuJTku6PnoIHmnIkgJHtjb2RlLmxlbmd0aH0g5a2XIOKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAn5aaC5p6c5Lul5ZCO6L+Y5Lya55So77yI5bu65qCRIC8g5oyJ5aWR57qm5pCtIFVJIC8g5om56YeP5pS56IqC54K5IC8g5a2Y6aKE5Yi25Lu277yJ77yMJyArXG4gICAgICAgICAgICAgICAgJ+aKiioq5ZCM5LiA5q615Luj56CBKirnlKggc2F2ZVJlY2lwZSjlkI3lrZcsIDzov5nmrrXku6PnoIE+LCB7ZGVzY3JpcHRpb24sIHBhcmFtcywgcmV0dXJuc30pIOWtmOS4i+adpe+8micgK1xuICAgICAgICAgICAgICAgICfkuIvmrKHlvIDlt6UgZmluZFJlY2lwZXMg5bCx6IO95om+5Yiw5a6D77yM5LiN55So5LuO6Zu25YaN5YaZ5LiA6YGN44CCJyArXG4gICAgICAgICAgICAgICAgJ++8iOS4gOasoeaAp+eahOaOoue0ouebtOaOpSByZXR1cm4g5bCx6KGM77yM5Yir5a2Y44CC77yJJyxcbiAgICAgICAgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZW52ZWxvcGUsIG51bGwsIDIpO1xuICAgIHJldHVybiBva1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICflnLrmma/miafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8qKlxuICog6K+35rGC5LiA5qyh5Zy65pmv5pKk6ZSA5b+r54Wn44CCXG4gKlxuICog5Zy65pmv6ISa5pys6YeM55qEIGBzbmFwc2hvdCgpYCDlj6rnva7moIflv5fkvY3vvIznnJ/mraPnmoTlv6vnhafnlLHov5nph4zlj5Hotbcg4oCU4oCUXG4gKiDlv4XpobvnlLHkuLvov5vnqIvosIPvvIzlm6DkuLrku44gc2NlbmUg6L+b56iL57uZIHNjZW5lIOWMheWPkea2iOaBr+aYr+iHqueOr+OAglxuICovXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0U2NlbmVTbmFwc2hvdCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlr7nlpJbvvJpleGVjdXRlX2NvZGUgLyBjYXB0dXJlX3ZpZXcgLyDmjqLmtLsgLyDlnLrmma/kvqcgZGVzY3JpYmVfYXBpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBFeGVjdXRlQ29kZVBhcmFtcyB7XG4gICAgY29kZT86IHVua25vd247XG4gICAgY29udGV4dD86IHVua25vd247XG4gICAgYXJncz86IHVua25vd247XG4gICAgdGltZW91dE1zPzogdW5rbm93bjtcbiAgICBzbmFwc2hvdD86IHVua25vd247XG59XG5cbi8qKlxuICog44CM6L+Z5q615Luj56CB5Y+q6IO95ZyoIHNjZW5lIOi3keOAjeeahOWIpOaNriDigJTigJQg5LiA5Liq5Liq6YO95pivKirlj6rlnKjlnLrmma/kuIrkuIvmloflrZjlnKjnmoToo7jmoIfor4bnrKYqKuOAglxuICpcbiAqIOS4uuS7gOS5iOimgeacieS4gOS7vea4heWNle+8mmBjb250ZXh0YCDmvI/nu5nml7bvvIzml6flrp7njrDlnKggYGNvY29zLXRvb2xzYC/ov5nph4zpg73mmK9cbiAqIGBwYXJhbXMuY29udGV4dCA9PT0gJ3NjZW5lJyA/ICdzY2VuZScgOiAnZWRpdG9yJ2Ag4oCU4oCUIOS5n+WwseaYryoq6Z2Z6buY5b2T5oiQIGVkaXRvcioq77yMXG4gKiDogIwgZWRpdG9yIOaymeeusemHjOayoeaciSBgY2Ng77yM5LqO5piv5qih5Z6L5ou/5Yiw55qE5piv77yaXG4gKlxuICogYGBgXG4gKiBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRcbiAqIGBgYFxuICpcbiAqIOWunua1i+S7o+S7t++8iDIwMjYtMDktMzAgMTc6NDUg6YKj5p2h5Lya6K+d77yJ77ya5qih5Z6L5a6M5YWo5LiN55+l6YGT6L+Z5piv44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN77yMXG4gKiDkuo7mmK/ov57nnYAgMTAg5q2l5Zyo5YGa5a+554Wn5a6e6aqMIOKAlOKAlCDmgIDnlpEgYGFyZ3NgIOaUueWPmOS6huaJp+ihjOeOr+Wig+OAgeaAgOeWkeS7o+eggeWkqumVv+iiq+aIquaWreOAgVxuICog5oCA55aRIHNjZW5lIOi/m+eoi+S4ouS6hiBgY2Ng44CB5oCA55aR5pivIGBzbmFwc2hvdDogdHJ1ZWAg55qE5Ymv5L2c55So77yIKirov5nmnaHmmK/plJnnmoTvvIzop4HkuIsqKu+8ie+8jFxuICog5LiA5q2l6YO95rKh5b6A44CM5oiR5rKh5YaZIGNvbnRleHTjgI3kuIrmg7PjgILmlbTmnaHkvJror50gNTAg5q2l6YeM5pyJIDEwIOatpeiKseWcqOi/meS4iumdouOAglxuICpcbiAqIOKaoCAqKmBzbmFwc2hvdDogdHJ1ZWAg5LiN5piv5Y6f5ZugKirvvIhza2lsbCDph4zmm77ov5nkuYjorrDvvIzlt7Lmm7TmraPvvInvvJpgc25hcHNob3RgIOWPquaYr1xuICog44CM6LeR5a6M5LmL5ZCO6aKd5aSW55m76K6w5LiA5qyh5pKk6ZSA5b+r54Wn44CN77yM5Luj56CB5LuN6LeR5ZyoIHNjZW5lIOaymeeusemHjO+8jGBjY2Ag54Wn5qC35ZyoXG4gKiDvvIhgc2NyaXB0cy92ZXJpZnktY29jb3MtZW5naW5lLmpzYCDph4zmnInkuIDmnaHmlq3oqIDlsLHmmK8gYGNvbnRleHQ6J3NjZW5lJyArIHNuYXBzaG90OnRydWVgIOi3kemAmueahO+8ieOAglxuICog55yf5q2j55qE5Yik5o2u5Y+q5pyJ44CM5pyJ5rKh5pyJ57uZIGNvbnRleHTjgI3jgIJcbiAqL1xuY29uc3QgU0NFTkVfT05MWV9NQVJLRVJTOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSljY1xccypbLlsoXS8sIG5hbWU6ICdjYycgfSxcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pZGlyZWN0b3JcXHMqWy5bKF0vLCBuYW1lOiAnZGlyZWN0b3InIH0sXG4gICAgeyBwYXR0ZXJuOiAvKF58W15BLVphLXowLTlfJC5dKShub2RlQnlQYXRofG5vZGVCeVV1aWR8ZWFjaE5vZGV8Y29udGVudENoaWxkcmVufGlzRWRpdG9yTm9kZXxmaW5kVmlld0NhbnZhcylcXHMqXFwoLywgbmFtZTogJ+WcuuaZr+WKqeaJi++8iG5vZGVCeVBhdGgg562J77yJJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSkodHJlZXxkdW1wfGNhcHR1cmVWaWV3fGxvYWRGcmFtZXx3b3JsZFJlY3QpXFxzKlxcKC8sIG5hbWU6ICd0cmVlL2R1bXAvY2FwdHVyZVZpZXcvbG9hZEZyYW1lL3dvcmxkUmVjdCcgfSxcbiAgICB7XG4gICAgICAgIHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pKHBpY2t8bGFiZWxGaXR8c25hcHNob3RUcmVlfGRpZmZUcmVlKVxccypcXCgvLFxuICAgICAgICBuYW1lOiAncGljay9sYWJlbEZpdC9zbmFwc2hvdFRyZWUvZGlmZlRyZWUnLFxuICAgIH0sXG5dO1xuXG4vKiog44CM6L+Z5q615Luj56CB5Y+q6IO95ZyoIGVkaXRvciDot5HjgI3nmoTliKTmja7jgIIgKi9cbmNvbnN0IEVESVRPUl9PTkxZX01BUktFUlM6IEFycmF5PHsgcGF0dGVybjogUmVnRXhwOyBuYW1lOiBzdHJpbmcgfT4gPSBbXG4gICAgeyBwYXR0ZXJuOiAvKF58W15BLVphLXowLTlfJC5dKUVkaXRvclxccypbLltdLywgbmFtZTogJ0VkaXRvcicgfSxcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pKHJlc29sdmVQcm9qZWN0UGF0aHxsaXN0RGlyfHJlYWRKc29ufHByb2plY3RQYXRofGV4dGVuc2lvblJvb3QpXFxzKlxcKD8vLCBuYW1lOiAn57yW6L6R5Zmo5Yqp5omL77yIcHJvamVjdFBhdGgg562J77yJJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSlwcm9iZVxccypcXCgvLCBuYW1lOiAncHJvYmXvvIjlm77niYflg4/ntKDmjqLpkojvvIknIH0sXG5dO1xuXG4vKipcbiAqICoq5byx5Yik5o2uKirvvJrlnLrmma/kvqfni6zmnInnmoTmoIfor4bnrKbvvIzooqvlvZPmiJDmma7pgJrmoIfor4bnrKbnlKjliLDlsLHnrpfvvIhgdHlwZW9mIGNjYOOAgWAhIWNjYOOAgWBpZiAoZWFjaE5vZGUpYOKApu+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOW8uuWIpOaNruS4jeWkn++8muWunua1i+mCo+auteaKiuaooeWei+WdkeS6hiAxMCDmraXnmoTku6PnoIHnoa7lrp7mmK8gYGNjLkxheWVycy5FbnVtLlVJXzJEYO+8iOW8uuWIpOaNruiDveWRveS4re+8ie+8jFxuICog5L2G44CM5peB6L655LiA5Y+lIGByZXR1cm4geyBjY0xvYWRlZDogISFjYyB9YOOAjei/meenjeWGmeazleWQjOagt+ihqOaYjuOAjOaIkeimgeeahOaYr+WcuuaZr+OAje+8jFxuICog6ICM5a6D5pei5rKh5pyJIGBjYy5g44CB5Lmf5rKh5pyJIGBub2RlQnlQYXRoKGDjgILlvLHliKTmja7lj6rlnKgqKuayoeaciee8lui+keWZqOW8uuWIpOaNrioq5pe25omN55Sf5pWI77yMXG4gKiDmiYDku6UgYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywg4oCmKWAg6YKj56eN5Luj56CB5LiN5Lya6KKr5oqi6LWw44CCXG4gKi9cbmNvbnN0IFdFQUtfU0NFTkVfTkFNRVMgPVxuICAgIC9cXGIoY2N8Y29jb3N8ZGlyZWN0b3J8bm9kZUJ5UGF0aHxub2RlQnlVdWlkfGVhY2hOb2RlfGNvbnRlbnRDaGlsZHJlbnxpc0VkaXRvck5vZGV8d29ybGRSZWN0fGxvYWRGcmFtZXxjYXB0dXJlVmlld3xwaWNrfGxhYmVsRml0fHNuYXBzaG90VHJlZXxkaWZmVHJlZSlcXGIvO1xuXG4vKiog5ZG95Lit5riF5Y2V6YeM55qE5ZOq5Yeg5Liq77yI57uZ5Zue5omn6YeM55qE5Lq66K+d6K+05piO55So77yJ44CCICovXG5mdW5jdGlvbiBtYXJrZXJzT2YoY29kZTogc3RyaW5nLCBtYXJrZXJzOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+KTogc3RyaW5nW10ge1xuICAgIGNvbnN0IGhpdDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICAgIGlmIChtYXJrZXIucGF0dGVybi50ZXN0KGNvZGUpICYmIGhpdC5pbmRleE9mKG1hcmtlci5uYW1lKSA8IDApIGhpdC5wdXNoKG1hcmtlci5uYW1lKTtcbiAgICB9XG4gICAgcmV0dXJuIGhpdDtcbn1cblxuLyoqXG4gKiDmjqjmlq0gYGNvbnRleHRg77yI5Y+q5Zyo6LCD55So5pa5KirmsqHnu5kqKueahOaXtuWAmeeUqO+8ieOAglxuICpcbiAqIOWbm+e6p++8jOWFiOW8uuWQjuW8se+8mlxuICogMS4g5by65Zy65pmv5Yik5o2u77yIYGNjLmAgLyBgbm9kZUJ5UGF0aChgIC8gYHRyZWUoYCDigKbvvInihpIgc2NlbmXvvJtcbiAqIDIuIOW8uue8lui+keWZqOWIpOaNru+8iGBFZGl0b3IuYCAvIGBwcm9qZWN0UGF0aCgpYCDigKbvvInihpIgZWRpdG9y77ybXG4gKiAzLiDlvLHlnLrmma/liKTmja7vvIjoo7jmoIfor4bnrKYgYGNjYCAvIGBlYWNoTm9kZWAg4oCm77yJ4oaSIHNjZW5l77ybXG4gKiA0LiDpg73msqHmnIkg4oaSIGVkaXRvcu+8iCoq5peg5Ymv5L2c55SoKirnmoTpgqPkuIDkvqfvvJror7vnm5gv5p+l5bqT5LiN5Lya5Yqo55So5oi355qE5Zy65pmv77yJ44CCXG4gKlxuICogQHBhcmFtIGNvZGUgLSDnlKjmiLfku6PnoIHjgIJcbiAqIEByZXR1cm5zIGB7Y29udGV4dCwgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzfWDvvJtgbWFya2Vyc2Ag6Z2e56m66KGo56S644CM5o6o5pat5pyJ5L6d5o2u44CN44CCXG4gKi9cbmZ1bmN0aW9uIGluZmVyQ29udGV4dChjb2RlOiBzdHJpbmcpOiB7XG4gICAgY29udGV4dDogQ29kZUNvbnRleHQ7XG4gICAgc2NlbmVNYXJrZXJzOiBzdHJpbmdbXTtcbiAgICBlZGl0b3JNYXJrZXJzOiBzdHJpbmdbXTtcbn0ge1xuICAgIGNvbnN0IHNjZW5lTWFya2VycyA9IG1hcmtlcnNPZihjb2RlLCBTQ0VORV9PTkxZX01BUktFUlMpO1xuICAgIGNvbnN0IGVkaXRvck1hcmtlcnMgPSBtYXJrZXJzT2YoY29kZSwgRURJVE9SX09OTFlfTUFSS0VSUyk7XG4gICAgaWYgKHNjZW5lTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnMsIGVkaXRvck1hcmtlcnMgfTtcbiAgICBpZiAoZWRpdG9yTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG4gICAgaWYgKFdFQUtfU0NFTkVfTkFNRVMudGVzdChjb2RlKSkge1xuICAgICAgICByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnM6IFsnY2MgLyDlnLrmma/liqnmiYvvvIjoo7jmoIfor4bnrKbvvIknXSwgZWRpdG9yTWFya2VycyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG59XG5cbi8qKlxuICog5oqK44CM5LiK5LiL5paH6YCJ6ZSZ44CN6L+Z57G76ZSZ6K+v57+76K+R5oiQKirlj6/miafooYznmoTkuIDlj6Xor50qKuOAglxuICpcbiAqIGBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRgIOacrOi6q+ayoemUme+8jOmUmeeahOaYr+S4gOeCuee6v+e0oumDveS4jee7mSDigJTigJRcbiAqIOaooeWei+mdouWvueWug+WPquS8muWOu+WBmuWvueeFp+WunumqjO+8iOingSB7QGxpbmsgU0NFTkVfT05MWV9NQVJLRVJTfSDph4znmoTlrp7mtYvku6Pku7fvvInjgIJcbiAqIOi/memHjOaKiuW3suefpeeahOWHoOS4quijuOagh+ivhuespuiupOWHuuadpe+8jOebtOaOpeivtOa4heOAjOS9oOi3keWcqOWTquS4quS4iuS4i+aWh+OAgeivpeaUueaIkOS7gOS5iOOAjeOAglxuICpcbiAqIEBwYXJhbSBlcnJvciAtIOaymeeusemUmeivr+S/oeaBr+OAglxuICogQHBhcmFtIGNvbnRleHQgLSDlrp7pmYXot5HlnKjlk6rkuKrkuIrkuIvmlofjgIJcbiAqIEByZXR1cm5zIOe/u+ivkeWQjueahOmUmeivr+S/oeaBr+OAglxuICovXG5mdW5jdGlvbiBleHBsYWluRXJyb3IoZXJyb3I6IHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfSwgY29udGV4dDogQ29kZUNvbnRleHQpOiB7IG5hbWU6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICAgIGlmIChlcnJvci5uYW1lICE9PSAnUmVmZXJlbmNlRXJyb3InKSByZXR1cm4gZXJyb3I7XG4gICAgY29uc3QgbWlzc2VkID0gL14oPzxpZD5bQS1aYS16XyRdW1xcdyRdKikgaXMgbm90IGRlZmluZWQkLy5leGVjKGVycm9yLm1lc3NhZ2UudHJpbSgpKT8uZ3JvdXBzPy5pZCA/PyAnJztcbiAgICBpZiAoIW1pc3NlZCkgcmV0dXJuIGVycm9yO1xuXG4gICAgY29uc3Qgc2NlbmVHbG9iYWxzID0gWydjYycsICdjb2NvcycsICdkaXJlY3RvcicsICdzY2VuZScsICdqcycsICdub2RlQnlQYXRoJywgJ25vZGVCeVV1aWQnLCAnZWFjaE5vZGUnLCAnY29udGVudENoaWxkcmVuJywgJ2lzRWRpdG9yTm9kZScsICd0cmVlJywgJ2R1bXAnLCAnY2FwdHVyZVZpZXcnLCAnZmluZCddO1xuICAgIGNvbnN0IGVkaXRvckdsb2JhbHMgPSBbJ0VkaXRvcicsICdyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJywgJ19fZGlybmFtZScsICdfX2ZpbGVuYW1lJywgJ2ZzJywgJ3BhdGgnLCAnb3MnLCAnQnVmZmVyJywgJ3Byb2plY3RQYXRoJywgJ3Jlc29sdmVQcm9qZWN0UGF0aCcsICdsaXN0RGlyJywgJ3JlYWRKc29uJywgJ2V4dGVuc2lvblJvb3QnXTtcblxuICAgIGlmIChjb250ZXh0ID09PSAnZWRpdG9yJyAmJiBzY2VuZUdsb2JhbHMuaW5kZXhPZihtaXNzZWQpID49IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IGVycm9yLm5hbWUsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICAgIGAke2Vycm9yLm1lc3NhZ2V9XFxuYCArXG4gICAgICAgICAgICAgICAgYOKGkSDjgIwke21pc3NlZH3jgI3mmK8qKuWcuuaZr+S4iuS4i+aWhyoq5omN5pyJ55qE77yI6L+Z5qyh6LeR5ZyoIGVkaXRvciDmspnnrrHph4zvvIzpgqPph4zlj6rmnIkgRWRpdG9yIC8gcmVxdWlyZSAvIGZz77yJ44CCXFxuYCArXG4gICAgICAgICAgICAgICAgYOaUueazle+8mmNvY29zX2V4ZWN1dGVfY29kZSh7IGNvbnRleHQ6ICdzY2VuZScsIGNvZGU6IOKApiB9KeOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDkuIvmrKHkuZ/lj6/ku6Xlj6rlhpkgY29udGV4dO+8jOS4pOi+uemAmueUqO+8muaUueiKgueCuS/nu4Tku7Yg4oaSICdzY2VuZSfvvJvotYTmupDlupMv5bel56iL6K6+572uL+ivu+ebmCDihpIgJ2VkaXRvcifjgIJgLFxuICAgICAgICB9O1xuICAgIH1cbiAgICBpZiAoY29udGV4dCA9PT0gJ3NjZW5lJyAmJiBlZGl0b3JHbG9iYWxzLmluZGV4T2YobWlzc2VkKSA+PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBlcnJvci5uYW1lLFxuICAgICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgICAgICBgJHtlcnJvci5tZXNzYWdlfVxcbmAgK1xuICAgICAgICAgICAgICAgIGDihpEg44CMJHttaXNzZWR944CN5pivKirnvJbovpHlmajkuLvov5vnqIsqKuaJjeacieeahO+8iOi/measoei3keWcqOWcuuaZr+i/m+eoi+mHjO+8ieOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDmlLnms5XvvJpjb2Nvc19leGVjdXRlX2NvZGUoeyBjb250ZXh0OiAnZWRpdG9yJywgY29kZTog4oCmIH0pIOKAlOKAlCDotYTmupDlupPvvIhhc3NldC1kYu+8ieOAgeW3peeoi+iuvue9ruOAgeaehOW7uumDvei1sOWug+OAgmAsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiBlcnJvcjtcbn1cblxuLyoqIGBjb2Nvc19leGVjdXRlX2NvZGVgIOeahOWunueOsO+8muS4gOasoeaJp+ihjOmHjOWujOaIkOOAjOWPluaVsOaNriDihpIg5pS554q25oCBIOKGkiDov5Tlm57nu5PorrrjgI3jgIIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlQ29kZShwYXJhbXM6IEV4ZWN1dGVDb2RlUGFyYW1zKTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBjb25zdCBjb2RlID0gdHlwZW9mIHBhcmFtcy5jb2RlID09PSAnc3RyaW5nJyA/IHBhcmFtcy5jb2RlIDogJyc7XG4gICAgaWYgKCFjb2RlLnRyaW0oKSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6ICdleGVjdXRlX2NvZGXvvJpjb2RlIOaYr+epuueahOOAgicsIGVycm9yOiAnY29kZSDkuI3og73kuLrnqbonIH07XG4gICAgfVxuXG4gICAgY29uc3QgdGltZW91dE1zID0gY2xhbXBUaW1lb3V0KHBhcmFtcy50aW1lb3V0TXMsIFNBTkRCT1hfREVGQVVMVFMudGltZW91dE1zKTtcbiAgICBjb25zdCBhcmdzID1cbiAgICAgICAgcGFyYW1zLmFyZ3MgJiYgdHlwZW9mIHBhcmFtcy5hcmdzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShwYXJhbXMuYXJncylcbiAgICAgICAgICAgID8gKHBhcmFtcy5hcmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgICAgICAgOiB7fTtcblxuICAgIC8qKlxuICAgICAqIGBjb250ZXh0YCDnmoTkuInnp43mg4XlhrXvvIwqKumDveimgeivtOa4heaYr+WTquS4gOenjSoq77yaXG4gICAgICog4pGgIOaYvuW8j+e7meS6hiDihpIg54Wn5YGa77yI5ZCO6Z2i5Ye66ZSZ5pe25oyJ6L+Z5Liq5LiK5LiL5paH57+76K+R6ZSZ6K+v77yJ77ybXG4gICAgICog4pGhIOayoee7mSDihpIg5oyJ5Luj56CB6YeM55qE5qCH6K+G56ym5o6o5pat77yM5bm25Zyo5Zue5omn6YeM5rOo5piOIGBjb250ZXh0SW5mZXJyZWQ6IHRydWVgXG4gICAgICogICAg77yI5oKE5oKE5pu/5qih5Z6L5YGa5Yaz5a6a5L2G5LiN5ZGK6K+J5a6D77yM5LiL5qyh5a6D6L+Y5piv5Lya5ryP5YaZ77yJ77ybXG4gICAgICog4pGiIOaOqOaWreS5n+S4jeaIkOeriyDihpIgZWRpdG9y77yI5peg5Ymv5L2c55So55qE6YKj5Liq77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgZXhwbGljaXQ6IENvZGVDb250ZXh0IHwgbnVsbCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6IHBhcmFtcy5jb250ZXh0ID09PSAnZWRpdG9yJyA/ICdlZGl0b3InIDogbnVsbDtcbiAgICBjb25zdCBpbmZlcnJlZCA9IGV4cGxpY2l0ID09PSBudWxsID8gaW5mZXJDb250ZXh0KGNvZGUpIDogbnVsbDtcbiAgICBjb25zdCBjb250ZXh0OiBDb2RlQ29udGV4dCA9IGV4cGxpY2l0ID8/IGluZmVycmVkIS5jb250ZXh0O1xuXG4gICAgY29uc3QgcmVwbHkgPVxuICAgICAgICBjb250ZXh0ID09PSAnc2NlbmUnXG4gICAgICAgICAgICA/IGF3YWl0IHJ1blNjZW5lQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMsIHBhcmFtcy5zbmFwc2hvdCA9PT0gdHJ1ZSlcbiAgICAgICAgICAgIDogYXdhaXQgcnVuRWRpdG9yQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMpO1xuXG4gICAgLyoqXG4gICAgICog5rKh57uZIGNvbnRleHQg55qE6YKj5qyh77ya5oqK44CM5oiR5pu/5L2g6YCJ5LqG5ZOq5Liq44CB5Yet5LuA5LmI44CN5YaZ6L+b5Zue5omn44CCXG4gICAgICpcbiAgICAgKiDlhpnlnKgqKuS/oeWwgSoq77yIYGRhdGFg77yJ6YeM6ICM5LiN5piv5Y+q5YaZ5Zyo5paH5pys6YeM77yM5piv5Li65LqGIGB1bndyYXBTYW5kYm94UmVzdWx0YCDkuYvlpJbnmoTosIPnlKjmlrlcbiAgICAgKiDvvIjpnaLmnb/jgIHml6Xlv5fvvInkuZ/nnIvlvpfliLDvvJvmlofmnKzph4zlkIzmoLfkvJrlh7rnjrAg4oCU4oCUIOaooeWei+WPquivu+aWh+acrOOAglxuICAgICAqL1xuICAgIGlmIChpbmZlcnJlZCkge1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHJlcGx5LmRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChlbnZlbG9wZSkge1xuICAgICAgICAgICAgZW52ZWxvcGUuY29udGV4dEluZmVycmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IHdoeSA9XG4gICAgICAgICAgICAgICAgY29udGV4dCA9PT0gJ3NjZW5lJ1xuICAgICAgICAgICAgICAgICAgICA/IGDku6PnoIHph4zlh7rnjrDkuoYgJHtpbmZlcnJlZC5zY2VuZU1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICA6IGluZmVycmVkLmVkaXRvck1hcmtlcnMubGVuZ3RoID4gMFxuICAgICAgICAgICAgICAgICAgICAgID8gYOS7o+eggemHjOWHuueOsOS6hiAke2luZmVycmVkLmVkaXRvck1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICAgIDogJ+S7o+eggemHjOayoeacieWPquWxnuS6juafkOS4gOS+p+eahOagh+ivhuespic7XG4gICAgICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGDmsqHnu5kgY29udGV4dO+8jOaMieOAjCR7d2h5feOAjeaOqOaWreS4uiAnJHtjb250ZXh0fSfvvIjkuIvmrKHor7fmmL7lvI/kvKAgY29udGV4dO+8iWApO1xuICAgICAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgcmVwbHkudGV4dCA9PT0gJ3N0cmluZycgPyByZXBseS50ZXh0IDogJyc7XG4gICAgICAgICAgICByZXBseS50ZXh0ID0gdGV4dC5yZXBsYWNlKC9cXG4kLywgYFxcbi8vIGNvbnRleHQg5pyq57uZ77yM5oyJ44CMJHt3aHl944CN5o6o5pat5Li6ICcke2NvbnRleHR9J1xcbmApO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXBseTtcbn1cblxuLyoqIOWcuuaZr+S+p+aIquWbvuWKqeaJi+WbuuWumui1sOi/meS4gOihjO+8iOecn+ato+eahOWunueOsOWcqCBzb3VyY2Uvc2NlbmUudHMg55qEIGBjYXB0dXJlVmlld2Ag6YeM77yJ44CCICovXG5jb25zdCBDQVBUVVJFX1ZJRVdfU0NFTkVfQ09ERSA9ICdyZXR1cm4gYXdhaXQgY2FwdHVyZVZpZXcoYXJncyk7JztcblxuLyoqIOaIquWbvum7mOiupOiQveebmOebruW9le+8muezu+e7n+S4tOaXtuebruW9le+8jOS4juWFt+S9k+W3peeoi+aXoOWFs+OAgiAqL1xuZnVuY3Rpb24gZGVmYXVsdENhcHR1cmVQYXRoKGZvcm1hdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBkaXIgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksICdkc2gtY29jb3MtY2FwdHVyZXMnKTtcbiAgICBjb25zdCBzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csICctJyk7XG4gICAgcmV0dXJuIHBhdGguam9pbihkaXIsIGBzY2VuZS12aWV3LSR7c3RhbXB9LiR7Zm9ybWF0ID09PSAnanBlZycgPyAnanBnJyA6ICdwbmcnfWApO1xufVxuXG4vKiog5oiq5Zu+5aSx6LSl5pe255qE57uf5LiA5Zue5omn77yI5LiN5oqb77yM6K6p5qih5Z6L55yL5Yiw5Y+v6K+755qE5Y6f5Zug77yJ44CCICovXG5mdW5jdGlvbiBjYXB0dXJlRmFpbChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUb29sUmVwbHkge1xuICAgIGNvbnN0IHBheWxvYWQgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UsIC4uLihleHRyYSA/PyB7fSkgfTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBlcnJvcjogbWVzc2FnZSwgZGF0YTogcGF5bG9hZCB9O1xufVxuXG4vKiog5ou/5Yiw5Zu+5LmL5ZCO55qE5qCH5YeG5LiL5LiA5Y+l44CCICovXG5jb25zdCBDQVBUVVJFX1JFQURfSElOVCA9ICfnlKjlm77niYfor7vlj5bog73lipvmiZPlvIAgcGF0aCDnnIvkuIDnnLznlLvpnaLvvIzlho3lhrPlrprkuIvkuIDmraXjgIInO1xuXG4vKipcbiAqIOepuuWbvuaXtioq5b+F6aG757uZ6YCA6LevKirvvIjkuI3mmK9cIuWGjeivleS4gOasoVwi77yJ44CCXG4gKlxuICog5Y6G5Y+y77yIMjAyNi0wOS0zMCAwNDoyMyDkvJror53vvInvvJpgY2FwdHVyZV92aWV3YCDogIHogIHlrp7lrp7lm57kuoYgYGJsYW5rUmF0aW86IDFg77yMXG4gKiDkvYblj6rphY3kuobkuIDlj6XjgIzmjqXov5EgMSDor7TmmI7ln7rmnKzmmK/nqbrlm77jgI3igJTigJQg5qih5Z6L5LqO5piv6Ieq5bex5b6A5LiL6K+V77ya6YeN6K+VIGB3YWl0TXNgIOKGklxuICogYHNlbGVjdGAvYGZvY3VzLWNhbWVyYWAg4oaSIGBjYy5SZW5kZXJUZXh0dXJlYCDnprvlsY8g4oaSIOacgOWQjueUqOiKgueCueaVsOaNriArIENhbnZhczJEIOaJi+e7mOW4g+WxgOWvueeFp+Wbvu+8jFxuICogKirmlbTmlbQgMTYg5q2lKirjgILov5nkuKrlnZHnjrDlnKjnlLEgRWxlY3Ryb24g6YCa6YGT5LuO5qC55LiK5aC15L2P77yI6KeBIGBjYXB0dXJlLnRzYCDlpLTpg6jvvInvvIxcbiAqIOS9huecn+WIsOi/meS4gOatpeivtOaYjioq6L+e5ZCI5oiQ5ZCO55qEIHN1cmZhY2Ug6YO95piv56m655qEKiog4oCU4oCUIOmCo+aXtuabtOS4jeivpemHjeivleOAglxuICovXG5jb25zdCBDQVBUVVJFX0JMQU5LX0hJTlQgPVxuICAgICfov5nmmK/nqbrlm77vvIhibGFua1JhdGlv4omIMe+8ie+8jCoq5Yir5YaN6YeN6K+V5oiq5Zu+Kiog4oCU4oCUIEVsZWN0cm9uIOmAmumBk+W3sue7jyBgaW52YWxpZGF0ZSgpYCDpgLzov4fkuIDmrKHph43nu5jvvIwnICtcbiAgICAn5o2iIHdhaXRNcyAvIOmHjeaWsOiBmueEpiAvIOaNoiBtYXhXaWR0aCDpg73kuI3kvJrlj5jjgILlhYjnnIsgYHZpZXdgIOWGjeWGs+Wumu+8jOaMiemhuuW6j+WBmu+8micgK1xuICAgICfikaAgYHZpZXcudmlzaWJsZU1hdGNoZXNEZXNpZ24gPT09IGZhbHNlYO+8mue8lui+keWZqOWcuuaZr+inhuWbvueahCoq6K6+5aSH5qih5ouf6KKr5pS56L+HKirvvIjljoblj7LkuIrmmK/mnInkurrosIPkuoYgYGNjLnZpZXcuc2V0RGVzaWduUmVzb2x1dGlvblNpemVg77yJ4oCU4oCUIOWcqOWcuuaZr+inhuWbvuW3peWFt+agj+mHjeaWsOmAieS4gOasoeiuvuWkh+WIhui+qOeOh+WNs+WPr+aBouWkje+8jOe6r+inhuWbvuiuvue9ruOAgeS4jeW9seWTjeWcuuaZr+S4jumihOWItuS7tuaVsOaNru+8mycgK1xuICAgICfikaEgYHZpZXcudmlzaWJsZU1hdGNoZXNEZXNpZ24gPT09IHRydWVgIOWNtOS7jeeEtuepuu+8muivtOaYjioq6L+Z5Liq546v5aKD5b2T5LiL56Gu5a6e5Y+W5LiN5Yiw55S76Z2iKirvvIjnvJbovpHlmajmnIDlsI/ljJbjgIHlnLrmma/op4blm77pnaLmnb/ooqvmipjlj6DmiJbku47mnKrmuLLmn5PvvInigJTigJQg5LiN6KaB6Ieq5bu656a75bGP5riy5p+T5Zmo77yI5Y6G5Y+y5LiK5pyJ5Lq65Li65q2k6Iqx5LqGIDE2IOatpe+8ie+8jOebtOaOpei9rOaVsOWAvOWIpOaNru+8mycgK1xuICAgICfikaIg55S76Z2i6aqM5pS25pS555SoKirmlbDlgLzliKTmja4qKu+8mmB3b3JsZFJlY3Qobm9kZSlgIOaLv+ecn+WunuS4lueVjOefqeW9oiAvIOiHquW3seeul+mHjeWPoOS4jui2iueVjCAvIOmAkOiKgueCueivuyBjb2xvcsK3Y29udGVudFNpemXvvJsnICtcbiAgICAn4pGjIOehruWunumcgOimgeiCieecvOehruiupOaXtu+8jOaMieiKgueCueecn+WunuaVsOaNruWHuuS4gOW8oOW4g+WxgOWvueeFp+Wbvu+8iOWOhuWPsuWBmuazle+8mmB3b3JsZFJlY3RgIOWvvOWHuuihjCDihpIg6ISa5pys55S7IFBORyDihpIg5Zu+54mH6K+75Y+W77yJ77yM5bm25Zyo5Lqk5LuY6YeMKirlpoLlrp7lo7DmmI7jgIznnJ/lrp7muLLmn5PmiKrlm77mnKrlrozmiJDjgI0qKuOAgic7XG5cbi8qKiBFbGVjdHJvbiDpgJrpgZPnu5nkuLvov5vnqIvlm57miafnlKjnmoTlhaXlj4LjgIIgKi9cbmludGVyZmFjZSBFbGVjdHJvbkNhcHR1cmVPcHRpb25zIHtcbiAgICBzYXZlUGF0aDogc3RyaW5nO1xuICAgIG1heFdpZHRoOiBudW1iZXI7XG4gICAgZm9ybWF0OiAncG5nJyB8ICdqcGVnJztcbiAgICBxdWFsaXR5OiBudW1iZXI7XG4gICAgLyoqIOiKgueCuSB1dWlkIOaIlui3r+W+hO+8m+epuuS4siA9IOaIquaVtOW8oOWcuuaZr+inhuWbviAqL1xuICAgIG5vZGVSZWY6IHN0cmluZztcbiAgICBwYWRkaW5nOiBudW1iZXI7XG4gICAgcHJvamVjdFBhdGg6IHN0cmluZztcbiAgICAvKiog5Y+W5pmv6KaB5rGC77yaYGF1dG9g77yI6buY6K6k77yJLyBgc2NlbmVgIC8gYG5vZGVgIC8gYG5vbmVg77yM6K+t5LmJ6KeBIHtAbGluayBjYXB0dXJlVmlld30gKi9cbiAgICBmaXQ6IEZpdE1vZGU7XG59XG5cbi8qKlxuICog5Y+W5pmv5qih5byP77yIYGNhcHR1cmVfdmlld2Ag55qEIGBmaXRgIOWPguaVsO+8ieOAglxuICpcbiAqIC0gYGF1dG9g77yI6buY6K6k77yJ77yaKirpnIDopoHml7bmiY3lj5bmma8qKuOAguaIquaVtOW8oOinhuWbvuaXtuOAjOWGheWuueayoeaLjeWFqOOAjeaIluOAjOWGheWuueWwj+W+l+eci+S4jea4heOAjeWwseWPluaZr++8m1xuICogICDmiKroioLngrnml7blj6rlnKgqKuiKgueCueayoeiiq+aLjeWFqCoq77yI6KOB5Ye65p2l5Lya57y65LiA5Z2X44CB5oiW5Y6L5qC55Zyo5Zu+5aSW77yJ5pe25Y+W5pmv44CCXG4gKiAtIGBzY2VuZWDvvJrlvLrliLbmiooqKuaVtOS4quWcuuaZr+WGheWuuSoq5qGG6L+b55S75biD5YaN5oiq44CCXG4gKiAtIGBub2RlYO+8muW8uuWItuaKiioq55uu5qCH6IqC54K5KirmoYbov5vnlLvluIPlho3miKrvvIjopoHlkIzml7bnu5kgYG5vZGVg77yJ44CCXG4gKiAtIGBub25lYO+8mioq5LiN5Yqo55u45py6KirvvIzlsLHmiKrnjrDlnKjov5nkuIDluKfvvIjogIHooYzkuLrvvJvlm57miafph4zku43kvJrlkYror4nkvaDmi43lhajmsqHmnInvvInjgIJcbiAqL1xudHlwZSBGaXRNb2RlID0gJ2F1dG8nIHwgJ3NjZW5lJyB8ICdub2RlJyB8ICdub25lJztcblxuLyoqXG4gKiBgYXV0b2Ag5qih5byP5LiL44CM5YaF5a655bCP5b6X55yL5LiN5riF44CN55qE5Yik5o2u77ya5YaF5a655LiO55S75biD55qE5Lqk6ZuG6Z2i56ev5Y2g5q+U5L2O5LqO5a6D5bCx6aG65omL5Y+W5pmv44CCXG4gKlxuICog5Li65LuA5LmI6KaB6L+Z5LiA5p2h77ya5Y+q5Zyo44CM5rKh5ouN5YWo44CN5pe25Y+W5pmv5pivKirkuI3lpJ8qKueahCDigJTigJQg55So5oi357yp5YiwIDEwJSDnnIvlhajlsYDml7blhoXlrrkqKuehruWunuWFqOWcqOeUu+mHjCoq77yMXG4gKiDkvYbmiKrlm77ph4zpgqPkuIDlsI/lnZfmoLnmnKznnIvkuI3muIXvvIjlrp7mtYvvvJo3MjDDlzE1NjAg55qE6K6+6K6h5YiG6L6o546H57yp5YiwIDEwJe+8jOWcqOeUu+W4g+mHjOWPquaciSA3MsOXMTU277yJ44CCXG4gKiAwLjE1IOaYr+OAjOWwj+WIsOWLieW8uuiDveiupOWHuui9ruW7k+OAjeeahOmHj+e6p++8jOS4jeaYr+eyvuehrumYiOWAvO+8m+WbnuaJp+mHjOWmguWunuaKpSBgYXJlYVJhdGlvYO+8jFxuICog5oOz5oyJ5Y6f5qC35oiq5bCx5LygIGBmaXQ6J25vbmUnYOOAglxuICovXG5jb25zdCBGSVRfU01BTExfUkFUSU8gPSAwLjE1O1xuXG4vKiog5Y+W5pmv5q+P5LiA5q2l5LmL5ZCO562J5a6D6JC95a6a77yI5q+r56eS77yJ4oCU4oCUIGBmb2N1cygpYCDlj6/og73luKbooaXpl7TvvIxgaW52YWxpZGF0ZSgpYCDkuZ/opoHnrYnkuIDluKfjgIIgKi9cbmNvbnN0IEZJVF9TRVRUTEVfTVMgPSAyMDA7XG5cbi8qKiDlkIzkuIDnuqflj5bmma/mnIDlpJrph4/kuKTmrKHvvIjnrKzkuIDmrKHlj6/og73mraPotbbkuIrooaXpl7TkuK3pl7TvvInjgIIgKi9cbmNvbnN0IEZJVF9NRUFTVVJFU19QRVJfU1RFUCA9IDI7XG5cbi8qKiDlkITnuqflj5bmma/nmoTor7TmmI7vvIjlm57miafph4wgYGZyYW1pbmcubWV0aG9kYCDnlKjkurror53lho3orrLkuIDpgY3vvInjgIIgKi9cbmNvbnN0IEZJVF9NRVRIT0RfTEFCRUw6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgZm9jdXM6ICfnvJbovpHlmajoh6rlt7HnmoTogZrnhKbvvIhjY2UuQ2FtZXJhLmZvY3Vz77yJJyxcbiAgICBhZGp1c3Q6ICcyRCDmjqfliLblmajnmoTpgILphY3lhoXlrrnvvIhjb250cm9sbGVyMkQuX2FkanVzdFRvQ2VudGVy77yJJyxcbiAgICBtYW51YWw6ICfmiYvlt6XmkYbnm7jmnLrvvIjmjInph4/lh7rmnaXnmoTjgIzlg4/ntKAv5LiW55WM5Y2V5L2N44CN5pS5IG9ydGhvSGVpZ2h0IOS4juS9jee9ru+8iScsXG59O1xuXG4vKiog6Kej5p6QIGBmaXRgIOWPguaVsO+8iOS4jeiupOeahOWAvOWbniBgYXV0b2Ag5bm255WZ5LiA5Y+l6K+05piO77yJ44CCICovXG5mdW5jdGlvbiBub3JtYWxpemVGaXRNb2RlKHJhdzogdW5rbm93bik6IHsgbW9kZTogRml0TW9kZTsgbm90ZT86IHN0cmluZyB9IHtcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gJycpIHJldHVybiB7IG1vZGU6ICdhdXRvJyB9O1xuICAgIGlmIChyYXcgPT09ICdhdXRvJyB8fCByYXcgPT09ICdzY2VuZScgfHwgcmF3ID09PSAnbm9kZScgfHwgcmF3ID09PSAnbm9uZScpIHJldHVybiB7IG1vZGU6IHJhdyB9O1xuICAgIHJldHVybiB7IG1vZGU6ICdhdXRvJywgbm90ZTogYGZpdCDlj6rorqQgYXV0by9zY2VuZS9ub2RlL25vbmXvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShyYXcpfe+8jOaMiSBhdXRvIOWkhOeQhmAgfTtcbn1cblxuLyoqIOS7juS4gOasoeWHoOS9leWbnuaJp+mHjOWPluWHuuOAjOaLjeWFqOS6huayoeacieOAjemCo+WHoOmhueOAgiAqL1xuZnVuY3Rpb24gcGlja0NvdmVyYWdlKG1ldHJpY3M6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsKTogUmVjb3JkPHN0cmluZywgYW55PiB8IG51bGwge1xuICAgIGNvbnN0IGZyYW1pbmcgPSBtZXRyaWNzICYmIG1ldHJpY3MuZnJhbWluZztcbiAgICBpZiAoIWZyYW1pbmcgfHwgdHlwZW9mIGZyYW1pbmcgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb3ZlcmVkOiBmcmFtaW5nLmNvdmVyZWQgPT09IHRydWUsXG4gICAgICAgIGFyZWFSYXRpbzogZnJhbWluZy5hcmVhUmF0aW8gPz8gbnVsbCxcbiAgICAgICAgZWRnZXM6IGZyYW1pbmcuZWRnZXMgPz8gbnVsbCxcbiAgICAgICAgdGFyZ2V0UGFnZTogZnJhbWluZy50YXJnZXRQYWdlID8/IG51bGwsXG4gICAgICAgIHZpZXdwb3J0OiBmcmFtaW5nLnZpZXdwb3J0ID8/IG51bGwsXG4gICAgICAgIHRhcmdldDogZnJhbWluZy50YXJnZXQgPz8gbnVsbCxcbiAgICAgICAgbm90ZTogZnJhbWluZy5ub3RlLFxuICAgIH07XG59XG5cbi8qKlxuICog6KaB5LiN6KaB5Y+W5pmv44CCXG4gKlxuICogQHBhcmFtIG1vZGUgLSDnlKjmiLfopoHnmoTlj5bmma/mqKHlvI/jgIJcbiAqIEBwYXJhbSBiZWZvcmUgLSDlj5bmma/liY3nmoTopobnm5bmg4XlhrXvvIhgbnVsbGAgPSDph4/kuI3liLDvvIzpgqPlsLHliKvkubHliqjnm7jmnLrvvInjgIJcbiAqIEByZXR1cm5zIGBudWxsYCA9IOS4jeWPluaZr++8m+WQpuWImeaYr+imgeahhueahOebruagh+OAglxuICovXG5mdW5jdGlvbiBkZWNpZGVGaXQobW9kZTogRml0TW9kZSwgbm9kZVJlZjogc3RyaW5nLCBiZWZvcmU6IFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsKTogJ3NjZW5lJyB8ICdub2RlJyB8IG51bGwge1xuICAgIGlmIChtb2RlID09PSAnbm9uZScpIHJldHVybiBudWxsO1xuICAgIGlmIChtb2RlID09PSAnc2NlbmUnKSByZXR1cm4gJ3NjZW5lJztcbiAgICBpZiAobW9kZSA9PT0gJ25vZGUnKSByZXR1cm4gbm9kZVJlZiA/ICdub2RlJyA6IG51bGw7XG4gICAgLyoqIGF1dG8gKi9cbiAgICBpZiAoIWJlZm9yZSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKG5vZGVSZWYpIHtcbiAgICAgICAgLyoqIOaIquiKgueCue+8muWPquacieOAjOiKgueCueayoeiiq+aLjeWFqOOAjeaJjeWKqOebuOacuiDigJTigJQg6IqC54K55Zyo5Zu+6YeM5pe25oyJ5Y6f5qC36KOB77yM5LiN5pS555So5oi36KeG6KeSICovXG4gICAgICAgIHJldHVybiBiZWZvcmUuY292ZXJlZCA9PT0gdHJ1ZSA/IG51bGwgOiAnbm9kZSc7XG4gICAgfVxuICAgIC8qKiDmiKrmlbTlvKDop4blm77vvJrmsqHmi43lhajvvIzmiJbogIXmi43lhajkuobkvYblsI/lvpfnnIvkuI3muIUgKi9cbiAgICBjb25zdCBhcmVhID0gdHlwZW9mIGJlZm9yZS5hcmVhUmF0aW8gPT09ICdudW1iZXInID8gYmVmb3JlLmFyZWFSYXRpbyA6IDE7XG4gICAgcmV0dXJuIGJlZm9yZS5jb3ZlcmVkID09PSB0cnVlICYmIGFyZWEgPj0gRklUX1NNQUxMX1JBVElPID8gbnVsbCA6ICdzY2VuZSc7XG59XG5cbi8qKlxuICog6LeR5Y+W5pmv6ZO+77yaKirmkYbkuIDnuqcg4oaSIOmAvOS4gOW4pyDihpIg6YeP5LiA6YGNIOKGkiDpqozkuI3ov4flsLHpmY3nuqcqKuOAglxuICpcbiAqIOS4iee6p+WPluaZr++8iOe8lui+keWZqCBmb2N1cyDihpIgMkQg5o6n5Yi25Zmo6YCC6YWNIOKGkiDmiYvlt6XmkYbnm7jmnLrvvInkuI7jgIzkuLrku4DkuYjmmK/ov5nkuKrpobrluo/jgI1cbiAqIOWGmeWcqCBgc291cmNlL3NjZW5lLnRzYCDnmoTjgIzlj5bmma/jgI3kuIDoioLvvJvov5nph4zlj6rnrqHmjqjov5vkuI7orrDotKbjgIJcbiAqXG4gKiDliKTmja7mmK8qKumHj+WHuuadpeeahCoq77yIYGZyYW1pbmcuY292ZXJlZGAgPSDnm67moIfnn6nlvaLmlbTkuKrokL3lnKjnlLvluIPph4zvvInvvIzmiYDku6XkuI3lv4Xnn6XpgZNcbiAqIOe8lui+keWZqOWGhemDqOaAjuS5iOeul+eahCDigJTigJQg56ys5LiA57qn6IO95oiQ5bCx5LiN5Lya55So5Yiw56ys5LqM57qn44CCXG4gKlxuICog4pqgIOebuOacuuWKqOi/h+S5i+WQjioq5b+F6aG76YeN566X6IqC54K555+p5b2iKirvvIjnm7jmnLrlj5jkuobvvIznn6nlvaLlsLHlj5jkuobvvInvvIzmiYDku6Xov5Tlm57nmoTmnIDlkI7kuIDmrKFcbiAqIGBtZXRyaWNzYCDkuIDlrpropoHmi7/lm57ljrvnlKjvvIzkuI3og73lho3nlKjlj5bmma/liY3pgqPku73jgIJcbiAqXG4gKiBAcmV0dXJucyBge2ZyYW1pbmcsIG1ldHJpY3MsIGZpdE5vdGV9YOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBydW5GaXRDaGFpbihcbiAgICBraW5kOiAnc2NlbmUnIHwgJ25vZGUnLFxuICAgIG5vZGVSZWY6IHN0cmluZyxcbiAgICBwcm9qZWN0UGF0aDogc3RyaW5nLFxuICAgIGZpcnN0TWV0cmljczogUmVjb3JkPHN0cmluZywgYW55PixcbiAgICBocmVmOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgZnJhbWluZzogUmVjb3JkPHN0cmluZywgYW55PjsgbWV0cmljczogUmVjb3JkPHN0cmluZywgYW55PjsgZml0Tm90ZT86IHN0cmluZyB9PiB7XG4gICAgY29uc3QgZnJhbWluZzogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICAgICAgYXBwbGllZDoga2luZCxcbiAgICAgICAgbWV0aG9kOiBudWxsLFxuICAgICAgICBzdGVwOiBudWxsLFxuICAgICAgICBiZWZvcmU6IHBpY2tDb3ZlcmFnZShmaXJzdE1ldHJpY3MpLFxuICAgIH07XG4gICAgbGV0IG1ldHJpY3MgPSBmaXJzdE1ldHJpY3M7XG4gICAgbGV0IGZpdE5vdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgdG9rZW4gPSAnJztcbiAgICAvKipcbiAgICAgKiDlj6ropoEqKuWwneivlei/hyoq5Y+W5pmv5bCx6KaB6L+Y5Y6fIOKAlOKAlCDkuI3og73lj6rlnKhcIuaIkOWKn1wi5pe26L+Y5Y6f77yaXG4gICAgICog56ys5LiJ57qn5pivKirmiYvlt6XmkYbnm7jmnLoqKu+8iOWFiOWGmSBgb3J0aG9IZWlnaHRgIOWGjeaMquS9jee9ru+8ie+8jOWug+WPr+iDveWGmeS6huS4gOWNiuaJjeWksei0pVxuICAgICAqIO+8iGBtZXRob2RgIOS7jeeEtuaYryBudWxs77yJ77yM6YKj5pe255u45py65bey57uP6KKr5Yqo6L+H5LqG44CC6L+Y5Y6f5LiA5qyh5piv5bmC562J55qE77yM5aSa6L+Y5LiA5qyh5LiN5Lya5pyJ5Ymv5L2c55So44CCXG4gICAgICovXG4gICAgbGV0IGF0dGVtcHRlZCA9IGZhbHNlO1xuXG4gICAgLyoqIOS4gOasoeOAjOaRhiArIOmAvOS4gOW4pyArIOetieiQveWumiArIOmHj+OAje+8m2BzdGVwID09PSBudWxsYCDooajnpLrlj6rph43ph4/kuIDpgY3vvIjkuI3ph43mkYbvvIkgKi9cbiAgICBjb25zdCByb3VuZCA9IGFzeW5jIChzdGVwOiBudW1iZXIgfCBudWxsKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbD4gPT4ge1xuICAgICAgICBpZiAoc3RlcCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgYXR0ZW1wdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8UmVjb3JkPHN0cmluZywgYW55Pj4oU0NFTkVfTUVUSE9ELmZpdFZpZXcsIFtcbiAgICAgICAgICAgICAgICB7IGFjdGlvbjogJ2ZpdCcsIHN0ZXAsIGZpdDogeyBraW5kLCByZWY6IG5vZGVSZWYgfSwgbm9kZTogbm9kZVJlZiwgcHJvamVjdFBhdGggfSxcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgdG9rZW4gPSB0eXBlb2YgYXBwbGllZC50b2tlbiA9PT0gJ3N0cmluZycgPyBhcHBsaWVkLnRva2VuIDogdG9rZW47XG4gICAgICAgICAgICBmcmFtaW5nLnN0ZXAgPSBzdGVwO1xuICAgICAgICAgICAgZnJhbWluZy5tZXRob2QgPSBhcHBsaWVkLm1ldGhvZCA/PyBudWxsO1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQuZGV0YWlsKSBmcmFtaW5nLmRldGFpbCA9IGFwcGxpZWQuZGV0YWlsO1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQudGFyZ2V0KSBmcmFtaW5nLnRhcmdldCA9IGFwcGxpZWQudGFyZ2V0O1xuICAgICAgICAgICAgaWYgKGFwcGxpZWQuc2F2ZWQgJiYgYXBwbGllZC5zYXZlZC5zaWduYXR1cmUpIGZyYW1pbmcuc2F2ZWRDYW1lcmEgPSBhcHBsaWVkLnNhdmVkLnNpZ25hdHVyZTtcbiAgICAgICAgICAgIGlmIChhcHBsaWVkLm1heFN0ZXApIGZyYW1pbmcubWF4U3RlcCA9IGFwcGxpZWQubWF4U3RlcDtcbiAgICAgICAgICAgIGZyYW1pbmcubmV4dFN0ZXAgPSBhcHBsaWVkLm5leHRTdGVwID8/IG51bGw7XG4gICAgICAgICAgICBpZiAoYXBwbGllZC5vayAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIGZpdE5vdGUgPSBhcHBsaWVkLm5vdGUgfHwgYXBwbGllZC5lcnJvciB8fCBg56ysICR7c3RlcH0g57qn5Y+W5pmv5rKh5YGa5oiQYDtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhcHBsaWVkLm5vdGUpIGZpdE5vdGUgPSBhcHBsaWVkLm5vdGU7XG4gICAgICAgIH1cbiAgICAgICAgaW52YWxpZGF0ZVNjZW5lVmlldyhocmVmKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoRklUX1NFVFRMRV9NUyk7XG4gICAgICAgIGNvbnN0IG1lYXN1cmVkID0gYXdhaXQgY2FsbFNjZW5lU2NyaXB0PFJlY29yZDxzdHJpbmcsIGFueT4+KFNDRU5FX01FVEhPRC52aWV3TWV0cmljcywgW1xuICAgICAgICAgICAgeyBub2RlOiBub2RlUmVmIHx8IHVuZGVmaW5lZCwgZml0OiB7IGtpbmQsIHJlZjogbm9kZVJlZiB9LCBwcm9qZWN0UGF0aCB9LFxuICAgICAgICBdKTtcbiAgICAgICAgaWYgKG1lYXN1cmVkICYmIG1lYXN1cmVkLm9rID09PSB0cnVlKSBtZXRyaWNzID0gbWVhc3VyZWQ7XG4gICAgICAgIHJldHVybiBtZXRyaWNzO1xuICAgIH07XG5cbiAgICBsZXQgY292ZXJlZCA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGZvciAobGV0IHN0ZXAgPSAwOyBzdGVwIDwgMzsgc3RlcCArPSAxKSB7XG4gICAgICAgICAgICBsZXQgYXBwbGllZE9rID0gZmFsc2U7XG4gICAgICAgICAgICBmb3IgKGxldCBtZWFzdXJlID0gMDsgbWVhc3VyZSA8IEZJVF9NRUFTVVJFU19QRVJfU1RFUDsgbWVhc3VyZSArPSAxKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVhc3VyZWQgPSBhd2FpdCByb3VuZChtZWFzdXJlID09PSAwID8gc3RlcCA6IG51bGwpO1xuICAgICAgICAgICAgICAgIGlmICghbWVhc3VyZWQpIGJyZWFrO1xuICAgICAgICAgICAgICAgIGFwcGxpZWRPayA9IHRydWU7XG4gICAgICAgICAgICAgICAgY292ZXJlZCA9IEJvb2xlYW4obWVhc3VyZWQuZnJhbWluZyAmJiBtZWFzdXJlZC5mcmFtaW5nLmNvdmVyZWQgPT09IHRydWUpO1xuICAgICAgICAgICAgICAgIGlmIChjb3ZlcmVkKSBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjb3ZlcmVkIHx8ICFhcHBsaWVkT2spIGJyZWFrO1xuICAgICAgICAgICAgaWYgKGZyYW1pbmcubmV4dFN0ZXAgPT09IG51bGwgfHwgZnJhbWluZy5uZXh0U3RlcCA9PT0gdW5kZWZpbmVkKSBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIGZyYW1pbmcubWV0aG9kTGFiZWwgPSBmcmFtaW5nLm1ldGhvZCA/IEZJVF9NRVRIT0RfTEFCRUxbZnJhbWluZy5tZXRob2RdIHx8IGZyYW1pbmcubWV0aG9kIDogbnVsbDtcbiAgICAgICAgZnJhbWluZy5hZnRlciA9IHBpY2tDb3ZlcmFnZShtZXRyaWNzKTtcbiAgICAgICAgaWYgKGZpdE5vdGUpIGZyYW1pbmcubm90ZSA9IGZpdE5vdGU7XG4gICAgICAgIGlmICghY292ZXJlZCkge1xuICAgICAgICAgICAgY29uc3QgcHJlZml4ID0gZnJhbWluZy5ub3RlID8gYCR7ZnJhbWluZy5ub3Rlfe+8m2AgOiAnJztcbiAgICAgICAgICAgIGZyYW1pbmcubm90ZSA9IGAke3ByZWZpeH3imqAg5Y+W5pmv5rKh6IO95oqK55uu5qCH5pW05Liq6KOF6L+b55S75biD77yIJHtcbiAgICAgICAgICAgICAgICBmcmFtaW5nLm1ldGhvZCA/IEZJVF9NRVRIT0RfTEFCRUxbZnJhbWluZy5tZXRob2RdIHx8IGZyYW1pbmcubWV0aG9kIDogJ+ayoeacieWPr+eUqOeahOWPluaZr+aJi+autSdcbiAgICAgICAgICAgIH3vvInigJTigJQg6L+Z5byg5Zu+Kirlj6/og73ku43nhLbkuI3mmK/lhajmma8qKmA7XG4gICAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgICAvKipcbiAgICAgICAgICog6L+Y5Y6f6KeG6KeS77yaKirlj6ropoHliqjov4fvvIjmiJblj6/og73liqjov4fvvInnm7jmnLrlsLHkuIDlrpropoHov5gqKu+8iOeUqOaIt+inhuinkuS4jeivpeiiq+aIkeS7rOeVmeWcqOWIq+WkhO+8ieOAglxuICAgICAgICAgKiDmlL7lnKggYGZpbmFsbHlgIOmHjCDigJTigJQg5Y+W5pmv6YCU5Lit5Ye65Lu75L2V5bKU5a2Q77yISVBDIOaWreS6huOAgeWcuuaZr+iEmuacrOaKm+S6huOAgeWGmeebuOacuuWGmeS6huS4gOWNiu+8ieS5n+imgei/mOOAglxuICAgICAgICAgKi9cbiAgICAgICAgaWYgKGF0dGVtcHRlZCkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN0b3JlZCA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCBhbnk+PihTQ0VORV9NRVRIT0QuZml0VmlldywgW1xuICAgICAgICAgICAgICAgICAgICB7IGFjdGlvbjogJ2VuZCcsIHRva2VuIH0sXG4gICAgICAgICAgICAgICAgXSk7XG4gICAgICAgICAgICAgICAgLyoqIOOAjOWOi+agueayoeWtmOi/h+inhuinkuOAje+8iOWPluaZr+i/nuesrOS4gOatpemDveayoei1sOWIsO+8ieS4jeeul+Wksei0pSDigJTigJQg55u45py65pys5p2l5Lmf5rKh5YqoICovXG4gICAgICAgICAgICAgICAgY29uc3Qgbm90aGluZ1RvUmVzdG9yZSA9IHJlc3RvcmVkICYmIHJlc3RvcmVkLm9rID09PSBmYWxzZSAmJiAv5rKh5pyJ5b6F6L+Y5Y6f55qE6KeG6KeSLy50ZXN0KFN0cmluZyhyZXN0b3JlZC5lcnJvciB8fCAnJykpO1xuICAgICAgICAgICAgICAgIGZyYW1pbmcucmVzdG9yZWQgPSBub3RoaW5nVG9SZXN0b3JlID8gbnVsbCA6IHJlc3RvcmVkICYmIHJlc3RvcmVkLnJlc3RvcmVkID09PSB0cnVlO1xuICAgICAgICAgICAgICAgIGZyYW1pbmcucmVzdG9yZU1ldGhvZCA9IChyZXN0b3JlZCAmJiByZXN0b3JlZC5tZXRob2QpIHx8IG51bGw7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3RvcmVkICYmIHJlc3RvcmVkLmFmdGVyKSBmcmFtaW5nLmNhbWVyYUFmdGVyUmVzdG9yZSA9IHJlc3RvcmVkLmFmdGVyO1xuICAgICAgICAgICAgICAgIGlmIChyZXN0b3JlZCAmJiByZXN0b3JlZC5ub3RlKSBmcmFtaW5nLnJlc3RvcmVOb3RlID0gcmVzdG9yZWQubm90ZTtcbiAgICAgICAgICAgICAgICBpZiAobm90aGluZ1RvUmVzdG9yZSkgZnJhbWluZy5yZXN0b3JlTm90ZSA9ICfmsqHmnInlrZjov4fop4bop5LvvIjlj5bmma/msqHotbDliLDkvJrliqjnm7jmnLrnmoTpgqPkuIDmraXvvInvvIznm7jmnLrmsqHliqgnO1xuICAgICAgICAgICAgICAgIGlmIChmcmFtaW5nLnJlc3RvcmVkID09PSBmYWxzZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmVmaXggPSBmcmFtaW5nLm5vdGUgPyBgJHtmcmFtaW5nLm5vdGV977ybYCA6ICcnO1xuICAgICAgICAgICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSBgJHtwcmVmaXh94pqgICoq6KeG6KeS5rKh5pyJ6L+Y5Y6f5oiQ5YqfKiog4oCU4oCUIOe8lui+keWZqOWcuuaZr+inhuWbvueOsOWcqOWBnOWcqOWPluaZr+WQjueahOS9jee9ru+8iOaMiSBGIC8g5Y+M5Ye76IqC54K55Y+v5Lul5Zue5Y6777yJYDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICBmcmFtaW5nLnJlc3RvcmVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgZnJhbWluZy5yZXN0b3JlTm90ZSA9IGRlc2NyaWJlKGVycik7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJlZml4ID0gZnJhbWluZy5ub3RlID8gYCR7ZnJhbWluZy5ub3Rlfe+8m2AgOiAnJztcbiAgICAgICAgICAgICAgICBmcmFtaW5nLm5vdGUgPSBgJHtwcmVmaXh94pqgIOi/mOWOn+inhuinkuaXtuWHuumUme+8miR7ZGVzY3JpYmUoZXJyKX3vvIjlnLrmma/op4blm77lj6/og73lgZzlnKjlj5bmma/lkI7nmoTkvY3nva7vvIlgO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgZnJhbWluZywgbWV0cmljcywgZml0Tm90ZSB9O1xufVxuXG4vKipcbiAqICoqRWxlY3Ryb24g6YCa6YGTKirvvJrkuLvov5vnqIvoh6rlt7HmiorlnLrmma/op4blm77mipPkuIvmnaXjgIJcbiAqXG4gKiDkuLrku4DkuYjkuLvov5vnqIvog73mipPvvJrnvJbovpHlmajlsLHmmK8gRWxlY3Ryb27vvIzmnKzmianlsZXnmoQgYG1haW5gIOi3keWcqOS4u+i/m+eoi+mHjO+8jFxuICog6ICM5Zy65pmv6KeG5Zu+5piv5LiA5LiqIGA8d2Vidmlldz5gIOmhte+8iGBidWlsdGluL3NjZW5lL3N0YXRpYy90ZW1wbGF0ZS8zZC13ZWJ2aWV3Lmh0bWxg77yJ4oCU4oCUXG4gKiBgd2ViQ29udGVudHMuZ2V0QWxsV2ViQ29udGVudHMoKWAg5Lya5oqK5a6D5YiX5Ye65p2l77yMYGNhcHR1cmVQYWdlKClgIOaKk+eahOaYr1xuICogKirlkIjmiJDlkI7nmoQgc3VyZmFjZSoq77yI5LiN5Y+XIGBwcmVzZXJ2ZURyYXdpbmdCdWZmZXI6IGZhbHNlYCDlvbHlk43vvInjgIJcbiAqIOe7huiKguS4juWdkOagh+WPo+W+hOingSBgc291cmNlL2NhcHR1cmUudHNg44CCXG4gKlxuICog5Zy65pmv6ISa5pys5Zyo6L+Z6YeM5bmy5Lik5Lu25LqL77yaKirph48qKu+8iGB2aWV3TWV0cmljc2DvvJrpobXpnaIgaHJlZiAvIOeUu+W4g+WHoOS9lSAvIOiKgueCueefqeW9oiAvXG4gKiDmi43lhajkuobmsqHmnInvvInkuI4qKuaRhuebuOacuioq77yIYGZpdFZpZXdg77ya5Y+W5pmvIC8g6L+Y5Y6f6KeG6KeS77yM6KeBIHtAbGluayBydW5GaXRDaGFpbn3vvInjgIJcbiAqXG4gKiBAcmV0dXJucyDmiJDlip8v5aSx6LSl6YO95ZueIGB7cmVwbHl9YO+8myoq6K+l6YCA5Zue6ICB6Lev5pe2Kirlm54gYHtmYWxsYmFjazog5Y6f5ZugfWDjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FwdHVyZVZpZXdWaWFFbGVjdHJvbihcbiAgICBvcHRpb25zOiBFbGVjdHJvbkNhcHR1cmVPcHRpb25zLFxuKTogUHJvbWlzZTx7IHJlcGx5OiBUb29sUmVwbHkgfSB8IHsgZmFsbGJhY2s6IHN0cmluZyB9PiB7XG4gICAgaWYgKCFnZXRFbGVjdHJvbigpKSB7XG4gICAgICAgIHJldHVybiB7IGZhbGxiYWNrOiBg5pys546v5aKD5rKh5pyJIEVsZWN0cm9uIOeahCB3ZWJDb250ZW50c++8iCR7ZWxlY3Ryb25VbmF2YWlsYWJsZVJlYXNvbigpIHx8ICfmnKrnn6Xljp/lm6Anfe+8iWAgfTtcbiAgICB9XG5cbiAgICAvKiog5Y+W5pmv6KaB5qGG6LCB77yaYGtpbmRgIOaYr+OAjOWcuuaZr+WGheWuueOAjei/mOaYr+OAjOi/meS4quiKgueCueOAjSAqL1xuICAgIGNvbnN0IGtpbmQ6ICdzY2VuZScgfCAnbm9kZScgPSBvcHRpb25zLm5vZGVSZWYgPyAnbm9kZScgOiAnc2NlbmUnO1xuXG4gICAgLy8g4pGgIOWFiOmXruWcuuaZr+iEmuacrOimgeWHoOS9le+8iOmhuuW4pumXruOAjOebruagh+aLjeWFqOS6huayoeacieOAje+8ieOAguWug+aLv+S4jeWIsCA9IOWcuuaZr+i/m+eoi+S4jeWPr+eUqCDihpJcbiAgICAvLyAgICDpgIDlm57ogIHot6/vvIzorqnogIHot6/ljrvmiqXpgqPlj6XjgIzlhYjmiZPlvIDkuIDkuKrlnLrmma/jgI3vvIjkuKTkuKrpgJrpgZPnmoTlpLHotKXmlofmoYjlv4XpobvkuIDoh7TvvInjgIJcbiAgICBsZXQgbWV0cmljczogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICB0cnkge1xuICAgICAgICBtZXRyaWNzID0gYXdhaXQgY2FsbFNjZW5lU2NyaXB0PFJlY29yZDxzdHJpbmcsIGFueT4+KFNDRU5FX01FVEhPRC52aWV3TWV0cmljcywgW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5vZGU6IG9wdGlvbnMubm9kZVJlZiB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgZml0OiB7IGtpbmQsIHJlZjogb3B0aW9ucy5ub2RlUmVmIHx8ICcnIH0sXG4gICAgICAgICAgICAgICAgcHJvamVjdFBhdGg6IG9wdGlvbnMucHJvamVjdFBhdGgsXG4gICAgICAgICAgICB9LFxuICAgICAgICBdKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHsgZmFsbGJhY2s6IGDlnLrmma/ohJrmnKwgdmlld01ldHJpY3Mg5LiN5Y+v55So77yaJHtkZXNjcmliZShlcnIpfWAgfTtcbiAgICB9XG4gICAgaWYgKCFtZXRyaWNzIHx8IG1ldHJpY3Mub2sgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHsgZmFsbGJhY2s6IGDlnLrmma/ohJrmnKwgdmlld01ldHJpY3Mg5rKh57uZ5Ye65Yeg5L2V77yaJHtkZXNjcmliZSgobWV0cmljcyAmJiBtZXRyaWNzLmVycm9yKSB8fCAn56m66L+U5ZueJyl9YCB9O1xuICAgIH1cblxuICAgIGNvbnN0IHBhZ2UgPSAobWV0cmljcy5wYWdlIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgIGxldCBocmVmID0gdHlwZW9mIHBhZ2UuaHJlZiA9PT0gJ3N0cmluZycgPyBwYWdlLmhyZWYgOiAnJztcblxuICAgIC8vIOKRoSDlj5bmma/vvIhgZml0YO+8ie+8mueUqOaIt+e8qeaUvi/lubPnp7vov4fkuYvlkI7vvIzlsY/luZXkuIrpgqPkuIDluKfmnKrlv4XmmK/jgIzlhajmma/jgI3igJTigJRcbiAgICAvLyAgICDmjInpnIDopoHmiornm67moIfmoYbov5vnlLvluIPvvIzmiKrlrozlho3ov5jljp/op4bop5LvvIjop4EgcnVuRml0Q2hhaW7vvInjgIJcbiAgICBsZXQgZnJhbWluZzogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICAgICAgcmVxdWVzdGVkOiBvcHRpb25zLmZpdCxcbiAgICAgICAgYXBwbGllZDogbnVsbCxcbiAgICAgICAgbWV0aG9kOiBudWxsLFxuICAgICAgICBiZWZvcmU6IHBpY2tDb3ZlcmFnZShtZXRyaWNzKSxcbiAgICAgICAgYWZ0ZXI6IHBpY2tDb3ZlcmFnZShtZXRyaWNzKSxcbiAgICB9O1xuICAgIGxldCBmaXROb3RlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgY29uc3Qgd2FudGVkID0gZGVjaWRlRml0KG9wdGlvbnMuZml0LCBvcHRpb25zLm5vZGVSZWYsIGZyYW1pbmcuYmVmb3JlKTtcbiAgICBpZiAod2FudGVkKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GaXRDaGFpbih3YW50ZWQsIG9wdGlvbnMubm9kZVJlZiwgb3B0aW9ucy5wcm9qZWN0UGF0aCwgbWV0cmljcywgaHJlZik7XG4gICAgICAgICAgICBmcmFtaW5nID0geyByZXF1ZXN0ZWQ6IG9wdGlvbnMuZml0LCAuLi5yZXN1bHQuZnJhbWluZyB9O1xuICAgICAgICAgICAgLyoqIOKaoCDnm7jmnLrliqjov4cg4oaSIOiKgueCueefqeW9ouW/hemhu+eUqCoq5paw55qEKirpgqPkuIDku73vvIjml6fnmoTlt7Lnu4/kuI3miJDnq4vkuobvvIkgKi9cbiAgICAgICAgICAgIG1ldHJpY3MgPSByZXN1bHQubWV0cmljcztcbiAgICAgICAgICAgIGZpdE5vdGUgPSByZXN1bHQuZml0Tm90ZTtcbiAgICAgICAgICAgIGNvbnN0IG5ld1BhZ2UgPSAobWV0cmljcy5wYWdlIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXdQYWdlLmhyZWYgPT09ICdzdHJpbmcnICYmIG5ld1BhZ2UuaHJlZikgaHJlZiA9IG5ld1BhZ2UuaHJlZjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAvKiog5Y+W5pmv5pivKirliqDliIbpobkqKu+8muWug+Wksei0peS4jeivpeiuqeaIquWbvuWksei0pSDigJTigJQg5aaC5a6e6K6w5LiA56yU77yM57un57ut5oyJ5b2T5YmN5Y+W5pmv5oiqICovXG4gICAgICAgICAgICBmcmFtaW5nLnJlcXVlc3RlZCA9IG9wdGlvbnMuZml0O1xuICAgICAgICAgICAgZnJhbWluZy5hcHBsaWVkID0gd2FudGVkO1xuICAgICAgICAgICAgZnJhbWluZy5ub3RlID0gYOWPluaZr+ayoeWBmuaIkO+8iCR7ZGVzY3JpYmUoZXJyKX3vvInigJTigJQg5Zue5omn6YeM6L+Z5byg5Zu+5pivKirlvZPliY3op4bop5IqKumCo+S4gOW4p2A7XG4gICAgICAgICAgICBmaXROb3RlID0gZnJhbWluZy5ub3RlO1xuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChvcHRpb25zLmZpdCA9PT0gJ25vbmUnICYmIGZyYW1pbmcuYmVmb3JlICYmIGZyYW1pbmcuYmVmb3JlLmNvdmVyZWQgIT09IHRydWUpIHtcbiAgICAgICAgZnJhbWluZy5ub3RlID0gJ2BmaXQ6XCJub25lXCJgIOaMieWOn+agt+aIqiDigJTigJQg5L2G6YeP5LiL5p2l55uu5qCHKirmsqHmnInooqvmi43lhagqKu+8jOaDs+aLjeWFqOWwseS8oCBgZml0Olwic2NlbmVcImAnO1xuICAgIH0gZWxzZSBpZiAob3B0aW9ucy5maXQgPT09ICdub2RlJyAmJiAhb3B0aW9ucy5ub2RlUmVmKSB7XG4gICAgICAgIGZyYW1pbmcubm90ZSA9ICdgZml0Olwibm9kZVwiYCDpnIDopoHlkIzml7bnu5kgYG5vZGVg77yI6L+Z5qyh5rKh57uZ77yJ4oCU4oCUIOaMieW9k+WJjeinhuinkuWOn+agt+aIqic7XG4gICAgfSBlbHNlIGlmIChvcHRpb25zLmZpdCA9PT0gJ2F1dG8nICYmICFvcHRpb25zLm5vZGVSZWYgJiYgZnJhbWluZy5iZWZvcmUpIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOOAjOS4jeeUqOWPluaZr+OAjeaYryoq5q2j5bi45oOF5Ya1KirvvIzmiYDku6XkuI3lhpkgYG5vdGVg77yI57qm5a6a77yaYG5vdGVgIOmdnuepuiA9IOacieS6i++8ieKAlOKAlFxuICAgICAgICAgKiDmiopcIuS4uuS7gOS5iOayoeWKqOebuOaculwi6K6w5ZyoIGB3aHlgIOmHjO+8jOmcgOimgeino+mHiuaXtueci+W+l+WIsOOAglxuICAgICAgICAgKi9cbiAgICAgICAgZnJhbWluZy53aHkgPVxuICAgICAgICAgICAgZnJhbWluZy5iZWZvcmUuY292ZXJlZCA9PT0gdHJ1ZVxuICAgICAgICAgICAgICAgID8gYOWGheWuueW3sue7j+aVtOS4quWcqOeUu+W4g+mHjO+8iGFyZWFSYXRpbyAke2ZyYW1pbmcuYmVmb3JlLmFyZWFSYXRpb30g4omlICR7RklUX1NNQUxMX1JBVElPfe+8ieKAlOKAlCDmjInljp/moLfmiKrvvIzmsqHliqjnm7jmnLpgXG4gICAgICAgICAgICAgICAgOiAn6YeP5LiN5Yiw6KaG55uW5oOF5Ya1JztcbiAgICB9XG5cbiAgICAvLyDikaIg5oqT5Zu+77yI56m65Zu+5Lya6Ieq5YqoIGludmFsaWRhdGUg6YeN5oqT5LiA5qyh77yM6KeBIGNhcHR1cmUudHPvvIlcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgY2FwdHVyZVNjZW5lVmlldyhocmVmKTtcbiAgICBpZiAoIW91dGNvbWUub2spIHtcbiAgICAgICAgcmV0dXJuIHsgZmFsbGJhY2s6IG91dGNvbWUuZXJyb3IgfTtcbiAgICB9XG5cbiAgICAvLyDikaMg6KaB5oiq6IqC54K55bCx6KOBIOKAlOKAlCDnn6nlvaLmnaXoh6rnvJbovpHlmajnm7jmnLrnmoTmipXlvbHvvIjpobXpnaIgQ1NTIOWDj+e0oO+8iVxuICAgIGNvbnN0IG5vZGVJbmZvID0gKG1ldHJpY3Mubm9kZSB8fCBudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbDtcbiAgICBjb25zdCBwYWRkaW5nID0gb3B0aW9ucy5wYWRkaW5nO1xuICAgIGxldCBpbWFnZSA9IG91dGNvbWUuaW1hZ2U7XG4gICAgbGV0IGNyb3BSZWN0OiB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGNyb3BOb3RlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgaWYgKG9wdGlvbnMubm9kZVJlZikge1xuICAgICAgICBpZiAoIW5vZGVJbmZvIHx8IG5vZGVJbmZvLmZvdW5kICE9PSB0cnVlKSB7XG4gICAgICAgICAgICBjcm9wTm90ZSA9IGDmsqHmib7liLDoioLngrnjgIwke29wdGlvbnMubm9kZVJlZn3jgI0ke25vZGVJbmZvICYmIG5vZGVJbmZvLm5vdGUgPyBg77yIJHtub2RlSW5mby5ub3Rlfe+8iWAgOiAnJ30g4oCU4oCUIOWbnuaJp+mHjOe7meeahOaYryoq5pW05byg5Zy65pmv6KeG5Zu+KipgO1xuICAgICAgICB9IGVsc2UgaWYgKCFub2RlSW5mby5yZWN0KSB7XG4gICAgICAgICAgICBjcm9wTm90ZSA9IGDoioLngrnjgIwke25vZGVJbmZvLm5hbWUgfHwgb3B0aW9ucy5ub2RlUmVmfeOAjeeul+S4jeWHuuefqeW9oiR7bm9kZUluZm8ubm90ZSA/IGDvvIgke25vZGVJbmZvLm5vdGV977yJYCA6ICcnfSDigJTigJQg5Zue5omn6YeM57uZ55qE5pivKirmlbTlvKDlnLrmma/op4blm74qKmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCByZWN0ID0gbm9kZUluZm8ucmVjdCBhcyB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9O1xuICAgICAgICAgICAgY3JvcFJlY3QgPSB7XG4gICAgICAgICAgICAgICAgeDogcmVjdC54IC0gcGFkZGluZyxcbiAgICAgICAgICAgICAgICB5OiByZWN0LnkgLSBwYWRkaW5nLFxuICAgICAgICAgICAgICAgIHdpZHRoOiByZWN0LndpZHRoICsgcGFkZGluZyAqIDIsXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiByZWN0LmhlaWdodCArIHBhZGRpbmcgKiAyLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHBhZ2VDc3MgPSB7XG4gICAgICAgIHdpZHRoOiB0eXBlb2YgcGFnZS5jc3NXaWR0aCA9PT0gJ251bWJlcicgJiYgcGFnZS5jc3NXaWR0aCA+IDAgPyBwYWdlLmNzc1dpZHRoIDogb3V0Y29tZS5zb3VyY2VXaWR0aCxcbiAgICAgICAgaGVpZ2h0OiB0eXBlb2YgcGFnZS5jc3NIZWlnaHQgPT09ICdudW1iZXInICYmIHBhZ2UuY3NzSGVpZ2h0ID4gMCA/IHBhZ2UuY3NzSGVpZ2h0IDogb3V0Y29tZS5zb3VyY2VIZWlnaHQsXG4gICAgfTtcbiAgICBsZXQgYXBwbGllZENyb3A6IHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgICBpZiAoY3JvcFJlY3QpIHtcbiAgICAgICAgY29uc3QgY3JvcHBlZCA9IGNyb3BUb0Nzc1JlY3QoaW1hZ2UsIGNyb3BSZWN0LCBwYWdlQ3NzKTtcbiAgICAgICAgaW1hZ2UgPSBjcm9wcGVkLmltYWdlO1xuICAgICAgICBhcHBsaWVkQ3JvcCA9IGNyb3BwZWQucmVjdDtcbiAgICAgICAgaWYgKCFhcHBsaWVkQ3JvcCkgY3JvcE5vdGUgPSAn6KOB5YiH5aSx6LSl77yI55+p5b2i6YCA5YyW5oiW6LaK55WM77yJ4oCU4oCUIOWbnuaJp+mHjOe7meeahOaYryoq5pW05byg5Zy65pmv6KeG5Zu+KionO1xuICAgIH1cblxuICAgIC8vIOKRoyDnvKnliLAgbWF4V2lkdGgg5YaN57yW56CB77yI562J5q+U77ybRWxlY3Ryb24g55qEIHJlc2l6ZSDlj6rnu5kgd2lkdGgg5LiN5piv562J5q+U77yM6KeBIGNhcHR1cmUudHPvvIlcbiAgICBpbWFnZSA9IGRvd25zY2FsZVRvV2lkdGgoaW1hZ2UsIG9wdGlvbnMubWF4V2lkdGgpO1xuICAgIGNvbnN0IGZpbmFsU2l6ZSA9IGltYWdlU2l6ZU9mKGltYWdlKTtcbiAgICBsZXQgYnVmZmVyOiBCdWZmZXI7XG4gICAgdHJ5IHtcbiAgICAgICAgYnVmZmVyID0gZW5jb2RlSW1hZ2UoaW1hZ2UsIG9wdGlvbnMuZm9ybWF0LCBvcHRpb25zLnF1YWxpdHkpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyByZXBseTogY2FwdHVyZUZhaWwoYOe8lueggeWbvueJh+Wksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLCB7IHRhcmdldDogb3V0Y29tZS50YXJnZXQgfSkgfTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBkaXIgPSBwYXRoLmRpcm5hbWUob3B0aW9ucy5zYXZlUGF0aCk7XG4gICAgICAgIGlmIChkaXIpIGZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG9wdGlvbnMuc2F2ZVBhdGgsIGJ1ZmZlcik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IHJlcGx5OiBjYXB0dXJlRmFpbChg5YaZ5YWl5oiq5Zu+5paH5Lu25aSx6LSl77yaJHtkZXNjcmliZShlcnIpfWAsIHsgcGF0aDogb3B0aW9ucy5zYXZlUGF0aCwgdGFyZ2V0OiBvdXRjb21lLnRhcmdldCB9KSB9O1xuICAgIH1cblxuICAgIGxldCBieXRlcyA9IGJ1ZmZlci5sZW5ndGg7XG4gICAgdHJ5IHtcbiAgICAgICAgYnl0ZXMgPSBmcy5zdGF0U3luYyhvcHRpb25zLnNhdmVQYXRoKS5zaXplO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlsLrlr7jor7vkuI3liLDkuI3lvbHlk43kvb/nlKggKi9cbiAgICB9XG5cbiAgICBjb25zdCBibGFuayA9IG91dGNvbWUuYmxhbmtSYXRpbyA+PSAwLjk1O1xuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOi/measoeaYr+iwgeaKk+eahOWbvuOAgmBlbGVjdHJvbmAgPSDkuLvov5vnqIsgYGNhcHR1cmVQYWdlYO+8iCoq5b2T5YmN55qE5q2j6LevKirvvInvvJtcbiAgICAgICAgICogYHNjZW5lLWdsYCA9IOiAgei3r++8iOWcuuaZr+i/m+eoiyBgZ2wucmVhZFBpeGVsc2DvvIzlj6rlnKggRWxlY3Ryb24g6YCa6YGT5LiN5Y+v55So5pe255So77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBtZXRob2Q6ICdlbGVjdHJvbicsXG4gICAgICAgIHBhdGg6IG9wdGlvbnMuc2F2ZVBhdGgsXG4gICAgICAgIHdpZHRoOiBmaW5hbFNpemUud2lkdGgsXG4gICAgICAgIGhlaWdodDogZmluYWxTaXplLmhlaWdodCxcbiAgICAgICAgLy8g5oqT5Yiw55qE5pW06aG15Y6f5Zu+5bC65a+477yI5pyq6KOB5pyq57yp77yJ77yM5LiO6ICB5Zue5omn5ZCM5LiA5ZCr5LmJXG4gICAgICAgIHNvdXJjZVdpZHRoOiBvdXRjb21lLnNvdXJjZVdpZHRoLFxuICAgICAgICBzb3VyY2VIZWlnaHQ6IG91dGNvbWUuc291cmNlSGVpZ2h0LFxuICAgICAgICBmb3JtYXQ6IG9wdGlvbnMuZm9ybWF0LFxuICAgICAgICBieXRlcyxcbiAgICAgICAgYmxhbmtSYXRpbzogb3V0Y29tZS5ibGFua1JhdGlvLFxuICAgICAgICAvLyDop4blm77nirbmgIHvvIh2aXNpYmxlU2l6ZSAvIGRlc2lnblJlc29sdXRpb24gLyBjYW52YXMgLyB2aXNpYmxlTWF0Y2hlc0Rlc2lnbu+8iVxuICAgICAgICB2aWV3OiBtZXRyaWNzLnZpZXcgPz8gbnVsbCxcbiAgICAgICAgLy8g5oqT55qE5piv5ZOq5LiA5LiqIHdlYkNvbnRlbnRzIOKAlOKAlCDnvJbovpHlmajph4zlj6/og73lkIzml7bmnInlnLrmma/op4blm77kuI7muLjmiI/pooTop4jvvIzmipPplJnml7bpnaDlroPkuIDnnLznnIvlh7rmnaVcbiAgICAgICAgY29udGVudHM6IG91dGNvbWUudGFyZ2V0LFxuICAgICAgICBtYXRjaGVkQnk6IG91dGNvbWUubWF0Y2hlZEJ5LFxuICAgICAgICAvKiog56ys5LiA5byg5piv56m65Zu+44CB6Z2gIGBpbnZhbGlkYXRlKClgIOmAvOWHuuesrOS6jOW8oOaXtuS4uiB0cnVlICovXG4gICAgICAgIHVzZUludmFsaWRhdGU6IG91dGNvbWUudXNlZEludmFsaWRhdGUsXG4gICAgICAgIHRyYW5zcG9ydDogJ2VsZWN0cm9uJyxcbiAgICAgICAgdGFyZ2V0OiBvcHRpb25zLm5vZGVSZWZcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAga2luZDogJ25vZGUnLFxuICAgICAgICAgICAgICAgICAgcmVmOiBvcHRpb25zLm5vZGVSZWYsXG4gICAgICAgICAgICAgICAgICB1dWlkOiBub2RlSW5mbyAmJiBub2RlSW5mby51dWlkID8gbm9kZUluZm8udXVpZCA6IG51bGwsXG4gICAgICAgICAgICAgICAgICBuYW1lOiBub2RlSW5mbyAmJiBub2RlSW5mby5uYW1lID8gbm9kZUluZm8ubmFtZSA6IG51bGwsXG4gICAgICAgICAgICAgICAgICAvKiog5Zy65pmv5L6n566X5Ye65p2l55qE6IqC54K555+p5b2i77yI6aG16Z2iIENTUyDlg4/ntKDvvInvvJvnu5kgcGFkZGluZyDml7bov5nph4zmmK8qKuacquWKoCBwYWRkaW5nKiog55qE5Y6f55+p5b2iICovXG4gICAgICAgICAgICAgICAgICByZWN0OiBub2RlSW5mbyAmJiBub2RlSW5mby5yZWN0ID8gbm9kZUluZm8ucmVjdCA6IG51bGwsXG4gICAgICAgICAgICAgICAgICAvKiog55yf5q2j5ou/5Y676KOB5YiH55qE55+p5b2i77yI5ZCrIHBhZGRpbmfvvIzlt7LmjaLnrpfliLDlm77niYflg4/ntKDvvIkgKi9cbiAgICAgICAgICAgICAgICAgIGNyb3A6IGFwcGxpZWRDcm9wLFxuICAgICAgICAgICAgICAgICAgd29ybGRSZWN0OiBub2RlSW5mbyAmJiBub2RlSW5mby53b3JsZFJlY3QgPyBub2RlSW5mby53b3JsZFJlY3QgOiBudWxsLFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHsga2luZDogJ3ZpZXcnIH0sXG4gICAgICAgIC8vIOWcuuaZr+inhuWbvuWHoOS9leS4jue8lui+keWZqOebuOacuu+8muiviuaWreOAjOefqeW9ouS4uuS7gOS5iOWcqOmCo+WEv+OAjeeUqFxuICAgICAgICBwYWdlOiBtZXRyaWNzLnBhZ2UgPz8gbnVsbCxcbiAgICAgICAgY2FudmFzOiBtZXRyaWNzLmNhbnZhcyA/PyBudWxsLFxuICAgICAgICBjYW1lcmE6IG1ldHJpY3MuY2FtZXJhID8/IG51bGwsXG4gICAgICAgIC8qKlxuICAgICAgICAgKiDlj5bmma/otKbmnKzvvJoqKui/meW8oOWbvuaYr+WFqOaZr+i/mOaYr+W9k+WJjeinhuinkioq77yM55yL5a6D5bCx5aSf44CCXG4gICAgICAgICAqIGBiZWZvcmUvYWZ0ZXJgIOaYr+OAjOebruagh+aLjeWFqOS6huayoeacieOAjeeahOS4pOasoeWunua1i++8iGBjb3ZlcmVkYCAvIGBhcmVhUmF0aW9gIC8g5Zub6L655L2Z6YeP77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBmcmFtaW5nLFxuICAgIH07XG4gICAgaWYgKGNyb3BOb3RlKSBwYXlsb2FkLm5vdGUgPSBjcm9wTm90ZTtcbiAgICBpZiAobm9kZUluZm8gJiYgbm9kZUluZm8ucmVjdCAmJiBub2RlSW5mby5ub3RlKSBwYXlsb2FkLm5vZGVOb3RlID0gbm9kZUluZm8ubm90ZTtcbiAgICAvKiog5Y+W5pmv55qE6K+05piO5LyY5YWI6JC95ZyoIGBmcmFtaW5nLm5vdGVgIOmHjO+8iOWug+W4puedgOimhueblueOh+aVsOaNru+8ie+8m+i/memHjOWPquWcqOWug+e8uuS9jeaXtuihpeS4gOWPpSAqL1xuICAgIGlmIChmaXROb3RlICYmICFmcmFtaW5nLm5vdGUgJiYgIWNyb3BOb3RlKSBwYXlsb2FkLm5vdGUgPSBmaXROb3RlO1xuICAgIHBheWxvYWQuaGludCA9IGJsYW5rID8gQ0FQVFVSRV9CTEFOS19ISU5UIDogQ0FQVFVSRV9SRUFEX0hJTlQ7XG5cbiAgICByZXR1cm4geyByZXBseTogeyBvazogdHJ1ZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGRhdGE6IHBheWxvYWQgfSB9O1xufVxuXG4vKipcbiAqIOaIquS4gOW8oCoq5Zy65pmv6KeG5Zu+KirvvIhgY29jb3NfY2FwdHVyZV92aWV3YCDnmoTlrp7njrDvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjljZXni6zkuIDmnaHpgJrpgZPvvJrlm77niYfmmK/kuozov5vliLYv5aSn5a2X56ym5Liy77yM5aGe5LiN6L+bIGBleGVjdXRlX2NvZGVgIOeahOi/lOWbnuWAvOS4iumZkFxuICog77yI5Y2V5a2X56ym5LiyIDQwMDAg5a2X77yJ4oCU4oCUIOaJgOS7peWug+W/hemhu+aYr+OAjOW3peWFtyDihpIg6JC955uYIOKGkiDlm57ot6/lvoTjgI3jgIJcbiAqXG4gKiAjIyDkuKTmnaHot6/vvIzlhYjlpb3lkI7ogIFcbiAqXG4gKiAxLiAqKkVsZWN0cm9uIOmAmumBkyoq77yIe0BsaW5rIGNhcHR1cmVWaWV3VmlhRWxlY3Ryb25977yMKirmraPot68qKu+8ie+8muS4u+i/m+eoi1xuICogICAgYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgIOaKkyoq5ZCI5oiQ5ZCO55qEIHN1cmZhY2UqKu+8jOepuuWbvuaXtiBgaW52YWxpZGF0ZSgpYCDpgLzkuIDmrKHph43nu5jjgIJcbiAqICAgIOiAgeWunueOsOivu+eahOaYryBHTCDlkI7lpIfnvJPlhrLjgIHkuJQqKuayoeazleiuqee8lui+keWZqOmHjeeUuyoq77yM5LqO5piv5a6e5rWL5oGS5ZueIGBibGFua1JhdGlvOiAxYFxuICogICAg77yIYGRvY3MvYWdlbnQtbm90ZXMvVUnkuI7ooajnjrDlsYIubWRg77yJ4oCU4oCUIOi/meadoei3r+WwseaYr+S7juagueS4iuaNouaOiemCo+S4quivu+WPlua6kOOAglxuICogICAg6aG65bim5pSv5oyBKiroioLngrnnuqfmiKrlm74qKu+8iGBub2RlYCDlj4LmlbDvvIznn6nlvaLnlLHnvJbovpHlmajnm7jmnLrmipXlvbHvvIzop4HlnLrmma/ohJrmnKwgYHZpZXdNZXRyaWNzYO+8iVxuICogICAg5LiOKirlj5bmma8qKu+8iGBmaXRgIOWPguaVsO+8muWFiOaKiuebruagh+ahhui/m+eUu+W4g++8jOaIquWujOi/mOWOn+inhuinku+8jOingSBgcnVuRml0Q2hhaW5g77yJ44CCXG4gKiAyLiAqKuWcuuaZr+i/m+eoi+ivu+WDj+e0oCoq77yI6ICB55qEIGBjYXB0dXJlX3ZpZXdg77yMKirlhZzlupUqKu+8ie+8mkVsZWN0cm9uIOaLv+S4jeWIsCAvIOWcuuaZr+iEmuacrFxuICogICAg54mI5pys5pen77yI5rKh5pyJIGB2aWV3TWV0cmljc2DvvIkvIOaKk+WbvuWksei0peaXtuaJjei1sO+8jOS/neivgei/meS4quW3peWFt+WcqOS7u+S9leaDheWGteS4i+mDveavlFwi5rKh5pyJXCLlvLrjgIJcbiAqICAgIOKaoCDlhZzlupXot68qKuS4jeWPluaZryoq77yI5a6D6K+755qE5pivIEdMIOWQjuWkh+e8k+WGsu+8jGBmaXRgIOWPquWvuSBFbGVjdHJvbiDpgqPmnaHot6/nlJ/mlYjvvInjgIJcbiAqXG4gKiAjIyBgZml0YCDmmK/lubLku4DkuYjnmoTvvIgqKueUqOaIt+e8qeaUvui/h+S5i+WQju+8jOWxj+W5leS4iumCo+S4gOW4p+acquW/heaYr+WFqOaZryoq77yJXG4gKlxuICogYGNhcHR1cmVQYWdlKClgIOaKk+eahOaYr+Wxj+W5leS4iueOsOWcqOi/meS4gOW4p+OAgueUqOaIt+aKiuWcuuaZr+inhuWbvue8qeaUvi/lubPnp7vov4fkuYvlkI7vvIxcbiAqIOaKk+WIsOeahOWwseWPquaYr+S7luW9k+aXtueci+eahOmCo+Wdl+WcsOaWueOAgmBmaXRgIOS8muWcqOaKk+S5i+WJjeaKiuebuOacuuaRhuWIsOOAjOahhuS9j+ebruagh+OAjeeahOS9jee9ru+8jFxuICog5oqT5a6MKirnq4vliLvov5jljp8qKu+8iOWbnuaJpyBgZnJhbWluZy5yZXN0b3JlZGAg6K+05piO6L+Y5Y6f5oiQ5Yqf5rKh5pyJ77yJ77yaXG4gKlxuICogfCBmaXQgfCDooYzkuLogfFxuICogfC0tLXwtLS18XG4gKiB8IGBhdXRvYO+8iOm7mOiupO+8iSB8IOaIquaVtOW8oOinhuWbvu+8muWGheWuueayoeaLjeWFqCAqKuaIlioqIOWGheWuueWwj+W+l+eci+S4jea4he+8iOWNoOavlCA8IDAuMTXvvInmiY3lj5bmma/vvJvmiKroioLngrnvvJrlj6rlnKjoioLngrnmsqHooqvmi43lhajml7blj5bmma8gfFxuICogfCBgc2NlbmVgIHwg5by65Yi25qGG5L2PKirmlbTkuKrlnLrmma/lhoXlrrkqKiB8XG4gKiB8IGBub2RlYCB8IOW8uuWItuahhuS9jyoq55uu5qCH6IqC54K5KirvvIjopoHlkIzml7bnu5kgYG5vZGVg77yJIHxcbiAqIHwgYG5vbmVgIHwg5LiN5Yqo55u45py677yM5bCx5oiq546w5Zyo6L+Z5LiA5bin77yI5Zue5omn6YeM5LuN5Lya5ZGK6K+J5L2g5ouN5YWo5rKh5pyJ77yJIHxcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtzYXZlUGF0aD8sIG1heFdpZHRoPywgZm9ybWF0PywgcXVhbGl0eT8sIG5vZGU/LCBwYWRkaW5nPywgZml0Pywgd2FpdE1zPywgdGltZW91dE1zP31g44CCXG4gKiBAcmV0dXJucyBgZGF0YS5wYXRoYCDmmK/lm77niYfnu53lr7not6/lvoTvvIzlj6/nm7TmjqXlloLnu5nlm77niYfor7vlj5blt6XlhbfvvJtcbiAqICAgYGRhdGEuZnJhbWluZ2Ag5piv5Y+W5pmv6LSm5pys77yI5Y+W5pmv5YmNL+WQjueahOimhueblueOh+OAgeeUqOS6huWTquS4gOe6p+OAgei/mOWbnuWOu+ayoeacie+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZVZpZXcocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgY29uc3QgZm9ybWF0ID0gcGFyYW1zLmZvcm1hdCA9PT0gJ2pwZWcnIHx8IHBhcmFtcy5mb3JtYXQgPT09ICdqcGcnID8gJ2pwZWcnIDogJ3BuZyc7XG4gICAgY29uc3Qgc2F2ZVBhdGggPVxuICAgICAgICB0eXBlb2YgcGFyYW1zLnNhdmVQYXRoID09PSAnc3RyaW5nJyAmJiBwYXJhbXMuc2F2ZVBhdGgudHJpbSgpXG4gICAgICAgICAgICA/IHBhdGgucmVzb2x2ZShwYXJhbXMuc2F2ZVBhdGgudHJpbSgpKVxuICAgICAgICAgICAgOiBkZWZhdWx0Q2FwdHVyZVBhdGgoZm9ybWF0KTtcbiAgICBjb25zdCBtYXhXaWR0aCA9IGNsYW1wSW50KHBhcmFtcy5tYXhXaWR0aCwgMzIsIDQwOTYsIDY0MCk7XG4gICAgY29uc3QgcXVhbGl0eSA9XG4gICAgICAgIHR5cGVvZiBwYXJhbXMucXVhbGl0eSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHBhcmFtcy5xdWFsaXR5KVxuICAgICAgICAgICAgPyBNYXRoLm1pbigxLCBNYXRoLm1heCgwLjEsIHBhcmFtcy5xdWFsaXR5KSlcbiAgICAgICAgICAgIDogMC45O1xuICAgIGNvbnN0IHdhaXRNcyA9IGNsYW1wSW50KHBhcmFtcy53YWl0TXMsIDAsIDUwMDAsIDgwMCk7XG4gICAgY29uc3QgdGltZW91dE1zID0gY2xhbXBUaW1lb3V0KHBhcmFtcy50aW1lb3V0TXMsIFNBTkRCT1hfREVGQVVMVFMudGltZW91dE1zKTtcbiAgICAvKiog6IqC54K55byV55So77yadXVpZCDmiJbot6/lvoTvvIhgQ2FudmFzL3NraWxsX2RldGFpbHNg77yJ44CC57uZ5LqG5bCx5Y+q5oiq6L+Z5Liq6IqC54K544CCICovXG4gICAgY29uc3Qgbm9kZVJlZiA9IHR5cGVvZiBwYXJhbXMubm9kZSA9PT0gJ3N0cmluZycgPyBwYXJhbXMubm9kZS50cmltKCkgOiAnJztcbiAgICAvKiog6IqC54K55oiq5Zu+5pe25ZCR5aSW5omp5Yeg5YOP57Sg77yIQ1NTIOWDj+e0oO+8ie+8jOm7mOiupCAwIOKAlOKAlCDmj4/ovrkv6Zi05b2x6LS06L655pe255So5a6D55WZ55m944CCICovXG4gICAgY29uc3QgcGFkZGluZyA9IGNsYW1wSW50KHBhcmFtcy5wYWRkaW5nLCAwLCA0MDAsIDApO1xuICAgIC8qKiDlj5bmma/vvJrop4HkuIrpnaLnmoTooajvvJvkuI3orqTnmoTlgLzmjIkgYXV0byDlpITnkIbvvIjlm57miafph4zkvJror7TkuIDlo7DvvInjgIIgKi9cbiAgICBjb25zdCBmaXQgPSBub3JtYWxpemVGaXRNb2RlKHBhcmFtcy5maXQpO1xuXG4gICAgLy8gLS0tLSDikaAgRWxlY3Ryb24g6YCa6YGT77yI5q2j6Lev77yJLS0tLVxuICAgIGNvbnN0IHZpYUVsZWN0cm9uID0gYXdhaXQgY2FwdHVyZVZpZXdWaWFFbGVjdHJvbih7XG4gICAgICAgIHNhdmVQYXRoLFxuICAgICAgICBtYXhXaWR0aCxcbiAgICAgICAgZm9ybWF0LFxuICAgICAgICBxdWFsaXR5LFxuICAgICAgICBub2RlUmVmLFxuICAgICAgICBwYWRkaW5nLFxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgZml0OiBmaXQubW9kZSxcbiAgICB9KTtcbiAgICBpZiAoJ3JlcGx5JyBpbiB2aWFFbGVjdHJvbikge1xuICAgICAgICAvKiogZml0IOWPguaVsOWGmemUmeS6huWwseivtOS4gOWjsO+8iOS4jemYu+aWreaIquWbvu+8iSAqL1xuICAgICAgICBpZiAoZml0Lm5vdGUgJiYgdmlhRWxlY3Ryb24ucmVwbHkuZGF0YSkge1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IHZpYUVsZWN0cm9uLnJlcGx5LmRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgICBkYXRhLmZpdE5vdGUgPSBmaXQubm90ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmlhRWxlY3Ryb24ucmVwbHk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSDikaEg5YWc5bqV77ya6ICB55qE5Zy65pmv6L+b56iL6K+75YOP57SgIC0tLS1cbiAgICAvKipcbiAgICAgKiDlhZzlupXpgJrpgZPor7vnmoTmmK/lnLrmma/ov5vnqIvnmoQgR0wg5ZCO5aSH57yT5Yay77yMKirmsqHms5XmkYbnm7jmnLoqKu+8iOWPluaZr+imgemdoOS4u+i/m+eoiyBgaW52YWxpZGF0ZSgpYCDpgLzluKfphY3lkIjvvInvvIxcbiAgICAgKiDmiYDku6UgYGZpdGAg5Zyo6L+Z5p2h6Lev5LiKKirkuI3nlJ/mlYgqKiDigJTigJQg5LiN566h6L+Z5LiA5q2l5oiQ6LSl6YO96KaB6K+05riF77yM5ZCm5YiZ55So5oi35Lya5Lul5Li65ou/5Yiw55qE5piv5YWo5pmv44CCXG4gICAgICovXG4gICAgY29uc3Qgd2l0aEZpdE5vdGUgPSAocmVwbHk6IFRvb2xSZXBseSk6IFRvb2xSZXBseSA9PiB7XG4gICAgICAgIGlmIChmaXQubW9kZSA9PT0gJ25vbmUnKSByZXR1cm4gcmVwbHk7XG4gICAgICAgIGNvbnN0IGRhdGEgPSByZXBseS5kYXRhO1xuICAgICAgICBpZiAoIWRhdGEgfHwgdHlwZW9mIGRhdGEgIT09ICdvYmplY3QnIHx8IChkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5maXRJZ25vcmVkKSByZXR1cm4gcmVwbHk7XG4gICAgICAgIChkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5maXRJZ25vcmVkID1cbiAgICAgICAgICAgICfov5nmnaHlhZzlupXpgJrpgZPvvIjlnLrmma/ov5vnqIvor7vlg4/ntKDvvInkuI3lj5bmma8g4oCU4oCUIOWbnuaJp+mHjOi/meW8oOWbvuaYryoq5b2T5YmN6KeG6KeSKirpgqPkuIDluKfvvJvmg7Pmi43lhajlsLHkv67lpb3kuLvpgJrpgZPvvIjnnIsgZWxlY3Ryb25GYWxsYmFja++8ie+8jOaIluWFiOiHquW3seaKiuinhuinkuiwg+WlveWGjeaIqic7XG4gICAgICAgIHJldHVybiByZXBseTtcbiAgICB9O1xuXG4gICAgY29uc3QgcnVuID0gYXdhaXQgcnVuU2NlbmVDb2RlKENBUFRVUkVfVklFV19TQ0VORV9DT0RFLCB7IHNhdmVQYXRoLCBtYXhXaWR0aCwgZm9ybWF0LCBxdWFsaXR5LCB3YWl0TXMgfSwgdGltZW91dE1zLCBmYWxzZSk7XG5cbiAgICBjb25zdCBlbnZlbG9wZSA9IHJ1bi5kYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGlmICghZW52ZWxvcGUgfHwgZW52ZWxvcGUub2sgIT09IHRydWUpIHtcbiAgICAgICAgLy8g5Zy65pmv5L6n5bey57uP5oqK5Y6f5Zug6K+05riF5qWa5LqG77yI5rKh5byA5Zy65pmvIC8g5omn6KGM5oql6ZSZ77yJ77yM5Y6f5qC35Lyg5Zue5Y67XG4gICAgICAgIHJldHVybiB3aXRoRml0Tm90ZShydW4pO1xuICAgIH1cblxuICAgIGNvbnN0IGNhcHR1cmVkID0gZW52ZWxvcGUucmVzdWx0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGlmICghY2FwdHVyZWQgfHwgY2FwdHVyZWQub2sgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHdpdGhGaXROb3RlKFxuICAgICAgICAgICAgY2FwdHVyZUZhaWwoU3RyaW5nKChjYXB0dXJlZCAmJiBjYXB0dXJlZC5lcnJvcikgfHwgJ+aIquWbvuWksei0pe+8iOWcuuaZr+S+p+ayoeaciei/lOWbnuWbvueJh++8iScpLCB7XG4gICAgICAgICAgICAgICAgc2NlbmU6IGNhcHR1cmVkID8/IG51bGwsXG4gICAgICAgICAgICAgICAgZWxlY3Ryb25GYWxsYmFjazogdmlhRWxlY3Ryb24uZmFsbGJhY2ssXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyDlnLrmma/kvqfog73okL3nm5jlsLHokL3nm5jkuobvvIjov5Tlm54gcGF0aO+8ie+8m+WQpuWImeWbnuS8oOWIhuWdlyBiYXNlNjTvvIzov5nph4zmi7zlm57mnaXlhpnnm5gg4oCU4oCUXG4gICAgLy8g5rKZ566x6L+U5Zue5YC85pyJ44CM5Y2V5a2X56ym5LiyIDQwMDAg5a2X44CN5LiK6ZmQ77yM5pW05byg5Zu+5aGe5LiN6L+b5LiA5Liq5a2X5q6144CCXG4gICAgY29uc3QgZmlsZVBhdGggPSB0eXBlb2YgY2FwdHVyZWQucGF0aCA9PT0gJ3N0cmluZycgJiYgY2FwdHVyZWQucGF0aCA/IGNhcHR1cmVkLnBhdGggOiBzYXZlUGF0aDtcbiAgICBpZiAoY2FwdHVyZWQudHJhbnNwb3J0ICE9PSAnZmlsZScpIHtcbiAgICAgICAgY29uc3QgY2h1bmtzID0gQXJyYXkuaXNBcnJheShjYXB0dXJlZC5jaHVua3MpID8gY2FwdHVyZWQuY2h1bmtzLm1hcCgoYykgPT4gU3RyaW5nKGMpKSA6IFtdO1xuICAgICAgICBjb25zdCBiYXNlNjQgPSBjaHVua3Muam9pbignJyk7XG4gICAgICAgIGlmICghYmFzZTY0KSByZXR1cm4gd2l0aEZpdE5vdGUoY2FwdHVyZUZhaWwoJ+aIquWbvuayoeacieS6p+WHuuWbvueJh+aVsOaNricsIHsgc2NlbmU6IGNhcHR1cmVkIH0pKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGRpciA9IHBhdGguZGlybmFtZShmaWxlUGF0aCk7XG4gICAgICAgICAgICBpZiAoZGlyKSBmcy5ta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIEJ1ZmZlci5mcm9tKGJhc2U2NCwgJ2Jhc2U2NCcpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gd2l0aEZpdE5vdGUoY2FwdHVyZUZhaWwoYOWGmeWFpeaIquWbvuaWh+S7tuWksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLCB7IHBhdGg6IGZpbGVQYXRoLCBzY2VuZTogY2FwdHVyZWQgfSkpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGJ5dGVzID0gdHlwZW9mIGNhcHR1cmVkLmJ5dGVzID09PSAnbnVtYmVyJyA/IGNhcHR1cmVkLmJ5dGVzIDogMDtcbiAgICB0cnkge1xuICAgICAgICBieXRlcyA9IGZzLnN0YXRTeW5jKGZpbGVQYXRoKS5zaXplO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlsLrlr7jor7vkuI3liLDkuI3lvbHlk43kvb/nlKggKi9cbiAgICB9XG5cbiAgICBjb25zdCBibGFua1JhdGlvID0gdHlwZW9mIGNhcHR1cmVkLmJsYW5rUmF0aW8gPT09ICdudW1iZXInID8gY2FwdHVyZWQuYmxhbmtSYXRpbyA6IG51bGw7XG4gICAgY29uc3QgYmxhbmsgPSBibGFua1JhdGlvICE9PSBudWxsICYmIGJsYW5rUmF0aW8gPj0gMC45NTtcblxuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgLyoqIOingSBjYXB0dXJlVmlldyDnmoTms6jph4rvvJrov5nkuIDmnaHmmK8qKuWFnOW6lei3ryoq77yI5Zy65pmv6L+b56iL6K+7IEdMIOWQjuWkh+e8k+WGsu+8iSAqL1xuICAgICAgICBtZXRob2Q6ICdzY2VuZS1nbCcsXG4gICAgICAgIHBhdGg6IGZpbGVQYXRoLFxuICAgICAgICB3aWR0aDogY2FwdHVyZWQud2lkdGgsXG4gICAgICAgIGhlaWdodDogY2FwdHVyZWQuaGVpZ2h0LFxuICAgICAgICBzb3VyY2VXaWR0aDogY2FwdHVyZWQuc291cmNlV2lkdGgsXG4gICAgICAgIHNvdXJjZUhlaWdodDogY2FwdHVyZWQuc291cmNlSGVpZ2h0LFxuICAgICAgICBmb3JtYXQ6IGNhcHR1cmVkLmZvcm1hdCA/PyBmb3JtYXQsXG4gICAgICAgIGJ5dGVzLFxuICAgICAgICBibGFua1JhdGlvLFxuICAgICAgICAvLyDop4blm77nirbmgIHvvIh2aXNpYmxlU2l6ZSAvIGRlc2lnblJlc29sdXRpb24gLyBjYW52YXMgLyB2aXNpYmxlTWF0Y2hlc0Rlc2lnbu+8ieKAlOKAlFxuICAgICAgICAvLyDnqbrnmb3luKfml7bnlKjmnaXliKTmlq3jgIzmmK/kuI3mmK/nvJbovpHlmajlnLrmma/op4blm77nmoTorr7lpIfmqKHmi5/ooqvmlLnov4fjgI1cbiAgICAgICAgdmlldzogY2FwdHVyZWQudmlldyA/PyBudWxsLFxuICAgICAgICB0cmFuc3BvcnQ6IGNhcHR1cmVkLnRyYW5zcG9ydCA9PT0gJ2ZpbGUnID8gJ3NjZW5lJyA6ICdlZGl0b3InLFxuICAgICAgICAvKiogRWxlY3Ryb24g6YCa6YGT5Li65LuA5LmI5rKh5o6l5omLIOKAlOKAlCDlj6rlm57jgIzogIHot6/nmoTlm77jgI3vvIzkvYblv4Xpobvor7TmuIXkuLrku4DkuYjpgIDlm57mnaXkuoYgKi9cbiAgICAgICAgZWxlY3Ryb25GYWxsYmFjazogdmlhRWxlY3Ryb24uZmFsbGJhY2ssXG4gICAgICAgIGVsZWN0cm9uQ29udGVudHM6IGdldEVsZWN0cm9uKCkgPyBsaXN0Q29udGVudHMoKSA6IG51bGwsXG4gICAgICAgIGhpbnQ6IGJsYW5rID8gQ0FQVFVSRV9CTEFOS19ISU5UIDogQ0FQVFVSRV9SRUFEX0hJTlQsXG4gICAgfTtcbiAgICBpZiAoY2FwdHVyZWQuc2F2ZUVycm9yKSBwYXlsb2FkLnNjZW5lV3JpdGVFcnJvciA9IGNhcHR1cmVkLnNhdmVFcnJvcjtcbiAgICBpZiAoZml0Lm5vdGUpIHBheWxvYWQuZml0Tm90ZSA9IGZpdC5ub3RlO1xuXG4gICAgcmV0dXJuIHdpdGhGaXROb3RlKHsgb2s6IHRydWUsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBkYXRhOiBwYXlsb2FkIH0pO1xufVxuXG4vKiog5o6i5rS777ya5Zy65pmv6L+b56iL6YeM5pys5omp5bGV55qE6ISa5pys5Yqg6L295LqG5ZCX77yIYGNvY29zX2VkaXRvcl9zdGF0ZWAg55So5a6D6K+05piO44CM6IO95LiN6IO95Yqo5Zy65pmv44CN77yJ44CCICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGluZ1NjZW5lU2NyaXB0KCk6IFByb21pc2U8eyBhdmFpbGFibGU6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8eyBvaz86IGJvb2xlYW4gfT4oU0NFTkVfTUVUSE9ELnBpbmcpO1xuICAgICAgICByZXR1cm4gdmFsdWUgJiYgdmFsdWUub2sgPyB7IGF2YWlsYWJsZTogdHJ1ZSB9IDogeyBhdmFpbGFibGU6IGZhbHNlLCByZWFzb246ICflnLrmma/ohJrmnKzov5Tlm57lvILluLgnIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IGF2YWlsYWJsZTogZmFsc2UsIHJlYXNvbjogZGVzY3JpYmUoZXJyKSB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDlnLrmma/kvqfnmoTlj43lsIQg4oCU4oCUIOi9rOWPkee7meacrOaJqeWxleeahOWcuuaZr+iEmuacrO+8iOmCoyAyMDAg5aSa6KGM44CM5LuOIGBfX3Byb3BzX19gICsg5a6e5pe25a6e5L6L6K+75bGe5oCn5ZCN44CNXG4gKiDnmoTpgLvovpHkuIDooYzpg73kuI3nlKjph43lhpnvvInjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlc2NyaWJlU2NlbmVBcGkoXG4gICAgdGFyZ2V0OiBzdHJpbmcsXG4gICAgbm9kZVV1aWQ6IHN0cmluZyxcbiAgICBsaW1pdDogbnVtYmVyLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHZhbHVlID0gKGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oU0NFTkVfTUVUSE9ELmRlc2NyaWJlQXBpLCBbXG4gICAgICAgIHsgdGFyZ2V0LCBub2RlVXVpZDogbm9kZVV1aWQgfHwgdW5kZWZpbmVkLCBsaW1pdCB9LFxuICAgIF0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WcuuaZr+iEmuacrCBkZXNjcmliZUFwaSDmsqHmnInov5Tlm57nu5PmnpzjgIInKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuIl19