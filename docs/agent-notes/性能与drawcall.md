# 性能 · Draw call 拆账与优化（2026-11）

> 触发：用户问「drawcall 50~60 能优化么」。
> 结论：**能，而且大头几乎全在战斗 HUD（`View_Game_Stage`）**，不在战斗内容上。
> 本文只写判据与做法；数字是**静态估算**（预制件默认激活状态 + DFS 渲染顺序），实机请用 `tools/analysis/dc-probe.js` 复核。

## 0. 先量，别猜

| 工具 | 用途 | 用法 |
|---|---|---|
| `tools/analysis/dc-scan.mjs` | **静态**：按渲染顺序走预制件，估算 DC 并拆账（哪个功能/哪个节点花钱） | `node tools/analysis/dc-scan.mjs assets/resources/prefabs/ui/scenes/scene_game_stage/cmps/View_Game_Stage.prefab --list` |
| `tools/analysis/prefab-tree.mjs` | 打印节点树（层级 = 渲染顺序） | `node tools/analysis/prefab-tree.mjs <prefab> [深度]` |
| `tools/analysis/dc-probe.js` | **运行时**：读引擎本帧真实批次（`director.root.batcher2D.batches`），按贴图拆账，并给出「重排+图集后的乐观下限」 | 战斗中贴进浏览器控制台，然后 `__dc()` / `__dcMax()` |

引擎口径（`cocos/2d/renderer/batcher-2d.ts`，3.8.6 实读）：
- 合批 = **相邻**两次提交的 texture / material / blend / layer 全同；`autoMergeBatches` 只在提交时收尾当前段，**不会回头**找更早的同贴图批次 ⇒ **顺序就是一切**；
- Label（TTF，`cacheMode = NONE`）= 每个 Label 一张**自己的 canvas 贴图**（`label.ts` 的 `_ttfSpriteFrame`）⇒ **恒 1 DC，且会切断前后 Sprite 的合批**；
- `cacheMode = CHAR` 的 Label 共享字模图集，`computeHash = fontSize + fontFamily + color + outline` 相同才共享（`font-utils.ts`）；
- Mask 走模板缓冲，进出各插 1 个 batch；
- 空文本 `Label` / 无贴图 `Sprite` 不提交（`renderData.isValid() === false` 直接 return）。

## 1. 现状拆账（`View_Game_Stage`，战斗 HUD）

`25 Label + 55 Sprite = 80 次提交 → 估算 65 DC`。

| 子树 | DC / 组件 | 组成 |
|---|---|---|
| `skills` | **15 / 16** | 4 个技能槽 × (底框 → 图标 → 冷却遮罩 → 锁)，4 种贴图严格交替 ⇒ 16 次提交一次都合不上 |
| `bosses` | **11 / 11** | 3 行 × (图标 + 名字 + 数量 + 倒计时)，Label 独占贴图 |
| `speed` | **8 / 8** | 4 个倍速按钮 × (底框 + Label) |
| `money` | 6 / 6 | 金币/击杀各 (icon + value + desc) |
| `ctlrs_right` | 6 / 6 | 英雄/遗物/商城 各 (按钮图 + Label) |
| `progress` / `hp` / `exp` | 各 3 / 4 | 进度条 Sprite 相邻可合（3 个 ProgressBar 是同一个内置白图） |
| `ctl` | 3 / 3 | 暂停/退出/帮助（3 张散图） |
| `item_bags` / `info` / `head` | 3 / 2 / 1 | — |
| `buff_status` | **1 / 12** | 12 个 Buff 图标同贴图且相邻 ⇒ 已经是 1 DC ✅ |

**按节点名**：`name`(Label) 8、`icon`(Sprite) 8、`value`(Label) 5、`cd_mask` 4、`lock` 4、`label` 4、`count` 3 ⇒ **Label 合计 25 DC（HUD 的 38%）**。

其余静态：`Scene_Game_Stage` = 3 DC（背景 + 英雄 + 射程圈）；运行时每层中央 Graphics（飘字 / 印痕 / 地雷）各 +1 DC。

