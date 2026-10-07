import { _decorator, Button, Color, Label, Node, Sprite, Tween, tween, UIOpacity, UITransform, Vec3 } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { AdMgr } from 'db://assets/scripts/platform/ad/AdMgr';
import { formatCount } from '../../../common/GoldText';
import { DataCenter, MallConfig, SHOP_REASON_TEXT } from '../../../data';
import { SHOP_CELL_NODE, ShopScopeEvents, type ShopAdCardVM, type ShopDailyVM, type ShopItemKey, type ShopPageVM } from './ShopScope';
import { buildShopPageVM, shopFingerprint } from './ShopVM';

const { ccclass, property } = _decorator;

/**
 * View_Shop.ts — 商城**全屏页**（宿主 UIManager 的普通视图层）
 *
 * ## 形态（2026-11 拍板）
 * `views/` 形态的 `BaseView` + `@uiview`（与 `View_TaskUI` 逐字同口径）：预制件
 * `prefabs/ui/views/shop/View_Shop`，`layer = View`，`single = true`，**返回自关**。
 * 入口有三个：主界面底部「商城」页签 + 顶栏 `head/coins/<格名>/add` 三颗 `+`（都在 `Scene_Menu` 里接）。
 * ⚠ 与另外两个全屏面板（`Scene_Menu/ui_difficulty`、`Scene_Menu/ui_hero_detail`）
 * **不同时可见**：那一对是场景内嵌节点，开商城前由 `Scene_Menu.onClickShop` 先收起它们。
 *
 * ## 分层（与项目其它界面一致）—— **这一屏自己就是宿主**
 *   · **规则与数据在数据层**：商品与门槛在 `mall_items.json` + `battle_constants.shop*`（→ `MallConfig`），
 *     计数/券/免广告卡在 `data/funcs/ShopData.ts`（存档），发奖只在 `DataCenter`。
 *   · **判据只在 VM 里算一次**：`ShopVM.buildShopPageVM()` 算出整页 VM，本视图照着画
 *     （`applyPage`），**不自己算**「还剩几次 / 能不能领」。
 *   · **本视图负责编排**：点格 → 问 `DataCenter.canUseShopAd` → `AdMgr.showRewardVideo` →
 *     拿到 `true` 才 `DataCenter.grantShopItem` → 飘字 + 重刷。⚠ 广告返回 `false` 时
 *     **不发奖、不扣次数**，只给一行中文提示（`AdMgr` 的既定语义，见 `platform/ad/AdMgr.ts` 文件头）。
 *   · ⚠ **为什么宿主不是 `Scene_Menu`**：`UIScope.emit` 只沿 `node.parent` 向上、不跨 UIManager 的层节点
 *     （`views` 与 `scenes` 是兄弟），页面的事件到不了 `Scene_Menu` 的作用域 —— 详见 `./ShopScope` 文件头。
 *
 * ## 数据是响应式的
 * `ShopData` 继承 `DataModule`（`reactive` + 自动落盘），所以本视图在 `init()` 里订阅一个
 * 「页面指纹」（`shopFingerprint`）：看广告、领补给、领卡、英雄升级花掉经验……任何地方改了数据
 * 都会自动重刷，不需要手动广播（与 `View_TaskUI.progressFingerprint` 同一套路）。
 *
 * 组件挂载：预制件里没挂脚本时由 `UIManager.showUI` 运行时 `addComponent`，
 * 所有节点引用都按名字兜底解析（编辑器里不拖也能跑）。
 */
@uiview({
    prefabPath: 'prefabs/ui/views/shop/View_Shop',
    layer: ViewLayer[ViewLayer.View],
    single: true,
})
@ccclass('View_Shop')
export class View_Shop extends BaseView {

