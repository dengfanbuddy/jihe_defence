# dsh_chat —— 编辑器里的 DSH 对话框

在 Cocos Creator 编辑器里，Inspector 旁边开一个对话框跟 DSH 智能体聊天。它能读工程文件、读 skill、
连大模型，并且**直接操作你正开着的这个编辑器**（读场景、建删节点、查资源、改工程设置）。

## 它长什么样（一张图看完）

```
Cocos Creator 编辑器（Node 20.15.1 / Electron 31）
├─ 扩展 dsh_chat（本目录）
│   ├─ main 进程 ── fork ─────────────► DSH 子进程（系统 node v24，`dsh --profile cocos`）
│   │      ▲                                   │
│   │      │ ① ipc：原生工具调用                │ stdout：SDK 协议（换行分帧 JSON-RPC）
│   │      │    cocos_execute_code 等           │ stderr：插件日志（诊断尾巴，不进上下文）
│   │      │                                   ▼
│   │      └─ core/engine（vm 沙箱）/ 本扩展场景脚本 → 真编辑器与场景进程
│   └─ 面板（渲染进程，dockable）◄── ② Editor.Message 广播 + 轮询 get-events
└─ $DSH_HOME/profiles/cocos/  ← 由 dsh-profile/ 幂等同步而来
```

**两条通道，各司其职**：模型 ↔ 宿主走 SDK 协议（stdio），宿主 ↔ 编辑器走进程间 IPC
（`fork` 自带的那条 fd）。**全程不占端口、不走 HTTP、不经过 MCP**。

## 界面：抄 DSH，不嵌 DSH

面板的观感对齐 DSH 自己的 Web GUI，但**不是把那个 GUI 嵌进来**。两条路都评估过：

| | 嵌 `dsh web`（iframe） | 面板自绘 + 抄设计系统（**采用**） |
|---|---|---|
| 依赖 | 要跑 webserver + WS + 客户端模块加载（web profile 有 57 个插件）⇒ 等于再起一份 agent，会话/设置/工具全分家 | 无。仍是「一个 host + 一条 IPC」 |
| 宽度 | 它的 CSS **一条响应式媒体查询都没有**（只有 `prefers-reduced-motion`）⇒ 三栏应用塞进 Inspector 旁的窄面板必然挤 | 按 380~640px 调过 |
| 端口/HTTP | 必须有（还要处理 token 与 iframe 策略） | 仍然零端口 |
| 视觉 | 现成的 | `--dsw-*` token **直接从 DSH 抽**，一条不手抄 |

具体做法：

- **token 层**：`static/style/default/dsw-tokens.css` 由 `scripts/extract-dsw-tokens.js` 从已安装的
  `@deepseek-ai/dsh-client-ui-theme` 里抠出来（色板 → 语义别名、明暗两套、字号阶梯、elevation、
  滚动条、代码块配色），唯一改动是**选择器降域**到 `.dsh-root`。
- **组件层**：`static/style/default/index.css` 手写，只消费 token —— 换主题/改字号/DSH 换色板都只动 token。
- **渲染模型照抄 DSH**：用户气泡 / 助手 markdown（子集）/ **折叠的思考块** / **按工具名分类的工具卡片**
  （`source/panels/default/tool-card.ts`：终端、文件、diff、搜索、待办、问答、代码、网页 + 通用回退，
  四态与耗时，失败自动展开）/ 代码块带 banner 与复制 / 状态行。
- **我们在吃同一条事件流**（`SessionEventLikeEntry`：`type`/`seq`/`time`/`data`），所以它的对话区怎么渲染，
  我们就能怎么渲染 —— 抄的是渲染模型，不是像素。

## 工具面与能力的来源（执行能力已迁进本扩展）

模型在面板里能不能像用 MCP 那样操作编辑器，只取决于**它手里有几个工具**。

**2026-09 起，编辑器执行能力是「本扩展自带的」**：沙箱在 `source/core/engine.ts`（editor 上下文，
`vm.createContext` 隔离）、场景脚本在 `source/scene.ts`（scene 上下文，注册在 `package.json` 的
`contributions.scene`），recipe 在 `source/core/recipes.ts`，序列化上限在 `source/core/serialize.ts`。
原先借的 `dfan_mcp2` 已经不是依赖了 —— 那个扩展可以随时关掉/删掉，`cocos_*` 工具照样能用。

| 工具 / 能力 | 落点 | 说明 |
|---|---|---|
| `cocos_execute_code` | `core/engine.executeCode` | `context:'editor'` 走本扩展的 vm 沙箱；`context:'scene'` 转发本扩展的场景脚本。`args` 一路透传 |
| `cocos_describe_api` | `cocos-tools.describeEditorApi` + `core/engine.describeSceneApi` | 编辑器侧是**自带反射**（命名空间 / `helpers` / `module:xxx` / 点分路径）；scene 侧问场景脚本，类的属性名从 `__props__` 与实时实例上读 |
| `cocos_editor_state` | `cocos-tools.readEditorState` | 工程/版本/选中/场景 + **能力探活**（场景脚本在不在）+「下一步用哪个工具」 |
| `cocos_capture_view` | `core/engine.captureView` + 场景脚本的 `captureView` | 截**编辑器场景视图**当前一帧 → 落成 png/jpeg → 回路径。像素塞不进沙箱返回值（单字符串 4000 字），所以它必须是独立工具，见坑 33 |
| recipe 五件套（沙箱助手） | `core/recipes.ts` | 注入在两个上下文的沙箱里：`findRecipes` / `readRecipe` / `saveRecipe` / `runRecipe` / `deleteRecipe`（存 `<工程根>/.dsh-mcp/recipes/`）。**`saveRecipe` 有复用门禁**：不是跑通了就能存，见下 |
| 用法要点（原先在 MCP 的 `initialize.instructions` 里） | 四段工具 `description` | DSH 不消费 MCP 的 instructions（实测全包零匹配），所以「别猜 API、先找 recipe、gizmo 剪枝、返回值上限」**必须写进工具描述**，否则模型根本不知道它们存在 |
| MCP HTTP 服务 + 客户端配置写入 | ❌ 不移植 | 本扩展的立身之本就是**不占端口、不走 HTTP**（工具走 fork IPC） |
| resources / prompts（`cocos://…`） | ❌ 不移植 | DSH 只桥 tools；等价信息在 `cocos_editor_state` 里 |
| 面板活动日志 / 代码试验台 | ❌ 不移植 | 面板本身就是对话界面，「跑一段代码」在对话里说一句就行 |
| 沙箱设置（默认超时 / 序列化上限 / printEditorLog） | `core/engine.ts` 的常量 | 收成 `SANDBOX_DEFAULTS` + `SERIALIZE_OPTIONS` 两处，不再有设置面板 |

**三条口径**（都写在注释里，改之前先读）：

1. **scene 侧要有打开的场景**：`execute-scene-script` 需要场景进程里已加载本扩展脚本，
   没开场景时必须给「先打开一个场景」而不是内部错误（`SCENE_SCRIPT_HINT`）。
