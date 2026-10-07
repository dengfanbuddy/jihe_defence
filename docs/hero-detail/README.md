# 英雄详情（弹窗）· 设计契约与施工规格

> **AI 提示词见同目录 `prompts.md`** —— 那一份**只描述"这个弹窗要显示什么"**（+ 2 个要补的属性图标），
> **布局 / 分区 / 尺寸交给 AI 自行分析**，不写施工级坐标。
> 本文件是**施工级**的契约：面板长什么样、数据从哪来、升级怎么算、状态怎么判 —— 两者内容口径一致。
>
> ✅ **现状：已落地（2026-11）** —— `Scene_Menu.prefab` 的根节点上有了 `ui_hero_detail`
> （节点树 + `Cmp_HeroDetail` 组件），英雄卡的「详 情」按钮改为**开这个弹窗**。
> 落地时与本规格有 **4 处偏差**，逐条记在 **§8**（都是实现约束导致的，不是漏做）。
> 实施细节与验收证据见 §8；`HeroCard` 的「当前值 / 每级成长」切换开关已退休（详情页有每级成长列）。

---

## 1. 一句话流程（**落地后的实际形态**）

```
英雄页（Scene_Menu → content/right/heros）的一张卡
  └─ 点「详 情」                        → scope.emit(OpenDetail, heroId)（沿父链冒到 Scene_Menu）
       └─ Scene_Menu.openHeroDetail()    → HeroVM.buildDetailVM(heroId) → 打开 ui_hero_detail 并下发 VM
            └─ Cmp_HeroDetail.setVM(vm)  → 按 VM 重画（已解锁 / 未解锁两态）
                 ├─ 点「升 级」          → scope.emit(LevelUp, heroId)
                 │     └─ Scene_Menu → DataCenter.levelUpHero → 扣**通用英雄经验** → heroData.tryLevelUp
                 │           └─ 成功后 Scene_Menu 重推一次 VM（弹窗立刻变成"升完"的样子）
                 │              ＋ Cmp_Heroes 的指纹 watcher 自己重铺列表（卡片同步）
                 ├─ 点「解 锁」          → scope.emit(Unlock, heroId)
                 │     └─ Scene_Menu → DataCenter.unlockHero（**金币的唯一出口**）→ 同上两处一起刷新
                 └─ 点「关闭 ×」         → scope.emit(CloseDetail) → 只收起弹窗（**不写任何数据**）
```

**⚠ 宿主是 `Scene_Menu`，不是英雄页（`Cmp_Heroes`）** —— `UIScope.emit` **只沿 `node.parent` 向上冒泡**，
而 `ui_hero_detail` 必须是**根节点的子节点**（弹窗要盖住整屏，塞不进 `content/right/heros`）。
于是卡片发的「详 情」与弹窗发的「升 级 / 解 锁」都只到得了根节点：**`Scene_Menu` 是唯一同时看得见两侧的宿主**。
由此还定下一条硬口径：`Unlock` / `LevelUp` **只有 `Scene_Menu` 一个监听方**（卡片与弹窗发同一个事件；
两边各接一半 = 从弹窗点一下被处理两次，重复扣费）。

**分层与工程其它界面逐字同口径**：弹窗与卡片都只渲染 + 上报；**判据（经验够不够 / 解没解锁 /
这一步花什么、花多少）只在 `HeroVM` 算一次**（`cmps/HeroVM.ts`），两个消费方都只拿结果去画 ——
两边各写一份的话迟早会出现「卡片说能点、弹窗说不能点」，而这两处**从来不并排显示**，界面上极难发现。

**两种资源两种用途（2026-11 拍板，已落地）**：

| 动作 | 花什么 | 价格公式 | 谁发放 |
|---|---|---|---|
| **升级** | **通用英雄经验**（`HeroData.sharedExp`，所有英雄共用一份） | `HeroData.getExpForNextLevel(level)` = `100 × 1.12^(lv-1)` | 一局**通关**时（`Scene_Game_Stage.endRun` → `DataCenter.grantClearHeroExp`） |
| **解锁** | **金币**（`ItemData`） | `HeroConfig.getUnlockCost(id)` = `500 × 1.35^(列表序号)` | 局内结算 / 任务等既有出口 |

