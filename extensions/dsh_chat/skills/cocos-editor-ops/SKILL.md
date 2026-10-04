---
name: cocos-editor-ops
description: 用 dsh_chat 扩展的 cocos_* 原生工具（Code Mode）操作 Cocos Creator 3.8.6 编辑器与场景：查/建/改场景节点与组件、批量改资源、存预制件、跑通后固化成 recipe。当用户要求「在编辑器里做点什么」——建场景/预制件、批量改节点、按契约搭 UI 骨架、查资源引用、读配表——时使用。含 9 条实测踩过的坑（gizmo 污染场景树、cc.find 找不到含斜杠的节点、存预制件的两条路子与副作用、EditBox 把节点撑成贴图尺寸、截图整帧空白、`cc is not defined` = context 选错、三个静默改数据的 UI 组件、编辑态两个不可信的查询手段、Widget 单边对齐回写漂移）与 6 条纪律（增量改/别在真实场景实验/别动全局视图状态/失败别静默/别硬啃编辑器安装目录/丢代码前先榨事实）。
---

# Cocos Creator 编辑器操作（dsh_chat 的 cocos_* 工具 / Code Mode）
<!-- fact: bundled-skill-wired | verify: script:bundled-skill-wired | 断言 dsh-host.ts 真的注入了 DSH_BUNDLED_SKILL_DIR，且本文件在位 -->
<!-- fact: no-shadowing-skill | verify: script:no-shadowing-skill | 断言消费工程里没有同名的 cocos-editor-ops（有就会整体覆盖本文件） -->
<!-- fact: bundled-skill-end-to-end | verify: manual | 开 Cocos 编辑器 → 面板启动 agent → 看会话开头的 skill catalog / `skill` 工具列表里有没有 cocos-editor-ops。上面那条 script 锚点只证明「代码接了线」，**没证明 DSH 真扫到了** -->

> **这个 skill 管什么**：Cocos Creator 3.8.6 的**引擎/编辑器行为** + **`dsh_chat` 插件自身的边界**。
> 它随插件发布（DSH 的 bundled skill 根），所以**换项目也照样生效**。
>
> **它不管什么**：具体项目的业务约定 —— 设计分辨率取哪个、节点怎么命名、允不允许引用工程资源、
> 数值口径是什么。那些属于**项目自己的 skill 或 `AGENTS.md`**。
>
> ⚠ **同名会被「整体覆盖」而不是「合并」**：DSH 的 skill 按名字去重，**rank 小的赢**
> （`dsh-skill-filesystem`：工程 `.agents/skills` = 200 → 用户 `~/.agents/skills` = 500 →
> 本 skill 的 bundled 根 = 600）。所以**工程里不要再放一个同名的 `cocos-editor-ops`** ——
> 那会把这里全部 9 条坑一起吃掉。要写项目专有约定，**另起一个名字**（如 `mygame-ui-conventions`）。

## 何时使用

- 用户要求在**编辑器里**做事：建/改场景、预制件、批量改节点属性、按契约搭节点树。
- 需要**批量**改资源或读配表（比手工点快，也比写一次性脚本可复用）。
- 不确定某个引擎 API 的准确属性名/方法名，需要**先查再写**。

**不适用**：纯 TS 代码改动（那直接改源码）。

## 工具面：只有 4 个 tool
<!-- fact: tool-count | verify: script:tool-count-is-4 | 断言 bridge 里 ctx.tools.register 正好 4 次 -->

编辑器执行能力由 **`dsh_chat` 扩展自带**（沙箱与场景脚本都在它里面，见
`extensions/dsh_chat/source/core/engine.ts` + `source/scene.ts`）。

| 工具 | 用途 |
|---|---|
| `cocos_execute_code` | 主工具。写 JS，跑在指定上下文，返回它 `return` 的值 |
| `cocos_describe_api` | 按需查编辑器/引擎 API，**不要猜** |
| `cocos_editor_state` | 会话开头/卡住时探一次：在哪个工程、选中什么、能不能动场景 |
| `cocos_capture_view` | 把**编辑器场景视图**截成图片文件、回路径（改完布局想看一眼画面时用） |

### 两个上下文先选对

| | `context:"editor"` | `context:"scene"` |
|---|---|---|
| 进程 | 编辑器主进程（Node.js） | 引擎场景进程 |
| 可用 | `Editor.*` / `require` / `fs` / `path` | `cc` / `director` / `scene` / 场景助手 |
| 管什么 | 资源（asset-db）、工程设置、构建、读盘 | 节点、组件、运行时对象 |

**口诀：改文件/查库 → editor；碰节点/组件 → scene。**

> **`context` 永远显式写。** 漏给时插件会按代码里的标识符猜（含 `cc`/`nodeByPath` → `scene`）
> 并在回执里注明 `contextInferred`，但那是兜底、不是许可 —— 猜错的症状见坑 6。

