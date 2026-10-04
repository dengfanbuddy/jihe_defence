import { ref, type Ref } from '../../platform/reactivity';
import type { AdPlacement } from '../../platform/ad/AdMgr';
import { RandomUtil } from '../../platform/utils/RandomUtil';
import { ShopConfig } from '../data/configs/ShopConfig';
import type { KillBuffCfg, KillBuffStat } from '../excel_table/Tb_KillBuffConfig';
import { MODIFY_ATTR_TEMPLATE_ID } from './types';
import { AttributeType } from './core/Types';
import { evaluateRefreshGate, type RefreshGate } from './RefreshGate';
import type { Entity } from './Entity';

/**
 * BuffShop —— **局内击杀商店（Buff 商店）的完整功能封装**（纯 TS，无 cc 依赖）
 *
 * 数据源：`kill_buffs.json`（20 个「可重复购买、价格递增、层数封顶」的百分比 Buff）。
 *
 * ```
 *   ShopBuffPanel / ShopBuffItem      只渲染与上报
 *        ▲ provide 状态                  │ emit(BuffShopRefresh) / emit(BuffShopBought, buffId)
 *        ▼                               ▼
 *   BuffShop（本类）                  摊位抽取、价格与层数、购买校验、**属性施加**
 *        │
 *        ▼  hero.modifiers.AddModifier(MODIFY_ATTR_TEMPLATE_ID, kv.attrs)
 *   ModifierSystem / AttributeSystem  统一结算（本类不做任何属性计算）
 * ```
 *
 * ── 货币（**击杀数，不是金币**）──
 *   刷新摊位与买 Buff 都花**击杀数**（`useBattleStore().killPoints`，每杀 1 只 +1），
 *   金币只用于选英雄刷新与遗物抽取 —— 两条经济线互不抢资源（设计稿 §7.1 / §12.6）。
 *   真源与扣费口都由宿主注入（`deps.getKillPoints` / `deps.spendKillPoints`），本类不认识 store。
 *
 * ── 叠加方式（**唯一的属性口径**，见 `STAT_MODE`）──
 *   · `percent`：对**英雄基础属性**的百分比加成（`final = base × (1 + Σv/100)`），
 *     用于 base 非 0 的属性（攻击/生命/攻速/射程/回血）—— 语义就是「+8% 攻击力」
 *   · `add`：固定值叠加（配置 int 口径，百分数型属性 5 = 5 个百分点），
 *     用于 **base = 0 的属性**（护甲/闪避/暴击率）—— 它们用 percent 乘出来恒为 0
 *   · 每买一层 = **一条独立的 Modifier**（origin = `killbuff:{id}:{层}`），互不覆盖、各算各的，
 *     所以「层数」天然就是多条同类加成的叠加，不需要额外维护叠层
 *
 * ── 状态（`ref`，由宿主 `Scene_Game_Stage` provide 给 UI 子树）──
 *   `panelVisible` 面板开关（宿主/HUD 按它写面板节点 active）
 *   `slots`        4 个摊位的 Buff id（0 = 空摊）
 *   `stacks`       每个 Buff 已购层数（`{ [buffId]: 层数 }`，item 据此显示层数与下一层价格）
 *   `refreshCost`  刷新一次摊位的**击杀数**费用
 *   `adFreeLeft`   剩余「广告免费刷新」次数
 *
 * 规则常量（`shop_constants`，缺省走内置默认值）：`killBuffRefreshCost`（默认 50 击杀数）、
 *   `killBuffRefreshAdFreePerRun`（默认 1）、`killBuffMaxStackDefault`（默认 10，表里有 `max_stack` 以表为准）。
 *
 * ⚠ `stat = special` 的条目（走 `script_id` 的复杂机制）**不进摊位池**：行为尚未实现，
 *   放上去会变成"买了没效果"，所以直接过滤掉（配置保留，实现后把池子过滤条件放开即可）。
 */