2. `target: 'helpers'` 这一档**回沙箱问** `helperNames()`，**不抄清单** —— 助手是沙箱注入的事实，
   抄一份的下场是「查到的函数在沙箱里根本不存在」。
3. **recipe 只存能复用的**：`description` / `returns` 必填、`params` 声明的键必须在代码里真的用到
   `args.<键>`、代码里不许有具体 uuid / 绝对路径 / `.tmp/`（要参数化）。一次性的探索直接 `return`
   出来就行，落盘只会让 `findRecipes` 多一条以后跑不通的噪声。

## 哪些「编辑器操作的通用边界」收进了插件（而不是留在 skill 里）

判据只有一条：**这件事能不能由代码判死**。

| 边界 | 谁该管 | 为什么 |
|---|---|---|
| 场景树里 97% 是编辑器 gizmo | **插件**（`eachNode`/`tree` 默认按 `HideInHierarchy` 剪枝，并在有子节点被藏时回 `editorHidden`） | 判据是引擎里的一个标志位，能算 —— 算法就不该让模型每次重建一遍 |
| 节点名含 `/` → `cc.find` 静默返回 null | **插件**（`nodeByPath` 贪心按段匹配） | 同上：这是解析算法，不是知识 |
| **`cc is not defined` = 漏给 `context`** | **插件**（`engine.executeCode`：按标识符推断 + 回执注明 `contextInferred`；真选错时错误里直接给改法） | 实测这一条让模型绕了 **10 步**（见坑 37/38）。错误信息里能写下的东西，就不该指望模型自己想明白 |
| 编辑器场景里取图片 `SpriteFrame` 的三条错路（`cc.resources.load` 报 `Can not parse this input`、`query-assets('…/spriteFrame')` 静默回空、裸 uuid 拿到 `Texture2D`） | **插件**（`loadFrame(ref)`：读 `.meta` 的 spriteFrame 子资源、缓存、失败时报「试过哪些候选、各拿到什么类型」） | 正解要绕两步（editor 查 uuid → scene `loadAny`），**绕法本身是机械的** —— 机械的步骤就该是一个函数 |
| 编辑态 `getBoundingBoxToWorld()` 给自相矛盾的值 | **插件**（`worldRect(node, {root})`：按 `position`+`anchor`+`contentSize` 自洽累加） | 同上的"机械算法"；顺带把「原点是谁」写进返回值，省掉一轮对账 |
| 空图帧（`blankRatio≈1`）的退路 | **插件**（回执里带 `view.*` + 分两种情况的可照做 hint，并明说**别再重试**） | 现象能量出来（`visibleMatchesDesign`），退路能写死 |
| 「跑通的代码要存 recipe」 | **插件提醒 + skill 纪律**（长代码 + 真改了场景 → 回执里提醒一次 `saveRecipe`） | 判据可算（代码长度 + `undoSnapshot`），但**"值不值得存"要人来判**，所以只提醒不代劳 |
| `EditBox`/`Sprite` 的 `sizeMode=TRIMMED` 撑大宿主节点 | **skill**（写法约定：`sizeMode` 必须先于 `spriteFrame`） | 它不是"环境会骗你"，而是"顺序写错"，帮不上忙也拦不住 |
| `cc.Button` 的 COLOR 过渡覆盖 Sprite 底色、`ScrollView` 把 content 推到 `-10` | **skill** | 同上：是"组件语义"，模型按契约写就对了 |
| `cc.Layout.HorizontalAlign` 在 3.8 不存在 | **skill**（并标明 `alignHorizontal` 的取值**未实测**，给 probe 写法） | 是引擎版本事实，不是算法；插件没有合理的拦截点 |
| 别动 `cc.view.setDesignResolutionSize`、别在真实场景塞探针、别硬啃编辑器安装目录 | **skill 纪律** | 纪律是"取舍"，不是"对错"，代码判不死 |
| 超时掐不断已在跑的异步代码 / 场景侧报错行号 +1 / 不能离线改 `.prefab` | **skill 的诚实边界** | 引擎与 vm 的固有限制，插件改不了，只能说明白 |

**口径**：上面「插件」那一列的共同点是 **判据可计算 + 正解是机械步骤**（算法、探测、错误翻译、提醒时机）。
留在 skill 的那一列是 **需要人策展的取舍与引擎版本事实**。两边的分界线就是
「这段文字能不能换成一个函数」—— 能换就换，换不了才写进 skill。

**怎么验的**（不用重启编辑器，也不碰正在跑的会话）：

```sh
cd extensions/dsh_chat && npm run build && node scripts/verify-cocos-engine.js
```

它用**假 `Editor` + 假 `cc`** 把整条链真跑一遍（58 条断言）：契约（`contributions.scene`）、
真 `dist/scene.js` 的 `runCode`/超时掐断/助手注入（含 `loadFrame` 的 `.meta` 解析与 `worldRect` 的几何）、
editor 沙箱的 args 与错误形状、`context` 漏给/选错的推断与报错、recipe 门禁
（写死 uuid / 参数没用上 / 缺 meta 都要被拒）与落盘回跑、长代码 + 改动生效后的 recipe 提醒、
scene 转发的快照与降级文案，以及 `cocos-tools` 四个 IPC 方法的回执。
插件那一侧另有 `node scripts/verify-bridge.js`（含控制通道的**中断**：两条取 Agent 的路 + 两个边界）。

## 目录：谁是真源

