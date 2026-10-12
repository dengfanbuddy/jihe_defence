import { _decorator, Button, Color, instantiate, Label, Layout, Node, ProgressBar, ScrollView, Sprite } from 'cc';
import { Tabs } from 'db://assets/scripts/platform/ui/Tabs';
import { VirtualList, VirtualListLayout } from 'db://assets/scripts/platform/ui/VirtualList';
import { DataCenter } from '../../../../data';
import type { IOuterDrawPreview } from '../../../../data';
import { getOuterBonusTotals, getOuterRelics } from '../../../../data/configs/EquipmentConfig';
import { OuterRelicDraw } from '../../../../battle/OuterRelicDraw';
import { rarityTier } from '../../../../common/RelicRarityColor';
import type { RelicCfg } from '../../../../excel_table/Tb_RelicConfig';
import { OuterRelicItem } from './OuterRelicItem';
import { OuterAttrItem } from './OuterAttrItem';
import { OuterDrawScopeEvents } from './OuterDrawScope';

const { ccclass, property } = _decorator;

/** 生成出来的行节点名前缀（`clearGenerated` 只清这些，作者摆的 summary / header / empty 不动） */
const ROW_PREFIX = 'row_';

/* ── 总览列表的几何 ──
 * 总览那一列现在由 `VirtualList` 摆位置，**不再读预制件里那个 `cc.Layout`**（它被关掉了，见
 * `ensureRelicVirtualList`），所以这两个数得由代码给。值是从预制件
 * `pages/overview/scroll/lists` 上那个 Layout 现读抄下来的（`_spacingY = 12` / `_paddingBottom = 16`）——
 * 版式再改时两边要一起动，否则"列表比改之前高一点/矮一点"这种偏差没人看得出来。
 * 横向那 16px 内边距不用单独给：格子 514 宽、`content` 546 宽，虚拟列表默认居中摆 = 左右各 16，与原来一致。
 */
/** 行间距 */
const RELIC_ROW_SPACING = 12;
/** 列表底部留白（滚到底时最后一行与裁切线之间的那一档） */
const RELIC_LIST_PADDING_BOTTOM = 16;

/**
 * 总览列表的一行 = 一件遗物 + 它的收集份数。
 *
 * 份数在**重铺时快照一次**（不放进渲染回调里现查）：排序判据（有没有收集过）与格子上画的数量
 * 必须来自同一时刻的同一份数据，否则"排在上面但写着未获得"这种事迟早会出现。
 */
interface RelicRow {
    cfg: RelicCfg;
    count: number;
}

/* ── 抽取那一行的节点契约（`pages/overview` 下，与进度卡同一行）──
 * 三个节点都是**按名字解析**的（`@property` 拖了就用拖的，没拖就按下面的名字找）：
 *   `draw_btn`（抽取按钮，带 Button）→ 子节点 `cost`（消耗那行字）
 *   `ten_box`（十连勾选框，带 Button）→ 子节点 `box`（方框）→ 子节点 `check`（勾），以及 `name`（文字）
 */
const DRAW_BUTTON_NAME = 'draw_btn';
const COST_LABEL_NAME = 'cost';
const TEN_TOGGLE_NAME = 'ten_box';
const TEN_BOX_NAME = 'box';
const TEN_CHECK_NAME = 'check';
const TEN_TEXT_NAME = 'name';

/** 抽取按钮的底色：可点 = `c-accent-action`（全工程「这里能点」的青绿）；不可点 = `c-disabled-pill` */
const DRAW_ON_COLOR = '#3F9E9B';
const DRAW_OFF_COLOR = '#B9C1C1';
/**
 * 消耗那行字的**两态色**（都在 `tokens.json` 里，见 `docs/art-style/tokens.json`）：
 *   · 常态 = `c-text-on-dark` `#FFFFFF`（青绿按钮底上的白字，与预制件里那个原色一致）
 *   · **券和金币都不够** = `c-warn` `#FF0000` —— 那时那行金币价的意思是"还差这么多"，
 *     不是"点一下扣这么多"；按钮同时已经置灰（`DRAW_OFF_COLOR`）。
 * ⚠ 这两行是**运行期写**的色，`npm run audit:ui` 只扫预制件上序列化的值、扫不到它们，
 *   所以 `audit:draw` 的 G32 会拿它们逐条对 `tokens.json`。
 */
const COST_ENOUGH_COLOR = '#FFFFFF';
const COST_LACK_COLOR = '#FF0000';
/** 十连勾选框的两态色：方框 `c-ink-200` → `c-accent-action`，文字 `c-ink-600` → `c-ink-900` */
const TEN_BOX_ON_COLOR = '#3F9E9B';
const TEN_BOX_OFF_COLOR = '#D8D8D8';
const TEN_TEXT_ON_COLOR = '#445054';
const TEN_TEXT_OFF_COLOR = '#6A696B';

