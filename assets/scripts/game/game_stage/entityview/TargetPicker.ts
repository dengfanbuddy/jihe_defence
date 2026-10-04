import { _decorator, Color, Component, EventTouch, Graphics, Node, UITransform, Vec2, Vec3 } from 'cc';
import type { Entity } from '../../battle';
import { TAP_SELECT, TARGET_MARK } from '../../common/TargetSelectConfig';
const { ccclass } = _decorator;

/** 输入区覆盖尺寸（像素）：与 `HitVfxLayer` 的同名口径一致，见 `TAP_SELECT.coverSize` 的注释 */
const COVER_SIZE = TAP_SELECT.coverSize;

/**
 * ============================================================
 * TargetPicker —— 点选索敌（点击怪物切换普攻目标）：**输入 + 选中标记**
 * ============================================================
 *
 * ---- 它只做两件事，规则一概不做 ----
 *   ① **输入**：把"在战场上点了一下"翻译成**逻辑世界坐标**，交给宿主（`bind` 的 `onTap`）。
 *      "点中了谁 / 该不该改目标"是**战斗规则**，唯一决策点在 `Scene_Game_Stage`
 *      （`onFieldTap` → `resolveAttackTarget`）—— 本组件不认识候选集、不认识射程、不认识锁定。
 *   ② **标记**：把宿主给的那只怪框出来（青绿描边环 + 四角括号），**每帧由宿主调 `mark()`**。
 *
 * ---- 为什么是"一个覆盖全场的输入区"，而不是给每只怪挂触摸 ----
 *   · 怪物节点只有 20×20px（半径 10），手指点不中；要给每只怪补一个"更大的隐形判定区"，
 *     就得动预制件或在对象池里增删子节点 —— 池化节点上的监听/子节点最容易跨局残留。
 *   · 判定半径应当**与体型无关地统一**（Boss 与小怪的点选手感一致），而 `UITransform.hitTest`
 *     只能按节点自身的 contentSize 判 —— 想加大就得改 contentSize，等于拿表现尺寸换手感。
 *   · 一层一个输入区 = 一次注册、一次摘除，换局不会漏。
 *
 * ---- 事件会被谁抢走（引擎的 2D 派发规则，决定了本层能收到什么）----
 *   Cocos 的手势派发顺序 = **相机优先级 → 同父兄弟的下标更大者先**，且**第一个命中的节点会把
 *   这次触摸认领掉**（后面的节点收不到）。所以本层节点必须**排在 HUD（`uiViewNode`）之前**：
 *   · HUD 上的按钮 / 技能格 / 三个全屏面板（`BlockInputEvents`）排在本层之前 → 点它们不会漏到这里；
 *   · 其余位置（含 HUD 上没有交互的空白）都会落到本层 → 判为"点了场地"。
 *   排错方向（排到 HUD 之后）的后果是**点 HUD 按钮会顺带改目标**，所以位置由宿主显式插入。
 *
 * ---- 坐标系：点选点换算到 `enimys` 的局部空间 == 逻辑世界坐标 ----
 *   与 `HitVfxLayer` / `DamageTextLayer` 同一条契约（层节点与 monsterParent 局部变换相同，
 *   怪是按 `node.setPosition(entity.position)` 摆的），所以：
 *   · 触摸点用 **monsterParent 的 UITransform** 反变换得到逻辑坐标 —— 与 `entity.position` 同一套数；
 *     不用本节点自己的 UITransform，是为了"即使层节点被挪了位置，点选仍然准"（挪动只影响画出来的环，
 *     而那个由 `checkSpace` 在 bind 时打警告）。
 *   · 标记直接用 `entity.position` 画，**不做坐标转换**。
 *
 * ---- 标记挂在哪一层（决定它画在怪的上面还是下面）----
 *   宿主把本节点插在 `enimys` **之前**（bg 之上、怪之下）：环读作"圈在地上的锁定框"，
 *   不会盖住怪、也不会盖住飘字。同时它**参与战斗内容层位移**（同偏移，见 `collectShakeTargets`）——
 *   否则震屏那一帧环会从怪身上"脱开"。
 *
 * ---- 时间与现实约束 ----
 *   本层没有自己的时钟：标记是**常驻状态**（不是印痕那种一次性图形），位置变了才重画
 *   （脏检查三件套：目标 / 坐标 / 半径），所以静止时一帧都不 clear。
 *   与 `HitVfxLayer` 一致：`unbind()` 用在节点还活着的时候（换局 / 退出），
 *   `onDestroy()` **只断引用不碰画布**（碰了会堵死引擎销毁队列，表现为画面永久卡住）。
 */
@ccclass('TargetPicker')
export class TargetPicker extends Component {
    /** 画布：环与四角括号都画在它上面（整层 1 次 draw call） */
    private g: Graphics | null = null;

    /**
     * 逻辑坐标的参照节点（= monsterParent）：点选点反变换的坐标系，也是 bind 时坐标系自检的基准。
     * 只用于触摸点换算，**不持有实体**。
     */
    private spaceAnchor: Node | null = null;

