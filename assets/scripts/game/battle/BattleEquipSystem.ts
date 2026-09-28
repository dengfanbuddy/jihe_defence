import type { RelicCfg } from "../excel_table/Tb_RelicConfig";
import { relicHasInner, relicInnerModifiers } from "../excel_table/Tb_RelicConfig";
import { BattleContext } from "./BattleContext";
import { Entity } from "./Entity";
import { BattleEvents } from "./types";


/**
 * 局内装备系统 —— 肉鸽核心（借鉴 Dota 2：遗物 = 一组永久 Modifier）
 *
 * 设计：
 *   - 遗物本身不写逻辑，它只是"Modifier 的集合 + 事件挂钩"
 *   - 简单装备：relics.json 的 **`modifiers_inner`**（局内版）配置列表，自动挂载
 *     （2026-07 起 relics 是「一件遗物一行」，局内版 / 局外版分两侧：本系统只吃局内版）
 *   - 复杂装备：script_id 指向代码类（覆写 Modifier 逻辑）
 *   - 获得装备时发布 OnRelicAdded 事件（UI/音效/成就订阅）
 */
export class BattleEquip {
    readonly def: RelicCfg;
    owner: Entity;
    /** 该遗物生成的 Modifier 实例 */
    appliedModifiers: any[] = [];

    constructor(def: RelicCfg, owner: Entity) {
        this.def = def;
        this.owner = owner;
    }

    getId(): number { return this.def.id; }

    /** 挂载（获得遗物）：将**局内版**配置的 Modifier 全部施加到主人身上 */
    Apply(ctx: BattleContext): void {
        // 整组遗物效果用 ApplyWithMaxHpCarry 包住：遗物里若含最大生命，
        // 满血时当前生命同步 +ΔmaxHp（残血时只抬上限），见 Entity.ApplyWithMaxHpCarry
        this.owner.ApplyWithMaxHpCarry(() => {
            for (const entry of relicInnerModifiers(this.def)) {
                // origin = 遗物条目：遗物间/与技能/buff 同 id 时各持独立实例；同遗物重复施加按 entry 配置合并
                // kv = 效果的施加参数（纯属性加成走共享模板「属性修改」，属性与数值由 kv.attrs 传入）
                //
                // duration：**遗物效果默认永久**（表格 `modifiers_inner[].duration` 不填 = null）。
                //   遗物是一次性获得、整局生效的被动，所以不能回落到效果模板自带的时长 ——
                //   模板是给技能/临时 buff 用的（如 mod 11「吸血」= 5 秒），借用它会让遗物的被动 5 秒后失效。
                //   真要限时的遗物在表格里写正数即可（`duration: 3` = 只持续 3 秒）。
                const duration = entry.duration ?? -1;
                const mod = this.owner.modifiers.AddModifier(entry.modifier, this.owner, duration, entry.kv, `relic:${this.def.id}`);
                if (mod) this.appliedModifiers.push(mod);
            }
        });
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

    constructor(owner: Entity, ctx: BattleContext) {
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
        // 局内只能获得**有局内版**的遗物（relics 表里 id 1294~1302 是只有局外版的，挂上去不会有任何效果）
        if (!relicHasInner(def)) {
            console.warn(`[RelicSystem] 遗物 ${id} ${def.name} 没有局内版（scope=${def.scope}），不能在本局获得`);
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

    /**
     * 换宿主（重新选英雄）：把已获得的遗物原样重新挂到新实体上。
     *
     * 「重新选英雄后等级/经验/装备/Buff 都不变」——遗物由本系统持有，
     * 旧实体连同它的 ModifierSystem 一起被销毁，因此这里重新 Apply 一遍即可
     * （新实体上重新生成 Modifier 实例，属性加成与被动随之恢复）。
     */
    RebindOwner(owner: any): void {
        this.owner = owner;
        for (const relic of this.relics) {
            relic.owner = owner;
            relic.appliedModifiers.length = 0;
            relic.Apply(this.ctx);
        }
    }

    Clear(): void {
        for (const r of [...this.relics]) r.Remove(this.ctx);
        this.relics.length = 0;
    }
}
