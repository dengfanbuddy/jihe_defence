/**
 * 主进程侧的抓图通道：**用 Electron 自己抓编辑器场景视图**。
 *
 * ## 为什么要有这条通道（现有那条路的结构性缺陷）
 *
 * 原来的 `cocos_capture_view` 跑在**场景进程**里：`cc.game.canvas` → `gl.readPixels`
 * 读默认帧缓冲。它有两个绕不过去的问题：
 *
 * 1. **WebGL 默认帧缓冲合成后即失效**（`preserveDrawingBuffer` 默认 false），
 *    必须在「画完那一帧」内读；
 * 2. **场景进程没有办法让编辑器重画一帧** —— 视图没在渲染时
 *    （面板被折叠 / 切到别的页签 / 窗口被遮挡），`EVENT_AFTER_DRAW` 不触发，
 *    兜底的 `setTimeout` 读到的是被清掉的缓冲。本工程实测就是这个：
 *    `blankRatio=1` 而 `visibleMatchesDesign=true`（见 `docs/agent-notes/UI与表现层.md`）。
 *
 * Electron 这条路换了个**读取源**，两个问题一起消掉：
 *
 * - `webContents.capturePage()` 读的是 **Chromium 合成后的 surface**，不是 GL 后备缓冲
 *   —— `preserveDrawingBuffer` 与它无关，抓到的就是屏幕上那一帧（含网格与 gizmo）；
 * - `webContents.invalidate()` 能**排一次重绘** —— 缺的「逼它画一帧」补上了。
 *
 * 顺带还多了个能力：**按矩形抓**（节点级截图）。`capturePage(rect)` / `crop(rect)`
 * 都在 DIP（= CSS 像素）里算，而「节点 → CSS 像素」由场景进程用编辑器相机算
 * （`cce.Camera.camera.worldToScreen`，见 `scene.ts` 的 `viewMetrics`）。
 *
 * ## 坐标口径（只此一处，别在别处再换算一次）
 *
 * | 量 | 单位 / 原点 |
 * |---|---|
 * | 场景脚本报来的节点矩形 | **CSS 像素**，相对**页面左上角** |
 * | `capturePage()` 抓到的图 | **DIP**（= CSS 像素）尺寸；`toPNG()` 默认 scaleFactor 1 |
 * | `crop(rect)` | 同上，1:1 |
 *
 * 理论上「图宽 = 页面 CSS 宽」，但真机上未必（缩放、DPI 取舍），所以这里**实测比值**
 * `scale = 图宽 / 页面CSS宽` 再乘上去 —— 有偏差也自己纠正，不靠假设。
 *
 * ## 这一层刻意不做的事
 *
 * 不落盘（`engine.ts` 负责写文件与回执）、不认识「节点」（那是场景脚本的事）。
 * 输入输出都是「网页 + 矩形」，这样它能在 verify 里被一个假 Electron 完整跑通。
 */

import type { NativeImage, WebContents } from 'electron';

/** 场景视图网页的 URL 特征 —— scene 包的两个模板页（`builtin/scene/static/template/`）。 */
const SCENE_VIEW_URL = /(^|[\\/])(2d|3d)-webview\.html/i;

/** 明显不是场景视图的（DevTools / 编辑器主窗口）。 */
const NON_SCENE_TYPE = /^(devtools|backgroundPage|remote)$/i;

interface ElectronLike {
    webContents?: {
        getAllWebContents(): WebContents[];
        fromId(id: number): WebContents | undefined;
    };
}

/** 一个网页的速写（回执与诊断用；取不到的项不出现）。 */
export interface ContentInfo {
    id: number;
    type: string;
    url: string;
    title?: string;
    visible?: boolean | null;
}

/** 找到的场景视图。`matchedBy` 写进回执 —— 抓错窗口时一眼看得出凭什么选的。 */
export interface SceneViewHit {
    contents: WebContents;
    info: ContentInfo;
    matchedBy: 'href' | 'url' | 'webview';
}

/**
 * 一次抓图的结果。
 *
 * ⚠ 刻意写成**一个扁平接口 + 可选字段**，而不是 `{ok:true,…} | {ok:false,…}` 的可辨识联合：
 * 本工程 `strict: false`，联合在这里既没换来类型安全，又让调用方到处要窄化。用 `ok` 判断即可。
 */
