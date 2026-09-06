/**
 * 游戏业务 Store 定义
 *
 * 场景节点和 UI 节点通过 DefineStore 共享响应式数据。
 * 在任意组件中 import useBattleStore 后调用即可拿到同一个 store 实例。
 */

export { useBattleStore } from './useBattleStore'
export { useUIStore } from './useUIStore'
