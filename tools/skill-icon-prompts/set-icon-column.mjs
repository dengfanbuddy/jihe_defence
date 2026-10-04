/**
 * set-icon-column.mjs —— 把 30 个局内肉鸽技能的 `icon` 列写进 `assets/resources/tb/abilities.json`
 *
 * 幂等：已经是目标值的行原样不动；`icon` 目标值 = `textures/skills/<code>`
 * （code 来自 `tools/skill-icon-prompts/skills.json`，**不是**从名字猜的）。
 *
 * 两条工程纪律（都在 AGENTS.md 里，这里照做）：
 *   ① 键顺序按 schema 重排 —— `abilities` 的规范顺序见下（与 `.tmp/apply-hero-config.mjs`
 *      当初补英雄技能 icon 时用的是同一份），否则 `npm run verify` 的「往返无损」会红；
 *   ② **改完 JSON 必须回灌 xlsx**，否则下一次 `npm run export`（xlsx→JSON）会把这次改动覆盖掉：
 *        cd tools/excel_export; node src/cli.ts json2excel --force --table abilities
 *      （⚠ 不是 `npm run import -- --force --table abilities` —— 当前 npm 会把参数吃掉。）
 *
 * 用法：
 *   node tools/skill-icon-prompts/set-icon-column.mjs --dry-run
 *   node tools/skill-icon-prompts/set-icon-column.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ABILITIES = path.join(ROOT, 'assets/resources/tb/abilities.json');
const SKILLS = path.join(HERE, 'skills.json');
const DRY = process.argv.includes('--dry-run');

/** abilities 的规范键顺序（与 schema 一致；schema 里没有的键由 reorder 兜底保留） */
const ORDER = ['id', 'name', 'code', 'name_en', 'scope', 'icon', 'behavior', 'cooldown', 'mana_cost', 'cast_range',
    'cast_point', 'damage_type', 'damage', 'targeting', 'effects', 'script_id', 'level', 'level_damage',
    'upgrades_to', 'projectile_prefab', 'rarity', 'stage', 'weight', 'max_level', 'tags',
    'lv1', 'lv2', 'lv3', 'effects_lv2', 'effects_lv3', 'synergy'];

const reorder = (obj, order) => {
    const out = {};
    for (const k of order) if (k in obj) out[k] = obj[k];
    for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];   // 兜底：schema 外的键也留着
    return out;
};

function main() {
    const data = JSON.parse(fs.readFileSync(SKILLS, 'utf8'));
    const rows = JSON.parse(fs.readFileSync(ABILITIES, 'utf8'));

    /** id → 目标 icon 路径 */
    const want = new Map();
    for (const s of data.skills) want.set(s.id, `textures/skills/${s.code}`);

    let set = 0;
    let unchanged = 0;
    const missing = [];

    const next = rows.map((r) => {
        const target = want.get(r.id);
        if (target === undefined) return reorder(r, ORDER);      // 不是本轮的技能：只重排键序
        if (r.scope !== 'shop') missing.push(`id ${r.id}（${r.name}）scope=${r.scope}，不是 shop`);
        if (r.icon === target) { unchanged++; return reorder(r, ORDER); }
        set++;
        console.log(`  ${r.id} ${r.name}：${r.icon ? `"${r.icon}"` : '（空）'} → "${target}"`);
        return reorder({ ...r, icon: target }, ORDER);
    });

    if (missing.length) {
        console.error('✗ 有技能在配表里不是 shop：');
        for (const m of missing) console.error(`   - ${m}`);
        process.exit(1);
    }
    // 反向：skills.json 里的 id 是否都能在配表里找到
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, p] of want) {
        if (!ids.has(id)) { console.error(`✗ skills.json 的 id ${id}（${p}）在 abilities.json 里不存在`); process.exit(1); }
    }

    const withIcon = next.filter((r) => r.icon).length;
    console.log(`◆ abilities.json：${rows.length} 行；本次写入 ${set} 条，已是目标值 ${unchanged} 条；全表带 icon 共 ${withIcon} 条`);

    if (DRY) { console.log('（--dry-run：未写盘）'); return; }

    // 规范 JSON：2 空格缩进 + 末尾换行（工程既有格式，`npm run verify` 依赖它）
    fs.writeFileSync(ABILITIES, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`✔ 已写 ${path.relative(ROOT, ABILITIES)}`);
    console.log('   别忘了回灌 xlsx：cd tools/excel_export; node src/cli.ts json2excel --force --table abilities');
}

main();
