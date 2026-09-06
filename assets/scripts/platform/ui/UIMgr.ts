// UIManager.ts

import { _decorator, Camera, Canvas, Component, director, error, game, instantiate, Layers, Node, Prefab, resources, screen, UITransform, Vec2, Vec3, view, warn, Widget } from "cc";

import BaseView from "./BaseView";
import { LogMgr } from "../log/LogMgr";
import { isConstructor } from "../utils/TypeUtil";
import { Tips } from "./Tips";
import { ViewInfo } from "./ViewInfo";


const { ccclass } = _decorator;
@ccclass('UIMgr')
export default class UIMgr extends Component {

    private static instance: UIMgr = null;
    private viewUid = 0
    // // UI层级节点
    // private mainLayer: Node = null; // Main层
    // private popLayer: Node = null; // Pop层
    // private tipsLayer: Node = null; // Tips层
    // private marqueeLayer: Node = null; // 走马灯层
    // private topLayer: Node = null; // 走马灯层

    // // UI栈
    // private mainStack: View[] = []; // Main层栈
    // private popStack: View[] = []; // Pop层栈
    // private tipsStack: View[] = []; // Tips层栈
    // private marqueeStack: View[] = []; // 走马灯层栈
    // private topStack: View[] = []; // 走马灯层栈

    layers: Map<string, Node> = new Map()
    layerStacks: Map<string, BaseView<any, any>[]> = new Map()
    globalBeforeShowFun: (layerNode: Node, showView: BaseView<any, any>, stack: BaseView<any, any>[]) => void = null;
    canvas: Canvas = null
    camera: Camera = null



    public static get ins(): UIMgr {
        if (!this.instance) {
            LogMgr.err("还未初始化就进行获取！")
        }
        return this.instance;
    }

    private nextId() {
        let id = this.viewUid++;
        return id
    }

    //ui预制件的根目录，可以根据名找到预制件
    prefabRootPath = ""
    static viewInfos: {
        [name: string]: ViewInfo
    } = {}

    // static viewInfos2:{
    //     [name:string]:ViewInfo
    // }={}

    tipsLayerName: string = ""
    tipsPrefab: Prefab = null


    public static init(rootNode?: Node, layerNames?: string[], tipsLayerName?: string, tipsPrefab?: Prefab) {
        if (!rootNode) {
            throw error("UI根节点为null，无法进行初始化")
            // rootNode = new Node("UIRoot")
            // rootNode.addComponent(UITransform)
            // rootNode.addComponent(Canvas)

        }

        if (!layerNames) {
            layerNames = [
                // DefaultLayer.MainLayer,
                // DefaultLayer.PopLayer,
                // DefaultLayer.TipsLayer,
                // DefaultLayer.MarqueeLayer,
                // DefaultLayer.TopLayer,
            ]
        }

        let mgr = rootNode.addComponent(UIMgr)
        rootNode.setPosition(0, 0, 0)
        UIMgr.instance = mgr;
        mgr.canvas = rootNode.getComponent(Canvas)
        mgr.camera = rootNode.getComponentInChildren(Camera)
        mgr.initUICamera();
        // mgr.adjustToScreen();
        mgr.fullSizeViewNode(rootNode)
        // 获取屏幕实际分辨率
        // let size = screen.windowSize;
        // let screenWidth: number = size.width / view.getScaleX();
        // let screenHeight: number = size.height / view.getScaleY();
        // console.log("屏幕实际分辨率", screenWidth, screenHeight);
        // let size = view.getVisibleSize();
        // console.log("屏幕实际分辨率", size.width, size.height);
        // rootNode
        //   .getComponent(UITransform)
        //   .setContentSize(size.width, size.height);
        // rootNode.getComponent(Widget).updateAlignment()

        if (layerNames && layerNames.length > 0) {
            let tasks = []
            let layerNodes = new Map<string, Node>()
            layerNames.forEach((layerName) => {
                if (mgr.layers.has(layerName)) {
                    throw error("ui 层级重复：" + layerName)
                    return
                }
                tasks.push(new Promise((r, j) => {
                    let layerIns = UIMgr.ins.createLayer(layerName)
                    layerNodes.set(layerName, layerIns)
                    r(layerName)
                    // resources.load<Prefab>("./LayerPrefab.prefab",(e,data)=>{
                    //     if(e){
                    //         error("加载层级预制件失败："+layerName)
                    //         j(e)
                    //         return
                    //     }
                    //     let layerIns = instantiate(data)
                    //     layerIns.name = layerName
                    //     layerNodes.set(layerName,layerIns)
                    //     r(layerName)
                    // })
                }))

            })
            Promise.all(tasks).then(() => {
                layerNames.forEach((layerName) => {
                    let layerNode = layerNodes.get(layerName)
                    let widget = layerNode.getComponent(Widget)
                    layerNode.setParent(rootNode)
                    layerNode.layer = rootNode.layer
                    // 更新 Widget
                    widget.updateAlignment();
                    mgr.layers.set(layerName, layerNode)
                    mgr.layerStacks.set(layerName, [])
                })
                if (tipsLayerName) {
                    let tipsLayerNode = mgr.layers.get(tipsLayerName)
                    if (!tipsLayerNode) {
                        LogMgr.err("tips 层级不存在：" + tipsLayerName)
                    }
                    mgr.tipsLayerName = tipsLayerName
                    if (tipsPrefab) {
                        mgr.tipsPrefab = tipsPrefab
                    } else {
                        LogMgr.warn("tipsLayerName 设置了，但tipsPrefab未设置，无法显示tips")
                    }
                }
                director.addPersistRootNode(rootNode)
            }).catch((e) => {
                error("创建层级预制件失败：" + e)
            })
            return
        }
        rootNode.children.forEach((node) => {
            let nName = node.name
            if (mgr.layers.has(nName)) {
                warn("ui 层级重复：" + nName)
                return
            }
            mgr.layers.set(nName, node)
            mgr.layerStacks.set(nName, [])
        })
        if (tipsLayerName) {
            let tipsLayerNode = mgr.layers.get(tipsLayerName)
            if (!tipsLayerNode) {
                LogMgr.err("tips 层级不存在：" + tipsLayerName)
            }
            mgr.tipsLayerName = tipsLayerName
            if (tipsPrefab) {
                mgr.tipsPrefab = tipsPrefab
            } else {
                LogMgr.warn("tipsLayerName 设置了，但tipsPrefab未设置，无法显示tips")
            }
        }
        director.addPersistRootNode(rootNode)
        return
    }

