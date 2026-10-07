# 商城（全屏页）· 设计契约

> **AI 提示词见同目录 `prompts.md`** —— 那一份**只描述"这个全屏页要显示什么"**（+ 2 个要补的图标），
> **布局 / 分区 / 尺寸交给 AI 自行分析**，不写施工级坐标（与 `docs/hero-detail/prompts.md` 同一套口径）。
> 本文件是**设计级**的契约：卖什么、每个商品给多少、钱从哪来、数据出口在哪、还差哪些接线。
>
> ✅ **现状（2026-11 更新）：界面与数据层都已落地，一屏跑得通**。
> **形态 = `views/` 形态的 `BaseView`**（不是场景内嵌 `UIWidget`，与 `View_TaskUI` 同口径）：
> 预制件 `assets/resources/prefabs/ui/views/shop/View_Shop.prefab`（110 节点；广告区是**竖直滚动列表**，见 §3.2）
> + 脚本 `assets/scripts/game/ui/views/shop/View_Shop.ts`（`@uiview` 注册，`layer = View`、`single`）
> + 契约 `assets/scripts/game/ui/views/shop/ShopScope.ts`（事件 + 页面 VM 形状）
> + 判据 `assets/scripts/game/ui/views/shop/ShopVM.ts`（**把存档算成一份 `ShopPageVM`**）。
> **入口有四个**：主界面底部「商城」页签（`bottom/left/shop`）+ 顶栏 `head/coins/<格名>/add` 三颗 `+`。
> **数据层**：`data/funcs/ShopData.ts`（存档：日键 / 每格次数 / 免广告卡）+ `DataCenter` 的商城四个出口
> + `configs/MallConfig.ts`（读 `mall_items.json` 与 `battle_constants` 的 `shop*` 常量）+ `AdMgr` 的 6 个广告位。
> **体检**：`npm run audit:mall`（**174 条**：真跑 `ShopData` / `DataCenter` / `ShopVM` + 真配表 + 读真预制件对契约）。
> ⚠ **2026-11 起：券 / 次数的"存量"不在 `ShopData` 里了，搬到了 `data/funcs/BagData.ts`（局外背包）** ——
> `ad_ticket` / `revive_ticket` / `outer_draw_ticket` / `boost_<effect_code>`。它们不是"商城的记账"而是**玩家背包里的东西**，
> 两处各存一份迟早会出现"商城说 2 张、背包说 0 张"。`ShopData` 上那 10 个券相关方法（`getAdTickets` /
> `addBoostTicket` / `consumeOuterDrawTicket` …）**已整体删除**；商城发奖改道 `bagData.addItem`。
> 口径真源与搬家的完整理由见 **`docs/bag/README.md` §1**（`audit:mall` 的 D7/D8/G3/H 段断言已跟着改，
> 那几段顺带成了 `BagData` 的存档往返体检）。
> ✅ **2026-11 第二次改：商城的三种券 = 三个背包道具，用的地方一律"检查背包"** ——
> A4 `relic_draw` → `outer_draw_ticket`、**A5 `revive_ticket`（顶替原「开局增益券」格）** → `revive_ticket`、
> A6 `ad_ticket` → `ad_ticket`；三个 `grants.type` 在 `DataCenter.grantMallLines` 里都落 `bagData`。
> 🚧 **还没做的**（都属于"局内消费"那一侧，不影响这一屏）：**局外遗物抽取扣券**（抽取链路本身未落地）、
> 局外属性进战斗 —— 见 §4 的第 5/9 条。**已落地**：局内广告券替换两个广告位（§4 第 7 条、`docs/meta-growth/README.md` §3）、
> 局内复活券（A5 的消费侧，`docs/bag/README.md` §6）。

---

## 1. 一句话形态

**全屏页**（不是弹窗、不是右侧内容页）：占满 750×1334，打开时**主界面被整块盖住**，
左上角一个返回入口，页内自带资源读数（顶栏那一条 750×76 被盖住了，玩家看不见它）。
**形态 = `views/` 形态的 `BaseView`**（宿主 `UIManager` 的普通视图层，返回**页面自关**）。

```
（四个入口都在 Scene_Menu）
底部页签 bottom/left/shop ／ 顶栏 coins/{gold,ernergy-001,ernergy-002} 各自的 "+"
  └─ 点它   → Scene_Menu.onClickShop()             （先收起 ui_difficulty / ui_hero_detail）
       └─ UIManager.showUI(View_Shop)              （View 层，盖住整个 Scene 层）
            ├─ 点「免费领取」 → scope.emit(ClaimFree)   → 本页 onClaimFree
            │     └─ DataCenter.claimShopDailyGift() → 记"今天领过" + 发金币/经验（× 连续登录倍数）
            ├─ 点某个商品格   → scope.emit(BuyWithAd, itemKey) → 本页 onBuyWithAd
            │     ├─ DataCenter.canUseShopAd(key)   （本格次数 / 今日广告总次数，判据只算一次）
            │     └─ AdMgr.showRewardVideo(placement)
            │           ├─ true  → DataCenter.grantShopItem(key) → 发奖 + 记次数 + 记累计观看 → 飘字 + 重刷
            │           └─ false → 不发奖、不记次数（**没接 SDK 时的既定语义**），底部说明行给一行提示
            ├─ 点免广告卡的「领取」 → scope.emit(ClaimAdCard) → 本页 onClaimAdCard
            │     └─ DataCenter.claimAdCard() → 记「生效到什么时候」+ 清累计计数
            └─ 点「返回」     → View_Shop.onClickBack() → UIManager.closeUI(View_Shop)（只收起，不写数据）
```

