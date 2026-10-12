/**
 * 局外遗物重做 → `assets/resources/tb/relics.json` 落表（**幂等**，可反复跑）
 *
 * 输入：设计真源 `scripts/lib/relic-outer-design.mjs`（形状/数值/词缀的唯一出处）
 * 输出（对**每一件有局内版的遗物**）：
 *   · `scope` → `both`（用户口径①：局内局外**严格对齐**，268 件一件不多一件不少）
 *   · `description_outer` / `modifiers_outer`（按品质预算算出来的固定值属性）
 *   · `effects_outer`（红件的局内开局词缀；非红件写空数组）
 *   并**整行删除**只有局外版的那 9 件（1294~1302）—— 它们在局内不存在，属"局外额外的东西"。
 *
 * ⚠ 写完必须回灌 xlsx：`node src/cli.ts json2excel --force --table relics`，再 `npm run check` / `npm run verify`。
 * 用法：`node scripts/gen-relics-outer.mjs`（`--dry` 只报告不写盘 / `--limit=5` 打印前 5 件示例）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    outerDescriptionOf, outerModifiersOf, outerEffectsOf, outerAttrEntries, outerRunEffectOf,
    OUTER_ATTRS, OUTER_UNIT, OUTER_TOTAL_TARGET, FORBIDDEN_ATTRS, formatRunEffect,
} from './lib/relic-outer-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'assets/resources/tb/relics.json');
const DRY = process.argv.includes('--dry');
const SAMPLE = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1] || 0);

const relics = JSON.parse(fs.readFileSync(FILE, 'utf8'));

/* --------------------------------------------------- 自检：要删的件必须真的只有局外版 */

const doomed = relics.filter((r) => r.scope === 'outer');
for (const row of doomed) {
    if ((row.modifiers_inner ?? []).length || row.description_inner) {
        throw new Error(`要删的遗物 ${row.id} ${row.name} 含局内版（在局内商店里出得来），不能整行删 —— 改设计或改成"只清空局外版"`);
    }
}

/* --------------------------------------------------- 组装局外版 */

const out = [];
let touched = 0;
for (const row of relics) {
    if (row.scope === 'outer') continue;                 // 只有局外版的整行删除
    const next = { ...row };
    next.scope = 'both';
    next.description_outer = outerDescriptionOf(row);
    next.modifiers_outer = outerModifiersOf(row);
    next.effects_outer = outerEffectsOf(row);
    if (JSON.stringify([row.scope, row.description_outer, row.modifiers_outer, row.effects_outer])
        !== JSON.stringify([next.scope, next.description_outer, next.modifiers_outer, next.effects_outer])) touched++;
    out.push(next);
}

/* --------------------------------------------------- 红线（落表是设计真源的最后一道闸） */

const totals = {};
const effCount = {};
for (const row of out) {
    for (const [a, v] of outerAttrEntries(row)) {
        if (FORBIDDEN_ATTRS.has(a)) throw new Error(`${row.id} ${row.name}：局外给了被禁的比例型属性 ${a}`);
        if (!OUTER_ATTRS.includes(a)) throw new Error(`${row.id} ${row.name}：局外给了白名单外的属性 ${a}`);
        totals[a] = (totals[a] ?? 0) + v;
    }
    if (!row.description_outer) throw new Error(`${row.id} ${row.name}：局外描述为空`);
    const eff = outerRunEffectOf(row);
    if (eff) effCount[eff.code] = (effCount[eff.code] ?? 0) + 1;
    if (row.rarity === 'legendary' && !eff) throw new Error(`${row.id} ${row.name}：红件没有开局词缀`);
    if (row.rarity !== 'legendary' && eff) throw new Error(`${row.id} ${row.name}：非红件不该有开局词缀`);
}

/* --------------------------------------------------- 报告 */

const tierCount = {};
for (const r of out) tierCount[r.rarity] = (tierCount[r.rarity] ?? 0) + 1;
console.log(`[局外遗物] 行数 ${relics.length} → ${out.length}（删除只有局外版的 ${doomed.length} 件：${doomed.map((r) => r.id).join('/')}）`);
console.log(`[局外遗物] 品质分布：` + ['common', 'rare', 'epic', 'legendary'].map((r) => `${r} ${tierCount[r] ?? 0}`).join(' / '));
console.log(`[局外遗物] 局外版有变化 ${touched} 件`);
console.log(`[局外遗物] 集齐 268 件 × 1 份的局外总量（目标见 OUTER_TOTAL_TARGET）：`);
for (const a of OUTER_ATTRS) {
    const t = Math.round((totals[a] ?? 0) * 100) / 100;
    const target = OUTER_TOTAL_TARGET[a];
    console.log(`   · 属性 ${a}: ${t}  (目标 ${target}, 偏差 ${(((t / target) - 1) * 100).toFixed(1)}%)  单位值 ${OUTER_UNIT[a]}`);
}
console.log(`[局外遗物] 红件开局词缀：` + Object.entries(effCount).map(([c, n]) => `${c} ${n} 件`).join(' / '));

if (SAMPLE > 0) {
    console.log('\n[局外遗物] 示例：');
    for (const row of out.slice(0, SAMPLE)) {
        const eff = outerRunEffectOf(row);
        console.log(`   ${row.id} ${row.name} [${row.rarity}] ${row.description_outer}`);
        if (eff) console.log(`      effects_outer = ${JSON.stringify(row.effects_outer)}  (${formatRunEffect(eff.code, eff.value)})`);
    }
}

if (DRY) {
    console.log('[局外遗物] --dry：未写盘');
} else {
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[局外遗物] 已写 ${path.relative(ROOT, FILE)}`);
}
