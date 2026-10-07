# 局外背包（全屏页）· 设计契约

> **本文是「局外背包」的口径真源**（2026-11 落地）。预制件 `prefabs/ui/views/bag/View_Bag.prefab`
> 由美术/AI 出图**先做好的**，本文记录的是**把它接进工程时定的那套规则**：装什么、一件道具长什么样、
> 存量存在哪、容量怎么算、哪三处是只读的。
>
> 体检：`npm run audit:bag`（**144 条**，真跑 `BagData` / `BagConfig` / `BagVM` + 真配表 + 真预制件契约）。

---

## 0. 一句话

**背包 = 玩家「持有」的可堆叠道具的一览**：一格一种道具（图标 + 数量 + 可选倒计时），
点一格看详情；**格子恒画满 80 个**（没道具的那些是空槽，见 §3.6）；
道具**长什么样**由配表 `bag_items.json` 说了算，**有几件**由存档模块
`data/funcs/BagData.ts` 说了算。**这一屏没有任何发奖 / 扣费**。

```
主界面底部「背包」页签（Scene_Menu.onClickBag）
  └─ UIManager.showUI(View_Bag)                    ← views 形态的全屏页，返回自关
       ├─ BagVM.buildBagPageVM(选中谁)              ← 判据唯一落点：铺哪几格（含空槽）/ 详情写什么 / 容量多少
       │    ├─ BagConfig  ← tb/bag_items.json       ← 「这件道具是什么」（名字/图标/品质/堆叠上限）
       │    ├─ BagData    ← 存档 bag_data            ← 「玩家有几件」（items 数组）
       │    └─ ItemData / HeroData                  ← 顶栏那两条读数
       └─ View_Bag.applyPage(vm)                    ← 照着画，不自己算
  产出源：商城 A4/A5/A6（`DataCenter.grantMallLines`）→ `BagData.addItem`
```

---

## 1. 为什么券要"搬家"（2026-11 最重要的一条）

三类券 / 次数原来存在 `ShopData`（商城存档）里：

| 道具 | 原来（`ShopData`） | 现在（`BagData`） |
|---|---|---|
| 局内广告券（商城 A6） | `adTickets` | `getCount('ad_ticket')` |
| 局外遗物抽取券（商城 A4） | `outerDrawTickets` | `getCount('outer_draw_ticket')` |
| **局内复活券（商城 A5）** | （原本没有这件东西） | `getCount('revive_ticket')` |
| 本局增益券（连续登录 ≥7 天赠） | `boostTickets[]`（按效果 code） | `getCount('boost_<effect_code>')` |

**它们本来就不是"商城的记账"**。商城的记账是"今天看没看过这一格 / 累计看了多少次 / 免广告卡到几号"；
而券是**玩家背包里的东西**。以前没有背包界面，这个区别看不出来；
一旦有了背包，就会长出「**商城说有 2 张、背包说你有 0 张**」这种两处各存一份的经典事故。

所以：**存量搬到 `BagData`，`ShopData` 只留它自己的日计数与免广告卡**。
`ShopData` 上那 10 个券相关方法（`getAdTickets` / `addBoostTicket` / `consumeOuterDrawTicket` …）
**已整体删除**，别再去那里找。

> ⚠ **旧存档里那三个字段会被丢弃**（它们已不在 `IShopData` 的 schema 里，而 `DataModule.mergeDeep`
> 只合并「默认数据里已经存在的 key」）。开发期可接受 —— 重看一次广告就回来了。
> 真要保住就得写一次性迁移（读 `shop_data` 原始串 → 转存 `bag_data`），本轮没做。

### 1.1 三种券的**消费点**（2026-11 口径：**用的地方一律"检查背包"**）

券不做第二份记账，所以每个消费点就是一句 `bagData.has/consumeItem`：

| 券 | 消费点（唯一） | 怎么判 | 落地 |
|---|---|---|---|
| `ad_ticket` 局内广告券 | 局内肉鸽商店的**两个广告位**：`RelicShop.refresh()`（免看广告刷新）与 `RelicShop.pick(id, viaAd=true)`（免看广告补选） | 形状进 `RefreshGate.viaTicket`（**判据的唯一真源**，三个面板共用），`RelicShop.tryUseAdTicket()` 真扣；扣不动就退回"看广告" | ✅ 2026-11 |
| `revive_ticket` 局内复活券 | **英雄被打死那一刻**：`Scene_Game_Stage.onLethalForHero()`（在 `OnTakeDamage` 里，早于死亡检查） | 有券就弹复活面板（另一颗按钮是"看广告复活"，每局 `battle_constants.reviveAdPerRun` 次）；两颗都没有 → **不弹面板**，照旧判负 | ✅ 2026-11（见 §6） |
| `outer_draw_ticket` 局外遗物抽取券 | 局外遗物**抽取链路**：`DataCenter.drawOuterRelic(count)`（图鉴页「抽 取」/ 十连，见 `docs/meta-growth/README.md` §1.6） | 判据在 `OuterRelicDraw.plan()`（**唯一的付费方案**）：**券优先于金币**，用券抽**不扣金币、也不抬当日价格阶梯**（`EquipmentCollection.drawPaidCount` 只随金币抽前进）；券不够才轮到金币 | ✅ 2026-11（`npm run audit:draw` 的 C/D 段钉住） |

