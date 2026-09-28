// UIManager.ts - 单场景UI管理器（@uiview 注册表 + 层级栈 + 缓存超时）
// 特性：场景层切换自动关闭其他层级 + 缓存超时防止内存增长

import {
    _decorator, Component, director, error,
    instantiate, Node, Prefab,
    resources, UITransform, view, Widget
} from "cc";
import BaseView from "./BaseView";
import { LogMgr } from "../log/LogMgr";
import { ViewInfo, ViewLayer } from "./ViewInfo";
import { isConstructor } from "../utils/TypeUtil";
import { GlobalEventMgr } from "../event/GlobalEventMgr";

const { ccclass, property } = _decorator;


/**
 * 层级节点 + 栈
 */
interface LayerInfo {
    node: Node;
    stack: BaseView[];
}

/**
 * 缓存的视图信息
 */
interface CachedViewInfo {
    view: BaseView;
    expireTime: number;
}

@ccclass('UIManager')
export default class UIManager extends Component {

    private static instance: UIManager = null;

    // ================ 编辑器挂载的层级节点 ================

    @property(Node)
    layerScenes: Node
    @property(Node)
    layerViews: Node
    @property(Node)
    layerPopups: Node
    @property(Node)
    layerDialogs: Node
    @property(Node)
    layerTips: Node
    @property(Node)
    layerTop: Node

    // ================ 运行时状态 ================

    private viewUid = 0;
    /** 层级映射（name → {node, stack}） */
    private layers: Map<string, LayerInfo> = new Map();
    /** 视图缓存（key = 视图构造器名） */
    private viewCache: Map<string, CachedViewInfo> = new Map();

    /** 全局前置回调，在每次 showView 前调用 */
    public globalBeforeShowFun: (layerNode: Node, showView: BaseView, stack: BaseView[]) => void = null;

    /** 场景层名称列表 —— 在这些层级上打开 UI 时，会自动关闭其他非场景层的 UI */
    private sceneLayerNames: string[] = [ViewLayer[ViewLayer.Scene]];

    /** 视图缓存超时（毫秒），默认 60s */
    public static DEFAULT_CACHE_TIME: number = 60000;

    /** 视图信息 —— `@uiview` 装饰器注册的目标（key = 视图类名） */
    static viewInfos: { [name: string]: ViewInfo } = {};

    changeSceneView: () => new (...args: any[]) => BaseView = null;

    // ================ 单例 ================

    public static get ins(): UIManager {
        if (!this.instance) {
            LogMgr.err("UIManager 还未初始化就进行获取！")
        }
        return this.instance;
    }

    // ================ 生命周期 ================

    protected onLoad(): void {
        UIManager.instance = this;
        this.initLayers();

        // 开启定时缓存清理（每10s）
        this.schedule(this.cleanupExpiredCache, 10);
    }

    // ================ 初始化 ================

    /** 将编辑器挂载的层级节点注册到 layers 映射 */
    private initLayers(): void {
        const layerMapping: [string, Node][] = [
            [ViewLayer[ViewLayer.Scene], this.layerScenes],
            [ViewLayer[ViewLayer.View], this.layerViews],
            [ViewLayer[ViewLayer.PopUp], this.layerPopups],
            [ViewLayer[ViewLayer.Dialog], this.layerDialogs],
            [ViewLayer[ViewLayer.Tip], this.layerTips],
            [ViewLayer[ViewLayer.Top], this.layerTop],
        ];
        layerMapping.forEach(([name, node]) => {
            if (!node) {
                LogMgr.warn(`UIManager 层级节点缺失：${name}`);
                return;
            }
            this.layers.set(name, { node, stack: [] });
        });

        LogMgr.debug("UIManager onLoad 完成，已注册层级：", Array.from(this.layers.keys()));
    }

    // ================ 显示 UI ================

