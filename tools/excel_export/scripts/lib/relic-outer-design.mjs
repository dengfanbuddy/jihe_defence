/**
 * relic-outer-design.mjs —— **局外遗物数值设计真源**（2026-11 重做）
 *
 * 与 `relic-inner-design.mjs`（局内 268 件）**对称**：那边管"这一局里这件遗物给什么"，
 * 这边管"图鉴里收集到的这件遗物，跨局永久给什么"。两边的**身份列**（id/name/icon/rarity/tags）
 * 只有一份，所以本文件**不重复定义那 268 件**，只定义**从局内身份推出局外数值**的规则。
 *
 * ── 用户口径（2026-11，四条，缺一不可）──
 *   ① **局内局外严格对齐**：局外池 = 局内池 = **268 件**（原 37 件局外池 + 9 件"只有局外版"的
 *      dota2 中立道具**整行删除** —— 那 9 件在局内不存在，属"局外额外的东西"）；
 *   ② **攻速 / 暴击率 / 闪避率这类"比例型"属性一律不给**（见 `FORBIDDEN_ATTRS` 的推导）；
 *   ③ **红色遗物额外给"局内开局初始值"**（初始金币 +10 / 初始击杀 +10 …，见 `RUN_EFFECT_*`）；
 *   ④ **集齐总量与旧 37 件同量级**（单件 ≈ 旧单件的 1/7）—— 难度曲线、推荐档位、金币产出都不用重标。
 *
 * ── 为什么是"按品质预算"而不是"照抄局内数值"──
 *   局内黄/红档的属性是 `percent`（对基础属性乘算，如"攻击力 +21%"），而局外落在**基础值**上，
 *   照抄会得到"黄档的攻击加成比白档还小"的倒挂（详见 `docs/meta-growth/README.md` §1.7）。
 *   所以：**形状（给哪几条属性）由局内身份决定**，**数值由品质预算决定** —— 与本工程
 *   「判据只有一份、数值只有一个出处」的口径一致。
 *
 * ── 与旧 37 件的对账（口径见 `tools/outer-relic-design/README.md`）──
 *   旧 37 件 ×1 份的局外总量：攻击 +372 / 攻速 +135% / 暴击 +47% / 暴击倍率 +50 / 护甲 +71 /
 *   生命 +1820 / 回血 +12.5 / 闪避 +23% / 攻距 +5。
 *   新表砍掉比例型那一半（攻速/暴击/闪避）之后，**DPS 改由攻击力一个轴承担** —— 标定出的
 *   总量（`OUTER_TOTAL_TARGET`）与旧表在多档等级上逐英雄对过账（`node tools/outer-relic-design/report.mjs`）。
 */
import { ATTR_VALUE, roundAttrValue, MAX_ATTRS_PER_RELIC } from './relic-inner-design.mjs';

/* ===================================================================
 * 一、属性白名单（用户口径 ②）
 * =================================================================== */

/**
 * **禁止给的比例型属性**（用户口径："攻速，暴击率，闪避率等不能给"）。
 *
 * 判据与 `AttributeScaling.SCALE` / `relic-inner-design.PERCENT_ATTRS` **同源**：
 *   · 4 攻击速度（base 100 = 1.0，上限 5.0）· 7 魔法抗性 · 8 闪避（互补式，上限 45）
 *   · 11 伤害输出倍率 · 12 受伤减免倍率 · 14 暴击率（上限 100）· 15 暴击倍率（best 叠加）
 *   · 21 金币获取 · 22 经验获取 · 23 冷却缩减 · 24 抽卡折扣 · 25 吸血
 *
 * 为什么这一整族都禁（不只是用户点名的三条）：它们**全是乘区**（`multiply` / `complement` / `best`），
 * 落在"跨局永久、份数无上限"的局外轴上会变成**复利** —— 而局外的份数是线性累加的，
 * 一旦叠进乘区，"多抽 10 份"的效果就不再是"多 10 份的量"，而是随收集次数指数放大。
 * 局外**只给加法轴**（`stack_mode = add`）是本设计的硬边界。
 */
export const FORBIDDEN_ATTRS = new Set([4, 7, 8, 11, 12, 14, 15, 21, 22, 23, 24, 25]);

