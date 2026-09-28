import { Component, EditBox, Label, Node, ProgressBar, Slider, Toggle, ToggleContainer } from "cc";
import BaseView from "./BaseView";
import UIManager from "./UIManager";
import { ViewInfo } from "./ViewInfo";

/**
 * 视图类装饰器：校验继承关系 + 把视图元数据注册进 `UIManager.viewInfos`（`UIManager.showUI` 靠它按类名找预制件和层级）
 */
export function uiview(viewOptions:ViewInfo){
    return function <T extends { new(...args: any[]): {} }>(constructor: T) {
        // 检查原型链继承关系（UIManager 只认 BaseView 子类）
        if (!BaseView.prototype.isPrototypeOf(constructor.prototype)) {
            throw new TypeError(`${constructor.name} 必须继承自 BaseView`);
        }
        let viewInfo = UIManager.viewInfos[constructor.name]
        if(viewInfo){
            throw new Error(`${constructor.name} 的元数据已经在 UIManager 中注册过了`)
        }
        if(!viewOptions.single){
            viewOptions.single = false
        }
        UIManager.viewInfos[constructor.name] = viewOptions

        //收集元数据
        return constructor
    }
    
}

export function bindValue(cmpType:new (...args)=>any = Node,name:string="") {
    return (target: Object, propertyKey: string) => {
        let constructor = target.constructor;
        
        // 验证类型
        if (!Component.prototype.isPrototypeOf(cmpType.prototype)) {
            throw new TypeError(`@bindValue 只支持绑定Node或Component的子类! 类：${constructor.name} 字段：${propertyKey}`);
        }
        let typeName = cmpType.name;
        
        if(typeName != EditBox.name 
            && typeName != Slider.name 
            && typeName != Toggle.name 
            && typeName != ToggleContainer.name
            && typeName != Label.name
            && typeName != ProgressBar.name
        ){
            throw new TypeError(`@bindValue 只支持绑定EditBox,Slider, Toggle,ToggleContainer,ProgressBar。类：${constructor.name} 字段：${propertyKey}`);
        }
        // 确定节点名称
        let nodeName = name;
        if (!nodeName) {
            nodeName = propertyKey.startsWith("&") ? propertyKey : "&" + propertyKey;
        }

        // 存储绑定信息
        let bindValues = constructor.prototype["__bindValues"];
        if (!bindValues) {
            bindValues = {};
            constructor.prototype["__bindValues"] = bindValues;
        }

        bindValues[propertyKey] = {
            cmpType,
            nodeName
        };
    };
}


export function bind(cmpType:new (...args)=>any = Node,name:string="") {

    return (target: Object, propertyKey: string) => {
        let constructor = target.constructor
        let bindType:new (...args)=>any = Node
        if(cmpType != Node && Component.prototype.isPrototypeOf(cmpType)){
            throw new TypeError(`@bind 只支持绑定Node或Component的子类! 类：${constructor.name} 字段：${propertyKey}` );
        }
        bindType = cmpType 

        let binds = constructor.prototype["__binds"]
        if(!binds){
            binds = {}
            constructor.prototype["__binds"] = binds
        }

        if(name){
            if(!name.startsWith("&")){
                name = "&"+name
            }
            binds[propertyKey] = {
                cmpType,
                nodeName:name
            }
        }else{
            let nodeName = propertyKey
            if(!propertyKey.startsWith("&")){
                nodeName = "&"+propertyKey
            }
            binds[propertyKey] = {
                cmpType,
                nodeName
            }
        }
    };
}
