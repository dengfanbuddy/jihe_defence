/**
 * useBattleStore — 战斗状态 Store
 *
 * 管理**局内（这一局）的运行状态与它的响应式投影**，供场景逻辑与 UI 共享。
 *
 * ── 放什么（判据是「这个概念属于谁」，不是「现在谁在读」）──
 *   ① **UI 摆放 / 功能页面状态**（面板开关、面板要渲染的候选、界面私有选中态）→ 不属于这里，归 `UIScope`：
 *      宿主 `provide` **功能门面**（`HeroSelectVM` / `RelicShopVM` / `BuffShopVM` / `SkillSlotsVM`），
 *      子孙 `inject`（键见 `game/ui/scenes/scene_game_stage/cmps/StageScope.ts`）。
 *      判据：删掉那个控件，这个值就没有意义了。
 *   ② **局内运行状态**（`level` / `exp` / `expToNext` / `enemiesAlive` / `isPaused`）→ 留在这里：
 *      它们不是「给 UI 看的」，而是场景自己的升级 / 刷怪 / 抽卡 / 暂停逻辑的运算对象
 *      （`Scene_Game_Stage.addBattleExp` 直接拿 `level/exp/expToNext` 算升级，遗物面板刷新读 `level` 挑品质档位）。
 *   ③ **战斗真源的响应式投影**（`hp` / `maxHp` / `gold` / `kills` / `killPoints` / `phase` / `phaseRemainTime` /
 *      `phaseTotalTime` / `heroId` / `heroSkills`）→ 留在这里：
 *      真源在 `Entity` / 场景字段，UI 只读。它们描述的是**这一局战斗**（生命周期 = 对局，不是某个 widget），
 *      且跨层视图（popup 层结算 / 商店弹窗）读不到 scope —— 只有本界面内部的 UI 能读到的东西，才轮到 ①。
 *
 * @example
 * ```ts
 * // 本项目约定：store 里 hp/maxHp 等是「投影值」，真源在 Entity/战斗系统，
 * // 由场景在关键事件后写入（见 Scene_Game_Stage.syncHeroToStore）
 *
 * // UI 节点中（自动响应）
 * import { useBattleStore } from '../../game/stores'
 * const battle = useBattleStore()
 * // battle.hp 是响应式的，绑定到 Label 即可
 * someLabel.string = `${battle.hp}`  // 随 hp 变化自动更新
 * ```
 */

import { defineStore } from '../../platform/store'
import { ref } from '../../platform/reactivity'
import { DEFAULT_GAME_MODE } from '../common/GameModeConfig'
import { BATTLE_SPEED_DEFAULT } from '../common/BattleSpeedConfig'

/**
 * 每击杀一只怪得到的**击杀数**（击杀商店货币）—— **缺省值**。
 *
 * 真值在 `units.json.killReward`（缺省回落这里）：杂兵一律 1，**玩家自己放的「击杀怪」**
 * （units#2009，`rewardType = 'kill_boss'`）是 150 —— 那个槽位的设计就是"用一场硬仗换一叠击杀数"。
 * 宿主（`Scene_Game_Stage`）按死者配置解析出点数，再调 `onEnemyKilled(points)`；
 * 这一条同时是"配表没写 / 写脏了"的兜底。
 */
export const KILL_POINTS_PER_KILL = 1

