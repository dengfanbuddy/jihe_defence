# dsh_chat 对话成本分析：一个「简单登录预制件」为什么花掉 79 步

> 分析对象：`<DSH_HOME>/sessions/--D-Project-cocos-jihe_defence--/` 下 2026-09-29 ~ 09-30 的会话日志（zstd JSONL，逐帧解压后按事件统计）。
> 复现工具（一次性、已 gitignore 在 `.tmp/`）：`dsh-trace.mjs`（全事件轨迹）、`dsh-calls.mjs`（步/调用/重复/token）、`dsh-workload.mjs`（代码量与 pwsh 靶子）、`dsh-timeline.mjs`（全会话时间线）、`dsh-grep.mjs`（按正则捞事件）。

---

## 0. 结论先说

1. **最近这次（04:23）不是「模型慢」，是三个能力缺口**：① 预制件写回没有 API；② 唯一的视觉验收通道（`cocos_capture_view`）返回空白帧且没有退路；③ 内置资源与组件坑没有落盘。6.1 分钟里写了 **51KB JS**、79 步里 **36 步**花在这三件事上。
2. **真正贵的是「重复」。** 一夜之间同一个任务做了 **3 次真跑**（15:47 / 00:49 / 04:23；另有 03:20 那 41 秒因 `dfan_mcp2` 被禁用、工具链全挂而夭折），外加 1 次复盘（00:10，109 分钟）与 1 次报错排查（03:24，59 分钟）。四次之间**经验一个字都没传下去**：A 的预制件被覆盖、A 的 recipe 变成孤儿、A 花 12 步抢救的视图损坏状态没人接手。
3. **知识库已经有了，而且是被「合法地」废弃的。** 00:59 那条 `build-login-ui-tree` recipe 里写着「★ sizeMode 必须先于 spriteFrame 赋值（默认 TRIMMED 会把节点撑成贴图原始尺寸）」——**正是 04:23 又踩一次、又花时间修的那个坑**。03:24 迁移时你明确选了「**丢弃掉**，给现在的 recipes 加规则，应该是可以复用的才保存」，于是目录从 `.dfan-mcp` 换成了 `.dsh-mcp`、旧目录不再被读；**但那条 recipe 里的「事实」从来没被榨进 skill**。3.5 小时后，同一批坑重新付了一遍钱。
   → 所以结论不是「要有知识库」，而是**「丢弃代码资产之前，先把里面的事实搬进 skill」**——代码可以丢，事实不该跟着丢。
4. **需要知识库，但不是向量检索库。** 三个载体（skill=人策展的事实 / recipe=跑通的代码 / describe_api=运行时反射）**骨架都已经在了**，缺的是**内容、触发、生命周期**；真要用代码补的只有两处：**预制件写回**，以及**先修好/能自检场景视图状态**（不是先造离屏渲染器——见 R2）。

---

## 1. 证据：一夜之间的时间线

| 开始 | 会话 | 时长 | 日志 | 步 | 调用 | 结果 |
|---|---|---|---|---|---|---|
| 09-29 15:47 | `4b2ee6de` | 5.7 min | 647 KB | 63 | 75 | 19 节点登录 UI（当时没有 `cocos_*` 工具，模型自己搭了个 JSON-RPC 桥连 dfan 的 8731 端口） |
| 09-30 00:10 | `d22a6ff5` | **109.3 min** | 1044 KB | 164 | 180 | 「为什么这么长」复盘（turn 1，3.9 min）→ 你说「可以修复」→ **turn 2（9.2 min / 113 调用 / 38 次 edit）当场修了插件** |
| 09-30 00:49 | `37423001` | 10.0 min | 1323 KB | 65 | 85 | 27 节点预制件（uuid `49ab8656-…`，**现已不在磁盘**）+ 最后一步存下 1 条 recipe |
| 09-30 03:20 | `ae9668b2` | **41 秒** | 148 KB | 20 | 27 | **能力全挂**：dfan_mcp2 已被禁用 → 沙箱没了，`turn/end` = `aborted/disposed`，零产出、零文字 |
| 09-30 03:24 | `session-0e211bb9` | **59.3 min** | 1458 KB | 118 | 177 | 报错排查 → dfan_mcp2 能力迁进 dsh_chat |
| 09-30 04:23 | `ad6ce9c2` | 6.1 min | 805 KB | 79 | 91 | 29 节点预制件（80 KB），**无 recipe** |

