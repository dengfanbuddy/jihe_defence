/**
 * ShopConfig.ts — 肉鸽商店配置门面
 *
 * 数据源：assets/resources/tb/ 下 5 张表（由 tools/excel_export 导表产出）
 *   - shop_constants.json  商店规则常量（KV：抽取费用/选项数/阶段门槛/广告次数/池权重）
 *   - shop_draw.json       品质抽取概率（按英雄等级段的 白/蓝/黄/红 权重 + 越阶概率）
 *   - relics.json          肉鸽商店道具（293 件，id 1001~1293）＝ 之前的「遗物」，效果由 modifiers 描述
 *   - abilities.json       技能表（**含肉鸽额外技能 30 个，scope=shop，id 101~130**；原 shop_skills 表已并入）
 *   - kill_buffs.json      **神器**（20 个，永久、可叠层、每层价格 ×price_growth 递增）——
 *                          名字是旧称，语义见 docs/artifact-drop/README.md
 *   - battle_items.json    局内**掉落 Buff**（14 件限时道具，阶段 Boss 掉进 6 格小背包；与神器是两条轨）
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
// 肉鸽额外技能已并入 abilities 表（scope=shop）——独立表与容器 `Tb_ShopSkillConfig` 已删除，勿恢复
import { AbilityCfgContainer, abilityInShop, abilityLevelDesc, abilityMaxLevel } from '../../excel_table/Tb_AbilityConfig';
import type { AbilityCfg } from '../../excel_table/Tb_AbilityConfig';
import { KillBuffCfgContainer } from '../../excel_table/Tb_KillBuffConfig';
import type { KillBuffCfg } from '../../excel_table/Tb_KillBuffConfig';
import { BattleItemCfgContainer } from '../../excel_table/Tb_BattleItemConfig';
import type { BattleItemCfg } from '../../excel_table/Tb_BattleItemConfig';
import { ShopDrawCfgContainer } from '../../excel_table/Tb_ShopDrawConfig';
import type { ShopDrawCfg } from '../../excel_table/Tb_ShopDrawConfig';
import { ShopConstCfgContainer } from '../../excel_table/Tb_ShopConstConfig';
import type { ShopConstValue } from '../../excel_table/Tb_ShopConstConfig';

/** 品质顺序（stage 默认同序） */
export const SHOP_RARITY_ORDER: ShopRarity[] = ['common', 'rare', 'epic', 'legendary'];

/** 商店内容（道具/技能）的品质：白/蓝/黄/红（与 relics.rarity 同源） */
export type ShopRarity = RelicRarity;

/** 道具（遗物）id 段：1000 + 设计稿道具 id（`scope` 含 `outer` 的件**局内局外同一批**，商店池只认"有局内版"） */
export const SHOP_RELIC_ID_MIN = 1001;
export const SHOP_RELIC_ID_MAX = 1293;

/** 肉鸽额外技能 id 段：100 + 设计稿技能 id（101~130；单位技能在 1~99，互不重叠） */
export const SHOP_SKILL_ID_MIN = 101;
export const SHOP_SKILL_ID_MAX = 130;

