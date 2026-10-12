import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * **神器**配置表（kill_buffs.json）
 *
 * 名字沿用旧称（表名不动，免得动一整套导出链路）；语义 = **神器**，见 `docs/artifact-drop/README.md`。
 *
 * 设计：击杀数购买，可重复购买（价格按 price_growth 递增），层数封顶 max_stack。
 *       两种形态，由 `stat` 区分：
 *         · **属性型**（`atk`/`hp`/`range`/`def`/`aspd`/`crit`/`dodge`/`regen`）——
 *           直接给英雄属性，叠加方式是 `percent` 或 `add`（base = 0 的那些必须 `add`）；
 *           每买一层挂**一条独立 Modifier**（`origin = killbuff:{id}:{层}`），天然叠层。
 *         · **机制型**（`special`，如天怒"每 10 杀朝面前喷出扇形"）—— 属性列表达不出来，
 *           效果写在 `modifiers` 里（引用 `modifiers.json` 里有 `script_id` 的行），
 *           由 `battle/SpecialBuffs.ts` 的脚本类实现；**重买只更新 kv.stack，不新挂一条**
 *           （口径见 `BuffShop.applySpecial` 与 `SpecialBuffs.ts` 文件头）。
 * 查询：TbRoot.ins.getTbContainer(KillBuffCfgContainer).getCfgById(1)
 * ⚠ 表里**没有** `script_id` 列：脚本类名挂在 `modifiers.json` 的行上（与遗物/道具同一条路），
 *   神器表只负责"引用哪条 Modifier + 传什么 kv"。
 */

/** 作用属性标识：8 个基础属性 + special（机制型，走 `modifiers`） */
export type KillBuffStat = 'atk' | 'hp' | 'range' | 'def' | 'aspd' | 'crit' | 'dodge' | 'regen' | 'special';

/** 一条要施加到英雄身上的 Modifier（写法与 `relics.modifiers_inner` 完全一致） */
export interface KillBuffModifierEntry {
    /** 引用的 `ModifierCfg.id`（属性型神器不走这里，一律用共享模板 `MODIFY_ATTR_TEMPLATE_ID` = 1000） */
    modifier: number;
    /**
     * 施加参数（挂在哪条 Modifier 上的"这条效果用多少"）。
     * ⚠ 这里**不写 duration**：神器一律永久，由 `BuffShop.applyStack` 传 `-1`。
     * ⚠ 也**不写 stack**：当前购买层数由 `BuffShop.applySpecial` 在施加时注入。
     */
    kv?: Record<string, any>;
}

export interface KillBuffCfg {
    id: number;
    code: string;
    name: string;
    /**
     * 图标资源路径（`textures/artifacts/<code>`，resources 相对、**不带扩展名**）。
     *
     * 2026-11 补齐（此前这一列**根本不存在** ⇒ 摊位 `content/head/inner` 一直是那张已退场的占位图，
     * 编辑器里画成洋红块）。帧名 = `code`，图集 = `textures/artifacts/artifacts`（**与遗物同一套画风**，
     * 因为摊位 `head` 那圈九宫格按四档品质色染色，只有「中明度主体 + 深描边」在四档上都读得清）。
     * 口径与出图流程见 `docs/artifact-buff-icons/README.md`。
     */
    icon?: string;
    stat: KillBuffStat;
    /** 对应 AttributeType 编号（stat=special 时缺省） */
    attr_id?: number;
    /** 每层加成（百分比数值：8 = +8%，0.6 = +0.6%）；special 型为 0（数值全在 `modifiers[].kv`） */
    per: number;
    /** 每层效果原文（**会显示在商店格子上**，所以要写全随层数变化的部分） */
    per_desc?: string;
    max_stack: number;
    /** 首层价格（击杀点） */
    price: number;
    /** 每次购买后的价格系数（1.35 = 每次 ×1.35） */
    price_growth: number;
    tags?: string[];
    /** 机制型（`stat = special`）的效果：引用的 Modifier 列表（必填，否则这条神器买了没效果） */
    modifiers?: KillBuffModifierEntry[];
    note?: string;
}

@tb_config(':tb/kill_buffs')
export class KillBuffCfgContainer extends TbContainer<KillBuffCfg> {
    getTbName(): string { return 'KillBuffCfg'; }

    /** 第 n 层（n 从 1 开始）的购买价格：price × growth^(n-1)，向上取整 */
    getPriceAt(cfg: KillBuffCfg, stack: number): number {
        const n = Math.max(1, stack);
        return Math.ceil(cfg.price * Math.pow(cfg.price_growth ?? 1, n - 1));
    }
}
