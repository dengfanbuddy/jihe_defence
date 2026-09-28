/**
 * migrate-modifier-effects.ts —— 一次性迁移：modifiers.json 的旧三列 → 原子效果 `effects`
 *
 * 背景：Modifier 的效果已原子化（见 excel_table/EffectTypes.ts）。
 * 旧的三个固定列被 `effects` 取代：
 *   properties: [[13, 0]]                     → effects: [{ "type":"modify_attr", "attrs":[[13, 0]] }]
 *   properties: [[5, {value:-90, var:"slow"}]] → effects: [{ "type":"modify_attr", "attrs":[{ "attr":5, "value":-90, "var":"slow" }] }]
 *   states: { "stunned": true }                → effects: [{ "type":"apply_state", "state":"stunned" }]
 *   tick: { interval, damage, damage_type }    → effects: [{ "type":"tick_damage", "interval", "value":damage, "damage_type" }]
 *   tick: { interval, heal }                   → effects: [{ "type":"tick_heal", "interval", "value":heal }]
 *   tick: { interval, apply_modifier, ... }    → effects: [{ "type":"tick_apply_modifier", ... }]
 * 一条 Modifier 的多个旧列会按「属性 → 状态 → 周期」顺序合成一个 effects 数组。
 *
 * **幂等**：已经有 `effects` 的行原样保留（只做键顺序规范化），可反复执行。
 *
 * 用法：node tools/excel_export/scripts/migrate-modifier-effects.ts
 * 之后：cd tools/excel_export && npm run import -- --force --table modifiers
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FILE = path.join(ROOT, 'assets/resources/tb/modifiers.json');

/** 旧键 → 新键的顺序（写入 JSON 时按此顺序，便于人工 diff） */
const KEY_ORDER = [
    'id', 'name', 'icon', 'is_debuff', 'is_hidden', 'dispel_level', 'duration', 'cd',
    'stack_mode', 'max_stack', 'strongest_only', 'effects', 'events', 'script_id',
];

/** 把旧的三列折叠成原子效果列表 */
function toEffects(rec: Record<string, any>): any[] {
    if (Array.isArray(rec.effects)) return rec.effects;

    const effects: any[] = [];

    if (Array.isArray(rec.properties)) {
        const attrs = rec.properties.map((p: any[]) => {
            const v = p[1];
            if (typeof v === 'number') return [p[0], v];
            const entry: Record<string, any> = { attr: p[0], value: v?.value ?? 0 };
            if (v?.mode !== undefined) entry.mode = v.mode;
            if (v?.var !== undefined) entry.var = v.var;
            return entry;
        });
        if (attrs.length) effects.push({ type: 'modify_attr', attrs });
    }

    if (rec.states && typeof rec.states === 'object') {
        for (const [state, on] of Object.entries(rec.states as Record<string, boolean>)) {
            effects.push(on === false ? { type: 'apply_state', state, value: false } : { type: 'apply_state', state });
        }
    }

    const t = rec.tick;
    if (t && typeof t === 'object') {
        const interval = t.interval;
        if (t.damage) {
            const e: Record<string, any> = { type: 'tick_damage', interval, value: t.damage };
            if (t.damage_type) e.damage_type = t.damage_type;
            effects.push(e);
        }
        if (t.heal) effects.push({ type: 'tick_heal', interval, value: t.heal });
        if (t.apply_modifier) {
            const e: Record<string, any> = { type: 'tick_apply_modifier', interval, modifier: t.apply_modifier };
            if (t.apply_modifier_duration !== undefined) e.duration = t.apply_modifier_duration;
            if (t.apply_modifier_chance !== undefined) e.chance = t.apply_modifier_chance;
            effects.push(e);
        }
    }

    return effects;
}

/** 按 KEY_ORDER 重建对象（丢掉 properties/states/tick 三个旧键） */
function reorder(rec: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const k of KEY_ORDER) {
        if (rec[k] !== undefined) out[k] = rec[k];
    }
    for (const k of Object.keys(rec)) {
        if (out[k] === undefined && !['properties', 'states', 'tick'].includes(k)) out[k] = rec[k];
    }
    return out;
}

const rows: Record<string, any>[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let migrated = 0;

const out = rows.map((rec) => {
    const effects = toEffects(rec);
    const changed = !Array.isArray(rec.effects) || rec.properties !== undefined;
    if (changed) migrated++;
    const next = reorder({ ...rec, effects });
    if (effects.length === 0) delete next.effects;
    return next;
});

fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`✔ ${path.relative(ROOT, FILE)}：共 ${out.length} 条，迁移 ${migrated} 条（已有 effects 的行原样保留）`);
console.log('接着执行：cd tools/excel_export && npm run import -- --force --table modifiers');
