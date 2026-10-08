# 游戏模式（主界面「游戏」页）· 运行期契约

> 讲的是**代码**：模式卡点了之后发生什么、顶部那两格读数从哪来、难度弹窗怎么知道"这是哪个模式的难度"。
> 局内的**玩法差异（无尽模式）目前还没做** —— 现状与落地入口见 §5，别把它当成已完成。

---

## 1. 一句话流程

```
主界面「游戏」页（content/right/game）
  ├─ 点一张模式卡（<id> = stage / no_ending）
  │    └─ Cmp_Game.onClickCard(id)
  │         ├─ LevelData.selectMode(id)        ← **唯一落盘口**（非法 id 一律拒绝）
  │         └─ render()                        ← 重画：顶部信息 + 卡片选中态（幂等）
  │
  └─ 点「开始游戏」(bottom/right/enter_game，归 Scene_Menu)
       └─ Scene_Menu.onClickEnterGame() → ui_difficulty.active = true
            └─ Cmp_Difficulty.onShow()  ← 读**当前模式**那一份进度（标题写成「阶段模式 · 选难度」）
                 ├─ 点格子 → 只改弹窗自己的 pending（不落盘）
                 └─ 点「确定」→ Scene_Menu.enterGame(level)
                      ├─ LevelData.selectLevel(level, mode)   ← 落盘（按模式各记一份）
                      └─ UIManager.showUI(Scene_Game_Stage)
                           └─ Scene_Game_Stage.resetRun() 读 mode + difficulty → battleStore
```

**分层**（与工程其它界面逐字同口径）：页面（`Cmp_Game`）自己读写数据层并画自己的子树；
宿主 `Scene_Menu` 只管"开下一屏"与"组件在不在"；难度弹窗只渲染 + 上报。

---

## 2. 文件清单

| 文件 | 角色 |
|---|---|
| `assets/scripts/game/common/GameModeConfig.ts` | **模式唯一真源**（纯 TS）：支持哪几个 / 默认哪个 / 名字与卡面文案 / 难度弹窗标题文案 |
| `assets/scripts/game/data/funcs/LevelData.ts` | 存档：`mode`（当前模式）+ `modes[]`（**每个模式各一份** `selected`/`lastPlayed`）+ `cleared`（全局解锁阶梯） |
| `assets/scripts/game/ui/scenes/scene_menu/cmps/Cmp_Game.ts` | 「游戏」页控制器：模式卡选中 + 顶部信息（`@ccclass('Cmp_Game')`，挂在 `content/right/game`） |
| `assets/scripts/game/ui/scenes/scene_menu/Scene_Menu.ts` | 宿主：`setupGamePage()` 确保组件在；`enterGame()` 落盘档位并进游戏 |
| `assets/scripts/game/ui/scenes/scene_menu/cmps/Cmp_Difficulty.ts` | 难度弹窗：标题点名**当前模式**；`onShow` 取当前模式的待确认档 |
| `assets/scripts/game/stores/useBattleStore.ts` | `mode` 投影（HUD 左上角显示模式名） |
| `assets/scripts/game/ui/scenes/scene_game_stage/Scene_Game_Stage.ts` | `resetRun()` 读一次模式；**局内规则尚未按模式分岔**（§5） |
| `assets/scripts/game/ui/scenes/scene_game_stage/cmps/View_Game_Stage.ts` | HUD `info/mode` 写模式名（原来是预制件里的死文案「阶梯模式」） |

---

## 3. 节点契约（`Scene_Menu.prefab` → `content/right/game`）

