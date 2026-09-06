import { Action } from "./action/Action";
import { Wait } from "./action/Wait";
import { BehaviorTree } from "./BehaviorTree";
import { Blackboard } from "./Blackboard";
import { BTNode } from "./BTNode";
import { BTState } from "./BTState";
import { InterruptType } from "./InterruptType";
import { Selector } from "./composite/Selector";
import { Sequence } from "./composite/Sequence";
import { Condition } from "./condition/Condition";
import { SubTree } from "./decorator/SubTree";
import { BTLoader } from "./BTLoader";

// 示例行为树创建函数
export function createSampleBehaviorTree(): BehaviorTree {
    // 创建具体节点实例（不再使用抽象类）
    const checkHasTarget = new Condition("HasTarget", bb => bb.get("target") !== undefined);
    const moveToTarget = new MoveToAction("MoveToTarget", "target");
    const attackTarget = new AttackAction("AttackTarget", "target");
    const patrol = new PatrolAction("Patrol", ["Point A", "Point B"]);
    const wait = new Wait("Wait", 2000);
    
    // 组合节点
    const attackSequence = new Sequence("AttackSequence", [
        checkHasTarget,
        moveToTarget,
        attackTarget
    ]);
    
    const patrolSequence = new Sequence("PatrolSequence", [
        patrol,
        wait
    ]);
    
    const rootSelector = new Selector("RootSelector", [
        attackSequence,
        patrolSequence
    ]);
    
    // 创建行为树
    const blackboard = new Blackboard();
    return new BehaviorTree(rootSelector, blackboard);
}
// 具体动作节点实现
export class MoveToAction extends BTNode {
    private targetKey: string;
    private speed: number;
    
    constructor(name: string, targetKey: string, speed: number = 1) {
        super(name);
        this.targetKey = targetKey;
        this.speed = speed;
    }
    
    tick(blackboard: Blackboard): BTState {
        const target = blackboard.get<any>(this.targetKey);
        
        if (!target) {
            this.state = BTState.FAILURE;
            return this.state;
        }
        
        console.log(`Moving to target: ${target} at speed ${this.speed}`);
        this.state = BTState.SUCCESS;
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.state = BTState.INTERRUPTED;
            console.log("Movement interrupted!");
        }
    }

    reset(): void {
        this.state = BTState.FAILURE;
    }
}

export class AttackAction extends BTNode {
    private targetKey: string;
    
    constructor(name: string, targetKey: string) {
        super(name);
        this.targetKey = targetKey;
    }
    
    tick(blackboard: Blackboard): BTState {
        const target = blackboard.get<any>(this.targetKey);
        
        if (!target) {
            this.state = BTState.FAILURE;
            return this.state;
        }
        
        console.log(`Attacking target: ${target}`);
        this.state = BTState.SUCCESS;
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.state = BTState.INTERRUPTED;
            console.log("Attack interrupted!");
        }
    }

    reset(): void {
        this.state = BTState.FAILURE;
    }
}

export class PatrolAction extends BTNode {
    private waypoints: string[];
    private currentWaypoint: number = 0;
    
    constructor(name: string, waypoints: string[]) {
        super(name);
        this.waypoints = waypoints;
    }
    
    tick(blackboard: Blackboard): BTState {
        if (this.waypoints.length === 0) {
            this.state = BTState.SUCCESS;
            return this.state;
        }
        
        const waypoint = this.waypoints[this.currentWaypoint];
        console.log(`Patrolling to: ${waypoint}`);
        
        this.currentWaypoint = (this.currentWaypoint + 1) % this.waypoints.length;
        this.state = BTState.SUCCESS;
        return this.state;
    }
    
    interrupt(blackboard: Blackboard, type: InterruptType): void {
        if (this.state === BTState.RUNNING) {
            this.state = BTState.INTERRUPTED;
            console.log("Patrol interrupted!");
        }
    }

    reset(): void {
        this.state = BTState.FAILURE;
        this.currentWaypoint = 0;
    }
}

// 复杂行为树示例
export function createComplexBehaviorTree(): BehaviorTree {
    // 创建条件
    const hasTarget = new Condition("HasTarget", bb => bb.get("target") !== undefined);
    const isLowHealth = new Condition("IsLowHealth", bb => (bb.get<number>("health") || 100) < 30);
    
    // 创建动作
    const flee = new MoveToAction("Flee", "safeLocation", 2.5);
    const heal = new Wait("Heal", 5000);
    const moveToTarget = new MoveToAction("MoveTo", "target");
    const attack = new AttackAction("Attack", "target");
    const patrol = new PatrolAction("Patrol", ["A", "B", "C"]);
    const wait = new Wait("Wait", 3000);
    
    // 组合节点
    const fleeSelector = new Selector("FleeOrHeal", [
        flee,
        heal
    ]);
    
    const lowHealthSequence = new Sequence("LowHealthActions", [
        isLowHealth,
        fleeSelector
    ]);
    
    const combatSequence = new Sequence("CombatActions", [
        hasTarget,
        moveToTarget,
        attack
    ]);
    
    const patrolSequence = new Sequence("PatrolActions", [
        patrol,
        wait
    ]);
    
    // 根节点
    const rootSelector = new Selector("RootSelector", [
        lowHealthSequence,
        combatSequence,
        patrolSequence
    ]);
    
    // 创建行为树
    const blackboard = new Blackboard();
    blackboard.set("health", 100);
    blackboard.set("safeLocation", "Base Camp");
    return new BehaviorTree(rootSelector, blackboard);
}

