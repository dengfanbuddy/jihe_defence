/**
 * battle/core/BattleConstUtil —— 战斗常量工具（兼容层）
 *
 * 数据源：assets/resources/tb/battle_constants.json（KV 对象格式）
 * 通过 TbRoot 的 BattleConstCfgContainer 加载。
 *
 * 容错：配置表未加载完成时返回内置默认值，保证数据模块在启动早期可安全调用。
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
import { BattleConstCfgContainer } from '../../excel_table/Tb_BattleConstConfig';

/** 内置默认值（与 battle_constants.json 保持一致，加载失败时兜底） */
const DEFAULTS: Record<string, number> = {
    minDamage: 1,
    critRateCap: 0.6,
    critDmgBase: 0.5,
    dodgeCap: 0.4,
    atkSpeedCap: 3.0,
    atkRangeCap: 15,
    initialEnergy: 100,
    initialHp: 100,
    initialGold: 100,
    initialStamina: 120,
    maxItemSlots: 100,
    initialPhase: 1,
    heroExpFormulaBase: 100,
    heroExpFormulaRatio: 1.12,
    heroUnlockCostBase: 500,
    heroUnlockCostGrowth: 1.35,
    heroLevelUpGoldBase: 50,
    heroLevelUpGoldRatio: 1.25,
    playerExpFormulaBase: 100,
    playerExpFormulaRatio: 1.15,
    battleExpFormulaBase: 60,
    battleExpFormulaRatio: 1.18,
    clearRewardPlayerExpBase: 50,
    clearRewardHeroExpBase: 80,
    enemyDropExpDefault: 10,
    enemyDropGoldDefault: 1,
    rewardTimeBasePerSec: 0.00067,
    rewardTimeCap: 0.4,
    rewardBossGoldBonus: 10,
    rewardBossExpBonus: 10,
    projectileSpeedDefault: 600,
    collisionDetectThreshold: 30,
    /** 实体默认碰撞半径（像素）——用于实体分离/防重叠 */
    collisionRadiusDefault: 26,
    /** 实体分离强度（0~1）：每帧解析重叠量的比例，越大分离越迅速 */
    separationStrength: 0.6,
    phaseDefaultRemainingTime: 360,
    skillSlotCount: 4,
    /** 1 米 = 多少像素（距离换算的唯一口径，见 getPxPerMeter） */
    pxPerMeter: 50,
    // 一局打完就发的局外金币（口径见 common/RunClearReward 的文件头）
    runClearGoldBase: 400,
    runClearGoldDecay: 0.6,
    runClearGoldFloor: 40,
    runClearGoldStageDivisor: 3,
    // 一局打完就发的通用英雄经验（口径见 common/RunClearHeroExp 的文件头）
    runHeroExpWeightStage: 0.6,
    runHeroExpWeightTime: 0.4,
    runHeroExpStageFull: 5,
    runHeroExpTimeFull: 600,
    runHeroExpMin: 8,
    runHeroExpMax: 1600,
    // 结算面板「看广告翻倍」的倍率区间（口径见 common/RewardAdBonus 的文件头）
    settleAdMulMin: 1.0,
    settleAdMulMax: 3.0,
    settleAdMulDecimals: 1,
};

export class BattleConstUtil {
    private static _loaded = false;
    /** 已加载的 KV 缓存（加载后从容器拷贝，避免每次查容器） */
    private static cache: Record<string, number> = { ...DEFAULTS };

    /** 标记容器已可用（TbRoot 加载完成后由外部调用，或首次读取时自动探测） */
    static markLoaded(): void {
        BattleConstUtil._loaded = true;
        BattleConstUtil.reload();
    }

    /** 从容器重新加载（容器可用时） */
    static reload(): void {
        try {
            const container = TbRoot.ins.getTbContainer(BattleConstCfgContainer);
            if (container && container.size > 0) {
                for (const cfg of container.cfgs) {
                    if (typeof cfg.value === 'number') {
                        BattleConstUtil.cache[cfg.code] = cfg.value;
                    }
                }
                BattleConstUtil._loaded = true;
            }
        } catch {
            // 容器未加载，保持默认值
        }
    }

    /** 读取数值常量 */
    static getNumber(key: string, defaultValue?: number): number {
        const v = BattleConstUtil.cache[key];
        return v !== undefined ? v : (defaultValue ?? 0);
    }

    /**
     * **每局「看广告复活」的次数上限**（`battle_constants.reviveAdPerRun`，现 1；0 = 关掉这一条）。
     *
     * 消费点只有一处：`Scene_Game_Stage` 的**致命伤拦截器**（英雄被打死那一刻先问一次
     * "背包里有复活券 / 还有广告复活次数吗"）。⚠ 复活券**不受本键约束** ——
     * 它一局能用几次由背包存量决定（券是玩家买到手的东西，再套一层局内配额等于券作废）。
     */
    static getReviveAdPerRun(): number {
        return Math.max(0, Math.floor(BattleConstUtil.getNumber('reviveAdPerRun', 1)));
    }

