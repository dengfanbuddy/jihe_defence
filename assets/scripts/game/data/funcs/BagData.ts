/**
 * BagDataModule —— **局外背包**的存档数据模块（局外，跨局累积）
 *
 * ── 它是谁的"家" ──
 * 玩家**持有**的可堆叠道具的**唯一真源**。三类券 / 次数全在这里：
 *   · `ad_ticket`         局内广告券（商城 A6 发）
 *   · `outer_draw_ticket` 局外遗物抽取次数（商城 A4 发）
 *   · `boost_<code>`      本局增益券，**按成就效果 code 分格存**（商城 A5 / 连续登录赠券）
 *
 * ⚠ **2026-11 这次搬家的原因**：这三个东西原来存在 `ShopData` 里。可它们**不是商城的记账**
 *   （商城的记账是"今天看没看过这一格 / 累计看过多少次 / 免广告卡到几号"），而是**玩家背包里的东西** ——
 *   一旦有了背包界面，就会出现"商城说你有 2 张、背包说你有 0 张"这种**两处各存一份**的经典事故。
 *   所以存量搬到本模块，`ShopData` 只留它自己的日计数与免广告卡。
 *   ⚠ 副作用：**旧存档里那三个字段会被丢弃**（它们已不在 `IShopData` 的 schema 里，
 *     `DataModule.mergeDeep` 只合并默认数据里已有的 key）—— 开发期可接受，重看一次广告就回来了。
 *
 * ── 数据形状（⚠ 为什么是数组）──
 * `DataModule` 的深度合并只认「默认数据里已经存在的 key」（`mergeDeep` 里 `if (!(key in target)) continue`），
 * 用 `{[key]: count}` 这种**动态字典**存的话，读档时整片会被丢掉（默认数据里它是空对象）。
 * 数组类型走的是「整片覆盖」，所以能正确读档 —— 与 `TaskData.records` / `ShopData.itemUsed` 同一口径。
 *
 * ── 分工（与项目其它界面一致）──
 *   · **本模块只管存量与规则**：有几件、能不能加（`stack_max`）、能不能扣（够不够）；
 *   · **"这件道具是什么"在配表**（`bag_items.json` → `BagConfig`）；
 *   · **发奖不在这里**：谁发的（商城 / 抽取链路）由 `DataCenter` 决定，本模块只记账。
 *
 * ── 用法 ──
 *   // 数据层（DataCenter）发完奖之后
 *   DataCenter.ins.bagData.addItem(BAG_ITEM_KEY.adTicket, 1);
 *   // 界面侧（BagVM）
 *   DataCenter.ins.bagData.getCount(BAG_ITEM_KEY.adTicket);
 *   DataCenter.ins.bagData.getUsedSlots();      // 占了几格（底栏「容量 N/80」的分子）
 */
import { DataModule } from '../DataModule';
import { BagConfig } from '../configs/BagConfig';
import type { AchEffectCode } from '../../excel_table/Tb_AchievementConfig';

/**
 * 一件道具的存量（**数组**，见文件头 ⚠）。
 * 只有 `count > 0` 的记录会被保留 —— 扣到 0 即整条删掉（背包格子也跟着消失）。
 */
export interface BagItemRecord {
    /** 道具 key（= `bag_items.key`） */
    key: string;
    /** 持有数量 */
    count: number;
    /** 过期时间戳（ms；**0 = 永久**。由配表 `expire_hours` 在**入库那一刻**算出来并存下） */
    expireAt: number;
}

/** 背包数据模块的数据结构（存档键 `bag_data`） */
export interface IBagData {
    /** 持有的道具（数组，见文件头 ⚠） */
    items: BagItemRecord[];
}

/**
 * 手里的一种本局增益券 —— 形状与搬家前的 `ShopData.ShopBoostTicket` **逐字一致**
 * （`{code, count}`），方便日志 / 体检脚本沿用旧断言。
 */
