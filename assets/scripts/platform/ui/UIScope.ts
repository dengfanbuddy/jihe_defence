/**
 * UIScope —— UI 作用域（Vue 风格 provide / inject），**不依赖 UIManager**
 *
 * 解决的问题：大 UI 的最外层组件 ↔ 界面内任意深度的小组件、以及小组件之间的通信。
 *
 *   - 向下共享：`provide(key, value)` 对本节点及其整棵子树可见，**深度无关**
 *   - 向上通知：`scope.on/emit`（每个作用域一条独立事件总线，随作用域销毁自动清空；
 *     `emit` 会**沿父链向上冒泡**，父链上每个 UIComponent 作用域都能用 `on` 收到）
 *   - 响应式：`scope.watch(...)` 建的 watcher 由 effectScope 统一回收，不必再手写 watchHandles 数组
 *   - 生命周期：`pause()` / `resume()` / `dispose()`（显示、隐藏、销毁分别对应）
 *
 * 因为不依赖 UIManager，所以它同时适用于两类 UI：
 *   - UIManager 管理的视图（场景/弹窗）→ 继承 `BaseView`，生命周期由 UIManager 驱动
 *   - 场景预制件里内嵌的 UI 页面 / 小组件 → 继承 `UIWidget`，生命周期由 Cocos 原生回调驱动
 *
 * ── 使用示例 ──
 * ```ts
 * // 提供方：任意层级的宿主（例：一个面板），向整棵子树注入自己的东西
 * protected onInit() {
 *     this.provide('heroSelect:selectedId', ref(0))
 *     this.scope.on('heroSelect:picked', this.onPicked, this)
 * }
 *
 * // 消费方：任意深度（第 1 层还是第 5 层写法完全一样）
 * private selectedId = null
 * protected onInit() {
 *     this.selectedId = this.inject<Ref<number>>('heroSelect:selectedId')
 *     this.scope.watch(() => this.selectedId.value, () => this.applySelected())
 * }
 * ```
 *
 * ── 三条必须知道的规则 ──
 * 1. **只沿 `node.parent` 向上，不跨 UIManager 的层节点**：`scenes` / `views` / `popup` / `dialog` / `tip` / `top`
 *    互为兄弟，跨层互相注不到 —— 这也正是层结构给的天然隔离。跨界面共享请走全局 store（`useBattleStore`）。
 * 2. **提供要早于消费**：子组件的 `onLoad` 在 `setParent` 激活时就同步跑完（早于 `BaseView.showView()`），
 *    所以宿主要在 `__preload` / `onLoad` 里 provide；如果提供时机确实很晚（比如要等战斗上下文创建完），
 *    消费方用**惰性注入**（用到时才 `inject`）即可，不受顺序影响。
 * 3. **`inject` 向上找值，`emit` 向上冒泡，两者方向一致、都不向后代/兄弟扩散**：
 *    `emit` 先派发到自己的总线，再沿父链逐级派发到**每个祖先 UIComponent 的作用域**，
 *    所以「第 5 层的小组件通知第 2 层的面板」不需要任何引用（第 1 层通知第 2 层、第 5 层通知第 2 层写法完全一样）。
 *    兄弟之间仍然收不到（要互斥就走共同祖先的 provide，见 `docs/UI框架使用说明.md` §7）。
 */

import { Component, Node } from "cc";
import {
    effectScope, watch,
    type EffectScope, type WatchCallback, type WatchEffect, type WatchHandle, type WatchOptions, type WatchSource,
} from "../reactivity";
import BaseEventMgr from "../event/BaseEventMgr";
import { LogMgr } from "../log/LogMgr";

/** 注入键：推荐 `'域:用途'` 形式的字符串（便于日志排查），也支持 symbol */
export type ScopeKey = string | symbol;

