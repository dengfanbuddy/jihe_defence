/**
 * Store.ts — Pinia 风格的状态管理
 *
 * 基于已有的 @vue/reactivity 系统，提供与 Pinia 类似的状态管理 API。
 * 场景节点脚本和 UI 节点脚本可以通过 Store 共享响应式数据，无需通过事件或参数传递。
 *
 * ── 快速开始 ──
 *
 * 【Composition API · 推荐】
 * ```ts
 * // stores/useBattleStore.ts
 * import { defineStore } from '../../platform/store'
 *
 * export const useBattleStore = defineStore('battle', () => {
 *   const hp = ref(100);
 *   const maxHp = ref(100);
 *   const isAlive = computed(() => hp.value > 0);
 *
 *   function takeDamage(amount: number) {
 *     hp.value = Math.max(0, hp.value - amount);
 *   }
 *   function heal(amount: number) {
 *     hp.value = Math.min(maxHp.value, hp.value + amount);
 *   }
 *
 *   return { hp, maxHp, isAlive, takeDamage, heal };
 * });
 *
 * // 任意组件中
 * const battle = useBattleStore();
 * battle.hp;          // → 100 (ref 自动解包)
 * battle.takeDamage(30);
 * ```
 *
 * 【Options API】
 * ```ts
 * const useCounter = defineStore('counter', {
 *   state: () => ({ count: 0, step: 1 }),
 *   getters: {
 *     double: (state) => state.count * 2,
 *   },
 *   actions: {
 *     increment() { this.count += this.step; },
 *   },
 * });
 * ```
 *
 * 【响应式监听】
 * ```ts
 * import { watch } from '../../platform/reactivity';
 *
 * watch(() => battleStore.hp, (newHp, oldHp) => {
 *   console.log(`HP 变化: ${oldHp} → ${newHp}`);
 * });
 * ```
 */

import {
  reactive,
  ref,
  computed,
  watch,
  toRaw,
  isRef,
  proxyRefs,
  type Ref,
  type WatchStopHandle,
  type ShallowUnwrapRef,
} from '../reactivity'

// ============================================================
// 类型定义
// ============================================================

/** Store 选项 */
export interface StoreOptions {
  /** 是否持久化到 localStorage */
  persist?: boolean | StorePersistOptions
}

export interface StorePersistOptions {
  /** localStorage 键名（默认: 'store_' + storeId） */
  key?: string
}

/** 订阅回调 */
export type SubscribeCallback<S> = (mutation: MutationPayload, state: S) => void

export interface MutationPayload {
  storeId: string
  type: 'patch' | 'action' | 'reset' | 'set'
  payload?: any
}

/** Action 订阅回调 */
export type OnActionCallback = (call: ActionCall) => void

export interface ActionCall {
  name: string
  args: any[]
  after: (cb: () => void) => void
  onError: (cb: (error: unknown) => void) => void
}

/** Options API 选项 */
export interface OptionsStoreOptions<
  S extends Record<string, any> = Record<string, any>,
  G extends Record<string, Function> = {},
  A extends Record<string, Function> = {},
> {
  state?: () => S
  getters?: G & ThisType<S & { [K in keyof G]: G[K] extends (state: any) => infer R ? R : never }>
  actions?: A & ThisType<S & GettersToComputed<G> & A>
  persist?: boolean | StorePersistOptions
}

type GettersToComputed<G> = {
  [K in keyof G]: G[K] extends (state: any) => infer R ? R : never
}

type OptionsStoreReturn<
  S extends Record<string, any>,
  G extends Record<string, Function>,
  A extends Record<string, Function>,
> = S & GettersToComputed<G> & A

// ============================================================
// 内部 Store 注册表
// ============================================================

const storeRegistry = new Map<string, StoreInstance<any>>()

// ============================================================
// StoreInstance — 每个 Store 的运行时实例
// ============================================================

class StoreInstance<S extends Record<string, any>> {
  $id: string
  $state: S
  readonly $proxy: S

  private _persistOptions: StorePersistOptions | null = null
  private _stopPersist: WatchStopHandle | null = null
  private _subscribers: SubscribeCallback<S>[] = []
  private _actionSubscribers: OnActionCallback[] = []

  constructor(id: string, rawState: S, persistOptions: StorePersistOptions | null) {
    this.$id = id
    this.$state = reactive(rawState) as S
    this.$proxy = proxyRefs(this.$state) as S

    if (persistOptions) {
      this._persistOptions = persistOptions
      this._loadPersisted()
      this._startPersist()
    }
  }

  /** 批量更新 */
  $patch(partialOrMutator: Partial<S> | ((state: S) => void)): void {
    if (typeof partialOrMutator === 'function') {
      partialOrMutator(this.$state)
    } else {
      Object.assign(this.$state, partialOrMutator)
    }
    this._notify('patch')
  }

  /** 重置 state 到初始值 */
  $reset(initialState: () => S): void {
    const fresh = initialState()
    for (const key of Object.keys(fresh)) {
      ;(this.$state as any)[key] = (fresh as any)[key]
    }
    this._notify('reset')
  }

