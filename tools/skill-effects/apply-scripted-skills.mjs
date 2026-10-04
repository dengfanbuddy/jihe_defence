/**
 * apply-scripted-skills.mjs —— 把「审查定案」里**剩下 24 条**技能落进配表（幂等）
 *
 * 前一份 `apply-skill-effects.mjs` 落了 §4.1 的 6 条纯声明式技能（103/104/105/106/107/130）。
 * 本脚本落**其余 24 条**：
 *
 *   · B 类 16 条（脚本 Modifier）：101 分裂弹 / 102 穿透弹 / 108 铁壳 / 109 首击 / 111 淘金 /
 *     112 圣盾 / 114 追踪弹 / 115 榴弹 / 116 燃刃 / 117 寒刃 / 118 毒刃 / 120 静电磁场 /
 *     121 影剪 / 122 击杀回响 / 126 暴击连锁 / 129 时间回廊
 *   · C 类 1 条（补了一处引擎派发）：127 闪避反击
 *   · D 类 7 条（重设计成零基建的等价机制）：110 过载 / 113 回旋镖 / 119 雷链 /
 *     123 哨兵炮台 / 124 镜像分身 / 125 元素军阵 / 128 战旗
 *
 * 脚本实现在 `assets/scripts/game/battle/ShopSkillModifiers.ts`，本文件只负责配表。
 * 两边靠 **Modifier id（40~67）** 对齐，`npm run audit:skill` 有一条断言专门盯这个对账。
 *
 * 三条配表纪律（都是引擎口径逼出来的，见 `docs/skill-icons/README.md` §2）：
 *   ① 脚本修饰符一律 `duration: -1` + `stack_mode: 'refresh'` —— 它们是**被动技能挂的常驻效果**，
 *      不是限时 Buff；技能换级时 `Ability.setLevel` 会先按 origin 摘掉旧实例再挂新的，
 *      所以每一级的 kv 一定是当前级的（不会串档）。
 *   ② **数值全部走 kv**，一行 Modifier 服务三档 → 改数值不用改代码、不用加行。
 *      唯一的例外是需要改 `max_stack` 的（如灼烧/冰冻的层数上限）—— `max_stack` 是 def 的字段，
 *      不能由 kv 传，所以 def 取**最高档**（6 / 3），低档由脚本自己钳住。
 *   ③ 声明式能做的**绝不写成脚本**：108 的护甲、110 的增伤、128 的自身增伤、
 *      117 的减速、120 的层数计数都留在 `effects` 里（护甲/破甲必须 `add` —— 它们的 base 是 0，
 *      `percent` 打在 base=0 上恒为 0；而 110/128 的 attr 11 base=100，`percent` 才对）。
 *
 * 幂等：modifiers 同 id 先删后插；abilities 只覆盖本脚本负责的那 24 行的
 * `effects` / `effects_lv2` / `effects_lv3` / `lv1` / `lv2` / `lv3`，其余行原样保留。
 *
 * 用法：
 *   node tools/skill-effects/apply-scripted-skills.mjs --dry-run
 *   node tools/skill-effects/apply-scripted-skills.mjs
 *   cd tools/excel_export; node src/cli.ts json2excel --force --table abilities,modifiers
 *   cd tools/excel_export; npm run check; npm run verify; npm run audit:skill
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
    for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
    return out;
};

/* ===================================================================
 * 新增 Modifier（id 40~67，与 ShopSkillModifiers.ts 的 SHOP_MOD 同号）
 * =================================================================== */

/** 被动技能挂的常驻脚本修饰符：永久 + 同源刷新（见文件头纪律 ①） */
const passive = (id, name, script_id) => ({
    id, name, is_debuff: false, is_hidden: false, dispel_level: 1,
    duration: -1, stack_mode: 'refresh', script_id,
});

