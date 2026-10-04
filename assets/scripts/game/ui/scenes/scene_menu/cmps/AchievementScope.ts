/**
 * AchievementScope.ts — 成就页面的 scope 契约（事件键）
 *
 * 与 `views/task/TaskScope.ts`、`scene_game_stage/cmps/StageScope.ts` 同一套路：
 * 页面内部的通信只走 scope，组件之间不互相 `getComponent`。
 *
 * 方向约定：
 *   · 状态向下：宿主 `Cmp_Achievement` 把「这条成就当前长什么样」整包下发给卡片（`setInfo`），
 *     卡片不认识数据层、也不自己重算判据（判据唯一真源 = `AchievementData.getGroupState`）；
 *   · 通知向上：卡片只 `scope.emit(AchScopeEvents.Claim, group)`；**真正领奖的是宿主**
 *     （宿主 → `DataCenter.ins.achieveData.claim`），然后按结果重刷。
 */
export const AchScopeEvents = {
    /** 点了「领取」（参数：成就 group） */
    Claim: 'achieve:claim',
} as const;
