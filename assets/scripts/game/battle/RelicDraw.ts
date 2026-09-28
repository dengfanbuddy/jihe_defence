import { SHOP_RARITY_ORDER, ShopConfig, type ShopRarity } from '../data/configs/ShopConfig';
import type { RelicCfg } from '../excel_table/Tb_RelicConfig';
import { abilityInShop, abilityLevelDesc, abilityMaxLevel } from '../excel_table/Tb_AbilityConfig';
import type { AbilityCfg } from '../excel_table/Tb_AbilityConfig';

/** 候选的种类：遗物（道具）或肉鸽额外技能 */
export type ShopOptionKind = 'relic' | 'skill';

/**
 * 一次抽取里的一个候选（面板/流程只认它，不直接读配置表）。
 *
 * 遗物与技能**共用同一个结构**：因为一次刷新是混合池，4 个格子里两种都可能出现，
 * 面板不该为「这格是遗物还是技能」写两条渲染路径 —— 认 `kind` 分流即可。
 */
export interface ShopOption {
    kind: ShopOptionKind;
    /** 遗物 id（1001~1293）或技能 id（101~130）——两段不重叠，所以「只用一个数字」也能唯一定位 */
    id: number;
    name: string;
    rarity: ShopRarity;
    /** 抽取用的阶段门槛（遗物由品质推导，技能读自己的 stage 列） */
    stage: number;
    /** 展示用效果描述（遗物=局内版描述；技能=当前等级那档文案） */
    desc: string;
    icon?: string;
    /** 当前是否可选取（false → UI 置灰） */
    selectable: boolean;
    /** 置灰原因（日志/提示用） */
    reason?: string;
    /** 技能专用：当前**已拥有**的等级（0 = 还没拥有；>0 表示这次选中是「升级」） */
    level: number;
    /** 技能专用：最高等级（1~3）；遗物恒为 1 */
    maxLevel: number;
}

