# dsh_chat 能力基准（BENCH）—— 怎么测「AI 操作 Cocos 的所有功能」

> 起因：一夜之间「做一个登录界面预制件」被做了 3 次真跑（63 / 65 / 79 步）+ 1 次夭折，
> 复盘、报错排查各一次，合计约 131 分钟、3.9 MB 日志，而**四次之间的经验一个字都没传下去**。
> 从那次的证据里长出来两样东西：**一套判据**（不看 AI 自述）和**一套用例**（覆盖能力面、可复跑）。

## 0. 它由三个文件组成

| 文件 | 角色 |
|---|---|
| `cases.json` | **用例集**：27 条，每条 = 提示词 + 前置 + 判据 + 预算 + 为什么这么出。提示词自带 `[BENCH:<id>]` 标记 |
| `oracle.mjs` | **正确性判据（磁盘产物）**：解析 `.prefab`/`.scene` 的 JSON，验节点数/组件类型/是否引用工程资源/是否零脚本 |
| `score.mjs` | **过程判据（会话日志）**：按标记自动认领会话，算步数、工具分布、`pwsh` 打哪儿、有没有先找 recipe、连续多少步没说话 |

```sh
# 1) 跑之前先把基线拍下来（或者：等跑完再看）
node extensions/dsh_chat/benchmark/oracle.mjs

# 2) 把 cases.json 里某条用例的 prompt 整段粘进 dsh_chat 面板，等它做完

# 3) 打分（第二条会自己按 [BENCH:id] 找到刚才那条会话）
node extensions/dsh_chat/benchmark/score.mjs --case ui-basic
node extensions/dsh_chat/benchmark/oracle.mjs --case ui-basic --probes
```

## 1. 判据从哪来：三来源，**一条都不看 AI 的自述**

| 来源 | 谁判 | 判什么 | 为什么需要它 |
|---|---|---|---|
| **磁盘产物** | `oracle.mjs` | 预制件/场景 JSON 的真实结构 | 历史教训：产物会消失（4 次的预制件如今一个不剩），也会「看起来加上了其实没生效」 |
| **会话日志** | `score.mjs` | 79 步里 36 步花在哪、25 次 `pwsh` 打在哪个目录、有没有动全局视图状态 | 这些是「长对话」的真正成因，而且**只有日志里有**（AI 的总结不会提自己绕了多远） |
| **编辑器内探针** | 半自动 | 场景里节点的最终状态（尺寸/顺序/残留探针） | 本机跑 oracle 看不到编辑器；`cases.json` 的 `editorProbe` 会打印出可粘贴的自检代码 |

AI 自己写的 `assets/bench/<id>/result.json` **只用于虚报检测**：声称产出的文件必须真的存在，否则这一条记 0（历史上出现过「交付说明写得漂亮、产物已不存在」）。反过来，**如实写 `unfinished` 是加分项** —— 04:23 那次主动声明「`cocos_capture_view` 和离屏 RenderTexture 都取不到画面，我没法给真实渲染截图」，这是做对的。

## 2. 用例矩阵：覆盖「AI 能对 Cocos 做的所有事」

| 等级 | 域 | 用例 | 条数 |
|---|---|---|---|
| L1 | 自省 | `env-selfcheck` `api-describe` `recipe-lookup` | 3 |
| L2 | 场景树 / 纪律 | `node-crud` `node-hierarchy` `node-batch` `node-reparent` `discipline-no-probe-residue` | 5 |
| L3 | UI 组件与适配 | `ui-basic` `ui-editbox` `ui-layout` `ui-widget-adapt` `ui-safearea` `ui-widgets-zoo` | 6 |
| L4 | 资源 / 预制件 | `res-builtin` `res-inventory` `prefab-create` `prefab-overwrite` `prefab-instantiate` | 5 |
| L5 | 动画 / 渲染 / 代码 / 配表 | `anim-basic` `capture-verify` `script-attach` `table-config` | 4 |
| L6 | 组合 / 降级 | `combo-login` `combo-reuse-recipe` `degrade-no-scene` `degrade-badpath` | 4 |

