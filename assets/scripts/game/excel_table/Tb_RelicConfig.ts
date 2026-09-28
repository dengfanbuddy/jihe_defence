import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 遗物配置表（relics.json）——「一件遗物一行」
 *
 * 局内版与局外版是**同一件遗物**：身份列（`id` / `name` / `code` / `icon` / `rarity` / `category`）共用一套，
 * 只有效果与描述分两侧（`modifiers_inner` / `description_inner` 与 `modifiers_outer` / `description_outer`），
 * `scope` 说明这件遗物在哪几侧出现。规则与列定义见 docs/配置规则_品质与词条门禁.md §1.1。
 *
 * 查询：TbRoot.ins.getTbContainer(RelicCfgContainer).getCfgById(1003)
 * 取某一侧的效果：`relicInnerModifiers(cfg)` / `relicOuterModifiers(cfg)`（别直接读字段，字段是可选的）
 */

/** 遗物品质：白/蓝/黄/红（**局内局外同一阶梯**） */
export type RelicRarity = 'common' | 'rare' | 'epic' | 'legendary';

/**
 * 遗物作用域 —— 语义是「**这件遗物在哪几侧出现**」（2026-07 起一件遗物一行）：
 *   · `inner` = 只有局内版（本局内生效，肉鸽商店可抽到；id 1~5 手工 demo / 1001~1293 设计稿道具）
 *   · `outer` = 只有局外版（跨局永久收集；id 1294~1302，多是 dota2 中立道具）
 *   · `both`  = 两侧都有：同一件遗物的两套效果（id 用的是**局内 id**）
 */
export type RelicScope = 'inner' | 'outer' | 'both';

/** 遗物引用的 Modifier 条目（`modifiers_inner` / `modifiers_outer` 的元素） */
export interface RelicModifierEntry {
    modifier: number;             // 引用的 ModifierCfg.id（number）
    /**
     * 持续时长（秒）。**留空 / `null` = 永久**（遗物都是一次性获得、整局生效的被动；
     * Excel 空单元格导出成 `null`，所以 `null` 与"没写"同义，**不要**理解成 0 秒）。
     * 只有"限时遗物"才写正数。
     * ⚠ 这里**不回落** `ModifierCfg.duration`（那是给技能/临时 buff 的时长，
     *   如 mod 11「吸血」= 5 秒，遗物引用它时会用自己那份 Modifier 实例，见 `BattleEquip.Apply`）。
     */
    duration?: number | null;
    /**
     * 施加参数（透传给 Modifier，供效果的 `attrs_var` / `var` 绑定取值）。
     * 纯属性加成统一引用「属性修改」共享模板（id = MODIFY_ATTR_TEMPLATE_ID）：
     *   { "modifier": 1000, "kv": { "attrs": [[3, 14, "percent"]] } }
     * attrs 的值语义：percent 是**百分数**（14 = +14%，对基础属性乘算一次）、add 是**固定值**。
     */
    kv?: Record<string, any>;
}

export interface RelicCfg {
    id: number;
    name: string;
    /** 唯一英文代码（程序引用用；有局外版的遗物取自原装备表，形如 `d2_gauntlets` / `d2n_apex`） */
    code?: string;
    /** 图标资源路径（局内局外**共用**同一张图） */
    icon?: string;
    rarity: RelicRarity;
    /** 这件遗物在哪几侧出现（见 RelicScope） */
    scope: RelicScope;
    /** 局外分类 d2_basic / d2_upgrade / d2_neutral（只有局外版才填） */
    category?: string;
    // ---- 两侧的效果与描述：只有对应侧存在时才有值，取用一律走下面的帮助函数 ----
    /** **局内版**效果描述（肉鸽商店/背包展示） */
    description_inner?: string;
    /**
     * **局内版**效果 = 一组永久 Modifier（**遗物 → Modifier 两层**）。
     * 纯属性加成不要为每件遗物单独建 Modifier，统一引用共享模板 + kv.attrs 传参。
     */
    modifiers_inner?: RelicModifierEntry[];
    /** **局外版**效果描述（局外收集展示） */
    description_outer?: string;
    /** **局外版**效果（口径同上；局外是跨局永久加成，一般只给固定值 add） */
    modifiers_outer?: RelicModifierEntry[];
    /** 复杂遗物逻辑（逃逸口；局内局外共用一行） */
    script_id?: string;
}

/** 这件遗物有局内版吗（scope = inner / both；缺省视为 inner，兼容老数据） */
export function relicHasInner(relic: RelicCfg): boolean {
    return !relic.scope || relic.scope === 'inner' || relic.scope === 'both';
}

/** 这件遗物有局外版吗（scope = outer / both） */
export function relicHasOuter(relic: RelicCfg): boolean {
    return relic.scope === 'outer' || relic.scope === 'both';
}

/** 局内版效果（Modifier 引用列表；没有局内版时是空数组） */
export function relicInnerModifiers(relic: RelicCfg): RelicModifierEntry[] {
    return relic.modifiers_inner || [];
}

/** 局外版效果（Modifier 引用列表；没有局外版时是空数组） */
export function relicOuterModifiers(relic: RelicCfg): RelicModifierEntry[] {
    return relic.modifiers_outer || [];
}

/** 局内版描述（商店/背包显示用；没有局内版时是空串） */
export function relicInnerDesc(relic: RelicCfg): string {
    return relic.description_inner || '';
}

/** 局外版描述（局外收集显示用；没有局外版时是空串） */
export function relicOuterDesc(relic: RelicCfg): string {
    return relic.description_outer || '';
}

@tb_config(':tb/relics')
export class RelicCfgContainer extends TbContainer<RelicCfg> {
  getTbName(): string { return 'RelicCfg'; }
}
