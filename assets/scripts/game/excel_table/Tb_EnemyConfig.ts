import { ITbDecode } from '../../platform/excel_table/ITbDecode';
import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { TbRoot } from '../../platform/excel_table/TbRoot';


export class EnemyCfg {
  id!: number;
  code!: string;
  name!: string;
  category!: string;
  attributes!: Record<string, number>;
  expReward!: number;
  goldReward!: number;
  attackRange!: number;
  skillIds?: string[];
  healAmount?: number;
  healInterval?: number;
}


@tb_config(':tb/enemies')
export class EnemyCfgContainer extends TbContainer<EnemyCfg> {
  getTbName(): string {
    return EnemyCfg.name
  }


}

