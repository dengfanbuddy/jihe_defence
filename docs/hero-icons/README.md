# 英雄头像 / 技能图标（白描徽记）· 10 个 Dota2 代表英雄

10 个英雄的头像与技能图标的**设计稿 + 出图规范 + 工具链**。设计源在
`tools/hero-icon-prompts/heroes.json`，本目录多数文件是它的产物。

- **设计稿（先看这个）**：`heroes.md` —— 英雄身份、配表数值、技能（含 Modifier 与落地成本）
- **出图清单**：`prompts.md`（人看）/ `prompts.csv`（投给 ComfyUI）/ `prompts.json`（机读）
- **机读副本**：`heroes.json`

---

## 1. 十个英雄是谁

现役 4 个（`units.json` team=1）+ 新增 6 个，**伤害只有物理 / 法术**（本作没有元素体系，
`element_effects.json` 已于 2026-07 删除，设计库里那套火/冰/毒/雷/暗在本作不存在）。

| id | 英雄 | Dota2 原型 | 伤害 | 流派 | 状态 |
|---|---|---|---|---|---|
| 1001 | 火枪 | Sniper | 物理 | 超远点杀 | 现役 |
| 1002 | 赏金猎人 | Bounty Hunter | 物理 | 经济成长 | 现役 |
| 1003 | 宙斯 | Zeus | 法术 | 连锁爆发 | 现役 |
| 1004 | 斧王 | Axe | 物理 | 近战坦克反伤 | 现役 |
| 1005 | 幻影刺客 | Phantom Assassin | 物理 | 暴击爆发 | 新增 |
| 1006 | 卓尔游侠 | Drow Ranger | 物理 | 远程攻速点杀 | 新增 |
| 1007 | 水晶室女 | Crystal Maiden | 法术 | 控场冻结 | 新增 |
| 1008 | 莉娜 | Lina | 法术 | 单体贯穿爆发 | 新增 |
| 1009 | 冥界亚龙 | Viper | 法术 | 持续剧毒 | 新增 |
| 1010 | 谜团 | Enigma | 法术 | 暗影溅射 | 新增 |

5 物理 / 5 法术，10 个互不重复的玩法定位。设计细节与全部数值见 `heroes.md`。

## 2. 风格口径：为什么图里**一点颜色都不该有**

这不是审美选择，是**扒现有素材量出来的**：

| 素材 | 尺寸 | 不透明像素的颜色构成 |
|---|---|---|
| `textures/heros/huoqiang.png` | 256×256 | `#F6F6F6` 66.2%，其余是它的抗锯齿邻色（`#F5F5F5`/`#F7F7F7`…），**第二颜色为零** |
| `textures/heros/shangjin / zhousi / fuwang.png` | 256×256 | 同上，几乎 100% 是同一个近白色 |
| `textures/skills/bullet.png` | 200×200 | **`#FFFFFF` 100%** |

底色不在图里，**在预制件里**（`View_Game_Stage.prefab`，逐字段读出来的）：

| 槽位 | 显示尺寸 | 底色（Sprite `_color`） |
|---|---|---|
| 选人卡头像 `hero_select_panel/pannel/items/item*/content/head` | 50×50 | **`#A85A5A`** 暗红（`c-identity` 英雄身份色） |
| 选人卡技能图 `…/content/skills` 与 `skills-001` | 20×20 | **`#70ACB3`** 青绿（`c-accent-400`） |
| HUD 头像 `head` | 50×50 | 同上暗红 |
| HUD 技能槽 `skills/skill*/icon` | 50×50 | 槽底 `#70ACB3` |

所以交付图的正确形态是：**纯白 `#F6F6F6` 单色 + 真透明 alpha**，形状靠
「实心白色块 + 内部细节挖空」表达（也就是 stencil / 剪纸的做法）。**图里多一个像素的第二颜色就是错**。

> 这条与遗物图标那套（中明度彩色主体 + 深描边）**口径不同、不要混用**：遗物画在白色九宫格上靠品质染色，
> 主体必须自己有明度结构；英雄头像/技能图标画在**暗红/青绿实底**上，主体必须是纯白剪影。

### 2.1 为什么包围盒必须是正方形（工程正确性，不是美观）

`item/content/head/inner` 与 `skills/inner` 都是 `_sizeMode=0`（**CUSTOM**）+ `_isTrimmedMode=true`：

