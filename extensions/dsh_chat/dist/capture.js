"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getElectron = getElectron;
exports.electronUnavailableReason = electronUnavailableReason;
exports.listContents = listContents;
exports.findSceneView = findSceneView;
exports.blankRatioOf = blankRatioOf;
exports.imageSizeOf = imageSizeOf;
exports.captureSceneView = captureSceneView;
exports.invalidateSceneView = invalidateSceneView;
exports.cropToCssRect = cropToCssRect;
exports.downscaleToWidth = downscaleToWidth;
exports.encodeImage = encodeImage;
/** 场景视图网页的 URL 特征 —— scene 包的两个模板页（`builtin/scene/static/template/`）。 */
const SCENE_VIEW_URL = /(^|[\\/])(2d|3d)-webview\.html/i;
/** 明显不是场景视图的（DevTools / 编辑器主窗口）。 */
const NON_SCENE_TYPE = /^(devtools|backgroundPage|remote)$/i;
function describe(error) {
    if (error instanceof Error)
        return error.message;
    if (error && typeof error === 'object') {
        const anyErr = error;
        if (typeof anyErr.message === 'string')
            return anyErr.message;
    }
    return String(error);
}
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.min(5000, ms)));
});
// ---------------------------------------------------------------------------
// Electron 的取用
// ---------------------------------------------------------------------------
let electronCache;
let electronError = null;
/**
 * 懒加载 Electron —— **绝不能放模块顶层**。
 *
 * `require('electron')` 只在编辑器主进程里成立；普通 Node（本扩展的 verify 脚本、
 * DSH 子进程）里是 MODULE_NOT_FOUND。放顶层的话整个模块 import 就炸，
 * 连「失败就退回老路」的机会都没有。
 */
