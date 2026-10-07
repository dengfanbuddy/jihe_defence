# 商城（全屏页）· AI 提示词（只描述显示内容）

> 本文件由 `node tools/shop-prompts/gen-prompts.mjs` 生成，**别手改** —— 改内容改生成器。
> 同目录另有 `prompts.json`（机读）、`prompts.csv`（投递用）与 `README.md`（卖什么 / 数值依据 / 数据出口 / 待接线清单）。

**口径**：提示词**只讲"这一屏要显示什么" + "它是一个全屏页"** —— 布局、分区、尺寸、留白、视觉组织
**全部交给 AI 自己分析**，提示词里不出现施工级坐标。需要施工规格时另看 `README.md`。

---

## 0. 商城里卖什么（内容口径 · 与 `README.md` §2 同源）

| # | 商品 | 给多少 | 频率 | 依据 / 值不值 |
|---|---|---|---|---|
| F1 | 每日补给 | 金币 ×200 ＋ 通用英雄经验 ×100（**连续登录 3 天起 ×1.5 → 300 / 150**） | **每天 1 次 · 不看广告** | 日任务合计 ≈810 金 / 550 经验；100 经验 ≈ 1.25 局通关；**界面上显示的是乘完之后的数** |
| A1 | 金币袋 | 金币 ×300 | 每天 3 次 | **遗物抽取的燃料**（当日 1~2 抽，见 `docs/meta-growth/README.md` §1.3）；顺带补解锁英雄的缺口（第 2 位 675） |
| A2 | 英雄经验瓶 | 通用英雄经验 ×120 | 每天 3 次 | ≈1.5 局通关；Lv12→13 需 347 ★**主推** |
| A3 | 账号经验册 | 账号经验 ×150 | 每天 2 次 | 等级 1→2 需 100、2→3 需 120；升级另发金币，**并解锁局内等级加成** |
| A4 | 遗物抽取次数 | **+1 次局外遗物抽取次数**（免费抽，不花金币） | 每天 **2** 次 | 与局外抽取同一套管线（品质权重 6:2.5:1:0.5、档内优先未收集），**不抬高当日价格阶梯** ★**主推** |
| A5 | 开局增益券 | 随机 1 张**本局增益**（10 条现成效果） | 每天 2 次 | 发放时**排除已达上限**的效果 ★**主推** |
| A6 | 局内广告券 | **+1 张局内广告券**（局内免看广告） | 每天 2 次 | 局内抽卡/补选遗物时**代替**看广告；⚠ **不增加**局内次数上限（`docs/meta-growth/README.md` §3） |

**两条把钱说清楚的前提**（决定上面这些东西为什么是这些数）：

1. **金币是前期资源、经验是长期资源**：金币的两个深坑是解锁英雄（10 位合计 **27,295**，一次性）与
   **局外遗物抽取**（`docs/meta-growth/README.md` §1：集齐 37 件 ≈ 775 抽 ≈ 25 万金币），而成就一次性给 **185,650** 金币；
   通用英雄经验则是**无上限**的（升到 Lv20 要 6,336、Lv30 要 21,447、Lv40 要 68,384），
   且**只有通关才发**（80 × 难度收益倍率）→ 广告商品的主推应该是经验与"免费抽"。
2. **广告不发奖不是"没做"而是刻意的**：`AdMgr` 在未注入真 SDK 时一律返回 `false`（历史上按"看完"兜底白送过免费刷新），
   所以「广告暂不可用」**不做成界面态**（2026-11 决策）：广告返回 `false` 时不发奖、不扣次数，
   由**宿主**给一行可读提示即可，六格照样只显示「今日 N/M」。

### 0.1 这一屏要显示什么（提示词的唯一内容口径）