/**
 * `Scene_Menu` → 「遗物」页（`content/right/outer_relics`）的页面控制器
 *
 * ── 页面结构（编辑器里的节点契约，2026-11 版式重做后）──
 * ```
 * outer_relics                ← 本组件挂这里（同时是 Tabs 宿主：tab 与 content 的共同祖先），546×1162
 * ├── tabs                    ← tabBarNode：tab_overview / tab_attr（258×60 格，选中 = 深板岩药丸 + 白字）
 * └── pages                   ← contentBarNode：overview / attrs（顺序与 tab 一一对应）
 *     ├── overview            纯容器（546×1090，没有组件：把「固定卡」与「滚动区」分开）
 *     │   ├── summary         总览进度卡（白卡 250×72）：label / bar(ProgressBar) / value
 *     │   │                   ⚠ **在 ScrollView 之外**，所以往下翻遗物时它一直贴顶（`relicSummary`）
 *     │   ├── ten_box         十连勾选框（78×72）：box(方框) → check(勾) + name(「十连抽」)
 *     │   ├── draw_btn        抽 取（170×72，青绿底）：title(「抽 取」) + cost(消耗文案)
 *     │   └── scroll          ScrollView（顶部内缩 100 = 72 卡 + 16 上留白 + 12 间距），546×990
 *     │       └── lists       ← `relicList`，虚拟列表的 content：只放「可视格 + 池里的格」
 *     └── attrs               ScrollView（属性总览）→ lists（Layout V，间距 10）
 *         ├── summary         说明行（514×20）
 *         ├── header          表头（514×32，三列与数据行同 x）
 *         └── empty           空态提示（514×40，有数据时 active=false）
 * templates                   active=false 的两个模板节点（不进列表，只当克隆源）
 * ```
 *
 * 行模板（改版后）：`OuterRelicItem` 514×92 = 品质描边卡 + 64 图标框 + 名字 20 + 描述 16 + 数量；
 * `OuterAttrItem` 514×56 = 白卡 + 三列（属性 / 固定加成 / 百分比加成），三列 x 与表头行共用一套口径。
 *
 * ⚠ **总览那张进度卡为什么不在 `lists` 里**：放在 `lists` 里就是列表的第一行，往下翻会跟着滚走。
 * 现在它是 ScrollView 的**兄弟节点**（`pages/overview/summary`），只有 `lists` 会被 ScrollView 移动，
 * 卡片天然定在顶部；`scroll` 顶部让出 100px（72+16+12）正好是卡片 + 一档行间距，
 * 列表滚到顶时第一行落在**卡片下方 12px**、继续下滚则从卡片下沿被 Mask 裁掉（不会从卡片边上漏出来）。
 *
 * ── 总览列表为什么用 `VirtualList`（而不是「模板 + instantiate」铺满）──
 * 局外遗物池 **2026-11 从 37 件扩到 268 件**（`relics.json` 268 行、`scope` 全是 `both`），
 * 逐件 `instantiate` 就是 268 个行节点一次性进场景 —— 那是「打开这一页卡一下」的直接来源，
 * 而且 99% 的行在屏幕外，白建。现在改成 `platform/ui/VirtualList`（挂在 `scroll` 上、
 * `content` = `lists`）：节点数从 `O(268)` 降到「可视格 + 缓冲格」这十几二十个，
 * 滚出去的行还回对象池、滚进来的复用。
 *
 * ⚠ **虚拟化接管了摆放，`lists` 上原来那个 `cc.Layout` 必须让位**：它下一帧会按自己的规则再摆一遍
 * （表现是格子乱跳/挤成一坨）。所以 `ensureRelicVirtualList` 在运行期把它 `enabled = false` ——
 * **预制件 JSON 一个字没动**（虚拟列表的文件头明确支持"`addComponent` 后手动赋值"这条用法）。
 *
 * ── 「属性总览」为什么还是「模板节点 + instantiate」──
 * 那一页的行数**不随数据增长**（最多 16 个属性 = 16 行），虚拟化对它没有收益；
 * 逐行手摆又笨又会在加属性时忘了补，所以保留原来的克隆套路（`spawnRow` / `clearGenerated`），
 * 模板节点放在 `templates` 下（`active=false`），不需要新建预制件资产。
 *
 * ── 数据来源（本组件不做任何数值换算）──
 *   · 遗物清单：`getOuterRelics()`（`relics.json` 里 `scope` 含 outer 的 268 件）
 *   · 数量：`DataCenter.ins.equipCollection.getCollectedCount(id)`
 *   · 属性总和：`getOuterBonusTotals()`（内部 = `getAllEquipmentBonuses()` 按属性求和）
 *   · 抽取（**局外遗物的唯一来源**）：`DataCenter.previewOuterDraw / drawOuterRelic`
 *     —— 抽一次花什么、抽不抽得动、那行字红不红，**判据全在数据层那一份**，本页只负责把答案画出来
 *   · 抽到的每一件：**不在这一行显示**（那行只回答"下一抽多少钱"），改为 `scope.emit(ShowResult, lines)`
 *     冒泡给宿主 `Scene_Menu` → 弹 `ui_draw_result`（`Cmp_OuterDrawResult`，一件一张卡 + 小动画）
 *
 * 继承 `Tabs`（与左侧菜单的 `Cmp_FuncTabs` 同一套路）：两个子 tab 的切换、选中态、
 * content 显隐全由框架管，本类只做「切了要重刷吗」与「列表怎么铺」。
 */
