/**
 * useBattleStore — 战斗状态 Store
 *
 * 管理战斗中英雄/敌人的实时状态，供场景节点和 UI 节点共享。
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

  // ── 战斗状态 ──
  const phase = ref(1)//阶段
  const maxPhase = ref(4)//最大阶段 0表示无限
  const phaseRemainTime = ref(300)//当前阶段剩余时间
  const enemiesAlive = ref(0)//存活敌人数量
  const isPaused = ref(false)//是否暂停
  const isGameOver = ref(false)//是否结束

  // ── 统计 ──
  const kills = ref(0)
  const damageDealt = ref(0)
  const damageTaken = ref(0)

  const selectHeroList = ref<number[]>([])
  const showSelectHeroPanel = ref(false)
  const gold = ref(0)
  const refreshGold = ref(100)

  // ── 局内英雄等级/经验（投影值：真源在 Entity/HeroData，由场景 onDeath 写入） ──
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
    phase.value = 1
    maxPhase.value = 4
    phaseRemainTime.value = 300
    enemiesAlive.value = 0
    isPaused.value = false
    isGameOver.value = false
    kills.value = 0
    damageDealt.value = 0
    damageTaken.value = 0
    gold.value = 0
    refreshGold.value = 100
    level.value = 1
    exp.value = 0
    expToNext.value = 60
    showSelectHeroPanel.value = false
    selectHeroList.value = []
  }

  function randomHeroes(){
    //TODO 从已解锁的英雄中随机
    this.selectHeroList = [1,2,3,4]
  }

  function togglePause(): void {
    isPaused.value = !isPaused.value
  }

  return {
    hp, maxHp,
    phase, maxPhase, phaseRemainTime, enemiesAlive, isPaused, isGameOver,
    kills, damageDealt, damageTaken,
    onEnemyKilled, reset, togglePause,
    selectHeroList, randomHeroes, showSelectHeroPanel,
    gold, refreshGold,
    level, exp, expToNext
  }
})