    /**
     * **局外遗物抽取**的当日基准价（金币）—— 当天第 1 抽的价格。
     *
     * 三个键一起构成价格阶梯（口径真源 `docs/meta-growth/README.md` §1.3）：
     *   `当天第 N 抽（N 从 1 起）= min(base + step × (N-1), cap)`
     * ⚠ **只有花金币的抽才抬价**：用抽取券（`outer_draw_ticket`）抽不扣金币、也不抬阶梯。
     * 每天 0 点按**本地日期键**回到 `base`（不是"距上次 24 小时"）。
     * 消费点只有一处：`battle/OuterRelicDraw.costOfDraw`（别在业务里另算一遍）。
     */
    static getOuterDrawCostBase(): number {
        return Math.max(0, BattleConstUtil.getNumber('outerDrawCostBase', 200));
    }

    /** 局外遗物抽取·每付费抽一次的涨价步长（见 `getOuterDrawCostBase`） */
    static getOuterDrawCostStep(): number {
        return Math.max(0, BattleConstUtil.getNumber('outerDrawCostStep', 100));
    }

    /** 局外遗物抽取·当日单抽价格封顶（**0 = 不封顶**；见 `getOuterDrawCostBase`） */
    static getOuterDrawCostCap(): number {
        return Math.max(0, BattleConstUtil.getNumber('outerDrawCostCap', 600));
    }

    /* ===================================================================
     * 一局打完就发的局外金币（`common/RunClearReward` 的四个键）
     *
     * 口径真源 = `assets/scripts/game/common/RunClearReward.ts` 的文件头：
     *   `本局结算金币 = max(floor, base × decay^(N-1)) × clamp(到达阶段 / divisor, 0, 1)`
     * 这四条**都不乘难度收益倍率**（理由见那份文件头的口径 ③）。
     * =================================================================== */

    /** 按局结算金币·第 1 局的曲线值（金币） */
    static getRunClearGoldBase(): number {
        return Math.max(0, BattleConstUtil.getNumber('runClearGoldBase', 400));
    }

    /** 按局结算金币·每往后一局的衰减系数（0.6 = 每局只剩 60%） */
    static getRunClearGoldDecay(): number {
        return BattleConstUtil.getNumber('runClearGoldDecay', 0.6);
    }

    /** 按局结算金币·曲线下限（衰减到这里就不再降；这就是"之后每局很少"的那个数） */
    static getRunClearGoldFloor(): number {
        return Math.max(0, BattleConstUtil.getNumber('runClearGoldFloor', 40));
    }

    /** 按局结算金币·完成系数的分母 = 到达第几阶段算打满（3 = 阶段 3 起给满额） */
    static getRunClearGoldStageDivisor(): number {
        return Math.max(1, BattleConstUtil.getNumber('runClearGoldStageDivisor', 3));
    }

    /** 玩家经验公式基数 */
    static getPlayerExpFormulaBase(): number {
        return BattleConstUtil.getNumber('playerExpFormulaBase', 100);
    }
    /** 玩家经验公式增长率 */
    static getPlayerExpFormulaRatio(): number {
        return BattleConstUtil.getNumber('playerExpFormulaRatio', 1.15);
    }
    /** 英雄经验公式基数 */
    static getHeroExpFormulaBase(): number {
        return BattleConstUtil.getNumber('heroExpFormulaBase', 100);
    }
    /** 英雄经验公式增长率 */
    static getHeroExpFormulaRatio(): number {
        return BattleConstUtil.getNumber('heroExpFormulaRatio', 1.12);
    }

    /**
     * **英雄解锁**的金币基准价 —— 英雄列表（`units.json` 里 `category=hero`、按 id 升序）里
     * **序号最靠前**那一位的价格；每靠后一位 × `getHeroUnlockCostGrowth()`。
     *
     * 价格公式（唯一落点：`data/configs/HeroConfig.getUnlockCost`）：
     *   `cost(英雄) = round(基准 × 涨价系数 ^ 该英雄在英雄列表里的下标)`
     *
     * ⚠ 为什么按「序号」而不是每个英雄单独定价：本表是全局 KV 表，没有「一行一英雄」的位置；
     *   真要逐个定价，就在 `units` 表加一列 `unlock_cost`，并让 `HeroConfig.getUnlockCost` 优先读它。
     *   默认解锁的那位（`HeroData.defaultData` 里的 1001）即使算出来也不消耗。
     */
    static getHeroUnlockCostBase(): number {
        return BattleConstUtil.getNumber('heroUnlockCostBase', 500);
    }