「能不能点」的判据（`HeroVM.isHeroActionEnabled`，两个界面共用）：

| 态 | 条件 |
|---|---|
| 未解锁（花金币） | `价 ≤ 0`（配表把解锁价配成 0 = 免费英雄）**或** `持有金币 ≥ 价` |
| 已解锁（花经验） | `价 > 0` **且** `通用经验池 ≥ 价` —— ⚠ 比解锁侧多一条 `价 > 0`：解锁是一次性的，升级**无上限**，配表没给经验口径时放行就是"点一下升一级"的无限白送（`HeroData.tryLevelUp` 也会拒） |

---

## 2. 面板要显示什么（「英雄的所有信息」逐字段）

| # | 显示什么 | 数据来源 | 口径 / 坑 |
|---|---|---|---|
| 1 | 英雄头像（白描徽记） | `units.head_icon` → `textures/heros/*`（碎图，**走 `resources.load(路径/spriteFrame)`**） | ⚠ 不能用 `loadBundleSprite`：它会把路径首段 `textures` 当分包名（`HeroCard.ts:426-441`） |
| 2 | 英雄名 | `cfg.name` | — |
| 3 | 解锁态 | `HeroData.isUnlocked(id)` | 未解锁 = 整块置灰 + 头像盖锁；**头像下面没有档案，所以等级/经验/属性一律按 1 级画** |
| 4 | 等级 | `heroData.getHeroLevel(id)` | 无上限；未解锁时收起（别显示 `LV.0`） |
| 5 | 经验（**持有池子** / 本级所需） | 通用经验池 / `getExpForNextLevel(level)` | **公式只许有一份**（`HeroData.ts:99-104`）；展示与结算同源 —— 见 §4 |
| 6 | 经验进度条 | `持有经验 / 本级所需` | `所需 <= 0`（表没给经验口径）或未解锁 → **整块收起**，别画一条永远空的条 |
| 7 | **5 项基础属性 + 每级成长** | `HeroConfig.getAttrRows(id, level)` | 见 §2.1 —— **不是卡片上那 4 行** |
| 8 | 技能（图标 / 名字 / 效果文案） | `HeroConfig.getSkillIcons(id)` + `abilities.json` 的 `name` / `lv1` | 技能图标走**图集三级降级**（`common/AtlasIcon.ts`），取不到会自己回落碎图 |
| 9 | 这一步花什么、花多少 | 未解锁 = 金币 `getUnlockCost(id)`；已解锁 = 经验 `getExpForNextLevel(level)` | `0` = 免费（表里基准价配成 0）→ 收起价格文字，别显示孤零零的「0」 |
| 10 | 持有的两种资源 | 通用英雄经验池 / `itemData.getCurrency(CurrencyType.Gold)` | **必须画在面板里**：遮罩是全屏的（750×1334 rgba(0,0,0,.70)），会把顶栏资源条一起盖住 —— 见 §3.1 |
| 11 | 已解锁统计 | `heroData.getUnlocked().length / HeroConfig.getHeroes().length` | 放 header 右侧（与 `ui_difficulty` 的 `count` 同位置） |

### 2.1 属性行：为什么不能照抄卡片那 4 行

卡片固定画 `HERO_ATTR_ROWS`（`HeroConfig.ts:36-41`）= **最大生命 / 攻击力 / 护甲 / 攻击距离**。
但英雄条目按铁律**只允许配 5 项基础属性**（`1 最大生命 / 2 最大魔法 / 3 攻击力 / 4 攻击速度 / 16 攻击距离`），
**从来不配护甲(6)** → `getAttrRows` 会回落到 `attributes.json` 的 `base`，而护甲的 base 是 **0**。

> 也就是说：**卡片上第三行「护甲」对任何英雄恒为 0** —— 那是"表里没配所以回落默认值"，不是设计意图。

详情面板按**英雄真配了的那 5 项**铺行，顺序即表的顺序：

