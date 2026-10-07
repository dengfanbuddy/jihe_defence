"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOAL_PHASE_TEXT = exports.TODO_MARK = void 0;
exports.todoCounts = todoCounts;
exports.progressChipText = progressChipText;
exports.turnHeadHint = turnHeadHint;
/** 三种状态的标记：面板里没有图标资源，而这三个符号在任何字体里都有。 */
exports.TODO_MARK = { pending: '○', in_progress: '◐', completed: '✓' };
/** 目标阶段的说法（英文枚举 → 面板上的中文；`?? fallback` 由调用方兜）。 */
exports.GOAL_PHASE_TEXT = {
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
function todoCounts(todos) {
    let done = 0;
    let active = 0;
    for (const todo of todos) {
        if (todo.status === 'completed')
            done += 1;
        else if (todo.status === 'in_progress')
            active += 1;
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
function progressChipText(progress) {
    if (!progress)
        return null;
    const todos = progress.todos;
    if (todos === null) {
        // 会话里已经有过动静（轮次/目录）才值得占状态行的位置说一句「没有清单」，
        // 全新会话（还没开跑）就整颗藏起来 —— 那时候没有清单是理所当然的
        return progress.currentTurn > 0 || progress.turns.length > 0 ? '待办 —' : null;
    }
    if (todos.length === 0)
        return '待办 空';
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
function turnHeadHint(jumpable) {
    return jumpable ? '· 点一下跳到那一轮' : '· 只有摘要';
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvZ3Jlc3MuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvcHJvZ3Jlc3MudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F3Qkc7OztBQXFCSCxnQ0FRQztBQXFCRCw0Q0FXQztBQVdELG9DQUVDO0FBdEVELHdDQUF3QztBQUMzQixRQUFBLFNBQVMsR0FBK0IsRUFBRSxPQUFPLEVBQUUsR0FBRyxFQUFFLFdBQVcsRUFBRSxHQUFHLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBRXhHLGtEQUFrRDtBQUNyQyxRQUFBLGVBQWUsR0FBc0M7SUFDOUQsTUFBTSxFQUFFLEtBQUs7SUFDYixNQUFNLEVBQUUsS0FBSztJQUNiLE9BQU8sRUFBRSxLQUFLO0lBQ2QsUUFBUSxFQUFFLEtBQUs7Q0FDbEIsQ0FBQztBQUVGOzs7OztHQUtHO0FBQ0gsU0FBZ0IsVUFBVSxDQUFDLEtBQWlCO0lBQ3hDLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQztJQUNiLElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNmLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7UUFDdkIsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFdBQVc7WUFBRSxJQUFJLElBQUksQ0FBQyxDQUFDO2FBQ3RDLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxhQUFhO1lBQUUsTUFBTSxJQUFJLENBQUMsQ0FBQztJQUN4RCxDQUFDO0lBQ0QsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztBQUNqRCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQWtCRztBQUNILFNBQWdCLGdCQUFnQixDQUFDLFFBQTZCO0lBQzFELElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0IsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQztJQUM3QixJQUFJLEtBQUssS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNqQix1Q0FBdUM7UUFDdkMsb0NBQW9DO1FBQ3BDLE9BQU8sUUFBUSxDQUFDLFdBQVcsR0FBRyxDQUFDLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNqRixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUM7UUFBRSxPQUFPLE1BQU0sQ0FBQztJQUN0QyxNQUFNLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMxQyxPQUFPLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxJQUFJLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztBQUMvRSxDQUFDO0FBRUQ7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFnQixZQUFZLENBQUMsUUFBaUI7SUFDMUMsT0FBTyxRQUFRLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQzlDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOi/m+W6puaKveWxiemHjCoq57qvKirnmoTpgqPkuIDljYrvvJrmuIXljZXorqHmlbDjgIFjaGlwIOaWh+ahiOOAgeS4ieenjeeKtuaAgeeahOagh+iusOOAglxuICpcbiAqICMjIOS4uuS7gOS5iOWNleeLrOS4gOS4quaooeWdl1xuICpcbiAqIOS4jiBgbWVudGlvbi50c2Ag5ZCM5LiA5Liq55CG55Sx77yI5Lmf5piv5ZCM5LiA5Liq5L2N572u77yJ77ya6Z2i5p2/6LeR5Zyo57yW6L6R5Zmo55qE5riy5p+T6L+b56iL6YeM44CBXG4gKiAqKumbtuS+nei1luOAgeWPquaciSBET00qKu+8jOaJgOS7peOAjOWAvOW+l+i3keW3suefpeetlOahiOeahOe6r+WHveaVsOOAjeWPquiDveW+heWcqOi/meenjeeLrOeri+aooeWdl+mHjCDigJTigJRcbiAqIGBzY3JpcHRzL3ZlcmlmeS1wYW5lbC5qc2Ag6IO9IGByZXF1aXJlYCDnvJbor5HkuqfniakgYGRpc3QvcGFuZWxzL2RlZmF1bHQvcHJvZ3Jlc3MuanNg77yMXG4gKiDljbTmi7/kuI3liLAgYGluZGV4LnRzYCDph4znmoTlhoXpg6jlh73mlbDvvIjpgqPkuI3mmK/mqKHlnZfvvIzmmK/kuIDmlbTkuKrpnaLmnb/lhaXlj6PvvInjgIJcbiAqXG4gKiAjIyDov5nph4zmlL7nmoTkuInku7bkuovvvIzlnY/mjonpg70qKuS4jeS8muaKpemUmSoqXG4gKlxuICogfCDlh73mlbAgfCDlnY/kuobkvJrmgI7moLcgfFxuICogfC0tLXwtLS18XG4gKiB8IGB0b2RvQ291bnRzYCB8IOeKtuaAgeihjOmCo+milyBjaGlwIOS4juaKveWxiemHjOeahOOAjOWujOaIkCBOIC8g5YWxIE3jgI3lr7nkuI3kuIrvvIjkuKTkuKrmlbDlkIToh6rpg73jgIznnIvotbfmnaXov5jooYzjgI3vvIkgfFxuICogfCBgcHJvZ3Jlc3NDaGlwVGV4dGAgfCDnirbmgIHooYwqKuW5s+mdmeWcsOaSkuiwjioqIOKAlOKAlCDmnIDpmr7nnIvnmoTkuIDnp43mmK/miorkuIrkuIDova7nmoTmuIXljZXlhpnmiJDjgIznjrDlnKjmraPlnKjlgZrnmoTkuosgMy8444CNIHxcbiAqIHwgYFRPRE9fTUFSS2AgfCDmuIXljZXph4zkuInnp43nirbmgIHplb/lvpfkuIDmoLfvvIjlhajpg6ggYOKXi2DvvInvvIzkuIDnnLznnIvkuI3lh7rlk6rmnaHlnKjlgZogfFxuICpcbiAqIOaJgOS7peWug+S7rOWAvOW+l+S4gOW8oOW3suefpeetlOahiOihqO+8jOiAjOeUuyBET00g55qE6YKj5Lqb5Ye95pWw5LiN5YC85b6X77yI57G75ZCNL+e7k+aehOeUsSBgdmVyaWZ5LXBhbmVsYFxuICog55qE5b+F6ZyA57G75ZCN5riF5Y2V5LiO6aKE6KeI5Zmo55uu5rWL5YWc552A77yJ44CCXG4gKlxuICog4pqgIOi/memHjCoq5LiN6K64IGltcG9ydCDku7vkvZXkuJzopb8qKu+8iOmdouadv+aYr+mbtuS+nei1lueahO+8ie+8jOS5n+S4jeiuuOeisCBgZG9jdW1lbnRg44CCXG4gKlxuICogQG1vZHVsZSBkc2hfY2hhdC9wYW5lbC9wcm9ncmVzc1xuICovXG5cbmltcG9ydCB0eXBlIHsgR29hbFZpZXcsIFByb2dyZXNzVmlldywgVG9kb1N0YXR1cywgVG9kb1ZpZXcgfSBmcm9tICcuLi8uLi9jb25zdGFudHMnO1xuXG4vKiog5LiJ56eN54q25oCB55qE5qCH6K6w77ya6Z2i5p2/6YeM5rKh5pyJ5Zu+5qCH6LWE5rqQ77yM6ICM6L+Z5LiJ5Liq56ym5Y+35Zyo5Lu75L2V5a2X5L2T6YeM6YO95pyJ44CCICovXG5leHBvcnQgY29uc3QgVE9ET19NQVJLOiBSZWNvcmQ8VG9kb1N0YXR1cywgc3RyaW5nPiA9IHsgcGVuZGluZzogJ+KXiycsIGluX3Byb2dyZXNzOiAn4peQJywgY29tcGxldGVkOiAn4pyTJyB9O1xuXG4vKiog55uu5qCH6Zi25q6155qE6K+05rOV77yI6Iux5paH5p6a5Li+IOKGkiDpnaLmnb/kuIrnmoTkuK3mlofvvJtgPz8gZmFsbGJhY2tgIOeUseiwg+eUqOaWueWFnO+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IEdPQUxfUEhBU0VfVEVYVDogUmVjb3JkPEdvYWxWaWV3WydwaGFzZSddLCBzdHJpbmc+ID0ge1xuICAgIGFjdGl2ZTogJ+i/m+ihjOS4rScsXG4gICAgcGF1c2VkOiAn5bey5pqC5YGcJyxcbiAgICBibG9ja2VkOiAn5Y2h5L2P5LqGJyxcbiAgICBjb21wbGV0ZTogJ+W3suWujOaIkCcsXG59O1xuXG4vKipcbiAqIOaVsOS4gOmBjea4heWNle+8iOe6r+iuoeaVsO+8jOayoeacieWPo+W+hOmXrumimCDigJTigJQg5omA5Lul6Z2i5p2/5Y+v5Lul6Ieq5bex566X77yM5LiN5b+F6Zeu5a6/5Li777yJ44CCXG4gKlxuICogQHBhcmFtIHRvZG9zIC0g5riF5Y2V44CCXG4gKiBAcmV0dXJucyBgZG9uZWAgLyBgYWN0aXZlYCAvIGB0b3RhbGDvvJtgdG90YWxgIOaYryoq5p2h55uu5oC75pWwKirvvIjkuI3mmK8gZG9uZSArIGFjdGl2Ze+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gdG9kb0NvdW50cyh0b2RvczogVG9kb1ZpZXdbXSk6IHsgZG9uZTogbnVtYmVyOyBhY3RpdmU6IG51bWJlcjsgdG90YWw6IG51bWJlciB9IHtcbiAgICBsZXQgZG9uZSA9IDA7XG4gICAgbGV0IGFjdGl2ZSA9IDA7XG4gICAgZm9yIChjb25zdCB0b2RvIG9mIHRvZG9zKSB7XG4gICAgICAgIGlmICh0b2RvLnN0YXR1cyA9PT0gJ2NvbXBsZXRlZCcpIGRvbmUgKz0gMTtcbiAgICAgICAgZWxzZSBpZiAodG9kby5zdGF0dXMgPT09ICdpbl9wcm9ncmVzcycpIGFjdGl2ZSArPSAxO1xuICAgIH1cbiAgICByZXR1cm4geyBkb25lLCBhY3RpdmUsIHRvdGFsOiB0b2Rvcy5sZW5ndGggfTtcbn1cblxuLyoqXG4gKiDnirbmgIHooYzpgqPpopfjgIzlvoXlip4geC9544CN5YaZ5LuA5LmI44CCYG51bGxgID0g5pW06aKX6JeP6LW35p2l44CCXG4gKlxuICog5Zub56eN44CM5rKh5pyJL+ayoeacieaEj+S5ieOAjeWQhOacieWQhOeahOWGmeazle+8jOWboOS4uuWug+S7rOaYr+S4jeWQjOeahOS6i++8mlxuICpcbiAqIHwg5oOF5Ya1IHwg6L6T5Ye6IHwg5Li65LuA5LmI5LiN6IO95ZCI5bm2IHxcbiAqIHwtLS18LS0tfC0tLXxcbiAqIHwg5LiA5qyh6YO95rKh6K+76L+H77yIYHByb2dyZXNzID09PSBudWxsYO+8iSB8IGBudWxsYO+8iOiXj+i1t+adpe+8iSB8IOaYvuekuiBgMC8wYCDkvJrlgYfoo4XjgIxhZ2VudCDkuIDmnaHpg73msqHlgZrlrozjgI0gfFxuICogfCDnvJPlrZjor7Tov5nkuIDova7msqHlhpnmuIXljZUgfCBg5b6F5YqeIOKAlGAgfCDnoLTmipjlj7fmmK/jgIzkuI3nn6XpgZPjgI3vvIzkuI7jgIzpm7bjgI3mmK/kuKTku7bkuosgfFxuICogfCBhZ2VudCDmmI7noa7lhpnkuobkuIDku73nqbrooaggfCBg5b6F5YqeIOepumAgfCDov5nmmK8qKuWug+iHquW3seivtOeahCoq77yM5LiN5piv6K+75LiN5YiwIHxcbiAqIHwg5pyJ5riF5Y2VIHwgYOW+heWKniAzLzhg77yI5Y+v6IO95bim44CM77yI5LiK5LiA6L2u77yJ44CN77yJIHwg4oCU4oCUIHxcbiAqXG4gKiDimqAgYO+8iOS4iuS4gOi9ru+8iWAg6YKj5Zub5Liq5a2X5piv6L+Z6aKXIGNoaXAg5a2Y5Zyo55qE5Li76KaB55CG55Sx77ya5riF5Y2V5omA5bGe6L2u5qyh5q+U5b2T5YmN6L2u5qyh5pen5pe277yMXG4gKiBEU0gg55qE5oqV5b2xKirlt7Lnu4/miorlroPlvZLpm7bkuoYqKu+8iGB0b2RvL3dyaXRlYCDnmoTmipXlvbHlnKjmr4/mrKEgYHR1cm4vc3RhcnRgIOW9kumbtu+8ie+8jFxuICog5Lmf5bCx5piv44CM5pys6L2uIGFnZW50IOi/mOayoeWGmea4heWNleOAjeOAguS4jeWKoOi/meS4quagh+iusO+8jOeUqOaIt+S8muaKiuS4iuS4gOi9rueahOihqOW9k+aIkOeOsOWcqOato+WcqOWBmueahOS6i+OAglxuICpcbiAqIEBwYXJhbSBwcm9ncmVzcyAtIOWuv+S4u+WQiOW5tuWlveeahOi/m+W6pu+8m+ayoeacieivu+aVsOaXtiBudWxs44CCXG4gKiBAcmV0dXJucyBjaGlwIOaWh+ahiO+8m+i/lOWbniBudWxsIOihqOekuui/memilyBjaGlwIOivpeiXj+i1t+adpeOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvZ3Jlc3NDaGlwVGV4dChwcm9ncmVzczogUHJvZ3Jlc3NWaWV3IHwgbnVsbCk6IHN0cmluZyB8IG51bGwge1xuICAgIGlmICghcHJvZ3Jlc3MpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHRvZG9zID0gcHJvZ3Jlc3MudG9kb3M7XG4gICAgaWYgKHRvZG9zID09PSBudWxsKSB7XG4gICAgICAgIC8vIOS8muivnemHjOW3sue7j+aciei/h+WKqOmdme+8iOi9ruasoS/nm67lvZXvvInmiY3lgLzlvpfljaDnirbmgIHooYznmoTkvY3nva7or7TkuIDlj6XjgIzmsqHmnInmuIXljZXjgI3vvIxcbiAgICAgICAgLy8g5YWo5paw5Lya6K+d77yI6L+Y5rKh5byA6LeR77yJ5bCx5pW06aKX6JeP6LW35p2lIOKAlOKAlCDpgqPml7blgJnmsqHmnInmuIXljZXmmK/nkIbmiYDlvZPnhLbnmoRcbiAgICAgICAgcmV0dXJuIHByb2dyZXNzLmN1cnJlbnRUdXJuID4gMCB8fCBwcm9ncmVzcy50dXJucy5sZW5ndGggPiAwID8gJ+W+heWKniDigJQnIDogbnVsbDtcbiAgICB9XG4gICAgaWYgKHRvZG9zLmxlbmd0aCA9PT0gMCkgcmV0dXJuICflvoXlip4g56m6JztcbiAgICBjb25zdCB7IGRvbmUsIHRvdGFsIH0gPSB0b2RvQ291bnRzKHRvZG9zKTtcbiAgICByZXR1cm4gcHJvZ3Jlc3Muc3RhbGUgPyBg5b6F5YqeICR7ZG9uZX0vJHt0b3RhbH3vvIjkuIrkuIDova7vvIlgIDogYOW+heWKniAke2RvbmV9LyR7dG90YWx9YDtcbn1cblxuLyoqXG4gKiDlm57lkIjnm67lvZXph4zpgqPkuIDmnaHnmoTlpLTpg6jmj5DnpLrjgIJcbiAqXG4gKiDliIbkuKTlj6XnmoTnkIbnlLHvvJoqKuiDveS4jeiDveeCuSoq5b+F6aG75LiA55y855yL5b6X5Ye65p2l44CC6Lez5LiN5LqG55qE5YGa5oiQIGA8ZGl2PmDvvIjlvaLnirbkuIrlsLHngrnkuI3liqjvvInvvIxcbiAqIOS9hueUqOaIt+i/mOaYr+imgeefpemBk+OAjOS4uuS7gOS5iOeCueS4jeWKqOOAjeKAlOKAlCDlhajmloflhpnlnKjmir3lsYnlupXpg6jvvIzov5nph4zlj6rnu5nmnIDnn63nmoTkuIDlj6XjgIJcbiAqXG4gKiBAcGFyYW0ganVtcGFibGUgLSDpgqPkuIDova7nmoTmraPmlofov5jlnKjkuI3lnKjpnaLmnb/nmoTovazlhpnnqpflj6Pph4zvvIhgVHVyblZpZXcuZW50cnlTZXEgIT09IG51bGxg77yJ44CCXG4gKiBAcmV0dXJucyDlpLTpg6jpgqPlj6Xmj5DnpLrjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHR1cm5IZWFkSGludChqdW1wYWJsZTogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGp1bXBhYmxlID8gJ8K3IOeCueS4gOS4i+i3s+WIsOmCo+S4gOi9ricgOiAnwrcg5Y+q5pyJ5pGY6KaBJztcbn1cbiJdfQ==