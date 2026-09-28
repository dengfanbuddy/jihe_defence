# 项目配表结构 / 属性口径 / 公式（Jihe Defence）

> 目标：让配置产出**与代码口径完全一致**，避免"配对了却读不到/读歪"。
> 代码位置：`assets/scripts/game/`（战斗在 `battle/`，配表在 `excel_table/`，局外数据在 `data/`）。

## 0. 权威表（当前 tb/ 目录的全部内容）

权威（TbRoot 加载并消费）：`attributes.json`、`units.json`、`abilities.json`、`modifiers.json`、`relics.json`、`equipments.json`、`battle_constants.json`（共 7 张）。

曾存在的 `growth_curves.json`、`enemies.json`、`phases.json`、`passive_combos.json`、`element_effects.json` 及对应 `Tb_*Config.ts` 容器**已删除**，代码无残留引用。**不要再新增/引用这些表**；若确有需要，须同步建容器并注册到 TbRoot 管线。

**加英雄/怪物 → `units.json`（team=1 英雄 / team=2 怪物）**。属性加成效果 → 优先用 `modifiers.json`；技能 → `abilities.json`；局外装备 → `equipments.json`；全局参数 → `battle_constants.json`。

## 1. 属性字典（attributes.json，id 即 AttributeType）

| id | 名称 | 叠加 | 百分比型(×100)? | min/max |
|---|---|---|---|---|
| 1 | 最大生命 | add | 否 | 1~99999 |
| 2 | 最大魔法 | add | 否 | 0~9999 |
| 3 | 攻击力 | add | 否 | 0~9999 |
| 4 | 攻击速度 | multiply | ✅ | 10~1000 |
| 5 | 移动速度 | add | 否 | 50~1000 |
| 6 | 护甲 | add | 否 | -20~100 |
| 7 | 魔法抗性 | complement | ✅ | 0~95 |
| 8 | 闪避 | complement | ✅ | 0~95 |
| 9 | 生命恢复/秒 | add | 否 | 0~999 |
| 10 | 魔法恢复/秒 | add | 否 | 0~999 |
| 11 | 伤害输出倍率 | multiply | ✅ | 0~1000 |
| 12 | 物理受伤倍率 | multiply | ✅ | 0~1000 |
| 13 | 魔法受伤倍率 | multiply | ✅ | 0~1000 |
| 14 | 暴击率 | add | ✅ | 0~100 |
| 15 | 暴击倍率 | best | ✅ | 100~1000 |
| 16 | 攻击距离 | add | 否 | 50~2000 |

> `battle/core/AttributeScaling.ts` 定义哪些属性 ×100。**配置里写 int（100=100%），运行时 ÷100 消费 float（0.25）。**

## 2. 两条量纲铁律（最易错）

1. `units.json.base_attributes` = `[[属性id, int配置值], ...]`。百分比型（攻速/魔抗/闪避/暴率/暴伤/倍率）按 ×100 写：攻速 1.2 → `120`；魔抗 25% → `25`。普通属性（生命/攻击/护甲/移速/距离）写原值。
2. 英雄条目的 `growthValues` = `[[属性id, 每级成长float], ...]`，**浮点语义**：暴击 +0.5%/级 → `0.005`；护甲 +0.5/级 → `0.5`；生命 +25/级 → `25`。**不是 ×100**。（代码 `Scene_Game_Stage.applyHeroGrowth` 内部自行 ×scale 转 int。）**注意：攻速禁止写入 growthValues（全局铁律，见 docs/数值配置参考手册 §4.3）。**

### 示例（units.json 现役英雄：火枪 id=1001）
```json
{
  "id": 1001, "name": "火枪", "team": 1, "category": "hero",
  "base_attributes": [[1,320],[2,120],[5,280],[3,40],[4,120],[6,2],[8,2],[9,1],[14,5],[16,700]],
  "attack_interval": 1.0,
  "attack_targeting": "farthest",
  "growthValues": [[1,12],[3,3],[6,0.3],[14,0.005],[8,0.002],[9,0.02]],
  "abilities": [12, 16]
}
```
解读：火枪 40 攻、攻速 `120`(=1.2)、护甲 2、攻距 700（全场最远，普攻索敌 `farthest`）；每级 生命+12、攻击+3、护甲+0.3、暴率+0.5%/级（**无攻速行** —— 攻速禁止进 growthValues/局外加成，见 docs/数值配置参考手册 §4.3）。

**units id 分段（2026-06 起）**：英雄 1000 段 = 1001 火枪 / 1002 赏金猎人 / 1003 宙斯 / 1004 斧王；怪物 2000 段 = 2001~2008（2001~2004 普通 / 2005 精英 / 2006~2008 boss），每条带 `category: 'hero'|'monster'`，怪物另带 `subtype: 'normal'|'elite'|'boss'`。

## 3. 战斗公式（battle/DamagePipeline.ts、Entity.ts、Scene_Game_Stage.ts）

