import { MonsterAI } from './MonsterAI';

/**
 * AttackStopAI —— 攻击停顿型 AI（"攻击后停几秒"）
 *
 * 行为：靠近英雄 → 攻击 → 攻击后停顿数秒（原地不动，不追击）
 *       → 停顿结束继续靠近攻击。制造"一下一下"的节奏感。
 * 可配参数：
 *   - stopDuration: 攻击后停顿秒数（默认 2）
 *   - speedMul: 追击速度倍率（默认 1）
 *   - stopWhenHit: 是否攻击命中后才停顿（默认 false，发起攻击即停）
 */
export class AttackStopAI extends MonsterAI {
    /** 当前是否处于停顿 */
    private stopped = false;

    update(dt: number): void {
        const target = this.findTarget();
        if (!target) return;

        // 停顿中：只计时，不动不攻击
        if (this.stopped) {
            this.timer -= dt;
            if (this.timer <= 0) {
                this.stopped = false;
            }
            return;
        }

        const dist = this.distanceTo(target);
        const attackRange = this.entity.getAttackRange();

        if (dist <= attackRange) {
            // 攻击前短暂蓄力（可选参数）
            const windup = this.getParam('windupTime', 0);
            if (windup > 0) {
                this.timer -= dt;
                if (this.timer > 0) return; // 蓄力中不动
                this.timer = windup;
            }
            const attacked = this.tryAttack(target);
            if (attacked || !this.getParam('stopWhenHit', false)) {
                this.stopped = true;
                this.timer = this.getParam('stopDuration', 2);
            }
            return;
        }

        // 追击
        this.moveToward(target, dt, this.getParam('speedMul', 1));
    }
}
