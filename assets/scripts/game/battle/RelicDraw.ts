import { SHOP_RARITY_ORDER, ShopConfig, type ShopRarity } from '../data/configs/ShopConfig';
import type { RelicCfg } from '../excel_table/Tb_RelicConfig';

/** 一次抽取里的一个遗物候选（面板/流程只认它，不直接读配置表） */
export interface RelicOption {
    id: number;
    name: string;
    rarity: ShopRarity;
    /** 所属阶段 1~4（由品质推导） */
    stage: number;
    /** 展示用效果描述（relics.json 的局内版描述） */
    desc: string;
    icon?: string;
    /** 当前是否可选取（false → UI 置灰） */
    selectable: boolean;
    /** 置灰原因（日志/提示用） */
    reason?: string;
}

/**
 * RelicDraw —— **遗物抽取规则**（纯函数，无状态、无 cc 依赖）
 *
 * 只回答一个问题：「这一轮该出哪几件遗物」。花多少、能不能抽、抽完干什么，全部由
 * `RelicShop`（功能流程）决定；池子/权重/阶段门槛/费用口径全部来自配表（见 `ShopConfig`）。
 *
 * ── 规则口径（改表即改玩法，本文件不含任何数值）──
 *   · **先 roll 品质，再在同品质遗物里等权随机**（relics 表没有单件权重列，「权重随机」体现在品质档位上）
 *   · 品质权重随英雄等级变化（`shop_draw`：白/蓝/黄/红）
 *   · 阶段门槛：品质对应 stage 超过当前阶段上限时，按 `upgrade_chance` 决定是否越阶，否则降到本阶段最高品质
 *   · 本轮内不重复（`used` 集合），本局已拥有的不再出现（去重）
 *   · 池子抽干时逐级降级：目标品质（含越阶）→ 目标品质 → 阶段门槛内全池 → 全池；全都空了就少出一个槽位
 *
 * 费用 / 广告额度这类「商店级」规则也在这里读（`drawCost` / `adFreeDrawLimit` / `adExtraPickLimit`），
 * 目的是让 `RelicShop` 只跟本文件打交道，配置键名不散落在业务代码里。
 */
export class RelicDraw {

    /* ===================================================================
     * 商店级规则（薄封装 ShopConfig，业务只认这里的方法名）
     * =================================================================== */

    /** 一次刷新展示几个槽位（缺省 shop_constants.optionCount = 4） */
    static optionCount(): number {
        return Math.max(1, ShopConfig.getOptionCount());
    }

    /** 第 drawIndex 次付费刷新的费用（0 起；50 → 100 → … 封顶 200） */
    static drawCost(drawIndex: number): number {
        return ShopConfig.getDrawCost(Math.max(0, drawIndex));
    }

    /** 一局内可用的「广告免费刷新」次数（配置关闭时为 0） */
    static adFreeDrawLimit(): number {
        if (!ShopConfig.getBool('adFreeDrawEnabled', true)) return 0;
        return Math.max(0, ShopConfig.getNumber('adFreeDrawPerRun', 3));
    }

    /** 一轮抽取里可用的「广告补选」次数（配置关闭时为 0） */
    static adExtraPickLimit(): number {
        if (!ShopConfig.getBool('adExtraPickEnabled', true)) return 0;
        return Math.max(0, ShopConfig.getNumber('adExtraPickCount', 1));
    }

    /* ===================================================================
     * 抽取
     * =================================================================== */

