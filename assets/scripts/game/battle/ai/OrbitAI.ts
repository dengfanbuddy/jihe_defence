import { MonsterAI } from './MonsterAI';

/**
 * OrbitAI —— 环绕型 AI
 *
 * 行为：围绕英雄保持固定半径旋转（走位风筝），
 *       每隔一段时间靠近攻击一次，然后拉开继续绕。
 * 可配参数：
 *   - orbitRadius: 环绕半径（默认 250）
 *   - angularSpeed: 角速度 rad/s（默认 1.5，正=顺时针，负=逆时针）
 *   - attackInterval: 攻击间隔秒（默认 3，每隔多久靠近打一次）
 *   - attackLeash: 攻击时允许进入的距离（默认 = 攻击距离）
 */
export class OrbitAI extends MonsterAI {
    /** 当前环绕角（相对英雄） */
    private angle = 0;
    /** 攻击窗口计时 */
    private attackTimer = 0;

    override onAttach(): void {
        this.angle = Math.random() * Math.PI * 2;
        this.attackTimer = this.getParam('attackInterval', 3) * (0.5 + Math.random() * 0.5);
    }

    update(dt: number): void {
        const target = this.findTarget();
        if (!target) return;

        const orbitRadius = this.getParam('orbitRadius', 250);
        const dist = this.distanceTo(target);

        // 攻击窗口：每隔 attackInterval 秒靠近打一波
        this.attackTimer -= dt;
        if (this.attackTimer <= 0 && dist > this.entity.getAttackRange()) {
            this.moveToward(target, dt, 1.6);
            if (this.distanceTo(target) <= this.entity.getAttackRange()) {
                this.tryAttack(target);
                this.attackTimer = this.getParam('attackInterval', 3);
            }
            return;
        }

        // 攻击窗口内且已在攻击距离 → 直接打
        if (this.attackTimer <= 0) {
            if (this.tryAttack(target)) {
                this.attackTimer = this.getParam('attackInterval', 3);
            }
            return;
        }

        // 常规环绕：围绕目标转圈（只走切向，保持半径）
        const toTargetX = target.position.x - this.entity.position.x;
        const toTargetY = target.position.y - this.entity.position.y;
        const curDist = Math.hypot(toTargetX, toTargetY) || 1;

        // 半径偏差 → 微调径向（拉回/推出）
        const radialX = toTargetX / curDist;
        const radialY = toTargetY / curDist;
        const radialPull = (curDist - orbitRadius) * 0.5;
        this.entity.position.x += radialX * radialPull * dt;
        this.entity.position.y += radialY * radialPull * dt;

        // 切向旋转（环绕）
        const angular = this.getParam('angularSpeed', 1.5);
        // 切向单位向量（垂直径向，顺时针）
        const tanX = -radialY;
        const tanY = radialX;
        this.moveDirection(tanX * angular, tanY * angular, dt, 1);
    }
}
