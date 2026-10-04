/**
 * 离线自测：不调用任何接口，验证「色键抠图 → 裁边 → 补方形」这条链路。
 *
 *   node tests/alpha-test.mjs [图标目录]
 *
 * 做法：拿一张真图标当主体，合成到不同风格的背景上（模拟模型直出图），
 * 再跑一遍抠图，检查：背景被抠干净、主体保留、边缘没有背景色残留、裁边/补方形尺寸正确。
 * 覆盖四种「模型可能给我们的背景」：纯键色 / 渐变键色 / 完全换成别的纯色 / JPEG 压缩。
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readRaw, writePng, normalizeInput } from '../src/images.mjs';
import { chromaKey, trimTransparent, padToSquare, detectKeyColor } from '../src/alpha.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = process.argv[2] || 'E:\\project2\\AI\\dota2_equip\\output\\icons';
const TMP = path.join(ROOT, '.data', 'test');
fs.mkdirSync(TMP, { recursive: true });

const MAGENTA = [255, 0, 255];
const TEAL = [12, 42, 46];
let failures = 0;
function check(name, cond, detail = '') {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
}

/** 用 raw 像素造背景（radial > 0 时从中心底色渐变到角落的变暗版本） */
async function makeBackground(size, baseRgb, radial = 0) {
    const buf = Buffer.alloc(size * size * 3);
    const cx = size / 2;
    const cy = size / 2;
    const maxR = Math.hypot(cx, cy);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const t = radial > 0 ? Math.min(1, Math.hypot(x - cx, y - cy) / maxR) ** 1.5 : 0;
            const i = (y * size + x) * 3;
            buf[i] = Math.round(baseRgb[0] * (1 - t) + Math.max(0, baseRgb[0] - radial) * t);
            buf[i + 1] = Math.round(baseRgb[1] * (1 - t) + Math.max(0, baseRgb[1] + radial * 0.35) * t);
            buf[i + 2] = Math.round(baseRgb[2] * (1 - t) + Math.max(0, baseRgb[2] - radial) * t);
        }
    }
    return sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** 造一张「模型直出图」：背景 + 居中主体 */
async function makeFakeOutput(iconBuffer, { size = 1024, base = MAGENTA, radial = 0, jpeg = false, subjectScale = 0.6 } = {}) {
    const bg = await makeBackground(size, base, radial);
    // 这里是**造夹具**（合成一张"模型直出图"给抠图算法吃），所以显式允许放大：
    // 素材图标只有 88×64，不放大摆在 1024 画布上只占 0.5% 的画面，抠图断言全部失去意义。
    // 注意这与「送进接口的输入图」是两回事 —— 那条路径默认**不放大**（放大会糊掉风格信息）。
    const subj = await normalizeInput(iconBuffer, { inputMaxEdge: Math.round(size * subjectScale), allowUpscale: true });
    const meta = await sharp(subj.buffer).metadata();
    let img = sharp(bg).composite([
        {
            input: subj.buffer,
            top: Math.round((size - meta.height) / 2),
            left: Math.round((size - meta.width) / 2),
        },
    ]);
    return jpeg ? img.jpeg({ quality: 90 }).toBuffer() : img.png().toBuffer();
}

/**
 * 统计：
 *  - bgLeft  ：不透明且颜色接近背景色的像素（整体，主体自身的暗色也会被算进来）
 *  - edgeBg  ：其中**紧贴透明区**（≤3px）的那些 —— 这才是真正的「漏抠色边 / 光晕」
 *  - edgeLen ：不透明区与透明区交界处的像素数（用来把 edgeBg 归一成「平均色边厚度」）
 */
function analyze(img, base, tol = 25) {
    const { data, width, height } = img;
    const transparent = new Uint8Array(width * height);
    let bgLeft = 0;
    let semi = 0;
    let opaque = 0;
    for (let i = 0; i < width * height; i++) {
        const a = data[i * 4 + 3];
        if (a === 0) {
            transparent[i] = 1;
            continue;
        }
        if (a < 255) semi++;
        else opaque++;
        const p = i * 4;
        const d = Math.max(Math.abs(data[p] - base[0]), Math.abs(data[p + 1] - base[1]), Math.abs(data[p + 2] - base[2]));
        if (a > 200 && d <= tol) bgLeft++;
    }
    let edgeBg = 0;
    let edgeLen = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (transparent[i]) continue;
            let nearT = false;
            for (let dy = -3; dy <= 3 && !nearT; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (transparent[ny * width + nx]) {
                        nearT = true;
                        break;
                    }
                }
            }
            if (!nearT) continue;
            edgeLen++;
            const p = i * 4;
            const d = Math.max(Math.abs(data[p] - base[0]), Math.abs(data[p + 1] - base[1]), Math.abs(data[p + 2] - base[2]));
            if (d <= tol) edgeBg++;
        }
    }
    return { bgLeft, edgeBg, edgeLen, semi, opaque, total: width * height };
}

