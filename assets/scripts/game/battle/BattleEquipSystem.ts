import type { RelicCfg } from "../excel_table/Tb_RelicConfig";
import { BattleContext } from "./BattleContext";
import { BattleEvents } from "./types";


/**
 * 局内装备系统 —— 肉鸽核心（借鉴 Dota 2：遗物 = 一组永久 Modifier）
 *
 * 设计：
 *   - 遗物本身不写逻辑，它只是"Modifier 的集合 + 事件挂钩"
 *   - 简单装备：relics.json 配置 modifiers 列表，自动挂载
 *   - 复杂装备：script_id 指向代码类（覆写 Modifier 逻辑）
 *   - 获得装备时发布 OnRelicAdded 事件（UI/音效/成就订阅）
 */
export class BattleEquip {
    readonly def: RelicCfg;
    owner: any;
    /** 该遗物生成的 Modifier 实例 */
    appliedModifiers: any[] = [];

    constructor(def: RelicCfg, owner: any) {
        this.def = def;
        this.owner = owner;
    }

    getId(): number { return this.def.id; }

    /** 挂载（获得遗物）：将所有配置 Modifier 施加到主人身上 */
    Apply(ctx: BattleContext): void {
        for (const entry of this.def.modifiers) {
            const mod = this.owner.modifiers.AddModifier(entry.modifier, this.owner, entry.duration);
            if (mod) this.appliedModifiers.push(mod);
        }
        ctx.bus.publish(BattleEvents.OnRelicAdded, {
            target: this.owner, relicId: this.def.id,
        });
    }

    /** 移除（出售/重置遗物） */
    Remove(ctx: BattleContext): void {
        for (const mod of this.appliedModifiers) {
            this.owner.modifiers.RemoveModifier(mod);
        }
        this.appliedModifiers.length = 0;
        ctx.bus.publish(BattleEvents.OnRelicRemoved, {
            target: this.owner, relicId: this.def.id,
        });
    }
}

/**
 * 实体上的遗物集合
 */
export class RelicSystem {
    private owner: any;
    private ctx: BattleContext;
    private relics: BattleEquip[] = [];

    constructor(owner: any, ctx: BattleContext) {
        this.owner = owner;
        this.ctx = ctx;
    }

    /** 获得遗物 */
    AddRelic(id: number): BattleEquip | null {
        const def = this.ctx.getRelicDef(id);
        if (!def) {
            console.warn(`[RelicSystem] 未找到遗物定义: ${id}`);
            return null;
        }
        // 同名遗物不可重复获得（肉鸽惯例：唯一）
        if (this.has(id)) return this.get(id)!;

        const relic = new BattleEquip(def, this.owner);
        relic.Apply(this.ctx);
        this.relics.push(relic);
        return relic;
    }

    /** 移除遗物 */
    RemoveRelic(id: number): boolean {
        const relic = this.get(id);
        if (!relic) return false;
        relic.Remove(this.ctx);
        this.relics = this.relics.filter((r) => r.getId() !== id);
        return true;
    }

    get(id: number): BattleEquip | undefined {
        return this.relics.find((r) => r.getId() === id);
    }
    has(id: number): boolean { return this.relics.some((r) => r.getId() === id); }
    getAll(): BattleEquip[] { return this.relics; }
    Clear(): void {
        for (const r of [...this.relics]) r.Remove(this.ctx);
        this.relics.length = 0;
    }
}
