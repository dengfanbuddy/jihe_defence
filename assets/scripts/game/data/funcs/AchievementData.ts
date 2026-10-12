/**
 * AchievementDataModule — 成就数据模块（局外，跨局永久累积）
 *
 * 设计稿：`docs/成就系统设计.md`（**唯一真源**，本文件只实现它）§8。
 *
 * ── 与 `TaskData` 的关系（别照抄错）──
 *   · 任务是**周期性**的（日/周键变化就清记录），成就是**一次性永久**的：不重置、不清周期；
 *   · 任务用 `claimed: boolean`（领完不再累积），成就用 `claimedTier: number`
 *     —— **领完铜档仍要继续累积**，否则银档永远卡在「进度不动」；
 *   · 任务奖励 = 账号经验 + 金币，成就奖励 = **只有金币** + 「末档效果永久生效」；
 *   · 成就多一个「一条成就 = 同 group 的 3 行配表」的归并视角（容器已按 group 归并）。
 *
 * ── 数据形状 ⚠ ──
 * `records` 必须用**数组**：`DataModule.mergeDeep` 只合并「默认数据里已经存在的 key」
 * （`if (!(key in target)) continue`），用 `{ [group]: record }` 字典存动态 group 的话
 * **读档时会被整片丢掉**（默认数据里 records 是空对象）。数组走「整片覆盖」，能正确读档。
 *
 * ── 用法 ──
 * ```ts
 * // 对局侧上报（与 taskData 并排一行，见 Scene_Game_Stage 的各上报点）
 * achieveData.addProgress('kill_enemies', 1);     // 累加型
 * achieveData.peakProgress('level_reached', 12);  // 峰值型（只增不减）
 * achieveData.markFlag('login');                  // 置为完成
 * achieveData.reportRunGoals({ stage: 5, heroLevel: 27, kills: 1200, gold: 2400, survive: 1110 });
 *                                                 // 「门槛 × 局数」型：**每局结算调一次**
 *
 * // 界面侧
 * const list  = achieveData.getGroups('stage');        // 某分类的成就（已排序 + 隐藏过滤）
 * const state = achieveData.getGroupState('st_clear'); // { tier, progress, count, state, nextReward, nextDesc, effect... }
 * const n     = achieveData.getClaimableCount();       // 红点
 * const res   = achieveData.claim('st_clear');         // 领「下一档」
 *
 * // 开局快照（`Scene_Game_Stage` 每次开局读一次，本局全程用它）
 * const effects = achieveData.getEffects();            // { run_start_gold: 50, ... }（已按封顶 clamp）
 * ```
 */
import { DataModule } from '../DataModule';
import { AchievementConfig, ACH_RUN_TARGETS, isRunTarget } from '../configs/AchievementConfig';
import { ACH_EFFECT_META } from '../../common/AchievementEffectMeta';
import type { AchEffectCode, AchGroupCfg, AchTarget } from '../../excel_table/Tb_AchievementConfig';

/**
 * 单条成就的进度记录。
 *
 * ⚠ **两套进度字段**（2026-11 起）：
 *   · `progress` —— 累加 / 峰值型（击杀数、通关次数、账号等级…）的进度，一条成就一个数；
 *   · `runCounts` —— **「门槛 × 局数」型**（`run_*`：`run_stage` / `run_hero_level` /…）的进度，
 *     **逐档一个计数**（`runCounts[i]` = 满足第 i+1 档门槛的**局数**）。
 *
 * 为什么局数型不能用 `progress` 一个数：门槛是**逐档抬高**的（第2阶段×3局 → 第3阶段×5局…），
 * 而「达到第3阶段的局数」≤「达到第2阶段的局数」—— 共用一个计数器会**多算**
 * （打完第 2 阶段的那几局会把"达到第 3 阶段"的计数一起顶上去 ⇒ 提前发奖）。
 * 逐档计数天然单调、且领奖不需要清零。
 */
export interface AchRecord {
    /** 成就组（= 配表 `group`，一条成就一条记录） */
    group: string;
    /** 当前进度（**只增不减**；峰值型取历史峰值，已按最高档目标钳制）。`run_*` 型恒为 0 */
    progress: number;
    /** 已领到第几档（0 = 一档都没领） */
    claimedTier: number;
    /** `run_*` 型的**逐档局数**（缺省 = 还没推进过；旧存档里没有这个字段，按全 0 处理） */
    runCounts?: number[];
}

