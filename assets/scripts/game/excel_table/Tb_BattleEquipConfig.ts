import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/** װ������ʵ�� */
export class BattleEquipCfg {
    id: number;
    name: string;
    icon?: string;
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
    description: string;
    modifiers: BattleEquipModifierEntry[]; // 遗物 = 一组永久 Modifier
    script_id?: string;    
}
/** ---- 遗物表 relics（肉鸽） ---- */
export interface BattleEquipModifierEntry {
    modifier: string;             // 引用的 ModifierCfg.id
    duration?: number;            // 默认用 ModifierCfg.duration
}

@tb_config(':tb/equipments')
export class EquipCfgContainer extends TbContainer<BattleEquipCfg> {
  getTbName(): string { return BattleEquipCfg.name; }
}