> 口径：**券跨局/跨天累积，但局内配额不受影响** —— 用广告券时局内那一次免费额度照扣
> （`RelicShop.roll(true)` 仍 `adFreeUsed++`），所以"攒一周券 = 一局白拿十几次"不会发生
> （见 `docs/meta-growth/README.md` §3.1）。复活券没有局内配额，它的次数上限**就是背包存量**
> （玩家自己买来的东西，再套一层局内配额等于把券作废）。

---

## 2. 分层与"谁是宿主"

| 层 | 落点 | 职责 |
|---|---|---|
| 配表 | `tb/bag_items.json`（编辑源 `excel/bag_items.xlsx`） | 一件道具一行：名字 / 图标 / 品质 / 堆叠上限 / 描述 / 能不能用 |
| 门面 | `data/configs/BagConfig.ts` | **唯一读口**：`getSortedItems` / `getItem` / `boostItemKey` / `getStackMax` / `getSlotCapacity` |
| 存档 | `data/funcs/BagData.ts`（键 `bag_data`） | **存量与规则的唯一真源**：加 / 扣 / 堆叠上限 / 有效期 / 清过期 |
| 判据 | `ui/views/bag/BagVM.ts` | `buildBagPageVM(选中谁)` 一次算好整页 VM；`bagFingerprint()` 给 watcher |
| 契约 | `ui/views/bag/BagScope.ts` | VM 形状 + 事件名 + 格子节点契约 `BAG_CELL_NODE` + **空位色 `BAG_EMPTY_FRAME`** / **占位文案 `BAG_NO_SELECTION_TEXT`** |
| 页面 | `ui/views/bag/View_Bag.ts` + `BagItem.ts` | 只渲染 + 上报；**页面自己就是宿主** |
| 入口 | `scene_menu/Scene_Menu.ts` → `onClickBag()` | 只管"开"与"与另三个界面互斥" |

**⚠ 为什么宿主不是 `Scene_Menu`**：`UIScope.emit` 只沿 `node.parent` 向上冒泡，而 `views` 层与 `scenes` 层
是 UIManager 下的**兄弟节点**（见 `platform/ui/UIScope.ts` 规则 1），页面的事件到不了 `Scene_Menu`。
所以实际形态与 `View_Shop` / `View_TaskUI` 逐字一致：**页面自己 `scope.on` 自己 `emit` 的事件**
（格子发 `bag:selectItem` → 页面换选中 → 重画）。保留这个事件名是为了**留一条缝**：
哪天要把流程搬出去（例如换成纯 TS 的功能类），只改 `View_Bag` 里那一处监听，界面代码不动。

**互斥**：`views` 层的三个全屏页（背包 / 商城 / 任务）**同层不会自动互斥** ——
`UIManager` 只在**切到场景层**时才关掉别的层的 UI。所以「开之前先把兄弟收掉」这件事只能由宿主做：
`Scene_Menu.closeViewPages(except)`。同时它与两个**场景内嵌弹窗**（`ui_difficulty` / `ui_hero_detail`）
也不同时可见（那对是 `active` 显隐，由 `closeDifficultyPanel` / `closeHeroDetail` 收）。
不互斥的后果很具体：**上面那个全屏页会把下面那个的返回键盖住，玩家就回不去了**。

---

## 3. 装什么 · 一件道具长什么样

### 3.1 表结构（`bag_items.json`）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | int | 道具 id（1001 起） |
| `key` | string | **唯一标识 = 代码与存档之间的契约**：`ad_ticket` / `outer_draw_ticket` / `boost_<effect_code>` |
| `name` | string | 道具名（详情面板第一行） |
| `desc` | string | 一句话说明（详情面板正文**第一行**） |
| `use_hint` | string | 「为什么不能手动用 / 怎么生效」（正文**第二行**；`effect_code` 非空的行会被效果文案顶掉） |
| `icon` | string | 图标路径（resources 相对、**不带扩展名**；留空 = 保留预制件占位图） |
| `rarity` | enum | 品质四档 —— **只决定格子底框色**（色值真源 `common/RelicRarityColor.ts`） |
| `stack_max` | int | 单格堆叠上限（**0 = 不限**） |
| `usable` / `sellable` | bool | 能不能手动用 / 能不能卖（**本期全 0**，见 §5） |
| `sell_price` | int | 出售单价（`sellable = 0` 时无意义） |
| `expire_hours` | number | 有效期（小时；**0 = 永久** → 格子不显示倒计时） |
| `effect_code` | enum | **增益券专用**：这张券对应哪条成就效果（10 选 1） |
| `sort` | int | 排序（决定格子的先后） |

> ⚠ **没有 `category`（分类）列**：本轮界面没有页签 / 分组，加了就是一个**没有消费方**的字段
> （工程里那类"配了但没人读"的列已经吃过一次亏）。真要做分类页签时再加，那时它才有意义。

### 3.2 当前 13 行

| key | 名字 | 品质 | 产出源 |
|---|---|---|---|
| `ad_ticket` | 局内广告券 | 蓝 | 商城 A6（看广告，每天 2 张） |
| `outer_draw_ticket` | 局外遗物抽取券 | 紫 | 商城 A4（看广告，每天 2 张） |
| `revive_ticket` | 局内复活券 | 紫 | 商城 A5（看广告，每天 2 张）—— 局内死亡时消费，见 §1.1 / §6 |
| `boost_run_start_gold` … `boost_relic_start_gift` | 10 张「XX 券」 | 蓝 | 连续登录第 7 天赠 1 张（⚠ 商城 A5 那一格 2026-11 改成了复活券） |

