import type { Entity } from '../Entity';
import type { BattleContext } from '../BattleContext';

/**
 * ============================================================
 * MonsterAI —— 怪物 AI 脚本基类
 * ============================================================
 *
 * 设计目标：怪物的移动/攻击行为不写死在 GameManager 里，
 * 而是封装成独立的 AI 脚本对象，由 Entity.Tick 每帧驱动。
 *
 * 用法：
 *   1. 继承 MonsterAI，覆写 update(dt)（和可选的 onAttach/onDetach）
 *   2. 在 AIRegistry 注册：registerAI('chase', ChaseAI)
 *   3. units.json 怪物配置加 "ai": { "type": "chase", "params": {...} }
 *   4. BattleContext.CreateEntityFromDef 自动按配置创建 AI 挂到实体
 *
 * 基类提供的工具方法：
 *   - findTarget(team?)：找最近的敌对实体（默认 team=1 玩家方）
 *   - moveToward(target, dt, speed?)：向目标移动（可自定义速度/倍率）
 *   - tryAttack(target)：进入攻击距离时自动普攻（复用 Entity.Attack 冷却）
 *
 * 每个 AI 实例持有 entity + ctx，通过 entity.position 驱动移动，
 * 通过 entity.Attack 驱动攻击，完全与表现层解耦。
 */
export abstract class MonsterAI {
    /** 归属实体（怪物） */
    protected entity: Entity;
    /** 战斗上下文（访问实体表/伤害管线/事件总线） */
    protected ctx: BattleContext;
    /** AI 配置参数（units.json 的 ai.params） */
    protected params: Record<string, any>;

    /** 内部计时器（AI 子类自用） */
    protected timer = 0;

    constructor(entity: Entity, ctx: BattleContext, params?: Record<string, any>) {
        this.entity = entity;
        this.ctx = ctx;
        this.params = params ?? {};
    }

    /** 挂载时调用（子类可覆写做初始化） */
    onAttach(): void {}

    /** 卸载时调用（子类可覆写做清理） */
    onDetach(): void {}

    /** 每帧驱动（Entity.Tick 调用） */
    abstract update(dt: number): void;

    /* ============ 工具方法 ============ */

    /**
     * 查找最近的敌对目标（默认 team=1 玩家方英雄）
     * @param team 敌方队伍号
     */
    protected findTarget(team = 1): Entity | null {
        const enemies = this.ctx.GetTeamEntities(team);
        if (enemies.length === 0) return null;

        let nearest: Entity | null = null;
        let minDist = Infinity;
        for (const e of enemies) {
            const d = this.distanceTo(e);
            if (d < minDist) {
                minDist = d;
                nearest = e;
            }
        }
        return nearest;
    }

    /** 到某实体的距离 */
    protected distanceTo(e: Entity): number {
        const dx = e.position.x - this.entity.position.x;
        const dy = e.position.y - this.entity.position.y;
        return Math.hypot(dx, dy);
    }

    /** 到某点的距离 */
    protected distanceToPoint(x: number, y: number): number {
        const dx = x - this.entity.position.x;
        const dy = y - this.entity.position.y;
        return Math.hypot(dx, dy);
    }

    /**
     * 向目标移动
     * @param target 目标实体
     * @param dt 帧间隔
     * @param speedMul 速度倍率（默认 1，可被 Modifier 移速影响）
     * @param stopDistance 停止距离（小于该距离不再前进，默认 0）
     * @returns 是否正在移动（true=还在赶路）
     */
    protected moveToward(target: { position: { x: number; y: number } }, dt: number, speedMul = 1, stopDistance = 0): boolean {
        const dx = target.position.x - this.entity.position.x;
        const dy = target.position.y - this.entity.position.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= stopDistance) return false;

        const speed = this.entity.getMoveSpeed() * speedMul;
        const step = speed * dt;
        // 避免过冲
        const move = Math.min(step, dist);
        this.entity.position.x += (dx / dist) * move;
        this.entity.position.y += (dy / dist) * move;
        return true;
    }

    /** 朝某个方向移动 */
    protected moveDirection(dirX: number, dirY: number, dt: number, speedMul = 1): void {
        const len = Math.hypot(dirX, dirY);
        if (len <= 0) return;
        const speed = this.entity.getMoveSpeed() * speedMul;
        const step = speed * dt;
        this.entity.position.x += (dirX / len) * step;
        this.entity.position.y += (dirY / len) * step;
    }

    /**
     * 尝试攻击目标（进入攻击距离才攻击，复用 Entity.Attack 的普攻冷却）
     * @returns 是否发起了攻击
     */
    protected tryAttack(target: Entity | null): boolean {
        if (!target || target.IsDead()) return false;
        if (this.distanceTo(target) > this.entity.getAttackRange()) return false;
        return this.entity.Attack(target) > 0;
    }

    /** 获取参数（带默认值） */
    protected getParam<T>(key: string, fallback: T): T {
        return this.params[key] !== undefined ? this.params[key] as T : fallback;
    }
}