/** 成就数据模块的数据结构 */
export interface IAchievementData {
    /** 进度记录（**数组**，见文件头 ⚠） */
    records: AchRecord[];
    /** 累计领取档数（统计用） */
    claimedTotal: number;
    /** 买过的击杀商店 Buff 种类（`buff_types` 成就的数据源） */
    buffTypes: number[];
    /** 抽到过的肉鸽技能种类（`skills_picked` 成就的数据源） */
    skillKinds: number[];
}

/**
 * 一条成就在界面上的状态：
 *   active    = 下一档还没达成（按钮「未达成」）
 *   claimable = 下一档可领（按钮「领取」）
 *   claimed   = 本档已领、下一档还没达成（按钮「已领取」）
 *   done      = **全部档位已领完**（按钮「已领取」，描述显示「已完成」）
 */
export type AchState = 'active' | 'claimable' | 'claimed' | 'done';

/** 一条成就的完整展示状态（界面只读它，不自己重算判据） */
export interface AchGroupState {
    /** 成就组 */
    group: string;
    /** 分类 */
    category: string;
    /** 成就名 */
    name: string;
    /** 描述（= 这一条成就**第 1 档**的 desc；卡面通常显示 `nextDesc`） */
    desc: string;
    /** **下一档**自己的描述（逐档可不同，如「累计3局把战线推进到第2阶段。」）；`done` 时 = 末档 desc */
    nextDesc: string;
    /** 图标（resources 相对路径，空 = 用占位图） */
    icon: string;
    /** 是否隐藏成就（达成前不展示） */
    silent: boolean;
    /** 展示档位：已领则=已领最高档，未领=第 1 档（卡面染色 / `阶段N` 文案用它） */
    tier: number;
    /** 下一档档位（`state==='done'` 时 = maxTier） */
    nextTier: number;
    /** 已领到第几档 */
    claimedTier: number;
    /** 最高档（**档位数不固定**：3~20 档，别假设 3） */
    maxTier: number;
    /** 当前进度（已钳到**下一档**目标，界面直接显示） */
    progress: number;
    /** 下一档目标数量（`run_*` 型 = **局数**） */
    count: number;
    /** 状态 */
    state: AchState;
    /** 下一档可领的金币（0 = 没有下一档了） */
    nextReward: number;
    /** 末档的特殊效果（无则 null） */
    effect: { code: AchEffectCode; value: number } | null;
    /** 末档效果是否**已生效**（= 末档已领；卡面的效果行/槽按它显隐） */
    effectUnlocked: boolean;
    /** 是否算「隐藏且未达成」（界面显示 `???`；列表里要不要生成这一行由界面定） */
    hidden: boolean;
}

/** 领奖结果 */
export interface AchClaimResult {
    ok: boolean;
    /** 失败原因（ok=false 时有值）：unknown / claimed / unfinished */
    reason?: string;
    /** 本次领取的档位 */
    tier?: number;
    /** 实发金币 */
    gold?: number;
}

/**
 * 一局打完时的「本局读数」—— `reportRunGoals()` 的入参。
 * 全部可选：没传的项 → 对应的 `run_*` target 整族不推进（"这项本局没测到" ≠ "这项是 0"）。
 */
export interface RunGoals {
    /** 本局到达的最高阶段（`run_stage`） */
    stage?: number;
    /** 本局英雄最高等级（`run_hero_level`） */
    heroLevel?: number;
    /** 本局击杀数（`run_kill`） */
    kills?: number;
    /** 本局持有的金币峰值（`run_gold`） */
    gold?: number;
    /** 本局存活时长（秒，`run_survive`） */
    survive?: number;
}

/** target → `RunGoals` 里的字段名（两处必须一起改：这里 + `RunGoals`） */
const RUN_GOAL_KEY: Record<string, keyof RunGoals> = {
    run_stage: 'stage',
    run_hero_level: 'heroLevel',
    run_kill: 'kills',
    run_gold: 'gold',
    run_survive: 'survive',
};

