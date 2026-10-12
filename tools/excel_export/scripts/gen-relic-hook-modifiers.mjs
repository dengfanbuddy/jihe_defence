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
 *   · **200~ = 遗物钩子（本脚本）**，**自动跳过 240~259** ——
 *     那一段被神器 / 掉落 Buff 的脚本行占着（`KillBuff_*` = 240~243、`BattleItem_BloodBag` = 250），
 *     所以 41~43 号钩子从 260 起；**300~311 = 遗物钩子要施加的减益/DoT（本脚本）**
 *     （段定义在 `lib/relic-inner-design.mjs` 的 `HOOK_MOD_GAPS` / `DEBUFF_MOD_BASE`）
 *
 * 用法：`node scripts/gen-relic-hook-modifiers.mjs`（`--dry` 只报告不写盘）
 * ⚠ 写完必须回灌 xlsx：`node src/cli.ts json2excel --force --table modifiers`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKS, hookModId, HOOK_MOD_BASE, DEBUFF_MOD_BASE, HOOK_MOD_GAPS } from './lib/relic-inner-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'assets/resources/tb/modifiers.json');
const DRY = process.argv.includes('--dry');

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
/**
 * **手维护的 UI 列**：这几列是 2026-11 状态栏那一批加上的（`modifiers.bar_show` 白名单 /
 * `bar_text` 短标 / `desc` 说明面板 / `icon` / `is_hidden`），**不属于本脚本生产的字段**。
 *
 * ⚠⚠ 不加这个保留会有两个真实后果（两条都被 `npm run audit:statusbar` 抓得到，但发现得太晚）：
 *   · 全部 `RelicHook_*` 行的 `bar_show`/`bar_text`/`desc` 被抹掉 ⇒ HUD 状态栏那 8 个载体
 *     （蓄力/护盾充能/法术屏障/濒死守护/不屈/连击/圣盾池/时间回廊）**一次性全部不出栏**；
 *   · `#212 遗物·连击` 的 `is_hidden` 被人手改成了 `false`（白名单要求 `bar_show` 与 `is_hidden` 不许打架），
 *     落表会把它写回 `true` ⇒ 体检的 C1 当场红。
 * 判据：**盘上那一行已经有的 UI 列，原样带过来**；新钩子没有旧行，才用脚本默认值（`is_hidden: true`）。
 */
const UI_COLUMNS = ['bar_show', 'bar_text', 'desc', 'icon', 'is_hidden'];
const prevById = new Map(rows.map((r) => [r.id, r]));

const hookRows = HOOKS.map((h) => {
    const impl = String(h.impl).replace(/^S:/, '');
    if (!impl.startsWith('RelicHook_')) throw new Error(`钩子 ${h.id} 的 impl 不是脚本类：${h.impl}`);
    const row = {
        // ⚠ 走 `hookModId()`（设计真源的分配器），**不要**写 `HOOK_MOD_BASE + i`：
        //   那个位置式算法会撞上 240~259（神器 / 掉落 Buff 的脚本行），撞号守卫会直接拒绝写盘。
        id: hookModId(h.id),
        name: `遗物·${h.cn}`,
        is_debuff: false,
        is_hidden: true,
        dispel_level: 0,   // 遗物被动**不可驱散**（Purge 只会移除 dispel_level > 0 的）
        duration: -1,      // 永久（唯一口径，别用 0/null）
        stack_mode: 'refresh',
        script_id: impl,
    };
    const prev = prevById.get(row.id);
    if (prev) for (const k of UI_COLUMNS) if (prev[k] !== undefined) row[k] = prev[k];
    return row;
});

