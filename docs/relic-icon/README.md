# 遗物图标 · Qwen-Image-2.1 重出图作业手册

**目标**：把 `assets/resources/textures/relics/` 里这 293 张 dota 官方图标（88×64，带卡片底/写实材质），用 ComfyUI + **Qwen-Image-2.1** 重出成**本游戏风格**、**透明背景**的方形图标，文件名不变地覆盖回去。

配套文件：

| 文件 | 是什么 |
|---|---|
| `prompts.json` | **307 条全量数据**：两条路线的完整提示词 + 出图规格 + 参考图路径 |
| `prompts.csv` | 同一份数据的 CSV（BOM + CRLF，Excel / 调度脚本直接读） |
| `prompts.md` | 人读清单：共享风格段全文 + 307 条主题索引 |
| `../../tools/relic-icon-prompts/subjects.json` | **作者数据**（每件道具的英文视觉描述 + 形态分类）—— 改描述改这里 |
| `../../tools/relic-icon-prompts/gen-prompts.mjs` | 生成器（幂等）：`node tools/relic-icon-prompts/gen-prompts.mjs` |
| `../../tools/relic-icon-prompts/comfyui_batch.py` | 批量投递脚本（走 ComfyUI `/prompt` API，**见 §6 的未验证声明**） |
| `../../tools/relic-icon-prompts/check-icons.py` | **交付体检**：真 alpha / 四边留白 / 正方形 / 200×200，违规退出码 1（见 §7） |

> 307 条 = `relics.json` 的**全部行**，不只是现有 293 张图：另有 9 件局外独有中立道具（1294~1302，本地没图）和 5 件手工 demo 遗物（id 1~5）也一并写好了提示词。

---

## 1. 出图规格（先看这条，错了后面白干）

| 项 | 值 | 依据 |
|---|---|---|
| 宽高比 | **1:1 正方形** | `RelicItem.prefab` 的 `content/head/inner` 是 **50×50** 的 Sprite（`sizeMode=CUSTOM` + SIMPLE），代码只换 `spriteFrame` 不改尺寸 → 非正方形素材会被**拉伸**（现在这批 88×64 就是被纵向拉长 1.375 倍的） |
| 生成分辨率 | **1024×1024**（1.0 MP） | 屏幕上只画 50×50，1024 足够；2K（4 MP）纯浪费算力。**512×512 也可以用**（你实测那张就是 512），只是厚涂描边降到 200 时边缘没有 1024 出图干净 |
| 交付尺寸 | **200×200 PNG（RGBA）** | 工程里 UI 图标的既有统一规格：`textures/common/*`、`property/*`、`skills/bullet.png` 全是 200×200 |
| 留白 | **四周各约 1/10**（外轮廓不许顶边） | 你实测那张贴到了左/右/上三边（边距 0.0%/0.0%/0.2%），进 50×50 槽会被底框切掉 |
| 透明 | **必须有 alpha** | 图标槽底下是预制件的底框（品质靠它表现，见 §7），图标自己不能带底 |
| 命名 | `<dota2 key>.png`（= `prompts.json` 的 `out_png`） | 覆盖回去**配表一个字都不用改**（`icon` 列已经是 `textures/relics/<key>`） |

---

## 2. 风格口径（四档预设，**默认 `cartoon`**）

风格段不是一句话，而是**四档预设**，生成时用 `--style` 选：

```bash
node tools/relic-icon-prompts/gen-prompts.mjs                   # 默认 cartoon：明亮卡通（平涂 cel shading + 粗匀描边）
node tools/relic-icon-prompts/gen-prompts.mjs --style project    # 严格美术圣经：低多边形平面几何 + 双色 + 细匀描边
node tools/relic-icon-prompts/gen-prompts.mjs --style dota       # dota 厚涂道具风（实测偏暗黑，用户已否两轮）
node tools/relic-icon-prompts/gen-prompts.mjs --style dota-muted # 同一套 dota 画法 + 颜色收到项目双色
```

`prompts.json` 里的 `style` 字段记录当前是哪一档；**换档重跑会覆盖三份产物**（所以别人开着 `prompts.csv` 时会改写成 `prompts.csv.new` 并退出码 1 —— 关掉 Excel 再跑）。

### 为什么默认换成了 `cartoon`（2026-10 用户口径「要明亮的卡通风格，要符合我们的游戏」）

第一版按用户最初的口径走了 `dota` 厚涂（对齐他发的测试图 `ComfyUI_00014_.png`），**用户看过之后两次反馈「太暗黑」**。逐像素量下来他没错 —— 问题不在"画法"而在**明度**：

| 档 | 明度均值（实测 4 张） | 近黑占比 | 与工程底色的关系 |
|---|---|---|---|
| `dota` 厚涂 | 0.34 ~ 0.41 | 21% ~ 31% | 工程底是**浅色纸面**（局外 `#EFEEED` / 局内 `#EBF4FB`），深色厚涂物体压在上面显得又重又脏 |
| `cartoon` 明亮卡通 | **0.69 ~ 0.81** | **0.0%** | 亮部占 65%~83%，和浅底是一套的 |

更关键的是：**美术圣经本来就写着不许暗**。`docs/art-style/ui-design-prompt.md` §1.3 明令「**禁止**：渐变、投影、发光、纹理、拟物高光」，附录 D 的「AI 常见走偏」第一条就是「**出成暗底 / 霓虹 / 赛博** → 底必须是浅色纸面」。所以 `dota` 档的厚涂材质（划痕/木纹/做旧）是在跟工程自己的规范对打，用户说"要符合我们的游戏"是准确的判断；`cartoon` 档就是**按工程规范写的**：平涂 cel shading、粗匀圆头描边、禁一切装饰性材质、颜色只落在明度亮半边。

