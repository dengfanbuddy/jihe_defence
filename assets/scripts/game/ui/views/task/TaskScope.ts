/**
 * TaskScope.ts — 任务界面的 scope 契约（键 + 事件）
 *
 * 与 `scene_game_stage/cmps/StageScope.ts` 同一套路：界面内部的通信只走 scope，
 * 不在组件之间互相 `getComponent`。
 *
 * 方向约定：
 *   · 状态向下：宿主 `View_TaskUI` 把「这个格子要显示的任务 + 状态」直接下发给 `TaskItem`（`setTask`），
 *     不 provide 裸 ref —— 格子的输入就是一次性的渲染参数，不是共享状态。
 *   · 通知向上：格子只 `scope.emit(TaskScopeEvents.Claim, id)`；**真正领奖的是宿主**
 *     （宿主 → `DataCenter.ins.taskData.claim`），格子不知道数据层、更不知道奖励怎么发。
 */

export const TaskScopeEvents = {
    /** 点了「领取」（参数：任务 id） */
    Claim: 'task:claim',
} as const;

/** 页签切换（宿主自己处理，定义在这里方便以后下发给别的组件） */
export const TaskTabs = ['daily', 'weekly'] as const;
