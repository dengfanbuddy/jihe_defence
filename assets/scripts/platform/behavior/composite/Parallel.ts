import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";
import { CompositeNode } from "./CompositeNode";


// 并行节点 - 同时执行所有子节点
export class Parallel extends CompositeNode {
    private results: BTState[] = [];
    private allFinished: boolean = false;
    
    constructor(name: string = "Parallel", children: BTNode[] = []) {
        super(name, children);
        this.results = new Array(children.length).fill(BTState.FAILURE);
    }
    
    tick(blackboard: Blackboard): BTState {
        // 如果被中断，重置状态
        if (this.state === BTState.INTERRUPTED) {
            this.reset();
        }
        
        let runningFound = false;
        let allSuccess = true;
        let anyFailure = false;
        
        // 执行所有子节点
        for (let i = 0; i < this.children.length; i++) {
            // 跳过已完成的节点
            if (this.results[i] === BTState.SUCCESS || this.results[i] === BTState.FAILURE) {
                continue;
            }
            
            const child = this.children[i];
            const childState = child.tick(blackboard);
            this.results[i] = childState;
            
            // 检查运行状态
            if (childState === BTState.RUNNING) {
                runningFound = true;
            }
            
            // 检查失败状态
            if (childState === BTState.FAILURE || childState === BTState.INTERRUPTED) {
                anyFailure = true;
            }
            
            // 检查成功状态
            if (childState !== BTState.SUCCESS) {
                allSuccess = false;
            }
        }
        
        // 处理运行状态
        if (runningFound) {
            this.state = BTState.RUNNING;
            return this.state;
        }
        
        // 处理成功状态
        if (allSuccess) {
            this.reset();
            this.state = BTState.SUCCESS;
            return this.state;
        }
        
        // 处理失败状态
        if (anyFailure) {
            this.reset();
            this.state = BTState.FAILURE;
            return this.state;
        }
        
        // 默认返回失败
        this.state = BTState.FAILURE;
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            // 中断所有正在运行的子节点
            for (let i = 0; i < this.children.length; i++) {
                if (this.results[i] === BTState.RUNNING) {
                    this.children[i].interrupt(blackboard, type);
                }
            }
            this.state = BTState.INTERRUPTED;
        }
    }
    
    reset(): void {
        super.reset();
        this.results = new Array(this.children.length).fill(BTState.FAILURE);
        this.allFinished = false;
    }
}