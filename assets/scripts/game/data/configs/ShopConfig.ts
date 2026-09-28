/**
 * ShopConfig.ts — 肉鸽商店配置门面
 *
 * 数据源：assets/resources/tb/ 下 5 张表（由 tools/excel_export 导表产出）
 *   - shop_constants.json  商店规则常量（KV：抽取费用/选项数/阶段门槛/广告次数/池权重）
 *   - shop_draw.json       品质抽取概率（按英雄等级段的 白/蓝/黄/红 权重 + 越阶概率）
 *   - relics.json          肉鸽商店道具（293 件，id 1001~1293）＝ 之前的「遗物」，效果由 modifiers 描述
 *   - shop_skills.json     肉鸽额外技能（30 个，3 级可升）
 *   - kill_buffs.json      击杀商店 Buff（20 个，可重复购买、价格递增）
 *
 * 道具（遗物）的属性加成统一走 Modifier 管线：
 *   遗物条目引用「属性修改」共享模板（`MODIFY_ATTR_TEMPLATE_ID`），自己的属性与数值写在 `kv.attrs` 里 ——
 *   `percent`（对**英雄基础属性**的百分比加成，同类加法叠加后乘算一次）或 `add`（固定值）；
 *   带 `cd` 的被动各是一条独立 Modifier，**每个被动各算各的冷却**。
 *
 * 设计稿 → 配表的生成脚本：tools/excel_export/scripts/gen-shop-from-hero-design.ts
 *
 * 容错：配置表未加载完成时返回内置默认值，保证早期调用安全（与 BattleConstUtil 一致）。
 *
 * 用法：
 *   ShopConfig.getNumber('drawCostBase')                    // 50
 *   ShopConfig.getArray('stageMaxByPhase')                  // [1,2,3,4]
 *   ShopConfig.getDrawBand(heroLevel)                       // ShopDrawCfg
 *   ShopConfig.getRelics()                                  // RelicCfg[]（含 293 件道具）
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
import { RelicCfgContainer, relicHasInner, relicInnerDesc } from '../../excel_table/Tb_RelicConfig';
import type { RelicCfg, RelicRarity } from '../../excel_table/Tb_RelicConfig';
import { ShopSkillCfgContainer } from '../../excel_table/Tb_ShopSkillConfig';
import type { ShopSkillCfg } from '../../excel_table/Tb_ShopSkillConfig';
import { KillBuffCfgContainer } from '../../excel_table/Tb_KillBuffConfig';
import type { KillBuffCfg } from '../../excel_table/Tb_KillBuffConfig';
import { ShopDrawCfgContainer } from '../../excel_table/Tb_ShopDrawConfig';
import type { ShopDrawCfg } from '../../excel_table/Tb_ShopDrawConfig';
import { ShopConstCfgContainer } from '../../excel_table/Tb_ShopConstConfig';
import type { ShopConstValue } from '../../excel_table/Tb_ShopConstConfig';

/** 品质顺序（stage 默认同序） */
export const SHOP_RARITY_ORDER: ShopRarity[] = ['common', 'rare', 'epic', 'legendary'];

/** 商店内容（道具/技能）的品质：白/蓝/黄/红（与 relics.rarity 同源） */
export type ShopRarity = RelicRarity;

/** 道具（遗物）id 段：1000 + 设计稿道具 id（1294 起是**只有局外版**的遗物，不进商店池，靠 scope 过滤） */
export const SHOP_RELIC_ID_MIN = 1001;
export const SHOP_RELIC_ID_MAX = 1293;

/** 内置默认值（与 shop_constants.json 保持一致，容器不可用时兜底） */
const DEFAULTS: Record<string, ShopConstValue> = {
    optionCount: 4,
    pickCount: 1,
    drawCostBase: 50,
    drawCostStep: 50,
    drawCostCap: 200,
    drawCostResetEachPhase: 0,
    stageMaxByPhase: [1, 2, 3, 4],
    relicSkillPoolWeight: { relic: 1, skill: 1 },
    guaranteeSkillPerDraw: 1,
    duplicateSkillUpgrade: 1,
    maxSkillSlots: 3,
    adFreeDrawEnabled: 1,
    adFreeDrawPerRun: 3,
    adExtraPickEnabled: 1,
    adExtraPickCount: 1,
    adRefreshEnabled: 0,
    killBuffPriceGrowth: 1.35,
    killBuffMaxStackDefault: 10,
};