/** 内置默认值（与 shop_constants.json 保持一致，容器不可用时兜底） */
const DEFAULTS: Record<string, ShopConstValue> = {
    optionCount: 4,
    pickCount: 1,
    drawCostBase: 50,
    drawCostStep: 25,
    // 0 = **不封顶**（2026-11：原来是 200，抽到第 7 次之后就一直是 200，等于"费用不再涨"。
    // 改不封顶后单局可抽次数由 ~48 降到 ~25，局内滚雪球跟着慢下来 ——
    // 这条本来也是 `docs/局内刷怪节奏设计.md` §12.6 的建议值）
    drawCostCap: 0,
    drawCostResetEachPhase: 0,
    stageMaxByPhase: [1, 2, 3, 4],
    skillMaxPerDraw: 2,
    skillDrawChance: 20,
    skillCountWeight: { '1': 70, '2': 30 },
    duplicateSkillUpgrade: 1,
    maxSkillSlots: 3,
    adFreeDrawEnabled: 1,
    adFreeDrawPerRun: 3,
    adExtraPickEnabled: 1,
    adExtraPickCount: 1,
    adRefreshEnabled: 0,
    killBuffPriceGrowth: 1.35,
    killBuffMaxStackDefault: 10,
    killBuffRefreshCost: 50,
    killBuffRefreshCostStep: 25,
    killBuffRefreshCostCap: 200,
    killBuffFreeRefreshPerRun: 1,
    killBuffRefreshAdFreePerRun: 1,
    heroSelectRefreshCost: 100,
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
    /** 抽取费用上限（**0 = 不封顶**；见 `DEFAULTS.drawCostCap` 的说明） */
    static getDrawCostCap(): number { return ShopConfig.getNumber('drawCostCap', 0); }

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
     * 否则只有局外版的遗物（`scope='outer'`；2026-11 起表里已经没有）会混进局内商店抽取池。
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

    /**
     * 肉鸽额外技能池 = `abilities.json` 里 **scope 含 shop** 的技能（id 101~130，30 个）。
     *
     * ⚠ 2026-09 起技能不分表：单位技能与肉鸽技能同一张 `abilities.json`，
     * 靠 `scope`（unit / shop / both）区分归属，所以这里**必须按 scope 过滤**，
     * 否则英雄自带的技能（火球术、鹰眼瞄准…）会混进商店抽取池。
     */
    static getShopSkills(): AbilityCfg[] {
        return pick(() => TbRoot.ins.getTbContainer(AbilityCfgContainer).cfgs, [])
            .filter(abilityInShop);
    }

    /** 按 id 取肉鸽技能（id 不在商店池里返回 undefined） */
    static getShopSkill(id: number): AbilityCfg | undefined {
        return pick(() => {
            const cfg = TbRoot.ins.getTbContainer(AbilityCfgContainer).getCfgById(id);
            return cfg && abilityInShop(cfg) ? cfg : undefined;
        }, undefined);
    }

    /** 任意技能（含单位技能）——详情面板按 id 查它拿名字/图标/描述 */
    static getAbility(id: number): AbilityCfg | undefined {
        return pick(() => TbRoot.ins.getTbContainer(AbilityCfgContainer).getCfgById(id), undefined);
    }

    /** 技能的最高等级（1~3；单位技能为 1） */
    static getSkillMaxLevel(cfg: AbilityCfg): number {
        return abilityMaxLevel(cfg);
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

    /**
     * 第 `refreshIndex` 次**付费**神器的刷新费用（`refreshIndex` 从 0 开始）：
     * `clamp(base + step × n, …, cap)` —— 公式与 `getDrawCost`（遗物抽取那套）**逐字同形**，
     * 因为两个商店的刷新按钮共用同一个面板判据与同一套玩家预期。
     *
     * ⚠ 三层口径（改这里之前先看 `docs/artifact-drop/README.md` §12）：
     *   ① 只有**付费**刷新推进 `refreshIndex` —— 免费刷新（开局白送）与广告刷新**都不抬价**，
     *      否则"白送的那一次"会当场把后续单价顶高一档；
     *   ② 封的是**单价**不是**次数** —— 玩家要的"刷新次数无上限"照旧（无尽模式靠这条）；
     *   ③ `cap <= 0` = 不封顶（与 `getDrawCostCap` 同口径）。
     */
    static getKillBuffRefreshCost(refreshIndex: number): number {
        const base = ShopConfig.getNumber('killBuffRefreshCost', 50);
        const step = ShopConfig.getNumber('killBuffRefreshCostStep', 25);
        const cap = ShopConfig.getNumber('killBuffRefreshCostCap', 200);
        const raw = base + step * Math.max(0, refreshIndex);
        return cap > 0 ? Math.min(raw, cap) : raw;
    }

    /** 每局**开局白送**的神器免费刷新次数（`killBuffFreeRefreshPerRun`；0 = 不白送） */
    static getKillBuffFreeRefreshPerRun(): number {
        return Math.max(0, ShopConfig.getNumber('killBuffFreeRefreshPerRun', 1));
    }

    /** 技能在指定等级下的效果描述（lv1/lv2/lv3 逐级回落；全空返回 ''） */
    static getSkillLevelDesc(cfg: AbilityCfg, level: number): string {
        return abilityLevelDesc(cfg, level);
    }

    /* ===================================================================
     * 局内掉落 Buff（`battle_items.json`）—— 阶段 Boss 掉落、进 6 格小背包
     *
     * ⚠ 与上面的「击杀商店 Buff（神器）」是**两条轨**：
     *   神器 = 永久 + 可叠层 + 花击杀数买刷新；掉落 Buff = **限时 + 一次性消耗 + 打 Boss 掉**。
     *   见 `docs/artifact-drop/README.md`。
     * =================================================================== */

    /** 全部掉落 Buff */
    static getBattleItems(): BattleItemCfg[] {
        return pick(() => TbRoot.ins.getTbContainer(BattleItemCfgContainer).cfgs, []);
    }

    static getBattleItem(id: number): BattleItemCfg | undefined {
        return pick(() => TbRoot.ins.getTbContainer(BattleItemCfgContainer).getCfgById(id), undefined);
    }

    /** 掉落 Buff 的权重（`weight` 缺省 1；`<= 0` = 配了但不投放） */
    static getBattleItemWeight(cfg: BattleItemCfg): number {
        try {
            return TbRoot.ins.getTbContainer(BattleItemCfgContainer).weightOf(cfg);
        } catch {
            const w = cfg?.weight ?? 1;
            return Number.isFinite(w) && w > 0 ? w : 0;
        }
    }
}
