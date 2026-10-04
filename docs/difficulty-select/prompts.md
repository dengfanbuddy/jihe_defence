# 难度选择弹窗 · AI 生图提示词清单（Qwen-Image-2.1）

> 本文件由 `node tools/difficulty-icon-prompts/gen-prompts.mjs` 生成，**别手改** —— 改内容改生成器。
> 同目录另有 `prompts.json`（机读，直接喂装机脚本）与 `prompts.csv`（投递，直接喂批量脚本）。

**一共 14 条**：12 个白描徽记（1:1，交付 64×64）+ 2 张大图（9:16 / 16:9，只做缩放、**不抠底**）。

---

## 0. 这批图要画什么（设计口径）

| 项 | 口径 |
|---|---|
| 总量 | **100 档难度** = **10 段 × 10 档** |
| 段页签 | 10 个（`1~10` / `11~20` / … / `91~100`），每段一个**段徽记** → 这是本清单的主体 |
| 三态 | **当前选择**（青绿描边环 + 右上角角标 + 青绿数字）、**已解锁**（白底 + 细灰边 + 墨色数字）、**未解锁**（`#D8D8D8` 底 + 白色小锁 + 淡灰数字） |
| 头目门槛 | **每 10 档**（第 10 / 20 / … / 100 档）用 `diff_boss_gate` 标出，是段末档，格子略宽 |
| 解锁规则 | 通关第 N 档 → 解锁第 N+1 档；**跨越 10 的倍数那档（头目档）要额外打一次** |
| 视觉语法 | **形状即段位**：十段徽记的台阶数 1→10 递增，**颜色完全不参与区分段位**（符合 `docs/美术风格预设.md` §9-4「档位差靠体型与徽记附件，不靠换色相」） |

### 0.1 为什么只有 14 条，而不是 100 条

这个弹窗**绝大部分不需要 AI 出图** —— 骨架是「九宫格贴图 + 纯色 + Label」，现成素材已经齐了。
**下面这些一律不要出图**（出了就是白花钱，而且会和现有 UI 撞风格）：

| 要什么 | 用什么 | 说明 |
|---|---|---|
| 弹窗面板底 / 圆角 | `common/rect_rd_20` | 九宫格纯白圆角，运行时按需染色；**不要出"面板底纹"图**（风格禁止材质） |
| 选中描边环 | `common/rect_board_rd_20` | 只描边不填充，烘焙色 `#6FA9A7`；当前选择态直接用 |
| 小/中圆角格 | `common/rect_rd_5` / `rect_rd_10` | 段页签、难度格底 |
| 选中角标 / 已通关勾 | `common/conor` / `common/gou` | 白色，运行时染青绿；三态里的"当前选择"和"已通关"都用它俩 |
| 未解锁锁 | `common/lock` | 白色，盖 `#747474` 遮罩 —— **难度格这一级够用了**，`diff_lock_seal` 只是段页签上的可选加强 |
| 关闭 × | `common/close` | 弹窗右上角 |
| 纯色块 | `common/white_4x4` | 所有实心底（青绿按钮底、灰遮罩底） |
| 分隔线 / 范围线 | `cc.Graphics` | `#D8D8D8` 细线，代码画，不出图 |
| **100 个难度数字** | **`cc.Label`** | **绝不出图**：100 张图、不可本地化、不可改字号、不可染色 |
| 难度格的三态底色 | 预制件 `_color` | 白 / 白+青绿环 / `#D8D8D8`+遮罩 —— 颜色不是资产 |

---

## 1. 出图规格

| 项 | 白描徽记（12 条） | 大图（2 条） |
|---|---|---|
| 出图尺寸 | 512×512（1:1，0.25 MP） | 按各自比例出一整张（`diff_ladder` 16:9、`diff_concept_ui` 9:16） |
| 交付 | **64×64 RGBA** | `diff_ladder` 等比缩到宽 750；`diff_concept_ui` 只留源图 |
| 主体色 | **纯白单色**（白描；不透明像素只许有一个白） | 大图按各自提示词（青灰明度阶 / 双色 UI） |
| 背景 | 出图画在**深板岩灰 `#445054`** 上，**本地四边采样色键抠掉** | 透明底（ladder）/ 实底（concept_ui） |
| 后处理 | `make-hero-icons.py`：色键 → 拍平白 → **正方形包围盒** → 缩到 64 | **只做 Lanczos 缩放**，⚠ **不要**跑 `make-hero-icons.py` |
| 装机 | `textures/difficulty/<key>`（不带扩展名） | `textures/difficulty/ladder`；概念稿不入库 |

