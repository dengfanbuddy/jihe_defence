import { Node } from 'cc';
import { Entity, EntityPool, BattleContext } from '../../battle';
import type { UnitCfg } from '../../excel_table/Tb_UnitConfig';
import type { UnitKind } from '../../common/EntityVisualConfig';
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
 * 预制件路径：见下方 MONSTER_PREFAB（占位美术阶段所有怪共用同一个）
 * 节点分层：活着的挂 activeParent（如 monsterParent），
 *          死亡回收时移到 cacheParent（如 monsterCacheParent）并隐藏。
 *
 * 用法（Scene_Game_Stage）：
 *   this.monsterPool = new MonsterPool(this.ctx, this.monsterParent, this.monsterCacheParent);
 *   const m = this.monsterPool.acquire(def);          // 逻辑+表现一次搞定
 *   this.monsterPool.release(m);                      // 先还表现再还逻辑，内部保证
 */

/**
 * 占位美术：所有怪共用同一个预制件（只有缩放/配色不同，见 EntityVisualConfig）。
 *
 * 恢复"每只怪各自的预制件"时：
 *   1. 删掉本常量与 applyPlaceholderBody()
 *   2. acquire 里改回：`const prefabPath = def.prefab ?? \`prefabs/units/monster_${def.id}\``
 *   （逻辑侧的碰撞半径会随之回到 units.json 的 collision_radius，无需再改别处）
 */
const MONSTER_PREFAB = 'prefabs/unit/monsters/one';

/**
 * 占位预制件 one 的 UITransform 是 20×20 → 世界半径 10。
 *
 * 为什么需要一个"占位半径"：占位阶段所有怪长得一样大，体型差异**只来自类别缩放**；
 * 而 units.json 的 collision_radius（10/24/18/26/40…）是按各自美术尺寸配的，
 * 现在直接拿来用会把两只同样大的怪推开一大段空隙（看着没挨着却被推开）。
 * 因此基础半径改用占位图半径，实际半径 = 占位半径 × 类别缩放（Entity.SetUnitKind），
 * 屏幕上看到的间距 == 逻辑上的推距。
 */
const MONSTER_PREFAB_RADIUS = 10;

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
     * @param def 单位配置（奖励/属性/AI；预制件当前统一走 MONSTER_PREFAB）
     * @param kind 表现类别（可选）：缺省由配置解析；阶段/最终 Boss 由调用方显式传入
     *             —— 它同时决定配色/缩放与碰撞半径（推距），见 EntityVisualConfig
     * @returns 逻辑实体（已绑定 view，节点挂在 activeParent 下）
     */
    acquire(def: UnitCfg, kind?: UnitKind): Entity {
        const entity = this.entityPool.acquire(def, kind);
        // 占位美术：体型只由缩放决定，碰撞半径按占位图半径重算（保证推距与画面一致）
        this.applyPlaceholderBody(entity, kind);
        this.viewPool.acquire(entity, MONSTER_PREFAB, this.activeParent);
        return entity;
    }

    /** 占位美术阶段：把基础碰撞半径换成占位图半径，再按类别缩放重算实际半径 */
    private applyPlaceholderBody(entity: Entity, kind?: UnitKind): void {
        entity.baseCollisionRadius = MONSTER_PREFAB_RADIUS;
        entity.SetUnitKind(kind ?? entity.unitKind);
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
