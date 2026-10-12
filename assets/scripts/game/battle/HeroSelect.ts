import { ref, type Ref } from '../../platform/reactivity';
import type { AdPlacement } from '../../platform/ad/AdMgr';
import { RandomUtil } from '../../platform/utils/RandomUtil';
import { ShopConfig } from '../data/configs/ShopConfig';
import { TbRoot } from '../../platform/excel_table/TbRoot';
import { UnitCfgContainer } from '../excel_table/Tb_UnitConfig';
import { evaluateRefreshGate, type RefreshGate } from './RefreshGate';

/**
 * HeroSelect —— **选英雄功能的完整封装**（纯 TS，无 cc 依赖）
 *
 * 从 `Scene_Game_Stage` 里抽出来的「选人」这条线：抽候选 → 开面板 → 刷新（花金币 / 看广告）→
 * 选中 → **回调宿主去真正创建英雄实体**。
 *
 * ```
 *   HeroSelectPanel / HeroItem      只渲染与上报
 *        ▲ provide 状态                 │ emit(HeroRefresh) / emit(HeroPicked, heroId)
 *        ▼                              ▼
 *   HeroSelect（本类）              候选池、刷新费用与广告额度、选中态、面板显隐
 *        │
 *        ▼  deps.selectHero(heroId)   真正创建实体（属性 / 遗物重挂 / 换英雄）——那是**战斗逻辑**，留在宿主
 * ```
 *
 * ⚠ 本类**不创建英雄实体**：`selectHero` 是宿主注入的回调（场景里要做的事太多：换英雄要移除旧实体、
 *   `RelicSystem.RebindOwner`、同步 store、刷范围圈…），本类只管「选了谁、什么时候选」。
 *
 * ── 状态（`ref`，由宿主 `Scene_Game_Stage` provide 给 UI 子树）──
 *   `panelVisible` 面板开关（宿主/HUD 按它写面板节点 active）
 *   `candidates`   本局候选英雄 id（面板渲染）
 *   `selectedId`   当前选中的英雄 id（item 之间的互斥选中态）
 *   `refreshCost`  刷新一次的金币费用
 *   `adFreeLeft`   剩余「广告免费刷新」次数
 *
 * 规则常量（`shop_constants`，缺省走内置默认值，改表即改玩法）：
 *   `heroSelectCandidateCount`（默认 4）· `heroSelectRefreshCost`（默认 100）
 *   `heroSelectAdFreePerRun`（默认 1）
 *
 * ⚠ **候选池 = 局外已解锁的英雄**（用户口径「局内英雄也只能随机解锁的英雄」）：
 *   本类不认识存档，池子由宿主通过 `deps.getUnlockedHeroIds()` 注入（`DataCenter.heroData`），
 *   本类只与 `units.json` 的 hero 段求交集 → 没解锁的英雄**一个都不会出现**在候选里。
 *   默认解锁 2 位（`DEFAULT_UNLOCKED_HERO_IDS`）时，面板上就是那 2 个候选。
 *
 * 成就特殊效果（`hero_select_free`）：额外免费刷新次数由宿主通过 `deps.getAchAdFreeBonus()`
 *   注入，**叠加**在 `heroSelectAdFreePerRun` 之上；宿主取的是**本局开局快照**（见设计稿 §5.2）。
 */
export interface HeroSelectDeps {
    /** 读本局金币（真源 `hero.gold`，与 HUD 同一口径） */
    getGold(): number;
    /** 扣金币；返回 false = 余额不足（宿主负责同步 HUD / store） */
    spendGold(amount: number): boolean;
    /** 拉激励视频（宿主实现，通常包一层"播放期间暂停战斗"） */
    playAd(placement: AdPlacement): Promise<boolean>;
    /** 真正把英雄放到场上（创建实体 / 换英雄 / 遗物重挂 / 同步 store）——宿主实现 */
    selectHero(heroId: number): void;
    /**
     * 成就效果 `hero_select_free` —— **额外**的免费刷新次数。
     * 宿主从**开局快照**取（未注入 / 未生效 = 0），本类把它**叠加**在
     * `shop_constants.heroSelectAdFreePerRun`（默认 1）之上。
     *
     * ⚠ 本类**不许**自己调 `AchievementData.getEffects()`（实时值会让"打到一半突然多一次免费刷新"）。
     */
    getAchAdFreeBonus?(): number;
    /**
     * **本局候选池 = 局外已解锁的英雄**（用户口径「局内英雄也只能随机解锁的英雄」）。
     *
     * 宿主实现：`() => DataCenter.ins.heroData.getUnlocked().map((r) => r.id)`
     *   —— 已解锁档案（`records`）是唯一真源，本类只做「与 `units.json` 的 hero 段求交集」。
     *
     * ⚠ **为什么走回调而不是 `import DataCenter`**：本类是纯 TS 战斗功能类，不认识存档、不认识界面
     *   （同 `BuffShop.getAchPriceDiscount` / `SkillSlots.onSkillGranted` 的分层口径）；
     *   顺带让"未解锁的英雄进不了候选"这件事能在体检里用假档案直接跑（见 `tools/hero-select-audit`）。
     *
     * ⚠ 未注入（或返回空）时**回退整池**并打警告 —— 宁可让玩家抽到没解锁的英雄，
     *   也不能让候选为空（面板会变成一块点不动的空板，选不了英雄就进不了战斗）。
     */
    getUnlockedHeroIds?(): number[];
}

