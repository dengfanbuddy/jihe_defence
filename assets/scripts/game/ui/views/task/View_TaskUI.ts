import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { DataCenter } from '../../../data';
import type { TaskType } from '../../../data/configs/TaskConfig';
import { TaskItem } from './TaskItem';
import { TaskScopeEvents } from './TaskScope';

const { ccclass, property } = _decorator;

/**
 * 页签两态 —— **与工程里另一个「2 个页签」的条同一套口径**
 * （`Cmp_FuncTabs` 的左侧一级菜单 / `Cmp_OuterRelics` 的遗物页子页签：
 * 选中 = 深板岩药丸底 + 白字，未选中 = 无底 + 深墨字）：
 *   · 选中底 `#5C676E` 就是风格预设里的 `c-ink-pill`（文档 §6「选中药丸整块高亮，不是只变文字色」）
 *   · 未选中底写的是**纸面底色**（`View_TaskUI.prefab` 的全屏底也是它）→ 观感上等于"没有底"，
 *     与遗物页那种"格子干脆不摆底图"一致。⚠ 哪天改了全屏底色，这里要一起改。
 */
const TAB_ACTIVE_BG = '#5C676E';
const TAB_ACTIVE_LABEL = '#FFFFFF';
const TAB_INACTIVE_BG = '#EFEEED';
const TAB_INACTIVE_LABEL = '#354047';

/**
 * View_TaskUI.ts — 任务界面（日任务 / 周任务）
 *
 * 分层（与项目其它界面一致）：
 *   · **规则与数据在数据层**：进度记录、周期重置、领奖发奖全在 `data/funcs/TaskData.ts`
 *     （奖励 = 账号经验 + 金币，由 `DataCenter.grantTaskReward` 发）。
 *   · **本视图只做宿主**：拿页签/列表节点、把「任务 + 状态 + 进度」下发到格子、
 *     把格子冒泡上来的 `TaskScopeEvents.Claim` 转交给 `TaskData.claim()`，然后刷新界面。
 *   · 格子（`TaskItem`）不认识数据层，只渲染 + 通知。
 *
 * 数据是响应式的（`TaskData` 继承 `DataModule` → `reactive`），所以这里用 `scope.watch`
 * 订阅一个「进度指纹」，任何地方上报进度 / 领奖 / 升级都会自动重刷，不需要手动广播。
 *
 * 组件挂载：预制件里没挂脚本时由本类在 `ensureItems()` / UIManager 里运行时补上
 * （`addComponent`），所有节点引用都按名字兜底解析，编辑器里不拖也能跑。
 */
@uiview({
    prefabPath: 'prefabs/ui/views/task/View_TaskUI',
    layer: ViewLayer[ViewLayer.View],
    single: true,
})
@ccclass('View_TaskUI')
export class View_TaskUI extends BaseView {

    @property(Button)
    backBtn: Button = null;
    @property(Button)
    dailyTabBtn: Button = null;
    @property(Button)
    weeklyTabBtn: Button = null;
    @property(Label)
    dailyTabLabel: Label = null;
    @property(Label)
    weeklyTabLabel: Label = null;
    /** 列表容器（scroll/view/content）：子节点 task_item_1..N 就是格子 */
    @property(Node)
    contentNode: Node = null;

    /** 列表格子（按 content 的子节点顺序，最多就这么多格） */
    private items: TaskItem[] = [];
    /** 当前页签 */
    private activeType: TaskType = 'daily';

    // ────────────── 生命周期（BaseView：init 一次 / show 每次 / close 关闭） ──────────────

    protected init(): void {
        this.resolveRefs();
        this.ensureItems();
        this.bindEvents();

        // 进度指纹：任何地方改了任务进度 / 领奖状态 / 账号等级 → 自动重刷列表
        this.scope.watch(() => this.progressFingerprint(), () => this.refreshList());
    }

    protected show(): void {
        // 每次打开都对齐一次周期（跨天/跨周的重置 + 每日登录任务）
        DataCenter.ins.taskData.ensurePeriod();
        this.refreshAll();
    }

    protected close(): void {
        // 不需要额外处理：watcher 随 scope 暂停，节点由 UIManager 缓存/销毁
    }

    // ────────────── 交互 ──────────────

    private bindEvents(): void {
        this.backBtn?.node.on(Button.EventType.CLICK, this.onClickBack, this);
        this.dailyTabBtn?.node.on(Button.EventType.CLICK, this.onClickDailyTab, this);
        this.weeklyTabBtn?.node.on(Button.EventType.CLICK, this.onClickWeeklyTab, this);
        // 格子只向上通知「点了领取」，真正领奖在这里
        this.scope.on(TaskScopeEvents.Claim, this.onClaim, this);
    }

    private onClickBack(): void {
        UIManager.ins.closeUI(View_TaskUI);
    }

    private onClickDailyTab(): void {
        this.switchTab('daily');
    }

    private onClickWeeklyTab(): void {
        this.switchTab('weekly');
    }

    private switchTab(type: TaskType): void {
        if (this.activeType === type) return;
        this.activeType = type;
        this.refreshAll();
    }

