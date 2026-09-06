/**
 * useUIStore — UI 状态 Store
 *
 * 管理全局 UI 状态：弹窗层级、提示信息、加载状态等。
 * 场景节点可以修改这些状态，UI 节点自动响应。
 *
 * 不需要持久化（UI 状态关闭即重置）。
 *
 * @example
 * ```ts
 * const ui = useUIStore()
 * ui.showToast('装备已强化！')
 * ui.isLoading = true
 * ```
 */

import { defineStore } from '../../platform/store'
import { ref, reactive } from '../../platform/reactivity'

export type ToastType = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  message: string
  type: ToastType
  duration: number
  createdAt: number
}

export interface ModalInfo {
  /** 模态框唯一标识 */
  key: string
  /** 传入的数据 */
  data?: any
}

export const useUIStore = defineStore('ui', () => {
  // ── Toast 队列 ──
  const toasts = ref<Toast[]>([])

  // ── 全局加载 ──
  const isLoading = ref(false)
  const loadingMessage = ref('')

  // ── 模态框栈 ──
  const activeModals = ref<ModalInfo[]>([])

  // ── 通用提示 ──
  const notification = reactive<{
    visible: boolean
    title: string
    message: string
    confirmText: string
    cancelText: string
    onConfirm: (() => void) | null
    onCancel: (() => void) | null
  }>({
    visible: false,
    title: '',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    onConfirm: null,
    onCancel: null,
  })

  // ── 当前场景标识 ──
  const currentScene = ref<string>('')

  // ── Actions ──

  let _toastId = 0

  function showToast(message: string, type: ToastType = 'info', duration = 2000): void {
    const id = ++_toastId
    toasts.value = [...toasts.value, { id, message, type, duration, createdAt: Date.now() }]
    // 自动移除
    setTimeout(() => removeToast(id), duration)
  }

  function removeToast(id: number): void {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  function showLoading(msg = '加载中...'): void {
    isLoading.value = true
    loadingMessage.value = msg
  }

  function hideLoading(): void {
    isLoading.value = false
    loadingMessage.value = ''
  }

  function showModal(key: string, data?: any): void {
    activeModals.value = [...activeModals.value, { key, data }]
  }

  function closeModal(key: string): void {
    activeModals.value = activeModals.value.filter(m => m.key !== key)
  }

  function showConfirm(title: string, message: string, onConfirm?: () => void): void {
    notification.visible = true
    notification.title = title
    notification.message = message
    notification.onConfirm = onConfirm ?? null
    notification.onCancel = null
  }

  function hideNotification(): void {
    notification.visible = false
  }

  function setCurrentScene(scene: string): void {
    currentScene.value = scene
  }

  return {
    toasts, isLoading, loadingMessage, activeModals,
    notification, currentScene,
    showToast, removeToast,
    showLoading, hideLoading,
    showModal, closeModal,
    showConfirm, hideNotification,
    setCurrentScene,
  }
})
