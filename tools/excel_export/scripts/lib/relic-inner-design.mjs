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
 * 品质池深与预算（2026-10 定案：**池深比例 4:3:2:1** —— 白 107 / 蓝 80 / 黄 54 / 红 27）。
 * 口径：白 = 纯属性垫底（池子最厚、认人不认效果），蓝 = 固定值 + 1 个轻钩子，
 *       黄 = 百分比 / 百分比型属性 + 1~2 钩子，红 = 大百分比 + 功能属性 + 2~3 钩子（每件都是流派核心）。
 *
 * ⚠ **2026-11：预算列写的是"单属性满额值"**（= `ATTR_VALUE[tier][attr].v`），
 *   实际值还要乘 `SHARE[属性条数]`（一件两条属性 ⇒ 每条 0.75×）。这张表是给人读的摘要，
 *   **真源是 `ATTR_VALUE` + `SHARE` + `MAX_ATTRS_PER_RELIC` 三张表**（改预算改那里，别改这里）。
 */
export const RARITY_PLAN = {
    common: { pool: 107, cn: '白', hooks: 0, attrs: '固定值 1~3 项（**同档内属性集合互不重复**）', budget: '**1 份预算**：单属性满额 攻击 +13 / 生命 +140 / 护甲 +3.5 / 回血 +0.15 / 魔法 +20 / 攻距 +16；多一条属性就按 `SHARE` 摊薄（双 0.75× / 三 0.6×）' },
    rare: { pool: 80, cn: '蓝', hooks: 1, attrs: '固定值 1~3 项（同白档，单属性值略高）', budget: '白档 ×1.4 左右：单属性满额 攻击 +20 / 生命 +200 / 护甲 +5.5 / 回血 +0.1 / 魔法 +30 / 攻距 +20 + 1 个轻钩子' },
    epic: { pool: 54, cn: '黄', hooks: '1~2', attrs: '百分比 或 百分比型属性（攻速/闪避/暴击率/魔抗/受伤/增伤）', budget: '单属性满额 攻击 +21% / 生命 +26% / 攻速 +40 / 魔抗 +20 / 闪避 +13 / 暴击率 +22 / 受伤 −22 / 增伤 +16（按条数摊薄）' },
    legendary: { pool: 27, cn: '红', hooks: '2~3', attrs: '大百分比 + 功能属性（金币/经验/冷却/抽卡折扣）', budget: '单属性满额 攻击 +42% / 生命 +52% / 攻速 +62 / 暴击倍率 225（best，不摊薄）/ 功能百分比 +26~60；**每件都是流派核心**' },
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
 * ⚠ **2026-11 起它只做一件事：把这条属性"配给"名单里的件**（不再覆盖任何值）。
 *
 * 为什么改：以前它是「把该属性在**所有**件上的值统一覆盖成该品质的供给值」+「往名单里的件上追加一条」。
 * 覆盖那条**看着像好事**（同档同属性同值），实际制造了两个真问题：
 *   ① **支配关系**：被追加的件属性条数会涨到 4~6 条，而**每条都还是满额** ——
 *      于是一件 6 条属性的件在数值上全面压过 2 条属性的件（`1123 萃取` ⊇ `1132 祭品` 就是这么来的），
 *      玩家在 4 格商店里"肯定选那一件"；
 *   ② **值被埋掉**：设计真源里手写的值（`[6, 1.5]`）被悄悄改成 10，改表的人看不出自己写的数没用。
 * 现在：**哪些件带这条属性**由本表决定（`add` = 追加成设计属性），**值一律由
 * `ATTR_VALUE[tier][attr] × SHARE[属性条数]` 算**（见下）—— 供给与数值是两件分开的事。
 *
 * 规则：`{ common/rare/epic/legendary: 值（保留作"该档的供给参考值"，不再写进表）, add: [追加的遗物 id], except: [...] }`
 *   · `add` 里的件 → 没有该属性就**追加一条**（属性条数上限 `MAX_ATTRS_PER_RELIC`，满了就跳过）；
 *   · `except` → 这件不加（如 1292 癫狂 的"受到伤害 +10%"是它的代价，不能被减伤顶掉）。
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
 * 二之三：值的唯一出处 —— 「一件 = 一份预算，摊到几条属性上就按条数打折」
 * ===================================================================================== */

/**
 * **一件遗物的收益属性条数上限**。
 *
 * 判据来自用户口径（2026-11）："右边 3 件都是攻击 +8，中间那件还多一条加成，那肯定选中间那件"
 * —— 一件的属性条数**没有上限**时，条数多的那件只要每条都满额，就必然支配条数少的件。
 * 所以：① 条数封顶 3（与"一件最多 3 个钩子"对称）；② 每条的值随条数**递减**（`SHARE`）。
 * 两条合起来 ⇒ **同品质内不可能存在"逐属性支配"的两件**（证明见 `SHARE` 的注释）。
 */
export const MAX_ATTRS_PER_RELIC = 3;

/**
 * **条数摊薄系数**：一条属性的最终值 = `ATTR_VALUE[tier][attr] × SHARE[条数]`。
 *
 * 为什么这么定：本作的白/蓝档只有 9 条固定值属性可用（1 生命 / 2 魔法 / 3 攻击 / 6 护甲 /
 * 9 回血 / 10 回蓝 / 16 攻距 / 26 攻回 / 27 攻蓝），而"每件效果都不一样"要求属性集合互不重复
 * ⇒ 107 件里绝大多数必须是 2~3 条属性 ⇒ **每条必须比"只有它一条"的件更薄**，否则
 * "攻击力 +8 单条件"会被"攻击力 +8 且白送攻距 +30"的件全面压过（就是用户截图里那三格）。
 *
 * ⚠ 这张表**同时是无支配性的证明**：若 A 的属性集合 ⊇ B 的，则 A 的条数 ≥ B 的条数
 *   ⇒ A 在共享属性上的值 ≤ B 的（share 单调不增）⇒ A 不可能"每条都 ≥ B 且至少一条 >"。
 *   集合相同 ⇒ 值完全相同（`ATTR_VALUE` 只按档位给）⇒ 是"重复件"而不是"支配件"
 *   ⇒ 重复密度由生成器/门禁单独卡（白/蓝档同 profile ≤2 件）。
 */
export const SHARE = { 1: 1, 2: 0.75, 3: 0.6, 4: 0.5, 5: 0.45, 6: 0.4 };

/**
 * **不参与摊薄**的属性：15 暴击倍率的叠加方式是 `best`（取最强的一件），
 * 摊薄它等于"三条属性的暴击装反而更弱"，语义上说不通（且它不是"加法收益"）。
 */
export const NO_SHARE_ATTRS = new Set([15]);

/**
 * **代价件（有增有减）的收益加成**：一件带代价的遗物，收益按这个系数放大。
 *
 * 没有它，"代价件"就是"更差的件"（同样的收益还多一条负面）—— 没人会选，
 * 那 30~40% 的密度就白铺了。系数取 1.25~1.5：**收益明显更厚、代价真实可感**，
 * 但不至于"无视代价闭眼买"（代价轴见 `docs/relic-redesign/README.md` §1.2c）。
 */
export const COST_BOOST = { common: 1.5, rare: 1.4, epic: 1.3, legendary: 1.25 };

/**
 * **每档每属性的基准值**（= 该属性"单独出现"时的值）+ 该轴的叠加方式。
 *
 * 这是**全池数值的唯一出处**（`ITEMS` 里只写"这件有哪几条属性"，不再写字面值）：
 *   · 白/蓝 = 固定值（门禁：百分比与百分比型属性黄档起）；
 *   · 黄/红 = 数值属性走 `percent`（对基础属性乘算）、百分比型属性走 `add`（配置值 = 百分点）。
 *
 * 白/蓝的取值口径：**按"每件平均收益 ≈ 现网"校准**过的（不是拍脑袋）——
 * 现网白档 107 件里有 20 件完全相同的「攻击力 +8」、45 件是"两条都满额"，
 * 拆成"集合互不重复 + 条数摊薄"之后，单条件的值必须抬到 13（攻击）/140（生命）才能让
 * **每局抽到的期望收益**与现网持平（差额由 `tools/relic-redesign` 的供给表逐条打印）。
 */
export const ATTR_VALUE = {
    common: {
        1: { v: 140 }, 2: { v: 20 }, 3: { v: 13 }, 6: { v: 3.5 }, 9: { v: 0.15 },
        10: { v: 0.12 }, 16: { v: 16 }, 26: { v: 1 }, 27: { v: 1 },
    },
    rare: {
        1: { v: 200 }, 2: { v: 30 }, 3: { v: 20 }, 6: { v: 5.5 }, 9: { v: 0.1 },
        10: { v: 0.16 }, 16: { v: 20 }, 26: { v: 1 }, 27: { v: 1 },
    },
    epic: {
        1: { v: 26, mode: 'percent' }, 2: { v: 40 }, 3: { v: 21, mode: 'percent' },
        4: { v: 40, mode: 'add' }, 6: { v: 13, mode: 'add' }, 7: { v: 20, mode: 'add' },
        8: { v: 13, mode: 'add' }, 9: { v: 0.28 }, 10: { v: 0.18 },
        11: { v: 16, mode: 'add' }, 12: { v: -22, mode: 'add' }, 14: { v: 22, mode: 'add' },
        15: { v: 225, mode: 'best' }, 16: { v: 80, mode: 'add' },
        25: { v: 12, mode: 'add' }, 26: { v: 3 }, 27: { v: 3 },
    },
    legendary: {
        1: { v: 52, mode: 'percent' }, 2: { v: 80 }, 3: { v: 42, mode: 'percent' },
        4: { v: 62, mode: 'add' }, 6: { v: 21, mode: 'add' }, 7: { v: 32, mode: 'add' },
        8: { v: 20, mode: 'add' }, 9: { v: 0.42 }, 10: { v: 0.26 },
        11: { v: 24, mode: 'add' }, 12: { v: -36, mode: 'add' }, 14: { v: 30, mode: 'add' },
        15: { v: 225, mode: 'best' }, 16: { v: 90, mode: 'add' },
        21: { v: 26, mode: 'add' }, 22: { v: 26, mode: 'add' }, 23: { v: 40, mode: 'add' },
        24: { v: 60, mode: 'add' }, 25: { v: 20, mode: 'add' }, 26: { v: 4 }, 27: { v: 4 },
    },
};

/** 一条属性值的取整口径（回血/回蓝 2 位小数、护甲 1 位、其余取整且至少 1 —— 0 值等于"配了却没变"） */
export function roundAttrValue(attr, v) {
    if (attr === 9 || attr === 10) return Math.round(v * 100) / 100;
    if (attr === 6) return Math.round(v * 10) / 10;
    if (v < 0) return Math.round(v);
    return Math.max(1, Math.round(v));
}

/**
 * 一条属性的最终值。
 * @param {string} tier 品质（`common` / `rare` / `epic` / `legendary`）
 * @param {number} attr 属性 id
 * @param {number} count 这件遗物的**收益属性条数**（摊薄依据）
 * @param {boolean} [isCostItem] 是不是代价件（收益 × `COST_BOOST`）
 */
export function attrValueOf(tier, attr, count, isCostItem = false) {
    const def = ATTR_VALUE[tier]?.[attr];
    if (!def) throw new Error(`未登记属性值：${tier} / ${attr}（改属性集就要同步 ATTR_VALUE）`);
    const share = NO_SHARE_ATTRS.has(attr) ? 1 : (SHARE[count] ?? SHARE[MAX_ATTRS_PER_RELIC]);
    const boost = isCostItem ? (COST_BOOST[tier] ?? 1) : 1;
    return roundAttrValue(attr, def.v * share * boost);
}

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
        /**
         * ⚠ **半径口径（2026-11 用户定案）**：**所有"以目标为圆心"的爆炸类钩子，半径一律 50 像素**
         *   —— `splash` / `critEcho` / `killBoom` 三条同一套尺（它们共用一个渲染形态：命中点画一圈爆炸环）。
         *
         * 为什么从 120~160 砍到 50：英雄攻击距离只有 187~250（设计宽 750 的 1/4~1/3），
         *   而爆炸半径 120~160 意味着**一圈直径 240~320 的爆炸盖住了你大半个射程**，
         *   用户口径「攻击范围才 200，爆炸就 100 多，很不合理」。换算成设计单位：`pxPerMeter` = 50，
         *   所以 50 像素 = **1 米半径**，是"蹭到紧挨着的那 1~2 只"的溅射手感（怪被分离逻辑推开的
         *   间距 ≈ 两倍碰撞半径，实测约 40~60 像素）。
         *
         * 三档**不再靠半径区分**（三档同 50），档位差异全部落回伤害百分比 —— 爆炸大小是"形态"，
         *   不该随品质长大；否则白档玩家看到的圈和红档一样大，而红档还多一倍伤害，视觉上读不出档差。
         */
        id: 'splash', cn: '溅射', trig: 'on_attack_landed', impl: 'S:RelicHook_Splash', kv: ['pct', 'radius'],
        tier: { rare: { pct: 20, radius: 50 }, epic: { pct: 30, radius: 50 }, legendary: { pct: 45, radius: 50 } },
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
        /** ⚠ 半径口径同 `splash`（爆炸类一律 50 像素 = 1 米，见上面那条注释） */
        id: 'critEcho', cn: '暴击回响', trig: 'on_deal_damage', impl: 'S:RelicHook_CritEcho', kv: ['pct', 'radius'],
        tier: { rare: { pct: 30, radius: 50 }, epic: { pct: 50, radius: 50 }, legendary: { pct: 80, radius: 50 } },
        txt: v => `暴击时对目标 ${v.radius} 像素内敌人造成 ${v.pct}% 伤害`,
    },
    {
        /**
         * 连击：**命中按概率叠层，窗口锚在第一次叠层成功那一击**（2026-11 口径）。
         *
         * 为什么 `sec` 按档递增（4/6/8 秒）：窗口内能叠到的层数 ≈ `窗口 / 普攻间隔 × chance%`，
         * 而满层要 `(max−1)/chance%` 次命中。25% 概率下 3 秒窗口连蓝档都叠不满
         * （实测蓝档只剩 +1.4% 攻速 ≈ 没有效果），所以窗口随档位拉长；
         * `per` 同时从 2/3/4 抬到 4/6/8 补偿概率带来的层数减半。
         * 四个数的对账脚本：`node tools/relic-combo-sim/sim.mjs`（时间加权平均额外攻速）。
         */
        id: 'atkSpeedStack', cn: '连击', trig: 'on_attack_landed', impl: 'S:RelicHook_AtkSpeedStack', kv: ['per', 'max', 'sec', 'chance'],
        tier: {
            rare: { per: 4, max: 6, sec: 4, chance: 25 },
            epic: { per: 6, max: 10, sec: 6, chance: 25 },
            legendary: { per: 8, max: 15, sec: 8, chance: 25 },
        },
        txt: v => `普攻命中 ${v.chance}% 概率叠 1 层：攻击速度 +${v.per}%（上限 ${v.max} 层，首次命中起 ${v.sec} 秒后清零）`,
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
        /**
         * ⚠ **光环半径不能跟爆炸一样砍到 50（2026-11 用户定案，砍之前必读）**：
         *   光环是**以英雄为圆心**的持续圈，而怪会**停在自己的攻击距离**不再靠近
         *   （`ChaseAI`：`dist <= getAttackRange()` 就原地开打）。全表 9 种怪的停位距离是
         *   **44 / 90 / 100 / 100 / 120 / 120 / 140 / 150 / 180**（`units.json` 的 attr16，
         *   小怪/精英最大 120）—— 半径 ≤50 时**只有 44 射程的哥布林会被烫到**，
         *   其余 8 种怪一辈子站在圈外，这条遗物就变成了"配了等于没配"（本工程最忌讳的那种病）。
         *
         *   所以光环只收 ~15%，并守住一条下限：**红档半径 ≥ 150**（= 连 140/150 射程的 Boss
         *   都能被烫到，与改前 160 的覆盖面**完全等价**，不损失任何可作用目标）。
         *   档位差仍按半径递增（低档打得近、高档打得远），因为它就是"圈多大"这件事本身。
         *   判据落在 `check:pool` 的 H 组（下限现读 `units.json`，不是写死的数）。
         */
        id: 'immolate', cn: '灼烧光环', trig: 'on_tick', impl: 'S:RelicHook_Immolate', kv: ['value', 'radius'],
        tier: { rare: { value: 8, radius: 120 }, epic: { value: 16, radius: 135 }, legendary: { value: 30, radius: 150 } },
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
        /** ⚠ 半径口径同 `splash`（爆炸类一律 50 像素 = 1 米，见上面那条注释） */
        id: 'killBoom', cn: '死亡回响', trig: 'BUS:on_kill', impl: 'S:RelicHook_KillBoom', kv: ['value', 'radius'],
        tier: { rare: { value: 40, radius: 50 }, epic: { value: 80, radius: 50 }, legendary: { value: 140, radius: 50 } },
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
        /** ⚠ 光环半径的下限规则同 `immolate`（红档 ≥150，等效覆盖面不许缩水） */
        id: 'slowAura', cn: '迟滞光环', trig: 'on_tick', impl: 'S:RelicHook_SlowAura', kv: ['pct', 'radius'],
        tier: { rare: { pct: 20, radius: 140 }, epic: { pct: 30, radius: 160 }, legendary: { pct: 40, radius: 180 } },
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

    /* ---------- F 召唤增殖类（**2026-11 补**：这 3 条填掉 8 个流派词里唯一 0 件的空档） ----------
     *
     * 为什么是这 3 条形态：本作**没有召唤物基建** —— `MonsterPool` 把 prefab 硬编码成
     * `prefabs/unit/monsters/one`，team=1 的召唤物没有 EntityView 分支，
     * 真造一个单位出来是**看不见也打不动**的（"配了却永远见不到"，正是本工程最忌讳的那种病）。
     * 所以「召唤增殖」一律落地为**零基建等价机制**：不造实体，而是**让你的输出多出几份** ——
     * 这是技能侧 123 哨戒炮台 / 124 镜像分身 / 125 元素军阵 三条"召唤流"当年用的同一套口径，
     * 这里按遗物侧重新配数值与形态（三条的**时间形态各不相同**：周期 / 概率 / 累积）。
     *
     * 三条钩子的伤害类型一律**物理**：它们是"你（或你的分身）又打了一发"，走的是普攻那条链
     * （与 `splash` 同口径），不是法术追加。
     *
     * ⚠ 只挂 `召唤增殖` 一个标签，**不叠 `远程点杀`**：炮台自己选目标、分身替你出手，
     * 交付给玩家的是"我这边多了一个人"，不是"我这一发打得更狠"。标签要能回答
     * "我在凑 X 流派，这件算不算我的件"，两个都挂就答不清了。
     */
    {
        id: 'turret', cn: '哨戒炮台', trig: 'on_tick', impl: 'S:RelicHook_Turret', kv: ['interval', 'pct'],
        tier: { rare: { interval: 4, pct: 60 }, epic: { interval: 3, pct: 80 }, legendary: { interval: 2, pct: 100 } },
        txt: v => `每 ${v.interval} 秒自动对最近的敌人打出一击（攻击力 ${v.pct}%）`,
    },
    {
        id: 'mirror', cn: '镜像残影', trig: 'on_attack_landed', impl: 'S:RelicHook_Mirror', kv: ['chance', 'pct'],
        tier: { rare: { chance: 25, pct: 50 }, epic: { chance: 35, pct: 65 }, legendary: { chance: 50, pct: 85 } },
        txt: v => `普攻命中后有 ${v.chance}% 概率对同一目标立刻再打一次（攻击力 ${v.pct}%）`,
    },
    {
        id: 'clones', cn: '增殖体', trig: 'BUS:on_kill', impl: 'S:RelicHook_Clones', kv: ['perKill', 'max', 'pct'],
        tier: {
            rare: { perKill: 5, max: 2, pct: 20 },
            epic: { perKill: 4, max: 3, pct: 25 },
            legendary: { perKill: 3, max: 4, pct: 30 },
        },
        txt: v => `每击杀 ${v.perKill} 个敌人 +1 个增殖体（上限 ${v.max} 个，本局永久）；普攻时每个增殖体追加 攻击力 ${v.pct}% 的伤害`,
    },

    /* ---------- G 地雷改造族：**2026-11 新增，服务「骷髅王」流派** ----------
     *
     * 背景：骷髅王（`units#1010`）的发动机是**骷髅地雷** —— 每几秒在攻击范围内随机埋一颗雷
     * （上限 5 颗、满上限停手），敌人踩中即爆（物理伤害）。机制本体在 `battle/BattleMines.ts`，
     * 参数由英雄技能（`abilities#28`）给基础值。
     *
     * 这 6 条钩子的定位 = **放大器与变体**（不是发动机）：
     *   · `mineYield` / `mineCap` 是**流派资源轴**（产量 / 池子上限）；
     *   · `mineBlast` / `mineRange` 是**专属数值**（只有地雷流用得上 ⇒ 按分工归遗物；
     *     通用数值泵如攻击力/攻速归神器，神器买了任何流派都强 —— 见 docs/mine/README.md）；
     *   · `mineBurn` / `mineChain` 是**机制变体**（同一发爆炸换一种作用方式）。
     *
     * ⚠ 三项实现口径（改之前必读）：
     *   ① **kv 键名就是 `common/MineConfig.ts` 的 `MINE_KV`**（不是本文件另起一套）——
     *      键名写错 = 遗物静默无效；`RelicHook_MineTune.OnCreated` 会在控制台喊一声，
     *      `audit:mine` 与 `audit:hero` 也各有一条断言盯着；
     *   ② **六条钩子共用同一个脚本类** `RelicHook_MineTune`（`impl` 相同）：地雷是共享池，
     *      遗物只改参数，不做任何 add/remove 记账（重算式，见该类注释）；
     *   ③ 三档数值都**不含"上限 +3 以上"**：「雷区」红档只 +2 —— 上限从 5 到 8 就已经把节奏
     *      从"布置战场"变成"踩雷走廊"，再高战斗会退化成"埋完就走"。
     */
    {
        id: 'mineYield', cn: '急造', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineYieldPct'],
        tier: { rare: { mineYieldPct: 20 }, epic: { mineYieldPct: 30 }, legendary: { mineYieldPct: 40 } },
        txt: v => `骷髅地雷的布雷间隔 −${v.mineYieldPct}%`,
    },
    {
        id: 'mineCap', cn: '雷区', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineCapAdd'],
        tier: { rare: { mineCapAdd: 1 }, epic: { mineCapAdd: 1 }, legendary: { mineCapAdd: 2 } },
        txt: v => `骷髅地雷的上限 +${v.mineCapAdd} 颗`,
    },
    {
        id: 'mineBlast', cn: '重装', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineBlastPct'],
        tier: { rare: { mineBlastPct: 60 }, epic: { mineBlastPct: 90 }, legendary: { mineBlastPct: 130 } },
        txt: v => `骷髅地雷的爆炸伤害 +${v.mineBlastPct}% 攻击力`,
    },
    {
        /**
         * ⚠ **数值随基础半径一起砍（2026-11）**：地雷的爆炸半径基础值 `abilities#28` 从
         *   110/120/130 → **50/55/60**（同样是"爆炸不该盖住半个射程"，详见 `common/MineConfig.ts`），
         *   所以这条"扩爆"的加成也从 +30/+50/+70 → **+15/+25/+35**。
         *
         *   为什么必须一起改：旧的 +70 单件就接近基础值（110→180，×1.64）；若基础掉到 50 而加成不动，
         *   一件红档扩爆就能把半径推到 120 —— **比改前的整发爆炸还大**，等于这件遗物一个人把这次改动撤销掉。
         *   新比例（50→65/75/85）= 旧的 ×1.30/×1.50/×1.70，档位手感逐档对齐。
         */
        id: 'mineRange', cn: '扩爆', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineRadiusAdd'],
        tier: { rare: { mineRadiusAdd: 15 }, epic: { mineRadiusAdd: 25 }, legendary: { mineRadiusAdd: 35 } },
        txt: v => `骷髅地雷的爆炸半径 +${v.mineRadiusAdd}`,
    },
    {
        id: 'mineBurn', cn: '燃烧雷', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineBurnPct'],
        tier: { rare: { mineBurnPct: 20 }, epic: { mineBurnPct: 30 }, legendary: { mineBurnPct: 45 } },
        txt: v => `骷髅地雷爆炸后留下燃烧地面：每秒 攻击力 ${v.mineBurnPct}%，持续 3 秒`,
    },
    {
        id: 'mineChain', cn: '连锁雷', trig: 'PASSIVE:mine', impl: 'S:RelicHook_MineTune', kv: ['mineChain'],
        tier: { rare: { mineChain: 1 }, epic: { mineChain: 2 }, legendary: { mineChain: 3 } },
        txt: v => `骷髅地雷引爆时连带引爆 90 半径内最多 ${v.mineChain} 颗相邻地雷`,
    },

    /* ---------- H 背水血怒族（2026-11 补）----------
     * 流派语义：**以「已损失生命」为资源轴换输出** —— 血越少越强，代价是自伤与"治不回来"。
     *
     * 与既有钩子的边界（**这一族存在的理由**，否则它就是「坦克反伤」的重复件）：
     *   · `lowHpGuard` / `nearDeath` / `lastStand` / `takeHeal` 都是**阈值触发**的**生存**手段
     *     （血低 → 减伤 / 无敌 / 不死 / 回血）⇒ 归「坦克反伤」，玩家堆它们是为了**活下来**；
     *   · 这一族是**连续缩放**的**输出**手段（血低 → 攻速 / 攻击力 / 附带伤害，且**没有任何保命成分**）
     *     ⇒ 归「背水血怒」，玩家堆它们是为了**打出更多伤害**，并且必须自己承担血线风险。
     *   判据是"这件东西交付给玩家的是生存还是输出"，不是"它提到没提到生命"。
     *
     * ⚠ 与哈斯卡（`units#1009`「血怒」，`ScriptedModifiers.Modifier_BloodRage`）的关系：
     *   英雄技能给的是 **0.5/0.75/1.0 每 1% 缺血流**，这几条钩子是**同一条轴上的加码**
     *   （不是"另一套机制"）⇒ 哈斯卡抽到它们会线性变强，其他英雄抽到则是"白手起家"的背水流。
     *   四条钩子都**不写数值下限**：`per` 是"每 1% 缺血的增量"，全池最大也就 legendary 0.5，
     *   满血 0 收益、空血 50% 攻速 —— 上限不需要额外钳。
     */
    {
        id: 'bloodRush', cn: '血怒', trig: 'PASSIVE:lowHp', impl: 'S:RelicHook_BloodRush', kv: ['per'],
        tier: { rare: { per: 0.2 }, epic: { per: 0.35 }, legendary: { per: 0.5 } },
        txt: v => `每损失 1% 生命，攻击速度 +${v.per}%（满血时无加成）`,
    },
    {
        id: 'desperateAtk', cn: '拼命', trig: 'PASSIVE:lowHp', impl: 'S:RelicHook_DesperateAtk', kv: ['per'],
        tier: { rare: { per: 0.4 }, epic: { per: 0.7 }, legendary: { per: 1 } },
        txt: v => `每损失 1% 生命，攻击力 +${v.per}%（满血时无加成）`,
    },
    {
        id: 'selfBleed', cn: '焚血', trig: 'PASSIVE:lowHp', impl: 'S:RelicHook_SelfBleed', kv: ['drain', 'spd'],
        tier: { rare: { drain: 1, spd: 8 }, epic: { drain: 1, spd: 14 }, legendary: { drain: 1, spd: 22 } },
        txt: v => `攻击速度 +${v.spd}%；代价：每秒流失 ${v.drain}% 最大生命（生命降到 30% 即停）`,
    },
    {
        id: 'lastBreath', cn: '浴血', trig: 'on_attack_landed', impl: 'S:RelicHook_LastBreath', kv: ['threshold', 'pct'],
        tier: { rare: { threshold: 35, pct: 25 }, epic: { threshold: 40, pct: 45 }, legendary: { threshold: 45, pct: 70 } },
        txt: v => `生命低于 ${v.threshold}% 时，普攻命中追加 攻击力 ${v.pct}% 的纯粹伤害`,
    },

    /* ---------- I 弹幕散射族（2026-11 补）----------
     * 流派语义：**一发攻击覆盖尽量多的敌人** —— 与「远程点杀」（把一发做大、打死一个）是
     * **同一把枪的两种用法**，所以这一族全部打**物理**、全部享受暴击与破甲，
     * 与「法术爆发」（`hitPct` / `chain` 打 `Magical`）在伤害类型上就已经分开。
     *
     * ⚠ 与既有钩子的边界：
     *   · `splash`（溅射）与 `pierce`（穿透）**同时**归两条线（见 `HOOK_TAGS`）——
     *     "打一圈"与"打一条线"本来就是弹幕流的交付物，但它们的主标签仍是「远程点杀」
     *     （那两件遗物也会给单发加伤），所以**不在这两条上另起炉灶**；
     *   · `chain`（连锁）打魔法 ⇒ 法术爆发。`ricochet`（跳弹）打物理、吃暴击、吃破甲
     *     ⇒ 弹幕散射。**同一段行为、两种伤害类型就是两条流派** —— 这是本工程早就定下的
     *     判据（`HOOK_TAGS` 里 `hitPct` 归法术爆发而 `splash` 归远程点杀，用的就是它）。
     */
    {
        id: 'multishot', cn: '散射', trig: 'on_attack_landed', impl: 'S:RelicHook_Multishot', kv: ['extra', 'pct'],
        tier: { rare: { extra: 1, pct: 35 }, epic: { extra: 2, pct: 35 }, legendary: { extra: 2, pct: 55 } },
        txt: v => `普攻命中后，向攻击范围内另外 ${v.extra} 个敌人各射一箭：攻击力 ${v.pct}% 的物理伤害`,
    },
    {
        id: 'volley', cn: '箭雨', trig: 'PASSIVE:volley', impl: 'S:RelicHook_Volley', kv: ['interval', 'count', 'pct'],
        tier: {
            rare: { interval: 2.5, count: 2, pct: 40 },
            epic: { interval: 2, count: 3, pct: 45 },
            legendary: { interval: 1.5, count: 4, pct: 50 },
        },
        txt: v => `每 ${v.interval} 秒向攻击范围内至多 ${v.count} 个敌人各射一箭：攻击力 ${v.pct}% 的物理伤害`,
    },
    {
        id: 'ricochet', cn: '跳弹', trig: 'on_attack_landed', impl: 'S:RelicHook_Ricochet', kv: ['jumps', 'pct'],
        tier: { rare: { jumps: 1, pct: 35 }, epic: { jumps: 2, pct: 35 }, legendary: { jumps: 2, pct: 50 } },
        txt: v => `普攻命中后弹射 ${v.jumps} 次（每次换一个目标），每次造成 攻击力 ${v.pct}% 的物理伤害`,
    },

    /* ---------- G 主动型：**2026-10 定案不做**（不做遗物面板的使用按钮） ----------
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
 * 二之三、流派标签（2026-11）
 *
 * 为什么要有这一段：`abilities.json`（30 条肉鸽技能）与 `kill_buffs.json`（20 条击杀 Buff）
 * 早就有 `tags` 列，**只有池子最大的 268 件遗物一条都没有** —— 于是"流派"这件事
 * 只做了 2/3，而且做了的那 2/3 也没有出口（商店 4 格、技能槽都不显示流派）。
 *
 * 三条口径：
 *   1. **词表共用**：遗物用的标签必须来自 `RELIC_ARCHETYPES`（= 技能表与击杀 Buff 表已经在用的那 8 个词）。
 *      三张表各用一套词，等于给玩家三套语言，"流派"永远拼不起来。
 *   2. **标签由机制推出来，不手写**：钩子 → 标签、属性 → 标签两张规则表是唯一真源，
 *      加一件遗物不用手填标签，改一条钩子的定位也只改一处（评审稿会打印每件推导出的标签）。
 *   3. **每件 1~3 个**，钩子（效果）优先于属性 —— 效果比属性更能说明"这件是干什么的"。
 *      只有"纯 生命/魔法/攻击力"的垫底件才回落到通用属性标签。
 *
 * ✅ **2026-11 已补齐**：`召唤增殖` 原先 0 件（40 条钩子里没有召唤类，本作也没有召唤物基建）。
 *   补法是三条**零基建等价机制**钩子（`turret` / `mirror` / `clones`，见 HOOKS 的 F 段注释）
 *   + 6 件原本就"名字指着一个多出来的自己"的遗物（幻影斧 / 支配头盔 / 三叉戟 / 影刃 /
 *   回响之笼 / 怨灵系带）各加一条 —— 蓝 2 / 黄 2 / 红 2，与「经济成长 4 件」「元素持续 7 件」
 *   同一量级。⚠ 白档仍然是 0 件**且应该保持 0**：白档只有属性、没有钩子，
 *   而纯属性推不出「召唤增殖」（同理：物理暴击 / 元素持续 / 经济成长 / 控制减速的白档也都是 0），
 *   硬给白件贴这个标签就是"标签失去区分度"。生成器会把每档件数打出来。
 * ===================================================================================== */

/** 流派词表（**唯一真源**：遗物 / 技能 / 击杀 Buff 三张表共用） */
export const RELIC_ARCHETYPES = [
    '远程点杀', '坦克反伤', '物理暴击', '法术爆发', '召唤增殖', '元素持续', '经济成长', '控制减速',
    /* 2026-11 补两条（第 9 / 10 条）—— 词表从 8 个扩到 10 个，与用户定稿的 10 英雄名册一一对应：
     *   背水血怒 = 哈斯卡（`units#1009`）「血越少攻速越快」；
     *   弹幕散射 = 卓尔游侠（`units#1006`）「散射物理」。
     * ⚠ 两条都在**遗物侧**才有专属钩子；技能表 / 神器表暂时只标已有的那 8 条
     *   （`tagsOf` 的推词表是共用的一份，但没挂钩子的表不会推出新词 —— 不会凭空多出标签）。 */
    '背水血怒', '弹幕散射',
];

/**
 * 兜底标签：一件遗物一条标签都推不出来时用（避免出现"没有流派"的孤儿件）。
 * 目前只有"纯 生命/魔法/攻击力"的垫底件会走到这里，而它们都能被 `GENERIC_ATTR_TAGS` 接住。
 */
export const OTHER_TAG = '其他';

/** 一件遗物最多几个标签（超过就只留前面的 —— 钩子优先） */
export const MAX_TAGS_PER_RELIC = 3;

/** 全部合法标签（8 个流派词 + 兜底的「其他」） */
export const ALL_TAGS = [...RELIC_ARCHETYPES, OTHER_TAG];

/**
 * 钩子 → 流派标签。
 * 判据是**这条钩子交付给玩家什么**，不是它的名字听起来像什么：
 *   · 伤害类型看代码（`RelicHooks.ts`）：`HitPct` / `Chain` 打的是 `DamageType.Magical`
 *     ⇒ 归 **法术爆发**，不是"物理"；`Splash` 打的是攻击力百分比 ⇒ 归 **远程点杀**。
 *   · `evadeCounter`（闪避成功后反打）同时给两个标签 —— 与技能表 `127 闪避反击` 的双标签写法一致。
 */
export const HOOK_TAGS = {
    /* A 攻击命中类 */
    hitFlat: ['法术爆发'],                     // 追加固定魔法伤害（不吃攻击力）
    hitPct: ['远程点杀', '法术爆发'],           // 追加攻击力 X% 的**魔法**伤害：吃攻击力(点杀) + 打魔法(爆发)，两条流派都受益
    ignite: ['元素持续'],
    poison: ['元素持续'],
    frost: ['元素持续', '控制减速'],   // 既有持续伤害语义也有减速
    armorBreak: ['远程点杀'],
    splash: ['远程点杀', '弹幕散射'],   // 攻击力百分比的溅射 = 物理清场（"打一圈"也是弹幕流的交付物）
    chain: ['法术爆发'],              // 弹射打的是 DamageType.Magical
    pierce: ['远程点杀', '弹幕散射'],   // 沿一条线打过去（"打一条线"同样是弹幕流的交付物）
    execute: ['远程点杀'],
    firstStrike: ['远程点杀'],
    critEcho: ['物理暴击'],
    atkSpeedStack: ['远程点杀'],
    charge: ['远程点杀'],
    /* B 受击 / 生存类 */
    thorns: ['坦克反伤'],
    block: ['坦克反伤'],
    shieldCharge: ['坦克反伤'],
    evadeCounter: ['坦克反伤', '物理暴击'],
    lowHpGuard: ['坦克反伤'],
    nearDeath: ['坦克反伤'],
    lastStand: ['坦克反伤'],
    takeHeal: ['坦克反伤'],
    immolate: ['法术爆发'],           // 每秒对周围造成魔法伤害
    takeStackAtk: ['坦克反伤'],       // 挨打换攻击力（与技能表 128 战旗 / 129 时间回廊 同族）
    magicBarrier: ['坦克反伤'],
    regenTick: ['坦克反伤'],
    /* C 击杀类 */
    killHeal: ['坦克反伤'],
    killMana: ['法术爆发'],           // 回蓝 → 技能施放
    killGold: ['经济成长'],
    killExpFlat: ['经济成长'],
    killStackAtk: ['远程点杀'],
    killBoom: ['法术爆发'],
    killCdr: ['法术爆发'],            // 减的是技能冷却
    /* D 节奏 / 周期类 */
    tickStackAtk: ['远程点杀'],
    phaseBuff: ['远程点杀'],
    /* E 控制 / 光环类 */
    slowAura: ['控制减速'],
    stunProc: ['控制减速'],
    freezeProc: ['控制减速'],
    hexProc: ['控制减速'],
    silenceProc: ['控制减速'],
    /* F 召唤增殖类（2026-11 补）—— 三条都只归这一个标签，理由见 HOOKS 里那段注释 */
    turret: ['召唤增殖'],              // 多一个自己会出手的东西（周期）
    mirror: ['召唤增殖'],              // 你这一发变成两发（概率）
    clones: ['召唤增殖'],              // 越打身上的分身越多（累积）
    /* G 地雷改造族（2026-11 补）—— 同属「召唤增殖」：地雷就是"你放在场上、自己会干活的东西"。
     * ⚠ 语义因此收窄为：**在场上放置/召唤出自主工作的东西**（炮台 / 镜像 / 增殖体 / 地雷），
     *   不是"真的多一个会走路的单位"（本作没有召唤物实体，见 HOOKS F 段注释）。 */
    mineYield: ['召唤增殖'],
    mineCap: ['召唤增殖'],
    mineBlast: ['召唤增殖'],
    mineRange: ['召唤增殖'],
    mineBurn: ['召唤增殖'],
    mineChain: ['召唤增殖'],
    /* H 背水血怒族（2026-11 补）—— 四条都只归这一个标签：它们交付的是**输出**，
     * 与「坦克反伤」那批"血低 → 活下来"的钩子（`lowHpGuard` / `nearDeath` / `lastStand` / `takeHeal`）
     * 判据相反（见 `HOOKS` H 段那段注释）。 */
    bloodRush: ['背水血怒'],
    desperateAtk: ['背水血怒'],
    selfBleed: ['背水血怒'],           // 代价件：自伤换攻速，交付物仍然是输出
    lastBreath: ['背水血怒'],
    /* I 弹幕散射族（2026-11 补）—— 三条都打**物理**、都走暴击与破甲。
     * ⚠ `splash` / `pierce` 改成**双标签**（下面 A 段那两行也改了）：它们本来就是
     *   "一发打多个"的交付物，弹幕流玩家抽到它们不该觉得自己抽错了线；
     *   但**主标签仍是「远程点杀」**（那两件也照样给单发加伤），所以没有任何一件遗物
     *   因为这次改词表而换了主标签。 */
    multishot: ['弹幕散射'],
    volley: ['弹幕散射'],
    ricochet: ['弹幕散射'],
};

/**
 * 属性 → 流派标签（**只列有区分度的**）。
 * 判据：这条属性本身指向哪条流派。`1 最大生命` / `3 攻击力` 两项太通用
 * （几乎每件都带），放进 `ATTR_TAGS` 会让所有遗物都沾上同一个标签 ⇒ 它们是**兜底**，
 * 只在"这件一条标签都推不出来"时才用（见 `GENERIC_ATTR_TAGS`）。
 */
export const ATTR_TAGS = {
    2: '法术爆发',    // 最大魔法（供技能施放 —— 与 10 魔法恢复 同一条线）
    4: '远程点杀',    // 攻击速度
    6: '坦克反伤',    // 护甲
    7: '坦克反伤',    // 魔法抗性
    8: '坦克反伤',    // 闪避
    9: '坦克反伤',    // 生命恢复
    10: '法术爆发',   // 魔法恢复（供技能施放）
    11: '物理暴击',   // 伤害输出（增伤乘区）
    12: '坦克反伤',   // 受伤减免
    14: '物理暴击',   // 暴击率
    15: '物理暴击',   // 暴击倍率
    16: '远程点杀',   // 攻击距离
    21: '经济成长',   // 金币获取
    22: '经济成长',   // 经验获取
    23: '法术爆发',   // 冷却缩减
    24: '经济成长',   // 抽卡折扣
    25: '坦克反伤',   // 吸血（生存向）
    26: '坦克反伤',   // 攻击回复
    27: '法术爆发',   // 攻击回蓝
};

/** 兜底：通用属性的归属（只在推不出任何标签时使用） */
export const GENERIC_ATTR_TAGS = {
    1: '坦克反伤',    // 最大生命
    3: '远程点杀',    // 攻击力
};

/**
 * **流派配平判据**（2026-11 配平那一批定案）—— `npm run check:pool` 的 **G 组**照这张表判，生成器也打它。
 *
 * **为什么是这几个数**（算出来的，不是拍的）：
 *   · `minPerArchetype = 12`（4.5%）—— 成型线是 5 件（`ARCHETYPE_FORM_THRESHOLD`），一局抽 ~15 件、
 *     4 格选 1 ⇒ 一条线占 5% 时"专挑它"大约拿得到 3 件；再薄就等于**这条线在一局里看不见**。
 *   · `maxPerArchetype = 56`（21%）—— 到这个占比，随机抽 15 件的期望就 ≥5 件 ⇒ **不想堆也会成型**，
 *     成型提示退化成噪音（配平前「坦克反伤」93 件 / 35%，必响）。
 *   · `maxSpread = 4.5` —— **结构下限，不是没配平**：白档 107 件（占全池 40%）只有 9 条固定值属性，
 *     **只能推出 3 个词**（`whiteReachable`）⇒ 这 3 条线天然比专精线厚；再加「坦克反伤」是唯一的
 *     防御词（池子里的防御件全归它），10 条线全池均分**做不到**。2026-11 实测 4.23（配平前 23.2）。
 *   · `maxWhitePerArchetype = 44` —— 白档是垫底件，**不许单独把一条线抬起来**（白档 107 件里最多 41%）。
 *   · `mechanicalMin/Max = 8 / 32` —— **机制件（蓝+黄+红）**那一层必须 10 条线都有份：≥8 件才谈得上
 *     "这条线的核心件都在高档位"，≤32 件避免"高档位被一条线吃掉一半"。
 *
 * ⚠ 真要压到 2× 得动**池深**（白 107 → ~80：把 27 件白件升成蓝档并挂专精钩子）或给白档开「其他」词 ——
 *   两条都是独立的设计决定，取舍见 `docs/hero-archetype/README.md` §7.1。
 */
export const ARCHETYPE_BALANCE = {
    minPerArchetype: 12,
    maxPerArchetype: 56,
    maxSpread: 4.5,
    whiteReachable: ['远程点杀', '坦克反伤', '法术爆发'],
    maxWhitePerArchetype: 44,
    mechanicalMin: 8,
    mechanicalMax: 32,
};

/**
 * 一件遗物的流派标签（1~3 个，去重，**第 1 个是主标签**）。
 *
 * 顺序即优先级：钩子 → 有区分度的属性 → 通用属性兜底 → `其他`。
 *
 * ⚠ **属性只在"这件没有钩子"时才定性**（2026-11 实测后收紧的口径）：
 * 一开始让属性与钩子并列，结果「坦克反伤」占到了 166/268（62%）——
 * 因为 `护甲 / 魔抗 / 闪避 / 受伤减免 / 吸血` 大面积作为**次要词条**出现在输出件上，
 * 于是每件输出件都被贴上防守标签，标签就失去区分度了。
 * 现在：**钩子是身份，属性是填充物** —— 有钩子的件按钩子归类，
 * 纯属性件（白档 107 件 + 少量黄档）才按属性归类。这样标签才回答得了
 * "我在凑 X 流派，这件算不算我的件"。
 *
 * **代价条目（`item.cost`）不产生标签** —— 「疯狂面具」的 `护甲 -5` 是它的价钱，
 * 不能让这件输出件被贴上「坦克反伤」。
 *
 * @param {{h?: any[], a?: any[], t?: string[]}} item 设计真源里的一行（`resolveFinalItems()` 前后都可以）
 * @returns {string[]}
 */
/**
 * 一条属性条目的属性 id —— **两种写法都要认**：
 *   · `ITEMS` 里的设计写法：`a: [3, 16]`（只有 id，值由预算表算）；
 *   · `resolveFinalItems()` 之后的落表写法：`a: [[3, 13], [16, 16]]`。
 * 少了这个归一化，`tagsOf()` 会在设计表上一条标签都推不出来（静默变成「其他」）。
 */
export function attrIdOf(entry) {
    return Array.isArray(entry) ? entry[0] : entry;
}

export function tagsOf(item) {
    if (Array.isArray(item?.t) && item.t.length) return item.t.slice(0, MAX_TAGS_PER_RELIC);
    const out = [];
    const push = (tag) => {
        if (!ALL_TAGS.includes(tag)) throw new Error(`未登记的流派标签：${tag}（词表见 RELIC_ARCHETYPES）`);
        if (out.indexOf(tag) < 0 && out.length < MAX_TAGS_PER_RELIC) out.push(tag);
    };
    for (const h of item?.h ?? []) {
        const id = Array.isArray(h) ? h[0] : h;
        for (const tag of HOOK_TAGS[id] ?? []) push(tag);
    }
    /**
     * ⚠ **代价条目不产生标签**（本函数的文档一直是这么写的，但 2026-11 之前实现漏了这条）：
     * `resolveFinalItems()` 之后 `a` 里混着代价，于是「笨重」的 `攻击速度 -12%` 会按
     * `ATTR_TAGS[4] = 远程点杀` 给一件纯防御件贴上输出标签。2026-11 铺开代价件
     *（5 件 → 61 件）之后这条才显形：61 件里有 30+ 件的标签是**代价**给的。
     */
    const costIds = costAttrIds(item);
    const benefitEntries = (item?.a ?? []).filter((e) => !costIds.has(attrIdOf(e)));
    if (!out.length) {
        const table = ATTR_TAGS;
        for (const entry of benefitEntries) {
            const tag = table[attrIdOf(entry)];
            if (tag) push(tag);
        }
    }
    if (!out.length) {
        for (const entry of benefitEntries) {
            const tag = GENERIC_ATTR_TAGS[attrIdOf(entry)];
            if (tag) push(tag);
        }
    }
    if (!out.length) push(OTHER_TAG);
    return out;
}
/**
 * 逐件设计 —— **只写"这件有哪几条属性"（属性 id 列表），值不在这里**。
 *
 * 值一律由 `ATTR_VALUE[品质][属性] × SHARE[条数]`（代价件再 ×`COST_BOOST`）现算，见 `applyBudget()`。
 * 为什么把"哪几条"与"多少"分开：2026-11 之前值是手写在每一行里的，于是同一档里
 * 出现了「攻击力 +8 / +10 / +13」并存、以及"两条属性都拿满额"的件——前者让同效果的件
 * 有强有弱、后者让多一条属性的件**全面压过**同档的其它件（用户截图里那三格就是这么来的）。
 *
 * 字段：
 *   a    = **收益属性 id 列表**（≤`MAX_ATTRS_PER_RELIC` 条；顺序有意义 —— 第 1 条决定流派主标签）
 *   h    = 钩子 id（可选，1~3 个）
 *   cost = **代价条目**（可选，写法与落表一致 `[属性, 值, 叠加方式?]`）—— 代价件的收益自动 ×`COST_BOOST`
 *   kw   = 关键词（UI 上的一句话身份）；note = 需要额外说明的点
 */
export const ITEMS = [
    /* ===== 红档（27 件；代价件 8 件） ===== */
    { id: 5, r: 'legendary', a: [1], h: ["lastBreath"], kw: "锁血" },
    { id: 1131, r: 'legendary', a: [21, 22, 24], h: ["killGold","killExpFlat"], kw: "点金（经济：金币/经验/抽卡折扣三件套）" },
    { id: 1137, r: 'legendary', a: [3, 6], h: ["thorns","lowHpGuard"], kw: "刃甲" },
    { id: 1153, r: 'legendary', a: [3, 1], h: ["freezeProc","lastStand"], cost: [[4,-15,"add"]], kw: "时间冻结（命中概率冰封）" },
    { id: 1155, r: 'legendary', a: [3], h: ["execute","hitPct"], cost: [[1,-15,"percent"]], kw: "神灭斩（斩杀）" },
    { id: 1157, r: 'legendary', a: [3, 4], h: ["firstStrike","critEcho","mirror"], kw: "影刃（残影补刀）" },
    { id: 1159, r: 'legendary', a: [3, 14, 15], h: ["critEcho"], kw: "暴击" },
    { id: 1160, r: 'legendary', a: [3, 1, 6], h: ["mineCap"], kw: "地雷·雷区" },
    { id: 1161, r: 'legendary', a: [3, 6], h: ["armorBreak","execute"], kw: "黯灭" },
    { id: 1164, r: 'legendary', a: [1, 3], h: ["bloodRush","selfBleed","immolate"], cost: [[12,15,"add"]], kw: "契约（代价件：受到伤害 +15%；2026-11 从「激怒」改挂「背水血怒」—— 契约换的是输出不是防御）" },
    { id: 1169, r: 'legendary', a: [1, 23], h: ["killCdr"], kw: "神杖" },
    { id: 1180, r: 'legendary', a: [3, 1, 9], h: ["desperateAtk","bloodRush"], cost: [[4,-15,"add"]], kw: "血精（2026-11：血精石本来就该是「血越少越强」，从回血件改成背水血怒的核心件）" },
    { id: 1181, r: 'legendary', a: [3, 8], h: ["mineBurn"], cost: [[1,-15,"percent"]], kw: "地雷·燃烧" },
    { id: 1183, r: 'legendary', a: [1, 9, 7], h: ["magicBarrier","nearDeath"], kw: "林肯" },
    { id: 1185, r: 'legendary', a: [1, 9, 23], h: ["mineYield"], kw: "地雷·急造" },
    { id: 1190, r: 'legendary', a: [3, 14, 15], h: ["critEcho"], kw: "致命一击" },
    { id: 1194, r: 'legendary', a: [3, 4, 8], h: ["evadeCounter"], cost: [[1,-15,"percent"]], kw: "蝴蝶" },
    { id: 1195, r: 'legendary', a: [3, 8], h: ["mineChain"], kw: "地雷·连锁" },
    { id: 1197, r: 'legendary', a: [3], h: ["mineBlast"], kw: "地雷·重装" },
    { id: 1198, r: 'legendary', a: [3, 1, 6], h: ["volley","atkSpeedStack"], kw: "全军狂暴（2026-11：「嗜杀」换成「箭雨」—— 主标签转「弹幕散射」）" },
    { id: 1202, r: 'legendary', a: [3, 1, 4], h: ["frost","slowAura"], kw: "霜寒" },
    { id: 1203, r: 'legendary', a: [3, 1, 25], h: ["mineRange"], kw: "地雷·扩爆" },
    { id: 1206, r: 'legendary', a: [3, 1, 9], h: ["stunProc","execute"], cost: [[4,-15,"add"]], kw: "深渊" },
    { id: 1207, r: 'legendary', a: [3, 1, 9], h: ["multishot","killStackAtk"], cost: [[4,-15,"add"]], kw: "三叉戟（2026-11：「穿透」换成「散射」—— 三叉戟就是三路开花，主标签转「弹幕散射」）" },
    { id: 1208, r: 'legendary', a: [3, 1, 8], h: ["critEcho","execute"], kw: "血棘" },
    { id: 1221, r: 'legendary', a: [9, 24], h: ["killGold","killExpFlat"], cost: [[4,-15,"add"]], kw: "采集（经济·抽卡折扣）" },
    { id: 1280, r: 'legendary', a: [3, 21, 24], h: ["killGold","killExpFlat"], kw: "贪婪（经济：金币 + 抽卡折扣）" },

    /* ===== 黄档（54 件；代价件 16 件） ===== */
    { id: 2, r: 'epic', a: [3, 25], h: ["lastBreath"], cost: [[1,-12,"percent"]], kw: "吸血（2026-11：代价件 + 背水血怒 —— 这是一件「少血换伤害」的件）" },
    { id: 1019, r: 'epic', a: [7, 11], h: ["silenceProc"], kw: "法抗增伤" },
    { id: 1021, r: 'epic', a: [4], h: ["volley"], kw: "攻速" },
    { id: 1022, r: 'epic', a: [7, 12], h: ["magicBarrier"], kw: "法抗" },
    { id: 1025, r: 'epic', a: [3, 25], h: ["selfBleed","desperateAtk"], kw: "吸血（2026-11：改挂「背水血怒」）" },
    { id: 1031, r: 'epic', a: [3, 25], h: ["selfBleed","bloodRush"], kw: "吸取（2026-11：从「屠戮回血」改挂「背水血怒」—— 攻速件不该挂回血钩子）" },
    { id: 1033, r: 'epic', a: [7], h: ["magicBarrier"], kw: "法抗" },
    { id: 1034, r: 'epic', a: [8], h: ["critEcho"], kw: "闪避反击" },
    { id: 1044, r: 'epic', a: [3, 12], h: ["desperateAtk"], kw: "虚化减伤" },
    { id: 1080, r: 'epic', a: [4], h: ["atkSpeedStack"], kw: "月华" },
    { id: 1086, r: 'epic', a: [8], h: ["critEcho"], kw: "闪避" },
    { id: 1120, r: 'epic', a: [1, 6], h: ["mineCap"], kw: "地雷·雷区" },
    { id: 1123, r: 'epic', a: [3, 6, 25], h: ["critEcho"], kw: "萃取" },
    { id: 1125, r: 'epic', a: [3, 4, 25], cost: [[6,-5]], kw: "疯狂面具（代价件：护甲 −5，攻速换命）" },
    { id: 1126, r: 'epic', a: [14], h: ["critEcho"], kw: "暴击" },
    { id: 1130, r: 'epic', a: [7, 12], h: ["magicBarrier"], kw: "微光" },
    { id: 1132, r: 'epic', a: [3, 6, 25], h: ["killGold"], kw: "祭品" },
    { id: 1139, r: 'epic', a: [3, 1], h: ["selfBleed","takeStackAtk"], cost: [[4,-12,"add"]], kw: "臂章（2026-11：臂章的经典形态就是「自己掉血换输出」，从「不屈」改挂「焚血」）" },
    { id: 1140, r: 'epic', a: [3, 4], h: ["silenceProc", "hitFlat"], cost: [[1,-12,"percent"]], kw: "净魂" },
    { id: 1141, r: 'epic', a: [3, 1], h: ["clones", "killStackAtk"], cost: [[4,-12,"add"]], kw: "支配" },
    { id: 1142, r: 'epic', a: [3, 4], h: ["multishot","chain"], cost: [[1,-12,"percent"]], kw: "阵列（2026-11：「穿透」换成「散射」—— 阵列本来就是多目标词）" },
    { id: 1146, r: 'epic', a: [3, 1, 7], h: ["lowHpGuard"], kw: "裹布" },
    { id: 1148, r: 'epic', a: [3, 1, 6], h: ["killExpFlat"], kw: "灵瓮" },
    { id: 1151, r: 'epic', a: [3, 1], h: ["mineBlast"], cost: [[4,-12,"add"]], kw: "地雷·重装" },
    { id: 1152, r: 'epic', a: [3, 8], h: ["mineChain"], cost: [[1,-12,"percent"]], kw: "地雷·连锁" },
    { id: 1156, r: 'epic', a: [3, 7], h: ["silenceProc", "magicBarrier"], cost: [[1,-12,"percent"]], kw: "克星" },
    { id: 1163, r: 'epic', a: [1, 6], h: ["mineBurn"], kw: "地雷·燃烧" },
    { id: 1165, r: 'epic', a: [1, 6], h: ["lastBreath", "regenTick"], cost: [[4,-12,"add"]], kw: "清莲" },
    { id: 1166, r: 'epic', a: [1, 7, 12], h: ["lowHpGuard","magicBarrier"], cost: [[4,-12,"add"]], kw: "法衣" },
    { id: 1167, r: 'epic', a: [3, 9], h: ["multishot","splash"], cost: [[1,-12,"percent"]], kw: "分裂（2026-11：补「散射」，主标签转「弹幕散射」）" },
    { id: 1171, r: 'epic', a: [1, 7, 11], h: ["frost","killCdr"], kw: "慧散" },
    { id: 1172, r: 'epic', a: [3, 4], h: ["killCdr", "atkSpeedStack"], kw: "夜慧" },
    { id: 1173, r: 'epic', a: [3, 4], h: ["mineRange"], kw: "地雷·扩爆" },
    { id: 1178, r: 'epic', a: [3, 4], h: ["critEcho","mirror"], cost: [[1,-12,"percent"]], kw: "分身（追加一击）" },
    { id: 1179, r: 'epic', a: [1, 16], h: ["multishot", "execute"], cost: [[4,-12,"add"]], kw: "神枪" },
    { id: 1184, r: 'epic', a: [3, 1], h: ["killCdr","regenTick"], kw: "牧杖" },
    { id: 1186, r: 'epic', a: [3, 1, 9], h: ["mineYield"], kw: "地雷·急造" },
    { id: 1187, r: 'epic', a: [3, 16], h: ["multishot"], kw: "穿刺" },
    { id: 1188, r: 'epic', a: [3, 25], h: ["bloodRush","desperateAtk"], kw: "吸血（2026-11：撒旦之邪力改挂「背水血怒」）" },
    { id: 1189, r: 'epic', a: [1, 9], h: ["regenTick"], kw: "巨兽之血" },
    { id: 1191, r: 'epic', a: [4, 6], h: ["atkSpeedStack"], kw: "攻速光环" },
    { id: 1192, r: 'epic', a: [14, 15, 7], h: ["critEcho"], kw: "妖术" },
    { id: 1193, r: 'epic', a: [3, 7], h: ["hitPct"], cost: [[1,-12,"percent"]], kw: "以太冲击" },
    { id: 1199, r: 'epic', a: [3, 9, 4], h: ["hexProc", "firstStrike"], kw: "白银" },
    { id: 1204, r: 'epic', a: [3, 6, 9], h: ["thorns","lowHpGuard"], cost: [[1,-12,"percent"]], kw: "帕拉斯玛" },
    { id: 1209, r: 'epic', a: [3, 9, 16], h: ["killHeal","regenTick"], cost: [[1,-12,"percent"]], kw: "生机（击杀回血）" },
    { id: 1242, r: 'epic', a: [14, 15], h: ["critEcho"], kw: "重锤" },
    { id: 1244, r: 'epic', a: [8], h: ["critEcho"], kw: "闪避" },
    { id: 1253, r: 'epic', a: [7, 12], h: ["lastBreath"], kw: "魔免" },
    { id: 1268, r: 'epic', a: [4], h: ["atkSpeedStack"], kw: "迅速" },
    { id: 1274, r: 'epic', a: [4], h: ["desperateAtk","selfBleed"], kw: "狂热（2026-11：「蓄力」换成「背水血怒」两条 —— 狂热就该是「越危险越猛」）" },
    { id: 1281, r: 'epic', a: [3, 25], h: ["desperateAtk"], kw: "吸血鬼（2026-11：改挂「背水血怒」）" },
    { id: 1289, r: 'epic', a: [3, 11], h: ["killCdr"], kw: "释放" },
    { id: 1292, r: 'epic', a: [4], h: ["critEcho"], cost: [[12,10,"add"]], kw: "癫狂（代价件：受到伤害 +10%）" },

    /* ===== 蓝档（80 件；代价件 24 件） ===== */
    { id: 3, r: 'rare', a: [3], h: ["ignite"], cost: [[1,-9,"percent"]], kw: "点燃" },
    { id: 4, r: 'rare', a: [1], h: ["bloodRush"], cost: [[4,-9,"add"]], kw: "血量" },
    { id: 1005, r: 'rare', a: [1, 3], h: ["hitFlat"], kw: "智力" },
    { id: 1013, r: 'rare', a: [2, 9], h: ["killMana"], kw: "法力" },
    { id: 1014, r: 'rare', a: [3, 6], h: ["armorBreak"], kw: "腐蚀" },
    { id: 1015, r: 'rare', a: [3], h: ["poison"], kw: "剧毒" },
    { id: 1030, r: 'rare', a: [3, 6], h: ["multishot","pierce"], kw: "穿刺（2026-11：补「散射」，主标签转「弹幕散射」）" },
    { id: 1041, r: 'rare', a: [1, 3], h: ["hitPct"], kw: "法伤" },
    { id: 1058, r: 'rare', a: [1, 6], h: ["killGold"], kw: "自修" },
    { id: 1059, r: 'rare', a: [3, 10], h: ["killGold"], cost: [[1,-9,"percent"]], kw: "战旗" },
    { id: 1061, r: 'rare', a: [1, 9], h: ["killGold"], cost: [[4,-9,"add"]], kw: "补给" },
    { id: 1063, r: 'rare', a: [3, 10], h: ["mineBlast"], kw: "地雷·重装" },
    { id: 1070, r: 'rare', a: [3, 16], h: ["ignite"], kw: "仙火" },
    { id: 1072, r: 'rare', a: [2, 9], h: ["killExpFlat"], cost: [[3,-9,"percent"]], kw: "启迪（经济）" },
    { id: 1079, r: 'rare', a: [2, 3], h: ["killCdr"], kw: "刷新" },
    { id: 1087, r: 'rare', a: [6, 9], h: ["block"], cost: [[4,-9,"add"]], kw: "格挡" },
    { id: 1088, r: 'rare', a: [9], h: ["volley","charge"], cost: [[4,-9,"add"]], kw: "振奋（2026-11：补「箭雨」—— 从「攒一发大的」改成「周期性齐射」，主标签转「弹幕散射」；「蓄力」保留为次标签）" },
    { id: 1089, r: 'rare', a: [2, 6], h: ["critEcho"], kw: "先手" },
    { id: 1090, r: 'rare', a: [1, 6], h: ["bloodRush"], kw: "极限（2026-11：改挂「背水血怒」）" },
    { id: 1091, r: 'rare', a: [6, 9], h: ["firstStrike"], kw: "鹰眼" },
    { id: 1092, r: 'rare', a: [1], h: ["killGold"], kw: "掠夺" },
    { id: 1093, r: 'rare', a: [1, 3, 6], h: ["hitFlat"], kw: "秘法" },
    { id: 1094, r: 'rare', a: [2], h: ["execute"], kw: "神圣" },
    { id: 1095, r: 'rare', a: [1, 3, 16], h: ["freezeProc"], kw: "冰封" },
    { id: 1098, r: 'rare', a: [1, 9], h: ["regenTick"], cost: [[4,-9,"add"]], kw: "回复" },
    { id: 1100, r: 'rare', a: [1, 3, 26], h: ["desperateAtk"], cost: [[4,-9,"add"]], kw: "护腕（2026-11：改挂「背水血怒」）" },
    { id: 1101, r: 'rare', a: [3, 6, 9], h: ["turret"], cost: [[1,-9,"percent"]], kw: "怨灵" },
    { id: 1105, r: 'rare', a: [1, 3, 27], h: ["killGold"], kw: "灵龛" },
    { id: 1107, r: 'rare', a: [1, 2], h: ["killBoom"], kw: "口袋肉山" },
    { id: 1109, r: 'rare', a: [2, 6, 9], h: ["firstStrike"], kw: "猎鹰" },
    { id: 1111, r: 'rare', a: [3, 6, 10], h: ["shieldCharge"], cost: [[1,-9,"percent"]], kw: "护盾充能" },
    { id: 1112, r: 'rare', a: [2], h: ["multishot"], cost: [[3,-9,"percent"]], kw: "动力" },
    { id: 1116, r: 'rare', a: [3, 6, 16], h: ["critEcho"], kw: "相位" },
    { id: 1117, r: 'rare', a: [1, 2], h: ["killMana"], kw: "秘法" },
    { id: 1119, r: 'rare', a: [1, 16], h: ["phaseBuff"], kw: "战鼓" },
    { id: 1121, r: 'rare', a: [1, 3, 9], h: ["silenceProc"], kw: "纷争" },
    { id: 1122, r: 'rare', a: [1, 6, 9], h: ["mineCap"], kw: "地雷·雷区" },
    { id: 1124, r: 'rare', a: [16], h: ["ignite"], kw: "长枪" },
    { id: 1127, r: 'rare', a: [1, 2, 3], h: ["killCdr"], cost: [[4,-9,"add"]], kw: "慧光" },
    { id: 1128, r: 'rare', a: [1, 2, 9], h: ["frost"], cost: [[4,-9,"add"]], kw: "散华" },
    { id: 1129, r: 'rare', a: [6, 10], h: ["multishot"], kw: "夜叉" },
    { id: 1133, r: 'rare', a: [1, 10], h: ["takeHeal"], kw: "原力" },
    { id: 1134, r: 'rare', a: [1, 3, 10], h: ["takeHeal"], kw: "圣洁" },
    { id: 1135, r: 'rare', a: [1, 10], h: ["frost"], kw: "迟缓" },
    { id: 1143, r: 'rare', a: [3, 6, 26], h: ["ricochet","atkSpeedStack"], kw: "炎阳（2026-11：补「跳弹」，主标签转「弹幕散射」）" },
    { id: 1144, r: 'rare', a: [1, 16], h: ["killExpFlat"], kw: "灵匣" },
    { id: 1145, r: 'rare', a: [3, 9], h: ["killCdr"], kw: "圣杖" },
    { id: 1147, r: 'rare', a: [3, 9], h: ["ricochet","splash"], kw: "回音（2026-11：补「跳弹」—— 回音战刃的经典形态就是「打一下弹到下一个」，主标签转「弹幕散射」）" },
    { id: 1149, r: 'rare', a: [6, 10], h: ["ignite"], kw: "巫师" },
    { id: 1150, r: 'rare', a: [3, 9, 10], h: ["stunProc"], kw: "陨星" },
    { id: 1154, r: 'rare', a: [6], h: ["killExpFlat"], cost: [[4,-9,"add"]], kw: "魂匣" },
    { id: 1158, r: 'rare', a: [1, 6, 26], h: ["silenceProc"], kw: "紫怨" },
    { id: 1162, r: 'rare', a: [1, 6, 27], h: ["killExpFlat"], kw: "洞察" },
    { id: 1168, r: 'rare', a: [9], h: ["magicBarrier"], kw: "法术屏障" },
    { id: 1170, r: 'rare', a: [1, 9, 26], h: ["frost"], kw: "双剑" },
    { id: 1174, r: 'rare', a: [1, 9, 27], h: ["silenceProc"], kw: "否决" },
    { id: 1175, r: 'rare', a: [6, 16], h: ["mineRange"], kw: "地雷·扩爆" },
    { id: 1176, r: 'rare', a: [1, 2, 6], h: ["block"], kw: "卫士" },
    { id: 1177, r: 'rare', a: [6], h: ["frost"], kw: "冰霜光环" },
    { id: 1182, r: 'rare', a: [3, 9, 16], h: ["slowAura"], kw: "渔叉" },
    { id: 1196, r: 'rare', a: [6, 16], h: ["hitFlat"], kw: "坎达" },
    { id: 1205, r: 'rare', a: [9, 10], h: ["multishot","splash"], cost: [[4,-9,"add"]], kw: "斥散（2026-11：补「散射」，主标签转「弹幕散射」）" },
    { id: 1212, r: 'rare', a: [3, 9, 26], h: ["critEcho"], kw: "仪式" },
    { id: 1213, r: 'rare', a: [9, 10], h: ["poison"], kw: "浸染" },
    { id: 1226, r: 'rare', a: [1, 9, 10], h: ["poison"], kw: "种籽" },
    { id: 1231, r: 'rare', a: [3, 6, 27], h: ["mineBurn"], cost: [[1,-9,"percent"]], kw: "地雷·燃烧" },
    { id: 1233, r: 'rare', a: [3, 9, 27], h: ["mineChain"], cost: [[1,-9,"percent"]], kw: "地雷·连锁" },
    { id: 1236, r: 'rare', a: [9, 16], h: ["mineYield"], kw: "地雷·急造" },
    { id: 1241, r: 'rare', a: [2, 3, 6], h: ["critEcho"], kw: "回响" },
    { id: 1252, r: 'rare', a: [2, 3, 9], h: ["stunProc"], kw: "天崩" },
    { id: 1257, r: 'rare', a: [9, 16], h: ["mirror"], cost: [[4,-9,"add"]], kw: "棱晶" },
    { id: 1259, r: 'rare', a: [1, 6, 10], h: ["lastStand"], cost: [[4,-9,"add"]], kw: "不朽" },
    { id: 1267, r: 'rare', a: [3, 16], h: ["execute"], kw: "高远" },
    { id: 1269, r: 'rare', a: [10], h: ["desperateAtk"], cost: [[6,-4]], kw: "冒险（代价件：护甲 −4，进攻换脆皮）" },
    { id: 1278, r: 'rare', a: [2, 3], h: ["killExpFlat"], kw: "睿智" },
    { id: 1279, r: 'rare', a: [10], h: ["volley"], kw: "永恒" },
    { id: 1283, r: 'rare', a: [1, 6, 16], h: ["tickStackAtk"], cost: [[4,-9,"add"]], kw: "进化" },
    { id: 1284, r: 'rare', a: [2, 6], h: ["lastBreath"], cost: [[3,-9,"percent"]], kw: "巨神（2026-11：改挂「背水血怒」）" },
    { id: 1286, r: 'rare', a: [3, 10, 16], h: ["critEcho"], cost: [[1,-9,"percent"]], kw: "主导" },
    { id: 1287, r: 'rare', a: [1, 9, 16], h: ["regenTick"], cost: [[4,-9,"add"]], kw: "恢复" },

    /* ===== 白档（107 件；代价件 12 件） ===== */
    { id: 1, r: 'common', a: [6, 9], cost: [[4,-6,"add"]], kw: "反伤" },
    { id: 1001, r: 'common', a: [3], kw: "压制" },
    { id: 1002, r: 'common', a: [6, 9], kw: "格挡" },
    { id: 1003, r: 'common', a: [9, 1], kw: "力量" },
    { id: 1004, r: 'common', a: [3], kw: "敏捷" },
    { id: 1006, r: 'common', a: [6, 1], cost: [[4,-6,"add"]], kw: "血甲" },
    { id: 1007, r: 'common', a: [6], kw: "守护" },
    { id: 1008, r: 'common', a: [9, 1], kw: "血回" },
    { id: 1009, r: 'common', a: [9], kw: "回血" },
    { id: 1010, r: 'common', a: [2, 9], kw: "回蓝" },
    { id: 1011, r: 'common', a: [9], kw: "挡法" },
    { id: 1012, r: 'common', a: [16], kw: "追猎" },
    { id: 1016, r: 'common', a: [10, 3], kw: "利爪" },
    { id: 1017, r: 'common', a: [3, 1], kw: "腰带" },
    { id: 1018, r: 'common', a: [6], kw: "护甲" },
    { id: 1020, r: 'common', a: [6, 1], kw: "血甲" },
    { id: 1023, r: 'common', a: [6, 10], kw: "锁甲" },
    { id: 1024, r: 'common', a: [16], kw: "蓄势" },
    { id: 1026, r: 'common', a: [6, 1, 9], kw: "恢复" },
    { id: 1027, r: 'common', a: [10, 9], kw: "回血" },
    { id: 1028, r: 'common', a: [3, 1], kw: "溅射" },
    { id: 1029, r: 'common', a: [16, 3, 10], kw: "攻击" },
    { id: 1035, r: 'common', a: [6, 10], kw: "护甲" },
    { id: 1036, r: 'common', a: [16, 1, 3], kw: "远击（2026-11 池配平：补了攻距，主标签转远程点杀）" },
    { id: 1037, r: 'common', a: [16, 3, 9], kw: "阔剑" },
    { id: 1038, r: 'common', a: [6, 1, 3], kw: "血甲" },
    { id: 1039, r: 'common', a: [9, 1, 2], kw: "血牛" },
    { id: 1040, r: 'common', a: [6, 9, 10], kw: "护甲" },
    { id: 1042, r: 'common', a: [16, 3, 6], kw: "连锁" },
    { id: 1043, r: 'common', a: [16, 3, 6], kw: "重剑" },
    { id: 1045, r: 'common', a: [9, 3], cost: [[1,-6,"percent"]], kw: "秘银" },
    { id: 1046, r: 'common', a: [2, 1], cost: [[4,-6,"add"]], kw: "回血" },
    { id: 1047, r: 'common', a: [9, 10], kw: "回血" },
    { id: 1056, r: 'common', a: [2, 3, 6], kw: "续命" },
    { id: 1057, r: 'common', a: [16, 3, 26], kw: "补给" },
    { id: 1060, r: 'common', a: [1], kw: "狂石" },
    { id: 1067, r: 'common', a: [2], kw: "突袭" },
    { id: 1068, r: 'common', a: [1], kw: "树枝" },
    { id: 1069, r: 'common', a: [16, 3, 9], kw: "净化（攻击回复）" },
    { id: 1071, r: 'common', a: [2, 9], kw: "芒果" },
    { id: 1075, r: 'common', a: [2, 1], kw: "药膏（攻击回复）" },
    { id: 1078, r: 'common', a: [16, 2, 3], kw: "奶酪（攻击回复）" },
    { id: 1082, r: 'common', a: [10, 1], kw: "柔软" },
    { id: 1083, r: 'common', a: [2, 3], kw: "能量" },
    { id: 1084, r: 'common', a: [10, 1], kw: "活力" },
    { id: 1085, r: 'common', a: [16, 1], cost: [[4,-6,"add"]], kw: "精气" },
    { id: 1096, r: 'common', a: [6, 16], kw: "反伤" },
    { id: 1097, r: 'common', a: [2, 6, 9], kw: "王者" },
    { id: 1099, r: 'common', a: [16, 1], cost: [[4,-6,"add"]], kw: "充能" },
    { id: 1102, r: 'common', a: [2, 3, 9], kw: "挂件" },
    { id: 1103, r: 'common', a: [27, 1, 3], kw: "魔瓶" },
    { id: 1104, r: 'common', a: [2, 1, 6], kw: "魂戒" },
    { id: 1106, r: 'common', a: [10, 1, 9], kw: "静谧" },
    { id: 1108, r: 'common', a: [10], kw: "腐蚀" },
    { id: 1110, r: 'common', a: [9, 1, 16], kw: "丰饶" },
    { id: 1113, r: 'common', a: [9, 1, 26], kw: "坚韧" },
    { id: 1118, r: 'common', a: [27, 3, 9], kw: "空明" },
    { id: 1136, r: 'common', a: [16, 9], kw: "以太" },
    { id: 1210, r: 'common', a: [16, 3, 27], kw: "碎屑" },
    { id: 1211, r: 'common', a: [16, 3], kw: "吸血垫" },
    { id: 1214, r: 'common', a: [10], kw: "决斗" },
    { id: 1215, r: 'common', a: [27, 1, 9], kw: "护符" },
    { id: 1216, r: 'common', a: [6, 3, 26], kw: "举杯" },
    { id: 1217, r: 'common', a: [10, 1, 3], cost: [[4,-6,"add"]], kw: "潜能" },
    { id: 1218, r: 'common', a: [10, 3, 26], cost: [[1,-6,"percent"]], kw: "骰子" },
    { id: 1219, r: 'common', a: [6, 3, 9], kw: "盾墙垫" },
    { id: 1220, r: 'common', a: [6, 16], kw: "石羽" },
    { id: 1222, r: 'common', a: [10, 3, 27], kw: "咒盾（2026-11 池配平：主标签转法术爆发）" },
    { id: 1223, r: 'common', a: [6, 9, 16], kw: "勇气垫" },
    { id: 1224, r: 'common', a: [6, 1, 16], kw: "精华" },
    { id: 1225, r: 'common', a: [16, 3], kw: "跃迁" },
    { id: 1227, r: 'common', a: [16, 3, 27], kw: "远袭" },
    { id: 1228, r: 'common', a: [10, 3, 9], kw: "法力垫" },
    { id: 1229, r: 'common', a: [2, 3], kw: "咒刃（2026-11 池配平：主标签转法术爆发）" },
    { id: 1230, r: 'common', a: [16, 2, 3], cost: [[4,-6,"add"]], kw: "炽热" },
    { id: 1232, r: 'common', a: [2, 3, 10], kw: "通灵（攻击回蓝）" },
    { id: 1234, r: 'common', a: [27, 3, 26], kw: "不倦垫" },
    { id: 1235, r: 'common', a: [2, 3, 26], kw: "灼药（2026-11 池配平：主标签转法术爆发）" },
    { id: 1237, r: 'common', a: [2, 3, 27], kw: "授粉垫" },
    { id: 1238, r: 'common', a: [2, 6], kw: "咏咒（攻击回蓝）" },
    { id: 1239, r: 'common', a: [2, 10], kw: "烙印垫" },
    { id: 1240, r: 'common', a: [2, 10], kw: "蒲公英垫" },
    { id: 1243, r: 'common', a: [6, 9, 26], kw: "化蛹垫" },
    { id: 1245, r: 'common', a: [9, 3, 26], kw: "嗜血垫" },
    { id: 1246, r: 'common', a: [2, 6], kw: "残留垫" },
    { id: 1247, r: 'common', a: [2], kw: "附魔" },
    { id: 1248, r: 'common', a: [16, 2, 6], kw: "触媒垫" },
    { id: 1249, r: 'common', a: [6, 3, 10], kw: "铁壁（2026-11 池配平：主标签转坦克反伤）" },
    { id: 1250, r: 'common', a: [16, 2], kw: "疾行" },
    { id: 1251, r: 'common', a: [2, 9, 10], kw: "召唤垫" },
    { id: 1254, r: 'common', a: [16, 2, 9], kw: "巫毒垫" },
    { id: 1255, r: 'common', a: [16, 1, 3], kw: "血仪" },
    { id: 1256, r: 'common', a: [2, 1, 27], kw: "圣衣" },
    { id: 1258, r: 'common', a: [27, 6, 9], cost: [[4,-6,"add"]], kw: "协和" },
    { id: 1270, r: 'common', a: [2, 6, 10], cost: [[3,-6,"percent"]], kw: "神秘" },
    { id: 1271, r: 'common', a: [2, 6, 26], cost: [[3,-6,"percent"]], kw: "警觉垫" },
    { id: 1272, r: 'common', a: [6, 1, 26], kw: "壮实" },
    { id: 1273, r: 'common', a: [6, 9, 16], kw: "坚强垫" },
    { id: 1275, r: 'common', a: [16, 2], kw: "捷足" },
    { id: 1276, r: 'common', a: [2, 1, 10], kw: "粗暴垫" },
    { id: 1277, r: 'common', a: [16, 3, 10], kw: "无边" },
    { id: 1282, r: 'common', a: [16, 9], kw: "犀利" },
    { id: 1285, r: 'common', a: [16, 3, 26], kw: "凶猛垫" },
    { id: 1288, r: 'common', a: [6, 1, 10], kw: "厚实" },
    { id: 1290, r: 'common', a: [27, 1, 6], kw: "活力" },
    { id: 1291, r: 'common', a: [2, 1, 26], cost: [[4,-12,"add"]], kw: "笨重垫（代价件：攻速 −12%，卖点是单次伤害）" },
    { id: 1293, r: 'common', a: [16, 1, 2], kw: "轻快" },

];

/* =====================================================================================
 * 四、派生层（**生成器与落表脚本共用这一份**，别各写一份 —— 文案/数值一旦有两份实现就会漂移）
 * ===================================================================================== */

/** 落表 id 段：钩子行 200 起（顺序 = `HOOKS` 数组顺序）、钩子要施加的减益/DoT 行 300 起 */
export const HOOK_MOD_BASE = 200;
export const DEBUFF_MOD_BASE = 300;

/**
 * 200 段里**不属于遗物钩子**的区间（分配钩子 id 时自动跳过）。
 *
 * 为什么要有这张表：神器 / 掉落 Buff 的脚本行也落在 200 段
 * （`KillBuff_Skyfall` … = 240~243、`BattleItem_BloodBag` = 250，2026-11 落地），
 * 而 `gen-relic-hook-modifiers.mjs` 曾经按"整段 200~399"清行 —— 跑一次就会把这 5 条删掉。
 * 清行规则已改成**按归属标记认领**（`script_id` 以 `RelicHook_` 开头 + 减益 id 清单），
 * 这里再把占用写进设计真源，让"新钩子算出来的 id 会不会撞"在**设计层**就能看出来。
 * ⚠ 神器那边还会继续长（`kill_buffs` 加机制型条目就会加行），所以整段 240~259 一起留出来。
 */
export const HOOK_MOD_GAPS = [
    { from: 240, to: 259, why: '神器 / 掉落 Buff 的脚本行（SpecialBuffs.ts / battle_items）' },
];

/** 该 id 是不是被别的系统占了（钩子分配要绕开） */
export function isReservedModId(id) {
    return HOOK_MOD_GAPS.some((g) => id >= g.from && id <= g.to);
}

/**
 * 钩子 → `modifiers.json` 行 id。
 *
 * 顺序敏感：`HOOKS` 里插一条/删一条都会让**它后面**的 id 平移，
 * 所以**改完必须重跑 `npm run gen:relic-hooks` 再跑落表**（两个脚本都读这一个函数）。
 * 分配时自动跳过 `HOOK_MOD_GAPS`（神器/掉落 Buff 那一段），宁可留一段空号也不撞号。
 * 显式写 `modId` 可以钉死（留给"必须保持 id 不变"的历史钩子），但**不许**钉到保留段或撞已有号。
 */
const HOOK_MOD_IDS = (() => {
    const map = new Map();
    const used = new Set();
    let cursor = HOOK_MOD_BASE;
    for (const h of HOOKS) {
        let id = h.modId;
        if (id === undefined) {
            while (isReservedModId(cursor) || used.has(cursor)) cursor++;
            id = cursor++;
        }
        if (map.has(h.id)) throw new Error(`钩子 id 重名：${h.id}`);
        if (isReservedModId(id)) throw new Error(`钩子 ${h.id} 的 modId ${id} 落在保留段（${JSON.stringify(HOOK_MOD_GAPS)}）`);
        if (used.has(id)) throw new Error(`钩子 ${h.id} 的 modId ${id} 与前面的钩子撞号`);
        used.add(id);
        map.set(h.id, id);
    }
    return map;
})();

export function hookModId(hookId) {
    const id = HOOK_MOD_IDS.get(hookId);
    if (id === undefined) throw new Error(`未定义的钩子：${hookId}`);
    return id;
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
    // ⚠ 必须走 `HOOK_MOD_IDS` 反查，**不能**用 `modId - HOOK_MOD_BASE` 当下标：
    //   新钩子的 id 从 260 起（跳过神器那一段），下标式在这里会算出 60 > HOOKS.length
    //   → 返回 null → 门禁把钩子文案当成遗物文案解析 → 在低档件上误报"越档承诺了攻击力百分比"。
    let hookId = null;
    for (const [id, mid] of HOOK_MOD_IDS) if (mid === modId) { hookId = id; break; }
    if (hookId === null) return null;
    const hook = HOOK_BY_ID[hookId];
    const values = hook?.tier?.[rarity];
    return values ? hook.txt(values) : null;
}

/**
 * 把 `SUPPLY_TOPUP` 的追加名单落到逐件设计上：**名单里的件就"带这条属性"**（追加进 `a`）。
 *
 * ⚠ **不再覆盖任何值**（2026-11 改）：值一律由 `attrValueOf()` 按条数算 —— 覆盖会让
 * "同一条属性在 2 条属性的件上也拿满额"，那正是支配关系的来源（见 `SHARE` 的注释）。
 * 条数满了（`MAX_ATTRS_PER_RELIC`）就跳过：宁可供给少一点，也不许长出 5 条属性的怪物件。
 */
export function applySupplyFill(items = ITEMS) {
    const out = items.map((it) => ({ ...it, a: [...(it.a ?? [])], cost: (it.cost ?? []).map((e) => [...e]) }));
    for (const [key, rule] of Object.entries(SUPPLY_TOPUP)) {
        const attr = Number(key);
        const extra = new Set(rule.add ?? []);
        const except = new Set(rule.except ?? []);
        for (const it of out) {
            if (!extra.has(it.id) || except.has(it.id)) continue;
            if (it.a.includes(attr)) continue;
            if (it.a.length >= MAX_ATTRS_PER_RELIC) continue;
            /**
             * ⚠ **不许把"代价轴"补给这件遗物**（2026-11 实测踩到）：
             * 供给配平只认 id 名单，不知道这件遗物的代价已经打在这条轴上 —— 于是
             * 「冈格尼尔」的收益被补成"攻击速度 +31"、而它的代价是"攻击速度 −12%"，
             * 净额仍是正的：**代价当场失效**（`npm run audit:attr` 的「代价专项」抓的就是这个，
             * 报出来的话是"方向反了"= 加了这条属性之后最终值反而变大了）。
             */
            if (it.cost.some((e) => e[0] === attr)) continue;
            it.a.push(attr);
        }
    }
    return out;
}

/**
 * 把「属性 id 列表」算成「`[id, value, mode?]` 条目」—— **值的唯一出处**。
 *
 * `ITEMS` 里只写"这件有哪几条属性"（`a: [3, 16]`），值全在这里按
 * `ATTR_VALUE[品质][属性] × SHARE[条数]` 现算（代价件再乘 `COST_BOOST`）。
 * 好处：改一个数只改一处；"多一条属性"自动让**所有**属性的值变薄（预算守恒），
 * 不会出现"忘了把攻击力从 8 改成 6"这种漂移。
 */
export function applyBudget(items = ITEMS) {
    return applySupplyFill(items).map((it) => {
        const isCostItem = (it.cost ?? []).length > 0;
        const count = it.a.length;
        return {
            ...it,
            a: it.a.map((attr) => {
                const def = ATTR_VALUE[it.r]?.[attr];
                if (!def) throw new Error(`未登记属性值：${it.r} / ${attr}（遗物 ${it.id}）`);
                const entry = [attr, attrValueOf(it.r, attr, count, isCostItem)];
                if (def.mode) entry.push(def.mode);
                return entry;
            }),
        };
    });
}

/**
 * 最终逐件表（供给配平 + 预算算值）—— 生成器与落表脚本的唯一输入。
 *
 * ⚠ **代价条目在这里、而不是在 `ITEMS` 里并进 `a`**，顺序是关键：
 * `cost` 是"这件遗物的价钱"，它必须**最后**并进 `a`，否则：
 *   · 供给核算与预算表会把代价当成收益（`SUPPLY_TOPUP` 的 `except` 就是为它留的）；
 *   · 评审稿/体检分不清"收益"与"代价"（净额核算会错）。
 * 并进去之后 `cost` 字段**原样保留**，体检靠它分辨（不是靠符号 —— 12 号轴正号才是代价）。
 *
 * ⚠ **代价条目的值是手写的**（不走预算表）：代价是"这件遗物的价钱"，与它的收益条数无关，
 *   也不该因为"这件有 3 条属性"就被摊薄成 1/3（那等于代价白送）。
 */
export function resolveFinalItems() {
    return applyBudget(ITEMS).map((it) => (
        it.cost.length ? { ...it, a: [...it.a, ...it.cost.map((e) => [...e])] } : it
    ));
}

/**
 * 这件遗物的**代价**属性 id 集合。
 * `resolveFinalItems()` 之后 `a` 里已经混着收益与代价，靠这个函数分辨（`cost` 字段保留）。
 */
export function costAttrIds(item) {
    return new Set((item?.cost ?? []).map((e) => e[0]));
}

/** 这件遗物的代价条目（`[[attrId, value, mode?], ...]`） */
export function costEntriesOf(item) {
    return item?.cost ?? [];
}

/* ---------------- 文案（属性 + 钩子 → 一句话），评审稿与配表 `description_inner` 共用 ---------------- */

/**
 * 一条属性条目的文案。
 *
 * ⚠ **负值必须自己带符号**（2026-11 修）：早期版本三处都硬写 `+${value}`，
 * 负固定值会渲染成「护甲 +-5」、负 percent 会渲染成「最大生命 +-15%」。
 * 加代价件之前全池只有 attr 12 出现过负值，而 12 走的是下面那条自带符号的分支，
 * 所以这个 bug 一直没被暴露 —— 铺代价件会立刻踩到。
 */
export function attrText([id, value, mode]) {
    const cn = ATTR_CN[id] ?? `属性${id}`;
    const percentType = PERCENT_ATTRS.has(id);
    const pctMode = mode === 'percent';
    /** 带符号的绝对值（`+3` / `-3`） */
    const signed = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(v)}`;
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
    if (pctMode) return `${cn} ${signed(value)}%`;
    if (id === 9 || id === 10) return `${cn} ${signed(value)}/秒`;
    return `${cn} ${signed(value)}`;
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

/**
 * 整件遗物的 `description_inner`：**收益在前、代价在最后**，各段分号串联。
 *
 * 为什么代价要单独一段、还带「代价：」前缀：
 *   · 玩家要在**一眼之内**看出"这件不是白给的" —— 混在收益里（"攻击力 +13；护甲 -5"）
 *     会读成一条普通词条，而它其实是这件遗物的价钱；
 *   · 门禁体检按 `，、；` 切子句，`代价：护甲 -5` 切出来仍是完整一句 ⇒ 属性词条照样能被识别。
 */
export function descriptionOf(item) {
    const costKeys = new Set(costEntriesOf(item).map((e) => e.join('|')));
    const benefits = (item.a ?? []).filter((e) => !costKeys.has(e.join('|')));
    const costs = (item.a ?? []).filter((e) => costKeys.has(e.join('|')));

    const parts = [];
    const attrPart = attrListText(benefits);
    if (attrPart) parts.push(attrPart);
    for (const h of item.h ?? []) parts.push(hookText(h, item.r));
    if (costs.length) parts.push(`代价：${costs.map(attrText).join('、')}`);
    return parts.join('；');
}