/**
 * 成就模块的宿主能力（由 `DataCenter` 在构造时注入）。
 * 用注入而不是直接 import DataCenter：`DataCenter → AchievementData → DataCenter` 会形成模块循环依赖。
 */
export interface AchievementHost {
    /** 当前账号等级 */
    getAccountLevel(): number;
    /** 连续登录天数 */
    getLoginStreak(): number;
    /** 已收集的遗物**种类数**（`relic_collected` 的数据源） */
    getRelicKinds(): number;
    /** 发奖：只发金币（`DataCenter.grantAchieveReward`） */
    grantReward(gold: number, group: string): void;
}

export class AchievementDataModule extends DataModule<IAchievementData> {
    /** 宿主能力（DataCenter 注入；未注入时只记进度、不发奖，领奖返回失败） */
    private _host: AchievementHost | null = null;

    /** `target → 该 target 的全部成就` 的索引（配表只加载一次，懒建 + 表就绪前不缓存） */
    private _byTarget: Map<AchTarget, AchGroupCfg[]> | null = null;

    constructor() {
        super('achievement_data');
    }

    protected defaultData(): IAchievementData {
        return {
            records: [],
            claimedTotal: 0,
            buffTypes: [],
            skillKinds: [],
        };
    }

    /** 注入宿主能力（只由 DataCenter 调用） */
    setHost(host: AchievementHost): void {
        this._host = host;
    }

    /* ===================================================================
     * 上报进度（对局侧调用）
     * =================================================================== */

    /**
     * 累加进度（kill_enemies / gold_earned / draw_count …）。
     * 与 `taskData.addProgress` 的区别：**领过奖也继续累积**（成就的一次性目标要能滚到银/金档）。
     */
    addProgress(target: AchTarget, amount: number): void {
        if (!(amount > 0)) return;
        if (AchievementConfig.getTargetMode(target) !== 'add') {
            console.warn(`[成就] ${target} 不是累加型条件，已忽略 addProgress（见 ACH_TARGET_MODE）`);
            return;
        }
        for (const g of this._groupsOf(target)) {
            const rec = this._record(g.group, true);
            if (!rec) continue;
            this._write(rec, g, rec.progress + amount);
        }
    }

    /**
     * 取峰值（只增不减）。
     *
     * ⚠ 2026-11 档位改版后，真正的**局内峰值**（`kill_in_run` / `gold_in_run` / `survive_time`）
     * 已经没有成就行在用了（换成了 `run_kill` / `run_gold` / `run_survive`，见 `reportRunGoals`）；
     * 现在走这里的主要是 `level_reached`（账号等级）/ `login_streak`（连续登录）/
     * `relic_collected` / `buff_types` / `skills_picked`（三个"种类数"）以及任务表的
     * `stage_reached` / `hero_level`。
     */
    peakProgress(target: AchTarget, value: number): void {
        if (!(value > 0)) return;
        if (AchievementConfig.getTargetMode(target) !== 'max') {
            console.warn(`[成就] ${target} 不是峰值型条件，已忽略 peakProgress（见 ACH_TARGET_MODE）`);
            return;
        }
        for (const g of this._groupsOf(target)) {
            const rec = this._record(g.group, true);
            if (!rec) continue;
            if (value > rec.progress) this._write(rec, g, value);
        }
    }

    /** 置为完成（`login` 这类一次性条件 → 直接顶到最高档目标，各档依次可领） */
    markFlag(target: AchTarget): void {
        for (const g of this._groupsOf(target)) {
            const rec = this._record(g.group, true);
            if (!rec) continue;
            this._write(rec, g, this._maxCount(g));
        }
    }

