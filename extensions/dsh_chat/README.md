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
还有**第三条**：插件主动发起的**交互帧**（人和模型之间那一问，见「交互」一节）——
模型提问 / 授权请求 / 计划评审，同样走 fork IPC。
以及搭在同一条控制帧上的**服务帧**（见「输入触发器」一节）：斜杠命令与 `@路径` 候选
原生产方都在宿主里，SDK 协议表达不了，所以由插件按 agent 转给面板。

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
- **它有的、我们也补上了的**：交互块（提问 / 授权 / 计划评审）、历史会话（含全文搜索 / 导出 / 删除）、
  斜杠命令与 `@` 引用补全、**会话用量（token 与上下文占用）**。
  刻意**不**抄的有一处：多会话并排的侧边栏 —— 面板是挂在编辑器旁边的一块窄地方，
  会话之间的切换交给「历史」抽屉。

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
| `cocos_capture_view` | `source/capture.ts`（主进程 Electron）+ `core/engine.captureView`（取景链 `runFitChain`）+ 场景脚本的 `viewMetrics` / `fitView` / `captureView` | 截**编辑器那块画布**当前一帧（或**指定的某一个节点**） → 落成 png/jpeg → 回路径。默认会**先取景再截**（`fit`：用户缩放过之后屏幕上那一帧未必是全景），截完还原视角，账本在回执的 `framing` 里。`view` 说明要的是**编辑器场景**还是**跑着的游戏**（编辑器内预览，两者用**不同的相机**），回执 `mode` 说清实际截到哪一种；**运行态下不取景、不按节点裁图**（那时编辑器相机不是渲染用的那台）。像素塞不进沙箱返回值（单字符串 4000 字），所以它必须是独立工具，见坑 33 |
| `cocos_logs` | `source/logs.ts`（`readLogs`） | 读**工程里的日志文件**（路径 + 行号 + 原文）。第二处"独立开通道"的理由：控制台里的字是**别的进程**打的，代码拿不到。默认扫一张**通用候选目录表**（`temp/logs` / `logs` / `local/logs` / `temp/asset-db/log` / `local` / `temp`），**全都扫**并逐个报 ✓/✗；支持 `list` / `tail` / `grep` / `regex` / `caseSensitive` / `since` / `dir` / `files`，单文件只尾读 2MB（回执里写「已尾读」）；唯一的写盘口是 `clear`，**必须带 `confirm:'clear'`**（少了就拒绝，且不动任何文件），清空 = 截断成 0 字节 |
| `cocos_click_node` | `source/input.ts`（`clickAt`）+ 场景脚本的 `viewMetrics`（投影）与 `pick`（命中探测） | 在**节点中心**（编辑态，按编辑器相机投影）或**一个坐标**（`space:"view"` 页面 CSS 像素 / `"uv"` 0~1 比例）上**真点一下** —— `webContents.sendInputEvent`，走 Chromium 自己的输入管线。回执里带**真发出去的那几条事件**、`probe`（点之前 `pick` 的判词）、`focused`（网页内键盘焦点）、`window`（**窗口焦点** —— Electron 明说 `sendInputEvent` 需要窗口有焦点，没焦点时回执会直说「可能没被送达」）。**运行态给 `node` 会被拒**（那一刻的投影不成立），只能给坐标。⚠ 真机实测（2026-11）：事件**到得了那一页、到不了引擎** —— 见坑 64 |
| `cocos_send_keys` | `source/input.ts`（`sendKeys`） | 真发键盘：`key` 走 `keyDown`/`keyUp`（Electron 加速键名），`text` 逐字发 `char`（真往输入框打字，≤200 字）。**不抢网页内焦点**（只如实报 `focused`），窗口焦点同 `click_node` |
| `cocos_runtime` | `source/preview.ts`（只读模式探针）+ 场景脚本的 `readSceneMode` | 看**运行预览**（编辑器内 game view）的**状态** —— ⛔ **只剩只读的 `state`**：`play` / `stop` / `pause` / `resume` / `step` 五个开关**2026-10-08 撤掉**（见坑 69 / 坑 70）。`state` 把两条独立来源摆出来：编辑器消息 `query-scene-mode`（认不出就 `unknown` + 原值）+ 场景进程的 `cce.PreviewPlay._state`（`previewState` / `paused` / `frames` —— **运行态的真判据**，facade 那两条实测判不出）。撤掉的理由：那五个动作是"从编辑器内部换掉那块画布的渲染相机"，与两次「场景面板画面停住 / 黑掉」同一条时间线；而且在本工程里编辑器内预览**进不了游戏**（卡在首场景 `Loading` 的 `loadBundle('scripts')`，`0%`）。要看画面请**人在编辑器工具栏上按播放键**。**没有 `timeScale`**：引擎里没有全局倍率（`Scheduler.setTimeScale` 不缩放组件 `update`） |
| **每个回执结尾的 `refs`** | `core/serialize.ts`（`collectRefs` / `formatRefs`）+ `cocos-tools.ts`（`withRefs` 包每个方法） | 把结果里出现过的**全形 uuid / `db://` 路径**去重后排进文案结尾（结构化版本在 `data.refs`）。省掉"下一步要用刚才那个 uuid → 重新查一遍 / 凭记忆编一个"这一轮。只抽不会认错的两类：**压缩型 uuid 刻意不抽**（任意 22 字符的单词都会命中，抽出来是噪声），节点路径也不抽（`Canvas/x/y` 与普通文本无法区分）。抽不到就**不加空壳字段、不改文案**；它自己抛错也不让调用失败 |
| recipe 五件套（沙箱助手） | `core/recipes.ts` | 注入在两个上下文的沙箱里：`findRecipes` / `readRecipe` / `saveRecipe` / `runRecipe` / `deleteRecipe`（存 `<工程根>/.dsh-mcp/recipes/`）。**`saveRecipe` 有复用门禁**：不是跑通了就能存，见下 |
| 用法要点（原先在 MCP 的 `initialize.instructions` 里） | 八段工具 `description` | DSH 不消费 MCP 的 instructions（实测全包零匹配），所以「别猜 API、先找 recipe、gizmo 剪枝、返回值上限、运行态为什么不能按节点点」**必须写进工具描述**，否则模型根本不知道它们存在 |
| **界面交互三件**（点按 / 按键 / 运行态开关） | `source/input.ts` + `source/preview.ts` + `source/cocos-tools.ts` 的三个方法 | 「改完 UI 点一下有没有反应」以前只能请人点。三件合起来才是闭环：截图看得见、点得动、**还能把画面冻住再截图**（跑着的游戏每帧都在变，冻住之后每一条判据都可复现）。边界写在工具描述里：运行态不成立的是**节点投影**（不是"算不准"）、`probe` 只证明坐标对不证明送达、窗口焦点是 `sendInputEvent` 的前提。⚠ **2026-11 真机验收查明**：合成点击/按键**到不了引擎**（引擎在编辑器构建里不注册 DOM 监听，见坑 64）—— 所以"点一下 → 看游戏逻辑有没有反应"这条闭环**现在还不成立**，换路在做 |
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
| **截图里有个东西，节点树里却没有**（实测烧了 16 轮：枚举子树 → 按颜色做直方图 → 反算坐标 → grep 预制件，结论是那是编辑器移动 gizmo 的 XY 手柄） | **插件**（`pick(x, y, {space})` → `verdict` / `hits` / `invisible` / `editorHits`） | 症结不是算不出，而是**手工枚举回空时无法区分「真没有」和「我枚举漏了」**，所以只能再枚举一遍。剪枝+bucket+判词都是算法，"空列表可不可信"这件事只能由代码来担保 |
| 「这个框放不放得下这行字 / 会不会被裁」 | **插件**（`labelFit(node, override)`：实测出的行进给与内容高公式 + 有 DOM 就真量宽度；回执里带 `clippedText` = **看不见的那几个字**） | 原先只能"改真 Label（或建探针卡）+ 截图"试；而**反事实**（"框改成 210 呢"）在没有 helper 时只能靠动真场景。公式是量出来的常数，机械算法 |
| 「我到底改了什么」（手工 dump 字段 + 人肉比对必漏） | **插件**（`snapshotTree` / `diffTree`：键按**节点路径**而非 uuid、字段白名单、只回真正变了的；`suspectLeaks` 点名像探针的新增节点） | 判据可算；且**"节点路径 vs uuid"这个选择是有对错的**（存盘会换 uuid），不该每次让模型赌 |
| 「这张图能不能用 `Sprite.color` 染色」「某张图存不存在」 | **插件**（editor 侧 `probe(ref)`：走 Electron `nativeImage` 读真像素，回中心/四角/透明比例/`tint` 判词/`engineBuiltin`） | 图像事实可算可量；而 Node 没有内置 PNG 解码器、场景进程取像素不稳 —— 机械但易错的路正是插件该封的 |
| 空图帧（`blankRatio≈1`）的退路 | **插件**（回执里带 `view.*` + 分两种情况的可照做 hint，并明说**别再重试**；截图正路是主进程 Electron：读**合成后的画面**，**纯只读** —— 一次 `capturePage()`，不排重绘、空图也不重试，见 `source/capture.ts` 与坑 69） | 现象能量出来（`visibleMatchesDesign`），退路能写死 |
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

它用**假 `Editor` + 假 `cc` + 假 `electron`** 把整条链真跑一遍（**215 条断言**）：契约（`contributions.scene`）、
真 `dist/scene.js` 的 `runCode`/超时掐断/助手注入（含 `loadFrame` 的 `.meta` 解析与 `worldRect` 的几何、
`pick` 的三桶与 `editor-overlay` 判词、`labelFit` 对两处**历史真 bug** 的复现与修复、
`snapshotTree`/`diffTree` 的路径键与探针泄漏点名 —— 顺带钉住「**哈希不含时间戳**」，
见坑 68 的同类：一个会随时间变的指纹当不了指纹）、
editor 沙箱的 args 与错误形状、`context` 漏给/选错的推断与报错、recipe 门禁
（写死 uuid / 参数没用上 / 缺 meta 都要被拒）与落盘回跑、长代码 + 改动生效后的 recipe 提醒、
scene 转发的快照与降级文案、`capture_view` 的 **Electron 通道**（真跑 `viewMetrics` 的节点投影换算、
裁切/padding/夹取、**抓图前一律先排一次重绘** + 空图时再逼一次、抓不到 webContents 时退回老路），
**取景链**（`fit`：假相机是**真·正交模型**，所以「三级取景逐级降级」「量出来的覆盖判据」
「手工摆相机的算式」「视角还原的两条通道与还原失败的如实回执」都真跑），
**日志与 `refs`**（真写日志文件再读回来、clear 要确认且零副作用、尾读、uuid/`db://` 去重），
以及**界面交互三件**（假 webContents 把每次 `sendInputEvent` 的入参原样记下来逐字比对：
节点中心投影、`uv` 折算、双击/右键/修饰键归一、**运行态给 `node` 被拒且一个事件都不发**、
窗口没焦点时提前台并如实记、按键三态与字数上限），
**运行态只剩只读的口径**（假 `PreviewPlay` 仍按需演"消息通了 / 回 ok 但一动不动 / 直接抛错"三种脾气，
断言的是**这五个动作一个都进不去**：`ok:false` + **零副作用**（不发消息、一次直调都没有）+ 拒的文案
点名"为什么撤"；另外 `state` 照旧两条来源都摆出来、用户自己开了预览时照样如实报 `running:true`、
拿不到 `_state` 时回退且 `note` 明说不可信），
还有 `cocos-tools` 八个 IPC 方法的回执（抓图那条钉的是**一次 `invalidate()` 都不调**、
连旧参数 `forceRepaint:true` 也不产生任何副作用）。
插件那一侧另有 `node scripts/verify-bridge.js`（含控制通道的**中断**：两条取 Agent 的路 + 两个边界）。

## 交互：模型提问 / 授权请求 / 计划评审（**2026-12 新增**）

**症状（旧版三条，一个根因）**：模型 `ask_user_question` 反问你 → 工具报 `NO_PROVIDER`；
需要授权的操作 → 一律被拒（你连"它问过我"都看不到）；计划模式进得去、**出不来**。

**根因**：DSH 的 `user-questions/request` 与 `approval/request` 都是 **cordis waterfall** ——
谁来回答取决于**有没有人挂监听**，而 DSH 自带的应答者只有**浏览器客户端那一半**
（`dsh-client-ui-user-questions` / `dsh-client-ui-approval`，长在 `dsh-web-app` 里）。
本 profile 挂的是 `dsh-sdk-app`，那两个包一个都不在 ⇒ 兜底分别是
`noAnswerer`（报错）与 `"unavailable"`（fail closed）。

**做法**：在 `dsh-cocos-bridge` 里挂应答者，把请求经**已有的 fork IPC** 转给面板，人按下按钮再把
结果还回去。于是多出**第三条通道**（前两条是工具帧 `req`/`res` 与控制帧 `ctl`/`ctl-res`）：

```
运行时 waterfall ──► 插件 ctx.on('…/request') ──► process.send({kind:'ask', phase:'open', …})
                                                       │
   面板（人点按钮）──► 扩展主进程 ──► {kind:'ctl', method:'interaction/answer'} ──┘
                                    └─► 插件 settle → {kind:'ask', phase:'settled'} → 面板收卡片
```

| 交互 | 面板画成什么 | 面板能给的三个结果 |
|---|---|---|
| `kind: 'question'` | 「模型在等你回答」：问题 + 选项（可多选）+ 自定义输入 | 选/写 → `{answers}`；✕ → 抛 `UserQuestionError/ASK_CANCELLED` |
| `intent.kind: 'plan-review'` | 「计划评审」：额外把 `detail`（**就是那份计划 markdown**）渲染出来，「批准」那一项按 `intent.approve` **按名字**标绿 | 同上（`plan-mode` 靠 `ASK_CANCELLED` 认出「用户要插话」） |
| `kind: 'approval'` | 「需要你批准」：工具名 + 理由 + 「允许一次 / 拒绝」 | `allowed-once` / `rejected`；✕ → `cancelled` |

**四条口径**（都写在 `dsh-cocos-bridge/index.js` 的注释里，改之前先读）：

1. **面板不在就当场放行**，不是干等：扩展主进程看「面板最近有没有在轮询」（`get-events` 计数，
   60s 窗口），没有就立刻回 `delegate` ⇒ 行为与没有这套东西时**完全一致**（提问报错、授权失败关闭）。
   没有这一关，面板关着时模型会一直卡在那一问上。
2. **插件自己不设超时**：请求带的 `signal`（这一轮被取消 / 工具调用超时）到点就撤下问题并抛取消 ——
   与浏览器客户端一致。自己再定一个超时只会制造「面板还开着但问题自己消失了」。
3. **不 import 那两个包**：与「不 import 附件库」同一条口径 —— 静态 import 一旦解析失败，
   **整个插件**（含八个 `cocos_*` 工具）都不会加载。取消的错误形状手写成
   `{name:'UserQuestionError', code:'ASK_CANCELLED'}` 即可（`ask()` 是按名字+code 认的）。
4. **载荷只过 JSON 能表达的东西**：`Agent` 对象与 `AbortSignal` 跨不了 IPC，所以只投影
   `agentId` / `sessionId` 字符串。面板侧还会**再截断一遍**长文本（计划可以几万字）。

**面板侧的两条实现口径**：① 交互块**只在签名变化时重建**（`interactionSignature`）—— 否则
每 800ms 一次的状态刷新会把你正在敲的自定义回答抹掉；② 提交后先记 `interactionSent`
再发（不禁用按钮连点两下会发两次），失败要把记号退掉。

**怎么验**（都不开编辑器）：

