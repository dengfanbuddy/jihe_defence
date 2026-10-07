/**
 * ShopVM.ts —— 局外商城的**页面 VM 构造**（判据的唯一落点）
 *
 * 分层（口径真源 `docs/shop/README.md`）：
 *   · **判据只算一次**：`buildShopPageVM()` 把「今天能不能领 / 每格还剩几次 / 卡攒到哪了 /
 *     图鉴收到几件」算成一份 `ShopPageVM`，界面照着画、**不自己重算**。
 *   · **数据从哪来**：商品与规则来自 `MallConfig`（`mall_items.json` + `battle_constants.shop*`），
 *     计数与券来自 `DataCenter.ins.shopData`（存档），读数来自 `itemData` / `heroData` / `equipCollection`。
 *   · **发奖不在这里**：领东西一律走 `DataCenter.claimShopDailyGift()` / `grantShopItem()` / `claimAdCard()`。
 *
 * ⚠ **宿主是谁**（2026-11 修正，别照旧文档抄）：这一屏是 `views/` 层的全屏页，而 `UIScope.emit`
 * 只沿 `node.parent` 向上、**不跨 UIManager 的层节点**（`scenes` 与 `views` 是兄弟）——
 * 所以「宿主 = `Scene_Menu` 收页面事件」在原设计里是**做不到**的。实际形态与 `View_TaskUI` 一致：
 * **页面自己就是宿主**（自己 `scope.on` 自己 `emit` 的三件事，见 `View_Shop.bindEvents`），
 * 逻辑收口在本文件（判据）+ `DataCenter`（发奖），`Scene_Menu` 只负责"开"与"与另两个全屏面板互斥"。
 *
 * 用法（`View_Shop`）：
 *   this.scope.watch(() => shopFingerprint(), () => this.refresh());   // 数据一变自动重刷
 *   this.applyPage(buildShopPageVM());
 */
import { CurrencyType, DataCenter, MallConfig, BAG_ITEM_KEY } from '../../../data';
import { getOuterRelics } from '../../../data/configs/EquipmentConfig';
import { SHOP_CELL_NODE } from './ShopScope';
import type { ShopAdCardVM, ShopCellVM, ShopDailyVM, ShopItemKey, ShopPageVM } from './ShopScope';

/** 六个广告格的 key（顺序 = 预制件里的格子顺序；VM 少了哪个格，界面就保持它的样例态） */
export const SHOP_CELL_KEYS = Object.keys(SHOP_CELL_NODE) as ShopItemKey[];

/** 「数据层没接线」类告警只报一次（`MallConfig` 未就绪 / 某格没配表），别每次开都刷屏 */
let warnedNotReady = false;
let warnedMissingCells = '';

/**
 * 把当前存档与配表算成**一份整页 VM**。
 *
 * ⚠ 返回值里的 `daily.gold` / `daily.heroExp` 是**已经乘完连续登录倍数**的数
 * （与 `DataCenter.claimShopDailyGift` 用同一把尺，见那里的 `previewShopDailyGift`）——
 * 界面**不许**再自己乘一次，也不许画「200 × 1.5」（README §2.1）。
 */
