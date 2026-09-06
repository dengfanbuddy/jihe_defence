import BaseEventMgr from "./BaseEventMgr";

export class GlobalEventMgr extends BaseEventMgr{
    private static _ins: GlobalEventMgr;
    public static get ins(): GlobalEventMgr {
        if (!GlobalEventMgr._ins) {
            GlobalEventMgr._ins = new GlobalEventMgr();
        }
        return GlobalEventMgr._ins;
    }
}