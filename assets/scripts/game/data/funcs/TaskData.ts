/**
 * TaskDataModule — 任务数据模块（局外，跨局累积）
 *
 * ── 口径（2026-09 改）──
 * **奖励不再由「局内结束」统一发放，而是「完成任务 → 领奖」时发**：
 *   · 对局只负责**上报进度**（击杀 / 通关 / 阶段 / 英雄等级 / 消耗金币…），见 Scene_Game_Stage 的上报点；
 *   · 进度达标后玩家在任务界面点「领取」，本模块调宿主注入的 `TaskHost.grantReward()`，
 *     由 `DataCenter` 发**账号经验**（PlayerInfo.addExp → 走等级表）与**金币**（ItemData.currencies.gold）。
 *
 * ── 数据形状 ──
 * `records` 故意用**数组**而不是 `{ [taskId]: record }` 字典：`DataModule` 的深度合并只认
 * 「默认数据里已经存在的 key」（`mergeDeep` 里 `if (!(key in target)) continue`），
 * 用字典存动态任务 id 的话，**读档时会被整片丢掉**（默认数据里 tasks 是空对象）。
 * 数组类型走的是「整片覆盖」，所以能正确读档。
 *
 * ── 重置 ──
 * `dailyKey` = 当天日期（YYYYMMDD）；`weeklyKey` = **本周周一的日期**（天然唯一，避开"第几周"的跨年坑）。
 * 键变化 → 清掉该周期的任务记录（进度与已领取状态一起清）。
 *
 * ── 用法 ──
 *   // 对局侧上报（累加 / 取峰值 / 置完成）
 *   DataCenter.ins.taskData.addProgress('kill_enemies', 1);
 *   DataCenter.ins.taskData.peakProgress('hero_level', level);
 *   DataCenter.ins.taskData.markFlag('login');
 *
 *   // 界面侧
 *   const tasks = DataCenter.ins.taskData.getTasks('daily');   // 已按等级过滤 + 排序
 *   const state = DataCenter.ins.taskData.getState(cfg);       // locked / active / claimable / claimed
 *   const res   = DataCenter.ins.taskData.claim(cfg.id);       // 领奖
 */
import { DataModule } from '../DataModule';
import { TaskConfig } from '../configs/TaskConfig';
import { todayKey, weekKey } from '../../common/DayKey';
import type { TaskCfg, TaskTarget, TaskType } from '../../excel_table/Tb_TaskConfig';

/** 单个任务的进度记录 */
export interface TaskRecord {
    /** 任务 id（tasks.json 的 id） */
    id: number;
    /** 当前进度（已按目标数量钳制） */
    progress: number;
    /** 是否已领奖 */
    claimed: boolean;
}

/** 任务数据模块的数据结构 */
export interface ITaskData {
    /** 日任务周期键（当天日期 YYYYMMDD） */
    dailyKey: string;
    /** 周任务周期键（本周周一的日期 YYYYMMDD） */
    weeklyKey: string;
    /** 进度记录（数组，见文件头注释：字典会被 DataModule 的合并丢掉） */
    records: TaskRecord[];
    /** 累计领取次数（统计用） */
    claimedTotal: number;
}

/** 任务在界面上的三种（四种）状态 */
export type TaskState = 'locked' | 'active' | 'claimable' | 'claimed';

/** 发奖结果（由 DataCenter 回填） */
export interface TaskGrantResult {
    /** 本次是否升级 */
    leveledUp: boolean;
    /** 发奖前的等级 */
    fromLevel: number;
    /** 发奖后的等级 */
    toLevel: number;
    /** 升级过程中额外发放的金币（等级表的 reward_gold 汇总） */
    bonusGold: number;
}

/** 领奖结果 */
export interface TaskClaimResult {
    ok: boolean;
    /** 失败原因（ok=false 时有值）：unknown / claimed / unfinished / locked */
    reason?: string;
    /** 实发账号经验 */
    exp?: number;
    /** 实发金币 */
    gold?: number;
    /** 本次是否升级 */
    leveledUp?: boolean;
    /** 升级后等级 */
    level?: number;
}

/**
 * 任务模块的宿主能力（由 `DataCenter` 在构造时注入）。
 * 用注入而不是直接 import DataCenter：`DataCenter → TaskData → DataCenter` 会形成模块循环依赖。
 */
export interface TaskHost {
    /** 当前账号等级（用于任务的 unlock_level 过滤） */
    getAccountLevel(): number;
    /** 发奖：账号经验 + 金币（返回升级结果） */
    grantReward(exp: number, gold: number, taskId: number): TaskGrantResult;
}

/**
 * 完成条件的进度模式（**唯一真源**，与 `Tb_TaskConfig.TaskTarget` 一一对应）：
 *   add  = 累加（击杀数、金币…）
 *   max  = 取峰值（单局最高阶段 / 单局最高英雄等级）
 *   flag = 置为完成（每日登录）
 */