export interface CaptureOutcome {
    ok: boolean;
    /** ok 时有值 */
    image?: NativeImage;
    /** 抓到的原图尺寸（DIP） */
    sourceWidth?: number;
    sourceHeight?: number;
    blankRatio?: number;
    /** 第一张是空图、靠 `invalidate()` 逼出第二张时为 true */
    usedInvalidate?: boolean;
    target?: ContentInfo;
    matchedBy?: SceneViewHit['matchedBy'];
    /** 失败原因 */
    error?: string;
    /** 失败时的现场：当时到底有哪些 webContents（抓错窗口/抓不到时唯一有用的证据） */
    contents?: ContentInfo[];
}

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
        setTimeout(resolve, Math.max(0, Math.min(5000, ms)));
    });

// ---------------------------------------------------------------------------
// Electron 的取用
// ---------------------------------------------------------------------------

let electronCache: ElectronLike | null | undefined;
let electronError: string | null = null;

/**
 * 懒加载 Electron —— **绝不能放模块顶层**。
 *
 * `require('electron')` 只在编辑器主进程里成立；普通 Node（本扩展的 verify 脚本、
 * DSH 子进程）里是 MODULE_NOT_FOUND。放顶层的话整个模块 import 就炸，
 * 连「失败就退回老路」的机会都没有。
 */
export function getElectron(): ElectronLike | null {
    if (electronCache !== undefined) return electronCache;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('electron') as ElectronLike;
        electronCache = mod && mod.webContents ? mod : null;
        electronError = electronCache ? null : 'require("electron") 拿到了模块，但没有 webContents（当前不是主进程？）';
    } catch (err) {
        electronCache = null;
        electronError = describe(err);
    }
    return electronCache;
}

/** 拿不到 Electron 的原因（可用时返回 null）。回执里要如实说清是「没这个能力」还是「抓失败了」。 */
export function electronUnavailableReason(): string | null {
    getElectron();
    return electronError;
}

function safeUrl(contents: WebContents): string {
    try {
        return contents.getURL() || '';
    } catch {
        return '';
    }
}

function safeType(contents: WebContents): string {
    try {
        return contents.getType() || '';
    } catch {
        return '';
    }
}

/** 所有活着的网页。诊断（抓不到时列出「当时到底有哪些 webContents」）与定位都用它。 */
export function listContents(): ContentInfo[] {
    const electron = getElectron();
    if (!electron || !electron.webContents) return [];
    let all: WebContents[] = [];
    try {
        all = electron.webContents.getAllWebContents() || [];
    } catch {
        return [];
    }
    const rows: ContentInfo[] = [];
    for (const contents of all) {
        try {
            if (contents.isDestroyed()) continue;
        } catch {
            continue;
        }
        const row: ContentInfo = { id: contents.id, type: safeType(contents), url: safeUrl(contents) };
        try {
            row.title = contents.getTitle();
        } catch {
            /* 忽略：取不到就算了 */
        }
        try {
            const win = contents.getOwnerBrowserWindow();
            row.visible = win ? win.isVisible() : null;
        } catch {
            /* 忽略 */
        }
        rows.push(row);
    }
    return rows;
}

/** 去掉 #hash：同一页的 hash 变化不该被当成换页。 */
function withoutHash(url: string): string {
    const at = url.indexOf('#');
    return at >= 0 ? url.slice(0, at) : url;
}

/**
 * 定位场景视图。
 *
 * 优先级（**首选精确匹配**，因为「抓错窗口」是最难查的一类故障）：
 * 1. `href` —— 场景脚本报来的 `location.href`，也就是它自己那一页。这是**确定性**的；
 * 2. URL 命中 `2d|3d-webview.html`（场景脚本不可用时的兜底）；
 * 3. 唯一的 `webview` 类型实例（再兜一层）。
 */
