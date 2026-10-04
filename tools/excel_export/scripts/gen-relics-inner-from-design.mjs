/**
 * 局内遗物效果重做 → `assets/resources/tb/relics.json` 落表（**幂等**，可反复跑）
 *
 * 输入：设计真源 `scripts/lib/relic-inner-design.mjs`（最终表 = `resolveFinalItems()`）
 * 输出：`relics.json` 的**局内版**（`rarity` / `description_inner` / `modifiers_inner`）按设计稿重写；
 *       删除清单里的 30 件**整行删除**（它们只在局内出现，见下面的自检）。
 *
 * 不动的东西（口径：名字与图标不改，省美术成本）：
 *   · `id` / `name` / `code` / `icon` / `category` / `scope` 原样保留；
 *   · **局外版**（`description_outer` / `modifiers_outer`）完全不动；
 *   · 设计之外的每一行（`scope=outer` 的 1294~1302 等）原样透传。
 *
 * 落表形态：
 *   · 纯属性 → 共享模板 `{modifier: 1000, kv: {attrs}}`（**不要**为每件遗物新建 Modifier）
 *   · 钩子   → `{modifier: 200+i, kv: 该钩子在本件品质下的数值}`（行由 `gen-relic-hook-modifiers.mjs` 生成）
 *   · `duration: null` = 永久（唯一口径，别写 0）
 *
 * 用法：`node scripts/gen-relics-inner-from-design.mjs`（`--dry` 只报告不写盘 / `--limit 5` 只为检查打印示例）
 * ⚠ 写完必须回灌 xlsx：`node src/cli.ts json2excel --force --table relics`，再 `npm run export` / `npm run check`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveFinalItems, descriptionOf, hookModId, hookKv, DROP_IDS,
} from './lib/relic-inner-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'assets/resources/tb/relics.json');
const DRY = process.argv.includes('--dry');
const SAMPLE = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1] || 0);

/** 「属性修改」共享模板 id（`battle/types.ts` 的 MODIFY_ATTR_TEMPLATE_ID） */
const MODIFY_ATTR_TEMPLATE_ID = 1000;

const relics = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byId = new Map(relics.map((r) => [r.id, r]));
const finalById = new Map(resolveFinalItems().map((i) => [i.id, i]));

/* --------------------------------------------------- 自检：删除的件必须只在局内出现 */

for (const id of DROP_IDS) {
    const row = byId.get(id);
    if (!row) continue;                       // 已经删过了（幂等）
    if (row.scope !== 'inner') {
        throw new Error(`要删的遗物 ${id} ${row.name} 的 scope=${row.scope}（含局外版），不能整行删 —— 改设计或改成"只清空局内版"`);
    }
}

/* --------------------------------------------------- 组装局内版 */

/** 一件遗物 → `modifiers_inner`（纯属性一条 + 每条钩子一条） */
function toModifiers(item) {
    const out = [];
    if ((item.a ?? []).length) {
        out.push({ modifier: MODIFY_ATTR_TEMPLATE_ID, duration: null, kv: { attrs: item.a.map((e) => [...e]) } });
    }
    for (const h of item.h ?? []) {
        const hookId = Array.isArray(h) ? h[0] : h;
        const tier = Array.isArray(h) ? h[1] : item.r;
        out.push({ modifier: hookModId(hookId), duration: null, kv: hookKv(hookId, tier) });
    }
    return out;
}

const out = [];
const droppedScriptIds = [];
let touched = 0;
let removed = 0;

for (const row of relics) {
    if (DROP_IDS.has(row.id)) { removed++; continue; }
    const item = finalById.get(row.id);
    if (!item) { out.push(row); continue; }    // 局外独有 / 设计之外：原样透传

    const next = { id: row.id, name: row.name };
    if (row.code !== undefined) next.code = row.code;
    if (row.icon !== undefined) next.icon = row.icon;
    next.rarity = item.r;                       // 品质按池深 4:3:2:1 重分档
    next.scope = row.scope;
    if (row.category !== undefined) next.category = row.category;
    next.description_inner = descriptionOf(item);
    next.modifiers_inner = toModifiers(item);
    if (row.description_outer !== undefined) next.description_outer = row.description_outer;
    if (row.modifiers_outer !== undefined) next.modifiers_outer = row.modifiers_outer;
    // 局内版的复杂逻辑现在**全部**由钩子（modifiers_inner）表达；
    // 老的 relic 级 script_id（如 demo 的 Relic_PocketMercy）全工程无消费方，是死引用 → 丢弃并记录
    if (row.script_id !== undefined) droppedScriptIds.push(`${row.id} ${row.name}: ${row.script_id}`);

    const oldRarity = row.rarity;
    const oldDesc = row.description_inner;
    if (oldRarity !== item.r || oldDesc !== next.description_inner) touched++;
    out.push(next);
}

/* --------------------------------------------------- 报告 */

const rarityCount = {};
for (const r of out) if (r.scope !== 'outer') rarityCount[r.rarity] = (rarityCount[r.rarity] ?? 0) + 1;
console.log(`[遗物落表] 行数 ${relics.length} → ${out.length}（删除 ${removed} 件）`);
console.log(`[遗物落表] 局内版品质分布：` + ['common', 'rare', 'epic', 'legendary'].map((r) => `${r} ${rarityCount[r] ?? 0}`).join(' / '));
console.log(`[遗物落表] 品质或文案有变化 ${touched} 件；丢弃死 script_id ${droppedScriptIds.length} 处`);
for (const s of droppedScriptIds) console.log('   · ' + s);

if (SAMPLE > 0) {
    for (const item of resolveFinalItems().slice(0, SAMPLE)) {
        const row = out.find((r) => r.id === item.id);
        console.log(`   ${row.id} ${row.name} [${row.rarity}] ${row.description_inner}`);
        console.log(`      ${JSON.stringify(row.modifiers_inner)}`);
    }
}

if (DRY) {
    console.log('[遗物落表] --dry：未写盘');
} else {
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[遗物落表] 已写 ${path.relative(ROOT, FILE)}`);
}