| 显示什么 | 长什么样（样例用真实感数据） | 口径 / 坑 |
|---|---|---|
| 形态 | **全屏页**：占满 750×1334，打开时主界面整块被盖住 | 与 `ui_difficulty` / `ui_hero_detail` **不同时开**（三个都是全屏/模态） |
| 返回入口 | 左上角返回箭头 | 全屏页的唯一出口（views 形态下页面自己关自己） |
| 金币读数 | 圆金币图形 + 「1,240」（暖金 `#D38C1E`） | `itemData.getCurrency(Gold)`；用途两条：**解锁英雄** + **局外遗物抽取** |
| 通用英雄经验读数 | 青绿徽记 + 「760」 | `heroData.getSharedExp()`；**只用于英雄升级**，一局通关才发 |
| 每日免费块（**页面主角**） | 礼盒图形 + 「每日补给」+「金币 300 + 通用英雄经验 150」（**已含连续登录加成**） | 每天 1 次，**不看广告**；日键 `YYYYMMDD` 跨日重置；基础量是 200/100，×1.5 之后才是 300/150 |
| 连续登录加成 | 「连续登录 4 天 · 今日 ×1.5」 | `PlayerInfo.loginStreak`；3~6 天 ×1.5（300/150）、≥7 天 ×2（400/200）并加送 1 张增益券 —— **格子上显示的是乘完之后的数** |
| 唯一的主按钮 | 青绿实心药丸「免费领取」（`c-accent-action #3F9E9B`） | 当日已领 = 灰药丸「明天再来」（`c-disabled-pill #B9C1C1`）。⚠ **全屏页只有这一颗实心按钮** |
| 重置倒计时 | 「距重置 07:12:33」 | 次日本地 0 点；**不是**"距上次 24 小时" |
| 6 个广告商品格 | 金币袋 +300 金币 · 英雄经验瓶 +120 通用英雄经验 · 账号经验册 +150 账号经验 · 遗物抽取次数（+1 次局外抽取）· 开局增益券（随机 1 张本局增益）· **局内广告券（+1 张，局内免看广告）** | 每格：图形 + 名称 + 数量 + 广告角标 + 「今日 N/M」；**权重不相等**（前两格更重）；⚠ **两种券必须一眼分开**（判别靠**孔洞语义**：增益券斜箭头孔 / 广告券播放三角孔，见 §2 的实测口径） |
| 遗物格的图鉴进度 | 「已收集 12/37」+ 小品质色片 | 局外遗物共 37 件、**只能靠局外金币抽取获得**（`docs/meta-growth/README.md` §1）；广告这一格给的是**一次免费抽**（每天 2 次），不花金币也不抬高当日价格 |
| **免广告卡**（唯一的长线目标） | 图形 + 「免广告卡」+「累计观看广告 42/84」+ 细进度条 + 「攒满 84 次可领 · 生效 24 小时」+ **描边**按钮「领取」 | 攒满 = **84 次**（= 每日上限 14 × 6 天），领了给 **24 小时免广告**（局内那两个广告位直接放行）。口径见 `docs/shop/README.md` §2.3；⚠ 按钮是**环**不是实心（全屏页只有一颗实心按钮） |
| 底部账本与说明 | 「今日广告 6/14」+「看完一段视频即可领取 · 每天 0 点重置」 | 跨商品共用一个每日广告总上限（3+3+2+**2**+2+**2** = **14**） |
| 本页的定价声明 | 「本页商品全部通过观看激励视频获得，不需要付费」 | 这一屏**只做广告变现**，没有任何付费点 |

---

## 1. 主提示词：给 AI 描述「这一屏要显示什么」

> 三版同一个内容口径，按用途挑一条：**中文版**给"AI 设计器/实现者"（要规格），
> **英文版**给图像模型（要效果图），**极简版**只列内容（上下文紧张或想先试一版）。

### 1.1 中文版（可直接复制 · 给 AI 设计器 / 前端 / Cocos 实现者）