**运行时增量（随局面变化）**：
- **怪物血条**：`one.prefab` 根是身体（`enimy1.png`），子节点 `hp_bar`（内置白图 `default_sprite_splash`）+ 运行时建的残影条（同贴图）⇒ 每只**正在显示血条**的怪把身体那一段合批切断一次 ≈ **+1~2 DC/条**。攻击上限 3 次/s、血条停 2s ⇒ 常驻 5~6 条 ⇒ **+6~12 DC**（后期更肉更久）。
- **弹道**：`projectile_1.prefab` = 根 `MotionStreak` + 子 `Sprite(white_4x4)`。MotionStreak 走 middleware 分支（要求同一个 meshBuffer 才能合批）⇒ **每发弹道 2 DC**，3~6 发在飞 ⇒ **+6~12 DC**。
- 商店/背包/详情等弹窗打开时各自再叠（`RelicItem` 一格 = 3 Sprite + 3 Label = 6 DC）。

## 2. 优化清单（按性价比，从高到低）

### ① 数字类 Label → 一张 BitmapFont（省 ~8~12 DC）★首推
HUD 里 `value / count / time / lv / x1 / label` 这类**纯数字+符号**文案共 ~13 个，每个现在 1 DC → 换成同一张数字图集的 BitmapFont，全部可合批成 **1~3 DC**。
- 项目已有现成风格与代码：`entityview/GeometricDigits.ts`（飘字就是几何数字，恒定 1 DC）。做法同源：出一张 `0-9 : . / % x k 万` 的 png + `.fnt`，或直接生成 SpriteFrame 序列用脚本拼。
- 汉字类（名字/描述）保留 TTF 即可：它们数量少、字号/颜色杂，BitmapFont 收益低。

### ② 图标分层 + 打图集（省 ~8~12 DC）
现状 `common/*.png` 是 ~30 张散图（gold / monster / pause / exit / help / lock / unlock / bag / right / store / item_shop / hero_select_btn / gold_boss / kill_boss / ad / close …），且**被 Label 交替切断** ⇒ 光打图集不够，必须同时**把同贴图节点排到一起**：
- 给 `assets/resources/textures/common/` 加一张 AutoAtlas（构建期打图集）；
- 把 `skills` 的子结构从「4 个槽各自带 icon/cd_mask/lock」重排成「4 层：`frames[] / icons[] / masks[] / locks[]`」（同贴图的兄弟相邻 ⇒ 16 次提交压到 ~4 DC）。
- `ctl`（3 张图变 1 张图同贴图相邻）⇒ 3 → 1。

### ③ 冷却遮罩改用 `Sprite.type = FILLED`（省 4 DC）
`skills/*/cd_mask` 是一张铺满的白图叠在图标上。改成图标外框 Sprite 自己的 `FILLED`（RADIAL / VERTICAL）fillRange 表现冷却 ⇒ 4 个 `cd_mask` 节点直接不渲染。

### ④ 血条独立成层（省 5~10 DC，后期更多）
把 `hp_bar` 从单位预制件里挪到与 `enimys` 同级的 `hp_bars` 层（或在 `HpBar` 里改画到一个中央 Graphics 上，照 `DamageTextLayer` 的先例）：身体连续（1 DC）+ 血条连续（1~2 DC）。
- 代价：血条节点不再跟随单位父缩放，`HpBar` 现有的「高度补偿 = 1/父缩放」口径要改成按世界坐标写位置；池化复用/层级弹出（`zPop`）要一并处理。
- 更省事的中间态：**让单位图集里带一条白色像素**，`hp_bar` 引用它 ⇒ 身体与血条同贴图 ⇒ 天然合批（前提是单位美术进图集）。

### ⑤ 弹道去掉 MotionStreak（省 3~6 DC）
拖尾换成一枚被拉伸的同贴图 Sprite（`white_4x4`）⇒ 弹头+拖尾同贴图 ⇒ 每发 1 DC；或者把拖尾交给中央 Graphics 层（项目已有三处先例）。

### ⑥ 不划算/慎用的
- **全量 `cacheMode = CHAR`**：`computeHash` 含 fontSize + color + outline，HUD 有 8 档字号 × 多色 ⇒ 每种组合一张字模图集（2048² 级别），**内存换 DC**，本项目字号档位多，收益有限、风险不小。
- **`cacheMode = BITMAP` + 动态合图**：倒计时/金币这类逐帧变的文本会反复重排动态图集，CPU 抖动风险。
- **`UIStaticBatch`**：只适合真正不动的 HUD 底框；进度条/图标/文字都不动的不多。