    @property(Button)
    backBtn: Button = null;
    /** 每日补给的**唯一主按钮**（全屏页只有这一颗实心按钮） */
    @property(Button)
    claimBtn: Button = null;
    @property(Label)
    claimLabel: Label = null;
    @property(Label)
    resGoldLabel: Label = null;
    @property(Label)
    resExpLabel: Label = null;
    @property(Label)
    dailyGoldLabel: Label = null;
    @property(Label)
    dailyExpLabel: Label = null;
    @property(Label)
    streakLabel: Label = null;
    @property(Node)
    streakDotsNode: Node = null;
    @property(Label)
    resetLabel: Label = null;
    /** 六个广告商品格的容器（`ad_list/view/content` —— `ad_list` 那一区是竖直滚动列表，见 `resolveRefs`） */
    @property(Node)
    cellsRoot: Node = null;
    @property(Label)
    adCardSubLabel: Label = null;
    @property(Label)
    adCardHintLabel: Label = null;
    @property(Node)
    adCardFillNode: Node = null;
    @property(Button)
    adCardBtn: Button = null;
    @property(Label)
    adCardBtnLabel: Label = null;
    @property(Label)
    adCardActiveLabel: Label = null;
    @property(Label)
    ledgerLabel: Label = null;
    /** 底部那行说明（「看完一段视频即可领取 · 每天 0 点重置」）—— 领不到时**临时**借它给一行中文提示 */
    @property(Label)
    ledgerRuleLabel: Label = null;
    /** 领取成功的飘字（静置 `active=false`，见 `playRewardFly`） */
    @property(Node)
    rewardFly: Node = null;

    /** 主按钮两态色（README §2.1 / tokens：可领 = `c-accent-action`，已领 = `c-disabled-pill`） */
    private static readonly CLAIM_ENABLED_BG = '#3F9E9B';
    private static readonly CLAIM_DISABLED_BG = '#B9C1C1';
    /** 连续登录的 7 个点：已过 = `c-accent-400`，未到 = `c-ink-200` */
    private static readonly DOT_ON = '#70ACB3';
    private static readonly DOT_OFF = '#D8D8D8';
    /** 免广告卡「领取」两态字色：可领 = 正文墨色，未攒满 = 次要灰（环只描边不能染色，见 tokens `c-accent-ring`） */
    private static readonly ADCARD_BTN_ON = '#445054';
    private static readonly ADCARD_BTN_OFF = '#999999';
    /** 进度条满宽 = `ad_progress/pbar_bg` 的宽度（填充条按比例改宽，锚点在左边） */
    private static readonly PBAR_FULL_WIDTH = 330;
    /** 连续登录阶梯：满 7 天（README §2.1） */
    private static readonly STREAK_DAYS = 7;
    /** 提示行停留时长（秒） */
    private static readonly HINT_SECONDS = 2;

    /** 商品格：key → 格子节点 + 它的四个标签 + 点击回调（退订要用同一个引用） */
    private cells = new Map<ShopItemKey, {
        node: Node;
        nameLabel: Label;
        amountLabel: Label;
        subLabel: Label;
        countLabel: Label;
        onClick: () => void;
    }>();
    /** 飘字的复位位置（预制件里摆好的位置，每次播完回到这里） */
    private rewardFlyHome: Vec3 = null;
    private rewardFlyOpacity: UIOpacity = null;
    /** 底部说明行的原文（提示行借它显示 2 秒后要还回去） */
    private ledgerRuleHome = '';
    /** 提示行的序号：连点两次时只让最后一次负责还原（否则第一次的定时器会提前还原） */
    private hintSeq = 0;
    /** 免广告卡上一帧是否生效中（生效↔过期 的切换要整页重画：进度区与按钮会整块换掉） */
    private adCardWasActive = false;
    /** 广告正在拉起（防连点：`AdMgr` 也会拒并发，这里只是少打几条日志） */
    private adBusy = false;

    // ────────────── 生命周期（BaseView：init 一次 / show 每次 / close 关闭） ──────────────

