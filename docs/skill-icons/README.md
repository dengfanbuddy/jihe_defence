# 局内（肉鸽）技能审查 · 技能图标 · 技能图集

本轮针对 `assets/resources/tb/abilities.json` 里 **`scope = 'shop'` 的 30 个肉鸽技能（id 101~130）** 做了三件事：

1. **审查它们要不要重新设计** —— 结论是**要，30 条里 24 条要动**（§3、§4）。
2. 按项目既有的**白描徽记**口径出 **30 张技能图标**并装机（§6）。
3. 把**全部技能图标打成 Cocos Creator 图集**（plist + png，§7）。

> 逐技能的判定表在 **[`skills.md`](./skills.md)**（由生成器产出，含每条技能的结论 / 落地机制 / 要改的文案 / 图标主体）。
> 本文写的是**结论背后的口径**与**动手清单**。

---

## 0. 结论摘要

> **状态（2026-10 收尾）：30 条全部落地。** 下面这张表是**动手前**的历史判定，
> 现状见 §0.1。逐条的「审查结论 → 落地形态」对照在 [`skills.md`](./skills.md)
> （落地那两列是每次现读配表 + `modifiers.json` **推导**出来的，不是手写的）。

| | 数量 | 含义 |
|---|---|---|
| ✔ **纯声明式**，零新增 TS | **6** | 只要把 `effects` 填上就能生效（103 / 104 / 105 / 106 / 107 / 130） |
| ✎ **需一个脚本 Modifier** | **16** | 走高阶逃逸口（`script_id`），与现有的 `Modifier_MusketHeadshot` 同一套路 |
| ✎+ **需补一处引擎派发** | **1** | 127 闪避反击：闪避当前**不发任何事件** |
| ⟳ **需重设计** | **7** | 110 / 113 / 119 / 123 / 124 / 125 / 128 所依赖的机制**在本作根本不存在** |

审查时**这 30 条一条都不生效**：`effects` 全是 `[]`，长按技能槽弹出的详情面板上写的是
**「效果待实现（设计稿只给了文字）」**（`AbilityDesc.describeEffectsAtLevel` 的兜底文案）。
它们能抽到、能进技能槽、能升级、能看描述 —— **但一点战斗效果都没有**。

审查的真正结论不是「数值要调」，而是：
> **原稿有 7 条挂在「本作不存在的机制」上**（技能释放 / 技能伤害 / 冷却缩减 / 友军 / 元素 / 护盾池 / 召唤），
> 另有 17 条虽然机制成立，但**必须写代码**才能落地（声明式动作有 4 个硬性表达力缺口，见 §2）。

---

## 0.1 现状（落地之后）

| | 数量 | 说明 |
|---|---|---|
| ✔ 已落地 · **纯声明式** | **7** | 103 / 104 / 105 / 106 / 107 / 110 / 130 —— 改配表就生效 |
| ✔ 已落地 · **脚本 Modifier** | **17** | 全在 `assets/scripts/game/battle/ShopSkillModifiers.ts`（一个文件 25 个类） |
| ✔ 已落地 · **声明式 + 脚本** | **6** | 108 / 117 / 120 / 127 / 128 / 129 —— 能用声明式的半句就没写成脚本 |

- **新增 28 行 Modifier**（id 40~67），`modifiers.json` **32 → 60 行**；
- `npm run check` 的「商店技能没有战斗效果」告警 **30 → 0**；
- **新增一处引擎派发**：`Entity.resolveAttackHit` 的闪避分支现在会发 `on_evade`
  （并派发给**闪避者**的 Modifier）—— 顺带把「闪避」与「格挡」彻底分开；
- **新增一个总线事件** `on_gold_gained`：脚本改 `hero.gold` 后必须发它，场景层据此刷新 HUD；
- `npm run audit:skill` **45 → 116 条断言**，覆盖四类需求（按攻击力算伤害 / 条件判断 /
  写 `blocked` 字段 / 挂总线事件）+ 层数上限 + 分级切换 + 周期性行为。

---

## 1. 审查方法：不读注释，真跑源码

本项目的 `AGENTS.md` 与代码注释里对这套战斗系统的描述**有几处是过时的**（本文档顺手纠正了三处，
见 §9）。所以本次审查不采信注释，全部结论都由**源码调用图 + 真配表**推出来：

- 枚举**全部**事件派发点：`DispatchEvent(` 与 `bus.publish(BattleEvents.` 的每一个调用处；
- 枚举**声明式动作词汇**：`EffectExecutor.execute` 的 `switch(action.type)` 全部分支 +
  `EffectTypes.ts` 的全部接口字段；
- 枚举**可用属性**：`attributes.json` 16 行 + `Types.ts` 的 `AttributeType`；
- 枚举**可达性**：谁调用 `Ability.Cast` / `getCastableSkills` / `RemoveAbility` / `Trigger`；
- 逐条把 30 个技能的原稿文案往这套词汇上投影，**投不上去的就是要动的地方**。

> ⚠ 一个方法论坑（本次真踩过）：PowerShell 的 `Select-String -Path "a\**\*.ts"` 里
> `**` 只等价于**一层** `*`。用它搜「`Trigger()` 有没有调用方」得到的是**空的假阴性**，
> 而换 ripgrep 递归搜才发现真相是「确实一个调用方都没有」。**跨目录搜代码一律用 grep 工具。**

---

## 2. 决定设计的 13 条引擎口径（每条都有落点）

这一节是本文档的主体：**30 条技能里几乎每一条的结论都直接由这 13 条推出来**。

### 2.1 只有 5 个事件会派发给 Modifier

`ModifierSystem.DispatchEvent` 才是把事件送到 `Modifier.OnBattleEvent` 的唯一通道。
全工程只有 **5 处**调用它：

| 事件名 | 派发给谁 | 落点 |
|---|---|---|
| `on_attack_start` | 攻击者 | `Entity.ts:343`（**返回 true 可取消这次普攻**） |
| `on_attack_landed` | 攻击者 | `Entity.ts:379` |
| `on_block_damage` | 受击者 | `DamagePipeline.ts:108` |
| `on_take_damage` | 受击者 | `DamagePipeline.ts:132` |
| `on_deal_damage` | 伤害来源 | `DamagePipeline.ts:134` |

`BattleEvents` 里另外 **15 个**事件（`on_kill` / `on_death` / `on_heal` / `on_projectile_hit` /
`on_ability_cast` / `on_state_changed` / `on_entity_added` …）**只 `bus.publish`，从不 `DispatchEvent`**。

> **后果**：`modifiers.json` 的 `events[].event` 只要写了这 15 个名字里的任何一个，
> **永远不触发**（不报错、不警告，静默失效）。
> 现网 9 条带 events 的 modifier 全挂在 `on_attack_landed` / `on_take_damage` 上，
> 恰好都在安全名单里 —— 所以这个坑还没爆过。
>
> **要用总线事件就得写脚本**：脚本在 `OnCreated` 里 `ctx.bus.on('on_kill', ...)`，
> **必须在 `OnDestroy` 里 `off`**（实体走对象池复用，不摘会重复计数）。

### 2.2 `on_attack_landed` 不带 `isCrit`，`on_deal_damage` 带

- `Entity.resolveAttackHit:377` 组的事件是 `{ attacker, target, damage: finalDamage, damageType }` —— **没有 isCrit**。
- `DamagePipeline:124-130` 的 `dmgEvent` 是 `{ source, target, rawDamage, finalDamage, damageType, isCrit, ability, reflected }` —— **有 isCrit**。

> **后果**：126 暴击连锁**不能**挂 `on_attack_landed`，必须挂 `on_deal_damage`（它派发给伤害来源＝英雄自己，正是想要的）。

### 2.3 「护盾」不是实体字段，是 `on_block_damage` 里的一个可变字段

`DamagePipeline.ts:103-110`：

```ts
const shieldEvent = { target, source, damage, damageType, blocked: 0 };
target.modifiers?.DispatchEvent('on_block_damage', shieldEvent);
damage -= shieldEvent.blocked;
```

全工程**没有** shield 字段（`EntityBus` 里的 `hero_shield_status` 只是旧事件名）。
护盾 ＝ 某个 Modifier 在 `on_block_damage` 里往 `blocked` 里写字。

> **后果**：112 圣盾、108 铁壳 l3 必须写脚本 —— **声明式动作没法写 `blocked`**。

### 2.4 伤害数值是**绝对值**，只有属性条目能绑变量（**最关键的一条**）

`Tb_AbilityConfig.ts:43-45` 的 `damage` / `aoe_damage` / `heal`，与 `EffectTypes.ts:60-67` 的
`tick_damage` / `tick_heal` —— **字段里只有 `value: number`，没有 `var`、没有 `pct`**。

