/**
 * useBattleStore — 战斗状态 Store
 *
 * 管理**局内（这一局）的运行状态与它的响应式投影**，供场景逻辑与 UI 共享。
 *
 * ── 放什么（判据是「这个概念属于谁」，不是「现在谁在读」）──
 *   ① **UI 摆放**（面板开关、面板要渲染的列表、界面私有选中态）→ 不属于这里，归 `UIScope`：
 *      宿主 `provide`，子孙 `inject`（键见 `game/ui/scenes/scene_game_stage/cmps/UiScopeKeys.ts`）。
 *      判据：删掉那个控件，这个值就没有意义了。
 *   ② **局内运行状态**（`level` / `exp` / `expToNext` / `enemiesAlive` / `isPaused`）→ 留在这里：
 *      它们不是「给 UI 看的」，而是场景自己的升级 / 刷怪 / 抽卡 / 暂停逻辑的运算对象
 *      （`Scene_Game_Stage.addBattleExp` 直接拿 `level/exp/expToNext` 算升级，遗物面板刷新读 `level` 挑品质档位）。
 *   ③ **战斗真源的响应式投影**（`hp` / `maxHp` / `gold` / `kills` / `phase` / `phaseRemainTime` /
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
   * 英雄当前拥有的技能 id 列表（units.json 的 `abilities` + 肉鸽额外学会的；含被动，不含普攻）。
   * 投影值，真源在 `Entity.abilities.getAll()`；HUD 技能栏按它渲染。
   */
  const heroSkills = ref<number[]>([])

  // ── 战斗状态 ──
  const phase = ref(1)//阶段
  const maxPhase = ref(4)//最大阶段 0表示无限
  const phaseRemainTime = ref(300)//当前阶段剩余时间
  /** 当前阶段的**总时长**（阶段进度条的分母；真源在场景的 GameStageConfig，UI 只读） */
  const phaseTotalTime = ref(0)
  const enemiesAlive = ref(0)//存活敌人数量
  const isPaused = ref(false)//是否暂停
  const isGameOver = ref(false)//是否结束

  // ── 统计 ──
  const kills = ref(0)
  const damageDealt = ref(0)
  const damageTaken = ref(0)

  const gold = ref(0)

  /**
   * **局内遗物背包**：本局已获得遗物 id 列表（投影值，真源在 `RelicSystem.getAll()`）。
   * 场景在 `syncHeroToStore` 里写（获得遗物 / 换英雄 / 重开一局都会同步）。
   * ⚠ 面板要渲染的「本次 4 个候选」不是它 —— 那是**页面级状态**，走 `UIScope`
   *   （`StageScopeKeys.RelicSlots`，由 `Scene_Game_Stage` provide），别混用。
   */
  const relicBag = ref<number[]>([])

  // ⚠ 「刷新候选英雄的费用」**不在这里**：它属于选英雄功能，由 `HeroSelect.refreshCost` 持有
  //   （页面级状态 → 宿主 provide，键见 UiScopeKeys.HeroSelectRefreshCost）。
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
  function onEnemyKilled(): void {
    kills.value++
    enemiesAlive.value = Math.max(0, enemiesAlive.value - 1)
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
    isGameOver.value = false
    kills.value = 0
    damageDealt.value = 0
    damageTaken.value = 0
    gold.value = 0
    relicBag.value = []
    level.value = 1
    exp.value = 0
    expToNext.value = 60
  }

  function togglePause(): void {
    isPaused.value = !isPaused.value
  }

  return {
    hp, maxHp,
    heroId, heroSkills,
    phase, maxPhase, phaseRemainTime, phaseTotalTime, enemiesAlive, isPaused, isGameOver,
    kills, damageDealt, damageTaken,
    onEnemyKilled, reset, togglePause,
    gold,
    level, exp, expToNext,
    relicBag
  }
})
