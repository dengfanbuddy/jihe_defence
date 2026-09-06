/**
 * EquipmentConfig.ts — 局外装备配置数据（从 JSON 配置表加载）
 *
 * 数据源：assets/resources/tb/equipments.json
 * 通过 ConfigLoader 在 Main.ts 启动时加载
 *
 * 新功能：装备不再有孔位，改为局外收集属性加成系统。
 * 每件收集到的装备贡献属性加成到 OuterAttributeCalculator。
 *
 * v2：属性统一 number 编号（AttributeType），
 *     兼容旧配置字符串键（atk/maxHp...），转换层自动映射。
 */

import { TbRoot } from "../../../platform/excel_table/TbRoot";
import { AttributeType, EquipmentCategory, EquipmentConfig, WeaponQuality, OuterBonusGroup, BonusLayerType } from "../../battle/core/Types";
import { EquipCfgContainer, EquipCfg } from "../../excel_table/Tb_EquipmentConfig";
import { DataCenter } from "../DataCenter";
import { ConfigLoader } from "../../config/ConfigLoader";

/** 属性名（旧配置字符串键）→ 编号 */
function attrKeyToId(key: string): number {
  const n = Number(key);
  return Number.isNaN(n) ? ConfigLoader.nameToAttrId(key) : n;
}

/**
 * JSON 装备实体 → EquipmentConfig（业务层类型）
 * attributes 统一转为二维数组 [[attrId, value], ...]
 */
function equipJsonToConfig(json: EquipCfg): EquipmentConfig {
  const attributes = Array.isArray(json.attributes)
    ? (json.attributes as [number, number][])
    : Object.entries(json.attributes ?? {}).map(([k, v]) => [attrKeyToId(k), v] as [number, number]);

  const bonusTypes = Array.isArray(json.bonusTypes)
    ? (json.bonusTypes as [number, BonusLayerType][])
    : Object.entries(json.bonusTypes ?? {}).map(([k, v]) => [attrKeyToId(k), v as BonusLayerType] as [number, BonusLayerType]);

  return {
    id: json.id,
    name: json.name,
    description: json.description,
    category: json.category as EquipmentCategory,
    quality: json.quality as WeaponQuality,
    heroId: json.heroId,
    attributes,
    bonusTypes,
    allPercent: json.allPercent,
  };
}

/** 根据 ID 获取装备配置 */
export function getEquipmentConfig(equipId: number): EquipmentConfig | undefined {
  const container = TbRoot.ins.getTbContainer(EquipCfgContainer);
  const item = container.getCfgById(equipId);
  return item ? equipJsonToConfig(item) : undefined;
}

/** 获取所有装备列表 */
export function getAllEquipments(): EquipmentConfig[] {
  const container = TbRoot.ins.getTbContainer(EquipCfgContainer);
  return container.cfgs.map(item => equipJsonToConfig(item));
}

/** 获取指定英雄的专属装备 ID */
export function getHeroSpecificEquipId(heroId: string): number | undefined {
  const container = TbRoot.ins.getTbContainer(EquipCfgContainer);
  const found = container.cfgs.find(item => item.heroId === heroId);
  return found?.id;
}

/** 按装备类别筛选 */
export function getEquipmentsByCategory(category: string): EquipmentConfig[] {
  const container = TbRoot.ins.getTbContainer(EquipCfgContainer);
  return container.cfgs
    .filter(item => item.category === category)
    .map(item => equipJsonToConfig(item));
}

/** 按品质筛选 */
export function getEquipmentsByQuality(minQuality: number): EquipmentConfig[] {
  const container = TbRoot.ins.getTbContainer(EquipCfgContainer);
  return container.cfgs
    .filter(item => item.quality >= minQuality)
    .map(item => equipJsonToConfig(item));
}

/* ===================================================================
 * 装备 → OuterBonusGroup 转换（v2 简化版）
 * =================================================================== */

