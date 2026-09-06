# 状态机（FSM）教学 — 从简单到复杂

> 本文以 **Cocos Creator + TypeScript** 为例，代码取自本项目 `platform/fsm/` 的实际实现。
> 从最直观的 if-else 开始，一步步进化到泛型、层级状态机。
> **建议打开 IDE 边看边敲，每个阶段代码量都很小。**

---

## 目录

1. [什么是状态机](#1-什么是状态机)
2. [第 1 层：if-else 硬编码](#2-第-1-层if-else-硬编码)
3. [第 2 层：enum + switch](#3-第-2-层enum--switch)
4. [第 3 层：状态模式（State Pattern）](#4-第-3-层状态模式state-pattern)
5. [第 4 层：泛型状态机框架](#5-第-4-层泛型状态机框架)
6. [第 5 层：真实案例 — 敌人 AI](#6-第-5-层真实案例--敌人-ai)
7. [第 6 层：层级状态机（Hierarchical FSM）](#7-第-6-层层级状态机hierarchical-fsm)
8. [第 7 层：游戏流程状态机](#8-第-7-层游戏流程状态机)
9. [设计要点总结](#9-设计要点总结)
10. [常见问题](#10-常见问题)

---

## 1. 什么是状态机

**有限状态机**（Finite State Machine, FSM）是一个拥有 **有限个状态**、并且 **同一时刻只能处于一个状态** 的模型。

```
     ┌──────────────────────────────────────────────────┐
     │                   状态机                           │
     │                                                    │
     │   ┌──────────┐      ┌──────────┐      ┌──────────┐│
     │   │   Idle   │ ──►  │  Chase   │ ──►  │  Attack  ││
     │   │  (空闲)   │      │  (追击)   │      │  (攻击)   ││
     │   └──────────┘      └──────────┘      └──────────┘│
     │         │                              │           │
     │         ▼                              ▼           │
     │   ┌──────────┐                   ┌──────────┐      │
     │   │  Stunned  │                   │   Dead   │      │
     │   │  (受控)   │                   │  (死亡)   │      │
     │   └──────────┘                   └──────────┘      │
     └──────────────────────────────────────────────────────┘
```

### 三个核心概念

| 概念 | 说明 | 代码体现 |
|------|------|----------|
| **状态（State）** | 对象在某个时刻的稳定形态 | `Idle`, `Chase`, `Attack` |
| **转移（Transition）** | 从一个状态切换到另一个 | `changeState(Chase)` |
| **动作（Action）** | 进入/退出/持续执行的行为 | `onEnter`, `onExit`, `onUpdate` |

> 💡 **直觉理解**：状态机就像 vending machine（自动售货机）——不同状态下按同一个按钮结果不同：没投钱按按钮 → 没反应；投了钱按按钮 → 出货。

---

## 2. 第 1 层：if-else 硬编码

最直接的做法：用一个变量记录当前状态，然后在 `update` 里用 if-else 判断。

```typescript
// Enemy_IfElse.ts — 最原始的 if-else 状态机

enum AIState {
  Idle, Chase, Attack, Dead
}

class Enemy_IfElse {
  private state: AIState = AIState.Idle;
  private idleTimer = 0.3;
  private attackTimer = 0;

  update(dt: number) {
    if (this.state === AIState.Idle) {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        console.log("开始追击");
        this.state = AIState.Chase;  // ← 直接改变量
      }
    } 
    else if (this.state === AIState.Chase) {
      const dist = this.calcDistanceToHero();
      if (dist < 5) {
        console.log("进入攻击范围");
        this.state = AIState.Attack;
      } else {
        this.moveTowardHero(dt);
      }
    } 
    else if (this.state === AIState.Attack) {
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) {
        this.attackTimer = 1.0;
        console.log("攻击！");
      }
      // 如果目标跑远了就切回 Chase
      if (this.calcDistanceToHero() > 6) {
        this.state = AIState.Chase;
      }
    } 
    else if (this.state === AIState.Dead) {
      // 死亡动画 ...
    }
  }
}
```

**优点**：零设计，零文件，零学习成本。

**缺点**（很快就忍不了）：

```
╔══════════════════════════════════════════════════╗
║  问题                        后果                  ║
╠══════════════════════════════════════════════════╣
║  所有逻辑混在一个函数里         一坨，难以阅读            ║
║  新增状态要改 update 函数      容易漏掉或破坏现有逻辑       ║
║  状态转移代码散落在各处         很难理清完整的状态图         ║
║  无法复用状态逻辑              "复制粘贴改" 恶性循环        ║
╚══════════════════════════════════════════════════╝
```

> **什么时候用**：状态不超过 3 个，且不会再增加。

---

## 3. 第 2 层：enum + switch

把 if-else 换成 switch，结构清晰了一点。

```typescript
// Enemy_Switch.ts — switch 版本

enum AIState {
  Idle, Chase, Attack, Dead
}

class Enemy_Switch {
  private state: AIState = AIState.Idle;
  private idleTimer = 0.3;
  private attackTimer = 0;

  update(dt: number) {
    switch (this.state) {
      case AIState.Idle:
        this.updateIdle(dt);
        break;
      case AIState.Chase:
        this.updateChase(dt);
        break;
      case AIState.Attack:
        this.updateAttack(dt);
        break;
      case AIState.Dead:
        this.updateDead(dt);
        break;
    }
  }

  private updateIdle(dt: number) {
    this.idleTimer -= dt;
    if (this.idleTimer <= 0) this.state = AIState.Chase;
  }

  private updateChase(dt: number) {
    const dist = this.calcDistanceToHero();
    if (dist < 5) this.state = AIState.Attack;
    else this.moveTowardHero(dt);
  }

  private updateAttack(dt: number) {
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      this.attackTimer = 1.0;
      this.doAttack();
    }
    if (this.calcDistanceToHero() > 6) this.state = AIState.Chase;
  }

  private updateDead(_dt: number) { /* 死亡动画 */ }
}
```

把每个状态的逻辑拆到了独立方法里，阅读性提升了。但**本质没变**——逻辑还是和这个类强耦合，无法独立复用每个状态。

---

## 4. 第 3 层：状态模式（State Pattern）

**核心思想**：把每个状态封装成一个独立的类，实现统一的接口。状态机只管"当前是哪个状态"和"如何切换"。

### 4.1 先定义状态接口

```typescript
// IState.ts

/**
 * 状态接口 — 生命周期方法都是可选的
 * T 是上下文类型，状态通过它访问共享数据
 */
export interface IState<T> {
  /** 进入状态时调用 */
  onEnter?(context: T, ...params: any[]): void;
  
  /** 每帧更新（状态机驱动） */
  onUpdate?(context: T, deltaTime: number): void;
  
  /** 退出状态时调用 */
  onExit?(context: T): void;
}
```

### 4.2 实现简单的状态机

```typescript
// SimpleStateMachine.ts

import { IState } from './IState';

export class SimpleStateMachine<T> {
  private states: Map<string, IState<T>> = new Map();
  private currentStateName: string = '';
  public context: T;

  constructor(context: T) {
    this.context = context;
  }

  /** 注册一个状态 */
  registerState(name: string, state: IState<T>): void {
    this.states.set(name, state);
  }

  /** 切换状态 */
  changeState(name: string, ...params: any[]): void {
    // 退出当前状态
    const current = this.states.get(this.currentStateName);
    current?.onExit?.(this.context);

    // 记录新状态
    this.currentStateName = name;

    // 进入新状态
    const next = this.states.get(name);
    next?.onEnter?.(this.context, ...params);
  }

  /** 驱动当前状态的 onUpdate */
  update(dt: number): void {
    const current = this.states.get(this.currentStateName);
    if (current && 'onUpdate' in current) {
      (current as any).onUpdate(this.context, dt);
    }
  }

  getCurrentState(): string {
    return this.currentStateName;
  }

  isState(name: string): boolean {
    return this.currentStateName === name;
  }
}
```

### 4.3 用状态模式写敌人 AI

```typescript
// 1. 定义枚举（用字符串，方便调试看日志）
enum EnemyAIState {
  Idle    = "Idle",
  Chase   = "Chase",
  Attack  = "Attack",
  Stunned = "Stunned",
  Dead    = "Dead",
}

// 2. 实现每个状态类

class IdleState implements IState<Enemy> {
  onEnter(ctx: Enemy): void {
    ctx.idleTimer = 0.3;
    console.log("进入 Idle");
  }
  onUpdate(ctx: Enemy, dt: number): void {
    ctx.idleTimer -= dt;
    if (ctx.idleTimer <= 0) {
      ctx.fsm.changeState(EnemyAIState.Chase);
    }
  }
}

class ChaseState implements IState<Enemy> {
  onUpdate(ctx: Enemy, dt: number): void {
    const dist = ctx.calcDistanceToHero();
    if (dist < 5) {
      ctx.fsm.changeState(EnemyAIState.Attack);
    } else {
      ctx.moveTowardHero(dt);
    }
  }
}

class AttackState implements IState<Enemy> {
  onEnter(ctx: Enemy): void {
    ctx.attackTimer = 0; // 下一次 update 就攻击
  }
  onUpdate(ctx: Enemy, dt: number): void {
    const dist = ctx.calcDistanceToHero();
    if (dist > 6) {
      ctx.fsm.changeState(EnemyAIState.Chase);
      return;
    }
    ctx.attackTimer -= dt;
    if (ctx.attackTimer <= 0) {
      ctx.attackTimer = 1.0;
      ctx.doAttack();
    }
  }
}

class StunnedState implements IState<Enemy> {
  onEnter(ctx: Enemy, duration: number): void {
    ctx.stunTimer = duration;
    console.log(`被眩晕 ${duration} 秒`);
  }
  onUpdate(ctx: Enemy, dt: number): void {
    ctx.stunTimer -= dt;
    if (ctx.stunTimer <= 0) {
      ctx.fsm.changeState(EnemyAIState.Chase);
    }
  }
}

class DeadState implements IState<Enemy> {
  onEnter(ctx: Enemy): void {
    ctx.isAlive = false;
    console.log("敌人死亡");
  }
}

// 3. 在 Enemy 类中使用

class Enemy {
  fsm = new SimpleStateMachine<Enemy>(this);
  idleTimer = 0;
  attackTimer = 0;
  stunTimer = 0;
  isAlive = true;

  constructor() {
    this.fsm.registerState(EnemyAIState.Idle,    new IdleState());
    this.fsm.registerState(EnemyAIState.Chase,   new ChaseState());
    this.fsm.registerState(EnemyAIState.Attack,  new AttackState());
    this.fsm.registerState(EnemyAIState.Stunned, new StunnedState());
    this.fsm.registerState(EnemyAIState.Dead,    new DeadState());
    this.fsm.changeState(EnemyAIState.Idle);     // 开局 Idle
  }

  update(dt: number): void {
    this.fsm.update(dt);  // 一行代码驱动 AI
  }

  // 外部调用：受击触发眩晕
  applyStun(duration: number): void {
    this.fsm.changeState(EnemyAIState.Stunned, duration);
  }
}
```

### 状态模式的优点

```
┌─────────────────────────────────────────────────────────────┐
│  1. 每个状态独立成类，职责单一                                 │
│  2. 新增/删除状态不影响其他状态                                 │
│  3. 状态可以单独测试                                           │
│  4. 状态转移集中在 changeState 调用点，容易追踪                  │
│  5. 状态类可以复用（多个敌人类型共享同一个 IdleState）            │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. 第 4 层：泛型状态机框架

第 3 层的 `SimpleStateMachine` 已经很好了，但实际项目还需要更多功能。来看看本项目的完整实现。

> 源代码在 `assets/scripts/platform/fsm/` 下，三个文件：

### 文件结构

```
platform/fsm/
├── fsm_type.ts        # 接口定义
├── fsm_core.ts        # 核心状态机（带批量注册、autoUpdate、input 分发等）
└── fsm_hierarchical.ts # 层级状态机（扩展）
```

### 5.1 接口定义（`fsm_type.ts`）

```typescript
/** 基础状态接口（所有方法可选） */
export interface IState<T> {
    onEnter?(context: T, ...params: any[]): void;
    onUpdate?(context: T, deltaTime: number): void;
    onExit?(context: T): void;
}

/** 强制 onUpdate 的状态（编译期约束） */
export interface IUpdatableState<T> extends IState<T> {
    onUpdate(context: T, deltaTime: number): void;
}

/** 带输入处理的状态 */
export interface IInputState<T> extends IState<T> {
    onInput?(context: T, inputType: string, data: any): void;
}
```

### 5.2 核心状态机（`fsm_core.ts`）

关键特性对比之前的简化版：

| 特性 | 说明 |
|------|------|
| **两种注册方式** | `registerState(config)` 对象方式 / `registerState(name, state, autoUpdate)` 参数方式 |
| **批量注册** | `registerStates(configs[])` 一次注册多个 |
| **autoUpdate 开关** | 每个状态可以独立控制是否自动调用 `onUpdate` |
| **状态变更回调** | `onStateChanged(from, to)` 全局监听 |
| **启用/禁用** | `setEnabled(false)` 暂停状态机 |
| **重置** | `reset()` 清空所有状态 |
| **getPreviousState** | 获取上一个状态，用于"恢复"场景 |
| **handleInput** | 向当前状态分发输入事件 |

```typescript
// 完整核心框架（无注释版便于阅读，有注释版见源文件）

export interface StateConfig<T> {
    name: string;
    state: IState<T>;
    autoUpdate?: boolean;
}

export class StateMachine<T> {
    private states: Map<string, IState<T>> = new Map();
    private autoUpdateMap: Map<string, boolean> = new Map();
    private currentStateName: string = '';
    private previousStateName: string = '';
    private isEnabled: boolean = true;
    context: T;
    public onStateChanged: (fromState: string, toState: string) => void = null;

    constructor(context: T, initialStates?: StateConfig<T>[]) {
        this.context = context;
        if (initialStates) {
            initialStates.forEach(config => this.registerState(config));
        }
    }

    // ─── 有两种调用方式 ───
    
    registerState(config: StateConfig<T>): void;
    registerState(name: string, state: IState<T>, autoUpdate?: boolean): void;

    registerState(nameOrConfig: string | StateConfig<T>, 
                  state?: IState<T>, autoUpdate: boolean = true): void {
        let name: string, stateInstance: IState<T>, shouldAutoUpdate: boolean;
        if (typeof nameOrConfig === 'string') {
            name = nameOrConfig;
            stateInstance = state!;
            shouldAutoUpdate = autoUpdate;
        } else {
            name = nameOrConfig.name;
            stateInstance = nameOrConfig.state;
            shouldAutoUpdate = nameOrConfig.autoUpdate !== false;
        }
        this.states.set(name, stateInstance);
        this.autoUpdateMap.set(name, shouldAutoUpdate);
    }

    registerStates(configs: StateConfig<T>[]): void {
        configs.forEach(config => this.registerState(config));
    }

    changeState(stateName: string, ...params: any[]): boolean {
        if (!this.isEnabled || !this.states.has(stateName)) return false;

        // 退出当前状态
        const currentState = this.states.get(this.currentStateName);
        currentState?.onExit?.(this.context);
        
        // 记录切换
        this.previousStateName = this.currentStateName;
        this.currentStateName = stateName;
        
        // 进入新状态
        const newState = this.states.get(stateName);
        newState?.onEnter?.(this.context, ...params);
        
        this.onStateChanged?.(this.previousStateName, stateName);
        return true;
    }

    update(deltaTime: number): void {
        if (!this.isEnabled || !this.currentStateName) return;
        const state = this.states.get(this.currentStateName);
        if (this.autoUpdateMap.get(this.currentStateName) && state && 'onUpdate' in state) {
            (state as any).onUpdate(this.context, deltaTime);
        }
    }

    handleInput(inputType: string, data?: any): void {
        const state = this.states.get(this.currentStateName);
        if (state && 'onInput' in state) {
            (state as any).onInput(this.context, inputType, data);
        }
    }

    getCurrentState(): string       { return this.currentStateName; }
    getPreviousState(): string      { return this.previousStateName; }
    isState(stateName: string): boolean  { return this.currentStateName === stateName; }
    hasState(stateName: string): boolean { return this.states.has(stateName); }
    
    setEnabled(enabled: boolean): void {
        this.isEnabled = enabled;
        if (!enabled) this.states.get(this.currentStateName)?.onExit?.(this.context);
    }

    reset(): void {
        this.states.get(this.currentStateName)?.onExit?.(this.context);
        this.currentStateName = '';
        this.previousStateName = '';
        this.isEnabled = true;
    }

    getAllStateNames(): string[] {
        return Array.from(this.states.keys());
    }
}
```

---

## 6. 第 5 层：真实案例 — 敌人 AI

项目中的 `EnemyEntity` 和 `EnemyAIState` 是 FSM 最完整的使用案例。

### 状态图

```
                     出生后 0.3 秒
    ┌──────┐  ──────────────────────►  ┌───────┐
    │ Idle │                            │ Chase │
    └──────┘  ◄──────────────────────── └───────┘
                  英雄死亡 → 回到 Idle       │
                                            │ 进入射程
                                            ▼
              ┌──────────┐              ┌───────┐
              │ Stunned  │  ◄──────────  │ Attack│
              │ (受控)    │  被技能命中    └───────┘
              └──────────┘                  │
                   │                        │ HP ≤ 0
                   ▼                        ▼
              ┌──────────┐              ┌───────┐
              │  Chase   │              │  Dead │
              └──────────┘              └───────┘
```

### EnemyEntity（敌人实体）

```typescript
// EnemyEntity.ts（节选）
@ccclass('EnemyEntity')
export class EnemyEntity extends BattleEntity {
    faction: 'enemy' = 'enemy';
    
    // AI 状态机
    aiFSM: StateMachine<EnemyEntity>;
    
    // 共享运行时数据
    idleTimer: number = 0;
    attackTimer: number = 0;
    stunTimer: number = 0;
    deadTimer: number = 0;
    isAlive: boolean = true;

    onLoad(): void {
        // 注册 5 个状态，构造时直接传入
        this.aiFSM = new StateMachine<EnemyEntity>(this, [
            { name: EnemyAIState.Idle,    state: new IdleState()    },
            { name: EnemyAIState.Chase,   state: new ChaseState()   },
            { name: EnemyAIState.Attack,  state: new AttackState()  },
            { name: EnemyAIState.Stunned, state: new StunnedState() },
            { name: EnemyAIState.Dead,    state: new DeadState()    },
        ]);
        this.aiFSM.changeState(EnemyAIState.Idle);
    }

    update(dt: number): void {
        if (!this.isAlive) return;
        this.aiFSM.update(dt);       // ← 驱动 AI
        super.update(dt);            // ← Buff/技能更新
    }

    // 外部调用：被控制技能命中
    applyStun(duration: number): void {
        this.aiFSM.changeState(EnemyAIState.Stunned, duration);
    }
}
```

### 5 个状态实现

```typescript
// EnemyAIState.ts（完整代码见源文件）

// ─── Idle：出生等待 ───
class IdleState implements IState<EnemyEntity> {
    onEnter(ctx: EnemyEntity): void {
        ctx.idleTimer = 0.3;  // 等待 0.3 秒入场
    }
    onUpdate(ctx: EnemyEntity, dt: number): void {
        ctx.idleTimer -= dt;
        if (ctx.idleTimer <= 0) {
            ctx.aiFSM.changeState(EnemyAIState.Chase);
        }
    }
}

// ─── Chase：追击英雄 ───
class ChaseState implements IState<EnemyEntity> {
    onUpdate(ctx: EnemyEntity, dt: number): void {
        const dist = Vec3.distance(ctx.node.position, heroPos);
        if (dist <= attackRange) {
            ctx.aiFSM.changeState(EnemyAIState.Attack);
        } else {
            // 朝英雄移动
            ctx.node.position = myPos.add(dir.multiplyScalar(speed * dt));
        }
    }
}

// ─── Attack：攻击 ───
class AttackState implements IState<EnemyEntity> {
    onEnter(ctx: EnemyEntity): void {
        ctx.attackTimer = 0;  // 进状态就立刻攻击
    }
    onUpdate(ctx: EnemyEntity, dt: number): void {
        // 目标跑远了 → 切回追击
        if (dist > range * 1.2) {
            ctx.aiFSM.changeState(EnemyAIState.Chase);
            return;
        }
        // 攻击冷却
        ctx.attackTimer -= dt;
        if (ctx.attackTimer > 0) return;
        ctx.attackTimer = 1.0 / attackSpeed;
        EventBus.emit(EventNames.ENEMY_ATTACK, { source: ctx, target: hero });
    }
}

// ─── Stunned：受控（眩晕/冰冻） ───
class StunnedState implements IState<EnemyEntity> {
    onEnter(ctx: EnemyEntity, duration: number): void {
        ctx.stunTimer = duration;  // 由外部传持续时间
    }
    onUpdate(ctx: EnemyEntity, dt: number): void {
        ctx.stunTimer -= dt;
        if (ctx.stunTimer <= 0) {
            ctx.aiFSM.changeState(EnemyAIState.Chase); // 恢复后继续追击
        }
    }
}

// ─── Dead：死亡 ───
class DeadState implements IState<EnemyEntity> {
    onEnter(ctx: EnemyEntity): void {
        ctx.isAlive = false;
        ctx.deadTimer = 0.5;  // 播放死亡动画
        EventBus.emit(EventNames.COMBAT_ON_KILL, { targetId: ctx.entityId });
    }
    onUpdate(ctx: EnemyEntity, dt: number): void {
        ctx.deadTimer -= dt;
        if (ctx.deadTimer <= 0) {
            Scene_Game_Stage.instance?.despawnEnemy(ctx); // 回收
        }
    }
}
```

### 关键设计点

1. **context = this** — 状态机 context 就是敌人自己，状态实现里可以直接访问 `ctx.attributes`、`ctx.node.position` 等
2. **onEnter 初始化，onUpdate 驱动** — 每个状态的 `onEnter` 设初始值，`onUpdate` 判断条件 + 切换
3. **外部注入参数** — `changeState(Stunned, duration)` 把持续时间传到 `onEnter`
4. **共享数据在实体上** — `idleTimer`、`attackTimer`、`stunTimer`、`deadTimer` 都在实体上声明

---

## 7. 第 6 层：层级状态机（Hierarchical FSM）

当状态越来越多时，有些状态其实是"父子关系"。比如：

```
战斗 (Battle)
  ├── 普通战斗 (NormalCombat)
  ├── Boss 战 (BossCombat)
  └── 暂停 (Pause)
```

层级状态机的作用：**切换子状态时，如果父状态还没激活，先自动激活父状态**。

### 7.1 层级状态机实现

```typescript
// fsm_hierarchical.ts
export class HierarchicalStateMachine<T> extends StateMachine<T> {
    private stateHierarchy: Map<string, string[]> = new Map(); 
    // 父状态 → 子状态列表, 例如: "Battle" → ["NormalCombat", "BossCombat"]

    /** 设置父子关系 */
    setParentChildRelation(parentState: string, childStates: string[]): void {
        this.stateHierarchy.set(parentState, childStates);
    }

    changeState(stateName: string, ...params: any[]): boolean {
        // 如果目标状态是某个父状态的子状态，且父状态未激活 → 先激活父状态
        for (const [parent, children] of this.stateHierarchy) {
            if (children.includes(stateName) && 
                this.getCurrentState() !== parent) {
                super.changeState(parent, ...params);
                break;
            }
        }
        return super.changeState(stateName, ...params);
    }
}
```

### 7.2 使用示例

```typescript
// 假设一个 RPG 战斗场景的层级状态机

const hfsm = new HierarchicalStateMachine<SomeContext>(context);

// 注册所有状态（扁平的）
hfsm.registerState("Battle",        new BattleState());
hfsm.registerState("NormalCombat",  new NormalCombatState());
hfsm.registerState("BossCombat",    new BossCombatState());
hfsm.registerState("Pause",         new PauseState());

// 设置父子关系
hfsm.setParentChildRelation("Battle", ["NormalCombat", "BossCombat"]);

// 使用：直接切子状态
hfsm.changeState("NormalCombat");
// → 自动先切到 "Battle"（onEnter 会初始化战场）
// → 再切到 "NormalCombat"

hfsm.changeState("BossCombat");
// → "Battle" 已经在激活状态了，不会重复 onEnter
// → 直接从 "NormalCombat" 切到 "BossCombat"
```

### 7.3 嵌套层级状态机示意图

```
场景状态机 (Scene_Game_Stage.fsm)
│
├── HeroSelection → [无子状态, 选英雄]
│
├── Battle (父状态, 持有战斗上下文)
│   ├── NormalCombat  ← 普通波次
│   ├── PhaseBoss     ← 阶段 Boss
│   └── FinalBoss     ← 最终 Boss
│
├── Pause → [无子状态, 暂停 UI]
│
├── Victory → [胜利结算]
│
└── Defeat → [失败结算]

切换示例:
  HeroSelection → Battle (自动进入 NormalCombat)
        │
        ▼
  NormalCombat → PhaseBoss (Battle 保持激活, 仅子状态切换)
        │
        ▼
  PhaseBoss → FinalBoss
        │
        ▼
  FinalBoss → Victory / Defeat
```

> 注：本项目的 `HierarchicalStateMachine` 已实现但当前代码中未投入使用。实际项目可以先从单层 FSM 开始，遇到"需要在父状态下管理子阶段"时才升级。

---

## 8. 第 7 层：游戏流程状态机

项目中另一个实际案例：用 FSM 管理整个游戏的关卡流程。

### 状态枚举

```typescript
// GameStateType.ts
export enum GameStateType {
    HeroSelection = "HeroSelection",   // 选英雄
    PreBattle     = "PreBattle",       // 战前准备
    Battle        = "Battle",          // 战斗中
    PhaseBoss     = "PhaseBoss",       // 阶段Boss
    FinalBoss     = "FinalBoss",       // 最终Boss
    Pause         = "Pause",           // 暂停
    Victory       = "Victory",         // 胜利
    Defeat        = "Defeat"           // 失败
}
```

### 使用方式

```typescript
// Scene_Game_Stage.ts 节选
export class Scene_Game_Stage extends BaseView<null, null> {
    fsm: StateMachine<any>;

    onLoad(): void {
        this.fsm = new StateMachine<any>({});
        (this.fsm.context as any).fsm = this.fsm;  // ← 让 context 自己持有 fsm
        this.fsm.registerState(GameStateType.HeroSelection, new HeroSelectionState(), true);
        this.fsm.registerState(GameStateType.Battle,        new BattleState(),        true);
        this.fsm.registerState(GameStateType.Pause,         new PauseState(),         true);
    }

    show(): void {
        this.fsm.changeState(GameStateType.HeroSelection);
    }

    // 选择英雄后进入战斗
    selectHero(heroId: string): void {
        if (this.fsm.isState(GameStateType.HeroSelection)) {
            this.hero = new HeroEntity();
            this.hero.initHero(heroId);
            this.fsm.changeState(GameStateType.Battle);
        }
    }

    // 暂停/恢复
    togglePause(): void {
        if (this.battleStore.isPaused) {
            this.fsm.changeState(GameStateType.Pause);
        } else {
            const prev = this.fsm.getPreviousState();
            this.fsm.changeState(prev ?? GameStateType.HeroSelection);
        }
    }

    update(dt: number): void {
        this.fsm.update(dt);  // 让当前状态的 onUpdate 运行

        // 暂停时不更新战斗实体
        if (this.fsm.isState(GameStateType.Pause)) return;

        this.updateEntities(dt);
        this.checkCollisions();
        this.cleanDeadEntities();
    }
}
```

### BattleState 实现

```typescript
// BattleState.ts
export class BattleState implements IState<any> {
    battleStore = useBattleStore();

    onEnter(context: any): void {
        console.log("进入战斗，当前阶段：", this.battleStore.phase);
    }

    onUpdate(context: any, deltaTime: number): void {
        // 倒计时，时间到进入下一阶段或最终 Boss
        let remain = this.battleStore.phaseRemainTime;
        remain -= deltaTime;
        if (remain <= 0) {
            if (this.battleStore.phase >= this.battleStore.maxPhase) {
                // 最终阶段 → 启动 Boss 战
                context.fsm.changeState(GameStateType.FinalBoss);
            } else {
                this.battleStore.phase++;
            }
        }
    }
}
```

---

## 9. 设计要点总结

### 9.1 FSM 设计步骤

```
Step 1: 列出所有状态
        └─ 画状态转移图（纸笔或 draw.io）

Step 2: 确定上下文（context）
        └─ 状态之间共享什么数据？

Step 3: 实现每个状态类
        └─ onEnter: 设置初始值
        └─ onUpdate: 判断条件 → 切换/执行行为
        └─ onExit: 清理（可选）

Step 4: 组装状态机
        └─ 注册所有状态
        └─ changeState(初始状态)

Step 5: 每帧驱动
        └─ 在 update 中调用 fsm.update(dt)
```

### 9.2 什么时候用状态机？

| 适合 | 不适合 |
|------|--------|
| 实体有明确的「状态」区分 | 只是简单的"开/关"（一个 boolean 就够了） |
| 不同状态下行为差异大 | 状态超过 15 个 → 考虑行为树 |
| 状态之间存在明确的转移条件 | 需要 AI 规划多个步骤 → 考虑行为树 |
| 状态数量稳定，不频繁增删 | 状态每天都在变 → 考虑配置驱动 |

### 9.3 与行为树的对比

```
状态机（FSM）                   行为树（Behavior Tree）
────────                      ─────────
状态 + 转移                   节点 + 组合器
逻辑散落在各个状态             逻辑集中在树结构
适合：AI 行为                  适合：复杂决策
状态数 ≤ 10 最佳              节点数可以成百上千
显式的转移条件                 隐式的优先级控制
运行时轻量                     运行时需要遍历树
```

> 本项目两套都有：`platform/fsm/` 给状态机，`platform/behavior/` 给行为树。

### 9.4 常见陷阱

1. ❌ **状态类里持有外部引用** — 状态是单例？还是每次 new？
   - 如果状态无状态（不存数据），可以复用同一实例
   - 如果状态需要存数据，每次 new 或使用 context 存

2. ❌ **onEnter 和 onUpdate 职责混淆**
   - `onEnter` = 初始化（设 timer、换动画、播声音）
   - `onUpdate` = 每帧判断（条件检测、状态切换）
   - 不要在 `onEnter` 里写可能一帧就完成的事情

3. ❌ **状态之间直接访问对方数据**
   - 共享数据放在 context 上
   - 状态只通过 context 交换数据

4. ✅ **正确的 context 使用**
   - `EnemyEntity` 的 context = `this`（敌人自己）
   - `Scene_Game_Stage` 的 context = `{}`（空对象，用于存 fsm 引用）

---

## 10. 常见问题

### Q: 状态实例应该复用还是每次都 new？

**复用**：如果状态类没有内部状态（只依赖 context），可以 `new IdleState()` 一次注册，永久生效。  
**不复用**：有些状态需要保存私有数据（不在 context 上的），比如计时器、计数器等。  
**推荐**：前期都用复用方式，有问题再改。

### Q: 状态太多怎么办？

- 如果超过 10 个状态 → 考虑是否能用层级状态机分组
- 如果超过 20 个状态 → 考虑行为树替代
- 如果某些状态只在特定条件下出现 → 考虑运行时动态注册/注销

### Q: changeState 可以在 onUpdate 之外调用吗？

可以。`enemy.applyStun(duration)` 就是从外部（Buff/技能系统）调用 `changeState`。  
这也是状态机的优势——**任何地方都能触发状态切换**。

### Q: 如何调试状态机？

1. 给状态用**有意义的字符串名**（枚举值用字符串而非数字）
2. 监听 `onStateChanged` 回调：
   ```typescript
   fsm.onStateChanged = (from, to) => {
       console.log(`[FSM] ${from || '初始'} → ${to}`);
   };
   ```
3. 在 Inspector 中显示当前状态：
   ```typescript
   @property
   currentStateDisplay: string = '';
   // 每帧更新: this.currentStateDisplay = this.fsm.getCurrentState();
   ```

---

> 💡 **一句话总结**：
> 状态机 = **用独立的类管理每个状态的行为 + 用统一接口切换状态**，让代码从面条式的 if-else 变成清晰可扩展的模块化结构。本项目从敌人 AI 到游戏流程都在用，适合所有「有明确状态变化」的场景。