```sh
cd extensions/dsh_chat && npm run build
node scripts/verify-bridge.js     # 用假 ctx.on + 真 waterfall 派发跑满 8 组：回答/空答案/关掉/允许/拒绝/取消/委派/没有 IPC
node scripts/verify-panel.js      # 消息名、元素 id、样式类三处契约（新增交互块那批）
node scripts/preview-panel.js --serve   # 眼睛看：?ask=approval | ?ask=question | ?ask=plan
```

⚠ `verify-bridge` 里那条「`sendAskFrame` 的 `kind` 必须最后写」的断言是有来历的：
业务字段里也有个 `kind`（`'question'`/`'approval'`），先展开它就会把路由标签盖掉，
编辑器那侧按 `kind === 'ask'` 分流 ⇒ **整条路静默失效**（卡片永不出现、模型一直等）。

**落地要重启什么**：改插件要 `node scripts/install-profile.js` **且重启 agent**
（`patchReload: live` 不会重跑 `apply()`，见坑 23）；改扩展代码要**重启编辑器**（坑 14）。

## 输入触发器：斜杠命令（`/`）· `@` 路径引用 · 会话标题（**2026-12 新增**）

**症状（三条，一个根因）**：输入框里打 `/compact` 会被当成**普通消息**发给模型（模型只会一脸
茫然地回你一段话）；打 `@assets/scr` 没有任何补全；标题栏永远是「DSH · cocos」——
哪怕会话日志里明明记着标题。

**根因**：DSH 把「人能直接用的东西」做成了**宿主里的两个注册表**，而它们的**消费方原本只有浏览器那一半**
（`dsh-client-ui-commands` / `dsh-client-ui-reference`，都长在 `dsh-web-app` 里）：

| 能力 | 生产方（**base 里就有**） | 宿主服务 | SDK 协议能表达吗 |
|---|---|---|---|
| 斜杠命令 | `/compact` `/plan` `/goal` `/feedback` 各插件自己注册 | `ctx.commands` | ❌ 协议只有 `initialize` / `session/prompt` / `shutdown` |
| `@路径` 候选 | `dsh-file-reference-local` | `ctx.fileReferences` | ❌ 同上 |
| 会话标题 | `dsh-session-title`（回退）+ `session-title-llm`（模型） | 会话日志里的 `session/title` 事件 | ✅ **能** —— 它就是一条会话事件 |

**做法**（与「交互」一节同一个套路：SDK 没有的，就由**跑在运行时里的插件**转出来）：

```
面板 输入 `/` 或 `@`  ──► 主进程 ──► ctl commands/list · commands/run · fileref/list
                                          │
   插件 ctx.commands.list(agent) / execute(agent, line, [], signal)
        ctx.fileReferences.list(agent, query, signal)   ← 都是**按 agent** 查的
```

**四条口径**：

1. **`/` 开头的整行不走模型**。这不是优化，是语义：`ctx.commands` 的语法是「第 0 字节必须是斜杠」，
   而**分派权在注册表手里**（`execute()` 回 `undefined` = 语法不合法或名字不认识）。
   所以面板只把整行递给 `commands/run`，自己一个字符都不解析。`known:false`（名字不认识）
   与 `kind:'error'`（命令跑了但失败）是**两件事**，文案不一样。
2. **命令的结果画在转写里**（主进程写一条 note），不画在临时浮层里：命令在会话日志中留下
   `command/run` + `command/done` 两条**仅写日志**的事件（不进模型历史），所以它天然属于会话 ——
   刷新 / 换会话 / 回放之后那条 note 还在。回放走的是 `handleSessionEvent` 里那条 `command/done`
   分支（**只在回放时画**，实时那条由控制回执负责，两处都画就会看到两遍，与 `user/message` 同一个纪律）。
3. **`@` 语法是逐字移植 + 对账，不是「照意思重写」**。面板跑在渲染进程里、零依赖，不能
   import node_modules，所以 `source/panels/default/mention.ts` 是
   `@deepseek-ai/dsh-file-reference/grammar` 的移植；`verify-panel.js` 里有一条**对账**：
   拿同一批输入（含邮箱里的 `@`、`@"..."`、目录不闭合引号、控制字符）同时跑两份、逐字符比对。
   漂移的症状是「插进去的路径不是模型收到的那条」，从界面上看不出来。
4. **不做浮层**。`/` 菜单与 `@` 候选共用输入区上方那一块（`#popup`），与历史抽屉/图片选择器
   同一摆法 —— 窄面板里浮层要自己算位置，而输入框会长高、对话区会滚动，结果是菜单飘到别处。

**会话标题**（第三条）：`session-title` 是 base 里就开着的，所以 `session/title` 事件**一直都有**
（只是 `session-title-llm` 被 sdk-app 关掉了，标题只有「首条用户消息头几个词」那种回退）。
现在 profile 把它重新打开（`disabled: false`），标题就变成**模型生成的**、且会「先粗后细」跳一次
（回退同步就有，LLM 那条晚一两秒覆盖它 —— 这是设计如此）。三处消费：标题栏、
`session-log.js` 的历史列表标题、历史回放的 `HistoryView.title`。

**怎么验**（都不开编辑器）：

```sh
cd extensions/dsh_chat && npm run build
node scripts/verify-bridge.js    # 服务通道那一组：列命令/执行/未知命令/错误结果/@候选收敛/服务缺失说人话/ping 能力位
node scripts/verify-panel.js     # 契约 + **@ 语法对账**（我们那份 vs DSH 装的那份，逐字符比）
node scripts/preview-panel.js --serve
#   眼睛看：?type=/compact 看命令表，?type=@assets/scripts/game/battle 看路径候选，
#          ?title=0 看没有标题时退回品牌名，?nocommands=1 / ?norefs=1 看两个服务不可用时的降级
```

**profile 层新增了什么**（`dsh-profile/cordis.patch.yml`）：

| 行 | 为什么 |
|---|---|
| `session-title-llm: disabled: false` | sdk-app 把它关了（它的 UI 是别人家的客户端）⚠ **必须显式写 `false`**：patch 里没写的键**不会被清掉**（`applyEntryPatches` 只逐键覆盖它自己带的键），只写 id 是没用的 |
| `file-reference-local` | `@` 候选的本地提供方。**只挂这一个** —— 那个 seam 包（`@deepseek-ai/dsh-file-reference`）的默认导出**自己就是一个注册 `fileReferences` 服务的 `Service` 子类**，两个都挂会撞名，而且是 **apply 阶段的硬失败 ⇒ 整棵树起不来**（面板上只看到「agent 启动失败」）。`dsh-web-app` 的 bundle 同样只挂提供方。顺带它会按 agent 装一句系统提示词（`FILE_REFERENCE_PROMPT`，前提是该 agent 有 `read`）：「`@` 开头的是用户显式引用的工作区路径」 |

验证 profile **真的挂起来了**（不只是配置合成对了）：

```sh
node scripts/verify-profile-rows.js    # 真起一次 dsh --profile cocos + 一个探针插件，约 20 秒
```

**这个脚本抓到过两个只在启动时才现形的错**（本地静态检查都看不见）：

1. 上面那条「seam 与提供方撞名」——**配置能合成、行也在，但树起不来**；
2. **cordis 的服务只能用 `ctx.inject` 拿，`ctx.get(name)` 恒为 `undefined`** ——
   它不报错，只回 undefined，于是每一处「现用现取」都被说成「这个 profile 没挂那个服务」。
   插件里原来有三处这么写的（`attachments` / 新增的 `commands` / `fileReferences`），
   其中 `attachments` 那处是**老 bug**：「继续此会话之后再贴图」在真运行时一直失败，
   而本地测试没抓到 —— 因为 `verify-bridge` 喂的是**假 ctx**，假的 `get` 什么都给。
   现在假 ctx 的 `get` 一律返回 undefined（与真运行时一致），谁改回 `ctx.get` 谁就红。

**落地要重启什么**：profile 与插件都改了 ⇒ `node scripts/install-profile.js` + **重启 agent**
（`patchReload: live` 只盯 patch 配置，不重跑 `apply()`，见坑 23）+ **重启编辑器**（面板代码变了，坑 14）。

## 目录：谁是真源

| 路径 | 角色 |
|---|---|
| `dsh-profile/` | **profile 的源**（可评审、进 Git）。装到 `$DSH_HOME/profiles/cocos/` 只是它的投影 |
| `dsh-profile/package.json` | profile 的**清单**：`dsh.profile.bundles`（层叠顺序）+ `dependencies`。**两处必须一致** —— bundle 名字靠 profile 自己的 `node_modules` 解析，声明了却没装 = 那一行整体加载不起来，而 profile 看起来是装好的。`install-profile.js` 会体检这件事（缺了给一条能直接粘的命令） |
| `dsh-profile/cordis.patch.yml` | profile 层：persona、编辑器工具桥、**会话标题 LLM（重新启用）**、**`@` 引用的提供方**。合成结果用 `dsh --profile cocos --dump-config` 离线看，**真挂上没有**用 `scripts/verify-profile-rows.js` 看 |
| `dsh-profile/plugin/dsh-cocos-bridge/index.js` | DSH 侧的插件：经 IPC 注册 `cocos_execute_code` / `cocos_describe_api` / `cocos_editor_state` / `cocos_capture_view` / `cocos_logs` / `cocos_click_node` / `cocos_send_keys` / `cocos_runtime`；另有三条**给面板用的**通道（控制帧 / 交互帧 / 服务帧）。**纯 ESM JS，不编译**；八段 description 就是模型唯一的说明书 |
| `skills/` | **随插件发布的通用 skill**（引擎/编辑器行为 + 插件自身边界）。`source/dsh-host.ts` fork 时注入 `DSH_BUNDLED_SKILL_DIR=<这里>`，DSH 当 bundled 根扫（rank 600）→ **换个工程装上就有**。⚠ 同名是「整体覆盖」不是合并，工程里**别**再放一份同名的 —— 口径与 6 个根的全表见 `skills/README.md` |
| `skills/cocos-editor-ops/SKILL.md` | 那份 skill 本体：13 条坑 + 4 条铁律 + 6 条纪律 + 24 条 `<!-- fact: -->` 声明（15 条 `script:` 锚点 / 9 条 `manual`） |
| `scripts/verify-skill-facts.js` | **事实门禁**：每条坑必须声明怎么验；`script:` 锚点必须真跑通过；工程里不许有同名 skill（会遮蔽插件这份）。改 `SKILL.md` 后跑它（`npm run verify:skill`） |
| `i18n/zh.js` `i18n/en.js` | 编辑器菜单文案 —— `package.json` 的 `contributions.menu` 用 `i18n:menu.panel/dsh_chat` 寻址，**缺了 i18n 目录菜单组名会显示成原始 key** |
| `scripts/install-profile.js` | 幂等安装器（CJS）。编辑器每次加载扩展都会调它；也能手工 `node scripts/install-profile.js` |
| `scripts/verify-bridge.js` | 验证 bridge 插件：装的那份 == 源的那份、`apply()` 注册了 8 个工具、描述里那几条要点还在、**控制通道能真发图**、**交互通道能真应答两个 waterfall**（假 ctx.on + 真派发，8 组）。**不开编辑器、不碰正在跑的会话** |
| `source/` | 扩展源码（主进程 + 面板），编译到 `dist/` |
| `source/cocos-tools.ts` | IPC 请求的**服务端**（八个方法：execute_code / describe_api / editor_state / capture_view / read_logs / click_node / send_keys / runtime），并给每个方法的回执统一补 `refs`（`withRefs`） |
| `source/input.ts` | **真输入**（主进程 Electron）：`clickAt` / `sendKeys` → `webContents.sendInputEvent`，页面收到的是**真事件**（走 Chromium 输入管线，不是"悄悄调一下回调"）。坐标口径（页面 CSS 像素，与节点矩形同一空间）与**窗口焦点的前提**都写在文件头 —— 回执里 `window` 那一格就是"这一下到底送没送进去"的判据 |
| `source/preview.ts` | **运行预览的只读探针**（2026-10-08 砍到只剩这一半）：`querySceneMode()` 问一句 `query-scene-mode`。文件头记着**为什么把开关整条撤掉**（两次画布事故的时间线 + 本工程里编辑器内预览跑不进游戏）与三条诚实口径：不猜模式（认不出就 `unknown` + 原值）、失败不吞（原文照搬）、**没有 `timeScale`**（引擎里没有全局倍率，给了名字就是"看着像能用"）。⚠ 原来那两条消息（`editor-preview-set-play` / `editor-preview-call-method`）与 `sendPreviewMessage` **已删** —— 谁把它们加回来，`verify-skill-facts.js` 的 `interaction-tools-wired` 当场红 |
| `source/core/engine.ts` | **执行引擎**：editor 上下文的 vm 沙箱、scene 上下文的转发、`capture_view`（Electron 优先、老路兜底）、场景脚本探活 |
| `source/capture.ts` | **截图的 Electron 通道**（主进程）：定位场景视图那个 `webContents`（按 URL）→ `capturePage()` 抓**合成后的画面** → 按 CSS 矩形裁 → 编码。**纯只读**：⛔ 一次 `invalidate()` 都不调（空图也不重试、不逼重绘 —— 2026-10-08 口径，见坑 69）；坐标口径与"为什么不用 `gl.readPixels`"都写在文件头 |
| `source/core/sandbox.ts` | vm 沙箱执行器（超时两层、日志捕获、跨 realm 错误归一化） |
| `source/core/serialize.ts` | 返回值序列化上限（深度/数组/键/字符串）+ cc 对象压成摘要 |
| `source/core/recipes.ts` | recipe 存储与五件套助手 + **复用门禁**（`checkRecipeReusability`） |
| `source/core/scene-bridge.ts` | 主进程 → 场景进程的桥（`execute-scene-script` + 失败模式区分） |
| `source/scene.ts` | **场景脚本**（跑在引擎进程）：`ping` / `runCode` / `describeApi` / `viewMetrics` / `fitView` + 全部场景助手（`eachNode`/`tree`/`nodeByPath`/`dump`/`snapshot`/`worldRect`/`contentBounds`/`captureView`/`pick`/`labelFit`/`snapshotTree`/`diffTree`…）。`viewMetrics` 是**截图链路里「量」的那一半**（页面 href / 画布几何 / 节点矩形，靠 `cce.Camera.camera.worldToScreen` 投影；带 `fit` 时再多一项 `framing` = 目标拍全了没有）；`fitView` 是**「摆相机」的那一半**（三级取景 + 视角还原，判据全部量着验）；`readSceneMode` 报**这一页画的是编辑器场景还是跑着的游戏**（**只读** `PreviewPlay._state`，见坑 65）。⛔ 原来的 `runtimeControl`（在场景进程里直调 `cce.PreviewPlay` 开关预览）**2026-10-08 已删**（见坑 70）。构建后是 `dist/scene.js`，由 `package.json` 的 `contributions.scene` 注册 |
| `source/types/electron.d.ts` | 手写的**最小 Electron 声明**（只要 `webContents` + `NativeImage` 那几个方法）—— 不拉整份 66 万字符的 `electron.d.ts` |
| `scripts/verify-cocos-engine.js` | 验证整条执行链（假 Editor + 假 cc，真跑 `dist/scene.js`）。**改沙箱/场景脚本/recipe 后必须跑** |
| `source/dsh-host.ts` | 托管子进程 + 接四条流（stdout/stderr/工具 IPC/控制 IPC）+ 维护转写与广播 + 历史回放与恢复 + **会话读数（用量 + 进度：回合结束/跑完命令各读一次，清单与目标还走实时事件，都走广播推给面板）** + **回合锚点（`turn/start` → 转写条目号）** |
| `source/history.ts` | 历史会话：工程键（照抄 DSH 的 `projectKey`）、列会话、读日志、**全文搜索 / 导出 / 删除**（都是 spawn 系统 node 跑下面那个脚本） |
| `source/sdk-client.ts` | SDK 协议客户端（3 个请求 / 4 个通知） |
| `source/images.ts` | **图片附件的唯一真源**：扩展名→MIME 白名单、20MB/20 张/200MB 三个上限（与 DSH 附件库同口径）、扫目录兜底、读文件成规范 base64、批次校验、面板侧的筛选/体积显示也用它（面板与主进程**共用这一份**，不许抄第二遍）。纯 fs + path，不开编辑器就能验 |
| `source/panels/default/index.ts` | 面板 UI：零依赖，纯 DOM（挂载、状态、轮询/广播、设置、外观、历史抽屉、图片粘贴/选图/碎片区、交互卡片、**输入触发器**、**用量 chip 与用量抽屉**、**待办 chip 与进度抽屉**、**活动 chip 与活动抽屉**） |
| `source/panels/default/cost.ts` | 花费那一块的**纯函数**（`formatMoney` 是上游 `dsh-cost-meter` 的逐字移植、`costTextOf` 说该说哪几句话）。与 `progress.ts` 同一个摆法：**零依赖、不碰 DOM**，`verify-panel.js` 跑已知答案；`verify-stats.js` 把**真插件** import 进来对拍格式化 |
| `source/panels/default/mention.ts` | **`@` token 语法的移植层**（对齐 `@deepseek-ai/dsh-file-reference/grammar`）+ 面板自己的「整份输入 → 行/列」换算。`verify-panel.js` 里有对账，**改它必须跑那个** |
| `source/panels/default/progress.ts` | 进度那三块的**纯函数**（chip 文案 `progressChipText`、清单计数 `todoCounts`、三种状态标记、回合条目提示）。与 `mention.ts` 同一个摆法：**零依赖、不碰 DOM**，所以 `verify-panel.js` 能 `require` 编译产物跑已知答案 —— 而 chip 文案错一个字就是「把上一轮的清单写成现在正在做的事」 |
| `source/panels/default/markdown.ts` | markdown 子集渲染（纯 DOM，绝不用 `innerHTML`） |
| `source/panels/default/tool-card.ts` | 工具卡片：按工具名分派种类 + 从入参抽标题 |
| `static/style/default/dsw-tokens.css` | **生成物**：从 DSH 抽出来的 `--dsw-*` token（别手改，重跑脚本） |
| `static/style/default/index.css` | 手写组件样式层，只消费 token |
| `scripts/extract-dsw-tokens.js` | 抽 token（幂等，`--check` 可校验是否与已装 DSH 一致） |
| `scripts/preview-panel.js` | **不开编辑器看面板**：真面板代码 + 真 CSS + 样例转写 → 自包含 HTML（含 `__dshFakePaste` 粘贴模拟、用量样本的 `?usage=` 各档、进度样本的 `?progress=` 各档） |
| `scripts/session-log.js` | 会话日志读取器（`list` / `read` / **`search` / `export` / `delete`**，输出一行 JSON）。**要用 node ≥ 22.15 跑**（zstd）。2026-12 起还管两件重活：**`export --zip`**（含子孙会话与附件像素，布局对齐 DSH 官方）与 **`delete --reclaim-attachments`**（候选 ∩ 全库无引用 ⇒ 搬墓碑）。它同时 `module.exports` 出纯逻辑给校验脚本用（沙箱里 spawn 抓 stdout 是 EPERM，同一条判据得能直接 require） |
| `scripts/zip.js` | **零依赖 ZIP 写入器**（`node:zlib` 的 `deflateRawSync` + 自己实现 CRC32；store 与 deflate 两种 method；**不做 ZIP64** —— 超限抛错而不是产出坏包；`assertSafeEntryPath` 挡 Zip Slip） |
| `source/stats.ts` | **会话读数的读取器**：读 DSH 的会话投影缓存（`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`）并归一化成面板能画的那几样 —— **一次读盘同时给用量与进度**（`readSessionCache`），**外加一次账本读**（花费的显示币种在 `cost-meter` 的账本里）。**都是明文 JSON，所以主进程自己读盘**（不需要 zstd / 外部 node）。五条用量口径 + 一条进度口径写在文件头 |
| `scripts/verify-stats.js` | 用量 / 进度 / **花费**的回归：合成一份投影缓存跑真读取器 + **与上游公式/形状对账**（含进度那三行的状态 vs 视图）+ **真跑 `--dump-config` 验数据源挂着** + **把真插件的 `formatMoney` import 进来对拍** + 真缓存/真账本只读普查（含 `plan` 从没 active 那条判据） |
| `scripts/verify-bridge.js` | 插件自检：装的那份 == 源的那份、注册了 8 个工具、描述要点还在、**控制通道能真发图**、**交互通道能真应答两个 waterfall**、**活动通道**（jobs/subagents 的投影 + 一次都不调 `read()` + 中断的 authority 形状） |
| `scripts/verify-panel.js` | 面板静态契约：`MSG` ↔ `package.json`、`SELECTORS` ↔ 模板、样式类 ↔ CSS、**两个格式化函数的已知答案**（`formatTokens` / `formatDuration`），以及 **`@` 语法的对账（我们那份 vs DSH 装的那份）** |
| `scripts/verify-images.js` | 图片链路的主进程那半（扫描/读取/校验/筛选/路径映射），不开编辑器就能跑 |
| `scripts/verify-replay.js` | 拿**真日志**跑回放：形状容错（工具结果不会被新旧格式差异吃掉）、代数递增 |
| `scripts/verify-history.js` | 搜索 / 导出 / 删除的回归：**合成一棵会话树**（真 zstd 拼接帧、含末尾半个帧、含「目录名 ≠ header.id」、含两个日志文件并存），跑真脚本验判据 —— 投影后匹配、AND 语义、覆盖率如实上报、两种 `tool/result` 形状、命令名从配对事件里取回、jsonl 掐掉半行、`..` 之类的越界删除被拒、**挑日志文件的优先级**（当前格式 vs 旧残留，见坑 61）、以及**脚本 CLI ↔ `history.ts` 的调用契约**。只碰系统临时目录。<br>2026-12 起**同一个文件里还有第二段**：**直接 `require` 那个脚本的纯逻辑**（81 条，不 spawn）—— 覆盖 `zip.js`（往返 / CRC32 与 `zlib.crc32` 交叉验证 / 压缩不动退 store / Zip Slip 8 例）、会话索引（跨工程反查 / 重复 id 指名报错 / DFS 前序 + fork 口径）、**导出 ZIP 用独立解析器读回**（条目顺序 / 根会话逐字节 / 代理对 / manifest 对账）、**回收**（dry-run 与真跑同一份清单 / 唯一引用被搬而跨会话共享的还在原地 / hash·bytes·时间窗·缺失四条否决 / `incomplete` 时一个没动 / 墓碑路径与内容 / 不碰 `request-images`）。**两段分开的理由**：沙箱里 spawn 抓 stdout 是 EPERM，纯逻辑那半照样要能跑 |
| `scripts/verify-profile-rows.js` | **真起一次 profile**（临时挂一个探针插件）验「那几个服务到底挂上没有」+ 验「服务只能靠 `inject` 取」。抓过两个只在启动时才现形的错（见「输入触发器」一节） |

