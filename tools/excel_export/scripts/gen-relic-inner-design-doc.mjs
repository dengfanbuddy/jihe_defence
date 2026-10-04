/**
 * 局内遗物效果重做 —— **评审稿生成器**
 *
 * 输入：`scripts/lib/relic-inner-design.mjs`（设计真源）+ `assets/resources/tb/relics.json`（原名/图标/现品质/现效果）
 * 输出：
 *   · `docs/relic-redesign/README.md`        —— 口径 + 钩子库 + 品质预算 + 删除清单 + 属性覆盖 + 落地路径
 *   · `docs/relic-redesign/relics-inner.md`  —— 全表（逐件：旧效果 → 新属性 + 新钩子 + 新文案）
 *   · `docs/relic-redesign/relics-inner.csv` —— 同全表（供 Excel 评审）
 *
 * 用法：`node tools/excel_export/scripts/gen-relic-inner-design-doc.mjs`
 * 只出报告不写盘：`node tools/excel_export/scripts/gen-relic-inner-design-doc.mjs --dry`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    RARITY_PLAN, NEW_ATTRS, ATTR_CN, PERCENT_ATTRS, ZERO_BASE_ATTRS, DEAD_ATTRS, MERGED_ATTRS,
    HOOKS, HOOK_BY_ID, MAX_HOOKS_PER_RELIC, DROPS, DROP_IDS, ITEMS,
    ATTR_CAPS, UNCAPPED_ATTRS, SUPPLY_TOPUP, VAMP_ATTR_TIERS,
    // 派生层（与落表脚本共用同一份实现，避免"评审稿写的"与"落表的"漂移）
    resolveFinalItems, attrText, attrListText, resolveHook, hookText, descriptionOf,
} from './lib/relic-inner-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const RELICS = path.join(ROOT, 'assets/resources/tb/relics.json');
const OUT_DIR = path.join(ROOT, 'docs/relic-redesign');
const DRY = process.argv.includes('--dry');

const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
const RARITY_CN = { common: '白', rare: '蓝', epic: '黄', legendary: '红' };
const RARITY_COLOR = { common: '#DDDDDD', rare: '#5096FF', epic: '#CF68FF', legendary: '#FF6464' };

const relics = JSON.parse(fs.readFileSync(RELICS, 'utf8'));
/**
 * 「局内版」范围 = 肉鸽商店能抽到的那些 = `scope` 含 inner 的 **inner + both** 两种。
 * ⚠ 别写成 `scope.includes('inner')` —— `'both'.includes('inner')` 是 false，
 *   这样会把 28 件两侧都有的遗物（狂战斧/蝴蝶/斯嘉蒂之眼…）漏在设计之外，
 *   它们的局内版就会一直挂着 Dota2 老效果。
 */
const innerRows = relics.filter((r) => {
    const s = String(r.scope || '');
    return s === 'inner' || s === 'both';
});
const byId = new Map(innerRows.map((r) => [r.id, r]));

/* ------------------------------------------------------- 供给配平（保证总给 > 上限） */

const FINAL_ITEMS = resolveFinalItems();
const finalById = new Map(FINAL_ITEMS.map((i) => [i.id, i]));

/* ------------------------------------------------------------------ 格式化 */

/** 旧效果摘要（用于对比列） */
function oldSummary(row) {
    const mods = row.modifiers_inner ?? [];
    const attrPart = (mods.find((m) => m.modifier === 1000)?.kv?.attrs ?? [])
        .map(([id, v, m]) => `${ATTR_CN[id] ?? id}${m === 'percent' ? ` +${v}%` : ` +${v}`}`)
        .join('+');
    const others = mods.filter((m) => m.modifier !== 1000).map((m) => `mod${m.modifier}`).join('+');
    const bits = [attrPart, others].filter(Boolean).join('/');
    return bits || '（无效果）';
}

/* ------------------------------------------------------------------ 校验 */

const problems = [];
const warnings = [];
const designed = new Set(ITEMS.map((i) => i.id));

for (const row of innerRows) {
    if (!designed.has(row.id) && !DROP_IDS.has(row.id)) problems.push(`遗物 ${row.id} ${row.name} 既没有设计也没有列入删除`);
}
/** 「效果型属性」——吸血/攻击回复/攻击回蓝虽然是属性，但本身就是效果，蓝档起给它们也算"有钩子"；
 *  白档可以给 **26 攻击回复 / 27 攻击回蓝**（它们是平坦固定值，符合"白档只给属性"），但给不了 25 吸血（百分比型 → 黄档起）。 */
