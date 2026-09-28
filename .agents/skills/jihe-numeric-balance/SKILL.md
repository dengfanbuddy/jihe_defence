---
name: jihe-numeric-balance
description: 为《集合防御 / Jihe Defence》(Cocos Creator 肉鸽塔防项目) 配置数值：局外英雄基础属性与成长、局外装备(品质/特殊效果)、局内怪物属性、金币/经验经济。当用户给出英雄设定、技能/装备/怪物描述并要数值设计、数值配置或平衡建议时使用；产出「数值设计表 + 可直接粘贴的 tb JSON 片段」。
---

# 集合防御 · 数值配置技能 (jihe-numeric-balance)

本技能让 AI 在没有数值策划经验的对话者给出「英雄/技能/装备/怪物文字设定」后，产出**符合本项目代码口径、可直接落地**的数值设计表和配表 JSON。

## 何时使用

- 用户描述一个英雄（定位、节奏、特色机制、职业/射程），需要**基础属性 + 每级成长**。
- 用户描述一件装备（品质、属性方向、特殊效果），需要**属性预算与 JSON**。
- 用户描述怪物/Boss（体型、威胁、奖励倾向），需要**属性 + 金币经验**。
- 用户要求调平衡（"太强/太弱"）、给奖励定价、做成长曲线、定单局经济。
- 用户只做设计讨论（不改数值）时**不要**强行产 JSON，先给设计表。

## 项目关键口径（必须遵守，否则配错表）

本项目权威数据源 = `assets/resources/tb/`（TbRoot 管线加载）。**该目录当前仅有 7 张表**：`units.json`(英雄 team=1 + 怪物 team=2)、`attributes.json`、`abilities.json`、`modifiers.json`、`relics.json`、`equipments.json`、`battle_constants.json`。曾存在的旧表 `enemies/phases/growth_curves/passive_combos/element_effects` 及对应容器**已删除**（无残留引用），不要写它们，也不要新增无容器消费的 JSON。

两条最容易写错的规则（详见 references/project-conventions.md）：
1. `base_attributes` 里百分比型属性（攻速/魔抗/闪避/暴率/暴伤/倍率等，见 `battle/core/AttributeScaling.ts` SCALE 表）配置值为 **int（100=100%）**；普通属性（生命/攻击/护甲/移速/距离）为原值。
2. 英雄条目的 `growthValues` **不是 int**，是**运行时 float 语义**（暴击 0.005 = 0.5%/级）。两处千万不能互相套用。

## 工作流

```
STEP 0 澄清输入（不足时最多问 2 个核心问题）：
       目标模式：难度模式(难度 N) / 无尽模式(基准难度) / Boss 模式(Boss 档位)？
       英雄定位与节奏、普攻/技能形态；局外成长预算层（英雄独立/公共装备/成就/Boss 收集等，见 quick-method §三模式）。
STEP 1 定锚：按 references/quick-method.md 的五步法先给锚点数值：
       普通怪 TTK 0.5~3s；1DPS≈10HP；怪 3~8 下致死英雄；
       装备品质 ×1.0/1.3/1.6/2.0/2.5；难度指数 1.05~1.15；
       局外永久加成总量 ≤ +50%；百分比属性最后统一折算成 int(×100)。
       三模式默认：难度模式按"3~4 天/难度"反推怪强度；无尽模式怪强度随时间超线性增长；
       Boss 模式按"满配 DPS×10~30s"做分档 HP + 碎片经济（详见 quick-method §三模式与 project-conventions §局外）。
STEP 2 分层填模板表（数值设计表，人读为主）：
       英雄基础属性表 / growthValues 表 / 技能预算表 / 装备表 / 怪物+奖励表。
       每个值给出【依据：锚点或公式】而不是裸数字。
STEP 3 转 JSON（可粘贴）：按 templates/ 里的字段结构产出，遵守 STEP 前两条口径。
STEP 4 自检（每项打勾）：
       ☐ 已指定目标模式与难度/档位基准  ☐ 普通怪 TTK∈0.5~3s  ☐ 英雄被小怪 3~8 下致死
       ☐ 1DPS≈10HP 一致    ☐ 百分比 ×100、growthValues 用 float
       ☐ 不超 attributes.json min/max 与战斗 cap(暴率≤60/闪避≤40/攻速≤3)
       ☐ 难度曲线与局外净成长匹配；无尽/Boss 模式强度曲线独立设计
       ☐ 局外各成长层合计 ≤ +50%；奖励经公式折算后 ≈ 该模式单局预算
STEP 5 输出（见下方输出契约）。
```

## 输出契约

产出一份结构化回复，固定包含：

1. **数值设计表**（Markdown 表）：英雄基础属性表 / 成长表（含 5/10/20/30 级样例值）/ 技能或装备表 / 奖励表。
2. **配表 JSON 片段**（若适用）：用 ```json 代码块给出可直接粘贴到 `units.json`（或 equipments/abilities）的条目；标注"追加"或"替换 id=?"。
3. **自检结果**：上述 STEP 4 勾选项 + 一两个反例计算（如"火枪 DPS=？ 打哥布林 TTK=？"）。
4. **变更影响提示**：是否涉及新增属性/新增容器/需要改代码。

## 参考资料

- `references/quick-method.md` —— 数值方法论速查（锚点/五步/经济预算）。
- `references/project-conventions.md` —— 本项目配表结构、属性口径、公式、权威表。
- `templates/` —— 空模板表（英雄/技能/装备/怪物经济）。
- 项目文档（相对仓库根）：`docs/数值配置参考手册.md`、`docs/数值设计调研报告_肉鸽塔防.md`。
- 代码侧：`assets/scripts/game/battle/core/AttributeScaling.ts`、`battle/DamagePipeline.ts`、`excel_table/Tb_UnitConfig.ts`。

## 注意

- 不改动既有 JSON 除非用户明确要求；否则只给"追加/替换"片段并标注影响。
- 任何与代码不符的假设（如护甲公式 def/(def+100) vs Dota 公式）要指出，见 references/project-conventions.md §公式。
