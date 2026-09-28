/**
 * ============================================================
 * 飘伤害字 —— 设计稿渲染器（不依赖任何第三方库）
 * ============================================================
 *
 * 为什么有这个东西：
 *   伤害数字的字形是**手写的几何笔画**（GEOMETRIC_DIGITS），不是字体资产，
 *   所以"长什么样"不能靠脑补 —— 本脚本把真实的字形数据与真实的表现参数
 *   跑成一张 PNG（docs/damage-text-mockup.png），改配色/字号/寿命后重跑即可看效果，
 *   不用开 Cocos 编辑器。
 *
 * 保真口径：
 *   · 字形数据**直接从 GeometricDigits.ts 里解析**（不是手抄一份），改字形后本图同步变
 *   · 字号/笔画粗细/字距/描边/上浮/寿命/暴击标 全部从 DamageTextConfig.ts 解析
 *   · 描边按"距离线段 ≤ 半线宽"光栅化 + 2× 超采样降采样，等价于 MITER 直角描边
 *
 * ⚠ 坐标口径：本脚本用**图像坐标（y 向下）**排版；字形数据是 **y 向上**的
 *   （y=0 为基线），所以所有字形 y 都要取反（`baseY - y * size`），上浮也是 y 减小。
 *
 * 版式：上段是字形自检；下段是**同一批飘字在浅底 / 深底两种面板上的并排对比**
 *   —— 战斗背景是浅色的，白字必须靠深色描边才读得出来，这一栏就是那张"能不能读"的证据。
 *
 * 用法（在项目根目录）：node tools/damage-text-preview/gen-mockup.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const GLYPH_SRC = resolve(ROOT, 'assets/scripts/game/game_stage/entityview/GeometricDigits.ts');
const CONFIG_SRC = resolve(ROOT, 'assets/scripts/game/common/DamageTextConfig.ts');
const OUT = resolve(ROOT, 'docs/damage-text-mockup.png');

// ============ 1. 从 TS 源里解析真实数据（字形 + 表现参数） ============

function extractGlyphs() {
    const src = readFileSync(GLYPH_SRC, 'utf8');
    const m = src.match(/GEOMETRIC_DIGITS\s*:\s*number\[\]\[\]\[\]\s*=\s*(\[[\s\S]*?\n\];)/);
    if (!m) throw new Error('无法从 GeometricDigits.ts 解析出 GEOMETRIC_DIGITS');
    const literal = m[1].replace(/;\s*$/, ''); // 表里只有数字字面量与注释，直接求值
    return {
        glyphs: eval(literal),
        boxWidth: Number(src.match(/GLYPH_BOX_WIDTH\s*=\s*([\d.]+)/)[1]),
    };
}

function extractNumber(src, key) {
    const m = src.match(new RegExp(`${key}\\s*:\\s*(-?[\\d.]+)`));
    if (!m) throw new Error(`无法解析配置项 ${key}`);
    return Number(m[1]);
}

function extractHex(src, key) {
    const m = src.match(new RegExp(`${key}\\s*:\\s*0x([0-9a-fA-F]+)`));
    if (!m) throw new Error(`无法解析颜色项 ${key}`);
    return parseInt(m[1], 16);
}

function extractStyle(src, tierName) {
    const block = src.match(new RegExp(`\\[DamageTextTier\\.${tierName}\\]:\\s*\\{([\\s\\S]*?)\\n    \\}`));
    if (!block) throw new Error(`无法解析档位 ${tierName}`);
    const body = block[1];
    const style = {};
    const keys = ['scale', 'color', 'life', 'rise', 'pop', 'popTime', 'marker', 'markerHeight', 'markerGap', 'fadeFrom', 'priority'];
    for (const key of keys) {
        const m = body.match(new RegExp(`${key}\\s*:\\s*(0x[0-9a-fA-F]+|[\\d.]+)`));
        if (m) style[key] = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
    }
    return style;
}

const { glyphs: DIGITS, boxWidth: GLYPH_BOX_WIDTH } = extractGlyphs();
const cfgSrc = readFileSync(CONFIG_SRC, 'utf8');
const CFG = {
    baseFontSize: extractNumber(cfgSrc, 'baseFontSize'),
    heroScaleBonus: extractNumber(cfgSrc, 'heroScaleBonus'),
    outlineGrow: extractNumber(cfgSrc, 'outlineGrow'),
    outlineColor: extractHex(cfgSrc, 'outlineColor'),
    ladderGapRatio: extractNumber(cfgSrc, 'ladderGapRatio'),
    spawnOffsetY: extractNumber(cfgSrc, 'spawnOffsetY'),
    strokeRatio: extractNumber(cfgSrc, 'strokeRatio'),
    advanceRatio: extractNumber(cfgSrc, 'advanceRatio'),
};
const STYLE = { normal: extractStyle(cfgSrc, 'Normal'), crit: extractStyle(cfgSrc, 'Crit') };
const HERO_HURT_COLOR = 0xff4c4c; // = UNIT_VISUALS[Hero].hitColor（EntityVisualConfig）
const UNIT_COLORS = {
    normal: 0x6b8e9b,
    elite: 0x9b59b6,
    goldBoss: 0xe74c3c,
    hero: 0xe8e8e8,
};

// ============ 2. 极简光栅器（RGB 浮点缓冲 + 距离场描边） ============

const SS = 2;                       // 超采样倍率
const W = 1200, H = 820;            // 输出尺寸（逻辑像素）
const BW = W * SS, BH = H * SS;
const buf = new Float32Array(BW * BH * 3);

function clear(bg) {
    const r = (bg >> 16) & 0xff, g = (bg >> 8) & 0xff, b = bg & 0xff;
    for (let i = 0; i < BW * BH; i++) {
        buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
    }
}

function blend(x, y, rgb, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= BW || y >= BH) return;
    const i = (y * BW + x) * 3;
    const ia = 1 - a;
    buf[i] = ((rgb >> 16) & 0xff) * a + buf[i] * ia;
    buf[i + 1] = ((rgb >> 8) & 0xff) * a + buf[i + 1] * ia;
    buf[i + 2] = (rgb & 0xff) * a + buf[i + 2] * ia;
}

function distToSeg(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

/** 描一条线（逻辑坐标；等价于 Graphics 的 stroke + MITER 直角） */
function line(x0, y0, x1, y1, width, rgb, alpha) {
    const sx0 = x0 * SS, sy0 = y0 * SS, sx1 = x1 * SS, sy1 = y1 * SS;
    const hw = (width * SS) / 2;
    const minX = Math.max(0, Math.floor(Math.min(sx0, sx1) - hw - 1));
    const maxX = Math.min(BW - 1, Math.ceil(Math.max(sx0, sx1) + hw + 1));
    const minY = Math.max(0, Math.floor(Math.min(sy0, sy1) - hw - 1));
    const maxY = Math.min(BH - 1, Math.ceil(Math.max(sy0, sy1) + hw + 1));
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const d = distToSeg(x + 0.5, y + 0.5, sx0, sy0, sx1, sy1);
            const cov = Math.min(1, Math.max(0, hw + 0.5 - d));
            if (cov > 0) blend(x, y, rgb, alpha * cov);
        }
    }
}

