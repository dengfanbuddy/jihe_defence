# dsh_chat 的 AI 工作流：全图梳理 · 问题清单 · 「自包含 + 自进化」方案

> **审计日期**：2026-09-30（本轮）
> **对象**：`extensions/dsh_chat/`（+ `dsh-profile/`、`.agents/skills/cocos-editor-ops/`、`.dsh-mcp/`、`$DSH_HOME/profiles/cocos/`）
> **方法**：四路并行源码审计（运行时接线 / 沙箱与 recipe / 面板与验证 / 知识层与 DSH 检出）+ **全会话日志量化**（解 zstd 逐事件统计，工具 `.tmp/dsh-evolution-metrics.mjs`）+ 现场跑验证套件（286 条断言全绿）+ DSH 检出与已装 profile 的指纹比对。
> **上位文档**：`docs/dsh_chat_对话成本与通用能力分析.md`（2026-09-30 13:09，上一轮：一个登录预制件为什么花掉 79 步）。本文是它的**续作与收敛**——那一轮修的是工具层，这一轮问的是「插件能不能自己长本事」。
> **未验证项**：本机当前没有打开 Cocos 编辑器（只有 CocosDashboard 进程），所有编辑器内行为均来自**源码 + 会话日志**，未做真机复现；标 ⚠️ 的条目附了复现方法。

---

## 0. 结论速览

**一句话现状**：编辑器面板 → 扩展主进程 → `fork(dsh --profile cocos)` → profile 里的 bridge 插件注册 4 个 `cocos_*` 工具 → 工具调用经 fork IPC 回到扩展主进程 → editor 走 vm 沙箱、scene 走本扩展的场景脚本 → 改真编辑器。**这条链是自包含的**（`dfan_mcp2` 依赖已物理解除）；**但围绕它的三条"经验回流"通道——事实（skill）、代码（recipe）、能力（工具/助手）——没有一条是闭合的。**

**三个判断**（按重要性）

1. **运行时自包含 ✅，开发闭环不自包含 ❌。** 执行能力全在扩展内（`source/core/*` + `source/scene.ts`），零端口、零 MCP、离线装 profile；但改 `dist/**` 必须**重启 Cocos Creator**、改 bridge 插件必须**重启 agent**、装 profile 要写 workspace 之外的 `$DSH_HOME`（沙箱会拒）。后果可测：插件自身那轮开发会话（`90f1e5ef`，45 分钟 / 207 步）里 **`cocos_*` 调用 = 0 次**——造工具的那个 agent 没法用自己造的工具。
2. **自进化的"三个载体"骨架齐全，但四条环路全断。** 事实有 skill（且**热生效**：agent 写完下一步就能看见）、代码有 recipe（门禁严、`verifiedAt` 会失真）、反射有 `describe_api`；但：事实靠纪律手写、recipe 三次真实任务只落盘 1 条、能力增长必须重启、回归基准**不能无人跑通**。
3. **当前最大的隐性漏损不是"缺能力"，是"知识在下沉通道上被吃掉"。** `AGENTS.md` 68,322 B > `dsh-base` 给的 `agent-instructions.maxBytes = 65,536` → 每次会话**静默截断**，被切掉的正是末尾**最新沉淀的那几条 Notes**；同时 `extensions/dsh_chat/`（371 个文件）、`.agents/skills/cocos-editor-ops/`、`.dsh-mcp/` **都不在 git 里**。一边在丢新知识，一边在丢可回滚性——这两条不修，任何"自进化"都是往漏桶里倒水。

**一句话方案**：把"能力增长"从 **`dist/`（要重启编辑器）**搬到**运行时可加载的三层**——`recipe`（代码）/ `skill`（事实）/ **动态 helper 目录与运行时插件（能力）**，并给每一层配一道**可执行的 verify**；凡"判据可计算"的增长自动生效，凡"取舍与版本事实"留给人策展。

---

## 1. 工作流全图

### 1.1 五个角色、两条通道

```
Cocos Creator 3.8.6 编辑器（Electron 31 / Node 20.15）
├─ 扩展主进程  dist/main.js        ← package.json:8
│    load() → ensureReady(): 读设置 + 探 node/dsh + 同步 profile      source/main.ts:386-389,113-122
│    methods{}: 面板/菜单全部入口（18 个消息）                        source/main.ts:149-383
│    contributions.scene = dist/scene.js（场景脚本，跑在引擎进程）     package.json:145-152
│
├─ fork ──► DSH 子进程（**系统 node**，不是编辑器内嵌 node）
│    <nodeExe> <…>/@deepseek-ai/dsh/lib/bin.js --profile cocos        source/dsh-host.ts:292-301
│    stdout = SDK JSON-RPC ｜ stderr = 插件日志 ｜ IPC(fd4) = 工具帧+控制帧
│    profile = $DSH_HOME/profiles/cocos（仓库 dsh-profile/ 的拷贝投影）scripts/install-profile.js:121-163
│      └─ node_modules/dsh-cocos-bridge/index.js → ctx.tools.register × 4
│
├─ 面板（渲染进程，可停靠）dist/panels/default/index.js
│    Editor.Message.request('dsh_chat', <msg>)                        source/panels/default/index.ts:371
│    事件回流：广播（私有 API，快）+ 轮询 get-events（主路，800/300ms）
└─ 沙箱执行面
     editor 上下文：vm.createContext 新 realm（Editor/require/fs/path + 7 助手 + recipe 五件套）
     scene  上下文：宿主 realm + 局部绑定注入（cc/director + 13 助手 + recipe 五件套）
```

**两条通道各司其职**：模型 ↔ 宿主走 **SDK stdio 协议**；宿主 ↔ 编辑器走 **fork 的 IPC fd**。全程零端口、零 HTTP、不走 MCP。

**四个工具**（模型能碰编辑器的全部手段，`dsh-profile/plugin/dsh-cocos-bridge/index.js:615,673,717,741`）：

| 工具 | 语义 | 落到编辑器 |
|---|---|---|
| `cocos_execute_code` | 通用逃生口：写 JS，返回它 `return` 的值 | editor → vm 沙箱；scene → 场景脚本 |
| `cocos_describe_api` | **渐进式披露**：别猜 API | editor 侧自带反射；scene 侧转发场景脚本 |
| `cocos_editor_state` | 会话开头/卡住时探一次（工程/版本/选中/场景 + 能力探活 + 「下一步用哪个工具」） | 主进程 + 场景探针 |
| `cocos_capture_view` | **唯一独立通道**：场景视图落成 png 回路径（像素塞不进 4000 字上限） | 场景脚本 `captureView` |

### 1.2 一次真实任务的时间线（`78db6ce7`，「搭建图里的任务界面，不要代码」，50 步 / 6.2 分钟 / 41 次 `cocos_*`）