而**只有** `modify_attr` 的属性条目支持变量绑定（`EffectTypes.ts:20-29` 的 `AttrEntry.var` 与
`ModifyAttrEffect.attrs_var`，实现在 `resolveAttrEntries`）。

> **后果（这条决定了 17 条技能要不要写脚本）**：
> 「**造成 X% 攻击力**」这类文案**声明式做不了** —— `value` 是个写死的常数，
> 而肉鸽里攻击力会一路涨，写死的数值几分钟后就贬值成 0。
> 要么把它改成固定值（接受贬值），要么写 `script_id` 在代码里按 `atk` 算。
> 反过来，「**减速 20%**」「**破甲 N**」这类**属性类**减益**能做**（属性条目有 `var`，
> 施加方用 `kv: { slow: -60 }` 传值，移速 base=300 所以 -60 就是 -20%）——
> 这也是 117 寒刃能靠声明式落地、而 116 燃刃的 DoT 不能的原因。

### 2.5 `modifiers.cd` 是**死代码**

`Modifier.Trigger()`（`Modifier.ts:126-131`）是全工程**唯一**调用 `OnTriggered()` 的地方，
而 `grep '\.Trigger\('` 在 `assets/scripts` 下**零命中**（只有定义处）；`IsReady()`
也只被 `Trigger()` 自己调用。`ModifierSystem.Tick:257` 确实在递减 `cdRemaining`，
**但没有任何东西会去触发它**。

> **后果**：`modifiers.json` 的 `cd` 列**配了不生效** —— 递减的计时器没有消费者。
> 要做「每 N 秒触发一次」，只能在脚本的 `OnTick(dt)` 里自己计时
> （`Modifier_ZeusThunder` 的四阶自动落雷就是这么写的）。
> ⚠ `AGENTS.md` 里「带 cd 的被动各算各的」这句是**半对**的：计时确实各算各的，但没有触发方。

### 2.6 `tick_damage` 不随层数放大，只有属性条目会

`ModifierSystem.processTickEffect:277-284` 用的是 `eff.value` **原值**；
而 `Modifier.GetModifierProperty:166` 是 `value * this.stackCount`。

> **后果**：116/118 的「叠 6 层灼烧/毒液」放大的是**属性类减益**，
> **DoT 恒为单层数值**。这两条的文案必须跟着改口径，否则是在骗玩家。

### 2.7 `percent` 打在 base=0 上恒为 0

`attributes.json` 里 base 为 0 的有：**护甲(6) / 闪避(8) / 生命恢复(9) / 魔法恢复(10) / 暴击率(14)**。
`AttributeSystem.combine:150` 是 `result *= 1 + Σv/100`，base=0 乘任何数都是 0。

> **后果**：108 铁壳的「护甲减伤 +6%」**必须写成 `add` 固定值**（护甲 +2/+4/+7），
> 107 暴击机芯的暴击率同理。这条已被 `check:affix` 的 `numeric_percent_zero_base` 拦，不会重犯。

### 2.8 护甲是双曲减伤曲线，不是线性百分比

`DamagePipeline.applyResistance:165-169`：`multiplier = 1 - (0.06a)/(1 + 0.06|a|)`。

> **后果**：原稿「护甲减伤 +18%」不能直接抄成 18 这个数 ——
> 护甲 +7 ≈ 减伤 30%，护甲 +18 ≈ 减伤 52%。**这是数值要重定的原因，不是文案问题。**

### 2.9 英雄**永远不会施放技能**

- `AbilitySystem.getCastableSkills()`（`AbilitySystem.ts:67`）**全工程零调用方**；
- `Ability.Cast` 的唯一外部调用方是 `ai/BossAI.tryCastSkill`（怪物侧）；
- `AbilitySystem.AddAbility:51` 对 `behavior='passive'` 立即 `ApplyPassive()`。

> **后果（30 条里 3 条直接死在这上面）**：
> 119 雷链「**技能释放**时附加连锁闪电」、124 镜像分身「**释放技能**时召唤分身」
> —— 英雄根本不会释放技能，这两条**永远不触发**。
> 同时 110 过载 l3「**技能冷却** -12%」与 124 l3「技能冷却 -20%」也一起作废。
> 另外 `percent` 那条「技能伤害」在本作**没有对应属性**（16 个属性里没有它）。

### 2.10 「友军」在本作不存在

本作是**单英雄塔防**：`units.json` 里 team=1 只有 10 个英雄，场上同时只有一个；
没有任何召唤物（见 2.11）。

> **后果**：128 战旗「周围 3.5m **友军**增伤 15%」的增伤部分**永远只作用于自己**——
> 那句话在机制上是废话，真正生效的是后半句「降低敌人护甲 10%」。

### 2.11 召唤物没有任何表现路径

`MonsterPool.ts:35`：

```ts
const MONSTER_PREFAB = 'prefabs/unit/monsters/one';   // 所有怪共用同一个占位预制件
```

`acquire()` 把每只怪都绑到这个硬编码路径上；英雄则是场景里**预置的** `heroNode`。
**team=1 的召唤物既不走怪物池、也没有英雄预制件** → 会是一个纯逻辑实体、屏幕上什么都不显示。
另外 `units.json` 里也没有「可召唤单位」的行，召唤物还需要 AI 与生命周期回收。

> **后果**：123 哨兵炮台 / 124 镜像分身 / 125 元素军阵 这三条「召唤流」是**一条独立的产品级功能线**
> （要补：单位配置行 + 表现路径 + AI + 回收），不该由一条肉鸽技能顺带带出来。
> 本轮的处理是**保留名字与设计意图、把机制换成等价的无基建版本**（见 §4.4）。

### 2.12 技能被顶掉后，它挂的 Modifier **不会摘**（真 bug）

```ts
// AbilitySystem.ts:55
RemoveAbility(id: number): void {
    this.abilities = this.abilities.filter((a) => a.getId() !== id);
}
```

`Ability.removeOwnModifiers()` 是 **private**，只被 `Ability.setLevel` 调用。
而 `SkillSlots.grant` 顶掉旧技能时走的正是 `hero.abilities.RemoveAbility(replacedId)`。

> **后果（这是本轮最严重的一条）**：**肉鸽技能被替换后，它给的属性加成永久留在英雄身上。**
> 30 条肉鸽技能全是 `passive` + `modify_attr`，所以这条对它们是**致命的** ——
> 抽了「迅捷 +25% 攻速」再换成「强健」，攻速会一直白给。
> 英雄自带技能因为槽 0 永久锁定、不可替换，所以这个 bug 一直没暴露。
> `AbilitySystem.Clear()`（对象池复用前）有同样的漏。
>
> **落地任何一条 shop 技能之前必须先补这一处**（`RemoveAbility` 里加
> `a.removeOwnModifiers()`，把 private 改成 public 或加一个公开方法）。

### 2.13 `on_take_damage` 派发在**死亡检查之前**（一条能救命的好口径）

`DamagePipeline` 的阶段顺序是：
**第 6 阶段扣血（`:121`）→ 第 7 阶段派发 `on_take_damage`（`:132`）→ 第 8 阶段检查死亡（`:137`）**。

> **后果**：挂在 `on_take_damage` 上的脚本只要在事件里把血补回来，
> 第 8 阶段的 `IsDead()` 就不成立、`Die()` 不会被调用 ——
> **129 时间回廊的「死亡时逆转时间」能真的拦住死亡**，不需要改引擎。
> 这是整份设计里最巧的一条，落地时要**防递归**（补血可能触发别的治疗/伤害事件）。

---

## 3. 结论：要重设计，但不是推翻重来

分两类看：

**① 机制成立的（23 条）** —— 原稿的**设计意图是对的**，只是**表达不了**。
处理方式是把机制「翻译」到真实的钩子上，**名字、品质、阶段、权重、流派标签全部保留**
（它们是肉鸽经济与抽取曲线的一部分，动了要重算整条成长曲线）。
例：116 燃刃「每秒 15% 攻击力」→ 数值改成固定值（或脚本按 atk 算），
机制仍是「普攻附加可叠层的灼烧」，图标仍是火焰剑。

**② 机制不存在的（7 条）** —— 必须换锚点，因为原稿挂在这些东西上：

| 技能 | 挂在哪 | 本作现状 |
|---|---|---|
| 110 过载 | 技能伤害 / 技能冷却 | 两个属性都不存在；英雄不施法 |
| 119 雷链 | 技能释放 | 英雄不施法 |
| 124 镜像分身 | 技能释放 + 召唤 | 两者都不存在 |
| 123 哨兵炮台 | 召唤一个实体 | 召唤基建整条不存在（2.11） |
| 125 元素军阵 | 召唤 + **元素** | 召唤不存在；**本作只有物理/法术，没有元素**（`element_effects.json` 2026-07 已删） |
| 128 战旗 | 友军 | 没有友军（2.10） |
| 113 回旋镖 | 弹道返程 | `Projectile` 是纯直线一次性，没有返程 |

