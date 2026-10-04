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

/** 属性叠加方式 —— 借鉴 Dota 2 的四种叠加规则，外加本项目新增的「百分比」 */
export enum AttributeStackMode {
    Add = 'add',            // 加法叠加（固定值）：final = base + Σ v
    Percent = 'percent',    // 百分比叠加：final = base × (1 + Σ v)。同类加法叠加、只对基础值乘算一次；
                            // 与 Multiply 的区别：Multiply 是 Π(1+v)（多来源复利），Percent 是 1+Σv（多来源相加）
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
    /**
     * 闪避成功（2026-10 新增，**会派发给 Modifier**）。
     *
     * 在此之前「闪避」是**完全静默**的：`Entity.resolveAttackHit` 里
     * `if (evasion > 0 && Math.random() < evasion) return 0;` 直接返回，
     * 近战连总线事件都没有；远程虽然会经 `Projectile` 发 `on_projectile_miss`，
     * 但那只发总线、且 `reason` 只有一个 `'evaded_or_blocked'`（分不清闪避还是格挡）。
     * 现在补齐了，并且与「格挡」（`on_block_damage`）彻底分开。
     *
     * 载荷：`{ attacker, target, dodger }`（`target` === `dodger` === 闪避者）。
     */
    OnEvade: 'on_evade',
    /** 局内金币变化（脚本加金后必须发它，场景层据此把 hero.gold 投影到 HUD） */
    OnGoldGained: 'on_gold_gained',
    /**
     * 局内经验入账（2026-10 遗物重做新增）。
     *
     * 为什么需要：遗物钩子「领悟（killExpFlat）」要按击杀额外发经验，而局内经验的唯一入口是
     * `Scene_Game_Stage.addBattleExp`（私有，且要处理升级/成长/HUD 投影）—— 战斗层不能直接调。
     * 所以由脚本 `publish({ target, amount, source })`，场景层订阅后折算成局内经验。
     */
    OnExpGained: 'on_exp_gained',
    /**
     * 阶段切换（2026-10 遗物重做新增）。
     *
     * 为什么需要：遗物钩子「阶段契约（phaseBuff）」的语义是「每进入新阶段叠一层」，
     * 而阶段切换的唯一决策点是 `Scene_Game_Stage.checkStage` —— 原先那里只投影 store，没有事件。
     * 场景层在**阶段号真的变了**之后 publish（载荷 `{ from, to }`），钩子自行订阅。
     */
    OnPhaseChanged: 'on_phase_changed',
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

/**
 * 「属性修改」共享 Modifier 模板 id（modifiers.json 中 id = 1000 的那一条）
 *
 * 该模板的效果只有一条 `{ type:'modify_attr', attrs_var:'attrs' }`：
 * **属性类型、数值、叠加方式全部由施加方传入**（kv.attrs = [[属性id, 值, 叠加方式], ...]）。
 *
 * 用途 —— 所有「纯属性加成」共用这一条，不再为每个数值组合单独生成 Modifier：
 *   · 肉鸽遗物/道具：`relics.modifiers: [{ modifier: 1000, kv: { attrs: [...] } }]`
 *   · 技能临时改属性：`EffectExecutor` 的 `modify_attr` 动作也转成它
 * 好处：percent/add 语义只有一处实现，叠层/刷新/驱散/按 origin 隔离全部复用 ModifierSystem；
 * 实例身份 = (模板 id, origin)，遗物间互不干扰（origin = `relic:<遗物id>`）。
 */
export const MODIFY_ATTR_TEMPLATE_ID = 1000;