/**
 * 获取属性的默认层类型
 * quality < 2.5 → 'flat'（固定值）
 * quality >= 2.5 → 'percent'（百分比）
 */
function getDefaultLayerForQuality(quality: number): BonusLayerType {
  return quality >= 2.5 ? 'percent' : 'flat';
}

/**
 * 将单件装备配置转换为 OuterBonusGroup（2 层结构）
 * 根据 quality 和 bonusTypes 决定每个属性属于 flat 还是 percent
 */
export function equipmentConfigToBonuses(config: EquipmentConfig): OuterBonusGroup {
  const group: OuterBonusGroup = {
    flat: {},
    percent: {},
  };

  const defaultLayer = getDefaultLayerForQuality(config.quality);

  // 属性为二维数组 [[attrId, value], ...]
  for (const [attrId, value] of config.attributes) {
    if (value === undefined || value === 0) continue;

    // 分层映射（bonusTypes 数组或对象）
    let layer: string = defaultLayer;
    if (Array.isArray(config.bonusTypes)) {
      const found = config.bonusTypes.find(([id]) => id === attrId);
      if (found) layer = found[1];
    } else if (config.bonusTypes) {
      // 对象形式（旧配置兼容）
      const found = Object.entries(config.bonusTypes).find(([k]) => Number(k) === attrId);
      if (found) layer = found[1] as string;
    }

    if (layer === 'flat' || layer === 'percent') {
      (group[layer] as Record<number, number>)[attrId] = value;
    } else {
      const targetLayer: 'flat' | 'percent' =
        layer.includes('Percent') || layer.includes('percent') ? 'percent' : 'flat';
      (group[targetLayer] as Record<number, number>)[attrId] = value;
    }
  }

  // 旧版 allPercent 合并到 percent 层（对所有已有属性生效）
  if (config.allPercent) {
    for (const key of Object.keys(group.percent)) {
      const attrId = Number(key);
      (group.percent as Record<number, number>)[attrId] =
        ((group.percent as Record<number, number>)[attrId] ?? 0) + config.allPercent;
    }
  }

  return group;
}

/**
 * 获取所有已收集装备的总加成组
 * 从 DataCenter.ins.equipCollection 读取装备收集记录，
 * 每件装备的加成 × 收集次数（可重复收集，属性累加）
 */
export function getAllEquipmentBonuses(): OuterBonusGroup {
  const total: OuterBonusGroup = {
    flat: {},
    percent: {},
  };

  // 从装备收集系统读取所有已收集的装备
  const collection = DataCenter.ins.equipCollection;
  const allCollectedIds = collection.getAllCollectedIds();

  for (const equipId of allCollectedIds) {
    const config = getEquipmentConfig(equipId);
    if (!config) continue;

    const count = collection.getCollectedCount(equipId);
    if (count <= 0) continue;

    // 计算单件装备的基础加成组
    const baseBonuses = equipmentConfigToBonuses(config);

    // 乘以收集次数（可重复收集，属性累加）
    for (const layer of ['flat', 'percent'] as const) {
      for (const key of Object.keys(baseBonuses[layer])) {
        const attrId = Number(key) as AttributeType;
        const val = (baseBonuses[layer][attrId] ?? 0) as number;
        if (val === 0) continue;
        const existing = (total[layer][attrId] ?? 0) as number;
        (total[layer] as Record<number, number>)[attrId] = existing + val * count;
      }
    }
  }

  return total;
}

/**
 * 将 src 的加成合并到 dst（2 层版本）
 */
function mergeBonusGroup(dst: OuterBonusGroup, src: OuterBonusGroup): void {
  for (const layer of ['flat', 'percent'] as const) {
    for (const key of Object.keys(src[layer])) {
      const attrId = Number(key) as AttributeType;
      const val = src[layer][attrId] as number;
      const existing = (dst[layer][attrId] ?? 0) as number;
      (dst[layer] as Record<number, number>)[attrId] = existing + val;
    }
  }
}