同一个任务（登录预制件）：**3 次真跑（15:47 / 00:49 / 04:23）+ 1 次因能力全挂 41 秒夭折**，合计 **21.8 分钟 / 2.8 MB 日志 / 207 步 / 251 次调用**；连支撑会话算上 **≈ 131 分钟 / 3.9 MB / 389 步 / 455 次调用**。

> **最刺眼的一条**：这一整夜里，唯一**活到今天**的产物是那条 recipe（A 的预制件 `49ab8656-…` 已被覆盖/删除；今天的 `LoginView.prefab` 是 04:23 重做的 `46de9908-…`）。而它恰恰是现在 `findRecipes()` 看不到的那一条。

---

## 2. 最近这次（04:23）为什么长：分阶段账

**硬数字**

| 指标 | 值 |
|---|---|
| 墙钟 | 6.1 分钟（79 步，平均 4.6 s/步） |
| 事件 / 解压 | 2770 事件 / 1733 KB（原始 805 KB、1881 个 zstd 帧） |
| 输出 token | 70,575（其中 **reasoning 43,885 ≈ 62%**） |
| 首步 input | 28,124 token（含 AGENTS.md 注入 40 KB + skill 目录 7.9 KB） |
| 写进 `cocos_execute_code` 的代码 | **51,028 字符 ≈ 50 KB**（43 次调用，单次最大 6,858） |
| `pwsh` 25 次 | **25/25 全部指向 `C:\ProgramData\cocos\editors\Creator\3.8.6`**；6 次读引擎 `.ts` 源码，3 次啃 `.ccc` 压缩产物；**0 次**碰工程文件 |
| UI 重建次数 | **3 次**（6,278 / 6,516 / 6,739 字符） |
| 重复调用 | 仅 1 次（读同一张 mock 图）→ 不是"笨"，是"没路" |

**分阶段（按 step）**

| 阶段 | 步 | 干了什么 |
|---|---|---|
| 侦察：内部资源 + 引擎组件源码 | s1–s30（30 步） | `db://internal/default_ui/*` 找贴图、猜 uuid、`loadAny` 试 4 次、pwsh 读 `edit-box.ts`/`toggle.ts` |
| 搭 v1 | s31 | 6,278 字符一次性建树 |
| 视觉验收失败 → 改数值验收 | s32–s41（10 步） | `capture_view` **blankRatio=1** ×2、试 `select`/`focus-camera`、自写布局数值校验 |
| **预制件写回逆向** | s42–s61（**20 步**） | `scene:create-prefab` 失败 → 10 次 pwsh 搜编辑器 → 发现 `.ccc` 是压缩的 → 反射 `globalThis` → 找到 `cce.Prefab.createPrefabAssetFromNode` |
| **自建离屏/Canvas2D 渲染器** | s62–s77（**16 步**） | `RenderTexture` 离屏失败 → 用节点数据 + Canvas2D 自己画布局对照图 → `color.toHEX()` 少个 `#` 再修一次 |
| 收尾 | s78–s79 | 核验文件、写交付说明 |

**换算**：若这 36 步（预制件写回 20 + 验收 16）变成 2~3 步工具调用，这次会话大约落在 **15 步以内**。

---

## 3. 七条根因（按代价排序）

### R1｜预制件写回没有任何能力（20 步）
插件工具面与 cheatsheet 里**一个字都没提 prefab**（只有 `query-assets` 查 `.prefab`）。于是每一次都要**重新猜**，而且两次结果不一样：

- **00:49 那次（A）**：`Editor.Message.request('scene','create-prefab', nodeUuid, url)` **是能用的**——A 在第 39/44/59 步调了 3 次，产出了 `LoginView.prefab`（uuid `49ab8656-…`）。
- **04:23 那次**：同一个消息**失败**，回 `The thing you want to instantiate is nil`，**不给任何原因**（而当时 `db://assets/prefabs/LoginView.prefab` 这个 url 上还躺着 A 留下的同名资产——最可能与"目标已存在"有关，但没人知道）。随后 10 次 pwsh 挖编辑器安装目录（找到 `package.json` 里的 `create-prefab` 声明、发现 `.ccc` 是压缩的读不出来），最后靠反射 `globalThis` 才找到**真正稳定可用**的那条：

