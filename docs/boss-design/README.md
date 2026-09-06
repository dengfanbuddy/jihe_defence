# 怪物图鉴 · Boss 体系设计

以 dota2 的怪物/野怪/首领为灵感，设计本作完整的怪物推进体系，并绑定到项目真实配置。
全部形象由 `art-boss.js` 参数化生成（Glyphica 风格），可导出 SVG / PNG。

> 打开 `index.html` 查看。顶栏可跳转到「通用 Glyph 图鉴」「单位/弹道设计」「英雄设计库」。

## 页面结构

| 区段 | 内容 |
|---|---|
| 01 总览 | 怪物总数 + 档位分布 + 元素分布 |
| 02 阶段推进 | 4 阶段，每阶段 3 小怪 + 3 精英 + 1 守关Boss |
| 03 全局特殊Boss | 金币 / 击杀 / 防守（均不主动攻击） |
| 04 最终Boss · 难度循环 | 20 只最终Boss + 难度→Boss 对照表 |
| 05 全图鉴 | 按档位 / 元素 / 阶段筛选全部怪物 |
| 06 配置导出 | 聚合 `monster-design.json` 下载 |

## 怪物清单（共 51 只）

| 档位 | 数量 | 说明 |
|---|---|---|
| 小怪 | 12 | 每阶段 3 种；**攻击频率低**（攻频 0.6~1.0，攻击间隔 2.6~3.5s），但攻击/血量较高 |
| 精英 | 12 | 每阶段 3 种；同样低攻频，血量攻击更高 |
| 阶段Boss | 4 | 每阶段 1 只；带 1~3 个**小技能**，按血量分段切换 AI |
| 金币Boss | 1 | **不攻击**，击杀爆金币（400 金） |
| 击杀Boss | 1 | **不攻击**，限时击杀拿经验（600 经验） |
| 防守Boss | 1 | **不攻击**，敌方防线核心，需拆解（周期刷盾） |
| 最终Boss | 20 | 每只 1~2 个**主动技能**（多数 1 主动 + 1 被动），按难度循环登场 |

## 阶段难度倍率

| 阶段 | 主题 | 倍率 |
|---|---|---|
| 1 | 初入战场（自然/物理） | 1.0 |
| 2 | 熔岩之境（火） | 1.6 |
| 3 | 万毒沼泽（毒/暗） | 2.4 |
| 4 | 寒霜之巅（冰/雷） | 3.6 |

## 最终Boss 难度循环

本作设 100 级难度，**每 5 个难度一个类型的最终Boss**：

- 难度 1-5 → 第 1 只（末日使者）
- 难度 6-10 → 第 2 只（虚空领主）
- …
- 难度 96-100 → 第 20 只（原始湮灭者）

**难度 100 之后**：循环这 20 只 Boss，仅按 `difficultyMultiplier` 提高属性
（HP/ATK/护甲/移速随难度线性增长），Boss 类型与技能不变。

最终Boss 元素覆盖全部 7 系（物理/火/冰/毒/雷/暗/无），主动技能数 1~2。

## 数据来源

| 配置 | 用途 |
|---|---|
| `assets/resources/tb/units.json` | 单位 AI 类型 / 攻击间隔 / 掉落 / 碰撞半径（gold_boss 等奖励类型） |
| `assets/resources/tb/enemies.json` | 怪物档位（normal / elite / boss）与属性结构 |
| `assets/resources/tb/phases.json` | 阶段推进与难度倍率 |
| `assets/resources/tb/abilities.json` | 主动技能的行为 / 冷却 / 伤害类型 |
| `assets/resources/tb/element_effects.json` | 元素状态：灼烧 / 冰冻 / 毒 / 连锁闪电 / 爆炸 / 暗影 / 静电磁场 / 赏金 / 腐蚀 |
| dota2 野怪/首领 | 怪物灵感与机制改编 |

## 文件结构

```
docs/boss-design/
├── index.html            怪物图鉴主页面
├── assets/
│   ├── style.css         双主题基础样式（复用）
│   ├── style-extra.css   Boss 页追加样式
│   ├── art-boss.js       MonsterSigil 参数化徽记生成器（shape/element/cat/ai 合成）
│   ├── data-monsters-a.js 阶段1&2（14 只）window.MONSTER_DATA_A
│   ├── data-monsters-b.js 阶段3&4 + 全局特殊（17 只）window.MONSTER_DATA_B
│   ├── data-monsters-c.js 20 只最终Boss（含属性计算与难度循环）window.MONSTER_DATA_C
│   └── app-boss.js       渲染 / 筛选 / 难度对照 / 导出逻辑
└── README.md
```

## 新增怪物

1. 在 `data-monsters-*.js` 对应数组追加一条，结构和其它一致
   （`id/code/name/en/cat/stage/element/shape/ai/atkInterval/attacks/stats/reward/role/dota/skills/design/tell/build/tags`）。
2. `shape` 取值必须是 `art-boss.js` 里的体形原型：`beast/brute/caster/swarm/serpent/sentinel/colossus/wraith/gargoyle/hydra`。
3. 刷新即可。可加 `skills`（Boss）或置 `attacks: false`（不攻击特殊Boss）。

## 硬约束（沿用 Glyphica 视觉语法）

- 双色制：一个墨色 + 一个强调色；主结构 2.2~3px，细节 1.2~1.6px，全部圆头。
- 虚线 = 范围 / 预告 / 未发生；实线 = 已存在实体。
- 档位附件：小怪极简；精英双外环；阶段Boss 王冠 + 分段环 + 基座；特殊Boss 禁攻杠 + 奖励图标；最终Boss 三重环 + 王冠 + 双技能珠。
- 不攻击的特殊Boss 用「禁攻杠」（两端锁）明确表达，并把奖励（金币/准星/盾徽）画在身上。
- 导出图不含 `<text>`。

> 本目录所有图形均为参数化原创，仅复用 Glyphica 视觉语法与 Dota 2 怪物灵感，不含任何原游戏素材。
> 数值为策划初稿，落地前需按本作数值体系平衡测试。