### 场景侧的两个「别再手搓」助手（插件已封好）

| 助手 | 取代什么 |
|---|---|
| `await loadFrame('db://assets/…/x.png')` | 取代「editor 查 `query-asset-info` 拿 `@f9941` → scene `loadAny({uuid})`」两步走；`cc.resources.load('…/spriteFrame')` 在编辑器场景里**必失败**（坑 8） |
| `worldRect(node, { root })` | 取代 `getBoundingBoxToWorld()`（编辑态不可信）与自己手写锚点累加（坑 8） |

## 铁律

### 1. 不要猜 API —— 先 `cocos_describe_api`

```js
// 想知道 cc.Camera 有哪些属性、当前值是多少（带 nodeUuid 会补出真实实例）
cocos_describe_api({ context: "scene", target: "cc.Camera", nodeUuid: "<节点uuid>" })
cocos_describe_api({ context: "editor" })                          // Editor 命名空间总览
cocos_describe_api({ context: "editor", target: "helpers" })       // 沙箱助手函数签名
cocos_describe_api({ context: "editor", target: "module:fs" })     // 某个 node 模块的导出
```

猜属性名 = 白跑一趟 + 可能踩出难查的静默失败。

### 2. 在沙箱里筛完，只 return 结论

返回值有上限（深度 6 / 数组 100 / 对象 60 键 / 字符串 4000），而且
**cc 对象会被压成 `[Node name=x uuid=y]` 摘要**：

```js
// ❌ 你只会拿到一行摘要
return scene;
// ✅ 在代码里筛，只把结论带出来
const names = [];
eachNode(n => { if (n.getComponent(cc.Label)) names.push(n.name); });
return { count: names.length, sample: names.slice(0, 5) };
```

要看细节用 `dump(node)`（显式取字段、不会循环引用炸掉）或 `tree()`（层级骨架）。

### 3. 改完场景必须登记撤销

```js
const n = nodeByPath('Canvas/Panel');
n.setPosition(0, 100, 0);
snapshot();               // ← 登记一次撤销快照
return { ok: true };
```

也可以给 `cocos_execute_code` 传 `{ snapshot: true }` 无条件登记。

---

## 坑 1：场景树里 97% 的节点不是你的内容
<!-- fact: pit-1-editor-nodes | verify: script:prune-reports-hidden | 断言 source/scene.ts 仍回 editorChildrenHidden -->

**症状**：`eachNode` / `tree()` 回一堆 `xAxis` / `Rectangle` / `Plane` / `LinesNode` / `gizmoRoot`，
模型照着这些名字去推断游戏结构，然后写错。

**实测**（Cocos Creator 3.8.6，一个只有 `Canvas` 的空场景）：

| 场景级根 | 节点数 | `objFlags` | layer |
|---|---|---|---|
| `Canvas` | **2** | 0 | `UI_2D` |
| `Editor Scene Foreground` | 117 | **1096** | `DEFAULT` |
| `Editor Scene Background` | 8 | **1096** | `DEFAULT` |
| 合计 | **128**（真实内容只占 2） | | |

### 判据：`HideInHierarchy` 位 —— 但**只能用在剪枝上**

```js
const HIDE_IN_HIERARCHY = cc.CCObject.Flags.HideInHierarchy;   // = 1024
const isEditorRoot = (node) => (node.hideFlags & HIDE_IN_HIERARCHY) !== 0;
```

`hideFlags` 是 `CCObject` 的公开访问器（内部已 `& AllHideMasks`）。
`1096 = HideInHierarchy | DontDestroy | DontSave`。

⚠ **`gizmoRoot` 自身的 `objFlags` 是 0** —— 那个位**只在两个场景级根上**。
所以必须**剪掉根**（整棵子树自然都没了），**逐节点过滤会漏掉整棵 gizmo 子树**。

### 两条被实测否掉的直觉（别再走一遍）

- ❌ **按 layer 掩码滤**：编辑器根 `Editor Scene Foreground` 与真实相机 `Canvas/Camera`
  **同为 `Layers.DEFAULT`(1073741824)**；gizmo 子树里还混着 `5242880`、`16777216`。
  按层滤会**误伤真实节点**。
- ❌ **按节点名滤**（`gizmoRoot` 之类）：名字是实现细节，而且覆盖不了 `Editor Scene Background` 那棵。

### 现在由插件兜住了（但你要知道边界）

`eachNode(visit, root?, {includeEditor}?)` 与 `tree({...})` **默认剪枝**，
并在有子节点被藏时回一个 `editorChildrenHidden: N`（不静默）。
`isEditorNode(node)` / `contentChildren(node?)` 可直接用。

- 需要连 gizmo 一起看（极少见）→ 传 `includeEditor: true`。
- `nodeByPath` 是**显式点名**，**不受剪枝影响**。

---