    /**
     * 显示 UI（通过视图类）
     * - 如果目标层是场景层，会自动关闭并缓存其他非场景层的 UI
     * - 支持从缓存中恢复最近关闭的同类型视图
     */
    public async showUI<T extends BaseView>(
        viewType: new (...args: any[]) => T,
        afterShowCb?: () => void,
        ...args: any[]
    ): Promise<T> {
        const viewName = viewType.name || viewType.prototype.name;
        const uiInfo = UIManager.viewInfos[viewName];

        if (!uiInfo) {
            LogMgr.err(`view info not found for: ${viewType.name}`);
            return null;
        }

        const layerName = uiInfo.layer as string;
        if (!this.layers.has(layerName)) {
            LogMgr.err("未知 ui 层级：" + layerName);
            return null;
        }

        const layerInfo = this.layers.get(layerName);
        const stack = layerInfo.stack;

        // ---- 场景层切换：自动关闭并缓存非场景层的所有 UI ----
        const isSceneSwitch = this.sceneLayerNames.indexOf(layerName) !== -1;
        if (isSceneSwitch) {
            this.closeAndCacheOverlayLayers(viewName);
            // 显示场景转场动画（Top 层）
            this.showSceneTransition();
        }

        // ---- 单例检查（栈中查找） ----
        let view: BaseView = null;
        if (uiInfo.single) {
            let pos = -1;
            for (let i = 0; i < stack.length; i++) {
                if (stack[i].viewName === viewName) {
                    view = stack[i];
                    pos = i;
                    break;
                }
            }
            if (view) {
                stack.splice(pos, 1);
            }
        }

        // ---- 从层级节点的子节点中查找（已实例化但未入栈的） ----
        if (!view) {
            view = this.findViewOnLayer(layerInfo.node, viewType);
            if (view) {
                view.uid = this.nextId();
                // 如果该视图同时还在缓存中，将其从缓存移除防止后续 addToCache 误销毁
                this.evictFromCache(viewName);
            }
        }

        // ---- 从缓存中恢复 ----
        if (!view) {
            view = this.takeFromCache(viewName);
        }

        // ---- 创建新视图 ----
        if (!view) {
            const prefab = await this.loadUIPrefab(uiInfo.prefabPath);
            if (!prefab) {
                error(`加载预制件失败: ${uiInfo.prefabPath}`);
                return null;
            }
            const uiNode = instantiate(prefab);
            view = uiNode.getComponent(viewType);
            if (!view) {
                view = uiNode.addComponent(viewType) as T;
            }
            view.uid = this.nextId();
        }

        // ---- 入栈 & 挂载 ----
        stack.push(view);
        const layerNode = layerInfo.node;
        this.globalBeforeShowFun?.(layerNode, view, stack);
        view.node.setParent(layerNode);

        const widget = view.getComponent(Widget);
        if (widget) {
            widget.updateAlignment();
        }

        await view.showView(...args);
        LogMgr.debug(`显示视图：${viewName} uid:${view.uid}`);
        afterShowCb?.();

        // 场景切换完成 → 触发转场结束动画
        if (isSceneSwitch) {
            this.scheduleOnce(() => {
                GlobalEventMgr.ins.emit('SCENE_LOAD_PROGRESS', 1.0);
            }, 1)

        }

        return view as T;
    }

    // ================ 关闭 UI ================

    /**
     * 关闭 UI（通过实例或类型）
     * - 默认将视图移入缓存（expire 后自动销毁）
     * - 传入 options.destroy = true 则立即销毁
     */
    public async closeUI<T extends BaseView>(
        view: T | (new (...args: any[]) => T),
        options?: {
            cb?: () => void;
            destroy?: boolean;
        }
    ): Promise<void> {
        let viewType: new (...args: any[]) => T;
        let closeByType = false;

        if (isConstructor(view)) {
            closeByType = true;
            viewType = view as new (...args: any[]) => T;
        } else {
            viewType = (view as BaseView).constructor as new (...args: any[]) => T;
        }

        const viewName = viewType.name || viewType.prototype.name;
        const uiInfo = UIManager.viewInfos[viewName];
        if (!uiInfo) {
            LogMgr.err(`关闭UI失败！没有找到视图数据: ${viewType.name}`);
            return;
        }

        const layerName = uiInfo.layer as string;
        if (!this.layers.has(layerName)) {
            LogMgr.err(`未知ui层级：${layerName} 无法关闭视图：${viewName}`);
            return;
        }

        const stack = this.layers.get(layerName).stack;

        // 收集需要关闭的视图
        const toClose: BaseView[] = [];
        if (closeByType) {
            stack.forEach((v) => {
                if (v.viewName === viewName) {
                    toClose.push(v);
                }
            });
        } else {
            const idx = stack.indexOf(view as BaseView);
            if (idx !== -1) {
                toClose.push(stack[idx]);
            }
        }

        if (!toClose.length) return;

        toClose.forEach((v) => {
            v.closeView();
            this.removeFromStack(stack, v);

            if (options && options.destroy) {
                v.deleteView();
                v.node.destroy();
                LogMgr.debug(`销毁视图：${v.name} uid:${v.uid}`);
            } else {
                this.addToCache(v);
                LogMgr.debug(`关闭视图：${v.name} uid:${v.uid}（已缓存）`);
            }
        });

        options?.cb?.();
    }

    /** 关闭指定层级所有 UI（默认移入缓存） */
    public closeAllByLayer(layerName: string, destroy: boolean = false): void {
        const layerInfo = this.layers.get(layerName);
        if (!layerInfo) return;
        const stack = layerInfo.stack;
        while (stack.length > 0) {
            const v = stack.pop();
            v.closeView();
            if (destroy) {
                v.deleteView();
                v.node.destroy();
            } else {
                this.addToCache(v);
            }
        }
    }

    /** 关闭所有 UI（可排除某些层级） */
    public closeAllUI(excludeLayers: string[] = []): void {
        this.layers.forEach((_info, layerName) => {
            if (excludeLayers.indexOf(layerName) !== -1) return;
            this.closeAllByLayer(layerName, false);
        });
    }

    // ================ 缓存机制 ================

