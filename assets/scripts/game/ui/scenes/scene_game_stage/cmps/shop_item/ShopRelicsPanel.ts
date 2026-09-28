import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { type Ref } from 'db://assets/scripts/platform/reactivity';
import { useBattleStore } from '../../../../../stores';
import { StageScopeEvents, StageScopeKeys } from '../UiScopeKeys';
import { ShopRiItem } from './ShopRelicsItem';

const { ccclass, property } = _decorator;

/** 刷新按钮可点 / 置灰时的配色（按钮底图是深色 Sprite，置灰就调亮它） */
const REFRESH_BTN_ENABLED_COLOR = new Color(255, 255, 255, 255);
const REFRESH_BTN_DISABLED_COLOR = new Color(124, 124, 124, 255);
/** 费用文字的两种颜色：够钱（原色）/ 不够钱（红） */
const COST_ENOUGH_COLOR = new Color(106, 105, 107, 255);
const COST_LACK_COLOR = new Color(255, 60, 60, 255);

/**
 * 遗物商店面板（内嵌在战斗 HUD 预制件里的 UI 页面 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 职责边界（业务全在宿主 `Scene_Game_Stage`，本面板只管"摆"和"通知"）──
 *   · **渲染**：把注入的 `RelicSlots`（4 个遗物 id）铺到 4 个 item 上；空槽 / 已选走的槽位收起
 *   · **置灰**：刷新按钮的可用性 = 「金币 ≥ 刷新费用」**或**「还有广告免费刷新次数」；
 *     都不满足 → Button.interactable=false + 灰化，且点击无效
 *   · **通知**：点刷新 → `emit(RelicRefresh)`；点关闭 → 写页面级开关 `RelicPanelVisible=false`
 *     （面板节点的显隐由宿主统一写，面板自己不动自己的节点）
 *   · item 的点击由 item 自己 `emit(RelicPicked, id, viaAd)` 冒泡到宿主，**不经过本面板**
 *
 * ── 通信 ──
 *   向下：不用 provide（item 只上报，不需要共享选中态）
 *   向上：`scope.emit`（宿主 `scope.on` 收到）
 *   页面级状态：宿主 `provide` 的若干 `Ref`（见 `StageScopeKeys`），面板只读 + 只写「显隐」这一个
 *   金币是**战斗真源的投影**（跨界面/跨层可读）→ 读 `useBattleStore().gold`
 */
@ccclass('ShopRelicsPanel')
export class ShopRelicsPanel extends UIWidget {

    /** 4 个槽位的父节点（`pannel/items`） */
    @property(Node)
    itemListNode: Node = null;
    /** 刷新费用数字（`pannel/refresh/value`） */
    @property(Label)
    refreshGoldValueNode: Label = null;
    /** 刷新按钮（`pannel/refresh/refresh_btn`） */
    @property(Node)
    refreshBtnNode: Node = null;
    /** 刷新按钮上的文字（`pannel/refresh/refresh_btn/Label`）：金币够 = 刷新、不够但有广告 = 看广告 */
    @property(Label)
    refreshBtnLabel: Label = null;
    /** 关闭按钮（`pannel/close`） */
    @property(Node)
    closeBtnNode: Node = null;

    battleStore = useBattleStore();

    /** 槽位上的 item 组件（首次刷新时缓存一次） */
    private items: ShopRiItem[] = [];

    /* 宿主注入的页面级状态（场景在 onLoad 里 provide → 这里 onInit 注入得到） */
    /** 4 个槽位的遗物 id（0 = 空槽） */
    private slots: Ref<number[]> = null;
    /** 本次刷新是否已选过（已选 → 剩余槽位置灰） */
    private rollUsed: Ref<boolean> = null;
    /** 剩余槽位是否转为「看广告才能选」 */
    private adMode: Ref<boolean> = null;
    /** 本次刷新费用 */
    private refreshCost: Ref<number> = null;
    /** 剩余广告免费刷新次数 */
    private adFreeLeft: Ref<number> = null;
    /** 面板显隐（面板只写它，节点显隐由宿主写） */
    private panelVisible: Ref<boolean> = null;

