/**
 * 用真调用查清「方舟的 background=transparent 到底在什么情况下出透明」。
 *
 *   node tests/check-transparent.mjs              # 跑全部 3 个用例
 *   node tests/check-transparent.mjs --cases a,c  # 只跑指定用例
 *   node tests/check-transparent.mjs --model doubao-seedream-5-0-pro-260628
 *
 * ⚠ 会真出图，**花钱**（每例约 0.1~0.3 元）。结论请看最后那张表。
 *
 * 三个用例的区别只在「输入图的张数与透明通道」：
 *   a: 2 张输入图（风格参考 + 目标图，都是不透明的） + background=transparent
 *   b: 1 张输入图（有不透明 alpha 通道）            + background=transparent
 *   c: 1 张输入图（真的带透明像素）                  + background=transparent
 * 产出图与结论写在 .data/probe-transparent/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { effectiveApiKey, effectiveBaseUrl, DEFAULT_PARAMS } from '../src/config.mjs';
import { generateImage, explainError } from '../src/ark.mjs';
import { normalizeInput, probeImage, alphaStats as rawAlphaStats } from '../src/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.data', 'probe-transparent');
const ICONS = 'E:\\project2\\AI\\dota2_equip\\output\\icons';

const args = process.argv.slice(2);
const val = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : '';
};
const cases = (val('cases') || 'a,b,c').split(',').map((s) => s.trim()).filter(Boolean);
const model = val('model') || DEFAULT_PARAMS.model;
const size = val('size') || '1K';
const PROMPT =
    '把图2里的道具（图1是风格参考）重绘成同一画风的游戏道具图标，背景必须是纯色 #FF00FF，四周留出均匀留白，不要投影、不要边框。';

const apiKey = effectiveApiKey();
if (!apiKey) {
    console.error('没有 API Key：先在界面「设置」里填，或设环境变量 ARK_API_KEY');
    process.exit(1);
}
const baseUrl = effectiveBaseUrl();

/** 读一张图并压到 inputMaxEdge 以内，返回 data URL 与它自己的透明特征 */
async function loadInput(file, { makeTransparent = false } = {}) {
    if (!fs.existsSync(file)) throw new Error(`找不到图：${file}`);
    let buf = fs.readFileSync(file);
    if (makeTransparent) {
        // 造一张"真的有透明像素"的输入图：把四周挖空一圈
        const meta = await sharp(buf).metadata();
        const m = Math.floor(Math.min(meta.width, meta.height) * 0.12);
        const inner = await sharp(buf)
            .ensureAlpha()
            .extract({ left: m, top: m, width: meta.width - 2 * m, height: meta.height - 2 * m })
            .png()
            .toBuffer();
        buf = await sharp({
            create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
            .composite([{ input: inner, left: m, top: m }])
            .png()
            .toBuffer();
    }
    const norm = await normalizeInput(buf, { inputMaxEdge: 512 });
    const dataUrl = `data:image/png;base64,${norm.buffer.toString('base64')}`;
    return { dataUrl, alpha: await alphaStats(norm.buffer), bytes: norm.buffer.length };
}

/** 量一张图的透明特征：有没有 alpha 通道、有多少真透明像素（复用 src/images.mjs 的口径） */
async function alphaStats(buf) {
    const meta = await probeImage(buf);
    const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let min = 255;
    for (let i = 3; i < data.length; i += 4) if (data[i] < min) min = data[i];
    const s = await rawAlphaStats(buf);
    return {
        width: meta.width,
        height: meta.height,
        hasAlpha: meta.hasAlpha,
        alphaMin: min,
        transparentRatio: +s.transparentRatio.toFixed(4),
        partialRatio: +s.partialRatio.toFixed(4),
    };
}

async function runCase(id, { images, note }) {
    const t0 = Date.now();
    const label = { a: '2 图输入（都不透明）', b: '1 图输入（alpha 通道但不透明）', c: '1 图输入（真有透明像素）' }[id];
    console.log(`\n--- 用例 ${id.toUpperCase()}：${label} ---`);
    console.log(`    输入：${note}`);
    try {
        const gen = await generateImage({
            apiKey,
            baseUrl,
            model,
            prompt: PROMPT,
            images,
            size,
            outputFormat: 'png',
            background: 'transparent',
            watermark: false,
            responseFormat: 'b64_json',
            timeoutMs: 300000,
            retries: 1,
        });
        const buf = gen.images[0];
        const a = await alphaStats(buf);
        const file = path.join(OUT, `${id}.png`);
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(file, buf);
        const verdict = a.transparentRatio > 0.02 ? '✅ 真的透明' : a.hasAlpha ? '⚠️ 有 alpha 通道但全不透明（等于没透明）' : '❌ 连 alpha 通道都没有（不透明 PNG）';
        console.log(`    结果：${verdict}`);
        console.log(`    尺寸 ${a.width}x${a.height}  alpha 通道 ${a.hasAlpha}  alphaMin ${a.alphaMin}  透明像素 ${(a.transparentRatio * 100).toFixed(2)}%  半透明 ${(a.partialRatio * 100).toFixed(2)}%  ${Date.now() - t0}ms`);
        console.log(`    输出已存：${file}`);
        return { id, label, ok: true, alpha: a, verdict, ms: Date.now() - t0 };
    } catch (err) {
        console.log(`    接口报错：${err.code} (HTTP ${err.status || '-'})`);
        console.log(`    ${String(err.message).slice(0, 240)}`);
        const hint = explainError(err);
        if (hint) console.log(`    判读：${hint}`);
        return { id, label, ok: false, code: err.code, status: err.status, message: err.message, hint, ms: Date.now() - t0 };
    }
}

console.log(`\n=== background=transparent 真调用探查（花钱，${cases.length} 例）===`);
console.log(`模型 ${model}  尺寸 ${size}  baseUrl ${baseUrl}`);

const targetFile = path.join(ICONS, 'aegis.png');
const refFile = path.join(ICONS, 'desolator_2.png');
const opaquePng = path.join(ROOT, 'out', 'smoketest_aegis.png');

const results = [];
if (cases.includes('a')) {
    const ref = await loadInput(refFile);
    const tgt = await loadInput(targetFile);
    console.log(`\n[输入自检] 参考图 alpha 通道=${ref.alpha.hasAlpha} 透明像素=${(ref.alpha.transparentRatio * 100).toFixed(2)}%`);
    console.log(`[输入自检] 目标图 alpha 通道=${tgt.alpha.hasAlpha} 透明像素=${(tgt.alpha.transparentRatio * 100).toFixed(2)}%`);
    results.push(await runCase('a', { images: [ref.dataUrl, tgt.dataUrl], note: '风格参考图 + 目标图，两张都取自 dota2 图标（不透明）' }));
}
if (cases.includes('b')) {
    const tgt = await loadInput(targetFile);
    results.push(await runCase('b', { images: [tgt.dataUrl], note: '只发目标图（文件里有 alpha 通道，但像素全不透明）' }));
}
if (cases.includes('c')) {
    if (!fs.existsSync(opaquePng)) {
        console.log(`\n跳过用例 C：需要一张真有透明像素的输入图，当前找不到 ${opaquePng}`);
        console.log('（先跑一次色键抠图生成它，或改 --target 指定）');
    } else {
        const src = await loadInput(opaquePng);
        console.log(`\n[输入自检] 透明输入图 alpha 通道=${src.alpha.hasAlpha} 透明像素=${(src.alpha.transparentRatio * 100).toFixed(2)}%`);
        results.push(await runCase('c', { images: [src.dataUrl], note: `只发一张「真的有透明像素」的输入图（${path.basename(opaquePng)}）` }));
    }
}

console.log('\n=== 结论表 ===\n');
for (const r of results) {
    console.log(`  ${r.id.toUpperCase()}  ${r.label.padEnd(26)} ${r.ok ? r.verdict : `报错 ${r.code}`}`);
}
const summary = { at: Date.now(), model, size, results, inputs: { refFile, targetFile, transparentInput: opaquePng } };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`\n明细：${path.join(OUT, 'result.json')}`);
