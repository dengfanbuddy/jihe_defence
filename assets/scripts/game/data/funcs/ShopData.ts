/**
 * ShopDataModule —— **局外商城**的存档数据模块（局外，跨局累积）
 *
 * ── 职责边界（与项目其它界面一致）──
 *   · **本模块只管"商城的记账"**：今天领没领补给、每个商品今天看了几次、今天总共看了几次、
 *     累计看了多少、免广告卡生效到什么时候 —— 以及由这些数推出来的判据（`canUseAd` / `canClaimAdCard`）。
 *   · **发奖不在这里**：金币 / 经验 / 券的实际发放与"扣一次机会"都在 `DataCenter`（局外资源的唯一出口），
 *     因为账号经验要顺带结算等级奖励、券要按成就效果的 `cap` 排除，那些都不该让一个存档模块知道。
 *     调用顺序恒为：先问 `canXxx()` → 再发（`DataCenter`）→ 最后记一笔（本模块的 `mark*` / `recordAdWatched`）。
 *
 * ⚠ **2026-11：三类券 / 次数的存量已搬去 `data/funcs/BagData`（局外背包）。**
 *   `adTickets`（局内广告券）/ `outerDrawTickets`（遗物抽取次数）/ `boostTickets`（本局增益券）
 *   原来存在本模块里，但它们是**玩家背包里的东西**、不是商城的记账 —— 有了背包界面之后，
 *   两处各存一份迟早会出现"商城说有 2 张、背包说你有 0 张"。
 *   现在：**存量看 `DataCenter.ins.bagData`**，本模块只留日计数与免广告卡。
 *
 * ── 数据形状（⚠ 为什么 `itemUsed` 用**数组**）──
 * `DataModule` 的深度合并只认「默认数据里已经存在的 key」（`mergeDeep` 里 `if (!(key in target)) continue`），
 * 用 `{[itemKey]: count}` 这种**动态字典**存的话，读档时整片会被丢掉（默认数据里它是空对象）。
 * 数组类型走的是「整片覆盖」，所以能正确读档 —— 与 `TaskData.records` / `BagData.items` 同一口径。
 *
 * ── 日键（跨天重置）──
 * `dailyKey` = 当天日期 `YYYYMMDD`（口径真源 `game/common/DayKey.ts`，与任务模块**同一把尺**）。
 * 键变化 → 清掉 `adUsedToday` 与 `itemUsed`；`freeClaimedKey` 用**比较**代替清零（存的是"领过的那天"）。
 * 免广告卡的累计观看次数（`adCardWatched`）**跨天累计、不随日键清零**（口径见 docs/shop/README.md §2.3）。
 *
 * ── 用法 ──
 *   // 界面侧（View_Shop / ShopVM）
 *   const shop = DataCenter.ins.shopData;
 *   shop.ensurePeriod();                       // 每次打开商城先对齐一次
 *   shop.getItemUsedToday('gold');             // 今日已用次数
 *   shop.canUseAd('gold');                     // { ok, reason }
 *   shop.getAdCardWatched();                   // 累计观看（免广告卡进度）
 *   // 数据层（DataCenter）发完奖之后
 *   shop.recordAdWatched('gold');              // 记一笔：今日 +1 / 累计 +1
 */
import { DataModule } from '../DataModule';
import { todayKey, secondsToNextDay } from '../../common/DayKey';

/** 某个商品今天已用的次数（**数组**，见文件头 ⚠） */
export interface ShopItemUsed {
    /** 商品 key（`MallItemKey`：gold / hero_exp / acc_exp / relic_draw / boost / ad_ticket） */
    key: string;
    /** 今日已用次数 */
    count: number;
}

/** 商城数据模块的数据结构（存档键 `shop_data`） */
export interface IShopData {
    /** 日键（当天日期 YYYYMMDD）—— 变了就清日计数 */
    dailyKey: string;
    /** 「每日补给」是哪一天领的（= 今天 = 今天已领；空串 = 从没领过） */
    freeClaimedKey: string;
    /** 今日已看广告总次数（跨商品共用一本账，上限 `MallConfig.getAdDailyTotalLimit()`） */
    adUsedToday: number;
    /** 每个商品今日已用次数（数组，见文件头 ⚠） */
    itemUsed: ShopItemUsed[];
    /** 免广告卡·累计观看广告次数（跨天累计；领卡后清零，从头攒下一张） */
    adCardWatched: number;
    /** 免广告卡·生效截止时间戳（ms；0 = 未生效） */
    adCardActiveUntil: number;
}