增益券**按效果分格存**（不是"所有增益券堆一格"）：因为一张券的**效果在发放那一刻就定了**
（`DataCenter.rollBoostCode` 随机一条），合并成一个数之后，入局时就没法还原"手里分别是哪几张"了。
`key` 由 `BagConfig.boostItemKey(code)` 拼（`boost_<code>`），**全工程只在这一处拼这个字符串**。

> ⚠ `revive_ticket` 的 `icon` 现在**借的是 `textures/shop/boost_ticket`**（与商城那一格的图一致）——
> 工程里没有"复活"语义的券图，这是已知美术缺口（见 `docs/shop/README.md` §3.3 末注）。

### 3.3 ⚠ 文案宽度是**硬约束**（这一条最容易踩）

两种"框吃文案"的方式，**编辑器里都看不出来**：

| 框 | 溢出模式 | 超了会怎样 |
|---|---|---|
| `name`（200×38 / fs24） | `CLAMP` | **直接吃字**（静默截断） |
| `desc`（200 宽 / fs16 / lh24） | `RESIZE_HEIGHT` | 不裁字，但**一行行折下去长高** → 把下面的「使用 / 出售」往下推，推多了就**点不到按钮** |
| `count` / `cap_value` / 按钮 label | `CLAMP` | 直接吃字 |

所以：
- `name` ≤ 8 个汉字（**硬红线**，CLAMP）；`desc` / `use_hint` / 效果文案 **各 ≤ 12 个汉字**
  （设计口径就是"每行一句话、正文两行"；`desc` 那一行折了会把第二行挤走）；
- **正文总高**还必须放得进面板：面板高 1038，固定部分（图标 176 + 名字 38 + 两个按钮 112 +
  排版间距 90 + 上留白 10）约 416 ⇒ 正文最多约 **622px ≈ 25 行**；
- 这一条**不是靠自觉**：`audit:bag` 的 **B 段**把框尺寸**从预制件现读**（不是手抄"200×64"），
  按框宽逐行估算（全角 1×字号、半角 0.6×字号，故意偏保守）—— B1 拦裁字、B2~B4 拦折行、
  **B8 拦"正文长得把按钮顶出面板"**、B8b/B8c 顺带钉住"哪个框是哪种溢出模式"。

> ⚠ 2026-11 用户改版前 `desc` 是 `CLAMP`，那时的口径是"只放得下两行、第三行开始看不见"。
> 改成 `RESIZE_HEIGHT` 之后**失败方式变了**（从"吃字"变成"顶掉按钮"），
> 上面那张表就是这次重新推的口径 —— 改框之前先看这一段。

### 3.4 容量（**先定死 80**）

- **一格 = 一种道具**（不是一件）⇒ 底栏「容量 N/80」的分子 = **有存量的种类数**（`BagData.getUsedSlots()`）。
- `80` 写死在 `BagConfig.BAG_SLOT_CAPACITY`（2026-11 拍板"先定死"）。
  **为什么不进配表**：这一轮它没有第二档取值（不做扩容）—— 放表里只是把常量搬了个家。
  真要做"消耗钻石抬上限 / 分档上限"时再挪进 `battle_constants`，那时它才是一份**会变的数据**。
- ⚠ 预制件里那句「56/120」是**样例文案**，运行期一律被覆盖 —— 别去看它推容量。
- 「扩容」按钮（`bottom_bar/btn_expand`）**保持预制件的收起态**：本轮没有第二档容量，露出来就是骗人。
- 配表里已经删过行的 key（"孤儿"）**不占格子也不占容量**，但存量留在存档里不静默删
  （`BagData.getOrphanKeys()` → `BagVM` 给一条 warn）。

### 3.5 倒计时（`expire_hours`）

当前 12 行全是 `0`（永久）⇒ 格子上的 `timer` 那块**恒为收起**。
但路径是通的、也必须通（格子已经把它画出来了）：
- 有效期**在入库那一刻**算成时间戳存进 `BagItemRecord.expireAt`（之后再改配表不影响手里已有的，与"券跨局累积"同一口径）；
- `BagData.pruneExpired()` 清过期（调用点：`View_Bag.show()` 与每秒的 `tickClock()`）——
  ⚠ **`BagVM` 是纯读的、不在里面清**：`buildBagPageVM` 会被 watcher 回调间接调用，而"在 watcher 里写数据"
  是这套响应式里最容易出事的写法（见 `ShopVM.shopFingerprint` 的注释）；
- 清掉一件会改 `bagFingerprint` → watcher 自己 `refresh()` → **那一格随之消失**（不需要页面手动重刷）；
- 每秒的刷新只重写那一行文字（`BagItem.tickTimer`），**不重建整页 VM**（重建会牵连图标与全部格子）；
- ⚠ 格子下的倒计时秒数**只做过实现与数据层验证，界面上的走字没有真机确认**，见 §8。

### 3.6 格子恒画满 80 个（**空槽**）

> 用户口径（2026-11）：**"把背包格子也画出来，即使没有道具，也能看到格子，定死 80 个。"**

