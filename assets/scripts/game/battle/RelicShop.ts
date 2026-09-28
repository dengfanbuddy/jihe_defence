import { ref, type Ref } from '../../platform/reactivity';
import type { AdPlacement } from '../../platform/ad/AdMgr';
import { RelicDraw, type RelicOption } from './RelicDraw';
import type { RelicSystem } from './BattleEquipSystem';

/**
 * RelicShop —— **局内遗物商店的完整功能封装**（纯 TS，无 cc 依赖）
 *
 * 把「入口 → 面板 → 刷新 → 选中 → 入背包」这一整套流程从 `Scene_Game_Stage` 里抽出来：
 * 场景只负责**持有节点 + 接线 + 提供平台能力**（金币真源、广告、暂停策略），
 * 面板与 item 只负责**渲染 + 上报**。四层职责（规则/流程/状态/表现各归各的）：
 *
 * ```
 *   ShopRelicsPanel / ShopRiItem      只渲染与上报（scope.emit）
 *        ▲ provide 状态 / 收事件          │ emit(RelicRefresh) / emit(RelicPicked, id, viaAd)
 *        │                                ▼
 *   RelicShop（本类）                  本局商店状态（抽了几次 / 广告用了几次 / 本轮候选 / 本轮选没选过）
 *        │                               ＋交互流程（能不能抽、要不要看广告、选中后干什么）
 *        ▼
 *   RelicDraw                         抽取规则（品质权重 / 阶段门槛 / 越阶 / 去重 / 降级；费用与广告额度键名）
 *        ▼
 *   RelicSystem（BattleEquipSystem）   背包 + 属性：AddRelic 挂上 modifiers_inner，属性/被动当场生效
 * ```
 *
 * ⚠ 本类**不做属性计算**：遗物的效果是「属性修改」共享模板 Modifier + 自己的 `kv.attrs`，
 *   由 `AttributeSystem` 统一结算（见 BattleEquipSystem / ModifierSystem）。
 *
 * ── 状态（`ref`，由宿主 `Scene_Game_Stage` provide 给 UI 子树，键见 `UiScopeKeys`）──
 *   `panelVisible` 面板开关（宿主按它写面板节点 active）
 *   `slots`        4 个槽位的遗物 id（0 = 空槽 / 已被选走 → item 自己收起）
 *   `rollUsed`     本次刷新是否已选过（已选 → 剩余槽位置灰）
 *   `adMode`       剩余槽位是否转为「看广告才能选」（广告补选）
 *   `refreshCost`  下一次刷新的金币费用（面板显示 + 置灰判据）
 *   `adFreeLeft`   剩余「广告免费刷新」次数
 *
 * ── 生命周期 ──
 *   本类随**界面**创建一次（宿主 `onLoad`，它持有的状态要 provide 给 UI 子树）；
 *   它自己持有的计次（抽了几次 / 广告用了几次）属于**一局**，由宿主在换局时调 `reset()`；
 *   背包（`RelicSystem`）也属于一局，通过 `getBag()` 延迟取（未选英雄时为 null，内部一律空判）。
 *
 * @example
 * ```ts
 * // 宿主（Scene_Game_Stage）：onLoad 建一次并把状态 provide 出去
 * this.relicShop = new RelicShop({
 *     getBag: () => this.heroRelics,
 *     getGold: () => this.battleStore.gold,
 *     spendGold: (n) => this.spendGold(n),
 *     getHeroLevel: () => this.battleStore.level ?? 1,
 *     getPhase: () => this.stage,
 *     playAd: (p) => this.playRewardAd(p),
 * })
 * this.scope.provide(StageScopeKeys.RelicSlots, this.relicShop.slots)
 * this.scope.on(StageScopeEvents.RelicRefresh, () => this.relicShop.refresh(), this)
 * this.scope.on(StageScopeEvents.RelicPicked, (id, viaAd) => this.relicShop.pick(id, viaAd), this)
 * ```
 */