> ⚠ 仍存的张力：§1.3 那句「图标一律**几何线稿**（圆/方/三角/菱形/环的组合）；禁止写实图形」严格讲连"卡通道具插画"也不符合。当前按用户口径走卡通道具插画，**如果哪天要回到最严口径就是 `--style project`（一条命令切回，307 条重生成）**。

### 那张测试图暴露的两个必须修的问题（提示词里已经写死）

1. **它其实没有透明背景。** 全图 alpha 最小值 = **237**（没有一处为 0），96% 的像素是 `a=255`；背景那层「浅灰棋盘格」是 `(235,235,235)` / `(248,248,248)` **画进像素里的**（占 61.4% 面积），不是 alpha。放进游戏就是一张灰底方图。→ 请先确认真身：`python -c "from PIL import Image; im=Image.open(r'你的路径'); print(im.mode, im.getchannel('A').getextrema())"`，打印出 `('A', (0, 255))` 才是真透明。若原图也是 `(237, 255)`，就用官方去背景模板（§4）重跑一遍。
2. **主体顶边了。** 把浅灰底当背景抠掉后量包围盒：左边距 **0.0%**、右边距 **0.0%**、上边距 0.2%、下边距 4.5% —— 斧刃与火焰**贴到了左/右/上三边**。50×50 的槽位 + 70×70 的底框下，这种满构图会被框切掉。→ 提示词里补了一句 `MARGIN`，**但提示词只是建议**（实测仍有 6.1%~35.5% 的偏差），真正保证留白的是交付步骤 `make-delivery.py`（§7.1）。

### 四档各自的画法

| 档 | 画法 | 配色 | 光 |
|---|---|---|---|
| **`cartoon`（默认）** | **平涂 cel shading**：每个面 = 一块纯色底 + 最多一档更深的平涂；粗匀圆头描边；**零材质**（无划痕/木纹/做旧/锈迹） | **中明度**：钢青灰、赭石、中褐、柔青绿、赭红；**亮色只做受光边的高光，暗色只做描边与小暗面** | 正面偏上、清晰均匀；暗面一档平涂约占三分之一；不投影 |
| `project` | 低多边形平面几何、细匀描边、无任何贴图质感 | 项目双色（墨灰 + 青绿） | 图表式均匀光、无投影 |
| `dota` | 手绘厚涂、粗重外描边、明暗两大块、材质靠划痕/木纹/褶皱说话 | 跟随道具本身；最暗只到深炭灰/深褐（不到黑） | 左上高光、右下软阴影 |
| `dota-muted` | 同上 | 收敛到项目双色 | 同上 |

真源在 `gen-prompts.mjs` 的 `STYLE_PRESETS`（`DRAWING_CARTOON` / `PALETTE_CARTOON` / `LIGHT_CARTOON` / `CLOSE_CARTOON` / `DRAWING_DOTA` / `PALETTE_DOTA` / `LIGHT_DOTA` / `CLOSE_DOTA` / `DRAWING_FLAT` / `PALETTE_DUO` / `LIGHT_FLAT` / `CLOSE_FLAT` / `MARGIN`）与首句锚点表 `ANCHORS`；**改风格改那里再重跑**。量明度用 `.tmp/bright_probe.py`（只统计 `a >= 128` 的像素）。


### ⚠ 明度改了两轮，最终定在「中明度」（2026-10，两轮都是用户看过图之后的反馈）

| 轮次 | 做法 | 明度均值（4 张） | 白档融底 | 结论 |
|---|---|---|---|---|
| ① 初版 | dota 厚涂「整体压暗」 | 0.21 ~ 0.41 | — | **太暗黑**，用户否 |
| ② 转明亮卡通 | 整体推到明度亮半边 | 0.69 ~ 0.81 | **42.1%**（最差 57.4%） | 单看很清爽，但**贴到白档品质框上 42% 的像素融进底色**，用户否 |
| ③ **中明度（定稿）** | 主体落中间调 + 保留深描边 | **0.55 ~ 0.66** | **14.1%** | 四档品质色上都读得清 |

**为什么不是越亮越好 —— 这是被框决定的，不是审美**：
`RelicItem.content/head` 是**白色圆角九宫格**（`common/rect_rd_5_white.png`），运行时按品质染成
`#DDDDDD` / `#5096FF` / `#CF68FF` / `#FF6464`（`ShopRelicsItem.RARITY_COLOR`）。四档底色的相对明度是
**0.87 / 0.60 / 0.63 / 0.54** —— **全在浅到中段**。所以：

- 主体太亮（0.7+）→ 在白档浅灰底上糊掉（实测 42% 融底）；
- 主体太暗（0.3-）→ 在蓝紫红底上糊掉；
- **唯一在四档上都成立的做法 = 中明度主体 + 一圈深描边**（描边是真正把形状从任何底色里分离出来的东西，
  也正是美术圣经「彩色底 + 单色线稿、靠剪影辨识」的同一思路）。

**验收指标**（`.tmp/frame_contrast.py` 与 `.tmp/framesheet-mid.png` 的用法见下）：

| 指标 | 目标 | 初版② | 定稿③ |
|---|---|---|---|
| 明度均值 | 0.50 ~ 0.60 | 0.73 | **0.55 ~ 0.66** |
| 主体中位明度 p50 | 中明度 | 0.69 ~ 0.78 | **0.43 ~ 0.58** |
| 描边明度 p10 | 越深越好 | 0.29 ~ 0.33 | **0.20 ~ 0.25** |
| 描边与四档底**最小**明度差 | ≥ 0.28 | ≤ 0.25 | **0.30 ~ 0.34** |
| 白档 `#DDDDDD` 融底占比 | < 15% | 42.1% | **14.1%** |

