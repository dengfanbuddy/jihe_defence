import type { AchTier } from '../excel_table/Tb_AchievementConfig';

/**
 * 成就档位配色与名称（**全工程唯一源**）
 *
 * 与 `RelicRarityColor.ts` 同风格：色值只有一份，卡面（`AchievementItem`）从这里取，
 * 别在界面里各写一套。
 *
 * ⚠ **档位色是「点缀」，不是「底色」**（2026-11 卡面改版后的口径）：
 * 卡面是纯白 `c-surface` + `rect_rd_20` 大圆角（`docs/美术风格预设.md` §6「内容卡片」），
 * 档位色**只出现在两处之外的一处** —— 卡左缘那条 `tier_bar` 刻度条（`AchievementItem.applyBgAndTier`）。
 * 为什么不铺满/晕染卡面：① 浅底上会与正文的深色文字抢对比度，金档 `#F2C14E` 最严重；
 * ② 铜/银/金是本卡唯一的「暖色强调」，铺成面积就变成第三种强调色（违反 §10）；
 * ③ §9-4 的原则是「档位差主要靠**形状与附件**而不是换色相」。
 *
 * 卡面上的档位名（`lv`，铜/银/金）走 `c-ink-900` 墨色 —— 档位色由刻度条回答，
 * 文字只管可读（`#F2C14E` 写在白底上只有 1.5:1，读不出来）。
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