### ⑦ 先确认瓶颈
50~60 DC 对 2D 手游**不算高**（一般 < 100 都算健康）。若 profiler 里帧率稳定、GPU 时间不高，优先修的是 **JS 逻辑**（每帧重绘 Graphics、事件遍历 40 只怪）而不是 DC。只有「低端机掉帧 + GPU 提交是主因」时才值得动 UI 结构。**越晚改越贵**：UI 结构调整要动预制件与 `View_Game_Stage` 的节点绑定，等美术图全进了再拆图集/换字体成本翻倍。

## 2.5 「boss 战 DC 100+ 且 FPS 掉到 1」—— 先分清是不是同一件事（2026-11 用户报）

用户给的 profiler 截图读数（我把截图放大后逐行核对过）：
`Draw call 82 · Frame time 37ms · Instance Count 0 · Triangle 516 · Game Logic 2ms · Physics 0 · Renderer 1ms · Present 0ms · Texture 33M · Buffer 43M`。

**先读准这张面板**（3.8.6 源码：`profiler/profiler.ts` + `perf-counter.ts`）：

| 格子 | 口径 |
|---|---|
| `Framerate (FPS)` | `PerfCounter.frame()`：**最近约 500ms 里出了几帧** ⇒ 显示 1 ≈ 半秒只出 1 帧（**持续卡，不是单帧毛刺**） |
| `Frame time / Game Logic / Physics / Renderer / Present` | `PerfCounter.end()` 的**当前值**，面板每 ~500ms 采一次样（所以几格之间可以互相对不上，是不同瞬间的样本） |
| `Draw call / Triangle / Instance / Texture Mem / Buffer Mem` | 每 ~500ms 从 `device.numDrawCalls / numTris / memoryStatus` 抄一次 |

**结论：这不是 draw call 的问题。** 82 DC / 516 三角形 / 引擎每帧 3ms —— 引擎和 GPU 都很闲，不可能做出 27 FPS，更不可能 FPS 1。
`Frame time 37ms − 引擎 3ms = 34ms`（以及偶发的 ~1s）**花在 profiler 量不到的地方**：GC、DevTools（控制台/面板本身）、贴图上传、浏览器合成。

按可能性排序的嫌疑（每条都给判据）：

1. **伤害段数爆炸 → 分配风暴 → GC** ★最像。
   本工程 `DamageMeter` 的文件头就写着「用户报：最终 Boss 265 万血，**画面卡一下就死了** ⇒ 只可能是段数爆炸」。
   每一段伤害都会分配：`DamagePipeline` 的 `shieldEvent` + `dmgEvent` 两个字面量对象、`HitVfxLayer.onTakeDamage` 一个、`HitFeelDirector.onTakeDamage` 一个，外加 `DamageMeter.recordInstance` 里 **`targetKey()` 每段拼一个新字符串**（`${name}#${uid}`）—— 段数一爆（一帧几百~几万段），一帧就是几万个小对象 ⇒ 年轻代 GC 每零点几秒一次、老年代 GC 一次停几百 ms~1s。**GC 停顿不在 `Game Logic` 里**，正好解释「logic 2ms / render 1ms 但 FPS 1」。
   判据（现成）：`__dmgMeter.peak`（单帧段数峰值）/ `__dmgMeter.depthGuardHits`（>0 = 伤害链在递归）/ `__dmgMeter.byTag`；把 `__dmgMeter.enabled = false` 再打一场看 FPS 是否好转（账本自己也在每段拼字符串）。
