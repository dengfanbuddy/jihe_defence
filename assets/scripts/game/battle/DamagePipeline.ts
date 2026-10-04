import { BattleEvents, DamageType, StateType } from './types';
import { AttributeType } from './core/Types';
import type { BattleContext } from './BattleContext';
import { Entity } from './Entity';

/**
 * 伤害管线 —— 借鉴 Dota 2 的分层结算（Bracket）设计
 *
 * 结算顺序：
 *   1. 攻击者增伤（所有 Modifier 的 damage_out 加成，乘法叠加）
 *   2. 暴击（优者生效：取最高倍率，PRD 概率可选）
 *   3. 目标护盾/格挡（Modifier 事件拦截，可吞掉伤害）
 *   4. 目标受伤增减（受伤减免 12，**全能减免**：物理与法术都减）
 *   5. 护甲/魔抗减免
 *   6. 扣血（先扣血，事件监听者才能看到扣血后的 HP 与真实死亡状态）
 *   7. 发布事件 → 吸血/反伤/荆棘 等 Modifier 响应
 *   8. 检查死亡
 */
export class DamagePipeline {
    private ctx: BattleContext;

    /** 递归深度保险丝：防止反射/连锁伤害无限循环（实例级，避免跨战斗污染） */
    private depth = 0;
    private static readonly MAX_DEPTH = 10;

    constructor(ctx: BattleContext) {
        this.ctx = ctx;
    }

    /**
     * 对目标造成伤害
     * @returns 最终实际伤害
     */
    ApplyDamage(
        target: any,
        source: any,
        rawDamage: number,
        damageType: DamageType,
        options?: {
            ability?: any;
            isCrit?: boolean;
            critMultiplier?: number;
            damageFlags?: number;
            /** 反射/连锁伤害标记：带此标记的伤害不会再触发反射（防无限循环） */
            isReflected?: boolean;
        },
    ): number {
        // 深度保护：超过阈值直接丢弃（反射链断裂）
        if (++this.depth > DamagePipeline.MAX_DEPTH) {
            this.depth--;
            return 0;
        }
        try {
            return this.applyDamageInner(target, source, rawDamage, damageType, options);
        } finally {
            this.depth--;
        }
    }

    private applyDamageInner(
        target: Entity,
        source: any,
        rawDamage: number,
        damageType: DamageType,
        options?: {
            ability?: any;
            isCrit?: boolean;
            critMultiplier?: number;
            damageFlags?: number;
            isReflected?: boolean;
        },
    ): number {
        if (!target || target.IsDead?.()) return 0;
        if (rawDamage <= 0) return 0;

        // 无敌/虚灵检查
        if (target.status.get(StateType.Invulnerable)) return 0;
        if (damageType === DamageType.Physical && target.status.get(StateType.Ethereal)) return 0;
        if (damageType !== DamageType.Physical && target.status.get(StateType.MagicImmune)) return 0;

        // ---- Phase 1: 攻击者增伤 ----
        let damage = rawDamage;
        const sourceMods = source?.modifiers;
        if (sourceMods) {
            // 收集所有 damage_out 贡献（可扩展为属性系统统一处理）
            const outMult = this.collectOutgoingMultiplier(source);
            damage *= outMult;
        }

        // ---- Phase 2: 暴击 ----
        let isCrit = options?.isCrit ?? false;
        let critMult = options?.critMultiplier ?? 1;
        if (!isCrit) {
            const crit = this.rollCrit(source);
            if (crit) {
                isCrit = true;
                critMult = crit;
            }
        }
        if (isCrit) damage *= critMult;

        // ---- Phase 3: 护盾/格挡（目标 Modifier 拦截）----
        const shieldEvent = {
            target, source, damage, damageType,
            blocked: 0,
        };
        // 事件名：on_block_damage —— Modifier 可覆写 OnBattleEvent 返回 consumed
        target.modifiers?.DispatchEvent('on_block_damage', shieldEvent);
        damage -= shieldEvent.blocked;
        if (damage <= 0) return 0;

        // ---- Phase 4: 目标受伤增减 ----
        damage *= this.collectIncomingMultiplier(target, damageType);

        // ---- Phase 5: 抗性减免 ----
        damage = this.applyResistance(target, damage, damageType);

        const finalDamage = Math.max(0, damage);

        // ---- Phase 6: 先扣血（事件监听者才能看到扣血后的 HP 与真实死亡状态）----
        target.ChangeHp(-finalDamage, source);

        // ---- Phase 7: 事件广播（吸血/反伤/荆棘/受击后效）----
        const dmgEvent = {
            source, target, rawDamage, finalDamage, damageType, isCrit,
            ability: options?.ability,
            _attacker: source,
            /** 反射/连锁标记：反射 modifier 看到此标记不再二次反射 */
            reflected: options?.isReflected ?? false,
        };
        this.ctx.bus.publish(BattleEvents.OnTakeDamage, dmgEvent);
        target.modifiers?.DispatchEvent('on_take_damage', dmgEvent);
        this.ctx.bus.publish(BattleEvents.OnDealDamage, dmgEvent);
        source?.modifiers?.DispatchEvent('on_deal_damage', dmgEvent);

        // ---- Phase 8: 死亡检查 ----
        if (target.IsDead()) {
            target.Die(source);
            this.ctx.bus.publish(BattleEvents.OnDeath, { entity: target, killer: source });
            if (source) this.ctx.bus.publish(BattleEvents.OnKill, { killer: source, victim: target });
        }

        return finalDamage;
    }

    // ---- 内部辅助 ----

    /** 攻击者增伤倍率（所有来源乘法叠加，如 1.2 × 1.3） */
    private collectOutgoingMultiplier(source: any): number {
        // 优先走属性系统（推荐）：攻击者定义 damage_out 属性
        if (source.attrs?.has(AttributeType.DamageOut)) return source.attrs.get(AttributeType.DamageOut);
        return 1;
    }

    /**
     * 目标受伤增减
     *
     * 2026-10 口径：**受伤减免是"全能减免"** —— 物理与法术都减，只有一条属性
     * `AttributeType.IncomingDamage(12)`（原 12 物理受伤 / 13 魔法受伤 已合并，13 退役）。
     * 所以这里不再按 `damageType` 分支：物理、法术、纯粹伤害都吃这一条。
     */
    private collectIncomingMultiplier(target: any, _damageType: DamageType): number {
        if (target.attrs?.has(AttributeType.IncomingDamage)) return target.attrs.get(AttributeType.IncomingDamage);
        return 1;
    }

    /** 抗性减免 */
    private applyResistance(target: any, damage: number, damageType: DamageType): number {
        if (damageType === DamageType.Pure) return damage;
        if (damageType === DamageType.Physical) {
            const armor = target.attrs?.get(AttributeType.Def) ?? 0;
            // Dota 2 护甲双曲公式
            const multiplier = 1 - (0.06 * armor) / (1 + 0.06 * Math.abs(armor));
            return damage * multiplier;
        }
        // Magical
        const resist = target.attrs?.get(AttributeType.MagicResist) ?? 0.25;
        return damage * (1 - resist);
    }

    /** 暴击：从 Modifier 收集最优暴击（优者生效） */
    private rollCrit(source: any): number | null {
        if (!source?.modifiers) return null;
        // 通过属性系统走最干净：source 定义 crit_chance / crit_multiplier
        if (source.attrs?.has(AttributeType.CritRate)) {
            const chance = source.attrs.get(AttributeType.CritRate);
            const mult = source.attrs.get(AttributeType.CritDmg);
            if (chance > 0 && mult > 1 && Math.random() < chance) return mult;
        }
        return null;
    }
}
