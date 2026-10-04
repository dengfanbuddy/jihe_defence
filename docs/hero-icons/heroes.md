# 集合防御 · 10 个 Dota2 代表英雄（设计稿 + 头像/技能图标出图清单）

> 本文件由 `node tools/hero-icon-prompts/gen-prompts.mjs` 生成，**别手改** —— 改设计改 `tools/hero-icon-prompts/heroes.json`。

- 英雄 **10** 个：现役 4 个 + 新增 6 个
- 出图 **20** 张：英雄头像 256×256 × 10 + 技能图标 64×64 × 10
- 伤害体系：**只有物理 / 法术**（本作没有元素体系，`element_effects.json` 已于 2026-07 删除）

## 0. 两条先说清楚的硬口径

### 0.1 英雄技能**必须是被动**

`AbilitySystem.AddAbility()` 对被动技能会立即 `ApplyPassive()`（挂永久 Modifier），但**英雄侧没有任何主动施放入口** ——
`castAbility` 在整个工程里的唯一调用方是 `ai/BossAI.tryCastSkill`。所以 10 个英雄的技能全部设计成 `behavior: "passive"`。

想让英雄技能能按 CD 自动放（比如给水晶室女一个「主动开极寒领域」），要补的是**一处**：在英雄每帧的 tick 里对
`hero.abilities.getCastableSkills()` 逐个尝试施放（`Ability.Cast` 已实现，含冷却与蓝耗判定）。
本稿不依赖这一条 —— 全部 10 个技能**不加一行 TS 就能生效**。

### 0.2 技能效果全部走现有声明式词汇

只有两种来源，都在 `excel_table/EffectTypes.ts` 里：

| 来源 | 何时生效 | 可用动作 |
|---|---|---|
| `modifiers.effects[]` | Modifier 存活期间**持续**（声明式） | `modify_attr` / `apply_state` / `tick_damage` / `tick_heal` / `tick_apply_modifier` |
| `modifiers.events[].actions[]` | **事件触发**时执行一次 | `damage` / `aoe_damage` / `heal` / `apply_modifier` / `remove_modifier` / `modify_attr` / `lifesteal` / `reflect` / `steal_gold` / `projectile` / `execute_script` |

⚠ **事件动作的目标是「事件目标，无则宿主」**（`Modifier.runAction`：`target = event?.target ?? host`）：

- `on_attack_landed` → `event.target` 是**被打的那个敌人** → 可以对他造成伤害 / 施加减速
- `on_take_damage` → `event.target` 是**宿主自己**（攻击者在 `event.source`）→ `aoe_damage` 会以自己为圆心；
  **`apply_modifier` 会施加到自己身上**，所以「受击时冻住打我的人」这类效果**声明式做不到**（本稿因此没这么设计）

## 1. 英雄总览

| id | 英雄 | Dota2 原型 | 伤害 | 流派 | 生命 | 魔法 | 攻击 | 攻速 | 射程 | 普攻索敌 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1001 | **火枪**<br>Sniper | Sniper | 物理 | 超远点杀 | 320 | 120 | 40 | 1.20 | 350 | 最远 | 现役 |
| 1002 | **赏金猎人**<br>Bounty Hunter | Bounty Hunter | 物理 | 经济成长 | 520 | 100 | 200 | 1.20 | 200 | 最近 | 现役 |
| 1003 | **宙斯**<br>Zeus | Zeus | 法术 | 连锁爆发 | 340 | 220 | 26 | 1.00 | 600 | 最近 | 现役 |
| 1004 | **斧王**<br>Axe | Axe | 物理 | 近战坦克反伤 | 560 | 80 | 34 | 1.00 | 200 | 最近 | 现役 |
| 1005 | **幻影刺客**<br>Phantom Assassin | Phantom Assassin | 物理 | 暴击爆发 | 300 | 100 | 44 | 1.10 | 200 | 最近 | **新增** |
| 1006 | **卓尔游侠**<br>Drow Ranger | Drow Ranger | 物理 | 远程攻速点杀 | 300 | 120 | 32 | 1.40 | 420 | 残血 | **新增** |
| 1007 | **水晶室女**<br>Crystal Maiden | Crystal Maiden | 法术 | 控场冻结 | 420 | 260 | 24 | 1.00 | 380 | 最近 | **新增** |
| 1008 | **莉娜**<br>Lina | Lina | 法术 | 单体贯穿爆发 | 320 | 200 | 30 | 1.05 | 480 | 最强 | **新增** |
| 1009 | **冥界亚龙**<br>Viper | Viper | 法术 | 持续剧毒 | 380 | 160 | 28 | 1.20 | 340 | 最近 | **新增** |
| 1010 | **谜团**<br>Enigma | Enigma | 法术 | 暗影溅射 | 400 | 240 | 26 | 0.95 | 360 | 最强 | **新增** |