```text
请设计《集合防御》里的「商城」界面。**它是一个全屏页**（不是弹窗、不是浮在遮罩上的浮层）：
占满整屏，打开时主界面整块被盖住，所以页内要自带资源读数（主界面那条顶栏玩家看不见了）。

【只要求这些内容，布局由你自己分析决定】
下面这些内容怎么分区、每块多大、留白怎么留、视觉层级怎么排，你按最清晰易读的方式自己定 ——
我只规定「必须显示什么」，不规定摆在哪。

【必须显示的内容】（括号里是样例数据，用这些真实感数据，不要占位文案）
1. 顶部一条资源行：返回入口 + 金币 1,240 + 通用英雄经验 760
2. 页面的**主角块**「每日补给」：礼盒图形 + 「金币 300 + 通用英雄经验 150」
3. 连续登录加成：「连续登录 4 天 · 今日 ×1.5」（**格子上的 300/150 已经是乘完的数**，不要另画一行 "200 × 1.5"）
4. **唯一的主按钮**：「免费领取」（青绿实心）。已领时变灰药丸「明天再来」+ 保留倒计时
5. 重置倒计时：「距重置 07:12:33」（每天 0 点重置）
6. 六个广告商品格，每格要有：图形 + 名称 + 数量 + 广告角标 + 今日剩余次数
   ① 金币袋 +300 金币「今日 2/3」
   ② 英雄经验瓶 +120 通用英雄经验「今日 1/3」
   ③ 账号经验册 +150 账号经验「今日 2/2」
   ④ 遗物抽取次数 +1 次局外抽取 · 品质片 · 「已收集 12/37」「今日 2/2」
   ⑤ 开局增益券 · 随机 1 张本局增益 ·「今日 0/2」
   ⑥ 局内广告券 · +1 张 · 一句「局内免看广告」·「今日 2/2」
   ⚠ ⑤ 与 ⑥ **都是券**，两张图标必须一眼分得开（判别靠**孔洞语义**：⑤ 斜箭头孔 + 下方票根 / ⑥ 播放三角孔 + 左侧票根）
7. **免广告卡**（本页唯一的长线目标）：图形 + 「免广告卡」+「累计观看广告 42/84」+ 一条细进度条
   + 一句「攒满 84 次（按今日上限约 6 天）可领 · 生效 24 小时」+ 一颗**描边**按钮「领取」
8. 底部一行：「今日广告 6/14」+「看完一段视频即可领取 · 每天 0 点重置」
9. 一句定价声明：「本页商品全部通过观看激励视频获得，不需要付费」
10. 领取成功的反馈：数量往上飘一下（`+300`），不弹二级确认框

【视觉风格（这是本项目既定风格，不是可选项）】
浅色纸面上的低多边形几何、双色制、大留白、图纸沙盘感；**零渐变、零投影、零发光、零材质纹理**。
颜色只有这几个来源：墨色阶 #445054 / #465259 / #56636A / #6A696B / #999999（文字与图标）、
青绿 #67999A / #70ACB3（**只表示系统与操作**：按钮、进度、可点格）、
暖金 #D38C1E（**只表示货币**：金币读数）、品质 4 档 #DDDDDD / #5096FF / #CF68FF / #FF6464（**只表示遗物品质**）。
局外页面的底是暖米白 #EFEEED，卡片是白 #FFFFFF。
字号只用 40 / 24 / 20 / 16 / 14 / 12；圆角只用 4 / 8 / 16；间距只用 6 / 10 / 20 / 30。
图标一律几何线稿（圆/方/三角/菱/环/盾/箭头的组合），不要 emoji、不要写实图形、不要贴图。

【硬约束】
- **全屏页只有一个实心主按钮**（「免费领取」）；六个商品格与免广告卡的「领取」一律**描边/次级**，不许再出现第二个实心按钮
- 六个商品格**不许等权排布**：金币袋与英雄经验瓶要比其余四格更重（等大格子居中铺满 = 没有主次）
- 不许出现第三种强调色；暖金只用在金币上
- 所有文字与数字都必须是**可替换的文本**（不要做成图片）
- 这一屏**没有任何付费点**，只有看广告与每日免费

【交付】先给一段「设计说明」（≤120 字：这一屏服务什么动作、视觉引导顺序），
再给一节「你决定的分区方案」（每块放什么、为什么这么排、留白怎么留），最后给「自检」（上面 10 项是否都在）。
```

### 1.2 英文版（给图像模型 · 要一张效果图）

- 比例 **9:16**　装机：不进工程（只给评审/施工参考，落 docs/shop/shop.png）
- 中文（校对用，**不投递**）：商城全屏页效果图：竖屏，整屏铺满（不是弹窗、不是浮层），暖米白纸面底；顶部一条细的资源行（返回箭头 + 金币 1,240 + 通用英雄经验 760）；页内最重的一块是「每日补给」—— 礼盒图形 + 「金币 300 + 通用英雄经验 150」+ 「连续登录 4 天 · 今日 ×1.5」+ 青绿实心主按钮「免费领取」+ 「距重置 07:12:33」；另有六个广告商品格（金币袋 +300 / 英雄经验瓶 +120 / 账号经验册 +150 / 遗物抽取次数 +1·已收集 12/37 / 开局增益券 / 局内广告券），每格带广告角标与「今日 2/3」次数；**每格的图形都落在一块小青绿方块上**（白描图贴浅色纸面会看不见）；再往下是「免广告卡」那一块（累计观看广告 42/84 + 一条细进度条 + 一句「攒满 84 次可领 · 生效 24 小时」+ 一颗**描边**按钮「领取」）；底部一行「今日广告 6/14」+「看完一段视频即可领取 · 每天 0 点重置」+「本页商品全部通过观看激励视频获得，不需要付费」。**布局如何分区、每块多大、留白怎么留，全部由 AI 自己分析决定**。

