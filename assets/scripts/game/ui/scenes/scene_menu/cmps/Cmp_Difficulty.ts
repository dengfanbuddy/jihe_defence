import { _decorator, Button, instantiate, Label, Node } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter } from '../../../../data';
import { DIFFICULTY_MAX, levelLabel } from '../../../../common/DifficultyConfig';
import { Cmp_DifficultyCell } from './Cmp_DifficultyCell';
import type { DifficultyCellState } from './Cmp_DifficultyCell';
import { DifficultyScopeEvents } from './DifficultyScope';

const { ccclass, property } = _decorator;

/**
 * `content` 里作者摆的那一个格子实例（`DifficuteCell.prefab` 的嵌套预制件实例）的**节点名**。
 * 它就是**模板**：运行期照它克隆 100 份，**它自己当第 1 格** —— 不另外留一个模板节点，
 * 否则 `content` 上的 GRID Layout 会把它也排进网格、白占一格。
 */
const CELL_TEMPLATE_NAME = 'cell';

/** 运行期铺出来的格子名（`cell_001` ~ `cell_100`）；名字只用于排查，档位来自 `cellNum` */
const CELL_PREFIX = 'cell_';

/** 节点名（弹窗子树的节点契约；改预制件里的名字要同步这里） */
const NODE = {
    content: 'panel/list/content',
    count: 'panel/header/count',
    closeBtn: 'panel/header/btn_close',
    detailTitle: 'panel/detail/title',
    startBtn: 'panel/detail/btn_start',
} as const;

/** `cell_001` 这种名字（只用于日志与排错） */
function cellName(level: number): string {
    // 不用 `padStart`：本项目 target 是 es2015（lib 里没有 ES2017 的 String 扩展方法）
    return `${CELL_PREFIX}${`00${level}`.slice(-3)}`;
}

/**
 * Cmp_Difficulty —— `Scene_Menu/ui_difficulty`（**难度选择弹窗**）的页面控制器
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`（**不加 @uiview**）。
 *
 * ── 节点契约（`assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab`）──
 * ```
 * ui_difficulty                 ← 本组件挂这里（`@property` 已在预制件里拖好）
 * ├── mask                      全屏遮罩（纯视觉，**不接点击**：理由见下）
 * └── panel
 *     ├── bg / header           header: title(难度选择) / count(共 100 关) / btn_close
 *     ├── legend                三态图例（纯展示，代码不碰）
 *     ├── detail                title(关卡 09) / btn_start(确定)
 *     └── list(ScrollView) → content(GRID Layout) → cell   ← 模板（DifficuteCell 实例）
 * ```
 *
 * ── 职责 ──
 *   · **铺格**：按模板克隆 `DIFFICULTY_MAX` 个 `Cmp_DifficultyCell`（10 列 × 10 行，行 = 段）；
 *   · **定状态**：按 `LevelData` 给每格算三态（当前选择 / 已解锁 / 未解锁）并下发；
 *   · **选择**：收格子冒泡上来的 `Pick`（**确认前不落盘**）；
 *   · **通知宿主**：点「确定」`emit(Confirm, level)`、点关闭 `emit(Close)` —— 落盘（`LevelData.selectLevel`）
 *     与进游戏都由 `Scene_Menu` 做（弹窗不知道"下一屏是谁"）。
 *
 * ── 三态（与图例一一对应；配色真源在 `Cmp_DifficultyCell`）──
 * | 状态 | 判据 | 底 | 数字 | 徽记 | 选中环 |
 * |---|---|---|---|---|---|
 * | 当前选择 | `level === pending` | 深青绿 `#406E6E` | 白 | 白菱形 | **显示** |
 * | 已解锁 | `level <= unlocked` | 浅灰 `#C6D0D0` | 墨 `#3A4A4E` | 墨菱形 | — |
 * | 未解锁 | `level > unlocked` | 深灰 `#737E84` | 白 | 白锁 | — |
 *
 * 「当前选择」永远只有一格（环是格子自己的节点，按状态显隐，不再跨格子搬）。
 *
 * ── 两条实现口径（都是踩过的坑）──
 *   ① **遮罩不接点击**：Cocos 的节点触摸**只命中注册过监听器的节点** —— 遮罩上挂监听后，
 *      点标题/图例/空白处（那些节点没有监听器）也会命中遮罩，于是弹窗会在玩家没点关闭时自己收起来。
 *      关窗只留 `btn_close` 一条路。
 *   ② **状态只由本类写、格子只负责画**：格子之间互不通信、也不互相 `getComponent`；
 *      向上通知走 `scope.emit`（沿 `node.parent` 冒泡，深度无关）。
 */