> ⚠ **包围盒必须正方形**：槽位是 `sizeMode=CUSTOM` + `trim=true`，包围盒非方会被拉伸。
> 判据是后处理打印的 `形变=…×`：**> 1.15 要改提示词，不要接受形变**（技能图标那轮的返工点，见 `docs/skill-icons/README.md` §7.5）。

---

## 2. 共享风格段（白描徽记，**不要改这里**）

`DRAWING` / `BACKGROUND` / `LIGHT` / `SQUARE` / `CLOSE` 全部 `import` 自 `tools/hero-icon-prompts/gen-prompts.mjs`
（真源），与**英雄头像 / 技能图标**是同一份 —— 改风格请改真源，然后连这三套一起重跑。

**只有三处是按题材改写的**（都写在生成器里，改的是"画什么"不是"怎么画"）：
`KIND`（英雄那版写的是"头像/人物"）、`READING`（英雄那版点名帽檐/武器，这里点名台阶数与顶上那件东西），
外加 `DRAWING` 的**第二句** —— 原句列的是 `the eyes, the mouth, the folds of cloth, the openings in armour`，
那是**人物**的细节清单，喂给"阶梯工事"既白占注意力、又有把模型带向"画一个头"的真实风险，所以换成了台阶/垛口/门洞/槽孔。

> **画法**：The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind.

> **题材细节**：Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size.

> **光照**：Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap.

> **底与锚**：No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square.

> **构图**：The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge.

> **承载底**：The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge.

> **收尾**：The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.

> ⚠ **承载底那句只做正向陈述**：这是踩过两次的坑（`docs/relic-icon/README.md` §2）——
> 一提到「贴到浅灰板上」模型就把浅灰板画出来；改写成「不许是白的/不许是灰的」又烘焙了一张近白底板（否定式在 `cfg 1` 下不可靠）。
> 这句底是给 `make-hero-icons.py` **按四边采样色键抠掉**的，抠完就是真透明。

---

## 3. 资产清单

### 3.1 白描徽记（12 条，1:1，交付 64×64）

| # | key | 是什么 | 用在哪 | 装机路径 | 优先级 |
|---|---|---|---|---|---|
| 1 | `diff_tier_01` | 第 1 段 · 新兵（难度 1~10） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_01` | P0 |
| 2 | `diff_tier_02` | 第 2 段 · 老兵（难度 11~20） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_02` | P0 |
| 3 | `diff_tier_03` | 第 3 段 · 精锐（难度 21~30） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_03` | P0 |
| 4 | `diff_tier_04` | 第 4 段 · 尖兵（难度 31~40） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_04` | P0 |
| 5 | `diff_tier_05` | 第 5 段 · 猎手（难度 41~50） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_05` | P0 |
| 6 | `diff_tier_06` | 第 6 段 · 督军（难度 51~60） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_06` | P0 |
| 7 | `diff_tier_07` | 第 7 段 · 破阵（难度 61~70） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_07` | P0 |
| 8 | `diff_tier_08` | 第 8 段 · 铁壁（难度 71~80） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_08` | P0 |
| 9 | `diff_tier_09` | 第 9 段 · 屠城（难度 81~90） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_09` | P0 |
| 10 | `diff_tier_10` | 第 10 段 · 终焉（难度 91~100） | 段页签（10 个一横排）＋ 详情条左侧 | `textures/difficulty/diff_tier_10` | P0 |
| 11 | `diff_boss_gate` | 头目门槛 | 每 10 档的段末格（右下角小标）＋ 门槛提示 | `textures/difficulty/diff_boss_gate` | P0 |
| 12 | `diff_lock_seal` | 未解锁封印 | 未解锁的段页签（盖在段徽记上） | `textures/difficulty/diff_lock_seal` | **P2 可选** |

### 3.2 大图（2 条，不进 `items[]`）

| key | 是什么 | 比例 | 装机 | 优先级 |
|---|---|---|---|---|
| `diff_concept_ui` | 整屏概念稿 | 9:16 | 不进工程（只给评审/施工参考，落 docs/difficulty-select/concept.png） | P0 |
| `diff_ladder` | 弹窗顶部主插图 | 16:9 | 装机：textures/difficulty/ladder（透明底，横向铺满后按 2.9:1 裁中段） | P0 |

---

## 4. 逐条提示词

### 4.1 白描徽记（12 条 · 1:1 · 投给 ComfyUI 的是「英文提示词」那一栏）

#### `diff_tier_01`　第 1 段 · 新兵（难度 1~10）

- 交付：`diff_tier_01.png`　**64×64**　装机：`textures/difficulty/diff_tier_01`
- 中文（校对用，**不投递**）：难度段徽记（难度 1~10 · 新兵）：纯白单色白描，一座 1 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A squat stone plinth standing alone at the centre of the square, drawn as one chunky rectangular block with one wide shallow step cut across its front so a broad tread runs from the left edge of the block to the right. One thick slab lies flat on top of the block and overhangs it on both sides, and that overhanging slab is what pushes the silhouette out to the full width of the frame. A single narrow tally notch is cut down the middle of the plinth's front face, and one small round hole is punched clean through the middle of the top slab. Two short buttresses flank the block, one at each side, each separated from the plinth by a wide open slot, and both buttresses run down to the bottom edge of the frame so the whole mass sits low and broad with its weight spread evenly. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_02`　第 2 段 · 老兵（难度 11~20）

