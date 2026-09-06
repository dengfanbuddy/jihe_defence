import { Ability } from './Ability';
import { DamageType } from './types';
import type { BattleContext } from './BattleContext';

/**
 * 复杂技能示例 —— 配置 + 脚本混合模型的"脚本逃逸口"
 *
 * 当配置化 effects 无法表达复杂逻辑时（弹射/变身/偷取/自定义流程），
 * 继承 Ability 覆写 OnCast，并在游戏启动时注册：
 *
 *   ctx.scriptRegistry.registerClass('Ability_LightningChain', Ability_LightningChain);
 *
 * 然后在 abilities.xlsx 中把该技能的 script_id 设为 'Ability_LightningChain'。
 */

/** 闪电链：对主目标造成伤害，并弹射至 3 个额外目标（每次衰减 30%） */
export class Ability_LightningChain extends Ability {
    OnCast(target?: any, _point?: { x: number; y: number }): void {
        const caster = this.caster;
        const ctx: BattleContext = caster.ctxRef;
        if (!target || target.IsDead()) return;

        const baseDamage = 60;
        const bounceCount = 3;
        const decay = 0.7;
        const targetTeam = target.team; // 弹射在目标同队单位之间进行

        let current = target;
        let damage = baseDamage;
        const hit = new Set([current.id]);

        for (let i = 0; i <= bounceCount; i++) {
            // 主目标 + 弹射
            ctx.damagePipeline.ApplyDamage(current, caster, damage, DamageType.Magical, { ability: this });
            if (i >= bounceCount) break;

            // 找下一个最近的未命中同队目标（弹射链）
            let next: any = null;
            let bestDist = Infinity;
            for (const e of ctx.GetTeamEntities(targetTeam)) {
                if (e.id === caster.id || hit.has(e.id) || e.IsDead()) continue;
                const dx = (e.position.x - current.position.x);
                const dy = (e.position.y - current.position.y);
                const d = dx * dx + dy * dy;
                if (d < bestDist) {
                    bestDist = d;
                    next = e;
                }
            }
            if (!next) break;
            hit.add(next.id);
            current = next;
            damage *= decay;
        }
    }
}