```
game                       ← Cmp_Game 挂这里（5 个 @property 都在预制件里拖好了）
├── info
│   ├── name               ← 模式名（如「阶段模式」）
│   │   └── desc           ← 模式说明（两行，**是 name 的子节点**）
│   ├── passed/value       ← 最高通过（全局：已通关的最高档）
│   └── last/value         ← 上次玩过（**按模式**：该模式上次打过的档）
└── lists(ScrollView + Mask)
    └── contents           ← 卡片容器（GRID/VERTICAL Layout）
        ├── stage          ← 模式卡：**节点名 = 模式 id**
        │   ├── bg / game_bg
        │   ├── active     ← 选中态覆盖层（青绿环 + 角标 + 勾，整卡大小，**不接点击**）
        │   └── name / desc
        ├── no_ending      ← 同上
        └── card-002       ← 「挑战boss」：**没做** → Cmp_Game.onInit 里显式 `active=false`
```

三条口径：

1. **卡片按名字匹配，不按下标**：多摆/少摆一张卡、调换顺序都不会串位；名字不在 `GAME_MODES` 里的卡一律收起
   （点了没反应的东西不该出现在列表里）。加模式 = 加一行 `GAME_MODES` + 在 `contents` 下摆一张**同名**卡。
2. **不用 `Button`**：卡片是"选中项"不是"按钮"（Button 的 SCALE/染色过渡与 `interactable` 会带来副作用，
   `AchievementItem`/`TaskItem` 踩过）。与底部三个页签同口径，走节点 `TOUCH_END`。
   整卡大小的 `active` 覆盖层**不会挡点击** —— Cocos 的节点触摸只命中"注册过监听器的节点"。
3. **`onShow` 无条件重画**：本页节点会被左侧页签 `active=false` 收起（`Cmp_FuncTabs`），
   收起期间 watcher 是暂停的；切回来必须按当前数据整块刷一次（`scope.resume()` 的补播是另一条保险）。

---

## 4. 数据层口径（`LevelData`）

| 字段 | 作用域 | 谁写 |
|---|---|---|
| `mode` | 当前选中的模式 | `selectMode()`（模式卡点一下） |
| `modes[].selected` | **每个模式各自**"准备打的档" | `selectLevel(level, mode)`（难度弹窗「确定」） |
| `modes[].lastPlayed` | **每个模式各自**"上次打过的档" | `markPlayed()`（进战斗时）/ `markCleared()` |
| `cleared` | **全局**：已通关的最高档 ⇒ 解锁阶梯 = `cleared + 1` | `markCleared()`（仅 victory） |

四条必须知道的口径：

1. **`modes` 是数组，不是字典**：`DataModule` 读档走 `mergeDeep`，"默认值里没有这个 key"的动态字典会被整片吃掉
   （`BagData.items` / `EquipmentCollection.collected` 都踩过）；数组是整体覆盖，安全。
2. **只有 `cleared` 是全局的** —— 两个模式**共用同一条解锁阶梯**（设计稿：
   「无尽模式 = 在已解锁难度上无限阶段」，`docs/prd/肉鸽塔防_游戏设计定案.md` §14.3）。
   所以主界面顶部「最高通过」两个模式显示同一个数，「上次玩过」跟着模式走。
   **要让「最高通过」也分模式**：改 `LevelData.getClearedLevel()` 一处（其余读法都从它出）。
3. **老存档无损迁移**：只有 `selected` / `lastPlayed` 两个标量、没有 `modes` 数组的存档，
   在读档时把那两个值归到**默认模式（阶段模式）**名下（那时工程里只有它一个模式）。之后那两个字段不再读写。
4. **刷新靠指纹**：主界面 watcher 的源是 `LevelData.progressKey()`（模式 + 全局进度 + 各模式 selected/lastPlayed）。
   它**只读、不建记录** —— 在 watcher 的取值函数里改数据会造成追踪重入。

---

## 5. 局内的模式差异 —— 🚧 **尚未落地**（现状是"只投影、不分岔"）

现在 `Scene_Game_Stage.resetRun()` 只做两件事：

```ts
this.battleStore.mode = DataCenter.ins.levelData.getMode();
console.log(`[模式] 本局模式：${gameModeName(this.battleStore.mode)}`);
```