@ccclass('Cmp_OuterRelics')
export class Cmp_OuterRelics extends Tabs {

    /** 「总览」的列表容器（`pages/overview/scroll/lists`）：虚拟列表的 `content`，只放可视格 + 池里的格 */
    @property({ type: Node, tooltip: '总览列表容器（pages/overview/scroll/lists，虚拟列表的 content）' })
    relicList: Node = null;

    /**
     * 「总览」顶部**固定不动**的进度卡（`pages/overview/summary`）。
     * 它在 ScrollView **外面**（是 `scroll` 的兄弟节点），所以列表滚动时它一直贴顶。
     * 留空也能跑：`resolveSummary()` 会按节点契约的路径回退着找。
     */
    @property({ type: Node, tooltip: '总览顶部固定进度卡（pages/overview/summary，不随列表滚动）' })
    relicSummary: Node = null;

    /** 「抽 取」按钮（`pages/overview/draw_btn`，节点上带 `cc.Button`）。留空按名字兜底解析。 */
    @property({ type: Node, tooltip: '抽取按钮（pages/overview/draw_btn，带 Button）' })
    drawButton: Node = null;

    /** 十连勾选框（`pages/overview/ten_box`，节点上带 `cc.Button`）。留空按名字兜底解析。 */
    @property({ type: Node, tooltip: '十连勾选框（pages/overview/ten_box，带 Button）' })
    tenToggle: Node = null;

    /** 抽取按钮上那行**消耗**文案（`pages/overview/draw_btn/cost`）。留空按名字兜底解析。 */
    @property({ type: Label, tooltip: '消耗文案（pages/overview/draw_btn/cost）' })
    drawCostLabel: Label = null;

    /** 「属性总览」的列表容器（`pages/attrs/lists`） */
    @property({ type: Node, tooltip: '属性总览列表容器（pages/attrs/lists）' })
    attrList: Node = null;

    /** 遗物行的模板节点（`templates/OuterRelicItem`，`active=false`）—— 现在是**虚拟列表的克隆源** */
    @property({ type: Node, tooltip: '遗物行模板（templates/OuterRelicItem，虚拟列表的克隆源）' })
    relicTemplate: Node = null;

    /** 属性行的模板节点（`templates/OuterAttrItem`，`active=false`，运行时克隆） */
    @property({ type: Node, tooltip: '属性行模板（templates/OuterAttrItem）' })
    attrTemplate: Node = null;

    /** 选中态的文字色（与左侧菜单同一套口径） */
    private readonly selectFontColor = new Color('#FFFFFF');
    /** 未选中态的文字色（`c-ink-900`，与页签条的墨色口径一致） */
    private readonly unselectFontColor = new Color('#445054');

    /** 「十连抽」勾选框的当前状态（**不落盘**：它是一次操作的选择，不是玩家的存档数据） */
    private _tenDraw = false;
    /** 本次抽到的遗物 id（重铺列表时高亮它们）—— 只活到离开这一页，见 `OuterRelicItem.setInfo` 的 `fresh` */
    private _freshIds: Set<number> = new Set<number>();
    /** 消耗文案被临时改成结果时，用来判"该还原的是不是我这一个定时器"（连点两次只还原一次） */
    private _costHintSeq = 0;
    /** 抽取/勾选框的点击绑定（节点事件不像 scope 事件那样自动回收，`onDispose` 要成对摘掉）
     *  ⚠ 名字必须与基类 `Tabs._clickBindings`（private）区分开：同名会 TS2415「分别声明了同一个私有属性」 */
    private _drawClickBindings: { node: Node, type: string, handler: () => void }[] = [];

    /**
     * 总览列表的虚拟化容器 —— **运行期 `addComponent` 出来的**（预制件里没有这个组件，见 `ensureRelicVirtualList`）。
     * 挂在 `pages/overview/scroll` 上（与 `ScrollView` 同一个节点：视口按那个节点的尺寸算）。
     */
    private _vlist: VirtualList = null;

