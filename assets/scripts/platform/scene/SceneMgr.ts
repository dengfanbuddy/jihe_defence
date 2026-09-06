// SceneManager.ts
import { _decorator, director, Director, Scene, Node, ProgressBar, Label, SceneAsset, log, warn, sys } from 'cc';
import { SceneInfo } from './SceneInfo';
const { ccclass, property } = _decorator;

@ccclass('SceneMgr')
export class SceneMgr {

    private static instance: SceneMgr = null;
    private defaultScene:string = null;
    private nowScene:string = null;
    private sceneStack: string[] = [];
    private sceneInfoFunc:(sceneName:string)=>SceneInfo = null;
    private beforEnter:()=>void = null;
    private updateProgress:(progress:number)=>void = null;
    private afterEnter:()=>void = null;
    private enterFail:()=>void = null;

    public static get ins(): SceneMgr {
        if (!this.instance) {
            this.instance = new SceneMgr();
        }
        return this.instance;
    }

    private constructor() {
        // 私有构造函数，确保单例模式
    }


    public setSceneInfoFun(func:(sceneName:string)=>SceneInfo){
        this.sceneInfoFunc  = func
    }
    public setBeforeEnterFun(func:()=>void){
        this.beforEnter  = func
    }
    public setUpdateProgressFun(func:(progress:number)=>void){
        this.updateProgress  = func
    }
    public setAfterEnterFun(func:()=>void){
        this.afterEnter  = func
    }

    public setEnterFailFun(func:()=>void){
        this.enterFail  = func
    }
    //有加载界面
    public enterWithProgressScene(sceneName: string,afterEnter?:()=>void): void {

    }
    /**
     * 进入场景
     * @param sceneName 场景名称
     * @param isMainScene 是否为主场景
     */
    public enterScene(sceneName: string,afterEnter?:()=>void): void {
        let sceneInfo = null
        if(this.sceneInfoFunc){
            sceneInfo = this.sceneInfoFunc(sceneName)
        }
        if(!sceneInfo){
            throw new Error("无法获取场景信息，场景名："+sceneName)
        }

        //TODO 关闭其他ui显示加载ui
        // 显示加载UI
        this.beforEnter?.()
        // 加载场景
        director.preloadScene(sceneName, (completedCount: number, totalCount: number, item: any) => {
            // 更新加载进度
            const progress = completedCount / totalCount;
            this.updateProgress?.(progress)
        }, (error: Error | null, scene: SceneAsset) => {
            if (error) {
                this.enterFail?.()
                // this.exitScene()
                console.error(`场景加载失败: `,error);
                //尝试退到之前的场景
                let preScene = this.sceneStack[this.sceneStack.length-1]
                if(preScene==sceneName){
                    //尝试退到默认场景
                    if(!this.defaultScene){//没有默认场景
                        throw new Error("进入场景失败，没有默认场景，无法进入默认场景！");
                    }
                    if(this.defaultScene==sceneName){
                        throw new Error("进入默认场景失败！");
                    }
                    this.enterScene(this.defaultScene)
                    return
                }
                let info = this.sceneInfoFunc(preScene)
                if(!info.isMainScene){
                    this.enterScene(this.defaultScene)
                }else{
                    this.enterScene(preScene)
                }
                return;
            }

            // 先缓存旧场景引用（loadScene 前获取）
            let old = director.getScene()
            let oldSceneName = old ? old.name : null;

            // 先加载新场景
            director.loadScene(sceneName)

            // 更新场景栈和当前场景
            if (sceneInfo.isMainScene) {
                this.sceneStack = [];
            }
            this.sceneStack.push(sceneName);
            this.nowScene = sceneName

            // 释放旧场景资源
            if (oldSceneName) {
                let oldScene = this.sceneInfoFunc(oldSceneName)
                if(oldScene&&!oldScene.isMainScene){
                    old.destroy()
                }
            }
            sys.garbageCollect()

            // 再触发回调（此时 director.getScene() 已返回新场景）
            this.afterEnter?.()
            afterEnter?.()

            console.log(`进入场景: ${sceneName}`);
        });

    }

    /**
     * 退出当前场景，返回上一个场景
     */
    public exitScene(): void {
        let info = this.sceneInfoFunc(this.nowScene)
        if(info.isMainScene){
            warn("当前已经是主场景了，无法继续退出场景："+this.nowScene)
            return
        }

        // 移除当前场景
        this.sceneStack.pop();

        // 获取上一个场景
        const previousScene = this.sceneStack[this.sceneStack.length - 2];


        this.enterScene(previousScene,()=>{
            this.sceneStack.pop()
            this.sceneStack.pop()
        })
    }



    /**
     * 获取当前场景名称
     */
    public getCurrentSceneName(): string {
        return this.sceneStack[this.sceneStack.length - 1];
    }

    /**
     * 清空场景栈
     */
    public clearSceneStack(): void {
        this.sceneStack = [];
    }
}