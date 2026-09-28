/**
 * TabItem —— `Tabs` 里**一个页签节点**的状态载体 + **表现接口**（挂在 `Tabs.tabNodes` 里的节点上）
 *
 * 框架**不规定**选中 / 未选中长什么样：换 Sprite、改 Label 颜色、切 `active`、缩放、播动画、
 * 联动 Toggle、换 Spine……都由你决定。你只需要重写一个方法：
 *
 * ```ts
 * // ① 写一个自己的 tab（不同样式的 tab 就写不同的子类，挂在各自的 tab 节点上）
 * @ccclass('TabItem_Func')
 * export class TabItem_Func extends TabItem {
 *     @property(Node) activeBg: Node = null;          // 高亮底图
 *     @property(Label) title: Label = null;
 *
 *     protected onSelectedChanged(selected: boolean): void {
 *         this.activeBg.active = selected;                              // 换底图
 *         this.title.color = selected ? Color.WHITE : new Color(153, 153, 153);
 *         // 想播动画就 tween(this.node).to(0.1, { scale: selected ? 1.1 : 1 }).start();
 *     }
 * }
 *
 * // ② 曲线救国：tab 组件不想继承 TabItem，就重写 Tabs.applyTabSelected 按自己的类型分发
 * ```
 *
 * ── 契约（很短，但都别破）──
 *   · `setSelected(bool)` **由 `Tabs` 调用**（Tabs 是选中态的唯一写入方），它内部转发给 `onSelectedChanged`
 *   · `onSelectedChanged` **可能被重复调用**（Tabs 的 `onShow` / `refresh()` 会整条重刷），实现要**幂等**；
 *     它**第一次**被调用发生在 `onLoad`（本基类里），也就是你自己 `onInit` **之后**，时序是安全的
 *   · 本组件**不认识 `Tabs`**：不 import、不持有引用、**不自己绑点击**（点击统一由 Tabs 绑，
 *     你在子类里再 `on` 一次就会点一下切两次）
 *   · 除了表现，还想在 tab 上做别的事（红点 / 锁定态 / 加载图标）→ 照常用 `onInit/onShow/onHide/onDispose`
 *
 * ⚠ 继承 `UIWidget` 就**不要**加 `@uiview`，也不要重写 `onLoad/onEnable/onDisable/onDestroy`
 *   （本基类确实重写了 `onLoad`，那是为了把首次表现推迟到 `onInit` 之后；子类照旧只用 4 个钩子）。
 */

import { _decorator } from "cc";
import { UIWidget } from "./UIWidget";

const { ccclass, property } = _decorator;

@ccclass("TabItem")
export class TabItem extends UIWidget {

    /** 业务标识，可空。留空时用**节点名**当 key（`Tabs.selectByKey` 靠它定位） */
    @property({ type: String, tooltip: "业务标识，可空；留空时用节点名当 key" })
    public tabKey: string = "";

    /** 本 tab 在 `Tabs` 里的下标（Tabs 收集时写入；-1 = 还没被任何 Tabs 接管） */
    public tabIndex: number = -1;

    /** 当前是否选中（**只读语义**：唯一写入方是 `Tabs`，表现请写在 `onSelectedChanged` 里） */
    public get selected(): boolean {
        return this._selected;
    }

    private _selected: boolean = false;

    /**
     * 是否已跑过 `onLoad`（= 子类自己的 `onInit` 已经跑完）。
     * 存在的理由：`Tabs` 在**它自己的 `onInit`**（父组件的 onLoad，**早于**子组件的 onLoad，见
     * `docs/UI框架使用说明.md` §4.1）里就会调 `setSelected`，那时本组件的 `onInit` 还没跑 ——
     * 直接把表现抛给子类，会出现「你的 onSelectedChanged 在 onInit 之前被调」这种脏时序
     * （hook 里用了 onInit 里建的东西就会报错，而且异常是从父组件的 onLoad 里抛出去的，会打断整条激活链）。
     */
    private _loaded: boolean = false;

    /**
     * ⚠ **子类不要重写它**（和 UIWidget 对 onLoad 的规则一致）：这里只是把「首次表现」推迟到 `onInit` 之后。
     */
    public onLoad(): void {
        super.onLoad();                 // scope + 子类的 onInit()
        this._loaded = true;
        // 补画一次当前选中态：保证 onSelectedChanged 第一次被调用时，子类 onInit 里的东西都已就绪
        this.onSelectedChanged(this._selected);
    }

    /**
     * 写入选中态 —— **由 `Tabs` 调用**，写完立刻交给 `onSelectedChanged` 做表现。
     * 幂等：同值重复调用也会再走一遍表现（Tabs 靠这个在 `refresh()` 时重刷）。
     * 若本组件还没 `onLoad`（节点还没被激活），只先记住状态，`onLoad` 时补画。
     */
    public setSelected(selected: boolean): void {
        this._selected = selected;
        if (!this._loaded) {
            return;
        }
        this.onSelectedChanged(selected);
    }

    /**
     * **表现接口（子类重写）**：把当前选中态画出来。
     *
     * 基类默认**什么都不做** —— 框架不预设任何「显示 active_bg / 改文字颜色」之类的约定，
     * 表现 100% 由业务决定（这也是它不叫 `applyDefaultVisual` 的原因）。
     *
     * @param selected 当前是否选中
     */
    protected onSelectedChanged(selected: boolean): void {
    }
}
