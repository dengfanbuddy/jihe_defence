import { Modifier } from './Modifier';
import { DamageType } from './types';
import type { BattleContext } from './BattleContext';

/**
 * Modifier_EagleEye —— 火枪「鹰眼瞄准」的命中叠层脚本（modifiers.json 20/21）
 *
 * 挂载在英雄自身（施放技能时 apply_modifier 到 self）：
 *  - 鹰眼期间英雄每次攻击命中（on_attack_landed）→ 对自身重放本 Modifier。
 *    同 (id, origin) 重放走 stack_mode=stack 的叠层逻辑：层数 +1 并刷新时长，
 *    达到 def.max_stack 后系统自动不再续时（窗口按最后满层时刻 + 持续时长自然结束）。
 *  - 携带 kv.finisher=true（四阶技能施加）时：本 Modifier 自然到期（OnDestroy）
 *    会对攻击范围内存活 Boss（rewardType='boss' 或 ai.type='boss'）追加一次
 *    200% 攻击力的物理伤害（设计：四阶"结束时对 Boss 追加一次 200% 伤害"）。
 *
 * 注册（与 Ability_LightningChain 同一入口，见 Scene_Game_Stage.initBattle）：
 *   ctx.scriptRegistry.registerClass('Modifier_EagleEye', Modifier_EagleEye);
 *
 * 数值全部在配表（modifiers.json 的 duration/max_stack/properties），此处只写行为。
 */
export class Modifier_EagleEye extends Modifier {
    /** 每帧不做事（叠层/终结都由事件与生命周期驱动） */
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;

        const attacker = event?.attacker as any;
        if (!attacker || attacker !== this.target) return false;

        const host = this.target as any;
        if (!host?.modifiers || host.IsDead?.()) return false;

        // 命中即续时：用创建时的持续时长（技能 effect 的 duration 覆盖值）重放同源 Modifier
        host.modifiers.AddModifier(this.def.id, this.source, this.duration, this.getKV(), this.origin);
        return false;
    }

    /** 到期/被移除时调用（此处只做四阶 Boss 终结，其它档无 finisher 标记直接返回） */
    OnDestroy(): void {
        const kv = this.getKV();
        if (!kv || !kv.finisher) return;

        const owner = (this.source ?? this.target) as any;
        if (!owner || !owner.alive || owner.IsDead?.()) return;
        const ctx: BattleContext | undefined = owner.ctxRef;
        if (!ctx) return;

        const atk = owner.getAttackDamage?.() ?? 0;
        if (atk <= 0) return;
        const range = owner.getAttackRange?.() ?? 0;
        const me = owner.position ?? { x: 0, y: 0 };

        // Boss 判定对齐 units.json：rewardType='boss'（关底）或 ai.type='boss'（Boss 模式）
        let boss: any = null;
        let best = Infinity;
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!e || e.IsDead?.()) continue;
            const def = ctx.getUnitDef?.(e.id);
            const isBoss = def?.rewardType === 'boss' || def?.ai?.type === 'boss';
            if (!isBoss) continue;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            const d = dx * dx + dy * dy;
            if (d <= range * range && d < best) {
                best = d;
                boss = e;
            }
        }

        if (boss) {
            ctx.damagePipeline.ApplyDamage(boss, owner, atk * 2, DamageType.Physical);
        }
    }
}

/**
 * Modifier_CounterStorm —— 斧王「反击风暴」被动（modifiers.json 24）
 * 被敌人攻击命中累计 need 次后，对「自身攻击距离 × radiusFactor」范围内的所有敌人
 * 各造成一次当前攻击力物理伤害（反击），随后计数清零重新累计。
 * need / radiusFactor 由被动技能（ability 17）effect 的 kv 注入，默认 5 / 0.5。
 */
export class Modifier_CounterStorm extends Modifier {
    private counter = 0;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_take_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        const src = event?.source as any;
        if (!src || src.team !== 2) return false;
        const dmg = event?.finalDamage ?? event?.damage ?? 0;
        if (dmg <= 0) return false;

