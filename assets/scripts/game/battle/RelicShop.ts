import { ref, type Ref } from '../../platform/reactivity';
import type { AdPlacement } from '../../platform/ad/AdMgr';
import { RelicDraw, type ShopOption, type ShopOptionKind } from './RelicDraw';
import { evaluateRefreshGate, type RefreshGate } from './RefreshGate';
import type { RelicSystem } from './BattleEquipSystem';
import type { SkillSlots } from './SkillSlots';

/**
 * RelicShop —— **局内肉鸽商店的完整功能封装**（纯 TS，无 cc 依赖）
 *
 * 把「入口 → 面板 → 刷新 → 选中 → 发放」这一整套流程从 `Scene_Game_Stage` 里抽出来：
 * 场景只负责**持有节点 + 接线 + 提供平台能力**（金币真源、广告、暂停策略），
 * 面板与 item 只负责**渲染 + 上报**。层级（规则/流程/状态/表现各归各的）：
 *
 * ```
 *   ShopRelicsPanel / ShopRiItem      只渲染与上报（scope.emit）
 *        ▲ provide 状态 / 收事件          │ emit(RelicRefresh) / emit(RelicPicked, id, viaAd)
 *        │                                ▼
 *   RelicShop（本类）                  本局商店状态（抽了几次 / 广告用了几次 / 本轮候选 / 本轮选没选过）
 *        │                               ＋交互流程（能不能抽、要不要看广告、选中后发放到哪）
 *        ▼
 *   RelicDraw                         抽取规则（混合池：品质权重 / 阶段门槛 / 越阶 / 技能配额 / 去重）
 *        ├──▶ RelicSystem（BattleEquipSystem）  遗物：入背包 + 挂 modifiers_inner（属性/被动当场生效）
 *        └──▶ SkillSlots                        技能：写入技能槽（升级 / 填空槽 / 替换未锁定槽）
 * ```
 *
 * ── 混合池（2026-09）──
 *   一轮会同时出**遗物**和**肉鸽额外技能**，技能个数由**技能配额**先定好
 *   （`shop_constants.skillDrawChance` 掷有没有技能 → `skillCountWeight` 掷 1 个还是 2 个，
 *   上限 `skillMaxPerDraw`），剩下的格子全是遗物。两者走**两条不同的发放通道**：
 *     遗物 → `RelicSystem.AddRelic`（本局唯一，重复获得被拒）
 *     技能 → `SkillSlots.grant`（重复抽到 = 升级；没满级的技能会一直留在池子里）
 *
 * ── 状态（`ref`，由宿主 `Scene_Game_Stage` provide 给 UI 子树的**只读门面 `RelicShopVM`**，键见 `StageScope`）──
 *   `panelVisible` 面板开关（宿主按它写面板节点 active）
 *   `slots`        本次抽取的格子展示状态（**格数 = `RelicDraw.optionCount()`**，默认 4、成就效果可 +1；
 *                  空槽 / 已被选走 → id 0；见 `ShopSlotVM`）
 *   `rollUsed`     本次刷新是否已选过（已选 → 剩余槽位置灰）
 *   `adMode`       剩余槽位是否转为「看广告才能选」（广告补选）
 *   `refreshCost`  下一次刷新的金币费用（面板显示 + 置灰判据；**含成就折扣**）
 *   `adFreeLeft`   剩余「广告免费刷新」次数（**含成就加成**）
 *
 * ── 成就特殊效果（全部走宿主的**开局快照**，经 `RelicShopDeps` 的 `getAch*` 注入）──
 *   `shop_draw_discount` 抽取费用折扣比例 → `drawCostNow()`（显示与实扣同一口径）
 *   `shop_option_plus`   每次抽取的额外候选数 → `RelicDraw.optionCount(bonus)`
 *   `ad_free_draw`       额外广告免费抽次数 → `RelicDraw.adFreeDrawLimit(bonus)`（叠加在配置上）
 *   `relic_start_gift`   开局白送遗物件数 → `grantStartGift()`（复用 `RelicDraw.relicPool` 纯函数）
 *   ⚠ 本类**不自己读** `AchievementData`：实时读会让"打到一半费用/选项数突然变"，与设计稿 §5.2 相反。
 *
 * ── 生命周期 ──
 *   本类随**界面**创建一次（宿主 `onLoad`，它持有的状态要 provide 给 UI 子树）；
 *   它自己持有的计次（抽了几次 / 广告用了几次）属于**一局**，由宿主在换局时调 `reset()`；
 *   背包（`RelicSystem`）与技能槽（`SkillSlots`）也属于一局，通过 getter 延迟取（未选英雄时为 null，内部一律空判）。
 *
 * @example
 * ```ts
 * // 宿主（Scene_Game_Stage）：onLoad 建一次并把状态 provide 出去
 * this.relicShop = new RelicShop({
 *     getBag: () => this.heroRelics,
 *     getSkillSlots: () => this.skillSlots,
 *     getGold: () => this.battleStore.gold,
 *     spendGold: (n) => this.spendGold(n),
 *     getHeroLevel: () => this.battleStore.level ?? 1,
 *     getPhase: () => this.stage,
 *     playAd: (p) => this.playRewardAd(p),
 *     onSkillAllLocked: () => this.uiView.showFloatText('技能槽已全部锁定'),
 * })
 * ```
 */