/**
 * **局外属性白名单（5 条轴）**：1 最大生命 / 2 最大魔法 / 3 攻击力 / 6 护甲 / 9 生命恢复。
 *
 * 为什么只有 5 条（而不是把 10 条加法轴全用上）：
 *   · **16 攻击距离**：单件只能给 +0.1 才不超预算（268 件摊下来总量只有 +5），而 +0.1 攻距
 *     在 UI 上读起来像"没给"；且它直接改变"能否够到怪"这一档性质（`audit:reach` 盯着屏幕预算），
 *     放量 = 把关卡设计的前提改掉 ⇒ 不给；
 *   · **10 魔法恢复 / 26 攻击回复 / 27 攻击回蓝**：旧 37 件一个都没给过，是**净新增的续航轴**，
 *     而续航在本工程的战力模型里没有对应乘区（`battle-power` 只算 DPS/有效血）——
 *     加了就是"没被任何体检盯住的强度"，先不给（要加得先给模型补这一层）；
 *   · 剩下的 5 条正好覆盖"肉（生命/护甲/回血）、输出（攻击力）、技能（魔法）"三块，
 *     而 `属性总览` 那一页最多 5 行，读起来也干净。
 */
export const OUTER_ATTRS = [1, 2, 3, 6, 9];

/** 一件局外遗物最多给几条属性（与局内的 `MAX_ATTRS_PER_RELIC` 同口径，但局外只到 2 —— 图鉴行一行放得下） */
export const OUTER_MAX_ATTRS = 2;

/* ===================================================================
 * 二、数值预算（用户口径 ④：集齐总量与旧 37 件同量级）
 * =================================================================== */

/**
 * **品质权重**：一件遗物的局外贡献 = `OUTER_UNIT[属性] × OUTER_TIER_WEIGHT[品质] × SHARE[条数]`。
 *
 * 为什么用"权重 × 单位值"而不是给每条轴单独抄一张 4 档表：**268 件里每条轴的件数不一样**
 * （攻击力 125 件、护甲 74 件…），逐档手抄必然出现"某条轴总量偏了"却看不出来。
 * 权重定死之后，`OUTER_UNIT` 就是**唯一**的标定旋钮 —— 改一个数 = 改那条轴的总量，
 * `report.mjs` 会把总量与旧表逐条对账。
 *
 * 权重梯度 1 / 2 / 3.5 / 6：红件一件顶 6 件白件（与局内 4:3:2:1 的池深梯度同量级，
 * 但更陡 —— 局外是"集齐"型进度，高档件必须让玩家记得住）。
 */
export const OUTER_TIER_WEIGHT = { common: 1, rare: 2, epic: 3.5, legendary: 6 };

/**
 * **条数摊薄系数**（与局内 `SHARE` 同一套值的前两项）。
 *
 * 为什么必须摊薄：局外的值是"按属性条数无关"地给的，那么"攻击力 +14 且白送生命 +35"的件
 * 会在同品质内**全面压过**"攻击力 +14"的件 —— 这正是 `check:pool` 的 B 组（无支配）要拦的东西。
 * 摊薄之后同品质内不可能存在逐属性支配对（证明与局内 `SHARE` 的注释逐字相同）。
 */
export const OUTER_SHARE = { 1: 1, 2: 0.75 };

/**
 * **每条轴的"单位值"** = 品质权重为 1 的一件遗物给多少。
 * 标定依据 = `OUTER_TOTAL_TARGET`（见下），由 `report.mjs --solve` 反解、四舍五入成好读的数，
 * 再回填这里（**不要手改 relics.json 里的值** —— 那是生成物）。
 */
export const OUTER_UNIT = {
    1: 12,      // 最大生命：94 件带 ⇒ 总量 ≈ +2480
    2: 5,       // 最大魔法：49 件带 ⇒ 总量 ≈ +310
    3: 4,       // 攻击力：125 件带 ⇒ 总量 ≈ +1350（DPS 那一半全靠它）
    6: 0.7,     // 护甲：74 件带 ⇒ 总量 ≈ +73
    9: 0.13,    // 生命恢复/秒：74 件带 ⇒ 总量 ≈ +12
};

