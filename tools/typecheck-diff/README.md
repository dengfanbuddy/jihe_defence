# 类型检查基线门禁（typecheck-diff）

**回答的问题：「这次改动，有没有引入新的 TypeScript 类型错误？」**

一条命令回答，退出码就是答案：

```bash
node tools/typecheck-diff/check.mjs        # 0 = 没有新错误；1 = 有新错误；2 = 环境问题（跑不动）
```

---

## 1. 为什么要它：裸 `tsc --noEmit` 当不了门禁

本工程根目录跑全量 `tsc --noEmit`，**恒为红**：

```bash
node node_modules/typescript/bin/tsc --noEmit
# 实测：249 条 error，tsc 自身退出码 2
```

这 249 条是**历史噪声**，不是这次的改动：

| 噪声来源 | 典型错误码 | 说明 |
|---|---|---|
| `tools/excel_export/**` | `TS5097`、`TS2591`、`TS1343` | 导表工具的 Node/ESM 写法与游戏侧 tsconfig 不同一套（根 tsconfig 没配 `types: ["node"]`） |
| 旧 `platform/**` 等 | `TS2550`、`TS2304`、`TS2503` | `target: ES2015` 下 `Object.entries` 之类的缺库、旧代码的历史遗留 |
| 引擎声明文件 | `TS2304`、`TS2314` | `@types/jsb.d.ts`、`cc.d.ts` 在 `lib` 口径下自身的报错（如 `TypedArray`、`Map<T>`） |

结论：**"红了"这个信息量已经为零** —— 它区分不出「这次改坏的类型」和「三个月前就存在的类型」。
把 249 条清干净是另一件事（要动 `tsconfig.json` / 导表工具，风险大、收益低）；
在那之前，门禁要能回答的是**增量**问题，而不是"能不能编译"。

于是本工具引入**基线（baseline）**：把"已知的历史错误"冻结成一份可 diff 的文本，
之后只对**新增**的部分报警。

### 与"清干净"的关系

这不是"容忍烂代码"：基线是**只能变短、不能变长**的（变长要在 review 里显式说明）。
一旦哪天有人把某类历史错误清掉，跑一次 `--update` 基线就缩短；
而任何人**无意中引入**新错误，CI/本地立刻拿到退出码 1。

---

## 2. 怎么跑

```bash
# ① 比对基线（日常用这条）
node tools/typecheck-diff/check.mjs

# ② 当前错误全量写成新基线（唯一写盘入口）
node tools/typecheck-diff/check.mjs --update

# ③ 结构化输出：stdout 是纯 JSON，人读信息改走 stderr
node tools/typecheck-diff/check.mjs --json

# ④ 只看某类错误（诊断用）
node tools/typecheck-diff/check.mjs --filter assets/scripts

# ⑤ 单次 tsc 超时（毫秒，默认 900000 = 15 分钟）
node tools/typecheck-diff/check.mjs --timeout 300000

# ⑥ 帮助
node tools/typecheck-diff/check.mjs --help
```

不需要装任何依赖：只用 Node 内置模块，且**刻意不走 `npx`**
（`npx` 在依赖缺失时会联网自动安装，会污染环境、也会让"找不到 tsc"这种真问题被掩盖）。

tsc 入口按顺序找（可用环境变量 `TYPECHECK_TSC` 覆盖）：

1. `node_modules/typescript/bin/tsc`
2. `node_modules/typescript/lib/tsc.js`
3. `tools/excel_export/node_modules/typescript/bin/tsc`
4. `tools/excel_export/node_modules/typescript/lib/tsc.js`

实际执行的是 `node <上面找到的 tsc> --noEmit --pretty false`，工作目录 = 工程根。
`--pretty false` 是**必须**的：折叠/上色模式下输出不是"一行一条"，解析不到任何 `error TS` 行，
会被误判成"全绿"。

### 输出长什么样

