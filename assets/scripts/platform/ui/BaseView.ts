import { _decorator, tween, Vec3, Node } from "cc";
import { UIComponent } from "./UIComponent";

// View.ts
const { ccclass, property } = _decorator;

/**
 * UIManager 管理的视图基类（场景 / 视图 / 弹窗，需配 `@uiview` 注册）。
 *
 * 生命周期由 `UIManager.showUI/closeUI` 驱动，与作用域（继承自 UIComponent 的 `this.scope`）一一对应：
 *   showView()   → `scope.resume()`   （显示）
 *   closeView()  → `scope.pause()`    （隐藏/进缓存，**不销毁**）
 *   deleteView() → `scope.dispose()`  （真销毁，停 watcher + 清局部事件 + 撤销 provide）
 *
 * 因此**场景本身就是整棵内嵌 UI 子树的 provide 宿主**：`Scene_Game_Stage` 里
 * `this.scope.provide(key, value)`，其预制件内部任意深度的 `UIWidget`（含 `View_Game_Stage`）
 * 都能 `inject(key)` 到 —— 注意要在早于子节点 onLoad 的时机提供，否则消费方改用惰性注入（用到时才 inject）。
 * 详见 UIScope.ts。
 *
 * 内嵌在场景预制件里、不经 UIManager 的 UI 请继承 `UIWidget`，不要用本类。
 *
 * 视图内的 watcher 用 `this.scope.watch(...)`：随视图显示/隐藏自动 resume/pause，销毁时自动回收。
 *
 * 注：原有的 `dataModel` / `controller`（BaseCtl）MVC 已删除 —— 视图私有状态用继承来的
 * `this.scope` / `this.provide`，业务逻辑放 store（`useBattleStore`）或纯 TS 系统（BattleContext 等）。
 */
@ccclass("BaseView")
export default class BaseView extends UIComponent {

    /**视图实例的唯一标识符 */
    public uid:number = 0
    public node:Node = null;
    // 默认动画时长
    private static DEFAULT_ANIM_DURATION: number = 0.3;

    // 是否已初始化
    private _isInitialized: boolean = false;
    protected animationShowFunc:()=>void = null;
    protected animationCloseFunc:()=>void = null;
    public useAnimation = false
    public showArgs:any[] = []

    public get viewName(){
        return this.node.name
    }

    // 生命周期：初始化（第一次显示时调用）
    protected init() {
        // 子类重写
    }

    // 生命周期：显示（每次显示时调用）
    protected show() {
        // 子类重写
    }

    // 生命周期：关闭（隐藏时调用）
    protected close() {
        // 子类重写
    }

    // 生命周期：销毁（销毁时调用）
    protected delete(){

    }

    // 显示UI（带默认动画）
    public async showView(...args: any[]) {
        if(args){
            this.showArgs = args
        }
        if (!this._isInitialized) {
            this._isInitialized = true;
            this.init();
        }
        this.node.active = true;
        // 作用域随视图一起恢复（UIManager 的 show/close/delete 与 scope 的 resume/pause/dispose 一一对应）
        this.scope.resume();
        this.show();
        if(this.useAnimation){
            await this.playShowAnimation();
        }
    }

    // 隐藏UI（带默认动画）
    public async closeView() {
        this.close();
        // 只暂停、不销毁：closeUI 默认会把视图放进缓存（节点仅 active=false），复用时不再走 onLoad，销毁作用域就废了
        this.scope.pause();
        if(this.useAnimation){
            await this.playCloseAnimation();
        }
        this.node.active = false;
    }
    public deleteView(){
        // 真销毁（UIManager 传 destroy:true 或缓存过期）时才销毁作用域
        this.scope.dispose();
        this.delete()
    }

    // 播放显示动画
    private async playShowAnimation(): Promise<void> {
        if(this.animationShowFunc){
            return this.animationShowFunc?.()
        }
        this.node.setScale(new Vec3(0, 0, 1)) ;
        return new Promise((resolve) => {
            tween(this.node)
                .to(BaseView.DEFAULT_ANIM_DURATION, { scale: new Vec3(1,1,1) }, { easing: "linear" })
                .start();
        });
    }

    // 播放关闭动画
    private async playCloseAnimation(): Promise<void> {
        if(this.animationCloseFunc){
            return this.animationCloseFunc?.()
        }
        return new Promise((resolve) => {
            tween(this.node)
                .to(BaseView.DEFAULT_ANIM_DURATION, { scale: new Vec3(0,0,0) }, { easing: "linear" })
                .start();
        });
    }
}
