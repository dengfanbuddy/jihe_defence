import { AttributeContribution, BattleEvents, DamageType, DispelLevel, ModifierStackMode, StateType } from './types';
import { Modifier } from './Modifier';
import type { ModifierCfg } from '../excel_table/Tb_ModifierConfig';
import type { ModifierCfgContainer } from '../excel_table/Tb_ModifierConfig';
import type { BattleContext } from './BattleContext';
import type { AttributeSystem } from './AttributeSystem';
import type { StatusSystem } from './StatusSystem';

/**
 * ModifierSystem —— 管理实体上所有 Modifier 的生命周期/叠加/汇总/事件分发
 *
 * 借鉴 Dota 2：
 *   - 叠加规则：none / refresh / stack / renew
 *   - 属性贡献：每次增删后重新汇总到 AttributeSystem
 *   - 事件分发：战斗事件广播给所有 Modifier 的事件回调
 *   - 驱散：按等级批量移除
 */
export class ModifierSystem {
    private modifiers: Modifier[] = [];
    private defs: ModifierCfgContainer;
    private ctx: BattleContext;
    private entity: any; // Entity

    // 通过 getter 动态访问，避免 Entity 构造顺序导致的空引用
    private get attrs(): AttributeSystem { return this.entity.attrs; }
    private get status(): StatusSystem { return this.entity.status; }

    constructor(entity: any, ctx: BattleContext, defs: ModifierCfgContainer) {
        this.entity = entity;
        this.ctx = ctx;
        this.defs = defs;
    }

    // ============ 添加 ============

    /**
     * 添加 Modifier
     * @param id ModifierCfg.id
     * @param source 来源实体（可选）
     * @param duration 覆盖持续时间（秒；缺省用定义值）
     * @param kv 传给 OnCreated 的参数
     */
    AddModifier(id: number, source?: unknown, duration?: number, kv?: Record<string, any>): Modifier | null {
        const def = this.defs.getCfgById(id);
        if (!def) {
            console.warn(`[ModifierSystem] 未找到 Modifier 定义: ${id}`);
            return null;
        }
        // 免疫/不可施加检查：Invulnerable 状态下不可施加 debuff（可配）
        if (this.status.get(StateType.Invulnerable) && def.is_debuff) return null;

        const existing = this.find(id);
        if (existing && def.stack_mode !== ModifierStackMode.Renew) {
            return this.applyStackRule(existing, def, source, duration, kv);
        }

        const mod = this.createModifier(def, source, duration, kv);
        this.modifiers.push(mod);
        this.onAdded(mod);
        return mod;
    }

    private applyStackRule(existing: Modifier, def: ModifierCfg, source: unknown, duration?: number, kv?: Record<string, any>): Modifier {
        switch (def.stack_mode) {
            case ModifierStackMode.Refresh:
                // 刷新持续时间
                existing.remainingTime = duration !== undefined ? duration : def.duration;
                existing.source = source;
                existing.OnRefresh(kv);
                this.ctx.bus.publish(BattleEvents.OnModifierRefreshed, {
                    target: this.entity, modifierId: def.id, stackCount: existing.stackCount, source,
                });
                return existing;
            case ModifierStackMode.Stack: {
                // 叠加层数（上限 max_stack）
                const max = def.max_stack ?? 999;
                if (existing.stackCount < max) {
                    existing.setStackCount(existing.stackCount + 1);
                    existing.remainingTime = duration !== undefined ? duration : def.duration;
                    existing.OnRefresh(kv);
                    this.recollect();
                    this.ctx.bus.publish(BattleEvents.OnModifierRefreshed, {
                        target: this.entity, modifierId: def.id, stackCount: existing.stackCount, source,
                    });
                }
                return existing;
            }
            case ModifierStackMode.None:
            default:
                // 不叠加：移除旧的，新建
                this.RemoveModifier(existing);
                const mod = this.createModifier(def, source, duration, kv);
                this.modifiers.push(mod);
                this.onAdded(mod);
                return mod;
        }
    }

    private createModifier(def: ModifierCfg, source: unknown, duration?: number, kv?: Record<string, any>): Modifier {
        const mod = new Modifier(def, duration, kv);
        mod.target = this.entity;
        mod.source = source;
        // 复杂逻辑逃逸：script_id 指向注册在 ScriptRegistry 中的类
        if (def.script_id) {
            const Cls = this.ctx.scriptRegistry.get(def.script_id);
            if (Cls) {
                const scripted = new Cls(def, duration, kv);
                scripted.target = this.entity;
                scripted.source = source;
                return scripted;
            }
            console.warn(`[ModifierSystem] script_id 未注册: ${def.script_id}`);
        }
        mod.OnCreated(kv);
        return mod;
    }

    // ============ 移除 ============

    RemoveModifier(mod: Modifier): void {
        const idx = this.modifiers.indexOf(mod);
        if (idx < 0) return;
        this.modifiers.splice(idx, 1);
        mod.OnDestroy();
        this.recollect();
        this.ctx.bus.publish(BattleEvents.OnModifierRemoved, {
            target: this.entity, modifierId: mod.getId(), stackCount: mod.stackCount,
        });
    }