```js
// context: 'scene'，实测可用
await cce.Prefab.createPrefabAssetFromNode(nodeUuid, 'db://assets/prefabs/LoginView.prefab');
// 副作用：场景里的原节点会被替换成该预制件的实例（nodeStillInScene=false）
```

**这些事实一条都不在任何文档、skill、工具描述里**：两个 API 谁在什么条件下可用、目标 url 已存在时怎么办（覆盖？先删？另存？）、原节点会被替换成实例——全靠现猜。

### R2｜视觉验收通道失效且没有退路（16 步）
`cocos_capture_view` 老老实实回了 `blankRatio: 1`（"基本是空图"），实现里也有 `sampleBlankRatio` 检测——**但没有任何替代方案**。模型于是自己造：重试 `waitMs` → `select`/`focus-camera` → `cc.RenderTexture` 离屏（也拿不到帧）→ 最后用节点真实数据 + Canvas2D 手绘布局对照图（这条路其实是**对的做法**，但花了 16 步并踩了自己的 bug）。
`README.md` 的「已知限制」里也**没写**这条。

**⚠ 而且它很可能不是"环境不支持"，是被前一次会话打坏的**：00:49 那次为了"模拟设备高度验适配"，在 `context:'scene'` 里调了

```js
cc.view.setDesignResolutionSize(750, 1624, cc.ResolutionPolicy.FIXED_WIDTH);
cc.view.setDesignResolutionSize(750, 1000, cc.ResolutionPolicy.FIXED_WIDTH);
cc.view.setDesignResolutionSize(750, 1334, cc.ResolutionPolicy.FIXED_WIDTH);   // 想还原
```

（`37423001` 会话 step 46，`timeoutMs: 60000`）。后果（复盘会话实测）：编辑器**场景视图的设备模拟被打掉**，Canvas 从 750×1334 变成面板比例 671.6，`visible = 750 × 559.35`、`frame = 775 × 578`，已对齐的 Widget 被按旧几何反算 margin → 根节点高度算成 **-5289**。A 会话随后花了 **12 步（s46–s57）**抢救，试过 `setFrameSize`/`setCanvasSize`、13 个不存在的场景消息、DOM 探测，最后靠 `Editor.Profile.getConfig/setConfig('scene','scene_view.output_device')` 才把 `output_device` 改回 `__default_design__`——**但没有真正恢复**：复盘时实测仍是 `visible = 750×559.35` 的裁切状态，04:23 的 `capture_view` 依旧 `blankRatio: 1`。

→ **行动顺序应该是：先修/确认编辑器视图状态（场景视图工具栏重选 750×1334 设备），再决定要不要自建离屏渲染器。** 否则会在"环境不可用"的错误前提下造一套昂贵的替代品。同时插件应把"视图是否在渲染"变成一条**可探测、可自愈或可明确声明**的事实，而不是每次会话重新发现。

### R3｜recipe 被废弃，但里面的**事实**没被榨出来
- 00:49 会话存下 `.dfan-mcp/recipes/build-login-ui-tree.js`（7.7 KB，53 行，2026-09-30 00:59:08），里面写清了：
  - `sizeMode = CUSTOM` **必须先于** `spriteFrame` 赋值（否则节点被撑成贴图尺寸 → 04:23 又踩一次的"EditBox 被缩成 2×2"）
  - Widget `AlignMode.ALWAYS` 的用法、底部条用 `Layout(BOTTOM_TO_TOP)` 避开"单边对齐在回写时漂移"的引擎坑
  - `EditBox` 的 `TEXT_LABEL`/`PLACEHOLDER_LABEL` 处理、`snapshot()`、`return {nodeUuid, nodes}` 直接喂给 create-prefab
- 03:24 迁移时智能体**明确识别了风险**并问你：「`RECIPE_DIR_NAME = '.dfan-mcp'`……改名 `.dsh-mcp/recipes`，兼容读旧目录（推荐）？」
- **你的回答（逐字）**：`「丢弃掉，给现在的recipes加规则，应该是可以复用的才保存」` → 即：**丢弃旧 recipe 存储，换成"只存可复用的"门禁**。这个决定是对的（旧那条写死了 5 个项目资源 uuid，本来就过不了新门禁）。
- **但落地只做了一半**：代码换了目录（`recipes.ts:49 RECIPE_DIR_NAME = '.dsh-mcp'`，`dfan` 零命中）、README 明说「旧目录不读」，**而那条 recipe 里的两条坑（`sizeMode` 顺序、`Layout` 避漂移）一条都没写进 `SKILL.md`**。3.5 小时后 04:23 重新发现 `sizeMode/TRIMMED`，又花掉好几步。