> **量法**：`.tmp/bright_probe.py`（明度/暗部/近黑，只统计 `a >= 128`）。
> **看效果**：`.tmp/frame_sheet.py` 会把图标按**真实槽位尺寸**（70×70 框 + 50×50 图标，放大 3×）
> 贴到四档品质色上拼成对照图 —— **判断这个风格必须在这张图上判断**，200×200 的图看着没问题、
> 缩到 50px 可能就糊了。200×200 大图请用 `.tmp/agg_probe.py` 整批过。

### ⚠⚠ 透明底这条：两次翻车，都记在这（**别改 `BACKGROUND` 的写法**）

1. **提示词里只要提到"承载底"，模型就会把底画出来。** 我为了让图标在浅灰品质框上清楚，
   写了一句 `reads clearly when placed on a pale grey plate` → 4 张图 alpha 全部 213~252、**整张不透**
   （模型直接把浅灰板画了出来）。
2. **否定式不可靠，"不要白/不要灰"反而把白灰引出来了**（negation priming）。我把背景句改写成
   「…不许是白的、不许是灰的、不许是任何平涂色」并挪到段末之后，4 张图又变成**烘焙了一张近白圆角底板**
   （alpha 240~255，只有圆角处真透明），等于白跑一轮。

**口径**：背景句只做**正向陈述**（"画面里除了主体什么都没有、那块地方是透的"），
**禁止**列举"不要什么颜色"、**禁止**提到任何"贴到什么底上"。改这句之后透明恢复正常
（真透明像素占比 70%~88%）。

### ⚠⚠ 透明底检查必须在**原图**上做（流水线漏洞，已补闸）

`make-delivery.py` 会**把假透明洗白**：源图整张不透明时，包围盒 = 全画幅 → 脚本照样贴出一圈透明边距、
输出一张"合规"的 200×200，于是 `check-icons.py` 全绿，而图里其实烘焙着一块底板
（实测：4 张源图 alpha 全在 240~255，交付后 alpha 极值却是 `(0, 255)`、留白正好 10%）。
**现在 `make-delivery.py` 有闸**：源图真透明像素 < 1% 直接拒绝交付。原图体检命令：

```bash
python -c "from PIL import Image,glob
for p in sorted(glob.glob('.tmp/relic-icons-final/*.png')):
    h=Image.open(p).convert('RGBA').getchannel('A').histogram(); t=sum(h)
    print(p, '真透明 %.1f%%' % (sum(h[:128])/t*100))"
```


**第四条口径：品质不进出图。** 品质由 UI 里图标背后的底框表现（用户口径），所以 307 条提示词里**没有任何品质色**，同一件道具不会因为品质出四张图 —— 而**底框染品质色的代码在 `ShopRelicsItem.setFrameColor`**（见 §7.5）。

> 你那段测试文字里的**结构**（先说画面主体与构图 → 再说材质细节 → 再说风格 → 收尾）正是 Qwen-Image-2.1 要的观察者散文体，307 条就是按这个骨架写的；我只是把"Dota 2 风格、线条粗犷、色彩对比强烈、材质刻画细致"这套词换成了可复用的英文句子，并补上**真透明**与**留白**两条硬要求。

- `docs/art-style/tokens.json` → `prompt` 块 + `palette`（`project` / `dota-muted` 档的配色来源）
- `docs/art-style/ui-design-prompt.md` §1.3 → 图标几何线稿口径（`project` 档）
- `docs/美术风格预设.md` §1 → 浅色纸面上的低多边形几何（`project` 档）

---

## 3. 两条路线

### 路线 A（推荐）· 参考图重绘 —— 293 件有原图的

把现成的 dota 图标当参考图喂进 **Image Edit** 子图，只改「画风 + 背景」两件事，靠一句总括的保真条款锁住道具身份（造型轮廓、部件数量、部件位置关系与比例）。这是**最保辨识度**的一条路。

提示词 = `prompts.json[].prompt_edit_zh`（中文指令；单图输入**不加** `<imageX>` 标签）。

**⚠ 这条路上最容易踩的坑：原图只有 88×64。** 官方口径是「`custom_size` 关掉时，编辑结果按第一张参考图的尺寸出图；`resolution 0` 保持每张参考图自己的像素尺寸」。所以**必须先把 88×64 放大到 1024×1024 再进 edit 子图**，否则你会拿到一堆 96×64 的糊图：

```
LoadImage(relics/bfury.png) → ImageScale(1024×1024, lanczos) → [Image Edit 子图的 image_1]
```

编辑子图的画布取 `Resolution Selector`（打开 `custom_size`）→ **1:1 / 1.0 MP**。采样 `steps 25 / cfg 1 / euler / simple`，缓存节点（Qwen Image 2.1 Cache）用模板默认值。

### 路线 B · 纯文生图 —— 307 件都能用，9 件没图的只能用它

英文观察者散文（Qwen-Image-2.1 的 T2I 规范口径），提示词 = `prompts.json[].prompt_t2i`。模板用官方 T2I 模板 `image_qwen_image_2_1_t2i.json`：

- **Resolution Selector**：`1:1` + `1.0 MP`（1024×1024）
- `steps 25` / `cfg 1` / `euler` / `simple`
- **`refine_prompt` 保持关闭** —— 那个 PE 文本编码器会把我们写好的成套提示词改写成别的，307 张的一致性就没了
- `wh_ratio` 就是 **`1:1`**（清单里每条都写了；T2I 规范要求比例只出现在字段里，**不要**写进提示词正文，清单里的正文也没写）

### ⚠ 负向词：这份清单里没有 negative 列，是有原因的

