import { BehaviorTree } from "./BehaviorTree";
import { Blackboard } from "./Blackboard";
import { BTNode } from "./BTNode";
import { BTState } from "./BTState";
import { Wait } from "./action/Wait";
import { Sequence } from "./composite/Sequence";
import { Selector } from "./composite/Selector";
import { Parallel } from "./composite/Parallel";
import { Inverter } from "./decorator/Inverter";
import { Repeater } from "./decorator/Repeater";
import { SubTree } from "./decorator/SubTree";
import { Condition } from "./condition/Condition";
import { LogMgr } from "../log/LogMgr";

// 行为树 JSON 节点定义
export interface BTJsonNode {
    type: string;
    name: string;
    children?: BTJsonNode[];
    child?: BTJsonNode;
    // Wait
    milliseconds?: number;
    // Condition
    expression?: string;
    conditionName?: string;
    // Repeater
    repeatCount?: number;
    infinite?: boolean;
    // Action (custom)
    actionClass?: string;
    actionParams?: Record<string, any>;
    // SubTree
    subTreePath?: string;
    subTree?: BTJsonNode;
}

// 条件表达式解析结果
interface ParsedExpression {
    key: string;
    operator: string;
    value: any;
}

// 条件评估器注册表
type ConditionEvaluator = (bb: Blackboard) => boolean;
// 自定义动作工厂
type ActionFactory = (name: string, params: Record<string, any>) => BTNode;

export class BTLoader {
    private static conditionRegistry: Map<string, ConditionEvaluator> = new Map();
    private static actionRegistry: Map<string, ActionFactory> = new Map();

    // 注册条件评估器
    static registerCondition(name: string, evaluator: ConditionEvaluator): void {
        if (this.conditionRegistry.has(name)) {
            LogMgr.warn(`条件 "${name}" 已注册，将被覆盖`);
        }
        this.conditionRegistry.set(name, evaluator);
    }

    // 注销条件评估器
    static unregisterCondition(name: string): void {
        this.conditionRegistry.delete(name);
    }

    // 注册自定义动作工厂
    static registerAction(className: string, factory: ActionFactory): void {
        if (this.actionRegistry.has(className)) {
            LogMgr.warn(`动作 "${className}" 已注册，将被覆盖`);
        }
        this.actionRegistry.set(className, factory);
    }

    // 注销自定义动作
    static unregisterAction(className: string): void {
        this.actionRegistry.delete(className);
    }

    // 从 JSON 对象加载行为树
    static fromJson(json: BTJsonNode, blackboard?: Blackboard): BehaviorTree {
        const root = this.parseNode(json);
        return new BehaviorTree(root, blackboard);
    }

    // 从 JSON 字符串加载行为树
    static fromJsonString(jsonStr: string, blackboard?: Blackboard): BehaviorTree {
        const json = JSON.parse(jsonStr) as BTJsonNode;
        return this.fromJson(json, blackboard);
    }

    // 递归解析 JSON 节点
    private static parseNode(json: BTJsonNode): BTNode {
        const { type, name } = json;

        switch (type) {
            // 组合节点
            case "Sequence":
                return this.parseSequence(name, json.children || []);
            case "Selector":
                return this.parseSelector(name, json.children || []);
            case "Parallel":
                return this.parseParallel(name, json.children || []);

            // 装饰节点
            case "Inverter":
                return this.parseInverter(name, json.child);
            case "Repeater":
                return this.parseRepeater(name, json);

            // 叶节点
            case "Condition":
                return this.parseCondition(name, json);
            case "Wait":
                return new Wait(name, json.milliseconds ?? 0);
            case "Action":
                return this.parseCustomAction(name, json);

            // 子树
            case "SubTree":
                return this.parseSubTree(name, json);

            default:
                LogMgr.err(`未知的行为树节点类型: "${type}"，使用 Condition 降级处理`);
                return new Condition(name, () => false);
        }
    }

    private static parseSequence(name: string, children: BTJsonNode[]): Sequence {
        const nodes = children.map(c => this.parseNode(c));
        return new Sequence(name, nodes);
    }

    private static parseSelector(name: string, children: BTJsonNode[]): Selector {
        const nodes = children.map(c => this.parseNode(c));
        return new Selector(name, nodes);
    }

    private static parseParallel(name: string, children: BTJsonNode[]): Parallel {
        const nodes = children.map(c => this.parseNode(c));
        return new Parallel(name, nodes);
    }