    protected init(): void {
        this.resolveRefs();
        this.bindEvents();

        // 页面指纹：任何地方改了金币/经验/次数/券/卡/图鉴进度 → 自动重刷整页
        this.scope.watch(() => shopFingerprint(), () => this.refresh());
    }

    protected show(): void {
        // 跨天打开商城：先把「今日广告次数 / 每格今日次数」清掉再画
        DataCenter.ins.shopData.ensurePeriod();
        this.refresh();
        // 两个倒计时（「距重置」/「免广告生效中 · 剩」）每秒钟自己走
        this.schedule(this.tickClock, 1);
    }

    protected close(): void {
        this.unschedule(this.tickClock);
        this.stopRewardFly();
    }

    // ────────────── 交互（页面只上报，处理在同文件的三个 onXxx 里） ──────────────

    private bindEvents(): void {
        this.backBtn?.node.on(Button.EventType.CLICK, this.onClickBack, this);
        this.claimBtn?.node.on(Button.EventType.CLICK, this.onClickClaimFree, this);
        this.adCardBtn?.node.on(Button.EventType.CLICK, this.onClickClaimAdCard, this);
        // 商品格在预制件里是**纯 Sprite 节点**（没有 Button，与主界面顶栏那三格同一情形）→ 走节点触摸。
        // 回调存进 `cells`：退订要用**同一个引用**（`onDestroy` 里逐个 offNodeEvent）。
        for (const [key, cell] of this.cells) {
            cell.onClick = () => this.scope.emit(ShopScopeEvents.BuyWithAd, key);
            cell.node.on(Node.EventType.TOUCH_END, cell.onClick, this);
        }

        // 三个向上事件**由本页自己接**（页面就是宿主，见文件头说明）：
        // 这是全页唯一处理流程的地方，别在别处再接一份（一次点击会被处理两次）
        this.scope.on(ShopScopeEvents.ClaimFree, this.onClaimFree, this);
        this.scope.on(ShopScopeEvents.BuyWithAd, this.onBuyWithAd, this);
        this.scope.on(ShopScopeEvents.ClaimAdCard, this.onClaimAdCard, this);
    }

    /** 返回是**页面自己的事**（views 形态：UIManager 关掉自己并进缓存，宿主不需要知道） */
    private onClickBack(): void {
        UIManager.ins.closeUI(View_Shop);
    }

    private onClickClaimFree(): void {
        this.scope.emit(ShopScopeEvents.ClaimFree);
    }

    private onClickClaimAdCard(): void {
        this.scope.emit(ShopScopeEvents.ClaimAdCard);
    }

    /**
     * 领每日补给（一天一次、不看广告）。判据与数额都在数据层：
     * 失败原因是 `DataCenter` 给的（今天领过 / 没配表），界面只把它翻译成一行中文。
     */
    private onClaimFree(): void {
        const res = DataCenter.ins.claimShopDailyGift();
        if (!res.ok) {
            this.flashHint(SHOP_REASON_TEXT[res.reason] ?? '现在领不了');
            return;
        }
        ezgame.info(`[商城] 每日补给：${res.granted.map(l => l.text).join(' / ')}`);
        this.playRewardFly(res.flyText);
        this.refresh();
    }