2. **骷髅地雷 = 每颗雷一个 Graphics 节点**（`MineLayer` 2026-11 从"整层一个 Graphics"改成"每颗雷一个预制件节点"，`mine.prefab` 上是 `Graphics`）⇒ **每颗雷恒定 1 DC 且完全不能合批**，雷一多 DC 就线性上涨 —— 这是「DC 82 → 100+」最合理的解释；雷若每帧重画虚线圆，CPU 也同步上涨。
3. **DevTools 控制台刷屏**（profiler 开着 = 控制台开着，每条日志都是同步 DOM 写入）。热路径上真实存在的两处风险：`AudioMgr.playSFX()` 每次调用都 `sys.localStorage.getItem('local_sfx')`，且 **`local_sfx == '0'` 时每次请求都 `console.log('音效声音为0')`**（命中密度最高的 boss 战 = 每秒几十条；⚠ 但全工程没有任何地方**写**这个键，只在你手改过 localStorage 时才触发）；以及结算时 `__runStats` / `__dmgMeter` 两份大报告 —— `Scene_Game_Stage` 注释自己写着「一整块大字符串 + 两次 console.log，控制台开着时渲染几千字符比生成它还贵」。
4. **顿帧不是元凶**：`stopTimeScale 0.02 / stopMsPerWindow 30 / stopMinGapSec 2` 只冻战斗时钟、不冻 UI，观感是"隔两秒定一下"，**不会让 profiler 的 FPS 变 1**（判据 `__hitFeel.stats.stops / stopMsTotal`）。
5. **渲染层**（本文件第 1~2 节那套 DC 优化）：对**移动端/低端机**有意义，但按上面的数**治不了这次的掉帧** —— 别先动 UI 结构。

**工具**：`tools/analysis/stall-probe.js` —— 逐帧打点，把**每个长帧**和那一刻的「段数 / console 调用数 / JS 堆变化 / DC / 三角形」记在一行里；`__stall()` 看长帧榜（含帧耗时分位）、`__stallLog()` 看控制台刷屏榜。

**怎么跑（只认浏览器）**：Creator 的**浏览器预览**或构建出来的 web 包 → F12 → 把文件全文贴进 **Sources ▸ Snippets**（新建一个代码段，免得每次都被 Chrome 的"禁止粘贴"拦一次）→ Run → **关掉 DevTools 打一局**，卡完之后再按 F12 输入 `__stall()`（数据一直在记，与面板开不开无关）。⚠ 编辑器**模拟器预览**是原生窗口，没有控制台，跑不了；"堆MB"那一列只有 Chromium 系有（`performance.memory`），其他浏览器显示 0，其余功能照常。这一张表就能把上面 1/2/3 三条分开。

## 2.6 已落地的两处热路径改动（2026-11）+ 实测结论

| 文件 | 改动 | 性质 |
|---|---|---|
| `platform/audio/AudioMgr.ts` | `playSFX` 不再**每次调用**都 `sys.localStorage.getItem('local_sfx')`、也不再在静音时每次 `console.log`；改成 `isSfxMuted()`（TTL 1000ms 缓存 + **只在开关翻转时**打一条日志） | 热路径卫生：静音状态下的日志洪泛是"一旦触发就致命"的隐患（DevTools 开着时每秒几十条同步 DOM 写入），`localStorage` 同步读也不该按次调用。⚠ 全工程没有任何地方**写** `local_sfx`，所以这条**大概率不是本次 FPS 掉 1 的原因** |
| `game/battle/DamageMeter.ts` | `recordInstance` 的目标键不再每段现拼 `${名字}#${uid}`，改成按实体缓存（`WeakMap` + **现名比对**，`Entity.Reinit` 会改 `name`，所以必须比现名） | 与工程既有纪律一致（"热路径不现拼字符串"）。**实测不是瓶颈**——见下 |

**实测（`tools/analysis/damage-meter-cache-check.cjs`，Node 24 / V8，200 万段）**：

```
旧（每段拼字符串）：11ms / 2000000 段（5.5ns 每段），堆增长 0.3MB
新（WeakMap 缓存）  ：25ms / 2000000 段（12.5ns 每段），堆增长 0.0MB
```

⇒ V8 的年轻代处理"短命小字符串"几乎免费（200 万段只花 11ms、堆只涨 0.3MB），缓存反而让**每次调用慢 ~7ns**
（换算"一帧 1 万段" = 0.07ms，噪声级）。**结论：别把 FPS 掉到 1 的锅扣在这条路上**，也别再从"每段拼字符串"
这个方向找 GC —— 要定位必须用 `tools/analysis/stall-probe.js` 看长帧那一行的「段数 / console / 堆变化」。
自检脚本的用法写在它自己的文件头（`tsc` 编到 `.tmp/dc-build` 再 `node` 跑，键格式 / 池化改名失效 / 两种兜底 / 帧账本四条断言）。