| 步 | 干了什么 | 值得注意 |
|---|---|---|
| s1 | `skill(cocos-editor-ops)` + `cocos_editor_state` | **开头就吃 skill 与自检**（上一轮的建议生效了） |
| s2 | `tree()` + **`findRecipes()`** | recipe 机制**第一次被真的用上**（历史上 0 次） |
| s3 | `readRecipe('build-login-ui-tree')` | 读了唯一那条 recipe |
| s4–s9 | 资源侦察：`query-assets` ×3、读 4 张图、pwsh 读 `.meta` | 9 步全花在"从路径拿到可用贴图引用" |
| s10 | `describe_api` ×3（`cc.ScrollView`/`Mask`/`Layout`） | 用对了 |
| s11–s25 | **建树 → 丢助手 → 重建 → 再丢 → 再重建**（15 步） | 踩 `vm` 上下文不跨调用（README 坑 1）：把辅助函数挂在 `globalThis.__taskUI`，下一次调用就没了（s23 注释原文「helpers 丢了，需要重跑上一步」） |
| s26,s30 | `cocos_capture_view` ×2 | 拿不到可用画面 |
| s28–s34 | 手写世界矩形累加 + 重叠检测 + Layout 复核 | 当时还没有 `worldRect` 助手（该助手是**同一天晚些**的 `90f1e5ef` 会话才加的） |
| **s35–s43** | **自写 PowerShell GDI+ 渲染器**（`.tmp/task-ui-preview.ps1` → PNG → `read_image`）9 步 | 视觉验收缺口的**复发**：上一轮 16 步，这一轮 9 步 |
| s44 | `cce.Prefab.createPrefabAssetFromNode(...)` 存预制件 | 靠 skill 记的反编译 API，无助手 |
| s45–s46 | 读 `.prefab` JSON 核验 + `query-dirty` | 产物自检做得好 |
| **s46–s48** | **改 `SKILL.md`**（把"`snapshot:true` 的副作用"这条**错事实**改对） | 收尾的沉淀能量**全给了 skill，没给 recipe** |
| s49–s50 | 交付说明 | 全程 0 次 `saveRecipe` |

**这一条时间线就是本文的问题地图**：9 步资源解析（缺 `resolveAsset`）、15 步助手丢失（缺"跨调用状态"的正面原语）、9 步视觉（缺产品化预览）、0 条 recipe（缺落盘触发）。

### 1.3 经验沉淀的三条通道（现状）

| 通道 | 载体 | 写入门槛 | 生效时延 | 现状 |
|---|---|---|---|---|
| **代码** | `<工程根>/.dsh-mcp/recipes/*.js`（每次调用现读盘） | `saveRecipe` **复用门禁**（description/returns/参数真用上/无 uuid/无绝对路径/无 `.tmp/`） | **零重启**（下一次 `findRecipes` 就在） | 1 条（`build-login-ui-tree.js`，9.5KB，已完全参数化） |
| **事实** | `.agents/skills/cocos-editor-ops/SKILL.md`（423 行 / 27.8KB） | 人策展（agent 也能写：`write`/`edit` 会经 `fs/observed` 让 skill provider 失效，**下一步就刷新目录**） | **零重启** | 8 坑 + 6 纪律 + 内置资源 + recipe 口径 + 验收清单 + 已知限制 |
| **能力** | `dist/**`（沙箱助手、场景脚本）+ profile 里 bridge 插件的 4 段 description | `npm run build` + **重启编辑器**；bridge 改完 **重启 agent** | **分钟~十分钟级，且要人动手** | 13 个 scene 助手 + 7 个 editor 助手，**全是"读/量/探"** |

### 1.4 会话生命周期

| 动作 | 背后 |
|---|---|
| 启动 | `fork` → SDK `initialize`（180 s 预算）→ **自动接上本工程最近一条有内容的会话**（列日志 → 面板回放 → 控制帧 `session/resume` → `ctx.agents.resume`） |
| 中断本轮 | 控制帧 `session/cancel` → 运行时 `Agent.cancel({kind:'user'})`（SDK 协议本身没有取消，只能由跑在运行时里的插件代劳） |
| 停止 / 重启 | 停整个子进程；重启后照样接回上次会话（上下文不丢） |
| 新会话 | 释放接上来的 agent + 换新 sessionId（旧历史仍在抽屉里） |

**关键结构事实**：**面板 agent 与"被执行的编辑器"在同一个进程树里**——扩展主进程既 fork 了 agent，又是工具的服务端。**"agent 改自己的工具"因此天然是"自改即自杀"**（改完 `dist/` 要重启编辑器，而重启编辑器会连带 kill 掉 agent 子进程）。

---

## 2. 现状量化（真实会话，不是估计）

### 2.1 三次真实编辑器任务

| 会话 | 任务 | 步 | 时长 | `cocos_*` | 代码量 | `findRecipes` | 读了 recipe | **存了 recipe** | pwsh 打编辑器安装目录 |
|---|---|---|---|---|---|---|---|---|---|
| `37423001` | 登录预制件（首版） | 65 | 10.0 min | 70 | — | 有 | — | **1** | 0 |
| `ad6ce9c2` | 登录预制件（重做） | **79** | 6.1 min | 54 | 51 KB | 有（空） | — | **0** | **25/25 全打在这里** |
| `78db6ce7` | 任务界面（Tab+返回） | **50** | 6.2 min | 41 | — | 有 | 有 | **0** | **0** |

**进步**：步数 79 → 50、乱翻编辑器安装目录 25 → 0、开头先读 skill+recipe；**基准过程分 38 → 62 / 100**（`benchmark/score.mjs`）。
**没进步**：**recipe 沉淀率 1/3**；同类"没路可走"的动作（自建渲染器、资源解析）**原样复发**。

### 2.2 插件自身的开发会话（`90f1e5ef`，45 min / 207 步）

| 指标 | 值 |
|---|---|
| 工具分布 | `edit` 68 / `pwsh` 66 / `read` 60 / `grep` 21 / `todo_write` 3 / `write` 3 |
| **`cocos_*` 调用** | **0** |
| 现场踩的坑 | 改 profile 的那次**被沙箱拒绝**（写 `$DSH_HOME` 在 workspace 之外，只能申请放宽权限重试）；bridge 插件改出**语法错误**（纯 JS 无类型检查，靠运行时才发现）；`patchReload: live` 被当成热重载 |
| 产出 | `loadFrame` / `worldRect` / `context` 推断与错误翻译 / 空白帧退路 / skill 纠错 / README 边界表 |

**这条会话是"自进化"最贵的一次实测**：45 分钟里**一步都没能对着真编辑器验证**——因为那时 `dist/` 还是旧的、编辑器重启会杀掉自己。它只能靠 `verify-cocos-engine.js`（假 Editor + 假 cc）。

### 2.3 验证与基准

| 项 | 现状 |
|---|---|
| 自动化断言 | **286 条**（`verify-cocos-engine` 58 / `verify-panel` 112 / `verify-images` 59 / `verify-bridge` 57），本轮现场全绿 |
| 未覆盖 | `paths.ts` / `settings.ts` / `dsh-host.ts` / 实时流 / 面板运行时 / markdown / tool-card / **广播快路** / **dist 新鲜度** / `package.json` 入口存在性 |
| 跑法 | 5 个脚本**手工逐个跑**，根 `package.json` 无脚本、无 CI、无 lint（0 条 npm 别名） |
| 基准 | 27 用例 / 32 checks / 13 editorProbe；**执行靠人把 prompt 粘进面板**；`assets/bench/` 与 `Bench.scene` **在当前 checkout 不存在** → 磁盘判据必然全红；8/27 用例 `checks=0`（只能人工粘探针）→ **实际只有 19 条能被 oracle 无人判定**；**26/27 无基线**；`score.mjs` 恒 `exit 0`；基准**只被它自己的 README 引用**（全仓 9 处命中都在 `benchmark/README.md`） |
| 基准可达性 | 只有"对已有日志打分"这一种能全自动（本轮复现了 `38/100`） |

