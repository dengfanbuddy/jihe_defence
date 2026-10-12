import { BattleConstUtil } from '../battle/core/BattleConstUtil';
import { rewardMul } from './DifficultyConfig';

/**
 * ============================================================
 * RunClearHeroExp —— **一局打完就发的通用英雄经验**（纯规则，无 cc 依赖、不碰数据层）
 * ============================================================
 *
 * 这条链路的由来（2026-11，用户口径）：
 * >
 * > 「局内结束还要奖励英雄升级经验，需要管理阶段和时间，给一个范围。」
 *
 * 它取代的是**只有通关才发**的旧写法（`DataCenter.grantClearHeroExp` =
 * `clearRewardHeroExpBase × rewardMul(难度)`，一局固定 80×倍率，与打得好不好无关）：
 * 那样"打到第 4 阶段才阵亡"和"第 1 阶段就送死"发的经验**一模一样**，
 * 局内那五十分钟的推进在结算里一个数字都不体现。现在**胜负都发**、且由**阶段 + 时间**共同决定。
 *
 * ── 公式（六个配表键，全在 `battle_constants`）──
 *
 * ```
 * 阶段进度 stageRatio = clamp(到达阶段 / stageFull, 0, 1)      // stageFull = 5（打到 Boss 阶段 = 满）
 * 时间进度 timeRatio  = clamp(存活秒数 / timeFull, 0, 1)        // timeFull  = 600s（10 分钟 = 满）
 * 综合进度 progress   = 0.6 × stageRatio + 0.4 × timeRatio      // 两条权重之和 = 1（stageWeight/timeWeight）
 * 原始值   raw        = clearRewardHeroExpBase × progress × rewardMul(难度档位)
 * 实发     exp        = clamp(round(raw), runHeroExpMin, runHeroExpMax)   ← 「给一个范围」
 * ```
 *
 * 为什么是**加权相加**而不是相乘：两者高度相关（时间不够就推不完阶段），
 * 相乘等于把"速通"和"苟活"同时惩罚两遍，一局打出 10% 的进度会变成 1%；
 * 相加则各自保留一半话语权 —— 打得快（阶段高）和打得久（时间长）**都能**换来经验，
 * 玩家不必在"推塔"和"磨时间"之间二选一（口径见 `docs/settle/README.md` §2）。
 *
 * ── 现值（base 80 / 权重 0.6·0.4 / 5 阶段 / 600s / 范围 8~1600）──
 *
 * | 局面（难度 1） | 阶段 | 时间 | 进度 | 实发 |
 * |---|---|---|---|---|
 * | 准备期就阵亡 | 0 | 0:30 | 0.02 | **8**（保底） |
 * | 第 1 阶段阵亡 | 1 | 1:00 | 0.16 | 13 |
 * | 第 3 阶段阵亡 | 3 | 3:00 | 0.48 | 38 |
 * | 第 4 阶段阵亡 | 4 | 5:00 | 0.68 | 54 |
 * | Boss 阶段阵亡 | 5 | 8:00 | 0.92 | 74 |
 * | **通关**（≈10 分钟打完） | 5 | ≥10:00 | 1.00 | **80** |
 *
 * 最后一行的 80 与旧口径**逐字相同**（`clearRewardHeroExpBase` 就是基数）——
 * 通关手感不变，变的是"没通关的那几百局终于也有经验了"。
 * 难度档位到 100 时 `rewardMul ≈ 17.96`，满额 = 80 × 17.96 ≈ 1437，
 * 仍在 `runHeroExpMax`（1600）之内 ⇒ **封顶只在配置被调歪时才会生效**，正常玩法够不到。
 *
 * ── 三条口径（写死，别在别处再算一遍）──
 *
 *   ① **只有"真正打完一局"才发**：调用点是 `Scene_Game_Stage.endRun()`（胜利 / 英雄阵亡 /
 *      Boss 超时三条路都走它）。**中途退出**走 `exit()`、不调 `endRun` ⇒ 不发 ——
 *      与金币（`common/RunClearReward`）、「完成对局 +1」的任务口径逐字同口径。
 *   ② **胜负都发**：胜负本身不进公式，它体现在"阶段 + 时间"上（赢了必然阶段 5、时间也长）。
 *      刻意**不做**"失败再乘一个 0.3"这类二次折扣 —— 那等于把同一件事罚两遍。
 *   ③ **乘难度收益倍率**（与金币那条**刻意不同**）：它是"局外成长的报酬"，
 *      高难度档位收益更高是对的（金币那条是新手启动资金，乘上去会让老玩家刷金币，见
 *      `RunClearReward` 口径 ③）。
 */
export class RunClearHeroExp {

