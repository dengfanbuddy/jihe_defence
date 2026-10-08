/**
 * LevelDataModule - 难度（关卡）进度数据模块
 *
 * 存**局外**的三件事（局内那一局怎么缩放由 `common/DifficultyConfig` 算，不在这里）：
 *   · **当前选中的模式** —— 主界面「游戏」页那张模式卡点一下就落盘（`common/GameModeConfig` 是真源）
 *   · **已通关的最高档** —— 解锁推进的唯一依据：「通关第 N 档 → 解锁第 N+1 档」；
 *     **全局一份**（两个模式共用这条阶梯，见下）
 *   · **每个模式各自的**当前选择 / 上次玩过的档 —— 难度弹窗的默认选中项与主界面的「上次玩过」
 *
 * ── 解锁规则（`docs/difficulty-select/prompts.md` §0）──
 *   通关第 N 档 → 解锁第 N+1 档。所以**可玩档位 = 1 ~ min(已通关+1, 100)**：
 *   一档没通关时只有档 1 可玩（首次游玩默认难度 1，见 `docs/prd/阶段模式_局内规则详解.md` §2.2）。
 *
 * ── 两个模式怎么分（本期口径，见 `docs/game-mode/README.md`）──
 *   · **共用**：`cleared`（已通关的最高档）→ 解锁阶梯。设计稿的口径是「无尽模式 = 在已解锁难度上无限阶段」，
 *     所以它**不单独解锁**，也**不单独记通关**（它没有终点，不会 `markCleared`）。
 *   · **各记一份**：`selected` / `lastPlayed`。切回某个模式时，难度弹窗默认停在
 *     "这个模式上次准备打的档"，而不是被另一个模式覆盖掉。
 *   · 于是主界面顶部那两个读数：**「最高通过」是全局的**（两个模式显示同一个数），
 *     **「上次玩过」跟着模式走**。要让「最高通过」也分模式，改 `getClearedLevel()` 一处即可。
 *
 * ⚠ 与 `PlayerInfo.maxWave` 的区别：`maxWave` 记的是**局内阶段**（1~5），
 *   本模块记的是**难度档位**（1~100），两者是正交的两个轴，别混用。
 *
 * ⚠ **`modes` 必须是数组，不能是字典**：`DataModule` 读档走 `mergeDeep`，
 *   动态字典（`{stage: {...}}`）在"默认值里没有这个 key"时会被整片吃掉
 *   （`BagData.items` / `EquipmentCollection.collected` 都踩过），数组则是整体覆盖。
 *
 * @example
 * ```ts
 * // 主界面：选了模式 / 读进度画顶部信息
 * const lv = DataCenter.ins.levelData;
 * lv.selectMode('no_ending');       // 模式卡点一下（唯一入口）
 * lv.getMode();                     // → 'no_ending'
 * lv.getLastPlayedLevel();          // → 该模式上次打过的档（0 = 还没打过）
 * lv.getClearedLevel();             // → 全局：已通关的最高档
 *
 * // 难度弹窗：读进度画三态 + 落盘选择（都按**当前模式**各记一份）
 * lv.isUnlocked(7);                 // 7 档能不能点（全局阶梯）
 * lv.selectLevel(7);                // 确认选择（未解锁会被拒，返回 false）
 *
 * // 局内通关：解锁下一档
 * DataCenter.ins.levelData.markCleared(7);
 * ```
 */

import { DataModule } from '../DataModule';
import { DIFFICULTY_MAX, clampLevel } from '../../common/DifficultyConfig';
import { DEFAULT_GAME_MODE, GAME_MODES, normalizeGameMode, type GameModeId } from '../../common/GameModeConfig';

/** 单个模式的进度（`selected` / `lastPlayed` 按模式各记一份） */
export interface IModeProgress {
    /** 模式 id（`GameModeConfig.GameMode`；取值只可能是 `GAME_MODES` 里的 id） */
    mode: string;
    /** 这个模式**当前选中**的档（1 ~ `DIFFICULTY_MAX`）—— 打开难度弹窗时的默认落点 */
    selected: number;
    /** 这个模式**上次实际打过**的档（0 = 还没打过；主界面「上次玩过」显示它） */
    lastPlayed: number;
}

