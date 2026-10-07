import { BattleConstUtil } from './core/BattleConstUtil';
import { getOuterRelicCfgs } from '../excel_table/Tb_RelicConfig';
import type { RelicCfg, RelicRarity } from '../excel_table/Tb_RelicConfig';

/**
 * OuterRelicDraw —— **局外遗物抽取规则**（纯函数、无状态、无 cc 依赖、**不碰数据层**）
 *
 * 只回答三个问题：「这一抽出哪件」「这一抽该花多少」「勾了十连该怎么付」。
 * 扣钱 / 记图鉴 / 存档全部由 `DataCenter.drawOuterRelic` 做（与 `RelicDraw` ↔ `RelicShop`
 * 的分工逐字对称）—— 这样规则能被体检脚本直接跑，不必起界面、也不必造存档。
 *
 * ── 规则口径（口径真源 `docs/meta-growth/README.md` §1，本文件不含任何数值）──
 *   · **池子**：`scope` 含 `outer` 的那 37 件局外遗物（由调用方传入，本文件不查表）
 *   · **两步抽取**：① 掷品质（白 6 / 蓝 2.5 / 紫 1 / 红 0.5）
 *                  ② 在**该品质档内**优先给「还没收集过的」；这一档集齐了才等概率随机重复
 *     —— 第 ② 步的作用只有一个：**让图鉴能集齐**（否则 10% 的紫档要在 11 件里靠运气凑齐）
 *   · **价格阶梯**：`当天第 N 抽（N 从 1 起）= min(base + step × (N-1), cap)`
 *     `cap = 0` 表示不封顶；**只有花金币的抽才抬价**（券抽不抬）
 *   · **每天 0 点回到 base**：日键口径见 `common/DayKey`，**由数据层记**（本文件只接收"当日已付费抽数"）
 *   · **份数无上限**：同一件可以反复抽到（属性按份数线性累加），所以本文件**不做去重**，十连里重复是正常的
 *
 * ── 为什么「先出方案、再照方案执行」──
 * 界面要显示消耗、`DataCenter` 要真的扣钱 —— 两处各算一遍迟早出现「按钮写着 200、实际扣 300」。
 * 所以这里只有一个 `plan()`：**它产出的 `steps` 就是最终会执行的那几步**，
 * 界面拿它拼文案、`DataCenter` 拿它逐步执行（与商城的 `previewShopDailyGift` 同一套路）。
 */
export class OuterRelicDraw {

    /* ===================================================================
     * 抽取规则
     * =================================================================== */

    /**
     * **局外池** = `relics.json` 里 `scope` 含 `outer` 的那 37 件（过滤口径只有一份，
     * 在 `Tb_RelicConfig.getOuterRelicCfgs`；这里只是转发，与 `RelicDraw.skillPool` ↔ `ShopConfig` 同形）。
     *
     * ⚠ 另外 240 件只有局内版的遗物**不进池** —— 抽出来没有局外属性，等于白抽。
     */
    static outerPool(): RelicCfg[] {
        return getOuterRelicCfgs();
    }

    /** 品质档位（**从低到高**，与权重数组同序；顺序只影响日志可读性，不影响抽取） */
    static readonly RARITY_ORDER: RelicRarity[] = ['common', 'rare', 'epic', 'legendary'];

    /**
     * 四档品质的抽取权重（**固定值**，不随任何等级/阶段变化 —— 局外抽取没有"关卡"语境）。
     * 折算概率：白 60% / 蓝 25% / 紫 10% / 红 5%。
     * ⚠ 与"池子里各档有几件"是**两件事**：池子里紫+红占 17/37，但抽到的概率只有 15%。
     */
    static readonly RARITY_WEIGHT: Record<RelicRarity, number> = {
        common: 6,
        rare: 2.5,
        epic: 1,
        legendary: 0.5,
    };

    /** 「十连抽」= 一次抽几个（界面的勾选框选中时用它；改这里就是改十连的档位） */
    static readonly TEN_DRAW_COUNT = 10;

