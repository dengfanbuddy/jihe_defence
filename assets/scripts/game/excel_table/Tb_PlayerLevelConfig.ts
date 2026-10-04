import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 账号等级表（player_levels.json）
 *
 * **等级经验的唯一来源**（取代 battle_constants 的 playerExpFormulaBase / playerExpFormulaRatio 公式）：
 *   `id`   = 等级（1 起，与 `PlayerInfo.level` 对应）
 *   `exp`  = 从本级升到下一级所需经验（**0 = 满级**，满级后经验不再累积）
 *   `reward_gold` = 升到本级时的一次性金币奖励
 *   `unlock_features` = 该等级解锁的功能标识（`LevelConfig.hasFeature(level, code)` 判定）
 *
 * 与等级挂钩的新玩法一律**加列**（例：每日任务数上限、商店折扣），不要另起一张表。
 *
 * 查询：TbRoot.ins.getTbContainer(PlayerLevelCfgContainer).getCfgById(5)
 */
export interface PlayerLevelCfg {
    /** 等级（1 起，主键） */
    id: number;
    /** 从本级升到下一级所需经验（0 = 满级） */
    exp: number;
    /** 升到本级时发放的一次性金币奖励 */
    reward_gold?: number;
    /** 该等级解锁的功能标识 */
    unlock_features?: string[];
    /** 等级展示文案（如「解锁：每周任务」） */
    desc?: string;
}

@tb_config(':tb/player_levels')
export class PlayerLevelCfgContainer extends TbContainer<PlayerLevelCfg> {
    getTbName(): string { return 'PlayerLevelCfg'; }

    /**
     * 满级 = 表里等级最高的那一行（`maxId`）。
     *
     * ⚠ 不是「最后一个 exp > 0 的行」：满级那行的 `exp` **就是 0**（本级不再升级），
     * 按 exp>0 找会把满级的前一级当满级（踩过：30 行的表被算成 29 级满级，永远升不到 30）。
     */
    getMaxLevel(): number {
        if (!this.cfgs.length) return 0;
        return this.maxId;
    }

    /** 从 level 升到下一级所需经验（满级/无该行 → 0） */
    getExpToNext(level: number): number {
        return Math.max(0, this.getCfgById(level)?.exp ?? 0);
    }

    /** 升到 level 时的金币奖励（缺省 0） */
    getGoldReward(level: number): number {
        return Math.max(0, this.getCfgById(level)?.reward_gold ?? 0);
    }

    /** level 这一级解锁的功能标识列表（缺省空数组） */
    getUnlockFeatures(level: number): string[] {
        return this.getCfgById(level)?.unlock_features ?? [];
    }
}