    protected onInit(): void {
        this.slots = this.inject<Ref<number[]>>(StageScopeKeys.RelicSlots, null);
        this.rollUsed = this.inject<Ref<boolean>>(StageScopeKeys.RelicRollUsed, null);
        this.adMode = this.inject<Ref<boolean>>(StageScopeKeys.RelicAdMode, null);
        this.refreshCost = this.inject<Ref<number>>(StageScopeKeys.RelicRefreshCost, null);
        this.adFreeLeft = this.inject<Ref<number>>(StageScopeKeys.RelicAdFreeLeft, null);
        this.panelVisible = this.inject<Ref<boolean>>(StageScopeKeys.RelicPanelVisible, null);

        // 缓存 item（一次即可：槽位节点是预制件里摆死的 4 个）
        if (this.itemListNode) {
            this.itemListNode.children.forEach((node) => {
                const item = node.getComponent(ShopRiItem);
                if (item) this.items.push(item);
            });
        }
        if (!this.items.length) {
            ezgame.warn('[遗物面板] items 子节点上没有 ShopRiItem 组件，面板不会有内容');
        }
        if (!this.slots) {
            ezgame.warn('[遗物面板] 没注入到 RelicSlots（不在 Scene_Game_Stage 子树下？），面板不会刷新');
        }

        // 节点事件：一辈子只绑一次，onDispose 成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);

        // watcher 交给 scope 托管：面板隐藏时随 scope 暂停，销毁时自动回收
        if (this.slots) this.scope.watch(() => this.slots.value, () => this.refreshItems());
        if (this.rollUsed) this.scope.watch(() => this.rollUsed.value, () => this.refreshItems());
        if (this.adMode) this.scope.watch(() => this.adMode.value, () => this.refreshItems());
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
        // 每次打开都按当前状态无条件刷一遍（item 的 relicId 是普通字段，watch 补播不到）
        this.refreshItems();
        this.refreshRefreshButton();
    }

    protected onDispose(): void {
        // 两个按钮都是后代节点：销毁时它们先被 _destruct()（字段清空），直接 off 会抛异常堵死销毁队列
        this.offNodeEvent(this.refreshBtnNode, Button.EventType.CLICK, this.onClickRefresh, this);
        this.offNodeEvent(this.closeBtnNode, Button.EventType.CLICK, this.onClickClose, this);
    }

    /* ===================================================================
     * 刷新（宿主与各个 watcher 的公共出口）
     * =================================================================== */

    /** 把 4 个槽位铺到 item 上（空槽收起；本次已选过 → 剩余置灰或转「广告选取」） */
    private refreshItems(): void {
        const slots = this.slots ? this.slots.value : [];
        const used = !!this.rollUsed?.value;
        const adPick = used && !!this.adMode?.value;

        for (let i = 0; i < this.items.length; i++) {
            const id = Number(slots?.[i] ?? 0);
            // 已选过：普通模式下整格不可点；广告补选模式下剩余格变成「看广告可再选一个」
            this.items[i].setItemInfo(id, adPick ? 1 : 0);
            this.items[i].setSelectable(id > 0 && (!used || adPick));
        }
    }

    /**
     * 刷新按钮状态：金币够 → 可点（显示「刷新」+ 费用）；
     * 金币不够但还有广告免费次数 → 也可点（显示「看广告」）；两者都不行 → 置灰不可点。
     *
     * ⚠ 判据必须与宿主 `Scene_Game_Stage.onRelicRefresh` 里的扣费逻辑**完全一致**，
     *   否则会出现"按钮能点但点了没反应"（宿主拒绝）或"能免费却显示置灰"。
     */
    private refreshRefreshButton(): void {
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

    /* ===================================================================
     * 通知宿主（本面板不扣钱、不抽遗物、不关自己的节点）
     * =================================================================== */

    /** 点刷新：交给宿主判断「扣金币」还是「拉广告」，抽完把 4 个 id 写回 RelicSlots */
    private onClickRefresh(): void {
        this.scope.emit(StageScopeEvents.RelicRefresh);
    }

    /** 点关闭：只翻页面级开关（面板节点显隐由宿主统一写） */
    private onClickClose(): void {
        if (this.panelVisible) this.panelVisible.value = false;
    }
}
