import { _decorator, Button, Color, Label, Node, Sprite, color } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DifficultyScopeEvents } from './DifficultyScope';

const { ccclass, property } = _decorator;

//选择状态下背景的颜色
const CELL_SELECT_BG_COLOR = color("406E6E")
//已解锁且未选中状态下背景的颜色
const CELL_UNSELECT_BG_COLOR = color("C6D0D0")
//未解锁状态下背景的颜色
const CELL_Lock_BG_COLOR = color("737E84")
//已解锁且选中状态下文字和unlock节点的颜色。未解锁文字和lock节点的颜色
const CELL_SELECT_Text_COLOR = color("FFFFFF")
//已解锁且未选中状态下文字和unlock节点的颜色
const CELL_UNSELECT_Text_COLOR = color("3A4A4E")

/**
 * 一格的三态 —— **与弹窗图例的三态一一对应**（当前选择 / 已解锁 / 未解锁）。
 *
 * 判据由宿主 `Cmp_Difficulty` 算好下发（本类**不读存档**）：
 *   · `locked`   档位 > `LevelData.getUnlockedLevel()`（未解锁：深灰底 + 白锁）
 *   · `selected` 档位 === 宿主待确认的档位（深青绿底 + 白字 + 选中环）
 *   · `unlocked` 其余（浅灰底 + 墨字 + 墨色菱形徽记）
 */
export type DifficultyCellState = 'selected' | 'unlocked' | 'locked';

/**
 * 子节点名（与 `DifficuteCell.prefab` 一致；`@property` 全都没拖也能按名字兜底解析）。
 * ⚠ `lock` 指的是预制件里那个**叫 `mark` 的节点**（作者把锁图标放在了 `mark` 上，
 *   而 `@property` 的名字是 `lockNode`）—— 改名要同步这里和预制件。
 */
const CHILD = {
    ring: 'ring',
    bg: 'bg',
    num: 'num',
    /** 已解锁的菱形徽记（12×12 白方块转 45°） */
    unlock: 'unlock',
    /** 未解锁的锁（16×18 的 `textures/common/lock`） */
    lock: 'mark',
} as const;

/**
 * Cmp_DifficultyCell —— 难度网格里的**一格**（`DifficuteCell.prefab` 的根组件）
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`（**不加 @uiview**）。
 *
 * ── 节点契约（`assets/resources/prefabs/ui/scenes/scene_menu/cmps/DifficuteCell.prefab`）──
 * ```
 * DifficuteCell        48×48，Button(SCALE, zoom 1.06) + 本组件
 * ├── ring             56×56 选中环（描边方框 #6FA9A7）—— 垫在 bg 底下
 * ├── bg               48×48 底（`rect_rd_5_white`，运行期染色）
 * ├── num              Label（档位数字）
 * ├── unlock           12×12 菱形徽记 = 已解锁
 * └── mark             16×18 锁 = 未解锁（`@property` 里叫 `lockNode`）
 * ```
 *
 * ── 职责只有两件 ──
 *   ① **渲染**：把宿主下发的三态画到上面那几个节点上（配色是本文件顶部的五个常量，**运行期唯一写入口**）；
 *   ② **通知**：点一下 `scope.emit(DifficultyScopeEvents.Pick, cellNum)`，向上冒泡给 `Cmp_Difficulty` ——
 *      "选中哪一档"由弹窗决定，格子自己不改任何状态。
 *
 * ── 两条实现口径 ──
 *   ① **颜色永远由本类写**，不交给 Button 的过渡：`interactable = false`（未解锁）时 Button 会用
 *      `_disabledColor` 覆盖外观，作者摆的深灰底会被吃成另一块灰（`AchievementItem` / `TaskItem` 踩过）。
 *      预制件里是 `SCALE` 过渡，只缩放不改色，所以这里是安全的。
 *   ② **未解锁的格子 `interactable = false`**：摁下去不会有 SCALE 反馈，也收不到 CLICK
 *      （`onClickCell` 里再判一次状态，双保险）。
 */
@ccclass('Cmp_DifficultyCell')
export class Cmp_DifficultyCell extends UIWidget {

    @property(Node)
    ringNode: Node = null;

    @property(Node)
    bgNode: Node = null;

    @property(Node)
    numNode: Node = null;

    @property(Node)
    unlockNode: Node = null;

    @property(Node)
    lockNode: Node = null;

    /** 这一格是第几档（1 ~ `DIFFICULTY_MAX`），由宿主在铺格时下发 */
    cellNum = 0;

    /** 当前状态（宿主下发；默认"已解锁"只是为了第一帧不画成锁，真正的状态马上会被刷上去） */
    private state: DifficultyCellState = 'unlocked';

    /** 格子根节点上的按钮（`onInit` 解析一次） */
    private button: Button = null;

    /** 子节点是否已经解析过（`apply` 每次都调 `resolveRefs`，只真解析一次） */
    private refsResolved = false;

    protected onInit(): void {
        this.resolveRefs();
        this.button = this.node.getComponent(Button) ?? this.node.addComponent(Button);
        if (this.button) {
            // 过渡只缩放、不染色（预制件里就是 SCALE）→ 不会与下面写死的三态色打架
            this.button.node.on(Button.EventType.CLICK, this.onClickCell, this);
        }
        this.apply();
    }