## 坑 2：`cc.find` 找不到名字含 `/` 的节点，而且是**静默返回 null**
<!-- fact: pit-2-ccfind-slash | verify: script:nodebypath-greedy | 断言 source/scene.ts 仍是贪心按段匹配 -->

**症状**：明明在层级面板里看得到，`cc.find('a/b/c')` 却返回 `null`，
调用方以为「节点不存在」而走了错误分支。

**原因**：`cc.find` 按 `/` 切开逐层 `getChildByName`，于是**节点名本身含 `/`** 的路径永远解不开。

**实测存在的例子**：`internal/editor/grid-2d`、`internal/editor/grid`（编辑器自己生成的）。

**修法**：`nodeByPath(path)` 内部先用 `cc.find`，失败再**贪心按段匹配** ——
每层从「最长的一段」开始试，先把 `internal/editor/grid-2d` 整体当一个节点名试，
不行再退化成 `internal` → `editor` → `grid-2d` 三层。

```js
nodeByPath('Canvas/weird/name/deep')                                  // ✅ 解析得到
nodeByPath('Editor Scene Foreground/gizmoRoot/internal/editor/grid-2d') // ✅ 整段即节点名
cc.find('Canvas/weird/name/deep')                                     // ❌ null
```

**自己写遍历代码时注意**：别用 `cc.find` 拼路径，用 `nodeByPath`；
路径里带了斜杠时要意识到可能是「节点名的一部分」而不是层级分隔。

---

## 坑 3：存预制件没有「一个标准调用」，而且失败**不给原因**
<!-- fact: pit-3-prefab-apis | verify: manual | 真编辑器里两条路各试一次，看失败回执给不给原因 -->

实测两次结果**不一样**，这点必须先知道：

| 路子 | 怎么走 | 实测 |
|---|---|---|
| 编辑器消息 | `Editor.Message.request('scene','create-prefab', nodeUuid, url)` | 有时**能成**（第一次尝试成功 3 次）；目标 url 上**已有同名资产**时失败，回 `The thing you want to instantiate is nil`，**没有任何解释** |
| 场景门面（**更稳**） | `await cce.Prefab.createPrefabAssetFromNode(nodeUuid, 'db://assets/xxx.prefab')` | 在 `context:'scene'` 里直接可用，返回资产 uuid |

```js
// context: 'scene' —— 推荐这条
const root = nodeByPath('Canvas/MyPanel');
const uuid = await cce.Prefab.createPrefabAssetFromNode(root.uuid, 'db://assets/prefabs/MyPanel.prefab');
return { uuid, stillInScene: !!nodeByUuid(root.uuid) };
```

三条必须记住的副作用与边界：

- **原节点会被替换成该预制件的实例**（`nodeByUuid(旧uuid)` 变 null）—— 场景里不是"多了一个实例"，是**那个节点变成了实例**。
- **目标 url 已存在时的策略要自己定**：覆盖（先 `asset-db delete-asset` 再建）/ 另存到新 url / 先查 `query-asset-info` 再决定。**不要反复重试同一个调用**。
- 存完**按文件核验**（见「验收清单」），别只看返回值。

`create-prefab` 失败时**不要去啃编辑器的安装目录**（见「纪律 5」）。

---

## 坑 4：`EditBox` 会把宿主节点撑成贴图尺寸（踩过两次）
<!-- fact: pit-4-editbox-sizemode | verify: manual | 真编辑器里建 EditBox 赋帧，回报 contentSize 有没有被贴图改掉 -->

**症状**：`addComponent(cc.EditBox)` 或给它的背景 Sprite 赋 `spriteFrame` 之后，输入框节点的
`contentSize` 变成贴图的原始尺寸（实测变成过 **2×2** 和 **63×63**），标签排版跟着全错。

**原因**：`cc.Sprite.sizeMode` 默认是 `TRIMMED` —— 赋值 `spriteFrame` 时按贴图尺寸改宿主节点。

**修法**：**先把 `sizeMode` 设成 `CUSTOM`，再赋 `spriteFrame`，最后复位 `contentSize`**。
同一个顺序对**所有** Sprite 都成立（普通图片节点、九宫格、按钮底图都一样），
只是 EditBox 会**自己建**一个背景 Sprite，所以特别容易漏。

**EditBox 自己建的两个子节点叫 `TEXT_LABEL` 与 `PLACEHOLDER_LABEL`**（`n.getChildByName('TEXT_LABEL')` 直接能取到）——
要规整字号/颜色/对齐就改它们；它们同样是 `UITransform` + `Label`，锚点一般设成 `(0, 1)`。

```js
const sp = node.addComponent(cc.Sprite);
sp.sizeMode = cc.Sprite.SizeMode.CUSTOM;   // ← 必须在 spriteFrame 之前
sp.type = cc.Sprite.Type.SLICED;           // 九宫格
sp.spriteFrame = frame;
node.getComponent(cc.UITransform).setContentSize(w, h);
```