export function findSceneView(href?: string): SceneViewHit | null {
    const electron = getElectron();
    if (!electron || !electron.webContents) return null;
    let all: WebContents[] = [];
    try {
        all = electron.webContents.getAllWebContents() || [];
    } catch {
        return null;
    }

    const candidates: WebContents[] = [];
    for (const contents of all) {
        try {
            if (contents.isDestroyed()) continue;
        } catch {
            continue;
        }
        if (NON_SCENE_TYPE.test(safeType(contents))) continue;
        candidates.push(contents);
    }

    const toHit = (contents: WebContents, matchedBy: SceneViewHit['matchedBy']): SceneViewHit => ({
        contents,
        matchedBy,
        info: { id: contents.id, type: safeType(contents), url: safeUrl(contents) },
    });

    const wanted = typeof href === 'string' ? withoutHash(href.trim()) : '';
    if (wanted) {
        for (const contents of candidates) {
            if (withoutHash(safeUrl(contents)) === wanted) return toHit(contents, 'href');
        }
        /**
         * 退一步按「问号之前 + webview 页面」比：编辑器可能给不同的 query（`?url=…`）
         * 拼出不同的 URL，而 pathname 是同一个文件。
         */
        const wantedBase = wanted.split('?')[0];
        if (wantedBase) {
            for (const contents of candidates) {
                const url = withoutHash(safeUrl(contents));
                if (url.split('?')[0] === wantedBase && SCENE_VIEW_URL.test(url)) return toHit(contents, 'url');
            }
        }
    }

    for (const contents of candidates) {
        if (SCENE_VIEW_URL.test(safeUrl(contents))) return toHit(contents, 'url');
    }
    for (const contents of candidates) {
        if (safeType(contents) === 'webview') return toHit(contents, 'webview');
    }
    return null;
}

// ---------------------------------------------------------------------------
// 抓图 / 空图判据 / 裁切与编码
// ---------------------------------------------------------------------------

/**
 * 空图比例 —— **与场景侧 `sampleBlankRatio` 同一口径**（全透明或纯黑都算空），
 * 两边数字可以直接比。`toBitmap()` 给的是 BGRA。
 */
export function blankRatioOf(image: NativeImage): number {
    let bitmap: Buffer;
    try {
        bitmap = image.toBitmap();
    } catch {
        return 0; // 取不到像素就别把它当成"空图"（宁可让上层按正常图处理）
    }
    const total = Math.floor(bitmap.length / 4);
    if (total <= 0) return 1;
    const step = Math.max(1, Math.floor(total / 512));
    let sampled = 0;
    let blank = 0;
    for (let i = 0; i < total; i += step) {
        const o = i * 4;
        sampled += 1;
        if (bitmap[o + 3] === 0 || (bitmap[o] === 0 && bitmap[o + 1] === 0 && bitmap[o + 2] === 0)) blank += 1;
    }
    return sampled > 0 ? Math.round((blank / sampled) * 1000) / 1000 : 1;
}

/** 图的 DIP 尺寸（= CSS 像素）。取不到时回 0×0（调用方据此判断"这张图不可用"）。 */
export function imageSizeOf(image: NativeImage): { width: number; height: number } {
    try {
        const size = image.getSize();
        return { width: size.width || 0, height: size.height || 0 };
    } catch {
        return { width: 0, height: 0 };
    }
}

/** 内部用的短名。 */
const imageSize = imageSizeOf;

/**
 * 抓一张场景视图。
 *
 * 两步走，且**只在必要时才多花一次**：
 * 1. 直接 `capturePage()`（屏幕上现在就是这样）；
 * 2. 若基本是空图（`blankRatio >= 0.98`）→ `invalidate()` 排一次重绘 → 再抓一次。
 *
 * 第 2 步就是老实现缺的那一件：**它没法让编辑器重画**。
 *
 * @param href 场景脚本报来的 `location.href`（首选判据，见 {@link findSceneView}）。
 * @param invalidationWaitMs 逼重绘后等多久再抓（默认 150ms，够一帧）。
 */
export async function captureSceneView(href?: string, invalidationWaitMs = 150): Promise<CaptureOutcome> {
    const hit = findSceneView(href);
    if (!hit) {
        const reason = electronUnavailableReason();
        return {
            ok: false,
            error: reason
                ? `拿不到 Electron 的 webContents：${reason}`
                : '没有找到场景视图的 webContents（编辑器里可能还没有打开任何场景视图面板）。',
            contents: listContents(),
        };
    }

    const contents = hit.contents;
    try {
        let image = await contents.capturePage();
        let usedInvalidate = false;

        if (blankRatioOf(image) >= 0.98) {
            contents.invalidate();
            await sleep(invalidationWaitMs);
            const retry = await contents.capturePage();
            /** 只有在真的更好用时才换成第二张（否则保留第一张，别越抓越差） */
            if (blankRatioOf(retry) < blankRatioOf(image)) {
                image = retry;
                usedInvalidate = true;
            }
        }

        const size = imageSize(image);
        return {
            ok: true,
            image,
            sourceWidth: size.width,
            sourceHeight: size.height,
            blankRatio: blankRatioOf(image),
            usedInvalidate,
            target: hit.info,
            matchedBy: hit.matchedBy,
        };
    } catch (err) {
        return {
            ok: false,
            error: `capturePage 失败：${describe(err)}`,
            contents: listContents(),
        };
    }
}