const EFFECT_ATTRS = new Set([25, 26, 27]);
/** 功能百分比属性（金币/经验/冷却/抽卡折扣）—— 与门禁「功能性百分比红档起」一致，只有红档能给 */
const FUNC_ATTRS = new Set([21, 22, 23, 24]);
for (const item of FINAL_ITEMS) {
    const row = byId.get(item.id);
    if (!row) { problems.push(`设计里出现不存在的局内遗物 id=${item.id}`); continue; }
    const hooks = item.h ?? [];
    const effectAttrs = (item.a ?? []).filter(([id]) => EFFECT_ATTRS.has(id));
    const effects = hooks.length + effectAttrs.length;
    if (hooks.length > MAX_HOOKS_PER_RELIC) problems.push(`${item.id} ${row.name} 钩子超过 ${MAX_HOOKS_PER_RELIC} 个（${hooks.length}）`);
    if (item.r === 'common' && hooks.length > 0) problems.push(`${item.id} ${row.name} 是白档却给了钩子`);
    if (item.r !== 'common' && effects === 0) warnings.push(`${item.id} ${row.name} 是${RARITY_CN[item.r]}档却没有任何效果（钩子或效果型属性）`);
    if (item.r === 'rare' && effects > 1) warnings.push(`${item.id} ${row.name} 蓝档给了 ${effects} 个效果（口径：蓝档 1 个轻效果）`);
    if (item.r === 'epic' && effects > 2) warnings.push(`${item.id} ${row.name} 黄档给了 ${effects} 个效果（口径：黄档 1~2 个）`);
    for (const h of hooks) {
        const r = resolveHook(h, item.r);
        if (r.error) problems.push(`${item.id} ${row.name}：${r.error}`);
    }
    // 属性门禁（与 docs/配置规则_品质与词条门禁.md 一致）
    const attrs = item.a ?? [];
    if (item.r === 'common' && attrs.length > 2) warnings.push(`${item.id} ${row.name} 白档给了 ${attrs.length} 项属性（口径：1~2 项）`);
    for (const [id, value, mode] of attrs) {
        if (DEAD_ATTRS.has(id)) problems.push(`${item.id} ${row.name} 用了本作无效属性 ${ATTR_CN[id]}(${id})`);
        if (MERGED_ATTRS.has(id)) problems.push(`${item.id} ${row.name} 用了已合并的属性 ${ATTR_CN[id]}(${id})（受伤减免是全能减免，一律写 12）`);
        if (mode === 'percent' && PERCENT_ATTRS.has(id)) problems.push(`${item.id} ${row.name} 对百分比型属性用了 percent（应改 add）`);
        if (mode === 'percent' && ZERO_BASE_ATTRS.has(id)) problems.push(`${item.id} ${row.name} 对 base=0 属性 ${ATTR_CN[id]} 用了 percent（恒为 0）`);
        if (mode === 'multiply') problems.push(`${item.id} ${row.name} 用了 multiply（全项目禁用）`);
        if (FUNC_ATTRS.has(id) && item.r !== 'legendary') problems.push(`${item.id} ${row.name} 给了功能百分比属性「${ATTR_CN[id]}」（门禁：红档专属）`);
        if ((PERCENT_ATTRS.has(id) || mode === 'percent') && (item.r === 'common' || item.r === 'rare')) {
            const what = PERCENT_ATTRS.has(id) ? `百分比型属性「${ATTR_CN[id]}」` : '百分比加成';
            problems.push(`${item.id} ${row.name} 是${RARITY_CN[item.r]}档却给了${what}（门禁：黄档起）`);
        }
    }
}

/* 属性覆盖：每个"本作可用属性"至少有一件遗物能给 + 有上限属性的「全池总供给 > 上限」自检 */
const COVERABLE = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 21, 22, 23, 24, 25, 26, 27];
const coverCount = {};
const supply = {};      // 该属性的"池总给"（best 模式取最大值，其余求和）
for (const item of FINAL_ITEMS) for (const [id, v] of item.a ?? []) {
    coverCount[id] = (coverCount[id] ?? 0) + 1;
    if (HOOK_BY_ID[id]) continue;
    supply[id] = id === 15 ? Math.max(supply[id] ?? -Infinity, v) : (supply[id] ?? 0) + v;
}
for (const id of COVERABLE) if (!coverCount[id]) problems.push(`属性 ${ATTR_CN[id]}(${id}) 没有任何遗物能给`);

const supplyRows = [];
for (const [key, c] of Object.entries(ATTR_CAPS)) {
    const attr = Number(key);
    const got = supply[attr] ?? 0;
    const ratio = c.cap === 0 ? 0 : got / c.cap;
    supplyRows.push({ attr, cap: c.cap, got, ratio, min: c.min, cnt: coverCount[attr] ?? 0, unit: c.unit, note: c.note });
    if (!coverCount[attr]) problems.push(`有上限的属性 ${ATTR_CN[attr]}(${attr}) 没有任何遗物能给`);
    else if (Math.abs(got) <= Math.abs(c.cap)) problems.push(`属性 ${ATTR_CN[attr]} 全池总给 ${got} 未超过上限 ${c.cap}（堆不到上限 = 上限永远不生效）`);
    else if (ratio < c.min) warnings.push(`属性 ${ATTR_CN[attr]} 供给只有上限的 ${ratio.toFixed(2)}×（目标 ≥ ${c.min}×，构筑选择空间偏窄）`);
}
for (const [key, tiers] of Object.entries(VAMP_ATTR_TIERS)) {
    const attr = Number(key);
    supplyRows.push({
        attr, cap: 0, got: supply[attr] ?? 0, ratio: 0, min: 0, cnt: coverCount[attr] ?? 0,
        unit: tiers.unit, note: '2026-10 定案：做成正式属性（值由遗物 kv.attrs 给，命中结算点消费）',
    });
}

/* 钩子使用统计 */
const hookUse = {};
for (const item of FINAL_ITEMS) for (const h of item.h ?? []) {
    const id = Array.isArray(h) ? h[0] : h;
    hookUse[id] = (hookUse[id] ?? 0) + 1;
}
for (const h of HOOKS) if (!hookUse[h.id]) warnings.push(`钩子 ${h.id}（${h.cn}）没有被任何遗物使用`);

