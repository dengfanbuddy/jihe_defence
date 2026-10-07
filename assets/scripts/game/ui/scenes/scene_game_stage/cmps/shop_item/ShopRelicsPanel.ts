import { _decorator, Button, Label, Node } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { applyRefreshButton } from '../RefreshButtonView';
import { ShopRiItem } from './ShopRelicsItem';
import { refreshButtonKey } from '../../../../../battle/RefreshGate';
import type { RelicShopVM, ShopSlotVM } from '../../../../../battle/RelicShop';

const { ccclass, property } = _decorator;

/**
 * 遗物商店面板（内嵌在战斗 HUD 预制件里的 UI 页面 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 职责边界（业务全在 `RelicShop`（game/battle/RelicShop.ts），本面板只管"摆"和"通知"）──
 *   · **渲染**：把门面里的 `slots`（4 个格子的状态，遗物 **或** 肉鸽技能）铺到 4 个 item 上；
 *     空槽 / 已选走的格子收起
 *   · **置灰**：刷新按钮可用性**不再自己算** —— 问门面 `shop.refreshGate()`（判据唯一真源）
 *   · **通知**：点刷新 → `emit(RelicRefresh)`；点关闭 → 写门面的 `panelVisible=false`
 *     （面板节点的显隐由宿主统一写，面板自己不动自己的节点）
 *   · item 的点击由 item 自己 `emit(RelicPicked, id, viaAd)` 冒泡到宿主，**不经过本面板**
 *
 * ── 通信 ──
 *   向下：不用 provide（item 只上报，不需要共享选中态）
 *   向上：`scope.emit`（宿主 `scope.on` 收到）
 *   页面级状态：只 inject **一个** `RelicShopVM` 门面（原来 inject 6 个裸 ref，拿不到规则只能自己重算）
 *   金币不再由本面板读 —— 已进 `refreshGate()`（判据连同"金币够不够"一起算好了）
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

    /** 槽位上的 item 组件（首次刷新时缓存一次） */
    private items: ShopRiItem[] = [];

    /** 宿主注入的**功能门面**（=`RelicShop` 实例；场景在 onLoad 里 provide → onInit 注入得到） */
    private shop: RelicShopVM = null;

    protected onInit(): void {
        this.shop = this.inject<RelicShopVM>(StageScopeKeys.RelicShop, null);
        if (!this.shop) {
            ezgame.warn('[遗物面板] 没注入到 RelicShop 门面（不在 Scene_Game_Stage 子树下？），面板不会刷新');
        }

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

        // 节点事件：一辈子只绑一次，onDispose 成对 off
        this.refreshBtnNode?.on(Button.EventType.CLICK, this.onClickRefresh, this);
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);

        // watcher 交给 scope 托管：面板隐藏时随 scope 暂停，销毁时自动回收
        this.scope.watch(() => this.shop?.slots.value, () => this.refreshItems());
        this.scope.watch(() => this.shop?.rollUsed.value, () => this.refreshItems());
        this.scope.watch(() => this.shop?.adMode.value, () => this.refreshItems());
        // 刷新按钮：watch **绘制指纹**（判据 + 费用），判据没变就不重画
        this.scope.watch(
            () => refreshButtonKey(this.shop?.refreshGate(), this.shop?.refreshCost.value ?? 0),
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

    /** 把 4 个格子铺到 item 上（空槽收起；本次已选过 → 剩余置灰或转「广告/券选取」） */
    private refreshItems(): void {
        const slots: ShopSlotVM[] = this.shop ? this.shop.slots.value : [];
        const used = !!this.shop?.rollUsed.value;
        const adPick = used && !!this.shop?.adMode.value;
        // 补选时的角标语义：背包里有广告券 → 「用 券」；没有 → 「看广告」。
        // ⚠ 判据只有一处（`RelicShop.refreshGate().viaTicket`），面板不自己读背包
        const ticketPick = adPick && !!this.shop?.refreshGate().viaTicket;

        for (let i = 0; i < this.items.length; i++) {
            const vm = slots?.[i] ?? null;
            const id = Number(vm?.id ?? 0);
            // 已选过：普通模式下整格不可点；广告/券补选模式下剩余格变成「免看广告再选一个」
            this.items[i].setItemInfo(vm, adPick ? (ticketPick ? 2 : 1) : 0);
            // selectable 由宿主给（本轮「拒发」的格子已在宿主侧置灰，例如技能槽全锁定）
            this.items[i].setSelectable(id > 0 && !!vm?.selectable && (!used || adPick));
        }
    }

    /**
     * 刷新按钮的表现：判据来自 `RelicShop.refreshGate()`（**唯一真源**，与 `refresh()` 的准入同一份），
     * 本面板只负责把判据画到节点上（配色/文案的实现在 `RefreshButtonView`）。
     */
    private refreshRefreshButton(): void {
        applyRefreshButton(
            { btnNode: this.refreshBtnNode, btnLabel: this.refreshBtnLabel, costLabel: this.refreshGoldValueNode },
            this.shop ? this.shop.refreshGate() : null,
            this.shop ? this.shop.refreshCost.value : 0,
        );
    }

    /* ===================================================================
     * 通知宿主（本面板不扣钱、不抽遗物、不关自己的节点）
     * =================================================================== */

    /** 点刷新：交给宿主判断「扣金币」还是「拉广告」，抽完把 4 个格子写回 `RelicShopVM.slots` */
    private onClickRefresh(): void {
        this.scope.emit(StageScopeEvents.RelicRefresh);
    }

    /** 点关闭：只翻页面级开关（面板节点显隐由宿主统一写） */
    private onClickClose(): void {
        if (this.shop) this.shop.panelVisible.value = false;
    }
}
