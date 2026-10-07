import { _decorator, Button, Color, instantiate, Label, Node, ProgressBar, Sprite } from 'cc';
import { Tabs } from 'db://assets/scripts/platform/ui/Tabs';
import { DataCenter } from '../../../../data';
import type { IOuterDrawPreview } from '../../../../data';
import { getOuterBonusTotals, getOuterRelics } from '../../../../data/configs/EquipmentConfig';
import { OuterRelicDraw } from '../../../../battle/OuterRelicDraw';
import { rarityTier } from '../../../../common/RelicRarityColor';
import { OuterRelicItem } from './OuterRelicItem';
import { OuterAttrItem } from './OuterAttrItem';

const { ccclass, property } = _decorator;

/** 生成出来的行节点名前缀（`clearGenerated` 只清这些，作者摆的 summary / header / empty 不动） */
const ROW_PREFIX = 'row_';

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
 *     │       └── lists       ← `relicList`：**只放克隆出来的行**（Layout V，间距 12，上边距 0）
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
 * ── 为什么用「模板节点 + instantiate」而不是在预制件里摆 N 行 ──
 * 局外遗物有 **37 件**（属性总览最多 16 行），逐行手摆既笨又会在加遗物时忘了补。
 * 模板节点放在 `templates` 下（`active=false`），运行时克隆 —— 行内容仍然在编辑器里看得见、改得动，
 * 而且**不需要新建预制件资产**（省掉一次「等编辑器导入 .meta」）。
 *
 * ── 数据来源（本组件不做任何数值换算）──
 *   · 遗物清单：`getOuterRelics()`（`relics.json` 里 `scope` 含 outer 的 37 件）
 *   · 数量：`DataCenter.ins.equipCollection.getCollectedCount(id)`
 *   · 属性总和：`getOuterBonusTotals()`（内部 = `getAllEquipmentBonuses()` 按属性求和）
 *   · 抽取（**局外遗物的唯一来源**）：`DataCenter.previewOuterDraw / drawOuterRelic`
 *     —— 抽一次花什么、抽不抽得动，**判据全在数据层那一份**，本页只负责把答案画出来
 *
 * 继承 `Tabs`（与左侧菜单的 `Cmp_FuncTabs` 同一套路）：两个子 tab 的切换、选中态、
 * content 显隐全由框架管，本类只做「切了要重刷吗」与「列表怎么铺」。
 */
@ccclass('Cmp_OuterRelics')
export class Cmp_OuterRelics extends Tabs {

    /** 「总览」的列表容器（`pages/overview/scroll/lists`，**只放克隆出来的行**） */
    @property({ type: Node, tooltip: '总览列表容器（pages/overview/scroll/lists，只放克隆出来的行）' })
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

    /** 遗物行的模板节点（`templates/OuterRelicItem`，`active=false`，运行时克隆） */
    @property({ type: Node, tooltip: '遗物行模板（templates/OuterRelicItem）' })
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

    /** 抽完之后消耗行原地改成结果，几秒后还原（与商城 `View_Shop.flashHint` 同一套路） */
    private static readonly HINT_SECONDS = 2;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        // Tabs.onInit 要先把选中态 provide 出去、收集节点并绑点击
        super.onInit();
        // ⚠ 这里**不铺数据**：本页所在节点在运行时是 `active=false` 的（左侧菜单默认选「游戏」），
        // 直到点「遗物」才被激活 —— 那一刻 onLoad→onEnable 连着跑，`onShow` 一定会执行一次。
        // 在 onInit 里再铺一遍就是白铺（37+9 行克隆两次）。
        // 但**节点引用与点击绑定**要在 onInit 做：它们与"显示没显示"无关（绑给按钮，不是绑给列表）。
        this.resolveDrawRefs();
        this.bindDrawControls();
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
     * 总览：所有局外遗物，**按品质从高到低**排（图鉴观感），同档按 id 升序。
     * 已收集的正常显示、未收集的整行置灰（置灰在 `OuterRelicItem.setInfo` 里按数量决定）。
     */
    private rebuildRelics(): void {
        const list = this.relicList;
        if (!list || !this.relicTemplate) return;
        this.clearGenerated(list);

        const relics = getOuterRelics()
            .slice()
            .sort((a, b) => rarityTier(b.rarity) - rarityTier(a.rarity) || a.id - b.id);

        const collection = DataCenter.ins.equipCollection;
        let owned = 0;
        for (const cfg of relics) {
            const count = collection.getCollectedCount(cfg.id);
            if (count > 0) owned++;
            const row = this.spawnRow(this.relicTemplate, list, `${ROW_PREFIX}${cfg.id}`);
            row?.getComponent(OuterRelicItem)?.setInfo(cfg, count, this._freshIds.has(cfg.id));
        }

        // 作者摆的汇总卡（`pages/overview/summary`）：它在 ScrollView 外面，所以永远贴在页面顶部
        this.setProgressSummary(owned, relics.length);
    }

