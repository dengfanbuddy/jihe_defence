import { BattleEvents, DamageType, StateType } from './types';
import type { ConfigAction } from '../excel_table/Tb_AbilityConfig';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * Projectile —— 弹道实体（两阶段结算的核心）
 * ============================================================
 * 发射时不立即结算伤害，而是创建弹道：
 *   - Tick 按弹速推进（飞行时间 = 距离 / 弹速）
 *   - 到达后 onHit() 重新校验（目标死亡/无敌/闪避）再结算
 *
 * 语义：
 *   - isAttack = true  → 普攻弹道：命中触发 on_attack_landed（吸血/偷钱/点燃）
 *   - isAttack = false → 技能弹道：命中只结算伤害 + OnProjectileHit
 * ============================================================
 */
export class Projectile {
    readonly id: number;
    source: any;
    target: any;
    speed: number;
    rawDamage: number;
    damageType: DamageType;
    /** 普攻弹道标记（命中触发攻击特效事件） */
    isAttack: boolean;
    ability?: any;
    /** 命中后执行的效果（多目标弹道：毒镖/冰霜等命中附加） */
    hitEffects?: ConfigAction[];
    /** 视图引用（表现层绑定：ProjectileView 组件，可为空） */
    view: any = null;

    /** 当前位置（逻辑层推进，表现层只读同步）——与 Entity.position 同构 */
    position: { x: number; y: number } = { x: 0, y: 0 };

    private ctx: BattleContext;
    private traveled = 0;
    private readonly totalDistance: number;
    /** 单位方向向量（起点 → 终点，归一化） */
    private readonly dirX: number;
    private readonly dirY: number;
    /** 终点快照（目标移动时弹道仍飞向原落点；需要追踪可改逻辑） */
    private readonly endX: number;
    private readonly endY: number;

    private static nextId = 1;

    constructor(params: {
        source: any;
        target: any;
        speed: number;
        damage: number;
        damageType: DamageType;
        isAttack?: boolean;
        ability?: any;
        hitEffects?: ConfigAction[];
        ctx: BattleContext;
    }) {
        this.id = Projectile.nextId++;
        this.source = params.source;
        this.target = params.target;
        this.speed = params.speed;
        this.rawDamage = params.damage;
        this.damageType = params.damageType;
        this.isAttack = params.isAttack ?? false;
        this.ability = params.ability;
        this.hitEffects = params.hitEffects;
        this.ctx = params.ctx;

        // 起点 = 发射瞬间 source 位置；终点 = target 位置快照
        const sx = params.source?.position?.x ?? 0;
        const sy = params.source?.position?.y ?? 0;
        this.endX = params.target?.position?.x ?? sx;
        this.endY = params.target?.position?.y ?? sy;
        this.position = { x: sx, y: sy };

        const dx = this.endX - sx;
        const dy = this.endY - sy;
        this.totalDistance = Math.hypot(dx, dy);
        if (this.totalDistance > 0) {
            this.dirX = dx / this.totalDistance;
            this.dirY = dy / this.totalDistance;
        } else {
            this.dirX = 0;
            this.dirY = 0;
        }
    }

    /** 弹道飞行进度 0~1（表现层可用来插值/特效进度） */
    getProgress(): number {
        if (this.totalDistance <= 0) return 1;
        return Math.min(1, this.traveled / this.totalDistance);
    }

    /** 每帧推进（位置 + 距离）；返回是否到达目标（到达后由 BattleContext 调用 onHit 并移除） */
    tick(dt: number): boolean {
        if (this.totalDistance <= 0) return true; // 距离为 0（同位置）→ 立即到达
        const step = this.speed * dt;
        this.traveled += step;
        // 推进逻辑位置（表现层只读跟随）
        this.position.x += this.dirX * step;
        this.position.y += this.dirY * step;
        return this.traveled >= this.totalDistance;
    }

    /** 命中时对齐终点（到达瞬间位置 == 终点，避免浮点误差） */
    snapToEnd(): void {
        this.position = { x: this.endX, y: this.endY };
    }

    /** 每帧更新（表现层由 ProjectileView.update 驱动；逻辑层无需额外动作） */
    Update(dt: number): void {
        this.tick(dt);
    }

    /**
     * 命中结算：重新校验目标状态（飞行期间可能变化），通过后才造成伤害。
     * @returns 实际伤害
     */
    onHit(): number {
        const t = this.target;
        if (!t) return 0;

        // ---- 飞行期间目标状态变化 → 落空 ----
        if (t.IsDead?.() || t.status?.get(StateType.Invulnerable)) {
            this.ctx.bus.publish(BattleEvents.OnProjectileMiss, { projectile: this, target: t, reason: 'dead_or_invulnerable' });
            return 0;
        }
        if (this.damageType === DamageType.Physical && t.status?.get(StateType.Ethereal)) return 0;
        if (this.damageType !== DamageType.Physical && t.status?.get(StateType.MagicImmune)) return 0;

        // ---- 普攻弹道：闪避判定 + 完整攻击命中流程（特效在命中时触发） ----
        if (this.isAttack) {
            const resolver = this.source?.resolveAttackHit;
            let dmg: number;
            if (!resolver) {
                dmg = this.ctx.damagePipeline.ApplyDamage(t, this.source, this.rawDamage, this.damageType, { ability: this.ability });
            } else {
                dmg = resolver.call(this.source, t, this.rawDamage, this.damageType, this.ability);
            }
            if (dmg <= 0) {
                this.ctx.bus.publish(BattleEvents.OnProjectileMiss, { projectile: this, target: t, reason: 'evaded_or_blocked' });
            } else {
                // 普攻命中统一发 OnProjectileHit（视图回收依赖此事件）
                this.ctx.bus.publish(BattleEvents.OnProjectileHit, { projectile: this, target: t, damage: dmg });
            }
            return dmg;
        }

        // ---- 技能弹道：直接结算 + 命中附加效果（毒镖/冰霜等）+ 命中事件 ----
        const dmg = this.ctx.damagePipeline.ApplyDamage(t, this.source, this.rawDamage, this.damageType, { ability: this.ability });
        if (this.hitEffects?.length) {
            for (const fx of this.hitEffects) {
                this.ctx.effects.execute(fx, { actor: this.source, target: t });
            }
        }
        this.ctx.bus.publish(BattleEvents.OnProjectileHit, { projectile: this, target: t, damage: dmg });
        return dmg;
    }
}