## 2.7 实测案例（2026-11，boss 战「FPS 掉到 1」）—— 结论：**段数爆炸 + 大 GC，与渲染无关**

`tools/analysis/stall-probe.js` 现场抓的 6000 帧（约 4.4 分钟，其中 68 个长帧，Top20 加起来就 **69 秒**）：

| 观察 | 读数 | 说明 |
|---|---|---|
| `DC` / `三角` | 长帧里仍是 **69~76 DC / 1990~10746 三角** | **全程与渲染无关** ⇒ draw call 优化治不了这件事（本文件第 1~2 节那套留给移动端） |
| `console` | 每帧 **0~4**（刷屏榜第一是击杀日志，4 分钟共 ~600 条） | 排除"控制台刷屏" |
| `段数` | 长帧里 **28,131 / 40,020 / 47,078 / 57,014 / 68,204**（正常是几十） | **伤害段数爆炸**；量级恰好落在 `MAX_DEPTH=10` 的连锁反应区间（3^10 = 59,049） |
| `堆MB` / `堆变化MB` | 86 → **137MB**，单帧 **+35MB**，另一些帧 **−51 / −40 / −11MB** | 一帧几万段 × 每段若干临时对象 ⇒ 大堆 + 大 GC |
| `耗时ms` | 1,535 … 3,255ms（**另有两帧 10,244 / 16,898ms 且 `段数=0`**） | 段数≠0 的那批 = 一帧真在处理几万段；`段数=0` 的那批是 **tick 之外**的停顿（最可能是上面那堆垃圾引发的 major GC，也可能是切窗口/最小化导致 rAF 停摆的采样假象） |

**为什么这么慢（三重放大，缺一不可）**：
1. **段数爆炸** —— 一帧几万段（`DamageMeter` 文件头预言的正是这件事）；
2. **每段 × 每个存活实体** —— `EntityView` 是**每个实体各订阅一次** `OnTakeDamage`（它自己的注释就写着"每次伤害事件会遍历所有已订阅视图"）⇒ 事件数是 `段数 × 存活实体数` 的两重乘积（50 只怪 × 5.7 万段 = **285 万次回调**）；
3. **每段若干临时对象** —— `HitVfxLayer.onTakeDamage` / `HitFeelDirector.onTakeDamage` 每段 push 一个对象、`DamageMeter` 每段记账 ⇒ 一帧 +10~35MB 垃圾 ⇒ major GC（堆 137MB 时单次回收几百 ms~数秒）。

**优先修第 1 条（根因）**：用 `__dmgMeter.depthGuardHits`（>0 = 伤害链在递归/连锁）+ `__dmgMeter.byTag`（Top 段数来源）指名那条链，对照 `__runStats` 里这一局的遗物/技能/神器清单找组合。
**第 2、3 条已落地（止血，2026-11）** —— 见下节。

## 2.8 已落地的三项止血改动（2026-11）+ 自检

| # | 改动 | 效果 |
|---|---|---|
| ① | `DamagePipeline` 第 7 阶段**直调** `target.view.onTakeDamage(dmgEvent)`；`EntityView` / `Hero` **不再各自订阅** `OnTakeDamage`（`unsubHit` / `subscribeHit` 整段删除；`Hero.bind` 现在也写 `entity.view`） | 砍掉"每段 × 每个存活实体"的二次放大：50 只怪 × 5.7 万段原来 = **285 万次回调/帧**，现在 = **5.7 万次**。总线上仍留中央层（飘字/印痕/导演/屏闪/场景，数量是常数 ≤5）。直调传的是**同一个 `dmgEvent` 对象**，不额外分配；调用点在 `publish` **之后**，所以表现层读到的是最终血量（场景那条"英雄致命伤拦截"改完血也看得见） |
| ② | `EntityView.onTakeDamage` **整套反应同帧去重**（`director.getTotalFrames()` 比帧号）：第一段做整套（显示血条+起跑残影条+染色+抖动），同帧后续段只走**新增的轻量** `HpBar.setRatio()`（只写宽度与 `hpPct`，不重启残影条、不重置隐藏倒计时） | 同帧几万段打在同一只怪身上时，`setScale`/`sprite.color`/`setContentSize` 从几万次变成 ~1 次；残影条的追赶目标本来就是 `hpPct`，所以它会从"这一帧开始的位置"追到"这一帧结束的位置"，表现不变 |
| ③ | `HitFeelDirector` 落点采样 与 `HitVfxLayer` 逐段记账**每帧封顶** `HIT_FEEL_BUDGET.perFrameHitSampleMax = 512`（超出的只累加计数：`stats.pointsDropped` / `stats.hitsDropped`） | 把"一帧 +10~35MB 垃圾"压成常数级；**诊断口径不受影响**（`peakHitsPerFrame` 仍然数全部段） |

