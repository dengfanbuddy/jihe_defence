/**
 * check-shop-draw.mjs —— 肉鸽商店抽取体检（配置自检，不依赖 Cocos 运行时）
 *
 * 用真实的 assets/resources/tb/shop_*.json + relics.json 跑批量模拟抽取，输出各「阶段 × 英雄等级」下的：
 *   - 最少选项数（应为 optionCount，不足说明池子有洞）
 *   - 品质分布（白/蓝/黄/红，应与 shop_draw 的等级段权重 + 阶段门槛吻合）
 *   - 遗物(道具) : 技能 比例（应与 shop_constants.relicSkillPoolWeight 吻合）
 *   - 每次抽取的平均「越阶」命中数
 * 并检查：选项不重复、池子耗尽（全部已获得）时的退化行为、抽取费用曲线。
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

/** 复刻 ShopSystem.rollOptionsInternal + pickCandidate + ensureSkillGuarantee */
function drawOnce(phase, level, owned) {
    const b = band(level);
    const weights = ORDER.map(r => b[r]);
    const upgradeChance = b.upgrade_chance / 100;
    const cap = stageCap(phase);

    const picked = [];
    const used = new Set();
    let upgrades = 0;

    for (let i = 0; i < consts.optionCount; i++) {
        let rarity = rollRarity(weights);
        if (stageOf(rarity) > cap) {
            if (Math.random() < upgradeChance) upgrades++;
            else rarity = ORDER[Math.max(0, cap - 1)];
        }
        const allowed = Math.max(cap, stageOf(rarity));

        const byKind = { relic: [], skill: [] };
        for (const r of relics) {
            // 遗物不落 stage 列：阶段由品质推导（白 1 / 蓝 2 / 黄 3 / 红 4）
            if (r.rarity !== rarity || stageOf(r.rarity) > allowed) continue;
            if (used.has(`relic:${r.id}`)) continue;
            if (owned.relics.has(r.id)) continue; // 遗物本局唯一
            byKind.relic.push({ kind: 'relic', id: r.id, rarity, w: 1 });
        }
        for (const sk of skills) {
            if (sk.rarity !== rarity || sk.stage > allowed) continue;
            if (used.has(`skill:${sk.id}`)) continue;
            // 重复抽到同名技能 = 升 1 级；**满级之后才**从池子里去掉（max_level 封顶）
            if ((owned.skills.get(sk.id) ?? 0) >= (sk.max_level ?? 1)) continue;
            byKind.skill.push({ kind: 'skill', id: sk.id, rarity, w: sk.weight });
        }

        const nonEmpty = Object.keys(byKind).filter(k => byKind[k].length > 0);
        if (!nonEmpty.length) continue;

        const kindWeights = nonEmpty.map(k => ({ k, w: Math.max(0, consts.relicSkillPoolWeight[k] ?? 1) }));
        const positive = kindWeights.filter(x => x.w > 0);
        const chosen = pickWeighted(positive.length ? positive : kindWeights)?.k;
        const hit = pickWeighted(byKind[chosen]);
        if (!hit) continue;
        used.add(`${hit.kind}:${hit.id}`);
        picked.push(hit);
    }

    // 技能保底
    let haveSkill = picked.filter(p => p.kind === 'skill').length;
    while (haveSkill < consts.guaranteeSkillPerDraw) {
        const pool = skills.filter(s => s.stage <= cap
            && !used.has(`skill:${s.id}`)
            && (owned.skills.get(s.id) ?? 0) < (s.max_level ?? 1));
        if (!pool.length) break;
        const s = pool[Math.floor(Math.random() * pool.length)];
        const at = picked.map(p => p.kind).lastIndexOf('relic');
        const idx = at >= 0 ? at : picked.length - 1;
        if (idx < 0) break;
        used.delete(`${picked[idx].kind}:${picked[idx].id}`);
        used.add(`skill:${s.id}`);
        picked[idx] = { kind: 'skill', id: s.id, rarity: s.rarity };
        haveSkill++;
    }

    return { picked, upgrades };
}

// ============================ 主流程 ============================

console.log('▌肉鸽商店抽取体检');
console.log(`  遗物(道具) ${relics.length} 件 / 技能 ${skills.length} 个 / 每轮模拟 ${RUNS} 次`);
console.log(`  选项数 ${consts.optionCount} · 可选 ${consts.pickCount} · 技能保底 ${consts.guaranteeSkillPerDraw} · 池比例 遗物${consts.relicSkillPoolWeight.relic}:技能${consts.relicSkillPoolWeight.skill}\n`);

const problems = [];
const phases = [...new Set([...consts.stageMaxByPhase.map((_, i) => i + 1), 5])];

for (const phase of phases) {
    for (const level of [1, 5, 12, 25, 30]) {
        const rarityCount = {};
        const kindCount = { relic: 0, skill: 0 };
        let minOpts = Infinity;
        let upgradeTotal = 0;

        for (let n = 0; n < RUNS; n++) {
            const { picked, upgrades } = drawOnce(phase, level, { relics: new Set(), skills: new Map() });
            upgradeTotal += upgrades;
            minOpts = Math.min(minOpts, picked.length);
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
if (cost(99) !== consts.drawCostCap) problems.push('抽取费用未收敛到 drawCostCap');

console.log(problems.length ? `\n✖ ${problems.length} 个问题：\n  · ` + problems.slice(0, 20).join('\n  · ') : '\n✔ 未发现空池 / 重复 / 费用异常');
process.exitCode = problems.length ? 1 : 0;