export interface BuffShopDeps {
    /** 本局英雄实体（属性/效果的施加目标）；还没选英雄时为 null */
    getHero(): Entity | null;
    /** 读本局**击杀数余额**（击杀商店的唯一货币；真源 = `useBattleStore().killPoints`） */
    getKillPoints(): number;
    /** 扣击杀数；返回 false = 余额不足（宿主负责同步 HUD / store） */
    spendKillPoints(amount: number): boolean;
    /** 拉激励视频（宿主实现，通常包一层"播放期间暂停战斗"） */
    playAd(placement: AdPlacement): Promise<boolean>;
    /**
     * 成就效果 `kill_buff_discount` —— 击杀商店价格的折扣**比例**
     * （宿主从**开局快照**取：配表百分数 / 100，`10` → `0.1` = 打 9 折；未注入 / 未生效 = 0）。
     *
     * ⚠ 本类**不许**自己调 `AchievementData.getEffects()`（实时值会让"打到一半价格突然变了"）。
     */
    getAchPriceDiscount?(): number;
    /**
     * 真的买成一个 Buff 之后回调（宿主用它上报成就进度 `buff_types` 的「种类数」）。
     * 走回调而不是 `import DataCenter`：本类是纯 TS 战斗功能类，分层口径同 `SkillSlots.onSkillGranted`。
     */
    onBuffBought?(buffId: number): void;
}

/** 每个 stat 的叠加方式（`percent` = 相对基础值；`add` = 固定值，用于 base=0 的属性） */
const STAT_MODE: Record<KillBuffStat, 'percent' | 'add'> = {
    atk: 'percent',
    hp: 'percent',
    range: 'percent',
    regen: 'percent',
    aspd: 'percent',
    // 百分数型属性且英雄 base = 0 → percent 乘出来恒为 0（项目口径：一律 add + 配置值 = 百分点）
    crit: 'add',
    dodge: 'add',
    // 护甲 base = 0，同样只有固定值才有意义
    def: 'add',
    special: 'add',
};

/** stat → 属性编号兜底（表里 `attr_id` 齐全时以表为准；缺列时用它，避免整条 Buff 失效） */
const STAT_ATTR: Record<KillBuffStat, number> = {
    atk: AttributeType.Atk,
    hp: AttributeType.MaxHp,
    range: AttributeType.AtkRange,
    def: AttributeType.Def,
    aspd: AttributeType.AtkSpeed,
    crit: AttributeType.CritRate,
    dodge: AttributeType.Evasion,
    regen: AttributeType.HpRegen,
    special: -1,
};

/**
 * BuffShop 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束面板/item 能碰什么）。
 *
 * 关键的一条：**价格与可买性也走门面**（`stackOf / maxStackOf / nextPriceOf / canBuy`）。
 * `ShopBuffItem` 原来自己重算 `Math.max(1, cfg.max_stack ?? 1)` 与价格公式 ——
 * 与这里口径不同（缺省值是 `killBuffMaxStackDefault` = 10 而非 1），一旦表里有行不写 `max_stack`，
 * UI 会在第 1 层就显示"已满"而 `buy()` 其实允许买到 10 层。现在口径只有一处。
 *
 * ⚠ **动作不在只读面上**（`open/close/refresh/buy/reset/syncCost` 都不声明）：
 *   UI 只 `scope.emit` 向上，由宿主转交。
 */
export interface BuffShopVM {
    /** 面板是否显示 */
    readonly panelVisible: Ref<boolean>;
    /** 4 个摊位的 Buff id（0 = 空摊） */
    readonly slots: Ref<number[]>;
    /** 每个 Buff 的已购层数（item 据此显示层数/上限与下一层价格） */
    readonly stacks: Ref<Record<number, number>>;
    /** 刷新一次摊位的**击杀数**费用 */
    readonly refreshCost: Ref<number>;
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number>;
    /** 刷新按钮的判据（唯一真源；面板只画，不再自己重算） */
    refreshGate(): RefreshGate;
    /** 该 Buff 当前已购层数 */
    stackOf(buffId: number): number;
    /** 该 Buff 的层数上限（表里的 `max_stack`，缺省走 `shop_constants.killBuffMaxStackDefault`） */
    maxStackOf(cfg: KillBuffCfg | undefined): number;
    /** 该 Buff **下一层**的价格（已满级返回 0） */
    nextPriceOf(buffId: number): number;
    /** 现在能不能买（未满级 且 击杀数够） */
    canBuy(buffId: number): boolean;
}

export class BuffShop {

    /* ===== 页面级状态（宿主 provide 给 UI 子树） ===== */