/**
 * 「能不能看这次广告」的结果（`reason` 空串 = 可以）。
 * ⚠ 两条判据都满时**先报 `item_limit`**（这一格更具体：玩家点的是这一格）；总次数那条
 * 由界面底部「今日广告 N/14」另外回答，不算被吞掉。
 */
export interface ShopAdCheck {
    ok: boolean;
    /**
     * 不能看的原因：
     *   `unknown_item`     配表里没有这个商品（表未就绪 / key 写错）
     *   `not_ad`           这个商品不是广告商品（每日补给走 `canClaimFree()`）
     *   `item_limit`       这一格今天看满了
     *   `daily_total_limit` 今天的广告总次数用完了（跨商品共用，见 README §2.2）
     */
    reason: '' | 'unknown_item' | 'not_ad' | 'item_limit' | 'daily_total_limit';
}

/** 领免广告卡的结果 */
export interface ShopAdCardClaimResult {
    ok: boolean;
    /** 失败原因（`ok=true` 时是空串）：`not_enough` 没攒满 / `active` 已有一张生效中 */
    reason: '' | 'not_enough' | 'active';
    /** 生效截止时间戳（ms；失败为原值） */
    activeUntil: number;
}

/** 一条原因对应的中文提示（**唯一一份**：`View_Shop` 与日志都用它） */
export const SHOP_REASON_TEXT: Record<string, string> = {
    unknown_item: '这个商品没配表',
    not_ad: '它不是广告商品',
    item_limit: '今天的次数用完了',
    daily_total_limit: '今天的广告次数用完了',
    boost_pool_empty: '本局增益都已满',
    not_enough: '还没攒满',
    active: '免广告已经生效了',
    claimed_today: '今天已经领过了',
};

export class ShopDataModule extends DataModule<IShopData> {

    constructor() {
        super('shop_data');
        // 首次构造也要对齐日键（新号第一次进入 = 今天第一次打开）
        this.ensurePeriod();
    }

    protected defaultData(): IShopData {
        return {
            dailyKey: '',
            freeClaimedKey: '',
            adUsedToday: 0,
            itemUsed: [],
            adCardWatched: 0,
            adCardActiveUntil: 0,
        };
    }

    // ────────────── 周期（跨天重置） ──────────────

    /**
     * 对齐日键（**幂等**，可随便调）：键变了就清掉**日计数**。
     * 调用点：模块构造（首次进入）、`DataCenter.init()`、每次打开商城（`View_Shop.show()`）。
     *
     * ⚠ 只清"日"口径的三样（`adUsedToday` / `itemUsed` / 免费的领取日键）；
     *   免广告卡的累计观看**跨天保留**。
     *   券（局内广告券 / 遗物抽取次数 / 增益券）**也跨天保留** —— 但它们已经不住在本模块里了，
     *   见文件头 ⚠ 与 `data/funcs/BagData.ts`（本方法碰不到它们，这正是搬家想要的效果）。
     */
    ensurePeriod(): void {
        const dk = todayKey();
        if (this.data.dailyKey !== dk) {
            this.data.dailyKey = dk;
            this.data.adUsedToday = 0;
            this.data.itemUsed = [];
        }
    }

    /** 今天是否已经领过每日补给 */
    isFreeClaimedToday(): boolean {
        return !!this.data.freeClaimedKey && this.data.freeClaimedKey === todayKey();
    }

    /** 记下「今天领过每日补给」（发奖由 `DataCenter` 做，本方法只记账） */
    markFreeClaimed(): void {
        this.ensurePeriod();
        this.data.freeClaimedKey = todayKey();
    }

    /** 距次日 0 点重置还有多少秒（界面「距重置 07:12:33」） */
    getResetInSec(): number {
        return secondsToNextDay();
    }

    // ────────────── 每日次数 ──────────────

