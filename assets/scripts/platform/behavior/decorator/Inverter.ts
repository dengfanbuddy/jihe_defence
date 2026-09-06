import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";
import { DecoratorNode } from "./DecoratorNode";

// 取反节点 - 反转子节点的结果
export class Inverter extends DecoratorNode {
    constructor(name: string = "Inverter", child: BTNode) {
        super(name, child);
    }
    
    tick(blackboard: Blackboard): BTState {
        const childState = this.child.tick(blackboard);
        
        switch (childState) {
            case BTState.SUCCESS:
                this.state = BTState.FAILURE;
                break;
            case BTState.FAILURE:
                this.state = BTState.SUCCESS;
                break;
            case BTState.RUNNING:
                this.state = BTState.RUNNING;
                break;
            case BTState.INTERRUPTED:
                this.state = BTState.INTERRUPTED;
                break;
        }
        
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.child.interrupt(blackboard, type);
            this.state = BTState.INTERRUPTED;
        }
    }
}