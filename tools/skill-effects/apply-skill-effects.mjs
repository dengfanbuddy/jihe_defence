/**
 * apply-skill-effects.mjs —— 把「审查定案」的技能效果落进配表（幂等）
 *
 * 本轮只落 **§4.1 的 6 条纯声明式技能**（零新增 TS，全部用现有声明式词汇表达）：
 *
 *   103 嗜血      普攻吸血 5% / 9% / 14%
 *   104 迅捷      攻击速度 +8% / +15% / +35%
 *   105 鹰眼      攻击范围 +12% / +20% / +45%
 *   106 强健      最大生命 +12% / +22% / +35%（三阶另给生命恢复 +2/秒）
 *   107 暴击机芯   暴击率 +8% / +15% / +24%（三阶另给暴击倍率 170）
 *   130 恶魔契约   攻击力 +40/60/100%、最大生命 -15/-25/-40%
 *
 * 设计依据与「为什么这么改」全在 `docs/skill-icons/README.md` §4.1 与 `docs/skill-icons/skills.md`。
 * 三条与引擎口径直接相关的取舍（都真跑源码核过）：
 *
 *   ① **「造成 X% 攻击力」类的技能不在这 6 条里** —— `damage`/`aoe_damage`/`tick_damage`
 *      的 `value` 是**绝对数**、不吃攻击力（只有 `modify_attr` 的属性条目能绑 `var`）。
 *      所以这 6 条全是**属性型**或**吸血型**，不需要脚本。带 % 伤害的那 16 条要写脚本。
 *   ② **`percent` 打在 base=0 的属性上恒为 0** → 护甲(6)/闪避(8)/生命恢复(9)/魔法恢复(10)/
 *      暴击率(14) 这五个必须用 `add`。所以 104 攻速用 `add`（攻速 base=100，+8 即 ×1.08）、
 *      107 暴击率用 `add`（百分点）、106 三阶的生命恢复用 `add`（固定值）。
 *   ③ **暴击倍率(15) 的词条必须显式写 `best`** —— 属性默认叠加方式就是 `best`，
 *      而 `best` 是 `max(base, Σv)`；写成 `add` 会变成 `base + Σv` 累加（踩过）。
 *
 * 另外顺手把原稿里**在本作做不到**的半句删掉（不是省略，是明确删）：
 *   · 103 l3「过量回复转化 30% 护盾」→ 本作没有护盾池（护盾 = `on_block_damage` 里写 `blocked` 字段）
 *   · 104 l3「攻速≥2.5 时首次命中必暴击」/ 105 l3「射程内无敌人时攻速 +10%」→ 条件式，
 *     声明式动作只有 `chance` 没有条件判断
 *   · 106 l3「每秒回复 1% 最大生命」→ `tick_heal.value` 是固定值，做不到「1% 动态」→ 改成固定 +2/秒
 *   · 130 l3「技能冷却 -25%」→ 属性表里没有「冷却缩减」
 *
 * 幂等：同 id 的行先删后插，全表按键顺序重排（`npm run verify` 要求往返无损）。
 *
 * 用法：
 *   node tools/skill-effects/apply-skill-effects.mjs --dry-run
 *   node tools/skill-effects/apply-skill-effects.mjs
 *   cd tools/excel_export; node src/cli.ts json2excel --force --table abilities,modifiers
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB = path.join(ROOT, 'assets/resources/tb');
const DRY = process.argv.includes('--dry-run');

/** 规范键顺序（与 schema 一致；schema 里没有的键由 reorder 兜底保留） */
const ORDER = {
    abilities: ['id', 'name', 'code', 'name_en', 'scope', 'icon', 'behavior', 'cooldown', 'mana_cost', 'cast_range',
        'cast_point', 'damage_type', 'damage', 'targeting', 'effects', 'script_id', 'level', 'level_damage',
        'upgrades_to', 'projectile_prefab', 'rarity', 'stage', 'weight', 'max_level', 'tags',
        'lv1', 'lv2', 'lv3', 'effects_lv2', 'effects_lv3', 'synergy'],
    modifiers: ['id', 'name', 'icon', 'is_debuff', 'is_hidden', 'dispel_level', 'duration', 'cd', 'stack_mode',
        'max_stack', 'strongest_only', 'effects', 'events', 'script_id'],
};

const reorder = (obj, order) => {
    const out = {};
    for (const k of order) if (k in obj) out[k] = obj[k];
    for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];   // schema 外的键也留着
    return out;
};

