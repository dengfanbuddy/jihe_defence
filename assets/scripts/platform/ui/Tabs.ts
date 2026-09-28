/**
 * Tabs —— 通用页签：维护「tab 节点 ←→ content 节点」的对应关系，点 tab 切换选中态并显隐对应内容
 *
 * ── 它管什么 ──
 *   ① **选中态**：只有一个 tab 是选中的（`select` 是唯一写入方，其他节点自然 unselect）
 *   ② **内容显隐**：`contentNodes[i].active = (i === selectedIndex)`，其余全部关掉
 *   ③ **向下共享选中态**：`provide` 两个 ref（下标 / key），内容节点与任意深度的后代都能 `inject` + `watch`
 *   ④ **向上通知**：点击与切换会 `scope.emit`（沿父链冒泡，宿主祖先能收到）；子类也可重写 `onTabChanged`
 *
 * ── 通信规约（与 docs/UI框架使用说明.md §7 一致）──
 *   · tab 节点 / content 节点都是**自己的子项**，宿主直接持有并写状态是允许的（不需要跨组件 getComponent）
 *   · 选中态「真源」在 `Tabs` 这一份，向下用 `provide`（不塞全局 store：它是页面级 UI 状态，判据见 `StageScope.ts` 头注释）
 *   · 兄弟互斥不靠互相引用：选中态只由 Tabs 一处决定，表现通过 `applyTabSelected` → `TabItem.setSelected` 下发
 *
 * ── 编辑器怎么摆（Tabs 挂在同时包含 tab 和 content 的**共同祖先**上）──
 * ```
 * content            ← [Tabs]（tabBarNode = menus，contentBarNode = right）
 * ├── menus          ← tabBarNode（子节点按顺序 = tab）
 * │   ├── game       ← [TabItem 的子类] 表现写在 onSelectedChanged 里
 * │   ├── achivement ← [TabItem 的子类]
 * │   └── hero       ← [TabItem 的子类]
 * └── right          ← contentBarNode（子节点按顺序 = content，与上面一一对应）
 *     ├── game       ← [View_Game_Stage 之类，可以继承 UIWidget]
 *     ├── achivement ←
 *     └── hero       ←
 * ```
 *   - `tabNodes` / `contentNodes` **留空**时自动取 `tabBarNode.children` / `contentBarNode.children`
 *     （想让某些子节点不参与，就显式拖 `tabNodes` / `contentNodes` 数组）
 *   - 校验：两个列表**按下标一一对应**，数量不一致会在控制台 warn（按较短的对齐，不会崩）
 *   - content 要在 `Tabs` 的**子树内**才 inject 得到选中态（provide 只对子树可见，跨层 / 兄弟注不到）
 *
 * ── 表现怎么写：框架不管，只留接口（不预设任何节点名/颜色约定）──
 *   A. 每个 tab 节点挂 `TabItem` 的**子类**，重写 `onSelectedChanged(selected)`（推荐：表现跟节点走，最直观）
 *      —— 不同类型的 tab（图标型 / 文字型 / 带动画）就写不同的子类，各自挂在自己的 tab 节点上
 *   B. tab 组件不是 `TabItem` 子类 → 重写 `Tabs.applyTabSelected(tab, index, selected)` 按自己的类型分发
 *
 * ── 用法 ──
 * ```ts
 * // ① tab 的表现：继承 TabItem，想怎么画就怎么画（框架默认什么都不做）
 * @ccclass('TabItem_Func')
 * export class TabItem_Func extends TabItem {
 *     protected onSelectedChanged(selected: boolean): void {
 *         this.activeBg.active = selected;                       // 换底图 / 改色 / 播动画……随你
 *     }
 * }
 *
 * // ② 业务侧监听切换（宿主：拿到 Tabs 实例直接 scope.on，emit 会沿父链冒泡到宿主）
 * this.tabs.scope.on(TabsScopeEvents.Changed, (index: number, key: string, prev: number) => {
 *     LogMgr.debug(`切到 ${key}（${prev} → ${index}）`);
 * });
 *
 * // ③ 子类重写虚拟钩子（菜单里的 `Cmp_FuncTabs` 要接入就这么写）
 * @ccclass('Cmp_FuncTabs')
 * export class Cmp_FuncTabs extends Tabs {
 *     protected onTabChanged(index: number, key: string, prevIndex: number): void {
 *         if (key === 'hero') this.refreshHeroList();
 *     }
 * }
 *
 * // ④ 内容节点（UIWidget 子类）想知道「我被切到了」：inject 选中态，或实现 ITabContent
 * protected onInit(): void {
 *     this.selectedIndex = this.inject<Ref<number>>(TabsScopeKeys.SelectedIndex, null);
 * }
 * // ITabContent 是给「节点一直 active、只想被通知」的内容用的；正常显隐直接用 UIWidget 的 onShow/onHide
 * ```
 *
 * ⚠ 继承 `UIWidget` 就**不要**加 `@uiview`，也不要重写 `onLoad/onEnable/onDisable/onDestroy`。
 */

