import { AttributeSystem } from './AttributeSystem';
import { ModifierSystem } from './ModifierSystem';
import { StatusSystem } from './StatusSystem';
import { AbilitySystem } from './AbilitySystem';
import { Projectile } from './Projectile';
import { AIRegistry } from './ai/AIRegistry';
import { BattleEvents, DamageType } from './types';
import { AttributeType } from './core/Types';
import type { AttributeArray } from './core/Types';
import { BattleConstUtil } from './core/BattleConstUtil';
import type { MonsterAI } from './ai/MonsterAI';
import type { BattleContext } from './BattleContext';

/**
 * 实体 —— 战斗中所有可交互对象（英雄/怪物/召唤物）的统一抽象
 * 组合：属性 + Modifier + 状态 + 技能
 */
export class Entity {
    /** 单位配置 id（同类型怪物共享，如 monster_goblin=4） */
    readonly id: number;
    /** 实例唯一 id（对象池复用后仍唯一，用于实体表 key / 弹道命中判断） */
    readonly uid: number;
    name: string;
    team: number;

    attrs: AttributeSystem;
    modifiers: ModifierSystem;
    status: StatusSystem;
    abilities: AbilitySystem;

    /** 当前生命/魔法（与属性系统联动：max_hp / max_mana） */
    hp = 0;
    mana = 0;
    alive = true;

    /** 金币（供偷钱等经济玩法；可从 UnitCfg 初始化） */
    gold = 0;

    /** 普攻基础间隔（秒）；实际冷却 = base / attack_speed */
    attackBaseInterval = 1.7;
    /** 普攻投射物标识（远程攻击表现，如 'shuriken'）；mod_shuriken 存在时也会触发 */
    attackProjectile?: string;
    /** 普攻弹道速度（像素/秒，默认 1200） */
    attackProjectileSpeed = 1200;
    /** 普攻冷却计时器（= 普攻间隔） */
    private attackTimer = 0;

    /** 自定义数据槽（可挂任意业务数据） */
    readonly custom: Record<string, any> = {};

    /** 视图引用（Cocos 层绑定，可为空） */
    view: any = null;

    /** AI 脚本（怪物/Boss 行为，由 Entity.Tick 驱动；英雄可留空由场景层 AI 控制） */
    ai: MonsterAI | null = null;

    /** 世界坐标（Cocos 层设置；纯逻辑可忽略） */
    position: { x: number; y: number } = { x: 0, y: 0 };

    /** 碰撞半径（像素）——用于实体间分离/防重叠；默认取战斗常量 collisionRadiusDefault */
    collisionRadius = BattleConstUtil.getCollisionRadiusDefault();
    /** 是否作为锚点（英雄/防守点）——实体分离时不被推开，只承担推开别人 */
    immovable = false;

    private ctx: BattleContext;

    constructor(id: number, uid: number, name: string, team: number, ctx: BattleContext, initialBaseAttrs?: AttributeArray) {
        this.id = id;
        this.uid = uid;
        this.name = name;
        this.team = team;
        this.ctx = ctx;

        this.attrs = new AttributeSystem(ctx.attributeContainer, initialBaseAttrs);
        this.modifiers = new ModifierSystem(this, ctx, ctx.modifierContainer);
        this.status = new StatusSystem(this.modifiers, ctx.bus);
        this.abilities = new AbilitySystem(this, ctx, ctx.abilityContainer);

        // 初始生命/魔法取属性系统当前值
        this.hp = this.attrs.get(AttributeType.MaxHp);
        this.mana = this.attrs.get(AttributeType.MaxMana);
    }

    get ctxRef(): BattleContext { return this.ctx; }

    // ============ 对象池支持 ============