export interface RelicShopDeps {
    /** 本局的遗物背包（随一局创建：选完英雄才有 → 可能为 null，本类内部空判） */
    getBag(): RelicSystem | null;
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
}

export class RelicShop {

    /* ===== 页面级状态（宿主 provide 给 UI 子树，面板/item 只读） ===== */

    /** 面板是否显示（入口按钮设 true、面板关闭按钮设 false；节点显隐由宿主写） */
    readonly panelVisible: Ref<boolean> = ref(false);
    /** 4 个槽位的遗物 id（0 = 空槽 / 已被选走） */
    readonly slots: Ref<number[]> = ref<number[]>([]);
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
    /** 本轮候选（点选时用来校验"点的确实是本次抽出来的那一件"） */
    private current: RelicOption[] = [];
    /** 本轮是否已选过（未选过只能选 1 个；选过后只能靠广告补选） */
    private pickedInRoll = false;
    /** 本轮剩余的广告补选次数 */
    private adPicksLeft = 0;

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

    /** 现在能不能刷新（金币够 或 还有广告免费次数）——面板的置灰判据与这里同一套 */
    canRefresh(): boolean {
        return this.deps.getGold() >= RelicDraw.drawCost(this.drawCount) || this.adFreeLeft.value > 0;
    }

    /**
     * 刷新 4 个遗物 —— **与面板的置灰判据同一套规则**：
     *   ① 金币 ≥ 本次费用 → 扣金币抽 4 个
     *   ② 金币不够、但还有「广告免费抽」次数 → 弹激励视频，看完免费抽 4 个（不扣钱、不抬高后续费用）
     *   ③ 两者都不行 → 面板此时已是置灰态，这里只打日志（点不动，正常走不到）
     */
    refresh(): void {
        if (!this.deps.getBag()) return;
        // 费用以「已抽次数」为准现算（面板显示的那份只是投影，别让它在别处被写脏）
        this.syncCost();

        const cost = this.refreshCost.value;
        if (this.deps.getGold() >= cost) {
            this.roll(false);
            return;
        }
        if (this.adFreeLeft.value <= 0) {
            console.warn(`[遗物] 金币不足（${this.deps.getGold()}/${cost}）且没有广告免费次数，刷新被拒`);
            return;
        }
        this.deps.playAd('relic_refresh').then((ok) => {
            if (ok) this.roll(true);
        });
    }

    /** 真正抽 4 个并写进槽位（规则见 `RelicDraw.roll`：品质权重 + 阶段门槛 + 未拥有去重，只出遗物） */
    private roll(free: boolean): void {
        const bag = this.deps.getBag();
        if (!bag) return;

        const cost = RelicDraw.drawCost(this.drawCount);
        if (free) {
            if (this.adFreeLeft.value <= 0) return;
            this.adFreeUsed++;
        } else if (!this.deps.spendGold(cost)) {
            console.warn(`[遗物] 金币不足，刷新失败（${this.deps.getGold()}/${cost}）`);
            return;
        }

        const options = RelicDraw.roll({
            heroLevel: this.deps.getHeroLevel(),
            phase: this.deps.getPhase(),
            count: RelicDraw.optionCount(),
            owned: bag.getAll().map((r) => r.getId()),
            pool: this.relicPoolIds(),
        });
        if (!options.length) {
            console.warn('[遗物] 刷新失败：池子里已经没有可出的遗物（都拥有了 / 白名单为空）');
            this.syncCost();
            return;
        }

        this.current = options;
        this.pickedInRoll = false;
        this.adPicksLeft = RelicDraw.adExtraPickLimit();
        // 付费刷新才推进费用（广告免费刷新不抬高后续费用）
        if (!free) this.drawCount++;

        this.slots.value = options.map((o) => o.id);
        this.rollUsed.value = false;
        this.adMode.value = false;
        this.syncCost();

        console.log(`[遗物] ${free ? '广告免费刷新' : `花费 ${cost} 金刷新`}：${options.map((o) => `${o.name}[${o.rarity}]`).join(' / ')}`);
    }