- 导入器按 **alpha 包围盒**算 trim（写进 `.meta` 的 `trimX/trimY/width/height/offsetX/offsetY`）
- Sprite 又把 **trim 后的矩形铺满** CUSTOM 尺寸（50×50 / 20×20）

→ **包围盒不是正方形，画面就被拉伸**。现有素材就是这么处理的：`bullet.png` 的包围盒正好
**164×164**，`huoqiang.png` 是 201×203（1% 以内）。

⚠ **一个反直觉的坑（第一版栽在这）**：把「裁剪窗口」补成正方形**并不会**让「内容包围盒」变正方形 ——
包围盒由不透明像素的范围定义，四周补透明像素根本改不了它。实测 `hero_huoqiang` 源包围盒 424×364，
补成 424×424 窗口后交付图量出来**还是 205×177**。唯一有效的做法是**把内容按 x/y 独立缩放成正方形**。
而且这件事**在屏幕上的结果与让引擎拉伸完全一致**（同样的形变量），
区别只是资产从此自洽、WYSIWYG。所以 `make-hero-icons.py` 会打印 `形变=1.02×` 这个数：
**> 1.15 就说明模型构图太扁/太瘦，该去改提示词，而不是接受形变。**

### 2.2 交付尺寸

| 类型 | 交付 | 画布占位 | 与现有素材的关系 |
|---|---|---|---|
| 英雄头像 | **256×256** | 80%（包围盒 205×205，四周留白 10%） | 与现有 4 张头像同尺寸 |
| 技能图标 | **200×200** | 80%（包围盒 160×160） | 与 `bullet.png` 同尺寸 |

---

## 3. 工具链

三个脚本，都在 `tools/hero-icon-prompts/`：

| 脚本 | 干什么 |
|---|---|
| `gen-prompts.mjs` | 设计源 → `heroes.md` / `heroes.json` / `prompts.{json,csv,md}`（**改设计只改 `heroes.json`**） |
| `make-hero-icons.py` | ComfyUI 原图 → 色键抠底 → **全部拍平成 `#F6F6F6`** → 缩成正方形包围盒 → 交付尺寸；`--sheet` 出真实槽位对照图 |
| `check-hero-icons.py` | 交付体检：单色 / 真 alpha / 正方形 / 包围盒正方形 / 留白 / 半透明占比（违规退出码 1） |

出图复用遗物那套投递器 `tools/relic-icon-prompts/comfyui_batch.py`（它只改工作流里一个节点的提示词字段，与题材无关）。

### 3.1 完整流程（重跑一遍就照这个顺序）

```powershell
# 0) ComfyUI 开着，工作流是 Qwen-Image-2.1 T2I（节点 7 = PrimitiveStringMultiline 吃提示词）
#    先确认模型在显存里常驻（见 docs/relic-icon/README.md §5 的「模型常驻」口径）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_t2i_w4a8.json --csv docs/hero-icons/prompts.csv `
  --prompt-node 7 --route t2i --out .tmp/hero-icons-out `
  --free-every 0 --unload-every 0

# 1) 后处理（色键 → 拍平白 → 正方形包围盒 → 256/200）
python tools/hero-icon-prompts/make-hero-icons.py `
  --src .tmp/hero-icons-out --dst .tmp/hero-icons-final `
  --sheet .tmp/hero-icons-final/_sheet.png

# 2) 体检（必须全绿）
python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/hero-icons-final

# 3) 装机（装完再查一次真实资源）
python tools/hero-icon-prompts/install-hero-icons.py --apply
python tools/hero-icon-prompts/check-hero-icons.py --installed
```

`--only huoqiang,huanci` 可以只跑指定英雄（先导用）。

### 3.2 实测数据（2026-10）

- **出图**：20 张全部一次成功，0 失败。第 1 张 23~33s（模型加载），之后稳定 **9 s/张**；
  全程 `--free-every 0 --unload-every 0`，跑完 `nvidia-smi` 显存仍占 13.7GB —— **模型真常驻**
  （与遗物那轮的结论一致：装得下就别调 `/free`，调了每张白付 13s 重加载）。
- **色键**：提示词要的是 `#445054`，模型实际画出 `(58,66,81)`~`(62,68,80)` —— 都在同一族但**不等于**请求值。
  所以 `make-hero-icons.py` **不写死色值**，而是**从四边采样实际底色**再做色键（中位数，少量反锯齿白边带不偏）。
