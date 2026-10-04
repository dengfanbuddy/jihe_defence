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
 *   · **本轮出几个技能由技能配额决定**（与品质无关的独立一掷）：
 *     ① `skillDrawChance` 先掷「这轮有没有技能」（默认 20%，即 80% 一个技能都不出）；
 *     ② 有技能时按 `skillCountWeight`（默认 `{"1":70,"2":30}`）加权掷具体个数 `n`，`n` ∈ [0, `skillMaxPerDraw`]
 *     → 一轮里的技能选项数**最多 `skillMaxPerDraw`（默认 2）**，其余格子全是遗物
 *   · **品质仍是逐格 roll，口径与之前完全一致**：品质权重随英雄等级变化（`shop_draw`：白/蓝/黄/红），
 *     同品质内遗物等权、技能读自己的 `weight` 列
 *   · 阶段门槛：品质对应 stage 超过当前阶段上限时，按 `upgrade_chance` 决定是否越阶，否则降到本阶段最高品质
 *   · 本轮内不重复；遗物本局唯一（已拥有不再出）；**技能满级后才不出**（没满级仍会出现 = 可升级）
 *   · **配额补齐**：某格掷到的品质里没有技能可选（或格子被阶段门槛降过档）时配额可能没排满 →
 *     把遗物候选换成阶段内任意技能，直到配额用满（技能池空了就放弃，不硬塞）
 *   · 池子抽干时补位：先阶段内全品质、再全池；全都空了就少出一个槽位
 *
 * 费用 / 广告额度这类「商店级」规则也在这里读（`drawCost` / `adFreeDrawLimit` / `adExtraPickLimit`），
 * 目的是让 `RelicShop` 只跟本文件打交道，配置键名不散落在业务代码里。
 */
export class RelicDraw {

    /* ===================================================================
     * 商店级规则（薄封装 ShopConfig，业务只认这里的方法名）
     * =================================================================== */

    /**
     * 一次刷新展示几个槽位（缺省 `shop_constants.optionCount` = 4）。
     *
     * @param bonus 成就效果 `shop_option_plus` 的**额外选项数**（宿主从**开局快照**取；
     *              0 / 缺省 = 不加）。放在这里而不是改配置：配置是"基础档位"，
     *              成就效果是"本局的额外加成"，两者分开才不会互相污染（改表不会覆盖掉成就效果）。
     */
    static optionCount(bonus = 0): number {
        return Math.max(1, ShopConfig.getOptionCount() + Math.max(0, Math.floor(bonus)));
    }

    /** 第 drawIndex 次付费刷新的费用（0 起；50 → 100 → … 封顶 200） */
    static drawCost(drawIndex: number): number {
        return ShopConfig.getDrawCost(Math.max(0, drawIndex));
    }

    /**
     * 一局内可用的「广告免费刷新」次数（配置关闭时为 0）。
     *
     * @param bonus 成就效果 `ad_free_draw` 的**额外次数**（宿主从**开局快照**取；
     *              按 hook 的口径**叠加**在配置的 `adFreeDrawPerRun` 之上）。
     *              `adFreeDrawEnabled` 关掉时它同样不生效（免费抽这条通道整个是关的）。
     */
    static adFreeDrawLimit(bonus = 0): number {
        if (!ShopConfig.getBool('adFreeDrawEnabled', true)) return 0;
        return Math.max(0, ShopConfig.getNumber('adFreeDrawPerRun', 3) + Math.max(0, Math.floor(bonus)));
    }

    /** 一轮抽取里可用的「广告补选」次数（配置关闭时为 0） */
    static adExtraPickLimit(): number {
        if (!ShopConfig.getBool('adExtraPickEnabled', true)) return 0;
        return Math.max(0, ShopConfig.getNumber('adExtraPickCount', 1));
    }

    /** 一轮里技能选项数的上限（`shop_constants.skillMaxPerDraw`；0 = 永不出技能） */
    static skillMaxPerDraw(): number {
        return Math.max(0, Math.floor(ShopConfig.getNumber('skillMaxPerDraw', 2)));
    }

    /** 一轮里「出技能」的概率（`shop_constants.skillDrawChance`，百分数：20 = 20%；0 = 永不出技能） */
    static skillDrawChance(): number {
        return Math.max(0, Math.min(100, ShopConfig.getNumber('skillDrawChance', 20)));
    }