| 行 | 属性 | 类型 | 显示口径（`HeroConfig.formatAttrValue`） |
|---|---|---|---|
| 1 | 最大生命 | 普通 | 取整（`452`） |
| 2 | 最大魔法 | 普通 | 取整（`120`） |
| 3 | 攻击力 | 普通 | 取整（`73`） |
| 4 | 攻击速度 | **倍率型** | 百分数（表里 `120` → `1.20` → 显示 `120%`） |
| 5 | 攻击距离 | 普通（**像素**） | 取整（`250`）；`battle_constants.pxPerMeter = 50`，**不要显示成米** |

「每级成长」列取 `units.growthValues` 的**原值**（float 语义，`HeroConfig.ts:249-253`），
不成长显示 `—`；等级 1 时成长一次都不加（`getAttrRows` 的 `levels = lv - 1`）。

### 2.2 **不叠局外遗物加成**（照抄卡片，别"顺手补上"）

`HeroConfig.ts:169-172` 已写明：`OuterAttributeCalculator` 那条链路**目前没有运行时消费点**，
玩家在局内也吃不到。面板要是先叠上，就变成「英雄页写着 20 护甲、进游戏是 0」。
接线之后在 `getAttrRows` 里加一层即可，**本面板不用自己叠**。

---

## 3. 布局规格

### 3.1 骨架来源：与「难度选择弹窗」逐节点同构

难度弹窗（`Scene_Menu.prefab` 的 `ui_difficulty`）是工程里**唯一已落地的全屏弹窗**，
它的实测尺寸就是本面板的骨架 —— 直接沿用，不要另起一套：

| 节点 | 位置 | 尺寸 | 备注 |
|---|---|---|---|
| `ui_difficulty`（根） | (0,0) | 750×1334 | Widget 全屏 |
| `mask` | (0,0) | 750×1334 | 纯视觉，**不接点击**（挂监听会让"点标题"也关窗） |
| `panel` | (0,**-23**) | **640×836** | 白色圆角 16（`common/rect_rd_20` 九宫格） |
| `panel/header` | (0,**363**) | **640×64** | 标题栏 |
| `header/corner_l` / `corner_r` | (∓309,-21) | **22×22** | 标题栏两端角饰 |
| `header/emblem` | (-279,0) | **26×26** | `outer` 26×26 + `inner` 12×12 两层 |
| `header/title` | (-252,0) | 120×49 | 20px 加粗 ink-900 |
| `header/btn_close` | (292,0) | **56×56** | 内含 `icon` 30×30 |
| `panel/detail`（底部操作条） | (0,-367) | **620×88** | 左文案 + 右主按钮 |
| `detail/btn_start` | (205,0) | **173×52** | `label` 48×39 + `arrow` 22×22 |

> ⚠ **`ui_hero_detail` 必须追加在 `head` 与 `ui_difficulty` 之后**（root 子节点顺序 = 绘制顺序）：
> 排在 `head` 前面会被顶栏压住，排在 `ui_difficulty` 前面会被难度弹窗压住。
> 另外两个弹窗**不要同时开**（各自 `onShow` 时先关掉对方，或宿主在同一处管显隐）。

### 3.2 版式表（`panel` 局部坐标，中心为原点，y 向上）

> **这是"建议版式"，不是硬指标**：数值全部取自工程实测（难度弹窗的骨架尺寸），照它搭能一次对齐现有界面；
> 但**换一种分区方式也完全可以** —— 让 AI 分析出来的组织方案只要满足 §2 的 11 项内容与 §3.3 的 token 约束，
> 就以那份方案为准，本表当参照。**提示词（`prompts.md`）里刻意不写这些坐标**。

`panel` 高 **840**（比难度弹窗高 4px，就是为了塞下第 3 块），宽 640 不变。

| 区块 | 节点名 | x | y | 宽 | 高 |
|---|---|---|---|---|---|
| 标题栏 | `header` | 0 | **+388** | 640 | 64 |
| 英雄块 | `hero` | 0 | **+268** | 600 | 176 |
| 分隔线 | `line_1`（`cc.Graphics`） | 0 | **+174** | 600 | 1 |
| 属性块 | `attrs` | 0 | **+22** | 600 | 288 |
| 分隔线 | `line_2`（`cc.Graphics`） | 0 | **-130** | 600 | 1 |
| 技能块 | `skill` | 0 | **-212** | 600 | 148 |
| 底部操作条 | `detail` | 0 | **-372** | 620 | 88 |

