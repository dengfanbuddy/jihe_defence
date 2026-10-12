/**
 * VirtualList —— **槽位式虚拟列表**（长列表只画看得见的那几格）
 *
 * ── 一句话 ──
 * 挂在**已有的 `ScrollView` 节点**上，接管它 `content` 里那一格模板：滚动时按可见区间
 * **从对象池取节点 / 归还节点**，`content` 里始终只有「可视格 + 缓冲格」这么多节点，
 * 1000 条数据也只创建十几二十个。
 *
 * ── 为什么不自己实现滚动（重要）──
 * 滚动的手感（拖动跟手、惯性衰减、边缘回弹、`scrollTo` 动画）全部**继续由引擎的
 * `cc.ScrollView` 提供**，本组件**不接管触摸、不写惯性**，只做两件事：
 *   ① 算 `content` 该多大（否则 ScrollView 没有滚动行程）；
 *   ② 算「现在哪几格落在视口里」，把它们摆到正确的位置、把跑出去的还回池里。
 * 这条路线的代价是「你必须有一个正常工作的 ScrollView 结构」，收益是**不用重写惯性**，
 * 且能直接改造工程里已有的列表预制件（难度弹窗 / 图鉴 / 背包都是这个结构）。
 *
 * ── 它怎么知道滚动到哪了（零分配的判据）──
 * 每帧读 `content.position`（一个**活的** `Vec3`，不产生垃圾）与上一帧比对，变了才算可见区间。
 * 当前滚动量 =
 * ```
 * scrollTop  = [content.position.y + (1 - contentAnchorY) * contentHeight]
 *            - [(1 - viewAnchorY) * viewHeight]
 * ```
 * 这与引擎 `ScrollView.getScrollOffset().y` **完全等价**（引擎源码
 * `cocos/ui/scroll-view.ts:696` 的 `_getContentTopBoundary() - _topBoundary`，
 * 其中 `_getContentTopBoundary()` 见 `:1335-1341`、`_topBoundary` 见 `:1148-1155`）；
 * 之所以自己算，是因为 `getScrollOffset()` **每次调用都 `new Vec2()`**，逐帧调会白造垃圾。
 *
 * ── 三条硬口径（改这个文件前必读）──
 *   ① **`content` 上不许有启用中的 `Layout`**：虚拟化自己摆位置，`Layout` 会跟着把它摆回去，
 *      表现是「格子乱跳/挤成一坨」。`_ensureReady()` 里有一条一次性告警专门盯这个。
 *   ② **模板节点只用来克隆，自己不参与显示**：拿到模板后立刻 `active = false` 并留在 `content` 里
 *      （**不销毁**，池空了还要再克隆），所以它**不会**被算进可见格。
 *   ③ **`onDispose` 里绝不碰别的组件**：只归还自己的节点、清自己的数组。
 *      收尾时连后代节点的 `getComponent` 都不能调（子节点先销毁、`Node._components` 已置 null），
 *      这是本工程踩过的坑（见 AGENTS.md「表现层 onDestroy」）。
 *
 * ── 不做清单（刻意的，别当漏了）──
 *   · **循环列表（loop / 首尾相接无限滚）**：要做对必须复制首尾并做位置回绕，与「按 index 摆放」
 *     的正交模型冲突，收益也远小于复杂度 —— 需要滚到头的界面用 `scrollToIndex` 即可。
 *   · **不等高的网格**：网格里的行高取该行最大值（已支持），但**格子的宽**（横轴尺寸）一律取模板宽，
 *     不支持每格不同宽（要这个就把「一行多格」做成一个 cell）。
 *   · **自动回弹/吸附对齐（snap）**：交给 ScrollView 自己的 `ScrollView` 设置，本组件不管。
 *
 * ── 用法（最短路径）──
 * ```ts
 * // 节点结构：list(ScrollView) → view(Mask) → content   ← 模板就是 content 现在的第一个子节点
 * @property(VirtualList) vlist: VirtualList = null;
 *
 * protected onInit(): void {
 *     this.vlist.setItemRenderer(this, (index, node) => {
 *         node.getChildByName('num').getComponent(Label).string = `${index + 1}`;
 *     });
 *     this.vlist.numItems = 100;          // ← 设完就会铺格
 * }
 * ```
 *
 * ── 与工程其它部分的接口 ──
 *   · 数据侧只喂**判据层**（`BagVM` / `ShopVM` / `HeroVM` 这种）算好的结果，
 *     **不许在 cell 里自己算业务**（本工程「判据只有一份」的规矩）；
 *   · 刷新粒度：`refreshItem(i)`（一格变了）/ `refreshAll()`（全变了）/ `reload()`（格子数量或尺寸变了）；
 *   · 与 `RefreshGate` 配合：Gate 的键变了就 `refreshAll()`，单格状态变了就 `refreshItem(i)`。
 */

import { _decorator, Enum, Node, ScrollView, UITransform, Vec2, ccenum, error, instantiate, warn } from 'cc';
import { UIWidget } from './UIWidget';

const { ccclass, property } = _decorator;

/** 布局方向：纵向单列 / 横向单行 / 纵向网格（多列）/ 横向网格（多行） */
export enum VirtualListLayout {
    /** 纵向单列（最常见：任务、聊天、设置） */
    Vertical = 0,
    /** 横向单行 */
    Horizontal = 1,
    /** 纵向滚动、一行 `gridCount` 格（背包、图鉴、难度格） */
    GridVertical = 2,
    /** 横向滚动、一列 `gridCount` 格 */
    GridHorizontal = 3,
}
ccenum(VirtualListLayout);

/** 横轴对齐（单列时的格子整体靠左/居中/靠右） */
export enum VirtualListCrossAlign {
    Start = 0,
    Center = 1,
    End = 2,
}
ccenum(VirtualListCrossAlign);

