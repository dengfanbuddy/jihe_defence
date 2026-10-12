import { _decorator, Color, Component, Graphics, Node, Vec3 } from 'cc';
import type { BattleContext } from '../../battle';
import type { MineRecord, BurnField } from '../../battle/BattleMines';
import { MINE_LAYER_NODE_NAME, MINE_LAYER_STYLE } from '../../common/MineConfig';

const { ccclass } = _decorator;

/**
 * ============================================================
 * MineLayer —— 「骷髅地雷」的表现层（整场一个中央层，一个 Graphics）
 * ============================================================
 *
 * 画两样东西（**只画逻辑，不改逻辑**）：
 *   · **待引爆的地雷**：实线小圆 + 中心实心点 + 一圈**虚线**（虚线 = "还没发生"，见
 *     `docs/art-style/tokens.json` 的 `shapes.dashedMeaning`）；
 *   · **燃烧地面**（遗物「燃烧雷」留下的）：一圈更大的虚线 + 几条内刻度，不填充
 *     （填充会在浅底图纸上糊成一团，而本作的美术禁用清单里有"渐变/发光/阴影"）。
 *
 * 爆炸本身**不在这里画**：`BattleMines.detonate` 每炸一颗就
 * `publishSkillShape({shape: Blast, radius: 真实爆炸半径})`，爆炸环与形态音效由
 * `HitVfxLayer` 那套"路 B"免费复用（见 `battle/SkillShape.ts`）。
 * 本层再画一遍 = 同一发爆炸出现两个圈。
 *
 * ── 三条硬约束（都是既有层踩过的坑，照抄口径）──
 *   ① **坐标系契约**：本层按**逻辑世界坐标**直接绘制、**不做任何坐标转换** ——
 *      `EntityView.bind` 是 `node.setPosition(entity.position)`，即 `monsterParent` 的局部空间
 *      == 逻辑世界坐标。所以层节点必须与 `monsterParent` **同坐标系**（根下兄弟、position (0,0)、
 *      scale 1）。`bind` 时做一次自检（`checkSpace`），挪了位置会打警告。
 *   ② **整层一个 Graphics**：地雷最多 5 颗 + 燃烧地面几片，每帧全量重画（`clear()` + 重画）比
 *      "每颗雷一个节点"便宜得多，也**不需要对象池**（没有节点要复用）。
 *   ③ **没东西可画时不 clear**：空地雷时每帧 clear 一次是白扔 draw call ——
 *      用一个 `drawn` 标志记住"上一帧画过没有"，空了才清一次（同 `HitVfxLayer` 的账本思路）。
 *
 * ⚠ 本层**只读** `ctx.mines`：布雷 / 触发 / 伤害全在纯 TS 的 `BattleMines` 里
 *   （它不依赖 cc，所以能被 `audit:mine` 真跑）。表现层碰战斗逻辑 = 那条体检就白做了。
 */
@ccclass('MineLayer')
export class MineLayer extends Component {
    /** 唯一画布（整层一个 Graphics ⇒ 恒定 1 次 draw call） */
    private g: Graphics | null = null;
    private ctx: BattleContext | null = null;
    /** 坐标系参照节点（= 场景的 monsterParent）；null = 还没 bind */
    private ref: Node | null = null;
    /** 上一帧画过东西没有（用于"空了才清一次"） */
    private drawn = false;
    /** 坐标系自检只报一次（否则每帧刷屏） */
    private spaceChecked = false;

    onLoad(): void {
        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        // 线与点都要圆头（图纸风：细线圆头，见 tokens.shapes.lineWidth）
        this.g.lineCap = Graphics.LineCap.ROUND;
        this.g.lineJoin = Graphics.LineJoin.ROUND;
        this.g.clear();
    }

    /**
     * 接上战斗上下文。
     *
     * @param ctx 战斗上下文（`ctx.mines` 是唯一数据源）
     * @param coordRef **坐标系参照节点**（通常传 `monsterParent`）：用于自检"本层与它同坐标系"
     */
    bind(ctx: BattleContext, coordRef?: Node | null): void {
        this.ctx = ctx;
        this.ref = coordRef ?? null;
        this.spaceChecked = false;
        this.checkSpace();
    }

    /** 断引用（换局时由宿主调；节点保留，下次进战斗重新 bind） */
    unbind(): void {
        this.ctx = null;
        this.clearAll();
    }

    /** 清空画面（宿主在换局/结束时会调） */
    clearAll(): void {
        this.g?.clear();
        this.drawn = false;
    }

    update(): void {
        const g = this.g;
        const mines = this.ctx?.mines;
        if (!g) return;
        const list: readonly MineRecord[] = mines?.list() ?? [];
        const fields: readonly BurnField[] = mines?.burnFields() ?? [];

        // 没有东西可画：只在"上一帧还画着"时清一次（约束 ③）
        if (!list.length && !fields.length) {
            if (this.drawn) this.clearAll();
            return;
        }

        g.clear();
        // ① 燃烧地面先画（在雷"下面"，不遮住雷的实线）
        for (const f of fields) this.drawField(g, f);
        // ② 地雷
        for (const m of list) this.drawMine(g, m);
        this.drawn = true;
    }

