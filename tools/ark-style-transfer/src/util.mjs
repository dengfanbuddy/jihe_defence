/** 通用小工具：日志 / 路径安全 / 并发池 / CSV / 文件名 */

import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT } from './config.mjs';

export function log(...args) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}]`, ...args);
}

export function warn(...args) {
    const t = new Date().toTimeString().slice(0, 8);
    console.warn(`[${t}]`, ...args);
}

let seq = 0;
export function newId(prefix = 'job') {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** 指数退避（带抖动） */
export function backoffMs(attempt, base = 1200, cap = 20000) {
    const v = Math.min(cap, base * 2 ** attempt);
    return Math.round(v * (0.75 + Math.random() * 0.5));
}

export function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

export function isImageFile(p) {
    return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

/** 把用户输入路径归一化（支持 %USERPROFILE% 之类的环境变量、去掉引号） */
export function resolveUserPath(p) {
    if (!p) return '';
    let s = String(p).trim().replace(/^["']|["']$/g, '');
    s = s.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
    if (s === '~') s = process.env.USERPROFILE || process.env.HOME || s;
    return path.resolve(s);
}

/** 递归（或单层）列出目录下的图片文件 */
export function listImages(dir, { recursive = false, limit = 0, offset = 0 } = {}) {
    const out = [];
    const walk = (d, depth) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch (e) {
            throw new Error(`无法读取目录 ${d}：${e.message}`);
        }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (recursive && depth < 6 && !e.name.startsWith('.')) walk(full, depth + 1);
                continue;
            }
            if (isImageFile(full)) out.push(full);
        }
    };
    walk(dir, 0);
    out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const sliced = offset ? out.slice(offset) : out;
    return limit > 0 ? sliced.slice(0, limit) : sliced;
}

/**
 * 简单的并发池：对 items 逐项跑 fn，最多 concurrency 个同时在跑。
 * 支持外部取消（isCancelled() 返回 true 后不再取新任务）。
 */
export async function runPool(items, concurrency, fn, isCancelled = () => false) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            if (isCancelled()) return;
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                results[i] = { __error: e };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

export function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
    const head = columns.map(csvEscape).join(',');
    const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(',')).join('\n');
    return `${head}\n${body}\n`;
}

export function safeName(name) {
    return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
}

export function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(ms) {
    if (!ms) return '-';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 在文件系统里找一个不冲突的文件名 */
export function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    for (let i = 2; i < 1000; i++) {
        const cand = path.join(dir, `${base}_${i}${ext}`);
        if (!fs.existsSync(cand)) return cand;
    }
    return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/** 图片文件 → data URL（供接口以 base64 方式传参考图） */
export function fileToDataUrl(file) {
    const ext = path.extname(file).toLowerCase();
    const mime =
        ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.bmp'
                  ? 'image/bmp'
                  : ext === '.avif'
                    ? 'image/avif'
                    : ext === '.tif' || ext === '.tiff'
                      ? 'image/tiff'
                      : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export function bufToDataUrl(buf, format = 'png') {
    const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
}

export function parseDataUrl(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) throw new Error('不是合法的 data URL');
    return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

export function mimeOf(p) {
    const ext = path.extname(p).toLowerCase();
    return (
        {
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.mjs': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.map': 'application/json; charset=utf-8',
            '.ico': 'image/x-icon',
            '.woff2': 'font/woff2',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.avif': 'image/avif',
            '.tif': 'image/tiff',
            '.tiff': 'image/tiff',
            '.svg': 'image/svg+xml',
            '.json': 'application/json; charset=utf-8',
            '.csv': 'text/csv; charset=utf-8',
            '.txt': 'text/plain; charset=utf-8',
            '.zip': 'application/zip',
        }[ext] || 'application/octet-stream'
    );
}

/** 解析 #RRGGBB / #RGB / rgb(1,2,3) / "255,0,255" */
export function parseColor(s) {
    if (!s) return null;
    s = String(s).trim();
    let m = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
    if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
    m = /(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(s);
    if (m) return [clamp(+m[1], 0, 255), clamp(+m[2], 0, 255), clamp(+m[3], 0, 255)];
    return null;
}

export function toHex(rgb) {
    return `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
