// Framework/FSM/HierarchicalStateMachine.ts
import { StateMachine, StateConfig } from './fsm_core';
import { IState } from './fsm_type';

/**
 * 层级状态机（支持子状态）
 */
export class HierarchicalStateMachine<T> extends StateMachine<T> {
    private parentStateMachine: StateMachine<T> | null = null;
    private stateHierarchy: Map<string, string[]> = new Map(); // 父状态 -> 子状态列表
    
    constructor(context: T, parentSM?: StateMachine<T>) {
        super(context);
        this.parentStateMachine = parentSM || null;
    }
    
    /**
     * 设置父子关系
     */
    setParentChildRelation(parentState: string, childStates: string[]): void {
        this.stateHierarchy.set(parentState, childStates);
    }
    
    /**
     * 进入状态（支持子状态自动进入父状态更新逻辑）
     */
    changeState(stateName: string, ...params: any[]): boolean {
        // 检查是否属于某个父状态的子状态
        for (const [parentState, children] of this.stateHierarchy) {
            if (children.includes(stateName)) {
                // 如果父状态未激活，先激活父状态
                if (this.getCurrentState() !== parentState) {
                    super.changeState(parentState, ...params);
                }
                // 然后在父状态下切换子状态
                break;
            }
        }
        
        return super.changeState(stateName, ...params);
    }
}