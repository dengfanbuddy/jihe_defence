# 英雄详情弹窗 · AI 提示词（只描述显示内容）

> 本文件由 `node tools/hero-detail-prompts/gen-prompts.mjs` 生成，**别手改** —— 改内容改生成器。
> 同目录另有 `prompts.json`（机读）与 `prompts.csv`（投递用），以及 `README.md`（面板契约 / 数据来源 / 施工清单）。

**口径**：提示词**只讲"这个弹窗要显示什么" + "它是一个弹窗"** —— 布局、分区、尺寸、留白、视觉组织
**全部交给 AI 自己分析**，提示词里不出现施工级坐标。需要施工规格时另看 `README.md`。

---

## 0. 这个弹窗要显示什么（提示词的唯一内容口径）

| 显示什么 | 长什么样（样例用真配表的火枪 12 级） | 口径 / 坑 |
|---|---|---|
| 英雄头像 | 白描徽记（`textures/heros/*`），暗红 `#A85A5A` 底 | 头像**不是**彩色立绘，是本作那套白色单色徽记 |
| 英雄名 | 「火枪」 | `units.json` 的 `name` |
| 等级 | 「LV.12」 | 未解锁时**不显示**（没有档案） |
| 经验（可升级用） | 进度条 + 「120/347」+ 一句「升下一级需要 347 经验」 | **升级花的就是它**；数字 = 持有 / 本级所需 |
| 五项属性 + 每级成长 | 最大生命 452（+12/级）· 最大魔法 120（—）· 攻击力 73（+3/级）· 攻击速度 120%（—）· 攻击距离 250（—） | 英雄**真配了的 5 项**，不是英雄卡上那 4 行（卡上第 3 行「护甲」对英雄恒为 0） |
| 技能 | 图标 + 「爆头冲击（被动）」+ 效果文案 | 英雄自带技能**恰好 1 个且必为被动** |
| 唯一的主操作按钮 | 「升 级」（可升级 = 青绿 `#3F9E9B`；经验不够 = 浅灰 `#B9C1C1` 且点不动） | 一屏**只许一个**主按钮 |
| 升级要花的资源 | 经验 347（= 本级所需） | **花经验，不花金币** |
| 持有的可升级资源 | 通用英雄经验 1,280 | 一局结束时发放，所有英雄共用 |
| 解锁用的货币 | 金币 640 | 金币**只用于解锁英雄**，不参与升级 |
| 关闭入口 | 右上角细描边 × | 弹窗的唯一出口 |
| 未解锁的同款态 | 信息整块灰 + 头像盖白锁 + 去掉等级与经验 + 按钮变「解 锁」+ 金币价 675 | 与已解锁态是**同一个弹窗**，只换 3 处 |

### 0.1 两条已拍板的规则

1. **升级花经验，经验在一局结束时发放**（所有英雄共用一份通用英雄经验池）。
   金币**只用来解锁英雄**（`500 × 1.35^列表序号`），不参与升级 —— 所以面板上两种资源都要**看得见**，但用途要分清。
2. **面板必须自带资源读数**：弹窗遮罩是**全屏**的（`rgba(0,0,0,.70)` 盖 750×1334），
   主界面顶栏那条资源栏会被一起压暗 —— 玩家在弹窗里**看不到顶栏**，所以「经验 / 金币」要画进弹窗。

### 0.2 这一版改了哪两处（相对上一版）

| 项 | 上一版 | 这一版 |
|---|---|---|
| 升级花什么 | 金币（`50 × 1.25^(lv-1)`） | **经验**（= 本级所需，`100 × 1.12^(lv-1)`） |
| 提示词写到什么粒度 | 逐格坐标（"经验条 300×10 @ x=+4"） | **只写显示内容**，布局交给 AI 分析 |

> ⚠ **一处实现后果**（写代码时躲不掉）：`HeroData.addHeroExp()` 现在是**发经验即自动升级**的循环
> （`HeroData.ts:139-155`），而"在详情面板花经验升级"要求**发经验只进池、升级要玩家手动点**。
> 落地时必须二选一：① 新增一份**通用经验池**（放 `ItemData` 或 `PlayerInfo`）并让 `addHeroExp` 只加不升；
> ② 沿用 per-hero 的 `exp` 字段但**删掉自动升级循环**，把升级收敛到面板这一条路径。

---

## 1. 主提示词：给 AI 描述「弹窗要显示什么」

> 三版同一个内容口径，按用途挑一条：**中文版**给"AI 设计器/实现者"（要规格），
> **英文版**给图像模型（要效果图），**极简版**只列内容（上下文紧张或想先试一版）。