    /** 阶段维度占的权重（`battle_constants.runHeroExpWeightStage`，与时间权重之和 = 1） */
    static stageWeight(): number {
        return Math.max(0, BattleConstUtil.getRunHeroExpWeightStage());
    }

    /** 时间维度占的权重（`battle_constants.runHeroExpWeightTime`） */
    static timeWeight(): number {
        return Math.max(0, BattleConstUtil.getRunHeroExpWeightTime());
    }

    /**
     * **阶段进度**（0~1）：到达 `runHeroExpStageFull` 个阶段就满。
     *
     * @param stage 本局到达的阶段（`Scene_Game_Stage.stage`：0 = 还在准备期，1~4 常规，5 = Boss 阶段）
     */
    static stageRatio(stage: number): number {
        const full = Math.max(1, BattleConstUtil.getRunHeroExpStageFull());
        const s = Math.max(0, Math.floor(stage) || 0);
        return Math.min(1, s / full);
    }

    /**
     * **时间进度**（0~1）：存活 `runHeroExpTimeFull` 秒就满。
     *
     * ⚠ 时间在 `endRun` 那一刻**已经定格**（`Scene_Game_Stage.elapsed` 不再往前走），
     *   所以这个值在一局里只会算一次，不存在"面板开着还在涨"的问题。
     *
     * @param elapsed 本局存活秒数
     */
    static timeRatio(elapsed: number): number {
        const full = Math.max(1, BattleConstUtil.getRunHeroExpTimeFull());
        const t = Math.max(0, elapsed) || 0;
        return Math.min(1, t / full);
    }

    /**
     * **综合进度**（0~1）= 阶段权重 × 阶段进度 + 时间权重 × 时间进度。
     * 两个权重**不归一化**（配表配成 0.6 / 0.4 就是它们的实际占比，和 = 1时进度上限正好是 1）；
     * 配歪了（和 > 1）进度会被下面的 `Math.min(1, …)` 夹住，不会发出超额经验。
     */
    static progress(stage: number, elapsed: number): number {
        const raw = RunClearHeroExp.stageWeight() * RunClearHeroExp.stageRatio(stage)
            + RunClearHeroExp.timeWeight() * RunClearHeroExp.timeRatio(elapsed);
        return Math.min(1, Math.max(0, raw));
    }

    /**
     * **本局实发区间**（`[min, max]`，已做"配歪了也不许反过来"的收敛）。
     *
     * 结算面板与文档都读它，**不要在别处再读一次那两个键** ——
     * 面板上写"预计 8~1600"而实发 12 这种对不上的事就是这么来的。
     */
    static range(): { min: number; max: number } {
        const min = Math.max(0, BattleConstUtil.getRunHeroExpMin());
        const max = Math.max(min, BattleConstUtil.getRunHeroExpMax());
        return { min, max };
    }

    /**
     * **本局结算英雄经验**（唯一入口；`DataCenter.grantRunClearHeroExp` 调它）。
     *
     * @param stage      本局到达的阶段
     * @param elapsed    本局存活秒数
     * @param difficulty 本局难度档位（1 ~ `DIFFICULTY_MAX`；`rewardMul` 在这里参与）
     * @returns 实发经验（0 = 本局不发：只有"基数配成 0"这一种可能）
     */
    static amountFor(stage: number, elapsed: number, difficulty: number): number {
        const base = Math.max(0, BattleConstUtil.getClearRewardHeroExpBase());
        if (base <= 0) return 0;

        const raw = base * RunClearHeroExp.progress(stage, elapsed) * Math.max(0, rewardMul(difficulty));
        const { min, max } = RunClearHeroExp.range();
        return Math.max(0, Math.round(Math.min(max, Math.max(min, raw))));
    }

    /** 一句话说明（日志用）：`阶段 3 · 3:00 → +38 英雄经验（基数 80 × 进度 0.48 × 难度 ×1.00）` */
    static describe(stage: number, elapsed: number, difficulty: number): string {
        const s = Math.max(0, Math.floor(stage) || 0);
        const t = Math.max(0, Math.floor(elapsed) || 0);
        const mmss = `${Math.floor(t / 60)}:${t % 60 < 10 ? '0' + (t % 60) : t % 60}`;
        return `阶段 ${s} · ${mmss} → +${RunClearHeroExp.amountFor(s, t, difficulty)} 英雄经验`
            + `（基数 ${Math.round(BattleConstUtil.getClearRewardHeroExpBase())}`
            + ` × 进度 ${RunClearHeroExp.progress(s, t).toFixed(2)}`
            + ` × 难度 ×${rewardMul(difficulty).toFixed(2)}）`;
    }
}
