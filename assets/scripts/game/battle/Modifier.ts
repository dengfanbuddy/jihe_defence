import { AttributeStackMode, DamageType, DispelLevel, StateType } from './types';
import type { ModifierCfg, ModifierEventAction } from '../excel_table/Tb_ModifierConfig';
import type { AttrEntry, ModifierEffect, ModifierTickEffect } from '../excel_table/EffectTypes';
import { isTickEffect, resolveAttrEntries } from '../excel_table/EffectTypes';
import type { ConfigAction } from '../excel_table/Tb_AbilityConfig';
/**
 * 归一化「持续时长」（秒）—— 施加方传的时长**只认显式数值**：
 *   `null` / `undefined`（= 表格没填）一律视为「未指定」→ 回落 `ModifierCfg.duration`；
 *   配置也缺省时按**永久**（-1）处理。
 *
 * ⚠ 为什么必须归一化（踩过：遗物加的属性"过一帧就没了"，表现为 UI 刷新时又变回去）：
 *   Excel 空单元格导出成 `null`（`relics.json` 的 `modifiers_inner[].duration` **全是 null**）。
 *   旧写法 `duration !== undefined ? duration : def.duration` 把 null 当成了显式时长 →
 *   `remainingTime = null` → `isPermanent()` 为 false（`null < 0` 不成立）→ 首次 `Tick` 里
 *   `null - dt` 是负数 → 当场判定"已过期"并移除，属性加成/被动一帧后就被抹掉。
 *   `-1` = 永久是唯一口径（见 modifiers.json 的 duration 列），别用 `0` 或 `null` 表达永久。
 */
export function normalizeDuration(def: ModifierCfg | undefined, duration?: number | null): number {
    const d = duration ?? def?.duration;
    return d === undefined || d === null ? -1 : d;
}

