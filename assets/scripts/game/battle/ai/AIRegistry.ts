import type { Entity } from '../Entity';
import type { BattleContext } from '../BattleContext';
import { MonsterAI } from './MonsterAI';

/**
 * ============================================================
 * AIRegistry —— 怪物 AI 注册表（配置 → 脚本实例的工厂）
 * ============================================================
 *
 * units.json 的怪物配置：
 *   "ai": { "type": "chase", "params": { "speedMul": 1.2 } }
 *
 * BattleContext.CreateEntityFromDef 时调用：
 *   const ai = AIRegistry.create(def.ai, entity, ctx);
 *   entity.ai = ai;
 *
 * 新增 AI 类型：实现一个 MonsterAI 子类 → registerAI('xxx', XxxAI) → 配置引用即可。
 */
type AIConstructor = new (entity: Entity, ctx: BattleContext, params?: Record<string, any>) => MonsterAI;

export class AIRegistry {
    private static registry = new Map<string, AIConstructor>();

    /** 注册 AI 类型（游戏启动时调用） */
    static registerAI(type: string, ctor: AIConstructor): void {
        if (AIRegistry.registry.has(type)) {
            console.warn(`[AIRegistry] 重复注册 AI: ${type}`);
            return;
        }
        AIRegistry.registry.set(type, ctor);
    }

    /** 按配置创建 AI 实例（无配置/未注册返回 null） */
    static create(config: { type: string; params?: Record<string, any> } | undefined | null, entity: Entity, ctx: BattleContext): MonsterAI | null {
        if (!config || !config.type) return null;
        const ctor = AIRegistry.registry.get(config.type);
        if (!ctor) {
            console.warn(`[AIRegistry] 未注册的 AI 类型: ${config.type}`);
            return null;
        }
        const ai = new ctor(entity, ctx, config.params);
        ai.onAttach();
        return ai;
    }

    /** 是否存在某类型 */
    static has(type: string): boolean {
        return AIRegistry.registry.has(type);
    }

    /** 清空（场景销毁时可选调用） */
    static clear(): void {
        AIRegistry.registry.clear();
    }
}