/**
 * RelicDraw —— **肉鸽商店抽取规则**（纯函数，无状态、无 cc 依赖）
 *
 * 只回答一个问题：「这一轮该出哪几个候选」。花多少、能不能抽、抽完干什么，全部由
 * `RelicShop`（功能流程）决定；池子/权重/阶段门槛/费用口径全部来自配表（见 `ShopConfig`）。
 *
 * ── 规则口径（改表即改玩法，本文件不含任何数值）──
 *   · 池子是**混合池**：遗物（relics.json 有局内版的那些）+ 肉鸽额外技能（abilities.json 里 scope=shop）
 *   · **先 roll 品质，再在同品质里按种类加权 + 同种类等权/权重随机**
 *     （遗物没有单件权重列 → 等权；技能读自己的 `weight` 列）
 *   · 种类之间按 `shop_constants.relicSkillPoolWeight` 加权（默认遗物 1 : 技能 1）
 *   · 品质权重随英雄等级变化（`shop_draw`：白/蓝/黄/红）
 *   · 阶段门槛：品质对应 stage 超过当前阶段上限时，按 `upgrade_chance` 决定是否越阶，否则降到本阶段最高品质
 *   · 本轮内不重复；遗物本局唯一（已拥有不再出）；**技能满级后才不出**（没满级仍会出现 = 可升级）
 *   · **技能保底** `guaranteeSkillPerDraw`：一轮里技能少于该数时，把遗物候选换成技能（池子空了就放弃）
 *   · 池子抽干时补位：先阶段内全品质、再全池；全都空了就少出一个槽位
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

    /** 混合池的种类权重（`shop_constants.relicSkillPoolWeight`） */
    static poolWeight(kind: ShopOptionKind): number {
        const w = ShopConfig.getObject('relicSkillPoolWeight', { relic: 1, skill: 1 });
        const v = Number(w[kind]);
        return Number.isFinite(v) && v >= 0 ? v : 1;
    }

    /** 一轮里至少给几个技能候选（`shop_constants.guaranteeSkillPerDraw`；0 = 不保底） */
    static skillGuarantee(): number {
        return Math.max(0, Math.floor(ShopConfig.getNumber('guaranteeSkillPerDraw', 0)));
    }

    /* ===================================================================
     * 池子
     * =================================================================== */

    /**
     * 遗物池：配置里的商店遗物（**有局内版**）∩ 白名单 − 已拥有。
     *
     * ⚠ relics 表是「一件遗物一行」（局内版 / 局外版共用 id 与品质），所以**必须按 scope 过滤**，
     *   否则只有局外版的遗物（id 1294~1302）会混进局内商店抽取池。
     */
    static relicPool(poolIds?: number[], owned?: ReadonlySet<number> | number[]): RelicCfg[] {
        const ownedSet = RelicDraw.toIdSet(owned);
        let all = ShopConfig.getRelics();
        if (poolIds && poolIds.length) {
            const allow = new Set(poolIds);
            all = all.filter((d) => allow.has(d.id));
        }
        return ownedSet.size ? all.filter((d) => !ownedSet.has(d.id)) : all;
    }

    /** 技能池：`abilities.json` 里 scope 含 shop 的那些（单位技能不参与抽取） */
    static skillPool(): AbilityCfg[] {
        return ShopConfig.getShopSkills().filter(abilityInShop);
    }

    /** 配置 → 遗物候选 */
    static makeRelicOption(def: RelicCfg, owned = false): ShopOption {
        return {
            kind: 'relic',
            id: def.id,
            name: def.name,
            rarity: def.rarity,
            // 遗物不落 stage 列：阶段由品质推导
            stage: ShopConfig.getStageOfRarity(def.rarity),
            desc: ShopConfig.getRelicDesc(def),
            icon: def.icon,
            selectable: !owned,
            reason: owned ? '本局已获得' : undefined,
            level: 0,
            maxLevel: 1,
        };
    }

    /**
     * 配置 → 技能候选。
     * @param ownedLevel 这个技能**当前已拥有的等级**（0 = 没拥有）；描述与「升级」提示都按它算
     */
    static makeSkillOption(def: AbilityCfg, ownedLevel = 0): ShopOption {
        const maxLevel = abilityMaxLevel(def);
        const level = Math.max(0, Math.min(maxLevel, Math.floor(ownedLevel) || 0));
        const shownLevel = level > 0 ? level : 1;
        return {
            kind: 'skill',
            id: def.id,
            name: def.name,
            rarity: def.rarity ?? 'common',
            stage: def.stage ?? 1,
            desc: abilityLevelDesc(def, shownLevel),
            icon: def.icon,
            // 技能永远可选：没拥有 = 学一个，已拥有且没满级 = 升一级
            selectable: true,
            reason: undefined,
            level,
            maxLevel,
        };
    }

    /* ===================================================================
     * 抽取
     * =================================================================== */

    /**
     * 抽 count 个候选（遗物 + 技能混合池）。
     *
     * @param heroLevel 英雄等级（决定品质概率档位）
     * @param phase 当前阶段（1 起，决定 stage 门槛）
     * @param count 抽几个
     * @param ownedRelics 本局已拥有的**遗物** id（去重）
     * @param ownedSkills 本局已拥有的**技能** id → 等级（满级的才从池里去掉）
     * @param pool 遗物池白名单（留空 = 配置里的商店遗物全池）
     */
    static roll(params: {
        heroLevel: number;
        phase: number;
        count: number;
        ownedRelics?: ReadonlySet<number> | number[];
        ownedSkills?: ReadonlyMap<number, number> | Record<number, number>;
        pool?: number[];
    }): ShopOption[] {
        const count = Math.max(0, Math.floor(params.count));
        if (count <= 0) return [];

        const ownedRelics = RelicDraw.toIdSet(params.ownedRelics);
        const ownedSkills = RelicDraw.toLevelMap(params.ownedSkills);
        const weights = ShopConfig.getRarityWeights(params.heroLevel);
        const upgradeChance = ShopConfig.getUpgradeChance(params.heroLevel);
        const stageCap = ShopConfig.getStageCap(params.phase);

        const relicPool = RelicDraw.relicPool(params.pool, ownedRelics);
        const skillPool = RelicDraw.skillPool();

        const picked: ShopOption[] = [];
        const usedRelic = new Set<number>();
        const usedSkill = new Set<number>();

        /** 当前品质/阶段下可用候选（分种类；技能满级的不算候选） */
        const candidates = (rarity: ShopRarity | null, allowedStage: number, allRarities: boolean): Record<ShopOptionKind, ShopOption[]> => {
            const relics = relicPool
                .filter((d) => (allRarities || d.rarity === rarity)
                    && ShopConfig.getStageOfRarity(d.rarity) <= allowedStage
                    && !usedRelic.has(d.id))
                .map((d) => RelicDraw.makeRelicOption(d));
            const skills = skillPool
                .filter((s) => (allRarities || s.rarity === rarity)
                    && (s.stage ?? 1) <= allowedStage
                    && !usedSkill.has(s.id)
                    && (ownedSkills.get(s.id) ?? 0) < abilityMaxLevel(s))
                .map((s) => RelicDraw.makeSkillOption(s, ownedSkills.get(s.id) ?? 0));
            return { relic: relics, skill: skills };
        };

        /** 按种类权重 + 种类内权重取一个候选（种类全空返回 null） */
        const pickFrom = (byKind: Record<ShopOptionKind, ShopOption[]>): ShopOption | null => {
            const kinds = (['relic', 'skill'] as ShopOptionKind[]).filter((k) => byKind[k].length > 0);
            if (!kinds.length) return null;
            const kindWeights = kinds.map((k) => ({ k, w: RelicDraw.poolWeight(k) }));
            const positive = kindWeights.filter((x) => x.w > 0);
            const chosen = RelicDraw.pickWeighted(positive.length ? positive : kindWeights)?.k ?? kinds[0];
            // 遗物同品质等权（表里没有单件权重列）；技能读自己的 weight 列
            const list = byKind[chosen];
            const weighted = chosen === 'skill'
                ? list.map((o) => ({ o, w: RelicDraw.skillWeight(o.id) }))
                : list.map((o) => ({ o, w: 1 }));
            const hit = RelicDraw.pickWeighted(weighted)?.o ?? list[0];
            if (hit.kind === 'relic') usedRelic.add(hit.id);
            else usedSkill.add(hit.id);
            return hit;
        };

        // ① 主循环：先 roll 品质，再在同品质里混合取
        for (let i = 0; i < count; i++) {
            let rarity = RelicDraw.rollRarity(weights);
            // 阶段门槛：超出当前阶段的品质，按 upgrade_chance 决定是否越阶，否则降到当前阶段最高品质
            if (ShopConfig.getStageOfRarity(rarity) > stageCap && Math.random() >= upgradeChance) {
                rarity = SHOP_RARITY_ORDER[Math.max(0, stageCap - 1)] ?? 'common';
            }
            const allowedStage = Math.max(stageCap, ShopConfig.getStageOfRarity(rarity));
            const option = pickFrom(candidates(rarity, allowedStage, false));
            if (option) picked.push(option);
        }

        // ② 技能保底：技能不够就把遗物候选换成技能（池子空了就放弃，不硬塞）
        const guarantee = RelicDraw.skillGuarantee();
        let skillCount = picked.filter((p) => p.kind === 'skill').length;
        while (skillCount < guarantee) {
            const pool = skillPool.filter((s) => (s.stage ?? 1) <= stageCap
                && !usedSkill.has(s.id)
                && (ownedSkills.get(s.id) ?? 0) < abilityMaxLevel(s));
            if (!pool.length) break;
            const at = picked.map((p) => p.kind).lastIndexOf('relic');
            if (at < 0) break; // 没有遗物可选可换（已经全是技能 / 一个都没抽出来）
            const evicted = picked[at];
            usedRelic.delete(evicted.id);
            const skill = RelicDraw.pickWeighted(pool.map((s) => ({ o: s, w: s.weight ?? 1 })))?.o ?? pool[0];
            usedSkill.add(skill.id);
            picked[at] = RelicDraw.makeSkillOption(skill, ownedSkills.get(skill.id) ?? 0);
            skillCount++;
        }

        // ③ 补位：主循环因池子变窄少抽了格子时，忽略品质先阶段内后全池补齐
        for (let guard = 0; picked.length < count && guard < count * 2; guard++) {
            const inStage = pickFrom(candidates(null, stageCap, true));
            const option = inStage ?? pickFrom(candidates(null, SHOP_RARITY_ORDER.length, true));
            if (!option) break;
            picked.push(option);
        }

        return picked;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    private static toIdSet(ids?: ReadonlySet<number> | number[]): Set<number> {
        if (!ids) return new Set<number>();
        if (ids instanceof Set) return new Set<number>(ids);
        return new Set<number>(ids);
    }

    /** 「已拥有技能 → 等级」归一成 Map（数组/普通对象都收） */
    private static toLevelMap(src?: ReadonlyMap<number, number> | Record<number, number>): Map<number, number> {
        if (!src) return new Map<number, number>();
        if (src instanceof Map) return new Map<number, number>(src);
        const out = new Map<number, number>();
        // 不用 Object.entries：本项目 target 是 ES2015，Object.entries 不在 lib 里（全项目同类代码也踩过）
        for (const key of Object.keys(src)) out.set(Number(key), Number((src as Record<string, number>)[key]));
        return out;
    }

    /** 技能的同品质内权重（缺省 1） */
    private static skillWeight(id: number): number {
        const cfg = ShopConfig.getShopSkill(id);
        const w = Number(cfg?.weight);
        return Number.isFinite(w) && w > 0 ? w : 1;
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

    /** 通用加权取一（权重全 0 时退化成等权） */
    private static pickWeighted<T extends { w: number }>(list: T[]): T | null {
        if (!list.length) return null;
        const total = list.reduce((s, x) => s + Math.max(0, x.w), 0);
        if (total <= 0) return list[Math.floor(Math.random() * list.length)] ?? null;
        let r = Math.random() * total;
        for (const x of list) {
            r -= Math.max(0, x.w);
            if (r <= 0) return x;
        }
        return list[list.length - 1];
    }
}