⚠ **宿主是谁：这一屏自己**（2026-11 修正，别照旧稿抄成 `Scene_Menu`）。
`UIScope.emit` 只沿 `node.parent` 向上冒泡、**不跨 UIManager 的层节点**（`views` 与 `scenes` 是兄弟，
见 `platform/ui/UIScope.ts` 规则 1），所以"页面把事件冒到 `Scene_Menu` 去处理"在原设计里**做不到**。
落地形态与 `View_TaskUI` 一致：**页面自己 `scope.on` 自己 `emit` 的三件事**
（留这条缝是为了将来把流程搬到别处时只改一处监听），
**`Scene_Menu` 只负责"开"与"与另两个全屏面板互斥"**这两件事。

**分层仍然照旧**：页面只渲染 + 上报；**判据（能不能领 / 还剩几次 / 卡攒到哪了）只在 `ShopVM` 里算一次**
（`buildShopPageVM()` 下发一份 `ShopPageVM`）；发奖 / 扣额度 / 写存档全在 `DataCenter`
（本项目局外资源的唯一出口）。数据是响应式的：页面在 `init()` 里订阅 `shopFingerprint()`，
任何地方改了金币/经验/次数/券/卡，界面自动重刷。

> **为什么最后还是选了 views 形态而不是原先写的「`Scene_Menu/ui_shop` 内嵌节点」**：
> ① 同一屏的 `View_TaskUI`（任务界面）就是 views 形态的全屏页，两条路并存只会让"返回怎么办 /
> 谁管 `active` / 事件往哪冒"每次都重新讨论一遍；② views 形态下 `UIManager` 负责建/缓存/销毁，
> 页面自己管生命周期，`Scene_Menu` 只需要"开"和"与另两个全屏节点互斥"两件事；
> ③ 内嵌形态要求 `Scene_Menu.prefab` 里多一棵 110 节点的子树，而主界面预制件已经有 311 个节点了。
> （顺带：内嵌也解决不了跨层通信 —— `ui_hero_detail` 能收到英雄页的事件，是因为它挂在**同一个场景节点**下。）

---

## 2. 可卖内容（**唯一口径表**）

### 2.0 先看钱从哪来（这决定了什么值得卖）

| 局外资源 | 唯一用途 | 现有来源 | 深坑有多深 |
|---|---|---|---|
| **金币** `itemData.currencies.gold` | **解锁英雄**（`HeroConfig.getUnlockCost` = `500 × 1.35^列表序号`） | 账号升级（2~30 级合计 **29,040**）、任务领奖（日 810 / 周 8,800）、成就（75 行一次性合计 **185,650**） | 10 位英雄解锁总价 **27,295** —— **一次性、且远远小于成就给的金币** → 后期金币过剩 |
| **通用英雄经验** `heroData.sharedExp` | **英雄升级**（`HeroData.getExpForNextLevel` = `100 × 1.12^(lv-1)`） | **只有一局通关**：`clearRewardHeroExpBase`(80) × `rewardMul(难度)` | **无上限**：升到 Lv10 累计 1,475 / Lv20 **6,336** / Lv30 **21,447** / Lv40 **68,384** —— 全项目唯一的无限深坑 |
| **账号经验** `playerInfo.exp` | 账号等级（1~30），升级按等级表发金币 | 任务领奖（日 550 / 周 3,650） | **封顶**：到满级累计 **98,390** 经验 → 顺带发 29,040 金币 |
| **局外遗物** `equipCollection` | 图鉴（`Cmp_OuterRelics`）+ 成就 `relic_collected` 进度 + 永久属性 | **局外花金币抽取**（`docs/meta-growth/README.md` §1）；⚠ 局内抽到遗物**不再**写局外图鉴（那条接线已切断，见 §2.2 的 A4 说明） | 37 件（白 12 / 蓝 8 / 紫 11 / 红 6）；⚠ **属性还没接进战斗**（`OuterAttributeCalculator` 无运行时消费点 → 见 §4 第 8 条） |

> 结论：**金币是前期资源、经验是长期资源**。广告商品的主推应该是**经验**，金币袋是补前期缺口。

### 2.1 F · 每日免费（每天 1 次，**不看广告**）

| # | 商品 | 给多少 | 依据 |
|---|---|---|---|
| **F1** | **每日补给** | **金币 ×200 + 通用英雄经验 ×100** | 日任务 6 条合计 ≈810 金 / 550 经验 → 本项 ≈ 1/4 天日常；100 英雄经验 ≈ **1.25 局通关**（80/局·难度 1） |

- **连续登录加成**（复用 `PlayerInfo.loginStreak`）：1~2 天 ×1（200/100）· **3~6 天 ×1.5（300/150）** · **≥7 天 ×2（400/200）＋ 开局增益券 ×1**
- ⚠ **界面上显示的是乘完之后的数**（连续 4 天就写「金币 300 + 通用英雄经验 150」+ 一行「连续登录 4 天 · 今日 ×1.5」），
  **不要**写成「200 × 1.5」让玩家自己算
- **重置口径**：本地日键 `YYYYMMDD`（与 `TaskData.todayKey()` 逐字同口径），跨日自动恢复；界面显示「距重置 07:12:33」
- 两态：**可领**（青绿实心主按钮「免费领取」）/ **已领**（`c-disabled-pill #B9C1C1` 灰药丸 +「明天再来」+ 倒计时）

### 2.2 A · 广告商品（看 1 次激励视频领 1 份；每项有每日次数上限）

