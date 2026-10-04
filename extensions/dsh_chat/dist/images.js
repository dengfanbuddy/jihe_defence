"use strict";
/**
 * 图片附件 —— 「工程里的图片 / 剪贴板图片 → 模型」这条链路上**唯一的真源**。
 *
 * ## 为什么要单独一个模块
 *
 * 这条链路上有三处「写在两个地方、必须对得上」的数字与名字，而且**对不上的时候都不报错**
 * （面板照发、主进程照传，最后是模型侧拒收或者干脆静默丢图）：
 *
 * 1. **MIME 白名单**：DSH 的附件库（`@deepseek-ai/dsh-attachment`）只收
 *    `image/png | image/jpeg | image/webp | image/gif` 四种，别的类型在 `saveImages` 里
 *    直接被拒（`UNSUPPORTED_IMAGE_TYPE`）。所以扩展名 → MIME 的映射必须是一份；
 * 2. **上限**：单张 20MB / 单条消息 20 张 / 合计 200MB（与 `dsh-attachment-local` 的
 *    `Config` 默认值同口径）。超了要在**面板上**就说清楚，别让用户等一轮才发现图没上去；
 * 3. **base64 必须是「规范形式」**：附件库的解码器要求
 *    `Buffer.from(data,'base64').toString('base64') === data`（`INVALID_IMAGE_BASE64`）——
 *    带换行、带空格、带 `data:` 前缀的一律拒绝。所以在进 IPC 之前就归一化一次。
 *
 * 这个模块**不碰 `Editor`**（纯 fs + path），所以 `scripts/verify-images.js` 能拿一个临时
 * 目录把整条读取/校验逻辑真跑一遍 —— 不用开编辑器。
 *
 * ## 「工程里的图片」为什么有两套路
 *
 * 主路是资源库（`asset-db` 的 `query-assets`）：它是编辑器里**用户真看得见**的那份事实，
 * 还顺带给出 `db://assets/...` 这个可读 URL 与 uuid。兜底是直接扫 `assets/` 目录：资源库
 * 查询是内置扩展的消息，可能因为版本差异、数据库没就绪、pattern 语义变化而返回空
 * —— 那时「一张图都选不了」是很糟的体验，而目录扫描永远能用。
 * 两套结果按**绝对路径**去重合并（见 `mergeProjectImages`）。
 *
 * @module dsh_chat/images
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SCAN_DEPTH = exports.MAX_LISTED_IMAGES = exports.MAX_MESSAGE_IMAGE_BYTES = exports.MAX_IMAGE_BYTES = exports.MAX_IMAGES_PER_MESSAGE = exports.IMAGE_EXTENSIONS = exports.IMAGE_MIME_BY_EXT = void 0;
exports.mimeOfImagePath = mimeOfImagePath;
exports.isImagePath = isImagePath;
exports.dbUrlToPath = dbUrlToPath;
exports.pathToDbUrl = pathToDbUrl;
exports.urlLooksLikeImage = urlLooksLikeImage;
exports.scanImageFiles = scanImageFiles;
exports.mergeProjectImages = mergeProjectImages;
exports.projectImagesFromAssetDb = projectImagesFromAssetDb;
exports.filterProjectImages = filterProjectImages;
exports.readImageFile = readImageFile;
exports.validateImageBatch = validateImageBatch;
exports.formatBytes = formatBytes;
const fs_1 = require("fs");
const path_1 = require("path");
/** 扩展名 → MIME。键一律是**小写、带点**的形式（`extname()` 的返回值）。 */
exports.IMAGE_MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};
/** 认得的图片扩展名（面板的筛选、目录扫描共用）。 */
exports.IMAGE_EXTENSIONS = Object.keys(exports.IMAGE_MIME_BY_EXT);
/** 一条消息里最多几张（对齐 `dsh-attachment-local` 的 `maxImagesPerMessage` 默认值）。 */
exports.MAX_IMAGES_PER_MESSAGE = 20;
/** 单张图的字节上限（`maxImageBytes` 默认 20MB）——超了是**拒收**，不是压缩。 */
exports.MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 一条消息里所有图的合计字节上限（`maxMessageImageBytes` 默认 200MB）。 */
exports.MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;
/** 列工程图片时的条数上限（面板是 DOM 列表，不设上限会卡）。 */
exports.MAX_LISTED_IMAGES = 800;
/** 目录扫描的深度上限（防符号链接成环 / 恐怖目录）。 */
exports.MAX_SCAN_DEPTH = 12;
/** `extname` 结果的小写形式（`.` 开头；没有扩展名时是空串）。 */
function extOf(file) {
    return (0, path_1.extname)(file).toLowerCase();
}
/**
 * 路径 → MIME；不是认得的图片则返回 null。
 *
 * @param file - 文件名或绝对路径（只看扩展名）。
 * @returns MIME 或 null。
 */
function mimeOfImagePath(file) {
    var _a;
    return (_a = exports.IMAGE_MIME_BY_EXT[extOf(file)]) !== null && _a !== void 0 ? _a : null;
}
/** 扩展名是不是认得的图片。 */
function isImagePath(file) {
    return mimeOfImagePath(file) !== null;
}
/**
 * `db://assets/foo/bar.png` → `<工程根>/assets/foo/bar.png`。
 *
 * 只认 `db://assets/` 与 `db://internal/` 两个挂载点（编辑器里只有这两个稳定存在），
 * 其余（用户自建的 db 挂载）返回 null —— 宁可不显示，也不要拼出一个错路径去读盘。
 *
 * ⚠ 资源库的**子资源**（如 `db://assets/a.png/spriteFrame`）也会走这个函数，
 * 它拼出来的是一个不存在的路径 —— 调用方按「扩展名必须正好是图片后缀」过滤掉它们
 * （见 `urlLooksLikeImage`），别在这里猜。
 *
 * @param projectPath - 工程根（`Editor.Project.path`）。
 * @param url - `db://` 开头的资源 URL。
 * @returns 绝对路径或 null。
 */
function dbUrlToPath(projectPath, url) {
    const match = /^db:\/\/([^/]+)\/(.+)$/.exec(url.trim());
    if (!match)
        return null;
    const [, mount, rest] = match;
    if (mount !== 'assets' && mount !== 'internal')
        return null;
    return (0, path_1.join)((0, path_1.resolve)(projectPath), mount, ...rest.split('/'));
}
/**
 * 绝对路径 → `db://assets/...`（反向映射）。
 *
 * @param projectPath - 工程根。
 * @param file - 绝对路径。
 * @returns `db://` URL，或空串（路径不在 assets/internal 下）。
 */
function pathToDbUrl(projectPath, file) {
    const root = (0, path_1.resolve)(projectPath);
    const target = (0, path_1.resolve)(file);
    for (const mount of ['assets', 'internal']) {
        const base = (0, path_1.join)(root, mount);
        if (target === base)
            continue;
        if (target.startsWith(base + path_1.sep)) {
            const rest = (0, path_1.relative)(base, target).split(path_1.sep).join('/');
            return `db://${mount}/${rest}`;
        }
    }
    return '';
}
/** 这个 `db://` URL 看着就是一张图本体（不是 `/spriteFrame` 那种子资源）。 */
function urlLooksLikeImage(url) {
    return isImagePath(url);
}
/**
 * 扫一个目录下的所有图片文件（**兜底路**，资源库查询拿不到东西时用）。
 *
 * 只认图片扩展名；跳过 `.` 开头的目录（`.git` / `.tmp` 这类）与 `library`/`temp`
 * （它们不在 `assets/` 下，但工程根被误传进来时也拦一下）。
 *
 * @param root - 起始目录（一般是 `<工程根>/assets`）。
 * @param limit - 条数上限。
 * @returns 文件清单（绝对路径 + 相对路径 + 字节数），按路径排序。
 */
