/**
 * affix-rules.mjs —— 「品质 × 词条」门禁规则**单一真源**（工具侧）
 *
 * 本文件是 `docs/配置规则_品质与词条门禁.md` 的代码化版本：文档讲设计意图，这里讲可执行口径。
 * 迁移脚本（migrate-affix-gating.mjs）与校验脚本（check-affix-gating.mjs）**都只 import 本文件**，
 * 不允许各自抄一份阈值 —— 改规则只改这里 + 同步文档。
 *
 * 规则速览（2026-07 定案）：
 *   1. 品质全局统一 **4 档**：白(common) / 蓝(rare) / 黄(epic) / 红(legendary)。
 *      局外装备的 `quality` 数字与遗物的 `rarity` 枚举一一对应（见 QUALITY_TIERS）。
 *   2. 词条按「是不是百分比」分四类，各自有最低品质档：
 *        · 数值属性 + 固定值（攻击值/生命值…）→ 白档起（**所有品质都能给，只是多少不同**）
 *        · 百分比属性（对基础值乘算）      → 黄档起
 *        · 百分比型属性（攻速/魔抗/闪避/暴率…，值本身就是百分比）→ 黄档起
 *        · 功能性固定值（击杀金币 +2…）    → 蓝档起
 *        · 功能性百分比（金币获取 +13%…）  → 红档起（最高品质专属）
 *   3. 语义陷阱：**百分比型属性禁止用 `percent` 叠加**（闪避/暴率等基础值为 0 → percent 恒为 0）。
 *      百分比型属性一律用 `add`，配置值 = 百分点（`[14, 10, "add"]` = 暴击率 +10%）。
 *   4. **一件遗物一行**（2026-07 改造）：局内版与局外版共用 `id`/`name`/`icon`/`rarity`，
 *      只有 `modifiers_inner`/`description_inner` 与 `modifiers_outer`/`description_outer` 分两侧，
 *      `scope` 说明这件遗物在哪几侧出现（见 §5.5）。
 */

// ============================ 1. 品质 4 档 ============================

/**
 * 全局品质阶梯（唯一权威）。
 * `quality` 用于装备表（数字），`key` 用于遗物/技能表（枚举），`tier` 用于一切门禁判定。
 */
export const QUALITY_TIERS = [
    { tier: 1, key: 'common', quality: 1.0, label: '白', color: '#DDDDDD' },
    { tier: 2, key: 'rare', quality: 1.3, label: '蓝', color: '#5096FF' },
    { tier: 3, key: 'epic', quality: 1.6, label: '黄', color: '#CF68FF' },
    { tier: 4, key: 'legendary', quality: 2.0, label: '红', color: '#FF6464' },
];

/** 装备 quality 数字 → 档位序号（旧 2.5「独特」已并入红档） */
export const QUALITY_TO_TIER = { 1: 1, 1.3: 2, 1.6: 3, 2: 4, 2.5: 4 };

/** 遗物/技能 rarity 枚举 → 档位序号 */
export const RARITY_TO_TIER = { common: 1, rare: 2, epic: 3, legendary: 4 };

/** 档位序号 → rarity 枚举 / quality 数字 */
export const TIER_TO_RARITY = { 1: 'common', 2: 'rare', 3: 'epic', 4: 'legendary' };
export const TIER_TO_QUALITY = { 1: 1.0, 2: 1.3, 3: 1.6, 4: 2.0 };

/** 装备表允许出现的 quality 值（4 档，别的都是违规） */
export const ALLOWED_QUALITY = [1, 1.3, 1.6, 2];

/** 档位序号 → 中文档名（报告用） */
export const TIER_LABEL = { 1: '白(common)', 2: '蓝(rare)', 3: '黄(epic)', 4: '红(legendary)' };

// ============================ 2. 属性分类 ============================

/**
 * **数值属性**：配置值就是原值，可做固定值加成。
 * 对齐 `attributes.json` 与 `battle/core/Types.ts` 的 AttributeType。
 */
export const NUMERIC_ATTRS = [1, 2, 3, 5, 6, 9, 10, 16];

/**
 * **百分比型属性**：配置值 = 实际值 × 100（100 = 100%），必须用 `add` 叠加。
 * 与 `battle/core/AttributeScaling.ts` 的 SCALE 表**逐项对齐**，改那边要改这里。
 */
export const PERCENT_ATTRS = [4, 7, 8, 11, 12, 13, 14, 15];