| # | 商品 | 给多少 | 每日 | 依据 / 值不值 |
|---|---|---|---|---|
| **A1** | 金币袋 | **+300 金币** | 3 | 角色变了：它现在是**遗物抽取的燃料**（`docs/meta-growth/README.md` §1.3：当日 1~2 抽）；顺带补前期解锁英雄的缺口（第 2 位 675） |
| **A2** | 英雄经验瓶 | **+120 通用英雄经验** | 3 | ≈1.5 局通关；满额度 360/天 ≈ 4.5 局；Lv12→13 需 347（≈3 次） ★**主推** |
| **A3** | 账号经验册 | **+150 账号经验** | 2 | 等级 1→2 需 100、2→3 需 120；升级另按等级表发金币（120~3,000）**并解锁局内等级加成**（同为 `docs/meta-growth/README.md` §2） |
| **A4** | 局外遗物抽取券 | **+1 张抽取券**（1 张 = 免费抽 1 次，不花金币） | **2** | 走**同一套抽取管线**（品质权重 6:2.5:1:0.5 + 档内优先未收集），**不花金币、也不抬高当日价格阶梯**（与局内"广告免费刷新不抬高后续费用"同口径）★**主推** |
| **A5** | 局内复活券 | **+1 张复活券**（局内死亡时免看广告复活） | 2 | **2026-11 顶替了原来的「开局增益券」那一格**（预制件里那一格本来就叫 `cell_relife`）。券进背包（`revive_ticket`，跨局累积），局内英雄被打死那一刻弹复活面板：有券走券、没券看广告（每局 `battle_constants.reviveAdPerRun` 次）。⚠ **本局增益券没有消失**：它仍由「连续登录 ≥7 天赠 1 张」发放（§2.1），只是不再占一格 |
| **A6** | 局内广告券 | **+1 张局内广告券** | **2** | 局内**免看广告**抽卡 / 补选遗物（`docs/meta-growth/README.md` §3）；广告是全屏原生层、局内播要暂停战斗，攒券把广告挪到局外看不打断节奏。⚠ 券**只替换广告、不增加局内次数上限**（**已落地 2026-11**：`RefreshGate.viaTicket` + `RelicShop` 两个广告位） |

- **每日广告总上限 = 14 次**（3+3+2+**2**+2+**2**），跨商品共用一个「今日已看广告次数」账本 ——
  界面顶部重置条右侧显示「今日广告 6/14」（`reset_bar/label_today`）。
  ⚠ A5 由「增益券」换成「复活券」是**顶替**而不是新增，所以六格之和仍是 14、总上限不动
  （体检 B2 盯的是 `Σ daily_limit == shopAdDailyTotalLimit`；要抬总上限就得同时给别的格加次数）。
- **数值的唯一来源**（2026-11 落地）：上面这些数**一行一个商品地写在 `mall_items.json`** 里 ——
  `grants`（发什么，一项一件）、`daily_limit`（每天几次）、`placement`（哪个广告位）、
  `name` / `amount_text`（界面那两行文案）；跨商品的规则常量在 `battle_constants` 的 `shop*` 键里。
  ⇒ **格子上写的数就是真正发的数**（`ShopVM` 把配表下发到格子的 `name` / `amount` 标签，见 §3.2），
  改数量只改表；`Σ daily_limit` 必须等于 `shopAdDailyTotalLimit` —— `npm run audit:mall` 的 B2 在盯这条。
- 每格显示 **「今日 N/M」**（三态只画这一种，见 §3.4 的决策登记）
- ⚠ **广告语义沿用 `AdMgr` 的既定口径**：未注入真 SDK → `showRewardVideo` 一律 `false` → **不发奖**。
  这条不是"开发兜底"，是刻意为之（历史上按"看完"兜底白送过免费刷新）。
  → 界面上**不画**「广告暂不可用」这个态（决策见 §3.4），**由页面在顶部重置条那行给一行中文提示**
  （`View_Shop.flashHint`：借 `reset_bar/label_hint` 显示 2 秒再还原 —— 只打 `ezgame.warn` 玩家是看不见的。
  ⚠ 2026-11 契约变更：原来借的是页面最底部 `ledger/label_rule`，而那条 `ledger` 在预制件改版时被删了，
  运行期取不到 = **领不到时玩家看不到任何反馈**；现在读 `reset_bar` 的两行，`audit:mall` 的 J5 会拦这种"路径不存在"）。
- 另有**§2.3 免广告卡**（累计看满 84 次换 24 小时免广告）：它**不是商品格**，是这一屏唯一的长线目标。

### 2.3 免广告卡（累计观看换 24 小时免广告 · **2026-11 定案保留**）

| 项 | 口径 |
|---|---|
| 攒什么 | **累计观看广告次数**（跨天累计，不按日清零），每看 1 次激励视频 +1 |
| 攒多少 | **84 次**（= 每日广告上限 14 × 6 天；样本态「累计观看广告 42/84」就是半程） |
| 给什么 | **24 小时免广告**：这段时间里**局内那两个广告位**（`relic_refresh` / `relic_extra_pick`）**不再拉起广告**，直接放行；用户点「领取」时记 `activeUntil` 时间戳并**清空累计计数**（下一张从头攒） |
| 为什么保留 | **它解决的是"看广告的动机"**（用户原话）：`A1~A6` 每次只给一份小额资源，而这张卡把"攒够"变成一条独立的长线 —— 让"今天把 14 次看完"这件事本身有终局奖励。它是本页**唯一的长线目标**，也是广告频次能上去的支点 |
| 界面三态 | 未攒满（环 + 次灰字「未攒满」）/ 可领（环 + 深墨字「领取」）/ 生效中（**隐藏进度区**，只留「免广告生效中 · 剩 23:12:45」，按钮整颗收起） |
| ⚠ 与 A6 的关系 | **不冲突、也不重复**：A6 是**券**（局外看广告攒、局内免广告，一次一张、跨局累积），这张卡是**时间段**（24 小时内不限次数）。两者**都只替换局内那两个广告位**，**都不增加局内次数上限**（那 3 次免费刷新 / 1 次补选照扣） |
| ⚠ 与"唯一实心主按钮"的关系 | 全屏页只留「免费领取」一颗**实心**按钮（`c-accent-action`）。免广告卡的「领取」用**青绿描边环**（`rect_board_rd_20`，只描边不填充）+ 深墨字 —— 环是"这里能点"的语义，实心留给主操作。⚠ 环是**烤进贴图的青绿、不能染色**（`Sprite.color` 乘上去会发脏），所以"不可点"只回答在**字色**上 |

