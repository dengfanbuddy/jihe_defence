/**
 * 局内遗物钩子 → `modifiers.json` 落表（**幂等**）
 *
 * 做什么：
 *   1. 把设计真源 `scripts/lib/relic-inner-design.mjs` 的 `HOOKS` 数组落成 **id 200 起的一条钩子一行**
 *      （`duration: -1` 永久、`dispel_level: 0` 不可驱散、`script_id` 指向 `battle/RelicHooks.ts` 的类）；
 *   2. 补齐钩子要用到的「目标减益 / 周期伤害」行（id 300~311，减速/沉默/妖术/破甲/冰封/点燃×3/中毒×3）；
 *   3. 顺手修掉历史脏数据：`id 1 燃烧` 里的 `[13, 0]`（13 已并入 12，见 types.ts 的受伤减免）。
 *
 * 为什么 id 段这么切：
 *   · 1~26   = 手工 Modifier（历史）
 *   · 40~67  = 肉鸽技能脚本行（ShopSkillModifiers）
 *   · 1000   = 「属性修改」共享模板（纯属性加成全部引用它）
 *   · **200~239 = 遗物钩子（本脚本）**；**300~311 = 遗物钩子要施加的减益/DoT（本脚本）**
 *
 * 用法：`node scripts/gen-relic-hook-modifiers.mjs`（`--dry` 只报告不写盘）
 * ⚠ 写完必须回灌 xlsx：`node src/cli.ts json2excel --force --table modifiers`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKS } from './lib/relic-inner-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'assets/resources/tb/modifiers.json');
const DRY = process.argv.includes('--dry');

/** 钩子行 id 起点（一条钩子一行，顺序 = HOOKS 数组顺序） */
export const HOOK_MOD_BASE = 200;
/** 减益/DoT 行 id 段 */
export const DEBUFF_MOD_BASE = 300;

/** 钩子施加给敌人的「减益 / 周期伤害」行（参数化：能由 kv 传值的走 `var`，DoT 按品质分三行） */
const DEBUFF_ROWS = [
    {
        id: 300, name: '遗物·减速', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 2, stack_mode: 'refresh',
        effects: [{ type: 'modify_attr', attrs: [{ attr: 5, value: -90, var: 'slow' }] }],
    },
    {
        id: 301, name: '遗物·沉默', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 2, stack_mode: 'refresh',
        effects: [{ type: 'apply_state', state: 'silenced' }],
    },
    {
        id: 302, name: '遗物·妖术', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 1.5, stack_mode: 'refresh',
        effects: [{ type: 'apply_state', state: 'hexed' }],
    },
    {
        id: 303, name: '遗物·破甲', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 2, stack_mode: 'stack', max_stack: 3,
        effects: [{ type: 'modify_attr', attrs: [{ attr: 6, value: -2, var: 'armor' }] }],
    },
    {
        id: 304, name: '遗物·冰封', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 1.5, stack_mode: 'none',
        effects: [{ type: 'apply_state', state: 'stunned' }],
    },
    // 点燃：概率触发、持续 3 秒，按品质分三行（tick_damage **不支持 var**，所以数值必须烘在行里）
    ...[6, 12, 20].map((dps, i) => ({
        id: 306 + i, name: `遗物·点燃（${['蓝', '黄', '红'][i]}）`, is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 3, stack_mode: 'refresh',
        effects: [{ type: 'tick_damage', interval: 1, value: dps, damage_type: 'magical' }],
    })),
    // 中毒：**renew**（每次命中新建独立实例 = 一层，5 层上限由钩子脚本判），持续 4 秒
    ...[4, 8, 14].map((dps, i) => ({
        id: 309 + i, name: `遗物·中毒（${['蓝', '黄', '红'][i]}）`, is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 4, stack_mode: 'renew',
        effects: [{ type: 'tick_damage', interval: 1, value: dps, damage_type: 'magical' }],
    })),
];

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));

/* ---------- 1. 钩子行 ---------- */
const hookRows = HOOKS.map((h, i) => {
    const impl = String(h.impl).replace(/^S:/, '');
    if (!impl.startsWith('RelicHook_')) throw new Error(`钩子 ${h.id} 的 impl 不是脚本类：${h.impl}`);
    return {
        id: HOOK_MOD_BASE + i,
        name: `遗物·${h.cn}`,
        is_debuff: false,
        is_hidden: true,
        dispel_level: 0,   // 遗物被动**不可驱散**（Purge 只会移除 dispel_level > 0 的）
        duration: -1,      // 永久（唯一口径，别用 0/null）
        stack_mode: 'refresh',
        script_id: impl,
    };
});

/* ---------- 2. 合并（清掉旧的本段行，按 id 排序插回） ---------- */
const inRange = (id) => (id >= HOOK_MOD_BASE && id < HOOK_MOD_BASE + 100) || (id >= DEBUFF_MOD_BASE && id < DEBUFF_MOD_BASE + 100);
const kept = rows.filter((r) => !inRange(r.id));
const merged = [...kept, ...hookRows, ...DEBUFF_ROWS].sort((a, b) => a.id - b.id);

/* ---------- 3. 历史脏数据：13 已并入 12 ---------- */
let fixedBurn = 0;
for (const r of merged) {
    for (const eff of r.effects ?? []) {
        for (const a of eff.attrs ?? []) {
            const entry = Array.isArray(a) ? a : null;
            if (entry && entry[0] === 13) { entry[0] = 12; fixedBurn++; }
            if (!entry && a && a.attr === 13) { a.attr = 12; fixedBurn++; }
        }
    }
}

console.log(`[钩子落表] 钩子行 ${hookRows.length} 条（id ${HOOK_MOD_BASE}~${HOOK_MOD_BASE + hookRows.length - 1}）`);
console.log(`[钩子落表] 减益/DoT 行 ${DEBUFF_ROWS.length} 条（id ${DEBUFF_MOD_BASE}~${DEBUFF_MOD_BASE + DEBUFF_ROWS.length - 1}）`);
console.log(`[钩子落表] modifiers 总行数 ${rows.length} → ${merged.length}；顺手把 ${fixedBurn} 处属性 13 改成 12`);
for (const h of hookRows) console.log(`   ${h.id} ${h.name} → ${h.script_id}`);

if (DRY) {
    console.log('[钩子落表] --dry：未写盘');
} else {
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`[钩子落表] 已写 ${path.relative(ROOT, FILE)}`);
}
