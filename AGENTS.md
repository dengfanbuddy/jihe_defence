# 集合防御 (Jihe Defence) — Cocos Creator 肉鸽塔防

Cocos Creator 3.8.6 TypeScript 项目。一款俯视角 roguelike 塔防游戏，含自定义反应式框架、行为树、FSM、技能/Buff 系统。

## Project

- **引擎**: Cocos Creator 3.8.6 (`package.json` → `creator.version`)
- **语言**: TypeScript (strict 关闭, `tsconfig.json`)
- **入口组件**: `assets/scripts/game/scene/Main.ts` — `@ccclass('Main')` 挂在 `assets/scenes/Main.scene`（加载配表后 `UIManager.showUI(Scene_Menu)`）；真正的**首场景**是 `assets/scenes/Loading.scene`（`Loading.ts` 先加载 `scripts` bundle + 配表，再 `director.loadScene('Main')`）
- **全局门面**: `assets/scripts/platform/ezgame.ts` — `window.ezgame` 暴露 `ui` / `res` / `debug` / `info` / `warn` / `error`

## Commands

| 用途 | 命令 |
|------|------|
| 构建 | Cocos Creator 编辑器中构建（无 CLI 脚本） |
| 导表（Excel → JSON） | `cd tools/excel_export && npm run export` |

根目录无 npm 脚本（`package.json` 仅记录项目名和 UUID）；配表工具另有独立 `tools/excel_export/package.json`，AI 出图工具另有独立 `tools/ark-style-transfer/package.json`。

## Architecture

```
assets/scripts/
├── platform/          ← 可复用游戏框架层
│   ├── reactivity/    Vue 风格响应式系统 (reactive, ref, watch, computed, effect, effectScope)
│   ├── store/         Pinia 风格状态管理 (defineStore / storeToRefs；游戏侧 store 在 game/stores/)
│   ├── ui/            UI 框架 (UIManager + BaseView/UIWidget + UIScope + Tabs/TabItem + @uiview/@bind/@bindValue)
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
    ├── battle/        战斗系统（核心为扁平结构）
    │   ├── core/      属性换算/类型/常量 (AttributeScaling.ts, Types.ts, EventBus.ts, BattleConstUtil.ts)
    │   ├── ai/        怪物 AI (ChaseAI/WanderAI/OrbitAI/AttackStopAI/BossAI, AIRegistry, MonsterAI)
    │   ├── Entity.ts / AttributeSystem.ts / Modifier.ts + ModifierSystem.ts
    │   ├── Ability.ts + AbilitySystem.ts / BattleEquipSystem.ts(遗物背包 + 属性)
    │   ├── 局内功能类（每个功能一个类，纯 TS 无 cc 依赖）: HeroSelect.ts(选英雄) / RelicShop.ts(肉鸽商店流程) + RelicDraw.ts(抽取规则·遗物+技能混合池) / SkillSlots.ts(技能槽:锁定·落槽·升级·冷却投影) + AbilityDesc.ts(技能详情文案) / BuffShop.ts(击杀商店 Buff)
    │   ├── DamagePipeline.ts / EffectExecutor.ts / ScriptedAbilities.ts / Targeting.ts
    │   ├── RunStats.ts(局内成长统计·一局的完整账本:属性按来源拆固定值/百分比 + 遗物/神器/掉落Buff/技能/限时状态/金币/击杀/等级/阶段时间线，**三条收尾路**（打完 `endRun` / 中途退出 `exit` / 控制台 `__runStatsDump()`）打一份可贴给 AI 的报告，JSON 挂 `window.__runStats`)
    │   └── BattleContext.ts（容器总入口 + CreateEntityFromDef）
    ├── data/          局外数据层
    │   ├── DataCenter 数据中心单例 (PlayerInfo / HeroData / ItemData / EquipmentCollection)
    │   ├── DataModule 响应式数据基类 (reactive + localStorage 自动保存) / StorageUtil
    │   ├── funcs/     数据模块实现 (PlayerInfo/HeroData/ItemData/EquipmentCollection)
    │   ├── OuterAttributeCalculator.ts（局外加成：final = base×(1+percent)+flat）
    │   └── configs/   EquipmentConfig.ts（局外遗物 → OuterBonusGroup；数据源 = relics.json 里有局外版的遗物，读 modifiers_outer）
    ├── scene/         场景预制体组件 (Scene_Menu, Scene_Game_Stage 在 game_stage/scene)
    ├── game_stage/    局内阶段状态机 (states: HeroSelection/Battle/Pause) + Hero.ts + Scene_Game_Stage.ts
    │   └── ui/ 局内 UI (View_Game_Stage, hero_select/...)；entityview/ 实体/弹道对象池与视图
    ├── excel_table/   配表容器 (各域 Tb_*Config.ts 容器，@tb_config 注册)
    ├── stores/        全局状态 store (useBattleStore / useUIStore，跨场景 + UI 共享)
    ├── ui/            游戏 UI 组件
    └── common/        公共 (EventKeys, GraphCircle)
```

