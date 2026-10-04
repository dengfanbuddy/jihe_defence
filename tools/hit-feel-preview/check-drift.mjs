#!/usr/bin/env node
/**
 * ============================================================
 * 打击感演示台 —— 漂移体检（check-drift）
 * ============================================================
 *
 * 演示台是"单文件 HTML"，好处是双击即开；代价是**里面的常量会跟工程漂移**
 * （美术改了战斗底色、策划调了火枪攻击距离、程序改了顿帧口径 —— HTML 不会自己知道）。
 *
 * 本脚本把 index.html 里 `<script id="project-const">` 那份**真源快照**
 * 逐字段与工程里的 TS / JSON / 美术规范对账，任何一项对不上即退出码 1。
 *
 * 用法：node tools/hit-feel-preview/check-drift.mjs
 * 退出码：0 = 一致；1 = 有漂移（含"引用的文件不存在"）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const rel = p => path.join(ROOT, p);
const read = p => fs.readFileSync(rel(p), 'utf8');
const readJson = p => JSON.parse(read(p));

/* ====================== 真源解析 ====================== */
const entityVisualSrc = read('assets/scripts/game/common/EntityVisualConfig.ts');
const damageTextSrc = read('assets/scripts/game/common/DamageTextConfig.ts');
const artStyleSrc = read('docs/美术风格预设.md');
const battleConst = readJson('assets/resources/tb/battle_constants.json');
const unitsJson = readJson('assets/resources/tb/units.json');
const abilitiesJson = readJson('assets/resources/tb/abilities.json');
const attributesJson = readJson('assets/resources/tb/attributes.json');

const rows = o => (Array.isArray(o) ? o : (o && (o.data || o.rows)) || []);

/** units.base_attributes: [[属性id, int值]] → 运行时语义（百分比型属性 int = 值×100） */
const ATTR = { HP: 1, MANA: 2, ATK: 3, ATK_SPEED: 4, MOVE_SPEED: 5, ARMOR: 6, MAGIC_RESIST: 7, ATK_RANGE: 16 };
const SCALED = new Set([ATTR.ATK_SPEED, ATTR.MAGIC_RESIST]);   // AttributeScaling.SCALE 里的百分比型
function attrsOf(unit) {
    const m = {};
    (unit.base_attributes || []).forEach(([id, v]) => { m[id] = SCALED.has(id) ? v / 100 : v; });
    return m;
}
function unitById(id) {
    const u = rows(unitsJson).find(x => x.id === id);
    if (!u) throw new Error('units.json 里找不到 id=' + id);
    return u;
}
function abilityById(id) {
    const a = rows(abilitiesJson).find(x => x.id === id);
    if (!a) throw new Error('abilities.json 里找不到 id=' + id);
    return a;
}
function attrById(id) {
    const a = rows(attributesJson).find(x => x.id === id);
    if (!a) throw new Error('attributes.json 里找不到 id=' + id);
    return a;
}
function hex(n) { return n == null ? null : '#' + Number(n).toString(16).padStart(6, '0').toLowerCase(); }

/** EntityVisualConfig.ts 的 UNIT_VISUALS 每行 */
const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function parseUnitVisuals() {
    const out = {};
    const re = /\[UnitKind\.(\w+)\]:\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(entityVisualSrc))) {
        const body = m[2];
        const g = k => { const r = new RegExp(k + ':\\s*([^,]+)'); const x = body.match(r); return x ? x[1].trim() : null; };
        const colorRaw = g('color');
        out[snake(m[1])] = {
            color: colorRaw === 'null' ? null : hex(parseInt(colorRaw.replace('0x', ''), 16)),
            scale: parseFloat(g('scale')),
            hitColor: hex(parseInt(g('hitColor').replace('0x', ''), 16)),
        };
    }
    return out;
}
/** DamageTextConfig.ts 的 DAMAGE_TEXT 标量 */
function parseDamageText() {
    const block = damageTextSrc.match(/export const DAMAGE_TEXT = \{([\s\S]*?)\n\} as const;/);
    if (!block) throw new Error('DamageTextConfig.ts 里解析不到 DAMAGE_TEXT');
    const out = {};
    const re = /^\s{4}(\w+):\s*(-?[\d.]+)/gm;
    let m;
    while ((m = re.exec(block[1]))) out[m[1]] = parseFloat(m[2]);
    return out;
}
/** DamageTextConfig.ts 的 DAMAGE_TEXT_STYLES 每档 */
function parseDamageTextStyles() {
    const out = {};
    const re = /\[DamageTextTier\.(\w+)\]:\s*\{([\s\S]*?)\n    \}/g;
    let m;
    while ((m = re.exec(damageTextSrc))) {
        const body = m[2];
        const one = {};
        const re2 = /(\w+):\s*([^,\n]+),/g;
        let x;
        while ((x = re2.exec(body))) {
            const k = x[1], v = x[2].trim();
            if (/^-?[\d.]+$/.test(v)) one[k] = parseFloat(v);
            else if (/^0x[0-9a-fA-F]+$/.test(v)) one[k] = hex(parseInt(v, 16));       // color: 0xffffff
            else if (v === 'UNIT_VISUALS[UnitKind.Hero].hitColor') one[k] = 'HERO_HIT_COLOR';
        }
        out[m[1].toLowerCase()] = one;
    }
    return out;
}