/** 渲染回调：把第 `index` 条数据画到 `node` 上（复用节点，**必须整格重画**，别留上一条的残留） */
export type VirtualListItemRenderer = (index: number, node: Node) => void;

/** 主轴尺寸回调：返回第 `index` 格在**滚动方向**上的长度（像素） */
export type VirtualListItemSizeProvider = (index: number) => number;

/** 模板类型回调：返回第 `index` 格用哪个模板（不设则全用默认模板） */
export type VirtualListTemplateKeyProvider = (index: number) => string;

/** 可见区间回调：可见区间变化时触发（first/last 都是**闭区间**下标，-1 表示空） */
export type VirtualListRangeListener = (first: number, last: number) => void;

/** 一次性告警去重（同一条只提醒一次，别每帧刷屏） */
const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
    if (warned.has(key)) {
        return;
    }
    warned.add(key);
    warn(msg);
}

/**
 * 二分查找：第一个「右边界 > d」的行（`d` = 距内容顶端的距离）。
 * 只有**不等高**（配了 `setItemSizeProvider`）才需要二分；等高走除法，见 `_findFirstLine`。
 */
function lowerBoundByEnd(offsets: Float64Array, lineMain: Float64Array, lineCount: number, d: number): number {
    let lo = 0;
    let hi = lineCount - 1;
    let ans = lineCount - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] + lineMain[mid] > d) {
            ans = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    return ans;
}

/** 二分查找：最后一个「起点 < d」的行 */
function lowerBoundByStart(offsets: Float64Array, lineCount: number, d: number): number {
    let lo = 0;
    let hi = lineCount - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < d) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** 把行下标夹到 `[0, lineCount-1]`（**下界也要夹**：过冲时它会算成负数） */
function clampLine(l: number, lineCount: number): number {
    if (l < 0) {
        return 0;
    }
    return l > lineCount - 1 ? lineCount - 1 : l;
}

/** 模块级临时量（避免逐帧 new；`scrollToOffset` 会自己 clone） */
const _tmpOffset = new Vec2();

/**
 * VirtualList —— 见文件头。
 * 继承 `UIWidget`（**不加 `@uiview`**）：它是预制件里内嵌的小组件，生命周期归 Cocos 管，
 * 顺带白拿 UIScope 与「onDispose 抛异常不堵死引擎销毁队列」的兜底。
 */
@ccclass('VirtualList')
export class VirtualList extends UIWidget {

    // ───────────────────────────── 编辑器拖引用 ─────────────────────────────

    /** 滚动视口（**必须是 ScrollView 所在节点上的那个组件**；本组件通常也挂在这个节点上） */
    @property(ScrollView)
    scrollView: ScrollView = null;

    /** 滚动内容节点（ScrollView 的 `content`；⚠ 上面**不要**留启用中的 `Layout`） */
    @property(Node)
    contentNode: Node = null;

    /** 格子模板（不拖则取 `content` 的第一个子节点；它会被置为 `active=false` 只当模板） */
    @property(Node)
    templateNode: Node = null;

    // ───────────────────────────── 布局 ─────────────────────────────

    /** 布局方向 */
    @property({ type: Enum(VirtualListLayout), tooltip: 'Vertical=纵向单列 / Horizontal=横向单行 / GridVertical=纵向多列 / GridHorizontal=横向多行' })
    layout: VirtualListLayout = VirtualListLayout.Vertical;

    /** 网格的列数（`GridVertical`）或行数（`GridHorizontal`）；单列/单行时忽略 */
    @property({ tooltip: '网格的列数/行数；单列单行时忽略' })
    gridCount: number = 1;

    /** 主轴（滚动方向）格间距 */
    @property
    spacingMain: number = 0;

    /** 横轴（垂直滚动方向）格间距 */
    @property
    spacingCross: number = 0;

    /** 主轴起始内边距（纵向 = 上边距，横向 = 左边距） */
    @property
    paddingMainStart: number = 0;

    /** 主轴结束内边距（纵向 = 下边距，横向 = 右边距） */
    @property
    paddingMainEnd: number = 0;

    /** 横轴起始内边距（纵向 = 左边距，横向 = 上边距） */
    @property
    paddingCrossStart: number = 0;

    /** 横轴结束内边距（纵向 = 右边距，横向 = 下边距） */
    @property
    paddingCrossEnd: number = 0;

    /** 横轴对齐（格子整体贴起始边 / 居中 / 贴结束边） */
    @property({ type: Enum(VirtualListCrossAlign) })
    crossAlign: VirtualListCrossAlign = VirtualListCrossAlign.Center;

    /** 是否连横轴尺寸也由本组件接管（默认 **false**：横轴尺寸沿用预制件里 `content` 的宽度/高度） */
    @property({ tooltip: '连横轴尺寸也接管；默认关，横轴沿用预制件里 content 的尺寸' })
    fitCrossSize: boolean = false;

    // ───────────────────────────── 虚拟化参数 ─────────────────────────────

    /** 视口上下各多铺多少（**视口长度的倍数**）：0.5 = 上下各多铺半屏，滚动时不容易看见空白 */
    @property({ tooltip: '视口倍数缓冲，0.5 = 上下各多铺半屏' })
    overscanRatio: number = 0.5;

    /** 每帧最多新建几个节点（分帧创建，避免一次性实例化一大片卡一帧） */
    @property({ tooltip: '每帧最多新建的节点数（分帧创建）' })
    maxCreatePerFrame: number = 8;

    /** 池子保留上限（超出的直接销毁，避免来回切界面把池子撑大） */
    @property({ tooltip: '对象池保留上限，超出的销毁' })
    maxPoolSize: number = 48;

    // ───────────────────────────── 运行期状态 ─────────────────────────────

