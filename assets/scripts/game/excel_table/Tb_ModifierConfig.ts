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
    /**
     * **这一行自己的图标**（buff 图标；`resources` 相对路径、不带扩展名，如 `textures/buffs/burn`）。
     *
     * 2026-11 起状态栏真的会消费它，但**它是兜底**：一格优先显示**来源的图标**
     * （遗物 → `relics.icon` / 技能 → `abilities.icon` / 药水 → `battle_items.icon`，
     *  判据在 `battle/StatusBar.ts` 的 `originInfo`），来源表没有（或这行没有 `origin`）才用这一列。
     * 空 = 运行期回落「色块 + 短标 + 值」的画法（不是空白格）；取不到图**不重试**。
     * ⚠ 写进来的那张帧**必须真在某个图集 / 碎图里** —— `audit:statusbar` 的 G5 会读 `plist` 逐条核。
     */
    icon?: string;
    is_debuff: boolean;           // 是否为负面
    is_hidden?: boolean;          // 是否在 Buff 栏隐藏
    /**
     * **允许进 HUD 状态栏**（2026-11 新增；白名单，缺省 false）。
     *
     * 只有标了它的行才**可能**出现在英雄头像下方那一行（`View_Game_Stage/buff_status`）。
     * 标它的两类：
     *   ① 会挂到**英雄**身上的限时 / 负面效果（燃烧 / 无敌 / 共享模板 1000 的限时实例）；
     *   ② 常驻载体里「有就绪态 / 层数可讲」的脚本行（遗物·蓄力 / 不屈 / 圣盾 …），
     *      它们的值时有时无，由实例的 `Modifier.GetBarState()` 现算 —— 返回 null 就不占格子。
     *
     * ⚠ 只打**怪物**的 debuff（遗物减速 / 点燃 / 中毒那一族）**一律不标**：英雄栏看不到它们。
     * ⚠ 标了它不等于一定显示：还要「本帧真的有内容」（有剩余时长 或 `GetBarState()` 非空）。
     */
    bar_show?: boolean;
    /**
     * 状态栏格子的**占位短标**（≤2 汉字，如「燃烧」「蓄力」）。
     *
     * 留空 = 运行期按来源取名兜底：共享模板 1000 的限时实例按 `origin`
     * （`item:<id>` / `relic:<id>` / `ability:<id>`）取药水 / 遗物 / 技能名。
     *
     * ⚠ 图标不走这一列（那是 `icon` 列或来源配表的事），本列也**不改成路径** ——
     *   它的职责是"**没有图**的时候格子上写什么"（有图时格子只画「值」一行，见 docs/status-bar/README.md §4.5）。
     */
    bar_text?: string;
    /**
     * **状态说明**（2026-11 新增）：点 HUD 状态栏那一格时弹出的说明面板上那一句话。
     *
     * 玩家能点到的只有 `bar_show = 1` 的那十几行（其余行根本不进状态栏），
     * 所以这一列主要服务它们 —— 其余行留空即可。
     *
     * 留空时的兜底：面板退化成一个通用句（「持续 N 秒 / 永久」+ 正面/负面），
     * 而**共享模板 1000 的限时实例**永远走 `origin` 的配表名与说明
     * （药水取 `battle_items.desc`、遗物取 `relics.description_inner`、技能取 `abilities.lv1`），
     * 不看这一列 —— 它只是一个模板，本身没有语义。
     */
    desc?: string;
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