**验收**：把最终 `contentSize` 报出来（比如 `480×80`），别只看"没报错"。

---

## 坑 5：`cocos_capture_view` 可能整帧空白 —— 先量，别硬试，别自建渲染器
<!-- fact: pit-5-blank-capture | verify: script:capture-reports-viewstate | 断言回执仍带 view.visibleMatchesDesign -->

**症状**：回执里 `blankRatio` 接近 `1`，像素全 0。

**它不是"环境不支持"** —— 实测的真相是：有人为了「模拟设备高度验适配」调过
`cc.view.setDesignResolutionSize(...)`，把**编辑器场景视图的设备模拟打掉了**
（`visible` 从 `750×1334` 变成 `750×559.35`），此后每次截图都是白纸。

**现在的回执里带了视图状态**：`view.visibleSize` / `view.designResolution` / `view.visibleMatchesDesign` /
`view.canvas`。**先看这几个数**：

- `visibleMatchesDesign: false` → 大概率就是设备模拟被改过。**恢复入口在编辑器 UI**：
  场景视图工具栏重新选一次设备分辨率（或拖一下场景面板）—— 纯视图设置，不影响场景与预制件数据。
- 与设计分辨率一致却仍然空 → 才去怀疑"这个环境下确实拿不到帧"。

**三条纪律**：① **不要反复重试截图**（换 `waitMs`、`select`、`focus-camera` 都不会变）；
② **不要动 `cc.view.setDesignResolutionSize` / `setFrameSize`**（见纪律 3）；
③ 需要肉眼确认时，按**节点真实数据**出一张布局对照图，并在交付里**如实声明「真实渲染截图未完成」**。

---

## 坑 6：`ReferenceError: cc is not defined` = **context 选错了**（旧版记的「`snapshot: true` 的副作用」是错的）
<!-- fact: pit-6-context-cc | verify: script:context-inference | 断言 engine.ts 仍推断 context 并回 contextInferred -->

**症状**：一段明明能跑的构建脚本（用 `cc` / `nodeByPath` / `tree()`）报 `ReferenceError: cc is not defined`，
**而且一个节点都没建出来**（不是"建完再报错"）。

**真因**：这次调用**没给 `context`**，于是跑在 `editor` 沙箱里 —— 那里只有 `Editor` / `require` / `fs`，
**没有 `cc`**。判据只有「有没有给 context」这一条。

**⚠ 曾经记成「`snapshot: true` 让代码跑在没有 cc 的上下文里」—— 那条是错的，别再按它排查。**
`snapshot` 只是「跑完之后额外登记一次撤销快照」，代码照样跑在 scene 沙箱里、`cc` 照样在
（`scripts/verify-cocos-engine.js` 里就有一条 `context:'scene' + snapshot:true` 的断言是绿的）。
当时之所以误判，是因为两次对照调用**不只差这一个参数**（另一次同时漏了 `context`）——
「换一个变量做对照」是好手法，但前提是**只换那一个变量**。

**现在插件自己兜住了**（`engine.executeCode`）：

- **漏给 `context` 不再静默落到 editor**：按代码里的标识符推断（含 `cc` / `nodeByPath` / `tree(` → `scene`），
  并在回执里带 `contextInferred: true` + 一条 note 说明依据 —— 推断不等于你可以不写；
- **真选错了会给出改法**：错误信息里直接写「`cc` 是场景上下文才有的 → 改成 `context: 'scene'`」，
  不再只回一句 `cc is not defined`。

**实测代价（2026-09-30 17:45 那条会话）**：模型在没有上面这套兜底时，为这一条错误做了 **10 步**
对照实验（怀疑 `args` 改了执行环境、怀疑代码太长被截断、怀疑 scene 进程丢了 `cc`、
最后错记成 `snapshot: true` 的副作用），一步都没往「我没写 context」上想 —— **50 步的预算里 10 步花在这**。
所以：**写代码时永远显式带上 `context`**（口诀：改文件/查资源库 → `editor`；碰节点/组件 → `scene`）。

## 坑 7：三个"静默改你数据"的 UI 组件
<!-- fact: pit-7-silent-ui-components | verify: manual | 真编辑器里探 cc.Layout 的键；若真有 HorizontalAlign 说明这条过期 -->

