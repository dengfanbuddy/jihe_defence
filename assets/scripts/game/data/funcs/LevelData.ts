/**
 * LevelDataModule - 难度（关卡）进度数据模块
 *
 * 存**局外**的两件事（局内那一局怎么缩放由 `common/DifficultyConfig` 算，不在这里）：
 *   · 已通关的最高档 —— 解锁推进的唯一依据：「通关第 N 档 → 解锁第 N+1 档」
 *   · 当前选择 / 上次玩过的档 —— 难度弹窗的默认选中项与主界面的「上次玩过」
 *
 * ── 解锁规则（`docs/difficulty-select/prompts.md` §0）──
 *   通关第 N 档 → 解锁第 N+1 档。所以**可玩档位 = 1 ~ min(已通关+1, 100)**：
 *   一档没通关时只有档 1 可玩（首次游玩默认难度 1，见 `docs/prd/阶段模式_局内规则详解.md` §2.2）。
 *
 * ⚠ 与 `PlayerInfo.maxWave` 的区别：`maxWave` 记的是**局内阶段**（1~5），
 *   本模块记的是**难度档位**（1~100），两者是正交的两个轴，别混用。
 *
 * @example
 * ```ts
 * // 开局前（难度弹窗）：读进度画三态 + 落盘选择
 * const lv = DataCenter.ins.levelData;
 * lv.isUnlocked(7);        // 7 档能不能点
 * lv.isCleared(7);        // 7 档通关过没有（弹窗的三态里没有独立外观，留着给"已通关"标记用）
 * lv.selectLevel(7);       // 确认选择（未解锁会被拒，返回 false）
 *
 * // 局内通关：解锁下一档
 * DataCenter.ins.levelData.markCleared(7);
 * ```
 */

import { DataModule } from '../DataModule';
import { DIFFICULTY_MAX, clampLevel } from '../../common/DifficultyConfig';

/** 难度进度数据结构 */
export interface ILevelData {
    /** 已通关的最高难度档（0 = 一档都没通关过） */
    cleared: number;
    /** 已确认选择的难度档（1 ~ `DIFFICULTY_MAX`）—— 开战时用它 */
    selected: number;
    /** 上次实际打过的难度档（0 = 还没打过；主界面「上次玩过」显示它） */
    lastPlayed: number;
}

export class LevelDataModule extends DataModule<ILevelData> {
    constructor() {
        super('level_progress');
    }

    protected defaultData(): ILevelData {
        return {
            cleared: 0,
            selected: 1,
            lastPlayed: 0,
        };
    }

    /* ===================================================================
     * 读（判据只有这几条，界面**不要自己重算**）
     * =================================================================== */

    /** 档位总数（= DifficultyConfig 的 100） */
    getMaxLevel(): number {
        return DIFFICULTY_MAX;
    }

    /** 已通关的最高档（0 = 无；脏存档会被收敛到 0~100） */
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
     * 当前选中的档（开战时用）。
     * **只读收敛**：脏存档（选择 > 已解锁，例如换了台设备/改过档）一律夹回可玩区间，不写盘。
     */
    getSelectedLevel(): number {
        const n = clampLevel(this.data.selected);
        return Math.min(n, this.getUnlockedLevel());
    }

    /** 上次玩过的档（**0 = 还没打过**；主界面「上次玩过」用 —— 这里允许 0，不能用 clampLevel） */
    getLastPlayedLevel(): number {
        const n = Math.floor(this.data.lastPlayed);
        if (!Number.isFinite(n) || n < 0) return 0;
        return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
    }

    /* ===================================================================
     * 写（唯一入口，界面只调这两个）
     * =================================================================== */

    /**
     * 确认选择某档（难度弹窗「确定」）。
     * @returns 是否写入成功（未解锁 / 越界 → false，数据不动）
     */
    selectLevel(level: number): boolean {
        const n = clampLevel(level);
        if (!this.isUnlocked(n)) return false;
        if (this.data.selected !== n) this.data.selected = n;
        return true;
    }

    /** 记「这一档打过」（进入战斗时调，主界面「上次玩过」读它） */
    markPlayed(level: number): void {
        const n = clampLevel(level);
        if (this.data.lastPlayed !== n) this.data.lastPlayed = n;
    }

    /**
     * 记「这一档通关了」（`Scene_Game_Stage.endRun('victory')` 调）—— **解锁推进的唯一入口**。
     * @returns 是否**新推进了进度**（true = 本次通关解锁了更高档位，主界面/弹窗可以据此提示）
     */
    markCleared(level: number): boolean {
        const n = clampLevel(level);
        const advanced = n > this.getClearedLevel();
        if (advanced) this.data.cleared = n;
        this.markPlayed(n);
        return advanced;
    }
}
