/**
 * 进度抽屉里**纯**的那一半：清单计数、chip 文案、三种状态的标记。
 *
 * ## 为什么单独一个模块
 *
 * 与 `mention.ts` 同一个理由（也是同一个位置）：面板跑在编辑器的渲染进程里、
 * **零依赖、只有 DOM**，所以「值得跑已知答案的纯函数」只能待在这种独立模块里 ——
 * `scripts/verify-panel.js` 能 `require` 编译产物 `dist/panels/default/progress.js`，
 * 却拿不到 `index.ts` 里的内部函数（那不是模块，是一整个面板入口）。
 *
 * ## 这里放的三件事，坏掉都**不会报错**
 *
 * | 函数 | 坏了会怎样 |
 * |---|---|
 * | `todoCounts` | 状态行那颗 chip 与抽屉里的「完成 N / 共 M」对不上（两个数各自都「看起来还行」） |
 * | `progressChipText` | 状态行**平静地撒谎** —— 最难看的一种是把上一轮的清单写成「现在正在做的事 3/8」 |
 * | `TODO_MARK` | 清单里三种状态长得一样（全部 `○`），一眼看不出哪条在做 |
 *
 * 所以它们值得一张已知答案表，而画 DOM 的那些函数不值得（类名/结构由 `verify-panel`
 * 的必需类名清单与预览器目测兜着）。
 *
 * ⚠ 这里**不许 import 任何东西**（面板是零依赖的），也不许碰 `document`。
 *
 * @module dsh_chat/panel/progress
 */

import type { GoalView, ProgressView, TodoStatus, TodoView } from '../../constants';

/** 三种状态的标记：面板里没有图标资源，而这三个符号在任何字体里都有。 */
export const TODO_MARK: Record<TodoStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' };

/** 目标阶段的说法（英文枚举 → 面板上的中文；`?? fallback` 由调用方兜）。 */
export const GOAL_PHASE_TEXT: Record<GoalView['phase'], string> = {
    active: '进行中',
    paused: '已暂停',
    blocked: '卡住了',
    complete: '已完成',
};

/**
 * 数一遍清单（纯计数，没有口径问题 —— 所以面板可以自己算，不必问宿主）。
 *
 * @param todos - 清单。
 * @returns `done` / `active` / `total`；`total` 是**条目总数**（不是 done + active）。
 */
export function todoCounts(todos: TodoView[]): { done: number; active: number; total: number } {
    let done = 0;
    let active = 0;
    for (const todo of todos) {
        if (todo.status === 'completed') done += 1;
        else if (todo.status === 'in_progress') active += 1;
    }
    return { done, active, total: todos.length };
}

/**
 * 状态行那颗「待办 x/y」写什么。`null` = 整颗藏起来。
 *
 * 四种「没有/没有意义」各有各的写法，因为它们是不同的事：
 *
 * | 情况 | 输出 | 为什么不能合并 |
 * |---|---|---|
 * | 一次都没读过（`progress === null`） | `null`（藏起来） | 显示 `0/0` 会假装「agent 一条都没做完」 |
 * | 缓存说这一轮没写清单 | `待办 —` | 破折号是「不知道」，与「零」是两件事 |
 * | agent 明确写了一份空表 | `待办 空` | 这是**它自己说的**，不是读不到 |
 * | 有清单 | `待办 3/8`（可能带「（上一轮）」） | —— |
 *
 * ⚠ `（上一轮）` 那四个字是这颗 chip 存在的主要理由：清单所属轮次比当前轮次旧时，
 * DSH 的投影**已经把它归零了**（`todo/write` 的投影在每次 `turn/start` 归零），
 * 也就是「本轮 agent 还没写清单」。不加这个标记，用户会把上一轮的表当成现在正在做的事。
 *
 * @param progress - 宿主合并好的进度；没有读数时 null。
 * @returns chip 文案；返回 null 表示这颗 chip 该藏起来。
 */
export function progressChipText(progress: ProgressView | null): string | null {
    if (!progress) return null;
    const todos = progress.todos;
    if (todos === null) {
        // 会话里已经有过动静（轮次/目录）才值得占状态行的位置说一句「没有清单」，
        // 全新会话（还没开跑）就整颗藏起来 —— 那时候没有清单是理所当然的
        return progress.currentTurn > 0 || progress.turns.length > 0 ? '待办 —' : null;
    }
    if (todos.length === 0) return '待办 空';
    const { done, total } = todoCounts(todos);
    return progress.stale ? `待办 ${done}/${total}（上一轮）` : `待办 ${done}/${total}`;
}

/**
 * 回合目录里那一条的头部提示。
 *
 * 分两句的理由：**能不能点**必须一眼看得出来。跳不了的做成 `<div>`（形状上就点不动），
 * 但用户还是要知道「为什么点不动」—— 全文写在抽屉底部，这里只给最短的一句。
 *
 * @param jumpable - 那一轮的正文还在不在面板的转写窗口里（`TurnView.entrySeq !== null`）。
 * @returns 头部那句提示。
 */
export function turnHeadHint(jumpable: boolean): string {
    return jumpable ? '· 点一下跳到那一轮' : '· 只有摘要';
}