> 攻速一栏已把配表的 int 换算回倍率（配表 `120` = 1.20 次/秒）。射程单位是**像素**（`battle_constants.pxPerMeter` = 50 px/m）。

### 流派覆盖

- **物理（5）**：火枪（超远点杀）、赏金猎人（经济成长）、斧王（近战坦克反伤）、幻影刺客（暴击爆发）、卓尔游侠（远程攻速点杀）
- **法术（5）**：宙斯（连锁爆发）、水晶室女（控场冻结）、莉娜（单体贯穿爆发）、冥界亚龙（持续剧毒）、谜团（暗影溅射）

## 2. 逐个英雄

### 1001 · 火枪 Sniper（现役）

> 射程最远的炮台。锁定最靠外的敌人点名，靠击退把贴脸的怪推回去。

- **Dota2 原型**：Sniper　**伤害**：物理　**流派**：超远点杀
- **基础属性**（配表 int 原值）：最大生命 320 / 最大魔法 120 / 攻击力 40 / 攻击速度 120 / 攻击距离 350
- **每级成长**：最大生命 12 / 攻击力 3
- **普攻**：间隔 1s　索敌 最远　弹道 musket
- **头像**：`textures/heros/huoqiang`

#### 技能：爆头冲击(被动)

**效果**：普攻附带 5% 攻击力的额外伤害；15% 概率击退敌人 1m

- 施加 Modifier 23（永久），kv={"pct":0.05,"chance":0.15,"knockback":1}
- modifiers.json 23（script_id: Modifier_MusketHeadshot，已实现）

**落地成本**：**不需要写代码**（纯配表）

---

### 1002 · 赏金猎人 Bounty Hunter（现役）

> 攻速最快、血量最厚的前排经济引擎。每一次命中都在偷钱。

- **Dota2 原型**：Bounty Hunter　**伤害**：物理　**流派**：经济成长
- **基础属性**（配表 int 原值）：最大生命 520 / 最大魔法 100 / 攻击力 200 / 攻击速度 120 / 攻击距离 200
- **每级成长**：最大生命 10 / 攻击力 2.5
- **普攻**：间隔 0.85s　索敌 最近　弹道 shuriken
- **头像**：`textures/heros/shangjin`
- ⚠️ **待确认**：攻击力 200 明显离群（其余英雄 24~44，设计稿写的是 12），疑似配表笔误，落地前请确认

#### 技能：偷钱(被动)

**效果**：普攻命中偷取 20 金币

- 施加 Modifier 13（永久）
- modifiers.json 13（events: on_attack_landed → steal_gold 20，纯声明式）

**落地成本**：**不需要写代码**（纯配表）

---

### 1003 · 宙斯 Zeus（现役）

> 射程 600 的法术炮台，靠链式弹射一次清算一整排怪。

- **Dota2 原型**：Zeus　**伤害**：法术　**流派**：连锁爆发
- **基础属性**（配表 int 原值）：最大生命 340 / 最大魔法 220 / 攻击力 26 / 攻击速度 100 / 攻击距离 600
- **每级成长**：最大生命 10 / 最大魔法 10 / 攻击力 2.5
- **普攻**：间隔 1.4s　索敌 最近　弹道 lightning
- **头像**：`textures/heros/zhousi`

#### 技能：雷霆之核·一阶(被动)

**效果**：普攻追加目标当前生命 3.5% 的法术伤害，并向附近 1 个敌人链式弹射（60% 衰减）