/** 商店一个格子的**展示状态**（宿主 provide 给面板；面板只读渲染） */
export interface ShopSlotVM {
    kind: ShopOptionKind;
    /** 遗物/技能 id（**0 = 空槽**：还没抽到 / 已被选走 / 这次选不了） */
    id: number;
    /** 技能当前**已拥有**的等级（0 = 未拥有；>0 表示这次选中是升级） */
    level: number;
    /** 技能最高等级（遗物恒 1） */
    maxLevel: number;
    /** 这一格现在能不能点（已选过 / 已被拒 → false，面板置灰） */
    selectable: boolean;
}

export interface RelicShopDeps {
    /** 本局的遗物背包（随一局创建：选完英雄才有 → 可能为 null，本类内部空判） */
    getBag(): RelicSystem | null;
    /** 本局的技能槽（同上，可能为 null） */
    getSkillSlots(): SkillSlots | null;
    /** 读本局金币（真源 `hero.gold`，与 HUD 显示同一口径） */
    getGold(): number;
    /** 扣金币；返回 false = 余额不足（宿主负责同步 HUD / store） */
    spendGold(amount: number): boolean;
    /** 抽取用的英雄等级（决定品质概率档位，见 shop_draw） */
    getHeroLevel(): number;
    /** 当前阶段（1 起；决定 stage 门槛） */
    getPhase(): number;
    /**
     * 拉激励视频。**由宿主实现**（通常要包一层"播放期间暂停战斗"）；
     * 未接入 SDK 时的兜底策略也在宿主 / `AdMgr` 那一层，本类只认 true = 看完。
     */
    playAd(placement: AdPlacement): Promise<boolean>;
    /**
     * 选中了技能、但**一个未锁定的技能槽都没有**时的提示钩子（宿主负责飘字 / 弹条）。
     * 不提供就只打日志。
     */
    onSkillAllLocked?(option: ShopOption): void;

    /* ── 成就特殊效果（**全部走开局快照**，宿主 getter 返回本局开局读到的值）──
     * ⚠ 语义：本类**不许**自己调 `AchievementData.getEffects()`（那是实时的，会让"打到一半突然多一个商店选项"）。
     *   未注入 / 未生效时一律按 0 处理（`??` 兜底），所以不接线也能跑。 */

    /** `shop_draw_discount` —— 抽取费用折扣**比例**（配表百分数 / 100：`10` → `0.1` = 打 9 折） */
    getAchDrawDiscount?(): number;
    /**
     * 遗物属性「24 抽卡折扣」—— 同样返回**比例**（运行时 0.35 = 打 6.5 折）。
     * 与成就折扣**加法叠加**（不是叠乘），上限由属性自身钳制（attributes.json max 80）。
     */
    getRelicDrawDiscount?(): number;
    /** `shop_option_plus` —— 每次抽取的**额外选项数**（+1 个 = 5 选 1） */
    getAchOptionBonus?(): number;
    /** `ad_free_draw` —— 额外「广告免费抽」次数（**叠加**在 `shop_constants.adFreeDrawPerRun` 上） */
    getAchAdFreeBonus?(): number;
    /** `relic_start_gift` —— 每局开局白送的随机遗物件数（0 = 不送） */
    getAchStartGift?(): number;

