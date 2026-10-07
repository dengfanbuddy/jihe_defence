# 对照：`hhhh124hhhh/cocos-extensions`（"Cocos MCP Stack"）vs 本工程的 `dsh_chat`

> 分析对象 = `https://github.com/hhhh124hhhh/cocos-extensions`（MIT，24 commits，最新一版 0.5.0）。
> 本地只读副本：`.tmp/cocos-extensions/`（不属于工程的一部分，可直接删）。
> 本文件里的每条事实都带 `文件:行号`；**没读到的一律写"未见"**，不推测。
> **借用口径（2026-11 追加）**：借的必须是**能力**，不能是**业务** —— 判据与实测见 §4.0。

---

## 0. 一句话结论

**两边不在同一层，所以"谁强"这个问题问错了。**

- 他们是**能力服务器**：一个装在编辑器里的 HTTP MCP Server（`:8765`，`core` 38 / `full` 106 个细粒度工具），
  任何支持 MCP 的客户端（Claude Code / Cursor / Codex / Trae…）都能连；dsh 只是其中一个客户端，
  靠一个 14 行的 patch 把 `mcp__cocos__*` 挂进来。编辑器里的"聊天面板"是一层
  **iframe 套 dsh web（`:3080`）**。
- 我们是**客户端替换**：`dsh_chat` 在编辑器主进程里 `fork` 一个独立 dsh profile，
  面板自己画（380~640px），工具走 fork IPC 的原生注册——**零端口、零 HTTP、不经过 MCP**。

**值得借鉴的是他们"编辑器能力面"里的五件我们真没有的东西**（日志、预览截图、输入模拟、预制件引用体检、
工具结果的 `refs`），不是他们的架构。反过来，我们手里有三件他们没有的：真隔离（vm 沙箱）、
真门禁（8 个 verify / 11k 行）、以及"客户端那一半"的完整能力（审批/提问/计划评审/斜杠命令/history/用量）。

**外加一条本次明确的口径**：上面那五件之所以值得借，是因为它们都是**与业务无关的通用能力**
（读日志 / 截图 / 发输入 / 取引用清单 / 抽 uuid），不是我方业务的搬运。凡是要把业务知识
（表名、节点名、预制件路径、阈值判据）写进扩展层的，一律改写或剔除 —— 见 §4.0。

---

## 1. 两边的构成（事实）

### 1.1 他们（3 个组件 + 安装器）

| 组件 | 角色 | 事实锚点 |
|---|---|---|
| `cocos-mcp-bridge` | Cocos 编辑器扩展 + **内嵌 HTTP MCP Server**（`:8765`），并自带 4 个面板 | `cocos-mcp-bridge/package.json:9`（`main: browser.js`）、`:60-103`（4 个 panel）、`lib/server.js:10`（协议版本 `2025-11-25`） |
| `cocos-codely` | dsh 客户端 bundle = **纯"电话线"** | `cocos-codely/package.json` 只有 `dsh.bundle.patch` 一个 dsh 字段；`dsh-cocos-mount.patch.yml:2-14` 插一行 `@deepseek-ai/dsh-mcp-client`（`streamable-http` → `127.0.0.1:8765`，`toolCallTimeoutMs: 120000`，reconnect 10 次） |
| `agent-presets/` | 8 个角色预设（队长 + 7 角色），配第三方 `@nanmicoder/dsh-agent-teams` | `agent-presets/cocos-game-studio/agent.cordis.yml:32-47`（`agent_teams_*` 六步 + role→preset 映射表） |
| `install-cocos-stack.mjs` | 幂等安装器（copy 覆盖 + junction + profile bundles 校准） | `install-cocos-stack.mjs:161-219` |

工具面：**22 个分类**（`docs/TOOLS.md` 的 `### ` 段），`core` 只暴露高频 38 个，
`full` 全量 106 个，另有 `custom`（按分类/工具名增删）+ **命名 profile 存/取/导出/导入**
（`lib/tool-profiles.js:34-143`）。
主工具是 `execute_javascript`（`context: scene | editor`），其余全是围绕它的"专用工具"。

### 1.2 我们

| 项 | 事实 |
|---|---|
| 工具面 | **正好 4 个**：`cocos_execute_code` / `cocos_capture_view` / `cocos_editor_state` / `cocos_describe_api`（`dsh-profile/plugin/dsh-cocos-bridge/index.js:1499-1659`） |
| 传输 | 模型↔宿主走 SDK stdio，宿主↔编辑器走 fork IPC 自带的那条 fd（`README.md:21-26`） |
| 面板 | 自绘（零依赖纯 DOM + 从 DSH 抽的 `--dsw-*` token）；**明确否掉了 iframe 方案**（`README.md:30-37`） |
| 编辑器执行 | editor 上下文 = `vm.createContext` 沙箱（`source/core/engine.ts`）；scene 上下文 = 场景脚本（`source/scene.ts`，184KB，助手 `eachNode/tree/nodeByPath/dump/snapshot/worldRect/contentBounds/captureView/pick/labelFit/snapshotTree/diffTree/loadFrame`） |
| 面板块 | 对话 / 工具卡片 / 交互卡（提问·授权·计划评审）/ history（搜索·导出·删除）/ 用量·进度·活动三个抽屉 / 图片 / 斜杠命令 + `@` 引用 |
| 门禁 | 8 个 verify 脚本（`package.json:17`），共 **11,405 行**；skill 有 `<!-- fact: -->` 锚点门禁 |

