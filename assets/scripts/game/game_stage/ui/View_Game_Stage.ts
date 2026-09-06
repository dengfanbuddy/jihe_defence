import { _decorator, Button, Component, Label, Node, ProgressBar, resources, Sprite, SpriteFrame } from 'cc';
import BaseView from '../../../platform/ui/BaseView';
import { bindValue, uiview } from '../../../platform/ui/UIDecorator';
import UIMgr from '../../../platform/ui/UIMgr';
import { ViewLayer } from '../../../platform/ui/ViewInfo';
import { GlobalEventMgr } from '../../../platform/event/GlobalEventMgr';
import { EventKeys } from '../../common/EventKeys';
import { useBattleStore } from '../../stores';
import { BattleContext, EventBus } from '../../battle';
import { EventNames } from '../../battle/core/EventBus';
import { computed, watch, WatchHandle } from '../../../platform/reactivity';
import { UIComponent } from '../../../platform/ui/UIComponent';
import { Main } from '../../scene/Main';
import { Scene_Menu } from '../../scene/scene_prefab/Scene_Menu';

const { ccclass, property } = _decorator;

@ccclass('View_Game_Stage')
export class View_Game_Stage extends Component {



    /* ===== 场景节点 ===== */
    /* ===== 信息节点 ===== */
    @property(Label)
    info_name: Label = null;
    @property(Label)
    info_mode: Label = null;
    /* ===== 信息节点 ===== */
    @property(Label)
    progress_name: Label = null;
    @property(Label)
    progress_time: Label = null;
    @property(ProgressBar)
    progress_bar: ProgressBar = null;
    /* ===== 货币节点 ===== */
    @property(Label)
    money_gold_value: Label = null;
    @property(Label)
    money_kill_value: Label = null;

    /* ===== 角色信息节点 ===== */
    @property(Sprite)
    head_icon: Sprite = null;
    @property(Node)
    weapons_node: Node = null;
    @property(Label)
    hp_value: Label = null;
    @property(ProgressBar)
    hp_bar: ProgressBar = null;
    @property(Label)
    lv_value: Label = null;
    @property(Label)
    lv__exp_value: Label = null;
    @property(ProgressBar)
    lv_exp_bar: ProgressBar = null;

    @property(Node)
    heroSelectPanel: Node = null;
    @property(Node)
    heroSelectBtn: Node = null;

    @property(Node)
    store_btn: Node = null;

    @property(Node)
    pauseBtn: Node = null;
    @property(Node)
    exitBtn: Node = null;

    @property(Node)
    endNode: Node = null;

    @property(Node)
    endBtnNode: Node = null;

    battleStore = useBattleStore()
    private startSF: SpriteFrame = null;
    private pauseSF: SpriteFrame = null;
    ctx: BattleContext
    showSelectWatchHander: WatchHandle
    watchHandlers: WatchHandle[] = []
    onLoad() {

    }

    start() {
        resources.load("textures/common/pause/spriteFrame", SpriteFrame, (err, data) => {
            if (err) { console.error(err); return; }
            this.pauseSF = data;
        });
        resources.load("textures/common/start/spriteFrame", SpriteFrame, (err, data) => {
            if (err) { console.error(err); return; }
            this.startSF = data;
        });
    }