### 2.4 知识层

| 项 | 现状 |
|---|---|
| `AGENTS.md` | **68,322 B**，预算 **65,536 B**（`dsh-base` 的 `agent-instructions.maxBytes`），实际注入 **65,143 B 后被截断** → 每次都丢末尾（最新 Notes）⚠️ 复现：看会话第一条 `Workspace instruction budget` 通知 |
| skill | 工程 `.agents/skills/`（rank 200）压过用户级 `~/.agents/skills/`（rank 500，17 个）；**只扫一层**（`<root>/<name>/SKILL.md`）；**正文热读、frontmatter 变更下一步刷新** |
| recipe | 1 条；**未入库**；`verifiedAt` 只在 `runRecipe` 成功时写、且 `saveRecipe` 不写 → 该条**没有** `verifiedAt`；`daysSinceVerified` 把 `null` 当"新鲜"（`?? 0`）→ 30 天陈旧警告对"从没跑过"的 recipe 永久失效 |
| 会话日志 | `$DSH_HOME/sessions/<工程键>/`，65 个会话 / 本工程 ≈ 30 MB；zstd 拼接帧（**必须逐帧解**，流式解压器直接报 `Unknown frame descriptor`）；**没有删除 API**；全文检索（`session-query-sqlite`）默认 `openAt:'never'` → 装了但没开 |

---

## 3. 自包含评估

### 3.1 已经做到的（这层做得扎实）

1. **执行能力 100% 自带**：沙箱在 `source/core/engine.ts`、场景脚本在 `source/scene.ts`、recipe 在 `source/core/recipes.ts`、序列化上限在 `source/core/serialize.ts`。`dfan_mcp2` / `dfan_mcp` / `cocos-mcp` **零运行期引用**（`verify-cocos-engine.js:573` 还留了一条"回执里不许再提 dfan"的守卫断言）。
2. **profile 离线安装**：不走 pnpm、不碰 registry，只往 `<DSH_HOME>/profiles/cocos/` 做**按内容拷贝**（幂等 + 清理源里已删的文件 + 版本戳）。
3. **零端口 / 零 HTTP / 零 MCP**：四条通道（SDK stdio、fork IPC、编辑器内部消息、场景进程）全在进程内或编辑器内部。
4. **面板零依赖**：纯 DOM + 自写 markdown 子集 + 抄 DSH 设计 token（`extract-dsw-tokens.js --check` 可校验与已装 DSH 是否一致）。
5. **降级有文案**：没有打开场景 → "先打开一个场景"；`ok` 语义已修正（部分降级 ≠ 失败）。

### 3.2 残余外部依赖（关键几条）

| 依赖 | 缺了会怎样 | `install-profile.js` 会校验吗 |
|---|---|---|
| DSH CLI（`@deepseek-ai/dsh`，实装 `0.1.2-rc.1`） | agent 直接起不来 | ❌ |
| **系统 node ≥ 22.15**（zstd API；编辑器内嵌 Node 20.15 解不开） | agent 起不来 + 历史全不可读 | ❌（有硬编码候选路径兜底，其中一条是坏的，见 P2-4） |
| `<DSH_HOME>/profiles/node_modules` 里的 `dsh-base` / `dsh-sdk-app` / `dsh-tools` / `dsh-llm` | **4 个工具全没了**（插件整体加载失败） | ❌ **完全不校验**，报告照回 `ok:true` |
| `$DSH_HOME` 环境变量 | 未设时两侧都回落 `~/.dsh`（一致，可接受） | ⚠️ 只建 profile 子目录 |
| profile 是**全局按名字共享**的 | 同机另一工程/另一版 dsh_chat 加载扩展 → **后加载者覆盖前者**，无隔离无版本校验 | ❌ |
| `AGENTS.md` / `.agents/skills/` / `.dsh-mcp/recipes/` | 少知识、少复用，不影响功能 | ❌（懒创建） |

**结论**：运行期自包含已达标；**"自包含"的缺口集中在"装得上、跑得对"的校验**——插件有现成的 `ping` 控制帧（回 `agents`/`cancel`/`owned` 能力自述）却**只在测试里用过**，本可作为"扩展 ↔ 插件 ↔ profile"三方版本握手，现在不兼容只能等 120 s 超时或报"未知的编辑器方法"。

---

## 4. 问题清单

> 分级口径：**P0 = 直接挡住"自包含 + 自进化"**；**P1 = 每次任务重复付费 / 知识会写错或写丢**；**P2 = 工程健壮性与可观测性**。
> 每条给：症状 / 证据 / 代价 / 落点。

### P0（挡住自进化）

**P0-1 整个插件不在版本控制里。**
证据：`git ls-files extensions/dsh_chat` = **0 个文件**；`git status` 里三个未跟踪条目 `?? extensions/dsh_chat/`（**62 个文件**，含 `source/` 17 + `dist/` 21 + `benchmark/` 4 + `scripts/` 9 + `dsh-profile/` + `static/`）、`?? .agents/skills/cocos-editor-ops/`、`?? .dsh-mcp/` —— 三者**都没有被 `.gitignore` 忽略**（`.gitignore` 只忽略 `library/temp/local/build/profiles/node_modules/.tmp` 等）。
代价：源码/dist/benchmark/DSH 侧插件的每一次"自进化"**不可 diff、不可回滚、不可 review**；一条 `git clean -fd` 全没。**自进化的前提是"改错了能退回去"**，这条不修，后面所有自动化都是裸奔。
落点：`.gitignore` 加例外 + `git add`（含 `.dsh-mcp/recipes/`，它是团队资产，skill 里也写着"建议入库"）。

**P0-2 改扩展必须重启编辑器 → agent 无法验证自己的产物。**
证据：`Editor.Package` 只有 `checkReload/scan/startup`；实测 `disable/enable('dsh_chat')` 返回成功但拿到的是**同一个 `require` 缓存模块实例**（`unload()` 都没真跑）。`90f1e5ef` 45 分钟 / 207 步里 `cocos_*` 调用 **0**。
代价：插件的能力增长（新助手、错误翻译、新工具）**只能靠假 Editor 验证**；"真实编辑器里的那一跳"每次都要人说一句"去重启"。
落点：见 §5 环路 C（把能力增长搬到运行时可加载层）。

**P0-3 改 bridge 插件必须重启 agent，且 agent 不能重启自己。**
证据：`patchReload: live` **只**盯 patch 配置文件（launcher 给 live profile 建的 HMR 实例 `root: []`，不监视任何模块目录）；`dsh-base` 里 `hmr` row 是 `disabled: true`。而插件头注释 `index.js:39` 还写着"`patchReload: live` 会热重载"——**与 README 坑 23 直接矛盾**，最容易被下一个人当真。
代价：工具面（含 4 段"模型唯一说明书"的 description）的每次修订 = 一次 stop/start；agent 自己发起的重启会把自己这一轮打断（它只能请求人点按钮）。
落点：§5 环路 C 的三档（HMR row / cordis 运行时插件 / 面板"待生效重启"横幅）。