- 施加 Modifier 26（永久），kv={"chain":1,"decay":0.6,"pct":0.035,"autoT":0,"autoPct":0}
- modifiers.json 26（script_id: Modifier_ZeusThunder，已实现；19→20→21→22 是换 id 升阶链）

**落地成本**：**不需要写代码**（纯配表）

---

### 1004 · 斧王 Axe（现役）

> 血量最高的沙包。挨打本身就是它的输出手段。

- **Dota2 原型**：Axe　**伤害**：物理　**流派**：近战坦克反伤
- **基础属性**（配表 int 原值）：最大生命 560 / 最大魔法 80 / 攻击力 34 / 攻击速度 100 / 攻击距离 200
- **每级成长**：最大生命 22 / 攻击力 1.5
- **普攻**：间隔 1.25s　索敌 最近　弹道 （近战无弹道）
- **头像**：`textures/heros/fuwang`

#### 技能：反击风暴(被动)

**效果**：每受到 5 次攻击，对半个攻击距离内的所有敌人各造成一次攻击力的物理伤害

- 施加 Modifier 24（永久），kv={"need":5,"radiusFactor":0.5}
- modifiers.json 24（script_id: Modifier_CounterStorm，已实现）

**落地成本**：**不需要写代码**（纯配表）

---

### 1005 · 幻影刺客 Phantom Assassin（新增）

> 近战暴击核心。伤害方差最大的英雄，靠暴击倍率把单次普攻抬到 2.4 倍。

- **Dota2 原型**：Phantom Assassin　**伤害**：物理　**流派**：暴击爆发
- **基础属性**（配表 int 原值）：最大生命 300 / 最大魔法 100 / 攻击力 44 / 攻击速度 110 / 攻击距离 200
- **每级成长**：最大生命 11 / 攻击力 3.2
- **普攻**：间隔 1s　索敌 最近　弹道 （近战无弹道）
- **头像**：`textures/heros/huanci`

#### 技能：恩赐解脱(被动)

**效果**：暴击率 +25%，暴击倍率提升至 240%

- 施加 Modifier 27（永久）
- Modifier **27 幻影暴击**：duration 永久，stack_mode refresh
  - 属性：暴击率 25(add)、暴击倍率 240(best)
- 口径：纯声明式：暴击率 base=0 → 必须 add 百分点；暴击倍率 base=150 → 必须 best（写 add 会变成 150+240=390%）

**落地成本**：**不需要写代码**（纯配表）

---

### 1006 · 卓尔游侠 Drow Ranger（新增）

> 攻速 140 的远程射手，专挑残血补刀，靠霜冻箭把整排怪拖成慢动作。

- **Dota2 原型**：Drow Ranger　**伤害**：物理　**流派**：远程攻速点杀
- **基础属性**（配表 int 原值）：最大生命 300 / 最大魔法 120 / 攻击力 32 / 攻击速度 140 / 攻击距离 420
- **每级成长**：最大生命 11 / 攻击力 2.6
- **普攻**：间隔 0.9s　索敌 残血　弹道 arrow
- **头像**：`textures/heros/zhuoer`

#### 技能：霜冻之箭(被动)

**效果**：攻击力 +6；普攻命中使敌人移速 -40%、持续 2 秒

- 施加 Modifier 28（永久）
- Modifier **28 霜冻之箭(被动)**：duration 永久，stack_mode refresh
  - 属性：攻击力 6(add)
  - 事件 `on_attack_landed` → 施加 Modifier 2（2s），kv={"slow":-40}
- 口径：纯声明式：复用现成的 modifier 2「减速」（它的 attrs 用 value:-90、var:'slow' 占位，kv 传 -40 即 -40%）

**落地成本**：**不需要写代码**（纯配表）

---

### 1007 · 水晶室女 Crystal Maiden（新增）

> 法术侧的坦克。魔抗与回蓝最厚，靠概率冰封把冲脸的怪按在原地。

- **Dota2 原型**：Crystal Maiden　**伤害**：法术　**流派**：控场冻结
- **基础属性**（配表 int 原值）：最大生命 420 / 最大魔法 260 / 攻击力 24 / 攻击速度 100 / 攻击距离 380
- **每级成长**：最大生命 16 / 最大魔法 12 / 攻击力 1.8
- **普攻**：间隔 1.3s　索敌 最近　弹道 ice
- **头像**：`textures/heros/shuijing`

