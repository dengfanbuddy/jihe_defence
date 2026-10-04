/**
 * check-shop-draw.mjs —— 肉鸽商店抽取体检（配置自检，不依赖 Cocos 运行时）
 *
 * 用真实的 assets/resources/tb/shop_*.json + relics.json 跑批量模拟抽取，输出各「阶段 × 英雄等级」下的：
 *   - 最少选项数（应为 optionCount，不足说明池子有洞）
 *   - 品质分布（白/蓝/黄/红，应与 shop_draw 的等级段权重 + 阶段门槛吻合）
 *   - 遗物(道具) : 技能 比例 + **每轮技能个数分布**（应吻合 shop_constants.skillDrawChance × skillCountWeight）
 *   - 每次抽取的平均「越阶」命中数
 * 并检查：选项不重复、技能个数不超 skillMaxPerDraw、池子耗尽（全部已获得）时的退化行为、抽取费用曲线。
 *
 * 用法：node tools/excel_export/scripts/check-shop-draw.mjs
 *
 * ⚠ 本脚本复刻了 battle/RelicDraw.ts 的抽取判定（Node 里跑不起 cc 依赖）。
 *   改 RelicDraw 的抽取逻辑时，请同步这里的判定，否则体检结果会失真。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.resolve(HERE, '../../..', 'assets/resources/tb');

const read = (name) => JSON.parse(fs.readFileSync(path.join(TB, `${name}.json`), 'utf8'));
const consts = read('shop_constants');
const drawBands = read('shop_draw');
// 肉鸽额外技能 = abilities.json 里 scope 含 shop 的那些（原 shop_skills 表已并入 abilities，id 段 101~130）
const abilities = read('abilities');
const skills = abilities
    .filter(a => a.scope === 'shop' || a.scope === 'both')
    .map(a => ({ id: a.id, name: a.name, rarity: a.rarity, stage: a.stage, weight: a.weight ?? 1, max_level: a.max_level ?? 1 }));
// 商店道具 = 遗物里**有局内版**的那些（scope=inner 或 both，id 1001~1293，共 293 件）；
// id < 1000 是手工 demo 遗物，`scope="outer"`（只有局外版，如 id 1294~1302）不进商店池 ——
// 判定口径必须与 game/data/configs/ShopConfig.ts 的 getRelics() 一致
const relics = read('relics').filter(r => r.id >= 1001 && r.id <= 1293 && (r.scope === 'inner' || r.scope === 'both'));

/** 模拟轮数（每个 阶段 × 等级 组合） */
const RUNS = 2000;

const ORDER = ['common', 'rare', 'epic', 'legendary'];
const stageOf = (r) => ORDER.indexOf(r) + 1;
const stageCap = (phase) =>
    consts.stageMaxByPhase[Math.min(consts.stageMaxByPhase.length - 1, Math.max(0, phase - 1))];
const band = (lv) => drawBands.find(d => lv >= d.level_min && lv <= d.level_max) ?? drawBands[0];

function rollRarity(weights) {
    const total = weights.reduce((s, v) => s + v, 0);
    if (total <= 0) return ORDER[0];
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return ORDER[i]; }
    return ORDER[0];
}

function pickWeighted(list) {
    const total = list.reduce((s, c) => s + c.w, 0);
    if (total <= 0) return list.length ? list[0] : null;
    let r = Math.random() * total;
    for (const c of list) { r -= c.w; if (r <= 0) return c; }
    return list[list.length - 1];
}

/**
 * 本轮该出几个技能 —— 复刻 `RelicDraw.rollSkillCount`：
 * ① 先按 `skillDrawChance` 掷「这轮有没有技能」（默认 20%）；② 有技能时按 `skillCountWeight` 掷个数。
 */
function rollSkillCount() {
    const max = Math.max(0, Math.floor(consts.skillMaxPerDraw ?? 2));
    if (max <= 0) return 0;
    const chance = Math.max(0, Math.min(100, consts.skillDrawChance ?? 20));
    if (Math.random() * 100 >= chance) return 0;
    const weights = consts.skillCountWeight ?? {};
    const list = [];
    for (let n = 1; n <= max; n++) {
        const v = Number(weights[String(n)]);
        if (Number.isFinite(v) && v > 0) list.push({ n, w: v });
    }
    const hit = pickWeighted(list);
    return hit ? hit.n : 1;
}

/**
 * 复刻 `RelicDraw.pickFrom`：`preferSkill`（本轮技能配额还没用满）时先拿技能、没有才退回遗物；
 * 否则先遗物、遗物空才退回技能 —— 回退只为「别让格子空着」，不会突破配额上限。
 */
function pickKind(byKind, preferSkill) {
    const order = preferSkill ? ['skill', 'relic'] : ['relic', 'skill'];
    for (const k of order) {
        if (byKind[k].length) return pickWeighted(byKind[k]);
    }
    return null;
}

