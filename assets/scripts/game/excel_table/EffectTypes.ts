import type { AttributeStackMode, DamageType, StateType } from '../battle/types';
import type { AttributeType } from '../battle/core/Types';

/**
 * 原子效果词汇（全项目唯一一份）—— 「效果」= 类型 + 参数
 *
 * 设计原则：
 *   1. **一个效果只描述一件事**，具体参数（属性编号 / 数值 / 叠加方式 / 状态名…）都写在效果里，
 *      不再散落成一堆表列（旧的 modifiers.properties / states / tick 三列已废弃）。
 *   2. **参数可以由外部传入**：`attrs_var` 指向施加时 kv 里的同名键，用 kv 的值整表替换 `attrs`。
 *      「同一条效果模板、不同幅度」靠它实现 —— 例如全项目共用一条 `属性修改` Modifier
 *      （id 见 battle/types.ts 的 MODIFY_ATTR_TEMPLATE_ID），属性与数值全由施加方给。
 *   3. 同一套词汇被三处复用：
 *      · `ModifierCfg.effects`        —— **声明式**：随 Modifier 存活期间由 Modifier/ModifierSystem 轮询
 *      · `AbilityCfg.effects`         —— **命令式**：由 EffectExecutor 执行一次（见 Tb_AbilityConfig.ConfigAction）
 *      · `ModifierCfg.events[].actions` —— 事件触发时执行一次
 */

/** 一条已归一化的属性修改条目（简写 `[属性id, 值, 叠加方式?]` 归一化后的形态） */
export interface AttrEntry {
    attr: AttributeType;
    value: number;
    mode?: AttributeStackMode;
    /**
     * 变量绑定：施加时若 kv[var] 有值则用 kv 值替代 value（用于"同语义不同幅度"模板，
     * 如减速模板 value=-90 占位、kv { slow: -150 } 传 50% 减速）。缺省用 value。
     */
    var?: string;
}

/**
 * 属性修改条目的配置写法：
 *   · 简写：`[属性id, 值, 叠加方式?]`，如 `[3, 14, "percent"]`
 *   · 对象：`{ attr, value, mode?, var? }`（需要 kv 变量绑定时用）
 *
 * 值语义（见 docs/数值配置参考手册.md「数值口径四条铁律」）：
 *   · `percent` = **百分数**（14 = +14%），对**基础属性**乘算一次，多来源加法叠加、不复利
 *   · `add`（缺省）= **固定值**，`final = base + Σv`（缩放型属性 int = 值×100）
 *   · `multiply` = 小数且**复利**（0.14）—— 百分比加成不要用它
 */
export type AttrEffectEntry = [AttributeType, number, AttributeStackMode?] | AttrEntry;

/** 属性修改效果：`attrs` 直接给列表，或用 `attrs_var` 让施加方通过 kv 传入整张列表 */
export interface ModifyAttrEffect {
    type: 'modify_attr';
    /** 属性条目列表（`attrs_var` 存在时本字段被整表替换） */
    attrs?: AttrEffectEntry[];
    /** 施加时从 `kv[attrs_var]` 取属性列表，整表替换 `attrs` */
    attrs_var?: string;
}

/** 状态效果：本 Modifier 存活期间宿主获得该状态（`value: false` = 压制该状态） */
export interface ApplyStateEffect {
    type: 'apply_state';
    state: StateType;
    value?: boolean;
}

/** 周期伤害（DoT）：每 interval 秒对宿主造成一次伤害 */
export interface TickDamageEffect {
    type: 'tick_damage';
    /** 间隔（秒） */
    interval: number;
    /** 每次伤害 */
    value: number;
    damage_type?: DamageType;
}

/** 周期治疗（HoT）：每 interval 秒治疗宿主一次 */
export interface TickHealEffect {
    type: 'tick_heal';
    interval: number;
    value: number;
}

/** 周期施加 Modifier：每 interval 秒向宿主施加一次 modifier（可带概率） */
export interface TickApplyModifierEffect {
    type: 'tick_apply_modifier';
    interval: number;
    modifier: number;
    duration?: number;
    /** 概率 0-1，缺省 1 */
    chance?: number;
}

/** 周期效果：**每条自带一个计时器**，同一 Modifier 上多条周期效果各算各的 */
export type ModifierTickEffect = TickDamageEffect | TickHealEffect | TickApplyModifierEffect;

/** 声明式效果（用于 `ModifierCfg.effects`） */
export type ModifierEffect = ModifyAttrEffect | ApplyStateEffect | ModifierTickEffect;

/** 是否为周期效果 */
export function isTickEffect(e: ModifierEffect): e is ModifierTickEffect {
    return e.type === 'tick_damage' || e.type === 'tick_heal' || e.type === 'tick_apply_modifier';
}

/** 简写/对象两种写法归一化为对象形态 */
export function normalizeAttrEntry(e: AttrEffectEntry): AttrEntry {
    if (Array.isArray(e)) return { attr: e[0], value: e[1], mode: e[2] };
    return e;
}

/**
 * 按施加参数解析出**实际生效**的属性条目（声明式/命令式共用一份实现）
 * - `attrs_var`：整表取自 `kv[attrs_var]`
 * - 条目的 `var`：用 `kv[var]` 覆盖 value
 * @param kv 施加时传入的参数
 */
export function resolveAttrEntries(
    effects: ModifierEffect[] | undefined,
    kv?: Record<string, any>,
): AttrEntry[] {
    const out: AttrEntry[] = [];
    const push = (raw: AttrEffectEntry): void => {
        const e = normalizeAttrEntry(raw);
        if (e.var && kv && kv[e.var] !== undefined) {
            const v = kv[e.var];
            out.push({ attr: e.attr, mode: e.mode, var: e.var, value: typeof v === 'number' ? v : Number(v) || 0 });
            return;
        }
        out.push(e);
    };
    for (const eff of effects ?? []) {
        if (eff.type !== 'modify_attr') continue;
        if (eff.attrs_var) {
            const list = kv?.[eff.attrs_var];
            if (Array.isArray(list)) for (const it of list) push(it as AttrEffectEntry);
            continue;
        }
        for (const it of eff.attrs ?? []) push(it);
    }
    return out;
}
