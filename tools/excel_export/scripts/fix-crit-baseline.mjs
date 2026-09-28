#!/usr/bin/env node
/**
 * fix-crit-baseline.mjs —— **暴击口径修复**（幂等）
 *
 * 背景（体检发现，见 `tools/attr-audit/`）：
 *   1. `attributes.json` 的**暴击倍率（属性 15）base = 100** → 运行时 1.0，
 *      而 `DamagePipeline.rollCrit` 要求 `倍率 > 1` 才可能暴击 → **全项目永远不会暴击**，
 *      暴击率词条（`[14, 14, "add"]`）纯装饰（打 300 次伤害值恒定）。
 *   2. 文案里承诺了「暴击倍率 +X%」的遗物，`kv.attrs` 里**根本没有属性 15** →
 *      即使修好 base，这些遗物的暴击倍率也不会变（代达罗斯之殇文案 +225%、英灵胸针 +80%）。
 *
 * 口径（真源 = `scripts/lib/affix-rules.mjs` 的 `CRIT_MULT_BASE` / `critTextToMultiplier`）：
 *   · 属性 15 的 base = **150**（1.5 倍）：只要暴击率为正就能打出 1.5 倍的暴击；
 *   · 配置值 int = 倍率 × 100（`225` = 225%），`stack_mode = best`（多件暴击装取最强一件生效，Dota 语义）；
 *   · 文案「暴击倍率 +X%」→ 配置值：`X ≥ 100` 视为绝对倍率（225 → 225），`X < 100` 视为相对加成（80 → 180）。
 *
 * 处理范围（**只动局内版** —— 局外链路还没接线，且局外属性走 int 口径的 flat/percent 两层）：
 *   · 黄档(epic) / 红档(legendary)：文案里写了暴击词条但 kv.attrs 缺 → **回填**（暴击率 14 / 暴击倍率 15）
 *   · 白/蓝档：百分比型属性黄档起，**不回填**（会把门禁打红）→ 只列进报告的「需人工定案」，
 *     由策划二选一：升档补词条，还是删掉越档文案
 *
 * 用法：
 *   node tools/excel_export/scripts/fix-crit-baseline.mjs            # 写盘 + 出报告
 *   node tools/excel_export/scripts/fix-crit-baseline.mjs --dry-run  # 只出报告不写盘
 *   ... --json-dir <目录>                                             # 换数据目录（默认 assets/resources/tb，便于在副本上试跑）
 *
 * 跑完必须回灌表格与复核：
 *   cd tools/excel_export && npm run import -- --force --table attributes,relics && npm run export && npm run verify && npm run check:affix
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ATTR_NAME, CRIT_MULT_ATTR, CRIT_MULT_BASE, CRIT_MULT_MODE, DESC_ATTR_ALIAS, TIER_LABEL,
    critTextToMultiplier, hasInnerSide, hasOuterSide, parseClauseTerms, relicSide, tierOfRarity,
} from './lib/affix-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
/** 数据目录（`--json-dir` 可换，便于在副本上试跑） */
const JSON_DIR = path.resolve(opt('--json-dir', path.join(ROOT, 'assets/resources/tb')));
const REPORT_FILE = path.join(ROOT, 'tools/excel_export/reports/crit-baseline-fix.md');
/** 只有在默认数据目录上跑才写报告（`--json-dir` 试跑不应覆盖正式报告） */
const WRITE_REPORT = JSON_DIR === path.join(ROOT, 'assets/resources/tb');

const DRY_RUN = argv.includes('--dry-run');

/** 暴击率属性编号（与 CRIT_MULT_ATTR 成对出现） */
const CRIT_RATE_ATTR = 14;

