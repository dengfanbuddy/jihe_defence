# 难度选择（100 档）· 运行期契约

> 出图规范与提示词清单见同目录 `prompts.md`（`diff_tier_*` / `diff_boss_gate` / `diff_ladder` 等）。
> **本文件讲的是代码**：弹窗读了什么、点了之后发生什么、局内怎么按难度改数值。

---

## 1. 一句话流程

```
主界面「开始游戏」(bottom/right/enter_game)
   └─ Scene_Menu.onClickEnterGame()             → setupDifficultyPanel() + ui_difficulty.active = true
        └─ Cmp_Difficulty.onShow()              → 首次照模板铺 100 格，每次按最新进度重画三态 + 详情条「关卡 09」
             ├─ 点格子                          → Cmp_DifficultyCell scope.emit(Pick) 冒泡上来
             │                                     → 只改弹窗自己的 pending（**不落盘**）
             ├─ 点「确定」                      → scope.emit(DifficultyScopeEvents.Confirm, level)
             │                       └─ Scene_Menu.enterGame(level)
             │                            ├─ LevelData.selectLevel(level)   ← 落盘（必须在跳场景之前）
             │                            └─ UIManager.showUI(Scene_Game_Stage)
             └─ 点「关闭 ×」                    → scope.emit(DifficultyScopeEvents.Close) → 收起弹窗（数据不动）

局内：Scene_Game_Stage.resetRun() 读 LevelData.getSelectedLevel() → this.difficulty（本局全程不变）
      → 怪物属性 / 刷怪间隔 / 击杀奖励三处按 DifficultyConfig 的倍率生效
      → 通关（endRun('victory')）→ LevelData.markCleared(N) → **解锁第 N+1 档**
```

**分层**（与工程其它界面一致）：弹窗只渲染 + 上报；**落盘与跳场景在宿主 `Scene_Menu`**（那是"流程归谁管"的问题）。

---

## 2. 文件清单

| 文件 | 角色 |
|---|---|
| `assets/scripts/game/common/DifficultyConfig.ts` | **曲线唯一真源**（纯 TS）：`enemyHpMul` / `bossHpMul` / `enemyAtkMul` / `rewardMul` / `spawnGapMul` / 段名 / 档位文案 |
| `assets/scripts/game/data/funcs/LevelData.ts` | 进度存档：`cleared`（已通关最高档）/ `selected`（当前选择）/ `lastPlayed`；**唯一解锁判据** |
| `assets/scripts/game/ui/scenes/scene_menu/cmps/Cmp_Difficulty.ts` | 弹窗控制器（铺格 + 算三态 + 选择 + 两条向上通知） |
| `assets/scripts/game/ui/scenes/scene_menu/cmps/Cmp_DifficultyCell.ts` | **一格**（`DifficuteCell.prefab` 的根组件）：只画三态 + 点一下往上冒泡 `Pick` |
| `assets/resources/prefabs/ui/scenes/scene_menu/cmps/DifficuteCell.prefab` | 格子的预制件（ring / bg / num / unlock / mark）；`content` 里放一个实例当模板 |
| `assets/scripts/game/ui/scenes/scene_menu/cmps/DifficultyScope.ts` | 弹窗内部的 scope 事件键（格子 `Pick` / 弹窗 `Confirm` · `Close`） |
| `assets/scripts/game/ui/scenes/scene_menu/Scene_Menu.ts` | 宿主：持有弹窗节点、写显隐、落盘 + 进游戏、主界面进度标签 |
| `assets/scripts/game/game_stage/entityview/MonsterPool.ts` | `statScaleHook`：难度缩放的**注入点**（池子不知道"难度"是什么） |
| `assets/scripts/game/ui/scenes/scene_game_stage/Scene_Game_Stage.ts` | 局内落点：`applyDifficultyScale` / `getSpawnInterval` / `currentRewardScale` / `endRun` 解锁 |
| `assets/scripts/game/stores/useBattleStore.ts` | `difficulty` 投影（HUD 显示「难度 N」用） |

---

## 3. 弹窗节点契约（`prefabs/ui/scenes/scene_menu/Scene_Menu.prefab`）

```
Scene_Menu
└── ui_difficulty                 ← 组件**已挂在预制件上**（`Cmp_Difficulty`，几个 @property 都拖好了）
    ├── mask                      全屏遮罩（纯视觉，**不接点击**：Cocos 只命中"注册过监听器的节点"，
    │                             挂上监听会让"点标题/图例"也关窗）
    └── panel
        ├── bg
        ├── header                title(难度选择) / count(共 100 关) / btn_close
        ├── legend                三态图例（纯展示，代码不碰）
        ├── detail                title(关卡 09) / btn_start(确定)
        └── list(ScrollView) → content(GRID Layout, 10 列) → cell   ← 模板（DifficuteCell 预制件实例）
                                                                    └── ring / bg / num / unlock / mark
```

