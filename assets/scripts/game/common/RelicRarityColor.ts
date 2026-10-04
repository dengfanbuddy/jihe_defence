import type { RelicRarity } from '../excel_table/Tb_RelicConfig';

/**
 * 遗物品质配色（**全工程唯一配色源**）
 *
 * 品质不进出图（见 `docs/relic-icon/README.md` §2 第四条），品质只靠 UI 里图标背后的
 * **底框颜色**表现 —— 所以这套色值必须只有一份，否则局内商店和局外图鉴会各染一套。
 *
 * 色值来自美术定的四档，`ShopRelicsItem` 与 `OuterRelicItem` 共用本文件。
 */
export const RELIC_RARITY_COLOR: Record<RelicRarity, string> = {
    common: '#DDDDDD',      // 白
    rare: '#5096FF',        // 蓝
    epic: '#CF68FF',        // 黄（美术取色偏紫）
    legendary: '#FF6464',   // 红
};

/** 品质档位序号（1 白 / 2 蓝 / 3 黄 / 4 红）——排序与「降级判定」用 */
export const RELIC_RARITY_TIER: Record<RelicRarity, number> = {
    common: 1, rare: 2, epic: 3, legendary: 4,
};

/** 取品质色（未知品质回落白档，绝不返回 undefined） */
export function rarityColor(rarity: string | undefined): string {
    return RELIC_RARITY_COLOR[rarity as RelicRarity] ?? RELIC_RARITY_COLOR.common;
}

/** 取品质档位（未知品质回落 1） */
export function rarityTier(rarity: string | undefined): number {
    return RELIC_RARITY_TIER[rarity as RelicRarity] ?? 1;
}
