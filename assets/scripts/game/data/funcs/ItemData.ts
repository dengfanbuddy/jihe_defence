/**
 * ItemDataModule - 道具/资源数据模块
 *
 * 数据内容：
 * - 货币（金币、钻石等）
 * - 背包道具（物品 ID → 数量）
 *
 * 注意：装备收集已移至独立的 EquipmentCollectionModule（局外装备收集系统）。
 */

import { DataModule } from '../DataModule';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/** 货币类型枚举 */
export enum CurrencyType {
    Gold = 'gold',
    Diamond = 'diamond',
    /** 体力 */
    Stamina = 'stamina',
    /** 荣誉点 */
    Honor = 'honor',
}

/** 货币数据 */
export interface ICurrencies {
    [CurrencyType.Gold]: number;
    [CurrencyType.Diamond]: number;
    [CurrencyType.Stamina]: number;
    [CurrencyType.Honor]: number;
}

/** 道具数据模块的数据结构 */
export interface IItemData {
    /** 货币 */
    currencies: ICurrencies;
    /** 背包道具 key = 道具配置 ID, value = 数量 */
    items: Record<string, number>;
}

export class ItemDataModule extends DataModule<IItemData> {
    constructor() {
        super('item_data');
    }

    protected defaultData(): IItemData {
        return {
            currencies: {
                [CurrencyType.Gold]: 0,
                [CurrencyType.Diamond]: 0,
                [CurrencyType.Stamina]: BattleConstUtil.getInitialStamina(),
                [CurrencyType.Honor]: 0,
            },
            items: {},
        };
    }

    // ────────────── 货币操作 ──────────────

    /** 获取货币数量 */
    getCurrency(type: CurrencyType): number {
        return this.data.currencies[type] ?? 0;
    }

    /** 增加货币 */
    addCurrency(type: CurrencyType, amount: number): void {
        if (amount <= 0) return;
        this.data.currencies[type] = (this.data.currencies[type] ?? 0) + amount;
    }

    /** 消耗货币，返回是否成功 */
    spendCurrency(type: CurrencyType, amount: number): boolean {
        if (amount <= 0) return true;
        const current = this.data.currencies[type] ?? 0;
        if (current < amount) return false;
        this.data.currencies[type] = current - amount;
        return true;
    }

    /** 判断货币是否足够 */
    hasEnoughCurrency(type: CurrencyType, amount: number): boolean {
        return (this.data.currencies[type] ?? 0) >= amount;
    }

    // ────────────── 道具操作 ──────────────

    /** 获取道具数量 */
    getItemCount(itemId: string): number {
        return this.data.items[itemId] ?? 0;
    }

    /** 增加道具 */
    addItem(itemId: string, count: number): void {
        if (count <= 0) return;
        this.data.items[itemId] = (this.data.items[itemId] ?? 0) + count;
    }

    /** 消耗道具，返回是否成功 */
    removeItem(itemId: string, count: number): boolean {
        if (count <= 0) return true;
        const current = this.data.items[itemId] ?? 0;
        if (current < count) return false;
        const remaining = current - count;
        if (remaining <= 0) {
            delete this.data.items[itemId];
        } else {
            this.data.items[itemId] = remaining;
        }
        return true;
    }

    /** 获取背包道具数量（不同种类的数量） */
    getItemCountDistinct(): number {
        return Object.keys(this.data.items).length;
    }
}