    // 创建层级节点
    private createLayer(name: string): Node {
        const layer = new Node();
        layer.name = name;
        layer.setPosition(new Vec3(0, 0, 0))
        let widget = layer.addComponent(Widget)
        widget.left = 0;
        widget.right = 0;

        // 设置 Widget 的 top 和 bottom 为 0，实现垂直布满
        widget.top = 0;
        widget.bottom = 0;

        // 设置 Widget 的对齐方式为水平和垂直都对齐
        widget.isAlignLeft = true;
        widget.isAlignRight = true;
        widget.isAlignTop = true;
        widget.isAlignBottom = true;
        widget.alignMode = 1;
        // 更新 Widget
        widget.updateAlignment();
        layer.setParent(this.node); // 将层级节点作为UIManager的子节点
        return layer;
    }

    // 显示UI参数： 名字 是否使用pop动画 参数 打开后回调
    // public async showUI(uiName: string, afterShowCb?: () => void, ...args: any[]) {
    //     const uiInfo = this.viewInfos[uiName]
    //     if (!uiInfo) {
    //         error(`view info not found for: ${uiName}`);
    //         return;
    //     }
    //     if(!this.layers.has(uiInfo.layer)){
    //         error("未知ui层级："+uiInfo.layer)
    //         return
    //     }
    //     let stack = this.layerStacks.get(uiInfo.layer)
    //     let exist = null;
    //     if(uiInfo.single){
    //         exist = stack.find(v=>(v as Component).name==uiName)
    //     }
    //     let view:BaseView<any> = null;
    //     if(!exist){
    //         // 加载预制件
    //         const uiNode = await this.loadUIPrefab(uiInfo.prefabPath);
    //         if (!uiNode) {
    //             error(`Failed to load UI: ${uiName}`);
    //             return;
    //         }