    /* ── 上报给宿主的进度钩子（**走回调，不 import 数据层**，分层口径同 `SkillSlots.onSkillGranted`）── */

    /** 一轮抽取真的成功了（宿主用它上报成就 `draw_count`；付费抽与广告免费抽都算一次） */
    onDraw?(): void;
    /** 遗物真的发到手里了（宿主用它写遗物图鉴 + 上报成就 `relic_collected`） */
    onRelicGranted?(relicId: number): void;
}

/**
 * RelicShop 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束面板能碰什么）。
 *
 * 面板原来只 inject 到 6 个裸 `ref`，拿不到规则，于是「刷新按钮能不能点」被重抄了一遍。
 * 现在面板问这个门面要判据（`refreshGate()`）即可。
 *
 * ⚠ **动作不在只读面上**（`open/close/refresh/pick/reset/syncCost` 都不声明）：
 *   UI 只 `scope.emit` 向上，由宿主转交给本类。
 */
export interface RelicShopVM {
    /** 面板是否显示（面板只写它，节点 active 由持有节点的宿主写） */
    readonly panelVisible: Ref<boolean>;
    /** 4 个格子的展示状态（遗物 **或** 技能；`id` 0 = 空槽 / 已被选走） */
    readonly slots: Ref<ShopSlotVM[]>;
    /** 本次刷新是否已选过（已选 → 剩余槽位置灰） */
    readonly rollUsed: Ref<boolean>;
    /** 剩余槽位是否转为「看广告才能选」 */
    readonly adMode: Ref<boolean>;
    /** 本次刷新的金币费用 */
    readonly refreshCost: Ref<number>;
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number>;
    /** 刷新按钮的判据（唯一真源；面板只画，不再自己重算） */
    refreshGate(): RefreshGate;
}

export class RelicShop {

    /* ===== 页面级状态（宿主 provide 给 UI 子树，面板/item 只读） ===== */

    /** 面板是否显示（入口按钮设 true、面板关闭按钮设 false；节点显隐由宿主写） */
    readonly panelVisible: Ref<boolean> = ref(false);
    /** 4 个格子的展示状态（id 0 = 空槽 / 已被选走） */
    readonly slots: Ref<ShopSlotVM[]> = ref<ShopSlotVM[]>([]);
    /** 本次刷新是否已选过 */
    readonly rollUsed: Ref<boolean> = ref(false);
    /** 剩余槽位是否转为「看广告才能选」 */
    readonly adMode: Ref<boolean> = ref(false);
    /** 本次刷新的金币费用 */
    readonly refreshCost: Ref<number> = ref(0);
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number> = ref(0);

    /* ===== 本局商店状态（只属于这一局，reset() 清空） ===== */

    /** 已付费刷新次数（决定下次费用 50 → 100 → … 封顶） */
    private drawCount = 0;
    /** 已用掉的广告免费刷新次数 */
    private adFreeUsed = 0;
    /** 本轮候选（点选时用来校验"点的确实是本次抽出来的那个"） */
    private current: ShopOption[] = [];
    /** 本轮是否已选过（未选过只能选 1 个；选过后只能靠广告补选） */
    private pickedInRoll = false;
    /** 本轮剩余的广告补选次数 */
    private adPicksLeft = 0;
    /** 本局是否已发过「开局赠遗物」（成就效果 `relic_start_gift`；一局只发一次，换英雄不重发） */
    private startGiftGranted = false;
    /**
     * 本轮「点了但发不出去」的候选（目前只有一种：技能槽全锁定）。
     * 只置灰这一格、**不消耗本次选择** —— 玩家还能改选别的，去解锁之后再抽。
     */
    private rejected = new Set<number>();

