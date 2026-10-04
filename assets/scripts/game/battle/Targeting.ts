/**
 * Targeting —— 目标选择策略库
 *
 * 技能/普攻都可以配置自己的索敌策略（AbilityCfg.targeting / UnitCfg.attack_targeting）：
 *   - nearest     距离最近（默认）
 *   - lowest_hp   血量比例最低（优先斩杀）
 *   - farthest    距离最远（**在调用方传入的候选集内**，不含射程过滤）
 *   - random      随机
 *   - strongest   攻击力最高（优先威胁大的）
 *
 * 注意：本库只做"候选集内"的比较，不做射程判定。
 * 射程过滤由调用方完成（如 Scene_Game_Stage.pickEnemy 先按 range 过滤再调用），
 * 因此 farthest 的实际语义 = "射程内最远的敌人"，而非全图最远。
 *
 * 另有一个不走策略的入口 `pickTargetAtPoint`：按**玩家点选点**挑目标（点击怪物切换攻击目标），
 * 它自带判定半径过滤（见该函数注释）。
 *
 * 用法：
 *   const target = pickTarget(ability.def.targeting, enemies, caster.position);
 */
export type TargetingStrategy = 'nearest' | 'lowest_hp' | 'farthest' | 'random' | 'strongest';

/** 实体最小接口（便于测试与解耦） */
interface Targetable {
    position?: { x: number; y: number };
    hp?: number;
    getMaxHp?: () => number;
    getAttackDamage?: () => number;
    IsDead?: () => boolean;
    /** 碰撞半径（像素，已含体型缩放）；**只有 `pickTargetAtPoint` 用**，别的策略不读它 */
    collisionRadius?: number;
}

/**
 * 按策略从候选集中选择一个目标
 * @param strategy 策略（缺省 nearest）
 * @param candidates 候选实体（**射程过滤由调用方做**，本函数不判距离上限）
 * @param center 参考点（nearest/farthest 需要；可为空则用候选中心）
 */
export function pickTarget(
    strategy: TargetingStrategy | undefined,
    candidates: Targetable[],
    center?: { x: number; y: number },
): Targetable | null {
    const list = candidates.filter((c) => !c.IsDead?.());
    if (list.length === 0) return null;
    const s = strategy ?? 'nearest';

    switch (s) {
        case 'nearest': {
            let best: Targetable | null = null;
            let bestDist = Infinity;
            for (const c of list) {
                const d = dist2(c, center);
                if (d < bestDist) { bestDist = d; best = c; }
            }
            return best;
        }
        case 'farthest': {
            let best: Targetable | null = null;
            let bestDist = -1;
            for (const c of list) {
                const d = dist2(c, center);
                if (d > bestDist) { bestDist = d; best = c; }
            }
            return best;
        }
        case 'lowest_hp': {
            let best: Targetable | null = null;
            let bestRatio = Infinity;
            for (const c of list) {
                const maxHp = c.getMaxHp?.() ?? 1;
                const ratio = (c.hp ?? 0) / maxHp;
                if (ratio < bestRatio) { bestRatio = ratio; best = c; }
            }
            return best;
        }
        case 'strongest': {
            let best: Targetable | null = null;
            let bestAtk = -1;
            for (const c of list) {
                const atk = c.getAttackDamage?.() ?? 0;
                if (atk > bestAtk) { bestAtk = atk; best = c; }
            }
            return best;
        }
        case 'random':
        default: {
            return list[Math.floor(Math.random() * list.length)];
        }
    }
}

/**
 * 按「点选」挑目标（玩家点击怪物切换普攻目标）—— 候选集内**离点选点最近**、且落在各自判定半径内的那一个。
 *
 * 与 `pickTarget` 的三个不同（都是刻意的）：
 *   ① **自带半径过滤**：点选的语义是"我点了它"，中不中取决于**点得准不准**，
 *      而不是"在不在射程内" —— 射程过滤仍然由调用方做（点选一只射程外的怪是合法操作：
 *      它只是"排队等着打"，见 `Scene_Game_Stage.resolveAttackTarget`）。
 *   ② 判定半径逐候选算：`max(minRadius, collisionRadius + pad)`。`pad`/`minRadius` 由调用方从
 *      `common/TargetSelectConfig.ts` 递进来（本文件是纯策略库，不读配置、不读 cc）。
 *   ③ 都不在判定半径内 → 返回 `null`：调用方据此判定"点了空地"（= 取消手动选择）。
 *
 * 重叠时选**中心离点选点更近**的那只（不是"先命中的那只"）：怪群必然重叠，手指落点离谁更近，
 * 玩家心里想的就是谁。
 *
 * @param candidates 候选实体（**调用方负责过滤**：存活 / 未回收 / 可选中 / 敌对阵营）
 * @param point      点选点（**逻辑世界坐标**，与 `entity.position` 同一套数）
 * @param pad        判定半径的额外垫量（像素）
 * @param minRadius  判定半径下限（像素）
 */
export function pickTargetAtPoint(
    candidates: Targetable[],
    point: { x: number; y: number },
    pad = 0,
    minRadius = 0,
): Targetable | null {
    if (!point || !candidates?.length) return null;
    let best: Targetable | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c || c.IsDead?.()) continue;
        const body = typeof c.collisionRadius === 'number' && c.collisionRadius > 0 ? c.collisionRadius : 0;
        const r = Math.max(minRadius, body + pad);
        const dx = (c.position?.x ?? 0) - point.x;
        const dy = (c.position?.y ?? 0) - point.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;              // 点不在它的判定半径内 → 这只不算被点中
        if (d2 < bestDist) { bestDist = d2; best = c; }
    }
    return best;
}

/**
 * 按策略选择多个目标（多目标弹道/群攻用）
 * @param count 目标数量（不足则返回全部）
 */
export function pickTargets(
    strategy: TargetingStrategy | undefined,
    candidates: Targetable[],
    center?: { x: number; y: number },
    count = 1,
): Targetable[] {
    const list = candidates.filter((c) => !c.IsDead?.());
    if (list.length === 0) return [];
    const n = Math.min(Math.max(1, count), list.length);
    const s = strategy ?? 'nearest';

    const sorted: Targetable[] = [...list];
    switch (s) {
        case 'farthest':
            sorted.sort((a, b) => dist2(b, center) - dist2(a, center));
            break;
        case 'lowest_hp': {
            const ratio = (c: Targetable) => (c.hp ?? 0) / Math.max(1, c.getMaxHp?.() ?? 1);
            sorted.sort((a, b) => ratio(a) - ratio(b));
            break;
        }
        case 'strongest':
            sorted.sort((a, b) => (b.getAttackDamage?.() ?? 0) - (a.getAttackDamage?.() ?? 0));
            break;
        case 'random':
            for (let i = sorted.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
            }
            break;
        case 'nearest':
        default:
            sorted.sort((a, b) => dist2(a, center) - dist2(b, center));
            break;
    }
    return sorted.slice(0, n);
}

/** 平方距离（center 缺省按 (0,0)） */
function dist2(c: Targetable, center?: { x: number; y: number }): number {
    const cx = center?.x ?? 0;
    const cy = center?.y ?? 0;
    const dx = (c.position?.x ?? 0) - cx;
    const dy = (c.position?.y ?? 0) - cy;
    return dx * dx + dy * dy;
}