/** 填充矩形（逻辑坐标，x/y 为左上角，图像坐标 y 向下） */
function rect(x, y, w, h, rgb, alpha) {
    const sx = x * SS, sy = y * SS, sw = w * SS, sh = h * SS;
    const minX = Math.max(0, Math.floor(sx)), maxX = Math.min(BW - 1, Math.ceil(sx + sw) - 1);
    const minY = Math.max(0, Math.floor(sy)), maxY = Math.min(BH - 1, Math.ceil(sy + sh) - 1);
    for (let py = minY; py <= maxY; py++) {
        const covY = Math.min(1, Math.max(0, Math.min(py + 1, sy + sh) - Math.max(py, sy)));
        for (let px = minX; px <= maxX; px++) {
            const covX = Math.min(1, Math.max(0, Math.min(px + 1, sx + sw) - Math.max(px, sx)));
            if (covX * covY > 0) blend(px, py, rgb, alpha * covX * covY);
        }
    }
}

/** 矩形描边（画在矩形外沿） */
function rectOutline(x, y, w, h, width, rgb, alpha) {
    line(x, y, x + w, y, width, rgb, alpha);
    line(x + w, y, x + w, y + h, width, rgb, alpha);
    line(x + w, y + h, x, y + h, width, rgb, alpha);
    line(x, y + h, x, y, width, rgb, alpha);
}

