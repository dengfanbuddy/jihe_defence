import { Node } from 'cc';
import { Entity, EntityPool, BattleContext } from '../../battle';
import type { UnitCfg } from '../../excel_table/Tb_UnitConfig';
import { EntityView } from './EntityView';
import { EntityViewPool } from './EntityViewPool';

/**
 * ============================================================
 * MonsterPool —— 怪物统一对象池（场景层唯一入口）
 * ============================================================
 *
 * 组合编排两个池（配对逻辑收敛到一处，场景层不再关心顺序）：
 *   - EntityPool（battle/ 纯逻辑）：按 unitId 分桶复用逻辑实体
 *   - EntityViewPool（表现层）：按预制件路径分桶复用节点 + EntityView
 *
 * 预制件路径：从 UnitCfg.prefab 配置读取（配置驱动，不再硬编码）
 * 节点分层：活着的挂 activeParent（如 monsterParent），
 *          死亡回收时移到 cacheParent（如 monsterCacheParent）并隐藏。
 *
 * 用法（Scene_Game_Stage）：
 *   this.monsterPool = new MonsterPool(this.ctx, this.monsterParent, this.monsterCacheParent);
 *   const m = this.monsterPool.acquire(def);          // 逻辑+表现一次搞定
 *   this.monsterPool.release(m);                      // 先还表现再还逻辑，内部保证
 */
export class MonsterPool {
    private entityPool: EntityPool;
    private viewPool: EntityViewPool;
    private activeParent: Node;
    private cacheParent: Node;

    constructor(ctx: BattleContext, activeParent: Node, cacheParent: Node) {
        this.entityPool = new EntityPool(ctx);
        this.viewPool = new EntityViewPool();
        this.activeParent = activeParent;
        this.cacheParent = cacheParent;
    }

    /**
     * 取一只怪物：逻辑实体 + 表现节点同时出池并绑定
     * @param def 单位配置（prefab 字段决定预制件路径）
     * @returns 逻辑实体（已绑定 view，节点挂在 activeParent 下）
     */
    acquire(def: UnitCfg): Entity {
        const entity = this.entityPool.acquire(def);
        const prefabPath = def.prefab ?? `prefabs/units/monster_${def.id}`;
        this.viewPool.acquire(entity, prefabPath, this.activeParent);
        return entity;
    }



    /** 回收一只怪物：先还表现节点（移到 cacheParent 隐藏），再还逻辑实体 */
    release(entity: Entity): void {
        this.viewPool.release(entity, this.cacheParent);
        this.entityPool.release(entity);
    }

    /** 当前活跃怪物数（表现视图数，调试用） */
    activeCount(): number {
        return this.viewPool.activeCount();
    }

    /** 逻辑池空闲数（调试用） */
    idleCount(unitId?: number): number {
        return this.entityPool.idleCount(unitId);
    }

    /** 按 uid 查询活跃视图（表现层读取/特效挂载） */
    getView(uid: number): EntityView | undefined {
        return this.viewPool.getView(uid);
    }

    /** 预加载怪物预制件到缓存（战斗开始前调用，避免首帧卡顿） */
    preload(paths: string[], cb?: (loaded: number, total: number) => void): void {
        this.viewPool.preload(paths, cb);
    }

    /** 释放预制件缓存（战斗结束时调用，资源可回收） */
    releasePrefabs(): void {
        this.viewPool.releasePrefabs();
    }

    /** 清空两个池（场景重开时调用） */
    Clear(): void {
        this.viewPool.Clear();
        this.entityPool.Clear();
    }
}