import { _decorator, Button, Node } from "cc";
import { ref, type Ref } from "../reactivity";
import { LogMgr } from "../log/LogMgr";
import { UIWidget } from "./UIWidget";
import { TabItem } from "./TabItem";

const { ccclass, property } = _decorator;

/** `Tabs` 向下注入的状态键（`inject` + `scope.watch` 用；值与 `TabItem` / 内容节点共享） */
export const TabsScopeKeys = {
    /** 当前选中的下标（`Ref<number>`，-1 = 都没选） */
    SelectedIndex: "tabs:selectedIndex",
    /** 当前选中的 key（`Ref<string>`，`TabItem.tabKey` 优先，留空时是节点名） */
    SelectedKey: "tabs:selectedKey",
} as const;

/** `Tabs` 抛出的事件（`scope.on` 监听；emit 沿父链向上冒泡，所以宿主祖先收得到） */
export const TabsScopeEvents = {
    /** 某个 tab 被点了（参数：index, key）—— 切换是否真的发生还没决定，适合埋点/拦截 */
    Click: "tabs:click",
    /** 选中项真的变了（参数：index, key, prevIndex） */
    Changed: "tabs:changed",
    /** 又点了一次**已经选中**的 tab（参数：index, key）—— 状态没变，内容可借此刷新 */
    Reselect: "tabs:reselect",
} as const;

/**
 * 内容节点可选的「被切到了」回调：节点上的任意组件实现了这两个方法就会被调到。
 * 正常显隐用 `UIWidget` 的 `onShow/onHide` 就够了，这个接口是给
 * 「节点一直 active（如共用背景板）也需要知道切换」或「重选时想刷新」的场景。
 */
export interface ITabContent {
    /** 本内容被显示（每次可见都会调，重选同一下标也会再调一次） */
    onTabShow?(index: number, key: string): void;
    /** 本内容被隐藏（关闭节点 active 之前调） */
    onTabHide?(index: number, key: string): void;
}

/** `select()` 的可选项 */
export interface ITabSelectOptions {
    /** true = 即使下标没变也重新应用一遍（重选刷新用） */
    force?: boolean;
    /** true = 不发 `Changed` 事件、不走 `onTabChanged` 钩子（静默切换） */
    silent?: boolean;
}

@ccclass("Tabs")
export class Tabs extends UIWidget {

    /* ==================== 编辑器配置：节点 ==================== */

    /** tab 节点列表（顺序 = 下标）。留空则取 `tabBarNode.children` */
    @property({ type: [Node], tooltip: "tab 节点列表（顺序即下标）；留空则取 tabBarNode 的子节点" })
    public tabNodes: Node[] = [];