        const kv = this.getKV();
        const need = Number(kv?.need ?? 5);
        this.counter += 1;
        if (this.counter < need) return false;
        this.counter = 0;
        this.counterStrike(host);
        return false;
    }

    /** 触发反击：对 1/2 攻击距离内所有敌人各造成一次攻击力伤害 */
    private counterStrike(host: any): void {
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!host.alive || host.IsDead?.() || !ctx) return;
        const atk = host.getAttackDamage?.() ?? 0;
        if (atk <= 0) return;
        const kv = this.getKV();
        const radiusFactor = Number(kv?.radiusFactor ?? 0.5);
        const radius = (host.getAttackRange?.() ?? 0) * radiusFactor;
        const me = host.position ?? { x: 0, y: 0 };
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!e || e.IsDead?.()) continue;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            if (dx * dx + dy * dy <= radius * radius) {
                ctx.damagePipeline.ApplyDamage(e, host, atk, DamageType.Physical);
            }
        }
    }
}

/** 宙斯闪电链的弹射索敌半径（像素） */
const ZEUS_BOUNCE_RANGE = 260;

/**
 * Modifier_ZeusThunder —— 宙斯「雷霆之核」被动（modifiers.json 26）
 * 攻击命中主目标后：
 *   1) 追加一次「目标当前生命 × pct」的魔法雷伤（随当前血量递减）；
 *   2) 向主目标附近至多 chain 个敌人链式弹射，各造成 攻击 × decay 的魔法雷伤；
 * 四阶（kv.autoT>0）时：每 autoT 秒对攻击范围内随机敌人造成 攻击 × autoPct 雷击。
 * chain / pct / autoT / autoPct 由雷霆之核四档被动（ability 19~22）effect 的 kv 注入。
 * modifier 采用 strongest_only：升阶时旧实例会被整体替换为新档位 kv。
 */
export class Modifier_ZeusThunder extends Modifier {
    private autoTimer = 0;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !host.alive || host.IsDead?.()) return false;
        const kv = this.getKV() ?? {};

        const atk = host.getAttackDamage?.() ?? 0;
        const mainTarget = event?.target as any;

        // 1) 被动百分比：追加「当前生命 × pct」雷伤
        const pct = Number(kv.pct ?? 0.035);
        if (mainTarget && !mainTarget.IsDead?.() && pct > 0) {
            const extra = Math.max(1, Math.round((mainTarget.hp ?? 0) * pct));
            if (extra > 0) ctx.damagePipeline.ApplyDamage(mainTarget, host, extra, DamageType.Magical);
        }

        // 2) 链式弹射：主目标附近至多 chain 个敌人，各吃 攻击×decay 雷伤
        const chainN = Number(kv.chain ?? 0);
        const decay = Number(kv.decay ?? 0.6);
        if (chainN > 0 && atk > 0 && mainTarget && !mainTarget.IsDead?.()) {
            const picks: any[] = [];
            for (const e of ctx.GetTeamEntities(2) ?? []) {
                if (!e || e.IsDead?.() || e === mainTarget) continue;
                const dx = e.position.x - mainTarget.position.x;
                const dy = e.position.y - mainTarget.position.y;
                if (dx * dx + dy * dy <= ZEUS_BOUNCE_RANGE * ZEUS_BOUNCE_RANGE) picks.push(e);
                if (picks.length >= chainN) break;
            }
            for (const e of picks) {
                ctx.damagePipeline.ApplyDamage(e, host, Math.round(atk * decay), DamageType.Magical);
            }
        }
        return false;
    }

    /** 四阶：周期性自动对随机敌人落雷 */
    OnTick(dt: number): void {
        const host = this.target as any;
        const kv = this.getKV() ?? {};
        const autoT = Number(kv.autoT ?? 0);
        if (autoT <= 0 || !host || !host.alive || host.IsDead?.()) return;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx) return;

        this.autoTimer += dt;
        if (this.autoTimer < autoT) return;
        this.autoTimer = 0;

        const atk = host.getAttackDamage?.() ?? 0;
        const autoPct = Number(kv.autoPct ?? 1.5);
        if (atk <= 0) return;
        const range = host.getAttackRange?.() ?? 0;
        const me = host.position ?? { x: 0, y: 0 };
        const inRange = (ctx.GetTeamEntities(2) ?? []).filter((e: any) => {
            if (!e || e.IsDead?.()) return false;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            return dx * dx + dy * dy <= range * range;
        });
        if (inRange.length === 0) return;
        const pick = inRange[Math.floor(Math.random() * inRange.length)];
        ctx.damagePipeline.ApplyDamage(pick, host, Math.round(atk * autoPct), DamageType.Magical);
    }
}