### 1.1 中文版（可直接复制 · 给 AI 设计器 / 前端 / Cocos 实现者）

```text
请设计《集合防御》里的「英雄详情」界面。**它是一个弹窗**（模态浮层）：全屏遮罩 + 浮在中间的面板，
背景是主界面被压暗后的样子。

【只要求这些内容，布局由你自己分析决定】
下面这些内容怎么分区、每块多大、留白怎么留、视觉层级怎么排，你按最清晰易读的方式自己定 ——
我只规定「必须显示什么」，不规定摆在哪。

【必须显示的内容】（括号里是样例数据，用这些真实感数据，不要占位文案）
1. 英雄头像（本作是白色单色徽记，暗红底，不是彩色立绘）
2. 英雄名：「火枪」
3. 等级：「LV.12」
4. 经验：进度条 + 「120 / 347」+ 一句「升下一级需要 347 经验」
5. 五项属性，每项都要有「当前值」和「每级成长」：
   最大生命 452（+12/级）· 最大魔法 120（—）· 攻击力 73（+3/级）· 攻击速度 120%（—）· 攻击距离 250（—）
6. 技能：图标 + 名称「爆头冲击（被动）」+ 效果文案「普攻附带 5% 攻击力的额外伤害；15% 概率击退敌人 1m」
7. **一个主操作按钮**：「升 级」。已解锁时它有两种状态要能画出来：可升级 / 经验不足（置灰点不动）
8. 升级要花的资源：经验 347（**升级花经验，不花金币**）
9. 持有的通用英雄经验：1,280（一局结束时发放，所有英雄共用）
10. 金币 640（**金币只用于解锁英雄**，不参与升级）
11. 关闭入口
12. 同一个弹窗的**未解锁态**：英雄信息整块置灰 + 头像盖一把白锁 + 去掉等级与经验 + 按钮文案变「解 锁」、旁边换成金币价 675

【视觉风格（这是本项目既定风格，不是可选项）】
浅色纸面上的低多边形几何、双色制、大留白、图纸沙盘感；**零渐变、零投影、零发光、零材质纹理**。
颜色只有这几个来源：墨色阶 #445054 / #56636A / #6A696B / #999999（文字与图标）、
青绿 #67999A / #70ACB3（**只表示系统与操作**：按钮、进度、可点元素）、
暗红 #A85A5A（**只表示英雄与人**：头像格）、暖金 #D38C1E（**只表示货币**：经验与金币读数）。
字号只用 40 / 24 / 20 / 16 / 14 / 12；圆角只用 4 / 8 / 16；间距只用 6 / 10 / 20 / 30。
图标一律几何线稿（圆/方/三角/菱/环/盾/箭头的组合），不要 emoji、不要写实图形、不要贴图。

【硬约束】
- 一屏**只有一个**主按钮；不许出现第三种强调色
- 所有文字与数字都必须是**可替换的文本**（不要做成图片）
- 弹窗自带资源读数（遮罩会把主界面顶栏压暗，玩家看不到顶栏）

【交付】先给一段「设计说明」（≤120 字：这一屏服务什么动作、视觉引导顺序），
再给一节「你决定的分区方案」（每块放什么、为什么这么排、留白怎么留），最后给「自检」（上面 12 项是否都在）。
```

### 1.2 英文版（给图像模型 · 要一张效果图）

- 比例 **9:16**　装机：不进工程（只给评审/施工参考，落 docs/hero-detail/popup.png）
- 中文（校对用，**不投递**）：英雄详情弹窗效果图：竖屏，主界面被 70% 黑遮罩压暗，白色大圆角面板浮在中间；面板里显示一个英雄（火枪 · LV.12）的全部信息 —— 头像、名字、等级、经验条与「120/347」、五项属性（生命/魔法/攻击/攻速/距离，各带每级成长）、技能（爆头冲击 · 被动 · 效果文案）、一个青绿主按钮「升 级」、可升级用的经验 1,280、解锁用的金币 640、关闭入口。**布局如何分区、每块多大、留白怎么留，全部由 AI 自己分析决定**。

**英文提示词**