/** 属性编号 → 显示名（报告/描述文案用） */
export const ATTR_NAME = {
    1: '最大生命', 2: '最大魔法', 3: '攻击力', 4: '攻击速度', 5: '移动速度', 6: '护甲',
    7: '魔法抗性', 8: '闪避', 9: '生命恢复', 10: '魔法恢复', 11: '伤害输出',
    12: '物理受伤', 13: '魔法受伤', 14: '暴击率', 15: '暴击伤害', 16: '攻击距离',
};

/** 该属性是不是百分比型（值本身即百分比） */
export function isPercentAttr(attrId) {
    return PERCENT_ATTRS.includes(attrId);
}

/**
 * **基础值为 0 的数值属性** —— 对齐 `attributes.json` 的 `base`（改那边要改这里）：
 *   护甲(6) / 生命恢复(9) / 魔法恢复(10) 的 base 都是 **0**。
 *
 * 为什么单独列出来：英雄条目在 2026-07 收口后不再配这三项（`base_attributes` 只允许 1/2/3/4/16），
 * 它们的实际基础值就回落成 0 —— 此时 `percent` 算出来是 `0 × (1+Σv/100) = 0`，**词条恒不生效**
 * （踩过：传说「统御头盔」护甲 +22% → 属性系统里护甲仍是 0）。
 * 与「百分比型属性禁止 percent」同源的铁律：**base=0 的属性一律用 `add` 给固定值**。
 */
export const ZERO_BASE_ATTRS = [6, 9, 10];

/** 该属性是不是「基础值为 0」的数值属性（percent 对它恒为 0） */
export function isZeroBaseAttr(attrId) {
    return ZERO_BASE_ATTRS.includes(attrId);
}

// ============================ 3. 门禁矩阵 ============================

/**
 * 词条类别 → 最低品质档。
 * `attr` = 属性词条（走 kv.attrs）；`functional` = 功能性词条（走 Modifier 的 events/effects，schema 暂无独立列）。
 */
export const MIN_TIER_BY_AFFIX = {
    /** 数值属性 + 固定值：白档起（攻击值/生命值，只是多少不同） */
    numeric_flat: 1,
    /** 数值属性 + 百分比加成：黄档起 */
    numeric_percent: 3,
    /** 百分比型属性 + 固定值（百分点）：黄档起 */
    percent_attr_flat: 3,
    /** 功能性固定值（击杀金币 +2）：蓝档起 */
    functional_flat: 2,
    /** 功能性百分比（金币获取 +13%）：红档起，最高品质专属 */
    functional_percent: 4,
};

/**
 * 判定一条**属性词条** `[attrId, value, mode?]` 的类别与最低档位。
 * @returns {{ kind: string, minTier: number, violation?: string }}
 */
export function classifyAttrAffix(attrId, mode) {
    const effective = mode ?? 'add';

    if (isPercentAttr(attrId)) {
        if (effective === 'percent') {
            // 语义陷阱：闪避/暴率等基础值为 0，percent 恒为 0（魔抗等虽非 0，但语义与 add 重复且易错）
            return {
                kind: 'percent_attr_percent',
                minTier: MIN_TIER_BY_AFFIX.percent_attr_flat,
                violation: `百分比型属性（${ATTR_NAME[attrId] ?? attrId}）禁止用 percent 叠加，请改用 add（配置值 = 百分点）`,
            };
        }
        return { kind: 'percent_attr_flat', minTier: MIN_TIER_BY_AFFIX.percent_attr_flat };
    }

    if (effective === 'percent') {
        if (isZeroBaseAttr(attrId)) {
            // 语义陷阱（同「百分比型属性禁止 percent」）：base=0 → percent 恒为 0
            return {
                kind: 'numeric_percent_zero_base',
                minTier: MIN_TIER_BY_AFFIX.numeric_percent,
                violation: `属性「${ATTR_NAME[attrId] ?? attrId}」的基础值是 0，percent 乘出来恒为 0（0×(1+v)），`
                    + `请改用 add 给固定值（折算基准见 FLAT_CONVERT_BASELINE）`,
            };
        }
        return { kind: 'numeric_percent', minTier: MIN_TIER_BY_AFFIX.numeric_percent };
    }
    if (effective === 'multiply') {
        // multiply = 复利，全项目禁用（见 AGENTS.md 数值口径）
        return {
            kind: 'numeric_multiply',
            minTier: 4,
            violation: `属性（${ATTR_NAME[attrId] ?? attrId}）用了 multiply（复利）叠加，项目口径禁用，请用 percent 或 add`,
        };
    }
    return { kind: 'numeric_flat', minTier: MIN_TIER_BY_AFFIX.numeric_flat };
}