export interface BagBoostTicket {
    /** 成就效果 code（`AchEffectCode`） */
    code: AchEffectCode;
    /** 持有张数 */
    count: number;
}

export class BagDataModule extends DataModule<IBagData> {

    constructor() {
        super('bag_data');
    }

    protected defaultData(): IBagData {
        return { items: [] };
    }

    // ────────────── 读 ──────────────

    /** 持有几件（没有 = 0） */
    getCount(key: string): number {
        return Math.max(0, this._find(key)?.count ?? 0);
    }

    /** 有没有（> 0 才算有；与 UI 的"这一格要不要出现"同一判据） */
    has(key: string): boolean {
        return this.getCount(key) > 0;
    }

    /** 过期时间戳（ms；0 = 永久 / 没有这件道具） */
    getExpireAt(key: string): number {
        return Math.max(0, this._find(key)?.expireAt ?? 0);
    }

    /**
     * 全部**有存量、且配表认得**的道具 key（保持配表 `sort` 升序 —— 界面按这个顺序铺格子）。
     *
     * ⚠ 配表里已经不存在的 key（改过表 / 删过行）**不算数**：它画不出格子，也就不该占容量
     * （`getUsedSlots()` 就是拿它算的，多算一个就等于"明明只有 3 格，底栏写着 4/80"）。
     * 那些"孤儿"存量仍然留在存档里（不静默删玩家的东西），要看它们用 `getOrphanKeys()`。
     *
     * ⚠ **本方法是纯读**（不清理过期）—— 它会被 `BagVM` 的 watcher 指纹间接调用，
     * 而"在 watcher 里写数据"是这套响应式里最容易出事的一种写法（见 `ShopVM.shopFingerprint` 的说明）。
     * 要清过期请显式调 `pruneExpired()`（调用点：`View_Bag.show()` 与每秒的 `tickClock()` ——
     * **不要**放进 `BagVM`，那个函数会被 watcher 回调间接调用）。
     */
    getOwnedKeys(): string[] {
        const owned = this.data.items.filter(r => r.count > 0).map(r => r.key);
        return BagConfig.getSortedItems().map(c => c.key).filter(k => owned.indexOf(k) >= 0);
    }

    /**
     * **配表已经不认**的存量 key（改过表留下的孤儿）：它们画不出格子，但存量还在。
     * 用途只有两个：给玩家/开发一条告警（`BagVM`）、以及体检脚本对账。
     */
    getOrphanKeys(): string[] {
        const owned = this.data.items.filter(r => r.count > 0).map(r => r.key);
        const known = BagConfig.getSortedItems().map(c => c.key);
        return owned.filter(k => known.indexOf(k) < 0).sort();
    }

    /** 已占用的格子数（= 有存量的**种类**数；底栏「容量 N/80」的分子） */
    getUsedSlots(): number {
        return this.getOwnedKeys().length;
    }

    // ────────────── 写 ──────────────

    /**
     * 加数量。
     * @returns **加完之后的总数**（放进去了多少按 `stack_max` 截断；被截断时打一条 warn，不静默吞）
     */
    addItem(key: string, count: number): number {
        const n = Math.max(0, Math.floor(count));
        if (!key || n <= 0) return this.getCount(key);

        const stackMax = BagConfig.getStackMax(key);
        const cur = this.getCount(key);
        // `stack_max = 0` = 不限
        const room = stackMax > 0 ? Math.max(0, stackMax - cur) : n;
        const real = Math.min(n, room);
        if (real < n) {
            console.warn(`[背包] ${key} 已达堆叠上限 ${stackMax}，本次只放进 ${real}/${n} 张`);
        }
        // ⚠ 一张都放不进去时**不新建记录**：空记录虽然会被 `getOwnedKeys` 滤掉，
        //   但会留在存档里变成永远不消失的垃圾
        if (real <= 0) return cur;

        const rec = this._find(key, true);
        rec.count = cur + real;
        if (rec.expireAt <= 0) {
            // 有效期**在入库那一刻**算：之后再改配表不影响手里已有的（与"券跨局累积"同一口径）
            const hours = Math.max(0, BagConfig.getItem(key)?.expire_hours ?? 0);
            if (hours > 0) rec.expireAt = Date.now() + hours * 3600 * 1000;
        }
        return rec.count;
    }