- 交付：`diff_tier_02.png`　**64×64**　装机：`textures/difficulty/diff_tier_02`
- 中文（校对用，**不投递**）：难度段徽记（难度 11~20 · 老兵）：纯白单色白描，一座 2 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A two-step stair rising from the lower left toward the upper right, the lower step broad and the upper step narrower so the two treads read as one short flight climbing across the square. On the upper step a short thick post stands upright, and from the top of that post a small triangular pennant flies out to the right with a swallow-tailed notch cut into its trailing edge. A row of four square tally notches is punched along the front face of the lower step, evenly spaced, and a thin plinth runs under the whole stair from the left edge of the frame to the right so the base is squared off. One round hole is cut through the pennant near the post, and the post is split from the step beneath it by a narrow open slot. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_03`　第 3 段 · 精锐（难度 21~30）

- 交付：`diff_tier_03.png`　**64×64**　装机：`textures/difficulty/diff_tier_03`
- 中文（校对用，**不投递**）：难度段徽记（难度 21~30 · 精锐）：纯白单色白描，一座 3 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A three-step stair climbing from the lower left to the upper right, each step narrower than the one below it, with every tread left as a wide flat band of solid white. Planted in front of the stair, at the lower right of the square, stands a round shield seen face-on, its rim a thick ring and its boss a smaller ring cut clean through the middle, with a vertical slot and two round holes punched between the rim and the boss. A thin plinth runs under both the stair and the shield from edge to edge of the frame, and three square tally notches are cut along the lowest step. Two low posts stand at the top of the stair and frame the upper corner, so the mass rises to the top edge of the frame as well as filling its width. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_04`　第 4 段 · 尖兵（难度 31~40）

- 交付：`diff_tier_04.png`　**64×64**　装机：`textures/difficulty/diff_tier_04`
- 中文（校对用，**不投递**）：难度段徽记（难度 31~40 · 尖兵）：纯白单色白描，一座 4 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A steep flight of four shallow steps climbing from the lower left corner to the upper right corner, the steps packed close together so they read as one long diagonal ramp notched into four treads. At the top of the flight, on the highest tread, a short thick torch stands upright, and its flame is cut as three tapered tongues of open space rising from a wide bowl with two round holes punched through the bowl's rim. A heavy squared base block sits under the bottom of the flight and runs out to both side edges of the frame. Four tally notches are cut across the front of that base, and a band of two parallel slots is cut along the side of the flight to hold the diagonal together. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_05`　第 5 段 · 猎手（难度 41~50）