const TS = {
    unitVisuals: parseUnitVisuals(),
    hitFlashDuration: parseFloat(entityVisualSrc.match(/export const HIT_FLASH_DURATION = ([\d.]+)/)[1]),
    dmg: parseDamageText(),
    dmgStyles: parseDamageTextStyles(),
};

/* ====================== 快照解析 ====================== */
const html = read('tools/hit-feel-preview/index.html');
const snapBlock = html.match(/<script id="project-const" type="application\/json">([\s\S]*?)<\/script>/);
if (!snapBlock) { console.error('✗ index.html 里找不到 <script id="project-const"> 快照'); process.exit(1); }
const SNAP = JSON.parse(snapBlock[1]);
const featuresBlock = html.match(/<script id="features" type="application\/json">([\s\S]*?)<\/script>/);
const FEATURES = featuresBlock ? JSON.parse(featuresBlock[1]) : [];
const HTML_FILES = [...html.matchAll(/[\w./-]+\.(?:ts|json|md)/g)].map(m => m[0]);

/* ====================== 对账 ====================== */
const rowsOut = [];
let bad = 0;
function cmp(label, src, want, got) {
    let same;
    if (typeof want === 'number' && typeof got === 'number') same = Math.abs(want - got) < 1e-9;
    else if (want && got && typeof want === 'object') same = JSON.stringify(want) === JSON.stringify(got);
    else same = String(want).toLowerCase() === String(got).toLowerCase();
    if (!same) bad++;
    rowsOut.push({ ok: same, label, src, want: fmt(want), got: fmt(got) });
}
const fmt = v => v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/* --- 1. 单位表现（EntityVisualConfig.ts） --- */
cmp('受击闪烁时长', 'HIT_FLASH_DURATION', TS.hitFlashDuration, SNAP.hitFlashDuration);
const KIND_KEY = { hero: 'Hero', normal: 'Normal', elite: 'Elite', gold_boss: 'GoldBoss', kill_boss: 'KillBoss', stage_boss: 'StageBoss', final_boss: 'FinalBoss' };
Object.keys(SNAP.unitVisuals).forEach(k => {
    const t = TS.unitVisuals[k];
    if (!t) { cmp('单位配色 ' + k, 'UNIT_VISUALS', '(存在)', '(缺失)'); return; }
    const s = SNAP.unitVisuals[k];
    cmp(k + ' 底色', 'UNIT_VISUALS.' + KIND_KEY[k] + '.color', t.color, s.color);
    cmp(k + ' 体型倍率', 'UNIT_VISUALS.' + KIND_KEY[k] + '.scale', t.scale, s.scale);
    cmp(k + ' 受击色', 'UNIT_VISUALS.' + KIND_KEY[k] + '.hitColor', t.hitColor, s.hitColor);
});

/* --- 2. 飘字（DamageTextConfig.ts） --- */
const DT_KEYS = ['baseFontSize', 'heroScaleBonus', 'outlineGrow', 'mergeWindow', 'maxAlive', 'ladderSteps', 'ladderGapRatio', 'scatterRadius', 'spawnOffsetY', 'strokeRatio', 'advanceRatio'];
DT_KEYS.forEach(k => cmp('飘字 ' + k, 'DAMAGE_TEXT.' + k, TS.dmg[k], SNAP.damageText[k]));
(function () {
    const m = damageTextSrc.match(/outlineColor:\s*0x([0-9a-fA-F]+)/);
    cmp('飘字描边色', 'DAMAGE_TEXT.outlineColor', hex(parseInt(m[1], 16)), SNAP.damageText.outlineColor);
})();
['normal', 'crit'].forEach(tier => {
    const t = TS.dmgStyles[tier], s = SNAP.damageTextStyles[tier];
    if (!t) { cmp('飘字档 ' + tier, 'DAMAGE_TEXT_STYLES', '(存在)', '(缺失)'); return; }
    Object.keys(s).forEach(k => {
        if (k === 'heroColor') return;                       // 单独在下面按"英雄受击色"对
        cmp('飘字 ' + tier + '.' + k, 'DAMAGE_TEXT_STYLES.' + tier + '.' + k, t[k], s[k]);
    });
    cmp('飘字 ' + tier + ' 英雄受击色', 'UNIT_VISUALS[Hero].hitColor', TS.unitVisuals.hero.hitColor, s.heroColor);
});

