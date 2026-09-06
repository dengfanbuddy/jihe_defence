import { Blackboard } from "./Blackboard";
import { BTState } from "./BTState";
import { InterruptType } from "./InterruptType";

// 行为树节点基类
export abstract class BTNode {
    protected name: string;
    protected state: BTState = BTState.FAILURE;
    protected interruptType: InterruptType = InterruptType.NONE;
    
    constructor(name: string) {
        this.name = name;
    }
    
    // 执行节点逻辑
    abstract tick(blackboard: Blackboard): BTState;
    
    // 中断处理
    abstract interrupt(blackboard: Blackboard, type: InterruptType): void;
    
    // 重置节点状态
    abstract reset(): void;
    
    // 获取节点状态
    getState(): BTState {
        return this.state;
    }
    
    // 获取节点名称
    getName(): string {
        return this.name;
    }
}