/**
 * 造一个「主体」：带硬边的彩色形状 + 内部一块接近键色的「宝石」。
 * 图标目录不存在时用它，让自测自包含；顺带覆盖「主体内部接近背景色的区域不能被抠掉」。
 */
async function makeSyntheticSubject(w = 300, h = 220) {
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = x - w / 2;
            const cy = y - h / 2;
            if (Math.hypot(cx / (w / 2), cy / (h / 2)) >= 1) continue; // 圆外透明
            const i = (y * w + x) * 4;
            const gem = Math.hypot(cx - w * 0.18, cy + h * 0.1) < Math.min(w, h) * 0.12;
            const outer = Math.hypot(cx, cy) > Math.min(w, h) * 0.45;
            const c = gem ? [210, 30, 200] : outer ? [60, 90, 140] : [200 - Math.round(y / 2), 150 + (x % 40), 60];
            buf[i] = c[0];
            buf[i + 1] = c[1];
            buf[i + 2] = c[2];
            buf[i + 3] = 255;
        }
    }
    return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

const files = fs.existsSync(ICON_DIR) ? fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.png')).slice(0, 3) : [];
const subjects = files.length
    ? files.map((f) => ({ name: f, buf: fs.readFileSync(path.join(ICON_DIR, f)) }))
    : [{ name: 'synthetic_subject.png', buf: await makeSyntheticSubject() }];
if (!files.length) console.log(`（图标目录不存在：${ICON_DIR}\n  改用内置合成主体，自测依然完整可跑）\n`);

console.log(`\n=== 抠图链路自测（主体：${subjects.map((s) => s.name).join(', ')}）===\n`);

const cases = [
    { title: '纯键色背景（模型照做了）· 自动探测键色', opts: { base: MAGENTA }, autoKey: true, expectMode: 'chroma' },
    { title: '纯键色背景 · 手动指定键色', opts: { base: MAGENTA }, autoKey: false, expectMode: 'chroma' },
    {
        title: '径向渐变背景（暗角）→ 按实测底色抠',
        opts: { base: MAGENTA, radial: 110 },
        autoKey: true,
        expectMode: 'chroma',
    },
    {
        title: '强力渐变 + 手动指定键色（边框已不是键色）→ 走「边框连续性」路径',
        opts: { base: MAGENTA, radial: 200 },
        autoKey: false,
        expectMode: 'frame',
    },
    { title: 'JPEG 压缩后再抠（接口只给 jpeg 的情况）', opts: { base: MAGENTA, jpeg: true }, autoKey: true, expectMode: 'chroma' },
    {
        title: '模型换了暗色背景（深青）→ 靠「颜色连续性」保住暗色主体',
        opts: { base: TEAL },
        autoKey: true,
        expectMode: 'chroma',
    },
    {
        title: '安全阀：把透明上限压到 50%（本例背景占 74%）→ 应整张回退不透明',
        opts: { base: MAGENTA },
        autoKey: true,
        expectMode: 'chroma',
        maxTransparent: 0.5,
        expectRevert: true,
    },
];

