import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { DamageType } from '../battle/types';
import type { AttrEffectEntry } from './EffectTypes';

/**
 * 战斗技能配置表（abilities.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(AbilityCfgContainer).getCfgById(1)
 */

/** 目标选择策略（技能/普攻各自的索敌方式） */
export type TargetingStrategy = 'nearest' | 'lowest_hp' | 'farthest' | 'random' | 'strongest';

/** 技能行为类型 */
export type AbilityBehavior =
    | 'passive'     // 被动
    | 'attack'      // 普攻（遗留标记：仅用于把普攻形态排除出技能枚举；普攻实际由 Entity.Attack 按攻击力属性驱动，不执行本 effects）
    | 'no_target'   // 无目标，按下即触发
    | 'unit_target' // 指定单位
    | 'point'       // 指定地面
    | 'aoe'         // 范围
    | 'toggle';     // 切换

/** 配置化动作（与技能 effects 共用一套 Action DSL；引用 id 均为 number） */
export type ConfigAction =
    | { type: 'damage'; value: number; damage_type?: DamageType; chance?: number; projectile_speed?: number }
    | { type: 'aoe_damage'; value: number; radius: number; damage_type?: DamageType }
    | { type: 'heal'; value: number; chance?: number }
    | { type: 'apply_modifier'; modifier: number; duration?: number; chance?: number; kv?: Record<string, any> }
    | { type: 'remove_modifier'; modifier: number }
    /**
     * 属性修改（**命令式**一次）：内部转成「属性修改」共享 Modifier 模板
     * （id 见 battle/types.ts 的 MODIFY_ATTR_TEMPLATE_ID），走 ModifierSystem 的贡献通道，
     * percent/add 语义与肉鸽遗物完全一致；`duration` 缺省 = 永久。
     * 条目写法见 EffectTypes.AttrEffectEntry（值语义：percent 是百分数、add 是固定值）。
     */
    | { type: 'modify_attr'; attrs: AttrEffectEntry[]; duration?: number }
    | { type: 'lifesteal'; ratio: number }   // 按本次伤害吸血
    | { type: 'reflect'; ratio: number }     // 反弹伤害
    | { type: 'steal_gold'; value: number }  // 偷取目标金币（赏金猎人）
    | {
          type: 'projectile';                // 多目标弹道：对 N 个目标发射弹道，命中后执行 hit_effects
          value?: number;                    // 直接伤害（0/缺省 = 纯效果镖）
          damage_type?: DamageType;
          speed: number;                     // 弹速（像素/秒）
          targeting?: TargetingStrategy;     // 目标选择策略（缺省 nearest）
          target_count?: number;             // 目标数量（缺省 1）
          radius?: number;                   // 选择范围（缺省全图）
          hit_effects?: ConfigAction[];      // 命中后执行的动作（如施加毒/减速）
      }
    | { type: 'execute_script'; script_id: string }; // 复杂逻辑逃逸口（代码类名，保持字符串）

export interface AbilityCfg {
    id: number;
    name: string;
    icon?: string;
    behavior: AbilityBehavior;
    cooldown: number;             // 秒
    mana_cost: number;
    cast_range?: number;
    cast_point?: number;          // 施法前摇（秒）
    damage_type?: DamageType;
    damage?: number;              // 快捷伤害字段（effects 也可覆盖）
    effects: ConfigAction[];      // 施放时的效果列表
    script_id?: string;           // 复杂技能对应代码类名（逃逸口）
    level?: number;               // 当前等级（可选，用于成长）
    level_damage?: number[];      // 每级伤害 [20, 40, 60]（可选）
    /** 目标选择策略（缺省 nearest）。自动施放的主动技能用它索敌（普攻索敌见 units.json attack_targeting） */
    targeting?: TargetingStrategy;
    /** 升级形态 id：抽到重复技能时整体替换（升级 = 换形态） */
    upgrades_to?: number;
    /** 技能弹道预制件路径（effects 含 projectile 时使用，如 'prefabs/projectiles/fireball'） */
    projectile_prefab?: string;
}

@tb_config(':tb/abilities')
export class AbilityCfgContainer extends TbContainer<AbilityCfg> {
  getTbName(): string { return 'AbilityCfg'; }
}