    /** 每次显示按当前字段重画一次（`state` / `cellNum` 是普通字段，watch 感知不到） */
    protected onShow(): void {
        this.apply();
    }

    protected onDispose(): void {
        // 事件挂在**自己**的节点上，同样要走 offNodeEvent（节点销毁时 node.off 会炸，见 AGENTS.md）
        this.offNodeEvent(this.node, Button.EventType.CLICK, this.onClickCell, this);
        this.button = null;
    }

    /* ===================================================================
     * 对外：宿主下发
     * =================================================================== */

    /** 设档位（铺格时用；只写数字，状态由 `setState` 刷） */
    public setNum(num: number): void {
        this.cellNum = num;
        this.apply();
    }

    /** 只刷状态（宿主改选择时对**每一格**调一次） */
    public setState(state: DifficultyCellState): void {
        this.state = state;
        this.apply();
    }

    /** 一次下发档位 + 状态（宿主铺格/刷新时的常用入口） */
    public setInfo(level: number, state: DifficultyCellState): void {
        this.cellNum = level;
        this.state = state;
        this.apply();
    }

    /** 当前状态（宿主想在上报前看一眼时用） */
    public getState(): DifficultyCellState {
        return this.state;
    }

    /* ===================================================================
     * 渲染
     * =================================================================== */

    private apply(): void {
        this.resolveRefs();

        const selected = this.state === 'selected';
        const locked = this.state === 'locked';

        // 底 + 数字（配色见文件顶部；`interactable=false` 不会染色，理由见类注释①）
        this.setSpriteColor(this.bgNode,
            locked ? CELL_Lock_BG_COLOR : (selected ? CELL_SELECT_BG_COLOR : CELL_UNSELECT_BG_COLOR));
        this.setTextColor(this.numNode, selected || locked ? CELL_SELECT_Text_COLOR : CELL_UNSELECT_Text_COLOR);
        this.setLabel(this.numNode, this.cellNum > 0 ? `${this.cellNum}` : '');

        // 徽记：菱形 = 已解锁（选中时白 / 未选中时墨），锁 = 未解锁（白）
        if (this.unlockNode) {
            this.unlockNode.active = !locked;
            this.setSpriteColor(this.unlockNode, selected ? CELL_SELECT_Text_COLOR : CELL_UNSELECT_Text_COLOR);
        }
        if (this.lockNode) {
            this.lockNode.active = locked;
            this.setSpriteColor(this.lockNode, CELL_SELECT_Text_COLOR);
        }

        // 选中环：只有「当前选择」那一格亮（预制件里默认是亮的，所以别的地方必须显式关掉）
        if (this.ringNode) this.ringNode.active = selected;

        if (this.button) this.button.interactable = !locked;
    }

    /** 写 Sprite 颜色（Cocos 的 setter 内部是 `_color.set(value)` 拷贝，共用同一个 Color 常量是安全的） */
    private setSpriteColor(node: Node, c: Color): void {
        const sp = node ? node.getComponent(Sprite) : null;
        if (sp && sp.isValid) sp.color = c;
    }

    private setTextColor(node: Node, c: Color): void {
        const lb = node ? node.getComponent(Label) : null;
        if (lb && lb.isValid) lb.color = c;
    }

    /** 写文案（相同就不写：100 格的字符串重排没必要每帧做） */
    private setLabel(node: Node, text: string): void {
        const lb = node ? node.getComponent(Label) : null;
        if (lb && lb.isValid && lb.string !== text) lb.string = text;
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    /** 点格子：只向上通知"我想选这一档"，选中与否由弹窗决定 */
    private onClickCell(): void {
        if (this.state === 'locked') return;      // 未解锁点不动（`interactable` 也是 false，双保险）
        if (this.cellNum < 1) return;             // 还没被铺格下发过（理论上不会）
        this.scope.emit(DifficultyScopeEvents.Pick, this.cellNum);
    }

    /* ===================================================================
     * 节点契约（`@property` 没拖就按名字兜底，只在缺的时候查一次）
     * =================================================================== */

    /** 子节点是否已经解析过（`apply` 每次都会调 `resolveRefs`，只真解析一次） */
    private resolveRefs(): void {
        if (this.refsResolved) return;
        this.refsResolved = true;

        const n = this.node;
        this.ringNode = this.ringNode ?? n.getChildByName(CHILD.ring);
        this.bgNode = this.bgNode ?? n.getChildByName(CHILD.bg);
        this.numNode = this.numNode ?? n.getChildByName(CHILD.num);
        this.unlockNode = this.unlockNode ?? n.getChildByName(CHILD.unlock);
        this.lockNode = this.lockNode ?? n.getChildByName(CHILD.lock);

        if (!this.bgNode || !this.numNode) {
            ezgame.warn(`[难度选择] 格子契约不完整（需要 ${CHILD.bg} / ${CHILD.num}）：${n.name}，`
                + `bg=${!!this.bgNode} num=${!!this.numNode}`);
        }
    }
}
