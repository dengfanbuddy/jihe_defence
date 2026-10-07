# UI 规范门禁（`ui-token-audit`）

离线可跑、**不依赖 Cocos 编辑器**的 UI 规范体检：一条 `node` 命令回答一个具体问题 ——

> **「某个预制件的某棵子树里，每个 `Sprite` / `Label` 的颜色和字号，是否都来自工程的 token 真源？」**

它替代的是"打开编辑器、点开那个弹窗、用取色器一个个比对"这件做不到的事（一份 `Scene_Menu.prefab` 有 82 万字符，
英雄详情弹窗子树里就有 24 个 Sprite + 34 个 Label —— 靠眼睛看是看不住的）。

---

## 1. 回答什么问题

对子树里的**每一个** `cc.Sprite` / `cc.Label`，逐条判四件事（全部通过 = 退出码 0）：

| 判据 | 检查的东西 | 违规长什么样 |
|---|---|---|
| **P1** | `_color` 的 `#RRGGBB`（大写）必须在 tokens.json 色板里 | `/ui_hero_detail/panel/header/name: Label #6B6B6B（不在 tokens.json 色板里…）` |
| **P2** | `cc.Label._fontSize` 必须在字号阶梯上 | `/ui_hero_detail/panel/skill/desc: Label fs=33（不在字号阶梯上）` |
| **P3** | `cc.Label._lineHeight` 只许 `0`（引擎自动）/ `=== _fontSize` / `round(_fontSize × 1.5)` | `/…/desc: Label fs=33 lh=21（行距既不是 0…、也不等于字号 33、也不是 round(33×1.5)=50）` |
| **P4** | `cc.Sprite._spriteFrame.__uuid__` 不许以 `7d8f9b89` 开头（引擎内置贴图） | `/ui_hero_detail/panel/bg: Sprite spriteFrame=7d8f9b89-…（引擎内置贴图（应改用自有 textures/common/white_4x4））` |

**为什么值得门禁**：这四类问题**不会报任何错**，编辑器里预览还完全正常 ——

- 取色器里随手点一个"差不多的灰"（`#6A696B` → `#6B6B6B`）：浅底上人眼分不出，但色板上就此多出一种"野生灰"，
  风格一路漂移；
- 字号用了阶梯外的值（16 → 17）：工程字号体系里多一条孤值，页面间"看起来有点不一样"却说不清哪里不一样；
- `_lineHeight` 留着改版前字号时代的残值：`overflow=NONE` 时节点高 = `lineHeight × 1.26`，框高虚高，
  编辑器里做重叠/越界检查会失真；
- `_spriteFrame` 指向引擎内置 `default_ui`（uuid 前缀 `7d8f9b89`，即 `db://internal/default_ui/*`）：
  构建产物里混进引擎贴图；本工程一律用自有 `textures/common/white_4x4`。

---

## 2. 怎么跑

```bash
# 默认：主界面预制件里的「英雄详情弹窗」子树
node tools/ui-token-audit/audit.mjs

# 指定预制件 / 指定子树根节点名（相对工程根或绝对路径都行）
node tools/ui-token-audit/audit.mjs --prefab assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab --root ui_hero_detail

# 子树根**同名节点不止一个**时，用路径点名（首段可省）
node tools/ui-token-audit/audit.mjs --prefab assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab --root-path Scene_Menu/content/right/outer_relics

# 结构化结果（只打 JSON，给别的脚本消费）
node tools/ui-token-audit/audit.mjs --json
```

参数：

| 参数 | 说明 |
|---|---|
| `--prefab <路径>` | 被体检的预制件。默认 `assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab` |
| `--root <节点名>` | 子树根**节点名**（不是组件名、不是文件路径）。默认 `ui_hero_detail`；同名节点取数组下标最小的 |
| `--root-path <路径>` | 子树根的**节点路径**（斜杠分隔，如 `Scene_Menu/content/right/outer_relics`；首段可省）。**优先于 `--root`** |
| `--json` | 只打印结构化 JSON；出错时也打 JSON（带 `error` 字段） |
| `-h, --help` | 用法 |

**什么时候必须用 `--root-path`**：`Scene_Menu.prefab` 里有**两个** `outer_relics`
（左侧菜单项 / 右侧页面，下标 322 / 725），`--root outer_relics` 只能取到下标小的那个（左侧菜单项，
只有 7 个节点），扫出来的结论跟右侧那页毫无关系。路径法把"哪一棵"说死，走错段时还会报出
"走到哪一段、该层有哪些子节点"。

**退出码**（三态，不含糊）：