/* ---------- 2. 合并（清掉**本脚本拥有的**旧行，按 id 排序插回） ---------- */
/**
 * 本脚本"拥有"哪些行？—— 删除范围必须等于**我写的行**，不能是"这个 id 段"。
 *
 * ⚠⚠ **2026-11 修掉的静默删数据**：原先这里写的是
 * `(id >= 200 && id < 300) || (id >= 300 && id < 400)` —— 那个范围**把别人的行也圈进来了**。
 * 神器 / 掉落 Buff 的脚本行就落在这一段里（`KillBuff_Skyfall` … = 240~243、`BattleItem_BloodBag` = 250），
 * 于是**跑一次 `npm run gen:relic-hooks` 就会把那 5 条静默删掉** ——
 * 后果是 4 件机制型神器与「血包」全部变成指向不存在 Modifier 的引用（界面上表现为"买了没效果"），
 * 而这条命令正是设计文档里"改完遗物设计后按序跑"的第二步。任何下一次遗物设计改动都会踩到它。
 *
 * 现在的判据 = **按归属标记认领**：
 *   · 钩子行：`script_id` 以 `RelicHook_` 开头（神器那批是 `KillBuff_` / `BattleItem_`，不会误伤）；
 *   · 减益/DoT 行：`DEBUFF_ROWS` 的**精确 id 清单**，外加"id 在 300 段、没有 script_id、
 *     名字以「遗物·」开头"的历史残行（本轮删掉某条 DoT 时它才需要被清）。
 * 另外加一道**撞号守卫**：算出来的钩子 id 若撞上别人的行，直接抛错而不是覆盖。
 */
const DEBUFF_IDS = new Set(DEBUFF_ROWS.map((r) => r.id));
const ownedByMe = (r) => String(r.script_id ?? '').startsWith('RelicHook_')
    || DEBUFF_IDS.has(r.id)
    || (r.id >= DEBUFF_MOD_BASE && r.id < DEBUFF_MOD_BASE + 100
        && !r.script_id && String(r.name ?? '').startsWith('遗物·'));
const kept = rows.filter((r) => !ownedByMe(r));
const merged = [...kept, ...hookRows, ...DEBUFF_ROWS].sort((a, b) => a.id - b.id);

/* ---------- 2b. 撞号守卫 + 清账 ---------- */
const droppedRows = rows.filter((r) => !kept.includes(r));
{
    const mine = new Set([...hookRows, ...DEBUFF_ROWS].map((r) => r.id));
    const clash = merged.filter((r) => mine.has(r.id) && !ownedByMe(r));
    if (clash.length) {
        throw new Error(`[钩子落表] id 撞号，拒绝写盘（会覆盖别人的行）：`
            + clash.map((r) => `${r.id} ${r.name ?? ''} script_id=${r.script_id ?? '-'}`).join(' / ')
            + '\n  → 钩子 id 段见 relic-inner-design.mjs 的 HOOK_RESERVED_MOD_IDS 注释，换一段再落表');
    }
}

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

console.log(`[钩子落表] 钩子行 ${hookRows.length} 条（id ${hookRows.map((r) => r.id).join(',')}）`);
console.log(`[钩子落表] 减益/DoT 行 ${DEBUFF_ROWS.length} 条（id ${DEBUFF_MOD_BASE}~${DEBUFF_MOD_BASE + DEBUFF_ROWS.length - 1}）`);
console.log(`[钩子落表] modifiers 总行数 ${rows.length} → ${merged.length}；顺手把 ${fixedBurn} 处属性 13 改成 12`);
console.log(`[钩子落表] 按归属清掉旧行 ${droppedRows.length} 条：${droppedRows.map((r) => r.id).join(',') || '（无）'}`);
console.log(`[钩子落表] 保留的非本脚本行 ${kept.length} 条（神器/掉落 Buff/手工 Modifier/属性模板都在这里，**不会被碰**）`);
for (const h of hookRows) console.log(`   ${h.id} ${h.name} → ${h.script_id}`);

if (DRY) {
    console.log('[钩子落表] --dry：未写盘');
} else {
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`[钩子落表] 已写 ${path.relative(ROOT, FILE)}`);
}