    //         // 添加UI脚本
    //         let cmp = uiNode.getComponent(uiInfo.script);
    //         if (!cmp) {
    //             cmp = uiNode.addComponent(uiInfo.script) as BaseView<any>;
    //         }
    //         view = cmp as BaseView<any>;
    //         // view.viewName=uiName
    //     }
    //     stack.push(view)
    //     let layerNode= this.layers.get(uiInfo.layer)
    //     this.globalBeforeShowFun?.(layerNode,view,stack)
    //     view.node.setParent(layerNode)
    //     let widget = view.getComponent(Widget)
    //     if(widget){
    //         widget.updateAlignment()
    //     }
    //     // 显示UI
    //     await view.showView(...args);
    //     // 执行回调函数
    //     afterShowCb?.();
    // }
    //TODO 传入类型，传入实例，传入实例id进行显示
    public async showUI<T extends BaseView<any, any>>(viewType: new (...args: any[]) => T, afterShowCb?: () => void, ...args: any[]) {
        let viewName = viewType.name
        if (!viewName) {
            viewName = viewType.prototype.name
        }
        let uiInfo = UIMgr.viewInfos[viewName]

        if (!uiInfo) {
            LogMgr.err(`view info not found for: ${viewType.name}`);
            return;
        }
        if (!this.layers.has(uiInfo.layer)) {
            LogMgr.err("未知ui层级：" + uiInfo.layer)
            return
        }
        let stack = this.layerStacks.get(uiInfo.layer)
        let view: BaseView<any, any> = null;
        if (uiInfo.single) {
            let pos = 0;
            for (let index = 0; index < stack.length; index++) {
                const element = stack[index];
                if (element.viewName == viewName) {
                    view = element
                    pos = index;
                    break
                }
            }
            if (view) {
                stack.splice(pos, 1)
            }
        }

        if (!view) {
            // 加载预制件
            let uiNodePrefab = await this.loadUIPrefab(uiInfo.prefabPath);
            if (!uiNodePrefab) {
                error(`Failed to load UIPrefab: ${uiInfo.prefabPath}`);
                return;
            }
            let uiNode = instantiate(uiNodePrefab);
            // 添加UI脚本
            view = uiNode.getComponent(viewType);
            if (!view) {
                view = uiNode.addComponent(viewType) as T;
            }
            view.uid = this.nextId()
            // view.viewName=uiName
        }
        stack.push(view)
        let layerNode = this.layers.get(uiInfo.layer)
        this.globalBeforeShowFun?.(layerNode, view, stack)
        view.node.setParent(layerNode)
        let widget = view.getComponent(Widget)
        if (widget) {
            widget.updateAlignment()
        }
        // 显示UI
        await view.showView(...args);
        LogMgr.debug("显示视图：" + viewName + " uid:" + view.uid)
        // 执行回调函数
        afterShowCb?.();
        return view
    }
    public async closeUI<T extends BaseView<any, any>>(view: T | (new (...args: any[]) => T), options?: {
        cb?: () => void,
        destroy?: boolean
    }): Promise<void> {
        let toClose: BaseView<any, any>[] = [];
        let viewType: new (...args: any[]) => T = null
        let closeByType = false
        if (isConstructor(view)) {
            closeByType = true
            viewType = view as new (...args: any[]) => T
        } else {
            let instance = view as BaseView<any, any>
            viewType = instance.constructor as new (...args: any[]) => T
        }
        let viewName = viewType.name
        if (!viewName) {
            viewName = viewType.prototype.name
        }
        let uiInfo = UIMgr.viewInfos[viewName]

        if (!uiInfo) {
            LogMgr.err(`关闭UI失败！没有找到视图数据: ${viewType.name}`);
            return;
        }
        if (!this.layers.has(uiInfo.layer)) {
            LogMgr.err("未知ui层级：" + uiInfo.layer + " 无法关闭视图：" + viewName)
            return
        }
        let stack = this.layerStacks.get(uiInfo.layer)
        if (!stack) {
            return
        }
        if (closeByType) {
            stack.forEach((v) => {
                if (v.viewName == viewName) {
                    toClose.push(v)
                }
            })
        } else {
            let index = stack.indexOf(view as BaseView<any, any>)
            if (index!= -1) {
                toClose.push(stack[index])
            }
        }
        if (toClose.length === 0) {
            return
        }
        toClose.forEach((v) => {
            v.closeView()
            LogMgr.debug("关闭视图：" + v.name + " uid:" + v.uid)
            if (options && options.destroy) {
                v.deleteView()
                LogMgr.debug("销毁视图：" + v.name + " uid:" + v.uid)
                let index = stack.indexOf(v)
                if (index !== -1) {
                    stack.splice(index, 1)
                }
            }
        })
        if (options) {
            options.cb?.()
        }
    }

