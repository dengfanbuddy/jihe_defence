#!/usr/bin/env node
/**
 * check-drift.mjs —— **试听页 / 素材 / 真源配置 三方对账**（打击反馈音效 B4）
 *
 * 回答的问题：**`HitFeelConfig.ts` 里改了音量或变了键名之后，「试听页听到的」和「盘上的文件」
 * 还是不是同一件事？**
 *
 * 三个对账对象：
 *   ① **真源** = `assets/scripts/game/common/HitFeelConfig.ts`
 *      （档位表 `sfx` / `sfxVolume` / `sfxVariants`、非档位表 `HIT_FEEL_SFX_EXTRA`、节流 `HIT_FEEL_BUDGET.sfx*`）
 *      —— 由本脚本**文本解析**得到，不编译、不 import TS。
 *   ② **试听页** = `audition.html` 里 `DRIFT:BEGIN/END` 之间那段 JSON —— 试听页只认它。
 *   ③ **素材** = `assets/resources/sfx/*.wav` 的文件名集合。
 *
 * 为什么需要它（这不是"多余的仪式"）：
 *   试听页是纯静态 HTML，它没法在 `file://` 下 import TypeScript；如果不做对账，
 *   "配置改了、试听页还是旧数字"这件事**没有任何东西会发现** —— 而那正是最容易发生的漂移
 *   （改音量的人不会想到要去翻一个 html）。同类先例见 `tools/hit-feel-preview/check-drift.mjs`。
 *
 * 与另外两个工具的分工（**三个各管一段，别互相替代**）：
 *   · `render.mjs --check`  ← 字节层：盘上的 wav 与 `design.mjs` 的配方是否逐字节一致
 *   · `check-drift.mjs`（本文件）← 口径层：配置 ↔ 试听页 ↔ **文件是否齐全**（**素材门禁**，缺文件即失败）
 *   · `npm run audit:hitfeel` 组 ⑰ ← 代码层：节流账本真的成立吗（缺素材只警告，不卡代码门禁）
 *
 * 用法：
 *   node tools/hit-feel-sfx/check-drift.mjs            # 对账（有漂移 → 退出码 1）
 *   node tools/hit-feel-sfx/check-drift.mjs --write     # 用真源重写试听页里那段 JSON（改完配置跑这个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CONFIG = path.join(ROOT, 'assets/scripts/game/common/HitFeelConfig.ts');
const AUDITION = path.join(HERE, 'audition.html');
const SFX_DIR = path.join(ROOT, 'assets/resources/sfx');

const BEGIN = '<!-- DRIFT:BEGIN';
const END = '<!-- DRIFT:END -->';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '   ' + detail : ''}`);
    return cond;
};

// ============================ ① 解析真源 ============================

/**
 * 取 `[HitFeelTier.Xxx]: { ... }` 这一段的正文。
 *
 * 为什么用文本解析而不是编译：本脚本要能被"只装了 node"的人直接跑
 * （编译 TS 需要 typescript 包 + 打桩，那是 `audit:hitfeel` 的活）。
 * 代价是**解析失败必须响** —— 见下面 `num()` / `str()` 的兜底。
 */
function tierBlocks(src) {
    const out = new Map();
    const re = /\[HitFeelTier\.(\w+)\]:\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        const from = m.index + m[0].length;
        const next = src.indexOf('[HitFeelTier.', from);
        const endBrace = src.indexOf('\n};', from);
        let to = src.length;
        if (next > 0) to = Math.min(to, next);
        if (endBrace > 0) to = Math.min(to, endBrace);
        out.set(m[1], src.slice(from, to));
    }
    return out;
}

const num = (body, key) => {
    const m = new RegExp('\\b' + key + ':\\s*(-?[0-9.]+)').exec(body);
    return m ? Number(m[1]) : null;
};
const str = (body, key) => {
    // 同时接受单引号与双引号（源码里现在用单引号）
    const m = new RegExp('\\b' + key + ":\\s*(['\"])(.*?)\\1").exec(body);
    return m ? m[2] : null;
};

