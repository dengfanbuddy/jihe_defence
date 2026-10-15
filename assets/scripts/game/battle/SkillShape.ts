import { BattleEvents } from './types';
import { HitShapeKind } from '../common/HitFeelConfig';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * SkillShape —— **技能形态的显式上报**（设计文档 §13.4 的"路 B"，2026-11 落地）
 * ============================================================
 *
 * 一句话：战斗侧真的知道自己放了什么形状的技能（爆炸 / 链 / **扇形**），
 * 所以**直接告诉表现层**，不再让它从"同源同帧的落点几何"里猜。
 *
 * ── 为什么要从"路 A（几何推断）"升级到"路 B（显式上报）" ──
 *   路 A 的判定是启发式的，三处已知降级都写在 `docs/打击反馈设计.md` §13.2：
 *     ① **短跳距的链式弹射被画成爆炸环**（跳距 < 80px 就落进"挤成一堆"那一支）；
 *     ② **同源多目标的周期性伤害**（一片怪挂着同一个 DoT，每秒同帧跳字）会被当成一次技能；
 *     ③ **没有锚点的一次性效果根本判不出来** —— 击杀爆炸、天怒、Boss 的咆哮都是这一类。
 *   ③ 是最要命的一条：它让"技能打中一片怪却什么都不画"成为可能，而那正是形态层要修的 bug。
 *
 * ── 口径（三条硬约束）──
 *   ① **上报只是"补一条事实"，不是"换一套判定"**：`HitVfxLayer` 收到显式形态就直接画，
 *      收不到就仍然回落 `resolveHitShape` 的几何推断 —— 两条路并存，谁也不废谁。
 *   ② **坐标必须是逻辑世界坐标**（与 `HitVfxLayer` 的绘制空间同一套，见该文件的坐标系契约）。
 *      所有调用点都在实体位置被回收**之前**取值（`OnKill` 那种要读 `deathPos` 快照）。
 *   ③ **半径一律像素**：配表写"米"的地方由调用方自己过 `pxPerMeter`（唯一口径在
 *      `battle_constants.pxPerMeter`），本文件不认识"米"。
 *
 * @example
 * ```ts
 * // 以宿主为中心、40° 半角、攻击距离 ×1.2 的扇形（Boss 咆哮 / 神器天怒）
 * publishSkillShape(ctx, {
 *     shape: HitShapeKind.Fan, source: host,
 *     cx: host.position.x, cy: host.position.y,
 *     radius: host.getAttackRange() * 1.2,
 *     dirX: ux, dirY: uy, halfAngleDeg: 40,
 * });
 * ```
 */

/** 上报的一条形态（字段与 `HitFeelConfig.HitShapeResult` 对齐，少了它就不必上报） */
export interface SkillShapeReport {
    /** 形态类别（用 `HitShapeKind` 的字符串值，避免两侧各写一套常量） */
    shape: HitShapeKind;
    /** 圆心 / 扇形顶点（逻辑坐标） */
    cx: number;
    cy: number;
    /** 半径（**像素**）。0 = 画不出范围（扇形/爆炸都要它） */
    radius: number;
    /** 扇形朝向（单位向量；只有 Fan 用） */
    dirX?: number;
    dirY?: number;
    /** 扇形**半角**（度；只有 Fan 用。40 = 总共 80° 的扇面） */
    halfAngleDeg?: number;
    /** 链式落点（只有 Chain 用；已按跳序排好） */
    points?: { x: number; y: number }[];
    /** 来源实体（表现层用它判"这次是不是英雄受击"→ 颜色口径，口径 4） */
    source?: any;
    /** 目标（可空）：给表现层判"打的是不是英雄"用 */
    target?: any;
    /**
     * **这一发的图形由上报方自己画**，形态层（`HitVfxLayer`）整条不接（不画、不占额度、不吸收印痕）。
     *
     * 唯一的使用者是目前的地雷（`reportMineBlast`）：它的表现是**自己的预制件节点**
     * （`game_stage/entityview/MineView`，跟着那颗雷的位置走、炸完就地回收），
     * 而形态层那条同形状的环会在**同一帧、同一个位置**再画一遍 —— 同一发爆炸两个圈。
     *
     * ⚠ 它**只关掉"画"**，不关掉"上报"：音效、顿帧、抖动照旧（导演自己订阅总线上的这条事件，
     *   它对形态的判断与谁画这个环无关）。
     * ⚠ 别拿它当"我不想看见这个环"的开关用 —— 那样会让打击反馈的账本与画面不一致
     *   （形态层的额度是按**图形个数**算的，塞进去一堆画不出来的图形会把真要画的挤掉）。
     */
    noDraw?: boolean;
}

/*
 * ⚠ **本文件刻意只依赖 `battle/types.ts` + `common/HitFeelConfig.ts`**（两者都是纯 TS 常量），
 *   不 import `core/BattleConstUtil`（它会拖进 `TbRoot` + 整条配表管线）。
 *   原因：本文件被 `RelicHooks` / `ShopSkillModifiers` / `SpecialBuffs` 三个脚本文件引用，
 *   而那三个文件都是**体检脚本要按 SOURCES 白名单单独编译并真跑**的
 *   （`tools/status-bar-audit` / `tools/artifact-audit`）——
 *   在这里多引一层配表管线会让它们集体跑不起来（报错长得像"体检脚本自己坏了"）。
 *   "米 → 像素"的换算因此留在调用方（`boss/BossSkills.ts` 的 `meters()`，口径仍是 `pxPerMeter`）。
 */

/** 两个实体之间的单位方向（完全重合返回 (0,0)，调用方自己兜底） */
export function shapeDirection(from: any, to: any): { x: number; y: number } {
    const fx = from?.position?.x ?? 0;
    const fy = from?.position?.y ?? 0;
    const tx = to?.position?.x ?? fx;
    const ty = to?.position?.y ?? fy;
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return { x: 0, y: 0 };
    return { x: dx / len, y: dy / len };
}

/**
 * **唯一上报入口**。字段不合法（形状为 none / 半径非正 / 坐标 NaN）时**静默丢弃** ——
 * 表现层宁可什么都不画，也不许画一个半径 NaN 的环（那会让整层 Graphics 抛异常）。
 */
export function publishSkillShape(ctx: BattleContext | undefined, report: SkillShapeReport): void {
    if (!ctx?.bus || !report) return;
    if (report.shape === HitShapeKind.None) return;
    if (!Number.isFinite(report.cx) || !Number.isFinite(report.cy)) return;
    const radius = Number(report.radius);
    if (!Number.isFinite(radius) || radius <= 0) return;

    ctx.bus.publish(BattleEvents.OnSkillShape, {
        shape: report.shape,
        cx: report.cx,
        cy: report.cy,
        radius,
        dirX: Number(report.dirX) || 0,
        dirY: Number(report.dirY) || 0,
        halfAngleDeg: Number(report.halfAngleDeg) || 0,
        points: report.points ?? [],
        source: report.source,
        target: report.target,
        noDraw: report.noDraw === true,
    });
}