/** 难度进度数据结构 */
export interface ILevelData {
    /** 已通关的最高难度档（0 = 一档都没通关过）—— **全局一份**，两个模式共用（见文件头） */
    cleared: number;
    /**
     * ⚠ **旧档兼容字段**（= 只有一个模式时"当前选中的难度档"）。
     * 读档时会被迁进 `modes` 里默认模式那一条，之后**没有任何读写方** ——
     * 别写它、也别读它，一律走 `getSelectedLevel()` / `selectLevel()`。
     */
    selected: number;
    /** ⚠ **旧档兼容字段**，同 `selected`（= 只有一个模式时的「上次玩过」）。 */
    lastPlayed: number;
    /** 当前选中的模式 id（`GameModeConfig.GameMode`；脏值在读取时收敛，不写盘） */
    mode: string;
    /** 每个模式各自的进度（**数组**，不是字典 —— 理由见文件头） */
    modes: IModeProgress[];
}

/** `lastPlayed` 的合法区间是 0~100（0 = 没打过），不能用 `clampLevel`（它会把 0 抬成 1） */
function clampLastPlayed(value: unknown): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
}

export class LevelDataModule extends DataModule<ILevelData> {
    constructor() {
        super('level_progress');
        // 读档之后补一次记录（老存档里没有 `modes` 数组 → 由 `selected`/`lastPlayed` 迁进来）
        this.ensureRecords();
    }

    protected defaultData(): ILevelData {
        return {
            cleared: 0,
            selected: 1,
            lastPlayed: 0,
            mode: DEFAULT_GAME_MODE,
            modes: GAME_MODES.map((m) => ({ mode: m.id, selected: 1, lastPlayed: 0 })),
        };
    }

    /* ===================================================================
     * 模式（主界面模式卡的唯一落盘口）
     * =================================================================== */

    /** 当前选中的模式（脏值收敛到默认，**不写盘**） */
    getMode(): GameModeId {
        return normalizeGameMode(this.data.mode);
    }

    /**
     * 选一个模式（主界面模式卡点一下调它）。
     * @returns 是否写入了（非法 id / 与当前相同 → false，数据不动）
     */
    selectMode(mode: string): boolean {
        const id = normalizeGameMode(mode);
        if (id !== mode) return false;          // 只认受支持的 id（`card-002` 那种一律拒绝）
        if (this.data.mode === id) return false;
        this.data.mode = id;
        return true;
    }

    /**
     * 主界面刷新用的**指纹**（模式 + 全局进度 + 每个模式的 selected/lastPlayed）。
     *
     * 给 `scope.watch` 当只读数据源：**它不建记录、不写盘**（在 watcher 的取值函数里改数据
     * 会让追踪重入），值一变就说明主界面该重画了。
     */
    progressKey(): string {
        const parts: string[] = [this.getMode(), `${this.getClearedLevel()}`];
        for (const info of GAME_MODES) {
            const rec = this.findRecord(info.id);
            parts.push(`${info.id}:${rec ? clampLevel(rec.selected) : 0}/${rec ? clampLastPlayed(rec.lastPlayed) : 0}`);
        }
        return parts.join('|');
    }

    /* ===================================================================
     * 读（判据只有这几条，界面**不要自己重算**）
     * =================================================================== */

    /** 档位总数（= DifficultyConfig 的 100） */
    getMaxLevel(): number {
        return DIFFICULTY_MAX;
    }

    /** 已通关的最高档（0 = 无；脏存档会被收敛到 0~100）—— **全局一份**，与模式无关 */
    getClearedLevel(): number {
        const n = Math.floor(this.data.cleared);
        if (!Number.isFinite(n) || n < 0) return 0;
        return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
    }

    /** 已通关的档数（= 最高档；档位是连续推进的，不存在跳档） */
    getClearedCount(): number {
        return this.getClearedLevel();
    }

    /**
     * **已解锁到第几档** —— 可玩档位 = 1 ~ 本值。
     * 通关第 N 档解锁第 N+1 档，所以它 = min(已通关 + 1, 100)：一档没过时只有档 1 可玩。
     * **两个模式共用**（无尽模式不单独解锁，见文件头）。
     */
    getUnlockedLevel(): number {
        return Math.min(DIFFICULTY_MAX, this.getClearedLevel() + 1);
    }

    /** 该档是否可玩（弹窗里"已解锁"的那一档底色） */
    isUnlocked(level: number): boolean {
        const n = clampLevel(level);
        return n <= this.getUnlockedLevel();
    }

