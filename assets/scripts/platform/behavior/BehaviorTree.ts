import { Blackboard } from "./Blackboard";
import { BTNode } from "./BTNode";
import { BTState } from "./BTState";
import { InterruptType } from "./InterruptType";

// 行为树类
export class BehaviorTree {
    private root: BTNode;
    private blackboard: Blackboard;
    private isRunning: boolean = false;
    
    constructor(root: BTNode, blackboard: Blackboard = new Blackboard()) {
        this.root = root;
        this.blackboard = blackboard;
    }
    
    // 更新行为树
    update(): void {
        if (!this.isRunning) {
            this.isRunning = true;
        }
        
        this.root.tick(this.blackboard);
        
        // 如果根节点完成，重置树
        const state = this.root.getState();
        if (state !== BTState.RUNNING) {
            this.reset();
        }
    }
    
    // 中断行为树
    interrupt(type: InterruptType = InterruptType.FORCED): void {
        if (this.isRunning) {
            this.root.interrupt(this.blackboard, type);
            this.isRunning = false;
        }
    }
    
    // 重置行为树
    reset(): void {
        this.root.reset();
        this.isRunning = false;
    }
    
    // 获取黑板
    getBlackboard(): Blackboard {
        return this.blackboard;
    }
    
    // 检查行为树是否正在运行
    isTreeRunning(): boolean {
        return this.isRunning;
    }
    getRootState(): BTState {
        return this.root.getState();
    }
}