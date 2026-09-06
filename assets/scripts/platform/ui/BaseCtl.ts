import BaseView from "./BaseView";

export class BaseCtl<T extends BaseView<any,any>>{
    view:T
    isInit:boolean


    init(){

    }

    initDo():void{
        if(this.isInit){
            return
        }
        this.init()
        this.isInit = true
    }
}