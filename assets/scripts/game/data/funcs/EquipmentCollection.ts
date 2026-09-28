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
 * DataCenter.ins.equipCollection.addCollected(1068);   // 铁树枝干（relics.json，有局外版）
 * DataCenter.ins.equipCollection.addCollected(1167);   // 狂战斧（relics.json，有局外版）
 *
 * // 查看收集情况
 * const count = DataCenter.ins.equipCollection.getCollectedCount(1068);
 * ```
 *
 * ⚠ 2026-07：遗物表改成「一件遗物一行」，局内版 / 局外版**共用同一个 id**，本模块存的 id 即 relic id。
 * 有局外版的遗物用它的局内 id（1001~1293 段），只有局外版的遗物是 1294~1302。
 * （更早的两次数值/结构迁移：装备 id 1~45 → +2000 → 再并入遗物并用局内 id，见
 *  `tools/excel_export/reports/equipments-into-relics.md` 与 `reports/relics-scope-restructure.md`）
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
     * @param equipId 装备配置 ID（= relics.json 里**有局外版**的遗物 id：两侧都有的用局内 id，只有局外版的是 1294~1302）
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