```
▌类型检查基线比对（tools/typecheck-diff）
  · 工程根 : D:\Project\cocos\jihe_defence
  · tsc    : node_modules/typescript/bin/tsc
  · 基线   : tools/typecheck-diff/baseline.txt（249 条）
  · 开始全量 `tsc --noEmit`（实测数秒~数分钟，请稍候）…
  ✔ 全量检查完成，耗时 4.5 秒（tsc 退出码 2，错误 249 条）

▌摘要

✔ 基线 249 条 → 当前 249 条 → 新增 0 条（已消失 0 条） —— 没有基线之外的新错误（退出码 0）
```

出现新错误时：

```
▌新增错误
  ✘ assets/scripts/game/battle/Xxx.ts(42,9): error TS2322: Type 'string' is not assignable to type 'number'.

▌摘要

✘ 基线 249 条 → 当前 250 条 → 新增 1 条（已消失 0 条） —— 存在基线里没有的错误（退出码 1）
  · 处理：改代码修掉；确认是"合理的新错误"再跑 --update 并入基线
```

### 退出码（三条，别混）

| 码 | 含义 | 什么时候出 |
|---|---|---|
| 0 | **没有新错误** | 当前错误集合 ⊆ 基线 |
| 1 | **有新错误** | 存在基线里没有的错误行 |
| 2 | **环境问题**（没有结论） | 找不到 tsc / tsc 崩溃或超时 / 输出里一条 `error TS` 都没有但退出码非 0 / 基线文件不存在 / tsc 报出无位置的配置级错误 / 参数写错 |

**2 不是 0**：脚本宁可说"我没测出结论"，也不会把"跑不动"报成"全绿"。
另外注意 `tsc` 自己的退出码在有错误时本来就是 `1` 或 `2`，所以脚本**先看有没有解析到错误行**，
再看 tsc 退出码 —— 不会把"249 条错误"误判成"环境问题"。

---

## 3. 基线文件

`tools/typecheck-diff/baseline.txt`

* **普通文本、一行一条错误**、UTF-8、`\n` 换行、无 BOM、末尾一个换行 → 可入库、可 diff、可 review；
* **只由 `--update` 写入**；平时跑比对**绝不写盘**；
* 首次运行若文件不存在：**不自动创建**，而是提示「基线不存在，先跑 `--update`」并退出码 2
  （否则"第一次跑就全绿"会把 249 条历史错误一次性吞掉）；
* 排序：**路径 → 行号 → 列号 → 错误码**（路径按字节序比较，不用 locale 规则，保证跨机器稳定）；
* 去重：同一行文本只留一条（`tsc` 偶尔会对同一位置重复报同一句）。

### 一行是怎么"规范化"的

原始输出（受平台/终端影响）：

```
assets\scripts\game\battle\AttributeSystem.ts(42,46): error TS2550: Property 'entries' does not exist ...
```

归一成（存进基线的那一行）：

```
assets/scripts/game/battle/AttributeSystem.ts(42,46): error TS2550: Property 'entries' does not exist ...
```

三步：

