import { _decorator, Button, Color, Label, Node, Sprite, UITransform } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { TaskConfig } from '../../../data/configs/TaskConfig';
import type { TaskCfg } from '../../../excel_table/Tb_TaskConfig';
import type { TaskState } from '../../../data/funcs/TaskData';
import { TaskScopeEvents } from './TaskScope';

const { ccclass, property } = _decorator;

/**
 * 三种（四种）状态的表现 —— **唯一配色源**（数值取预制件里作者摆的三态色：
 * 未完成灰 / 领取青 / 已领取浅灰）。
 *
 * ⚠ 为什么不交给 Button 的 Color 过渡：`interactable = false` 时 Button 会强制用
 * `_disabledColor`（灰 124）覆盖外观，而「未完成」与「已领取」都不可点，
 * 作者摆的两种颜色会被同一块灰吃掉。所以这里把 `transition` 关掉、颜色由本组件写。
 */
const STATE_STYLE: Record<TaskState, { text: string; bg: string; labelColor: string }> = {
    locked: { text: '未解锁', bg: '#B9C1C1', labelColor: '#FFFFFF' },
    active: { text: '未完成', bg: '#B9C1C1', labelColor: '#FFFFFF' },
    claimable: { text: '领取', bg: '#3F9E9B', labelColor: '#FFFFFF' },
    claimed: { text: '已领取', bg: '#E0E4E4', labelColor: '#9AA6A6' },
};

/** 任务名（标题）色：可领奖时高亮，其余用预制件的深墨色 */
const TITLE_COLOR_NORMAL = '#2F3A3C';
const TITLE_COLOR_CLAIMABLE = '#3F9E9B';

/** 进度条满宽兜底（预制件 progress_bg 宽 250；找不到父节点时用它） */
const DEFAULT_BAR_WIDTH = 250;

/**
 * 任务列表里的**一个任务格子**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有两件：
 *   ① 渲染：把宿主下发的「任务配置 + 状态 + 进度」画到预制件的节点上
 *      （标题 / 描述 / 进度条 / 两个奖励格 / 状态按钮）；
 *   ② 通知：点「领取」时 `scope.emit(TaskScopeEvents.Claim, id)` —— 领奖、发奖、刷新都由宿主做。
 *
 * 组件是**运行时挂的**（`View_TaskUI.ensureItems()` 给 content 下已有的 task_item_* 节点 addComponent），
 * 所以所有子节点引用都按名字兜底解析（`@property` 没拖也能跑，见 `resolveRefs`）。
 */
@ccclass('TaskItem')
export class TaskItem extends UIWidget {

    @property(Label)
    titleLabel: Label = null;
    @property(Label)
    descLabel: Label = null;
    @property(Label)
    progressLabel: Label = null;
    /** 奖励 1 = 账号经验 */
    @property(Label)
    rewardExpLabel: Label = null;
    /** 奖励 2 = 金币 */
    @property(Label)
    rewardGoldLabel: Label = null;
    @property(Label)
    stateLabel: Label = null;
    /** 进度条填充（锚点在左 → 改宽度即从左往右涨） */
    @property(Node)
    progressFill: Node = null;
    @property(Node)
    rewardExpNode: Node = null;
    @property(Node)
    rewardGoldNode: Node = null;
    @property(Button)
    stateBtn: Button = null;

    /** 当前格子的任务（null = 空格子） */
    private cfg: TaskCfg | null = null;
    /** 当前状态（宿主下发，非响应式字段 —— 每次 setTask/onShow 都会按它重画） */
    private state: TaskState = 'active';
    /** 当前进度 */
    private progress = 0;
    /** 进度条满宽（首次解析时缓存：之后宽度被进度改写，再读父节点就读不到原值了） */
    private barWidth = DEFAULT_BAR_WIDTH;
    private barWidthCached = false;

    protected onInit(): void {
        this.resolveRefs();
        // 状态按钮自己写色，不用 Button 的 Color 过渡（否则 disabled 会把配色吃掉）
        if (this.stateBtn) this.stateBtn.transition = Button.Transition.NONE;
        this.stateBtn?.node.on(Button.EventType.CLICK, this.onClickState, this);
    }

    protected onShow(): void {
        // 显示时按当前状态无条件重画一次（cfg/state 都是普通字段，watch 感知不到）。
        // ⚠ 只在**有任务**时重画：`apply()` 会改 `node.active`，而 onShow 是引擎在 onEnable 里同步调的，
        //   在那里把节点关掉会当场触发一轮 onDisable（重入）；空格子的显隐由宿主的 setTask(null) 负责。
        if (this.cfg) this.apply();
    }