    /** tab 容器：`tabNodes` 留空时自动收集它的子节点 */
    @property({ type: Node, tooltip: "tab 容器：tabNodes 留空时自动取它的子节点" })
    public tabBarNode: Node = null;

    /** content 节点列表（顺序与 tab 一一对应）。留空则取 `contentBarNode.children` */
    @property({ type: [Node], tooltip: "content 节点列表（顺序与 tab 一一对应）；留空则取 contentBarNode 的子节点" })
    public contentNodes: Node[] = [];

    /** content 容器：`contentNodes` 留空时自动收集它的子节点 */
    @property({ type: Node, tooltip: "content 容器：contentNodes 留空时自动取它的子节点" })
    public contentBarNode: Node = null;

    /* ==================== 编辑器配置：行为 ==================== */

    /** 初始选中的下标（-1 = 开局都不选） */
    @property({ type: Number, tooltip: "初始选中的下标；-1 = 开局都不选" })
    public defaultIndex: number = 0;

    /** 初始化时就切到 `defaultIndex`（关掉则保持预制件里的原状，由外部显式调 select） */
    @property({ type: Boolean, tooltip: "初始化时就切到 defaultIndex" })
    public switchOnInit: boolean = true;

    /** 每次显示（onShow）是否回到 `defaultIndex`（关掉 = 记住上次选中项） */
    @property({ type: Boolean, tooltip: "每次显示是否回到 defaultIndex；关掉 = 记住上次选中项" })
    public resetOnShow: boolean = false;

    /** 再点一次**已经选中**的 tab 时，是否取消选中（默认否：只发 Reselect 事件） */
    @property({ type: Boolean, tooltip: "再点已选中的 tab 是否取消选中" })
    public allowSwitchOff: boolean = false;

    /* ==================== 运行时状态 ==================== */

    /** 当前选中的下标（-1 = 都没选） */
    private _selectedIndex: number = -1;
    /** 收集到的 tab 节点（下标 → 节点） */
    private _tabList: Node[] = [];
    /** 收集到的 content 节点（下标 → 节点，与 `_tabList` 对应） */
    private _contentList: Node[] = [];
    /** 下标 → TabItem（含子类实例；为 null = 该 tab 没挂 TabItem，表现交给 `applyTabSelected` 的重写） */
    private _tabItems: (TabItem | null)[] = [];
    /** 下标 → key（`TabItem.tabKey` 优先，否则节点名） */
    private _keys: string[] = [];
    /** 一次点击绑定的记账（节点事件不像 scope 事件那样自动回收，onDispose 要成对 off） */
    private _clickBindings: { node: Node, type: string, handler: () => void }[] = [];

    /** 向下注入的选中下标（内容节点 / 任意深度后代 inject 得到） */
    private _selectedIndexRef: Ref<number> = null;
    /** 向下注入的选中 key */
    private _selectedKeyRef: Ref<string> = null;

    /* ==================== 只读查询 ==================== */

    /** 当前选中的下标（-1 = 都没选） */
    public get selectedIndex(): number {
        return this._selectedIndex;
    }

    /** 当前选中的 key（没选中为 ''） */
    public get selectedKey(): string {
        return this._selectedIndex >= 0 ? (this._keys[this._selectedIndex] || "") : "";
    }

    /** tab 数量（= content 数量的上限） */
    public get tabCount(): number {
        return this._tabList.length;
    }

    /** 收集到的 tab 节点（只读视图，顺序即下标） */
    public get tabs(): readonly Node[] {
        return this._tabList;
    }

    /** 收集到的 content 节点（只读视图，顺序与 tab 对应） */
    public get contents(): readonly Node[] {
        return this._contentList;
    }

    /** 当前选中的 tab 节点（没选中为 null） */
    public get selectedTabNode(): Node {
        return this.getTabNode(this._selectedIndex);
    }

    /** 当前选中的 content 节点（没选中为 null） */
    public get selectedContentNode(): Node {
        return this.getContentNode(this._selectedIndex);
    }