    /* ===================================================================
     * 选中遗物
     * =================================================================== */

    /**
     * item 被点击（由面板/item 向上冒泡上来的通知）。
     *
     * 先校验它确实是**本次候选**里的那一件（刷新后旧点击作废），
     * 需要广告的（`viaAd`）先弹激励视频，看到了才发放。
     *
     * @param relicId 遗物 id（relics.json）
     * @param viaAd true = 该槽位处于「看广告可再选一个」状态（本次已选过后的广告补选）
     */
    pick(relicId: number, viaAd: boolean): void {
        const option = this.current.find((o) => o.id === relicId);
        if (!option) {
            console.warn(`[遗物] 面板点选的遗物不在本次候选中：${relicId}（可能刚刷新过，面板还没重绘完）`);
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
     * 发放：**入背包 + 上属性** + 槽位收尾。
     *
     * `RelicSystem.AddRelic` 挂上遗物的 `modifiers_inner`（属性加成走「属性修改」共享模板 + `kv.attrs`，
     * 被动是各自带 cd 的 Modifier），属性/被动当场生效；本类不做任何属性计算。
     *
     * @param viaAd true = 广告补选（可在「本次已选过」的置灰项里再选 1 个）
     */
    private grant(option: RelicOption, viaAd: boolean): void {
        const bag = this.deps.getBag();
        if (!bag) return;

        // 一次刷新只能选 1 个（多选由广告补选提供，且不消耗金币）
        if (!viaAd && this.pickedInRoll) {
            console.warn(`[遗物] 本次刷新已选过，${option.name} 需要看广告才能补选`);
            return;
        }
        if (bag.has(option.id)) {
            console.warn(`[遗物] ${option.name} 本局已拥有，重复获得被拒`);
            return;
        }
        const relic = bag.AddRelic(option.id);
        if (!relic) {
            console.warn(`[遗物] 获得失败：${option.name}（${option.id}）`);
            return;
        }

        if (viaAd) this.adPicksLeft--;

        // 槽位收尾：被选中的那一格置 0（**选择的遗物隐藏**，其余三格保持可见）
        const slots = [...this.slots.value];
        const idx = slots.indexOf(option.id);
        if (idx >= 0) slots[idx] = 0;
        this.slots.value = slots;
        // 本次已选过 → 剩余格置灰；若还能广告补选，则剩余格改标「看广告可再选一个」
        this.pickedInRoll = true;
        this.rollUsed.value = true;
        this.adMode.value = !viaAd && this.adPicksLeft > 0;

        this.syncCost();

        console.log(`[遗物] ${viaAd ? '（广告补选）' : ''}获得「${option.name}」[${option.rarity}]，背包共 ${bag.getAll().length} 件`);
    }

    /* ===================================================================
     * 状态同步 / 重置
     * =================================================================== */

    /** 把费用与广告剩余次数同步给面板（换局 / 换英雄 / 刷新后都要调） */
    syncCost(): void {
        this.refreshCost.value = RelicDraw.drawCost(this.drawCount);
        this.adFreeLeft.value = Math.max(0, RelicDraw.adFreeDrawLimit() - this.adFreeUsed);
    }

    /**
     * 换局 / 换英雄：商店状态整体复位（槽位清空、面板收起、抽数与广告次数归零）。
     * ⚠ 背包（`RelicSystem`）不在这里清 —— 它属于「一局」，由宿主按自己的口径处理
     *   （换英雄要保留遗物并 `RebindOwner`，重开一局才随商店一起重建）。
     */
    reset(): void {
        this.drawCount = 0;
        this.adFreeUsed = 0;
        this.current = [];
        this.pickedInRoll = false;
        this.adPicksLeft = 0;

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
