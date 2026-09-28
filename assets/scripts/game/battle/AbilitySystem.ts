import { Ability } from './Ability';
import type { AbilityCfg } from '../excel_table/Tb_AbilityConfig';
import type { AbilityCfgContainer } from '../excel_table/Tb_AbilityConfig';
import type { BattleContext } from './BattleContext';

/**
 * AbilitySystem —— 实体技能管理
 * 管理技能实例、冷却更新、施放分发。
 * 复杂技能通过 script_id 从 ScriptRegistry 获取代码类。
 */
export class AbilitySystem {
    private abilities: Ability[] = [];
    private defs: AbilityCfgContainer;
    private entity: any;
    private ctx: BattleContext;

    constructor(entity: any, ctx: BattleContext, defs: AbilityCfgContainer) {
        this.entity = entity;
        this.ctx = ctx;
        this.defs = defs;
    }

    /** 添加技能（从配置） */
    AddAbility(defOrId: number | AbilityCfg): Ability | null {
        let def: AbilityCfg | undefined;
        if (typeof defOrId === 'number') {
            def = this.defs.getCfgById(defOrId);
            if (!def) {
                console.warn(`[AbilitySystem] 未找到技能定义: ${defOrId}`);
                return null;
            }
        } else {
            def = defOrId;
        }

        // 复杂技能逃逸：script_id → ScriptRegistry
        let ability: Ability;
        if (def.script_id) {
            const Cls = this.ctx.scriptRegistry.get(def.script_id);
            if (Cls) {
                ability = new Cls(def, this.entity);
            } else {
                console.warn(`[AbilitySystem] script_id 未注册: ${def.script_id}，使用默认实现`);
                ability = new Ability(def, this.entity);
            }
        } else {
            ability = new Ability(def, this.entity);
        }
        this.abilities.push(ability);
        // 被动技能：添加时立即生效（挂载永久 Modifier）
        if (ability.isPassive()) ability.ApplyPassive();
        return ability;
    }

    RemoveAbility(id: number): void {
        this.abilities = this.abilities.filter((a) => a.getId() !== id);
    }

    getAbility(id: number): Ability | undefined {
        return this.abilities.find((a) => a.getId() === id);
    }

    /**
     * 获取可施放的主动技能列表（不含普攻/被动）
     * 普攻（behavior=attack）与被动（passive）都不算技能，不参与自动施放/技能枚举。
     */
    getCastableSkills(): Ability[] {
        return this.abilities.filter((a) => a.isAutoCastable());
    }

    /**
     * 技能升级（肉鸽：抽到重复技能 → 整体替换为升级形态）
     * 级联：沿 upgrades_to 链跳过已拥有的中间形态，直接升到第一个未拥有的形态
     * @param id 触发升级的技能 id（已拥有）
     * @returns 替换后的新技能（全链已拥有则返回 null）
     */
    UpgradeAbility(id: number): Ability | null {
        const initial = this.getAbility(id);
        if (!initial) return null;

        // 沿链找到第一个未拥有的形态
        let current: Ability | undefined = initial;
        let nextId = current.def.upgrades_to;
        while (nextId) {
            if (!this.getAbility(nextId)) {
                const nextDef = this.defs.getCfgById(nextId);
                if (!nextDef) return null;
                this.RemoveAbility(initial.getId());
                return this.AddAbility(nextDef);
            }
            current = this.getAbility(nextId);
            nextId = current?.def.upgrades_to;
        }
        return null; // 整条升级链都已拥有
    }

    getAll(): Ability[] { return this.abilities; }

    /** 清空所有技能（对象池复用前调用） */
    Clear(): void {
        this.abilities.length = 0;
    }

    /** 施放技能 */
    CastAbility(id: number, target?: any, point?: { x: number; y: number }): boolean {
        const ability = this.getAbility(id);
        if (!ability) return false;
        return ability.Cast(target, point);
    }

    /** 更新冷却 */
    Tick(dt: number): void {
        for (const a of this.abilities) a.Tick(dt);
    }
}
