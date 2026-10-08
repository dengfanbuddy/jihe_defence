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
 * Electron 这条路换了个**读取源**，第一个问题直接消掉：
 *
 * - `webContents.capturePage()` 读的是 **Chromium 合成后的 surface**，不是 GL 后备缓冲
 *   —— `preserveDrawingBuffer` 与它无关，抓到的就是屏幕上那一帧（含网格与 gizmo）。
 *
 * ## ⛔ 本模块**一次 `invalidate()` 都不调**（2026-10-08 之后，硬口径）
 *
 * 曾经这里有第二件「补能力」：`webContents.invalidate()` 排一次重绘，用来把**旧帧**顶掉
 * （「逼它画一帧」）。它换来的代价是**编辑器的场景面板黑掉/画面停住**，两次现场都只能重启编辑器：
 *
 * | 时间 | 现场 |
 * |---|---|
 * | 2026-10-08 04:48 | `真机验收2.md` 的 R6：两次带重绘的抓图之后，场景面板画面停住、切场景也不更新（`docs/冻结诊断.md`） |
 * | 2026-10-08 14:59 | 面板 agent 加 `Cmp_Game` 那次：同一块画布抓回来的是**一张全空的图**（`blankRatio 0.988`），用户看到的就是黑屏 |
 *
 * 当时把「抓图前一律排重绘」改成**要了才排**（`forceRepaint` 参数，默认 false）—— **这一改没救回来**：
 * 那次会话里编辑器跑的仍是**旧构建**（回执里 `forcedRepaint:true` 只有旧实现才这么恒报），
 * 也就是「靠一个默认值把危险动作关掉」在**模块级 require 缓存**面前是**不可验证的**。
 * ⇒ 现在只剩一条规则：**这个扩展不碰合成器**。抓到的图是空的就是空的（如实报 `blankRatio`），
 * 不再用"逼一帧"去救 —— 救不救得回来没证据，而代价是用户的编辑器黑屏。
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
 * 抓一张场景视图 —— **只读**：一次 `capturePage()`，不排重绘、不重试、不碰合成器。
 *
 * 抓到的是空图（`blankRatio` 接近 1）就是空图，**如实报**（文件头那条硬口径：
 * 本扩展不调 `invalidate()`；"逼一帧"救不救得回来没有证据，而代价是用户的编辑器黑屏）。
 * 空图的退路不是重试，而是**换判据**（`worldRect(node)` 这类数值判据）。
 *
 * @param href 场景脚本报来的 `location.href`（首选判据，见 {@link findSceneView}）。
 */
