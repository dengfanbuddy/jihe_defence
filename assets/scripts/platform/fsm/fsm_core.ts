// Framework/FSM/StateMachine.ts
import { _decorator, Component, warn } from 'cc';
import { IState } from './fsm_type';
import { GameStateType } from '../../game/game_stage/GameStateType';
import { HeroSelectionState } from '../../game/game_stage/states/HeroSelectionState';
const { ccclass, property } = _decorator;

/**
 * 状态配置
 */
export interface StateConfig<T> {
    name: string;           // 状态名称
    state: IState<T>;       // 状态实例
    autoUpdate?: boolean;   // 是否自动调用onUpdate（默认true）
}

/**
 * 通用状态机
 */
export class StateMachine<T> {
    private states: Map<string, IState<T>> = new Map();
    private autoUpdateMap: Map<string, boolean> = new Map();
    private currentStateName: string = '';
    private previousStateName: string = '';
    context: T;
    private isEnabled: boolean = true;
    
    // 状态变更事件
    //@ts-ignore
    public onStateChanged: (fromState: string, toState: string) => void = null;
    
    constructor(context: T, initialStates?: StateConfig<T>[]) {
        this.context = context;
        if (initialStates) {
            initialStates.forEach(config => this.registerState(config));
        }
    }
    
    /**
     * 方式1：使用配置对象注册
     */
    registerState(config: StateConfig<T>): void;
    
    /**
     * 方式2：使用参数注册（自动创建配置）
     */
    registerState(name: string, state: IState<T>, autoUpdate?: boolean): void;
    
    /**
     * 方式3：通用实现（支持两种调用方式）
     */
    registerState(nameOrConfig: string | StateConfig<T>, state?: IState<T>, autoUpdate: boolean = true): void {
        let name: string;
        let stateInstance: IState<T>;
        let shouldAutoUpdate: boolean;
        
        // 判断调用方式
        if (typeof nameOrConfig === 'string') {
            // 方式2：registerState(name, state, autoUpdate)
            name = nameOrConfig;
            stateInstance = state!;
            shouldAutoUpdate = autoUpdate;
        } else {
            // 方式1：registerState(config)
            name = nameOrConfig.name;
            stateInstance = nameOrConfig.state;
            shouldAutoUpdate = nameOrConfig.autoUpdate !== false;
        }
        
        // 检查重复
        if (this.states.has(name)) {
            warn(`状态 [${name}] 已经存在，将被覆盖`);
        }
        
        // 注册
        this.states.set(name, stateInstance);
        this.autoUpdateMap.set(name, shouldAutoUpdate);
    }

    
    /**
     * 批量注册状态
     */
    registerStates(configs: StateConfig<T>[]): void {
        configs.forEach(config => this.registerState(config));
    }
    
    /**
     * 切换状态
     */
    changeState(stateName: string, ...params: any[]): boolean {
        if (!this.isEnabled) {
            warn(`状态机已禁用，无法切换到 [${stateName}]`);
            return false;
        }
        
        if (!this.states.has(stateName)) {
            warn(`状态 [${stateName}] 不存在`);
            return false;
        }
        
        // 退出当前状态
        if (this.currentStateName) {
            const currentState = this.states.get(this.currentStateName);
            currentState?.onExit?.(this.context);
        }
        
        // 记录状态切换
        this.previousStateName = this.currentStateName;
        this.currentStateName = stateName;
        
        // 进入新状态
        const newState = this.states.get(stateName);
        newState?.onEnter?.(this.context, ...params);
    
        this.onStateChanged?.(this.previousStateName, stateName);
        
        return true;
    }
    
    /**
     * 每帧更新（需要在外部调用，通常在组件的update中）
     */
    update(deltaTime: number): void {
        if (!this.isEnabled || !this.currentStateName) return;
        
        const currentState = this.states.get(this.currentStateName);
        const shouldAutoUpdate = this.autoUpdateMap.get(this.currentStateName);
        
        // 如果状态实现了onUpdate且配置为自动更新
        if (shouldAutoUpdate && currentState && 'onUpdate' in currentState) {
            (currentState as any).onUpdate(this.context, deltaTime);
        }
    }
    
    /**
     * 处理输入（可选的输入分发）
     */
    handleInput(inputType: string, data?: any): void {
        if (!this.isEnabled || !this.currentStateName) return;
        
        const currentState = this.states.get(this.currentStateName);
        if (currentState && 'onInput' in currentState) {
            (currentState as any).onInput(this.context, inputType, data);
        }
    }
    
    /**
     * 获取当前状态名称
     */
    getCurrentState(): string {
        return this.currentStateName;
    }
    
    /**
     * 获取上一个状态名称
     */
    getPreviousState(): string {
        return this.previousStateName;
    }
    
    /**
     * 检查是否在指定状态
     */
    isState(stateName: string): boolean {
        return this.currentStateName === stateName;
    }
    
    /**
     * 检查状态是否存在
     */
    hasState(stateName: string): boolean {
        return this.states.has(stateName);
    }
    
    /**
     * 启用/禁用状态机
     */
    setEnabled(enabled: boolean): void {
        this.isEnabled = enabled;
        if (!enabled && this.currentStateName) {
            const currentState = this.states.get(this.currentStateName);
            currentState?.onExit?.(this.context);
        }
    }
    
    /**
     * 重置状态机
     */
    reset(): void {
        if (this.currentStateName) {
            const currentState = this.states.get(this.currentStateName);
            currentState?.onExit?.(this.context);
        }
        this.currentStateName = '';
        this.previousStateName = '';
        this.isEnabled = true;
    }
    
    /**
     * 获取所有注册的状态名
     */
    getAllStateNames(): string[] {
        return Array.from(this.states.keys());
    }
}