    /** 池子白名单（留空 = 配置里的商店遗物全池）。支持传函数：白名单常来自宿主 config，而它在 onLoad 之后才有值 */
    private poolIds: number[] | (() => number[]);

    private deps: RelicShopDeps;

    constructor(deps: RelicShopDeps, poolIds: number[] | (() => number[]) = []) {
        this.deps = deps;
        this.poolIds = poolIds ?? [];
    }

    /** 当前遗物池白名单 */
    private relicPoolIds(): number[] {
        return typeof this.poolIds === 'function' ? (this.poolIds() ?? []) : (this.poolIds ?? []);
    }

    /* ===================================================================
     * 成就效果（开局快照）折算 —— **费用 / 选项数 / 广告次数的唯一口径**
     * =================================================================== */

    /**
     * 抽取费用折扣比例 —— **显示与实扣的唯一口径**。
     * 两个来源**加法叠加**：成就 `shop_draw_discount`（开局快照）+ 遗物属性「24 抽卡折扣」（实时）。
     */
    private discount(): number {
        const ach = this.deps.getAchDrawDiscount?.() ?? 0;
        const relic = this.deps.getRelicDrawDiscount?.() ?? 0;
        return Math.max(0, Math.min(1, ach + relic));
    }

    /**
     * 第 `this.drawCount` 次付费刷新的**实付费用** = 配置价 × (1 − 折扣)，四舍五入取整。
     *
     * ⚠ 显示（`syncCost`）与实扣（`roll`）都读这里 —— 曾经两处各算一次，
     *   只改一处会让「面板显示 45、实际扣 50」，所以口径只能有一处。
     */
    private drawCostNow(): number {
        const base = RelicDraw.drawCost(this.drawCount);
        const d = this.discount();
        return Math.max(0, Math.round(base * (1 - d)));
    }

    /* ===================================================================
     * 入口：开 / 关面板
     * =================================================================== */

    /** 打开面板（入口按钮点击）；商店未就绪（还没选英雄）时拒绝并打日志 */
    open(): void {
        if (!this.deps.getBag()) {
            console.warn('[遗物] 还没选英雄（遗物系统未就绪），忽略打开面板');
            return;
        }
        this.syncCost();
        this.panelVisible.value = true;
    }

    /** 关闭面板（面板关闭按钮 / 宿主主动收起） */
    close(): void {
        this.panelVisible.value = false;
    }

    /* ===================================================================
     * 面板「刷新」
     * =================================================================== */

    /**
     * 刷新按钮的判据（**唯一真源**）：金币够 → 直接扣钱；不够但还有广告免费次数 → 看广告；都没有 → 置灰。
     * 面板拿它画按钮，`refresh()` 拿它做准入。
     */
    refreshGate(): RefreshGate {
        return evaluateRefreshGate(this.deps.getGold(), this.refreshCost.value, this.adFreeLeft.value);
    }

    /** 现在能不能刷新（= 判据的 `enabled`；给日志/宿主查询用） */
    canRefresh(): boolean {
        return this.refreshGate().enabled;
    }

    /**
     * 刷新 4 个候选（遗物 + 技能混合池）—— 准入用的就是 `refreshGate()` 那一份判据：
     *   ① 金币 ≥ 本次费用 → 扣金币抽 4 个
     *   ② 金币不够、但还有「广告免费抽」次数 → 弹激励视频，看完免费抽 4 个（不扣钱、不抬高后续费用）
     *   ③ 两者都不行 → 面板此时已是置灰态，这里只打日志（点不动，正常走不到）
     */
    refresh(): void {
        if (!this.deps.getBag()) return;
        // 费用以「已抽次数」为准现算（面板显示的那份只是投影，别让它在别处被写脏）
        this.syncCost();

        const cost = this.refreshCost.value;
        const gate = this.refreshGate();
        if (gate.canPay) {
            this.roll(false);
            return;
        }
        if (!gate.viaAd) {
            console.warn(`[遗物] 金币不足（${this.deps.getGold()}/${cost}）且没有广告免费次数，刷新被拒`);
            return;
        }
        this.deps.playAd('relic_refresh').then((ok) => {
            if (ok) this.roll(true);
        });
    }