    /**
     * 抽 count 个遗物候选。
     *
     * @param heroLevel 英雄等级（决定品质概率档位）
     * @param phase 当前阶段（1 起，决定 stage 门槛）
     * @param count 抽几个
     * @param owned 本局已拥有的遗物 id（去重）
     * @param pool 池子白名单（留空 = 配置里的商店遗物全池）
     */
    static roll(params: {
        heroLevel: number;
        phase: number;
        count: number;
        owned?: ReadonlySet<number> | number[];
        pool?: number[];
    }): RelicOption[] {
        const count = Math.max(0, Math.floor(params.count));
        if (count <= 0) return [];

        const owned = RelicDraw.toIdSet(params.owned);
        const weights = ShopConfig.getRarityWeights(params.heroLevel);
        const upgradeChance = ShopConfig.getUpgradeChance(params.heroLevel);
        const stageCap = ShopConfig.getStageCap(params.phase);
        const pool = RelicDraw.pool(params.pool, owned);

        const picked: RelicOption[] = [];
        const used = new Set<number>();

        for (let i = 0; i < count; i++) {
            let rarity = RelicDraw.rollRarity(weights);
            // 阶段门槛：超出当前阶段的品质，按 upgrade_chance 决定是否越阶，否则降到当前阶段最高品质
            if (ShopConfig.getStageOfRarity(rarity) > stageCap && Math.random() >= upgradeChance) {
                rarity = SHOP_RARITY_ORDER[Math.max(0, stageCap - 1)] ?? 'common';
            }
            const option = RelicDraw.pickCandidate(pool, rarity, stageCap, used);
            if (option) {
                used.add(option.id);
                picked.push(option);
            }
        }
        return picked;
    }

    /** 池子：配置里的商店遗物（有局内版）∩ 白名单 − 已拥有 */
    static pool(poolIds?: number[], owned?: ReadonlySet<number> | number[]): RelicCfg[] {
        const ownedSet = RelicDraw.toIdSet(owned);
        let all = ShopConfig.getRelics();
        if (poolIds && poolIds.length) {
            const allow = new Set(poolIds);
            all = all.filter((d) => allow.has(d.id));
        }
        return ownedSet.size ? all.filter((d) => !ownedSet.has(d.id)) : all;
    }

    /** 配置 → 候选（面板只认这个结构，不认识 RelicCfg） */
    static makeOption(def: RelicCfg, owned = false): RelicOption {
        return {
            id: def.id,
            name: def.name,
            rarity: def.rarity,
            // 遗物不落 stage 列：阶段由品质推导
            stage: ShopConfig.getStageOfRarity(def.rarity),
            desc: ShopConfig.getRelicDesc(def),
            icon: def.icon,
            selectable: !owned,
            reason: owned ? '本局已获得' : undefined,
        };
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    private static toIdSet(ids?: ReadonlySet<number> | number[]): Set<number> {
        if (!ids) return new Set<number>();
        if (ids instanceof Set) return new Set<number>(ids);
        return new Set<number>(ids);
    }

    /** 加权 roll 品质（权重与 SHOP_RARITY_ORDER 同序） */
    private static rollRarity(weights: number[]): ShopRarity {
        const total = weights.reduce((s, v) => s + Math.max(0, v), 0);
        if (total <= 0) return 'common';
        let r = Math.random() * total;
        for (let i = 0; i < weights.length; i++) {
            r -= Math.max(0, weights[i]);
            if (r <= 0) return SHOP_RARITY_ORDER[i] ?? 'common';
        }
        return SHOP_RARITY_ORDER[0];
    }

    /**
     * 取一个「指定品质」的候选（同品质等权）。
     * 依次降级：目标品质（含越阶后的 stage）→ 目标品质（无视 stage）→ 阶段门槛内全池 → 全池。
     * 池子抽干时返回 null，本轮槽位少一个（面板显示空槽）。
     */
    private static pickCandidate(pool: RelicCfg[], rarity: ShopRarity, stageCap: number, used: Set<number>): RelicOption | null {
        const candidates = (filter: (def: RelicCfg) => boolean): RelicOption[] =>
            pool
                .filter((def) => filter(def) && !used.has(def.id))
                .map((def) => RelicDraw.makeOption(def));

        const allowedStage = Math.max(stageCap, ShopConfig.getStageOfRarity(rarity));
        let list = candidates((d) => d.rarity === rarity && ShopConfig.getStageOfRarity(d.rarity) <= allowedStage);
        if (!list.length) list = candidates((d) => d.rarity === rarity);
        if (!list.length) list = candidates((d) => ShopConfig.getStageOfRarity(d.rarity) <= stageCap);
        if (!list.length) list = candidates(() => true);
        if (!list.length) return null;

        return list[Math.floor(Math.random() * list.length)] ?? null;
    }
}