### 2.4 暂不做（**要先接线，不是不做**）

| 想卖的 | 卡在哪 |
|---|---|
| **体力** | `CurrencyType.Stamina` 有字段、`initialStamina = 120` 也配了，但**全工程 0 个消费点**（`getInitialStamina` 只在 `ItemData.defaultData` 被读过一次）→ 卖了没处花。要先做「进关扣体力 + 随时间恢复」 |
| **钻石 / 荣誉** | `CurrencyType` 枚举里有，**无来源、无出口**（`grep` 全工程只有枚举与默认值）→ 卖它就是凭空造一套没有用途的货币 |
| **连续登录 7 天阶梯** | 字段齐（`loginStreak` / `signedInToday`），但 `PlayerInfo.onDailyLogin()` **全工程无调用方** → 要先接它；另注意 `signedInToday` 的默认值是 `true`（新号第一天就"已签到"），接的时候要一并改 |
| **离线收益 / 挂机** | 没有时间戳收益系统。`battle_constants` 里的 `rewardTimeBasePerSec` / `rewardTimeCap` 是**局内**的奖励时间系数（`Scene_Game_Stage.grantKillReward` 用），**不是挂机** |

### 2.5 不卖（**这三条要写进代码注释，免得以后有人补上**）

| 不卖 | 为什么 |
|---|---|
| **英雄本体 / 英雄等级直通** | 会绕过两条成长线：金币的深坑（解锁英雄 27,295 + **遗物抽取**，见 `docs/meta-growth/README.md` §1.3）、通用英雄经验是唯一的无上限深坑。直通等于把两张表一起作废 |
| **难度档位** | 解锁判据是「通关第 N 档」（`LevelData` 是唯一真源），花钱越过就与难度曲线自相矛盾（`docs/difficulty-select/README.md`） |
| **局内金币 / 遗物 / Buff** | 局内是**双货币**封闭经济（金币只给选英雄刷新 + 遗物抽取，击杀数只给击杀商店），广告位在**局内已经存在**（刷新 / 补选，`shop_constants.ad*`）。局外再插一脚会同时毁掉一局的肉鸽平衡与那两个既有广告位的价值 |

（皮肤 / 头像框 / 改名卡：工程里没有对应系统，`PlayerInfo.name` 可写但没有改名入口，v1 不做。）

---

## 3. 界面契约

### 3.1 入口：**开商城的点击都已接，顶栏读数还没接**

| 入口 | 状态 |
|---|---|
| **底部页签 `bottom/left/shop`**（与 `bag` / `task` 同排） | ✅ **已接**（2026-11）。与 `taskBtn` 同形：**纯 `Sprite` 节点、连 `Button` 都没有** → 走 `Node.EventType.TOUCH_END`，按路径 `bottom/left/shop` 兜底解析（`Scene_Menu.SHOP_TAB_PATH`），**没改 `Scene_Menu.prefab`** |
| 顶栏 `head/coins/<格名>/add` 三颗 `+` | ✅ **已接**（同上，`SHOP_ENTRY_PATHS`）。三格 `gold` / `ernergy-001` / `ernergy-002` 每格都是 `icon(30×30) + value(Label) + add(30×30)` 的 `cc.Layout` |
| 三个 `value` 的**读数** | 🚧 **没接**：文案仍是预制件里写死的 `200`。要接 `itemData.getCurrency(Gold)` / `heroData.getSharedExp()` / `playerInfo.level+exp` |
| `ernergy-001/002` **指代什么** | 🚩 **待拍板**（建议：一格 = 通用英雄经验，另一格 = 账号经验条；`energy.png` 这个图标**已被顶栏当货币用**，别再给别的语义）。定下来之前读数不接，免得又是"两格都显示同一个数" |

> ⚠ 底部那一格的**图标现在是 `textures/shop/daily_gift`（礼盒）**，与「商城」的语义不符
> （`bag` / `task` 用的是 `textures/common/bag` / `task`）。同一排里语义最接近的现成素材是
> `textures/common/store`（商店招牌）/ `common/item_shop` —— 换不换是美术口径，改一处 `_spriteFrame` 即可。

### 3.2 页面本体（**views 形态**）