* **铺格**：模板 = `content` 里作者摆的那一个 `DifficuteCell` 实例（节点名 `cell`）。运行期照它克隆
  `DIFFICULTY_MAX` 个，**模板自己当第 1 格** —— 不留模板节点：多一个不可见的模板也会被 GRID Layout
  排进网格、整排错位一格（若模板节点被改名，`Cmp_Difficulty` 会报一条带解决方法的 error）。
* 格子的档位**不按节点名解析**：铺格时 `cell.setNum(level)` 写进 `Cmp_DifficultyCell.cellNum`，
  `cell_001` 这种名字只用于排查（`DIFFICULTY_MAX` 100 → 10 列 × 10 行，**一行 = 一个段**，
  与设计稿「10 段 × 10 档」同构）。
* 首次打开铺一次，之后每次打开**只重画状态**（100 个节点的增删没必要每次做）。
* `count` 写「共 100 关」（档数取自 `DIFFICULTY_MAX`，**不是**写死的文案）。

### 3.1 三态

| 状态 | 判据 | 底 | 数字 | 徽记 | 选中环 |
|---|---|---|---|---|---|
| 当前选择 | `level === pending` | `#406E6E` | 白 | 白菱形 | **显示** |
| 已解锁 | `level <= unlocked` | `#C6D0D0` | 墨 `#3A4A4E` | 墨菱形 | — |
| 未解锁 | `level > unlocked` | `#737E84` | 白 | 白锁（`interactable=false`） | — |

* 三态**与弹窗图例一一对应**；配色真源 = `Cmp_DifficultyCell` 顶部的五个常量（`COLOR_STYLE` 那个时代已过去，
  现在一格一组件、只管自己）。
* 徽记两张都在 `DifficuteCell.prefab` 里：`unlock` = 12×12 白方块转 45° 的**菱形**，
  `mark`（`@property` 里叫 `lockNode`）= 16×18 的 `textures/common/lock`。**不再运行时加载碎图**。
* **不接 Button 的 COLOR 过渡**：`interactable = false` 时 Button 会用 `_disabledColor` 统一覆盖外观
  （`AchievementItem` / `TaskItem` 踩过）。格子在预制件里是 `SCALE` 过渡，颜色全由代码写。
* ⚠ 「已通关」目前**没有独立外观**（图例只有三态）。要加回"打过的和没打的分得清"，最省事的做法是
  在 `Cmp_DifficultyCell` 里把 `unlock` 节点的图换成 `textures/common/gou`（12×12，与菱形同尺寸，
  换图即可、不用改布局）—— 判据现成：`LevelData.isCleared(level)`。

### 3.2 解锁规则

**通关第 N 档 → 解锁第 N+1 档**（`LevelData.getUnlockedLevel() = min(cleared + 1, 100)`）：
一档没通关时只有档 1 可玩；首次游玩默认难度 1。脏存档（选择 > 已解锁）在**读取时**收敛，不写盘。

> 设计稿里还有两条**尚未落地**的表现（预制件里没有对应节点，做的时候再补）：
> ① 每 10 档一个**段末"头目门槛"档**（略宽 + `diff_boss_gate` 小标）；
> ② 10 个**段页签**（`diff_tier_01~10`）与弹窗顶部主插图 `diff_ladder`。
> 段名（新兵/老兵/…/终焉）已经在 `DIFFICULTY_TIER_NAMES` 里备好，目前只出现在日志里。

---

## 4. 局内怎么按难度改数值（**五个落点**）

| 改什么 | 在哪 | 倍率 |
|---|---|---|
| 怪 HP（普通/精英） | `Scene_Game_Stage.applyDifficultyScale`（经 `MonsterPool.statScaleHook`） | `1.10^(N-1)` |
| 怪 HP（阶段 / 最终 Boss） | 同上（按 `UnitKind` 分流） | `1.12^(N-1)` |
| 怪 攻击 | 同上 | `1.08^(N-1)` |
| 刷怪间隔 | `Scene_Game_Stage.getSpawnInterval` | `max(0.75, 0.97^(N-1))` |
| 击杀金币 / 经验 | `Scene_Game_Stage.currentRewardScale`（**唯一的奖励乘区出口**） | `1.06^(N-1)` |
| 解锁推进 | `Scene_Game_Stage.endRun`（仅 victory） | — |

