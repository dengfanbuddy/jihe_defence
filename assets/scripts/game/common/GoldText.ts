/**
 * GoldText.ts — 数字的**显示口径**（唯一实现）
 *
 * 口径（与预制件里作者摆的 `2k` 同风格）：
 *   < 1000  → 原数（`850`）
 *   ≥ 1000  → `1.2k`（一位小数，整数不带 `.0`）
 *   ≥ 10000 → `1.2万`
 *
 * 为什么单独一个文件：成就页的「领取」区（`AchievementItem`）与英雄页的「解锁 / 升级」区
 * （`HeroCard`）都要把价格缩写成同一个样子 —— 两份实现迟早会有一边忘了改。
 * `AchievementConfig.formatGold` 保留为**转发**（旧调用方一个字不用改）。
 * `formatCount`（千分位原数）是它的兄弟，给"要跟进度条对账"的读数用，见那个函数的注释。
 */
export function formatGold(n: number): string {
    const v = Math.max(0, Math.floor(n));
    if (v < 1000) return `${v}`;
    if (v < 10000) return `${trim1(v / 1000)}k`;
    return `${trim1(v / 10000)}万`;
}

/**
 * **通用数值缩写**（= `formatGold`，**同一份实现**，只是名字中性）。
 *
 * 局内凡是会变大的读数都走它：伤害飘字 / 击杀奖励飞入 / 击杀数 / 金币 / 生命 / 经验 /
 * 英雄属性值 / 商店价格与刷新费。口径见 `formatGold` 上面那张表。
 *
 * 为什么要有这个别名（而不是让调用方直接 `formatGold`）：那个名字读起来只像"金币"，
 * 于是局内那几处各自 `${n}` 拼字符串 —— 4~5 位数字会把 HUD 的格子顶爆、飘字糊成一片。
 * 口径只有一份，名字换成中性的，调用方就不必再讨论"这算不算金币"。
 * ⚠ **飘字侧（`DrawDigits` 的矢量字形表）只认 `0-9 . k 万`**：改这里的分档要同步
 * `game_stage/entityview/GeometricDigits.ts` 的字形表，否则新后缀会被跳过（宽度照留、不画）。
 */
export const formatNumber = formatGold;

/**
 * **不缩写**的计数显示（千分位原数）：`1280` → `1,280`。
 *
 * 与 `formatGold` 的分工：一次性大额价格用缩写（`2k`，玩家只需要一个量级），
 * 而**进度类**的数字（经验池持有量、升级所需经验）要能跟进度条上的
 * 「120 / 347」对上账，缩写了反而看不懂 —— 英雄详情弹窗的三个读数都用本函数。
 */
export function formatCount(n: number): string {
    const v = Math.max(0, Math.floor(n));
    return `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 一位小数，整数不带 `.0`（不用 toFixed(1) 的固定格式） */
function trim1(v: number): string {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}