/**
 * **集齐 268 件 × 1 份时的局外总量目标**（= 旧 37 件 × 1 份的量级，用户口径 ④）。
 *
 * 这五个数是**标定锚点**，不是"配表摘要"：`report.mjs --check` 会拿真表现算的总量跟它对账，
 * 偏了超过 15% 就报错（改了 `OUTER_UNIT` 或改了哪件遗物的属性就得重新对一次）。
 *   · 攻击力 +1300：旧表的 DPS 来自「攻击 +372 × 攻速 ×2.35 × 暴击 ×1.47」，
 *     砍掉攻速与暴击之后，**同一个 DPS 曲线要由攻击力一个轴复现** ⇒ 372 × 3.45 ≈ 1283
 *     （逐英雄逐等级对过账，见 report 的倍率表）；
 *   · 生命 +2400 / 护甲 +71：旧表 EHP = 生命 ×6.7 × 护甲 ×5.26 × 闪避 ÷0.77；
 *     闪避那一层（×1.30）没了 ⇒ 生命侧补到 +2400（旧 +1820 × 1.30）；
 *   · 魔法 +300 / 回血 +12：旧表没有魔法轴（净新增，刻意压小）；回血沿用旧量级。
 */
export const OUTER_TOTAL_TARGET = { 1: 2400, 2: 300, 3: 1300, 6: 71, 9: 12 };

/* ===================================================================
 * 三、形状：从局内身份推出这件遗物给哪几条轴
 * =================================================================== */

/**
 * **没有局内白名单属性时的兜底**（按主标签 `tags[0]`）。
 *
 * 268 件里有 17 件的局内属性全是比例型（如"加速手套 攻速 +40"、"闪避护符 闪避 +13"），
 * 它们**在局内是有身份的**（提升攻速/闪避），而局外禁掉了那几条轴 ⇒ 只能按流派兜底，
 * 否则这 17 件会变成"抽到了什么都不给"（图鉴里一行空白，比"弱"更糟）。
 * 兜底口径：**输出线给攻击力、防守线给护甲+生命、法术/经济线给生命+魔法**。
 */
export const TAG_FALLBACK_ATTRS = {
    远程点杀: [3],
    物理暴击: [3],
    弹幕散射: [3],
    法术爆发: [3, 2],
    召唤增殖: [3, 1],
    元素持续: [3, 1],
    坦克反伤: [6, 1],
    背水血怒: [1, 9],
    经济成长: [1, 2],
    控制减速: [2, 1],
};

/** 兜底也落空（没有标签，理论上不该有 —— `gen-relics-inner-from-design` 已卡"每件至少 1 个标签"）时的最后一道 */
export const DEFAULT_ATTRS = [1];

/* ===================================================================
 * 四、红色遗物的「局内开局初始值」（用户口径 ③）
 * =================================================================== */

/**
 * **红件（legendary）词缀**：每件红遗物给**一条**局内开局参数，`code` 取自
 * `common/AchievementEffectMeta.ts` 的 `ACH_EFFECT_CODES`（成就 / 增益券 / 红遗物**共用一套 code 与封顶**——
 * 三者汇总后统一过一遍 `cap`，这是 `docs/meta-growth/README.md` §1.5 定下的口径）。
 *
 * 映射按主标签（`tags[0]`）：**经济线给钱、击杀线给击杀数、输出线给金币/经验加成、防守线给两个折扣**。
 */
export const TAG_RUN_EFFECT = {
    经济成长: 'run_start_gold',
    召唤增殖: 'run_start_kill_points',
    背水血怒: 'run_start_kill_points',
    物理暴击: 'gold_gain_bonus',
    远程点杀: 'gold_gain_bonus',
    弹幕散射: 'gold_gain_bonus',
    法术爆发: 'battle_exp_bonus',
    元素持续: 'battle_exp_bonus',
    坦克反伤: 'kill_buff_discount',
    控制减速: 'shop_draw_discount',
};

/**
 * **三件旧红件保持原词缀**（`docs/meta-growth/README.md` §1.5 已经写进文档、
 * 且 `1190/1194/1202` 的名字与那三条效果一一对得上），其余红件按 `TAG_RUN_EFFECT` 走。
 * 值 = `[code, 每份数值]`（百分比类填**百分数**，与 `ACH_EFFECT_META` 的口径一致）。
 */