// 测试示例
function testBehaviorTree() {
    // 创建行为树
    const tree = createSampleBehaviorTree();
    const bb = tree.getBlackboard();
    
    console.log("=== 初始状态 ===");
    tree.update(); // 应该执行巡逻
    
    console.log("\n=== 设置目标 ===");
    bb.set("target", "Enemy1");
    tree.update(); // 应该攻击目标
    
    console.log("\n=== 移除目标 ===");
    bb.delete("target");
    tree.update(); // 应该返回巡逻
    
    console.log("\n=== 测试中断 ===");
    bb.set("target", "Enemy2");
    tree.update(); // 开始攻击
    tree.interrupt(); // 中断当前行为
    console.log(`中断后状态: ${tree.getRootState()}`);
}

// 运行测试
// testBehaviorTree();

// ===== SubTree 示例 =====

// 创建一个巡逻子树
function createPatrolSubTree(): BehaviorTree {
    const patrol = new PatrolAction("Patrol", ["A", "B", "C"]);
    const wait = new Wait("Wait", 2000);
    const patrolSeq = new Sequence("PatrolSeq", [patrol, wait]);
    return new BehaviorTree(patrolSeq);
}

// 使用 SubTree 构建主行为树
export function createTreeWithSubTree(): BehaviorTree {
    const hasTarget = new Condition("HasTarget", bb => bb.get("target") !== undefined);
    const moveToTarget = new MoveToAction("MoveTo", "target");
    const attack = new AttackAction("Attack", "target");
    const combatSeq = new Sequence("CombatSeq", [hasTarget, moveToTarget, attack]);

    const patrolTree = createPatrolSubTree();
    const subTree = new SubTree("PatrolSubTree", patrolTree);

    const root = new Selector("Root", [combatSeq, subTree]);
    return new BehaviorTree(root);
}

// ===== JSON 加载示例 =====

// 注册自定义动作
BTLoader.registerAction("MoveToAction", (name, params) =>
    new MoveToAction(name, params.targetKey, params.speed ?? 1)
);
BTLoader.registerAction("AttackAction", (name, params) =>
    new AttackAction(name, params.targetKey)
);
BTLoader.registerAction("PatrolAction", (name, params) =>
    new PatrolAction(name, params.waypoints ?? [])
);

// 注册条件评估器
BTLoader.registerCondition("hasTarget", bb => bb.get("target") !== undefined);
BTLoader.registerCondition("isLowHealth", bb => (bb.get<number>("health") || 100) < 30);

export function createTreeFromJson(): BehaviorTree {
    const jsonStr = JSON.stringify({
        root: {
            type: "Selector",
            name: "RootSelector",
            children: [
                {
                    type: "Sequence",
                    name: "LowHealthActions",
                    children: [
                        { type: "Condition", name: "IsLowHealth", conditionName: "isLowHealth" },
                        { type: "Wait", name: "Heal", milliseconds: 5000 }
                    ]
                },
                {
                    type: "Sequence",
                    name: "CombatActions",
                    children: [
                        { type: "Condition", name: "HasTarget", expression: "target != null" },
                        { type: "Action", name: "MoveTo", actionClass: "MoveToAction", actionParams: { targetKey: "target", speed: 2.5 } },
                        { type: "Action", name: "Attack", actionClass: "AttackAction", actionParams: { targetKey: "target" } }
                    ]
                }
            ]
        }
    });
    return BTLoader.fromJsonString(jsonStr);
}

// 简化表达式写法
export function createTreeWithExpression(): BehaviorTree {
    const jsonStr = JSON.stringify({
        root: {
            type: "Selector",
            name: "Root",
            children: [
                {
                    type: "Sequence",
                    name: "Flee",
                    children: [
                        { type: "Condition", name: "LowHP", expression: "health < 30" },
                        { type: "Wait", name: "Heal", milliseconds: 3000 }
                    ]
                },
                {
                    type: "Sequence",
                    name: "Pursue",
                    children: [
                        { type: "Condition", name: "HasEnemy", expression: "enemyCount > 0" },
                        { type: "Action", name: "Move", actionClass: "MoveToAction", actionParams: { targetKey: "target" } }
                    ]
                }
            ]
        }
    });
    return BTLoader.fromJsonString(jsonStr);
}