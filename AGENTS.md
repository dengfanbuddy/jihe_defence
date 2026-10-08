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
| 类型检查 | `npx tsc --noEmit`（**全量有 249 条历史错误**，别拿它当门禁 → 用 `npm run typecheck:diff`） |
| 平台层教程网页版（md → HTML + **静态 SVG 图**） | `node tools/docs-web/build.mjs` → `docs/platform-guide/web/`（20 页 + 63 张 `.svg`，零 JS 可离线双击打开）；本地预览 `node tools/docs-web/serve.mjs 8799` → http://127.0.0.1:8799/。`web/` 是生成物**勿手改**，改 `docs/platform-guide/*.md` 后重跑构建；渲染器与支持的 mermaid 子集见 `tools/docs-web/README.md` |
| 运行 | Cocos Creator 编辑器直接预览 |
| 导表（Excel → JSON） | `cd tools/excel_export && npm run export` |
| 配表校验/自检 | `npm run check` / `npm run verify`（同上目录） |
| 品质×词条门禁体检 | `npm run check:affix`（违规退出码 1；`--strict` 警告也算失败、`--limit 0` 打全量） |
| 按门禁规则迁移配表（幂等） | `npm run migrate:affix`（`--dry-run` 只出报告不写盘） |
| 暴击口径修复（幂等） | `npm run fix:crit`（同上目录；`--dry-run` 只出报告不写盘） |
| 属性生效体检（真跑属性链路） | `npm run audit:attr`（同上目录 → `tools/attr-audit/audit.mjs`；有「加了却没变」即退出码 1） |
| 视野与可达性体检（屏幕预算 + 怪能否被打到） | `npm run audit:reach`（同上目录 → `tools/monster-reach-audit/audit.mjs`；① 英雄攻击距离超「设计宽 1/3（远程）·1/4（近战）」、或 ② 某只怪的「停位半径」> 英雄最小攻击距离，即退出码 1） |
| 技能槽规则体检（真跑槽位规则） | `npm run audit:slot`（同上目录 → `tools/skill-slot-audit/audit.mjs`；真跑 `SkillSlots`/`Ability` 验证锁定/落槽/升级口径，按真预制件校验详情面板 `skill_details` 的节点契约，并把真 `SkillDetailPanel` 跑在真预制件子树上验「一行一级 / 当前级绿字」） |
| **英雄卡 + 英雄详情弹窗**体检（真组件 × 真预制件 × 真配表） | `npm run audit:herocard`（同上目录 → `tools/hero-card-audit/audit.mjs`；**111 条**：A 契约 / A′ 拖错引用对照 / B~C 两态与边界 / D 经验公式 / F 两态判据 / E token 口径 / G 销毁级联 / **H 详情弹窗** —— 真 `Cmp_HeroDetail.ts` 跑在真 `Scene_Menu.prefab` 的 `ui_hero_detail` 子树上，验 23 个引用、三态、按钮两态色、**点一下真的冒泡出哪个事件 + heroId**、`onDispose` 不碰别的组件。改这个弹窗前后**必跑**） |
| **局外商城**体检（真数据层 × 真配表 × 真预制件） | `npm run audit:mall`（同上目录 → `tools/mall-audit/audit.mjs`；**174 条**：真跑 `ShopData` / `DataCenter` / `ShopVM` + `mall_items.json`，验每日补给一天一次与连续登录倍数、**界面显示的数 == 真正发的数**、每格每日上限与「今日广告 14」、跨天重置与券跨天保留、存档往返（数组字段不被 `mergeDeep` 吃掉）、免广告卡不可叠加、**三种券都落在背包且互不串账（D7/D8c~D8g）**、增益券池只发未达 `cap` 的效果；再读**真预制件**对六格节点名 / 每格四行标签 / `resolveRefs` 的路径 / 顶部重置条与顶栏三个入口路径 / **广告区是竖直滚动列表（ScrollView + Mask 在 `view` + 容器自增的 GRID content）且下沿不压免广告卡（J4d~J4k2）**。⚠ **2026-11 起券/次数的存量在 `bagData` 里**；⚠ **A5 已由「开局增益券」改成「局内复活券」**（六格之和仍 14，增益券只剩连续登录赠券一个出口 —— F 组就是改走那条路）（断言已跟着改，见 `docs/bag/README.md` §1）。改商城配表、预制件或入口前后**必跑**） |
| **局外背包**体检（真数据层 × 真配表 × 真预制件 + 文案宽度） | `npm run audit:bag`（同上目录 → `tools/bag-audit/audit.mjs`；**145 条**：真跑 `BagData` / `BagConfig` / `BagVM` + `bag_items.json`，验**格子恒铺满 80 个**（有货在前 · 空槽在后 · 空槽不参与选中 / 不带品质色 / 点了不冒泡）、**没选中时详情面板画「未选中」占位态**（不是整块收起）、**选中回落**、堆叠上限**不静默吞**、扣到 0 整条删掉、孤儿 key 不占格子也不占容量、`expire_hours` → 入库算时间戳 → `pruneExpired`、**商城 A4/A5/A6 的券（抽取券 / 复活券 / 广告券）真的进背包**、页面指纹无副作用；**B 段把框尺寸从预制件现读**再按框宽逐行估算（名字框 `CLAMP` ⇒ 超了**静默裁字**；正文框 `RESIZE_HEIGHT` ⇒ 不裁字但**会把两个按钮顶出面板**，B8 按面板高算额度）；F/G 段读**真预制件**对节点契约 / **预制件上拖的 15 个引用逐条对着路径核（F16b —— `??` 兜底拦不住"拖错"）** / **空位色的 token 口径（F13：运行期写的色，`audit:ui` 扫不到）** / `bagBtn` 真拖到了 `bottom/left/bag` / 三个全屏页的互斥表。改背包配表、预制件或入口前后**必跑**） |
| **局外遗物抽取**体检（真规则 × 真数据层 × 真配表 × 真预制件） | `npm run audit:draw`（同上目录 → `tools/outer-draw-audit/audit.mjs`；**90 条**：真跑 `OuterRelicDraw` / `DataCenter` / `EquipmentCollection` + `relics.json` / `battle_constants.json`，验**池子只有 scope 含 outer 的 37 件**、品质权重 6:2.5:1:0.5（6 万次采样 ±1.5%）、**档内优先未收集**（强制掷档，不靠运气）、**价格阶梯 / 封顶 / 跨天按日键重置**、**券优先于金币且用券不抬阶梯**、十连 = 接下来 10 抽逐个累加、金币不够时的**部分成功**、同件可反复抽到（份数无上限）、**预览的消耗 == 实扣**（判据同源）、**存档往返（`collected` 必须是数组，字典会被 `mergeDeep` 整片吃掉）**、旧存档字典形态迁移、预制件上 `draw_btn`/`ten_box`/`cost` 的节点契约与 5 个拖引用、以及「局内抽到遗物**不再**写图鉴」。改抽取规则、`EquipmentCollection` 或那一行 UI 前后**必跑**） |
| UI 规范门禁（字号/颜色/行距/内置贴图） | `npm run audit:ui`（同上目录 → `tools/ui-token-audit/audit.mjs`；扫预制件某棵子树里**每个** Sprite/Label 的色与字号是否都来自 `docs/art-style/tokens.json`（25 色 / 6 档字号）；`--prefab` / `--root` 指定，默认 `Scene_Menu.prefab` 的 `ui_hero_detail`。**改 UI 的色或字号前后必跑**；⚠ 现有 `ui_difficulty` 子树**尚未收敛**（25 条违规），别拿它当"全工程绿"；✅ `View_Bag.prefab`（57/57）与 `Bag_Cell.prefab`（14/14）2026-11 已收敛全绿 —— 那轮的 9 条 P3（Label 行距）已修，见 `docs/bag/README.md` §7 第 11 条） |
| 类型检查（**基线比对**，能当门禁） | `npm run typecheck:diff`（同上目录 → `tools/typecheck-diff/check.mjs`；全量 `tsc` 有 **249 条历史错误**、裸跑当不了门禁 —— 它比的是「基线之外有没有**新**错误」，有则退出码 1；改完代码跑它，确认是「新增 0 条」。基线在 `tools/typecheck-diff/baseline.txt`，`--update` 更新（**在途改动落地后要更新一次**）） |
| 预制件/场景**语义 diff**（改完预制件先跑它） | `node tools/prefab-diff/diff.mjs <新文件>`（零依赖；⚠ **别用 `npm run diff:prefab -- --b …`** —— 本机 npm 会把 `--b`/`--path` 当自己的配置吃掉，同 `json2excel --force` 那个坑，npm 那条只适合裸位置参数。⚠ **别用字节级/`git diff` 看预制件**：它是扁平数组 + 按下标 `{"__id__": n}` 互相引用，往中间插对象会让后面所有下标顺移 —— 实测 `Scene_Menu.prefab` 只多了 1 个组件、改了 2 个节点名 + 4 个字段，`git diff` 会出 **1173 个 hunk（其中 1147 行是 `__id__` 重编号）**，本工具 **75 ms** 出「改名 2 · 实质改动 4 · 噪声 0」。身份认 `__prefab.fileId` ⇒ 改名/移动精确、组件插入不带假 diff；引用解成 `@节点路径` / `#组件`，**「拖错引用」一眼可见**。缺省旧侧取 `git HEAD` 同路径，`--a/--b` 可比任意两份（含「存盘前快照 vs 存盘后」），`--gate` 接 CI。⚠ 它只**看差异**、不判契约 —— 契约门禁是 `audit:*` 那一族） |
| 打击反馈体检（真跑决策层+印痕层+屏幕层 + 假时钟假画布） | `npm run audit:hitfeel`（同上目录 → `tools/hit-feel-audit/audit.mjs`；真跑 `HitFeelConfig`/`HitFeelDirector`/`HitVfxLayer`/`HitScreenLayer`/`HpBar`，把 `cc` 桩成**记账画布 + 极简假节点树**，验**时间税 ≤3%**、1s 窗口顿帧 ≤30ms、位移 ≤6px 且同帧合并、密度 k、印痕「每档画出的图元数 = 档位表」、环半径、只描边不填充、合并/每秒新建 ≤60/并发 ≤24 且淘汰最弱档/碎片 ≤48、起手虚线、墨闪（只 T5/T6/T7 · 峰值=档位表 · 1.5s 冷却）、四角角标贴边与配色、连击断连清零、奖励飞到 HUD 锚点、残影条单调收敛、掉帧注入、换局无残留、**音效账本**（每 50ms ≤2 声 · 同帧只出最强档 · 音量不吃密度 k · 只给英雄响出手音）；**178 条**） |
| 打击反馈**音效素材**（离线渲染 + 试听 + 三方对账；**B4**） | `node tools/hit-feel-sfx/render.mjs [--check]`（零依赖合成器：配方 `design.mjs` → 出 `assets/resources/sfx/` 的 **16 个 wav** + `manifest.json` + `tier-table.json`；`--check` 逐字节对账且**绝不写盘**）· `node tools/hit-feel-sfx/check-drift.mjs [--write]`（**素材门禁**：`HitFeelConfig.ts` ↔ 试听页内嵌快照 ↔ 盘上文件；缺文件即失败）· 试听页 `tools/hit-feel-sfx/audition.html`（按档试听 / 两个节奏场景听"合并与节流"）。**改音效音量后必须依次跑** `render.mjs` → `check-drift.mjs --write`（细节见该目录 `README.md`） |
| AI 出图：风格迁移 + 透明背景（参考图+目标图，带 Web 台与批量） | `cd tools/ark-style-transfer; npm install; npm start` → http://127.0.0.1:8788（火山方舟 Seedream；Key 填界面右上角「设置」或设 `ARK_API_KEY`）。自测 `npm test`（不花钱）/ `npm run test:e2e`（需服务在跑）。**透明背景**：接口 `background=transparent` 只「保留**单图已有**的透明像素」（恰好 1 张输入图 + 该图至少 1 个透明像素，否则 400），双图风格迁移用不了 → 走**本地色键抠图**（提示词要求纯色背景，别在提示词里写"背景透明"）；报错原文见该目录 `README.md` §4.1，`npm run test:guard`（免费）/ `npm run test:transparent`（真调用，约 0.3 元）可复跑 |

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
  | `units.json` | `Tb_UnitConfig.ts` | **英雄(team=1, id 1000 段)与怪物(team=2, id 2000 段)统一实体表**：base_attributes/growthValues/abilities/goldReward/expReward/rewardType/category(hero\|monster)/subtype(normal\|elite\|boss)/ai |
  | `attributes.json` | `Tb_AttributeConfig.ts` | 16 个属性字典（id 对齐 `battle/core/Types.ts` 的 `AttributeType`：1=HP,3=攻击,4=攻速…）；`stack_mode` 可选 `add/percent/multiply/complement/best` |
  | `abilities.json` | `Tb_AbilityConfig.ts` | **技能表（单位技能 + 肉鸽额外技能，一张表）**：`scope` = `unit` 单位自带（units.json 的 `abilities` 引用，id 1~22）/ `shop` 肉鸽商店抽取池（id **101~130**，30 个）/ `both` 两侧都出（**必填列**）。行为/冷却/耗蓝/`effects[]`；单位技能另有 `upgrades_to` 换 id 升阶链。「一行多级」：`max_level`(1~3) + `lv1/lv2/lv3` 文案 + `effects`(1 级) 与 `effects_lv2`/`effects_lv3`（**整体覆盖**，留空沿用上一级）。共 52 行 |
  | `modifiers.json` | `Tb_ModifierConfig.ts` | Buff/DoT/事件效果（duration/**cd**/stack_mode/**effects[]**/events）。**肉鸽道具的效果也在这里**：手工 Modifier id 1~26 + **「属性修改」共享模板 id 1000**（纯属性加成全部引用它，属性与数值由施加方的 kv 传入） |
  | `relics.json` | `Tb_RelicConfig.ts` | **遗物表（一件遗物一行）**：局内版与局外版是同一件遗物，共用 `id`/`name`/`code`/`icon`/`rarity`/`category`，只有效果与描述分两侧（`description_inner`+`modifiers_inner` / `description_outer`+`modifiers_outer`）；`scope` = **这件遗物在哪几侧出现**（`inner` 只有局内版 = 肉鸽商店道具，手工 demo 1~5 + 1001~1293／`outer` 只有局外版 = **1294~1302**／`both` 两侧都有 = 那 28 件）。属性一律 `modifiers_*[{modifier:1000, kv:{attrs}}]` |
  | `battle_constants.json` | `Tb_BattleConstConfig.ts` | 全局常量（caps/经验公式/奖励系数/经济），`BattleConstUtil.getNumber(key, default)` 访问。⚠ **局外商城的 7 个 `shop*` 键也在这里**（每日广告上限/免广告卡/连续登录阶梯/增益券每种值多少），由 `MallConfig` 读 |
  | `shop_constants.json` | `Tb_ShopConstConfig.ts` | **肉鸽商店规则常量**（KV：选项数/抽取费用 50→200 封顶/阶段门槛/**技能配额** `skillDrawChance`+`skillCountWeight`+`skillMaxPerDraw`/广告次数），`ShopConfig.getNumber/getArray` 访问 |
  | `shop_draw.json` | `Tb_ShopDrawConfig.ts` | 品质抽取概率（英雄等级段 → 白/蓝/黄/红权重 + 越阶概率） |
  | `kill_buffs.json` | `Tb_KillBuffConfig.ts` | 击杀商店 Buff 20 个（stat/attr_id/per 每层百分比/max_stack/price×price_growth） |
  | `mall_items.json` | `Tb_MallItemConfig.ts` | **局外商城商品表（一行一商品）**：每日补给（`kind=free`，不看广告）+ 6 个广告商品（`kind=ad`）。列 = `key`(gold/hero_exp/acc_exp/relic_draw/boost/ad_ticket) / `grants`(JSON：发什么、多少) / `daily_limit` / `placement`(广告位) / `name`+`amount_text`（**界面那两行文案也由它下发**，所以"格子上写的数"就是"真正发的数"）。门面 `data/configs/MallConfig.ts` |
  | `bag_items.json` | `Tb_BagItemConfig.ts` | **局外背包的通用道具字典（一行一件）**：`key` / `name` / `desc` / `use_hint` / `icon` / `rarity` / `stack_max` / `usable`·`sellable` / `expire_hours` / `effect_code`（增益券专用）/ `sort`。⚠ 它只是**定义**（长什么样），**存量在 `data/funcs/BagData.ts`**（按 `key` 记账）；⚠ 与 `relics`（遗物，有自己的页面、**不进背包**）不是一回事；⚠ **`name` ≤ 8 汉字、`desc`·`use_hint` ≤ 12 汉字**：名字框是 `CLAMP`（超了**静默裁字**）、正文框是 `RESIZE_HEIGHT`（不裁字，但**写长了会把详情面板的两个按钮顶出去**）—— 两种编辑器里都看不出来，`audit:bag` 的 B 段**从预制件现读框尺寸**再估价。门面 `data/configs/BagConfig.ts` |
  | `tasks.json` | `Tb_TaskConfig.ts` | 日/周任务（目标/数量/奖励账号经验 + 金币/解锁等级），`TaskConfig` 访问 |
  | `achievements.json` | `Tb_AchievementConfig.ts` | 成就（一行一档：group/tier/target/count/奖励金币/末档 `effect_code`+`effect_value`），`AchievementConfig` 访问 |
  | `player_levels.json` | `Tb_PlayerLevelConfig.ts` | 账号等级表（`exp` 升下一级所需；0 = 满级；升级发 `reward_gold`） |

  **肉鸽商店（遗物 + 技能的混合池）**：运行时在 `battle/RelicShop.ts`（流程：抽什么/花多少/能不能选/要不要广告/选中后发到哪）+
  `battle/RelicDraw.ts`（**纯函数抽取规则**：品质权重/阶段门槛/越阶/**技能配额**（一轮 0~2 个技能）/去重/降级，以及费用与广告额度的配置键名），
  两者都**不做属性计算**（遗物属性走自己的 `modifiers_inner`，技能效果走 `Ability` → `EffectExecutor`）；
  配置门面 `game/data/configs/ShopConfig.ts`，容器在 `Main.ts` 以副作用导入注册。
  设计稿在 `docs/hero-design/`，迁移脚本 `tools/excel_export/scripts/gen-shop-from-hero-design.ts`（幂等，只更新**局内版**：`scope` 含 `inner` 的行改用设计稿的 `name`/`icon`/`rarity`/`description_inner`/`modifiers_inner`，手工遗物 id<1000、仅局外版、以及两侧都有的遗物的**局外版**都不动；肉鸽技能写进 `abilities.json` 的 `scope='shop'` 行）。
  ✅ **30 个肉鸽技能现在全部有战斗效果**（2026-10 收尾）：落地形态 = **纯声明式 7 / 脚本 17 / 声明式+脚本 6**。实现全在 `assets/scripts/game/battle/ShopSkillModifiers.ts`（25 个类，注册走该文件导出的 `SHOP_SKILL_SCRIPT_CLASSES` 一张表 → `Scene_Game_Stage.initBattle`），配表新增 **28 行 Modifier（id 40~67）**，`npm run check` 的「没效果的商店技能」告警已归零。细节见 Notes 里那条「局内（肉鸽）技能审查…」。

  **数值口径四条铁律**（详见 `docs/数值配置参考手册.md`；品质门禁见 `docs/配置规则_品质与词条门禁.md`）：
  - `units.json.base_attributes` 为 `[[属性id, int值]]`；**百分比型属性**（攻速/魔抗/闪避/暴率/暴伤/倍率，见 `battle/core/AttributeScaling.ts` SCALE 表）配置 **int = 值×100**（100=100%）；普通属性（生命/攻击/护甲/距离…）写原值。
  - **英雄条目只允许 5 项基础属性 + 3 项成长**（2026-07 收口）：`base_attributes` 只能是 `1 最大生命 / 2 最大魔法 / 3 攻击力 / 4 攻击速度 / 16 攻击距离`；`growthValues` 只能是 `1 / 2 / 3`。护甲/魔抗/闪避/回血/暴击率/移速不再由英雄配置给，回落 `attributes.json.base`（移速300/护甲0/魔抗25/闪避0/回血0/暴击0），改由**局外遗物 + 局内遗物**按品质门禁发放。
  - 英雄条目 `growthValues` 为 `[[属性id, 每级成长 float]]`，**float 语义**（暴击 0.005 = 0.5%/级），**不是 ×100**；代码 `Scene_Game_Stage.applyHeroGrowth` 内部自行换算；**升级只抬上限、不回血**（2026-11 口径，见 `docs/agent-notes/配表与数值口径.md`）。
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

<!-- 快速记录存放处。规矩：本文件只留「每次都用的判据 + 指针」，长条目/历史/踩坑细节一律写进 docs/agent-notes/ 或专门文档，别再往 AGENTS.md 堆（2026-10 已按这条清理过一次：Notes 从 64 KB 压到 ~8 KB）。 -->

**细节归档 = `docs/agent-notes/`**（2026-10 从本文件逐字搬出、未改写）：`配表与数值口径` / `技能与战斗系统` / `UI与表现层` / `美术资产管线` / `工具与工作流`。下面是索引，**碰到问题再点进去读**。

### 判据速查（动手前扫一眼）

- **改数值/配表**：一律改 `tools/excel_export/excel/*.xlsx` → `npm run export`。**只改 `assets/resources/tb/*.json` 是无效改动**（下一次导表会按 xlsx 覆盖回去）；脚本改了 JSON 必须回灌 xlsx（`cd tools/excel_export; node src/cli.ts json2excel --force --table <表名>`），再 `npm run check` + `npm run verify`。⚠ `npm run import -- --force --table X` 在当前 npm 下是**坏的**（`--force` 被 npm 自己吃掉），直接调 CLI。
- **改文本文件编码**：别用 `Get-Content | Set-Content` —— PowerShell 5.1 的 `Set-Content` 默认按 ANSI(GBK) 写盘，会把 UTF-8 中文源码写坏；用编辑器或 `[System.IO.File]::WriteAllText`。详见 [工具与工作流](docs/agent-notes/工具与工作流.md)。
- **属性口径**：`percent` 打在 **base=0** 的属性上恒为 0（护甲/闪避/生命恢复/魔法恢复/暴击率）→ 这些必须用 `add`；`multiply` 是复利、**全项目禁用**；三条模式与"英雄只允许 5 项基础属性 + 3 项成长"见上文 `Conventions → 数值口径四条铁律`。
- **Modifier**：一条效果只做一件事（`modifiers.effects[]` 原子效果）；**纯属性加成一律走共享模板 `MODIFY_ATTR_TEMPLATE_ID` = 1000** + `kv.attrs`，不要为每个数值组合新增 Modifier；`duration` **只有 `-1` 表示永久**。
- **局内经济是双货币（2026-11 落地）**：**金币**只给**选英雄刷新 + 遗物抽取**（唯一扣费口 `Scene_Game_Stage.spendGold`），**击杀数**只给**击杀商店 Buff**（`battleStore.killPoints`，每杀 1 只 +1，扣费口 `battleStore.spendKillPoints`，刷新 50 / 购买按 `kill_buffs.price`）。**遗物刷新费用封顶 200**（`shop_constants.drawCostCap`，注意 `0` = 不封顶），**局内升级不回血**；广告位**未接 SDK 一律不发奖励**（`AdMgr` 无 provider → false），见 `docs/局内刷怪节奏设计.md` §18 与 `docs/agent-notes/配表与数值口径.md`。
- **表现层 `onDestroy` 里绝不碰别的组件**：抛异常会堵死引擎的销毁队列 → **画面永久卡住、回不到主界面**（`UIComponent`/`UIWidget` 已各自兜住，子类照办）。收尾时**连后代节点的 `getComponent` 都不能调**（子节点先销毁、`Node._components` 已置 null → `reading 'length'`）：子组件引用在 `onInit` 记进字段，收尾只借 `?.node` 走 `offNodeEvent`；回归见 `npm run audit:herocard` 的 G 组，细节见 [UI与表现层](docs/agent-notes/UI与表现层.md)。
- **UI 通信**：两层体系（`BaseView` + `@uiview` 归 UIManager；预制件内嵌页面/小组件用 `UIWidget`，**禁止**加 `@uiview`）+ `UIScope`；跨界面共享只走 store。完整说明见 `docs/UI框架使用说明.md`。
- **改 UI（颜色 / 字号 / 版式）**：① **动手前先读** `docs/art-style/tokens.json` + 该界面的 `docs/<界面>/README.md`（规范写在文档里**挡不住**"读了没照做"—— 英雄详情弹窗就为此整版重建过一次）；② **动手前先跑一次 `npm run audit:ui` 拿基线**，改完再跑 —— 否则那一串违规里哪些是**自己引入的**看不出来（`--root` 换界面）；契约/交互另跑 `npm run audit:herocard`；改了字号/框尺寸/文案的 Label，先用场景侧助手 **`labelFit`** 算一遍会不会裁字（它回 `clippedText` = 看不见的那几个字，还能问反事实"框改成 210 呢"，**不用动真节点**）；③ 按**参考图**改版时，**每一轮开工前重读一次参考图**（实测只凭记忆改会跑偏，用户一眼就看出来），交付前把参考图与自己的截图并排看一遍；④ **只能真机跑的项逐条写 `[~]`，不许用肯定句**（"解锁后状态立刻变"这类话必须是**跑过**才写）。
- **动 `platform/` 之前先查「有没有被接线」**：`behavior` / `fsm` / `pool` / `red` / `guide` / `time` / `scene(SceneMgr)` / `ScreenAdpter` / `BundMgr` / `GameDataMgr` **全工程 0 调用**（`fsm_core` 连源码注释都自述"没有任何调用方"）；`store` 的 `persist`/`storeToRefs`/`$subscribe` 实测不可用（落盘一律走 `DataModule`）；`@bind`/`@bindValue` 从没用过且用了也绑不上（工程里没有 `&` 开头的节点名）。逐模块状态 / API / 生命周期流程图 / 踩坑见 **`docs/platform-guide/`**（19 章 · 62 张图 · 全部带 `文件:行号`），先看它的 `README.md`「平台层接线现状总表」。**引擎侧**：节点激活是三阶段批量调用（`__preload`→`onLoad`→`onEnable`，父先于子）、**反激活是父先、销毁是子先** —— 详见该系列第 0 章。
- **术语沟通**：用户用模糊词提需求（"手感""有点卡""优化一下""数值不平衡"）时，先按 `docs/游戏开发术语速查手册.md` **§0 描述模板**要一份**可验收的量化描述**再动手；术语疑似不同义查 §9，问"该改哪里"查 §11。
- **改打击感 / 表现强度**：先读 `docs/打击反馈设计.md`（「图纸印痕」定调 + 档位表 T0~T7 + 预算口径 + 不做清单）。三条硬判据：① 本作是**浅底图纸风**，发光/白闪/粒子/后处理**做了也看不见**（美术禁用清单）；② 顿帧是**对 DPS 的隐性征税**——只缩 `ctx.Tick`、**不缩** `elapsed`/阶段倒计时/Boss 限时，且 **1s 滑动账本内 ≤30ms**（大击杀/通关可把那一秒用满，绝不叠加）；③ 后期 3 次/秒 × 6 只/批 → 强度必须走**密度自适应衰减**。评审基线 = 演示台预设「本作建议」（那份文档的可视化）。
- **数值设计**：加载 Agent 技能 `jihe-numeric-balance`（`.agents/skills/jihe-numeric-balance/`），并参照 `docs/数值配置参考手册.md`（项目落地口径）与 `docs/数值设计调研报告_肉鸽塔防.md`（行业理论）。改配置表后无需改代码；但改 `attributes.json` 的属性范围/新增属性要同步 `battle/core/Types.ts` 的 `AttributeType` 与 `AttributeScaling.SCALE`。

### 主题索引

**→ [配表与数值口径](docs/agent-notes/配表与数值口径.md)**
- **肉鸽商店配置** —— 规则常量在 `shop_constants.json`；**商店道具就是遗物的局内版**；`gen-shop-from-hero-design.ts` 重跑后**必须再跑 `npm run migrate:affix`**，否则低档折算被打回。
- **肉鸽抽取的「技能配额」** —— 一轮（刷 4 格）里技能选项数 = 0~2，由 `RelicDraw.roll` 在进主循环之前先定。
- **遗物表 = 一件遗物一行** —— 局内版与局外版是同一件遗物、共用 `id`，只有效果与描述分两侧（`modifiers_inner` / `modifiers_outer`），`scope` 决定它在哪几侧出现。
- **局内遗物效果重做（✅ 已落地 2026-10）** —— 270+28 件局内遗物原来照搬 Dota2 装备（文案里全是本作没有的系统：砍树/守卫视野/信使/回城/莲花/中立代币/天神下凡/冰霜光环…），重做口径：**名字/图标不动**，只重写 `modifiers_inner` + `description_inner`（局外版完全不动）；**品质池深 4:3:2:1（白 107 / 蓝 80 / 黄 54 / 红 27，共 268 件，`RARITY_PLAN[].pool` 是唯一真源、生成器卡红线）**；**白档只给属性、蓝档起给钩子、一件最多 3 个钩子**；**不做主动型遗物**（6 个主动钩子已删、对应遗物改被动）；**白+蓝档不给百分比与百分比型属性（黄档起）、功能百分比（金币/经验/冷却/折扣）只给红档**；**有上限的属性（攻速 5 / 暴击率 100 / 闪避 45 / 护甲 200 / 冷却 50 / 折扣 80 / 魔抗 95 / 受伤减免 −80%）全池遗物总给必须高于上限**（配平层 `SUPPLY_TOPUP`）；**受伤减免(12) 是"全能减免"**（物理与法术都减，原 12/13 已合并、13 退役，`DamagePipeline.collectIncomingMultiplier` 一律取 12）；新增属性 **21 金币获取 / 22 经验获取 / 23 冷却缩减 / 24 抽卡折扣 / 25 吸血 / 26 攻击回复 / 27 攻击回蓝**（消费点分别在 `grantKillReward` / 同上 / `Ability.Cast` / `RelicShop.discount()` / `Entity.resolveAttackHit`，21~24 无上限轴靠 `OnExpGained` 等总线事件回场景层）。
  · **设计真源**：`tools/excel_export/scripts/lib/relic-inner-design.mjs`（`HOOKS` 40 条 + `ITEMS` + `ATTR_CAPS`/`SUPPLY_TOPUP`/`hookModId`/`descriptionOf` 都在这里，**派生层只有一份实现**）。
  · **三条生成/落表命令**（改设计后按序跑，都要回灌 xlsx）：`npm run gen:relic-design`（评审稿 `docs/relic-redesign/`）→ `npm run gen:relic-hooks`（`modifiers.json` 钩子行 200~239 + 减益/DoT 行 300~311）→ `npm run gen:relics-inner`（重写 `relics.json` 局内版、删除清单里的件整行删）→ `node src/cli.ts json2excel --force --table relics|modifiers` → `npm run export`。
  · **钩子实现**：`assets/scripts/game/battle/RelicHooks.ts`（40 个 `RelicHook_*` 参数化脚本类，数值全由配表 `kv` 传；注册表 `RELIC_HOOK_SCRIPT_CLASSES` → `Scene_Game_Stage.initBattle`，漏注册会**静默降级**成"抽到没效果"，生成器有一条红线专门盯 `HOOKS[].impl` ↔ 注册表）。
  · 落地时顺带修的：`check:affix` 的描述解析**先剥掉钩子文案**（否则「普攻命中叠 1 层：攻击速度 +2%」会被误报成"低档承诺了攻速"）；`audit:attr` 的属性表改成**从 `attributes.json` 现读**（手写表漏了新属性 21~27）、并给假上下文补了 `scriptRegistry` 惰性桩。
  · ⚠ **旧管线已停用**：`tools/excel_export/scripts/gen-shop-from-hero-design.ts` 会按 Dota2 设计稿重写局内版（重跑就会把这套设计覆盖掉）—— 现在它默认拒绝运行，要跑必须显式加 `--legacy-dota2`。
- **品质 × 词条门禁** —— 规则真源 `tools/excel_export/scripts/lib/affix-rules.mjs`，文档 `docs/配置规则_品质与词条门禁.md`；体检 `npm run check:affix`、迁移 `npm run migrate:affix`。
- **遗物 / Modifier 的时长口径** —— 踩过"遗物加的属性过一帧就没了"。同主题还有 **「加最大生命」的满血口径**（唯一入口 `Entity.ApplyWithMaxHpCarry(fn)`）与 **两处「配了也不生效」的静默陷阱**。
- **配表源漂移** —— 已按 JSON 方向回灌收敛；记住 xlsx 与 JSON **会互相覆盖**。
- **已知遗留噪声** —— `ConfigLoader.nameToAttrId` 仍映射 17~20 而 `AttributeType` 只到 16；`ExcelConfigDecorator.ts` 等旧框架文件仍在，新表一律走 `@tb_config` + `TbContainer`，勿新增旧式解码器。

**→ [技能与战斗系统](docs/agent-notes/技能与战斗系统.md)**
- **技能槽** —— 纯规则类 `battle/SkillSlots.ts` + HUD 侧组件；**槽 0 = 英雄专属技能、永久锁定**；详情面板节点契约在预制件的 `skill_details`；体检 `npm run audit:slot`。
- **局内（肉鸽）技能审查 + 技能图标 + 技能图集** —— 30 条肉鸽技能的审查结论、引擎口径（哪些事件真的会派发给 Modifier）、落地形态与修掉的两个真 bug，全文在 `docs/skill-icons/README.md`；实现在 `battle/ShopSkillModifiers.ts`。
- **英雄技能收敛** —— 现役英雄自带技能**恰好 1 个**（普攻不算技能条目）；**英雄技能必须是被动**，工程里没有主动施放入口。
- **火枪的唯一技能** —— 攻击附带 5% 攻击力额外伤害 + 15% 概率击退 1m（`battle/ScriptedModifiers.ts`）。
- **「米 → 像素」的唯一口径** —— `battle_constants.pxPerMeter`（现 50）：距离类配置一律**像素**。
- **索敌规则（粘性锁定 + 嘲讽 + 手动点选）** —— 唯一决策点 `Scene_Game_Stage.resolveAttackTarget`（优先级：嘲讽 → **玩家点选的手动目标** → 粘性锁定 → `attack_targeting`），普攻**不是**每帧重新选目标。**点击怪物切换攻击目标**：规则 `Scene_Game_Stage.onFieldTap`/`tickManualTarget`、几何 `battle/Targeting.pickTargetAtPoint`、输入与选中标记 `game_stage/entityview/TargetPicker.ts`、数值 `common/TargetSelectConfig.ts`。
- **对局结束 / 换局** —— 唯一收口 `Scene_Game_Stage.endRun(result, reason)`（幂等）；`resetRun()` 必须把上一局的英雄实体作废，否则上一局结算面板会立刻又弹出来。**重新选英雄**时等级/经验/遗物/Buff/技能槽都不变。

**→ [UI 与表现层](docs/agent-notes/UI与表现层.md)**
- **UI 通信规约（两层体系 + UIScope）** —— 铁律：状态向下（store / scope）、通知向上（emit）、兄弟之间只认共同祖先的共享状态。完整说明（生命周期顺序/时序图/踩坑清单/可复制配方）见 `docs/UI框架使用说明.md`。
- **局内功能四分** —— 选英雄 / 肉鸽商店 / 技能槽 / 击杀商店各一个纯 TS 功能类（`game/battle/`，无 cc 依赖），场景只做宿主；已删 `battle/ShopSystem.ts`（**勿恢复**）。
- **UI 页面数据分散 → 一个功能一个键 + 只读门面** —— 判据的唯一真源是 `battle/RefreshGate.ts`；改造后 19 键 → 5 键、`onLoad` 接线 83 行 → 10 行。
- **局外遗物图鉴**（`Scene_Menu` 左侧「遗物」页）= `Cmp_OuterRelics.ts` + `OuterRelicItem.ts` + `OuterAttrItem.ts`；含节点契约与**编辑器里改 Widget 的三个真坑**。
- **难度选择弹窗（100 档）= 一条完整链路** —— `Scene_Menu/ui_difficulty`（「开始游戏」先弹它，确认才进游戏）→ `Cmp_Difficulty`（铺 100 格 + 三态）/ `Cmp_DifficultyCell`（一格一组件，点一下 `scope.emit(Pick)` 冒泡上来）/ `DifficultyScope`（向上 `Confirm`/`Close`）→ `LevelData`（`cleared`/`selected`/`lastPlayed`，**解锁判据唯一真源**：通关第 N 档解锁 N+1）→ 局内五个落点（怪 HP·Boss HP·怪攻击·刷怪间隔·击杀奖励，倍率真源 `game/common/DifficultyConfig.ts`）。契约/曲线样本/验收清单见 `docs/difficulty-select/README.md`；出图提示词见同目录 `prompts.md`。四条口径：**格子是预制件 `cmps/DifficuteCell`**（`content` 里放一个实例当模板，运行期克隆 100 份，**模板自己当第 1 格** —— 多留一个不可见模板会被 GRID Layout 排进网格）、**档 1 = 基准平衡（所有倍率 ×1）**、**缩放是"每只怪出生一次"**（`MonsterPool.statScaleHook`，排在挂表现之前）、**三态与图例一一对应**（"已通关"目前无独立外观，要加就用 `gou` 换掉 `unlock` 的图）。
- **游戏模式（主界面「游戏」页的模式卡 · ✅ 菜单侧已落地 2026-11）** —— `Scene_Menu/content/right/game` 上的 `Cmp_Game`（`stage` 阶段模式 / `no_ending` 无尽模式，**默认 stage**；卡片节点名 = 模式 id，`card-002`「挑战boss」未做 → 被显式收起）。链路：点卡 → `LevelData.selectMode()` 落盘 → 点「开始游戏」→ 难度弹窗（**标题点名模式**）→「确定」→ `selectLevel(level, mode)` → 局内 `battleStore.mode` → HUD `info/mode` 显示模式名。真源 `game/common/GameModeConfig.ts`，契约/验收见 `docs/game-mode/README.md`。三条口径：**档位按模式各记一份**（`LevelData.modes[]`，**是数组不是字典** —— 字典会被 `mergeDeep` 吃掉）、**解锁阶梯全局共用**（`cleared`，两模式同一份 ⇒ 「最高通过」两模式同数、「上次玩过」跟着模式走）、⚠ **局内玩法差异（无尽模式）尚未实现**，只做了投影，落地入口是 `Scene_Game_Stage.checkStage()` 一处。
- **飘伤害字 / 单位血条**（表现层）—— `DamageTextLayer.ts` + `DamageTextConfig.ts`、`HpBar.ts` + `EntityHpBarConfig.ts`（**唯一数值源**）。
- **打击反馈（打击感）设计 = `docs/打击反馈设计.md`（「图纸印痕」）** —— 47 项里**开启 30 / 关闭 17**（其中 3 项是降级形态）；含**档位表 T0~T7**（每档的顿帧 ms / 位移 px / 印痕形状 / 膨胀 %）、预算与合并（顿帧 1s 账本 ≤30ms、位移 ≤6px 取最大不相加、印痕并发 ≤24）、**密度自适应衰减**（`k = clamp(0.55, 1, 1/(1+0.25·(n1s−2)))`）、**5 处改动点**与 B0~B4 批次。可视化 = 演示台预设「**本作建议**」。
  · **✅ B0+B1 已落地（2026-10）**：新增 `game/common/HitFeelConfig.ts`（**唯一数值真源**：档位/预算/衰减/印痕画法）与 `game_stage/entityview/HitFeelDirector.ts`（全局决策层：顿帧/慢动作/**战斗内容层位移**/账本/统计，**纯 TS 无 cc**）；改了 4 个文件：`HitFlash`（新增 `deform(pct,ms)`，`最终 scale = 基准 × 膨胀`）、`EntityView`（表现层抖动 offset + 膨胀 + Z-Pop，**不写 entity.position**）、`HpBar`（高度补偿改用**基准 scale**，否则受击那一帧血条会跳高）、`Scene_Game_Stage`（`tick(dtReal, dtCombat)` 双时钟 + `applyBattleShake` 位移战斗内容层）。
  · **✅ B2 图纸印痕已落地（2026-10）**：新增 `game_stage/entityview/HitVfxLayer.ts`（刻度 / 细环 / 对位十字 / 死亡碎片 / **起手虚线**，**整层一个 Graphics = 1 draw call**，池化的是数据对象），数值在 `HitFeelConfig` 的 `mark`（按档画几条）+ `HIT_FEEL_MARK`（怎么画：调色板/尺寸/寿命/合并半径）；`Scene_Game_Stage` 加 `ensureHitVfxLayer()`（三级取用，运行时建 `vfx` 节点并**插在 `damage_layer` 之前** —— 追加到最后会盖在 HUD 上）并把它加进位移层清单；顺带把 `projectile_1.prefab` 的弹体与 `MotionStreak` 从**荧光绿**改成墨色、`_fadeTime` 0.1→0.08，纹理换成自有 `textures/common/white_4x4.png`（落实风格预设 §9-8）。**两条口径落地时收敛过**：印痕一律墨色（**颜色只回答"打谁"**，暴击靠形状）、碎片**不取单位受击色**（详见设计文档 §4/§11）。
  · **✅ B3 信息层已落地（2026-10）**：新增 `game_stage/entityview/HitScreenLayer.ts`（**屏幕层**：墨色闪帧渲染 / 屏幕边缘受伤角标 / 连击计数 / 击杀落款 / 金币经验飞入，**整层一个 Graphics**）—— 它与 `HitVfxLayer` 的**唯一区别是"不抖"**（不在 `shakeTargets` 里，信息不该跟着震屏晃），节点插在 **HUD 之前**；墨闪的 α 由导出的 `flashAlpha` 出（时长/α 上限/1.5s 冷却账本在 `HIT_FEEL_BUDGET`）；击杀三件（连击/落款/奖励）由场景在 `grantKillReward` 里**显式调用**（奖励金额只有算数的那一方知道）；`HpBar` 加**延迟条**（残影条运行时建、**插在血条之前**=画在下面、借 hp_bar 的 SpriteFrame、0.6s ease-out 追上、回血直接跟到位）；`View_Game_Stage` 加 **HUD 数值弹跳**（帧驱动、收尾必须复位 scale）；`HitVfxLayer` 加**闪避斜杠**（F3）。
  · **铁律**：顿帧**只缩 `ctx.Tick`**（`dtCombat`），`checkStage`/`elapsed`/`bossScheduler` 一律走真实 dt —— 否则刷怪节奏与成就判定被静默改掉；**唯一例外档位**是 T5/T7（一次吃满那一秒的账本）。印痕层/屏幕层走**真实时间**（不吃顿帧/慢放），密度系数 k **出生时快照**。体检 `npm run audit:hitfeel`（**178 条**：时间税/钳制/同帧合并/每档图元数/合并与三级上限/起手虚线/墨闪冷却/角标贴边/连击清零/奖励落锚点/残影条收敛/换局无残留/**音效账本**）。
  · **✅ B4 音效已落地（2026-10）**：素材**不是"找来的"而是"渲出来的"** —— `tools/hit-feel-sfx/`（`design.mjs` 声音配方 + `render.mjs` 零依赖 DSP + `audition.html` 试听 + `check-drift.mjs` 三方对账 + `README.md`）产出 `assets/resources/sfx/` 的 **16 个音**（11 个音 + 5 个音高变体，139KB，16bit WAV / 22050 单声道 / 逐条峰值 0.80；零第三方素材 → 零授权义务）。代码链路：`HitFeelConfig`（`sfxVolume`/`sfxVariants` + `HIT_FEEL_SFX_EXTRA` + `hitFeelSfxKey`/`hitFeelSfxKeys`/`shouldPlayAttackSfx`）→ `HitFeelDirector.requestSfx`（**50ms 内 ≤2 声的节流账本 + 同帧只出最强档**；播放**回调由场景注入**，所以导演仍是纯 TS 无 cc）→ `Scene_Game_Stage.initBattle` 注入 `AudioMgr.ins.playSFX` 并 `preloadSfx`（**预加载是必须的**：`playSFX` 是"先加载再播"，第一次命中才加载会晚半拍）→ `AudioMgr`（`loadAudioClip` 改成**先 `resources.load` 再退回 bundle**，否则每次首载都白打一条 `分包:sfx加载失败`；`playSFX(url, volume)`）。
    · 三条落地口径：① **DoT 与普攻在总线载荷里完全同形 → DoT 也响 `hit_light`**（"不发声"要加 tag，被 §2 口径 5 否掉了，改由节流兜住）；② **出手音只给英雄**（怪走同一个 `Entity.Attack()`，全响会变底噪）；③ **全局触摸音从第一局战斗起生效**（`AudioMgr.ins` 第一次被访问 —— 之前全工程没人访问过它，所以"每次触摸一声 click"从未生效过）。
    · ⚠ **待办**：`assets/resources/sfx/` 的 16 个 `.meta` 要等 Cocos 编辑器首次导入才生成，**必须随提交入库**（否则构建出的资源没有 uuid、运行期取不到）。改音效音量后依次跑 `render.mjs` → `check-drift.mjs --write`。
  · **落地时改过的两处设计口径**（都在 `docs/打击反馈设计.md` §11）：① F4「连击」= **连续击杀**而不是"连续命中"（自动攻击下命中永不断连，计数只会单调涨）；② F7 角标用 `c-danger #C0392B` 而不是英雄受击色 `#FF4C4C`（后者语义是"打谁"，搬到整屏边框会变成第四种强调色）。
- **英雄详情弹窗（✅ 已落地 2026-11）** —— 契约/版式/数据来源在 `docs/hero-detail/README.md`（**§8 记了 4 处落地差异**），提示词在同目录 `prompts.md`（生成器 `tools/hero-detail-prompts/gen-prompts.mjs`，**只描述"要显示什么"+ 2 个缺的属性图标，布局交给 AI 自行分析、不写施工坐标**）。节点 = `Scene_Menu` 根节点上的 `ui_hero_detail`（静置 `active=false`）+ `Cmp_HeroDetail`；入口 = 英雄卡「详 情」。五条判据（②③④ 已落地、⑤ 已按它改完）：① 遮罩是**全屏**的 → 顶栏资源条会被盖住，**经验与金币必须画进面板**；② **升级花经验、解锁花金币**（两种用途不能混），经验是**所有英雄共用一份池子**（`HeroData.sharedExp`）、一局**通关**时按 `clearRewardHeroExpBase × rewardMul(难度)` 发放（`Scene_Game_Stage.endRun` → `DataCenter.grantClearHeroExp`；中途退出走 `exit()` 不发）；③ 属性行是英雄**真配了的 5 项**（`HeroConfig.HERO_DETAIL_ATTR_ROWS`：生命/魔法/攻击/攻速/距离），**不是**英雄卡那 4 行（卡上第 3 行「护甲」对英雄恒为 0）；④ 升级价 = `HeroData.getExpForNextLevel(level)`（`100 × 1.12^(lv-1)`，**展示与结算共用同一把尺**）；⑤ 旧的 `addHeroExp`（发经验即自动升级的循环）**已整体删除**（它全工程无调用方），`heroLevelUpGoldBase/Ratio` 与 `HeroConfig.getLevelUpCost` 随之失去消费者（保留只作历史读法）。
  · **三条实现口径（改这个弹窗前必读）**：**宿主是 `Scene_Menu` 而不是 `Cmp_Heroes`** —— `UIScope.emit` 只沿 `node.parent` 向上，而 `ui_hero_detail` 必须挂在根节点上（要盖整屏），`Cmp_Heroes` 收不到弹窗发的事件；而 `Unlock`/`LevelUp` **只能有一个监听方**（卡片与弹窗发同一个事件，两边各接一半 = 从弹窗点一下被处理两次、重复扣费）。**判据只有一份**：`scene_menu/cmps/HeroVM.ts`（`isHeroActionEnabled` / `buildCardVM` / `buildDetailVM` / `heroFingerprint`）供卡片与弹窗共用 —— 两边各写一份迟早「卡片说能点、弹窗说不能点」，而这两处**从不并排显示**、界面上极难发现。**升级侧比解锁侧多一条 `价 > 0`**：解锁是一次性的（免费解锁最多白送一个英雄），升级**无上限**，配表没给经验口径时放行就是"点一下升一级"的无限白送（`HeroData.tryLevelUp` 也会拒）。
  · ⏳ **还差两张美术图**：`hero_attr_mana` / `hero_attr_atk_speed`（`HeroConfig.ATTR_ICON` 里留的是**空串** = 保留预制件占位图；**不要**填一个不存在的路径，那会让每次开弹窗都刷"图标加载失败"）。
  · **✅ 体检已补齐（2026-11）**：`npm run audit:herocard` 新增 **H 组**（真 `Cmp_HeroDetail.ts` 跑在真 `Scene_Menu.prefab` 子树上）钉住 23 个引用 / 三态 / 按钮两态色 / **点一下真的冒泡出哪个事件 + heroId** / `onDispose` 收尾；`npm run audit:ui` 把"字号只落阶梯、颜色只出 tokens"变成门禁。**H 组当场抓到一条真 bug**：未解锁时「持有金币」那一格被隐藏（`active = vm.unlocked` 写反了 —— 那一步花的就是金币，余额却看不见），已改成两态都显示。
- **局外商城（全屏页 · ✅ 界面 + 数据层都已落地 2026-11）** —— 卖什么 / 数值依据 / 决策登记 / 施工与验收清单见 `docs/shop/README.md`（§2.3 免广告卡、§3.4 决策登记），提示词在同目录 `prompts.md`（生成器 `tools/shop-prompts/gen-prompts.mjs`），体检 `npm run audit:mall`（**174 条**）。五条判据：
① **形态 = `views/` 形态的 `BaseView`**：预制件 `prefabs/ui/views/shop/View_Shop.prefab`(110 节点；**广告区 `ad_list` 是竖直滚动列表** —— `ad_list`=ScrollView / `ad_list/view`=Mask / `ad_list/view/content`=GRID Layout，下沿停在免广告卡上方 12px，⚠ **Mask 不能和 ScrollView 同节点**) + `View_Shop.ts`(`@uiview`，layer=View、single) + 契约 `views/shop/ShopScope.ts`(事件 + `ShopPageVM`) + **判据 `views/shop/ShopVM.ts`**（`buildShopPageVM` / `shopFingerprint`）；**返回自关**，开之前先 `closeDifficultyPanel()` + `closeHeroDetail()`。⚠ 旧版"`Scene_Menu` 内嵌 `ui_shop`（`UIWidget`）"的说法**已作废**；② **宿主 = 这一屏自己** —— `UIScope.emit` **不跨 UIManager 的层节点**（`views` 与 `scenes` 是兄弟），"宿主 = `Scene_Menu` 收页面事件"**做不到**；页面自己 `scope.on`/`emit`，`Scene_Menu` 只管"开"与"与另两个全屏面板互斥"（与 `View_TaskUI` 同形）；③ 商品**全部看激励视频获得** + **每天 1 次不看广告的免费领取**，这一屏**没有任何付费点**；广告返回 `false` → **不发奖也不记次数**（`AdMgr` 口径），⚠ **不画「广告暂不可用」灰态**，由页面在底部说明行给一行中文提示（`flashHint`）；④ 卖的全是**既有资源的加速**（金币 / 通用英雄经验 / 账号经验 / **三种券**：局外遗物抽取券 / 局内复活券 / 局内广告券），券一律进背包（`bagData`），四条"不卖"的理由见 §2.5；⑤ **数值唯一来源** = `mall_items.json`（**一行一商品**：`grants`/`daily_limit`/`placement`/`name`/`amount_text`）+ `battle_constants` 的 7 个 `shop*` 键 → 门面 `MallConfig`；**格子上的 `+300 金币` 与真正发的数是同一份数据**（VM 下发那两行标签），`Σ daily_limit` 必须 = `shopAdDailyTotalLimit`（14）。三条落地口径：**全屏页只有一颗实心按钮**（「免费领取」；免广告卡是青绿**环** + 深墨字，⚠ 环烤进贴图**不能染色**）；**免广告卡** = 攒满 **84 次**换 **24 小时**、**不可叠加**（生效中再领被拒）、领后清零重攒、**只替换局内那两个广告位**、不抬局内次数上限；**界面显示的数 == 到手的数**（`DataCenter.previewShopDailyGift` 与发奖同一把尺 —— 让界面自己 `× 1.5` 迟早差 1）。· ✅ **局内消费侧只剩一处没接**：局外属性进战斗（§4 第 9 条）；**局外遗物抽取扣券**（✅ 2026-11：`DataCenter.drawOuterRelic`）、**局内广告券（替换两个广告位）与局内复活券都已落地**（判据 `RefreshGate.viaTicket` / 阵亡拦截 `Scene_Game_Stage.onLethalForHero`，见 `docs/bag/README.md` §1.1/§10）。🚧 另有顶栏三格读数（`ernergy-001/002` 语义待拍板）。· ⚠ 底部页签 `bottom/left/shop` 的**图标现在用的是 `textures/shop/daily_gift`（礼盒）**，与「商城」语义不符（`bag`/`task` 用的是 `textures/common/*`；同一排里语义接近的是 `common/store`）。
- **局外背包（全屏页 · ✅ 界面 + 数据层都已落地 2026-11）** —— 装什么 / 一件道具长什么样 / 容量口径 / 决策登记 / 三种券的消费点见 `docs/bag/README.md`（§1.1 消费点表 / §10 复活链路），体检 `npm run audit:bag`（**145 条**）。四条判据：① **形态与商城逐字同口径**：预制件 `prefabs/ui/views/bag/View_Bag.prefab` + `View_Bag.ts`(`@uiview`，layer=View、single) + 契约 `views/bag/BagScope.ts` + **判据 `views/bag/BagVM.ts`**（`buildBagPageVM(选中谁)` / `bagFingerprint`）；**返回自关**，**页面自己就是宿主**（`UIScope.emit` 不跨 UIManager 的层节点）；② **表 = 字典，`BagData` = 存量**：`bag_items.json` 一行一件（名字/图标/品质/堆叠上限/有效期），**代码里不写死任何一件道具**；存量在 `data/funcs/BagData.ts`（存档键 `bag_data`，`items` 是**数组** —— 动态字典会被 `mergeDeep` 吃掉）；③ ⚠ **券/次数已从 `ShopData` 搬到 `BagData`**（`ad_ticket` / `revive_ticket` / `outer_draw_ticket` / `boost_<effect_code>`）—— 它们不是"商城的记账"而是**玩家背包里的东西**，两处各存一份迟早出现"商城说 2 张、背包说 0 张"；`ShopData` 那 10 个方法**已删除**，商城发奖改道 `bagData.addItem`；**旧存档里那三个字段会被丢弃**（开发期可接受）；④ **文案宽度是硬约束**：名字框 `CLAMP` ⇒ 超了**静默裁字**，正文框 `RESIZE_HEIGHT` ⇒ 不裁字但**写长了会把「使用 / 出售」顶出面板**（B8 按面板高算额度）—— 两种编辑器里都看不出来，`audit:bag` 的 B 段**从预制件现读框尺寸**再估价。四条落地口径：**一格 = 一种道具**（容量的分子是种类数）、**容量先定死 80**（`BagConfig.BAG_SLOT_CAPACITY`；扩容按钮保持预制件的收起态）、**「使用 / 出售 / 扩容」本期只读**（置灰 + 详情面板第二行回答"为什么" —— 界面上不许出现"点不动又不说为什么"的按钮；"出售"开金币回收口会与「金币是抽取燃料」的既有经济打架）。· ⚠ 每格 `×N` 只在 **N ≥ 2** 时显示；**格子恒画满 80 个**（2026-11 补：`BagVM` 补空槽、`BagItem` 按 `vm.empty` 分派——空槽只画 `#D8D8D8` 灰底、无图标/数量/环、点了不冒泡；铺几格是**判据层**的事，`View_Bag` 里不许出现 `BAG_SLOT_CAPACITY`）。· ⚠ **详情面板恒显示**（2026-11 用户改版口径）：没选中时画「未选中」占位态（灰底 `BagScope.BAG_EMPTY_FRAME` —— **与格子空槽同一个常量**、名字 `BAG_NO_SELECTION_TEXT`，图标/正文/两个按钮全收起），两态由 `vm.detail.empty` 一处分派，**不再整块收起**（见 `docs/bag/README.md` §3.7）。· ⚠ **`resolveRefs` 的 `??` 兜底只认"没拖"、拦不住"拖错"**（改预制件层级时踩过：`detailNode` 指到了子节点）—— `audit:bag` 的 **F16b/F16c** 逐条核对。· 🚧 还差：真机确认倒计时/80 格滚动/**面板两态切换与那个 ScrollView 的拖动边界**、三处只读项。（✅ 遗物抽取次数的消费口 2026-11 已落地：`DataCenter.drawOuterRelic`，见上一条）
- **局外成长规则（遗物抽取 + 账号等级加成 + 局内广告券 · ✅ 抽取/广告券已落地、等级与属性接线仍 🚧 2026-11）** —— 口径真源 `docs/meta-growth/README.md`（数值/推翻记录/施工清单/验收），体检 **`npm run audit:draw`**（**90 条**：真跑 `OuterRelicDraw` + `DataCenter` + 真配表 —— 池子/品质权重/档内优先未收集/价格阶梯/**券优先且不抬价**/十连/部分成功/跨天重置/**预览==实扣**/**存档往返**/旧存档迁移/预制件节点契约/漏洞已堵）。五条判据：① **遗物不再由结算产出**（`docs/gdd_reward/tabs/settle.html` 的「数量→品质→id 三段抽」**已作废**，品质权重那一层被复用；`endRun` 现在只发英雄经验，所以是**纯纸面推翻**），改为**局外花金币抽取**：池子 = `scope` 含 `outer` 的 **37 件**（白12/蓝8/紫11/红6）、品质权重 **6:2.5:1:0.5**、档内**优先未收集**、价格 **200 / +100 / 封顶 600 且每天 0 点重置**（日键同 `TaskData.todayKey()`）、**份数无上限**（`getAllEquipmentBonuses` 按份数线性累加 ⇒ 局外属性无天花板，集齐 37 件期望 **≈775 抽 ≈ 25 万金币**）。**✅ 2026-11 已落地**：规则类 `battle/OuterRelicDraw.ts`（纯函数：权重 / 档内优先未收集 / 阶梯 / **付费方案 `plan()`**）、唯一出口 `DataCenter.drawOuterRelic(count)` + `previewOuterDraw(count)`（**先用券 → 再扣金币**，券抽**不抬阶梯**）、三个常量 `battle_constants.outerDrawCost{Base,Step,Cap}`、当日记账 `EquipmentCollection.drawPaidCount`（**只随金币抽前进**）；界面在图鉴页总览顶行（进度卡 250 + **十连勾选框** 78 + **「抽 取」按钮（按钮上就写着这次要花什么）** 170），消耗**由 `previewOuterDraw` 下发**、界面一行价格都不算；⚠ 顺带修掉一个真 bug：`collected` 原来是**动态字典**，`mergeDeep` 读档会把整片吃掉（图鉴一重启就归零）→ 改**数组** + `migrateCollectedShape()`（口径同 `BagData.items`）；② ✅ **漏洞已堵（2026-11）**：`Scene_Game_Stage.onRelicCollected` 里那行 `addCollected` 已删（方法体清空、只留回调位与说明），局外遗物**只有抽取一个来源** —— 否则局内池 268 件里 **28 件"两侧都有"**一局必然全到手 ⇒ **打两局局外属性就翻倍**；③ **账号等级（1~30）给局内加成**：每级 **击杀金币 +1% / 局内经验 +1%**（满级 +30%），**Lv10/20/30 给开局金币 +50/+100/+200**（不是每级 +50 —— `run_start_gold` 的 cap 只有 200，每级 +50 满级就是基础的 15 倍）；消费点只有 `Scene_Game_Stage.grantKillReward`（现在已是 `成就 + 遗物属性21/22` 两源相加，**加第三个来源就是一行**）+ `selectHero` 的开局金币（🚧 未做）；④ **红档遗物带局内特效词缀**，6 件各一条，**全部复用现成的 10 条 `AchEffectCode`**（`run_start_gold`/`gold_gain_bonus`/`battle_exp_bonus`/`hero_start_level`/`shop_draw_discount`/`kill_buff_discount`）⇒ **零新机制**；数值型按份数 Σ、次数型取 max，且**必须与成就/等级共用同一张 cap 表**（否则"份数无上限"+ 不 clamp = 开局金币无限涨；开局金币**总上限推荐 400** = `initialGold` 100 的 4 倍）；⑤ **局内广告券**（局外看广告攒、局内免看广告）：券在**商城**拿（看 1 次广告 +1 张、每天 2 张），**跨局累积**；局内只覆盖**肉鸽商店的两个广告位**（`RelicShop.refresh` 的 `playAd('relic_refresh')` = 免广告抽卡 / `RelicShop.pick(id, viaAd=true)` 的 `playAd('relic_extra_pick')` = 免广告补选遗物），**选英雄与击杀商店照旧走广告**、`pause_resume` 永远不收券；优先级 `金币够 ＞ 有券 ＞ 看广告 ＞ 置灰`；⚠ **券只替换广告、不增加局内次数上限**（那 3 次免费刷新 / 1 次补选照扣）—— 否则跨局攒券 = 攒出无限次数、还会顶破"一局吃 70~85% 池子"的旧目标；判据改在**唯一真源** `battle/RefreshGate.ts`（加 `viaTicket` 可选输入 + 字段，**`refreshButtonKey()` 必须一起带上这一位**，否则"有券了按钮还写着看广告"），界面第三态在 `RefreshButtonView`（券图标 `textures/common/ad_ticket` + 文案「用 券」）。**✅ 已落地 2026-11**（判据 + 两个广告位 + 两处界面；`docs/bag/README.md` §1.1）。· **商城随之改**：A4 = **每天 2 次、每次 +1 张局外遗物抽取券**（只给券不给遗物，免费抽不扣金币也不抬价）；**A6 局内广告券**（每天 2 张）；**A5 由「开局增益券」改成「局内复活券」**（每天 2 张，阵亡时消费；本局增益券只剩"连续登录赠券"一个出口）；每日广告总上限 **11 → 14**（六格之和不变，`docs/shop/README.md` §2.2）。
- 两条小铁律：**表现层 `onDestroy` 里绝不碰别的组件**、**`@uiview` 的 `prefabPath` 是 `resources` 相对路径**（挪预制件必须同步改代码）。

