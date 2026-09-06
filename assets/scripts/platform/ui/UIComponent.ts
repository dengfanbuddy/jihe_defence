import { Component, Node, EditBox, Slider, Toggle, ToggleContainer, warn, SystemEvent, Label, ProgressBar } from "cc";
import BaseView from "./BaseView";
import BaseEventMgr from "../event/BaseEventMgr";
import { LogMgr } from "../log/LogMgr";


export class UIComponent extends Component {
    _ownerView: BaseView<any, any> = null

    // 管理所有UI组件
    _uiComponents: Set<UIComponent> = new Set();

    // 存储绑定引用
    private _bindingReferences: Map<string, { component: any, eventHandlers: Function[] }> = new Map();
    private _isDestroyed: boolean = false;

    public get ownerView() {
        return this._ownerView
    }
    public set ownerView(view: BaseView<any, any>) {
        this._ownerView = view
    }

    // 注册组件 (改为public)
    public registerComponent(comp: UIComponent, owerView: BaseView<any, any>) {
        this._uiComponents.add(comp);
        comp.ownerView = owerView;
    }

    // 注销组件
    public unregisterComponent(comp: UIComponent) {
        this._uiComponents.delete(comp);
        comp.ownerView = null
    }


    protected __preload(): void {
        this.nodeBindHandle();
        this.setupAllBindings();
    }
    nodeBindHandle() {
        let clazzNmae = this.constructor.name

        let binds = Object.getPrototypeOf(this).constructor.prototype["__binds"]
        if (!binds) {
            return
        }
        let keyNum = 0
        let bindPropertyKeys = []
        for (let key in binds) {
            keyNum++
            bindPropertyKeys.push(key)
        }
        if (keyNum === 0) {
            return
        }
        let option = {
            findNum: 0,
            keyNum: keyNum
        }

        this.findNode(this.node.children, binds, bindPropertyKeys, option)
        for (let key in binds) {
            let after = this[key]
            if (!after) {
                let info = binds[key]
                let targetCmpType = info["cmpType"]
                console.warn(`字段绑定节点失败:clazzName:${clazzNmae} key:${key} nodeName:${binds[key]["nodeName"]} cmpType:${targetCmpType.name}`);

            }
        }
    }
    findNode(
        children: Node[],
        binds: {
            [key: string]: any
        },
        bindPropertyKeys: string[],
        option: {
            findNum: number,
            keyNum: number
        }
    ) {
        if (option.findNum === option.keyNum) {
            return
        }

        children.forEach(n => {


            let nodeName = n.name
            bindPropertyKeys.forEach(key => {
                let targetMeta = binds[key]
                let targetNodeName = targetMeta["nodeName"]
                let targetCmpType = targetMeta["cmpType"]
                if (targetNodeName === nodeName) {
                    let old = this[key]
                    if (old) {
                        let oldValuePath = ""
                        if (old instanceof Node) {
                            oldValuePath = (old as Node).getPathInHierarchy()
                        } else {
                            oldValuePath = (old.node as Node).getPathInHierarchy()
                        }
                        LogMgr.warn("绑定节点名重复：" + nodeName + " 视图：" + this.name + " 字段：" + key + " oldPath:" + oldValuePath + " nowPath:" + n.getPathInHierarchy())
                        return
                    }
                    if (Node === targetCmpType) {
                        this[key] = n
                    } else {
                        this[key] = n.getComponent(targetCmpType) as Component
                    }
                    option.findNum++
                }
            })
            let cmps = n.components
            for (let i = 0; i < cmps.length; i++) {
                if (cmps[i] instanceof UIComponent) {//不继续查找子节点
                    return
                }
            }
            let children = n.children
            if (children.length > 0) {
                this.findNode(children, binds, bindPropertyKeys, option)
            }
        })
    }

    /**
     * 设置所有双向绑定
     */
    protected setupAllBindings(): void {
        const bindValues = this.constructor.prototype["__bindValues"];
        if (!bindValues) return;

        Object.keys(bindValues).forEach(propertyKey => {
            const binding = bindValues[propertyKey];
            this.setupTwoWayBinding(propertyKey, binding.cmpType, binding.nodeName);
        });

    }