// ============================ 4. 折算基准（percent → 固定值） ============================

/**
 * 低品质把 `percent` 折算成固定值时的**基准值**（= 100% 对应多少白值）。
 *
 * 取值口径：4 个现役英雄 Lv.1~Lv.10 该属性的中位量级，取整便于复核
 * （见 docs/数值配置参考手册.md §4.2）。低档遗物因此「前期基本持平、后期自然稀释」——
 * 这正是「低档给固定值、高档给百分比」的设计意图。
 */
export const FLAT_CONVERT_BASELINE = {
    1: 500,   // 最大生命：320/520/340/560 → 取整
    2: 150,   // 最大魔法：120/100/220/80
    3: 60,    // 攻击力：40/200/26/34，按 Lv.10 中位量级上调
    5: 300,   // 移动速度：attributes.json base
    6: 10,    // 护甲：手册 §4.2 区间上沿（基础 0 —— percent 对护甲完全无效，必须折固定值）
    9: 2,     // 生命恢复/秒：1~3
    10: 2,    // 魔法恢复/秒：同回血
    16: 300,  // 攻击距离：200~600
};

/**
 * 暴击的**数值合同**（与 `attributes.json` 的属性 15 对齐）：
 *   · 配置值 int = 倍率 × 100（`225` = 225%），与 `AttributeScaling.SCALE[15] = 100` 一致；
 *   · base = **150**（1.5 倍）。**不能是 100**：`DamagePipeline.rollCrit` 要求 `倍率 > 1` 才可能暴击，
 *     base = 100 → 1.0 → 全项目永远不暴击（暴击率词条纯装饰，体检实测过）；
 *   · 词条的叠加方式必须显式写 `best`（`CRIT_MULT_MODE`）—— **条目 mode 会覆盖属性默认 mode**，
 *     写 `add` 就变成 `base + Σv` 累加（`+225%` 会算成 1.5 + 2.25 = 375%，实测踩过），
 *     `best` 才是「取最强的一件暴击装生效」（Dota 语义）。
 *     ⚠ 所以暴击倍率词条要写**绝对倍率的百分点**：`[15, 225, "best"]` = 暴击造成 225% 伤害。
 */
export const CRIT_MULT_ATTR = 15;
export const CRIT_MULT_BASE = 150;
/** 暴击倍率词条的叠加方式（见上：必须显式 best，不能靠属性默认值） */
export const CRIT_MULT_MODE = 'best';

/**
 * 描述文案里的「暴击倍率 +X%」→ 属性 15 的配置值（**绝对倍率的百分点**，配合 `CRIT_MULT_MODE = best`）。
 *   · `X >= 100` → 视为**绝对倍率**（`+225%` → 225，即暴击造成 225% 伤害 —— 代达罗斯之殇的 Dota 口径）
 *   · `X < 100`  → 视为**相对加成**（`+80%` → 180，即 100% + 80%）
 * 两种写法在现表里都出现过，取到的都是"暴击时的伤害百分比"，与玩家预期一致。
 */
export function critTextToMultiplier(textValue) {
    const v = Number(textValue) || 0;
    return v >= 100 ? v : 100 + v;
}

/**
 * 折算结果取整的属性（生命/魔法/攻击/移速/射程 —— 这些属性在配置里就是整数量级）；
 * 其余（护甲/回血/回蓝）保留 2 位小数，因为它们的白值本来就是小数。
 */
export const INTEGER_FLAT_ATTRS = [1, 2, 3, 5, 16];

/**
 * `percent` 值（14 = +14%）→ 固定值。
 */
export function percentToFlat(attrId, percentValue) {
    const base = FLAT_CONVERT_BASELINE[attrId];
    if (base === undefined) return undefined;
    const raw = (percentValue / 100) * base;
    return INTEGER_FLAT_ATTRS.includes(attrId) ? Math.round(raw) : Math.round(raw * 100) / 100;
}

// ============================ 5. 局外/局内专属（待定） ============================