  /** 订阅 state 变化，返回取消订阅函数 */
  $subscribe(callback: SubscribeCallback<S>): () => void {
    this._subscribers.push(callback)
    return () => {
      const idx = this._subscribers.indexOf(callback)
      if (idx >= 0) this._subscribers.splice(idx, 1)
    }
  }

  /** 监听 action 调用，返回取消订阅函数 */
  $onAction(callback: OnActionCallback): () => void {
    this._actionSubscribers.push(callback)
    return () => {
      const idx = this._actionSubscribers.indexOf(callback)
      if (idx >= 0) this._actionSubscribers.splice(idx, 1)
    }
  }

  /** 内部: 通知 action 调用 */
  _notifyAction(name: string, args: any[]): { after: () => void; onError: (error: unknown) => void } {
    const afters: (() => void)[] = []
    const onErrors: ((error: unknown) => void)[] = []

    const call: ActionCall = {
      name, args,
      after: (cb) => afters.push(cb),
      onError: (cb) => onErrors.push(cb),
    }

    for (const sub of this._actionSubscribers) {
      try { sub(call) } catch { /* 不中断主流程 */ }
    }

    return {
      after: () => { for (const cb of afters) cb() },
      onError: (error) => { for (const cb of onErrors) cb(error) },
    }
  }

  /* internal */ _notify(type: MutationPayload['type']): void {
    const mutation: MutationPayload = { storeId: this.$id, type }
    const state = this.$proxy as S
    for (const sub of this._subscribers) {
      try { sub(mutation, state) } catch { /* 不中断 */ }
    }
  }

  private _storageKey(): string {
    return this._persistOptions?.key ?? `store_${this.$id}`
  }

  private _loadPersisted(): void {
    try {
      const raw = localStorage.getItem(this._storageKey())
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved === 'object' && saved !== null) {
          Object.assign(this.$state, saved)
        }
      }
    } catch { /* 静默忽略 */ }
  }

  private _startPersist(): void {
    this._stopPersist = watch(
      () => toRaw(this.$state),
      (val) => {
        try {
          localStorage.setItem(this._storageKey(), JSON.stringify(val))
        } catch { /* 存储满等异常静默忽略 */ }
      },
      { deep: true },
    )
  }

  _stopPersisting(): void {
    this._stopPersist?.()
    this._stopPersist = null
  }

  dispose(): void {
    this._stopPersisting()
    this._subscribers = []
    this._actionSubscribers = []
  }
}

// ============================================================
// defineStore — 函数重载
// ============================================================

/**
 * defineStore — 定义 Store（Composition API）
 *
 * @param id    Store 唯一标识
 * @param setup  setup 函数，返回包含 ref / computed / 函数的对象
 * @param options 可选配置（persist 等）
 *
 * @example
 * ```ts
 * const useStore = defineStore('battle', () => {
 *   const hp = ref(100);
 *   return { hp, attack() { /* ... *​/ } };
 * });
 * const store = useStore();
 * store.hp; // → 100
 * ```
 */
export function defineStore<Id extends string, Setup extends () => Record<string, any>>(
  id: Id,
  setup: Setup,
  options?: StoreOptions,
): () => Setup extends (...args: any[]) => infer R ? ShallowUnwrapRef<R> : never

/**
 * defineStore — 定义 Store（Options API）
 *
 * @param id      Store 唯一标识
 * @param options  { state, getters, actions, persist? }
 *
 * @example
 * ```ts
 * const useCounter = defineStore('counter', {
 *   state: () => ({ count: 0 }),
 *   getters: { double: (s) => s.count * 2 },
 *   actions: { increment() { this.count++ } },
 * });
 * ```
 */
export function defineStore<
  Id extends string,
  S extends Record<string, any>,
  G extends Record<string, Function>,
  A extends Record<string, Function>,
>(
  id: Id,
  options: OptionsStoreOptions<S, G, A>,
): () => OptionsStoreReturn<S, G, A>

// ---- 实现 ----
export function defineStore(
  id: string,
  setupOrOptions: (() => Record<string, any>) | OptionsStoreOptions,
  options?: StoreOptions,
): any {
  if (typeof setupOrOptions === 'function') {
    return _createCompositionStore(id, setupOrOptions, options)
  } else {
    return _createOptionsStore(id, setupOrOptions)
  }
}

// ============================================================
// 内部实现
// ============================================================