    /**
     * 上报「本局达成情况」—— **`run_*`（门槛 × 局数）型成就的唯一推进口**，每局结算调一次。
     *
     * 语义：对每一条 `run_*` 成就的**每一档**，只要本局的数值 ≥ 那一档的门槛（`param`），
     * 那一档的局数计数 **+1**（一局最多 +1，所以"打很多局"才是达成条件）。
     *
     * 为什么用「逐档计数」而不是一个计数器：门槛逐档抬高（第2阶段×3局 → 第3阶段×5局…），
     * 「达到第3阶段的局数」≤「达到第2阶段的局数」—— 共用一个计数器会多算（提前发奖）。
     *
     * @param goals 本局读数（缺省/负数按 0 处理；**只有传了的那几项**会推进对应的 target）
     * @example
     * ```ts
     * // Scene_Game_Stage.reportRunTasks 里（结算，**每局一次**）
     * achieveData.reportRunGoals({
     *     stage: this.stage, heroLevel: this.battleStore.level ?? 1,
     *     kills: this.killCount, gold: this.hero ? this.hero.gold : 0, survive: this.elapsed,
     * });
     * ```
     */
    reportRunGoals(goals: RunGoals): void {
        for (const target of ACH_RUN_TARGETS) {
            const value = goals[RUN_GOAL_KEY[target]] ?? 0;
            if (!(value > 0)) continue;                 // 本局没这项读数 / 读数是 0 → 整族跳过
            for (const g of this._groupsOf(target)) {
                // ⚠ **先判有没有档位达标，再建记录**：这一族每局都会调一次，
                //   无条件建记录会让存档里每次多出 5 条全 0 的空记录（而它们什么都不影响）。
                //   门槛写坏（= 0）的档位**永远不推进**（容器装载时已 warn 过），而不是当成"无门槛"。
                let hit = false;
                for (const tier of g.tiers) {
                    const need = AchievementConfig.getRunParam(tier);
                    if (need > 0 && value >= need) { hit = true; break; }
                }
                if (!hit) continue;

                const rec = this._record(g.group, true);
                if (!rec) continue;
                const counts = this._countsOf(rec, g);
                for (let i = 0; i < g.tiers.length; i++) {
                    const need = AchievementConfig.getRunParam(g.tiers[i]);
                    if (need > 0 && value >= need) counts[i] = (counts[i] ?? 0) + 1;
                }
            }
        }
    }

    /**
     * 记一个「买过的击杀商店 Buff 种类」（`buff_types` 成就的数据源）。
     * 只有**新种类**才会推进进度 —— 进度语义是「种类数」而不是「购买次数」。
     */
    addBuffType(buffId: number): void {
        if (!(buffId > 0) || this.data.buffTypes.indexOf(buffId) >= 0) return;
        this.data.buffTypes.push(buffId);
        this.peakProgress('buff_types', this.data.buffTypes.length);
    }

    /** 记一个「抽到过的肉鸽技能种类」（`skills_picked` 的数据源），语义同 `addBuffType` */
    addSkillKind(skillId: number): void {
        if (!(skillId > 0) || this.data.skillKinds.indexOf(skillId) >= 0) return;
        this.data.skillKinds.push(skillId);
        this.peakProgress('skills_picked', this.data.skillKinds.length);
    }

    /**
     * 对齐**不需要打一局就会变**的峰值：账号等级 / 连续登录 / 遗物种类数 / 两个种类集合。
     *
     * 调用点：`DataCenter.init()`（进游戏时）与成就界面每次 `onShow`（免得上一次没上报的那几条一直不亮）。
     * **幂等**，可以随便调。
     */
    syncNonRunPeaks(): void {
        const host = this._host;
        if (host) {
            this.peakProgress('level_reached', host.getAccountLevel());
            this.peakProgress('login_streak', host.getLoginStreak());
            this.peakProgress('relic_collected', host.getRelicKinds());
        }
        this.peakProgress('buff_types', this.data.buffTypes.length);
        this.peakProgress('skills_picked', this.data.skillKinds.length);
    }

    /* ===================================================================
     * 查询（界面侧）
     * =================================================================== */

    /**
     * 某个分类（不传 = 全部）的成就状态，已排序；**隐藏成就在未达成前不出现**
     * （`silent=1` 且进度 = 0 且一档没领 → 过滤掉；达成后自动转为正常显示）。
     */
    getGroups(category?: string): AchGroupState[] {
        const all = AchievementConfig.getAll();
        const out: AchGroupState[] = [];
        for (const g of all) {
            if (category && g.category !== category) continue;
            const state = this._stateOf(g);
            if (state.hidden) continue;
            out.push(state);
        }
        return out;
    }

