/**
 * ============================================================
 * GameModeRules —— 局内**按模式分岔的全部规则**的唯一真源（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * 背景：`GameModeConfig`（同目录）回答的是**界面侧**的四件事（支持哪几个模式 / 默认哪个 /
 * 卡面文案 / 难度弹窗标题），它一个字都不提"这一局怎么玩"。而模式真正的差异在**局内**：
 * 阶段模式有终点（打到最终 Boss 通关），无尽模式没有（一直刷到英雄阵亡）。
 * 本文件就是那另一半 —— 两者合起来才是「游戏模式」这件事的完整真源。
 *
 * ── 为什么必须单独一个文件（而不是在 `checkStage` 里写 `if (mode === 'no_ending')`）──
 *   ① **一处判、处处用**：分岔点散落会立刻出现"有的地方按无尽、有的地方按阶段"的半成品态
 *      （例如阶段数不封顶了、但 HUD 还在显示「阶段 7/4」）。
 *   ② **可验证**：这些都是**纯函数/纯数值**，体检（`npm run audit:mode`）能不碰编辑器直接跑，
 *      而 `checkStage` 里那句 `if` 是跑不起来的（它在一个 cc 组件里）。
 *   ③ 场景侧只剩"消费"：`Scene_Game_Stage` 持有一个 `modeRules`，五个落点全部问它。
 *
 * ── 两条模式各自的口径（改之前先读）──
 *   · **阶段模式**（`stage`）= 4 个常规阶段 → 最终 Boss 阶段（超时未击杀 = 失败）；
 *     阶段时长由场景配置给（准备期 / `stageTime` / Boss 阶段 `bossTime`）；
 *     **小怪按阶段变肉**（`STAGE_MODE_HP_STEP` / `STAGE_MODE_ATK_STEP`，2026-11 新增，
 *     同时按同倍率抬高击杀奖励配平经济；**不作用 Boss**，Boss 走 `BossStrengthConfig`）。
 *
 * ── 局内英雄等级：**两种模式都不封顶**（2026-11 用户口径「局内英雄取消等级限制，以前是30级」）──
 *   `battle_constants.battleLevelMax` 这个键**已从表里删掉**，`Scene_Game_Stage.addBattleExp`
 *   的 while 条件只剩 `exp >= expToNext` —— 升级需求是指数增长
 *   （`battleExpFormulaBase × battleExpFormulaRatio^(L-1)`，现 60 × 1.12^(L-1)），
 *   本身就是"越升越慢"的天然上限，再叠一层硬上限只会让**后期的经验白吃**（静默的收益清零）。
 *   所以这里**没有**任何"等级上限"字段：它是模式之间的**共同口径**，不是分岔项。
 *   · **无尽模式**（`no_ending`）= 设计稿 `docs/prd/肉鸽塔防_游戏设计定案.md` §14.3
 *     「在已解锁难度上无限阶段」。落地口径见下面每条字段的注释；
 *     **与设计稿不一致的三处都在字段注释里写了理由**，别当成抄漏。
 *
 * ⚠ `docs/game-mode/README.md` §5 是这条链路的使用说明；改这里的数会把「一局能玩多久」一起改掉。
 */

import { GameMode, type GameModeId, gameModeName, normalizeGameMode } from './GameModeConfig';
import { FINAL_BOSS_STAGE, UnitKind, resolveBossKind } from './EntityVisualConfig';
import { STAGE_COUNT } from './StageTimingConfig';

/* ===================================================================
 * 阶段模式的数值（**要调"小怪随阶段变肉"只改这两行**）
 * =================================================================== */

