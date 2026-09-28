import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { DamageType } from '../battle/types';
import type { AttrEffectEntry } from './EffectTypes';
import type { RelicRarity } from './Tb_RelicConfig';

/**
 * 战斗技能配置表（abilities.json）
 *
 * **2026-09 起本表是「技能」的唯一来源**：单位技能与肉鸽额外技能同表，
 * 靠 `scope` 区分出现位置（`unit` 单位自带 / `shop` 肉鸽商店抽取池 / `both` 两侧都出）。
 * 独立表 `shop_skills` 已并入本表（迁移脚本 `tools/excel_export/scripts/merge-shop-skills-into-abilities.mjs`）。
 *
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

/**
 * 技能归属（决定这个技能出现在哪一侧）：
 *   `unit` 单位自带（units.json 的 `abilities` 引用它）
 *   `shop` 肉鸽商店抽取池（额外技能，id 段 101~130）
 *   `both` 两侧都出
 */
export type AbilityScope = 'unit' | 'shop' | 'both';

/** 商店技能的品质（与 relics.rarity 同一阶梯：白/蓝/黄/红） */
export type AbilityRarity = RelicRarity;

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
    effects: ConfigAction[];      // **1 级**效果列表
    script_id?: string;           // 复杂技能对应代码类名（逃逸口）
    level?: number;               // 当前等级（可选，用于成长）
    level_damage?: number[];      // 每级伤害 [20, 40, 60]（可选）
    /** 目标选择策略（缺省 nearest）。自动施放的主动技能用它索敌（普攻索敌见 units.json attack_targeting） */
    targeting?: TargetingStrategy;
    /** 升级形态 id：**单位技能**的「换 id 升阶」链（肉鸽技能不用它，改用 max_level 原地升级） */
    upgrades_to?: number;
    /** 技能弹道预制件路径（effects 含 projectile 时使用，如 'prefabs/projectiles/fireball'） */
    projectile_prefab?: string;

    /* ── 以下为「一行多级」+ 商店抽取所需列（原 shop_skills 表并入） ── */

    /** 归属：unit 单位自带 / shop 肉鸽商店抽取池 / both 两侧都出（**必填**） */
    scope: AbilityScope;
    /** 唯一英文代码（程序引用用；单位技能可留空） */
    code?: string;
    /** 英文名（展示/校对用） */
    name_en?: string;
    /** 品质（只有商店技能填；单位技能留空） */
    rarity?: AbilityRarity;
    /** 抽取阶段门槛 1~4（商店技能必填） */
    stage?: number;
    /** 同品质内的抽取权重（留空按 1） */
    weight?: number;
    /** 最高等级 1~3（重复抽到同名技能 +1 级，满级后不再进池；单位技能填 1） */
    max_level?: number;
    /** 流派标签 */
    tags?: string[];
    /** 1 级效果描述（留空时运行时按 cooldown/effects 自动拼一句话兜底） */
    lv1?: string;
    /** 2 级效果描述 */
    lv2?: string;
    /** 3 级效果描述（满级） */
    lv3?: string;
    /** 2 级效果**整体覆盖** `effects`（留空 = 沿用 1 级） */
    effects_lv2?: ConfigAction[];
    /** 3 级效果**整体覆盖**（留空 = 沿用上一级） */
    effects_lv3?: ConfigAction[];
    /** 联动说明（设计参考，不参与结算） */
    synergy?: string;
}

/** 技能是否出现在肉鸽商店抽取池（scope=shop / both） */
export function abilityInShop(cfg: AbilityCfg): boolean {
    return cfg?.scope === 'shop' || cfg?.scope === 'both';
}

/** 技能的最高等级（缺省 1；钳到 1~3） */
export function abilityMaxLevel(cfg: AbilityCfg): number {
    const lv = Math.floor(cfg?.max_level ?? 1);
    return Math.max(1, Math.min(3, Number.isFinite(lv) ? lv : 1));
}

/**
 * 指定等级的**效果数组**：`effects` 是 1 级，`effects_lv2` / `effects_lv3` 是整体覆盖；
 * 某一级留空 = 沿用上一级（所以 2 级留空时 3 级会取到 1 级的效果）。
 */
export function abilityEffectsAtLevel(cfg: AbilityCfg, level: number): ConfigAction[] {
    const lv = Math.max(1, Math.min(abilityMaxLevel(cfg), Math.floor(level) || 1));
    if (lv >= 3 && cfg.effects_lv3?.length) return cfg.effects_lv3;
    if (lv >= 2 && cfg.effects_lv2?.length) return cfg.effects_lv2;
    return cfg.effects ?? [];
}

/**
 * 指定等级的效果描述：优先取 `lv1/lv2/lv3` 列；
 * 留空时**沿用上一级**有文案的那一档，全空则返回 ''（由调用方决定要不要用自动拼句兜底）。
 */
export function abilityLevelDesc(cfg: AbilityCfg, level: number): string {
    const lv = Math.max(1, Math.min(abilityMaxLevel(cfg), Math.floor(level) || 1));
    const byLevel = [cfg.lv1, cfg.lv2, cfg.lv3];
    for (let i = Math.min(lv, byLevel.length) - 1; i >= 0; i--) {
        const text = byLevel[i];
        if (typeof text === 'string' && text.trim() !== '') return text;
    }
    return '';
}

@tb_config(':tb/abilities')
export class AbilityCfgContainer extends TbContainer<AbilityCfg> {
  getTbName(): string { return 'AbilityCfg'; }

  /** 肉鸽商店抽取池（scope=shop / both） */
  getShopSkills(): AbilityCfg[] {
    return this.cfgs.filter(abilityInShop);
  }

  /** 按 id 取商店技能（id 不在商店池里返回 undefined） */
  getShopSkill(id: number): AbilityCfg | undefined {
    const cfg = this.getCfgById(id);
    return cfg && abilityInShop(cfg) ? cfg : undefined;
  }

  /** 指定等级的效果描述（薄封装，供配置门面/UI 调用） */
  getLevelDesc(cfg: AbilityCfg, level: number): string {
    return abilityLevelDesc(cfg, level);
  }
}