    /** 将视图加入缓存 */
    private addToCache(view: BaseView): void {
        const key = this.cacheKey(view);
        // 如果有同 key 旧缓存，先销毁
        const existing = this.viewCache.get(key);
        if (existing) {
            this.destroyCachedView(existing);
            this.viewCache.delete(key);
        }

        const expireTime = Date.now() + UIManager.DEFAULT_CACHE_TIME;
        this.viewCache.set(key, {
            view,
            expireTime,
        });
        LogMgr.debug(`视图缓存：${view.constructor.name} uid:${view.uid} 将于 ${Math.round(UIManager.DEFAULT_CACHE_TIME / 1000)}s 后销毁`);
    }

    /** 从缓存中取回视图（不移除则返回 null） */
    private takeFromCache(viewName: string): BaseView | null {
        // 遍历查找匹配构造器名的缓存
        for (const [key, cached] of this.viewCache) {
            if (key === viewName) {
                this.viewCache.delete(key);
                if (Date.now() < cached.expireTime) {
                    LogMgr.debug(`从缓存恢复视图：${viewName}`);
                    return cached.view;
                } else {
                    // 已过期，销毁
                    this.viewCache.delete(key);
                    this.destroyCachedView(cached);
                    return null;
                }
            }
        }
        return null;
    }

    /**
     * 从缓存中移除指定视图（不销毁），防止视图在屏幕上时缓存中仍持有引用
     * 用于 findViewOnLayer 找到视图后同步清理缓存
     */
    private evictFromCache(viewName: string): void {
        for (const [key, cached] of this.viewCache) {
            if (key === viewName) {
                this.viewCache.delete(key);
                LogMgr.debug(`从缓存中移除视图引用：${viewName}`);
                return;
            }
        }
    }

    /** 销毁一个缓存的视图 */
    private destroyCachedView(cached: CachedViewInfo): void {
        if (cached.view) {
            cached.view.deleteView();
            cached.view.node.destroy();
        }

    }

    /** 定时清理过期缓存 */
    private cleanupExpiredCache(): void {
        const now = Date.now();
        this.viewCache.forEach((cached, key) => {
            if (now >= cached.expireTime) {
                LogMgr.debug(`缓存过期销毁：${key} uid:${cached.view.uid}`);
                this.destroyCachedView(cached);
                this.viewCache.delete(key);
            }
        });
    }

    // ================ 场景层切换 ================

    /**
     * 关闭并缓存所有非场景层的 UI（同层已有的也会被关闭）
     */
    private closeAndCacheOverlayLayers(viewName: string): void {
        this.layers.forEach((layerInfo, layerName) => {
            const stack = layerInfo.stack;
            const isSceneLayer = this.sceneLayerNames.indexOf(layerName) !== -1;
            while (stack.length > 0) {
                const v = stack.pop();
                // 场景层上正在打开的视图：弹出但不关闭，复用节点，由后续流程处理
                if (isSceneLayer && v.viewName === viewName) {
                    continue;
                }
                v.closeView();
                this.addToCache(v);
            }
        });
    }

    // ================ 场景切换动画 ================

    /** 触发场景切换转场动画（Top 层已有 Top_ChangeScene 节点监听事件） */
    private showSceneTransition(): void {

        // GlobalEventMgr.ins.emit('SCENE_Change');
        let changeSceneView = this.changeSceneView?.()
        if (changeSceneView) {
            this.showUI(changeSceneView)
            // 仅在下一次帧回调一次，避免 schedule() 默认“每帧、无限重复”造成常驻每帧事件
            this.scheduleOnce(() => {
                GlobalEventMgr.ins.emit('SCENE_LOAD_PROGRESS', 0);
            }, 0)
        }

    }



    // ================ 内部工具 ================

    private nextId(): number {
        return this.viewUid++;
    }

    private cacheKey(view: BaseView): string {
        return view.constructor.name;
    }

    private removeFromStack(stack: BaseView[], view: BaseView): void {
        const idx = stack.indexOf(view);
        if (idx !== -1) {
            stack.splice(idx, 1);
        }
    }

    /** 在层级节点的子节点中查找指定类型的视图（查找 inactive 的） */
    private findViewOnLayer<T extends BaseView>(
        layerNode: Node,
        viewType: new (...args: any[]) => T,
    ): T | null {
        for (const child of layerNode.children) {
            // 跳过已关闭/未激活的节点，避免取到已缓存的视图
            if (!child.active) continue;
            const comp = child.getComponent(viewType);
            if (comp) {
                return comp as T;
            }
        }
        return null;
    }

    private async loadUIPrefab(prefabPath: string): Promise<Prefab> {
        return new Promise((resolve) => {
            resources.load(prefabPath, Prefab, (err, prefab) => {
                if (err) {
                    error(err);
                    resolve(null);
                } else {
                    resolve(prefab);
                }
            });
        });
    }

    public fullSizeViewNode(_node: Node): void {
        const size = view.getVisibleSize();
        _node.getComponent(UITransform).setContentSize(size.width, size.height);
    }

    onResize(): void {
        // 屏幕适配扩展点
    }
}