**诚实说明一处反例**：那条 recipe 的**代码**对后两次尝试本来就用不上——它写死了 5 个项目贴图 uuid，而 03:20/04:23 的要求是「不用当前项目的资源」；03:20 那次也确实读懂了它并正确拒绝复用。**但坑（事实）是可复用的**：`sizeMode` 顺序、`Layout` 避漂移、`EditBox` 双标签处理，与用不用项目资源无关，04:23 全部重新踩了一遍。

> **这是本次分析最值钱的一条**：知识库里最贵的部分不是"代码"，是**代码里隐含的事实**。**"丢弃代码资产"必须伴随"事实摘录进 skill"**，否则丢弃等于删库。

### R4｜内置资源与组件坑没落盘（≈10 步）
04:23 全程只用 `db://internal/default_ui/*`（7 张贴图），为了拿到可用 uuid 试了 `loadAny({uuid})`、`assetManager.bundles.get()`、`bundle.get(path)` 四轮；4 次 `read_image` 去看引擎自带的 png 长什么样。这些 uuid/路径事实**本可以一次落盘、永久复用**。

### R5｜`cocos_editor_state` 把「降级」报成了硬 Error（03:24 会话的导火索）
用户看到的报错（原文）：

```
Error: 工程：D:\Project\cocos\jihe_defence
编辑器：CocosCreator 3.8.6
选中：scene-2d [3d901b39-…]
能力：只读得动编辑器 —— Scenario scripts do not exist: dfan_mcp2
⚠ 部分信息没拿到：
- 场景信息读取失败：在编辑器里执行代码失败：Message does not exist: dfan_mcp2 - run-code
```

真相是**四项探针里三项都成功了**，只有场景一项失败。但 `cocos-tools.ts` 里 `ok: problems.length === 0` → 桥接侧（`dsh-bridge/index.js:159`）见 `ok:false` 就 reject，把整段人话文案当成 `Error:` 抛给用户。注释里写的意图恰好相反：「任何一块拿不到都**不阻断**整体」。→ 一个"自检工具"的降级被读成"插件坏了"，直接换来 59 分钟的排查会话。

**根因（子代理核实）**：`dfan_mcp2` 被写进了 `profiles/v2/editor/packages.json` 的 `disable-packages`（01:47:30），而 dsh_chat 当时**借用**它的沙箱（`Editor.Message.request('dfan_mcp2','run-code')`），于是整条场景侧能力静默失效。

### R6｜插件自身开发没有闭环（59 分钟里只有 ~10 分钟在真干活）
03:24 那次迁移：177 次调用里 `cocos_*` 工具调用 **0 次**（坏掉的那个工具是唯一观察者）；58 次 pwsh + 44 次 edit + 41 次 read。83% 墙钟在**等待**（一次 `ask_user_question` 阻塞 33.3 分钟）。
缺的能力：没有编辑器扩展启用/禁用状态的查询 API；**没有热重载**（原话：「真实编辑器里的那一跳我没法验」，最后只能让用户手动重启编辑器）；没有 zstd 会话日志读取器（3 次重写脚本、4 次运行、零结论）；自测脚本 41 条断言跑了 6 次、build 3 次、`npm install` 2 次。

---

## 3.5 关键观察：上一轮修的全是「工具层」，知识层一个字没动

00:10 那次复盘（+ 同一会话 turn 2 的「可以修复」）列了 10 条问题。**逐条核对仓库现状后**：

| # | 复盘结论 | 现状 |
|---|---|---|
| 1 | 失败回执吞掉了原因（三层丢字段） | ✅ 已修（`dsh-host.ts` 回执带 `error`，桥接回落读 `result.text`） |
| 2 | `cocos_execute_code` 的 `args` 不可用 | ✅ 已修（schema + 一路透传） |
| 3 | 两套等价工具面同时挂载 | ✅ 已修（方向：dsh_chat 吸收 dfan；但 `extensions/dfan_mcp2/` 目录仍在磁盘） |
| 4a | 失败不该登记撤销快照 | ✅ 已修（`engine.ts:317-325` 改成 `if (ok && …)`） |
| 4b | 15s 默认超时 × 8KB 单体脚本 | ❌ 超时仍是 15000，且没有任何防单体脚本的机制 |
| 5 | 补视觉闭环（截图） | ⚠️ 工具建成了，但实测拿不到画面（见 R2） |
| 6 | 别把构建与验证焊死（改一个属性不该重灌 8KB） | ❌ 未做（只多了 `args`，不阻止整树重灌） |
| 7 | 别在用户真实场景里做实验（8 轮探针节点） | ❌ 未做（skill 里零规则） |
| 8 | 别用 `setDesignResolutionSize` 动全局视图状态 | ❌ 未做（全仓 0 匹配） |
| 9 | 「Widget 单边对齐漂移」归因不干净 | ❌ 未验证、未记录 |
| 10 | 零进度可见性（65 步 0 次 `todo_write`） | ❌ 未做（skill 里零约定） |