```text
This is a flat layout concept for a modal popup in a mobile game, drawn face-on as it would appear on a vertical phone screen, with no device frame, no perspective and no drop shadow. The whole screen behind the popup is a warm off-white paper field laid over by one even sheet of flat black, and a single white panel with generously rounded corners floats in the middle of that darkened field, well clear of every edge. The popup is about one hero, and how its contents are arranged, how large each part is and how the information is grouped are all left open, so the panel simply has to show everything listed here in whatever order and grouping reads most clearly. At the head of the popup stands the hero: a flat white stencil portrait of a musketeer in a wide-brimmed hat and round goggles, set on a rounded square of muted brick red, with the name "火枪" in large dark slate type and the small teal pill "LV.12" close beside it. Near the name sits the hero's experience: a thin rounded bar filled in flat teal a third of the way across, the pale grey text "120 / 347" at its end, and one short line of small grey text explaining that the next level costs 347 experience. Elsewhere in the panel the hero's five attributes are listed, each one a small flat white glyph with a slate name, a larger dark value and a small pale note of how much it grows per level: "最大生命 452 +12/级", "最大魔法 120", "攻击力 73 +3/级", "攻击速度 120%", "攻击距离 250". The hero's single skill appears as a rounded skill tile in flat teal holding a small white glyph of a bullet and an impact ring, with the name "爆头冲击（被动）" beside it and two short lines of grey text reading "普攻附带 5% 攻击力的额外伤害；15% 概率击退敌人 1m". One single main button sits in the popup, a teal pill with the white label "升 级" and a small white arrow, and next to that button stands the resource it spends: a small experience emblem with the number "1,280". A second read-out shows a small round gold coin glyph with "640" beside it in warm gold, which is the currency used to unlock a hero rather than to raise one, and a thin slate circle with a white cross sits at one corner of the panel as the way out. Every surface in the picture is one flat tone from edge to edge, with no gradient, no cast shadow, no glow, no bevel and no texture on anything, and light plays no part in the picture at all, so the palette is held to one cool ink family for all type and glyphs, one teal used only for the button, the progress fill and the skill tile, one muted brick red for the hero portrait only, and one warm gold for the currency read-outs only. The panel sits centred in the frame with generous even margins, the popup is quiet and easy to scan, and the flat picture reads as a printed diagram of a modal dialog rather than as a photograph of a device.
```

**短版（同图简写 · ~189 词 · 上下文紧张或先试一版时用）**

```text
Flat minimal mobile game popup, portrait: a warm off-white screen dimmed by one even sheet of seventy percent black with a single white rounded panel floating in the middle of it. The panel is the detail sheet of one hero: a flat white stencil portrait of a musketeer on a muted brick red tile, the name "火枪", a small teal pill "LV.12", a thin teal experience bar with the pale grey text "120 / 347", a list of five attributes each with a small white glyph, a slate name and a dark value, one teal-tiled skill icon with the name "爆头冲击（被动）" and two lines of grey text, one single teal pill button labelled "升 级" with a small white arrow, a small experience emblem showing "1,280", a small gold coin glyph showing "640", and a thin slate cross to close it. How the panel is divided and how large each part is are left open. Everything is one flat tone with no gradient, no shadow, no glow and no texture, in a palette of one cool ink family, one teal, one muted brick red and one warm gold only.
```

**未解锁态怎么画**（不是单独一条，把下面三处换掉即可）：

- 头像上盖一把白色小锁，英雄信息整块变灰
- 去掉等级与经验（未解锁没有档案）
- 唯一的主按钮文案变「解 锁」，旁边换成**金币**价 675（而非经验）

### 1.3 极简版（只列内容 · 想先试一版时用）

```text
画一个手游的「英雄详情」弹窗（竖屏，模态浮层，全屏遮罩 + 白色圆角面板浮在中间）。
面板里显示：英雄头像、名字「火枪」、等级「LV.12」、经验条与「120/347」、
五项属性（最大生命 452 +12/级、最大魔法 120、攻击力 73 +3/级、攻击速度 120%、攻击距离 250）、
一个技能（爆头冲击 · 被动 · 效果文案）、一个主按钮「升 级」（花 347 经验）、
持有的通用英雄经验 1,280、金币 640、关闭入口。
布局、分区、尺寸、留白你自己分析决定，只要这几项都在、且一眼能找到「等级经验」和「升级按钮」。
风格：浅色纸面低多边形几何、大留白、零渐变零投影零发光；墨色阶文字 + 青绿操作色 + 暗红英雄色 + 暖金货币色；
字号只用 40/24/20/16/14/12，圆角只用 4/8/16。
```

---

## 2. 要新出的 2 个属性图标（白描，1:1 → 64×64）

面板要显示英雄**真配了的 5 项属性**，而 `textures/property/` 只有 `atk` / `defence` / `atk_range` ——
**缺「攻击速度」与「最大魔法」**（这正是英雄卡一直不显示攻速的原因）。这两个是要出图的。

