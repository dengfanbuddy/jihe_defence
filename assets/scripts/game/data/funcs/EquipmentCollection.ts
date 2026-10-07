/**
 * EquipmentCollectionModule - 局外装备（遗物）收集数据模块
 *
 * 类似图鉴/成就系统的装备收集功能：
 * - **局外遗物**抽到之后记录在此（来源只有一处：`DataCenter.drawOuterRelic`，见下）
 * - 同一件装备可重复收集，属性累加（份数无上限）
 * - 独立于道具背包（ItemDataModule）
 * - 通过 OuterAttributeCalculator 计算属性加成
 *
 * @example
 * ```ts
 * // 图鉴页抽取（唯一的写入方）
 * DataCenter.ins.drawOuterRelic(1);
 *
 * // 查看收集情况
 * const count = DataCenter.ins.equipCollection.getCollectedCount(1068);
 * ```
 *
 * ⚠ 2026-07：遗物表改成「一件遗物一行」，局内版 / 局外版**共用同一个 id**，本模块存的 id 即 relic id。
 * 有局外版的遗物用它的局内 id（1001~1293 段），只有局外版的遗物是 1294~1302。
 * （更早的两次数值/结构迁移：装备 id 1~45 → +2000 → 再并入遗物并用局内 id，见
 *  `tools/excel_export/reports/equipments-into-relics.md` 与 `reports/relics-scope-restructure.md`）
 *
 * ⚠ 2026-11：**局内抽到的遗物不再写进图鉴**（`scope` 含 outer 与不含的都一样，那条接线已删）。
 * 局外遗物只有一个来源 —— 图鉴页的「抽 取」。原来那笔会随局数把份数翻倍，见 `docs/meta-growth/README.md` §0.2。
 *
 * ── ⚠⚠ `collected` 为什么是**数组**而不是 `{id: count}` 字典 ──
 * `DataModule` 的深度合并（`mergeDeep`）**只认「默认数据里已经存在的 key」**：
 * 默认数据里 `collected` 是空对象 / 空数组时，`{1167: 2}` 这种**动态字典的键在 target 里一个都没有**，
 * 于是整片被 `continue` 掉 —— **读档等于没读**（实测：合并完 `collected` 还是 `{}`）。
 * 这在 2026-11 之前一直没暴露，因为那时 `addCollected` 的调用方（局内掉落接线）本身就是个漏洞、
 * 而图鉴"每次重启都归零"看起来只是"还没接数据"。
 * 现在抽到的遗物是**玩家花金币换来的**，读档丢一次就是真丢东西 ⇒ 必须走数组（口径同 `BagData.items`、
 * `TaskData.records`、`ShopData.itemUsed`）。
 * 旧存档里那种字典形态由 `migrateCollectedShape()` 在 `DataCenter.init()` 里就地转成数组。
 */

import { DataModule } from '../DataModule';
import { todayKey } from '../../common/DayKey';

/** 一件遗物的收集记录（**数组**元素；见文件头 ⚠⚠） */
export interface EquipCollectedRecord {
    /** 遗物 id（= relics.json 里**有局外版**的遗物 id） */
    id: number;
    /** 收集份数（可重复收集，属性按份数线性累加，无上限） */
    count: number;
}

/** 局外装备收集数据 */
export interface IEquipmentCollection {
    /** 已收集的遗物（**数组**，见文件头 ⚠⚠；只有 `count > 0` 的记录会被保留） */
    collected: EquipCollectedRecord[];
    /**
     * **当日抽取记账的日键**（`YYYYMMDD`，口径 = `common/DayKey.todayKey()`）。
     * 与 `drawPaidCount` 一起构成"当天第几抽"的判据 —— 跨天时 `getOuterDrawIndex()` 直接回 0，
     * 所以**不需要**在 `DataCenter.init()` 里再做一次对齐。
     */
    drawDayKey: string;
    /**
     * **当日已付费（花金币）的抽数** —— 局外遗物抽取价格阶梯的分子。
     *
     * ⚠ 它记的是**花金币的抽数**，不是"当天抽了几次"：用抽取券（`outer_draw_ticket`）抽
     * 既不扣金币、**也不抬阶梯**（与局内"广告免费刷新不抬高后续费用"逐字同口径）。
     * 见 `battle/OuterRelicDraw.costOfDraw` 与 `docs/meta-growth/README.md` §1.3。
     */
    drawPaidCount: number;
}

export class EquipmentCollectionModule extends DataModule<IEquipmentCollection> {
    constructor() {
        super('equip_collection');
    }

    protected defaultData(): IEquipmentCollection {
        return {
            collected: [],
            drawDayKey: '',
            drawPaidCount: 0,
        };
    }

    // ────────────── 收集操作 ──────────────