/* ===================================================================
 * 新增的 Modifier —— 只有「吸血比例」这一类**没法走 var 绑定**的参数才需要单独开行
 * =================================================================== */

/**
 * 为什么 103 嗜血要 3 条 Modifier：`lifesteal` 的 `ratio` 是**动作字段**，
 * 而变量绑定（`var` / `attrs_var`）**只对 `modify_attr` 的属性条目生效**（见 `EffectTypes.ts`）。
 * 属性型技能（104~107 / 130）就没有这个问题 —— 它们全走 `属性修改` 共享模板 1000，
 * 数值写在技能的 `attrs` 里，一条 Modifier 都不用新增。
 */
const NEW_MODIFIERS = [
    { id: 34, name: '嗜血·一阶', ratio: 0.05 },
    { id: 35, name: '嗜血·二阶', ratio: 0.09 },
    { id: 36, name: '嗜血·三阶', ratio: 0.14 },
].map((m) => ({
    id: m.id,
    name: m.name,
    is_debuff: false,
    is_hidden: false,
    dispel_level: 1,
    /** 永久（-1）：这是**被动技能挂载的效果**，不是限时 Buff —— 别写成秒数 */
    duration: -1,
    stack_mode: 'refresh',
    events: [{ event: 'on_attack_landed', actions: [{ type: 'lifesteal', ratio: m.ratio }] }],
}));

/* ===================================================================
 * 6 条技能的效果与文案
 * =================================================================== */

const attr = (id, value, mode) => (mode ? [id, value, mode] : [id, value]);

const SKILLS = {
    103: {
        effects: [{ type: 'apply_modifier', modifier: 34, duration: -1 }],
        effects_lv2: [{ type: 'apply_modifier', modifier: 35, duration: -1 }],
        effects_lv3: [{ type: 'apply_modifier', modifier: 36, duration: -1 }],
        lv1: '普攻回复造成伤害 5% 的生命',
        lv2: '普攻回复造成伤害 9% 的生命',
        lv3: '普攻回复造成伤害 14% 的生命',
    },
    104: {
        effects: [{ type: 'modify_attr', attrs: [attr(4, 8, 'add')] }],
        effects_lv2: [{ type: 'modify_attr', attrs: [attr(4, 15, 'add')] }],
        effects_lv3: [{ type: 'modify_attr', attrs: [attr(4, 35, 'add')] }],
        lv1: '攻击速度 +8%',
        lv2: '攻击速度 +15%',
        lv3: '攻击速度 +35%',
    },
    105: {
        effects: [{ type: 'modify_attr', attrs: [attr(16, 12, 'percent')] }],
        effects_lv2: [{ type: 'modify_attr', attrs: [attr(16, 20, 'percent')] }],
        effects_lv3: [{ type: 'modify_attr', attrs: [attr(16, 45, 'percent')] }],
        lv1: '攻击范围 +12%',
        lv2: '攻击范围 +20%',
        lv3: '攻击范围 +45%',
    },
    106: {
        effects: [{ type: 'modify_attr', attrs: [attr(1, 12, 'percent')] }],
        effects_lv2: [{ type: 'modify_attr', attrs: [attr(1, 22, 'percent')] }],
        effects_lv3: [{ type: 'modify_attr', attrs: [attr(1, 35, 'percent'), attr(9, 2, 'add')] }],
        lv1: '最大生命 +12%',
        lv2: '最大生命 +22%',
        lv3: '最大生命 +35%，生命恢复 +2/秒',
    },
    107: {
        effects: [{ type: 'modify_attr', attrs: [attr(14, 8, 'add')] }],
        effects_lv2: [{ type: 'modify_attr', attrs: [attr(14, 15, 'add')] }],
        // 暴击倍率必须显式 `best`（属性默认就是 best；写 add 会变成 base+Σv 累加）
        effects_lv3: [{ type: 'modify_attr', attrs: [attr(14, 24, 'add'), attr(15, 170, 'best')] }],
        lv1: '暴击率 +8%',
        lv2: '暴击率 +15%',
        lv3: '暴击率 +24%，暴击伤害 +20%',
    },
    130: {
        effects: [{ type: 'modify_attr', attrs: [attr(3, 40, 'percent'), attr(1, -15, 'percent')] }],
        effects_lv2: [{ type: 'modify_attr', attrs: [attr(3, 60, 'percent'), attr(1, -25, 'percent')] }],
        effects_lv3: [{ type: 'modify_attr', attrs: [attr(3, 100, 'percent'), attr(1, -40, 'percent')] }],
        lv1: '攻击力 +40%，最大生命 -15%',
        lv2: '攻击力 +60%，最大生命 -25%',
        lv3: '攻击力 +100%，最大生命 -40%',
    },
};

