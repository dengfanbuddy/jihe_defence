import { _decorator, Button, Color, instantiate, Label, Node, Sprite, UITransform } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { AtlasIcon } from '../../../common/AtlasIcon';
import { formatCount } from '../../../common/GoldText';
import { rarityColor } from '../../../common/RelicRarityColor';
import { DataCenter } from '../../../data';
import { BagItem } from './BagItem';
import { BAG_EMPTY_FRAME, BagScopeEvents, type BagPageVM } from './BagScope';
import { bagFingerprint, buildBagPageVM } from './BagVM';

const { ccclass, property } = _decorator;

/**
 * View_Bag.ts — 局外背包**全屏页**（宿主 UIManager 的普通视图层）
 *
 * ## 形态（与 `View_Shop` / `View_TaskUI` 逐字同口径）
 * `views/` 形态的 `BaseView` + `@uiview`：预制件 `prefabs/ui/views/bag/View_Bag`，
 * `layer = View`，`single = true`，**返回自关**。入口 = 主界面底部「背包」页签（`Scene_Menu.onClickBag`）。
 * ⚠ 与另两个全屏页（`View_Shop` / `View_TaskUI`）以及两个场景内嵌弹窗（`ui_difficulty` / `ui_hero_detail`）
 * **不同时可见** —— 互斥由 `Scene_Menu` 在"开"的那一刻负责（`views` 层不归场景层那条自动关闭规则管）。
 *
 * ## 分层（与项目其它界面一致）—— **这一屏自己就是宿主**
 *   · **规则与数据在数据层**：道具定义在 `bag_items.json`（→ `BagConfig`），存量在 `data/funcs/BagData.ts`（存档）。
 *   · **判据只在 VM 里算一次**：`BagVM.buildBagPageVM(选中谁)` 算出整页 VM，本视图照着画（`applyPage`），
 *     **不自己算**「有几件 / 能不能用 / 正文写什么」。
 *   · **本视图负责编排**：点格子 → 换选中 → 重画（就这么一件事；本页没有发奖、没有扣费）。
 *   · ⚠ **为什么宿主不是 `Scene_Menu`**：`UIScope.emit` 只沿 `node.parent` 向上、不跨 UIManager 的层节点
 *     （`views` 与 `scenes` 是兄弟），页面的事件到不了 `Scene_Menu` 的作用域 —— 详见 `./BagScope` 文件头。
 *
 * ## 数据是响应式的
 * `BagData` 继承 `DataModule`（`reactive` + 自动落盘），所以本视图在 `init()` 里订阅一个「页面指纹」
 * （`bagFingerprint`）：商城看广告发券、以后遗物抽取扣次数、道具过期被清掉……任何地方改了数据都会自动重刷，
 * 不需要手动广播（与 `View_Shop` / `View_TaskUI` 同一套路）。
 * ⚠ 因此 `BagVM` 与指纹**都是纯读的**；"清过期"这个写操作只落在 `show()` 与每秒的 `tickClock()` 里。
 *
 * 组件挂载：预制件里没挂脚本时由 `UIManager.showUI` 运行时 `addComponent`，
 * 所有节点引用都按名字兜底解析（编辑器里不拖也能跑）。
 */
@uiview({
    prefabPath: 'prefabs/ui/views/bag/View_Bag',
    layer: ViewLayer[ViewLayer.View],
    single: true,
})
@ccclass('View_Bag')
export class View_Bag extends BaseView {

    @property(Button)
    backBtn: Button = null;
    @property(Label)
    resGoldLabel: Label = null;
    @property(Label)
    resExpLabel: Label = null;
    @property(Label)
    capValueLabel: Label = null;
    /** 容量进度条的填充（锚点在左 → 改宽度即从左往右涨，与 `TaskItem` 同一口径） */
    @property(Node)
    capFillNode: Node = null;
    /** 格子容器（`scroll/view/content`）：它的**第一个子节点就是模板格子** */
    @property(Node)
    contentNode: Node = null;
    /** 详情面板整块（`item_detail`；**恒显示**，没有选中时画"未选中"占位态，见 `applyDetail`） */
    @property(Node)
    detailNode: Node = null;
    /** 详情面板的品质底框（`item_detail/content/icon_tile`，与格子的底框同口径：品质色的唯一落点） */
    @property(Sprite)
    detailTile: Sprite = null;
    @property(Sprite)
    detailIcon: Sprite = null;
    @property(Label)
    detailNameLabel: Label = null;
    @property(Label)
    detailDescLabel: Label = null;
    @property(Button)
    useBtn: Button = null;
    @property(Label)
    useLabel: Label = null;
    @property(Button)
    sellBtn: Button = null;
    @property(Label)
    sellLabel: Label = null;

