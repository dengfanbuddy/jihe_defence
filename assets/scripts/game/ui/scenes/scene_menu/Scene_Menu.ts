import { _decorator, Button, Component, director, Label, Node } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { Scene_Game_Stage } from '../scene_game_stage/Scene_Game_Stage';
import { View_TaskUI } from '../../views/task/View_TaskUI';
import { DataCenter } from '../../../data';
import { ScopeKey } from 'db://assets/scripts/platform/ui/UIScope';
import { ref } from 'db://assets/scripts/platform/reactivity';
import { Cmp_Difficulty } from './cmps/Cmp_Difficulty';
import { DifficultyScopeEvents } from './cmps/DifficultyScope';
import { describeLevel } from '../../../common/DifficultyConfig';


const { ccclass, property } = _decorator;

/** 难度弹窗节点的名字（`@property` 没拖时的兜底；场景根节点的直接子节点） */
const DIFFICULTY_NODE_NAME = 'ui_difficulty';

/** 主界面「阶段模式」卡上的两个进度标签（`content/right/game/info` 下） */
const PROGRESS_PASSED_PATH = 'content/right/game/info/passed/value';
const PROGRESS_LAST_PATH = 'content/right/game/info/last/value';

@uiview({
    prefabPath: 'prefabs/ui/scenes/scene_menu/Scene_Menu', // 预制件路径
    layer: ViewLayer[ViewLayer.Scene], // 所属层级
    single: true,//是否是单例，单例的话只能有一个当前视图存在
})
@ccclass('Scene_Menu')
export class Scene_Menu extends BaseView {


    playerInfoNode:Node

    /** 成就红点（左侧页签 `achivement/icon/red_dot`，见 AchievementData.getClaimableCount） */
    private achieveRedDot: Node = null;


    /** 弹窗上的页面控制器（组件挂在 `ui_difficulty` 上，这里只是引用） */
    private difficulty: Cmp_Difficulty = null;
    /** 弹窗的两条向上事件是否已接（幂等守卫，见 `wireDifficultyEvents`） */
    private difficultyWired = false;
    /** 主界面「最高通过」/「上次玩过」两个数值标签 */
    private passedValueLabel: Label = null;
    private lastValueLabel: Label = null;


    //背包功能按钮
    @property(Node)
    bagBtn: Node = null;
    //任务功能按钮
    @property(Node)
    taskBtn: Node = null;
    //进入游戏功能按钮
    @property(Node)
    enterGameBtn: Node = null;

    /** 难度选择弹窗的节点（`ui_difficulty`；预制件里已拖好，没拖就按名字兜底解析） */
    @property(Node)
    difficultyNode: Node = null;

    start() {
        // 进入游戏：先弹**难度选择**，由弹窗「确定」再真正开战（见 enterGame）
        this.enterGameBtn?.on(Button.EventType.CLICK, this.onClickEnterGame, this);
        // 任务入口（bottom/left/task）：该节点上没有 Button，用节点触摸事件当点击
        // （想改成按钮：在预制件里给它加 Button，再把这里换成 Button.EventType.CLICK）
        this.taskBtn?.on(Node.EventType.TOUCH_END, this.onClickTask, this);
    }

    /** 打开任务界面（任务数据/领奖规则在 data/funcs/TaskData.ts，界面只是宿主） */
    private onClickTask(): void {
        UIManager.ins.showUI(View_TaskUI);
    }

    /* ===================================================================
     * 难度选择弹窗（宿主侧：持有节点 + 显隐 + 接弹窗冒泡上来的两件事）
     *
     * 分工：弹窗（`Cmp_Difficulty`）只渲染三态与选择，**不落盘、不跳场景**；
     *       落盘选择与进游戏都在这里 —— 那是"流程归谁管"的问题，不是弹窗的事。
     * =================================================================== */

    /**
     * 解析弹窗节点、拿到控制器组件。
     * 幂等（`init()` 与「开始游戏」各调一次）：**不管显隐**（显隐见 `openDifficultyPanel` / `closeDifficultyPanel`），
     * 组件在就复用（预制件里已经挂在 `ui_difficulty` 上了，`addComponent` 只是兜底）。
     */
    private setupDifficultyPanel(): void {
        this.difficultyNode = this.difficultyNode ?? this.node.getChildByName(DIFFICULTY_NODE_NAME);
        if (!this.difficultyNode) return;
        this.difficulty = this.difficulty ?? this.difficultyNode.getComponent(Cmp_Difficulty)
            ?? this.difficultyNode.addComponent(Cmp_Difficulty);
    }

    /**
     * 接弹窗冒泡上来的两件事（确定 / 关闭）。
     * 单独一步 + `difficultyWired` 守卫：它**不能**跟着节点解析一起判幂等 ——
     * 万一第一次解析节点时弹窗还没就位（拿不到节点），事件也不能就此永久不接。
     */
    private wireDifficultyEvents(): void {
        if (this.difficultyWired) return;
        this.difficultyWired = true;
        this.scope.on(DifficultyScopeEvents.Confirm, (level: number) => this.enterGame(level), this);
        this.scope.on(DifficultyScopeEvents.Close, () => this.closeDifficultyPanel(), this);
    }

    /** 点「开始游戏」：开弹窗（弹窗缺失时兜底成"直接按当前选择开战"，不让主界面卡死） */
    private onClickEnterGame(): void {
        this.setupDifficultyPanel();
        if (!this.difficultyNode || !this.difficulty) {
            ezgame.warn(`[难度选择] 弹窗不可用（预制件里没有 ${DIFFICULTY_NODE_NAME} 节点？）→ 按当前选择直接开战`);
            this.enterGame(DataCenter.ins.levelData.getSelectedLevel());
            return;
        }
        // 节点显隐由**持有节点的宿主**写（弹窗自己不动自己的 active）。
        // 打开这一下会触发弹窗的 onShow → 它按最新进度重铺/重画（不用宿主去喂数据）
        this.difficultyNode.active = true;
    }

