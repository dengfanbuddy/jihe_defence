/**
 * PlayerInfoModule - 玩家基础信息模块
 *
 * 数据内容：
 * - 玩家名、等级、经验值
 * - 游戏统计数据（总局数、总击杀）
 * - 时间相关（创建时间、最后登录时间）
 */

import { DataModule } from '../DataModule';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/** 玩家基础信息数据结构 */
export interface IPlayerInfo {
    /** 玩家名称 */
    name: string;
    /** 当前等级 */
    level: number;
    /** 当前经验值 */
    exp: number;
    /** 升到下一级所需经验 */
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
            expToNext: BattleConstUtil.getPlayerExpFormulaBase(),
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

    /** 增加经验值，处理升级 */
    addExp(amount: number): boolean {
        this.data.exp += amount;
        let leveledUp = false;
        while (this.data.exp >= this.data.expToNext) {
            this.data.exp -= this.data.expToNext;
            this.data.level += 1;
            this.data.expToNext = Math.floor(this.data.expToNext * BattleConstUtil.getPlayerExpFormulaRatio());
            leveledUp = true;
        }
        return leveledUp;
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