**P0-4 装 profile 写在 workspace 之外 → 沙箱拒绝。**
证据：`90f1e5ef` 里 `install-profile` 被拒后"申请最小放宽权限重试"（原文：*The profile install writes outside the workspace and was denied*）。`$DSH_HOME` 默认 `~/.dsh`。
代价：任何"agent 自改 profile 并生效"的闭环，在默认 `workspace-write` 沙箱下都会卡在权限上；若目标是全自动，必须给一个**在 workspace 内的落点**或一次性授权。
落点：profile 源留在仓库（现状正确），安装改为"由扩展主进程在编辑器侧执行"（它不受 agent 沙箱约束）或在面板上留一键；把"agent 只写仓库、安装与重启由宿主执行"写成口径。

**P0-5 `AGENTS.md` 超预算被静默截断，切掉的正是最新沉淀。**
证据：文件 68,322 B > `maxBytes` 65,536 B，实际注入 65,143 B；截断策略是"先整份丢掉更宽的、再截最具体的那份"，末尾 Notes 断在半句。
代价：**越沉淀越丢**——把新事实写进 `AGENTS.md` 反而会把它挤出窗口（并且没有告警）。这也是"知识层"最反直觉的一条。
落点：二选一——① 抬 `maxBytes`（profile patch 覆盖 `agent-instructions` row，`config` 是**整块替换**，要重述候选列表）；② **把工程 Notes 按主题拆进 `.agents/skills/*`（按需加载，不占常驻预算）**。推荐 ②，并给 `AGENTS.md` 一个"预算红线"自检（见 §6 第一批）。

### P1（重复付费 / 知识失真）

**P1-1 recipe 沉淀率 1/3，机制"存得住但没人存"。**
证据：3 次真实任务只有 1 条落盘；`78db6ce7` 有 `findRecipes`+`readRecipe`，**0 次 `saveRecipe`**（收尾 3 步全用在改 SKILL.md）。触发只有"文案 + 纪律 + 长代码回执提醒"三处；**工具 description 里的 `saveRecipe` 示例自身会被门禁拒**（缺 `returns`），而 skill 里那份是对的——两份文案不一致，模型按说明书写就被拒。
代价：cold start 仍在（同一类"搭 UI 树"任务每次从零重写）。
落点：§5 环路 B。

**P1-2 门禁有三处"假拒"，会教会模型"别存 recipe"。**
证据（`source/core/recipes.ts`）：① 绝对路径判据的正则会命中 `https://` 里的 `s:/`；② `params` 用数组写法说明会被写成空串 → 必判 `param-undocumented`；③ 官方示例缺 `returns`。另：参数使用检查是 `code.includes('args.'+key)`（`id` 会被 `args.identifier` 满足；`const {x} = args` 反被判没用上）；`MAX_RECIPE_DEPTH=4` 在 scene 侧**失效**（`depth` 形参从未被读）；`saveRecipe` 允许调用方自带 `verifiedAt`（唯一可信度信号可伪造）。
落点：修判据 + 加断言（每条门禁一个反例/正例）。

**P1-3 写路径助手全部缺失（13 个助手全是"读/量/探"）。**
证据：`prefabFromNode` / `internalAsset` / `resolveAsset` / `measureLayout` / `buildUI` / `editNodes` / `saveScene` / `setupEditBox|Button|Toggle` / `renderPreview` —— **全项目 0 命中**（上一轮分析就点名的 11 个，一个都没做）。
- 存预制件只能靠**未注入的宿主全局** `cce.Prefab.*`：`cce` 既不在 scene 注入清单、不在 `describe_api` 的助手表、也不在错误翻译的场景全局表里 → `ReferenceError: cce is not defined` **得不到任何上下文翻译**。
- `loadFrame` 恰好**明确拒绝** `db://internal/**`，而 skill 的整套 UI 搭法（"不许引用工程资源"）用的就是 `default_ui/*` → 模型必须退回手搓 `query-assets` + `loadAny({uuid})`（`78db6ce7` 的 9 步就是这么来的）。
- 没有 `saveScene`，`cocos_editor_state` 也不报"场景脏了没"；叠加"超时不留快照"，一次超时 = 未保存的半成品改动。
落点：按"判据可计算 + 正解是机械步骤"逐条封函数（见 §5 环路 C 与 §6 第二批）。

**P1-4 视觉验收仍是空洞：唯一的通道可能全白，"替代品"不存在。**
证据：`capture_view` 空图时回执已带 `view.*` 与"别再重试"的退路；skill 坑 5 进一步**禁止自建渲染器**；但被提议的 `renderPreview`（节点数据 → PNG）**从未实现** → `78db6ce7` 照旧写了 9 步 PowerShell GDI 渲染器。
代价：一次 UI 任务 20% 的预算花在"自己造眼睛"。
落点：**要么产品化 `renderPreview`（把那次手搓的 9 步变成一个函数）**，要么把"数值验收"做成一条**配方**（`worldRect` + 重叠/越界/对齐报告助手 + skill 里的固定套路），并在回执里直接给这条配方。当前是"禁止了旧路、没给新路"，最差的一档。

**P1-5 超时预算倒挂，超时后代码还在改工程。**
证据：编辑器沙箱允许 `timeoutMs` 到 **300 s**，bridge 只等 **120 s** 就 reject；`vm.timeout` 只管同步段，**没有抢占式取消**——模型收到超时并可能重试时，上一段代码**仍在往工程里写**。此外多处 `Editor.Message.request`（`scene:query-node-tree` / `snapshot` / `asset-db:query-assets`）**无超时**，包卡住则 Promise 永不 settle、handler 泄漏。失败时不登记快照 → 半成品 + 无 Ctrl+Z。
落点：统一预算（bridge ≥ 沙箱上限或沙箱上限 ≤ bridge-ε）、给所有跨包请求加超时、超时路径也要登记快照 + 回一条"可能改了一半"的显式 note。

**P1-6 知识层没有一致性校验 → 错事实能活 3 小时。**
证据：三条实录——① `SKILL.md` 曾把"`cc is not defined`"归因成 `snapshot:true` 的副作用（**错事实**），由另一次会话纠正；② 同一时刻 bridge 的 description 写"空图就再截一次"，而 engine 的提示写"别再重试截图"（**同一现象两条相反指令**）；③ 插件头注释说热重载，README 说不会。skill 里还有一处自相矛盾的候选（铁律 3 允许传 `snapshot:true`，验收清单要求"在代码里调 `snapshot()`"）。
代价：**错的事实比没有事实更贵**（skill 自己写了这句话），而它现在的保质期由"下一次被谁撞见"决定。
落点：§5 环路 A 的"事实 + 可执行 verify"。

**P1-7 能力基准不能无人跑通，也没有台账。**
证据：`assets/bench/` 与 `Bench.scene` 不存在 → oracle 磁盘判据必红；8/27 用例零自动检查；`score.mjs` 恒 `exit 0`（不能当门禁）；`--session` 不带 `--case` 时**27 条用例全部拿同一条会话打分**；`benchmark/cases.json` 硬编码 `D:\Project\cocos\jihe_defence`；只有 `combo-login` 一条有基线（38/100）。
代价：改了 skill/插件之后**无法自动回答"这次是变好还是变坏"**（这轮 38→62 是人肉对比出来的）。
落点：§5 环路 D。

