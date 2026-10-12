import { _decorator, Color, Label, Node, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, resources } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeKeys } from '../StageScope';
import { rarityColor } from '../../../../../common/RelicRarityColor';
import {
    ITEM_BAG_EXPAND_SECONDS, ITEM_BAG_FLY_ARC, ITEM_BAG_FLY_SECONDS, ITEM_BAG_FLY_SIZE,
} from '../../../../../common/ItemBagConfig';
import type { ItemBagVM } from '../../../../../battle/ItemBag';
import { ITEM_BAG_PICKED, ItemBagCell } from './ItemBagCell';

const { ccclass, property } = _decorator;

/**
 * 节点契约（预制件 `View_Game_Stage/item_bags` 下已摆好，**本组件不改预制件结构**）：
 *
 * ```
 * item_bags/                      ← 本组件挂在这个节点上（HUD 运行时 addComponent）
 *   ├─ toggle/                    收纳按钮（常显；点它展开 / 收起）
 *   │    ├─ icon                 背包图标
 *   │    ├─ arrow                指向右（展开方向）；展开后镜像成指左
 *   │    └─ count                `已装/格数`（如 `2/6`）
 *   └─ content/                   展开区（**默认 false = 收起**，点按钮后向右滑出）
 *        ├─ cells/               6 个格子（`cell_1` … `cell_6`，运行时挂 `ItemBagCell`）
 *        │    └─ cell_N/        [Sprite(底框) + Button] / bg / icon / name
 *        └─ tip/                 说明浮层（单击某格时显示那件道具：名字 / 效果 / 操作提示）
 *             ├─ name / desc / hint
 * ```
 *
 * ── 四件事分得干干净净 ──
 *   · **格子内容与能不能用** → `ItemBag`（宿主 provide 的只读门面 `ItemBagVM`；面板不存第二份）
 *   · **一件道具长什么样** → `battle_items.json`（名字 / 效果 / 品质 / 时长）
 *   · **怎么摆、怎么动** → 本组件（滑出 / 飞入 / 弹跳，数值一律取 `ItemBagConfig`）
 *   · **什么时候掉、掉了算谁的** → 宿主 `Scene_Game_Stage`（它调 `ItemBag.drop`，再把结果丢给 HUD）
 *
 * ── 收起态为什么默认 ──
 *   6 个格子摊在 HUD 上会一直占着屏幕左下角（那里还有 buff 栏与按钮列）。默认只留一颗按钮，
 *   点一下才向右展开 —— 见 `docs/artifact-drop/README.md` §11。
 */
@ccclass('ItemBagPanel')
export class ItemBagPanel extends UIWidget {

    /* ===== 编辑器可拖的引用（留空则按下面的节点名在自身子树里找） ===== */
    @property(Node)
    toggleNode: Node = null;
    @property(Node)
    contentNode: Node = null;
    @property(Node)
    cellsNode: Node = null;
    @property(Node)
    tipNode: Node = null;

    /** 宿主注入的功能门面（格子内容 / 空格数 / 能否使用都从它读） */
    private itemBag: ItemBagVM = null;

    private cells: ItemBagCell[] = [];

    /** 展开态（**不是响应式状态**：它只描述"这一屏现在怎么摆"，与战斗无关） */
    private expanded = false;

    /** 展开区收起来时的 x（= 展开位往左挪一个自身宽度：点一下向右滑出来） */
    private collapsedX = 0;
    /** 展开位 x / 共同的 y（**`onInit` 时从预制件现读**，不写死数值 —— 改版式只动预制件） */
    private authoredX = 0;
    private contentY = 0;
    private contentOpacity: UIOpacity = null;
    private arrowNode: Node = null;
    private countLabel: Label = null;
    private tipName: Label = null;
    private tipDesc: Label = null;

    /** 说明浮层现在讲的是哪一格（`-1` = 没显示） */
    private tipSlot = -1;

    /** 正在滑出的动画（`null` = 静止） */
    private slide: { from: number; to: number; age: number; life: number; collapsing: boolean } = null;
    /** 正在飞行的道具块 */
    private flights: FlyBlock[] = [];
    /** 收纳按钮的落格弹跳剩余时间 */
    private togglePunch = 0;

    /** 飞行块用的圆角底图（`textures/common/rect_rd_20`，静态缓存只加载一次） */
    private static roundFrame: SpriteFrame = null;

    /* ===================================================================
     * UIWidget 生命周期
     * =================================================================== */