官方文档写明：**`cfg 1` 时 ComfyUI 跳过负向条件那一遍，负向词没有效果**。Qwen-Image-2.1 发布的推荐路径就是 `cfg 1`，所以清单里的「不要渐变/不要文字/不要边框」全部写成**正向的观察句**（"every surface is flat and matte…"、"no lettering, numeral, watermark, border…"）塞在正向提示词里。真要负向词，只有两条路：把 `cfg` 提到 2（官方提示会过锐、且改一个量要固定种子对比），或者干脆走路线 A。

---

## 4. 透明背景

Qwen-Image-2.1 的 **VAE 是 4 通道**，官方明确「透明背景的图可以直接生成与编辑，不必事后抠图」。所以：

1. 每条提示词都写了 `isolated on a fully transparent background` / `输出真正带 alpha 通道的透明背景`，正常情况**直接出 RGBA**；`SaveImage` 节点写出的 PNG 就带 alpha。
2. **⚠ 先确认它是真透明，别被棋盘格骗了**：你实测那张 `ComfyUI_00014_.png` 的预览副本量出来 alpha 最小值是 **237**（一处为 0 都没有），背景那层浅灰棋盘格是**画进像素里的**（占 61.4% 面积）。一句命令验真身：
   ```bash
   python -c "from PIL import Image; im=Image.open(r'路径'); print(im.mode, im.getchannel('A').getextrema())"
   ```
   `('A', (0, 255))` = 真透明；`('A', (237, 255))` = 假透明（棋盘格/灰底已烘焙），进游戏就是一张灰底方图。
3. 假透明或底没干净时的补救：用官方**去背景模板** `image_qwen_image_2_1_background_removal.json`，它的编辑指令是 `Remove the background, and output a PNG image`，把出歪的那张丢进去再跑一次。
4. 交付前**别做白底合成**：降采样用带 alpha 的 Lanczos（Photoshop / `magick convert -resize 200x200` / Python PIL `thumbnail` 都保留 alpha），一路 RGBA 到底。

---

## 5. 模型与目录（官方模板口径）

```
📂 ComfyUI/models/
├── diffusion_models/  qwen_image_2.1_bf16.safetensors      （或 int8 版，省显存）
├── text_encoders/     qwen3vl_8b_bf16.safetensors          （或 qwen3vl_8b_int8_convrot）
└── vae/               qwen_image_2.1_vae_bf16.safetensors
```

模板在「工作流模板库」里搜 **Qwen-Image-2.1**：`Text to Image` / `Image Edit` / `Remove Background` 三个（对应 `image_qwen_image_2_1_t2i.json` / `_image_edit.json` / `_background_removal.json`）。参考：[ComfyUI 官方 Qwen-Image-2.1 教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)、[模型仓库](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)。

---

## 6. 批量怎么跑

**手动档**：`prompts.csv` 按 `prompt_t2i` 或 `prompt_edit_zh` 列，一行一条贴进文本节点；路线 A 还要把 `input_image` 对应的图先放大到 1024 再挂 LoadImage。

**脚本档**：`tools/relic-icon-prompts/comfyui_batch.py` —— 先在你的 ComfyUI 里把工作流调通（1:1 / 1.0MP / 25 步 / cfg 1 / 提示词节点 / LoadImage 节点），然后 **Workflow → Export (API)** 导出 API 格式的 JSON，再：

```bash
python tools/relic-icon-prompts/comfyui_batch.py \
  --workflow C:/ComfyUI/user/default/workflows/relic_t2i_api.json \
  --prompt-node 6 \                # 吃提示词的文本节点 id
  --route t2i \                    # t2i 用 prompt_t2i；edit 用 prompt_edit_zh + 改 LoadImage
  --out D:/relic-icons-out \
  --limit 3 --dry-run              # 先空跑 3 条，看清补丁打在哪
```

脚本做了三件事：按 `prompts.csv` 逐条把提示词（和路线 A 的参考图）补进工作流 JSON、POST 到 `127.0.0.1:8188/prompt`、轮询 `/history` 把出图按 `<key>.png` 收进 `--out`。**逐张串行**（投一张 → 等出图 → 下载 → 下一张），不会并发挤爆显存。

### 6.1 长批量保命参数（2026-10 在真机上跑过 4 张后定的）

```bash
python tools/relic-icon-prompts/comfyui_batch.py \
  --workflow .tmp/comfy_t2i_base.json --prompt-node 7 --route t2i \
  --out .tmp/relic-icons-out --free-every 1 --stall 420 --skip-existing
```

| 参数 | 默认 | 为什么需要它 |
|---|---|---|
| `--free-every N` / `--unload-every N` | **都是 0** | **别凭直觉设这两个 —— 先算模型装不装得下**（见下面的表）。实测：`/free`（**哪怕 `unload_models=false`**）会把模型逐出显存，装得下时调它 = 每张白付一次重加载（**9 s → 23 s**）；装不下时不卸会颠簸甚至假死 |
| `--skip-existing` | 关 | 断点续跑：输出目录里已有同名 png 就跳过，中断后接得上 |
| `--stall N` | 180 | 单张连续 N 秒没结果 → 判定"显存打满假死" → `/interrupt` 打断 + 重投 |
| `--attempts N` | 3 | 单张最多投几次：连接被掐（`WinError 10054`）、任务随服务端重启丢失、假死，都会重投 |
| `--timeout N` | 900 | 单张总时长上限 |

脚本内部还会：把结果先写 `<key>.png.part` 再改名（**中断不会留半张图骗过 `--skip-existing`**）、查 `/queue` 判断任务是真在跑还是已经丢了、网络错指数退避重试（提交/查询/下载三处）；平均耗时 > 40 s 时会打印"模型可能没常驻"的自诊断提示。

#### ⚠ 提速的真相：先让模型"装得下"，再让模型"常驻"

**2026-10 实测把这条结论整个推翻过一次，记全了免得再走弯路。** 同一张 16GB 卡（RTX 4070 Ti SUPER）：