@ccclass('Cmp_Difficulty')
export class Cmp_Difficulty extends UIWidget {

    /** 网格容器（`panel/list/content`）—— 留 `@property` 只为编辑器里能拖，不拖就按名字解析 */
    @property(Node)
    contentNode: Node = null;
    /** 详情条标题（`panel/detail/title`，显示「关卡 09」） */
    @property(Label)
    detailTitle: Label = null;
    /** 顶部计数（`panel/header/count`，显示「共 100 关」） */
    @property(Label)
    countLabel: Label = null;
    /** 右上角关闭按钮（`panel/header/btn_close`） */
    @property(Node)
    closeBtnNode: Node = null;
    /** 详情条「确定」按钮（`panel/detail/btn_start`） */
    @property(Node)
    startBtnNode: Node = null;

    /** 全部格子（下标 + 1 = 档位；铺格时按档位顺序 push） */
    private cells: Cmp_DifficultyCell[] = [];
    /** 是否已经铺过格（100 格不会变，铺一次就够；之后每次打开只重画状态） */
    private built = false;
    /** 本次打开时**待确认**的档位（确认前不落盘；每次 onShow 从数据层重新取） */
    private pending = 1;

    /* ===================================================================
     * 生命周期（Cocos 回调由基类接管，子类只用 onInit / onShow / onDispose）
     * =================================================================== */

    protected onInit(): void {
        this.resolveRefs();
        this.bindButtons();
        // 格子的点击冒泡上来 → 只改"待确认的档位"（格子不知道选中规则，弹窗不知道存档）
        this.scope.on(DifficultyScopeEvents.Pick, this.onPickCell, this);
        console.log(`[难度选择] onInit：content=${!!this.contentNode} 详情标题=${!!this.detailTitle} `
            + `确定按钮=${!!this.startBtnNode} 关闭按钮=${!!this.closeBtnNode}`);
    }

    /** 每次打开都按**最新进度**重画（进度只可能在局内变，所以不需要 watch） */
    protected onShow(): void {
        this.pending = DataCenter.ins.levelData.getSelectedLevel();
        this.buildGrid();
        this.render();
    }

    protected onDispose(): void {
        // 节点事件要用注册时的同一个引用摘（见 AGENTS.md 的 offNodeEvent）
        this.offNodeEvent(this.closeBtnNode, Button.EventType.CLICK, this.onClickClose, this);
        this.offNodeEvent(this.startBtnNode, Button.EventType.CLICK, this.onClickConfirm, this);
        // `scope.on(Pick)` 不必手动摘：作用域销毁时会清空自己的事件总线（UIComponent.onDestroy）
        this.cells = [];
    }

    /* ===================================================================
     * 对外
     * =================================================================== */

    /** 当前待确认的档位（宿主想在上报前看一眼时用；正常流程走 `Confirm` 事件就够了） */
    getPendingLevel(): number {
        return this.pending;
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    private resolveRefs(): void {
        const n = this.node;
        this.contentNode = this.contentNode ?? n.getChildByPath(NODE.content);
        this.detailTitle = this.detailTitle ?? n.getChildByPath(NODE.detailTitle)?.getComponent(Label);
        this.countLabel = this.countLabel ?? n.getChildByPath(NODE.count)?.getComponent(Label);
        this.closeBtnNode = this.closeBtnNode ?? n.getChildByPath(NODE.closeBtn);
        this.startBtnNode = this.startBtnNode ?? n.getChildByPath(NODE.startBtn);

        if (!this.contentNode || !this.detailTitle || !this.startBtnNode) {
            ezgame.warn('[难度选择] 子节点契约不完整（需要 panel/list/content、panel/detail/title、'
                + `panel/detail/btn_start）：${this.node.name}，找到 content=${!!this.contentNode} `
                + `title=${!!this.detailTitle} start=${!!this.startBtnNode}`);
        }
    }

    private bindButtons(): void {
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);
        this.startBtnNode?.on(Button.EventType.CLICK, this.onClickConfirm, this);
    }