**并且：那份复盘没有提出任何关于 skill / 知识文件 / 系统提示的建议**——它把 100% 的修法落在插件代码上。

**后果是可测量的**：`SKILL.md`（218 行，04:08 重写过）里的关键词实测命中数是

| 关键词 | 命中 | 关键词 | 命中 |
|---|---|---|---|
| `EditBox` | **0** | `create-prefab` | **0** |
| `内置资源` / `db://internal` | **0** | `setDesignResolutionSize` / `设备模拟` | **0** |
| `TRIMMED` | **0** | `todo` / `增量` | **0** |

也就是说：**工具层的 5 条修好了，所以 04:23 那次协作更顺（没有"编辑器返回失败"这种哑巴报错）；但知识层的 0 条没修，所以 04:23 把上一轮踩过的坑原样又踩了一遍。** 一次会话的"长"，60% 是这类**没被写下来的经验**，而不是工具不够。

### R7｜收尾的"沉淀"没有任何触发点（贯穿全部尝试）
`findRecipes` 在**任何一次会话里都没被调用过**；`saveRecipe` 只出现过 1 次，而且在 00:49 那次的**倒数第二步**（s61 才用 `describe_api(editor/helpers)` 猜出签名 → s62 落盘）。工具描述里明明写着「## 复用：别每次重新探索 —— 先找 recipe」，模型读了却没做。原因很朴素：**`.dsh-mcp` 从来不存在 → 第一次 `findRecipes()` 只会回一个空列表 → 这个机制在任何一次会话里都拿不到正反馈**。知识库的空启动（cold start）是它自己最大的敌人；而"存 recipe"被排到收尾，正好说明它在模型心里不是流程的一部分，而是**一份可选的作业**。

---

## 4. 通用功能：该提前做什么

> 插件自己定的口径是「IPC 协议要窄，需要新能力优先扩 `execute_code`，而不是加新方法」——下面的 A 类严格遵守它，只有「必须走独立通道」的才进 B 类。

### A. 沙箱助手（加在 `source/scene.ts` 的 `makeHelpers`，不改工具面）

| 助手 | 解决 | 证据 |
|---|---|---|
| `prefabFromNode(nodeOrPath, url, opts?)` | 封装 `cce.Prefab.createPrefabAssetFromNode`（**并对"目标 url 已存在"给明确策略**：覆盖 / 先删再建 / 另存），回 `{uuid,url,bytes}`，自动 `snapshot()`，并说清"原节点会被替换成实例" | 04:23 s42–s61（20 步）；00:49 用 `scene:create-prefab` 成功 3 次，两次行为不一致且失败无原因 |
| `internalAsset(pathOrName)` / `resolveAsset('default_ui/default_btn_normal')` | 按**路径**取 `db://internal/**` 的 spriteFrame，不再猜 uuid | 04:23 s3/s4/s20–s23/s28 |
| `measureLayout(root, canvasSize)` | 逐节点世界矩形 + **重叠检测** + 越界/零尺寸报告 | s39 手写、s74 靠肉眼才发现装饰线横穿卡片 |
| `setupEditBox(node, opts)` / `setupButton` / `setupToggle` | 把 `sizeMode=CUSTOM`、子标签、背景 Sprite 这些坑一次做对 | s40 交付里明写"EditBox 的 Sprite 默认 TRIMMED 把节点缩成 2×2" |
| `buildUI(spec)` | 声明式建树：改版变 diff，而不是重写 6 KB 代码 | 三次重写 6,278/6,516/6,739 字符 |
| `renderPreview(root, opts)` | **离屏**把 UI 子树画成 PNG（就是模型手搓的那张 Canvas2D 对照图，产品化）。**但先做 B5：先确认场景视图是不是被"设备模拟被打掉"搞成空白的**，别在错误前提下造替代品 | s62–s77（16 步） |
| `editNodes(spec)` / 增量改 | 只改指定节点的属性，不重灌整棵树 | 00:49 会话 6 次全树重建、117 KB 入参 |
| `saveScene()` / 脏状态提示 | 04:23 交付里不得不写「场景是未保存状态，按 Ctrl+S」 | s79 |