    private static parseInverter(name: string, child: BTJsonNode | undefined): Inverter {
        if (!child) {
            LogMgr.err(`Inverter "${name}" 缺少 child 节点`);
            return new Inverter(name, new Condition("dummy", () => false));
        }
        return new Inverter(name, this.parseNode(child));
    }

    private static parseRepeater(name: string, json: BTJsonNode): Repeater {
        if (!json.child) {
            LogMgr.err(`Repeater "${name}" 缺少 child 节点`);
            const dummy = new Condition("dummy", () => false);
            return new Repeater(name, dummy, json.repeatCount ?? 0, json.infinite ?? false);
        }
        const child = this.parseNode(json.child);
        return new Repeater(name, child, json.repeatCount ?? 0, json.infinite ?? false);
    }

    private static parseCondition(name: string, json: BTJsonNode): Condition {
        // 优先使用已注册的条件评估器
        if (json.conditionName && this.conditionRegistry.has(json.conditionName)) {
            const evaluator = this.conditionRegistry.get(json.conditionName)!;
            return new Condition(name, evaluator);
        }

        // 其次使用表达式解析
        if (json.expression) {
            const parsed = this.parseExpression(json.expression);
            if (parsed) {
                const { key, operator, value } = parsed;
                return new Condition(name, (bb) => {
                    const bbValue = bb.get<any>(key);
                    switch (operator) {
                        case "==": return bbValue == value;
                        case "!=": return bbValue != value;
                        case ">":  return bbValue > value;
                        case "<":  return bbValue < value;
                        case ">=": return bbValue >= value;
                        case "<=": return bbValue <= value;
                        case "!":  return !bbValue;
                        case "!!": return !!bbValue;
                        default:
                            LogMgr.warn(`不支持的条件运算符: "${operator}"`);
                            return false;
                    }
                });
            }
        }

        LogMgr.warn(`条件 "${name}" 无法解析，默认返回 false`);
        return new Condition(name, () => false);
    }

    // 解析简单表达式: "key < 30" / "target != null" / "hasFlag == true"
    private static parseExpression(expr: string): ParsedExpression | null {
        const patterns = [
            /^\s*(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/,
            /^\s*!!\s*(\w+)\s*$/,
            /^\s*!\s*(\w+)\s*$/,
            /^\s*(\w+)\s*$/,
        ];

        for (const pattern of patterns) {
            const match = expr.match(pattern);
            if (match) {
                if (pattern === patterns[0]) {
                    // key operator value
                    let value: any = match[3].trim();
                    if (value === "null") value = null;
                    else if (value === "true") value = true;
                    else if (value === "false") value = false;
                    else if (/^\d+\.?\d*$/.test(value)) value = Number(value);
                    return { key: match[1].trim(), operator: match[2].trim(), value };
                } else if (pattern === patterns[1]) {
                    // !!key (truthy check)
                    return { key: match[1].trim(), operator: "!!", value: null };
                } else if (pattern === patterns[2]) {
                    // !key (falsy check)
                    return { key: match[1].trim(), operator: "!", value: null };
                } else {
                    // key (truthy shorthand)
                    return { key: match[1].trim(), operator: "!!", value: null };
                }
            }
        }

        return null;
    }

    private static parseCustomAction(name: string, json: BTJsonNode): BTNode {
        const className = json.actionClass;
        if (!className) {
            LogMgr.err(`Action "${name}" 缺少 actionClass 字段`);
            return new Condition(name, () => false);
        }

        const factory = this.actionRegistry.get(className);
        if (!factory) {
            LogMgr.err(`未注册的自定义动作: "${className}"，请使用 BTLoader.registerAction() 注册`);
            return new Condition(name, () => false);
        }

        return factory(name, json.actionParams || {});
    }

    private static parseSubTree(name: string, json: BTJsonNode): BTNode {
        if (json.subTree) {
            // 内联子树定义
            const childRoot = this.parseNode(json.subTree);
            const childTree = new BehaviorTree(childRoot);
            return new SubTree(name, childTree);
        }

        if (json.subTreePath) {
            LogMgr.err(`SubTree "${name}" 的路径加载 "${json.subTreePath}" 暂未支持，需要配合 resources.load`);
            const dummy = new Condition("dummy", () => false);
            return new SubTree(name, new BehaviorTree(dummy));
        }

        LogMgr.err(`SubTree "${name}" 缺少 subTree 或 subTreePath 字段`);
        const dummy = new Condition("dummy", () => false);
        return new SubTree(name, new BehaviorTree(dummy));
    }
}
