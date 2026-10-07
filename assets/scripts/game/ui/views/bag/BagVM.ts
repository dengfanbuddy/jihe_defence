/**
 * BagVM.ts —— 局外背包的**页面 VM 构造**（判据的唯一落点）
 *
 * 分层（口径真源 `docs/bag/README.md`）：
 *   · **判据只算一次**：`buildBagPageVM(选中谁)` 把「要铺哪几格（含空槽）/ 每格显示什么 / 详情面板写什么 /
 *     容量进度条走多少」算成一份 `BagPageVM`，界面照着画、**不自己重算**。
 *   · **数据从哪来**：存量来自 `DataCenter.ins.bagData`（存档），
 *     道具长什么样来自 `BagConfig`（`bag_items.json`），读数来自 `itemData` / `heroData`。
 *   · **本文件是纯读 + 纯算**：**一行都不写数据** —— 连"清过期"（`pruneExpired`）都不在这里，
 *     因为它会被 watcher 回调间接调用，而"在 watcher 里写数据"是这套响应式里最容易出事的写法
 *     （见 `ShopVM.shopFingerprint` 的说明）。清过期的落点是 `View_Bag.show()` 与每秒的 `tickClock()`。
 *
 * ⚠ **这一屏自己就是宿主**（跨层 `emit` 到 `Scene_Menu` 做不到，见 `./BagScope` 文件头），
 * 所以"换选中"是页面的本地状态，`buildBagPageVM(key)` 把它当参数收进来 ——
 * 判据（哪些格、选中谁、正文写什么）仍然只在**这里**算一次。
 *
 * 用法（`View_Bag`）：
 *   this.scope.watch(() => bagFingerprint(), () => this.refresh());   // 数据一变自动重刷
 *   this.applyPage(buildBagPageVM(this.selectedKey));
 */
import { BagConfig, CurrencyType, DataCenter, MallConfig } from '../../../data';
import { achEffectLabel } from '../../../common/AchievementEffectMeta';
import { BAG_NO_SELECTION_TEXT, type BagCellVM, type BagDetailVM, type BagPageVM } from './BagScope';

/** 「配表里没有这一行」类告警只报一次（表被改坏时能一眼看出来，又不刷屏） */
let warnedOrphans = '';

/**
 * 把当前存档与配表算成**一份整页 VM**。
 *
 * @param selectedKey 当前选中的道具 key（页面本地状态）。传空 / 传一个**已经不在背包里**的 key
 *                    （比如刚把它用光了）会**自动回落到第一格** —— 不然详情面板会显示一件
 *                    "玩家已经没有"的道具，那是这类界面最典型的一个谎言。
 *                    一件道具都没有时没有可回落的目标 → 下发**未选中占位态**（`detail.empty`）。
 */
export function buildBagPageVM(selectedKey = ''): BagPageVM {
    const dc = DataCenter.ins;
    const bag = dc.bagData;

    // ① 有货的格子（按配表 `sort` 升序 —— 顺序由 `BagData.getOwnedKeys()` 定）
    const filled: BagCellVM[] = [];
    for (const key of bag.getOwnedKeys()) {
        const cfg = BagConfig.getItem(key);
        if (!cfg) continue;   // 理论上进不来（getOwnedKeys 已经滤过配表），留着是为了不把 undefined 传给界面
        filled.push({
            key,
            empty: false,
            name: cfg.name,
            icon: cfg.icon ?? '',
            rarity: cfg.rarity,
            count: bag.getCount(key),
            expireAt: bag.getExpireAt(key),
            selected: false,
        });
    }
    warnOrphans(bag.getOrphanKeys());

    // 选中回落：选中的那一格不在了（用光了 / 第一次打开）→ 落到第一格。
    // ⚠ **只在有货的格子里回落**：空槽的 key 是空串，若在整片 `cells` 里找，
    //   `''` 会命中第一个空槽 —— 于是"选中了一个空槽"、选中环画在不存在的道具上。
    const sel = filled.find(c => c.key === selectedKey) ?? filled[0];
    if (sel) sel.selected = true;

    // ② 空槽补足到上限（**画格子这件事归判据层**：空背包也铺满 80 格，界面不自己补）
    const cap = BagConfig.getSlotCapacity();
    const cells: BagCellVM[] = filled.slice();
    for (let i = cells.length; i < cap; i++) cells.push(makeEmptyCell());

    return {
        resBar: {
            gold: dc.itemData.getCurrency(CurrencyType.Gold),
            heroExp: dc.heroData.getSharedExp(),
        },
        cells,
        detail: sel ? (buildDetailVM(sel.key) ?? makeEmptyDetailVM()) : makeEmptyDetailVM(),
        capacity: { used: filled.length, cap, full: filled.length >= cap },
    };
}

/**
 * **未选中**的那一份详情 VM（面板恒显示，见 `BagPageVM.detail`）。
 *
 * ⚠ 它只回答"这一格空着"：灰底（`BAG_EMPTY_FRAME`，由界面按 `empty` 分派着染）+ 名字「未选中」，
 *   图标 / 正文 / 两个按钮全收起。所以除 `name` 之外全是**占位值**（`''` / `'common'` / `false`）——
 *   界面**不许**按这些字段渲染（`docs/bag/README.md` §2）。
 */
