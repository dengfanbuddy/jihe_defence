import { EventTarget } from "cc";

export default class BaseEventMgr {
    private _ed: EventTarget;

    public constructor() {
        this._ed = new EventTarget();
    }

    public emit(type: string|number, ...args: any[]) {
        this._ed.emit(type, ...args);
    }

    public addNotice(type: string|number, caller: any, listener: (...args: any[]) => void): void {
        this._ed.on(type, listener, caller);
    }

    public removeNotice(type: string|number, caller: any, listener: (...args: any[]) => void): void {
        this._ed.off(type, listener, caller);
    }

    public onceNotice(type: string|number, caller: any, listener: (...args: any[]) => void): void {
        this._ed.once(type, listener, caller);
    }

    public removeAll(): void {
        this._ed = new EventTarget();
    }
}