- 交付：`diff_tier_05.png`　**64×64**　装机：`textures/difficulty/diff_tier_05`
- 中文（校对用，**不投递**）：难度段徽记（难度 41~50 · 猎手）：纯白单色白描，一座 5 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A five-level tower standing at the centre of the square, each level a plain rectangular band slightly narrower than the level beneath it, so the whole mass steps inward as it rises to a flat top. A broad band is wrapped around the middle level and juts out past that level on both sides as a ledge, and that ledge is what carries the full width of the frame. Five narrow vertical slots are cut through the tower's face, one for each level, evenly spaced in a single column up the middle, and two small round holes are punched at the corners of the top level. A thin base skirt flares out at the bottom of the tower and reaches both side edges of the frame. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_06`　第 6 段 · 督军（难度 51~60）

- 交付：`diff_tier_06.png`　**64×64**　装机：`textures/difficulty/diff_tier_06`
- 中文（校对用，**不投递**）：难度段徽记（难度 51~60 · 督军）：纯白单色白描，一座 6 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A six-level tower rising at the centre of the square, each level a plain band a little narrower than the one below it, stacked into a stepped mass that reaches the top edge of the frame. Two tall pennants are planted on the shoulders of the tower, one on the left and one on the right, each a squared flag on a short thick staff with a wide notch cut out of the flag's outer edge, and the two flags spread the silhouette out to the full width of the frame. Six square tally notches are punched in a column up the middle of the tower's face, one for each level, and a ring of small round holes is cut around the base skirt where it flares out to meet the bottom of the frame. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_07`　第 7 段 · 破阵（难度 61~70）

- 交付：`diff_tier_07.png`　**64×64**　装机：`textures/difficulty/diff_tier_07`
- 中文（校对用，**不投递**）：难度段徽记（难度 61~70 · 破阵）：纯白单色白描，一座 7 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A seven-level tower filling the centre of the square, each level stepped in a little from the one below, and along the very top of the tower a crenellated parapet runs the full width with six square merlons cut apart from one another by wide open gaps. A deep arched opening is cut clean through the lowest level of the tower, and inside that opening a heavy portcullis hangs as a grid of three uprights crossed by three bars with open space between them. Seven narrow slots are cut in a single column up the tower's face, one for each level, and two small round holes are punched at the base of the tower where it flares out to meet the bottom edge of the frame. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_08`　第 8 段 · 铁壁（难度 71~80）

- 交付：`diff_tier_08.png`　**64×64**　装机：`textures/difficulty/diff_tier_08`
- 中文（校对用，**不投递**）：难度段徽记（难度 71~80 · 铁壁）：纯白单色白描，一座 8 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A broad eight-level keep standing at the centre of the square, each level stepped in from the one below it so the walls climb in eight shallow stages. Four small round turrets stand at the four upper corners of the keep, each capped with a cone, and the two outer turrets push the silhouette out to both side edges of the frame. Eight narrow vertical slots are cut in a single column up the middle of the keep's face, one for each level, and a heavy base skirt flares out at the bottom with a row of five square notches cut along its front. A single arched doorway is cut through the lowest level, and one round hole is punched through the cap of each turret. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_09`　第 9 段 · 屠城（难度 81~90）

- 交付：`diff_tier_09.png`　**64×64**　装机：`textures/difficulty/diff_tier_09`
- 中文（校对用，**不投递**）：难度段徽记（难度 81~90 · 屠城）：纯白单色白描，一座 9 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A nine-level spire rising at the centre of the square, each level a band narrower than the one below it, so the tower tapers in nine even stages to a pointed roof. A long jagged fissure is cut clean through the tower from the upper left down to the lower right, splitting the bands it crosses and leaving a zigzag of open space that runs the full height of the building. Nine square tally notches are punched in a column up the left side of the tower's face, one per level, and a broken ring of six short tapered spikes fans out around the base, each spike separated from its neighbours by an open gap, so the foot of the tower spreads to the full width of the frame. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_tier_10`　第 10 段 · 终焉（难度 91~100）

