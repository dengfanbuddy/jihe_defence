import { error } from 'cc';
import UIManager from "./ui/UIManager";
import { ResManager } from "./resources/ResMgr";
import { logLevel, LogMgr } from "./log/LogMgr";
import { AdMgr } from "./ad/AdMgr";

/**门面模式 */
class EzGame {
    public get ui(){
        return UIManager.ins;
    }
    public get res(){
        return ResManager.inst;
    }
    /** 激励视频广告（平台无关；未接入 SDK 时走开发兜底，见 platform/ad/AdMgr.ts） */
    public get ad(){
        return AdMgr.inst;
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