/**
 * 阶段模式：每阶段**小怪** HP 成长底数（2026-11 新增，此前恒为 1 = 完全不涨）。
 *
 * ── 为什么必须涨（用户口径：「所有阶段的小怪都是 1 下就死」）──
 *   英雄侧在一局里涨的是**单次伤害**（等级成长 + 遗物攻击），而怪侧原先只有两条曲线：
 *     ① 难度档位 `1.10^(N-1)`（整局恒定，档 1 时恒为 ×1）；
 *     ② 刷怪表 `SPAWN_BEATS` 的**混怪配比**（哥布林 → 巨魔/重击者）。
 *   ② 只换"刷哪只怪"，**同一种怪的 HP 一个字都不变** —— 于是一只 40 血的哥布林
 *   在第 16 分钟与第 1 分钟一样脆，而英雄此时单次伤害已经翻了 3~6 倍 ⇒ 全场一枪一个。
 *   ⇒ 本曲线就是补"**同一只怪随时间变肉**"这一条缺失的轴。
 *
 * ── 为什么是 1.35 / 阶段（而不是更大）──
 *   `1.35^3 = 2.46`：常规阶段 4 结束时的**小怪**血量相对阶段 1 是 ×2.46。
 *   · 英雄面板 DPS 一局只涨 ~2.9~3.4 倍（`tools/boss-balance/sim.mjs` 实测），
 *     再叠上遗物钩子的追加伤害，有效输出约 ×5~7 —— 而刷怪表自己的混怪均 HP 已经涨了 ×3.8，
 *     两者相乘 ×8.4 ~ ×9.3，**与玩家的有效成长大致同阶**（再高就会"打不动 → 屏幕堵死 → 收入崩"）。
 *   · 取 1.35 而不是 1.5：后者（×3.38）会把总 HP 流推到 ×12.8，明显超过玩家成长。
 *   · 阶段 1 恒为 ×1 ⇒ **"档 1 + 阶段 1 = 基准平衡"这条口径不变**（`audit:mode` A5 现在钉的是新曲线）。
 *
 * ⚠ **只作用小怪，不作用 Boss**（`stageGrowthHitsBoss = false`）：
 *   Boss 的强度另有一条"刷新点曲线"`common/BossStrengthConfig`（阶段 Boss ×0.25/×0.8/×2.6、最终 ×5.3），
 *   两者相乘会让最终 Boss 变成 3000 × 5.3 × 1.35^4 ≈ 52.8 万血 —— 那不是"更强"而是"打不完"。
 */
const STAGE_MODE_HP_STEP = 1.35;

/**
 * 阶段模式：每阶段**小怪**伤害成长底数（刻意低于 HP —— "秒杀感比打不动更劝退"，
 * 与 `DifficultyConfig`（1.10 vs 1.08）和无尽模式（1.25 vs 1.15）同一条口径）。
 *
 * `1.15^3 = 1.52`：英雄侧同一时刻的血量中位是 793 → 1652（×2.08）、护甲 4.1 → 18.1
 * （物理减伤 20% → 52%），所以 ×1.52 的攻击刚好让"站着硬吃会掉血"在每个阶段都成立。
 */
const STAGE_MODE_ATK_STEP = 1.15;

/* ===================================================================
 * 无尽模式的数值（**要调无尽曲线只改这五行**）
 * =================================================================== */

/**
 * 每阶段怪 HP 成长底数（设计稿 §14.3：`HP × 1.25 / 阶段`）。
 *
 * 为什么是指数而不是线性：玩家的局内成长（等级成长 + 肉鸽构筑）在长局里近似**线性偏强**，
 * 怪要是也线性，玩家就永远死不了 —— "无尽模式自然死亡"这件事必须由**超线性**承担
 * （同 `docs/数值配置参考手册.md` §3.3.3 的定论）。
 */
const ENDLESS_HP_STEP = 1.25;

/** 每阶段怪伤害成长底数（设计稿 §14.3：`伤害 × 1.15 / 阶段`；刻意低于 HP，秒杀比打不动更劝退） */
const ENDLESS_ATK_STEP = 1.15;

/**
 * 每阶段刷怪间隔的成长底数。**默认 1 = 刻意不涨**（设计稿 §14.3 写的是 `× 0.95 / 阶段`）。
 *
 * 为什么不照抄：间隔在本作是**呼吸旋钮、不是难度旋钮**（`docs/局内刷怪节奏设计.md` 的定论，
 * 也是 `DifficultyConfig` 口径 ① 给 `SPAWN_GAP_MIN` 封顶的同一条理由）——
 * 让间隔随阶段一直缩，会同时撞上同屏保险丝（`SPAWN_ALIVE_HARD = 50`）与"单英雄定点输出"的
 * 攻击频率墙，表现为**后期屏幕上怪挤成一片但打不动**，那是性能问题不是难度。
 * 难度全部由"每只怪更肉更疼"承担（上面两个底数）。
 * 留这个旋钮是为了将来真要调时有唯一一处可改。
 */