`panel` 顶边 +420、底边 -420：header 顶到 +420，`detail` 底到 -416（留 4px）。

**英雄块 `hero`（600×176，局部坐标）**

| 节点 | x | y | 宽 | 高 | 内容 / 颜色 |
|---|---|---|---|---|---|
| `hero/head` | -230 | 0 | 140 | 140 | 暗红 `#A85A5A` 圆角方底（`rect_rd_10`） |
| `hero/head/inner` | 0 | 0 | 110 | 110 | 英雄头像（白描，`textures/heros/*`） |
| `hero/head/lock` | 0 | 0 | 140 | 140 | 未解锁：ink-300 `#747474` 60% 遮罩 + `common/lock` 44×44 |
| `hero/head/lv` | 0 | -56 | 64 | 28 | 等级药丸：`c-accent-600` 底 + 白字 14px（「LV.12」） |
| `hero/name` | 100 | +52 | 400 | 34 | 24px 加粗 ink-900 左对齐（「火枪」） |
| `hero/exp_icon` | -196 | -20 | 20 | 20 | `common/exp_icon`（**青绿美术本色，不染色**） |
| `hero/exp_bar` | 4 | -20 | 300 | 10 | `ProgressBar`：轨道 ink-200 `#D8D8D8`、填充 `c-accent-400 #70ACB3` |
| `hero/exp_text` | 218 | -20 | 130 | 24 | 12px ink-400 右对齐（「120/347」= 持有经验 / 本级所需） |

**属性块 `attrs`（600×288）**：表头一行 30 高 + 5 行 × 48 高（首行中心 +70，行距 48）。
每行三列：图标 20×20 @ x=-272 · 名称 16px ink-600 左对齐 @ x=-210 · 当前值 20px ink-900 右对齐 @ x=+150 · 成长 12px ink-400 右对齐 @ x=+270。

**技能块 `skill`（600×148）**：分组底用 `c-surface-sunken #D8D8D8`（或白底 + 1px 描边）；
`skill/icon` 64×64 @ (-248,+18)，底 = `c-accent-400 #70ACB3` 圆角方 + 白描技能图（取图走 `AtlasIcon`）；
`skill/name` 20px ink-900 @ 右区上部；`skill/tag`「被动」12px `c-accent-600`；`skill/desc` 14px ink-600 两行（`lineHeight` 22）。

**底部操作条 `detail`（620×88）**：左 `cost` —— **图标跟着花什么走**：已解锁 = `common/exp_icon`（**青绿本色**）+ 经验数
（染 `c-accent-600`）；未解锁 = `common/gold` 染 `c-gold #D38C1E` + 金币价，数字 24px 同色；
右 `btn_upgrade` 173×52（`label`「升 级」16px 白字 + `arrow` `common/right` 22×22）。

### 3.3 颜色 / 字号 / 圆角：只用 token

| 用途 | token | 值 |
|---|---|---|
| 局外纸面底（面板背后被压暗的那层） | `c-canvas-menu` | `#EFEEED` |
| 面板底 / 卡片 | `c-surface` | `#FFFFFF` |
| 遮罩 | `c-scrim` | `rgba(0,0,0,.70)` |
| 标题、大数字 | `c-ink-900` | `#445054` |
| 正文 / 图标 | `c-ink-600` | `#6A696B` |
| 次要说明、成长值 | `c-ink-400` | `#999999` |
| 进度条轨道 / 分组底 / 分隔线 | `c-ink-200` | `#D8D8D8` |
| 进度条填充、技能图标底 | `c-accent-400` | `#70ACB3` |
| 选中/等级药丸、次要按钮 | `c-accent-600` | `#67999A` |
| **可点的主按钮**（升 级 / 解 锁） | `c-accent-action` | `#3F9E9B` |
| **不可点的主按钮** | `c-disabled-pill` | `#B9C1C1` |
| 头像格底（英雄身份） | `c-identity` | `#A85A5A` |
| 金币 / 价格 | `c-gold` | `#D38C1E`（亮部 `#FBE097`） |
| 不足 / 失败 | `c-warn` | `#C0392B` |