| 项 | 口径 |
|---|---|
| 资产 | `assets/resources/prefabs/ui/views/shop/View_Shop.prefab`（110 节点 / 750×1334；`npm run audit:ui --prefab … --root View_Shop` 数的就是这个数） |
| 脚本 | `assets/scripts/game/ui/views/shop/View_Shop.ts` —— 继承 **`BaseView`** + **`@uiview({prefabPath, layer: View, single: true})`**（**必须**加 `@uiview`：它归 `UIManager` 管；反过来，预制件里的内嵌小组件才用 `UIWidget` 且禁止 `@uiview`） |
| 契约 | `assets/scripts/game/ui/views/shop/ShopScope.ts` —— 事件名 + `ShopPageVM` 形状（判据的**唯一**下发口） |
| 判据 | `assets/scripts/game/ui/views/shop/ShopVM.ts` —— `buildShopPageVM()`（把存档 + 配表算成整页 VM）与 `shopFingerprint()`（页面 watcher 的订阅源） |
| 打开 | `UIManager.showUI(View_Shop)`（`View` 层，整块盖住 `Scene` 层的 `Scene_Menu`） |
| 关闭 | **页面自关**：`View_Shop.onClickBack()` → `UIManager.closeUI(View_Shop)`（进缓存、`active=false`，与 `View_TaskUI` 同口径）；进游戏/回主界面时由 `UIManager` 的场景层切换自动收掉（`closeAndCacheOverlayLayers`） |
| 互斥 | 开之前先 `closeDifficultyPanel()` + `closeHeroDetail()`（`Scene_Menu.onClickShop` 里就这两行）—— 三个都是全屏/模态，叠在一起上面那个会盖住下面那个的关闭按钮 |
| 组件里不许出现的东西 | 页面**不自己算**「还剩几次 / 能不能领」（那些是 `ShopPageVM` 的事）；**页面的 `onDestroy` 里不碰别的组件**（照 `UIComponent` 的 `offNodeEvent` 兜底） |
| 自带读数 | **必须**：金币 / 通用英雄经验（全屏页把顶栏盖住了，玩家看不到它）。⚠ **账号等级 + 经验条不再是必选项** —— 见 §3.4 的决策 |
| 事件 | 向上 `scope.emit`（`ClaimFree` / `BuyWithAd(key)` / `ClaimAdCard`）三件，**由本页自己 `scope.on`**（跨层到不了 `Scene_Menu`，见 §1；**只许一个监听方** = 一次点击被处理两次的防线） |
| 格子文案 | 每格的 `name` / `amount` / `sub` / `count` 四行**都由 VM 写**（`ShopCellVM`）：前两行来自 `mall_items.json`，`sub` 除遗物格（动态「已收集 N/M」）外也来自配表 —— 这样"格子上写的数"与"真正发的数"不可能不一致 |
| 倒计时 | 「距重置」与「免广告生效中 · 剩」由页面每秒 `tickClock()` 自己走（**不整页重算**）；免广告卡**生效↔过期**的切换才整页重画一次 |
| 广告区 = **竖直滚动列表**（2026-11 改） | 树上三层：`ad_list`（**cc.ScrollView** + Widget，只开竖向）→ `ad_list/view`（**cc.Mask** 剪裁）→ `ad_list/view/content`（**cc.Layout** GRID / `constraintNum=2` / `resizeMode=CONTAINER` / 间距 24×20，**六个格子住这儿**）。⇒ 后期加项只要往 `content` 里加节点，行数自己往下长、列表自己滚（**不必再动预制件尺寸**）。<br>· **下沿口径**：`ad_list` 的 Widget 改成四边对齐（`_alignFlags=45`：`_top=454` / **`_bottom=188`**）—— 188 正好停在免广告卡 `ad_progress` 上沿（`_bottom 20 + 高 156 = 176`）**之上 12px**，掩码就剪在这条线上，**任何行数都不会压到免广告卡**（门禁 `audit:mall` 的 J4k/J4k2 钉住这条）。<br>· ⚠ **Mask 不能和 ScrollView 挂同一个节点**：3.8.6 实测那样挂，编辑态里整棵子树被裁没（挪到 ScrollView 认的 `view` 子节点上即正常 —— 那也正是编辑器自建 ScrollView 的既定形态）。<br>· 格子的尺寸/位置**一个像素都没变**（GRID 2 列 + 间距 24/20 复现了原来手工摆的坐标），所以这一改**只改了滚动能力，不动版式**；格子内的 `name`/`amount`/`sub`/`count` 四行仍然由 VM 写。 |

### 3.3 需要补的图（3 个）· **✅ 已出图（2026-11）**

| 交付名 | 落点 | 为什么必须新出 |
|---|---|---|
| `shop_daily_gift` | `textures/shop/daily_gift` | 「每日免费补给」是页面视觉主角，现有 `common/` 里**没有礼盒/宝箱类**图形（`bag.png` 是背包、`store.png` 是商店招牌） |
| `shop_boost_ticket` | `textures/shop/boost_ticket` | 「本局增益券」是**票据**语义，现有素材里没有任何券/卡/票 |
| `ad_ticket` | `textures/common/ad_ticket` | 「局内广告券」**局内 HUD 也要用**（`RefreshButtonView` 的第三态），所以落 `common/`（与 `common/ad` 同排） |

**三张都是纯白 `#FFFFFF` 挖空的白描图（64×64 RGBA，深板岩灰承载底色键抠掉）。** 由此派生两条**施工期硬口径**（都是出图时实测出来的，不是审美）：

| 口径 | 为什么 | 怎么办 |
|---|---|---|
| **白描图只能落在有色块上** | 纯白挖空贴浅色纸面 `#EFEEED` / 白卡 = **0 对比度，等于看不见**（把交付图贴到真实底色上量过） | 商城页每一格的图形**必须先有一块青绿小方块 `#70ACB3` 承托**；HUD 同理。⚠ 提示词里曾写成 "on a **pale** tile"，已改掉 |
| **剪影必须接近方形** | 槽位是 `sizeMode=CUSTOM` + `_isTrimmedMode=true` → 引擎把 **alpha 包围盒铺满方槽**，越瘦的构图进槽被拉得越狠 | 出图时**直接命令"票身切成正方形"**（抽象的比例句一律无效，详见 `prompts.md` §2 的实测表）；后处理会打印「形变」，**> 1.15× 就回去改构图** |

