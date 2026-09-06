/**
 * EquipmentCollectionModule - 局外装备收集数据模块
 *
 * 类似图鉴/成就系统的装备收集功能：
 * - 局内结束后掉落的装备记录在此
 * - 同一件装备可重复收集，属性累加
 * - 独立于道具背包（ItemDataModule）
 * - 通过 OuterAttributeCalculator 计算属性加成
 *
 * @example
 * ```ts
 * // 局内结束掉落装备
 * DataCenter.ins.equipCollection.addCollected(9);   // d2_iron_branch (id=9)
 * DataCenter.ins.equipCollection.addCollected(27);  // d2_battlefury (id=27)
 *
 * // 查看收集情况
 * const count = DataCenter.ins.equipCollection.getCollectedCount(9);
 * ```
 */

import { DataModule } from '../DataModule';

/** 局外装备收集数据 */
export interface IEquipmentCollection {
    /** 已收集的装备列表，key=装备ID, value=收集次数 */
    collected: Record<number, number>;
}

export class EquipmentCollectionModule extends DataModule<IEquipmentCollection> {
    constructor() {
        super('equip_collection');
    }

    protected defaultData(): IEquipmentCollection {
        return {
            collected: {},
        };
    }

    // ────────────── 收集操作 ──────────────

    /**
     * 添加收集一次装备
     * @param equipId 装备配置 ID（数字 ID，对应 equipments.json 中的 id）
     * @param count   收集次数（默认 1，装备掉落可指定数量）
     */
    addCollected(equipId: number, count: number = 1): void {
        if (count <= 0) return;
        const current = this.data.collected[equipId] ?? 0;
        this.data.collected[equipId] = current + count;
    }

    /**
     * 获取某件装备的收集次数
     */
    getCollectedCount(equipId: number): number {
        return this.data.collected[equipId] ?? 0;
    }

    /**
     * 获取所有已收集的装备 ID 列表
     */
    getAllCollectedIds(): number[] {
        return Object.keys(this.data.collected)
            .map(Number)
            .filter(id => !isNaN(id) && (this.data.collected[id] ?? 0) > 0);
    }

    /**
     * 获取所有已收集装备及其次数
     */
    getAllCollected(): Record<number, number> {
        return { ...this.data.collected };
    }

    /**
     * 获取已收集装备的总种类数
     */
    getDistinctCount(): number {
        return this.getAllCollectedIds().length;
    }

    /**
     * 获取所有收集的总次数（含重复）
     */
    getTotalCollectionCount(): number {
        let total = 0;
        for (const count of Object.values(this.data.collected)) {
            total += count;
        }
        return total;
    }

    /**
     * 检查某件装备是否已收集过
     */
    hasCollected(equipId: number): boolean {
        return (this.data.collected[equipId] ?? 0) > 0;
    }
}
