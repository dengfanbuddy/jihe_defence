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
| 类型检查 | `npx tsc --noEmit` |
| 运行 | Cocos Creator 编辑器直接预览 |
| 导表（Excel → JSON） | `cd tools/excel_export && npm run export` |
| 配表校验/自检 | `npm run check` / `npm run verify`（同上目录） |
| 品质×词条门禁体检 | `npm run check:affix`（违规退出码 1；`--strict` 警告也算失败、`--limit 0` 打全量） |
| 按门禁规则迁移配表（幂等） | `npm run migrate:affix`（`--dry-run` 只出报告不写盘） |
| 暴击口径修复（幂等） | `npm run fix:crit`（同上目录；`--dry-run` 只出报告不写盘） |
| 属性生效体检（真跑属性链路） | `npm run audit:attr`（同上目录 → `tools/attr-audit/audit.mjs`；有「加了却没变」即退出码 1） |

根目录无 npm 脚本（`package.json` 仅记录项目名和 UUID）；配表工具另有独立 `tools/excel_export/package.json`。

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
    │   ├── 局内功能类（每个功能一个类，纯 TS 无 cc 依赖）: HeroSelect.ts(选英雄) / RelicShop.ts(遗物商店流程) + RelicDraw.ts(遗物抽取规则) / BuffShop.ts(击杀商店 Buff)
    │   ├── DamagePipeline.ts / EffectExecutor.ts / ScriptedAbilities.ts / Targeting.ts
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

  **`assets/resources/tb/` 现有 10 张权威表**（旧的 `equipments`/`enemies`/`phases`/`growth_curves`/`passive_combos`/`element_effects`/`shop_items` 及对应容器已删除，勿再恢复）：

  | JSON 文件 (`assets/resources/tb/`) | 容器 (`game/excel_table/`) | 内容 |
  |---|---|---|
  | `units.json` | `Tb_UnitConfig.ts` | **英雄(team=1, id 1000 段)与怪物(team=2, id 2000 段)统一实体表**：base_attributes/growthValues/abilities/goldReward/expReward/rewardType/category(hero\|monster)/subtype(normal\|elite\|boss)/ai |
  | `attributes.json` | `Tb_AttributeConfig.ts` | 16 个属性字典（id 对齐 `battle/core/Types.ts` 的 `AttributeType`：1=HP,3=攻击,4=攻速…）；`stack_mode` 可选 `add/percent/multiply/complement/best` |
  | `abilities.json` | `Tb_AbilityConfig.ts` | 技能（behavior/cooldown/mana_cost/effects[]/upgrades_to） |
  | `modifiers.json` | `Tb_ModifierConfig.ts` | Buff/DoT/事件效果（duration/**cd**/stack_mode/**effects[]**/events）。**肉鸽道具的效果也在这里**：手工 Modifier id 1~26 + **「属性修改」共享模板 id 1000**（纯属性加成全部引用它，属性与数值由施加方的 kv 传入） |
  | `relics.json` | `Tb_RelicConfig.ts` | **遗物表（一件遗物一行）**：局内版与局外版是同一件遗物，共用 `id`/`name`/`code`/`icon`/`rarity`/`category`，只有效果与描述分两侧（`description_inner`+`modifiers_inner` / `description_outer`+`modifiers_outer`）；`scope` = **这件遗物在哪几侧出现**（`inner` 只有局内版 = 肉鸽商店道具，手工 demo 1~5 + 1001~1293／`outer` 只有局外版 = **1294~1302**／`both` 两侧都有 = 那 28 件）。属性一律 `modifiers_*[{modifier:1000, kv:{attrs}}]` |
  | `battle_constants.json` | `Tb_BattleConstConfig.ts` | 全局常量（caps/经验公式/奖励系数/经济），`BattleConstUtil.getNumber(key, default)` 访问 |
  | `shop_constants.json` | `Tb_ShopConstConfig.ts` | **肉鸽商店规则常量**（KV：选项数/抽取费用 50→200 封顶/阶段门槛/池权重/广告次数），`ShopConfig.getNumber/getArray` 访问 |
  | `shop_draw.json` | `Tb_ShopDrawConfig.ts` | 品质抽取概率（英雄等级段 → 白/蓝/黄/红权重 + 越阶概率） |
  | `shop_skills.json` | `Tb_ShopSkillConfig.ts` | 肉鸽额外技能 30 个（rarity/stage/weight/lv1~lv3，重复抽取升级，max_level 封顶） |
  | `kill_buffs.json` | `Tb_KillBuffConfig.ts` | 击杀商店 Buff 20 个（stat/attr_id/per 每层百分比/max_stack/price×price_growth） |

  **肉鸽商店（遗物商店）**：商店道具 = 遗物，运行时在 `battle/RelicShop.ts`（流程：抽什么/花多少/能不能选/要不要广告/选中后入背包）+
  `battle/RelicDraw.ts`（**纯函数抽取规则**：品质权重/阶段门槛/越阶/去重/降级，以及费用与广告额度的配置键名），
  两者都**不做属性计算**（属性走遗物自己的 `modifiers_inner`）；
  配置门面 `game/data/configs/ShopConfig.ts`，容器在 `Main.ts` 以副作用导入注册。
  设计稿在 `docs/hero-design/`，迁移脚本 `tools/excel_export/scripts/gen-shop-from-hero-design.ts`（幂等，只更新**局内版**：`scope` 含 `inner` 的行改用设计稿的 `name`/`icon`/`rarity`/`description_inner`/`modifiers_inner`，手工遗物 id<1000、仅局外版、以及两侧都有的遗物的**局外版**都不动）。

  **数值口径四条铁律**（详见 `docs/数值配置参考手册.md`；品质门禁见 `docs/配置规则_品质与词条门禁.md`）：
  - `units.json.base_attributes` 为 `[[属性id, int值]]`；**百分比型属性**（攻速/魔抗/闪避/暴率/暴伤/倍率，见 `battle/core/AttributeScaling.ts` SCALE 表）配置 **int = 值×100**（100=100%）；普通属性（生命/攻击/护甲/距离…）写原值。
  - **英雄条目只允许 5 项基础属性 + 3 项成长**（2026-07 收口）：`base_attributes` 只能是 `1 最大生命 / 2 最大魔法 / 3 攻击力 / 4 攻击速度 / 16 攻击距离`；`growthValues` 只能是 `1 / 2 / 3`。护甲/魔抗/闪避/回血/暴击率/移速不再由英雄配置给，回落 `attributes.json.base`（移速300/护甲0/魔抗25/闪避0/回血0/暴击0），改由**局外遗物 + 局内遗物**按品质门禁发放。
  - 英雄条目 `growthValues` 为 `[[属性id, 每级成长 float]]`，**float 语义**（暴击 0.005 = 0.5%/级），**不是 ×100**；代码 `Scene_Game_Stage.applyHeroGrowth` 内部自行换算。
  - **Modifier 的效果是原子效果**（`modifiers.effects[]`，见 `game/excel_table/EffectTypes.ts`）：一条效果一件事 —— `modify_attr`（属性条目）/ `apply_state`（状态）/ `tick_damage` · `tick_heal` · `tick_apply_modifier`（周期）。**没有** `properties`/`states`/`tick` 三个旧列（已废弃）。
    · 属性条目的**叠加方式**（`attrs` 里 `[属性id, 值, 叠加方式]` 的第三项；缺省 `add`）：
      - `add` = **固定值**，`final = base + Σv`（缩放型属性 int = 值×100）
      - `percent` = **对基础属性的百分比加成**，配置值是**百分数**（`14` = +14%），`final = base × (1 + Σv/100)`，多来源**加法叠加、不复利**（`AttributeStackMode.Percent`，`AttributeSystem.combine` 里最先结算，`add` 加在其后）
      - `multiply` = `base × Π(1+v)`，配置值是**小数**（`0.14`）且**复利** —— 百分比加成不要用它
      遗物/道具一律用 `percent`（百分比）或 `add`（固定值）。
    · **参数可以外置**：`{"type":"modify_attr","attrs_var":"attrs"}` 表示整张属性表由施加方 kv 传入；条目写 `{"attr":5,"value":-90,"var":"slow"}` 表示单条数值由 kv 覆盖。纯属性加成全部走共享模板 `MODIFY_ATTR_TEMPLATE_ID`（=1000，`battle/types.ts`），**不要**为每个数值组合新增 Modifier。
  - `modifiers.cd` 是**该效果自己的冷却**（秒）：每个 Modifier 实例各持一个计时器，同一实体上多个带 cd 的被动**各算各的**（`Modifier.cdRemaining` + `ModifierSystem.Tick`）。
  - 伤害公式以 `battle/DamagePipeline.ts` 为准（物理减伤用 Dota 双曲公式 `0.06·a/(1+0.06|a|)`；`battle_constants.defenseFormula` 字符串未被消费）。

  **表格编辑流水线（Excel 是编辑源）**：`tools/excel_export/` 提供导表工具，`excel/<表名>.xlsx` 经 `npm run export` 生成本目录下的 JSON（表头 3 行：字段名/类型/中文说明，第 4 行起数据）。表结构集中定义在 `tools/excel_export/src/core/schema.ts`；改表后跑 `npm run export`，改字段后跑 `npm run verify` 确认往返无损。详见 `tools/excel_export/README.md`。