    /**
     * 点某个广告商品格：**先看次数够不够**（`DataCenter.canUseShopAd`）→ 拉广告 →
     * **只有拿到 `true` 才发奖**（`AdMgr` 未接 SDK / 中途关闭都返回 `false`，那就什么都不发生）。
     */
    private onBuyWithAd(key: ShopItemKey): void {
        if (this.adBusy) return;

        const dc = DataCenter.ins;
        const check = dc.canUseShopAd(key);
        if (!check.ok) {
            this.flashHint(SHOP_REASON_TEXT[check.reason] ?? '现在领不了');
            return;
        }

        this.adBusy = true;
        AdMgr.inst.showRewardVideo(MallConfig.getPlacement(key)).then((watched: boolean) => {
            this.adBusy = false;
            // 广告是全屏原生层，播完可能已经过去很久（页面可能被关掉甚至销毁）——先确认自己还活着
            if (!this.node || !this.node.isValid) return;

            if (!watched) {
                // ⚠ 不发奖、不扣次数：`AdMgr` 的兜底语义就是"没有真 SDK = 没有广告 = 不发奖励"
                this.flashHint(AdMgr.inst.hasProvider ? '看完视频才能领取' : '广告暂不可用');
                return;
            }

            const res = dc.grantShopItem(key);
            if (!res.ok) {
                this.flashHint(SHOP_REASON_TEXT[res.reason] ?? '发放失败');
                return;
            }
            ezgame.info(`[商城] ${key}：${res.granted.map(l => l.text).join(' / ')}`);
            this.playRewardFly(res.flyText, this.cells.get(key)?.node);
            this.refresh();
        });
    }

    /** 领免广告卡（攒满累计观看 → 换 N 小时免广告） */
    private onClaimAdCard(): void {
        const res = DataCenter.ins.claimAdCard();
        if (!res.ok) {
            this.flashHint(SHOP_REASON_TEXT[res.reason] ?? '现在领不了');
            return;
        }
        const hours = MallConfig.getAdCardHours();
        ezgame.info(`[商城] 免广告卡生效 ${hours} 小时（到 ${new Date(res.activeUntil).toLocaleString()}）`);
        // 这一件不是"数字变多"，飘字反而看不懂（框也放不下"免广告生效 24 小时"）→ 不飘字，
        // 靠 `label_active`（「免广告生效中 · 剩 hh:mm:ss」）与按钮整颗收起回答"变了"
        this.refresh();
    }

    // ────────────── 渲染（唯一入口：整页 VM） ──────────────

    /** 按当前数据重算一份 VM 并画上去（数据一变 watcher 也会调它） */
    private refresh(): void {
        this.applyPage(buildShopPageVM());
    }

    /**
     * 把一份整页 VM 画到界面上 —— **页面唯一的刷新入口**（`refresh()` 与外部都能调）。
     * ⚠ 文案口径：`vm.daily.gold` / `vm.daily.heroExp` 已经是**乘完连续登录倍数**的数，
     *   这里直接显示，**不画**「200 × 1.5」（README §2.1）。
     */
    public applyPage(vm: ShopPageVM): void {
        if (!vm) return;
        this.applyResBar(vm);
        this.applyDaily(vm.daily);
        this.applyCells(vm);
        this.applyAdCard(vm.adCard, vm.adLimit);
        if (this.ledgerLabel) {
            this.ledgerLabel.string = `今日广告 ${vm.adUsedToday}/${vm.adLimit}`;
        }
    }

    /** 顶部两条读数（金币用千分位原数：要能跟后面的数字对账，不用 `k` 缩写） */
    private applyResBar(vm: ShopPageVM): void {
        if (this.resGoldLabel) this.resGoldLabel.string = formatCount(vm.resBar.gold);
        if (this.resExpLabel) this.resExpLabel.string = formatCount(vm.resBar.heroExp);
    }

    /**
     * 每日补给块（F1）。两态就是**主按钮的两态**：
     * 可领 = 青绿实心「免费领取」；已领 = 灰药丸「明天再来」（倒计时保留）。
     */
    private applyDaily(vm: ShopDailyVM): void {
        if (this.dailyGoldLabel) this.dailyGoldLabel.string = `金币 ${formatCount(vm.gold)}`;
        if (this.dailyExpLabel) this.dailyExpLabel.string = `通用英雄经验 ${formatCount(vm.heroExp)}`;
        if (this.streakLabel) {
            this.streakLabel.string = `连续登录 ${vm.streakDays} 天 · 今日 ×${vm.streakMul}`;
        }
        this.applyStreakDots(vm.streakDays);
        if (this.resetLabel) this.resetLabel.string = `距重置 ${formatClock(vm.resetInSec)}`;

        if (this.claimLabel) this.claimLabel.string = vm.claimed ? '明天再来' : '免费领取';
        if (this.claimBtn) {
            this.claimBtn.interactable = !vm.claimed;
            // Button 的过渡是 SCALE（tokens.buttonStates），所以它**不碰颜色** —— 颜色的唯一写入方是本行
            const bg = this.claimBtn.getComponent(Sprite);
            if (bg) bg.color = new Color().fromHEX(vm.claimed
                ? View_Shop.CLAIM_DISABLED_BG : View_Shop.CLAIM_ENABLED_BG);
        }
    }