### B. 工具面（只加必须独立通道的）
1. **`cocos_capture_view` 在 `blankRatio ≥ 0.95` 时给出可执行退路**：直接回「改用 `renderPreview` / 用 `measureLayout` 做数值验收」，而不是一句"接近 1 说明基本是空图"。**这是零成本改动、收益最大的一处**。
2. **把"场景视图设备模拟"变成可探测、可自愈的事实**（这是 R2 的根因，比造渲染器便宜得多）：`cocos_capture_view`（或 `cocos_editor_state`）在拿到空白帧时，顺手回报 `cc.view.getVisibleSize()` / `getDesignResolutionSize()` / 场景视图 canvas 尺寸，并对照工程设计分辨率 750×1334 给出"疑似设备模拟被打掉"的判据 + 恢复入口。**当前它恒为 `visible = 750×559.35` vs 设计 750×1334，这个差异是可判定的。**
3. 若要真出图，建议独立成 `cocos_render_preview`（图片是二进制，塞不进 `execute_code` 的返回值上限——与作者当初给 `capture_view` 单独开通道的同一条理由）。
4. **`cocos_editor_state` 的 `ok` 语义修正**：只要核心探针成功就回 `ok: true`，把 problems 放进 `data.problems`；否则降级态永远被读成"工具坏了"。

### C. 知识落盘（详见 §5）
1. 把 §3 里的事实写进 `.agents/skills/cocos-editor-ops/SKILL.md`：预制件写回 API、`capture_view` 空图退路、EditBox/Toggle 的内置坑、内置资源按路径取法、**"别用 pwsh 硬啃编辑器安装目录"**（`.ccc` 是压缩的、中文文件还会踩 GBK/UTF-8 mojibake，实测 25/25 次 pwsh 都白打在那里）。
2. 把 `.dfan-mcp/recipes/build-login-ui-tree.js` **搬到 `.dsh-mcp/recipes/`** 并把写死的 5 个 uuid 参数化（门禁 `checkRecipeReusability` 会拒硬编码 uuid，这一点是对的——所以更需要 A 类的 `resolveAsset` 让 recipe 能不带 uuid 写）。
3. **入库**：`extensions/dsh_chat` 与 `.agents/skills` 现在共 **56 个文件未进 git**；recipe 目录也不在版本控制里 → 弄丢就真找不回。

### D. 触发与流程（比补内容更关键，且几乎零成本）
1. `cocos_editor_state` 的「下一步」提示里**加上 `findRecipes('ui')`**——那是模型每次会话唯一保证看得到的位置，现在那里只有 tree/describe_api/query-assets。
2. **种几条 recipe 进去**（把 `.dfan-mcp/recipes/build-login-ui-tree.js` 参数化后搬进 `.dsh-mcp/recipes/`）：`findRecipes()` 必须**第一次调用就非空**，否则这个机制永远拿不到正反馈（见 R7）。
3. 收尾固化：一段 ≥N 行、跑通、且被重跑过的 `execute_code`，回执里附一句"值得 `saveRecipe`"。
4. **把上一轮复盘里 4 条"模型侧纪律"写进 skill**（全都是 0 成本、0 代码的条款，现在一条都没落）：
   - **增量改，别全量重建**：改一个属性不要重灌整棵树（00:49 那次重灌 6 次、117 KB 入参）。
   - **别在用户的真实场景里做实验**：探针节点要建在临时宿主下并当场清理（那次塞了 8 轮 `__T1..4`/`__P`/`__IT`…）。
   - **绝对不要动全局视图状态**：`cc.view.setDesignResolutionSize` / 设备模拟属于"编辑器的东西"，动它会把场景视图和刚做好的产物一起打坏（R2 的根因）。
   - **丢弃任何代码资产之前，先把里面的事实搬进 skill**（R3 的教训）。
