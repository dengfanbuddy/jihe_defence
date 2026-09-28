import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { DispelLevel, ModifierStackMode } from '../battle/types';
import type { ModifierEffect } from './EffectTypes';
import type { ConfigAction } from './Tb_AbilityConfig';

/**
 * 战斗 Modifier（Buff/Debuff）配置表（modifiers.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(ModifierCfgContainer).getCfgById(1)
 *
 * 表结构（效果原子化后）：
 *   · 生命周期字段（duration / cd / stack_mode / max_stack / strongest_only / dispel_level …）
 *     描述的是「实例」，一条 Modifier 只需要一处；
 *   · **效果**（attributes 修改 / 状态 / 周期伤害…）全部写在 `effects` 里，一个效果一件事，
 *     类型与参数见 EffectTypes.ts —— 不再有 properties / states / tick 三列。
 *
 * 纯属性加成不要新增 Modifier：全项目共用「属性修改」模板
 * （id = battle/types.ts 的 MODIFY_ATTR_TEMPLATE_ID），属性与数值由施加方 kv 传入。
 */

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
    /**
     * 该效果**自己**的冷却（秒）；0 / 缺省 = 无冷却（常驻）。
     * 用于「自带冷却的被动」：每个 Modifier 实例各持一个计时器，
     * 同一实体上挂多个带 cd 的效果时**各算各的**（见 Modifier.cdRemaining / ModifierSystem.Tick）。
     */
    cd?: number;
    stack_mode: ModifierStackMode;// none/refresh/stack/renew
    max_stack?: number;           // stack 模式上限
    /**
     * 最强互斥（效果家族 opt-in）：实体上同 id 至多存活一个实例，无论来源/幅度。
     * 新施加比现存更强 → 移除现存挂新；更弱/等强 → refresh 型仅刷新最强实例时长、否则忽略。
     * 用于"减速 30/50 只算最强档"这类同语义不同幅度效果；默认 false = 跨来源独立实例（叠加）。
     */
    strongest_only?: boolean;
    /**
     * 声明式效果列表（原子效果，见 EffectTypes.ModifierEffect）：
     *   { "type":"modify_attr", "attrs":[[3,14,"percent"]] }   属性贡献
     *   { "type":"modify_attr", "attrs_var":"attrs" }          属性与数值由施加方 kv.attrs 传入（共享模板用）
     *   { "type":"apply_state", "state":"stunned" }            存活期间施加状态
     *   { "type":"tick_damage", "interval":1, "value":10, "damage_type":"magical" }  周期伤害
     *   { "type":"tick_heal", "interval":1, "value":20 }       周期治疗
     *   { "type":"tick_apply_modifier", "interval":3, "modifier":1 }  周期施加其它 Modifier
     */
    effects?: ModifierEffect[];
    events?: ModifierEventAction[]; // 事件绑定（触发式，非轮询）
    script_id?: string;           // 复杂逻辑对应的代码类名（逃逸口）
}

@tb_config(':tb/modifiers')
export class ModifierCfgContainer extends TbContainer<ModifierCfg> {
  getTbName(): string { return 'ModifierCfg'; }
}
