# 集合防御 (Jihe Defence) — Cocos Creator 肉鸽塔防

Cocos Creator 3.8.6 TypeScript 项目。一款俯视角 roguelike 塔防游戏，含自定义反应式框架、行为树、FSM、技能/Buff 系统。

## Project

- **引擎**: Cocos Creator 3.8.6 (`package.json` → `creator.version`)
- **语言**: TypeScript (strict 关闭, `tsconfig.json`)
- **入口组件**: `assets/scripts/game/scene/Main.ts` — `@ccclass('Main')` 挂载于首场景
- **全局门面**: `assets/scripts/platform/ezgame.ts` — `window.ezgame` 暴露 `ui` / `res` / `debug` / `info` / `warn` / `error`

## Commands

| 用途 | 命令 |
|------|------|
| 构建 | Cocos Creator 编辑器中构建（无 CLI 脚本） |
| 类型检查 | `npx tsc --noEmit` |
| 运行 | Cocos Creator 编辑器直接预览 |

无 npm 脚本（`package.json` 仅记录项目名和 UUID）。

## Architecture

```
assets/scripts/
├── platform/          ← 可复用游戏框架层
│   ├── reactivity/    Vue 风格响应式系统 (reactive, ref, watch, computed, effect)
│   ├── ui/            UI 框架 (UIMgr, BaseView, @uiview/@bind/@bindValue 装饰器)
│   ├── behavior/      行为树 (Selector, Sequence, Parallel, Decorator, Condition, Action)
│   ├── fsm/           有限状态机 (层级 FSM)
│   ├── event/         全局事件管理器 (GlobalEventMgr)
│   ├── resources/     资源/分包管理 (ResMgr 3000+ 行, BundMgr)
│   ├── scene/         场景切换管理 (SceneMgr 单例)
│   ├── excel_table/   配表框架 (TbRoot 管线, TbContainer, ITbDecode)
│   ├── audio/         音频管理器
│   ├── log/           日志系统 (等级控制, 开关)
│   ├── pool/          对象池
│   ├── red/           红点系统
│   ├── guide/         新手引导
│   ├── time/          时间管理器
│   └── utils/         TypeUtil
│
└── game/              ← 游戏业务逻辑
    ├── battle/        战斗系统
    │   ├── core/      类型定义 (Types.ts), 事件总线 (EventBus.ts)
    │   ├── attribute/ 属性集 (AttributeSet)
    │   ├── buff/      Buff 管理器 + 元素效果 (灼烧/冰冻/毒/连锁闪电/爆炸/暗影)
    │   ├── skill/     技能系统 (BaseSkill → PassiveSkill / ActiveSkill)
    │   ├── combat/    战斗结算 (CombatSystem)
    │   ├── entity/    实体体系 (BattleEntity → HeroEntity/EnemyEntity/SummonEntity/ProjectileEntity)
    │   └── hero/      英雄配置 (HERO_CONFIGS 8 个英雄)
    ├── data/          数据层
    │   ├── DataCenter 数据中心单例 (持 PlayerInfo / HeroData / ItemData 模块)
    │   ├── DataModule 响应式数据基类 (reactive + localStorage 自动保存)
    │   └── funcs/     数据模块实现
    ├── scene/         场景预制体组件 (Scene_Menu, Scene_Game_Stage)
    ├── game_stage/    游戏阶段状态机 (HeroSelectionState 等)
    ├── excel_table/   配置表实现 (ConfigLoader + 各域 Tb_*Config 容器/解码器)
    ├── ui/            游戏 UI 组件
    └── common/        公共 (EventKeys, GraphCircle)
```

**关键数据流**: `DataModule` → `reactive` 数据 → 组件读取 `this.data.xxx` → 自动 `watch` → debounce 100ms 写入 `localStorage`

**战斗事件流**: `EventBus.emit('combat:*')` → 技能/Buff/UI 监听 → 解耦通信

## Conventions

- **命名**: PascalCase 类/接口/枚举, camelCase 方法/属性, kebab-case 文件/文件夹
- **装饰器**: `@ccclass('Name')` 标记所有 Cocos 组件; `@uiview({prefabPath, layer, single})` 注册视图
- **UI 绑定**: `@bind(Button, "btnName")` 绑定节点; `@bindValue(Label)` 绑定组件值
- **单例**: 静态 `ins` / `inst` 属性 + 私有 `constructor` (Cocos 组件用 UIManager.ins)
- **注释**: JSDoc 风格 /** ... */ 中文注释, 关键接口含使用示例
- **缩进**: 4 空格 (TypeScript)
- **导入**: 相对路径显式导入, 不批量 `import *`; `platform/` 内部引用用相对路径
- **响应式**: 数据模块继承 `DataModule<T>`, 实现 `defaultData()`; `reactive` 数据直接读写
- **模块导出**: 每个模块 `index.ts` 统一导出, 如 `import { EventBus } from '../battle'`
- **字符集**: 源码注释为简体中文, 标识符/代码为英文
- **配置系统**: 所有游戏数据从 JSON 配置表加载（`assets/resources/tb/*.json`），通过 `TbRoot` 管线 + `ConfigLoader` 在 `Main.start()` 时加载。加载顺序：`await ConfigLoader.loadAll()` → `SkillManager.initializeRegistry()`
  | JSON 文件 (`assets/resources/tb/`) | 容器/解码器 (`game/excel_table/`) | 查询方式 |
  |---|---|---|
  | `heroes.json` | `Tb_HeroConfig.ts` | `ConfigLoader.getHeroContainer().getCfgByCode('sniper')` |
  | `growth_curves.json` | `Tb_GrowthCurveConfig.ts` | `getCfgByCode('attack')` |
  | `equipments.json` | `Tb_EquipmentConfig.ts` | `getCfgByCode('d2_battlefury')` |
  | `skills.json` | `Tb_SkillConfig.ts` | `getCfgByCode('attack_boost')` |
  | `enemies.json` | `Tb_EnemyConfig.ts` | `getCfgByCode('melee_soldier')` |
  | `battle_constants.json` | `Tb_BattleConstConfig.ts` | `BattleConstUtil.getNumber('minDamage')` |
  | `element_effects.json` | `Tb_ElementEffectConfig.ts` | `getCfgByCode('burn')` |
  | `phases.json` | `Tb_PhaseConfig.ts` | `getCfgByCode('phase_1')` |
  | 配置管线框架 | `platform/excel_table/` (TbRoot, TbContainer, ITbDecode) | — |
  | 业务层封装 | `game/battle/hero/HeroConfig.ts` 等模块导出函数保持与原 API 一致 | — |
  | 战斗常量 | `game/battle/core/BattleConstUtil.ts` 通过 `getNumber(key, default)` 全局访问 | — |

## Notes

<!-- 快速记录存放处 -->
