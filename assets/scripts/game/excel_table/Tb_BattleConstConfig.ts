import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 战斗常量配置实体
 * 数据源 battle_constants.json 为 KV 对象格式，容器重写 handleData 转换
 */
export class BattleConstCfg {
  id!: number;
  code!: string;
  value!: number | string;
}

@tb_config(':tb/battle_constants')
export class BattleConstCfgContainer extends TbContainer<BattleConstCfg> {
  getTbName(): string { return BattleConstCfg.name; }

  /** 重写 handleData 处理 KV 对象格式 */
  handleData(data: any): void {
    const obj = data as Record<string, any>;
    this.cfgs = [];
    this.cfgMap.clear();
    this.codeMap.clear();
    this.size = 0;
    this.maxId = 0;
    this.minId = 0;

    let idx = 0;
    for (const key of Object.keys(obj)) {
      idx++;
      const cfg: BattleConstCfg = { id: idx, code: key, value: obj[key] };
      this.cfgs.push(cfg);
      this.cfgMap.set(cfg.id, cfg);
      this.codeMap.set(cfg.code, cfg);
    }
    this.size = this.cfgs.length;
    this.maxId = idx;
    this.minId = 1;
    this.afterHandle();
  }
}