    /** 真正抽 4 个并写进槽位（规则见 `RelicDraw.roll`：混合池 + 品质权重 + 阶段门槛 + 技能配额） */
    private roll(free: boolean): void {
        const bag = this.deps.getBag();
        if (!bag) return;

        // 实付 = 配置价 × (1 − 成就折扣)；`drawCostNow()` 与面板显示的 `refreshCost` 是同一口径
        const cost = this.drawCostNow();
        if (free) {
            if (this.adFreeLeft.value <= 0) return;
            this.adFreeUsed++;
        } else if (!this.deps.spendGold(cost)) {
            console.warn(`[遗物] 金币不足，刷新失败（${this.deps.getGold()}/${cost}）`);
            return;
        }

        // 成就效果 `shop_option_plus`：本局每次抽取多出 N 个候选（快照值，局中领奖不变）
        const optionCount = RelicDraw.optionCount(this.deps.getAchOptionBonus?.() ?? 0);
        const options = RelicDraw.roll({
            heroLevel: this.deps.getHeroLevel(),
            phase: this.deps.getPhase(),
            count: optionCount,
            ownedRelics: bag.getAll().map((r) => r.getId()),
            ownedSkills: this.deps.getSkillSlots()?.ownedLevels() ?? new Map<number, number>(),
            pool: this.relicPoolIds(),
        });
        if (!options.length) {
            console.warn('[遗物] 刷新失败：池子里已经没有可出的内容（遗物都拥有了 / 技能都满级了 / 白名单为空）');
            this.syncCost();
            return;
        }

        // 成就进度：肉鸽商店累计抽取次数（target=draw_count；付费抽与广告免费抽都算一次）
        // —— 上报交给宿主（本类不认识数据层，见 deps.onDraw 的注释）
        this.deps.onDraw?.();

        this.current = options;
        this.pickedInRoll = false;
        this.adPicksLeft = RelicDraw.adExtraPickLimit();
        this.rejected.clear();
        // 付费刷新才推进费用（广告免费刷新不抬高后续费用）
        if (!free) this.drawCount++;

        this.slots.value = this.buildVMs();
        this.rollUsed.value = false;
        this.adMode.value = false;
        this.syncCost();

        console.log(`[遗物] ${free ? '广告免费刷新' : `花费 ${cost} 金刷新`}（${options.length} 个候选）：`
            + options.map((o) => `${o.kind === 'skill' ? '技' : '遗'}${o.name}[${o.rarity}]`).join(' / '));
    }

    /* ===================================================================
     * 选中
     * =================================================================== */

    /**
     * 格子被点击（由面板/item 向上冒泡上来的通知）。
     *
     * 先校验它确实是**本次候选**里的那个（刷新后旧点击作废），
     * 需要广告的（`viaAd`）先弹激励视频，看到了才发放。
     *
     * @param optionId 遗物 id（1001~1293）或技能 id（101~130）—— 两段不重叠，一个数字足够定位
     * @param viaAd true = 该格处于「看广告可再选一个」状态（本次已选过后的广告补选）
     */
    pick(optionId: number, viaAd: boolean): void {
        const option = this.current.find((o) => o.id === optionId);
        if (!option) {
            console.warn(`[遗物] 面板点选的候选不在本次候选里：${optionId}（可能刚刷新过，面板还没重绘完）`);
            return;
        }
        if (this.rejected.has(optionId)) {
            console.warn(`[遗物] ${option.name} 这次发不出去（技能槽已全部锁定），请先解锁技能槽`);
            return;
        }
        if (!viaAd) {
            this.grant(option, false);
            return;
        }
        if (this.adPicksLeft <= 0) {
            console.warn(`[遗物] 广告补选次数已用完：${option.name}`);
            return;
        }
        this.deps.playAd('relic_extra_pick').then((ok) => {
            if (ok) this.grant(option, true);
        });
    }