**英文提示词**

```text
This is a flat layout concept for a full-screen page in a mobile game, drawn face-on as it would appear on a vertical phone screen, with no device frame, no perspective and no drop shadow. The page covers the entire screen edge to edge on one flat warm off-white paper field, and no part of any earlier screen shows through anywhere, so this is a whole page of its own rather than a panel floating over a dark backdrop. How the page is divided into sections, how large each block is and how the whitespace is used are all left open, so the page simply has to show everything listed here in whatever grouping reads most clearly. Across the top a thin quiet row carries a small back arrow at its left end and two read-outs spread along it: a round gold coin glyph with the number "1,240" beside it in warm gold and a pale teal emblem with the number "760" beside it. The heaviest block on the page is the free daily crate: a flat white gift-box glyph on a teal tile, the heading "每日补给", the line "金币 300 + 通用英雄经验 150" underneath it, a small line of grey text reading "连续登录 4 天 · 今日 ×1.5", one filled teal pill button with the white label "免费领取", and the faint small text "距重置 07:12:33". Six smaller product cells follow, each one holding a flat white glyph standing on a small teal tile, the name of the goods, the amount it gives, a small advertising badge, and a small counter line: "金币袋 +300 金币" with "今日 2/3", "英雄经验瓶 +120 通用英雄经验" with "今日 1/3", "账号经验册 +150 账号经验" with "今日 2/2", "遗物抽取次数 +1 次局外抽取" with a small flat epic-purple quality chip and the wide grey text "已收集 12/37", "开局增益券 随机 1 张本局增益" with "今日 0/2", and lastly "局内广告券 +1 张 局内免看广告" with "今日 2/2". These six cells are not all equally weighted: the first two carry more visual weight than the rest, and each one simply shows how many of its daily views are left in a small quiet counter line. Below them one more flat white card holds the long-running goal: a flat white ticket glyph on a teal tile, the heading "免广告卡", a small grey line reading "累计观看广告 42/84", a very thin flat progress bar with its left part filled in teal, and the faint grey text "攒满 84 次（按今日上限约 6 天）可领 · 生效 24 小时", with one outlined teal pill button carrying the dark label "领取". Along the bottom of the page one quiet line of small grey text reads "今日广告 6/14", "看完一段视频即可领取 · 每天 0 点重置" and "本页商品全部通过观看激励视频获得，不需要付费". The palette is deliberately narrow: one family of cool slate inks for every word and glyph, one teal for buttons, tiles and progress, one warm gold used only for the coin read-outs, and one flat chip in the epic quality colour on the relic cell, and nothing else. Every surface is a flat tone with a thin clean outline and rounded corners, and no gradient, no drop shadow, no glow and no surface texture appears anywhere in the picture.
```

**短版（同图简写 · ~306 词 · 上下文紧张或先试一版时用）**

```text
Flat minimal mobile game page, portrait, filling the whole screen as a page of its own and not as a popup: one warm off-white paper field with a thin top row carrying a back arrow, a round gold coin glyph with "1,240" and a pale teal emblem with "760". Below that the heaviest block is a free daily crate: a flat white gift-box glyph on a teal tile, the heading "每日补给", the line "金币 300 + 通用英雄经验 150", a small grey line "连续登录 4 天 · 今日 ×1.5", one filled teal pill button labelled "免费领取", and the faint text "距重置 07:12:33". Six smaller product cells follow, each with a flat white glyph standing on a small teal tile, a name, an amount, a small advertising badge and a counter: "金币袋 +300 金币 · 今日 2/3", "英雄经验瓶 +120 通用英雄经验 · 今日 1/3", "账号经验册 +150 账号经验 · 今日 2/2", "遗物抽取次数 +1 次局外抽取 · 已收集 12/37", "开局增益券 随机 1 张本局增益 · 今日 0/2", "局内广告券 +1 张 局内免看广告 · 今日 2/2". Below them a seventh flat white card holds the long goal: a flat white ticket glyph on a teal tile, the heading "免广告卡", the small grey line "累计观看广告 42/84", a very thin flat progress bar with its left part filled teal, the faint grey line "攒满 84 次（按今日上限约 6 天）可领 · 生效 24 小时", and one outlined teal pill button with the dark label "领取". A quiet line of small grey text along the bottom reads "今日广告 6/14" and "看完一段视频即可领取 · 每天 0 点重置" and "本页商品全部通过观看激励视频获得，不需要付费". How the page is divided and how large each part is are left open. Everything is one flat tone with thin outlines and no gradient, no shadow, no glow and no texture, in a palette of one slate ink family, one teal, one warm gold used only for coins, and one quality chip.
```

