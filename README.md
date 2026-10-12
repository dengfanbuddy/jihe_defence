# 集合防御（Jihe Defence）

俯视角 **roguelike 塔防**，Cocos Creator 3.8.6 + TypeScript。
含自定义反应式框架、行为树、FSM、技能 / Buff 系统，全部游戏数据来自 `assets/resources/tb/*.json` 配表。

> **本文件是导航页。真正的权威入口是 [`AGENTS.md`](AGENTS.md)** —— 架构、命令、数值口径铁律、主题索引都在那里；本文只回答"东西在哪"。
> （本文件此前一直是个 0 字节空文件，2026-11 补上导航内容。）

---

## 1. 怎么跑起来

| 目的 | 做法 |
|---|---|
| 打开工程 / 预览游戏 | Cocos Creator 编辑器（3.8.6）直接打开工程 → 预览。首场景 `assets/scenes/Loading.scene` |
| 导表（Excel → JSON） | `cd tools/excel_export && npm run export` |
| 类型检查（可当门禁） | `cd tools/excel_export && npm run typecheck:diff` |
| 各类契约体检 | 同在 `tools/excel_export/` 下跑：`npm run check` / `verify` / `audit:attr` / `audit:reach` / `audit:slot` / `audit:herocard` / `audit:mall` / `audit:bag` / `audit:draw` / `audit:ui` / `audit:hitfeel` |

⚠ **改数值一律改 `tools/excel_export/excel/*.xlsx` 再导表**；只改 `assets/resources/tb/*.json` 是无效改动（下次导表会覆盖回去）。

## 2. 代码在哪

```
assets/scripts/
├── platform/   ← 可复用框架层（reactivity / store / ui / behavior / fsm / event / resources / excel_table …）
└── game/       ← 业务逻辑（battle 战斗 · data 局外数据 · game_stage 局内阶段 · scene 场景 · ui 界面 · excel_table 配表容器）
```

模块级说明见 [`AGENTS.md`](AGENTS.md) 的 `Architecture` 一节；`platform/` 每个模块**到底有没有被接线**见第 3 节的平台层教程。

## 3. 文档地图

### 3.1 先读这两份

| 文档 | 什么时候读 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **任何改动之前**。命令表 + 数值口径 + "动手前扫一眼"的判据速查 |
| [`docs/游戏开发术语速查手册.md`](docs/游戏开发术语速查手册.md) | 需求描述模糊时（"手感不好""有点卡"）—— 先按 §0 换成可验收的量化描述 |

### 3.2 按主题

| 主题 | 权威文档 |
|---|---|
| **平台层框架**（19 章教程：每个模块的 API / 生命周期 / 接线现状） | [`docs/platform-guide/README.md`](docs/platform-guide/README.md) |
| UI 框架（两层体系 / UIScope / 配方 / 红线） | [`docs/UI框架使用说明.md`](docs/UI框架使用说明.md) |
| 数值口径（配表怎么填、属性怎么算） | [`docs/数值配置参考手册.md`](docs/数值配置参考手册.md) |
| 品质 × 词条门禁规则 | [`docs/配置规则_品质与词条门禁.md`](docs/配置规则_品质与词条门禁.md) |
| 打击反馈 / 打击感（档位表 T0~T7） | [`docs/打击反馈设计.md`](docs/打击反馈设计.md) |
| 美术风格（配色 tokens / 用色与字号规范） | [`docs/美术风格预设.md`](docs/美术风格预设.md) + [`docs/art-style/tokens.json`](docs/art-style/tokens.json) |
| 局内刷怪节奏 | [`docs/局内刷怪节奏设计.md`](docs/局内刷怪节奏设计.md) |
| 成就系统 | [`docs/成就系统设计.md`](docs/成就系统设计.md) |
| 各界面 / 系统的落地方案 | `docs/<子系统>/README.md` —— 如 [`docs/bag/`](docs/bag/README.md)、[`docs/shop/`](docs/shop/README.md)、[`docs/meta-growth/`](docs/meta-growth/README.md)、[`docs/difficulty-select/`](docs/difficulty-select/README.md)、[`docs/game-mode/`](docs/game-mode/README.md)、[`docs/hero-detail/`](docs/hero-detail/README.md) |
| 历史细节与踩坑归档（从 `AGENTS.md` 搬出来的长条目） | [`docs/agent-notes/`](docs/agent-notes/README.md) |
| 工具说明 | 各工具目录自己的 `README.md`（`tools/*/README.md`） |

### 3.3 平台层教程的网页版

教程有**零 JS、可离线双击打开**的静态网页版（每张 mermaid 图都渲染成静态 SVG）：

```powershell
node tools/docs-web/build.mjs        # 读 docs/platform-guide/*.md → 写 docs/platform-guide/web/
node tools/docs-web/serve.mjs 8799   # 可选：本地预览 http://127.0.0.1:8799/
```

⚠ `docs/platform-guide/web/` 是**生成物，勿手改**；改 `docs/platform-guide/*.md` 后重跑构建。

## 4. 文档约定（避免再长出过时文档）

- **一份主题只有一份权威文档**，其余位置放**指针**，不复制正文（复制出来的第二份迟早发散）。
- 文档**作废时写清"谁推翻了它、现在看哪里"**，而不是默默留着。
- 长条目写进 `docs/agent-notes/` 或专门文档，**别往 `AGENTS.md` 堆**。
- 文档里的日期（如 `2026-11`）是项目内部时间轴，用来说明"口径是哪一批定的"。