| 配置 | 单张耗时 | 结果 |
|---|---|---|
| 大编码器（8.71GB）+ 常驻、一次都不清 | **112 s** | 又慢又卡 |
| 大编码器 + 每张 `/free` | 24~29 s | **第 7 张显存钉死 15.5/16GB 假死** |
| 大编码器 + 每张连模型一起卸 | 26~29 s | 稳定（当时误以为"卸载是必须的"） |
| **w4a8 编码器（5.88GB） + 一次都不调 `/free`** | **第 1 张 21 s，之后 8.3 / 8.6 s** | **稳定，跑完显存 13.7GB（模型真常驻）** |

**怎么算"装不装得下"**（在用的三个文件加起来 vs 显存）：

| 文件 | 大小 |
|---|---|
| `qwen_image_2.1_int8_convrot.safetensors`（UNET） | 6.76 GB |
| `qwen3vl_8b_int8_convrot.safetensors`（文本编码器，**旧**） | 8.71 GB |
| `qwen3vl_8b_w4a8.safetensors`（文本编码器，**现用**） | 5.88 GB |
| `qwen_image_2.1_vae_bf16.safetensors` | 0.63 GB |

- 旧的组合 = 6.76 + 8.71 + 0.63 = **16.1 GB > 16 GB → 装不下** → 必然每张换进换出；
- 换成 w4a8 = 6.76 + 5.88 + 0.63 = **13.27 GB → 装得下** → 可以常驻，省掉每张约 13 s 的重加载。

**耗时是怎么构成的**（`steps=1` 探针法，很值得复用）：`steps=40` 23.5 s、`steps=1` 18.0 s
→ **固定开销 17.4 s、每步只有 0.141 s** → **采样只占 24%**。所以：

- **降分辨率几乎没用**（只影响那 24%）：实测 640×640 → 512×512 只快 **3%**；
- **降步数也没多大用**：40 → 25 步只省 **2.1 s（9%）**；
- **真正的杠杆是"别让模型每张重新加载"**（省 13 s/张，3 倍）。

`steps=1` 探针怎么做：复制工作流 JSON，把 `KSampler.steps` 改成 1，跑一张，再从 `/history` 里取
`execution_start` → `execution_success` 的差值（**这个差值才是 GPU 真耗时**，不包含轮询与下载）。

> 想自己复算：`--free-every 0 --unload-every 0` 跑 3 张，看第 2/3 张是不是显著快于第 1 张；
> 跑完 `nvidia-smi` 看显存是不是还占着 —— **如果跑完显存掉回 1~2GB，说明模型没常驻，钱白花了。**

**其它显存杠杆**（优先级低于上面那条）：关掉抢显存的桌面程序（浏览器 / VS Code / Steam / Cocos 编辑器各占几百 MB~1GB+）；ComfyUI 加 `--reserve-vram 1.0` 留 1GB 给桌面，避免整机跟着卡。


---

## 7. 出完图怎么替换回去（这一步几乎零成本）

### 7.1 先做交付图：`make-delivery.py`（**这一步别省**）

```bash
python tools/relic-icon-prompts/make-delivery.py --src .tmp/relic-icons-final --dst .tmp/relic-icons-64 --size 64
```

**交付尺寸 = 64×64**（2026-10 口径：做完压到 64×64，再进图集）。显示槽位是 50×50，所以 64 是 1.28×。
**原图 640×640 一律留着** —— 以后想换交付尺寸只是重跑这一条命令（`--size 128` / `--size 200`），
**不用重新出图**。体积参考：现有 294 张 dota 原图（88×64）合计 **9974 KB**；新 64×64 平均 **3.4 KB/张**、
307 张约 **1029 KB**（约 1/10）。

它做四件事：

1. **假透明闸**：源图真透明像素 < 1% 直接拒绝（**不做这步会把假透明洗白**，见 §2 那个漏洞）。
2. **按 alpha 包围盒重新摆位**：主体长边归一到画布的 80%，四周各留 10%。提示词里那句 `MARGIN`（"留约 1/10"）**只是建议**——实测漂移很大（`magic_stick` 只留 1.2%、`clarity` 宽到 35.5%）。按包围盒算才是确定性的：不管模型怎么画，出来一定不顶边。
3. **成套统一视觉大小**：不归一会得到"有的塞满、有的很小"的参差（实测包围盒占位从 29% 到 84%），整屏商店的图标不成套。
4. **预乘 alpha 缩放**（`numpy`：先乘 alpha → LANCZOS → 除回来）：透明像素的 RGB 是模型随手填的（常是黑），直接缩放会让黑渗进主体边缘一圈深色描边。

### 7.2 再体检（四件事一次过，违规退出码 1）

```bash
python tools/relic-icon-prompts/check-icons.py --dir .tmp/relic-icons-64 --limit 20
```

它逐张量：**alpha 最小值是不是 0**（假透明）、**四边留白够不够 8%**（贴边）、**是不是正方形**、**是不是 64×64**（`--size` 可改）。拿现在工程里那批 dota 原图跑，294 张会**全红**（`alpha_min=255` + `88×64`）—— 这正是它们要被换掉的原因。

### 7.3 装机：`install-icons.py`（带三道闸，别手动 copy）

```bash
python tools/relic-icon-prompts/install-icons.py --src .tmp/relic-icons-64 --dry-run   # 先空跑
python tools/relic-icon-prompts/install-icons.py --src .tmp/relic-icons-64             # 确认后真装
```