    /** 数据条数（**写这个属性就会铺格**） */
    private _numItems: number = 0;

    /** 每个「行」在主轴上的长度（等高空数组，走算术） */
    private _lineMain: Float64Array = null;
    /** 每个「行」的主轴起始偏移（长度 = 行数 + 1，最后一位是整表长度） */
    private _offsets: Float64Array = null;
    /** 行数（纵向单列时 == 条数） */
    private _lineCount: number = 0;
    /** 一行几格（纵向单列 = 1；网格 = `gridCount`） */
    private _perLine: number = 1;
    /** 等高层距（行高 + 主轴间距）；不等高时为 -1 */
    private _stride: number = -1;
    /** 不等高标记 */
    private _variable: boolean = false;

    /** 主轴内容总长（含两端内边距） */
    private _mainTotal: number = 0;
    /** 横轴内容总长（仅在 `fitCrossSize` 时回写 `content`） */
    private _crossTotal: number = 0;
    /** 横轴可用长度（读预制件里的 `content` 尺寸） */
    private _crossAvail: number = 0;

    /** 当前视口里最靠前的一格下标（`_cells.length === 0` 时无意义） */
    private _first: number = 0;
    /** 当前活着的格子节点（**按 index 升序**，下标连续：`[_first, _first + _cells.length)`） */
    private _cells: Node[] = [];
    /** 与 `_cells` 平行的模板 key（还池时按 key 归位） */
    private _cellKeys: string[] = [];
    /** 与 `_cells` 平行的**主轴尺寸快照**（取用时问一次 `_sizeProvider`，之后摆放只用快照：
     *  否则每帧对每个可见格都问一次，既慢又要求回调必须幂等） */
    private _cellSizes: number[] = [];

    /** 对象池：模板 key → 空闲节点 */
    private _pool: Map<string, Node[]> = new Map();
    /** 非默认模板：key → 模板节点 */
    private _templates: Map<string, Node> = new Map();
    /** 默认模板节点（克隆源，自己永远不显示） */
    private _defaultTemplate: Node = null;

    /** 渲染回调 */
    private _renderer: VirtualListItemRenderer = null;
    private _rendererTarget: unknown = null;
    /** 尺寸回调（不设 = 全部等高） */
    private _sizeProvider: VirtualListItemSizeProvider = null;
    private _sizeProviderTarget: unknown = null;
    /** 模板 key 回调（不设 = 全用默认模板） */
    private _templateKeyProvider: VirtualListTemplateKeyProvider = null;
    private _templateKeyTarget: unknown = null;
    /** 可见区间回调 */
    private _rangeListener: VirtualListRangeListener = null;
    private _rangeTarget: unknown = null;

    /** 需要重建行表（条数/尺寸/间距/方向变了） */
    private _layoutDirty: boolean = true;
    /** 所有活格子都要重画（数据整体变了） */
    private _renderDirty: boolean = true;
    /** 强制重铺（视口尺寸变了） */
    private _rangeDirty: boolean = true;

    /** 上一帧的 `content.position`（用于判断"这一帧到底滚了没"） */
    private _lastPosX: number = Number.NaN;
    private _lastPosY: number = Number.NaN;
    /** 上一帧的视口尺寸（用于判断"视口变了没"） */
    private _lastViewW: number = Number.NaN;
    private _lastViewH: number = Number.NaN;
    /** 上一次派发出去的可见区间（用于只在变化时通知） */
    private _lastRangeFirst: number = -2;
    private _lastRangeLast: number = -2;

    /** 引用是否已解析（`_ensureReady` 的闸门） */
    private _ready: boolean = false;
    /** 引用解析失败时的错误文案（避免每帧重复报错） */
    private _brokenReason: string = '';

    /** `_acquire` 的带出字段：这次用的是哪个模板 key（省掉调用方再问一次） */
    private _acquireKey: string = 'default';
    /** `_acquire` 的带出字段：这次是"新建"还是"从池里拿"（只对新建扣分帧预算） */
    private _acquireCreated: boolean = false;

    // ═══════════════════════════ 公开 API ═══════════════════════════

    /** 数据条数。写入即重建行表并重铺（同一个值重复写不会白干活） */
    public get numItems(): number {
        return this._numItems;
    }

    public set numItems(value: number) {
        const n = value > 0 ? Math.floor(value) : 0;
        if (n === this._numItems) {
            return;
        }
        this._numItems = n;
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
    }

    /**
     * 绑定渲染回调（**唯一**把数据画到格子上的入口）。
     * `target` 显式传，避免依赖箭头函数以外的 `this` 语义（本工程一贯做法）。
     */
    public setItemRenderer(target: unknown, cb: VirtualListItemRenderer): void {
        this._rendererTarget = target;
        this._renderer = cb;
        this._renderDirty = true;
    }

    /**
     * 绑定主轴尺寸回调（**不等高**列表用；不绑 = 全部等于模板尺寸）。
     * ⚠ 回调会被「行表重建」时对**每一行**调用一次（网格是取行内最大值），别在里面做重活。
     */
    public setItemSizeProvider(target: unknown, cb: VirtualListItemSizeProvider): void {
        this._sizeProviderTarget = target;
        this._sizeProvider = cb;
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
    }

    /** 绑定模板 key 回调（多模板列表用） */
    public setTemplateKeyProvider(target: unknown, cb: VirtualListTemplateKeyProvider): void {
        this._templateKeyTarget = target;
        this._templateKeyProvider = cb;
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
    }

    /** 绑定可见区间回调（做曝光统计/懒加载用；**只在区间真的变了**才触发） */
    public setVisibleRangeListener(target: unknown, cb: VirtualListRangeListener): void {
        this._rangeTarget = target;
        this._rangeListener = cb;
    }