## Notes

<!-- 快速记录存放处 -->

- **术语沟通**: 用户描述需求/现象/数值时用的游戏行业术语（策划的锚点/预算/乘区/TTK、美术的图集/顿帧/剪影、程序的 draw call/幂等/收口…）集中定义在 `docs/游戏开发术语速查手册.md`。该文档含 **§0 描述模板**（报 bug 五要素、规则"机制七问"、数值模板）、§9 同名不同义消歧（锚点/池/状态/攻速/阶段 vs 关卡…）、§10 黑话→正式术语对照、§11 术语→本项目文件与字段的落地映射。用法：用户用模糊词提需求（"手感""有点卡""优化一下""数值不平衡"）时，按 §0.2/§0.6 先要一份**可验收的量化描述**再动手；用户说的术语与你的理解可能不同义时先查 §9；用户提到某术语想知道"该改哪里"时查 §11。
- **数值配置**: 需要配英雄/装备/怪物/经济数值时，加载 Agent 技能 `jihe-numeric-balance`（`.agents/skills/jihe-numeric-balance/`），并参照 `docs/数值配置参考手册.md`（项目落地口径）与 `docs/数值设计调研报告_肉鸽塔防.md`（行业理论）。**改数值一律改 `tools/excel_export/excel/*.xlsx` 再 `npm run export`**，不要手改 `assets/resources/tb/*.json`（下一次导表会覆盖）；改动配置表后无需改代码（TbRoot 直接读 JSON）；若改 `attributes.json` 属性范围/新增属性需同步 `battle/core/Types.ts` 的 `AttributeType` 与 `AttributeScaling.SCALE`。
- **肉鸽商店配置**: 规则常量在 `shop_constants.json`（手写源）；**商店道具就是遗物的局内版** —— 293 件 dota2 道具在 `relics.json`（有局内版，id 1001~1293），**遗物 → Modifier 只有两层**：`modifiers_inner: [{ "modifier": 1000, "duration": null, "kv": { "attrs": [[3, 14, "percent"]] } }]`。1000 是全项目唯一的「属性修改」共享模板（`MODIFY_ATTR_TEMPLATE_ID`），属性类型/数值/叠加方式全在 `kv.attrs`（`percent`=对基础属性的百分比 / `add`=固定值），**不要为每件道具新增 Modifier**。来自设计稿 `docs/hero-design/`，用 `node tools/excel_export/scripts/gen-shop-from-hero-design.ts` 迁移/重跑（**幂等**：只更新局内版，`id < 1000` 的手工遗物、`scope="outer"` 的仅局外版（1294~1302）与两侧都有的遗物的**局外版**都保留）；**⚠ 它按设计稿重写局内版（百分比原值），重跑后必须再跑 `npm run migrate:affix`**，否则低档折算被打回。旧三列数据用 `node tools/excel_export/scripts/migrate-modifier-effects.ts` 迁移（幂等）。新增道具玩法往 Modifier 的 `effects`（原子效果）或 `events` 里加，不要给遗物加列。当前 38 条遗物两侧都没有效果（设计稿只给了文字/被动），道具的**被动**（砍树/重击/光环/吃莲花/种植/传送…）需要行为实现，设计稿只给了文字，暂未落表（文本保留在 `description_inner` 与设计稿里，实现时再加独立 Modifier；性质属主动的应走 `abilities.json`），`cdr/goldGain/elementPower/summonPower` 4 个派生属性因暂无 `AttributeType` 未落 `kv.attrs`（只保留在文案）。**⚠ 只改 JSON 是无效改动**：脚本/手工改了 `assets/resources/tb/*.json` 后必须 `npm run import -- --force --table <表名>` 回灌 `excel/*.xlsx`，否则下一次 `npm run export` 会按 xlsx 把 JSON 覆盖回去（曾因此丢掉 `relics.json` 的少量改值，xlsx 无 git 备份、丢了找不回）。
- **遗物表 = 一件遗物一行（2026-07 两步改造，最终形态）**: 第一步把局外装备表 `equipments.json` 并入 `relics.json`（`scope=outer`，id 2001~2045）；第二步按「**遗物局内局外用同一个 id、icon、品质，只是 modifiers / 描述分局内局外**」改造成**一件遗物一行**：身份列 `id`/`name`/`code`/`icon`/`rarity`/`category` 两侧共用，效果与描述分两侧 `description_inner`+`modifiers_inner` / `description_outer`+`modifiers_outer`，`scope` 表示**这件遗物在哪几侧出现**（`inner` / `outer` / `both`）。合并时用**局内 id**；28 件同一个 dota2 道具两侧都有的合成一行（`scope="both"`，品质与名字冲突时**取局内**），9 件只有局外版的（dota2 中立道具等）接在 **1294~1302**，**8 件英雄专属装备已删除**（口径「无英雄专属」，`code=spc_*` 与 `hero_id` 列一起没了）。已删除：`equipments.json` / `equipments.xlsx` / `Tb_EquipmentConfig.ts` / 死亡的 `Tb_BattleEquipConfig.ts` / 一次性脚本 `merge-equipments-into-relics.mjs`（**勿再恢复**）。四条硬约束：① **`scope` 必填**，且必须与两侧的 `description_*` / `modifiers_*` 对得上（`check:affix` 与 `crossCheck` 都拦）；② **商店池按「有局内版」过滤**（`ShopConfig.getRelics()` → `relicHasInner`），`BattleEquipSystem` 也拒绝挂载没有局内版的遗物；③ 局外属性统一走 `modifiers_outer[].kv.attrs` 的 **int 口径**（`dodge 0.08` → `[8, 8, "add"]`），由 `EquipmentConfig.relicToBonusGroup()` 换算成运行时 float；④ **一件遗物只有一个品质**，任一侧升档会连带另一侧（`migrate:affix` 对「局外版词条全是百分比型」的件用**升档保身份**：闪避护符 `rare → epic`）。改造脚本 `tools/excel_export/scripts/restructure-relics-scope.mjs`（**一次性**，幂等；明细见 `reports/relics-scope-restructure.md`，历史映射见 `reports/equipments-into-relics.md`）；旧局外收集记录（`DataCenter.equipCollection`，**无任何调用方**）现在直接存遗物 id（局内外共用一套）。
- **品质 × 词条门禁（2026-07 定案）**: **规则真源 = `tools/excel_export/scripts/lib/affix-rules.mjs`**，文档 = `docs/配置规则_品质与词条门禁.md`（迁移脚本与校验脚本都只 import 它，改规则只改一处 + 同步文档 + 跑体检）。要点：① **品质全局统一 4 档**（白 `common`/`1`、蓝 `rare`/`1.3`、黄 `epic`/`1.6`、红 `legendary`/`2`；装备旧值 `2.5`「独特」已并入红档）；② **低档只能给"数值属性的固定值"**（攻击值/生命值，只是多少不同），**百分比加成与百分比型属性（攻速/魔抗/闪避/暴率/暴伤/倍率）要黄档起**，**功能性固定值要蓝档起**（击杀金币 +2），**功能性百分比只有红档**（金币获取 +13%）；③ **百分比型属性禁止用 `percent` 叠加**（闪避/暴率 base=0 → 乘出来恒为 0），一律 `add` + 配置值 = 百分点；④ 低档 `percent` 折成固定值的基准在 `FLAT_CONVERT_BASELINE`（攻击 60/生命 500/护甲 10/回血 2 等）。工具：`npm run check:affix`（违规退出码 1，含 units 英雄白名单、遗物 `scope` 与 `rarity`、`kv.attrs` 门禁、文案越档）、`npm run migrate:affix`（**幂等**迁移，报告落 `tools/excel_export/reports/affix-gating-migration.md`）。运行时同规则在 `game/data/configs/EquipmentConfig.ts`（`add` → flat、`percent` → percent 层且需黄档起，低档降级并 warn；顺带修掉旧版「quality ≥ 2.5 → 所有属性都进 percent 层」把 `atk:30` 当 3000% 的坑）。**未定案**：局外版给攻速（8 件，遗物 id 1167/1187/1191/1194/1202/1294/1298/1301，与手册 §4.3 铁律冲突）、8 件升档遗物白值需重算、28 件遗物的 `description_inner` 仍有设计稿原文残留、功能性词条的局外/局内归属清单未定（钩子 `AFFIX_SCOPE_REGISTRY`）、攻击距离单位存疑（2 是像素还是米）、合并行「两侧强度未平账」、1296/1300 两件缺图标、局外合成升级链（`d2_basic → d2_upgrade`）没有落表。完整清单见 `docs/配置规则_品质与词条门禁.md` §8。
- **遗物 / Modifier 的时长口径（踩过：遗物加的属性"过一帧就没了"，表现为 UI 刷新时又变回去）**: **只有 `-1` 表示永久**（`modifiers.json.duration` 必填，`-1` = 不衰减、正数 = 秒）。引用方的 `duration` **留空就是 `null`**（Excel 空单元格导出成 null）= **「没写」，绝不是 0 秒** —— 统一由 `Modifier.normalizeDuration` 归一化：`null` / `undefined` → 回落 `ModifierCfg.duration`，两者都缺省 → 永久 `-1`（`ModifierSystem` 的 refresh/stack/strongest_only 三条刷新时长路径也走它）。旧实现 `duration !== undefined ? duration : def.duration` 把 `null` 当成了显式时长 → `remainingTime = null` → `isPermanent()` 为 false（`null < 0` 不成立）→ 首次 `Tick` 里 `null - dt` 是负数 → 当场判定"已过期"并移除。**遗物效果默认永久**：`BattleEquip.Apply` 传 `entry.duration ?? -1`，**不回落效果模板自带时长**（模板是给技能/临时 Buff 的，如 mod 11「吸血」= 5 秒；借用它会让遗物被动 5 秒后失效）。`relics.json` 的 259 条局内版条目**全是 `duration: null`** → 修之前**每一件有局内版的遗物都是无效的**（属性与被动都只活一帧，靠 `OnRelicAdded` → `syncHeroToStore` 先写好 `battleStore.maxHp` 才"看起来加上了"，下一次受伤/回血/升级同步时又"变回去"）。口径同步在 `docs/数值配置参考手册.md` §8.2。
- **「加最大生命」的满血口径 = `Entity.ApplyWithMaxHpCarry(fn)`（遗物 / 击杀商店 Buff 的唯一入口）**: `hp` 是独立字段、**不会**跟着属性贡献涨（属性是"贡献 → 下次读取时重算"，`hp` 要显式写），所以"满血买 +生命遗物"会凭空出现一道缺口（1000/1000 → 1000/1140），看起来像没加上。口径：**施放前满血 → 当前生命同步 +ΔmaxHp（加完仍满血）；施放前不是满血 → 只抬上限、当前生命不动**（否则"残血买血"等于白送一次治疗）。实现是一层包裹器（取施放前的上限与"是否满血"快照 → 跑 `fn`（内部写 Modifier/`addBase`）→ 按新增的 `ΔmaxHp` 补 `hp`），调用点：`BattleEquip.Apply`（整组遗物 Modifier 包在里面）、`BuffShop.applyStack`（每层一条 Modifier）。**升级**走 `Scene_Game_Stage.addBattleExp` 的显式补满（另一条口径，保持原样）。⚠ 只给**永久**上限变化用：临时上限（技能 buff 到期会掉回来）**不要**走这个口 —— 上限回落而当前生命不回落会出现 `hp > maxHp` 的脏数据（HUD 显示 1200/1000），要等下次 `ChangeHp` 才钳回。
- **属性生效体检（2026-09 落地）= `tools/attr-audit/audit.mjs`（`npm run audit:attr`）**: 把**真源码**（Entity / AttributeSystem / ModifierSystem / Modifier / DamagePipeline / BattleEquipSystem / Tb_RelicConfig）用 `transpileModule` 编成 CJS（只桩 cc 表现层与配表容器），再用**真配表**跑一遍「建英雄 → `RelicSystem.AddRelic(真遗物)` → 推进一帧 → 读运行时属性值」，逐属性打印 `前 ⇒ 后`；有「加了却没变」的词条即**退出码 1**。**它是被三类静默坑逼出来的**（配表写对了代码也不一定生效）：① `duration: null`（Excel 空单元格）→ 一帧后判过期移除；② `percent` 打在 **base=0** 的属性上 → `0×(1+v)=0`；③ 暴击倍率 base=100 → 1.0 → `rollCrit` 的 `倍率 > 1` 永不成立 → 全项目不暴击。**改完属性相关配置跑一次**。
- **两处「配了也不生效」的静默陷阱（2026-09，门禁已拦）**: ① **`percent` × base=0 = 0** —— 护甲(6)/生命恢复(9)/魔法恢复(10) 的 `attributes.json.base` 都是 0（英雄收口后不再配这三项），用 percent 恒不生效（36 条词条：护甲 13 + 回血 23，如「统御头盔」护甲 +22% → 0）；规则真源 = `affix-rules.mjs` 的 **`ZERO_BASE_ATTRS`**，`check:affix` 报错（`numeric_percent_zero_base`）、`migrate:affix` 按 `FLAT_CONVERT_BASELINE` 自动折成 `add`（护甲 15% → +1.5、回血 14% → +0.28，描述同步重写）。② **暴击是半套系统** —— `DamagePipeline.rollCrit` 要求 `chance > 0 && mult > 1`，而属性 15 暴击倍率 base 曾是 100（1.0）→ 暴击永远不发生；现定案：**base = 150**、词条值 int = 倍率×100、**词条叠加方式必须显式写 `best`**（**条目 mode 覆盖属性默认 mode**，写 `add` 会变成 `base + Σv` 累加：`+225%` 会算成 375%，实测踩过）；合同真源 = `CRIT_MULT_BASE` / `CRIT_MULT_MODE` / `critTextToMultiplier`，数据修复 = `npm run fix:crit`（幂等：attributes base + 文案承诺的暴击词条回填 + 叠加方式归一，报告 `tools/excel_export/reports/crit-baseline-fix.md`）。**未定案**：1126 水晶剑（蓝档）/ 1242 巨人重锤（白档）文案写了暴击但没有对应词条 —— 百分比型属性黄档起，回填会把门禁打红，`fix:crit` 只报不改（二选一：升档补词条 / 删越档文案）。
- **配表源漂移（2026-09 实测，已按 JSON 方向回灌收敛）**: `npm run check`（xlsx→JSON 只比对不写盘）曾报三张表与 JSON 不一致：① **`relics` id 1~5（手工 demo 遗物）只存在于 JSON，xlsx 里根本没有** —— 这时直接跑 `npm run export`（xlsx→JSON）会**把它们删掉**；② **`units` 2001 哥布林**：JSON 生命 40 / xlsx 生命 100（未定哪个才是策划要的，当前以 JSON 的 40 为准）。处理方向：**以 JSON（线上口径）为准** `npm run import -- --force --table attributes,relics,units` 回灌 xlsx → `npm run verify` 确认往返无损。**两条教训**：脚本改完 JSON **必须**回灌 xlsx；反过来怀疑 JSON 落后于 xlsx 时，先跑 `npm run check` 看清两边差异再决定方向，**别盲目 `--force`**。
- **重新选英雄**: 等级 / 经验 / 装备（遗物）/ Buff 都**不变** —— 遗物由 `RelicSystem` 持有、Buff 层数由 `BuffShop` 持有（都不属于英雄实体），英雄实体重建后由 `Scene_Game_Stage.selectHero` 调 `RelicSystem.RebindOwner(hero)` 与 `BuffShop.rebind()` 把已获得的内容重新挂到新英雄上（见 `Scene_Game_Stage` 英雄创建分支）。
- **索敌规则（粘性锁定 + 嘲讽）**: 普攻**不是每帧重新选目标** —— 唯一决策点是 `Scene_Game_Stage.resolveAttackTarget`，优先级 ① 强制目标 `Entity.forcedTarget`（嘲讽，`SetForcedTarget(target, duration)` 设置，超时/目标死亡自动解除）→ ② 粘性锁定（`attackTarget`，锁定后一直打到它死亡 / 被回收 / 离开射程且射程内有别的敌人）→ ③ 按 `units.json.attack_targeting` 重新索敌。**`attack_targeting` 只在"重新索敌"时生效**（所以火枪 farthest = 锁定时挑最靠外的那只，然后打到它死）；技能自动施放仍按各自 `targeting` 每次重新选（未走锁定）。锁定必须清理的时机：换英雄（`selectHero`）、本局重开（`resetRun`）、目标死亡（`OnDeath`，因为实体回池后会被复用成"另一只怪"，旧引用必须作废）。怪物侧 `MonsterAI.findTarget` 同样先认 `forcedTarget`（斧王战吼"强制敌人打自己"就走这条），再退回"最近"。**嘲讽效果本身尚未落表**（`modifiers.json` / `abilities.json` 里还没有具体条目，只有这个钩子）。
- **飘伤害字（表现层）**: `game_stage/entityview/DamageTextLayer.ts`（整场一个中央层）+ `common/DamageTextConfig.ts`（**字号/描边**/配色/寿命/合并与上限的唯一数据源，不依赖 cc）+ `entityview/GeometricDigits.ts`（手写几何数字字形，零字体资产）。**节点由编辑器摆位**：`Scene_Game_Stage.damageLayerNode` 指向预制件里的 `damege_layer`（挂在场景根下、与 `enimys` 同级，排在 hero/弹道之后、`uiViewNode` 之前 → **数字压在所有战斗实体之上、UI 之下**；改层级就是拖节点顺序，不用改代码）；取用顺序见 `Scene_Game_Stage.ensureDamageTextLayer`（① 拖了引用 → 用它；② 没拖但子树里有组件 → 直接用；③ 都没有 → 运行时建一个挂在 `monsterParent` 最后）。**一个视觉通道只承载一个含义**：颜色 = 打谁（英雄受击红 = `UNIT_VISUALS[Hero].hitColor`，其余白），尺度/形状 = 打击分量（暴击 = 1.6× 字号 + 左侧实心菱形标 + pop 回弹），寿命 = 优先级。**颜色不用来区分暴击**（否则与单位配色/受击色三义）。**战斗背景是浅色的，白字必须描边**：每个飘字画两遍 —— 先 `outlineColor`（暗墨色）且线宽比正文多 `outlineGrow` 的一层描边、再画彩色正文，白字+深边在浅底深底上都能读（`outlineGrow: 0` 即关掉描边）。**换字号只动 `DAMAGE_TEXT.baseFontSize` 一处**（= 普通伤害的实测字高，世界单位；暴击/英雄受击都是它的倍率），间距类参数一律用**相对字号的倍率**（如 `ladderGapRatio`），否则改小字号后相邻数字会叠在一起。反噪声：同目标 + 同档位 + 同来源 0.15s 内**累加合并**（英雄受击不分来源）、全场并发上限 24 按优先级淘汰（英雄受击 +6）、同目标连击沿 y 阶梯错开、按 `target.uid` 横向稳定抖散。四处关键口径：① **所有飘字画在同一个 `Graphics` 上 → 整层恒定 1 次 draw call**（不是每个数字一个 Label 节点，池化的是纯数据对象）；② 位置必须在 `OnTakeDamage` 回调里**立刻快照**（该事件发生在 `ChangeHp` 之后、`Die` 之前，实体死后位置不再同步）；③ 飘字层节点的 layer 必须是 UI_2D（`new Node()` 默认不是，运行时创建那条路要显式 `node.layer = monsterParent.layer`，否则 UI 相机看不到）；④ **坐标系靠契约、不做转换**：`entity.position` 处于 `monsterParent` 的局部空间，而飘字层必须与它**同坐标系** —— 预制件里 `damege_layer` 与 `enimys` 同为场景根子节点、position 都是 `(0,0)`、缩放都是 1，两个局部空间完全重合，所以 `entity.position` 拿来即用（**曾经写过的 `inv(本层世界矩阵) × 参照世界矩阵` 换算已删除**：该摆法下它 ≡ 单位矩阵，白算还多一层"世界矩阵何时就绪"的依赖）。改层级时别动层节点的 position/scale；`bind(ctx, monsterParent)` 的第二个参数只用于 bind 时的一次自检（`checkSpace`，同父但局部变换不同 → `console.warn`）。设计稿与改手感用的渲染器：`docs/damage-text-mockup.png` + `node tools/damage-text-preview/gen-mockup.mjs`（从 TS 源解析真实字形与参数出图，不用开编辑器）。**尚未做**：伤害类型配色（物理白/魔法紫/纯粹青）、DoT 弱化档、治疗/反伤/闪避·免疫几何符号、大额伤害档 —— DoT 与普攻目前无法从事件里区分（`ModifierSystem.tick_damage` 与普攻都不带 `ability`），要做需先给 `ApplyDamage` 的 options 加一个可选 tag。
- **单位血条（表现层）**: `entityview/HpBar.ts`（控制器）+ `common/EntityHpBarConfig.ts`（**唯一数值源**：节点名 `hp_bar` / 隐藏延时 `hideDelay`=2 / 世界高度 `worldHeight`=5）+ `EntityView`（按 `HP_BAR.nodeName` 在预制件根节点下查子节点，bind 时 `attach`、unbind 时 `reset`）。口径：**默认隐藏**（预制件里 `hp_bar` 的 `_active` 也置了 false）→ 受击显示（同一个 `OnTakeDamage` 入口；该事件在扣血之后 → 读到的就是实时百分比）→ **未受击 2s 隐藏**（每次受击重新计时）；**宽度 = 生命百分比**（锚点在左 → 从左往右掉），满血宽度只在**首次 attach** 记录（之后 width 被百分比改写，池化复用再读就只能读到上一只的残血长度）。四处关键口径：① **父预制件缩放**：血条是单位根节点（按体型 ×1/1.3/1.5/2）的子节点，**高度定死 5 世界单位** → `node.scale.y = 1/父节点worldScale.y`（`worldScale` 的 getter 内部会先 `updateWorldTransform()`，取到的是最新值，不怕"本帧刚 setScale"）；**长度不抵消**，随体型一起放大 → 血条始终横跨身体（普通 20 / 最终 Boss 40），要改成"长度也定死 20"就是 scale.x 同样取倒数一行的事；② **预制件里 `hp_bar` 上挂着的 Widget（LEFT\|RIGHT 拉伸 + AlignMode.ALWAYS）必须关掉** —— 它会在自身/父节点 transform 一变（单位每帧移动）就把宽度改回"父节点宽度"，百分比会被逐帧覆盖（血条永远满格），所以 `HpBar.attach` 里 `widget.enabled = false`，**宽度的唯一写入方是 HpBar**；③ 计时**帧驱动**（同 HitFlash：池化节点上 scheduleOnce 会跨生命周期残留），`tick` 必须排在 `update` 的死亡早退**之前**（怪死了血条也要按时收尾）；④ 池化契约：`unbind → HpBar.reset()`（隐藏 + 复位长度/缩放），`onDestroy` 只断引用（血条是子节点，销毁流程里它先被销毁）。**英雄未挂**（HUD 的 `View_Game_Stage.hp_bar` ProgressBar 已承担），要挂就在 `Hero.ts` 里同样 `new HpBar().attach(...)`。
- **对局结束的唯一收口 = `Scene_Game_Stage.endRun(result, reason)`**（幂等 `if (this.finished) return`）: 结束条件全是**瞬时事件**，所以**不做每帧轮询** —— ① `bindBattleEvents` 的 `OnDeath`：英雄阵亡 → `defeat('hero_dead')`、**最终 Boss 阵亡 → `victory('boss_killed')`**（最终 Boss 引用 `finalBoss` 在 `spawnBoss` 里记，`resolveBossKind` 判最终；这一杀算进结算，所以判定放在统计/奖励之后）；② `checkStage` 里 Boss 阶段倒计时归零 → `defeat('boss_timeout')`；③ `update` 里英雄死亡的**兜底断言**（命中打 warn，只为防"事件漏了 → 带着死英雄继续刷怪推进阶段"）。职责边界：`endRun` 只做「定胜负 → 局外结算 → 写 `battleStore.isGameOver` / 发 `BATTLE_ENDED` → 弹结算面板」，**不回主界面**（回主界面是面板「确定」→ `exit()`）、**不销毁战斗实体**（它常在 `ctx.Tick` 的死亡链里被调，当场回收池会踩"遍历中改集合"；池与节点的清理由 `exit()` 做）。**已删除勿恢复**：每帧 `checkEnd()` 轮询、以及重复的 `finish()`（旧版直接 `showUI(Scene_Menu)` 会绕过结算面板；而且 `gameEnd` 不幂等 + `finish` 被 `finished` 挡住 → 谁先谁后都会出错）。`GameStageConfig.winTime` 现无人消费（留作"存活 N 秒即胜利"的口子），胜负两态由面板标题 `View_Game_Stage.end_title`（`showEnd(victory)`）显示。中途退出（HUD 退出按钮）**不算一次对局结束**、不结算 —— `exit()` 里显式不调 `endRun`，想改成"退出即结算"就加 `endRun('defeat','quit')`。
- **表现层 `onDestroy` 里绝不碰别的组件**（踩过：结束面板点「确定」报 `Cannot read properties of null (reading 'equals')`，且**画面卡死、回不到主界面**）: 节点销毁时 Cocos **先销毁子节点、再按注册顺序销毁本节点组件**，并对每个已销毁对象跑 `_destruct()`（对象字段一律置 null：`Sprite._color`、`Graphics._impl`、组件自己的引用字段…）。所以在 `onDestroy` 里回滚外观（`sprite.color = c` / `g.clear()` / `node.setScale`）会读到 null 抛 TypeError —— **真正致命的不是这条报错**：`onDestroy` 由引擎 `CCObject._deferredDestroy()` 在 `director.tick` 里调用，而它排在 `uiRendererManager.updateAllDirtyRenderers()` / `_root.frameMove()`（提交渲染）**之前**；抛异常会让**销毁队列不清空**（下一帧从同一个对象重新抛，控制台每帧刷同一条）且**此后每帧都不再绘制** → 画面永久卡在上一帧（"点确定没回到主界面"就是这么来的；队列只在整段循环跑完才清空，所以一个坏 `onDestroy` 能永久废掉渲染）。口径：**`unbind()`（对象池回收、节点不销毁）才回滚表现；`onDestroy()` 只退订 + 断引用**（`entityview/EntityView.ts`、`game_stage/Hero.ts`、`entityview/DamageTextLayer.ts` 都按这个口径），`HitFlash.paint` 内部再判一次 `sprite.isValid` 兜底。**同一个坑的 UI 变体（踩过：一局战斗结束回主界面「过了一会儿」开始刷屏报错）**：`UIWidget.onDispose()`（或任何组件 `onDestroy`）里对**后代节点**调 `node.off(...)` 一样会炸 —— 报 `Uncaught TypeError: Cannot read properties of null (reading 'off')`（`Node.off` = `this._eventProcessor.off(...)`，而 `_eventProcessor` 已被 `_destruct()` 置 null）。**触发链**：`Scene_Game_Stage.exit()` → `UIManager.showUI(Scene_Menu)` → 战斗视图进 **60s 缓存** → `cleanupExpiredCache()` → `node.destroy()` → 帧末销毁级联**先把后代节点 `_destruct()`**，随后这些组件的 `onDispose` 再 `off()` 就打空了；`HeroItem.onDispose` 是第一个撞上的（它在 `hero_select_panel/pannel/items/*` 上，比 `View_Game_Stage` 更深 → 先被销毁 → 抛异常把整条级联打断 → 销毁队列不清空 + `errorID(5000)`「destroy a object twice or more」刷屏 + 画面冻结），**修了它只会把异常顺位让给 `View_Game_Stage`（HUD 的按钮同样是它自己的后代）**，所以这一层的 `off` 必须全查一遍。口径：**组件 `onDestroy`/`onDispose` 里摘节点事件一律用 `UIComponent.offNodeEvent(node, type, handler, target)`**（内部判 `node.isValid`，已销毁节点直接跳过；`node?.off()` 的**可选链挡不住**这个错 —— `node` 不是 null，是它内部字段被清空了），跳过不会泄漏（监听随节点的事件处理器一起消亡）。同时 `UIWidget.onDestroy` 已 try/catch 兜住 `onDispose()`、`UIComponent.onDestroy` 兜住 `_scope.dispose()`，保证子类钩子写错时**绝不外抛**（不再陪葬引擎的销毁队列）。
- **`@uiview` 的 `prefabPath` 是 `resources` 相对路径，挪预制件必须同步改代码**（踩过：`prefabs/ui/Top_ChangeScene` 挪到 `prefabs/ui/top/` 后 `Top_ChangeScene.ts` 没改 → 每次切场景都在 `showUI` 内部 `加载预制件失败`、转场动画直接消失，容易被当成别的问题）。移动 `assets/resources/**` 下的预制件/资源后，grep 一遍 `prefabPath` 与 `resources.load` 里的路径字符串。
- **UI 通信规约（两层体系 + UIScope）** —— 完整说明（生命周期顺序/时序图/踩坑清单/可复制配方）见 `docs/UI框架使用说明.md`:
  · **两层**：① **UIManager 视图** —— 继承 `BaseView` 且必须 `@uiview({prefabPath, layer, single})`，挂在编辑器层节点（scenes/views/popup/dialog/tip/top）下，生命周期由 `showUI/closeUI` 驱动（`showView→scope.resume` / `closeView→scope.pause` / `deleteView→scope.dispose`；`closeUI` 默认只把节点 `active=false` 放进 60s 缓存，**复用时不会重跑 onLoad**，所以 close 只许 pause、dispose 只放 delete）。② **场景预制件里内嵌的页面/小组件** —— 继承 `UIWidget`，生命周期就是 Cocos 原生回调，子类改用 `onInit/onShow/onHide/onDispose` 钩子（**不要**重写 onLoad/onEnable/onDisable/onDestroy，会覆盖基类的 scope 生命周期）；**禁止加 `@uiview`**（`@uiview` 注册会成功，`showUI` 于是实例化预制件并 push 进栈，最后在 `await view.showView(...)` 抛 `TypeError: view.showView is not a function` —— `showView/closeView/deleteView` 只定义在 `BaseView` 上）。
  · **任意深度通信**（`platform/ui/UIScope.ts`，不依赖 UIManager）：向下共享用 `this.provide(key, value)` / 深层 `this.inject(key, fallback?)`（沿 `node.parent` 向上解析、**不含自己这一层**；scenes/views/popup 等层互为兄弟，跨层注不到）；向上通知用 `this.scope.on/emit`（每个 UIComponent 一条局部总线，随 scope 销毁自动清空；**`emit` 会沿 `node.parent` 向上冒泡**，父链上每个祖先作用域都能用 `on` 收到 —— 只向上，不传后代、不传兄弟，所以「第 5 层的 item 通知第 2 层的面板」不需要任何引用）；watcher 一律 `this.scope.watch(...)`（随显示隐藏 resume/pause、销毁自动回收）。key 常量集中在 `game/ui/scenes/scene_game_stage/cmps/UiScopeKeys.ts`（`'域:用途'` 命名）。项目里的正例：`Scene_Game_Stage` 在 `onLoad` 里向战斗 UI 注入「退出战斗」动作 + **三个功能面板的页面级状态**（键是各功能类自己的 `ref`：`HeroSelect*` / `Relic*` / `BuffShop*`）、`HeroItem` / `ShopRiItem` / `ShopBuffItem` 只向上 `emit`，场景把事件转交给对应功能类。
  · **store 还是 scope（判据是「这个概念属于谁」，不是「现在谁在读」）**：① **UI 摆放**（面板开关、面板要渲染的列表、界面私有选中态）→ 宿主 `provide`（场景在 `onLoad` 里给整棵子树 provide，值用 `ref`），判据是「删掉那个控件，这个值还有意义吗」；② **局内运行状态**（`level`/`exp`/`expToNext`/`enemiesAlive`/`isPaused`：写它的是游戏规则，场景自己的升级/刷怪/抽卡/暂停逻辑也在读）→ 留 `useBattleStore`；③ **战斗真源的响应式投影**（`hp`/`maxHp`/`gold`/`kills`/`phase`/`phaseRemainTime`：真源在 Entity 或场景字段，UI 只读）→ 留 `useBattleStore`（它描述的是**这一局战斗**，且 popup 层结算/商店弹窗跨层 `inject` 不到，只有 store 能跨界面）。
  · **铁律**：状态向下（store / scope）、通知向上（emit）、兄弟之间只认共同祖先的共享状态（state lifting），**绝不横向 `getComponent`**；跨界面（如 popup 层弹窗 ↔ 战斗场景）只能走全局 store（`useBattleStore`）。
  · **`pause/resume` 会补播**暂停期间被触发的 watcher（Vue 3.5 语义，见 `reactivity/effect.ts` 的 `pausedQueueEffects`），但**非响应式字段**（普通属性赋值，如 `item.heroId`）的变化不会被感知 —— 所以 `onShow` 里仍要按当前状态显式刷一次。
  · **已删除、勿恢复**：`UIMgr.ts`（旧管理器；`@uiview` 注册表已搬到 `UIManager.viewInfos`，`ezgame.ui` 指向 `UIManager.ins`）、`BaseCtl.ts` + `BaseView.dataModel/controller`（MVC；视图私有状态用 `this.scope`，逻辑放 store 或纯 TS 系统如 `BattleContext`）、`UIComponent.ownerView`/`_uiComponents`/`registerComponent`/`unregisterComponent`（从来没有任何调用方；"向上找宿主"请用 scope 的一个 key）、`BaseView.eventMgr`/`watchData`/`unWatchData`、`UIViewFieldPath.ts`。