**两种券怎么区分**：⚠ **不是"一竖一横"**（那是最初的设计口径，实测已被推翻 —— 方形槽会把包围盒归一，长短边在屏幕上留不下来）。真正留得到 20×20 的是**孔洞语义**：

- `shop_boost_ticket` = 方形票身（四角切平）+ **下方**略窄票根 + **斜向朝右上的实心箭头孔** + 左右短竖缝；
- `ad_ticket` = 方形票身 + **左侧**略窄票根 + **朝右的实心播放三角孔**（占票身大半个高度）+ 上下短横缝。

> ⚠ **2026-11 起「局内复活券」那一格（`cell_relife`）与背包里的 `revive_ticket` 都临时借这张 `boost_ticket` 图**
> （预制件里那一格的 `icon_tile/icon` 引的就是它）。语义上它应该是"十字/回旋"一类，但工程里没有这张图 ——
> **这是已知的美术缺口**，不是文案错：真要出图时按 `prompts.md` 的同一套口径（方形票身 + 孔洞语义）加一张
> `textures/shop/revive_ticket`，然后把 `bag_items.json` 里 `revive_ticket` 的 `icon` 与预制件那个 Sprite 一起换掉。

三者实测形变 **1.08× / 1.04× / 1.10×**，体检全绿（命令见 `prompts.md` §4.1）。出图与装机的完整口径在 `prompts.md` §2。

其余全部复用现成资产：金币 `common/gold`（**染 `c-gold #D38C1E`**）· 英雄经验 `common/exp_icon`（青绿本色，**不染**）·
账号经验 `common/player_exp` · 广告角标 `common/ad` · 加号 `common/add` · 关闭 `common/close` ·
遗物格用 `relics` 图集（`common/AtlasIcon.ts` 三级降级）· 面板底 `common/rect_rd_20` / `rect_board_rd_20`（九宫格 + 运行时染色）。

---

### 3.4 决策登记（2026-11，界面落地那一轮拍板）

这一节是**给未来的人看的**：下面五条都改过原设计稿，别再照着 prompts 的旧版"补回去"。

| # | 决策 | 原来的口径 | 现在 |
|---|---|---|---|
| 1 | **形态走 views**（`BaseView` + `@uiview`），不做 `Scene_Menu/ui_shop` 内嵌节点 | §3.2 旧版要求内嵌 `UIWidget` | 见 §1 末尾的三条理由。**改这条要同时改**：`View_Shop.ts` 的 `@uiview`、`Scene_Menu.onClickShop`、本文件 §1/§3.2 |
| 2 | **免广告卡保留**（§2.3），并从"契约外"变成契约的一部分 | prompts 只列了 F1 + A1~A6 七项 | §2.3 记了它的攒法/数值/为什么留 |
| 3 | **账号等级 + 经验条不画** | §3.2 旧版把它列为"必须的自带读数" | 顶部资源行只留**金币 / 通用英雄经验**两格（现在就是两格）。⚠ 卖出去的 A3「账号经验册」照旧，只是**这一屏不显示账号等级** |
| 4 | **两个灰态不画** | prompts 第 7 项要求画「今日已领完（明日再来）」与「广告暂不可用」 | 六格只画「今日 N/M」一种态。广告 `false` 时**不发奖也不记次数**（`AdMgr` 口径不变），由**页面自己**在底部说明行上给一行中文提示（`flashHint`，2 秒后还原），界面不做视觉态 |
| 5 | **领取成功的飘字保留** | prompts 第 10 项 | 预制件里已落节点 `reward_fly`（240×44，静置 `active=false`，`+300` fs24 `c-gold`），运行期 `View_Shop.playRewardFly(text, from?)` 往上飘 90px 并淡出。⚠ 框只有 240×44 ⇒ **一次只飘一行**（`IShopGrantResult.flyText` 取主项：金币优先），多项目靠顶部读数条对账 |
| 6 | **宿主 = 页面自己**（2026-11 落地时修正） | §1/§3.2 旧版写"宿主 = `Scene_Menu` 收页面的三个事件" | `UIScope.emit` 不跨 UIManager 的层节点（§1 已记），做不到。⇒ 页面自己 `scope.on`/`emit`，判据在 `ShopVM`、发奖在 `DataCenter`；`Scene_Menu` 只管"开"与"互斥" |
| 7 | **广告区改成竖直滚动列表**（用户口径：后期还会加项、下沿不许越过免广告卡） | 六格是手工摆的 2×3 网格，`ad_list` 只是个固定 710×580 的容器，**加第 7 项就会溢到免广告卡上** | `ad_list` = 竖直 ScrollView、Mask 在 `view`、`content` = GRID(2 列)/容器自增的 Layout；Widget 下边贴到免广告卡上沿**之上 12px**（`_bottom=188`）。⚠ **保留了两列瓦片版式**（格子的尺寸与坐标逐像素没变）—— 若将来要"一行一格的竖排列表"，改的是 `content` 的 Layout 类型（VERTICAL）+ 格子宽度，**不是**再动一次滚动结构（VERTICAL 实测会把 343 宽的格子居中，见 §3.2） |