- **铺几格是判据**：`BagVM.buildBagPageVM` 先把有货的按配表 `sort` 排好，再**补空槽补到 `cap`**，
  所以 `BagPageVM.cells.length` **恒 ≥ 80** —— 界面**不自己补格子**（`View_Bag.ts` 里连
  `BAG_SLOT_CAPACITY` 都不许出现，`audit:bag` 的 **F15** 盯这条）。
- **有货的排在前面、空槽在后面**，空槽不许插在中间（E9c）—— "第 N 格"因此仍然稳定可预测。
- **空槽长什么样**（`BagItem.setInfo` 按 `vm.empty` 分派，两种形态在**同一处**分派）：
  只画一格灰底 `#D8D8D8`（= `c-ink-200`，同一档也用在进度条轨道 / 侧栏底，
  tokens 里另名 `c-surface-sunken`），**图标 / 数量 / 倒计时 / 选中环全部收起**，**点了也不冒泡**。
- 三条不能踩的：
  ① **不许用品质色**（连白档 `quality.common #DDDDDD` 也不行）—— 空槽没有品质。
  白档格子的底框恰好也是 `#DDDDDD`，与空槽只差 5 个灰阶、肉眼分不出，**两者靠"有没有图标"区分**
  （`audit:bag` F13c 拦"拿品质色当空槽色"）；
  ② 颜色是**运行期写**的，`npm run audit:ui` 扫预制件扫不到 → 由 `audit:bag` 的 F13/F13b
  对 `docs/art-style/tokens.json` 兜一条（值必须来自色板）；
  ③ 空槽是**实心灰**而不是描边/虚线：这一格只有一张贴图（`rect_rd_20` 白圆角九宫格），
  工程里唯一的描边图 `rect_board_*` 是**烤进去的青绿**，乘上灰会发脏（同 `View_Bag.SELL_ON_TEXT`）。
- **代价与边界**：首屏会 `instantiate` 到 80 个格子（一次，`View_Bag.init`），空槽不加载图标
  （`BagItem` 直接跳过 `AtlasIcon`）；`content` 的 GRID Layout（4 列 / 98×116 / 间距 15×25 /
  resizeMode = CONTAINER）把高度算到 ~2805px，ScrollView 里滚动。
- **空背包 = 80 个空槽 + "未选中"占位面板**（不是空屏，也不是"显示一件不存在的道具"）：
  "选中"只可能落在**有货的格子**上（空槽 key 是空串，若在整片 `cells` 里按 key 回落会命中第一个空槽 ——
  E5a 专门钉这条）；一件都没选中时详情面板画占位态，见 §3.7。

### 3.7 「未选中」占位态（2026-11）

> 用户口径：**"如果未选中，`item_detail` 也要显示，只是 icon 不显示，背景颜色和背包 cell 无道具时一样，
> 名字显示未选中，其他不显示。"**

一件都没选中时（空背包，或选中的那一件刚被用光、还没回落），详情面板**不再整块收起**，而是画"空位"：

| 部件 | 未选中时 | 选中时 |
|---|---|---|
| `item_detail`（面板本身） | **恒显示** | 恒显示 |
| `content/icon_tile`（底框） | `BAG_EMPTY_FRAME`（`#D8D8D8`，**与格子空槽同一个常量**） | 品质色 `rarityColor(rarity)` |
| `content/icon_tile/icon` | **收起** | 配表图标（三级降级加载） |
| `content/name` | `BAG_NO_SELECTION_TEXT`（「未选中」） | 道具名 |
| `content/desc` · `btn_use` · `btn_sell` | **全部收起** | 正文两行 + 两个按钮 |

三条口径：
- **两态由 `vm.detail.empty` 一处分派**（与格子的 `vm.empty` 同形，落点在 `View_Bag.applyDetail`）——
  "画什么"仍然是判据层（`BagVM`）的决定，界面不自己判断；
- **占位文案只有一个落点**：`BagScope.BAG_NO_SELECTION_TEXT`（界面与 VM 都不许再写字面量，`audit:bag` F17e 盯）；
- **空位色只有一个落点**：`BagScope.BAG_EMPTY_FRAME`（空槽与占位态共用 —— 两处讲的都是"这儿本来该有东西"，
  各写一个灰迟早会调成两种不同的"空"）。

**为什么不再整块收起**：这一屏左边是一列格子、右边是面板，面板整块消失后右半边就只剩一片空白，
而左边还站着 80 个格子（空背包也铺满，见 §3.6）—— 玩家看到的会是"面板没加载出来"，而不是"背包是空的"。

> ⚠ **现在什么时候能看到它**：选中是"传空 / 传一个已经不在背包里的 key 就**自动回落到第一格**"的
> （`buildBagPageVM` 的选中回落，见 §8），所以**有货的背包一打开就已经选中了第一件** ——
> 占位态实际只在**空背包**（新号、或券全用光）时出现。
> 要改成"打开背包先不选、必须点一下才选"，只需去掉 `BagVM` 里那一行回落（`?? filled[0]`）——
> 那是个产品口径的选择，不是实现问题，改之前先确认。

---

## 4. 数据层（`BagData`）

存档键 `bag_data`，形状 **`{ items: [{ key, count, expireAt }] }`** —— `items` 是**数组**。

> ⚠ **为什么是数组而不是 `{key: count}` 字典**：`DataModule` 的深度合并只认「默认数据里已经存在的 key」
> （`mergeDeep` 里 `if (!(key in target)) continue`），动态字典在默认数据里是空对象 ⇒ **读档时整片丢掉**。
> 数组走"整片覆盖"，所以能读档 —— 与 `TaskData.records` / `ShopData.itemUsed` 同一口径。`audit:bag` C 段专门验它。

