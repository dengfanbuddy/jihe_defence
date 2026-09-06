import { _decorator, instantiate, Node, NodePool, Prefab, resources } from 'cc';
import { Projectile } from '../../battle';
import { ProjectileView } from './ProjectileView';
const { ccclass } = _decorator;

/**
 * ============================================================
 * ProjectileViewPool —— 弹道表现层对象池
 * ============================================================
 *
 * 与逻辑 Projectile（两阶段结算）配对：
 *   - 发射时 acquire：取节点 + ProjectileView.bind(projectile)
 *   - 命中回收时 release：unbind + 移到 cacheParent 隐藏 + NodePool.put
 *
 * 预制件路径：由调用方传入（技能/普攻配置里配置的 projectile_prefab）
 * 节点分层：活的挂 activeParent（projectileParent），回收移到 cacheParent（projectileCacheParent）
 *
 * 用法（Scene_Game_Stage）：
 *   this.projectilePool.acquire(p, 'prefabs/projectiles/shuriken', this.projectileParent);
 *   // 弹道命中（OnProjectileHit 事件）时：
 *   this.projectilePool.release(p, this.projectileCacheParent);
 */
@ccclass('ProjectileViewPool')
export class ProjectileViewPool {
    private pools = new Map<string, NodePool>();
    private prefabCache = new Map<string, Prefab>();
    /** 活跃弹道视图：projectile.id → ProjectileView */
    private activeViews = new Map<number, ProjectileView>();

    /**
     * 取一个弹道视图并绑定逻辑弹道
     * @param projectile 逻辑弹道（已由 BattleContext.spawnProjectile 发射）
     * @param prefabPath 弹道预制件路径（来自技能/单位配置）
     * @param activeParent 活跃父节点（projectileParent）
     * @param cb 异步加载完成回调
     */
    acquire(projectile: Projectile, prefabPath: string, activeParent: Node, cb?: (view: ProjectileView) => void): void {
        const projRef = projectile;
        // 标记弹道"飞行中"（release 时置 false；回调据此判断是否还该创建视图）
        (projectile as any)._viewAlive = true;

        this.getPrefab(prefabPath, (prefab) => {
            if (!prefab) {
                console.error(`[ProjectileViewPool] 预制件加载失败: ${prefabPath}`);
                return;
            }
            // 竞态防护：异步加载期间弹道已命中回收 → 放弃创建
            if (!(projRef as any)._viewAlive) return;

            let pool = this.pools.get(prefabPath);
            if (!pool) {
                pool = new NodePool();
                this.pools.set(prefabPath, pool);
            }
            let node = pool.get();
            if (!node) {
                node = instantiate(prefab);
            }
            node.parent = activeParent;
            node.active = true;

            let view = node.getComponent(ProjectileView);
            if (!view) view = node.addComponent(ProjectileView);
            view.bind(projRef, prefabPath);

            this.activeViews.set(projRef.id, view);
            cb?.(view);
        });
    }

    /**
     * 回收弹道视图
     * @param projectile 逻辑弹道（命中后）
     * @param cacheParent 缓存父节点（projectileCacheParent）
     */
    release(projectile: Projectile, cacheParent?: Node): void {
        // 先置飞行标记为 false（异步 acquire 回调据此放弃创建）
        (projectile as any)._viewAlive = false;

        const view = this.activeViews.get(projectile.id);
        if (!view) return; // 视图尚未创建（异步加载中）→ 回调会看到标记并放弃
        this.activeViews.delete(projectile.id);

        const prefabPath = view.prefabPath || '';
        const node = view.node;
        view.unbind();

        const pool = this.pools.get(prefabPath);
        if (pool) {
            node.active = false;
            if (cacheParent) node.parent = cacheParent;
            else node.removeFromParent();
            pool.put(node);
        } else {
            node.destroy();
        }
    }

    /** 当前活跃弹道视图数（调试用） */
    activeCount(): number {
        return this.activeViews.size;
    }

    /**
     * 预加载一批弹道预制件到缓存（战斗开始前调用）
     * @param paths 弹道预制件路径列表
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

    /** 释放弹道预制件缓存（战斗结束时调用） */
    releasePrefabs(): void {
        for (const pool of this.pools.values()) pool.clear();
        this.pools.clear();
        this.prefabCache.clear();
        for (const view of this.activeViews.values()) {
            if (view?.node) view.node.destroy();
        }
        this.activeViews.clear();
    }

    /** 清空（场景销毁时调用） */
    Clear(): void {
        this.releasePrefabs();
    }

    // ============ 内部 ============

    private getPrefab(path: string, cb: (prefab: Prefab | null) => void): void {
        const cached = this.prefabCache.get(path);
        if (cached) {
            cb(cached);
            return;
        }
        resources.load(path, Prefab, (err, prefab) => {
            if (err) {
                console.error(`[ProjectileViewPool] 加载失败: ${path}`, err);
                cb(null);
                return;
            }
            this.prefabCache.set(path, prefab);
            cb(prefab);
        });
    }
}