    // 加载UI预制件
    private async loadUIPrefab(prefabPath: string): Promise<Node> {
        //TODO 使用BundMgr
        return new Promise((resolve, reject) => {
            resources.load(prefabPath, Prefab, (err, prefab) => {
                if (err) {
                    error(err);
                    resolve(null);
                } else {
                    const uiNode = instantiate(prefab);
                    resolve(uiNode);
                }
            });
        });
    }
    public async canShowTips() {
        if (!this.tipsLayerName) {
            LogMgr.err("tips 层级未设置")
            return false
        }
        if (this.tipsPrefab == null) {
            this.tipsPrefab = await new Promise((r, j) => {
                resources.load("prefab/ui/compoents/tips", (e, data) => {
                    if (e) {
                        r(null)
                        LogMgr.err("加载tips预制件失败！", e)
                        return
                    }
                    r(data as Prefab)
                })
            })
        }
        if (this.tipsPrefab == null) {
            return false;
        }
        return true
    }
    // public async  showErrorTips(tips:string){
    //     let canDo = await this.canShowTips()
    //     if(!canDo){
    //         return
    //     }
    //     if(this.tipsPrefab==null){
    //         return
    //     }
    //     let tipsIns = instantiate(this.tipsPrefab)
    //     let tipsCom = tipsIns.getComponent(Tips)
    //     tipsCom.setErrorText(tips)
    //     this.tipsLayerNode.addChild(tipsIns)
    // }
    // public async  showSuccessTips(tips:string){
    //     let canDo = await this.canShowTips()
    //     if(!canDo){
    //         return
    //     }
    //     if(this.tipsPrefab==null){
    //         return
    //     }
    //     let tipsIns = instantiate(this.tipsPrefab)
    //     let tipsCom = tipsIns.getComponent(Tips)
    //     tipsCom.setSuccessText(tips)
    //     this.tipsLayerNode.addChild(tipsIns)
    // }
    public async showTips(tips: string) {
        let canDo = await this.canShowTips()
        if (!canDo) {
            return
        }
        if (this.tipsPrefab == null) {
            return
        }
        let layer = this.layers.get(this.tipsLayerName)
        let tipsNode = null;
        let children = layer.children
        for (let index = 0; index < children.length; index++) {
            let element = children[index];
            if (!element.active) {
                tipsNode = element;
                break;
            }
        }
        if (!tipsNode) {
            //TODO 从缓存中取
            let tipsIns = instantiate(this.tipsPrefab)
            let tipsCom = tipsIns.getComponent(Tips)
            tipsCom.setText(tips)
            tipsCom.setStatus(0)
            this.layers.get(this.tipsLayerName).addChild(tipsIns)
        } else {
            let tipsCom = tipsNode.getComponent(Tips)
            tipsCom.setText(tips)
            tipsCom.setStatus(0)
            tipsNode.active = true
        }

    }
    private initUICamera() {
        // UI 相机设置
        this.camera.priority = 100; // 高优先级，最后渲染
        this.camera.clearFlags = Camera.ClearFlag.DEPTH_ONLY; // 只清除深度
        this.camera.clearColor.set(0, 0, 0, 0);// 设置透明背景色，以便可以看到场景中的物体
        this.camera.visibility = Layers.BitMask.UI_2D; // 只渲染 UI_2D 层

        // 设置为正交投影
        this.camera.orthoHeight = 5;

        // 确保 UI 相机在屏幕中心
        // this.node.setPosition(0, 0, 10);
    }

    private adjustToScreen() {

        const visibleSize = view.getVisibleSize();
        const designSize = view.getDesignResolutionSize()

        // 根据屏幕尺寸调整相机
        const ratio = visibleSize.width / visibleSize.height;
        const designRatio = designSize.width / designSize.height;

        if (ratio > designRatio) {
            // 宽屏
            this.camera.orthoHeight = designSize.height / 2;
        } else {
            // 高屏
            this.camera.orthoHeight = designSize.height / 2 * (designRatio / ratio);
        }

    }

    onResize() {
        // 屏幕尺寸变化时调整
        this.adjustToScreen();
    }

    /**
* view 宽高适配全屏
* @param _node 
*/
    /**
     * 将节点设置为全屏大小
     * @param _node 需要设置为全屏的节点
     */
    public fullSizeViewNode(_node: Node) {
        // 获取屏幕窗口尺寸
        // let size = screen.windowSize;
        // // 计算实际屏幕宽度（考虑缩放比例）
        // let screenWidth: number = size.width / view.getScaleX();
        // // 计算实际屏幕高度（考虑缩放比例）
        // let screenHeight: number = size.height / view.getScaleY();
        // // 设置节点的大小为屏幕尺寸
        // _node.getComponent(UITransform).setContentSize(screenWidth, screenHeight);
        // console.log("屏幕尺寸变化，节点大小调整为：", screenWidth, screenHeight);

                // 获取屏幕窗口尺寸
        let size = view.getVisibleSize();
        // 计算实际屏幕宽度（考虑缩放比例）
        let screenWidth: number = size.width ;
        // 计算实际屏幕高度（考虑缩放比例）
        let screenHeight: number = size.height ;
        // 设置节点的大小为屏幕尺寸
        _node.getComponent(UITransform).setContentSize(screenWidth, screenHeight);
        console.log("屏幕尺寸变化，节点大小调整为：", screenWidth, screenHeight);
    }
}