| # | key | 是什么 | 用在哪 | 装机路径 |
|---|---|---|---|---|
| 1 | `hero_attr_atk_speed` | 属性图标 · 攻击速度 | 详情面板属性行「攻击速度」（20×20）；英雄卡若将来显示攻速也用它 | `textures/property/atk_speed` |
| 2 | `hero_attr_mana` | 属性图标 · 最大魔法 | 详情面板属性行「最大魔法」（20×20） | `textures/property/mana` |

**规格**：出图 512×512（1:1）→ 交付 **64×64 RGBA**；主体**纯白 `#FFFFFF` 单色**（不透明像素只许一个白）；
出图画在**深板岩灰 `#445054`** 承载底上，本地按四边采样**色键抠掉** → 真透明，可用 `Sprite.color` 染色。
风格段 `import` 自 `tools/hero-icon-prompts/gen-prompts.mjs`（与英雄头像 / 技能图标 / 难度徽记同一份）。

### 2.1 `hero_attr_atk_speed`　属性图标 · 攻击速度

- 交付：`hero_attr_atk_speed.png`　**64×64**　装机：`textures/property/atk_speed`
- 中文（校对用，**不投递**）：攻击速度图标：一个指向右的实心三角箭头（楔形，背面竖直），左方紧挨三条平行横杠（自上而下一条比一条长），三角正中挖一个小圆孔，底部一条通底短横杠把重量压住。

**英文提示词**

```text
This is a small interface icon for a mobile game: a single object or symbol treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included. A single speed mark filling the centre of the square: one broad arrowhead pointing to the right, drawn as a solid triangular wedge with a straight vertical back edge and a sharp tip, sitting on the horizontal centre line a little to the right of the middle of the frame. Immediately to the left of the wedge three parallel horizontal bars are stacked one above the other with clear even gaps between them, all three the same thickness and each bar a little longer than the one above it, so the three bars read as a short ladder of motion streaks running toward the wedge. One small round hole is punched clean through the middle of the arrowhead, a short solid baseline runs along the bottom of the frame under both the bars and the wedge, and the whole mark is squared off so that its total width and its total height come out very nearly equal. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the straight edges, the sharp corners, the round holes punched through it, the slots and notches cut into its outline — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

### 2.2 `hero_attr_mana`　属性图标 · 最大魔法

- 交付：`hero_attr_mana.png`　**64×64**　装机：`textures/property/mana`
- 中文（校对用，**不投递**）：最大魔法图标：一颗直立的水滴（下半是饱满的圆、上半均匀收成一个窄尖，尖端切平），水滴正中挖一个较小的同形水滴孔，下方再挖一个小圆孔，左右两侧各悬一段短横杠，底部一个短柄通底。

**英文提示词**

```text
This is a small interface icon for a mobile game: a single object or symbol treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included. A single upright droplet standing at the centre of the square: a solid form whose lower half is one broad even circle and whose upper half tapers smoothly to a narrow tip, and that tip is cut flat straight across the very top. A second, smaller droplet of the same shape is cut clean through the middle of the big one as open space, and one small round hole is punched through the solid part just below that opening. A short horizontal bar stands off to the left of the droplet and another to the right, both at the height where the droplet is widest, each separated from the droplet by a clear gap of even width, and a short thick stub sits under the lowest point of the droplet so the mass is squared off along the bottom of the frame and its height matches its width. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the straight edges, the sharp corners, the round holes punched through it, the slots and notches cut into its outline — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

> ⚠ 两条防撞形要求（**这是这套图标唯一的构图硬指标**）：
> `hero_attr_atk_speed` 不能像 `property/atk`（斜匕首）或 `property/atk_range`（圆盘 + 同心弧）；
> `hero_attr_mana` 不能像 `common/gold`（圆盘挖 ¥）、`common/energy`（闪电）或 `common/exp_icon`（青绿菱形）。

---

## 3. 这些一律不要出图

