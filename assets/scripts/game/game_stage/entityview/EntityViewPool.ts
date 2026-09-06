import { _decorator, instantiate, Node, NodePool, Prefab, resources } from 'cc';
import { Entity } from '../../battle';
import { EntityView } from './EntityView';
const { ccclass } = _decorator;

/**
 * ============================================================
 * EntityViewPool —— 表现层对象池（预制件节点 + EntityView）
 * ============================================================
 *
 * 与 EntityPool（逻辑层）配对使用：
 *   - EntityPool 负责复用纯逻辑 Entity（省 GC）
 *   - 本池负责复用预制件节点 + 上面的 EntityView 组件（省 instantiate/destroy 开销）
 *
 * 节点分层：
 *   acquire 时节点挂到 activeParent（如 monsterParent，场上可见）
 *   release 时节点移到 cacheParent（如 monsterCacheParent）并隐藏，随后 NodePool.put
 *
 * 内部结构：
 *   - pools: Map<prefabPath, NodePool>    按预制件路径分桶
 *   - activeViews: Map<entity.uid, EntityView>  当前在场上活跃的视图（回收时按 uid 查找）
 *   - prefabCache: 已加载的 Prefab 缓存（避免重复 resources.load）
 */
@ccclass('EntityViewPool')
export class EntityViewPool {
    private pools = new Map<string, NodePool>();
    private prefabCache = new Map<string, Prefab>();
    /** 活跃视图表：entity.uid → EntityView（release 时按 uid 找） */
    private activeViews = new Map<number, EntityView>();

    /**
     * 取一个视图并绑定逻辑实体
     * @param entity 逻辑实体（须已从 EntityPool 取出）
     * @param prefabPath 预制件路径（同类型怪物共用一个）
     * @param activeParent 活跃节点父节点（挂载后可见）
     * @param cb 预制件异步加载完成回调（若预制件已缓存则同步回调）
     */
    acquire(entity: Entity, prefabPath: string, activeParent: Node, cb?: (view: EntityView) => void): void;
    acquire(entity: Entity, prefabPath: string, activeParent: Node | ((view: EntityView) => void), cb?: (view: EntityView) => void): void {
        // 兼容第三参传回调的调用（省略 activeParent）
        let parent: Node | null = null;
        let done = cb;
        if (typeof activeParent === 'function') {
            done = activeParent;
        } else {
            parent = activeParent;
        }

        // 记录本次 acquire 的实体，异步回调后用于存活校验
        const entityRef = entity;
        // 复位回收标记（release 时置 true；下次 acquire 重新绑定前必须清掉）
        (entity as any)._viewRecycled = false;

        // 预制件可能未加载完成 → 统一走异步
        this.getPrefab(prefabPath, (prefab) => {
            if (!prefab) {
                console.error(`[EntityViewPool] 预制件加载失败: ${prefabPath}`);
                return;
            }

            // 竞态防护：异步加载期间实体已被回收 → 直接放弃（不创建节点）
            if ((entityRef as any)._viewRecycled || entityRef.IsDead?.()) {
                return;
            }

            // 从对应桶取节点（无则实例化）
            let pool = this.pools.get(prefabPath);
            if (!pool) {
                pool = new NodePool();
                this.pools.set(prefabPath, pool);
            }
            let node = pool.get();
            if (!node) {
                node = instantiate(prefab);
            }

            if (parent) node.parent = parent;
            else node.removeFromParent();
            node.active = true;

            // 获取/挂载 EntityView 组件并绑定
            let view = node.getComponent(EntityView);
            if (!view) view = node.addComponent(EntityView);
            view.bind(entityRef, prefabPath);

            // 记录活跃视图（回收时按 uid 查找）
            this.activeViews.set(entityRef.uid, view);
            done?.(view);
        });
    }

    /**
     * 回收视图：解除绑定 + 隐藏 + 移到 cacheParent + 回节点池
     * @param entity 逻辑实体（与 acquire 时同一个）
     * @param cacheParent 缓存节点父节点（隐藏的池化节点挂这里）
     */
    release(entity: Entity, cacheParent?: Node): void {
        // 无论视图是否已创建，先打回收标记（异步 acquire 回调据此放弃）
        (entity as any)._viewRecycled = true;

        const view = this.activeViews.get(entity.uid);
        if (!view) return; // 视图尚未创建（异步加载中）→ 回调会看到标记并放弃
        this.activeViews.delete(entity.uid);

        const prefabPath = view.prefabPath || '';
        const node = view.node;
        view.unbind();

        // 回节点池（有对应桶则 put，否则直接销毁兜底）
        const pool = this.pools.get(prefabPath);
        if (pool) {
            node.active = false;
            // 移到缓存父节点（隐藏），保持节点层级干净
            if (cacheParent) node.parent = cacheParent;
            else node.removeFromParent();
            pool.put(node);
        } else {
            node.destroy();
        }
    }

    /** 当前活跃视图数（调试用） */
    activeCount(): number {
        return this.activeViews.size;
    }

    /** 按 uid 查询当前活跃视图（调试/表现层读取） */
    getView(uid: number): EntityView | undefined {
        return this.activeViews.get(uid);
    }

    /**
     * 预加载一批预制件到缓存（战斗开始前调用，避免战斗中首帧卡顿）
     * @param paths 预制件路径列表（本局可能用到的单位/弹道）
     * @param cb 全部加载完成回调（成功数, 总数）
     */
    preload(paths: string[], cb?: (loaded: number, total: number) => void): void {
        const unique = Array.from(new Set(paths));
        let loaded = 0;
        let done = 0;
        const finish = () => {
            done++;
            if (done >= unique.length) cb?.(loaded, unique.length);
        };
        for (const p of unique) {
            this.getPrefab(p, (prefab) => {
                if (prefab) loaded++;
                finish();
            });
        }
    }

    /** 释放预制件缓存（战斗结束时调用；节点池一并清空，资源可回收） */
    releasePrefabs(): void {
        // 清空节点池（池中节点销毁）
        for (const pool of this.pools.values()) pool.clear();
        this.pools.clear();
        // 清空预制件缓存（释放 resources 引用）
        this.prefabCache.clear();
        // 残留活跃视图的节点销毁
        for (const view of this.activeViews.values()) {
            if (view?.node) view.node.destroy();
        }
        this.activeViews.clear();
    }

    /** 清空所有池与视图（场景销毁时调用） */
    Clear(): void {
        this.releasePrefabs();
    }

    // ============ 内部 ============

    /** 加载预制件（带缓存；回调风格兼容异步） */
    private getPrefab(path: string, cb: (prefab: Prefab | null) => void): void {
        const cached = this.prefabCache.get(path);
        if (cached) {
            cb(cached);
            return;
        }
        resources.load(path, Prefab, (err, prefab) => {
            if (err) {
                console.error(`[EntityViewPool] 加载失败: ${path}`, err);
                cb(null);
                return;
            }
            this.prefabCache.set(path, prefab);
            cb(prefab);
        });
    }
}
