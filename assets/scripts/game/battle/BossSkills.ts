import { DamageType } from './types';
import { HitShapeKind } from '../common/HitFeelConfig';
import { publishSkillShape, shapeDirection } from './SkillShape';
import { BattleConstUtil } from './core/BattleConstUtil';
import { Projectile } from './Projectile';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * BossSkills —— Boss 技能的**动作脚本**（`units.json` 的 `ai.params.skills` 指到 abilities.json，
 * abilities 的 effects 里用 `execute_script` 指到这里）
 * ============================================================
 *
 * ── 为什么 Boss 的技能必须是脚本而不是纯声明式 ──
 *   声明式的 `damage` / `aoe_damage` 吃的是**固定数值**（abilities.json 的 `value`），
 *   而 Boss 的强度会随「难度档位 × 刷新点曲线 × 阶段成长」三处相乘 —— 到最终 Boss 那一刻
 *   已经是基础值的 5~6 倍。写死 60 点的火球在 15000 血的 Boss 身上等于没有技能，
 *   写死 600 点又会在难度 1 的第一只 Boss 身上把人秒了。
 *   ⇒ Boss 技能的伤害一律按**施法者自己的攻击力**换算（`pct` 是百分数：120 = 攻击力 ×120%），
 *     与遗物/神器的既有口径一致（`RelicHooks.atkPct`）。
 *
 * ── 三条口径 ──
 *   ① **伤害走 `damagePipeline`**（不自己扣血）：护甲/魔抗/受伤减免/暴击才不会漏。
 *   ② **形态必须上报**（`publishSkillShape`）：这两个技能都是"看不见的作用范围"，
 *      不上报就是"玩家莫名其妙掉了一格血"。扇形的半角与半径**与实际结算几何同源**
 *      （用同一个 `halfAngleDeg` / `radiusM` 既筛人又画图），不会出现"画 60° 打 90°"。
 *   ③ **只打敌对队伍**：`findEntitiesInRadius(center, radius, teamFilter)` 的第三个参数是
 *      **teamFilter（只保留 `e.team === teamFilter`）**，不是"排除"。所以这里必须传
 *      **施法者的敌对队伍**（`actor.team === 1 ? 2 : 1`）。
 *      ⚠ **2026-11 修过一处真 bug**：这里原先写死 `2`，而 `2` 就是**怪物侧**（Boss 自己也是 team 2）
 *      ⇒ 扇形咆哮 / 深渊诅咒结算的是「Boss 自己 + 身边的小怪」（还附带一次自伤），
 *      **英雄一次都吃不到** —— 表现就是"最终 Boss 那两个技能完全没有威胁"。
 *      判据（与全工程一致的取法）：`RelicHooks.enemies()` 用 `GetTeamEntities(2)` 取敌人、
 *      `BattleContext` 用 `GetTeamEntities(1)` 取英雄 ⇒ 英雄 1 / 怪物 2，Boss 想打英雄就要传 1。
 *
 * 注册：`Scene_Game_Stage.initBattle` 里 `BOSS_SKILL_ACTIONS` 一次性注册
 * （`scriptRegistry.registerAction`，与 `SPECIAL_BUFF_SCRIPT_CLASSES` 同一处）。
 */

