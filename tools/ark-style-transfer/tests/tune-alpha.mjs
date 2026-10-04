/**
 * 抠图参数调参台：拿**已经生成的直出图**（`out/_raw/*.png`）反复试抠图参数。
 *
 *   node tests/tune-alpha.mjs out/_raw/xxx.png [输出对照图.png]
 *
 * 为什么不直接用界面上的「只重跑抠图」：调参要试很多组，这里一次跑完所有组合并打出
 * 「贴边杂边厚度」等客观指标，不用一张张看。全程不调接口、不花钱。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRaw, writePng } from '../src/images.mjs';
import { chromaKey, trimTransparent, padToSquare, detectKeyColor } from '../src/alpha.mjs';
import { DEFAULT_PARAMS } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'out', '_raw');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : null;

/** 客观指标：贴边「杂边厚度」= 贴边像素里带键色味的比例（越小越好） */
function edgeScore(img) {
    const { data, width: w, height: h } = img;
    let transparent = 0;
    let edgeLen = 0;
    let fringe = 0;
    for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] === 0) transparent++;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            if (data[p + 3] === 0) continue;
            let near = false;
            for (let dy = -3; dy <= 3 && !near; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    if (data[(ny * w + nx) * 4 + 3] === 0) {
                        near = true;
                        break;
                    }
                }
            }
            if (!near) continue;
            edgeLen++;
            const r = data[p];
            const g = data[p + 1];
            const b = data[p + 2];
            if (r > 90 && b > 90 && g < Math.min(r, b) - 45) fringe++;
        }
    }
    return { transparent: transparent / (w * h), edgeLen, fringe, perEdge: fringe / Math.max(1, edgeLen) };
}

let src = SRC;
if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    const f = fs.readdirSync(src).filter((x) => /\.(png|jpe?g)$/i.test(x))[0];
    if (!f) {
        console.error(`目录里没有直出图：${src}`);
        process.exit(1);
    }
    src = path.join(src, f);
}
if (!fs.existsSync(src)) {
    console.error(`找不到直出图：${src}\n（先跑一张生成，或指定 out/_raw 下的文件）`);
    process.exit(1);
}

const srcBuf = fs.readFileSync(src);
const base = { autoKey: true, keyColor: '#FF00FF', tolerance: DEFAULT_PARAMS.keyTolerance, localGrow: 14, shrinkEdge: 1, despill: true };
const cases = [
    { name: `当前默认（容差 ${base.tolerance}）`, o: {} },
    { name: '旧默认 容差 68', o: { tolerance: 68 } },
    { name: '自适应渐变关闭（旧行为）', o: { rampAuto: false } },
    { name: '默认 + 收边 2px', o: { shrinkEdge: 2 } },
    { name: '容差 50（更保守，防啃主体）', o: { tolerance: 50 } },
    { name: '容差 90', o: { tolerance: 90 } },
    { name: '容差 110（激进）', o: { tolerance: 110 } },
    { name: '去溢色 1.0', o: { spillStrength: 1.0 } },
];

console.log(`\n=== 抠图调参（源：${path.relative(ROOT, src)}）===\n`);

if (process.argv.includes('--diag')) {
    // 诊断：背景底色到底有多"干净"？决定容差该给多大。
    const img = await readRaw(srcBuf);
    const { data, width: w, height: h } = img;
    const K = detectKeyColor(data, w, h);
    const ring = [];
    for (let x = 0; x < w; x++) for (let r = 0; r < 2; r++) ring.push([x, r], [x, h - 1 - r]);
    for (let y = 0; y < h; y++) for (let r = 0; r < 2; r++) ring.push([r, y], [w - 1 - r, y]);
    const dists = ring.map(([x, y]) => {
        const p = (y * w + x) * 4;
        return Math.max(Math.abs(data[p] - K[0]), Math.abs(data[p + 1] - K[1]), Math.abs(data[p + 2] - K[2]));
    }).sort((a, b) => a - b);
    const q = (f) => dists[Math.min(dists.length - 1, Math.floor(dists.length * f))];
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    const sd = Math.sqrt(dists.reduce((a, b) => a + (b - mean) ** 2, 0) / dists.length);
    // 从边框泛洪后，背景区里离键色的距离分布
    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
        const i = y * w + x;
        if (seen[i]) return;
        const p = i * 4;
        const d = Math.max(Math.abs(data[p] - K[0]), Math.abs(data[p + 1] - K[1]), Math.abs(data[p + 2] - K[2]));
        if (d > 160) return;
        seen[i] = 1;
        stack.push(x, y);
    };
    for (const [x, y] of ring) push(x, y);
    const inside = [];
    while (stack.length) {
        const y = stack.pop();
        const x = stack.pop();
        const p = (y * w + x) * 4;
        inside.push(Math.max(Math.abs(data[p] - K[0]), Math.abs(data[p + 1] - K[1]), Math.abs(data[p + 2] - K[2])));
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < h - 1) push(x, y + 1);
    }
    inside.sort((a, b) => a - b);
    const qi = (f) => inside[Math.min(inside.length - 1, Math.floor(inside.length * f))];
    console.log(`键色（自动探测）: rgb(${K.join(',')})  = #${K.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    console.log(`边框像素到键色的距离: min ${dists[0]} / p50 ${q(0.5)} / p90 ${q(0.9)} / p99 ${q(0.99)} / max ${dists[dists.length - 1]}  σ=${sd.toFixed(1)}`);
    console.log(`泛洪背景区（${inside.length} px = ${(inside.length / (w * h) * 100).toFixed(1)}%）距离: p50 ${qi(0.5)} / p90 ${qi(0.9)} / p99 ${qi(0.99)} / max ${inside[inside.length - 1]}`);
    const p99 = qi(0.99);
    console.log(`\n建议：容差 ≥ ${Math.max(40, Math.round(p99 * 1.1))}（覆盖背景区 99% 的距离），当前默认 68`);
    console.log('说明：容差太小 → 背景边上的过渡带抠不掉（留一圈色边）；太大 → 主体边缘被啃。');
    process.exit(0);
}

let best = null;
for (const c of cases) {
    const img = await readRaw(srcBuf);
    const t0 = Date.now();
    const { stats } = chromaKey(img, { ...base, ...c.o });
    let out = trimTransparent(img, 2);
    out = padToSquare(out, { padRatio: 0.08 });
    const s = edgeScore(out);
    const line = `${c.name.padEnd(30)} 透明 ${(s.transparent * 100).toFixed(1).padStart(5)}%  贴边 ${String(s.edgeLen).padStart(5)}px  杂边 ${String(s.fringe).padStart(5)} = ${s.perEdge.toFixed(3)}px  渐变上界 ${String(stats.rampHi ?? '-').padStart(3)}  溢色修正 ${String(stats.spillPixelsFixed ?? 0).padStart(5)}  ${Date.now() - t0}ms`;
    console.log(line);
    if (!best || s.perEdge < best.perEdge) best = { ...s, name: c.name, o: c.o };
    if (OUT && c.name.includes('当前默认')) await writePng(out.data, out.width, out.height, OUT, { outSize: 512 });
}

console.log(`\n最好的一组：${best.name}（杂边 ${best.perEdge.toFixed(3)}px）`);
console.log('口径：杂边厚度 < 0.3px 基本看不出来；> 1px 就会看到一圈键色描边。');
if (OUT) console.log(`对照图已写到 ${OUT}`);