**另外两个态怎么画**（不是单独出图，把下面几处换掉即可）：

- **每日已领态**：主按钮变灰药丸「明天再来」+ 保留「距重置 07:12:33」（没有第二次领取）
- **免广告卡生效态**：进度区整块收起，只留一行「免广告生效中 · 剩 23:12:45」，按钮整颗收起
- **免广告卡可领态**：细进度条填满 + 按钮字色转深墨（「领取」）
- ⚠ **广告不可用态不画**（2026-11 决策，见 `docs/shop/README.md` §3.4）：六格不做置灰，由宿主给一行提示

### 1.3 极简版（只列内容 · 想先试一版时用）

```text
画一个手游的「商城」**全屏页**（竖屏，占满整屏、不是弹窗，暖米白纸面底）。
页内显示：顶部一条资源行（返回箭头、金币 1,240、通用英雄经验 760）；
主角块「每日补给」（礼盒图形、金币 300 + 通用英雄经验 150、连续登录 4 天 · 今日 ×1.5、
青绿实心主按钮「免费领取」、距重置 07:12:33）；
六个广告商品格（金币袋 +300、英雄经验瓶 +120、账号经验册 +150、遗物抽取次数 +1·已收集 12/37、开局增益券、局内广告券），
每格带广告角标与「今日 N/M」次数；
再一块「免广告卡」（累计观看广告 42/84、一条细进度条、一句「攒满 84 次可领 · 生效 24 小时」、一颗描边按钮「领取」）；
底部「今日广告 6/14」与「本页商品全部通过观看激励视频获得，不需要付费」。
布局、分区、尺寸、留白你自己分析决定，只要这几项都在、且一眼能找到「免费领取」和金币/经验两个读数。
风格：浅色纸面低多边形几何、大留白、零渐变零投影零发光；墨色阶文字 + 青绿操作色 + 暖金货币色 + 品质 4 档；
字号只用 40/24/20/16/14/12，圆角只用 4/8/16；全屏只有一个实心主按钮。
```

---

## 2. 要新出的 3 个图标（白描，1:1 → 64×64）

商城要的图形**绝大部分是现成的**（金币 / 英雄经验 / 账号经验 / 广告 / 加号 / 关闭 / 遗物图集）。
真正缺的是三个：**礼盒**（`common/` 里没有宝箱/礼盒类图形）、**本局增益券**与**局内广告券**
（现有素材里没有任何券/票/卡，而商城里这两格是并排的 → **两张券必须一眼分得开**）。

| # | key | 是什么 | 用在哪 | 装机路径 |
|---|---|---|---|---|
| 1 | `shop_daily_gift` | 商城图标 · 每日免费补给（礼盒） | 商城全屏页「每日补给」块的图形（40×40）；顶栏 `add` 入口若用同一语义也可复用 | `textures/shop/daily_gift` |
| 2 | `shop_boost_ticket` | 商城图标 · 本局增益券（票券） | 商城全屏页「开局增益券」格的图形（40×40） | `textures/shop/boost_ticket` |
| 3 | `ad_ticket` | 局内广告券图标（免看广告的票） | 商城全屏页「局内广告券」格（40×40）**＋ 局内 HUD**（`RefreshButtonView` 第三态「用 券」，20×20） | `textures/common/ad_ticket` |

**规格**：出图 512×512（1:1）→ 交付 **64×64 RGBA**；主体**纯白 `#FFFFFF` 单色**（不透明像素只许一个白）；
出图画在**深板岩灰 `#445054`** 承载底上，本地按四边采样**色键抠掉** → 真透明，可用 `Sprite.color` 染色。
风格段 `import` 自 `tools/hero-icon-prompts/gen-prompts.mjs`（与英雄头像 / 技能图标 / 难度徽记 / 英雄属性图标同一份）。