**没有任何一条规则按模式分岔** —— 选「无尽模式」进局，跑的还是阶段模式那套
（4 个常规阶段 → 最终 Boss → 胜利/失败），因为 `checkStage()` 只认 `this.stage` 与 `FINAL_BOSS_STAGE`。

落地时的**唯一入口**是 `Scene_Game_Stage.checkStage()`（阶段推进与结束判定的唯一收口）：
阶段上限、Boss 阶段是否结束、怪强度是否随时间继续爬，都在这一个方法里按 `this.battleStore.mode` 判，
**不要在别处零散地判模式**（零散判会立刻出现"有的地方按无尽、有的地方按阶段"的半成品态）。

顺带记着两条现成的口子（都不是给模式用的，别误用）：

- `useBattleStore.maxPhase`（`0 = 无限`）是**旧 FSM**（`game_stage/states/BattleState.ts`）的字段，
  而那个 FSM **全工程没有调用方**（见 `docs/platform-guide/README.md` 的接线总表）—— 别拿它当无尽模式的开关。
- `GameStageConfig.winTime` 同样是未消费字段（自述"保留给后续玩法"）。

---

## 6. 验收清单

| 项 | 判据 | 状态 |
|---|---|---|
| 模式卡收集 | 预制件 `contents` 下 `stage` / `no_ending` 都被绑上点击，`card-002` 被收起 | ✅ 真跑过（克隆件上直调 `onInit`：`cards=2`，`card-002.active=false`） |
| 默认选中 | 首次进主界面 `stage` 的 `active` 覆盖层亮、`no_ending` 灭 | ✅ 真跑过（同上，`stage sel=true / no_ending sel=false`） |
| 点一下换模式 | 覆盖层翻转 + 落盘 + 顶部信息跟着变 | ✅ 真跑过（`onClickCard('no_ending')` → 覆盖层翻转，点回来复原） |
| 顶部读数 | 「最高通过」= `cleared`，「上次玩过」= 当前模式的 `lastPlayed` | ✅ 真跑过（新档：`0 / 0`，文案与预制件占位一致） |
| 老存档迁移 | 旧档的 `selected`/`lastPlayed` 落到阶段模式那一条、不丢进度 | ⚠ 代码路径已写、**没有真档可验**（开发机上没有旧存档样本） |
| 难度弹窗点名模式 | 标题显示「阶段模式 · 选难度」，且**不压出面板/不盖关闭按钮** | ✅ `labelFit` 真量（237px → `[-310, -74]`，面板 `[-320, 320]`、count 盒从 147 起） |
| 按模式各记档 | A 模式选档 7 后切到 B，B 的弹窗仍停在它自己那一档 | ⚠ 逻辑由 `modes[]` 保证，**未真跑**（需要两次进弹窗的人工验收） |
| 局内模式投影 | HUD 左上角显示模式名（原来是死文案「阶梯模式」） | ⚠ **未真跑** —— 编辑器内预览的 `scripts` 分包加载不起来（见下），HUD 那条只能等真机/浏览器预览 |
| 局内规则分岔 | 无尽模式无终点 | ❌ **未实现**（§5） |

> ⚠ 本轮**没有拿到真实渲染截图**：`cocos_capture_view` 回 `blankRatio ≈ 0.99`（`view.visibleMatchesDesign: true`
> 但画面为空，工具已 `invalidate()` 逼过一次重绘仍为空）。画面判据用的是**数值判据**：
> `worldRect` / `labelFit` / 逐节点读 `spriteFrame.name` 与 `active`。
> 编辑器内预览（`cocos_runtime play`）也**卡在 `Loading` 场景的 `loadBundle('scripts')`**（进度 0%，分包既不成功也不失败），
> 所以"跑起来看一眼"这条路本轮走不通 —— 这是环境限制，与本轮改动无关（加载分包的是 `Loading.ts`，没动过）。