| 码 | 含义 |
|---|---|
| `0` | 全绿，`✔ 通过 N 条断言` |
| `1` | 有违规，逐条列出「节点路径 + 组件 + 实际值」 |
| `2` | **门禁自己跑不起来**：预制件不存在 / `--root` 找不到 / 真源读不到 / 参数写错。**绝不静默通过** |

输出观感（通过时）：

```
▌UI 规范门禁（真预制件 × docs/art-style/tokens.json）
  预制件    assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab
  子树根    ui_hero_detail（数组下标 1474）
  判据真源  docs/art-style/tokens.json
  规模      扫了 24 Sprite + 34 Label，对 32 个 token 色 / 6 档字号（子树共 77 个节点）

▌P1 颜色来自色板（cc.Sprite / cc.Label 的 _color）
  ✔ 58/58 条通过（对 32 个 token 色）
▌P2 字号在阶梯上（cc.Label 的 _fontSize）
  ✔ 34/34 条通过（对 6 档字号（40/24/20/16/14/12））
  …

✔ 通过 150 条断言
  扫了 24 Sprite + 34 Label，对 32 个 token 色 / 6 档字号
```

`--json` 的主要字段：

```jsonc
{
  "ok": true, "exitCode": 0, "checkedAt": "…",
  "prefab": { "path": "assets/…/Scene_Menu.prefab", "absolute": "D:\\…" },
  "root":   { "name": "ui_hero_detail", "index": 1474, "duplicates": 1, "path": null },
  "tokens": { "path": "docs/art-style/tokens.json", "paletteCount": 32,
              "palette": ["#000000", "…"], "fontLadder": [40, 24, 20, 16, 14, 12] },
  "stats":  { "nodes": 77, "sprites": 24, "labels": 34 },
  "assertions": { "total": 150, "passed": 150, "failed": 0 },
  "groups": [ { "id": "P1", "title": "…", "checked": 58, "passed": 58, "failed": 0 } ],
  "violations": [ { "rule": "P2", "path": "/…/desc", "node": "desc",
                    "component": "cc.Label", "actual": "fs=33", "reason": "不在字号阶梯上",
                    "message": "/…/desc: Label fs=33（不在字号阶梯上）" } ]
}
```

---

## 3. 判据真源（运行时**现读**，本脚本不硬编码任何色表 / 字号表）

| 真源 | 取什么 | 现值 |
|---|---|---|
| `docs/art-style/tokens.json` | `palette[].tokens[].hex` | **28 个 token 色**（含 `#FFFFFF`、`#EFEEED`） |
| `docs/art-style/tokens.json` | **`quality[].hex`** | **4 个品质色**：`#DDDDDD` 白 / `#5096FF` 蓝 / `#CF68FF` 黄 / `#FF6464` 红 |
| `docs/art-style/tokens.json` | `typography.scale[].size` | **6 档字号：40 / 24 / 20 / 16 / 14 / 12** |

> 品质色**必须**算进色板（2026-11 补）：品质不进出图、只靠 UI 上的底框/描边表现
> （见 `docs/relic-icon/README.md` §2），所以遗物行、商店格子的「品质描边」是**合法用法**。
> 只读 `palette` 会把它判成野生色 —— 那是门禁自己的漏。跑遗物图鉴子树时当场踩到：
> 同色 `#DDDDDD` 被报成 2 条 P1 违规。

真源改了，门禁判据**当天就跟着变**（改 `tokens.json` 不需要动这个脚本）。真源读不到 = 退出码 2，
因为"拿不到判据"和"全部通过"绝不能是同一个出口。

引擎内置贴图的判据不来自 tokens.json，是一条**前缀常量**：`7d8f9b89` = `db://internal/default_ui/*`。

### 三条容易误判的口径（**故意**放行的，别当 bug）

1. **`fs=14 / lh=21` 是合法的**：`21 === round(14 × 1.5)`，即多行正文的 1.5 倍行距。
   实测 `ui_hero_detail/panel/skill/desc` 就是这一组，是**有意**的设计，不是残值。
2. **色值只看 RGB，不看 alpha**：`{r,g,b,a}` 里 `a` 必须是 0~255 的正常值即可，遮罩的 `alpha=166` 等不参与判据。
   携带 alpha 的 token（如 `c-scrim #000000` + `alpha 0.7`）按它的 `hex` 参与色板。
3. **`_spriteFrame` 为空不算违规**：没拖贴图（纯色占位）是正常形态，只有"指向引擎内置贴图"才红。

---

## 4. 怎么加新界面

**① 新界面刚在编辑器里搭完，先跑一次**（这一步不需要改任何文件）：

```bash
# 新界面是独立预制件
node tools/ui-token-audit/audit.mjs --prefab assets/resources/prefabs/ui/scenes/<你的>/<界面>.prefab --root <你的根节点名>

# 新界面是嵌在已有预制件里的弹窗/页签（本工程多数如此，如 ui_hero_detail 挂在 Scene_Menu 上）
node tools/ui-token-audit/audit.mjs --root <你的根节点名>
```

