/**
 * LevelConfig.ts — 账号等级配置门面
 *
 * 数据源：`assets/resources/tb/player_levels.json`（编辑源 `tools/excel_export/excel/player_levels.xlsx`）
 * 容器：`excel_table/Tb_PlayerLevelConfig.ts`
 *
 * **等级经验口径的唯一入口**（替代原来 `battle_constants.playerExpFormulaBase/Ratio` 的公式）：
 *   LevelConfig.getExpToNext(level)     // 从 level 升到下一级所需经验（满级 0）
 *   LevelConfig.getMaxLevel()           // 满级等级
 *   LevelConfig.getGoldReward(level)    // 升到 level 时的金币奖励
 *   LevelConfig.hasFeature(level, code) // 该等级是否解锁了某功能（后续玩法按它挂钩）
 *
 * 容错：配表未加载时**回落到旧公式**（battle_constants 的 base × ratio^(lv-1)），
 * 保证早期调用（Loading 里 DataCenter 构造、或表缺失）依然能升级，不会静默卡死在 1 级。
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
import { PlayerLevelCfgContainer } from '../../excel_table/Tb_PlayerLevelConfig';
import type { PlayerLevelCfg } from '../../excel_table/Tb_PlayerLevelConfig';

export type { PlayerLevelCfg };

/** 功能解锁标识（配表 `unlock_features` 列的取值；后续新玩法在这里加常量） */
export const LevelFeature = {
    /** 每日任务 */
    DailyTask: 'daily_task',
    /** 每周任务 */
    WeeklyTask: 'weekly_task',
    /** 局外遗物（跨局永久加成） */
    RelicOuter: 'relic_outer',
    /** 遗物升阶 */
    RelicOuterUpgrade: 'relic_outer_upgrade',
    /** 满级：全部内容 */
    AllContent: 'all_content',
} as const;

export class LevelConfig {
    /** 表不可用时的等级上限（与旧公式口径一致：旧实现没有上限，这里给一个安全上界） */
    private static readonly FALLBACK_MAX_LEVEL = 99;

    /** 取容器（未加载时返回 null，不抛异常） */
    private static _container(): PlayerLevelCfgContainer | null {
        try {
            const c = TbRoot.ins.getTbContainer(PlayerLevelCfgContainer);
            return c && c.size > 0 ? c : null;
        } catch {
            return null;
        }
    }

    /** 等级表是否就绪（诊断用；未就绪时所有查询走旧公式回落） */
    static isReady(): boolean {
        return !!LevelConfig._container();
    }

    /** 等级配置行 */
    static getCfg(level: number): PlayerLevelCfg | undefined {
        return LevelConfig._container()?.getCfgById(level);
    }

    /** 满级等级（表就绪 = 表里最后一个可升级的等级；未就绪 = 99） */
    static getMaxLevel(): number {
        const c = LevelConfig._container();
        if (!c) return LevelConfig.FALLBACK_MAX_LEVEL;
        return Math.max(1, c.getMaxLevel());
    }

    /** 是否满级 */
    static isMaxLevel(level: number): boolean {
        return level >= LevelConfig.getMaxLevel();
    }

    /**
     * 从 level 升到下一级所需经验。
     * 表就绪 → 读表（满级行为 0）；未就绪 → 旧公式 `floor(base × ratio^(level-1))`。
     */
    static getExpToNext(level: number): number {
        const c = LevelConfig._container();
        if (c) return c.getExpToNext(level);
        const base = BattleConstUtil.getPlayerExpFormulaBase();
        const ratio = BattleConstUtil.getPlayerExpFormulaRatio();
        return Math.floor(base * Math.pow(ratio, Math.max(1, level) - 1));
    }

    /** 升到 level 时的一次性金币奖励（表未就绪 = 0） */
    static getGoldReward(level: number): number {
        return LevelConfig._container()?.getGoldReward(level) ?? 0;
    }

    /** level 这一级解锁的功能标识（表未就绪 = 空） */
    static getUnlockFeatures(level: number): string[] {
        return LevelConfig._container()?.getUnlockFeatures(level) ?? [];
    }

    /**
     * 当前等级是否已解锁某功能。
     * 语义：**任意 ≤ level 的等级行**声明过该标识即视为已解锁（解锁一次永久有效），
     * 所以配表时只需要在「解锁的那一级」那一行写上标识，不用每行重复。
     */
    static hasFeature(level: number, code: string): boolean {
        const c = LevelConfig._container();
        if (!c) return true; // 表不可用时不做任何功能门槛（保守放行，避免把功能全锁死）
        for (const cfg of c.cfgs) {
            if (cfg.id > level) break;
            if ((cfg.unlock_features ?? []).indexOf(code) >= 0) return true;
        }
        return false;
    }

    /** 等级展示文案（如「解锁：每周任务」；无则空串） */
    static getDesc(level: number): string {
        return LevelConfig.getCfg(level)?.desc ?? '';
    }
}