5. skill 的「验收清单」里加一条**回归任务**：「新场景 + 登录预制件 + 禁止工程资源」应在 ≤15 步内完成并产出 1 条 recipe——把它当成这套能力的冒烟测试。

---

## 5. 需不需要知识库？

**需要，但"知识库"这个词会把人带偏。** 本次的失败**不是"找不到已知资料"**，而是两类：

| 失败类型 | 例子 | 知识库能救吗 |
|---|---|---|
| **能力缺口** | 预制件写回、离屏预览、编辑器热重载 | ❌ 救不了，必须补代码 |
| **事实未落盘** | 预制件 API、capture 空图、EditBox 坑、内置资源 uuid | ✅ 落盘即可 |
| **生命周期事故** | recipe 因目录改名孤儿化 | ✅ 但靠**流程/兼容**，不是靠检索 |

而且**三个载体的骨架都已经存在**（这是这个插件做得好的地方）：

| 载体 | 现状 | 该装什么 | 判据（作者自己定的，我认同） |
|---|---|---|---|
| `.agents/skills/cocos-editor-ops/SKILL.md` | 218 行，**缺**上面那批事实 | 工程专有流程/坑点 | 需要人策展、能 review、能 diff |
| `.dsh-mcp/recipes/*.js` | 机制齐全（门禁 + `verifiedAt` + 新鲜度），**目录不存在** | 跑通了的**代码** | 代码过期会当场报错，不会悄悄给错结论 |
| `cocos_describe_api` | 已实现 | 引擎 API 长什么样 | 存了必然过期，运行时反射即可 |

**所以不建议再上一个向量库/RAG**，理由具体：
- 这里的问题从来不是"检索不到"，而是"没写下来"和"写下来被弄丢"。RAG 解决不了这两件事。
- 事实类知识的过期风险已经有更好的机制：`findRecipes` 的 `daysSinceVerified`（超 30 天先读再跑）+ 代码跑不通会当场报错。RAG 反而会**悄悄给出过期结论**——这正是 recipe 模块注释里点名的"过期的事实比没有事实更糟"。
- 真正需要的是**一次探测、全局复用的"环境事实缓存"**：这版编辑器里 prefab 门面在不在、场景视图合不合成、GPU readback 能不能用。它可以是一份 `docs/` 或 `.dsh-mcp/` 下的 JSON/Markdown，**跟着编辑器版本走**，而不是跟着语义检索走。

**一句话口径**：把知识库当「三张表」维护——**skill 放事实、recipe 放代码、探测结果放版本事实**；再加两条铁律：**改名要兼容读**、**写完要入库**。

---

## 6. 顺手记下的其他发现

1. **每条会话都在为一份和任务无关的 40 KB 注入付费**：`AGENTS.md` 68,322 B 被截断到 65,143 B 后注入，首步 input 28 K token。做一个"登录界面预制件"时，塔防数值/配表门禁那一大套基本是噪音。dsh_chat 的 README 自己也记了这条。
2. **`extensions/dsh_chat`（含本次结论的落点）与 `.agents/skills` 未入库**，56 个文件只存在于磁盘。
3. `README.md`「已知限制」漏了**场景视图可能整帧空白**这条——它现在是"每次都要重新发现一次"的事实。
4. 我这套分析脚本放在 `.tmp/`（已 gitignore），可复跑；若结论要沉淀，建议把 `dsh-calls.mjs`/`dsh-timeline.mjs` 移进 `extensions/dsh_chat/scripts/`。
5. **recipe 五件套是"沙箱助手"，不是工具**（`findRecipes`/`readRecipe`/`saveRecipe`/`runRecipe`/`deleteRecipe` 只活在 `execute_code` 里）。后果：从**工具调用流**上完全看不出"这次有没有存 recipe"——想让"沉淀率"变得可观测（甚至可考核），它需要一点一等公民的表面（至少在 `cocos_editor_state` 的下一步里出现）。
6. **03:20 那 41 秒是一次纯粹的沟通失败**：模型在 18 步里**四次**想到正确做法（"让用户启用 dfan_mcp2 然后重启编辑器，10 秒的事"），却因为**全程零文字输出**一句都没说；它还两次想到了正确退路（直接写 `.prefab` JSON 让编辑器导入）又自己放弃，最终 `turn/end` = `aborted/disposed`、零文件写入、零用户可见文字。**顺带死掉的还有一条真事实**：「`Graphics` 组件不会把绘制的形状序列化进 prefab」——它本来可以救下"零资源画图形"这条路。
7. **`cocos_describe_api` 被严重低估**：04:23 全程只用 6 次，而 00:49 那次 65 步里只用 2 次——尽管 skill 第一条铁律就是"不要猜 API"。A 会话里 `saveRecipe` 的签名一直靠猜，直到**倒数第二步**才用 `describe_api(editor/helpers)` 确认。
8. **`extensions/dfan_mcp2/` 目录仍在磁盘上**（"收掉重复工具面"目前只是"依赖清零 + 编辑器侧禁用"，不是物理删除）；`dsh_chat/README.md:61` 还有一处**悬空引用**（见"坑 33"，但全文没有 33 号条目）。

