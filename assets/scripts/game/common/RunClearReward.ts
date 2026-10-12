import { BattleConstUtil } from '../battle/core/BattleConstUtil';

/**
 * ============================================================
 * RunClearReward —— **一局打完就发的局外金币**（纯规则，无 cc 依赖、不碰数据层）
 * ============================================================
 *
 * 这条链路的由来（2026-11，用户口径）：
 * >
 * > 「局内结束的金币头几局高点，后面的就很少了」
 *
 * 它替代的是原来那一波**前期洪水**：一次性金币几乎全压在成就的**铜档**上（8,650），
 * 而铜档 2~3 局就能全清 ⇒ 新手第一个晚上就能抽 16 次，局外属性直接 ×4.4，
 * 局内前 4 分钟被压平（诊断见 `docs/agent-notes/配表与数值口径.md`）。
 * 现在改成**按局发、且随局数指数衰减**：新手前几局拿得到启动资金，之后迅速回落到很低。
 *
 * ── 公式（三个配表键，全在 `battle_constants`）──
 *
 * ```
 * 曲线值 curve(N) = max(floor, base × decay^(N-1))      // N = 本局是第几局（1 起）
 * 完成系数 factor = clamp(到达阶段 / divisor, 0, 1)      // 打到越远给得越多
 * 本局结算金币    = round(curve(N) × factor)
 * ```
 *
 * 现值（`base 400 / decay 0.6 / floor 40 / divisor 3`）：
 *
 * | 第 N 局 | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
 * |---|---|---|---|---|---|---|---|
 * | 曲线值 | 400 | 240 | 144 | 86 | 52 | 40 | 40 |
 * | 到阶段 1 / 3 / 4 实发 | 133 / 400 | 80 / 240 | 48 / 144 | 29 / 86 | 17 / 52 | 13 / 40 | 13 / 40 |
 *
 * ── 四条口径（写死，别在别处再算一遍）──
 *
 *   ① **只有"真正打完一局"才发**：调用点是 `Scene_Game_Stage.endRun()`（胜利 / 英雄阵亡 /
 *      Boss 超时三条路都走它）。**中途退出**走 `exit()`、不调 `endRun` ⇒ 不发 ——
 *      与「完成对局 +1」的任务口径逐字同口径。
 *   ② **完成系数是为了堵"速死刷钱"**：没有它，反复开局送死也能按曲线拿满额，
 *      每秒收益会高于正常打（stage 1 的怪几乎不破防，送死成本极低）。
 *      阶段 1 / 2 / 3+ 分别给 1/3、2/3、满额。
 *   ③ **不乘难度收益倍率**（与 `grantClearHeroExp` 的 `rewardMul(difficulty)` 不同）：
 *      这条是**新手启动资金**，不是"高难度的报酬"；乘上去会让老玩家用高难度档刷金币，
 *      把刚回收掉的产出又放回来。要高难度报酬就调 `DifficultyConfig.rewardMul` 那条线（局内收益）。
 *   ④ **局数 N 取自 `PlayerInfo.totalGames`**（`recordGameEnd` 在同一处 +1），
 *      所以发奖必须排在 `reportRunTasks()` **之后**，否则永远差一局。
 */
export class RunClearReward {

    /**
     * 第 `runIndex` 局的**曲线值**（不含完成系数）。
     *
     * @param runIndex 本局是累计第几局（1 起；非法值按 1 处理 = 拿最高档）
     */
    static curve(runIndex: number): number {
        const n = Math.max(1, Math.floor(runIndex) || 1);
        const base = Math.max(0, BattleConstUtil.getRunClearGoldBase());
        const floor = Math.max(0, BattleConstUtil.getRunClearGoldFloor());
        const decay = BattleConstUtil.getRunClearGoldDecay();
        if (base <= 0) return 0;
        // decay ≤ 0 / ≥ 1 都是"配歪了"：不给衰减就直接返回 base（别让 0 次方炸出一堆 0）
        const raw = decay > 0 && decay < 1 ? base * Math.pow(decay, n - 1) : base;
        return Math.max(floor, raw);
    }

    /**
     * **完成系数**（0~1）：按本局到达的阶段给 —— 见文件头口径 ②。
     *
     * @param stage 本局到达的阶段（`Scene_Game_Stage.stage`：0 = 还在准备期，1~4 常规，5 = Boss 阶段）
     */
    static stageFactor(stage: number): number {
        const divisor = Math.max(1, BattleConstUtil.getRunClearGoldStageDivisor());
        const s = Math.max(0, Math.floor(stage) || 0);
        return Math.min(1, s / divisor);
    }

    /**
     * **本局结算金币**（唯一入口；`DataCenter.grantRunClearGold` 调它）。
     *
     * @param runIndex 本局是累计第几局（1 起）
     * @param stage    本局到达的阶段
     * @returns 实发金币（0 = 本局不发）
     */
    static goldFor(runIndex: number, stage: number): number {
        const v = RunClearReward.curve(runIndex) * RunClearReward.stageFactor(stage);
        return Math.max(0, Math.round(v));
    }

    /** 一句话说明（日志/结算面板用）：`第 3 局 · 到达阶段 4 → +144 金币（曲线 144 × 1.00）` */
    static describe(runIndex: number, stage: number): string {
        const n = Math.max(1, Math.floor(runIndex) || 1);
        const s = Math.max(0, Math.floor(stage) || 0);
        const curve = RunClearReward.curve(n);
        const f = RunClearReward.stageFactor(s);
        return `第 ${n} 局 · 到达阶段 ${s} → +${RunClearReward.goldFor(n, s)} 金币`
            + `（曲线 ${Math.round(curve)} × ${f.toFixed(2)}）`;
    }
}