    /** 英雄解锁的涨价系数（每靠后一位 ×该值；1 = 都一样贵） */
    static getHeroUnlockCostGrowth(): number {
        return BattleConstUtil.getNumber('heroUnlockCostGrowth', 1.35);
    }

    /** **英雄升级**（Lv.1 → 2）所需金币 */
    static getHeroLevelUpGoldBase(): number {
        return BattleConstUtil.getNumber('heroLevelUpGoldBase', 50);
    }

    /**
     * 英雄升级的涨价系数：`Lv.N → N+1` 的消耗 = `基数 × 系数^(N-1)`
     * （口径与 `heroExpFormulaRatio` 那套"指数递增"一致，只是这里换成了金币）。
     */
    static getHeroLevelUpGoldRatio(): number {
        return BattleConstUtil.getNumber('heroLevelUpGoldRatio', 1.25);
    }
    /** 局内战斗等级经验公式基数 */
    static getBattleExpFormulaBase(): number {
        return BattleConstUtil.getNumber('battleExpFormulaBase', 60);
    }
    /** 局内战斗等级经验公式增长率 */
    static getBattleExpFormulaRatio(): number {
        return BattleConstUtil.getNumber('battleExpFormulaRatio', 1.18);
    }
    // ⚠ 这里**没有** `getBattleLevelMax()`：局内英雄等级**不封顶**（2026-11 用户口径
    //   「取消等级限制，以前是 30 级」），`battle_constants.battleLevelMax` 这个键已从表里删掉。
    //   升级需求是指数曲线（上面两个键：现 `battleExpFormulaBase/Ratio = 60 / 1.12`），
    //   本身就是"越升越慢"的天然上限 —— 再加硬上限只会让后期经验白吃
    //   （见 `Scene_Game_Stage.addBattleExp` 的注释）。
    /** 通关局外玩家经验基数（结算时按配置发） */
    static getClearRewardPlayerExpBase(): number {
        return BattleConstUtil.getNumber('clearRewardPlayerExpBase', 50);
    }
    /**
     * 单局结算的**通用英雄经验**基数（`battle_constants.clearRewardHeroExpBase`，现 80）。
     *
     * ⚠ 键名里的 `clear` 是历史读法：2026-11 起它**不再是"通关才发"**那个数，
     *   而是「阶段 × 时间」加权后的**满额**（`common/RunClearHeroExp` 的公式里，
     *   进度 = 1 时的原始值就是它 × 难度收益倍率）。通关 ≈ 进度 1 ⇒ 满额 80，
     *   与旧口径的"通关固定 80"逐字相同 —— 低关卡手感不变。
     *
     * 消费点只有一处：`RunClearHeroExp.amountFor`（别在别处再读一遍）。
     */
    static getClearRewardHeroExpBase(): number {
        return Math.max(0, BattleConstUtil.getNumber('clearRewardHeroExpBase', 80));
    }

    /* ===================================================================
     * 一局打完就发的通用英雄经验（`common/RunClearHeroExp` 的六个键）
     *
     * 口径真源 = 那个文件的文件头：
     *   `进度 = w_stage × clamp(阶段/满额阶段,0,1) + w_time × clamp(秒数/满额秒数,0,1)`
     *   `实发 = clamp(round(基数 × 进度 × 难度收益倍率), 下限, 上限)`
     * ⚠ 与金币那条**刻意不同**：这一条**乘**难度收益倍率（见 `RunClearReward` 口径 ③）。
     * =================================================================== */

    /** 单局英雄经验·**阶段维度**的权重（现 0.6；与时间权重之和 = 1） */
    static getRunHeroExpWeightStage(): number {
        return Math.max(0, BattleConstUtil.getNumber('runHeroExpWeightStage', 0.6));
    }

    /** 单局英雄经验·**时间维度**的权重（现 0.4） */
    static getRunHeroExpWeightTime(): number {
        return Math.max(0, BattleConstUtil.getNumber('runHeroExpWeightTime', 0.4));
    }

    /** 单局英雄经验·阶段打满的档位（现 5 = 打到 Boss 阶段就满） */
    static getRunHeroExpStageFull(): number {
        return Math.max(1, BattleConstUtil.getNumber('runHeroExpStageFull', 5));
    }

    /** 单局英雄经验·时间打满的秒数（现 600 = 10 分钟） */
    static getRunHeroExpTimeFull(): number {
        return Math.max(1, BattleConstUtil.getNumber('runHeroExpTimeFull', 600));
    }

    /** 单局英雄经验·**保底下限**（现 8：打一局就有，准备期阵亡也给） */
    static getRunHeroExpMin(): number {
        return Math.max(0, BattleConstUtil.getNumber('runHeroExpMin', 8));
    }