三道闸（任何一条不过就跳过那张，不会把坏图装进工程）：① **体检不过的不装**（真 alpha / 正方形 / 64×64 / 留白 ≥ 8%）；
② **不在 `prompts.csv` 清单里的文件名不装**（`--allow-extra` 可放行）；
③ 不碰 `RelicItem.prefab` 占位图那个 uuid 指着的资源。
它**不动 `.meta`**：覆盖同名文件时 uuids 不变（编辑器只当"贴图内容变了"）；新增的那 14 件要等编辑器导入生成 `.meta`。

> ⚠ **装了碎图之后必须再打一次图集、并退掉碎图**（2026-10 起工程走的是 plist 图集，见 §7.4）：
> `install-icons.py` 会把 64×64 装成**碎图**摆进 `textures/relics/`，而那个目录现在**只该有图集那一对文件**。
> 正确顺序是：装碎图 → `build-atlas.py --dst <临时目录>` → 用新打的两份覆盖 `textures/relics/relics.{plist,png}`
> → **切回编辑器窗口**让它重新导入 → `check-atlas.py` → `retire-loose-icons.py --apply`。

装完的两件收尾：
1. **14 件本地没图的**（id 1~5 = `thorn_mail`/`vampire_fang`/`flame_sword`/`giant_heart`/`palm_mercy`，1294~1302 = `gloves_of_haste`/`trusty_shovel`/`oak_heart`/`enchanted_quiver`/`philosophers_stone`/`imp_claw`/`titan_slab`/`pirate_hat`/`apex`）新图进目录后，还要把配表 `icon` 列指过去（改成 `textures/relics/<key>`）：改 `tools/excel_export/excel/relics.xlsx` 的 `icon` 列 → `cd tools/excel_export && node src/cli.ts excel2json`（或先改 JSON 再 `node src/cli.ts json2excel --force --table relics` 回灌），跑 `npm run check` + `npm run verify`。这 14 件目前的状态见 `tools/excel_export/reports/relic-icon-migration.md`。
2. **切回 Cocos 编辑器窗口**让它导入新文件（编辑器不在前台时资源库不刷新，`.meta` 不会生成，`resources.load` 就取不到 spriteFrame）；商店面板的图标有**按路径缓存**（`ShopRiItem.iconCache`），运行中替换文件不会立刻生效，**重开预览**再看。

### 7.4 打成图集（**图集资源 Atlas：plist + png**，2026-10 改口径）

> **口径变更**：一开始做的是「自动图集 Auto Atlas」（`auto-atlas.pac`），用户看过之后的要求是
> **「图集需要做成 cocos creator 的图集，现在这个图集没见过」** → 改成 3.x 的另一种图集资产
> **图集资源（Atlas）**：`plist` + `png` **同名一对**，拖进资源管理器就生成一个 Atlas 资源，
> 展开是一堆 `SpriteFrame` 子资源 —— 这才是 Cocos 开发者"见过"的那种图集。
> 旧的 `.pac` 与 307 张碎图**都已删除**（碎图有 zip 备份，见 §7.4.6）。

当前 `assets/resources/textures/relics/` 里只剩 4 个文件：

| 文件 | 说明 |
|---|---|
| `relics.plist` | 图集索引（TexturePacker **format 3** 的 XML plist），**307 帧** |
| `relics.png` | 图集大图，**704×1024**，填充率 80.6 % |
| `*.meta` | 编辑器生成；`relics.plist.meta` 里挂着 307 个 `sprite-frame` 子资源 |

#### 7.4.1 格式真源：不是照文档猜的，是照一份**真导入过**的图集写的

官方文档只说「用 TexturePacker **4.x** 导 **cocos2d-x 格式**的 plist」「不支持 4.x 以下的格式」，
**没有给字段表**；而编辑器里的导入器（`engine-extends` 的 `registerTexturePackerHandler`，注册名 `sprite-atlas`）
是编译进 `.ccc` 的，读不到源码。所以格式是**从一份真家伙上扒的**：

> `D:\Project\cocos\merge_tower_defense\assets\resources\icons\pack\texture.plist` (+ `.meta`)
> —— 它的 meta 写着 `"importer": "sprite-atlas"`、`userData.format = 3`，
> `subMetas` 里 16 个 `sprite-frame` 子资源（uuid = `<图集uuid>@<5 位十六进制>`）。

生成器 `build-atlas.py` 照它的结构写，并做过一次**结构对账**（不依赖编辑器、随时可复跑）：

```
顶层键    参照=['frames','metadata']        我的相同                    OK
metadata  参照 6 个键（format / pixelFormat / premultiplyAlpha /
          realTextureFileName / textureFileName / size）               OK
单帧键    参照 5 个键（spriteOffset / spriteSize / spriteSourceSize /
          textureRect / textureRotated）                              OK
值类型    前 4 个是字符串、textureRotated 是 bool —— 逐个相同          OK
帧名      参照 'select.png'  我的 'abyssal_blade.png'（都带 .png；
          导入后子资源的 name 会自动去掉扩展名）
坐标口径  textureRect = {{x,y},{w,h}}，**左上角原点、y 向下**
          （导入后 x/y 直接变成子资源的 trimX / trimY）
          spriteOffset = 裁剪后中心相对原图中心的偏移，**y 向上**
```

#### 7.4.2 打包：`build-atlas.py`

```bash
python tools/relic-icon-prompts/build-atlas.py                          # 只算不写，用来扫 --max-width
python tools/relic-icon-prompts/build-atlas.py --dst <目录> --max-width 704
```

- **每张图标先按 alpha 包围盒裁边**再进图集：307 张 64×64 的 1,257,472 px → **580,890 px（砍掉 53.8 %）**；
- MaxRects（BSSF）+ 间距 2，画布尺寸向上对齐到 **4 的倍数**（压缩纹理按 4×4 分块，不齐会浪费）；
- 扫过 384~2048 十几个宽度，**704 这一档面积近乎最小、又接近方形**：

  | `--max-width` | 图集尺寸 | 填充率 | 未压缩显存 |
  |---|---|---|---|
  | 384 | 384×1852 | 81.7 % | 2.71 MB |
  | **704（已采用）** | **704×1024** | **80.6 %** | **2.75 MB** |
  | 1024 | 1024×900 | 63.0 % | 3.52 MB |
  | 2048 | 2048×577 | 49.2 % | 4.51 MB |

