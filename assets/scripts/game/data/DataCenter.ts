/**
 * DataCenter - 数据中心（单例）
 *
 * 职责：
 * - 持有所有数据模块的引用
 * - 统一初始化、保存、重置
 * - 作为游戏逻辑访问数据的唯一入口
 *
 * 用法：
 *   // 游戏启动时
 *   DataCenter.ins.init();
 *
 *   // 游戏中读写数据
 *   DataCenter.ins.playerInfo.data.level;
 *   DataCenter.ins.itemData.addCurrency(CurrencyType.Gold, 100);
 *
 *   // 游戏退出前或切后台时
 *   DataCenter.ins.saveAll();
 *
 *   // 重置账号
 *   DataCenter.ins.resetAll();
 */

import { StorageUtil } from './StorageUtil';
import { PlayerInfoModule } from './funcs/PlayerInfo';
import { HeroDataModule } from './funcs/HeroData';
import { ItemDataModule, CurrencyType } from './funcs/ItemData';
import { EquipmentCollectionModule } from './funcs/EquipmentCollection';
import { TaskDataModule } from './funcs/TaskData';
import { AchievementDataModule } from './funcs/AchievementData';
import { LevelDataModule } from './funcs/LevelData';
import type { ILevelUpResult } from './funcs/PlayerInfo';
import type { TaskGrantResult, TaskHost } from './funcs/TaskData';
import type { AchievementHost } from './funcs/AchievementData';
import { LevelConfig } from './configs/LevelConfig';
import { HeroConfig } from './configs/HeroConfig';

/** 发账号经验的结果（= 升级区间 + 该区间按等级表结算的金币奖励） */
export interface IAccountExpResult extends ILevelUpResult {
    /** 升级过程中按等级表 `reward_gold` 汇总的金币（已发放） */
    bonusGold: number;
}

/**
 * **英雄操作**（解锁 / 升级）的结果 —— `DataCenter.unlockHero` / `levelUpHero` 的返回。
 *
 * 界面只读这个结构画提示，**不自己重算判据**（够不够钱、解没解锁都是数据层给的答案）。
 */
export interface IHeroActionResult {
    ok: boolean;
    /**
     * 失败原因（`ok=true` 时是空串）：
     *   `unknown_hero`     配表里没有这个英雄（表未就绪 / id 写错）
     *   `already_unlocked` 已经解锁了（重复点）
     *   `locked`           还没解锁就想升级
     *   `no_gold`          局外金币不足
     */
    reason: '' | 'unknown_hero' | 'already_unlocked' | 'locked' | 'no_gold';
    /** 本次**实际消耗**的局外金币（失败为 0） */
    cost: number;
    /** 操作后的英雄等级（失败为 0） */
    level: number;
}

export class DataCenter {
    private static _ins: DataCenter;

    static get ins(): DataCenter {
        if (!DataCenter._ins) {
            DataCenter._ins = new DataCenter();
        }
        return DataCenter._ins;
    }

    //玩家基本信息
    playerInfo = new PlayerInfoModule();
    //解锁的英雄数据
    heroData = new HeroDataModule();
    //道具数据
    itemData = new ItemDataModule();
    //局外装备收集（类似图鉴系统）
    equipCollection = new EquipmentCollectionModule();
    //任务数据（日/周任务进度 + 领奖发经验/金币）
    taskData = new TaskDataModule();
    //成就数据（一次性永久目标 + 领奖发金币 + 末档效果快照，见 docs/成就系统设计.md）
    achieveData = new AchievementDataModule();
    //难度（关卡）进度：已通关档位 / 当前选择 / 上次玩过 —— 难度弹窗与局内难度缩放的唯一数据源
    levelData = new LevelDataModule();

    private _inited = false;
    private _migrated = false;

