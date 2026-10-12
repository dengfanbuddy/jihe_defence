import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { useBattleStore } from '../../../../../stores';
import { ShopConfig } from '../../../../../data/configs/ShopConfig';
import { primaryTag } from '../../../../../common/RelicTags';
import { formatNumber } from '../../../../../common/GoldText';
import { AtlasIcon } from '../../../../../common/AtlasIcon';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import type { BuffShopVM } from '../../../../../battle/BuffShop';

const { ccclass, property } = _decorator;

/** 不可购买（已满级 / 击杀数不够 / 空摊）时的灰化色 */
const DISABLED_GREY = new Color(124, 124, 124, 255);

/** 流派标签在预制件里的节点名（`content/tags`：图标上方那一行 12px 灰字） */
const TAGS_NODE_NAME = 'tags';

/**
 * 击杀商店（Buff 商店）里的**一个摊位**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有三件（业务全在 `BuffShop`（game/battle/BuffShop.ts），本组件不知道击杀数怎么扣、更不知道别的摊位）：
 *   ① 渲染：按 Buff id 查 kill_buffs.json 出名字 / 效果文案，**层数、上限、下一层价格、能不能买一律问门面**
 *   ② 通知：点击 → `scope.emit(BuffShopBought, buffId)`，能不能买、买完层数怎么涨由宿主决定
 *   ③ 表现：已满级 / 击杀数不够 → 置灰
 *
 * ⚠ 这里**曾经自己重算**层数上限与价格（`Math.max(1, cfg.max_stack ?? 1)`），而 `BuffShop.maxStackOf`
 *   的缺省是 `shop_constants.killBuffMaxStackDefault`（10）—— 表里一旦有行不写 `max_stack`，
 *   UI 会在第 1 层就显示"已满"，而 `buy()` 其实允许买到 10 层。现在口径只有 `BuffShop` 一处。
 *
 * 通信：读门面 `BuffShop`（层数 / 价格 / 可买性）+ `useBattleStore().killPoints`（**只用于触发重算**，
 *   击杀数够不够由 `canBuy()` 回答）；只向上 `emit`。
 *   → 层数一变（买成功）本 item 会自动重算价格与层数，不需要面板逐个通知。
 */
@ccclass('ShopBuffItem')
export class ShopBuffItem extends UIWidget {

    /** 图标（`kill_buffs.icon`，2026-11 起真有图；见 `applyIcon`） */
    @property(Sprite)
    icon: Sprite = null;
    /** Buff 名（`kill_buffs.name`） */
    @property(Label)
    nameLabel: Label = null;
    /** 效果 + 层数 + 价格（`per_desc` / `x/y 层` / `价格 n`） */
    @property(Label)
    descLabel: Label = null;
    /**
     * **流派标签**（`kill_buffs.tags[0]` 主标签，见 `common/RelicTags`）。
     *
     * 神器与遗物、技能共用同一套 8 个词（`RELIC_ARCHETYPES`），同一屏里三处并排，
     * 只有神器不写标签会让人以为"神器的流派另有一套"。
     * 表里 19 行**每行恰好 1 个标签**（只用到 8 个词里的 6 个），所以主标签就是全部，
     * 不存在"放不下几个"的取舍 —— 但仍走 `primaryTag` 与遗物/技能同一口径，
     * 免得日后表里补出多标签时这里成了唯一一个会溢出的地方（框 70px，4 汉字 @12px = 48px）。
     *
     * 预制件里是 `content/tags`（fs12 / `#999999` / 居中 / `overflow=NONE`）；
     * 没在编辑器里拖也能跑：`ensureTags()` 按名字兜底。
     */
    @property(Label)
    tagsLabel: Label = null;
    /** 内容根节点：空摊时整块收起（按钮留在原地，靠 interactable 关掉点击） */
    @property(Node)
    contentNode: Node = null;
    /** 点击区（挂在摊位节点上的 Button）：点击 = 买一层；不可买时置灰 + interactable=false */
    @property(Button)
    buyBtn: Button = null;

    /** 当前摊位的 Buff id（0 = 空摊；非响应式字段，改完由 setItemInfo 内部显式刷一次表现） */
    buffId: number = 0;

    battleStore = useBattleStore();

    /** 宿主注入的**功能门面**（=`BuffShop` 实例）：层数 / 上限 / 下一层价格 / 能不能买都问它 */
    private shop: BuffShopVM = null;
    /** 预制件里的原始颜色（首次使用时缓存，用于从灰化状态恢复） */
    private baseColors = new Map<string, Color>();
    /** 当前这张图标对应的 `icon` 路径（同一路径不重复走异步；换神器才重新取图） */
    private iconPath = '';