function parseTruth() {
    const src = fs.readFileSync(CONFIG, 'utf8');
    const problems = [];

    const blocks = tierBlocks(src);
    if (blocks.size === 0) problems.push('真源解析失败：一个 `[HitFeelTier.*]` 档位块都没找到（表结构被改过？）');

    const tiers = [];
    for (const [tier, body] of blocks) {
        const sfx = str(body, 'sfx');
        const volume = num(body, 'sfxVolume');
        const variants = num(body, 'sfxVariants');
        if (sfx === null || volume === null || variants === null) {
            problems.push(`真源解析失败：档位 ${tier} 的 sfx / sfxVolume / sfxVariants 没能全解析出来`);
            tiers.push({ tier, sfx: null, volume: null, variants: null, error: true });
            continue;
        }
        tiers.push({ tier, sfx, volume, variants });
    }
    // ⚠ **顺序按源码出现顺序（= T0 → T7）**，不要排序：
    //   试听页的表就是要按"力度台阶"从上往下读，字母序会把它变成 kill_big → hit_boss → clear 这种随机顺序
    //   （落地时真踩过：第一版排了序，页面上第一个音变成了 T5）。

    const extra = {};
    const extraBlock = /export const HIT_FEEL_SFX_EXTRA = \{([\s\S]*?)\n\} as const;/.exec(src);
    if (!extraBlock) {
        problems.push('真源解析失败：找不到 `HIT_FEEL_SFX_EXTRA` 表');
    } else {
        const re = /(\w+):\s*\{\s*key:\s*(['"])(.*?)\2\s*,\s*volume:\s*(-?[0-9.]+)\s*,\s*variants:\s*(-?[0-9.]+)\s*\}/g;
        let m;
        while ((m = re.exec(extraBlock[1]))) {
            extra[m[1]] = { key: m[3], volume: Number(m[4]), variants: Number(m[5]) };
        }
        if (Object.keys(extra).length === 0) problems.push('真源解析失败：`HIT_FEEL_SFX_EXTRA` 里一条都没解析出来');
    }

    const budget = {
        sfxWindowMs: /sfxWindowMs:\s*(-?[0-9.]+)/.exec(src) ? Number(/sfxWindowMs:\s*(-?[0-9.]+)/.exec(src)[1]) : null,
        sfxMaxPerWindow: /sfxMaxPerWindow:\s*(-?[0-9.]+)/.exec(src) ? Number(/sfxMaxPerWindow:\s*(-?[0-9.]+)/.exec(src)[1]) : null,
    };
    if (budget.sfxWindowMs === null || budget.sfxMaxPerWindow === null) {
        problems.push('真源解析失败：`HIT_FEEL_BUDGET` 里的 sfxWindowMs / sfxMaxPerWindow 没解析出来');
    }

    const suffixMatch = /HIT_FEEL_SFX_VARIANT_SUFFIXES = \[(.*?)\]\s*as const/s.exec(src);
    const variantSuffixes = suffixMatch
        ? (suffixMatch[1].match(/'[^']*'/g) ?? []).map((s) => s.slice(1, -1))
        : [];
    if (variantSuffixes.length === 0) problems.push('真源解析失败：变体后缀表没解析出来');

    return {
        truth: {
            source: 'assets/scripts/game/common/HitFeelConfig.ts',
            note: '本段由 tools/hit-feel-sfx/check-drift.mjs 从真源生成，别手改；改配置后跑 `node check-drift.mjs --write`',
            tiers,
            extra,
            budget,
            variantSuffixes,
        },
        problems,
    };
}

/** 真源 → 应该存在的全部 .wav 文件名（不含扩展名） */
function expectedFiles(truth) {
    const keys = [];
    const push = (base, variants) => {
        if (!base) return;
        const n = Math.max(1, variants | 0);
        for (let i = 0; i < n; i++) {
            const r = i / n >= 1 ? 0.999999 : i / n;
            const suffix = n <= 1 ? '' : (truth.variantSuffixes[Math.floor(r * n)] ?? '');
            const k = base + suffix;
            if (keys.indexOf(k) < 0) keys.push(k);
        }
    };
    for (const t of truth.tiers) if (!t.error) push(t.sfx, t.variants);
    for (const k of Object.keys(truth.extra)) push(truth.extra[k].key, truth.extra[k].variants);
    // `click` 由平台层 `AudioMgr.defaultTouchStart` 写死引用（游戏层配置里没有它），
    // 但它同样必须是盘上的文件 —— 否则每次触摸都会走一次加载失败
    if (keys.indexOf('click') < 0) keys.push('click');
    return keys.sort();
}

// ============================ ② 对账 ============================

function readSnapshot(html) {
    const b = html.indexOf(BEGIN);
    const e = html.indexOf(END);
    if (b < 0 || e < 0 || e < b) return { error: 'audition.html 里找不到 DRIFT:BEGIN/END 标记' };
    const seg = html.slice(b, e);
    const m = /<script id="tierTable" type="application\/json">([\s\S]*?)<\/script>/.exec(seg);
    if (!m) return { error: 'DRIFT 段里找不到 <script id="tierTable">' };
    try {
        return { json: JSON.parse(m[1]), begin: b, end: e, seg, raw: m[1] };
    } catch (err) {
        return { error: 'DRIFT 段里的 JSON 解析失败：' + err.message };
    }
}

function buildBlock(truth) {
    // 缩进与 HTML 保持一致（4 空格），并且**每行一个字段**：这样 git diff 是可读的
    const json = JSON.stringify(truth, null, 4).split('\n').map((l) => '    ' + l).join('\n');
    return [
        BEGIN + ' —— 这一段由 `node check-drift.mjs --write` 从 HitFeelConfig.ts 生成，别手改 -->',
        '    <script id="tierTable" type="application/json">',
        json,
        '    </script>',
    ].join('\n');
}

function main() {
    const write = process.argv.includes('--write');
    console.log('\n打击反馈音效 · 试听页 / 素材 / 真源 三方对账（docs/打击反馈设计.md §12）');
    console.log('真源：assets/scripts/game/common/HitFeelConfig.ts');
    console.log('='.repeat(96));

    const { truth, problems } = parseTruth();
    console.log('\n① 解析真源');
    ok('真源解析成功（每个档位都拿到了 sfx / sfxVolume / sfxVariants）',
        problems.length === 0, problems.length ? problems.join('；') : `${truth.tiers.length} 档 + ${Object.keys(truth.extra).length} 个非档位音`);
    if (problems.length) {
        console.log('\n解析失败就不该继续对账（否则会拿一张空表去"校验"别的东西）→ 退出码 1');
        process.exit(1);
    }
    ok('节流口径解析到位', truth.budget.sfxWindowMs > 0 && truth.budget.sfxMaxPerWindow > 0,
        `${truth.budget.sfxWindowMs}ms / ${truth.budget.sfxMaxPerWindow} 声`);
    ok('变体后缀表解析到位', truth.variantSuffixes.length >= 3, JSON.stringify(truth.variantSuffixes));

    const expected = expectedFiles(truth);
    console.log(`\n② 素材是否齐全（应存在 ${expected.length} 个 .wav）`);
    let onDisk = [];
    try {
        onDisk = fs.readdirSync(SFX_DIR).filter((f) => /\.wav$/i.test(f)).map((f) => f.replace(/\.wav$/i, '')).sort();
    } catch (e) {
        onDisk = [];
    }
    const missing = expected.filter((k) => onDisk.indexOf(k) < 0);
    const orphans = onDisk.filter((k) => expected.indexOf(k) < 0);
    ok('每个应存在的音效文件都在盘上', missing.length === 0,
        missing.length ? `缺 ${missing.length} 个：${missing.join(', ')}（跑 node render.mjs 生成）` : `盘上 ${onDisk.length} 个`);
    ok('盘上没有"孤儿文件"（多出来的 wav 说明配置删了键但素材没清）', orphans.length === 0,
        orphans.length ? `多 ${orphans.length} 个：${orphans.join(', ')}` : '一一对应');

    console.log('\n③ 试听页快照是否等于真源');
    const html = fs.readFileSync(AUDITION, 'utf8');
    const snap = readSnapshot(html);
    if (snap.error) {
        ok('试听页可解析', false, snap.error);
    } else {
        const same = JSON.stringify(snap.json) === JSON.stringify(truth);
        if (same) {
            ok('audition.html 的 DRIFT 段与真源一致（改音量/键名后没跑 --write 就会在这里红）', true,
                `${truth.tiers.length} 档 / ${Object.keys(truth.extra).length} 个非档位音`);
        } else if (write) {
            const next = html.slice(0, snap.begin) + buildBlock(truth) + html.slice(snap.end);
            fs.writeFileSync(AUDITION, next);
            console.log('  → 已用真源重写 audition.html 的 DRIFT 段（--write）');
            ok('重写后与真源一致', true);
        } else {
            const diff = [];
            if (snap.json.tiers?.length !== truth.tiers.length) diff.push(`档位数 ${snap.json.tiers?.length} → ${truth.tiers.length}`);
            for (const t of truth.tiers) {
                const old = (snap.json.tiers ?? []).find((x) => x.tier === t.tier);
                if (!old) { diff.push(`新增档位 ${t.tier}`); continue; }
                if (old.sfx !== t.sfx) diff.push(`${t.tier}.sfx ${old.sfx} → ${t.sfx}`);
                if (old.volume !== t.volume) diff.push(`${t.tier}.volume ${old.volume} → ${t.volume}`);
                if (old.variants !== t.variants) diff.push(`${t.tier}.variants ${old.variants} → ${t.variants}`);
            }
            for (const k of Object.keys(truth.extra)) {
                const old = snap.json.extra?.[k];
                if (!old || old.key !== truth.extra[k].key || old.volume !== truth.extra[k].volume) {
                    diff.push(`非档位音 ${k}`);
                }
            }
            if (JSON.stringify(snap.json.budget) !== JSON.stringify(truth.budget)) diff.push('节流口径');
            ok('audition.html 的 DRIFT 段与真源一致', false,
                diff.slice(0, 6).join('；') + (diff.length > 6 ? ` …共 ${diff.length} 处` : '')
                + '　→ 跑 `node check-drift.mjs --write` 同步');
        }
    }

    /* ④ 与 render.mjs 的档位表快照交叉对账
       ----------------------------------------------------------------------------------------
       现在有**两个各自独立实现**的 `HitFeelConfig.ts` 解析器：本文件的 `parseTruth()`，
       和 `render.mjs` 里那份（它产出 `tier-table.json`，是"渲染器自己认不认这份配置"的依据）。
       两份实现互相对不上的时候，恰恰是最值得喊一声的时候 —— 真实先例就发生在这次的落地过程中：
       `render.mjs` 第一版把**数组字面量**当对象做括号配对，后缀表静默解析成 `['']`，
       于是 5 个 `_v2/_v3` 被误判成"没人引用"。单一实现发现不了这种错，两个实现交叉就能。
       注意分工：**它**管"渲染器 ↔ 配方 ↔ 素材引用集"，**本文件**管"试听页 ↔ 真源 ↔ 素材文件"。 */
    console.log('\n④ 与 render.mjs 的 tier-table.json 交叉对账（两个独立解析器必须得出同一个答案）');
    const tierPath = path.join(HERE, 'tier-table.json');
    if (!fs.existsSync(tierPath)) {
        console.log('  · 没有 tier-table.json（不影响本页对账；`node render.mjs` 会生成它）');
    } else {
        let other = null;
        try {
            other = JSON.parse(fs.readFileSync(tierPath, 'utf8'));
        } catch (err) {
            other = null;
        }
        ok('tier-table.json 能被解析', !!other);
        if (other) {
            const pair = (list) => JSON.stringify((list ?? []).map((t) => [t.tier, t.sfx, t.volume, t.variants]));
            ok('两份 tier 表逐档一致（档位名 / 键名 / 音量 / 变体数）',
                pair(other.tiers) === pair(truth.tiers),
                pair(other.tiers) === pair(truth.tiers) ? `${truth.tiers.length} 档` : `tier-table: ${pair(other.tiers)}\n      本文件: ${pair(truth.tiers)}`);
            const extraEq = (a, b) => {
                const ka = Object.keys(a ?? {}).sort();
                const kb = Object.keys(b ?? {}).sort();
                if (ka.join(',') !== kb.join(',')) return false;
                return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
            };
            ok('两份非档位音表一致', extraEq(other.extra, truth.extra),
                JSON.stringify(other.extra) + ' vs ' + JSON.stringify(truth.extra));
            ok('两份节流口径一致', JSON.stringify(other.budget) === JSON.stringify(truth.budget),
                JSON.stringify(other.budget));
        }
    }

    console.log('\n' + '='.repeat(96));
    if (fail === 0) console.log(`通过 ${pass} 条，全部通过`);
    else console.log(`通过 ${pass} 条，**失败 ${fail} 条**`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
