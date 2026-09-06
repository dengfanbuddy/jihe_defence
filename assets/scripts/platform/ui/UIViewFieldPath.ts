import { SearchType } from "./UIDecorator"

export interface BindMeta{
    path:string,
    type:new(...args:any[])=>any,
    searchType:SearchType
}

export class UIViewFieldPath{
    static bindMetas:Map<string,BindMeta> = new Map()
    // static filedTypes:Map<string,new(...args:any[])=>any> = new Map()
}