    /* ------------------------------------------------------------------ 画法 */

    /**
     * 一颗地雷：实线圆（本体）+ 中心点（引信）+ 虚线环（待触发预告）。
     *
     * ⚠ 三层都用**实线/虚线语法**表达状态，不用颜色区分 —— 本作是双色制，
     *   颜色只有"青绿 = 可点/系统"与"墨灰 = 内容"两支，拿颜色区分状态会被读成品质色。
     */
    private drawMine(g: Graphics, m: MineRecord): void {
        const s = MINE_LAYER_STYLE;
        // 本体：实线圆（已存在的实体）
        g.lineWidth = s.mineLineWidth;
        g.strokeColor = new Color(s.mineStroke[0], s.mineStroke[1], s.mineStroke[2], 255);
        g.circle(m.x, m.y, s.mineRadius);
        g.stroke();
        // 引信：实心点
        g.fillColor = new Color(s.mineCore[0], s.mineCore[1], s.mineCore[2], 255);
        g.circle(m.x, m.y, s.mineCoreRadius);
        g.fill();
        // 待触发：虚线环（"还没发生"）
        this.dashedCircle(g, m.x, m.y, s.mineTriggerRing, s.mineDashCount, s.armedColor, s.mineLineWidth);
    }

    /** 一片燃烧地面：更大的虚线环 + 几条内刻度（不填充） */
    private drawField(g: Graphics, f: BurnField): void {
        const s = MINE_LAYER_STYLE;
        g.lineWidth = s.fieldLineWidth;
        this.dashedCircle(g, f.x, f.y, f.radius, s.fieldDashCount, s.burnColor, s.fieldLineWidth);
        // 内刻度：八向短线，读作"这里在持续烧"
        const r0 = f.radius * 0.62;
        const r1 = f.radius * 0.86;
        g.strokeColor = new Color(s.burnColor[0], s.burnColor[1], s.burnColor[2], 255);
        for (let i = 0; i < 8; i++) {
            const a = (Math.PI * 2 * i) / 8;
            g.moveTo(f.x + Math.cos(a) * r0, f.y + Math.sin(a) * r0);
            g.lineTo(f.x + Math.cos(a) * r1, f.y + Math.sin(a) * r1);
        }
        g.stroke();
    }

    /**
     * 画一圈虚线（`Graphics` 没有 dash 原语 ⇒ 按段画圆弧）。
     *
     * 段数由 `dashCount` 定：段太多在 12px 的雷上会糊成一圈实线，
     * 段太少读不出"这是个圈"（取值与理由见 `MineConfig.MINE_LAYER_STYLE`）。
     */
    private dashedCircle(
        g: Graphics, cx: number, cy: number, radius: number,
        dashCount: number, rgb: readonly number[], lineWidth: number,
    ): void {
        g.lineWidth = lineWidth;
        g.strokeColor = new Color(rgb[0], rgb[1], rgb[2], 255);
        const step = (Math.PI * 2) / (dashCount * 2);
        for (let i = 0; i < dashCount; i++) {
            const a0 = i * step * 2;
            const a1 = a0 + step;
            g.moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
            g.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
        }
        g.stroke();
    }

    /* ------------------------------------------------------------------ 自检 */

    /**
     * 坐标系自检（**只报一次**）：本层必须与参照节点同坐标系。
     *
     * 为什么值得一条自检：绘制**不做坐标转换**（约束 ①），所以"层级摆错"不会报错、
     * 只会让雷**长在屏幕的另一个角落** —— 那种 bug 在编辑器里点不出来，只有在真机上看才现形。
     * 判据 = 两者的世界坐标相同（根下兄弟、(0,0)、scale 1 时成立）。
     */
    private checkSpace(): void {
        if (this.spaceChecked || !this.ref?.isValid) return;
        this.spaceChecked = true;
        const a = new Vec3();
        const b = new Vec3();
        this.node.getWorldPosition(a);
        this.ref.getWorldPosition(b);
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        const floor = 0.5; // 半个像素以内当作同一坐标系
        const dx0 = dx < floor ? 0 : dx;
        const dy0 = dy < floor ? 0 : dy;
        if (dx0 > 0 || dy0 > 0) {
            console.warn(
                `[地雷层] 本层与 monsterParent 不在同一坐标系（世界坐标差 ${dx0.toFixed(1)},${dy0.toFixed(1)}）——`
                + ' 地雷会画在错误的位置。绘制不做坐标转换，层节点必须与怪物层同父、position (0,0)、scale 1。',
            );
        }
    }
}

/** 兜底：宿主没建节点时可以就地建一个（见 `Scene_Game_Stage.ensureMineLayer`） */
export function attachMineLayer(parent: Node, name = MINE_LAYER_NODE_NAME): MineLayer {
    const node = new Node(name);
    node.layer = parent.layer;      // ⚠ 不继承 layer 的话 UI 相机看不到（同飘字层那条坑）
    parent.addChild(node);
    return node.addComponent(MineLayer);
}
