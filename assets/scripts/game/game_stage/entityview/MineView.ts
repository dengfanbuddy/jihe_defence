import { _decorator, Color, Component, Graphics } from 'cc';
import { MINE_LAYER_STYLE } from '../../common/MineConfig';

const { ccclass } = _decorator;

/**
 * ============================================================
 * MineView —— **一颗**骷髅地雷的表现（挂在 `mine.prefab` 上）
 * ============================================================
 *
 * 一颗雷的三种画法（**只画，不判定**）：`arm()` 之后
 *   ① **本体**：实线小圆（已存在的实体）+ 中心实心点（引信）；
 *   ② **触发范围**：**真实触发半径**上的虚线环 + 一条**雷达扫描线**在里面转
 *      （虚线 = "还没发生"，见 `docs/art-style/tokens.json` 的 `shapes.dashedMeaning`）；
 *   ③ **爆炸**（`playBlast()`）：一个圈从**原点快速扩散到真实爆炸半径** + 末端径向刻度。
 *
 * ── 三条硬约束 ──
 *   ① **节点位置 = 逻辑世界坐标**（`MineLayer` 每帧 `setPosition(m.x, m.y)`），
 *      所以这里**一律画在局部原点周围**、不做任何坐标转换（同 `HitVfxLayer` 的坐标系契约）。
 *   ② **本组件不碰战斗逻辑**：触发半径 / 爆炸半径 / 谁该炸，全部来自 `ctx.mines`
 *      （纯 TS 的 `BattleMines`，它不依赖 cc，所以能被体检脚本真跑）。这里只被喂参数。
 *   ③ **不在 `onLoad` 里假设自己已经被 arm**：池子里捞出来的节点可能刚 `reset()` 过，
 *      一切绘制都由 `arm()` / `playBlast()` 之后的 `tick()` 驱动，缺参数时画布是空的。
 *
 * ⚠ **颜色**：本体用 `c-ink-600`、扫描线用 `c-range-line`、爆炸圈用形态层同款墨色 ink ——
 *   三档都取自既有 token，**不新增颜色**（本作是双色制，拿颜色区分状态会被读成品质色）。
 *   语义一律由**线型**承担：实线 = 已存在的实体 / 虚线 = 还没发生 / 加粗 = 这一下很重
 *   （与 `HIT_FEEL_SHAPE` 的"爆炸看不清就靠描边加粗"是同一条口径）。
 */
@ccclass('MineView')
export class MineView extends Component {
    /** 画布（与组件同节点；直接挂预制件上，缺了就地补一个） */
    private g: Graphics | null = null;

    /** 在警戒（画本体 + 雷达盘） */
    private armed = false;
    /** 触发半径（像素）—— 每帧由 `MineLayer` 现读 `ctx.mines.runtime()` 喂进来 */
    private triggerRadius = 0;
    /** 扫描线当前角度（弧度） */
    private sweepAngle = 0;

    /** 爆炸已过的毫秒数；**< 0 = 不在爆炸态** */
    private blastAgeMs = -1;
    /** 这一发的**真实爆炸半径**（像素）—— 由引爆时报进来的，不是猜的视觉尺度 */
    private blastRadius = 0;

    /** 画布上有没有东西（"空着不 clear"的老账本，见 `MineLayer` 的历史注释） */
    private painted = false;

    onLoad(): void {
        this.gfx();
    }

    /** 回收前复位（**不要手调生命周期钩子**，这是给对象池用的显式入口） */
    reset(): void {
        this.armed = false;
        this.blastAgeMs = -1;
        this.blastRadius = 0;
        this.sweepAngle = 0;
        this.clearCanvas();
    }

    /* ------------------------------------------------------------------ 对外动作 */

    /** 在警戒（`MineLayer` 从池子里取到节点、或新的一颗雷落地时调） */
    arm(triggerRadius: number): void {
        this.armed = true;
        this.blastAgeMs = -1;
        this.triggerRadius = Math.max(1, triggerRadius);
        this.sweepAngle = 0;
        this.redraw();
    }

