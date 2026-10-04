import { _decorator, Button, Label, Node } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { applyRefreshButton, KILL_ICON_PATH } from '../RefreshButtonView';
import { ShopBuffItem } from './ShopBuffItem';
import { refreshButtonKey } from '../../../../../battle/RefreshGate';
import type { BuffShopVM } from '../../../../../battle/BuffShop';

const { ccclass, property } = _decorator;

/**
 * 击杀商店（Buff 商店）面板（内嵌在战斗 HUD 预制件里的 UI 页面 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 职责边界（业务全在 `BuffShop`（game/battle/BuffShop.ts），本面板只管"摆"和"通知"）──
 *   · **渲染**：把门面里的 `slots`（4 个摊位）铺到 item 上；空摊收起
 *   · **置灰**：刷新按钮可用性**不再自己算** —— 问门面 `buffShop.refreshGate()`（判据唯一真源）
 *   · **通知**：点刷新 → `emit(BuffShopRefresh)`；关面板 → 写门面的 `panelVisible=false`
 *   · 每个摊位的「买一层」由 item 自己 `emit(BuffShopBought, buffId)` 冒泡到宿主，**不经过本面板**
 *
 * ── 货币 = **击杀数**（不是金币）──
 *   刷新费与 Buff 价格都以击杀数计价，所以费用图标传 `KILL_ICON_PATH`（击杀数图标）；
 *   击杀数不够时会换成**广告图标** + 按钮文案「看广告」（由 `RefreshButtonView` 统一画）。
 *
 * 与遗物面板的差别：摊位是**可反复购买**的（层数封顶），所以没有"本次已选过"的置灰态 ——
 * 每格的可用性由 item 自己问门面（`stackOf / maxStackOf / nextPriceOf / canBuy`），买完成功会自动刷新。
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
    /** 刷新按钮上的文字（`refresh_btn/Label`）：击杀数够 = 刷新、不够但有广告 = 看广告 */
    @property(Label)
    refreshBtnLabel: Label = null;
    /** 关闭按钮（`pannel/close`） */
    @property(Node)
    closeBtnNode: Node = null;

    /** 摊位上的 item 组件（首次刷新时缓存一次） */
    private items: ShopBuffItem[] = [];

    /** 宿主注入的**功能门面**（=`BuffShop` 实例；场景在 onLoad 里 provide → onInit 注入得到） */
    private shop: BuffShopVM = null;

    protected onInit(): void {
        this.shop = this.inject<BuffShopVM>(StageScopeKeys.BuffShop, null);
        if (!this.shop) {
            ezgame.warn('[Buff商店面板] 没注入到 BuffShop 门面（不在 Scene_Game_Stage 子树下？），面板不会刷新');
        }

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

        // 节点事件：一辈子只绑一次，onDispose 成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);

        // watcher 交给 scope 托管
        this.scope.watch(() => this.shop?.slots.value, () => this.refreshItems());
        // 刷新按钮：watch **绘制指纹**（判据 + 费用），判据没变就不重画
        this.scope.watch(
            () => refreshButtonKey(this.shop?.refreshGate(), this.shop?.refreshCost.value ?? 0),
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

    /** 把 4 个摊位铺到 item 上（空摊收起；每格的层数/价格/置灰由 item 自己问门面） */
    private refreshItems(): void {
        const slots = this.shop ? this.shop.slots.value : [];
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].setItemInfo(Number(slots?.[i] ?? 0));
        }
    }

    /**
     * 刷新按钮的表现：判据来自 `BuffShop.refreshGate()`（**唯一真源**，与 `refresh()` 的准入同一份），
     * 本面板只负责把判据画到节点上（配色/文案的实现在 `RefreshButtonView`）。
     */
    private refreshRefreshButton(): void {
        applyRefreshButton(
            {
                btnNode: this.refreshBtnNode, btnLabel: this.refreshBtnLabel, costLabel: this.refreshCostLabel,
                // 刷新费是**击杀数**（不是金币）→ 费用图标换成击杀数图标（与 HUD 的 money/kill/icon 同一张图）
                costIconPath: KILL_ICON_PATH,
            },
            this.shop ? this.shop.refreshGate() : null,
            this.shop ? this.shop.refreshCost.value : 0,
        );
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
        if (this.shop) this.shop.panelVisible.value = false;
    }
}
