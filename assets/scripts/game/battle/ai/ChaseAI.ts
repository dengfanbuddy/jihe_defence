import { MonsterAI } from './MonsterAI';

/**
 * ChaseAI —— 追击型 AI（默认怪物行为）
 *
 * 行为：直接朝英雄移动，进入攻击距离后自动普攻。
 * 可配参数：
 *   - speedMul: 移动速度倍率（默认 1）
 *   - attackRangeMul: 攻击距离倍率（默认 1，>1 可让怪提前攻击）
 */
export class ChaseAI extends MonsterAI {
    update(dt: number): void {
        const target = this.findTarget();
        if (!target) return;

        // 进入攻击距离 → 攻击
        const attackRange = this.entity.getAttackRange() * this.getParam('attackRangeMul', 1);
        const dist = this.distanceTo(target);
        if (dist <= attackRange) {
            this.tryAttack(target);
            return;
        }

        // 否则朝目标移动
        this.moveToward(target, dt, this.getParam('speedMul', 1));
    }
}