#### 技能：冰霜结界(被动)

**效果**：魔抗 +20、每秒回蓝 +3；普攻命中 20% 概率冰封敌人 0.8 秒

- 施加 Modifier 29（永久）
- Modifier **29 冰霜结界(被动)**：duration 永久，stack_mode refresh
  - 属性：魔法抗性 20(add)、魔法恢复/秒 3(add)
  - 事件 `on_attack_landed` → 施加 Modifier 7（0.8s），20% 概率
- 口径：纯声明式：魔抗 7 base=25 → add 20 → 45%；回蓝 10 base=0 → 必须 add（percent 恒为 0）；冰封复用 modifier 7「眩晕」

**落地成本**：**不需要写代码**（纯配表）

---

### 1008 · 莉娜 Lina（新增）

> 点杀最肉的怪。普攻自带额外法术伤害，越打越疼。

- **Dota2 原型**：Lina　**伤害**：法术　**流派**：单体贯穿爆发
- **基础属性**（配表 int 原值）：最大生命 320 / 最大魔法 200 / 攻击力 30 / 攻击速度 105 / 攻击距离 480
- **每级成长**：最大生命 12 / 最大魔法 10 / 攻击力 2.4
- **普攻**：间隔 1.15s　索敌 最强　弹道 fire
- **头像**：`textures/heros/lina`

#### 技能：神灭斩(被动)

**效果**：伤害输出 +20%；普攻命中额外造成 30 点法术伤害

- 施加 Modifier 30（永久）
- Modifier **30 炽热之魂(被动)**：duration 永久，stack_mode refresh
  - 属性：伤害输出倍率 20(add)
  - 事件 `on_attack_landed` → 造成 30 点法术伤害
- 口径：纯声明式：伤害输出倍率 11 base=100 → add 20 → 120（1.2×）；on_attack_landed 的 event.target 就是被打的敌人，所以 damage 直接落在它身上

**落地成本**：**不需要写代码**（纯配表）

---

### 1009 · 冥界亚龙 Viper（新增）

> 唯一会叠层的英雄。攻速越快，毒叠得越满、怪被黏得越死。

- **Dota2 原型**：Viper　**伤害**：法术　**流派**：持续剧毒
- **基础属性**（配表 int 原值）：最大生命 380 / 最大魔法 160 / 攻击力 28 / 攻击速度 120 / 攻击距离 340
- **每级成长**：最大生命 14 / 攻击力 2.2
- **普攻**：间隔 1.1s　索敌 最近　弹道 venom
- **头像**：`textures/heros/viper`

#### 技能：幽冥剧毒(被动)

**效果**：普攻命中施加剧毒：每秒 8 点法术伤害，每层使敌人移速 -10%（可叠 5 层）、持续 4 秒

- 施加 Modifier 31（永久）
- Modifier **31 幽冥剧毒(被动)**：duration 永久，stack_mode refresh
  - 事件 `on_attack_landed` → 施加 Modifier 32（4s）
- Modifier **32 剧毒**：duration 4，stack_mode stack，max_stack 5
  - 属性：移动速度 -30(add)；tick_damage
- 口径：纯声明式，需新增 2 条 modifier（31 施加者模板 + 32 可叠的毒）。⚠ **层数只放大属性、不放大 tick** —— `ModifierSystem.processTickEffect` 用的是 `eff.value` 原值、不乘 `stackCount`，只有 `modify_attr` 会乘（`Modifier.resolveAttr`：value × stackCount）。所以设计成「层数放大减速（每层 -30 移速，5 层 -150 即基础 300 的 -50%）+ DoT 恒为 8/s」。想让 DoT 本身也随层数涨，要改的是 `processTickEffect` 里那一行。

**落地成本**：**不需要写代码**（纯配表）

---

### 1010 · 谜团 Enigma（新增）

> 法术侧的群伤。每一发普攻都在目标身上撕开一个扩散的暗影裂口，专治抱团推进。