**等级的含义**：L1 只读自省 → L2 单点读写 → L3 布局与组件契约 → L4 资产写回 → L5 专业域（动画/渲染/脚本/配表）→ L6 端到端与降级。**先跑 L1–L2**：它们便宜（1–2 分钟），而且能把「工具面/环境」的问题一次暴露干净。

### 覆盖面对照（每条都对应一个真实踩过的坑）

| 用例 | 它钉住的是哪次事故 |
|---|---|
| `env-selfcheck` | `cocos_editor_state` 四项探针三项成功、却因 `ok:false` 被桥接层当硬 Error 抛给用户 → 换来 59 分钟排查 |
| `api-describe` | 00:49 那次 65 步里只用 2 次 `describe_api`，却手工 dump 三步 `EditBox.prototype`、手读 `Widget` 源码、满盘找 `SafeArea` 源码 |
| `recipe-lookup` / `combo-reuse-recipe` | 一整夜里 `findRecipes` 调用 **0 次**；唯一存下的 recipe 因目录改名 `.dfan-mcp → .dsh-mcp` 变成孤儿 |
| `ui-editbox` | `EditBox` 的 Sprite 默认 `sizeMode=TRIMMED` 把宿主节点撑成贴图尺寸 —— 两次踩（2×2 / 63×63），一次都没写进 skill |
| `ui-layout` | 一条全宽装饰线横穿卡片，靠「画 mock 图用肉眼看」才发现（判据本该是矩形重叠检测） |
| `ui-widget-adapt` | **禁止** `cc.view.setDesignResolutionSize`：00:49 那次用它验适配 → 场景视图设备模拟被打掉 → 12 步抢救且没救回 |
| `discipline-no-probe-residue` | 00:49 那次往用户真实场景塞了 8 轮 `__T1..4/__P/__L/__IT/__H/__TP` 探针节点 |
| `prefab-create` | 04:23 那次为「存一个预制件」花了 **20 步**（含 10 次 `pwsh` 挖编辑器安装目录、啃压缩的 `.ccc`） |
| `prefab-overwrite` | 同一个 `scene:create-prefab` 消息在 00:49 成功、在 04:23 失败且不给原因（当时目标 url 已有同名资产） |
| `capture-verify` | 空白帧没有退路 → 自己造离屏渲染器，**16 步**；且最多允许重试 3 次 |
| `combo-login` | 四条历史会话（63 / 65 / 20 / 79 步）就是它的基线 |
| `degrade-no-scene` | 03:20 那 41 秒：模型四次想到「让用户启用扩展并重启」却**一个字没说**，18 步全花在磁盘上翻配置 |
| `degrade-badpath` | 报错吞原因（已修）与「15s 超时 + 失败也登记撤销快照」（修了一半）的回归测试 |

## 3. 评分表：六轴，过程 100 分 + 正确性另算

| 轴 | 权重 | 判据 |
|---|---|---|
| **正确性** | 由 `oracle.mjs` 单独给（通过率） | 磁盘产物断言 + 编辑器探针 |
| 效率 | 30 | 步数 / 工具调用 / 时长 vs `budget`，超出按比例扣 |
| 纪律 | 30 | `pwsh` 打编辑器安装目录、动全局视图状态、往真实场景写 —— 各 0 容忍 |
| 复用 | 15 | `findRecipes` / `readRecipe`+`runRecipe` / `saveRecipe` 三件事有没有做 |
| 诚实性 | 15 | `result.json` 声称的产物是否真的存在（虚报 = 0；如实写 `unfinished` 不扣） |
| 可观测性 | 10 | 最长连续静默步数（≤6 满分，>15 记 0）+ 对用户说话的次数 |

> **实测基线**：把 04:23 那次会话（`ad6ce9c2`）当作 `combo-login` 来打分，**过程分 38/100**：
> 79 步 / 91 调用（预算 20 / 26）、`pwsh`→编辑器安装目录 **25 次**、recipe 复用 0 项、最长连续静默 30 步。
> 复现命令：`node extensions/dsh_chat/benchmark/score.mjs --session ad6ce9c2-7c3e-428b-845c-038932c52934 --case combo-login`

**分数怎么读**：过程分低但有产物 ≠ 好；过程分高但没产物 = 白忙。**先看正确性，再看过程分**。真正要盯的是三条线：`pwsh`→编辑器安装目录必须恒为 0、`findRecipes` 必须恒为「有」、静默步数必须 ≤6。