/**
 * HeroSelect 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束面板能碰什么）。
 *
 * 为什么要有它：面板原来只 inject 到 4 个裸 `ref`，拿不到"规则"，于是
 * 「刷新按钮能不能点」这条判据在面板里被**重抄了一遍**（三个面板三份，逐字相同）。
 * 现在面板拿到的是这个门面，问它要判据（`refreshGate()`）即可。
 *
 * ⚠ **动作不在只读面上**：`open / close / refresh / pick / reset` 一律不上门面 ——
 *   UI 只 `scope.emit` 向上，由宿主转交给功能类（本项目「状态向下、通知向上」的方向性约束）。
 *   门面只声明"读什么"，所以面板写 `vm.pick(...)` 会编译报错。
 */
export interface HeroSelectVM {
    /** 面板是否显示（面板/HUD 只翻这个开关，节点 active 由持有节点的视图写） */
    readonly panelVisible: Ref<boolean>;
    /** 本局候选英雄 id（0 = 空位） */
    readonly candidates: Ref<number[]>;
    /** 当前选中的英雄 id（item 之间的互斥高亮） */
    readonly selectedId: Ref<number>;
    /** 刷新一次的金币费用 */
    readonly refreshCost: Ref<number>;
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number>;
    /** 刷新按钮的判据（唯一真源；面板只画，不再自己重算） */
    refreshGate(): RefreshGate;
}

export class HeroSelect {

    /* ===== 页面级状态（宿主 provide 给 UI 子树） ===== */

    /** 面板是否显示 */
    readonly panelVisible: Ref<boolean> = ref(false);
    /** 本局候选英雄 id（0 = 空位） */
    readonly candidates: Ref<number[]> = ref<number[]>([]);
    /** 当前选中的英雄 id（item 子树共享，用于互斥高亮） */
    readonly selectedId: Ref<number> = ref(0);
    /** 刷新一次的金币费用 */
    readonly refreshCost: Ref<number> = ref(0);
    /** 剩余「广告免费刷新」次数 */
    readonly adFreeLeft: Ref<number> = ref(0);

    /** 已用掉的广告免费刷新次数（属于一局） */
    private adFreeUsed = 0;

    private deps: HeroSelectDeps;

    constructor(deps: HeroSelectDeps) {
        this.deps = deps;
        this.syncCost();
    }

    /* ===================================================================
     * 一局的生命周期
     * =================================================================== */

    /** 开局：抽一批候选并打开面板（宿主在 `show()` 里调） */
    startRun(): void {
        this.rollCandidates();
        this.open();
    }

    /**
     * 换局复位：候选清空、面板收起、选中态与广告次数归零。
     * ⚠ 不动金币（局内经济由宿主与 store 管）。
     */
    reset(): void {
        this.adFreeUsed = 0;
        this.candidates.value = [];
        this.selectedId.value = 0;
        this.panelVisible.value = false;
        this.syncCost();
    }

    /* ===================================================================
     * 入口：开 / 关面板
     * =================================================================== */

    /** 打开面板（开局 / HUD 的「换英雄」按钮） */
    open(): void {
        this.panelVisible.value = true;
    }

    /** 关闭面板（面板关闭按钮 / 选完英雄） */
    close(): void {
        this.panelVisible.value = false;
    }

    /* ===================================================================
     * 候选 / 刷新
     * =================================================================== */

    /** 候选数量（shop_constants.heroSelectCandidateCount，缺省 4） */
    candidateCount(): number {
        return Math.max(1, ShopConfig.getNumber('heroSelectCandidateCount', 4));
    }

    /** 抽一批候选（不扣费；刷新走 `refresh()`） */
    rollCandidates(): void {
        const pool = this.heroPoolIds();
        if (!pool.length) {
            console.warn('[选英雄] units.json 里没有 category=hero 的英雄条目，候选为空');
            this.candidates.value = [];
            return;
        }
        // 池子比槽位少时**有几个铺几个**（面板会把没铺到的槽位整格收起，见 `HeroSelectPanel.checkHeroList`）：
        // 解锁 1~4 位时面板上看到的恰好是"你拥有的全部英雄"。
        this.candidates.value = RandomUtil.getRandomElements(pool, this.candidateCount());
    }