**→ [美术资产管线](docs/agent-notes/美术资产管线.md)**
- **遗物图标重出图（Qwen-Image-2.1 · ComfyUI）** —— 出图规范与替换步骤全在 `docs/relic-icon/README.md`；四条硬口径：出图必须 1:1 正方形、交付 64×64 RGBA、透明底提示词**只做正向陈述**（两次翻车）、品质不进出图。
- **英雄头像 / 技能图标（白描徽记）** —— `tools/hero-icon-prompts/` + `docs/hero-icons/README.md`；纯白 `#F6F6F6` + 真 alpha（不是遗物那套"中明度彩色主体"）；**包围盒必须正方形**，形变 > 1.15× 要改提示词而不是接受形变。
- **遗物图标落本地** —— `icon` 是 `resources` 相对路径且**不带扩展名**；只有 7 件局外独有中立道具仍是远程 URL（`loadRemoteFrame` 分支**不能删**）。⚠ 碎图已被**图集**（`relics.plist` + `relics.png`）取代，回退不用改代码。
- **技能图标 / 技能图集** —— `skills.plist` + `skills.png`（40 张 64×64）；取图三步降级链已抽成共享实现 `assets/scripts/game/common/AtlasIcon.ts`，并把"命中哪条路"打进日志。
- **出图提速的真相** —— 换 5.88GB 的 `qwen3vl_8b_w4a8` 让模型**装得下并常驻**（装得下就别调 `/free`、别降分辨率/步数），约 **9 s/张**；判据是跑完 `nvidia-smi` 显存还占着。

