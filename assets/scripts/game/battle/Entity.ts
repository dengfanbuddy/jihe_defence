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
import { UnitKind, getUnitScale, resolveUnitKind } from '../common/EntityVisualConfig';
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

    /**
     * 强制索敌目标（嘲讽）——非空时**压过一切常规索敌**（按策略重新挑 / 粘性锁定）。
     *
     * 与「粘性锁定」的关系：常规规则是"锁住一个目标直到它死亡才换"，
     * 嘲讽是唯一的例外——被嘲讽时立刻改打嘲讽者，嘲讽结束后再按常规规则重新锁。
     *
     * 消费方（都是本字段的读取者，不自己发明第二套规则）：
     *   - 英雄普攻：Scene_Game_Stage.resolveAttackTarget
     *   - 怪物 AI：MonsterAI.findTarget（斧王战吼"强制敌人攻击自己"就走这里）
     * 写入方：嘲讽类效果调用 SetForcedTarget；目标死亡/被回收/倒计时到点自动解除。
     */
    forcedTarget: Entity | null = null;
    /** 强制索敌剩余时间（秒）；<= 0 = 不限期（直到目标失效或显式清除） */
    private forcedTargetRemain = 0;

    /** 自定义数据槽（可挂任意业务数据） */
    readonly custom: Record<string, any> = {};

    /** 视图引用（Cocos 层绑定，可为空） */
    view: any = null;

    /** AI 脚本（怪物/Boss 行为，由 Entity.Tick 驱动；英雄可留空由场景层 AI 控制） */
    ai: MonsterAI | null = null;

    /** 世界坐标（Cocos 层设置；纯逻辑可忽略） */
    position: { x: number; y: number } = { x: 0, y: 0 };

    /** 碰撞半径（像素，已乘表现缩放）——用于实体间分离/防重叠 */
    collisionRadius = BattleConstUtil.getCollisionRadiusDefault();
    /** 配置里的基础碰撞半径（像素，未乘缩放）；表现类别切换时据此重算 collisionRadius */
    baseCollisionRadius = BattleConstUtil.getCollisionRadiusDefault();
    /**
     * 单位表现类别（英雄/普通/精英/各类 Boss）——决定配色、节点缩放与碰撞半径倍率。
     * 表现层（EntityView）读它取颜色/缩放；逻辑层（entity 分离）读它算半径，
     * 两者共用 game/common/EntityVisualConfig 同一份 scale，因此"推开的距离"与体型一致。
     */
    unitKind: UnitKind = UnitKind.Normal;
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
     * @param kind 表现类别（可选）：缺省由配置解析；阶段/最终 Boss 等"同一配置不同身份"由刷新方显式传入
     */
    Reinit(def: { name?: string; team?: number; base_attributes?: AttributeArray; hp?: number; mana?: number;
                  move_speed?: number; attack_damage?: number; attack_speed?: number; armor?: number; magic_resist?: number;
                  attack_range?: number; gold?: number; attack_interval?: number; attack_projectile?: string;
                  attack_projectile_speed?: number; abilities?: number[]; ai?: any;
                  collision_radius?: number; category?: string; subtype?: string; rewardType?: string }, kind?: UnitKind): void {
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
        // 碰撞半径：可配置覆盖，否则用常量默认值（存"基础值"，实际半径 = 基础值 × 表现缩放）
        this.baseCollisionRadius = def.collision_radius !== undefined
            ? def.collision_radius
            : BattleConstUtil.getCollisionRadiusDefault();
        // 表现类别 → 同步碰撞半径倍率（表现层节点缩放读同一份表，保证推距与体型一致）
        this.SetUnitKind(kind ?? resolveUnitKind(def));
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
        this.baseCollisionRadius = BattleConstUtil.getCollisionRadiusDefault();
        this.collisionRadius = BattleConstUtil.getCollisionRadiusDefault();
        this.unitKind = UnitKind.Normal;
        this.immovable = false;
        this.view = null;
        this.ClearForcedTarget();
        for (const k of Object.keys(this.custom)) delete this.custom[k];
        // 注意：不清 _viewRecycled —— 异步视图回调需要它判断放弃；
        // 复位放在 Reinit（下次复用）时
        this.modifiers.Clear();
        this.abilities.Clear();
        this.status.Clear();
        this.ai = null;
    }

    // ============ 表现类别 / 体型 ============

    /**
     * 设置表现类别（英雄/普通/精英/各类 Boss），并同步碰撞半径 = 基础半径 × 该类别缩放。
     *
     * 为什么半径要跟缩放走：实体分离（BattleContext.separateEntities）的判定是
     * `minDist = e.collisionRadius + other.collisionRadius`，两只单位被推开的距离就是 minDist。
     * 若半径不乘缩放，2 倍大的最终 Boss 会与普通怪"视觉重叠"却判定为不重叠；
     * 乘了之后，屏幕上看到的间距 == 逻辑上的推距。
     *
     * 表现层（EntityView.bind → HitFlash.apply）用同一份 scale 设置节点缩放。
     */
    SetUnitKind(kind: UnitKind): void {
        this.unitKind = kind;
        this.collisionRadius = this.baseCollisionRadius * getUnitScale(kind);
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

    /**
     * 施加「会改变最大生命」的效果（遗物 / 击杀商店 Buff / 升级…），并按**满血口径**结算当前生命：
     *   · 施放前是**满血** → 上限涨多少，当前生命也涨多少（ΔmaxHp），加完仍然是满血
     *   · 施放前**不是满血** → 只抬上限，当前生命不动（保留原有的缺口）
     *
     * 为什么需要它：属性加成的写入是「贡献 → 下次读取时重算」，`hp` 是独立字段、不会跟着涨，
     * 于是"满血买 +生命遗物"会凭空出现一道缺口（1000/1000 → 1000/1140），看起来像没加上。
     *
     * ⚠ 只给**永久**的上限变化用（遗物 / 击杀 Buff 的 `duration = -1` 条目）。
     *   临时上限（技能 buff 到期会掉回来）**不要**走这个口 —— 到期后上限回落而当前生命不回落，
     *   会出现 `hp > maxHp` 的脏数据（HUD 显示 1200/1000），要等到下次 `ChangeHp` 才被钳回。
     *
     * @param fn 真正写入上限变化的动作（内部一般是一段 `AddModifier` / `addBase`）
     * @returns `fn` 的返回值
     *
     * @example
     * ```ts
     * // 遗物：一组永久 Modifier，其中可能含最大生命
     * owner.ApplyWithMaxHpCarry(() => {
     *     for (const e of entries) owner.modifiers.AddModifier(e.modifier, owner, e.duration ?? -1, e.kv, origin);
     * });
     * ```
     */
    ApplyWithMaxHpCarry<T>(fn: () => T): T {
        const beforeMax = this.getMaxHp();
        const wasFull = this.hp >= beforeMax;
        const result = fn();
        const afterMax = this.getMaxHp();
        // 满血才补：非满血刻意不补（否则"残血买血"等于白送一次治疗）
        if (wasFull && afterMax > beforeMax) {
            this.hp = Math.min(afterMax, this.hp + (afterMax - beforeMax));
        } else if (afterMax < beforeMax) {
            // 上限**下降**（如「恶魔契约」-40% 最大生命）→ 当前生命必须跟着钳回，
            // 否则留下 `hp > maxHp` 的脏数据（实测满血买 130 三级后是 320/192，
            // HUD 会显示成"超过上限"，且要等到下一次 ChangeHp 才被钳回）。
            this.ClampHpToMax();
        }
        return result;
    }

    /**
     * 把当前生命钳到最大生命以内（上限下降后的收尾）。
     *
     * ⚠ 单独抽出来是因为它有三个必须调用的时机，漏一个就出 `hp > maxHp`：
     *   ① 永久上限下降（`ApplyWithMaxHpCarry` 的 else 分支）；
     *   ② **技能被顶掉时**（`Ability.removeOwnModifiers`）—— 例：挂着「强健 +22% 生命」
     *      满血，换成「迅捷」后上限回落，当前生命不钳就会 1.22B / B；
     *   ③ 临时上限**到期**（Modifier 自然结束）—— **目前没接**，见 `ApplyWithMaxHpCarry`
     *      的警告：那条要动 `ModifierSystem`（拿到"上限变了"的时机），属既有缺口。
     */
    ClampHpToMax(): void {
        const max = this.getMaxHp();
        if (this.hp > max) this.hp = max;
    }

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

    // ============ 强制索敌（嘲讽） ============

    /**
     * 设置强制索敌目标（嘲讽）
     * @param target 被强制攻击的目标（null = 等价于 ClearForcedTarget）
     * @param duration 持续秒数；<= 0 = 一直有效（直到目标死亡/被回收或显式清除）
     *
     * 用法（嘲讽类效果）：
     *   enemies.forEach(e => e.SetForcedTarget(this.hero, 2)); // 斧王战吼：2 秒内强制打自己
     */
    SetForcedTarget(target: Entity | null, duration = 0): void {
        this.forcedTarget = target;
        this.forcedTargetRemain = duration;
    }

    /** 解除强制索敌（嘲讽结束 / 目标失效） */
    ClearForcedTarget(): void {
        this.forcedTarget = null;
        this.forcedTargetRemain = 0;
    }

    /** 当前是否处于被嘲讽状态（存在有效的强制目标） */
    hasForcedTarget(): boolean {
        return !!this.forcedTarget && !this.forcedTarget.IsDead();
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
        if (evasion > 0 && Math.random() < evasion) {
            /**
             * 闪避事件（2026-10 补）。
             *
             * 为什么必须补这一处：闪避原本**什么都不发**，于是所有「闪避之后……」的技能
             * （127 闪避反击）都不可达；而格挡（`on_block_damage`，见 `DamagePipeline` 第 3 阶段）
             * 与闪避用的是同一条 `on_projectile_miss` 总线事件、`reason` 都是
             * `'evaded_or_blocked'`，**分不清是谁**。
             *
             * 派发对象是**闪避者**（`target`）—— 与 `on_take_damage` 派发给受击者同口径，
             * 挂在英雄身上的「闪避反击」才能收到（攻击者在 `event.attacker`）。
             */
            const evadeEvent = { attacker: this, target, dodger: target };
            this.ctx.bus.publish(BattleEvents.OnEvade, evadeEvent);
            target.modifiers?.DispatchEvent('on_evade', evadeEvent);
            return 0;
        }

        const finalDamage = this.ctx.damagePipeline.ApplyDamage(target, this, damage, damageType, { ability });

        /**
         * 普攻命中回复（2026-10 遗物重做新增属性 25/26/27）。
         *
         * 口径（三处一起定死，改口径只改这里）：
         *   · **只对普攻生效** —— `ability` 为空才是普攻；技能伤害（含技能弹道）不吃吸血。
         *     （近战即时命中与远程弹道命中都收敛到本方法，所以这里是唯一消费点。）
         *   · 25 吸血 = 本次结算后的**实际伤害** × 吸血比例（0.09 = 9%）；
         *   · 26 攻击回复 / 27 攻击回蓝 = **固定值**，不吃暴击倍率、不按伤害缩放；
         *   · 被闪避 / 完全格挡（`finalDamage <= 0`）时不给回复，避免"打空气也回血"。
         */
        if (finalDamage > 0 && !ability) {
            const lifesteal = this.attrs?.get(AttributeType.Lifesteal) ?? 0;
            const hitHeal = this.attrs?.get(AttributeType.HitHeal) ?? 0;
            const heal = finalDamage * lifesteal + hitHeal;
            if (heal > 0) this.Heal(heal, this);
            const hitMana = this.attrs?.get(AttributeType.HitMana) ?? 0;
            if (hitMana > 0) this.mana = Math.min(this.getMaxMana(), this.mana + hitMana);
        }

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
        // 强制索敌（嘲讽）倒计时：目标已死/已回收，或时间到 → 自动解除，回到常规索敌
        if (this.forcedTarget) {
            if (this.forcedTarget.IsDead() || this.ctx.IsRecycled(this.forcedTarget)) {
                this.ClearForcedTarget();
            } else if (this.forcedTargetRemain > 0) {
                this.forcedTargetRemain -= dt;
                if (this.forcedTargetRemain <= 0) this.ClearForcedTarget();
            }
        }
        this.modifiers.Tick(dt);
        this.abilities.Tick(dt);
        // AI 脚本驱动（移动/攻击行为）
        this.ai?.update(dt);
    }

    /** 获得属性（供配置动作使用） */
    AddBaseAttribute(id: number, value: number): void {
        this.attrs.addBase(id, value);
    }

    // ============ 位移（击退 / 牵引） ============

    /**
     * 把本单位沿「来源 → 自己」的方向推开一段距离（**击退**）。
     *
     * 口径（写在这里一次，别的系统不要再各算一份方向）：
     *   · **方向** = 从 `source.position` 指向 `position` 的单位向量（即"远离来源"），
     *     所以调用方只需传"谁推的"，不必自己算角度；两点重合（距离 < 1e-3，没有可用方向）时不位移。
     *   · **锚点不位移**：`immovable` 的实体（英雄/防守点）直接返回 0 —— 与实体分离
     *     （BattleContext.separateEntities）同一口径："只推别人，不被别人推动"。
     *   · **瞬时位移**：只改 `position`，不产生速度、不带状态（不眩晕/不定身）。怪物 AI 下一帧
     *     照常朝目标走回来，所以击退的战术价值 = "把它推回去的那段赶路时间"（按现配的怪移速算：
     *     50px ÷ 100~180px/s ≈ 0.3~0.5 秒的推进延迟）。想连控制一起给，另加 `apply_state`（眩晕/定身）。
     *   · **表现层不用通知**：`EntityView.update` 每帧按脏检查同步 `entity.position`，跳变会直接
     *     在下一帧渲染出来（逻辑驱动移动的既有约定）。
     *   · 不做落点合法性检查（不挡边界/不防重叠）：战斗场地没有实体墙，推出去的距离由调用方给，
     *     重叠由每帧的 `separateEntities` 收尾。
     *
     * @param source 推力来源（一般是攻击者），取其 `position` 作起点
     * @param distance 位移距离（**像素**；配表里的"米"由调用方 × `BattleConstUtil.getPxPerMeter()`）
     * @returns 实际位移距离（未位移返回 0）
     *
     * @example
     * ```ts
     * // 火枪「爆头冲击」：15% 概率击退 1m
     * target.ApplyKnockback(attacker, 1 * BattleConstUtil.getPxPerMeter());
     * ```
     */
    ApplyKnockback(source: { position?: { x: number; y: number } } | null | undefined, distance: number): number {
        if (!(distance > 0) || this.IsDead() || this.immovable) return 0;
        const from = source?.position;
        if (!from) return 0;
        const dx = this.position.x - from.x;
        const dy = this.position.y - from.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-3) return 0;
        this.position.x += (dx / len) * distance;
        this.position.y += (dy / len) * distance;
        return distance;
    }
}

/** Modifier 常量（实体内部引用；对应 modifiers.json 中的 id） */
export namespace Entity {
    export const ModShuriken = 16; // mod_shuriken 在 modifiers.json 中的编号
}