    /** 该档是否已通关（弹窗里的"已通关勾"） */
    isCleared(level: number): boolean {
        const n = clampLevel(level);
        return n >= 1 && n <= this.getClearedLevel();
    }

    /**
     * 某个模式**当前选中的档**（开战时用；`mode` 省略 = 当前模式）。
     * **只读收敛**：脏存档（选择 > 已解锁，例如换了台设备/改过档）一律夹回可玩区间，不写盘。
     */
    getSelectedLevel(mode?: string): number {
        const n = clampLevel(this.recordOf(mode).selected);
        return Math.min(n, this.getUnlockedLevel());
    }

    /**
     * 某个模式**上次玩过的档**（`mode` 省略 = 当前模式）。
     * **0 = 还没打过** —— 这里允许 0，不能用 `clampLevel`。
     */
    getLastPlayedLevel(mode?: string): number {
        return clampLastPlayed(this.recordOf(mode).lastPlayed);
    }

    /* ===================================================================
     * 写（唯一入口，界面只调这几个）
     * =================================================================== */

    /**
     * 确认选择某档（难度弹窗「确定」；`mode` 省略 = 当前模式 —— 弹窗开的就是当前模式那套）。
     * @returns 是否写入成功（未解锁 / 越界 → false，数据不动）
     */
    selectLevel(level: number, mode?: string): boolean {
        const n = clampLevel(level);
        if (!this.isUnlocked(n)) return false;
        const rec = this.recordOf(mode);
        if (rec.selected !== n) rec.selected = n;
        return true;
    }

    /** 记「这一档打过」（进入战斗时调；主界面「上次玩过」读它） */
    markPlayed(level: number, mode?: string): void {
        const n = clampLevel(level);
        const rec = this.recordOf(mode);
        if (rec.lastPlayed !== n) rec.lastPlayed = n;
    }

    /**
     * 记「这一档通关了」（`Scene_Game_Stage.endRun('victory')` 调）—— **解锁推进的唯一入口**。
     * @returns 是否**新推进了进度**（true = 本次通关解锁了更高档位，主界面/弹窗可以据此提示）
     */
    markCleared(level: number): boolean {
        const n = clampLevel(level);
        const advanced = n > this.getClearedLevel();
        if (advanced) this.data.cleared = n;
        // 「上次玩过」按**本局所在的模式**记（无尽模式通关同样算它这一档打过）
        this.markPlayed(n);
        return advanced;
    }

    /* ===================================================================
     * 内部：模式记录的取用与迁移
     * =================================================================== */

    /** 找一个模式已有的记录（**纯读**，没有就回 null） */
    private findRecord(mode: string): IModeProgress {
        const id = normalizeGameMode(mode);
        const list = this.data.modes;
        if (!Array.isArray(list)) return null;
        for (const rec of list) {
            if (rec && rec.mode === id) return rec;
        }
        return null;
    }

    /**
     * 取某个模式的记录，缺了就补一条（`selected` = 1 / `lastPlayed` = 0）。
     *
     * 自愈式，所以**不需要**在别处再写一遍"补记录"的逻辑：`load()` / `reset()` 之后
     * 任何一次读写都会把缺的那条补回来（`reset()` 会直接铺满，见 `defaultData`）。
     */
    private recordOf(mode?: string): IModeProgress {
        const id = normalizeGameMode(mode);
        const found = this.findRecord(id);
        if (found) return found;
        const created: IModeProgress = { mode: id, selected: 1, lastPlayed: 0 };
        if (!Array.isArray(this.data.modes)) this.data.modes = [];
        this.data.modes.push(created);
        return created;
    }

    /**
     * 读档后把 `GAME_MODES` 里每个模式都补齐一条记录（幂等）。
     *
     * ⚠ **老存档迁移**：只有 `selected` / `lastPlayed` 两个标量、没有 `modes` 数组时，
     *   那两个值归到**默认模式（阶段模式）**名下 —— 那时工程里只有它一个模式，
     *   所以这是无损迁移，不丢玩家进度。
     */
    private ensureRecords(): void {
        for (const info of GAME_MODES) {
            if (this.findRecord(info.id)) continue;
            const rec = this.recordOf(info.id);
            if (info.id !== DEFAULT_GAME_MODE) continue;
            rec.selected = clampLevel(this.data.selected);
            rec.lastPlayed = clampLastPlayed(this.data.lastPlayed);
        }
    }
}