    /** 某个商品今天已用次数 */
    getItemUsedToday(key: string): number {
        this.ensurePeriod();
        return Math.max(0, this._itemUsed(key)?.count ?? 0);
    }

    /** 今日已看广告总次数（跨商品） */
    getAdUsedToday(): number {
        this.ensurePeriod();
        return Math.max(0, this.data.adUsedToday);
    }

    /**
     * 能不能为这个商品看一次广告（**判据的唯一真源**，界面与数据层都问它）。
     * @param dailyLimit 这一格的每日上限（0 = 不限）；传 `MallConfig.getDailyLimit(key)`
     * @param totalLimit 今日广告总上限（跨商品共用）；传 `MallConfig.getAdDailyTotalLimit()`
     */
    canUseAd(key: string, dailyLimit: number, totalLimit: number): ShopAdCheck {
        this.ensurePeriod();
        if (!key) return { ok: false, reason: 'unknown_item' };
        if (dailyLimit > 0 && this.getItemUsedToday(key) >= dailyLimit) {
            return { ok: false, reason: 'item_limit' };
        }
        if (totalLimit > 0 && this.getAdUsedToday() >= totalLimit) {
            return { ok: false, reason: 'daily_total_limit' };
        }
        return { ok: true, reason: '' };
    }

    /**
     * 记一笔「这个商品看完了一次广告」（**发奖之后**调，见文件头的调用顺序）：
     * 今日该项次数 +1、今日广告总次数 +1、免广告卡的累计观看 +1。
     * @returns 累计观看次数（免广告卡进度）
     */
    recordAdWatched(key: string): number {
        this.ensurePeriod();
        const rec = this._itemUsed(key, true);
        if (rec) rec.count += 1;
        this.data.adUsedToday += 1;
        this.data.adCardWatched += 1;
        return this.data.adCardWatched;
    }

    // ────────────── 免广告卡（累计观看换 24 小时免广告，见 README §2.3） ──────────────

    /** 累计观看的广告次数（跨天累计） */
    getAdCardWatched(): number {
        return Math.max(0, this.data.adCardWatched);
    }

    /** 免广告卡当前是否生效中 */
    isAdCardActive(): boolean {
        return this.data.adCardActiveUntil > Date.now();
    }

    /** 免广告卡还剩多少秒（未生效 = 0） */
    getAdCardLeftSec(): number {
        const left = this.data.adCardActiveUntil - Date.now();
        return left > 0 ? Math.floor(left / 1000) : 0;
    }

    /**
     * 能不能领免广告卡：**攒满 且 当前没有生效中的卡**。
     * @param need 需要的累计观看次数（`MallConfig.getAdCardNeedWatches()`）
     */
    canClaimAdCard(need: number): boolean {
        return !this.isAdCardActive() && this.getAdCardWatched() >= Math.max(1, need);
    }

    /**
     * 领卡：记「生效到什么时候」并**清空累计计数**（下一张从头攒）。
     * ⚠ 生效**不叠加**：已生效时直接拒绝（否则连点两下就把 24 小时变成 48 小时）。
     * @param hours 生效小时数（`MallConfig.getAdCardHours()`）
     */
    claimAdCard(need: number, hours: number): ShopAdCardClaimResult {
        if (this.isAdCardActive()) {
            return { ok: false, reason: 'active', activeUntil: this.data.adCardActiveUntil };
        }
        if (this.getAdCardWatched() < Math.max(1, need)) {
            return { ok: false, reason: 'not_enough', activeUntil: this.data.adCardActiveUntil };
        }
        const ms = Math.max(1, hours) * 3600 * 1000;
        this.data.adCardActiveUntil = Date.now() + ms;
        this.data.adCardWatched = 0;
        return { ok: true, reason: '', activeUntil: this.data.adCardActiveUntil };
    }

    // ────────────── 内部 ──────────────

    /** 找（create=true 时新建）某个商品的今日计数记录 */
    private _itemUsed(key: string, create = false): ShopItemUsed | undefined {
        let rec = this.data.itemUsed.find(r => r.key === key);
        if (!rec && create) {
            rec = { key, count: 0 };
            this.data.itemUsed.push(rec);
        }
        return rec;
    }
}