| 组件 | 它干了什么 | 正解 |
|---|---|---|
| `cc.Button`（`transition = COLOR`，**默认值**） | 把**同一个节点上** Sprite 的 `color` 覆盖成 `normalColor`（默认白）—— 你先 `sprite.color = 青` 再 `addComponent(Button)`，底色就变白，且**不报任何错** | 底色写进 `button.normalColor`（配 `hoverColor`/`pressedColor`），别只改 sprite |
| `cc.ScrollView` | 把 `content.position.x` **绝对赋值**为 `(contentWidth - viewWidth) * 0.5` —— 这个公式假设 **content 的 `anchorX = 0`**；而常规摆法 content 锚点是 `0.5`，于是 content 与所有子节点被整体推偏（实测 690 宽 content 放进 710 宽 view → 全体左偏 10px，左右边距 30/50 不对称） | 让 **content 宽 = view 宽**（这时修正量恒为 0），或把 content 锚点改成 `(0, 1)` 并把 `position.x` 设为 `-viewWidth/2`。改完调一次 `sv._calculateBoundary()` 复核，连调两次值不变才算稳 |
| `cc.Layout` | **`cc.Layout.HorizontalAlign` / `VerticalAlign` 在 3.8 不存在** —— `Object.keys(cc.Layout)` 里只有 `Type/VerticalDirection/HorizontalDirection/ResizeMode/AxisDirection/Constraint`（两次实测：技能记录 + 2026-09-30 会话里模型自己 probe 了一遍），写了就是 `Cannot read properties of undefined (reading 'CENTER')` | ① **多数情况根本不用写**：`alignHorizontal` 默认已是 `CENTER`（横向排列时"居中"就是常见诉求）；② 真要改：`cc.HorizontalTextAlignment`（`LEFT=0 / CENTER=1 / RIGHT=2`）**确实是 `cc` 模块的顶层导出**（已按引擎声明文件核实：`declare module "cc"` 里的 `export enum HorizontalTextAlignment`），但**"赋给 `layout.alignHorizontal` 是否生效"没实测过** —— 声明文件把该属性写成 `boolean`（可疑），所以别当结论用：先 `cocos_describe_api({context:'scene', target:'cc.Layout', nodeUuid:'<一个真 Layout 节点>'})` 看真实类型/当前值，或先赋值再 `return { value: layout.alignHorizontal }` 复核 |

## 坑 8：编辑态下两个"看着能用其实不可信"的查询手段
<!-- fact: pit-8-editor-untrusted-queries | verify: script:loadframe-rejects-internal | 断言 scene.ts 的 loadFrame 仍显式拒绝 db://internal -->

- **`UITransform.getBoundingBoxToWorld()` 在编辑态给过自相矛盾的值**：同一棵树里 `view`
  （实测 `contentSize` 710×1074、position (0,0)）被报成 **710×1170**，而 1170 恰好是它子节点
  `content` 的高度；`content` 的 x 也被报偏。**结论**：布局验收别用它 ——
  **现在有现成的助手 `worldRect(node, { root })`**（按 `position` + `anchor` + `contentSize`
  自洽累加，返回 `{cx, cy, width, height, left, right, bottom, top}`，并自带原点口径说明），
  文档里那套"自己累加世界坐标"的手工活不用再写了。`root` 传 `Canvas` 就是「这张卡在 Canvas 里偏了多少」。
- **`cc.resources.load('textures/x/spriteFrame', cc.SpriteFrame, cb)` 在编辑器场景上下文里报
  `Can not parse this input:{"path":...,"bundle":""}`**（`cc.resources` 这一档没被正确初始化）。
  **正解**：**用助手 `await loadFrame('db://assets/.../x.png')`** —— 它自己去读 `.meta`
  里的 spriteFrame 子资源、替你补 `@f9941`、缓存结果，失败时抛出「试过哪些候选、各拿到什么类型」。
  也接受 `'<uuid>@<子资源键>'` 与裸 uuid。**别再手工两步走**（editor 查 `query-asset-info` → 拿
  `subAssets['f9941'].uuid` → 场景侧 `loadAny({uuid})`），那是这个助手出现之前的绕法。
  ⚠ `query-assets` 用 `pattern: '...x.png/spriteFrame'` 查 **返回空数组**（不报错），别以为"没有这个子资源"。

---

## 坑 9：Widget 的**单边对齐**会在回写时漂移 —— 贴边的一排东西改用 Layout
<!-- fact: pit-9-widget-one-side-align | verify: manual | 真编辑器里同一节点分别用「只开 bottom」与 Layout(BOTTOM_TO_TOP) 各摆一次，比 y -->

**症状**：只打开单边对齐（比如 `isAlignBottom`）的横条，在 `updateAlignment()` 与后续回写之后位置会漂，
跟子节点高度对不上；同一份代码重跑一次，结果还可能不一样。

**修法**：**贴边的一排东西别用单边对齐，改用 `cc.Layout` 排**：

```js
const lay = bar.addComponent(cc.Layout);
lay.type = cc.Layout.Type.VERTICAL;
lay.verticalDirection = cc.Layout.VerticalDirection.BOTTOM_TO_TOP;   // 从下往上堆
lay.horizontalDirection = cc.Layout.HorizontalDirection.LEFT_TO_RIGHT;
lay.resizeMode = cc.Layout.ResizeMode.NONE;                           // 容器尺寸自己管
lay.paddingBottom = 24; lay.paddingLeft = 30; lay.paddingRight = 30;
lay.spacingY = 6;
// 子节点挂完之后**必须显式调一次**，否则这次排版没生效：
lay.updateLayout(true);
```