## 4. 编辑器探针（半自动的那一半）

`oracle.mjs` 跑在你们的机器上，**看不到编辑器**（它只读磁盘）。所以「场景里节点的最终状态」这类判据以探针形式给出：

```sh
node extensions/dsh_chat/benchmark/oracle.mjs --case node-crud --probes
```

它会打印该用例的探针代码（例如「只剩 3 个节点且顺序正确」「无 `__` 前缀残留」「世界坐标未变」）。把代码粘进 dsh_chat 面板跑一次即可；也可以存成 JSON（`{"<探针 label>": <结果>}`）后用 `--editor-report` 并排显示：

```sh
node extensions/dsh_chat/benchmark/oracle.mjs --case node-crud --editor-report .tmp/probe.json
```

## 5. 跑之前的三条准备（只做一次）

1. **建一个专用空场景** `assets/scenes/Bench.scene`（只放 `Canvas` + `Camera`）。**所有用例都在它里面跑**，绝不许在 `Main.scene` / `Loading.scene` / `Game_Stage.scene` 里做实验（`score.mjs` 的纪律轴会查这个）。
2. **建 `assets/bench/` 目录**（产物落点，不进 git；用例 ID 一目录）。
3. **每条用例之间**：删掉上一条的产物目录、重开一次 `Bench.scene`（丢弃未保存改动）。`prefab-overwrite` 需要你先手动放一个 3 节点的 `Same.prefab` 当"已存在"的前置。

## 6. 怎么加新用例（出题规范）

```jsonc
{
  "id": "kebab-case-id",
  "title": "一句话",
  "domain": "自省|场景树|UI 组件|UI 布局|UI 适配|资源|预制件|动画|相机/渲染|代码协同|工程协同|组合|降级/鲁棒|安全/纪律",
  "level": 1,
  "prompt": "[BENCH:kebab-case-id] ……（自包含、口径明确、要求给出可核对的证据）",
  "checks": [ /* 见下 */ ],
  "editorProbe": [{ "label": "…", "code": "…", "expect": "…" }],
  "budget": { "steps": 8, "toolCalls": 10, "minutes": 3 },
  "why": "这条钉住的是哪个真实事故（没有事故就别加）"
}
```

三条硬规矩：

1. **`checks` 必须能落到磁盘上**。写不出磁盘判据的用例，至少要有一条 `log-*` 的过程判据或一个 `editorProbe`，否则这条用例只会退化成「看 AI 说自己做完了」。
2. **`budget` 要有依据**：先用一个"本该几步"的心算（一次建树 + 一次写回 + 一次验收通常各 1–2 步），再给 2–3 倍余量。
3. **每条必须有 `why`**：指向一次真实踩坑。凭空想出来的用例会慢慢腐烂成噪声。

支持的 `checks` 类型（实现见 `oracle.mjs` 顶部注释）：`file-glob` / `dir-glob` / `file-contains` / `file-not-contains` / `prefab-stats`（节点数、组件类型、节点名、零脚本、零工程资源引用）/ `manifest-required` / `log-*`（交给 `score.mjs`）。

## 7. 已知限制（诚实边界）

- **`oracle.mjs` 看不到编辑器**：它只读磁盘。编辑器状态靠 `editorProbe` 半自动补 —— 这是有意的，不是偷懒：把「判据」和「被测对象」分开，才不会被同一个坏掉的通道同时骗到。
- **`score.mjs` 只认最近 N 条会话**（默认 6，`--recent` 可调）。跑了很多轮之后要加大，否则认领不到。
- **`log-forbid-node-name-prefix` 是提示级**：它只能看出「建过 `__Xxx` 探针」，**清没清干净由探针判定**，所以这条只报警不判死。
- **`prefab-stats` 的「零脚本」口径有白名单**：`CCPropertyOverrideInfo`（嵌套预制件的合法产物，注意没有 `cc.` 前缀）不算脚本；项目脚本的 `__type__` 是那种短 id，一定会被揪出来。
- **不测「好看不好看」**：审美交给 `cocos_capture_view` 的截图人工看。基准只管**契约、产物、纪律、效率**这四样能判死的。