    /**
     * 单局英雄经验·**单局上限**（现 1600）。
     * 依据：难度 100 档的满额 = 80 × `rewardMul(100)` ≈ 80 × 17.96 ≈ **1437** ——
     * 上限刻意留在它之上，所以**正常玩法够不到封顶**，它只在配表被调歪时兜底。
     */
    static getRunHeroExpMax(): number {
        return Math.max(0, BattleConstUtil.getNumber('runHeroExpMax', 1600));
    }

    /* ===================================================================
     * 结算面板「看广告翻倍」（`common/RewardAdBonus` 的三个键）
     * =================================================================== */

    /** 看广告翻倍·倍率下限（现 1.0；配 1.0 时"这一档没赚头"是允许的，见 `RewardAdBonus` 口径 ①） */
    static getSettleAdMulMin(): number {
        return Math.max(0, BattleConstUtil.getNumber('settleAdMulMin', 1.0));
    }

    /** 看广告翻倍·倍率上限（现 3.0） */
    static getSettleAdMulMax(): number {
        return Math.max(0, BattleConstUtil.getNumber('settleAdMulMax', 3.0));
    }

    /** 看广告翻倍·小数位数（现 1；上限 3 由 `RewardAdBonus.decimals()` 夹住） */
    static getSettleAdMulDecimals(): number {
        return Math.max(0, BattleConstUtil.getNumber('settleAdMulDecimals', 1));
    }
    /** 初始体力 */
    static getInitialStamina(): number {
        return BattleConstUtil.getNumber('initialStamina', 120);
    }
    /** 碰撞检测阈值（子弹命中判定距离） */
    static getCollisionDetectThreshold(): number {
        return BattleConstUtil.getNumber('collisionDetectThreshold', 30);
    }
    /** 实体默认碰撞半径（像素，用于实体分离/防重叠） */
    static getCollisionRadiusDefault(): number {
        return BattleConstUtil.getNumber('collisionRadiusDefault', 26);
    }
    /** 实体分离强度（0~1）：每帧解析重叠量的比例 */
    static getSeparationStrength(): number {
        return BattleConstUtil.getNumber('separationStrength', 0.6);
    }
    /** 初始金币 */
    static getInitialGold(): number {
        return BattleConstUtil.getNumber('initialGold', 100);
    }
    /**
     * **1 米 = 多少像素**（默认 50）。
     *
     * 为什么需要它：项目里距离类配置一律是**像素**（火枪射程 350、刷怪半径 650~800、
     * 技能 `cast_range`/`radius` 500~600），而设计稿与技能文案说的是**米**
     * （"击退 1m"、"爆炸半径 1.5m"、"范围 +1m"）。缺了这条口径，每个写位移/范围的
     * 地方都会各自拍一个数字（曾经就没有，击退这类机制无从落地）。
     *
     * 用法：**配表里写米，代码里乘它换成像素**，例如
     * `target.ApplyKnockback(attacker, kv.knockback * BattleConstUtil.getPxPerMeter())`。
     * 想整体调手感（击退/牵引/范围的观感）只改 battle_constants.json 的 `pxPerMeter` 一处。
     */
    static getPxPerMeter(): number {
        return BattleConstUtil.getNumber('pxPerMeter', 50);
    }
    /** 击杀奖励默认金币基数（单位未配置 goldReward 时兜底） */
    static getEnemyDropGoldDefault(): number {
        return BattleConstUtil.getNumber('enemyDropGoldDefault', 1);
    }
    /** 击杀奖励默认经验基数（单位未配置 expReward 时兜底） */
    static getEnemyDropExpDefault(): number {
        return BattleConstUtil.getNumber('enemyDropExpDefault', 10);
    }
    /** 初始 HP */
    static getInitialHp(): number {
        return BattleConstUtil.getNumber('initialHp', 100);
    }
    /** 初始能量 */
    static getInitialEnergy(): number {
        return BattleConstUtil.getNumber('initialEnergy', 100);
    }
    /** 弹道默认速度 */
    static getProjectileSpeedDefault(): number {
        return BattleConstUtil.getNumber('projectileSpeedDefault', 600);
    }

    /** 击杀奖励时间通胀系数：每秒加成（timeMul = 1 + min(elapsed * this, cap)） */
    static getRewardTimeBasePerSec(): number {
        return BattleConstUtil.getNumber('rewardTimeBasePerSec', 0.00067);
    }
    /** 击杀奖励时间通胀上限 */
    static getRewardTimeCap(): number {
        return BattleConstUtil.getNumber('rewardTimeCap', 0.4);
    }
    /** 金币 boss 相对常规 boss 的一次性金币加成倍率 */
    static getRewardBossGoldBonus(): number {
        return BattleConstUtil.getNumber('rewardBossGoldBonus', 10);
    }
    /** 经验 boss 相对常规 boss 的一次性经验加成倍率 */
    static getRewardBossExpBonus(): number {
        return BattleConstUtil.getNumber('rewardBossExpBonus', 10);
    }
}
