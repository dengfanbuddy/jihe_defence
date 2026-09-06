import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 战斗遗物（肉鸽装备）配置表（relics.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(RelicCfgContainer).getCfgById(1)
 */

/** 遗物引用的 Modifier 条目 */
export interface RelicModifierEntry {
    modifier: number;             // 引用的 ModifierCfg.id（number）
    duration?: number;            // 默认用 ModifierCfg.duration
}

export interface RelicCfg {
    id: number;
    name: string;
    icon?: string;
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
    description: string;
    modifiers: RelicModifierEntry[]; // 遗物 = 一组永久 Modifier
    script_id?: string;           // 复杂遗物逻辑（逃逸口）
}

@tb_config(':tb/relics')
export class RelicCfgContainer extends TbContainer<RelicCfg> {
  getTbName(): string { return 'RelicCfg'; }
}
