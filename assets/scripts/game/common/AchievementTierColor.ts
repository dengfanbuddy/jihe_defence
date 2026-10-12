/**
 * 成就档位配色与名称（**全工程唯一源**）
 *
 * 与 `RelicRarityColor.ts` 同风格：色值只有一份，卡面（`AchievementItem`）从这里取，
 * 别在界面里各写一套。
 *
 * ── 2026-11 改版：档位名从「铜/银/金」改成「阶段N」──
 *
 * 原因是**档位数不再固定是 3**：账号等级那条有 20 档（每 5 级一阶，直到 100 级，
 * 见 `tools/excel_export/scripts/gen-achievements.mjs`），收集类 6~7 档，通关类 5~6 档。
 * 三档制的名字（铜/银/金）一旦有 20 档就说不通了，所以档位文案改成序号制的 **`阶段N`**（`tierName`）。
 *
 * 配色仍然是**三个色锚点**（`ACH_TIER_COLOR`，已在 `docs/art-style/tokens.json` 登记为
 * `c-tier-bronze/silver/gold`），但取法从「tier → 色」改成「**进度比例 → 色**」：
 * `tierColor(tier, maxTier)` 按 `(tier−1)/(maxTier−1)` 落在前 1/3 / 中 1/3 / 后 1/3，分别取
 * 铜 / 银 / 金（`tierBand`）。于是：
 *   · 3 档制（多数成就）→ 阶段1=铜、阶段2=银、阶段3=金，**与改版前逐字一致**；
 *   · 20 档制（账号等级）→ 前 7 档铜、中 6 档银、末 7 档金，横向看是"越往后越亮"。
 *
 * ⚠ **档位色是「点缀」，不是「底色」**（2026-11 卡面改版后的口径）：
 * 卡面是纯白 `c-surface` + `rect_rd_20` 大圆角（`docs/美术风格预设.md` §6「内容卡片」），
 * 档位色**只出现在一处** —— 卡左缘那条 `tier_bar` 刻度条（`AchievementItem.applyBgAndTier`）。
 * 为什么不铺满/晕染卡面：① 浅底上会与正文的深色文字抢对比度，金档 `#F2C14E` 最严重；
 * ② 铜/银/金是本卡唯一的「暖色强调」，铺成面积就变成第三种强调色（违反 §10）；
 * ③ §9-4 的原则是「档位差主要靠**形状与附件**而不是换色相」。
 *
 * 卡面上的档位名（`lv`，改版后是 `阶段N`）走 `c-ink-900` 墨色 —— 档位色由刻度条回答，
 * 文字只管可读（`#F2C14E` 写在白底上只有 1.5:1，读不出来）。
 */

/** 档位色三锚点：1 = 首档（铜）/ 2 = 中段（银）/ 3 = 末档（金） */
export const ACH_TIER_COLOR: Record<number, string> = {
    1: '#C98B5E',   // 铜
    2: '#B9C4CC',   // 银
    3: '#F2C14E',   // 金
};

/** 档位色区间（三锚点的下标） */
export type AchTierBand = 1 | 2 | 3;

/**
 * 取档位色（**按进度比例**，越界/未知一律回落首档，绝不返回 undefined）。
 * @param tier    当前档位（1 起）
 * @param maxTier 该条成就的总档位数（缺省 3 = 三档制）
 */
export function tierColor(tier: number, maxTier = 3): string {
    return ACH_TIER_COLOR[tierBand(tier, maxTier)];
}

/** 取档位名（`阶段N`；越界/未知按 1 处理） */
export function tierName(tier: number): string {
    return `阶段${tierIndex(tier)}`;
}

/**
 * 档位落在三锚点的哪一段 —— **唯一判据**（卡面/文档/体检都按它对照，别在别处再算一遍）。
 * 只有一档时直接给末档色（否则那条成就永远显示首档色，看着像"没做过"）。
 */
export function tierBand(tier: number, maxTier = 3): AchTierBand {
    const n = Math.max(1, Math.floor(maxTier) || 1);
    if (n <= 1) return 3;
    const ratio = (Math.min(tierIndex(tier), n) - 1) / (n - 1);
    if (ratio < 1 / 3) return 1;
    if (ratio < 2 / 3) return 2;
    return 3;
}

/** 档位序号钳到 ≥ 1（非数/NaN → 1） */
export function tierIndex(tier: number): number {
    const n = Math.floor(tier);
    return Number.isFinite(n) && n > 1 ? n : 1;
}