### P2（健壮性与可观测性，挑要紧的）

1. **同一常量两份、无交叉校验**：`IPC_TAG`（`constants.ts:23` ↔ `index.js:54`）、`PROFILE_NAME`（`constants.ts:15` ↔ `install-profile.js:39`）、**图片预算**（README 声称 `images.ts` 是唯一真源，面板 `index.ts:126-131` 另有一份）、`projectKey`（`history.ts` ↔ `cases.json`）、zstd 帧扫描（`session-log.js` ↔ `score.mjs`）、面板选择器（`SELECTORS` 表 ↔ 6 处硬编码 `querySelector('#btn-*')`）。漂移时**测试仍全绿、运行时直接哑掉**（写错 tag 只表现为 120 s 超时）。
2. **广播快路从未被测**：面板用**私有 API** `Editor.Message.__protected__.addBroadcastListener`；`preview-panel.js` 的假 Editor 没有 broadcast/`__protected__` → 这条快路在所有验证里都不存在，降级成纯轮询也是静默的。
3. **可以静默通过的断言**：`verify-panel` 只查"字符串出现过"（注释掉的 handler 也过）、SELECTORS 靠行正则解析（写歪一条被丢弃仍报"全部通过"）；`verify-cocos-engine` 有两条是**对 `dist/*.js` 的字符串 grep**；**没有任何脚本比较 `source/` 与 `dist/` 的新旧**。
4. **`paths.ts:66` 的兜底路径双拼**：`join(NVM_SYMLINK ?? 'C:\nvm4w','nodejs','node.exe')`，本机 `NVM_SYMLINK=C:\nvm4w\nodejs` → 得到不存在的 `…\nodejs\nodejs\node.exe`。于是"PATH 探测失败 → 已知路径兜底"这条**恒为死代码**（无测试覆盖 `resolveRuntime`）。
5. **版本号三处不一致**：`constants.ts:12`（0.1.0）/ `install-profile.js:42`（0.2.0）/ 两个 `package.json`（0.1.0）；盘上版本戳是 0.2.0 → 无法用版本号判断"装的是哪一版内容"。默认模型写死并声称"与 `settings.yaml` 对齐"（实际从不读它）。
6. **面板运行时**：`starting` 期间按钮 disabled，而 `initialize` 超时 **180 s** → 首次启动最坏 180 秒**没有任何取消入口**；主进程转写上限 600 条，**面板侧 `state.entries`/DOM 无上限也不感知删除** → 长会话两边静默分叉；为"面板到底在不在轮询"设计的 `panelPoll` 计数**没进 `StateReply`**（面板看不到）；`stderrTail` 进了快照但**面板从不渲染**。
7. **死代码 / 空壳**：`sdk-client.malformed` 计数器零调用方（注释却宣称"状态里能看见"）；`AgentStatus.'installing'` 从不被设置；bridge 的 `evt` 帧通道无生产者；`ping` 控制帧只有测试在用。
8. **沙箱的诚实边界应更显眼**：`vm` 不是安全边界（注释已写），scene 侧**零隔离**（宿主 realm + `new Function` 回落路径连死循环都掐不断），editor 侧的 `process` 是裁剪视图但 `require('process')` 仍拿得到真的——"防手滑，不防越权"这个口径应该出现在**模型能看到的地方**（工具 description），而不只是源码注释。

---

## 5. 「自进化」设计：四条环路 + 一个分层原则

**分层原则（复用插件自己已经写好的那条）**：

> **判据可计算 + 正解是机械步骤 → 进插件（代码）**；
> **需要人策展的取舍与引擎版本事实 → 进 skill（文字）**；
> **跑通了的代码 → 进 recipe**；
> **运行时反射得到的东西 → 不存（`describe_api`）**。

自进化的目标就是：**让这三层各自有一个"写入触发 + 生效通道 + 门禁验证"的闭环**，并且**新增能力尽量落在"零重启"的那一层**。

### 环路 A｜事实环（症状 → 事实 → skill → 可验证）

- **现状**：机制**已经热**（agent 写 `SKILL.md`，下一步 catalog 就刷新），缺的是**触发**与**验证**：写完靠自觉、对错靠下一轮撞见。
- **设计**：
  1. **一条事实 = 一个块 + 一个可执行判据**。在 `SKILL.md` 里给每条"坑"加一行 `verify:`（能算的写成断言或探针片段），由 `scripts/verify-skill-facts.mjs` 汇总跑；**算不出来的显式写 `verify: manual`**（承认它是人策展）。
  2. **收尾触发**：会话结束/交付回复里，若本轮出现过"事实修正"（模型改了 `SKILL.md` 或会话里否决过一条既有事实），插件在回执里给一句提醒（与 recipe 提醒同一机制，成本为零）。
  3. **`AGENTS.md` 预算红线**：脚本断言"`AGENTS.md` < `maxBytes`"，超了就红（先把 P0-5 解决）。
  4. **禁止单方面改判据**：改 skill 正文可以，改 `verify:` 断言必须过 `verify-skill-facts.js`（避免"把事实改到自己满意的样子"）。
- **门禁**：`node scripts/verify-skill-facts.js`（新增）→ 失败列出"哪条事实与当前实现/引擎不一致"。
- **验收**：故意把 `SKILL.md` 里一条已知事实改错 → 脚本必须报出来（这条自测写进脚本自身）。

### 环路 B｜代码环（跑通 → 参数化 → 落盘 → 命中）

- **现状**：门禁严（好事）+ 无触发 + 三处假拒 + `verifiedAt` 语义失真 + 未入库。
- **设计（按性价比排序）**：
  1. **修假拒**：`returns` 示例补上；`params` 数组写法给出说明或直接拒得明白；绝对路径判据排除 `://`；参数使用检查支持 `args.x` 与解构。**每条门禁配一个正例 + 一个反例的断言**。
  2. **让回执直接给"可粘贴的成品"**：触发条件（已改场景 + 代码 ≥1200 字 + 未超时）保留，但回执内容从"提醒你存"升级为"**替你写好调用**"——插件从本次代码里抽出 uuid / 绝对路径 / `.tmp/` 命中项，生成
     `saveRecipe('<建议名>', <本次代码>, { description:'…', params:{…}, returns:'…' })`，并**在正文里列出被外置的参数**。模型只剩"要不要存"一个决定。
  3. **修 `verifiedAt` 语义**：`saveRecipe` 写入时记 `createdAt` 但不记 `verifiedAt`；`findRecipes` 把"从未跑通"与"超过 30 天"**分开标注**（现在 `null` 被当新鲜）。`saveRecipe` 不再接受调用方自带 `verifiedAt`。
  4. **会话级触发**：一次会话里出现 ≥2 次同构的 `execute_code`（同工具、代码相似度高、都改了场景）→ 提示"这段值得固化成 recipe"（比"单次长代码"更贴近真实复用场景）。
  5. **入库 + 冒烟**：把 `.dsh-mcp/recipes/` 纳入 git；把 `78db6ce7` 那次"任务界面建树"参数化后存成第 2 条 recipe（**空目录是这套机制最大的敌人**，上一轮已经吃过一次）。