const report = [];
const log = (s = '') => report.push(s);
const stats = { baseChanged: 0, backfilledRate: 0, backfilledMult: 0, modeNormalized: 0, relics: 0 };
/** 需人工定案的条目（低档越档文案 / 局外版文案） */
const manual = [];

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(JSON_DIR, `${name}.json`), 'utf8'));
const writeJson = (name, data) => fs.writeFileSync(path.join(JSON_DIR, `${name}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');

/**
 * 从描述里抽出暴击词条 → `{ rate?: number, mult?: number }`
 * （`暴击率 +14%` / `暴击 +14%` → 暴击率；`暴击倍率 +225%` / `暴击伤害 +50%` → 暴击倍率）
 */
function parseCritTerms(desc) {
    const out = {};
    if (!desc) return out;
    for (const t of parseClauseTerms(desc)) {
        if (t.attrId === CRIT_RATE_ATTR) out.rate = Math.max(out.rate ?? 0, t.value);
        if (t.attrId === CRIT_MULT_ATTR) out.mult = Math.max(out.mult ?? 0, t.value);
    }
    return out;
}

// ============================ 1. attributes.json ============================

function fixAttributes(attrs) {
    log('## 1. attributes.json —— 暴击倍率 base 100 → 150');
    log();
    const crit = attrs.find((a) => a.id === CRIT_MULT_ATTR);
    if (!crit) {
        log(`> ⚠ 没找到属性 ${CRIT_MULT_ATTR}（${ATTR_NAME[CRIT_MULT_ATTR]}），跳过。`);
        log();
        return;
    }
    const before = crit.base;
    const min = crit.min ?? 0;
    if (before === CRIT_MULT_BASE) {
        log(`> 已是 ${CRIT_MULT_BASE}（1.5 倍），无需改动（幂等）。`);
        log();
        return;
    }
    crit.base = Math.max(CRIT_MULT_BASE, min);
    stats.baseChanged = crit.base !== before ? 1 : 0;
    log(`| 属性 | 字段 | 前 → 后 |`);
    log(`|---|---|---|`);
    log(`| ${CRIT_MULT_ATTR} ${ATTR_NAME[CRIT_MULT_ATTR]} | base | ${before} → **${crit.base}** |`);
    log();
    log(`> 为什么必须是 > 100：\`DamagePipeline.rollCrit\` 的判据是 \`chance > 0 && mult > 1\`，`);
    log('> base = 100 → 运行时 1.0 → 永远不满足 → 暴击率词条全部无效（体检实测：打 300 次伤害值恒定）。');
    log(`> 配置值 int 口径 = 倍率 × 100（\`AttributeScaling.SCALE[${CRIT_MULT_ATTR}] = 100\`），\`stack_mode = ${crit.stack_mode}\`（取最强一件生效）。`);
    log();
}

// ============================ 2. relics.json 局内版 ============================

function fixRelics(relics) {
    log('## 2. relics.json 局内版 —— 文案承诺的暴击词条回填 `kv.attrs`');
    log();
    log('| id | 遗物 | 档位 | 文案 | 回填 |');
    log('|---|---|---|---|---|');

    for (const r of relics) {
        if (!hasInnerSide(r)) continue;
        const tier = tierOfRarity(r.rarity);
        if (tier === 0) continue;

        const side = relicSide(r, 'inner');
        const crit = parseCritTerms(side.description);
        if (crit.rate === undefined && crit.mult === undefined) continue;

        const mods = (r.modifiers_inner ?? []).filter((m) => m?.kv?.attrs);
        const attrs = mods.flatMap((m) => m.kv.attrs);
        const hasRate = attrs.some((a) => a[0] === CRIT_RATE_ATTR);
        const hasMult = attrs.some((a) => a[0] === CRIT_MULT_ATTR);

        // ⓪ 已在表里的暴击倍率词条：叠加方式必须是 best（条目 mode 覆盖属性默认 mode，
        //    写 add 会变成 base + Σv 累加 —— `+225%` 会算成 1.5 + 2.25 = 375%）
        for (const a of attrs) {
            if (a[0] !== CRIT_MULT_ATTR || a[2] === CRIT_MULT_MODE) continue;
            log(`| ${r.id} | ${r.name} | ${TIER_LABEL[tier]} | ${side.description} | ${ATTR_NAME[CRIT_MULT_ATTR]} ${a[1]} 叠加方式 ${a[2] ?? 'add'} → **${CRIT_MULT_MODE}** |`);
            a[2] = CRIT_MULT_MODE;
            stats.modeNormalized++;
        }

        const wantRate = crit.rate !== undefined && !hasRate ? crit.rate : undefined;            // 暴击率：文案值即百分点
        const wantMult = crit.mult !== undefined && !hasMult ? critTextToMultiplier(crit.mult) : undefined;
        if (wantRate === undefined && wantMult === undefined) continue;

        if (tier < 3) {
            // 百分比型属性黄档起 —— 低档回填会把 check:affix 打红，交人工定案
            manual.push(`- **遗物 ${r.id} ${r.name}**（${TIER_LABEL[tier]}）：文案写了`
                + `${[wantRate !== undefined ? `暴击率 +${wantRate}%` : null, wantMult !== undefined ? `暴击倍率 ${wantMult}%` : null].filter(Boolean).join('、')}`
                + '，但百分比型属性**黄档起**（回填会把门禁打红）。二选一：**升档到黄档**并回填，或删掉这几条越档文案。');
            continue;
        }

        if (!mods.length) {
            // 这一侧没有任何 kv.attrs 载体（纯文案 / 只有专用 Modifier）—— 不凭空造属性块，交人工
            manual.push(`- **遗物 ${r.id} ${r.name}**（${TIER_LABEL[tier]}）：文案写了暴击词条，但这一侧没有任何 \`kv.attrs\` 载体（效果走专用 Modifier / 纯文案），未自动回填。`);
            continue;
        }

        const added = [];
        if (wantRate !== undefined) { attrs.push([CRIT_RATE_ATTR, wantRate, 'add']); added.push(`${ATTR_NAME[CRIT_RATE_ATTR]} +${wantRate}`); stats.backfilledRate++; }
        if (wantMult !== undefined) { attrs.push([CRIT_MULT_ATTR, wantMult, CRIT_MULT_MODE]); added.push(`${ATTR_NAME[CRIT_MULT_ATTR]} ${wantMult}%（${CRIT_MULT_MODE}）`); stats.backfilledMult++; }

        // 写回第一条带 attrs 的 Modifier（保持「一条共享模板引用」的形态）
        mods[0].kv.attrs = attrs;
        stats.relics++;
        log(`| ${r.id} | ${r.name} | ${TIER_LABEL[tier]} | ${side.description} | ${added.join('、')} |`);
    }

    log();
    log(`> 回填 ${stats.relics} 件：暴击率 ${stats.backfilledRate} 条、暴击倍率 ${stats.backfilledMult} 条。`);
    log('> 幂等：回填后 `kv.attrs` 已有该属性，重复执行不再命中。');
    log();

    // 局外版：文案提到暴击但没落表 → 只登记不自动改（局外属性链路尚未接线，且局外走 int 口径的 flat/percent 两层）
    for (const r of relics) {
        if (!hasOuterSide(r)) continue;
        const side = relicSide(r, 'outer');
        const crit = parseCritTerms(side.description);
        if (crit.rate === undefined && crit.mult === undefined) continue;
        const attrs = (r.modifiers_outer ?? []).flatMap((m) => m?.kv?.attrs ?? []);
        const missing = [];
        if (crit.rate !== undefined && !attrs.some((a) => a[0] === CRIT_RATE_ATTR)) missing.push(`暴击率 +${crit.rate}%`);
        if (crit.mult !== undefined && !attrs.some((a) => a[0] === CRIT_MULT_ATTR)) missing.push(`暴击倍率 ${critTextToMultiplier(crit.mult)}%`);
        if (missing.length) {
            manual.push(`- **遗物 ${r.id} ${r.name}** 局外版：文案写了 ${missing.join('、')}，但 \`modifiers_outer\` 里没有`
                + '（局外属性链路尚未接线，本次未处理）。');
        }
    }
}