    protected onDispose(): void {
        // 后代节点走 offNodeEvent（节点销毁时 `node.off` 会炸，见 AGENTS.md）
        this.offNodeEvent(this.stateBtn?.node, Button.EventType.CLICK, this.onClickState, this);
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /**
     * 设置这一格要显示的任务。
     * @param cfg      任务配置（**null = 空格子**，整格收起）
     * @param state    当前状态（locked / active / claimable / claimed）
     * @param progress 当前进度（内部按目标数量钳制）
     */
    setTask(cfg: TaskCfg | null, state: TaskState, progress: number): void {
        this.cfg = cfg ?? null;
        this.state = state;
        this.progress = Math.max(0, progress || 0);
        this.apply();
    }

    /** 当前格子的任务 id（0 = 空） */
    getTaskId(): number {
        return this.cfg?.id ?? 0;
    }

    /** 当前格子是否可领奖（宿主判断"这一格能不能点"时也可问它） */
    isClaimable(): boolean {
        return this.state === 'claimable' && !!this.cfg;
    }

    /* ===================================================================
     * 内部：渲染
     * =================================================================== */

    private apply(): void {
        const cfg = this.cfg;
        if (!cfg) {
            this.node.active = false;
            return;
        }
        this.node.active = true;

        const count = TaskConfig.getCount(cfg);
        const progress = Math.min(this.progress, count);
        const done = progress >= count;
        const style = STATE_STYLE[this.state] ?? STATE_STYLE.active;

        if (this.titleLabel) {
            this.titleLabel.string = cfg.name ?? '';
            this.titleLabel.color = new Color().fromHEX(
                this.state === 'claimable' ? TITLE_COLOR_CLAIMABLE : TITLE_COLOR_NORMAL,
            );
        }
        if (this.descLabel) this.descLabel.string = cfg.desc ?? '';
        if (this.progressLabel) this.progressLabel.string = TaskConfig.getProgressText(cfg, progress);

        this.applyBar(done ? 1 : progress / count);
        this.applyReward(this.rewardExpNode, this.rewardExpLabel, cfg.reward_exp ?? 0);
        this.applyReward(this.rewardGoldNode, this.rewardGoldLabel, cfg.reward_gold ?? 0);
        this.applyState(style, cfg);
    }

    /** 进度条：填充宽度 = 满宽 × 比例（锚点在左，改宽度即从左往右涨） */
    private applyBar(ratio: number): void {
        if (!this.progressFill) return;
        if (!this.barWidthCached) {
            const bg = this.progressFill.parent?.getComponent(UITransform);
            this.barWidth = bg?.width ?? DEFAULT_BAR_WIDTH;
            this.barWidthCached = true;
        }
        const tf = this.progressFill.getComponent(UITransform);
        if (!tf) return;
        const w = Math.max(0, Math.min(1, ratio)) * this.barWidth;
        tf.setContentSize(w, tf.height);
    }

    /** 奖励格：值为 0 时整格收起（不同任务的奖励种类可能只有一种） */
    private applyReward(node: Node | null, label: Label | null, value: number): void {
        if (node) node.active = value > 0;
        if (label) label.string = `x${value}`;
    }

    /** 状态按钮：文案 + 底色 + 文字色 + 能否点击 */
    private applyState(style: { text: string; bg: string; labelColor: string }, cfg: TaskCfg): void {
        const canClaim = this.state === 'claimable';
        if (this.stateBtn) this.stateBtn.interactable = canClaim;

        const sprite = this.stateBtn?.getComponent(Sprite);
        if (sprite) sprite.color = new Color().fromHEX(style.bg);
        if (this.stateLabel) {
            this.stateLabel.string = this.state === 'locked'
                ? `Lv.${TaskConfig.getUnlockLevel(cfg)} 解锁`
                : style.text;
            this.stateLabel.color = new Color().fromHEX(style.labelColor);
        }
    }

    /** 点击状态按钮：只通知宿主（未完成/已领取时按钮本来就不可点） */
    private onClickState(): void {
        if (!this.isClaimable()) return;
        this.scope.emit(TaskScopeEvents.Claim, this.cfg.id);
    }

    /**
     * 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑）。
     * 子节点契约（与 `prefabs/ui/views/task/cmps/task_item_1.prefab` 一致）：
     *   title / desc / progress_bg/progress_fill / progress_text / reward_1[label] / reward_2[label] / btn_state[label]
     */
    private resolveRefs(): void {
        const n = this.node;
        this.titleLabel = this.titleLabel ?? n.getChildByName('title')?.getComponent(Label);
        this.descLabel = this.descLabel ?? n.getChildByName('desc')?.getComponent(Label);
        this.progressLabel = this.progressLabel ?? n.getChildByName('progress_text')?.getComponent(Label);
        this.progressFill = this.progressFill ?? n.getChildByPath('progress_bg/progress_fill');

        const reward1 = n.getChildByName('reward_1');
        const reward2 = n.getChildByName('reward_2');
        this.rewardExpNode = this.rewardExpNode ?? reward1;
        this.rewardGoldNode = this.rewardGoldNode ?? reward2;
        this.rewardExpLabel = this.rewardExpLabel ?? reward1?.getChildByName('label')?.getComponent(Label);
        this.rewardGoldLabel = this.rewardGoldLabel ?? reward2?.getChildByName('label')?.getComponent(Label);

        const btn = n.getChildByName('btn_state');
        this.stateBtn = this.stateBtn ?? btn?.getComponent(Button);
        this.stateLabel = this.stateLabel ?? btn?.getChildByName('label')?.getComponent(Label);

        if (!this.titleLabel || !this.stateBtn) {
            console.warn('[TaskItem] 子节点契约不完整（需要 title / btn_state）：', n.name);
        }
    }
}