- **门禁**：`saveRecipe` 门禁本身 + `node scripts/verify-recipe.js`（现有一次性脚本 `.tmp/verify-recipe.mjs` 可固化）。
- **验收**：连续两次同类任务（搭 UI 树）里，第二次 `findRecipes` 命中且**实际复用**（日志里出现 `runRecipe`），步数下降 ≥30%。

### 环路 C｜能力环（工具/助手自增长）—— 关键的一环

把"长本事"分成三档，**按下限到上限逐档打开**：

**C1｜动态 helper 目录（推荐先做，零重启、零风险）**
- 落点：**工程内** `.dsh-mcp/helpers/*.js`（与 recipes 同级，纯数据/纯函数，git 友好）。
- 机制：`engine.buildEditorHelpers` / `scene.makeHelpers` 在每次调用时**按需加载**该目录（`require` + 签名从文件头声明读取），合并进沙箱助手；`describe_api('helpers')` 自动包含它们（**已经在回沙箱问，不用抄清单**）。
- 价值：把"给插件加一个助手"从**重启编辑器**降为**写一个文件**。`loadFrame` / `worldRect` 这类"机械步骤"以后可以先生成在 helper 目录里跑通，再择机上提到 `dist/`。
- 门禁：① 语法 + 导出形状检查；② 必须声明 `params`/`returns`（与 recipe 同口径）；③ **禁止在 helper 里 `require('fs')` 直写工程**（沙箱本身有 fs，但"助手"要可 review）；④ 第一次被调用时在回执里注明"来自 `.dsh-mcp/helpers`"。
- 验收：新增 `.dsh-mcp/helpers/overlap-report.js` → **不重启任何东西**，下一次 `cocos_execute_code` 直接可用（顺带解决 P1-4 的数值验收）。

**C2｜运行时插件（cordis 运行时工具）**
- 事实：DSH 检出里 `@deepseek-ai/dsh-tool-cordis` + `@deepseek-ai/dsh-cordis-host-runner` **已安装但没有任何 bundle 挂载它们**（`dsh-tool-cordis/README.md:28` 明说"no shipped bundle mounts the toolset"，要显式加 row）。它给模型 7 个工具：`cordis_inspect_list/query/self` + `cordis_define/run/stop/undefine` —— **模型当场写一个 Cordis 插件包并跑在当前进程里**。
- 落点：`dsh-profile/cordis.patch.yml` 加两行 insert（`cordis-host-runner` + `tool-cordis`）。
- 注意（README 自己写明）：**定义只活在进程内存，DSH 重启即消失**，沙箱是"对诚实代码的约束、不是安全边界"。
- 因此配套两步：① **"提升"动作**：把跑通的运行时插件源码落进 `dsh-profile/plugin/`（仓库内，可 review/入库）→ ② `install-profile` → ③ 面板横幅"新工具待生效 → 重启 agent"（**把重启从"人记得"变成"面板提醒"**）。
- 价值：这是**唯一能让"工具面"在一轮对话内自增长**的机制；也是让 panel agent 自己把"每次都要人做的机械动作"变成工具的正路。

**C3｜打开模块级 HMR（让 bridge 改动免重启）**
- 事实（本轮查清）：`dsh-base/cordis.patch.yml:19-25` 的 `hmr` row 是 `disabled: true`，注释写明"Module reload is opt-in per profile"；`patchReload: live` 时 launcher 只建一个 **`root: []`（不监视任何模块目录）** 的 HMR 实例，仅用来盯 `cordis.patch.yml`。**这就解释了 README 坑 23 的实测结论**（"patchReload live 不会重跑 apply()"）——不是 HMR 不行，是**它没被开、且没给 root**。
- 落点：在 `dsh-profile/cordis.patch.yml` 里覆盖 `hmr` row（`disabled: false` + 给 `root` 指向 profile 的插件目录），然后**实测**：改 `dsh-cocos-bridge/index.js` → `install-profile` → 观察 stderr 是否出现新的注册日志且模型手里工具变化。⚠️ **这是一个 30 分钟的 spike，不是一个已证结论**：HMR 需要 `timer` 服务（base 里已挂），且它的 watch 根以插件 `baseUrl` 解析，要试准参数。若成功，P0-3 直接消失。
- 无论 spike 成败，都要**顺手修掉插件头注释里那句错的热重载说明**（P0-3 证据）。

**C4｜把机械助手补上（不必等 C1/C2）**
优先顺序（按 `78db6ce7`/`ad6ce9c2` 的实测代价）：
1. `prefabFromNode(node, url, {onExists:'overwrite'|'delete-first'|'rename'})` —— 封装 `cce.Prefab.createPrefabAssetFromNode`，**明确说明"原节点会被替换成实例"**，并把 `cce` 补进注入清单/助手表/错误翻译（现在 `cce is not defined` 没有任何翻译）。
2. `resolveAsset('db://internal/default_ui/default_btn_normal')` —— 编辑器侧按路径取 `{uuid, subAssetUuid, url}`，**支持 `db://internal`**（补上 `loadFrame` 明确不支持的那一半）。
3. `overlapReport(root, {canvas})` / `measureLayout` —— `worldRect` 的批量化：逐节点矩形 + 重叠/越界/零尺寸报告（把 s28–s34 的手写循环变成一个函数）。
4. `editNodes(spec)` —— **只改指定节点的属性**，不重灌整棵树（skill 纪律 1 说"实测整树重建 7 次 / 重复 54.7 KB"）。
5. `saveScene()` + 在 `cocos_editor_state` 里报"场景是否 dirty"。

> ⚠️ 一个**反直觉但重要**的耦合：现在"提醒存 recipe"的触发条件是 **代码 ≥1200 字**，也就是**在奖励"把整棵树一次写完"的巨型脚本**。等 C4 的 `editNodes` 到位后，**这个阈值必须跟着下调**（否则新助手会被旧激励抵消）。

### 环路 D｜回归环（改了之后，怎么知道变好了）

- **现状**：286 条断言（都是"假 Editor + 真 dist"的进程内自检）+ 一套**必须人工粘贴**的能力基准；无基线台账、无 CI、`exit 0`。
- **设计**：
  1. **一条命令**：`npm run verify`（串 5 个脚本）+ `npm run verify:dist`（**断言 `dist/` 不比 `source/` 旧**，现在完全没查）+ `npm run verify:skill`（环路 A）。
  2. **基准自动化（关键）**：面板 agent 与 CLI agent 用的是**同一个 profile / 同一套工具 / 同一份会话日志**——所以完全可以**用 CLI 起一个 headless 的 cocos-profile 会话跑用例**（`dsh --profile cocos` + `--prompt` 或 SDK 脚本），然后 `score.mjs` 认领同一份日志。**不需要把 prompt 粘进面板**。补齐 `assets/bench/` 与 `Bench.scene`（现在缺失，磁盘判据必红）或把那些用例改成"探针式"（回执里带断言结果）。
  3. **台账**：每次跑把 `{case, commit, score, steps, calls, recipes_used, recipes_saved}` 追加进 `benchmark/baseline.json`；**`score.mjs` 改为不达标退出码 1**（现在恒 0）。
  4. **失败 → artifact 映射**：给每个用例标注"它考的是哪一层"（skill 事实 / recipe / 引擎断言 / 面板），失败时直接指向该改哪个文件——这是把"分数"变成"动作"的唯一办法。
