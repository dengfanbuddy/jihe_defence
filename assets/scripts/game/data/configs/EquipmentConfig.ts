/**
 * EquipmentConfig.ts — 局外装备配置门面（数据源：`relics.json` 里**有局外版**的遗物，`scope` = `outer` / `both`）
 *
 * ## 2026-07 变更：遗物表改成「一件遗物一行」
 *
 * 局内版与局外版**本质是同一件遗物的两个作用域**，因此共用一行、共用 id / name / icon / 品质，
 * 只有效果与描述分两侧：`modifiers_outer` / `description_outer` 就是本文件读的「局外装备」。
 * 原 `equipments.json` / `equipments.xlsx` / `Tb_EquipmentConfig` 已删除；
 * 英雄专属装备（`code=spc_*` + `hero_id`）也已按「无英雄专属」的口径删除。
 * id 段：局内道具 **1001~1293**（两侧都有的用局内 id）+ 仅局外 **1294~1302** + 手工 demo 1~5。
 *
 * ## 数值口径（两套，别混）
 *
 * | 位置 | 百分比型属性（攻速 4 / 魔抗 7 / 闪避 8 / 倍率 11~13 / 暴率 14 / 暴伤 15） |
 * |---|---|
 * | `relics.kv.attrs` | **配置 int**：`100 = 100%`（`[8, 8, "add"]` = 闪避 +8%） |
 * | `OuterBonusGroup`（本文件产出） | **运行时 float**：`0.08 = 8%` |
 *
 * `OuterAttributeCalculator` 用 `final = base × (1 + percent) + flat`，
 * 其中 `percent` 是**小数**（`0.05 = +5%`）、`flat` 是运行时值。本文件负责 int → float 与分层。
 * 分层遵循「品质 × 词条」门禁（docs/配置规则_品质与词条门禁.md）：`percent` 加成需**黄档（epic）起**。
 *
 * > ⚠ 该链路目前**尚未接线**（`OuterAttributeCalculator` 没有运行时消费点、`EquipmentCollection.addCollected` 无调用方）：
 * > 「框架已备、待接入」，见《数值配置参考手册》§3.3.2。
 */

import { TbRoot } from "../../../platform/excel_table/TbRoot";
import { AttributeType, EquipmentConfig, OuterBonusGroup } from "../../battle/core/Types";
import { AttributeCfgContainer } from "../../excel_table/Tb_AttributeConfig";
import { RelicCfgContainer, RelicCfg, relicHasOuter, relicOuterDesc, relicOuterModifiers, getOuterRelicCfgs } from "../../excel_table/Tb_RelicConfig";
import { DataCenter } from "../DataCenter";

/** 遗物 rarity → 品质档位序号（1 白 / 2 蓝 / 3 黄 / 4 红） */
const RARITY_TIER: Record<string, number> = { common: 1, rare: 2, epic: 3, legendary: 4 };
/** 档位序号 → 旧装备 `quality` 数字（保持对外契约：1 / 1.3 / 1.6 / 2） */
const TIER_QUALITY = [0, 1, 1.3, 1.6, 2];
/** `percent` 加成（对基础属性乘算）的最低档位：黄档 */
const PERCENT_LAYER_MIN_TIER = 3;
/** 百分比型属性编号（与 battle/core/AttributeScaling.SCALE 逐项对齐） */
const PERCENT_ATTR_IDS = [4, 7, 8, 11, 12, 13, 14, 15];

/** 配置 int → 运行时 float（百分比型属性 ÷100） */
function toRuntime(attrId: number, configValue: number): number {
    return PERCENT_ATTR_IDS.indexOf(attrId) >= 0 ? configValue / 100 : configValue;
}

/** 取 relics 表里所有**有局外版**的遗物（scope = outer / both）—— 过滤口径在表文件里，只有一份 */
export function getOuterRelics(): RelicCfg[] {
    return getOuterRelicCfgs();
}