    /** 点选回调（宿主实现"点中了谁 / 要不要改目标"） */
    private onTap: ((x: number, y: number) => void) | null = null;

    /** 当前画着的目标与上一次画的位置/半径（脏检查：都没变就跳过 clear + 重画） */
    private marked: Entity | null = null;
    private lastX = Number.NaN;
    private lastY = Number.NaN;
    private lastR = Number.NaN;
    /** 上一帧是否真的画过（没画过就不必 clear） */
    private drewLastFrame = false;

    /** 复用的 Color / 坐标容器（Graphics 的 setter 内部会拷贝，复用安全；见 HitVfxLayer.setPaint） */
    private readonly paint = new Color(255, 255, 255, 255);
    private readonly downPoint = new Vec2();
    private readonly upPoint = new Vec2();
    private readonly worldPoint = new Vec3();

    // ============ 绑定 / 解绑 ============

    /**
     * 绑定：取画布 + 撑开输入区 + 坐标系自检 + 注册触摸。
     *
     * @param spaceAnchor 逻辑坐标参照节点（= monsterParent）；传空则退回本节点的父节点
     * @param onTap       点选回调 `(x, y)` —— **逻辑世界坐标**（与 `entity.position` 同一套数）
     */
    bind(spaceAnchor: Node | null, onTap: (x: number, y: number) => void): void {
        this.unbind();

        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        // 圆头 + 圆角拐角（风格预设：线宽 1~2px、圆头）—— 括号的拐角才不会"缺一块"
        this.g.lineJoin = Graphics.LineJoin.ROUND;
        this.g.lineCap = Graphics.LineCap.ROUND;

        // 输入区的判定框 = 本节点的 UITransform 矩形，必须覆盖整个可见战场（见 TAP_SELECT.coverSize）
        const ui = this.node.getComponent(UITransform);
        if (ui) ui.setContentSize(COVER_SIZE, COVER_SIZE);

        this.spaceAnchor = spaceAnchor ?? this.node.parent;
        this.checkSpace(this.spaceAnchor);

        this.onTap = onTap ?? null;
        // 只注册 TOUCH_END 就够：
        //   · 触摸在 TOUCH_START 那一刻已被引擎判给本节点（命中测试发生在引擎侧，见类注释）；
        //   · "点选"必须能反悔 —— 判据是按下点与抬起点的位移（slopPx），所以落点在抬起时才结算；
        //   · 手指滑出判定区 / 被系统打断 → 引擎把事件转成 TOUCH_CANCEL，本层不注册它，
        //     于是**天然什么都不做**（这正是想要的："没抬在场上"就不算点选）。
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    /**
     * 解绑 / 清场：摘触摸 + 清标记 + 断引用。
     * 用在**节点还活着**的时候（换局 `resetRun`、退出战斗、重新 bind）。
     */
    unbind(): void {
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.onTap = null;
        this.clearMark();
        this.spaceAnchor = null;
    }

    /**
     * 组件销毁兜底：**只摘事件 + 断引用，不碰画布**。
     *
     * 理由与 `HitVfxLayer.onDestroy` 完全相同：画布与本组件同节点，销毁顺序由组件注册顺序决定，
     * `Graphics._impl` 可能已被置 null，此时 `clear()` 会抛 TypeError；而 `onDestroy` 是引擎
     * `CCObject._deferredDestroy()` 调的 —— 那里抛异常会让销毁队列不清空（每帧从同一个对象重新抛），
     * 并且 `director.tick` 会在绘制之前被打断 → **画面永久卡在上一帧**。
     */
    onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.onTap = null;
        this.spaceAnchor = null;
        this.marked = null;
        this.g = null;
    }

    /**
     * 坐标系自检（bind 时一次；纯局部变换比较，不依赖世界矩阵，所以不会有"矩阵还没就绪"的误报）。
     *
     * 能零成本且**必定正确**判出来的错法只有一种：本节点就在参照节点的同一父节点下、
     * 但被挪了位置或改了缩放 —— 这时标记会整体偏掉（点选仍然准，因为触摸点走的是参照节点）。
     */
    private checkSpace(anchor: Node | null): void {
        if (!anchor?.isValid || this.node.parent !== anchor) return;
        const p = this.node.position;
        const s = this.node.scale;
        if (p.x === 0 && p.y === 0 && s.x === 1 && s.y === 1) return;
        console.warn(
            `[TargetPicker] 点选层与 ${anchor.name} 同父但局部变换不同`
            + `（position=${p.x},${p.y} scale=${s.x},${s.y}）：标记按逻辑坐标直接绘制、不做坐标转换，`
            + '会整体偏移 —— 请把层节点的 position 归零、scale 置 1，或让它与参照节点保持同一变换。',
        );
    }

    // ============ 输入 ============