- 交付：`diff_tier_10.png`　**64×64**　装机：`textures/difficulty/diff_tier_10`
- 中文（校对用，**不投递**）：难度段徽记（难度 91~100 · 终焉）：纯白单色白描，一座 10 级阶梯工事，靠「实心白块 + 内部挖空」表达；深板岩灰纯色承载底（出图后本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A ten-level tower rising at the centre of the square, each level stepped in from the one below until the stack tapers to a narrow crown at the top, and that crown is cut as a band of five tall points separated by open gaps with a small round hole punched through the middle point. Two squared wings are cut out of the tower's shoulders, one on the left and one on the right, each spreading outward and downward to the side edges of the frame like the buttresses of a fortress. Ten narrow slots are cut in a single column up the middle of the tower's face, one for each level, and a heavy plinth flares out at the bottom with a row of seven square notches along its front edge. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_boss_gate`　头目门槛

- 交付：`diff_boss_gate.png`　**64×64**　装机：`textures/difficulty/diff_boss_gate`
- 中文（校对用，**不投递**）：头目门槛徽记：两座方塔夹一道尖拱门洞、门楣上一个圆孔、塔顶各三齿垛口、通底横基座带三个刻痕。纯白单色白描 + 内部挖空；深板岩灰承载底（本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A fortified gateway standing at the centre of the square: two thick square towers of equal height flank a wide arched opening between them, and that arch is cut clean through as open space with a pointed top and a keystone notch at its crown. Both towers carry a row of three square merlons along their flat tops, and a heavy lintel runs across from tower to tower above the arch with a single round hole punched through its middle. Five narrow vertical slots are cut in a column up the face of each tower, and a wide base step runs under both towers from the left edge of the frame to the right with three square tally notches cut along its front. Two short braces lean against the outer sides of the towers, each separated from its tower by an open slot, so the whole gate spreads to the full width of the frame. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

#### `diff_lock_seal`　未解锁封印　（P2 可选）

- 交付：`diff_lock_seal.png`　**64×64**　装机：`textures/difficulty/diff_lock_seal`
- 中文（校对用，**不投递**）：未解锁封印徽记：粗环 + 内圈 + 圆盘，盘中央挖一个带齿的锁孔，外环十二道短刻齿、四正方向各一个圆孔。纯白单色白描 + 内部挖空；深板岩灰承载底（本地色键抠掉）；正方形居中，四周留白充足。

**英文提示词**

```text
This is a difficulty-rank emblem for a game interface: a single stepped structure or fortified symbol treated as a bold graphic sign rather than as an illustration, with no character, no landscape and no background scene of any kind. A heavy round seal filling the centre of the square, drawn as one thick ring with a wide flat rim and a raised inner band, and a plain disc sitting inside that band. Down the middle of the disc a keyhole is cut clean through: a round hole with a long tapered slot dropping from it and two short square teeth cut out of the slot's lower end. Twelve short tapered notches are cut around the outer rim, evenly spaced, each separated from its neighbours by a solid length of rim, and a small round hole is punched through the rim at each of the four cardinal points. Two short squared tabs stick out on the left and right of the seal, and together with the rim they spread the silhouette out until its width and its height come out even. The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil. Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the stepped treads, the merlons, the arched openings, the slots cut through the walls, the rings of small round holes — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines. The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo. There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind. Every level, tread, merlon, slot and opening is a plain four-sided or round form, the levels stack squarely on top of one another, and every opening is wide enough to stay clean at small size. Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap. The emblem is built to be recognised instantly at the size of a small square badge: the stepped silhouette and the single object standing on the top step — a pennant, a shield, a torch, a tower, a crown — stay unmistakable at a single glance. The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge. No ground plane, no horizon, no sky and no second building appear anywhere in the picture, and the lowest level spreads out to both side edges of the frame so the mass is anchored along the bottom of the square. The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge. The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.
```

### 4.2 大图（2 条 · 比例不同，**必须单独分批投**）

> ⚠ 这两张**不是**白描徽记：`diff_concept_ui` 是整屏 UI 概念稿（**只给评审**，不进工程），
> `diff_ladder` 是等距白模插图（**透明底**）。**都不要跑 `make-hero-icons.py`**。

#### `diff_concept_ui`　整屏概念稿

- 比例 **9:16**　装机：不进工程（只给评审/施工参考，落 docs/difficulty-select/concept.png）
- 中文（校对用，**不投递**）：整屏概念稿：米白纸面上的白色大圆角面板，标题「难度选择」，10 个段页签、5×4 的难度格（含三种状态）、详情条、青绿主按钮「开始挑战」。

**英文提示词**

```text
This is a flat layout concept for a mobile game's difficulty-selection popup, drawn face-on and edge to edge as it would appear on a vertical phone screen, with no device frame, no perspective, no drop shadow and no scene behind the interface. The whole screen is filled with one uniform warm off-white paper tone, and floating in the middle of that field, well clear of every edge, is a single tall white panel with generously rounded corners. Along the top of the panel the title reads "难度选择" in dark slate Chinese characters set to the left, and in the top right corner a thin slate cross sits alone as the close control. A single hairline rule runs the full width of the panel just under the title, and beneath it a small line of pale grey text reads "当前 难度 37 · 已解锁 42 / 100". Below that line, ten small square chips are laid out in one horizontal row, each a rounded white tile carrying a small flat white emblem of a stepped tower, and the chips grow narrower and simpler toward the right. Under the row of chips the main body of the panel is a grid of twenty rounded square cells, five across and four down, evenly spaced and all the same size, filling the middle of the panel. Most of the cells are plain white with a hairline grey border and a dark slate two-digit number set in the upper left of each one; one single cell is ringed by a thick teal outline with a small teal corner triangle at its upper right and its number set in teal; and a few cells are filled with a flat pale grey instead of white, each carrying a small white padlock at its centre with its number set faintly in pale grey. Every tenth cell along the grid is a little wider and carries a small flat white gateway emblem at its lower right corner. Under the grid a small row of five dots sits centred, the first one teal and the rest pale grey. Along the bottom of the panel a wide white rounded strip holds a small stepped emblem at its left and two short lines of slate text beside it, and below that strip one large teal pill-shaped button stretches across the panel with the white words "开始挑战" centred on it. The palette holds exactly two families and never a third: a slate ink running from dark to pale, and one teal for everything the player can act on, with the warm off-white and the flat white carrying every surface. Light plays no part in the picture at all: every surface is a single flat tone with no gradient, no shading, no highlight, no bevel and no texture anywhere, and the only lines are thin even rules of one flat colour. The picture is calm and orderly, with generous empty margins inside the panel and plenty of untouched paper tone around it, the whole interface reading as a tidy engineering drawing rather than a decorated screen.
```

#### `diff_ladder`　弹窗顶部主插图

- 比例 **16:9**　装机：装机：textures/difficulty/ladder（透明底，横向铺满后按 2.9:1 裁中段）
- 中文（校对用，**不投递**）：主插图：等距低多边形白模「十级台阶」从左向右升高，顶上一顶小冠，四档青灰明度阶，无描边无投影，主体压在画面中段、上下留空（便于裁成横幅）。

**英文提示词**

```text
This is a wide banner illustration of a stepped structure, rendered as a clean untextured low-polygon model seen from an isometric angle, and the structure stands alone with nothing else in the frame. Ten flat platforms climb from the left of the picture to the right in even stages, each one a plain rectangular slab a little taller and a little deeper than the one before it, so the whole run reads as a single staircase rising steadily toward the right side of the frame. The lowest platform sits at the left, broad and low, and the highest platform stands at the right, narrow enough to read as a summit, with a small blocky crown resting on top of it and a short squared post beside the crown. A few of the middle platforms carry one small marker each — a flat upright panel on the third, a low square block on the sixth, a thin post on the ninth — and every marker is a plain solid form of the same simple kind as the platforms themselves. Each platform is built from clean flat faces meeting at hard straight edges, and every face is filled with one flat tone drawn from a four-step muted blue-grey ramp that runs from a deeper slate blue at the shadowed side up to a pale silvery grey on the top surfaces, so the whole model reads as one quiet family of cool greys. Light plays no part in the picture: there is no gradient across any face, no cast shadow on any surface, no outline along any edge, no highlight, no bevel and no surface texture anywhere. The staircase is squeezed into the middle band of the wide frame, occupying a shallow horizontal strip across the centre while the upper third and the lower third of the picture are left completely empty, so the whole run of steps can be cropped to a narrow strip without losing any part of the structure, and the model is positioned a little left of centre with its summit reaching toward the right.
```

---

## 5. 怎么投递（**按比例分三批**）

> 工作流的 **Resolution Selector 是全局的**，所以比例不同的图必须分批跑（`--only` 过滤 key）。
> 装得下模型就别调 `/free`（调了会把模型逐出显存，每张白付约 13 s —— 见 `docs/relic-icon/README.md` §6.1）。

```powershell
# 0) 生成/刷新清单（幂等）
node tools/difficulty-icon-prompts/gen-prompts.mjs