/**
 * 词条作用域 —— **设计未定，先留钩子，禁止在配置里凭空使用**。
 *
 * 用户口径（2026-07）：有些功能性词条只能局外获得、有些只能局内获得，具体哪些还没想好。
 * 已确定的**方向性约束**：
 *   · `outer`（局外永久）：攻速永远不给（数值配置手册 §4.3 铁律）——攻速是局内构筑杠杆；
 *     局外总量封顶 +50% 永久乘区，低档只给固定值正是这条的落地手段。
 *   · `inner`（局内本局）：攻速/大量百分比可以给，但受黄档起、红档起的功能百分比门禁约束。
 *   · 写死前必须先在 `docs/配置规则_品质与词条门禁.md` 的「§5 专属词条清单」里登记。
 */
export const AFFIX_SCOPE = {
    outer: 'outer',
    inner: 'inner',
    both: 'both',
};

/** 已登记的作用域清单（key = 词条标识，value = {scope, tier, note}）。**故意留空**：待策划定案后逐条登记。 */
export const AFFIX_SCOPE_REGISTRY = {};

// ============================ 5.5 遗物两侧（局内版 / 局外版） ============================

/**
 * 遗物作用域枚举（`relics.scope`）。
 *
 * 2026-07 改造后语义变了：由「**这一行**属于哪一侧」改为「**这件遗物**在哪几侧出现」——
 * 局内局外是同一件遗物，身份列（`id` / `name` / `code` / `icon` / `rarity` / `category`）共用，
 * 只有 `modifiers_inner` / `description_inner` 与 `modifiers_outer` / `description_outer` 分两侧。
 *
 *   · `inner` = 只有局内版（进肉鸽商店抽取池）
 *   · `outer` = 只有局外版（跨局永久收集）
 *   · `both`  = 两侧都有（同一件遗物的两套效果）
 */
export const RELIC_SCOPES = ['inner', 'outer', 'both'];

/** 这件遗物有局内版吗 */
export function hasInnerSide(relic) {
    const s = (relic && relic.scope) || 'inner';
    return s === 'inner' || s === 'both';
}

/** 这件遗物有局外版吗 */
export function hasOuterSide(relic) {
    return !!relic && (relic.scope === 'outer' || relic.scope === 'both');
}

/**
 * 取一件遗物在某一侧的效果。
 * @param {'inner'|'outer'} side
 * @returns {{side: string, label: string, modifiers: any[], description: string}}
 */
export function relicSide(relic, side) {
    const isInner = side === 'inner';
    const mods = isInner ? relic?.modifiers_inner : relic?.modifiers_outer;
    const desc = isInner ? relic?.description_inner : relic?.description_outer;
    return {
        side,
        label: isInner ? '局内' : '局外',
        modifiers: Array.isArray(mods) ? mods : [],
        description: typeof desc === 'string' ? desc : '',
    };
}

/** 这件遗物实际存在的所有侧（`scope="both"` 时是 `[局内版, 局外版]`） */
export function relicSides(relic) {
    const out = [];
    if (hasInnerSide(relic)) out.push(relicSide(relic, 'inner'));
    if (hasOuterSide(relic)) out.push(relicSide(relic, 'outer'));
    return out;
}

// ============================ 6. 描述文案的词条解析/生成 ============================

/** 描述文案里的属性名（含设计稿简称）→ AttributeType 编号 */
export const DESC_ATTR_ALIAS = {
    最大生命: 1, 生命: 1, 最大魔法: 2, 魔法: 2, 攻击力: 3, 攻击速度: 4, 攻速: 4,
    移动速度: 5, 移速: 5, 护甲: 6, 魔法抗性: 7, 魔抗: 7, 闪避: 8, 闪避几率: 8,
    生命恢复: 9, 回复: 9, 生命回复: 9, 魔法恢复: 10, 魔法回复: 10, 伤害输出: 11,
    物理受伤: 12, 魔法受伤: 13, 暴击: 14, 暴击率: 14, 暴击伤害: 15, 暴击倍率: 15,
    攻击距离: 16, 攻击范围: 16,
};

/** 暂无 AttributeType 的**功能性百分比**词条名（最高品质红档专属） */
export const FUNCTIONAL_PERCENT_NAMES = ['冷却', '冷却缩减', '金币获取', '金钱获取', '元素强度', '召唤物强度'];
/** 暂无 AttributeType 的**功能性固定值**词条名（蓝档起） */
export const FUNCTIONAL_FLAT_NAMES = ['每分钟金钱', '每秒金钱', '击杀金币', '击杀获得金币', '视野'];