## 用起来

1. **首次**：确认 node 与 dsh 在 PATH 上（面板设置里留空即可自动探测；找不到会在面板上红字说明）。
   **不需要装任何第三方包**：profile 的两层 bundle（`dsh-base` / `dsh-sdk-app`）都是 DSH 自带的，
   `install-profile.js` 只做**离线幂等**的文件同步。
   （2026-12 之前这里挂过一个第三方的 `dsh-cost-meter` 来提供「花费」那一行；现在**刻意不挂** ——
   profile 里声明了却没装会让**整棵树起不来**，代价远大于「少一块功能」，见「花费」一节。）
2. **加载扩展**：重启 Cocos Creator（或扩展管理器里刷新）。
3. **打开面板**：菜单 `面板 → dsh_chat → 打开 DSH 对话框`，把它拖到 Inspector 旁边停靠。
4. **首次启动要等几秒到几十秒**（加载整棵 DSH 插件树；热启动实测约 2.3 秒）。之后直接说话即可。
5. **重启不丢上下文**：agent 起来之后会自动接上本工程最近一条有内容的会话（并把它回放出来）。
   想从零开始点「新会话」；想看以前聊过什么点 **⟲**。标题栏会显示这条会话的标题（模型生成的，
   见「输入触发器」一节）。
6. **发图片**：截图之后把光标放进输入框按 **Ctrl+V**；或者点输入框左边的 **🖼**
   从工程 `assets/` 里选一张（可搜索、有缩略图）。详见「图片」一节。
7. **打 `/`** 会弹出斜杠命令表（`/compact` `/plan` `/goal` `/feedback` …，↑↓ 选、Enter 认）；
   **打 `@`** 会弹出工作区路径候选（选目录会继续保持菜单，可以一层层往下钻）。
   两者都是**发给宿主**而不是发给模型 —— 详见「输入触发器」一节。
8. **它想歪了 / 你改主意了**：输入框旁边会出现 **停止本轮**（只在它跑的时候出现）——
   按下就中断当前这一轮，**会话和上下文都留着**，你可以接着说「不是这个意思，改成…」。
   右上角那个 **停止** 是另一件事：它停掉整个 agent 进程（要重启，重启后会自己接回上次的会话）。
   两个按钮的分工见「已知限制」第一条。
9. **找回以前聊过的东西**：**⟲** 打开历史抽屉 —— 上面那个框筛标题（边打字边筛），
   按 **Enter** 或点「搜全文」就去**所有会话的内容**里搜（结果里会写「扫了几个会话、为什么停」）。
   点一条命中 = 回放它并**滚到命中的那一条**。每条会话右下角可以 **md / jsonl / zip 导出**
   （zip 是**对齐 DSH 官方导出**的那一份：含子会话与附件像素，比前两种慢，见「导出 ZIP」一节），
   也可以**删**（点一下先问、再点一下才真删；确认条上有个**默认不勾**的「顺带回收无引用附件」）。
   详见「历史会话」与「导出 ZIP / 回收附件」两节。
10. **看一眼花了多少 / 上下文的占用**：状态行右边那颗 **`上下文 12.3%`**（占用过 60% 变黄、
    过 85% 变红），点开是用量抽屉 —— 本会话累计 token、上下文估算组成、回合与耗时
    （首字延迟 / 生成速度）、**花费**（按你设的币种与汇率显示，另附账本原值（美元）、模型调用次数、
    今日全部工程合计），以及**这个数字有多新**（检查点水位 + 落后多少条 + 写于何时）。
    满了想压缩就打 `/compact`，它跑完会自己重读一次。详见「会话用量」一节。
11. **看一眼它现在做到哪一步**：旁边那颗 **`待办 3/8`**（agent 用 `todo_write` 写的清单，
    **实时**到面板），点开是进度抽屉 —— 清单（`✓` 做完 / `◐` 在做 / `○` 没开始）、
    这一局的目标（`/goal` 模式）、以及**整个日志的回合目录**（点一轮就跳到那一轮）。
    ⚠ 每一轮开始时 DSH 会把清单归零，所以本轮还没写新表时那颗 chip 会显示 `待办 3/8（上一轮）`——
    那不是 bug，是「本轮 agent 还没写清单」这件事被说出来了。详见「进度」一节。
12. **看一眼还有什么在后台跑**：状态行那颗 **`后台 1 · 子 2`**（**没事时整颗不出现**）。
    点开是活动抽屉：上半块是**后台任务**（跑着的长命令、子 agent 起的任务都列出来，带状态与退出码）、
    下半块是**子 agent**（可以中断某一个的当前一轮）。
    ⚠ 两块都**只活在运行时内存里**（agent 停掉就查无此物，历史会话也看不到），
    而且**任务的输出看不到** —— 不是没做，是读了会把模型的 `job_output` 废掉，详见「活动」一节。

设置项（面板右上 ⚙）：

| 字段 | 说明 |
|---|---|
| `主题` / `配色` / `正文字号` | 外观，三个维度互相独立。**主题**（明暗）三档：跟随编辑器 / 深色 / 浅色（标题栏那个 ◐ 按钮也能切）。⚠ 文案 2026-11 从「跟随系统」改成「跟随编辑器」—— `resolveTheme` 的实际行为是「先认编辑器主题，认不出才跟系统」，旧文案把回落档当成了主档。**配色**两档：`DSH 默认` / `跟随 Cocos 编辑器（深色）` —— 与明暗**正交**，落在根节点的 `data-palette` 上，覆盖层是 `static/style/default/editor-theme.css`（只重定义 `--dsw-alias-*`，不写组件选择器；**不许写进 `dsw-tokens.css`**，那份是生成物，重跑 `extract-dsw-tokens.js` 会整份覆盖），目前只有深色一档（编辑器深色是常驻形态）。**字号** 12~17px，默认 14 —— 与 DSH Web GUI 同口径 |
| `provider` / `model` / `reasoning` | 走哪条模型路由；默认与本机 `$DSH_HOME/settings.yaml` 的 `agent-default-model` 对齐 |
| `maxTokens` | 0 = 不传（用适配器默认） |
| `工作目录` | agent 的 cwd；留空 = 当前 Cocos 工程根 |
| `node 路径` / `dsh bin.js` | 留空 = 自动探测 |
| `自动启动` | 面板打开时自动起 agent |
| `显示 stderr` | 把子进程 stderr 当 note 显示（排查用） |

面板上还有 **修复 profile**：profile 被删/被改坏时一键重装，结果（含失败原因）直接显示在横幅上。

## 历史会话：看得见，也接得上

标题栏那个 **⟲** 打开历史抽屉，列出本工程在 `$DSH_HOME/sessions/` 里的会话（标题 = 会话日志里
的 `session/title`，没有才回退成首条用户消息、时间、轮数、大小）。点一条 = 把它的日志**回放到对话区**（只读），
横幅上出现「继续此会话」；点了就真接上，之后的消息带着那段历史。

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

### 搜索 / 导出 / 删除（**2026-12 新增**）

抽屉里现在有**两档**搜索，因为它们的成本差着量级 —— 混成一个控件会让人分不清
「为什么刚才秒出、这次要等两秒」：

| 控件 | 搜什么 | 成本 |
|---|---|---|
| 搜索框（边打字边筛） | **标题与 id** | 零：在手边这 30 条里做字符串匹配 |
| **搜全文**（Enter 或按钮） | **所有会话的内容**（你的话、我的回答、思考、工具参数与结果、命令） | 要读盘解压，有**硬预算** |

每条会话右下角还有三颗按钮：**md** / **jsonl** / **删**。

| 动作 | 背后发生了什么 | 落在哪 |
|---|---|---|
| 搜全文 | 主进程 spawn 系统 node 跑 `session-log.js search`：逐会话解 zstd → **字面子串**预筛 → 命中的才投影算片段 | 只读，不写盘 |
| 点一条命中 | 回放 + **滚到命中的那一条**（并高亮 4 秒） | 只读 |
| md | 投影成**给人读的转写**（`## 你` / `## 我（思考）` / `### 工具 read` + 参数与结果围栏） | `<DSH_HOME>/exports/<工程键>/<时间>-<标题>-<id8>.md` |
| jsonl | 把日志**解压后原样**搬出去（不投影、不截断；末尾半行会掐掉） | 同目录 `.jsonl` |
| 删 | **两段式**：先 `--dry-run` 报「1 个文件 · 1.7 MB」，行内变成确认条，第二下才真删 | 删掉 `<sessions>/<工程键>/<id>/` |

四条必须说清楚的口径：