    /**
     * 发放：**按种类分流** + 槽位收尾。
     *
     * 遗物 → `RelicSystem.AddRelic`（挂 `modifiers_inner`，属性/被动当场生效）；
     * 技能 → `SkillSlots.grant`（升级 / 填空槽 / 替换最低索引未锁定槽；全锁定则拒发并提示）。
     * 本类**不做任何属性计算**。
     *
     * @param viaAd true = 广告补选（可在「本次已选过」的置灰项里再选 1 个）
     */
    private grant(option: ShopOption, viaAd: boolean): void {
        if (!this.deps.getBag()) return;

        // 一次刷新只能选 1 个（多选由广告补选提供，且不消耗金币）
        if (!viaAd && this.pickedInRoll) {
            console.warn(`[遗物] 本次刷新已选过，${option.name} 需要看广告才能补选`);
            return;
        }

        if (option.kind === 'skill') {
            if (!this.grantSkill(option)) return; // 拒发（全锁定）→ 不消耗本次选择
        } else if (!this.grantRelic(option)) {
            return;
        }

        if (viaAd) this.adPicksLeft--;

        // 槽位收尾：被选中的那一格置 0（**选择的内容隐藏**，其余三格保持可见）
        const slots = [...this.slots.value];
        const idx = slots.findIndex((s) => s.id === option.id);
        if (idx >= 0) slots[idx] = { ...slots[idx], id: 0, selectable: false };
        this.slots.value = slots;
        // 本次已选过 → 剩余格置灰；若还能广告补选，则剩余格改标「看广告可再选一个」
        this.pickedInRoll = true;
        this.rollUsed.value = true;
        this.adMode.value = !viaAd && this.adPicksLeft > 0;

        this.syncCost();
    }

    /** 遗物发放：入背包 + 挂 Modifier */
    private grantRelic(option: ShopOption): boolean {
        const bag = this.deps.getBag();
        if (!bag) return false;
        if (bag.has(option.id)) {
            console.warn(`[遗物] ${option.name} 本局已拥有，重复获得被拒`);
            return false;
        }
        const relic = bag.AddRelic(option.id);
        if (!relic) {
            console.warn(`[遗物] 获得失败：${option.name}（${option.id}）`);
            return false;
        }
        console.log(`[遗物] 获得「${option.name}」[${option.rarity}]，背包共 ${bag.getAll().length} 件`);
        // 遗物**图鉴**收集（`relic_collected` 的数据源）—— 由宿主写：
        // 「只记图鉴里那 37 件（有局外版）」的过滤与上报都在宿主那一侧（见 `Scene_Game_Stage.onRelicCollected`）
        this.deps.onRelicGranted?.(option.id);
        return true;
    }

    /**
     * 技能发放：写进技能槽（口径见 `SkillSlots.grant`）。
     *
     * 失败只有一种需要提示玩家的情形：**一个未锁定的技能槽都没有** →
     * 调宿主注入的 `onSkillAllLocked`（通常飘字「技能槽已全部锁定」），
     * 并把这格标成「本轮拒发」（置灰不消耗选择），玩家可以改选别的。
     */
    private grantSkill(option: ShopOption): boolean {
        const skillSlots = this.deps.getSkillSlots();
        if (!skillSlots) {
            console.warn('[遗物] 技能槽系统未就绪，技能发放被拒');
            return false;
        }
        const result = skillSlots.grant(option.id);
        if (result.ok) {
            const detail = result.kind === 'upgraded'
                ? `升级到 Lv.${result.level}`
                : result.kind === 'replaced'
                    ? `顶替了槽 ${result.index + 1} 的旧技能（${result.replacedId}）`
                    : `写入槽 ${result.index + 1}`;
            console.log(`[遗物] 获得技能「${option.name}」[${option.rarity}]，${detail}`);
            return true;
        }

        switch (result.reason) {
            case 'all_locked':
                console.warn(`[遗物] 技能槽已全部锁定，「${option.name}」发不出去`);
                this.rejected.add(option.id);
                this.slots.value = this.buildVMs();
                this.deps.onSkillAllLocked?.(option);
                return false;
            case 'max_level':
                console.warn(`[遗物] 「${option.name}」已满级，无法再升级`);
                return false;
            case 'not_ready':
                console.warn('[遗物] 还没选英雄，技能发放被拒');
                return false;
            default:
                console.warn(`[遗物] 技能「${option.name}」发放失败：${result.reason}`);
                return false;
        }
    }

