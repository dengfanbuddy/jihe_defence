/**
 * GoldText.ts — 金币数字的**显示缩写**（唯一实现）
 *
 * 口径（与预制件里作者摆的 `2k` 同风格）：
 *   < 1000  → 原数（`850`）
 *   ≥ 1000  → `1.2k`（一位小数，整数不带 `.0`）
 *   ≥ 10000 → `1.2万`
 *
 * 为什么单独一个文件：成就页的「领取」区（`AchievementItem`）与英雄页的「解锁 / 升级」区
 * （`HeroCard`）都要把价格缩写成同一个样子 —— 两份实现迟早会有一边忘了改。
 * `AchievementConfig.formatGold` 保留为**转发**（旧调用方一个字不用改）。
 */
export function formatGold(n: number): string {
    const v = Math.max(0, Math.floor(n));
    if (v < 1000) return `${v}`;
    if (v < 10000) return `${trim1(v / 1000)}k`;
    return `${trim1(v / 10000)}万`;
}

/** 一位小数，整数不带 `.0`（不用 toFixed(1) 的固定格式） */
function trim1(v: number): string {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}
