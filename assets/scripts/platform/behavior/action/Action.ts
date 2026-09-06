import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";

// 动作节点基类
export abstract class Action extends BTNode {
    constructor(name: string) {
        super(name);
    }

    // 中断处理
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.state = BTState.INTERRUPTED;
        }
    }
    
    reset(): void {
        this.state = BTState.FAILURE;
    }
}