    protected onInit(): void {
        this.itemBag = this.inject<ItemBagVM>(StageScopeKeys.ItemBag, null);
        if (!this.itemBag) {
            ezgame.warn('[道具背包] 没注入到 ItemBag 门面（不在 Scene_Game_Stage 子树下？），6 个格子不会刷新');
        }

        this.resolveRefs();
        this.loadRoundFrame();

        // 点收纳按钮：展开 / 收起（只翻自己这一份状态，不碰任何战斗状态）
        this.toggleNode?.on(Node.EventType.TOUCH_END, this.toggleExpanded, this);

        // 格子单击 → 弹说明（**面板内部**的事件，宿主不需要知道）
        this.scope.on(ITEM_BAG_PICKED, this.onCellPicked, this);
        // 格子内容变了 → 重画 6 个格子与 `已装/格数`
        this.scope.watch(() => this.itemBag?.slots.value, () => this.refresh());

        this.collapseNow();
        this.refresh();
    }

    protected onShow(): void {
        // 每局开局都回到"收起 + 没有说明浮层"（上一局展开着没关的，新一局不该接着展开）
        this.collapseNow();
        this.refresh();
    }

    protected onDispose(): void {
        // ⚠ 这些节点都是本组件的后代：销毁时它们先被 `_destruct()`（字段清空），
        //   直接 `.off()` 会抛异常堵死引擎销毁队列 → 一律走 `offNodeEvent`
        this.offNodeEvent(this.toggleNode, Node.EventType.TOUCH_END, this.toggleExpanded, this);
        // 飞行中的块是运行时建的、不在预制件里，收尾时自己销毁（别留孤儿节点）
        for (const f of this.flights) {
            if (f.node?.isValid) f.node.destroy();
        }
        this.flights.length = 0;
        this.slide = null;
    }

    /**
     * 帧驱动三件事（**不用 tween**：销毁/换局时不会留下"跑到一半的补间"，
     * 与 `HitFeelDirector` / `View_Game_Stage` 的 HUD 弹跳同一口径）：
     *   ① 展开 / 收起 的滑出与淡入淡出
     *   ② 掉落道具块的贝塞尔飞行
     *   ③ 收纳按钮的落格弹跳
     */
    update(dt: number): void {
        this.tickSlide(dt);
        this.tickFlights(dt);
        this.tickTogglePunch(dt);
    }

    /* ===================================================================
     * 对外（宿主 `Scene_Game_Stage` / HUD 用的三个入口）
     * =================================================================== */

    /** 飘字提示的锚点节点（HUD 把提示挂在这颗按钮正上方） */
    get anchorNode(): Node {
        return this.toggleNode ?? this.node;
    }

    /** 现在是不是展开着（HUD 的提示语可以据此措辞；也是自检用） */
    get isExpanded(): boolean {
        return this.expanded;
    }

    /**
     * 一件道具**从掉落点飞进背包**（阶段 Boss 阵亡时由 HUD 调）。
     *
     * @param fromWorld 掉落点的**UI 世界坐标**（场景从实体的逻辑坐标换算过来）；
     *                  传 null（拿不到掉落点）时退化成"从按钮上方飞入" —— **绝不静默不画**
     * @param slot      落进第几格。收起态下飞向**收纳按钮**（落点即"进包了"），展开态飞向那一格
     */
    flyIn(fromWorld: Vec3 | null, slot: number): void {
        const hostUI = this.node.getComponent(UITransform);
        if (!hostUI) return;

        const cell = this.expanded ? (this.cells[slot]?.node ?? null) : null;
        const target = cell ?? this.toggleNode;
        if (!target?.isValid) return;

        const to = hostUI.convertToNodeSpaceAR(target.worldPosition);
        let from = new Vec3(to.x, to.y + ITEM_BAG_FLY_SIZE, 0);
        if (fromWorld) {
            const p = hostUI.convertToNodeSpaceAR(fromWorld);
            from = new Vec3(p.x, p.y, 0);
        }

        const cfg = this.itemBag ? this.itemBag.cfgAt(slot) : undefined;
        const block = this.buildFlyBlock(cfg?.name ?? '', cfg?.rarity ?? 'common');
        if (!block) return;

        // 控制点：中点 + 法线拱起（直线飞太"机械"，同打击反馈的奖励飞入）
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;

        this.flights.push({
            node: block,
            x0: from.x, y0: from.y,
            cx: (from.x + to.x) * 0.5 + nx * ITEM_BAG_FLY_ARC,
            cy: (from.y + to.y) * 0.5 + ny * ITEM_BAG_FLY_ARC,
            tx: to.x, ty: to.y,
            age: 0,
            life: ITEM_BAG_FLY_SECONDS,
            slot,
        });
    }

