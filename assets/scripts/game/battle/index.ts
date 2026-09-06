/**
 * battle 战斗系统统一导出
 *
 * 事件总线（统一入口，调用风格一致）：
 *   - `EventBus`（battle/EventBus.ts 核心类）：
 *       · 全局用法：`EventBus.emit/on/off/clear`（静态门面，操作全局单例）
 *       · 实例用法：`new EventBus()`（战斗局部，如 ctx.bus），方法与全局一致，均用 emit/on/off；
 *         旧别名 publish/subscribe/unsubscribe 保留（等价于 emit/on/off）
 *   - `EventNames`（battle/core/EventBus.ts 兼容层）：旧 UI/场景层事件名常量
 */
export { EventBus, EventBus as CoreEventBus, EventBus as BattleEventBus } from './EventBus';
export type { EventHandler, Unsubscribe, BattleEventType } from './EventBus';
export { Entity } from './Entity';
export { Ability } from './Ability';
export { AbilitySystem } from './AbilitySystem';
export { AttributeSystem } from './AttributeSystem';
export { Modifier } from './Modifier';
export { ModifierSystem } from './ModifierSystem';
export { StatusSystem } from './StatusSystem';
export { DamagePipeline } from './DamagePipeline';
export { Projectile } from './Projectile';
export { EffectExecutor } from './EffectExecutor';
export type { ActionContext } from './EffectExecutor';
export { pickTarget, pickTargets } from './Targeting';
export type { TargetingStrategy } from './Targeting';
export { BattleContext, ScriptRegistry } from './BattleContext';
export { SpatialGrid } from './SpatialGrid';
export {
    DamageType,
    StateType,
    AttributeStackMode,
    ModifierStackMode,
    DispelLevel,
    BattleEvents,
} from './types';
export type {
    AttackEventData,
    DamageEventData,
    DeathEventData,
    AbilityCastEventData,
    ModifierEventData,
    AttributeContribution,
} from './types';

// ============ 配置体系 ============

export { ConfigLoader } from '../config/ConfigLoader';
export type {
    AttributeCfg,
} from '../excel_table/Tb_AttributeConfig';
export type {
    ModifierCfg,
    ModifierPropertyEntry,
    ModifierTickCfg,
    ModifierEventAction,
} from '../excel_table/Tb_ModifierConfig';
export type {
    ConfigAction,
    AbilityCfg,
    AbilityBehavior,
} from '../excel_table/Tb_AbilityConfig';
export type {
    RelicCfg,
    RelicModifierEntry,
} from '../excel_table/Tb_RelicConfig';
export type {
    UnitCfg,
} from '../excel_table/Tb_UnitConfig';

// ============ 肉鸽 / 商店 ============

export { ShopSystem } from './ShopSystem';
export type { ShopOption, EquipResult } from './ShopSystem';
export { BattleEquip, RelicSystem } from './BattleEquipSystem';
export { Ability_LightningChain } from './ScriptedAbilities';

// ============ 对象池 ============

export { EntityPool } from './EntityPool';

// ============ 怪物 AI 脚本系统 ============

export { MonsterAI, AIRegistry, ChaseAI, WanderAI, OrbitAI, AttackStopAI, BossAI, initializeAI } from './ai';

// ============ 战斗常量兼容（旧 battle/core 引用） ============

export { BattleConstUtil } from './core/BattleConstUtil';
export { EventNames } from './core/EventBus';
export type {
    AttributeType,
    EquipmentCategory,
    WeaponQuality,
    BonusLayerType,
    OuterBonusGroup,
    FeatureBonus,
    EquipmentConfig as EquipConfigType,
} from './core/Types';
