/**
 * ShopScope.ts — 商城全屏页（`View_Shop`）的 scope 契约（键 + 事件 + 页面 VM 形状）
 *
 * 与 `views/task/TaskScope.ts` / `scene_game_stage/cmps/StageScope.ts` 同一套路：
 * **页面只渲染 + 上报，判据只在一个 VM 里算一次**（VM 构造在 `./ShopVM`）。
 *
 * 方向约定：
 *   · 状态向下：`buildShopPageVM()` 把「这一屏要显示什么」算成一份 `ShopPageVM`
 *     交给 `View_Shop.applyPage(vm)`；页面**不读数据层**、不自己算「还剩几次 / 能不能领」。
 *   · 通知向上：页面只 `scope.emit(...)`；真正看广告 / 发奖 / 扣额度的是 `DataCenter`
 *     + `AdMgr`（链路见 `docs/shop/README.md` §1）。
 *
 * ⚠ **「宿主 = `Scene_Menu` 收页面事件」是做不到的（2026-11 修正）**：
 * `UIScope.emit` 只沿 `node.parent` 向上冒泡，而 `views` 层与 `scenes` 层是 UIManager 下的**兄弟节点**
 * （见 `platform/ui/UIScope.ts` 规则 1），页面的 `emit` 永远到不了 `Scene_Menu` 的作用域。
 * 实际形态与 `View_TaskUI` 一致：**页面自己就是宿主** —— `View_Shop` 自己 `scope.on` 这三个事件
 * （`bindEvents`），流程写在它的三个 `onXxx` 里，判据在 `ShopVM`，发奖在 `DataCenter`；
 * `Scene_Menu` 只负责「开」与「与另两个全屏面板互斥」。保留这三个事件名是为了**留一条缝**：
 * 哪天要把流程搬到别处（例如换成一个纯 TS 的功能类），只改 `View_Shop` 里那一处监听，界面代码不动。
 *
 * 口径真源是 `docs/shop/README.md`：卖什么 / 每个给多少 / 数值依据都在那份文档里，
 * 本文件只把它们翻译成类型。
 */

/**
 * 六个广告商品的 key —— 与 README §2.2 的 A1~A6、预制件 `ad_list` 的六个格子一一对应。
 * 它同时是宿主侧的 `AdPlacement` 后缀来源（`shop_gold` / `shop_hero_exp` / …）。
 *
 * ⚠ 2026-11 改动：第 5 格由 **`boost`（开局增益券）** 换成 **`revive_ticket`（局内复活券）**
 *   —— 预制件里那一格本来就叫 `cell_relife`（「局内复活券 · 局内死亡立即复活」），
 *   旧契约写着 `cell_boost` 却**没有对应节点**，所以那一格一直画不出来（`audit:mall` J3/J4 会报）。
 *   本局增益券没有消失：它仍由「连续登录 ≥7 天赠 1 张」发放，背包里那 10 个 `boost_*` 道具也照旧。
 */
export type ShopItemKey = 'gold' | 'hero_exp' | 'acc_exp' | 'relic_draw' | 'revive_ticket' | 'ad_ticket';

/**
 * key → 预制件里的格子节点名（`View_Shop.prefab` 的 `ad_list/view/content`；点格子时按它回推 key）。
 *
 * ⚠ **三种券各有一格**（名字 / 数量 / 「今日 N/M」由配表 `mall_items` 下发）：
 *   `cell_relic`   局外遗物抽取券（`relic_draw`，sub 那一行是动态的「已收集 N/37」）
 *   `cell_relife`  局内复活券（`revive_ticket`）
 *   `cell_adticket` 局内广告券（`ad_ticket`）
 * 三个 key 都必须与 `assets/resources/tb/mall_items.json` 里 `kind = 'ad'` 的六行**完全对应** ——
 * 多一个 key 就是"画不出格子的商品"，少一个就是"永远空着的格子"，两边都有体检盯着（`audit:mall` A8/J5c）。
 */
export const SHOP_CELL_NODE: Readonly<Record<ShopItemKey, string>> = {
    gold: 'cell_gold',
    hero_exp: 'cell_exp',
    acc_exp: 'cell_acc',
    relic_draw: 'cell_relic',
    revive_ticket: 'cell_relife',
    ad_ticket: 'cell_adticket',
};

