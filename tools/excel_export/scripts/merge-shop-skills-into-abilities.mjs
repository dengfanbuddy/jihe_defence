/**
 * merge-shop-skills-into-abilities.mjs —— 把独立的 `shop_skills` 表**并入 `abilities` 表**（一次性，幂等）
 *
 * 背景：原来「单位技能」与「肉鸽额外技能」是两张表（abilities / shop_skills），
 * 但两者跑的是**同一套运行时**（同一个 `AbilitySystem` / `Ability` / `EffectExecutor`），
 * 技能槽也只能看到一张列表 —— 两张表意味着「同一个概念两处定义」。
 * 合并后：一张 `abilities` 表，靠 `scope` 说明技能出现在哪一侧：
 *   unit = 单位自带（units.json 的 abilities 引用）· shop = 肉鸽商店抽取池 · both = 两侧都出
 *
 * 本脚本做四件事（可重复执行，结果一致）：
 *   ① 老的 22 条单位技能补 `scope: 'unit'` + `max_level: 1`（新列，缺省即补）
 *   ② `shop_skills.json` 的 30 条技能**换 id 段**（1~30 → 101~130，避开单位技能 id）后并入 abilities
 *   ③ 按 schema 的字段顺序重排每一行的键（Excel 往返要求列序稳定）
 *   ④ 删掉 `shop_skills.json`（xlsx 请手工删除或用 git rm）
 *
 * 用法：node tools/excel_export/scripts/merge-shop-skills-into-abilities.mjs [--dry-run]
 *
 * ⚠ 合并进来的 30 条是**设计稿原文**：只带 name/品质/阶段/权重/多级描述/tags/synergy，
 *   `behavior: 'passive'` + `effects: []`（设计稿描述的是「普攻附加灼烧」「召唤炮台」这类
 *   需要行为实现的机制，现有 ConfigAction 词汇表表达不了）。
 *   也就是说：**它们现在能在商店抽到、能进技能槽、能升级、能显示描述，但还没有实际战斗效果**，
 *   要生效得给对应条目补 `effects` 或 `script_id`（与 38 条只有文案的遗物被动同一处境）。
 *   `npm run check` 会对「商店技能既无 effects 也无 script_id」给出提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TB = path.join(ROOT, 'assets/resources/tb');

/** 肉鸽额外技能的 id 偏移：原 shop_skills.id(1~30) → 100 + id = 101~130 */
const SKILL_ID_OFFSET = 100;

/** abilities 表的字段顺序（必须与 tools/excel_export/src/core/schema.ts 的 abilities.fields 一致） */
const ABILITY_FIELD_ORDER = [
    'id', 'name', 'code', 'name_en', 'scope', 'icon',
    'behavior', 'cooldown', 'mana_cost', 'cast_range', 'cast_point',
    'damage_type', 'damage', 'targeting', 'effects', 'script_id',
    'level', 'level_damage', 'upgrades_to', 'projectile_prefab',
    'rarity', 'stage', 'weight', 'max_level', 'tags',
    'lv1', 'lv2', 'lv3', 'effects_lv2', 'effects_lv3', 'synergy',
];

const dryRun = process.argv.includes('--dry-run');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(TB, file), 'utf8'));
const writeJson = (file, data) => {
    fs.writeFileSync(path.join(TB, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

/** 按 schema 字段顺序重排键（未登记的键留在末尾，避免静默丢字段） */
function reorder(rec) {
    const out = {};
    for (const key of ABILITY_FIELD_ORDER) {
        if (rec[key] !== undefined) out[key] = rec[key];
    }
    for (const key of Object.keys(rec)) {
        if (!(key in out)) out[key] = rec[key];
    }
    return out;
}

const abilities = readJson('abilities.json');
if (!Array.isArray(abilities)) throw new Error('abilities.json 不是数组');

const skillsPath = path.join(TB, 'shop_skills.json');
const hasSkills = fs.existsSync(skillsPath);
const shopSkills = hasSkills ? readJson('shop_skills.json') : [];

/* ① 单位技能补齐新列 */
let patched = 0;
for (const rec of abilities) {
    if (rec.scope === undefined) {
        rec.scope = 'unit';
        patched++;
    }
    if (rec.max_level === undefined) rec.max_level = 1;
}

/* ② 商店技能并入（幂等：按合并后的 id 判重） */
const byId = new Map(abilities.map((r) => [r.id, r]));
let added = 0;
for (const sk of shopSkills) {
    const id = sk.id + SKILL_ID_OFFSET;
    if (byId.has(id)) continue;
    const maxLevel = sk.lv3 ? 3 : sk.lv2 ? 2 : 1;
    const rec = {
        id,
        name: sk.name,
        code: sk.code,
        name_en: sk.name_en,
        scope: 'shop',
        // ⚠ 行为留 passive + 空 effects：设计稿描述的是需要行为实现的机制（见文件头）
        behavior: 'passive',
        cooldown: 0,
        mana_cost: 0,
        effects: [],
        rarity: sk.rarity,
        stage: sk.stage,
        weight: sk.weight,
        max_level: maxLevel,
    };
    if (Array.isArray(sk.tags) && sk.tags.length) rec.tags = sk.tags;
    rec.lv1 = sk.lv1;
    if (sk.lv2) rec.lv2 = sk.lv2;
    if (sk.lv3) rec.lv3 = sk.lv3;
    if (sk.synergy) rec.synergy = sk.synergy;

    const ordered = reorder(rec);
    abilities.push(ordered);
    byId.set(id, ordered);
    added++;
}

/* ③ 字段顺序归一 + 按 id 排序（Excel 里看着舒服，往返也稳定） */
const merged = abilities.map(reorder).sort((a, b) => a.id - b.id);

/* 自检：id 唯一 + 商店技能必填列齐全 */
const seen = new Set();
for (const rec of merged) {
    if (seen.has(rec.id)) throw new Error(`abilities id 重复：${rec.id}`);
    seen.add(rec.id);
    if ((rec.scope === 'shop' || rec.scope === 'both')) {
        for (const key of ['rarity', 'stage', 'max_level']) {
            if (rec[key] === undefined || rec[key] === null) {
                throw new Error(`商店技能 ${rec.id}（${rec.name}）缺少 ${key}`);
            }
        }
    }
}

console.log(`▌合并 shop_skills → abilities（${dryRun ? 'DRY RUN' : '写入'}）`);
console.log(`  单位技能补 scope/max_level：${patched} 条`);
console.log(`  并入肉鸽技能：${added} 条（共 ${merged.length} 条，id ${Math.min(...merged.map((r) => r.id))}~${Math.max(...merged.map((r) => r.id))}）`);
const shopCount = merged.filter((r) => r.scope === 'shop').length;
console.log(`  当前 scope=shop 的技能：${shopCount} 个`);
const noEffect = merged.filter((r) => r.scope === 'shop' && (!r.effects || !r.effects.length) && !r.script_id);
console.log(`  ⚠ 其中 ${noEffect.length} 个还没有 effects/script_id（只有设计稿文案，暂无战斗效果）`);

if (dryRun) process.exit(0);

writeJson('abilities.json', merged);
if (hasSkills) {
    fs.rmSync(skillsPath);
    console.log('  已删除 assets/resources/tb/shop_skills.json');
}
console.log('\n完成。接着执行：');
console.log('  cd tools/excel_export && npm run import -- --force --table abilities');
console.log('  npm run verify && npm run check');
console.log('  git rm excel/shop_skills.xlsx   # 旧表已并入 abilities');
