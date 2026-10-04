/**
 * PlayerInfoModule - 玩家基础信息模块
 *
 * 数据内容：
 * - 玩家名、等级、经验值
 * - 游戏统计数据（总局数、总击杀）
 * - 时间相关（创建时间、最后登录时间）
 *
 * ⚠ **升级经验口径 = 等级表**（`player_levels.json` / `LevelConfig`），
 *   旧版 `battle_constants.playerExpFormulaBase/Ratio` 公式只作为**表不可用时的回落**（LevelConfig 内部处理）。
 *   满级（等级表里 `exp = 0` 的那一级）后经验不再累积。
 *
 * ⚠ **发账号经验一律走 `DataCenter.ins.addAccountExp()`**，不要直接调 `addExp()`
 *   —— 升级时按等级表 `reward_gold` 发放的金币奖励在 DataCenter 那一层结算（本模块只负责等级与经验）。
 */

import { DataModule } from '../DataModule';
import { LevelConfig } from '../configs/LevelConfig';

/** 玩家基础信息数据结构 */
export interface IPlayerInfo {
    /** 玩家名称 */
    name: string;
    /** 当前等级 */
    level: number;
    /** 当前经验值 */
    exp: number;
    /** 升到下一级所需经验（**由等级表推导**，满级为 0） */
    expToNext: number;
    /** 累计游戏局数 */
    totalGames: number;
    /** 累计击杀数 */
    totalKills: number;
    /** 最高波数 */
    maxWave: number;
    /** 账号创建时间戳（ms） */
    createTime: number;
    /** 最后登录时间戳（ms） */
    lastLoginTime: number;
    /** 连续登录天数 */
    loginStreak: number;
    /** 今日是否已签到 */
    signedInToday: boolean;
    /** 头像 ID */
    avatarId: number;
}

/** 加经验的结果（升级区间供调用方（DataCenter）结算等级奖励） */
export interface ILevelUpResult {
    /** 本次是否升级 */
    leveledUp: boolean;
    /** 加经验前的等级 */
    fromLevel: number;
    /** 加经验后的等级 */
    toLevel: number;
}

export class PlayerInfoModule extends DataModule<IPlayerInfo> {
    constructor() {
        super('player_info');
    }

    protected defaultData(): IPlayerInfo {
        const now = Date.now();
        return {
            name: '新玩家',
            level: 1,
            exp: 0,
            // 等级表驱动（表未就绪时 LevelConfig 内部回落到旧公式）
            expToNext: LevelConfig.getExpToNext(1),
            totalGames: 0,
            totalKills: 0,
            maxWave: 0,
            createTime: now,
            lastLoginTime: now,
            loginStreak: 1,
            signedInToday: true,
            avatarId: 1,
        };
    }

    // ────────────── 便捷方法 ──────────────

    /**
     * 按等级表刷新 `expToNext`（读档后/切版本后调一次，把旧的公式值对齐到等级表）。
     * 幂等，`DataCenter.init()` 会调。
     */
    syncExpToNext(): void {
        const next = this.data.level >= LevelConfig.getMaxLevel()
            ? 0
            : LevelConfig.getExpToNext(this.data.level);
        if (this.data.expToNext !== next) this.data.expToNext = next;
        if (next === 0) this.data.exp = 0;
    }

    /**
     * 增加账号经验并按**等级表**处理升级。
     *
     * ⚠ 满级后经验不再累积（`exp` 归 0），避免界面显示 `exp/0` 之类的脏数据。
     * ⚠ 升级时按等级表 `reward_gold` 发金币的活儿在 `DataCenter.addAccountExp()`（本模块不碰货币）。
     */
    addExp(amount: number): ILevelUpResult {
        const fromLevel = this.data.level;
        if (amount > 0) this.data.exp += amount;
        let leveledUp = false;

        const maxLevel = LevelConfig.getMaxLevel();
        while (this.data.level < maxLevel) {
            const need = LevelConfig.getExpToNext(this.data.level);
            if (need <= 0) break; // 等级表这一行没写经验 = 到此为止（防止除零式死循环）
            if (this.data.exp < need) break;
            this.data.exp -= need;
            this.data.level += 1;
            leveledUp = true;
        }

        if (this.data.level >= maxLevel) {
            // 满级：清空溢出的经验
            this.data.exp = 0;
            this.data.expToNext = 0;
        } else {
            this.data.expToNext = LevelConfig.getExpToNext(this.data.level);
        }

        return { leveledUp, fromLevel, toLevel: this.data.level };
    }

    /** 记录一次游戏结束 */
    recordGameEnd(kills: number, wave: number): void {
        this.data.totalGames += 1;
        this.data.totalKills += kills;
        if (wave > this.data.maxWave) {
            this.data.maxWave = wave;
        }
    }

    /** 每日登录处理 */
    onDailyLogin(): void {
        const now = Date.now();
        const lastDate = new Date(this.data.lastLoginTime).toDateString();
        const todayDate = new Date(now).toDateString();

        if (lastDate !== todayDate) {
            const yesterday = new Date(Date.now() - 86400000).toDateString();
            this.data.loginStreak = lastDate === yesterday
                ? this.data.loginStreak + 1
                : 1;
            this.data.signedInToday = false;
        }
        this.data.lastLoginTime = now;
    }

    /** 签到 */
    signIn(): void {
        this.data.signedInToday = true;
    }
}
