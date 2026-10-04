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
    battleLevelMax: 30,
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
    /** 局内战斗等级上限 */
    static getBattleLevelMax(): number {
        return BattleConstUtil.getNumber('battleLevelMax', 30);
    }
    /** 通关局外玩家经验基数（结算时按配置发） */
    static getClearRewardPlayerExpBase(): number {
        return BattleConstUtil.getNumber('clearRewardPlayerExpBase', 50);
    }
    /** 通关局外英雄经验基数（结算时按配置发） */
    static getClearRewardHeroExpBase(): number {
        return BattleConstUtil.getNumber('clearRewardHeroExpBase', 80);
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