function getElectron() {
    if (electronCache !== undefined)
        return electronCache;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('electron');
        electronCache = mod && mod.webContents ? mod : null;
        electronError = electronCache ? null : 'require("electron") 拿到了模块，但没有 webContents（当前不是主进程？）';
    }
    catch (err) {
        electronCache = null;
        electronError = describe(err);
    }
    return electronCache;
}
/** 拿不到 Electron 的原因（可用时返回 null）。回执里要如实说清是「没这个能力」还是「抓失败了」。 */
function electronUnavailableReason() {
    getElectron();
    return electronError;
}
function safeUrl(contents) {
    try {
        return contents.getURL() || '';
    }
    catch {
        return '';
    }
}
function safeType(contents) {
    try {
        return contents.getType() || '';
    }
    catch {
        return '';
    }
}
/** 所有活着的网页。诊断（抓不到时列出「当时到底有哪些 webContents」）与定位都用它。 */
function listContents() {
    const electron = getElectron();
    if (!electron || !electron.webContents)
        return [];
    let all = [];
    try {
        all = electron.webContents.getAllWebContents() || [];
    }
    catch {
        return [];
    }
    const rows = [];
    for (const contents of all) {
        try {
            if (contents.isDestroyed())
                continue;
        }
        catch {
            continue;
        }
        const row = { id: contents.id, type: safeType(contents), url: safeUrl(contents) };
        try {
            row.title = contents.getTitle();
        }
        catch {
            /* 忽略：取不到就算了 */
        }
        try {
            const win = contents.getOwnerBrowserWindow();
            row.visible = win ? win.isVisible() : null;
        }
        catch {
            /* 忽略 */
        }
        rows.push(row);
    }
    return rows;
}
/** 去掉 #hash：同一页的 hash 变化不该被当成换页。 */
function withoutHash(url) {
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
function findSceneView(href) {
    const electron = getElectron();
    if (!electron || !electron.webContents)
        return null;
    let all = [];
    try {
        all = electron.webContents.getAllWebContents() || [];
    }
    catch {
        return null;
    }
    const candidates = [];
    for (const contents of all) {
        try {
            if (contents.isDestroyed())
                continue;
        }
        catch {
            continue;
        }
        if (NON_SCENE_TYPE.test(safeType(contents)))
            continue;
        candidates.push(contents);
    }
    const toHit = (contents, matchedBy) => ({
        contents,
        matchedBy,
        info: { id: contents.id, type: safeType(contents), url: safeUrl(contents) },
    });
    const wanted = typeof href === 'string' ? withoutHash(href.trim()) : '';
    if (wanted) {
        for (const contents of candidates) {
            if (withoutHash(safeUrl(contents)) === wanted)
                return toHit(contents, 'href');
        }
        /**
         * 退一步按「问号之前 + webview 页面」比：编辑器可能给不同的 query（`?url=…`）
         * 拼出不同的 URL，而 pathname 是同一个文件。
         */
        const wantedBase = wanted.split('?')[0];
        if (wantedBase) {
            for (const contents of candidates) {
                const url = withoutHash(safeUrl(contents));
                if (url.split('?')[0] === wantedBase && SCENE_VIEW_URL.test(url))
                    return toHit(contents, 'url');
            }
        }
    }
    for (const contents of candidates) {
        if (SCENE_VIEW_URL.test(safeUrl(contents)))
            return toHit(contents, 'url');
    }
    for (const contents of candidates) {
        if (safeType(contents) === 'webview')
            return toHit(contents, 'webview');
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
function blankRatioOf(image) {
    let bitmap;
    try {
        bitmap = image.toBitmap();
    }
    catch {
        return 0; // 取不到像素就别把它当成"空图"（宁可让上层按正常图处理）
    }
    const total = Math.floor(bitmap.length / 4);
    if (total <= 0)
        return 1;
    const step = Math.max(1, Math.floor(total / 512));
    let sampled = 0;
    let blank = 0;
    for (let i = 0; i < total; i += step) {
        const o = i * 4;
        sampled += 1;
        if (bitmap[o + 3] === 0 || (bitmap[o] === 0 && bitmap[o + 1] === 0 && bitmap[o + 2] === 0))
            blank += 1;
    }
    return sampled > 0 ? Math.round((blank / sampled) * 1000) / 1000 : 1;
}
/** 图的 DIP 尺寸（= CSS 像素）。取不到时回 0×0（调用方据此判断"这张图不可用"）。 */
function imageSizeOf(image) {
    try {
        const size = image.getSize();
        return { width: size.width || 0, height: size.height || 0 };
    }
    catch {
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
async function captureSceneView(href, invalidationWaitMs = 150) {
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
    }
    catch (err) {
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
function invalidateSceneView(href) {
    const hit = findSceneView(href);
    if (!hit)
        return false;
    try {
        hit.contents.invalidate();
        return true;
    }
    catch {
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
function cropToCssRect(image, rect, pageCss) {
    const size = imageSize(image);
    if (!pageCss.width || !pageCss.height || !size.width || !size.height)
        return { image, rect: null };
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
    }
    catch {
        return { image, rect: null };
    }
}
/**
 * 缩到不超过 `maxWidth`（**等比**：Electron 的 `resize` 只给 width 时 height 取原高，不是等比）。
 *
 * @returns 缩放后的图；本来就够小、或 `resize` 不可用时原样返回。
 */
function downscaleToWidth(image, maxWidth) {
    if (!maxWidth || maxWidth <= 0)
        return image;
    const size = imageSize(image);
    if (!size.width || size.width <= maxWidth)
        return image;
    const height = Math.max(1, Math.round((size.height * maxWidth) / size.width));
    try {
        return image.resize({ width: maxWidth, height, quality: 'good' });
    }
    catch {
        return image;
    }
}
/** 编码成 png/jpeg 字节。`toPNG()` 默认 scaleFactor 1（= DIP），与坐标口径一致。 */
function encodeImage(image, format, quality) {
    if (format === 'jpeg') {
        return image.toJPEG(Math.round(Math.min(1, Math.max(0.1, quality)) * 100));
    }
    return image.toPNG();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FwdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9jYXB0dXJlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdDRzs7QUFxRkgsa0NBWUM7QUFHRCw4REFHQztBQW1CRCxvQ0ErQkM7QUFnQkQsc0NBb0RDO0FBVUQsb0NBa0JDO0FBR0Qsa0NBT0M7QUFpQkQsNENBK0NDO0FBWUQsa0RBU0M7QUFVRCxzQ0FvQ0M7QUFPRCw0Q0FVQztBQUdELGtDQUtDO0FBM1pELHlFQUF5RTtBQUN6RSxNQUFNLGNBQWMsR0FBRyxpQ0FBaUMsQ0FBQztBQUV6RCxvQ0FBb0M7QUFDcEMsTUFBTSxjQUFjLEdBQUcscUNBQXFDLENBQUM7QUFpRDdELFNBQVMsUUFBUSxDQUFDLEtBQWM7SUFDNUIsSUFBSSxLQUFLLFlBQVksS0FBSztRQUFFLE9BQU8sS0FBSyxDQUFDLE9BQU8sQ0FBQztJQUNqRCxJQUFJLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNyQyxNQUFNLE1BQU0sR0FBRyxLQUE4QixDQUFDO1FBQzlDLElBQUksT0FBTyxNQUFNLENBQUMsT0FBTyxLQUFLLFFBQVE7WUFBRSxPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUM7SUFDbEUsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxNQUFNLEtBQUssR0FBRyxDQUFDLEVBQVUsRUFBaUIsRUFBRSxDQUN4QyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFO0lBQ3BCLFVBQVUsQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3pELENBQUMsQ0FBQyxDQUFDO0FBRVAsOEVBQThF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QyxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQztJQUM1QyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDckYsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDakMsQ0FBQztJQUVEOzZDQUN5QztJQUN6QyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQztJQUM3QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQztJQUM3QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQztJQUNqQyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztJQUNsQyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDcEYsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDakMsQ0FBQztJQUVELHNCQUFzQjtJQUN0QixNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xFLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbkUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3hFLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUM7SUFFdkMsSUFBSSxDQUFDO1FBQ0QsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUN2RCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDakMsQ0FBQztBQUNMLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBZ0IsZ0JBQWdCLENBQUMsS0FBa0IsRUFBRSxRQUFnQjtJQUNqRSxJQUFJLENBQUMsUUFBUSxJQUFJLFFBQVEsSUFBSSxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDN0MsTUFBTSxJQUFJLEdBQUcsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlCLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxLQUFLLElBQUksUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3hELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzlFLElBQUksQ0FBQztRQUNELE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0FBQ0wsQ0FBQztBQUVELGlFQUFpRTtBQUNqRSxTQUFnQixXQUFXLENBQUMsS0FBa0IsRUFBRSxNQUFzQixFQUFFLE9BQWU7SUFDbkYsSUFBSSxNQUFNLEtBQUssTUFBTSxFQUFFLENBQUM7UUFDcEIsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQy9FLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztBQUN6QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDkuLvov5vnqIvkvqfnmoTmipPlm77pgJrpgZPvvJoqKueUqCBFbGVjdHJvbiDoh6rlt7HmipPnvJbovpHlmajlnLrmma/op4blm74qKuOAglxuICpcbiAqICMjIOS4uuS7gOS5iOimgeaciei/meadoemAmumBk++8iOeOsOaciemCo+adoei3r+eahOe7k+aehOaAp+e8uumZt++8iVxuICpcbiAqIOWOn+adpeeahCBgY29jb3NfY2FwdHVyZV92aWV3YCDot5HlnKgqKuWcuuaZr+i/m+eoiyoq6YeM77yaYGNjLmdhbWUuY2FudmFzYCDihpIgYGdsLnJlYWRQaXhlbHNgXG4gKiDor7vpu5jorqTluKfnvJPlhrLjgILlroPmnInkuKTkuKrnu5XkuI3ov4fljrvnmoTpl67popjvvJpcbiAqXG4gKiAxLiAqKldlYkdMIOm7mOiupOW4p+e8k+WGsuWQiOaIkOWQjuWNs+WkseaViCoq77yIYHByZXNlcnZlRHJhd2luZ0J1ZmZlcmAg6buY6K6kIGZhbHNl77yJ77yMXG4gKiAgICDlv4XpobvlnKjjgIznlLvlrozpgqPkuIDluKfjgI3lhoXor7vvvJtcbiAqIDIuICoq5Zy65pmv6L+b56iL5rKh5pyJ5Yqe5rOV6K6p57yW6L6R5Zmo6YeN55S75LiA5binKiog4oCU4oCUIOinhuWbvuayoeWcqOa4suafk+aXtlxuICogICAg77yI6Z2i5p2/6KKr5oqY5Y+gIC8g5YiH5Yiw5Yir55qE6aG1562+IC8g56qX5Y+j6KKr6YGu5oyh77yJ77yMYEVWRU5UX0FGVEVSX0RSQVdgIOS4jeinpuWPke+8jFxuICogICAg5YWc5bqV55qEIGBzZXRUaW1lb3V0YCDor7vliLDnmoTmmK/ooqvmuIXmjonnmoTnvJPlhrLjgILmnKzlt6XnqIvlrp7mtYvlsLHmmK/ov5nkuKrvvJpcbiAqICAgIGBibGFua1JhdGlvPTFgIOiAjCBgdmlzaWJsZU1hdGNoZXNEZXNpZ249dHJ1ZWDvvIjop4EgYGRvY3MvYWdlbnQtbm90ZXMvVUnkuI7ooajnjrDlsYIubWRg77yJ44CCXG4gKlxuICogRWxlY3Ryb24g6L+Z5p2h6Lev5o2i5LqG5LiqKiror7vlj5bmupAqKu+8jOS4pOS4qumXrumimOS4gOi1t+a2iOaOie+8mlxuICpcbiAqIC0gYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgIOivu+eahOaYryAqKkNocm9taXVtIOWQiOaIkOWQjueahCBzdXJmYWNlKirvvIzkuI3mmK8gR0wg5ZCO5aSH57yT5YayXG4gKiAgIOKAlOKAlCBgcHJlc2VydmVEcmF3aW5nQnVmZmVyYCDkuI7lroPml6DlhbPvvIzmipPliLDnmoTlsLHmmK/lsY/luZXkuIrpgqPkuIDluKfvvIjlkKvnvZHmoLzkuI4gZ2l6bW/vvInvvJtcbiAqIC0gYHdlYkNvbnRlbnRzLmludmFsaWRhdGUoKWAg6IO9KirmjpLkuIDmrKHph43nu5gqKiDigJTigJQg57y655qE44CM6YC85a6D55S75LiA5bin44CN6KGl5LiK5LqG44CCXG4gKlxuICog6aG65bim6L+Y5aSa5LqG5Liq6IO95Yqb77yaKirmjInnn6nlvaLmipMqKu+8iOiKgueCuee6p+aIquWbvu+8ieOAgmBjYXB0dXJlUGFnZShyZWN0KWAgLyBgY3JvcChyZWN0KWBcbiAqIOmDveWcqCBESVDvvIg9IENTUyDlg4/ntKDvvInph4znrpfvvIzogIzjgIzoioLngrkg4oaSIENTUyDlg4/ntKDjgI3nlLHlnLrmma/ov5vnqIvnlKjnvJbovpHlmajnm7jmnLrnrpdcbiAqIO+8iGBjY2UuQ2FtZXJhLmNhbWVyYS53b3JsZFRvU2NyZWVuYO+8jOingSBgc2NlbmUudHNgIOeahCBgdmlld01ldHJpY3Ng77yJ44CCXG4gKlxuICogIyMg5Z2Q5qCH5Y+j5b6E77yI5Y+q5q2k5LiA5aSE77yM5Yir5Zyo5Yir5aSE5YaN5o2i566X5LiA5qyh77yJXG4gKlxuICogfCDph48gfCDljZXkvY0gLyDljp/ngrkgfFxuICogfC0tLXwtLS18XG4gKiB8IOWcuuaZr+iEmuacrOaKpeadpeeahOiKgueCueefqeW9oiB8ICoqQ1NTIOWDj+e0oCoq77yM55u45a+5KirpobXpnaLlt6bkuIrop5IqKiB8XG4gKiB8IGBjYXB0dXJlUGFnZSgpYCDmipPliLDnmoTlm74gfCAqKkRJUCoq77yIPSBDU1Mg5YOP57Sg77yJ5bC65a+477ybYHRvUE5HKClgIOm7mOiupCBzY2FsZUZhY3RvciAxIHxcbiAqIHwgYGNyb3AocmVjdClgIHwg5ZCM5LiK77yMMToxIHxcbiAqXG4gKiDnkIborrrkuIrjgIzlm77lrr0gPSDpobXpnaIgQ1NTIOWuveOAje+8jOS9huecn+acuuS4iuacquW/he+8iOe8qeaUvuOAgURQSSDlj5boiI3vvInvvIzmiYDku6Xov5nph4wqKuWunua1i+avlOWAvCoqXG4gKiBgc2NhbGUgPSDlm77lrr0gLyDpobXpnaJDU1Plrr1gIOWGjeS5mOS4iuWOuyDigJTigJQg5pyJ5YGP5beu5Lmf6Ieq5bex57qg5q2j77yM5LiN6Z2g5YGH6K6+44CCXG4gKlxuICogIyMg6L+Z5LiA5bGC5Yi75oSP5LiN5YGa55qE5LqLXG4gKlxuICog5LiN6JC955uY77yIYGVuZ2luZS50c2Ag6LSf6LSj5YaZ5paH5Lu25LiO5Zue5omn77yJ44CB5LiN6K6k6K+G44CM6IqC54K544CN77yI6YKj5piv5Zy65pmv6ISa5pys55qE5LqL77yJ44CCXG4gKiDovpPlhaXovpPlh7rpg73mmK/jgIznvZHpobUgKyDnn6nlvaLjgI3vvIzov5nmoLflroPog73lnKggdmVyaWZ5IOmHjOiiq+S4gOS4quWBhyBFbGVjdHJvbiDlrozmlbTot5HpgJrjgIJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IE5hdGl2ZUltYWdlLCBXZWJDb250ZW50cyB9IGZyb20gJ2VsZWN0cm9uJztcblxuLyoqIOWcuuaZr+inhuWbvue9kemhteeahCBVUkwg54m55b6BIOKAlOKAlCBzY2VuZSDljIXnmoTkuKTkuKrmqKHmnb/pobXvvIhgYnVpbHRpbi9zY2VuZS9zdGF0aWMvdGVtcGxhdGUvYO+8ieOAgiAqL1xuY29uc3QgU0NFTkVfVklFV19VUkwgPSAvKF58W1xcXFwvXSkoMmR8M2QpLXdlYnZpZXdcXC5odG1sL2k7XG5cbi8qKiDmmI7mmL7kuI3mmK/lnLrmma/op4blm77nmoTvvIhEZXZUb29scyAvIOe8lui+keWZqOS4u+eql+WPo++8ieOAgiAqL1xuY29uc3QgTk9OX1NDRU5FX1RZUEUgPSAvXihkZXZ0b29sc3xiYWNrZ3JvdW5kUGFnZXxyZW1vdGUpJC9pO1xuXG5pbnRlcmZhY2UgRWxlY3Ryb25MaWtlIHtcbiAgICB3ZWJDb250ZW50cz86IHtcbiAgICAgICAgZ2V0QWxsV2ViQ29udGVudHMoKTogV2ViQ29udGVudHNbXTtcbiAgICAgICAgZnJvbUlkKGlkOiBudW1iZXIpOiBXZWJDb250ZW50cyB8IHVuZGVmaW5lZDtcbiAgICB9O1xufVxuXG4vKiog5LiA5Liq572R6aG155qE6YCf5YaZ77yI5Zue5omn5LiO6K+K5pat55So77yb5Y+W5LiN5Yiw55qE6aG55LiN5Ye6546w77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIENvbnRlbnRJbmZvIHtcbiAgICBpZDogbnVtYmVyO1xuICAgIHR5cGU6IHN0cmluZztcbiAgICB1cmw6IHN0cmluZztcbiAgICB0aXRsZT86IHN0cmluZztcbiAgICB2aXNpYmxlPzogYm9vbGVhbiB8IG51bGw7XG59XG5cbi8qKiDmib7liLDnmoTlnLrmma/op4blm77jgIJgbWF0Y2hlZEJ5YCDlhpnov5vlm57miacg4oCU4oCUIOaKk+mUmeeql+WPo+aXtuS4gOecvOeci+W+l+WHuuWHreS7gOS5iOmAieeahOOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY2VuZVZpZXdIaXQge1xuICAgIGNvbnRlbnRzOiBXZWJDb250ZW50cztcbiAgICBpbmZvOiBDb250ZW50SW5mbztcbiAgICBtYXRjaGVkQnk6ICdocmVmJyB8ICd1cmwnIHwgJ3dlYnZpZXcnO1xufVxuXG4vKipcbiAqIOS4gOasoeaKk+WbvueahOe7k+aenOOAglxuICpcbiAqIOKaoCDliLvmhI/lhpnmiJAqKuS4gOS4quaJgeW5s+aOpeWPoyArIOWPr+mAieWtl+autSoq77yM6ICM5LiN5pivIGB7b2s6dHJ1ZSzigKZ9IHwge29rOmZhbHNlLOKApn1gIOeahOWPr+i+qOivhuiBlOWQiO+8mlxuICog5pys5bel56iLIGBzdHJpY3Q6IGZhbHNlYO+8jOiBlOWQiOWcqOi/memHjOaXouayoeaNouadpeexu+Wei+WuieWFqO+8jOWPiOiuqeiwg+eUqOaWueWIsOWkhOimgeeqhOWMluOAgueUqCBgb2tgIOWIpOaWreWNs+WPr+OAglxuICovXG5leHBvcnQgaW50ZXJmYWNlIENhcHR1cmVPdXRjb21lIHtcbiAgICBvazogYm9vbGVhbjtcbiAgICAvKiogb2sg5pe25pyJ5YC8ICovXG4gICAgaW1hZ2U/OiBOYXRpdmVJbWFnZTtcbiAgICAvKiog5oqT5Yiw55qE5Y6f5Zu+5bC65a+477yIRElQ77yJICovXG4gICAgc291cmNlV2lkdGg/OiBudW1iZXI7XG4gICAgc291cmNlSGVpZ2h0PzogbnVtYmVyO1xuICAgIGJsYW5rUmF0aW8/OiBudW1iZXI7XG4gICAgLyoqIOesrOS4gOW8oOaYr+epuuWbvuOAgemdoCBgaW52YWxpZGF0ZSgpYCDpgLzlh7rnrKzkuozlvKDml7bkuLogdHJ1ZSAqL1xuICAgIHVzZWRJbnZhbGlkYXRlPzogYm9vbGVhbjtcbiAgICB0YXJnZXQ/OiBDb250ZW50SW5mbztcbiAgICBtYXRjaGVkQnk/OiBTY2VuZVZpZXdIaXRbJ21hdGNoZWRCeSddO1xuICAgIC8qKiDlpLHotKXljp/lm6AgKi9cbiAgICBlcnJvcj86IHN0cmluZztcbiAgICAvKiog5aSx6LSl5pe255qE546w5Zy677ya5b2T5pe25Yiw5bqV5pyJ5ZOq5LqbIHdlYkNvbnRlbnRz77yI5oqT6ZSZ56qX5Y+jL+aKk+S4jeWIsOaXtuWUr+S4gOacieeUqOeahOivgeaNru+8iSAqL1xuICAgIGNvbnRlbnRzPzogQ29udGVudEluZm9bXTtcbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnJvciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSByZXR1cm4gYW55RXJyLm1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcoZXJyb3IpO1xufVxuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNTAwMCwgbXMpKSk7XG4gICAgfSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRWxlY3Ryb24g55qE5Y+W55SoXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxubGV0IGVsZWN0cm9uQ2FjaGU6IEVsZWN0cm9uTGlrZSB8IG51bGwgfCB1bmRlZmluZWQ7XG5sZXQgZWxlY3Ryb25FcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICog5oeS5Yqg6L29IEVsZWN0cm9uIOKAlOKAlCAqKue7neS4jeiDveaUvuaooeWdl+mhtuWxgioq44CCXG4gKlxuICogYHJlcXVpcmUoJ2VsZWN0cm9uJylgIOWPquWcqOe8lui+keWZqOS4u+i/m+eoi+mHjOaIkOeri++8m+aZrumAmiBOb2Rl77yI5pys5omp5bGV55qEIHZlcmlmeSDohJrmnKzjgIFcbiAqIERTSCDlrZDov5vnqIvvvInph4zmmK8gTU9EVUxFX05PVF9GT1VOROOAguaUvumhtuWxgueahOivneaVtOS4quaooeWdlyBpbXBvcnQg5bCx54K477yMXG4gKiDov57jgIzlpLHotKXlsLHpgIDlm57ogIHot6/jgI3nmoTmnLrkvJrpg73msqHmnInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEVsZWN0cm9uKCk6IEVsZWN0cm9uTGlrZSB8IG51bGwge1xuICAgIGlmIChlbGVjdHJvbkNhY2hlICE9PSB1bmRlZmluZWQpIHJldHVybiBlbGVjdHJvbkNhY2hlO1xuICAgIHRyeSB7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdmFyLXJlcXVpcmVzXG4gICAgICAgIGNvbnN0IG1vZCA9IHJlcXVpcmUoJ2VsZWN0cm9uJykgYXMgRWxlY3Ryb25MaWtlO1xuICAgICAgICBlbGVjdHJvbkNhY2hlID0gbW9kICYmIG1vZC53ZWJDb250ZW50cyA/IG1vZCA6IG51bGw7XG4gICAgICAgIGVsZWN0cm9uRXJyb3IgPSBlbGVjdHJvbkNhY2hlID8gbnVsbCA6ICdyZXF1aXJlKFwiZWxlY3Ryb25cIikg5ou/5Yiw5LqG5qih5Z2X77yM5L2G5rKh5pyJIHdlYkNvbnRlbnRz77yI5b2T5YmN5LiN5piv5Li76L+b56iL77yf77yJJztcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZWxlY3Ryb25DYWNoZSA9IG51bGw7XG4gICAgICAgIGVsZWN0cm9uRXJyb3IgPSBkZXNjcmliZShlcnIpO1xuICAgIH1cbiAgICByZXR1cm4gZWxlY3Ryb25DYWNoZTtcbn1cblxuLyoqIOaLv+S4jeWIsCBFbGVjdHJvbiDnmoTljp/lm6DvvIjlj6/nlKjml7bov5Tlm54gbnVsbO+8ieOAguWbnuaJp+mHjOimgeWmguWunuivtOa4heaYr+OAjOayoei/meS4quiDveWKm+OAjei/mOaYr+OAjOaKk+Wksei0peS6huOAjeOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsZWN0cm9uVW5hdmFpbGFibGVSZWFzb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgZ2V0RWxlY3Ryb24oKTtcbiAgICByZXR1cm4gZWxlY3Ryb25FcnJvcjtcbn1cblxuZnVuY3Rpb24gc2FmZVVybChjb250ZW50czogV2ViQ29udGVudHMpOiBzdHJpbmcge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBjb250ZW50cy5nZXRVUkwoKSB8fCAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gc2FmZVR5cGUoY29udGVudHM6IFdlYkNvbnRlbnRzKTogc3RyaW5nIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gY29udGVudHMuZ2V0VHlwZSgpIHx8ICcnO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gJyc7XG4gICAgfVxufVxuXG4vKiog5omA5pyJ5rS7552A55qE572R6aG144CC6K+K5pat77yI5oqT5LiN5Yiw5pe25YiX5Ye644CM5b2T5pe25Yiw5bqV5pyJ5ZOq5LqbIHdlYkNvbnRlbnRz44CN77yJ5LiO5a6a5L2N6YO955So5a6D44CCICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdENvbnRlbnRzKCk6IENvbnRlbnRJbmZvW10ge1xuICAgIGNvbnN0IGVsZWN0cm9uID0gZ2V0RWxlY3Ryb24oKTtcbiAgICBpZiAoIWVsZWN0cm9uIHx8ICFlbGVjdHJvbi53ZWJDb250ZW50cykgcmV0dXJuIFtdO1xuICAgIGxldCBhbGw6IFdlYkNvbnRlbnRzW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBhbGwgPSBlbGVjdHJvbi53ZWJDb250ZW50cy5nZXRBbGxXZWJDb250ZW50cygpIHx8IFtdO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IHJvd3M6IENvbnRlbnRJbmZvW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGNvbnRlbnRzIG9mIGFsbCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKGNvbnRlbnRzLmlzRGVzdHJveWVkKCkpIGNvbnRpbnVlO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdzogQ29udGVudEluZm8gPSB7IGlkOiBjb250ZW50cy5pZCwgdHlwZTogc2FmZVR5cGUoY29udGVudHMpLCB1cmw6IHNhZmVVcmwoY29udGVudHMpIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByb3cudGl0bGUgPSBjb250ZW50cy5nZXRUaXRsZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOW/veeVpe+8muWPluS4jeWIsOWwseeul+S6hiAqL1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB3aW4gPSBjb250ZW50cy5nZXRPd25lckJyb3dzZXJXaW5kb3coKTtcbiAgICAgICAgICAgIHJvdy52aXNpYmxlID0gd2luID8gd2luLmlzVmlzaWJsZSgpIDogbnVsbDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgfVxuICAgICAgICByb3dzLnB1c2gocm93KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvd3M7XG59XG5cbi8qKiDljrvmjokgI2hhc2jvvJrlkIzkuIDpobXnmoQgaGFzaCDlj5jljJbkuI3or6XooqvlvZPmiJDmjaLpobXjgIIgKi9cbmZ1bmN0aW9uIHdpdGhvdXRIYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhdCA9IHVybC5pbmRleE9mKCcjJyk7XG4gICAgcmV0dXJuIGF0ID49IDAgPyB1cmwuc2xpY2UoMCwgYXQpIDogdXJsO1xufVxuXG4vKipcbiAqIOWumuS9jeWcuuaZr+inhuWbvuOAglxuICpcbiAqIOS8mOWFiOe6p++8iCoq6aaW6YCJ57K+56Gu5Yy56YWNKirvvIzlm6DkuLrjgIzmipPplJnnqpflj6PjgI3mmK/mnIDpmr7mn6XnmoTkuIDnsbvmlYXpmpzvvInvvJpcbiAqIDEuIGBocmVmYCDigJTigJQg5Zy65pmv6ISa5pys5oql5p2l55qEIGBsb2NhdGlvbi5ocmVmYO+8jOS5n+WwseaYr+Wug+iHquW3semCo+S4gOmhteOAgui/meaYryoq56Gu5a6a5oCnKirnmoTvvJtcbiAqIDIuIFVSTCDlkb3kuK0gYDJkfDNkLXdlYnZpZXcuaHRtbGDvvIjlnLrmma/ohJrmnKzkuI3lj6/nlKjml7bnmoTlhZzlupXvvInvvJtcbiAqIDMuIOWUr+S4gOeahCBgd2Vidmlld2Ag57G75Z6L5a6e5L6L77yI5YaN5YWc5LiA5bGC77yJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kU2NlbmVWaWV3KGhyZWY/OiBzdHJpbmcpOiBTY2VuZVZpZXdIaXQgfCBudWxsIHtcbiAgICBjb25zdCBlbGVjdHJvbiA9IGdldEVsZWN0cm9uKCk7XG4gICAgaWYgKCFlbGVjdHJvbiB8fCAhZWxlY3Ryb24ud2ViQ29udGVudHMpIHJldHVybiBudWxsO1xuICAgIGxldCBhbGw6IFdlYkNvbnRlbnRzW10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBhbGwgPSBlbGVjdHJvbi53ZWJDb250ZW50cy5nZXRBbGxXZWJDb250ZW50cygpIHx8IFtdO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBjYW5kaWRhdGVzOiBXZWJDb250ZW50c1tdID0gW107XG4gICAgZm9yIChjb25zdCBjb250ZW50cyBvZiBhbGwpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChjb250ZW50cy5pc0Rlc3Ryb3llZCgpKSBjb250aW51ZTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoTk9OX1NDRU5FX1RZUEUudGVzdChzYWZlVHlwZShjb250ZW50cykpKSBjb250aW51ZTtcbiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKGNvbnRlbnRzKTtcbiAgICB9XG5cbiAgICBjb25zdCB0b0hpdCA9IChjb250ZW50czogV2ViQ29udGVudHMsIG1hdGNoZWRCeTogU2NlbmVWaWV3SGl0WydtYXRjaGVkQnknXSk6IFNjZW5lVmlld0hpdCA9PiAoe1xuICAgICAgICBjb250ZW50cyxcbiAgICAgICAgbWF0Y2hlZEJ5LFxuICAgICAgICBpbmZvOiB7IGlkOiBjb250ZW50cy5pZCwgdHlwZTogc2FmZVR5cGUoY29udGVudHMpLCB1cmw6IHNhZmVVcmwoY29udGVudHMpIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCB3YW50ZWQgPSB0eXBlb2YgaHJlZiA9PT0gJ3N0cmluZycgPyB3aXRob3V0SGFzaChocmVmLnRyaW0oKSkgOiAnJztcbiAgICBpZiAod2FudGVkKSB7XG4gICAgICAgIGZvciAoY29uc3QgY29udGVudHMgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgICAgaWYgKHdpdGhvdXRIYXNoKHNhZmVVcmwoY29udGVudHMpKSA9PT0gd2FudGVkKSByZXR1cm4gdG9IaXQoY29udGVudHMsICdocmVmJyk7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIOmAgOS4gOatpeaMieOAjOmXruWPt+S5i+WJjSArIHdlYnZpZXcg6aG16Z2i44CN5q+U77ya57yW6L6R5Zmo5Y+v6IO957uZ5LiN5ZCM55qEIHF1ZXJ577yIYD91cmw94oCmYO+8iVxuICAgICAgICAgKiDmi7zlh7rkuI3lkIznmoQgVVJM77yM6ICMIHBhdGhuYW1lIOaYr+WQjOS4gOS4quaWh+S7tuOAglxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3Qgd2FudGVkQmFzZSA9IHdhbnRlZC5zcGxpdCgnPycpWzBdO1xuICAgICAgICBpZiAod2FudGVkQmFzZSkge1xuICAgICAgICAgICAgZm9yIChjb25zdCBjb250ZW50cyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdXJsID0gd2l0aG91dEhhc2goc2FmZVVybChjb250ZW50cykpO1xuICAgICAgICAgICAgICAgIGlmICh1cmwuc3BsaXQoJz8nKVswXSA9PT0gd2FudGVkQmFzZSAmJiBTQ0VORV9WSUVXX1VSTC50ZXN0KHVybCkpIHJldHVybiB0b0hpdChjb250ZW50cywgJ3VybCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBjb250ZW50cyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICAgIGlmIChTQ0VORV9WSUVXX1VSTC50ZXN0KHNhZmVVcmwoY29udGVudHMpKSkgcmV0dXJuIHRvSGl0KGNvbnRlbnRzLCAndXJsJyk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY29udGVudHMgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICBpZiAoc2FmZVR5cGUoY29udGVudHMpID09PSAnd2VidmlldycpIHJldHVybiB0b0hpdChjb250ZW50cywgJ3dlYnZpZXcnKTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5oqT5Zu+IC8g56m65Zu+5Yik5o2uIC8g6KOB5YiH5LiO57yW56CBXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDnqbrlm77mr5Tkvosg4oCU4oCUICoq5LiO5Zy65pmv5L6nIGBzYW1wbGVCbGFua1JhdGlvYCDlkIzkuIDlj6PlvoQqKu+8iOWFqOmAj+aYjuaIlue6r+m7kemDveeul+epuu+8ie+8jFxuICog5Lik6L655pWw5a2X5Y+v5Lul55u05o6l5q+U44CCYHRvQml0bWFwKClgIOe7meeahOaYryBCR1JB44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBibGFua1JhdGlvT2YoaW1hZ2U6IE5hdGl2ZUltYWdlKTogbnVtYmVyIHtcbiAgICBsZXQgYml0bWFwOiBCdWZmZXI7XG4gICAgdHJ5IHtcbiAgICAgICAgYml0bWFwID0gaW1hZ2UudG9CaXRtYXAoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIDA7IC8vIOWPluS4jeWIsOWDj+e0oOWwseWIq+aKiuWug+W9k+aIkFwi56m65Zu+XCLvvIjlroHlj6/orqnkuIrlsYLmjInmraPluLjlm77lpITnkIbvvIlcbiAgICB9XG4gICAgY29uc3QgdG90YWwgPSBNYXRoLmZsb29yKGJpdG1hcC5sZW5ndGggLyA0KTtcbiAgICBpZiAodG90YWwgPD0gMCkgcmV0dXJuIDE7XG4gICAgY29uc3Qgc3RlcCA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IodG90YWwgLyA1MTIpKTtcbiAgICBsZXQgc2FtcGxlZCA9IDA7XG4gICAgbGV0IGJsYW5rID0gMDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRvdGFsOyBpICs9IHN0ZXApIHtcbiAgICAgICAgY29uc3QgbyA9IGkgKiA0O1xuICAgICAgICBzYW1wbGVkICs9IDE7XG4gICAgICAgIGlmIChiaXRtYXBbbyArIDNdID09PSAwIHx8IChiaXRtYXBbb10gPT09IDAgJiYgYml0bWFwW28gKyAxXSA9PT0gMCAmJiBiaXRtYXBbbyArIDJdID09PSAwKSkgYmxhbmsgKz0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHNhbXBsZWQgPiAwID8gTWF0aC5yb3VuZCgoYmxhbmsgLyBzYW1wbGVkKSAqIDEwMDApIC8gMTAwMCA6IDE7XG59XG5cbi8qKiDlm77nmoQgRElQIOWwuuWvuO+8iD0gQ1NTIOWDj+e0oO+8ieOAguWPluS4jeWIsOaXtuWbniAww5cw77yI6LCD55So5pa55o2u5q2k5Yik5patXCLov5nlvKDlm77kuI3lj6/nlKhcIu+8ieOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGltYWdlU2l6ZU9mKGltYWdlOiBOYXRpdmVJbWFnZSk6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2l6ZSA9IGltYWdlLmdldFNpemUoKTtcbiAgICAgICAgcmV0dXJuIHsgd2lkdGg6IHNpemUud2lkdGggfHwgMCwgaGVpZ2h0OiBzaXplLmhlaWdodCB8fCAwIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcbiAgICB9XG59XG5cbi8qKiDlhoXpg6jnlKjnmoTnn63lkI3jgIIgKi9cbmNvbnN0IGltYWdlU2l6ZSA9IGltYWdlU2l6ZU9mO1xuXG4vKipcbiAqIOaKk+S4gOW8oOWcuuaZr+inhuWbvuOAglxuICpcbiAqIOS4pOatpei1sO+8jOS4lCoq5Y+q5Zyo5b+F6KaB5pe25omN5aSa6Iqx5LiA5qyhKirvvJpcbiAqIDEuIOebtOaOpSBgY2FwdHVyZVBhZ2UoKWDvvIjlsY/luZXkuIrnjrDlnKjlsLHmmK/ov5nmoLfvvInvvJtcbiAqIDIuIOiLpeWfuuacrOaYr+epuuWbvu+8iGBibGFua1JhdGlvID49IDAuOThg77yJ4oaSIGBpbnZhbGlkYXRlKClgIOaOkuS4gOasoemHjee7mCDihpIg5YaN5oqT5LiA5qyh44CCXG4gKlxuICog56ysIDIg5q2l5bCx5piv6ICB5a6e546w57y655qE6YKj5LiA5Lu277yaKirlroPmsqHms5XorqnnvJbovpHlmajph43nlLsqKuOAglxuICpcbiAqIEBwYXJhbSBocmVmIOWcuuaZr+iEmuacrOaKpeadpeeahCBgbG9jYXRpb24uaHJlZmDvvIjpppbpgInliKTmja7vvIzop4Ege0BsaW5rIGZpbmRTY2VuZVZpZXd977yJ44CCXG4gKiBAcGFyYW0gaW52YWxpZGF0aW9uV2FpdE1zIOmAvOmHjee7mOWQjuetieWkmuS5heWGjeaKk++8iOm7mOiupCAxNTBtc++8jOWkn+S4gOW4p++8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZVNjZW5lVmlldyhocmVmPzogc3RyaW5nLCBpbnZhbGlkYXRpb25XYWl0TXMgPSAxNTApOiBQcm9taXNlPENhcHR1cmVPdXRjb21lPiB7XG4gICAgY29uc3QgaGl0ID0gZmluZFNjZW5lVmlldyhocmVmKTtcbiAgICBpZiAoIWhpdCkge1xuICAgICAgICBjb25zdCByZWFzb24gPSBlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogcmVhc29uXG4gICAgICAgICAgICAgICAgPyBg5ou/5LiN5YiwIEVsZWN0cm9uIOeahCB3ZWJDb250ZW50c++8miR7cmVhc29ufWBcbiAgICAgICAgICAgICAgICA6ICfmsqHmnInmib7liLDlnLrmma/op4blm77nmoQgd2ViQ29udGVudHPvvIjnvJbovpHlmajph4zlj6/og73ov5jmsqHmnInmiZPlvIDku7vkvZXlnLrmma/op4blm77pnaLmnb/vvInjgIInLFxuICAgICAgICAgICAgY29udGVudHM6IGxpc3RDb250ZW50cygpLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRlbnRzID0gaGl0LmNvbnRlbnRzO1xuICAgIHRyeSB7XG4gICAgICAgIGxldCBpbWFnZSA9IGF3YWl0IGNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICAgIGxldCB1c2VkSW52YWxpZGF0ZSA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChibGFua1JhdGlvT2YoaW1hZ2UpID49IDAuOTgpIHtcbiAgICAgICAgICAgIGNvbnRlbnRzLmludmFsaWRhdGUoKTtcbiAgICAgICAgICAgIGF3YWl0IHNsZWVwKGludmFsaWRhdGlvbldhaXRNcyk7XG4gICAgICAgICAgICBjb25zdCByZXRyeSA9IGF3YWl0IGNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICAgICAgICAvKiog5Y+q5pyJ5Zyo55yf55qE5pu05aW955So5pe25omN5o2i5oiQ56ys5LqM5byg77yI5ZCm5YiZ5L+d55WZ56ys5LiA5byg77yM5Yir6LaK5oqT6LaK5beu77yJICovXG4gICAgICAgICAgICBpZiAoYmxhbmtSYXRpb09mKHJldHJ5KSA8IGJsYW5rUmF0aW9PZihpbWFnZSkpIHtcbiAgICAgICAgICAgICAgICBpbWFnZSA9IHJldHJ5O1xuICAgICAgICAgICAgICAgIHVzZWRJbnZhbGlkYXRlID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNpemUgPSBpbWFnZVNpemUoaW1hZ2UpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBpbWFnZSxcbiAgICAgICAgICAgIHNvdXJjZVdpZHRoOiBzaXplLndpZHRoLFxuICAgICAgICAgICAgc291cmNlSGVpZ2h0OiBzaXplLmhlaWdodCxcbiAgICAgICAgICAgIGJsYW5rUmF0aW86IGJsYW5rUmF0aW9PZihpbWFnZSksXG4gICAgICAgICAgICB1c2VkSW52YWxpZGF0ZSxcbiAgICAgICAgICAgIHRhcmdldDogaGl0LmluZm8sXG4gICAgICAgICAgICBtYXRjaGVkQnk6IGhpdC5tYXRjaGVkQnksXG4gICAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogYGNhcHR1cmVQYWdlIOWksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLFxuICAgICAgICAgICAgY29udGVudHM6IGxpc3RDb250ZW50cygpLFxuICAgICAgICB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDmjpLkuIDmrKHph43nu5jvvIgqKuWPluaZr+S5i+WQjuW/hemhu+iwgyoq77yJ44CCXG4gKlxuICog5Li65LuA5LmI77yaYGNhcHR1cmVQYWdlKClgIOaKk+eahOaYryBDaHJvbWl1bSAqKuW9k+WJjeWQiOaIkOWlveeahOmCo+S4gOW4pyoq44CC5Zy65pmv6L+b56iL5pS55LqG55u45py6XG4gKiDvvIhgZm9jdXNgIC8g5pS5IG9ydGhvSGVpZ2h077yJ5LmL5ZCO77yM5aaC5p6c6L+Z5LiA6aG15rKh5pyJ6YeN5paw5ZCI5oiQ77yM5oqT5Yiw55qE6L+Y5pivKirml6flj5bmma8qKuOAglxuICogYGludmFsaWRhdGUoKWAg5bCx5piv44CM5o6S5LiA5qyh6YeN57uY44CN4oCU4oCU6L+Z5q2j5piv6ICB5a6e546w77yI5Zy65pmv6L+b56iLIGBnbC5yZWFkUGl4ZWxzYO+8iee8uueahOmCo+S4gOS7tuOAglxuICpcbiAqIEBwYXJhbSBocmVmIOWcuuaZr+iEmuacrOaKpeadpeeahCBgbG9jYXRpb24uaHJlZmDvvIjpppbpgInliKTmja7vvIzop4Ege0BsaW5rIGZpbmRTY2VuZVZpZXd977yJ44CCXG4gKiBAcmV0dXJucyDmib7liLDkuoblubbmiJDlip/mjpLkuIrph43nu5jml7bkuLogdHJ1Ze+8m+aJvuS4jeWIsC/lt7Lnu4/plIDmr4Hml7bkuLogZmFsc2XvvIjkuI3mipvvvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludmFsaWRhdGVTY2VuZVZpZXcoaHJlZj86IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGhpdCA9IGZpbmRTY2VuZVZpZXcoaHJlZik7XG4gICAgaWYgKCFoaXQpIHJldHVybiBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgICBoaXQuY29udGVudHMuaW52YWxpZGF0ZSgpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLyoqXG4gKiDmiorjgIzpobXpnaIgQ1NTIOWDj+e0oOOAjeefqeW9ouaNoueul+aIkOWbvueJh+WDj+e0oOefqeW9ouW5tuijgeWIh+OAglxuICpcbiAqIGBwYWdlQ3NzYCDmmK/pobXpnaLvvIg9IOaKk+WIsOeahOaVtOmhte+8ieeahCBDU1Mg5bC65a+477yb5q+U5YC8Kirlrp7mtYsqKuWHuuadpe+8jFxuICog6ICM5LiN5piv5YGH5a6a44CM5Zu+5a69ID09IOmhtemdoiBDU1Mg5a6944CN77yI57yp5pS+IC8gRFBJIOWPluiIjeS8muiuqeWug+S4jeetie+8ieOAglxuICpcbiAqIEByZXR1cm5zIOijgeWIh+WQjueahOWbvu+8m+efqeW9oumAgOWMluaIkOepuuOAgeaIliBgY3JvcGAg5oqb5byC5bi45pe2Kirljp/moLfov5Tlm54qKu+8iOWugeWPr+e7meaVtOmhte+8jOS4jee7meepuuWbvu+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JvcFRvQ3NzUmVjdChcbiAgICBpbWFnZTogTmF0aXZlSW1hZ2UsXG4gICAgcmVjdDogeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcbiAgICBwYWdlQ3NzOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0sXG4pOiB7IGltYWdlOiBOYXRpdmVJbWFnZTsgcmVjdDogeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IG51bGwgfSB7XG4gICAgY29uc3Qgc2l6ZSA9IGltYWdlU2l6ZShpbWFnZSk7XG4gICAgaWYgKCFwYWdlQ3NzLndpZHRoIHx8ICFwYWdlQ3NzLmhlaWdodCB8fCAhc2l6ZS53aWR0aCB8fCAhc2l6ZS5oZWlnaHQpIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG5cbiAgICBjb25zdCBzY2FsZVggPSBzaXplLndpZHRoIC8gcGFnZUNzcy53aWR0aDtcbiAgICBjb25zdCBzY2FsZVkgPSBzaXplLmhlaWdodCAvIHBhZ2VDc3MuaGVpZ2h0O1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHNjYWxlWCkgfHwgIU51bWJlci5pc0Zpbml0ZShzY2FsZVkpIHx8IHNjYWxlWCA8PSAwIHx8IHNjYWxlWSA8PSAwKSB7XG4gICAgICAgIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG4gICAgfVxuXG4gICAgLyoqIOWFiOWIpOOAjCoq5Y6L5qC55LiN55u45LqkKirjgI3vvJrpgqPlsLHkuI3mmK9cIuijgeS4gOS4i1wi77yM6ICM5piv55+p5b2i566X6ZSZ5LqGIOKAlOKAlCDlm54gbnVsbCDorqnkuIrlsYLpgIDlm57mlbTlvKDop4blm77vvIxcbiAgICAgKiAg5Yir57uZ5LiA5bygIDEg5YOP57Sg5a6955qEXCLmnInmlYjoo4HliIdcIu+8iOmCo+enjeWbvueci+S4jeWHuumXrumimOWcqOWTqu+8jOacgOmavuafpe+8ieOAgiAqL1xuICAgIGNvbnN0IHJhd1ggPSByZWN0LnggKiBzY2FsZVg7XG4gICAgY29uc3QgcmF3WSA9IHJlY3QueSAqIHNjYWxlWTtcbiAgICBjb25zdCByYXdXID0gcmVjdC53aWR0aCAqIHNjYWxlWDtcbiAgICBjb25zdCByYXdIID0gcmVjdC5oZWlnaHQgKiBzY2FsZVk7XG4gICAgaWYgKHJhd1ggKyByYXdXIDw9IDAgfHwgcmF3WSArIHJhd0ggPD0gMCB8fCByYXdYID49IHNpemUud2lkdGggfHwgcmF3WSA+PSBzaXplLmhlaWdodCkge1xuICAgICAgICByZXR1cm4geyBpbWFnZSwgcmVjdDogbnVsbCB9O1xuICAgIH1cblxuICAgIC8qKiDlpLnliLDlm77lhoXvvJrnm7jkuqTkvYbotornlYznmoTkuIDkvqfmiY3lpLkgKi9cbiAgICBjb25zdCB4ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2l6ZS53aWR0aCAtIDEsIE1hdGgucm91bmQocmF3WCkpKTtcbiAgICBjb25zdCB5ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2l6ZS5oZWlnaHQgLSAxLCBNYXRoLnJvdW5kKHJhd1kpKSk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLm1pbihzaXplLndpZHRoIC0geCwgTWF0aC5yb3VuZChyYXdXKSkpO1xuICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgubWluKHNpemUuaGVpZ2h0IC0geSwgTWF0aC5yb3VuZChyYXdIKSkpO1xuICAgIGNvbnN0IHRhcmdldCA9IHsgeCwgeSwgd2lkdGgsIGhlaWdodCB9O1xuXG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIHsgaW1hZ2U6IGltYWdlLmNyb3AodGFyZ2V0KSwgcmVjdDogdGFyZ2V0IH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG4gICAgfVxufVxuXG4vKipcbiAqIOe8qeWIsOS4jei2hei/hyBgbWF4V2lkdGhg77yIKirnrYnmr5QqKu+8mkVsZWN0cm9uIOeahCBgcmVzaXplYCDlj6rnu5kgd2lkdGgg5pe2IGhlaWdodCDlj5bljp/pq5jvvIzkuI3mmK/nrYnmr5TvvInjgIJcbiAqXG4gKiBAcmV0dXJucyDnvKnmlL7lkI7nmoTlm77vvJvmnKzmnaXlsLHlpJ/lsI/jgIHmiJYgYHJlc2l6ZWAg5LiN5Y+v55So5pe25Y6f5qC36L+U5Zue44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb3duc2NhbGVUb1dpZHRoKGltYWdlOiBOYXRpdmVJbWFnZSwgbWF4V2lkdGg6IG51bWJlcik6IE5hdGl2ZUltYWdlIHtcbiAgICBpZiAoIW1heFdpZHRoIHx8IG1heFdpZHRoIDw9IDApIHJldHVybiBpbWFnZTtcbiAgICBjb25zdCBzaXplID0gaW1hZ2VTaXplKGltYWdlKTtcbiAgICBpZiAoIXNpemUud2lkdGggfHwgc2l6ZS53aWR0aCA8PSBtYXhXaWR0aCkgcmV0dXJuIGltYWdlO1xuICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKHNpemUuaGVpZ2h0ICogbWF4V2lkdGgpIC8gc2l6ZS53aWR0aCkpO1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBpbWFnZS5yZXNpemUoeyB3aWR0aDogbWF4V2lkdGgsIGhlaWdodCwgcXVhbGl0eTogJ2dvb2QnIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gaW1hZ2U7XG4gICAgfVxufVxuXG4vKiog57yW56CB5oiQIHBuZy9qcGVnIOWtl+iKguOAgmB0b1BORygpYCDpu5jorqQgc2NhbGVGYWN0b3IgMe+8iD0gRElQ77yJ77yM5LiO5Z2Q5qCH5Y+j5b6E5LiA6Ie044CCICovXG5leHBvcnQgZnVuY3Rpb24gZW5jb2RlSW1hZ2UoaW1hZ2U6IE5hdGl2ZUltYWdlLCBmb3JtYXQ6ICdwbmcnIHwgJ2pwZWcnLCBxdWFsaXR5OiBudW1iZXIpOiBCdWZmZXIge1xuICAgIGlmIChmb3JtYXQgPT09ICdqcGVnJykge1xuICAgICAgICByZXR1cm4gaW1hZ2UudG9KUEVHKE1hdGgucm91bmQoTWF0aC5taW4oMSwgTWF0aC5tYXgoMC4xLCBxdWFsaXR5KSkgKiAxMDApKTtcbiAgICB9XG4gICAgcmV0dXJuIGltYWdlLnRvUE5HKCk7XG59XG4iXX0=