    /* ===================================================================
     * 展开 / 收起
     * =================================================================== */

    /** 点收纳按钮：开着就收、关着就开 */
    toggleExpanded(): void {
        if (this.expanded) this.collapse();
        else this.expand();
    }

    expand(): void {
        if (!this.contentNode) return;
        if (this.expanded && this.slide === null) return;
        this.expanded = true;
        this.contentNode.active = true;
        this.applyArrow();
        // 从**当前所在的位置**滑到展开位（连点两下时不会跳回起点，动画接着走）
        this.slide = {
            from: this.contentNode.position.x,
            to: this.authoredX,
            age: 0,
            life: ITEM_BAG_EXPAND_SECONDS,
            collapsing: false,
        };
    }

    collapse(): void {
        if (!this.contentNode) return;
        if (!this.expanded && this.slide === null) return;
        this.expanded = false;
        this.hideTip();
        this.applyArrow();
        this.slide = { from: this.contentNode.position.x, to: this.collapsedX, age: 0, life: ITEM_BAG_EXPAND_SECONDS, collapsing: true };
    }

    /** 立刻收起（不播动画）：换局 / 首次显示时调 */
    collapseNow(): void {
        this.expanded = false;
        this.slide = null;
        this.hideTip();
        if (this.contentNode) {
            this.contentNode.setPosition(this.collapsedX, this.contentY, 0);
            this.contentNode.active = false;
        }
        if (this.contentOpacity) this.contentOpacity.opacity = 0;
        this.applyArrow();
    }

    private tickSlide(dt: number): void {
        const s = this.slide;
        if (!s || !this.contentNode?.isValid) return;
        s.age += dt;
        const t = Math.min(1, s.life > 0 ? s.age / s.life : 1);
        const e = 1 - (1 - t) * (1 - t);                 // ease-out：出手快、落位稳
        this.contentNode.setPosition(s.from + (s.to - s.from) * e, this.contentY, 0);
        if (this.contentOpacity) this.contentOpacity.opacity = Math.round(255 * (s.collapsing ? 1 - e : e));

        if (t < 1) return;
        this.slide = null;
        if (s.collapsing) {
            this.contentNode.active = false;
            this.contentNode.setPosition(this.collapsedX, this.contentY, 0);
        } else if (this.contentOpacity) {
            this.contentOpacity.opacity = 255;
        }
    }

    /** 展开位（预制件里作者摆的那个 x —— 展开态不写死数值，改版式只动预制件） */
    private contentWidth(): number {
        const ui = this.contentNode?.getComponent(UITransform);
        return ui ? ui.width : 0;
    }

    private applyArrow(): void {
        if (this.arrowNode) this.arrowNode.setScale(this.expanded ? -1 : 1, 1, 1);   // 镜像成指左 = "可以收回去了"
    }

    /* ===================================================================
     * 格子 / 说明浮层
     * =================================================================== */

    /** 重画 6 个格子 + 按钮上的 `已装/格数`（watch / onShow / onInit 的公共出口） */
    refresh(): void {
        for (const c of this.cells) c.refresh();

        if (this.countLabel && this.itemBag) {
            const total = this.itemBag.slotCount();
            const used = total - this.itemBag.freeCount();
            this.countLabel.string = `${used}/${total}`;
        }

        // 说明浮层讲的那一格被用掉/被换掉了 → 收起来（别挂着一块讲空格的板子）
        if (this.tipSlot >= 0) {
            const cfg = this.itemBag ? this.itemBag.cfgAt(this.tipSlot) : undefined;
            if (!cfg) this.hideTip();
            else this.fillTip(cfg.name, cfg.desc);
        }
    }

    /** 格子单击：`slot < 0` = 点了空格子（等同于"点了一下别处"） */
    private onCellPicked(slot: number): void {
        if (slot < 0) {
            this.hideTip();
            return;
        }
        const cfg = this.itemBag ? this.itemBag.cfgAt(slot) : undefined;
        if (!cfg) {
            this.hideTip();
            return;
        }
        this.fillTip(cfg.name, cfg.desc);
        if (this.tipNode) this.tipNode.active = true;
        this.tipSlot = slot;
    }

