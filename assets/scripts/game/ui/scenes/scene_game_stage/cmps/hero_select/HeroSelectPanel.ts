import { _decorator, Button, Label, Node } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { HeroItem } from './HeroItem';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { applyRefreshButton } from '../RefreshButtonView';
import { refreshButtonKey } from '../../../../../battle/RefreshGate';
import type { HeroSelectVM } from '../../../../../battle/HeroSelect';
const { ccclass, property } = _decorator;

/**
 * 英雄选择面板（内嵌在战斗预制件里的 UI 页面 → 继承 UIWidget，不走 UIManager）
 *
 * ── 职责边界（业务全在 `HeroSelect`（game/battle/HeroSelect.ts），本面板只管"摆"和"通知"）──
 *   · **渲染**：把门面里的 `candidates`（本局候选）铺到 4 个 item 上
 *   · **置灰**：刷新按钮可用性**不再自己算** —— 问门面 `heroSelect.refreshGate()`（判据唯一真源）
 *   · **通知**：点刷新 → `emit(HeroRefresh)`；关面板 → 写 `panelVisible=false`
 *   · item 的点击由 item 自己 `emit(HeroPicked, heroId)` 冒泡到宿主，**不经过本面板**
 *
 * ── 通信（UIScope）──
 *   向下：只 inject **一个** `HeroSelectVM` 门面（原来 inject 4 个裸 ref，拿不到规则只能重算一遍）
 *   向上：`scope.emit`（宿主 `scope.on` 收到，转给 HeroSelect）
 *   金币不再由本面板读 —— 它已经进了 `refreshGate()`（判据连同"金币够不够"一起算好了）
 *
 * ⚠ 本面板不再 provide「当前选中英雄」（那是 `HeroSelect.selectedId`，由宿主统一 provide），
 *   也不再发全局 `BATTLE_SELECT_HERO` 事件（改为 scope 事件 + 宿主转交，链路只有一层）。
 */
@ccclass('HeroSelectPanel')
export class HeroSelectPanel extends UIWidget {
    /** 4 个候选槽位的父节点（`pannel/items`） */
    @property(Node)
    heroItemListNode: Node = null;
    /** 刷新费用数字（`pannel/refresh/value`） */
    @property(Label)
    refreshGoldValueNode: Label = null;
    /** 刷新按钮（`pannel/refresh/refresh_btn`） */
    @property(Node)
    refreshBtnNode: Node = null;
    /** 刷新按钮上的文字（`refresh_btn/Label`）：金币够 = 刷新、不够但有广告 = 看广告 */
    @property(Label)
    refreshBtnLabel: Label = null;
    /** 关闭按钮（`pannel/close`） */
    @property(Node)
    closeBtnNode: Node = null;

    /** 槽位上的 item 组件（首次刷新时缓存一次） */
    heroItems: HeroItem[] = [];

    /** 宿主注入的**功能门面**（=`HeroSelect` 实例；场景在 onLoad 里 provide，所以 onInit 注入得到） */
    private heroSelect: HeroSelectVM = null;

    protected onInit(): void {
        this.heroSelect = this.inject<HeroSelectVM>(StageScopeKeys.HeroSelect, null);
        if (!this.heroSelect) {
            ezgame.warn('HeroSelectPanel 没注入到 HeroSelect 门面（不在 Scene_Game_Stage 子树下？），候选与刷新按钮都不会刷新');
        }

        // 节点事件：一辈子只绑一次，onDispose 里成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Node.EventType.MOUSE_DOWN, this.closePanel, this);

        // watcher 交给作用域托管：面板隐藏时随 scope 暂停，销毁时自动停止
        this.scope.watch(() => this.heroSelect?.candidates.value, () => this.checkHeroList());
        // 刷新按钮：watch **绘制指纹**（判据 + 费用），判据没变就不重画
        this.scope.watch(
            () => refreshButtonKey(this.heroSelect?.refreshGate(), this.heroSelect?.refreshCost.value ?? 0),
            () => this.refreshRefreshButton(),
        );
    }

    protected onShow(): void {
        // 每次显示都按当前状态刷一次：item 的 heroId 是普通字段（非响应式），它的变化不会触发 watch
        this.checkHeroList();
        this.refreshRefreshButton();
    }

    protected onDispose(): void {
        // 两个按钮都是后代节点：销毁时它们先被 _destruct()（字段清空），直接 off 会抛异常堵死销毁队列
        this.offNodeEvent(this.refreshBtnNode, Button.EventType.CLICK, this.onClickRefresh, this);
        this.offNodeEvent(this.closeBtnNode, Node.EventType.MOUSE_DOWN, this.closePanel, this);
    }

    /** 把候选英雄铺到 item 上（空位保持预制件原样，item 自己会拒绝 id ≤ 0 的点击） */
    checkHeroList() {
        // 首次调用：缓存 heroItemListNode 子节点上的 HeroItem 组件（只在有列表时缓存一次）
        if (this.heroItems.length == 0 && this.heroItemListNode) {
            this.heroItemListNode.children.forEach((node) => {
                const item = node.getComponent(HeroItem);
                if (item) this.heroItems.push(item);
            })
        }
        const heroList = this.heroSelect ? this.heroSelect.candidates.value : [];
        const count = Math.min(this.heroItems.length, heroList.length);
        for (let index = 0; index < count; index++) {
            const heroId = Number(heroList[index]);
            if (heroId > 0) {
                // selectType=0 普通获取（广告获取是 item 的展示态，选取规则在 HeroSelect 里）
                this.heroItems[index].setHeroInfo(heroId, 0);
            }
        }
    }

    /**
     * 刷新按钮的表现：判据来自 `HeroSelect.refreshGate()`（**唯一真源**，与 `refresh()` 的准入同一份），
     * 本面板只负责把判据画到节点上（配色/文案的实现在 `RefreshButtonView`）。
     */
    refreshRefreshButton() {
        applyRefreshButton(
            { btnNode: this.refreshBtnNode, btnLabel: this.refreshBtnLabel, costLabel: this.refreshGoldValueNode },
            this.heroSelect ? this.heroSelect.refreshGate() : null,
            this.heroSelect ? this.heroSelect.refreshCost.value : 0,
        );
    }

    /** 点刷新：交给宿主（转给 `HeroSelect.refresh`：扣金币还是拉广告由它决定并同一套判据） */
    private onClickRefresh(): void {
        this.scope.emit(StageScopeEvents.HeroRefresh);
    }

    /** 关闭面板：只翻页面级开关，面板节点的显隐由持有节点的 HUD 统一处理 */
    closePanel() {
        if (this.heroSelect) {
            this.heroSelect.panelVisible.value = false;
        }
    }
}