/**
 * 页面向上冒泡的三件事。
 * ⚠ **唯一监听方是页面自己**（`View_Shop.bindEvents` 里的 `scope.on`）—— 见文件头的说明：
 * 跨层冒泡到 `Scene_Menu` 做不到，所以"宿主"就是这一屏自己。**再多一处监听 = 一次点击被处理两次**
 * （重复发奖 / 重复记次数）。
 * ⚠ 左上角「返回」**不在这里**：views 形态下页面自己 `UIManager.closeUI(View_Shop)` 收掉自己
 * （与 `View_TaskUI` 同口径），不需要向外通知。
 */
export const ShopScopeEvents = {
    /** 点「免费领取」（每日补给 F1；一天一次、不看广告） */
    ClaimFree: 'shop:claimFree',
    /** 点某个广告商品格（参数：`ShopItemKey`）→ 宿主拉起 `AdMgr.showRewardVideo('shop_*')` */
    BuyWithAd: 'shop:buyWithAd',
    /** 点免广告卡的「领取」（累计观看次数攒满 → 换 24 小时免广告；口径见 README §2.3） */
    ClaimAdCard: 'shop:claimAdCard',
} as const;

/** 顶部资源行 —— 全屏页把主界面顶栏整块盖住了，所以这一行是玩家**唯一**的读数 */
export interface ShopResBarVM {
    /** 金币（`itemData.getCurrency(CurrencyType.Gold)`） */
    gold: number;
    /** 通用英雄经验（`heroData.getSharedExp()`） */
    heroExp: number;
}

/**
 * 每日补给块（F1）。
 * ⚠ `gold` / `heroExp` 是**已经乘完连续登录加成**的数（连续 4 天就写 300/150），
 * 不要下发基础值让界面自己乘 —— 界面也不许画「200 × 1.5」（README §2.1）。
 */
export interface ShopDailyVM {
    gold: number;
    heroExp: number;
    /** 连续登录天数（`PlayerInfo.loginStreak`） */
    streakDays: number;
    /** 今日倍数（1 / 1.5 / 2） */
    streakMul: number;
    /** 今天是否已领（已领 = 主按钮变灰药丸「明天再来」） */
    claimed: boolean;
    /** 距次日 0 点重置的秒数（日键比较，不是"距上次 24 小时"） */
    resetInSec: number;
}

/**
 * 一个广告商品格（A1~A6）。
 * ⚠ 「今日次数用完」/「广告暂不可用」两个灰态**按决策不画**（2026-11，见 README §3.4）：
 * 格子只显示「今日 N/M」，领不到的原因由页面在底部说明行上给一行中文提示，不做视觉态。
 *
 * `name` / `amountText` / `sub` 由 `mall_items.json` 给 —— **界面上那一格写什么，与真正发多少同源**：
 * 配表改了数量（例如金币袋 300 → 400），格子上的 `+300 金币` 会跟着变成 `+400 金币`，
 * 不会出现"格子上写着 300、到手 400"（这三行原来是预制件里写死的样例文案）。
 */
export interface ShopCellVM {
    key: ShopItemKey;
    /** 商品名（写入格子的 `name` 标签；空 = 保持预制件文案不动） */
    name: string;
    /** 数量文案（写入格子的 `amount` 标签，如 `+300 金币`；空 = 不动） */
    amountText: string;
    /** 副标题（写入格子的 `sub` 标签；空 = 不动。遗物格那一行是动态的「已收集 N/M」） */
    sub: string;
    /** 今日已用次数 */
    usedToday: number;
    /** 每日次数上限（配表没写 = 0 = 不限） */
    dailyLimit: number;
}

/** 免广告卡（累计观看广告换 24 小时免广告；数值与依据见 README §2.3） */
export interface ShopAdCardVM {
    /** 累计观看广告次数 */
    watched: number;
    /** 需要攒满的次数 */
    need: number;
    /** 是否可领（攒满 且 当前没有生效中的卡） */
    claimable: boolean;
    /** 免广告剩余生效秒数（0 = 未生效） */
    activeLeftSec: number;
}

/** 整页 VM —— 宿主**一次算好、一次下发**（避免页面里出现第二份判据） */
export interface ShopPageVM {
    resBar: ShopResBarVM;
    daily: ShopDailyVM;
    cells: ShopCellVM[];
    adCard: ShopAdCardVM;
    /** 今日已看广告总次数 */
    adUsedToday: number;
    /** 每日广告总上限（README §2.2：当前 14） */
    adLimit: number;
    /** 局外遗物图鉴进度（`cell_relic` 的 sub 那一行「已收集 12/37」） */
    relicCollected: number;
    /** 局外遗物总数（37） */
    relicTotal: number;
}
