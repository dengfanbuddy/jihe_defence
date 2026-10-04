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
export type { IAccountExpResult, IHeroActionResult } from './DataCenter';

// 功能模块
export { PlayerInfoModule } from './funcs/PlayerInfo';
export type { IPlayerInfo, ILevelUpResult } from './funcs/PlayerInfo';

export { HeroDataModule } from './funcs/HeroData';
export type { IHeroData, HeroInfo } from './funcs/HeroData';

export { ItemDataModule, CurrencyType } from './funcs/ItemData';
export type { IItemData, ICurrencies } from './funcs/ItemData';

// 装备收集模块（独立局外收集系统）
export { EquipmentCollectionModule } from './funcs/EquipmentCollection';
export type { IEquipmentCollection } from './funcs/EquipmentCollection';

// 任务模块（日/周任务：进度上报 + 完成任务领账号经验/金币）
export { TaskDataModule, TargetMode } from './funcs/TaskData';
export type {
    ITaskData, TaskRecord, TaskState, TaskClaimResult, TaskGrantResult, TaskHost,
} from './funcs/TaskData';

// 成就模块（一次性永久目标：进度上报 + 领下一档发金币 + 末档效果开局快照）
export { AchievementDataModule } from './funcs/AchievementData';
export type {
    IAchievementData, AchRecord, AchState, AchGroupState, AchClaimResult, AchievementHost,
} from './funcs/AchievementData';

// 难度（关卡）进度模块（已通关档位 / 当前选择 / 上次玩过；曲线在 common/DifficultyConfig）
export { LevelDataModule } from './funcs/LevelData';
export type { ILevelData } from './funcs/LevelData';

// 配置门面：等级表 / 任务表 / 成就表 / 英雄表
export { LevelConfig, LevelFeature } from './configs/LevelConfig';
export type { PlayerLevelCfg } from './configs/LevelConfig';
export { TaskConfig } from './configs/TaskConfig';
export type { TaskCfg, TaskType, TaskTarget } from './configs/TaskConfig';
export { AchievementConfig, ACH_TARGET_MODE } from './configs/AchievementConfig';
export type { AchCfg, AchCategory, AchGroupCfg, AchTarget } from './configs/AchievementConfig';
export { HeroConfig } from './configs/HeroConfig';
export type { HeroAttrRow } from './configs/HeroConfig';

// 局外属性计算器
export { OuterAttributeCalculator } from './OuterAttributeCalculator';
export type { OuterBonusGroup, FeatureBonus } from '../battle/core/Types';