- **拍平**：`LANCZOS` 有负瓣，在硬边上会**过冲**，预乘图里 246 会被冲到 >246 并 clip 成 `#FFFFFF` ——
  第一版实测 **28% 的不透明像素变成了纯白**（体检的「单色」那条会红）。
  所以最后**无条件把 RGB 写死**；既然风格就是「一个纯色块」，就让 alpha 独自承载形状。

---

## 4. 判断风格必须看真实槽位尺寸

200×200 大图看着都没问题，**缩到 50×50（头像）与 20×20（选人卡技能图）才看得出糊不糊、剪影认不认得出**。
`make-hero-icons.py --sheet` 生成的四列对照图就是干这个的（底色取自预制件实测值）：

| 列 | 内容 | 含义 |
|---|---|---|
| 1 | 头像 @50×50 on `#A85A5A` | 真实头像槽（选人卡 / HUD） |
| 2 | 头像 @50×50 on 白 | 对照：白底上几乎看不见（这正是「图里不该有颜色」的证明） |
| 3 | 技能图 @50×50 on `#70ACB3` | 真实 HUD 技能槽 |
| 4 | 技能图 @20×20 on `#70ACB3` | 真实选人卡技能图（**全工程最小的显示处**） |

### 4.1 提示词迭代记录（两次都是看了图之后才改对的）

| 版本 | 结果 | 原因与修法 |
|---|---|---|
| v1 | 人物被压成**一坨抽象色块**（幻影刺客那张读起来像一朵花/皇冠，完全不像人） | 画法段写了「a few bold chunky masses」（几个粗大块）+「只靠两三个大块承载身份」。**这是过度简化** —— 对比 `huoqiang.png` 会发现现有素材内部细节相当丰富（帽檐、护目镜、胡子、手指全用负空间抠出来）。改成「**细节丰富，但只由实心白 + 挖空两种手段构成**」，并明确禁止"简化成 logo / 模糊一团" |
| v1 | 构图太扁：`hero_huoqiang` 源包围盒 424×364 → **形变 1.17×** | 加了「剪影要接近正方形」段。这不是新发明 —— 现有 4 张头像背后的菱形/盾形/尖角底衬**本来就是用来把剪影撑成方块的** |
| v2 | 头像能认出是人了（火枪＝戴羽帽的射手，幻影刺客＝兜帽+眼罩+双刀），形变降到 1.00~1.02× | 新增的「头部要占画面主体、正面或清晰四分之三、明确像一颗头（眉/眼/下颌）」一句是关键：**不写这句模型就只画一个兜帽轮廓** |

提示词长度：头像 575~661 词、技能图 490~516 词（Qwen T2I 官方建议 400~500）。
超出官方甜区的那几张**实测结果反而更好**（细节更多）—— 因为本风格的细节量本来就靠文字堆出来。

---

## 5. 配表已落地（2026-10）

10 个英雄**已经落表**，改动面如下（`npm run check` / `npm run verify` 全绿，`verify` 报**往返无损**）：

| 表 | 改动 |
|---|---|
| `units.json` | 12 → **18 行**：新增英雄 1005~1010（插在 1004 之后、怪物段之前） |
| `abilities.json` | 52 → **58 行**：新增单位技能 23~28；**补上了 `icon` 列**（这是一个 schema 里声明了、但 JSON 里从来没写过的键） |
| `modifiers.json` | 22 → **29 行**：新增 27~33 |

`icon` 一共填了 **13 条**：10 个英雄各自那一个技能（7/16/17/19/23~28）+ 宙斯整条升阶链（19/20/21/22 共用同一张图）。
其余 45 条（含 30 个肉鸽技能）留空 —— 它们还没有美术，`SkillSlot`/`HeroItem` 会回落 `textures/skills/bullet` 占位图。

### 5.1 两条改表时踩到的真口径

**① `units.prefab` 是死数据，所以新英雄这一列故意留空。**
全工程搜 `def.prefab` 只命中 `MonsterPool.ts` 里一行**被注释掉**的代码：怪物走硬编码占位件
（`MONSTER_PREFAB = 'prefabs/unit/monsters/one'`），英雄走场景里那个**预置的** `heroNode`
（`Scene_Game_Stage.selectHero` 里是 `this.heroNode.getComponent(Hero)`，不 new 任何预制件）。
现有 4 个英雄填的 `prefabs/units/hero_sniper` 等**文件根本不存在** —— 与其再添 6 条悬空引用，不如留空。