三条规则：
- **`addItem` 不静默吞**：超 `stack_max` 的部分丢掉并 `console.warn`（"看起来发了、其实没进包"是最难查的一类 bug）。
- **扣到 0 整条删掉**：留着 `count: 0` 的记录 = 存档里永远清不掉的垃圾。
- **`getOwnedKeys()` 是纯读**（不清理过期）：它会被 watcher 的指纹间接调用，而"在 watcher 里写数据"
  是这套响应式里最容易出事的写法（`ShopVM.shopFingerprint` 的注释里记过这个坑）。

---

## 5. 本期**只读**的三处（以及将来怎么接）

用户口径：**"本期只读：按钮按「能不能用」的判据置灰并给一行中文说明；容量 = 已持有份数/配表上限；扩容按钮先隐藏。"**

| 位置 | 本期 | 为什么 | 将来接的时候落在哪 |
|---|---|---|---|
| 「使用」 | 置灰（`usable` 全 0），文案「不可使用」 | 这些道具都是**入局 / 抽取时自动抵扣**的，手动"使用"没有意义 | 判据进 `BagVM`、副作用进 `DataCenter`（新增 `useBagItem`），`View_Bag.onClickUse` 那一处转过去 |
| 「出售」 | 置灰（`sellable` 全 0），文案「不可出售」 | 开一个**金币回收口**会与「金币是抽取燃料」的既有经济（`docs/meta-growth/README.md` §1.3，集齐 37 件 ≈ 25 万金币）直接打架 | 同上（`sellBagItem`）；回收价必须重新配平，不能拍脑袋 |
| 「扩容」 | 保持预制件的 `active = false` | 本轮没有第二档容量（见 §3.4） | 先定"上限从哪来"（配表常量 / 消耗品 / 等级解锁），再把按钮打开 |

**"为什么是灰的"要看得见**：两个按钮置灰的同时，详情面板**第二行**回答原因
（如「遗物页抽取时抵扣」）。界面上**不许**出现"点不动又不说为什么"的按钮 ——
这也是 `audit:bag` E7 盯的那条。

⚠ 两个 `onClickUse` / `onClickSell` **留着**并会 `ezgame.warn` 一声：
表里那一列真被谁改成 `1` 的时候，玩家至少能在控制台看到"这里还没接线"，而不是安静地什么都不发生。

---

## 6. 节点契约

### `View_Bag.prefab`（页面本体，750×1334）

```
View_Bag                (Widget + BlockInputEvents)
  top_bar               btn_back / title「背包」/ res_bar/chip_gold/value · chip_exp/value
  bottom_bar            cap_title「容量」/ cap_value「N/80」/ pbar/fill（锚点在左，按比例改宽）
                        btn_expand（**本轮恒为 active=false**）
  scroll/view/content   (ScrollView + Mask；Layout = GRID 4 列 / 98×116 / 间距 15×25)
                        └─ 一个 Bag_Cell 实例 = **模板，它自己就是第 1 格**（运行时克隆到 80 格，见 §3.6）
  item_detail           (白底 + ScrollView + Widget，**恒显示**)
    content             (Layout = VERTICAL / spacingY 20 / paddingTop 10 —— 两态里会有节点藏起来，
                         位置一律由它排，**不许手摆坐标**)
      icon_tile         底框（选中 = 品质色 / 未选中 = BAG_EMPTY_FRAME，见 §3.7）
        icon            道具图标（未选中时整个收起）
      name              道具名（未选中时写「未选中」）
      desc              正文两行（RESIZE_HEIGHT：写几行长多高，见 §3.3）
      btn_use           label
      btn_sell          bg · ring · label
```

**代码要什么 = 预制件有什么**：`View_Bag.resolveRefs()` 里 `at('...')` 的路径与预制件逐条对表
（`audit:bag` 的 F4 / **F16b** / **F16c**）。

> ⚠ **2026-11 预制件改版（用户给 `item_detail` 加了一层 `content` 容器 + ScrollView）之后踩到的两件事**，
> 都是"编辑器里看着对、跑起来不对"的类型，记在这里免得再犯：
> 1. **`resolveRefs` 的 `??` 兜底拦不住"拖错了"**：`??` 只认"没拖"，拖到一个**存在的**错误节点上照样用。
>    那次 `detailNode` 指到了 `item_detail/content`（面板的**子节点**，不是面板）——
>    而老代码里 `detailNode.active = ...` 会把**面板内容**藏掉，看起来就像"面板没显示"。
>    现在：面板恒显示、不再切它的 `active`（F17），并且 **F16b 把 15 个拖的引用逐条对着路径核**。
> 2. 顺带抓到一条**早就错了**的：`capFillNode` 指着 `bottom_bar/pbar`（**轨道**），而不是 `pbar/fill`（填充条）——
>    后果是"容量条改的是轨道的宽度、填充条纹丝不动"，界面上只是"看着怪"，没人会去查。
>    已改指 `pbar/fill`（与 `View_Shop` 的 `ad_progress/pbar_bg/pbar_fill` 同一处置）。
>
> 📌 **预制件侧还留了两条建议（这轮没动预制件，留给你在编辑器里决定）**：
> ① `content` 的 Layout **`resizeMode` 是 `NONE`**（容器高恒 100，不跟内容长）——
>    ScrollView 因此算不出真实内容高、拖动没有边界；正文写长了**看不到滚动条也不会滚**。
>    若这个 ScrollView 是为了"正文长了能滚"，把 `resizeMode` 改成 **`CONTAINER`** 才成立；
> ② 面板那个 ScrollView 现在是 `horizontal = true` + `vertical = true` ⇒ **在面板上左右拖也能把文字拖走**。
>    详情面板不需要横向滚动，改成 `horizontal = false` 更稳。