    private constructor() {
        // 任务模块的宿主能力（等级过滤 + 发奖）。
        // 用**注入**而不是让 TaskData 直接 import DataCenter：那会形成模块循环依赖。
        const host: TaskHost = {
            getAccountLevel: () => this.playerInfo.data.level,
            grantReward: (exp, gold, taskId) => this.grantTaskReward(exp, gold, taskId),
        };
        this.taskData.setHost(host);

        // 成就模块的宿主能力（与任务同一套路：注入而不是互相 import）
        const achHost: AchievementHost = {
            getAccountLevel: () => this.playerInfo.data.level,
            getLoginStreak: () => this.playerInfo.data.loginStreak,
            // 遗物**图鉴**种类数（`relic_collected` 的数据源）：
            // 收集记录只由 `RelicShop.grantRelic` 写入，且已过滤成「有局外版」的那 37 件，
            // 所以这里直接取种类数就与图鉴页 `Cmp_OuterRelics` 的「已收集 N/37」同口径
            getRelicKinds: () => this.equipCollection.getDistinctCount(),
            grantReward: (gold, group) => this.grantAchieveReward(gold, group),
        };
        this.achieveData.setHost(achHost);
    }

    /** 初始化数据中心（加载所有数据） */
    init(): void {
        if (this._inited) return;
        this._inited = true;

        // 模块在构造函数中已自动加载，此处只需标记初始化完成
        // 如果需要额外的初始化逻辑（如版本迁移），在这里加
        this._migrateIfNeeded();

        // 等级表驱动的以下两件事必须在这里对齐一次（此时 TbRoot 已加载完）：
        // ① 读档里的 expToNext 可能是旧公式算出来的 → 按等级表刷新
        this.playerInfo.syncExpToNext();
        // ② 任务周期（跨天/跨周重置 + 每日登录置完成）
        this.taskData.ensurePeriod();
        // ③ 账号等级上报给「等级类」任务（如「账号达到 5 级」）
        this.taskData.peakProgress('level_reached', this.playerInfo.data.level);
        // ④ 成就里**不需要打一局就会变**的那几条（账号等级 / 连续登录 / 遗物种类数 / 两个种类集合）
        this.achieveData.syncNonRunPeaks();

        console.log('[DataCenter] 数据中心初始化完成');
    }

    // ────────────── 账号经验 / 等级（唯一入口） ──────────────

    /**
     * 发**账号经验**（全项目唯一入口，**不要**直接调 `playerInfo.addExp()`）。
     *
     * 为什么必须走这里：升级时按等级表 `reward_gold` 发放的金币奖励在本方法里结算，
     * 并且会把新等级上报给「账号等级」类任务；绕过它就等于丢掉等级奖励与任务进度。
     *
     * @param amount 经验值（≤0 只做一次等级对齐）
     */
    addAccountExp(amount: number): IAccountExpResult {
        const res = this.playerInfo.addExp(amount);

        // 等级奖励：跨过的每一级都算（一次加满多级时逐级累加）
        let bonusGold = 0;
        for (let lv = res.fromLevel + 1; lv <= res.toLevel; lv++) {
            bonusGold += LevelConfig.getGoldReward(lv);
        }
        if (bonusGold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, bonusGold);
        }

