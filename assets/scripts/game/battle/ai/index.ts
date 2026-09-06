/**
 * battle/ai —— 怪物 AI 脚本系统统一导出
 *
 * 用法：
 *   1. 游戏启动时调用 AIRegistry.initialize() 注册内置 AI
 *   2. units.json 怪物配置 "ai": { "type": "chase" }，创建实体时自动挂载
 */
import { MonsterAI } from './MonsterAI';
import { AIRegistry } from './AIRegistry';
import { ChaseAI } from './ChaseAI';
import { WanderAI } from './WanderAI';
import { OrbitAI } from './OrbitAI';
import { AttackStopAI } from './AttackStopAI';
import { BossAI } from './BossAI';

/** 注册全部内置 AI（Main 启动时调用一次） */
export function initializeAI(): void {
    AIRegistry.registerAI('chase', ChaseAI);
    AIRegistry.registerAI('wander', WanderAI);
    AIRegistry.registerAI('orbit', OrbitAI);
    AIRegistry.registerAI('attack_stop', AttackStopAI);
    AIRegistry.registerAI('boss', BossAI);
}

export { MonsterAI, AIRegistry, ChaseAI, WanderAI, OrbitAI, AttackStopAI, BossAI };