    /** 面板是否显示 */
    readonly panelVisible: Ref<boolean> = ref(false);
    /** 4 个摊位的 Buff id（0 = 空摊） */
    readonly slots: Ref<number[]> = ref<number[]>([]);
    /** 每个 Buff 的已购层数（`{ [buffId]: 层数 }`） */
    readonly stacks: Ref<Record<number, number>> = ref<Record<number, number>>({});
    /** 刷新一次摊位的**击杀数**费用 */
    readonly refreshCost: Ref<number> = ref(0);
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number> = ref(0);

    /** 已用掉的广告免费刷新次数（属于一局） */
    private adFreeUsed = 0;
    /** 本局累计花掉的击杀数（统计/日志用） */
    private spentPoints = 0;

    private deps: BuffShopDeps;

    constructor(deps: BuffShopDeps) {
        this.deps = deps;
        this.syncCost();
    }

    /* ===================================================================
     * 入口：开 / 关面板
     * =================================================================== */

    /** 打开面板（入口按钮点击）；还没选英雄时拒绝并打日志 */
    open(): void {
        if (!this.deps.getHero()) {
            console.warn('[Buff商店] 还没选英雄，忽略打开面板');
            return;
        }
        // 首次打开先白送一摊（**首次摆摊不收费**；之后点「刷新」才花击杀数/看广告）
        if (!this.slots.value.some((id) => id > 0)) this.rollStalls();
        this.panelVisible.value = true;
    }

    /** 关闭面板 */
    close(): void {
        this.panelVisible.value = false;
    }

    /* ===================================================================
     * 摊位刷新
     * =================================================================== */

    /**
     * 刷新按钮的判据（**唯一真源**）：击杀数够 → 直接扣；不够但还有广告免费次数 → 看广告；都没有 → 置灰。
     * 面板拿它画按钮，`refresh()` 拿它做准入。
     */
    refreshGate(): RefreshGate {
        return evaluateRefreshGate(this.deps.getKillPoints(), this.refreshCost.value, this.adFreeLeft.value);
    }

    /** 现在能不能刷新（= 判据的 `enabled`；给日志/宿主查询用） */
    canRefresh(): boolean {
        return this.refreshGate().enabled;
    }

    /**
     * 刷新 4 个摊位 —— 准入用的就是 `refreshGate()` 那一份判据：
     *   ① 击杀数 ≥ 费用 → 扣费重抽；② 击杀数不够但还有广告免费次数 → 看广告重抽；③ 都不行 → 拒绝并打日志
     */
    refresh(): void {
        const cost = this.refreshCost.value;
        const gate = this.refreshGate();
        if (gate.canPay) {
            if (!this.deps.spendKillPoints(cost)) {
                console.warn(`[Buff商店] 击杀数不足，刷新失败（${this.deps.getKillPoints()}/${cost}）`);
                return;
            }
            this.spentPoints += cost;
            this.rollStalls();
            return;
        }
        if (!gate.viaAd) {
            console.warn(`[Buff商店] 击杀数不足（${this.deps.getKillPoints()}/${cost}）且没有广告免费次数，刷新被拒`);
            return;
        }
        this.deps.playAd('buff_shop_refresh').then((ok) => {
            if (!ok) return;
            this.adFreeUsed++;
            this.syncCost();
            this.rollStalls();
        });
    }

    /** 从未满级的 Buff 池里等权抽 4 个摊位（不重复） */
    private rollStalls(): void {
        const pool = this.pool();
        if (!pool.length) {
            console.warn('[Buff商店] kill_buffs 里没有可买的 Buff（都需要 attr_id 与 per）');
            this.slots.value = [];
            return;
        }
        const count = Math.min(ShopConfig.getOptionCount(), pool.length);
        const ids = RandomUtil.getRandomElements(pool.map((c) => c.id), count);
        // 不足 4 个时补 0（空摊），槽位数与面板上的 item 数一致
        while (ids.length < ShopConfig.getOptionCount()) ids.push(0);
        this.slots.value = ids;

        console.log(`[Buff商店] 摊位刷新：${ids.filter((id) => id > 0).map((id) => ShopConfig.getKillBuff(id)?.name ?? id).join(' / ')}`);
    }

    /* ===================================================================
     * 购买
     * =================================================================== */

    /** 该 Buff 当前已购层数 */
    stackOf(buffId: number): number {
        return this.stacks.value[buffId] ?? 0;
    }