**自检**：`tools/analysis/hitfeel-cap-check.cjs`（可重跑，文件头有两条命令；编译产物落 `.tmp/`）——
① 一次伤害恰好 1 次直调、与总线同一个事件对象、同屏 40 只别的怪一次都不被碰、缺视图/死目标/0 伤害不抛；
②③ 正常帧一个样本都不丢、爆炸帧只留 512 条、`peakHitsPerFrame` 仍数全部、闸门随帧复位。
工程级 `npm run typecheck --prefix tools/excel_export` 保持 **0 错误**。

⚠ 这三条是**止血**：段数爆炸的根因（哪条链在互触）仍要按 §2.7 的判据去查。它们保证的是"再爆一次也不会附带一次 GC 雪崩/几百万次回调"。

## 2.9 根因定案：`暴击回响` 的 N 份副本**互相触发**（2026-11，已修）

### 数据（用户 boss 战，`window.__dmgMeter`，一局 988 秒 / 19,404 帧）

| 指标 | 值 | 读法 |
|---|---|---|
| `instances` | 3,503,592 段 | 全打在最终 Boss 身上（`topTarget` = `最终boss1#47` 3,500,922 段） |
| `damage` | 3,641,027 | **平均每段 1.04 伤** ⇒ 这些段几乎没有伤害价值 |
| `depthGuardHits` | **0** | **深度保险丝一次没响** ⇒ 不是"深递归被截断"，链条是**自然枯竭**的 |
| `peak` | 第 19,369 帧 **65,932 段** | ≈ 一次暴击的全部衍生段 |
| `maxWindow` | **2,234,434 段**（1 秒滑窗） | 占全局段数的 2/3 |
| `topTag` | **10 项全是 `遗物·暴击回响#211@relic:xxxx`**，各 176k~462k 段 | 且其中 6 项彼此只差 ≤62 段（317,5xx）⇒ **各副本在同步开火** |
| `byType` | magical 3,500,922 / physical 2,670 | 英雄只打出 2,670 段物理 ⇒ **每 1 段物理衍生 ~1,311 段魔法** |

`relics.json` 里 **19 件遗物**的 `modifiers_inner` 都引 `遗物·暴击回响#211`（`kv = {pct, radius}`，
文案「暴击时对目标 50 像素内敌人造成 pct% 伤害」）；那一局拿到了其中 **11 件**。
Modifier 实例身份 = `(def.id, origin)`，`origin` 是 `relic:<id>` ⇒ **11 个各自独立的实例**。

### 机制（读代码可证 + 复现床可测）

`RelicHook_CritEcho.OnBattleEvent` 只用一个 `private busy` 防递归。**`busy` 是每实例一个字段**，
所以它只挡得住"自己触发自己"（只挂 1 件时行为完全正确 —— 这是当初没被发现的原因），
挡不住 **A 打出的追加段触发 B、B 的再触发 C……**。

`deal()` → `ctx.damagePipeline.ApplyDamage()` → 第 7 阶段 `source.modifiers.DispatchEvent('on_deal_damage')`
是**同步**的（且在 `depth` 保护范围**内**），`ModifierSystem.DispatchEvent` 迭代 `[...snapshot]`，
于是每份回响的追加段都会把其余 N-1 份全部唤醒一次 ⇒ 段数按组合数爆炸。