export const useBattleStore = defineStore('battle', () => {
  // ── 英雄状态（投影值，实际真源在 Entity/战斗系统，由场景 syncHeroToStore 写入） ──
  const hp = ref(100)
  const maxHp = ref(100)
  /**
   * 本局出战英雄的单位配置 id（units.json 的 hero 段）。0 = 尚未选英雄。
   * 投影值，真源在 `Scene_Game_Stage.hero`；UI 靠它去 units.json 查 `head_icon` 等
   * **英雄相关**展示数据（UI 自己不知道「现在是谁上场」，只能读这个 id）。
   */
  const heroId = ref(0)
  /**
   * 英雄当前拥有的技能 id 列表（units.json 的 `abilities` + 肉鸽商店抽到的；含被动，不含普攻）。
   * 投影值，真源在 `Entity.abilities.getAll()`；场景在 `syncHeroToStore` 里写。
   *
   * ⚠ **HUD 技能栏不再读它**：技能栏的 4 个格子由 `SkillSlots`（槽位 / 锁定 / 等级）驱动，
   *   经 `StageScopeKeys.SkillSlots` 把**功能门面 `SkillSlotsVM`** provide 给格子组件 —— 本字段只是
   *   "这个英雄会哪些技能"的平铺列表（顺序 = 实体里的挂载顺序，不含槽位/锁定语义），别拿它当技能栏数据源。
   */
  const heroSkills = ref<number[]>([])

  // ── 战斗状态 ──
  const phase = ref(1)//阶段
  /**
   * 阶段数**分母**（HUD 进度条那行「阶段 N/M」的 M）。**0 = 无限**（不画分母）。
   *
   * ✅ 2026-11 起它**真的会动**：`Scene_Game_Stage.resetRun` 按 `modeRules.maxPhase` 写入 ——
   * 阶段模式 = `StageTimingConfig.STAGE_COUNT`（4），无尽模式 = 0。
   * （此前它恒为 4，而唯一的写入方是那个全工程没人用的旧 FSM `game_states/states/BattleState`，
   * 所以"选无尽模式进局、HUD 还写着阶段 7/4"就是这样来的。）
   */
  const maxPhase = ref(4)
  const phaseRemainTime = ref(300)//当前阶段剩余时间
  /** 当前阶段的**总时长**（阶段进度条的分母；真源在场景的 GameStageConfig，UI 只读） */
  const phaseTotalTime = ref(0)
  const enemiesAlive = ref(0)//存活敌人数量
  const isPaused = ref(false)//是否暂停
  /**
   * **UI 面板导致的暂停**（选英雄 / 遗物商店 / Buff 商店打开时 = true）。
   *
   * 为什么要与 `isPaused` 分开存：`isPaused` 是"玩家按了暂停键"（以及看广告、复活面板那几处
   * 会临时借用它），**暂停按钮的图标认的是它**。面板一开就往 `isPaused` 里写，
   * 按钮图标会当场翻成"继续"—— 玩家没按过，那是在撒谎。
   *
   * 场景的推进判定读两者之或，见 `isBattleFrozen()`。
   */
  const panelPaused = ref(false)
  /**
   * **局内倍速**（1 / 1.5 / 2；档位与解锁级见 `game/common/BattleSpeedConfig`）。
   *
   * ⚠ **不属于"这一局"**：`reset()` 刻意**不**复位它 —— 玩家选了 2× 就该下一局还是 2×，
   *   每局都要重选一次是纯粹的骚扰。它是"玩家在本局的偏好"，与 `hp` / `level` 那类每局重来的投影不同。
   * ⚠ 解锁判据（账号等级）**不在这里**：那是 HUD 显隐的事，本字段只管值。
   */
  const speedMul = ref(BATTLE_SPEED_DEFAULT)
  const isGameOver = ref(false)//是否结束
  /**
   * **本局的难度档位**（1 ~ `DifficultyConfig.DIFFICULTY_MAX`）。
   *
   * 投影值，真源在 `DataCenter.ins.levelData`（难度选择弹窗「确定」时落盘）；
   * 场景在换局（`resetRun`）时读一次写进来，本局全程不变 ——
   * HUD 的 `info/name` 靠它显示「难度 N」，局内缩放全部走 `DifficultyConfig` 现算（不再读这个字段）。
   */
  const difficulty = ref(1)

  /**
   * **本局的游戏模式**（`GameModeConfig.GameMode`：`stage` 阶段模式 / `no_ending` 无尽模式）。
   *
   * 投影值，真源在 `DataCenter.ins.levelData`（主界面模式卡点一下就落盘）；
   * 场景在换局（`resetRun`）时读一次写进来，本局全程不变 ——
   * HUD 的 `info/mode` 靠它显示模式名（**原来那一格是预制件里的死文案「阶梯模式」，全工程没有写入方**）。
   *
   * ✅ **2026-11 起玩法规则真的按模式分岔了**：判据全在 `common/GameModeRules.ts`（纯函数），
   *   由 `Scene_Game_Stage` 持有一个 `modeRules` 并在七个落点消费（详见该字段的注释）。
   *   本字段仍然只是**投影**：**别拿它当规则的判据**（界面要按模式分岔就读场景投影过来的数，
   *   例如 `maxPhase` —— 0 = 无尽模式，不画分母）。
   */
  const mode = ref<string>(DEFAULT_GAME_MODE)

  // ── 统计 ──
  /** 本局**累计**击杀数（统计口径：结算 / 成就 `run_kill`；**花掉不会减少**） */
  const kills = ref(0)
  const damageDealt = ref(0)
  const damageTaken = ref(0)

  /**
   * **击杀数余额** —— 击杀商店（Buff 商店）的唯一货币（可花费，买一层就扣掉）。
   *
   * 与 `kills` 的关系：`kills` 是**累计**统计（只增不减），本字段是**余额**（花掉会减）。
   * 两者同源（每次击杀都记一笔，见 `onEnemyKilled`）。HUD 的 `money/kill/value` 显示的是**余额**
   * （与金币并排的货币读数），`kills` 只进结算面板与成就。
   *
   * ⚠ 口径：**每杀 1 只 = 1 点，但按怪种加权**（真值 = `units.json.killReward`，缺省
   *   `KILL_POINTS_PER_KILL`）。加权的唯一出口就是**玩家自己放的「击杀怪」**（units#2009，
   *   `rewardType = 'kill_boss'`，现 150 点）—— 它 cd 150s、限时 90s、打不动就白放一只，
   *   是"用一场硬仗换一叠击杀数"的那个槽位（见 `BossScheduler.BOSS_SLOTS`）。
   *   其余怪（含金币怪 / 守卫 / 阶段 Boss）一律 1：击杀数是神器的货币，
   *   让 Boss 也发大额会把这套经济从"取舍"变成"都能买满"。
   *   宿主按死者配置解析出点数后调 `onEnemyKilled(points)`。
   */
  const killPoints = ref(0)

  /** 金币余额（`hero.gold` 的投影）：选英雄刷新 + 遗物抽取的货币（击杀商店花的是 `killPoints`） */
  const gold = ref(0)

  /**
   * **局内遗物背包**：本局已获得遗物 id 列表（投影值，真源在 `RelicSystem.getAll()`）。
   * 场景在 `syncHeroToStore` 里写（获得遗物 / 换英雄 / 重开一局都会同步）。
   * ⚠ 面板要渲染的「本次 4 个候选」不是它 —— 那是**功能页面状态**，走 `UIScope`
   *   （`StageScopeKeys.RelicShop` 的 `RelicShopVM.slots`，由 `Scene_Game_Stage` provide），别混用。
   */
  const relicBag = ref<number[]>([])

  // ⚠ 「刷新候选英雄的费用」**不在这里**：它属于选英雄功能，由 `HeroSelect.refreshCost` 持有
  //   （功能页面状态 → 宿主 provide 角色门面，键见 StageScope.HeroSelect）。
  //   旧的 `refreshGold`（写死 100 的全局常量）已删除 —— 用一个全局 store 字段存界面自己的价格，
  //   会让"这笔钱是谁扣的"查不到；价格与扣费现在都在 HeroSelect 一处。

  // ── 局内英雄等级/经验 ──
  // ⚠ 这三个**不是投影**：真源就在这里（`Scene_Game_Stage.addBattleExp` 直接用它算升级、
  //   遗物面板刷新读 `level` 挑品质档位），所以它们属于「局内运行状态」，不要挪进 UI 树。
  //   理想形态是像 hp 一样在战斗层持有真源、store 只做投影（暂未收口）。
  const level = ref(1)
  const exp = ref(0)
  const expToNext = ref(60)

  // ── Actions ──
  /**
   * 记一次击杀：累计击杀 +1、**按怪种给击杀数**、场上敌人数 −1。
   *
   * @param points 这一只值几点击杀数（宿主 `Scene_Game_Stage.killPointsOf` 按 `units.json.killReward`
   *               解析后递进来）。⚠ **刻意不给默认值**：漏传就等于"所有怪又变回 1 点"，
   *               而那种回归在运行期完全看不出来 —— 设成必填，漏了就是编译错误。
   *               这里对脏值再兜一次底（`KILL_POINTS_PER_KILL`），但**真源在配表那一侧**。
   *               ⚠ 只有**击杀数**按它加权 —— `kills`（累计统计）恒 +1（它统计的是"几只"，不是"几分"）。
   */
  function onEnemyKilled(points: number): void {
    kills.value++
    const gain = Number.isFinite(points) ? Math.floor(points) : 0
    killPoints.value += gain > 0 ? gain : KILL_POINTS_PER_KILL
    enemiesAlive.value = Math.max(0, enemiesAlive.value - 1)
  }

  /** 加击杀数（脚本/遗物钩子额外发放时用；正常击杀走 `onEnemyKilled`） */
  function addKillPoints(amount: number): void {
    const n = Math.floor(amount)
    if (!Number.isFinite(n) || n <= 0) return
    killPoints.value += n
  }

  /**
   * 花掉击杀数（击杀商店的**唯一扣费口**：刷新摊位 + 买 Buff）。
   * @returns false = 余额不足（余额一分不动，调用方负责拒绝本次操作）
   */
  function spendKillPoints(amount: number): boolean {
    const cost = Math.max(0, Math.floor(amount))
    if (killPoints.value < cost) return false
    killPoints.value -= cost
    return true
  }


  function reset(): void {
    hp.value = 100
    maxHp.value = 100
    heroId.value = 0
    heroSkills.value = []
    phase.value = 1
    maxPhase.value = 4
    phaseRemainTime.value = 300
    phaseTotalTime.value = 0
    enemiesAlive.value = 0
    isPaused.value = false
    panelPaused.value = false
    isGameOver.value = false
    kills.value = 0
    killPoints.value = 0
    damageDealt.value = 0
    damageTaken.value = 0
    gold.value = 0
    relicBag.value = []
    level.value = 1
    exp.value = 0
    expToNext.value = 60
    difficulty.value = 1
    mode.value = DEFAULT_GAME_MODE
  }

  function togglePause(): void {
    isPaused.value = !isPaused.value
  }

  /** 切倍速（HUD 的三档按钮调它；值必须是 `BATTLE_SPEED_STEPS` 里的一档，认不出就归 1×） */
  function setSpeed(mul: number): void {
    const v = Number.isFinite(mul) && mul > 0 ? mul : 1
    if (speedMul.value !== v) speedMul.value = v
  }

  /** 写"面板导致的暂停"（唯一写入方是 `Scene_Game_Stage` 对三个面板的 watch） */
  function setPanelPaused(paused: boolean): void {
    const v = !!paused
    if (panelPaused.value !== v) panelPaused.value = v
  }

  /**
   * **本局是否冻结**（战斗推进的唯一判据）—— 玩家暂停 / 看广告 / 复活面板 / 任一功能面板打开
   * 都算冻结。`Scene_Game_Stage.update` 的早退与点选索敌都用它，别再各自读 `isPaused`。
   */
  function isBattleFrozen(): boolean {
    return isPaused.value || panelPaused.value
  }

  return {
    hp, maxHp,
    heroId, heroSkills,
    phase, maxPhase, phaseRemainTime, phaseTotalTime, enemiesAlive, isPaused, isGameOver,
    kills, killPoints, damageDealt, damageTaken,
    onEnemyKilled, addKillPoints, spendKillPoints, reset, togglePause,
    panelPaused, setPanelPaused, isBattleFrozen,
    speedMul, setSpeed,
    gold,
    level, exp, expToNext,
    relicBag,
    difficulty,
    mode
  }
})
