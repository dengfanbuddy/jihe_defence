import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/** 装备配置实体 */
export class EquipCfg {
  id!: number;
  code!: string;
  name!: string;
  description!: string;
  category!: string;
  quality!: number;
  heroId?: string;
  attributes!: Record<string, number>;
  /** 属性分层映射 — key=属性名, value=层类型, 缺省按 quality 决定 */
  bonusTypes?: Record<string, string>;
  /** 全百分比加成（最高品质装备独有） */
  allPercent?: number;
}

@tb_config(':tb/equipments')
export class EquipCfgContainer extends TbContainer<EquipCfg> {
  getTbName(): string { return EquipCfg.name; }
}