function scanImageFiles(root, limit = exports.MAX_LISTED_IMAGES) {
    const out = [];
    const base = (0, path_1.resolve)(root);
    const walk = (dir, depth) => {
        if (depth > exports.MAX_SCAN_DEPTH || out.length >= limit)
            return;
        let names;
        try {
            names = (0, fs_1.readdirSync)(dir);
        }
        catch {
            return; // 没权限/不存在：跳过这一支，不打断整次扫描
        }
        for (const name of names) {
            if (out.length >= limit)
                return;
            if (name.startsWith('.'))
                continue;
            const abs = (0, path_1.join)(dir, name);
            let stat;
            try {
                stat = (0, fs_1.statSync)(abs);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(abs, depth + 1);
                continue;
            }
            if (!stat.isFile() || !isImagePath(name))
                continue;
            const rel = (0, path_1.relative)(base, abs).split(path_1.sep).join('/');
            out.push({ path: abs, rel, name, bytes: stat.size });
        }
    };
    walk(base, 0);
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
/**
 * 两套路的结果合并：**按绝对路径去重**，主路（资源库）优先。
 *
 * @param primary - 资源库查到的（可空）。
 * @param fallback - 目录扫描到的（可空）。
 * @param limit - 总条数上限。
 * @returns 合并后的清单。
 */
function mergeProjectImages(primary, fallback, limit = exports.MAX_LISTED_IMAGES) {
    const seen = new Set();
    const out = [];
    for (const item of [...(primary !== null && primary !== void 0 ? primary : []), ...(fallback !== null && fallback !== void 0 ? fallback : [])]) {
        // Windows 盘符大小写、`/` `\` 混用都会让同一个文件变成两条 —— 统一成小写的规范路径
        const key = process.platform === 'win32' ? (0, path_1.resolve)(item.path).toLowerCase() : (0, path_1.resolve)(item.path);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit)
            break;
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
/**
 * 把 `asset-db` 的 `query-assets` 结果投影成 `ProjectImage[]`。
 *
 * 三道过滤，缺一条就会在面板上出现「点了读不出来」的项：
 *
 * 1. **只收 `db://assets/`**：`db://internal/...` 是引擎自带的资源，它映射到编辑器安装目录
 *    而不是工程目录（本扩展的 `read-image` 只读工程内的文件，会拒绝），列出来只会误导人；
 * 2. **URL 的扩展名必须正好是图片后缀**：资源库还会返回子资源，比如
 *    `db://assets/a.png/spriteFrame` —— 它拼出来是个不存在的路径；
 * 3. 拼不出绝对路径的（未知挂载点）直接跳过。
 *
 * @param rows - `query-assets` 的返回（形状不保证，逐字段取）。
 * @param projectPath - 工程根。
 * @returns 投影后的清单。
 */
function projectImagesFromAssetDb(rows, projectPath) {
    if (!Array.isArray(rows))
        return [];
    const out = [];
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object')
            continue;
        const row = raw;
        const url = typeof row.url === 'string' ? row.url : '';
        if (!url.startsWith('db://assets/'))
            continue;
        if (!urlLooksLikeImage(url))
            continue;
        const file = typeof row.file === 'string' && row.file ? row.file : dbUrlToPath(projectPath, url);
        if (!file)
            continue;
        const display = (typeof row.displayName === 'string' && row.displayName) || (typeof row.name === 'string' && row.name) || '';
        out.push({
            url,
            path: file,
            name: display || url.split('/').pop() || file,
            uuid: typeof row.uuid === 'string' ? row.uuid : undefined,
            mtime: typeof row.mtime === 'number' ? row.mtime : undefined,
            rel: url.replace(/^db:\/\//, ''),
            source: 'asset-db',
        });
    }
    return out;
}
/** 面板上的搜索：按名字/路径/url 做不区分大小写的子串匹配（空查询 = 全放行）。 */
function filterProjectImages(images, query) {
    const needle = String(query !== null && query !== void 0 ? query : '').trim().toLowerCase();
    if (!needle)
        return images;
    const terms = needle.split(/\s+/).filter(Boolean);
    return images.filter((image) => {
        const haystack = `${image.name} ${image.rel} ${image.url}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}
/**
 * 读一张图并编码成**规范 base64**。
 *
 * 三道关都是必须的：**大小**（20MB 上限，超了附件库拒收）、**类型**（白名单四种）、
 * **规范 base64**（换行/空格/`data:` 前缀都会让附件库报 `INVALID_IMAGE_BASE64`）。
 *
 * @param file - 绝对路径。
 * @param options - `{projectPath}` 用来顺带给出 `db://` URL；`{maxBytes}` 覆盖上限。
 * @returns 回执（失败**不抛**，把原因写成人话）。
 */
function readImageFile(file, options = {}) {
    var _a, _b;
    const maxBytes = (_a = options.maxBytes) !== null && _a !== void 0 ? _a : exports.MAX_IMAGE_BYTES;
    const abs = (0, path_1.resolve)(file);
    const mimeType = mimeOfImagePath(abs);
    if (!mimeType) {
        return { ok: false, error: `不是认得的图片格式（只收 ${exports.IMAGE_EXTENSIONS.join(' / ')}）：${abs}` };
    }
    let size;
    try {
        const stat = (0, fs_1.statSync)(abs);
        if (!stat.isFile())
            return { ok: false, error: `不是文件：${abs}` };
        size = stat.size;
    }
    catch (error) {
        return { ok: false, error: `读不到这个文件（${error instanceof Error ? error.message : String(error)}）：${abs}` };
    }
    if (size > maxBytes) {
        return {
            ok: false,
            error: `这张图 ${formatBytes(size)}，超过单张上限 ${formatBytes(maxBytes)}（DSH 附件库是拒收而不是压缩，请先自己压一下）。`,
        };
    }
    try {
        // 规范 base64：`toString('base64')` 不换行、无空格，正是附件库要的形式（别再手工拼 data: 前缀）
        const data = (0, fs_1.readFileSync)(abs).toString('base64');
        return {
            ok: true,
            name: (_b = abs.split(path_1.sep).pop()) !== null && _b !== void 0 ? _b : abs,
            path: abs,
            url: options.projectPath ? pathToDbUrl(options.projectPath, abs) : '',
            mimeType,
            bytes: size,
            data,
        };
    }
    catch (error) {
        return { ok: false, error: `读文件失败（${error instanceof Error ? error.message : String(error)}）：${abs}` };
    }
}
/** 认得的 MIME 集合（`validateImageBatch` 用）。 */
const ACCEPTED_MIME = new Set(Object.values(exports.IMAGE_MIME_BY_EXT));
/**
 * 校验一批待发送的图片。
 *
 * **在扩展这一侧再验一遍**（面板已经验过一次）：面板是渲染进程，它说的任何内容都不可信
 * ——这是 `panelProbe` 那条注释里的同一条口径。而且这一步能把「超限」变成一句人话回给面板，
 * 而不是等 SDK 侧抛 `IMAGES_TOO_LARGE` 后被吞成「发送失败」。
 *
 * @param images - 面板给的原始数组。
 * @returns 通过则给出规范化的图片列表，否则给出人话原因。
 */
function validateImageBatch(images) {
    var _a;
    if (images === undefined || images === null)
        return { ok: true, images: [] };
    if (!Array.isArray(images))
        return { ok: false, error: 'images 必须是数组' };
    if (images.length > exports.MAX_IMAGES_PER_MESSAGE) {
        return { ok: false, error: `一条消息最多带 ${exports.MAX_IMAGES_PER_MESSAGE} 张图（现在 ${images.length} 张）。` };
    }
    const out = [];
    let total = 0;
    for (let index = 0; index < images.length; index += 1) {
        const raw = ((_a = images[index]) !== null && _a !== void 0 ? _a : {});
        const where = `第 ${index + 1} 张`;
        const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : '';
        if (!ACCEPTED_MIME.has(mimeType)) {
            return { ok: false, error: `${where}的类型 "${mimeType || '(空)'}" 不在允许范围（${[...ACCEPTED_MIME].join(' / ')}）。` };
        }
        const data = typeof raw.data === 'string' ? raw.data.trim() : '';
        if (!data)
            return { ok: false, error: `${where}没有数据。` };
        let decoded;
        try {
            decoded = Buffer.from(data, 'base64');
        }
        catch (error) {
            return { ok: false, error: `${where}的 base64 解不开：${error instanceof Error ? error.message : String(error)}` };
        }
        // 规范形式校验（附件库的解码器就是这么判的，见文件头第 3 条）
        if (decoded.length === 0 || decoded.toString('base64') !== data) {
            return { ok: false, error: `${where}的 base64 不是规范形式（不许有换行/空格/缓存前缀），重建一次这张图即可。` };
        }
        if (decoded.length > exports.MAX_IMAGE_BYTES) {
            return { ok: false, error: `${where} ${formatBytes(decoded.length)}，超过单张上限 ${formatBytes(exports.MAX_IMAGE_BYTES)}。` };
        }
        total += decoded.length;
        out.push({
            mimeType: mimeType,
            data,
            bytes: decoded.length,
            name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
        });
    }
    if (total > exports.MAX_MESSAGE_IMAGE_BYTES) {
        return { ok: false, error: `这批图合计 ${formatBytes(total)}，超过单条消息上限 ${formatBytes(exports.MAX_MESSAGE_IMAGE_BYTES)}。` };
    }
    return { ok: true, images: out };
}
/** 字节数 → 人话（`622KB` / `2.3MB`）。 */
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0KB';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1hZ2VzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc291cmNlL2ltYWdlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBNkJHOzs7QUFxRkgsMENBRUM7QUFHRCxrQ0FFQztBQWdCRCxrQ0FNQztBQVNELGtDQVlDO0FBR0QsOENBRUM7QUFZRCx3Q0FrQ0M7QUFVRCxnREFnQkM7QUFpQkQsNERBd0JDO0FBR0Qsa0RBUUM7QUFZRCxzQ0FvQ0M7QUFvQ0QsZ0RBMkNDO0FBR0Qsa0NBR0M7QUEzWUQsMkJBQXlEO0FBQ3pELCtCQUE2RDtBQUs3RCxxREFBcUQ7QUFDeEMsUUFBQSxpQkFBaUIsR0FBa0M7SUFDNUQsTUFBTSxFQUFFLFdBQVc7SUFDbkIsTUFBTSxFQUFFLFlBQVk7SUFDcEIsT0FBTyxFQUFFLFlBQVk7SUFDckIsT0FBTyxFQUFFLFlBQVk7SUFDckIsTUFBTSxFQUFFLFdBQVc7Q0FDdEIsQ0FBQztBQUVGLDhCQUE4QjtBQUNqQixRQUFBLGdCQUFnQixHQUFhLE1BQU0sQ0FBQyxJQUFJLENBQUMseUJBQWlCLENBQUMsQ0FBQztBQUV6RSx3RUFBd0U7QUFDM0QsUUFBQSxzQkFBc0IsR0FBRyxFQUFFLENBQUM7QUFFekMseURBQXlEO0FBQzVDLFFBQUEsZUFBZSxHQUFHLEVBQUUsR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBRWhELHdEQUF3RDtBQUMzQyxRQUFBLHVCQUF1QixHQUFHLEdBQUcsR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBRXpELHNDQUFzQztBQUN6QixRQUFBLGlCQUFpQixHQUFHLEdBQUcsQ0FBQztBQUVyQyxpQ0FBaUM7QUFDcEIsUUFBQSxjQUFjLEdBQUcsRUFBRSxDQUFDO0FBeUNqQywyQ0FBMkM7QUFDM0MsU0FBUyxLQUFLLENBQUMsSUFBWTtJQUN2QixPQUFPLElBQUEsY0FBTyxFQUFDLElBQUksQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFD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LENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQztBQUN6SCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDlm77niYfpmYTku7Yg4oCU4oCUIOOAjOW3peeoi+mHjOeahOWbvueJhyAvIOWJqui0tOadv+WbvueJhyDihpIg5qih5Z6L44CN6L+Z5p2h6ZO+6Lev5LiKKirllK/kuIDnmoTnnJ/mupAqKuOAglxuICpcbiAqICMjIOS4uuS7gOS5iOimgeWNleeLrOS4gOS4quaooeWdl1xuICpcbiAqIOi/meadoemTvui3r+S4iuacieS4ieWkhOOAjOWGmeWcqOS4pOS4quWcsOaWueOAgeW/hemhu+WvueW+l+S4iuOAjeeahOaVsOWtl+S4juWQjeWtl++8jOiAjOS4lCoq5a+55LiN5LiK55qE5pe25YCZ6YO95LiN5oql6ZSZKipcbiAqIO+8iOmdouadv+eFp+WPkeOAgeS4u+i/m+eoi+eFp+S8oO+8jOacgOWQjuaYr+aooeWei+S+p+aLkuaUtuaIluiAheW5suiEhumdmem7mOS4ouWbvu+8ie+8mlxuICpcbiAqIDEuICoqTUlNRSDnmb3lkI3ljZUqKu+8mkRTSCDnmoTpmYTku7blupPvvIhgQGRlZXBzZWVrLWFpL2RzaC1hdHRhY2htZW50YO+8ieWPquaUtlxuICogICAgYGltYWdlL3BuZyB8IGltYWdlL2pwZWcgfCBpbWFnZS93ZWJwIHwgaW1hZ2UvZ2lmYCDlm5vnp43vvIzliKvnmoTnsbvlnovlnKggYHNhdmVJbWFnZXNgIOmHjFxuICogICAg55u05o6l6KKr5ouS77yIYFVOU1VQUE9SVEVEX0lNQUdFX1RZUEVg77yJ44CC5omA5Lul5omp5bGV5ZCNIOKGkiBNSU1FIOeahOaYoOWwhOW/hemhu+aYr+S4gOS7ve+8m1xuICogMi4gKirkuIrpmZAqKu+8muWNleW8oCAyME1CIC8g5Y2V5p2h5raI5oGvIDIwIOW8oCAvIOWQiOiuoSAyMDBNQu+8iOS4jiBgZHNoLWF0dGFjaG1lbnQtbG9jYWxgIOeahFxuICogICAgYENvbmZpZ2Ag6buY6K6k5YC85ZCM5Y+j5b6E77yJ44CC6LaF5LqG6KaB5ZyoKirpnaLmnb/kuIoqKuWwseivtOa4healmu+8jOWIq+iuqeeUqOaIt+etieS4gOi9ruaJjeWPkeeOsOWbvuayoeS4iuWOu++8m1xuICogMy4gKipiYXNlNjQg5b+F6aG75piv44CM6KeE6IyD5b2i5byP44CNKirvvJrpmYTku7blupPnmoTop6PnoIHlmajopoHmsYJcbiAqICAgIGBCdWZmZXIuZnJvbShkYXRhLCdiYXNlNjQnKS50b1N0cmluZygnYmFzZTY0JykgPT09IGRhdGFg77yIYElOVkFMSURfSU1BR0VfQkFTRTY0YO+8ieKAlOKAlFxuICogICAg5bim5o2i6KGM44CB5bim56m65qC844CB5bimIGBkYXRhOmAg5YmN57yA55qE5LiA5b6L5ouS57ud44CC5omA5Lul5Zyo6L+bIElQQyDkuYvliY3lsLHlvZLkuIDljJbkuIDmrKHjgIJcbiAqXG4gKiDov5nkuKrmqKHlnZcqKuS4jeeisCBgRWRpdG9yYCoq77yI57qvIGZzICsgcGF0aO+8ie+8jOaJgOS7pSBgc2NyaXB0cy92ZXJpZnktaW1hZ2VzLmpzYCDog73mi7/kuIDkuKrkuLTml7ZcbiAqIOebruW9leaKiuaVtOadoeivu+WPli/moKHpqozpgLvovpHnnJ/ot5HkuIDpgY0g4oCU4oCUIOS4jeeUqOW8gOe8lui+keWZqOOAglxuICpcbiAqICMjIOOAjOW3peeoi+mHjOeahOWbvueJh+OAjeS4uuS7gOS5iOacieS4pOWll+i3r1xuICpcbiAqIOS4u+i3r+aYr+i1hOa6kOW6k++8iGBhc3NldC1kYmAg55qEIGBxdWVyeS1hc3NldHNg77yJ77ya5a6D5piv57yW6L6R5Zmo6YeMKirnlKjmiLfnnJ/nnIvlvpfop4EqKueahOmCo+S7veS6i+Wunu+8jFxuICog6L+Y6aG65bim57uZ5Ye6IGBkYjovL2Fzc2V0cy8uLi5gIOi/meS4quWPr+ivuyBVUkwg5LiOIHV1aWTjgILlhZzlupXmmK/nm7TmjqXmiasgYGFzc2V0cy9gIOebruW9le+8mui1hOa6kOW6k1xuICog5p+l6K+i5piv5YaF572u5omp5bGV55qE5raI5oGv77yM5Y+v6IO95Zug5Li654mI5pys5beu5byC44CB5pWw5o2u5bqT5rKh5bCx57uq44CBcGF0dGVybiDor63kuYnlj5jljJbogIzov5Tlm57nqbpcbiAqIOKAlOKAlCDpgqPml7bjgIzkuIDlvKDlm77pg73pgInkuI3kuobjgI3mmK/lvojns5/nmoTkvZPpqozvvIzogIznm67lvZXmiavmj4/msLjov5zog73nlKjjgIJcbiAqIOS4pOWll+e7k+aenOaMiSoq57ud5a+56Lev5b6EKirljrvph43lkIjlubbvvIjop4EgYG1lcmdlUHJvamVjdEltYWdlc2DvvInjgIJcbiAqXG4gKiBAbW9kdWxlIGRzaF9jaGF0L2ltYWdlc1xuICovXG5cbmltcG9ydCB7IHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSAnZnMnO1xuaW1wb3J0IHsgZXh0bmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gJ3BhdGgnO1xuXG4vKiogRFNIIOmZhOS7tuW6k+aOpeWPl+eahOWbm+enjeagheagvOWbvu+8iOWkmuS4gOenjemDvei/h+S4jeS6hiBgdmFsaWRhdGVJbWFnZUJhdGNoYO+8ieOAgiAqL1xuZXhwb3J0IHR5cGUgSW1hZ2VNaW1lVHlwZSA9ICdpbWFnZS9wbmcnIHwgJ2ltYWdlL2pwZWcnIHwgJ2ltYWdlL3dlYnAnIHwgJ2ltYWdlL2dpZic7XG5cbi8qKiDmianlsZXlkI0g4oaSIE1JTUXjgILplK7kuIDlvovmmK8qKuWwj+WGmeOAgeW4pueCuSoq55qE5b2i5byP77yIYGV4dG5hbWUoKWAg55qE6L+U5Zue5YC877yJ44CCICovXG5leHBvcnQgY29uc3QgSU1BR0VfTUlNRV9CWV9FWFQ6IFJlY29yZDxzdHJpbmcsIEltYWdlTWltZVR5cGU+ID0ge1xuICAgICcucG5nJzogJ2ltYWdlL3BuZycsXG4gICAgJy5qcGcnOiAnaW1hZ2UvanBlZycsXG4gICAgJy5qcGVnJzogJ2ltYWdlL2pwZWcnLFxuICAgICcud2VicCc6ICdpbWFnZS93ZWJwJyxcbiAgICAnLmdpZic6ICdpbWFnZS9naWYnLFxufTtcblxuLyoqIOiupOW+l+eahOWbvueJh+aJqeWxleWQje+8iOmdouadv+eahOetm+mAieOAgeebruW9leaJq+aPj+WFseeUqO+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IElNQUdFX0VYVEVOU0lPTlM6IHN0cmluZ1tdID0gT2JqZWN0LmtleXMoSU1BR0VfTUlNRV9CWV9FWFQpO1xuXG4vKiog5LiA5p2h5raI5oGv6YeM5pyA5aSa5Yeg5byg77yI5a+56b2QIGBkc2gtYXR0YWNobWVudC1sb2NhbGAg55qEIGBtYXhJbWFnZXNQZXJNZXNzYWdlYCDpu5jorqTlgLzvvInjgIIgKi9cbmV4cG9ydCBjb25zdCBNQVhfSU1BR0VTX1BFUl9NRVNTQUdFID0gMjA7XG5cbi8qKiDljZXlvKDlm77nmoTlrZfoioLkuIrpmZDvvIhgbWF4SW1hZ2VCeXRlc2Ag6buY6K6kIDIwTULvvInigJTigJTotoXkuobmmK8qKuaLkuaUtioq77yM5LiN5piv5Y6L57yp44CCICovXG5leHBvcnQgY29uc3QgTUFYX0lNQUdFX0JZVEVTID0gMjAgKiAxMDI0ICogMTAyNDtcblxuLyoqIOS4gOadoea2iOaBr+mHjOaJgOacieWbvueahOWQiOiuoeWtl+iKguS4iumZkO+8iGBtYXhNZXNzYWdlSW1hZ2VCeXRlc2Ag6buY6K6kIDIwME1C77yJ44CCICovXG5leHBvcnQgY29uc3QgTUFYX01FU1NBR0VfSU1BR0VfQllURVMgPSAyMDAgKiAxMDI0ICogMTAyNDtcblxuLyoqIOWIl+W3peeoi+WbvueJh+aXtueahOadoeaVsOS4iumZkO+8iOmdouadv+aYryBET00g5YiX6KGo77yM5LiN6K6+5LiK6ZmQ5Lya5Y2h77yJ44CCICovXG5leHBvcnQgY29uc3QgTUFYX0xJU1RFRF9JTUFHRVMgPSA4MDA7XG5cbi8qKiDnm67lvZXmiavmj4/nmoTmt7HluqbkuIrpmZDvvIjpmLLnrKblj7fpk77mjqXmiJDnjq8gLyDmgZDmgJbnm67lvZXvvInjgIIgKi9cbmV4cG9ydCBjb25zdCBNQVhfU0NBTl9ERVBUSCA9IDEyO1xuXG4vKiog5LiA5p2h44CM5bel56iL6YeM55qE5Zu+54mH44CN5ZyoIElQQyDkuIrnmoTlvaLnirbjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJvamVjdEltYWdlIHtcbiAgICAvKiog6LWE5rqQ5bqTIFVSTO+8iGBkYjovL2Fzc2V0cy8uLi5g77yJ77yb55uu5b2V5omr5o+P5YWc5bqV5pe255Sx6Lev5b6E5Y+N5o6o77yM5ou/5LiN5Yiw5bCx5piv56m65Liy44CCICovXG4gICAgdXJsOiBzdHJpbmc7XG4gICAgLyoqIOe7neWvuei3r+W+hOOAgioq6L+Z5piv5Li76ZSuKirvvJrkuKTlpZfot6/nmoTnu5PmnpzmjInlroPljrvph43jgIIgKi9cbiAgICBwYXRoOiBzdHJpbmc7XG4gICAgLyoqIOaYvuekuuWQje+8iOS4gOiIrOWwseaYr+aWh+S7tuWQje+8ieOAgiAqL1xuICAgIG5hbWU6IHN0cmluZztcbiAgICAvKiog6LWE5rqQIHV1aWTvvIjlj6rmnInotYTmupDlupPpgqPmnaHot6/mnInvvInjgIIgKi9cbiAgICB1dWlkPzogc3RyaW5nO1xuICAgIC8qKiDlrZfoioLmlbDvvIjmi7/kuI3liLAgc3RhdCDml7bkuLogdW5kZWZpbmVk77yJ44CCICovXG4gICAgYnl0ZXM/OiBudW1iZXI7XG4gICAgLyoqIOi1hOa6kOacgOWQjuS/ruaUueaXtumXtO+8iOWPquaciei1hOa6kOW6k+mCo+adoei3r+e7meW+l+WHuu+8m+aOkuW6jy/mjpLmn6XnlKjvvInjgIIgKi9cbiAgICBtdGltZT86IG51bWJlcjtcbiAgICAvKiog5bGV56S655So77ya55u45a+55bel56iL5qC555qE6Lev5b6E77yM55SoIGAvYCDliIbpmpTjgIIgKi9cbiAgICByZWw6IHN0cmluZztcbiAgICAvKiog6L+Z5p2h5piv5LuO5ZOq5p2l55qE77yI5o6S5p+l55So77ya44CM6LWE5rqQ5bqT5oCO5LmI5bCR5LqG5Yeg5byg44CN5pe25YWI55yL5a6D77yJ44CCICovXG4gICAgc291cmNlOiAnYXNzZXQtZGInIHwgJ3NjYW4nO1xufVxuXG4vKiog6K+75Y+W5LiA5byg5Zu+54mH55qE5Zue5omn44CCICovXG5leHBvcnQgdHlwZSBSZWFkSW1hZ2VSZXN1bHQgPVxuICAgIHwge1xuICAgICAgICAgIG9rOiB0cnVlO1xuICAgICAgICAgIC8qKiDmmL7npLrlkI3jgIIgKi9cbiAgICAgICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICAgICAgLyoqIOe7neWvuei3r+W+hOOAgiAqL1xuICAgICAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgICAgICAvKiogYGRiOi8vYCBVUkzvvIjot6/lvoTkuI3lnKjotYTmupDlupPmmKDlsITojIPlm7TlhoXml7bkuLrnqbrkuLLvvInjgIIgKi9cbiAgICAgICAgICB1cmw6IHN0cmluZztcbiAgICAgICAgICAvKiog5aOw5piO57uZ6ZmE5Lu25bqT55qEIE1JTUXvvIjnlLHmianlsZXlkI3mjqjlh7rvvIzpmYTku7blupPkvJrmi7/lrZfoioLlho3pqozkuIDpgY3vvInjgIIgKi9cbiAgICAgICAgICBtaW1lVHlwZTogSW1hZ2VNaW1lVHlwZTtcbiAgICAgICAgICAvKiog5a2X6IqC5pWw44CCICovXG4gICAgICAgICAgYnl0ZXM6IG51bWJlcjtcbiAgICAgICAgICAvKiogKirop4TojIMqKiBiYXNlNjTvvIjkuI3luKYgYGRhdGE6YCDliY3nvIDvvIzml6DmjaLooYzvvInjgIIgKi9cbiAgICAgICAgICBkYXRhOiBzdHJpbmc7XG4gICAgICB9XG4gICAgfCB7IG9rOiBmYWxzZTsgZXJyb3I6IHN0cmluZyB9O1xuXG4vKiogYGV4dG5hbWVgIOe7k+aenOeahOWwj+WGmeW9ouW8j++8iGAuYCDlvIDlpLTvvJvmsqHmnInmianlsZXlkI3ml7bmmK/nqbrkuLLvvInjgIIgKi9cbmZ1bmN0aW9uIGV4dE9mKGZpbGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGV4dG5hbWUoZmlsZSkudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqXG4gKiDot6/lvoQg4oaSIE1JTUXvvJvkuI3mmK/orqTlvpfnmoTlm77niYfliJnov5Tlm54gbnVsbOOAglxuICpcbiAqIEBwYXJhbSBmaWxlIC0g5paH5Lu25ZCN5oiW57ud5a+56Lev5b6E77yI5Y+q55yL5omp5bGV5ZCN77yJ44CCXG4gKiBAcmV0dXJucyBNSU1FIOaIliBudWxs44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtaW1lT2ZJbWFnZVBhdGgoZmlsZTogc3RyaW5nKTogSW1hZ2VNaW1lVHlwZSB8IG51bGwge1xuICAgIHJldHVybiBJTUFHRV9NSU1FX0JZX0VYVFtleHRPZihmaWxlKV0gPz8gbnVsbDtcbn1cblxuLyoqIOaJqeWxleWQjeaYr+S4jeaYr+iupOW+l+eahOWbvueJh+OAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW1hZ2VQYXRoKGZpbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBtaW1lT2ZJbWFnZVBhdGgoZmlsZSkgIT09IG51bGw7XG59XG5cbi8qKlxuICogYGRiOi8vYXNzZXRzL2Zvby9iYXIucG5nYCDihpIgYDzlt6XnqIvmoLk+L2Fzc2V0cy9mb28vYmFyLnBuZ2DjgIJcbiAqXG4gKiDlj6rorqQgYGRiOi8vYXNzZXRzL2Ag5LiOIGBkYjovL2ludGVybmFsL2Ag5Lik5Liq5oyC6L2954K577yI57yW6L6R5Zmo6YeM5Y+q5pyJ6L+Z5Lik5Liq56iz5a6a5a2Y5Zyo77yJ77yMXG4gKiDlhbbkvZnvvIjnlKjmiLfoh6rlu7rnmoQgZGIg5oyC6L2977yJ6L+U5ZueIG51bGwg4oCU4oCUIOWugeWPr+S4jeaYvuekuu+8jOS5n+S4jeimgeaLvOWHuuS4gOS4qumUmei3r+W+hOWOu+ivu+ebmOOAglxuICpcbiAqIOKaoCDotYTmupDlupPnmoQqKuWtkOi1hOa6kCoq77yI5aaCIGBkYjovL2Fzc2V0cy9hLnBuZy9zcHJpdGVGcmFtZWDvvInkuZ/kvJrotbDov5nkuKrlh73mlbDvvIxcbiAqIOWug+aLvOWHuuadpeeahOaYr+S4gOS4quS4jeWtmOWcqOeahOi3r+W+hCDigJTigJQg6LCD55So5pa55oyJ44CM5omp5bGV5ZCN5b+F6aG75q2j5aW95piv5Zu+54mH5ZCO57yA44CN6L+H5ruk5o6J5a6D5LusXG4gKiDvvIjop4EgYHVybExvb2tzTGlrZUltYWdlYO+8ie+8jOWIq+WcqOi/memHjOeMnOOAglxuICpcbiAqIEBwYXJhbSBwcm9qZWN0UGF0aCAtIOW3peeoi+ague+8iGBFZGl0b3IuUHJvamVjdC5wYXRoYO+8ieOAglxuICogQHBhcmFtIHVybCAtIGBkYjovL2Ag5byA5aS055qE6LWE5rqQIFVSTOOAglxuICogQHJldHVybnMg57ud5a+56Lev5b6E5oiWIG51bGzjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRiVXJsVG9QYXRoKHByb2plY3RQYXRoOiBzdHJpbmcsIHVybDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgbWF0Y2ggPSAvXmRiOlxcL1xcLyhbXi9dKylcXC8oLispJC8uZXhlYyh1cmwudHJpbSgpKTtcbiAgICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBbLCBtb3VudCwgcmVzdF0gPSBtYXRjaDtcbiAgICBpZiAobW91bnQgIT09ICdhc3NldHMnICYmIG1vdW50ICE9PSAnaW50ZXJuYWwnKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gam9pbihyZXNvbHZlKHByb2plY3RQYXRoKSwgbW91bnQsIC4uLnJlc3Quc3BsaXQoJy8nKSk7XG59XG5cbi8qKlxuICog57ud5a+56Lev5b6EIOKGkiBgZGI6Ly9hc3NldHMvLi4uYO+8iOWPjeWQkeaYoOWwhO+8ieOAglxuICpcbiAqIEBwYXJhbSBwcm9qZWN0UGF0aCAtIOW3peeoi+agueOAglxuICogQHBhcmFtIGZpbGUgLSDnu53lr7not6/lvoTjgIJcbiAqIEByZXR1cm5zIGBkYjovL2AgVVJM77yM5oiW56m65Liy77yI6Lev5b6E5LiN5ZyoIGFzc2V0cy9pbnRlcm5hbCDkuIvvvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhdGhUb0RiVXJsKHByb2plY3RQYXRoOiBzdHJpbmcsIGZpbGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgcm9vdCA9IHJlc29sdmUocHJvamVjdFBhdGgpO1xuICAgIGNvbnN0IHRhcmdldCA9IHJlc29sdmUoZmlsZSk7XG4gICAgZm9yIChjb25zdCBtb3VudCBvZiBbJ2Fzc2V0cycsICdpbnRlcm5hbCddIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGJhc2UgPSBqb2luKHJvb3QsIG1vdW50KTtcbiAgICAgICAgaWYgKHRhcmdldCA9PT0gYmFzZSkgY29udGludWU7XG4gICAgICAgIGlmICh0YXJnZXQuc3RhcnRzV2l0aChiYXNlICsgc2VwKSkge1xuICAgICAgICAgICAgY29uc3QgcmVzdCA9IHJlbGF0aXZlKGJhc2UsIHRhcmdldCkuc3BsaXQoc2VwKS5qb2luKCcvJyk7XG4gICAgICAgICAgICByZXR1cm4gYGRiOi8vJHttb3VudH0vJHtyZXN0fWA7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG4vKiog6L+Z5LiqIGBkYjovL2AgVVJMIOeci+edgOWwseaYr+S4gOW8oOWbvuacrOS9k++8iOS4jeaYryBgL3Nwcml0ZUZyYW1lYCDpgqPnp43lrZDotYTmupDvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiB1cmxMb29rc0xpa2VJbWFnZSh1cmw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc0ltYWdlUGF0aCh1cmwpO1xufVxuXG4vKipcbiAqIOaJq+S4gOS4quebruW9leS4i+eahOaJgOacieWbvueJh+aWh+S7tu+8iCoq5YWc5bqV6LevKirvvIzotYTmupDlupPmn6Xor6Lmi7/kuI3liLDkuJzopb/ml7bnlKjvvInjgIJcbiAqXG4gKiDlj6rorqTlm77niYfmianlsZXlkI3vvJvot7Pov4cgYC5gIOW8gOWktOeahOebruW9le+8iGAuZ2l0YCAvIGAudG1wYCDov5nnsbvvvInkuI4gYGxpYnJhcnlgL2B0ZW1wYFxuICog77yI5a6D5Lus5LiN5ZyoIGBhc3NldHMvYCDkuIvvvIzkvYblt6XnqIvmoLnooqvor6/kvKDov5vmnaXml7bkuZ/mi6bkuIDkuIvvvInjgIJcbiAqXG4gKiBAcGFyYW0gcm9vdCAtIOi1t+Wni+ebruW9le+8iOS4gOiIrOaYryBgPOW3peeoi+aguT4vYXNzZXRzYO+8ieOAglxuICogQHBhcmFtIGxpbWl0IC0g5p2h5pWw5LiK6ZmQ44CCXG4gKiBAcmV0dXJucyDmlofku7bmuIXljZXvvIjnu53lr7not6/lvoQgKyDnm7jlr7not6/lvoQgKyDlrZfoioLmlbDvvInvvIzmjInot6/lvoTmjpLluo/jgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5JbWFnZUZpbGVzKHJvb3Q6IHN0cmluZywgbGltaXQgPSBNQVhfTElTVEVEX0lNQUdFUyk6IEFycmF5PHsgcGF0aDogc3RyaW5nOyByZWw6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH0+IHtcbiAgICBjb25zdCBvdXQ6IEFycmF5PHsgcGF0aDogc3RyaW5nOyByZWw6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH0+ID0gW107XG4gICAgY29uc3QgYmFzZSA9IHJlc29sdmUocm9vdCk7XG5cbiAgICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nLCBkZXB0aDogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICAgIGlmIChkZXB0aCA+IE1BWF9TQ0FOX0RFUFRIIHx8IG91dC5sZW5ndGggPj0gbGltaXQpIHJldHVybjtcbiAgICAgICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm47IC8vIOayoeadg+mZkC/kuI3lrZjlnKjvvJrot7Pov4fov5nkuIDmlK/vvIzkuI3miZPmlq3mlbTmrKHmiavmj49cbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgICAgICAgIGlmIChvdXQubGVuZ3RoID49IGxpbWl0KSByZXR1cm47XG4gICAgICAgICAgICBpZiAobmFtZS5zdGFydHNXaXRoKCcuJykpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgICAgICAgbGV0IHN0YXQ7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHN0YXQgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoc3RhdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgICAgICAgICAgd2FsayhhYnMsIGRlcHRoICsgMSk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXN0YXQuaXNGaWxlKCkgfHwgIWlzSW1hZ2VQYXRoKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IHJlbCA9IHJlbGF0aXZlKGJhc2UsIGFicykuc3BsaXQoc2VwKS5qb2luKCcvJyk7XG4gICAgICAgICAgICBvdXQucHVzaCh7IHBhdGg6IGFicywgcmVsLCBuYW1lLCBieXRlczogc3RhdC5zaXplIH0pO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHdhbGsoYmFzZSwgMCk7XG4gICAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5yZWwgPCBiLnJlbCA/IC0xIDogYS5yZWwgPiBiLnJlbCA/IDEgOiAwKSk7XG59XG5cbi8qKlxuICog5Lik5aWX6Lev55qE57uT5p6c5ZCI5bm277yaKirmjInnu53lr7not6/lvoTljrvph40qKu+8jOS4u+i3r++8iOi1hOa6kOW6k++8ieS8mOWFiOOAglxuICpcbiAqIEBwYXJhbSBwcmltYXJ5IC0g6LWE5rqQ5bqT5p+l5Yiw55qE77yI5Y+v56m677yJ44CCXG4gKiBAcGFyYW0gZmFsbGJhY2sgLSDnm67lvZXmiavmj4/liLDnmoTvvIjlj6/nqbrvvInjgIJcbiAqIEBwYXJhbSBsaW1pdCAtIOaAu+adoeaVsOS4iumZkOOAglxuICogQHJldHVybnMg5ZCI5bm25ZCO55qE5riF5Y2V44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVByb2plY3RJbWFnZXMoXG4gICAgcHJpbWFyeTogUHJvamVjdEltYWdlW10gfCB1bmRlZmluZWQsXG4gICAgZmFsbGJhY2s6IFByb2plY3RJbWFnZVtdIHwgdW5kZWZpbmVkLFxuICAgIGxpbWl0ID0gTUFYX0xJU1RFRF9JTUFHRVMsXG4pOiBQcm9qZWN0SW1hZ2VbXSB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGNvbnN0IG91dDogUHJvamVjdEltYWdlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgWy4uLihwcmltYXJ5ID8/IFtdKSwgLi4uKGZhbGxiYWNrID8/IFtdKV0pIHtcbiAgICAgICAgLy8gV2luZG93cyDnm5jnrKblpKflsI/lhpnjgIFgL2AgYFxcYCDmt7fnlKjpg73kvJrorqnlkIzkuIDkuKrmlofku7blj5jmiJDkuKTmnaEg4oCU4oCUIOe7n+S4gOaIkOWwj+WGmeeahOinhOiMg+i3r+W+hFxuICAgICAgICBjb25zdCBrZXkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gcmVzb2x2ZShpdGVtLnBhdGgpLnRvTG93ZXJDYXNlKCkgOiByZXNvbHZlKGl0ZW0ucGF0aCk7XG4gICAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgc2Vlbi5hZGQoa2V5KTtcbiAgICAgICAgb3V0LnB1c2goaXRlbSk7XG4gICAgICAgIGlmIChvdXQubGVuZ3RoID49IGxpbWl0KSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5yZWwgPCBiLnJlbCA/IC0xIDogYS5yZWwgPiBiLnJlbCA/IDEgOiAwKSk7XG59XG5cbi8qKlxuICog5oqKIGBhc3NldC1kYmAg55qEIGBxdWVyeS1hc3NldHNgIOe7k+aenOaKleW9seaIkCBgUHJvamVjdEltYWdlW11g44CCXG4gKlxuICog5LiJ6YGT6L+H5ruk77yM57y65LiA5p2h5bCx5Lya5Zyo6Z2i5p2/5LiK5Ye6546w44CM54K55LqG6K+75LiN5Ye65p2l44CN55qE6aG577yaXG4gKlxuICogMS4gKirlj6rmlLYgYGRiOi8vYXNzZXRzL2AqKu+8mmBkYjovL2ludGVybmFsLy4uLmAg5piv5byV5pOO6Ieq5bim55qE6LWE5rqQ77yM5a6D5pig5bCE5Yiw57yW6L6R5Zmo5a6J6KOF55uu5b2VXG4gKiAgICDogIzkuI3mmK/lt6XnqIvnm67lvZXvvIjmnKzmianlsZXnmoQgYHJlYWQtaW1hZ2VgIOWPquivu+W3peeoi+WGheeahOaWh+S7tu+8jOS8muaLkue7ne+8ie+8jOWIl+WHuuadpeWPquS8muivr+WvvOS6uu+8m1xuICogMi4gKipVUkwg55qE5omp5bGV5ZCN5b+F6aG75q2j5aW95piv5Zu+54mH5ZCO57yAKirvvJrotYTmupDlupPov5jkvJrov5Tlm57lrZDotYTmupDvvIzmr5TlpoJcbiAqICAgIGBkYjovL2Fzc2V0cy9hLnBuZy9zcHJpdGVGcmFtZWAg4oCU4oCUIOWug+aLvOWHuuadpeaYr+S4quS4jeWtmOWcqOeahOi3r+W+hO+8m1xuICogMy4g5ou85LiN5Ye657ud5a+56Lev5b6E55qE77yI5pyq55+l5oyC6L2954K577yJ55u05o6l6Lez6L+H44CCXG4gKlxuICogQHBhcmFtIHJvd3MgLSBgcXVlcnktYXNzZXRzYCDnmoTov5Tlm57vvIjlvaLnirbkuI3kv53or4HvvIzpgJDlrZfmrrXlj5bvvInjgIJcbiAqIEBwYXJhbSBwcm9qZWN0UGF0aCAtIOW3peeoi+agueOAglxuICogQHJldHVybnMg5oqV5b2x5ZCO55qE5riF5Y2V44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0SW1hZ2VzRnJvbUFzc2V0RGIocm93czogdW5rbm93biwgcHJvamVjdFBhdGg6IHN0cmluZyk6IFByb2plY3RJbWFnZVtdIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocm93cykpIHJldHVybiBbXTtcbiAgICBjb25zdCBvdXQ6IFByb2plY3RJbWFnZVtdID0gW107XG4gICAgZm9yIChjb25zdCByYXcgb2Ygcm93cykge1xuICAgICAgICBpZiAoIXJhdyB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0JykgY29udGludWU7XG4gICAgICAgIGNvbnN0IHJvdyA9IHJhdyBhcyB7IHVybD86IHVua25vd247IG5hbWU/OiB1bmtub3duOyBkaXNwbGF5TmFtZT86IHVua25vd247IHV1aWQ/OiB1bmtub3duOyBmaWxlPzogdW5rbm93bjsgbXRpbWU/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHVybCA9IHR5cGVvZiByb3cudXJsID09PSAnc3RyaW5nJyA/IHJvdy51cmwgOiAnJztcbiAgICAgICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly9hc3NldHMvJykpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoIXVybExvb2tzTGlrZUltYWdlKHVybCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBmaWxlID0gdHlwZW9mIHJvdy5maWxlID09PSAnc3RyaW5nJyAmJiByb3cuZmlsZSA/IHJvdy5maWxlIDogZGJVcmxUb1BhdGgocHJvamVjdFBhdGgsIHVybCk7XG4gICAgICAgIGlmICghZmlsZSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRpc3BsYXkgPVxuICAgICAgICAgICAgKHR5cGVvZiByb3cuZGlzcGxheU5hbWUgPT09ICdzdHJpbmcnICYmIHJvdy5kaXNwbGF5TmFtZSkgfHwgKHR5cGVvZiByb3cubmFtZSA9PT0gJ3N0cmluZycgJiYgcm93Lm5hbWUpIHx8ICcnO1xuICAgICAgICBvdXQucHVzaCh7XG4gICAgICAgICAgICB1cmwsXG4gICAgICAgICAgICBwYXRoOiBmaWxlLFxuICAgICAgICAgICAgbmFtZTogZGlzcGxheSB8fCB1cmwuc3BsaXQoJy8nKS5wb3AoKSB8fCBmaWxlLFxuICAgICAgICAgICAgdXVpZDogdHlwZW9mIHJvdy51dWlkID09PSAnc3RyaW5nJyA/IHJvdy51dWlkIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgbXRpbWU6IHR5cGVvZiByb3cubXRpbWUgPT09ICdudW1iZXInID8gcm93Lm10aW1lIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgcmVsOiB1cmwucmVwbGFjZSgvXmRiOlxcL1xcLy8sICcnKSxcbiAgICAgICAgICAgIHNvdXJjZTogJ2Fzc2V0LWRiJyxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDpnaLmnb/kuIrnmoTmkJzntKLvvJrmjInlkI3lrZcv6Lev5b6EL3VybCDlgZrkuI3ljLrliIblpKflsI/lhpnnmoTlrZDkuLLljLnphY3vvIjnqbrmn6Xor6IgPSDlhajmlL7ooYzvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJQcm9qZWN0SW1hZ2VzKGltYWdlczogUHJvamVjdEltYWdlW10sIHF1ZXJ5OiBzdHJpbmcpOiBQcm9qZWN0SW1hZ2VbXSB7XG4gICAgY29uc3QgbmVlZGxlID0gU3RyaW5nKHF1ZXJ5ID8/ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIW5lZWRsZSkgcmV0dXJuIGltYWdlcztcbiAgICBjb25zdCB0ZXJtcyA9IG5lZWRsZS5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgICByZXR1cm4gaW1hZ2VzLmZpbHRlcigoaW1hZ2UpID0+IHtcbiAgICAgICAgY29uc3QgaGF5c3RhY2sgPSBgJHtpbWFnZS5uYW1lfSAke2ltYWdlLnJlbH0gJHtpbWFnZS51cmx9YC50b0xvd2VyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gdGVybXMuZXZlcnkoKHRlcm0pID0+IGhheXN0YWNrLmluY2x1ZGVzKHRlcm0pKTtcbiAgICB9KTtcbn1cblxuLyoqXG4gKiDor7vkuIDlvKDlm77lubbnvJbnoIHmiJAqKuinhOiMgyBiYXNlNjQqKuOAglxuICpcbiAqIOS4iemBk+WFs+mDveaYr+W/hemhu+eahO+8mioq5aSn5bCPKirvvIgyME1CIOS4iumZkO+8jOi2heS6humZhOS7tuW6k+aLkuaUtu+8ieOAgSoq57G75Z6LKirvvIjnmb3lkI3ljZXlm5vnp43vvInjgIFcbiAqICoq6KeE6IyDIGJhc2U2NCoq77yI5o2i6KGML+epuuagvC9gZGF0YTpgIOWJjee8gOmDveS8muiuqemZhOS7tuW6k+aKpSBgSU5WQUxJRF9JTUFHRV9CQVNFNjRg77yJ44CCXG4gKlxuICogQHBhcmFtIGZpbGUgLSDnu53lr7not6/lvoTjgIJcbiAqIEBwYXJhbSBvcHRpb25zIC0gYHtwcm9qZWN0UGF0aH1gIOeUqOadpemhuuW4pue7meWHuiBgZGI6Ly9gIFVSTO+8m2B7bWF4Qnl0ZXN9YCDopobnm5bkuIrpmZDjgIJcbiAqIEByZXR1cm5zIOWbnuaJp++8iOWksei0pSoq5LiN5oqbKirvvIzmiorljp/lm6DlhpnmiJDkurror53vvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRJbWFnZUZpbGUoZmlsZTogc3RyaW5nLCBvcHRpb25zOiB7IHByb2plY3RQYXRoPzogc3RyaW5nOyBtYXhCeXRlcz86IG51bWJlciB9ID0ge30pOiBSZWFkSW1hZ2VSZXN1bHQge1xuICAgIGNvbnN0IG1heEJ5dGVzID0gb3B0aW9ucy5tYXhCeXRlcyA/PyBNQVhfSU1BR0VfQllURVM7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShmaWxlKTtcbiAgICBjb25zdCBtaW1lVHlwZSA9IG1pbWVPZkltYWdlUGF0aChhYnMpO1xuICAgIGlmICghbWltZVR5cGUpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOS4jeaYr+iupOW+l+eahOWbvueJh+agvOW8j++8iOWPquaUtiAke0lNQUdFX0VYVEVOU0lPTlMuam9pbignIC8gJyl977yJ77yaJHthYnN9YCB9O1xuICAgIH1cbiAgICBsZXQgc2l6ZTogbnVtYmVyO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHN0YXQgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgICBpZiAoIXN0YXQuaXNGaWxlKCkpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDkuI3mmK/mlofku7bvvJoke2Fic31gIH07XG4gICAgICAgIHNpemUgPSBzdGF0LnNpemU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOivu+S4jeWIsOi/meS4quaWh+S7tu+8iCR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3Ipfe+8ie+8miR7YWJzfWAgfTtcbiAgICB9XG4gICAgaWYgKHNpemUgPiBtYXhCeXRlcykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGDov5nlvKDlm74gJHtmb3JtYXRCeXRlcyhzaXplKX3vvIzotoXov4fljZXlvKDkuIrpmZAgJHtmb3JtYXRCeXRlcyhtYXhCeXRlcyl977yIRFNIIOmZhOS7tuW6k+aYr+aLkuaUtuiAjOS4jeaYr+WOi+e8qe+8jOivt+WFiOiHquW3seWOi+S4gOS4i++8ieOAgmAsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIOinhOiMgyBiYXNlNjTvvJpgdG9TdHJpbmcoJ2Jhc2U2NCcpYCDkuI3mjaLooYzjgIHml6DnqbrmoLzvvIzmraPmmK/pmYTku7blupPopoHnmoTlvaLlvI/vvIjliKvlho3miYvlt6Xmi7wgZGF0YTog5YmN57yA77yJXG4gICAgICAgIGNvbnN0IGRhdGEgPSByZWFkRmlsZVN5bmMoYWJzKS50b1N0cmluZygnYmFzZTY0Jyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIG5hbWU6IGFicy5zcGxpdChzZXApLnBvcCgpID8/IGFicyxcbiAgICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICAgIHVybDogb3B0aW9ucy5wcm9qZWN0UGF0aCA/IHBhdGhUb0RiVXJsKG9wdGlvbnMucHJvamVjdFBhdGgsIGFicykgOiAnJyxcbiAgICAgICAgICAgIG1pbWVUeXBlLFxuICAgICAgICAgICAgYnl0ZXM6IHNpemUsXG4gICAgICAgICAgICBkYXRhLFxuICAgICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDor7vmlofku7blpLHotKXvvIgke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX3vvInvvJoke2Fic31gIH07XG4gICAgfVxufVxuXG4vKiog6Z2i5p2/5Lyg5LiK5p2l55qE5b6F5Y+R6YCB5Zu+54mH77yI5qCh6aqM5YmN55qE5b2i54q277yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIEluY29taW5nSW1hZ2Uge1xuICAgIG1pbWVUeXBlPzogdW5rbm93bjtcbiAgICBkYXRhPzogdW5rbm93bjtcbiAgICBuYW1lPzogdW5rbm93bjtcbiAgICBieXRlcz86IHVua25vd247XG59XG5cbi8qKiDmoKHpqozpgJrov4flkI7nmoTlm77niYfvvIjlj6/ku6Xnm7TmjqXloZ7ov5sgU0RLIOeahCBjb250ZW50QmxvY2tz77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIFZhbGlkSW1hZ2Uge1xuICAgIG1pbWVUeXBlOiBJbWFnZU1pbWVUeXBlO1xuICAgIC8qKiDop4TojIMgYmFzZTY044CCICovXG4gICAgZGF0YTogc3RyaW5nO1xuICAgIC8qKiDop6PnoIHlkI7nmoTlrZfoioLmlbDvvIjpmYTku7blupPkvJrlho3pqozkuIDpgY3vvInjgIIgKi9cbiAgICBieXRlczogbnVtYmVyO1xuICAgIG5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKiDmoKHpqozlm57miafjgIIgKi9cbmV4cG9ydCB0eXBlIFZhbGlkYXRlUmVzdWx0ID0geyBvazogdHJ1ZTsgaW1hZ2VzOiBWYWxpZEltYWdlW10gfSB8IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nIH07XG5cbi8qKiDorqTlvpfnmoQgTUlNRSDpm4blkIjvvIhgdmFsaWRhdGVJbWFnZUJhdGNoYCDnlKjvvInjgIIgKi9cbmNvbnN0IEFDQ0VQVEVEX01JTUUgPSBuZXcgU2V0PHN0cmluZz4oT2JqZWN0LnZhbHVlcyhJTUFHRV9NSU1FX0JZX0VYVCkpO1xuXG4vKipcbiAqIOagoemqjOS4gOaJueW+heWPkemAgeeahOWbvueJh+OAglxuICpcbiAqICoq5Zyo5omp5bGV6L+Z5LiA5L6n5YaN6aqM5LiA6YGNKirvvIjpnaLmnb/lt7Lnu4/pqozov4fkuIDmrKHvvInvvJrpnaLmnb/mmK/muLLmn5Pov5vnqIvvvIzlroPor7TnmoTku7vkvZXlhoXlrrnpg73kuI3lj6/kv6FcbiAqIOKAlOKAlOi/meaYryBgcGFuZWxQcm9iZWAg6YKj5p2h5rOo6YeK6YeM55qE5ZCM5LiA5p2h5Y+j5b6E44CC6ICM5LiU6L+Z5LiA5q2l6IO95oqK44CM6LaF6ZmQ44CN5Y+Y5oiQ5LiA5Y+l5Lq66K+d5Zue57uZ6Z2i5p2/77yMXG4gKiDogIzkuI3mmK/nrYkgU0RLIOS+p+aKmyBgSU1BR0VTX1RPT19MQVJHRWAg5ZCO6KKr5ZCe5oiQ44CM5Y+R6YCB5aSx6LSl44CN44CCXG4gKlxuICogQHBhcmFtIGltYWdlcyAtIOmdouadv+e7meeahOWOn+Wni+aVsOe7hOOAglxuICogQHJldHVybnMg6YCa6L+H5YiZ57uZ5Ye66KeE6IyD5YyW55qE5Zu+54mH5YiX6KGo77yM5ZCm5YiZ57uZ5Ye65Lq66K+d5Y6f5Zug44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUltYWdlQmF0Y2goaW1hZ2VzOiB1bmtub3duKTogVmFsaWRhdGVSZXN1bHQge1xuICAgIGlmIChpbWFnZXMgPT09IHVuZGVmaW5lZCB8fCBpbWFnZXMgPT09IG51bGwpIHJldHVybiB7IG9rOiB0cnVlLCBpbWFnZXM6IFtdIH07XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGltYWdlcykpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdpbWFnZXMg5b+F6aG75piv5pWw57uEJyB9O1xuICAgIGlmIChpbWFnZXMubGVuZ3RoID4gTUFYX0lNQUdFU19QRVJfTUVTU0FHRSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5LiA5p2h5raI5oGv5pyA5aSa5bimICR7TUFYX0lNQUdFU19QRVJfTUVTU0FHRX0g5byg5Zu+77yI546w5ZyoICR7aW1hZ2VzLmxlbmd0aH0g5byg77yJ44CCYCB9O1xuICAgIH1cblxuICAgIGNvbnN0IG91dDogVmFsaWRJbWFnZVtdID0gW107XG4gICAgbGV0IHRvdGFsID0gMDtcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgaW1hZ2VzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgICBjb25zdCByYXcgPSAoaW1hZ2VzW2luZGV4XSA/PyB7fSkgYXMgSW5jb21pbmdJbWFnZTtcbiAgICAgICAgY29uc3Qgd2hlcmUgPSBg56ysICR7aW5kZXggKyAxfSDlvKBgO1xuICAgICAgICBjb25zdCBtaW1lVHlwZSA9IHR5cGVvZiByYXcubWltZVR5cGUgPT09ICdzdHJpbmcnID8gcmF3Lm1pbWVUeXBlIDogJyc7XG4gICAgICAgIGlmICghQUNDRVBURURfTUlNRS5oYXMobWltZVR5cGUpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgJHt3aGVyZX3nmoTnsbvlnosgXCIke21pbWVUeXBlIHx8ICco56m6KSd9XCIg5LiN5Zyo5YWB6K646IyD5Zu077yIJHtbLi4uQUNDRVBURURfTUlNRV0uam9pbignIC8gJyl977yJ44CCYCB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGRhdGEgPSB0eXBlb2YgcmF3LmRhdGEgPT09ICdzdHJpbmcnID8gcmF3LmRhdGEudHJpbSgpIDogJyc7XG4gICAgICAgIGlmICghZGF0YSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYCR7d2hlcmV95rKh5pyJ5pWw5o2u44CCYCB9O1xuICAgICAgICBsZXQgZGVjb2RlZDogQnVmZmVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZGVjb2RlZCA9IEJ1ZmZlci5mcm9tKGRhdGEsICdiYXNlNjQnKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGAke3doZXJlfeeahCBiYXNlNjQg6Kej5LiN5byA77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCB9O1xuICAgICAgICB9XG4gICAgICAgIC8vIOinhOiMg+W9ouW8j+agoemqjO+8iOmZhOS7tuW6k+eahOino+eggeWZqOWwseaYr+i/meS5iOWIpOeahO+8jOingeaWh+S7tuWktOesrCAzIOadoe+8iVxuICAgICAgICBpZiAoZGVjb2RlZC5sZW5ndGggPT09IDAgfHwgZGVjb2RlZC50b1N0cmluZygnYmFzZTY0JykgIT09IGRhdGEpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGAke3doZXJlfeeahCBiYXNlNjQg5LiN5piv6KeE6IyD5b2i5byP77yI5LiN6K645pyJ5o2i6KGML+epuuagvC/nvJPlrZjliY3nvIDvvInvvIzph43lu7rkuIDmrKHov5nlvKDlm77ljbPlj6/jgIJgIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGRlY29kZWQubGVuZ3RoID4gTUFYX0lNQUdFX0JZVEVTKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgJHt3aGVyZX0gJHtmb3JtYXRCeXRlcyhkZWNvZGVkLmxlbmd0aCl977yM6LaF6L+H5Y2V5byg5LiK6ZmQICR7Zm9ybWF0Qnl0ZXMoTUFYX0lNQUdFX0JZVEVTKX3jgIJgIH07XG4gICAgICAgIH1cbiAgICAgICAgdG90YWwgKz0gZGVjb2RlZC5sZW5ndGg7XG4gICAgICAgIG91dC5wdXNoKHtcbiAgICAgICAgICAgIG1pbWVUeXBlOiBtaW1lVHlwZSBhcyBJbWFnZU1pbWVUeXBlLFxuICAgICAgICAgICAgZGF0YSxcbiAgICAgICAgICAgIGJ5dGVzOiBkZWNvZGVkLmxlbmd0aCxcbiAgICAgICAgICAgIG5hbWU6IHR5cGVvZiByYXcubmFtZSA9PT0gJ3N0cmluZycgJiYgcmF3Lm5hbWUgPyByYXcubmFtZSA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGlmICh0b3RhbCA+IE1BWF9NRVNTQUdFX0lNQUdFX0JZVEVTKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDov5nmibnlm77lkIjorqEgJHtmb3JtYXRCeXRlcyh0b3RhbCl977yM6LaF6L+H5Y2V5p2h5raI5oGv5LiK6ZmQICR7Zm9ybWF0Qnl0ZXMoTUFYX01FU1NBR0VfSU1BR0VfQllURVMpfeOAgmAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGltYWdlczogb3V0IH07XG59XG5cbi8qKiDlrZfoioLmlbAg4oaSIOS6uuivne+8iGA2MjJLQmAgLyBgMi4zTUJg77yJ44CCICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Qnl0ZXMoYnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoYnl0ZXMpIHx8IGJ5dGVzIDw9IDApIHJldHVybiAnMEtCJztcbiAgICByZXR1cm4gYnl0ZXMgPj0gMTAyNCAqIDEwMjQgPyBgJHsoYnl0ZXMgLyAxMDI0IC8gMTAyNCkudG9GaXhlZCgxKX1NQmAgOiBgJHtNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGJ5dGVzIC8gMTAyNCkpfUtCYDtcbn1cbiJdfQ==