### `cmps/Bag_Cell.prefab`（一格）

```
Bag_Cell   根节点的 Sprite = **底框**（有货时染品质色、空槽时染 `#D8D8D8`，见 §3.6）
  ring     选中环（`active` 切显隐；**不染色** —— 烤进贴图的青绿，乘上去会发脏；空槽恒不画）
  icon     `bag_items.icon`（走共享三级降级 `AtlasIcon`；空槽整块收起、连加载都跳过）
  count    「×N」（**N ≥ 2 才显示**；`×1` 是噪声；空槽恒不显示）
  timer    （可选）倒计时药丸，> 0 才显示
    label
```

两处**配色口径**（与工程其它界面一致，别另发明一套）：
- 品质色**只有两个落点**：格子的底框、详情面板的 `icon_tile`；
  图标与文字一律保持墨色 —— 白档 `#DDDDDD` 染到文字上在纸面底上根本读不出来（同 `OuterRelicItem`）。
  **未选中**时 `icon_tile` 不染品质色，走 `BAG_EMPTY_FRAME`（见 §3.7）。
- 「使用」按钮底是**可染的白圆角九宫格**：可用 `c-accent-action #3F9E9B` / 不可用 `c-disabled-pill #B9C1C1`。
  「出售」的视觉主体是**烤色的环**（`rect_board_rd_10`）⇒ **"不可卖"只回答在字色上**
  （`c-accent-action` → `c-ink-400`），与商城免广告卡同一处置。
  容量数字满格时转 `c-warn #C0392B`。

---

## 7. 施工清单

| # | 做什么 | 状态 |
|---|---|---|
| 1 | `bag_items` 表（schema + xlsx + JSON + 容器 `Tb_BagItemConfig` + 门面 `BagConfig`） | ✅ |
| 2 | `BagData` 存档模块（存量 / 堆叠上限 / 有效期 / 清过期） | ✅ |
| 3 | 券搬家：`ShopData` 的 10 个方法删除，存量与商城发奖改道 `bag_data` | ✅ |
| 4 | views 流程：`BagScope` / `BagVM` / `BagItem` / `View_Bag` | ✅ |
| 5 | 入口与互斥：`Scene_Menu.onClickBag` + `closeViewPages` | ✅ |
| 6 | 体检 `npm run audit:bag`（115 条 → 127 条） | ✅ |
| 7 | 真机确认：倒计时走字、GRID 4 列在不同分辨率下的重排、长按/连点手感 | 🚧 |
| 8 | 「遗物抽取次数」的**消费口**（局外抽取链路） | ✅ 2026-11：`DataCenter.drawOuterRelic` —— 券优先于金币、用券不抬当日价格阶梯；判据与体检见 `docs/meta-growth/README.md` §1.6 / `npm run audit:draw` |
| 9 | 「使用 / 出售 / 扩容」三处（见 §5） | 🚧 本期只读 |
| 10 | **格子恒画满 80 个（空槽）**：`BagVM` 补槽 + `BagItem` 空槽分支 + `BagScope.empty`；体检 +12 条（E1/E1a/E3a/E5a/E9c/E9d/F13~F15） | ✅ |
| 11 | 顺手把两个预制件的 **9 条 P3（Label 行距）历史违规**收敛掉（`View_Bag` 8 + `Bag_Cell` 1） | ✅ |
| 12 | **详情面板改版（用户 2026-11 加 `content` 容器）后的重新绑定 + "未选中"占位态**：`BagScope` 两个常量 + `BagDetailVM.empty` + `BagVM.makeEmptyDetailVM` + `View_Bag.applyDetail` 两态；预制件修 2 个拖错的引用（`detailNode` / `capFillNode`）；B 段改成**从预制件现读框尺寸**；体检 +17 条（B0/B8/B8b/B8c · E1b2 · F16/F16b/F16c · F17~F17e · F18~F18d）+ 2 条旧断言改口径 | ✅ |

---

## 8. 验收清单

跑 `npm run audit:bag`（144 条）覆盖 A~G 段；下面是**人眼要确认**的部分：

**能自动验的（已在 audit 里）**
- [x] 空背包：**80 个空槽**（不是 0 格）、**详情面板照样显示且是"未选中"占位态**、容量 0/80
- [x] 有货的格子排在空槽**前面**、恒 80 格；空槽的 key 是空串 / 占位字段干净 / 一个都没被选中
- [x] 选中回落**不许落到空槽上**；有 2 件时按配表 `sort` 升序铺两格，默认选中第一格
- [x] 选中的那一格被用光 → **自动回落到第一格**（不许显示一件"玩家已经没有"的道具）
- [x] 堆叠上限截断且**不静默**；扣到 0 整条删掉；孤儿 key 不占格子与容量
- [x] 过期：`expire_hours = 1` → `expireAt ≈ now + 1h` → `pruneExpired()` 清掉
- [x] 商城的 A4 / A5 / A6 三种奖励真的落进背包，且券跨天保留
- [x] 详情正文恰好两行、按钮置灰、增益券第二行带具体数值
- [x] 页面指纹随存量与金币变化；**且指纹没有副作用**
- [x] 预制件节点契约 / 三个全屏页的互斥表 / `bagBtn` 真拖到了 `bottom/left/bag`
- [x] 空槽底色来自 tokens 色板、**不是**品质色；空槽分支收起图标/数量/环、点了不冒泡；
      `View_Bag` 里没有 `BAG_SLOT_CAPACITY`（铺格子只归判据层）
