import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 肉鸽商店常量配置表（shop_constants.json，KV 结构）
 *
 * 数据源：策划配置（原设计见 docs/prd/肉鸽塔防_局内成长与经济系统.md §3，本表按现行口径覆盖）
 * 查询：ShopConfig.getNumber('drawCostBase') / ShopConfig.getArray('stageMaxByPhase') …
 *
 * 说明：JSON 顶层是「常量名 → 值」的对象，容器重写 handleData 转成一行一条。
 */

/** 常量值：数字 / 字符串 / 数组 / 对象 */
export type ShopConstValue = number | string | number[] | Record<string, any>;

export class ShopConstCfg {
    id!: number;
    /** 常量名 */
    key!: string;
    /** 常量名（与 key 相同，兼容 TbContainer.codeMap 查询） */
    code!: string;
    value!: ShopConstValue;
}

@tb_config(':tb/shop_constants')
export class ShopConstCfgContainer extends TbContainer<ShopConstCfg> {
    getTbName(): string { return 'ShopConstCfg'; }

    /** 重写 handleData 处理 KV 对象格式 */
    handleData(data: any): void {
        const obj = (data ?? {}) as Record<string, ShopConstValue>;
        this.cfgs = [];
        this.cfgMap.clear();
        this.codeMap.clear();
        this.size = 0;
        this.maxId = 0;
        this.minId = 0;

        let idx = 0;
        for (const key of Object.keys(obj)) {
            idx++;
            const cfg: ShopConstCfg = { id: idx, key, code: key, value: obj[key] };
            this.cfgs.push(cfg);
            this.cfgMap.set(cfg.id, cfg);
            this.codeMap.set(cfg.code, cfg);
        }
        this.size = this.cfgs.length;
        this.maxId = idx;
        this.minId = idx > 0 ? 1 : 0;
        this.afterHandle();
    }
}
