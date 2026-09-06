# Glyph 图鉴 · 形象设计

参照《[Glyphica: Typing Survival](https://playglyphica.com/)》的视觉语法做的两套形象设计，
全部为纯几何 SVG（无外部字体与位图），可在线换主题并导出 SVG / PNG。

| 页面 | 内容 | 用途 |
|---|---|---|
| `index.html` | **通用 Glyph 图鉴**：14 只原创怪物 + 8 种弹道 + 8 个技能图标 | 风格规范与素材库，形象与项目解耦 |
| `ours.html` | **集合防御专属**：3 名我方单位 + 8 只怪物 + 8 种弹道/技能 + 9 个状态标记 + 5 张 AI 行为图 | 直接对应项目真实配置，可落地到引擎 |

## 打开方式

直接双击任一 `.html` 即可（无构建、无依赖、无网络请求，`file://` 下功能完整）。两页顶栏可互相跳转。

## 页面能做什么

| 功能 | 说明 |
|---|---|
| 主题切换 | 纸面 Paper（酒红强调）/ 夜场 Night（琥珀强调），所有图形实时换色 |
| 单个导出 | 每张卡片下的 `SVG` / `PNG` / `复制代码` |
| 批量导出 | 顶栏「批量 SVG」「批量 PNG」一次导出整页图形（浏览器会询问是否允许多文件下载） |
| PNG 尺寸 | 256 / 512 / 1024 / 2048 px，可选是否带底色（暗角渐变） |
| 战场预览 | 把形象放回真实构图检验，整张可导出 |
| 体量对照 | `ours.html` 按 `collision_radius` 等比排列全部单位，验证小尺寸可辨识度 |
| 配置导出 | `index.html` 一键复制/下载与 `enemies.json` 同结构的配置行（id 从 9 起） |

## 文件结构

```
docs/monster-design/
├── index.html          通用图鉴
├── ours.html           集合防御专属图鉴
└── assets/
    ├── art.js          通用美术库：monsters / projectiles / icons / vocab
    ├── data.js         通用元数据 + enemies.json 配置行
    ├── app.js          index.html 的渲染与导出
    ├── art-ours.js     本作美术库：units / shots / marks / ai
    ├── data-ours.js    本作元数据（数值取自真实配置表）
    ├── app-ours.js     ours.html 的渲染、体量对照、导出
    └── style.css       双主题样式（CSS 变量），两页共用
```

## 数据来源（ours.html）

| 配置 | 用途 |
|---|---|
| `assets/resources/tb/units.json` | 11 个单位的碰撞半径、AI 类型与参数、攻击间隔、掉落 |
| `assets/resources/tb/attributes.json` | 解码 `base_attributes` 的属性 id（1生命 2魔法 3攻击 4攻速 5移速 6护甲 7魔抗 9回复 16射程）|
| `assets/resources/tb/element_effects.json` | 9 种元素状态的层数规则与数值 |
| `assets/resources/tb/abilities.json` | 11 个技能的伤害、弹速、半径、附加效果 |
| `assets/scripts/game/battle/Projectile.ts` | 弹道为匀速直线 + 终点快照 → 决定了尾迹画法 |

## 新增形象

**通用页**：在 `art.js` 的 `monsters` 加绘制函数 `(p) => string`（`viewBox 0 0 120 120`），
再到 `data.js` 的 `monsters` 加同 `code` 的元数据，刷新即可。

**本作页**：在 `art-ours.js` 的 `units` / `shots` / `marks` / `ai` 里加函数，
再到 `data-ours.js` 对应数组加元数据（`radius` / `ai` / `stats` 请照抄配置表真实值），刷新即可。

## 硬约束

**通用（来自官方实机画面拆解）**

- 双色制：一个墨色 + 一个强调色，灰色只承担辅助信息。
- 主结构线宽 2.2~3px，细节 1.2~1.6px，全部圆头；无渐变、无阴影、无高光。
- 虚线 = 范围 / 预告 / 尚未发生；实线 = 已存在的实体。
- 状态信息（词条、血条、层数）一律作为最小图元挂在本体外围，不入本体造型。
- 导出图不含 `<text>`，保证 PNG 栅格化在任何机器上一致。

**本作追加**

- 阵营色：我方＝墨色主导 + 强调色核心；敌方＝强调色主导 + 墨色轮廓。
- 体量即配置：绘制尺寸严格按 `collision_radius` 等比。
- AI 即附件：chase＝朝向尖角，wander＝仇恨虚线圈，orbit＝轨道弧，attack_stop＝蓄力刻度，boss＝分段外环。
- 奖励可视化：金币/经验型 BOSS 把掉落画在身上。
- 状态层数：`stackRule: intensity` 画底部层数点，`exclusive` 不画。

> 本目录所有图形均为原创再设计，仅复用其视觉语法，不含任何原游戏素材。