    /**
     * 按 UnitCfg 重新初始化（对象池复用前调用，等价于重新创建）
     * 覆盖基础属性/技能/AI，重置运行状态。
     */
    Reinit(def: { name?: string; team?: number; base_attributes?: AttributeArray; hp?: number; mana?: number;
                  move_speed?: number; attack_damage?: number; attack_speed?: number; armor?: number; magic_resist?: number;
                  attack_range?: number; gold?: number; attack_interval?: number; attack_projectile?: string;
                  attack_projectile_speed?: number; abilities?: number[]; ai?: any;
                  collision_radius?: number }): void {
        // 清空上一轮运行状态
        this.ResetForPool();
        // 复位视图层回收标记（下次 acquire 时 ViewPool 可正常创建视图）
        delete (this as any)._viewRecycled;
        delete (this as any)._recycled;

        if (def.name !== undefined) this.name = def.name;
        if (def.team !== undefined) this.team = def.team;

        // 基础属性唯一来源：base_attributes 二维数组 [[attrId, 配置int]]
        // 缩放的倍率/百分比属性由 AttributeSystem 内部换算为 float
        for (const [attrId, value] of def.base_attributes ?? []) {
            this.attrs.setBase(attrId, value);
        }

        // 当前生命/魔法取属性系统值（hp/mana 不再单独配置，由 MaxHp/MaxMana 属性推导）
        this.hp = this.getMaxHp();
        this.mana = this.getMaxMana();
        this.gold = def.gold ?? 0;
        // 非属性行为参数（不在 base_attributes 中）
        // 碰撞半径：可配置覆盖，否则用常量默认值
        this.collisionRadius = def.collision_radius !== undefined
            ? def.collision_radius
            : BattleConstUtil.getCollisionRadiusDefault();
        if (def.attack_interval !== undefined) this.attackBaseInterval = def.attack_interval;
        if (def.attack_projectile) this.attackProjectile = def.attack_projectile;
        if (def.attack_projectile_speed !== undefined) this.attackProjectileSpeed = def.attack_projectile_speed;

        // 技能
        this.abilities.Clear();
        for (const abilityId of def.abilities ?? []) {
            this.abilities.AddAbility(abilityId);
        }
        // AI
        this.ai = AIRegistry.create(def.ai ?? null, this, this.ctx);
    }

    /** 清空运行状态（对象池回收时调用；保留构造时创建的子系统对象） */
    ResetForPool(): void {
        this.alive = true;
        this.hp = 0;
        this.mana = 0;
        this.gold = 0;
        this.attackTimer = 0;
        this.attackBaseInterval = 1.7;
        this.attackProjectile = undefined;
        this.attackProjectileSpeed = 1200;
        this.position = { x: 0, y: 0 };
        this.collisionRadius = BattleConstUtil.getCollisionRadiusDefault();
        this.immovable = false;
        this.view = null;
        for (const k of Object.keys(this.custom)) delete this.custom[k];
        // 注意：不清 _viewRecycled —— 异步视图回调需要它判断放弃；
        // 复位放在 Reinit（下次复用）时
        this.modifiers.Clear();
        this.abilities.Clear();
        this.status.Clear();
        this.ai = null;
    }

    // ============ 属性快捷 ============

    getMaxHp(): number { return this.attrs.get(AttributeType.MaxHp); }
    getMaxMana(): number { return this.attrs.get(AttributeType.MaxMana); }
    getMoveSpeed(): number { return this.attrs.get(AttributeType.MoveSpeed); }
    getAttackDamage(): number { return this.attrs.get(AttributeType.Atk); }
    getArmor(): number { return this.attrs.get(AttributeType.Def); }
    getMagicResist(): number { return this.attrs.get(AttributeType.MagicResist); }
    getAttackRange(): number { return this.attrs.get(AttributeType.AtkRange); }

    /** 普攻冷却（秒） = 基础间隔 / 攻速倍率。攻速越快，普攻（飞镖）冷却越短 */
    getAttackInterval(): number {
        const speed = Math.max(0.1, this.attrs.get(AttributeType.AtkSpeed));
        return this.attackBaseInterval / speed;
    }

    /** 是否处于普攻冷却中 */
    isAttackOnCooldown(): boolean { return this.attackTimer > 0; }

    /** 本次普攻是否表现为投射物（远程飞镖） */
    isProjectileAttack(): boolean {
        return !!this.attackProjectile || this.modifiers.has(Entity.ModShuriken);
    }

    // ============ 生命/魔法管理 ============

    /** 改变生命（负数为受伤，正数为治疗）。死亡判定由管线负责。 */
    ChangeHp(delta: number, source?: any): void {
        this.hp = Math.max(0, Math.min(this.getMaxHp(), this.hp + delta));
        if (this.hp <= 0) this.alive = false;
        if (delta > 0) {
            this.ctx.bus.publish(BattleEvents.OnHeal, { target: this, source, amount: delta });
        }
    }

    /** 治疗 */
    Heal(amount: number, source?: any): number {
        const before = this.hp;
        this.ChangeHp(Math.max(0, amount), source);
        return this.hp - before;
    }

    /** 直接恢复满 */
    FullHeal(): void {
        this.ChangeHp(this.getMaxHp() - this.hp);
    }

    /** 是否死亡 */
    IsDead(): boolean { return !this.alive || this.hp <= 0; }

    /** 死亡处理（可覆写，默认清理所有 Modifier） */
    Die(_killer?: any): void {
        if (!this.alive) return;
        this.alive = false;
        this.hp = 0;
        this.modifiers.Clear();
    }