| 路径 | 角色 |
|---|---|
| `dsh-profile/` | **profile 的源**（可评审、进 Git）。装到 `$DSH_HOME/profiles/cocos/` 只是它的投影 |
| `dsh-profile/plugin/dsh-cocos-bridge/index.js` | DSH 侧的插件：经 IPC 注册 `cocos_execute_code` / `cocos_describe_api` / `cocos_editor_state` / `cocos_capture_view`。**纯 ESM JS，不编译**；四段 description 就是模型唯一的说明书 |
| `skills/` | **随插件发布的通用 skill**（引擎/编辑器行为 + 插件自身边界）。`source/dsh-host.ts` fork 时注入 `DSH_BUNDLED_SKILL_DIR=<这里>`，DSH 当 bundled 根扫（rank 600）→ **换个工程装上就有**。⚠ 同名是「整体覆盖」不是合并，工程里**别**再放一份同名的 —— 口径与 6 个根的全表见 `skills/README.md` |
| `skills/cocos-editor-ops/SKILL.md` | 那份 skill 本体：9 条坑 + 3 条铁律 + 6 条纪律 + 13 条 `<!-- fact: -->` 声明 |
| `scripts/verify-skill-facts.js` | **事实门禁**：每条坑必须声明怎么验；`script:` 锚点必须真跑通过；工程里不许有同名 skill（会遮蔽插件这份）。改 `SKILL.md` 后跑它（`npm run verify:skill`） |
| `i18n/zh.js` `i18n/en.js` | 编辑器菜单文案 —— `package.json` 的 `contributions.menu` 用 `i18n:menu.panel/dsh_chat` 寻址，**缺了 i18n 目录菜单组名会显示成原始 key** |
| `scripts/install-profile.js` | 幂等安装器（CJS）。编辑器每次加载扩展都会调它；也能手工 `node scripts/install-profile.js` |
| `scripts/verify-bridge.js` | 验证 bridge 插件：装的那份 == 源的那份、`apply()` 注册了 4 个工具、描述里那几条要点还在。**不开编辑器、不碰正在跑的会话** |
| `source/` | 扩展源码（主进程 + 面板），编译到 `dist/` |
| `source/cocos-tools.ts` | IPC 请求的**服务端**（四个方法：execute_code / describe_api / editor_state / capture_view）：参数校验、编辑器侧反射、把调用交给下面的引擎 |
| `source/core/engine.ts` | **执行引擎**：editor 上下文的 vm 沙箱、scene 上下文的转发、`capture_view`、场景脚本探活 |
| `source/core/sandbox.ts` | vm 沙箱执行器（超时两层、日志捕获、跨 realm 错误归一化） |
| `source/core/serialize.ts` | 返回值序列化上限（深度/数组/键/字符串）+ cc 对象压成摘要 |
| `source/core/recipes.ts` | recipe 存储与五件套助手 + **复用门禁**（`checkRecipeReusability`） |
| `source/core/scene-bridge.ts` | 主进程 → 场景进程的桥（`execute-scene-script` + 失败模式区分） |
| `source/scene.ts` | **场景脚本**（跑在引擎进程）：`ping` / `runCode` / `describeApi` + 全部场景助手（`eachNode`/`tree`/`nodeByPath`/`dump`/`snapshot`/`captureView`…）。构建后是 `dist/scene.js`，由 `package.json` 的 `contributions.scene` 注册 |
| `scripts/verify-cocos-engine.js` | 验证整条执行链（假 Editor + 假 cc，真跑 `dist/scene.js`）。**改沙箱/场景脚本/recipe 后必须跑** |
| `source/dsh-host.ts` | 托管子进程 + 接四条流（stdout/stderr/工具 IPC/控制 IPC）+ 维护转写与广播 + 历史回放与恢复 |
| `source/history.ts` | 历史会话：工程键（照抄 DSH 的 `projectKey`）、列会话、读日志（spawn 系统 node 跑下面那个脚本） |
| `source/sdk-client.ts` | SDK 协议客户端（3 个请求 / 4 个通知） |
| `source/images.ts` | **图片附件的唯一真源**：扩展名→MIME 白名单、20MB/20 张/200MB 三个上限（与 DSH 附件库同口径）、扫目录兜底、读文件成规范 base64、批次校验、面板侧的筛选/体积显示也用它（面板与主进程**共用这一份**，不许抄第二遍）。纯 fs + path，不开编辑器就能验 |
| `source/panels/default/index.ts` | 面板 UI：零依赖，纯 DOM（挂载、状态、轮询/广播、设置、外观、历史抽屉、图片粘贴/选图/碎片区） |
| `source/panels/default/markdown.ts` | markdown 子集渲染（纯 DOM，绝不用 `innerHTML`） |
| `source/panels/default/tool-card.ts` | 工具卡片：按工具名分派种类 + 从入参抽标题 |
| `static/style/default/dsw-tokens.css` | **生成物**：从 DSH 抽出来的 `--dsw-*` token（别手改，重跑脚本） |
| `static/style/default/index.css` | 手写组件样式层，只消费 token |
| `scripts/extract-dsw-tokens.js` | 抽 token（幂等，`--check` 可校验是否与已装 DSH 一致） |
| `scripts/preview-panel.js` | **不开编辑器看面板**：真面板代码 + 真 CSS + 样例转写 → 自包含 HTML（含 `__dshFakePaste` 粘贴模拟） |
| `scripts/session-log.js` | 会话日志读取器（`list` / `read`，输出一行 JSON）。**要用 node ≥ 22.15 跑**（zstd） |
| `scripts/verify-bridge.js` | 插件自检：装的那份 == 源的那份、注册了 4 个工具、描述要点还在、**控制通道能真发图** |
| `scripts/verify-panel.js` | 面板静态契约：`MSG` ↔ `package.json`、`SELECTORS` ↔ 模板、样式类 ↔ CSS |
| `scripts/verify-images.js` | 图片链路的主进程那半（扫描/读取/校验/筛选/路径映射），不开编辑器就能跑 |
| `scripts/verify-replay.js` | 拿**真日志**跑回放：形状容错（工具结果不会被新旧格式差异吃掉）、代数递增 |

## 用起来

1. **首次**：确认 node 与 dsh 在 PATH 上（面板设置里留空即可自动探测；找不到会在面板上红字说明）。
2. **加载扩展**：重启 Cocos Creator（或扩展管理器里刷新）。
3. **打开面板**：菜单 `面板 → dsh_chat → 打开 DSH 对话框`，把它拖到 Inspector 旁边停靠。
4. **首次启动要等几秒到几十秒**（加载整棵 DSH 插件树；热启动实测约 2.3 秒）。之后直接说话即可。
5. **重启不丢上下文**：agent 起来之后会自动接上本工程最近一条有内容的会话（并把它回放出来）。
   想从零开始点「新会话」；想看以前聊过什么点 **⟲**。
6. **发图片**：截图之后把光标放进输入框按 **Ctrl+V**；或者点输入框左边的 **🖼**
   从工程 `assets/` 里选一张（可搜索、有缩略图）。详见「图片」一节。
7. **它想歪了 / 你改主意了**：输入框旁边会出现 **停止本轮**（只在它跑的时候出现）——
   按下就中断当前这一轮，**会话和上下文都留着**，你可以接着说「不是这个意思，改成…」。
   右上角那个 **停止** 是另一件事：它停掉整个 agent 进程（要重启，重启后会自己接回上次的会话）。
   两个按钮的分工见「已知限制」第一条。

设置项（面板右上 ⚙）：

| 字段 | 说明 |
|---|---|
| `主题` / `正文字号` | 外观。主题三档：跟随系统 / 深色 / 浅色（标题栏那个 ◐ 按钮也能切）；字号 12~17px，默认 14 —— 与 DSH Web GUI 同口径 |
| `provider` / `model` / `reasoning` | 走哪条模型路由；默认与本机 `$DSH_HOME/settings.yaml` 的 `agent-default-model` 对齐 |
| `maxTokens` | 0 = 不传（用适配器默认） |
| `工作目录` | agent 的 cwd；留空 = 当前 Cocos 工程根 |
| `node 路径` / `dsh bin.js` | 留空 = 自动探测 |
| `自动启动` | 面板打开时自动起 agent |
| `显示 stderr` | 把子进程 stderr 当 note 显示（排查用） |

面板上还有 **修复 profile**：profile 被删/被改坏时一键重装，结果（含失败原因）直接显示在横幅上。

## 历史会话：看得见，也接得上

标题栏那个 **⟲** 打开历史抽屉，列出本工程在 `$DSH_HOME/sessions/` 里的会话（标题 = 首条用户消息、
时间、轮数、大小）。点一条 = 把它的日志**回放到对话区**（只读），横幅上出现「继续此会话」；
点了就真接上，之后的消息带着那段历史。