> ⚠⚠ **两条实测口径（2026-11 出图时踩出来的，改形状句之前先读）**：
>
> ① **白描图标只能落在"有色块"上**。三张图都是纯白挖空，贴浅色纸面 `#EFEEED` / 白卡上**等于看不见**
> （把交付图拼到真实底色上是 0 对比度）—— 所以商城页里每一格都必须先给一块**青绿小方块**（`#70ACB3`）当承托，
> 顶栏与 HUD 同理。这不是审美，是"看不见"的问题。
>
> ② **剪影必须接近方形，而且只能靠"直接命令票身是方的"来拿**。槽位是 `sizeMode=CUSTOM` +
> `_isTrimmedMode=true` → 引擎把 **alpha 包围盒铺满方槽**，越瘦的构图进槽被拉得越狠。
> 同一套风格段只改形状句，实测（源图 alpha 包围盒，后处理打印的"形变"）：
>
> | boost_ticket 的形状句 | 源包围盒 | 形变 | 结果 |
> |---|---|---|---|
> | `clearly taller than it is wide`（第一版） | 163×324 | **1.99×** | 竖票被拉成方票，与 `ad_ticket` 分不开 |
> | `only a little taller / nearly square` | 221×324 | **1.47×** | **模型不听**，它按"票=竖长"画 |
> | 竖票 + 更宽的底票根（把宽度交给另一个形体） | 187×339 | **1.81×** | 更糟：票身被拉得更瘦 |
> | **票身切成正方形 + 略窄的下票根（现行）** | 327×339 | **1.04×** | ✅ 干净 |
> | `ad_ticket` 的对应句：`clearly wider than it is tall` → 方形票身 | 374×303 → 353×321 | 1.23× → **1.10×** | ✅ |
>
> 结论：**"整体接近方形"这类抽象句一律无效，只有"票身切成正方形"这种对形体的直接命令才管用。**
> 三张最终形变 `1.08× / 1.04× / 1.10×`，体检 `python tools/hero-icon-prompts/check-hero-icons.py` 全绿。

### 2.1 `shop_daily_gift`　商城图标 · 每日免费补给（礼盒）

- 交付：`shop_daily_gift.png`　**64×64**　装机：`textures/shop/daily_gift`
- 中文（校对用，**不投递**）：每日礼盒图标：一个正立的方礼盒，盒盖略宽于盒身、与盒身之间留一条横向的缝，盒身正面挖两条十字交叉的缎带缝（一竖一横），盒盖正中挖一个小圆孔，盒盖上方左右各一个对称的短耳（打结的缎带）。

**英文提示词**

```text
This is a small interface icon for a mobile game: a single object treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included. A single upright gift box standing at the centre of the square, built from two plain rectangular slabs: a wider flat lid sitting across the top and a slightly narrower body under it, with one clear even horizontal gap cut clean through between the two so the lid and the body read as separate pieces. Two straight bands of open space are cut clean through the front of the body — one running vertically down the middle and one running horizontally across it — so the crossing ribbons are expressed as holes rather than as drawn lines. One small round hole is punched through the middle of the lid, and above the lid two short symmetrical loops stand to the left and to the right of that hole like the two halves of a tied bow. The box is squared off at the bottom, and its total width and its total height come out very nearly equal. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and all of its detail — every opening, every division between neighbouring parts, every inner edge — is expressed purely as holes cut clean through that shape rather than as drawn lines. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

### 2.2 `shop_boost_ticket`　商城图标 · 本局增益券（票券）

- 交付：`shop_boost_ticket.png`　**64×64**　装机：`textures/shop/boost_ticket`
- 中文（校对用，**不投递**）：本局增益券图标：**方票身 + 下票根**——票身切成正方形（四角各切一个小缺角），底下的方形票根比票身略窄、由一条水平缺口线分开（两端各挖一个小圆孔），票身正中挖一个斜向朝右上的实心箭头形孔，票身左右各挖一条短竖缝。

**英文提示词**

```text
This is a small interface icon for a mobile game: a single object treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included. A single ticket standing at the centre of the square, its body cut as a plain square, as wide as it is tall, its four corners each sliced off by one small straight cut so they read as blunt notches rather than sharp points, and one plain rectangular stub joined under its bottom end, cut a little narrower than the body and clearly separated from it by one narrow horizontal line of open space with a small round hole punched at each end of that line. In the middle of the square body one broad arrowhead with a short thick shaft behind it is cut clean through as a single solid piece of open space, pointing diagonally up and to the right, chunky and generous so that the arrow reads as one bold solid hole rather than as a thin outline, with one short thin slot cut down each side of the body. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and all of its detail — every opening, every division between neighbouring parts, every inner edge — is expressed purely as holes cut clean through that shape rather than as drawn lines. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