- **验收**：`npm run bench -- --case ui-basic` 一条命令跑完并写出台账；连续两个 commit 的分差可查。

---

## 6. 落地路线（三批）

### 第一批：先把桶底补上（今天就能做，几乎零代码）

| # | 动作 | 落点 | 验收 |
|---|---|---|---|
| 1 | **入库**：`extensions/dsh_chat/`、`.agents/skills/cocos-editor-ops/`、`.dsh-mcp/` | `.gitignore`（明确不忽略这几条）+ `git add` | `git ls-files extensions/dsh_chat | wc -l` > 0；`git status` 干净 |
| 2 | **`AGENTS.md` 预算红线**：脚本断言 < 65,536 B；把末尾 Notes 按主题拆进 `.agents/skills/`（skill 按需加载、不占常驻预算） | `scripts/`（新建，或用 `tools/`）| 会话开头不再出现 `Workspace instruction budget` 截断通知 |
| 3 | **修 3 处会误导的文案**：插件头注释的热重载说法、bridge description 的"再截一次"、`index.js` 里 `saveRecipe` 示例补 `returns` | `dsh-profile/plugin/dsh-cocos-bridge/index.js` | `node scripts/verify-bridge.js` 绿 |
| 4 | **常量单源化 + 交叉校验**：`IPC_TAG` / `PROFILE_NAME` / 图片预算 / 项目路径 | `verify-bridge.js` / `verify-panel.js` 加断言（消字面量副本） | 故意改一侧 → 测试必须红 |
| 5 | **把分析脚本固化**：`.tmp/dsh-evolution-metrics.mjs`（本轮的量化工具）移进 `extensions/dsh_chat/scripts/` | 同名目录 | `node scripts/session-metrics.mjs` 可复跑 |

### 第二批：让"能力"能零重启地长出来（插件侧，中等改动）

| # | 动作 | 落点 | 验收 |
|---|---|---|---|
| 6 | **C1 动态 helper 目录**（`.dsh-mcp/helpers/*.js`） | `source/core/engine.ts` + `source/scene.ts`（合并注入）+ `verify-cocos-engine.js` 加断言 | 新写一个 helper → **不重启**，下一次 `execute_code` 可用 |
| 7 | **C4 四个写路径助手**：`prefabFromNode` / `resolveAsset` / `overlapReport` / `editNodes`（+ `saveScene` 与 dirty 状态） | `source/scene.ts` / `source/core/engine.ts` / 助手签名表 | `verify-cocos-engine.js` 断言；`cce` 进注入清单后 `cce is not defined` 有翻译 |
| 8 | **P1-4 视觉退路二选一**：产品化 `renderPreview`，或把"数值验收配方"写死进回执 + 存成 recipe | `source/scene.ts` / `.dsh-mcp/recipes/` / `SKILL.md` 坑 5 | 复跑同类 UI 用例：**不再自建渲染器**（日志里 0 次） |
| 9 | **P1-5 超时统一**：bridge `DEFAULT_TIMEOUT_MS` ≥ 沙箱上限或反之；跨包请求全加超时；超时也登记快照 + "可能改了一半" note | `index.js:64` / `source/core/engine.ts:158` / `cocos-tools.ts` / `scene-bridge.ts` | 新断言：`timeoutMs > bridge 上限` 时**必须**在客户端先拒绝 |
| 10 | **环路 B 的四条**：修假拒 / 回执给可粘贴骨架 / `verifiedAt` 语义 / 会话级触发 | `source/core/recipes.ts` / `source/core/engine.ts` | 每条门禁一正一反断言；`78db6ce7` 的建树代码能一条命令存下 |

### 第三批：把闭环焊上（自进化的主体）

| # | 动作 | 落点 | 验收 |
|---|---|---|---|
| 11 | **环路 A**：`verify:` 事实断言 + `verify-skill-facts.js` + 收尾提醒 | `.agents/skills/cocos-editor-ops/SKILL.md` / `scripts/` | 故意改错一条事实 → 脚本红 |
| 12 | **C3 HMR spike**：开启 `hmr` row 并给 `root`，实测 bridge 改动能否免重启 | `dsh-profile/cordis.patch.yml` | 改 description → **不重启 agent** 生效（或明确记下"这条路当前不可用"并保留重启横幅） |
| 13 | **C2 运行时插件**：挂 `cordis-host-runner` + `tool-cordis`；配套"提升到仓库 + install-profile + 面板待生效横幅" | `dsh-profile/cordis.patch.yml` / `source/panels/default/index.ts` | 一轮对话内新增一个工具并调用成功；重启后按"提升"路径复现 |
| 14 | **环路 D**：`npm run verify` / `npm run bench`（headless 跑用例）/ 基线台账 / 非零退出 / 失败→artifact 映射 | 根 `package.json`（新增 scripts）/ `benchmark/` | 一条命令跑完并写出台账；不达标退出码 1 |

### 不建议做的（反模式）

- **不要上向量库/RAG**：这里的问题从来不是"检索不到"，而是"没写下来"和"写下来被弄丢"。recipe 的新鲜度机制（跑不通会当场报错）已经比 RAG 的"悄悄给过期结论"更可靠。
- **不要让 agent 无门禁地自动改写 skill**：写入通道要热，但**每条事实要能被验证**；否则只是把"错事实活 3 小时"变成"错事实活到永远"。
- **不要把编排逻辑搬进插件**：`Scene_Game_Stage` 那套"一个功能一个键"的经验在这里同样成立——插件只该干"判据可计算"的事，取舍留在 skill。
- **不要在真实场景里做实验 / 不要动 `cc.view.setDesignResolutionSize` / 不要硬啃编辑器安装目录**：这三条纪律已经写进 skill，是这套协作里最省时间的部分，别为了"自动化"把它们放宽。

---

## 7. 判据（怎么算改好了）

| 判据 | 现在 | 目标 |
|---|---|---|
| 同类 UI 任务步数 | 50 步（`78db6ce7`） | **≤25 步**（连续两次，第二次必须命中并复用 recipe） |
| recipe 沉淀率 | 1/3 条任务 | **≥2/3**，且 `findRecipes` 命中后**真跑** `runRecipe` |
| 自建渲染器 | 复现 2 次（16 步 / 9 步） | **0 次**（有 `renderPreview` 或数值验收配方） |
| 改插件后生效时延 | 重启编辑器（分钟级，要人动手） | 事实/recipe/helper **0 重启**；工具面 ≤ 一次 agent 重启且**面板提醒** |
| 能力开发会话里 `cocos_*` 调用 | **0 次**（`90f1e5ef` / 207 步） | **>0 且能自验**（至少 helper 那层） |
| 错事实存活时间 | 3 小时+（靠撞见） | **一次 `npm run verify:skill` 内被发现** |
| 知识注入丢失 | 每会话丢 `AGENTS.md` 尾部 | **0 截断**（或不截断 skill 化后的内容） |
| 回归 | 人肉粘贴 + 手抄分数 | **一条命令**跑完、写台账、不达标退出码 1 |
| 未入库文件 | 3 个未跟踪条目（`extensions/dsh_chat/` 62 文件 + 2 个目录） | **0** |

