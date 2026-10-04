/**
 * 局内遗物（肉鸽商店道具）效果重做 —— **设计真源**
 *
 * 为什么要有这个文件：
 *   1. 现有 270 件局内遗物的效果是照搬 Dota2 装备的 —— 227 件只是「共享模板 1000 + kv.attrs」的纯属性，
 *      39 件连效果都没有，文案里全是本作不存在的系统（砍树 / 守卫视野 / 信使 / 回城 / 莲花 / 中立代币 / 施法距离 / 弹道速度…）。
 *   2. 重做后的口径（2026-10 定案）：
 *      · **名字与图标不动**（省美术成本），只重做 `modifiers_inner` 与 `description_inner`；
 *      · **删掉"本作没有的系统"那批遗物**（见 DROPS），其余全部保留并重新分档；
 *      · **每个属性都要有遗物能给**（见 ATTR_COVERAGE 自检）；
 *      · **品质池深 4:3:2:1**（白 107 / 蓝 80 / 黄 54 / 红 27，共 268 件）—— 越往上越少、越有身份；
 *      · **白档只给属性**；**蓝档起给"钩子"**（效果），同一钩子可出现在不同品质，只是数值/百分比不同；
 *      · **一件遗物最多 3 个钩子**；**不做主动型遗物**（6 个主动钩子已删、对应遗物改被动，见 HOOKS 末尾注释）。
 *   3. 钩子只能挂在**本作真实存在的时刻**上（触发事件清单见 HOOKS 的 trig 字段，与 `battle/types.ts` 逐一对应）。
 *
 * 生成物（`node tools/excel_export/scripts/gen-relic-inner-design-doc.mjs`）：
 *   · `docs/relic-redesign/README.md`     —— 口径 + 钩子库 + 品质预算 + 删除清单 + 落地路径
 *   · `docs/relic-redesign/relics-inner.md` —— 全表（逐件：属性 / 钩子 / 文案）
 *   · `docs/relic-redesign/relics-inner.csv` —— 同全表，供 Excel 评审
 */

/* =====================================================================================
 * 一、品质与预算
 * ===================================================================================== */

/**
 * 品质池深与预算（2026-10 定案：**池深比例 4:3:2:1** —— 白 96 / 蓝 72 / 黄 48 / 红 24）。
 * 口径：白 = 纯属性垫底（池子最厚、认人不认效果），蓝 = 固定值 + 1 个轻钩子，
 *       黄 = 百分比 / 百分比型属性 + 1~2 钩子，红 = 大百分比 + 功能属性 + 2~3 钩子（每件都是流派核心）。
 */
export const RARITY_PLAN = {
    common: { pool: 107, cn: '白', hooks: 0, attrs: '固定值 1~2 项', budget: '攻击 +8~13 / 生命 +90~145 / 护甲 +1~1.4 / 回血 +0.14~0.22 / 魔法 +40~60 / 攻距 +30~70' },
    rare: { pool: 80, cn: '蓝', hooks: 1, attrs: '固定值 1~2 项（可略高）', budget: '白档属性 + 1 个轻钩子（低概率/小数值/长冷却）' },
    epic: { pool: 54, cn: '黄', hooks: '1~2', attrs: '百分比 或 百分比型属性（攻速/闪避/暴击率/魔抗/受伤/增伤）', budget: '攻击 +14~16% / 生命 +18~20% / 攻速 +25 / 闪避 +10 / 暴击率 +12 / 魔抗 +15 / 受伤 -12 / 增伤 +12' },
    legendary: { pool: 27, cn: '红', hooks: '2~3', attrs: '大百分比 + 功能属性（金币/经验/冷却/抽卡折扣）', budget: '攻击 +32% / 生命 +42% / 攻速 +40 / 闪避 +15 / 暴击率 +16 / 暴击倍率 225（best） + 功能百分比 +20~35%' },
};

/**
 * 新增属性（`AttributeType` 扩到 25~27）。
 * 消费点（落地时必须接线，否则"加了却没变"，属 `npm run audit:attr` 会抓的那类脏数据）：
 *   21 金币获取 → `Scene_Game_Stage.grantKillReward`（与成就金币加成同一处折算）
 *   22 经验获取 → `Scene_Game_Stage.addBattleExp` 调用点（同上）
 *   23 冷却缩减 → `Ability.Cast` 设 `cooldownRemaining` 时乘 (1 - cdr)
 *   24 抽卡折扣 → `RelicShop` 扣费处（`drawCost * (1 - discount)`，封顶不超过 50%）
 *   25 吸血 / 26 攻击回复 / 27 攻击回蓝 → **普攻命中结算点** `Entity.resolveAttackHit`
 *      （近战与远程弹道命中都走这里）：`heal += 本次伤害 × 吸血%`、`heal += 攻击回复`、`mana += 攻击回蓝`。
 *      口径：**只对普攻伤害生效**（技能吸血另说）；攻击回复/攻击回蓝是**固定值**，不吃暴击倍率。
 */
export const NEW_ATTRS = [
    { id: 21, cn: '金币获取', mode: 'add', scale: true, text: v => `金币获取 +${v}%`, min: '红（功能百分比，与门禁「功能性百分比红档起」一致）' },
    { id: 22, cn: '经验获取', mode: 'add', scale: true, text: v => `经验获取 +${v}%`, min: '红（功能百分比，同上）' },
    { id: 23, cn: '冷却缩减', mode: 'add', scale: true, text: v => `技能冷却 -${v}%`, min: '红（功能百分比）' },
    { id: 24, cn: '抽卡折扣', mode: 'add', scale: true, text: v => `遗物抽取费用 -${v}%`, min: '红（功能百分比）' },
    { id: 25, cn: '吸血', mode: 'add', scale: true, text: v => `吸血 +${v}%`, min: '黄（百分比型属性）' },
    { id: 26, cn: '攻击回复', mode: 'add', scale: false, text: v => `每次普攻命中回复 ${v} 点生命`, min: '白（数值属性）' },
    { id: 27, cn: '攻击回蓝', mode: 'add', scale: false, text: v => `每次普攻命中回复 ${v} 点魔法`, min: '白（数值属性，本稿顺带）' },
];

/** 属性中文名（与 `battle/core/Types.ts` 的 AttributeTypeName 对齐；21~27 见 NEW_ATTRS） */
export const ATTR_CN = {
    1: '最大生命', 2: '最大魔法', 3: '攻击力', 4: '攻击速度', 5: '移动速度', 6: '护甲',
    7: '魔法抗性', 8: '闪避', 9: '生命恢复', 10: '魔法恢复', 11: '伤害输出', 12: '受伤减免',
    13: '魔法受伤（已并入 12，勿用）', 14: '暴击率', 15: '暴击倍率', 16: '攻击距离',
    21: '金币获取', 22: '经验获取', 23: '冷却缩减', 24: '抽卡折扣',
    25: '吸血', 26: '攻击回复', 27: '攻击回蓝',
};

/**
 * 2026-10 用户口径：**受伤减免是"全能减免"** —— 物理与法术都减，不再分「物理受伤 / 魔法受伤」两条。
 * 因此属性 **13（魔法受伤）退役**，全池改给 **12（受伤减免）**；引擎侧 `DamagePipeline` 的第 4 阶段
 * 原本按伤害类型取 12/13，落地时改成**一律取 12**（`collectIncomingMultiplier`）。
 * 13 现在只留在 `TypeScript`/`attributes.json` 的字典里当历史值，遗物**一件都不许再用**（生成器卡红线）。
 */
export const MERGED_ATTRS = new Set([13]);

/** 百分比型属性（配置值 = 实际值 × 100，用 `add`；禁 `percent`）—— 与 `AttributeScaling.SCALE` 一致 */
export const PERCENT_ATTRS = new Set([4, 7, 8, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25]);
/** base = 0 的数值属性（禁 `percent`，只能用 `add`） */
export const ZERO_BASE_ATTRS = new Set([6, 9, 10]);

/**
 * 本作**没有**的属性：5 移动速度。
 * 英雄是固定锚点（`Entity.immovable`，只推怪不被推）→ 局内给移速等于没给。
 * 3 件移速遗物（1012 风灵之纹 / 1024 速度之靴 / 1275 捷足）在重做里改给**攻速/攻击距离/闪避**。
 */
export const DEAD_ATTRS = new Set([5]);

/* =====================================================================================
 * 二之补：属性上限 + 「遗物池总供给必须高于上限」
 * ===================================================================================== */

/**
 * 有上限的属性（用户口径 2026-10 + 本稿补的待确认项）。
 * `cap` = 上限（**配置口径**：百分比型属性 = 百分点；攻速 = 100 表示 1.0 次/秒）；
 * `min` = 期望的供给倍数（全池总给 ÷ 上限，≥ 该值才算"有构筑选择空间"；< 1 即堆不满 = 严重问题）。
 *
 * ⚠ 两处必须同步改代码/配表（落地清单见文档 §5）：
 *   · `attributes.json` 的 max（现 攻速 1000 / 闪避 95 / 护甲 100 / 暴击率 100 …）；
 *   · `battle_constants.json` 里那三个**死常量** critRateCap 0.6 / dodgeCap 0.4 / atkSpeedCap 3
 *     （全工程无消费方，与上面这套上限打架，要么删要么接线成唯一真源）。
 */