---

## 4. 重设计定案（四类落地路径）

> ⚠ **§4 整节是"动手前的方案"**。四类现在**全部已落地**，实况见 §0.1 与 §11.5；
> 逐条的「审查结论 → 落地形态」对照见 [`skills.md`](./skills.md)。
> 落地时对方案有**两处偏离**，都记在 §11.5：① 115 榴弹直接做成按攻击力算（原本打算先按固定值）；
> ② 109 首击必须挂在 `on_attack_start` 上（原方案写的 `on_attack_landed` 判满血**永远为假**）。

### 4.1 A 类 · 纯声明式（6 条，零新增 TS）

把 `effects` 填上就生效。**这一类可以立刻落地，是性价比最高的**。

| id | 技能 | 落地写法 | 文案要改 |
|---|---|---|---|
| 103 | 嗜血 | `modifiers.events[on_attack_landed].actions[lifesteal ratio .05/.09/.14]` | l3「过量转护盾」→ 没有护盾池，改「吸血时额外回复 atk×0.2」或砍 |
| 104 | 迅捷 | `modify_attr [4 攻速, +8/+15/+25, add]` | l3 的「攻速≥2.5 时必暴击」是条件式 → 砍，数值提到 +35 |
| 105 | 鹰眼 | `modify_attr [16 攻击距离, +12/+20/+32, percent]` | l3 的条件式 → 砍，数值提到 +45 |
| 106 | 强健 | `modify_attr [1 最大生命, +12/+22/+35, percent]` | l3「每秒 1% 最大生命」→ `[9 生命恢复, +N, add]`（tick_heal 是定值） |
| 107 | 暴击机芯 | `[14 暴击率, +8/+15/+24, add]`；l3 追加 `[15 暴击倍率, 170, best]` | 无（最干净的一条） |
| 130 | 恶魔契约 | `[3 攻击力, +40/+60/+100, percent]` + `[1 最大生命, -15/-25/-40, percent]` | l3 的「技能冷却 -25%」砍 |

> ⚠ 130 减最大生命要留意「满血口径」：`Entity.ApplyWithMaxHpCarry` 只给**永久**上限变化用，
> 上限下降时当前生命要跟着钳回去，否则会出 `hp > maxHp` 的脏数据。

### 4.2 B 类 · 一个脚本 Modifier（17 条）

**已落地**：实现全部在 `assets/scripts/game/battle/ShopSkillModifiers.ts`（25 个类，
其中 24 个是这 30 条技能用的，另 1 个 `Modifier_Ignite` 被 115/116 共用），
注册在 `Scene_Game_Stage.initBattle`（走 `SHOP_SKILL_SCRIPT_CLASSES` 一张表，加技能只改那张表）。

走 `script_id` 逃逸口 —— **这条路已经铺好了**，工程里已有 4 个先例
（`Modifier_MusketHeadshot` / `Modifier_ZeusThunder` / `Modifier_CounterStorm` / `Modifier_EagleEye`）
与 1 个 Ability 先例（`Ability_LightningChain`），注册入口在
`Scene_Game_Stage.initBattle`（`:453-457`）。

它们需要脚本的原因只有四种，**没有第五种**：

1. **要按攻击力算伤害**（2.4）→ 101 分裂弹 / 102 穿透弹 / 109 首击 / 115 榴弹 / 116 燃刃 / 118 毒刃 / 119 雷链；
2. **要一个条件判断**（声明式动作只有 `chance`，没有条件）→ 109 首击（满血？）/ 121 影剪（残血？）/ 120 静电磁场（满 5 层？）/ 112 圣盾（够不够？）/ 108 铁壳 l3；
3. **要写事件里的可变字段** → 112 圣盾 / 108 铁壳 l3（`blocked`，见 2.3）；
4. **要挂总线事件**（2.1）→ 111 淘金 / 122 击杀回响（`on_kill`）、126 暴击连锁（`on_deal_damage` 读 `isCrit`，2.2）、129 时间回廊（能拦死亡，2.13）。

**写脚本时的三条纪律**（**已落地，且每条都有对应断言**）：

- **`bus.on` 必须配 `bus.off`**（`OnDestroy`）—— 实体走对象池，不摘会重复计数
  → `audit:skill` 的 L1b 断言「摘掉 111 后 `on_kill` 订阅数为 0」；
- **不要依赖 `modifiers.cd`**（2.5 死代码），计时自己在 `OnTick(dt)` 里做
  → P 组断言（123 不到点不开火 / 128 到点破甲）；
- **防递归**：脚本自己打出的伤害会再次派发事件（126 尤其危险），用 `event.ability` 或递归标记过滤
  → 119 / 120 / 126 都带 `busy` 标志。

> **落地时新发现的一条**：这四个原因之外还有**第五种"看起来像却不同"的情形** ——
> 需要"**在伤害发生之前**判定"的技能（109 首击判满血）不能挂在 `on_attack_landed` 上
> （那是扣血之后），必须用 `on_attack_start` 记标记再在 landed 消费。详见 §11.5。

### 4.3 C 类 · 需补一处引擎派发（1 条）—— **已补**

**127 闪避反击**。闪避原本**什么都不发**：

```ts
// 旧：Entity.resolveAttackHit:372-373
const evasion = target.attrs?.get(AttributeType.Evasion) ?? 0;
if (evasion > 0 && Math.random() < evasion) return 0;   // ← 直接 return，没有任何事件
```

远程虽然会经 `Projectile` 发 `on_projectile_miss`，但它是**只发总线**（2.1）且
`reason` 只有一个 `'evaded_or_blocked'`，**分不清是闪避还是格挡**。

**已补的钩子**（`Entity.resolveAttackHit`，就地 3 行）：

```ts
if (evasion > 0 && Math.random() < evasion) {
    const evadeEvent = { attacker: this, target, dodger: target };
    this.ctx.bus.publish(BattleEvents.OnEvade, evadeEvent);          // 表现层/UI 可订阅
    target.modifiers?.DispatchEvent('on_evade', evadeEvent);         // ★ 派发给**闪避者**
    return 0;
}
```

三个设计取舍：
- **派发给闪避者**（不是攻击者）—— 与 `on_take_damage` 派发给受击者同口径，
  挂在英雄身上的「闪避反击」才收得到（攻击者在 `event.attacker`）；
- **总线与 Modifier 两路都发** —— 与 `on_attack_start` / `on_attack_landed` 的既有写法一致；
- 顺带把「**闪避**」与「**格挡**」彻底分开：格挡是 `on_block_damage` 里写 `blocked`（108 / 112），
  闪避是 `on_evade` —— 之前两者共用 `on_projectile_miss` 那个含糊的 reason。

**已落地**：脚本 `Modifier_EvadeCounter` 挂在 `on_evade` 上，反击 150/250/350% 攻击力；
l2 用 Modifier 7 眩晕 0.5 秒，l3 的护盾**复用 112 的护盾池实现**（护盾逻辑只有一份）。
断言见 `audit:skill` 的 M 组。

### 4.4 D 类 · 重设计（7 条，名字与图标保留）

原则：**保住玩家感知，换掉不存在的机制**。全部换成**零基建**的等价版本。

| id | 技能 | 原稿 | 重设计为 | 为什么玩家感知不变 |
|---|---|---|---|---|
| 110 | 过载 | 技能伤害 +10%、冷却 -12% | `[11 伤害输出倍率, +6/+10/+16, percent]`；l3 给受伤倍率减伤 | 「越打越猛」的手感保留；attr 11 与 130 的「攻击力」是**不同乘区**，不重复 |
| 113 | 回旋镖 | 弹道返程再打一次 | 「命中后弹向次近敌人，atk×60%/75%」 | 「一次攻击打两下」保留；与 114 划清界限：**113 = 打第二次，114 = 换目标链式** |
| 119 | 雷链 | 技能释放附连锁闪电 | 改锚到 `on_attack_landed`：向最近敌人链式弹射 2/3/4 跳 | 与 114 拉开区分度（**119 = 跳数多、衰减狠**，114 = 定值 55% 纯弹射） |
| 123 | 哨兵炮台 | 召唤一座炮台 | 「每 N 秒自动对射程内最近敌人开火，atk×50%/90%/120%」（脚本 `OnTick` 计时） | 「多一路白嫖火力」保留；零基建 |
| 124 | 镜像分身 | 释放技能时召唤分身 | 「普攻有 N% 概率追加一次 atk×40%/60%/90% 的额外打击」 | 「多一个自己在打」保留；零基建 |
| 125 | 元素军阵 | 每击杀 3 个召唤小兵 | 「每击杀 3 个攒 1 层（上限 3/5/8），普攻时消耗全部层数、每层追加 atk×30%/45%/60%」 | 「军阵越打越厚」保留；且不再引用**不存在的元素体系** |
| 128 | 战旗 | 友军增伤 + 破甲 | **自身光环**：给自己 `[11, +15/+22/+30, percent]`；脚本 `OnTick` 对周围 3.5~4m 敌人定期破甲/减速 | 「旗子插在这儿这里就强」保留；单英雄局里原稿的「友军」等于自己 |