    /**
     * 添加收集一次装备
     * @param equipId 装备配置 ID（= relics.json 里**有局外版**的遗物 id：两侧都有的用局内 id，只有局外版的是 1294~1302）
     * @param count   收集次数（默认 1，装备掉落可指定数量）
     */
    addCollected(equipId: number, count: number = 1): void {
        if (count <= 0) return;
        // ⚠ 写之前先保证存量是数组：老存档的字典形态在这里兜一次底（`DataCenter.init()` 也会调，
        //   但那一步会因为"还没进游戏就崩/被跳过"而漏掉 —— 写入侧不能假定它跑过了）
        if (!Array.isArray(this.data.collected as unknown)) this.migrateCollectedShape();

        const list = this.data.collected;
        const rec = list.find(r => r.id === equipId);
        if (rec) rec.count += count;
        else list.push({ id: equipId, count });
    }

    /**
     * 获取某件装备的收集次数
     */
    getCollectedCount(equipId: number): number {
        return this._records().find(r => r.id === equipId)?.count ?? 0;
    }

    /**
     * 获取所有已收集的装备 ID 列表
     */
    getAllCollectedIds(): number[] {
        return this._records().filter(r => r.count > 0).map(r => r.id);
    }

    /**
     * 获取所有已收集装备及其次数（`{id: count}` 视图 —— 兼容旧调用方；
     * 存量本身是**数组**，见文件头 ⚠⚠。新代码优先用 `getCollectedCount`。）
     */
    getAllCollected(): Record<number, number> {
        const out: Record<number, number> = {};
        for (const r of this._records()) {
            if (r.count > 0) out[r.id] = r.count;
        }
        return out;
    }

    /**
     * 获取已收集装备的总种类数
     */
    getDistinctCount(): number {
        return this.getAllCollectedIds().length;
    }

    /**
     * 获取所有收集的总次数（含重复）
     */
    getTotalCollectionCount(): number {
        let total = 0;
        for (const r of this._records()) total += r.count;
        return total;
    }

    /**
     * 检查某件装备是否已收集过
     */
    hasCollected(equipId: number): boolean {
        return this.getCollectedCount(equipId) > 0;
    }

    // ────────────── 局外遗物抽取的当日记账 ──────────────

    /**
     * **当日已付费抽数**（价格阶梯的分子）—— 跨天自动回 0。
     *
     * ⚠ **纯读，不写盘**：日键对不上时只是"算作 0"，真正的落盘发生在
     * `setOuterDrawIndex()` 里（抽完之后）。这样它就能安全地被界面的
     * 每次重绘调用，而不会在"读的时候顺手改数据"（那套写法在本工程的响应式里最容易出事）。
     */
    getOuterDrawIndex(): number {
        if (this.data.drawDayKey !== todayKey()) return 0;
        return Math.max(0, Math.floor(this.data.drawPaidCount || 0));
    }

    /** 写回当日已付费抽数（**同时对齐日键** —— 跨天后第一次抽就把日键翻到新的一天） */
    setOuterDrawIndex(count: number): void {
        this.data.drawDayKey = todayKey();
        this.data.drawPaidCount = Math.max(0, Math.floor(count) || 0);
    }

    // ────────────── 旧存档迁移 ──────────────

    /**
     * **把旧存档里的字典形态就地转成数组**（`{1167: 2}` → `[{id:1167, count:2}]`）。
     *
     * 为什么需要它：`collected` 2026-11 之前是 `Record<number, number>`，读档时 `mergeDeep` 会把
     * 这种动态字典**整片吃掉**（见文件头 ⚠⚠）——但老存档里那个字典**还在** localStorage 里，
     * 而且因为默认值现在是数组，`mergeDeep` 走的是"数组直接覆盖"那一支 →
     * `this.data.collected` 会变成一个**对象**，后面 `.find` 之类当场炸。
     * 所以启动时（`DataCenter.init()`）把它转回来：老玩家已有的份数能救一点是一点。
     *
     * 幂等：已经是数组 / 是空的时候什么都不做。**不在这里打日志刷屏**（只在真转换时报一次）。
     * @returns 转换出来的条数（0 = 本来就不需要迁移）
     */
    migrateCollectedShape(): number {
        const raw = this.data.collected as unknown;
        if (Array.isArray(raw)) return 0;

        const out: EquipCollectedRecord[] = [];
        if (raw && typeof raw === 'object') {
            for (const key of Object.keys(raw as Record<string, unknown>)) {
                const id = Number(key);
                const count = Number((raw as Record<string, unknown>)[key]);
                if (Number.isFinite(id) && Number.isFinite(count) && count > 0) out.push({ id, count });
            }
        }
        this.data.collected = out;
        if (out.length) {
            console.log(`[遗物图鉴] 旧存档迁移：collected 从字典转成数组，救回 ${out.length} 种遗物`);
        }
        return out.length;
    }

    // ────────────── 内部 ──────────────

    /**
     * 收集记录（**唯一读入口**）。
     * ⚠ 它是**只读**的：老存档那种"还是字典"的中间态由 `migrateCollectedShape()` 在启动时统一处理，
     * 这里不再顺手改数据（在 getter 里写数据会在 watcher 回调里触发无谓的保存）。
     */
    private _records(): EquipCollectedRecord[] {
        const raw = this.data.collected as unknown;
        return Array.isArray(raw) ? (raw as EquipCollectedRecord[]) : [];
    }
}