export const ATTR_CAPS = {
    4: { cap: 500, unit: '攻速 5.0（100 = 1.0）', min: 1.3, note: '用户口径：最高 5' },
    6: {
        cap: 200, unit: '护甲（物理减伤，递减、不到 100%）', min: 1.2,
        // 2026-10 定案：**公式保留**现有 Dota 双曲 `0.06a/(1+0.06|a|)` —— 护甲 200 → 92.3% 减伤，
        // 要到 99% 需 ≈1650。上限 200 就是"92% 档"，不再按 99% 反推，也不需要改公式。
        note: '用户口径：最高 200；公式已定案保留（200 → 92.3%）',
    },
    7: { cap: 95, unit: '魔法抗性 %', min: 1.5, note: '用户口径（2026-10 已确认）：95，与护甲同理（递减、不到 100%）' },
    8: { cap: 45, unit: '闪避 %', min: 2.0, note: '用户口径：最高 45' },
    12: { cap: -80, unit: '受伤减免（**全能减免**：物理与法术都减；负值=减伤 %）', min: 1.2, note: '用户口径（2026-10）：受伤减免就是全能减免，最多减 80%；原 12 物理受伤 / 13 魔法受伤 合并成这一条' },
    14: { cap: 100, unit: '暴击率 %', min: 1.5, note: '用户口径：100' },
    23: { cap: 50, unit: '冷却缩减 %', min: 1.5, note: '用户口径：最高 50' },
    24: { cap: 80, unit: '抽卡折扣 %', min: 1.2, note: '用户口径：最高 80' },
};

/**
 * 无上限属性（2026-10 用户口径）—— 它们是**无限成长轴**：不做上限自检，只统计供给量。
 *   11 伤害输出 / 15 暴击倍率 / 21 金币获取 / 22 经验获取 / 25 吸血 / 26 攻击回复 / 27 攻击回蓝。
 *
 * ⚠ **落地注意**：无上限 ≠ 代码无上限 —— `attributes.json` 的 max 仍会被 `AttributeSystem` 钳制
 *   （现 伤害输出 max 1000 = +900%、暴击倍率 max 1000 = 10 倍）。要真"无上限"就得把 max 放到足够大，
 *   否则到顶那天会出现"加了却没变"（`npm run audit:attr` 会抓）。
 *   无上限轴的平衡靠**边际成本**（抽取费用 50→200 递增）+ 数值曲线，不靠硬上限。
 */
export const UNCAPPED_ATTRS = [1, 2, 3, 9, 10, 11, 15, 16, 21, 22, 25, 26, 27];

/**
 * 供给配平表 —— 保证「该属性的全池总给 > 上限（且 ≥ min 倍）」。
 *
 * 为什么需要它：白档/蓝档的单件属性值是照着"一件小装备"给的（护甲 +1），
 * 全池加起来也够不到上限 → 上限永远不会生效、玩家堆也堆不满。所以对**有上限**的属性，
 * 按品质统一抬到下面这组"供给值"，并把这些 id 追加到还没给该属性的件上。
 *
 * 规则：`{ common/rare/epic/legendary: 值, add: [额外追加的遗物 id], except: [跳过自动覆盖的 id] }`
 *   · 已给该属性的件 → 值**覆盖**为该品质的值；
 *   · `add` 里的件 → 没有该属性就**追加**一条；
 *   · `except` → 保留原值（如 1292 癫狂 的"受到伤害 +10%"是它的代价，不能被减伤覆盖）。
 */
export const SUPPLY_TOPUP = {
    4: {
        epic: 25, legendary: 40,
        // add = 追加到这些件身上（epic 名单 10 件 + 红档 2 件）；加 14 件原有 + 1 件红档原有 = 720（1.44×）
        add: [1031, 1123, 1132, 1141, 1148, 1163, 1179, 1192, 1204, 1281, 1206, 1207],
    },
    6: { common: 3.5, rare: 6, epic: 10, legendary: 16 },
    7: { epic: 15, legendary: 25, add: [1139, 1165] },
    8: { epic: 10, legendary: 15, add: [1130, 1146, 1163, 1120, 1204] },
    11: { epic: 12, legendary: 18, add: [1123, 1125, 1132, 1140, 1142, 1148, 1146, 1199, 1161, 1197] },
    12: {
        epic: -12, legendary: -20,
        // 全能减免（原 12 + 13 合并）：epic 5 件 + 原本就有 12 的 3 件 + 红档 3 件 → 约 -156（1.95×）
        add: [1044, 1120, 1130, 1146, 1163, 1137, 1160, 1207],
        except: [1292],   // 癫狂的「受到伤害 +10%」是它的代价，不能被减伤覆盖
    },
    14: { epic: 12, legendary: 16, add: [1044, 1120, 1123, 1125, 1132, 1139, 1141, 1156, 1152, 1199, 1197] },
    21: { legendary: 20, add: [1221] },
    22: { legendary: 20, add: [1131, 1280, 1221] },
    23: { legendary: 30, add: [1169, 1185, 1153] },
    24: { legendary: 35, add: [1221, 1131, 1280] },
};

/**
 * 吸血 / 攻击回复 / 攻击回蓝 —— **2026-10 定案：做成正式属性**（25 / 26 / 27），不再是钩子。
 * 属性值由遗物的 `kv.attrs` 给（共享模板 1000），运行时在**普攻命中结算点** `Entity.resolveAttackHit` 消费。
 * 本表只用于文档里展示"每档给多少"，与 ATTR_CAPS 无关（它们无上限）。
 */
export const VAMP_ATTR_TIERS = {
    25: { rare: 5, epic: 9, legendary: 15, unit: '吸血 %（无上限）' },
    26: { rare: 2, epic: 5, legendary: 9, unit: '攻击回复（点/次，无上限）' },
    27: { rare: 1, epic: 3, legendary: 5, unit: '攻击回蓝（点/次，无上限）' },
};

/* =====================================================================================
 * 二、钩子库（效果词汇）—— 触发事件只允许来自这张表
 * ===================================================================================== */

/**
 * impl 字段的取值：
 *   `S:<类名>` = 新增**参数化脚本模板**（`battle/RelicHooks.ts`，`script_id` 指向它，数值全部由遗物 `kv` 传入）
 *   `A:<attrId>` = 纯属性（走共享模板 1000 的 `kv.attrs`，不算钩子）
 *   `BUS:<事件>` = 需要脚本自行订阅总线（`on_kill` 等**只发总线、不派发给 Modifier**，必须 `OnDestroy` 里 off）
 *
 * 五个**会派发给 Modifier**的事件（能直接写 `events[].actions` 的只有前五个）：
 *   on_attack_start / on_attack_landed / on_block_damage / on_take_damage / on_evade / on_deal_damage
 * 只发总线的事件：on_kill / on_death / on_gold_gained / on_ability_cast / on_projectile_hit/miss /
 *   on_relic_added / on_relic_removed / on_entity_added/removed / on_heal / on_state_changed
 */