/** node → 该节点 provide 的键值（以节点为 key，节点被回收后自动释放） */
const providesMap: WeakMap<Node, Map<ScopeKey, any>> = new WeakMap();
/** 组件 → 它的作用域句柄 */
const scopes: WeakMap<Component, UIScope> = new WeakMap();
/**
 * 节点 → 挂在该节点上的作用域**列表**（`emit` 沿父链冒泡时按节点逐级查找）。
 * 用列表而不是单值：同一节点上理论上可以挂多个 UIComponent，每个都有自己的作用域，
 * 单值会被后注册的覆盖掉、让前一个静默收不到事件。
 */
const nodeScopes: WeakMap<Node, UIScope[]> = new WeakMap();

/** 登记「节点上的作用域」（`emit` 冒泡用；节点被回收后随 WeakMap 释放） */
function registerNodeScope(node: Node, scope: UIScope): void {
    if (!node) return;
    let list = nodeScopes.get(node);
    if (!list) {
        list = [];
        nodeScopes.set(node, list);
    }
    if (list.indexOf(scope) < 0) list.push(scope);
}

/** 注销「节点上的作用域」（scope.dispose 时调用） */
function unregisterNodeScope(node: Node, scope: UIScope): void {
    if (!node) return;
    const list = nodeScopes.get(node);
    if (!list) return;
    const index = list.indexOf(scope);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) nodeScopes.delete(node);
}

/** 沿父链解析（不含 fromNode 本层，与 Vue 一致：组件不能 inject 自己 provide 的值） */
function resolveInject<T>(fromNode: Node, key: ScopeKey, fallback: T): T {
    let p: Node = fromNode;
    while (p) {
        const map = providesMap.get(p);
        if (map && map.has(key)) {
            return map.get(key) as T;
        }
        p = p.parent;
    }
    if (fallback === undefined) {
        const name = fromNode ? fromNode.name : "null";
        LogMgr.warn(`UIScope 注入失败：key=${String(key)}，节点「${name}」向上的父链上没有提供者（可用 inject(key, fallback) 给默认值）`);
    }
    return fallback;
}

/** 向某个节点注册提供值（provide 的公共实现） */
function setProvide<T>(node: Node, key: ScopeKey, value: T): T {
    let map = providesMap.get(node);
    if (!map) {
        map = new Map<ScopeKey, any>();
        providesMap.set(node, map);
    }
    map.set(key, value);
    return value;
}

export class UIScope {

    /** 句柄所属组件 */
    public readonly host: Component;
    /** watcher 的宿主：detached，生命周期完全由本作用域控制（不受外层 effectScope 影响） */
    private _effects: EffectScope;
    /** 本作用域的局部事件总线 */
    private _bus: BaseEventMgr;
    private _disposed: boolean = false;

    public constructor(host: Component) {
        this.host = host;
        this._effects = effectScope(true);
        this._bus = new BaseEventMgr();
    }

    /** 作用域挂载的节点 */
    public get node(): Node {
        return this.host.node;
    }

    /** 是否已销毁 */
    public get disposed(): boolean {
        return this._disposed;
    }

    /* ==================== provide / inject ==================== */

    /**
     * 向本节点及其整棵子树提供值（同一 key 重复提供 = 覆盖）
     * @returns 传入的 value（方便 `this.selectedId = this.provide(key, ref(0))` 这样写）
     */
    public provide<T>(key: ScopeKey, value: T): T {
        return setProvide(this.node, key, value);
    }

    /** 沿父链向上解析（不含自己这一层） */
    public inject<T>(key: ScopeKey, fallback?: T): T {
        return resolveInject<T>(this.node.parent, key, fallback);
    }

    /* ==================== 响应式 ==================== */

    /**
     * 建立 watcher：由本作用域统一回收（dispose 时自动停），隐藏时随 scope 一起暂停
     * @returns WatchHandle；作用域已销毁时返回 null 并告警
     */
    public watch(
        source: WatchSource | WatchSource[] | WatchEffect | object,
        cb?: WatchCallback | null,
        options?: WatchOptions,
    ): WatchHandle {
        if (this._disposed) {
            LogMgr.warn(`UIScope 已销毁，watch 被忽略：${this.host.name}`);
            return null;
        }
        return this._effects.run(() => watch(source, cb, options)) as WatchHandle;
    }