    unInit() {
        this.heroSelectBtn.off(Button.EventType.CLICK, this.openSelectHeroPanel, this)
        this.pauseBtn.off(Button.EventType.CLICK, this.pauseCheck, this)
        this.exitBtn.off(Button.EventType.CLICK, this.exit, this)
        this.showSelectWatchHander?.stop()
        this.ctx = null
        this.watchHandlers.forEach(handler => handler.stop())
        this.watchHandlers = []
    }
    init(ctx: BattleContext) {
        this.ctx = ctx
        this.progress_name.string = "选择英雄中"
        this.progress_time.node.active = false
        this.progress_bar.node.active = false
        this.endNode.active = false
        let showSelectWatchHander = watch(() => this.battleStore.showSelectHeroPanel, () => {
            if (!this.heroSelectPanel) return;
            this.heroSelectPanel.active = this.battleStore.showSelectHeroPanel;
        }, { immediate: true })
        this.watchHandlers.push(showSelectWatchHander)
        // HP / 最大生命 任意变化都刷新血条与数字（合并原来重复的两个 watch）
        const hpWatch = watch(
            [() => this.battleStore.hp, () => this.battleStore.maxHp],
            () => {
                const hp = Math.trunc(this.battleStore.hp)
                this.hp_value.string = `${hp}/${this.battleStore.maxHp}`
                this.hp_bar.progress = this.battleStore.hp / this.battleStore.maxHp
            },
            { immediate: true },
        )
        this.watchHandlers.push(hpWatch)
        let goldVWatch = watch(() => this.battleStore.gold, () => {
            this.money_gold_value.string = `${this.battleStore.gold}`
        }, { immediate: true })
        this.watchHandlers.push(goldVWatch)
        let killVWatch = watch(() => this.battleStore.kills, () => {
            this.money_kill_value.string = `${this.battleStore.kills}`
        }, { immediate: true })
        this.watchHandlers.push(killVWatch)
        // 局内英雄等级 / 经验（升级→属性成长，HUD 同步）
        const lvWatch = watch(
            [() => this.battleStore.level, () => this.battleStore.exp, () => this.battleStore.expToNext],
            () => {
                const lv = this.battleStore.level
                const exp = this.battleStore.exp
                const need = this.battleStore.expToNext
                if (this.lv_value) this.lv_value.string = `Lv.${lv}`
                if (this.lv__exp_value) this.lv__exp_value.string = `${Math.trunc(exp)}/${need}`
                if (this.lv_exp_bar && need > 0) this.lv_exp_bar.progress = Math.min(1, exp / need)
            },
            { immediate: true },
        )
        this.watchHandlers.push(lvWatch)
        //         let expVWatch = watch(() => this.battleStore.kills, () => {
        //     this.money_kill_value.string = `${this.battleStore.kills}`
        // }, { immediate: true })
        // this.watchHandlers.push(expVWatch)
        // this.watchData(() => this.battleStore.showSelectHeroPanel, () => {
        //     if (!this.heroSelectPanel) return;
        //     this.heroSelectPanel.active = this.battleStore.showSelectHeroPanel;
        // }, { immediate: true })
        this.heroSelectBtn.on(Button.EventType.CLICK, this.openSelectHeroPanel, this)

        this.pauseBtn.on(Button.EventType.CLICK, this.pauseCheck, this)
        this.exitBtn.on(Button.EventType.CLICK, this.exit, this)
        this.endBtnNode.on(Button.EventType.CLICK, this.exit, this)
        // 阶段/剩余时间改为响应式订阅 store（单一来源），取代 BATTLE_REMAINTIME 事件推送
        const remainWatch = watch(
            [() => this.battleStore.phase, () => this.battleStore.phaseRemainTime],
            () => this.updateProgress(),
        )
        this.watchHandlers.push(remainWatch)

    }


    updateProgress() {
        const stage = this.battleStore.phase
        const time = this.battleStore.phaseRemainTime
        if (stage == 0) {//准备阶段
            this.progress_time.node.active = true
            this.progress_name.string = "准备中"
            let remainTime = Math.ceil(time)
            let timeStr = remainTime < 10 ? `0${remainTime}` : `${remainTime}`
            this.progress_time.string = `00:${timeStr}`
            this.progress_bar.node.active = false
            return
        }
        if (stage < 5) {//4个阶段
            this.progress_bar.node.active = true
            this.progress_name.string = `阶段 ${stage}/4`
            const totalSec = Math.ceil(time)
            let minute = Math.floor(totalSec / 60)
            let sec = totalSec % 60
            let minuteStr = minute < 10 ? `0${minute}` : `${minute}`
            let secStr = sec < 10 ? `0${sec}` : `${sec}`
            let timeStr = `${minuteStr}:${secStr}`
            this.progress_time.string = timeStr
            this.progress_bar.progress = (300 - time) / 300
            return
        }
        //boss阶段
        this.progress_bar.node.active = true
        this.progress_name.string = `Boss`
        const totalSec = Math.ceil(time)
        let minute = Math.floor(totalSec / 60)
        let sec = totalSec % 60
        let minuteStr = minute < 10 ? `0${minute}` : `${minute}`
        let secStr = sec < 10 ? `0${sec}` : `${sec}`
        let timeStr = `${minuteStr}:${secStr}`
        this.progress_time.string = timeStr
        this.progress_bar.progress = (120 - time) / 120

    }


    update(deltaTime: number) {

    }

    bindContext(ctx: BattleContext, bind: boolean) {
        if (bind) {
            this.ctx = ctx
            return
        }
        this.ctx = null
    }
    showEnd(data:any){
        //面板数据更新
        this.endNode.active = true
    }
    exit() {
        //TODO 二次确认
        EventBus.emit(EventNames.BATTLE_EXIT, null);
    }
    pauseCheck() {
        this.battleStore.togglePause();   // 复用 store 已有方法
        console.log(this.battleStore.isPaused)
        const sprite = this.pauseBtn.getComponent(Sprite);
        if (!sprite) return;              // 空安全

        sprite.spriteFrame = this.battleStore.isPaused ? this.startSF : this.pauseSF;
    }

    openSelectHeroPanel() {
        console.log("show select hero panel")
        this.battleStore.showSelectHeroPanel = true;
    }
}