### 2.3 `ad_ticket`　局内广告券图标（免看广告的票）

- 交付：`ad_ticket.png`　**64×64**　装机：`textures/common/ad_ticket`
- 中文（校对用，**不投递**）：局内广告券图标：**方票身 + 左票根**——票身切成正方形（四角切掉小缺角），左边的方形票根比票身略窄、由一条竖直缺口线分开（两端各挖一个小圆孔），票身右侧正中挖一个**大而饱满、朝右的播放三角**孔（占满票身大半个高度），票身上下各挖一条短横缝。

**英文提示词**

```text
This is a small interface icon for a mobile game: a single object treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included. A single ticket lying at the centre of the square, its body cut as a plain square, as tall as it is wide, its four corners each sliced off by one small straight cut so they read as blunt notches rather than sharp points, and one plain rectangular stub joined to its left-hand end, cut a little narrower than the body and clearly separated from it by one narrow vertical line of open space with a small round hole punched at each end of that line. In the right-hand part of the square body one broad triangle is cut clean through as open space with its sharp point facing right, taking up most of the height of the body so it reads at a glance as a triangle rather than as a small nick, with one short thin slot cut along the top edge of the body and one along its bottom edge. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and all of its detail — every opening, every division between neighbouring parts, every inner edge — is expressed purely as holes cut clean through that shape rather than as drawn lines. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

> ⚠ 三条防撞形要求（**这是这套图标唯一的构图硬指标**）：
> `shop_daily_gift` 不能像 `common/bag`（背包：软顶 + 背带）、`common/store`（店铺招牌：弧形顶棚）或 `common/item_shop`（货架）；
> `shop_boost_ticket` 与 `ad_ticket` **都必须是接近方形的票**（原因见上面的实测口径 ②），判别靠**孔**：
> 增益券****斜向朝右上的箭头孔 + 下方票根****，广告券**朝右的播放三角孔 + 左侧票根** ——
> ⚠ **"一竖一横"曾经是设计口径，实测已被推翻**：槽位会把包围盒归一，长短边在屏幕上留不下来，
> 能留到 20×20 的只有**孔洞语义**。
> 另外 `ad_ticket` 还要避 `common/ad`（裸的播放三角在圆角方框里，没有票券轮廓与票根孔）。

---

## 3. 这些一律不要出图

| 要什么 | 用什么 | 说明 |
|---|---|---|
| 页面底 / 卡片底 / 圆角 / 描边 | `common/rect_rd_20` · `rect_rd_10` · `rect_rd_5` · `rect_board_rd_*` | 九宫格贴图 + 运行时染色；**不要出"底纹/背景图"**（风格禁止材质） |
| 金币 / 英雄经验 / 账号经验 / 广告 / 加号 / 关闭 | `common/gold`（**染 `c-gold #D38C1E`**）· `common/exp_icon`（青绿本色，**不染**）· `common/player_exp` · `common/ad` · `common/add` · `common/close` | 全部现成；金币图标染色这条踩过坑（"两态色把金币图标染了"当过 bug 记） |
| 遗物图形 / 品质片 | `relics` 图集（走 `common/AtlasIcon.ts` 三级降级）+ 品质 4 档纯色 #DDDDDD / #5096FF / #CF68FF / #FF6464 | 37 件局外遗物的图都已有；品质片是纯色块，不是图 |
| 进度条 / 分隔线 / 倒计时的细刻度条 | `rect_rd_20` 九宫格 + `Sprite.color` · `cc.Graphics` | 填充 `#70ACB3`、轨道 `#D8D8D8`；线是代码画的（倒计时**文字**用 Label，不配时钟图标） |
| **所有文字与数字** | **`cc.Label`** | **绝不出图**：商品名 / 数量 / 次数 / 倒计时 / 说明文案 —— 出了就不可本地化、不可改字号、不可染色 |