- **局内功能三分（2026-07 解耦定案）**: 局内的三套「面板 + 商店/选择」各有一个**纯 TS 功能类**（`game/battle/`，无 cc / 无 ezgame 依赖），场景只做宿主（持节点 + provide 状态 + 转发事件 + 提供平台能力）：
  · 选英雄 `HeroSelect.ts`：候选池（units.json 的 `category=hero`）/ 刷新费用 100 与广告免费次数 / `selectedId`；`pick()` 校验通过后**回调** `Scene_Game_Stage.selectHero(heroId)` 去创建实体（实体 / 范围圈 / 事件订阅 / 遗物与 Buff 重挂属战斗逻辑，留在场景）
  · 遗物商店 `RelicShop.ts`（本局状态：付费抽了几次 / 广告用了几次 / 本轮候选 / 本轮是否已选 + 6 个页面级 `ref`）+ `RelicDraw.ts`（**纯函数抽取规则**：品质权重 → 阶段门槛/越阶 → 同品质等权 → 逐级降级；费用与广告额度的配置键名也只在这里读）
  · 击杀商店 Buff `BuffShop.ts`：4 个摊位（首次打开白送一摊，之后刷新才收费）/ 价格 `price × growth^(stack-1)` / 层数封顶 `max_stack` / **购买即施加属性**
  三者的**页面级状态**都是它们自己持有的 `ref`，由场景在 `onLoad` 里 `provide`（键 `HeroSelect*` / `Relic*` / `BuffShop*`，见 `UiScopeKeys.ts`），UI（`HeroSelectPanel`/`HeroItem`、`ShopRelicsPanel`/`ShopRiItem`、`ShopBuffPanel`/`ShopBuffItem`）只 `inject` 读 + `emit` 上报。**扣金币全项目只有一个口**：`Scene_Game_Stage.spendGold`（三个功能类共用 → 想换货币只改这一处）。
  Buff 的属性口径：每买一层 = **一条独立 Modifier**（共享模板 `MODIFY_ATTR_TEMPLATE_ID` = 1000，`origin = killbuff:{id}:{层}` → 每层各持一份加成，不会被 stack_mode 合并成一层）；`percent` 只用于 base≠0 的属性（攻击/生命/攻速/射程/回血），**护甲/闪避/暴率这类 base=0 或百分数型属性必须用 `add`**（percent 乘出来恒 0，与「品质 × 词条门禁」同一条铁律，映射表见 `BuffShop.STAT_MODE`）。`stat=special` 的 Buff 需要行为实现才能生效，**暂不进摊位池**。
  已删除（勿恢复）：`battle/ShopSystem.ts` —— 旧的「遗物 + 肉鸽技能」混合池商店，它把抽取规则、费用/广告额度、技能学习与升级链、以及 `HeroSelect`/`RelicShop` 共用的状态全塞进一个类；其中**混合池与技能学习那部分没有任何调用方**（旧 `openShop` 早已删除），随之下线（`shop_skills.json` / `ShopConfig.getShopSkills` 保留在配置层，将来要做「肉鸽技能商店」按同样方式新建功能类即可）。`useBattleStore.refreshGold` 也删了（写死 100 的全局常量；选英雄的费用现在是 `HeroSelect.refreshCost`，页面级状态不再借用全局 store）。`EventNames.BATTLE_SELECT_HERO` 已无生产者与消费者（选英雄改走 scope 事件），枚举项暂时留着。
- **已知遗留噪声**: `ConfigLoader.nameToAttrId` 仍映射 17~20（lightningDmg 等）但 `AttributeType` 枚举只到 16；`ExcelConfigDecorator.ts`/`ITbDecode.ts` 等旧框架文件仍存在，新表一律走 `@tb_config` + `TbContainer` 管线（`Tb_*Config.ts`），勿新增旧式解码器。
