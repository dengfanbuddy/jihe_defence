/**
 * OuterDrawScope.ts — 「遗物」页（`Scene_Menu` → 左侧「遗物」→ `content/right/outer_relics`）
 * **与抽取结果弹窗**（`Scene_Menu/ui_draw_result`）共用的内部契约
 *
 * 与 `HeroScope.ts`、`DifficultyScope.ts`、`AchievementScope.ts` 同一套路：页面内部的通信只走 scope，
 * 组件之间不互相 `getComponent`。
 *
 * ── 为什么结果弹窗的宿主是 `Scene_Menu`（与英雄详情弹窗逐字同口径）──
 * `UIScope.emit` **只沿 `node.parent` 向上冒泡**，而 `ui_draw_result` 是 `Scene_Menu`
 * **根节点的子节点**（与 `content` 平级 —— 弹窗要盖住整屏、遮罩要盖住顶栏与左右页签，
 * 所以它不能塞进 `content/right/outer_relics` 里）。于是：
 *
 * ```
 * Cmp_OuterRelics（content/right/outer_relics）  ──emit ShowResult──▶  Scene_Menu（根）
 * Cmp_OuterDrawResult（ui_draw_result）          ──emit CloseResult─▶  Scene_Menu（根）
 * ```
 *
 * 分工（同 `HeroScope` 的文件头）：
 *   · **数据向下**：`Cmp_OuterRelics` 把 `DataCenter.drawOuterRelic()` 返回的 `lines` 整包下发，
 *     弹窗**不认识 `DataCenter`、不认识配表、不算任何判据**，只负责把这几张卡画出来；
 *   · **通知向上**：弹窗点了「确 定 / ×」只 `emit(CloseResult)`，**显隐由宿主写**
 *     （弹窗自己不动自己的 `active` —— 出问题时定位会变难，`Cmp_HeroDetail` / `Cmp_Difficulty` 同口径）。
 */

/** `Cmp_OuterRelics` / `Cmp_OuterDrawResult` 抛给宿主的事件（`scope.emit`，沿父链冒泡） */
export const OuterDrawScopeEvents = {
    /** 抽完一次（参数：`IOuterDrawLine[]`，即这次真抽到的每一件）—— 宿主弹「获得遗物」面板 */
    ShowResult: 'outerDraw:result:show',
    /** 结果面板点了「确 定 / ×」（无参数）—— 宿主收起面板（**不写任何数据**） */
    CloseResult: 'outerDraw:result:close',
} as const;