    /**
     * 设置双向绑定
     * @param propertyKey 属性名
     * @param cmpType 组件类型
     * @param nodeName 节点名
     */
    protected setupTwoWayBinding(propertyKey: string, cmpType: any, nodeName: string): void {
        try {
            // 清理可能存在的旧绑定
            this.cleanupBinding(propertyKey);

            // 查找节点（增加递归查找，支持嵌套节点）
            // let node = this.findChildNodeByName(nodeName);
            let node = this.findNodeRecursively(this.node, nodeName);

            // // 如果直接子节点没找到，尝试递归查找所有子节点
            // if (!node) {
            //     node = this.findNodeRecursively(this.node, nodeName);
            // }

            if (!node) {
                warn(`双向绑定时未找到节点: ${nodeName}, 类: ${this.constructor.name}, 字段: ${propertyKey}`);
                return;
            }

            // 监听节点销毁事件
            node.once(Node.EventType.NODE_DESTROYED, () => this.onBoundNodeDestroyed(propertyKey), this);

            // 获取组件
            const component = cmpType === Node ? node : node.getComponent(cmpType);
            if (!component) {
                warn(`未找到组件: ${cmpType.name}, 节点: ${nodeName}`);
                return;
            }

            // 存储组件引用
            this[`_${propertyKey}Component`] = component;

            // 存储绑定引用和事件处理器
            const eventHandlers: Function[] = [];
            this._bindingReferences.set(propertyKey, { component, eventHandlers });
            // 创建私有属性存储实际值
            const privateKey = `_${propertyKey}`;
            this[privateKey] = this[propertyKey];
            // 定义属性的getter和setter
            Object.defineProperty(this, propertyKey, {
                get: () => {
                    return this[privateKey];
                },
                set: (newValue) => {
                    const oldValue = this[privateKey];
                    this[privateKey] = newValue;

                    // 触发值变化回调
                    if (newValue != oldValue) {
                        // 自动更新绑定的UI组件
                        if (this[`_${propertyKey}Component`]) {
                            this.updateUIComponent(propertyKey, newValue, oldValue);
                        }
                        this.onValueChange(propertyKey, newValue, oldValue);
                    }
                },
                enumerable: true,
                configurable: true
            });
            // 设置UI事件监听
            this.setupUIEvents(propertyKey, component, eventHandlers);
            // 初始同步数据到UI
            this.syncToUI(propertyKey, this[propertyKey]);

            // warn(`成功建立双向绑定: ${propertyKey} -> ${nodeName}`);
        } catch (error) {
            warn(`设置双向绑定失败: ${propertyKey}`, error);
        }
    }

    /**
     * 递归查找节点
     * @param parentNode 父节点
     * @param nodeName 要查找的节点名
     * @returns 找到的节点或null
     */
    private findNodeRecursively(parentNode: Node, nodeName: string): Node | null {
        for (const child of parentNode.children) {
            let cmps = child.components
            let skip = false;
            for (let i = 0; i < cmps.length; i++) {
                if (cmps[i] instanceof UIComponent) {//不继续查找子节点
                    skip = true
                    break
                }
            }
            if (skip) {
                continue
            }
            if (child.name === nodeName) {
                return child;
            }
            const found = this.findNodeRecursively(child, nodeName);
            if (found) {
                return found;
            }
        }
        return null;
    }

    /**
     * 根据名称查找子节点
     * @param nodeName 节点名
     * @returns 找到的节点
     */
    private findChildNodeByName(nodeName: string): Node | null {
        // 先尝试直接在子节点中查找
        let node = this.node.getChildByName(nodeName);
        if (node) return node;

        // 如果节点名以&开头，尝试去掉&查找
        if (nodeName.startsWith('&')) {
            node = this.node.getChildByName(nodeName.substring(1));
        } else {
            // 否则尝试添加&查找
            node = this.node.getChildByName('&' + nodeName);
        }

        return node;
    }