1. **搜索是字面子串，不是分词** —— 中文按字匹配（搜「打击感」能命中文中间的三个字）。
   本 profile 里的 FTS 后端是**关着的**（`session-query-sqlite` 的 `openAt: never`），
   而它继承来的 `filterEvents` 是逐会话、跑在宿主事件循环上的（搜一次就把 agent 卡几秒），
   何况 SQLite 的 `unicode61` 分词器对中文几乎等于不分词。所以搜索走**独立进程读盘**：
   顺带买到「agent 没在跑也能搜」与「不阻塞任何人」。
2. **搜索有预算，而且如实报覆盖率** —— 会话数 / 压缩字节数 / 毫秒三个上限谁先到就停，
   面板上会写「命中 3 条 —— ⚠ 没搜完：已经找够这么多条就收工了（更老的还没看）
   （扫了 6/107 个会话 · 10.1MB · 1454 ms）」。**不这么说的话，用户会以为搜遍了整个工程。**
   本工程实测：107 个会话 / 159 MB 压缩日志，全量扫一遍要几十秒 —— 所以默认就是「够用就停」。
3. **导出不往工程里写**（导出物是「看一眼就删」的东西，扔进工程只会污染 git）。
   三种格式**不是同一件事的三种格式**，是三种用途：`md` 给人读、`jsonl` 给工具吃
   （解压后一行一事件，不投影不截断）、**`zip` 对齐 DSH 官方导出**
   （`session.jsonl` + `subagents/<id>/session.jsonl` + `media/<hex>.<ext>`，见下一节）。
   前两种**图片附件不跟着走**（像素按内容存在 `<DSH_HOME>/attachments/v1/objects/…`，
   跨会话去重共用），md 里只留下「图名 + 尺寸 + 体积」的引用；**zip 那一路才带像素**。
4. **删除默认不动附件**，也**删不掉 agent 当前正在用的那条**（运行时手里攥着它，下一次落盘会把目录
   重新建出来 —— 表现就是「删了它又回来了」）。要删当前会话，先点「新会话」。
   二次确认条上有一个**默认不勾**的「顺带回收无引用附件」（见「导出与回收」一节）。

### 导出 ZIP / 回收附件（**2026-12 新增**）

这两件事是同一个来路：**附件的引用关系只活在会话日志里**
（内容块 `{type:'image', attachment:{attachmentId:'sha256:<64hex>', …}}`），
而 DSH 自己**既不导出子会话的像素、也从不回收附件**。所以两件事都得自己算。

#### `zip`：对齐 DSH 官方那一份

```sh
node scripts/session-log.js export --root <sessions> --project <工程键> --id <会话 id> \
  --zip --with-subagents --with-media
```

产物布局**逐字对齐** `@deepseek-ai/dsh-session-log-export`（那个包依赖四个运行中的 cordis 服务，
我们调不了，所以是照它的规格自己实现的）：

```
dsh-session-<safeId>.zip
├── session.jsonl                       根会话日志的**明文**（zstd 已解，逐字节原样，不重新序列化）
├── subagents/<safeId>/session.jsonl    每个子孙一份（DFS 前序）
├── media/<hex>.<ext>                   附件像素
└── manifest.json                       ⚠ 我们**加**的一份（DSH 不写：它靠各自的 header 自描述）
```

三条口径：

1. **两处有意偏离，都写明了理由**：① `media/` 下的名字**去掉 `sha256:` 前缀**
   （DSH 的原样是 `media/sha256:<hex>.png`，而冒号在 Windows 上解压会出问题）；
   ② **多一份 `manifest.json`**（编辑器面板里的人需要一个「这堆文件是什么」的入口）。
   其余三段式目录结构与 DSH 产物**可互认**。
2. **子孙的口径要分开报**：`origin === 'subagent'`（真子 agent）与「有 `parentSession`
   但没有 origin」（**fork**，`parentSession` 的官方语义本来就是"fork 血缘"）在日志头里
   是两回事。面板与转写里写的是「子孙 5 个 · 其中子 agent 4 · fork 1」——
   合成一个数的话，用户没法判断「我派出去的 agent 到底几个」。
3. **有一句话必须带出来**：**当前活跃会话可能少最后几条** —— DSH 导出前会先 `flush`，
   而我们只是读静态文件（读的时候用 `stat → 读 → stat` 复检 `size+mtimeNs`，
   变了就重读，最多 3 次；不稳定就如实写进 `notes`）。

#### `--reclaim-attachments`：删会话时回收**全库已无引用**的附件

```sh
node scripts/session-log.js delete --root <sessions> --project <工程键> --id <会话 id> \
  --reclaim-attachments --dry-run      # 先看清单，去掉 --dry-run 才真删
```

> ⚠ **附件是不可重建的**（`dsh-attachment-local/README.md` 的原话：*"Images are kept forever …
> nothing collects unreferenced objects"*），而且**跨会话共享**（本机实测同一个 sha256 出现在两条会话里）。
> 所以这一段的每一条守卫都是**硬要求**，不是可选优化。

| 守卫 | 为什么 |
|---|---|
| **交集，不是差集** | 只搬「**这条会话引用过** ∧ **全库都没人再引用**」的那几个。直接按「全库无引用」扫会把别的会话**正在用**的图搬走 |
| **全库扫描要排除即将被删的这条日志** | 不排除的话交集**恒为空**（它自己就引用了那些 id）——这个坑很隐蔽：功能看起来"跑了、什么都没找到" |
| **超预算 ⇒ 一个都不搬**（`incomplete: true`，fail-closed） | 判据不全时的"顺手删"就是不可逆的误删。宁可什么都不做 |
| **每个候选复算 sha256 + 核对 bytes** | 写入中断 / 外部改动过的对象不能当孤儿处理 |
| **1 小时时间窗** | 别的 DSH 进程可能刚写对象、日志还没落盘 —— 那个窗口真实存在（DSH 导出前要 `flush` 就是同一个理由） |
| **搬墓碑，永不 unlink** | 移到 `attachments/v1/.trash-<yyyyMMdd>/<hex 前 2 位>/<hex>`（同盘 rename；跨盘退化成复制 + 删原件）。**没有 `--purge`** 这个旗标 —— 不可逆的东西这一轮不提供 |
| **`request-images/` 一律不碰** | 那是派生缓存（可按需重算），而且它的 hash 是 `sha256(descriptor)`、**反查不到归属**，判据太弱、收益太小 |
| **ENOENT 当成功** | 别的进程可能已经处理过同一个对象 |

**量级（真机实测，很重要）**：498 条会话 / 569 MB，全库扫描里 **zstd 解压本身 60.8 秒**
（单线程，省不掉）+ 逐行 `JSON.parse` 8.2 秒 ⇒ 所以预算是 **120 秒**
（面板上写的是「通常 1~2 分钟」，并在勾选时就先说清楚）。
另一条同样重要：本机 **797 个附件对象全都被至少一条会话引用** ⇒ 现在真跑 `orphans` 就是 **0**。
**它不是「一键腾空间」**，只在删过「引用唯一」的会话之后才有活干 —— 面板的话术就是这么写的。


## 会话用量：token / 上下文占用（**2026-12 新增**）

状态行右边那颗 **`上下文 12.3%`** 就是它（点开是一个抽屉）。数据**不是问 agent 要的**，
而是主进程直接读 **DSH 自己的会话投影缓存**：

```
<DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json
```

那是 `dsh-session-projection-cache` 落的**检查点**（一个会话一个 JSON 文档，
`record.rows.<投影键> = {ver, seq, val}`）。本 profile 里挂着的几个单元正好凑齐要的数字：

| 行 | 谁注册的 | 给了什么 |
|---|---|---|
| `contextPressure` | `dsh-token-meter` | 窗口上限、**上一次**请求的 prompt 侧实测、**下一次**请求的预估 |
| `contextBreakdown` | 同上 | 上下文**估算**组成（系统提示 / 工具表 / 对话） |
| `tokenUsage` | 同上 | 本会话累计：输入（未命中缓存）/ 输出 / 缓存读 / 缓存写 |
| `sessionStats` | `dsh-session-stats` | 回合数 / 步数 / 模型耗时 / 工具耗时 / 首字延迟 / 解码速度 |
| `costUsage` | `dsh-cost-meter`（**第三方**插件；⚠ 本 profile **刻意不挂**它，见下一节） | 花费（**美元**入账；显示成什么币种在它的账本里，见下一节） |

**为什么不走 SDK / 插件**：SDK 协议就 `initialize` / `session/prompt` / `shutdown` 三个方法，
**没有**投影读取；而 `ctx.tokenMeter.measure()` 只有**宿主进程内的插件**拿得到，面板与 agent
是两个进程。好在缓存是**明文 JSON** —— 主进程自己 `readFile` 就够了，**不需要 zstd、
也不需要外部那个 node**（对比：会话日志必须 spawn 一个 Node ≥ 22.15 去解）。
顺带买到「agent 没在跑也能看」。

### 四条口径（面板上原样写着，一条都不许省）

1. **这是检查点，不是实时流。** 重写时机是「会话创建 / `turn/end` / 会话销毁」三个必写点
   + 两个节流（本 profile：**每 200 条事件或每 5 秒**）。所以抽屉头部那一行永远写着
   **来源 + 水位（记到第几条事件）+ 落后多少条 + 写于何时** —— 一份「12% 占用」在落后
   一万条事件时是完全没有意义的。主进程在**回合结束**（缓存恰好在那一刻写检查点）与**跑完
   斜杠命令**（`/compact` 就是靠它才看得到变化）之后各读一次，并走广播推给面板。
2. **占用率用「下一次请求的预估」（`projectedTokens`），不是「上一次的实测」。** 公式**照抄**
   上游 wire view：`max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)` ——
   压缩会让上一次的实测偏高，这个修正把它拉回来。本机真数据里两者差过 **2.8 倍**
   （实测 273.4k vs 预估 96.7k，那条会话被压缩过）。`verify-stats.js` 有一条断言**直接盯着
   上游那段源码**：哪天它改了公式，我们会红，而不是悄悄算错。
3. **「上下文组成」是估算，而且它不等于上面那条占用率。** 上游 README 明说它按
   「四字符一个 token」定价，中文与 JSON schema 会明显低估，三个数加起来**对不上**
   `projectedTokens`（本机真记录里差过 25 倍）。所以它单独一块、标着「估算」、
   **不参与**那条占用条 —— 只用来比相对大小。
4. **花费缺失时显示「没有」，不显示 `0`。** `costUsage` 由第三方插件 `dsh-cost-meter` 注册，
   而**本 profile 刻意不挂它**（见下一节）—— 所以新会话基本不会有这一行。但读取器照旧全功能：
   挂着它跑过的会话（含 2026-12 之前那批）检查点里**已经有**这一行，面板照旧画。
   `cost` 为 null 的意思是**这一行不存在**，不是「没花钱」，所以面板上永远不画 `$0.0000`。
   顺带：`tokenUsage` / `sessionStats` 缺失时对应的块整个不画，也**绝不补 0**。

### 花费：要读**两个文件**才画得出来（**2026-12 新增**）

> ⚠ 它是**第三方**插件（`dsh-cost-meter`，不是 DSH 自带的），而**本 profile 刻意不挂它**
> （`dsh-profile/package.json` 里零第三方 bundle）。所以这一节一半的篇幅在讲
> **「没挂它的时候会怎样」** —— 结论是：**只少一块功能，agent 照样起得来**，
> 而且面板会明说「这是本 profile 的选择」+ 想用怎么加回来。
>
> 为什么不挂：profile 的 `bundles` 里**声明了却没装**时，DSH 不是跳过那一行 ——
> `resolveBundleDir` 直接抛 ⇒ **整棵插件树起不来**（面板上只有一句「agent 启动失败」）。
> 那是「少一块功能」与「整个 agent 用不了」之间的取舍，我们选了前者。
> 这条机制（`install-profile.js` 把解析不到的第三方 bundle 从装出去的那份清单里摘掉）
> **照旧保留并有人在验**：`verify-stats.js` 的 `[2c]` 用一份**合成真源**（假的第三方包名）
> 在真跑它；`[8]` 与 `verify-profile-rows.js` 各有一条「零第三方」的红线盯着真源。
>
> 盘上可能还留着以前 pnpm 装的那份 `$DSH_HOME/profiles/cocos/node_modules/dsh-cost-meter`
> —— 它是**残留但无害**：不在 `bundles` 里就不会被挂上（`dsh plugin --profile cocos install`
> 会顺手 prune 掉它）。`verify-stats.js` 里那条「`formatMoney` 与真插件逐字对拍」因此
> 在本机还跑得动，换了机器就会**跳过并说明**（条件断言，不是红）。

金额在投影缓存那一行里，但**单位不由面板决定**：`costUsage` 的 `totals.cost` **恒为美元**
（上游 `usdFromCost` 的注释：「账本恒以美元存储」）。显示成 `¥` 还是 `$`、按什么汇率折、
留几位小数 —— 全在 `dsh-cost-meter` 自己的**账本**里：

```
<DSH_HOME>/storages/cost-meter/ledger.json      （config.currency / symbol / decimals / exchangeRate）
```

所以面板的「花费」那一块是这样画的（每一条都有它存在的理由）：

| 画什么 | 从哪来 | 为什么 |
|---|---|---|
| `deepseek-official / 模型名` → **`¥19.0945`** | 金额 = 缓存；币种/汇率 = 账本 | 与 DSH 自己（web 那边的花费面板）**同一种写法** —— 格式化是上游 `formatMoney` 的**逐字移植**，连「数值过小时自动放宽两位小数」都照搬（`verify-stats.js` 把真插件 import 进来跑 35 组对拍） |
| **账本原值（美元）** `$2.6520` | 缓存 / 账本 | 「折算是怎么来的」必须看得见；读不到账本时**这一行就是主行**（不猜汇率） |
| 模型调用 `1225 次` | 账本 | 「为什么这么贵」最有用的一个数 |
| **今日（全部工程）** `¥107.4362` | 账本 `days[今天]` | ⚠ 账本是**这台机器共享的**（不分工程、不分 profile），标签里就写着「全部工程」，否则会被当成「本工程今天花了这么多」 |
| 说明（折算 / 兜底 / 对账） | `costTextOf` | 见下面三条 |

三条判据（与用量、进度同一套「两个来源必须说出来」的规矩）：

1. **金额只有一个，来路必须标出来。** 检查点里有就用检查点，没有才退回账本里那条会话
   （老会话就是这样），退回时抬头写「本会话（来自账本）」。反过来（账本优先）不行 ——
   抽屉里其它每一行都是投影缓存给的，混两种来路会让「水位 / 落后多少条」失去意义。
2. **两处对不上就说出来**（差 > 0.01 美元或 > 1%）：账本保留的是**调用当时**按当时价表算出的
   金额，检查点会用**当前**价表把整份日志重折一遍，所以改过价表或汇率之后两者本来就会不一样。
   本机真数据里 446 条两边都有金额的会话中有 **8 条**（1.8%）超出容差 —— 这句话不是摆设。
3. **读不到账本照样能用**：按美元原值画 + 说清原因（`costNote`）。这类说明**不进 `notes`** ——
   `notes` 是**会话用量本身**的口径问题，而这一条只影响「显示成什么币种」，
   所以由花费那一块自己说（措辞全在 `panels/default/cost.ts`，那里才有已知答案表）。

### 怎么验的（都不开编辑器）

```sh
npm run verify:stats     # 合成一份投影缓存跑真读取器 + 与上游口径对账 + cocos profile 挂载核查
```

三类断言，各有各的理由：