function _createCompositionStore(
  id: string,
  setup: () => Record<string, any>,
  options?: StoreOptions,
): () => any {
  const persistOptions: StorePersistOptions | null =
    options?.persist === true ? {} :
    options?.persist && typeof options.persist === 'object' ? options.persist :
    null

  const useStore = (): any => {
    const existing = storeRegistry.get(id)
    if (existing) return existing.$proxy

    const setupResult = setup()

    // 提取 state
    const rawState: Record<string, any> = {}
    for (const key of Object.keys(setupResult)) {
      if (typeof setupResult[key] !== 'function') {
        rawState[key] = setupResult[key]
      }
    }

    const instance = new StoreInstance(id, rawState, persistOptions)

    // 组装最终对象
    const composed: Record<string, any> = {}

    // state 属性
    for (const key of Object.keys(rawState)) {
      composed[key] = rawState[key]
    }

    // actions（函数包装 action 订阅）
    for (const key of Object.keys(setupResult)) {
      const val = setupResult[key]
      if (typeof val === 'function') {
        composed[key] = (...args: any[]) => {
          const callbacks = instance._notifyAction(key, args)
          try {
            const result = val.apply(composedProxy, args)
            callbacks.after()
            return result
          } catch (error) {
            callbacks.onError(error)
            throw error
          }
        }
      }
    }

    // 工具方法
    _attachUtils(composed, instance)

    const composedProxy = proxyRefs(composed)
    ;(instance as any).$proxy = composedProxy
    storeRegistry.set(id, instance)
    return composedProxy
  }

  ;(useStore as any).$id = id
  return useStore
}

function _createOptionsStore(
  id: string,
  options: OptionsStoreOptions,
): () => any {
  const persistOptions: StorePersistOptions | null =
    options.persist === true ? {} :
    options.persist && typeof options.persist === 'object' ? options.persist :
    null

  const stateFn = options.state ?? (() => ({}))
  const getterFns = options.getters ?? {}
  const actionFns = options.actions ?? {}

  const useStore = (): any => {
    const existing = storeRegistry.get(id)
    if (existing) return existing.$proxy

    // 1. state → reactive
    const rawState = stateFn()
    const instance = new StoreInstance(id, rawState, persistOptions)

    // 2. getters → computed
    const computedMap: Record<string, any> = {}
    for (const key of Object.keys(getterFns)) {
      const getter = getterFns[key]
      computedMap[key] = computed(() => getter(instance.$state))
    }

    // 3. 组装 proxy
    const composed: Record<string, any> = {}

    // state
    for (const key of Object.keys(rawState)) {
      composed[key] = rawState[key]
    }
    // getters
    for (const key of Object.keys(computedMap)) {
      composed[key] = computedMap[key]
    }
    // actions — this 指向 composedProxy
    for (const key of Object.keys(actionFns)) {
      const fn = actionFns[key]
      composed[key] = (...args: any[]) => {
        const callbacks = instance._notifyAction(key, args)
        try {
          const result = fn.apply(composedProxy, args)
          callbacks.after()
          return result
        } catch (error) {
          callbacks.onError(error)
          throw error
        }
      }
    }

    // 工具方法
    _attachUtils(composed, instance)

    // $reset 需要 state 工厂
    if (options.state) {
      composed.$reset = () => {
        const fresh = stateFn()
        for (const key of Object.keys(fresh)) {
          ;(composedProxy as any)[key] = fresh[key]
        }
        instance._notify('reset')
      }
    }

    const composedProxy = proxyRefs(composed)
    ;(instance as any).$proxy = composedProxy
    storeRegistry.set(id, instance)
    return composedProxy
  }

  ;(useStore as any).$id = id
  return useStore
}

function _attachUtils(composed: Record<string, any>, instance: StoreInstance<any>): void {
  composed.$id = instance.$id
  composed.$state = instance.$state
  composed.$patch = instance.$patch.bind(instance)
  composed.$subscribe = instance.$subscribe.bind(instance)
  composed.$onAction = instance.$onAction.bind(instance)
}

// ============================================================
// 工具函数（导出）
// ============================================================

/**
 * storeToRefs — 从 Store 中解构出 ref 值（保持响应式连接）
 *
 * @example
 * ```ts
 * const { hp, maxHp } = storeToRefs(useBattleStore())
 * watch(hp, (v) => console.log('hp 变化:', v))
 * ```
 */
export function storeToRefs<S extends Record<string, any>>(
  store: S,
): { [K in keyof S]: S[K] extends Function ? never : Ref<UnwrapRefOrRaw<S[K]>> } {
  const refs: Record<string, any> = {}
  for (const key of Object.keys(store)) {
    const val = store[key]
    if (typeof val === 'function' || key.startsWith('$')) continue
    refs[key] = isRef(val) ? val : ref(val)
  }
  return refs as any
}

type UnwrapRefOrRaw<T> = T extends Ref<infer V> ? V : T

/**
 * disposeStore — 手动销毁 Store 实例
 */
export function disposeStore(id: string): void {
  const instance = storeRegistry.get(id)
  if (instance) {
    instance.dispose()
    storeRegistry.delete(id)
  }
}

/**
 * 清除所有 Store（用于热更新或测试）
 */
export function disposeAllStores(): void {
  for (const [id, instance] of storeRegistry) {
    instance.dispose()
  }
  storeRegistry.clear()
}

/**
 * 检查 Store 是否已注册
 */
export function hasStore(id: string): boolean {
  return storeRegistry.has(id)
}