**闭式解**：`a(n) = n·a(n-1) + 1` ⇔ **`Σ_{k=0..n} n!/k! ≈ e·n!`**（不是 `Σ P(n,k)`）。
链条只在"追加量 `Math.round(parent×pct/100)` 归零"时枯竭 —— 这正是 `depthGuardHits = 0` 的原因
（英雄 2,670 段物理 → 每段物理 3~5 代就衰减到 0，最大嵌套深度 ~6 ≪ `MAX_DEPTH = 10`）。
**如果 Boss 魔抗再低一点（追加段衰减更慢），链条会撞上保险丝** —— 那就是用户最早报的
「16.9 秒 / 10.2 秒长帧」（第 5 阶段 `段数=0`、堆 −40~−51MB，即穿透性大 GC）。

### 修复（与 `Thorns` 完全同一手法 —— 那一条早就这么写了）

`RelicHook_Thorns` 有两道：① `event.reflected` 直接返回 ② 自己打出的段挂 `{ isReflected: true }`
（`RelicHooks.ts:1008-1012` 的注释："只靠 ① 只能挡住一轮"）。`critEcho` **一道都没有** ⇒ 补上同名两道：

| 文件 | 改动 |
|---|---|
| `DamagePipeline.ts` | `ApplyDamage` / `applyDamageInner` 的 options 加 `isEcho?: boolean`；第 7 阶段的 `dmgEvent` 带 `isEcho: options?.isEcho ?? false`（与既有的 `reflected` 并列） |
| `RelicHooks.ts` | `deal()` 加第 6 个可选参数 `options` 透传给 `ApplyDamage`；`CritEcho.OnBattleEvent` 开头加 `if (event?.isEcho) return false;`，`aoe` 里的 `deal` 改传 `{ isEcho: true }`；类注释重写成"两层防护"并写明**只留 `busy` 就是这次的 bug** |

**语义**：一次暴击 = 根那 1 段 + **N 段**（N 件遗物各打一圈）—— 与文案一致。
`busy` 保留（同一次派发内不许自己重入），但它不再是唯一的防线。

### 自检 / 复现：`tools/analysis/crit-echo-cascade-check.cjs`

用**真** `DamagePipeline` + **真** `RelicHook_CritEcho` + **真** `DamageMeter`（`battle/**` 零 `cc` 依赖，
桩只做 ctx/实体/`DispatchEvent` —— 派发那段逐行照抄 `ModifierSystem`）。文件头有两条命令，产物落 `.tmp/`。

| 份数 N | 修复前（实测/闭式解） | 修复后 |
|---|---|---|
| 1 | 2 | **2**（根 + 1） |
| 2 | 5 | **3** |
| 3 | 16 | **4** |
| 4 | 65 | **5** |
| 5 | 326 | **6** |
| 6 | 1,957 | **7** |
| **11**（用户实测份数） | **28,671,512**（闭式解 108,505,112；被 `MAX_DEPTH` 截断，`guard = 39,916,800`） | **12** |

修复后 4 项判据全 PASS：① 段数 = N+1 ② 11 份降幅 ~986 万倍 ③ **非回响来源的暴击照样触发回响**
（4 份 → 5 段，不误伤"该响的场合"）④ 保险丝不再被触发（链路深度恒为 2）。
工程级 `npm run typecheck --prefix tools/excel_export` 保持 **0 错误**。

### ⚠ 这是**平衡改动**，不只是性能改动

修复前那条链贡献了 **2,650,000 伤**（Boss 全部 265 万血）—— 也就是用户最早报的
「最终 Boss 265 万血，画面卡一下就死了」。修复后暴击回流派的强度回到设计值：
**Σ pct 之和 ≈ 590% 的暴击伤害**（11 件：80+80+50×7+30，50px 范围魔法伤害），不再是一击秒 Boss。
若要让这条流派回到"强"，正确做法是**调 `relics.json` 的 `kv.pct`**，不是恢复副本互触。

同族排查：`Thorns` 已有两道标记 ✅；`ShopSkillModifiers` 里的追加伤害类钩子打出的段**不带** `isEcho`
（正确 —— 技能溅射暴击本来就该触发回响）。**新增任何"钩子打追加段"的类时，先问一句：
这东西的追加段会不会再喂回自己的触发器？会的话就必须挂标记。**

## 2.10 现场复测（修复后，用户实测一局）—— 结论：**段数回到设计值，最差 1 秒滑窗降 1397 倍**