红了就按 `节点路径 + 组件 + 实际值` 去编辑器里改那一个节点 —— 报错路径是**结构路径**
（首段就是 `--root` 那个名字，形如 `/ui_hero_detail/panel/skill/desc`），可以直接照着往下点。

**② 想让它常驻成一条命令**：在 `tools/excel_export/package.json` 的 `scripts` 里加一行

```json
"audit:ui": "node ../../tools/ui-token-audit/audit.mjs"
```

> ⚠ 本目录只包含 `audit.mjs` + 本文档两个文件，**没有替你改 `package.json`**（本工程其余体检脚本
> 都挂在 `tools/excel_export` 的脚本表下，见 `AGENTS.md` 的命令表）。加脚本那一步按上面一行照抄即可。

**③ 想一次巡检多个界面**：反复调这个脚本（`--json` 好解析），或写个十几行的小循环 ——
注意**每个界面单独给 `--root`**，因为"子树"才是判据的作用域。

**④ 新增色板 / 字号档**：改 `docs/art-style/tokens.json`（本工程规定它必须与 `docs/美术风格预设.md` §1、
`docs/art-style/index.html` **三处同改**，`tools/hero-card-audit/audit.mjs` 的 E8 那条断言在盯这件事），
改完直接重跑本脚本，别改这个脚本。

---

## 5. 负控自测（证明它真的会红，且**绝不动真资产**）

把预制件复制到临时目录、在副本上改一个值、跑副本 —— 真文件一个字节都不碰：

```powershell
$tmp = Join-Path $env:TEMP "neg/Scene_Menu.fs33.prefab"; New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
Copy-Item assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab $tmp -Force
# 在副本里把 ui_hero_detail/panel/skill/desc 的 _fontSize 由 14 改成 33（见 git 历史里的实测记录）
node tools/ui-token-audit/audit.mjs --prefab $tmp   # → 退出码 1，报出那条违规
Remove-Item -Recurse -Force (Split-Path $tmp)
```

实测结论：`fs=33` 会同时点亮 **P2**（33 不在阶梯上）与 **P3**（`lh=21` 对 `fs=33` 不再是 1.5 倍）——
两条都是真的，不是误报。同理，把某个 `_color` 改成 `#6B6B6B` 点亮 P1，把某颗 Sprite 的
`_spriteFrame.__uuid__` 改成 `7d8f9b89-…` 点亮 P4。

---

## 6. 边界：它**不**管什么

- 只管 `cc.Sprite` 与 `cc.Label`。`cc.Graphics`（范围圈那种 `lineColor`/`fillColor`）、`cc.RichText`、
  `cc.Mask`、`Material`、粒子等**不在判据内**；`cc.Graphics` 的配色目前靠 `tokens.json` 里的
  `c-range-line` 记录 + 人工对照（见 `docs/art-style/tokens.json` 的 `status: todo`）。
- 不管布局：位置 / 尺寸 / 对齐 / 越界是另一类体检（`tools/hero-card-audit/audit.mjs` 的 E7、
  `tools/monster-reach-audit` 等各管一段）。
- **不管 alpha 的语义**：只要求色值在色板上，不判断"这个遮罩该不该是 166"。
- 同名节点：`--root` 命中多个同名节点时取**数组下标最小**的那个，并在报告里注明
  （`同名节点 N 个，取下标最小的`）；子树内部的重名不影响，路径是结构路径。
  要精确点名某一棵就用 `--root-path`（报告里显示的是完整路径，不再是节点名）。
- 子树里一个 `Sprite`/`Label` 都没有时，报告会照实打 `扫了 0 Sprite + 0 Label` 并在 stderr 打一条
  ⚠ 警告（判据没有对象可比），但**不算违规**、退出码仍为 0 —— 空容器本身是合法形态。

---

## 7. 实现要点（改这个脚本前先看）

- 预制件是 Cocos 序列化 JSON：**顶层数组 + `{"__id__": n}` 引用**；节点是 `__type__ === 'cc.Node'`，
  组件挂在 `node._components[]`（值是 `{__id__: n}`），子节点在 `node._children[]`。
  脚本自带 `deref()` 解引用（`_color` / `_spriteFrame` 两种写法 —— 内联对象与引用 —— 都能解）。
- 遍历**只走 `_children[]` 递归**，不用 `JSON.stringify` 全文正则去猜：全文正则会扫进**不属于这棵子树**的
  组件，还会把"文本里恰好像色值"的东西误判成违规。
- 零依赖：只用 `node:fs` / `node:path` / `node:url`，不装任何包，不需要 Cocos 编辑器，可进 CI。