    /**
     * 掷本轮该出几个技能（0 ~ `skillMaxPerDraw`）。
     *
     * 两步走，缺一不可：① 先按 `skillDrawChance` 掷「这轮到底有没有技能」——
     * 默认 20%，所以 **80% 的刷新一个技能都不出**；② 有技能时按 `skillCountWeight`
     * （`{"1":70,"2":30}`）加权掷具体个数。权重只认 `1 ~ 上限` 的键，一个都没配就退化成 1 个。
     */
    static rollSkillCount(): number {
        const max = RelicDraw.skillMaxPerDraw();
        if (max <= 0) return 0;
        if (Math.random() * 100 >= RelicDraw.skillDrawChance()) return 0;
        const weights = ShopConfig.getObject('skillCountWeight', { '1': 70, '2': 30 });
        const list: { n: number; w: number }[] = [];
        for (let n = 1; n <= max; n++) {
            const w = Number(weights[String(n)]);
            if (Number.isFinite(w) && w > 0) list.push({ n, w });
        }
        return RelicDraw.pickWeighted(list)?.n ?? 1;
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
     * 技能个数由 `rollSkillCount()` 在前一步定好（默认 80% 出 0 个 / 14% 出 1 个 / 6% 出 2 个），
     * 剩下的格子全是遗物；**品质仍是逐格 roll**，口径与旧版一致。
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

        /**
         * 按种类取一个候选：`preferSkill` = 本轮技能配额还没用满 → 先拿技能、没有才退回遗物；
         * 否则先遗物、遗物空才退回技能（回退只为「别让格子空着」，不会突破配额上限）。
         */
        const pickFrom = (byKind: Record<ShopOptionKind, ShopOption[]>, preferSkill: boolean): ShopOption | null => {
            const order: ShopOptionKind[] = preferSkill ? ['skill', 'relic'] : ['relic', 'skill'];
            for (const k of order) {
                const list = byKind[k];
                if (!list.length) continue;
                // 遗物同品质等权（表里没有单件权重列）；技能读自己的 weight 列
                const weighted = k === 'skill'
                    ? list.map((o) => ({ o, w: RelicDraw.skillWeight(o.id) }))
                    : list.map((o) => ({ o, w: 1 }));
                const hit = RelicDraw.pickWeighted(weighted)?.o ?? list[0];
                if (hit.kind === 'relic') usedRelic.add(hit.id);
                else usedSkill.add(hit.id);
                return hit;
            }
            return null;
        };

        // ① 本轮技能配额：先掷「有没有技能」（默认 20%），再掷「几个」（默认 1 个 70% / 2 个 30%）
        //    —— 品质链路完全不变：每个格子还是先 roll 品质、再过阶段门槛/越阶
        let skillBudget = RelicDraw.rollSkillCount();

        // ② 主循环：先 roll 品质，再按「配额还剩几个技能」定种类
        for (let i = 0; i < count; i++) {
            let rarity = RelicDraw.rollRarity(weights);
            // 阶段门槛：超出当前阶段的品质，按 upgrade_chance 决定是否越阶，否则降到当前阶段最高品质
            if (ShopConfig.getStageOfRarity(rarity) > stageCap && Math.random() >= upgradeChance) {
                rarity = SHOP_RARITY_ORDER[Math.max(0, stageCap - 1)] ?? 'common';
            }
            const allowedStage = Math.max(stageCap, ShopConfig.getStageOfRarity(rarity));
            const option = pickFrom(candidates(rarity, allowedStage, false), skillBudget > 0);
            if (!option) continue;
            if (option.kind === 'skill') skillBudget--;
            picked.push(option);
        }

        // ③ 配额补齐：该品质里没有技能可选时配额会剩下来 → 把遗物候选换成技能（池子空了就放弃，不硬塞）
        while (skillBudget > 0) {
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
            skillBudget--;
        }

        // ④ 补位：主循环因池子变窄少抽了格子时，忽略品质先阶段内后全池补齐
        for (let guard = 0; picked.length < count && guard < count * 2; guard++) {
            const inStage = pickFrom(candidates(null, stageCap, true), skillBudget > 0);
            const option = inStage ?? pickFrom(candidates(null, SHOP_RARITY_ORDER.length, true), skillBudget > 0);
            if (!option) break;
            if (option.kind === 'skill') skillBudget--;
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