    /** 连续登录的 7 个点：`streakDays` 之前的点亮（`dot_1..dot_7`，预制件里已摆好） */
    private applyStreakDots(streakDays: number): void {
        if (!this.streakDotsNode) return;
        for (let i = 0; i < View_Shop.STREAK_DAYS; i++) {
            const dot = this.streakDotsNode.getChildByName(`dot_${i + 1}`);
            const sp = dot?.getComponent(Sprite);
            if (sp) sp.color = new Color().fromHEX(i < streakDays ? View_Shop.DOT_ON : View_Shop.DOT_OFF);
        }
    }

    /**
     * 六个广告格：商品名 / 数量 / 副标题 / 「今日 N/M」四行全部**照 VM 写**。
     *
     * ⚠ 前两行（`name` / `amountText`）原来写死在预制件里（样例文案），现在改成配表下发 ——
     *   这样"格子上写的数"与"真正发多少"是同一份数据（`mall_items.json`），
     *   不会出现改了配表数量、界面还写着旧数字的情况。VM 里为空 = 保持预制件文案不动。
     * 灰态按决策不画（README §3.4）：次数用完只体现在 `今日 N/M` 上，原因由底部提示行回答。
     */
    private applyCells(vm: ShopPageVM): void {
        for (const cell of vm.cells) {
            const view = this.cells.get(cell.key);
            if (!view) continue;
            if (view.nameLabel && cell.name) view.nameLabel.string = cell.name;
            if (view.amountLabel && cell.amountText) view.amountLabel.string = cell.amountText;
            if (view.subLabel && cell.sub) view.subLabel.string = cell.sub;
            if (view.countLabel) {
                view.countLabel.string = cell.dailyLimit > 0
                    ? `今日 ${cell.usedToday}/${cell.dailyLimit}`
                    : `今日 ${cell.usedToday}`;
            }
        }
    }

