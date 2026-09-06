import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";
import { DecoratorNode } from "./DecoratorNode";

// 重复节点 - 重复执行子节点指定次数或无限次
export class Repeater extends DecoratorNode {
    private repeatCount: number;
    private currentCount: number = 0;
    private infinite: boolean;
    
    constructor(
        name: string = "Repeater", 
        child: BTNode, 
        repeatCount: number = 0,
        infinite: boolean = false
    ) {
        super(name, child);
        this.repeatCount = repeatCount;
        this.infinite = infinite;
    }
    
    tick(blackboard: Blackboard): BTState {
        // 如果被中断，重置状态
        if (this.state === BTState.INTERRUPTED) {
            this.reset();
        }
        
        // 检查完成条件
        if (!this.infinite && this.currentCount >= this.repeatCount) {
            this.state = BTState.SUCCESS;
            return this.state;
        }
        
        const childState = this.child.tick(blackboard);
        
        switch (childState) {
            case BTState.SUCCESS:
                this.currentCount++;
                // 检查是否完成所有重复
                if (!this.infinite && this.currentCount >= this.repeatCount) {
                    this.state = BTState.SUCCESS;
                } else {
                    this.state = BTState.RUNNING;
                }
                break;
                
            case BTState.FAILURE:
                this.state = BTState.FAILURE;
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
    
    reset(): void {
        super.reset();
        this.currentCount = 0;
    }
}