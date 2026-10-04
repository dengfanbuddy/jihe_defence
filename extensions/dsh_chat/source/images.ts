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

import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join, relative, resolve, sep } from 'path';

/** DSH 附件库接受的四种栅格图（多一种都过不了 `validateImageBatch`）。 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 扩展名 → MIME。键一律是**小写、带点**的形式（`extname()` 的返回值）。 */
export const IMAGE_MIME_BY_EXT: Record<string, ImageMimeType> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/** 认得的图片扩展名（面板的筛选、目录扫描共用）。 */
export const IMAGE_EXTENSIONS: string[] = Object.keys(IMAGE_MIME_BY_EXT);

/** 一条消息里最多几张（对齐 `dsh-attachment-local` 的 `maxImagesPerMessage` 默认值）。 */
export const MAX_IMAGES_PER_MESSAGE = 20;

/** 单张图的字节上限（`maxImageBytes` 默认 20MB）——超了是**拒收**，不是压缩。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 一条消息里所有图的合计字节上限（`maxMessageImageBytes` 默认 200MB）。 */
export const MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;

/** 列工程图片时的条数上限（面板是 DOM 列表，不设上限会卡）。 */
export const MAX_LISTED_IMAGES = 800;

/** 目录扫描的深度上限（防符号链接成环 / 恐怖目录）。 */
export const MAX_SCAN_DEPTH = 12;

/** 一条「工程里的图片」在 IPC 上的形状。 */
export interface ProjectImage {
    /** 资源库 URL（`db://assets/...`）；目录扫描兜底时由路径反推，拿不到就是空串。 */
    url: string;
    /** 绝对路径。**这是主键**：两套路的结果按它去重。 */
    path: string;
    /** 显示名（一般就是文件名）。 */
    name: string;
    /** 资源 uuid（只有资源库那条路有）。 */
    uuid?: string;
    /** 字节数（拿不到 stat 时为 undefined）。 */
    bytes?: number;
    /** 资源最后修改时间（只有资源库那条路给得出；排序/排查用）。 */
    mtime?: number;
    /** 展示用：相对工程根的路径，用 `/` 分隔。 */
    rel: string;
    /** 这条是从哪来的（排查用：「资源库怎么少了几张」时先看它）。 */
    source: 'asset-db' | 'scan';
}

/** 读取一张图片的回执。 */
export type ReadImageResult =
    | {
          ok: true;
          /** 显示名。 */
          name: string;
          /** 绝对路径。 */
          path: string;
          /** `db://` URL（路径不在资源库映射范围内时为空串）。 */
          url: string;
          /** 声明给附件库的 MIME（由扩展名推出，附件库会拿字节再验一遍）。 */
          mimeType: ImageMimeType;
          /** 字节数。 */
          bytes: number;
          /** **规范** base64（不带 `data:` 前缀，无换行）。 */
          data: string;
      }
    | { ok: false; error: string };

/** `extname` 结果的小写形式（`.` 开头；没有扩展名时是空串）。 */
function extOf(file: string): string {
    return extname(file).toLowerCase();
}

/**
 * 路径 → MIME；不是认得的图片则返回 null。
 *
 * @param file - 文件名或绝对路径（只看扩展名）。
 * @returns MIME 或 null。
 */
export function mimeOfImagePath(file: string): ImageMimeType | null {
    return IMAGE_MIME_BY_EXT[extOf(file)] ?? null;
}