    /**
     * 设置UI事件监听
     * @param propertyKey 属性名
     * @param component 组件
     * @param eventHandlers 事件处理器数组
     */
    protected setupUIEvents(propertyKey: string, component: any, eventHandlers: Function[]): void {
        const componentType = component.constructor.name;
        const node = component.node || component;

        switch (componentType) {
            case 'EditBox':
                const editBoxHandler = () => {
                    if (!this.isComponentValid(component)) return;
                    this[propertyKey] = component.string;
                };
                node.on(EditBox.EventType.EDITING_DID_ENDED, editBoxHandler, this);
                eventHandlers.push(() => node.off(EditBox.EventType.EDITING_DID_ENDED, editBoxHandler, this));
                break;

            case 'Slider':
                const sliderHandler = () => {
                    if (!this.isComponentValid(component)) return;
                    this[propertyKey] = component.progress;
                };
                // 使用枚举常量而不是字符串，确保事件监听正确
                node.on("slide", sliderHandler, this);
                eventHandlers.push(() => node.off("slide", sliderHandler, this));
                break;

            case 'Toggle':
                const toggleHandler = () => {
                    if (!this.isComponentValid(component)) return;
                    this[propertyKey] = component.isChecked;
                };
                node.on(Toggle.EventType.TOGGLE, toggleHandler, this);
                eventHandlers.push(() => node.off(Toggle.EventType.TOGGLE, toggleHandler, this));
                break;
            case 'ToggleContainer':
                const toggleGroupHandler = () => {
                    if (!this.isComponentValid(component)) return;
                    // 对于ToggleContainer，我们可以将选中的索引作为值
                    const toggles = component.toggleItems;
                    if (!toggles || !Array.isArray(toggles)) return;
                    const selectedIndex = toggles.findIndex(toggle => toggle && toggle.isChecked);
                    this[propertyKey] = selectedIndex;
                };
                node.on("toggle-changed", toggleGroupHandler, this);

                // 监听所有toggle的事件
                // if (component.toggleItems && Array.isArray(component.toggleItems)) {
                //     component.toggleItems.forEach((toggle: Toggle) => {
                //         if (toggle && toggle.node) {
                //             toggle.node.on(Toggle.EventType.TOGGLE, toggleGroupHandler, this);
                //             eventHandlers.push(() => {
                //                 if (toggle && toggle.node) {
                //                     toggle.node.off(Toggle.EventType.TOGGLE, toggleGroupHandler, this);
                //                 }
                //             });
                //         }
                //     });
                // }
                break;
        }
    }

    /**
     * 同步数据到UI
     * @param propertyKey 属性名
     * @param value 值
     */
    protected syncToUI(propertyKey: string, value: any): void {
        if (!value && value !== 0 && value !== false) return;
        this.updateUIComponent(propertyKey, value, undefined);
    }

    /**
     * 更新UI组件
     * @param propertyKey 属性名
     * @param newValue 新值
     * @param oldValue 旧值
     */
    protected updateUIComponent(propertyKey: string, newValue: any, oldValue: any): void {
        try {
            const component = this[`_${propertyKey}Component`];
            // 增强组件有效性检查
            if (!component || !this.isComponentValid(component)) {
                warn(`更新UI组件时组件无效: ${propertyKey}`);
                return;
            }

            const componentType = component.constructor.name;

            switch (componentType) {
                case 'Label':
                    // 确保值是字符串类型
                    const labelstringValue = newValue !== undefined && newValue !== null ? String(newValue) : '';
                    if (component.string !== labelstringValue) {
                        component.string = labelstringValue;
                    }
                    break;
                case 'EditBox':
                    // 确保值是字符串类型
                    const stringValue = newValue !== undefined && newValue !== null ? String(newValue) : '';
                    if (component.string !== stringValue) {
                        component.string = stringValue;
                    }
                    break;
                case 'Slider':
                    // 确保值是有效的数字
                    const numValue = typeof newValue === 'number' ? newValue : 0;
                    if (component.progress !== numValue) {
                        component.progress = numValue;
                    }
                    break;
                case 'ProgressBar':
                    // 确保值是有效的数字
                    const progressValue = typeof newValue === 'number' ? newValue : 0;
                    if (component.progress !== progressValue) {
                        component.progress = progressValue;
                    }
                    break;
                case 'Toggle':
                    // 确保值是布尔类型
                    const boolValue = !!newValue;
                    if (component.isChecked !== boolValue) {
                        component.isChecked = boolValue;
                    }
                    break;
                case 'ToggleContainer':
                    // 对于ToggleContainer，value是选中的索引
                    if (typeof newValue === 'number' && newValue >= 0 && component.toggleItems &&
                        Array.isArray(component.toggleItems) && newValue < component.toggleItems.length) {
                        // 先取消所有选中状态
                        component.toggleItems.forEach((toggle: Toggle) => {
                            if (toggle && toggle.isValid) {
                                toggle.isChecked = false;
                            }
                        });
                        // 设置指定索引为选中状态
                        const targetToggle = component.toggleItems[newValue];
                        if (targetToggle && targetToggle.isValid) {
                            targetToggle.isChecked = true;
                        }
                    }
                    break;
                default:
                    warn(`未处理的组件类型: ${componentType}, 属性: ${propertyKey}`);
                    break;
            }
        } catch (error) {
            warn(`更新UI组件失败: ${propertyKey}`, error);
            // 仅在严重错误时清理绑定，避免频繁重建
        }
    }

