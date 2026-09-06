import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/** 成长曲线配置实体 */
export class GrowthCurveCfg {
  id!: number;
  code!: string;
  name!: string;
  growthPerLevel!: Record<string, number>;
}

@tb_config(':tb/growth_curves')
export class GrowthCurveCfgContainer extends TbContainer<GrowthCurveCfg> {
  getTbName(): string { return GrowthCurveCfg.name; }
}