| 类 | 验什么 | 为什么值钱 |
|---|---|---|
| **上游口径** | 真读 `dsh-token-meter` 的源码，钉住公式、`pressureFrom` 的口径与两个 `stateVersion`；**把真 `dsh-cost-meter` 的 `formatMoney` import 进来对拍** | 公式与格式化都是**照抄**来的，上游一改这里必须红 |
| **profile 挂载** | 真跑 `dsh --profile cocos --dump-config`（实测 ~100ms）+ 读 `dsh-profile/package.json` 的 bundles/依赖 | 数据源全在 bundle 里；哪天 DSH 不再挂 token-meter，面板就是一片空白 |
| **合成语料** | 临时 `DSH_HOME` 下的投影缓存与**账本**，跑真 `dist/stats.js` | 压缩修正、缺字段、脏数据（负数/字符串/NaN）、越界 id、坏 JSON、格式版本不认识、**账本缺失/坏掉/跨零点累加**…… 这些守卫只能在合成语料上验 |

对**真** `<DSH_HOME>` 只做**只读**抽查（目录不存在就跳过），一个字节都不写：
真缓存里有多少份带 `costUsage`、真账本里有多少天/多少条会话记录、以及两者对得上的比例。

## 上下文增长曲线（**2026-12 新增**）

用量抽屉里的那一块 **「上下文增长」**：一条会话里**上下文随每次模型调用怎么长大**
（一根柱 = 一次调用，柱高按最大值归一）。

> ⚠ 这一行同样由**第三方**插件注册（`dsh-context`），而**本 profile 不挂它**
> —— 与「花费」是同一个处境。所以这一节一半的篇幅也在讲**「没有这一行的时候会怎样」**：
> 结论是**那是常态、不是读失败**，面板会明说是谁注册的、本 profile 为什么不挂、
> 以及「只有 web/desktop profile 跑的会话才有」（缓存目录是整个 `DSH_HOME` 共享的，
> 所以别的 profile 跑的会话也落在同一个目录里）。

数据在**同一个 JSON 的另外一行**（`record.rows.contextTimeline = {ver, seq, val}`），
所以**读它不增加一次读盘**：`readSessionCache` 一次读盘把用量、进度与这条曲线一起给。

| 事实 | 是什么 | 为什么值得单独说 |
|---|---|---|
| `requests[].prompt` | provider **实测**（input + cacheRead + cacheWrite） | **主曲线用它** |
| `requests[].{system,tools,user,inject,assistant,tool,total}` | **估算**（上游按「四字符一个 token」定价） | 只画它会让占用**看起来远低于真实** |
| `events[]` 里 `kind: compaction / prune` | 压缩 / 裁剪点（`tokens` = 净释放） | 曲线掉下来的那一截就是它们 |
| `archiveFloor` | seq 小于它的删除记录**已被缓存裁掉** | 有了它，左半段的落差就查不到了 |
| `contextWindow` | 窗口上限（可能没有） | 没有就**不画百分比**（分母不知道就不补） |

### 四条口径（面板上原样写着，一条都不许省）

1. **主曲线必须优先用实测的 `prompt`，不是估算的 `total`。** 本机真数据实测
   （470 份缓存 / 40427 条请求）：`prompt ÷ total` 的 min 0.88、**中位 1.34**、p95 1.63、
   max 2.69 —— 也就是说**只画 `total` 会让人以为上下文占用远低于真实**（最坏低估到 1/2.7）。
   所以柱高取 `prompt`，缺失时才回落到 `total`，并且**把回落的那几根标成估算**
   （面板画成斜纹，图例里写着「不许混进实测里」）。本机 4 万条请求里只有 32 条没有实测。
2. **`ver` 只认 13，不匹配就丢掉整行。** 框架的口径是「版本不匹配 → 丢掉整行、
   从日志冷折叠」，**从不迁移**。所以面板如实写「这一行的版本是 N，本读取器只认 13，
   所以不画这条曲线」—— 硬读只会读出一个**错的形状**（而它看起来是对的，这比空白更糟）。
   **一个例外**：`ver === 1` 且 `val` 是**空对象**时，那是那个插件在「宿主低于它的基线」时
   注册的**降级占位**（`init: () => ({})`、`apply` 恒等），面板上的话是
   「宿主版本低于这个插件的基线，这一行是空的」。判据要**两个条件同时成立**：
   只看版本号会把「版本 1 的别的形状」也说成占位。
3. **压缩点要合并、聚合不许取平均。**
   - **挂载规则逐字照抄上游 wire view**（`while (requests[ri].seq <= ev.seq) ri++`）：
     压缩点钉在**它之后的第一条 request** 上（也就是「压缩之后的那一根柱」）；
     事件落在所有请求之后（刚压缩完会话就结束了）时钉在**最后一根柱**上 —— 丢掉它的话，
     表现是「明明压缩过，图上什么都没有」，而那是这块最容易犯的错。
   - **连发的 `prune` 合并成一个标记**：本机真数据里有一条会话 **52ms 内连发 7 条小 prune**、
     3.0 秒后才是那条大 compaction —— 不合并的话，柱子上会糊成一片（面板的合并窗是 5 秒）。
     同一根柱上有多处压缩时只画**一个** `✂`（它们是同一条竖线），几处、各释放多少都在 tip 里。
   - **点太多按回合聚合，取该回合的最后一步**（`requests` 中位 37 条、p95 322、**max 1500**，
     撞宿主的 `maxRequestSteps`；超过 **150 根柱**就聚合）。**绝不取平均值** ——
     平均会把压缩掉的那一截**抹平**，而那一截正是这张图存在的理由。
     柱宽 = 那个回合的步数（**不是**记录里那个 `stepCount`：它在 470 份真缓存里
     **一次都没出现过**，拿它当唯一依据的话聚合出来的柱宽会全是 1）。
4. **一个 0 都不许补。** `prompt` 与 `total` 都读不出来的请求**丢掉并计数**
   （面板说「有 N 条认不出来，没有为它们补一个 0」）；`contextWindow` 缺失就不画百分比；
   数据里真值就是 0 的那种柱子照样画（0 高，但 tip 里写着 0）。

### 怎么验的（都不开编辑器）

```sh
npm run verify:stats     # 合成语料跑真解析器（纯函数）+ 真缓存只读普查
npm run verify:panel     # 面板静态契约（选择器 / 样式类 / `**` 扫描 / 预览模板反引号）
node scripts/preview-panel.js --serve    # ?click=%23btn-usage&timeline=ok|none|oldver|empty
```

- **判据全在合成语料上**（`[11b]` 那一节，**纯函数、不 spawn**）：正常一份（优先 `prompt`、
  压缩点钉对柱、连发 prune 合并）、`ver` 不认识、`ver 1 + {}` 占位、`requests: []`、
  估算回落被标成估算、400 次调用按回合聚合**且落差仍是 -150k**、阈值边界（150 不聚合 /
  151 聚合）、脏数据（字符串 / NaN / 负数 / 缺 `seq` / 不是对象）不崩不补 0。
- **面板那几句话也有已知答案表**（`timelineTextOf` 是纯函数）：哪条是实测、哪条是估算、
  没有这一行时的那两句、`archiveFloor` 那句、没有窗口上限时不画百分比、
  以及**所有话里都不许出现 `**`**（面板用 `textContent`，星号会原样画出来）。
- **真缓存只读普查**（同一趟扫描，不写一个字节）：本机 **499 份缓存里 472 份带这一行**
  （`ver` 分布 **13×472**）、其中 **457 份画得出来**（53 份按回合聚合），共 17574 根柱 /
  58 个压缩点 —— 也就是说「本 profile 不挂它」≠「这台机器上没有这一行」：
  带这一行的正是**别的 profile 跑的会话**（缓存目录共享）。
- **预览器**那四个状态（`?timeline=ok|none|oldver|empty`）里，`oldver` / `empty` 两句说明是
  **从 `dist/constants.js` require 进来的**，不在样本里手写 —— 手写必然与真读取器漂移，
  而漂移之后预览看起来一切正常（它只是显示了一句真面板永远不会说的话）。

## 进度：待办清单 / 目标 / 回合目录（**2026-12 新增**）

状态行那颗 **`待办 3/8`** 就是它（点开是一个抽屉）。它回答的是另一个问题 ——
用量回答「花了多少」，进度回答 **「agent 现在在干什么、这一局在追什么、一共聊了哪几轮」**。

数据来自**两条路**，这是这一块最要紧的设计（也是它比用量麻烦的地方）：

| 块 | 谁给的 | 新鲜度 | 为什么不能只留一条路 |
|---|---|---|---|
| **待办清单** | `todo/write` **实时事件**（`dsh-tool-todo`）+ 缓存补洞 | 实时（agent 每 `todo_write` 一次就到） | 清单标的是「我现在做到哪一步」——攒 200 条事件/5 秒才写一次的缓存，恰好慢在人最想知道的那几秒 |
| **目标** | `goal/change` **实时事件**（`dsh-goal`）+ 缓存补洞 | 实时 | 同上（目标的变化就是几句话的事） |
| **回合目录** | 只有缓存（`turnOutline`，`dsh-session-turn-outline`） | 最多落后 200 条事件 / 5 秒 | 它要的是**整个日志**的轮次摘要 —— 事件流里没有「整个日志」这个概念，而缓存里 30 轮一条不少 |

合并规则只有一条：**事件优先、缓存补洞**。为什么这条是对的：两边折的是**同一份事件日志**，
差别只在「折到第几条」—— 所以「事件里有就用事件的」永远更接近真相；缓存只在事件**没有**这一块时补上
（典型：最后那次 `todo_write` 落在历史回放的 2000 条窗口之外）。
两边都有而且不一样时**会说出来**（在抽屉底部的口径区），不默默挑一个。

### 三句必须说出来的话（不说是会误导人的，不是显示不精确）

1. **清单可能是上一轮的。** DSH 的投影口径是 **`todos` 在每一次 `turn/start` 归零**
   （`dsh-tool-todo` 的 `apply` 里那一行）—— 所以本轮 agent 还没写新表时，投影的值是 `null`。
   面板这时**不把旧表藏起来**（藏了会像 bug），而是照画、并在 chip 上写 `待办 3/8（上一轮）`、
   在清单下面加一句「这份清单是第 N 轮写的……本轮 agent 还没写新清单，下面这些不是现在正在做的事」。
   不加这几个字，用户会把上一轮的表当成现在正在做的事 —— 那是看板撒谎。
2. **三种「没有清单」是三个意思。** 没读过（chip 藏起来）/ 缓存说这一轮没写（`待办 —`）/
   agent **明确写了一份空表**（`待办 空`）。第三种是它自己说的，不是我们读不到。
3. **更早的回合点不动。** 面板的转写只留**最近 600 条条目**（`MAX_ENTRIES`），而回合目录是
   **整个日志**的 —— 所以目录里靠前的那些轮次正文已经不在窗口里了，它们画成**点不动的行**
   （`第 7 轮 · 只有摘要`），点了会明说「已经不在转写窗口里」，**不是点了没反应**。
   能点的那些跳过去之后会把抽屉关掉、滚到那一轮并高亮几秒（复用「搜全文命中」那套 `jumpTo`）。

### 一个实现细节：回合锚点是**两套编号**，必须换算

`turnOutline` 给的 `seq` 是那一轮 `turn/start` 的**会话事件序号**（上游文档明说它就是「往回翻页的目标」），
而面板的转写条目号是**宿主自己的计数器**（`++this.seq`），两者毫不相干。
所以宿主在收到 `turn/start` 时记下「**下一条上屏的条目**是几号」（`markTurnStart` → `append` 里的
`bindTurnAnchor`），把它当跳转落点发给面板；那一条已经被 600 条上限挤掉时给 `null`，
面板据此把它画成点不动的行。**只发大纲不换算的话，目录就只能看不能点。**

### 怎么验的（都不开编辑器）

```sh
npm run verify:stats     # 进度那三行的已知答案 + 上游形状对账 + 真缓存只读普查
npm run verify:panel     # 面板引用 + chip 文案的已知答案表（progress.ts 那个纯函数模块）
node scripts/preview-panel.js --serve
```

- **上游形状**：进度那三行踩的坑和用量**不同** —— 用量是把状态当视图读（字段名恰好对得上，错了
  看不出来），而进度是**状态与视图根本不同形**：`turnOutline` 的状态是 `{turns, draft}`、视图是
  `turns` 那个数组本身；`goal` 的状态多一层 `current`（视图是 `state.current`）。
  所以 `verify-stats` 直接盯上游那几行源码（`view: state => state.turns` 等）——
  照视图读会**一条都读不到**，而且是静默的。
- **清单归零那条口径**也盯着源码（`if (event.type === "turn/start") return null;`）——
  它是「（上一轮）」那句话的唯一依据。
- **真缓存普查**（只读，491 份）：清单有内容的 **88** 份（共 661 条）、有目标的 **23** 份、
  有回合大纲的 **450** 份（共 898 轮），并核对不变量（轮次是正整数、严格升序、状态都在白名单里）。
- **回放这条路的对账**（`node scripts/verify-replay.js`，拿真日志真跑回放）：
  回放之后确实绑出了回合锚点，而且**每一个可点的锚点都在转写条目里找得到** ——
  这是「两套编号换算」唯一能被验到的地方（绑错了不会报错，只会跳到一个别的地方去）。
  ⚠ 正是这条断言抓出了「回放的事件白名单漏了三个事件」（见坑 56）：加上之前，
  回放一条历史会话会**一个锚点都绑不出来**，而实时那条路一切正常 —— 只在翻历史时才现形。
- **顺便查出来的判据**：`plan` 那一行本机 **491 份里 `active` 一次都没 true** ——
  所以**没有**「计划面板」（`dsh-plan-mode` 的 `plan/mode` 事件在事件表里，但这个 profile 从来没用过它）。
  哪天有人开始用 plan 模式，那条断言会红，提醒来做这块。

## 活动：后台任务（jobs）与子 agent（**2026-12 新增**）

状态行那颗 **`后台 3 · 子 2`** 就是它（点开是一个抽屉）。它回答的是第三个问题 ——
用量回答「花了多少」、进度回答「它在干什么」，而这一块回答 **「按了停止本轮之后，还有什么在后台跑着」**
与 **「它派出去的那几个子 agent 现在在哪儿」**。

数据**不是问 agent 要的**，也不是读盘：这两块**只活在运行时进程的内存里**
（jobs 的注册表就是个 `new Map()`，子 agent 的描述符写在**子会话自己**的日志里），
SDK 协议（`initialize` / `session/prompt` / `shutdown`）一个都表达不了。
所以走的是与斜杠命令、`@` 路径同一条路：**插件（`dsh-cocos-bridge`）借宿主的注册表，
经控制帧转给面板**（`jobs/list` / `subagents/list` / `subagents/interrupt` 三个方法）。

### 三句必须画出来的话（不说是会误导人的，不是显示不精确）

1. **看不到后台任务的输出** —— 而这**不是没做，是不能做**。每个 job 只有**一个消费游标**
   （`dsh-jobs/lib/types/types.d.ts`：*"each job has one consuming cursor"*），
   面板读一次就会把游标推走，模型下一次 `job_output` 只会拿到 `(no new output)` ——
   为了在面板上多显示几行而废掉模型的工具，代价与收益完全不成比例。
   所以插件**只用 `list()` / `get()`**（后者的契约明写 *"without changing its read cursor"*），
   抽屉里就写着这一句 + 「想看输出就让模型调 `job_output`」。
   `verify-bridge.js` 里有一条断言**专门盯着这件事**（假服务暴露一个会记账的 `read()`，
   断言它**一次都没被调用**）。
2. **这些数字只活在内存里**：agent 停掉之后就查无此物 —— 历史会话**看不到**它们
   （与「用量/进度照样能翻历史」不一样，抽屉头部与没起 agent 时的提示都写着这一条）。