    /**
     * 「使用」按钮两态色（底是**可染的**白圆角九宫格 `rect_rd_5_white`）：
     * 可用 = `c-accent-action`（工程里"这一颗能点"的青绿，同 `HeroCard` / `View_TaskUI`），
     * 不可用 = `c-disabled-pill`（全工程"现在不可点"的灰蓝药丸色）。字色恒为白。
     */
    private static readonly USE_ON_BG = '#3F9E9B';
    private static readonly USE_OFF_BG = '#B9C1C1';
    /**
     * 「出售」按钮两态色 —— ⚠ **只回答在字上**：它的视觉主体是 `ring`（`rect_board_rd_10`），
     * 而那张图的主体是**烤进去的青绿**，`Sprite.color` 乘上去只会得到脏色（见 `OuterRelicItem` 的同类说明）。
     * 所以"不可卖"不去染环，只把字从 `c-accent-action` 换成 `c-ink-400`（与商城免广告卡同一处置）。
     */
    private static readonly SELL_ON_TEXT = '#3F9E9B';
    private static readonly SELL_OFF_TEXT = '#999999';
    /** 容量满时数字转 `c-warn`（提示"再进新道具就没格子了"） */
    private static readonly CAP_FULL_TEXT = '#C0392B';
    private static readonly CAP_TEXT = '#445054';
    /** 容量进度条满宽 = `bottom_bar/pbar` 的宽度（填充条锚点在左，按比例改宽） */
    private static readonly PBAR_FULL_WIDTH = 430;

    /** 列表格子（模板自己就是第 1 格，与难度弹窗同一口径；运行时一次性克隆到 80 格） */
    private items: BagItem[] = [];
    /** 模板格子节点（`content` 的第一个子节点 = `Bag_Cell` 实例） */
    private template: Node = null;
    /** 当前选中的道具 key（**页面本地状态**；判据仍然只在 `BagVM` 里算，见文件头） */
    private selectedKey = '';

    // ────────────── 生命周期（BaseView：init 一次 / show 每次 / close 关闭） ──────────────

    protected init(): void {
        this.resolveRefs();
        this.ensureCells();
        this.bindEvents();

        // 页面指纹：任何地方改了背包存量 / 金币 / 通用英雄经验 → 自动重刷整页
        this.scope.watch(() => bagFingerprint(), () => this.refresh());
    }

    protected show(): void {
        // 跨天长挂之后第一次打开：先把过期的道具清掉再画。
        // ⚠ 清过期是**写操作**，所以它只落在 `show()` 与每秒的 `tickClock()` 里 ——
        //   `BagVM` 是纯读的（它会被 watcher 回调间接调用，见 `BagVM.ts` 文件头）。
        DataCenter.ins.bagData.pruneExpired();
        this.refresh();
        // 一秒一次：倒计时走字 + 顺手清过期（清掉一件会改指纹 → watcher 自动重刷，格子随之消失）
        this.schedule(this.tickClock, 1);
    }

    protected close(): void {
        this.unschedule(this.tickClock);
    }

    // ────────────── 交互 ──────────────

    private bindEvents(): void {
        this.backBtn?.node.on(Button.EventType.CLICK, this.onClickBack, this);
        // 两个按钮本期都按配表置灰（`usable` / `sellable` 全 0）；真接上时判据进 `BagVM`、
        // 落点进 `DataCenter`，这里只把点击转过去 —— 与商城页的分工一致。
        this.useBtn?.node.on(Button.EventType.CLICK, this.onClickUse, this);
        this.sellBtn?.node.on(Button.EventType.CLICK, this.onClickSell, this);
        // 格子只向上通知「选了哪一格」，真正换选中 + 重画在这里
        this.scope.on(BagScopeEvents.SelectItem, this.onSelectItem, this);
    }

    /** 返回是**页面自己的事**（views 形态：UIManager 关掉自己并进缓存，宿主不需要知道） */
    private onClickBack(): void {
        UIManager.ins.closeUI(View_Bag);
    }

    /** 点某一格：换选中并重画（选中的那一格不在了会自动回落到第一格，见 `buildBagPageVM`） */
    private onSelectItem(key: string): void {
        if (!key || key === this.selectedKey) return;
        this.selectedKey = key;
        this.refresh();
    }

