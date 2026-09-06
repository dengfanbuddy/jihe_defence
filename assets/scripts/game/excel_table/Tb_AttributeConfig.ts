import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import { AttributeStackMode } from '../battle/types';
import type { AttributeType } from '../battle/core/Types';

/**
 * 战斗属性配置表（attributes.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(AttributeCfgContainer).getCfgById(1)
 */
export interface AttributeCfg {
    id: AttributeType;        // 属性编号（与 AttributeType 枚举一致）
    name: string;             // 显示名
    stack_mode: AttributeStackMode; // 叠加方式：add/multiply/complement/best
    base: number;             // 初始基础值（可选，默认 0）
    min?: number;             // 最小值钳制（可选）
    max?: number;             // 最大值钳制（可选）
}

@tb_config(':tb/attributes')
export class AttributeCfgContainer extends TbContainer<AttributeCfg> {
  getTbName(): string { return 'AttributeCfg'; }
}