    /**
     * 免广告卡（累计观看换 24 小时免广告，数值口径见 README §2.3）。
     *
     * 三态（**生效中只显示"还剩多久"**，不再显示进度条）：
     *   · 生效中 → 隐藏进度区，显示 `label_active`，按钮整颗收起（这一屏此刻没有可做的事）；
     *   · 可领   → 环 + 深墨字「领取」，`interactable = true`；
     *   · 未攒满 → 环 + 次灰字「未攒满」，`interactable = false`。
     * ⚠ 环（`rect_board_rd_20`）是**烤进贴图的青绿、不能染色**（`Sprite.color` 乘上去会发脏），
     * 所以"不可点"只回答在**字色**上，不去染环。
     */
    private applyAdCard(vm: ShopAdCardVM, adLimit: number): void {
        const active = vm.activeLeftSec > 0;
        this.adCardWasActive = active;
        if (this.adCardActiveLabel) {
            this.adCardActiveLabel.node.active = active;
            if (active) this.adCardActiveLabel.string = `免广告生效中 · 剩 ${formatClock(vm.activeLeftSec)}`;
        }
        if (this.adCardSubLabel) this.adCardSubLabel.node.active = !active;
        if (this.adCardHintLabel) this.adCardHintLabel.node.active = !active;
        // 生效中就连进度条整条收起（轨道与填充是一对，别只藏填充）
        const pbar = this.adCardFillNode?.parent;
        if (pbar) pbar.active = !active;

        if (!active) {
            if (this.adCardSubLabel) {
                this.adCardSubLabel.string = `累计观看广告 ${vm.watched}/${vm.need}`;
            }
            if (this.adCardHintLabel) {
                const days = Math.max(1, Math.ceil(vm.need / Math.max(1, adLimit)));
                this.adCardHintLabel.string = `攒满 ${vm.need} 次（按今日上限约 ${days} 天）可领 · 生效 24 小时`;
            }
            if (this.adCardFillNode) {
                const ratio = Math.max(0, Math.min(1, vm.watched / Math.max(1, vm.need)));
                const ut = this.adCardFillNode.getComponent(UITransform);
                // 锚点在左边（预制件里就是），所以改宽即"从左往右长"
                if (ut) ut.setContentSize(View_Shop.PBAR_FULL_WIDTH * ratio, ut.contentSize.height);
            }
        }

        if (this.adCardBtn) {
            // 生效中**整颗收起**（README §2.3 的三态：这一屏此刻没有可做的事）
            this.adCardBtn.node.active = !active;
            this.adCardBtn.interactable = !active && vm.claimable;
        }
        if (this.adCardBtnLabel) {
            this.adCardBtnLabel.string = vm.claimable ? '领取' : '未攒满';
            this.adCardBtnLabel.color = new Color().fromHEX(vm.claimable
                ? View_Shop.ADCARD_BTN_ON : View_Shop.ADCARD_BTN_OFF);
        }
    }

    /**
     * 每秒走一次两个倒计时（**不重算整页 VM**：那会牵连六格与进度条，每秒重画没必要）。
     * 免广告卡**到期/生效切换**时整页重画一次 —— 那时要换的是整块区域（进度区 ↔ 生效文案 + 按钮）。
     */
    private tickClock(): void {
        const shop = DataCenter.ins.shopData;
        if (this.resetLabel) this.resetLabel.string = `距重置 ${formatClock(shop.getResetInSec())}`;

        const left = shop.getAdCardLeftSec();
        if ((left > 0) !== this.adCardWasActive) {
            this.refresh();
            return;
        }
        if (left > 0 && this.adCardActiveLabel) {
            this.adCardActiveLabel.string = `免广告生效中 · 剩 ${formatClock(left)}`;
        }
    }

    /**
     * 领不到时给**一行中文提示**（哪个原因都回答在底部那行说明上，README §3.4：
     * "广告暂不可用"这类灰态**不画**在格子上）。2 秒后自动还原原本那句说明。
     * 没有真 SDK 时这行是玩家**唯一**能看到的反馈 —— `ezgame.warn` 只进控制台。
     */
    private flashHint(text: string): void {
        if (!text) return;
        ezgame.warn(`[商城] ${text}`);
        const label = this.ledgerRuleLabel;
        if (!label || !label.isValid) return;

        label.string = text;
        const seq = ++this.hintSeq;
        this.scheduleOnce(() => {
            // 连点两次时，只有最后一次负责还原（否则前一次的定时器会把后一条提示擦掉）
            if (seq !== this.hintSeq) return;
            if (label.isValid) label.string = this.ledgerRuleHome;
        }, View_Shop.HINT_SECONDS);
    }

