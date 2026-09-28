import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { type Ref } from 'db://assets/scripts/platform/reactivity';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { useBattleStore } from '../../../../../stores';
import { StageScopeEvents, StageScopeKeys } from '../UiScopeKeys';
import { ShopBuffItem } from './ShopBuffItem';

const { ccclass, property } = _decorator;

/** 刷新按钮可点 / 置灰时的配色（按钮底图是深色 Sprite，置灰就调亮它） */
const REFRESH_BTN_ENABLED_COLOR = new Color(255, 255, 255, 255);
const REFRESH_BTN_DISABLED_COLOR = new Color(124, 124, 124, 255);
/** 费用文字的两种颜色：够钱（原色）/ 不够钱（红） */
const COST_ENOUGH_COLOR = new Color(106, 105, 107, 255);
const COST_LACK_COLOR = new Color(255, 60, 60, 255);

/**
 * 击杀商店（Buff 商店）面板（内嵌在战斗 HUD 预制件里的 UI 页面 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 职责边界（业务全在 `BuffShop`（game/battle/BuffShop.ts），本面板只管"摆"和"通知"）──
 *   · **渲染**：把注入的 `BuffShopSlots`（4 个摊位）铺到 item 上；空摊收起
 *   · **置灰**：刷新按钮可用性 = 「金币 ≥ 刷新费用」或「还有广告免费刷新次数」
 *   · **通知**：点刷新 → `emit(BuffShopRefresh)`；关面板 → 写 `BuffShopPanelVisible=false`
 *   · 每个摊位的「买一层」由 item 自己 `emit(BuffShopBought, buffId)` 冒泡到宿主，**不经过本面板**
 *
 * 与遗物面板的差别：摊位是**可反复购买**的（层数封顶），所以没有"本次已选过"的置灰态 ——
 * 每格的可用性由 item 自己按「层数 + 金币」算（层数从注入的 `BuffShopStacks` 读，买完成功会自动刷新）。
 */
@ccclass('ShopBuffPanel')
export class ShopBuffPanel extends UIWidget {

    /** 4 个摊位的父节点（`pannel/items`） */
    @property(Node)
    itemListNode: Node = null;
    /** 刷新费用数字（`pannel/refresh/value`） */
    @property(Label)
    refreshCostLabel: Label = null;
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

    /** 摊位上的 item 组件（首次刷新时缓存一次） */
    private items: ShopBuffItem[] = [];

    /* 宿主注入的页面级状态（=`BuffShop` 的 ref，场景在 onLoad 里 provide） */
    /** 4 个摊位的 Buff id（0 = 空摊） */
    private slots: Ref<number[]> = null;
    /** 面板显隐（面板只写它，节点显隐由持有节点的 HUD 统一写） */
    private panelVisible: Ref<boolean> = null;
    /** 刷新费用 / 剩余广告免费刷新次数 */
    private refreshCost: Ref<number> = null;
    private adFreeLeft: Ref<number> = null;

    protected onInit(): void {
        this.slots = this.inject<Ref<number[]>>(StageScopeKeys.BuffShopSlots, null);
        this.panelVisible = this.inject<Ref<boolean>>(StageScopeKeys.BuffShopPanelVisible, null);
        this.refreshCost = this.inject<Ref<number>>(StageScopeKeys.BuffShopRefreshCost, null);
        this.adFreeLeft = this.inject<Ref<number>>(StageScopeKeys.BuffShopAdFreeLeft, null);

        // 缓存 item（一次即可：摊位节点是预制件里摆死的 4 个）
        if (this.itemListNode) {
            this.itemListNode.children.forEach((node) => {
                const item = node.getComponent(ShopBuffItem);
                if (item) this.items.push(item);
            });
        }
        if (!this.items.length) {
            ezgame.warn('[Buff商店面板] items 子节点上没有 ShopBuffItem 组件，面板不会有内容');
        }
        if (!this.slots) {
            ezgame.warn('[Buff商店面板] 没注入到 BuffShopSlots（不在 Scene_Game_Stage 子树下？），面板不会刷新');
        }

        // 节点事件：一辈子只绑一次，onDispose 成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);

        // watcher 交给 scope 托管
        if (this.slots) this.scope.watch(() => this.slots.value, () => this.refreshItems());
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
        // 每次打开都按当前状态无条件刷一遍
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

    /** 把 4 个摊位铺到 item 上（空摊收起；每格的层数/价格/置灰由 item 自己按注入状态算） */
    private refreshItems(): void {
        const slots = this.slots ? this.slots.value : [];
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].setItemInfo(Number(slots?.[i] ?? 0));
        }
    }

    /**
     * 刷新按钮状态：金币够 → 可点（显示「刷新」+ 费用）；
     * 金币不够但还有广告免费次数 → 也可点（显示「看广告」）；两者都不行 → 置灰不可点。
     * ⚠ 判据必须与 `BuffShop.refresh()` 里的扣费逻辑完全一致。
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
        if (this.refreshCostLabel) {
            this.refreshCostLabel.string = `${cost}`;
            this.refreshCostLabel.color = canPay ? COST_ENOUGH_COLOR.clone() : COST_LACK_COLOR.clone();
        }
    }

    /* ===================================================================
     * 通知宿主（本面板不扣钱、不发货、不关自己的节点）
     * =================================================================== */

    /** 点刷新：交给宿主（转给 `BuffShop.refresh`：扣金币还是拉广告由它按同一套判据决定） */
    private onClickRefresh(): void {
        this.scope.emit(StageScopeEvents.BuffShopRefresh);
    }

    /** 点关闭：只翻页面级开关（面板节点显隐由持有节点的 HUD 统一写） */
    private onClickClose(): void {
        if (this.panelVisible) this.panelVisible.value = false;
    }
}
