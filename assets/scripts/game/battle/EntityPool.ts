import { Entity } from './Entity';
import { AIRegistry } from './ai/AIRegistry';
import { UnitKind } from '../common/EntityVisualConfig';
import type { BattleContext } from './BattleContext';
import type { UnitCfg } from '../excel_table/Tb_UnitConfig';

/**
 * ============================================================
 * EntityPool —— 实体对象池（怪物/Boss 频繁刷新的性能优化）
 * ============================================================
 *
 * 为什么需要：怪物每波刷新、生命周期短，反复 new Entity 会产生
 * 大量 GC 压力（每个 Entity 构造时会创建 AttributeSystem/
 * ModifierSystem/StatusSystem/AbilitySystem 4 个子系统）。
 * 池化复用后：子系统只创建一次，刷新时只重置状态。
 *
 * 设计：
 *   - 按单位 id（UnitCfg.id）分桶，同类型怪物复用同池实体
 *   - acquire(def)：取一个实体并 Reinit；池空则新建
 *   - release(entity)：ResetForPool 后回池
 *   - 实例 uid 不变（对象池复用后仍唯一，实体表/弹道安全）
 *
 * 用法（Scene_Game_Stage）：
 *   const pool = new EntityPool(ctx);
 *   const m = pool.acquire(def);   // 代替 ctx.CreateEntityFromDef
 *   m.position = {...};
 *   // 怪物死亡时：
 *   pool.release(m);               // 代替 ctx.RemoveEntity
 */
export class EntityPool {
    private ctx: BattleContext;
    /** 桶：unitId → 空闲实体列表 */
    private pools = new Map<number, Entity[]>();

    constructor(ctx: BattleContext) {
        this.ctx = ctx;
    }

    /** 从池中取出一个实体（没有空闲则新建） */
    acquire(def: UnitCfg, kind?: UnitKind): Entity {
        const list = this.pools.get(def.id);
        let entity = list?.pop();
        if (!entity) {
            // 池空 → 新建（uid 由 BattleContext 分配，保证唯一）
            entity = this.ctx.CreateEntityFromDef(def, kind);
        } else {
            // 复用：重新按配置初始化 + 注册到上下文（AddEntity 自动清除回收标记）
            entity.Reinit(def, kind);
            this.ctx.AddEntity(entity);
        }
        return entity;
    }

    /** 回收实体：清状态 + 移出上下文（ctx 统一打回收标记并发事件）+ 回池 */
    release(entity: Entity): void {
        this.ctx.RemoveEntity(entity);
        entity.ResetForPool();
        // 按单位配置 id 分桶（同类型怪物可复用）
        let list = this.pools.get(entity.id);
        if (!list) {
            list = [];
            this.pools.set(entity.id, list);
        }
        list.push(entity);
    }

    /** 池中当前空闲数量（调试用） */
    idleCount(unitId?: number): number {
        if (unitId !== undefined) return this.pools.get(unitId)?.length ?? 0;
        let total = 0;
        for (const list of this.pools.values()) total += list.length;
        return total;
    }

    /** 清空所有池（场景销毁时调用；实体从上下文移除） */
    Clear(): void {
        for (const list of this.pools.values()) {
            for (const e of list) this.ctx.RemoveEntity(e);
        }
        this.pools.clear();
    }
}