#### 7.4.3 ⚠ 关键：图集帧的裁剪数据**必须与碎图逐字段一致**（否则画面会变）

`RelicItem.content/head/inner` 是 `sizeMode = CUSTOM(50×50)` + `trim = true`：
**帧的 `width` / `height` / `rawWidth` / `rawHeight` / `offsetX` / `offsetY` 一变，
图标在 50×50 槽位里的大小与位置就变**。而碎图是**导入器自动裁过**的
（64×64 → 例如 `quelling_blade` 裁成 25×51、`offsetX -0.5` / `offsetY 0.5`）。

所以 plist 里的 `spriteSize` / `spriteSourceSize` / `spriteOffset` 是**按碎图 meta 反推的同一套公式**写的：

```
trimX  = bbox.left                      trimY  = bbox.top
width, height        = bbox 尺寸        rawWidth, rawHeight = 64
offsetX = (bbox.left + bbox.right)/2 - W/2
offsetY = H/2 - (bbox.top + bbox.bottom)/2        ← 注意这是 y 向上
```

> ⚠ **别拿 `trimX`/`trimY` 去和碎图比！** 碎图里它是「帧在那张小图里的坐标」，
> 图集里它是「帧在**整张图集**里的坐标」（= plist 的 `textureRect` 原点）—— **本来就该不同**。
> 第一版体检脚本拿这两个字段去比对，一次报 614 处（= 307×2，恰好只有这两个字段）——
> 是**判据**写错了，不是数据错了。这条代价值得记住：**指标错了会冤枉正确的结果**。

#### 7.4.4 验收：`check-atlas.py`（换图集前后**逐字段对账**）

```bash
python tools/relic-icon-prompts/check-atlas.py     # 全绿才允许删碎图；违规退出码 1
```

五项 + 一项自洽：① `importer === "sprite-atlas"` 且 `imported === true`；
② `format === 3`、`atlasTextureName === "relics.png"`；
③ 帧数 == 碎图数、帧名一一对应；④ **6 个外形字段逐字段一致**（307 张 × 6 字段）；
⑤ `library/` 下有图集 + 307 个帧子资源的导入产物；
⑥ `trimX`/`trimY` 必须等于 plist 的 `textureRect` 原点（帧位置自洽）。
**本项目实测：全部通过。**

#### 7.4.5 ⚠ 运行时的坑：`relics.plist` 与 `relics.png` **同名** → 去掉扩展名的路径不唯一

同目录同名一对是 TexturePacker 的老惯例、官方导入流程也这么配；但
`resources.load('textures/relics/relics')` 到底命中 plist 还是 png，取决于构建/预览资源表的
**去歧义策略，没有公开契约**（哪个保留干净路径、哪个被补上扩展名，由构建器决定）。
碎图已经删了，这里赌不起 → `ShopRelicsItem` 走**三步降级**，并把「命中哪条路」打进日志：

```
① 图集本体：resources.load('textures/relics/relics' 或 'textures/relics/relics.plist', SpriteAtlas)
            → atlas.getSpriteFrame(<帧名>)
② 直取帧：  'textures/relics/relics.plist/<帧名>' 或 'textures/relics/relics/<帧名>'（帧本身也是子资源）
③ 旧口径：  '<icon 路径>/spriteFrame'（碎图）—— 图集被删 / 换回碎图方案时商店不会空白，
            而且 `skills` 那类非遗物图标本来就该走这条
```

- **帧名 = `relics.json` 里 `icon` 值的路径主干**（`textures/relics/quelling_blade` → `quelling_blade`），
  所以**配表一个字都没改**；远程 URL 那 7 件照旧走 `loadRemoteFrame`；
- ⚠ **2026-10 起这套降级链已抽成共享实现 `assets/scripts/game/common/AtlasIcon.ts`** ——
  上面那三步现在是 `AtlasIcon.loadIconFrame(path)`，`ShopRelicsItem`（图集 `relics`）、
  `SkillSlot` / `HeroItem`（图集 `skills`）三家共用同一份，**图集路径由图标路径推导**：
  `textures/<dir>/<主干>` → 图集 `textures/<dir>/<dir>`（所以技能图集是 `textures/skills/skills`）。
  日志文案随之统一成了 `[图标]` 前缀（不再是 `[遗物面板]`），判读方式不变：
  - `[图标] 图集已加载：<路径>（N 帧）`
  - `[图标] 图标命中路径：<哪条>（<路径>）｜首个帧名：<帧名>` —— 每个图集**最多 3 行**（按「图集+路线」去重，不刷屏）
  - `[图标] 图集没取到：<base>（改走直取帧 / 旧碎图路径）` = 该图集整体没加载上
- 只看到 `图集没取到` + `三条路都没取到` = 全挂了（error 只报一次，不刷屏）。

#### 7.4.6 退掉碎图：`retire-loose-icons.py`（带三道闸）

```bash
python tools/relic-icon-prompts/retire-loose-icons.py           # 预演
python tools/relic-icon-prompts/retire-loose-icons.py --apply   # 真删
```

三道闸（任何一道不过就整体不执行）：① `check-atlas.py` 必须全绿；
② **全工程 `.prefab` / `.scene` / `.json` / `.anim` 里没有资源还按 uuid 引用碎图**
（实测当时只有 `RelicItem.prefab` 引了一件，已改指图集帧 `…@2e695`）；
③ **先备份进 zip 才允许删**。

