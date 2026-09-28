import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 击杀商店 Buff 配置表（kill_buffs.json）
 *
 * 数据源：设计稿 docs/hero-design/assets/data-skills.js 的 KBUFF_DATA（20 个）
 * 生成：node tools/excel_export/scripts/gen-shop-from-hero-design.ts
 *
 * 设计：击杀点购买，可重复购买（价格按 price_growth 递增），层数封顶 max_stack，
 *       全部为「对英雄基础属性」的百分比加成（同类加法叠加）。
 * 查询：TbRoot.ins.getTbContainer(KillBuffCfgContainer).getCfgById(1)
 */

/** 作用属性标识：8 个基础属性 + special（特殊机制，走 script_id） */
export type KillBuffStat = 'atk' | 'hp' | 'range' | 'def' | 'aspd' | 'crit' | 'dodge' | 'regen' | 'special';

export interface KillBuffCfg {
    id: number;
    code: string;
    name: string;
    stat: KillBuffStat;
    /** 对应 AttributeType 编号（stat=special 时缺省） */
    attr_id?: number;
    /** 每层加成（百分比数值：8 = +8%，0.6 = +0.6%）；special 型为 0 */
    per: number;
    /** 每层效果原文（设计稿 per），配置校对用 */
    per_desc?: string;
    max_stack: number;
    /** 首层价格（击杀点） */
    price: number;
    /** 每次购买后的价格系数（1.35 = 每次 ×1.35） */
    price_growth: number;
    tags?: string[];
    /** 复杂逻辑代码类名（逃逸口，special 型必经） */
    script_id?: string;
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
