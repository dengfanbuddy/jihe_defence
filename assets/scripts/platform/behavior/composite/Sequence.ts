import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";
import { CompositeNode } from "./CompositeNode";


// 顺序节点 - 依次执行子节点，全部成功返回成功，任一失败返回失败
export class Sequence extends CompositeNode {
    private currentIndex: number = 0;
    
    constructor(name: string = "Sequence", children: BTNode[] = []) {
        super(name, children);
    }
    
    tick(blackboard: Blackboard): BTState {
        // 如果被中断，重置状态
        if (this.state === BTState.INTERRUPTED) {
            this.reset();
        }
        
        // 从上次停止的地方继续执行
        for (let i = this.currentIndex; i < this.children.length; i++) {
            const child = this.children[i];
            const childState = child.tick(blackboard);
            
            // 处理运行中状态
            if (childState === BTState.RUNNING) {
                this.currentIndex = i;
                this.state = BTState.RUNNING;
                return this.state;
            }
            
            // 处理失败状态
            if (childState === BTState.FAILURE || childState === BTState.INTERRUPTED) {
                this.reset();
                this.state = BTState.FAILURE;
                return this.state;
            }
        }
        
        // 所有子节点成功完成
        this.reset();
        this.state = BTState.SUCCESS;
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            // 中断当前运行的子节点
            if (this.currentIndex < this.children.length) {
                this.children[this.currentIndex].interrupt(blackboard, type);
            }
            this.state = BTState.INTERRUPTED;
        }
    }
    
    reset(): void {
        super.reset();
        this.currentIndex = 0;
    }
}