    /**
     * 注册一个模板（多模板列表用）。节点会被置 `active=false` 只当克隆源。
     * 默认模板不需要注册 —— 拖 `templateNode` 或让 `content` 的第一个子节点当默认。
     */
    public registerTemplate(key: string, node: Node): void {
        if (!key || !node) {
            return;
        }
        node.active = false;
        this._templates.set(key, node);
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
    }

    /**
     * 重建行表并**全部重画**（条数变了、尺寸变了、格子内容全变了都调它）。
     * 视口尺寸/间距/方向在编辑器里改了也走这条。
     */
    public reload(): void {
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
    }

    /** 只重画一格（这一格还活着才有效；跑出视口的格子下次滚回来自然会重画） */
    public refreshItem(index: number): void {
        const i = index - this._first;
        if (i < 0 || i >= this._cells.length) {
            return;
        }
        this._renderCell(index, this._cells[i]);
    }

    /** 重画所有活着（含缓冲）的格子 */
    public refreshAll(): void {
        this._renderDirty = true;
    }

    /** 取某一格的节点（**跑出可视区就返回 null** —— 虚拟列表的必然结果，调用方要能接受） */
    public getCellNode(index: number): Node {
        const i = index - this._first;
        if (i < 0 || i >= this._cells.length) {
            return null;
        }
        return this._cells[i];
    }

    /**
     * 滚到第 `index` 格（把它对齐到视口起始边）。
     * `timeInSecond` > 0 走引擎的滚动动画（`attenuated` 由 ScrollView 决定）。
     */
    public scrollToIndex(index: number, timeInSecond: number = 0): void {
        if (!this._ensureReady()) {
            return;
        }
        const n = this._numItems;
        const i = index < 0 ? 0 : (index >= n ? n - 1 : index);
        if (n <= 0) {
            return;
        }
        this._buildLayoutIfDirty();
        const line = Math.floor(i / this._perLine);
        // 与 `_placeCell` 同一个口径：主轴起始内边距也算进去，否则"滚到第 N 格"会差一个边距
        const target = this.paddingMainStart + (this._offsets ? this._offsets[line] : line * this._stride);
        const max = this.scrollView.getMaxScrollOffset();
        const vertical = this._isVertical();
        if (vertical) {
            const y = Math.max(0, Math.min(target, max.y));
            _tmpOffset.set(0, y);
        } else {
            const x = Math.max(0, Math.min(target, max.x));
            _tmpOffset.set(x, 0);
        }
        this.scrollView.scrollToOffset(_tmpOffset, timeInSecond);
    }

    /** 清空数据并把所有格子还池（换页签/关界面时调，比等销毁更省） */
    public clear(): void {
        this.numItems = 0;
        this._recycleAll();
    }

    // ═══════════════════════════ 生命周期 ═══════════════════════════

    protected onInit(): void {
        // 什么都不做：引用解析推迟到第一次 `update`（`@property` 已由引擎注入，
        // 但代码里 `addComponent` 后手动赋值的场景也常见，统一在 `_ensureReady` 里兜底）
    }

    protected onDispose(): void {
        // ⚠ 只碰自己的字段。**不要**在这里 `getComponent` 后代节点（子节点先销毁 → `_components` 已置 null），
        //    也不要把异常抛出去（UIWidget 已兜一层，这里也不给它机会）。
        this._cells.length = 0;
        this._cellKeys.length = 0;
        this._cellSizes.length = 0;
        this._pool.clear();
        this._templates.clear();
        this._defaultTemplate = null;
        this._renderer = null;
        this._rendererTarget = null;
        this._sizeProvider = null;
        this._sizeProviderTarget = null;
        this._templateKeyProvider = null;
        this._templateKeyTarget = null;
        this._rangeListener = null;
        this._rangeTarget = null;
        this._offsets = null;
        this._lineMain = null;
        this._ready = false;
    }

    /**
     * 每帧：① 视口尺寸变了吗 ② 内容滚了吗 —— 两者都没变就**直接早退**（一次比较的开销）。
     * 用轮询而不是听 `ScrollView` 的 `SCROLLING` 事件，是因为惯性滑动、回弹、`scrollTo` 动画
     * 都会移动 `content.position`，轮询**一个都不会漏**，还省掉一组监听的挂/摘。
     */
    protected update(_dt: number): void {
        if (!this._ensureReady()) {
            return;
        }

        // ── 视口尺寸变化（旋转/自适应/Widget 拉伸）──
        const viewUI = this.scrollView.node.getComponent(UITransform);
        const vw = viewUI ? viewUI.width : 0;
        const vh = viewUI ? viewUI.height : 0;
        if (vw !== this._lastViewW || vh !== this._lastViewH) {
            this._lastViewW = vw;
            this._lastViewH = vh;
            this._rangeDirty = true;
        }

        // ── 内容是否移动 ──
        const pos = this.contentNode.position;
        if (this._rangeDirty || this._layoutDirty || this._renderDirty
            || pos.x !== this._lastPosX || pos.y !== this._lastPosY) {
            this._lastPosX = pos.x;
            this._lastPosY = pos.y;
            this._updateList();
        }
    }

    // ═══════════════════════════ 内部：引用与校验 ═══════════════════════════

