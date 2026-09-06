import { effect, ReactiveEffectOptions, ReactiveEffectRunner, stop, watch, WatchCallback, 
    WatchEffect, WatchHandle, WatchOptions, WatchSource } from "../reactivity/index";
import { _decorator, Component, error, tween, Vec3,Node } from "cc";
import { UIComponent } from "./UIComponent";
import BaseEventMgr from "../event/BaseEventMgr";
import UIMgr from "./UIMgr";
import { BaseCtl } from "./BaseCtl";
import { getConstructorName } from "../utils/TypeUtil";

// View.ts
const { ccclass, property } = _decorator;

@ccclass("BaseView")
export default class BaseView<M,C> extends UIComponent {

    /**视图实例的唯一标识符 */
    public uid:number = 0
    /**视图实例对应的数据 */
    public dataModel:M = null
    /**视图实例对应的控制器 */
    public controller:C = null;
    /**视图实例对应的事件管理器 */
    public eventMgr:BaseEventMgr = new BaseEventMgr()
    public node:Node = null;
    // 默认动画时长
    private static DEFAULT_ANIM_DURATION: number = 0.3;

    // 是否已初始化
    private _isInitialized: boolean = false;
    private effectsRefs:ReactiveEffectRunner[] = []
    private watcherHandles:WatchHandle[] = []
    protected animationShowFunc:()=>void = null;
    protected animationCloseFunc:()=>void = null;
    public useAnimation = false
    public showArgs:any[] = []

    public get viewName(){
        return this.node.name
    }

    protected __preload(): void {
        super.__preload();
        //初始化数据模型
        let info = UIMgr.viewInfos[Object.getPrototypeOf(this).constructor.name];
        if(info && info.dataModel) {
            this.dataModel = new info.dataModel() as M;
        }
        if(info && info.controller) {
            if(!BaseCtl.prototype.isPrototypeOf(info.controller.prototype)){
                throw new Error("view的controller必须是BaseCtl的子类")
            }
            let ctrl = new info.controller() as BaseCtl<any>;
            ctrl.view = this;
            ctrl.initDo()
            this.controller = ctrl as C;
        }
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

    /**监听数据，如果是监听整个对象，则直接传入响应式对象，默认是deep的，递归处理内部属性，如果是监听对象的属性，则传入函数，函数里调用整个这个的值，如果属性是ref，需要使用()=>xx.value*/
    protected watchData(source: WatchSource | WatchSource[] | WatchEffect | object, cb?: WatchCallback | null, options?: WatchOptions): WatchHandle {
        let wachHandle = watch(source, cb, options)
       this.watcherHandles.push(wachHandle)
       return wachHandle;
    }
    //取消监听
    protected unWatchData(wacher: WatchHandle) {
        let index = this.watcherHandles.indexOf(wacher)
        if(index==-1){
            return
        }
        this.watcherHandles.splice(index,1)
        wacher.stop()
        
    }
    // protected addEffect<T = any>(fn: () => T, options?: ReactiveEffectOptions){
    //     this.effectsRefs.push(effect(fn,options))
    // }

    // 显示UI（带默认动画）
    public async showView(...args: any[]) {
        if(args){
            this.showArgs = args
        }
        if (!this._isInitialized) {
            this._isInitialized = true;
            // this.nodeBindHandle();
            this.init();
        }
        this.node.active = true;
        this.watcherHandles.forEach(watcher=>watcher.resume())
        this.show();
        if(this.useAnimation){
            await this.playShowAnimation();
        }
    }

    // 隐藏UI（带默认动画）
    public async closeView() {
        this.close();
        this.watcherHandles.forEach(watcher=>watcher.pause())
        this.effectsRefs.forEach(e=>stop(e))
        this.effectsRefs = []
        if(this.useAnimation){
            await this.playCloseAnimation();
        }
        this.node.active = false;
    }
    public deleteView(){
        this.watcherHandles.forEach(watcher=>watcher.stop())
        this.watcherHandles = []
        this.delete()
        this.dataModel = null
        this.controller = null

    }
    protected  getModelKey():string{
        throw new error("modelkey 方法未实现："+getConstructorName(this))
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