/** 容器未就绪时读取常量（每次查询都会尝试重新取容器，加载完成后自动生效） */
function pick<T>(getter: () => T | undefined, fallback: T): T {
    try {
        const v = getter();
        return v === undefined ? fallback : v;
    } catch {
        return fallback;
    }
}

export class ShopConfig {
    // ============ 常量（shop_constants） ============

    /** 读取原始常量值（容器不可用时回落到内置默认值） */
    static get(key: string): ShopConstValue | undefined {
        try {
            const cfg = TbRoot.ins.getTbContainer(ShopConstCfgContainer).getCfgByCode(key);
            if (cfg && cfg.value !== undefined && cfg.value !== null) return cfg.value;
        } catch {
            // 容器未加载
        }
        return DEFAULTS[key];
    }

    /** 读取数值常量 */
    static getNumber(key: string, defaultValue?: number): number {
        const v = ShopConfig.get(key);
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
        return defaultValue ?? 0;
    }

    /** 读取布尔常量（1/true 视为真） */
    static getBool(key: string, defaultValue = false): boolean {
        const v = ShopConfig.get(key);
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return ['1', 'true', 'yes', '是'].includes(v.toLowerCase());
        return defaultValue;
    }

    /** 读取数组常量（非数组时返回默认值） */
    static getArray(key: string, defaultValue: number[] = []): number[] {
        const v = ShopConfig.get(key);
        return Array.isArray(v) ? (v as number[]) : defaultValue;
    }

    /** 读取对象常量（非对象时返回默认值） */
    static getObject(key: string, defaultValue: Record<string, any> = {}): Record<string, any> {
        const v = ShopConfig.get(key);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : defaultValue;
    }

    // ============ 抽取规则快捷读取 ============

    /** 每次抽取展示的选项数 */
    static getOptionCount(): number { return ShopConfig.getNumber('optionCount', 4); }
    /** 每次抽取可选择的选项数（选 1 后其余置灰） */
    static getPickCount(): number { return Math.max(1, ShopConfig.getNumber('pickCount', 1)); }
    /** 抽取费用上限 */
    static getDrawCostCap(): number { return ShopConfig.getNumber('drawCostCap', 200); }

    /** 第 drawIndex 次抽取的费用（drawIndex 从 0 开始）：clamp(base + step×n, …, cap) */
    static getDrawCost(drawIndex: number): number {
        const base = ShopConfig.getNumber('drawCostBase', 50);
        const step = ShopConfig.getNumber('drawCostStep', 50);
        const cap = ShopConfig.getDrawCostCap();
        const raw = base + step * Math.max(0, drawIndex);
        return cap > 0 ? Math.min(raw, cap) : raw;
    }

    /** 第 phase 阶段（1 起）可抽取的最高 stage */
    static getStageCap(phase: number): number {
        const arr = ShopConfig.getArray('stageMaxByPhase', [1, 2, 3, 4]);
        if (!arr.length) return SHOP_RARITY_ORDER.length;
        const idx = Math.max(0, Math.min(arr.length - 1, (phase || 1) - 1));
        return arr[idx];
    }

    /** 品质对应的默认 stage（与 shop_items/shop_skills 的 stage 列同序，缺省下两者一致） */
    static getStageOfRarity(rarity: ShopRarity): number {
        const i = SHOP_RARITY_ORDER.indexOf(rarity);
        return i >= 0 ? i + 1 : 1;
    }

    // ============ 品质抽取概率（shop_draw） ============