---

## 2. 逐项对照

| 维度 | 他们 | 我们 | 谁更稳 |
|---|---|---|---|
| **接入方式** | HTTP MCP（厂商无关；但 MCP 工具在**会话初始化时**注册 ⇒ "先起 8765 再开 dsh"这条时序坑，`QUICKSTART.md:35`） | fork IPC（只有本插件能用；换端口/重连这类问题不存在） | 各有取舍；我们是"专用"，他们是"通用" |
| **代码执行隔离** | `new AsyncFunction(...)` 直接跑，注入 `require/cc/Editor/scene/director/args`（`scene.js:31,590`；`browser.js:31,430`），**没有 vm**；安全靠正则拦 `fs.rm/unlink/truncate`、`createWriteStream`、`child_process`、家目录/工程外绝对路径、`..`（`lib/javascript-safety.js:6-11,52-90`），可 `safety_checks:false` 关掉 | `vm.createContext` 隔离 + 两层超时 + 跨 realm 错误归一化（`source/core/sandbox.ts` / `core/engine.ts`） | **我们**（他们自己的 README 也承认"这是防护栏，不是完整沙箱"，`README_CN.md:249`） |
| **工具数量/披露** | 106 个，靠 profile 分档补救 | 4 个，`execute_code` 一个描述 1870 字（`README.md` 坑 20） | 现在**我们**省；工具涨到 8~10 个之后必须补披露机制（见 §4-B6） |
| **工具结果的形状** | 统一信封 `{ok, tool, callId, timestamp, summary, data, refs}`，`refs` 自动抽 uuid / `db://` 路径供**下一步直接用**（`lib/tool-registry.js:88-114,245-298`） | `{ok, context, durationMs, result}` + 序列化上限（`source/core/serialize.ts`） | **他们**（`refs` 这一条直接可借） |
| **工具注解** | 由工具名正则推断 `readOnlyHint / destructiveHint / idempotentHint`（`lib/tool-registry.js:145-163`） | 无注解；但**审批通道已经挂好**（`README.md`「交互」一节） | 组合起来才强（见 §4-B7） |
| **面板形态** | `panel/codely.js` = iframe 嵌 `http://127.0.0.1:3080`（`codely.js:9,17`），2s×45 次轮询探活、90s 上限、`fetch` 连失败 3 次退化成周期重载 iframe（`:56-116`） | 自绘面板（一层真 DOM，抄渲染模型不抄像素） | **我们**（我们评估过的那张对照表在 `README.md:32-37`，结论一致） |
| **会话/历史/用量/进度** | 面板里没有；靠 iframe 那份 dsh web 提供（**好处**：与浏览器里是同一个会话） | 自己实现（回放 / 恢复 / 搜索 / 导出 ZIP / 回收附件 / 用量 / 进度 / 活动 / 交互） | **我们**（但要承认他们"两个视图一个会话"这一点是他们的优势） |
| **日志** | `get_recent_logs` / `search_project_logs` / `clear_logs`，扫 `temp/logs`、`temp`、`logs`、`local/logs`、`local`，尾读上限 2MB，支持正则/大小写，清空要 `confirmProjectLogs`（`lib/logs.js:7-15,144-199`） | **没有日志工具**（全仓 grep `printEditorLog|getLogs` 零命中） | **他们**（这是我们最该补的一条） |
| **截图** | 5 种：desktop / editor 窗口 / scene 面板 / **game 面板** / **preview 窗口**（`lib/tool-registry.js:1769-1967`）；game/preview 靠**在编辑器窗口里按文本打分找面板 DOM**（`lib/electron-tools.js:104-216`，`scene`/`game` 互为 −10 分），再 `capturePage(rect)`；返回 dataUri | 1 种：**编辑器场景视图**（可缩放到节点、带取景链 `fit`、空图时 `invalidate()` 逼重绘；`source/capture.ts`），返回**文件路径** | 精度上**我们**（按 webContents URL 定位 + 场景进程里的真几何投影）；覆盖面**他们** |
| **输入模拟** | `simulate_mouse_click/drag`、`key_press/combo`、`simulate_preview_input` → `webContents.sendInputEvent`（`lib/input.js:31-143`）；坐标是"面板相对、**以面板中心为基准**的偏移"（`lib/tool-registry.js:1853-1854`）⇒ 模型基本在盲点 | **没有** | 能力**他们**；但我们有他们没有的东西：**节点→屏幕的真投影**（`viewMetrics` / `pick(x,y)`），所以能做成"点这个节点"而不是"猜坐标" |
| **预制件** | `inspect_prefab`（抽 uuid 引用，最多 500 条）/ **`validate_prefab_references`**（逐个 `queryAssetInfo` 判存在）/ **`edit_prefab_json`**（`jsonPath` 或 search/replace + 可选 `.bak` + 改完自动重验）/ `apply`/`revert_prefab_instance`（`lib/prefabs.js:146-365`），写盘优先走 `asset-db` 的 `save-asset`（`:100-126`） | 场景侧有 `snapshotTree`/`diffTree`（"我改了什么"）；**预制件引用体检没有**，`audit:bag` 的 F16b 是手写核对；"不能离线改 `.prefab`"是我们写明的诚实边界（`README.md:108`） | 存在性体检**他们**；"改了什么"**我们** |
| **诊断** | `run_script_diagnostics`（找工程或编辑器自带 tsc，`ELECTRON_RUN_AS_NODE=1`，正则解析成 `{file,line,column,code,message}`）+ `get_script_diagnostic_context`（给每个错误贴源码片段）（`lib/diagnostics.js:119-174`） | `npm run typecheck:diff`（**基线比对**，能当门禁：全量 249 条历史错误也不挡路） | **我们**（他们的全量 tsc 在 249 条历史错误下等于没有信号） |
| **"一次调用给全貌"** | `validate_scene` = 场景快照 + 运行态 + 性能 + tsc 诊断 + 日志错误，并汇总一个 `ok`（`lib/tool-registry.js:1612-1647`） | `cocos_editor_state`（工程/版本/选中/场景 + 能力探活 + "下一步用哪个工具"），不聚合诊断 | 各有侧重；`ok` 汇总这一层可借 |
| **运行态** | `get_runtime_state` / `pause_runtime` / `set_time_scale` 作用在**编辑器场景进程的 director**（`scene.js:1349-1423`）——**不是**跑着的游戏预览 | 同一层（我们的 scene 上下文就是那个进程），只是没暴露这些 | 平手；我们加两行就有 |
| **出图** | `generate_sprite` / `generate_image`：调火山方舟 Seedream → 写 PNG/JPEG + **手写 `.meta`**（`ver 2.2.0`、`subMetas[name].uuid = <uuid>@f9941`）→ 回 `spriteFrameUuid` 可直接接 `create_sprite`（`lib/tools/image-gen.js:196-238,254-289`） | 有 `tools/ark-style-transfer/`（Seedream 风格迁移 + 色键抠图 + Web 台 + 批量），但**没有**"落到 assets 并给出可接线 uuid"这一步 | 闭环**他们**；出图质量/流程**我们**（风格锚图 + 透明背景那套） |
| **工程指令 / skill** | `list/read/write_project_instruction`（认 `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`.cursorrules`/`.windsurfrules`/`.github/copilot-instructions.md`）+ `create_project_skill` 写 `.codex/skills/<name>/SKILL.md`（`lib/project-instructions.js:7-164`） | recipe 五件套（`find/read/save/run/deleteRecipe`）+ **复用门禁**，存 `<工程根>/.dsh-mcp/recipes/`；另有随插件发布的 bundled skill（`skills/cocos-editor-ops/SKILL.md`，56KB / 20 条 fact 锚点） | **我们**（门禁 + fact 锚点是他们没有的） |
| **多角色** | 8 个 preset；但每个文件 15~16KB 里，**头 23 行注释与从 `- id: tool-bash` 到文末那一段逐字相同**（实测：头 23 行 1,766 字节 + 样板尾段 11,951 字节，见 `agent-presets/cocos-gameplay/agent.cordis.yml:65` 起），persona 只占 1.9~3.3KB；同名 `cocos-codely` 预设还存在两份漂移副本（`AUDIT_REPORT.md:117-123` 自记） | 1 个 profile、persona 13 行（`cordis.patch.yml:22-32`）+ 66KB `AGENTS.md` + skill 层分工 | **我们**（但"并行 subagent 时一人设一角色"确有价值，且**必须放在工程侧**，见 §4-C13） |
| **分发** | Cocos Store / npm `bin`（stdio→HTTP 桥）/ `server.json`（MCP Registry）/ 自更新（GitHub Release + SHA256SUMS）/ i18n zh·en / 生成 `docs/TOOLS.md` 且 `docs:check` 卡住漂移 | 单工程内部（UNLICENSED，无 CLI） | **他们**（若要分发就抄这份清单） |
| **测试** | `node --test` 16 个文件 / **1,634 行**（`cocos-mcp-bridge/test/`） | 8 个 verify / **11,405 行**（`scripts/`），含"假 Editor + 假 cc 真跑 `dist/scene.js`" | **我们**（差一个量级） |

---

## 3. 我们更强的地方（别被"105 个工具"带偏）

1. **隔离**：vm 沙箱 + 双层超时 vs `new AsyncFunction` + 正则栏。他们的正则还会拦掉
   `child_process`（`javascript-safety.js:8`），而本工程的工作流必须能跑 `npm run audit:*`。
2. **门禁文化**：他们的"门禁"是 `node --check`（语法）+ 1,634 行测试 + 生成文档比对；
   我们是"真跑源码 + 真配表"的体检脚本 + skill 的 fact 锚点。
3. **面板那一半**：history/用量/进度/活动/交互卡/斜杠命令/`@` 引用/图片管线，他们全在 iframe 里。
4. **预制件"改了什么"**：`snapshotTree`/`diffTree`（键按节点路径、只回真变了的、点名探针泄漏）他们没有。
5. **文档与代码一致**：见 §6（他们仓里至少 6 处文档与代码不符，我们靠 verify 脚本挡这一类）。
6. **分层干净（业务无关）**：扩展层的 4 个工具、`source/**`、随包发布的 skill，
   **业务词命中为 0**（实测见 §4.0）—— 业务知识全在 `AGENTS.md` / `docs/` / `tools/*-audit/`。
   这条纪律**必须保住**：借能力时最容易顺手把一批业务假设一起搬进来。

---

## 4. 值得借鉴的（按"能不能马上落地 + 是否真补能力"排序）

### 4.0 准入尺子：只借「与业务无关」的能力

> **扩展层只提供通用原语 + 原始事实；业务知识一律留在工程侧。**
> 业务知识 = 表名 / 预制件与节点名 / 数值口径 / 阈值判据 / "这算不算合格"。

**五条判据**（任一条不过 → 改写或剔除）：

1. **参数通用**：签名里只允许出现 `path` / `uuid` / `jsonPath` / 坐标 / 图片 / 通用枚举（如 `scene|game|preview`）；
   出现 `背包 / 英雄 / 遗物 / 商城 / 具体表名 / 具体场景名` 一律出局。
2. **输出是事实，不是判断**：回 `{文件路径, uuid, 行号, 计数, 差异率}`；
   **不许**回 `{是否合格, 是否泄漏, 建议怎么改}` —— 判断留给调用方（人或工程侧脚本）。
3. **不内置业务映射表**：不许有"槽位 → 期望资源"的对照表、"哪些场景不能碰"的名单、
   "哪些操作要审批"的白名单 —— 这些要么由**调用方传参**，要么写进**工程侧配置**。
4. **可移植**：换一个 Cocos 工程（哪怕不是游戏）也能用；用例与文档里不出现本工程的业务词。
5. **业务验收不进扩展**：像"背包 15 个引用是否拖对""商城显示数 == 实发数"这类断言归 `tools/*-audit/`；
   扩展只负责**把事实取出来**。

**一句话区分**（最容易混的一例）：
"取预制件的 uuid 引用清单" = **能力**（§4-A4）；"背包预制件的 15 个槽位引用是否都拖对" = **业务**（留在 `tools/bag-audit`）。
A4 只做前半句，后半句靠调用方把**期望值**传进来。

**现状核对（本次实测，grep 计数，2026-11）** —— 我们这一层本来就是干净的：

| 范围 | 业务词命中 | 结论 |
|---|---|---|
| `source/**/*.ts`（13 个）+ `dsh-profile/plugin/dsh-cocos-bridge/index.js` | `背包/商城/遗物/英雄/塔防/怪物/技能/关卡/大厅/结算/Cmp_/Scene_Menu/tb/` = **0** | 工具面 100% 业务无关（4 个工具名也不带业务语义） |
| `skills/cocos-editor-ops/SKILL.md`（464 行 / 56KB） | 同上 = **0** | skill 是**通用编辑器操作**，不是本游戏攻略 |
| `benchmark/**` | `Bench.scene` 26 处、`units/relics/abilities` 1 处 | **设计使然**（基准必须在真工程里跑）；但 `cases.json:349` 的 `table-config` 问的是**业务表**（英雄/遗物/技能的 id 区间）→ 建议改成"任选一张 `tb/*.json`，只考能不能真读到 + 数字对不对" |
| `scripts/preview-panel.js`（面板预览台） | `英雄/遗物` 2 处 | 纯假数据（只为看面板长相），**不对模型暴露**，可接受 |

**自检命令**（每批做完跑一次，**期望输出 `命中总数: 0`**；例外见上表最后两行）。
本机**没有装 `rg`**（实测 `Get-Command rg` 未找到），所以写成 node 一行脚本
（node 读写 UTF-8 稳定，避开 PowerShell 的中文编码坑）；已在本仓实测：
三个目录 **0 命中**，指向 `benchmark/` 时能正常报出 `cases.json:349`（**证明脚本不是假绿**）：

```sh
node -e "const fs=require('fs'),p=require('path');const W=/背包|英雄|遗物|商城|塔防|怪物|Scene_Menu|Cmp_|tb\//;let n=0;const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const f=p.join(d,e.name);if(e.isDirectory()){if(e.name!=='node_modules'&&e.name!=='dist')walk(f)}else if(/\.(ts|js|md|json)$/.test(e.name)){fs.readFileSync(f,'utf8').split(/\r?\n/).forEach((l,i)=>{if(W.test(l)){n++;console.log(f+':'+(i+1)+': '+l.trim().slice(0,70))}})}});['extensions/dsh_chat/source','extensions/dsh_chat/skills','extensions/dsh_chat/dsh-profile'].forEach(walk);console.log('命中总数: '+n)"
```

### A 级——补我们真没有的能力

**A1. 日志读取（最高优先）**
- 他们：`get_recent_logs` / `search_project_logs` / `clear_logs`（`lib/logs.js`）。
- 我们：**一个日志工具都没有**。
- 为什么对我们特别值：本工程最贵的一类坑（"表现层 `onDestroy` 里碰别的组件 → 引擎销毁队列堵死 →
  画面永久卡住"，见 `AGENTS.md`）**只在编辑器 console 里现形**；现在只能靠人肉转述。
- 落法：`source/cocos-tools.ts` + `core/engine.ts` 加一个 `cocos_logs`，读 `<工程>/temp/logs/*.log`
  （与他们的路径表同口径），参数 `{tail, grep, regex, since}`；`clear` 要显式确认。
- 判据：制造一条真错误 → 工具能指名道姓找回来；"onDestroy 堵死"要有一条回归用例。
- **业务无关：✅** 契约只有 `{tail, grep, regex, since}`，回**原始日志行 + 文件路径**；
  **不内置"这是哪类 bug"的判断**，"onDestroy 堵死"只是动机与验收场景，不进工具实现。

**A2. 预览 / Game 视图截图**
- 他们：`capture_game_screenshot`（编辑器窗口里那个 Game 面板）+ `capture_preview_screenshot`
  （独立的预览/模拟器窗口）。
- 我们：`cocos_capture_view` 只截**编辑器场景视图**——这个工程的游戏是跑在预览里的，
  "跑起来那一帧"恰恰看不到。
- 落法：给 `cocos_capture_view` 加 `view: 'scene' | 'game' | 'preview'`。
  **我们可以比他们稳**：他们靠"在 DOM 里按文本打分找面板"（`electron-tools.js:104-216`），
  而我们定位场景视图靠的是 webContents URL 匹配（`source/capture.ts:210-256`），
  预览窗口同样有稳定 URL。
- 判据：能在预览里截到一帧战斗画面并落成 png 路径（而不是 dataUri 塞爆回执）。
- **业务无关：✅** 参数是通用枚举（枚举值里不出现任何本工程场景名）；回 png 路径与尺寸，
  **不判"画面对不对"**。

**A3. 输入模拟（但要做成"点节点"而不是"猜坐标"）**
- 他们：`sendInputEvent` 五件套（`lib/input.js`），坐标是面板相对的盲点。
- 我们：没有；但**我们有他们没有的零件**——场景进程里的节点→屏幕投影
  （`viewMetrics` 用 `cce.Camera.camera.worldToScreen`，`pick(x,y)` 还能分辨
  "真没有"与"我枚举漏了"）。
- 落法：新增 `source/input.ts`（主进程 Electron，复用 `findSceneView` 的窗口定位），
  对外只暴露**两个**工具面：`cocos_click_node(path|uuid)`（点节点中心的真投影坐标）
  与 `cocos_send_keys`（给预览窗口发键）。
- 判据：点一下 `hero_select` 里的英雄卡 → 预览里真的选中（截图前后像素有差异）。
- 这一条把"整屏交互只能人肉验收"变成 agent 自验，是本清单里**收益最大**的一条。
- **业务无关：⚠ 需改写**：契约只收 `路径 | uuid`（**不收"英雄卡"这种业务称呼**）；
  正式验收用例要用**不依赖业务的临时节点**（建一个 `TestBtn` → 点它 → 看它自己的 click 是否触发），
  上面那句"点英雄卡"只当例子，真回归放工程侧。

**A4. 预制件引用体检 + 结构化改预制件**
- 他们：`validate_prefab_references`（抽 uuid 引用 → 逐个查 asset-db → 报 missing）
  + `edit_prefab_json`（jsonPath 编辑 + 可选备份 + 改完自动重验）；
  写盘优先走 `asset-db` 的 `save-asset`（`lib/prefabs.js:100-126`）。
- 我们：`audit:bag` 的 **F16b「15 个拖引用逐条对着路径核」是手写的**（编辑器的 `??` 兜底
  拦不住"拖错"，见 `AGENTS.md`）；且"不能离线改 `.prefab`"被写成了诚实边界。
- 落法：给场景/编辑器沙箱加一个 `cocos_prefab_refs(target)` 助手，回
  `[{jsonPath, key, uuid, dbUrl, type, name}]`。
- ⚠ **必须比他们多一条判据**：**存在 ≠ 对**。拖错一张同样存在的图，他们的工具照样绿 ——
  我们的版本要能接受"这个槽位应该是 `db://assets/.../xxx.png`"这样的期望值。
- 顺带可以**解除一条已知边界**（预制件写盘走 `asset-db`），但落地前要验：
  编辑器会不会把我们的写盘当外部改动、会不会冲掉未保存的编辑态。
- **业务无关：⚠ 需改写（这条最容易越界）**：工具只回**事实**（`jsonPath / key / uuid / dbUrl / type / name`）；
  **期望值必须由调用方传参**（"这个 jsonPath 应该是哪个 `db://`"），
  "审哪个预制件、哪个槽位该是什么"**一律留在 `tools/*-audit`** ——
  扩展里不许出现业务预制件路径、槽位名或"该拖哪张图"的对照表。

**A5. 工具结果带 `refs`**
- 他们：每个回执自动抽 `uuid` / `db://` 路径并去重（`lib/tool-registry.js:245-281`）。
- 我们：skill 里专门写了一整条"**别猜 uuid**"，说明这正是当前的痛点。
- 落法：`source/core/serialize.ts` 的输出里加一段 `refs`（扫返回值里的 uuid/db url/节点路径），
  让"查一次 → 后续直接用"变成默认路径。
- **业务无关：✅** 抽的是 uuid / `db://` URL / 节点路径这类**通用事实**，去重后原样附上，
  不做任何语义归类（不写"这是背包预制件"）。

### B 级——结构性（工具面涨到 8~10 个之后是必需）

**B6. 工具面按需暴露 + 目录元工具**：他们的 `core/full/custom` + 命名 profile 存取/导出/导入
（`lib/tool-profiles.js`）+ 面板一屏开关 + `get_tool_catalog`。我们现在 4 个工具、
`cocos_execute_code` 一条描述就 1870 字 —— A1~A5 做完就是 8~10 个，需要"默认少暴露、
需要时查目录"。
- **业务无关：✅** profile 键只认工具名/分类名（通用键）；**默认暴露哪几个是工程侧设置**，
  不硬编码任何业务清单。

**B7. 注解 × 本工程已经有的审批通道**：他们有 `readOnlyHint/destructiveHint/idempotentHint`
（正则推断，`tool-registry.js:145-163`），但**所有工具都直接执行、没有 approval 开关**
（`README_CN.md:250`）。我们反过来：通道已经有了（`approval/request` 应答者 → 面板卡片）。
把"删节点 / 删资源 / 覆盖预制件 / 写工程设置"标成 destructive → 只给这几类弹卡，
其余照旧不打扰。**这是他们已经想到、我们已经建好一半、合起来最强的一条。**
- **业务无关：⚠ 需改写一处**：注解**默认值**（readOnly/destructive/idempotent）是通用概念，可照抄；
  但"**哪些要弹审批**"是**工程侧设置**，扩展只按注解给默认建议，不内置业务操作白名单。

**B8. 出图闭环**：他们的 `generate_sprite` 把结果落到 `assets/resources/textures/` 并回
`spriteFrameUuid`，可以直接接 `create_sprite`。我们有出图工具（`tools/ark-style-transfer/`）
但缺这一步。⚠ 手写 `.meta` 有风险（uuid 生成、编辑器再次导入的行为），
落地要专门验"编辑器重新导入后 uuid 不变"。
- **业务无关：⚠ 拆两半**：**出图**（提示词、风格锚图、透明背景/色键）是业务，留在工程侧
  `tools/ark-style-transfer/`；扩展只加**通用原语**="把这个已有文件按路径导入 assets 并回
  `{uuid, dbUrl}`"（工具名与实现里不出现任何业务目录名与命名规则，目标目录由调用方传参）。

**B9. 像素对比（给"按参考图改版"一把尺子）**：他们的 persona 把
`vision_html_screenshot` → `vision_pixel_diff`（差异率 + 热力图）→ `vision_crop`
当成 UI 改动的硬判据（`cocos-codely/presets/cocos/agent.cordis.yml:33`），
但**那些工具不在本仓**（第三方 `dsh-vision-toolkit`）。
我们的 UI 纪律是"每轮开工前重读参考图 + 交付前并排看一遍"——加上差异率与最差区域，
就从"我看过了"变成"差 3.2%，最差区域在血条下沿"。
- **业务无关：✅** 两张图进 → 差异率 + 热力图出；
  **"差多少算达标"由调用方定**（参考图放哪、允许多少差，都不是扩展的事）。

**B10. 面板配色跟随编辑器**：他们的 `cocos-dsh-theme.client.js` 覆盖 `--dsw-alias-*`
把 dsh 网页染成 Cocos 深色（⚠ 在他们仓里是**死资产**：无调用方、不在 `files` 白名单）。
我们的面板本来就只消费 token → 加一套"Cocos 编辑器配色"主题是纯 token 覆盖，零架构改动。
- **业务无关：✅** 纯 token 覆盖（`--dsw-alias-*` → 编辑器主题色）；
  **不许把游戏配色/品牌色塞进主题**。

### C 级——看情况

- **C11 `perfSnapshot` + 一个 `ok` 汇总的体检**：他们的 `get_performance_snapshot`
  （节点/组件/UI 计数 + 内存 + 警告）与 `validate_scene` 的聚合口径。本工程用对象池，
  最容易出的就是"节点没回收"——一个可数的快照能当判据。
  · **业务无关：✅** 只报**计数**与警告条数，**不判"是不是泄漏"**（判据在工程侧）。
- **C12 `pause_runtime` / `set_time_scale`**：他们作用在编辑器场景进程的 director
  （与我们 scene 上下文同源）→ 我们加两行就有；"把场景冻住再截图/取数"能消掉时序抖动。
  · **业务无关：✅** 两个通用原语。
- **C13 ~~角色预设拆分~~ → 剔除（业务相关）**：他们 8 个 preset 里 persona 只占 1.9~3.3KB
  （其余是逐字相同的 agent-plane 样板），我们靠 13 行 persona + 66KB `AGENTS.md` + skill 更省。
  但**"角色"本身就是业务分工**（数值 / UI 还原 / 战斗系统）——按 §4.0 的尺子，它**不该进扩展**：
  要拆就拆在**工程侧**（`AGENTS.md` / `docs/` / 工程自己的 `.dsh-mcp` 或 skill 目录），
  扩展只保留一个**通用**的编辑器操作角色，bundled skill 也必须保持通用
  （实测 `cocos-editor-ops` 现在确实是 0 业务词，见 §4.0）。
- **C14 i18n / 自更新 / 一键客户端配置 / MCP Registry**：我们是单工程内部工具，不需要。
  要分发的那天，抄 `install-cocos-stack.mjs`（幂等 + junction/copy + `files` 白名单）。
  · **业务无关：✅**（只是本期不做）。

---

## 5. 不建议学的

1. **iframe 嵌 dsh web**：我们评估过并否掉（`README.md:30-37`）；他们也因此踩了
   "一个包身兼二职（既是 dsh bundle 又是 Cocos 扩展）"的坑，`AUDIT_REPORT.md` 的"问题 1"
   就是这件事，修法是**把面板挪回 bridge**——等于承认 iframe 那条路要配一个真扩展。
2. **`new AsyncFunction` 直跑 + 正则安全栏**：隔离性差一档，且正则会把本工程必需的
   子进程用法全拦掉。
3. **一味堆工具数量**：106 个工具里大量是 `create_label`/`create_button` 这类窄工具，
   而他们的"core 38 个"里仍有三分之一要靠 `[core]/[specialist]` 标签才知道该不该用。
   我们"少而深"是刻意选择（`README.md`「工具面与能力的来源」一节）。
4. **把要点写在 README 里当门禁**：见下。
5. **把业务知识写进扩展层**：扩展是"换一个 Cocos 工程也能用"的东西（§4.0）。
   判据不是"能不能跑"，而是"**删掉本工程的业务词之后还剩不剩**"。
   反例就在我们自己的 `benchmark/cases.json:349`（`table-config` 那条问的是
   英雄/遗物/技能的 id 区间）—— 基准绑工程是设计使然，但**用例本身也该只考
   "能不能真读到 + 数字对不对"**，不该考"知不知道本工程的表长什么样"。

---

## 6. 他们那份代码里的"反面教材"（文档漂移清单）

这条对我们**比功能清单更值钱**——我们是靠 verify 脚本 + fact 锚点挡住这类漂移的：

| 漂移 | 证据 |
|---|---|
| 工具数量三处不一致 | `README_CN.md:244` 写 core 39 / full 105；`docs/TOOLS.md:5` 写 core 38 / full 106；`README_CN.md:266` 又写 105 |
| 工具名与文档不符 | `cocos-codely/README.md:86-101` 与 `QUICKSTART.md:91` 用 `query_scene`/`set_property`/`build`/`get_console`；实际是 `get_scene_info`/`set_component_property`/`run_script_diagnostics`/`get_recent_logs` |
| 审计报告描述的是旧版本 | `AUDIT_REPORT.md:22,26-28` 说 `src/main.ts`"仅 load/unload/openPanel"、`src/panels/default/index.js`"含 iframe 3080/90s 超时"——那四个文件现在都是 **1 行 `# removed` 墓碑**，且不是合法 JSON/TS/HTML |
| 安装指南与脚本互相矛盾 | 根 `AGENTS.md` §7 写"`cocos-codely` 是 dsh bundle，**不要**放进 `~/.CocosCreator/extensions/`"，而 `cocos-codely/link-to-project.ps1:2` 干的正是这件事（且它依赖 `dist/main.js`，而 `src/main.ts` 已不会产出 dist） |
| 启动脚本指向已废弃的 patch | `start-cocos-dev.sh:13` 默认用 `dsh-cocos-assets.patch.yml`（该文件 YAML 内容为零、自述 DEPRECATED） |
| 死资产 | `cocos-dsh-theme.client.js` 全仓无调用方、也不在 `package.json` 的 `files` 白名单 |
| 最新提交已在修安全项 | `8b9162c`"移除硬编码的火山方舟接入点 ID，改为用户配置环境变量"——而根 `AGENTS.md` §6.6 仍在说"内置了实测可用的接入点" |

---

## 7. 如果要动手：建议的批次

| 批次 | 内容 | 为什么这个顺序 |
|---|---|---|
| **第 1 批**（小、立刻有用）**✅ 已落地 2026-11** | A1 日志工具 · A5 `refs` · B10 面板 Cocos 主题 | 不动架构、不新增窗口定位，当天能验。落地清单见 §8 |
| **第 2 批**（真补能力） | A2 预览截图 · A3 输入模拟（含 `cocos_click_node`）· C12 pause/timeScale | 共用同一套窗口定位（`source/capture.ts` 已有）；A3 收益最大 |
| **第 3 批**（解除已知边界） | A4 预制件引用体检 + 结构化改预制件（含 `asset-db` 写盘） | 会碰"编辑态 vs 写盘"的一致性，要单独验 |
| **第 4 批**（工具变多之后） | B6 profile/按需暴露 · B7 注解×审批 · B9 像素对比 · B8 出图闭环（只做"导入资产回 uuid"那半） | 前 3 批把工具数推到 8~10 个，这一批才有的放矢 |

**每批都要配两条**：

1. **verify**（本工程的规矩）：`node scripts/verify-*.js` 加断言 + 该条知识的
   `<!-- fact: -->` 锚点；改 `SKILL.md` 后跑 `npm run verify:skill`。
2. **业务无关自检**：`source/`、`dsh-profile/plugin/`、`skills/` 里业务词命中必须为 **0**
   （现成命令与例外清单见 §4.0）。发现新增命中 → **改写调用形态，而不是往扩展里加映射表**。

---

## 8. 第 1 批已落地（2026-11）：A1 日志 · A5 `refs` · B10 配色

三件都按 §4.0 的尺子做完了 —— **参数通用、输出是事实、没有业务映射表、换一个 Cocos 工程也能用**。

### 8.1 A1 `cocos_logs`（新增工具，工具面 4 → 5）

| 项 | 落点 |
|---|---|
| 实现 | `source/logs.ts`（新文件）→ `dist/logs.js`；分发表条目 `read_logs: withRefs(readLogs)`（`source/cocos-tools.ts`） |
| DSH 侧工具 | `dsh-profile/plugin/dsh-cocos-bridge/index.js` 的 `cocos_logs`（描述 + 10 个参数 + `presentCall`） |
| 参数 | `list` / `tail` / `grep` / `regex` / `caseSensitive` / `since` / `dir` / `files` / `clear` / `confirm` |
| 目录 | 通用候选表 `LOG_DIR_CANDIDATES`：`temp/logs`、`logs`、`local/logs`、`temp/asset-db/log`、`local`、`temp` —— **全都扫**，回执逐个报 ✓/✗ |
| 安全 | 只尾读单文件最后 **2MB**；只认 `.log` / `.txt`；唯一的写盘口 `clear` **必须带 `confirm:'clear'`**，且是**截断**不是删除（编辑器可能正开着文件） |
| 只回事实 | 不认识"这是哪类 bug"、不给修复建议；所有异常（目录不存在 / 文件读不动 / 正则非法 / 命中为 0）都**如实写在回执里** |

**真项目冒烟**（只读，脚本 `.tmp/dsh-smoke-logs.js`）：扫到 7 个真日志文件（含 `temp/asset-db/log/*.log` 334KB、`temp/logs/project.log` 1.1MB），
`grep:'uuid'` 命中 **267 行**；`clear` 不带 confirm 被拒且**一个字节都没动**；非法正则给人话原因。

### 8.2 A5 `refs`（出口统一补可复用标识）

- `source/core/serialize.ts` 新增 `collectRefs` / `formatRefs`（纯函数）；`source/cocos-tools.ts` 的 `withRefs` 把**五个方法**全包上。
- 只抽**不会认错**的两类：**全形 uuid**（含子资源写法 `uuid@f9941`）与 **`db://` 路径**。
  **压缩型 uuid 刻意不抽**（任意 22 字符单词都会命中，抽出来是噪声）、节点路径不抽（与普通文本无法区分）。
- 追加在 `text` 结尾（模型只读 `text` —— 桥接侧 `OUTPUT.render` 只渲染它），结构化版本进 `data.refs`。
- 抽不到就**不加空壳字段、不改文案**；抽取本身抛错绝不让一次成功的调用变成失败。

### 8.3 B10 配色（`palette`，与明暗正交）

- 新文件 `static/style/default/editor-theme.css`：**只重定义 `--dsw-alias-*`**（含 7 个当前未被消费的 `--dsw-specific-*` 备用），
  挂在 `.dsh-root[data-palette='editor'][data-theme='dark']` 上 —— 特异度 (0,3,0) 压过深色块 (0,2,0)，**不依赖样式注入顺序**。
  ⚠ 不能写进 `dsw-tokens.css`：那是 `scripts/extract-dsw-tokens.js` 的**生成物**，重跑会被整份覆盖。
- 设置项 `palette: 'dsw' | 'editor'`（`constants.ts` 的 `PanelPalette` + `settings.ts` 的白名单校验 + 面板 `data-palette`）。
- 顺带修掉一处**文案与行为不一致**：`auto` 档原来写「跟随系统」，实际是「先认编辑器、认不出才跟系统」→ 改成「跟随编辑器」。
- 离线预览台也接了：`preview-panel.js` 注入第三份 CSS，并支持 `?palette=editor`。

### 8.4 门禁（每批都要配的两条，都跑了）

| 门禁 | 结果 |
|---|---|
| `verify-cocos-engine.js` 新增 **[8] 段** | 真写日志文件再读回来：list / grep（行号与原文）/ 字面子串不转义 / 非法正则给人话 / `since` 按行内时间戳筛 / `clear` 拒绝且**零副作用** / 超大文件尾读并注明 / `clear+confirm` 真截断；refs 去重 + 子资源 uuid + 噪声不抽 + 空值不留壳。**163/163 通过** |
| `verify-panel.js` 新增 **3b 配色层** 段 | 覆盖层在不在、选择器对不对、12 个真消费 token 是否都覆盖、**是否混进组件选择器**、面板有 `data-palette`、设置有 `palette` 下拉、预览台也注入了 |
| `verify-bridge.js` | 工具名预期 4 → **5**（`EXPECTED_TOOLS` + 描述要点：`list: true` / `grep` / `confirm` / `F1` / 原文） |
| `verify-skill-facts.js` | `tool-count-is-4` → **`tool-count-is-5`**；新增 `logs-tool-wired` 锚点（注册 / 帧 / 分发表 / 候选目录 / 确认口令五处在）。**22 条事实 / 13 条可执行锚点全绿** |
| **业务无关自检**（§4.0 那条命令） | 三个目录 **命中 0** |

主要改动文件：`source/logs.ts`（新）、`source/core/serialize.ts`、`source/cocos-tools.ts`、`dsh-profile/plugin/dsh-cocos-bridge/index.js`、
`static/style/default/editor-theme.css`（新）、`source/constants.ts`、`source/settings.ts`、`source/panels/default/index.ts`、
`scripts/verify-cocos-engine.js`、`scripts/verify-panel.js`、`scripts/verify-bridge.js`、`scripts/verify-skill-facts.js`、
`scripts/preview-panel.js`、`skills/cocos-editor-ops/SKILL.md`、`README.md`。

⚠ **要生效得重启一次 agent**：插件是纯 ESM、不编译，但 `patchReload: live` **不热重载它**（README 坑 23），
所以新增工具后必须 stop/start 一次；面板侧改了 TS 则要先 `npm run build`。

---

## 附：本地副本

```sh
# 只读副本（浅克隆，872KB，分析完可直接删）
.tmp/cocos-extensions/
```

未纳入本次分析的：`cocos-mcp-bridge/lib/tools/files.js` 的逐工具实现、
`lib/resources.js` 的 `cocos://` 资源清单、`lib/update-checker.js` / `updater.js`、
`panel/shared.js`（68KB）的渲染细节 —— 与本工程能借鉴的部分无关（我们是 fork IPC，
既没有 resources/prompts 的消费方，也没有自更新需求）。