export const HOOKS = [
    /* ---------- A 攻击命中类 ---------- */
    {
        id: 'hitFlat', cn: '追击', trig: 'on_attack_landed', impl: 'S:RelicHook_HitFlat', kv: ['value'],
        tier: { rare: { value: 20 }, epic: { value: 45 }, legendary: { value: 80 } },
        txt: v => `普攻命中后追加 ${v.value} 点魔法伤害`,
    },
    {
        id: 'hitPct', cn: '重击', trig: 'on_attack_landed', impl: 'S:RelicHook_HitPct', kv: ['pct'],
        tier: { rare: { pct: 15 }, epic: { pct: 30 }, legendary: { pct: 50 } },
        txt: v => `普攻命中后追加 攻击力 ${v.pct}% 的魔法伤害`,
    },
    {
        id: 'ignite', cn: '点燃', trig: 'on_attack_landed', impl: 'S:RelicHook_Ignite', kv: ['chance', 'dps'],
        tier: { rare: { chance: 20, dps: 6 }, epic: { chance: 35, dps: 12 }, legendary: { chance: 50, dps: 20 } },
        txt: v => `普攻有 ${v.chance}% 概率点燃目标：每秒 ${v.dps} 点魔法伤害，持续 3 秒`,
    },
    {
        id: 'poison', cn: '剧毒', trig: 'on_attack_landed', impl: 'S:RelicHook_Poison', kv: ['dps'],
        tier: { rare: { dps: 4 }, epic: { dps: 8 }, legendary: { dps: 14 } },
        txt: v => `普攻使目标中毒：每层每秒 ${v.dps} 点魔法伤害（上限 5 层，持续 4 秒）`,
    },
    {
        id: 'frost', cn: '冰霜', trig: 'on_attack_landed', impl: 'S:RelicHook_Frost', kv: ['chance', 'slow'],
        tier: { rare: { chance: 25, slow: 25 }, epic: { chance: 40, slow: 35 }, legendary: { chance: 55, slow: 45 } },
        txt: v => `普攻有 ${v.chance}% 概率使目标减速 ${v.slow}%，持续 2 秒`,
    },
    {
        id: 'armorBreak', cn: '破甲', trig: 'on_attack_landed', impl: 'S:RelicHook_ArmorBreak', kv: ['armor'],
        tier: { rare: { armor: 2 }, epic: { armor: 3 }, legendary: { armor: 5 } },
        txt: v => `普攻使目标护甲 -${v.armor}（持续 2 秒，可叠 3 层）`,
    },
    {
        id: 'splash', cn: '溅射', trig: 'on_attack_landed', impl: 'S:RelicHook_Splash', kv: ['pct', 'radius'],
        tier: { rare: { pct: 20, radius: 120 }, epic: { pct: 30, radius: 140 }, legendary: { pct: 45, radius: 160 } },
        txt: v => `普攻命中后，对目标 ${v.radius} 像素内敌人造成 攻击力 ${v.pct}% 的伤害`,
    },
    {
        id: 'chain', cn: '连锁', trig: 'on_attack_landed', impl: 'S:RelicHook_Chain', kv: ['jumps', 'pct'],
        tier: { rare: { jumps: 1, pct: 40 }, epic: { jumps: 2, pct: 50 }, legendary: { jumps: 3, pct: 60 } },
        txt: v => `普攻命中后弹射 ${v.jumps} 次，每次造成 攻击力 ${v.pct}% 的伤害`,
    },
    {
        id: 'pierce', cn: '穿透', trig: 'on_attack_landed', impl: 'S:RelicHook_Pierce', kv: ['extra'],
        tier: { rare: { extra: 1 }, epic: { extra: 2 }, legendary: { extra: 3 } },
        txt: v => `普攻额外命中 ${v.extra} 个敌人（各造成 60% 伤害）`,
    },
    {
        id: 'execute', cn: '斩杀', trig: 'on_attack_landed', impl: 'S:RelicHook_Execute', kv: ['threshold', 'mult'],
        tier: { rare: { threshold: 15, mult: 1.2 }, epic: { threshold: 25, mult: 1.3 }, legendary: { threshold: 35, mult: 1.5 } },
        txt: v => `目标生命低于 ${v.threshold}% 时，普攻伤害 ×${v.mult}`,
    },
    {
        id: 'firstStrike', cn: '首击', trig: 'on_attack_landed', impl: 'S:RelicHook_FirstStrike', kv: ['pct'],
        tier: { rare: { pct: 25 }, epic: { pct: 40 }, legendary: { pct: 60 } },
        txt: v => `对满血敌人普攻伤害 +${v.pct}%`,
    },
    {
        id: 'critEcho', cn: '暴击回响', trig: 'on_deal_damage', impl: 'S:RelicHook_CritEcho', kv: ['pct', 'radius'],
        tier: { rare: { pct: 30, radius: 120 }, epic: { pct: 50, radius: 130 }, legendary: { pct: 80, radius: 140 } },
        txt: v => `暴击时对目标 ${v.radius} 像素内敌人造成 ${v.pct}% 伤害`,
    },
    {
        id: 'atkSpeedStack', cn: '连击', trig: 'on_attack_landed', impl: 'S:RelicHook_AtkSpeedStack', kv: ['per', 'max'],
        tier: { rare: { per: 2, max: 6 }, epic: { per: 3, max: 10 }, legendary: { per: 4, max: 15 } },
        txt: v => `普攻命中叠 1 层：攻击速度 +${v.per}%（上限 ${v.max} 层，持续 3 秒）`,
    },
    {
        id: 'charge', cn: '蓄力', trig: 'on_attack_start', impl: 'S:RelicHook_Charge', kv: ['interval', 'mult'],
        tier: { rare: { interval: 8, mult: 2.0 }, epic: { interval: 6, mult: 2.5 }, legendary: { interval: 5, mult: 3.0 } },
        txt: v => `每 ${v.interval} 秒，下一次普攻造成 ${v.mult} 倍伤害`,
    },

    /* ---------- B 受击 / 生存类 ---------- */
    {
        id: 'thorns', cn: '荆棘', trig: 'on_take_damage', impl: 'S:RelicHook_Thorns', kv: ['pct'],
        tier: { rare: { pct: 15 }, epic: { pct: 25 }, legendary: { pct: 40 } },
        txt: v => `受到伤害后，向攻击者反弹 ${v.pct}% 伤害`,
    },
    {
        id: 'block', cn: '格挡', trig: 'on_block_damage', impl: 'S:RelicHook_Block', kv: ['value'],
        tier: { rare: { value: 10 }, epic: { value: 20 }, legendary: { value: 35 } },
        txt: v => `每次受到攻击格挡 ${v.value} 点伤害`,
    },
    {
        id: 'shieldCharge', cn: '护盾充能', trig: 'on_tick', impl: 'S:RelicHook_ShieldCharge', kv: ['cd', 'value'],
        tier: { rare: { cd: 8, value: 20 }, epic: { cd: 6, value: 35 }, legendary: { cd: 5, value: 60 } },
        txt: v => `每 ${v.cd} 秒获得一次 ${v.value} 点伤害格挡`,
    },
    {
        id: 'evadeCounter', cn: '闪避反击', trig: 'on_evade', impl: 'S:RelicHook_EvadeCounter', kv: ['pct'],
        tier: { rare: { pct: 100 }, epic: { pct: 150 }, legendary: { pct: 200 } },
        txt: v => `闪避成功后对攻击者造成 攻击力 ${v.pct}% 的伤害`,
    },
    {
        id: 'lowHpGuard', cn: '背水', trig: 'on_take_damage', impl: 'S:RelicHook_LowHpGuard', kv: ['threshold', 'pct'],
        tier: { rare: { threshold: 35, pct: 15 }, epic: { threshold: 35, pct: 25 }, legendary: { threshold: 40, pct: 40 } },
        txt: v => `生命低于 ${v.threshold}% 时，受到的伤害降低 ${v.pct}%`,
    },
    {
        id: 'nearDeath', cn: '濒死守护', trig: 'on_take_damage', impl: 'S:RelicHook_NearDeath', kv: ['cd', 'dur'],
        tier: { rare: { cd: 60, dur: 1.5 }, epic: { cd: 45, dur: 1.5 }, legendary: { cd: 30, dur: 2 } },
        txt: v => `每 ${v.cd} 秒一次：生命低于 25% 时获得 ${v.dur} 秒无敌`,
    },
    {
        id: 'lastStand', cn: '不屈', trig: 'on_take_damage', impl: 'S:RelicHook_LastStand', kv: ['count'],
        tier: { rare: { count: 1 }, epic: { count: 1 }, legendary: { count: 2 } },
        txt: v => `本局受到致命伤害时以 1 点生命存活（${v.count} 次）`,
    },
    {
        id: 'takeHeal', cn: '坚韧', trig: 'on_take_damage', impl: 'S:RelicHook_TakeHeal', kv: ['value'],
        tier: { rare: { value: 3 }, epic: { value: 6 }, legendary: { value: 12 } },
        txt: v => `每次受到伤害后回复 ${v.value} 点生命`,
    },
    {
        id: 'immolate', cn: '灼烧光环', trig: 'on_tick', impl: 'S:RelicHook_Immolate', kv: ['value', 'radius'],
        tier: { rare: { value: 8, radius: 140 }, epic: { value: 16, radius: 150 }, legendary: { value: 30, radius: 160 } },
        txt: v => `每秒对周围 ${v.radius} 像素内的敌人造成 ${v.value} 点魔法伤害`,
    },
    {
        id: 'takeStackAtk', cn: '激怒', trig: 'on_take_damage', impl: 'S:RelicHook_TakeStackAtk', kv: ['per', 'max'],
        tier: { rare: { per: 1, max: 10 }, epic: { per: 1.5, max: 20 }, legendary: { per: 2, max: 30 } },
        txt: v => `每次受到伤害：攻击力 +${v.per}%（上限 ${v.max} 层，本局永久）`,
    },
    {
        id: 'magicBarrier', cn: '法术屏障', trig: 'on_take_damage', impl: 'S:RelicHook_MagicBarrier', kv: ['cd', 'pct'],
        tier: { rare: { cd: 25, pct: 50 }, epic: { cd: 20, pct: 100 }, legendary: { cd: 15, pct: 100 } },
        txt: v => `每 ${v.cd} 秒阻挡一次魔法伤害的 ${v.pct}%`,
    },
    {
        id: 'regenTick', cn: '复苏', trig: 'on_tick', impl: 'S:RelicHook_RegenTick', kv: ['interval', 'pct'],
        tier: { rare: { interval: 10, pct: 2 }, epic: { interval: 8, pct: 3 }, legendary: { interval: 6, pct: 5 } },
        txt: v => `每 ${v.interval} 秒回复 ${v.pct}% 最大生命`,
    },

    /* ---------- C 击杀类（只发总线，脚本自行订阅，OnDestroy 必须 off） ---------- */
    {
        id: 'killHeal', cn: '屠戮回血', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillHeal', kv: ['value'],
        tier: { rare: { value: 8 }, epic: { value: 15 }, legendary: { value: 25 } },
        txt: v => `击杀敌人回复 ${v.value} 点生命`,
    },
    {
        id: 'killMana', cn: '汲取', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillMana', kv: ['value'],
        tier: { rare: { value: 5 }, epic: { value: 10 }, legendary: { value: 20 } },
        txt: v => `击杀敌人回复 ${v.value} 点魔法`,
    },
    {
        id: 'killGold', cn: '悬赏', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillGold', kv: ['value'],
        tier: { rare: { value: 1 }, epic: { value: 2 }, legendary: { value: 4 } },
        txt: v => `每击杀 1 名敌人额外获得 ${v.value} 金币`,
    },
    {
        id: 'killExpFlat', cn: '领悟', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillExp', kv: ['exp'],
        tier: { rare: { exp: 3 }, epic: { exp: 6 }, legendary: { exp: 12 } },
        txt: v => `每击杀 1 名敌人额外获得 ${v.exp} 点经验`,
    },
    {
        id: 'killStackAtk', cn: '嗜杀', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillStackAtk', kv: ['per', 'max'],
        tier: { rare: { per: 0.5, max: 40 }, epic: { per: 0.8, max: 60 }, legendary: { per: 1.2, max: 80 } },
        txt: v => `每击杀 1 名敌人：攻击力 +${v.per}（上限 ${v.max}，本局永久）`,
    },
    {
        id: 'killBoom', cn: '死亡回响', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillBoom', kv: ['value', 'radius'],
        tier: { rare: { value: 40, radius: 120 }, epic: { value: 80, radius: 140 }, legendary: { value: 140, radius: 160 } },
        txt: v => `击杀敌人时，对周围 ${v.radius} 像素内敌人造成 ${v.value} 点魔法伤害`,
    },
    {
        id: 'killCdr', cn: '处决节律', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillCdr', kv: ['value'],
        tier: { rare: { value: 0.5 }, epic: { value: 1 }, legendary: { value: 2 } },
        txt: v => `击杀敌人使所有技能冷却减少 ${v.value} 秒`,
    },

    /* ---------- D 节奏 / 周期类 ---------- */
    {
        id: 'tickStackAtk', cn: '战意', trig: 'on_tick', impl: 'S:RelicHook_TickStackAtk', kv: ['interval', 'per', 'max'],
        tier: { rare: { interval: 5, per: 1, max: 20 }, epic: { interval: 4, per: 1, max: 30 }, legendary: { interval: 3, per: 1.5, max: 40 } },
        txt: v => `每 ${v.interval} 秒：攻击力 +${v.per}%（上限 ${v.max} 层，本局永久）`,
    },
    {
        id: 'phaseBuff', cn: '阶段契约', trig: 'BUS:on_phase_changed', impl: 'S:RelicHook_PhaseBuff', kv: ['atkSpeed', 'max'],
        tier: { rare: { atkSpeed: 4, max: 5 }, epic: { atkSpeed: 6, max: 6 }, legendary: { atkSpeed: 8, max: 8 } },
        txt: v => `每进入新阶段：攻击速度 +${v.atkSpeed}%（上限 ${v.max} 层，本局永久）`,
    },

    /* ---------- E 控制 / 光环类 ---------- */
    {
        id: 'slowAura', cn: '迟滞光环', trig: 'on_tick', impl: 'S:RelicHook_SlowAura', kv: ['pct', 'radius'],
        tier: { rare: { pct: 20, radius: 160 }, epic: { pct: 30, radius: 180 }, legendary: { pct: 40, radius: 200 } },
        txt: v => `周围 ${v.radius} 像素内敌人移动速度 -${v.pct}%`,
    },
    {
        id: 'stunProc', cn: '震荡', trig: 'on_attack_landed', impl: 'S:RelicHook_StunProc', kv: ['chance', 'dur'],
        tier: { rare: { chance: 10, dur: 0.8 }, epic: { chance: 18, dur: 1 }, legendary: { chance: 25, dur: 1.2 } },
        txt: v => `普攻有 ${v.chance}% 概率眩晕目标 ${v.dur} 秒`,
    },
    {
        id: 'freezeProc', cn: '冰封', trig: 'on_attack_landed', impl: 'S:RelicHook_FreezeProc', kv: ['chance'],
        tier: { rare: { chance: 12 }, epic: { chance: 20 }, legendary: { chance: 30 } },
        txt: v => `普攻有 ${v.chance}% 概率冻结目标 1.5 秒`,
    },
    {
        id: 'hexProc', cn: '妖术', trig: 'on_attack_landed', impl: 'S:RelicHook_HexProc', kv: ['chance', 'dur'],
        tier: { rare: { chance: 6, dur: 1.2 }, epic: { chance: 10, dur: 1.5 }, legendary: { chance: 15, dur: 2 } },
        txt: v => `普攻有 ${v.chance}% 概率妖术目标 ${v.dur} 秒`,
    },
    {
        id: 'silenceProc', cn: '静默', trig: 'on_attack_landed', impl: 'S:RelicHook_SilenceProc', kv: ['chance', 'dur'],
        tier: { rare: { chance: 15, dur: 2 }, epic: { chance: 25, dur: 2 }, legendary: { chance: 35, dur: 2.5 } },
        txt: v => `普攻有 ${v.chance}% 概率沉默目标 ${v.dur} 秒`,
    },

    /* ---------- F 主动型：**2026-10 定案不做**（不做遗物面板的使用按钮） ----------
     * 原来那 6 个主动钩子已删，对应 6 件遗物改成**同主题的被动**：
     *   时间冻结 1153  activeFreeze  → freezeProc（普攻概率冰封）
     *   神灭斩   1155  activeNuke    → execute（对残血敌人追加斩杀伤害）
     *   分身     1178  activeTurret  → critEcho（普攻命中后追加一段伤害 = 影分身补刀）
     *   护盾爆发 1186  activeShield  → shieldCharge（受击累积护盾）
     *   全军狂暴 1198  activeRage    → atkSpeedStack（攻击/击杀叠攻速）
     *   生机     1209  activeHeal    → killHeal（击杀回血）
     */
];