// ============================ main ============================

function main() {
    log('# 暴击口径修复报告（fix-crit-baseline.mjs）');
    log();
    log(`生成时间：${new Date().toISOString()}${DRY_RUN ? '　**--dry-run（未写盘）**' : ''}`);
    log();

    const attrs = readJson('attributes');
    const relics = readJson('relics');

    fixAttributes(attrs);
    fixRelics(relics);

    log('## 3. 需人工定案');
    log();
    if (manual.length) for (const m of manual) log(m);
    else log('- （无）');
    log();
    log('## 4. 汇总');
    log();
    log('| 项 | 数量 |');
    log('|---|---|');
    log(`| attributes 暴击倍率 base 改动 | ${stats.baseChanged} |`);
    log(`| 回填暴击率 | ${stats.backfilledRate} |`);
    log(`| 回填暴击倍率 | ${stats.backfilledMult} |`);
    log(`| 暴击倍率词条叠加方式归一（→ ${CRIT_MULT_MODE}） | ${stats.modeNormalized} |`);
    log(`| 需人工定案 | ${manual.length} |`);
    log();

    const total = stats.baseChanged + stats.backfilledRate + stats.backfilledMult + stats.modeNormalized;
    if (DRY_RUN) {
        console.log(report.join('\n'));
        console.log('\n（--dry-run：未写盘）');
        return;
    }
    if (total === 0) {
        console.log('✔ 本次无任何改动（幂等重跑）：暴击口径已符合规则，未写盘、报告保持原样。');
        return;
    }

    if (stats.baseChanged) writeJson('attributes', attrs);
    if (stats.backfilledRate + stats.backfilledMult + stats.modeNormalized > 0) writeJson('relics', relics);

    if (WRITE_REPORT) {
        fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
        fs.writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
    } else {
        console.log(report.join('\n'));
    }

    console.log(`✔ 已写盘：${path.relative(ROOT, JSON_DIR)} 的 ${[stats.baseChanged ? 'attributes.json' : null, (stats.backfilledRate + stats.backfilledMult + stats.modeNormalized) ? 'relics.json' : null].filter(Boolean).join(' / ')}`);
    if (WRITE_REPORT) console.log(`✔ 报告：${path.relative(ROOT, REPORT_FILE)}`);
    if (WRITE_REPORT) console.log('\n接着执行：cd tools/excel_export && npm run import -- --force --table attributes,relics && npm run export && npm run verify && npm run check:affix');
}

main();