function makeEmptyDetailVM(): BagDetailVM {
    return {
        empty: true,
        key: '',
        name: BAG_NO_SELECTION_TEXT,
        desc: '',
        icon: '',
        rarity: 'common',
        usable: false,
        sellable: false,
        useText: '',
        sellText: '',
    };
}

/**
 * 一个**空槽**（"这里有个位置，但没东西"）。
 * ⚠ 空槽只回答"还有没有位置"，**不回答品质** —— 所以 `rarity` 只是占位（界面按 `empty` 分支渲染，
 * 不会去染品质色；空白档的 `#DDDDDD` 与空槽的灰是两回事，见 `BagScope.BAG_EMPTY_FRAME`）。
 */
function makeEmptyCell(): BagCellVM {
    return {
        key: '',
        empty: true,
        name: '',
        icon: '',
        rarity: 'common',
        count: 0,
        expireAt: 0,
        selected: false,
    };
}

/**
 * 详情面板的 VM（**判据全在这里**：按钮能不能点、正文写哪两行）。
 *
 * 正文两行的口径（⚠ 2026-11 预制件改版后 `desc` 是 `overflow=RESIZE_HEIGHT`、宽 200 / fs16 / lh24 ⇒
 * **写几行长多高、不会裁字**，代价是会把下面两个按钮一层层往下推；面板高 1038，
 * 固定部分（`icon_tile` 176 + `name` 38 + 两个按钮 112 + 排版间距 90）约 416 ⇒ 正文最多约 25 行。
 * 但"能放下"不等于"该那么长"：两行仍是设计口径，`audit:bag` 的 B 段按**预制件实测**逐行估价钉住它）：
 *   · 第一行 = 配表 `desc`（这件东西干什么）
 *   · 第二行 = **增益券**写"这张券值多少"（`achEffectLabel`，带具体数字，玩家最想知道的就是它）；
 *              其余写配表 `use_hint`（如"抽取时自动抵扣，不需要手动使用"）——
 *              这正是回答"为什么「使用」是灰的"的那一句
 *
 * @returns 配表里没这一行时返回 `null`（调用方会换成**未选中占位态**，见 `makeEmptyDetailVM`）
 */
export function buildDetailVM(key: string): BagDetailVM | null {
    const cfg = BagConfig.getItem(key);
    if (!cfg) return null;

    // 增益券：第二行给**具体效果数值**（一张券值多少由 battle_constants.shopBoostTicketValues 下发）
    const effect = cfg.effect_code
        ? achEffectLabel(cfg.effect_code, MallConfig.getBoostTicketValue(cfg.effect_code))
        : '';
    const line2 = effect || cfg.use_hint || '';

    return {
        empty: false,
        key,
        name: cfg.name,
        desc: [cfg.desc ?? '', line2].filter(Boolean).join('\n'),
        icon: cfg.icon ?? '',
        rarity: cfg.rarity,
        usable: !!cfg.usable,
        sellable: !!cfg.sellable,
        useText: cfg.usable ? '使用' : '不可使用',
        sellText: cfg.sellable ? `出售 ${Math.max(0, cfg.sell_price ?? 0)}` : '不可出售',
    };
}

/**
 * 页面**指纹** —— watcher 的订阅源：**只要它变了就重刷界面**。
 * 读到的东西就是真实依赖（金币 / 通用英雄经验 / 背包里每一件的 key 与数量），
 * 任何地方（商城看广告发券、以后遗物抽取扣次数）改动都会自动重刷，不需要手动广播。
 *
 * ⚠ 本函数在 watcher 里跑，**不许有副作用**（清过期那种写操作放在 `View_Bag.show()` / `tickClock()` 里）。
 * ⚠ 直接读 `bag.data.items` 原始数组（而不是 `getOwnedKeys()`）：后者要过一遍配表排序与过滤，
 * 在 watcher 里跑属于白烧，指纹只需要"能区分变化"。
 */
export function bagFingerprint(): string {
    const dc = DataCenter.ins;
    const bag = dc.bagData;
    const items = bag.data.items.map(r => `${r.key}x${r.count}@${r.expireAt}`).join(',');
    return [
        dc.itemData.getCurrency(CurrencyType.Gold),
        dc.heroData.getSharedExp(),
        items,
    ].join('|');
}

/** 存档里有、配表里没有的 key 只报一次（配表被删过行时能一眼看出来，又不刷屏） */
function warnOrphans(orphans: string[]): void {
    const sig = orphans.join(',');
    if (!sig || sig === warnedOrphans) return;
    warnedOrphans = sig;
    console.warn(`[背包] 存档里有这些道具配表里没有（已被跳过，不占格子）：${sig}`
        + ' —— 要么是 bag_items.json 删过行，要么是 key 被改过（口径见 docs/bag/README.md §3）');
}
