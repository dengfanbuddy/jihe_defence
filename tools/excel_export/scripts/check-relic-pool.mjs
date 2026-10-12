/**
 * 遗物池结构体检 —— **"同档内不许有更好的那一件"这件事的可执行判据**。
 *
 * 为什么要有它（2026-11，用户口径）：局内商店一次给 4 个候选，实测出现过
 * 「右边 3 件都是攻击力 +8，中间那件还多一条加成」——玩家当然选中间那件，
 * 另外 3 格等于不存在。根因有两条，都在**池子结构**里、不在某一行的数值里：
 *   ① **同 profile 的件太多**（旧白档 107 件只有 32 种效果，其中「攻击力 +8」有 20 件）；
 *   ② **多属性件每条都拿满额** ⇒ 属性集合是超集的那件**逐属性全面压过**小的那件。
 * 于是本脚本把三件事钉成门禁：**条数上限 / 条数摊薄 / 无支配**，外加密度与供给。
 *
 * 判据来源：设计真源 `scripts/lib/relic-inner-design.mjs`（`resolveFinalItems()` 之后的最终表）。
 * 退出码 1 = 有违规（可挂 CI）。用法：
 *   node scripts/check-relic-pool.mjs            # 汇总
 *   node scripts/check-relic-pool.mjs --all      # 打全量违规清单
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveFinalItems, tagsOf, attrValueOf, ATTR_CN, ATTR_CAPS, ATTR_VALUE,
    COST_BOOST, MAX_ATTRS_PER_RELIC, SHARE, ITEMS, RELIC_ARCHETYPES, ARCHETYPE_BALANCE, hookKv,
} from './lib/relic-inner-design.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const ALL = process.argv.includes('--all');
const RARITY_CN = { common: '白', rare: '蓝', epic: '黄', legendary: '红' };
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];

/** 重复容忍度：白/蓝**没有钩子**，属性完全相同的两件就是"同一件"（玩家看到的也一样）⇒ 只许 2 件 */
const MAX_SAME_PROFILE = { common: 2, rare: 2, epic: 4, legendary: 4 };
/** 代价件密度的允许区间（白档刻意保持低密度：白档是"低方差安全件"） */
const COST_DENSITY_RANGE = {
    common: [0.05, 0.20], rare: [0.20, 0.45], epic: [0.20, 0.45], legendary: [0.20, 0.45],
};
/** 代价件总数下限（B 批 = 铺开到蓝/黄/红约 30%，别又缩回试点那 4 件） */
const MIN_COST_ITEMS = 40;

const problems = [];
const warns = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warns.push(msg);

const final = resolveFinalItems();
/**
 * 收益条目 = `a` 里**不在 `cost` 里**的那些。
 *
 * ⚠ 判据必须按**整条条目**（`[属性, 值, 叠加方式]`）认，**不能只按属性 id**：
 * 代价与收益可以落在同一条轴上（如「+最大生命 52% 代价 −最大生命 12%」的写法虽然少见，
 * 但按 id 过滤会把那条**收益**也一起当成代价丢掉 ⇒ 条数与期望值全错）。
 * 这也是 `descriptionOf()` 的口径（`costKeys`），两处必须一致。
 */
const costKeysOf = (it) => new Set((it.cost ?? []).map((e) => e.join('|')));
const isCost = (it) => (it.cost ?? []).length > 0;
const benefitsOf = (it) => (it.a ?? []).filter((e) => !costKeysOf(it).has(e.join('|')));

console.log('▌遗物池结构体检（tools/excel_export/scripts/check-relic-pool.mjs）');
console.log(`  · 件数 ${final.length} / 品质 ${RARITY_ORDER.map((r) => `${RARITY_CN[r]}${final.filter((i) => i.r === r).length}`).join(' / ')}`);