> **召唤流是真实的产品缺口，不是设计错误**。123/124/125 的共同诉求「场上多几个东西」，
> 要单独立项：`units.json` 加召唤单位行 → 给 `MonsterPool`/`EntityViewPool` 一条 team=1 的
> 表现分支（`EntityViewPool.acquire` 本身**支持任意 prefabPath**，所以并不难，
> 难的是 AI + 生命周期 + 与英雄的绑定）→ 再把这 3 条换回实体版本。
> **图集里给它们留的帧名不变**，届时只改 `effects`，不用重出图。

---

## 5. 落地顺序（建议）

1. **先补 2.12 那个 bug**（`RemoveAbility` 不摘 Modifier）—— 否则后面做的每一条 shop 技能都会漏属性；
2. **A 类 6 条**（纯配表，一次 `apply` 就能验证）；
3. **C 类补钩子**（1 行，同时解决 108 l3 / 112 / 127 三家）；
4. **B 类 17 条**（写脚本，按 §4.2 的四种原因分批）；
5. **D 类 7 条**（重设计后的机制与 B 类同批实现）；
6. 每一步都要给 `audit:hero` 那一套补断言 —— **配表写对了不等于生效**，
   `audit:slot` 只验槽位规则、`audit:attr` 只验遗物属性，**都不验这 30 条技能打出来什么**。

> 本轮**只做了审查 + 图标 + 图集**，`effects` 一个字没改（见 §8 的诚实边界）。

---

## 6. 图标规格

**风格与英雄头像、技能图标同一套**（白描徽记），不是遗物那套：

| 项 | 口径 |
|---|---|
| 主体 | **纯白 `#F6F6F6` 单色**，形状靠「实心白块 + 内部细节挖空」表达（stencil/剪纸） |
| 背景 | 图片里没有背景 —— 出图时画在深板岩灰 `#445054` 上，**本地按四边实际底色色键抠掉** |
| 显示底色 | 来自预制件：`skills/inner` 是 **`#70ACB3` 青绿**（选人卡 20×20、HUD 50×50） |
| 交付 | **64×64 RGBA**（出图 512×512 → 直接重采样到 64；2026-10 从 200 压到 64，理由见 §6.2） |
| **包围盒必须正方形** | `skills/inner` 是 `sizeMode=CUSTOM` + `trim=true` → 包围盒非方会被拉伸（§6.1） |

### 6.2 为什么压到 64×64（2026-10 口径）

技能图标在工程里的**真实显示处最大只有 50×50**（HUD `skills` 节点下每个 `skill{N}` 的 `icon`），
选人卡更小（`content/skills` 是 **20×20**，全工程最小显示处）。原来交付 200×200 是 **4 倍冗余**。

| | 200×200（旧） | **64×64（现）** |
|---|---|---|
| 40 张碎图合计 | ≈ 500 KB | **101 KB**（平均 2.6 KB/张） |
| 技能图集（未压缩） | 4.00 MB | **0.43 MB** |
| `skills.png` | 435 KB | **90.8 KB** |
| 真实槽位（50 / 20 px）观感 | 基准 | **肉眼看不出差别**（放大到 51 px 以上才略有差异） |

判断方法还是那句工程口径：**必须在真实槽位尺寸上看**。做法是把 200 版与 64 版并排、
各自缩到 50 与 20 贴在 `#70ACB3` 上对比 —— 50 px 下基本无法区分，20 px 下两者都已经到极限
（20 px 本来就糊，与源尺寸无关）。**源图 512×512 全部留着**，改尺寸只是重跑后处理。

> ⚠ 从 200 改成 64 有一个**必须做的连带动作**：`tools/hero-icon-prompts/gen-prompts.mjs` 的
> `SIZE.icon` 也要一起改（已改），否则 `textures/skills/` 里会混着 10 张 200×200 的英雄技能图，
> 图集里那 10 帧仍是 160×160，白占 60% 的面积。

### 6.1 三个已经踩过的坑（不要再走一遍）

1. **包围盒必须正方形，而且「把裁剪窗口补成正方形」没用** —— 包围盒由**不透明像素范围**定义，
   四周补透明像素改不了它。唯一有效做法是**把内容按 x/y 独立缩放成正方形**，
   并且打印形变倍数：**> 1.15 说明模型构图太扁/太瘦，要改提示词而不是接受形变**。
2. **必须无条件拍平 RGB** —— `LANCZOS` 有负瓣，在硬边上会过冲，预乘图里 246 会被冲到
   `#FFFFFF`（上一轮实测 **28% 的不透明像素变纯白**）。既然风格就是「一个纯色块」，
   就让 **alpha 独自承载形状、RGB 一律写死 246**（透明像素也写 246，避免边缘渗黑）。
3. **色键不写死色值** —— 提示词要的是 `#445054`，模型会画出 `(58,66,81)` 这类同族但不相等的颜色，
   所以按**四边采样实际底色取中位数**再做色键。

### 6.2 判断风格必须在**真实槽位尺寸**上看

全工程最小的技能图标显示处是**选人卡的 20×20**（`hero_select_panel/.../content/skills`），
HUD 是 50×50。200×200 大图看着都没问题，缩到 20px 才看得出糊不糊 ——
所以交付流程必须出一张**按真实槽位尺寸**的对照图（`make-hero-icons.py --sheet` 就是干这个的）。

### 6.3 为什么只给 30 条出图，不给 58 条

`abilities.json` 有 58 行，但**有 17 行是死数据**：

```
unit 段里没被任何单位引用的 id：2,3,4,5,6,8,9,10,11,12,13,14,15,18,20,21,22
```

（`units.json` 的 `abilities` 列实际只引用了 **1, 7, 16, 17, 19, 23, 24, 25, 26, 27, 28**。
其中 20/21/22 是宙斯的升阶链，虽然 `1003` 只写了 `19`，但 `UpgradeAbility` 会沿
`upgrades_to` 链走到它们，所以它们**不是**死的 —— 上一轮已经给整条链共用了
`zhousi_skill` 一张图。）

剩下 **16 行**（火球术 / 霜冻新星 / 圣光术 / 战吼 / 闪电链 / 荆棘光环 / 飞镖一~三阶 /
毒镖 / 鹰眼瞄准一~四阶 / 钢铁战吼）**没有任何消费者**，给它们出图是白花钱。
**处理建议：要么删掉这 16 行，要么等真做「每单位技能」时再补图。** 本轮两者都没做（只标出来）。

---

## 7. 技能图集（plist + png）

**同遗物图标那套口径**（`docs/relic-icon/README.md` §7.4 有完整的调研过程）：
用**图集资源 Atlas = `plist` + `png`**，不是自动图集 `auto-atlas.pac`
（后者只在构建时生成大图、工程里永远看不到，用户上一轮就是因此说「没见过」）。

### 7.1 四条硬口径（与遗物图集完全同源）

1. **帧的裁剪数据必须与碎图逐字段一致** —— 槽位是 `sizeMode=CUSTOM` + `trim=true`，
   `width`/`height`/`rawWidth`/`rawHeight`/`offsetX`/`offsetY` 一变，图标在槽里的**大小与位置就变**：
   `trimX = bbox.left`、`trimY = bbox.top`、`offsetX = (l+r)/2 - W/2`、`offsetY = H/2 - (t+b)/2`（**y 向上**）。
2. **`trimX`/`trimY` 不能拿去和碎图比** —— 碎图里它是「帧在那张小图里的坐标」，
   图集里是「帧在**整张图集**里的坐标」（= `textureRect` 原点），**本来就该不同**（上一轮栽过：误报 614 处）。
3. **plist 与 png 同名 → 「去掉扩展名的路径」不唯一**（哪个保留干净路径由构建器的去歧义策略决定，
   **没有公开契约**）→ 消费方走**三步降级**：图集本体 `SpriteAtlas` → 直取帧子资源
   `…/skills[.plist]/<帧名>` → 旧口径碎图路径 `<icon>/spriteFrame`，并把命中哪条路打进日志。
