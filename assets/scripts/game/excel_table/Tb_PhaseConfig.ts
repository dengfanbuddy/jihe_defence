import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/* eslint-disable @typescript-eslint/no-unused-vars */

/** 波次入口 */
export interface WaveSpawnEntry {
  enemyId: string;
  count: number;
  interval?: number;
}

/** 波次配置 */
export interface WaveConfig {
  waveIndex: number;
  spawnInterval: number;
  enemies: WaveSpawnEntry[];
}

/** 阶段配置实体 */
export class PhaseCfg {
  id!: number;
  code!: string;
  name!: string;
  duration!: number;
  difficultyMultiplier!: number;
  waves!: WaveConfig[];
}

@tb_config(':tb/phases')
export class PhaseCfgContainer extends TbContainer<PhaseCfg> {
  getTbName(): string { return PhaseCfg.name; }
}