/* ── A 结构 ── */
for (const it of final) {
    const ben = benefitsOf(it);
    if (ben.length > MAX_ATTRS_PER_RELIC) fail(`A1 超条数上限：${it.id} 有 ${ben.length} 条收益属性（上限 ${MAX_ATTRS_PER_RELIC}）`);
    if (!ben.length && !(it.h ?? []).length) fail(`A1b 空件：${it.id} 既没有收益属性也没有钩子（拿到等于没拿到）`);
    if ((it.h ?? []).length > 3) fail(`A3 钩子过多：${it.id} 有 ${(it.h ?? []).length} 个钩子`);
    for (const [attr, v, mode] of ben) {
        const def = ATTR_VALUE[it.r]?.[attr];
        if (!def) { fail(`A2 未登记属性值：${it.id} 给了 ${ATTR_CN[attr] ?? attr}，但 ATTR_VALUE.${it.r} 里没有它`); continue; }
        const want = attrValueOf(it.r, attr, ben.length, isCost(it));
        if (v !== want) fail(`D1 值没走预算表：${it.id} ${ATTR_CN[attr]} = ${v}，按预算表应为 ${want}`);
        const wantMode = def.mode ?? undefined;
        if (mode !== wantMode) fail(`D2 叠加方式不对：${it.id} ${ATTR_CN[attr]} mode=${mode ?? '(缺省)'}，应为 ${wantMode ?? '(缺省)'}`);
    }
    // 白/蓝只给固定值（门禁口径：百分比与百分比型属性黄档起）
    if (it.r === 'common' || it.r === 'rare') {
        for (const [attr, , mode] of ben) {
            if (mode === 'percent') fail(`A4 低档不许 percent：${it.id}（${RARITY_CN[it.r]}）${ATTR_CN[attr]} 用了 percent`);
            if (ATTR_VALUE[it.r][attr]?.mode && ATTR_VALUE[it.r][attr].mode !== undefined) {
                fail(`A4b 低档不许百分比型属性：${it.id}（${RARITY_CN[it.r]}）${ATTR_CN[attr]}`);
            }
        }
    }
}

/* ── B 无支配（本脚本的核心判据） ── */
const domPairs = [];
for (const tier of RARITY_ORDER) {
    const list = final.filter((it) => it.r === tier);
    for (const A of list) {
        for (const B of list) {
            if (A === B) continue;
            // 代价件不参与判定：它的"每条都更高"是**付了钱**换来的（有增有减 ≠ 支配）
            if (isCost(A) || isCost(B)) continue;
            const am = new Map(benefitsOf(A).map((e) => [e[0], e[1]]));
            const bm = new Map(benefitsOf(B).map((e) => [e[0], e[1]]));
            let ge = true; let gt = false;
            for (const [id, v] of bm) {
                const av = am.get(id);
                if (av === undefined || av < v) { ge = false; break; }
                if (av > v) gt = true;
            }
            if (ge && gt && am.size >= bm.size) domPairs.push([tier, A, B]);
        }
    }
}
for (const [tier, A, B] of domPairs) {
    const f = (it) => benefitsOf(it).map((e) => `${ATTR_CN[e[0]]} ${e[1]}`).join('；');
    fail(`B1 支配对：${RARITY_CN[tier]}档 ${A.id}(${f(A)}) 全面压过 ${B.id}(${f(B)})`);
}

/* ── C 同 profile 重复度 ── */
for (const tier of RARITY_ORDER) {
    const list = final.filter((it) => it.r === tier);
    const groups = new Map();
    for (const it of list) {
        const k = benefitsOf(it).map((e) => `${e[0]}:${e[1]}`).sort().join('|');
        groups.set(k, [...(groups.get(k) ?? []), it.id]);
    }
    const cap = MAX_SAME_PROFILE[tier];
    for (const ids of groups.values()) {
        if (ids.length > cap) fail(`C1 同效果件过多：${RARITY_CN[tier]}档 ${ids.length} 件完全同效果（上限 ${cap}）：${ids.join(', ')}`);
    }
    const dup = list.length - groups.size;
    console.log(`  · ${RARITY_CN[tier]}档：${list.length} 件 / ${groups.size} 种效果 / 重复件 ${dup}（上限 ${cap}/种）`);
}

/* ── E 供给与覆盖 ── */
const supply = {}; const count = {};
for (const it of final) for (const [attr, v] of benefitsOf(it)) { supply[attr] = (supply[attr] ?? 0) + v; count[attr] = (count[attr] ?? 0) + 1; }
for (const [key, cap] of Object.entries(ATTR_CAPS)) {
    const attr = Number(key);
    const total = supply[attr] ?? 0;
    const need = Math.abs(cap.cap) * cap.min;
    if (Math.abs(total) < need) fail(`E1 供给不足：${ATTR_CN[attr]} 全池总给 ${Number(total.toFixed(2))} < 目标 ${need}（上限 ${cap.cap} × ${cap.min}）`);
}
const giveable = new Set();
for (const tier of RARITY_ORDER) for (const a of Object.keys(ATTR_VALUE[tier])) giveable.add(Number(a));
for (const attr of giveable) {
    if (!count[attr]) fail(`E2 死属性：${ATTR_CN[attr]}(${attr}) 在 ATTR_VALUE 里登记了，却没有任何一件遗物给（"每个可给属性至少 1 件"）`);
}
console.log('  · 供给（有上限的轴）：', Object.keys(ATTR_CAPS).map((k) => `${ATTR_CN[k]}=${Number((supply[k] ?? 0).toFixed(1))}`).join('  '));

