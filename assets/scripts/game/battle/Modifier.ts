import { AttributeStackMode, DamageType, DispelLevel, StateType } from './types';
import type { ModifierCfg, ModifierEventAction, ModifierPropertyEntry } from '../excel_table/Tb_ModifierConfig';
import type { ConfigAction } from '../excel_table/Tb_AbilityConfig';
/**
 * Modifier —— 借鉴 Dota 2 的核心设计
 *
 * 一个挂载在实体上的"效果容器"，拥有：
 *   - 生命周期：OnCreated → (OnRefresh/OnTick/事件回调) → OnDestroy
 *   - Property 属性修改：声明对哪些属性产生多少贡献
 *   - State 状态控制：眩晕/沉默/无敌等硬状态
 *   - Event 事件回调：响应攻击/受伤/死亡等战斗事件
 *
 * 两种来源：
 *   1. 配置驱动：由 ModifierCfg（Excel→JSON）创建，所有行为由配置描述
 *   2. 代码驱动：子类覆写方法实现复杂逻辑（script_id 逃逸口）
 */
export class Modifier {
    readonly def: ModifierCfg;
    /** 宿主 */
    target: unknown;
    /** 来源（施法者/遗物等，可为空） */
    source?: unknown;
    /** 当前持续时间（秒，-1 永久） */
    duration: number;
    remainingTime: number;
    /** 层数 */
    stackCount = 1;
    /** 是否暂停（时间不流逝） */
    paused = false;
    /** 唯一实例 id */
    readonly instanceId: number;

    /** 周期效果计时器（由 ModifierSystem 驱动） */
    tickTimer = 0;

    private static nextInstanceId = 1;

    /** 创建时传入的 kv 参数 */
    protected kv: Record<string, any> = {};

    constructor(def: ModifierCfg, duration?: number, kv?: Record<string, any>) {
        this.def = def;
        this.duration = duration !== undefined ? duration : def.duration;
        this.remainingTime = this.duration;
        this.instanceId = Modifier.nextInstanceId++;
        if (kv) this.kv = kv;
    }

    // ============ 生命周期 ============

    /** 创建时调用（可覆写） */
    OnCreated(kv?: Record<string, any>): void {
        if (kv) this.kv = { ...this.kv, ...kv };
    }

    /** 同类型刷新时调用（可覆写，常用于重置内部状态） */
    OnRefresh(_kv?: Record<string, any>): void { /* 默认空实现 */ }

    /** 销毁时调用（可覆写，常用于还原副作用） */
    OnDestroy(): void { /* 默认空实现 */ }

    /** 每帧/每 tick 调用（dt 秒） */
    OnTick(_dt: number): void { /* 默认空实现 */ }

    // ============ Property 属性贡献 ============

    /**
     * 返回该 Modifier 对某属性的贡献值（null 表示不贡献该属性）
     * 默认从配置 def.properties 读取（二维数组 [[attrId, value] 或 [attrId, {value, mode}]]）；
     * 子类可覆写实现动态数值。
     */
    GetModifierProperty(attributeId: number): AttributeContributionLike | null {
        const entry = this.getPropertyEntry(attributeId);
        if (entry) {
            return { value: entry.value * this.stackCount, mode: entry.mode };
        }
        return null;
    }

    /** 从配置 properties（二维数组）查找某属性条目 */
    private getPropertyEntry(attributeId: number): ModifierPropertyEntry | null {
        const props = this.def.properties;
        if (!props) return null;
        for (const item of props) {
            if (item[0] === attributeId) {
                const v = item[1];
                if (typeof v === 'number') return { value: v };
                return v;
            }
        }
        return null;
    }

    /** 枚举本 Modifier 影响的所有属性（供 ModifierSystem 汇总） */
    GetAffectedAttributes(): number[] {
        return this.def.properties ? this.def.properties.map((p) => p[0]) : [];
    }

    // ============ State 状态控制 ============

    /** 返回状态施加表（可覆写） */
    CheckState(): Partial<Record<StateType, boolean>> {
        return this.def.states ?? {};
    }

    // ============ 事件回调 ============

    /**
     * 响应战斗事件（如 on_take_damage / on_attack_landed / on_death）
     * 默认执行配置 events 中的动作（经由 EffectExecutor，统一走伤害管线/事件系统）；
     * 子类可覆写实现复杂逻辑。
     * @returns 是否吞掉事件（true 时终止后续 Modifier 处理，用于护盾/格挡等）
     */
    OnBattleEvent(eventName: string, event: any): boolean {
        const binds = this.def.events?.filter((e) => e.event === eventName);
        if (!binds || binds.length === 0) return false;
        for (const bind of binds) {
            for (const action of bind.actions) {
                this.runAction(action, event);
            }
        }
        return false;
    }

    /** 通过 EffectExecutor 执行配置化动作（解耦：Modifier 不直接依赖任何执行逻辑） */
    private runAction(action: ConfigAction, event: any): void {
        const host = this.target as any;
        const ctx = host?.ctxRef;
        if (!ctx?.effects) return;
        ctx.effects.execute(action, {
            actor: this.source ?? host,   // 伤害源：Modifier 施加者或宿主
            target: event?.target ?? host, // 动作目标：事件目标或宿主
            event,
            self: this,
        });
    }

    // ============ 查询辅助 ============

    getId(): number { return this.def.id; }
    isDebuff(): boolean { return this.def.is_debuff; }
    isHidden(): boolean { return this.def.is_hidden ?? false; }
    isPermanent(): boolean { return this.duration < 0 || this.remainingTime < 0; }
    getDispelLevel(): DispelLevel { return this.def.dispel_level; }
    getStackMode() { return this.def.stack_mode; }
    getStackCount(): number { return this.stackCount; }
    setStackCount(n: number): void {
        this.stackCount = n;
        const max = this.def.max_stack;
        if (max !== undefined) this.stackCount = Math.min(max, this.stackCount);
    }
    /** 获取创建时参数 */
    getKV(): Record<string, any> { return this.kv; }
}

/** 属性贡献的运行时形态 */
export interface AttributeContributionLike {
    value: number;
    mode?: AttributeStackMode;
}

/** 便捷导入（供外部引用类型） */
export type { ModifierCfg, ModifierEventAction };
export { DamageType };