    /** 一条成就的状态（未知 group 返回 null） */
    getGroupState(group: string): AchGroupState | null {
        const g = AchievementConfig.getGroup(group);
        return g ? this._stateOf(g) : null;
    }

    /** 当前进度（未记录 = 0；已按**下一档**目标钳制） */
    getProgress(group: string): number {
        const g = AchievementConfig.getGroup(group);
        if (!g) return 0;
        return this._stateOf(g).progress;
    }

    /**
     * 可领档数（红点用）：**只要有一条成就的下一档可领就 > 0**。
     * 因为一次只能领「下一档」，所以它就是「可领的成就条数」。
     */
    getClaimableCount(): number {
        let n = 0;
        for (const g of AchievementConfig.getAll()) {
            if (this._stateOf(g).state === 'claimable') n++;
        }
        return n;
    }

    /* ===================================================================
     * 领奖
     * =================================================================== */

    /**
     * 领取「下一档」奖励（**唯一的发奖口**）。
     *
     * 顺序很重要：**先落盘 `claimedTier` 再发奖** —— 万一发奖过程里又被点一次（连点/重复事件），
     * 第二次会直接看到「下一档还没达成 / 已领完」而失败，不会双发。
     * 效果不需要单独发放：`getEffects()` 直接看「末档是否已领」，落盘即生效。
     */
    claim(group: string): AchClaimResult {
        const g = AchievementConfig.getGroup(group);
        if (!g) return { ok: false, reason: 'unknown' };

        const state = this._stateOf(g);
        if (state.state === 'done') return { ok: false, reason: 'claimed' };
        if (state.state !== 'claimable') return { ok: false, reason: 'unfinished' };

        const tierCfg = AchievementConfig.getTierCfg(group, state.nextTier);
        if (!tierCfg) return { ok: false, reason: 'unknown' };

        const rec = this._record(group, true);
        rec.claimedTier = state.nextTier;          // ① 先落盘
        this.data.claimedTotal += 1;

        const gold = Math.max(0, tierCfg.reward_gold ?? 0);
        this._host?.grantReward(gold, group);      // ② 再发奖

        const effectText = state.nextTier === g.maxTier && g.effect
            ? `，效果生效：${g.effect.code} ${g.effect.value}`
            : '';
        console.log(`[成就] 领取「${g.name}」${tierLabel(state.nextTier)}档：+${gold} 金币${effectText}`);
        return { ok: true, tier: state.nextTier, gold };
    }

    /* ===================================================================
     * 效果（开局快照）
     * =================================================================== */

    /**
     * 已生效的成就效果（`{ [effect_code]: value }`，**已按 `ACH_EFFECT_META.cap` 封顶**）。
     *
     * ⚠ **开局快照**：`Scene_Game_Stage` 每次开局读一次、本局全程用它 ——
     * 局中领奖**不改变本局**（免得打到一半突然多 50 金币 / 多一个商店选项）。
     */
    getEffects(): Partial<Record<AchEffectCode, number>> {
        const out: Partial<Record<AchEffectCode, number>> = {};
        for (const g of AchievementConfig.getAll()) {
            if (!g.effect) continue;
            const rec = this._find(g.group);
            if (!rec || rec.claimedTier < g.maxTier) continue;   // 末档没领 = 效果不生效
            const code = g.effect.code;
            out[code] = (out[code] ?? 0) + g.effect.value;
        }
        for (const code of Object.keys(out) as AchEffectCode[]) {
            const cap = ACH_EFFECT_META[code]?.cap;
            if (typeof cap === 'number') out[code] = Math.min(out[code] as number, cap);
        }
        return out;
    }