/** 钩子按 id 取用 */
export const HOOK_BY_ID = Object.fromEntries(HOOKS.map(h => [h.id, h]));

/** 每件遗物最多几个钩子 */
export const MAX_HOOKS_PER_RELIC = 3;

/**
 * 删除清单 —— **本作没有对应系统**的遗物（名字保留也没意义：图标/名字指向一个打不出来的动作）。
 * 其余一律保留（名字/图标/品质身份不动，只重做效果与文案）。
 */
export const DROPS = [
    { ids: [1048, 1049, 1050, 1051], reason: '闪烁 / 位移系统不存在（英雄是固定锚点，不移动）' },
    { ids: [1052, 1053, 1054], reason: '地上掉落拾取物 / 莲花系统不存在' },
    { ids: [1032, 1055, 1064, 1065, 1073], reason: '视野 / 守卫 / 反隐系统不存在（敌人没有隐身机制）' },
    { ids: [1066, 1076], reason: '信使 / 运货系统不存在' },
    { ids: [1077, 1138], reason: '回城 / 传送系统不存在' },
    { ids: [1062, 1074, 1081], reason: '砍树 / 吃树 / 种植系统不存在' },
    { ids: [1262, 1263, 1264, 1265, 1266], reason: '中立装备代币系统不存在（我们没有中立装备栏）' },
    { ids: [1114, 1115, 1200, 1201], reason: '道具升级技能的系统不存在（技能只能靠重复抽取升级，见 SkillSlots）' },
    { ids: [1260, 1261], reason: '吞噬 / 融合符文系统不存在' },
];

/** 删除 id 集合 */
export const DROP_IDS = new Set(DROPS.flatMap(d => d.ids));

/* =====================================================================================
 * 三、逐件设计
 *   a = kv.attrs（属性条目，写法与 relics.json 一致）；h = 钩子 id（档位默认取本件品质，可 [id, 'epic'] 覆盖）
 *   kw = 关键词（UI 上的一句话身份）；note = 需要额外说明的点
 * ===================================================================================== */