/**
 * 钩子实现自检（2026-10 落表后补）：`battle/RelicHooks.ts` 的 `RELIC_HOOK_SCRIPT_CLASSES`
 * 必须与 `HOOKS[].impl` 一一对齐 —— 漏一个的后果是运行时只打一句
 * `[ModifierSystem] script_id 未注册: xxx` 然后**静默降级成普通 Modifier**
 * （玩家看到的是"这件遗物抽到了却没效果"），是最难查的一类问题，所以卡在生成器里。
 */
{
    const hooksTs = path.join(ROOT, 'assets/scripts/game/battle/RelicHooks.ts');
    if (!fs.existsSync(hooksTs)) {
        warnings.push('还没生成 battle/RelicHooks.ts（钩子脚本实现），无法核对 script_id ↔ 注册表');
    } else {
        const src = fs.readFileSync(hooksTs, 'utf8');
        const block = src.match(/export const RELIC_HOOK_SCRIPT_CLASSES[^{]*\{([\s\S]*?)\n\};/);
        const keys = new Set(block ? [...block[1].matchAll(/RelicHook_[A-Za-z0-9_]+/g)].map((m) => m[0]) : []);
        const impls = HOOKS.map((h) => String(h.impl).replace(/^S:/, ''));
        for (const impl of impls) {
            if (!keys.has(impl)) problems.push(`钩子实现 ${impl} 不在 RelicHooks.ts 的 RELIC_HOOK_SCRIPT_CLASSES 注册表里（运行时会静默降级：遗物"抽到却没效果"）`);
        }
        for (const k of keys) {
            if (!impls.includes(k)) warnings.push(`RelicHooks.ts 注册表里的 ${k} 在 HOOKS 里没有对应钩子（死代码）`);
        }
    }
}

const rarityCount = {};
for (const item of FINAL_ITEMS) rarityCount[item.r] = (rarityCount[item.r] ?? 0) + 1;
const oldRarityCount = {};
for (const r of innerRows) oldRarityCount[r.rarity] = (oldRarityCount[r.rarity] ?? 0) + 1;
/** 池深自检：口径 4:3:2:1（`RARITY_PLAN[].pool` 是唯一真源） */
for (const r of RARITY_ORDER) {
    const want = RARITY_PLAN[r].pool;
    if (want !== undefined && (rarityCount[r] ?? 0) !== want) {
        problems.push(`品质池深 ${RARITY_CN[r]} 期望 ${want} 件、实到 ${rarityCount[r] ?? 0} 件（口径 4:3:2:1）`);
    }
}
/** 供给配平表自检：`add` 名单里的件必须落在该 rule 声明过的档位上，否则这条**静默失效** */
for (const [key, rule] of Object.entries(SUPPLY_TOPUP)) {
    const tiers = Object.keys(rule).filter((k) => k !== 'add' && k !== 'except');
    for (const id of rule.add ?? []) {
        const item = finalById.get(id);
        if (!item) { problems.push(`SUPPLY_TOPUP 属性「${ATTR_CN[key]}」的 add 里有不存在的遗物 id=${id}`); continue; }
        if (!tiers.includes(item.r)) {
            problems.push(`SUPPLY_TOPUP 属性「${ATTR_CN[key]}」的 add 里 ${id} 是${RARITY_CN[item.r]}档，但该规则只声明了 ${tiers.map((t) => RARITY_CN[t]).join('/')} 档（这条会静默失效）`);
        }
    }
}

/* ------------------------------------------------------------------ 文档 */

const sortedItems = [...FINAL_ITEMS].sort((a, b) => a.id - b.id);

function oldRarityOf(id) { return byId.get(id)?.rarity ?? '-'; }

const mdLines = [];
mdLines.push('# 局内遗物 · 效果重做全表（评审稿）');
mdLines.push('');
mdLines.push('> 生成器：`node tools/excel_export/scripts/gen-relic-inner-design-doc.mjs`（**别手改本文件**，改 `scripts/lib/relic-inner-design.mjs`）');
mdLines.push(`> 范围：\`relics.json\` 里 \`scope\` 含 \`inner\` 的 ${innerRows.length} 件；重做后保留 **${ITEMS.length}** 件、删除 **${DROP_IDS.size}** 件。`);
mdLines.push('> 名字与图标**不改**，只重做 `modifiers_inner` 与 `description_inner`（局外版 `modifiers_outer` 完全不动）。');
mdLines.push('');
mdLines.push(`## 0. 结论一览`);
mdLines.push('');
const LANDED = RARITY_ORDER.every((r) => (oldRarityCount[r] ?? 0) === (rarityCount[r] ?? 0));
mdLines.push(LANDED
    ? `- 品质池深（**4:3:2:1**）：白 ${rarityCount.common ?? 0} / 蓝 ${rarityCount.rare ?? 0} / 黄 ${rarityCount.epic ?? 0} / 红 ${rarityCount.legendary ?? 0}（共 ${ITEMS.length} 件）`
    : `- 品质重分档：` + RARITY_ORDER.map((r) => `${RARITY_CN[r]} ${oldRarityCount[r] ?? 0} → **${rarityCount[r] ?? 0}**`).join(' / ') + `（**池深比例 4:3:2:1**）`);
mdLines.push(`- 白档 = 纯属性（${rarityCount.common ?? 0} 件）；蓝档起给钩子，一件最多 ${MAX_HOOKS_PER_RELIC} 个钩子；**不做主动型遗物**`);
mdLines.push(`- 删除 ${DROP_IDS.size} 件：全部是「本作没有对应系统」的遗物（见 §3）`);
mdLines.push(`- 新增属性 ${NEW_ATTRS.map((a) => `${a.id} ${a.cn}`).join(' / ')}（需扩 \`AttributeType\` + 接线，见 §4）`);
mdLines.push(`- **有上限的属性，全池总给全部 > 上限**（含 1.2~2× 的选择空间，见 §1.3）—— 上限才真的会成为限制`);
mdLines.push('');
mdLines.push(`### 0.1 红档 ${rarityCount.legendary ?? 0} 件（每件 = 一条流派核心，池子最薄）`);
mdLines.push('');
mdLines.push('| id | 名称 | 身份 | 效果 |');
mdLines.push('|---|---|---|---|');
for (const item of sortedItems.filter((i) => i.r === 'legendary')) {
    mdLines.push(`| ${item.id} | ${byId.get(item.id)?.name ?? '?'} | ${item.kw ?? ''} | ${descriptionOf(item)} |`);
}
mdLines.push('');
mdLines.push(`### 0.2 黄档 ${rarityCount.epic ?? 0} 件（百分比 / 百分比型属性档）`);
mdLines.push('');
mdLines.push(sortedItems.filter((i) => i.r === 'epic').map((i) => `${i.id} ${byId.get(i.id)?.name ?? '?'}`).join(' / '));
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 1. 设计口径');
mdLines.push('');
mdLines.push('| 项 | 口径 |');
mdLines.push('|---|---|');
mdLines.push('| 身份 | 名字 / 图标 / `code` 不动；`rarity` 允许重分档 |');
mdLines.push('| 池深（2026-10 定案） | **4:3:2:1** —— 白 96 / 蓝 72 / 黄 48 / 红 24（共 240 件）：越往上池子越薄、每件越有身份 |');
mdLines.push('| 白档 | **只给属性**（固定值，1~2 项） |');
mdLines.push('| 蓝档 | 固定值属性 + **1 个钩子**（低概率 / 小数值 / 长冷却） |');
mdLines.push('| 效果型属性 | **25 吸血 / 26 攻击回复 / 27 攻击回蓝**：本身是属性（可叠、无上限），但算作"一个效果位"——带它们的件不必再配钩子 |');
mdLines.push('| 黄档 | 百分比 或 百分比型属性 + **1~2 个钩子** |');
mdLines.push('| 红档 | 大百分比 + 功能属性（金币/经验/冷却/抽卡折扣）+ **2~3 个钩子**，**每件都是流派核心** |');
mdLines.push('| 主动型 | **不做**（原 6 个主动钩子已删，对应遗物改成同主题被动，见 §2 末尾） |');
mdLines.push('| 钩子上限 | **一件最多 3 个** |');
mdLines.push('| 同一钩子跨品质 | 允许，只是数值/百分比不同（每档数值见 §2） |');
mdLines.push('| 效果来源 | 只能挂在**本作真实存在**的触发点上（见 §2 的 `触发` 列） |');
mdLines.push('| 明确删除 | 本作没有的系统：位移闪烁 / 视野守卫 / 信使 / 回城传送 / 砍树种植 / 莲花拾取 / 中立代币 / 道具升技能 / 吞噬融合 |');
mdLines.push('| 属性口径 | 百分比型属性用 `add`（配置值 = 百分点）；数值属性百分比用 `percent`（只对 base 乘算）；`multiply` 禁用；护甲/回血/回蓝（base=0）只能用 `add` |');
mdLines.push('| 无效属性 | **移动速度(5) 不发**（英雄是固定锚点，局内不移动）→ 鞋子类遗物改给攻击距离/攻速 |');
mdLines.push('| 受伤减免（12） | **全能减免**：物理与法术都减（2026-10 用户口径）。原「12 物理受伤 / 13 魔法受伤」两条**合并成一条 12**，13 退役（遗物一件都不许再用，生成器卡红线）；引擎侧 `DamagePipeline` 第 4 阶段改为一律取 12 |');
mdLines.push('');
mdLines.push('### 1.1 品质预算');
mdLines.push('');
mdLines.push('| 品质 | 池深 | 钩子数 | 属性 | 预算 |');
mdLines.push('|---|---|---|---|---|');
for (const r of RARITY_ORDER) {
    const p = RARITY_PLAN[r];
    mdLines.push(`| ${RARITY_CN[r]}（${r}） | ${p.pool ?? '—'} | ${p.hooks} | ${p.attrs} | ${p.budget} |`);
}
mdLines.push('');
mdLines.push('### 1.2 属性覆盖（每个属性都有遗物能给）');
mdLines.push('');
mdLines.push('| 属性 | 件数 | 属性 | 件数 |');
mdLines.push('|---|---|---|---|');
const coverRows = COVERABLE.map((id) => [ATTR_CN[id] ?? String(id), coverCount[id] ?? 0]);
for (let i = 0; i < coverRows.length; i += 2) {
    const a = coverRows[i], b = coverRows[i + 1] ?? ['', ''];
    mdLines.push(`| ${a[0]} | ${a[1]} | ${b[0]} | ${b[1]} |`);
}
mdLines.push('');
mdLines.push(`> 移动速度(5) 故意为 0 件：英雄 \`immovable\`（固定锚点），局内给移速等于没给。`);
mdLines.push(`> 新增属性 21~27 见 §4（21~24 需要扩 \`AttributeType\` 并接线，25~27 见 §4 的消费点，否则"加了却没变"）。`);
mdLines.push('');
mdLines.push('### 1.3 属性上限 × 遗物池总供给（硬约束：**总给必须高于上限**）');
mdLines.push('');
mdLines.push('口径：有上限的属性，**全池遗物能给的总量必须 > 上限**，否则上限永远不会生效、玩家也堆不满；本稿还要求 ≥ 一个"选择空间倍数"（`min`），否则等于"只有一条堆法"。**无上限的属性（暴击倍率 / 伤害输出 / 金币获取 / 经验获取 / 吸血）不做上限自检，只统计供给量** —— 它们是无限成长轴，靠抽取费用递增（50→200）这种边际成本约束。');
mdLines.push('');
mdLines.push('| 属性 | 上限 | 全池总给 | 供给/上限 | 目标 | 供给件数 | 说明 |');
mdLines.push('|---|---|---|---|---|---|---|');
for (const r of supplyRows.sort((a, b) => (a.isHook === b.isHook ? a.attr - b.attr : a.isHook ? 1 : -1))) {
    const name = r.isHook ? (HOOK_BY_ID[r.attr]?.cn ?? r.attr) : (ATTR_CN[r.attr] ?? r.attr);
    const uncapped = r.cap === 0;
    const capTxt = uncapped ? '**无上限**' : String(r.cap);
    const ratioTxt = uncapped ? '—' : `${r.ratio.toFixed(2)}×`;
    const ok = uncapped ? '∞' : (r.ratio < 1 ? '❌ 堆不满' : (r.min && r.ratio < r.min ? '⚠ 偏窄' : '✅'));
    mdLines.push(`| ${name} | ${capTxt} | ${Number(r.got.toFixed(2))} | ${ratioTxt} | ${uncapped ? '—' : `≥${r.min}×`} | ${r.cnt} | ${ok} ${r.note ?? ''} |`);
}
mdLines.push('');
mdLines.push('**无上限属性（只统计供给）**：' + UNCAPPED_ATTRS.map((id) => `${ATTR_CN[id]} ${Number((supply[id] ?? 0).toFixed(2))}`).join(' / '));
mdLines.push('');
mdLines.push('> ⚠ **无上限 ≠ 代码无上限**：`AttributeSystem` 仍按 `attributes.json` 的 min/max 钳制（现 伤害输出 max 1000 = +900%、暴击倍率 max 1000 = 10 倍）—— 要真"无上限"就得把这两项的 max 放到足够大，否则到顶那天会变成"加了却没变"（`npm run audit:attr` 会抓）。新属性 21/22 的 max 也要按"够大"配。');
mdLines.push('');
mdLines.push('> **供给配平**：单件属性值照"一件小装备"给是堆不满上限的（护甲 +1 × 44 件 = 68，上限 200），所以加了 `SUPPLY_TOPUP` 一层（设计真源里）：① 对有上限的属性，按品质把值抬到供给值并追加到指定件身上；② 对无上限的经济/增伤轴（伤害输出 / 金币获取 / 经验获取），保证**来源件数够多**（不然流派起不来）。要调上限/供给，只改 `ATTR_CAPS` 与 `SUPPLY_TOPUP` 两处，生成器会重算这张表并卡红线。');
mdLines.push('');
mdLines.push('> ⚠ **与代码现状冲突，落地要一起改**：`attributes.json` 现在的 max 是 攻速 1000 / 闪避 95 / 护甲 100；`battle_constants.json` 里 `critRateCap 0.6`、`dodgeCap 0.4`、`atkSpeedCap 3` 三个**死常量**（全工程无消费方）与上面这套上限打架 —— 要么删掉它们、要么把它们接成唯一真源。');
mdLines.push('');
mdLines.push('> ✅ **护甲公式已定案（2026-10）：保留现有 Dota 双曲 `减伤 = 0.06a / (1 + 0.06|a|)`** —— 上限 200 对应 **92.3% 减伤**，递减、永远到不了 100%。下面是这条曲线的几个采样点（生成器按真公式算的，别再按"200 ≈ 99%"反推）：');
mdLines.push('');
{
    const r = (a) => (0.06 * a) / (1 + 0.06 * a);
    const pts = [0, 10, 25, 50, 100, 150, 200, 300, 500, 1000, 1650];
    mdLines.push('| 护甲 | ' + pts.join(' | ') + ' |');
    mdLines.push('|' + '---|'.repeat(pts.length + 1));
    mdLines.push('| 物理减伤 | ' + pts.map((a) => `${(r(a) * 100).toFixed(1)}%`).join(' | ') + ' |');
}
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 2. 钩子库（效果词汇）');
mdLines.push('');
mdLines.push('`实现` 列：`S:类名` = 新增**参数化脚本模板**（`battle/RelicHooks.ts`，数值全部由遗物 `kv` 传入，不再为每个数值组合新增 Modifier 行）；`BUS:` = 该触发只发总线，脚本需自行订阅并在 `OnDestroy` 里 `off`。');
mdLines.push('');
mdLines.push('| 钩子 | 关键词 | 触发 | 实现 | 蓝 | 黄 | 红 |');
mdLines.push('|---|---|---|---|---|---|---|');
for (const h of HOOKS) {
    const cell = (tier) => h.tier[tier] ? '`' + JSON.stringify(h.tier[tier]).replace(/[{}"]/g, '').replace(/,/g, ', ') + '`' : '—';
    mdLines.push(`| ${h.id} | ${h.cn} | ${h.trig} | ${h.impl} | ${cell('rare')} | ${cell('epic')} | ${cell('legendary')} |`);
}
mdLines.push('');
mdLines.push('> **主动型钩子已删（2026-10 定案：不做主动型遗物）**。原来 6 个主动钩子改成**同主题被动**，落在这些钩子上：');
mdLines.push('> `时间冻结 1153`：activeFreeze → `freezeProc`（普攻概率冰封）｜`神灭斩 1155`：activeNuke → `execute`（残血追加斩杀）｜`分身 1178`：activeTurret → `critEcho`（命中追加一段）｜`护盾爆发 1186`：activeShield → `shieldCharge`（受击累积护盾）｜`全军狂暴 1198`：activeRage → `atkSpeedStack`（攻击叠攻速）｜`生机 1209`：activeHeal → `killHeal`（击杀回血）。');
mdLines.push('');
mdLines.push('### 2.1 实现口径注意（看着像"改伤害"、落地其实是"追加一段结算"）');
mdLines.push('');
mdLines.push('伤害管线（`DamagePipeline`）**没有给 Modifier 留"乘法改伤害"的口子**：能插手的只有第 3 阶段 `on_block_damage`（可变字段 `blocked`，护盾/格挡语义）。所以下面这些钩子的落地口径要统一认识：');
mdLines.push('');
mdLines.push('| 钩子 | 文案承诺 | 落地口径 |');
mdLines.push('|---|---|---|');
mdLines.push('| `execute` 斩杀 / `firstStrike` 首击 / `critEcho` 暴击回响 | 普攻伤害 ×1.3 / +60% / 80% 伤害 | **追加一段独立结算的伤害**（各自过一遍管线、独立吃护甲与暴击），不是把原伤害乘大 |');
mdLines.push('| `pierce` 穿透 | 额外命中 N 个敌人 | 命中后对另外 N 个敌人各追加一段 60% 攻击力伤害 |');
mdLines.push('| `hitFlat`/`hitPct`/`splash`/`chain`/`ignite`/`poison`/`armorBreak`/`frost`/`stunProc`… | 命中后附加效果 | `on_attack_landed` 里追加结算/施加 Modifier（走的都是既有事件，不需要改管线） |');
mdLines.push('| `block`/`shieldCharge`/`magicBarrier`/`lowHpGuard` | 格挡 / 减伤 | 在 `on_block_damage` 里写 `blocked`（唯一能"减少已到伤害"的位置） |');
mdLines.push('| `lastStand`/`nearDeath` | 致命伤害时不死 | `on_block_damage` 里判定"这一击会致死"→ 全量 block + 给 1 点生命/无敌；**不能**靠 `on_death` 复活（那时已死、本局已结束） |');
mdLines.push('| `phaseBuff` | 每进入新阶段 | 需要一个**新的总线事件** `on_phase_changed`（`Scene_Game_Stage.checkStage` 切阶段处 publish），现有事件里没有 |');
mdLines.push('| 21~24 功能属性 | 金币/经验/冷却/抽卡折扣 | 需要 4 处消费点接线（见 §4），否则"加了却没变"（**红档专属**） |');
mdLines.push('');
mdLines.push('> 另外两条工程纪律（写脚本时照办，出自 `ShopSkillModifiers.ts` 头注释）：**① 只发总线的事件（`on_kill` 等）必须自己 `bus.on` + 在 `OnDestroy` 里 `off`**（实体走对象池复用，不摘会把已回收实例算进去）；**② 别依赖 `modifiers.cd`**（`Trigger()/OnTriggered()` 全工程零调用方，是死代码），周期行为自己在 `OnTick(dt)` 里计时。');
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 3. 删除清单（本作没有的系统）');
mdLines.push('');
mdLines.push('| 遗物 | 原因 |');
mdLines.push('|---|---|');
for (const d of DROPS) {
    const names = d.ids.map((id) => `${id} ${byId.get(id)?.name ?? '?'}`).join('、');
    mdLines.push(`| ${names} | ${d.reason} |`);
}
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 4. 新增属性（需要接线）');
mdLines.push('');
mdLines.push('| id | 属性 | 口径 | 最低档 | 消费点 |');
mdLines.push('|---|---|---|---|---|');
const CONSUME = {
    21: '`Scene_Game_Stage.grantKillReward`（与成就金币加成同一处折算）',
    22: '`Scene_Game_Stage.addBattleExp` 调用点',
    23: '`Ability.Cast` 设 `cooldownRemaining` 时乘 (1 - cdr)',
    24: '`RelicShop` 扣费处（折扣封顶 50%）',
    25: '`Entity.resolveAttackHit`（普攻命中结算点，近战/远程弹道都走这里）：`heal += 本次伤害 × 吸血%`',
    26: '同上：`heal += 攻击回复`（固定值，不吃暴击倍率）',
    27: '同上：`mana += 攻击回蓝`（固定值）',
};
for (const a of NEW_ATTRS) mdLines.push(`| ${a.id} | ${a.cn} | ${a.text('X')} | ${a.min} | ${CONSUME[a.id]} |`);
mdLines.push('');
mdLines.push('> 17~20 是 `ConfigLoader.nameToAttrId` 的历史噪声（lightningDmg/poisonDmg/burnDmg/freezeDuration），**不要用**，新属性从 21 起排。');
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 5. 落地路径（评审通过后）');
mdLines.push('');
mdLines.push('1. **代码**：新增 `assets/scripts/game/battle/RelicHooks.ts`（§2 的 `S:` 类，一张 `RELIC_HOOK_SCRIPT_CLASSES` 表 + 公共小工具：`meters/alive/dist2/aoe/chain`），在 `Scene_Game_Stage.initBattle` 按 `SHOP_SKILL_SCRIPT_CLASSES` 的同一套路注册；扩 `AttributeType` 21~27 + `attributes.json` + 7 个消费点（§4）。**受伤减免合并**：`Types.ts` 里 `IncomingPhysical = 12` 改名 `IncomingDamage`（「受伤减免」）、删掉 `IncomingMagical = 13`；`DamagePipeline.collectIncomingMultiplier` 改成**一律取 12**（不再按伤害类型分支）；`attributes.json` 第 12 行改名 + 上下限（−80 ~ 100）、第 13 行删除。');
mdLines.push('2. **配表**：`modifiers.json` 增钩子模板行（id 段建议 200~259，一条钩子一行、`duration:-1`、`script_id` 指向脚本类）；`relics.json` 的每件遗物 `modifiers_inner = [ {modifier:1000, kv:{attrs}}, {modifier:钩子行, kv:{...}} ... ]`、`description_inner` 换成本表的文案；`scope` 里删掉的件**整行删除**（它们只在局内出现，不影响局外图鉴与存档）。');
mdLines.push('3. **回灌与体检**：`npm run export` → `npm run check` → `npm run verify` → `npm run check:affix`（白档越档词条） → `npm run audit:attr`（属性真的生效） → `npm run audit:slot` / `npm run check:shop`（抽取池与费用）。');
mdLines.push('4. **上限同步**：把 §1.3 的上限写进 `attributes.json` 的 max（攻速 500 / 护甲 200 / 闪避 45 / 暴击率 100 / 魔抗 95 …；无上限轴把 max 放到足够大），并处理 `battle_constants.json` 里 `critRateCap/dodgeCap/atkSpeedCap` 三个死常量（删或接成唯一真源）；`%` 类上限（折扣 80 / 冷却 50 / 受伤 −80）还要在消费点做钳制（`RelicShop` 折扣、`Ability` 冷却）。');
mdLines.push('5. **旧管线**：`gen-shop-from-hero-design.ts` 会按 Dota2 设计稿重写局内版 —— 落地后**必须停用/改写它**，否则重跑会把这套设计覆盖掉。');
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 6. 评审结论（2026-10 已定案）');
mdLines.push('');
mdLines.push('| # | 项 | 定案 | 影响面 |');
mdLines.push('|---|---|---|---|');
mdLines.push(`| 1 | **品质池深** | **4:3:2:1** —— 白 ${rarityCount.common ?? 0} / 蓝 ${rarityCount.rare ?? 0} / 黄 ${rarityCount.epic ?? 0} / 红 ${rarityCount.legendary ?? 0}（原四档接近均分） | 只改 \`ITEMS[].r\`；降档件的内容已按门禁重写（白/蓝不留百分比型属性、黄不留功能百分比） |`);
mdLines.push('| 2 | **蓝档钩子** | **保留**：蓝档 = 固定值属性 + 1 个轻钩子（拦挡/格挡类钩子照留） | 蓝档不再压成"高白值白件" |');
mdLines.push('| 3 | **主动型遗物** | **不做** —— 6 个主动钩子删除，6 件遗物（霜封/裁决/分身/壁垒/生机/狂暴）改同主题被动 | 遗物面板不需要"使用"按钮；红档少一类玩法 |');
mdLines.push('| 4 | **吸血 / 攻击回复 / 攻击回蓝** | **做成正式属性 25 / 26 / 27**（值由遗物 `kv.attrs` 给，在普攻命中结算点消费） | 与吸血相关的 3 个钩子已删；技能吸血暂不含 |');
mdLines.push('| 5 | **护甲公式** | **保留**现有 Dota 双曲（护甲 200 → 92.3% 减伤，递减、到不了 100%） | 不改 `DamagePipeline` |');
mdLines.push('| 6 | **属性上限** | 你给的：攻速 5.0 / 暴击率 100 / 闪避 45 / 护甲 200 / 冷却 50 / 折扣 80；**无上限**：暴击倍率 / 伤害输出 / 金币获取 / 经验获取 / 吸血 / 攻击回复 / 攻击回蓝 | 只改 `ATTR_CAPS` 一处，生成器重算 §1.3 并卡红线 |');
mdLines.push('| 7 | **受伤减免 = 全能减免（已确认）** | **物理与法术都减**，最多减 80%（原 12/13 两条合并成 12，13 退役）；**魔抗 95 也已确认** | 落地要改 `DamagePipeline.collectIncomingMultiplier`（一律取 12）+ `Types.ts` 改名（`IncomingPhysical` → `IncomingDamage`，删 `IncomingMagical`） |');
mdLines.push('');
mdLines.push('> 池深从"四档均分"改成 4:3:2:1 的连带影响（都已在本稿里处理）：① 白档从 61 → 96 件，多出来的 35 件是把最弱的蓝档件去掉钩子降下来（纯属性垫底件变多）；② 红档从 57 → 24 件，每件重新按"流派核心"挑过（多了经济/冷却/暴击这几条专精轴）；③ 黄档降档件要把百分比折算成固定值（门禁：百分比与百分比型属性黄档起）。');
mdLines.push('');
mdLines.push('---');
mdLines.push('');
const headEnd = mdLines.length;
mdLines.push(`## 7. 全表（${ITEMS.length} 件）`);
mdLines.push('');
if (LANDED) {
    mdLines.push('> ⚠ **本稿已在落地之后重新生成**：`旧品质` / `旧效果` 两列读的就是**落地后的配置**，所以与 `新*` 列相同；');
    mdLines.push('> 想看重做前的 Dota2 老效果对比，见 git 历史与 `docs/agent-notes/配表与数值口径.md`。');
    mdLines.push('');
}
mdLines.push('| id | 名称 | 旧品质 → 新品质 | 旧效果 | 关键词 | 新属性 | 新钩子 | 新文案 |');
mdLines.push('|---|---|---|---|---|---|---|---|');
for (const item of sortedItems) {
    const row = byId.get(item.id);
    const hooks = (item.h ?? []).map((h) => {
        const { hook, tier, values, error } = resolveHook(h, item.r);
        if (error) return `⚠${error}`;
        const tierTag = tier === item.r ? '' : `(${RARITY_CN[tier]})`;
        return `${hook.cn}${tierTag}`;
    }).join(' + ') || '—';
    const oldR = oldRarityOf(item.id);
    const move = oldR === item.r ? RARITY_CN[oldR] : `${RARITY_CN[oldR]} → ${RARITY_CN[item.r]}`;
    mdLines.push(`| ${item.id} | ${row?.name ?? '?'} | ${move} | ${oldSummary(row)} | ${item.kw ?? ''} | ${attrListText(item.a) || '—'} | ${hooks} | ${descriptionOf(item)} |`);
}
mdLines.push('');
mdLines.push('---');
mdLines.push('');
mdLines.push('## 8. 生成器自检');
mdLines.push('');
mdLines.push(`- 已设计 ${ITEMS.length} 件 / 删除 ${DROP_IDS.size} 件 / 覆盖局内遗物 ${ITEMS.length + DROP_IDS.size} 件`);
mdLines.push(`- 严重问题 ${problems.length} 条，警告 ${warnings.length} 条（明细跑 \`--dry\` 看控制台）`);
mdLines.push('- 口径自检项：钩子 ≤3 / 白档无钩子 / **白+蓝档不给百分比与百分比型属性（黄档起）** / **功能百分比（金币/经验/冷却/折扣）只给红档** / **受伤减免只用 12（13 已合并退役）** / 百分比型属性一律 add / 禁用 multiply / base=0 不用 percent / 不存在属性不发（移速）/ 每个可给属性至少 1 件遗物 / 每个钩子至少被 1 件遗物使用 / 供给配平的 add 名单档位对得上');
mdLines.push('');

const csvHeader = ['id', 'name', 'old_rarity', 'new_rarity', 'kw', 'old_effect', 'new_attrs', 'new_hooks', 'new_desc'];
const csvRows = [csvHeader.join(',')];
for (const item of sortedItems) {
    const row = byId.get(item.id);
    const hooks = (item.h ?? []).map((h) => {
        const { hook, tier, values, error } = resolveHook(h, item.r);
        if (error) return error;
        const kv = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ');
        return `${hook.id}[${tier}:${kv}]`;
    }).join(' + ');
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    csvRows.push([
        item.id, esc(row?.name), oldRarityOf(item.id), item.r, esc(item.kw),
        esc(oldSummary(row)), esc(attrListText(item.a)), esc(hooks), esc(descriptionOf(item)),
    ].join(','));
}

console.log(`[设计稿] 已设计 ${ITEMS.length} 件；删除 ${DROP_IDS.size} 件；局内总数 ${innerRows.length}`);
console.log(`[设计稿] 品质分布：` + RARITY_ORDER.map((r) => `${RARITY_CN[r]} ${rarityCount[r] ?? 0}`).join(' / '));
console.log(`[设计稿] 严重问题 ${problems.length} 条：`);
for (const p of problems) console.log('   ✗ ' + p);
console.log(`[设计稿] 警告 ${warnings.length} 条：`);
for (const w of warnings) console.log('   ! ' + w);
console.log('[设计稿] 上限 × 供给（got/cap，目标 ≥min×）：');
for (const r of supplyRows.sort((a, b) => a.attr - b.attr)) {
    if (r.cap === 0) continue;
    const mark = Math.abs(r.got) <= Math.abs(r.cap) ? '✗' : (r.ratio < r.min ? '!' : '✓');
    console.log(`   ${mark} ${ATTR_CN[r.attr]}(${r.attr}) ${Number(r.got.toFixed(2))}/${r.cap} = ${r.ratio.toFixed(2)}× (min ${r.min}×, ${r.cnt} 件)`);
}
console.log('   · 无上限：' + UNCAPPED_ATTRS.map((id) => `${ATTR_CN[id]} ${Number((supply[id] ?? 0).toFixed(2))}(${coverCount[id] ?? 0}件)`).join(' / '));

if (!DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const readme = [
        ...mdLines.slice(0, headEnd),
        `## 7. 全表（${ITEMS.length} 件）`,
        '',
        '- Markdown：[`relics-inner.md`](./relics-inner.md)',
        '- Excel：`relics-inner.csv`（同内容，带表头，可直接打开评审）',
        '',
    ];
    fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme.join('\n'), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'relics-inner.md'), mdLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'relics-inner.csv'), '\ufeff' + csvRows.join('\n'), 'utf8');
    console.log(`[设计稿] 已写：${path.relative(ROOT, path.join(OUT_DIR, 'README.md'))}`);
    console.log(`[设计稿] 已写：${path.relative(ROOT, path.join(OUT_DIR, 'relics-inner.md'))}`);
    console.log(`[设计稿] 已写：${path.relative(ROOT, path.join(OUT_DIR, 'relics-inner.csv'))}`);
}

if (problems.length) process.exitCode = 1;
