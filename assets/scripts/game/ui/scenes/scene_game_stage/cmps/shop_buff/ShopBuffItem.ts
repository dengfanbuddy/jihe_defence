import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { type Ref } from 'db://assets/scripts/platform/reactivity';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { useBattleStore } from '../../../../../stores';
import { ShopConfig } from '../../../../../data/configs/ShopConfig';
import { StageScopeEvents, StageScopeKeys } from '../UiScopeKeys';

const { ccclass, property } = _decorator;

/** 不可购买（已满级 / 金币不够 / 空摊）时的灰化色 */
const DISABLED_GREY = new Color(124, 124, 124, 255);

/**
 * 击杀商店（Buff 商店）里的**一个摊位**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有三件（业务全在 `BuffShop`（game/battle/BuffShop.ts），本组件不知道金币怎么扣、更不知道别的摊位）：
 *   ① 渲染：按 Buff id 查 kill_buffs.json 出名字 / 效果 / **当前层数与下一层价格**
 *   ② 通知：点击 → `scope.emit(BuffShopBought, buffId)`，能不能买、买完层数怎么涨由宿主决定
 *   ③ 表现：已满级 / 金币不够 → 置灰（item 自己按注入的层数与 store 的金币算，**只做展示判据**）
 *
 * 通信：读 `BuffShopStacks`（注入的层数）+ `useBattleStore().gold`；只向上 `emit`。
 *   → 层数一变（买成功）本 item 会自动重算价格与层数，不需要面板逐个通知。
 */
@ccclass('ShopBuffItem')
export class ShopBuffItem extends UIWidget {

    /** 图标（kill_buffs 暂无图标列，当前保留预制件占位图；配了图标再填这里） */
    @property(Sprite)
    icon: Sprite = null;
    /** Buff 名（`kill_buffs.name`） */
    @property(Label)
    nameLabel: Label = null;
    /** 效果 + 层数 + 价格（`per_desc` / `x/y 层` / `价格 n`） */
    @property(Label)
    descLabel: Label = null;
    /** 内容根节点：空摊时整块收起（按钮留在原地，靠 interactable 关掉点击） */
    @property(Node)
    contentNode: Node = null;
    /** 点击区（挂在摊位节点上的 Button）：点击 = 买一层；不可买时置灰 + interactable=false */
    @property(Button)
    buyBtn: Button = null;

    /** 当前摊位的 Buff id（0 = 空摊；非响应式字段，改完由 setItemInfo 内部显式刷一次表现） */
    buffId: number = 0;

    battleStore = useBattleStore();

    /** 宿主注入的「每个 Buff 的已购层数」（`BuffShop.stacks`） */
    private stacks: Ref<Record<number, number>> = null;
    /** 预制件里的原始颜色（首次使用时缓存，用于从灰化状态恢复） */
    private baseColors = new Map<string, Color>();

    protected onInit(): void {
        this.stacks = this.inject<Ref<Record<number, number>>>(StageScopeKeys.BuffShopStacks, null);
        if (!this.stacks) {
            ezgame.warn('ShopBuffItem 没注入到 BuffShopStacks（不在 Scene_Game_Stage 子树下？），层数与价格不会刷新');
        }
        this.buyBtn?.node.on(Button.EventType.CLICK, this.onClickItem, this);
        // 层数（买成功）或金币（够不够买下一层）一变 → 重算价格 / 层数 / 置灰
        this.scope.watch(
            [() => this.stacks?.value, () => this.battleStore.gold],
            () => this.refresh(),
        );
    }

    protected onShow(): void {
        // 每次面板打开都按当前状态复位一次（item 的 buffId 是普通字段，非响应式，watch 感知不到）
        this.refresh();
    }

    protected onDispose(): void {
        // buyBtn 是本节点上的组件（Component 自身会被 _destruct → `.node` 变 null），走 offNodeEvent 双重兜底
        this.offNodeEvent(this.buyBtn?.node, Button.EventType.CLICK, this.onClickItem, this);
    }

    /* ===================================================================
     * 对外：面板下发数据
     * =================================================================== */

    /** 设置摊位展示的 Buff（id ≤ 0 = 空摊 → 收起内容） */
    setItemInfo(buffId: number): void {
        this.buffId = buffId > 0 ? buffId : 0;
        this.refresh();
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 重算这个摊位的全部表现（层数 / 价格 / 是否可买） */
    private refresh(): void {
        const cfg = this.buffId > 0 ? ShopConfig.getKillBuff(this.buffId) : undefined;
        if (!cfg) {
            if (this.buffId > 0) ezgame.error(`[Buff商店] 未找到 Buff 配置：${this.buffId}`);
            this.applyContentVisible(false);
            this.applyBuyable(false);
            return;
        }

        const stack = this.stacks?.value?.[this.buffId] ?? 0;
        const maxStack = Math.max(1, cfg.max_stack ?? 1);
        const maxed = stack >= maxStack;
        const price = maxed ? 0 : ShopConfig.getKillBuffPrice(cfg, stack + 1);

        if (this.nameLabel) this.nameLabel.string = cfg.name ?? '';
        if (this.descLabel) {
            const lines = [cfg.per_desc ?? ''];
            lines.push(maxed ? `${stack}/${maxStack} 层（已满）` : `${stack}/${maxStack} 层 · 价格 ${price}`);
            this.descLabel.string = lines.filter((s) => !!s).join('\n');
        }

        this.applyContentVisible(true);
        this.applyBuyable(!maxed && this.battleStore.gold >= price);
    }

    /** 内容显隐：空摊 → 收起（按钮留在原地但不可点） */
    private applyContentVisible(visible: boolean): void {
        if (this.contentNode) this.contentNode.active = visible;
    }

    /**
     * 可买状态 + 灰化表现。
     * ⚠ 这里只是**展示判据**（层数/金币的同一套口径），真正扣钱与校验在 `BuffShop.buy` 里；
     *   点不动时按钮就 interactable=false，玩家点不出"买了没反应"。
     */
    private applyBuyable(canBuy: boolean): void {
        if (this.buyBtn) this.buyBtn.interactable = canBuy;

        const tint = (comp: Sprite | Label | null, key: string): void => {
            if (!comp) return;
            if (!this.baseColors.has(key)) this.baseColors.set(key, comp.color.clone());
            comp.color = canBuy ? this.baseColors.get(key).clone() : DISABLED_GREY.clone();
        };
        tint(this.icon, 'icon');
        tint(this.nameLabel, 'name');
        tint(this.descLabel, 'desc');
    }

    /** 点击：只负责"通知"，是否买得成、层数怎么涨全在宿主（`BuffShop.buy`） */
    private onClickItem(): void {
        if (this.buffId <= 0) return;
        this.scope.emit(StageScopeEvents.BuffShopBought, this.buffId);
    }
}
