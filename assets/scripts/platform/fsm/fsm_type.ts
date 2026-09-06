// Framework/FSM/IState.ts
import { _decorator } from 'cc';
const { ccclass } = _decorator;

/**
 * 状态接口
 */
export interface IState<T> {
    /** 进入状态 */
    onEnter?(context: T, ...params: any[]): void;
    /** 更新状态（每帧调用） */
    onUpdate?(context: T, deltaTime: number): void;
    /** 退出状态 */
    onExit?(context: T): void;
}

/**
 * 可更新的状态接口（支持每帧更新）
 */
export interface IUpdatableState<T> extends IState<T> {
    onUpdate(context: T, deltaTime: number): void;
}

/**
 * 可响应用户输入的状态接口
 */
export interface IInputState<T> extends IState<T> {
    onInput?(context: T, inputType: string, data: any): void;
}