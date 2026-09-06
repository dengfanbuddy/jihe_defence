import type { Entity } from './Entity';

/**
 * ============================================================
 * SpatialGrid —— 均匀网格空间哈希（实体分离 / 近邻查询）
 * ============================================================
 *
 * 为什么需要：俯视角 swarm 类战斗里，每帧对"所有实体两两"做距离判断是
 * O(n²)；当怪群规模到几十上百时，用均匀网格把近邻查询降到近似 O(n)。
 *
 * 原理：把世界切成固定大小的格子 cellSize，实体按 (position.x, position.y)
 * 落格；查询某实体周围 3x3 格子即可拿到"可能重叠"的候选集，再做精确距离
 * 判断。配合实体分离算法使用。
 *
 * 注意：
 *   - 网格只存引用，不复制位置；每帧开始时 clear() + reinsert() 即可
 *   - 格子内实体随帧移动后网格变"陈旧"，但分离时只用它做候选集（松散上界），
 *     精确判定仍在调用方做 —— 因此陈旧不影响正确性
 *
 * 用法（BattleContext.separateEntities）：
 *   this.spatialGrid.setCellSize(cellSize);
 *   this.spatialGrid.clear();
 *   for (const e of alive) this.spatialGrid.insert(e);
 *   const candidates = this.spatialGrid.getNeighbors(entity);
 */
export class SpatialGrid {
    private cellSize: number;
    /** 二维索引：cellX → (cellY → Entity[]) */
    private cells = new Map<number, Map<number, Entity[]>>();

    constructor(cellSize = 64) {
        this.cellSize = cellSize;
    }

    /** 设置格子边长（通常在 clear 前调用；重建会在下次 insert 时自然完成） */
    setCellSize(size: number): void {
        if (size <= 0) return;
        this.cellSize = size;
    }

    /** 清空全部格子（每帧重建前调用） */
    clear(): void {
        this.cells.clear();
    }

    /** 插入一个实体（按其当前 position 落格） */
    insert(entity: Entity): void {
        const { cx, cy } = this.cellOf(entity.position.x, entity.position.y);
        let col = this.cells.get(cx);
        if (!col) {
            col = new Map<number, Entity[]>();
            this.cells.set(cx, col);
        }
        let arr = col.get(cy);
        if (!arr) {
            arr = [];
            col.set(cy, arr);
        }
        arr.push(entity);
    }

    /**
     * 查询某实体周围 3x3 格子内的所有候选实体（可能包含自己）。
     * 返回的是松散上界，需再由调用方做精确的距离判断。
     */
    getNeighbors(entity: Entity): Entity[] {
        const { cx, cy } = this.cellOf(entity.position.x, entity.position.y);
        const res: Entity[] = [];
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
            const col = this.cells.get(ix);
            if (!col) continue;
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                const arr = col.get(iy);
                if (!arr) continue;
                for (let k = 0; k < arr.length; k++) res.push(arr[k]);
            }
        }
        return res;
    }

    /** 世界坐标 → 格子里坐标（向下取整，负坐标也正确） */
    private cellOf(x: number, y: number): { cx: number; cy: number } {
        return {
            cx: Math.floor(x / this.cellSize),
            cy: Math.floor(y / this.cellSize),
        };
    }
}