        if (res.leveledUp) {
            // 等级类任务（tasks.json 的 target = level_reached）
            this.taskData.peakProgress('level_reached', res.toLevel);
            // 成就：累计升级次数（add 型 —— 一次加满多级就按跨过的级数累加）
            this.achieveData.addProgress('level_up_count', res.toLevel - res.fromLevel);
            // 成就：账号等级（峰值型）—— 与 taskData 上面那行同一个落点，
            // 领奖/打局升级后**立刻**刷新，不必等下次 `syncNonRunPeaks()`（否则红点会慢一拍）
            this.achieveData.peakProgress('level_reached', res.toLevel);
            console.log(`[账号] 升级 ${res.fromLevel} → ${res.toLevel}（等级 ${res.toLevel}：${LevelConfig.getDesc(res.toLevel) || '无新解锁'}）`
                + (bonusGold > 0 ? `，等级奖励 +${bonusGold} 金币` : ''));
        }
        return { ...res, bonusGold };
    }

    /**
     * 任务领奖回填（`TaskData.claim()` 通过 TaskHost 回调到这里）：
     * 账号经验走 `addAccountExp`（含等级奖励），金币直接进 ItemData。
     */
    private grantTaskReward(exp: number, gold: number, _taskId: number): TaskGrantResult {
        const res = this.addAccountExp(exp);
        if (gold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, gold);
        }
        this.saveAll();
        return {
            leveledUp: res.leveledUp,
            fromLevel: res.fromLevel,
            toLevel: res.toLevel,
            bonusGold: res.bonusGold,
        };
    }

    /**
     * 成就领奖回填（`AchievementData.claim()` 通过 `AchievementHost` 回调到这里）。
     *
     * 与任务领奖的区别：成就**只发金币、不发账号经验**，也不产生「等级奖励」结算
     * （「末档效果永久生效」不需要在这里发 —— `AchievementData` 落盘 `claimedTier` 就等于生效，
     * 消费方开局读 `getEffects()` 快照）。
     */
    private grantAchieveReward(gold: number, _group: string): void {
        if (gold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, gold);
        }
        this.saveAll();
    }

    // ────────────── 英雄解锁 / 升级（唯一入口：含扣金币） ──────────────

    /**
     * **花金币解锁英雄**（英雄页「解 锁」按钮的唯一入口）。
     *
     * 分工：价格与公式在 `configs/HeroConfig`（读 `battle_constants`），
     * 纯数据操作在 `heroData.unlockHero`，**金币只在这里扣**（本项目局外金币的唯一出口是 `itemData`）。
     * 顺序是「先校验 → 再扣钱 → 再写存档」，任何一步不满足都不动数据。
     */
    unlockHero(heroId: number): IHeroActionResult {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) {
            return { ok: false, reason: 'unknown_hero', cost: 0, level: 0 };
        }
        if (this.heroData.isUnlocked(heroId)) {
            return { ok: false, reason: 'already_unlocked', cost: 0, level: this.heroData.getHeroLevel(heroId) };
        }

        const cost = HeroConfig.getUnlockCost(heroId);
        if (cost > 0) {
            if (!this.itemData.hasEnoughCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: 0 };
            }
            if (!this.itemData.spendCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: 0 };
            }
        }

        this.heroData.unlockHero(heroId);
        // ⚠ 不往 tasks/achievements 的 `spend_gold` 上报：那条口径是**局内**累计消耗金币
        //   （见 Tb_TaskConfig 的字段说明与 `Scene_Game_Stage` 的上报点），
        //   局外金币（itemData）与局内金币（hero.gold）是两套经济，混在一起会把任务进度算错。
        this.saveAll();

        const level = this.heroData.getHeroLevel(heroId);
        console.log(`[英雄] 解锁 ${cfg.name}（id=${heroId}），消耗 ${cost} 金币，当前 Lv.${level}`);
        return { ok: true, reason: '', cost, level };
    }

    /**
     * **花金币给已解锁英雄升 1 级**（英雄页「升 级」按钮的唯一入口）。
     * 等级无上限（`HeroData` 的口径），价格随等级指数上涨（`HeroConfig.getLevelUpCost`）。
     */
    levelUpHero(heroId: number): IHeroActionResult {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) {
            return { ok: false, reason: 'unknown_hero', cost: 0, level: 0 };
        }
        const info = this.heroData.getHeroInfo(heroId);
        if (!info) {
            return { ok: false, reason: 'locked', cost: 0, level: 0 };
        }

        const cost = HeroConfig.getLevelUpCost(info.level);
        if (cost > 0) {
            if (!this.itemData.hasEnoughCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: info.level };
            }
            if (!this.itemData.spendCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: info.level };
            }
        }

        this.heroData.addLevel(heroId);
        // ⚠ 同样**不**上报 `hero_level` 与 `spend_gold`：
        //   · `hero_level` 在成就里指的是**单局局内**英雄等级（`Scene_Game_Stage` 每局上报峰值），
        //     把局外等级喂进去会让"单局打到 Lv.5"被一次局外升级顶掉；
        //   · `spend_gold` 是局内金币口径（见 `unlockHero` 里那段说明）。
        this.saveAll();

        console.log(`[英雄] ${cfg.name} 升级到 Lv.${info.level}，消耗 ${cost} 金币`);
        return { ok: true, reason: '', cost, level: info.level };
    }

    /** 保存所有模块到 localStorage */
    saveAll(): void {
        this.playerInfo.save();
        this.heroData.save();
        this.itemData.save();
        this.equipCollection.save();
        this.taskData.save();
        this.achieveData.save();
        this.levelData.save();
        console.log('[DataCenter] 全部数据已保存');
    }

    /** 重置所有数据到默认值 */
    resetAll(): void {
        this.playerInfo.reset();
        this.heroData.reset();
        this.itemData.reset();
        this.equipCollection.reset();
        this.taskData.reset();
        this.achieveData.reset();
        this.levelData.reset();
        console.log('[DataCenter] 全部数据已重置');
    }

    /** 重置指定模块 */
    resetModule(moduleName: 'playerInfo' | 'heroData' | 'itemData' | 'equipCollection' | 'taskData' | 'achieveData' | 'levelData'): void {
        this[moduleName].reset();
    }

    /** 导出全部数据为 JSON（用于云存档） */
    exportAll(): Record<string, string> {
        return {
            playerInfo: this.playerInfo.serialize(),
            heroData: this.heroData.serialize(),
            itemData: this.itemData.serialize(),
            equipCollection: this.equipCollection.serialize(),
            taskData: this.taskData.serialize(),
            achieveData: this.achieveData.serialize(),
            levelData: this.levelData.serialize(),
        };
    }

    /** 从 JSON 导入全部数据（用于云存档恢复） */
    importAll(data: Record<string, string>): void {
        if (data.playerInfo) this.playerInfo.deserialize(data.playerInfo);
        if (data.heroData) this.heroData.deserialize(data.heroData);
        if (data.itemData) this.itemData.deserialize(data.itemData);
        if (data.equipCollection) this.equipCollection.deserialize(data.equipCollection);
        if (data.taskData) this.taskData.deserialize(data.taskData);
        if (data.achieveData) this.achieveData.deserialize(data.achieveData);
        if (data.levelData) this.levelData.deserialize(data.levelData);
    }

    /** 释放所有模块资源（用于游戏销毁时） */
    disposeAll(): void {
        this.playerInfo.dispose();
        this.heroData.dispose();
        this.itemData.dispose();
        this.equipCollection.dispose();
        this.taskData.dispose();
        this.achieveData.dispose();
        this.levelData.dispose();
        this._inited = false;
        console.log('[DataCenter] 数据中心已释放');
    }

    // ────────────── 数据版本迁移 ──────────────

    private static readonly DATA_VERSION_KEY = 'data_version';
    private static readonly CURRENT_VERSION = 1;

    /** 检查是否需要数据版本迁移 */
    private _migrateIfNeeded(): void {
        if (this._migrated) return;
        this._migrated = true;
        const savedVersion = StorageUtil.getItem<number>(DataCenter.DATA_VERSION_KEY) ?? 0;

        if (savedVersion < DataCenter.CURRENT_VERSION) {
            // 未来版本迁移逻辑：
            // if (savedVersion < 2) { this._migrateV1ToV2(); }
            // if (savedVersion < 3) { this._migrateV2ToV3(); }

            StorageUtil.setItem(DataCenter.DATA_VERSION_KEY, DataCenter.CURRENT_VERSION);
            console.log(`[DataCenter] 数据版本已迁移: v${savedVersion} → v${DataCenter.CURRENT_VERSION}`);
        }
    }
}
