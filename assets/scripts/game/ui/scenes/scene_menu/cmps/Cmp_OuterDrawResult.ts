import { _decorator, Button, instantiate, Label, Node, Tween, tween, UIOpacity, Vec3 } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import type { IOuterDrawLine } from '../../../../data';
import { getOuterRelic } from '../../../../data/configs/EquipmentConfig';
import { OuterDrawResultItem } from './OuterDrawResultItem';
import { OuterDrawScopeEvents } from './OuterDrawScope';

const { ccclass, property } = _decorator;

/** 节点契约（改预制件里的名字要同步这里；都留了按名字兜底，没拖 `@property` 也能跑） */
const NODE = {
    mask: 'mask',
    panel: 'panel',
    grid: 'panel/grid',
    okBtn: 'panel/btn_ok',
    closeBtn: 'panel/btn_close',
    /** 卡片模板（`active=false`，运行时克隆；与 `outer_relics/templates` 同一套路，不新建预制件资产） */
    template: 'templates/DrawResultItem',
} as const;

/** 卡片网格：一行最多几张 + 卡片尺寸 / 间距（与预制件里 `templates/DrawResultItem` 的框一致） */
const CARD_COLS = 5;
const CARD_W = 112;
const CARD_H = 150;
const GAP_X = 10;
const GAP_Y = 12;

/** 生成出来的卡片节点名前缀（重铺时只清这些；模板自己不在 `grid` 里） */
const CARD_PREFIX = 'card_';

/* ── 小动画的三个数（都在"一眼看得出来"与"别让人等"之间取的）──
 * 面板：0.9 → 1.0 的 `backOut` 弹入（`backOut` 会略微过冲，是本作唯一允许的"弹性"）；
 * 卡片：`0.6 → 1.0`，**逐张延迟 `CARD_STAGGER` 秒** —— 十连时最后一张在 0.36 + 0.16 ≈ 0.52s 落位；
 * 遮罩：透明度 0 → 255，比面板略快，避免"黑幕还在淡入、面板已经跳完了"。
 */
const PANEL_FROM_SCALE = 0.9;
const CARD_FROM_SCALE = 0.6;
const CARD_STAGGER = 0.04;

/**
 * `Scene_Menu/ui_draw_result` —— **局外遗物抽取的结果弹窗**
 *
 * ── 节点契约（`assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab`）──
 * ```
 * ui_draw_result             ← 本组件挂这里（宿主 = Scene_Menu，显隐由宿主写）；750×1334，静置 active=false
 * ├── mask                   全屏遮罩（`white_4x4` × `#000000` α178，纯视觉**不接点击**，理由同难度弹窗）
 * └── panel                  640×540
 *     ├── bg                 rect_rd_20 白卡
 *     ├── title              「获得遗物」
 *     ├── line               分隔线
 *     ├── grid               卡片容器（运行时按 5 列摆克隆出来的卡）
 *     ├── btn_ok             「确 定」（青绿药丸）
 *     ├── btn_close          ×（右上角，与 `ui_hero_detail` 同一颗 `close` 图标）
 *     └── (templates 在根下)
 * templates
 * └── DrawResultItem         112×150 的卡模板（`active=false`）：bg / head(inner) / name / sub
 * ```
 *
 * ── 职责（只有两件，别越界）──
 *   ① **渲染**：把宿主下发的 `IOuterDrawLine[]` 铺成一张张卡（一件一卡）；
 *   ② **上报**：点「确 定 / ×」`emit(CloseResult)`。
 * 本类**不认识 `DataCenter`、不认识抽取规则** —— 抽到什么、每一件几份、是不是新收集，
 * 全在 `DataCenter.drawOuterRelic()` 的结果里；这里只把 `id` 换成图标路径（`getOuterRelic`）。
 *
 * ⚠ **不显示"这次一共抽到几件"**（用户口径）：那个数会被写进「抽 取」按钮那行、把"下一抽多少钱"
 *   挤掉；数量在面板里由**一张卡一件**自然表达，重复的件另写 `×N`（= 抽完之后的**总份数**）。
 *
 * ⚠ **`active` 由宿主写**（同 `Cmp_HeroDetail` / `Cmp_Difficulty`）：弹窗自己不动自己的节点。
 * 宿主的标准写法（顺序不能反 —— 先下发数据再显示，`onShow` 才会按新数据重铺 + 放动画）：
 * ```ts
 * this.drawResult.setLines(lines);
 * this.drawResultNode.active = true;
 * ```
 */
@ccclass('Cmp_OuterDrawResult')
export class Cmp_OuterDrawResult extends UIWidget {

    /* ==================== 编辑器配置（全都可以不拖，按名字兜底） ==================== */

    @property(Node)
    panelNode: Node = null;
    @property(Node)
    maskNode: Node = null;
    @property(Label)
    titleLabel: Label = null;
    @property(Node)
    gridNode: Node = null;
    @property(Node)
    okBtnNode: Node = null;
    @property(Node)
    closeBtnNode: Node = null;
    @property(Node)
    cardTemplate: Node = null;