3. **子 agent 的 `running/idle/ready` 是我们自己合成的**，而且两个字段含义不同：
   `activity`（插件的 `activity`）只是「会话记录在不在内存里」，`status` 才是「忙不忙」——
   合成口径照抄 `dsh-tool-subagent-control` 的 `list-agents`：
   `agents.get(id)` 拿不到 ⇒ `ready`（= 只在磁盘上，可以 resume），拿得到就看 `agent.status`。
   面板上两个都写着（「运行中」+「会话记录在内存里」）。

### 列出来的东西（每一条都有它存在的理由）

| 画什么 | 从哪来 | 为什么 |
|---|---|---|
| 后台任务：状态 / 种类 / id / **label** | `JobSnapshot` 投影 | `label` 就是「命令原文」（pwsh 传整条命令）——**没有「命令」这个字段**，别去找 |
| 退出码 | `snapshot.detail` | 它也不在顶层（`exit code: N` / `signal: X` / `killed before exit`） |
| 「属于子 agent xxxx…（第 N 层）」 | 我们的 `jobOwners` | ⚠ **子 agent 起的 job 归子 agent**：只查当前会话的 `list()` 会漏掉「子 agent 在后台跑着一条长命令」，而那恰恰是最要紧的一种 |
| 子 agent：label / 一次性或可继续 / 层级 | `subagents.listDescendants` | **一次性**的子 agent **结构上不能再发消息**，所以要标出来（面板据此不画那个入口） |
| 「中断当前一轮」按钮 | `subagents.interrupt(id, {kind:'user', parentSessionId})` | 只停**当前这一轮**（会话与上下文都留着，同「停止本轮」）。`ready` 的子 agent 没有按钮 —— 它运行时里根本不存在 |
| 「这条记录本身有问题：corrupt」 | diagnostic 行 | 诊断行不许当成正常子 agent 画 |

### 为什么是轮询，而不是等推送

**这两个服务没有可订阅的「有变化」事件**：`jobs.onJobsChanged` 只在集合变化时响
（注册 / kill / settle / 拥有者销毁），**输出增长不触发**；子 agent 那边只有
`subagent/start|end` 两个粗事件（载荷里**没有 label** —— 它只在子会话日志里）。

所以面板按**节流**问（`ACTIVITY_POLL_MS = 4s`），而且**只在有东西可看时才问**：
抽屉开着、这一轮在跑、或者芯片还亮着（有东西没结束）—— 空闲时一次都不问。
宿主**不起定时器**（不像用量/进度那样在回合结束自己读一遍再广播）。

### 怎么验的（不开编辑器）

```sh
npm run verify:bridge    # 假 Editor + 假 ctx：jobs/subagents 两组服务的投影、绝不 read()、authority 形状
node scripts/preview-panel.js --serve    # 目测：?activity=empty|missing|subonly
```

`verify:bridge` 的「活动通道」那一段用**假 jobs/subagents/agents 服务**真跑控制帧，
钉住四件事：① 一次都没调 `read()`；② `list()` 带了 Agent（不带就只剩「无主 job」= 永远空白且不报错）；
③ 快照里的 `owner`（Agent 实例，过不了 IPC）没被透传；④ 中断的 authority 是
`{kind:'user', parentSessionId}`（用 `ancestor` 那支会被判越权，症状是「按钮点了没反应」）。

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
#   ⚠ 它也体检「bundles 里声明的第三方包**装没装**」（缺了给一条能直接粘的命令，
#     并以退出码 1 报出来）—— 声明了却没装 = 那一行整体加载不起来，而 profile 看起来是好的
#   ⚠ 本 profile 现在是**零第三方 bundle**（2026-12 的决定）：上面那条体检因此平时什么都不报，
#     但它**不是死代码** —— `verify-stats.js` 的 `[2c]` 用一份合成真源（假的第三方包名）在跑它

# 加第三方 bundle（先想清楚：见坑 57 —— 「声明了却没装」会让整棵树起不来）
#   dsh plugin --profile cocos add <包名>
#   （它就是 `pnpm add` 的转发器 + 按装好的状态对齐 dsh.profile.bundles；
#     加完把 dsh-profile/package.json 的 bundles 与 dependencies 一起更新，别只改一处；
#     然后**必须**同步放宽 verify-stats.js §8 / verify-profile-rows.js 里那两条「零第三方」红线）

# 改完 bridge 插件（加工具 / 改工具描述 / 改控制通道）→ 同步 + 验证
node scripts/install-profile.js && node scripts/verify-bridge.js
#   ⚠ 新增/改名工具后**必须重启 agent** 才会出现在模型手里（patchReload 不会重跑 apply()，见坑 23）

# 面板的静态契约（消息名 / 元素 id / 样式类，三处「写两遍」的地方）
#   + **@ 语法对账**（source/panels/default/mention.ts vs DSH 装的那份 grammar）—— 改 mention.ts 必跑
node scripts/verify-panel.js

# profile 行改了（cordis.patch.yml）→ ① 离线看合成结果 ② **真起一次**看服务挂上没有
dsh --profile cocos --dump-config
node scripts/verify-profile-rows.js      # 约 20 秒；会临时往 profile 里放一个探针插件，跑完自己删
#   ⚠ patch 里没写的键**不会被清掉**：要重新启用 sdk-app 关掉的行，
#     必须显式写 `disabled: false`（只写 id 是没用的）
#   ⚠ 服务只能用 `ctx.inject` 拿，`ctx.get(name)` 恒为 undefined（不报错！见坑 39）
#   ⚠ 加了第三方 bundle 之后**更要跑它**：dump-config 只证明配置合成对了，
#     证明不了那行真能加载（那一行不在我们的 patch 里，是它自己带的 patch 插的；
#     第三方插件的加载日志打的是 **stdout**，而 `[cocos-bridge]` 那些在 stderr —— 两个流都要看）
#   ⚠ 反过来，本 profile 现在是**零第三方**：这条脚本会红着告诉你「清单里有第三方 bundle」，
#     那正是提醒你去把 §8/这条红线一起改（有意的决定，不是随手能改的实现细节）

# 图片链路（主进程那半：扫目录 / 读文件 / 校验 / 筛选 / db:// 映射）——改 images.ts 后必须跑
node scripts/verify-images.js

# 回放真日志（读本工程最近的会话；只读，不启动 agent）——形状容错的哨兵
#   + **回合锚点是不是真的落在转写上**（实时/回放两条路里，只有它能验这条换算，见坑 56）
node scripts/verify-replay.js --limit 3

# 搜索 / 导出 / 删除（合成会话树跑真脚本；只碰临时目录，不读不写 $DSH_HOME）
node scripts/verify-history.js

# 用量与进度（合成投影缓存跑真读取器 + 与 dsh-token-meter 的公式、与进度那三行的**形状**对账
#   + 真跑 --dump-config 看数据源挂着 + 真缓存只读普查）
#   只对真 <DSH_HOME> 做只读抽查；改 source/stats.ts、constants 里的格式化函数、
#   面板的 progress.ts、或 DSH 升级后都要跑
node scripts/verify-stats.js
node scripts/verify-stats.js --keep       # 留着合成语料，自己翻

# 改面板样式/渲染 —— 不开编辑器就能看（真面板代码 + 真 CSS + 样例转写）
node scripts/preview-panel.js            # 生成 .tmp/panel-preview/index.html（自包含，双击就能看）
node scripts/preview-panel.js --serve    # 顺便起个静态服务并打印 URL
#   预览器开关：?theme=light|dark  ?font=12..17  ?idle=1（非运行态）
#              ?noShow=1（故意不调 show 钩子）  ?hide=毫秒（模拟 hide 误触发）
#              ?view=history|resumed（历史横幅两态）  ?click=选择器[,选择器…]（自动点，按序）
#              历史抽屉：?click=%23btn-history（开抽屉）
#                        ?hsearch=打击感（在搜索框里打字并按「搜全文」）
#                        ?hits=0（搜不到） ?partial=0（假装扫完了） ?exportfail=1 ?deletefail=1
#                        连点两个：?click=%23btn-history,%23history-list .dsh-history-item:first-child .dsh-mini-danger（看删除确认条）
#              图片：?click=%23btn-image（自动开选择器） ?failimages=1 ?readfail=1 ?scan=1
#              用量：?click=%23btn-usage（开抽屉） ?usage=none|compact|error|full ?cost=off|1|ledger|noconfig|disagree
#                    （none=还没落过检查点 compact=压缩过 error=读失败 full=占用 92% 看危险色）
#                    （cost：1=有检查点+有账本 ledger=只有账本（老会话） noconfig=读不到账本（按美元画）
#                      disagree=两处金额对不上 —— 四种状态的文案完全不同，只有这四种都看过才算验过）
#                    上下文增长：?timeline=ok|none|oldver|empty（在用量抽屉里，配 ?click=%23btn-usage）
#                    （ok=42 次调用（含一次 compaction 与连发 4 条 prune、两根估算柱）
#                      none=这一行根本不存在（本 profile 的常态）
#                      oldver=ver 不认识（面板要写出「版本是 12、只认 13」）
#                      empty=这一行在、但还没有请求记录）
#              进度：?click=%23btn-progress（开抽屉） ?progress=none|error|empty|stale|checkpoint|done|goal
#                    （stale=清单是上一轮的 empty=读过但什么都是空的 goal=只带目标）
#                    跳一轮：?click=%23btn-progress,%23progress%20.dsh-turn%5Bdata-jump%3D%22true%22%5D
#                    ⚠ `?click=#btn-progress` 里的 `#` 会被浏览器当成**片段**，必须写成 %23（踩过）
#              活动：?click=%23btn-activity（开抽屉） ?activity=empty|missing|subonly
#                    （empty=两个服务都在但都没东西 missing=服务没挂（说清是哪个）
#                      subonly=只有子 agent —— 验「块与块之间互不牵连」）
#                    点「中断当前一轮」：?click=%23btn-activity,%23activity%20.dsh-activity-stop
#              滚到底：?scroll=%23usage / ?scroll=%23progress / ?scroll=%23activity —— 三个抽屉**自己是滚动容器**
#                    （max-height:62% + overflow:auto），最底下那一块（花费 / 回合目录 / 那些说明）在页面级
#                    滚动里够不到，不开这个开关就只能靠「文本里确实有」来推布局没被撑破
#              输入触发器：?type=/compact（命令表） ?type=@assets/scripts（路径候选）
#                          ?title=0（没有标题） ?nocommands=1 ?norefs=1（两个服务不可用）
#   浏览器控制台里可以 `__dshFakePaste('image'|'noise'|'bmp'|'text')` 模拟粘贴（见「图片」一节）
#   页面顶部有自检条：getEvents/getState 计数必须持续增长 —— 这是在断言「面板自己在轮询」；
#   还带一行**量出来的高度**（root/body/hist/bar/图/选择器/弹出块，溢出会写 OVERFLOW）——
#   没有浏览器工具时，用 `chrome --headless=new --dump-dom` 抓下来读这行就够了。
#   ⚠ 改这个脚本时：`editorShim` 与 `buildHtml` 的返回值都是**模板字符串**，
#     里面**不许再出现反引号**（中文注释里包一个术语就会把整个文件写坏，见坑 35 / 43）。
#     `verify-panel.js` 现在会**扫**这两个模板替你拦这一条（写过两次才发现该机器检查）。
#   ⚠ 这两个模板里写 Windows 路径要留**四**个反斜杠（模板层吃掉两个，页面里的字符串才剩一个），
#     只写两个的话「反斜杠 + U」被当成未知转义，路径会变成 `C:Userswx...`。

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
39. **cordis 的服务只能用 `ctx.inject` 拿，`ctx.get(name)` 恒为 `undefined`**（2026-12 实测）：
    `Context.get` 的注释写的是「Read a service from the store without the inject requirement」，
    但它读的是**本 fiber 自己的 store**（只装它 inject 过的东西），不是整条上下文链。
    同一个进程里同一时刻：

    ```js
    ctx.get('tools')                          // undefined   ← 服务明明在
    ctx.inject(['tools'], (c) => c.tools)     // 服务实例
    ```

    **它不报错**，所以每一处「现用现取」都表现成「这个 profile 没挂那个服务」——
    一句听起来像配置问题的话，实际是取值方式错了（本插件踩了三次，其中 `attachments`
    那处让「继续此会话之后再贴图」在真运行时一直是坏的）。
    两条口径：① 需要服务就 `ctx.inject`，而且**一个服务一次 inject**（一次 inject 一串是"全都要"，
    少一个就整个回调不跑，能用的那个也一起废掉）；② 注入回执是**异步**的，
    启动时先 `hostService()` 预热一遍，别等第一次用到才登记。
    体检脚本 `verify-profile-rows.js` 专门盯这条，而且它**要求 `ctx.get` 继续返回 undefined**
    （哪天 DSH 改了行为，那条会红，说明这两处代码可以简化了）。
40. **`dsh-file-reference` 与 `dsh-file-reference-local` 不能同时挂**：那个 seam 包的**默认导出
    本身就是一个注册 `fileReferences` 服务的 `Service` 子类**，提供方继承它、注册的**是同一个服务名**，
    于是报 `service "fileReferences" has been registered at <FileReferenceService>` ——
    这是 **apply 阶段的硬失败，整棵树都起不来**（面板上只看到「agent 启动失败」，看不出是哪一行）。
    只挂提供方（`dsh-web-app` 的 bundle 也是这么挂的）。
    这类「配置合成了、行也在、但树起不来」的错只有**真启动一次**才看得见 —— 见坑 39 那个脚本。
41. **patch 里没写的键不会被清掉**：`applyEntryPatches` 只逐键覆盖**它自己带的键**，
    所以 sdk-app 写的 `disabled: true` **必须靠 `disabled: false` 显式关掉**，只写 `id:` 是没用的。
    验证方式：`dsh --profile cocos --dump-config`（离线，直接看合成后的行）。
42. **`preview-panel.js` 的模板字符串里不能出现反引号**（这条是坑 35 的重演，2026-12 又踩了一次）：
    改那个文件时在**中文注释里**包了个 `` `session/title` ``，整个文件当场语法错误
    （报的是 `SyntaxError: Unexpected identifier 'session'`，位置指向注释中间，看不出是注释的问题）。
    写注释一律用「」。**2026-12 第三次踩**（同一处、同样的写法）之后，`verify-panel.js` 加了断言
    直接扫那两个模板 —— 现在这条是**机器拦的**，不再靠记性。
43. **往外导的 JSONL 必须掐掉末尾半行**：会话日志是拼接帧，最后那一帧随时可能是**没写完的**
    （进程被 kill / 正在写）。`decodeAll` 会尽力解出它，于是原文末尾留着一截
    `{"type":"user/mess`。把它原样写进 `.jsonl` 的后果是**每一个消费方都在最后一步炸**
    （实测：拿它逐行 `JSON.parse` 的校验脚本当场 `Unterminated string`）。
    导出前 `dropTornTail` 掉那些解析不出来的尾行 —— 缺的本来就是一个没写完的事件。
44. **`search` 的「不折平大小写」这条优化差点变成假阴性**：预筛（不解析 JSON、直接对整份文本做子串
    判断）为了省一次几十 MB 的小写复制，原本按「查询里有没有大写字母」决定要不要折平 —— 但
    `queryTerms` 已经把词**全小写**了，于是条件恒为假。症状是**查 `ctx.tick` 找不到写着 `ctx.Tick`
    的会话**（反过来查 `CTX.TICK` 因为折平了反而能找到，所以肉眼看着像"偶尔搜不到"）。
    判据只能看**原始查询串**：`query !== query.toLowerCase() || /[a-z]/.test(query)`。
    这个是合成语料（`verify-history.js`）当场抓出来的 —— 真日志里没有刚好能区分两者的样本。