    protected onInit(): void {
        this.shop = this.inject<BuffShopVM>(StageScopeKeys.BuffShop, null);
        if (!this.shop) {
            ezgame.warn('ShopBuffItem 没注入到 BuffShop 门面（不在 Scene_Game_Stage 子树下？），层数与价格不会刷新');
        }
        this.buyBtn?.node.on(Button.EventType.CLICK, this.onClickItem, this);
        // 层数（买成功）或击杀数余额（够不够买下一层）一变 → 重算价格 / 层数 / 置灰
        this.scope.watch(
            [() => this.shop?.stacks.value, () => this.battleStore.killPoints],
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

    /** 重算这个摊位的全部表现（层数 / 价格 / 是否可买）—— 口径全部来自门面 `BuffShop` */
    private refresh(): void {
        const cfg = this.buffId > 0 ? ShopConfig.getKillBuff(this.buffId) : undefined;
        if (!cfg) {
            if (this.buffId > 0) ezgame.error(`[Buff商店] 未找到 Buff 配置：${this.buffId}`);
            this.applyContentVisible(false);
            this.applyBuyable(false);
            return;
        }

        // 层数 / 上限 / 下一层价格 / 能不能买：**问功能类**（唯一口径；这里不再自己重算一遍）
        //   maxStackOf 的缺省是配置项 killBuffMaxStackDefault，与 buy() 的封顶判断同源
        const stack = this.shop ? this.shop.stackOf(this.buffId) : 0;
        const maxStack = this.shop ? this.shop.maxStackOf(cfg) : 0;
        const price = this.shop ? this.shop.nextPriceOf(this.buffId) : 0;
        const maxed = maxStack > 0 && stack >= maxStack;

        if (this.nameLabel) this.nameLabel.string = cfg.name ?? '';
        // 图标：`kill_buffs.icon`（`textures/artifacts/<code>`，图集 `textures/artifacts/artifacts`）
        this.applyIcon(cfg.icon ?? '');
        // 流派标签：与遗物/技能同一套词表的**主标签**（`RelicTags` 是唯一口径）
        this.setTagsLabel(primaryTag(cfg.tags));
        if (this.descLabel) {
            const lines = [cfg.per_desc ?? ''];
            // 价格单位是**击杀数**（不是金币）→ 文案里写明，免得玩家以为是金币。
            // 价格走缩写口径（`formatNumber`）：神器价格按 `price_growth` 逐层涨（1.3~1.55），
            // 买深了就是四位数
            lines.push(maxed ? `${stack}/${maxStack} 层（已满）` : `${stack}/${maxStack} 层 · ${formatNumber(price)} 击杀`);
            this.descLabel.string = lines.filter((s) => !!s).join('\n');
        }

        this.applyContentVisible(true);
        this.applyBuyable(!!this.shop && this.shop.canBuy(this.buffId));
    }

    /** 内容显隐：空摊 → 收起（按钮留在原地但不可点） */
    private applyContentVisible(visible: boolean): void {
        if (this.contentNode) this.contentNode.active = visible;
    }

    /**
     * 按 `icon` 路径取图并写进 `icon` 槽（2026-11 补齐 —— 此前 `refresh()` **从不给图标赋图**，
     * 于是预制件里那张已退场的占位图（`fca27a57…`，全工程没有这个 uuid）就是运行时看到的东西，
     * 编辑器里画成洋红块）。
     *
     * 三条口径与遗物 / 技能格完全一致：
     *   · 加载走**全工程共用**的 `AtlasIcon.loadIconFrame`（图集本体 → 帧子资源 → 旧碎图三级降级 + 按路径缓存）；
     *   · **同一个 `icon` 路径不重复走异步** —— `refresh()` 会被「买了一层」「击杀数变了」反复调用，
     *     每次都重新 load 一遍是白费（`iconPath` 就是这道闸）；
     *   · 换摊位的瞬间**先清空**再等新图（否则上一层神器的图会短暂留在格子里，玩家会看成"买到了别的东西"）。
     *
     * 取不到图**不清空也不报错刷屏**：`AtlasIcon` 内部已按路径缓存失败结果、且三级降级都失败是
     * "配表填了不存在的路径"这类配置错误 —— 由 `docs/artifact-buff-icons/README.md` 的体检盯着配表，
     * 运行期这里安静地留空格（不去 `ezgame.error`，那会每次刷新商店刷一行）。
     */
    private applyIcon(path: string): void {
        if (!this.icon) return;
        if (path === this.iconPath) return;
        this.iconPath = path;
        if (!path) {
            this.icon.spriteFrame = null;
            return;
        }
        this.icon.spriteFrame = null;
        AtlasIcon.loadIconFrame(path).then((sf) => {
            // 异步回来时这一格可能已经换成别的神器了 → 只认"还在等这张图"的自己
            if (sf && this.icon?.isValid && this.iconPath === path) this.icon.spriteFrame = sf;
        });
    }

    /**
     * 可买状态 + 灰化表现。
     * ⚠ 这里只是**展示判据**（层数/击杀数的同一套口径），真正扣击杀数与校验在 `BuffShop.buy` 里；
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
        tint(this.ensureTags(), 'tags');
    }

    /** 标签 Label：优先用编辑器拖的引用，没拖就按名字 `content/tags` 找（同 `ShopRiItem.ensureTags` 的套路） */
    private ensureTags(): Label {
        if (this.tagsLabel?.isValid) return this.tagsLabel;
        const found = this.node.getChildByName('content')?.getChildByName(TAGS_NODE_NAME);
        this.tagsLabel = found?.getComponent(Label) ?? null;
        return this.tagsLabel;
    }

    /**
     * 写流派标签（空串 = 这行留白；配表没给标签时走这里）。
     * 没有标签可写时**不清空节点**：那一行的位置是排好的，藏节点会让名字/图标跳位。
     */
    private setTagsLabel(text: string): void {
        const label = this.ensureTags();
        if (label) label.string = text;
    }

    /** 点击：只负责"通知"，是否买得成、层数怎么涨全在宿主（`BuffShop.buy`） */
    private onClickItem(): void {
        if (this.buffId <= 0) return;
        this.scope.emit(StageScopeEvents.BuffShopBought, this.buffId);
    }
}
