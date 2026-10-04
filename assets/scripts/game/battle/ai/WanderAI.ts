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
 *   - aggroAfter: **兜底**——闲逛满这么多秒后无条件进入追击（默认 0 = 关闭）
 *
 * ⚠ 为什么需要 `aggroAfter`：本作的英雄**固定居中不动**，怪却从 650~800px 的外圈刷新。
 *   只靠 `aggroRange`（从「怪 → 英雄」的距离判定）永远触发不了 —— 怪就在屏幕边缘闲逛，
 *   英雄打不到它、它也打不到英雄，变成**完全不可交互的装饰**。
 *   想让"闲逛"在这个结构下仍然成立，就必须给一个时间兜底。
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
    /** 已经闲逛了多久（`aggroAfter` 兜底用） */
    private wanderElapsed = 0;

    override onAttach(): void {
        // 位置可能尚未由外部设置（如 spawnWave 在创建后才赋 position），延迟初始化 home
        this.homeInited = false;
        this.wanderElapsed = 0;
        this.aggro = false;
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
        // 兜底：闲逛满 aggroAfter 秒也强制追击（见类注释 —— 英雄不动 + 外圈刷新时，
        // 只靠 aggroRange 会让怪永远待在屏幕边缘，变成不可交互的装饰）
        this.wanderElapsed += dt;
        const aggroAfter = this.getParam('aggroAfter', 0);
        if (!this.aggro
            && (dist <= this.getParam('aggroRange', 400)
                || (aggroAfter > 0 && this.wanderElapsed >= aggroAfter))) {
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
