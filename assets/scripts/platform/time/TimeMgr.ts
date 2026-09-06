import { _decorator, Component, macro, Node } from "cc";
const { ccclass, property } = _decorator;


interface ISecHandler{
    id:number,
    func:Function,
    obj:any
}

@ccclass('TimeMgr')
export class TimeMgr extends Component{
    private static _ins: TimeMgr;
    public static get ins(): TimeMgr {
        if (this._ins == null) {
            return null
        }
        return this._ins;
    }
    private _loopFunc: Function;
    private _defaultLoopFun: Function;
    //每秒的处理器
    private secondHandlers:Map<number,ISecHandler[]> = new Map()

    onLoad() {
        TimeMgr._ins = this;
        this._init();
    }

    private _init() {
        this._defaultLoopFun = this.updateSecond.bind(this);
        //启动一个默认的循环
        this.startLoop(this._defaultLoopFun,1)
    }


    public startLoop(cb:Function,interval?:number,repeat?:number){
        if(!repeat){
            repeat = macro.REPEAT_FOREVER
        }
        this.schedule(cb,interval,repeat)
    }
    public stopLoop(cb:Function){
        this.unschedule(cb)
    }



    /**
     * 每秒更新
     */
    private updateSecond(): void {
        if(this.secondHandlers.size==0){
            return
        }
        let itr = this.secondHandlers.values()
        for(let v of itr){
            v.forEach(f=>{
                try{
                    f.func.call(f.obj)
                }catch(e){
                    console.error(e);
                }
            })
        }
    }

    
    public addSecHandler(id:number,func:Function,obj:Object){
        let list  = this.secondHandlers.get(id)
        if(!list){
            list = []
            this.secondHandlers.set(id,list)
        }
        let exist = list.find((o)=>o.func==func && o.obj==obj)
        if(exist){
            return
        }
        list.push({
            id,
            func,
            obj
        })
    }
    public removeSecHandler(id:number,func:Function,obj:Object){
        let list  = this.secondHandlers.get(id)
        if(!list){
            return
        }
        let exist = list.find((o)=>o.func==func && o.obj==obj)
        if(!exist){
            return
        }
        let index = list.indexOf(exist)
        list.splice(index,1)
    }
}