顺带两条**实现口径**（都写进了代码注释）：
- **全屏页只留一颗实心按钮**：`免费领取` = `c-accent-action #3F9E9B` 实底；免广告卡的「领取」改成 **`rect_board_rd_20` 青绿环 + 深墨字**（环是"这里能点"的语义）。
- **返回自关**：views 形态下页面自己 `UIManager.closeUI`，宿主不接 `Close` 事件（所以 `ShopScopeEvents` 里没有 `Close`）。

---

## 4. 施工清单（✅ = 2026-11 已落地；🚧 = 还差这一条）

| # | 做什么 | 落点 | 状态 |
|---|---|---|---|
| 1 | **把"英雄经验只有一个出口"那句口径改掉** —— `HeroData.addSharedExp` 的注释写着"调用方只有一处（通关结算）"，商城是**第二个来源**（方法本身不用动，它已经是"只加不升"）；同时 `hasSharedExp` 之类的判据仍然通用 | `data/funcs/HeroData.ts`（只改注释/口径） | ✅ |
| 2 | 新增 **`ShopDataModule`**（`DataModule` 子类，存档键 `shop_data`）：`dailyKey`(YYYYMMDD) · `freeClaimedKey` · `adUsedToday` · `itemUsed`（**数组**，不是字典 —— 见文件头 ⚠） · `adCardWatched` / `adCardActiveUntil`（免广告卡）；日键对齐见 `ensurePeriod()`，日/周键口径已抽到 `common/DayKey.ts`（与 `TaskData` **同一把尺**）。⚠ **2026-11 改**：原来这里还有 `boostTickets` / `adTickets` / `outerDrawTickets` 三个券字段，**已整体搬到 `data/funcs/BagData.ts`**（见文件头那条 ⚠ 与 `docs/bag/README.md` §1） | `data/funcs/ShopData.ts`（**新建**） | ✅ |
| 3 | `DataCenter` 上的出口：`claimShopDailyGift()` · `canUseShopAd(itemKey)` · `grantShopItem(itemKey)` · `claimAdCard()`（外加 `previewShopDailyGift()`：让界面"显示的数"与"发的数"同一把尺） | `data/DataCenter.ts` | ✅ |
| 4 | `AdPlacement` 加 **6** 个：`shop_gold` / `shop_hero_exp` / `shop_acc_exp` / `shop_relic_draw` / **`shop_revive_ticket`** / `shop_ad_ticket`（局内复活位是 `'revive'`）。⚠ `shop_boost` 已随 A5 改格退役，字符串留着只为对齐历史埋点 | `platform/ad/AdMgr.ts` | ✅ |
| 5 | A4 发的是**一张抽取券**：`bagData.addItem('outer_draw_ticket', 1)` → 玩家在遗物页抽时优先扣它（`consumeItem(..., 1)`：不扣金币、**不抬价**）。⚠ 遗物抽取链路本身还没落地（`docs/meta-growth/README.md` §1）；⚠ **2026-11 起存量在 `BagData`**，不在 `ShopData` | 与 `docs/meta-growth/README.md` §1.3 同一套价格状态 | 🚧 券已在发，消费方待接 |
| 6 | 增益券入局：`Scene_Game_Stage.show()` 的开局快照 = `AchievementData.getEffects()` **＋ 券池（`bagData.consumeBoostTickets()`）＋ 等级加成 ＋ 红遗物词缀**，**全部走同一个 `cap` clamp**；券在本局开始时消耗。⚠ 券的来源现在只剩「连续登录 ≥7 天赠 1 张」（A5 已改成复活券） | `Scene_Game_Stage.ts` / `AchievementData` / `BagData` | 🚧 |
| 7 | 局内广告券：`RefreshGate` 加 `viaTicket`（判据 + `refreshButtonKey` 一起）→ `RelicShop` 两支改成"先看券" → `RefreshButtonView` 第三态 | 见 `docs/meta-growth/README.md` §3.2/§3.3 | ✅ **已落地 2026-11** |
| 8 | 顶栏三格的**读数**接数据（四个入口都已接，见 §3.1；`ernergy-001/002` 的语义要先拍板） | `Scene_Menu.ts` | 🚧 只剩读数 |
| 9 | **局外属性接进战斗**（`OuterAttributeCalculator` 现在没有运行时消费点，`HeroConfig.getAttrRows` 的注释也承认）—— 不接的话 A4 只是"图鉴进度" | `OuterAttributeCalculator.ts` + 局内属性初始化 | 🚧 |
| 10 | **免广告卡**（§2.3）：`ShopData` 加 `adCardWatched` / `adCardActiveUntil` 两个字段；`DataCenter.claimAdCard()`；**局内那两个广告位改成"先看有没有生效中的卡"**（`RelicShop` 的两支 `playAd`，与 A6 券同一处判据） | `data/funcs/ShopData.ts` + `battle/RelicShop.ts` | ✅ 卡这一侧 / 🚧 局内消费 |
| 11 | **`ShopVM.ts`**（把上面这些数据**算成一份 `ShopPageVM`**，形状在 `views/shop/ShopScope.ts` 里）+ 页面 `scope.watch(页面指纹)` 自动重刷 | `ui/views/shop/ShopVM.ts`（新建）；⚠ **不是**原先写的 `scene_menu/cmps/` —— 它已经不属于场景侧了 | ✅ |
| 12 | **商品表落地**（原先只写了"卖什么"，没定"这行数写在哪"）：`mall_items.json` **一行一商品**（`grants` / `daily_limit` / `placement` / `name` / `amount_text`）+ `battle_constants` 的 7 个 `shop*` 常量 + 门面 `MallConfig` | `tools/excel_export/` + `data/configs/MallConfig.ts` | ✅（A5 的「一张券值多少」待拍板，见 §2.2） |
| 13 | **体检**：`npm run audit:mall` —— 真跑 `ShopData` / `DataCenter` / `ShopVM` + 真配表 + 读真预制件对节点契约 | `tools/mall-audit/audit.mjs` | ✅ 171 条 |

