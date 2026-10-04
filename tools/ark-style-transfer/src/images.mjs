/** 图像 I/O 与几何处理（统一用 sharp，避免各处理环节的颜色空间/通道数不一致） */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { bufToDataUrl } from './util.mjs';

sharp.cache(false);

/** 读图元信息 */
export async function probeImage(src) {
    const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
    const meta = await sharp(buf).metadata();
    return {
        width: meta.width || 0,
        height: meta.height || 0,
        format: meta.format || '',
        hasAlpha: !!meta.hasAlpha,
        size: buf.length,
    };
}

/** 统计有内容的像素占比与透明占比（用于 QC） */
export async function alphaStats(src) {
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const total = info.width * info.height;
    let transparent = 0;
    let partial = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            const a = data[(y * info.width + x) * 4 + 3];
            if (a === 0) transparent++;
            else if (a < 255) partial++;
            if (a > 8) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    return {
        width: info.width,
        height: info.height,
        transparentRatio: total ? transparent / total : 0,
        partialRatio: total ? partial / total : 0,
        bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    };
}

/**
 * 归一化「送进接口」的输入图：转 PNG、必要时等比缩放到 inputMaxEdge、轻微锐化。
 * 参考图/目标图都走这里，保证两张图在接口侧是同一种容器格式与色彩空间。
 *
 * ⚠ **默认只缩小、不放大**（`allowUpscale: false`）。踩过：dota2 图标是 88×64，
 * 老代码把它们放大到 512×372 再送接口 —— 实测相邻像素亮度差（细节量）从 17.2 掉到 3.05、
 * 38.9 掉到 6.8（**掉了 82%**），于是「风格参考图」送进去就是一团糊，
 * 不同参考图的风格差异被抹平，出图自然"换哪张参考都一样"。
 * 方舟对输入图的要求只是「宽高都 > 14px、≤ 6000×6000、单张 ≤ 30MB」（5.0 pro 文档），
 * 小图原样送完全合法，放大只会自损细节。
 */
export async function normalizeInput(src, { inputMaxEdge = 512, allowUpscale = false } = {}) {
    const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
    let pipe = sharp(buf, { failOn: 'none' }).rotate().ensureAlpha();
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const longEdge = Math.max(w, h);
    let scaled = false;
    // 缩小：超过上限就等比压到上限；放大：只有显式开启才做（默认不放大）
    const needDown = inputMaxEdge > 0 && longEdge > inputMaxEdge;
    const needUp = allowUpscale && inputMaxEdge > 0 && longEdge < inputMaxEdge * 0.5;
    if (needDown || needUp) {
        const scale = inputMaxEdge / longEdge;
        pipe = pipe.resize({
            width: Math.max(16, Math.round(w * scale)),
            height: Math.max(16, Math.round(h * scale)),
            fit: 'fill',
            kernel: 'lanczos3',
        });
        scaled = true;
    }
    let out = await pipe.png({ compressionLevel: 9 }).toBuffer();
    // 只有**缩小**后才轻微锐化（补回抽点损失）；放大本来就没细节，再锐化只会出振铃
    if (scaled && needDown) {
        out = await sharp(out).sharpen({ sigma: 0.6, m1: 0.4, m2: 0.8 }).png({ compressionLevel: 9 }).toBuffer();
    }
    const outMeta = await sharp(out).metadata();
    return {
        buffer: out,
        scaled,
        upscaled: scaled && needUp,
        width: w,
        height: h,
        sentWidth: outMeta.width || w,
        sentHeight: outMeta.height || h,
    };
}

export function toDataUrl(buf, format = 'png') {
    return bufToDataUrl(buf, format);
}

/** 原图（模型直出）落盘 */
export async function saveRaw(buf, dest, { format = 'png' } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (format === 'jpeg' || format === 'jpg') {
        await sharp(buf).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(dest);
    } else {
        await sharp(buf).png({ compressionLevel: 9 }).toFile(dest);
    }
    return dest;
}

/** 写 PNG（保留 alpha），可选按 outSize 等比缩放（内部 premultiply，避免半透明边缘发黑） */
export async function writePng(raw, width, height, dest, { outSize = 0 } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let img = sharp(raw, { raw: { width, height, channels: 4 } });
    let w = width;
    let h = height;
    if (outSize > 0 && Math.max(width, height) !== outSize) {
        const scale = outSize / Math.max(width, height);
        w = Math.max(1, Math.round(width * scale));
        h = Math.max(1, Math.round(height * scale));
        img = img.resize({ width: w, height: h, fit: 'fill', kernel: 'lanczos3' });
    }
    const buf = await img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    fs.writeFileSync(dest, buf);
    return { path: dest, width: w, height: h, size: buf.length };
}

/** 写 JPEG（无 alpha 场景） */
export async function writeJpeg(raw, width, height, dest, { outSize = 0, quality = 95, background = '#00000000' } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let img = sharp(raw, { raw: { width, height, channels: 4 } }).flatten({ background });
    const scale = outSize > 0 ? outSize / Math.max(width, height) : 1;
    if (outSize > 0 && Math.max(width, height) !== outSize) {
        img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), fit: 'fill', kernel: 'lanczos3' });
    }
    const buf = await img.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
    fs.writeFileSync(dest, buf);
    return { path: dest, width: Math.round(width * scale), height: Math.round(height * scale), size: buf.length };
}

/** 缩略图（界面网格用，PNG 保留透明） */
export async function writeThumb(src, dest, size = 160) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = await sharp(src, { failOn: 'none' })
        .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
    fs.writeFileSync(dest, buf);
    return dest;
}

/** 读成 RGBA raw（给抠图算法用） */
export async function readRaw(src) {
    const { data, info } = await sharp(src, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}