    /**
     * 领奖（宿主职责）：**先问数据层能不能领**，再按结果刷新。
     * 失败原因是数据层的判据（已领取 / 未完成 / 未解锁），界面不自己重算一遍。
     */
    private onClaim(taskId: number): void {
        const res = DataCenter.ins.taskData.claim(taskId);
        if (!res.ok) {
            ezgame.warn(`[任务] 领取失败：${res.reason}（task=${taskId}）`);
            this.refreshList();
            return;
        }
        ezgame.info(`[任务] 领取成功：+${res.exp} 账号经验 / +${res.gold} 金币`
            + (res.leveledUp ? `，账号升到 ${res.level} 级` : ''));
        this.refreshList();
    }

    // ────────────── 刷新 ──────────────

    private refreshAll(): void {
        this.applyTabs();
        this.refreshList();
    }

    private refreshList(): void {
        if (!this.items.length) return;
        const taskData = DataCenter.ins.taskData;
        // 格子数就是上限：配置里任务更多时，超出的不展示（想全展示就加格子）
        const list = taskData.getTasks(this.activeType, this.items.length);

        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            const cfg = list[i];
            if (!cfg) {
                item.setTask(null, 'active', 0); // 空格子：收起（content 上的 Layout 会自动重排）
                continue;
            }
            item.setTask(cfg, taskData.getState(cfg), taskData.getProgress(cfg));
        }
    }

    /** 页签两态：选中 = 深板岩药丸底 + 白字，未选中 = 无底（纸面底）+ 深墨字 */
    private applyTabs(): void {
        this.applyTab(this.dailyTabBtn, this.dailyTabLabel, this.activeType === 'daily');
        this.applyTab(this.weeklyTabBtn, this.weeklyTabLabel, this.activeType === 'weekly');
    }

    private applyTab(btn: Button, label: Label, active: boolean): void {
        if (!btn) return;
        // 关掉 Button 的 Color 过渡，底色完全由这里写 Sprite。
        // ⚠ 两种写法只能选一种：开着 COLOR 过渡时 Button 会用 normalColor 覆盖**同一节点上**的 Sprite
        //   （作者摆的两态色会被冲掉）；而 `transition = NONE` 之后 Button **再也不碰**颜色
        //   （`_applyTransition` 只在 COLOR/SPRITE/SCALE 三个分支里改目标，此时写 normalColor 是死代码）
        //   —— 所以关掉过渡之后，颜色的唯一写入方必须是本函数。与 `TaskItem.applyState` 同一套路。
        btn.transition = Button.Transition.NONE;
        const sprite = btn.getComponent(Sprite);
        if (sprite) sprite.color = new Color().fromHEX(active ? TAB_ACTIVE_BG : TAB_INACTIVE_BG);
        if (label) label.color = new Color().fromHEX(active ? TAB_ACTIVE_LABEL : TAB_INACTIVE_LABEL);
    }

    /**
     * 进度指纹 —— watcher 的订阅源：**只要它变了就重刷界面**。
     * 用「id:进度:状态」拼串而不是 deep watch：读到的字段就是真实依赖，改动一处也只刷一次。
     */
    private progressFingerprint(): string {
        const taskData = DataCenter.ins.taskData;
        const part = (type: TaskType): string => taskData.getTasks(type)
            .map(cfg => `${cfg.id}:${taskData.getProgress(cfg)}:${taskData.getState(cfg)}`)
            .join(',');
        return `${DataCenter.ins.playerInfo.data.level}|${part('daily')}|${part('weekly')}`;
    }

    // ────────────── 节点契约 ──────────────

    /** 按名字兜底解析节点（编辑器里没拖引用时用；契约见 View_TaskUI.prefab） */
    private resolveRefs(): void {
        const n = this.node;
        const topBar = n.getChildByName('top_bar');
        const tabBar = n.getChildByName('tab_bar');
        this.backBtn = this.backBtn ?? topBar?.getChildByName('btn_back')?.getComponent(Button);

        const daily = tabBar?.getChildByName('tab_daily');
        const weekly = tabBar?.getChildByName('tab_weekly');
        this.dailyTabBtn = this.dailyTabBtn ?? daily?.getComponent(Button);
        this.weeklyTabBtn = this.weeklyTabBtn ?? weekly?.getComponent(Button);
        this.dailyTabLabel = this.dailyTabLabel ?? daily?.getChildByName('label')?.getComponent(Label);
        this.weeklyTabLabel = this.weeklyTabLabel ?? weekly?.getChildByName('label')?.getComponent(Label);

        this.contentNode = this.contentNode ?? n.getChildByPath('scroll/view/content');
    }

    /**
     * 把 content 下的格子节点挂上 `TaskItem`（**没有改预制件**，与 `View_Game_Stage.setupSkillSlots` 同一套路）。
     * 想改成编辑器摆位：把 `TaskItem` 脚本拖到 task_item_* 上，这里会因为 `getComponent` 拿得到而跳过。
     */
    private ensureItems(): void {
        this.items = [];
        const content = this.contentNode;
        if (!content) {
            console.error('[View_TaskUI] 找不到列表容器 scroll/view/content，任务界面无法渲染');
            return;
        }
        for (const child of content.children) {
            const item = child.getComponent(TaskItem) ?? child.addComponent(TaskItem);
            this.items.push(item);
        }
        if (!this.items.length) {
            console.error('[View_TaskUI] 列表容器里没有格子节点（应至少有 task_item_1）');
        }
    }
}