const ENDLESS_SPAWN_GAP_STEP = 1;

/**
 * 每几个阶段刷一个 Boss。**默认 1 = 每个阶段边界都刷**（与阶段模式同一个节奏）。
 *
 * 设计稿 §14.3 写的是"每隔 3 个阶段刷新一个 Boss"，但它同时写"每个阶段 6 分钟" ——
 * 两者相乘 = **18 分钟才见一个 Boss**，而本作现役节奏是 4 分钟一个阶段、每个阶段边界一只 Boss
 * （`STAGE_TIME_SEC = 240`，见 `StageTimingConfig`）。无尽模式是从阶段模式**进来**的，
 * 让玩家在同一个游戏里适应两套完全不同的 Boss 节奏没有收益，所以这里跟阶段模式对齐、不跟旧稿。
 */
const ENDLESS_BOSS_EVERY_STAGES = 1;

/** 阶段 n 的成长倍率：`base^(n-1)`（第 1 阶段 = 选中的那个难度本身，一个数都不动） */
function stepMul(base: number, stage: number): number {
    if (!(base > 0) || base === 1) return 1;
    const n = Math.floor(stage);
    if (!Number.isFinite(n) || n <= 1) return 1;
    const mul = Math.pow(base, n - 1);
    return Number.isFinite(mul) ? mul : Number.MAX_VALUE;
}

/* ===================================================================
 * 两种模式的规则
 * =================================================================== */

/**
 * 一局里"按模式分岔"的全部判据。
 *
 * 场景侧（`Scene_Game_Stage`）持有一个实例，六个落点全部问它，**不许自己判模式**：
 *   · `checkStage` → `onStageTimeout` / `shouldSpawnBoss`
 *   · `spawnBoss` → `bossKind`
 *   · `stageDuration` → `isFinalBossStage`
 *   · `applyDifficultyScale` → `stageHpMul` / `stageAtkMul`
 *   · `getSpawnInterval` → `spawnGapMul`
 *   · `resetRun` → `maxPhase`（HUD 的「阶段 N/M」，0 = 无限）
 */
export interface IGameModeRules {
    /** 模式 id（`GameModeConfig.GameMode`） */
    readonly id: GameModeId;

    /** 这一局**有没有终点**（阶段模式 true；无尽 false —— 它只以英雄阵亡结束） */
    readonly hasEnding: boolean;

    // ⚠ 这里**没有**「局内等级上限」字段：2026-11 起两种模式都**不封顶**（见文件头那一段）。
    //   曾经有过 `maxBattleLevelOverride` / `unlimitedBattleLevel` 两个字段（阶段模式卡 30、
    //   无尽不限），取消等级限制后它们恒等于"不限"，留着就是一个**读不出差别的死旋钮**。

    /**
     * HUD 「阶段 N/M」的 **M**（`battleStore.maxPhase`）。
     * **0 = 无限**（与 `useBattleStore.maxPhase` / `drawCostCap` 的零口径一致，界面据此不画分母）。
     */
    readonly maxPhase: number;

    /** 每阶段怪 HP 成长底数（1 = 不涨） */
    readonly hpStepPerStage: number;

    /** 每阶段怪伤害成长底数（1 = 不涨） */
    readonly atkStepPerStage: number;

    /** 每阶段刷怪间隔成长底数（1 = 不变） */
    readonly spawnGapStepPerStage: number;

    /** 每几个阶段边界刷一个 Boss（≥1） */
    readonly bossEveryStages: number;