    private closeDifficultyPanel(): void {
        if (this.difficultyNode && this.difficultyNode.isValid) this.difficultyNode.active = false;
    }

    /**
     * 真正开战（弹窗「确定」`DifficultyScopeEvents.Confirm`、以及弹窗缺失时的兜底都走这里）。
     *
     * ⚠ **顺序不能换**：先把选择的档位落盘（`selectLevel`），再 `showUI(Scene_Game_Stage)` ——
     *   战斗场景是在自己的 `show()` 里读这个档位的，反过来写就会让这一局用的是上一档的数值。
     */
    private enterGame(level: number): void {
        const data = DataCenter.ins.levelData;
        if (!data.selectLevel(level)) {
            // 理论上进不来（未解锁的格子点不动）；真发生了就退回当前合法选择，不让流程断掉
            ezgame.warn(`[难度选择] 档位 ${level} 未解锁，改用当前选择 ${data.getSelectedLevel()}`);
        }
        ezgame.info(`[难度选择] 开战：${describeLevel(data.getSelectedLevel())}`);
        this.closeDifficultyPanel();
        UIManager.ins.showUI(Scene_Game_Stage);
    }

    /**
     * 主界面「阶段模式」卡上的两个进度标签：**最高通过** = 已通关的最高档，**上次玩过** = 上次打的档。
     *
     * 这两个格子原来是预制件里的死文案（写死的 `99`），现在接上 `LevelData` ——
     * 数值来自数据层，本方法只做"读 → 写"。
     */
    private refreshLevelProgress(): void {
        const data = DataCenter.ins.levelData;
        this.passedValueLabel = this.passedValueLabel ?? this.node.getChildByPath(PROGRESS_PASSED_PATH)?.getComponent(Label);
        this.lastValueLabel = this.lastValueLabel ?? this.node.getChildByPath(PROGRESS_LAST_PATH)?.getComponent(Label);
        if (this.passedValueLabel) this.passedValueLabel.string = `${data.getClearedLevel()}`;
        if (this.lastValueLabel) this.lastValueLabel.string = `${data.getLastPlayedLevel()}`;
    }

    /**
     * 成就红点：左侧功能页签 `achivement/icon/red_dot` 的显隐。
     *
     * ⚠ **为什么放在常驻的 `Scene_Menu` 而不是成就页（`Cmp_Achievement`）**：
     * 成就页节点在没选中时是 `active=false`，挂在它上面的 watcher 会随 `onDisable` 暂停 ——
     * 红点就只在「已经打开了成就页」时才亮，而那正是最不需要它的时候。
     * 数据侧判据只有一条：`AchievementData.getClaimableCount() > 0`（有可领档就亮，领完自然灭）。
     */
    protected init(): void {
        this.achieveRedDot = this.node.getChildByPath('content/left/menus/contents/achivement/icon/red_dot');
        if (!this.achieveRedDot) {
            ezgame.warn('[成就] 找不到左侧页签红点节点（content/left/menus/contents/achivement/icon/red_dot）');
        }
        this.refreshAchieveRedDot(DataCenter.ins.achieveData.getClaimableCount());
        this.scope.watch(
            () => DataCenter.ins.achieveData.getClaimableCount(),
            (count: number) => this.refreshAchieveRedDot(count),
        );

        // 难度弹窗：解析节点 + 收它冒泡上来的两件事（确定 / 关闭），并**开局收起**
        // （预制件里这个节点是 active=true —— 作者编辑时方便；显隐归宿主管，见 open/closeDifficultyPanel）
        this.wireDifficultyEvents();
        this.setupDifficultyPanel();
        if (!this.difficultyNode) {
            ezgame.warn(`[难度选择] 预制件里找不到弹窗节点（${DIFFICULTY_NODE_NAME}）→ 点「开始游戏」将按当前选择直接开战`);
        } else {
            this.closeDifficultyPanel();
        }
        // 进度标签：局内通关会改 `cleared`，回到主界面时要跟着变（watch + show() 里各兜一次）
        this.refreshLevelProgress();
        this.scope.watch(
            [() => DataCenter.ins.levelData.data.cleared, () => DataCenter.ins.levelData.data.lastPlayed],
            () => this.refreshLevelProgress(),
        );
    }

    private refreshAchieveRedDot(count: number): void {
        if (this.achieveRedDot && this.achieveRedDot.isValid) {
            this.achieveRedDot.active = count > 0;
        }
    }

    onDestroy(): void {
        // 摘节点事件（事件挂在自己的节点上，退订要走 offNodeEvent 兜底，见 AGENTS.md）
        this.offNodeEvent(this.taskBtn, Node.EventType.TOUCH_END, this.onClickTask, this);
        this.offNodeEvent(this.enterGameBtn, Button.EventType.CLICK, this.onClickEnterGame, this);
        super.onDestroy();
    }

    protected show(): void {
        // 回到主界面（局内 `exit()` → showUI(Scene_Menu)）：弹窗一律是收起的，
        // 上一局的通关进度也要立刻反映到「最高通过 / 上次玩过」上
        this.closeDifficultyPanel();
        this.refreshLevelProgress();
    }

    protected close(): void {

    }


    static ScopeKey = {
        MenuSelect:"MenuSelect"
    }
}