# 1) 12 个白描徽记：Resolution Selector = 1:1 / 0.25MP
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/difficulty-select/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/diff-icons-out --skip-existing --free-every 0 --unload-every 0 `
  --only diff_tier_01,diff_tier_02,diff_tier_03,diff_tier_04,diff_tier_05,diff_tier_06,diff_tier_07,diff_tier_08,diff_tier_09,diff_tier_10,diff_boss_gate,diff_lock_seal

# 2) 主插图：Resolution Selector 改成 16:9 后重跑同样一条（输出目录不同）
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/difficulty-select/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/diff-scenes-out --skip-existing --only diff_ladder

# 3) 整屏概念稿：Resolution Selector 改成 9:16 后再跑一条
python tools/relic-icon-prompts/comfyui_batch.py `
  --workflow .tmp/comfy_api_base.json --csv docs/difficulty-select/prompts.csv `
  --prompt-node 7 --prompt-key value --route t2i `
  --out .tmp/diff-scenes-out --skip-existing --only diff_concept_ui
```

## 6. 出完图怎么处理与装机

```powershell
# 4) 只处理 12 个徽记：色键抠底 + 拍平白 + 正方形包围盒 → 64×64
python tools/hero-icon-prompts/make-hero-icons.py `
  --src .tmp/diff-icons-out --dst .tmp/diff-icons-final `
  --prompts docs/difficulty-select/prompts.json