    /** 按英雄等级取品质概率档位 */
    static getDrawBand(heroLevel: number): ShopDrawCfg | undefined {
        try {
            return TbRoot.ins.getTbContainer(ShopDrawCfgContainer).getBandByLevel(heroLevel);
        } catch {
            return undefined;
        }
    }

    /** 品质权重表 [common, rare, epic, legendary]（容器不可用时回落到设计稿 Lv.1-9 档） */
    static getRarityWeights(heroLevel: number): number[] {
        const band = ShopConfig.getDrawBand(heroLevel);
        if (!band) return [55, 30, 12, 3];
        return SHOP_RARITY_ORDER.map(r => Number((band as any)[r] ?? 0));
    }

    /** 越阶概率（0~1）：抽到「下一阶段」内容的概率 */
    static getUpgradeChance(heroLevel: number): number {
        const band = ShopConfig.getDrawBand(heroLevel);
        return band ? (band.upgrade_chance ?? 0) / 100 : 0.15;
    }

    // ============ 内容表 ============

    /**
     * 商店道具池 = relics.json 里**有局内版**的遗物（`scope` = `inner` / `both`，id 1001~1293，293 件，由设计稿迁移而来）。
     *
     * ⚠ 2026-07 起 relics 表是「一件遗物一行」：局内版 / 局外版共用 id 与品质，
     * 只是 `modifiers_inner` / `modifiers_outer` 分两侧。因此**必须按 scope 过滤**，
     * 否则只有局外版的遗物（id 1294~1302）会混进局内商店抽取池。
     * id < 1000 的手工遗物是 demo 内容，同样不进商店池。
     */
    static getRelics(): RelicCfg[] {
        return pick(() => TbRoot.ins.getTbContainer(RelicCfgContainer).cfgs, [])
            .filter(r => relicHasInner(r))
            .filter(r => r.id >= SHOP_RELIC_ID_MIN);
    }

    /** 按 id 取商店道具（遗物） */
    static getRelic(id: number): RelicCfg | undefined {
        return pick(() => TbRoot.ins.getTbContainer(RelicCfgContainer).getCfgById(id), undefined);
    }

    /** 道具的展示文案（取**局内版**描述：遗物的一条 effect 总述） */
    static getRelicDesc(cfg: RelicCfg): string {
        return relicInnerDesc(cfg);
    }

    /** 全部肉鸽额外技能 */
    static getShopSkills(): ShopSkillCfg[] {
        return pick(() => TbRoot.ins.getTbContainer(ShopSkillCfgContainer).cfgs, []);
    }

    static getShopSkill(id: number): ShopSkillCfg | undefined {
        return pick(() => TbRoot.ins.getTbContainer(ShopSkillCfgContainer).getCfgById(id), undefined);
    }

    /** 全部击杀商店 Buff */
    static getKillBuffs(): KillBuffCfg[] {
        return pick(() => TbRoot.ins.getTbContainer(KillBuffCfgContainer).cfgs, []);
    }

    static getKillBuff(id: number): KillBuffCfg | undefined {
        return pick(() => TbRoot.ins.getTbContainer(KillBuffCfgContainer).getCfgById(id), undefined);
    }

    /** 击杀商店 Buff 第 stack 层（1 起）的购买价格；stack 越界时按最高层价格 */
    static getKillBuffPrice(cfg: KillBuffCfg, stack: number): number {
        try {
            return TbRoot.ins.getTbContainer(KillBuffCfgContainer).getPriceAt(cfg, stack);
        } catch {
            const growth = cfg.price_growth ?? ShopConfig.getNumber('killBuffPriceGrowth', 1.35);
            return Math.ceil(cfg.price * Math.pow(growth, Math.max(1, stack) - 1));
        }
    }

    /** 技能在指定等级下的效果描述 */
    static getSkillLevelDesc(cfg: ShopSkillCfg, level: number): string {
        const lv = Math.max(1, Math.min(cfg.max_level || 1, level));
        return (lv >= 3 ? cfg.lv3 : lv === 2 ? cfg.lv2 : cfg.lv1) ?? cfg.lv1;
    }
}