async function captureSceneView(href) {
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
        const image = await contents.capturePage();
        const size = imageSize(image);
        return {
            ok: true,
            image,
            sourceWidth: size.width,
            sourceHeight: size.height,
            blankRatio: blankRatioOf(image),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FwdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9jYXB0dXJlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVERzs7QUE4RUgsa0NBWUM7QUFHRCw4REFHQztBQW1CRCxvQ0ErQkM7QUFnQkQsc0NBb0RDO0FBVUQsb0NBa0JDO0FBR0Qsa0NBT0M7QUFjRCw0Q0FpQ0M7QUFVRCxzQ0FvQ0M7QUFPRCw0Q0FVQztBQUdELGtDQUtDO0FBOVdELHlFQUF5RTtBQUN6RSxNQUFNLGNBQWMsR0FBRyxpQ0FBaUMsQ0FBQztBQUV6RCxvQ0FBb0M7QUFDcEMsTUFBTSxjQUFjLEdBQUcscUNBQXFDLENBQUM7QUErQzdELFNBQVMsUUFBUSxDQUFDLEtBQWM7SUFDNUIsSUFBSSxLQUFLLFlBQVksS0FBSztRQUFFLE9BQU8sS0FBSyxDQUFDLE9BQU8sQ0FBQztJQUNqRCxJQUFJLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNyQyxNQUFNLE1BQU0sR0FBRyxLQUE4QixDQUFDO1FBQzlDLElBQUksT0FBTyxNQUFNLENBQUMsT0FBTyxLQUFLLFFBQVE7WUFBRSxPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUM7SUFDbEUsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCw4RUFBOEU7QUFDOUUsZUFBZTtBQUNmLDhFQUE4RTtBQUU5RSxJQUFJLGFBQThDLENBQUM7QUFDbkQsSUFBSSxhQUFhLEdBQWtCLElBQUksQ0FBQztBQUV4Qzs7Ozs7O0dBTUc7QUFDSCxTQUFnQixXQUFXO0lBQ3ZCLElBQUksYUFBYSxLQUFLLFNBQVM7UUFBRSxPQUFPLGFBQWEsQ0FBQztJQUN0RCxJQUFJLENBQUM7UUFDRCw4REFBOEQ7UUFDOUQsTUFBTSxHQUFHLEdBQUcsT0FBTyxD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TUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO0lBQzVDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLElBQUksQ0FBQyxJQUFJLE1BQU0sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNyRixPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUNqQyxDQUFDO0lBRUQ7NkNBQ3lDO0lBQ3pDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDO0lBQzdCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDO0lBQzdCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFDO0lBQ2pDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ2xDLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLElBQUksQ0FBQyxLQUFLLElBQUksSUFBSSxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNwRixPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUNqQyxDQUFDO0lBRUQsc0JBQXNCO0lBQ3RCLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbEUsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNuRSxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDeEUsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUV2QyxJQUFJLENBQUM7UUFDRCxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3ZELENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUNqQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxTQUFnQixnQkFBZ0IsQ0FBQyxLQUFrQixFQUFFLFFBQWdCO0lBQ2pFLElBQUksQ0FBQyxRQUFRLElBQUksUUFBUSxJQUFJLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUM3QyxNQUFNLElBQUksR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUIsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssSUFBSSxRQUFRO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDeEQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDOUUsSUFBSSxDQUFDO1FBQ0QsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDdEUsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7QUFDTCxDQUFDO0FBRUQsaUVBQWlFO0FBQ2pFLFNBQWdCLFdBQVcsQ0FBQyxLQUFrQixFQUFFLE1BQXNCLEVBQUUsT0FBZTtJQUNuRixJQUFJLE1BQU0sS0FBSyxNQUFNLEVBQUUsQ0FBQztRQUNwQixPQUFPLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDL0UsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ3pCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOS4u+i/m+eoi+S+p+eahOaKk+WbvumAmumBk++8mioq55SoIEVsZWN0cm9uIOiHquW3seaKk+e8lui+keWZqOWcuuaZr+inhuWbvioq44CCXG4gKlxuICogIyMg5Li65LuA5LmI6KaB5pyJ6L+Z5p2h6YCa6YGT77yI546w5pyJ6YKj5p2h6Lev55qE57uT5p6E5oCn57y66Zm377yJXG4gKlxuICog5Y6f5p2l55qEIGBjb2Nvc19jYXB0dXJlX3ZpZXdgIOi3keWcqCoq5Zy65pmv6L+b56iLKirph4zvvJpgY2MuZ2FtZS5jYW52YXNgIOKGkiBgZ2wucmVhZFBpeGVsc2BcbiAqIOivu+m7mOiupOW4p+e8k+WGsuOAguWug+acieS4pOS4que7leS4jei/h+WOu+eahOmXrumimO+8mlxuICpcbiAqIDEuICoqV2ViR0wg6buY6K6k5bin57yT5Yay5ZCI5oiQ5ZCO5Y2z5aSx5pWIKirvvIhgcHJlc2VydmVEcmF3aW5nQnVmZmVyYCDpu5jorqQgZmFsc2XvvInvvIxcbiAqICAgIOW/hemhu+WcqOOAjOeUu+WujOmCo+S4gOW4p+OAjeWGheivu++8m1xuICogMi4gKirlnLrmma/ov5vnqIvmsqHmnInlip7ms5XorqnnvJbovpHlmajph43nlLvkuIDluKcqKiDigJTigJQg6KeG5Zu+5rKh5Zyo5riy5p+T5pe2XG4gKiAgICDvvIjpnaLmnb/ooqvmipjlj6AgLyDliIfliLDliKvnmoTpobXnrb4gLyDnqpflj6Pooqvpga7mjKHvvInvvIxgRVZFTlRfQUZURVJfRFJBV2Ag5LiN6Kem5Y+R77yMXG4gKiAgICDlhZzlupXnmoQgYHNldFRpbWVvdXRgIOivu+WIsOeahOaYr+iiq+a4heaOieeahOe8k+WGsuOAguacrOW3peeoi+Wunua1i+WwseaYr+i/meS4qu+8mlxuICogICAgYGJsYW5rUmF0aW89MWAg6ICMIGB2aXNpYmxlTWF0Y2hlc0Rlc2lnbj10cnVlYO+8iOingSBgZG9jcy9hZ2VudC1ub3Rlcy9VSeS4juihqOeOsOWxgi5tZGDvvInjgIJcbiAqXG4gKiBFbGVjdHJvbiDov5nmnaHot6/mjaLkuobkuKoqKuivu+WPlua6kCoq77yM56ys5LiA5Liq6Zeu6aKY55u05o6l5raI5o6J77yaXG4gKlxuICogLSBgd2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKWAg6K+755qE5pivICoqQ2hyb21pdW0g5ZCI5oiQ5ZCO55qEIHN1cmZhY2UqKu+8jOS4jeaYryBHTCDlkI7lpIfnvJPlhrJcbiAqICAg4oCU4oCUIGBwcmVzZXJ2ZURyYXdpbmdCdWZmZXJgIOS4juWug+aXoOWFs++8jOaKk+WIsOeahOWwseaYr+Wxj+W5leS4iumCo+S4gOW4p++8iOWQq+e9keagvOS4jiBnaXptb++8ieOAglxuICpcbiAqICMjIOKblCDmnKzmqKHlnZcqKuS4gOasoSBgaW52YWxpZGF0ZSgpYCDpg73kuI3osIMqKu+8iDIwMjYtMTAtMDgg5LmL5ZCO77yM56Gs5Y+j5b6E77yJXG4gKlxuICog5pu+57uP6L+Z6YeM5pyJ56ys5LqM5Lu244CM6KGl6IO95Yqb44CN77yaYHdlYkNvbnRlbnRzLmludmFsaWRhdGUoKWAg5o6S5LiA5qyh6YeN57uY77yM55So5p2l5oqKKirml6fluKcqKumhtuaOiVxuICog77yI44CM6YC85a6D55S75LiA5bin44CN77yJ44CC5a6D5o2i5p2l55qE5Luj5Lu35pivKirnvJbovpHlmajnmoTlnLrmma/pnaLmnb/pu5Hmjokv55S76Z2i5YGc5L2PKirvvIzkuKTmrKHnjrDlnLrpg73lj6rog73ph43lkK/nvJbovpHlmajvvJpcbiAqXG4gKiB8IOaXtumXtCB8IOeOsOWcuiB8XG4gKiB8LS0tfC0tLXxcbiAqIHwgMjAyNi0xMC0wOCAwNDo0OCB8IGDnnJ/mnLrpqozmlLYyLm1kYCDnmoQgUjbvvJrkuKTmrKHluKbph43nu5jnmoTmipPlm77kuYvlkI7vvIzlnLrmma/pnaLmnb/nlLvpnaLlgZzkvY/jgIHliIflnLrmma/kuZ/kuI3mm7TmlrDvvIhgZG9jcy/lhrvnu5Por4rmlq0ubWRg77yJIHxcbiAqIHwgMjAyNi0xMC0wOCAxNDo1OSB8IOmdouadvyBhZ2VudCDliqAgYENtcF9HYW1lYCDpgqPmrKHvvJrlkIzkuIDlnZfnlLvluIPmipPlm57mnaXnmoTmmK8qKuS4gOW8oOWFqOepuueahOWbvioq77yIYGJsYW5rUmF0aW8gMC45ODhg77yJ77yM55So5oi355yL5Yiw55qE5bCx5piv6buR5bGPIHxcbiAqXG4gKiDlvZPml7bmiorjgIzmipPlm77liY3kuIDlvovmjpLph43nu5jjgI3mlLnmiJAqKuimgeS6huaJjeaOkioq77yIYGZvcmNlUmVwYWludGAg5Y+C5pWw77yM6buY6K6kIGZhbHNl77yJ4oCU4oCUICoq6L+Z5LiA5pS55rKh5pWR5Zue5p2lKirvvJpcbiAqIOmCo+asoeS8muivnemHjOe8lui+keWZqOi3keeahOS7jeaYryoq5pen5p6E5bu6KirvvIjlm57miafph4wgYGZvcmNlZFJlcGFpbnQ6dHJ1ZWAg5Y+q5pyJ5pen5a6e546w5omN6L+Z5LmI5oGS5oql77yJ77yMXG4gKiDkuZ/lsLHmmK/jgIzpnaDkuIDkuKrpu5jorqTlgLzmiorljbHpmanliqjkvZzlhbPmjonjgI3lnKgqKuaooeWdl+e6pyByZXF1aXJlIOe8k+WtmCoq6Z2i5YmN5pivKirkuI3lj6/pqozor4HnmoQqKuOAglxuICog4oeSIOeOsOWcqOWPquWJqeS4gOadoeinhOWIme+8mioq6L+Z5Liq5omp5bGV5LiN56Kw5ZCI5oiQ5ZmoKirjgILmipPliLDnmoTlm77mmK/nqbrnmoTlsLHmmK/nqbrnmoTvvIjlpoLlrp7miqUgYGJsYW5rUmF0aW9g77yJ77yMXG4gKiDkuI3lho3nlKhcIumAvOS4gOW4p1wi5Y675pWRIOKAlOKAlCDmlZHkuI3mlZHlvpflm57mnaXmsqHor4Hmja7vvIzogIzku6Pku7fmmK/nlKjmiLfnmoTnvJbovpHlmajpu5HlsY/jgIJcbiAqXG4gKiDpobrluKbov5jlpJrkuobkuKrog73lipvvvJoqKuaMieefqeW9ouaKkyoq77yI6IqC54K557qn5oiq5Zu+77yJ44CCYGNhcHR1cmVQYWdlKHJlY3QpYCAvIGBjcm9wKHJlY3QpYFxuICog6YO95ZyoIERJUO+8iD0gQ1NTIOWDj+e0oO+8iemHjOeul++8jOiAjOOAjOiKgueCuSDihpIgQ1NTIOWDj+e0oOOAjeeUseWcuuaZr+i/m+eoi+eUqOe8lui+keWZqOebuOacuueul1xuICog77yIYGNjZS5DYW1lcmEuY2FtZXJhLndvcmxkVG9TY3JlZW5g77yM6KeBIGBzY2VuZS50c2Ag55qEIGB2aWV3TWV0cmljc2DvvInjgIJcbiAqXG4gKiAjIyDlnZDmoIflj6PlvoTvvIjlj6rmraTkuIDlpITvvIzliKvlnKjliKvlpITlho3mjaLnrpfkuIDmrKHvvIlcbiAqXG4gKiB8IOmHjyB8IOWNleS9jSAvIOWOn+eCuSB8XG4gKiB8LS0tfC0tLXxcbiAqIHwg5Zy65pmv6ISa5pys5oql5p2l55qE6IqC54K555+p5b2iIHwgKipDU1Mg5YOP57SgKirvvIznm7jlr7kqKumhtemdouW3puS4iuinkioqIHxcbiAqIHwgYGNhcHR1cmVQYWdlKClgIOaKk+WIsOeahOWbviB8ICoqRElQKirvvIg9IENTUyDlg4/ntKDvvInlsLrlr7jvvJtgdG9QTkcoKWAg6buY6K6kIHNjYWxlRmFjdG9yIDEgfFxuICogfCBgY3JvcChyZWN0KWAgfCDlkIzkuIrvvIwxOjEgfFxuICpcbiAqIOeQhuiuuuS4iuOAjOWbvuWuvSA9IOmhtemdoiBDU1Mg5a6944CN77yM5L2G55yf5py65LiK5pyq5b+F77yI57yp5pS+44CBRFBJIOWPluiIje+8ie+8jOaJgOS7pei/memHjCoq5a6e5rWL5q+U5YC8KipcbiAqIGBzY2FsZSA9IOWbvuWuvSAvIOmhtemdokNTU+WuvWAg5YaN5LmY5LiK5Y67IOKAlOKAlCDmnInlgY/lt67kuZ/oh6rlt7HnuqDmraPvvIzkuI3pnaDlgYforr7jgIJcbiAqXG4gKiAjIyDov5nkuIDlsYLliLvmhI/kuI3lgZrnmoTkuotcbiAqXG4gKiDkuI3okL3nm5jvvIhgZW5naW5lLnRzYCDotJ/otKPlhpnmlofku7bkuI7lm57miafvvInjgIHkuI3orqTor4bjgIzoioLngrnjgI3vvIjpgqPmmK/lnLrmma/ohJrmnKznmoTkuovvvInjgIJcbiAqIOi+k+WFpei+k+WHuumDveaYr+OAjOe9kemhtSArIOefqeW9ouOAje+8jOi/meagt+Wug+iDveWcqCB2ZXJpZnkg6YeM6KKr5LiA5Liq5YGHIEVsZWN0cm9uIOWujOaVtOi3kemAmuOAglxuICovXG5cbmltcG9ydCB0eXBlIHsgTmF0aXZlSW1hZ2UsIFdlYkNvbnRlbnRzIH0gZnJvbSAnZWxlY3Ryb24nO1xuXG4vKiog5Zy65pmv6KeG5Zu+572R6aG155qEIFVSTCDnibnlvoEg4oCU4oCUIHNjZW5lIOWMheeahOS4pOS4quaooeadv+mhte+8iGBidWlsdGluL3NjZW5lL3N0YXRpYy90ZW1wbGF0ZS9g77yJ44CCICovXG5jb25zdCBTQ0VORV9WSUVXX1VSTCA9IC8oXnxbXFxcXC9dKSgyZHwzZCktd2Vidmlld1xcLmh0bWwvaTtcblxuLyoqIOaYjuaYvuS4jeaYr+WcuuaZr+inhuWbvueahO+8iERldlRvb2xzIC8g57yW6L6R5Zmo5Li756qX5Y+j77yJ44CCICovXG5jb25zdCBOT05fU0NFTkVfVFlQRSA9IC9eKGRldnRvb2xzfGJhY2tncm91bmRQYWdlfHJlbW90ZSkkL2k7XG5cbmludGVyZmFjZSBFbGVjdHJvbkxpa2Uge1xuICAgIHdlYkNvbnRlbnRzPzoge1xuICAgICAgICBnZXRBbGxXZWJDb250ZW50cygpOiBXZWJDb250ZW50c1tdO1xuICAgICAgICBmcm9tSWQoaWQ6IG51bWJlcik6IFdlYkNvbnRlbnRzIHwgdW5kZWZpbmVkO1xuICAgIH07XG59XG5cbi8qKiDkuIDkuKrnvZHpobXnmoTpgJ/lhpnvvIjlm57miafkuI7or4rmlq3nlKjvvJvlj5bkuI3liLDnmoTpobnkuI3lh7rnjrDvvInjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29udGVudEluZm8ge1xuICAgIGlkOiBudW1iZXI7XG4gICAgdHlwZTogc3RyaW5nO1xuICAgIHVybDogc3RyaW5nO1xuICAgIHRpdGxlPzogc3RyaW5nO1xuICAgIHZpc2libGU/OiBib29sZWFuIHwgbnVsbDtcbn1cblxuLyoqIOaJvuWIsOeahOWcuuaZr+inhuWbvuOAgmBtYXRjaGVkQnlgIOWGmei/m+WbnuaJpyDigJTigJQg5oqT6ZSZ56qX5Y+j5pe25LiA55y855yL5b6X5Ye65Yet5LuA5LmI6YCJ55qE44CCICovXG5leHBvcnQgaW50ZXJmYWNlIFNjZW5lVmlld0hpdCB7XG4gICAgY29udGVudHM6IFdlYkNvbnRlbnRzO1xuICAgIGluZm86IENvbnRlbnRJbmZvO1xuICAgIG1hdGNoZWRCeTogJ2hyZWYnIHwgJ3VybCcgfCAnd2Vidmlldyc7XG59XG5cbi8qKlxuICog5LiA5qyh5oqT5Zu+55qE57uT5p6c44CCXG4gKlxuICog4pqgIOWIu+aEj+WGmeaIkCoq5LiA5Liq5omB5bmz5o6l5Y+jICsg5Y+v6YCJ5a2X5q61KirvvIzogIzkuI3mmK8gYHtvazp0cnVlLOKApn0gfCB7b2s6ZmFsc2Us4oCmfWAg55qE5Y+v6L6o6K+G6IGU5ZCI77yaXG4gKiDmnKzlt6XnqIsgYHN0cmljdDogZmFsc2Vg77yM6IGU5ZCI5Zyo6L+Z6YeM5pei5rKh5o2i5p2l57G75Z6L5a6J5YWo77yM5Y+I6K6p6LCD55So5pa55Yiw5aSE6KaB56qE5YyW44CC55SoIGBva2Ag5Yik5pat5Y2z5Y+v44CCXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2FwdHVyZU91dGNvbWUge1xuICAgIG9rOiBib29sZWFuO1xuICAgIC8qKiBvayDml7bmnInlgLwgKi9cbiAgICBpbWFnZT86IE5hdGl2ZUltYWdlO1xuICAgIC8qKiDmipPliLDnmoTljp/lm77lsLrlr7jvvIhESVDvvIkgKi9cbiAgICBzb3VyY2VXaWR0aD86IG51bWJlcjtcbiAgICBzb3VyY2VIZWlnaHQ/OiBudW1iZXI7XG4gICAgYmxhbmtSYXRpbz86IG51bWJlcjtcbiAgICB0YXJnZXQ/OiBDb250ZW50SW5mbztcbiAgICBtYXRjaGVkQnk/OiBTY2VuZVZpZXdIaXRbJ21hdGNoZWRCeSddO1xuICAgIC8qKiDlpLHotKXljp/lm6AgKi9cbiAgICBlcnJvcj86IHN0cmluZztcbiAgICAvKiog5aSx6LSl5pe255qE546w5Zy677ya5b2T5pe25Yiw5bqV5pyJ5ZOq5LqbIHdlYkNvbnRlbnRz77yI5oqT6ZSZ56qX5Y+jL+aKk+S4jeWIsOaXtuWUr+S4gOacieeUqOeahOivgeaNru+8iSAqL1xuICAgIGNvbnRlbnRzPzogQ29udGVudEluZm9bXTtcbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnJvciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSByZXR1cm4gYW55RXJyLm1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcoZXJyb3IpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEVsZWN0cm9uIOeahOWPlueUqFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmxldCBlbGVjdHJvbkNhY2hlOiBFbGVjdHJvbkxpa2UgfCBudWxsIHwgdW5kZWZpbmVkO1xubGV0IGVsZWN0cm9uRXJyb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKipcbiAqIOaHkuWKoOi9vSBFbGVjdHJvbiDigJTigJQgKirnu53kuI3og73mlL7mqKHlnZfpobblsYIqKuOAglxuICpcbiAqIGByZXF1aXJlKCdlbGVjdHJvbicpYCDlj6rlnKjnvJbovpHlmajkuLvov5vnqIvph4zmiJDnq4vvvJvmma7pgJogTm9kZe+8iOacrOaJqeWxleeahCB2ZXJpZnkg6ISa5pys44CBXG4gKiBEU0gg5a2Q6L+b56iL77yJ6YeM5pivIE1PRFVMRV9OT1RfRk9VTkTjgILmlL7pobblsYLnmoTor53mlbTkuKrmqKHlnZcgaW1wb3J0IOWwseeCuO+8jFxuICog6L+e44CM5aSx6LSl5bCx6YCA5Zue6ICB6Lev44CN55qE5py65Lya6YO95rKh5pyJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbGVjdHJvbigpOiBFbGVjdHJvbkxpa2UgfCBudWxsIHtcbiAgICBpZiAoZWxlY3Ryb25DYWNoZSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZWxlY3Ryb25DYWNoZTtcbiAgICB0cnkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXZhci1yZXF1aXJlc1xuICAgICAgICBjb25zdCBtb2QgPSByZXF1aXJlKCdlbGVjdHJvbicpIGFzIEVsZWN0cm9uTGlrZTtcbiAgICAgICAgZWxlY3Ryb25DYWNoZSA9IG1vZCAmJiBtb2Qud2ViQ29udGVudHMgPyBtb2QgOiBudWxsO1xuICAgICAgICBlbGVjdHJvbkVycm9yID0gZWxlY3Ryb25DYWNoZSA/IG51bGwgOiAncmVxdWlyZShcImVsZWN0cm9uXCIpIOaLv+WIsOS6huaooeWdl++8jOS9huayoeaciSB3ZWJDb250ZW50c++8iOW9k+WJjeS4jeaYr+S4u+i/m+eoi++8n++8iSc7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGVsZWN0cm9uQ2FjaGUgPSBudWxsO1xuICAgICAgICBlbGVjdHJvbkVycm9yID0gZGVzY3JpYmUoZXJyKTtcbiAgICB9XG4gICAgcmV0dXJuIGVsZWN0cm9uQ2FjaGU7XG59XG5cbi8qKiDmi7/kuI3liLAgRWxlY3Ryb24g55qE5Y6f5Zug77yI5Y+v55So5pe26L+U5ZueIG51bGzvvInjgILlm57miafph4zopoHlpoLlrp7or7TmuIXmmK/jgIzmsqHov5nkuKrog73lipvjgI3ov5jmmK/jgIzmipPlpLHotKXkuobjgI3jgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCk6IHN0cmluZyB8IG51bGwge1xuICAgIGdldEVsZWN0cm9uKCk7XG4gICAgcmV0dXJuIGVsZWN0cm9uRXJyb3I7XG59XG5cbmZ1bmN0aW9uIHNhZmVVcmwoY29udGVudHM6IFdlYkNvbnRlbnRzKTogc3RyaW5nIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gY29udGVudHMuZ2V0VVJMKCkgfHwgJyc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhZmVUeXBlKGNvbnRlbnRzOiBXZWJDb250ZW50cyk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGNvbnRlbnRzLmdldFR5cGUoKSB8fCAnJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cbn1cblxuLyoqIOaJgOaciea0u+edgOeahOe9kemhteOAguiviuaWre+8iOaKk+S4jeWIsOaXtuWIl+WHuuOAjOW9k+aXtuWIsOW6leacieWTquS6myB3ZWJDb250ZW50c+OAje+8ieS4juWumuS9jemDveeUqOWug+OAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3RDb250ZW50cygpOiBDb250ZW50SW5mb1tdIHtcbiAgICBjb25zdCBlbGVjdHJvbiA9IGdldEVsZWN0cm9uKCk7XG4gICAgaWYgKCFlbGVjdHJvbiB8fCAhZWxlY3Ryb24ud2ViQ29udGVudHMpIHJldHVybiBbXTtcbiAgICBsZXQgYWxsOiBXZWJDb250ZW50c1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgYWxsID0gZWxlY3Ryb24ud2ViQ29udGVudHMuZ2V0QWxsV2ViQ29udGVudHMoKSB8fCBbXTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCByb3dzOiBDb250ZW50SW5mb1tdID0gW107XG4gICAgZm9yIChjb25zdCBjb250ZW50cyBvZiBhbGwpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChjb250ZW50cy5pc0Rlc3Ryb3llZCgpKSBjb250aW51ZTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3c6IENvbnRlbnRJbmZvID0geyBpZDogY29udGVudHMuaWQsIHR5cGU6IHNhZmVUeXBlKGNvbnRlbnRzKSwgdXJsOiBzYWZlVXJsKGNvbnRlbnRzKSB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcm93LnRpdGxlID0gY29udGVudHMuZ2V0VGl0bGUoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlv73nlaXvvJrlj5bkuI3liLDlsLHnrpfkuoYgKi9cbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgd2luID0gY29udGVudHMuZ2V0T3duZXJCcm93c2VyV2luZG93KCk7XG4gICAgICAgICAgICByb3cudmlzaWJsZSA9IHdpbiA/IHdpbi5pc1Zpc2libGUoKSA6IG51bGw7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5b+955WlICovXG4gICAgICAgIH1cbiAgICAgICAgcm93cy5wdXNoKHJvdyk7XG4gICAgfVxuICAgIHJldHVybiByb3dzO1xufVxuXG4vKiog5Y675o6JICNoYXNo77ya5ZCM5LiA6aG155qEIGhhc2gg5Y+Y5YyW5LiN6K+l6KKr5b2T5oiQ5o2i6aG144CCICovXG5mdW5jdGlvbiB3aXRob3V0SGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYXQgPSB1cmwuaW5kZXhPZignIycpO1xuICAgIHJldHVybiBhdCA+PSAwID8gdXJsLnNsaWNlKDAsIGF0KSA6IHVybDtcbn1cblxuLyoqXG4gKiDlrprkvY3lnLrmma/op4blm77jgIJcbiAqXG4gKiDkvJjlhYjnuqfvvIgqKummlumAieeyvuehruWMuemFjSoq77yM5Zug5Li644CM5oqT6ZSZ56qX5Y+j44CN5piv5pyA6Zq+5p+l55qE5LiA57G75pWF6Zqc77yJ77yaXG4gKiAxLiBgaHJlZmAg4oCU4oCUIOWcuuaZr+iEmuacrOaKpeadpeeahCBgbG9jYXRpb24uaHJlZmDvvIzkuZ/lsLHmmK/lroPoh6rlt7HpgqPkuIDpobXjgILov5nmmK8qKuehruWumuaApyoq55qE77ybXG4gKiAyLiBVUkwg5ZG95LitIGAyZHwzZC13ZWJ2aWV3Lmh0bWxg77yI5Zy65pmv6ISa5pys5LiN5Y+v55So5pe255qE5YWc5bqV77yJ77ybXG4gKiAzLiDllK/kuIDnmoQgYHdlYnZpZXdgIOexu+Wei+WunuS+i++8iOWGjeWFnOS4gOWxgu+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZFNjZW5lVmlldyhocmVmPzogc3RyaW5nKTogU2NlbmVWaWV3SGl0IHwgbnVsbCB7XG4gICAgY29uc3QgZWxlY3Ryb24gPSBnZXRFbGVjdHJvbigpO1xuICAgIGlmICghZWxlY3Ryb24gfHwgIWVsZWN0cm9uLndlYkNvbnRlbnRzKSByZXR1cm4gbnVsbDtcbiAgICBsZXQgYWxsOiBXZWJDb250ZW50c1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgICAgYWxsID0gZWxlY3Ryb24ud2ViQ29udGVudHMuZ2V0QWxsV2ViQ29udGVudHMoKSB8fCBbXTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgY2FuZGlkYXRlczogV2ViQ29udGVudHNbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgY29udGVudHMgb2YgYWxsKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoY29udGVudHMuaXNEZXN0cm95ZWQoKSkgY29udGludWU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKE5PTl9TQ0VORV9UWVBFLnRlc3Qoc2FmZVR5cGUoY29udGVudHMpKSkgY29udGludWU7XG4gICAgICAgIGNhbmRpZGF0ZXMucHVzaChjb250ZW50cyk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9IaXQgPSAoY29udGVudHM6IFdlYkNvbnRlbnRzLCBtYXRjaGVkQnk6IFNjZW5lVmlld0hpdFsnbWF0Y2hlZEJ5J10pOiBTY2VuZVZpZXdIaXQgPT4gKHtcbiAgICAgICAgY29udGVudHMsXG4gICAgICAgIG1hdGNoZWRCeSxcbiAgICAgICAgaW5mbzogeyBpZDogY29udGVudHMuaWQsIHR5cGU6IHNhZmVUeXBlKGNvbnRlbnRzKSwgdXJsOiBzYWZlVXJsKGNvbnRlbnRzKSB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgd2FudGVkID0gdHlwZW9mIGhyZWYgPT09ICdzdHJpbmcnID8gd2l0aG91dEhhc2goaHJlZi50cmltKCkpIDogJyc7XG4gICAgaWYgKHdhbnRlZCkge1xuICAgICAgICBmb3IgKGNvbnN0IGNvbnRlbnRzIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgICAgIGlmICh3aXRob3V0SGFzaChzYWZlVXJsKGNvbnRlbnRzKSkgPT09IHdhbnRlZCkgcmV0dXJuIHRvSGl0KGNvbnRlbnRzLCAnaHJlZicpO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDpgIDkuIDmraXmjInjgIzpl67lj7fkuYvliY0gKyB3ZWJ2aWV3IOmhtemdouOAjeavlO+8mue8lui+keWZqOWPr+iDvee7meS4jeWQjOeahCBxdWVyee+8iGA/dXJsPeKApmDvvIlcbiAgICAgICAgICog5ou85Ye65LiN5ZCM55qEIFVSTO+8jOiAjCBwYXRobmFtZSDmmK/lkIzkuIDkuKrmlofku7bjgIJcbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IHdhbnRlZEJhc2UgPSB3YW50ZWQuc3BsaXQoJz8nKVswXTtcbiAgICAgICAgaWYgKHdhbnRlZEJhc2UpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY29udGVudHMgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHVybCA9IHdpdGhvdXRIYXNoKHNhZmVVcmwoY29udGVudHMpKTtcbiAgICAgICAgICAgICAgICBpZiAodXJsLnNwbGl0KCc/JylbMF0gPT09IHdhbnRlZEJhc2UgJiYgU0NFTkVfVklFV19VUkwudGVzdCh1cmwpKSByZXR1cm4gdG9IaXQoY29udGVudHMsICd1cmwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3QgY29udGVudHMgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICBpZiAoU0NFTkVfVklFV19VUkwudGVzdChzYWZlVXJsKGNvbnRlbnRzKSkpIHJldHVybiB0b0hpdChjb250ZW50cywgJ3VybCcpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNvbnRlbnRzIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgaWYgKHNhZmVUeXBlKGNvbnRlbnRzKSA9PT0gJ3dlYnZpZXcnKSByZXR1cm4gdG9IaXQoY29udGVudHMsICd3ZWJ2aWV3Jyk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOaKk+WbviAvIOepuuWbvuWIpOaNriAvIOijgeWIh+S4jue8lueggVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog56m65Zu+5q+U5L6LIOKAlOKAlCAqKuS4juWcuuaZr+S+pyBgc2FtcGxlQmxhbmtSYXRpb2Ag5ZCM5LiA5Y+j5b6EKirvvIjlhajpgI/mmI7miJbnuq/pu5Hpg73nrpfnqbrvvInvvIxcbiAqIOS4pOi+ueaVsOWtl+WPr+S7peebtOaOpeavlOOAgmB0b0JpdG1hcCgpYCDnu5nnmoTmmK8gQkdSQeOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gYmxhbmtSYXRpb09mKGltYWdlOiBOYXRpdmVJbWFnZSk6IG51bWJlciB7XG4gICAgbGV0IGJpdG1hcDogQnVmZmVyO1xuICAgIHRyeSB7XG4gICAgICAgIGJpdG1hcCA9IGltYWdlLnRvQml0bWFwKCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAwOyAvLyDlj5bkuI3liLDlg4/ntKDlsLHliKvmiorlroPlvZPmiJBcIuepuuWbvlwi77yI5a6B5Y+v6K6p5LiK5bGC5oyJ5q2j5bi45Zu+5aSE55CG77yJXG4gICAgfVxuICAgIGNvbnN0IHRvdGFsID0gTWF0aC5mbG9vcihiaXRtYXAubGVuZ3RoIC8gNCk7XG4gICAgaWYgKHRvdGFsIDw9IDApIHJldHVybiAxO1xuICAgIGNvbnN0IHN0ZXAgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHRvdGFsIC8gNTEyKSk7XG4gICAgbGV0IHNhbXBsZWQgPSAwO1xuICAgIGxldCBibGFuayA9IDA7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b3RhbDsgaSArPSBzdGVwKSB7XG4gICAgICAgIGNvbnN0IG8gPSBpICogNDtcbiAgICAgICAgc2FtcGxlZCArPSAxO1xuICAgICAgICBpZiAoYml0bWFwW28gKyAzXSA9PT0gMCB8fCAoYml0bWFwW29dID09PSAwICYmIGJpdG1hcFtvICsgMV0gPT09IDAgJiYgYml0bWFwW28gKyAyXSA9PT0gMCkpIGJsYW5rICs9IDE7XG4gICAgfVxuICAgIHJldHVybiBzYW1wbGVkID4gMCA/IE1hdGgucm91bmQoKGJsYW5rIC8gc2FtcGxlZCkgKiAxMDAwKSAvIDEwMDAgOiAxO1xufVxuXG4vKiog5Zu+55qEIERJUCDlsLrlr7jvvIg9IENTUyDlg4/ntKDvvInjgILlj5bkuI3liLDml7blm54gMMOXMO+8iOiwg+eUqOaWueaNruatpOWIpOaWrVwi6L+Z5byg5Zu+5LiN5Y+v55SoXCLvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpbWFnZVNpemVPZihpbWFnZTogTmF0aXZlSW1hZ2UpOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNpemUgPSBpbWFnZS5nZXRTaXplKCk7XG4gICAgICAgIHJldHVybiB7IHdpZHRoOiBzaXplLndpZHRoIHx8IDAsIGhlaWdodDogc2l6ZS5oZWlnaHQgfHwgMCB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4geyB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XG4gICAgfVxufVxuXG4vKiog5YaF6YOo55So55qE55+t5ZCN44CCICovXG5jb25zdCBpbWFnZVNpemUgPSBpbWFnZVNpemVPZjtcblxuLyoqXG4gKiDmipPkuIDlvKDlnLrmma/op4blm74g4oCU4oCUICoq5Y+q6K+7KirvvJrkuIDmrKEgYGNhcHR1cmVQYWdlKClg77yM5LiN5o6S6YeN57uY44CB5LiN6YeN6K+V44CB5LiN56Kw5ZCI5oiQ5Zmo44CCXG4gKlxuICog5oqT5Yiw55qE5piv56m65Zu+77yIYGJsYW5rUmF0aW9gIOaOpei/kSAx77yJ5bCx5piv56m65Zu+77yMKirlpoLlrp7miqUqKu+8iOaWh+S7tuWktOmCo+adoeehrOWPo+W+hO+8mlxuICog5pys5omp5bGV5LiN6LCDIGBpbnZhbGlkYXRlKClg77ybXCLpgLzkuIDluKdcIuaVkeS4jeaVkeW+l+WbnuadpeayoeacieivgeaNru+8jOiAjOS7o+S7t+aYr+eUqOaIt+eahOe8lui+keWZqOm7keWxj++8ieOAglxuICog56m65Zu+55qE6YCA6Lev5LiN5piv6YeN6K+V77yM6ICM5pivKirmjaLliKTmja4qKu+8iGB3b3JsZFJlY3Qobm9kZSlgIOi/meexu+aVsOWAvOWIpOaNru+8ieOAglxuICpcbiAqIEBwYXJhbSBocmVmIOWcuuaZr+iEmuacrOaKpeadpeeahCBgbG9jYXRpb24uaHJlZmDvvIjpppbpgInliKTmja7vvIzop4Ege0BsaW5rIGZpbmRTY2VuZVZpZXd977yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlU2NlbmVWaWV3KGhyZWY/OiBzdHJpbmcpOiBQcm9taXNlPENhcHR1cmVPdXRjb21lPiB7XG4gICAgY29uc3QgaGl0ID0gZmluZFNjZW5lVmlldyhocmVmKTtcbiAgICBpZiAoIWhpdCkge1xuICAgICAgICBjb25zdCByZWFzb24gPSBlbGVjdHJvblVuYXZhaWxhYmxlUmVhc29uKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogcmVhc29uXG4gICAgICAgICAgICAgICAgPyBg5ou/5LiN5YiwIEVsZWN0cm9uIOeahCB3ZWJDb250ZW50c++8miR7cmVhc29ufWBcbiAgICAgICAgICAgICAgICA6ICfmsqHmnInmib7liLDlnLrmma/op4blm77nmoQgd2ViQ29udGVudHPvvIjnvJbovpHlmajph4zlj6/og73ov5jmsqHmnInmiZPlvIDku7vkvZXlnLrmma/op4blm77pnaLmnb/vvInjgIInLFxuICAgICAgICAgICAgY29udGVudHM6IGxpc3RDb250ZW50cygpLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRlbnRzID0gaGl0LmNvbnRlbnRzO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGltYWdlID0gYXdhaXQgY29udGVudHMuY2FwdHVyZVBhZ2UoKTtcbiAgICAgICAgY29uc3Qgc2l6ZSA9IGltYWdlU2l6ZShpbWFnZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGltYWdlLFxuICAgICAgICAgICAgc291cmNlV2lkdGg6IHNpemUud2lkdGgsXG4gICAgICAgICAgICBzb3VyY2VIZWlnaHQ6IHNpemUuaGVpZ2h0LFxuICAgICAgICAgICAgYmxhbmtSYXRpbzogYmxhbmtSYXRpb09mKGltYWdlKSxcbiAgICAgICAgICAgIHRhcmdldDogaGl0LmluZm8sXG4gICAgICAgICAgICBtYXRjaGVkQnk6IGhpdC5tYXRjaGVkQnksXG4gICAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogYGNhcHR1cmVQYWdlIOWksei0pe+8miR7ZGVzY3JpYmUoZXJyKX1gLFxuICAgICAgICAgICAgY29udGVudHM6IGxpc3RDb250ZW50cygpLFxuICAgICAgICB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDmiorjgIzpobXpnaIgQ1NTIOWDj+e0oOOAjeefqeW9ouaNoueul+aIkOWbvueJh+WDj+e0oOefqeW9ouW5tuijgeWIh+OAglxuICpcbiAqIGBwYWdlQ3NzYCDmmK/pobXpnaLvvIg9IOaKk+WIsOeahOaVtOmhte+8ieeahCBDU1Mg5bC65a+477yb5q+U5YC8Kirlrp7mtYsqKuWHuuadpe+8jFxuICog6ICM5LiN5piv5YGH5a6a44CM5Zu+5a69ID09IOmhtemdoiBDU1Mg5a6944CN77yI57yp5pS+IC8gRFBJIOWPluiIjeS8muiuqeWug+S4jeetie+8ieOAglxuICpcbiAqIEByZXR1cm5zIOijgeWIh+WQjueahOWbvu+8m+efqeW9oumAgOWMluaIkOepuuOAgeaIliBgY3JvcGAg5oqb5byC5bi45pe2Kirljp/moLfov5Tlm54qKu+8iOWugeWPr+e7meaVtOmhte+8jOS4jee7meepuuWbvu+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JvcFRvQ3NzUmVjdChcbiAgICBpbWFnZTogTmF0aXZlSW1hZ2UsXG4gICAgcmVjdDogeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcbiAgICBwYWdlQ3NzOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0sXG4pOiB7IGltYWdlOiBOYXRpdmVJbWFnZTsgcmVjdDogeyB4OiBudW1iZXI7IHk6IG51bWJlcjsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSB8IG51bGwgfSB7XG4gICAgY29uc3Qgc2l6ZSA9IGltYWdlU2l6ZShpbWFnZSk7XG4gICAgaWYgKCFwYWdlQ3NzLndpZHRoIHx8ICFwYWdlQ3NzLmhlaWdodCB8fCAhc2l6ZS53aWR0aCB8fCAhc2l6ZS5oZWlnaHQpIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG5cbiAgICBjb25zdCBzY2FsZVggPSBzaXplLndpZHRoIC8gcGFnZUNzcy53aWR0aDtcbiAgICBjb25zdCBzY2FsZVkgPSBzaXplLmhlaWdodCAvIHBhZ2VDc3MuaGVpZ2h0O1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHNjYWxlWCkgfHwgIU51bWJlci5pc0Zpbml0ZShzY2FsZVkpIHx8IHNjYWxlWCA8PSAwIHx8IHNjYWxlWSA8PSAwKSB7XG4gICAgICAgIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG4gICAgfVxuXG4gICAgLyoqIOWFiOWIpOOAjCoq5Y6L5qC55LiN55u45LqkKirjgI3vvJrpgqPlsLHkuI3mmK9cIuijgeS4gOS4i1wi77yM6ICM5piv55+p5b2i566X6ZSZ5LqGIOKAlOKAlCDlm54gbnVsbCDorqnkuIrlsYLpgIDlm57mlbTlvKDop4blm77vvIxcbiAgICAgKiAg5Yir57uZ5LiA5bygIDEg5YOP57Sg5a6955qEXCLmnInmlYjoo4HliIdcIu+8iOmCo+enjeWbvueci+S4jeWHuumXrumimOWcqOWTqu+8jOacgOmavuafpe+8ieOAgiAqL1xuICAgIGNvbnN0IHJhd1ggPSByZWN0LnggKiBzY2FsZVg7XG4gICAgY29uc3QgcmF3WSA9IHJlY3QueSAqIHNjYWxlWTtcbiAgICBjb25zdCByYXdXID0gcmVjdC53aWR0aCAqIHNjYWxlWDtcbiAgICBjb25zdCByYXdIID0gcmVjdC5oZWlnaHQgKiBzY2FsZVk7XG4gICAgaWYgKHJhd1ggKyByYXdXIDw9IDAgfHwgcmF3WSArIHJhd0ggPD0gMCB8fCByYXdYID49IHNpemUud2lkdGggfHwgcmF3WSA+PSBzaXplLmhlaWdodCkge1xuICAgICAgICByZXR1cm4geyBpbWFnZSwgcmVjdDogbnVsbCB9O1xuICAgIH1cblxuICAgIC8qKiDlpLnliLDlm77lhoXvvJrnm7jkuqTkvYbotornlYznmoTkuIDkvqfmiY3lpLkgKi9cbiAgICBjb25zdCB4ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2l6ZS53aWR0aCAtIDEsIE1hdGgucm91bmQocmF3WCkpKTtcbiAgICBjb25zdCB5ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2l6ZS5oZWlnaHQgLSAxLCBNYXRoLnJvdW5kKHJhd1kpKSk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLm1pbihzaXplLndpZHRoIC0geCwgTWF0aC5yb3VuZChyYXdXKSkpO1xuICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgubWluKHNpemUuaGVpZ2h0IC0geSwgTWF0aC5yb3VuZChyYXdIKSkpO1xuICAgIGNvbnN0IHRhcmdldCA9IHsgeCwgeSwgd2lkdGgsIGhlaWdodCB9O1xuXG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIHsgaW1hZ2U6IGltYWdlLmNyb3AodGFyZ2V0KSwgcmVjdDogdGFyZ2V0IH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGltYWdlLCByZWN0OiBudWxsIH07XG4gICAgfVxufVxuXG4vKipcbiAqIOe8qeWIsOS4jei2hei/hyBgbWF4V2lkdGhg77yIKirnrYnmr5QqKu+8mkVsZWN0cm9uIOeahCBgcmVzaXplYCDlj6rnu5kgd2lkdGgg5pe2IGhlaWdodCDlj5bljp/pq5jvvIzkuI3mmK/nrYnmr5TvvInjgIJcbiAqXG4gKiBAcmV0dXJucyDnvKnmlL7lkI7nmoTlm77vvJvmnKzmnaXlsLHlpJ/lsI/jgIHmiJYgYHJlc2l6ZWAg5LiN5Y+v55So5pe25Y6f5qC36L+U5Zue44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb3duc2NhbGVUb1dpZHRoKGltYWdlOiBOYXRpdmVJbWFnZSwgbWF4V2lkdGg6IG51bWJlcik6IE5hdGl2ZUltYWdlIHtcbiAgICBpZiAoIW1heFdpZHRoIHx8IG1heFdpZHRoIDw9IDApIHJldHVybiBpbWFnZTtcbiAgICBjb25zdCBzaXplID0gaW1hZ2VTaXplKGltYWdlKTtcbiAgICBpZiAoIXNpemUud2lkdGggfHwgc2l6ZS53aWR0aCA8PSBtYXhXaWR0aCkgcmV0dXJuIGltYWdlO1xuICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoKHNpemUuaGVpZ2h0ICogbWF4V2lkdGgpIC8gc2l6ZS53aWR0aCkpO1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBpbWFnZS5yZXNpemUoeyB3aWR0aDogbWF4V2lkdGgsIGhlaWdodCwgcXVhbGl0eTogJ2dvb2QnIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gaW1hZ2U7XG4gICAgfVxufVxuXG4vKiog57yW56CB5oiQIHBuZy9qcGVnIOWtl+iKguOAgmB0b1BORygpYCDpu5jorqQgc2NhbGVGYWN0b3IgMe+8iD0gRElQ77yJ77yM5LiO5Z2Q5qCH5Y+j5b6E5LiA6Ie044CCICovXG5leHBvcnQgZnVuY3Rpb24gZW5jb2RlSW1hZ2UoaW1hZ2U6IE5hdGl2ZUltYWdlLCBmb3JtYXQ6ICdwbmcnIHwgJ2pwZWcnLCBxdWFsaXR5OiBudW1iZXIpOiBCdWZmZXIge1xuICAgIGlmIChmb3JtYXQgPT09ICdqcGVnJykge1xuICAgICAgICByZXR1cm4gaW1hZ2UudG9KUEVHKE1hdGgucm91bmQoTWF0aC5taW4oMSwgTWF0aC5tYXgoMC4xLCBxdWFsaXR5KSkgKiAxMDApKTtcbiAgICB9XG4gICAgcmV0dXJuIGltYWdlLnRvUE5HKCk7XG59XG4iXX0=