**Widget 的正确写法**（一次真跑通的搭树脚本里定下来的形状，别各自发明一套）：

```js
const w = n.addComponent(cc.Widget);
w.alignMode = cc.Widget.AlignMode.ALWAYS;
// 只打开**显式给了值**的那些对齐项
for (const key of ['Left', 'Right', 'Top', 'Bottom', 'HorizontalCenter', 'VerticalCenter']) {
    const prop = key[0].toLowerCase() + key.slice(1);
    if (cfg[prop] != null) w['isAlign' + key] = true;
}
for (const key of ['left', 'right', 'top', 'bottom', 'horizontalCenter', 'verticalCenter']) {
    if (cfg[key] != null) w[key] = cfg[key];
}
w.updateAlignment();
```

**两条口径 —— 老实说清哪条是「引擎行为」、哪条只是「某次搭树的取舍」**：

- **单边对齐在 Widget 回写时会漂移** → 上面那段 Layout 写法的由来，**实测踩到过**。这是引擎行为，可以直接依赖。
- **只用「四边拉伸 + 居中」两种对齐** → ⚠ **这是某次搭树的取舍，不是引擎规则。**
  它够用、且避开了这类漂移，**照做可以，但别当成因果结论往外推** ——
  别的项目要不要收敛到两种，由那个项目自己定。
- 设计分辨率**别背数字**：开局查一次 `cc.view.getDesignResolutionSize()` 就知道；
  而且它属于「编辑器的东西」，不许改（纪律 3）。

---

## 纪律（比技巧更省时间；每条都对应一次真实事故）

1. **增量改，别全量重建。** 改一个属性不要重灌整棵树的构建脚本 —— 实测一次任务里
   整树重建 **7 次 / 重复发送 54.7 KB 代码**。建树脚本要**幂等**（先删同名节点再建），
   改动用小段代码按名字取节点改属性。
2. **别在用户的真实场景里做实验。** 探针节点要有**统一前缀**（如 `__probe_`）、跑完**当场删掉**；
   实验尽量放临时宿主节点下。实测有人往用户场景塞了 8 轮 `__T1..4`/`__P`/`__IT` 之类的节点。
3. **绝不动全局视图状态。** `cc.view.setDesignResolutionSize` / `setFrameSize` / `setCanvasSize`
   属于「编辑器的东西」，动它会把场景视图和刚做好的产物一起打坏（坑 5 的根因）。
   要验多分辨率适配：**用临时宿主节点改尺寸 + 实例化副本**，或者只按数值推算。
4. **失败不要静默。** 长时间工具流水里要**定期对用户说一句**在干什么；
   卡住时的正解常常是「一句话让用户做个动作」（"请在扩展面板启用 X 并重启编辑器"），
   实测有会话 41 秒里 20 步**一个字都没输出**，用户只看到卡住。
   收尾时**如实写未完成项** —— 「截图我没拿到」比假装完成值钱。
5. **别用 `pwsh` 硬啃编辑器安装目录。** 实测 25/25 次 `pwsh` 都打在
   `C:\ProgramData\cocos\editors\Creator\3.8.6`，一半是白打：`.ccc` 是**压缩**产物读不出来、
   中文文件还会踩编码（GBK/UTF-8 混读成乱码）。
   要查编辑器/引擎 API：**先 `cocos_describe_api`**（`target:'module:xxx'` / `'helpers'` / `cc.Xxx`），
   再在 `execute_code` 里反射 `cce.*` 与 `globalThis`，最后才考虑读源码。
6. **丢弃任何代码资产之前，先把里面的事实搬进 skill。** 实测一条 recipe 里写着
   「`sizeMode` 必须先于 `spriteFrame`」这个坑，但迁移时只搬了代码目录、没搬事实 →
   3.5 小时后同一个坑**被重新发现一次**。代码可以丢，**事实不该跟着丢**。

---

## 内置资源：按**路径**取，不要背 uuid

当你需要**只用引擎内置资源、不引用工程内任何资源**时（例如想搭一个能独立验证的 demo，
或所在项目有「产物不得引用 `assets/`」的硬要求），`db://internal/default_ui/` 下有
20 张贴图与 2 个图集，覆盖常见 UI：

| 用途 | 路径（`db://internal/default_ui/…`） |
|---|---|
| 单色/占位 | `default_sprite` / `default_sprite_splash` |
| 面板底 | `default_panel`（**九宫格**，用 SLICED） |
| 按钮 | `default_btn_normal` / `_pressed` / `_disabled` |
| 输入框 | `default_editbox_bg` |
| 进度条 | `default_progressbar` / `default_progressbar_bg` |
| 开关 | `default_toggle_normal` / `_pressed` / `_disabled` / `default_toggle_checkmark` |
| 滑动条 | `default_scrollbar` / `default_scrollbar_vertical` / `_bg` |
| 单选 | `default_radio_button_on` / `_off` |
| 图集 | `atom.plist` / `atom_new.plist` |