* 字号只用阶梯 **40 / 24 / 20 / 16 / 14 / 12**；圆角只用 **4 / 8 / 16**（`rect_rd_5` / `rect_rd_10` / `rect_rd_20`）；
  间距只用 **6 / 10 / 20 / 30**。
* **禁止**渐变 / 投影 / 发光 / 纹理 / 拟物高光；一屏只许一个主操作按钮。
* 三态与两态色：`c-accent-action`（可点）/ `c-disabled-pill`（不可点）—— 与 `HeroCard` 的
  `BTN_ENABLED_BG` / `BTN_DISABLED_BG`（`HeroCard.ts:22-23`）**同一对常量**，别再调一遍色。
  ⚠ 按钮要**关掉 `Button.transition`** 自己写色：`interactable = false` 时 Button 会用 `_disabledColor`
  统一覆盖外观，作者摆的两态会被同一块灰吃掉（`HeroCard.ts:19-21` 记过这个坑）。

### 3.4 三态

| 态 | 触发 | 表现 |
|---|---|---|
| **已解锁** | `heroData.getHeroInfo(id) !== null` | 正常色；行显示「当前值 / 每级」；按钮「升 级」+ **经验**价；等级药丸与经验条都在 |
| **未解锁** | 同上取到 `null` | 整块置灰（`NodeUtils.setGray`，头像盖 `lock`）；等级药丸/经验条**收起**；属性按**1 级**画；按钮「解 锁」+ **金币**价 |
| **资源不够** | 已解锁：持有经验 `< getExpForNextLevel(level)`；未解锁：金币 `< 解锁价` | 只有按钮变 `c-disabled-pill` 且 `interactable = false` —— **卡面不置灰**（"这里能升但目前升不起"要一眼分得清） |

---

## 4. 升级与经验：**已拍板（2026-11）** —— 升级花经验、经验在局内结束时发放

| 项 | 口径 |
|---|---|
| 升级花什么 | **通用英雄经验**（所有英雄共用一份池子） |
| 升级价格 | `HeroData.getExpForNextLevel(level)` = `floor(100 × 1.12^(lv-1))`（**同一把尺**：展示与结算共用，见 `HeroData.ts:99-104`） |
| 经验从哪来 | **一局结束时发放**（发放点：`Scene_Game_Stage.endRun` 之后，与「结算面板 → 领奖」同一处流程） |
| 解锁花什么 | **金币**（`500 × 1.35^(列表序号)`）—— 金币**不参与升级** |
| 经验条的含义 | **"够不够升级"**：条 = `持有经验 / 本级所需`，满了就能点「升 级」；升级后扣掉、条回落、下一级所需变大 |
| 金币的含义 | 只用于解锁英雄（`DataCenter.unlockHero` 保持不动） |

### 4.1 落地时必须改的三处（**这一版口径的直接后果**）

| 改哪 | 为什么 |
|---|---|
| **新增一份通用经验池** | `HeroData` 现在的 `exp` 是**per-hero** 的（`HeroInfo.exp`），而口径要的是"所有英雄共用"。放进 `ItemData` 加一种货币、或放 `PlayerInfo` 都行，**但要只有一处真源** |
| **`HeroData.addHeroExp` 改成"只加不升"** | 它现在是**发经验即自动升级**的循环（`HeroData.ts:139-155`），与"在详情面板花经验升级"直接冲突：进池那一刻就自己升完了。要么删循环，要么整体改用新的加经验入口 |

> ⚠ 上一版（口径 A：升级花金币 `50 × 1.25^(lv-1)`）已废弃：`heroLevelUpGoldBase` / `heroLevelUpGoldRatio`
> 两个常量**不再有消费者**（若确定不回退，可以从 `battle_constants` 撤键，撤键要连 xlsx 一起改）。
> ⚠ `clearRewardHeroExpBase`（= 80）仍在 `battle_constants.json` 里但**没有任何消费方**（随"奖励改为任务领取"下线）
> —— 它就是"一局结束发英雄经验"的候选数值来源，接线时从它起步、或新配一个键。