    /**
     * 抬起手指 → 上报点选点（逻辑坐标）。
     *
     * 三件判据，任何一条不满足就**静默忽略**（点选失败不该有副作用）：
     *   ① 位移 ≤ `TAP_SELECT.slopPx`（按下去又划走 = 拖拽，不是点选）；
     *   ② 参照节点与它的 UITransform 都还在（换局/退出后可能是空引用）；
     *   ③ 宿主给了 `onTap`。
     */
    private onTouchEnd(e: EventTouch): void {
        const down = e.getUIStartLocation(this.downPoint);
        const up = e.getUILocation(this.upPoint);
        const dx = up.x - down.x;
        const dy = up.y - down.y;
        if (dx * dx + dy * dy > TAP_SELECT.slopPx * TAP_SELECT.slopPx) return;

        const local = this.toLogical(up.x, up.y);
        if (local) this.onTap?.(local.x, local.y);
    }

    /**
     * UI 坐标 → **逻辑世界坐标**（与 `entity.position` 同一套数）
     *
     * `Touch.getUILocation()` 给的是 UI 坐标：Canvas 按设计分辨率对齐之后，它与 UI 节点的
     * **世界坐标是同一个空间**（原点在屏幕左下角），所以经参照节点（monsterParent）的
     * `convertToNodeSpaceAR` 反变换即得到逻辑坐标 —— `EntityView.bind` 正是拿 `entity.position`
     * 直接 `setPosition` 的（见类注释的坐标系契约）。
     */
    private toLogical(uiX: number, uiY: number): { x: number; y: number } | null {
        const anchor = this.spaceAnchor;
        if (!anchor?.isValid) return null;
        const ui = anchor.getComponent(UITransform);
        if (!ui) return null;
        Vec3.set(this.worldPoint, uiX, uiY, 0);
        const p = ui.convertToNodeSpaceAR(this.worldPoint);
        return { x: p.x, y: p.y };
    }

    // ============ 选中标记 ============

    /**
     * 画出"现在打的是它"（宿主每帧调一次；传 `null` = 不画）
     *
     * 脏检查：目标、坐标、半径三者都没变就一个图元都不重画 —— 怪站着不动时本层是零开销的。
     *
     * ⚠ 传进来的必须是**还活着的**实体：本层只做 `IsDead` 兜底，不判"是否已回对象池"
     *   （那条判据在宿主的 `isTargetUsable` 里，是唯一的真源；池化实体回池后位置会被复位，
     *   在这里画会得到一个飘在原点上的环）。
     */
    mark(target: Entity | null): void {
        if (!this.g) return;
        if (!target || target.IsDead?.() || !target.position) {
            this.clearMark();
            return;
        }
        const p = target.position;
        const r = Math.max(TARGET_MARK.ringMinRadiusPx, radiusOf(target) + TARGET_MARK.ringPadPx);
        if (this.drewLastFrame && target === this.marked
            && p.x === this.lastX && p.y === this.lastY && r === this.lastR) return;

        this.marked = target;
        this.lastX = p.x;
        this.lastY = p.y;
        this.lastR = r;

        const g = this.g;
        g.clear();
        this.setPaint(g, TARGET_MARK.color, TARGET_MARK.alpha / 255);
        g.lineWidth = TARGET_MARK.lineWidthPx;

        // 环：贴在本体外缘之外（只描边不填充 —— GraphCircle / HitVfxLayer 的既有口径）
        g.circle(p.x, p.y, r);

        // 四角括号：贴在外接正方体的四个角上，两臂各沿一条边向内 → 读作"框住了这只"
        const half = r + TARGET_MARK.bracketGapPx;
        const arm = TARGET_MARK.bracketArmPx;
        for (let sx = -1; sx <= 1; sx += 2) {
            for (let sy = -1; sy <= 1; sy += 2) {
                const cx = p.x + sx * half;
                const cy = p.y + sy * half;
                g.moveTo(cx - sx * arm, cy);
                g.lineTo(cx, cy);
                g.lineTo(cx, cy - sy * arm);
            }
        }
        // 一次 stroke 画完（环与括号同线宽同色，所以是 1 次 draw call）
        g.stroke();
        this.drewLastFrame = true;
    }

    /** 清掉标记（没画过就什么都不做；换局/取消/目标死亡都走这里 —— 幂等） */
    clearMark(): void {
        this.marked = null;
        this.lastX = Number.NaN;
        this.lastY = Number.NaN;
        this.lastR = Number.NaN;
        if (!this.drewLastFrame) return;
        this.drewLastFrame = false;
        if (this.g) this.g.clear();
    }

    /** 当前是否画着标记（调试 / 自检用） */
    get hasMark(): boolean {
        return this.drewLastFrame;
    }

    /** 设置当前画笔色（描边 + 填充同时设；同 `HitVfxLayer.setPaint`，复用 Color 实例是安全的） */
    private setPaint(g: Graphics, rgb: number, alpha: number): void {
        const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
        this.paint.set((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, Math.round(a * 255));
        g.strokeColor = this.paint;
        g.fillColor = this.paint;
    }
}

/** 单位的碰撞半径（已含体型缩放；缺字段/为 0 时退回 0，由 `ringMinRadiusPx` 兜底） */
function radiusOf(entity: any): number {
    const r = entity?.collisionRadius;
    return typeof r === 'number' && r > 0 ? r : 0;
}