export const ITEMS = [
    /* ===== 红档（流派级：大百分比 + 功能属性 + 2~3 钩子） · 27 件 ===== */
    { id: 5, r: 'legendary', a: [[1, 145]], h: ['lastStand'], kw: '锁血' },
    { id: 1131, r: 'legendary', a: [[3, 27, 'percent'], [21, 10, 'add']], h: ['killGold', 'killExpFlat'], kw: '点金（经济）' },
    { id: 1137, r: 'legendary', a: [[3, 22, 'percent'], [6, 1.5]], h: ['thorns', 'lowHpGuard'], kw: '刃甲' },
    { id: 1153, r: 'legendary', a: [[3, 27, 'percent'], [1, 29, 'percent']], h: ['freezeProc', 'lastStand'], kw: '时间冻结（命中概率冰封）' },
    { id: 1155, r: 'legendary', a: [[3, 27, 'percent']], h: ['execute', 'hitPct'], kw: '神灭斩（斩杀）' },
    { id: 1157, r: 'legendary', a: [[3, 27, 'percent'], [4, 25, 'add']], h: ['firstStrike', 'critEcho'], kw: '影刃' },
    { id: 1159, r: 'legendary', a: [[3, 27, 'percent'], [14, 14, 'add'], [15, 225, 'best']], h: ['critEcho'], kw: '暴击' },
    { id: 1160, r: 'legendary', a: [[3, 22, 'percent'], [1, 29, 'percent'], [6, 1.9]], h: ['block', 'evadeCounter'], kw: '天堂' },
    { id: 1161, r: 'legendary', a: [[3, 27, 'percent'], [6, 1.9]], h: ['armorBreak', 'execute'], kw: '黯灭' },
    { id: 1164, r: 'legendary', a: [[1, 36, 'percent']], h: ['takeStackAtk', 'immolate'], kw: '契约' },
    { id: 1169, r: 'legendary', a: [[1, 29, 'percent'], [23, 10, 'add']], h: ['killCdr'], kw: '神杖' },
    { id: 1180, r: 'legendary', a: [[3, 27, 'percent'], [1, 29, 'percent'], [9, 0.28], [25, 15, 'add']], h: ['killHeal', 'regenTick'], kw: '血精' },
    { id: 1181, r: 'legendary', a: [[3, 27, 'percent'], [8, 11, 'add']], h: ['immolate', 'lowHpGuard'], kw: '辉耀' },
    { id: 1183, r: 'legendary', a: [[1, 29, 'percent'], [9, 0.28], [7, 15, 'add']], h: ['magicBarrier', 'nearDeath'], kw: '林肯' },
    { id: 1185, r: 'legendary', a: [[1, 29, 'percent'], [9, 0.28], [23, 10, 'add']], h: ['killCdr'], kw: '奥术' },
    { id: 1195, r: 'legendary', a: [[3, 32, 'percent'], [8, 13, 'add']], h: ['chain', 'critEcho'], kw: '雷神' },
    { id: 1197, r: 'legendary', a: [[3, 32, 'percent']], h: ['execute', 'hitPct', 'critEcho'], kw: '圣剑' },
    { id: 1198, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [6, 2.2]], h: ['atkSpeedStack', 'killStackAtk'], kw: '全军狂暴（击杀叠攻速）' },
    { id: 1203, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [25, 15, 'add'], [26, 9]], h: ['splash'], kw: '九头蛇' },
    { id: 1206, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [9, 0.32]], h: ['stunProc', 'execute'], kw: '深渊' },
    { id: 1207, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [9, 0.32]], h: ['pierce', 'killStackAtk'], kw: '三叉戟' },
    { id: 1208, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [8, 13, 'add']], h: ['critEcho', 'execute'], kw: '血棘' },
    { id: 1221, r: 'legendary', a: [[9, 0.5], [24, 15, 'add']], h: ['killGold', 'killExpFlat'], kw: '采集（经济·抽卡折扣）' },
    { id: 1280, r: 'legendary', a: [[3, 27, 'percent'], [21, 10, 'add']], h: ['killGold', 'killExpFlat'], kw: '贪婪（经济）' },

    /* ----- 2026-10 补：`scope=both` 的 28 件（局内版也要重做，之前漏了这批）-----
     * 这批是**两侧都有**的遗物（Dota2 基础件 + 核心大件）：局外版不动，但它们的**局内版**
     * 原来还挂着「砍树 / 天神下凡 / 冰霜光环 / 致命一击 / 巨兽之血 / 弹道速度…」这些本作没有的东西，
     * 所以按同一套口径补进设计（名字/图标/局外版全不动，只重写局内版效果与文案）。
     * 池深同步按 4:3:2:1 重算：白 107 / 蓝 80 / 黄 54 / 红 27（共 268 件）。 */
    { id: 1190, r: 'legendary', a: [[3, 27, 'percent'], [14, 16, 'add'], [15, 225, 'best']], h: ['critEcho'], kw: '致命一击' },
    { id: 1194, r: 'legendary', a: [[3, 27, 'percent'], [4, 25, 'add'], [8, 13, 'add']], h: ['evadeCounter'], kw: '蝴蝶' },
    { id: 1202, r: 'legendary', a: [[3, 32, 'percent'], [1, 42, 'percent'], [4, 25, 'add']], h: ['frost', 'slowAura'], kw: '霜寒' },

    /* ===== 黄档（百分比 / 百分比型属性 + 1~2 钩子） · 54 件 ===== */
    { id: 2, r: 'epic', a: [[3, 12], [25, 9, 'add']], kw: '吸血' },
    { id: 1019, r: 'epic', a: [[7, 12, 'add'], [11, 10, 'add']], h: ['silenceProc'], kw: '法抗增伤' },
    { id: 1021, r: 'epic', a: [[4, 12, 'add']], h: ['atkSpeedStack'], kw: '攻速' },
    { id: 1022, r: 'epic', a: [[7, 15, 'add'], [12, -10, 'add']], h: ['magicBarrier'], kw: '法抗' },
    { id: 1025, r: 'epic', a: [[3, 10], [25, 9, 'add']], kw: '吸血' },
    { id: 1031, r: 'epic', a: [[3, 14, 'percent'], [25, 9, 'add']], h: ['killHeal'], kw: '吸取' },
    { id: 1033, r: 'epic', a: [[7, 25, 'add']], h: ['magicBarrier'], kw: '法抗' },
    { id: 1034, r: 'epic', a: [[8, 8, 'add']], h: ['evadeCounter'], kw: '闪避反击' },
    { id: 1044, r: 'epic', a: [[3, 13, 'percent'], [12, -10, 'add']], h: ['lowHpGuard'], kw: '虚化减伤' },
    { id: 1080, r: 'epic', a: [[4, 25, 'add']], h: ['atkSpeedStack'], kw: '月华' },
    { id: 1112, r: 'rare', a: [[3, 10]], h: ['atkSpeedStack'], kw: '动力' },
    { id: 1120, r: 'epic', a: [[1, 18, 'percent'], [6, 1.5]], h: ['block', 'thorns'], kw: '先锋' },
    { id: 1123, r: 'epic', a: [[3, 14, 'percent'], [6, 1.5], [25, 9, 'add']], h: ['killStackAtk'], kw: '萃取' },
    { id: 1125, r: 'epic', a: [[3, 14, 'percent'], [4, 15, 'add'], [25, 9, 'add']], kw: '狂热' },
    { id: 1130, r: 'epic', a: [[7, 20, 'add'], [12, -20, 'add']], h: ['magicBarrier'], kw: '微光' },
    { id: 1132, r: 'epic', a: [[3, 12, 'percent'], [6, 1.5], [25, 9, 'add']], h: ['killHeal'], kw: '祭品' },
    { id: 1139, r: 'epic', a: [[3, 16, 'percent'], [1, 20, 'percent']], h: ['takeStackAtk', 'lastStand'], kw: '臂章' },
    { id: 1140, r: 'epic', a: [[3, 16, 'percent'], [4, 15, 'add']], h: ['hitFlat', 'silenceProc'], kw: '净魂' },
    { id: 1141, r: 'epic', a: [[3, 14, 'percent'], [1, 18, 'percent']], h: ['killStackAtk'], kw: '支配' },
    { id: 1142, r: 'epic', a: [[3, 16, 'percent'], [4, 12, 'add']], h: ['pierce', 'chain'], kw: '阵列' },
    { id: 1146, r: 'epic', a: [[3, 14, 'percent'], [1, 18, 'percent'], [7, 15, 'add']], h: ['lowHpGuard'], kw: '裹布' },
    { id: 1148, r: 'epic', a: [[3, 14, 'percent'], [1, 18, 'percent'], [6, 1.5]], h: ['killHeal'], kw: '灵瓮' },
    { id: 1151, r: 'epic', a: [[3, 16, 'percent'], [1, 145]], h: ['stunProc', 'execute'], kw: '碎颅' },
    { id: 1152, r: 'epic', a: [[3, 16, 'percent'], [8, 9, 'add']], h: ['chain', 'hitPct'], kw: '漩涡' },
    { id: 1156, r: 'epic', a: [[3, 16, 'percent'], [7, 15, 'add']], h: ['magicBarrier', 'silenceProc'], kw: '克星' },
    { id: 1163, r: 'epic', a: [[1, 20, 'percent'], [6, 1.5]], h: ['block', 'regenTick'], kw: '赤红' },
    { id: 1165, r: 'epic', a: [[1, 20, 'percent'], [6, 1.5]], h: ['regenTick', 'lastStand'], kw: '清莲' },
    { id: 1166, r: 'epic', a: [[1, 20, 'percent'], [7, 20, 'add'], [12, -15, 'add']], h: ['lowHpGuard', 'magicBarrier'], kw: '法衣' },
    { id: 1171, r: 'epic', a: [[1, 20, 'percent'], [7, 15, 'add'], [11, 10, 'add']], h: ['frost', 'killCdr'], kw: '慧散' },
    { id: 1172, r: 'epic', a: [[3, 16, 'percent'], [4, 15, 'add']], h: ['atkSpeedStack', 'killCdr'], kw: '夜慧' },
    { id: 1173, r: 'epic', a: [[3, 16, 'percent'], [4, 16, 'add']], h: ['atkSpeedStack', 'phaseBuff'], kw: '气宇' },
    { id: 1178, r: 'epic', a: [[3, 16, 'percent'], [4, 26, 'add']], h: ['critEcho', 'pierce'], kw: '分身（追加一击）' },
    { id: 1179, r: 'epic', a: [[1, 20, 'percent'], [16, 70]], h: ['pierce', 'execute'], kw: '神枪' },
    { id: 1184, r: 'epic', a: [[3, 16, 'percent'], [1, 20, 'percent']], h: ['killCdr', 'regenTick'], kw: '牧杖' },
    { id: 1186, r: 'epic', a: [[3, 16, 'percent'], [1, 20, 'percent'], [9, 0.22]], h: ['shieldCharge', 'killCdr'], kw: '护盾爆发（受击护盾）' },
    { id: 1192, r: 'epic', a: [[14, 14, 'add'], [15, 225, 'best'], [7, 12, 'add']], h: ['hexProc'], kw: '妖术' },
    { id: 1199, r: 'epic', a: [[3, 16, 'percent'], [9, 0.22], [4, 15, 'add']], h: ['firstStrike', 'silenceProc'], kw: '白银' },
    { id: 1204, r: 'epic', a: [[3, 16, 'percent'], [6, 1.5], [9, 0.22]], h: ['thorns', 'lowHpGuard'], kw: '帕拉斯玛' },
    { id: 1205, r: 'rare', a: [[3, 10]], h: ['splash'], kw: '斥散' },
    { id: 1209, r: 'epic', a: [[3, 16, 'percent'], [9, 0.22], [16, 60]], h: ['killHeal', 'regenTick'], kw: '生机（击杀回血）' },
    { id: 1242, r: 'epic', a: [[14, 10, 'add'], [15, 225, 'best']], h: ['stunProc'], kw: '重锤' },
    { id: 1244, r: 'epic', a: [[8, 6, 'add']], h: ['evadeCounter'], kw: '闪避' },
    { id: 1253, r: 'epic', a: [[7, 25, 'add'], [12, -15, 'add']], h: ['nearDeath'], kw: '魔免' },
    { id: 1268, r: 'epic', a: [[4, 25, 'add']], h: ['atkSpeedStack'], kw: '迅速' },
    { id: 1274, r: 'epic', a: [[4, 12, 'add']], h: ['charge'], kw: '狂热' },
    { id: 1281, r: 'epic', a: [[3, 12, 'percent'], [25, 9, 'add']], h: ['killHeal'], kw: '吸血鬼' },
    { id: 1289, r: 'epic', a: [[3, 12, 'percent'], [11, 10, 'add']], h: ['killCdr'], kw: '释放' },
    { id: 1292, r: 'epic', a: [[4, 15, 'add'], [12, 10, 'add']], h: ['hitPct'], kw: '癫狂（代价：受到伤害 +10%）' },

    /* ----- 2026-10 补：`scope=both` 的 28 件（黄档 6 件）----- */
    { id: 1086, r: 'epic', a: [[8, 6, 'add']], h: ['evadeCounter'], kw: '闪避' },
    { id: 1126, r: 'epic', a: [[14, 10, 'add']], h: ['critEcho'], kw: '暴击' },
    { id: 1188, r: 'epic', a: [[3, 14, 'percent'], [25, 9, 'add']], h: ['killHeal'], kw: '吸血' },
    { id: 1189, r: 'epic', a: [[1, 20, 'percent'], [9, 0.22]], h: ['regenTick'], kw: '巨兽之血' },
    { id: 1191, r: 'epic', a: [[4, 25, 'add'], [6, 1.5]], h: ['atkSpeedStack'], kw: '攻速光环' },
    { id: 1193, r: 'epic', a: [[3, 14, 'percent'], [7, 15, 'add']], h: ['hitPct'], kw: '以太冲击' },

    /* ===== 蓝档（固定值属性 + 1 个轻钩子） · 80 件 ===== */
    { id: 3, r: 'rare', a: [[3, 10]], h: ['ignite'], kw: '点燃' },
    { id: 4, r: 'rare', a: [[1, 145]], h: ['takeHeal'], kw: '血量' },
    { id: 1005, r: 'rare', a: [[1, 90], [3, 10]], h: ['hitPct'], kw: '智力' },
    { id: 1013, r: 'rare', a: [[2, 60], [10, 0.14]], h: ['killMana'], kw: '法力' },
    { id: 1014, r: 'rare', a: [[3, 8], [6, 1]], h: ['armorBreak'], kw: '腐蚀' },
    { id: 1015, r: 'rare', a: [[3, 8]], h: ['poison'], kw: '剧毒' },
    { id: 1030, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['pierce'], kw: '穿刺' },
    { id: 1041, r: 'rare', a: [[1, 90], [3, 10]], h: ['hitPct'], kw: '法伤' },
    { id: 1058, r: 'rare', a: [[1, 90], [6, 1]], h: ['regenTick'], kw: '自修' },
    { id: 1059, r: 'rare', a: [[3, 10]], h: ['phaseBuff'], kw: '战旗' },
    { id: 1061, r: 'rare', a: [[1, 90], [9, 0.14]], h: ['killHeal'], kw: '补给' },
    { id: 1063, r: 'rare', a: [[3, 8], [1, 90]], h: ['killBoom'], kw: '爆裂' },
    { id: 1070, r: 'rare', a: [[3, 8], [1, 90]], h: ['takeHeal'], kw: '仙火' },
    { id: 1072, r: 'rare', a: [[2, 60]], h: ['killExpFlat'], kw: '启迪（经济）' },
    { id: 1079, r: 'rare', a: [[2, 60], [10, 0.14]], h: ['killCdr'], kw: '刷新' },
    { id: 1088, r: 'rare', a: [[3, 10]], h: ['charge'], kw: '振奋' },
    { id: 1090, r: 'rare', a: [[1, 145], [6, 1.2]], h: ['takeStackAtk'], kw: '极限' },
    { id: 1091, r: 'rare', a: [[6, 1.2]], h: ['firstStrike'], kw: '鹰眼' },
    { id: 1093, r: 'rare', a: [[1, 90], [3, 10]], h: ['hitFlat'], kw: '秘法' },
    { id: 1094, r: 'rare', a: [[3, 10]], h: ['execute'], kw: '神圣' },
    { id: 1095, r: 'rare', a: [[3, 8], [1, 90]], h: ['freezeProc'], kw: '冰封' },
    { id: 1098, r: 'rare', a: [[1, 90], [9, 0.14]], h: ['regenTick'], kw: '回复' },
    { id: 1100, r: 'rare', a: [[3, 10], [1, 110]], h: ['takeStackAtk'], kw: '护腕' },
    { id: 1101, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['hitFlat'], kw: '怨灵' },
    { id: 1105, r: 'rare', a: [[3, 10], [1, 110]], h: ['killHeal'], kw: '灵龛' },
    { id: 1107, r: 'rare', a: [[1, 145]], h: ['killBoom'], kw: '口袋肉山' },
    { id: 1109, r: 'rare', a: [[3, 10], [1, 110]], h: ['firstStrike'], kw: '猎鹰' },
    { id: 1111, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['shieldCharge'], kw: '护盾充能' },
    { id: 1116, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['evadeCounter'], kw: '相位' },
    { id: 1117, r: 'rare', a: [[1, 90], [2, 60]], h: ['killMana'], kw: '秘法' },
    { id: 1119, r: 'rare', a: [[3, 10], [1, 145]], h: ['phaseBuff'], kw: '战鼓' },
    { id: 1121, r: 'rare', a: [[1, 90], [3, 10]], h: ['silenceProc'], kw: '纷争' },
    { id: 1122, r: 'rare', a: [[1, 145], [9, 0.14]], h: ['regenTick'], kw: '梅肯' },
    { id: 1127, r: 'rare', a: [[1, 90], [3, 10]], h: ['killCdr'], kw: '慧光' },
    { id: 1128, r: 'rare', a: [[1, 100], [9, 0.14]], h: ['frost'], kw: '散华' },
    { id: 1129, r: 'rare', a: [[3, 10]], h: ['atkSpeedStack'], kw: '夜叉' },
    { id: 1133, r: 'rare', a: [[1, 145]], h: ['takeHeal'], kw: '原力' },
    { id: 1134, r: 'rare', a: [[1, 145], [3, 10]], h: ['takeHeal'], kw: '圣洁' },
    { id: 1135, r: 'rare', a: [[1, 145]], h: ['slowAura'], kw: '迟缓' },
    { id: 1143, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['atkSpeedStack'], kw: '炎阳' },
    { id: 1144, r: 'rare', a: [[3, 10], [1, 145]], h: ['killMana'], kw: '灵匣' },
    { id: 1145, r: 'rare', a: [[3, 10], [9, 0.14]], h: ['magicBarrier'], kw: '圣杖' },
    { id: 1147, r: 'rare', a: [[3, 10], [9, 0.14]], h: ['splash'], kw: '回音' },
    { id: 1149, r: 'rare', a: [[3, 10]], h: ['ignite'], kw: '巫师' },
    { id: 1150, r: 'rare', a: [[3, 10], [9, 0.14]], h: ['stunProc'], kw: '陨星' },
    { id: 1154, r: 'rare', a: [[1, 100]], h: ['takeHeal'], kw: '魂匣' },
    { id: 1158, r: 'rare', a: [[3, 10], [1, 90]], h: ['silenceProc'], kw: '紫怨' },
    { id: 1162, r: 'rare', a: [[3, 10], [1, 90]], h: ['magicBarrier'], kw: '洞察' },
    { id: 1170, r: 'rare', a: [[3, 10], [1, 100]], h: ['frost'], kw: '双剑' },
    { id: 1174, r: 'rare', a: [[3, 10], [1, 100]], h: ['silenceProc'], kw: '否决' },
    { id: 1175, r: 'rare', a: [[3, 10]], h: ['chain'], kw: '飓风' },
    { id: 1176, r: 'rare', a: [[1, 100], [6, 1.2]], h: ['block'], kw: '卫士' },
    { id: 1182, r: 'rare', a: [[3, 10], [9, 0.14]], h: ['slowAura'], kw: '渔叉' },
    { id: 1196, r: 'rare', a: [[3, 10], [1, 145]], h: ['hitFlat'], kw: '坎达' },
    { id: 1212, r: 'rare', a: [[3, 8], [9, 0.14]], h: ['tickStackAtk'], kw: '仪式' },
    { id: 1213, r: 'rare', a: [[3, 8], [1, 90]], h: ['hitFlat'], kw: '浸染' },
    { id: 1226, r: 'rare', a: [[1, 90], [9, 0.14]], h: ['regenTick'], kw: '种籽' },
    { id: 1231, r: 'rare', a: [[3, 8], [6, 1]], h: ['immolate'], kw: '献祭' },
    { id: 1233, r: 'rare', a: [[3, 8], [9, 0.14]], h: ['chain'], kw: '风暴' },
    { id: 1236, r: 'rare', a: [[3, 8], [1, 90]], h: ['armorBreak'], kw: '开膛' },
    { id: 1241, r: 'rare', a: [[3, 8], [6, 1]], h: ['critEcho'], kw: '回响' },
    { id: 1252, r: 'rare', a: [[3, 8], [9, 0.14]], h: ['stunProc'], kw: '天崩' },
    { id: 1257, r: 'rare', a: [[3, 8], [1, 90]], h: ['lowHpGuard'], kw: '棱晶' },
    { id: 1259, r: 'rare', a: [[1, 145], [6, 1]], h: ['lastStand'], kw: '不朽' },
    { id: 1267, r: 'rare', a: [[3, 10], [16, 60]], h: ['execute'], kw: '高远' },
    { id: 1269, r: 'rare', a: [[3, 10]], h: ['hitPct'], kw: '冒险' },

    /* ----- 2026-10 补：`scope=both` 的 28 件（蓝档 8 件）----- */
    { id: 1087, r: 'rare', a: [[6, 1.2]], h: ['block'], kw: '格挡' },
    { id: 1089, r: 'rare', a: [[3, 8]], h: ['firstStrike'], kw: '先手' },
    { id: 1092, r: 'rare', a: [[1, 110]], h: ['killHeal'], kw: '掠夺' },
    { id: 1124, r: 'rare', a: [[16, 60]], h: ['hitFlat'], kw: '长枪' },
    { id: 1167, r: 'epic', a: [[3, 14, 'percent'], [9, 0.22]], h: ['splash'], kw: '分裂' },
    { id: 1168, r: 'rare', a: [[1, 145]], h: ['magicBarrier'], kw: '法术屏障' },
    { id: 1177, r: 'rare', a: [[6, 1.2]], h: ['slowAura'], kw: '冰霜光环' },
    { id: 1187, r: 'epic', a: [[3, 14, 'percent'], [16, 60]], h: ['pierce'], kw: '穿刺' },
    { id: 1278, r: 'rare', a: [[2, 60], [10, 0.14]], h: ['killCdr'], kw: '睿智' },
    { id: 1279, r: 'rare', a: [[3, 10]], h: ['phaseBuff'], kw: '永恒' },
    { id: 1283, r: 'rare', a: [[1, 145], [6, 1.2]], h: ['tickStackAtk'], kw: '进化' },
    { id: 1284, r: 'rare', a: [[3, 10], [6, 1.2]], h: ['takeStackAtk'], kw: '巨神' },
    { id: 1286, r: 'rare', a: [[3, 8], [1, 90]], h: ['killStackAtk'], kw: '主导' },
    { id: 1287, r: 'rare', a: [[1, 90], [9, 0.14]], h: ['regenTick'], kw: '恢复' },

    /* ===== 白档（纯固定值属性，1~2 项） · 107 件 ===== */
    { id: 1, r: 'common', a: [[6, 1.2]], kw: '反伤' },
    { id: 1001, r: 'common', a: [[3, 8]], kw: '压制' },
    { id: 1002, r: 'common', a: [[6, 1]], kw: '格挡' },
    { id: 1006, r: 'common', a: [[1, 90], [6, 1]], kw: '血甲' },
    { id: 1008, r: 'common', a: [[1, 90], [9, 0.14]], kw: '血回' },
    { id: 1009, r: 'common', a: [[9, 0.14]], kw: '回血' },
    { id: 1010, r: 'common', a: [[2, 40], [10, 0.14]], kw: '回蓝' },
    { id: 1011, r: 'common', a: [[9, 0.14]], kw: '挡法' },
    { id: 1012, r: 'common', a: [[16, 50]], kw: '追猎' },
    { id: 1018, r: 'common', a: [[6, 1.2]], kw: '护甲' },
    { id: 1020, r: 'common', a: [[1, 120], [6, 1]], kw: '血甲' },
    { id: 1024, r: 'common', a: [[16, 50]], kw: '蓄势' },
    { id: 1027, r: 'common', a: [[9, 0.14]], kw: '回血' },
    { id: 1028, r: 'common', a: [[1, 110]], kw: '溅射' },
    { id: 1029, r: 'common', a: [[3, 10]], kw: '攻击' },
    { id: 1035, r: 'common', a: [[6, 1.2]], kw: '护甲' },
    { id: 1036, r: 'common', a: [[1, 110], [9, 0.14]], kw: '耐久' },
    { id: 1038, r: 'common', a: [[1, 120], [6, 1]], kw: '血甲' },
    { id: 1039, r: 'common', a: [[1, 145], [9, 0.14]], kw: '血牛' },
    { id: 1040, r: 'common', a: [[6, 1.2]], kw: '护甲' },
    { id: 1042, r: 'common', a: [[3, 10]], kw: '连锁' },
    { id: 1043, r: 'common', a: [[3, 10], [6, 1.2]], kw: '重剑' },
    { id: 1046, r: 'common', a: [[1, 145], [9, 0.14]], kw: '回血' },
    { id: 1047, r: 'common', a: [[9, 0.14]], kw: '回血' },
    { id: 1056, r: 'common', a: [[3, 8], [1, 90]], kw: '续命' },
    { id: 1057, r: 'common', a: [[3, 8], [1, 90]], kw: '补给' },
    { id: 1060, r: 'common', a: [[1, 90]], kw: '狂石' },
    { id: 1067, r: 'common', a: [[3, 8]], kw: '突袭' },
    { id: 1069, r: 'common', a: [[3, 8], [9, 0.14]], kw: '净化（攻击回复）' },
    { id: 1071, r: 'common', a: [[2, 40], [9, 0.14]], kw: '芒果' },
    { id: 1075, r: 'common', a: [[1, 90], [9, 0.14]], kw: '药膏（攻击回复）' },
    { id: 1078, r: 'common', a: [[1, 110], [9, 0.14]], kw: '奶酪（攻击回复）' },
    { id: 1082, r: 'common', a: [[1, 90]], kw: '柔软' },
    { id: 1083, r: 'common', a: [[2, 45]], kw: '能量' },
    { id: 1085, r: 'common', a: [[1, 145]], kw: '精气' },
    { id: 1096, r: 'common', a: [[6, 1]], kw: '反伤' },
    { id: 1097, r: 'common', a: [[9, 0.14]], kw: '王者' },
    { id: 1099, r: 'common', a: [[1, 90]], kw: '充能' },
    { id: 1102, r: 'common', a: [[9, 0.14]], kw: '挂件' },
    { id: 1103, r: 'common', a: [[3, 10], [1, 110]], kw: '魔瓶' },
    { id: 1104, r: 'common', a: [[1, 110], [6, 1.2]], kw: '魂戒' },
    { id: 1106, r: 'common', a: [[1, 110], [9, 0.14]], kw: '静谧' },
    { id: 1108, r: 'common', a: [[3, 10]], kw: '腐蚀' },
    { id: 1110, r: 'common', a: [[1, 145], [9, 0.14]], kw: '丰饶' },
    { id: 1113, r: 'common', a: [[1, 145], [9, 0.14]], kw: '坚韧' },
    { id: 1118, r: 'common', a: [[3, 10], [9, 0.14]], kw: '空明' },
    { id: 1136, r: 'common', a: [[9, 0.14], [16, 30]], kw: '以太' },
    { id: 1210, r: 'common', a: [[3, 8], [6, 1]], kw: '碎屑' },
    { id: 1211, r: 'common', a: [[3, 8], [1, 90]], kw: '吸血垫' },
    { id: 1214, r: 'common', a: [[3, 8]], kw: '决斗' },
    { id: 1215, r: 'common', a: [[1, 90], [9, 0.14]], kw: '护符' },
    { id: 1216, r: 'common', a: [[3, 8], [26, 1]], kw: '举杯' },
    { id: 1217, r: 'common', a: [[1, 90]], kw: '潜能' },
    { id: 1218, r: 'common', a: [[3, 8]], kw: '骰子' },
    { id: 1219, r: 'common', a: [[3, 8], [6, 1]], kw: '盾墙垫' },
    { id: 1220, r: 'common', a: [[6, 1]], kw: '石羽' },
    { id: 1222, r: 'common', a: [[3, 8]], kw: '穷鬼盾' },
    { id: 1223, r: 'common', a: [[6, 1]], kw: '勇气垫' },
    { id: 1224, r: 'common', a: [[1, 90]], kw: '精华' },
    { id: 1225, r: 'common', a: [[3, 8]], kw: '跃迁' },
    { id: 1227, r: 'common', a: [[3, 8]], kw: '护壳' },
    { id: 1228, r: 'common', a: [[3, 8], [9, 0.14]], kw: '法力垫' },
    { id: 1229, r: 'common', a: [[3, 8], [1, 90]], kw: '致残垫' },
    { id: 1230, r: 'common', a: [[3, 8]], kw: '炽热' },
    { id: 1232, r: 'common', a: [[2, 40], [27, 1]], kw: '通灵（攻击回蓝）' },
    { id: 1234, r: 'common', a: [[3, 8]], kw: '不倦垫' },
    { id: 1235, r: 'common', a: [[3, 8]], kw: '火药垫' },
    { id: 1237, r: 'common', a: [[3, 8], [1, 90]], kw: '授粉垫' },
    { id: 1238, r: 'common', a: [[2, 45], [27, 1]], kw: '咏咒（攻击回蓝）' },
    { id: 1239, r: 'common', a: [[3, 8]], kw: '烙印垫' },
    { id: 1240, r: 'common', a: [[3, 8]], kw: '蒲公英垫' },
    { id: 1243, r: 'common', a: [[6, 1]], kw: '化蛹垫' },
    { id: 1245, r: 'common', a: [[3, 8], [26, 1]], kw: '嗜血垫' },
    { id: 1246, r: 'common', a: [[3, 8]], kw: '残留垫' },
    { id: 1247, r: 'common', a: [[2, 45]], kw: '附魔' },
    { id: 1248, r: 'common', a: [[3, 8]], kw: '触媒垫' },
    { id: 1249, r: 'common', a: [[3, 8], [6, 1]], kw: '黯灭垫' },
    { id: 1250, r: 'common', a: [[16, 50]], kw: '疾行' },
    { id: 1251, r: 'common', a: [[3, 8]], kw: '召唤垫' },
    { id: 1254, r: 'common', a: [[3, 8]], kw: '巫毒垫' },
    { id: 1255, r: 'common', a: [[1, 90]], kw: '血仪' },
    { id: 1256, r: 'common', a: [[3, 8]], kw: '圣衣' },
    { id: 1258, r: 'common', a: [[9, 0.14]], kw: '协和' },
    { id: 1270, r: 'common', a: [[9, 0.14]], kw: '神秘' },
    { id: 1271, r: 'common', a: [[3, 8]], kw: '警觉垫' },
    { id: 1272, r: 'common', a: [[1, 90], [9, 0.14]], kw: '壮实' },
    { id: 1273, r: 'common', a: [[3, 8], [6, 1]], kw: '坚强垫' },
    { id: 1275, r: 'common', a: [[16, 50]], kw: '捷足' },
    { id: 1276, r: 'common', a: [[3, 8], [1, 90]], kw: '粗暴垫' },
    { id: 1277, r: 'common', a: [[3, 8], [16, 40]], kw: '无边' },
    { id: 1282, r: 'common', a: [[9, 0.14], [16, 30]], kw: '犀利' },
    { id: 1285, r: 'common', a: [[3, 8], [16, 30]], kw: '凶猛垫' },
    { id: 1288, r: 'common', a: [[1, 90], [6, 1]], kw: '厚实' },
    { id: 1290, r: 'common', a: [[1, 90], [9, 0.14]], kw: '活力' },
    { id: 1291, r: 'common', a: [[3, 8], [1, 90]], kw: '笨重垫' },
    { id: 1293, r: 'common', a: [[16, 50]], kw: '轻快' },

    /* ----- 2026-10 补：`scope=both` 的 28 件（白档 11 件）----- */
    { id: 1003, r: 'common', a: [[1, 90], [9, 0.14]], kw: '力量' },
    { id: 1004, r: 'common', a: [[3, 8]], kw: '敏捷' },
    { id: 1007, r: 'common', a: [[6, 1]], kw: '守护' },
    { id: 1016, r: 'common', a: [[3, 8]], kw: '利爪' },
    { id: 1017, r: 'common', a: [[1, 120]], kw: '腰带' },
    { id: 1023, r: 'common', a: [[6, 1.2]], kw: '锁甲' },
    { id: 1026, r: 'common', a: [[1, 90], [9, 0.14]], kw: '恢复' },
    { id: 1037, r: 'common', a: [[3, 10]], kw: '阔剑' },
    { id: 1045, r: 'common', a: [[3, 13]], kw: '秘银' },
    { id: 1068, r: 'common', a: [[1, 90]], kw: '树枝' },
    { id: 1084, r: 'common', a: [[1, 145]], kw: '活力' },

];