4. **回退不用改代码**：解 zip 放回碎图 + 删 `skills.plist`/`skills.png` → 第 3 步自动接管。

### 7.2 格式是**扒出来的**，不是猜的

照本机一份 3.8 **真导入过**的图集（`merge_tower_defense/assets/resources/icons/pack/texture.plist`）：
`importer: "sprite-atlas"`、`userData.format = 3`、子资源 uuid = `<图集uuid>@<5 位十六进制>`、
帧名带 `.png` 而子资源 `name` 去扩展名。引擎里那个导入器（`registerTexturePackerHandler`，注册名
`sprite-atlas`）编译在 `.ccc` 里读不到源码，官方文档也只说「用 TexturePacker 4.x 导 cocos2d-x 格式」
而不给字段表 —— 所以只能按真样本对账。

### 7.3 图集里装哪些帧

**帧集 = `abilities.json` 里 `icon` 列引用到的全部路径去重**（而不是「扫 `textures/skills/` 目录下的所有 png」）。
理由：目录里有 4 张**没有任何消费者**的遗留图，扫目录会把它们一起打进去：

| 文件 | 谁在用 |
|---|---|
| `bullet.png` | `SkillSlot.PLACEHOLDER_ICON` / `ShopRelicsItem.PLACEHOLDER_ICON` —— **是回落占位图，必须留在图集外** |
| `baotou.png`（128×128 青绿准星） | **无人引用**（遗留素材） |
| `huoqiang.png`（128×128 青绿准星） | **无人引用**（与 `textures/heros/huoqiang.png` 同名但不同图，遗留） |
| `魔棒·去背景.png`（**624 KB**） | **无人引用** —— 某次实验的残留，建议删（占着 `resources/` 的构建体积） |

### 7.4 ⚠ 显存是涨的，不是打平

商店/选人一屏只显示 4~10 个技能图标，碎图方案**只加载用到的那几张**（每张 ≈10 KB）；
图集方案**加载任意一张就会把整张图集拉进显存**。
换到的是**构建期确定性 + 能在编辑器里看到并展开子资源引用** —— 这个 trade-off 与遗物图集一致，
是上一轮用户明确选择的路线。

### 7.5 本轮实测数字（2026-10 落地）

**出图**：30 张 **一次成功 0 失败**，1 次投递全中，总耗时 **5.8 分钟、平均 12 s/张**
（第 1 张 26~36 s 是模型加载，之后稳定 9~12 s）。跑完 `nvidia-smi` 仍占 **13.7 GB** → 模型真常驻。

**后处理**：30 张全部 `chroma-key` 抠底 + 拍平白 + 正方形包围盒，结果
**纯白比例 100%（30/30）**、**真 alpha 100%（30/30）**、包围盒一律 **160×160**（正方形 ✔）、
四边留白各 **10.0%**、半透明像素 **2.6%~3.8%**（门槛 28%）。

**形变（`squeeze`）**：这轮真正的返工点。首轮 30 张里 **13 张 > 1.15×**，
全部是**主体天然细长**的那类（剑 / 旗 / 闪电 / 盾）。按工程口径「> 1.15 要改提示词而不是接受形变」
返工了 4 张最狠的，**做法是把「构图要方」写成具体动作**（而不是重复那句抽象的 square）：

| 技能 | 首轮 | 返工后 | 提示词怎么改的 |
|---|---|---|---|
| 102 穿透弹 | 1.31 | **1.06** | 「三块板排成一横排」→「弩箭走对角线，三块板**竖着叠**」 |
| 117 寒刃 | 1.36 | **1.02** | 「细长的剑」→「剑**截短**，护手向两侧张成长翼，六颗冰晶排成一条**横带**」 |
| 128 战旗 | 1.37 | **1.08** | 「旗杆贯穿整幅」→「杆**短而粗**，旗面**宽**（布明显比高更宽），两根流苏各向一侧伸到边」 |
| 109 首击 | 1.37 | 1.23 | 第一版改成「拳头从上往下砸」→ **过头了**（327×447 变成 374×508，反而更瘦）→ 再改成「拳头从左、靶在右，冲击尖刺**上下各四根**把高度补回来」 |

**结论（重要，写下来免得下次又试）**：模型对**具体构图动作**的响应很好，对抽象的
「剪影要接近正方形」基本不理；而**改方向容易过头**（首击那张就是），
所以返工要盯着 `squeeze` 这个数字迭代，别一次改太多。剩下 **10 张在 1.16~1.28** 之间
（火刃 1.28 / 圣盾 1.26 / 闪避反击 1.24 / 雷链 1.24 / 首击 1.23 / 元素军阵 1.23 / 迅捷 1.20 /
哨兵炮台 1.20 / 镜像分身 1.16 / 恶魔契约 1.16）—— **看真实槽位尺寸时它们读得清、也与已装机的 10 张
英雄技能图风格一致，所以按「可接受」放行**；要更严就再来一轮（源图都在，`--only` 单张重跑即可）。

**图集**：帧集 **40 帧**（10 张英雄技能图 + 30 张肉鸽技能图），交付 **64×64**。
扫描 5 档宽度后定 **`--max-width 256`** —— ⚠ **换交付尺寸后最优宽度会变**
（200 那轮的最优是 704，64 这轮是 256：帧变小时窄画布填充率反而更高）：

| `--max-width` | 画布 | 填充率 | 未压缩 |
|---|---|---|---|
| **256** | **212×532** | **92.2%** | **0.43 MB** |
| 320 | 320×372 | 87.4% | 0.45 MB |
| 384 | 372×320 | 87.4% | 0.45 MB |
| 512 | 480×268 | 80.9% | 0.49 MB |
| 704 | 692×212 | 70.9% | 0.56 MB |

产物 `assets/resources/textures/skills/skills.{plist,png}`（plist 12.1 KB / **png 90.8 KB**）。
裁边砍掉 **36.5%** 像素（64→51 见方）。体检 `check-skills-atlas.py`：**[2]~[5] 四组全绿、40 帧、
几何偏差 0、780 对帧不重叠、观测最小间距 2 px**，其中 **40 帧逐像素与大图对应块 RGBA 全等**。

> ⚠ **显存**：40 张碎图合计 **101 KB**（且只加载用到的几张），图集加载任意一张是
> **0.43 MB**（未压缩）。压到 64 之后这个 trade-off 已经很小（原来是 1.12 MB → 4.00 MB）。
> 想再小只能改分辨率规格或拆图集，**收益已经不大**。

### 7.6 ⚠ `.meta` 会「导入过但已过期」—— 这是本轮新加的一道判据

改交付尺寸（200 → 64）之后重打了图集，结果发现 `skills.plist.meta` **还在**、
且 `importer=sprite-atlas / imported=True / 40 个帧子资源名字齐全** —— 结构完全合法，
**但里面的逐帧裁剪数据是上一次导入留下的旧的**：

```
bloodthirst   width 实际=160 应为=51    rawWidth 实际=200 应为=64
              height 实际=160 应为=51   rawHeight 实际=200 应为=64
