import { BattleEvents, StateType } from './types';
import type { ModifierSystem } from './ModifierSystem';

/**
 * 状态系统 —— 聚合实体上所有 Modifier 施加的硬状态
 * 借鉴 Dota 2：任一 Modifier 施加了某状态，该状态即生效（OR 聚合）
 */
export class StatusSystem {
    private mods: ModifierSystem;
    private bus: any;
    private cache = new Map<StateType, boolean>();

    constructor(mods: ModifierSystem, bus: any) {
        this.mods = mods;
        this.bus = bus;
    }

    /** 重新聚合（Modifier 增删后调用） */
    recollect(): void {
        const merged: Partial<Record<StateType, boolean>> = {};
        for (const m of this.mods.getAll()) {
            const states = m.CheckState();
            for (const [state, active] of Object.entries(states)) {
                if (active) merged[state as StateType] = true;
            }
        }
        // 对比旧缓存，发布变化事件
        for (const state of Object.values(StateType)) {
            const before = this.cache.get(state) ?? false;
            const after = merged[state] ?? false;
            if (before !== after) {
                this.cache.set(state, after);
                this.bus.publish(BattleEvents.OnStateChanged, { state, active: after });
            }
        }
    }

    /** 查询某状态是否生效 */
    get(state: StateType): boolean {
        return this.cache.get(state) ?? false;
    }

    /** 清空状态缓存（对象池复用前调用） */
    Clear(): void {
        this.cache.clear();
    }

    /** 快速查询：是否完全不能行动（眩晕/妖术等） */
    isFullyDisabled(): boolean {
        return this.get(StateType.Stunned) || this.get(StateType.Hexed);
    }

    /** 查询：能否施法 */
    canCast(): boolean {
        return !this.get(StateType.Stunned) && !this.get(StateType.Hexed) && !this.get(StateType.Silenced);
    }

    /** 查询：能否普攻 */
    canAttack(): boolean {
        return !this.get(StateType.Stunned) && !this.get(StateType.Hexed) && !this.get(StateType.Disarmed);
    }

    /** 查询：能否移动 */
    canMove(): boolean {
        return !this.get(StateType.Stunned) && !this.get(StateType.Hexed) && !this.get(StateType.Rooted);
    }
}