    /** 复活 */
    Respawn(): void {
        this.alive = true;
        this.hp = this.getMaxHp();
        this.mana = this.getMaxMana();
    }

    // ============ 战斗行为 ============

    /** 普通攻击（两阶段：发射弹道 or 即时命中）。冷却 = 普攻间隔（由攻速决定） */
    Attack(target: any): number {
        if (this.attackTimer > 0) return 0; // 普攻冷却中
        if (!this.status.canAttack()) return 0;
        if (!target || target.IsDead()) return 0;

        // 进入攻击动作，开始冷却（普攻冷却 = 飞镖冷却）
        this.attackTimer = this.getAttackInterval();

        const dmg = this.getAttackDamage();
        this.ctx.bus.publish(BattleEvents.OnAttackStart, { attacker: this, target, damage: dmg });
        const consumed = this.modifiers.DispatchEvent('on_attack_start', { attacker: this, target, damage: dmg });
        if (consumed) return 0;

        // 飞镖普攻：发布投射物事件（表现层据此播放飞镖弹道/粒子）
        if (this.isProjectileAttack()) {
            this.ctx.bus.publish(BattleEvents.OnAttackProjectile, {
                attacker: this,
                target,
                damage: dmg,
                damageType: DamageType.Physical,
                projectile: this.attackProjectile ?? 'shuriken',
            });
        }

        // 普攻技能（behavior=attack）：伤害由技能 effects 决定（可配弹道）
        const attackAbility = this.abilities.getAttackAbility();
        if (attackAbility) {
            return attackAbility.OnAttack(target);
        }

        // 默认普攻：远程 → 发射弹道（延迟结算）；近战 → 即时命中
        if (this.attackProjectile) {
            this.launchProjectile(target, dmg, DamageType.Physical, true);
            return 0;
        }
        return this.resolveAttackHit(target, dmg, DamageType.Physical, undefined);
    }

    /**
     * 命中结算（攻击阶段共用）：闪避判定 → 伤害管线 → 攻击命中事件（特效在此触发）
     * 弹道命中时也走这里，保证"飞镖飞到时才触发吸血/偷钱/点燃"
     */
    resolveAttackHit(target: any, damage: number, damageType: DamageType, ability?: any): number {
        if (!target || target.IsDead?.()) return 0;
        // 命中判定：闪避（弹道模式下在到达时才算）
        const evasion = target.attrs?.get(AttributeType.Evasion) ?? 0;
        if (evasion > 0 && Math.random() < evasion) return 0;

        const finalDamage = this.ctx.damagePipeline.ApplyDamage(target, this, damage, damageType, { ability });

        const landedEvent = { attacker: this, target, damage: finalDamage, damageType };
        this.ctx.bus.publish(BattleEvents.OnAttackLanded, landedEvent);
        this.modifiers.DispatchEvent('on_attack_landed', { ...landedEvent, _attacker: this, _target: target });
        return finalDamage;
    }

    /** 发射普攻弹道（命中时由 Projectile 调用 resolveAttackHit） */
    launchProjectile(target: any, damage: number, damageType: DamageType, isAttack: boolean, ability?: any): Projectile {
        const projectile = new Projectile({
            source: this,
            target,
            speed: this.attackProjectileSpeed,
            damage,
            damageType,
            isAttack,
            ability,
            ctx: this.ctx,
        });
        this.ctx.spawnProjectile(projectile);
        return projectile;
    }

    /** 每帧更新 */
    Tick(dt: number): void {
        if (!this.alive) return;
        // 生命/魔法自然恢复（属性驱动）
        const hpRegen = this.attrs.get(AttributeType.HpRegen);
        const manaRegen = this.attrs.get(AttributeType.ManaRegen);
        if (hpRegen > 0 && this.hp < this.getMaxHp()) this.ChangeHp(hpRegen * dt);
        if (manaRegen > 0 && this.mana < this.getMaxMana()) {
            this.mana = Math.min(this.getMaxMana(), this.mana + manaRegen * dt);
        }
        // 普攻冷却恢复
        if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);
        this.modifiers.Tick(dt);
        this.abilities.Tick(dt);
        // AI 脚本驱动（移动/攻击行为）
        this.ai?.update(dt);
    }

    /** 获得属性（供配置动作使用） */
    AddBaseAttribute(id: number, value: number): void {
        this.attrs.addBase(id, value);
    }
}

/** Modifier 常量（实体内部引用；对应 modifiers.json 中的 id） */
export namespace Entity {
    export const ModShuriken = 16; // mod_shuriken 在 modifiers.json 中的编号
}
