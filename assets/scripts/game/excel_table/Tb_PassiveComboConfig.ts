import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/** 被动技能组合配置实体 */
export class PassiveComboCfg {
  id!: number;
  code!: string;
  name!: string;
  /** 组合包含的技能 ID 列表 */
  skills!: string[];
  /** 下一级组合 ID（0=无后续） */
  nextId!: number;
  /** 解锁等级要求 */
  unlockLevel!: number;
  /** 组合品质 */
  quality!: string;
}

@tb_config(':tb/passive_combos')
export class PassiveComboCfgContainer extends TbContainer<PassiveComboCfg> {
  getTbName(): string { return PassiveComboCfg.name; }
}