1. `\` → `/`（去掉 Windows 反斜杠差异）；
2. 工程根内的绝对路径 → **相对工程根的 `/` 路径**；
   工程根**外**的绝对路径保持原样 —— 例如引擎声明 `C:/ProgramData/cocos/editors/Creator/3.8.6/.../jsb.d.ts`，
   跨盘符没法相对化（见下方"已知局限"）；
3. 消息里的连续空白折叠成一个空格并去首尾空白（tsc 的消息里可能带换行对齐）。

比对是**整行文本精确比对**（`Set` 判定），**不做模糊匹配、不做"行号漂移容忍"**。
所以插入/删除几行代码导致某些历史错误的**行号变了**，会被算成"新增 + 消失"各若干条 ——
这是刻意的取舍：模糊匹配会放过"同一行号换了个错法"的真回归。
遇到大范围行号漂移时，人肉确认后跑一次 `--update` 即可。

---

## 4. 基线怎么更新

```bash
node tools/typecheck-diff/check.mjs            # 先看清现在多了什么、少了什么
node tools/typecheck-diff/check.mjs --update   # 确认无误后再冻结成新基线
git diff tools/typecheck-diff/baseline.txt     # 基线 diff 必须是"能解释的"
```

**该更新基线的三种情况**

1. **错误消失了**（打印在「已消失的错误」一节，退出码仍是 0）—— 修好了一批历史错误，基线该缩短；
2. **新增的错误是"合理的"** —— 例如引擎/依赖升级带来的声明差异、`tsconfig` 口径变更
   （这类要在提交信息里写清"为什么这些新错误是可接受的"）；
3. **大范围行号漂移** —— 见上节。

**不该更新基线的两种情况**

1. 新增错误是**自己这次改代码引入的** → 去修代码；
2. 不想看那几条错误 → `--filter` 看诊断，或者去修，**别用 `--update` 把红变绿**。
   `--update` 是"承认这批新错误"的显式动作，它出现在 diff 里就该有人问一句为什么。

**别手改 `baseline.txt`**：手改会破坏排序/去重口径，下一次 `--update` 产生的 diff 会一片噪声。
要删就删对应的源码错误，然后 `--update`。

---

## 5. 已知局限（如实记录）

* **基线带机器相关路径**：工程根外的绝对路径原样入基线，其中包含 Cocos 编辑器安装路径
  （`C:/ProgramData/cocos/editors/Creator/3.8.6/...`）与依赖目录。**换机器/换 Cocos 安装位置/升级引擎版本**
  时，那部分行会整体变成"新增 + 消失"。对策：这类变更后跑一次 `--update`，并在提交信息里注明；
  换机器时基线应视为"本机基线"。
* **不做行号漂移容忍**（理由见 §3）。
* **基线快照的是"生成那一刻的工作区"**，包含未提交的改动。所以：基线生成时如果工作区是脏的，
  那批脏改动引入的错误就被"承认"进基线了（在别人看来 = 提前放行）。
  规矩：**基线跟着提交走** —— 在自己那批改动提交/落地之后再 `--update`，
  别在别人正在改的中间态上生成基线。
* **只覆盖根 `tsconfig.json` 这一套口径**：`tools/excel_export` 自己的 tsconfig 不在检查范围内
  （它的错误是被记进基线的那批历史噪声之一）。
* **不做增量/缓存**：每次都跑一次全量 tsc（实测 4~6 秒，见下），没有 `--incremental`/`tsbuildinfo`，
  避免"缓存过期导致漏报"这类最坏情况。
* **tsc 输出走普通文件而不是管道**：管道有 `maxBuffer` 上限，超了会被截断 → 错误少了 → **假的绿**；
  用文件重定向不存在截断。（同时也让脚本在禁止进程间命名管道的受限沙箱里能跑。）
  临时文件写在系统临时目录（不行则退回本目录），跑完立即删除；超过 64 MB 视为异常，退出码 2。

### tsc 全量跑一次的实测耗时

| 环境 | 命令 | 实测 |
|---|---|---|
| 本机（Node v24.9.0 / Windows，热缓存） | `node tools/typecheck-diff/check.mjs` | **约 4~6 秒**（tsc 本体 4.0~5.5 秒） |
| 本机 | `node node_modules/typescript/bin/tsc --noEmit` | 4.5 秒，249 条 error，退出码 2 |

原始任务描述里估的是"2~4 分钟"，**本机实测并没有那么慢**（多次运行 4~6 秒，无 `tsbuildinfo` 缓存）。
如果哪天它真的变成几分钟，用 `--timeout` 调大超时即可（默认已给 15 分钟）。

---

## 6. 自测记录（怎么证明它是有效的）

```bash
# ① 生成基线 → 比对必须 0
node tools/typecheck-diff/check.mjs --update     # 249 条，退出码 0
node tools/typecheck-diff/check.mjs              # 基线 249 条 → 当前 249 条 → 新增 0 条，退出码 0

# ② 反向自测：造一个真错，必须变红（不碰真源码）
printf "const x: number = 'abc';\n" > assets/scripts/__typecheck_diff_probe.ts
node tools/typecheck-diff/check.mjs              # ✘ ...__typecheck_diff_probe.ts(1,7): error TS2322...，退出码 1
rm assets/scripts/__typecheck_diff_probe.ts
node tools/typecheck-diff/check.mjs              # 回到 退出码 0

# ③ 语法自检
node --check tools/typecheck-diff/check.mjs
```

`--filter` **不是**反向自测手段（它只改打印、不改退出码口径），所以反向自测必须真的造一条错误。
