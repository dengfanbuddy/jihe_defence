import { BTNode } from "../BTNode";
import { BTState } from "../BTState";


// 组合节点基类
export abstract class CompositeNode extends BTNode {
    protected children: BTNode[] = [];
    
    constructor(name: string, children: BTNode[] = []) {
        super(name);
        this.children = children;
    }
    
    // 添加子节点
    addChild(child: BTNode): void {
        this.children.push(child);
    }
    
    // 重置所有子节点
    reset(): void {
        this.state = BTState.FAILURE;
        this.children.forEach(child => child.reset());
    }
}