**关键数据流**: `DataModule` → `reactive` 数据 → 组件读取 `this.data.xxx` → 自动 `watch` → debounce 100ms 写入 `localStorage`

**战斗事件流**: `EventBus.emit('combat:*')` → 技能/Buff/UI 监听 → 解耦通信

## Conventions

- **命名**: PascalCase 类/接口/枚举, camelCase 方法/属性, kebab-case 文件/文件夹
- **装饰器**: `@ccclass('Name')` 标记所有 Cocos 组件; `@uiview({prefabPath, layer, single})` 注册视图
- **UI 绑定**: `@bind(Button, "btnName")` 绑定节点; `@bindValue(Label)` 绑定组件值（两者按节点名 `&字段名` 解析，`@bindValue` 只支持 EditBox/Slider/Toggle/ToggleContainer/Label/ProgressBar；**当前项目实际都用 `@property` 显式拖引用**，见 `docs/UI框架使用说明.md`）
- **UI 通信**: 两层体系 —— `BaseView`(+`@uiview`) 归 UIManager 管；场景预制件里内嵌的页面/小组件用 `UIWidget`（**禁止**加 `@uiview`）。界面内部任意深度的通信：向下 `this.provide/this.inject`（UIScope）、向上 `this.scope.on/emit`、watcher 一律 `this.scope.watch`；跨界面共享只走 store。详见 Notes「UI 通信规约」。
- **单例**: 静态 `ins` / `inst` 属性 + 私有 `constructor` (Cocos 组件用 UIManager.ins)
- **注释**: JSDoc 风格 /** ... */ 中文注释, 关键接口含使用示例
- **缩进**: 4 空格 (TypeScript)
- **导入**: 相对路径显式导入, 不批量 `import *`; `platform/` 内部引用用相对路径
- **响应式**: 数据模块继承 `DataModule<T>`, 实现 `defaultData()`; `reactive` 数据直接读写
- **模块导出**: 每个模块 `index.ts` 统一导出, 如 `import { EventBus } from '../battle'`
- **字符集**: 源码注释为简体中文, 标识符/代码为英文
- **配置系统**: 所有游戏数据从 JSON 配置表加载（`assets/resources/tb/*.json`）。加载：`Main._init()` → `await TbRoot.ins.loadTbs()`（容器在 `excel_table/Tb_*Config.ts` 用 `@tb_config(':tb/xxx')` 注册）→ `BattleConstUtil.markLoaded()`。查询一律走 `TbRoot.ins.getTbContainer(XxxCfgContainer)`，业务层封装见 `game/data/configs/`（如 `EquipmentConfig.ts`）与 `BattleConstUtil`。

  **`assets/resources/tb/` 现有 14 张权威表**（旧的 `equipments`/`enemies`/`phases`/`growth_curves`/`passive_combos`/`element_effects`/`shop_items`/**`shop_skills`** 及对应容器已删除，勿再恢复；⚠ 新表 **`mall_items` 是「局外商城」商品表**、**`bag_items` 是「局外背包」的通用道具字典**，与那批已删的表都无关，别混）：

  | JSON 文件 (`assets/resources/tb/`) | 容器 (`game/excel_table/`) | 内容 |
  |---|---|---|
  | `units.json` | `Tb_UnitConfig.ts` | **英雄(team=1, id 1000 段)与怪物(team=2, id 2000 段)统一实体表**：base_attributes/growthValues/abilities/goldReward/expReward/**killReward**/rewardType/category(hero\|monster)/subtype(normal\|elite\|boss)/ai |
  | `attributes.json` | `Tb_AttributeConfig.ts` | 16 个属性字典（id 对齐 `battle/core/Types.ts` 的 `AttributeType`：1=HP,3=攻击,4=攻速…）；`stack_mode` 可选 `add/percent/multiply/complement/best` |
  | `abilities.json` | `Tb_AbilityConfig.ts` | **技能表（单位技能 + 肉鸽额外技能，一张表）**：`scope` = `unit` 单位自带（units.json 的 `abilities` 引用，id 1~31）/ `shop` 肉鸽商店抽取池（id **101~130**，30 个）/ `both` 两侧都出（**必填列**）。行为/冷却/耗蓝/`effects[]`；单位技能另有 `upgrades_to` 换 id 升阶链（**2026-11 起只剩兜底**，现役英雄技能都改成「一行多级」）。「一行多级」：`max_level`(1~3) + `lv1/lv2/lv3` 文案 + `effects`(1 级) 与 `effects_lv2`/`effects_lv3`（**整体覆盖**，留空沿用上一级）。共 **58 行**（赏金 7「悬赏」、斧王 17「反击风暴」、宙斯 19「雷霆之核」、骷髅王 28「骷髅地雷」、哈斯卡 27「血怒」、卓尔游侠 24「弹幕散射」是 3 级，随英雄 Lv.15/Lv.30 升级；**每个英雄技能都必须有 `lv1`** —— 英雄详情弹窗的技能描述直接读它，斧王 17 曾整行缺文案 ⇒ 弹窗空白，判据 `audit:hero` 的 A6） |
  | `modifiers.json` | `Tb_ModifierConfig.ts` | Buff/DoT/事件效果（duration/**cd**/stack_mode/**effects[]**/events）。**肉鸽道具的效果也在这里**：手工 Modifier id 1~26 + **「属性修改」共享模板 id 1000**（纯属性加成全部引用它，属性与数值由施加方的 kv 传入）。⚠ **id 段有归属**（改表前先看 `docs/agent-notes/配表与数值口径.md` 的段表）：`27~39` 英雄技能脚本行（33 骷髅地雷标记 / 69 血怒 / 70 弹幕散射）· `40~68` 肉鸽技能 · `200~239` + `260~275` 遗物钩子行（**按 `HOOKS` 数组顺序现算，插一条会让后面整体平移 ⇒ 新钩子一律追加在末尾**；240~259 留给神器/掉落 Buff）· `300~311` 遗物减益/DoT · `320~322` 怪物减益 · 1000 共享模板 |
  | `relics.json` | `Tb_RelicConfig.ts` | **遗物表（一件遗物一行）**：局内版与局外版是同一件遗物，共用 `id`/`name`/`code`/`icon`/`rarity`/`category`，只有效果与描述分两侧（`description_inner`+`modifiers_inner` / `description_outer`+`modifiers_outer`）；`scope` = **这件遗物在哪几侧出现**（⚠ **2026-11 起全表 268 行都是 `both`**：局内局外严格对齐，原来 9 件"只有局外版"的 1294~1302 已整行删除）。局外版**只给 5 条加法轴**（生命/魔法/攻击/护甲/回血），值 = 品质预算（真源 `scripts/lib/relic-outer-design.mjs`，落表 `gen-relics-outer.mjs`，门禁 `check:outer`）；另有一列 **`effects_outer`** = 红件的「局内开局初始值」（27 件各一条，code 取自 `ACH_EFFECT_CODES`）。属性一律 `modifiers_*[{modifier:1000, kv:{attrs}}]` |
  | `battle_constants.json` | `Tb_BattleConstConfig.ts` | 全局常量（caps/经验公式/奖励系数/经济），`BattleConstUtil.getNumber(key, default)` 访问。⚠ **局外商城的 7 个 `shop*` 键也在这里**（每日广告上限/免广告卡/连续登录阶梯/增益券每种值多少），由 `MallConfig` 读 |
  | `shop_constants.json` | `Tb_ShopConstConfig.ts` | **肉鸽商店规则常量**（KV：选项数/抽取费用 **50 → +25/次 → 不封顶**（`drawCostCap = 0`；2026-11 前是封顶 200）/阶段门槛/**技能配额** `skillDrawChance`+`skillCountWeight`+`skillMaxPerDraw`/广告次数），`ShopConfig.getNumber/getArray` 访问 |
  | `shop_draw.json` | `Tb_ShopDrawConfig.ts` | 品质抽取概率（英雄等级段 → 白/蓝/黄/红权重 + 越阶概率） |
  | `kill_buffs.json` | `Tb_KillBuffConfig.ts` | **神器表（击杀数商店）19 条**：**属性型 15**（`stat`/`attr_id`/`per` 每层百分比/max_stack/price×price_growth）+ **机制型 4**（`stat=special` + `modifiers` JSON 引 `modifiers.json` 里带 `script_id` 的行；实现在 `battle/SpecialBuffs.ts`）。⚠ 表里**没有** `script_id` 列（那一列全工程零消费方，2026-11 已删）。**`icon` 列 2026-11 补齐**（19 行 → `textures/artifacts/<code>`，图集 `textures/artifacts/artifacts`，**与遗物同一套画风**；同批还补了 `battle_items.icon` 17 行 + `modifiers.icon` 4 行，见 `docs/artifact-buff-icons/README.md`） |
  | `mall_items.json` | `Tb_MallItemConfig.ts` | **局外商城商品表（一行一商品）**：每日补给（`kind=free`，不看广告）+ 6 个广告商品（`kind=ad`）。列 = `key`(gold/hero_exp/acc_exp/relic_draw/boost/ad_ticket) / `grants`(JSON：发什么、多少) / `daily_limit` / `placement`(广告位) / `name`+`amount_text`（**界面那两行文案也由它下发**，所以"格子上写的数"就是"真正发的数"）。门面 `data/configs/MallConfig.ts` |
  | `bag_items.json` | `Tb_BagItemConfig.ts` | **局外背包的通用道具字典（一行一件）**：`key` / `name` / `desc` / `use_hint` / `icon` / `rarity` / `stack_max` / `usable`·`sellable` / `expire_hours` / `effect_code`（增益券专用）/ `sort`。⚠ 它只是**定义**（长什么样），**存量在 `data/funcs/BagData.ts`**（按 `key` 记账）（现 14 行：2026-11 多了 `boost_run_start_kill_points` 初始击杀券）；⚠ 与 `relics`（遗物，有自己的页面、**不进背包**）不是一回事；⚠ **`name` ≤ 8 汉字、`desc`·`use_hint` ≤ 12 汉字**：名字框是 `CLAMP`（超了**静默裁字**）、正文框是 `RESIZE_HEIGHT`（不裁字，但**写长了会把详情面板的两个按钮顶出去**）—— 两种编辑器里都看不出来，`audit:bag` 的 B 段**从预制件现读框尺寸**再估价。门面 `data/configs/BagConfig.ts` |
  | `tasks.json` | `Tb_TaskConfig.ts` | 日/周任务（目标/数量/奖励账号经验 + 金币/解锁等级），`TaskConfig` 访问 |
  | `achievements.json` | `Tb_AchievementConfig.ts` | 成就（**一行 = 一档**：group/tier/category/name/desc/target/**param**/count/奖励金币/末档 `effect_code`+`effect_value`），`AchievementConfig` 访问。⚠ **2026-11 档位改版**：档位名 = **`阶段N`**、**档位数 3~20 不固定**（账号等级 20 档 = 每 5 级一阶到 100 级），全表 **154 行 / 25 条 / 金币 53,645**，**由 `tools/excel_export/scripts/gen-achievements.mjs` 生成**（改表改那个脚本，别手改 JSON/xlsx）；局内成就一律用 **`run_*`「门槛 × 局数」**族（`run_stage`/`run_hero_level`/`run_kill`/`run_gold`/`run_survive`，`param` = 门槛，结算时 `AchievementData.reportRunGoals()` 上报，**一局最多 +1 点**、逐档各记一个局数）。⚠ **收集类成就把「表里一共多少种」抄进了两处**（文案「（共 19 种）」+ 末档 `count`），而 `target` 的数据源在别的表里 —— `npm run check` 的跨表校验会盯着这三条：`buff_types`↔`kill_buffs` 行数 / `skills_picked`↔`abilities` 里 scope 含 shop 的行数 / `relic_collected`↔`relics` 里 scope 含 outer 的行数。**改这些表的行数就要顺手改成就**，否则末档**永远拿不到**且成就页写着假数字（2026-11 神器 20→19 时真踩过）。改这张表**必跑** `npm run audit:achieve`（**109 条**：结构 / 门禁 / 负例 / 设计区间 / **真跑数据模块**（含「低门槛的局数不会顶高门槛的档位」F31、存档往返 F36b）/ 档位命名配色 / **B4b「每条 effect_code 至少一个真实来源」= 成就末档 ∪ `relics.effects_outer`**）。⚠ **「图鉴大师」的档位 2026-11 重排过**（局外池 37 → 268）：`10/25/50/90/140/200/268`，文案「收集局外遗物图鉴（共268件）。」—— 档位数**仍是 7**，所以成就金币总量 53,645 不变 |
  | `player_levels.json` | `Tb_PlayerLevelConfig.ts` | 账号等级表（`exp` 升下一级所需；**0 = 满级**，满级 = 表里最大 id；升级发 `reward_gold`）。⚠ **2026-11 上限 30 → 100**（成就「指挥官之路」20 档的刻度），**由 `tools/excel_export/scripts/gen-player-levels.mjs` 生成**：1~10 级沿用旧表、10 级起线性 **+100/级**，满级累计 **449,380** 经验 ≈ 活跃玩家 **13.5 个月**，升级金币合计 **18,130**（≈45 金/天）。⚠ 代价（有意接受）：**21~30 级这一段比旧曲线快 3 倍**（旧满级 89 天 → 新 30 级 29 天）。⚠ `docs/meta-growth/README.md` §2 那张「每级 +1% / Lv30 = +30%」的**未落地**加成表按满级 30 写的，落地前必须按新上限重定 |



## Notes

<!-- 快速记录存放处。规矩：本文件只留「每次都用的判据 + 指针」，长条目/历史/踩坑细节一律写进 docs/agent-notes/ 或专门文档，别再往 AGENTS.md 堆（2026-10 已按这条清理过一次：Notes 从 64 KB 压到 ~8 KB）。 -->

**细节归档 = `docs/agent-notes/`**（2026-10 从本文件逐字搬出、未改写）：`配表与数值口径` / `技能与战斗系统` / `UI与表现层` / `美术资产管线` / `工具与工作流` / `性能与drawcall`。下面是索引，**碰到问题再点进去读**。