export const TargetMode: Record<TaskTarget, 'add' | 'max' | 'flag'> = {
    login: 'flag',
    play_games: 'add',
    victory: 'add',
    kill_enemies: 'add',
    gold_earned: 'add',
    spend_gold: 'add',
    relics_picked: 'add',
    skills_used: 'add',
    buffs_bought: 'add',
    stage_reached: 'max',
    hero_level: 'max',
    level_reached: 'max',
};

export class TaskDataModule extends DataModule<ITaskData> {
    /** 宿主能力（DataCenter 注入；未注入时只记进度、不发奖，领奖返回失败） */
    private _host: TaskHost | null = null;

    constructor() {
        super('task_data');
        // 首次构造也要对齐周期（新号第一次进入 = 今天第一次登录）
        this.ensurePeriod();
    }

    protected defaultData(): ITaskData {
        return {
            dailyKey: '',
            weeklyKey: '',
            records: [],
            claimedTotal: 0,
        };
    }

    /** 注入宿主能力（只由 DataCenter 调用） */
    setHost(host: TaskHost): void {
        this._host = host;
    }

    // ────────────── 周期 ──────────────

    /**
     * 对齐日/周周期（**幂等**，可随便调）：
     *   ① 周期键变化 → 清掉该周期的记录（进度 + 已领取状态）；
     *   ② 顺带把「每日登录」类任务置为完成（新的一天自动可领）。
     * 调用点：模块构造（首次进入）、`DataCenter.init()`、任务界面每次打开。
     */
    ensurePeriod(): void {
        const dk = TaskDataModule.todayKey();
        const wk = TaskDataModule.weekKey();

        let dailyRolled = false;
        if (this.data.dailyKey !== dk) {
            this.data.dailyKey = dk;
            this._clearPeriod('daily');
            dailyRolled = true;
        }
        if (this.data.weeklyKey !== wk) {
            this.data.weeklyKey = wk;
            this._clearPeriod('weekly');
        }
        // 配置表里下线的任务记录一并清掉（表未就绪时不动，避免把整包记录删光）
        if (dailyRolled) this._pruneUnknownTasks();

        // 每日登录：幂等（已领过也无所谓，进度本来就该是满的）
        this.markFlag('login');
    }

    // ────────────── 上报进度（对局侧调用） ──────────────

    /** 累加进度（kill_enemies / gold_earned / spend_gold …） */
    addProgress(target: TaskTarget, amount: number): void {
        if (!(amount > 0)) return;
        if (TargetMode[target] !== 'add') {
            console.warn(`[TaskData] ${target} 不是累加型条件，已忽略 addProgress（见 TargetMode）`);
            return;
        }
        for (const cfg of TaskConfig.getByTarget(target)) {
            const rec = this._record(cfg.id, true);
            if (!rec || rec.claimed) continue;
            this._write(rec, cfg, rec.progress + amount);
        }
    }

    /** 取峰值（stage_reached / hero_level / level_reached：只增不减） */
    peakProgress(target: TaskTarget, value: number): void {
        if (!(value > 0)) return;
        if (TargetMode[target] !== 'max') {
            console.warn(`[TaskData] ${target} 不是峰值型条件，已忽略 peakProgress（见 TargetMode）`);
            return;
        }
        for (const cfg of TaskConfig.getByTarget(target)) {
            const rec = this._record(cfg.id, true);
            if (!rec || rec.claimed) continue;
            if (value > rec.progress) this._write(rec, cfg, value);
        }
    }

    /** 置为完成（login） */
    markFlag(target: TaskTarget): void {
        for (const cfg of TaskConfig.getByTarget(target)) {
            const rec = this._record(cfg.id, true);
            if (!rec || rec.claimed) continue;
            this._write(rec, cfg, TaskConfig.getCount(cfg));
        }
    }

    // ────────────── 查询（界面侧） ──────────────

    /**
     * 某个页签要展示的任务：**已按账号等级过滤**（`unlock_level > 当前等级` 的不出现）+ 已排序。
     * @param type  日 / 周
     * @param limit 最多返回几条（0/不传 = 不限；预制件只有 6 个格子，界面按它传）
     */
    getTasks(type: TaskType, limit = 0): TaskCfg[] {
        const level = this._accountLevel();
        const list = TaskConfig.getTasks(type).filter(cfg => TaskConfig.getUnlockLevel(cfg) <= level);
        return limit > 0 ? list.slice(0, limit) : list;
    }

    /** 任务的当前进度（未记录 = 0；已领取 = 目标数量） */
    getProgress(cfg: TaskCfg): number {
        const rec = this._find(cfg.id);
        if (!rec) return 0;
        return Math.min(rec.progress, TaskConfig.getCount(cfg));
    }

    /** 任务状态 */
    getState(cfg: TaskCfg): TaskState {
        if (this._accountLevel() < TaskConfig.getUnlockLevel(cfg)) return 'locked';
        const rec = this._find(cfg.id);
        if (rec?.claimed) return 'claimed';
        const count = TaskConfig.getCount(cfg);
        return (rec?.progress ?? 0) >= count ? 'claimable' : 'active';
    }