    public getTabNode(index: number): Node {
        return (index >= 0 && index < this._tabList.length) ? this._tabList[index] : null;
    }

    public getContentNode(index: number): Node {
        return (index >= 0 && index < this._contentList.length) ? this._contentList[index] : null;
    }

    public getTabKey(index: number): string {
        return (index >= 0 && index < this._keys.length) ? (this._keys[index] || "") : "";
    }

    /** key → 下标（找不到返回 -1；key 大小写敏感） */
    public indexOfKey(key: string): number {
        return this._keys.indexOf(key);
    }

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        // ① 先把选中态 provide 出去：父组件的 onLoad 早于子组件（见 docs §4.1），
        //    所以子树在自己的 onInit 里就能 inject 到（Tabs 必须挂在 tab/content 的共同祖先上）
        this._selectedIndexRef = this.provide<Ref<number>>(TabsScopeKeys.SelectedIndex, ref(-1));
        this._selectedKeyRef = this.provide<Ref<string>>(TabsScopeKeys.SelectedKey, ref(""));

        // ② 收集节点 + 绑点击
        this.collectNodes();
        this.bindTabClicks();

        // ③ 应用初始选中态（会同步两个 ref，子树一 inject 就拿到正确的值）
        if (this.switchOnInit) {
            this.select(this.defaultIndex);
        } else {
            this.refresh();
        }
    }

    protected onShow(): void {
        // 每次显示按当前状态无条件刷一次：节点 active 有可能被外部动过，缓存复用也不会重跑 onInit
        if (this.resetOnShow) {
            this.select(this.defaultIndex);
        }
        this.refresh();
    }

    protected onDispose(): void {
        this.unbindTabClicks();
        this._tabList = [];
        this._contentList = [];
        this._tabItems = [];
        this._keys = [];
        this._selectedIndexRef = null;
        this._selectedKeyRef = null;
    }

    /* ==================== 对外：切换 ==================== */

    /**
     * 选中第 `index` 个 tab（`-1` = 全部取消选中，同时隐藏所有 content）
     * @returns 状态是否真的变了（越界返回 false 并 warn；下标没变且没传 `force` 也返回 false）
     */
    public select(index: number, options?: ITabSelectOptions): boolean {
        const opts = options || {};
        if (index < -1 || index >= this._tabList.length) {
            LogMgr.warn(`Tabs「${this.node.name}」select(${index}) 越界：共 ${this._tabList.length} 个 tab`);
            return false;
        }
        if (index === this._selectedIndex && !opts.force) {
            return false;
        }

        const prevIndex = this._selectedIndex;
        this._selectedIndex = index;
        const key = index >= 0 ? (this._keys[index] || "") : "";

        // 状态（真源）先落盘，再刷表现：表现层只读，不做任何决策
        if (this._selectedIndexRef) {
            this._selectedIndexRef.value = index;
        }
        if (this._selectedKeyRef) {
            this._selectedKeyRef.value = key;
        }

        this.applyTabStates();
        this.applyContentStates();

        if (!opts.silent) {
            this.onTabChanged(index, key, prevIndex);
            this.scope.emit(TabsScopeEvents.Changed, index, key, prevIndex);
            LogMgr.debug(`Tabs「${this.node.name}」切换：${prevIndex} → ${index}（${key || "无"}）`);
        }
        return true;
    }

    /** 按 key 选中（key 取 `TabItem.tabKey`，留空时是 tab 节点名） */
    public selectByKey(key: string, options?: ITabSelectOptions): boolean {
        const index = this.indexOfKey(key);
        if (index < 0) {
            LogMgr.warn(`Tabs「${this.node.name}」selectByKey('${key}') 找不到：现有 key = [${this._keys.join(", ")}]`);
            return false;
        }
        return this.select(index, options);
    }

    /** 按当前选中项把 tab 表现与 content 显隐重新写一遍（不改状态、不发事件） */
    public refresh(): void {
        this.applyTabStates();
        this.applyContentStates();
    }

    /** 重新收集节点（运行时动态增删了 tab 后调用；会重绑点击，旧绑定先摘干净） */
    public rebuild(): void {
        this.unbindTabClicks();
        this.collectNodes();
        this.bindTabClicks();
        // 收集结果变了，下标可能不再合法 → 夹回范围并重刷
        if (this._selectedIndex >= this._tabList.length) {
            this._selectedIndex = this._tabList.length - 1;
        }
        this.refresh();
    }

    /* ==================== 虚拟钩子（子类重写） ==================== */

    /** 选中项变化时调用（重写它做业务，比到处注册 scope.on 更直接） */
    protected onTabChanged(index: number, key: string, prevIndex: number): void {
    }

    /** 又点了一次已选中的 tab（状态没变）时调用 */
    protected onTabReselect(index: number, key: string): void {
    }

    /**
     * **表现接口（子类可重写）**：把第 `index` 个 tab 刷成 `selected`。
     *
     * 默认实现：转发给该 tab 节点上的 `TabItem`（**含它的子类**）—— 具体怎么画由 `TabItem.onSelectedChanged` 决定；
     * 节点上没有 `TabItem` 就什么都不做（框架不预设任何节点名 / 颜色 / 缩放约定）。
     *
     * 你的 tab 组件不是 `TabItem` 子类（比如是 `Toggle`、或自定义的 `MyTabBtn`）时，重写这里按自己的类型分发：
     * ```ts
     * protected applyTabSelected(tab: Node, index: number, selected: boolean): void {
     *     tab.getComponent(MyTabBtn)?.setSelected(selected);
     * }
     * ```
     *
     * ⚠ 重写时**不要** `super.applyTabSelected(...)` 之外再自己写一套 —— 这里是 tab 选中态的**唯一表现入口**
     *   （`select()` / `refresh()` / `onShow()` 都只走它）。
     */
    protected applyTabSelected(tab: Node, index: number, selected: boolean): void {
        const item = this._tabItems[index];
        if (item && item.isValid) {
            item.setSelected(selected);
        }
    }

    /* ==================== 内部：收集与绑定 ==================== */

    /** 收集 tab / content 节点，并缓存每个 tab 的 TabItem 与 key */
    private collectNodes(): void {
        const tabs = (this.tabNodes && this.tabNodes.length > 0)
            ? this.tabNodes.filter((n) => !!n)
            : (this.tabBarNode ? this.tabBarNode.children.slice() : []);
        const contents = (this.contentNodes && this.contentNodes.length > 0)
            ? this.contentNodes.filter((n) => !!n)
            : (this.contentBarNode ? this.contentBarNode.children.slice() : []);

        if (tabs.length === 0) {
            LogMgr.warn(`Tabs「${this.node.name}」没收集到 tab 节点：请拖 tabNodes，或拖 tabBarNode（会取它的子节点）`);
        }
        if (contents.length !== tabs.length) {
            LogMgr.warn(`Tabs「${this.node.name}」tab(${tabs.length}) 与 content(${contents.length}) 数量不一致：按下标一一对应，多出来的不会被切换`);
        }

        this._tabList = tabs;
        this._contentList = contents;
        this._tabItems = [];
        this._keys = [];

        tabs.forEach((node, index) => {
            // getComponent 认子类：挂 TabItem 的任意子类（不同样式的 tab 各种各的）都能被收集到
            const item = node.getComponent(TabItem);
            if (item) {
                // tab 下标由宿主写入；TabItem 自己不认识 Tabs，只被动接受
                item.tabIndex = index;
            }
            this._tabItems.push(item);
            this._keys.push(item && item.tabKey ? item.tabKey : node.name);
        });
    }

    /**
     * 绑点击：**优先认 Button**，没有 Button 才退回 `TOUCH_END`。
     * - Button 挂在 tab 子树任意一层都行 → 直接听**那个 Button 所在的节点**的 `CLICK`
     *   （Button 自己在自己的节点上 `emit('click')`，不听冒泡，最稳）
     * - 没有 Button → 听 tab 节点自己的 `TOUCH_END`（Cocos 3.8 的节点触摸事件 `bubbles = true`，
     *   命中子节点时也会沿父链冒泡上来，见引擎 `SceneGraph/NodeEventProcessor._handleTouchEnd`）
     */
    private bindTabClicks(): void {
        this._tabList.forEach((node, index) => {
            const handler = () => this.onTabClicked(index);
            const button = node.getComponent(Button) || node.getComponentInChildren(Button);
            if (button) {
                button.node.on(Button.EventType.CLICK, handler);
                this._clickBindings.push({ node: button.node, type: Button.EventType.CLICK, handler });
                return;
            }
            node.on(Node.EventType.TOUCH_END, handler);
            this._clickBindings.push({ node, type: Node.EventType.TOUCH_END, handler });
        });
    }

    private unbindTabClicks(): void {
        for (const binding of this._clickBindings) {
            if (binding.node && binding.node.isValid) {
                binding.node.off(binding.type, binding.handler);
            }
        }
        this._clickBindings.length = 0;
    }

    /** 点击回调：先向上通知，再决定「切换 / 取消选中 / 重选」 */
    private onTabClicked(index: number): void {
        const key = this._keys[index] || "";
        this.scope.emit(TabsScopeEvents.Click, index, key);

        if (index === this._selectedIndex) {
            if (this.allowSwitchOff) {
                this.select(-1);
                return;
            }
            // 状态没变：只回调，让内容有机会刷新（不重设 ref，避免无意义的响应式触发）
            this.onTabReselect(index, key);
            this.scope.emit(TabsScopeEvents.Reselect, index, key);
            return;
        }
        this.select(index);
    }

    /* ==================== 内部：刷表现 ==================== */

    /** 写 tab 的选中态：**只走 `applyTabSelected` 这一个表现入口**（默认转发给 TabItem，表现由业务决定） */
    private applyTabStates(): void {
        this._tabList.forEach((node, index) => {
            if (!node || !node.isValid) {
                return;
            }
            this.applyTabSelected(node, index, index === this._selectedIndex);
        });
    }

    /** 写 content 显隐（只留一个 active，并在切换前后通知实现了 ITabContent 的组件） */
    private applyContentStates(): void {
        this._contentList.forEach((node, index) => {
            if (!node || !node.isValid) {
                return;
            }
            const show = index === this._selectedIndex;
            const key = this._keys[index] || "";
            if (show) {
                if (!node.active) {
                    node.active = true;
                }
                // 激活之后再通知：此时内容自己的 onLoad/onEnable（UIWidget 的 onInit/onShow）已经跑完
                this.notifyContent(node, true, index, key);
            } else if (node.active) {
                // 关闭之前先通知：这时内容还在激活态，能安全访问自己的子节点
                this.notifyContent(node, false, index, key);
                node.active = false;
            }
        });
    }

    /** 广播 `ITabContent.onTabShow/onTabHide`（鸭子类型：节点上任意组件有这个方法就会被调） */
    private notifyContent(node: Node, show: boolean, index: number, key: string): void {
        const components = node.components;
        for (let i = 0; i < components.length; i++) {
            const component: any = components[i];
            const callback = show ? component.onTabShow : component.onTabHide;
            if (typeof callback !== "function") {
                continue;
            }
            try {
                callback.call(component, index, key);
            } catch (error) {
                LogMgr.warn(`Tabs「${this.node.name}」通知内容节点「${node.name}」的 ${show ? "onTabShow" : "onTabHide"} 出错：${error}`);
            }
        }
    }
}
