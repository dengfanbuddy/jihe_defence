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
export { pickTarget, pickTargets, pickTargetAtPoint } from './Targeting';
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
    MODIFY_ATTR_TEMPLATE_ID,
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
    ModifierEventAction,
} from '../excel_table/Tb_ModifierConfig';
export type {
    AttrEntry,
    AttrEffectEntry,
    ModifierEffect,
    ModifierTickEffect,
    ModifyAttrEffect,
    ApplyStateEffect,
} from '../excel_table/EffectTypes';
export { resolveAttrEntries, normalizeAttrEntry, isTickEffect } from '../excel_table/EffectTypes';
export type {
    ConfigAction,
    AbilityCfg,
    AbilityBehavior,
    AbilityScope,
    AbilityRarity,
} from '../excel_table/Tb_AbilityConfig';
export {
    abilityInShop,
    abilityMaxLevel,
    abilityEffectsAtLevel,
    abilityLevelDesc,
    AbilityCfgContainer,
} from '../excel_table/Tb_AbilityConfig';
export type {
    RelicCfg,
    RelicModifierEntry,
    RelicRarity,
} from '../excel_table/Tb_RelicConfig';
export type {
    UnitCfg,
} from '../excel_table/Tb_UnitConfig';
export type {
    KillBuffCfg,
    KillBuffStat,
} from '../excel_table/Tb_KillBuffConfig';
export type {
    ShopDrawCfg,
} from '../excel_table/Tb_ShopDrawConfig';

// ============ 肉鸽 / 局内商店（每个功能一个类，规则与流程分开） ============
//
// 分层：UI（面板/item，只渲染与上报）→ 功能类（本层，只管流程与状态）→ 规则/系统（下方）
//   · RelicShop   肉鸽商店：抽什么（遗物 + 技能混合池）/ 花多少 / 能不能选 / 要不要广告 / 选中后发放
//   · RelicDraw   抽取规则（纯函数；品质权重 / 阶段门槛 / 越阶 / 种类权重 / 技能保底 / 去重 / 费用与广告额度）
//   · SkillSlots  技能槽：4 个格子的技能与等级 / 锁定状态 / 新技能落槽规则 / 冷却投影
//   · HeroSelect  选英雄：候选池 / 刷新（金币或广告）/ 选中 → 回调宿主创建英雄
//   · BuffShop    击杀商店 Buff：摊位抽取 / 价格与层数 / 购买 → 属性当场生效
//   · RelicSystem 遗物背包 + 属性（BattleEquipSystem，一件遗物 = 一组永久 Modifier）

export { RelicShop } from './RelicShop';
export type { RelicShopDeps, ShopSlotVM, RelicShopVM } from './RelicShop';
export { RelicDraw } from './RelicDraw';
export type { ShopOption, ShopOptionKind } from './RelicDraw';
export { evaluateRefreshGate, refreshButtonKey } from './RefreshGate';
export type { RefreshGate } from './RefreshGate';
export {
    SkillSlots,
    SKILL_SLOT_COUNT,
    HERO_SLOT_INDEX,
} from './SkillSlots';
export type { SkillSlotState, SkillGrantResult, SkillSlotsDeps, SkillOwner, SkillSlotsVM } from './SkillSlots';
export { describeAbility, describeBasics, describeEffects, describeEffectsAtLevel } from './AbilityDesc';
export { HeroSelect } from './HeroSelect';
export type { HeroSelectDeps, HeroSelectVM } from './HeroSelect';
export { BuffShop } from './BuffShop';
export type { BuffShopDeps, BuffShopVM } from './BuffShop';
export { ShopConfig, SHOP_RARITY_ORDER, SHOP_RELIC_ID_MIN, SHOP_RELIC_ID_MAX, SHOP_SKILL_ID_MIN, SHOP_SKILL_ID_MAX } from '../data/configs/ShopConfig';
export type { ShopRarity } from '../data/configs/ShopConfig';
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