    /* ===================================================================
     * 状态同步 / 重置
     * =================================================================== */

    /** 本轮候选 → 面板要渲染的格子状态（含「被拒发」的置灰标记） */
    private buildVMs(): ShopSlotVM[] {
        return this.current.map((o) => ({
            kind: o.kind,
            id: o.id,
            level: o.level,
            maxLevel: o.maxLevel,
            selectable: o.selectable && !this.rejected.has(o.id),
        }));
    }

    /** 把费用与广告剩余次数同步给面板（换局 / 换英雄 / 刷新后都要调） */
    syncCost(): void {
        // 费用与实扣同一条口径（含成就折扣），否则面板显示的价与实际扣的钱会对不上
        this.refreshCost.value = this.drawCostNow();
        // 广告免费抽：配置额度 + 成就效果 `ad_free_draw`（叠加，快照值）
        this.adFreeLeft.value = Math.max(0,
            RelicDraw.adFreeDrawLimit(this.deps.getAchAdFreeBonus?.() ?? 0) - this.adFreeUsed);
    }

    /**
     * 开局赠遗物（成就效果 `relic_start_gift`）—— 宿主在**本局首次选完英雄**后调一次。
     *
     * 复用**同一套抽取纯函数**（`RelicDraw.relicPool` / `makeRelicOption`）与**同一个发放通道**
     * （`grantRelic` → `RelicSystem.AddRelic`），所以「开局送的」与「商店抽到的」在背包、
     * 属性挂载、`relics_picked` 进度上报上完全同口径 —— 不另开一条发遗物的路。
     *
     * ⚠ 幂等：一局只发一次（`startGiftGranted`，`reset()` 复位），换英雄不会重发。
     */
    grantStartGift(): void {
        if (this.startGiftGranted) return;
        this.startGiftGranted = true;

        const count = Math.max(0, Math.floor(this.deps.getAchStartGift?.() ?? 0));
        const bag = this.deps.getBag();
        if (count <= 0 || !bag) return;

        const owned = bag.getAll().map((r) => r.getId());
        for (let i = 0; i < count; i++) {
            const pool = RelicDraw.relicPool(this.relicPoolIds(), owned);
            if (!pool.length) {
                console.warn('[遗物] 开局赠遗物：池子里已经没有可送的遗物（都拥有了 / 白名单为空）');
                return;
            }
            const def = pool[Math.min(pool.length - 1, Math.floor(Math.random() * pool.length))];
            const option = RelicDraw.makeRelicOption(def, false);
            if (!this.grantRelic(option)) return;
            owned.push(def.id); // 多件时逐件去重（同一件不送两次）
        }
    }

    /**
     * 换局 / 换英雄：商店状态整体复位（槽位清空、面板收起、抽数与广告次数归零）。
     * ⚠ 背包与技能槽都不在这里清 —— 它们属于「一局」，由宿主按自己的口径处理
     *   （换英雄要保留遗物/技能并重新挂到新英雄上；重开一局才随商店一起重建）。
     */
    reset(): void {
        this.drawCount = 0;
        this.adFreeUsed = 0;
        this.current = [];
        this.pickedInRoll = false;
        this.adPicksLeft = 0;
        this.rejected.clear();
        // 换局：开局赠遗物重新可发（效果是"每局开局"送的，不是只送一次）
        this.startGiftGranted = false;

        this.slots.value = [];
        this.rollUsed.value = false;
        this.adMode.value = false;
        this.panelVisible.value = false;
        // 费用与广告次数按「已抽 0 次」重算 —— 别留 0：面板的置灰判据会把它当成"免费刷新"
        this.syncCost();
    }

    /* ===================================================================
     * 查询
     * =================================================================== */

    /** 背包件数（日志/展示用；真源仍是 RelicSystem） */
    bagCount(): number {
        return this.deps.getBag()?.getAll().length ?? 0;
    }

    /** 已付费刷新次数（调试/统计用） */
    getDrawCount(): number { return this.drawCount; }
}