/** 按 id 取局外版遗物（没有局外版的遗物返回 undefined） */
export function getOuterRelic(equipId: number): RelicCfg | undefined {
    const item = TbRoot.ins.getTbContainer(RelicCfgContainer).getCfgById(equipId);
    return item && relicHasOuter(item) ? item : undefined;
}

/**
 * 局外版遗物 → `OuterBonusGroup`（flat / percent 两层）。读的是 **`modifiers_outer`**。
 *
 * 分层口径（按门禁规则，而不是「品质高就全都乘算」）：
 *   · `add`（固定值）→ `flat`，值换算成运行时 float（闪避 8 → 0.08）
 *   · `percent`（对基础属性乘算）→ `percent`，值是**百分数**（14 → 0.14），且需黄档起；
 *     低档出现 percent 会被降级为 flat 并 warn
 *   · 百分比型属性一律应写 `add`（其基础值为 0，percent 乘出来恒为 0）
 *
 * ⚠ 历史坑：旧 `equipments.json` 用 `quality ≥ 2.5 → 该件所有属性都进 percent 层`，
 * 把 `atk: 30` 当成 3000% 的乘区 —— 现在所有属性都以 `[id, 值, 叠加方式]` 明确表达，坑已消失。
 */
export function relicToBonusGroup(relic: RelicCfg): OuterBonusGroup {
    const group: OuterBonusGroup = { flat: {}, percent: {} };
    const tier = RARITY_TIER[relic.rarity] ?? 0;
    const percentAllowed = tier >= PERCENT_LAYER_MIN_TIER;

    for (const m of relicOuterModifiers(relic)) {
        const attrs = (m?.kv?.attrs ?? []) as Array<[number, number, (string | undefined)?]>;
        for (const entry of attrs) {
            if (!Array.isArray(entry)) continue;
            const attrId = Number(entry[0]);
            const value = Number(entry[1]);
            const mode = entry[2] ?? 'add';
            if (!Number.isFinite(attrId) || !Number.isFinite(value) || value === 0) continue;

            if (mode === 'percent') {
                if (!percentAllowed) {
                    console.warn(`[局外] 遗物 id=${relic.id} 品质档位不足（${relic.rarity}），属性 ${attrId} 的 percent 加成已降级为固定值`);
                    group.flat[attrId as AttributeType] = (group.flat[attrId as AttributeType] ?? 0) + toRuntime(attrId, value);
                    continue;
                }
                // percent 的配置值是百分数（14 = +14%），运行时层要小数（0.14）
                group.percent[attrId as AttributeType] = (group.percent[attrId as AttributeType] ?? 0) + value / 100;
                continue;
            }

            if (mode !== 'add') {
                console.warn(`[局外] 遗物 id=${relic.id} 属性 ${attrId} 的叠加方式 "${mode}" 不支持（局外只用 add / percent），按固定值处理`);
            }
            group.flat[attrId as AttributeType] = (group.flat[attrId as AttributeType] ?? 0) + toRuntime(attrId, value);
        }
    }

    return group;
}

/* ===================================================================
 * 兼容层：原 equipment 形态的查询（局外收集系统按原样调用即可）
 * =================================================================== */

/** 局外版遗物 → 旧 `EquipmentConfig` 形态（quality / attributes / bonusTypes…） */
function relicToEquipmentConfig(r: RelicCfg): EquipmentConfig {
    const tier = RARITY_TIER[r.rarity] ?? 1;
    const attributes: [number, number][] = [];
    const bonusTypes: [number, 'flat' | 'percent'][] = [];

    for (const m of relicOuterModifiers(r)) {
        const attrs = (m?.kv?.attrs ?? []) as Array<[number, number, (string | undefined)?]>;
        for (const entry of attrs) {
            if (!Array.isArray(entry)) continue;
            const attrId = Number(entry[0]);
            const value = Number(entry[1]);
            if (entry[2] === 'percent') {
                attributes.push([attrId, value / 100]);
                bonusTypes.push([attrId, 'percent']);
            } else {
                attributes.push([attrId, toRuntime(attrId, value)]);
                bonusTypes.push([attrId, 'flat']);
            }
        }
    }

    return {
        id: r.id,
        name: r.name,
        description: relicOuterDesc(r),
        category: r.category ?? 'd2_basic',
        quality: TIER_QUALITY[tier] ?? 1,
        attributes,
        bonusTypes,
    };
}