- 备份：`tools/relic-icon-prompts/backup-relic-icons-64.zip`（614 个文件 / 1.58 MB）——
  碎图是 `make-delivery.py` 的产物、**没有 git 备份**（新加的 14 张还是 untracked），
  删掉就只剩图集里那份像素了；
- 一并删掉 `auto-atlas.pac` + `.meta`（两种图集不留两份）；
- 目录最后只剩 `relics.plist` / `relics.png` / 两个 `.meta`；
- **回退路径**（不用改一行代码）：解 zip 放回碎图 → 删 `relics.plist` / `relics.png` → 第 ③ 步自动接管。

#### 7.4.7 另一条路（**已放弃，别再捡回来**）：自动图集 Auto Atlas

`auto-atlas.pac` **也是** Cocos Creator 的官方图集（资源管理器 `+ → 自动图集配置`，
内容就是 37 字节的一行 JSON `{"__type__": "cc.SpriteAtlas"}`），但它是**构建期配置**：
大图只在**构建时**生成、**工程里永远看不到那张图**（编辑器里只能选中它点**预览**看
Packed / Unpacked Textures）—— 这正是"没见过"的原因。
它的好处是**对按路径加载透明**（代码零改动）；代价是"看不见、只在构建时存在"，
而且 `filterUnused`（剔除未使用的图片）与"按路径动态加载"的关系社区两种说法都有、只能靠构建定论。
离线预览工具 `preview-atlas.py` 保留着（`python tools/relic-icon-prompts/preview-atlas.py --save`
→ `docs/relic-icon/atlas-preview.png`），但**工程里已经不用这条路了**。

#### 7.4.8 ⚠ 显存：换成图集是**涨**的，不是"打平"

商店一屏只显示 4 个图标：碎图方案只加载那 4 张（≈ **65 KB**）；
**图集方案是"加载任意一张图标就会把整张 704×1024 拉进显存"（≈ 2.75 MB 未压缩 / 约 0.7 MB 按 4bpp 压缩）**。
之前写的"显存几乎打平"是拿「307 张全加载」比的 —— **按商店的实际用量算是明显上涨**。
换图集买到的是**构建期确定性 + 能在编辑器里看到、能展开子资源引用**，代价是显存；要省显存就上压缩纹理。

### 7.5 品质底框染色（代码侧，已实现）

`ShopRelicsItem.ts`：`@property(Sprite) frame`（预制件里的 `content/head`）+ `setFrameColor()`。
- 遗物按 `RARITY_COLOR[rarity]` 染框（白 `#DDDDDD` / 蓝 `#5096FF` / 紫 `#CF68FF` / 红 `#FF6464`）；
- **技能格复位成中性白框**（技能没有品质，不复位会把上一格的颜色留着）；
- 接进了 `baseColors` 机制，所以**置灰/恢复会一起处理**（不接的话首次灰化会把预制件默认色当成"原色"缓存，品质色再也回不来）；
- 没在编辑器里拖 `frame` 也能跑：`ensureFrame()` 按名字 `content/head` 兜底找（同 `HpBar.hp_bar` 的套路）。

**出图与框的分工**：品质**只**由底框颜色表达，图里不含品质色 —— 所以**图标里不要出现大面积纯白/纯蓝/纯紫/纯红**，否则会和框撞色。

### 验收清单

- [ ] **真 alpha**（在**原图**上量！`: `im.getchannel('A').getextrema()` 是 `(0, 255)`，且真透明像素占比有几十 %；
- [ ] **四周留白 ≥ 8%**：主体外轮廓不顶边；
  ↑ 这两条 + 正方形 + 64×64 直接跑 `python tools/relic-icon-prompts/check-icons.py --dir <交付目录>`，绿了再装；
- [ ] 50×50 槽位里**不拉伸**（正方形）；
- [ ] 剪影在 50×50 下仍能分辨是什么道具 —— **用 `.tmp/frame_sheet.py` 拼真实槽位尺寸的对照图看**，别只看大图；
- [ ] 四档品质底色上（`#DDDDDD`/`#5096FF`/`#CF68FF`/`#FF6464`）都能读 —— `.tmp/frame_contrast.py` 查"融底占比"，描边与四档底的最小明度差 ≥ 0.28；
- [ ] 同一档的 307 张**同一套画法**（描边粗细、光照方向、留白比例一致），混进 HUD 其它图标（`textures/skills/bullet.png`、`property/atk.png`）不违和；
- [ ] 没有出现文字/数字/水印；
- [ ] 品质**不在图里**（品质交给 UI 底框）。

---

## 8. 与现有工程的关系（别踩的几条）

- **`textures/relics/yazhizhiren.png` 不能删**：它是 `RelicItem.prefab` 里图标槽的**占位图**（预制件按 uuid `fca27a57-f2ce-4859-8822-321fa73d5fda@f9941` 引用）。出图不影响它，但别顺手清掉。
- **配表 `icon` 列已经是本地路径**（`textures/relics/<key>`，不带扩展名）；本轮出图**不改配表**（除 §7.3 那 14 件）。
- **技能图标没在这份清单里**：`abilities.json` 的 52 行 `icon` 目前全空，回落占位图 `textures/skills/bullet`。要出技能图标的话，那是另一批（30 个肉鸽技能 + 22 个单位技能），提示词可以复用本文件的风格段。
- 风格段/摆位句的唯一真源是生成器 `gen-prompts.mjs` 里的 `STYLE_PRESETS`（三档）与 `KIND_TEMPLATE`（21 种形态的摆位/朝向句）：**要改风格改那里再重跑**（`--style dota|dota-muted|project`），不要手改 `prompts.json` / `prompts.md`（会被下一次生成覆盖）。
