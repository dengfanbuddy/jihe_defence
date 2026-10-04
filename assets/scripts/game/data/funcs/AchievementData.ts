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
 * achieveData.peakProgress('stage_reached', 5);   // 峰值型（只增不减）
 * achieveData.markFlag('login');                  // 置为完成
 *
 * // 界面侧
 * const list  = achieveData.getGroups('stage');        // 某分类的成就（已排序 + 隐藏过滤）
 * const state = achieveData.getGroupState('st_clear'); // { tier, progress, count, state, nextReward, effect... }
 * const n     = achieveData.getClaimableCount();       // 红点
 * const res   = achieveData.claim('st_clear');         // 领「下一档」
 *
 * // 开局快照（`Scene_Game_Stage` 每次开局读一次，本局全程用它）
 * const effects = achieveData.getEffects();            // { run_start_gold: 50, ... }（已按封顶 clamp）
 * ```
 */
import { DataModule } from '../DataModule';
import { AchievementConfig } from '../configs/AchievementConfig';
import { ACH_EFFECT_META } from '../../common/AchievementEffectMeta';
import type { AchEffectCode, AchGroupCfg, AchTarget } from '../../excel_table/Tb_AchievementConfig';

/** 单条成就的进度记录 */
export interface AchRecord {
    /** 成就组（= 配表 `group`，一条成就一条记录） */
    group: string;
    /** 当前进度（**只增不减**；峰值型取历史峰值，已按最高档目标钳制） */
    progress: number;
    /** 已领到第几档（0 = 一档都没领） */
    claimedTier: number;
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
    /** 描述 */
    desc: string;
    /** 图标（resources 相对路径，空 = 用占位图） */
    icon: string;
    /** 是否隐藏成就（达成前不展示） */
    silent: boolean;
    /** 展示档位：已领则=已领最高档，未领=第 1 档（卡面染色 / `lv` 文案用它） */
    tier: number;
    /** 下一档档位（`state==='done'` 时 = maxTier） */
    nextTier: number;
    /** 已领到第几档 */
    claimedTier: number;
    /** 最高档 */
    maxTier: number;
    /** 当前进度（已钳到**下一档**目标，界面直接显示） */
    progress: number;
    /** 下一档目标数量 */
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

    /** 取峰值（stage_reached / hero_level / kill_in_run / login_streak：只增不减） */
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

    /** 写进度（钳到**最高档**目标：领完金档后进度不再无限涨） */
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
        const rawProgress = rec?.progress ?? 0;
        const claimedTier = rec?.claimedTier ?? 0;
        const maxTier = g.maxTier;

        // 下一档：领到哪就 +1；已领完则停在最高档
        const nextTier = Math.min(claimedTier + 1, maxTier);
        const nextCfg = AchievementConfig.getTierCfg(g.group, nextTier);
        const count = nextCfg ? AchievementConfig.getCount(nextCfg) : 0;
        const done = claimedTier >= maxTier;

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
            icon: g.icon,
            silent: g.silent,
            tier: Math.max(1, claimedTier),
            nextTier,
            claimedTier,
            maxTier,
            // 进度显示按「下一档目标」钳制（领完金档时进度就是它的目标值）
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

/** 档位中文（日志用，UI 走 `AchievementTierColor.tierName`） */
function tierLabel(tier: number): string {
    return tier === 3 ? '金' : tier === 2 ? '银' : '铜';
}