/** 扩展名是不是认得的图片。 */
export function isImagePath(file: string): boolean {
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
export function dbUrlToPath(projectPath: string, url: string): string | null {
    const match = /^db:\/\/([^/]+)\/(.+)$/.exec(url.trim());
    if (!match) return null;
    const [, mount, rest] = match;
    if (mount !== 'assets' && mount !== 'internal') return null;
    return join(resolve(projectPath), mount, ...rest.split('/'));
}

/**
 * 绝对路径 → `db://assets/...`（反向映射）。
 *
 * @param projectPath - 工程根。
 * @param file - 绝对路径。
 * @returns `db://` URL，或空串（路径不在 assets/internal 下）。
 */
export function pathToDbUrl(projectPath: string, file: string): string {
    const root = resolve(projectPath);
    const target = resolve(file);
    for (const mount of ['assets', 'internal'] as const) {
        const base = join(root, mount);
        if (target === base) continue;
        if (target.startsWith(base + sep)) {
            const rest = relative(base, target).split(sep).join('/');
            return `db://${mount}/${rest}`;
        }
    }
    return '';
}

/** 这个 `db://` URL 看着就是一张图本体（不是 `/spriteFrame` 那种子资源）。 */
export function urlLooksLikeImage(url: string): boolean {
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
export function scanImageFiles(root: string, limit = MAX_LISTED_IMAGES): Array<{ path: string; rel: string; name: string; bytes: number }> {
    const out: Array<{ path: string; rel: string; name: string; bytes: number }> = [];
    const base = resolve(root);

    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_SCAN_DEPTH || out.length >= limit) return;
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return; // 没权限/不存在：跳过这一支，不打断整次扫描
        }
        for (const name of names) {
            if (out.length >= limit) return;
            if (name.startsWith('.')) continue;
            const abs = join(dir, name);
            let stat;
            try {
                stat = statSync(abs);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(abs, depth + 1);
                continue;
            }
            if (!stat.isFile() || !isImagePath(name)) continue;
            const rel = relative(base, abs).split(sep).join('/');
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
export function mergeProjectImages(
    primary: ProjectImage[] | undefined,
    fallback: ProjectImage[] | undefined,
    limit = MAX_LISTED_IMAGES,
): ProjectImage[] {
    const seen = new Set<string>();
    const out: ProjectImage[] = [];
    for (const item of [...(primary ?? []), ...(fallback ?? [])]) {
        // Windows 盘符大小写、`/` `\` 混用都会让同一个文件变成两条 —— 统一成小写的规范路径
        const key = process.platform === 'win32' ? resolve(item.path).toLowerCase() : resolve(item.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) break;
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
export function projectImagesFromAssetDb(rows: unknown, projectPath: string): ProjectImage[] {
    if (!Array.isArray(rows)) return [];
    const out: ProjectImage[] = [];
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as { url?: unknown; name?: unknown; displayName?: unknown; uuid?: unknown; file?: unknown; mtime?: unknown };
        const url = typeof row.url === 'string' ? row.url : '';
        if (!url.startsWith('db://assets/')) continue;
        if (!urlLooksLikeImage(url)) continue;
        const file = typeof row.file === 'string' && row.file ? row.file : dbUrlToPath(projectPath, url);
        if (!file) continue;
        const display =
            (typeof row.displayName === 'string' && row.displayName) || (typeof row.name === 'string' && row.name) || '';
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
export function filterProjectImages(images: ProjectImage[], query: string): ProjectImage[] {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return images;
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
export function readImageFile(file: string, options: { projectPath?: string; maxBytes?: number } = {}): ReadImageResult {
    const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
    const abs = resolve(file);
    const mimeType = mimeOfImagePath(abs);
    if (!mimeType) {
        return { ok: false, error: `不是认得的图片格式（只收 ${IMAGE_EXTENSIONS.join(' / ')}）：${abs}` };
    }
    let size: number;
    try {
        const stat = statSync(abs);
        if (!stat.isFile()) return { ok: false, error: `不是文件：${abs}` };
        size = stat.size;
    } catch (error) {
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
        const data = readFileSync(abs).toString('base64');
        return {
            ok: true,
            name: abs.split(sep).pop() ?? abs,
            path: abs,
            url: options.projectPath ? pathToDbUrl(options.projectPath, abs) : '',
            mimeType,
            bytes: size,
            data,
        };
    } catch (error) {
        return { ok: false, error: `读文件失败（${error instanceof Error ? error.message : String(error)}）：${abs}` };
    }
}

/** 面板传上来的待发送图片（校验前的形状）。 */
export interface IncomingImage {
    mimeType?: unknown;
    data?: unknown;
    name?: unknown;
    bytes?: unknown;
}

/** 校验通过后的图片（可以直接塞进 SDK 的 contentBlocks）。 */
export interface ValidImage {
    mimeType: ImageMimeType;
    /** 规范 base64。 */
    data: string;
    /** 解码后的字节数（附件库会再验一遍）。 */
    bytes: number;
    name?: string;
}

/** 校验回执。 */
export type ValidateResult = { ok: true; images: ValidImage[] } | { ok: false; error: string };

/** 认得的 MIME 集合（`validateImageBatch` 用）。 */
const ACCEPTED_MIME = new Set<string>(Object.values(IMAGE_MIME_BY_EXT));

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
export function validateImageBatch(images: unknown): ValidateResult {
    if (images === undefined || images === null) return { ok: true, images: [] };
    if (!Array.isArray(images)) return { ok: false, error: 'images 必须是数组' };
    if (images.length > MAX_IMAGES_PER_MESSAGE) {
        return { ok: false, error: `一条消息最多带 ${MAX_IMAGES_PER_MESSAGE} 张图（现在 ${images.length} 张）。` };
    }

    const out: ValidImage[] = [];
    let total = 0;
    for (let index = 0; index < images.length; index += 1) {
        const raw = (images[index] ?? {}) as IncomingImage;
        const where = `第 ${index + 1} 张`;
        const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : '';
        if (!ACCEPTED_MIME.has(mimeType)) {
            return { ok: false, error: `${where}的类型 "${mimeType || '(空)'}" 不在允许范围（${[...ACCEPTED_MIME].join(' / ')}）。` };
        }
        const data = typeof raw.data === 'string' ? raw.data.trim() : '';
        if (!data) return { ok: false, error: `${where}没有数据。` };
        let decoded: Buffer;
        try {
            decoded = Buffer.from(data, 'base64');
        } catch (error) {
            return { ok: false, error: `${where}的 base64 解不开：${error instanceof Error ? error.message : String(error)}` };
        }
        // 规范形式校验（附件库的解码器就是这么判的，见文件头第 3 条）
        if (decoded.length === 0 || decoded.toString('base64') !== data) {
            return { ok: false, error: `${where}的 base64 不是规范形式（不许有换行/空格/缓存前缀），重建一次这张图即可。` };
        }
        if (decoded.length > MAX_IMAGE_BYTES) {
            return { ok: false, error: `${where} ${formatBytes(decoded.length)}，超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}。` };
        }
        total += decoded.length;
        out.push({
            mimeType: mimeType as ImageMimeType,
            data,
            bytes: decoded.length,
            name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
        });
    }
    if (total > MAX_MESSAGE_IMAGE_BYTES) {
        return { ok: false, error: `这批图合计 ${formatBytes(total)}，超过单条消息上限 ${formatBytes(MAX_MESSAGE_IMAGE_BYTES)}。` };
    }
    return { ok: true, images: out };
}

/** 字节数 → 人话（`622KB` / `2.3MB`）。 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0KB';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