/* =====================================================================================
 * 四、派生层（**生成器与落表脚本共用这一份**，别各写一份 —— 文案/数值一旦有两份实现就会漂移）
 * ===================================================================================== */

/** 落表 id 段：钩子行 200 起（顺序 = `HOOKS` 数组顺序）、钩子要施加的减益/DoT 行 300 起 */
export const HOOK_MOD_BASE = 200;
export const DEBUFF_MOD_BASE = 300;

/**
 * 钩子 → `modifiers.json` 行 id。
 * 顺序敏感：`HOOKS` 里插一条/删一条都会让后面的 id 平移，
 * 所以**改完必须重跑 `npm run gen:relic-hooks` 再跑落表**（两个脚本都读这一个函数）。
 */
export function hookModId(hookId) {
    const i = HOOKS.findIndex(h => h.id === hookId);
    if (i < 0) throw new Error(`未定义的钩子：${hookId}`);
    return HOOK_MOD_BASE + i;
}

/**
 * 钩子的「周期伤害」行 id（点燃 / 中毒）—— `tick_damage` **不支持 var**，
 * 每秒伤害只能按品质烘在行里，所以施加方要用 `kv.dotMod` 告诉脚本用哪一行。
 */
export const DOT_MOD = {
    ignite: { rare: 306, epic: 307, legendary: 308 },
    poison: { rare: 309, epic: 310, legendary: 311 },
};