```
普攻间隔 = attack_interval / atkSpeed(float)
物理减免 = 1 - 0.06·armor / (1 + 0.06·|armor|)      // Dota 公式（100甲≈86%减伤）
魔法减免 = 1 - magicResist
伤害期望 = 单发 × (1 + 暴率×(暴伤-1))
击杀奖励 = (goldReward|expReward) × [1+(stage-1)×0.15] × [1+min(elapsed×0.00067, 0.4)]
gold_boss/exp_boss 奖励 ×10（rewardBossGoldBonus/ExpBonus）
```

⚠️ `battle_constants.defenseFormula: "def/(def+100)"` 是**未消费字符串**，别按它脑算护甲；按上表 Dota 公式或干脆统一公式口径。

### 常用全局 cap（battle_constants.json）
暴率 ≤0.6(60%)、闪避 ≤0.4、攻速 ≤3.0、攻距上限 15、minDamage 1、伤害层乘区分开。

## 4. 各表核心字段

### units.json（UnitCfg）
`id/name/team/base_attributes/abilities[]/attack_interval/attack_projectile*/growthValues(英雄)/gold/goldReward/expReward/rewardType(normal|elite|boss|gold_boss|exp_boss)/ai{type,params}/collision_radius/prefab`

### abilities.json
`id/name/behavior(unit_target|aoe|no_target|passive|attack)/cooldown/mana_cost/cast_range/damage_type(physical|magical|null)/targeting(effect 用)/effects[]/upgrades_to/projectile_prefab`
- effects.type：`damage`/`heal`/`aoe_damage`/`apply_modifier`(modifier+duration)/`projectile`/`steal_gold`/`execute_script`

### modifiers.json
`id/name/is_debuff/dispel_level/duration/stack_mode(none|refresh|stack|renew)/properties[[attrId,int值]]/tick{interval,damage,damage_type}/events[{event,actions[{type,ratio|value|modifier|duration|chance}]}]/states{stunned,invulnerable...}`

### equipments.json（局外装备收集，quality=1~2.5）
`id/code/name/description/category(hero_specific|d2_basic|d2_upgrade|d2_neutral)/quality(数字；≥2.5→percent层,<2.5→flat层)/heroId?/attributes{键:值 或 [[id,值]]}/bonusTypes?/allPercent?`
- 局外公式：`final = base×(1+Σpercent) + Σflat`（OuterAttributeCalculator）
- 高品质特殊效果：schema 暂无 effects 字段 → 方案①扩展 schema 加 effects；方案②复用 modifier 事件在拾取/装备时挂上。

### battle_constants.json
`defenseFormula(未用)/minDamage/caps/元素参数(burnDmgRatio...)/equipSlotCount/initial* /经验公式参数(heroExp/playerExp/battleExp 的 Base+Ratio)/clearReward*/enemyDrop*/rewardTime*/rewardBoss*/phaseDefaultRemainingTime/skillSlot*`

## 5. 局外系统（data/ 目录）与三模式约束

- **模式定义（2026 确认）**：难度模式（难度 1~100+，每 5 难度换关底 Boss，3~4 天/难度推进）/ 无尽模式（选难度基准、无阶段刷到死）/ Boss 模式（独立 Boss 池 → 碎片 → 合成 → 收集属性）。三模式详细数值口径见 `quick-method.md §0` 与项目文档 `docs/数值配置参考手册.md §3.5`。
- `HeroDataModule`：局外英雄 `level/exp`，经验需求 = `heroExpFormulaBase × ratio^(level-1)`；**局外等级目前未回乘战斗属性**（战斗成长靠局内等级 growthValues）。
- `EquipmentCollectionModule` + `EquipmentConfig.getAllEquipmentBonuses`：图鉴式收集（次数 × 单件加成）。
- `OuterAttributeCalculator`：`final = base×(1+Σpercent)+Σflat`，按 feature（equipment/talent/成就/Boss收集…）分组叠加——**所有局外成长层的注册入口**。
- ⚠️ **代码接线现状**：`OuterAttributeCalculator`/`getAllEquipmentBonuses` 目前无运行时消费点（未 apply 到战斗实体）——配好数值后还需接调用；新增局外系统 = 新增 feature 组 + 总预算 ≤ +50%。
- ⚠️ **局内等级**：设计目标是三模式均无上限；代码现状 `battle_constants.battleLevelMax=30` + `Scene_Game_Stage.addBattleExp` 会卡 30 级，做长局前需放开或按模式参数化。

## 6. 产出校验清单（写 JSON 前过一遍）

- [ ] 目标文件是权威表（units/abilities/modifiers/equipments/battle_constants），不是遗留表
- [ ] base_attributes 百分比属性 ×100；growthValues 用 float
- [ ] 数值都在 attributes.json min/max 与 cap 内
- [ ] abilities 引用的 modifier id 存在于 modifiers.json；units 引用的 ability id 存在于 abilities.json
- [ ] 字段名与 `Tb_UnitConfig`/`Tb_AbilityConfig`/... 接口一致（key 命名 snake_case）
- [ ] 新增 JSON 条目不顶替现有 id（或明确写"替换 id=N"）
- [ ] 金额/经验经 §3 奖励公式折完 ≈ 单局预算
