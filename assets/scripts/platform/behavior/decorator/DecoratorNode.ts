import { BTNode } from "../BTNode";
import { BTState } from "../BTState";

// 装饰节点基类
export abstract class DecoratorNode extends BTNode {
    protected child: BTNode;
    
    constructor(name: string, child: BTNode) {
        super(name);
        this.child = child;
    }
    
    reset(): void {
        this.state = BTState.FAILURE;
        this.child.reset();
    }
}