    /**
     * 刷新按钮的判据（**唯一真源**）：金币够 → 直接扣钱；不够但还有广告免费次数 → 看广告；都没有 → 置灰。
     *
     * 面板（`HeroSelectPanel`）拿它画按钮，`refresh()` 拿它做准入 —— 两边永远同一个答案，
     * 不会再出现"面板能点、点了没反应"或"面板置灰、其实还能广告刷新"。
     */
    refreshGate(): RefreshGate {
        return evaluateRefreshGate(this.deps.getGold(), this.refreshCost.value, this.adFreeLeft.value);
    }

    /** 现在能不能刷新（= 判据的 `enabled`；给日志/宿主查询用，面板请不要自己算，拿 `refreshGate()`） */
    canRefresh(): boolean {
        return this.refreshGate().enabled;
    }

    /**
     * 刷新候选 —— 准入用的就是 `refreshGate()` 那一份判据：
     *   ① 金币 ≥ 费用 → 扣费重抽；② 金币不够但还有广告免费次数 → 看广告重抽；③ 都不行 → 拒绝并打日志
     */
    refresh(): void {
        const cost = this.refreshCost.value;
        const gate = this.refreshGate();
        if (gate.canPay) {
            if (!this.deps.spendGold(cost)) {
                console.warn(`[选英雄] 金币不足，刷新失败（${this.deps.getGold()}/${cost}）`);
                return;
            }
            this.rollCandidates();
            return;
        }
        if (!gate.viaAd) {
            console.warn(`[选英雄] 金币不足（${this.deps.getGold()}/${cost}）且没有广告免费次数，刷新被拒`);
            return;
        }
        this.deps.playAd('hero_refresh').then((ok) => {
            if (!ok) return;
            this.adFreeUsed++;
            this.syncCost();
            this.rollCandidates();
        });
    }

    /* ===================================================================
     * 选中
     * =================================================================== */

    /**
     * 选中某个候选英雄（item 点选冒泡上来）。
     * 只接受**本批候选里**的 id（防止刷新后的旧点击 / 面板还没重绘时点到脏数据）。
     */
    pick(heroId: number): void {
        if (!heroId || this.candidates.value.indexOf(heroId) < 0) {
            console.warn(`[选英雄] 点选的英雄不在本批候选中：${heroId}`);
            return;
        }
        this.selectedId.value = heroId;
        this.close();
        this.deps.selectHero(heroId);
    }

    /* ===================================================================
     * 状态同步
     * =================================================================== */

    /** 把费用与广告剩余次数同步给面板（构造 / 刷新后 / 换局后） */
    syncCost(): void {
        this.refreshCost.value = Math.max(0, ShopConfig.getNumber('heroSelectRefreshCost', 100));
        // 免费刷新次数 = 配置额度 + 成就效果 `hero_select_free`（叠加，本局开局快照值）
        const limit = Math.max(0, ShopConfig.getNumber('heroSelectAdFreePerRun', 1))
            + Math.max(0, Math.floor(this.deps.getAchAdFreeBonus?.() ?? 0));
        this.adFreeLeft.value = Math.max(0, limit - this.adFreeUsed);
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /**
     * **本局候选池 = 已解锁英雄 ∩ `units.json` 的 hero 段**（唯一真源；`rollCandidates` 只认它）。
     *
     * 三条口径：
     *   ① 池子按 `units.json` 的条目顺序（id 升序），只保留**已解锁**的 id ——
     *      没解锁的英雄**一个都不会出现在候选里**，哪怕它就在表里；
     *   ② 脏存档里的 id（表里根本没有的英雄、或旧版本删掉的英雄）自然被交集滤掉；
     *   ③ 交集为空（宿主忘了注入 / 存档里一个已解锁的都没有 / 配表还没加载）→ **回退整池 + 警告**，
     *      绝不让候选为空（空候选 = 选不了英雄 = 卡在选人阶段进不去）。
     */
    private heroPoolIds(): number[] {
        const all = this.allHeroIds();
        if (!all.length) return [];

        const unlocked = this.deps.getUnlockedHeroIds?.() ?? [];
        if (!unlocked.length) {
            console.warn('[选英雄] 没有拿到已解锁英雄（未注入 getUnlockedHeroIds 或档案为空），本次回退整池');
            return all;
        }

        const unlockedSet = new Set(unlocked.filter((id) => Number.isFinite(id) && id > 0));
        const pool = all.filter((id) => unlockedSet.has(id));
        if (!pool.length) {
            console.warn(`[选英雄] 已解锁的 id（${unlocked.join(',')}）在 units.json 里一个都对不上，本次回退整池`);
            return all;
        }
        return pool;
    }

    /** `units.json` 里 `category=hero` 的全部条目（id 升序；表未加载时返回空数组） */
    private allHeroIds(): number[] {
        try {
            return TbRoot.ins.getTbContainer(UnitCfgContainer).cfgs
                .filter((cfg) => cfg.category === 'hero')
                .map((cfg) => cfg.id)
                .sort((a, b) => a - b);
        } catch {
            // 配表还没加载（正常不会：候选是在 show 之后才抽的）
            return [];
        }
    }
}