/** 根据 ID 获取局外装备配置（没有局外版的遗物返回 undefined） */
export function getEquipmentConfig(equipId: number): EquipmentConfig | undefined {
    const relic = getOuterRelic(equipId);
    return relic ? relicToEquipmentConfig(relic) : undefined;
}

/** 获取所有局外装备列表 */
export function getAllEquipments(): EquipmentConfig[] {
    return getOuterRelics().map(relicToEquipmentConfig);
}

/** 按装备类别筛选（category 列：d2_basic / d2_upgrade / d2_neutral） */
export function getEquipmentsByCategory(category: string): EquipmentConfig[] {
    return getOuterRelics()
        .filter((r) => r.category === category)
        .map(relicToEquipmentConfig);
}

/** 按品质筛选（minQuality 用旧装备口径：1 / 1.3 / 1.6 / 2） */
export function getEquipmentsByQuality(minQuality: number): EquipmentConfig[] {
    return getAllEquipments().filter((e) => (e.quality ?? 0) >= minQuality);
}

/** 旧装备 `quality` 数字 → 档位序号（2.5 旧「独特」并入红档；未知返回 0） */
const QUALITY_TIER: Record<string, number> = { '1': 1, '1.3': 2, '1.6': 3, '2': 4, '2.5': 4 };
function tierOfQuality(quality: number): number {
    return QUALITY_TIER[String(quality)] ?? 0;
}

/**
 * 旧形态配置 → `OuterBonusGroup`（`attributes` + `bonusTypes`）。
 * 新代码优先用 `relicToBonusGroup(遗物条目)`（能表达同一属性的 add + percent 双条目）。
 */
export function equipmentConfigToBonuses(config: EquipmentConfig): OuterBonusGroup {
    const group: OuterBonusGroup = { flat: {}, percent: {} };
    const tier = tierOfQuality(config.quality);
    const percentAllowed = tier >= PERCENT_LAYER_MIN_TIER;

    if (tier === 0) {
        console.warn(`[局外装备] id=${config.id} quality=${config.quality} 不在 4 档（1/1.3/1.6/2）内，按最低档处理`);
    }

    for (const [attrId, value] of config.attributes) {
        if (!value) continue;
        const declared = (config.bonusTypes ?? []).find(([id]) => id === attrId)?.[1];
        if (declared === 'percent') {
            if (!percentAllowed) {
                console.warn(`[局外装备] id=${config.id} 品质档位不足（quality=${config.quality}），属性 ${attrId} 的 percent 加成已降级为固定值`);
                group.flat[attrId as AttributeType] = (group.flat[attrId as AttributeType] ?? 0) + value;
            } else {
                group.percent[attrId as AttributeType] = (group.percent[attrId as AttributeType] ?? 0) + value;
            }
        } else {
            group.flat[attrId as AttributeType] = (group.flat[attrId as AttributeType] ?? 0) + value;
        }
    }
    return group;
}

/**
 * 获取所有已收集局外装备的总加成组。
 * 从 `DataCenter.ins.equipCollection` 读取收集记录（**存的是 relics 的遗物 id**，与局内是同一个 id 空间：
 * 两侧都有的用局内 id，只有局外版的在 1294~1302），每件装备的加成 × 收集次数（可重复收集，属性累加）。
 */