    private fillTip(name: string, desc: string): void {
        if (this.tipName) this.tipName.string = name;
        if (this.tipDesc) this.tipDesc.string = desc;
    }

    private hideTip(): void {
        this.tipSlot = -1;
        if (this.tipNode) this.tipNode.active = false;
    }

    /* ===================================================================
     * 飞行的道具块 / 弹跳
     * =================================================================== */

    /**
     * 造一块飞行中的道具（**运行时建，不进预制件**）：品质色圆角块 + 白底 + 名字。
     * 与格子的画法刻意一致 —— 落格时视觉上"就是它进去了"，不需要额外解释。
     */
    private buildFlyBlock(name: string, rarity: string): Node {
        if (!ItemBagPanel.roundFrame) return null;
        const size = ITEM_BAG_FLY_SIZE;

        const root = new Node('item_fly');
        root.layer = this.node.layer;
        this.node.addChild(root);
        root.setSiblingIndex(this.node.children.length - 1);      // 压在同级之上
        const rui = root.addComponent(UITransform);
        rui.setContentSize(size, size);
        const frame = root.addComponent(Sprite);
        frame.sizeMode = Sprite.SizeMode.CUSTOM;                  // ⚠ 必须先于 spriteFrame
        frame.type = Sprite.Type.SLICED;
        frame.spriteFrame = ItemBagPanel.roundFrame;
        frame.color = new Color(rarityColor(rarity));
        rui.setContentSize(size, size);

        const inner = new Node('bg');
        inner.layer = root.layer;
        root.addChild(inner);
        const iui = inner.addComponent(UITransform);
        iui.setContentSize(size - 8, size - 8);
        const isp = inner.addComponent(Sprite);
        isp.sizeMode = Sprite.SizeMode.CUSTOM;
        isp.type = Sprite.Type.SLICED;
        isp.spriteFrame = ItemBagPanel.roundFrame;
        isp.color = new Color(255, 255, 255, 255);
        iui.setContentSize(size - 8, size - 8);

        const label = new Node('name');
        label.layer = root.layer;
        root.addChild(label);
        const lui = label.addComponent(UITransform);
        lui.setContentSize(size - 12, 18);
        const lb = label.addComponent(Label);
        lb.string = name;
        lb.fontSize = 12;
        // ⚠ **不要写 lineHeight**：行距只许是 0（引擎自动）/ 字号本身 / round(字号 × 1.5)，
        //   随手写个 `字号 + 4` 会被 `npm run audit:ui` 判违规（预制件里那 10 个 Label 就是这么修的）
        lb.color = new Color(68, 80, 84, 255);                    // c-ink-900
        lb.horizontalAlign = Label.HorizontalAlign.CENTER;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.CLAMP;

        return root;
    }

