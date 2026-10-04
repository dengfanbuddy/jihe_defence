#!/usr/bin/env node
/**
 * audit.mjs —— **「视野与可达性」体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答两个问题（都是真读配表 + 真读工程设置算出来的，不是静态猜）：
 *
 *   ① **英雄的攻击距离有没有超出屏幕预算？**
 *      设计分辨率取自 `settings/v2/packages/project.json`：
 *        远程 ≤ 设计宽 × 1/3      近战 ≤ 设计宽 × 1/4
 *      （按 `attack_projectile` 是否配置来区分远程/近战）
 *
 *   ② **每只怪最终都能被英雄打到吗？**（本作的结构前提：英雄**固定居中不动**，
 *      怪从 `spawnRadius` 的外圈刷新 → 任何"不主动靠近"的 AI 都会让怪永远停在射程外，
 *      它打不到英雄、英雄也打不到它 = 完全不可交互的装饰）
 *      → 不变式：**每只怪的「停位半径」≤ 英雄的最小攻击距离**
 *
 * 「停位半径 standoff」按 AI 类型取：
 *   chase / attack_stop      → 自身的攻击距离（走到这个距离就停）
 *   wander                   → 自身攻击距离，**但必须有 aggroAfter 兜底**（否则永远不警戒）
 *   orbit                    → orbitRadius（绕着这个半径转）
 *   boss                     → 各阶段的最大值（BossAI 的 orbit 分支**没有俯冲逻辑**，
 *                              所以它的 orbit 半径还必须 ≤ 自身攻击距离，否则那个阶段纯空转）
 *
 * 为什么需要它：这两类问题都是「配表格式完全合法、但运行时不可交互」，
 *   `npm run check` / `npm run verify` 只验格式，**验不出来**。
 *   已经真实踩过一次：混怪表引进 `wander`/`orbit` 两种 AI 后，
 *   游荡者（aggroRange 350 < 刷新距离 650~800，永不警戒）与环绕魔（orbitRadius 200 > 近战上限 187）
 *   双双变成打不到的怪。
 *
 * 用法：
 *   node tools/monster-reach-audit/audit.mjs          # 体检 + 结论（有违规时退出码 1）
 *   npm run audit:reach                               # 在 tools/excel_export 下的等价命令
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
const PROJECT_JSON = path.join(ROOT, 'settings/v2/packages/project.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ============================================================
 * 1. 设计分辨率 → 攻击距离预算
 * ============================================================ */
let designW = 750, designH = 1334, fitWidth = true;
try {
    const d = readJson(PROJECT_JSON)?.designResolution ?? {};
    designW = d.width ?? designW;
    designH = d.height ?? designH;
    fitWidth = d.fitWidth !== false;
} catch {
    console.warn(`⚠ 读不到 ${path.relative(ROOT, PROJECT_JSON)}，改用默认 ${designW}×${designH}`);
}
// 占屏比例以「适配的那一边」为准：fitWidth → 用宽，否则用高
const budgetBase = fitWidth ? designW : designH;
const RANGED_CAP = Math.round(budgetBase / 3);
const MELEE_CAP = Math.round(budgetBase / 4);

const units = readJson(path.join(TB_DIR, 'units.json'));
const attrRange = (u) => {
    const a = (u.base_attributes ?? []).find((b) => b[0] === 16);
    return a ? a[1] : undefined;
};
const isRanged = (u) => !!(u.attack_projectile && String(u.attack_projectile).trim());

const errors = [];
const warns = [];

/* ============================================================
 * 2. 检查 ①：英雄攻击距离
 * ============================================================ */
const heroes = units.filter((u) => u.team === 1);
console.log('═'.repeat(72));
console.log(`① 英雄攻击距离（设计分辨率 ${designW}×${designH}，fit${fitWidth ? 'Width' : 'Height'}`
    + ` → 基准边 ${budgetBase}）`);