    /**
     * 解析引用 + 校验结构。返回 `false` 表示"这一帧别干活了"。
     * 失败只报一次错（`_brokenReason` 记住），避免每帧刷屏把控制台冲垮。
     */
    private _ensureReady(): boolean {
        if (this._ready) {
            return true;
        }
        if (this._brokenReason) {
            return false;
        }
        if (!this.scrollView || !this.scrollView.isValid) {
            this._brokenReason = '没有拖 ScrollView（`scrollView`），或它已被销毁';
            error(`[VirtualList] ${this.node.name}：${this._brokenReason}`);
            return false;
        }
        // `content` 的兜底：优先用拖的，其次读 ScrollView 自己的 `content` 字段
        if (!this.contentNode || !this.contentNode.isValid) {
            this.contentNode = this.scrollView.content;
        }
        if (!this.contentNode || !this.contentNode.isValid) {
            this._brokenReason = '没有 content 节点（既没拖 `contentNode`，ScrollView 的 `content` 也是空的）';
            error(`[VirtualList] ${this.node.name}：${this._brokenReason}`);
            return false;
        }
        // 模板兜底：拖的 → 否则 content 的第一个子节点
        if (!this.templateNode || !this.templateNode.isValid) {
            const children = this.contentNode.children;
            for (let i = 0; i < children.length; i++) {
                if (children[i] && children[i].isValid) {
                    this.templateNode = children[i];
                    break;
                }
            }
        }
        if (!this.templateNode || !this.templateNode.isValid) {
            this._brokenReason = '找不到格子模板（`content` 里没有任何子节点可当模板）';
            error(`[VirtualList] ${this.node.name}：${this._brokenReason}`);
            return false;
        }
        // ⚠ 引擎的 ScrollView 假定 `content.position` 就是视口局部坐标（`_getContentPosition()`），
        //    所以 content 必须是 ScrollView 节点的子节点，或中间隔着一个位于原点的节点。这里只做提示。
        if (this.contentNode.parent !== this.scrollView.node) {
            const p = this.contentNode.parent;
            if (p && (p.position.x !== 0 || p.position.y !== 0)) {
                warnOnce(`content-parent-offset:${this.node.name}`,
                    `[VirtualList] content 的父节点 ${p.name} 不在原点：滚动行程会与算出来的可见区间错位（引擎自身也假定 content 是视口的直接子节点）`);
            }
        }
        // ⚠⚠ content 上不许有启用中的 Layout：虚拟化自己摆位置，Layout 会跟着再摆一次
        const layoutComp: any = this.contentNode.getComponent('cc.Layout');
        if (layoutComp && layoutComp.enabledInHierarchy) {
            warnOnce(`content-layout:${this.node.name}`,
                `[VirtualList] content(${this.contentNode.name}) 上有启用中的 Layout：它会和虚拟化的摆放打架（格子乱跳/挤成一坨）。请删掉它或设 enabled=false`);
        }

        this._defaultTemplate = this.templateNode;
        // 模板只当克隆源：**留在 content 里但不显示**（销毁了池空时就没得克隆了）
        this._defaultTemplate.active = false;

        this._ready = true;
        this._layoutDirty = true;
        this._renderDirty = true;
        this._rangeDirty = true;
        // 用户可能已经在编辑器里把 ScrollView 的 content 指到别处了，这里对齐一次
        if (this.scrollView.content !== this.contentNode) {
            this.scrollView.content = this.contentNode;
        }
        return true;
    }

    private _isVertical(): boolean {
        return this.layout === VirtualListLayout.Vertical || this.layout === VirtualListLayout.GridVertical;
    }

    // ═══════════════════════════ 内部：行表（前缀和） ═══════════════════════════

    /**
     * 重建行表。**核心口径**：不管哪种布局，都先把数据切成「行」——
     * 纵向单列/横向单行时一行 = 1 格，网格时一行 = `gridCount` 格；
     * 于是主轴数学**只有一套**（前缀和 + 二分）。
     * 等高（没配 `setItemSizeProvider`）走**算术**，连数组都不建。
     */
    private _buildLayoutIfDirty(): void {
        if (!this._layoutDirty) {
            return;
        }
        this._layoutDirty = false;

        const n = this._numItems;
        const perLine = (this.layout === VirtualListLayout.GridVertical || this.layout === VirtualListLayout.GridHorizontal)
            ? (this.gridCount > 0 ? Math.floor(this.gridCount) : 1)
            : 1;
        this._perLine = perLine;
        this._lineCount = n > 0 ? Math.ceil(n / perLine) : 0;

        const tmplUI = this._defaultTemplate.getComponent(UITransform);
        const tmplW = tmplUI ? tmplUI.width : 0;
        const tmplH = tmplUI ? tmplUI.height : 0;
        const baseMain = this._isVertical() ? tmplH : tmplW;
        this._variable = !!this._sizeProvider;

        const mainSpacing = this.spacingMain;
        if (!this._variable) {
            this._stride = baseMain + mainSpacing;
            this._lineMain = null;
            this._offsets = null;
        } else {
            this._stride = -1;
            const lineCount = this._lineCount;
            if (!this._lineMain || this._lineMain.length < lineCount) {
                this._lineMain = new Float64Array(lineCount > 0 ? lineCount : 1);
            }
            if (!this._offsets || this._offsets.length < lineCount + 1) {
                this._offsets = new Float64Array(lineCount > 0 ? lineCount + 1 : 2);
            }
            let acc = 0;
            for (let l = 0; l < lineCount; l++) {
                const from = l * perLine;
                const to = Math.min(n, from + perLine);
                let maxSize = 0;
                for (let i = from; i < to; i++) {
                    const s = Number(this._sizeProvider.call(this._sizeProviderTarget, i));
                    if (s > maxSize) {
                        maxSize = s;
                    }
                }
                if (maxSize < 0 || !isFinite(maxSize)) {
                    maxSize = baseMain;
                }
                this._lineMain[l] = maxSize;
                this._offsets[l] = acc;
                acc += maxSize + mainSpacing;
            }
            this._offsets[lineCount] = acc;
        }

        // ── 主轴总长（末尾那一个间距不算）──
        const contentLen = this._lineCount > 0
            ? (this._variable ? this._offsets[this._lineCount] - mainSpacing : this._lineCount * this._stride - mainSpacing)
            : 0;
        this._mainTotal = this.paddingMainStart + Math.max(0, contentLen) + this.paddingMainEnd;

        // ── 横轴：可用长度读预制件，总长按需接管 ──
        const contentUI = this.contentNode.getComponent(UITransform);
        const crossSpacing = this.spacingCross;
        const lineCrossLen = perLine * (this._isVertical() ? tmplW : tmplH) + (perLine - 1) * crossSpacing;
        this._crossTotal = this.paddingCrossStart + lineCrossLen + this.paddingCrossEnd;
        this._crossAvail = this._isVertical()
            ? (contentUI ? contentUI.width : lineCrossLen)
            : (contentUI ? contentUI.height : lineCrossLen);

        // ── 写回 content 尺寸（ScrollView 靠它算滚动行程；尺寸没变时引擎不会重算，也不会触发多余事件）──
        if (contentUI) {
            const w = this._isVertical()
                ? (this.fitCrossSize ? this._crossTotal : contentUI.width)
                : this._mainTotal;
            const h = this._isVertical()
                ? this._mainTotal
                : (this.fitCrossSize ? this._crossTotal : contentUI.height);
            contentUI.setContentSize(w, h);
        }
    }