    /**
     * 领取成功的反馈：数字从按钮位置**往上飘一下**再消失（README §2.1 / prompts 第 10 项：
     * 不弹二级确认框）。`from` 不给就落在「免费领取」那颗按钮上。
     */
    public playRewardFly(text: string, from?: Node): void {
        const fly = this.rewardFly;
        if (!fly || !fly.isValid || !text) return;
        const src = from && from.isValid ? from : this.claimBtn?.node;
        if (src) {
            const srcUt = src.getComponent(UITransform);
            const selfUt = this.node.getComponent(UITransform);
            if (srcUt && selfUt) {
                const local = selfUt.convertToNodeSpaceAR(srcUt.convertToWorldSpaceAR(Vec3.ZERO));
                fly.setPosition(local.x, local.y, 0);
            }
        } else if (this.rewardFlyHome) {
            fly.setPosition(this.rewardFlyHome);
        }

        const label = fly.getChildByName('label')?.getComponent(Label);
        if (label) label.string = text;

        this.stopRewardFly();
        fly.active = true;
        if (this.rewardFlyOpacity) this.rewardFlyOpacity.opacity = 255;
        tween(fly)
            .by(0.85, { position: new Vec3(0, 90, 0) }, { easing: 'quartOut' })
            .call(() => {
                if (fly.isValid) fly.active = false;
            })
            .start();
        if (this.rewardFlyOpacity) {
            tween(this.rewardFlyOpacity).to(0.85, { opacity: 0 }).start();
        }
    }

    /** 收尾：停掉飘字的 tween 并把它收回静置态（`close()` 里调用，那时后代节点还活着） */
    private stopRewardFly(): void {
        if (this.rewardFly && this.rewardFly.isValid) {
            Tween.stopAllByTarget(this.rewardFly);
            this.rewardFly.active = false;
            if (this.rewardFlyHome) this.rewardFly.setPosition(this.rewardFlyHome);
        }
        if (this.rewardFlyOpacity) Tween.stopAllByTarget(this.rewardFlyOpacity);
    }

    // ────────────── 节点契约（契约见 View_Shop.prefab；编辑器里没拖引用时按名字兜底） ──────────────

