/**
 * data 数据层统一导出
 *
 * 游戏其他模块通过此入口引用数据功能：
 *   import { DataCenter, CurrencyType } from '../data';
 */

// 基础工具
export { StorageUtil } from './StorageUtil';
export { DataModule } from './DataModule';

// 数据中心
export { DataCenter } from './DataCenter';

// 功能模块
export { PlayerInfoModule } from './funcs/PlayerInfo';
export type { IPlayerInfo } from './funcs/PlayerInfo';

export { HeroDataModule } from './funcs/HeroData';
export type { IHeroData, HeroInfo } from './funcs/HeroData';

export { ItemDataModule, CurrencyType } from './funcs/ItemData';
export type { IItemData, ICurrencies } from './funcs/ItemData';

// 装备收集模块（独立局外收集系统）
export { EquipmentCollectionModule } from './funcs/EquipmentCollection';
export type { IEquipmentCollection } from './funcs/EquipmentCollection';

// 局外属性计算器
export { OuterAttributeCalculator } from './OuterAttributeCalculator';
export type { OuterBonusGroup, FeatureBonus } from '../battle/core/Types';