    /* ==================== 运行时状态 ==================== */

    /** 这一屏要画的每一件（null = 还没下发过） */
    private lines: IOuterDrawLine[] = [];
    /** 克隆出来的卡片（重铺 / 收尾都要用；**只清 `card_` 前缀的**，模板在 `templates` 下不动） */
    private cards: Node[] = [];
    /** 本次动画**起过 tween 的目标**（Node 与 UIOpacity 都可能）—— 收起时逐个停掉，避免残留动画 */
    private tweenTargets: Array<Node | UIOpacity> = [];

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        this.resolveRefs();
        this.bindButtons();
        console.log(`[遗物抽取] 结果弹窗 onInit：面板=${!!this.panelNode} 卡片模板=${!!this.cardTemplate} `
            + `确定=${!!this.okBtnNode}`);
    }

    /** 每次显示：按当前数据重铺 + 放一遍入场的三个小动画（`lines` 是普通字段，watcher 感知不到） */
    protected onShow(): void {
        this.render();
        this.playShowAnim();
    }

    protected onHide(): void {
        this.stopAnim();
    }

    protected onDispose(): void {
        this.stopAnim();
        this.offNodeEvent(this.okBtnNode, Button.EventType.CLICK, this.onClickClose, this);
        this.offNodeEvent(this.closeBtnNode, Button.EventType.CLICK, this.onClickClose, this);
        this.cards = [];
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /**
     * 下发这一次抽到的每一件（**不负责显隐**，那是宿主的事）。
     *
     * 节点已经在显示时（同一屏里再抽一次）就地重画 + 重放动画；否则只存下来，
     * 等宿主写 `active = true` 之后由 `onShow` 铺 —— 与 `Cmp_HeroDetail.setVM` 逐字同口径。
     */
    setLines(lines: IOuterDrawLine[] | null): void {
        this.lines = Array.isArray(lines) ? lines : [];
        if (this.node.activeInHierarchy) {
            this.render();
            this.playShowAnim();
        }
    }

    /* ===================================================================
     * 渲染
     * =================================================================== */

    /**
     * 铺卡：一件一卡，**一行最多 `CARD_COLS` 张、每行各自居中**（6~9 件时最后一行不靠左）。
     *
     * ⚠ 位置是**自己算**的而不是挂 `cc.Layout`：GRID 布局会把"最后一行不足"的格子也按列宽占位，
     *   而这里要的是"这一行有几张就居中几张"（同 `Cmp_Difficulty` 手摆格子的理由）。
     */
    private render(): void {
        const grid = this.gridNode;
        if (!grid) return;
        this.clearCards();

        const lines = this.lines;
        const rows = Math.max(1, Math.ceil(lines.length / CARD_COLS));
        const rowHeight = CARD_H + GAP_Y;
        const totalHeight = rows * CARD_H + (rows - 1) * GAP_Y;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const card = this.spawnCard(grid, i);
            if (!card) continue;

            const row = Math.floor(i / CARD_COLS);
            const col = i % CARD_COLS;
            const inRow = Math.min(CARD_COLS, lines.length - row * CARD_COLS);
            card.setPosition((col - (inRow - 1) / 2) * (CARD_W + GAP_X),
                totalHeight / 2 - CARD_H / 2 - row * rowHeight, 0);

            card.getComponent(OuterDrawResultItem)
                ?.setInfo(line.id, line.name, line.rarity, this.iconOf(line.id), line.count, line.isNew);
        }
    }

    /**
     * 这件遗物的图标路径。
     *
     * ⚠ **只有这一句要防配表未就绪**：`getOuterRelic` 走 `TbRoot`，编辑器场景里没跑
     * `Main._init()` ⇒ 容器未注册会抛。把 try 收在这一句里（而不是套住整个铺卡循环）——
     * 套在外面会让**第一张卡一抛就整屏空白**（实测：只铺出 `card_0` 就断），
     * 而这一屏是玩家花金币换来的东西，宁可少一张图标也不能少一件。
     */
    private iconOf(id: number): string {
        try {
            return getOuterRelic(id)?.icon ?? '';
        } catch (err) {
            return '';
        }
    }

    /** 克隆模板 → 挂到网格 → 返回（模板缺失时返回 null，不抛） */
    private spawnCard(grid: Node, index: number): Node | null {
        if (!this.cardTemplate) return null;
        const card = instantiate(this.cardTemplate);
        if (!card) return null;
        card.name = `${CARD_PREFIX}${index}`;
        card.active = true;
        grid.addChild(card);
        this.cards.push(card);
        return card;
    }

    /**
     * 清掉上一次的卡。
     *
     * ⚠ 与 `Cmp_OuterRelics.clearGenerated` 同样的两条：只清自己生成的（`card_` 前缀），
     * 且**先 `removeFromParent()` 再 `destroy()`** —— `destroy()` 延迟到帧末，只调它的话
     * 这一帧里新旧卡会同时挂在 `grid` 下（新卡会被算进旧卡的排布里）。
     * 第三条是本组件独有的：**销毁前先把这张卡上的 tween 停掉** —— 同一屏里再抽一次时
     * 上一轮的卡片动画可能还在跑（`setLines` 就地重铺那条路），让 tween 去写一个已销毁的节点是白跑。
     */
    private clearCards(): void {
        for (const card of this.cards) {
            if (!card || !card.isValid) continue;
            Tween.stopAllByTarget(card);
            const op = card.getComponent(UIOpacity);
            if (op) Tween.stopAllByTarget(op);
            card.removeFromParent();
            card.destroy();
        }
        this.cards = [];
    }

    /* ===================================================================
     * 入场小动画
     * =================================================================== */

    /**
     * 面板弹入 + 遮罩淡入 + 卡片逐张蹦出来。
     *
     * 三条口径：
     *   · **全部走 `tween`，不用 `scheduleOnce` 串延迟** —— 收起时要能一次性 `Tween.stopAllByTarget` 停干净，
     *     定时器漏一个就会在下次打开时把新动画打断（`View_Shop.flashHint` 那类定时器就是这么踩的）；
     *   · **起始状态由本方法写**（`scale` / `opacity`），不依赖上一轮的收尾 —— 中途被打断也能恢复成对的形态；
     *   · **收尾一定复位 scale = 1**（`View_Game_Stage` 的 HUD 弹跳记过这条：停在 0.9 会一直小一号）。
     */
    private playShowAnim(): void {
        this.stopAnim();

        const panel = this.panelNode;
        if (panel) {
            panel.setScale(PANEL_FROM_SCALE, PANEL_FROM_SCALE, 1);
            tween(panel).to(0.18, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
            this.tweenTargets.push(panel);
            const op = this.ensureOpacity(panel);
            if (op) {
                op.opacity = 0;
                tween(op).to(0.12, { opacity: 255 }).start();
                this.tweenTargets.push(op);
            }
        }

        const maskOp = this.ensureOpacity(this.maskNode);
        if (maskOp) {
            maskOp.opacity = 0;
            tween(maskOp).to(0.15, { opacity: 255 }).start();
            this.tweenTargets.push(maskOp);
        }

        for (let i = 0; i < this.cards.length; i++) {
            const card = this.cards[i];
            const delay = i * CARD_STAGGER;
            card.setScale(CARD_FROM_SCALE, CARD_FROM_SCALE, 1);
            tween(card).delay(delay).to(0.16, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
            this.tweenTargets.push(card);

            const op = this.ensureOpacity(card);
            if (op) {
                op.opacity = 0;
                tween(op).delay(delay).to(0.12, { opacity: 255 }).start();
                this.tweenTargets.push(op);
            }
        }
    }

    /** 停掉本次起过的所有 tween（收起 / 销毁 / 重播之前都要调，否则上一轮的动画会继续跑到一半） */
    private stopAnim(): void {
        for (const target of this.tweenTargets) {
            if (target && target.isValid) Tween.stopAllByTarget(target);
        }
        this.tweenTargets = [];
    }

    /** 取（必要时补）节点上的 `UIOpacity` —— 预制件里已经挂好了，这里只是缺组件时的兜底 */
    private ensureOpacity(node: Node | null): UIOpacity | null {
        if (!node) return null;
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    /* ===================================================================
     * 交互（只上报，不写数据）
     * =================================================================== */

    private onClickClose(): void {
        this.scope.emit(OuterDrawScopeEvents.CloseResult);
    }

    private bindButtons(): void {
        for (const node of [this.okBtnNode, this.closeBtnNode]) {
            if (!node) continue;
            // ⚠ 过渡一律 `NONE` 自己写色（`interactable=false` 时 Button 会用 `_disabledColor` 覆盖外观，
            //   同 `HeroCard` / `Cmp_HeroDetail` 记过的那条）
            const button = node.getComponent(Button) ?? node.addComponent(Button);
            button.transition = Button.Transition.NONE;
            node.on(Button.EventType.CLICK, this.onClickClose, this);
        }
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        this.maskNode = this.maskNode ?? n.getChildByName(NODE.mask);
        this.panelNode = this.panelNode ?? n.getChildByName(NODE.panel);
        this.titleLabel = this.titleLabel
            ?? n.getChildByPath(NODE.panel)?.getChildByName('title')?.getComponent(Label) ?? null;
        this.gridNode = this.gridNode ?? n.getChildByPath(NODE.grid);
        this.okBtnNode = this.okBtnNode ?? n.getChildByPath(NODE.okBtn);
        this.closeBtnNode = this.closeBtnNode ?? n.getChildByPath(NODE.closeBtn);
        this.cardTemplate = this.cardTemplate ?? n.getChildByPath(NODE.template);

        if (!this.panelNode || !this.gridNode || !this.cardTemplate || !this.okBtnNode) {
            ezgame.warn('[遗物抽取] 结果弹窗的子节点契约不完整（需要 panel / panel/grid / panel/btn_ok / '
                + `templates/DrawResultItem）：${n.name}`);
        }
    }
}