/* --- 3. 全局常量（battle_constants.json） --- */
const BC_KEYS = ['pxPerMeter', 'critDmgBase', 'critRateCap', 'atkSpeedCap', 'projectileSpeedDefault', 'projectileMaxDistDefault', 'minDamage', 'dodgeCap', 'collisionRadiusDefault', 'separationStrength'];
BC_KEYS.forEach(k => cmp('常量 ' + k, 'battle_constants.json.' + k, battleConst[k], SNAP.battleConstants[k]));

/* --- 4. 属性字典（attributes.json；百分比型 int = 值×100） --- */
cmp('攻速 base（int→倍率）', 'attributes.json#4', attrById(4).base / 100, SNAP.attributes.atkSpeedBase / 100);
cmp('攻速 stack_mode', 'attributes.json#4', attrById(4).stack_mode, SNAP.attributes.atkSpeedMode);
cmp('魔抗 base（int→比例）', 'attributes.json#7', attrById(7).base / 100, SNAP.attributes.magicResistBase / 100);
cmp('魔抗 stack_mode', 'attributes.json#7', attrById(7).stack_mode, SNAP.attributes.magicResistMode);
cmp('暴击率 base', 'attributes.json#14', attrById(14).base, SNAP.attributes.critRateBase);
cmp('暴击倍率 base（int=×100）', 'attributes.json#15', attrById(15).base / 100, SNAP.attributes.critMultBase / 100);
cmp('暴击倍率 stack_mode', 'attributes.json#15', attrById(15).stack_mode, SNAP.attributes.critMultMode);

/* --- 5. 火枪（units.json 1001） --- */
const hero = unitById(1001);
const ha = attrsOf(hero);
cmp('火枪 id', 'units.json#1001', 1001, SNAP.hero.id);
cmp('火枪 最大生命', 'units.base_attributes[1]', ha[ATTR.HP], SNAP.hero.maxHp);
cmp('火枪 最大魔法', 'units.base_attributes[2]', ha[ATTR.MANA], SNAP.hero.maxMana);
cmp('火枪 攻击力', 'units.base_attributes[3]', ha[ATTR.ATK], SNAP.hero.atk);
cmp('火枪 攻速（120→1.2）', 'units.base_attributes[4]', ha[ATTR.ATK_SPEED], SNAP.hero.atkSpeed);
cmp('火枪 攻击距离', 'units.base_attributes[16]', ha[ATTR.ATK_RANGE], SNAP.hero.atkRange);
cmp('火枪 攻击间隔', 'units.attack_interval', hero.attack_interval, SNAP.hero.attackInterval);
cmp('火枪 碰撞半径', 'units.collision_radius', hero.collision_radius, SNAP.hero.collisionRadius);
cmp('火枪 索敌策略', 'units.attack_targeting', hero.attack_targeting, SNAP.hero.attackTargeting);
cmp('火枪 弹道', 'units.attack_projectile', hero.attack_projectile, SNAP.hero.attackProjectile);

/* --- 6. 火枪技能 16 的三个参数（abilities.json / modifiers.json 链路） --- */
const ab16 = abilityById(16);
const eff = (ab16.effects || []).find(e => e.type === 'apply_modifier') || {};
const kv = eff.kv || {};
cmp('技能 16 额外伤害比例', 'abilities.json#16.effects[0].kv.pct', kv.pct, SNAP.hero.headshotPct);
cmp('技能 16 击退概率', 'abilities.json#16.effects[0].kv.chance', kv.chance, SNAP.hero.headshotKnockChance);
cmp('技能 16 击退米数', 'abilities.json#16.effects[0].kv.knockback', kv.knockback, SNAP.hero.headshotKnockMeter);
cmp('技能 16 修饰符引用', 'abilities.json#16.effects[0].modifier', eff.modifier, 23);

