import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/** 元素效果配置实体 */
export class ElementEffectCfg {
  id!: number;
  code!: string;
  name!: string;
  elementType!: string;
  stackRule!: string;
  maxDuration!: number;
  tickDamageRatio?: number;
  tickInterval?: number;
  maxStacks?: number;
  slowPerStack?: number;
  freezeStacksRequired?: number;
  freezeDuration?: number;
  bounceCount?: number;
  bounceDamageRatio?: number;
  explosionRadius?: number;
  explosionDamageRatio?: number;
  executeThreshold?: number;
  executeDamageMultiplier?: number;
}

@tb_config(':tb/element_effects')
export class ElementEffectCfgContainer extends TbContainer<ElementEffectCfg> {
  getTbName(): string { return ElementEffectCfg.name; }
}