---

## 5. 资产：谁复用、谁是新增

**一律复用（不要出图，出了就是白花钱 + 撞风格）**：

| 要什么 | 用什么 |
|---|---|
| 面板底 / 圆角 | `common/rect_rd_20`（九宫格，运行时染色） |
| 小圆角（头像格底、等级药丸） | `common/rect_rd_10` / `rect_rd_5` |
| 关闭 × | `common/close`（200×200，白描挖空） |
| 未解锁锁 | `common/lock` |
| 标题栏角饰 | `common/conor`（60×68） |
| 英雄头像 | `textures/heros/*`（10 个英雄都有） |
| 技能图标 | `textures/skills` 图集（40 张 64×64，走 `AtlasIcon`） |
| 生命 / 攻击 / 护甲 / 攻击距离图标 | `common/heart` · `property/atk` · `property/defence` · `property/atk_range` |
| 经验图标 | `common/exp_icon`（**青绿本色，不染色**）—— 升级价与"持有经验"都用它 |
| 金币图标 | `common/gold`（白描，运行时染 `c-gold #D38C1E`）—— **只出现在解锁语境** |
| 升级箭头 | `common/right` |
| 进度条 / 分隔线 | `rect_rd_20` 九宫格 + `Sprite.color`；分隔线 `cc.Graphics` 画 `#D8D8D8` 细线 |
| **所有文字与数字** | **`cc.Label`**（绝不出图：不可本地化、不可改字号、不可染色） |

**要新增（= `prompts.md` 的清单）**：

| key | 是什么 | 为什么缺 |
|---|---|---|
| `hero_attr_atk_speed` | 攻击速度图标 | `textures/property/` 只有 `atk` / `defence` / `atk_range`，**没有攻速** —— 卡片之所以不显示攻速就是这个原因（`HeroConfig.ts:32-34`） |
| `hero_attr_mana` | 最大魔法图标 | `common/energy.png` 是**顶栏货币格**在用的图标（`Scene_Menu.prefab` 的 `head/coins/ernergy-*`），拿它当属性图标会与"货币"语义撞车 |
| `hero_detail_popup` | 弹窗效果图（9:16，**只讲显示内容**，布局交给 AI） | 评审/施工对照，**不进工程** |

> 标题栏徽记可以直接沿用 `ui_difficulty` 的 `outer` 26×26 + `inner` 12×12 双环，**不必单独出图**；
> 顶部主插图（等距白模横幅）本轮**不做** —— 面板内容是信息密集的表格，顶部再加插图会抢注意力。

---

## 6. 施工清单（谁改哪个文件）—— ✅ 已全部落地（2026-11）

