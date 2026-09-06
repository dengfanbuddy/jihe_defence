import { BehaviorTree } from "../BehaviorTree";
import { Blackboard } from "../Blackboard";
import { BTNode } from "../BTNode";
import { BTState } from "../BTState";
import { InterruptType } from "../InterruptType";

// 子树节点 - 引用另一个行为树作为子节点
export class SubTree extends BTNode {
    private childTree: BehaviorTree;

    constructor(name: string, childTree: BehaviorTree) {
        super(name);
        this.childTree = childTree;
    }

    tick(blackboard: Blackboard): BTState {
        // 如果被中断，重置子树
        if (this.state === BTState.INTERRUPTED) {
            this.childTree.reset();
            // 同步黑板引用（可选：让子树使用传入的黑板）
            this.childTree["blackboard"] = blackboard;
        }

        // 更新子树
        this.childTree.update();

        // 获取子树根节点状态
        this.state = this.childTree.getRootState();

        // 如果子树完成（非 RUNNING），子树会被 BehaviorTree.update 自动 reset
        // 这里直接传递状态给父树
        return this.state;
    }

    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING && this.childTree.isTreeRunning()) {
            this.childTree.interrupt(type);
            this.state = BTState.INTERRUPTED;
        }
    }

    reset(): void {
        this.state = BTState.FAILURE;
        this.childTree.reset();
    }
}