**② `tick_damage` **不随层数放大**，只有 `modify_attr` 会。**
`ModifierSystem.processTickEffect` 用的是 `eff.value` **原值**；而 `Modifier.resolveAttr` 里是
`value × stackCount`。所以「可叠 5 层的毒」**DoT 不会随层数涨**。
冥界亚龙因此改成 **「层数放大减速（每层 -30 移速）+ DoT 恒为 8/s」**：
既保住「越打越黏」的手感（减速把怪留在射程里），又不依赖一个不存在的机制。
想让 DoT 本身也随层数涨，要改的是 `processTickEffect` 里那一行（乘 `m.getStackCount()`）。
这条已被 `audit:hero` 的 G6/G7 钉成断言，防止将来被误当成 bug 改掉。

### 5.2 改表流程（改这些表就照这个顺序）

```powershell
# 1) 改 JSON（本次用 .tmp/apply-hero-config.mjs，幂等：同 id 先删再插；键顺序按 schema 重排）
# 2) ⚠ 回灌 xlsx —— 只改 JSON 是无效改动，下一次 npm run export 会按 xlsx 覆盖回来
cd tools/excel_export
node src/cli.ts json2excel --force --table units,abilities,modifiers
# 3) 一致性 + 往返无损
npm run check ; npm run verify
# 4) 三道相关体检
npm run audit:hero     # 39 条：10 英雄的普攻+被动端到端真跑（本目录新增的工具）
npm run audit:slot     # 53 条：技能槽规则（会打印「英雄 10 个」逐个对技能 id）
npm run audit:attr     # 遗物属性链路（本次未涉及，确认无回归）
npm run check:affix    # 品质门禁（本次 0 错误，78 条警告全是既有遗物问题）
```

### 5.3 `audit:hero` = `tools/hero-audit/verify-heroes.mjs`（新增体检）

对齐 `attr-audit` / `skill-slot-audit` 的「真跑源码」套路：把真源码 `transpileModule` 成 CJS、
只桩 `cc`/容器，用**真配表**建实体 → 真普攻命中 → 看伤害 / 属性 / 受害者身上的 Modifier / 层数 / 状态。
**39 条断言**，覆盖：

- **A 装配**（10 英雄）：恰好 1 个技能 / `scope=unit`+`passive`+`max_level=1` / 挂被动零警告 / 技能引用的 Modifier 都存在
- **B 配表 ↔ 资产交叉验证**：每个 `head_icon` 与技能 `icon` 指向的 png **真的在磁盘上**
- **C~H 逐个英雄的差量**：幻影刺客 0.25 暴击率 + 2.4× 倍率（`best` 生效）；卓尔游侠 +6 攻击力且 kv 覆盖真的改了受害者移速；
  水晶室女魔抗 0.25→0.45、回蓝 3、`random=0` 冰封 / `0.99` 不冰封；莉娜输出倍率 1.2、命中附伤 == 直接打 30 法术；
  冥界亚龙叠层让减速 -30→-60 而 DoT 恒定；谜团溅射打到邻居且伤害 == 直接打 28 法术。

**它当场抓出的两个「不是配表错、而是我的期望错」**（值得记）：属性 `.get()` **读出单位不统一** ——
魔抗/伤害输出倍率给的是**比例**（0.45 / 1.2），而魔法恢复给的是**原值**（3）；
另外莉娜那条用「有技能 vs 无技能」量附伤是**混淆的**（技能自带的 +20% 输出会把普攻本身也抬高，实测差 34.8 而非 28.8），
必须另起一个把 `events` 摘掉的 ctx 做隔离对照 —— 于是给 `makeCtx` 加了 `stripEventsFrom` 参数。

### 5.4 还需要写代码吗

**不需要。** 10 个技能全部由现有声明式词汇表达（`modify_attr` / `apply_modifier` / `damage` / `aoe_damage`
+ `modifiers.events`）。但有三条**引擎事实**必须先知道，否则下一个技能很容易设计成做不到的东西：