    private resolveRefs(): void {
        const n = this.node;
        const at = (path: string): Node => n.getChildByPath(path);

        this.backBtn = this.backBtn ?? at('top_bar/btn_back')?.getComponent(Button);
        this.resGoldLabel = this.resGoldLabel ?? at('res_bar/chip_gold/value')?.getComponent(Label);
        this.resExpLabel = this.resExpLabel ?? at('res_bar/chip_exp/value')?.getComponent(Label);
        this.dailyGoldLabel = this.dailyGoldLabel ?? at('daily_card/reward_gold/label')?.getComponent(Label);
        this.dailyExpLabel = this.dailyExpLabel ?? at('daily_card/reward_exp/label')?.getComponent(Label);
        this.streakLabel = this.streakLabel ?? at('daily_card/streak_text')?.getComponent(Label);
        this.streakDotsNode = this.streakDotsNode ?? at('daily_card/streak_dots');
        this.claimBtn = this.claimBtn ?? at('daily_card/btn_claim')?.getComponent(Button);
        this.claimLabel = this.claimLabel ?? at('daily_card/btn_claim/label')?.getComponent(Label);
        this.resetLabel = this.resetLabel ?? at('reset_bar/label_reset')?.getComponent(Label);
        // ⚠ 六个格子住在 `ad_list` 的**滚动内容节点**里（2026-11 起这一区是竖直 ScrollView：
        //   `ad_list` = ScrollView + Widget / `ad_list/view` = Mask（剪裁在免广告卡上方）/
        //   `ad_list/view/content` = 纵向自增的 Layout）。旧的 `ad_list` 直接挂六格已作废。
        this.cellsRoot = this.cellsRoot ?? at('ad_list/view/content') ?? at('ad_list');
        this.adCardSubLabel = this.adCardSubLabel ?? at('ad_progress/sub')?.getComponent(Label);
        this.adCardHintLabel = this.adCardHintLabel ?? at('ad_progress/hint')?.getComponent(Label);
        this.adCardFillNode = this.adCardFillNode ?? at('ad_progress/pbar_bg/pbar_fill');
        this.adCardBtn = this.adCardBtn ?? at('ad_progress/btn_get')?.getComponent(Button);
        this.adCardBtnLabel = this.adCardBtnLabel ?? at('ad_progress/btn_get/label')?.getComponent(Label);
        this.adCardActiveLabel = this.adCardActiveLabel ?? at('ad_progress/label_active')?.getComponent(Label);
        // ⚠ 「今日广告 N/14」与「领不到时的提示行」**都在 `reset_bar` 里**（2026-11 契约变更）：
        //   旧的 `ledger`（页面最底部那一条：今日广告 + 规则说明 + 付费说明）在预制件改版时被删掉了，
        //   而 `ledger/*` 两条路径仍然写在这里 → 运行期静默取不到（页面底部再也没有任何反馈，
        //   领不到时玩家只能看到"点了没反应"）。现在读 `reset_bar` 的两行：
        //   `label_today` = 「今日广告 N/14」（本视图写），`label_hint` = 「每天 0 点重置」（被 `flashHint` 临时借用）。
        this.ledgerLabel = this.ledgerLabel ?? at('reset_bar/label_today')?.getComponent(Label);
        this.ledgerRuleLabel = this.ledgerRuleLabel ?? at('reset_bar/label_hint')?.getComponent(Label);
        this.rewardFly = this.rewardFly ?? at('reward_fly');

        if (this.ledgerRuleLabel) this.ledgerRuleHome = this.ledgerRuleLabel.string;

        if (this.rewardFly) {
            this.rewardFlyHome = this.rewardFly.position.clone();
            // 淡出用（预制件里没挂；与 `View_TaskUI` 运行时给格子 addComponent 同一套路）
            this.rewardFlyOpacity = this.rewardFly.getComponent(UIOpacity) ?? this.rewardFly.addComponent(UIOpacity);
        }

        this.cells.clear();
        for (const key of Object.keys(SHOP_CELL_NODE) as ShopItemKey[]) {
            const node = this.cellsRoot?.getChildByName(SHOP_CELL_NODE[key]);
            if (!node) {
                ezgame.warn(`[商城] 广告格节点缺失：${SHOP_CELL_NODE[key]}（契约见 View_Shop.prefab 的 ad_list/view/content）`);
                continue;
            }
            this.cells.set(key, {
                node,
                nameLabel: node.getChildByName('name')?.getComponent(Label),
                amountLabel: node.getChildByName('amount')?.getComponent(Label),
                subLabel: node.getChildByName('sub')?.getComponent(Label),
                countLabel: node.getChildByName('count')?.getComponent(Label),
                onClick: null,
            });
        }
    }

    onDestroy(): void {
        // 摘节点事件（事件挂在后代节点上，退订一律走 offNodeEvent 兜底 —— 子节点先销毁，见 AGENTS.md）
        this.offNodeEvent(this.backBtn?.node, Button.EventType.CLICK, this.onClickBack, this);
        this.offNodeEvent(this.claimBtn?.node, Button.EventType.CLICK, this.onClickClaimFree, this);
        this.offNodeEvent(this.adCardBtn?.node, Button.EventType.CLICK, this.onClickClaimAdCard, this);
        for (const cell of this.cells.values()) {
            this.offNodeEvent(cell.node, Node.EventType.TOUCH_END, cell.onClick, this);
        }
        this.cells.clear();
        // `scope` 的三条监听随作用域销毁一起清（`UIScope.dispose` → 事件总线 removeAll）
        super.onDestroy();
    }
}

/**
 * `秒` → `HH:MM:SS`（「距重置 07:12:33」/「剩 23:12:45」两处共用同一把尺）。
 * 只画倒计时**文字**，不配时钟图标（README §3.3 的资产口径）。
 */
function formatClock(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    // 不用 `padStart`（工程 target 的 lib 到不了 ES2017，全量 tsc 会报 TS2550）
    const p2 = (v: number): string => (v < 10 ? `0${v}` : `${v}`);
    return `${p2(h)}:${p2(m)}:${p2(s)}`;
}