    // ═══════════════════════════ 内部：可见区间与铺格 ═══════════════════════════

    /** 主线：算可见区间 → 归还/取用节点 → 摆位置 → 派发区间回调 */
    private _updateList(): void {
        this._buildLayoutIfDirty();

        const n = this._numItems;
        if (n <= 0) {
            this._recycleAll();
            // ⚠ 两个脏标记必须一起清掉：不清的话 `update` 的早退判据永远为真，
            //   空列表会**每帧**都跑进来一次（不崩，但"没滚动就不干活"这条优化就废了）
            this._renderDirty = false;
            this._rangeDirty = false;
            this._emitRange(-1, -1);
            return;
        }

        // `refreshAll()` / 首次铺格：**所有活格子都要整格重画**（不只是新取用的那些）
        const renderAll = this._renderDirty;

        const viewUI = this.scrollView.node.getComponent(UITransform);
        const viewLen = this._isVertical() ? (viewUI ? viewUI.height : 0) : (viewUI ? viewUI.width : 0);
        const contentUI = this.contentNode.getComponent(UITransform);
        const contentLen = this._isVertical() ? (contentUI ? contentUI.height : 0) : (contentUI ? contentUI.width : 0);
        const contentAnchor = this._isVertical() ? (contentUI ? contentUI.anchorY : 1) : (contentUI ? contentUI.anchorX : 0);
        const viewAnchor = this._isVertical() ? (viewUI ? viewUI.anchorY : 0.5) : (viewUI ? viewUI.anchorX : 0.5);

        // 当前滚动量：**与引擎 `getScrollOffset()` 等价**（见文件头推导）
        const pos = this.contentNode.position;
        const contentStart = (this._isVertical() ? pos.y : pos.x) + (1 - contentAnchor) * contentLen;
        const viewStart = (1 - viewAnchor) * viewLen;
        const scrolled = contentStart - viewStart;

        // 可见窗口（距内容起始边的距离），含缓冲；**故意不夹到 [0, max]** —— 边缘回弹时要能看见格子
        const buffer = viewLen * (this.overscanRatio > 0 ? this.overscanRatio : 0);
        const d0 = scrolled - buffer;
        const d1 = scrolled + viewLen + buffer;

        // ⚠ 搜索窗口必须先**减掉主轴起始内边距**：行表里的 `offsets` 只有 `lineStart`，
        //   而 `_placeCell` 摆位置时用的是 `paddingMainStart + lineStart`（两处必须同口径）。
        //   不减的话窗口整体偏了一个 padding —— padding 大于缓冲时**视口顶部会露白一格**，
        //   小于缓冲时表现为缓冲偏心（下面多铺、上面少铺）。
        const searchStart = d0 - this.paddingMainStart;
        const searchEnd = d1 - this.paddingMainStart;

        let firstLine: number;
        let lastLine: number;
        if (this._variable) {
            firstLine = lowerBoundByEnd(this._offsets, this._lineMain, this._lineCount, searchStart);
            lastLine = lowerBoundByStart(this._offsets, this._lineCount, searchEnd);
        } else {
            const stride = this._stride > 0 ? this._stride : 1;
            firstLine = Math.floor(searchStart / stride);
            lastLine = Math.floor(searchEnd / stride);
        }
        // ⚠ **上下界都要夹**：只夹下界的话，过冲（content 被拖到"视口 + 缓冲"之外，例如边缘回弹拉过头）
        //   时 `lastLine` 是负的，紧接着 `firstLine > lastLine` 又把 `firstLine` 拽成负的 →
        //   `_fillToRange` 会造出 index 为负的格子，负下标一路喂给渲染回调与可见区间回调。
        firstLine = clampLine(firstLine, this._lineCount);
        lastLine = clampLine(lastLine, this._lineCount);
        if (firstLine > lastLine) {
            firstLine = lastLine;
        }

        let first = firstLine * this._perLine;
        let last = Math.min(n - 1, (lastLine + 1) * this._perLine - 1);
        if (first > n - 1) {
            first = n - 1;
        }

        // ── 归还跑出去的（头/尾）、取用新进来的 ──
        this._trimToRange(first, last);
        // `false` = 这一帧的分帧预算用尽、还没铺满 → **不能清 `_rangeDirty`**，否则下一帧会早退，永不续建
        const filled = this._fillToRange(first, last);

        // ── 摆位置（复用节点也要重摆：index → 坐标是纯函数）──
        const count = this._cells.length;
        for (let k = 0; k < count; k++) {
            const idx = this._first + k;
            if (renderAll) {
                this._renderCell(idx, this._cells[k]);
            }
            this._placeCell(idx, this._cells[k], this._cellSizes[k]);
        }

        this._renderDirty = false;
        // ⚠ 只在**真铺满**时才清 `_rangeDirty`：分帧预算用尽（`filled === false`）时保持为 `true`，
        //   下一帧 `update()` 才会再进来续建。之前这里无条件清掉，导致"一屏需要的格数 >
        //   `maxCreatePerFrame`"的列表（网格尤其明显）**永远只画前几格，不滚一下就再也不补**。
        this._rangeDirty = !filled;
        // ⚠ 只在**真铺出格子**时派发：分帧创建还没铺完（`count === 0`）时派发 `(-1,-1)` 会被消费方
        //   误读成"列表空了"（例如拿去清空曝光集合）。`(-1,-1)` 的语义**只有一个**：`numItems === 0`。
        if (count > 0) {
            this._emitRange(this._first, this._first + count - 1);
        }
    }