/** 单条描述词条：`攻击力 +14%` / `生命恢复 +0.15/s` / `护甲 +12%` */
export const TERM_RE = /^(.+?)\s*([+＋-])?\s*([\d.]+)\s*(%?)(\/s)?$/;

/**
 * 解析一条描述词条 → { kind: 'attr'|'functional_percent'|'functional_flat'|'unknown', attrId?, value?, percent?, raw }
 * 仅用于**文案**解析（不进战斗逻辑）；`kind='unknown'` 表示机制参数/被动名等非词条文本。
 */
export function parseTerm(raw) {
    const text = String(raw).trim();
    const m = TERM_RE.exec(text);
    if (!m) return { kind: 'unknown', raw: text };
    const name = m[1].trim();
    const sign = m[2] === '-' ? -1 : 1;
    const value = Number(m[3]) * sign;
    const percent = m[4] === '%';
    if (DESC_ATTR_ALIAS[name] !== undefined) {
        return { kind: 'attr', attrId: DESC_ATTR_ALIAS[name], value, percent, raw: text };
    }
    if (FUNCTIONAL_PERCENT_NAMES.includes(name)) return { kind: 'functional_percent', name, percent, value, raw: text };
    if (FUNCTIONAL_FLAT_NAMES.includes(name)) return { kind: 'functional_flat', name, percent, value, raw: text };
    return { kind: 'unknown', raw: text };
}

/** 一个「属性块」= 若干 `|` 分隔的词条，且每条都能识别；否则返回 null（说明这段是机制原文） */
export function parseTermBlock(seg) {
    const terms = String(seg).split('|').map(parseTerm);
    return terms.every((t) => t.kind !== 'unknown') ? terms : null;
}

/**
 * 由属性词条生成描述文案（`|` 两侧留空格，`；` 不留 —— 与设计稿原文一致）。
 * @param attrs [[attrId, value, mode], ...]
 */
export function formatTerms(attrs, sep = '；') {
    const glue = sep === '|' ? ' | ' : '；';
    return attrs
        .map(([id, value, mode]) => {
            const name = ATTR_NAME[id] ?? `属性${id}`;
            const isPct = isPercentAttr(id) || (mode ?? 'add') === 'percent';
            const unit = isPct ? '%' : (id === 9 || id === 10 ? '/s' : '');
            const sign = value >= 0 ? '+' : '';
            return `${name} ${sign}${value}${unit}`;
        })
        .join(glue);
}

// ============================ 7. 工具函数 ============================

/** 无 AttributeType 的遗留属性编号（配置里出现只报警告、不生效；见 AGENTS.md 遗留噪声） */
export const LEGACY_ATTR_IDS = [17, 18, 19, 20];

/**
 * 配置表里的属性键 → 编号：兼容
 *   · `ConfigLoader.nameToAttrId` 的驼峰/下划线写法（`maxHp` / `atkSpeed` / `critRate`…）
 *   · 描述文案里的中文名与简称（`攻击力` / `攻速` / `闪避`…）
 */
export const CONFIG_ATTR_ALIAS = {
    maxHp: 1, max_hp: 1, maxMana: 2, max_mana: 2,
    atk: 3, attack_damage: 3, atkSpeed: 4, attack_speed: 4,
    moveSpeed: 5, move_speed: 5, def: 6, armor: 6,
    magicResist: 7, magic_resist: 7, dodge: 8, evasion: 8,
    hpRegen: 9, hp_regen: 9, manaRegen: 10, mana_regen: 10,
    damageOut: 11, incomingPhysical: 12, incomingMagical: 13,
    critRate: 14, crit_chance: 14, critDmg: 15, crit_multiplier: 15,
    atkRange: 16, attack_range: 16,
    lightningDmg: 17, poisonDmg: 18, burnDmg: 19, freezeDuration: 20,
    ...DESC_ATTR_ALIAS,
};

/** 属性键（数字字符串 / 驼峰 / 中文名）→ AttributeType 编号；无法识别返回 undefined */
export function resolveAttrId(key) {
    const n = Number(key);
    if (!Number.isNaN(n)) return n;
    return CONFIG_ATTR_ALIAS[key];
}

