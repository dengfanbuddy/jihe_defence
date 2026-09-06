import { RelicSystem } from './BattleEquipSystem';
import type { BattleContext } from './BattleContext';

/**
 * 肉鸽商店系统 —— 借鉴幸存者 like 的构筑循环
 *
 * 功能：
 *   - 3 个技能槽（最多同时装备 3 个商店技能）
 *   - 从技能池 + 遗物池中随机抽取 3 个选项（不重复）
 *   - 装备：技能 → 英雄学会（AddAbility）；遗物 → 立即生效（AddRelic）
 *   - autoChoose：Demo 用的自动决策（真实游戏换成玩家 UI 选择）
 *
 * 设计要点：
 *   - 商店不持有任何战斗逻辑，只做"池子抽取 + 装备编排"
 *   - 装备后技能/遗物走已有的 AbilitySystem / RelicSystem，自动融入战斗
 */
export interface ShopOption {
    kind: 'ability' | 'relic';
    id: number;
    name: string;
    rarity?: string;
}

/** 装备结果 */
export type EquipResult = 'equipped' | 'upgraded' | 'relic' | null;

export class ShopSystem {
    /** 技能池（AbilityCfg.id） */
    readonly skillPool: number[];
    /** 遗物池（RelicCfg.id） */
    readonly relicPool: number[];
    /** 技能槽上限 */
    readonly maxSlots: number;

    private hero: any;
    private relicSystem: RelicSystem;
    private ctx: BattleContext;
    /** 已装备的商店技能 id（用于槽位计数与去重） */
    private equippedSkills: number[] = [];

    constructor(hero: any, ctx: BattleContext, relicSystem: RelicSystem, opts?: {
        skillPool?: number[];
        relicPool?: number[];
        maxSlots?: number;
    }) {
        this.hero = hero;
        this.ctx = ctx;
        this.relicSystem = relicSystem;
        this.skillPool = opts?.skillPool ?? [];
        this.relicPool = opts?.relicPool ?? [];
        this.maxSlots = opts?.maxSlots ?? 3;
    }

    // ============ 抽取 ============

    /** 随机抽取 count 个不重复选项（技能 + 遗物混合池） */
    rollOptions(count = 3): ShopOption[] {
        const pool: ShopOption[] = [];
        for (const id of this.skillPool) {
            const def = this.ctx.getAbilityDef(id);
            if (def) pool.push({ kind: 'ability', id, name: def.name ?? String(id) });
        }
        for (const id of this.relicPool) {
            const def = this.ctx.getRelicDef(id);
            if (def) pool.push({ kind: 'relic', id, name: def.name ?? String(id), rarity: def.rarity });
        }
        // Fisher-Yates 洗牌取前 count
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, Math.min(count, pool.length));
    }

    // ============ 装备 ============

    /**
     * 装备一个选项
     * @returns 'equipped' 新装备 / 'upgraded' 升级替换 / 'relic' 获得遗物 / null 失败
     */
    equip(option: ShopOption): EquipResult {
        if (option.kind === 'ability') return this.equipAbility(option.id);
        return this.equipRelic(option.id) ? 'relic' : null;
    }

    private equipAbility(id: number): EquipResult {
        // 已拥有 → 尝试升级替换（肉鸽：重复抽到 = 升级，整体换成下一形态）
        if (this.hero.abilities.getAbility(id)) {
            return this.hero.abilities.UpgradeAbility(id) ? 'upgraded' : null;
        }
        // 槽位已满 → 失败
        if (this.equippedSkills.length >= this.maxSlots) return null;
        const ok = this.hero.abilities.AddAbility(id) !== null;
        if (ok) this.equippedSkills.push(id);
        return ok ? 'equipped' : null;
    }

    private equipRelic(id: number): boolean {
        // RelicSystem 自带唯一性检查
        return this.relicSystem.AddRelic(id) !== null;
    }

    /** 自动决策：优先技能（新装备/升级），再遗物（Demo 用；真实游戏改为玩家选择） */
    autoChoose(options: ShopOption[]): EquipResult {
        // 先找技能（构筑核心：技能槽优先，已拥有则升级）
        for (const opt of options) {
            if (opt.kind === 'ability' && this.canEquip(opt)) {
                return this.equip(opt);
            }
        }
        // 再找遗物
        for (const opt of options) {
            if (opt.kind === 'relic' && this.canEquip(opt)) {
                return this.equip(opt);
            }
        }
        return null;
    }

    /** 该选项当前是否可装备（新装 / 可升级 / 遗物未拥有） */
    canEquip(option: ShopOption): boolean {
        if (option.kind === 'ability') {
            const existing = this.hero.abilities.getAbility(option.id);
            // 已拥有 → 有升级形态且升级目标未被拥有即可升级
            if (existing) return !!existing.def.upgrades_to;
            return this.equippedSkills.length < this.maxSlots;
        }
        // 遗物唯一性
        return !this.relicSystem.has(option.id);
    }

    // ============ 查询 ============

    getEquippedSkills(): number[] { return [...this.equippedSkills]; }
    isSlotFull(): boolean { return this.equippedSkills.length >= this.maxSlots; }
}
