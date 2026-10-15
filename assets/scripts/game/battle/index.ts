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
export { BattleMines, resolveMineRuntime, reportMineBlast } from './BattleMines';
export type { MineRecord, BurnField, MineRuntime, MineDeps, MineHero, MineEnemy } from './BattleMines';
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
export type { RelicShopDeps, ShopSlotVM, RelicShopVM, RelicRollInfo } from './RelicShop';
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
//   · ItemBag     局内掉落 Buff 小背包（6 格）：阶段 Boss 掉落 / 满了拒收 / 点击使用 → 限时效果
//                 ⚠ 与 BuffShop（**神器**：永久 + 可叠层 + 花击杀数买刷新）是**两条轨**，
//                   见 docs/artifact-drop/README.md
export { ItemBag } from './ItemBag';
export type { ItemBagDeps, ItemBagVM, DropResult } from './ItemBag';
//   · StatusBar   HUD 状态栏（英雄头像下方那一行）的**采集规则**（纯 TS）：
//                 白名单（配表 `bar_show`）+ 同键合并（共享模板 1000 的 origin）+ 排序。
//                 ⚠ 它**只读**英雄身上的 Modifier 实例，不改任何战斗状态；格子的画法在
//                   `ui/scenes/scene_game_stage/cmps/status_bar/`（见 docs/status-bar/README.md）
export { StatusBar, shortLabel } from './StatusBar';
export type { StatusBarDeps, StatusBarEntry, StatusBarVM } from './StatusBar';
export type { BarState } from './Modifier';
//   · SpecialBuffs **机制型**效果的脚本实现：神器 4 条（天怒 / 波次补给 / 战地急救 / 滚雪球）
//                 + 掉落道具 1 条（血包，唯一的 duration=0 即刻生效）
//                 ⚠ 注册走 `SPECIAL_BUFF_SCRIPT_CLASSES` → Scene_Game_Stage.initBattle
export {
    KillBuff_Skyfall,
    KillBuff_WaveHeal,
    KillBuff_CritHeal,
    KillBuff_Snowball,
    BattleItem_BloodBag,
    SPECIAL_BUFF_SCRIPT_CLASSES,
} from './SpecialBuffs';
export { ShopConfig, SHOP_RARITY_ORDER, SHOP_RELIC_ID_MIN, SHOP_RELIC_ID_MAX, SHOP_SKILL_ID_MIN, SHOP_SKILL_ID_MAX } from '../data/configs/ShopConfig';
export type { ShopRarity } from '../data/configs/ShopConfig';
export { BattleEquip, RelicSystem } from './BattleEquipSystem';
export { Ability_LightningChain } from './ScriptedAbilities';
//   · BossSkills   Boss 技能的**动作脚本**（abilities.json effects[].script_id）：
//                 `boss_fireball`（攻击力加成的弹道）/ `boss_cast`（扇形或圆形的作用域 + debuff）。
//                 注册走 `BOSS_SKILL_ACTIONS` → Scene_Game_Stage.initBattle（`registerAction`，不是 registerClass）
export { bossFireball, bossCast, BOSS_SKILL_ACTIONS } from './BossSkills';
//   · SkillShape   技能形态的**显式上报**（"路 B"）：战斗侧说自己放了什么形状，
//                 表现层据此画爆炸环 / 链折线 / **扇形**，不再只靠落点几何猜
export { publishSkillShape, shapeDirection } from './SkillShape';
export type { SkillShapeReport } from './SkillShape';

// ============ 对象池 ============

export { EntityPool } from './EntityPool';

// ============ 局内统计（一局的完整账本） ============

//   · RunStats    局内成长统计：把一局里「属性加成（按来源拆固定值/百分比）· 遗物 · 神器 ·
//                 掉落 Buff · 技能 · 限时状态 · 金币 · 击杀数 · 经验/等级 · 阶段时间线」
//                 汇总成一份结构化报告，结束时在控制台打一整块、并把 JSON 挂到 window.__runStats。
//                 ⚠ 它**只记账不决策**：只读 attrs / modifiers，其余全靠宿主把既有事件转交进来
//                   （接线点清单见 RunStats.ts 文件头的「落点一览」）。
export { RunStats, ATTR_SOURCE_LABEL, ATTR_SOURCE_ORDER } from './RunStats';
export type {
    AttrSourceKey, AttrBonusBucket, AttrStatRow,
    RunRelicRecord, RunArtifactRecord, RunBattleItemRecord, RunSkillRecord, RunBuffRecord,
    RunRollRecord, RunStageRecord, RunBossRecord, RunKillByUnit, RunEndInfo,
    RunStatsHero, RunStatsModifier, RunStatsReport, RunStatsDeps,
} from './RunStats';

//   · DamageMeter  **伤害段数账本**（只读诊断，与 RunStats 正交）：
//                 回答"一帧里结算了多少段 / 每段是谁打的 / 谁挨得最多 / 有没有递归链"——
//                 RunStats 记的是"一局的成长账"，它记的是"伤害的**结构**"。
//                 单帧段数（或 1 秒滑窗）超阈值会当场 `console.warn`；随时 `__dmgMeterReport()`。
//                 ⚠ 它**不改任何伤害**：只在管线入口/出口数数，来源靠调用方 `withTag` 压栈。
export { DamageMeter } from './DamageMeter';
export type { DamageBucket, DamageTargetBucket } from './DamageMeter';

// ============ 怪物 AI 脚本系统 ============

export { MonsterAI, AIRegistry, ChaseAI, WanderAI, OrbitAI, AttackStopAI, BossAI, initializeAI } from './ai';
export { normalizePhases, normalizeSkills, resolveAbilityRef } from './ai';
export type { BossPhaseSpec, BossSkillSpec } from './ai';

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