export function buildShopPageVM(): ShopPageVM {
    const dc = DataCenter.ins;
    const shop = dc.shopData;

    // 读之前对齐一次日键：跨天打开商城时，先把「今日广告次数 / 每格今日次数」清掉再算
    shop.ensurePeriod();

    // ── 每日补给（F1）──
    const preview = dc.previewShopDailyGift();
    const daily: ShopDailyVM = {
        gold: preview.gold,
        heroExp: preview.heroExp,
        streakDays: preview.streakDays,
        streakMul: preview.streakMul,
        claimed: shop.isFreeClaimedToday(),
        resetInSec: shop.getResetInSec(),
    };

    // ── 六个广告格（A1~A6）──
    const adLimit = MallConfig.getAdDailyTotalLimit();
    const relicCollected = dc.equipCollection.getDistinctCount();
    const relicTotal = getOuterRelics().length;
    const cells: ShopCellVM[] = [];
    for (const cfg of MallConfig.getAdItems()) {
        const key = cfg.key as ShopItemKey;
        if (!SHOP_CELL_NODE[key]) {
            console.warn(`[商城] mall_items 里的 key「${cfg.key}」在界面契约（SHOP_CELL_NODE）里没有对应格子 → 已忽略`);
            continue;
        }
        cells.push({
            key,
            name: cfg.name,
            amountText: cfg.amount_text ?? '',
            // 遗物格那一行是**动态**的（图鉴进度）；其余格的 sub 由配表给（留空 = 不写，保持预制件文案）
            sub: key === 'relic_draw' ? `已收集 ${relicCollected}/${relicTotal}` : (cfg.subtitle ?? ''),
            usedToday: shop.getItemUsedToday(cfg.key),
            dailyLimit: Math.max(0, cfg.daily_limit),
        });
    }
    if (!cells.length && !warnedNotReady) {
        warnedNotReady = true;
        console.warn('[商城] mall_items.json 没有可用的广告商品（配表未加载完？）→ 页面保持预制件的样例态；'
            + '接线见 docs/shop/README.md §4');
    }
    const missing = SHOP_CELL_KEYS.filter(k => !cells.some(c => c.key === k)).join(',');
    warnMissingCells(missing);

    // ── 免广告卡（累计观看换 N 小时免广告）──
    const need = MallConfig.getAdCardNeedWatches();
    const adCard: ShopAdCardVM = {
        watched: shop.getAdCardWatched(),
        need,
        claimable: shop.canClaimAdCard(need),
        activeLeftSec: shop.getAdCardLeftSec(),
    };

    return {
        resBar: {
            gold: dc.itemData.getCurrency(CurrencyType.Gold),
            heroExp: dc.heroData.getSharedExp(),
        },
        daily,
        cells,
        adCard,
        adUsedToday: shop.getAdUsedToday(),
        adLimit,
        relicCollected,
        relicTotal,
    };
}

/** 少配了哪几格只报一次（配表被改坏时能一眼看出来，又不刷屏） */
function warnMissingCells(missing: string): void {
    if (!missing || missing === warnedMissingCells) return;
    warnedMissingCells = missing;
    console.warn(`[商城] 这些格子没在 mall_items.json 里配到（界面会保持预制件文案）：${missing}`);
}

/**
 * 页面**指纹** —— watcher 的订阅源：**只要它变了就重刷界面**。
 * 读到的字段就是真实依赖（金币 / 通用英雄经验 / 连续登录 / 每格今日次数 / 券 / 卡 / 图鉴进度），
 * 任何地方（看广告、领补给、领卡、英雄升级花掉经验）改动都会自动重刷，不需要手动广播。
 *
 * ⚠ 本函数在 watcher 里跑，**不许有副作用**（`ensurePeriod` 那种写操作放在 `show()` / `buildShopPageVM()` 里）。
 */
export function shopFingerprint(): string {
    const dc = DataCenter.ins;
    const shop = dc.shopData;
    const used = SHOP_CELL_KEYS.map(k => shop.getItemUsedToday(k)).join('/');
    return [
        dc.itemData.getCurrency(CurrencyType.Gold),
        dc.heroData.getSharedExp(),
        dc.playerInfo.data.loginStreak,
        shop.isFreeClaimedToday() ? 1 : 0,
        shop.getAdUsedToday(),
        shop.getAdCardWatched(),
        shop.isAdCardActive() ? 1 : 0,
        // ⚠ 券的存量住在**背包**（2026-11 搬过去），不再住在 shopData —— 别在这里读 shopData 的旧字段
        dc.bagData.getCount(BAG_ITEM_KEY.adTicket),
        dc.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket),
        dc.bagData.getBoostTotalCount(),
        dc.equipCollection.getDistinctCount(),
        used,
    ].join('|');
}