    /** 按 id 移除（移除所有同名实例） */
    RemoveModifierById(id: number): number {
        const targets = this.modifiers.filter((m) => m.getId() === id);
        for (const m of targets) this.RemoveModifier(m);
        return targets.length;
    }

    /** 按状态移除（如驱散 stun 时移除所有眩晕来源） */
    RemoveByState(state: StateType): number {
        let removed = 0;
        for (const m of [...this.modifiers]) {
            if (m.CheckState()[state]) {
                this.RemoveModifier(m);
                removed++;
            }
        }
        return removed;
    }

    /** 驱散：移除可驱散性 <= level 且 dispel_level > None 的 Modifier */
    Purge(level: DispelLevel, targetDebuffsOnly = false): number {
        let removed = 0;
        for (const m of [...this.modifiers]) {
            const dl = m.getDispelLevel();
            if (dl === DispelLevel.None) continue;
            if (dl <= level && (!targetDebuffsOnly || m.isDebuff())) {
                this.RemoveModifier(m);
                removed++;
            }
        }
        return removed;
    }

    /** 移除全部 */
    Clear(): void {
        for (const m of [...this.modifiers]) {
            m.OnDestroy();
        }
        this.modifiers.length = 0;
        this.recollect();
    }

    // ============ 查询 ============

    find(id: number): Modifier | undefined {
        return this.modifiers.find((m) => m.getId() === id);
    }
    getAll(): Modifier[] { return this.modifiers; }
    has(id: number): boolean { return this.modifiers.some((m) => m.getId() === id); }
    getStackCount(id: number): number {
        return this.modifiers
            .filter((m) => m.getId() === id)
            .reduce((s, m) => s + m.stackCount, 0);
    }

    // ============ 每帧更新 ============

    Tick(dt: number): void {
        for (const m of [...this.modifiers]) {
            // 周期效果（DoT/HoT）—— 在剩余时间扣除前处理
            if (m.def.tick) {
                m.tickTimer += dt;
                while (m.tickTimer >= m.def.tick.interval) {
                    m.tickTimer -= m.def.tick.interval;
                    this.processTick(m);
                }
            }
            if (m.paused || m.isPermanent()) {
                m.OnTick(dt);
                continue;
            }
            m.remainingTime -= dt;
            m.OnTick(dt);
            if (m.remainingTime <= 0) {
                this.RemoveModifier(m);
            }
        }
    }

    /** 处理 Modifier 的周期效果（tick.damage / tick.heal / tick.apply_modifier） */
    private processTick(m: Modifier): void {
        const t = m.def.tick!;
        const source = m.source ?? this.entity;
        const target = m.target ?? this.entity;
        if (t.damage && t.damage > 0) {
            this.ctx.damagePipeline.ApplyDamage(
                target, source, t.damage,
                t.damage_type ?? DamageType.Magical,
            );
        }
        if (t.heal && t.heal > 0) {
            if (target.Heal) target.Heal(t.heal, source);
        }
        if (t.apply_modifier) {
            const chance = t.apply_modifier_chance ?? 1;
            if (Math.random() < chance && target.modifiers) {
                target.modifiers.AddModifier(t.apply_modifier, source, t.apply_modifier_duration);
            }
        }
    }

    // ============ 属性汇总 ============

    /** 上次影响过的属性集合（用于清除残留贡献） */
    private prevAffected = new Set<number>();

    /** 重新收集所有 Modifier 对属性的贡献并写入 AttributeSystem */
    private recollect(): void {
        const affected = new Set<number>();
        for (const m of this.modifiers) {
            for (const attr of m.GetAffectedAttributes()) affected.add(attr);
        }
        // 合并历史属性：确保被移除的 Modifier 的贡献被清零
        const all = new Set<number>([...affected, ...this.prevAffected]);
        for (const attr of all) {
            const list: AttributeContribution[] = [];
            let order = 0;
            for (const m of this.modifiers) {
                const c = m.GetModifierProperty(attr);
                if (c !== null) {
                    list.push({ value: c.value, mode: c.mode, order: order++ });
                }
            }
            this.attrs.setContributions(attr, list);
        }
        this.prevAffected = affected;
        this.status.recollect();
    }

    // ============ 事件分发（广播给所有 Modifier） ============

    /**
     * 向所有 Modifier 广播战斗事件。
     * 按添加顺序调用；若某 Modifier 返回 consumed=true 则停止（护盾/格挡语义）。
     * @returns 事件是否被吞掉
     */
    DispatchEvent(eventName: string, event: any): boolean {
        for (const m of [...this.modifiers]) {
            const consumed = m.OnBattleEvent(eventName, event);
            if (consumed) return true;
        }
        return false;
    }

    // ============ 内部辅助 ============

    private onAdded(mod: Modifier): void {
        mod.OnCreated(mod.getKV());
        this.recollect();
        this.ctx.bus.publish(BattleEvents.OnModifierAdded, {
            target: this.entity, modifierId: mod.getId(), stackCount: mod.stackCount, source: mod.source,
        });
    }
}