/** 复刻 RelicDraw.roll（品质链路：权重 roll → 阶段门槛/越阶；种类链路：技能配额） */
function drawOnce(phase, level, owned) {
    const b = band(level);
    const weights = ORDER.map(r => b[r]);
    const upgradeChance = b.upgrade_chance / 100;
    const cap = stageCap(phase);

    const picked = [];
    const used = new Set();
    const usedRelic = new Set();
    const usedSkill = new Set();
    let upgrades = 0;
    // 技能配额：先掷「有没有技能」，再掷「几个」（一轮里的技能选项数上限 = skillMaxPerDraw）
    let skillBudget = rollSkillCount();

    /** 当前品质/阶段下的候选（技能满级的不算候选；遗物本局唯一） */
    const candidates = (rarity, allowed, allRarities) => {
        const byKind = { relic: [], skill: [] };
        for (const r of relics) {
            if (!allRarities && r.rarity !== rarity) continue;
            // 遗物不落 stage 列：阶段由品质推导（白 1 / 蓝 2 / 黄 3 / 红 4）
            if (stageOf(r.rarity) > allowed) continue;
            if (usedRelic.has(r.id) || owned.relics.has(r.id)) continue;
            byKind.relic.push({ kind: 'relic', id: r.id, rarity: r.rarity, w: 1 });
        }
        for (const sk of skills) {
            if (!allRarities && sk.rarity !== rarity) continue;
            if (sk.stage > allowed) continue;
            if (usedSkill.has(sk.id)) continue;
            // 重复抽到同名技能 = 升 1 级；**满级之后才**从池子里去掉（max_level 封顶）
            if ((owned.skills.get(sk.id) ?? 0) >= (sk.max_level ?? 1)) continue;
            byKind.skill.push({ kind: 'skill', id: sk.id, rarity: sk.rarity, stage: sk.stage, w: sk.weight });
        }
        return byKind;
    };

    const take = (hit) => {
        if (!hit) return false;
        used.add(`${hit.kind}:${hit.id}`);
        if (hit.kind === 'relic') usedRelic.add(hit.id); else { usedSkill.add(hit.id); skillBudget--; }
        picked.push(hit);
        return true;
    };

    // ① 主循环：先 roll 品质，再按「配额还剩几个技能」定种类
    for (let i = 0; i < consts.optionCount; i++) {
        let rarity = rollRarity(weights);
        if (stageOf(rarity) > cap) {
            if (Math.random() < upgradeChance) upgrades++;
            else rarity = ORDER[Math.max(0, cap - 1)];
        }
        const allowed = Math.max(cap, stageOf(rarity));
        take(pickKind(candidates(rarity, allowed, false), skillBudget > 0));
    }

    // ② 配额补齐：该品质里没有技能可选 → 把遗物候选换成阶段内任意技能（池子空了就放弃）
    while (skillBudget > 0) {
        const pool = candidates(null, cap, true).skill;
        if (!pool.length) break;
        const at = picked.map(p => p.kind).lastIndexOf('relic');
        if (at < 0) break;
        const evicted = picked[at];
        used.delete(`relic:${evicted.id}`);
        usedRelic.delete(evicted.id);
        const s = pickWeighted(pool);
        used.add(`skill:${s.id}`);
        usedSkill.add(s.id);
        picked[at] = s;
        skillBudget--;
    }

    // ③ 补位：池子变窄少抽了格子时，忽略品质先阶段内后全池补齐
    for (let guard = 0; picked.length < consts.optionCount && guard < consts.optionCount * 2; guard++) {
        const inStage = pickKind(candidates(null, cap, true), skillBudget > 0);
        const hit = inStage ?? pickKind(candidates(null, ORDER.length, true), skillBudget > 0);
        if (!take(hit)) break;
    }

    return { picked, upgrades, skillCount: picked.filter(p => p.kind === 'skill').length };
}

// ============================ 主流程 ============================

console.log('▌肉鸽商店抽取体检');
console.log(`  遗物(道具) ${relics.length} 件 / 技能 ${skills.length} 个 / 每轮模拟 ${RUNS} 次`);
console.log(`  选项数 ${consts.optionCount} · 可选 ${consts.pickCount} · 技能配额 出技能${consts.skillDrawChance}% × ${JSON.stringify(consts.skillCountWeight)}（上限 ${consts.skillMaxPerDraw} 个）\n`);

const problems = [];
const phases = [...new Set([...consts.stageMaxByPhase.map((_, i) => i + 1), 5])];
/** 每轮技能个数直方图（全局累计；键 = 技能个数） */
const skillHist = {};
let skillHistRuns = 0;