---

## 5. 验收清单

> `[x]` = **`npm run audit:mall` 真跑过并通过**（171 条，命令在最后一行）；
> `[ ]` = 还没验（多数要真机 / 编辑器里点）。

- [x] 顶栏读数与商城页内读数**同源**（`DataCenter`）：页内两格直接读 `itemData` / `heroData`（audit I3）
- [ ] 顶栏三格的读数（🚧 还没接，见 §3.1）
- [x] 每日免费：**同一天只能领一次**；跨天（"领过的日子"变成旧的）后可再领 —— 日键比较，不是"距上次 24 小时"（audit C5/C6）
- [x] 领到的数额 = 界面显示的数额（`previewShopDailyGift` 与实发同一把尺；4 天 ×1.5 / 7 天 ×2 + 送 1 张券）（audit C7/C8/I8）
- [x] 广告商品：**每项每日次数独立**，且「今日广告总次数」不超 **14**（audit D2/D3/D4）
- [x] 广告 `false`（未接 SDK / 中途关闭）→ **不发奖、不扣次数**（audit D1/D9）；页面在顶部重置条那行给一行提示（真机点得到）
- [x] A4 给的是**一张抽取券**（不是遗物本体）：图鉴不被写脏；用一次就少一张；不用则**跨天保留**（audit D7/G3）
- [x] A6 给的券**跨天/跨局保留**（audit D8/D8b）；**局内"用券不抬次数上限"已接**（§4 第 7 条 + `docs/meta-growth/README.md` §3.1）
- [x] **A5 给的复活券也是背包道具**：与广告券/抽取券互不串账、扣得掉、日上限 2（audit D8c~D8g）；
      ⚠ 局内那一次"死亡 → 面板 → 复活"只能在真机/预览里点（代码链路见 `docs/bag/README.md` §6）
- [x] **免广告卡**：看够 84 次才能领（audit E1/E2）；领了**清零重新攒**、生效中**再领被拒**（不会叠成 48 小时）（audit E2e/E3）；过期后回到"未攒满"（audit E4）
- [ ] **免广告卡对局内的效果**（局内那两个广告位 24 小时内不再拉起广告）—— 🚧 局内消费侧还没接（§4 第 10 条）
- [x] 增益券：已达 `cap` 的效果**不参与随机**；券按"张数 × 每张值"与成就给的数值同一量纲、合计不超 `cap`
      （audit F1~F3d；⚠ 2026-11 起这一组走的是**每日补给的连续登录赠券**——商城已经没有增益券格了）
- [ ] 同一局里券、成就、等级、红遗物词缀**合计不超 cap**（要 `Scene_Game_Stage` 接上才验得了，§4 第 6 条）
- [x] 商城开着时 `ui_difficulty` / `ui_hero_detail` **都是收起的**（`onClickShop` 先关它们；`Scene_Menu` 那两行就是证据）
- [x] 存档往返：`itemUsed` / `boostTickets` 是**数组**，读档不会被 `mergeDeep` 吃掉（audit H —— 这是本项目真踩过的坑）
- [x] 颜色只出 `docs/art-style/tokens.json` 的 25 色、字号只落 6 档 →
      `node tools/ui-token-audit/audit.mjs --prefab assets/resources/prefabs/ui/views/shop/View_Shop.prefab --root View_Shop`（249 条通过）
- [x] 金币数字用 `c-gold #D38C1E`；经验用青绿本色（**不要**把金币图标染青绿 —— 历史上"两态色把金币图标染了"当过 bug 记）
- [x] **全屏页只有一颗实心按钮**（「免费领取」）；免广告卡的「领取」是青绿环 + 深墨字（§3.4）
- [x] 领取成功**往上飘一下**（`reward_fly`），不弹二级确认框；连点两次不会叠出两层飘字（`stopRewardFly` 先停再播）
- [ ] **两种券的图标摆在一起不会认错**（`shop_boost_ticket` 斜箭头孔 + 下方票根 / `ad_ticket` 播放三角孔 + 左侧票根）——
      ⚠ 别用"一竖一横"当判据（方形槽会把包围盒归一，长短边留不下来，见 §3.3）；这一条要**肉眼看**
- [ ] 三张白描图**都落在有色块上**（青绿 `#70ACB3` 等），没有一张贴在浅色纸面/白卡上（贴上去等于看不见，见 §3.3）
- [x] 界面契约与预制件一致：六格节点名 / 每格的 `name`·`amount`·`count` 标签 / `resolveRefs` 里 20 条路径 /
      底部页签与顶栏三个入口路径**都在真预制件里存在**（audit J1~J7 —— 改预制件或改配表 key 时这条会当场爆）
- [x] 广告区是**竖直滚动列表**且**下沿不压免广告卡**：`ad_list` 挂 ScrollView（只竖向）、Mask 在 `view` 上、
      `content` 是容器自增的 GRID；`ad_list` 的 Widget 下边贴到免广告卡上沿之上（audit J4d~J4k2）
- [ ] **真机上拖一下这个列表**（六格时内容比视区矮、拖是弹性回弹；**加到 4 行以上**才真滚得起来）——
      编辑器里只能用"临时多塞两格看有没有被裁在卡上方"来间接验（本轮就是这么验的）

```bash
cd tools/excel_export && npm run audit:mall     # 131 条；任何一条不过 → 退出码 1
```
