/**
 * AchievementConfig.ts — 成就配置门面
 *
 * 数据源：`assets/resources/tb/achievements.json`（编辑源 `tools/excel_export/excel/achievements.xlsx`）
 * 容器：`excel_table/Tb_AchievementConfig.ts`（**一行 = 一档**，容器里已按 `group` 归并成「一条成就」）
 *
 * 这层只做「读配置」，不含任何进度与领奖逻辑（那些在 `data/funcs/AchievementData.ts`）：
 *   AchievementConfig.getCategories()        // 分类条（只返回**有内容**的分类）
 *   AchievementConfig.getByCategory('stage') // 某分类的成就（已排序）
 *   AchievementConfig.getGroup('st_clear')   // 一条成就（含它的 3 个档位）
 *   AchievementConfig.getTargetMode('victory') // 进度模式（add / max / flag）
 *
 * 容错：配表未加载完成时返回空结果（与 TaskConfig / ShopConfig / BattleConstUtil 一致），
 * 调用方拿到空列表只会「没有成就」，不会崩。
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
import { AchievementCfgContainer, ACH_CATEGORY_NAME, ACH_CATEGORY_ORDER } from '../../excel_table/Tb_AchievementConfig';
import type { AchCfg, AchCategory, AchEffectCode, AchGroupCfg, AchTarget } from '../../excel_table/Tb_AchievementConfig';
import { formatGold } from '../../common/GoldText';

export type { AchCfg, AchCategory, AchEffectCode, AchGroupCfg, AchTarget };
export { ACH_CATEGORY_NAME, ACH_CATEGORY_ORDER };

/**
 * 完成条件的**进度模式**（唯一真源）：进度怎么根据外部事件更新。
 *   add  = 累加（击杀数、通关次数、金币…）
 *   max  = 取峰值（单局最高阶段 / 单局英雄等级 / 单局金币峰值）
 *   flag = 置为完成（每日登录这类一次性的）
 *
 * ⚠ 前 12 个与 `TaskData.TargetMode` **同一个词表、必须同一个语义**（改这里要同步那边）；
 *   后 16 个是成就专属（数据来源见 `docs/成就系统设计.md` §3.3）。
 */
export const ACH_TARGET_MODE: Record<AchTarget, 'add' | 'max' | 'flag'> = {
    // —— 与 tasks 共用（口径必须与 TaskData.TargetMode 一致）——
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
    // —— 成就专属 ——
    level_up_count: 'add',
    login_streak: 'max',
    survive_time: 'max',
    kill_in_run: 'max',
    gold_in_run: 'max',
    clear_no_damage: 'add',
    clear_fast: 'add',
    clear_low_hp: 'add',
    run_no_relic_clear: 'add',
    clear_one_skill: 'add',
    damage_dealt: 'add',
    crit_hits: 'add',
    draw_count: 'add',
    relic_collected: 'max',
    buff_types: 'max',
    skills_picked: 'max',
};

/** 分类条的一项 */
export interface AchCategoryEntry {
    code: AchCategory;
    /** 中文名（如「闯关」） */
    name: string;
}

export class AchievementConfig {
    /** 取容器（未加载时返回 null，不抛异常） */
    private static _container(): AchievementCfgContainer | null {
        try {
            const c = TbRoot.ins.getTbContainer(AchievementCfgContainer);
            return c && c.size > 0 ? c : null;
        } catch {
            return null;
        }
    }

    /** 配置表是否就绪（诊断用） */
    static isReady(): boolean {
        return !!AchievementConfig._container();
    }

    /** 全部成就（已按 分类 → sort → group 排序） */
    static getAll(): AchGroupCfg[] {
        return AchievementConfig._container()?.getGroups() ?? [];
    }

    /** 一条成就（按 group） */
    static getGroup(group: string): AchGroupCfg | undefined {
        return AchievementConfig._container()?.getGroup(group);
    }

    /** 某个分类的成就（已排序） */
    static getByCategory(category: AchCategory): AchGroupCfg[] {
        return AchievementConfig._container()?.getByCategory(category) ?? [];
    }

    /**
     * 分类条（**只返回有内容的分类**）：
     * 某个分类一条成就都没有时不出现 —— 免得出现点进去是空页的页签。
     * 表未就绪时返回空数组（界面显示空态）。
     */
    static getCategories(): AchCategoryEntry[] {
        const c = AchievementConfig._container();
        if (!c) return [];
        const out: AchCategoryEntry[] = [];
        for (const code of ACH_CATEGORY_ORDER) {
            if (c.getByCategory(code).length === 0) continue;
            out.push({ code: code as AchCategory, name: ACH_CATEGORY_NAME[code] ?? code });
        }
        return out;
    }

    /** 某条成就的某一档配表行 */
    static getTierCfg(group: string, tier: number): AchCfg | undefined {
        return AchievementConfig._container()?.getTierCfg(group, tier);
    }

    /** 某条成就的最高档（缺省 0 = 表未就绪/无此成就） */
    static getMaxTier(group: string): number {
        return AchievementConfig._container()?.getMaxTier(group) ?? 0;
    }

    /** 完成条件的进度模式（未知 target 按 add 处理） */
    static getTargetMode(target: AchTarget): 'add' | 'max' | 'flag' {
        return ACH_TARGET_MODE[target] ?? 'add';
    }

    /** 档位的目标数量（防御性：配 0 或负数时按 1 处理，避免「一进游戏就完成」） */
    static getCount(cfg: AchCfg): number {
        return Math.max(1, cfg.count ?? 1);
    }

    /** 档位的进度文案（如 `12/50`；进度按目标数量钳制） */
    static getProgressText(cfg: AchCfg, progress: number): string {
        const count = AchievementConfig.getCount(cfg);
        return `${Math.min(Math.max(0, progress), count)}/${count}`;
    }

    /**
     * 金币数字的**缩写**口径（界面 `unlock/value` 用，与预制件里摆的 `2k` 同风格）：
     *   < 1000      → 原数（`850`）
     *   ≥ 1000      → `1.2k`（一位小数，整数不带 `.0`）
     *   ≥ 10000     → `1.2万`
     *
     * ⚠ 实现已抽到 `common/GoldText.ts`（英雄页的价格也用同一份），本方法只是转发。
     */
    static formatGold(n: number): string {
        return formatGold(n);
    }
}