同一套 `__dmgMeter` 账本、修复前后各一局（都是完整局：`frames` 19.4k / 21.3k）。
⚠ 修复前那局是 **victory**；修复后那局的胜负**尚未确认**（原因见下面「平衡实测」一节）。

| 指标 | 修复前（bug 版） | 修复后 | 降幅 |
|---|---|---|---|
| 全程段数 `instances` | 3,503,592 | **20,303** | 173× |
| 全程伤害 `damage` | 3,641,027 | 1,617,778 | 2.25× |
| **峰值单帧段数** | 65,932 | **57** | **1,157×** |
| **最差 1 秒滑窗段数** | 2,234,434 | **1,599** | **1,397×** |
| 对最终 Boss 段数 | 3,500,922 | 17,871 | 196× |
| 对最终 Boss 伤害 | 2,650,000 | 562,684 | 4.7× |
| `depthGuardHits` | 0 | 0 | — |
| 帧数 `frames` | 19,404 | 21,333 | — |

### 峰值帧可以**逐段对上**（"没有级联"最硬的证据）

修复后最差那一帧（frame 21011，57 段）的账本顶部写着
`遗物·暴击回响#211@{1208,1190,1157} 各 7 段` —— 即**这一帧发生了 7 次暴击**，
每次暴击让 7 件回响各打 **1** 段：`7 件 × 7 次 = 49` 段 + 7 段暴击本身 = 56，
再加 1 段别的来源 = **57，一位都不多**。
修复前同一位置是每标签 **317,5xx 段**。

### 伤害结构回到健康区间

| 来源 | 段数 | 伤害 | 占比 |
|---|---|---|---|
| 普攻 | 1,414 | 630,672 | 39.0% |
| 暴击回响（7 件合计） | 15,861 | 395,824 | 24.5% |
| 其余（爆头冲击 / 中毒 / 其他遗物 / 弹道） | ~3,000 | 591,282 | 36.6% |

### ⚠ 平衡实测：级联消失后，最终 Boss **打不死了**（待用户裁决）

`finalBossUnitId = 2011`（`units.json` 基础 HP **500,000**）× `FINAL_BOSS_HP_MUL` **5.3**
× `bossHpMul(难度 1) = 1.0583⁰ = 1` = **2,650,000** —— 正好等于修复前那一局对 Boss 的伤害。
（`ChangeHp` 在目标死亡后即停，所以那个数会**精确等于血条上限**；这也反过来证明当时它确实死了。）

修复后同一只 Boss 只吃到 **562,684 = 21.2%**。
**也就是说：修复前那局能通关，靠的就是这个 bug。** 这条流派按设计值打出来的是
「Σ pct 的暴击伤害」级别的 50px 范围魔法伤害，不是 265 万。

⚠ 这里有个**必须由用户裁决**的问题：**是"Boss 太肉"还是"这条 build 本来就打不过"？**
- 若那局是**败局** ⇒ 265 万这条血量**只有在级联存在时才可打**。要么按定标口径重推
  `FINAL_BOSS_HP_MUL`（但 `BossStrengthConfig` 文件头明确写了"不要靠抬倍率加难度"，
  且那条倍率服务的是**难度 100 的最高成长玩家**），要么接受"当时是被 bug 抬着通关的"。
- 若是**胜局**（或那一枪没打完 / 走的是非 `ChangeHp` 的斩杀）⇒ 无需处理。

反过来说：**级联吞掉的其实只有 Boss 那一条血。** 全程伤害只从 3.64M 掉到 1.62M（2.25×），
而对 Boss 的伤害掉了 4.7× —— 小怪血量小、死亡即停，级联砸在它们身上本来就被夹住了。

⚠ 本节只量了**段数/滑窗**这两笔账；**FPS 侧等用户复测确认后再补**（本文件不写没量过的数，见 §0）。

## 3. 预期收益（静态模型外推）

| 阶段 | 估算 DC |
|---|---|
| 现状（HUD 静态） | 65 + 战斗内容 ~10 ⇒ 实机 50~60（用户观测） |
| 做 ①（数字 BitmapFont） | −10 |
| 做 ②③（图集 + 分层 + FILLED） | −12 |
| 做 ④⑤（血条层 + 弹道） | −8~15 |
| **合计** | **⇒ 25~35** |