45. **合成语料里验「按时间排序」必须显式写 mtime**：四个目录是在同一毫秒级里造出来的，
    靠写入顺序定序是碰运气（第一版断言就是这么红的）。`utimesSync` 显式给时间戳，
    断言才能钉住「最新在前」。
46. **`turn/end` 那一刻读投影缓存，可能读到「上一拍」的账**：检查点确实在 `turn/end` 写，
    但那是 **agent 进程里**的监听器干的活，与推到主进程的 `session/event` 通知是**两条路**，
    谁先到没有保证。用量数字通常不受影响（它不随 `turn/end` 变），但 `sessionStats.turns`
    会少一个回合，看着就像「回合数不对」。所以读的时候**等一拍**（`USAGE_REFRESH_DELAY_MS = 700`），
    并且面板上如实显示水位与落后条数 —— **这类「可能差一点」的事不要靠猜，要显示出来**。
47. **`contextBreakdown` 三行加起来和占用率对不上，而且能差 25 倍**：本机真记录里
    `system 1769 + tools 10763 + messages 3864 = 14301`，而同一条记录的
    `projectedTokens` 是 96676。原因是两个数**不是同一个口径**：`projected` 是
    「provider 实测样本 + surface 的带符号位移」，而组成是按「四字符一个 token」估的
    （中文与 JSON schema 低估得很厉害）。上游 README 明说「present them as an approximate
    composition, never as a total」—— 所以面板上它**单独一块、标着「估算」、不参与**那条占用条。
    把两者堆成一根堆叠条就是在用一个假总数骗人。
48. **占用率必须用「预估」而不是「上一次实测」**：`pressureTokens` 是 prompt 侧的**上一次**
    实测，流式期间不动，而且**压缩之后会偏高**。本机真数据：`pressure 273437` vs
    `projected 96676`（2.8 倍）。上游为此维护了一个 surface 总数并发布 `projectedTokens`，
    公式是 `max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)` ——
    **照抄**，并且在 `verify-stats.js` 里对着上游源码钉住。另外：`surface < sampledSurface`
    就是「这份记录之后上下文被压缩过」，面板要**主动说出来**，否则用户会以为占用率凭空掉了一大截。
49. **验证脚本里临时改 `DSH_HOME`，别忘了那之后别人也要用它**：`verify-stats.js` 为了造语料
    把 `process.env.DSH_HOME` 指到临时目录 —— 于是后面「真跑 `dsh --profile cocos --dump-config`」
    与「真缓存抽查」全都跑到了一个**不存在 profile 的空家**里（症状：dump-config 静默 exit 1、
    抽查读到了自己刚写的坏 JSON 样本）。真家的路径必须在**改之前**就存下来，并且 spawn 时
    显式带上 `env: {…, DSH_HOME: realHome}`。
50. **`preview-panel.js` 的假数据也要分「有」和「没有」两种**：用量那一块真 cocos profile
    **没有花费**（`costUsage` 是 web 那边挂的），所以样本的默认状态就是 `cost: null` ——
    想看有花费的样子得显式加 `?cost=1`。否则「花费那行长什么样」永远没人验，
    而它恰好是最容易写成「显示 0」的那一行。
51. **投影缓存里存的是投影的「状态」，不是客户端的「wire view」**（2026-12，做进度时踩到）：
    同一个键的这两种形状**经常同形**（用量那几行就是，所以一直没暴露），但**不同形的地方一读就空**：
    `turnOutline` 的状态是 `{turns, draft}`、wire view 是 `turns` 那个**数组本身**；`goal` 的状态多一层
    `current`（view 是 `state.current`）。照 wire view 读**不会报错**，只会「一条都读不到」——
    表现出来就是「这个会话没有清单 / 没有回合」，而真数据里有 88 份带清单、450 份带大纲。
    所以 `verify-stats.js` 直接盯上游源码里的 `view: state => state.turns` / `view: (state) => state.current`。
    另一半：`contextPressure` 的状态里**没有** `projectedTokens`（那是 view 现算的），
    这正是「占用率必须照抄上游公式自己算」的**根本原因**（不是我们偷懒）。
52. **「上一轮的清单」这件事必须在面板上说出口**（2026-12）：`dsh-tool-todo` 的投影在
    **每一次 `turn/start` 把 `todos` 归零**（源码里一行 `if (event.type === "turn/start") return null;`）。
    于是本轮 agent 还没写新表时，投影的值是 `null`，而面板手里还攥着上一轮那份 ——
    不标出来的话，那颗 chip 会平静地写「待办 3/8」，用户以为那就是现在在做的事。
    口径：**旧表照画（藏起来会像 bug），但 chip 上加「（上一轮）」、清单下加一句说清楚**，
    并且这句判据（`stale` = 清单所属轮次 < 当前轮次）由宿主算，面板不自己推。
53. **两套编号必须换算一次，否则「能看不能点」**：回合大纲给的 `seq` 是**会话事件序号**
    （上游文档说它就是「往回翻页的目标」），而面板的转写条目号是**宿主自己的计数器**（`++this.seq`）——
    两者毫不相干。宿主在 `turn/start` 到的那一刻记下「**下一条上屏的条目**会是几号」
    （`markTurnStart` 记待绑、`append` 里 `bindTurnAnchor` 绑上），这才是能跳的锚点。
    顺带：那一轮已经被 `MAX_ENTRIES`（600）挤掉时锚点给 `null`，面板把它画成**点不动的行**并写明原因 ——
    `jumpTo` 那条老路在找不到元素时是**静默返回**的（它服务于「搜全文命中」，主进程那时已经提示过了），
    主动点的这条路不能复用那个静默行为。
54. **面板源码是「一个目录」不是一个文件**（2026-12，`verify-panel.js` 的假失败）：
    纯函数那几块（`mention.ts` / `progress.ts`）是**独立模块**（它们要能单独 `require` 出来跑已知答案），
    所以「面板源码」得把 `source/panels/default/*.ts` 拼起来再扫 —— 只读 `index.ts` 的话，
    凡是搬进模块里的东西都会报成「找不到」，而那是**测试写错了**，不是面板写错了。
    同一个坑的另一半：新增的面板模块还要记得喂给 `preview-panel.js`（`files` 表 + `__dshLoad`），
    否则预览里一点开就是「预览器没有这个模块：./progress」。
55. **`?click=#btn-progress` 里的 `#` 会被浏览器当成 URL 片段**（踩过）：`location.search` 里只剩 `?click=`，
    于是「自动点一下」静默不生效（截图里看就是「点了没反应」，很容易怀疑到面板代码）。
    必须写成 `?click=%23btn-progress`。
56. **回放用的那份日志投影是按白名单筛事件的，新事件类型会被静默丢掉**（2026-12，`verify-replay.js` 抓到的）：
    `session-log.js` 的 `KEPT_TYPES` 决定「哪些事件进回放流」，而实时那条路（SDK 的 `session.event`）
    **不筛**。于是「实时能做、回放做不到」这种**只在历史会话上出现**的偏差就来了 ——
    做进度时踩的正是这个：`turn/start` / `todo/write` / `goal/change` 都不在白名单里，
    所以回放一条历史会话时**一条回合锚点都绑不出来**（回合目录整列能看不能点），
    清单与目标也只能靠检查点兜底。**症状是「实时好好的，翻历史就残」**，而这类偏差在
    编辑器里点两下是看不出来的（新会话都是实时那条路）。
    口径：给面板加任何一个「实时事件 → 界面」的映射时，**顺手回头看 `KEPT_TYPES` 一眼**；
    现在 `verify-replay.js` 有一条断言盯着「真日志回放后确实绑出过锚点、且锚点都在转写里」。
57. **「声明了」不等于「装了」——而症状是功能整体消失、`dump-config` 还看不出来**（2026-12 挂
    `dsh-cost-meter` 时收紧的，那条依赖后来被**刻意撤掉**了，机制留着）：
    `dsh.profile.bundles` 里的名字靠**profile 自己的 `node_modules`** 解析。声明了却没装（或者只改了
    `bundles` 没写进 `dependencies`，被 pnpm 下一次 install 清掉）时，`--dump-config` 里那一行
    **照样出现**，但插件加载不起来 —— 具体到 cost-meter 就是「花费」永远显示「没有花费记录」，
    而那句理由看起来还挺合理。**比这更狠的是**：DSH 的 `resolveBundleDir` 解析不到 bundle 时
    **直接抛**（`loadProfile` 就是 `bundles.map(...)`）⇒ 整棵树起不来。四条防线：
    `install-profile.js` 每次加载体检声明的依赖、把解析不到的那一行从**装出去的那份**清单里摘掉
    （真源留着意图，`dsh plugin --profile cocos install` 才有东西可装）、并以退出码 1 报缺；
    `verify-stats.js` 的 `[2c]` 用**合成真源**真跑一遍这套摘除 + 自愈；`[8]` 与
    `verify-profile-rows.js` 各有一条红线盯着「真源里零第三方 bundle」（这是**有意的决定**：
    2026-12 起我们不要这个取舍 —— 「少一块功能」比「整棵树起不来」便宜太多）。
58. **第三方插件的加载日志打在 stdout 上**（2026-12 实测；当时挂的正是 `dsh-cost-meter`）：
    它 `apply()` 的第一行是 `console.log`，而 stdout 是**SDK 协议的地盘**
    （`[cocos-bridge]` 那些日志用的是 stderr）。第一次写断言时只 grep 了 stderr，于是
    「明明挂上了」被判成没挂。两件事都要记住：① 验任何 bundle 的加载都要**两个流都看**
    （`verify-profile-rows.js` 现在两个流一起扫）；② stdout 上出现杂质行是**常态**
    （`sdk-client.ts` 的「跳过并计数」就是为它写的，计数会暴露在状态里）。
59. **花费要读两个文件，而且「没金额」的时候不许再说显示口径**（2026-12，目测抓到的）：
    金额在投影缓存里（**美元**入账），显示币种/汇率/小数位在 `cost-meter` 的账本里 ——
    只读一个文件的画法必然是错的（要么永远 `$`、要么自己猜一个汇率）。另一半更隐蔽：
    没有金额、也没有原因时，那句「上面显示的是账本原值（美元）」会**指着一片空白**
    （它上面只有「没有花费记录」）。所以判据的顺序是**先判有没有金额，再谈怎么显示钱**；
    `verify-panel.js` 里有一条断言专门盯着它（`costTextOf({...全 null})` 必须一句话都不说）。
60. **面板文案里混进 markdown 的 `**` 会被原样画出来**（第三次踩，终于变成机器检查）：
    面板一律 `textContent` 写入（不解析 markdown），而这句话常常是**从注释里复制**过来的
    （注释里加粗是合理的），于是 `**本轮还没写清单**` 在两个星号中间显示。现在
    `verify-panel.js` 扫 `source/panels/default/*.ts` 里所有单引号字符串，
    唯一豁免是 `markdown.ts`（它自己就是那个渲染器）。
61. **两个日志文件并存时，「版本号优先」这条判断是反的**（2026-12 修的真 bug）：
    旧实现在会话目录里挑日志时写的是「版本化的（`session.v4.jsonl.zstd`）优先，其次最新的」——
    而事实相反：**当前格式的版本号是 `0`**（`SESSION_FORMAT_VERSION = 0`），物理名**恒为**
    `session.jsonl.zstd`（DSH 自己的 `findLog` 只认这个精确名），**带 `.vN` 的才是更老的一代残留**。
    真实反例（`session-1aba7f97-…`）：两个文件并存，当前格式 **14381 行 / 末行 seq 387154**、
    残留 **3090 行 / seq 3088** ⇒ 旧逻辑挑了残留，于是**面板对这条会话只显示 1/5 的内容**，
    标题、全文搜索、导出**全部基于过期快照**，而且**不报任何错**。
    现在的顺序是「**精确名 → 精确名（未压缩）→ 版本化残留（按 mtime）**」，
    并把**被忽略的残留**如实带出去（列表里那句「盘上还有一份更旧的」）。
    `verify-history.js` 用一份夹具钉住它（把残留的 mtime 故意设成**更新**，
    所以「按 mtime 取最新」这条错路也一起被拦住）。
62. **job 的输出是「消费型」的，面板读一次就把模型的工具废掉**（2026-12 做活动抽屉时定下的）：
    每个后台任务只有**一个消费游标**（`dsh-jobs` 的类型注释原话：*"each job has one consuming
    cursor"*），`read()` 一调就把游标推走 ⇒ 模型下一次 `job_output` 只会拿到 `(no new output)`。
    所以插件**只用 `list()` / `get()`**（`get()` 的契约明写 "without changing its read cursor"），
    面板上也**如实写「看不到输出」**。`verify-bridge.js` 里有一条断言专门盯着这件事
    （假服务暴露一个会记账的 `read()`，断言它**一次都没被调用**）——
    这类"为了多显示几行而废掉主功能"的改动，靠人自觉是拦不住的。
63. **回收附件的全库扫描必须排除「即将被删的那条日志」**（2026-12，实现时才想到）：
    判据是「**这条会话引用过** ∧ **全库都没人再引用**」—— 而「全库」里**包含**马上要删的这条，
    于是它自己就把那些 id 引用着 ⇒ **交集恒为空**，功能看起来"跑了、什么都没找到"。
    同类必须一起做的三件事：① **超预算就一条都不搬**（判据不全时的"顺手删"是不可逆的误删）；
    ② 每个候选**复算 sha256 + 核对字节数**；③ **搬墓碑而不是 unlink**（并且**不提供 `--purge`**）。
    背景是一条硬事实：附件**跨会话共享、永不重建**（DSH 官方 README：*"Images are kept forever …
    nothing collects unreferenced objects"*），所以这里任何 bug 都是**永久丢图**。

64. **编辑器构建里引擎「不注册 DOM 监听」——所以合成点击/按键到不了引擎**（2026-11 真机验收，
    这是那批工具在真机上失效的**根因**）：`pal/input/web/mouse-input.ts` 里写着
    `// In Editor, we receive mouse event from manually event dispatching.` + `if (!EDITOR) { this._registerEvent(); }`
    —— 编辑器构建**根本不给 canvas 挂 `mousedown`**，真人的点击是**编辑器自己手动转发**进引擎的
    （原生场景视图就是这么接的：`preload/native/native-scene.js` 里那张
    `{"mouse-down":"_dispatchMouseDownEvent", …}` 表）。实测现象：`sendInputEvent` 确实到了那一页
    （`target`/`matchedBy`/`window.focused` 三项全对），全屏拦截节点却 **0 条**；连页面里自己
    `dispatchEvent` 也不进引擎。**换路**：引擎给编辑器留了六个口子
    （`cc.input._dispatchMouseDownEvent` / `_dispatchMouseMoveEvent` / `_dispatchMouseUpEvent` /
    `_dispatchMouseScrollEvent` / `_dispatchKeyboardDownEvent` / `_dispatchKeyboardUpEvent`，
    `cocos/input/input.ts` 的注释原话 *"exposed for Editor Only"*）。
    **✅ 第 2 轮真机验收把这条路证成了**（`真机验收2-结果.md`）：六个口子全在、全屏探针收到了
    `touch-start`/`touch-end`、两点差值 ÷ `Δclient` **逐位等于 `scaleX`/`scaleY`**、画布外的点
    **0 命中**（反面对照成立）—— 坐标就是**页面 CSS 像素**（引擎的公式是 `clientX - canvasRect.x`）。
    剩下的是接线（`transport: 'engine' | 'page'` + 加速键名 → DOM `code` 的映射）。
    **验收记录**：`docs/真机验收-结果.md` 与 `docs/真机验收2-结果.md`（原文，未删改）。