    /** 触发半径变了（遗物「扩爆」/ 换英雄：参数每帧重算，所以这里只重画、不重开扫描角） */
    setTriggerRadius(triggerRadius: number): void {
        const r = Math.max(1, triggerRadius);
        if (Math.abs(r - this.triggerRadius) < 0.01) return;
        this.triggerRadius = r;
        this.redraw();
    }

    /**
     * 引爆（敌人踩上来了）：本体与雷达盘立刻收掉，改画**从原点扩到爆炸半径**的圈。
     *
     * @param blastRadius 这一发的真实爆炸半径（像素；`MineRuntime.blastRadius`）
     */
    playBlast(blastRadius: number): void {
        this.armed = false;
        this.blastRadius = Math.max(2, blastRadius);
        this.blastAgeMs = 0;
        this.redraw();
    }

    /** 还在警戒（宿主据此判"这颗雷还要不要留在场上"） */
    get isArmed(): boolean { return this.armed; }

    /** 爆炸播完了没有（宿主据此回收节点） */
    get blastFinished(): boolean {
        return this.blastAgeMs >= MINE_LAYER_STYLE.blastLifeMs;
    }

    /* ------------------------------------------------------------------ 每帧 */

    /**
     * 推进 + 重画（由 `MineLayer.update` 每帧调用，dt 与战斗同一条钟）。
     *
     * ⚠ 只在**有东西可画**时才 `clear()` + 重画：池子里的空闲节点、以及爆炸播完
     *   等回收的那一帧，都不该白扔 draw call（同 `HitVfxLayer` 的账本思路）。
     */
    tick(dt: number): void {
        if (this.armed) {
            this.sweepAngle += dt * MINE_LAYER_STYLE.sweepDegPerSec * Math.PI / 180;
            const TAU = Math.PI * 2;
            if (this.sweepAngle > TAU) this.sweepAngle -= TAU;
        } else if (this.blastAgeMs >= 0) {
            this.blastAgeMs += dt * 1000;
        } else {
            return;                                     // 既不在警戒、也不在爆炸：没什么可画
        }
        this.redraw();
    }

    /* ------------------------------------------------------------------ 画法 */

    private redraw(): void {
        const g = this.gfx();
        if (!g) return;
        g.clear();
        this.painted = true;
        if (this.armed) this.drawArmed(g);
        else if (this.blastAgeMs >= 0) this.drawBlast(g);
    }

    /**
     * 在警戒的一颗雷：触发范围（虚线圈）+ 本体 + 雷达扫描线。
     *
     * ⚠ 画序 = 从"范围"到"实体"：范围圈在下、本体在上，所以雷达线穿过本体时
     *   也不会把引信点糊掉（`Graphics` 是同一画布，线是叠加的，顺序只影响观感的一致性）。
     */
    private drawArmed(g: Graphics): void {
        const s = MINE_LAYER_STYLE;
        const R = this.triggerRadius;

        // ① 触发范围：虚线环（"还没发生"）
        this.dashedCircle(g, R, s.triggerDashCount, s.armedColor, s.triggerLineWidth);

        // ② 本体：实线圆（已存在的实体）
        g.lineWidth = s.mineLineWidth;
        g.strokeColor = new Color(s.mineStroke[0], s.mineStroke[1], s.mineStroke[2], 255);
        g.circle(0, 0, s.mineRadius);
        g.stroke();
        // 引信：实心点
        g.fillColor = new Color(s.mineCore[0], s.mineCore[1], s.mineCore[2], 255);
        g.circle(0, 0, s.mineCoreRadius);
        g.fill();

        // ③ 雷达扫描线：从圆心扫到触发半径，尖端两条小刻度（制图"箭头"的语法）
        const a = this.sweepAngle;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        g.lineWidth = s.sweepLineWidth;
        g.strokeColor = new Color(s.armedColor[0], s.armedColor[1], s.armedColor[2], 255);
        g.moveTo(ca * s.mineRadius, sa * s.mineRadius);      // 起笔在本体之外，不穿进雷里
        g.lineTo(ca * R, sa * R);
        g.stroke();
        // 尖端刻度：垂直于扫描线方向各伸出一半（长度固定，与半径无关 —— 它不是"范围"的一部分）
        const nx = -sa;
        const ny = ca;
        const half = s.sweepTipTickLen * 0.5;
        const tx = ca * (R - s.sweepTipTickLen);
        const ty = sa * (R - s.sweepTipTickLen);
        g.moveTo(tx + nx * half, ty + ny * half);
        g.lineTo(tx - nx * half, ty - ny * half);
        g.stroke();
    }

