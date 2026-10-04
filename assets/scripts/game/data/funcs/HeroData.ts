/**
 * HeroDataModule - 英雄/角色数据模块（局外，跨局累积）
 *
 * 数据内容：
 * - 已解锁英雄列表（**记录存在 = 已解锁**，没有"锁定中"的中间态）
 * - 每个英雄的等级、经验值
 *
 * ── 数据形状：为什么是**数组**而不是 `{ [英雄id]: {...} }` 字典（2026-10 改）──
 * 字典形态**解锁读档会丢**：`DataModule._load()` 用 `mergeDeep` 合并存档，
 * 而它只认「默认数据里已经存在的 key」（`if (!(key in target)) continue`，防的是删字段后残留）。
 * 英雄默认数据里只预置了 1001 一位 → 运行时解锁 1002 写进 localStorage，
 * 下次启动合并时 target 里没有 `1002` 这个 key，**整条被静默跳过**（等于解锁白花钱）。
 * 数组走的是「整片覆盖」分支（`Array.isArray` 那一支），所以读档正确 ——
 * 同一个坑 `TaskData.records` / `AchievementData.records` 已经踩过并因此改用数组，见那两份文件头。
 *
 * ── 谁改数据 ──
 *   · 升级 / 解锁的**金币消耗**在 `DataCenter`（`unlockHero` / `levelUpHero`，本项目唯一的金币出口），
 *     本模块只做纯数据操作（发英雄、加等级、加经验），不认识金币、不认识界面。
 *   · 界面（`Scene_Menu` → 英雄页）只读 `isUnlocked` / `getHeroInfo`，动作一律走 `DataCenter`。
 */

import { DataModule } from '../DataModule';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/** 默认解锁的英雄（`units.json` hero id 1001 火枪） */
export const DEFAULT_UNLOCKED_HERO_ID = 1001;

/** 单个英雄的数据 */
export interface HeroInfo {
    /** 英雄配置 ID */
    id: number;
    /** 当前等级（无上限，可无限提升） */
    level: number;
    /** 当前经验值 */
    exp: number;
}

/** 英雄数据模块的数据结构 */
export interface IHeroData {
    /**
     * 英雄记录（**数组**，见文件头 ⚠；每条记录存在 = 该英雄已解锁）
     */
    records: HeroInfo[];
}

export class HeroDataModule extends DataModule<IHeroData> {
    constructor() {
        super('hero_data');
    }

    /**
     * 默认数据方法
     * @returns 只解锁火枪（`units.json` hero id 1001）的空档案
     */
    protected defaultData(): IHeroData {
        return {
            records: [
                { id: DEFAULT_UNLOCKED_HERO_ID, level: 1, exp: 0 },
            ],
        };
    }

    // ────────────── 查询 ──────────────

    /** 获取英雄信息（未解锁/不存在则返回 null） */
    getHeroInfo(heroId: number): HeroInfo | null {
        return this.data.records.find((r) => r.id === heroId) ?? null;
    }

    /** 该英雄是否已解锁 */
    isUnlocked(heroId: number): boolean {
        return this.getHeroInfo(heroId) !== null;
    }

    /** 已解锁英雄的记录（只读视图，调用方不要直接改） */
    getUnlocked(): readonly HeroInfo[] {
        return this.data.records;
    }

    /** 英雄当前等级（未解锁返回 0） */
    getHeroLevel(heroId: number): number {
        return this.getHeroInfo(heroId)?.level ?? 0;
    }

    /** 英雄当前经验值（未解锁返回 0）—— 界面画经验条用（`HeroCard` 的 `exp_bar`） */
    getHeroExp(heroId: number): number {
        return this.getHeroInfo(heroId)?.exp ?? 0;
    }

    /**
     * 从 `level` 升到 `level + 1` 所需的**经验总量**（`battle_constants.heroExpFormulaBase/Ratio`）。
     *
     * 公开给界面用：经验条的进度 = `当前经验 / getExpForNextLevel(当前等级)`
     * （见 `Cmp_Heroes.buildVM` 的 `exp` / `expMax`）。**同一个公式不要再抄第二份** ——
     * `addHeroExp` 的升级结算用的就是本方法。
     *
     * @param level 当前等级（≥ 1；传 0/负数按 1 处理）
     */
    getExpForNextLevel(level: number): number {
        const base = BattleConstUtil.getHeroExpFormulaBase();
        const ratio = BattleConstUtil.getHeroExpFormulaRatio();
        const lv = Math.max(1, Math.floor(level || 1));
        return Math.max(0, Math.floor(base * Math.pow(ratio > 0 ? ratio : 1, lv - 1)));
    }

    // ────────────── 写操作（纯数据，不含金币） ──────────────

    /**
     * 解锁英雄（**纯数据操作**：只写记录，不扣任何货币）。
     *
     * ⚠ 界面上的「解锁」按钮**不要**直接用它 —— 那条路要先收钱：
     *   `DataCenter.ins.unlockHero(id)`（查价 → 扣金币 → 调本方法）。
     *   本方法留给「免费发英雄」的场景（活动、奖励、剧情解锁）。
     * @returns 真正写入了记录才为 true（已解锁 = false）
     */
    unlockHero(heroId: number): boolean {
        if (!heroId || this.isUnlocked(heroId)) return false;
        this.data.records.push({ id: heroId, level: 1, exp: 0 });
        return true;
    }

    /** 英雄升 1 级（**纯数据操作**，不扣货币；金币那一层在 `DataCenter.levelUpHero`） */
    addLevel(heroId: number): boolean {
        const hero = this.getHeroInfo(heroId);
        if (!hero) return false;
        hero.level += 1;
        return true;
    }

    /**
     * 英雄增加经验（按 `battle_constants` 的 `heroExpFormulaBase/Ratio` 逐级结算，可一次升多级）。
     *
     * ⚠ **发放链路仍未接线**：英雄经验的发放口径（`clearRewardHeroExpBase`）已随"奖励改为任务领取"下线，
     *   见 `battle_constants` 里那两条的说明。现在的口径是「一局结束发通用英雄经验、在英雄详情面板
     *   消耗经验升级」，接了发放就调本方法；而**经验条的展示**已经用上同一个公式
     *   （`getExpForNextLevel` ← `Cmp_Heroes.buildVM`），所以结算与展示不会各说一套。
     * @returns 是否至少升了一级
     */
    addHeroExp(heroId: number, amount: number): boolean {
        const hero = this.getHeroInfo(heroId);
        if (!hero || amount <= 0) return false;

        hero.exp += amount;
        let leveledUp = false;
        while (true) {
            const need = this.getExpForNextLevel(hero.level);
            // ⚠ 必须挡 `need <= 0`：配表把 `heroExpFormulaBase` 配成 0 时，这里会变成
            //    `exp -= 0; level += 1` 的**死循环**（整个游戏卡住，且没有任何报错）
            if (need <= 0 || hero.exp < need) break;
            hero.exp -= need;
            hero.level += 1;
            leveledUp = true;
        }
        return leveledUp;
    }
}