    /* ===================================================================
     * 铺格
     * =================================================================== */

    /**
     * 照模板铺 `DIFFICULTY_MAX` 个格子（**幂等**：只铺一次，之后每次打开只重画状态）。
     *
     * 模板 = `content` 里作者摆的那一个 `DifficuteCell` 预制件实例（节点名 `cell`）：
     * 它**自己当第 1 格**，其余按档位顺序克隆（`content` 上有 GRID Layout，10 列 → 正好 10 行，
     * 一行 = 一个段，与设计稿的「10 段 × 10 档」同构）。
     *
     * ⚠ 不留模板节点：多一个不可见的模板也会被 Layout 排进网格，整排会错位一格。
     * ⚠ 克隆件要显式 `active = true`：模板将来若被作者改成 `active=false`，克隆出来也会是隐藏的。
     */
    private buildGrid(): void {
        if (this.built) return;
        const content = this.contentNode;
        if (!content) return;

        const template = content.getChildByName(CELL_TEMPLATE_NAME);
        if (!template) {
            ezgame.error(`[难度选择] ${this.node.name} 的 ${NODE.content} 下找不到格子模板「${CELL_TEMPLATE_NAME}」`
                + `（要求：把 DifficuteCell 预制件拖进 content，并把那个节点的名字留成 ${CELL_TEMPLATE_NAME}）`);
            return;
        }
        const templateName = template.name;

        for (let level = 1; level <= DIFFICULTY_MAX; level++) {
            // 第 1 格直接复用模板节点（不再多留模板，见方法注释）
            const node = level === 1 ? template : instantiate(template);
            if (!node) continue;
            node.name = cellName(level);
            node.active = true;
            if (node.parent !== content) content.addChild(node);

            const cell = node.getComponent(Cmp_DifficultyCell) ?? node.addComponent(Cmp_DifficultyCell);
            if (!cell) {
                ezgame.warn(`[难度选择] 格子 ${node.name} 上挂不上 Cmp_DifficultyCell（预制件里没挂？），该格不可用`);
                continue;
            }
            cell.setNum(level);
            this.cells.push(cell);
        }
        this.built = true;
        console.log(`[难度选择] 铺格完成：${this.cells.length}/${DIFFICULTY_MAX} 格（模板=${templateName}）`);
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    /** 收格子的 `Pick`：只改待确认的档位（未解锁的档位一律不认，格子自己已经拦过一道） */
    private onPickCell(level: number): void {
        if (!Number.isFinite(level) || level < 1 || level > DIFFICULTY_MAX) return;
        if (level === this.pending) return;
        if (level > DataCenter.ins.levelData.getUnlockedLevel()) return;
        this.pending = level;
        this.render();
    }

    private onClickConfirm(): void {
        this.scope.emit(DifficultyScopeEvents.Confirm, this.pending);
    }

    private onClickClose(): void {
        this.scope.emit(DifficultyScopeEvents.Close);
    }

    /* ===================================================================
     * 渲染（只读数据层 + 本类的 pending → 下发到每一格）
     * =================================================================== */

    private render(): void {
        const unlocked = DataCenter.ins.levelData.getUnlockedLevel();

        if (this.countLabel) this.countLabel.string = `共 ${DIFFICULTY_MAX} 关`;
        if (this.detailTitle) this.detailTitle.string = levelLabel(this.pending);

        for (const cell of this.cells) {
            if (!cell || !cell.isValid) continue;
            cell.setState(this.stateOf(cell.cellNum, unlocked));
        }
    }

    /**
     * 一格的三态。
     * **未解锁优先**：正常数据下选中的档位一定已解锁（`getSelectedLevel` 读的时候就收敛过），
     * 这一条只是防脏数据把"未解锁"画成"当前选择"。
     */
    private stateOf(level: number, unlocked: number): DifficultyCellState {
        if (level > unlocked) return 'locked';
        return level === this.pending ? 'selected' : 'unlocked';
    }
}