for (const phase of phases) {
    for (const level of [1, 5, 12, 25, 30]) {
        const rarityCount = {};
        const kindCount = { relic: 0, skill: 0 };
        let minOpts = Infinity;
        let upgradeTotal = 0;
        let maxSkills = 0;

        for (let n = 0; n < RUNS; n++) {
            const { picked, upgrades, skillCount } = drawOnce(phase, level, { relics: new Set(), skills: new Map() });
            upgradeTotal += upgrades;
            minOpts = Math.min(minOpts, picked.length);
            maxSkills = Math.max(maxSkills, skillCount);
            skillHist[skillCount] = (skillHist[skillCount] ?? 0) + 1;
            skillHistRuns++;
            if (new Set(picked.map(p => `${p.kind}:${p.id}`)).size !== picked.length) {
                problems.push(`阶段${phase} Lv${level}：出现重复选项`);
            }
            for (const p of picked) {
                rarityCount[p.rarity] = (rarityCount[p.rarity] ?? 0) + 1;
                kindCount[p.kind]++;
            }
        }

        const total = kindCount.relic + kindCount.skill;
        const pct = r => total ? ((rarityCount[r] ?? 0) / total * 100).toFixed(1) + '%' : '0%';
        const kindPct = k => total ? Math.round(kindCount[k] / total * 100) + '%' : '0%';

        console.log(
            `阶段${phase} Lv${String(level).padStart(2)}  最少选项=${minOpts}  ` +
            `白${pct('common').padStart(6)} 蓝${pct('rare').padStart(6)} 黄${pct('epic').padStart(6)} 红${pct('legendary').padStart(6)}  ` +
            `遗物${kindPct('relic').padStart(4)}/技能${kindPct('skill').padStart(4)}  越阶${(upgradeTotal / RUNS).toFixed(2)}/次`,
        );

        if (minOpts < consts.optionCount) {
            problems.push(`阶段${phase} Lv${level}：选项不足 ${minOpts}/${consts.optionCount}（池子在该品质/阶段下为空）`);
        }
        if (maxSkills > consts.skillMaxPerDraw) {
            problems.push(`阶段${phase} Lv${level}：单轮技能数 ${maxSkills} 超过 skillMaxPerDraw=${consts.skillMaxPerDraw}`);
        }
    }
}

// 技能配额分布（应吻合 skillDrawChance × skillCountWeight）
const histPct = n => skillHistRuns ? (skillHist[n] ?? 0) / skillHistRuns * 100 : 0;
const histLine = Object.keys(skillHist).sort((a, b) => Number(a) - Number(b))
    .map(n => `${n}个 ${histPct(Number(n)).toFixed(1)}%`).join('  ');
console.log(`\n每轮技能个数分布（${skillHistRuns} 轮）：${histLine}`);
const expectHasSkill = Math.max(0, Math.min(100, consts.skillDrawChance ?? 20));
const hasSkillPct = 100 - histPct(0);
// 容差 3 个百分点：样本量有限 + 技能池被阶段门槛/满级收窄时可能排不满配额
if (Math.abs(hasSkillPct - expectHasSkill) > 3) {
    problems.push(`出技能的实际概率 ${hasSkillPct.toFixed(1)}% 与 skillDrawChance=${expectHasSkill}% 偏差超过 3 个百分点`);
}
const weights = consts.skillCountWeight ?? {};
for (const key of Object.keys(weights)) {
    const n = Number(key);
    if (!Number.isFinite(n) || n < 1 || n > (consts.skillMaxPerDraw ?? 2)) {
        problems.push(`skillCountWeight 的键 "${key}" 越界（只认 1 ~ skillMaxPerDraw=${consts.skillMaxPerDraw}）`);
    }
}

// 池子耗尽
const drained = drawOnce(4, 30, {
    relics: new Set(relics.map(r => r.id)),
    // 技能全满级（max_level）才算「抽干」
    skills: new Map(skills.map(s => [s.id, s.max_level ?? 1])),
});
console.log(`\n池子耗尽（全部已获得）：抽到 ${drained.picked.length} 个选项（预期 0 → UI 需提示无可用内容）`);
if (drained.picked.length !== 0) problems.push('池子耗尽时仍抽出了选项，遗物唯一性 / 技能满级判定可能有漏');

// 费用曲线
const cost = n => Math.min(consts.drawCostBase + consts.drawCostStep * n, consts.drawCostCap);
console.log('费用曲线: ' + [0, 1, 2, 3, 4, 5, 8].map(n => `第${n + 1}次=${cost(n)}`).join('  '));
if (cost(0) !== consts.drawCostBase) problems.push('首次抽取费用不等于 drawCostBase');
// 收敛判据不能假定「99 次就能顶到 cap」：base/step 是策划调过的（现 base+step 远小于 cap），
// 按「还差多少 / 每步增量」算出真正需要的次数再验一次
const stepsToCap = consts.drawCostStep > 0
    ? Math.ceil((consts.drawCostCap - consts.drawCostBase) / consts.drawCostStep)
    : Infinity;
if (Number.isFinite(stepsToCap) && cost(stepsToCap + 1) !== consts.drawCostCap) {
    problems.push('抽取费用未收敛到 drawCostCap');
}
if (cost(1e6) > consts.drawCostCap) problems.push('抽取费用超过 drawCostCap');

console.log(problems.length ? `\n✖ ${problems.length} 个问题：\n  · ` + problems.slice(0, 20).join('\n  · ') : '\n✔ 未发现空池 / 重复 / 费用异常');
process.exitCode = problems.length ? 1 : 0;