/* ===================================================================
 * 主流程
 * =================================================================== */

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(TB, name), 'utf8'));
const writeJson = (name, data) => fs.writeFileSync(path.join(TB, name), JSON.stringify(data, null, 2) + '\n', 'utf8');

function main() {
    const abilities = readJson('abilities.json');
    const modifiers = readJson('modifiers.json');

    // ---- 自检：要改的技能必须存在、必须是 shop、必须是被动 ----
    const problems = [];
    for (const idStr of Object.keys(SKILLS)) {
        const id = Number(idStr);
        const row = abilities.find((r) => r.id === id);
        if (!row) { problems.push(`abilities.json 里没有 id ${id}`); continue; }
        if (row.scope !== 'shop') problems.push(`id ${id}（${row.name}）scope=${row.scope}，应为 shop`);
        if (row.behavior !== 'passive') problems.push(`id ${id}（${row.name}）behavior=${row.behavior}，肉鸽技能必须是被动`);
    }
    // ---- 自检：新增 modifier id 不能和现有的撞 ----
    for (const m of NEW_MODIFIERS) {
        if (modifiers.some((r) => r.id === m.id)) { /* 幂等：允许已存在（下面整行替换） */ }
    }
    if (problems.length) {
        console.error('✗ 前置自检失败：');
        for (const p of problems) console.error(`   - ${p}`);
        process.exit(1);
    }

    // ---- 改 modifiers：同 id 先删后插，追加到表尾（它们是最高 id） ----
    const modIds = new Set(NEW_MODIFIERS.map((m) => m.id));
    const keptMods = modifiers.filter((r) => !modIds.has(r.id)).map((r) => reorder(r, ORDER.modifiers));
    const nextMods = [...keptMods, ...NEW_MODIFIERS.map((r) => reorder(r, ORDER.modifiers))];

    // ---- 改 abilities：原地替换这 6 行的 effects / effects_lv2 / effects_lv3 / lv1~lv3 ----
    let touched = 0;
    const nextAbilities = abilities.map((r) => {
        const patch = SKILLS[r.id];
        if (!patch) return reorder(r, ORDER.abilities);
        touched++;
        const merged = { ...r, ...patch };
        // 该级没有效果就删掉这个键，别留空数组（留空数组在 `abilityEffectsAtLevel` 里会被当成"有"）
        if (!merged.effects_lv2) delete merged.effects_lv2;
        if (!merged.effects_lv3) delete merged.effects_lv3;
        return reorder(merged, ORDER.abilities);
    });

    // ---- 报告 ----
    console.log(`◆ abilities.json：命中 ${touched} 条（期望 ${Object.keys(SKILLS).length} 条）`);
    for (const id of Object.keys(SKILLS)) {
        const row = nextAbilities.find((r) => r.id === Number(id));
        const lv = [row.effects, row.effects_lv2, row.effects_lv3].map((e) => (e ? e.length : '沿用')).join(' / ');
        console.log(`   ${String(id).padStart(3)} ${row.name.padEnd(6, '　')} 效果条数(1/2/3 级)=${lv}`);
    }
    console.log(`◆ modifiers.json：${modifiers.length} → ${nextMods.length} 行（+${NEW_MODIFIERS.length}：${NEW_MODIFIERS.map((m) => `${m.id} ${m.name}`).join('、')}）`);
    const withEff = nextAbilities.filter((r) => r.scope === 'shop' && (r.effects?.length || r.script_id)).length;
    console.log(`◆ 商店技能里「已有战斗效果」的：${withEff}/30（本轮之前是 0）`);

    if (DRY) { console.log('（--dry-run：未写盘）'); return; }

    writeJson('abilities.json', nextAbilities);
    writeJson('modifiers.json', nextMods);
    console.log('✔ 已写 assets/resources/tb/abilities.json 与 modifiers.json');
    console.log('   下一步（必须）：cd tools/excel_export; node src/cli.ts json2excel --force --table abilities,modifiers');
    console.log('   然后：npm run check; npm run verify; npm run audit:skill');
}

main();