export function getAllEquipmentBonuses(): OuterBonusGroup {
    const total: OuterBonusGroup = { flat: {}, percent: {} };

    const collection = DataCenter.ins.equipCollection;
    for (const equipId of collection.getAllCollectedIds()) {
        const relic = getOuterRelic(equipId);
        if (!relic) continue;

        const count = collection.getCollectedCount(equipId);
        if (count <= 0) continue;

        const bonuses = relicToBonusGroup(relic);
        for (const layer of ['flat', 'percent'] as const) {
            for (const key of Object.keys(bonuses[layer])) {
                const attrId = Number(key) as AttributeType;
                const val = (bonuses[layer][attrId] ?? 0) as number;
                if (val === 0) continue;
                const existing = (total[layer][attrId] ?? 0) as number;
                (total[layer] as Record<number, number>)[attrId] = existing + val * count;
            }
        }
    }

    return total;
}

/* ===================================================================
 * 「属性总览」的展示口径（UI 只读这一份，自己不做换算）
 * =================================================================== */

/**
 * 该属性的**运行时值是不是「比例」**（`0.08` = 8%）—— 与 `AttributeScaling.SCALE` 的 8 项逐项对齐。
 *
 * 为什么要暴露它：UI 要把 `0.08` 显示成 `+8%`、把 `6 护甲` 显示成 `+6`，
 * 这个判断散落到 UI 里就会与数据层的换算各写一套（改一处忘一处）。
 */
export function isRatioAttr(attrId: number): boolean {
    return PERCENT_ATTR_IDS.indexOf(attrId) >= 0;
}

/** 一条属性的局外加成汇总（UI 的一行） */
export interface OuterBonusTotal {
    attrId: AttributeType;
    /** 属性中文名（attributes.json 的 `name`） */
    name: string;
    /** 固定值层（**运行时值**：比例型属性是小数，如攻速 0.2 = +20%） */
    flat: number;
    /** 百分比层（**小数**：0.05 = 对基础属性 +5%） */
    percent: number;
}

/** 属性中文名（取不到就回落 `属性 N`，绝不返回空串） */
function attrNameOf(attrId: number): string {
    const def = TbRoot.ins.getTbContainer(AttributeCfgContainer)?.getCfgById(attrId);
    return def?.name || `属性 ${attrId}`;
}

/**
 * 「属性总览」的数据行：把所有遗物的加成按属性**求和**，attrId 升序，两层都为 0 的不出现。
 * @param group 不传则取 `getAllEquipmentBonuses()`（= 已收集遗物的总和）
 */
export function getOuterBonusTotals(group?: OuterBonusGroup): OuterBonusTotal[] {
    const g = group ?? getAllEquipmentBonuses();
    const ids = new Set<number>();
    for (const k of Object.keys(g.flat)) ids.add(Number(k));
    for (const k of Object.keys(g.percent)) ids.add(Number(k));

    const rows: OuterBonusTotal[] = [];
    for (const attrId of [...ids].sort((a, b) => a - b)) {
        const flat = Number(g.flat[attrId as AttributeType] ?? 0);
        const percent = Number(g.percent[attrId as AttributeType] ?? 0);
        if (flat === 0 && percent === 0) continue;
        rows.push({ attrId: attrId as AttributeType, name: attrNameOf(attrId), flat, percent });
    }
    return rows;
}

/** 保留两位小数并去掉多余的 0（0.1+0.2 这类浮点噪声不该显示成 0.30000000000000004） */
function trim2(v: number): number {
    return Math.round(v * 100) / 100;
}

/**
 * **固定值层**的展示文案。
 *   · 比例型属性（攻速/暴击率/闪避/暴击倍率…）→ `+20%`（配置 int 的口径：`20` 就是 +20%）
 *   · 普通属性 → `+450`
 *   · 0 → `—`
 */
export function formatFlatBonus(attrId: number, value: number): string {
    if (!value) return '—';
    const ratio = isRatioAttr(attrId);
    const n = trim2(ratio ? value * 100 : value);
    return `${n > 0 ? '+' : ''}${n}${ratio ? '%' : ''}`;
}

/** **百分比层**的展示文案：`0.05` → `+5%`；0 → `—` */
export function formatPercentBonus(value: number): string {
    if (!value) return '—';
    const n = trim2(value * 100);
    return `${n > 0 ? '+' : ''}${n}%`;
}
