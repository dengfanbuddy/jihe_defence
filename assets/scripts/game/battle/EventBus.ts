import { BattleEvents } from './types';

/**
 * 类型安全的事件总线（发布-订阅模式）
 * 借鉴 Dota 2 的事件驱动架构：所有系统通过事件解耦，
 * 新增技能/Buff/遗物只需要订阅事件，无需修改核心代码。
 *
 * 双形态（统一入口，调用风格一致）：
 *   - 全局总线（跨场景/UI 通信）：`EventBus.emit('battle_exit', data)` / `EventBus.on(...)`
 *   - 实例总线（战斗内局部，如每场战斗的 ctx.bus）：`new EventBus()`，方法与全局一致
 *
 * 统一词汇：全局与实例均使用 `emit`(发布) / `on`(订阅) / `off`(退订) / `clear`(清空)。
 *   实例另保留旧别名 `publish` / `subscribe` / `unsubscribe`，语义一致（兼容战斗系统已有调用）。
 *
 * 用法：
 *   // 全局（静态门面）
 *   EventBus.emit(EventNames.BATTLE_EXIT, null);
 *   EventBus.on(EventNames.BATTLE_SELECT_HERO, (payload) => ...);
 *   EventBus.off(EventNames.BATTLE_SELECT_HERO, handler);  // 按 handler 精确移除
 *   EventBus.clear();                                       // 清空全部
 *
 *   // 实例（战斗局部），与全局同一套方法名
 *   const bus = new EventBus();
 *   bus.emit('on_death', { entity, killer });               // 旧别名: bus.publish(...)
 *   bus.on('on_death', handler);                            // 旧别名: bus.subscribe(...)
 *   bus.on('on_death', this.handleDeath, this);             // 传入 caller 绑定 this
 *   bus.off('on_death', handler);                           // 旧别名: bus.unsubscribe(...)
 *   bus.onBattleEvent(BattleEvents.OnDeath, handler);       // BattleEvents 常量简写
 */
export type EventHandler<T extends object = object> = (event: T) => void;
export type Unsubscribe = () => void;

/**
 * 订阅记录：handler 与调用对象（this 绑定）。
 * `caller` 缺省时，派发时 this 保持未绑定（与旧行为一致）。
 */
interface HandlerEntry {
    handler: Function;
    caller?: any;
}

/** 战斗事件值类型：'on_death' 等（与 BattleEvents 常量一致） */
export type BattleEventType = typeof BattleEvents[keyof typeof BattleEvents];

export class EventBus {
    private handlers = new Map<string, Set<HandlerEntry>>();

    // ============ 全局单例门面（静态） ============

    /** 全局唯一实例（跨场景/UI 通信用） */
    private static _global: EventBus | null = null;
    static get global(): EventBus {
        if (!EventBus._global) EventBus._global = new EventBus();
        return EventBus._global;
    }

    /** 发布全局事件（emit 语法） */
    static emit(type: string | number, payload?: any): void {
        EventBus.global.emit(String(type), payload);
    }

    /**
     * 订阅全局事件（on 语法；负载类型宽松，兼容旧代码 any 负载）
     * @param handler 回调函数
     * @param caller  调用对象（回调被触发时绑定的 this；可选）
     */
    static on(type: string | number, handler: (event: any) => void, caller?: any): Unsubscribe {
        return EventBus.global.on(String(type), handler, caller);
    }

    /**
     * 取消全局订阅（off 语法）
     * @param handler 传则精确移除该回调；不传则移除该事件的全部订阅
     * @param caller  传则仅移除绑定了该 caller 的那次订阅（与 handler 一并匹配；可选）
     */
    static off(type: string | number, handler?: EventHandler, caller?: any): void {
        EventBus.global.off(String(type), handler, caller);
    }

    /** 清空全局事件（全部或指定） */
    static clear(type?: string | number): void {
        if (type !== undefined) EventBus.global.clear(String(type));
        else EventBus.global.clear();
    }

    /** 重置全局总线（测试/热更新用） */
    static reset(): void {
        EventBus._global?.clear();
        EventBus._global = null;
    }

    // ============ 实例 API ============

    /** 发布事件（与全局 emit 一致的统一词汇；payload 缺省为空对象） */
    emit(type: string | number, payload?: any): void {
        this.publish(String(type), payload ?? {});
    }

    /**
     * 订阅事件，返回取消订阅函数（与全局 on 一致）
     * @param handler 回调函数
     * @param caller  调用对象（回调被触发时绑定的 this；可选）
     */
    on(type: string | number, handler: (event: any) => void, caller?: any): Unsubscribe {
        return this.subscribe(String(type), handler, caller);
    }

    /**
     * 取消订阅（与全局 off 一致的语义）
     * @param handler 传则精确移除该回调；不传则移除该事件的全部订阅
     * @param caller  传则仅移除绑定了该 caller 的那次订阅（与 handler 一并匹配；可选）
     */
    off(type: string | number, handler?: EventHandler, caller?: any): void {
        if (handler) this.unsubscribe(String(type), handler, caller);
        else this.clear(String(type));
    }

    /**
     * 订阅事件（旧别名 subscribe，等价于 on），返回取消订阅函数
     * @param caller 调用对象（回调被触发时绑定的 this；可选，配合 handler 一并存储）
     */
    subscribe<T extends object = object>(eventType: string, handler: EventHandler<T>, caller?: any): Unsubscribe {
        let set = this.handlers.get(eventType);
        if (!set) {
            set = new Set();
            this.handlers.set(eventType, set);
        }
        const entry: HandlerEntry = { handler, caller };
        set.add(entry);
        return () => {
            set.delete(entry);
            if (set.size === 0) this.handlers.delete(eventType);
        };
    }

    /**
     * 按回调精确移除（旧别名 unsubscribe，等价于 off(type, handler)）
     * @param caller 传则连同该调用对象一起匹配，仅移除那一次订阅；不传则移除所有绑定该 handler 的订阅
     */
    unsubscribe(eventType: string, handler: Function, caller?: any): void {
        const set = this.handlers.get(eventType);
        if (!set) return;
        for (const entry of set) {
            if (entry.handler === handler && (caller === undefined || entry.caller === caller)) {
                set.delete(entry);
            }
        }
        if (set.size === 0) this.handlers.delete(eventType);
    }

    /**
     * 发布事件（旧别名 publish，等价于 emit；同步分发，复制订阅列表避免遍历时增删导致异常）
     * 派发时以每个订阅记录的 caller 作为 this 调用。
     */
    publish<T extends object = object>(eventType: string, event: T): void {
        const set = this.handlers.get(eventType);
        if (!set || set.size === 0) return;
        const snapshot = Array.from(set);
        for (const entry of snapshot) {
            (entry.handler as EventHandler<T>).call(entry.caller, event);
        }
    }

    /** 订阅标准战斗事件（简写）：传 BattleEvents 常量，如 onBattleEvent(BattleEvents.OnDeath, handler, this) */
    onBattleEvent(eventType: BattleEventType, handler: EventHandler, caller?: any): Unsubscribe {
        return this.subscribe(eventType, handler, caller);
    }

    /** 清空事件（全部或指定事件类型） */
    clear(eventType?: string): void {
        if (eventType) this.handlers.delete(eventType);
        else this.handlers.clear();
    }
}