export const RUN_EFFECT_OVERRIDE = {
    1190: ['gold_gain_bonus', 5],      // 代达罗斯之殇：击杀金币 +5%
    1194: ['battle_exp_bonus', 5],     // 蝴蝶：局内经验 +5%
    1202: ['hero_start_level', 1],     // 斯嘉蒂之眼：开局英雄等级 +1（次数型，取 max）
};

/** 每条 code 的**每份**数值（`TAG_RUN_EFFECT` 用；百分比类填百分数） */
export const RUN_EFFECT_VALUE = {
    run_start_gold: 10,
    run_start_kill_points: 10,
    gold_gain_bonus: 2,
    battle_exp_bonus: 2,
    kill_buff_discount: 2,
    shop_draw_discount: 2,
    hero_start_level: 1,
};

/* ===================================================================
 * 五、对外 API
 * =================================================================== */

/** 局内属性条目 → `{id, value}` 列表（只认"属性修改"共享模板那条，与 `battle-power` 同口径） */
function innerAttrEntries(row) {
    const out = [];
    for (const m of row.modifiers_inner ?? []) {
        const attrs = m?.kv?.attrs;
        if (!Array.isArray(attrs)) continue;
        for (const e of attrs) {
            if (!Array.isArray(e)) continue;
            out.push({ id: Number(e[0]), value: Number(e[1]), mode: e[2] ?? 'add' });
        }
    }
    return out;
}

/**
 * 这件遗物在局外给哪几条属性（**形状的唯一出处**）。
 * @param {object} row `relics.json` 的一行
 * @returns {number[]} 属性 id（已按 `OUTER_ATTRS` 优先级排序，1~2 条）
 */
export function outerAttrsOf(row) {
    const picked = [];
    for (const e of innerAttrEntries(row)) {
        // ⚠ 负值（代价件的"代价"）不进局外：局外是**永久**收集加成，
        //   一条负的局外加成会跟着账号一辈子（局内的代价只活一局）
        if (!(e.value > 0)) continue;
        if (!OUTER_ATTRS.includes(e.id)) continue;
        if (picked.includes(e.id)) continue;
        picked.push(e.id);
    }
    if (!picked.length) {
        const t = (row.tags ?? [])[0];
        const fb = TAG_FALLBACK_ATTRS[t] ?? DEFAULT_ATTRS;
        return fb.slice(0, OUTER_MAX_ATTRS);
    }
    // 顺序按 `OUTER_ATTRS`（生命 → 魔法 → 攻击 → 护甲 → 回血），多出来的截断
    const sorted = OUTER_ATTRS.filter((a) => picked.includes(a));
    return sorted.slice(0, OUTER_MAX_ATTRS);
}

/** 一条局外属性在这件遗物上的值（`单位值 × 品质权重 × 条数摊薄`，再按属性取整） */
export function outerValueOf(tier, attr, count) {
    const unit = OUTER_UNIT[attr];
    if (!unit) throw new Error(`局外没有登记属性 ${attr} 的单位值（改属性集就要同步 OUTER_UNIT）`);
    const w = OUTER_TIER_WEIGHT[tier] ?? 0;
    if (!w) throw new Error(`未知品质 ${tier}`);
    const share = OUTER_SHARE[count] ?? OUTER_SHARE[OUTER_MAX_ATTRS];
    const raw = unit * w * share;
    if (attr === 6) return Math.round(raw * 10) / 10;      // 护甲 1 位小数
    if (attr === 9) return Math.round(raw * 100) / 100;    // 回血 2 位小数
    return Math.max(1, Math.round(raw));
}

/** 这件遗物的**局外属性条目**：`[[attr, value], ...]`（直接写进 `kv.attrs`） */
export function outerAttrEntries(row) {
    const attrs = outerAttrsOf(row);
    return attrs.map((a) => [a, outerValueOf(row.rarity, a, attrs.length)]);
}

/** 属性中文名（局外描述用；与 `attributes.json` 的 name 对齐，不引入第二套叫法） */
const ATTR_CN = { 1: '最大生命', 2: '最大魔法', 3: '攻击力', 6: '护甲', 9: '生命恢复/秒' };