**→ [工具与工作流](docs/agent-notes/工具与工作流.md)**
- **打击感演示台 = `tools/hit-feel-preview/`** —— 把打击感拆成 **47 个可独立开关的要素**，预设「项目当前」只开 3 项（= 工程现在的打击感水位）；带 `check-drift.mjs`（160 项真源对账）与 `audit.mjs`（78 条真跑）。改工程配色/时长/数值后要同步 `index.html` 的真源快照。
- **体检脚本的套路** —— `audit:attr` / `audit:slot` / `audit:hero` / `audit:skill` / `audit:reach` 都是「**真跑源码 + 真配表**」；而 `npm run check` / `npm run verify` 只验配表**格式**，**验不出**「配表写对了但运行时是脏数据」。
  · `audit:reach` 专治「配表合法但运行时不可交互」：本作英雄**固定居中不动**、怪从 `spawnRadius`（650~800px）外圈刷新，所以**任何"不主动靠近"的 AI 都会让怪停在射程外**（`wander` 必须配 `aggroAfter` 兜底；`orbit` 的 `orbitRadius` 必须 < 英雄最小攻击距离）。真实踩过一次：混怪表引进 `wander`/`orbit` 后游荡者与环绕魔双双变成打不到的怪。
- **一次真实事故的复盘** —— `Get-Content | Set-Content` 写坏 UTF-8 源码，靠"生成器 + 产物互为快照"重建；可复用的结论：改文件一律用显式 UTF-8 的工具。