    /* ==================== 局部事件（向上通知 / 命令） ==================== */

    public on(type: string | number, listener: (...args: any[]) => void, caller?: any): this {
        this._bus.addNotice(type, caller ?? this.host, listener);
        return this;
    }

    public once(type: string | number, listener: (...args: any[]) => void, caller?: any): this {
        this._bus.onceNotice(type, caller ?? this.host, listener);
        return this;
    }

    public off(type: string | number, listener: (...args: any[]) => void, caller?: any): this {
        this._bus.removeNotice(type, caller ?? this.host, listener);
        return this;
    }

    /**
     * 发通知：先派发到本作用域的总线，再**沿 `node.parent` 向上逐级派发**到每个祖先 UIComponent 的作用域。
     *
     * 语义（与 `inject` 同向）：`子 → 宿主` 的通知不需要任何引用，宿主 `scope.on(type, fn)` 就能收到，
     * 深度无关；**不会**向下传给后代、也不会横向传给兄弟（要互斥请用共同祖先 provide 的共享状态）。
     *
     * 注意：逐级派发用的是 `dispatchLocal`（不再触发冒泡），否则越上层的祖先会被重复通知。
     * 某一层监听器抛错不影响其它层（各自 try/catch）。
     */
    public emit(type: string | number, ...args: any[]): void {
        this.dispatchLocal(type, ...args);

        let p: Node = this.node ? this.node.parent : null;
        while (p) {
            const list = nodeScopes.get(p);
            if (list) {
                for (const scope of list) {
                    if (scope.disposed) continue;
                    try {
                        scope.dispatchLocal(type, ...args);
                    } catch (err) {
                        LogMgr.warn(`UIScope 向上通知「${String(type)}」时，节点「${p.name}」的监听器抛错：${err}`);
                    }
                }
            }
            p = p.parent;
        }
    }

    /** 只在本作用域总线上派发（不冒泡）—— 给 `emit` 逐级向上派发用 */
    public dispatchLocal(type: string | number, ...args: any[]): void {
        this._bus.emit(type, ...args);
    }

    /* ==================== 生命周期 ==================== */

    /**
     * 暂停本作用域的所有 watcher。
     * 注意：暂停期间被触发的 watcher 会被记下，`resume()` 时补播一次（Vue 3.5 语义）；
     * 但**非响应式输入**（普通字段）的变化不会被感知，显示时仍需按当前状态刷一次。
     */
    public pause(): void {
        this._effects.pause();
    }

    /** 恢复本作用域的所有 watcher（并补播暂停期间的触发） */
    public resume(): void {
        this._effects.resume();
    }

    /** 销毁：停掉全部 watcher、清空事件总线、撤销本节点的 provide（可重复调用） */
    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._effects.stop();
        this._bus.removeAll();
        providesMap.delete(this.node);
        unregisterNodeScope(this.node, this);
        scopes.delete(this.host);
    }
}

/* ==================== 自由函数形式（只拿到 Node、没有组件实例时用） ==================== */

/** 取（必要时创建）某个组件的作用域句柄 */
export function getScope(host: Component): UIScope {
    let scope = scopes.get(host);
    if (!scope) {
        scope = new UIScope(host);
        scopes.set(host, scope);
        // 节点 → 作用域：`emit` 沿父链冒泡时按节点逐级查（节点被回收后由 WeakMap 自动释放）
        registerNodeScope(host.node, scope);
    }
    return scope;
}

/** Vue 语义的 provide：向 node 及其整棵子树提供值 */
export function provide<T>(node: Node, key: ScopeKey, value: T): T {
    return setProvide(node, key, value);
}

/** Vue 语义的 inject：从 node 的父链向上解析 */
export function inject<T>(node: Node, key: ScopeKey, fallback?: T): T {
    return resolveInject<T>(node.parent, key, fallback);
}