/** 画一串数字：居中于 centerX，基线 baseY，字号 size，线宽 width（= DrawDigits 的同一套算法） */
function digits(text, centerX, baseY, size, rgb, alpha, width) {
    text = String(text);
    const advance = size * CFG.advanceRatio;
    const total = (text.length - 1) * advance + size * GLYPH_BOX_WIDTH;
    let penX = centerX - total / 2;
    const sw = width ?? Math.max(1, size * CFG.strokeRatio);
    for (const ch of text) {
        const glyph = DIGITS[ch.charCodeAt(0) - 48];
        if (glyph) {
            for (const sub of glyph) {
                const n = sub.length;
                const closed = n >= 8 && sub[0] === sub[n - 2] && sub[1] === sub[n - 1];
                const end = closed ? n - 2 : n;
                const gx = (k) => penX + sub[k] * size;
                const gy = (k) => baseY - sub[k + 1] * size; // 字形 y 向上 → 图像 y 取反
                let prevX = 0, prevY = 0;
                for (let k = 0; k < end; k += 2) {
                    if (k > 0) line(prevX, prevY, gx(k), gy(k), sw, rgb, alpha);
                    prevX = gx(k); prevY = gy(k);
                }
                if (closed) line(prevX, prevY, gx(0), gy(0), sw, rgb, alpha);
                // 顶点补方块：笔画全为横竖段，方形正好填满 MITER 直角接缝
                for (let k = 0; k < end; k += 2) rect(gx(k) - sw / 2, gy(k) - sw / 2, sw, sw, rgb, alpha);
            }
        }
        penX += advance;
    }
    return total;
}

/** 实心菱形（= GeometricDigits.fillDiamond：逐行扫成水平细线即实心多边形） */
function solidDiamond(cx, cy, hw, hh, rgb, alpha) {
    for (let dy = -hh; dy <= hh; dy += 0.5) {
        const halfW = hw * (1 - Math.abs(dy) / hh);
        if (halfW > 0) line(cx - halfW, cy + dy, cx + halfW, cy + dy, 1, rgb, alpha);
    }
}

/** 单位方块（居中；可选描边，浅底上放浅色单位时才需要） */
function unit(x, y, size, rgb, scale = 1, border = 0) {
    const s = size * scale;
    rect(x - s / 2, y - s / 2, s, s, rgb, 1);
    if (border > 0) rectOutline(x - s / 2, y - s / 2, s, s, border, 0x9aa3a8, 1);
}

function divider(y, rgb) {
    rect(48, y, W - 96, 1, rgb, 1);
}

/** 量宽度（= GeometricDigits.measureDigits） */
function measure(text, size) {
    return (text.length - 1) * size * CFG.advanceRatio + size * GLYPH_BOX_WIDTH;
}

// ============ 3. 一个飘字的"某一时刻"（与 DamageTextLayer.drawItem 同一套运算） ============

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

function alphaOf(t, fadeFrom) {
    if (t <= fadeFrom) return 1;
    const k = (t - fadeFrom) / (1 - fadeFrom);
    return k >= 1 ? 0 : 1 - k;
}