65. **运行态判不出来：facade 那两条在预览跑着的时候仍然是 `general`**（2026-11 真机实测）：
    `SceneFacadeManager.getCurrentFacade().modeName` 与 `queryMode()` 都回 `"general"`、
    `globalThis.isPreviewProcess` 恒 `false` —— 于是 `readSceneMode` 认出的 `mode`/`running`
    **恒为编辑态**，连带三条设计一起失效：`view:"game"`、运行态不裁节点、
    **运行态拒绝按节点点**（这条拒绝**从来没触发过**）。真机上唯一会变的是
    `cce.PreviewPlay._state`（`stop`/`play`/`pause`）—— 它是**私有字段**（d.ts 里只有 `isPause()` 公开），
    所以口径是：**读它、原样报出、读不到就回退并明说"这条判据不可信"**（不许安静地猜）。
66. **`PreviewPlay` 那两条 scene 消息在真机上都不好用 —— 而现在**整条开关都撤掉了**（2026-10-08）**：
    **历史实测**（2026-11，两轮把顺序改过一次）：第 1 轮 `request('editor-preview-set-play', true)` **120s 不回执**、
    `call-method('pause', true)` **抛** `Cannot read properties of undefined (reading 'setAttribute')`、
    `step`/`resume` 回 `true` 而**一帧不动**、`set-play(false)` 回 `false` 而**预览仍在跑**。
    第 2 轮更彻底：**`send` 那条消息连副作用都没有**（30s 五次采样 `_state` 一直是 `stop`），
    而**直调 `cce.PreviewPlay`** 五个动作**全部生效**（`start()` 3s 起来、`pause` 后 1.5s `frames` **+0**、
    `step` **恰好 +1 帧**）；**工具栏那颗按钮的 `isPlay` 靠这条消息的「回执」更新**
    （`builtin/preview/static/toolbar/middle.js`），而它**从不回执** ⇒ 走哪条路工具栏都同步不了。
    所以当时的结论是"直调优先、消息兜底，判据只有状态（`applied.by` 点名走了哪条）"。
    ⛔ **2026-10-08 之后这五个动作全部删除**（坑 70）：`cocos_runtime` 只剩只读的 `state`，
    上面这些"哪条路通"的知识**只作为历史记录**留在 `docs/真机验收-结果.md` / `docs/真机验收2-结果.md` 里。
    另外两条仍有用的：`stop()` 之后 `director`/`game` **同时被留在 paused**（两轮各复现）；
    **重起预览会重载运行场景**，运行期挂的节点（探针）随之消失。
67. **`open-scene` 传 `db://` 路径不是"打开那个场景"**（2026-11 实测）：它会开出一个**新的未命名 2D 场景**
    （`query-node-tree` 的根变成 `scene-2d` 且**根 uuid 每次都不同**，磁盘上文件 mtime 不变），
    而且**不报错** —— 接着往下做就是在错误的（空的）场景里改东西。传**资源 uuid** 才是开它。
    提示位已经写进 `cocos_editor_state` 的「下一步」，见 skill 的「坑 15」。
68. **`capturePage()` 抓到的可能是**旧帧**，而"空图才逼重绘"这条兜不住它**（2026-11 实测）：
    预览跑过之后连抓三次截图**字节完全相同**（41223），画面还是上一段预览的最后一帧，
    而同一时刻 `framing` 报的相机与内容包围盒**都已经回到编辑态** —— 也就是"图是旧的、量是新的"，
    这种组合最容易让人得出错误结论。**判据**：改一处**可见**的东西（挪个节点）再截一次，字节没变就是旧的。
    ⚠ 这条**曾经**的修法是"抓图前一律先 `invalidate()` 排一次重绘"，然后改成"要了才排"，
    **2026-10-08 起连那个开关都撤了**（本扩展一处 `invalidate()` 都不调）—— 见坑 69 / 坑 70。
69. **⚠ 凡是"碰合成器"的动作都有代价：之后「场景」面板的画面会停住 / 黑掉，只能重启编辑器**
    （2026-10-08 两次真机现场）：
    - **第一次（04:48，R6）**：全流程里两次抓图（回执 `forcedRepaint: true`）之后，**场景面板画面停住** ——
      切到别的场景也不更新，**只有重启编辑器才恢复**（点窗口置顶 / 最小化还原 / 拖分隔条 / 关掉再打开场景面板
      **都试过，没用**）。同一时刻引擎侧**完全健康**：帧计数 2 秒 **+119**（≈59fps，从编辑器启动起一帧没少）、
      `gamePaused`/`directorPaused` 都是 `false`、编辑器相机 `Editor Camera` `active+enabled`、
      `document.visibilityState: visible`、引擎里装着 `Main` —— 而画布上还是**切场景之前**那一帧。
      ⇒ **画面停在这一层（那一页的呈递），不在引擎里**。完整判定与逐字回执见 `docs/冻结诊断.md` §5。
    - **第二次（14:59，面板 agent 加 `Cmp_Game` 那次）**：同一块画布抓回来的是**一张全空的图**
      （`blankRatio: 0.988`，用户看到的就是**黑屏**）。这次会话里既跑过 `cocos_runtime({action:'play'})`
      （14:53:44，`cce.PreviewPlay.start()`，游戏卡在首场景 `Loading` 的 `loadBundle('scripts')` 0%），
      也做过带重绘的抓图。
    - **两个候选，因果仍未单变量证实**：① Chromium 把这一页的呈递停了（与本扩展无关）；
      ② 我们**碰合成器**的那两类操作（抓图前 `invalidate()` 逼重绘 **与** 从编辑器内部开关运行预览）。
      **按代价不对称做的取舍：两条都整体撤掉**（见坑 70）—— 能做的是"把发生的条件撤掉"，不是"修好了"。
    - ⚠ **顺带记一条"改动没生效"的坑**：第一次事故之后把 `invalidate()` 改成 **opt-in**
      （`forceRepaint` 默认 `false`），**这一改在那次会话里根本没生效** —— 当时编辑器跑的仍是**旧构建**
      （14:59 的回执里 `forcedRepaint: true`，而只有旧实现才恒报 `true`：dist 在 05:16 才重建，
      而编辑器 05:14 重启时已经把旧模块装进了 require 缓存）。
      ⇒ **教训**：靠"一个默认值"关掉危险动作是**不可验证的**。要么不做（现在的口径），要么在同一句里
      把"生效判据"钉进回执（现在：回执里连这两格字段都没有了）。
    - **恢复配方**（人来做，只有第 3 步管用）：`Ctrl+S` → 重启编辑器。场景数据不会丢（R6 收尾 `query-dirty: false`）。
70. **⛔ 运行预览的开关（`play`/`stop`/`pause`/`resume`/`step`）已整体撤掉**（2026-10-08）：
    `cocos_runtime` 只剩**只读**的 `state`。三条理由：
    ① 那五个动作**换掉那块画布的渲染相机**（`PreviewPlay.start()` 藏编辑器相机、`stop()` 还回来），
    是"我们主动改过用户眼前那块画布"的少数几个动作之一，且与坑 69 的两次现场**同一条时间线**；
    ② 留着它，"是谁把画面弄停的"永远说不清（重启之后没法复盘）；撤掉之后只剩"环境 / Chromium"一类解释；
    ③ **在本工程里它本来就没用** —— 编辑器内跑起来会卡在首场景 `Loading` 的 `loadBundle('scripts')`
    （进度 `0%`，既不成功也不失败；`cc.assetManager.bundles` 里只有 `internal`），也就是**进不了游戏**。
    落地：`source/preview.ts` 砍到只剩 `querySceneMode()`、`source/scene.ts` 删 `runtimeControl`、
    `package.json` 的 `contributions.scene.methods` 去掉 `runtimeControl`、bridge 的 action 白名单只剩 `state`、
    `cocos-tools.ts` 的非 `state` 一律拒绝并说明原因。
    判据由 `verify-skill-facts.js` 的 `preview-control-removed`（四个入口挨个点名）+
    `verify-cocos-engine.js` 的 9g 段（五个动作零副作用地被拒）钉住。
    ⚠ **要生效必须重启编辑器**（扩展改动没有热重载，见「已知限制」）。

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
- **用量的四条限制**（都是「如实显示」而不是「藏起来」）：
  - **它是检查点，不是实时流**：数字最多落后「200 条事件或 5 秒」（本 profile 的节流配置），
    抽屉头部会把**实际**落后条数写出来。想要刚读的，点抽屉里的「刷新」。
  - **花费那一行来自一个第三方插件，而本 profile 刻意不挂它**（`dsh-profile/package.json`
    里零第三方 bundle，理由见「花费」一节）：所以**新会话不会有花费**，面板会明说
    「本 profile 刻意不挂它」并给出加回来的命令。挂着它跑过的会话（含 2026-12 之前那批）
    检查点里**已经有** `costUsage`，面板照旧画；**两个来源对不上时也会写出来**
    （账本按调用当时的价表、检查点按当前价表重算）。
  - **账本是这台机器共享的**：所以「今日」那一行是**所有工程、所有 profile** 加起来的一天，
    标签里写着「全部工程」。想只看本工程，得自己去 `ledger.json` 的 `days[*].sessions[]` 里挑。
  - **「上下文组成」是估算**，与占用率不是一个口径、加起来对不上（见坑 47）；它只用来比相对大小。
  - 另：**历史会话（只读回放）也能看用量** —— 主进程读的是「面板正看着的那条会话」的记录，
    但那条路径没有实时水位，所以头部会写「没有实时水位可比」而不是编一个「落后 0 条」。
- **进度的四条限制**（同样是「如实显示」而不是「藏起来」）：
  - **清单每一轮都会被 DSH 归零**：本轮 agent 还没写新表时，面板上那份属于**上一轮**
    （chip 写「（上一轮）」、抽屉里有一句说清楚）。这是 DSH 的投影口径，不是我们的 bug（见坑 52）。
  - **回合目录是缓存的，转写是窗口**：目录来自**整个日志**（几百轮也在），而面板只留最近 600 条条目 ——
    所以靠前的轮次**只有摘要、点不动**，点了会明说原因。想跳就只能跳到还在窗口里的那几轮。
  - **清单那一块最新、目标与目录那一块最多落后 5 秒**：前者走实时事件，后者走检查点。
    抽屉头部把「哪一块是哪来的」写出来（不说的话用户会以为三块一样新）。
  - **没有「计划面板」**：`dsh-plan-mode` 的 `plan/mode` 事件在事件表里，但本机 491 份记录里
    `plan.active` **一次都没 true** —— 所以「计划」这块**没有数据可画**，做出来就是空壳。
    `verify-stats.js` 有一条断言盯着这件事，哪天有人开始用 plan 模式它就会红。
  - 另外两块**查过、确认做不了**（不是没做）：**后台任务（jobs）** 不在这份缓存里，也没有对应的事件
    （它们只活在运行时进程的 `ctx.jobs` 里，要读得让 bridge 插件多发一条控制帧 —— 那是另一轮的事）；
    **子 agent** 在缓存里只有一个 `{identity:{mode, seq}}`，真正的描述符（label / model）是写在**子会话自己**
    的日志里的，父会话只看到 `subagent.started/finished` 两条 note。
- **执行能力是自带的，但 scene 侧要有打开的场景**：`cocos_execute_code({context:'scene'})`、
  `cocos_capture_view`、`cocos_describe_api({context:'scene'})` 都靠场景进程里加载的本扩展脚本
  （`dist/scene.js`，由 `contributions.scene` 注册）。没开场景时它们会回一句「先打开一个场景」
  并把 `cocos_editor_state` 的能力行标成「只读得动编辑器」，而不是崩掉。
  editor 上下文（`context:'editor'`）不受影响，随时可用。
- **曾经的 `dfan_mcp2` 依赖已解除**：沙箱、场景脚本、recipe 全在 `source/core/` 与 `source/scene.ts`。
  那个扩展可以关掉/删掉；`scripts/verify-cocos-engine.js` 里有一条断言专门盯着「工具回执里不许再提 dfan」。
- **recipe 存 `.dsh-mcp/`**（旧目录 `.dfan-mcp/` 不读）：`saveRecipe` 有复用门禁，
  「跑通了」不等于「值得存」—— 见「工具面与能力的来源」一节。
- **面板还没做**：计划面板、跨工程会话列表（现在只列当前工程）。
  历史回放是只读的（要接着聊得点「继续此会话」）。
  ✅ 已补：**模型提问 / 授权请求 / 计划评审**（见「交互」一节，2026-12）——这三条以前是
  「结构性做不到」，不是「没做 UI」。
  ✅ 已补：**斜杠命令（`/`）与 `@` 路径引用**（见「输入触发器」一节，2026-12）与**会话标题**
  （同一节）——这三条同样是「宿主里一直有、只是没人接过来」。
  ✅ 已补：**历史会话的搜索 / 导出 / 删除**（见「历史会话」一节，2026-12）与「搜到了就跳到那一条」。
  ✅ 已补：**token / 上下文用量**（见「会话用量」一节，2026-12）与**待办清单 / 目标 / 回合目录**
  （见「进度」一节，同一轮）——后者的三块里有两块（清单、目标）走的是**实时事件**，
  所以「agent 现在做到哪一步」是即时可见的，不必等检查点。
  ⛔ **决定不做：花费不自己实现**（2026-12）—— 「花费」这一行由**第三方**插件
  `dsh-cost-meter` 注册（金额在投影缓存里、显示币种在它自己的账本里）。读取器与面板那两块
  **照旧全功能**（挂过它的会话照常画），但**本 profile 不再挂它**：
  `dsh-profile/package.json` 的 `bundles` 里只有两个 in-box 的 `@deepseek-ai/*`，
  `dependencies` 是空的。理由是「声明了却没装 ⇒ 整棵树起不来」这个代价太大
  （`resolveBundleDir` 直接抛，面板上只有一句「agent 启动失败」）。
  代价是**新会话看不到花费**，面板会明说这是本 profile 的选择 + 给一条加回来的命令。
  还差的：**搜索有预算**（可能只扫了一部分，界面上会说出来）。
  ✅ 已补：**导出含子会话 + 删除回收附件**（见「导出 ZIP / 回收附件」一节，2026-12）——
  两条都**不再依赖 DSH 那个包**：ZIP 的布局是照它的规格自己实现的
  （`scripts/zip.js` 零依赖，`session.jsonl` + `subagents/<id>/session.jsonl` + `media/<hex>.<ext>`），
  回收则是**新增能力**（DSH 自己**从不删会话**、也从不回收附件）。
  ⚠ 两个「偏离」与三条「必须说出来」的口径（活跃会话可能少最后几条 / 子孙里 subagent 与 fork 分开报 /
  超预算一个都不搬）都在那一节里，别在别处重新描述一遍。
  ✅ 已补：**jobs / 子 agent 的专门面板**（见「活动」一节，2026-12）—— 改的正是 bridge 插件
  （`jobs/list` / `subagents/list` / `subagents/interrupt` 三个控制方法）。
  ✅ 已补（但**注册者是第三方、本 profile 不挂**）：**上下文增长曲线**（见「上下文增长曲线」
  一节，2026-12）—— `contextTimeline` 那一行由第三方 `dsh-context` 注册，所以与「花费」
  同一套处理：读取器与面板**全功能**（挂过它的 profile 跑的会话照常画），
  本 profile 不挂它 ⇒ 面板明说「本 profile 不挂它，只有 web/desktop profile 跑的会话才有」。
  ⚠ 本机 499 份缓存里 **472 份带这一行** —— 别把「本 profile 不挂」误读成「这台机器上没有」：
  缓存目录是整个 `DSH_HOME` 共享的，那些是别的 profile 跑的会话。
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