for (const subj of subjects) {
    console.log(`■ ${subj.name}`);
    for (const c of cases) {
        const fake = await makeFakeOutput(subj.buf, c.opts);
        const img = await readRaw(fake);
        const before = analyze(img, c.opts.base);
        const t0 = Date.now();
        const { stats } = chromaKey(img, {
            autoKey: c.autoKey,
            keyColor: '#FF00FF',
            tolerance: 68,
            localGrow: 14,
            despill: true,
            shrinkEdge: 1,
            maxTransparent: c.maxTransparent,
        });
        const ms = Date.now() - t0;
        const after = analyze(img, c.opts.base);

        console.log(`  · ${c.title}  [${stats.mode} / ${ms}ms]`);
        check(`走的是「${c.expectMode}」路径`, stats.mode === c.expectMode, `实际 ${stats.mode}`);

        if (c.expectRevert) {
            check('被安全阀拦下并回退（reverted）', stats.reverted === true, `wouldBe=${((stats.wouldBeTransparentRatio ?? 0) * 100).toFixed(1)}%`);
            check('图片没有被改动（整幅仍不透明）', after.opaque === after.total, `不透明 ${after.opaque}/${after.total}`);
            check('给出了可读的告警', stats.warnings.length > 0, stats.warnings[0]?.slice(0, 56));
            continue;
        }

        check('没有被安全阀回退', !stats.reverted);
        check('背景被抠掉（透明 55%~92%）', stats.transparentRatio > 0.55 && stats.transparentRatio < 0.92, `${(stats.transparentRatio * 100).toFixed(1)}%`);
        check('主体完整保留（有内容框）', !!stats.bbox, stats.bbox ? `${stats.bbox.w}×${stats.bbox.h}` : 'null');
        const share = stats.bbox ? (stats.bbox.w * stats.bbox.h) / after.total : 0;
        check('主体面积合理（占画面 18%~45%）', share > 0.18 && share < 0.45, `${(share * 100).toFixed(1)}%`);
        const fringe = after.edgeLen ? after.edgeBg / after.edgeLen : 0;
        check('平均色边厚度 < 2px（无漏抠色边/光晕）', fringe < 2, `${after.edgeBg}/${after.edgeLen} = ${fringe.toFixed(2)}px`);

        const trimmed = trimTransparent(img, 2);
        const squared = padToSquare(trimmed, { padRatio: 0.08 });
        check('裁边后尺寸变小', trimmed.trimmed === true, `${img.width}×${img.height} → ${trimmed.width}×${trimmed.height}`);
        check('补方形后是正方形', squared.width === squared.height, `${squared.width}×${squared.height}`);

        const fatal = ['抠图会去掉', '只判定出', '几乎没有可用的背景种子'];
        const bad = stats.warnings.filter((w) => fatal.some((k) => w.startsWith(k)));
        check('没有致命 QC 告警', bad.length === 0, bad.join('；') || '无');

        if (c === cases[0]) {
            const out = await writePng(squared.data, squared.width, squared.height, path.join(TMP, `out_${subj.name}`), { outSize: 512 });
            fs.writeFileSync(path.join(TMP, `raw_${subj.name}`), fake);
            const k = detectKeyColor(img.data, img.width, img.height);
            check('自动探测键色命中品红系', k[0] > 180 && k[1] < 90 && k[2] > 180, `rgb(${k.join(',')})`);
            console.log(`    产出：${out.path}（${out.width}×${out.height}）  直出图：raw_${subj.name}`);

            // 主体内部那块「接近键色的宝石」必须被保住（这是色键最容易翻车的地方）
            if (subj.name === 'synthetic_subject.png') {
                const { data, width, height } = await readRaw(fake);
                const scale = 614 / 300;
                const left = Math.round((1024 - 614) / 2);
                const top = Math.round((1024 - Math.round(220 * scale)) / 2);
                const gx = Math.round(left + 204 * scale);
                const gy = Math.round(top + 88 * scale);
                const gr = Math.round(26 * scale * 0.6);
                let n = 0;
                let aSum = 0;
                let rgb = [0, 0, 0];
                for (let y = gy - gr; y <= gy + gr; y++) {
                    for (let x = gx - gr; x <= gx + gr; x++) {
                        if ((x - gx) ** 2 + (y - gy) ** 2 > gr * gr) continue;
                        const p = (y * width + x) * 4;
                        aSum += data[p + 3];
                        rgb[0] += data[p];
                        rgb[1] += data[p + 1];
                        rgb[2] += data[p + 2];
                        n++;
                    }
                }
                const meanA = aSum / n;
                const meanRgb = rgb.map((v) => Math.round(v / n));
                check('主体内部「接近键色的宝石」没被误抠（alpha 仍不透明）', meanA > 200, `meanAlpha=${meanA.toFixed(0)}`);
                check('宝石颜色没被去溢色改掉', meanRgb[0] > 150 && meanRgb[2] > 150 && meanRgb[1] < 110, `rgb(${meanRgb.join(',')})`);
            }
        }
    }
    console.log('');
}

/* ------------------------------------------------------------------ 溢色抑制专项 */
// 构造「主体边缘被键色染了一圈」的图：把渐变上界人为收窄（rampAuto:false + 小容差），
// 让染色环以「不透明」留下来，专门验证「贴边溢色抑制」这条路径确实生效。
console.log('■ 贴边溢色抑制专项');
{
    const size = 512;
    const buf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 3;
            const r = Math.hypot(x - size / 2, y - size / 2);
            let c = [255, 0, 255]; // 背景：键色
            if (r < 152) c = [200, 40, 190]; // 被键色染色的过渡环
            if (r < 144) c = [140, 70, 40]; // 主体
            buf[i] = c[0];
            buf[i + 1] = c[1];
            buf[i + 2] = c[2];
        }
    }
    const img = await readRaw(await sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
    const { stats } = chromaKey(img, {
        autoKey: false,
        keyColor: '#FF00FF',
        tolerance: 24, // 故意小：渐变上界只到 ~38，染色环会以「不透明」留下
        rampAuto: false,
        localGrow: 12,
        despill: true,
        spillStrength: 0.9,
        shrinkEdge: 0,
    });
    check('溢色抑制确实被触发', (stats.spillPixelsFixed ?? 0) > 100, `${stats.spillPixelsFixed} px`);
    // 取染色环上「正好贴着背景」的那一圈（r≈151）验证颜色被拉离键色
    const { data } = img;
    const p = (256 * size + 256 + 151) * 4;
    const after = [data[p], data[p + 1], data[p + 2]];
    check('染色环被去溢色（红/蓝下降、绿回升）', after[0] < 198 && after[2] < 188 && after[1] > 42, `rgb(${after.join(',')}) ← 原 rgb(200,40,190)`);
    console.log('');
}

console.log(failures === 0 ? `全部通过 ✅  产出在 ${TMP}` : `有 ${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