/** 挂在**敌人**身上的减益脚本修饰符 */
const debuff = (id, name, script_id, duration, max_stack) => ({
    id, name, is_debuff: true, is_hidden: false, dispel_level: 1,
    duration, stack_mode: 'stack', max_stack, script_id,
});

const NEW_MODIFIERS = [
    // ── B 类：脚本 Modifier（挂英雄） ──────────────────────────────
    passive(40, '技能·分裂弹', 'Modifier_SplitShot'),
    passive(41, '技能·穿透弹', 'Modifier_PiercingBolt'),
    /** 108 l3 的格挡（护甲那半句是纯声明式，在 abilities.json 里） */
    passive(42, '技能·铁壳格挡', 'Modifier_IronShell'),
    passive(43, '技能·首击', 'Modifier_FirstStrike'),
    passive(44, '技能·淘金', 'Modifier_GoldRush'),
    /** 112 圣盾；127 l3 的「获得护盾」也复用它（护盾逻辑只有一份） */
    passive(45, '技能·圣盾', 'Modifier_DivineShield'),
    passive(46, '技能·回旋镖', 'Modifier_Boomerang'),
    passive(47, '技能·追踪弹', 'Modifier_HomingShot'),
    passive(48, '技能·榴弹', 'Modifier_Grenade'),
    passive(49, '技能·燃刃', 'Modifier_FlameBlade'),
    passive(51, '技能·毒刃', 'Modifier_VenomBlade'),
    passive(54, '技能·寒刃', 'Modifier_FrostBlade'),
    passive(55, '技能·雷链', 'Modifier_ChainLightning'),
    passive(57, '技能·静电磁场', 'Modifier_StaticField'),
    passive(58, '技能·影剪', 'Modifier_ShadowCut'),
    passive(59, '技能·击杀回响', 'Modifier_KillEcho'),
    passive(60, '技能·哨兵炮台', 'Modifier_SentryTurret'),
    passive(61, '技能·镜像分身', 'Modifier_MirrorImage'),
    passive(62, '技能·元素军阵', 'Modifier_ElementalLegion'),
    passive(63, '技能·暴击连锁', 'Modifier_CritChain'),
    passive(64, '技能·闪避反击', 'Modifier_EvadeCounter'),
    passive(65, '技能·战旗光环', 'Modifier_WarBanner'),
    passive(67, '技能·时间回廊', 'Modifier_TimeRewind'),

    // ── B 类：脚本 DoT（挂敌人） ──────────────────────────────────
    // max_stack 取最高档 6（def 是硬上限），低档（2 / 4）由施加方脚本自己钳
    debuff(50, '技能·灼烧', 'Modifier_Ignite', 4, 6),
    debuff(52, '技能·毒液', 'Modifier_Poison', 4, 6),

    // ── 纯声明式：117 的减速 / 120 的层数计数 / 128 的破甲 ──────────
    {
        id: 53, name: '技能·冰冻', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 3, stack_mode: 'stack', max_stack: 3,
        // 每层 -60 移速（base=300 → 每层 -20%）；幅度由施加方 kv.slow 传（条目 var 绑定）
        effects: [{ type: 'modify_attr', attrs: [{ attr: 5, value: -60, var: 'slow' }] }],
    },
    {
        id: 56, name: '技能·静电层数', is_debuff: true, is_hidden: true, dispel_level: 1,
        duration: 10, stack_mode: 'stack', max_stack: 5,
        // 纯计数器：没有任何效果，只承载层数（「满 5 层引爆」的条件判定在 Modifier_StaticField 里）
    },
    {
        id: 66, name: '技能·破甲', is_debuff: true, is_hidden: false, dispel_level: 1,
        duration: 2, stack_mode: 'refresh',
        // 护甲 base=0 → 必须 add（percent 恒 0）；幅度由 kv.armorBreak 传
        effects: [{ type: 'modify_attr', attrs: [{ attr: 6, value: -3, var: 'armorBreak' }] }],
    },
];

/* ===================================================================
 * 24 条技能的效果与文案
 * =================================================================== */