    /** 未领取的已完成任务数（红点用；传 type 只数该页签） */
    getClaimableCount(type?: TaskType): number {
        const list = type ? TaskConfig.getTasks(type) : TaskConfig.getAll();
        let n = 0;
        for (const cfg of list) {
            if (this.getState(cfg) === 'claimable') n++;
        }
        return n;
    }

    /** 已领取的任务数（统计用） */
    getClaimedTotal(): number {
        return this.data.claimedTotal;
    }

    // ────────────── 领奖 ──────────────

    /**
     * 领取任务奖励（**唯一的发奖口**）。
     *
     * 顺序很重要：先落盘 `claimed = true` 再发奖 —— 万一发奖过程里又被点一次（连点/重复事件），
     * 第二次会直接看到已领取而失败，不会双发。
     */
    claim(taskId: number): TaskClaimResult {
        const cfg = TaskConfig.getTask(taskId);
        if (!cfg) return { ok: false, reason: 'unknown' };

        this.ensurePeriod();

        const state = this.getState(cfg);
        if (state === 'claimed') return { ok: false, reason: 'claimed' };
        if (state === 'locked') return { ok: false, reason: 'locked' };
        if (state !== 'claimable') return { ok: false, reason: 'unfinished' };

        const rec = this._record(taskId, true);
        rec.claimed = true;
        this.data.claimedTotal += 1;

        const exp = Math.max(0, cfg.reward_exp ?? 0);
        const gold = Math.max(0, cfg.reward_gold ?? 0);
        const grant = this._host
            ? this._host.grantReward(exp, gold, taskId)
            : { leveledUp: false, fromLevel: this._accountLevel(), toLevel: this._accountLevel(), bonusGold: 0 };

        console.log(`[任务] 领取「${cfg.name}」：+${exp} 账号经验 / +${gold} 金币`
            + (grant.bonusGold > 0 ? ` / 升级奖励 +${grant.bonusGold} 金币` : '')
            + (grant.leveledUp ? `（账号升级 ${grant.fromLevel} → ${grant.toLevel}）` : ''));

        return {
            ok: true,
            exp,
            gold: gold + (grant.bonusGold ?? 0),
            leveledUp: grant.leveledUp,
            level: grant.toLevel,
        };
    }

    // ────────────── 内部 ──────────────

    /** 账号等级（宿主未注入时按 1 处理） */
    private _accountLevel(): number {
        return this._host?.getAccountLevel() ?? 1;
    }

    private _find(taskId: number): TaskRecord | undefined {
        return this.data.records.find(r => r.id === taskId);
    }

    /** 取记录（create=true 时不存在就新建，保证响应式追踪拿到的是长期存在的对象） */
    private _record(taskId: number, create: boolean): TaskRecord | undefined {
        let rec = this._find(taskId);
        if (!rec && create) {
            rec = { id: taskId, progress: 0, claimed: false };
            this.data.records.push(rec);
        }
        return rec;
    }

    /** 写进度（钳制到目标数量，避免超配表上限的脏数据） */
    private _write(rec: TaskRecord, cfg: TaskCfg, value: number): void {
        const count = TaskConfig.getCount(cfg);
        const next = Math.min(count, Math.max(0, value));
        if (rec.progress !== next) rec.progress = next;
    }

    /** 清掉某个周期的记录（进度 + 已领取状态一起清） */
    private _clearPeriod(type: TaskType): void {
        const ids = new Set(TaskConfig.getTasks(type).map(c => c.id));
        if (!ids.size) {
            // 表未就绪：按 id 段兜底（日 1000 段 / 周 2000 段），避免"重置不掉"
            const lo = type === 'daily' ? 1000 : 2000;
            const hi = lo + 1000;
            this.data.records = this.data.records.filter(r => r.id < lo || r.id >= hi);
            return;
        }
        this.data.records = this.data.records.filter(r => !ids.has(r.id));
    }

    /** 清掉配置表里已经不存在的任务记录（表未就绪时不动） */
    private _pruneUnknownTasks(): void {
        if (!TaskConfig.isReady()) return;
        const alive = new Set(TaskConfig.getAll().map(c => c.id));
        this.data.records = this.data.records.filter(r => alive.has(r.id));
    }

    /**
     * 当天日期键 YYYYMMDD。
     * ⚠ 实现已抽到 `game/common/DayKey.ts`（**唯一口径**）：日/周键必须与 `ShopData`
     *   的每日重置、每日广告次数用**同一把尺**，各写一份迟早在时区/UTC 上分叉。
     */
    private static todayKey(): string {
        return todayKey();
    }

    /** 本周周期键 = 本周周一的日期 YYYYMMDD（同上，口径在 DayKey.ts） */
    private static weekKey(): string {
        return weekKey();
    }
}