**取法**：先 `Editor.Message.request('asset-db','query-assets',{pattern:'db://internal/default_ui/**'})`
拿到 url 与 uuid，再 `cc.assetManager.loadAny({uuid})`；**uuid 是编辑器版本相关的，不要写进文档或 recipe**
（`recipe` 的复用门禁也会拒 —— 把 uuid 走 `args` 传）。真正的判据是
**"核验产物文件里没有 `db://assets` 引用"**（做法见「验收清单」）。

---

## recipe：跑通的代码别丢
<!-- fact: archive-not-indexed | verify: script:archive-not-indexed | 断言 .dsh-mcp/archive/ 下的文件不被 findRecipes 索引 -->

跑通一段以后还会用的代码（建场景、按契约搭节点树、批量改资源…），
用**与 `cocos_execute_code` 完全相同的一段代码**存下来：

```js
saveRecipe('create-2d-scene', `<刚才那段代码>`, {
  description: '从内部模板创建 2D 场景资产并打开',
  params: { name: '新场景名', template: '可选，db://internal/... 模板路径' },
  returns: '创建后的资产信息 {uuid, url}',
});
```

下次（哪怕换了会话、换了工作目录）：

```js
findRecipes('scene');                                   // 索引：名字/说明/参数/新鲜度
readRecipe('create-2d-scene');                           // 取源码，想改写就改
await runRecipe('create-2d-scene', { name: 'BossArena' }); // 直接跑
```

- 存放处：`<工程根>/.dsh-mcp/recipes/*.js`（**建议入库**，团队共享）。
- **不是跑通了就能存**（复用门禁，`saveRecipe` 会拒）：必须写 `description` 与 `returns`，
  `params` 里声明的每个参数代码里得真的用上 `args.<键>`，代码里不许出现具体 uuid /
  绝对路径 / `.tmp/`（那些该走 `args`），名字里不许带日期。
  被拒时它会把缺什么列出来 —— 按提示参数化再存；只对这一次成立的结果直接 `return` 就行。
- `runRecipe` 成功后回填 `verifiedAt`（**每天最多写一次**，避免 git 噪声）。
- `findRecipes` 回的 **`daysSinceVerified`** 是判断新鲜度的唯一依据：
  **超过 30 天没跑通的，先 `readRecipe` 看一眼再跑** —— 过期的路径/API 比没有 recipe 更坑。
- recipe 的 `context` 声明与当前上下文不符时会**明确拒绝**并提示改哪个字段；
  `context: 'any'` 表示两边都能跑。
- recipe 可以调 recipe，**最多 4 层**（防循环引用跑飞）。

### 什么**不该**存成 recipe

| 内容 | 该去哪 | 为什么 |
|---|---|---|
| 引擎 API 的用法/属性名 | `cocos_describe_api`，**不存** | 存了必然过期，而且随时可查 |
| 工程专有的流程、约定、坑点 | 本文件（`.agents/skills/`） | 需要人策展、能 review、能 git diff |
| **跑通了的代码** | **recipe** | 文件存事实会过期成谎话；代码过期会当场报错 |
| 只对这一次成立的探索 | 对话里 `return` 出来就够 | 它进 recipe 只会让 `findRecipes` 多一条跑不通的噪声 |
| **结构写死、只能换文案/贴图的一次性布局** | 哪都不进（要留就 `.dsh-mcp/archive/`） | 换个用途搭不出来，名字还命不中 —— **错的 recipe 比没有 recipe 更贵** |

**「跑通了」≠「能存」** —— 还要过三条形状判据：

1. **换个参数还能跑**：代码里没有写死的节点路径 / 文案 / uuid。
2. **能说出 ≥2 个「形状相同、用途不同」的未来调用点**；说不出 → 它是「这次探索的记录」，`return` 出来就行。
3. **名字按「形状」而不是「用途」命名** —— 名字就是索引。

对照（都在 `.dsh-mcp/`）：`recipes/build-subtabbed-list-page`（按形状命名 + 18 个真参数，✅）
vs `archive/build-login-ui-tree`（结构写死 + 按用途命名，❌ 已退出索引；它夹带的事实已搬进坑 4 / 坑 9 / 纪律 1）。

---

## 验收清单

改完编辑器/场景，**别只说「做完了」**，用一次 `cocos_execute_code` 把证据取回来：

1. **改了什么**：`return` 具体的 uuid / 名字 / 属性前后值，不要 `return node`。
2. **数量对不对**：`eachNode` 数一遍（注意已自动滤掉编辑器装饰）。
3. **契约对不对**：按名字取你**自己约定过**的子节点/组件（例如「这棵树必有 `bg`/`title`/`list`」），
   缺一个就报出来，别假定它在。