# 5) 体检（真 alpha / 正方形 / 64×64 / 留白 ≥8% / 纯白比例）
#    ⚠ 必须带 --prompts，否则它按**英雄那份**清单取期望边长（本清单的 key 不在里面 → 尺寸检查被跳过）
python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/diff-icons-final `
  --prompts docs/difficulty-select/prompts.json --limit 20
#    装机之后还可以按 icon_path 直接查真资源：--installed --prompts docs/difficulty-select/prompts.json

# 6) 装机（缺省只演练，看清楚再 --apply；装完切回 Cocos 窗口让它导入生成 .meta）
python tools/hero-icon-prompts/install-hero-icons.py `
  --src .tmp/diff-icons-final --prompts docs/difficulty-select/prompts.json
python tools/hero-icon-prompts/install-hero-icons.py `
  --src .tmp/diff-icons-final --prompts docs/difficulty-select/prompts.json --apply
```

三件收尾：

1. **大图不跑第 4 步**：`diff_ladder` 用任一缩放工具等比缩到宽 750 后丢进 `assets/resources/textures/difficulty/ladder.png`；
   `diff_concept_ui` 存成 `docs/difficulty-select/concept.png` 就完事（不进 `resources/`，省构建体积）。
2. **`assets/resources/textures/difficulty/` 是新目录**：12 个 `.meta` 要等 Cocos 编辑器首次导入才生成，**必须随提交入库**（否则运行期取不到 spriteFrame）。
3. **先别打图集**：只有 12 张，碎图即可；等这批图超过 ~30 张再照 `docs/skill-icons/README.md` §7 打成 `difficulty.plist` + `difficulty.png`。

---

## 7. 验收清单

- [ ] 12 张徽记**同一套画法**：一个纯白色、描边为零、光照为零、材质为零；
- [ ] **10 个段徽记摆成一行时，台阶数 1→10 的递增看得出来**（这是"段位"的唯一表达）；
- [ ] 每张的 `形变 ≤ 1.15×`（后处理打印；超了改**具体构图动作**再跑，别接受形变）；
- [ ] **缩到真实槽位看**（段页签 56×56、难度格内 40×40）—— 大图看着没问题不算通过；
- [ ] 贴在**青绿 `#70ACB3`** 与**白底**上都读得清（选中态是青绿药丸底、未选中是白底，靠 `Sprite.color` 染色）；
- [ ] 图里**没有文字/数字/水印/边框**；
- [ ] `diff_boss_gate` 与 `diff_tier_10` 不能撞形（前者是"门"，后者是"塔 + 冠"）；
- [ ] `diff_ladder` 是**透明底**且上下各留了 1/3 空白（否则裁成 2.9:1 横幅时会把台阶切掉）。
