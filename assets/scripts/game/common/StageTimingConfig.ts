/**
 * ============================================================
 * StageTimingConfig —— 局内**阶段节奏**的唯一数值真源（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * 只管四件事：打几个阶段、准备期多久、常规阶段多久、Boss 阶段多久。
 * 它不知道谁在读，也不碰任何节点 / 存档。
 *
 * ── 谁在读 ──
 *   ① `Scene_Game_Stage.defaultConfig`（局内推进：`checkStage` 的倒计时与阶段切换）
 *   ② `GameRulesConfig`（「游戏规则说明」面板的文案 —— 玩家看到的「每阶段 4 分钟」就是这几个数）
 *
 * ── 为什么单独放一个文件 ──
 *   这几个数原来只写在 `Scene_Game_Stage.defaultConfig` 里（240 / 150 / 15）。规则说明面板要是
 *   自己再抄一份，改节奏时**界面会静默撒谎**（面板说 4 分钟、实际 3 分钟）。文案与规则共用一份数据
 *   是这条链路上唯一能防住漂移的做法（同 `BattleSpeedConfig` / `TargetSelectConfig` 的口径）。
 *
 * ⚠ 改这里的数会同时改**单局总时长**，而刷怪节拍表（`Scene_Game_Stage.SPAWN_BEATS`）是按
 *   `elapsed`（秒）索引的、与阶段无关 —— 但 `SPAWN_BEAT_BOSS` 的接管时刻与 Boss 调度都跟着走。
 *   动之前先读 `docs/局内刷怪节奏设计.md` §12.3 / §12.4。
 */

/** 常规阶段数（阶段 1 ~ N；之后进入 Boss 阶段 `FINAL_BOSS_STAGE`） */
export const STAGE_COUNT = 4;

/** 准备期时长（秒）：选完英雄后开始倒计时，期间不刷怪（HUD 显示「准备中」） */
export const PREPARE_TIME_SEC = 7;

/** 常规阶段时长（秒）：阶段 1~4 各持续这么久 */
export const STAGE_TIME_SEC = 240;

/** Boss 阶段时长（秒）：最终 Boss 阶段超时未击杀 = 本局失败 */
export const BOSS_TIME_SEC = 150;

/** 单局总时长（秒，1× 速度）：准备期 + 全部常规阶段 + Boss 阶段（不含最终 Boss 战的额外耗时） */
export const RUN_TOTAL_SEC = PREPARE_TIME_SEC + STAGE_COUNT * STAGE_TIME_SEC + BOSS_TIME_SEC;

/**
 * 秒 → 中文时长文案（`240` → `4 分钟` / `150` → `2 分 30 秒` / `45` → `45 秒`）。
 * 规则说明面板统一用它，避免每处各写一遍除法。
 */
export function formatDuration(sec: number): string {
    const total = Math.max(0, Math.round(sec));
    const minute = Math.floor(total / 60);
    const rest = total % 60;
    if (minute <= 0) return `${rest} 秒`;
    if (rest === 0) return `${minute} 分钟`;
    return `${minute} 分 ${rest} 秒`;
}