- [x] **未选中占位态**：`detail.empty` 为真、名字是「未选中」、其余字段是干净占位值；
      界面不切面板 `active`、不把文案写死、底框走 `BAG_EMPTY_FRAME`（F17~F17e）
- [x] **预制件上拖的 15 个引用逐条对着路径核**（F16b）+ 兜底路径与期望表一致（F16c）——
      这两条抓的正是"拖错了但 `??` 兜底不报错"
- [x] 文案宽度这一段**从预制件现读框尺寸**（B0），并区分 CLAMP（裁字）与 RESIZE_HEIGHT（顶掉按钮）
- [x] `npm run audit:ui`：`View_Bag` 57/57、`Bag_Cell` 14/14（色/字号/行距/内置贴图四项全绿）

**必须真机看的（`[~]` = 本次**没有**验证，别当已通过）**
- [~] 底栏「容量 N/80」与进度条在不同分辨率下的观感；进度条满格时的颜色
  （⚠ 顺带确认：容量条动的是**填充条**、轨道不动 —— `capFillNode` 这轮才从轨道改回填充条）
- [~] 80 格的**滚动**手感（20 行 × 141px ≈ 2805px 内容高）、滑到一半时松手会不会误选中一格
- [~] 空槽的灰（`#D8D8D8`）在真机屏幕上的观感：与白档格子的 `#DDDDDD` 靠图标区分够不够清楚
- [~] 长道具名 / 长描述的**实际**排版情况（B 段是估算不是像素级排版；`desc` 现在是 RESIZE_HEIGHT，
      要专看"正文变长之后两个按钮有没有跟着让位"）
- [~] 倒计时药丸的走字（当前没有任何道具用到它）
- [~] 两个置灰按钮点击时**确实没有反馈**（`interactable = false` 的引擎行为）
- [~] 从商城回主界面再进背包，格子里领到的券是不是立刻在（响应式 + 缓存视图复用）
- [~] **未选中 → 选中 → 再回到未选中**（把最后一件用光 / 换号）时面板的**两态切换是否干净**：
      `icon` 有没有残留上一件的图、正文/按钮有没有收起来、底框灰 ↔ 品质色切得对不对
- [~] 详情面板那个 ScrollView 的**拖动边界**（见 §6 的两条建议：`resizeMode` 现在是 NONE，
      在面板上左右拖也拖得动）

---

## 9. 决策登记（2026-11，落地那一轮拍板）

| 问题 | 定案 | 理由 |
|---|---|---|
| 背包里装什么 | **新建通用道具表 + `BagData`**（用户选的 C 方案） | 不要把它写死成"只装遗物"；道具定义必须能加一行就多一件 |
| 遗物进不进背包 | **不进** | 遗物有自己的表（`relics`）与页面（左侧「遗物」页），两处都放会变成两套"持有"口径 |
| 「使用 / 出售 / 容量 / 扩容」 | **本期只读**（用户选的 A 方案）+ 容量**先定死 80** | 先把 views 流程与真数据跑通，不引入任何新经济口径 |
| 券的存量 | **搬进 `BagData`**（不是"两处各存一份"） | 见 §1 |
| 旧存档的三个券字段 | **丢弃**，不写迁移 | 开发期；重看一次广告就回来了 |
| 分类列 | **不加** | 没有消费方的字段就是下次改表时的坑（见 §3.1） |
| 每格数量文案 | `×1` **不显示** | 一格既然在，就说明至少有 1 件；`×1` 是噪声 |
| **空背包长什么样** | **恒画满 80 个槽**（有货在前、空槽在后），空槽灰底 `#D8D8D8` | 用户 2026-11 口径："即使没有道具，也能看到格子，定死 80 个" —— 一眼看得出**还有多少位置**，而不是"什么都没有"；槽位数与"装了几件"因此是两件事（容量分子仍数道具） |
| 空槽的底色 | **不许用品质色**（含白档 `#DDDDDD`），用 `c-ink-200`/`c-surface-sunken` 那一档 | 空槽没有品质；白档格子的底框恰好也是 `#DDDDDD`，染上去就是"这件是白档"，与空槽只差 5 个灰阶 |
| 空槽能不能点 | **不能**（点了不冒泡） | 没有详情可显示 —— 让详情面板去展示一件不存在的东西，正是本页最忌讳的那种谎言 |
| **没选中时详情面板怎么办** | **面板恒显示**，画"未选中"占位态（灰底 + 名字，其余收起） | 用户 2026-11 口径；面板整块收起会让右半边变空白，而左边还站着 80 个格子 —— 看起来像"面板没加载出来" |
| 占位态的底框色 | **与格子空槽同一个常量** `BAG_EMPTY_FRAME`（`#D8D8D8`） | 两处讲的都是"这儿本来该有东西"；各写一个灰迟早出现两种不同的"空" |
| 有货的背包要不要默认选中第一件 | **要**（沿用选中回落：传空 / 选中项消失 → 落到第一格） | 打开就有详情可看，少一次点击；**代价**是"未选中"占位态实际上只在空背包时出现（要改就删 `BagVM` 里那一行回落） |
| 预制件拖错的引用（`detailNode` / `capFillNode`） | **直接修预制件**，并加 F16b/F16c 两条体检钉住 | `??` 兜底只认"没拖"、拦不住"拖错"；拖错的那两个节点都**存在**，所以一路静默 |
| 详情面板多出来的 ScrollView | 代码**不碰它**；只在文档里给两条建议（`resizeMode` → CONTAINER、`horizontal` → false） | 这一轮的口径是"面板恒显示 + 两态"，滚动边界是预制件侧的排版问题，动它要先确认用户的意图 |