---

## 4. 怎么投递

```powershell
# 0) 生成/刷新清单（幂等）
node tools/shop-prompts/gen-prompts.mjs

# 1) 3 个图标：EmptyLatentImage 直填 512×512（= 清单里的 `gen_size`）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/shop/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/shop-icons-out --skip-existing --free-every 0 --unload-every 0 `
  --only shop_daily_gift,shop_boost_ticket,ad_ticket

# 2) 全屏页效果图：Resolution Selector 改成 9:16 后跑这一条（输出目录不同）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/shop/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/shop-scenes-out --skip-existing --only shop_fullscreen
```

### 4.1 出完图怎么处理与装机（**只对 3 个图标**）

```powershell
# 3) 色键抠底 + 拍平白 + 正方形包围盒 → 64×64
python tools/hero-icon-prompts/make-hero-icons.py `
  --src .tmp/shop-icons-out --dst .tmp/shop-icons-final `
  --prompts docs/shop/prompts.json

# 4) 体检（真 alpha / 正方形 / 64×64 / 留白 / 纯白比例）
#    ⚠ 必须带 --prompts，否则它按**英雄那份**清单取期望边长（本清单的 key 不在里面 → 尺寸检查被跳过）
python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/shop-icons-final `
  --prompts docs/shop/prompts.json --limit 20

# 5) 装机（缺省只演练，看清楚再 --apply；装完切回 Cocos 窗口让它导入生成 .meta）
python tools/hero-icon-prompts/install-hero-icons.py `
  --src .tmp/shop-icons-final --prompts docs/shop/prompts.json --apply
```

> ⚠ **全屏页效果图不跑第 3 步**（跑了会把概念稿毁掉），也不用装机：存成 `docs/shop/shop.png` 就完事。
> ⚠ `textures/shop/` 是**新目录**（礼盒 + 增益券），`ad_ticket` 落已有的 `textures/common/`；三个 `.png` 与它们的 `.meta` 都要随提交入库（没有 `.meta` 就没有 uuid，运行期取不到）。

---

## 5. 验收清单

- [ ] 效果图里看得出来**这是一个全屏页**：整屏铺满、上一屏一点都不透出来；
- [ ] 内容**一项不缺**：资源行（返回 + 金币 + 经验）/ 每日补给块 / 连续登录加成 / 一个主按钮 / 倒计时 / 六个商品格（含次数）/ **免广告卡**（进度 + 领取）/ 底部账本 / 定价声明 / 领取反馈；
- [ ] **只有一个实心主按钮**（「免费领取」），六个商品格与免广告卡的「领取」全是被描边或次级样式；
- [ ] 六个商品格**有主次**（不是六个等大格子居中铺满）；
- [ ] 金币是**暖金**、经验是**青绿**、遗物品质只用品质 4 档 —— 没有第四种色系，没有渐变/投影/发光/纹理；
- [ ] 页内**自带资源读数**（不能假设玩家还看得到主界面顶栏）；
- [ ] ⚠ **不画账号等级 + 经验条，也不画两个灰态**（2026-11 决策，见 `docs/shop/README.md` §3.4）—— 画了就是与契约不符；
- [ ] **两种券的图标摆在一起不会认错**（增益券：斜箭头孔 + 下方票根 / 广告券：播放三角孔 + 左侧票根）——
      ⚠ 别再用"一竖一横"当判据（方形槽会把包围盒归一，长短边留不下来）；
- [ ] 每张白描图**都落在有色块上**（青绿 `#70ACB3` 等），没有一张贴在浅色纸面/白卡上（贴上去等于看不见）；
- [ ] 3 个新图标与 `common/gold` `common/ad` `common/exp_icon` **摆在一起看不出是两批出的图**；
- [ ] 每张图标 `形变 ≤ 1.15×`（后处理打印；超了改**具体构图动作**再跑，别接受形变 —— 现行三张是 1.08 / 1.04 / 1.10）；
- [ ] 图标**缩到 20×20** 还认得出（`ad_ticket` 真身就在局内 HUD 的 20×20 上），且染成 `#6A696B` 与 `#70ACB3` 两种色都读得清；
- [ ] 效果图里的文字**只当版式锚点**（错字不算不合格），但「免费领取」与两个资源读数必须一眼找得到。
