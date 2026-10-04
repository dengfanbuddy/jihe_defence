# tools/docs-web —— 把平台层教程构建成网页（图全部是静态 SVG）

零依赖（只用 Node 内置模块）。**不联网、不装包、不需要浏览器**即可产出整站。

```powershell
# 1) 构建（读 docs/platform-guide/*.md → 写 docs/platform-guide/web/）
node tools/docs-web/build.mjs

# 2) 本地起一个只读静态服务器看效果（可选；也可以直接双击 web/index.html）
node tools/docs-web/serve.mjs 8799      # → http://127.0.0.1:8799/

# 3) 只想统计「教程里用了哪些 mermaid 语法」（改渲染器前先跑它）
node tools/docs-web/analyze-mermaid.mjs
```

## 产物

```
docs/platform-guide/web/
├── index.html           ← README.md（总览 / 索引 / 接线现状总表）
├── 00-lifecycle.html …  ← 每章一页：左侧章节导航 + 页内目录 + 上/下一章
├── diagrams.html        ← ★ 全部图表总览（63 张 SVG 一页看全，可单张下载）
└── assets/
    ├── style.css
    └── diagrams/<章节>-NN.svg     ← 每张 mermaid 图渲染成的**静态 SVG**
```

- 页面是**零 JS** 的：图是内联 SVG（也同时落成独立 `.svg` 文件），所以在 `file://` 下双击也能看，打印时版式也正常。
- 超过 900px 宽的图（时序图居多）走「保持原始尺寸 + 横向滚动」，避免缩小到看不清字。
- 生成的 HTML 里每张图都带 `图 N · 宽×高 · 查看/下载 .svg` 的脚注。

## 三个脚本

| 文件 | 作用 |
|---|---|
| `mermaid-svg.mjs` | **mermaid 子集 → 静态 SVG** 的渲染器（自写布局：flowchart 分层 + 重心排序、sequenceDiagram 生命线、stateDiagram-v2 复用 flowchart） |
| `build.mjs` | Markdown → HTML 的转换 + 站点装配 + 图表总览页 |
| `analyze-mermaid.mjs` | 统计教程里真实用到的 mermaid 语法（**改渲染器前先跑它**，避免凭感觉扩大或遗漏支持范围） |
| `serve.mjs` | 30 行的只读静态服务器（给 `web/` 用，不参与构建） |

## 支持的 mermaid 语法（= 教程里真实出现的）

已用 `analyze-mermaid.mjs` 核对：**63 张图 = 40 flowchart / 16 sequenceDiagram / 7 stateDiagram-v2**。

- `flowchart TD|TB|LR|RL`：`A["标签"]`、`A{"标签"}`、裸 id、`<br/>` 换行、自环；边 `A --> B`、`A -- 文本 --> B`、`A -->|文本| B`（**`-->` 与 `|` 之间可以没有空格**，这条踩过）、`-.->` 虚线
- `sequenceDiagram`：`participant X as 别名`、`->>`、`-->>`、`Note over/right of/left of A[,B]:`、`alt/else/opt/loop/par … end`、`autonumber`
- `stateDiagram-v2`：`[*]`（按左右操作数区分 start / end）、中文状态名、`A --> B: 文本`、`note right of X … end note`

**不支持**（教程里也没用）：`subgraph`、`style/classDef/linkStyle`、复合状态、`%%{init}%%`、甘特图/类图/ER 图等。
真需要这些时再扩渲染器，或者改用 mermaid-cli（需要联网装包）。

## 注意事项

- `docs/platform-guide/web/` 是**生成物**：不要手改，改 `.md` 后重跑 `build.mjs`。
- 渲染器把标签里的行内 markdown（`` ` `` / `**`）**剥掉**再画（SVG 里不做富文本），所以图中文字与正文略有差异。
- 文字宽度是按字符估算的（CJK 全宽 / ASCII 半宽 + 6% 安全系数），不同字体下仍可能有几个像素误差；盒子宁大不小。
- 改图请只改 `.md` 里的 mermaid 源码，**别改生成的 `.svg`**。