| 动作 | 背后发生了什么 |
|---|---|
| ⟲ 列历史 | 直接扫 `<DSH_HOME>/sessions/<工程键>/`，**agent 没在跑也能看**（读磁盘，不走 agent） |
| 点一条 | 引擎主进程 spawn 系统 node 跑 `scripts/session-log.js`：解 zstd → 投影成事件 → 走**和实时同一条**投影逻辑画进面板 |
| 继续此会话 | 控制帧 → 插件 `ctx.agents.resume({resumeSessionId})`：**DSH 自己的恢复机制**，模型带着上下文回来 |
| ↻ 重启 | stop → start；`start()` 结束时会**自动接上最近一条有内容的会话**（所以「停止→启动」不再清空上下文） |
| 新会话 | 释放接上来的 agent + 换新 sessionId（上一段历史仍在抽屉里） |

**为什么要往插件里加一条「控制通道」**：SDK 协议只有 `initialize` / `session/prompt` / `shutdown`
—— **没有「恢复某个会话」**，而 `session/prompt` 走的是 `agents.create`（用这个 id **新建**一个会话，
模型侧没有任何历史）。真正能恢复上下文的 `agents.resume` 只有**运行时内部**能调，而我们的插件
就跑在运行时里。于是：

```
面板「继续此会话」 → 扩展主进程 → fork IPC 控制帧 {kind:'ctl', method:'session/resume'}
                                  → 插件 ctx.agents.resume({resumeSessionId}) → AgentHandle
接上之后每一句话 → 控制帧 method:'session/prompt' → handle.agent.followup(createUserMessage(...))
```

事件不用另开一条路：SDK server 订阅的是 `ctx.on('session/event')`（运行时里的**所有**会话），
所以接上来的会话的流式事件照样经 `session.event` 回到面板。

> ⚠ 实测：`agents.resume` **不会**把历史事件重放出来（`.tmp/verify-resume.mjs` 里那条断言），
> 所以「面板自己回放一遍」不是多此一举 —— 不画就没有。

## 图片：粘贴剪贴板 / 从工程里选

面板支持把图**直接发给模型**（截图问「这里为什么不对」是最常用的一种提问）。三条入口，
落到同一条路上：

| 入口 | 怎么用 |
|---|---|
| **粘贴剪贴板** | 光标在面板里按 **Ctrl+V**（截图工具/微信/QQ 复制的图都行） |
| **选工程里的图** | 输入框左边的 **🖼** 打开选择器：列 `assets/` 下的图片，可搜索、可看缩略图，**点一张就加上** |
| **拖进来** | 把文件从资源管理器拖到面板上 |

选中的图变成输入框上方的**碎片**（缩略图 + 名字 + 尺寸 + 体积，点 ✕ 移除），发送时和文字一起走。

### 一条图要走完的五步（每一步都可能是静默失败）

```
粘贴/选图 → ① 归一化（面板）  → ② IPC（面板 → 主进程）→ ③ 校验（主进程）
          → ④ 内容块（SDK session/prompt 或控制帧）→ ⑤ 附件库（DSH 运行时）
```

1. **归一化（面板侧，`source/panels/default/index.ts`）**：DSH 附件库只收
   `png / jpeg / webp / gif` 四种，且**会拿字节验一遍**声明的 MIME。所以面板先
   「解码 → 按预算缩放 → 编码成白名单里的一种 → **规范 base64**」。
   预算照附件库自己的口径来：像素 2048×2048、编码 4MB（超了走 `PNG → webp → JPEG` 梯子）。
   **在面板里就压到位**的理由很实在：一张 4K 截图的 base64 是十几 MB，
   与其让它走一趟 IPC 再被附件库重压一遍，不如先压好。
2. **IPC**：面板 → 主进程走 `send-message`（面板只发 `{mimeType, data, name}` 三个字段，
   缩略图/尺寸是面板自己的事）。
3. **校验（`source/main.ts` → `source/images.ts` 的 `validateImageBatch`）**：面板是渲染进程，
   它说的内容不可信 —— 所以**再验一遍**：白名单、单张 20MB、一条消息 20 张、合计 200MB、
   base64 逐字规范。失败回一句人话（「第 2 张 25MB，超过单张上限」，而不是附件库那句英文）。
4. **内容块**：`{type:'text'}` + `{type:'image', data, mimeType}`。
   普通会话走 SDK 的 `session/prompt`，**接上来的历史会话走控制帧**（见下）。
5. **附件库**：base64 落成 `{type:'image', attachment}`（内容寻址的引用）。
   走 SDK 时这一步是**服务端**做的（`dsh-sdk-jsonrpc-server` 的 `durablePromptContent`）；
   走控制帧时是**插件**做的（`dsh-cocos-bridge` 的 `admitImages` → `ctx.get('attachments').saveImages`）。

### 「工程里的图片」是两套路

主路是**资源库**（`asset-db` 的 `query-assets`）：它是编辑器里用户真看得见的那份事实，
还顺带给出 `db://assets/...` 这个可读 URL。兜底是**扫 `assets/` 目录**：内置扩展的消息名/
参数随版本可能变，拿不到时至少要能选图 —— 两套结果按绝对路径去重（`mergeProjectImages`）。
`list-images` 的回执里带 `source: 'asset-db' | 'scan'`，选择器的说明行会写出来是哪条路。

**列出来的每一项都必须读得出来**，所以资源库那条路要过滤三样：只收 `db://assets/`
（`db://internal` 是引擎自带资源，映射不到工程目录）、URL 扩展名必须正好是图片后缀
（挡掉 `db://assets/a.png/spriteFrame` 这类子资源）、拼不出路径的跳过。

### 缩略图是面板自己画的

选择器里每张图都要一次「读文件 → 解码 → 画 128px」才出缩略图，所以它是**懒加载**的：
`IntersectionObserver` 只读看得见的那几张，同屏最多 3 路，读出来的存进面板内存缓存
（关掉再开不重读）。这样即使工程里有几百张图，也不会在打开选择器时把面板卡住。

### 转写里只记「元数据」

转写条目上带的是 `{name, mimeType, bytes, width, height}`，**没有像素**：

- 转写要走广播/轮询回面板（每 120ms 一批、每 800ms 一次增量），塞几 MB 的 base64 会把面板拖死；
- 回放历史日志时**根本拿不到原图** —— 日志里存的是附件引用（`attachmentId` 那一套），字节在附件库里。

所以历史消息里画的是「🖼 图名（尺寸 · 体积）」的碎片；**刚由本面板发出去**的那几张例外，
缩略图还在手边（`sentThumbs`），就顺手显示真图，让「我刚才贴的是哪张」一眼能确认。

### 怎么验的（都不开编辑器）

```sh
cd extensions/dsh_chat && npm run build
node scripts/verify-images.js                 # 主进程那半：扫描/读文件/校验/筛选/路径映射，70 条断言
node scripts/verify-panel.js                  # 面板那半的静态契约（消息名/元素 id/样式类）
node scripts/install-profile.js && node scripts/verify-bridge.js
#   ↑ 后者会**真喂控制帧**进插件（假 agents + 假 attachments），断言「接上来的会话发图」那条路：
#     base64 解码成字节、mediaType 透传、内容块是 [文本, {type:image, attachment}]、坏 base64 被拒
node scripts/preview-panel.js --serve         # 浏览器里真跑一遍面板（含粘贴与选择器）
```