    /** 一次最多能抽几个（防呆：请求值再大也只抽这么多） */
    static readonly MAX_DRAW = OuterRelicDraw.TEN_DRAW_COUNT;

    /**
     * **当天第 `index` 次「付费抽」**的价格（`index` 从 0 起 = 当天第一次）。
     *
     * `价格 = min(base + step × index, cap)`，`cap = 0` 表示不封顶。
     * 例（base 200 / step 100 / cap 600）：`200 / 300 / 400 / 500 / 600 / 600 / …`
     *
     * ⚠ **只有花金币的抽才消耗 `index`**：用券抽既不扣金币、也不抬阶梯（与局内
     *   "广告免费刷新不抬高后续费用" 逐字同口径），所以调用方传进来的必须是
     *   **当日已付费抽数**，而不是"当天抽了几次"。
     */
    static costOfDraw(index: number): number {
        const n = Math.max(0, Math.floor(index) || 0);
        const base = BattleConstUtil.getOuterDrawCostBase();
        const step = BattleConstUtil.getOuterDrawCostStep();
        const cap = BattleConstUtil.getOuterDrawCostCap();
        const raw = base + step * n;
        return cap > 0 ? Math.min(raw, cap) : raw;
    }

    /**
     * 掷品质（按 `RARITY_WEIGHT` 加权）。
     * 权重全配成 0 时退化成最低档（白），**不抛异常** —— 图鉴页抽不出东西比报错更难查。
     */
    static rollRarity(): RelicRarity {
        const weights = OuterRelicDraw.RARITY_ORDER.map((r) => Math.max(0, OuterRelicDraw.RARITY_WEIGHT[r] ?? 0));
        const total = weights.reduce((s, v) => s + v, 0);
        if (total <= 0) return OuterRelicDraw.RARITY_ORDER[0];
        let r = Math.random() * total;
        for (let i = 0; i < weights.length; i++) {
            r -= weights[i];
            if (r <= 0) return OuterRelicDraw.RARITY_ORDER[i];
        }
        return OuterRelicDraw.RARITY_ORDER[OuterRelicDraw.RARITY_ORDER.length - 1];
    }

    /**
     * 抽一件局外遗物。
     *
     * @param pool   局外池（`scope` 含 `outer` 的那 37 件；空池返回 null）
     * @param ownedOf `id → 已收集份数`（0 = 还没收集过）。传函数而不是传 `EquipmentCollection`：
     *                本文件要保持可被体检脚本直接跑，不依赖任何数据模块。
     * @returns 抽中的那件配置（池子为空时 null）
     */
    static roll(pool: RelicCfg[], ownedOf: (id: number) => number): RelicCfg | null {
        if (!pool || !pool.length) return null;
        const owned = (r: RelicCfg) => Math.max(0, Math.floor(ownedOf(r.id) || 0));

        const tier = OuterRelicDraw.rollRarity();
        const inTier = pool.filter((r) => r.rarity === tier);
        const hit = OuterRelicDraw.pickInTier(inTier, owned)
            // 这一档池子里一件都没有（配表被改窄了 / 品质拼写变了）→ 退回全池，别让这一抽落空
            ?? OuterRelicDraw.pickInTier(pool, owned);
        return hit;
    }

    /**
     * 在**一个品质档内**取一件：**优先未收集**，这一档集齐了才等概率随机重复。
     *
     * 「优先未收集」**不是**"抽不到已有的" —— 它是"这一档还有没收集的就**必出那一件**"，
     * 作用是让图鉴能集齐（否则紫档要集齐 11 件就成了纯运气）。收集齐之后回到纯随机（份数无上限）。
     */
    static pickInTier(tier: RelicCfg[], owned: (r: RelicCfg) => number): RelicCfg | null {
        if (!tier || !tier.length) return null;
        const fresh = tier.filter((r) => owned(r) <= 0);
        const from = fresh.length ? fresh : tier;
        return from[Math.floor(Math.random() * from.length)] ?? null;
    }

    /* ===================================================================
     * 付费方案（界面显示的数 == 真正扣的数，唯一真源）
     * =================================================================== */