    /**
     * 点「使用」：**本期是死路**（表里 `usable` 全 0 ⇒ 按钮 `interactable = false`，点击根本不会到这儿）。
     * 留着它是为了"谁把配表那一列改成 1 了"的那一刻**当场喊一声**，而不是安静地什么都不发生。
     */
    private onClickUse(): void {
        ezgame.warn(`[背包] 「使用」还没有接线（${this.selectedKey}）：`
            + '这些道具都是入局 / 抽取时自动抵扣的，手动使用没有意义 —— 见 docs/bag/README.md §5');
    }

    /** 点「出售」：同上，本期是死路（`sellable` 全 0） */
    private onClickSell(): void {
        ezgame.warn(`[背包] 「出售」还没有接线（${this.selectedKey}）：`
            + '开金币回收口会与「金币是抽取燃料」的既有经济打架 —— 见 docs/bag/README.md §5');
    }

    // ────────────── 渲染（唯一入口：整页 VM） ──────────────

    /** 按当前数据重算一份 VM 并画上去（数据一变 watcher 也会调它） */
    private refresh(): void {
        this.applyPage(buildBagPageVM(this.selectedKey));
    }

    /**
     * 把一份整页 VM 画到界面上 —— **页面唯一的刷新入口**。
     * ⚠ 选中回落也要**写回本地状态**：VM 可能把选中换成别的格（原来那一格被用光了），
     *   不写回的话下一次刷新又会拿着那个已经消失的 key 去算，每次都在回落（表现为"选中态乱跳"）。
     */
    public applyPage(vm: BagPageVM): void {
        if (!vm) return;

        const selected = vm.cells.find(c => c.selected);
        this.selectedKey = selected ? selected.key : '';

        if (this.resGoldLabel) this.resGoldLabel.string = formatCount(vm.resBar.gold);
        if (this.resExpLabel) this.resExpLabel.string = formatCount(vm.resBar.heroExp);

        this.applyCells(vm);
        this.applyDetail(vm);
        this.applyCapacity(vm);
    }