| 要什么 | 用什么 | 说明 |
|---|---|---|
| 面板底 / 圆角 / 描边环 | `common/rect_rd_20` · `rect_rd_10` · `rect_rd_5` · `rect_board_rd_*` | 九宫格贴图 + 运行时染色；**不要出"面板底纹"图**（风格禁止材质） |
| 关闭 × / 未解锁锁 / 角饰 | `common/close` · `common/lock` · `common/conor` | 现成的白描挖空图 |
| 英雄头像 / 技能图标 | `textures/heros/*` · `textures/skills` 图集 | 10 个英雄都有；技能图走 `common/AtlasIcon.ts` 三级降级 |
| 生命 / 攻击 / 护甲 / 攻击距离图标 | `common/heart` · `property/atk` · `property/defence` · `property/atk_range` | 已有；本次只补缺的**攻速**与**魔法**两个 |
| 经验 / 金币 / 升级箭头图标 | `common/exp_icon`（青绿本色）· `common/gold`（染 `c-gold #D38C1E`）· `common/right` | 金币图标**必须染成 `#D38C1E`**（工程历史上"两态色把金币图标染了"当 bug 记过） |
| 进度条 / 分隔线 | `rect_rd_20` 九宫格 + `Sprite.color` · `cc.Graphics` | 填充 `#70ACB3`、轨道 `#D8D8D8`；线是代码画的 |
| **所有文字与数字** | **`cc.Label`** | **绝不出图**：英雄名 / 等级 / 经验数字 / 属性名与值 / 技能名与效果 / 按钮文案 —— 出了就不可本地化、不可改字号、不可染色 |

---

## 4. 怎么投递

```powershell
# 0) 生成/刷新清单（幂等）
node tools/hero-detail-prompts/gen-prompts.mjs

# 1) 2 个属性图标：Resolution Selector = 1:1 / 0.25MP
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/hero-detail/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/hero-detail-icons-out --skip-existing --free-every 0 --unload-every 0 `
  --only hero_attr_atk_speed,hero_attr_mana

# 2) 弹窗效果图：Resolution Selector 改成 9:16 后跑这一条（输出目录不同）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/hero-detail/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/hero-detail-scenes-out --skip-existing --only hero_detail_popup
```

### 4.1 出完图怎么处理与装机（**只对 2 个图标**）

```powershell
# 3) 色键抠底 + 拍平白 + 正方形包围盒 → 64×64
python tools/hero-icon-prompts/make-hero-icons.py `
  --src .tmp/hero-detail-icons-out --dst .tmp/hero-detail-icons-final `
  --prompts docs/hero-detail/prompts.json

# 4) 体检（真 alpha / 正方形 / 64×64 / 留白 / 纯白比例）
#    ⚠ 必须带 --prompts，否则它按**英雄那份**清单取期望边长（本清单的 key 不在里面 → 尺寸检查被跳过）
python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/hero-detail-icons-final `
  --prompts docs/hero-detail/prompts.json --limit 20

# 5) 装机（缺省只演练，看清楚再 --apply；装完切回 Cocos 窗口让它导入生成 .meta）
python tools/hero-icon-prompts/install-hero-icons.py `
  --src .tmp/hero-detail-icons-final --prompts docs/hero-detail/prompts.json --apply
```

> ⚠ **弹窗效果图不跑第 3 步**（跑了会把概念稿毁掉），也不用装机：存成 `docs/hero-detail/popup.png` 就完事。
> ⚠ `textures/property/atk_speed.png` 与 `mana.png` 是**新文件**，`.meta` 要等 Cocos 编辑器首次导入才生成，**必须随提交入库**。

---

## 5. 验收清单

- [ ] 效果图里看得出来**这是一个弹窗**：全屏遮罩 + 浮在中间的面板 + 背景被压暗；
- [ ] 12 项内容**一项不缺**：头像 / 名字 / 等级 / 经验条与数字 / 5 项属性（含每级成长）/ 技能 / 一个主按钮 / 升级所需经验 / 持有经验 / 金币 / 关闭入口 / 未解锁态说明；
- [ ] **只有 1 个主按钮**，且看得出「可升级 / 经验不足」两态；
- [ ] 升级花的是**经验**（不是金币），金币只出现在解锁语境里；
- [ ] 一屏只有**一个**强调色家族（青绿），没有第四种颜色；暗红只在头像上、暖金只在货币上；
- [ ] 没有渐变、没有投影、没有发光、没有材质纹理；
- [ ] 面板里**自带资源读数**（不能假设玩家看得到主界面顶栏）；
- [ ] 2 个图标与 `property/atk` `property/defence` `property/atk_range` `common/heart` **摆成一行看不出是两批出的图**；
- [ ] 每张图标 `形变 ≤ 1.15×`（后处理打印；超了改**具体构图动作**再跑，别接受形变）；
- [ ] 图标**缩到 20×20** 还认得出，且染成 `#6A696B` 与 `#70ACB3` 两种色都读得清；
- [ ] 效果图里的文字**只当版式锚点**（错字不算不合格），但「升级按钮」与「等级经验」必须一眼找得到。
