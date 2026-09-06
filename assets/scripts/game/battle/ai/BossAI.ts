import { MonsterAI } from './MonsterAI';

/**
 * BossAI —— Boss 阶段机 AI
 *
 * Boss 特殊行为：按血量百分比切换阶段，每个阶段不同的移动/攻击策略，
 * 支持周期性施放技能（走 AbilitySystem，配置 abilities 即可）。
 *
 * 可配参数：
 *   - phases: 阶段定义数组（从高血量到低血量），每项：
 *       { hpRatio: 0.7, behavior: 'chase' | 'orbit' | 'attack_stop', ...该行为参数 }
 *     第一个阶段是 hpRatio 最高的（如 1.0），hp 低于该比例时进入该阶段。
 *   - skillInterval: 主动技能施放间隔秒（默认 0 = 不自动放技能）
 *   - skillId: 主动技能 id（如 'boss_breath'，需在 abilities.json 配置）
 */
export class BossAI extends MonsterAI {
    /** 阶段定义 */
    private phases: { hpRatio: number; behavior: string; params?: Record<string, any> }[] = [];
    /** 当前阶段索引 */
    private phaseIdx = 0;
    /** 技能施放计时 */
    private skillTimer = 0;
    /** 每个阶段切换时发布的标记（防止重复触发） */
    private phaseApplied = false;

    override onAttach(): void {
        this.phases = this.getParam('phases', []);
        // 按 hpRatio 降序排列（高血量在前）
        this.phases.sort((a, b) => b.hpRatio - a.hpRatio);
        if (this.phases.length === 0) {
            // 默认两阶段：70% 前正常追击，70% 后狂暴追击
            this.phases = [
                { hpRatio: 1.0, behavior: 'chase', params: { speedMul: 1 } },
                { hpRatio: 0.7, behavior: 'chase', params: { speedMul: 1.5 } },
            ];
        }
        this.skillTimer = this.getParam('skillInterval', 0);
        this.phaseIdx = 0;
        this.phaseApplied = false;
    }

    update(dt: number): void {
        const target = this.findTarget();
        if (!target) return;

        // 1. 阶段判定（按当前血量比例）
        const hpRatio = this.entity.getMaxHp() > 0 ? this.entity.hp / this.entity.getMaxHp() : 0;
        let idx = 0;
        for (let i = 0; i < this.phases.length; i++) {
            if (hpRatio <= this.phases[i].hpRatio) {
                idx = i;
                break;
            }
        }
        if (idx !== this.phaseIdx) {
            this.phaseIdx = idx;
            this.phaseApplied = false;
            console.log(`[BossAI] ${this.entity.name} 进入阶段 ${idx + 1} (HP ${Math.round(hpRatio * 100)}%)`);
        }

        // 阶段切换回调（子类可覆写，如进入狂暴时加 Modifier）
        if (!this.phaseApplied) {
            this.onPhaseChanged(this.phaseIdx);
            this.phaseApplied = true;
        }

        const phase = this.phases[this.phaseIdx];

        // 2. 主动技能（周期性，走 AbilitySystem 的 CastAbility）
        this.tryCastSkill(dt, target);

        // 3. 当前阶段行为
        this.executeBehavior(phase, dt, target);
    }

    /** 阶段切换钩子（子类覆写：给 Boss 加狂暴/护盾/召唤等） */
    protected onPhaseChanged(_phaseIdx: number): void {}

    /** 周期性施放主动技能 */
    private tryCastSkill(dt: number, target: any): void {
        const interval = this.getParam('skillInterval', 0);
        if (interval <= 0) return;

        this.skillTimer -= dt;
        if (this.skillTimer > 0) return;

        const skillId = this.getParam('skillId', '');
        if (skillId) {
            // 技能可能需要目标：默认最近敌人（team=1）
            this.entity.abilities.CastAbility(skillId, target);
        }
        this.skillTimer = interval;
    }

    /** 执行当前阶段行为（委托给对应 AI 逻辑） */
    private executeBehavior(phase: { behavior: string; params?: Record<string, any> }, dt: number, target: any): void {
        const p = phase.params ?? {};
        const dist = this.distanceTo(target);
        const attackRange = this.entity.getAttackRange();

        switch (phase.behavior) {
            case 'orbit': {
                // 环绕（简化版：切向旋转 + 半径保持）
                const radius = p.orbitRadius ?? 250;
                const angular = p.angularSpeed ?? 1.5;
                const dx = target.position.x - this.entity.position.x;
                const dy = target.position.y - this.entity.position.y;
                const cur = Math.hypot(dx, dy) || 1;
                const radialX = dx / cur, radialY = dy / cur;
                this.entity.position.x += radialX * (cur - radius) * 0.5 * dt;
                this.entity.position.y += radialY * (cur - radius) * 0.5 * dt;
                this.moveDirection(-radialY * angular, radialX * angular, dt, 1);
                // 半径内且技能冷却外 → 攻击
                if (cur <= radius && !this.entity.isAttackOnCooldown()) {
                    this.tryAttack(target);
                }
                break;
            }
            case 'attack_stop': {
                if (dist <= attackRange) {
                    if (this.tryAttack(target)) {
                        this.timer = p.stopDuration ?? 2;
                    } else if (this.timer <= 0) {
                        this.timer = p.stopDuration ?? 2;
                    }
                    this.timer -= dt;
                    // 停顿期间不动
                } else {
                    this.moveToward(target, dt, p.speedMul ?? 1);
                }
                break;
            }
            case 'chase':
            default: {
                if (dist <= attackRange) {
                    this.tryAttack(target);
                } else {
                    this.moveToward(target, dt, p.speedMul ?? 1);
                }
                break;
            }
        }
    }
}
