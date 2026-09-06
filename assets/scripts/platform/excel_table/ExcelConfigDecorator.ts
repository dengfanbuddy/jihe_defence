
import { ResManager } from "../resources/ResMgr";
import { ITbDecode } from "./ITbDecode";
import { TbContainer } from "./TbContainer";
import { TbRoot } from "./TbRoot";


export function bind_path(path:string) {
    return function <T extends { new(...args: any[]): {} }>(_constructor: T) {
        var newConstructor = class T extends _constructor {
            constructor(...args: Array<any>) {
                super(...args);
                let obj = ResManager.inst.getJosn(path);
                for(let key in obj){
                    this[key] = obj[key]
                }
            }
        }
        return newConstructor;
    }
}

/**
 * 
 * @param tbType 表的结构
 * @returns 
 */
export function tb_container(tbType:new(...args: any[])=> {}) {
    return function <T extends { new(...args: any[]): TbContainer<any> }>(_constructor: T) {
        TbRoot.ins.registryContainer(tbType.name,_constructor as any)
        return _constructor;
    }
}


export function tb_decoder(tbType:new(...args: any[])=> {}) {
    return function <T extends { new(...args: any[]): ITbDecode<any> }>(_constructor: T) {
        TbRoot.ins.registryDecoder(tbType.name,_constructor)
        return _constructor;
    }
}