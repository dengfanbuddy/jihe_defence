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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type ToolReply } from '../constants';
import {
    captureSceneView,
    cropToCssRect,
    downscaleToWidth,
    electronUnavailableReason,
    encodeImage,
    getElectron,
    imageSizeOf,
    listContents,
} from '../capture';
import {
    buildRecipeHelpers,
    RECIPE_HELPER_SIGNATURES,
    type RecipeRunner,
    type RecipeRunOutcome,
} from './recipes';
import { callSceneScript, SceneUnavailableError } from './scene-bridge';
import { runInSandbox } from './sandbox';
import { formatInline, safeSerialize, type SerializeOptions } from './serialize';

export type CodeContext = 'editor' | 'scene';

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
const SERIALIZE_OPTIONS: Partial<SerializeOptions> = {
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
} as const;

/** 把任意异常收敛成一句话。 */
function describe(error: unknown): string {
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
function buildSafeProcess(): Record<string, unknown> {
    return {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        versions: { ...process.versions },
        pid: process.pid,
        cwd: () => process.cwd(),
        uptime: () => process.uptime(),
        memoryUsage: () => process.memoryUsage(),
        hrtime: (time?: [number, number]) => process.hrtime(time),
    };
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
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
function probeImage(ref: unknown, options?: Record<string, unknown>): Record<string, unknown> {
    const opts: Record<string, unknown> = options || {};
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) {
        throw new Error("probe(ref)：要一个图片路径，例如 probe('db://assets/resources/textures/common/rect_rd_20.png')。");
    }

    let file = raw;
    if (raw.indexOf('db://assets/') === 0) {
        file = path.join(Editor.Project.path, 'assets', raw.slice('db://assets/'.length));
    } else if (raw.indexOf('db://') === 0) {
        throw new Error(
            `probe：'${raw}' 指向的不是工程 assets 里的文件（db://internal 之类是引擎内置资源，磁盘上不在工程目录）。`,
        );
    }
    if (!path.isAbsolute(file)) file = path.join(Editor.Project.path, file);

    if (!fs.existsSync(file)) {
        // 路径写错是最常见的原因 —— 顺手把同目录下名字相近的列出来，省一轮 listDir
        let nearby: string[] = [];
        try {
            const base = path.basename(file).replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase();
            const stem = base.slice(0, Math.min(6, base.length));
            nearby = fs
                .readdirSync(path.dirname(file))
                .filter((name) => name.toLowerCase().indexOf(stem) >= 0)
                .slice(0, 8);
        } catch {
            nearby = [];
        }
        return { ok: false, path: file, exists: false, error: `文件不存在：${file}`, nearby };
    }

    let uuid: string | null = null;
    try {
        const metaFile = `${file}.meta`;
        if (fs.existsSync(metaFile)) {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { uuid?: unknown };
            if (meta && typeof meta.uuid === 'string') uuid = meta.uuid;
        }
    } catch {
        /* 读不到就算了：像素结论不依赖它 */
    }
    /** 与 `audit:ui` 的 P4 同一条判据：引擎内置贴图 uuid 前缀 */
    const engineBuiltin = Boolean(uuid && uuid.indexOf('7d8f9b89') === 0);

    const electron = getElectron() as { nativeImage?: { createFromPath(p: string): any } } | null;
    if (!electron || !electron.nativeImage || typeof electron.nativeImage.createFromPath !== 'function') {
        return {
            ok: false,
            path: file,
            exists: true,
            uuid,
            error: `拿不到 Electron 的 nativeImage（${electronUnavailableReason() || '当前不在主进程？'}），读不了像素。`,
        };
    }

    let image: any;
    let size: { width: number; height: number } = { width: 0, height: 0 };
    let bitmap: Buffer;
    try {
        image = electron.nativeImage.createFromPath(file);
        size = image.getSize();
        if (!size.width || !size.height) {
            return { ok: false, path: file, exists: true, uuid, error: 'nativeImage 解不开这张图（格式不认识？）。' };
        }
        bitmap = image.toBitmap(); // BGRA
    } catch (err) {
        return {
            ok: false,
            path: file,
            exists: true,
            uuid,
            error: `解像素失败：${err instanceof Error ? err.message : String(err)}`,
        };
    }

    /** BGRA → 一个像素。越界回 null（不抛）。 */
    const pixelAt = (x: number, y: number): Record<string, number> | null => {
        if (!(x >= 0 && y >= 0 && x < size.width && y < size.height)) return null;
        const o = (y * size.width + x) * 4;
        if (o + 3 >= bitmap.length) return null;
        return { r: bitmap[o + 2], g: bitmap[o + 1], b: bitmap[o], a: bitmap[o + 3] };
    };
    const toHex = (px: Record<string, number> | null): string | null =>
        px ? `#${[px.r, px.g, px.b, px.a].map((v) => v.toString(16).padStart(2, '0')).join('')}` : null;

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
    const colourTally = new Map<string, number>();
    for (let i = 0; i < total; i += step) {
        const px = pixelAt(i % size.width, Math.floor(i / size.width));
        if (!px) continue;
        sampled += 1;
        if (px.a < alphaMin) alphaMin = px.a;
        if (px.a > alphaMax) alphaMax = px.a;
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
        if (px.a >= 200 && minC >= 200 && maxC - minC <= 24) whiteishCount += 1;
        const key = `${px.r >> 5},${px.g >> 5},${px.b >> 5}`;
        colourTally.set(key, (colourTally.get(key) || 0) + 1);
    }

    const meanOf = (sum: number): number => (opaqueCount > 0 ? Math.round(sum / opaqueCount) : 0);
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

    const out: Record<string, unknown> = {
        ok: true,
        path: file,
        exists: true,
        uuid,
        engineBuiltin,
        bytes: (() => {
            try {
                return fs.statSync(file).size;
            } catch {
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
        if (!px) out.atNote = `(${wantX}, ${wantY}) 越界了（图是 ${size.width}×${size.height}）`;
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
    ...RECIPE_HELPER_SIGNATURES,
] as const;

/** editor 上下文的起手式助手（recipe 五件套由 `runEditorContext` 另加）。 */
function buildEditorHelpers(): Record<string, unknown> {
    return {
        sleep,
        /** 扩展包根目录 —— 想读本插件源码时用 */
        extensionRoot: EXTENSION_ROOT,
        /** 当前工程根目录 */
        projectPath: () => Editor.Project.path,
        /** 把相对/绝对路径统一成绝对路径（相对工程的路径按工程根解析） */
        resolveProjectPath: (p: string) => (path.isAbsolute(p) ? p : path.join(Editor.Project.path, p)),
        /** 列目录（只返回名字，避免一次吐太多） */
        listDir: (dir: string): string[] => {
            const abs = path.isAbsolute(dir) ? dir : path.join(Editor.Project.path, dir);
            return fs.readdirSync(abs);
        },
        /** 读 JSON（配表脚本经常要干这个） */
        readJson: (file: string): unknown => {
            const abs = path.isAbsolute(file) ? file : path.join(Editor.Project.path, file);
            return JSON.parse(fs.readFileSync(abs, 'utf-8'));
        },
        /** 图片像素探针 —— 见 {@link probeImage} 的说明（「这图能不能染色」靠它一句话答） */
        probe: (ref: unknown, options?: Record<string, unknown>) => probeImage(ref, options),
        helperNames: () => [...EDITOR_HELPER_SIGNATURES],
    };
}

/** 把沙箱日志行转成响应里的字符串数组 */
function formatLogLines(logs: Array<{ level: string; text: string }>): string[] {
    return logs.map((l) => `[${l.level}] ${l.text}`);
}

/** 夹一个调用方传进来的超时（模型与面板都可能给脏值） */
function clampTimeout(value: unknown, fallback: number): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(100, Math.min(300000, Math.trunc(raw)));
}

/** 整数夹取（截图参数用）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
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
export async function runEditorCode(
    code: string,
    args: Record<string, unknown>,
    timeoutMs: number,
): Promise<ToolReply> {
    // 惰性持有执行器：recipe 助手要能调「跑一段代码」，而那段代码又需要同样的全局量
    // （包括 recipe 助手自己）—— 互相引用，所以必须晚绑定。
    const runnerRef: { current: RecipeRunner | null } = { current: null };

    const { helpers: recipeHelpers } = buildRecipeHelpers({
        projectPath: Editor.Project.path,
        context: 'editor',
        defaultTimeoutMs: timeoutMs,
        getRunner: () => {
            const runner = runnerRef.current;
            if (!runner) throw new Error('recipe 执行器尚未就绪');
            return runner;
        },
    });

    const globals: Record<string, unknown> = {
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
    runnerRef.current = async (
        recipeCode: string,
        recipeArgs: Record<string, unknown>,
        nestedTimeoutMs: number,
    ): Promise<RecipeRunOutcome> => {
        const nested = await runInSandbox({
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

    const run = await runInSandbox({
        code,
        globals,
        label: 'dsh-editor',
        ...sandboxOptions,
        timeoutMs,
    });

    const serialized = safeSerialize(run.result, SERIALIZE_OPTIONS);
    // 「上下文选错了」不能只回一句 cc is not defined（见 explainError 里记的实测代价）
    const error = run.ok ? null : explainError(run.error ?? { name: 'Error', message: '编辑器侧执行失败' }, 'editor');
    const envelope: Record<string, unknown> = {
        ok: run.ok,
        context: 'editor',
        durationMs: run.durationMs,
        ...(run.ok ? { result: serialized.value } : { error }),
    };
    if (run.logs.length > 0) envelope.logs = formatLogLines(run.logs);
    if (run.logsTruncated) envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (run.timedOut) envelope.timedOut = true;
    if (serialized.truncated) {
        const notes = (envelope.notes as string[] | undefined) ?? [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }

    const text = JSON.stringify(envelope, null, 2);
    return run.ok
        ? { ok: true, text, data: envelope }
        : {
              ok: false,
              text,
              error: `${error?.name ?? 'Error'}: ${error?.message ?? '编辑器侧执行失败'}`,
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
export async function runSceneCode(
    code: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    wantSnapshot: boolean,
): Promise<ToolReply> {
    let sceneResult: Record<string, unknown>;
    try {
        sceneResult = await callSceneScript<Record<string, unknown>>(SCENE_METHOD.runCode, [
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
    } catch (err) {
        const message = err instanceof SceneUnavailableError ? err.message : describe(err);
        const envelope = { ok: false, context: 'scene', error: message };
        return { ok: false, text: JSON.stringify(envelope, null, 2), error: message, data: envelope };
    }

    const ok = sceneResult.ok === true;
    // 场景侧返回的是引擎里的活对象，必须过一遍序列化再进响应
    const serialized = safeSerialize(sceneResult.result, SERIALIZE_OPTIONS);

    // 快照登记：脚本内 snapshot() 置位，或调用方显式要求
    let snapshotTaken: boolean | undefined;
    if (ok && (sceneResult.snapshotRequested === true || wantSnapshot)) {
        snapshotTaken = await requestSceneSnapshot();
    }

    const rawError = sceneResult.error as { name?: string; message?: string } | undefined;
    const error = ok ? null : explainError({ name: rawError?.name ?? 'Error', message: rawError?.message ?? '场景执行失败' }, 'scene');

    const envelope: Record<string, unknown> = {
        ok,
        context: 'scene',
        durationMs: sceneResult.durationMs ?? 0,
        ...(ok ? { result: serialized.value } : { error }),
    };
    const sceneLogs = Array.isArray(sceneResult.logs)
        ? (sceneResult.logs as Array<{ level: string; text: string }>)
        : [];
    if (sceneLogs.length > 0) envelope.logs = formatLogLines(sceneLogs);
    if (sceneResult.logsTruncated) envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (sceneResult.timedOut) envelope.timedOut = true;
    if (snapshotTaken !== undefined) envelope.undoSnapshot = snapshotTaken;
    if (serialized.truncated) {
        const notes = (envelope.notes as string[] | undefined) ?? [];
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
        const notes = (envelope.notes as string[] | undefined) ?? [];
        notes.push(
            `这次改动真生效了（已登记撤销快照），而且代码有 ${code.length} 字 —— ` +
                '如果以后还会用（建树 / 按契约搭 UI / 批量改节点 / 存预制件），' +
                '把**同一段代码**用 saveRecipe(名字, <这段代码>, {description, params, returns}) 存下来：' +
                '下次开工 findRecipes 就能找到它，不用从零再写一遍。' +
                '（一次性的探索直接 return 就行，别存。）',
        );
        envelope.notes = notes;
    }

    const text = JSON.stringify(envelope, null, 2);
    return ok
        ? { ok: true, text, data: envelope }
        : {
              ok: false,
              text,
              error: `${error?.name ?? 'Error'}: ${error?.message ?? '场景执行失败'}`,
              data: envelope,
          };
}

/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
async function requestSceneSnapshot(): Promise<boolean> {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 对外：execute_code / capture_view / 探活 / 场景侧 describe_api
// ---------------------------------------------------------------------------

export interface ExecuteCodeParams {
    code?: unknown;
    context?: unknown;
    args?: unknown;
    timeoutMs?: unknown;
    snapshot?: unknown;
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
const SCENE_ONLY_MARKERS: Array<{ pattern: RegExp; name: string }> = [
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
const EDITOR_ONLY_MARKERS: Array<{ pattern: RegExp; name: string }> = [
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
const WEAK_SCENE_NAMES =
    /\b(cc|cocos|director|nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|worldRect|loadFrame|captureView|pick|labelFit|snapshotTree|diffTree)\b/;

/** 命中清单里的哪几个（给回执里的人话说明用）。 */
function markersOf(code: string, markers: Array<{ pattern: RegExp; name: string }>): string[] {
    const hit: string[] = [];
    for (const marker of markers) {
        if (marker.pattern.test(code) && hit.indexOf(marker.name) < 0) hit.push(marker.name);
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
function inferContext(code: string): {
    context: CodeContext;
    sceneMarkers: string[];
    editorMarkers: string[];
} {
    const sceneMarkers = markersOf(code, SCENE_ONLY_MARKERS);
    const editorMarkers = markersOf(code, EDITOR_ONLY_MARKERS);
    if (sceneMarkers.length > 0) return { context: 'scene', sceneMarkers, editorMarkers };
    if (editorMarkers.length > 0) return { context: 'editor', sceneMarkers, editorMarkers };
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
function explainError(error: { name: string; message: string }, context: CodeContext): { name: string; message: string } {
    if (error.name !== 'ReferenceError') return error;
    const missed = /^(?<id>[A-Za-z_$][\w$]*) is not defined$/.exec(error.message.trim())?.groups?.id ?? '';
    if (!missed) return error;

    const sceneGlobals = ['cc', 'cocos', 'director', 'scene', 'js', 'nodeByPath', 'nodeByUuid', 'eachNode', 'contentChildren', 'isEditorNode', 'tree', 'dump', 'captureView', 'find'];
    const editorGlobals = ['Editor', 'require', 'module', 'exports', '__dirname', '__filename', 'fs', 'path', 'os', 'Buffer', 'projectPath', 'resolveProjectPath', 'listDir', 'readJson', 'extensionRoot'];

    if (context === 'editor' && sceneGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message:
                `${error.message}\n` +
                `↑ 「${missed}」是**场景上下文**才有的（这次跑在 editor 沙箱里，那里只有 Editor / require / fs）。\n` +
                `改法：cocos_execute_code({ context: 'scene', code: … })。\n` +
                `下次也可以只写 context，两边通用：改节点/组件 → 'scene'；资源库/工程设置/读盘 → 'editor'。`,
        };
    }
    if (context === 'scene' && editorGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message:
                `${error.message}\n` +
                `↑ 「${missed}」是**编辑器主进程**才有的（这次跑在场景进程里）。\n` +
                `改法：cocos_execute_code({ context: 'editor', code: … }) —— 资源库（asset-db）、工程设置、构建都走它。`,
        };
    }
    return error;
}

/** `cocos_execute_code` 的实现：一次执行里完成「取数据 → 改状态 → 返回结论」。 */
export async function executeCode(params: ExecuteCodeParams): Promise<ToolReply> {
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code.trim()) {
        return { ok: false, text: 'execute_code：code 是空的。', error: 'code 不能为空' };
    }

    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    const args =
        params.args && typeof params.args === 'object' && !Array.isArray(params.args)
            ? (params.args as Record<string, unknown>)
            : {};

    /**
     * `context` 的三种情况，**都要说清是哪一种**：
     * ① 显式给了 → 照做（后面出错时按这个上下文翻译错误）；
     * ② 没给 → 按代码里的标识符推断，并在回执里注明 `contextInferred: true`
     *    （悄悄替模型做决定但不告诉它，下次它还是会漏写）；
     * ③ 推断也不成立 → editor（无副作用的那个）。
     */
    const explicit: CodeContext | null = params.context === 'scene' ? 'scene' : params.context === 'editor' ? 'editor' : null;
    const inferred = explicit === null ? inferContext(code) : null;
    const context: CodeContext = explicit ?? inferred!.context;

    const reply =
        context === 'scene'
            ? await runSceneCode(code, args, timeoutMs, params.snapshot === true)
            : await runEditorCode(code, args, timeoutMs);

    /**
     * 没给 context 的那次：把「我替你选了哪个、凭什么」写进回执。
     *
     * 写在**信封**（`data`）里而不是只写在文本里，是为了 `unwrapSandboxResult` 之外的调用方
     * （面板、日志）也看得到；文本里同样会出现 —— 模型只读文本。
     */
    if (inferred) {
        const envelope = reply.data as Record<string, unknown> | undefined;
        if (envelope) {
            envelope.contextInferred = true;
            const why =
                context === 'scene'
                    ? `代码里出现了 ${inferred.sceneMarkers.join(' / ')}`
                    : inferred.editorMarkers.length > 0
                      ? `代码里出现了 ${inferred.editorMarkers.join(' / ')}`
                      : '代码里没有只属于某一侧的标识符';
            const notes = (envelope.notes as string[] | undefined) ?? [];
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
function defaultCapturePath(format: string): string {
    const dir = path.join(os.tmpdir(), 'dsh-cocos-captures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `scene-view-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
}

/** 截图失败时的统一回执（不抛，让模型看到可读的原因）。 */
function captureFail(message: string, extra?: Record<string, unknown>): ToolReply {
    const payload = { ok: false, error: message, ...(extra ?? {}) };
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
const CAPTURE_BLANK_HINT =
    '这是空图（blankRatio≈1），**别再重试截图** —— 本扩展**不调 `invalidate()`**（不碰合成器，' +
    '理由见 `source/capture.ts` 文件头与 `docs/冻结诊断.md`），' +
    '换 waitMs / 重新聚焦 / 换 maxWidth 都不会变。先看 `view` 再决定，按顺序做：' +
    '① `view.visibleMatchesDesign === false`：编辑器场景视图的**设备模拟被改过**（历史上是有人调了 `cc.view.setDesignResolutionSize`）—— 在场景视图工具栏重新选一次设备分辨率即可恢复，纯视图设置、不影响场景与预制件数据；' +
    '② `view.visibleMatchesDesign === true` 却仍然空：说明**这个环境当下确实取不到画面**（编辑器最小化、场景视图面板被折叠或从未渲染）—— 不要自建离屏渲染器（历史上有人为此花了 16 步），直接转数值判据；' +
    '③ 画面验收改用**数值判据**：`worldRect(node)` 拿真实世界矩形 / 自己算重叠与越界 / 逐节点读 color·contentSize；' +
    '④ 确实需要肉眼确认时，按节点真实数据出一张布局对照图（历史做法：`worldRect` 导出行 → 脚本画 PNG → 图片读取），并在交付里**如实声明「真实渲染截图未完成」**。';

/** Electron 通道给主进程回执用的入参。 */
interface ElectronCaptureOptions {
    savePath: string;
    maxWidth: number;
    format: 'png' | 'jpeg';
    quality: number;
    /** 节点 uuid 或路径；空串 = 截整张场景视图 */
    nodeRef: string;
    padding: number;
    projectPath: string;
    /** 取景要求：`auto`（默认）/ `scene` / `node` / `none`，语义见 {@link captureView} */
    fit: FitMode;
    /** 「想要哪一种画面」：`auto`（不管）/ `scene`（编辑器场景）/ `game`（跑着的游戏），见 {@link ViewTarget} */
    view: ViewTarget;
}

/**
 * 取景模式（`capture_view` 的 `fit` 参数）。
 *
 * - `auto`（默认）：**需要时才取景**。截整张视图时「内容没拍全」或「内容小得看不清」就取景；
 *   截节点时只在**节点没被拍全**（裁出来会缺一块、或压根在图外）时取景。
 * - `scene`：强制把**整个场景内容**框进画布再截。
 * - `node`：强制把**目标节点**框进画布再截（要同时给 `node`）。
 * - `none`：**不动相机**，就截现在这一帧（老行为；回执里仍会告诉你拍全没有）。
 */
type FitMode = 'auto' | 'scene' | 'node' | 'none';

/**
 * 「想要哪一种画面」（`capture_view` 的 `view` 参数）。
 *
 * 编辑器里那块场景视图**同一时刻只画一样东西**：编辑态的编辑器场景，或者运行预览
 * （game view，编辑器工具栏那颗播放键）跑着的**游戏画面**。两者用的是**不同的相机**
 * （见 `source/scene.ts` 的 `readSceneMode`），所以"我要的是哪一种"必须由调用方说清楚 ——
 * 否则回执里那张图到底是场景还是游戏，只有图自己知道。
 *
 * - `auto`（默认）：不管，抓现在这一帧 —— 但回执里**照样**会说清抓到的是哪一种（`mode`）。
 * - `scene`：要编辑器场景。拿到的是运行态画面时会**明说不对**（不假装成功）。
 * - `game`：要跑着的游戏。**运行态下不再取景、不再裁节点**（两者都建立在编辑器相机上，
 *   而那时在渲染的是游戏相机 —— 摆了也不会改变画面）。
 */
type ViewTarget = 'auto' | 'scene' | 'game';

/**
 * 解析 `view` 参数。
 *
 * `'preview'` 按 `game` 理解（读者多半是想说"跑起来那个画面"），但会**多写一句**说明
 * 它有两种读法 —— 浏览器/模拟器预览是另一个应用的另一个进程，本扩展够不着。
 */
function normalizeViewTarget(raw: unknown): { mode: ViewTarget; note?: string } {
    if (raw === undefined || raw === null || raw === '' || raw === 'auto') return { mode: 'auto' };
    if (raw === 'scene' || raw === 'game') return { mode: raw };
    if (raw === 'preview') {
        return {
            mode: 'game',
            note:
                '`view:"preview"` 按 `game`（编辑器内运行预览）理解。若你指的是**浏览器/模拟器预览**，' +
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
const FIT_METHOD_LABEL: Record<string, string> = {
    focus: '编辑器自己的聚焦（cce.Camera.focus）',
    adjust: '2D 控制器的适配内容（controller2D._adjustToCenter）',
    manual: '手工摆相机（按量出来的「像素/世界单位」改 orthoHeight 与位置）',
};

/** 解析 `fit` 参数（不认的值回 `auto` 并留一句说明）。 */
function normalizeFitMode(raw: unknown): { mode: FitMode; note?: string } {
    if (raw === undefined || raw === null || raw === '') return { mode: 'auto' };
    if (raw === 'auto' || raw === 'scene' || raw === 'node' || raw === 'none') return { mode: raw };
    return { mode: 'auto', note: `fit 只认 auto/scene/node/none，收到 ${JSON.stringify(raw)}，按 auto 处理` };
}

/** 从一次几何回执里取出「拍全了没有」那几项。 */
function pickCoverage(metrics: Record<string, any> | null): Record<string, any> | null {
    const framing = metrics && metrics.framing;
    if (!framing || typeof framing !== 'object') return null;
    return {
        covered: framing.covered === true,
        areaRatio: framing.areaRatio ?? null,
        edges: framing.edges ?? null,
        targetPage: framing.targetPage ?? null,
        viewport: framing.viewport ?? null,
        target: framing.target ?? null,
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
function decideFit(mode: FitMode, nodeRef: string, before: Record<string, any> | null): 'scene' | 'node' | null {
    if (mode === 'none') return null;
    if (mode === 'scene') return 'scene';
    if (mode === 'node') return nodeRef ? 'node' : null;
    /** auto */
    if (!before) return null;
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
async function runFitChain(
    kind: 'scene' | 'node',
    nodeRef: string,
    projectPath: string,
    firstMetrics: Record<string, any>,
    href: string,
): Promise<{ framing: Record<string, any>; metrics: Record<string, any>; fitNote?: string }> {
    const framing: Record<string, any> = {
        applied: kind,
        method: null,
        step: null,
        before: pickCoverage(firstMetrics),
    };
    let metrics = firstMetrics;
    let fitNote: string | undefined;
    let token = '';
    /**
     * 只要**尝试过**取景就要还原 —— 不能只在"成功"时还原：
     * 第三级是**手工摆相机**（先写 `orthoHeight` 再挪位置），它可能写了一半才失败
     * （`method` 仍然是 null），那时相机已经被动过了。还原一次是幂等的，多还一次不会有副作用。
     */
    let attempted = false;

    /** 一次「摆 + 逼一帧 + 等落定 + 量」；`step === null` 表示只重量一遍（不重摆） */
    const round = async (step: number | null): Promise<Record<string, any> | null> => {
        if (step !== null) {
            attempted = true;
            const applied = await callSceneScript<Record<string, any>>(SCENE_METHOD.fitView, [
                { action: 'fit', step, fit: { kind, ref: nodeRef }, node: nodeRef, projectPath },
            ]);
            token = typeof applied.token === 'string' ? applied.token : token;
            framing.step = step;
            framing.method = applied.method ?? null;
            if (applied.detail) framing.detail = applied.detail;
            if (applied.target) framing.target = applied.target;
            if (applied.saved && applied.saved.signature) framing.savedCamera = applied.saved.signature;
            if (applied.maxStep) framing.maxStep = applied.maxStep;
            framing.nextStep = applied.nextStep ?? null;
            if (applied.ok !== true) {
                fitNote = applied.note || applied.error || `第 ${step} 级取景没做成`;
                return null;
            }
            if (applied.note) fitNote = applied.note;
        }
        /**
         * ⛔ 这里曾经有一句 `invalidateSceneView(href)`（"相机动了，逼一帧再量"）。
         * 2026-10-08 之后**删掉了**：本扩展一次 `invalidate()` 都不调（见 `source/capture.ts` 文件头）。
         * 代价如实说：相机刚动完就量，读到的**可能是重画前的那一帧** ——
         * 所以下面这一量与主进程侧的取景链会**多量几轮**，而不是靠逼一帧来"保证新鲜"。
         */
        await sleep(FIT_SETTLE_MS);
        const measured = await callSceneScript<Record<string, any>>(SCENE_METHOD.viewMetrics, [
            { node: nodeRef || undefined, fit: { kind, ref: nodeRef }, projectPath },
        ]);
        if (measured && measured.ok === true) metrics = measured;
        return metrics;
    };

    let covered = false;
    try {
        for (let step = 0; step < 3; step += 1) {
            let appliedOk = false;
            for (let measure = 0; measure < FIT_MEASURES_PER_STEP; measure += 1) {
                const measured = await round(measure === 0 ? step : null);
                if (!measured) break;
                appliedOk = true;
                covered = Boolean(measured.framing && measured.framing.covered === true);
                if (covered) break;
            }
            if (covered || !appliedOk) break;
            if (framing.nextStep === null || framing.nextStep === undefined) break;
        }

        framing.methodLabel = framing.method ? FIT_METHOD_LABEL[framing.method] || framing.method : null;
        framing.after = pickCoverage(metrics);
        if (fitNote) framing.note = fitNote;
        if (!covered) {
            const prefix = framing.note ? `${framing.note}；` : '';
            framing.note = `${prefix}⚠ 取景没能把目标整个装进画布（${
                framing.method ? FIT_METHOD_LABEL[framing.method] || framing.method : '没有可用的取景手段'
            }）—— 这张图**可能仍然不是全景**`;
        }
    } finally {
        /**
         * 还原视角：**只要动过（或可能动过）相机就一定要还**（用户视角不该被我们留在别处）。
         * 放在 `finally` 里 —— 取景途中出任何岔子（IPC 断了、场景脚本抛了、写相机写了一半）也要还。
         */
        if (attempted) {
            try {
                const restored = await callSceneScript<Record<string, any>>(SCENE_METHOD.fitView, [
                    { action: 'end', token },
                ]);
                /** 「压根没存过视角」（取景连第一步都没走到）不算失败 —— 相机本来也没动 */
                const nothingToRestore = restored && restored.ok === false && /没有待还原的视角/.test(String(restored.error || ''));
                framing.restored = nothingToRestore ? null : restored && restored.restored === true;
                framing.restoreMethod = (restored && restored.method) || null;
                if (restored && restored.after) framing.cameraAfterRestore = restored.after;
                if (restored && restored.note) framing.restoreNote = restored.note;
                if (nothingToRestore) framing.restoreNote = '没有存过视角（取景没走到会动相机的那一步），相机没动';
                if (framing.restored === false) {
                    const prefix = framing.note ? `${framing.note}；` : '';
                    framing.note = `${prefix}⚠ **视角没有还原成功** —— 编辑器场景视图现在停在取景后的位置（按 F / 双击节点可以回去）`;
                }
            } catch (err) {
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
async function captureViewViaElectron(
    options: ElectronCaptureOptions,
): Promise<{ reply: ToolReply } | { fallback: string }> {
    if (!getElectron()) {
        return { fallback: `本环境没有 Electron 的 webContents（${electronUnavailableReason() || '未知原因'}）` };
    }

    /** 取景要框谁：`kind` 是「场景内容」还是「这个节点」 */
    const kind: 'scene' | 'node' = options.nodeRef ? 'node' : 'scene';

    // ① 先问场景脚本要几何（顺带问「目标拍全了没有」）。它拿不到 = 场景进程不可用 →
    //    退回老路，让老路去报那句「先打开一个场景」（两个通道的失败文案必须一致）。
    let metrics: Record<string, any>;
    try {
        metrics = await callSceneScript<Record<string, any>>(SCENE_METHOD.viewMetrics, [
            {
                node: options.nodeRef || undefined,
                fit: { kind, ref: options.nodeRef || '' },
                projectPath: options.projectPath,
            },
        ]);
    } catch (err) {
        return { fallback: `场景脚本 viewMetrics 不可用：${describe(err)}` };
    }
    if (!metrics || metrics.ok !== true) {
        return { fallback: `场景脚本 viewMetrics 没给出几何：${describe((metrics && metrics.error) || '空返回')}` };
    }

    const page = (metrics.page || {}) as Record<string, any>;
    let href = typeof page.href === 'string' ? page.href : '';

    /**
     * 这一页现在画的是**编辑器场景**还是**跑着的游戏** —— 由场景脚本报上来（`viewMetrics.runtime`，
     * 见 `source/scene.ts` 的 `readSceneMode`）。「运行态」有两条硬后果（下面 ② 与 ④ 各一条）：
     * 取景与裁节点都建立在**编辑器相机**上，而运行态的渲染相机是**游戏自己的**。
     */
    const runtime = (metrics.runtime || {}) as Record<string, any>;
    const running = runtime.running === true;
    const actualMode = typeof runtime.mode === 'string' ? runtime.mode : 'unknown';

    /**
     * 「没给出正确模式」时的如实说明。
     *
     * 约定：`note` 非空 = 有事。这里只在**调用方要的那一种与实际那一种不一致**时才写，
     * 而且写的是事实（"这张图是 X"），不是安慰（"可能不是你要的"）。
     */
    let viewNote: string | undefined;
    if (options.view === 'game' && !running) {
        viewNote =
            '要的是**运行态**（game view）画面，但编辑器现在**不在**运行预览里 —— 这张图是**编辑器场景**。' +
            '本扩展**已经开不了预览了**（那条能力 2026-10-08 撤掉了，理由见 `cocos_runtime` 的说明）：' +
            '要看游戏画面，请**自己在编辑器工具栏按那颗播放键**，回来再截。';
    } else if (options.view === 'scene' && running) {
        viewNote =
            '要的是**编辑器场景**，但编辑器现在正在跑运行预览 —— 这张图是**游戏画面**。' +
            '想要编辑器场景：请**自己在编辑器工具栏按停止**再截。';
    } else if (options.view !== 'auto' && runtime.mode === 'unknown' && runtime.note) {
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
    let fitMode: FitMode = options.fit;
    /** 运行态下「取景被忽略」的说明 —— 它属于**取景账本**（`framing.note`），不是「拿错画面」那一类 */
    let fitOverrideNote: string | undefined;
    if (running && fitMode !== 'none') {
        fitMode = 'none';
        fitOverrideNote =
            '运行态下不取景：`fit` 摆的是编辑器相机，而画面由游戏自己的相机渲染，摆了也不会改变这张图（这次按原样截）。';
    }

    let framing: Record<string, any> = {
        requested: fitMode,
        applied: null,
        method: null,
        before: pickCoverage(metrics),
        after: pickCoverage(metrics),
    };
    let fitNote: string | undefined;
    const wanted = decideFit(fitMode, options.nodeRef, framing.before);
    if (wanted) {
        try {
            const result = await runFitChain(wanted, options.nodeRef, options.projectPath, metrics, href);
            framing = { requested: fitMode, ...result.framing };
            /** ⚠ 相机动过 → 节点矩形必须用**新的**那一份（旧的已经不成立了） */
            metrics = result.metrics;
            fitNote = result.fitNote;
            const newPage = (metrics.page || {}) as Record<string, any>;
            if (typeof newPage.href === 'string' && newPage.href) href = newPage.href;
        } catch (err) {
            /** 取景是**加分项**：它失败不该让截图失败 —— 如实记一笔，继续按当前取景截 */
            framing.requested = fitMode;
            framing.applied = wanted;
            framing.note = `取景没做成（${describe(err)}）—— 回执里这张图是**当前视角**那一帧`;
            fitNote = framing.note;
        }
    } else if (fitMode === 'none' && framing.before && framing.before.covered !== true) {
        framing.note = '`fit:"none"` 按原样截 —— 但量下来目标**没有被拍全**，想拍全就传 `fit:"scene"`';
    } else if (fitMode === 'node' && !options.nodeRef) {
        framing.note = '`fit:"node"` 需要同时给 `node`（这次没给）—— 按当前视角原样截';
    } else if (fitMode === 'auto' && !options.nodeRef && framing.before) {
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
    if (fitOverrideNote && !framing.note) framing.note = fitOverrideNote;

    // ③ 抓图（**只读**：一次 `capturePage()`，不排重绘 —— 见 capture.ts 文件头那条硬口径）
    const outcome = await captureSceneView(href);
    if (!outcome.ok) {
        return { fallback: outcome.error };
    }

    // ④ 要截节点就裁 —— 矩形来自编辑器相机的投影（页面 CSS 像素）
    const nodeInfo = (metrics.node || null) as Record<string, any> | null;
    const padding = options.padding;
    let image = outcome.image;
    let cropRect: { x: number; y: number; width: number; height: number } | null = null;
    let cropNote: string | undefined;
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
        } else if (!nodeInfo || nodeInfo.found !== true) {
            cropNote = `没找到节点「${options.nodeRef}」${nodeInfo && nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 回执里给的是**整张场景视图**`;
        } else if (!nodeInfo.rect) {
            cropNote = `节点「${nodeInfo.name || options.nodeRef}」算不出矩形${nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 回执里给的是**整张场景视图**`;
        } else {
            const rect = nodeInfo.rect as { x: number; y: number; width: number; height: number };
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
    let appliedCrop: { x: number; y: number; width: number; height: number } | null = null;
    if (cropRect) {
        const cropped = cropToCssRect(image, cropRect, pageCss);
        image = cropped.image;
        appliedCrop = cropped.rect;
        if (!appliedCrop) cropNote = '裁切失败（矩形退化或越界）—— 回执里给的是**整张场景视图**';
    }

    // ④ 缩到 maxWidth 再编码（等比；Electron 的 resize 只给 width 不是等比，见 capture.ts）
    image = downscaleToWidth(image, options.maxWidth);
    const finalSize = imageSizeOf(image);
    let buffer: Buffer;
    try {
        buffer = encodeImage(image, options.format, options.quality);
    } catch (err) {
        return { reply: captureFail(`编码图片失败：${describe(err)}`, { target: outcome.target }) };
    }

    try {
        const dir = path.dirname(options.savePath);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(options.savePath, buffer);
    } catch (err) {
        return { reply: captureFail(`写入截图文件失败：${describe(err)}`, { path: options.savePath, target: outcome.target }) };
    }

    let bytes = buffer.length;
    try {
        bytes = fs.statSync(options.savePath).size;
    } catch {
        /* 尺寸读不到不影响使用 */
    }

    const blank = outcome.blankRatio >= 0.95;
    const payload: Record<string, unknown> = {
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
        view: metrics.view ?? null,
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
            sources: runtime.sources ?? null,
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
        page: metrics.page ?? null,
        canvas: metrics.canvas ?? null,
        camera: metrics.camera ?? null,
        /**
         * 取景账本：**这张图是全景还是当前视角**，看它就够。
         * `before/after` 是「目标拍全了没有」的两次实测（`covered` / `areaRatio` / 四边余量）。
         */
        framing,
    };
    if (cropNote) payload.note = cropNote;
    if (nodeInfo && nodeInfo.rect && nodeInfo.note) payload.nodeNote = nodeInfo.note;
    /** 取景的说明优先落在 `framing.note` 里（它带着覆盖率数据）；这里只在它缺位时补一句 */
    if (fitNote && !framing.note && !cropNote) payload.note = fitNote;
    else if (fitOverrideNote && !cropNote && !payload.note) payload.note = fitOverrideNote;
    /**
     * ⚠ 「要的那种画面没拿到」**压过**上面两条。
     *
     * 它说的不是"这张图小瑕疵"，而是"这张图根本不是你要的那个东西" ——
     * 被 `framing.note` 或裁剪说明盖掉的话，调用方会拿着一张错画面的图继续往下走
     * （这正是最难查的一类错：工具没报错，图也在，就是不对）。
     */
    if (viewNote) payload.note = viewNote;
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
export async function captureView(params: Record<string, unknown>): Promise<ToolReply> {
    const format = params.format === 'jpeg' || params.format === 'jpg' ? 'jpeg' : 'png';
    const savePath =
        typeof params.savePath === 'string' && params.savePath.trim()
            ? path.resolve(params.savePath.trim())
            : defaultCapturePath(format);
    const maxWidth = clampInt(params.maxWidth, 32, 4096, 640);
    const quality =
        typeof params.quality === 'number' && Number.isFinite(params.quality)
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
            const data = viaElectron.reply.data as Record<string, unknown>;
            if (fit.note) data.fitNote = fit.note;
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
    const withFitNote = (reply: ToolReply): ToolReply => {
        const data = reply.data;
        const payload = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
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
            if (payload) payload.viewNote = view.note;
            return reply;
        }
        if (fit.mode === 'none') return reply;
        if (!payload || payload.fitIgnored) return reply;
        payload.fitIgnored =
            '这条兜底通道（场景进程读像素）不取景 —— 回执里这张图是**当前视角**那一帧；想拍全就修好主通道（看 electronFallback），或先自己把视角调好再截';
        return reply;
    };

    const run = await runSceneCode(CAPTURE_VIEW_SCENE_CODE, { savePath, maxWidth, format, quality, waitMs }, timeoutMs, false);

    const envelope = run.data as Record<string, unknown> | undefined;
    if (!envelope || envelope.ok !== true) {
        // 场景侧已经把原因说清楚了（没开场景 / 执行报错），原样传回去
        return withFitNote(run);
    }

    const captured = envelope.result as Record<string, unknown> | undefined;
    if (!captured || captured.ok !== true) {
        return withFitNote(
            captureFail(String((captured && captured.error) || '截图失败（场景侧没有返回图片）'), {
                scene: captured ?? null,
                electronFallback: viaElectron.fallback,
            }),
        );
    }

    // 场景侧能落盘就落盘了（返回 path）；否则回传分块 base64，这里拼回来写盘 ——
    // 沙箱返回值有「单字符串 4000 字」上限，整张图塞不进一个字段。
    const filePath = typeof captured.path === 'string' && captured.path ? captured.path : savePath;
    if (captured.transport !== 'file') {
        const chunks = Array.isArray(captured.chunks) ? captured.chunks.map((c) => String(c)) : [];
        const base64 = chunks.join('');
        if (!base64) return withFitNote(captureFail('截图没有产出图片数据', { scene: captured }));
        try {
            const dir = path.dirname(filePath);
            if (dir) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        } catch (err) {
            return withFitNote(captureFail(`写入截图文件失败：${describe(err)}`, { path: filePath, scene: captured }));
        }
    }

    let bytes = typeof captured.bytes === 'number' ? captured.bytes : 0;
    try {
        bytes = fs.statSync(filePath).size;
    } catch {
        /* 尺寸读不到不影响使用 */
    }

    const blankRatio = typeof captured.blankRatio === 'number' ? captured.blankRatio : null;
    const blank = blankRatio !== null && blankRatio >= 0.95;

    const payload: Record<string, unknown> = {
        ok: true,
        /** 见 captureView 的注释：这一条是**兜底路**（场景进程读 GL 后备缓冲） */
        method: 'scene-gl',
        path: filePath,
        width: captured.width,
        height: captured.height,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        format: captured.format ?? format,
        bytes,
        blankRatio,
        // 视图状态（visibleSize / designResolution / canvas / visibleMatchesDesign）——
        // 空白帧时用来判断「是不是编辑器场景视图的设备模拟被改过」
        view: captured.view ?? null,
        transport: captured.transport === 'file' ? 'scene' : 'editor',
        /** Electron 通道为什么没接手 —— 只回「老路的图」，但必须说清为什么退回来了 */
        electronFallback: viaElectron.fallback,
        electronContents: getElectron() ? listContents() : null,
        hint: blank ? CAPTURE_BLANK_HINT : CAPTURE_READ_HINT,
    };
    if (captured.saveError) payload.sceneWriteError = captured.saveError;
    if (fit.note) payload.fitNote = fit.note;

    return withFitNote({ ok: true, text: JSON.stringify(payload, null, 2), data: payload });
}

/** 探活：场景进程里本扩展的脚本加载了吗（`cocos_editor_state` 用它说明「能不能动场景」）。 */
export async function pingSceneScript(): Promise<{ available: boolean; reason?: string }> {
    try {
        const value = await callSceneScript<{ ok?: boolean }>(SCENE_METHOD.ping);
        return value && value.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    } catch (err) {
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
export async function readNodeGeometry(nodeRef: string): Promise<Record<string, any>> {
    try {
        const metrics = await callSceneScript<Record<string, any>>(SCENE_METHOD.viewMetrics, [
            { node: nodeRef || undefined, projectPath: Editor.Project.path },
        ]);
        if (!metrics || metrics.ok !== true) {
            return { ok: false, error: describe((metrics && metrics.error) || 'viewMetrics 没给出几何') };
        }
        return metrics;
    } catch (err) {
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
export async function readSceneRuntime(): Promise<{ ok: boolean; runtime?: Record<string, unknown>; error?: string }> {
    try {
        const metrics = await callSceneScript<Record<string, any>>(SCENE_METHOD.viewMetrics, [{}]);
        if (!metrics || metrics.ok !== true) {
            return { ok: false, error: describe((metrics && metrics.error) || 'viewMetrics 没给出结果') };
        }
        const runtime = (metrics.runtime || null) as Record<string, unknown> | null;
        if (!runtime) {
            return { ok: false, error: '场景脚本没有报 runtime（这个版本的本扩展脚本比主进程旧？）' };
        }
        return { ok: true, runtime };
    } catch (err) {
        return { ok: false, error: describe(err) };
    }
}

/**
 * 场景侧的反射 —— 转发给本扩展的场景脚本（那 200 多行「从 `__props__` + 实时实例读属性名」
 * 的逻辑一行都不用重写）。
 */
export async function describeSceneApi(
    target: string,
    nodeUuid: string,
    limit: number,
): Promise<Record<string, unknown>> {
    const value = (await callSceneScript<Record<string, unknown>>(SCENE_METHOD.describeApi, [
        { target, nodeUuid: nodeUuid || undefined, limit },
    ])) as Record<string, unknown> | undefined;

    if (!value || typeof value !== 'object') {
        throw new Error('场景脚本 describeApi 没有返回结果。');
    }
    return value;
}
