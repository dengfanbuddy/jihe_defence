import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import type { ConfigAction } from './Tb_AbilityConfig';
import type { RelicRarity } from './Tb_RelicConfig';

/**
 * 肉鸽额外技能配置表（shop_skills.json）
 *
 * 数据源：设计稿 docs/hero-design/assets/data-skills.js 的 RSKILL_DATA（30 个）
 * 生成：node tools/excel_export/scripts/gen-shop-from-hero-design.ts
 *
 * 设计：3 个额外技能槽；重复抽到同名技能 = 升 1 级（max_level 封顶）。
 * 查询：TbRoot.ins.getTbContainer(ShopSkillCfgContainer).getCfgById(1)
 */
export interface ShopSkillCfg {
    id: number;
    code: string;
    name: string;
    name_en?: string;
    rarity: RelicRarity;
    /** 所属阶段 1~4（抽取门槛，同 shop_items.stage） */
    stage: number;
    /** 同品质内的抽取权重 */
    weight: number;
    /** 可升级层数（1~3） */
    max_level: number;
    tags?: string[];
    /** 1 / 2 / 3 级效果描述 */
    lv1: string;
    lv2?: string;
    lv3?: string;
    /** 联动说明（设计参考） */
    synergy?: string;
    /** 效果 JSON 数组（走 EffectExecutor，动作类型见 Tb_AbilityConfig.ConfigAction） */
    effects?: ConfigAction[];
    /** 复杂逻辑代码类名（逃逸口） */
    script_id?: string;
}

@tb_config(':tb/shop_skills')
export class ShopSkillCfgContainer extends TbContainer<ShopSkillCfg> {
    getTbName(): string { return 'ShopSkillCfg'; }

    /** 取指定等级的效果描述文本（level 从 1 开始，超出范围取最高档） */
    getLevelDesc(cfg: ShopSkillCfg, level: number): string {
        const lv = Math.max(1, Math.min(cfg.max_level || 1, level));
        return (lv >= 3 ? cfg.lv3 : lv === 2 ? cfg.lv2 : cfg.lv1) ?? cfg.lv1;
    }
}