四条口径（改之前先读，都是踩过的）：

1. **档 1 = 当前基准平衡**（所有倍率恒为 ×1）：老玩家从档 1 重开一局，一个数都不变。
2. **缩放必须"每只怪出生一次"**：对象池复用会先按配置 `Reinit`（基础属性回到配置值），
   所以倍率是挂在 `MonsterPool.acquire` 上的回调，而不是"开局算一次"。
   它排在**挂表现之前** —— `EntityView.bind` 会拿当前 `hp/maxHp` 初始化血条，写在后面会错位一帧。
3. **只乘基础值（`AttributeSystem.setBase`）**，不动攻速/护甲/移速：那属于"这只怪是什么怪"。
   回写要过 `AttributeScaling.denormalize`（`getBase` 给 float、`setBase` 吃配置 int）。
4. **刷怪间隔有下限**（`SPAWN_GAP_MIN = 0.75`）：设计稿的 0.97^(N-1) 是按难度 1~10 推的，
   0.97^99 ≈ 0.049 是 20 倍出怪速率 —— 会同时撞上同屏保险丝（`SPAWN_ALIVE_HARD = 50`）
   与「后期难度靠每只怪更肉、不靠一秒比一秒多」这条定论（`docs/局内刷怪节奏设计.md`）。

### 4.1 曲线样本（`DifficultyConfig.curveTable()` 可直接打印全表）

| 档 | 怪 HP | 怪攻击 | Boss HP | 收益 | 刷怪间隔 |
|---|---|---|---|---|---|
| 1 | ×1.00 | ×1.00 | ×1.00 | ×1.00 | ×1.00 |
| 10 | ×2.36 | ×2.00 | ×2.77 | ×1.69 | ×0.76 |
| 30 | ×15.9 | ×9.3 | ×26.8 | ×5.42 | ×0.75 |
| 100 | ×12528 | ×2037 | ×74573 | ×320 | ×0.75 |

> ⚠ **曲线是指数的，且刻意比收益涨得快**（HP 1.10^N vs 收益 1.06^N）：差额要由**局外成长**补
> （`docs/数值设计调研报告_肉鸽塔防.md` §4：每档净需多 ~3~4% 输出）。设计稿的节奏是「3~4 天过 1 档」。
> **本作目前的局外成长远达不到这条曲线** —— 想让高档次可玩，最省事的做法是调软 `DifficultyConfig`
> 里的四个底数（例：全改 1.05 → 档 100 ≈ ×126），只改这一个文件、四处调用点都不用动。

---

## 5. 主界面上的其它接线

* 「阶段模式」卡的两个数值标签（原来写死 `99`）：**最高通过** = `cleared`，**上次玩过** = `lastPlayed`
  （`Scene_Menu.refreshLevelProgress`，只在 `init` / `show` / watcher 里写）。
* 局内 HUD 左上角 `info/name`（原来写死「难度 99」）：本局难度 = `battleStore.difficulty`
  （`View_Game_Stage.refreshDifficulty`）。
  ⚠ 旁边的 `info/mode` 仍写着预制件里的死文案「阶梯模式」，与主界面的「阶段模式」不一致 ——
  没在本轮改动范围内，要统一就改预制件那一条 Label。

## 6. 验收清单

- [ ] 主界面点「开始游戏」→ 弹出难度弹窗（**不再直接进游戏**）。
- [ ] 一档都没通关时：只有档 1 可点（深青绿 + 选中环 + 白字 + 白菱形），2~100 全是深灰底 + 白锁。
- [ ] 点已解锁的格子 → 选中环搬过去、详情条变「关卡 NN」，原来那格变回浅灰底墨字。
- [ ] 100 格排成 **10 列 × 10 行**（`content` 上有 GRID Layout），整屏不用滚动。
- [ ] 点「确定」→ 弹窗收起 + 进战斗；HUD 左上角显示「难度 N」；控制台有一行 `[难度] 本局难度：…`。
- [ ] 控制台 `[奖励] 击杀 …` 的 `x` 系数随档位变大（档 1 与档 5 对比）。
- [ ] 通关一局 → 回主界面，「最高通过」= 该档、「上次玩过」= 该档，再开弹窗时**下一档已解锁**。
- [ ] 中途退出（HUD 退出按钮）→ **不算通关**（不解锁下一档），但「上次玩过」已更新。
- [ ] 反复开关弹窗：格子不会越铺越多（控制台 `[难度选择] 铺格完成：100/100` 只出现一次）。