/**
 * 一个飘字在寿命进度 t 时刻的样子（含**两遍绘制**：先暗色描边、再彩色正文）
 *
 * @param tier 'normal' | 'crit'
 * @param heroHurt 是否打在英雄身上（决定颜色与放大）
 * @param t 寿命进度 0~1
 * @param y0 出生点基线（图像坐标）
 */
function floatText(value, x, y0, tier, heroHurt, t) {
    const st = STYLE[tier];
    const size = CFG.baseFontSize * st.scale * (heroHurt ? CFG.heroScaleBonus : 1);
    const alpha = alphaOf(t, st.fadeFrom);
    const rgb = heroHurt ? HERO_HURT_COLOR : st.color;
    const baseline = y0 - st.rise * easeOutCubic(t); // 上浮 = 图像 y 减小
    const text = String(value);
    const textCy = baseline - size * 0.5;

    const strokeW = Math.max(1, size * CFG.strokeRatio);
    const grows = CFG.outlineGrow > 0;
    const outlineW = strokeW + size * CFG.outlineGrow;
    const outlineHalf = (size * CFG.outlineGrow) * 0.5;

    // 几何：暴击左侧菱形标与数字作为一组整体居中
    let badgeCx = 0, badgeW = 0, badgeH = 0, textX = x;
    if (st.marker > 0) {
        badgeW = size * st.marker;
        badgeH = size * st.markerHeight;
        const gap = size * st.markerGap;
        const w = measure(text, size);
        const left = x - (badgeW * 2 + gap + w) / 2;
        badgeCx = left + badgeW;
        textX = left + badgeW * 2 + gap + w / 2;
    }

    // 1) 描边（暗色、更粗）
    if (grows) {
        if (badgeW > 0) solidDiamond(badgeCx, textCy, badgeW + outlineHalf, badgeH + outlineHalf, CFG.outlineColor, alpha);
        digits(text, textX, baseline, size, CFG.outlineColor, alpha, outlineW);
    }
    // 2) 正文（彩色）
    if (badgeW > 0) solidDiamond(badgeCx, textCy, badgeW, badgeH, rgb, alpha);
    digits(text, textX, baseline, size, rgb, alpha, strokeW);
}

// ============ 4. 出图 ============

const BG_LIGHT = 0xf2f4f5;   // = 当前战斗背景（浅色）
const BG_DARK = 0x101619;    // 深底对照
clear(BG_LIGHT);
for (let gx = 0; gx <= W; gx += 60) rect(gx, 0, 1, H, 0xe4e8ea, 1);
for (let gy = 0; gy <= H; gy += 60) rect(0, gy, W, 1, 0xe4e8ea, 1);

// ---- A. 字形自检：0~9（真实普通字号 / 真实暴击字号 / 2× 放大看拐角与描边） ----
digits('0123456789', 600, 70, CFG.baseFontSize, CFG.outlineColor, 1, Math.max(1, CFG.baseFontSize * CFG.strokeRatio) + CFG.baseFontSize * CFG.outlineGrow);
digits('0123456789', 600, 70, CFG.baseFontSize, 0xffffff, 1);
digits('0123456789', 600, 150, CFG.baseFontSize * STYLE.crit.scale, CFG.outlineColor, 1, Math.max(1, CFG.baseFontSize * STYLE.crit.scale * CFG.strokeRatio) + CFG.baseFontSize * STYLE.crit.scale * CFG.outlineGrow);
digits('0123456789', 600, 150, CFG.baseFontSize * STYLE.crit.scale, 0xffffff, 1);
digits('0123456789', 600, 260, CFG.baseFontSize * 2, CFG.outlineColor, 1, Math.max(1, CFG.baseFontSize * 2 * CFG.strokeRatio) + CFG.baseFontSize * 2 * CFG.outlineGrow);
digits('0123456789', 600, 260, CFG.baseFontSize * 2, 0xffffff, 1);
divider(292, 0xd5dade);