/** 钩子按品质取 kv（配表落表用）；点燃/中毒额外带 `dotMod` */
export function hookKv(hookId, rarity) {
    const hook = HOOK_BY_ID[hookId];
    if (!hook) throw new Error(`未定义的钩子：${hookId}`);
    const values = hook.tier[rarity];
    if (!values) throw new Error(`钩子 ${hookId} 没有 ${rarity} 档数值`);
    const dot = DOT_MOD[hookId];
    return dot ? { ...values, dotMod: dot[rarity] } : { ...values };
}

/**
 * 由「钩子行 id + 品质」反查该钩子的文案（品质门禁体检用）。
 *
 * 为什么需要：钩子文案里会出现「攻击速度 +2%」「攻击力 +1%」这类字样，
 * 但那是**钩子效果的描述**，不是"这件遗物在本档位承诺了一条越档属性"。
 * 门禁的描述解析器分不清这两者，会把它们误报成"档位不允许的属性词条"，
 * 所以体检时先按这个函数把**钩子文案原样剥掉**、再解析属性词条。
 */
export function hookTextByModId(modId, rarity) {
    const i = modId - HOOK_MOD_BASE;
    if (!(i >= 0 && i < HOOKS.length)) return null;
    const hook = HOOKS[i];
    const values = hook.tier[rarity];
    return values ? hook.txt(values) : null;
}

