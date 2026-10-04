import { DamageType, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { Projectile } from './Projectile';
import { pickTargets } from './Targeting';
import type { ConfigAction } from '../excel_table/Tb_AbilityConfig';
import type { BattleContext } from './BattleContext';
import type { Entity } from './Entity';

/**
 * ============================================================
 * EffectExecutor —— 效果执行器（独立系统）
 * ============================================================
 * 职责：执行配置化动作（Action DSL）。所有"效果"（伤害/治疗/
 * Buff 施加/偷钱/吸血/反弹...）统一从这里走，保证经过伤害管线
 * 与事件系统。
 *
 * 为什么独立（解耦说明）：
 *   - 技能施放、Modifier 事件、遗物挂载……任何系统产生效果都
 *     调用 EffectExecutor，而不是互相调用
 *   - ModifierSystem 只负责 Modifier 生命周期，不再承担执行职责
 *   - 新增 Action 类型只需扩展本类（开闭原则）
 *
 * 依赖注入：全部通过 BattleContext 获取（DamagePipeline /
 * ScriptRegistry / schedule），自身无状态，可复用/可测试。
 * ============================================================
 */

/** 动作执行上下文 */
export interface ActionContext {
    /** 动作执行者（伤害来源 / 施法者 / Modifier 施加者） */
    actor: any;
    /** 目标（技能目标 / 事件目标，可空 = 默认作用于 actor） */
    target?: any;
    /** 目标点（point/aoe 技能） */
    point?: { x: number; y: number };
    /** 触发事件（Modifier 事件回调时携带，供吸血/反弹取数） */
    event?: any;
    /** 触发动作的 Modifier（Modifier 事件回调时携带） */
    self?: any;
    /**
     * 来源组标识：本动作产生的效果归属的授予条目（如 'ability:6' / 'relic:1' / 'buff:12'）。
     * 主要被 apply_modifier 消费：同 (id, origin) 合并，跨 origin 各持独立实例。缺省 = 空分组。
     */
    origin?: string;
}

export class EffectExecutor {
    private ctx: BattleContext;

    constructor(ctx: BattleContext) {
        this.ctx = ctx;
    }

    /**
     * 执行一个配置化动作
     * @param action Action DSL
     * @param context 执行上下文（actor/target/point/event/self）
     */
    execute(action: ConfigAction, context: ActionContext): void {
        const { actor, target, point, event, self, origin } = context;
        const ctx = this.ctx;

        switch (action.type) {
            case 'damage': {
                if (this.rollChance(action.chance)) break;
                const tgt = target ?? actor;
                if (!tgt) break;
                if (action.projectile_speed) {
                    // 弹道伤害：发射投射物，飞行到达后才结算（两阶段）
                    ctx.spawnProjectile(new Projectile({
                        source: actor,
                        target: tgt,
                        speed: action.projectile_speed,
                        damage: action.value,
                        damageType: action.damage_type ?? DamageType.Magical,
                        ctx,
                    }));
                } else {
                    // 即时伤害
                    ctx.damagePipeline.ApplyDamage(tgt, actor, action.value,
                        action.damage_type ?? DamageType.Magical);
                }
                break;
            }
            case 'aoe_damage': {
                const center = target ?? actor;
                const radius = action.radius;
                for (const e of ctx.findEntitiesInRadius(center, radius)) {
                    ctx.damagePipeline.ApplyDamage(e, actor, action.value,
                        action.damage_type ?? DamageType.Magical);
                }
                break;
            }
            case 'projectile': {
                // 多目标弹道：按策略选 N 个敌人，各发射一枚弹道，命中后执行 hit_effects
                const radius = action.radius ?? Infinity;
                const candidates = ctx.GetAllEntities().filter((e: any) =>
                    e !== actor && e.team !== actor.team && !e.IsDead?.() &&
                    (radius === Infinity || Math.hypot(
                        (e.position?.x ?? 0) - (actor.position?.x ?? 0),
                        (e.position?.y ?? 0) - (actor.position?.y ?? 0),
                    ) <= radius),
                );
                const targets = pickTargets(action.targeting, candidates, actor.position, action.target_count ?? 1);
                for (const t of targets) {
                    ctx.spawnProjectile(new Projectile({
                        source: actor,
                        target: t,
                        speed: action.speed,
                        damage: action.value ?? 0,
                        damageType: action.damage_type ?? DamageType.Magical,
                        hitEffects: action.hit_effects,
                        ctx,
                    }));
                }
                break;
            }
            case 'heal': {
                if (this.rollChance(action.chance)) break;
                const tgt = target ?? actor;
                tgt?.Heal?.(action.value, actor);
                break;
            }
            case 'apply_modifier': {
                if (this.rollChance(action.chance)) break;
                const tgt = target ?? actor;
                // kv：模板效果的幅度参数（如减速 { slow: -150 }），透传给 Modifier 的 OnCreated/var 绑定
                if (tgt?.modifiers) tgt.modifiers.AddModifier(action.modifier, actor, action.duration, action.kv, origin);
                break;
            }
            case 'remove_modifier': {
                const tgt = target ?? actor;
                if (tgt?.modifiers) tgt.modifiers.RemoveModifierById(action.modifier);
                break;
            }
            case 'lifesteal': {
                // 依赖事件中的最终伤害：攻击者吸血
                const dmg = this.eventDamage(event);
                if (dmg > 0) {
                    const gainer = event?.attacker ?? actor;
                    gainer.Heal?.(dmg * action.ratio, actor);
                }
                break;
            }
            case 'reflect': {
                // 反弹给事件中的攻击者；反射/连锁伤害不再二次反射（防无限循环）
                if (event?.reflected) break;
                const attacker = event?.attacker ?? event?.source;
                if (attacker) {
                    const dmg = this.eventDamage(event);
                    ctx.damagePipeline.ApplyDamage(attacker, actor, dmg * action.ratio, DamageType.Physical, {
                        isReflected: true,
                    });
                }
                break;
            }
            case 'steal_gold': {
                // 偷取目标金币：事件发起者获得，target 失去（上限=目标剩余）
                const gainer = event?.attacker ?? actor;
                const tgt = target;
                if (!tgt || !gainer) break;
                const actual = Math.min(tgt.gold ?? 0, action.value);
                tgt.gold = (tgt.gold ?? 0) - actual;
                gainer.gold = (gainer.gold ?? 0) + actual;
                break;
            }
            case 'modify_attr': {
                // 属性修改统一转成「属性修改」共享模板 Modifier（见 MODIFY_ATTR_TEMPLATE_ID）：
                // 走 ModifierSystem 的**贡献**通道（不是 addBase），percent/add 语义与肉鸽遗物完全一致，
                // 并自动获得叠层/刷新/按 origin 隔离/驱散能力。
                // @param duration 缺省 = 永久（-1）
                const tgt = target ?? actor;
                if (!tgt?.modifiers) break;
                const dur = action.duration ?? -1;
                const apply = () => tgt.modifiers.AddModifier(
                    MODIFY_ATTR_TEMPLATE_ID, actor, dur,
                    { attrs: action.attrs }, origin,
                );
                /**
                 * **永久**上限变化走「满血带血」口径 —— 与遗物（`BattleEquip.Apply`）、
                 * 击杀商店 Buff（`BuffShop.applyStack`）走的是同一条路。
                 *
                 * 为什么必须包（2026-10 补）：不包的话「恶魔契约 -40% 最大生命」会把上限压下去
                 * 而当前生命不动，满血买完就是 `hp > maxHp` 的脏数据（实测 320/192）。
                 * 临时上限（`duration >= 0`）**刻意不包** —— 到期时上限回落而当前生命不回落，
                 * 仍然要靠 `Entity.ClampHpToMax`，那是 `ModifierSystem` 侧的既有缺口。
                 */
                if (dur < 0 && typeof tgt.ApplyWithMaxHpCarry === 'function') {
                    tgt.ApplyWithMaxHpCarry(apply);
                } else {
                    apply();
                }
                break;
            }
            case 'execute_script': {
                const fn = ctx.scriptRegistry.getAction(action.script_id);
                if (fn) fn(actor, self, action);
                else console.warn(`[EffectExecutor] script action 未注册: ${action.script_id}`);
                break;
            }
            default: {
                const _exhaustive: never = action;
                console.warn(`[EffectExecutor] 未知动作类型`, _exhaustive);
            }
        }
    }

    /** 概率判定：chance 为 undefined 时必中 */
    private rollChance(chance?: number): boolean {
        return chance !== undefined && Math.random() > chance;
    }

    /**
     * 从事件中提取最终伤害。
     * 兼容两种字段命名：伤害管线发的是 finalDamage，普攻命中发的是 damage。
     */
    private eventDamage(event: any): number {
        return event?.finalDamage ?? event?.damage ?? 0;
    }
}

/** 便捷导出（供外部引用类型） */
export type { ConfigAction, Entity };
