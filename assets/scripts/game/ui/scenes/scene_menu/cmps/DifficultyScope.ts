/**
 * DifficultyScope.ts — 难度选择弹窗的 scope 契约（事件键）
 *
 * 与 `AchievementScope.ts`、`TaskScope.ts`、`StageScope.ts` 同一套路：
 * 界面内部的通信只走 scope，组件之间不互相 `getComponent`。
 *
 * 方向约定：
 *   · 状态向下：宿主（`Scene_Menu`）持有弹窗节点、负责显隐，并**下发**每格的状态；
 *     弹窗自己读数据层（`LevelData`）算状态、画格子；
 *   · 通知向上：格子 → 弹窗（`Pick`）、弹窗 → 宿主（`Confirm` / `Close`），
 *     一律 `scope.emit(...)`（会沿 `node.parent` 向上冒泡，不需要任何引用）。
 *     弹窗**不自己改存档、也不自己跳场景** —— 落盘选择与进游戏都由宿主 `Scene_Menu` 做
 *     （那是"谁负责流程"的问题，不是弹窗的事）。
 */
export const DifficultyScopeEvents = {
    /** 点了一个可玩的格子（参数：档位）—— 由 `Cmp_DifficultyCell` 冒泡给 `Cmp_Difficulty`，只改"待确认的档位" */
    Pick: 'difficulty:pick',
    /** 点了「确定」（参数：选中的难度档位）—— 落盘 + 进游戏由宿主做 */
    Confirm: 'difficulty:confirm',
    /** 点了右上角关闭（参数：无）—— 只是收起弹窗，不改任何数据 */
    Close: 'difficulty:close',
} as const;