    /**
     * 爆炸：一个圈**从原点快速扩散到真实爆炸半径**，末段在环上盖一圈径向刻度。
     *
     * 半径走 `blastGrowPow`（0.45 < 1 = 起步快）：用户口径「圆圈从原点**快速**扩散到爆炸范围」，
     * 而线性扩散会读成"慢慢涨大"，那是"持续伤害场"的语法，不是"炸了一下"。
     * 画法与形态层的 `HitVfxLayer.drawBlast` **同源同参数**（寿命/线宽/缓动/刻度全对齐），
     * 差别只有一条：那边可以画 2~3 层错开的环，地雷这一发**只画一个圈** ——
     * "踩上去炸了"这件事只有一个瞬间，多环会读成"连续炸了好几下"。
     */
    private drawBlast(g: Graphics): void {
        const s = MINE_LAYER_STYLE;
        const t = Math.max(0, Math.min(1, this.blastAgeMs / s.blastLifeMs));
        const alpha = s.blastAlpha * Math.max(0, 1 - Math.pow(t, s.blastFadePow));
        if (alpha <= 0.01) return;
        const r = Math.max(2, this.blastRadius * Math.pow(t, s.blastGrowPow));

        g.lineWidth = s.blastLineWidth;
        g.strokeColor = new Color(s.blastColor[0], s.blastColor[1], s.blastColor[2], Math.round(alpha * 255));
        g.circle(0, 0, r);
        g.stroke();

        // 径向刻度：只在环接近到位时画（否则刻度会飘在半径之外，读成"炸歪了"）
        if (t < s.blastTickFrom) return;
        const half = s.blastTickLen * 0.5;
        g.lineWidth = s.blastTickWidth;
        for (let i = 0; i < s.blastTicks; i++) {
            const a = (Math.PI * 2 * i) / s.blastTicks;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            g.moveTo(ca * (r - half), sa * (r - half));
            g.lineTo(ca * (r + half), sa * (r + half));
        }
        g.stroke();
    }

    /** 一圈虚线（`Graphics` 没有 dash 原语 ⇒ 按段画圆弧；段数太少读不出"这是个圈"） */
    private dashedCircle(g: Graphics, radius: number, dashCount: number, rgb: readonly number[], lineWidth: number): void {
        g.lineWidth = lineWidth;
        g.strokeColor = new Color(rgb[0], rgb[1], rgb[2], 255);
        const n = Math.max(4, Math.round(dashCount));
        const step = (Math.PI * 2) / (n * 2);
        for (let i = 0; i < n; i++) {
            const a0 = i * step * 2;
            const a1 = a0 + step;
            g.moveTo(Math.cos(a0) * radius, Math.sin(a0) * radius);
            g.lineTo(Math.cos(a1) * radius, Math.sin(a1) * radius);
        }
        g.stroke();
    }

    /* ------------------------------------------------------------------ 内部 */

    /**
     * 取画布（懒取 + 缺了就补）。
     *
     * 为什么懒取而不是只在 `onLoad` 里取：本组件的节点来自**对象池**，
     * 而池子里的节点在被 `instantiate` 之前可能从没激活过 —— 那时代码若已经调了 `arm()`
     * （例如同一帧里"取到节点 → 立刻布雷"），`onLoad` 还没跑，硬等就会漏掉第一帧的绘制。
     */
    private gfx(): Graphics | null {
        if (!this.g || !this.g.isValid) {
            this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
            // 圆头 + 圆角拐角（图纸风：细线圆头，见 tokens.shapes.lineWidth）
            this.g.lineCap = Graphics.LineCap.ROUND;
            this.g.lineJoin = Graphics.LineJoin.ROUND;
        }
        return this.g;
    }

    /** 清一次画布（**只在自己画过东西时**才清：空闲节点不该每帧白扔一次 clear） */
    private clearCanvas(): void {
        if (!this.painted) return;
        this.painted = false;
        if (this.g?.isValid) this.g.clear();
    }
}