// ---- B/C. 浅底 / 深底两块面板：同一批飘字，检验"哪种底都能读" ----
/**
 * @param px,py 面板左上角；bg 面板底色；light 是否是浅底（决定单位方块要不要描边）
 */
function scenePanel(px, py, bg, light) {
    const pw = 540, ph = 490;
    rect(px, py, pw, ph, bg, 1);
    rectOutline(px, py, pw, ph, 2, light ? 0xd5dade : 0x2b343a, 1);

    const heroBorder = light ? 1.5 : 0;   // 浅底上浅色英雄方块必须描边才看得见
    const hero = { x: px + 300, y: py + 400, size: 46, color: UNIT_COLORS.hero };
    const mNorm = { x: px + 108, y: py + 350, size: 50, color: UNIT_COLORS.normal };
    const mElite = { x: px + 205, y: py + 175, size: 50, color: UNIT_COLORS.elite, scale: 1.3 };
    const mBoss = { x: px + 425, y: py + 195, size: 50, color: UNIT_COLORS.goldBoss, scale: 1.5 };

    unit(hero.x, hero.y, hero.size, hero.color, 1, heroBorder);
    unit(mNorm.x, mNorm.y, mNorm.size, mNorm.color, 1);
    unit(mElite.x, mElite.y, mElite.size, mElite.color, mElite.scale);
    unit(mBoss.x, mBoss.y, mBoss.size, mBoss.color, mBoss.scale);

    // 数字的出生基线 = 单位上沿再抬 spawnOffsetY
    const above = (m, extra = 0) => m.y - (m.size * (m.scale ?? 1)) / 2 - CFG.spawnOffsetY - extra;

    // 连击阶梯：单发永远从第 0 层起，连击才往上铺（间距 = 基准字号 × 倍率）
    const LADDER = CFG.baseFontSize * CFG.ladderGapRatio;
    floatText(37, mNorm.x - 8, above(mNorm), 'normal', false, 0.15);
    floatText(42, mNorm.x - 8, above(mNorm) - LADDER, 'normal', false, 0.45);
    floatText(18, mNorm.x - 8, above(mNorm) - LADDER * 2, 'normal', false, 0.8);
    // 暴击：1.6× + 左侧实心菱形标
    floatText(286, mElite.x, above(mElite), 'crit', false, 0.25);
    floatText(104, mBoss.x, above(mBoss), 'crit', false, 0.55);
    // 英雄受击：红字 + 1.15× + 居中
    floatText(58, hero.x, above(hero, 6), 'normal', true, 0.35);
}

scenePanel(40, 322, 0xffffff, true);    // 浅底（当前战斗背景）
scenePanel(620, 322, BG_DARK, false);   // 深底对照

// ---- 降采样 → PNG ----
const out = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const i = ((y * SS + sy) * BW + (x * SS + sx)) * 3;
                r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
            }
        }
        const n = SS * SS, o = (y * W + x) * 3;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
}

// ---- 最小 PNG 编码器（zlib 内置） ----
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: truecolor RGB
const rawPng = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
    rawPng[y * (W * 3 + 1)] = 0; // filter: none
    out.copy(rawPng, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawPng, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);

console.log(`已生成 ${OUT}  (${W}x${H})`);
console.log(`字号: 基准 ${CFG.baseFontSize}（普通）×${STYLE.normal.scale} / 暴击 ×${STYLE.crit.scale} / 英雄受击 ×${CFG.heroScaleBonus}`);
console.log(`描边: 溢出 ${CFG.outlineGrow} → 每侧 ${(CFG.baseFontSize * CFG.outlineGrow / 2).toFixed(2)}px，色 #${CFG.outlineColor.toString(16).padStart(6, '0')}`);
console.log(`寿命: 普通 ${STYLE.normal.life}s / 暴击 ${STYLE.crit.life}s；上浮: 普通 ${STYLE.normal.rise}px / 暴击 ${STYLE.crit.rise}px`);
