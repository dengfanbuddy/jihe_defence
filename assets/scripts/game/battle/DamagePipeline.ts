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
            /**
             * **回响标记（2026-11 加）**：带此标记的伤害不会再触发任何一份「暴击回响」。
             *
             * 为什么必须靠载荷里的标记、而不是钩子自己那个 `busy` 布尔：一局里可能同时挂着
             * **N 份**同一个回响（19 件遗物的 `modifiers_inner` 都引 `遗物·暴击回响#211`，
             * 用户实测一局拿到 11 件）——`busy` 是**每实例一个**，只挡得住"自己再触发自己"，
             * 挡不住"A 打出的段去触发 B、B 打出的段再触发 C……"，段数于是按
             * `Σ n!/k! ≈ e·n!` 爆炸（实测 N=6 → 1957 段/次暴击、N=11 → 2867 万段/次暴击，
             * 见 `tools/analysis/crit-echo-cascade-check.cjs`）。
             * 与 `isReflected` 是同一个手法（那份注释写着"带此标记的伤害不会再触发反射"）——
             * 这两处是同一类问题：**钩子自己打出的追加段不许再喂回自己的触发器**。
             */
            isEcho?: boolean;
        },
    ): number {
        /**
         * 段数账本（`battle/DamageMeter.ts`，**只读诊断**）：这里是全工程伤害的**唯一入口**，
         * 所以"进管线多少次"只能在这里数；"真正扣血多少段"在第 6 阶段之后数。
         * 两者的差值（免疫/已死/格挡/深度保险丝）同样是证据：调用次数远大于段数时，
         * 说明有东西在**空转刷伤害**（打无敌/打尸体）。
         */
        this.ctx.meter.recordCall();
        // 深度保护：超过阈值直接丢弃（反射链断裂）—— 被它拦下的那一段就是"确实存在递归链"的物证
        if (++this.depth > DamagePipeline.MAX_DEPTH) {
            this.depth--;
            this.ctx.meter.recordDepthGuard();
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
            /** 回响标记（含义见公开入口 `ApplyDamage` 的同名字段） */
            isEcho?: boolean;
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
        // 段数账本：真正落到血条上的那一段（归属 = 当前标签栈栈顶，见 DamageMeter 文件头口径②）
        this.ctx.meter.recordInstance(target, finalDamage, damageType);

        // ---- Phase 7: 事件广播（吸血/反伤/荆棘/受击后效）----
        const dmgEvent = {
            source, target, rawDamage, finalDamage, damageType, isCrit,
            ability: options?.ability,
            _attacker: source,
            /** 反射/连锁标记：反射 modifier 看到此标记不再二次反射 */
            reflected: options?.isReflected ?? false,
            /**
             * 回响标记：**这一段是某个回响钩子打出来的追加段**。
             * `RelicHook_CritEcho` 看到它就拒绝再开一代 —— 否则 N 份回响会互相触发到阶乘级
             * （见 `ApplyDamage` 的 `isEcho` 注释与 `tools/analysis/crit-echo-cascade-check.cjs`）。
             */
            isEcho: options?.isEcho ?? false,
        };
        this.ctx.bus.publish(BattleEvents.OnTakeDamage, dmgEvent);
        /**
         * **受击者自己的表现走直调，不走总线**（2026-11 改，见 `EntityView` 类注释）。
         *
         * 为什么：`EntityView` 原来是**每个实体各订阅一次** `OnTakeDamage`、再各自按 `e.target`
         * 过滤 —— 段数正常时无所谓，但段数一爆（实测 boss 战一帧 4~6.8 万段、同屏几十只怪）
         * 事件数就变成 `段数 × 存活实体数` 的**二次放大**（50 × 5.7 万 = 285 万次回调/帧）。
         * `target.view` 这个反向引用本来就存在（`EntityView.bind` / `Hero.bind` 写它），
         * 所以这里一次空判就能把过滤掉的那 N-1 次调用省掉。
         *
         * ⚠ **放在 `publish` 之后**：监听者（例如场景里"英雄致命伤拦截/复活"那条）可能在这一帧
         *   改动血量，表现层要读到**最终**的 `target.hp`（口径与"先扣血再发事件"一致）。
         * ⚠ 传的是**同一个 `dmgEvent` 对象**，不额外分配。
         */
        target.view?.onTakeDamage?.(dmgEvent);
        target.modifiers?.DispatchEvent('on_take_damage', dmgEvent);
        this.ctx.bus.publish(BattleEvents.OnDealDamage, dmgEvent);
        source?.modifiers?.DispatchEvent('on_deal_damage', dmgEvent);

        // ---- Phase 8: 死亡检查 ----
        if (target.IsDead()) {
            /**
             * 死后坐标快照 —— **必须在 `publish(OnDeath)` 之前取**。
             *
             * 为什么：场景的 `OnDeath` 监听里当场就 `recycleMonster` 回对象池了
             * （`MonsterPool.release` → `EntityPool.release` → `Entity.ResetForPool()`，
             * 那里的 `this.position = { x: 0, y: 0 }` 把坐标清零），而 `OnKill` 是在那之后才发的。
             * ⇒ `OnKill` 的监听者拿到 `victim` 时，它的 `position` **已经是 (0,0)**。
             * 任何"以死者位置为圆心"的效果（范围伤害/掉落/尸体）都只能读这份快照。
             *
             * 这是**踩过的坑**（2026-11）：技能 122「击杀回响」与遗物「死亡回响」都拿 `victim`
             * 当圆心，实际圆心恒为地图原点 —— 范围伤害只在原点附近生效，画面上极难看出。
             * 同族的第三个受害者见 `Scene_Game_Stage` 里"掉落点坐标必须在 recycleMonster 之前取"。
             */
            const deathPos = { x: target.position?.x ?? 0, y: target.position?.y ?? 0 };
            target.Die(source);
            this.ctx.bus.publish(BattleEvents.OnDeath, { entity: target, killer: source, deathPos });
            if (source) this.ctx.bus.publish(BattleEvents.OnKill, { killer: source, victim: target, deathPos });
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
