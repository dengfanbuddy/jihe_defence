import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { AttributeStackMode, DamageType, DispelLevel, ModifierStackMode, StateType } from '../battle/types';
import type { AttributeType } from '../battle/core/Types';
import type { ConfigAction } from './Tb_AbilityConfig';

/**
 * 战斗 Modifier（Buff/Debuff）配置表（modifiers.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(ModifierCfgContainer).getCfgById(1)
 */

/** Modifier 属性修改条目（属性编号 + 数值/叠加方式） */
export interface ModifierPropertyEntry {
    value: number;
    mode?: AttributeStackMode; // 覆盖属性默认叠加方式
}

/** 周期性效果（类似 Dota 2 的 poison/DoT） */
export interface ModifierTickCfg {
    interval: number;             // 秒
    damage?: number;              // 每次 tick 伤害（可选）
    damage_type?: DamageType;
    heal?: number;                // 每次 tick 治疗（可选）
    apply_modifier?: number;      // 每次 tick 附加的 modifier id（可选）
    apply_modifier_duration?: number;
    apply_modifier_chance?: number; // 概率 0-1
}

/** Modifier 事件绑定（Excel 中为 JSON 字符串列 events） */
export interface ModifierEventAction {
    event: string;                // 事件名：on_take_damage / on_attack_landed / on_death ...
    actions: ConfigAction[];
}

export interface ModifierCfg {
    id: number;                   // Modifier ID（number）
    name: string;
    icon?: string;
    is_debuff: boolean;           // 是否为负面
    is_hidden?: boolean;          // 是否在 Buff 栏隐藏
    dispel_level: DispelLevel;    // 可驱散等级
    duration: number;             // 默认持续时间（秒，-1 永久）
    stack_mode: ModifierStackMode;// none/refresh/stack/renew
    max_stack?: number;           // stack 模式上限
    /** 属性修改：二维数组 [[属性编号, {value, mode?}], ...] 或 [[属性编号, value], ...] */
    properties?: [AttributeType, number | ModifierPropertyEntry][];
    states?: Partial<Record<StateType, boolean>>;        // 状态施加 { "stunned": true }
    tick?: ModifierTickCfg;       // 周期效果
    events?: ModifierEventAction[]; // 事件绑定
    script_id?: string;           // 复杂逻辑对应的代码类名（逃逸口）
}

@tb_config(':tb/modifiers')
export class ModifierCfgContainer extends TbContainer<ModifierCfg> {
  getTbName(): string { return 'ModifierCfg'; }
}