```

也就是说：**只看「有没有 `.meta` + 帧名齐不齐」是分辨不出过期的**。
在编辑器重新导入之前，图集帧是按旧数据描述的（槽位里的大小/位置全错），
而退碎图的闸 1 会放行 → 把碎图删了、图集却是错的，就没有退路了。

所以 `check-skills-atlas.py` 的 **[6] 组升级成了判据**：

- `.meta` **不存在** → 信息（还没导入，由 retire 的闸 1 卡）；
- `.meta` **存在但对不上当前 plist** → **违规**（逐帧比 `width`/`height`/`rawWidth`/`rawHeight`/
  `trimX`/`trimY` 六个字段）。

分层就此完整：**闸 1 = 「导入过吗」，闸 2 = 「导入的数据是当前的吗」**。
本轮实测该判据命中了 40 帧不一致、退出码 1 → 退碎图被正确挡住，
**自愈办法就是切回 Cocos Creator 窗口让它重新导入**（资源库检测到 png/plist 变了会重算，
并保留 uuid）。图集本体与帧子资源**没有被任何 prefab/scene/anim/json 按 uuid 引用**
（已全工程扫过），所以重建图集、重新导入都不会弄断任何引用。

---

## 7.7 退碎图（**已执行**）+ 一条差点酿成事故的"保底名单"

**已退**：40 张技能碎图 + 40 个 `.meta`（回收 **219,467 B**），
`assets/resources/textures/skills/` 现在只剩：

```
skills.plist  skills.png          ← 图集本体（+ 两个 .meta）
bullet.png                        ← 代码级回落占位图（SkillSlot / ShopRelicsItem 的 PLACEHOLDER_ICON）
baotou.png  huoqiang.png          ← 被 Scene_Menu.prefab 按 uuid 引用（英雄槽占位图）
```

回滚：`Expand-Archive -Force tools/skill-icon-prompts/backup-skill-icons.zip assets/resources/textures/skills`
（zip 是扁平 basename；图集方案不用改代码，第 ③ 步降级链会自动接管）。

### ⚠⚠ 这一轮踩到的坑：「绝不删」名单里的说明是**没人验过的一句话**

退碎图脚本原本有一张 `NEVER_DELETE` 名单，里面把 `baotou.png` / `huoqiang.png` 描述成
**「既有遗留资源（128×128，无人引用，不在本次范围）」**。这句「无人引用」是**凭印象写的、从来没被验证过** ——
而事实是**两者各被 `Scene_Menu.prefab` 按 uuid 引用 5 次**（`cc.Sprite._spriteFrame`，选人卡的英雄槽占位图）。
于是它们被当成垃圾清理掉，预制件留下 **10 处悬空引用**。

**修法（两道）**：

1. **把说明改成事实** —— 现在写的是「被 Scene_Menu.prefab 按 uuid 引用（英雄槽占位图）」；
2. **加闸 0：保底名单自检** —— 每次运行都现场扫一遍引用数，
   凡是 `why` 里声称「无人引用」却扫出引用的，**直接拒绝执行**（`retire-loose-skill-icons.py` 的 `report_keep_list`）。
   顺带把 `scan_uuid_refs()` 抽出来给「闸 0」和「闸 3」共用 ——
   原来只有"待删的那批"被扫描，"保底的那批"谁都没查，这正是漏掉的半边。

> **教训**：一张安全名单的危险不在于它拦得不够，而在于**它自己没被验证**。
> 「闸 3 查得严、保底名单没人查」这种半覆盖，比没有名单更危险 —— 因为它给人已经安全了的错觉。

`魔棒·去背景.png`（1920×1920 / 610 KB）经扫描**确实零引用**，已随本轮一并清掉；
它的字节保留在 `tools/skill-icon-prompts/backup-legacy-skill-orphans.zip`（6 个条目，665,560 B）。

### 闸 0~4 的完整分层

| 闸 | 查什么 | 为什么必须有 |
|---|---|---|
| **0** | `NEVER_DELETE` 的 `why` 与现场引用数一致 | 名单是"绝不删"的唯一依据，它错了后面全白搭 |
| 1 | 图集是否已被编辑器导入（`.meta` + 40 帧子资源） | 没导入就删碎图 = 图没了、图集也不能用 |
| 2 | `check-skills-atlas.py` 退出码 0（含 [6] 组 `.meta` 是否**对得上当前 plist**） | 「导入过」≠「导入的是当前这份」 |
| 3 | 全工程没有资源还按 uuid 引用待删碎图 | 删了会留悬空引用（就是闸 0 想拦的那种事） |
| 4 | 先写 zip 并逐条核对，**核对通过才删** | 回滚包必须是"能证明完整"的，不是"应该写进去了" |

---

## 8. 命令清单

```powershell
# 1) 生成提示词清单（会与 abilities.json 逐条对账，漂移则退出码 1）
node tools/skill-icon-prompts/gen-prompts.mjs

# 2) 出图（30 张，串行；模型常驻时约 9 s/张）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json `
  --csv docs/skill-icons/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/skill-icons-out --skip-existing `
  --free-every 0 --unload-every 0        # 装得下就别调 /free（调了会把模型逐出显存，每张白付 ~13 s）

# 3) 处理（色键 / 拍平白 / 正方形包围盒）+ 体检 + 装机（复用英雄那套工具，--prompts 指过来即可）
python tools/hero-icon-prompts/make-hero-icons.py --src .tmp/skill-icons-out --dst .tmp/skill-icons-final `
  --prompts docs/skill-icons/prompts.json --sheet .tmp/skill-icons-final/_sheet.png
python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/skill-icons-final
python tools/hero-icon-prompts/install-hero-icons.py --src .tmp/skill-icons-final --apply

# 4) 图集（帧集由 abilities.json 的 icon 列决定，所以必须先做完第 3.5 步）
python tools/skill-icon-prompts/build-skills-atlas.py            # 只算不写，先看尺寸/填充率
#   ⚠ 换过交付尺寸/帧集就重扫一遍宽度（64 这轮最优是 256，200 那轮是 704）
python tools/skill-icon-prompts/build-skills-atlas.py --max-width 256 --apply
python tools/skill-icon-prompts/check-skills-atlas.py            # 体检门禁（违规退出码 1）
#   ⚠ 打完图集要**切回 Cocos 窗口前台**让它重新导入，否则 [6] 组会报「.meta 已过期」
python tools/skill-icon-prompts/retire-loose-skill-icons.py      # 退碎图·预演（缺省不删）
python tools/skill-icon-prompts/retire-loose-skill-icons.py --apply

# 3.5) 把 icon 列写进配表并回灌 xlsx（顺序很重要：图没装之前别填，
#      否则 icon 指向不存在的文件 → 取图为 null → 技能槽是**空白**而不是占位图）
node tools/skill-icon-prompts/set-icon-column.mjs
cd tools/excel_export; node src/cli.ts json2excel --force --table abilities

# 3.6) 技能效果（幂等；两份脚本各管各的那批技能，互不覆盖）
node tools/skill-effects/apply-skill-effects.mjs     # §4.1 的 6 条纯声明式（103/104/105/106/107/130）
node tools/skill-effects/apply-scripted-skills.mjs   # 其余 24 条（新增 28 行 Modifier 40~67）
cd tools/excel_export; node src/cli.ts json2excel --force --table abilities,modifiers

# 3.7) 让文档自己证明"已落地"（落地那两列是现读配表推导的，对不上就退出码 1）
node tools/skill-icon-prompts/set-landed.mjs         # 幂等：写 landed.indirect / landed.note
node tools/skill-icon-prompts/gen-prompts.mjs        # 重生成 docs/skill-icons/*（含落地状态对账）