    /** 把活格子裁剪到 `[first, last]`（超出头/尾的还池） */
    private _trimToRange(first: number, last: number): void {
        // 全部跑出去了 → 一起还掉（下一次 fill 会重新取）
        if (this._cells.length === 0) {
            this._first = first;
            return;
        }
        const myLast = this._first + this._cells.length - 1;
        if (myLast < first || this._first > last) {
            this._recycleAll();
            this._first = first;
            return;
        }
        // 头部：`_cells` 是按 index 升序的稠密数组，从前往后还
        let dropHead = first - this._first;
        while (dropHead-- > 0 && this._cells.length > 0) {
            this._recycleAt(0, true);
        }
        // 尾部：从后往前还
        let dropTail = (this._first + this._cells.length - 1) - last;
        while (dropTail-- > 0 && this._cells.length > 0) {
            this._recycleAt(this._cells.length - 1, false);
        }
    }

    /**
     * 把活格子补齐到 `[first, last]`；`maxCreatePerFrame` 是每帧的**新建**预算（取池不算）。
     *
     * @returns **是否铺满**：`false` = 预算用尽提前收工 —— 调用方必须让 `_rangeDirty` 保持 `true`，
     *          否则下一帧 `update()` 的早退判据成立、再也不会续建。
     */
    private _fillToRange(first: number, last: number): boolean {
        let budget = this.maxCreatePerFrame > 0 ? Math.floor(this.maxCreatePerFrame) : 1 << 30;
        // 头补（从 `first` 往 `_first` 方向一格一格补，`unshift` 是 O(活格子数)，活格子只有十几二十个）
        while (this._first > first) {
            const idx = this._first - 1;
            const node = this._acquire(idx, budget);
            if (!node) {
                break;
            }
            if (this._acquireCreated) {
                budget--;
            }
            this._first = idx;
            this._cells.unshift(node);
            this._cellKeys.unshift(this._acquireKey);
            this._cellSizes.unshift(this._sizeOfItem(idx));
        }
        // 尾补
        while (this._first + this._cells.length - 1 < last) {
            const idx = this._first + this._cells.length;
            const node = this._acquire(idx, budget);
            if (!node) {
                break;
            }
            if (this._acquireCreated) {
                budget--;
            }
            this._cells.push(node);
            this._cellKeys.push(this._acquireKey);
            this._cellSizes.push(this._sizeOfItem(idx));
        }
        // 铺满了才返回 true；没铺满（预算用尽 / 池与预算都拿不到）交给调用方保持 `_rangeDirty`
        return this._first <= first && this._first + this._cells.length - 1 >= last;
    }

    /** 可见区间回调（**只在变了的时候**触发） */
    private _emitRange(first: number, last: number): void {
        if (first === this._lastRangeFirst && last === this._lastRangeLast) {
            return;
        }
        this._lastRangeFirst = first;
        this._lastRangeLast = last;
        if (this._rangeListener) {
            this._rangeListener.call(this._rangeTarget, first, last);
        }
    }

    // ═══════════════════════════ 内部：对象池 ═══════════════════════════

    /** 第 `index` 格该用哪个模板 key（没配回调就是 DEFAULT） */
    private _keyOf(index: number): string {
        if (!this._templateKeyProvider) {
            return 'default';
        }
        const k = this._templateKeyProvider.call(this._templateKeyTarget, index);
        return k ? k : 'default';
    }

    /**
     * 取一个节点：**先池、后克隆**。返回 `null` 表示"这一帧的新建预算用完了"（调用方 break，下一帧再来）。
     * 取到就立刻 `active = true` 并渲染一次（`renderer` 必须**整格重画**，见文件头）。
     * 取用结果通过 `_acquireKey` / `_acquireCreated` 带出去（避免调用方再问一次 `_keyOf`、也避免多分配一个对象）。
     * ⚠ **只有"新建"才吃预算**：从池里拿是零成本的，不该被 `maxCreatePerFrame` 卡住。
     */
    private _acquire(index: number, budget: number): Node {
        const key = this._keyOf(index);
        const bucket = this._pool.get(key);
        let node: Node = null;
        let created = false;
        if (bucket && bucket.length > 0) {
            node = bucket.pop();
        } else {
            if (budget <= 0) {
                return null;
            }
            const tmpl = key === 'default' ? this._defaultTemplate : (this._templates.get(key) || this._defaultTemplate);
            node = this._createFromTemplate(tmpl);
            if (!node) {
                return null;
            }
            created = true;
        }
        this._acquireKey = key;
        this._acquireCreated = created;
        node.active = true;
        this._renderCell(index, node);
        return node;
    }