预览器里有两件专门的工具（`scripts/preview-panel.js`）：

- **`window.__dshFakePaste(kind)`**：造一个带图的剪贴板事件丢给面板。
  `image` = 一张 3000×2000（验缩放）、`noise` = 2000×1500 真噪声（PNG 压不动 → 验 webp/JPEG 梯子）、
  `bmp` = 非白名单格式（验转码）、`text` = 纯文字（**必须原样进输入框**，不能被我们吃掉）。
- **查询开关**：`?click=%23btn-image` 自动开选择器、`?failimages=1` 资源库查询失败、`?readfail=1` 单张读不出来、
  `?scan=1` 走扫目录那条兜底路。

## 开发循环

```sh
# 改扩展 TS → 编译（本扩展自带 devDependencies：typescript + @types/node）
cd extensions/dsh_chat && npm install && npm run build

# 改沙箱 / 场景脚本 / recipe → 先 build，再跑引擎验证（假 Editor + 假 cc，真跑 dist/scene.js）
node scripts/verify-cocos-engine.js

# 改 dsh-profile/（profile 或插件）→ 同步到 $DSH_HOME（幂等）
node scripts/install-profile.js

# 改完 bridge 插件（加工具 / 改工具描述 / 改控制通道）→ 同步 + 验证
node scripts/install-profile.js && node scripts/verify-bridge.js
#   ⚠ 新增/改名工具后**必须重启 agent** 才会出现在模型手里（patchReload 不会重跑 apply()，见坑 23）

# 面板的静态契约（消息名 / 元素 id / 样式类，三处「写两遍」的地方）
node scripts/verify-panel.js

# 图片链路（主进程那半：扫目录 / 读文件 / 校验 / 筛选 / db:// 映射）——改 images.ts 后必须跑
node scripts/verify-images.js

# 回放真日志（读本工程最近的会话；只读，不启动 agent）——形状容错的哨兵
node scripts/verify-replay.js --limit 3

# 改面板样式/渲染 —— 不开编辑器就能看（真面板代码 + 真 CSS + 样例转写）
node scripts/preview-panel.js            # 生成 .tmp/panel-preview/index.html（自包含，双击就能看）
node scripts/preview-panel.js --serve    # 顺便起个静态服务并打印 URL
#   预览器开关：?theme=light|dark  ?font=12..17  ?idle=1（非运行态）
#              ?noShow=1（故意不调 show 钩子）  ?hide=毫秒（模拟 hide 误触发）
#              ?view=history|resumed（历史横幅两态）  ?click=%23btn-history（自动点开抽屉）
#              图片：?click=%23btn-image（自动开选择器） ?failimages=1 ?readfail=1 ?scan=1
#   浏览器控制台里可以 `__dshFakePaste('image'|'noise'|'bmp'|'text')` 模拟粘贴（见「图片」一节）
#   页面顶部有自检条：getEvents/getState 计数必须持续增长 —— 这是在断言「面板自己在轮询」；
#   还带一行**量出来的高度**（root/body/hist/bar/图/选择器，溢出会写 OVERFLOW）——
#   没有浏览器工具时，用 `chrome --headless=new --dump-dom` 抓下来读这行就够了。

# DSH 升级后重抽设计 token（幂等；--check 只比对，不一致退出码 1）
node scripts/extract-dsw-tokens.js
node scripts/extract-dsw-tokens.js --check
```

`preview-panel.js` 为什么值得存在：编辑器**没有热重载**（改 `dist/` 必须重启），而且面板里的报错
只能靠人去控制台捞。这个脚本把真面板代码装进假环境（`Editor.Panel.define` 原样收配置、
`Message.request` 回样例转写、`$` 按 `SELECTORS` 手工解析一遍），于是气泡/markdown/工具卡片/状态行
全都会真画出来，JS 报错也直接落在页面上。

改 profile 的**配置/依赖**（`cordis.patch.yml` / `package.json`）会被 `patchReload: live` 热重载；
但**改插件代码不会重跑 `apply()`** —— 新增的工具要等 agent 重启才出现（见坑 23）。改扩展代码要重启编辑器。

## 踩过的坑（都在这份代码里修掉了，别再踩回去）

1. **`execute_code` 的 vm 上下文不跨调用**：`globalThis` 在每个沙箱调用之间是新的，
   「起服务、下一次调用再读它」这种测试写法不成立。但 **`require` 的缓存是共享的** ——
   同一个模块实例跨调用存活（我们正是靠这一点在编辑器里跑真扩展代码做验收）。
2. **面板样式必须降域到 `.dsh-root`**：面板的 `style` 会被注入进**编辑器页面**，裸选择器会改到
   编辑器自己的界面。旧版面板样式里那句 `html,body{background:#252526}` 就是这种写法（编辑器本来就是
   深色，所以一直没人发现）—— 现在已经删掉、改成 token 层统一下域；面板高度改由 TS 在挂载时**量一次**
   （`ensureLayout`，量出来的尺寸会经 `panel-probe` 回传，见第 16 条）。
3. **面板里不要用 `document.getElementById`**：它**返回 null**（模板不在模块所处的那个文档里），
   而 `Editor.Panel.define` 的 `$` 选择器（`ctx.$.xxx`）是编辑器在面板子树里解析的、可靠。
   第一版用 `getElementById` 拿状态点/横幅 → 一进面板 `refreshState` 就抛
   `Cannot set properties of null (setting 'textContent')`，整块 UI 其实是死的。
   **口径：面板里所有元素引用都进 `$` 表，取不到只 warn 不抛。**
4. **`Editor.Panel.openBeside(beside, name)` 对已经打开的面板返回 `false`** 且什么都不做 ——
   想「停靠到 Inspector 旁边」必须先 `close()`（见 `main.ts` 的 `dockPanel`，菜单里也有一项）。
   日常打开用 `openPanel`：已开就 `focus`，没开就 `openBeside('inspector')`，失败才退回浮动窗口。
5. **`session.event` 的信封**：载荷在 `event.data` 里，不在 `event` 上
   （`SessionEvent = { type, seq, time, data }`）。第一版直接读 `event.name`，结果工具名变
   `unknown`、助手文本一个字都上不了屏。
6. **沙箱回执套了一层**：`{ ok, context, durationMs, result }`，沙箱返回值在 `.result`。
   第一版当 `{hasScene}` 读，界面永远显示「场景：未打开」（而场景开着、546 个节点）。
   （这条最初是在转发别的扩展时踩的，迁进本扩展后信封形状没变 —— `unwrapSandboxResult` 仍在用。）
