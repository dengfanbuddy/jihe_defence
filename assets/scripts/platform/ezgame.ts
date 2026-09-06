import { error } from 'cc';
import UIMgr from "./ui/UIMgr";
import { ResManager } from "./resources/ResMgr";
import { logLevel, LogMgr } from "./log/LogMgr";

/**门面模式 */
class EzGame {
    public get ui(){
        return UIMgr.ins;
    }
    public get res(){
        return ResManager.inst;
    }

    public get debug(){
        return LogMgr.debug
    }
    public get info(){
        return LogMgr.info
    }
    public get warn(){
        return LogMgr.warn
    }
    public get error(){
        return LogMgr.err
    }

    public setLogLevel(level:number){
        if(level>logLevel.Error){
            level = logLevel.Error
        }
        if(level<logLevel.Debug){
            level = logLevel.Debug
        }
        LogMgr.logLevel = level
    }
    public setLogOpen(open:boolean){
        LogMgr.logOpen = open
    }
}

/** 全局 Window 接口 */
declare global {
    interface Window {
        ezgame: EzGame;
    }
    const ezgame: EzGame;
}

/** 创建 Core 类的实例并赋值给全局 window 对象 */
window.ezgame = new EzGame();