import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";

// 条件节点 - 检查条件是否满足
export class Condition extends BTNode {
    private condition: (bb: Blackboard) => boolean;
    
    constructor(
        name: string, 
        condition: (bb: Blackboard) => boolean
    ) {
        super(name);
        this.condition = condition;
    }
    
    tick(blackboard: Blackboard): BTState {
        if (this.condition(blackboard)) {
            this.state = BTState.SUCCESS;
        } else {
            this.state = BTState.FAILURE;
        }
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        // 条件节点不需要中断处理
    }
    
    reset(): void {
        this.state = BTState.FAILURE;
    }
}