7. **`turn/end.reason` 是对象**：`{ kind: 'completed' | 'aborted' | ... }`，不是字符串；`String()` 会打出 `[object Object]`。
8. **SDK profile 的 stdout 只属于协议帧**：插件里任何 `console.log` 都会插进协议流。一律 `console.warn`。
9. **TypeScript 会把 `import()` 降级成 `require()`**（`module: CommonJS` 下）：所以安装器必须是 CJS
   `.js`，否则运行时拿 `file:///...` 去 require，报 `Cannot find module 'file:///...'`，
   而且被 try/catch 吞成一行 warning，症状是「profile 一直没同步，但没人知道」。
10. **`fork` 必须显式给 `execPath`**：默认会用编辑器的 `process.execPath`（`CocosCreator.exe`），
    而 dsh 的 ESM 入口要真正的 node。另外 `windowsHide` 在本地 `@types/node` 的 `ForkOptions` 里还没声明（断言保留）。
11. **`Editor.Panel.define` 的 `ready` 是顶层钩子**，放进 `methods` 里永远不会被调到。
    菜单路径要用 `i18n:menu.panel/<名字>` 这个内置惯用法。
12. **本机 MCP 工具有 120s 上限**（`toolCallTimeoutMs: 120000`）：想跑「启动 + 一轮对话」的整链测试，
    得把轮询窗口压在这个预算内，否则被掐断（而沙箱脚本其实还在跑）。
13. **别用 PowerShell 改这些中文文件**：PS 5.1 的 `Get-Content -Raw` 默认按 ANSI 解码，
    `-replace ... | Set-Content` 会把整份文档变成乱码（本 README 就中过一次）。
14. **扩展没有热重载 API**：改了 `dist/` 下任何东西（含面板 JS）都要**重启编辑器**或重装扩展才好使；
    `Editor.Package` 只有 `checkReload/scan/startup` 这类接口，没有 reload。
15. **窄面板里的表格要 `table-layout: fixed`**：`width:100%` 在 `auto` 布局下只是**最小宽度**，
    「表头 + 长 token」的 min-content 会把表撑出面板，而 `overflow-x:hidden` 只会把它裁掉
    （现象是表格右边直接被切）。预览器的 380px 档就是用来盯这个的。
16. **面板的轮询必须自己在 `mount` 里起，不能只挂在 `listeners.show` 上**（**这是「不流式」的根因**）：
    症状是「上一轮的回复要等下一次发送才整段冒出来」——`send()` 里那次 `pollOnce` 成了唯一的刷新点。
    原因：对**编辑器启动时恢复的停靠面板**，`show` 不保证在 `ready` 之后触发（WeakMap 里还没 state，
    `uiByPanel.get(this)?.resume()` 静默 no-op）。编辑器里另一个面板扩展的写法，就是在 Vue 的 `mounted()` 里
    自己 `startPolling()`，`show/hide` 只当优化 —— 这个写法是对的。两条加固：① `hide` 到达时先量一次
    面板是否**真的不可见**（`getClientRects()`，误判方向偏向「继续轮询」）；② `ready` 包 try/catch，
    挂载抛错会连带丢掉 state 登记，那就什么都刷新不了。
    **验证**：主进程侧 `get-state` 里带了 `panelPoll.count`（`get-events` 的调用次数）——
    「面板到底在不在轮询」从此是一条可查的事实；预览器 `?noShow=1` 是这条的回归用例
    （故意不调 `show`，页面自检条上的 `getEvents` 仍必须持续增长）。
17. **`Editor.Package.disable/enable('dsh_chat')` 不能用来热重载扩展**（实测）：两个调用都返回成功，
    但扩展的 `main.js` 是 Node `require` 缓存的，拿到的是**同一个旧模块实例**
    （判断依据：新版才有的 `panelPoll` 字段没出现，且 `agent.entryCount` 仍是 47 ⇒ 连 `unload()`
    都没真跑）。改 `dist/` 之后**只能重启编辑器**。
18. **面板里的报错要能被外部读到**：以前面板抛错只有编辑器控制台一行行刷，用户没法转述。
    现在面板把自检（元素是否解析到、布局量出来的高度、`ownsDocument`、`resumed`/`paused`…）
    经 `panel-probe` 消息回传主进程，`get-state` 的 `panel` 字段里能读到最近 8 条 ——
    排查时先看这个，别去猜。
19. **`markdown.ts` / `tool-card.ts` 用相对 `require` 引**：面板 dist 是 CommonJS（`module: CommonJS`），
    同级文件能正常解析（`dist/constants.js` 一直是这么引的）；别为了「干净」改成 ESM `import`，
    面板加载器不做打包。
20. **DSH 不消费 MCP 的 `initialize.instructions`**（实测「全包零匹配」）：所以那些**只写在
    instructions 里**的用法要点（**别猜 API、先找 recipe、gizmo 剪枝、返回值上限、`snapshot()`**）
    必须落进工具的 `description`，否则模型看不见 —— 它不会去读别人的 README。
    这也是 `cocos_execute_code` 的描述有 1870 字的原因：那不是话痨，是**唯一一处模型一定会看的说明书**。
21. **`args` 在转发链上被丢过一次**（已修）：旧实现只把 `{code, context, timeoutMs, snapshot}` 往下传，
    于是 `cocos_execute_code({args})` 里的 `args` 被静默丢掉 —— 沙箱里 `args` 是 `{}`，
    报错却是 `Cannot read properties of undefined (reading 'x')`，看着像模型自己写错了代码。
    现在两侧都透传（桥接 schema → `cocos-tools.runExecuteCode` → `engine.executeCode` → 沙箱全局 `args`）。
    **加参数时记得问一句：这一层往下传了吗？** 参数外置的另一种正路仍是 recipe：
    `saveRecipe(名字, 代码, {params})` + `runRecipe(名字, args)`。
22. **在编辑器里 `require` 编译产物做验证时，先清 `require.cache`**：活着的扩展**已经加载过**那个模块，
    `require` 会原样返回**旧实例**（实测 `wasCached: true`，症状是 `t.describeApi is not a function`）。
    正确写法：`const p = require.resolve(dist路径); delete require.cache[p]; require(p)`。
23. **`patchReload: live` 不会重跑 bridge 的 `apply()`**（实测）：改了插件代码并 `install-profile`
    同步之后，正在跑的 agent 的 `stderrTail` 里仍然只有**一条**旧的注册日志
    （`已注册原生工具：cocos_execute_code / cocos_editor_state`）—— 也就是说新工具不会热插进正在运行的会话。
    **新增/改名工具后必须重启 agent**（面板上「停止」再自动启动，或重开面板）；改 description 同理。
    ⚠ 所以别在用户正说话时重启：那会打断正在进行的那一轮。
24. **「停止」之后必须还有路可走**（用户报的 bug）：原来那个按钮只有「停止」一种语义，
    停掉之后**面板里再没有任何入口能起来**（唯一的路是重开面板/重启编辑器，而 `autoStart`
    只在「从没起过」时才触发）。现在：一个按钮两种语义（`stopped`/`error` → 「启动」），
    外加一个 ↻「重启」（stop → start）。判断依据是 `snapshot.status`，不是按钮自己的文案。