---

## 7. 怎么算改好了

| 判据 | 现在 | 目标 |
|---|---|---|
| 同一任务步数（新场景 + 登录预制件 + 禁止工程资源） | 79 步 / 6.1 min | **≤15 步** |
| `pwsh` 打向编辑器安装目录的次数 | 25/25 | **0** |
| 会话结束时产出的 recipe | 0 | **≥1**（且 `findRecipes` 下次真能查到） |
| `cocos_capture_view` 空图时模型的动作 | 自建渲染器 16 步 | **1 步退路**（`renderPreview` / `measureLayout`） |
| 插件侧验证 | — | `npm run build && node scripts/verify-cocos-engine.js` 增加 `prefabFromNode`/`measureLayout`/`internalAsset` 的断言 |

---

## 8. 已落地（2026-09-30，本轮改动回执）

| # | 改动 | 落点 | 验证 |
|---|---|---|---|
| 1 | **空白帧给可执行退路 + 回报视图状态** | `source/core/engine.ts`（`blankRatio ≥ 0.95` 时给三段退路）、`source/scene.ts` 新增 `readViewState()`（`view.visibleSize` / `designResolution` / `visibleMatchesDesign`） | `verify-cocos-engine.js` 新增哨兵断言，**45/45 通过**（原 41 + 新 4） |
| 2 | **`cocos_editor_state` 的 `ok` 语义修正**：降级 ≠ 失败（`gotAnything` + `data.problems` + `data.degraded`） | `source/cocos-tools.ts` | 同上，含「部分降级不报失败」的新断言 |
| 3 | **`findRecipes` 摆进「下一步」提示位**（模型唯一保证看得到的地方） | `source/cocos-tools.ts` | 同上 |
| 4 | **skill 补 3 条坑 + 6 条纪律 + 内置资源清单**（坑 3 预制件写回两条路与副作用 / 坑 4 EditBox 的 TRIMMED / 坑 5 空白截图先量视图状态；纪律：增量改·别在真实场景实验·别动全局视图状态·失败别静默·别硬啃编辑器安装目录·丢代码前先榨事实） | `.agents/skills/cocos-editor-ops/SKILL.md` | 关键词从 0 命中变为覆盖；`description` 同步 |
| 5 | **recipe 复活并参数化**：`.dsh-mcp/recipes/build-login-ui-tree.js`（uuid 全部走 `args`，注释里留住了 `sizeMode`/`TRIMMED`/`BOTTOM_TO_TOP`/幂等四条事实） | 工程根 `.dsh-mcp/recipes/` | `checkRecipeReusability` **0 problems**；`listRecipeRecords` 能列出（= `findRecipes()` 不再为空）；13/13 断言 |
| 6 | **能力基准（27 条用例 + 两套判据）** | `extensions/dsh_chat/benchmark/`（`cases.json` / `oracle.mjs` / `score.mjs` / `README.md`） | 拿 04:23 的历史会话跑通，得基线 **过程分 38/100**；磁盘判据在缺产物时正确判红 |

**还没做的（有意留着）**：`prefabFromNode` / `internalAsset` / `measureLayout` / `setupEditBox` / `buildUI(spec)` 这五个沙箱助手（工具层改动，属下一轮）；`extensions/dfan_mcp2/` 目录的物理删除；把 `extensions/dsh_chat`、`.agents/skills`、`.dsh-mcp` 纳入 git（现在分别是 56 个未跟踪文件）；`engine.ts:55` 的 15s 默认超时（上一轮复盘的第 4b 条）。

**扩展改动没有热重载** —— 以上 1~3 条要**重启一次 Cocos Creator** 才生效（场景脚本在引擎进程里）。
