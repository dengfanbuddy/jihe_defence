export type RedDotCallback = (isActive: boolean) => void;

export class RedDotNode {
    public name:string = ""
    private children: Map<string, RedDotNode> = new Map();
    private _isActive: boolean = false;
    private callbacks: Set<RedDotCallback> = new Set();

    constructor(name:string,public readonly parent?: RedDotNode) {
        this.name = name;
    }

    get isActive(): boolean {
        return this._isActive;
    }

    set isActive(value: boolean) {
        if (this._isActive === value) return;
        
        this._isActive = value;
        this.notify();
        
        // 自动更新父节点状态
        this.parent?.updateState();
    }

    addChild(key: string): RedDotNode {
        const node = new RedDotNode(key,this);
        this.children.set(key, node);
        return node;
    }

    removeFromParent(){
        this.parent.children.delete(this.name)
    }

    getChild(key: string): RedDotNode | undefined {
        return this.children.get(key);
    }

    updateState() {
        const newState = Array.from(this.children.values())
            .some(node => node.isActive);
        
        if (this._isActive !== newState) {
            this._isActive = newState;
            this.notify();
            this.parent?.updateState();
        }
    }

    subscribe(callback: RedDotCallback) {
        this.callbacks.add(callback);
        callback(this._isActive);
    }

    unsubscribe(callback: RedDotCallback) {
        this.callbacks.delete(callback);
    }

    private notify() {
        this.callbacks.forEach(cb => cb(this._isActive));
    }
}