**→ [平台层使用教程](docs/platform-guide/README.md)**（19 章 · 62 张 mermaid · 每条结论带 `文件:行号`）
- **每章统一 10 节**：一句话/源码地图/快速上手/API 速查/**生命周期与流程图**/与 Cocos 生命周期的关系/组合用法/现象→原因→做法/调试手段/事实依据。入口先看 `README.md` 的**「平台层接线现状总表」**（✅在用 / ⚠️半接线 / ❌备而未用）与**「跨章节重要发现」**。
- **第 0 章 = 生命周期总纲**：引擎三阶段激活、反激活 vs 销毁的顺序、**平台模块创建/销毁总表**、启动时序（Loading→Main→菜单）、**一局对局边界**（`show`/`resetRun`/`initBattle`/`endRun`/`exit`）、`update` 里的**双时钟**（顿帧只缩 `ctx.Tick`）。

### 已知遗留 / 未接线（做相关功能时顺手处理）

- `units.json` 1002 赏金猎人攻击力 **200**（其余英雄 24~44，设计稿写 12），量级差 5~8 倍，疑似配表笔误。
- `units.json` 的 `prefab` 列是**死数据**（全工程无消费方），现有 4 条是悬空引用，新英雄这列**故意留空**。
- `abilities.json` 有 **16 行死数据**（id 2~6、8~15、18 未被任何单位引用）→ 给它们出图是白花钱。
- **⚠ 过期结论别再照抄（两次变更，按时间读）**：① 「`EquipmentCollection.addCollected` 全工程无调用方 / 局内掉落→局外收集还没接线」**已于 2026-10 失效** —— 当时改成由 `Scene_Game_Stage.onRelicCollected` ← `RelicShop.onRelicGranted` 调用（只记 `scope` 含 `outer` 的那 37 件）。② **2026-11 规则修改又把这条接线整个废掉**：局内抽到的遗物**不再**写局外图鉴（局外遗物只能靠**金币抽取**获得，见 `docs/meta-growth/README.md` §0.2）—— 所以 `onRelicCollected` 里那个 `addCollected` 调用**是要删的**、不是要保的。`game/data/configs/EquipmentConfig.ts` 头注释里"尚未接线"那句同样过期（"收集"这条已接线又已拆，"属性进战斗"那条**至今仍未接**）。
- 局外遗物 `description_outer` 写法不统一（攻速写成 `+0.2 攻击速度` 而非 `+20%`），**属性总览按数据说话、与描述文案可能对不上**。
- UI 批次 4（可选）：把 `StageScopeKeys.*` 换成 `StageScopeMap` 的类型化键。
- **难度弹窗还没落地的表现**（设计稿见 `docs/difficulty-select/prompts.md`，预制件里**没有对应节点**）：10 个**段页签**（`diff_tier_01~10`）、每 10 档的**头目门槛**（`diff_boss_gate`，段末格略宽 + 角标）、选中格的**右上角标**（`conor`）、弹窗顶部主插图（`diff_ladder`）。`assets/resources/textures/difficulty/` **目录都还不存在**（12 张徽记未出图）。段名（新兵/老兵/…/终焉）已经在 `DifficultyConfig.DIFFICULTY_TIER_NAMES` 里备好，目前只进日志。另：`View_Game_Stage/info/mode` 仍是预制件里的死文案「**阶梯模式**」，与主界面「阶段模式」不一致（本轮只把隔壁 `info/name` 接成了「难度 N」）。
- `docs/hero-design/` 那个 30 英雄设计库用的是**火/冰/毒/雷/暗元素体系**，而本作**只有物理/法术**，引用它时必须把元素那层剥掉。
