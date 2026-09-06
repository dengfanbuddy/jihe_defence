import { Component, EditBox, error, Label, Node, ProgressBar, Slider, Toggle, ToggleContainer } from "cc";
import { UIViewFieldPath } from "./UIViewFieldPath";
import BaseView from "./BaseView";
import UIMgr from "./UIMgr";
import { ViewInfo } from "./ViewInfo";

// export enum SearchType{
//     Single,//单个节点
//     Children,//
//     // Descendants
// }

/**
 * 功能1：根据路径查找指定的Node节点或组件
 * 功能2：查找指定路径节点下的孩子里的组件或后代里的组件
 * 查找节点时，type不传
 * 查找组件时：
 * 1.type必填
 * 2.如果searchType不填，默认是找路径对应的节点上的组件
 * 3.如果searchType是children，则是找路径节点的所有孩子节点上的组件
//  * 4.如果searchType是Descendants，则是找路径节点的所有后代节点上的组件
 * @param path 
 * @param type 
 * @param searchType 
 * @returns 
 */
// 自动绑定控件节点（装饰器）
// export function bindNode<T extends Component>(path: string,type?:new(...args:any[])=>T,searchType:SearchType = SearchType.Single) {
//     return (target: any, propertyKey: string) => {
//         let pathKey = target.name+"_"+propertyKey
//         if(!UIViewFieldPath.bindMetas.has(pathKey)){
//             let bindMeta = {
//                 path,
//                 type:type?type:null,
//                 searchType
//             }
//             UIViewFieldPath.bindMetas.set(pathKey,bindMeta)
//         }
//         // target["__path_"+propertyKey] = path
//         // const descriptorOld = Object.getOwnPropertyDescriptor(target, propertyKey);
//         // // target.prototype[""]
//         // let descriptor = {
//         //     get: function() {
//         //         let key = propertyKey+"_v"
//         //         if(this[key]){
//         //             return this[key]
//         //         }
//         //         let find =  this.node.getChildByPath(path);
//         //         if(find){
//         //             this[key] = find
//         //             return find
//         //         }
//         //         throw new Error("未找到路径对应的节点："+(this as Component).name+"  "+path)
//         //     },
//         // };
//         // Object.defineProperty(target, propertyKey, descriptor);
//     };
// }

// 自动绑定事件（装饰器）
// export function bindEvent(eventType: string, path: string) {
//     return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
//         const method = descriptor.value;
//         descriptor.value = function (this: BaseView) {
//             const node = this.node.getChildByPath(path);
//             if (node) {
//                 node.on(eventType, method, this);
//             } else {
//                 error(`Node not found: ${path}`);
//             }
//         };
//     };
// }
// export function uiview(){
//     return function <T extends { new(...args: any[]): {} }>(constructor: T) {
//         return class extends constructor {
//             constructor(...args: any[]) {
//                 super(...args);
    
//                 // 获取类的所有实例属性
//                 const propertyNames = Object.getOwnPropertyNames(this);
    
//                 // 为每个属性添加 getter
//                 propertyNames.forEach((propertyName) => {
//                     if (propertyName !== 'constructor') { // 排除构造函数

//                         let nodePath = constructor["__path_"+propertyName] || constructor.prototype["__path_"+propertyName]
//                         if(nodePath){
//                             this["__v_"+propertyName] = this["node"].getChildByPath(nodePath);
//                             if(!this["__v_"+propertyName]){
//                                 throw new error(constructor.name+" not found node in path:"+nodePath)
//                             }

//                         }
//                     }
//                 });
//             }
//         };
//     }
// }
/**视图类装饰器，用于收集元数据，返回新的构造函数 */
export function uiview(viewOptions:ViewInfo){
    return function <T extends { new(...args: any[]): {} }>(constructor: T) {
        //TODO 判断构造函数是否是BaseView的子类
          // 检查原型链继承关系
        if (!BaseView.prototype.isPrototypeOf(constructor.prototype)) {
            throw new TypeError(`${constructor.name} 必须继承自 BaseView`);
        }
        let viewInfo = UIMgr.viewInfos[constructor.name]
        if(viewInfo){
            throw new Error(`${constructor.name} 的元数据已经在UIMgr中注册过了`)
        }
        if(!viewOptions.single){
            viewOptions.single = false
        }
        UIMgr.viewInfos[constructor.name] = viewOptions
        
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