| 文件 | 改什么 | 实际怎么落的 |
|---|---|---|
| `assets/scripts/game/data/funcs/HeroData.ts` | 加**通用经验池**；`addHeroExp` 去掉自动升级循环；新增升级入口 | 池子放在**本模块**（`IHeroData.sharedExp`），不挪 `ItemData`（见 §8-②）；`addHeroExp` / `getHeroExp` / `records[].exp` **整体删除**，换成 `getSharedExp` / `addSharedExp` / `hasSharedExp` / `tryLevelUp` |
| `assets/scripts/game/data/DataCenter.ts` | `levelUpHero` 改走经验；`unlockHero` 保持不动 | ✅ 逐字如此；另加 `grantClearHeroExp(difficulty)`（发放的唯一入口）+ 失败原因 `no_exp` / `no_formula` |
| `assets/scripts/game/ui/scenes/scene_game_stage/Scene_Game_Stage.ts` | **经验发放点**：`endRun` 之后发通用英雄经验 | ✅ 只在**通关分支**发（`clearRewardHeroExpBase × rewardMul(难度)`）；`exit()` 不发 |
| `.../Scene_Menu.prefab` | **新增** `ui_hero_detail` 节点树，追加在 `ui_difficulty` 之后 | ✅ 77 个节点，追加在最后（root 子节点顺序 = 绘制顺序）；静置态 `active=false` |
| `.../cmps/Cmp_HeroDetail.ts` | **新增**：`UIWidget`（**禁止 `@uiview`**），只渲染 VM + 两条 `scope.emit` | ✅ 逐字如此；节点引用按名字兜底解析 |
| `.../cmps/HeroScope.ts` | 新增 `OpenDetail` / `CloseDetail` + `HeroDetailVM`（`cost` 换成 `costKind`） | ✅ 逐字如此（`Detail` 那个"展开互斥"事件随卡片开关一起退休） |
| `.../cmps/HeroVM.ts` | （规格里没有的新增）**判据的唯一实现**：卡片 VM / 弹窗 VM / 指纹 | ✅ 新增文件 —— 因为判据现在有两个消费方（卡片 + 弹窗），见 §1 的分层说明 |
| `.../cmps/HeroCard.ts` | 「详 情」按钮改成开弹窗；`expanded` 那套退休 | ✅ 逐字如此；另加"价格图标跟着 `costKind` 走"（升级 = 经验图青绿本色，解锁 = 金币图） |
| `.../cmps/Cmp_Heroes.ts` | `buildVM` 按态分流；收 `OpenDetail` 开弹窗；指纹加进经验池 | 判据挪进 `HeroVM`（本类只剩"铺列表"）；**开弹窗与收动作都归 `Scene_Menu`**（见 §1 的 ⚠）；指纹已含经验池 |
| `assets/scripts/game/ui/scenes/scene_menu/Scene_Menu.ts` | （规格里没有的新增）托管弹窗 + 英雄页四件事 | ✅ 与 `ui_difficulty` 逐字同构：`setupHeroDetailPanel` / `wireHeroEvents` / `openHeroDetail` / `closeHeroDetail` / `pushHeroDetail` + 两个动作处理 |
| `assets/scripts/game/common/GoldText.ts` | （规格里没有的新增）`formatCount`（千分位原数） | ✅ 进度类读数（经验池 / 升级价 / 金币）要能跟进度条上的「120 / 347」对上账，不能用 `2k` 那种缩写 |
| `tools/hero-detail-prompts/gen-prompts.mjs` | 提示词生成器（改提示词改它，**别手改 `prompts.md`**） | 未动 |

**体检**：`npm run audit:herocard`（`tools/hero-card-audit/audit.mjs`）已扩到 **75 条**，
新增 D 组（通用经验池与升级：只进池不自动升级 / 池子不够不动数据 / 未解锁不能升 / base=0 不免费白送）、
F 组（**两态判据**：真 `HeroVM.ts` + 假数据层，覆盖"未解锁+金币够→可点、解锁后同一函数给出另一份 VM"），
以及 B7b/B7c/B14/B14b（价格图标跟着花什么走、切态能复原）。

---

## 7. 验收清单（勾 = 已在编辑器里逐项看过；`~` = 只能真机跑一把才能确认）

- [x] 英雄页点「详 情」→ 弹出面板；**顶栏资源条被遮罩盖住，但面板里的经验与金币读数看得见**。
- [x] 已解锁英雄：等级药丸 + 经验条（`持有经验 / 本级所需`）+ 5 行属性（当前值 + 每级成长）+ 技能三件套 + **经验价** + 「升 级」。
- [x] 未解锁英雄：整块置灰 + 头像盖锁 + 等级/经验收起 + 属性按 1 级画 + 按钮文案变「解 锁」+ **金币价**。
- [x] **资源不足**：按钮变 `#B9C1C1` 且 `interactable=false`（点不动），页面其余部分保持正常色；
      **金币不足不影响升级按钮**（只影响解锁）、**经验不足不影响解锁按钮**（只影响升级）。
      三态已在编辑器里逐张截图核对过（`.tmp-hero-detail/v4-*.png`，**临时文件、不必入库**）：
      金币够 → 亮青按钮 `#3F9E9B` / 差 1 金币 → 灰按钮 `#B9C1C1` / 已解锁 → 经验价 + 经验条。
- [x] 属性行是**最大生命 / 最大魔法 / 攻击力 / 攻击速度 / 攻击距离**（**不是**卡片那 4 行，页面上不出现恒为 0 的护甲）——
      `HeroConfig.HERO_DETAIL_ATTR_ROWS` 是唯一真源，断言见体检 F6b。