/** 把 `SUPPLY_TOPUP` 应用到逐件设计上（**最终表**）：值覆盖 / 追加 / except 保留原值 */
export function applySupplyTopup(items = ITEMS) {
    const out = items.map((it) => ({ ...it, a: (it.a ?? []).map((e) => [...e]) }));
    for (const [key, rule] of Object.entries(SUPPLY_TOPUP)) {
        const attr = Number(key);
        const extra = new Set(rule.add ?? []);
        const except = new Set(rule.except ?? []);
        for (const it of out) {
            const idx = it.a.findIndex((e) => e[0] === attr);
            const wanted = extra.has(it.id);
            if (idx < 0 && !wanted) continue;
            if (except.has(it.id)) continue;
            const v = rule[it.r];
            if (v === undefined) continue;
            if (idx >= 0) it.a[idx] = [attr, v, ...(it.a[idx].length > 2 ? [it.a[idx][2]] : [])];
            else it.a.push([attr, v]);
        }
    }
    return out;
}

/** 最终逐件表（供给配平之后）—— 生成器与落表脚本的唯一输入 */
export function resolveFinalItems() {
    return applySupplyTopup(ITEMS);
}

/* ---------------- 文案（属性 + 钩子 → 一句话），评审稿与配表 `description_inner` 共用 ---------------- */

/** 一条属性条目的文案 */
export function attrText([id, value, mode]) {
    const cn = ATTR_CN[id] ?? `属性${id}`;
    const percentType = PERCENT_ATTRS.has(id);
    const pctMode = mode === 'percent';
    if (id === 15) return `暴击倍率 ${value}%`;
    if (percentType) {
        const sign = value >= 0 ? '+' : '-';
        const abs = Math.abs(value);
        if (id === 12) return value < 0 ? `受到的伤害 ${sign}${abs}%（物理与法术都减）` : `受到的伤害 ${sign}${abs}%`;
        if (id === 21) return `金币获取 ${sign}${abs}%`;
        if (id === 22) return `经验获取 ${sign}${abs}%`;
        if (id === 23) return `技能冷却 -${abs}%`;
        if (id === 24) return `遗物抽取费用 -${abs}%`;
        return `${cn} ${sign}${abs}%`;
    }
    if (pctMode) return `${cn} +${value}%`;
    if (id === 9 || id === 10) return `${cn} +${value}/秒`;
    return `${cn} +${value}`;
}

/** 属性列表 → 分号串联的文案 */
export function attrListText(attrs) {
    return (attrs ?? []).map(attrText).join('；');
}

/** 解析一条钩子（`h` 里可以是 id，也可以是 `[id, '档位']` 覆盖档位） */
export function resolveHook(entry, rarity) {
    const [id, tierOverride] = Array.isArray(entry) ? entry : [entry, null];
    const hook = HOOK_BY_ID[id];
    if (!hook) return { hook: null, id, tier: null, values: null, error: `未定义的钩子 ${id}` };
    const tier = tierOverride ?? rarity;
    const values = hook.tier[tier];
    if (!values) return { hook, id, tier, values: null, error: `钩子 ${id} 没有 ${tier} 档数值` };
    return { hook, id, tier, values, error: null };
}

/** 一条钩子的文案（按本件品质取档位数值） */
export function hookText(entry, rarity) {
    const { hook, values, error } = resolveHook(entry, rarity);
    if (error) return `⚠${error}`;
    return hook.txt(values);
}

/** 整件遗物的 `description_inner`（属性在前、钩子在后，分号串联） */
export function descriptionOf(item) {
    const parts = [];
    const attrs = attrListText(item.a);
    if (attrs) parts.push(attrs);
    for (const h of item.h ?? []) parts.push(hookText(h, item.r));
    return parts.join('；');
}
