import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";
import { Action } from "./Action";

// 等待节点 - 等待指定时间后返回成功
// 等待节点
export class Wait extends BTNode {
    private waitTime: number;
    private startTime: number = 0;
    private isWaiting: boolean = false;
    
    constructor(name: string = "Wait", waitTime: number) {
        super(name);
        this.waitTime = waitTime;
    }
    
    tick(blackboard: Blackboard): BTState {
        if (this.state === BTState.INTERRUPTED) {
            this.reset();
        }
        
        if (!this.isWaiting) {
            this.startTime = Date.now();
            this.isWaiting = true;
            this.state = BTState.RUNNING;
            return this.state;
        }
        
        const elapsed = Date.now() - this.startTime;
        if (elapsed >= this.waitTime) {
            this.state = BTState.SUCCESS;
            this.isWaiting = false;
        } else {
            this.state = BTState.RUNNING;
        }
        
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.state = BTState.INTERRUPTED;
            this.isWaiting = false;
        }
    }
    
    reset(): void {
        this.state = BTState.FAILURE;
        this.isWaiting = false;
        this.startTime = 0;
    }
}