# 5) 配表闸门（audit:skill 真跑源码验技能真的生效：116 条断言）
cd tools/excel_export; npm run check; npm run verify
npm run audit:attr; npm run audit:slot; npm run audit:hero; npm run audit:skill; npm run check:affix
```

### 8.1 `check-skills-atlas.py` 查什么

**6 组检查**（比遗物那版更严，前两处是这次新加的）：

1. **结构契约** —— 顶层 `frames`+`metadata`；`metadata` 六键（`format` 必须是整数 3、
   `pixelFormat=RGBA8888`、`premultiplyAlpha` 假、`realTextureFileName==textureFileName=="skills.png"`、
   `size` 可解析）；每帧**恰好 5 键**、`textureRotated` 必须是 bool、帧名必须带 `.png`。
2. **帧集 == `abilities.json` 的 icon 列**（规则与 `build-skills-atlas.py` 共用一份实现，
   经 `importlib` 加载，不会两边漂移）；缺帧 / 多帧 / 配表引用了但碎图没落地 = 违规。
3. **逐帧几何对账** —— 用真碎图算 `getbbox()`，核 `spriteSize` / `spriteSourceSize` /
   `spriteOffset=((l+r)/2-W/2, H/2-(t+b)/2)`（**y 向上**）/ `textureRotated==False`，
   报「期望 vs 实际」的数字。⚠ 碎图全退之后这一组会自动降级为「只查 `textureRotated`」，
   不误报。
4. **逐帧像素对账（新增）** —— 碎图裁块与大图 `textureRect` 处的块 **RGBA 全等**。
   防的是「plist 与 png 不同步」（几何全对但大图贴错了帧），而且**碎图一删就再也验不了**，
   所以它必须发生在删除之前。`--no-pixels` 可关。
5. **`textureRect` 自洽** —— 全在 `metadata.size` 内、**宽高 == `spriteSize`**（新增的交叉断言）、
   两两不重叠、间距 ≥ 打包的 `PAD`（2）并打印**观测到的最小间距**。
6. **`.meta` 导入状态** —— 只作信息打印，**不计入判定**（硬闸留给 retire 的第一道闸：
   刚打完图集还没导入时也要能体检）。

### 8.2 `retire-loose-skill-icons.py` 的四道闸

1. **编辑器真的导入过图集** —— `skills.plist.meta` 存在、`importer == "sprite-atlas"`、
   `imported is True`、`userData.format == 3`、且 `subMetas` 里**每一帧都有**对应条目。
   `.meta` 缺失就明确提示「切回 Cocos Creator 窗口 / 按 Assets 面板刷新」并退出码 1。
   **这道闸没有绕过开关** —— 它是「图集真的可用」的唯一证据。
2. `check-skills-atlas.py` 退出码必须是 0。
3. **全工程没有资源还按 uuid 引用待删的碎图**（照遗物那版多加了这一道）。
   实跑命中只有 `View_Game_Stage.prefab→bullet` 与 `Scene_Menu.prefab→baotou,huoqiang` ——
   **全在「绝不删」名单里**，所以这道闸现在是绿的（也侧面印证那三张不能删）。
4. **先备份再删** —— zip 落 `tools/skill-icon-prompts/backup-skill-icons.zip`，
   核对条目数 + `testzip()` 无损才动手；zip 条目是**扁平 basename**，所以回滚是一条命令：
   `Expand-Archive -Force tools/skill-icon-prompts/backup-skill-icons.zip assets/resources/textures/skills`

**绝不删的四张**（用**精确文件名**白名单保护，不用前缀匹配 —— `huoqiang` 是
`huoqiang_skill` 的前缀，前缀匹配会误伤）：
`bullet.png`（`PLACEHOLDER_ICON`）、`baotou.png`、`huoqiang.png`、`魔棒·去背景.png`。
只删「**是图集里的一帧** 且 **`abilities.json` 的 icon 列引用了它**」的交集。

---

## 9. 顺手纠正的三处文档不一致

1. **`AGENTS.md` 说「`modifiers.cd` 每个实例各持一个计时器」** —— 计时器确实在跑，
   但**没有任何东西会触发它**（§2.5，`Trigger()` 零调用方）。这句要补上「目前是死代码」。
2. **`ScriptedModifiers.ts` 的注释说「事件是广播给双方实体的：命中者与被命中者都会收到」** ——
   `on_attack_landed` **只派发给攻击者**（`Entity.ts:379` 只调 `this.modifiers.DispatchEvent`），
   受击者收到的是 `on_take_damage`。原脚本里那句 `event.attacker === host` 的判断是**对的、也是必要的**，
   但**理由不是**注释里写的那样。
3. **`AGENTS.md` 说「30 个肉鸽技能只有文案没有效果」** —— 这条**是对的**，
   本文档把它量化到了「哪一条为什么落不了地、要动哪里」。

---

## 10. 诚实边界（**2026-10 收尾后重写**）

**已落地（全部）**

- 审查结论（30 条逐条判定，见 `skills.md`）；
- **30 条技能全部有战斗效果**：6 条纯声明式 + 17 条脚本 + 6 条声明式/脚本混装 + 1 条补了引擎派发。
  `npm run check` 的「没效果的商店技能」告警 **30 → 0**；
- **两个真 bug 已修**（§11.1 / §11.2），**一处引擎派发 + 一个总线事件新增**（§11.5）；
- 40 张技能图标**已出图、已压到 64×64、已装机、已进图集**；
- **碎图已退**（§7.7）：40 张 png + 40 个 `.meta` 已删除（回收 219 KB），
  目录里只剩 `skills.plist` + `skills.png` + 3 张有引用/占位用途的遗留图；
- `abilities.json` 的 `icon` 列 **13 → 43 条**，并已回灌 `abilities.xlsx`（11 张表往返无损）；
- 技能图集 `skills.plist` + `skills.png`（40 帧、212×532、90.8 KB）；
- 取图降级链抽成共享实现 `AtlasIcon.ts`，三个消费方已接线。

**未做 / 有意的取舍**

- **召唤流仍然是产品级缺口**（§4.4 的注）：123 / 124 / 125 现在跑的是**零基建的等价机制**，
  不是实体召唤物。要真做召唤物得单独立项（`units.json` 加行 → `MonsterPool` 加 team=1 的
  表现分支 → AI + 生命周期 + 与英雄绑定），届时**只改 `effects`，图集帧名与名字都不用动**。
- 17 行死技能（`scope='unit'` 但全表零引用，§6.3）**仍然只标出来，没删**。
- **127 的「每波一次」类设计改成了自计时冷却**：本作**没有波次事件**
  （`BattleEvents` 里没有任何 wave 相关的键，关卡推进在场景层），所以 129 的
  「每波 1 次」写成了「每 45 秒最多 1 次」，文案同步改了。这是**缩水**，不是等价替换。
- **111 淘金的「金币加成 +8%/+16%」「波次利息 +5%」被砍掉**：属性表里没有「金币获取」，
  改成了更大的固定额（+2/+3）。
- **DoT 数值在施加那一刻按当时的攻击力定格**：之后英雄攻击力涨了，已经在燃烧的目标
  不会追溯加强。这是刻意选择（同一层数在不同时刻打出不同数字更难解释），但和
  「DoT 跟着攻击力实时成长」是两种设计，选的是前者。
- **10 张图标形变仍在 1.16~1.28**（§7.5），按「真实槽位读得清 + 与已装机 10 张风格一致」放行。
- 130 的「技能冷却 -25%」、104 的「攻速≥2.5 必暴击」等**条件式半句已明确删掉**（不是省略），
  逐条记在 `skills.md` 的「落地机制」列里。

**两个数字上的实话**

- 图集换来的是**构建期确定性**，不是省显存：图集是 0.43 MB（未压缩）且**加载任意一张就把整张拉进显存**。
  压到 64 之后这个差距已经很小，但仍然不是"省"。
- **题图不同源**：30 张新图与 10 张英雄技能图**笔法略有差异**（新图细节更密），
  在真实槽位尺寸下看不出，但放大会。

---

## 11. 本轮修掉的代码缺陷 + 落地的技能

### 11.1 `AbilitySystem.RemoveAbility` 不摘被动 Modifier（**漏属性**）

```ts
// 旧：只 filter 掉技能对象，被动挂上去的 Modifier 留在实体上
RemoveAbility(id: number): void {
    this.abilities = this.abilities.filter((a) => a.getId() !== id);
}
```

`Ability.removeOwnModifiers()` 原本是 **private**、只被 `setLevel` 调用；
而 `SkillSlots.grant` 顶掉旧技能时走的正是 `RemoveAbility(replacedId)`
→ **肉鸽技能被替换后，它给的属性加成永久留在英雄身上**（抽「迅捷 +25% 攻速」再换掉，攻速一直白给）。
30 条肉鸽技能全是 `passive` + `modify_attr`，所以这条对它们是致命的；
英雄自带技能因为槽 0 永久锁定、不可替换，所以一直没暴露。

**修法**：`removeOwnModifiers()` 改成 **public**，`RemoveAbility` 与 `Clear()`
在丢弃技能对象前先调它（按 `origin === 'ability:<id>'` 过滤，与 `setLevel` 换级重挂同一条路径）。
`Clear()` 的两个调用点（`Entity.Reinit` / `ResetForPool`）恰好都在之前先 `modifiers.Clear()`，
所以它原本不漏属性 —— 但那是**巧合不是保证**，现在显式摘掉，让 `Clear()` 自洽。

### 11.2 最大生命**下降**时当前生命不钳（`hp > maxHp` 脏数据）

`Entity.ApplyWithMaxHpCarry` 原先只处理上限**上涨**（满血带血），下降那一支是空的。
而「恶魔契约 +100% 攻击力 / **-40% 最大生命**」正是下降 ——
实测满血买完三级是 **`hp 320 / maxHp 192`**（HUD 会显示成"超过上限"，要等下一次 `ChangeHp` 才被钳回）。

**修法**（三处，缺一不可）：

1. 新增 `Entity.ClampHpToMax()`；
2. `ApplyWithMaxHpCarry` 加上限下降分支 → 调它；
3. **`EffectExecutor` 的 `modify_attr` 在 `duration < 0`（永久）时改走 `ApplyWithMaxHpCarry`** ——
   与遗物（`BattleEquip.Apply`）、击杀商店 Buff（`BuffShop.applyStack`）**统一成同一条路**。
   在此之前技能改属性是**绕过**那个包裹器的，所以「遗物有满血口径、技能没有」。
4. `Ability.removeOwnModifiers()` 收尾也调一次 —— 例：挂着「强健 +22% 生命」满血，
   换成「迅捷」后上限回落，不钳就会 1.22B / B。

> **仍然存在的缺口（既有的，本轮没动）**：**临时**上限到期时的回落没接钩子
> （Modifier 自然结束 → 上限掉回来而当前生命不回落）。要修得在 `ModifierSystem` 里拿到
> "上限变了"的时机，属独立改动。`ApplyWithMaxHpCarry` 的文档注释里已把这条写清楚。

### 11.3 落地的 6 条技能（`tools/skill-effects/apply-skill-effects.mjs`，幂等）

| id | 技能 | 落地写法 |
|---|---|---|
| 103 | 嗜血 | `apply_modifier` 34/35/36（**新增 3 条 Modifier**，`events[on_attack_landed] → lifesteal 0.05/0.09/0.14`） |
| 104 | 迅捷 | `modify_attr [4 攻速, +8/+15/+35, add]` |
| 105 | 鹰眼 | `modify_attr [16 攻击范围, +12/+20/+45, percent]` |
| 106 | 强健 | `modify_attr [1 最大生命, +12/+22/+35, percent]`；三阶追加 `[9, +2, add]` |
| 107 | 暴击机芯 | `modify_attr [14 暴击率, +8/+15/+24, add]`；三阶追加 `[15, 170, best]` |
| 130 | 恶魔契约 | `modify_attr [3 攻击力, +40/+60/+100, percent]` + `[1 最大生命, -15/-25/-40, percent]` |

**为什么只有 103 需要新增 Modifier**：`lifesteal` 的 `ratio` 是**动作字段**，
而变量绑定（`var` / `attrs_var`）**只对 `modify_attr` 的属性条目生效**（`EffectTypes.ts`）——
所以「同一套效果、三种幅度」在属性型技能上完全可以靠 `effects_lv2/lv3` 换个数值解决
（全走共享模板 1000），只有吸血比例这种**非属性参数**才必须一档一条 Modifier。

文案也按引擎口径改掉了做不到的半句（删了，不是省略）：
l3 的「过量转护盾」（本作没有护盾池）/「攻速≥2.5 必暴击」「射程内无敌人时 +10%」（条件式）/
「每秒 1% 最大生命」（`tick_heal` 是定值 → 改成固定 +2/秒）/「技能冷却 -25%」（没有该属性）。

### 11.4 新增体检 `npm run audit:skill`（= `tools/skill-audit/verify-skills.mjs`，**45 → 116 条断言**）

对齐 `audit:attr` / `audit:slot` / `audit:hero` 的「真跑源码」套路：`transpileModule` 编真源码、
只桩 `cc`/容器，用**真配表**建英雄 → 挂技能 → 读属性 / 数 Modifier / 真打一下：

| 组 | 覆盖 |
|---|---|
| A | 换技能不漏属性（**11.1 的回归测试**，含 `Clear()`） |
| B | 五条纯声明式技能的 1/2/3 级属性逐级对账 |
| C | 暴击倍率走 `best` 而不是累加 |
| D | 负向最大生命 + **11.2 的回归测试** |
| E | 嗜血升级摘旧挂新 |
| F | 嗜血**真普攻命中**后回复量 == 最终伤害 × 比例 |
| G | 30 条技能的 `icon` 真的在**图集**里（碎图退掉后判据改成查帧名） |
| H | 30 条全部有 `effects`/`script_id`；`apply_modifier` 指向的 Modifier 都存在；`script_id` ↔ 注册表**双向**对账；脚本型被动的 `duration` 必须是 -1 |
| I | **原因①** 按攻击力算伤害：倍率随 atk 变、段数对、锥角/半径边界对、链式衰减曲线对 |
| J | **原因②** 条件判断：满血 / 残血血线 / 满 5 层引爆 / 满 3 层冻结 |
| K | **原因③** 写 `on_block_damage.blocked`：护盾池吸收、破池、充能；概率格挡两种分支 |
| L | **原因④** 总线事件：击杀加金（含 `on_gold_gained`）、击杀回响、**拦住死亡**、军阵攒层倾泻、**订阅被 `off` 干净** |
| M | **引擎钩子**：闪避 → `on_evade` → 反击真的打回去 |
| N | 层数上限随档位、DoT **随层数放大**（脚本相对 `tick_damage` 的改进点）、换级后 kv 是当前档 |
| P | 周期性行为（开火 / 光环破甲）自己计时，不依赖死代码 `modifiers.cd` |

⚠ 这个脚本**当场抓出了 11.2**（D 组一条断言红：`hp 320 / maxHp 192`）——
这正是加它的意义：`npm run check` 与 `verify` 都只验配表**格式**，验不出「配表对了但运行时是脏数据」。

本次扩到 116 条时又抓到 **1 条我自己的实现偏差**（不是配表错）：119 雷链的伤害曲线
写成了「每跳都先乘一次 decay」，使**首跳只有 50% 攻击力**、与文案的「首跳 100%」对不上（§11.5）。

---

### 11.5 其余 24 条技能落地（`tools/skill-effects/apply-scripted-skills.mjs`）

**落表结果**

| | 变化 |
|---|---|
| `modifiers.json` | 32 → **60 行**（新增 28 行，id **40~67**） |
| `abilities.json` | 24 条技能的 `effects` / `effects_lv2` / `effects_lv3` / `lv1~lv3` 全部改写 |
| 商店技能「已有战斗效果」 | 6/30 → **30/30**；`npm run check` 的对应告警 **30 → 0** |
| 落地形态 | 纯声明式 **7** · 脚本 **17** · 声明式+脚本 **6** |

**28 行 Modifier 的分工**（这是本轮的配表设计要点）

- **23 行 `script_id` 型**：被动挂的常驻效果，一律 `duration: -1` + `stack_mode: refresh`
  —— 它们是"技能挂着的状态"而不是限时 Buff，写成秒数会过一会就没了；
- **3 行纯声明式模板**：`53 技能·冰冻`（`modify_attr` 条目带 `var`，幅度由施加方 kv 传）、
  `56 技能·静电层数`（**纯计数器**，没有 `effects`，只承载 `stack_mode: stack` 的层数）、
  `66 技能·破甲`（护甲 base=0 → 必须 `add`）；
- **2 行敌人侧 DoT**：`50 技能·灼烧` / `52 技能·毒液`，`duration: 4`（**故意限时**）+ `max_stack: 6`。

**为什么层数上限要"def 取最高档、脚本钳低档"**：`max_stack` 是 **def 的字段，不能由 kv 传**，
所以 116（2/4/6 层）与 117（1/2/3 层）的 def 取最高档，低档由脚本判断"到量就只续时、不再叠"。

**新增的两处引擎改动（都很小，但都是"没有它就做不了"）**

1. `Entity.resolveAttackHit` 的**闪避分支**补 `on_evade` 派发（§4.3）；
2. `BattleEvents` 新增 **`on_gold_gained`**：脚本改 `hero.gold` 后必须发它，
   否则 HUD 的金币要等到下一次受伤/治疗才跳（`hero.gold` 的既有写入方
   `grantKillReward` 是自己顺手调的 `syncHeroToStore()`，技能侧没有这个便利）。

**落地时发现并修掉的 3 个实现口径问题**（都不是配表错、都是"写下去才发现"）

1. **119 雷链首跳伤害写错**（上面 §11.4 末尾那条）：`chain` 回调带 index 后改成
   `if (i > 1) dmg *= decay` —— **首跳 100%、之后每跳衰减**。119 与 114 的区分度也就落在这里
   （114 = 定值 55% 每跳、跳数少；119 = 首跳满额但衰减狠、跳数多）。
2. **109 首击不能挂 `on_attack_landed`**：「目标满血？」必须在**扣血之前**判定，
   而 landed 是在 `ApplyDamage` **之后**派发的（`Entity.resolveAttackHit:395-399`）→
   在那里读 `hp / getMaxHp()` **永远为假**。正确分工：`on_attack_start` 记标记（按 uid）、
   landed 消费（按 uid 存也顺手解决了对象池复用后认错实体的问题）。
3. **`percent` 打在 base=0 上的老问题又出现两次**：108 的护甲（必须 `add`）与
   128 的破甲（必须 `add`）。而 110 的「伤害输出倍率」（attr 11 base=100）与
   128 的自身增伤用 `percent` 才对 —— **同一个词条里两种写法并存，是属性 base 决定的**，
   不是风格选择。

**写这 25 个类时踩到的三组"测试才算得出来"的陷阱**（都已变成断言里写明的注意事项）

- **`Entity.ChangeHp` 会把 hp 钳在 `maxHp`**：用 `raw=400` 打一个满血 320 的英雄量"格挡减半"，
  量出来是 320 而不是 400 —— **测试伤害不能超过目标当前生命**；
- **`DamagePipeline` 对每一次伤害都会 roll 暴击**（不是只有普攻）→ 任何精确断言都必须先把
  攻击者的暴击率清零，否则伤害随机翻 1.5 倍；
- **不要在断言里假设"属性的 base 就是 `attributes.json` 的默认值"**：怪物行会覆盖它，
  而属性 5（移速）有 `min: 50` 的下限 —— 实测某只怪 base=100，减 120 被钳成 50，
  于是「每层 -60」的断言**两层和一层都是 50、假通过**。所以测试木桩要显式钉住它依赖的属性。