/** kv 读取（配表里漏字段/null 都是常态，`Number(null)` 是 0 会静默把效果变成 0） */
function kvNum(kv: Record<string, any> | undefined, key: string, fallback: number): number {
    const raw = kv?.[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
}

/**
 * 米 → 像素。
 *
 * ⚠ **唯一口径是 `battle_constants.pxPerMeter`（现 50）**，不要在配表里写像素 ——
 *   本文件不用 `ShopSkillModifiers` 那份 `meters()`（它 import 了整条商店管线），
 *   而是直接问 `BattleConstUtil`（同一个真源，两条读取路径）。
 */
function meters(m: number): number {
    return m * BattleConstUtil.getPxPerMeter();
}

/** 未配置 / 未指定时的扇形半角（度）—— 40° 半角 = 80° 扇面，读起来是一个"正前方"的动作 */
const DEFAULT_FAN_HALF_ANGLE = 40;

/**
 * **深渊火球**（`boss_fireball`）：朝技能目标发射一枚弹道，伤害 = 施法者攻击力 × `pct`。
 *
 * kv：`{ pct, modifier, duration, speed }`
 *   · `pct`      伤害百分数（120 = 攻击力 ×120%）
 *   · `modifier` 命中后挂在**目标**（英雄）身上的 Modifier id（0/缺省 = 不挂）
 *   · `duration` 上面那条 Modifier 的持续（秒）
 *   · `speed`    弹速（像素/秒，缺省 900）
 *
 * 为什么用弹道而不是即时伤害：① "看得见的一发火球"是 Boss 唯一的远程语言；
 * ② `Projectile` 自带"飞行期间目标死了/无敌了 → 落空"的复检（`onHit` 里那三段），
 * 即时伤害没有这一层。
 */
export function bossFireball(actor: any, _self: any, action: any, context?: any): void {
    const ctx: BattleContext | undefined = actor?.ctxRef;
    const target = context?.target ?? _self?.target;
    if (!ctx || !actor || !target) return;
    if (target.IsDead?.()) return;

    const kv = action?.kv ?? {};
    const atk = actor.getAttackDamage?.() ?? 0;
    const pct = kvNum(kv, 'pct', 120);
    const dmg = Math.max(1, Math.round(atk * pct / 100));
    const speed = Math.max(1, kvNum(kv, 'speed', 900));
    const modId = Math.floor(kvNum(kv, 'modifier', 0));
    const duration = kvNum(kv, 'duration', 6);

    ctx.spawnProjectile(new Projectile({
        source: actor,
        target,
        speed,
        damage: dmg,
        damageType: DamageType.Magical,
        hitEffects: modId > 0
            ? [{ type: 'apply_modifier', modifier: modId, duration, kv: kv } as any]
            : undefined,
        ctx,
    }));
}

/**
 * **范围咆哮 / 诅咒**（`boss_cast`）：以施法者为顶点，按 `shape` 决定的作用域结算伤害 + 挂 debuff，
 * 并**把作用域原样上报给表现层**（爆炸环 / 扇形扩散）。
 *
 * kv：
 *   · `shape`        `'fan'` 扇形（缺省）| `'blast'` 圆形
 *   · `radiusM`      作用半径（**米**，唯一换算口径 `battle_constants.pxPerMeter`）
 *   · `halfAngleDeg` 扇形半角（度；只有 fan 用，缺省 40）
 *   · `pct`          伤害百分数（0 = 纯 debuff）
 *   · `modifier`     挂在命中目标身上的 Modifier id（0 = 不挂）
 *   · `duration`     上面那条 Modifier 的持续（秒）
 *
 * 为什么几何要**先算一次再喂两处**：筛选与画图各算一遍就会漂移（改了一处忘了另一处），
 * 而"画了 80° 却打了 120°"是玩家一眼能看出来、代码里却查不出来的那类 bug。
 */
export function bossCast(actor: any, _self: any, action: any, context?: any): void {
    const ctx: BattleContext | undefined = actor?.ctxRef;
    if (!ctx || !actor) return;

    const kv = action?.kv ?? {};
    const target = context?.target ?? null;
    const radius = meters(kvNum(kv, 'radiusM', 3.6));
    if (!(radius > 0)) return;

    const shapeRaw = kv?.shape;
    const shapeName = String(
        shapeRaw === undefined || shapeRaw === null || shapeRaw === '' ? 'fan' : shapeRaw,
    ).toLowerCase();
    const isFan = shapeName !== 'blast';
    const halfAngleDeg = Math.max(1, Math.min(180, kvNum(kv, 'halfAngleDeg', DEFAULT_FAN_HALF_ANGLE)));
    const halfAngleRad = (halfAngleDeg * Math.PI) / 180;

    const cx = actor.position?.x ?? 0;
    const cy = actor.position?.y ?? 0;
    // 没有目标时朝"英雄默认站位"（场景中心）—— 保证扇形永远有一个可见朝向
    const dir = target && target.position
        ? shapeDirection(actor, target)
        : normalizeDir(-cx, -cy);

    const atk = actor.getAttackDamage?.() ?? 0;
    const pct = kvNum(kv, 'pct', 0);
    const dmg = pct > 0 ? Math.max(1, Math.round(atk * pct / 100)) : 0;
    const modId = Math.floor(kvNum(kv, 'modifier', 0));
    const duration = kvNum(kv, 'duration', 6);

    const hit = (e: any): void => {
        if (!e || e.IsDead?.()) return;
        if (e === actor) return;                 // 兜底：绝不结算到自己（见文件头 ③）
        if (dmg > 0) ctx.damagePipeline.ApplyDamage(e, actor, dmg, DamageType.Magical);
        if (modId > 0) {
            e.modifiers?.AddModifier?.(modId, actor, duration, kv, `boss:${actor.id}`);
        }
    };

    /**
     * 敌对队伍 = 施法者所在队伍的另一侧（英雄 1 / 怪物 2）。
     * `actor.team` 缺失时回落 `1`（英雄侧）—— Boss 的技能打不到人才是真正的 bug，
     * 而"英雄侧写死"对本函数唯一的调用方（Boss）恒为正确值。
     */
    const enemyTeam = actor.team === 1 ? 2 : 1;
    const inRange = ctx.findEntitiesInRadius(actor, radius, enemyTeam) ?? [];
    if (isFan) {
        const cosLimit = Math.cos(halfAngleRad);
        for (const e of inRange) {
            if (!e || e.IsDead?.()) continue;
            const dx = (e.position?.x ?? cx) - cx;
            const dy = (e.position?.y ?? cy) - cy;
            const len = Math.hypot(dx, dy);
            // 贴在顶点上的目标（len≈0）没有方向可言 → 一律算命中（否则"贴脸反而打不到"）
            if (len > 1e-3 && (dx / len) * dir.x + (dy / len) * dir.y < cosLimit) continue;
            hit(e);
        }
    } else {
        for (const e of inRange) hit(e);
    }

    publishSkillShape(ctx, {
        shape: isFan ? HitShapeKind.Fan : HitShapeKind.Blast,
        source: actor,
        target,
        cx, cy, radius,
        dirX: dir.x,
        dirY: dir.y,
        halfAngleDeg,
    });
}

/** 单位化（全零返回 (1,0)：宁可朝右画，也不画一个没有朝向的扇形） */
function normalizeDir(x: number, y: number): { x: number; y: number } {
    const len = Math.hypot(x, y);
    if (!(len > 1e-6)) return { x: 1, y: 0 };
    return { x: x / len, y: y / len };
}

/**
 * 脚本动作清单 —— 供 `Scene_Game_Stage.initBattle` 一次性注册。
 *
 * 键名 = `abilities.json` 的 `effects[].script_id`。漏注册的表现是
 * `[EffectExecutor] script action 未注册: xxx`（会打印，但技能静默变成"没有效果"），
 * 所以改这张表之后请连同 `abilities.json` 的引用一起核对。
 */
export const BOSS_SKILL_ACTIONS: Record<string, (actor: any, self: any, action: any, context?: any) => void> = {
    boss_fireball: bossFireball,
    boss_cast: bossCast,
};