    /**
     * 铺格子：**恒铺满 `vm.cells`（= 上限 80 个槽位）** —— 前几个装道具、后面是空槽
     * （"铺几格"是判据层的决定，见 `BagVM.buildBagPageVM`；空背包也要看得见格子）。
     * 模板自己当第 1 格（与难度弹窗的 100 格同一口径），不够就地克隆。
     */
    private applyCells(vm: BagPageVM): void {
        const content = this.contentNode;
        if (!content || !this.template) return;

        // 不够就克隆（首屏一次性克隆到 80；`BagItem` 用 `addComponent` 挂，与 TaskItem 同套路）
        while (this.items.length < vm.cells.length) {
            const node = instantiate(this.template);
            node.setParent(content);
            this.items.push(node.getComponent(BagItem) ?? node.addComponent(BagItem));
        }
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].setInfo(vm.cells[i] ?? null);
        }
    }

    /**
     * 详情面板（`item_detail`）：**恒显示**，两态由 `vm.detail.empty` **一处分派**（与格子的 `vm.empty` 同形）。
     *
     * ⚠ 2026-11 改口径（原来的写法是"没有选中就把面板 `active = false`"）：面板**不再整块收起**。
     *   这一屏左边是一列格子、右边是面板，面板整块消失后右半边只剩一片空白，
     *   而左边还站着 80 个格子（空背包也铺满）——玩家会以为面板没加载出来。
     *   现在没有选中时画"未选中"占位态：
     *     · 底框 = `BAG_EMPTY_FRAME`（**与格子的空槽共用同一个常量**，两处讲的都是"这儿本来该有东西"）；
     *     · `icon` / `desc` / `btn_use` / `btn_sell` **全收起**（不收起就会把上一件道具的残留留在面板上）；
     *     · `name` 写 VM 下发的占位词（`BAG_NO_SELECTION_TEXT`，界面不硬编码文案）。
     *
     * ⚠ 有选中时两个按钮按 VM 的 `usable` / `sellable` 置灰（本期恒 false），
     *   而"为什么是灰的"由正文第二行回答 —— 界面上不许出现"点不动又不说为什么"的按钮。
     */
    private applyDetail(vm: BagPageVM): void {
        const d = vm.detail;
        if (!d) return;

        const iconNode = this.detailIcon?.node;
        const descNode = this.detailDescLabel?.node;
        const useNode = this.useBtn?.node;
        const sellNode = this.sellBtn?.node;

        if (d.empty) {
            // ── 未选中：灰底 + 名字，其余全收起 ──
            if (this.detailTile) this.detailTile.color = new Color().fromHEX(BAG_EMPTY_FRAME);
            if (iconNode) iconNode.active = false;
            if (this.detailNameLabel) this.detailNameLabel.string = d.name;
            if (descNode) descNode.active = false;
            if (useNode) useNode.active = false;
            if (sellNode) sellNode.active = false;
            return;
        }

        // ── 有选中：品质底框 + 图标 + 名字 + 正文 + 两个按钮 ──
        if (this.detailTile) this.detailTile.color = new Color().fromHEX(rarityColor(d.rarity));
        if (iconNode) iconNode.active = true;
        if (descNode) descNode.active = true;
        if (useNode) useNode.active = true;
        if (sellNode) sellNode.active = true;

        if (this.detailNameLabel) this.detailNameLabel.string = d.name;
        if (this.detailDescLabel) this.detailDescLabel.string = d.desc;
        this.loadDetailIcon(d.icon);

        if (this.useBtn) {
            this.useBtn.interactable = d.usable;
            const bg = this.useBtn.getComponent(Sprite);
            if (bg) bg.color = new Color().fromHEX(d.usable
                ? View_Bag.USE_ON_BG : View_Bag.USE_OFF_BG);
        }
        if (this.useLabel) this.useLabel.string = d.useText;

        if (this.sellBtn) this.sellBtn.interactable = d.sellable;
        if (this.sellLabel) {
            this.sellLabel.string = d.sellText;
            // 环不可染 → "不可卖"只回答在字色上（见 SELL_ON_TEXT 的说明）
            this.sellLabel.color = new Color().fromHEX(d.sellable
                ? View_Bag.SELL_ON_TEXT : View_Bag.SELL_OFF_TEXT);
        }
    }

    /** 底栏容量：「容量 3/80」+ 进度条（一格 = 一种道具，所以分子就是"有存量的种类数"） */
    private applyCapacity(vm: BagPageVM): void {
        const cap = vm.capacity;
        if (this.capValueLabel) {
            this.capValueLabel.string = `${cap.used}/${cap.cap}`;
            this.capValueLabel.color = new Color().fromHEX(cap.full ? View_Bag.CAP_FULL_TEXT : View_Bag.CAP_TEXT);
        }
        if (this.capFillNode) {
            const ratio = cap.cap > 0 ? Math.max(0, Math.min(1, cap.used / cap.cap)) : 0;
            const ut = this.capFillNode.getComponent(UITransform);
            if (ut) ut.setContentSize(View_Bag.PBAR_FULL_WIDTH * ratio, ut.contentSize.height);
        }
    }

    /**
     * 每秒走一次：**只重写倒计时那一行文字**（不重算整页 VM —— 那会牵连全部格子与图标）。
     *
     * ⚠ 顺手 `pruneExpired()`：清掉一件会改 `bagFingerprint` → watcher 自己 `refresh()` →
     *   那一格随之消失。放在这里而不是 `BagVM` 里，是因为**它会被 watcher 回调间接调用**，
     *   而"在 watcher 里写数据"是这套响应式里最容易出事的写法（见 `BagVM.ts` 文件头）。
     */
    private tickClock(): void {
        DataCenter.ins.bagData.pruneExpired();
        for (const item of this.items) item.tickTimer();
    }

    private loadDetailIcon(url: string): void {
        if (!this.detailIcon || !url) return;
        AtlasIcon.loadIconFrame(url).then((sf) => {
            if (sf && this.detailIcon?.isValid) this.detailIcon.spriteFrame = sf;
        });
    }

    // ────────────── 节点契约（契约见 View_Bag.prefab；编辑器里没拖引用时按名字兜底） ──────────────

    /**
     * ⚠ 路径按名字兜底解析 —— 但**只有当预制件里那个 `@property` 是空的**才走兜底
     * （`??` 的语义）：编辑器里拖错了引用（拖到了同名层级里的另一个节点），兜底**拦不住**。
     * 所以预制件上拖的 15 个引用由 `audit:bag` 的 F16 逐条对着路径核（2026-11 抓到过一次：
     * `item_detail` 加了 `content` 之后 `detailNode` 指到了 `content`、`capFillNode` 指到了 `pbar`）。
     *
     * ⚠ 2026-11 详情面板改版后，五个子节点都挂在 **`item_detail/content`** 下面（`content` 是
     * VERTICAL Layout 容器），路径必须带上这一层。
     */
    private resolveRefs(): void {
        const n = this.node;
        const at = (path: string): Node => n.getChildByPath(path);

        this.backBtn = this.backBtn ?? at('top_bar/btn_back')?.getComponent(Button);
        this.resGoldLabel = this.resGoldLabel ?? at('top_bar/res_bar/chip_gold/value')?.getComponent(Label);
        this.resExpLabel = this.resExpLabel ?? at('top_bar/res_bar/chip_exp/value')?.getComponent(Label);
        this.capValueLabel = this.capValueLabel ?? at('bottom_bar/cap_value')?.getComponent(Label);
        this.capFillNode = this.capFillNode ?? at('bottom_bar/pbar/fill');
        this.contentNode = this.contentNode ?? at('scroll/view/content');
        this.detailNode = this.detailNode ?? at('item_detail');
        this.detailTile = this.detailTile ?? at('item_detail/content/icon_tile')?.getComponent(Sprite);
        this.detailIcon = this.detailIcon ?? at('item_detail/content/icon_tile/icon')?.getComponent(Sprite);
        this.detailNameLabel = this.detailNameLabel ?? at('item_detail/content/name')?.getComponent(Label);
        this.detailDescLabel = this.detailDescLabel ?? at('item_detail/content/desc')?.getComponent(Label);
        this.useBtn = this.useBtn ?? at('item_detail/content/btn_use')?.getComponent(Button);
        this.useLabel = this.useLabel ?? at('item_detail/content/btn_use/label')?.getComponent(Label);
        this.sellBtn = this.sellBtn ?? at('item_detail/content/btn_sell')?.getComponent(Button);
        this.sellLabel = this.sellLabel ?? at('item_detail/content/btn_sell/label')?.getComponent(Label);

        // 详情面板的所有部件都必须解析出来：面板是**恒显示**的（未选中也要画占位态），
        // 少一个引用就会留下"上一件道具的残留"或一块空白 —— 这种缺失在编辑器里看不出来。
        if (!this.detailNode || !this.detailTile || !this.detailIcon
            || !this.detailNameLabel || !this.detailDescLabel
            || !this.useBtn || !this.useLabel || !this.sellBtn || !this.sellLabel) {
            ezgame.warn('[背包] 详情面板（item_detail/content/*）有引用没解析出来 —— 未选中态会画不干净');
        }

        // 「扩容」按钮按决策**保持预制件的收起态**（这一轮没有第二档容量，见 docs/bag/README.md §3），
        // 这里只确认它存在 → 免得哪天有人以为它"接丢了"
        if (!at('bottom_bar/btn_expand')) {
            ezgame.warn('[背包] 预制件里找不到扩容按钮（bottom_bar/btn_expand）—— 本轮它本来就该是收起的');
        }
    }

    /**
     * 把 `content` 下已有的格子节点挂上 `BagItem`（**没有改预制件**，与 `View_TaskUI.ensureItems` 同一套路）。
     * ⚠ 只有**一个**子节点（`Bag_Cell` 实例）：它同时是模板与第 1 格，其余 79 格运行时克隆
     *   （多留一个模板会被 GRID Layout 排进网格 —— `audit:bag` 的 F6 专门盯这条）。
     */
    private ensureCells(): void {
        this.items = [];
        this.template = this.contentNode?.children[0] ?? null;
        if (!this.template) {
            ezgame.warn('[背包] 列表容器（scroll/view/content）里没有格子模板（应有一个 Bag_Cell 实例）→ 铺不出格子');
            return;
        }
        this.items.push(this.template.getComponent(BagItem) ?? this.template.addComponent(BagItem));
    }

    onDestroy(): void {
        // 摘节点事件（事件挂在后代节点上，退订一律走 offNodeEvent 兜底 —— 子节点先销毁，见 AGENTS.md）
        this.offNodeEvent(this.backBtn?.node, Button.EventType.CLICK, this.onClickBack, this);
        this.offNodeEvent(this.useBtn?.node, Button.EventType.CLICK, this.onClickUse, this);
        this.offNodeEvent(this.sellBtn?.node, Button.EventType.CLICK, this.onClickSell, this);
        this.items = [];
        this.template = null;
        // `scope` 的那条监听随作用域销毁一起清（`UIScope.dispose` → 事件总线 removeAll）
        super.onDestroy();
    }
}