    /**
     * 扣数量（**判据的唯一入口**：够就扣、不够就整笔失败，不做部分扣）。
     * @returns 是否真的扣掉了（false = 不够 / 没有这件道具）
     */
    consumeItem(key: string, count = 1): boolean {
        const n = Math.max(0, Math.floor(count));
        if (!key) return false;
        if (n <= 0) return true;

        const rec = this._find(key);
        if (!rec || rec.count < n) return false;

        rec.count -= n;
        if (rec.count <= 0) this._remove(key);
        return true;
    }

    /** 清空某件道具（返回清掉的数量；用于"整批消耗"类逻辑） */
    clearItem(key: string): number {
        const rec = this._find(key);
        if (!rec) return 0;
        const n = rec.count;
        this._remove(key);
        return n;
    }

    /** 清理过期道具（返回清理掉的**种类数**；幂等，随便调） */
    pruneExpired(): number {
        const now = Date.now();
        const expired = this.data.items.filter(r => r.expireAt > 0 && r.expireAt <= now);
        for (const r of expired) this._remove(r.key);
        return expired.length;
    }

    // ────────────── 本局增益券（按成就效果 code 分格） ──────────────

    /** 手里某种增益券的张数（`code` = `AchEffectCode`） */
    getBoostTicketCount(code: AchEffectCode | string): number {
        return this.getCount(BagConfig.boostItemKey(code));
    }

    /**
     * 手里全部增益券（副本，按配表顺序稳定返回）。
     * 形状与搬家前的 `ShopData.getBoostTickets()` **逐字一致**（`{code, count}`），
     * 方便读档日志与体检脚本沿用旧断言。
     */
    getBoostTickets(): BagBoostTicket[] {
        const out: BagBoostTicket[] = [];
        for (const cfg of BagConfig.getSortedItems()) {
            if (!cfg.effect_code) continue;
            const count = this.getCount(cfg.key);
            if (count > 0) out.push({ code: cfg.effect_code, count });
        }
        return out;
    }

    /** 手里增益券的**总张数** */
    getBoostTotalCount(): number {
        let n = 0;
        for (const t of this.getBoostTickets()) n += t.count;
        return n;
    }

    /** 加增益券（`DataCenter.grantBoostTickets` 发奖时调）；返回加完之后该种的张数 */
    addBoostTicket(code: AchEffectCode | string, count = 1): number {
        return this.addItem(BagConfig.boostItemKey(code), count);
    }

    /**
     * 取出并**清空**全部增益券 —— 入局开局快照用（券在本局开始时消耗，见 `docs/shop/README.md` §4 第 6 条）。
     * ⚠ 入局前的 `cap` clamp 由消费方统一做（券 + 成就 + 等级 + 红遗物词缀**共用一张 cap 表**）。
     */
    consumeBoostTickets(): BagBoostTicket[] {
        const out = this.getBoostTickets();
        for (const t of out) this.clearItem(BagConfig.boostItemKey(t.code));
        return out;
    }

    // ────────────── 内部 ──────────────

    /** 找（create=true 时新建）某件道具的记录 */
    private _find(key: string, create = false): BagItemRecord | undefined {
        let rec = this.data.items.find(r => r.key === key);
        if (!rec && create) {
            rec = { key, count: 0, expireAt: 0 };
            this.data.items.push(rec);
        }
        return rec;
    }

    /** 整条删掉（扣到 0 / 过期 / 清空都走这里） */
    private _remove(key: string): void {
        const idx = this.data.items.findIndex(r => r.key === key);
        if (idx >= 0) this.data.items.splice(idx, 1);
    }
}
