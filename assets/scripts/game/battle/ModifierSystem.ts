import { AttributeContribution, BattleEvents, DamageType, DispelLevel, ModifierStackMode, StateType } from './types';
import { Modifier, normalizeDuration } from './Modifier';
import type { ModifierCfg } from '../excel_table/Tb_ModifierConfig';
import type { ModifierCfgContainer } from '../excel_table/Tb_ModifierConfig';
import type { ModifierTickEffect } from '../excel_table/EffectTypes';
import { resolveAttrEntries } from '../excel_table/EffectTypes';
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
     * @param duration 覆盖持续时间（秒；缺省用定义值）。**`null` 与缺省同义 = 未指定**
     *                 （表格空单元格导出就是 null，见 `Modifier.normalizeDuration`），别当成 0 秒
     * @param kv 传给 OnCreated 的参数
     * @param origin 来源组标识（授予条目标识，如 'relic:1' / 'ability:6' / 'buff:12'）。
     *              同 (id, origin) 才按 stack_mode 合并（refresh 刷时 / stack 叠层 / none 覆盖）；
     *              不同 origin 各持独立实例（分别计时/失效/叠加），互不干扰。
     *              缺省共享空分组 = 旧的"实体上按 id 唯一"行为。
     */
    AddModifier(id: number, source?: unknown, duration?: number | null, kv?: Record<string, any>, origin?: string): Modifier | null {
        const def = this.defs.getCfgById(id);
        if (!def) {
            console.warn(`[ModifierSystem] 未找到 Modifier 定义: ${id}`);
            return null;
        }
        // 免疫/不可施加检查：Invulnerable 状态下不可施加 debuff（可配）
        if (this.status.get(StateType.Invulnerable) && def.is_debuff) return null;

        // 最强互斥家族（strongest_only）：实体上同 id 只保留最强幅度实例，跨来源也互斥
        if (def.strongest_only) {
            return this.addStrongestOnly(def, source, duration, kv, origin);
        }

        const existing = this.findByOrigin(id, origin);
        if (existing && def.stack_mode !== ModifierStackMode.Renew) {
            return this.applyStackRule(existing, def, source, duration, kv, origin);
        }

        const mod = this.createModifier(def, source, duration, kv, origin);
        this.modifiers.push(mod);
        this.onAdded(mod);
        return mod;
    }

    private applyStackRule(existing: Modifier, def: ModifierCfg, source: unknown, duration?: number | null, kv?: Record<string, any>, origin?: string): Modifier {
        switch (def.stack_mode) {
            case ModifierStackMode.Refresh:
                // 刷新持续时间（duration 缺省 / null = 未指定 → 用定义值；别把 null 写进 remainingTime）
                existing.remainingTime = normalizeDuration(def, duration);
                existing.source = source;
                existing.OnRefresh(kv);
                this.recollect(); // kv 幅度变化时贡献需重算
                this.ctx.bus.publish(BattleEvents.OnModifierRefreshed, {
                    target: this.entity, modifierId: def.id, stackCount: existing.stackCount, source,
                });
                return existing;
            case ModifierStackMode.Stack: {
                // 叠加层数（上限 max_stack）
                const max = def.max_stack ?? 999;
                if (existing.stackCount < max) {
                    existing.setStackCount(existing.stackCount + 1);
                    existing.remainingTime = normalizeDuration(def, duration);
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
                const mod = this.createModifier(def, source, duration, kv, origin);
                this.modifiers.push(mod);
                this.onAdded(mod);
                return mod;
        }
    }

    /**
     * strongest_only 施加：实体上同 id 至多一个实例，按幅度保留最强（跨来源互斥）。
     * - 新幅度 >= 现存最强 → 移除全部现存同 id 实例，挂新实例（全新时长）
     * - 新幅度 < 现存最强 → 该效果为 refresh 型则仅刷新最强实例时长（不覆盖幅度），否则忽略
     */
    private addStrongestOnly(def: ModifierCfg, source: unknown, duration?: number | null, kv?: Record<string, any>, origin?: string): Modifier {
        const alive = this.modifiers.filter((m) => m.getId() === def.id);
        if (alive.length > 0) {
            let strongest = alive[0];
            let best = this.potencyOf(def, strongest.getKV());
            for (let i = 1; i < alive.length; i++) {
                const p = this.potencyOf(def, alive[i].getKV());
                if (p > best) { best = p; strongest = alive[i]; }
            }
            const incoming = this.potencyOf(def, kv);
            if (incoming < best) {
                // 更弱：仅补时，幅度保持最强（不合并 kv，避免最强幅度被弱档覆盖）
                if (def.stack_mode === ModifierStackMode.Refresh) {
                    strongest.remainingTime = normalizeDuration(def, duration);
                    strongest.source = source;
                    this.ctx.bus.publish(BattleEvents.OnModifierRefreshed, {
                        target: this.entity, modifierId: def.id, stackCount: strongest.stackCount, source,
                    });
                }
                return strongest;
            }
            // 同强或更强 → 替换全部现存实例
            for (const m of [...alive]) this.RemoveModifier(m);
        }
        const mod = this.createModifier(def, source, duration, kv, origin);
        this.modifiers.push(mod);
        this.onAdded(mod);
        return mod;
    }

    /**
     * 效果强度：以首条属性条目的幅度为准（支持 `attrs_var` 由 kv 传入、条目 `var` 绑定），
     * 绝对值比较（支持负向减益）。
     */
    private potencyOf(def: ModifierCfg, kv?: Record<string, any>): number {
        const entries = resolveAttrEntries(def.effects, kv);
        if (entries.length === 0) return 0;
        return Math.abs(entries[0].value);
    }

    private createModifier(def: ModifierCfg, source: unknown, duration?: number | null, kv?: Record<string, any>, origin?: string): Modifier {
        const mod = new Modifier(def, duration, kv);
        mod.target = this.entity;
        mod.source = source;
        mod.origin = origin ?? '';
        // 复杂逻辑逃逸：script_id 指向注册在 ScriptRegistry 中的类
        if (def.script_id) {
            const Cls = this.ctx.scriptRegistry.get(def.script_id);
            if (Cls) {
                const scripted = new Cls(def, duration, kv);
                scripted.target = this.entity;
                scripted.source = source;
                scripted.origin = origin ?? '';
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

    /** 按 (id, origin) 查找同分组实例：同 id 跨来源不合并（origin 缺省 = 空分组） */
    findByOrigin(id: number, origin?: string): Modifier | undefined {
        const key = origin ?? '';
        return this.modifiers.find((m) => m.getId() === id && (m.origin ?? '') === key);
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
            // 自带冷却（cd）：每个实例独立计时，互不影响
            if (m.cdRemaining > 0) m.cdRemaining = Math.max(0, m.cdRemaining - dt);
            // 周期效果（DoT/HoT）—— 每条周期效果各持一个计时器；在剩余时间扣除前处理
            for (const eff of m.advanceTicks(dt)) this.processTickEffect(m, eff);
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

    /** 处理一条周期效果（tick_damage / tick_heal / tick_apply_modifier） */
    private processTickEffect(m: Modifier, eff: ModifierTickEffect): void {
        const source = m.source ?? this.entity;
        const target = m.target ?? this.entity;
        switch (eff.type) {
            case 'tick_damage': {
                if (eff.value > 0) {
                    this.ctx.damagePipeline.ApplyDamage(
                        target, source, eff.value,
                        eff.damage_type ?? DamageType.Magical,
                    );
                }
                break;
            }
            case 'tick_heal': {
                if (eff.value > 0 && target.Heal) target.Heal(eff.value, source);
                break;
            }
            case 'tick_apply_modifier': {
                const chance = eff.chance ?? 1;
                if (Math.random() < chance && target.modifiers) {
                    // tick 施加的效果归属触发它的 Modifier 的来源组（同源可 refresh/stack）
                    target.modifiers.AddModifier(eff.modifier, source, eff.duration, undefined, m.origin);
                }
                break;
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