/**
 * Modifier —— 借鉴 Dota 2 的核心设计
 *
 * 一个挂载在实体上的"效果容器"，拥有：
 *   - 生命周期：OnCreated → (OnRefresh/OnTick/事件回调) → OnDestroy
 *   - Effects 原子效果：`def.effects` 里一条一件事 —— 属性贡献 / 状态 / 周期伤害…
 *   - Event 事件回调：响应攻击/受伤/死亡等战斗事件
 *
 * **效果原子化**：属性改什么属性、加多少、用哪种叠加方式，全部写在效果里（见 EffectTypes.ts），
 * 不再有 properties / states / tick 三列。需要「一条模板、多种幅度」时用 `var`（单条数值）
 * 或 `attrs_var`（整张属性表由施加方 kv 传入，纯属性加成的共享模板就是这么做的）。
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
    /**
     * 来源组标识：授予该效果的条目（如 'relic:1' / 'ability:6' / 'buff:12'）。
     * 实例身份 = (def.id, origin)：同 (id, origin) 才合并（按 stack_mode 刷新/叠层/覆盖）；
     * 不同 origin 各持独立实例——分别计时、分别失效、属性贡献各自叠加、状态 OR 聚合。
     * 缺省（未标注的旧调用）共享空分组，等价于旧的"实体上按 id 唯一"行为。
     */
    origin?: string;
    /** 当前持续时间（秒，-1 永久） */
    duration: number;
    remainingTime: number;
    /** 层数 */
    stackCount = 1;
    /** 是否暂停（时间不流逝） */
    paused = false;
    /** 唯一实例 id */
    readonly instanceId: number;

    /**
     * 自带冷却剩余时间（秒）。cd 来自配置 def.cd（0 = 无冷却）；
     * **每个 Modifier 实例各持一个**，同一实体上多个带 cd 的效果互不影响。
     */
    cdRemaining = 0;

    /** 周期效果列表（配置静态，构造时解析一次，避免每帧分配） */
    private readonly tickEffectList: ModifierTickEffect[];
    /**
     * 周期效果各自的计时器，与 tickEffectList 一一对应：
     * **每条周期效果各算各的**（如同时有 1 秒 DoT 与 3 秒 HoT 互不干扰）
     */
    private readonly tickTimers: number[] = [];

    private static nextInstanceId = 1;
    /** 无周期效果时的共享空数组（避免每帧分配） */
    private static readonly NO_TICKS: ModifierTickEffect[] = [];

    /** 创建时传入的 kv 参数 */
    protected kv: Record<string, any> = {};

    constructor(def: ModifierCfg, duration?: number | null, kv?: Record<string, any>) {
        this.def = def;
        this.duration = normalizeDuration(def, duration);
        this.remainingTime = this.duration;
        this.instanceId = Modifier.nextInstanceId++;
        if (kv) this.kv = kv;
        this.tickEffectList = (def.effects ?? []).filter(isTickEffect);
    }

    // ============ 生命周期 ============

    /** 创建时调用（可覆写） */
    OnCreated(kv?: Record<string, any>): void {
        if (kv) this.kv = { ...this.kv, ...kv };
    }

    /** 同类型刷新时调用（可覆写，常用于重置内部状态） */
    OnRefresh(kv?: Record<string, any>): void {
        // 默认合并 kv：同源重放携带新参数（如减速幅度变化）时实例拿到新值
        if (kv) this.kv = { ...this.kv, ...kv };
    }

    /** 销毁时调用（可覆写，常用于还原副作用） */
    OnDestroy(): void { /* 默认空实现 */ }

    /** 每帧/每 tick 调用（dt 秒） */
    OnTick(_dt: number): void { /* 默认空实现 */ }

    // ============ 自带冷却（cd） ============

    /** 该效果的冷却时长（秒，配置值；0 = 无冷却） */
    getCd(): number { return this.def.cd ?? 0; }

    /** 冷却是否已就绪（无冷却恒为 true） */
    IsReady(): boolean { return this.getCd() <= 0 || this.cdRemaining <= 0; }

    /** 剩余冷却（秒） */
    getCdRemaining(): number { return this.cdRemaining; }

    /**
     * 触发一次并重置**自己**的冷却（其它带 cd 的效果不受影响）
     * @returns 冷却中就绪并已触发返回 true；仍在冷却返回 false
     */
    Trigger(): boolean {
        if (!this.IsReady()) return false;
        this.cdRemaining = this.getCd();
        this.OnTriggered();
        return true;
    }

    /** 触发回调（子类可覆写实现具体行为） */
    OnTriggered(): void { /* 默认空实现 */ }

    // ============ Effects 原子效果 ============

    /** 本 Modifier 声明的声明式效果列表（原子效果，见 EffectTypes） */
    getEffects(): ModifierEffect[] { return this.def.effects ?? []; }

    /**
     * 本 Modifier **实际生效**的属性条目。
     * `attrs_var` 时整表取自施加方 kv（共享模板 `属性修改` 的做法）；
     * 条目带 `var` 时用 kv 覆盖数值。见 EffectTypes.resolveAttrEntries。
     */
    resolveAttrs(): AttrEntry[] { return resolveAttrEntries(this.def.effects, this.kv); }

    // ============ Property 属性贡献 ============

    /**
     * 返回该 Modifier 对某属性的贡献值（null 表示不贡献该属性）
     * 由 `effects` 中所有 `modify_attr` 效果的条目汇总而来（同属性多条相加，mode 取第一条）；
     * 子类可覆写实现动态数值。
     */
    GetModifierProperty(attributeId: number): AttributeContributionLike | null {
        let value = 0;
        let mode: AttributeStackMode | undefined;
        let found = false;
        for (const e of this.resolveAttrs()) {
            if (e.attr !== attributeId) continue;
            found = true;
            value += e.value;
            if (mode === undefined) mode = e.mode;
        }
        if (!found) return null;
        return { value: value * this.stackCount, mode };
    }

    /** 枚举本 Modifier 影响的所有属性（供 ModifierSystem 汇总） */
    GetAffectedAttributes(): number[] {
        return this.resolveAttrs().map((e) => e.attr);
    }

    // ============ State 状态控制 ============

    /** 返回状态施加表（由 `apply_state` 效果汇总，可覆写） */
    CheckState(): Partial<Record<StateType, boolean>> {
        const out: Partial<Record<StateType, boolean>> = {};
        for (const eff of this.getEffects()) {
            if (eff.type !== 'apply_state') continue;
            out[eff.state] = eff.value !== false;
        }
        return out;
    }

    // ============ 周期效果 ============

    /** 本 Modifier 的周期效果列表（每条自带计时器） */
    getTickEffects(): ModifierTickEffect[] { return this.tickEffectList; }

    /**
     * 推进周期计时器，返回本帧应当触发的周期效果（可能多条）。
     * 由 ModifierSystem 驱动；每条周期效果**各算各的间隔**。
     */
    advanceTicks(dt: number): ModifierTickEffect[] {
        if (this.tickEffectList.length === 0) return Modifier.NO_TICKS;
        const fired: ModifierTickEffect[] = [];
        for (let i = 0; i < this.tickEffectList.length; i++) {
            const interval = this.tickEffectList[i].interval;
            if (!(interval > 0)) continue;
            const t = (this.tickTimers[i] ?? 0) + dt;
            let rest = t;
            while (rest >= interval) {
                rest -= interval;
                fired.push(this.tickEffectList[i]);
            }
            this.tickTimers[i] = rest;
        }
        return fired.length ? fired : Modifier.NO_TICKS;
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
            origin: this.origin,          // 效果归属的来源组（与施加本 Modifier 的条目一致）
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
export type { ModifierCfg, ModifierEventAction, AttrEntry, ModifierEffect, ModifierTickEffect };
export { DamageType };
