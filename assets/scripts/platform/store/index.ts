/**
 * store — Pinia 风格的状态管理
 *
 * 基于 @vue/reactivity 的共享响应式数据管理方案。
 * 场景节点和 UI 节点通过 Store 共享数据，无需参数传递或事件广播。
 *
 * @example
 * ```ts
 * // 定义 Store（推荐 Composition API）
 * import { defineStore } from '../../platform/store'
 * import { ref, computed } from '../../platform/reactivity'
 *
 * export const useBattleStore = defineStore('battle', () => {
 *   const hp = ref(100);
 *   const maxHp = ref(100);
 *   const hpPercent = computed(() => hp.value / maxHp.value);
 *   return { hp, maxHp, hpPercent };
 * });
 *
 * // 使用
 * const battle = useBattleStore();
 * console.log(battle.hp); // 响应式
 * ```
 */

export {
  defineStore,
  storeToRefs,
  disposeStore,
  disposeAllStores,
  hasStore,
} from './Store'

export type {
  StoreOptions,
  StorePersistOptions,
  SubscribeCallback,
  MutationPayload,
  OnActionCallback,
  ActionCall,
  OptionsStoreOptions,
} from './Store'
