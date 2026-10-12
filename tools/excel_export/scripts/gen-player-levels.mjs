#!/usr/bin/env node
/**
 * gen-player-levels.mjs — 账号等级表生成器（**设计真源** → `assets/resources/tb/player_levels.json`）
 *
 * 为什么要重新定这条曲线（2026-11）：成就「指挥官之路」改成**每 5 级一阶、直到 100 级**（20 阶），
 * 而旧表只到 30 级、且是 **×1.2 的指数曲线** —— 那个曲线**没法往 100 级延**：
 * 30 级单级已是 16,480 经验（约 2 周），照 ×1.2 推到 100 级单级要 5.7e9（几十年）。
 * 所以整条曲线重新定，判据是**两段式**：
 *
 *   ① **1~10 级原样保留**（100/120/140/170/210/250/300/360/430/520）—— 新手前几天的节奏是被调过的；
 *   ② **10 级起改线性 +100/级**（520 → 9,420），到 100 级累计 **449,900** 经验。
 *
 * 折算成时间（活跃玩家：日任务 400 + 周任务摊 400 + 账号经验册 300 ≈ **1,100 经验/天**）：
 *
 *   | 里程碑 | 累计经验 | 约需 | 旧曲线（×1.2） |
 *   |---|---|---|---|
 *   | Lv10 | 2,600 | 2 天 | 2 天 |
 *   | Lv20 | 12,300 | 11 天 | 11 天 |
 *   | **Lv30** | **32,000** | **1 个月** | 89 天（旧满级） |
 *   | Lv50 | 101,400 | 3 个月 | — |
 *   | **Lv100** | **449,900** | **≈13.5 个月** | 不可达 |
 *
 * ⚠ **代价（有意接受）**：20 级以前两条曲线几乎重合，**21~30 级这一段快 3 倍**
 *   （旧满级 3 个月 → 新 30 级 1 个月）。这是"100 级"的必然代价：等级上限抬到 100 之后，
 *   满级要留在长线目标的位置上，就不能让前 30 级再占掉 3 个月。已按用户口径接受。
 *
 * 升级金币：**2~30 级原样保留**（30~800，合计 7,970），31~99 级 = 120（整十级 +180），
 *   100 级（满级）= 800 —— 全表合计 **18,130** 金 / 约 13.5 个月 ≈ 45 金/天，
 *   相对"日任务 330 + 商城 700"的日循环是**零头**，不会重演"局外金币产出过快"。
 *
 * 用法：`node tools/excel_export/scripts/gen-player-levels.mjs [--dry-run]`
 *   写完 JSON 后回灌 xlsx：`cd tools/excel_export && node src/cli.ts json2excel --force --table player_levels`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, 'assets/resources/tb/player_levels.json');

/** 满级等级（表里 `exp = 0` 的那一行；`LevelConfig.getMaxLevel()` 读的就是它） */
const MAX_LEVEL = 100;

/** ① 1~9 级「升到下一级」所需经验（**沿用旧表，别改**：新手前几天的节奏是按它调的） */
const EARLY_EXP = [100, 120, 140, 170, 210, 250, 300, 360, 430];

/** ② 10 级起的线性段：exp(n) = BASE + (n − 10) × STEP */
const LINEAR_FROM = 10;
const LINEAR_BASE = 520;    // = 旧表的 10 级（接得上 EARLY_EXP）
const LINEAR_STEP = 100;

/** ③ 升级金币：2~30 级沿用旧表（末位 800 是旧的"满级奖励"，现在只是普通一级） */
const EARLY_GOLD = [
    30, 50, 70, 80, 100, 120, 130, 150, 170, 180,
    200, 210, 230, 250, 260, 280, 300, 310, 330, 350,
    360, 380, 400, 410, 430, 450, 460, 480, 800,
];
/** 31 级起的常规金币 / 整十级加给 / 满级一次性 */
const LATE_GOLD = 120;
const LATE_GOLD_DECADE = 180;
const MAX_LEVEL_GOLD = 800;

/** 功能解锁（解锁一次永久有效；`LevelConfig.hasFeature` 按「任意 ≤ level 的行声明过」判定） */
const FEATURES = {
    1: { unlock_features: ['daily_task'], desc: '解锁：每日任务' },
    3: { unlock_features: ['weekly_task'], desc: '解锁：每周任务' },
    5: { unlock_features: ['relic_outer'], desc: '解锁：局外遗物' },
    15: { unlock_features: ['relic_outer_upgrade'], desc: '解锁：遗物升阶' },
    100: { unlock_features: ['all_content'], desc: '解锁：全部内容（满级）' },
};

/* ===================================================================
 * 曲线
 * =================================================================== */

/** 从 level 升到下一级所需经验（满级 = 0） */
function expOf(level) {
    if (level >= MAX_LEVEL) return 0;
    if (level < LINEAR_FROM) return EARLY_EXP[level - 1];
    return LINEAR_BASE + (level - LINEAR_FROM) * LINEAR_STEP;
}

/** 升到 level 时的一次性金币奖励 */
function goldOf(level) {
    if (level <= 1) return 0;
    if (level <= 30) return EARLY_GOLD[level - 2];
    if (level >= MAX_LEVEL) return MAX_LEVEL_GOLD;
    return LATE_GOLD + (level % 10 === 0 ? LATE_GOLD_DECADE : 0);
}

/* ===================================================================
 * 生成
 * =================================================================== */

const rows = [];
for (let level = 1; level <= MAX_LEVEL; level++) {
    const row = { id: level, exp: expOf(level), reward_gold: goldOf(level) };
    const feat = FEATURES[level];
    if (feat) {
        row.unlock_features = feat.unlock_features;
        row.desc = feat.desc;
    }
    rows.push(row);
}

// ── 生成期自检 ──
const problems = [];
for (let i = 1; i < rows.length - 1; i++) {
    if (!(rows[i].exp > rows[i - 1].exp)) problems.push(`Lv${i + 1} 经验未递增：${rows[i - 1].exp} → ${rows[i].exp}`);
}
if (rows[rows.length - 1].exp !== 0) problems.push('满级的 exp 必须是 0');

/** 累计到某级所需的总经验（含该级之前的全部） */
const cum = (lv) => rows.slice(0, lv - 1).reduce((s, r) => s + r.exp, 0);
const totalGold = rows.reduce((s, r) => s + r.reward_gold, 0);
const PER_DAY = 1100;   // 日 400 + 周 2800/7 + 账号经验册 300

console.log(`等级表生成：${rows.length} 行（满级 Lv${MAX_LEVEL}）`);
console.log(`  升级金币合计 ${totalGold}（≈ ${(totalGold / (cum(MAX_LEVEL) / PER_DAY)).toFixed(0)} 金/天）`);
for (const lv of [5, 10, 15, 20, 30, 50, 75, 100]) {
    const c = cum(lv);
    console.log(`  Lv${String(lv).padStart(3)}：本级需 ${String(rows[lv - 1].exp).padStart(5)}，`
        + `累计 ${String(c).padStart(7)} 经验 ≈ ${(c / PER_DAY).toFixed(1)} 天`);
}

if (problems.length) {
    console.error('\n✘ 生成期自检未通过：');
    problems.forEach((p) => console.error(`  · ${p}`));
    process.exit(1);
}

if (process.argv.includes('--dry-run')) {
    console.log('\n(--dry-run：未写盘)');
} else {
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n');
    console.log(`\n✔ 已写入 ${path.relative(ROOT, OUT)}`);
    console.log('  下一步：cd tools/excel_export && node src/cli.ts json2excel --force --table player_levels');
}