**① 英雄技能必须是被动。** `AbilitySystem.AddAbility` 对 `behavior='passive'` 会立即 `ApplyPassive()`，
但**英雄侧没有任何主动施放入口** —— `castAbility` 全工程唯一调用方是 `ai/BossAI.tryCastSkill`。
想让技能按 CD 自动放，要在英雄 tick 里对 `hero.abilities.getCastableSkills()` 逐个尝试 `Ability.Cast`
（冷却/蓝耗判定都已实现）。

**② `on_take_damage` 的动作目标是宿主自己。** `Modifier.runAction` 是 `target = event?.target ?? host`，
而 `on_take_damage` 的 `event.target` **就是宿主**（攻击者在 `event.source`）。所以：
- `aoe_damage` 会以**自己**为圆心 ✓（斧王式反击可以这么写）
- 但 `apply_modifier` 会**施加到自己身上**，而且**够不到 `event.source`**
  → **「受击时冻住打我的人」声明式做不到**。水晶室女原本想这么设计，因此改成「普攻命中触发」。

**③ `on_attack_landed` 的动作目标是「被打的那个敌人」** ✓ —— 可以对它造成伤害 / 施加减速 / 上毒，
这也是本次 5 个新技能（卓尔游侠/水晶室女/莉娜/冥界亚龙/谜团）全都挂在 `on_attack_landed` 上的原因。

**两条「想要更强就得动代码」的升级路径**（写在 `heroes.md` 里）：

1. **英雄主动技能**：见上面 ①。
2. **谜团真聚怪**：声明式词汇里没有位移动作，要做「把怪吸成一堆」得加一个 `script_id` 逃逸口
   （参照 `Entity.ApplyKnockback` 的反向）。当前落表的是**溅射版**。

### 5.5 本轮**没**动的既有问题

- `units.json` 1002 赏金猎人攻击力 **200**（其余英雄 24~44，设计稿写 12）—— 疑似笔误，**未改**。
- 现有 4 个英雄的 `prefab` 悬空引用**未清理**（见 5.1）。
- 30 个肉鸽技能仍是「只有文案、没有 effects」（`npm run check` 的既有警告）。


---

## 6. 文件结构

```
tools/hero-icon-prompts/
├── heroes.json              ★ 唯一作者数据：10 英雄的设计 + 中英文美术描述
├── gen-prompts.mjs          设计源 → 下面 docs/ 的产物（风格段在这里，改风格只改这里）
├── make-hero-icons.py       原图 → 交付图（色键 / 拍平白 / 正方形包围盒 / 对照图）
├── check-hero-icons.py      交付体检
└── install-hero-icons.py    装机（自带备份 + 三道闸）

docs/hero-icons/
├── README.md                本文件
├── heroes.md                ★ 设计稿（人看）
├── heroes.json              设计稿（机读）
├── prompts.md / .csv / .json  出图清单
└── （可选）preview/          真实槽位对照图
```

## 7. 未决 / 已知问题

- **现役 4 张头像会被换掉**：本轮把 1001~1004 的头像也按同一风格重出了（否则 10 个英雄新旧风格并存）。
  装机脚本会把原图备份进 `tools/hero-icon-prompts/backup-hero-portraits.zip`，不满意可回滚。
  代价要说清：**新图比原图简洁**（原图内部刻线更密），整队内部一致但与原图不是同一笔法。
- **`units.json` 1002 赏金猎人的攻击力是 200**，而其余英雄是 24~44（设计稿写的是 12）——
  量级差 5~8 倍，疑似配表笔误。**落地前请确认**，我没动它。
- **`units.json` 的 `prefab` 列指向不存在的文件**（`prefabs/units/hero_sniper` 等，
  全工程搜不到，`assets/resources/prefabs/unit/` 下只有 `monsters/one.prefab` 与
  `projectiles/projectile_1.prefab`）。现役就如此，本轮未涉及，但落地新英雄时绕不开。
- **选人卡的第二个技能位**（`skills-001`）本轮空着 —— 用户口径是每英雄 1 张技能图。
  若将来给英雄加第二个技能，那个槽已经就位（`HeroItem.setHeroInfo` 取 `abilities` 前两个）。
- **`textures/skills/` 里的老图**：`huoqiang.png` / `baotou.png` 是 128×128 的青绿准星风格（不是本套白描），
  `魔棒·去背景.png` 是 1920×1920 的素材（624KB）。所以本次技能图命名带 `_skill` 后缀**避免覆盖**它们。
  这几张要不要清掉另说。