---

## 附录 A：证据与复现

| 证据 | 复现方式 |
|---|---|
| 三次真实任务 / 插件开发会话的步数、工具分布、recipe 使用 | `node .tmp/dsh-evolution-metrics.mjs`（本轮的量化脚本，见 §6 第 5 条建议固化）；单会话细账 `node .tmp/dsh-calls.mjs <session.jsonl.zstd>` |
| 会话日志位置与形态 | `$DSH_HOME/sessions/--D-Project-cocos-jihe_defence--/<id>/session.jsonl.zstd`（zstd 拼接帧；用 `extensions/dsh_chat/scripts/session-log.js list/read`，需 Node ≥22.15） |
| 286 条断言全绿 | `cd extensions/dsh_chat && node scripts/verify-cocos-engine.js`（58）/ `verify-panel.js`（112）/ `verify-images.js`（59）/ `verify-bridge.js`（57） |
| 基准 38/100 可复现 | `node benchmark/score.mjs --session ad6ce9c2-7c3e-428b-845c-038932c52934 --case combo-login`（会话 id 见 §2.1；本轮逐项复现 README 的 38/100） |
| profile 与仓库源一致 | 比 `SHA-256($DSH_HOME/profiles/cocos/node_modules/dsh-cocos-bridge/index.js)` 与仓库源；版本戳在 `.dsh-chat-profile.json` |
| HMR 未开 | `dsh-base/cordis.patch.yml:19-25`（`disabled: true`）+ `<dsh>/lib/profile-boot-*.js` 里 `patchReload==='live'` 时 `root: []` 的兜底实例 |
| `AGENTS.md` 截断 | 会话第一条 `Workspace instruction budget ...` 通知；`maxBytes` 在 `dsh-base/cordis.patch.yml`（65536） |
| 运行时插件未挂载 | `@deepseek-ai/dsh-tool-cordis/README.md:28` + `dsh-base/cordis.patch.yml` 中无该 row（包已安装于 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`） |

**未验证（诚实边界）**：编辑器内行为的真机复现（本机未开编辑器）；HMR 开启后是否真能免重启（列为 spike）；三个竞态（历史回放混入实时流、`dispose`/`resume` 交叉、恢复会话期间的早发消息）只做了代码路径分析，未运行时复现。

## 附录 B：自进化接线速查（可直接照抄的落点）

> 前提：profile 的组合顺序是 **bundle 层 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`**；**patch 语义是整块替换该 row 的 `config`（不深合并）**；`cordis.yml` 每次启动都会被重写成 `[]`，**只能改 `cordis.patch.yml`**。看默认行用 `dsh --profile cocos --dump-default-config` / `--dump-config`。

**① 打开模块级 HMR（对应 §5 环路 C3，先做 spike）** —— `dsh-profile/cordis.patch.yml`：

```yaml
# 覆盖 dsh-base 里那行 disabled 的 hmr（注意：patch 是整块替换 config）
- id: hmr
  disabled: false
  config:
    root: ['node_modules/dsh-cocos-bridge']   # 相对 hmr 插件的 baseUrl 解析；先试这一个，再试 ['.']
    debounce: 200
```

**验证步骤（30 分钟内可判定）**：① `node scripts/install-profile.js` → ② 面板里启动 agent，看 stderr 是否出现 `watching …` → ③ 改 `dsh-profile/plugin/dsh-cocos-bridge/index.js` 里某段 description 并再 `install-profile` → ④ 观察运行中的 agent 是否出现第二次「已注册原生工具」日志、且模型手里可见新描述。**成功 = P0-3 消失；失败就把结论写进 README 坑 23**（顺便把它与插件头注释的矛盾一起修掉）。

**② 挂运行时插件工具（对应 §5 环路 C2）** —— 同文件追加：

```yaml
- insert:
    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
      config: { vmTimeoutMs: 5000 }
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

注意：定义**只在进程内存**，DSH 重启即消失 → 配套"提升到 `dsh-profile/plugin/` + install-profile + 面板横幅提醒重启"三步，否则会变成"临时工具用完就丢"的假进化。

**③ 抬 `AGENTS.md` 预算（或改用 skill 承载，推荐后者）** —— 覆盖 `agent-instructions` row；因为 patch 整块替换 config，**必须重述候选文件列表**（`['AGENTS.md','CLAUDE.md']` + 叠加项），先用 `--dump-default-config` 抄一份默认行再改 `maxBytes`。

**④ 动态 helper 目录（对应 §5 环路 C1）** —— 契约草案（实现时按这个定）：

```
<工程根>/.dsh-mcp/helpers/<name>.js      # 纯函数、无 fs 写、无闭包状态
  /* @dsh-helper { "name": "...", "params": {...}, "returns": "...", "contexts": ["scene","editor"] } */
  module.exports = function (helpers) { return { myHelper(...) { … } }; };
```

加载点：`engine.buildEditorHelpers()`（editor）/ `scene.makeHelpers()`（scene）在**每次调用时**扫描目录并合并；`describe_api('helpers')` 自动包含（它已经是"回沙箱问清单"，不用抄）；回执里注明"来自 `.dsh-mcp/helpers`"。**收益**：把"给插件加助手"从重启编辑器降为写一个文件——这是"自包含 + 自进化"最划算的一跳。

## 附录 C：与上一轮结论的对照

| 上一轮（13:09 文档）的建议 | 现状 |
|---|---|
| 空白帧给可执行退路 + 回报视图状态 | ✅ 已落地（`engine.ts` + `readViewState`），但**替代品仍缺**（P1-4） |
| `cocos_editor_state` 的 `ok` 语义修正 | ✅ 已落地 |
| `findRecipes` 摆进"下一步"提示位 | ✅ 已落地（`78db6ce7` s2 真的调了） |
| skill 补坑 + 纪律 + 内置资源清单 | ✅ 大幅超出（423 行 / 8 坑 / 6 纪律）；⚠️ 但仍无一致性校验（P1-6） |
| recipe 复活并参数化 | ✅ 1 条 `build-login-ui-tree`；❌ **未入库**、沉淀率仍低 |
| 能力基准 | ✅ 建成 27 用例；❌ 不能无人跑通、无台账（P1-7） |
| **`prefabFromNode` / `internalAsset` / `measureLayout` / `setupEditBox` / `buildUI`（五个沙箱助手）** | ❌ **一个都没做**（P1-3） |
| **15 s 默认超时** | ❌ 未改，且与 bridge 的 120 s 形成倒挂（P1-5） |
| 把 `extensions/dsh_chat` / skills / recipe 入库 | ❌ 未做（P0-1） |
| 别把构建与验证焊死 / 增量改 | ❌ 未做（缺 `editNodes`） |
| 别在真实场景实验 / 别动全局视图状态 / 零进度可见 | ✅ 已写进 skill 纪律（文字层）；机制层未强制 |

**一句话**：上一轮的修法 100% 落在插件代码上，**知识层与"生长机制"没动**；这一轮的核心增量就是**把"生长机制"本身设计出来**——而且它不需要新造轮子：DSH 已经把 skill 热加载、cordis 运行时插件、HMR 开关都准备好了，缺的是**接线、触发和门禁**。