25. **`tool/result` 有**两种**形状，只认一种会静默丢掉所有工具结果**：同一个工程、同一天的两个
    会话日志形状就不一样（DSH 升过版），区别在 `data.message.content`：

    | 来源 | 形状 | 内容在哪 |
    |---|---|---|
    | 实时事件 / 老日志（头里 `version: 0`） | `[{type:'tool-result', toolCallId, content:[块…], isError}]` | **里层** `content[0].content` |
    | 新日志（`version: 4`） | `[{type:'text', text}]` | **就是** `message.content` |

    症状是「工具卡片 `done: true` 但结果一个字都没有」（不报错、不抛异常，看着像工具没输出）。
    口径：`dsh-host.ts` 的 `toolResultOf()` 一次认两种（`isError` 也同理，新形状挂在外层
    `message.isError`）。**`scripts/verify-replay.js` 就是这条的哨兵** —— 它拿真日志跑回放，
    断言「有结果的工具卡片数 > 0」。
26. **SDK 协议没有「恢复会话」**：`dsh-sdk-protocol` 一共三个请求
    （`initialize` / `session/prompt` / `shutdown`），`session/prompt` 走的是 `agents.create`
    —— 拿一个 id **新建**会话，**模型侧没有任何历史上下文**（老代码 `start()` 每次随机抽 uuid，
    所以「一重启之前聊的全没了」）。真正恢复上下文的是 `agents.resume({resumeSessionId})`
    （`dsh --profile tui --resume <id>` 用的就是它），而它**只能在运行时内部调** ——
    这就是要给插件加「控制通道」的原因（见「历史会话」一节）。
27. **`agents.resume` 不会重放历史事件**（`.tmp/verify-resume.mjs` 实测：resume 后 4 秒内
    收到 0 条 `session.event`）。所以「面板自己把日志回放一遍」是必需的，不是重复劳动。
    反过来推：**回放的内容不会被运行时的老事件覆盖**，两边不会打架。
28. **清空转写必须有一个独立记号**：面板按 `rev > since` 拉增量，「某条被删掉了」这件事
    在这个协议里表达不出来（老条目一旦从主进程数组里消失，面板永远收不到"它没了"）。
    所以主进程加了 `generation`（每次清空 +1），面板对不上就**整块重画**。
    有了它，「换会话」「回放历史」「新会话」三条路都只走同一个 `resetUi()`，不会各写一遍。
29. **事件要按 sessionId 过滤**：接上历史会话之后，运行时里可能同时有「老的 SDK 会话」和
    「接上来的会话」，不过滤的话两段对话会在面板里串成一段。现在只认当前活动会话的事件；
    **代价**：子 agent（subagent）的会话事件不再混进主转写（它另有 `subagent.started/finished`
    两条 note）—— 这是有意的取舍，过滤掉比串台好。
30. **工程键本身以 `--` 开头**（`--D-Project-cocos-jihe_defence--`，DSH 的 `projectKey()` 规定的）：
    脚本参数解析里那句常见的「下一个 token 以 `--` 开头就当没给值」会把整个工程键吞掉 ——
    症状是 `session-log.js` 报「必须给 --root 与 --project」，而命令行看着完全正常。
    判定只能按**白名单**（`FLAGS`）来，不能按前缀。（传给子进程时也一律用 argv 数组，不拼字符串。）
31. **编辑器自带的 Node 没有 zstd**：会话日志是 zstd 拼接帧，`node:zlib` 的 zstd API 要
    **Node ≥ 22.15**，而 Cocos 的 Electron 31 是 Node 20.15 —— 主进程里**解不开**。
    所以读日志这件事外包给系统 node（`scripts/session-log.js`）：主进程只负责找文件、决定读哪个。
    后果也要说清楚：**没有 node ≥ 22.15 就列不出历史**（面板给的是这条人话，不是内部错误）。
32. **多帧 zstd 不能指望 `zstdDecompressSync` 一次解完**：它只吃**一个**完整帧
    （多帧拼接时解到第一帧结束就返回，**不报错**）—— 直接解整个文件只会得到 162 字节的会话头，
    看着像"日志是空的"。必须像 DSH 那样先按帧头结构扫出边界（`scanZstdFrames`，本仓库
    `scripts/session-log.js` 里是移植版），再逐帧解。`verify-replay.js` 会拿真日志对账帧数。
33. **`refreshState` 会「没事就把横幅收起来」，于是用户动作产生的提示活不过一次轮询**：
    `tick()` 在**有新条目时**（跑动时 300ms 一跳）和每 5 跳都会 `refreshState`，里面那句
    `else if (status !== 'starting') setBanner(state, null)` 会把「贴图失败 / 发送失败 / 已经在列表里了」
    这类提示当场抹掉 —— 更糟的是 `send()` 结尾自己就 `refreshState()` 一次，等于**刚写完就清**。
    症状很迷惑：日志里看得到错误，用户眼前什么都没发生。
    口径：**动作类提示一律带 `holdMs`**（`setBanner(..., BANNER_HOLD.ERROR | INFO)`，见 `setBanner` 的注释），
    `refreshState` 那句收起动作前先问 `state.bannerUntil`；状态类提示（profile 同步失败、agent 出错）
    不用带 —— 它们本来就会在每轮状态里被重新写出来。
34. **浏览器 `canvas.toDataURL('image/webp')` 编码不支持时会静默回落成 PNG**：拿到的
    `data:image/png;base64,…` 会被当成 webp 声明出去，而附件库**拿字节验类型**，于是报一个
    很难懂的错。口径：用之前先 `dataUrl.startsWith('data:image/webp')` 验一下（见 `encodeWebp`）。
    同一条也解释了为什么面板要「先归一化」：**声明的 MIME 必须与字节一致**，这是附件库的硬要求。
35. **`preview-panel.js` 里那段假 Editor 是字符串模板**：里面**不能出现反引号与 `${`**
    （会当场截断模板/被求值，报的却是「Unexpected identifier」这类看不出所以然的错）。
    写注释时用「」代替反引号。
36. **「AI 思考到一半不能中断」是 SDK 的表面限制，不是运行时的**（用户报的问题）：
    `dsh-sdk-protocol` 只有 `initialize` / `session/prompt` / `shutdown` 三个方法，没有任何取消语义，
    而 `session/prompt` 的回执是**入队回执**（`prompt()` 在 `followup()` 之后立刻 return，不等这一轮跑完）——
    于是就"只能等它自己结束"。但运行时自己的 `Agent.cancel(cause, {keepInbox})` 一直都在
    （`dsh-agent` 的 `runtime-types.d.ts`），只有**跑在运行时里的插件**能调。
    实现要点三条：① 取 Agent 有**两条路** —— 面板普通会话是 SDK 服务端 `agents.create` 建的
    （用 `ctx.agents.get(sessionId)` 找），「继续此会话」是插件 `agents.resume` 建的（自己持有 handle）；
    恰好是同一个注册表里的同一个对象（`dsh-sdk-jsonrpc-server` 的 `assertLiveAgent` 就是这么比的）；
    ② **没在跑不算错**（回 `{cancelled:false}`）—— 按钮与「这一轮刚好自己结束」天然有竞态；
    ③ **不要拿主进程缓存的 `running` 当闸门**（它来自 `session.status` 通知，面板刚重开时是陈旧的），
    一律问插件、由它回 `cancelled`。