- [x] 颜色只来自 §3.3；字号只落 40/24/20/16/14/12（`24/20/16/14/12`）；圆角只落 4/8/16。
- [x] 点「关闭 ×」→ 面板收起，**存档一个字节都没动**（`Cmp_HeroDetail.onClickClose` 只有一句 `scope.emit`）。
- [~] 点「升 级」→ **经验池扣掉 `本级所需`**、等级 +1、经验条回落、属性值变大、下一级所需按 `100 × 1.12^(lv-1)` 涨一档
      —— 数据层逻辑由体检 D6/D7 钉住，界面重画由 `Scene_Menu.pushHeroDetail` 负责；**真机点一下才能看到联动**。
- [~] 打一局通关 → 经验池**涨了**（且进存档）；**中途退出不发** —— 需要真机跑一局。
- [~] 反复开关弹窗：没有返回值、没有刷屏报错（**`onDestroy` / `onDispose` 里绝不碰别的组件**）——
      `Cmp_HeroDetail.onDispose` 只摘两个节点事件，形参与 `HeroCard` 同款。
- [ ] 图标摆成一行时，`hero_attr_atk_speed` / `hero_attr_mana` 与 `property/atk` `property/defence`
      `property/atk_range` `common/heart` **看不出是两批出的图** —— ⏳ **等这两张图**（现在仍是占位图，见 §8-③）。

---

## 8. 落地差异（实现与本规格不一致的 4 处 + 理由）

| # | 规格怎么写的 | 实际怎么落的 | 为什么 |
|---|---|---|---|
| ① | §1/§6：宿主是 `Cmp_Heroes`（它开弹窗、它收 `Unlock`/`LevelUp`） | 宿主是 **`Scene_Menu`**；`Cmp_Heroes` 只管铺列表 | `UIScope.emit` **只沿 `node.parent` 向上冒泡**，而 `ui_hero_detail` 必须是根节点的子节点（要盖整屏）—— `Cmp_Heroes`（在 `content/right/heros` 里）**根本收不到弹窗发的事件**。两边各接一半就会重复扣费，所以必须归一处，而根节点是唯一同时看得见卡片与弹窗的地方 |
| ② | §4.1：通用经验池"放 `ItemData` 加一种货币、或放 `PlayerInfo` 都行" | 池子放在 **`HeroData`（`IHeroData.sharedExp`）** | 它是**英雄成长**的数据，和 `records` 同生共死（同一份存档、同一次合并、同一个 `getSharedExp`）；放 `ItemData` 会变成"英雄升级逻辑读货币表"，而且 `HeroData.tryLevelUp` 就得反向 import 货币模块。**并且：老存档不会丢** —— `sharedExp` 在默认数据里预置了 key，`mergeDeep` 会正确合并（这正是 `records` 当初必须改成数组的原因） |
| ③ | §3.2：面板高 840、hero 块 600×176、属性行 48 高… | 面板 **640×440**，分区按**效果图**（顶部英雄块 → 左属性 / 右技能 → 底部操作条），无青底标题栏与角饰 | §3.2 自己写明"是建议版式，不是硬指标"；`prompts.md` 也是"布局交给 AI"。效果图的分区更好（一屏内信息密度高、不用滚），11 项内容一个不少 |
| ④ | §5：分隔线用 `cc.Graphics` 画细线 | 用 **1px `Sprite`**（`common/white_4x4` 染 `#D8D8D8`） | `cc.Graphics` 的绘制指令**不随预制件序列化** —— 摆进预制件运行期是空的（`ui_difficulty` 里那条分隔线就是这个形态） |

**还差的两张图**（`hero_attr_mana` / `hero_attr_atk_speed`）：`HeroConfig.ATTR_ICON` 里它们的值是**空串**
（= 保留预制件里作者摆的占位图：`common/energy` 与 `common/right`），**故意不写一个不存在的路径** ——
那会让每次打开弹窗都刷一条"图标加载失败"。图到位之后只改这一处、两个字符串。
