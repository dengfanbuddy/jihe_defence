/**
 * UIWidget —— 场景预制件里**内嵌**的 UI 页面 / 小组件的基类
 *
 * 与 `BaseView` 的区别（很重要，别用错）：
 *   - `BaseView`：由 **UIManager** 管理的视图（挂在 `scenes`/`views`/`popup`/... 层节点下），
 *     必须配 `@uiview`，生命周期（init/show/close/delete）由 `UIManager.showUI/closeUI` 驱动。
 *   - `UIWidget`：**不经过 UIManager** 的 UI（战斗预制件 `Scene_Game_Stage` 里的 `View_Game_Stage`
 *     及其内部的面板、列表项……），生命周期就是 Cocos 原生的 onLoad/onEnable/onDisable/onDestroy。
 *     **不要给它加 `@uiview`**：注册本身会成功，`UIManager.showUI` 于是照常实例化预制件并把它 push 进栈，
 *     最后在 `await view.showView(...)` 处抛 `TypeError: view.showView is not a function`
 *     （`showView/closeView/deleteView` 只定义在 `BaseView` 上），并留下挂在层节点上的脏节点。
 *
 * 继承了 `UIComponent`，因此每个 UIWidget 天然是 `@bind` / `@bindValue` 的**作用域边界**
 * （父组件的 @bind 不会捅进子组件内部的节点），同时自带 `this.scope`（provide/inject + watch 回收 + 局部事件）。
 *
 * ── 用法 ──
 * ```ts
 * @ccclass('HeroSelectPanel')
 * export class HeroSelectPanel extends UIWidget {
 *     protected onInit(): void {          // 只跑一次（对应 onLoad）
 *         this.selectedId = this.provide('heroSelect:selectedId', ref(0))
 *         this.scope.watch(() => this.battleStore.gold, () => this.refreshGold())
 *         this.scope.on('heroSelect:picked', this.onPicked, this)
 *     }
 *     protected onShow(): void { }        // 每次显示（对应 onEnable）
 *     protected onHide(): void { }        // 每次隐藏（对应 onDisable）
 *     protected onDispose(): void { }     // 销毁（对应 onDestroy）
 * }
 * ```
 *
 * ⚠ 子类**不要**重写 onLoad / onEnable / onDisable / onDestroy（会覆盖掉本基类的 scope 生命周期），
 *   需要这些时机就用 onInit / onShow / onHide / onDispose。
 */

import { error } from "cc";
import { UIComponent } from "./UIComponent";

export class UIWidget extends UIComponent {

    public onLoad(): void {
        // 建作用域句柄（惰性 getter 也在这里被提前触发，保证 provide 早于子组件的 onLoad）
        this.scope;
        this.onInit();
    }

    public onEnable(): void {
        this.scope.resume();
        this.onShow();
    }

    public onDisable(): void {
        this.onHide();
        this.scope.pause();
    }

    public onDestroy(): void {
        // ⚠ onDispose 里**绝不允许把异常抛出去**：onDestroy 由引擎在 `director.tick` 的
        // `CCObject._deferredDestroy()` 里逐个调用，抛异常会让**销毁队列不清空**（下一帧从同一个对象
        // 重新抛，控制台每帧刷同一条）并且此后**每帧都不再绘制**（该循环排在提交渲染之前）→ 画面永久卡死。
        // 子类钩子写错只报错、不陪葬整个引擎的销毁流程。详见 AGENTS.md「表现层 onDestroy」一条。
        try {
            this.onDispose();
        } catch (err) {
            error(`[UIWidget] ${this.constructor.name}.onDispose 抛异常（已吞掉，避免堵死引擎销毁队列）`, err);
        }
        // UIComponent.onDestroy 里会统一 dispose 作用域（停 watcher、清事件、撤销 provide）
        super.onDestroy();
    }

    /** 生命周期钩子：只执行一次（对应 onLoad）—— provide / 注册 scope 事件 / 建 watcher 放这里 */
    protected onInit(): void {
    }

    /**
     * 生命周期钩子：每次显示（对应 onEnable）。
     * 响应式数据在 resume 时会补播，但**非响应式输入**（外部直接赋值的普通字段，如 item 的 heroId）
     * 的变化不会被感知 —— 所以这里要按当前状态无条件刷一次。
     */
    protected onShow(): void {
    }

    /** 生命周期钩子：每次隐藏（对应 onDisable）—— watcher 的暂停由基类统一处理 */
    protected onHide(): void {
    }

    /** 生命周期钩子：销毁（对应 onDestroy）—— 摘掉节点事件等收尾工作放这里 */
    protected onDispose(): void {
    }
}