/**
 * 排一次重绘（**取景之后必须调**）。
 *
 * 为什么：`capturePage()` 抓的是 Chromium **当前合成好的那一帧**。场景进程改了相机
 * （`focus` / 改 orthoHeight）之后，如果这一页没有重新合成，抓到的还是**旧取景**。
 * `invalidate()` 就是「排一次重绘」——这正是老实现（场景进程 `gl.readPixels`）缺的那一件。
 *
 * @param href 场景脚本报来的 `location.href`（首选判据，见 {@link findSceneView}）。
 * @returns 找到了并成功排上重绘时为 true；找不到/已经销毁时为 false（不抛）。
 */
export function invalidateSceneView(href?: string): boolean {
    const hit = findSceneView(href);
    if (!hit) return false;
    try {
        hit.contents.invalidate();
        return true;
    } catch {
        return false;
    }
}

/**
 * 把「页面 CSS 像素」矩形换算成图片像素矩形并裁切。
 *
 * `pageCss` 是页面（= 抓到的整页）的 CSS 尺寸；比值**实测**出来，
 * 而不是假定「图宽 == 页面 CSS 宽」（缩放 / DPI 取舍会让它不等）。
 *
 * @returns 裁切后的图；矩形退化成空、或 `crop` 抛异常时**原样返回**（宁可给整页，不给空图）。
 */
export function cropToCssRect(
    image: NativeImage,
    rect: { x: number; y: number; width: number; height: number },
    pageCss: { width: number; height: number },
): { image: NativeImage; rect: { x: number; y: number; width: number; height: number } | null } {
    const size = imageSize(image);
    if (!pageCss.width || !pageCss.height || !size.width || !size.height) return { image, rect: null };

    const scaleX = size.width / pageCss.width;
    const scaleY = size.height / pageCss.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
        return { image, rect: null };
    }

    /** 先判「**压根不相交**」：那就不是"裁一下"，而是矩形算错了 —— 回 null 让上层退回整张视图，
     *  别给一张 1 像素宽的"有效裁切"（那种图看不出问题在哪，最难查）。 */
    const rawX = rect.x * scaleX;
    const rawY = rect.y * scaleY;
    const rawW = rect.width * scaleX;
    const rawH = rect.height * scaleY;
    if (rawX + rawW <= 0 || rawY + rawH <= 0 || rawX >= size.width || rawY >= size.height) {
        return { image, rect: null };
    }

    /** 夹到图内：相交但越界的一侧才夹 */
    const x = Math.max(0, Math.min(size.width - 1, Math.round(rawX)));
    const y = Math.max(0, Math.min(size.height - 1, Math.round(rawY)));
    const width = Math.max(1, Math.min(size.width - x, Math.round(rawW)));
    const height = Math.max(1, Math.min(size.height - y, Math.round(rawH)));
    const target = { x, y, width, height };

    try {
        return { image: image.crop(target), rect: target };
    } catch {
        return { image, rect: null };
    }
}

/**
 * 缩到不超过 `maxWidth`（**等比**：Electron 的 `resize` 只给 width 时 height 取原高，不是等比）。
 *
 * @returns 缩放后的图；本来就够小、或 `resize` 不可用时原样返回。
 */
export function downscaleToWidth(image: NativeImage, maxWidth: number): NativeImage {
    if (!maxWidth || maxWidth <= 0) return image;
    const size = imageSize(image);
    if (!size.width || size.width <= maxWidth) return image;
    const height = Math.max(1, Math.round((size.height * maxWidth) / size.width));
    try {
        return image.resize({ width: maxWidth, height, quality: 'good' });
    } catch {
        return image;
    }
}

/** 编码成 png/jpeg 字节。`toPNG()` 默认 scaleFactor 1（= DIP），与坐标口径一致。 */
export function encodeImage(image: NativeImage, format: 'png' | 'jpeg', quality: number): Buffer {
    if (format === 'jpeg') {
        return image.toJPEG(Math.round(Math.min(1, Math.max(0.1, quality)) * 100));
    }
    return image.toPNG();
}
