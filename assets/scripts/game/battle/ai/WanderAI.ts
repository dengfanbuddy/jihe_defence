import { MonsterAI } from './MonsterAI';

/**
 * WanderAI —— 闲逛型 AI
 *
 * 行为：不主动追击，在出生点附近随机游荡；
 *       英雄进入警戒半径后才切换为追击并攻击。
 * 可配参数：
 *   - wanderRadius: 闲逛范围（围绕出生点，默认 200）
 *   - changeDirInterval: 换向间隔秒（默认 2）
 *   - wanderSpeedMul: 闲逛速度倍率（默认 0.5）
 *   - aggroRange: 警戒半径，英雄进入后追击（默认 400）
 *   - chaseSpeedMul: 追击速度倍率（默认 1.2）
 */
export class WanderAI extends MonsterAI {
    /** 出生点（闲逛中心）——延迟到首次 update 记录（实体位置可能由外部在挂载后才设置） */
    private homeX = 0;
    private homeY = 0;
    private homeInited = false;
    /** 当前游荡方向（单位向量） */
    private dirX = 1;
    private dirY = 0;
    /** 是否已进入追击状态 */
    private aggro = false;

    override onAttach(): void {
        // 位置可能尚未由外部设置（如 spawnWave 在创建后才赋 position），延迟初始化 home
        this.homeInited = false;
        this.timer = Math.random() * this.getParam('changeDirInterval', 2);
    }

    /** 首次 update 时记录出生点（此时位置已由外部设置好） */
    private ensureHome(): void {
        if (this.homeInited) return;
        this.homeX = this.entity.position.x;
        this.homeY = this.entity.position.y;
        this.homeInited = true;
        const angle = Math.random() * Math.PI * 2;
        this.dirX = Math.cos(angle);
        this.dirY = Math.sin(angle);
    }

    update(dt: number): void {
        this.ensureHome();

        const target = this.findTarget();
        if (!target) return;

        const dist = this.distanceTo(target);

        // 英雄进入警戒范围 → 追击
        if (!this.aggro && dist <= this.getParam('aggroRange', 400)) {
            this.aggro = true;
        }

        // 追击状态：攻击 or 追上
        if (this.aggro) {
            const attackRange = this.entity.getAttackRange();
            if (dist <= attackRange) {
                this.tryAttack(target);
            } else {
                this.moveToward(target, dt, this.getParam('chaseSpeedMul', 1.2));
            }
            return;
        }

        // 闲逛：换向计时 + 随机偏转 + 限制在出生点附近
        this.timer -= dt;
        if (this.timer <= 0) {
            this.timer = this.getParam('changeDirInterval', 2);
            const angle = Math.atan2(this.dirY, this.dirX) + (Math.random() - 0.5) * 2.5;
            this.dirX = Math.cos(angle);
            this.dirY = Math.sin(angle);
        }

        // 超出闲逛半径 → 转向回家
        const fromHome = Math.hypot(this.entity.position.x - this.homeX, this.entity.position.y - this.homeY);
        if (fromHome > this.getParam('wanderRadius', 200)) {
            this.dirX = (this.homeX - this.entity.position.x) / fromHome;
            this.dirY = (this.homeY - this.entity.position.y) / fromHome;
        }

        this.moveDirection(this.dirX, this.dirY, dt, this.getParam('wanderSpeedMul', 0.5));
    }
}