    /** 该 Buff 的层数上限（表里的 `max_stack`，缺省走 shop_constants.killBuffMaxStackDefault） */
    maxStackOf(cfg: KillBuffCfg | undefined): number {
        if (!cfg) return 0;
        return Math.max(1, cfg.max_stack ?? ShopConfig.getNumber('killBuffMaxStackDefault', 10));
    }

    /**
     * 第 `stack` 层（1 起）的**实付价格** = 配置价 × (1 − 成就折扣)，四舍五入取整。
     *
     * ⚠ **价格只有这一条口径**：面板显示（`nextPriceOf`）与实际扣费（`buy`）都走它 ——
     *   只改一处会出现「面板显示 90、实际扣 100」。
     * ⚠ 折扣是**比例**（配表百分数 / 100：`10` → `0.1` = 打 9 折），不是"减多少钱"。
     */
    private priceOf(cfg: KillBuffCfg, stack: number): number {
        const base = ShopConfig.getKillBuffPrice(cfg, stack);
        const raw = this.deps.getAchPriceDiscount?.() ?? 0;
        const discount = Math.max(0, Math.min(1, raw));
        return Math.max(0, Math.round(base * (1 - discount)));
    }

    /** 该 Buff **下一层**的价格（当前层数 + 1；已满级返回 0） */
    nextPriceOf(buffId: number): number {
        const cfg = ShopConfig.getKillBuff(buffId);
        if (!cfg) return 0;
        const stack = this.stackOf(buffId);
        if (stack >= this.maxStackOf(cfg)) return 0;
        return this.priceOf(cfg, stack + 1);
    }

    /** 该 Buff 现在能不能买（未满级 且 击杀数够） */
    canBuy(buffId: number): boolean {
        const price = this.nextPriceOf(buffId);
        return price > 0 && this.deps.getKillPoints() >= price;
    }

    /**
     * 购买一层（item 点选冒泡上来）。
     *
     * 校验顺序：摊位里确实有这个 Buff → 未满级 → 击杀数够 → 扣掉击杀数 → **属性当场生效** → 层数 +1（UI 自动刷新价格）。
     * @returns 是否购买成功
     */
    buy(buffId: number): boolean {
        if (this.slots.value.indexOf(buffId) < 0) {
            console.warn(`[Buff商店] 买的不是本摊位的 Buff：${buffId}（可能刚刷新过）`);
            return false;
        }
        const hero = this.deps.getHero();
        if (!hero) {
            console.warn('[Buff商店] 还没选英雄，无法购买');
            return false;
        }
        const cfg = ShopConfig.getKillBuff(buffId);
        if (!cfg) {
            console.warn(`[Buff商店] 未找到 Buff 配置：${buffId}`);
            return false;
        }

        const stack = this.stackOf(buffId);
        const maxStack = this.maxStackOf(cfg);
        if (stack >= maxStack) {
            console.warn(`[Buff商店] ${cfg.name} 已满 ${maxStack} 层`);
            return false;
        }

        const price = this.priceOf(cfg, stack + 1);
        if (!this.deps.spendKillPoints(price)) {
            console.warn(`[Buff商店] 击杀数不足（${this.deps.getKillPoints()}/${price}），买不了 ${cfg.name}`);
            return false;
        }

        const level = stack + 1;
        this.applyStack(cfg, level, hero);
        this.spentPoints += price;
        // 换新对象：面板/item 靠 watch(stacks) 刷新层数与价格
        this.stacks.value = { ...this.stacks.value, [buffId]: level };

        console.log(`[Buff商店] 获得「${cfg.name}」${level}/${maxStack} 层（${cfg.per_desc ?? ''}），花费 ${price} 击杀数`);
        // 成就进度：买过的击杀商店 Buff **种类**（target=buff_types；只记新种类，重复购买同一 Buff 不推进）
        // —— 上报交给宿主（本类不认识数据层，见 deps.onBuffBought 的注释）
        this.deps.onBuffBought?.(buffId);
        return true;
    }

    /* ===================================================================
     * 生命周期
     * =================================================================== */

