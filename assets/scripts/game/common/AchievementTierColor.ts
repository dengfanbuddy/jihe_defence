import type { AchTier } from '../excel_table/Tb_AchievementConfig';

/**
 * 成就档位配色与名称（**全工程唯一源**）
 *
 * 与 `RelicRarityColor.ts` 同风格：色值只有一份，卡面（`AchievementItem`）、
 * 档位文字（`lv`）都从这里取，别在界面里各写一套。
 *
 * ⚠ **卡面底色用的是「同色 + 低透明度」**（`ACH_TIER_BG_ALPHA`），不是满色：
 * 设计稿里「`bg` 按档位染色」与「`lv` 文字用档位色」两条同时满色会互相吃掉
 * （金档最严重：`#F2C14E` 压 `#F2C14E`），满色底也会与正文的深色文字抢对比度。
 * 要更深/更浅只改 `ACH_TIER_BG_ALPHA`，别换色相。
 *
 * 另一种用法：卡面底色低透明度叠在局外纸面底（`#EFEEED`）上 —— 见设计稿 §7.4。
 */
export const ACH_TIER_COLOR: Record<AchTier, string> = {
    1: '#C98B5E',   // 铜
    2: '#B9C4CC',   // 银
    3: '#F2C14E',   // 金
};

/** 档位中文名（卡面 `lv` 用） */
export const ACH_TIER_NAME: Record<AchTier, string> = {
    1: '铜',
    2: '银',
    3: '金',
};

/** 卡面 `bg` 的档位色透明度（0~255；60 ≈ 24% 叠在纸面底上） */
export const ACH_TIER_BG_ALPHA = 60;

/** 取档位色（越界/未知一律回落铜档，绝不返回 undefined） */
export function tierColor(tier: number): string {
    return ACH_TIER_COLOR[clampTier(tier)];
}

/** 取档位名（越界回落铜档） */
export function tierName(tier: number): string {
    return ACH_TIER_NAME[clampTier(tier)];
}

/** 档位序号钳到 1~3 */
export function clampTier(tier: number): AchTier {
    if (tier <= 1) return 1;
    if (tier >= 3) return 3;
    return (Math.floor(tier) as AchTier) || 1;
}