/** 一条属性的展示文案：`最大生命 +240` / `护甲 +1.8` / `生命恢复/秒 +0.33` */
export function formatOuterAttr(attr, value) {
    const n = String(value);
    return `${ATTR_CN[attr] ?? `属性 ${attr}`} +${n}`;
}

/**
 * 这件红遗物的**开局词缀**（`{code, value}`；非红件返回 null）。
 * @param {object} row
 */
export function outerRunEffectOf(row) {
    if (row.rarity !== 'legendary') return null;
    const ov = RUN_EFFECT_OVERRIDE[row.id];
    if (ov) return { code: ov[0], value: ov[1] };
    const tag = (row.tags ?? [])[0];
    const code = TAG_RUN_EFFECT[tag];
    if (!code) return null;
    return { code, value: RUN_EFFECT_VALUE[code] ?? 1 };
}

/** 词缀的展示文案（与 `common/AchievementEffectMeta.achEffectLabel` 同口径，落表时写死进描述） */
const EFFECT_CN = {
    run_start_gold: '局内初始金币',
    run_start_kill_points: '局内初始击杀',
    gold_gain_bonus: '击杀金币',
    battle_exp_bonus: '局内经验',
    kill_buff_discount: '神器价格',
    shop_draw_discount: '肉鸽抽取费用',
    hero_start_level: '开局英雄等级',
};
const EFFECT_UNIT = { run_start_gold: '', run_start_kill_points: '', gold_gain_bonus: '%', battle_exp_bonus: '%', kill_buff_discount: '%', shop_draw_discount: '%', hero_start_level: '级' };
const EFFECT_PERCENT = new Set(['gold_gain_bonus', 'battle_exp_bonus', 'kill_buff_discount', 'shop_draw_discount']);
/** 折扣类显示负号（口径同 `achEffectLabel`：名字里带"费用/价格"的降 X% 才是好事） */
const EFFECT_DISCOUNT = new Set(['kill_buff_discount', 'shop_draw_discount']);

export function formatRunEffect(code, value) {
    const name = EFFECT_CN[code] ?? code;
    const sign = EFFECT_DISCOUNT.has(code) ? '-' : '+';
    const num = EFFECT_PERCENT.has(code) ? `${Math.abs(value)}%` : `${Math.abs(value)}${EFFECT_UNIT[code] ?? ''}`;
    return `${name} ${sign}${num}`;
}

/** 这件遗物的局外描述（`最大生命 +16；护甲 +0.5；击杀金币 +2%`） */
export function outerDescriptionOf(row) {
    const parts = outerAttrEntries(row).map(([a, v]) => formatOuterAttr(a, v));
    const eff = outerRunEffectOf(row);
    if (eff) parts.push(formatRunEffect(eff.code, eff.value));
    return parts.join('；');
}

/**
 * 这件遗物的**局外效果**（`modifiers_outer`）：纯属性一条 + 红件词缀一条。
 *
 * ⚠ 词缀**不是** Modifier（它在开局快照里被读走，不是挂在实体上的被动），所以单列一列
 * `effects_outer`，由 `Scene_Game_Stage.snapshotAchieveEffects()` 合并进开局快照 ——
 * 写成 Modifier 会变成"战斗里挂一个没人读的被动"。
 */
export const MODIFY_ATTR_TEMPLATE_ID = 1000;

export function outerModifiersOf(row) {
    const entries = outerAttrEntries(row);
    return entries.length
        ? [{ modifier: MODIFY_ATTR_TEMPLATE_ID, duration: null, kv: { attrs: entries } }]
        : [];
}

/** 这件遗物的 `effects_outer` 列（没有词缀 = 空数组；**不写 null**，空数组更好比） */
export function outerEffectsOf(row) {
    const eff = outerRunEffectOf(row);
    return eff ? [{ code: eff.code, value: eff.value }] : [];
}

/** 供体检/报告使用：局内设计里的品质摘要（避免两处各写一份档位表） */
export const OUTER_TIERS = Object.keys(OUTER_TIER_WEIGHT);
/** 复用的局内常量（报告里打印"与局内预算表的比例"时用） */
export { ATTR_VALUE, roundAttrValue, MAX_ATTRS_PER_RELIC };
