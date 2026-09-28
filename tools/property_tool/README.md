# 属性配置生成器 (property_tool)

一个轻量的本地 Web 工具，用于配置游戏属性值并实时预览最终要写入 Excel 的属性串。

## 功能

- **实时预览**：在左侧为各属性填数值，右侧即时生成最终 Excel 属性串。
- **解析回填**：粘贴已有的属性串（如 `1:500|10:100|...`）自动回填表单，方便改现有配置。
- **0 值处理**：默认忽略值为 0 的属性（0 往往表示无加成），可勾选「包含值为 0 的属性」。
- **倍率提示**：倍率 / 百分比型属性（魔抗、攻速、暴击率等）按 ×100 存整数，输入时实时显示对应运行时值（如 `25 → 0.25（25%）`）。
- **一键复制**：复制生成的属性串。

## 使用方式

直接双击打开 `index.html` 即可（纯静态，无需构建），或任意静态服务器托管：

```bash
python -m http.server 8099 --directory property_tool
# 打开 http://127.0.0.1:8099/index.html
```

## 属性格式

```
id:value|id:value|...
```

- `id`：属性编号（即 `AttributeType` 枚举值）。
- `value`：最终写入 Excel 的数值（整数，倍率/百分比型为 ×100 后的整数）。
- 不同属性之间用 `|` 分隔，结果按 `id` 升序排列。

示例：`1:500|3:42|4:1|5:320|6:5|7:25|10:100|16:100`

## 属性表

| id | 名称 | 枚举 | 缩放 |
|----|------|------|------|
| 1 | 最大生命 | MaxHp | ×1 |
| 2 | 最大魔法 | MaxMana | ×1 |
| 3 | 攻击力（局内 attack_damage） | Atk | ×1 |
| 4 | 攻击速度（倍率） | AtkSpeed | ×100 |
| 5 | 移动速度 | MoveSpeed | ×1 |
| 6 | 护甲（局内 armor） | Def | ×1 |
| 7 | 魔法抗性（补数乘法） | MagicResist | ×100 |
| 8 | 闪避（补数乘法） | Evasion | ×100 |
| 9 | 生命恢复/秒 | HpRegen | ×1 |
| 10 | 魔法恢复/秒 | ManaRegen | ×1 |
| 11 | 伤害输出倍率 | DamageOut | ×100 |
| 12 | 物理受伤倍率 | IncomingPhysical | ×100 |
| 13 | 魔法受伤倍率 | IncomingMagical | ×100 |
| 14 | 暴击率 | CritRate | ×100 |
| 15 | 暴击倍率 | CritDmg | ×100 |
| 16 | 攻击距离 | AtkRange | ×1 |
| 17 | 闪电伤害 | LightningDmg | ×1 |
| 18 | 毒伤害 | PoisonDmg | ×1 |
| 19 | 燃烧伤害 | BurnDmg | ×1 |
| 20 | 冻结时长 | FreezeDuration | ×1 |

> **缩放说明**：倍率 / 百分比型属性（标 ×100）在配置表里用整数表示，代码运行时换算回浮点。
> 例如魔抗配置 `25` = 运行时 `0.25` = 25%；攻速配置 `100` = 运行时 `1.0`（100%）。
> 其余属性（×1）直接使用原始数值。
> 该规则与 `assets/scripts/game/battle/core/AttributeScaling.ts` 保持一致。

## 数据来源

- 属性编号与中文名取自 `assets/scripts/game/battle/core/Types.ts` 的 `AttributeType` 枚举与 `AttributeTypeName`。
- 缩放规则取自 `assets/scripts/game/battle/core/AttributeScaling.ts`。

## 说明

- 留空的属性不会写入结果；`0` 默认视为无加成而忽略（可在右侧勾选包含）。
- 生成的属性串按 `id` 升序排列，方便阅读与比对；顺序不影响游戏解析。
