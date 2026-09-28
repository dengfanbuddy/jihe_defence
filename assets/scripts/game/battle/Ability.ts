import { BattleEvents, DamageType, StateType } from './types';
import type { AbilityCfg, ConfigAction } from '../excel_table/Tb_AbilityConfig';
import type { BattleContext } from './BattleContext';

/**
 * 技能 —— 借鉴 Dota 2 的 Ability 设计
 *
 * 两种形态：
 *   1. 配置驱动：由 AbilityCfg（Excel→JSON）创建，effects 列表驱动行为
 *   2. 代码驱动：子类覆写 OnCast / 注册 script_id，实现复杂逻辑（逃逸口）
 *
 * 施放流程：检查（冷却/蓝量/状态）→ 扣蓝 → 前摇 → 执行效果 → 发布事件 → 进冷却
 */
export class Ability {
    readonly def: AbilityCfg;
    caster: any;
    cooldownRemaining = 0;

    constructor(def: AbilityCfg, caster: any) {
        this.def = def;
        this.caster = caster;
    }

    getId(): number { return this.def.id; }
    isPassive(): boolean { return this.def.behavior === 'passive'; }
    /** 普攻形态标记（不算技能：普攻由 Entity.Attack 属性驱动；本标记用于把遗留普攻条目排除出技能枚举/自动升级） */
    isAttack(): boolean { return this.def.behavior === 'attack'; }
    /** 是否自动施放型主动技能（AI 可触发，区别于 passive 被动 / attack 普攻） */
    isAutoCastable(): boolean {
        return !this.isPassive() && !this.isAttack();
    }

    /**
     * 来源组标识：本技能（条目级）产生的效果统一打该 origin（如 'ability:6'）。
     * 同 (id, origin) 按 stack_mode 合并；与遗物/商店 buff 等其它来源同 id 时各持独立实例。
     */
    get originKey(): string { return `ability:${this.def.id}`; }

    /** 冷却中？ */
    isOnCooldown(): boolean { return this.cooldownRemaining > 0; }
    getCooldownRemaining(): number { return this.cooldownRemaining; }

    /** 是否满足施放条件 */
    canCast(): boolean {
        if (this.isPassive() || this.isAttack()) return false;
        if (this.isOnCooldown()) return false;
        const status = this.caster.status;
        if (!status.canCast()) return false;
        if (this.def.mana_cost > 0 && this.caster.mana < this.def.mana_cost) return false;
        return true;
    }

    /**
     * 施放技能
     * @param target 目标实体（unit_target）
     * @param point 目标点（point/aoe）
     * @returns 是否成功施放
     */
    Cast(target?: any, point?: { x: number; y: number }): boolean {
        if (!this.canCast()) return false;
        const caster = this.caster;

        // 扣蓝
        if (this.def.mana_cost > 0) caster.mana -= this.def.mana_cost;

        // 施法前摇（可在此挂动画；简化：立即执行）
        if (this.def.cast_point && this.def.cast_point > 0) {
            // 实际项目中在此播放施法动画，cast_point 秒后回调 OnCast
        }

        this.OnCast(target, point);

        // 进入冷却
        this.cooldownRemaining = this.def.cooldown;
        this.ctx.bus.publish(BattleEvents.OnAbilityCast, {
            caster, abilityId: this.def.id, target, point,
        });
        return true;
    }

    /** 技能效果执行入口（可覆写） */
    OnCast(target?: any, point?: { x: number; y: number }): void {
        const effects = this.resolveEffects(target, point);
        for (const action of effects) {
            // 效果统一经 EffectExecutor 执行（解耦：技能不直接调用任何系统）
            this.ctx.effects.execute(action, { actor: this.caster, target, point, origin: this.originKey });
        }
    }

    /**
     * 被动技能：挂载永久效果（由 AbilitySystem 在添加时自动调用）
     * 借鉴 Dota 2：被动技能无需施放，天生生效
     */
    ApplyPassive(): void {
        if (!this.isPassive()) return;
        for (const action of this.def.effects) {
            this.ctx.effects.execute(action, { actor: this.caster, target: this.caster, origin: this.originKey });
        }
    }

    /** 解析每级成长数值（level_damage 支持） */
    protected resolveEffects(_target?: any, _point?: any): ConfigAction[] {
        const effects = this.def.effects.map((e) => ({ ...e }));
        // 若配置了等级伤害，将 damage.value 替换为当前等级数值
        if (this.def.level_damage && this.def.level_damage.length > 0) {
            const lv = this.def.level ?? 1;
            const dmg = this.def.level_damage[Math.min(lv - 1, this.def.level_damage.length - 1)];
            for (const e of effects) {
                if (e.type === 'damage') e.value = dmg;
                if (e.type === 'aoe_damage') e.value = dmg;
            }
        }
        return effects;
    }

    /** 每帧更新冷却 */
    Tick(dt: number): void {
        if (this.cooldownRemaining > 0) {
            this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
        }
    }

    protected get ctx(): BattleContext { return this.caster.ctx; }
}

/** 便捷导出 */
export { DamageType, StateType };