---

## 10. 局内复活券的完整链路（2026-11 落地）

```text
商城 A5 `revive_ticket`（每天 2 张，看激励视频）
   └─ DataCenter.grantMallLines('revive_ticket') → bagData.addItem('revive_ticket', 1)   ← 唯一的产出口
        └─ 局内：英雄被打死那一刻
             Scene_Game_Stage.onLethalForHero()      ← 挂在 `BattleEvents.OnTakeDamage` 里
               ├─ bagData.getCount('revive_ticket') > 0 ?   → 弹面板，第一颗按钮 =「用复活券复活（剩 N）」
               ├─ 否则 adRevivesLeft > 0 且 AdMgr 可用 ?     → 弹面板，按钮 =「看广告复活」
               └─ 两样都没有                                → **不弹面板**，与旧行为逐字一致：endRun('defeat','hero_dead')
```

### 10.1 ⚠ 拦截时机：**不能等 `OnDeath`**

`DamagePipeline` 的顺序是「Phase 6 扣血 → **Phase 7 派发 `OnTakeDamage`** → Phase 8 死亡检查 `Die()`」。
`Die()` 会 `modifiers.Clear()` —— 等到 `OnDeath` 再复活，就等于把**遗物 / Buff / 技能槽的 Modifier 全丢了**，
要么重挂一遍全部状态、要么接受"复活后变白板"。所以复活走 **Phase 7**：

1. 这一击把血打到 0 时，`onLethalForHero()` 立刻 `hero.alive = true` 并把血补到 **1 点**；
2. Phase 8 的 `IsDead()` 于是不成立 → `Die()` 不会被调用 → 本局状态**原封不动**；
3. 面板期间 `battleStore.isPaused = true`（`update` 的暂停分支会停掉 `ctx.Tick`，也就不会再有伤害进来）；
4. 玩家选"复活"→ `hero.FullHeal()` + 解除暂停；选"放弃"→ `hero.Die()` + `endRun('defeat','hero_giveup')`。

> 同一套机制的先例是技能 129「时间回廊」（`ShopSkillModifiers.Modifier_TimeRewind`：在 `on_take_damage` 里把血补回来）。
> 两个坑都写在它的注释里，这里也踩了同一个：**`ChangeHp` 只把 `alive` 置 false、从不置回 true** ——
> 补血之后必须显式 `alive = true`，否则 `IsDead()`（判 `!alive || hp <= 0`）照样成立。

### 10.2 两条口径

| 问题 | 定案 | 理由 |
|---|---|---|
| 复活券一局能用几次 | **不限**（受背包存量约束） | 券是玩家自己买来的东西，再套一层局内配额等于把券作废；想收就收**产出口**（A5 每日 2 张） |
| 看广告复活一局几次 | `battle_constants.reviveAdPerRun`（现 **1**；0 = 关掉这条） | 与局内"广告免费刷新次数"同一类规则常量；没有这个闸，玩家可以无限看广告续命、失败条件直接失效 |
| 复活回多少血 | **满血**（`Entity.FullHeal`） | 面板上写的「复活后满血继续本局」就是它；只回 1 点血会让"复活"和"再死一次"没区别 |
| 没有券也没有广告次数时 | **不弹面板**，直接判负 | 面板上只剩"放弃"一颗按钮 = 让玩家白点一下；与旧行为逐字一致才是最小改动 |
| 面板长什么样 | **运行期建节点**（`cmps/RevivePromptPanel.ts`），不是预制件 | `View_Game_Stage.prefab` 是 59 万字符的大预制件，为一块新面板去改它的风险高于收益；先例 = `HitVfxLayer` / `HitScreenLayer` |

### 10.3 还没验的（要真机 / 预览）

- [~] 死亡瞬间弹面板、点「用复活券」后**真的**满血继续（面板节点是运行期建的，`audit:ui` 扫不到它的色/字号，
      改色请对着 `RevivePromptPanel` 里那几行 token 注释改）；
- [~] 点「看广告复活」时 `AdMgr` 未接 SDK → 面板**留在原地** + 一行中文提示（走 `View_Game_Stage.showFloatText`）；
- [~] 复活后遗物 / Buff / 技能**一个都没丢**（这是选 Phase 7 拦截的全部理由，值得单独点一遍对账）；
- [~] 连点两次 / 同一帧两只怪同时打死英雄时，**不会扣两张券**（`revivePending` 幂等 + 面板只接一次回调）。
