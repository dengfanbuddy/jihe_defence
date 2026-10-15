import { DamageType, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { Projectile } from './Projectile';
import { pickTargets } from './Targeting';
import { HitShapeKind } from '../common/HitFeelConfig';
import { publishSkillShape } from './SkillShape';
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
        /**
         * 段数账本（`battle/DamageMeter.ts`，**只读诊断**）：**声明式动作是本执行器唯一的入口**，
         * 所以"这一段伤害是哪条动作打出来的"只能在这里压标签 ——
         * 归属 = `动作:damage@ability:1` / `脚本:boss_cast@boss:2011` / `动作:aoe_damage`（无来源组）。
         * 用 `try/finally` 出栈：动作里抛异常也不能让标签栈错位（诊断代码不许污染战斗）。
         */
        const meter = this.ctx.meter;
        meter.pushTag(tagOfAction(action, context?.origin));
        try {
            this.executeInner(action, context);
        } finally {
            meter.popTag();
        }
    }

    /** 动作的实际执行体（`execute` 只负责压/弹来源标签） */
    private executeInner(action: ConfigAction, context: ActionContext): void {
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
                /**
                 * ⚠ **必须按"施法者的敌对队伍"筛人**：`findEntitiesInRadius` 的第三个参数是
                 * `teamFilter`（只留 `e.team === teamFilter`）；**不传 = 谁都打** —— 包括施法者自己
                 * 与友军。2026-11 与 `BossSkills.bossCast` 的同一处坑一起收口（那边曾把
                 * 「自己 + 身边小怪」当成目标）。`actor.team` 缺失时保持旧行为（不筛）。
                 */
                const ownTeam = actor?.team;
                const enemyTeam = ownTeam === 1 ? 2 : (ownTeam === 2 ? 1 : undefined);
                const hits = ctx.findEntitiesInRadius(center, radius, enemyTeam);
                /**
                 * **先上报形态、再结算伤害**（设计文档 §13.4 的"路 B"）。
                 *
                 * 为什么声明式的 AoE 也必须上报：这类技能的结算**一个 `OnAttackLanded` 锚点都没有**
                 * （它是"技能自己"造成的伤害，不是"某次普攻引发的"），而表现层的几何推断
                 * 完全依赖那个锚点 ⇒ 以前这一发爆炸在屏幕上**什么都不画**。
                 * 上报之后，表现层直接拿到"圆心 + 真实半径"，画出来的扩散环就是作用范围本身。
                 *
                 * ⚠ 顺序有意为之：上报用的是**结算前**的圆心快照（实体随时可能被这次伤害打死并回收，
                 *   之后再读 `center.position` 就是 (0,0)）。
                 */
                publishSkillShape(ctx, {
                    shape: HitShapeKind.Blast,
                    source: actor,
                    target: center,
                    cx: center?.position?.x ?? 0,
                    cy: center?.position?.y ?? 0,
                    radius,
                });
                for (const e of hits) {
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
                /**
                 * ⚠ **第四个参数（`context`）是 2026-11 补的，且必须留着**：
                 * 脚本动作原先只拿得到 `(actor, self, action)`，**看不到这次动作的目标**
                 * （`target` / `point` 都在 `ActionContext` 里）—— 于是"朝技能目标发射一枚
                 * 攻击力加成的火球"这种脚本只能自己重新索敌一次，索到的目标可能已经变了。
                 * 老脚本忽略第四个参数即可，签名向后兼容。
                 */
                if (fn) fn(actor, self, action, context);
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

/**
 * 动作的来源标签（**段数账本**用，见 `battle/DamageMeter.ts`）：`动作:类型@来源组`。
 *
 * 为什么要带 `origin`：同一条 `damage` 动作可能来自技能（`ability:1`）、遗物（`relic:1030`）、
 * 神器（`killbuff:16`）或掉落道具（`item:…`）—— 只有带上来源组，报告里才分得清"谁打的"。
 * `execute_script` 带 `script_id`（如 `boss_cast`），因为脚本自己怎么打伤害只有它知道。
 */
function tagOfAction(action: ConfigAction, origin?: string): string {
    const raw = action as any;
    const head = raw?.script_id ? `脚本:${raw.script_id}` : `动作:${raw?.type ?? 'unknown'}`;
    return origin ? `${head}@${origin}` : head;
}