    /**
     * `stageHpMul` / `stageAtkMul` 这两条阶段成长**要不要也乘到 Boss 身上**。
     *
     *   · 无尽模式 `true`：它的阶段成长（×1.25/阶段）就是"这一局越来越难"的唯一旋钮，
     *     而它每个阶段都刷 Boss（`ENDLESS_BOSS_EVERY_STAGES = 1`）—— 漏掉 Boss 就等于
     *     "Boss 永远停在第 1 阶段的强度"，无尽模式会变成刷 Boss 游戏。
     *   · 阶段模式 `false`：Boss 另有**刷新点曲线** `common/BossStrengthConfig`
     *     （阶段 Boss ×1/1.6/2.6、最终 Boss ×5），本曲线是给小怪补的，两者相乘会叠成打不完的血条。
     */
    readonly stageGrowthHitsBoss: boolean;

    /**
     * 第 `stage` 阶段的**击杀奖励**额外倍率（金币/经验通用）。
     *
     * 为什么存在：阶段成长把怪的 HP 抬了多少，怪就该多掉多少钱 —— 否则 `gold per HP`
     * 会随阶段一路下滑（阶段模式实测末段掉 2.9 倍 ⇒ 抽卡次数腰斩 ⇒ 后期构筑被经济掐死）。
     * 阶段模式 = 与 `stageHpMul` **同倍率**（"HP 涨多少、它掉多少"）；无尽模式 = 1
     * （它的经济口径 2026-11 已定稿，且金币按 1.25^N 复利增长会让抽卡阶梯形同虚设）。
     */
    stageRewardMul(stage: number): number;

    /** 第 `stage` 阶段是不是"最终 Boss 阶段"（进入该阶段时刷出的那只就是最终 Boss） */
    isFinalBossStage(stage: number): boolean;

    /** 阶段倒计时归零时该做什么（`checkStage` 的唯一判据） */
    onStageTimeout(stage: number): 'defeat' | 'advance';

    /** 第 `stage` 阶段边界该刷出什么类别的 Boss */
    bossKind(stage: number): UnitKind;

    /** 第 `stage` 阶段边界要不要刷 Boss */
    shouldSpawnBoss(stage: number): boolean;

    /** 第 `stage` 阶段的怪 HP 额外倍率（不含难度档位那一层） */
    stageHpMul(stage: number): number;

    /** 第 `stage` 阶段的怪伤害额外倍率（不含难度档位那一层） */
    stageAtkMul(stage: number): number;

    /** 第 `stage` 阶段的刷怪间隔倍率（不含难度档位那一层；≤1） */
    stageSpawnGapMul(stage: number): number;
}

/**
 * **阶段模式**的规则 —— 4 阶段 → 最终 Boss；超时 = 失败。
 *
 * 2026-11 起它**不再"一个数都不改"**：小怪按阶段变肉（`STAGE_MODE_HP_STEP` / `STAGE_MODE_ATK_STEP`），
 * 同时按同倍率抬高击杀奖励配平经济。理由与推导见上面两个常量的注释 ——
 * 修的是"同一种怪的 HP 整局不变 ⇒ 后期一枪一个"这条缺失的轴。
 */
const STAGE_MODE_RULES: IGameModeRules = {
    id: GameMode.Stage,
    hasEnding: true,
    maxPhase: STAGE_COUNT,
    hpStepPerStage: STAGE_MODE_HP_STEP,
    atkStepPerStage: STAGE_MODE_ATK_STEP,
    spawnGapStepPerStage: 1,
    bossEveryStages: 1,
    stageGrowthHitsBoss: false,

    isFinalBossStage: (stage) => stage >= FINAL_BOSS_STAGE,
    onStageTimeout: (stage) => (stage >= FINAL_BOSS_STAGE ? 'defeat' : 'advance'),
    bossKind: (stage) => resolveBossKind(stage),
    shouldSpawnBoss: (stage) => stage > 0,
    stageHpMul: (stage) => stepMul(STAGE_MODE_HP_STEP, stage),
    stageAtkMul: (stage) => stepMul(STAGE_MODE_ATK_STEP, stage),
    // 奖励与 HP **同倍率**（"怪肉了多少，它就多掉多少"）—— 只在阶段模式开，理由见接口注释
    stageRewardMul: (stage) => stepMul(STAGE_MODE_HP_STEP, stage),
    stageSpawnGapMul: () => 1,
};