    /**
     * 换英雄：把已买的 Buff 原样重新挂到新实体上。
     *
     * 「重新选英雄后等级/经验/装备/Buff 都不变」——Buff 由本类持有层数（不属于英雄实体），
     * 旧实体连同它的 ModifierSystem 一起被销毁，所以这里按层重放一遍即可（与
     * `RelicSystem.RebindOwner` 同一口径，宿主在换英雄后调用）。
     */
    rebind(): void {
        const hero = this.deps.getHero();
        if (!hero) return;
        for (const buffId of this.purchasedIds()) {
            const cfg = ShopConfig.getKillBuff(buffId);
            if (!cfg) continue;
            const stack = this.stackOf(buffId);
            for (let level = 1; level <= stack; level++) this.applyStack(cfg, level, hero);
        }
        if (this.purchasedIds().length) {
            console.log(`[Buff商店] 换英雄：已把 ${this.purchasedIds().length} 种 Buff 重挂到新英雄上`);
        }
    }

    /** 换局复位：摊位清空、层数归零、面板收起、广告次数归零（**已生效的 Modifier 随旧实体一起作废**） */
    reset(): void {
        this.adFreeUsed = 0;
        this.spentPoints = 0;
        this.slots.value = [];
        this.stacks.value = {};
        this.panelVisible.value = false;
        this.syncCost();
    }

    /** 把费用与广告剩余次数同步给面板（构造 / 刷新后 / 换局后） */
    syncCost(): void {
        // 费用单位 = **击杀数**（配置键 `killBuffRefreshCost`，缺省 50）
        this.refreshCost.value = Math.max(0, ShopConfig.getNumber('killBuffRefreshCost', 50));
        const limit = Math.max(0, ShopConfig.getNumber('killBuffRefreshAdFreePerRun', 1));
        this.adFreeLeft.value = Math.max(0, limit - this.adFreeUsed);
    }

    /* ===================================================================
     * 查询
     * =================================================================== */

    /** 已购买的 Buff id 列表 */
    purchasedIds(): number[] {
        return Object.keys(this.stacks.value).map(Number).filter((id) => this.stackOf(id) > 0);
    }

    /** 本局在 Buff 商店花掉的**击杀数**（刷新 + 购买；统计用） */
    getSpentKillPoints(): number { return this.spentPoints; }

    /* ===================================================================
     * 内部：属性施加
     * =================================================================== */

    /**
     * 施加第 `level` 层的加成 —— 走**「属性修改」共享模板 Modifier**（`MODIFY_ATTR_TEMPLATE_ID` = 1000），
     * 属性/数值/叠加方式全在 `kv.attrs` 里；`duration = -1` = 永久。
     *
     * origin 带上层号（`killbuff:{id}:{level}`）：同一 Buff 的每一层都是**独立实例**，
     * 各自贡献一份加成（不会被 stack_mode 合并掉），也就天然实现了"层数叠加"。
     */
    private applyStack(cfg: KillBuffCfg, level: number, hero: Entity): void {
        const attrId = cfg.attr_id ?? STAT_ATTR[cfg.stat];
        const per = cfg.per ?? 0;
        if (!attrId || attrId < 0 || !per) {
            console.warn(`[Buff商店] ${cfg.name} 没有可施加的属性（stat=${cfg.stat}, attr_id=${cfg.attr_id}, per=${cfg.per}）——special 类需要行为实现`);
            return;
        }
        if (!hero.modifiers) {
            console.warn('[Buff商店] 英雄实体上没有 ModifierSystem，Buff 无法生效');
            return;
        }

        const mode = STAT_MODE[cfg.stat] ?? 'percent';
        // 满血口径：加成里若含最大生命，满血时当前生命同步 +ΔmaxHp（残血时只抬上限），
        // 与遗物同一套规则（Entity.ApplyWithMaxHpCarry）
        hero.ApplyWithMaxHpCarry(() => hero.modifiers.AddModifier(
            MODIFY_ATTR_TEMPLATE_ID,
            hero,
            -1,                                              // -1 = 永久（本局有效）
            { attrs: [[attrId, per, mode]] },                // 属性 / 数值 / 叠加方式
            `killbuff:${cfg.id}:${level}`,                   // 每层独立实例
        ));
    }

    /** 摊位池：有属性可施加的 Buff（`special` 型暂无行为实现，不进池） */
    private pool(): KillBuffCfg[] {
        return ShopConfig.getKillBuffs().filter((cfg) => {
            if (cfg.stat === 'special') return false;
            const attrId = cfg.attr_id ?? STAT_ATTR[cfg.stat];
            return !!attrId && attrId > 0 && (cfg.per ?? 0) > 0;
        });
    }
}