console.log(`   远程上限 ${RANGED_CAP}px（1/3）   近战上限 ${MELEE_CAP}px（1/4）`);
console.log('═'.repeat(72));
console.log('id    英雄        类型   距离    占屏宽    判定');
console.log('-'.repeat(72));
for (const u of heroes) {
    const r = attrRange(u);
    const ranged = isRanged(u);
    const cap = ranged ? RANGED_CAP : MELEE_CAP;
    if (r === undefined) { warns.push(`${u.id} ${u.name} 没有配置攻击距离（属性 16）`); continue; }
    const ratio = ((r / budgetBase) * 100).toFixed(0);
    const over = r > cap;
    if (over) errors.push(`英雄 ${u.id} ${u.name} 攻击距离 ${r}px 超过${ranged ? '远程' : '近战'}上限 ${cap}px（占屏宽 ${ratio}%）`);
    console.log(`${String(u.id).padEnd(5)} ${u.name.padEnd(10)} ${(ranged ? '远程' : '近战').padEnd(6)} `
        + `${String(r).padStart(4)}px  ${String(ratio).padStart(3)}%     ${over ? `🔴 超上限 ${cap}` : 'ok'}`);
}

const heroRanges = heroes.map((u) => attrRange(u)).filter((v) => typeof v === 'number');
const MIN_HERO = heroRanges.length ? Math.min(...heroRanges) : 0;

/* ============================================================
 * 3. 检查 ②：怪可达性
 * ============================================================ */
const spawnRadius = [650, 800]; // 与 GameStageConfig.defaultConfig.spawnRadius 对齐（见下）
console.log('');
console.log('═'.repeat(72));
console.log(`② 怪可达性（英雄最小攻击距离 = ${MIN_HERO}px；刷新圈 ${spawnRadius[0]}~${spawnRadius[1]}px）`);
console.log('═'.repeat(72));
console.log('id    怪物        AI            停位半径   判定');
console.log('-'.repeat(72));

const monsters = units.filter((u) => u.team === 2);
for (const u of monsters) {
    const own = attrRange(u);
    const ai = u.ai ?? {};
    const p = ai.params ?? {};
    let standoff = own;
    const notes = [];

    switch (ai.type) {
        case 'orbit': {
            standoff = p.orbitRadius ?? 250;
            if (standoff > own) notes.push(`停位 ${standoff} > 自身攻击 ${own}（靠俯冲才打得到）`);
            break;
        }
        case 'wander': {
            if (!(p.aggroAfter > 0)) {
                if (p.aggroRange > 0 && p.aggroRange < spawnRadius[1]) {
                    standoff = Infinity;
                    notes.push(`aggroRange ${p.aggroRange} < 刷新距离 ${spawnRadius[1]} 且没有 aggroAfter → 可能永不警戒`);
                } else if (!(p.aggroRange > 0)) {
                    standoff = Infinity;
                    notes.push('既没有 aggroRange 也没有 aggroAfter → 永不警戒');
                }
            }
            break;
        }
        case 'boss': {
            for (const ph of p.phases ?? []) {
                const v = ph.behavior === 'orbit' ? (ph.params?.orbitRadius ?? 250) : own;
                if (v > standoff) standoff = v;
                if (ph.behavior === 'orbit' && v > own) {
                    notes.push(`orbit 阶段 ${v} > 自身攻击 ${own}（BossAI 无俯冲 → 该阶段空转）`);
                }
            }
            break;
        }
        default:
            break; // chase / attack_stop：停位 = 自身攻击距离
    }

    const ok = standoff <= MIN_HERO;
    if (!ok) {
        errors.push(`怪物 ${u.id} ${u.name}（ai=${ai.type}）停位半径 ${standoff === Infinity ? '∞' : standoff} > 英雄最小攻击距离 ${MIN_HERO}`);
    }
    if (notes.length) warns.push(`${u.id} ${u.name}：${notes.join('；')}`);
    console.log(`${String(u.id).padEnd(5)} ${u.name.padEnd(9)} ${String(ai.type).padEnd(13)} `
        + `${String(standoff === Infinity ? '∞' : standoff).padEnd(10)} ${ok ? 'ok' : '🔴 不可达'}`
        + (notes.length ? `   ⚠ ${notes.join('；')}` : ''));
}

/* ============================================================
 * 4. 结论
 * ============================================================ */
console.log('');
if (warns.length) {
    console.log('提示（不影响退出码）：');
    for (const w of warns) console.log(`  ⚠ ${w}`);
    console.log('');
}
if (errors.length) {
    console.log('🔴 体检不通过：');
    for (const e of errors) console.log(`  · ${e}`);
    console.log(`\n共 ${errors.length} 项违规。`);
    process.exit(1);
}
console.log('✔ 两项体检全部通过：英雄攻击距离在屏幕预算内，且每只怪都能进入英雄射程。');