    /**
     * 总览页顶部那张「已收集 N/M」进度卡（作者摆的 `pages/overview/summary`）。
     *
     * 节点契约：`summary` 是**容器**（白卡 `rect_rd_20`），三个子节点 ——
     * `label`（静态前缀「已收集遗物」）/ `bar`（`cc.ProgressBar`，子节点 `Bar` 是青绿填充）/ `value`（数字）。
     * `value` 找不到时退回旧契约（`summary` 自己就是一条 Label），免得预制件与脚本不同步时整页空白。
     *
     * ⚠ 卡片**不在** `list` 里（那样会跟着列表滚走），所以这里**不碰** `list`，
     * 也不动它的 siblingIndex —— 位置由预制件决定。
     */
    private setProgressSummary(owned: number, total: number): void {
        const summary = this.resolveSummary();
        if (!summary) return;
        const label = summary.getComponent(Label) ?? summary.getChildByName('value')?.getComponent(Label);
        if (label) label.string = `${owned} / ${total}`;
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

    /** 克隆模板 → 挂到列表 → 返回（模板缺失/组件缺失时返回 null，不抛） */
    private spawnRow(template: Node, parent: Node, name: string): Node | null {
        const node = instantiate(template);
        if (!node) return null;
        node.name = name;
        node.active = true;
        parent.addChild(node);
        return node;
    }

    /**
     * 清掉上一次生成的行。
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
     * 资源不够时 `DataCenter` 会**部分成功**（抽得动几个抽几个）—— 那不是失败，
     * 只在消耗那行播一下"实际抽到几件"，让玩家自己看得见数量对不对。
     */
    private onDrawClicked(): void {
        const count = this._tenDraw ? OuterRelicDraw.TEN_DRAW_COUNT : 1;
        const res = DataCenter.ins.drawOuterRelic(count);

        if (!res.ok) {
            ezgame.warn(`[遗物图鉴] 抽取没成功：${res.reason}`);
            this.flashCost(res.reason === 'no_resource' ? '券和金币都不够' : '配表未就绪');
            return;
        }

        // 高亮"这次抽到的"（含重复抽到的）：抽完重铺列表时带 `fresh`，
        // 离开这一页就清掉（见 `onShow`）—— 它回答的是"我刚抽到了哪几件"，不是一种持久状态
        this._freshIds = new Set<number>(res.lines.map((l) => l.id));
        this.rebuildAll();
        this.refreshDrawBar();

        const fresh = res.lines.filter((l) => l.isNew).length;
        this.flashCost(`抽到 ${res.drawn} 件${fresh > 0 ? ` · ${fresh} 新` : ''}`);
    }

    /**
     * 刷「抽 取」那一行：消耗文案 + 按钮两态色 + 勾选框两态。
     *
     * 消耗与可点性**只读 `DataCenter.previewOuterDraw`** —— 与真正扣钱走的是同一个 `OuterRelicDraw.plan()`。
     * 券够时那行写「抽取券 N」（券优先于金币），券不够时写混付/纯金币的总价。
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

        if (this.drawCostLabel) this.drawCostLabel.string = vm?.costText ?? '—';
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
     * 消耗那行原地换成结果、`HINT_SECONDS` 秒后还原成"当前该花的钱"（与商城 `View_Shop.flashHint` 同套路）。
     *
     * 还原时**重新算一遍**而不是记下旧值：刚抽完价格可能已经涨了一档（花金币的抽会抬阶梯）。
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