    /** 单条效果的当前数值（未生效 = 0） */
    getEffect(code: AchEffectCode): number {
        return this.getEffects()[code] ?? 0;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** `target → 成就` 索引（表未就绪时返回空数组且不缓存） */
    private _groupsOf(target: AchTarget): AchGroupCfg[] {
        if (!this._byTarget) {
            if (!AchievementConfig.isReady()) return [];
            const map = new Map<AchTarget, AchGroupCfg[]>();
            for (const g of AchievementConfig.getAll()) {
                const list = map.get(g.target);
                if (list) list.push(g);
                else map.set(g.target, [g]);
            }
            this._byTarget = map;
        }
        return this._byTarget.get(target) ?? [];
    }

    private _find(group: string): AchRecord | undefined {
        return this.data.records.find(r => r.group === group);
    }

    /** 取记录（create=true 时不存在就新建，保证响应式追踪拿到的是长期存在的对象） */
    private _record(group: string, create: boolean): AchRecord | undefined {
        let rec = this._find(group);
        if (!rec && create) {
            rec = { group, progress: 0, claimedTier: 0 };
            this.data.records.push(rec);
        }
        return rec;
    }

    /**
     * 取 `run_*` 型的**逐档局数**数组（按需创建并挂到记录上）。
     * 挂上去之后是**响应式**的：界面读 `runCounts[i]` 就建立了依赖，`reportRunGoals` 改它即自动重刷。
     */
    private _countsOf(rec: AchRecord, g: AchGroupCfg): number[] {
        const size = Math.max(1, g.tiers.length);
        if (!rec.runCounts || rec.runCounts.length < size) {
            const next = new Array<number>(size).fill(0);
            if (rec.runCounts) for (let i = 0; i < rec.runCounts.length; i++) next[i] = rec.runCounts[i] ?? 0;
            rec.runCounts = next;
        }
        return rec.runCounts;
    }

    /** 写进度（钳到**最高档**目标：领完末档后进度不再无限涨） */
    private _write(rec: AchRecord, g: AchGroupCfg, value: number): void {
        const next = Math.min(this._maxCount(g), Math.max(0, Math.floor(value)));
        if (rec.progress !== next) rec.progress = next;
    }

    /** 一条成就的最高档目标数量（配表异常时兜底 1） */
    private _maxCount(g: AchGroupCfg): number {
        const last = g.tiers[g.tiers.length - 1];
        return last ? AchievementConfig.getCount(last) : 1;
    }

    /** 组装一条成就的展示状态（**判据只在这里**，界面不重算） */
    private _stateOf(g: AchGroupCfg): AchGroupState {
        const rec = this._find(g.group);
        const claimedTier = rec?.claimedTier ?? 0;
        const maxTier = g.maxTier;

        // 下一档：领到哪就 +1；已领完则停在最高档
        const nextTier = Math.min(claimedTier + 1, maxTier);
        const nextCfg = AchievementConfig.getTierCfg(g.group, nextTier);
        const count = nextCfg ? AchievementConfig.getCount(nextCfg) : 0;
        const done = claimedTier >= maxTier;

        // ⚠ 进度取哪一套：`run_*` 型读**下一档自己的局数**（逐档计数），其余读 `progress`
        const rawProgress = isRunTarget(g.target)
            ? (rec?.runCounts?.[nextTier - 1] ?? 0)
            : (rec?.progress ?? 0);

        let state: AchState;
        if (done) state = 'done';
        else if (rawProgress >= count) state = 'claimable';
        else if (claimedTier > 0) state = 'claimed';
        else state = 'active';

        return {
            group: g.group,
            category: g.category,
            name: g.name,
            desc: g.desc,
            // 卡面显示「下一档」自己的文案（逐档 desc：门槛写在里面，如「累计3局把第…推进到第2阶段」）
            nextDesc: (nextCfg?.desc ?? '') || g.desc,
            icon: g.icon,
            silent: g.silent,
            tier: Math.max(1, claimedTier),
            nextTier,
            claimedTier,
            maxTier,
            // 进度显示按「下一档目标」钳制（领完末档时进度就是它的目标值）
            progress: done ? count : Math.min(rawProgress, count),
            count,
            state,
            nextReward: done ? 0 : Math.max(0, nextCfg?.reward_gold ?? 0),
            effect: g.effect ? { code: g.effect.code, value: g.effect.value } : null,
            effectUnlocked: !!g.effect && claimedTier >= maxTier,
            hidden: g.silent && rawProgress <= 0 && claimedTier <= 0,
        };
    }
}

/** 档位文案（日志用，UI 走 `AchievementTierColor.tierName`） */
function tierLabel(tier: number): string {
    return `阶段${tier}`;
}