4. **画面对不对**（改布局/UI 时）：
   - 先 `cocos_capture_view` 截一张，用图片读取能力**看一眼** —— 坐标数字看不出叠字、错位、空白图；
   - **截图是空图时不要重试**（见坑 5 的三条纪律），改用**数值判据**：`worldRect(node, {root: canvas})`
     拿真实矩形 → 自己算重叠/越界/对齐（"左右边距是不是相等"这种，一次就能查出来）。
5. **场景脏了没**：`Editor.Message.request('scene','query-dirty')`（editor 上下文）。
6. **撤销登记了没**：改过场景就必须登记撤销 —— **在代码里调 `snapshot()`**，或传工具参数 `snapshot: true`
   （两者等价，参数那条由主进程在跑完后发起）。成功的回执里会带 `undoSnapshot: true`。
   ⚠ 它与「代码跑在哪个上下文」**毫无关系** —— 曾经把它当成 `cc is not defined` 的元凶，那是误判（见坑 6）。
7. **产物文件本身也要核验**（存了预制件/场景之后必做）：产物是 JSON，**读回来数**——
   节点数、`__type__` 清单（有没有非 `cc.*` 的脚本类型）、引用了哪些资源
   （`db://internal` 还是 `db://assets`）、`contentSize` 有没有被贴图改过。
   一句话例子：「只用内置资源」的判据不是"我没引用工程资源"，而是
   **文件里的每个 `__uuid__` 都在 `assets/**/*.meta` 里搜不到**。
8. **跑通的东西存 recipe**：这段代码以后还会用（建树/按契约搭 UI/批量改节点/存预制件）
   → `saveRecipe(...)`；开工前先 `findRecipes('ui')` 看有没有现成的（见上一节的口径）。
   插件会在「长代码 + 真改了场景（登记了撤销）」的回执里主动提醒一次 —— 那不是噪音，
   指的是下面这条实测教训。

## 已知限制（诚实边界）

- **要有打开的场景**：`context:"scene"` 这一档靠场景进程里加载的扩展脚本，
  没打开场景时工具会明确让你先开一个（不是崩）。
- **`context` 漏给会被推断**：插件按代码里的标识符猜（`cc` / `nodeByPath` / `tree(` → `scene`；
  `Editor` / `projectPath` → `editor`），并在回执里带 `contextInferred: true` + 一条 note 说明依据。
  这是兜底、不是许可 —— **永远显式写 `context`**（见坑 6 的实测代价）。
- **扩展改动没有热重载**：改完 `extensions/dsh_chat/` 的源码/场景脚本，要**重启一次 Cocos Creator**
  才会生效；「真实编辑器里的那一跳」在会话里验不了，**必须明确告诉用户去重启**。
  改完的标准动作：`cd extensions/dsh_chat && npm run build && node scripts/verify-cocos-engine.js`（假 `Editor` + 假 `cc` 真跑）。
  **再加上事实门禁**：`node scripts/verify-skill-facts.js`（或 `npm run verify:skill`）——
  **本文件里每条事实都挂了一条 `<!-- fact: … | verify: … -->` 声明**，改错了它会当场红。
  新写一条坑时必须同时声明它怎么被验证（能算的写 `script:<锚点名>`，只能人验的写 `manual` + 一句「人在哪看什么」）。
- **`cocos_capture_view` 可能整帧空白**（`blankRatio ≈ 1`）：先按坑 5 量视图状态，
  **不要反复重试、不要自建离屏渲染器**；这一项没做成要如实说。
- **超时掐不断已在跑的异步代码**：`vm` 的 `timeout` 只管同步段，Node 没有抢占式取消。
  超时后那段代码可能还在跑（所以别写 `await new Promise(()=>{})` 这种不可结束的等待）。
  默认超时 **15 秒** —— 别把一整棵 UI 树塞进一次调用，超时后你不知道它死在哪。
- **场景侧用户代码的报错行号比源码大 1**（代码被包进 async IIFE，用户代码从第 2 行开始）。
- **不能离线改 `.prefab`**：`.prefab` 是 JSON，但编辑器不打开就改容易和导入器打架。
- **recipe 的嵌套执行与外层共享同一个同步超时预算**，子 recipe 的超时会被夹到不超过外层。
- **能力基准在 `extensions/dsh_chat/benchmark/`**：27 条用例 + 磁盘判据（`oracle.mjs`）
  + 过程判据（`score.mjs`）。想量化「这次的协作到底几分」就去跑它，
  别凭感觉说"这次很快/很慢"。
- `AGENTS.md` 里关于技能目录的约定同样适用：**业务专有**的 workflow 留在本仓库
  `.agents/skills/`，通用编辑器操作知识才考虑上提。
