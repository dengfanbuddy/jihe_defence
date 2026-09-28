/**
 * HeroDataModule - 英雄/角色数据模块
 *
 * 数据内容：
 * - 已解锁英雄列表
 * - 每个英雄的等级、经验值、突破等级
 * - 当前出战阵容
 * - 英雄碎片数量
 */

import { DataModule } from '../DataModule';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/** 单个英雄的数据 */
export interface HeroInfo {
    /** 英雄配置 ID */
    id: number;
    /** 当前等级（无上限，可无限提升） */
    level: number;
    /** 当前经验值 */
    exp: number;
}

/** 英雄数据模块的数据结构 */
export interface IHeroData {
    /** 所有英雄数据，key = 英雄 ID */
    heroes: Record<number, HeroInfo>;
}

export class HeroDataModule extends DataModule<IHeroData> {
    constructor() {
        super('hero_data');
    }

    /**
     * 默认数据方法
     * @returns 返回一个包含空heroes对象的IHeroData接口类型数据
     */
    protected defaultData(): IHeroData {
        return {
            heroes: {
                // 默认解锁：火枪（units.json hero id 1001）
                1001: {
                    id: 1001,
                    level: 1,
                    exp: 0,
                }
            }
        };
    }

    // ────────────── 便捷方法 ──────────────

    /** 解锁英雄 */
    unlockHero(heroId: number): boolean {
        if (this.getHeroInfo(heroId)) return false;

        this.data.heroes[heroId] = {
            id: heroId,
            level: 1,
            exp: 0,
        };
        return true;
    }

    /** 获取英雄信息（不存在则返回 null） */
    getHeroInfo(heroId: number): HeroInfo | null {
        return this.data.heroes[heroId] ?? null;
    }

    /** 英雄增加经验 */
    addHeroExp(heroId: string, amount: number): boolean {
        const hero = this.data.heroes[heroId];
        if (!hero) return false;

        hero.exp += amount;
        let leveledUp = false;
        while (hero.exp >= this._expForNextLevel(hero.level)) {
            hero.exp -= this._expForNextLevel(hero.level);
            hero.level += 1;
            leveledUp = true;
        }
        return leveledUp;
    }

    /** 计算下一级所需经验（公式来自 battle_constants.json） */
    private _expForNextLevel(level: number): number {
        const base = BattleConstUtil.getHeroExpFormulaBase();
        const ratio = BattleConstUtil.getHeroExpFormulaRatio();
        return Math.floor(base * Math.pow(ratio, level - 1));
    }
}