    /**
     * 检查组件是否有效
     * @param component 组件
     * @returns 是否有效
     */
    protected isComponentValid(component: any): boolean {
        if (!component) return false;
        if (this._isDestroyed) return false;
        if (component.node && component.node.destroyed) return false;
        return true;
    }

    /**
     * 绑定节点被销毁时的处理
     * @param propertyKey 属性名
     */
    private onBoundNodeDestroyed(propertyKey: string): void {
        if (this._isDestroyed) return;

        // 安全地清理绑定，即使在节点销毁的情况下
        try {
            warn(`绑定节点已被销毁: ${propertyKey}, 类: ${this.constructor.name}`);
            this.cleanupBinding(propertyKey);
        } catch (error) {
            warn(`节点销毁时清理绑定 ${propertyKey} 出错`, error);
        }
    }

    /**
     * 清理单个绑定
     * @param propertyKey 属性名
     */
    protected cleanupBinding(propertyKey: string): void {
        const binding = this._bindingReferences.get(propertyKey);
        if (binding) {
            try {
                // 清理事件监听
                if (binding.eventHandlers && Array.isArray(binding.eventHandlers)) {
                    binding.eventHandlers.forEach(handler => {
                        try {
                            if (typeof handler === 'function') {
                                handler();
                            }
                        } catch (error) {
                            warn(`清理事件处理器时出错: ${propertyKey}`, error);
                        }
                    });
                    // 清空事件处理器数组
                    binding.eventHandlers.length = 0;
                }

                // 移除节点销毁监听（如果有的话）
                if (binding.component && binding.component.node) {
                    try {
                        binding.component.node.off(Node.EventType.NODE_DESTROYED, null, this);
                    } catch (e) {
                        // 忽略错误，节点可能已经被销毁
                    }
                }
            } catch (error) {
                warn(`清理绑定过程中出错: ${propertyKey}`, error);
            } finally {
                // 确保引用被清除，防止内存泄漏
                this._bindingReferences.delete(propertyKey);

                // 安全地删除组件引用
                const componentKey = `_${propertyKey}Component`;
                if (this.hasOwnProperty(componentKey)) {
                    delete this[componentKey];
                } else {
                    this[componentKey] = null;
                }
            }
        }
    }

    /**
     * 清理所有绑定
     */
    protected cleanupAllBindings(): void {
        // 创建一个数组来存储所有的属性键，避免在遍历时修改Map
        const propertyKeys = Array.from(this._bindingReferences.keys());

        // 清理每个绑定
        propertyKeys.forEach(propertyKey => {
            try {
                this.cleanupBinding(propertyKey);
            } catch (error) {
                warn(`清理绑定 ${propertyKey} 时出错`, error);
            }
        });

        // 最后清空整个Map
        this._bindingReferences.clear();
    }

    /**
     * 值变化时的回调
     * @param propertyKey 属性名
     * @param newValue 新值
     * @param oldValue 旧值
     */
    protected onValueChange(propertyKey: string, newValue: any, oldValue: any): void {
        // 尝试调用特定的字段变化回调
        const handlerName = `on${propertyKey.charAt(0).toUpperCase() + propertyKey.slice(1)}Change`;
        if (this[handlerName] && typeof this[handlerName] === 'function') {
            this[handlerName](oldValue, newValue);
        }
    }

    /**
     * 重新绑定所有节点
     */
    public rebindAll(): void {
        this.cleanupAllBindings();
        this.setupAllBindings();
    }

    /**
     * 重新绑定单个属性
     * @param propertyKey 属性名
     * @returns 是否成功
     */
    public rebind(propertyKey: string): boolean {
        const bindValues = this.constructor.prototype["__bindValues"];
        if (!bindValues || !bindValues[propertyKey]) {
            warn(`未找到绑定配置: ${propertyKey}`);
            return false;
        }

        this.cleanupBinding(propertyKey);

        const binding = bindValues[propertyKey];
        this.setupTwoWayBinding(propertyKey, binding.cmpType, binding.nodeName);

        return true;
    }

    onDestroy(): void {
        // 标记为已销毁，防止在清理过程中触发新的事件
        this._isDestroyed = true;

        try {
            // 清理所有绑定
            this.cleanupAllBindings();
        } catch (error) {
            warn(`${this.constructor.name} onDestroy 清理绑定时出错`, error);
        } finally {
            // 确保所有引用都被清除
            this._bindingReferences = null;
        }
    }
}