37. **参数在转发链上被「善意地兜默认值」= 把事实吃掉**（同 21 的另一种形态）：
    bridge 的 `cocos_execute_code` 原来写 `context: args.context === 'scene' ? 'scene' : 'editor'`，
    于是「模型漏写 `context`」这个**事实**在插件这一层就被抹平了，编辑器侧只看到一次"正常的 editor 调用",
    报出 `ReferenceError: cc is not defined` —— 实测让模型绕了 10 步（详见 `engine.executeCode` 的注释）。
    现在**原样透传**（`context: args.context`），由**唯一一处**（`engine.executeCode`）负责
    「没给就按代码推断 + 在回执里注明 `contextInferred`」。
    口径：**兜默认值只能在"知道自己在兜"的那一层做，而且必须说出来。**
38. **`snapshot: true` 被冤枉过一次**（记在 skill 的坑 6 里，已更正）：它只是「跑完再登记一次撤销快照」，
    与「代码跑在哪个上下文」无关（`verify-cocos-engine.js` 里 `context:'scene' + snapshot:true` 一直是绿的）。
    当时误判成"带上它就等于让代码跑在没 `cc` 的环境里"，是因为那两次对照调用**不只差这一个参数** ——
    「换一个变量做对照」的前提是**只换那一个变量**。教训写进了 skill：**错的事实比没有事实更贵**
    （它会让下一个人按错的方向排查）。

## 已知限制

- **两条更新路，轮询是主路**：面板每 800ms（**跑动时 300ms**）拉一次 `get-events` 增量；
  主进程也往面板广播（`dsh_chat:event`，120ms 一批）做加速 —— 但**不依赖它**：
  `Editor.Message.__protected__.addBroadcastListener` 拿不到时（是否拿到会写进 `panel-probe` 的
  `resumed.broadcast`），轮询这条路照样能让流式文本逐段显示。实测模型输出约 200 字/250ms。
- **两种「停」，别混**：
  - **停止本轮**（输入框旁的按钮，只在跑动时出现）= 中断**当前这一轮**，走的是控制通道
    `session/cancel` → 运行时 `Agent.cancel({kind:'user'})`。会话、上下文、子 agent 全留着，
    下一句接着说即可（转写里会多一条 `本轮结束：aborted` 的 note 与「已请求中断」的提示）。
  - **停止**（右上角）= 停掉**整个 agent 进程**（要重启；好在那之后会自动接上最近一条有内容的会话，
    见下一条）。
  - 为什么需要两个：SDK 协议只有 `initialize` / `session/prompt` / `shutdown`，
    **没有「取消这一轮」**，而且 `session/prompt` 的回执只是「入队成功」（不等这一轮跑完）——
    所以「AI 想歪了要改口」这件事在加这条通道之前，唯一的办法是杀掉整个进程。
    **SDK 没有 ≠ 运行时没有**：`Agent.cancel()` 一直在，只是只有跑在运行时里的插件能调（见坑 36）。
- **转写保留 600 条**（`MAX_ENTRIES`）：回放一条几千事件的大会话时，面板留下的是**尾部 600 条**
  （最老的那些会被挤掉）——这是刻意的，面板是 DOM 渲染，不设上限会卡。
- **自动接上会话的两条前提**：本工程的会话日志要在 `<DSH_HOME>/sessions/<工程键>/` 里，
  并且有 **Node ≥ 22.15**（解 zstd，见坑 31）。两条都不满足时 `start()` 退回「新会话」并把原因写进转写。
  ⚠ 推论：**同一个工程同时开两个编辑器**会都想接上同一条会话（两个写入方），别这么干。
- **子 agent 的会话事件不进主转写**（见坑 29）：只有 `subagent.started/finished` 两条 note。
- **执行能力是自带的，但 scene 侧要有打开的场景**：`cocos_execute_code({context:'scene'})`、
  `cocos_capture_view`、`cocos_describe_api({context:'scene'})` 都靠场景进程里加载的本扩展脚本
  （`dist/scene.js`，由 `contributions.scene` 注册）。没开场景时它们会回一句「先打开一个场景」
  并把 `cocos_editor_state` 的能力行标成「只读得动编辑器」，而不是崩掉。
  editor 上下文（`context:'editor'`）不受影响，随时可用。
- **曾经的 `dfan_mcp2` 依赖已解除**：沙箱、场景脚本、recipe 全在 `source/core/` 与 `source/scene.ts`。
  那个扩展可以关掉/删掉；`scripts/verify-cocos-engine.js` 里有一条断言专门盯着「工具回执里不许再提 dfan」。
- **recipe 存 `.dsh-mcp/`**（旧目录 `.dfan-mcp/` 不读）：`saveRecipe` 有复用门禁，
  「跑通了」不等于「值得存」—— 见「工具面与能力的来源」一节。
- **面板还没做**：token 用量统计、历史会话的**搜索**与删除、跨工程会话列表
  （现在只列当前工程）；历史回放是只读的（要接着聊得点「继续此会话」）。
- **图片**（详见「图片」一节）：
  - **模型得支持视觉**：面板只负责把图送进附件库，能不能看懂取决于 `provider/model`
    （当前默认 `deepseek-v4-flash-vision-exp` 是视觉档；换成纯文本模型时图会白送）。
  - **转写里没有像素**：历史消息只画「图名 + 尺寸 + 体积」的碎片，缩略图只在**发送前**的输入区里显示
    （刚发出去那几条例外，见那节的说明）；关掉面板图片就丢了（**草稿只存文字**，
    localStorage 5MB 配额撑不住一张图，而撑爆的表现是**连文字草稿一起静默失效**）。
  - **单张 20MB / 一条消息 20 张 / 合计 200MB**（与 DSH 附件库同口径，写在 `source/images.ts`）：
    超了是**拒收**不是压缩，面板会先说清楚哪一张超了。
  - **`读剪贴板` 按钮可能拿不到权限**：`navigator.clipboard.read()` 在部分环境被拒，
    那时给的是「用 Ctrl+V」的提示 —— **Ctrl+V 这条路不依赖任何权限**，永远可用。
  - **选择器的缩略图要现读**：不给 `assets/` 建缓存，所以第一次打开选择器会读若干张图
    （懒加载 + 同屏 3 路 + 面板内存缓存，滚动时才继续读）。
- **markdown 是子集**：标题/列表/引用/分隔线/表格/围栏代码块 + 行内 code/粗体/斜体/删除/链接。
  不做嵌套列表、脚注、内联 HTML；**不做语法高亮**（DSH 的 shiki 配色 token 已经抽进 token 层，
  以后要上高亮直接按那套上色）。
- **工具卡片是按工具名分派的启发式**：`pwsh`/`read`/`edit`/`grep`/`todo`/`ask_user_question`/`cocos_*`
  这些常见名字有专门卡片，认不出的走通用卡片（显示工具名 + 原始入参），不会猜错结构。
- **`AGENTS.md` 会在每次会话注入**：本工程的 `AGENTS.md` 有 66KB，第一笔 token 开销就在这。