/* --- 7. 怪物（units.json 2001/2002/2005/2006/2007） --- */
const MON = { goblin: 2001, troll: 2002, elite: 2005, stage_boss: 2006, gold_boss: 2007 };
Object.keys(MON).forEach(key => {
    const u = unitById(MON[key]), a = attrsOf(u), s = SNAP.monsters[key];
    cmp(key + ' id', 'units.json#' + MON[key], MON[key], s.id);
    cmp(key + ' 生命', 'units.base_attributes[1]', a[ATTR.HP], s.maxHp);
    cmp(key + ' 移速', 'units.base_attributes[5]', a[ATTR.MOVE_SPEED], s.moveSpeed);
    cmp(key + ' 攻击力', 'units.base_attributes[3]', a[ATTR.ATK], s.atk);
    cmp(key + ' 护甲', 'units.base_attributes[6]', a[ATTR.ARMOR], s.armor);
    cmp(key + ' 魔抗（25→0.25）', 'units.base_attributes[7]', a[ATTR.MAGIC_RESIST], s.magicResist);
    cmp(key + ' 碰撞半径', 'units.collision_radius', u.collision_radius, s.collisionRadius);
    cmp(key + ' 类别', 'units.subtype/rewardType', u.subtype === 'boss' && u.rewardType !== 'boss' ? 'boss' : u.subtype, s.kind === 'stage_boss' || s.kind === 'gold_boss' ? 'boss' : s.kind);
});

/* --- 8. 美术规范里的颜色必须还在（docs/美术风格预设.md） --- */
Object.keys(SNAP.art).forEach(k => {
    const v = SNAP.art[k];
    if (Array.isArray(v)) {
        v.forEach((hexv, i) => cmp('品质框色 ' + i, '美术风格预设.md', '(含 ' + hexv + ')',
            artStyleSrc.toUpperCase().includes(hexv.toUpperCase()) ? '(含 ' + hexv + ')' : '(缺失)'));
        return;
    }
    cmp('美术色 ' + k, '美术风格预设.md', '(含 ' + v + ')',
        artStyleSrc.toUpperCase().includes(String(v).toUpperCase()) ? '(含 ' + v + ')' : '(缺失 ' + v + ')');
});

/* --- 9. 页面里引用的工程文件都得在（防挪文件后落点表失效） --- */
const MUST_EXIST = [
    'assets/scripts/game/game_stage/entityview/HitFlash.ts',
    'assets/scripts/game/game_stage/entityview/DamageTextLayer.ts',
    'assets/scripts/game/game_stage/entityview/HpBar.ts',
    'assets/scripts/game/game_stage/entityview/ProjectileView.ts',
    'assets/scripts/game/game_stage/entityview/GeometricDigits.ts',
    'assets/scripts/game/common/EntityVisualConfig.ts',
    'assets/scripts/game/common/DamageTextConfig.ts',
    'assets/scripts/game/common/EntityHpBarConfig.ts',
    'assets/scripts/game/common/GraphCircle.ts',
    'assets/scripts/game/battle/DamagePipeline.ts',
    'assets/scripts/game/battle/Entity.ts',
    'assets/scripts/game/battle/types.ts',
    'assets/scripts/game/ui/scenes/scene_game_stage/Scene_Game_Stage.ts',
    'assets/resources/tb/units.json',
    'assets/resources/tb/abilities.json',
    'assets/resources/tb/attributes.json',
    'assets/resources/tb/battle_constants.json',
    'docs/美术风格预设.md',
];
MUST_EXIST.forEach(p => cmp('文件存在', p, true, fs.existsSync(rel(p))));

/* ====================== 报告 ====================== */
const W1 = 26, W2 = 46, W3 = 16, W4 = 16;
console.log('\n打击感演示台 · 常量漂移体检');
console.log('快照：tools/hit-feel-preview/index.html  <script id="project-const">');
console.log('真源：' + SNAP._source);
console.log('='.repeat(W1 + W2 + W3 + W4 + 8));
console.log('  ' + '字段'.padEnd(W1) + '来源'.padEnd(W2) + '真源'.padEnd(W3) + '快照'.padEnd(W4));
console.log('-'.repeat(W1 + W2 + W3 + W4 + 8));
rowsOut.forEach(r => {
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label.padEnd(W1 - 1) + r.src.padEnd(W2) + r.want.padEnd(W3) + r.got.padEnd(W4));
});
console.log('='.repeat(W1 + W2 + W3 + W4 + 8));
if (bad) {
    console.log('✗ 发现 ' + bad + ' 处漂移（共 ' + rowsOut.length + ' 项）：真源改了，index.html 的快照没跟着改。');
    console.log('  修法：把上面 ✗ 行的「真源」值写回 index.html 的 <script id="project-const">，然后重跑本脚本。');
} else {
    console.log('✓ 全部一致（' + rowsOut.length + ' 项）—— 演示台与工程真源没有漂移。');
}
console.log('  开关数：' + FEATURES.length + '（' + Object.entries(FEATURES.reduce((a, f) => (a[f.g] = (a[f.g] || 0) + 1, a), {})).map(([k, v]) => k + v).join(' ') + '）');
process.exit(bad ? 1 : 0);