- **Dota2 原型**：Enigma　**伤害**：法术　**流派**：暗影溅射
- **基础属性**（配表 int 原值）：最大生命 400 / 最大魔法 240 / 攻击力 26 / 攻击速度 95 / 攻击距离 360
- **每级成长**：最大生命 15 / 最大魔法 11 / 攻击力 2
- **普攻**：间隔 1.35s　索敌 最强　弹道 shadow
- **头像**：`textures/heros/mituan`

#### 技能：黑洞(被动)

**效果**：攻击力 +8；普攻命中在目标处撕开暗影，对 130 半径内敌人造成 28 点法术伤害

- 施加 Modifier 33（永久）
- Modifier **33 黑洞(被动)**：duration 永久，stack_mode refresh
  - 属性：攻击力 8(add)
  - 事件 `on_attack_landed` → 对 130 半径内敌人造成 28 点法术伤害
- 口径：纯声明式（溅射版）：aoe_damage 以 event.target 为圆心
- 升级路径：要做成 Dota2 那种「把怪吸成一堆」的真聚怪，需要新增一个 script_id 逃逸口（如 Modifier_BlackHole：每 N 秒把攻击范围内敌人向自己拉近 1m，参照 Entity.ApplyKnockback 的反向）。声明式词汇里没有位移动作，这是全部 10 个设计里唯一需要写 TS 的一条。

**落地成本**：**不需要写代码**（纯配表）　（只有想做「真聚怪」时才需要（溅射版不需要））

---

## 3. 出图清单（20 张）

| key | 英雄 | 类型 | 交付尺寸 | 装机路径 |
|---|---|---|---|---|
| `hero_huoqiang` | 火枪 Sniper | 英雄头像 | 256×256 | `textures/heros/huoqiang` |
| `skill_huoqiang` | 火枪 Sniper | 技能图标 | 64×64 | `textures/skills/huoqiang_skill` |
| `hero_shangjin` | 赏金猎人 Bounty Hunter | 英雄头像 | 256×256 | `textures/heros/shangjin` |
| `skill_shangjin` | 赏金猎人 Bounty Hunter | 技能图标 | 64×64 | `textures/skills/shangjin_skill` |
| `hero_zhousi` | 宙斯 Zeus | 英雄头像 | 256×256 | `textures/heros/zhousi` |
| `skill_zhousi` | 宙斯 Zeus | 技能图标 | 64×64 | `textures/skills/zhousi_skill` |
| `hero_fuwang` | 斧王 Axe | 英雄头像 | 256×256 | `textures/heros/fuwang` |
| `skill_fuwang` | 斧王 Axe | 技能图标 | 64×64 | `textures/skills/fuwang_skill` |
| `hero_huanci` | 幻影刺客 Phantom Assassin | 英雄头像 | 256×256 | `textures/heros/huanci` |
| `skill_huanci` | 幻影刺客 Phantom Assassin | 技能图标 | 64×64 | `textures/skills/huanci_skill` |
| `hero_zhuoer` | 卓尔游侠 Drow Ranger | 英雄头像 | 256×256 | `textures/heros/zhuoer` |
| `skill_zhuoer` | 卓尔游侠 Drow Ranger | 技能图标 | 64×64 | `textures/skills/zhuoer_skill` |
| `hero_shuijing` | 水晶室女 Crystal Maiden | 英雄头像 | 256×256 | `textures/heros/shuijing` |
| `skill_shuijing` | 水晶室女 Crystal Maiden | 技能图标 | 64×64 | `textures/skills/shuijing_skill` |
| `hero_lina` | 莉娜 Lina | 英雄头像 | 256×256 | `textures/heros/lina` |
| `skill_lina` | 莉娜 Lina | 技能图标 | 64×64 | `textures/skills/lina_skill` |
| `hero_viper` | 冥界亚龙 Viper | 英雄头像 | 256×256 | `textures/heros/viper` |
| `skill_viper` | 冥界亚龙 Viper | 技能图标 | 64×64 | `textures/skills/viper_skill` |
| `hero_mituan` | 谜团 Enigma | 英雄头像 | 256×256 | `textures/heros/mituan` |
| `skill_mituan` | 谜团 Enigma | 技能图标 | 64×64 | `textures/skills/mituan_skill` |

完整提示词见同目录 `prompts.md`；投递用 `tools/relic-icon-prompts/comfyui_batch.py`（见 README §4）。