    /** 克隆一个模板（`instantiate` 会连子节点一起复制；模板本身是 `active=false` 的，克隆体手动打开） */
    private _createFromTemplate(tmpl: Node): Node {
        const node = instantiate(tmpl);
        if (!node) {
            return null;
        }
        node.active = true;
        this.contentNode.addChild(node);
        return node;
    }

    /** 还一个节点回池（`active=false` 留在 content 下，**不销毁**） */
    private _release(node: Node, key: string): void {
        if (!node || !node.isValid) {
            return;
        }
        node.active = false;
        let bucket = this._pool.get(key);
        if (!bucket) {
            bucket = [];
            this._pool.set(key, bucket);
        }
        const cap = this.maxPoolSize > 0 ? Math.floor(this.maxPoolSize) : 64;
        if (bucket.length >= cap) {
            node.destroy();
            return;
        }
        bucket.push(node);
    }

    /** 还掉 `_cells[k]`（`head=true` 从数组头移除，`false` 从尾） */
    private _recycleAt(k: number, head: boolean): void {
        const node = this._cells[k];
        const key = this._cellKeys[k];
        this._cells.splice(k, 1);
        this._cellKeys.splice(k, 1);
        this._cellSizes.splice(k, 1);
        if (head) {
            this._first++;
        }
        this._release(node, key);
    }

    /** 全部还池（清数据、换页、销毁前） */
    private _recycleAll(): void {
        const count = this._cells.length;
        for (let k = count - 1; k >= 0; k--) {
            this._release(this._cells[k], this._cellKeys[k]);
        }
        this._cells.length = 0;
        this._cellKeys.length = 0;
        this._cellSizes.length = 0;
        this._first = 0;
    }

    /**
     * 第 `index` 格的主轴尺寸 —— **只在取用时问一次**（结果进 `_cellSizes` 快照）。
     * 不在 `_placeCell` 里现问的理由有两个：① 滚动时每帧每格问一次是白花的开销；
     * ② 摆放与行表用了**两次不同时刻**的返回值，回调只要有一点点不确定，格子就会与行表对不齐。
     */
    private _sizeOfItem(index: number): number {
        if (!this._variable || !this._sizeProvider) {
            return 0;
        }
        const s = Number(this._sizeProvider.call(this._sizeProviderTarget, index));
        return isFinite(s) && s > 0 ? s : 0;
    }

    // ═══════════════════════════ 内部：渲染与摆放 ═══════════════════════════

    /** 把数据画到节点上（**整格重画**；节点是复用的，上一条的内容不会自己消失） */
    private _renderCell(index: number, node: Node): void {
        if (this._renderer) {
            this._renderer.call(this._rendererTarget, index, node);
        }
    }

    /**
     * 摆放一格。坐标全部以 **content 自己的锚点为原点** 推导：
     * 内容矩形的上边在 `y = (1 - anchorY) * height`、左边在 `x = -anchorX * width`，
     * 所以「距起始边 d、距横轴起始边 r」的格子其 **原点**（锚点在格子内部）是
     * ```
     * 纵向：y = contentTop - d - (1 - cellAnchorY) * cellH
     *       x = contentLeft + r + cellAnchorX * cellW
     * 横向：x = contentLeft + d + cellAnchorX * cellW
     *       y = contentTop - r - (1 - cellAnchorY) * cellH
     * ```
     */
    private _placeCell(index: number, node: Node, mySize: number): void {
        if (!node || !node.isValid) {
            return;
        }
        const contentUI = this.contentNode.getComponent(UITransform);
        const cw = contentUI ? contentUI.width : 0;
        const ch = contentUI ? contentUI.height : 0;
        const cax = contentUI ? contentUI.anchorX : 0.5;
        const cay = contentUI ? contentUI.anchorY : 0.5;
        const contentLeft = -cax * cw;
        const contentTop = (1 - cay) * ch;

        const cellUI = node.getComponent(UITransform);
        const cellW = cellUI ? cellUI.width : 0;
        const cellH = cellUI ? cellUI.height : 0;
        const cellAX = cellUI ? cellUI.anchorX : 0.5;
        const cellAY = cellUI ? cellUI.anchorY : 0.5;

        const line = Math.floor(index / this._perLine);
        const col = index - line * this._perLine;

        // 主轴：距起始边的距离 d（`mySize` 由调用方从 `_cellSizes` 快照带进来）
        const lineMain = this._variable
            ? this._lineMain[line]
            : (this._isVertical() ? cellH : cellW);
        const lineStart = this._variable ? this._offsets[line] : line * this._stride;
        // ⚠ 只有**不等高**才有"在行内居中"这一项：等高时 `mySize` 恒为 0，加这一项会把整列整体下移半格
        const d = this.paddingMainStart + lineStart + (this._variable ? (lineMain - mySize) / 2 : 0);

        // 横轴：距横轴起始边的距离 r
        const crossSpacing = this.spacingCross;
        const perLine = this._perLine;
        const vertical = this._isVertical();
        const cellCross = vertical ? cellW : cellH;
        const lineCrossLen = perLine * cellCross + (perLine - 1) * crossSpacing;
        const crossAvail = vertical ? cw : ch;
        let rStart: number;
        if (this.crossAlign === VirtualListCrossAlign.Start) {
            rStart = this.paddingCrossStart;
        } else if (this.crossAlign === VirtualListCrossAlign.End) {
            rStart = crossAvail - this.paddingCrossEnd - lineCrossLen;
        } else {
            rStart = (crossAvail - lineCrossLen) / 2;
        }
        const r = rStart + col * (cellCross + crossSpacing);

        const x = vertical
            ? contentLeft + r + cellAX * cellW
            : contentLeft + d + cellAX * cellW;
        const y = vertical
            ? contentTop - d - (1 - cellAY) * cellH
            : contentTop - r - (1 - cellAY) * cellH;

        node.setPosition(x, y, 0);
    }
}