/* ── F 代价件密度 ── */
let costTotal = 0;
for (const tier of RARITY_ORDER) {
    const list = final.filter((it) => it.r === tier);
    const n = list.filter(isCost).length;
    costTotal += n;
    const ratio = n / list.length;
    const [lo, hi] = COST_DENSITY_RANGE[tier];
    if (ratio < lo) warn(`F1 代价件太少：${RARITY_CN[tier]}档 ${n}/${list.length} = ${(ratio * 100).toFixed(0)}%（期望 ${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}% —— 全是纯收益件时 4 格商店就没有取舍）`);
    if (ratio > hi) fail(`F1b 代价件过多：${RARITY_CN[tier]}档 ${n}/${list.length} = ${(ratio * 100).toFixed(0)}%（上限 ${(hi * 100).toFixed(0)}% —— 密度过高会让这一档"没得选"）`);
}
if (costTotal < MIN_COST_ITEMS) fail(`F2 代价件总数 ${costTotal} < ${MIN_COST_ITEMS}（B 批要求铺开，不是试点那 4 件）`);
console.log(`  · 代价件：${costTotal}/${final.length}（${(costTotal / final.length * 100).toFixed(0)}%），收益加成 COST_BOOST=${JSON.stringify(COST_BOOST)}`);

/* ── G 标签 ── */
const tagCount = {};
for (const it of final) for (const t of tagsOf(it)) tagCount[t] = (tagCount[t] ?? 0) + 1;
const costTags = final.filter((it) => isCost(it) && tagsOf(it).some((t) => ['远程点杀', '法术爆发', '物理暴击'].includes(t)));
console.log('  · 标签：', Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
if (costTags.length > 0) {
    // 代价条目不产生标签（2026-11 修）；这里列出来只是让人知道"这些件的标签来自收益那边"
    if (ALL) console.log('    （带代价的输出件：', costTags.map((i) => i.id).join(', '), '—— 它们的标签来自收益属性/钩子，不是代价）');
}
console.log(`  · 条数摊薄 SHARE=${JSON.stringify(SHARE)}，条数上限=${MAX_ATTRS_PER_RELIC}`);

/* ── G 流派配平（2026-11 新增：判据见 ARCHETYPE_BALANCE 的注释） ── */
const prim = (it) => tagsOf(it)[0];
const totals = {};
const perTier = {};
for (const t of RELIC_ARCHETYPES) { totals[t] = 0; perTier[t] = {}; for (const r of RARITY_ORDER) perTier[t][r] = 0; }
for (const it of final) { const t = prim(it); totals[t]++; perTier[t][it.r]++; }
const vals = Object.values(totals);
const maxN = Math.max(...vals); const minN = Math.min(...vals);
const maxTag = RELIC_ARCHETYPES.find((t) => totals[t] === maxN);
const minTags = RELIC_ARCHETYPES.filter((t) => totals[t] === minN);
console.log('  · 流派配平（主标签 · 逐档）：');
for (const t of RELIC_ARCHETYPES) {
    const mech = totals[t] - perTier[t].common;      // 机制件 = 这条线里非白档的件（白档只有属性、没有钩子）
    console.log(`      ${t.padEnd(5, '　')} ${String(totals[t]).padStart(3)} 件（${(totals[t] / final.length * 100).toFixed(1).padStart(4)}%）`
        + `  白 ${String(perTier[t].common).padStart(3)} / 蓝 ${String(perTier[t].rare).padStart(2)}`
        + ` / 黄 ${String(perTier[t].epic).padStart(2)} / 红 ${String(perTier[t].legendary).padStart(2)}`
        + `   机制件 ${String(mech).padStart(2)}`);
}
console.log(`  · 最厚 ${maxTag} ${maxN} / 最薄 ${minTags.join('·')} ${minN} = **${(maxN / minN).toFixed(2)}×**`
    + `（上限 ${ARCHETYPE_BALANCE.maxSpread}×）`);
for (const t of RELIC_ARCHETYPES) {
    if (totals[t] < ARCHETYPE_BALANCE.minPerArchetype) {
        fail(`G1 流派太薄：${t} 全池只有 ${totals[t]} 件 < ${ARCHETYPE_BALANCE.minPerArchetype}（成型线 5 件，太薄等于这条线在一局里看不见）`);
    }
    if (totals[t] > ARCHETYPE_BALANCE.maxPerArchetype) {
        fail(`G2 流派太厚：${t} 全池 ${totals[t]} 件 > ${ARCHETYPE_BALANCE.maxPerArchetype}（不想堆也会成型，提示变噪音）`);
    }
    const mech = totals[t] - perTier[t].common;
    if (mech < ARCHETYPE_BALANCE.mechanicalMin) fail(`G4 机制件太少：${t} 只有 ${mech} 件（蓝+黄+红）< ${ARCHETYPE_BALANCE.mechanicalMin}`);
    if (mech > ARCHETYPE_BALANCE.mechanicalMax) fail(`G4b 机制件太多：${t} ${mech} 件 > ${ARCHETYPE_BALANCE.mechanicalMax}（高档位被一条线吃掉）`);
    if (perTier[t].common > 0 && ARCHETYPE_BALANCE.whiteReachable.indexOf(t) < 0) {
        fail(`G5 白档挂了推不出的词：${t} 有 ${perTier[t].common} 件白档件（白档只有 9 条固定值属性，只能推 ${ARCHETYPE_BALANCE.whiteReachable.join('/')}）`);
    }
    if (perTier[t].common > ARCHETYPE_BALANCE.maxWhitePerArchetype) {
        fail(`G5b 白档把一条线抬太高：${t} 白档 ${perTier[t].common} 件 > ${ARCHETYPE_BALANCE.maxWhitePerArchetype}`);
    }
    if (perTier[t].rare === 0 && perTier[t].epic === 0 && perTier[t].legendary === 0) {
        fail(`G6 流派没有机制件：${t} 在高档位一件都没有（玩家凑不出这条线）`);
    }
}
if (maxN / minN > ARCHETYPE_BALANCE.maxSpread) {
    fail(`G3 流派厚度落差过大：${maxTag} ${maxN} ÷ ${minTags.join('·')} ${minN} = ${(maxN / minN).toFixed(2)}× > ${ARCHETYPE_BALANCE.maxSpread}×`);
}

/* ── H 半径口径（2026-11 新增：用户口径「攻击范围才 200，爆炸就 100 多，很不合理」） ──
 *
 * 池子里带半径的效果只有 5 条钩子 + 地雷那一条，它们**不是一回事**，判据必须分开：
 *
 *   ① **爆炸类**（`splash` / `critEcho` / `killBoom`）—— 以**命中目标 / 阵亡者**为圆心。
 *      · 半径**一律 50 像素**（`pxPerMeter` = 50 ⇒ 正好 1 米，读作"蹭到紧挨着的那 1~2 只"）；
 *      · 三档**同值**：爆炸大小是**形态**不是数值，随品质长大只会让白档和红档的圈一样大、
 *        而红档还多一倍伤害（视觉上读不出档差），档位差异一律落回伤害百分比。
 *
 *   ② **光环类**（`immolate` / `slowAura`）—— 以**英雄**为圆心，而怪会**停在自己的攻击距离**
 *      不再靠近（`ChaseAI` 判 `dist <= getAttackRange()`）。全表 9 种怪的停位距离是
 *      **44 / 90 / 100 / 100 / 120 / 120 / 140 / 150 / 180**（`units.json` 的 attr16；
 *      其中小怪/精英最大 **120**，Boss 是 140/150/180）⇒ 半径 ≤50 时**只有 44 射程的哥布林会被烫到**，
 *      其余 8 种怪一辈子站在圈外（配了等于没配）。所以光环**不跟爆炸同尺**：
 *      下限 `AURA_RADIUS_MIN` = **非 Boss 怪的最大停位距离**（现 120，从 `units.json` 现读），
 *      三档单调不减，且红档还要够到 `AURA_RADIUS_MIN` 以上（现 immolate 150 / slowAura 180）。
 *      红档够不到 180 射程那两个 Boss 是**刻意的**（改前的 immolate 160 也够不到）。
 *
 *   ③ **地雷·扩爆**（`mineRange`）—— 加在 `abilities#28` 的基础爆炸半径上。单件加成
 *      **不许超过基础半径**：基础 110→50 之后，若还留 +70，一件红档就能把半径推到 120，
 *      **比改前的整发爆炸还大** —— 等于这一件遗物一个人把用户这次改动撤销掉。
 */
const BLAST_HOOKS = ['splash', 'critEcho', 'killBoom'];
const AURA_HOOKS = ['immolate', 'slowAura'];
const BLAST_RADIUS_PX = 50;
const AURA_RADIUS_MIN = (() => {
    // 真读 `units.json`：光环下限 = 非 Boss 怪的**最大停位距离**（写死会和配表脱节）
    let standoffs = [];
    try {
        const units = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/resources/tb/units.json'), 'utf8'));
        standoffs = units.filter((u) => u.category === 'monster' && u.subtype !== 'boss')
            .map((u) => (u.base_attributes ?? []).find((b) => b[0] === 16)?.[1])
            .filter((v) => typeof v === 'number');
    } catch { /* 读不到就退回内联值 */ }
    return standoffs.length ? Math.max(...standoffs) : 150;
})();
const MINE_BASE_RADIUS = (() => {
    try {
        const ab = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/resources/tb/abilities.json'), 'utf8'));
        const kv = ab.find((a) => a.id === 28)?.effects?.[0]?.kv ?? {};
        return Number(kv.mineBlastRadius) || 50;
    } catch { return 50; }
})();

const TIERS = ['rare', 'epic', 'legendary'];
const radiusOf = (hookId, tier) => Number(hookKv(hookId, tier).radius);

for (const id of BLAST_HOOKS) {
    const vals = TIERS.map((r) => radiusOf(id, r));
    for (const [i, v] of vals.entries()) {
        if (v !== BLAST_RADIUS_PX) {
            fail(`H1 爆炸半径不是 ${BLAST_RADIUS_PX}：${id} 的 ${RARITY_CN[TIERS[i]]}档 = ${v}`
                + `（爆炸类一律 ${BLAST_RADIUS_PX} 像素 = 1 米，别盖住大半个射程）`);
        }
    }
    if (new Set(vals).size !== 1) {
        fail(`H2 爆炸半径随品质长大：${id} = ${vals.join('/')}（大小是形态，档位差异该落在伤害上）`);
    }
}
for (const id of AURA_HOOKS) {
    const vals = TIERS.map((r) => radiusOf(id, r));
    if (vals[0] < AURA_RADIUS_MIN) {
        fail(`H3 光环半径被架空：${id} 蓝档 = ${vals[0]} < ${AURA_RADIUS_MIN}`
            + `（怪停在自己的攻击距离外不再靠近，半径小了这条光环一辈子烫不到人）`);
    }
    for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) fail(`H4 光环半径倒挂：${id} = ${vals.join('/')}`);
    }
    if (vals[2] < AURA_RADIUS_MIN) fail(`H4b 光环红档够不到非 Boss 怪的停位距离：${id} 红档 = ${vals[2]}`);
}
for (const r of TIERS) {
    const add = Number(hookKv('mineRange', r).mineRadiusAdd);
    if (add > MINE_BASE_RADIUS) {
        fail(`H5 扩爆加成超过基础半径：${RARITY_CN[r]}档 +${add} > 基础 ${MINE_BASE_RADIUS}`
            + `（单件遗物就能把地雷爆炸推回改前水平，等于撤销这次改动）`);
    }
}
console.log(`  · 半径口径：爆炸类（${BLAST_HOOKS.join('/')}）= **${BLAST_RADIUS_PX}px** 通档同值`);
console.log(`      光环类（${AURA_HOOKS.join('/')}）= `
    + AURA_HOOKS.map((id) => `${id} ${TIERS.map((r) => radiusOf(id, r)).join('/')}`).join(' · ')
    + `（下限 ${AURA_RADIUS_MIN}px = 非 Boss 怪最大停位距离）`);
console.log(`      地雷扩爆 = ${TIERS.map((r) => '+' + hookKv('mineRange', r).mineRadiusAdd).join('/')}`
    + `（基础 ${MINE_BASE_RADIUS}px，取自 abilities#28）`);

/* ── 汇总 ── */
console.log('');
if (warns.length) {
    console.log(`⚠ 警告 ${warns.length} 条：`);
    for (const w of (ALL ? warns : warns.slice(0, 8))) console.log('   ' + w);
    if (!ALL && warns.length > 8) console.log(`   …（还有 ${warns.length - 8} 条，--all 打全量）`);
}
if (problems.length) {
    console.log(`✖ 违规 ${problems.length} 条：`);
    for (const p of (ALL ? problems : problems.slice(0, 20))) console.log('   ' + p);
    if (!ALL && problems.length > 20) console.log(`   …（还有 ${problems.length - 20} 条，--all 打全量）`);
    process.exit(1);
}
console.log('✔ 遗物池结构体检通过（无支配 / 重复度达标 / 供给达标 / 代价件密度达标）');