const attr = (id, value, mode) => (mode ? [id, value, mode] : [id, value]);
const mod = (modifier, kv, duration = -1) => (kv
    ? { type: 'apply_modifier', modifier, duration, kv }
    : { type: 'apply_modifier', modifier, duration });
const attrs = (list) => ({ type: 'modify_attr', attrs: list });

const SKILLS = {
    /* ── B 类 16 条 ─────────────────────────────────────────────── */
    101: {
        effects: [mod(40, { count: 1, pct: 0.5 })],
        effects_lv2: [mod(40, { count: 2, pct: 0.6 })],
        effects_lv3: [mod(40, { count: 3, pct: 0.7 })],
        lv1: '普攻额外追加 1 段 50% 攻击力的伤害',
        lv2: '额外追加 2 段，每段 60% 攻击力',
        lv3: '额外追加 3 段，每段 70% 攻击力',
    },
    102: {
        effects: [mod(41, { count: 1, pct: 0.6, spread: 0.6 })],
        effects_lv2: [mod(41, { count: 2, pct: 0.72, spread: 0.6 })],
        effects_lv3: [mod(41, { count: 3, pct: 0.85, spread: 0.6 })],
        lv1: '普攻穿透 1 个身后的敌人，造成 60% 攻击力伤害',
        lv2: '穿透 2 个敌人，穿透伤害 72%',
        lv3: '穿透 3 个敌人，穿透伤害 85%',
    },
    108: {
        effects: [attrs([attr(6, 2, 'add')])],
        effects_lv2: [attrs([attr(6, 4, 'add')])],
        effects_lv3: [attrs([attr(6, 7, 'add')]), mod(42, { chance: 0.1, pct: 0.5 })],
        lv1: '护甲 +2（约 10.7% 物理减伤）',
        lv2: '护甲 +4（约 19.4% 物理减伤）',
        lv3: '护甲 +7（约 29.6% 物理减伤），受击有 10% 几率格挡 50% 伤害',
    },
    109: {
        effects: [mod(43, { pct: 0.25 })],
        effects_lv2: [mod(43, { pct: 0.45 })],
        effects_lv3: [mod(43, { pct: 0.65, haste: 15, hasteSec: 2 })],
        lv1: '对满生命敌人的首次命中追加 25% 攻击力伤害',
        lv2: '首击追加伤害提升至 45% 攻击力',
        lv3: '首击追加伤害提升至 65% 攻击力，击杀后攻速 +15%（持续 2 秒）',
    },
    111: {
        effects: [mod(44, { gold: 1 })],
        effects_lv2: [mod(44, { gold: 2 })],
        effects_lv3: [mod(44, { gold: 3 })],
        lv1: '击杀敌人额外 +1 金币',
        lv2: '击杀敌人额外 +2 金币',
        lv3: '击杀敌人额外 +3 金币',
    },
    112: {
        effects: [mod(45, { pct: 0.08, reflect: 0, recharge: 6 })],
        effects_lv2: [mod(45, { pct: 0.13, reflect: 0, recharge: 6 })],
        effects_lv3: [mod(45, { pct: 0.20, reflect: 0.6, recharge: 6 })],
        lv1: '受击时以护盾吸收伤害（护盾值 = 最大生命 8%，破碎后 6 秒充能）',
        lv2: '护盾值提升至最大生命 13%',
        lv3: '护盾值提升至最大生命 20%，破碎时对伤害来源反弹 60% 已吸收伤害',
    },
    114: {
        effects: [mod(47, { jumps: 1, pct: 0.55, range: 260 })],
        effects_lv2: [mod(47, { jumps: 2, pct: 0.55, range: 260 })],
        effects_lv3: [mod(47, { jumps: 3, pct: 0.55, range: 260 })],
        lv1: '普攻命中后弹向次近敌人，造成 55% 攻击力伤害',
        lv2: '弹射链增至 2 跳，每跳 55% 攻击力',
        lv3: '弹射链增至 3 跳，每跳 55% 攻击力',
    },
    115: {
        effects: [mod(48, { radiusM: 1.5, pct: 0.8 })],
        effects_lv2: [mod(48, { radiusM: 2.0, pct: 1.0 })],
        effects_lv3: [mod(48, { radiusM: 2.5, pct: 1.3, burnPct: 0.15, burnSec: 4 })],
        lv1: '普攻命中后爆炸（半径 1.5m），对范围内敌人造成 80% 攻击力伤害',
        lv2: '爆炸半径 2.0m，伤害提升至 100% 攻击力',
        lv3: '爆炸半径 2.5m，伤害提升至 130% 攻击力，并附加每秒 15% 攻击力的灼烧',
    },
    116: {
        effects: [mod(49, { maxLayers: 2, dpsPct: 0.15, duration: 4 })],
        effects_lv2: [mod(49, { maxLayers: 4, dpsPct: 0.15, duration: 4 })],
        effects_lv3: [mod(49, { maxLayers: 6, dpsPct: 0.15, duration: 4 })],
        lv1: '普攻附加灼烧（每层每秒 15% 攻击力），最多叠 2 层',
        lv2: '灼烧最多叠 4 层',
        lv3: '灼烧最多叠 6 层',
    },
    117: {
        effects: [mod(54, { maxLayers: 1, slow: -60, duration: 3 })],
        effects_lv2: [mod(54, { maxLayers: 2, slow: -60, duration: 3 })],
        effects_lv3: [mod(54, { maxLayers: 3, slow: -60, duration: 3, freezeSec: 1.5 })],
        lv1: '普攻附加冰冻（每层减速 20%），最多叠 1 层',
        lv2: '冰冻最多叠 2 层',
        lv3: '冰冻最多叠 3 层，叠满时冻结 1.5 秒',
    },
    118: {
        effects: [mod(51, { maxLayers: 2, dpsPct: 0.10, duration: 4 })],
        effects_lv2: [mod(51, { maxLayers: 4, dpsPct: 0.10, duration: 4 })],
        effects_lv3: [mod(51, { maxLayers: 6, dpsPct: 0.10, duration: 4, spread: 1, spreadRadiusM: 2 })],
        lv1: '普攻附加毒液（每层每秒 10% 攻击力），最多叠 2 层',
        lv2: '毒液最多叠 4 层',
        lv3: '毒液最多叠 6 层，中毒目标死亡时向周围 2m 传染',
    },
    120: {
        effects: [mod(57, { threshold: 5, burstPct: 1.5, radiusM: 1.5, stackSec: 10 })],
        effects_lv2: [mod(57, { threshold: 5, burstPct: 2.0, radiusM: 2.0, stackSec: 10 })],
        effects_lv3: [mod(57, { threshold: 5, burstPct: 2.8, radiusM: 2.5, stackSec: 10, chain: 2 })],
        lv1: '普攻命中叠 1 层静电（最多 5 层），满层引爆造成 150% 攻击力范围伤害（半径 1.5m）',
        lv2: '引爆伤害 200% 攻击力，半径 2.0m',
        lv3: '引爆伤害 280% 攻击力，半径 2.5m，引爆后再附带一次 2 跳雷链',
    },
    121: {
        effects: [mod(58, { threshold: 0.3, pct: 0.3 })],
        effects_lv2: [mod(58, { threshold: 0.4, pct: 0.3 })],
        effects_lv3: [mod(58, { threshold: 0.45, pct: 0.3, healPct: 0.08 })],
        lv1: '对生命低于 30% 的敌人额外造成 30% 攻击力伤害',
        lv2: '斩杀阈值提升至 40%',
        lv3: '斩杀阈值 45%，斩杀后回复 8% 最大生命',
    },
    122: {
        effects: [mod(59, { pct: 1.25, radiusM: 1.5 })],
        effects_lv2: [mod(59, { pct: 1.5, radiusM: 2.0 })],
        effects_lv3: [mod(59, { pct: 1.85, radiusM: 2.5, goldChance: 0.2 })],
        lv1: '击杀敌人时在其位置引发回响（半径 1.5m），造成 125% 攻击力伤害',
        lv2: '回响伤害 150% 攻击力，半径 2.0m',
        lv3: '回响伤害 185% 攻击力，半径 2.5m，并有 20% 概率掉 1 金币',
    },
    126: {
        effects: [mod(63, { mode: 1, pct: 0.5, radiusM: 1 })],
        effects_lv2: [mod(63, { mode: 2, pct: 0.6 })],
        effects_lv3: [mod(63, { mode: 3, pct: 2.0, radiusM: 2.5, need: 3 })],
        lv1: '暴击时在目标处引发小爆炸（半径 1m，50% 攻击力）',
        lv2: '暴击时弹射至相邻敌人，造成 60% 攻击力伤害',
        lv3: '每累计 3 次暴击触发一次大爆炸（半径 2.5m，200% 攻击力）',
    },
    129: {
        effects: [mod(67, { pct: 0.3, cdSec: 45 })],
        effects_lv2: [mod(67, { pct: 0.6, cleanse: true, cdSec: 45 })],
        effects_lv3: [mod(67, { pct: 1.0, cleanse: true, invulnSec: 3, cdSec: 45 })],
        lv1: '生命归零时逆转时间，回复 30% 最大生命重生（每 45 秒最多 1 次）',
        lv2: '重生回复 60% 最大生命，并清除全部负面效果',
        lv3: '重生回复 100% 最大生命，重生后 3 秒无敌',
    },

    /* ── C 类 1 条（引擎补了 on_evade 派发） ────────────────────── */
    127: {
        effects: [mod(64, { pct: 1.5 })],
        effects_lv2: [mod(64, { pct: 2.5, stunSec: 0.5 })],
        effects_lv3: [mod(64, { pct: 3.5, shieldPct: 0.25, shieldRecharge: 6 })],
        lv1: '闪避后对伤害来源反击，造成 150% 攻击力伤害',
        lv2: '反击伤害 250% 攻击力，并眩晕来源 0.5 秒',
        lv3: '反击伤害 350% 攻击力，并获得最大生命 25% 的护盾（6 秒充能）',
    },

    /* ── D 类 7 条（重设计：保住玩家感知，换掉不存在的机制） ──────── */
    110: {
        // 原稿「技能伤害 +10%、技能冷却 -12%」两项在本作都不存在（没有这两个属性，
        // 且英雄永远不施放技能）→ 换锚到真实存在的乘区：伤害输出倍率（对所有伤害生效）
        effects: [attrs([attr(11, 6, 'percent')])],
        effects_lv2: [attrs([attr(11, 10, 'percent')])],
        effects_lv3: [attrs([attr(11, 16, 'percent'), attr(12, -12, 'percent'), attr(13, -12, 'percent')])],
        lv1: '伤害输出 +6%',
        lv2: '伤害输出 +10%',
        lv3: '伤害输出 +16%，受到的所有伤害 -12%',
    },
    113: {
        // 原稿要「弹道返程再打一次」，而 Projectile 是纯直线一次性 → 换成等价的一次弹射
        effects: [mod(46, { pct: 0.6 })],
        effects_lv2: [mod(46, { pct: 0.75 })],
        effects_lv3: [mod(46, { pct: 0.9 })],
        lv1: '普攻命中后弹向最近的另一个敌人，造成 60% 攻击力伤害',
        lv2: '回旋伤害提升至 75% 攻击力',
        lv3: '回旋伤害提升至 90% 攻击力',
    },
    119: {
        // 原稿挂在「技能释放」上，而英雄永远不会施放技能 → 锚点换成普攻命中
        effects: [mod(55, { jumps: 2, decay: 0.5, range: 260 })],
        effects_lv2: [mod(55, { jumps: 3, decay: 0.6, range: 260 })],
        effects_lv3: [mod(55, { jumps: 4, decay: 0.7, range: 260, endBurstPct: 0.5 })],
        lv1: '普攻命中后向最近敌人链式弹射 2 跳，首跳 100% 攻击力，每跳衰减 50%',
        lv2: '弹射 3 跳，每跳衰减 40%',
        lv3: '弹射 4 跳，每跳衰减 30%，弹跳终点再爆炸一次（50% 攻击力 / 半径 1m）',
    },
    123: {
        // 召唤基建不存在 → 换成自身周期性开火（玩家感知不变，零基建）
        effects: [mod(60, { interval: 1.0, pct: 0.5, shots: 1 })],
        effects_lv2: [mod(60, { interval: 0.8, pct: 0.9, shots: 1 })],
        effects_lv3: [mod(60, { interval: 0.6, pct: 1.2, shots: 2 })],
        lv1: '每 1 秒自动对攻击范围内最近的敌人开火，造成 50% 攻击力伤害',
        lv2: '每 0.8 秒开火一次，伤害提升至 90% 攻击力',
        lv3: '每 0.6 秒连开 2 枪，每枪 120% 攻击力',
    },
    124: {
        // 召唤 + 「释放技能时」双重不可达 → 换成普攻概率追加一击
        effects: [mod(61, { chance: 0.35, pct: 0.4 })],
        effects_lv2: [mod(61, { chance: 0.5, pct: 0.6 })],
        effects_lv3: [mod(61, { chance: 0.7, pct: 0.9 })],
        lv1: '普攻有 35% 概率追加一次 40% 攻击力的额外打击',
        lv2: '50% 概率追加一次 60% 攻击力的额外打击',
        lv3: '70% 概率追加一次 90% 攻击力的额外打击',
    },
    125: {
        // 召唤 + 「元素」双重不存在 → 换成「击杀攒层、普攻一次性倾泻」
        effects: [mod(62, { perKill: 3, maxStacks: 3, pctPerStack: 0.3 })],
        effects_lv2: [mod(62, { perKill: 3, maxStacks: 5, pctPerStack: 0.45 })],
        effects_lv3: [mod(62, { perKill: 3, maxStacks: 8, pctPerStack: 0.6 })],
        lv1: '每击杀 3 个敌人攒 1 层军阵（上限 3 层），普攻时消耗全部层数、每层追加 30% 攻击力',
        lv2: '军阵上限 5 层，每层追加 45% 攻击力',
        lv3: '军阵上限 8 层，每层追加 60% 攻击力',
    },
    128: {
        // 「给友军增伤」在单英雄局里等于给自己；破甲做成真光环
        effects: [attrs([attr(11, 15, 'percent')])],
        effects_lv2: [attrs([attr(11, 22, 'percent')]), mod(65, { radiusM: 3.5, armorBreak: -3, interval: 1, duration: 2 })],
        effects_lv3: [attrs([attr(11, 30, 'percent')]), mod(65, { radiusM: 4.0, armorBreak: -6, interval: 1, duration: 2 })],
        lv1: '自身伤害输出 +15%',
        lv2: '自身伤害输出 +22%，并持续降低周围 3.5m 内敌人 3 点护甲',
        lv3: '自身伤害输出 +30%，并持续降低周围 4m 内敌人 6 点护甲',
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

    const problems = [];
    for (const idStr of Object.keys(SKILLS)) {
        const id = Number(idStr);
        const row = abilities.find((r) => r.id === id);
        if (!row) { problems.push(`abilities.json 里没有 id ${id}`); continue; }
        if (row.scope !== 'shop') problems.push(`id ${id}（${row.name}）scope=${row.scope}，应为 shop`);
        if (row.behavior !== 'passive') problems.push(`id ${id}（${row.name}）behavior=${row.behavior}，肉鸽技能必须是被动`);
    }
    // 每个 apply_modifier 引用的 modifier id 必须真的在（新表里）存在
    const newIds = new Set(NEW_MODIFIERS.map((m) => m.id));
    const oldIds = new Set(modifiers.filter((r) => !newIds.has(r.id)).map((r) => r.id));
    for (const [id, patch] of Object.entries(SKILLS)) {
        for (const key of ['effects', 'effects_lv2', 'effects_lv3']) {
            for (const e of patch[key] ?? []) {
                if (e.type !== 'apply_modifier') continue;
                if (!newIds.has(e.modifier) && !oldIds.has(e.modifier)) {
                    problems.push(`技能 ${id} 的 ${key} 引用了不存在的 modifier ${e.modifier}`);
                }
            }
        }
    }
    // 脚本类清单必须与 TS 侧注册表一一对应（漏注册 = 运行时静默降级）
    const tsFile = path.join(ROOT, 'assets/scripts/game/battle/ShopSkillModifiers.ts');
    const ts = fs.readFileSync(tsFile, 'utf8');
    for (const m of NEW_MODIFIERS) {
        if (!m.script_id) continue;
        if (!ts.includes(`'${m.script_id}'`) && !ts.includes(`${m.script_id},`)) {
            problems.push(`modifiers.json 的 ${m.id} 声明 script_id=${m.script_id}，但 ShopSkillModifiers.ts 里没有这个类`);
        }
    }
    if (problems.length) {
        console.error('✗ 前置自检失败：');
        for (const p of problems) console.error(`   - ${p}`);
        process.exit(1);
    }

    // ---- modifiers：同 id 先删后插（追加到现有表尾） ----
    const keptMods = modifiers.filter((r) => !newIds.has(r.id)).map((r) => reorder(r, ORDER.modifiers));
    const nextMods = [...keptMods, ...NEW_MODIFIERS.map((r) => reorder(r, ORDER.modifiers))];

    // ---- abilities：只覆盖本脚本负责的行 ----
    let touched = 0;
    const nextAbilities = abilities.map((r) => {
        const patch = SKILLS[r.id];
        if (!patch) return reorder(r, ORDER.abilities);
        touched++;
        const merged = { ...r, ...patch };
        // 该级没有效果就删掉这个键（留空数组在 abilityEffectsAtLevel 里会被当成"有"）
        if (!merged.effects_lv2) delete merged.effects_lv2;
        if (!merged.effects_lv3) delete merged.effects_lv3;
        return reorder(merged, ORDER.abilities);
    });

    console.log(`◆ abilities.json：命中 ${touched} 条（期望 ${Object.keys(SKILLS).length} 条）`);
    for (const id of Object.keys(SKILLS).map(Number).sort((a, b) => a - b)) {
        const row = nextAbilities.find((r) => r.id === id);
        const lv = [row.effects, row.effects_lv2, row.effects_lv3].map((e) => (e ? e.length : '沿用')).join('/');
        console.log(`   ${String(id).padStart(3)} ${row.name.padEnd(6, '　')} 效果条数(1/2/3)=${lv}`);
    }
    console.log(`◆ modifiers.json：${modifiers.length} → ${nextMods.length} 行（+${NEW_MODIFIERS.length}）`);
    const shop = nextAbilities.filter((r) => r.scope === 'shop');
    const withEff = shop.filter((r) => (r.effects?.length ?? 0) > 0 || r.script_id).length;
    console.log(`◆ 商店技能里「已有战斗效果」的：${withEff}/${shop.length}`);

    if (DRY) { console.log('（--dry-run：未写盘）'); return; }
    writeJson('abilities.json', nextAbilities);
    writeJson('modifiers.json', nextMods);
    console.log('✔ 已写 assets/resources/tb/abilities.json 与 modifiers.json');
    console.log('   下一步（必须）：cd tools/excel_export; node src/cli.ts json2excel --force --table abilities,modifiers');
    console.log('   然后：npm run check; npm run verify; npm run audit:skill');
}

main();
