/**
 * DayKey.ts —— 「本地日 / 周」键的**唯一口径**
 *
 * 为什么单独一个文件：跨天重置的判断散布在多个数据模块里（`TaskData` 的日/周任务周期、
 * `ShopData` 的每日补给与每日广告次数），**键必须是同一把尺**才算得对 ——
 * 曾经各写一份 `YYYYMMDD` 时，只要有一处用了本地时区以外的东西（`toISOString()` 是 UTC），
 * 「同一天」在两个模块里就会差 8 小时。
 *
 * 口径（与 `TaskData` 原来的私有实现逐字一致，2026-11 抽出来共用）：
 *   · 日键 = **本地日期** `YYYYMMDD`（跨日自动恢复，不是「距上次 24 小时」）
 *   · 周键 = **本周周一的日期** `YYYYMMDD`（天然唯一，避开"第几周"的跨年坑）
 *
 * 用法：
 *   DayKey.todayKey()          // '20261123'
 *   DayKey.secondsToNextDay()  // 距次日 0 点还有多少秒（界面「距重置 07:12:33」）
 */

/** 两位补零（不用 `padStart`：本项目 tsconfig 的 lib 目标里没有它） */
export function pad2(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

/** 当天日期键 `YYYYMMDD`（本地时区） */
export function todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 本周周期键 = 本周周一的日期 `YYYYMMDD`（跨年也不会撞） */
export function weekKey(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const offsetToMonday = (d.getDay() + 6) % 7; // 周一 = 0
    d.setDate(d.getDate() - offsetToMonday);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/**
 * 距**次日 0 点**还有多少秒（界面的「距重置」倒计时）。
 * 用本地 0 点而不是 "+24 小时"：跨天重置是按**日期**算的，倒计时也要跟着日期走。
 */
export function secondsToNextDay(): number {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/** 名称空间形式（`DayKey.todayKey()`），与自由函数并存便于按项目习惯引用 */
export const DayKey = { pad2, todayKey, weekKey, secondsToNextDay };
