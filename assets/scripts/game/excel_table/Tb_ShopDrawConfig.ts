import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 肉鸽品质抽取概率表（shop_draw.json）
 *
 * 数据源：设计稿 docs/hero-design/assets/data-draw.js（按英雄等级段的白/蓝/黄/红概率）
 * 生成：node tools/excel_export/scripts/gen-shop-from-hero-design.ts
 *
 * 查询：TbRoot.ins.getTbContainer(ShopDrawCfgContainer).getBandByLevel(heroLevel)
 */
export interface ShopDrawCfg {
    id: number;
    /** 档位说明（如「英雄 Lv.1-9」） */
    band: string;
    level_min: number;
    level_max: number;
    /** 白（普通）权重 % */
    common: number;
    /** 蓝（稀有）权重 % */
    rare: number;
    /** 黄（史诗）权重 % */
    epic: number;
    /** 红（传说）权重 % */
    legendary: number;
    /**
     * 越阶概率 %：抽到 stage > 当前阶段 的「下一阶段」内容的概率。
     * 判定基准阶段见 shop_constants.stageMaxByPhase。
     */
    upgrade_chance: number;
}

@tb_config(':tb/shop_draw')
export class ShopDrawCfgContainer extends TbContainer<ShopDrawCfg> {
    getTbName(): string { return 'ShopDrawCfg'; }

    /** 按英雄等级取档位（越界时取最近档：低于最低用首档，高于最高用末档） */
    getBandByLevel(heroLevel: number): ShopDrawCfg | undefined {
        const lv = heroLevel || 1;
        for (const cfg of this.cfgs) {
            if (lv >= cfg.level_min && lv <= cfg.level_max) return cfg;
        }
        const sorted = [...this.cfgs].sort((a, b) => a.level_min - b.level_min);
        if (!sorted.length) return undefined;
        return lv < sorted[0].level_min ? sorted[0] : sorted[sorted.length - 1];
    }
}