    private tickFlights(dt: number): void {
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const f = this.flights[i];
            if (!f.node?.isValid) { this.flights.splice(i, 1); continue; }
            f.age += dt;
            const t = Math.min(1, f.life > 0 ? f.age / f.life : 1);
            const e = 1 - (1 - t) * (1 - t);                      // 先快后慢：落到背包时几乎停住
            const u = 1 - e;
            const x = u * u * f.x0 + 2 * u * e * f.cx + e * e * f.tx;
            const y = u * u * f.y0 + 2 * u * e * f.cy + e * e * f.ty;
            f.node.setPosition(x, y, 0);
            const s = 1 - 0.22 * e;                               // 末段缩小 = "收进格子里"
            f.node.setScale(s, s, 1);

            if (t < 1) continue;

            // 落格：展开态弹那一格，收起态弹收纳按钮（**无论哪种都要有落地反馈**）
            const cell = this.expanded ? this.cells[f.slot] : null;
            if (cell) cell.punch();
            else this.togglePunch = 0.18;
            f.node.destroy();
            this.flights.splice(i, 1);
        }
    }

    private tickTogglePunch(dt: number): void {
        if (this.togglePunch <= 0 || !this.toggleNode?.isValid) return;
        this.togglePunch = Math.max(0, this.togglePunch - dt);
        const t = 1 - this.togglePunch / 0.18;
        const s = 1 + 0.12 * Math.sin(Math.PI * t);
        this.toggleNode.setScale(s, s, 1);
        if (this.togglePunch <= 0) this.toggleNode.setScale(1, 1, 1);   // ⚠ 收尾必须复位
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 按名字解析节点 + 给 6 个格子挂组件并下发格号 */
    private resolveRefs(): void {
        if (!this.toggleNode) this.toggleNode = this.node.getChildByName(TOGGLE_NODE);
        if (!this.contentNode) this.contentNode = this.node.getChildByName(CONTENT_NODE);
        if (this.contentNode) {
            if (!this.cellsNode) this.cellsNode = this.contentNode.getChildByName(CELLS_NODE);
            if (!this.tipNode) this.tipNode = this.contentNode.getChildByName(TIP_NODE);
            this.authoredX = this.contentNode.position.x;
            this.contentY = this.contentNode.position.y;
            this.collapsedX = this.authoredX - this.contentWidth();
            this.contentOpacity = this.contentNode.getComponent(UIOpacity) ?? this.contentNode.addComponent(UIOpacity);
        }
        if (!this.toggleNode) ezgame.warn(`[道具背包] 预制件里找不到 \`${TOGGLE_NODE}\` 节点，背包打不开`);
        if (!this.contentNode) ezgame.warn(`[道具背包] 预制件里找不到 \`${CONTENT_NODE}\` 节点，格子无处可放`);
        if (!this.cellsNode) ezgame.warn(`[道具背包] \`${CONTENT_NODE}\` 下找不到 \`${CELLS_NODE}\` 节点，6 个格子不会出现`);
        if (!this.tipNode) ezgame.warn(`[道具背包] \`${CONTENT_NODE}\` 下找不到 \`${TIP_NODE}\` 节点，单击格子不会有说明`);

        this.arrowNode = this.toggleNode?.getChildByName(ARROW_NODE) ?? null;
        const countNode = this.toggleNode?.getChildByName(COUNT_NODE) ?? null;
        this.countLabel = countNode ? countNode.getComponent(Label) : null;
        if (this.tipNode) {
            this.tipName = this.tipNode.getChildByName(TIP_NAME)?.getComponent(Label) ?? null;
            this.tipDesc = this.tipNode.getChildByName(TIP_DESC)?.getComponent(Label) ?? null;
        }

        // 6 个格子：给预制件里摆好的节点逐个挂上 ItemBagCell（**运行时挂，不改预制件**）
        this.cells = [];
        if (this.cellsNode) {
            this.cellsNode.children.forEach((node, index) => {
                const cell = node.getComponent(ItemBagCell) ?? node.addComponent(ItemBagCell);
                // ⚠ `addComponent` 可能**当场就跑完 onInit**（那时 slotIndex 还是 -1，组件按兄弟顺序自推），
                //   所以显式下发格号后要再刷一次，首帧的表现才跟格号一致
                const changed = cell.slotIndex !== index;
                cell.slotIndex = index;
                if (changed) cell.refresh();
                this.cells.push(cell);
            });
        }
        // 格数与预制件对不上时**必须喊出来**：多出来的格子装得下但看不见（见 ItemBagConfig 的告警）
        const expected = this.itemBag ? this.itemBag.slotCount() : this.cells.length;
        if (this.cells.length !== expected) {
            ezgame.warn(`[道具背包] 预制件里有 ${this.cells.length} 个格子，配表说 ${expected} 个 —— 两边要一致（ItemBagConfig.ITEM_BAG_SLOT_COUNT）`);
        }
    }

    /** 飞行块用的圆角底图（静态缓存；失败只报错、不抛） */
    private loadRoundFrame(): void {
        if (ItemBagPanel.roundFrame) return;
        resources.load('textures/common/rect_rd_20/spriteFrame', SpriteFrame, (err, sf) => {
            if (err || !sf) {
                ezgame.error('[道具背包] 圆角底图加载失败（飞行中的道具块会画不出来）', err);
                return;
            }
            ItemBagPanel.roundFrame = sf;
        });
    }
}

/** 预制件里的节点名（改名字要同步这里 + 预制件） */
const TOGGLE_NODE = 'toggle';
const CONTENT_NODE = 'content';
const CELLS_NODE = 'cells';
const TIP_NODE = 'tip';
const ARROW_NODE = 'arrow';
const COUNT_NODE = 'count';
const TIP_NAME = 'name';
const TIP_DESC = 'desc';

/** 一块正在飞行的道具 */
interface FlyBlock {
    node: Node;
    /** 起点 / 控制点 / 终点（**本层局部坐标**） */
    x0: number; y0: number;
    cx: number; cy: number;
    tx: number; ty: number;
    age: number;
    life: number;
    /** 会落到第几格（收起态下不用，只弹按钮） */
    slot: number;
}
