import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { type Ref } from 'db://assets/scripts/platform/reactivity';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { useBattleStore } from '../../../../../stores';
import { HeroItem } from './HeroItem';
import { StageScopeEvents, StageScopeKeys } from '../UiScopeKeys';
const { ccclass, property } = _decorator;

/** 刷新按钮可点 / 置灰时的配色（按钮底图是深色 Sprite，置灰就调亮它） */
const REFRESH_BTN_ENABLED_COLOR = new Color(255, 255, 255, 255);
const REFRESH_BTN_DISABLED_COLOR = new Color(124, 124, 124, 255);
/** 费用文字的两种颜色：够钱（原色）/ 不够钱（红） */
const COST_ENOUGH_COLOR = new Color(106, 105, 107, 255);
const COST_LACK_COLOR = new Color(255, 60, 60, 255);

/**
 * 英雄选择面板（内嵌在战斗预制件里的 UI 页面 → 继承 UIWidget，不走 UIManager）
 *
 * ── 职责边界（业务全在 `HeroSelect`（game/battle/HeroSelect.ts），本面板只管"摆"和"通知"）──
 *   · **渲染**：把注入的 `HeroSelectList`（本局候选）铺到 4 个 item 上
 *   · **置灰**：刷新按钮可用性 = 「金币 ≥ 刷新费用」或「还有广告免费刷新次数」；都不满足 → 置灰不可点
 *   · **通知**：点刷新 → `emit(HeroRefresh)`；关面板 → 写 `HeroSelectPanelVisible=false`
 *   · item 的点击由 item 自己 `emit(HeroPicked, heroId)` 冒泡到宿主，**不经过本面板**
 *
 * ── 通信（UIScope）──
 *   向上：`scope.emit`（宿主 `scope.on` 收到，转给 HeroSelect）
 *   页面级状态：宿主 provide 的若干 `Ref`（见 `StageScopeKeys`），面板只读 + 只写「显隐」这一个
 *   金币是**战斗真源的投影**（跨界面/跨层可读）→ 读 `useBattleStore().gold`
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

    battleStore = useBattleStore();

    /** 槽位上的 item 组件（首次刷新时缓存一次） */
    heroItems: HeroItem[] = [];

    /* 宿主注入的页面级状态（=`HeroSelect` 的 ref，场景在 onLoad 里 provide） */
    /** 本局候选英雄 id */
    private heroList: Ref<number[]> = null;
    /** 面板是否显示（面板只写它，节点显隐由持有节点的 HUD 统一写） */
    private panelVisible: Ref<boolean> = null;
    /** 刷新费用 / 剩余广告免费刷新次数 */
    private refreshCost: Ref<number> = null;
    private adFreeLeft: Ref<number> = null;

    protected onInit(): void {
        // 宿主在 onLoad 里 provide，所以这里（子组件的 onInit）注入得到
        this.heroList = this.inject<Ref<number[]>>(StageScopeKeys.HeroSelectList, null);
        this.panelVisible = this.inject<Ref<boolean>>(StageScopeKeys.HeroSelectPanelVisible, null);
        this.refreshCost = this.inject<Ref<number>>(StageScopeKeys.HeroSelectRefreshCost, null);
        this.adFreeLeft = this.inject<Ref<number>>(StageScopeKeys.HeroSelectAdFreeLeft, null);

        // 节点事件：一辈子只绑一次，onDispose 里成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Node.EventType.MOUSE_DOWN, this.closePanel, this);

        // watcher 交给作用域托管：面板隐藏时随 scope 暂停，销毁时自动停止
        if (this.heroList) {
            this.scope.watch(() => this.heroList.value, () => this.checkHeroList());
        } else {
            ezgame.warn("HeroSelectPanel 没注入到 HeroSelectList（不在 Scene_Game_Stage 子树下？），英雄列表不会刷新");
        }
        // 金币 / 费用 / 广告次数：任意一个变了都要重算刷新按钮的可用性
        this.scope.watch(
            [
                () => this.battleStore.gold,
                () => this.refreshCost?.value ?? 0,
                () => this.adFreeLeft?.value ?? 0,
            ],
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
        const heroList = this.heroList ? this.heroList.value : [];
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
     * 刷新按钮状态：金币够 → 可点（显示「刷新」+ 费用）；
     * 金币不够但还有广告免费次数 → 也可点（显示「看广告」）；两者都不行 → 置灰不可点。
     *
     * ⚠ 判据必须与 `HeroSelect.refresh()` 里的扣费逻辑**完全一致**，否则会出现"按钮能点但点了没反应"。
     */
    refreshRefreshButton() {
        const cost = this.refreshCost ? this.refreshCost.value : 0;
        const gold = this.battleStore.gold;
        const adLeft = this.adFreeLeft ? this.adFreeLeft.value : 0;

        const canPay = gold >= cost;
        const canAdRefresh = !canPay && adLeft > 0;
        const enabled = canPay || canAdRefresh;

        if (this.refreshBtnNode) {
            const btn = this.refreshBtnNode.getComponent(Button);
            if (btn) btn.interactable = enabled;
            const sprite = this.refreshBtnNode.getComponent(Sprite);
            if (sprite) sprite.color = enabled ? REFRESH_BTN_ENABLED_COLOR.clone() : REFRESH_BTN_DISABLED_COLOR.clone();
        }
        if (this.refreshBtnLabel) {
            this.refreshBtnLabel.string = canPay ? '刷新' : (canAdRefresh ? '看广告' : '刷新');
            this.refreshBtnLabel.color = enabled ? REFRESH_BTN_ENABLED_COLOR.clone() : REFRESH_BTN_DISABLED_COLOR.clone();
        }
        if (this.refreshGoldValueNode) {
            this.refreshGoldValueNode.string = `${cost}`;
            this.refreshGoldValueNode.color = canPay ? COST_ENOUGH_COLOR.clone() : COST_LACK_COLOR.clone();
        }
    }

    /** 点刷新：交给宿主（转给 `HeroSelect.refresh`：扣金币还是拉广告由它决定并同一套判据） */
    private onClickRefresh(): void {
        this.scope.emit(StageScopeEvents.HeroRefresh);
    }

    /** 关闭面板：只翻页面级开关，面板节点的显隐由持有节点的 HUD 统一处理 */
    closePanel() {
        if (this.panelVisible) {
            this.panelVisible.value = false;
        }
    }
}