/** **运行时 float → 配置 int**（百分比型属性 ×100：0.08 → 8；其余原值） */
export function toConfigInt(attrId, runtimeValue) {
    return isPercentAttr(attrId) ? Math.round(runtimeValue * 100) : runtimeValue;
}

/** **配置 int → 运行时 float**（百分比型属性 ÷100：8 → 0.08；其余原值） */
export function toRuntimeValue(attrId, configValue) {
    return isPercentAttr(attrId) ? configValue / 100 : configValue;
}

/** 属性名按长度倒序（正则交替时长的优先，避免「攻击力」被「攻击」抢先匹配） */
const DESC_ATTR_NAMES = Object.keys(DESC_ATTR_ALIAS).sort((a, b) => b.length - a.length).join('|');

/**
 * 从一个**描述子句**里抽出属性词条，兼容两种写法：
 *   · 名称在前：`攻击力 +8` / `最大生命 +90` / `闪避 +8%`
 *   · 数值在前：`+0.1 攻击速度` / `+2m 攻击范围`
 * @returns {{attrId:number, value:number, percent:boolean}[]}
 */
export function parseClauseTerms(clause) {
    const text = String(clause ?? '');
    const out = [];
    const reNameFirst = new RegExp(`(${DESC_ATTR_NAMES})\\s*([+＋-]?\\s*[\\d.]+)\\s*(%?)`, 'g');
    const reValueFirst = new RegExp(`([+＋-]?\\s*[\\d.]+)\\s*(%?)\\s*(${DESC_ATTR_NAMES})`, 'g');
    let m;
    while ((m = reNameFirst.exec(text)) !== null) {
        out.push({ attrId: DESC_ATTR_ALIAS[m[1]], value: Number(String(m[2]).replace(/[+＋\s]/g, '')) , percent: m[3] === '%' });
    }
    while ((m = reValueFirst.exec(text)) !== null) {
        const num = Number(String(m[1]).replace(/[+＋\s]/g, ''));
        out.push({ attrId: DESC_ATTR_ALIAS[m[3]], value: (String(m[1]).trim().startsWith('-') ? -num : num), percent: m[2] === '%' });
    }
    return out;
}

/**
 * 找出描述里**当前品质档位不允许**的属性词条子句（低档文案清理 / 校验提醒共用）。
 * 语义与 kv.attrs 的门禁完全一致：百分比型属性、以及「数值属性 + %」都要黄档起。
 * @returns {string[]} 违规子句原文
 */
export function illegalDescriptionClauses(desc, tier) {
    if (!desc) return [];
    const bad = [];
    for (const clause of String(desc).split(/[，、；]/)) {
        if (!clause.trim()) continue;
        for (const t of parseClauseTerms(clause)) {
            const mode = (t.percent && !isPercentAttr(t.attrId)) ? 'percent' : 'add';
            if (tier < classifyAttrAffix(t.attrId, mode).minTier) {
                bad.push(clause.trim());
                break;
            }
        }
    }
    return bad;
}

/** 从描述里删掉指定子句（用来清低档不该出现的属性文案），返回新描述 */
export function dropDescriptionClauses(desc, clauses) {
    if (!desc || !clauses.length) return desc;
    const drop = new Set(clauses);
    return String(desc)
        .split(/[，、；]/)
        .map((s) => s.trim())
        .filter((s) => s && !drop.has(s))
        .join('，');
}

/**
 * 从**某一侧**的 modifiers 数组里摊平出全部属性词条 `[attrId, value, mode]`（会带出来源 modifier id）。
 * @param {any[]} modifiers 遗物的 `modifiers_inner` 或 `modifiers_outer`（见 relicSide）
 */
export function collectRelicAttrs(modifiers) {
    const out = [];
    for (const m of modifiers ?? []) {
        for (const a of m?.kv?.attrs ?? []) out.push({ attr: a, modifier: m.modifier });
    }
    return out;
}

/** 遗物 rarity → 档位序号（未知返回 0） */
export function tierOfRarity(rarity) {
    return RARITY_TO_TIER[rarity] ?? 0;
}

/** 装备 quality → 档位序号（未知返回 0；旧 2.5 归红档） */
export function tierOfQuality(quality) {
    return QUALITY_TO_TIER[quality] ?? 0;
}

/** 格式化一条属性词条为描述文案，如「攻击力 +8」「暴击率 +10%」 */
export function formatAttrAffix(attrId, value, mode) {
    return formatTerms([[attrId, value, mode]], '；');
}
