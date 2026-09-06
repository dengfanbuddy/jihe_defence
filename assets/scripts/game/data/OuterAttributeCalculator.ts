/**
 * OuterAttributeCalculator.ts — 局外属性计算器（v2 简化版）
 *
 * 抽象所有局外功能（装备、天赋等）的属性加成计算。
 * 每个功能注册自己的加成组，计算器汇总后按公式计算最终属性。
 *
 * 属性公式（v2）：
 *   final = base × (1 + sumPercent) + sumFlat
 *
 * 2 层加成类型：
 *   层 1 flat    — 固定值加成（加在百分比计算之后）
 *   层 2 percent — 百分比加成（乘在 base 上）
 *
 * 局外功能不包含 FINAL_MULTIPLY（该层由局内 Buff/技能提供）
 *
 * @example
 * ```ts
 * const calc = new OuterAttributeCalculator();
 * calc.addFeatureBonuses('equipment', someBonuses);
 * calc.addFeatureBonuses('talent', talentBonuses);
 * const finalAttrs = calc.getFinalAttributes({ atk: 18, maxHp: 120 });
 * // 按功能查看
 * const breakdown = calc.getAllFeatureBreakdown();
 * ```
 */

import { AttributeType, OuterBonusGroup, FeatureBonus } from '../battle/core/Types';

export class OuterAttributeCalculator {
  /** 所有已注册的功能加成组 */
  private featureGroups: Map<string, OuterBonusGroup> = new Map();

  /* ===== 功能管理 ===== */

  /** 注册一个功能的加成（会覆盖同名功能） */
  addFeatureBonuses(featureName: string, bonuses: OuterBonusGroup): void {
    this.featureGroups.set(featureName, bonuses);
  }

  /** 移除一个功能的加成 */
  removeFeatureBonuses(featureName: string): void {
    this.featureGroups.delete(featureName);
  }

  /** 获取某个功能的加成组 */
  getFeatureBonuses(featureName: string): OuterBonusGroup | null {
    return this.featureGroups.get(featureName) ?? null;
  }

  /** 获取所有已注册功能的名称 */
  getFeatureNames(): string[] {
    return Array.from(this.featureGroups.keys());
  }

  /** 清空所有功能加成 */
  clear(): void {
    this.featureGroups.clear();
  }

  /* ===== 汇总计算 ===== */

  /**
   * 获取所有功能的汇总加成组
   * 将各功能的 2 层加成按层累加
   */
  getTotalGroup(): OuterBonusGroup {
    const total: OuterBonusGroup = {
      flat: {},
      percent: {},
    };

    for (const [, group] of this.featureGroups) {
      this._mergeGroup(total, group);
    }

    return total;
  }

  /**
   * 计算最终属性值（局外预览用，不含 FINAL_MULTIPLY）
   * @param baseAttributes 英雄基础属性（配置表中的 baseAttributes）
   * @returns 最终属性值（包含所有局外加成）
   */
  getFinalAttributes(
    baseAttributes: Partial<Record<AttributeType, number>> | Array<[number, number]>
  ): Record<string, number> {
    const total = this.getTotalGroup();
    const result: Record<string, number> = {};

    // 归一化基础属性为 number key 对象（兼容二维数组与对象）
    const baseMap: Record<number, number> = {};
    if (Array.isArray(baseAttributes)) {
      for (const [id, v] of baseAttributes) baseMap[id] = v;
    } else {
      for (const key of Object.keys(baseAttributes)) baseMap[Number(key)] = baseAttributes[Number(key) as AttributeType] ?? 0;
    }

    // 收集所有涉及到的属性类型
    const allAttrs = new Set<AttributeType>();
    for (const key of Object.keys(baseMap)) allAttrs.add(Number(key) as AttributeType);
    for (const key of Object.keys(total.flat)) allAttrs.add(Number(key) as AttributeType);
    for (const key of Object.keys(total.percent)) allAttrs.add(Number(key) as AttributeType);

    for (const attr of allAttrs) {
      const base = baseMap[attr] ?? 0;
      const flat = (total.flat[attr] ?? 0) as number;
      const percent = (total.percent[attr] ?? 0) as number;

      // 公式: base × (1 + percent) + flat
      result[attr] = base * (1 + percent) + flat;
    }

    return result;
  }

  /** 计算单个属性的最终值 */
  getFinalAttribute(
    attr: AttributeType,
    baseValue: number
  ): number {
    const totals = this.getTotalGroup();
    const flat = (totals.flat[attr] ?? 0) as number;
    const percent = (totals.percent[attr] ?? 0) as number;
    return baseValue * (1 + percent) + flat;
  }

  /* ===== 属性总览（用于 UI） ===== */

  /**
   * 获取所有功能的属性贡献总览
   * 每个功能返回其加成组，用于 UI 展示
   */
  getAllFeatureBreakdown(): FeatureBonus[] {
    const breakdown: FeatureBonus[] = [];
    for (const [featureName, bonuses] of this.featureGroups) {
      breakdown.push({ featureName, bonuses });
    }
    return breakdown;
  }

  /**
   * 获取单个功能的属性贡献（用于 UI 分页）
   */
  getFeatureBreakdown(featureName: string): FeatureBonus | null {
    const bonuses = this.featureGroups.get(featureName);
    if (!bonuses) return null;
    return { featureName, bonuses };
  }

  /* ===== 内部工具 ===== */

  private _mergeGroup(dst: OuterBonusGroup, src: OuterBonusGroup): void {
    for (const layer of ['flat', 'percent'] as const) {
      for (const key of Object.keys(src[layer])) {
        const attr = Number(key) as AttributeType;
        const val = (src[layer][attr] ?? 0) as number;
        const existing = (dst[layer][attr] ?? 0) as number;
        (dst[layer] as Record<number, number>)[attr] = existing + val;
      }
    }
  }
}

/* ===== 便捷工厂函数 ===== */

/**
 * 创建一个包含所有已收集装备加成的计算器
 */
export function createEquipmentCalculator(): OuterAttributeCalculator {
  const calc = new OuterAttributeCalculator();
  // 装备加成在调用处从 EquipmentConfig.getAllEquipmentBonuses() 获取并注册
  return calc;
}