    /**
     * 排一次抽取的**付费方案** —— 这就是最终会执行的那几步，不多不少。
     *
     * 优先级（`docs/meta-growth/README.md` §1.6）：**先用券，券不够才花金币**。
     * 花金币的那几步按当日价格阶梯**逐个累加**（第 1 步 `costOfDraw(paidIndex)`、第 2 步 `+1` …），
     * 所以「十连」的价钱 = 接下来 10 抽的价格之和，与"连点 10 次单抽"**分毫不差**（没有十连折扣）。
     *
     * @param count    想抽几个（1 = 单抽，10 = 十连）
     * @param paidIndex 当日**已付费**抽数（阶梯的起点；日键由数据层管）
     * @param ticketLeft 背包里的局外遗物抽取券张数
     * @param gold     手上的金币（**只用来判断"买得起几步"**，本方法不扣钱）
     * @returns 抽得起的那些步（`steps.length` 可能 < `count`；0 = 一次都抽不动）
     */
    static plan(count: number, paidIndex: number, ticketLeft: number, gold: number): OuterDrawPlan {
        const want = Math.max(0, Math.floor(count) || 0);
        const tickets = Math.max(0, Math.floor(ticketLeft) || 0);
        const balance = Math.max(0, Math.floor(gold) || 0);
        let wallet = balance;
        let index = Math.max(0, Math.floor(paidIndex) || 0);
        let ticketsLeft = tickets;

        const steps: OuterDrawStep[] = [];
        for (let i = 0; i < want; i++) {
            if (ticketsLeft > 0) {
                // 券在金币之前：不扣金币、**也不抬当日价格阶梯**
                ticketsLeft--;
                steps.push({ viaTicket: true, cost: 0 });
                continue;
            }
            const cost = OuterRelicDraw.costOfDraw(index);
            if (cost > wallet) break; // 买不起了：就此打住（已经排好的那几步照常执行）
            wallet -= cost;
            index++;
            steps.push({ viaTicket: false, cost });
        }

        const goldDraws = steps.filter((s) => !s.viaTicket).length;
        return {
            steps,
            ticketUse: steps.length - goldDraws,
            goldDraws,
            goldCost: steps.reduce((s, x) => s + x.cost, 0),
        };
    }

    /**
     * 付费方案的**一行文案**（界面按钮上那行消耗）。
     *
     * 文案只有这一处实现：界面不许自己拼（`券` 与 `金币` 的比例一变，
     * 两处各拼一遍必然出现"显示花金币、其实扣了券"）。
     */
    static formatCost(plan: OuterDrawPlan): string {
        if (!plan || !plan.steps.length) return '—';
        return OuterRelicDraw.formatSpent(plan.ticketUse, plan.goldCost);
    }

    /** 消耗文案（**抽完之后**报实际花掉的那份也走它 —— 与按钮上显示的逐字同形） */
    static formatSpent(ticketUse: number, goldCost: number): string {
        const tickets = Math.max(0, Math.floor(ticketUse) || 0);
        const gold = Math.max(0, Math.floor(goldCost) || 0);
        if (tickets > 0 && gold > 0) return `券${tickets} 金币${gold}`;
        if (tickets > 0) return `抽取券 ${tickets}`;
        if (gold > 0) return `金币 ${gold}`;
        return '—';
    }
}

/** 抽取方案里的一步（`viaTicket` 时 `cost` 恒为 0） */
export interface OuterDrawStep {
    /** true = 这一抽用**局外遗物抽取券**（不扣金币、也不抬当日价格阶梯） */
    viaTicket: boolean;
    /** 这一抽要花多少金币 */
    cost: number;
}

/** 一次抽取（单抽 / 十连）的付费方案 —— 见 `OuterRelicDraw.plan` */
export interface OuterDrawPlan {
    /** 真正会执行的那几步（顺序即抽取顺序） */
    steps: OuterDrawStep[];
    /** 会用掉几张券 */
    ticketUse: number;
    /** 需要花金币的抽数 */
    goldDraws: number;
    /** 这些金币抽的总价 */
    goldCost: number;
}