/**
 * **无尽模式**的规则 —— 无终点、阶段无上限、怪按阶段指数成长、永不出最终 Boss。
 *
 * 三个"必须有"的判据（少任何一个都会退化成阶段模式的半成品）：
 *   · `onStageTimeout` 恒为 `advance` —— 否则跑到第 5 阶段就按阶段模式判负了（这就是原来那个 bug）；
 *   · `bossKind` 恒为 `StageBoss` —— 否则第 4 阶段之后刷出来的"最终 Boss"一死就 `victory`，
 *     无尽模式会**被通关**（`Scene_Game_Stage.bindBattleEvents` 的 OnDeath 认的是 `finalBoss` 引用）；
 *   · `stageHpMul/stageAtkMul` 随阶段指数涨 —— 否则玩家越打越强、怪原地不动，这一局没有尽头也没有终点。
 */
const ENDLESS_MODE_RULES: IGameModeRules = {
    id: GameMode.NoEnding,
    hasEnding: false,
    maxPhase: 0,                // 0 = 不显示分母（HUD 画「阶段 N」）
    hpStepPerStage: ENDLESS_HP_STEP,
    atkStepPerStage: ENDLESS_ATK_STEP,
    spawnGapStepPerStage: ENDLESS_SPAWN_GAP_STEP,
    bossEveryStages: ENDLESS_BOSS_EVERY_STAGES,
    stageGrowthHitsBoss: true,

    isFinalBossStage: () => false,
    onStageTimeout: () => 'advance',
    bossKind: () => UnitKind.StageBoss,
    shouldSpawnBoss: (stage) => stage > 0 && stage % ENDLESS_BOSS_EVERY_STAGES === 0,
    stageHpMul: (stage) => stepMul(ENDLESS_HP_STEP, stage),
    stageAtkMul: (stage) => stepMul(ENDLESS_ATK_STEP, stage),
    // 经济口径不动（2026-11 定稿）：无尽的金币需求由抽卡阶梯自己承担，不跟着 HP 复利
    stageRewardMul: () => 1,
    stageSpawnGapMul: (stage) => (ENDLESS_SPAWN_GAP_STEP >= 1 ? 1 : Math.max(0.5, stepMul(ENDLESS_SPAWN_GAP_STEP, stage))),
};

/** 模式 id → 规则（脏值收敛到默认模式，与 `GameModeConfig` 同口径：**不抛错**） */
export function getModeRules(mode: unknown): IGameModeRules {
    return normalizeGameMode(mode) === GameMode.NoEnding ? ENDLESS_MODE_RULES : STAGE_MODE_RULES;
}

/** 这一局是不是无尽模式（判据只有这一处，界面/日志/体检都走它） */
export function isEndlessMode(mode: unknown): boolean {
    return getModeRules(mode) === ENDLESS_MODE_RULES;
}

/**
 * 一句话描述本局模式（开局日志用）—— 让"这一局到底按哪套规则跑"在日志里一眼可见。
 * 阶段模式：`阶段模式（4 阶段 → 最终 Boss，超时判负 · 小怪 HP ×1.35/阶段 · 攻击 ×1.15/阶段）`
 * 无尽模式：`无尽模式（无限阶段 · 怪 HP ×1.25/阶段 · 攻击 ×1.15/阶段 · 每 1 阶段一个 Boss）`
 *
 * ⚠ 这里**不提"等级不限"**：它是两种模式的共同口径（见文件头），写进某一侧会读成"另一侧有限制"。
 */
export function describeModeRules(mode: unknown): string {
    const r = getModeRules(mode);
    const growth = `怪 HP ×${r.hpStepPerStage}/阶段 · 攻击 ×${r.atkStepPerStage}/阶段`;
    if (r.hasEnding) {
        return `${gameModeName(r.id)}（${r.maxPhase} 阶段 → 最终 Boss，超时判负 · 小怪 ${growth}）`;
    }
    return `${gameModeName(r.id)}（无限阶段 · ${growth}`
        + ` · 每 ${r.bossEveryStages} 阶段一个 Boss）`;
}
