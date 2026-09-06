/**
 * 核心基础类型定义
 * 借鉴 Dota 2 战斗系统：伤害类型 / 状态类型 / 叠加方式 / 事件
 */

/** 伤害类型（借鉴 Dota 2 的 物理/魔法/纯粹 三分类） */
export enum DamageType {
    Physical = 'physical', // 受护甲减免
    Magical = 'magical',   // 受魔法抗性减免
    Pure = 'pure',         // 无视减免
}

/** 状态效果（State）—— 借鉴 Dota 2 的 Modifier State 系统 */
export enum StateType {
    Stunned = 'stunned',        // 眩晕：不能移动/攻击/施法/用道具
    Rooted = 'rooted',          // 定身：不能移动，可攻击施法
    Silenced = 'silenced',      // 沉默：不能施放技能
    Muted = 'muted',            // 缄默：不能使用主动道具
    Disarmed = 'disarmed',      // 缴械：不能普通攻击
    Hexed = 'hexed',            // 妖术：沉默+缄默+缴械
    Invulnerable = 'invulnerable', // 无敌
    MagicImmune = 'magic_immune',  // 法术免疫
    BreakPassives = 'break_passives', // 破被动
    Ethereal = 'ethereal',      // 虚灵：不能普攻，受魔法伤害增加
    Untargetable = 'untargetable', // 不可选中
}

/** 属性叠加方式 —— 借鉴 Dota 2 的四种叠加规则 */
export enum AttributeStackMode {
    Add = 'add',            // 加法叠加：final = base + Σ v
    Multiply = 'multiply',  // 乘法叠加：final = base × Π(1 + v)
    Complement = 'complement', // 补数乘法：final = 1 - (1-base) × Π(1 - v)  (用于魔抗/闪避等)
    Best = 'best',          // 优者生效：final = max(base, v...)
}

/** Modifier 叠加方式（同名 Modifier 重复施加时的行为） */
export enum ModifierStackMode {
    None = 'none',      // 不叠加：新实例替换旧实例（不刷新时长）
    Refresh = 'refresh',// 刷新：重置持续时间，不增加层数
    Stack = 'stack',    // 叠加层数：层数 +1，刷新时长，属性按层数×基础值
    Renew = 'renew',    // 并存：创建独立新实例，互不影响
}

/** 驱散等级 */
export enum DispelLevel {
    None = 0,
    Basic = 1,   // 普通驱散
    Strong = 2,  // 强驱散
    Ultimate = 3,// 极强驱散
}

/** 战斗事件名（EventBus 键） */
export const BattleEvents = {
    OnAttackStart: 'on_attack_start',
    OnAttackLanded: 'on_attack_landed',
    OnTakeDamage: 'on_take_damage',
    OnDealDamage: 'on_deal_damage',
    OnDeath: 'on_death',
    OnAbilityCast: 'on_ability_cast',
    OnHeal: 'on_heal',
    OnModifierAdded: 'on_modifier_added',
    OnModifierRemoved: 'on_modifier_removed',
    OnModifierRefreshed: 'on_modifier_refreshed',
    OnStateChanged: 'on_state_changed',
    OnRelicAdded: 'on_relic_added',
    OnRelicRemoved: 'on_relic_removed',
    OnKill: 'on_kill',
    OnBattleStart: 'on_battle_start',
    /** 普攻投射物（远程攻击/飞镖表现） */
    OnAttackProjectile: 'on_attack_projectile',
    /** 弹道命中目标 */
    OnProjectileHit: 'on_projectile_hit',
    /** 弹道落空（目标中途死亡/无敌/闪避） */
    OnProjectileMiss: 'on_projectile_miss',
    /** 实体加入战斗上下文（进入 spatialMap/实体表） */
    OnEntityAdded: 'on_entity_added',
    /** 实体移出战斗上下文（回收/移除） */
    OnEntityRemoved: 'on_entity_removed',
} as const;

/** ---- 事件数据结构 ---- */

export interface AttackEventData {
    attacker: unknown; // Entity
    target: unknown;
    damage: number;
    damageType: DamageType;
}

export interface DamageEventData {
    source: unknown;
    target: unknown;
    rawDamage: number;
    finalDamage: number;
    damageType: DamageType;
    isCrit: boolean;
}

export interface DeathEventData {
    entity: unknown;
    killer?: unknown;
}

export interface AbilityCastEventData {
    caster: unknown;
    abilityId: string;
    target?: unknown;
    point?: { x: number; y: number };
}

export interface ModifierEventData {
    target: unknown;
    modifierId: string;
    source?: unknown;
    stackCount: number;
}

/** 属性修改贡献（Modifier → Attribute 的桥） */
export interface AttributeContribution {
    value: number;
    mode?: AttributeStackMode; // 不填则取属性定义的默认叠加方式
    order: number;             // 计算顺序（同模式下按 order 排序）
}