    /**
     * 总览列表**当前这一份**排好序的数据。
     * 渲染回调按 `index` 从这里取 —— 格子是对象池里复用的，`index` 是**数据下标**，
     * 池子把哪个节点交给哪一行都不影响"第 N 格画第 N 条"，所以这份数组必须由重铺那一处写好。
     */
    private _relicRows: RelicRow[] = [];

    /** 抽完之后那行提示的存活秒数（现只用于失败提示，见 `flashCost`） */
    private static readonly HINT_SECONDS = 2;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        // Tabs.onInit 要先把选中态 provide 出去、收集节点并绑点击
        super.onInit();
        // ⚠ 这里**不铺数据**：本页所在节点在运行时是 `active=false` 的（左侧菜单默认选「游戏」），
        // 直到点「遗物」才被激活 —— 那一刻 onLoad→onEnable 连着跑，`onShow` 一定会执行一次。
        // 在 onInit 里再铺一遍就是白铺（268 件遗物铺两次）。
        // 但**节点引用、点击绑定与虚拟列表本体**要在 onInit 做：它们与"显示没显示"无关
        //（虚拟列表只是把 `scroll` 的结构认下来，条数由 `onShow` 给）。
        this.resolveDrawRefs();
        this.bindDrawControls();
        this.ensureRelicVirtualList();
    }

    protected onShow(): void {
        super.onShow();
        // 每次显示都重建：数量是外部数据（`equipCollection` 随时会变），
        // 它不是响应式字段，watch 不到 —— 与 `HeroSelectPanel.checkHeroList` 同一个理由。
        // 顺带清掉上一次的"刚抽到"高亮：它只该活到离开这一页。
        this._freshIds.clear();
        this.rebuildAll();
        this.refreshDrawBar();
    }

    protected onDispose(): void {
        for (const binding of this._drawClickBindings) {
            // ⚠ 必须用 `offNodeEvent` 而不是 `node.off`：子节点此刻可能已经被 `_destruct` 过
            this.offNodeEvent(binding.node, binding.type, binding.handler, this);
        }
        this._drawClickBindings.length = 0;
        this._freshIds.clear();
    }

    /**
     * 选中态表现：**与左侧菜单 `Cmp_FuncTabs` 完全同口径**（`active_bg` 显隐 + `name` 换色），
     * 这样页面内外的 tab 长得一样。框架默认实现是转发给 `TabItem`，本页的 tab 没挂它。
     */
    protected applyTabSelected(tab: Node, _index: number, selected: boolean): void {
        const bg = tab.getChildByName('active_bg');
        if (bg) bg.active = selected;
        const label = tab.getChildByName('name')?.getComponent(Label);
        if (label) label.color = selected ? this.selectFontColor.clone() : this.unselectFontColor.clone();
    }

    /* ==================== 铺列表 ==================== */

    private rebuildAll(): void {
        // 数据层没加载好（TbRoot 未就绪）时**不要**把异常抛到 onLoad 里 —— 那会连带弄坏整个 Scene_Menu；
        // 退化成空页，等下次 onShow 再试。
        try {
            this.rebuildRelics();
            this.rebuildAttrs();
        } catch (err) {
            ezgame.error('[遗物图鉴] 铺列表出错（页面留空，下次显示会重试）', err);
        }
    }

    /**
     * 总览：所有局外遗物（现 268 件），排好序交给虚拟列表。
     *
     * 排序口径（用户定的，逐条都在下面这一句里）：
     *   ① **已获得的在最上面**（图鉴的第一眼要看"我有什么"）
     *   ② 同一组内**品质降序**（legendary → epic → rare → common），权重取 `rarityTier()`
     *      —— 全工程只有那一张品质表，这里**不许再抄一份**
     *   ③ 同品质内**id 降序**
     *
     * 已收集的正常显示、未收集的整行置灰（置灰在 `OuterRelicItem.setInfo` 里按数量决定）。
     */
    private rebuildRelics(): void {
        const vlist = this.ensureRelicVirtualList();
        if (!vlist) return;

        // 份数在这里**快照一次**：排序判据（有没有收集过）与格子上画的数量必须是同一时刻的数据，
        // 也让渲染回调不必每次回数据层查一遍（滚动时每格都会被重画）
        const collection = DataCenter.ins.equipCollection;
        const rows: RelicRow[] = getOuterRelics()
            .map((cfg) => ({ cfg, count: collection.getCollectedCount(cfg.id) }));
        rows.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0)
            || rarityTier(b.cfg.rarity) - rarityTier(a.cfg.rarity)
            || b.cfg.id - a.cfg.id);

        this._relicRows = rows;
        let owned = 0;
        for (const row of rows) {
            if (row.count > 0) owned++;
        }

        // 条数写进去它就会重建行表并铺格（同一份 268 条再写一次不会白干活）
        vlist.numItems = rows.length;
        // ⚠ 这一句**不能省**：抽完重铺时条数没变（268 → 268），`numItems` 的 setter 见值相同直接 return，
        //    新份数/新加的"刚抽到"高亮就永远画不出来 —— 虚拟列表只重画活着的格子，而格子是复用的。
        vlist.refreshAll();

        // 作者摆的汇总卡（`pages/overview/summary`）：它在 ScrollView 外面，所以永远贴在页面顶部
        this.setProgressSummary(owned, rows.length);
    }

    /**
     * 建（或复用）总览列表的虚拟列表。
     *
     * ── 为什么是**运行期 addComponent** 而不是拖在预制件上 ──
     * 这一处改造**不许动预制件 JSON**（手改扁平数组 + `__id__` 互引的资产风险太高），
     * 而虚拟列表的文件头明确支持"`addComponent` 后手动赋值"这条用法（引用解析推迟到第一次 `update`）。
     * 赋值顺序无所谓，这里按"先引用、后参数、最后回调"写。
     *
     * ── 结构对不上时**退化**而不是抛异常 ──
     * 与 `rebuildAll` 里那条 try/catch 同一个理由：本页的 onLoad 抛异常会连带弄坏整个 `Scene_Menu`。
     * 认不出结构就打一条 warn 并让列表留空（属性总览那一页照常）。
     *
     * @returns 虚拟列表实例；结构不齐时返回 null（调用方静默跳过铺列表）
     */
    private ensureRelicVirtualList(): VirtualList {
        if (this._vlist?.isValid) return this._vlist;

        // ① 宿主节点 = `lists` 的父节点 `scroll`：ScrollView 与 VirtualList **必须同挂一个节点**
        //    （视口 = ScrollView 所在节点的尺寸；这是虚拟列表文件头「用法」里的硬口径，
        //     挂到 `outer_relics` 上会把 1162 高的整页当成视口，缓冲多铺一大截）
        const content = this.relicList;
        const host = content?.parent;
        const scrollView = host?.getComponent(ScrollView);
        if (!content || !host || !scrollView || !this.relicTemplate) {
            ezgame.warn('[遗物图鉴] 总览列表的节点结构对不上（缺 `scroll`/ScrollView/行模板）→ 本页列表留空');
            return null;
        }

        // ② 判空后再建：同一节点上重复 `addComponent` 会挂出第二个实例，
        //    两个实例各算一套可见区间、各自摆位置 → 格子抖/重影（而且不会报错）
        const vlist = host.getComponent(VirtualList) ?? host.addComponent(VirtualList);
        vlist.scrollView = scrollView;
        vlist.contentNode = content;
        // 模板在 `templates/` 下（**在 `content` 之外**）：虚拟列表支持外部模板，
        // 它会把这个节点置 `active=false` 只当克隆源，克隆体挂进 `content`
        vlist.templateNode = this.relicTemplate;
        vlist.layout = VirtualListLayout.Vertical;
        vlist.spacingMain = RELIC_ROW_SPACING;
        vlist.paddingMainEnd = RELIC_LIST_PADDING_BOTTOM;
        vlist.setItemRenderer(this, (index, node) => this.renderRelicRow(index, node));

        // ③ ⚠ `content` 上不许有启用中的 `Layout`：虚拟化自己 `setPosition`，Layout 下一帧又按自己的规则
        //    摆一遍（现象是"格子乱跳/挤成一坨"）。预制件里那个 Layout 是**启用**的，而它的两件职责
        //    （内容高度 + 摆位置）现在都归虚拟列表，所以在这里关掉它 —— 只改运行期状态，预制件不动。
        const layout = content.getComponent(Layout);
        if (layout) layout.enabled = false;

        this._vlist = vlist;
        return vlist;
    }

    /**
     * 把第 `index` 行画到格子上 —— 虚拟列表**唯一**的数据出口。
     *
     * ⚠ 两条口径：
     *   ① 数据一律从 `_relicRows`（当前这一份排序结果）取，**不在回调里现查库、也不缓存节点** ——
     *      格子是对象池里复用的，`index` 是**数据下标**，池子把它交给哪一行都得画对；
     *   ② **整格重画**（`OuterRelicItem.setInfo` 本来就把名字/描述/标签/数量/描边/置灰全写一遍），
     *      这正是复用安全的前提 —— 只写"变了的那一项"必然串格。
     */
    private renderRelicRow(index: number, node: Node): void {
        const row = this._relicRows[index];
        if (!row) return;
        node.getComponent(OuterRelicItem)?.setInfo(row.cfg, row.count, this._freshIds.has(row.cfg.id));
    }

    /**
     * 总览页顶部那张进度卡（作者摆的 `pages/overview/summary`）。
     *
     * 节点契约：`summary` 是**容器**（白卡 `rect_rd_20`），三个子节点 ——
     * `label`（静态前缀「已收集遗物」）/ `bar`（`cc.ProgressBar`，子节点 `Bar` 是青绿填充）/ `value`（数字）。
     * `value` 找不到时退回旧契约（`summary` 自己就是一条 Label），免得预制件与脚本不同步时整页空白。
     *
     * ⚠ `value` 只写**已收集的件数**（用户口径 2026-11：不要分母）——
     *   分母由进度条自己表达（`progress` 仍是"已收集件数 ÷ 池子件数"），数字那行留给"我收了多少件"。
     *
     * ⚠ 卡片**不在** `list` 里（那样会跟着列表滚走），所以这里**不碰** `list`，
     * 也不动它的 siblingIndex —— 位置由预制件决定。
     */
    private setProgressSummary(owned: number, total: number): void {
        const summary = this.resolveSummary();
        if (!summary) return;
        const label = summary.getComponent(Label) ?? summary.getChildByName('value')?.getComponent(Label);
        if (label) label.string = `${owned}`;
        const bar = summary.getChildByName('bar')?.getComponent(ProgressBar);
        if (bar) bar.progress = total > 0 ? owned / total : 0;
    }

    /**
     * 找那张固定进度卡：**先认编辑器里拖的引用**（改节点名也不怕），
     * 再按节点契约的路径找（`pages/overview/summary`），最后退回旧契约（卡片还在 `lists` 里的老预制件）。
     * 三条都落空就返回 null（`setProgressSummary` 静默跳过，不会把异常抛进 `onLoad`）。
     */
    private resolveSummary(): Node {
        return this.relicSummary
            ?? this.node.getChildByName('pages')?.getChildByName('overview')?.getChildByName('summary')
            ?? this.relicList?.getChildByName('summary')
            ?? null;
    }

    /** 属性总览：所有遗物属性加成的**总和**，每种属性一行；一条都没有时显示空态提示 */
    private rebuildAttrs(): void {
        const list = this.attrList;
        if (!list || !this.attrTemplate) return;
        this.clearGenerated(list);

        const rows = getOuterBonusTotals();
        for (const row of rows) {
            const node = this.spawnRow(this.attrTemplate, list, `${ROW_PREFIX}attr_${row.attrId}`);
            node?.getComponent(OuterAttrItem)?.setInfo(row);
        }

        const relics = getOuterRelics();
        const collection = DataCenter.ins.equipCollection;
        const owned = relics.filter((r) => collection.getCollectedCount(r.id) > 0).length;

        // 说明行（作者摆的 `lists/summary`）：把「这是**已收集**的总和」写清楚，
        // 免得被读成「所有遗物（含未获得）的总和」—— 那是两个完全不同的数
        const summary = list.getChildByName('summary');
        if (summary) {
            const label = summary.getComponent(Label);
            if (label) label.string = `已收集 ${owned}/${relics.length} 件 —— 下面是它们的加成总和`;
            summary.setSiblingIndex(0);
        }
        // 表头：用同一个模板写死三个格子名（作者摆的 `lists/header`）
        const header = list.getChildByName('header');
        if (header) {
            header.getComponent(OuterAttrItem)?.setHeader('属性', '固定加成', '百分比加成');
            header.setSiblingIndex(1);
        }
        // 空态提示（作者摆的 `lists/empty`）
        const empty = list.getChildByName('empty');
        if (empty) empty.active = rows.length === 0;
    }

    /**
     * 克隆模板 → 挂到列表 → 返回（模板缺失/组件缺失时返回 null，不抛）。
     * **只服务「属性总览」那一列**（总览列已虚拟化，格子由 `VirtualList` 自己的对象池造）。
     */
    private spawnRow(template: Node, parent: Node, name: string): Node | null {
        const node = instantiate(template);
        if (!node) return null;
        node.name = name;
        node.active = true;
        parent.addChild(node);
        return node;
    }

    /**
     * 清掉上一次生成的行（**只服务「属性总览」那一列**）。
     *
     * ⚠ 两条都必须做对：
     *   ① **只清 `ROW_PREFIX` 开头的** —— `summary` / `header` / `empty` 是作者摆在预制件里的，
     *      被清掉就再也回不来了（它们不是克隆出来的）；
     *   ② **先 `removeFromParent()` 再 `destroy()`** —— `destroy()` 是**延迟到帧末**执行的，
     *      只调 `destroy()` 的话这一帧内 `list.children` 里新旧行**同时存在**，
     *      `Layout` 会按多出一倍的行算高度、画出重叠的列表（实测过：父节点重复出现两批行）。
     *      `removeFromParent()` 是立即生效的，调完 `children` 就干净了。
     */
    private clearGenerated(list: Node): void {
        for (const child of [...list.children]) {
            if (!child.name.startsWith(ROW_PREFIX)) continue;
            child.removeFromParent();
            child.destroy();
        }
    }

    /* ===================================================================
     * 抽取（**局外遗物的唯一来源**）
     *
     * 本页只做三件事：① 把消耗/能不能点画出来；② 把点击转给 `DataCenter`；③ 把结果铺回界面。
     * 价格阶梯、券的优先级、池子与品质权重**全在数据层**（`OuterRelicDraw` + `DataCenter`），
     * 这里一行都不许自己算 —— 否则迟早出现"按钮写着 200、实际扣 300"。
     * =================================================================== */

    /** 解析三个抽取相关的节点引用（编辑器拖的优先，没拖就按节点名找；都找不到就退化成"没有抽取入口"） */
    private resolveDrawRefs(): void {
        const overview = this.node.getChildByName('pages')?.getChildByName('overview');
        if (!this.drawButton) this.drawButton = overview?.getChildByName(DRAW_BUTTON_NAME) ?? null;
        if (!this.tenToggle) this.tenToggle = overview?.getChildByName(TEN_TOGGLE_NAME) ?? null;
        if (!this.drawCostLabel) {
            this.drawCostLabel = this.drawButton?.getChildByName(COST_LABEL_NAME)?.getComponent(Label) ?? null;
        }
        if (!this.drawButton) {
            ezgame.warn('[遗物图鉴] 没找到抽取按钮（`pages/overview/draw_btn`）→ 本页没有抽取入口');
        }
    }

    /** 绑「抽 取」与「十连抽」两个点击（有 Button 就听 Button 的 CLICK，否则退回节点触摸） */
    private bindDrawControls(): void {
        this.bindClick(this.drawButton, () => this.onDrawClicked());
        this.bindClick(this.tenToggle, () => this.onTenToggleClicked());
    }

    private bindClick(node: Node, handler: () => void): void {
        if (!node) return;
        const button = node.getComponent(Button);
        const type = button ? Button.EventType.CLICK : Node.EventType.TOUCH_END;
        node.on(type, handler, this);
        this._drawClickBindings.push({ node, type, handler });
    }

    /** 勾/取消「十连抽」（本页状态，不落盘）—— 勾上之后消耗那行会立刻改成十连的总价 */
    private onTenToggleClicked(): void {
        this._tenDraw = !this._tenDraw;
        this.refreshDrawBar();
    }

    /**
     * 点「抽 取」：转给 `DataCenter.drawOuterRelic`（1 抽 / 勾了十连就 10 抽），再把结果铺回来。
     *
     * 抽到之后做三件事，**顺序不能换**：
     *   ① 记下"这次抽到的"并重铺图鉴（列表里那几件的描边会转成青绿，离开这一页才清）；
     *   ② **立刻**刷「抽 取」那一行 —— 花金币的抽会抬当日价格阶梯，所以刷出来的就是
     *      **下一次抽取要花的钱**（`previewOuterDraw` 与真正扣钱同源，见 `refreshDrawBar`）；
     *   ③ 把这一批结果 `emit` 给宿主（`Scene_Menu`）弹出「获得遗物」面板。
     *
     * ⚠ **消耗那行不再播"抽到 N 件"**（用户口径 2026-11）：那行是"这一下要花什么"的唯一落点，
     *   被结果文案盖住 2 秒，玩家最想看的"下一抽多少钱"就看不见了。数量改由结果面板
     *   一件一张卡表达（重复的件另写 `×N`），这里只负责把按钮恢复成"下一步的价"。
     *
     * 资源不够时 `DataCenter` 会**部分成功**（抽得动几个抽几个）—— 那不是失败，
     * 面板照常弹，画出来的就是真抽到的那几件（`drawn < requested` 一眼可见）。
     */
    private onDrawClicked(): void {
        const count = this._tenDraw ? OuterRelicDraw.TEN_DRAW_COUNT : 1;
        const res = DataCenter.ins.drawOuterRelic(count);

        if (!res.ok) {
            ezgame.warn(`[遗物图鉴] 抽取没成功：${res.reason}`);
            // 失败提示**不弹面板**、也不改数据：只在消耗那行原地报一句（几秒后还原成当前该花的钱）
            this.flashCost(res.reason === 'no_resource' ? '券和金币都不够' : '配表未就绪');
            return;
        }

        // 高亮"这次抽到的"（含重复抽到的）：抽完重铺列表时带 `fresh`，
        // 离开这一页就清掉（见 `onShow`）—— 它回答的是"我刚抽到了哪几件"，不是一种持久状态
        this._freshIds = new Set<number>(res.lines.map((l) => l.id));
        this.rebuildAll();
        // ⚠ 这一行必须紧跟在扣账之后：抽完价格可能已经涨了一档，玩家看到的必须是**下一抽的价**
        this.refreshDrawBar();

        // 结果面板由宿主（`Scene_Menu`）持有 —— 它是根节点的子节点，本页只负责把结果冒泡上去
        this.scope.emit(OuterDrawScopeEvents.ShowResult, res.lines);
    }

    /**
     * 刷「抽 取」那一行：消耗文案 + 那行字的**两态色** + 按钮两态色 + 勾选框两态。
     *
     * 消耗与可点性**只读 `DataCenter.previewOuterDraw`** —— 与真正扣钱走的是同一个 `OuterRelicDraw.plan()`。
     *
     * 那行字的三态（用户口径 2026-11，**文案与颜色都出自数据层**，这里一行都不许自己算）：
     *   · 券够 → 「抽取券 N」（券优先于金币，所以有券时它一定出现在这行里）
     *   · 券不够、金币够 → 「金币 M」/ 混付「券N 金币M」
     *   · **都不够** → 仍然写**金币全价**，但画成**红字**（`costLack`）= "还差这么多"；
     *     按钮同时置灰（`DRAW_OFF_COLOR`），点一下仍会给一句失败提示（见 `flashCost`）
     */
    private refreshDrawBar(): void {
        const count = this._tenDraw ? OuterRelicDraw.TEN_DRAW_COUNT : 1;
        let vm: IOuterDrawPreview = null;
        try {
            vm = DataCenter.ins.previewOuterDraw(count);
        } catch (err) {
            // 配表未就绪（TbRoot 还没加载完）→ 不把异常带进 onLoad，按钮显示"—"并置灰
            ezgame.error('[遗物图鉴] 抽取预览算不出来（配表未就绪？）', err);
        }

        if (this.drawCostLabel) {
            this.drawCostLabel.string = vm?.costText ?? '—';
            // 红的语义是"这就是你要攒的钱"，所以**只有 `costLack` 才红**：
            // `vm` 为 null（配表未就绪）时那行是 `—`，按常态白字画，别把"算不出来"演成"钱不够"。
            this.drawCostLabel.color = new Color(vm?.costLack ? COST_LACK_COLOR : COST_ENOUGH_COLOR);
        }
        const sprite = this.drawButton?.getComponent(Sprite);
        if (sprite) sprite.color = new Color(vm?.enabled ? DRAW_ON_COLOR : DRAW_OFF_COLOR);

        const box = this.tenToggle?.getChildByName(TEN_BOX_NAME);
        const boxSprite = box?.getComponent(Sprite);
        if (boxSprite) boxSprite.color = new Color(this._tenDraw ? TEN_BOX_ON_COLOR : TEN_BOX_OFF_COLOR);
        const check = box?.getChildByName(TEN_CHECK_NAME);
        if (check) check.active = this._tenDraw;
        const text = this.tenToggle?.getChildByName(TEN_TEXT_NAME)?.getComponent(Label);
        if (text) text.color = new Color(this._tenDraw ? TEN_TEXT_ON_COLOR : TEN_TEXT_OFF_COLOR);
    }

    /**
     * 把消耗那行**临时**换成一句提示（现只用于**抽取失败**：「券和金币都不够」/「配表未就绪」），
     * `HINT_SECONDS` 秒后还原成"当前该花的钱"（与商城 `View_Shop.flashHint` 同套路）。
     *
     * ⚠ **成功路径不许走这里**（用户口径 2026-11）：抽完之后那行要显示的是**下一抽的价**，
     *   这只有 `refreshDrawBar()` 能算（花金币的抽会抬当日阶梯），临时文案会把真价盖住。
     *
     * 还原时**重新算一遍**而不是记下旧值（配表/金币一变旧值就是假的）。
     * 连点两次时只有最后一次负责还原（`_costHintSeq`），否则前一个定时器会把新提示擦掉。
     */
    private flashCost(text: string): void {
        if (!text) return;
        const label = this.drawCostLabel;
        if (!label || !label.isValid) {
            ezgame.warn(`[遗物图鉴] ${text}`);
            return;
        }

        label.string = text;
        const seq = ++this._costHintSeq;
        this.scheduleOnce(() => {
            if (seq !== this._costHintSeq) return;
            this.refreshDrawBar();
        }, Cmp_OuterRelics.HINT_SECONDS);
    }
}
