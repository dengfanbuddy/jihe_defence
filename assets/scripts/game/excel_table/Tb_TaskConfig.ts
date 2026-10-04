import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 任务配置表（tasks.json）
 *
 * 一行 = 一个任务。任务通过 `target`（完成条件）+ `count`（目标数量）描述，
 * 进度由 `game/data/funcs/TaskData.ts` 在上报事件里累加；完成后**手动领奖**，
 * 奖励只有两种：`reward_exp`（账号经验 → PlayerInfo）+ `reward_gold`（金币 → ItemData）。
 *
 * 重置周期由 `type` 决定（daily = 每日 0 点 / weekly = 每周一），
 * 是否展示由 `unlock_level`（账号等级）与页签筛选共同决定。
 *
 * 查询：TbRoot.ins.getTbContainer(TaskCfgContainer).getByType('daily')
 */

/** 任务类型：决定重置周期与所在页签 */
export type TaskType = 'daily' | 'weekly';

/**
 * 完成条件标识。
 * 每个标识对应一种「外部事件 → 进度」的换算方式，换算规则在 `TaskData.TargetMode` 里（唯一真源）：
 *   login          登录（每日首次打开任务界面 = 1，flag）
 *   play_games     完成对局数（add；对局结束才 +1，中途退出不算）
 *   victory        通关次数（add；击杀最终 Boss）
 *   kill_enemies   击杀敌人数（add）
 *   gold_earned    局内累计获得金币（add）
 *   spend_gold     局内累计消耗金币（add）
 *   relics_picked  局内累计获得遗物数（add）
 *   skills_used    累计使用技能次数（add；⚠ 走 BattleEvents.OnAbilityCast，
 *                  当前英雄技能与肉鸽技能**全是被动**，拿不到进度 —— 等有主动技能的任务再用它）
 *   buffs_bought   累计购买击杀商店 Buff 次数（add）
 *   stage_reached  单局到达的最高阶段（max，取峰值）
 *   hero_level     单局英雄最高等级（max，取峰值）
 *   level_reached  账号等级（max；等级变化时上报）
 */
export type TaskTarget =
    | 'login'
    | 'play_games'
    | 'victory'
    | 'kill_enemies'
    | 'gold_earned'
    | 'spend_gold'
    | 'relics_picked'
    | 'skills_used'
    | 'buffs_bought'
    | 'stage_reached'
    | 'hero_level'
    | 'level_reached';

export interface TaskCfg {
    /** 任务 ID（日任务 1001 段 / 周任务 2001 段） */
    id: number;
    /** 任务类型（重置周期 + 页签） */
    type: TaskType;
    /** 任务名（列表项标题） */
    name: string;
    /** 任务描述（列表项副标题） */
    desc?: string;
    /** 完成条件 */
    target: TaskTarget;
    /** 条件参数（预留：如指定英雄/关卡 id，留空 = 不限） */
    param?: string;
    /** 目标数量 */
    count: number;
    /** 奖励·账号经验 */
    reward_exp: number;
    /** 奖励·金币 */
    reward_gold: number;
    /** 解锁所需账号等级（缺省 1 = 不限制） */
    unlock_level?: number;
    /** 同页签内排序（升序） */
    sort?: number;
}

@tb_config(':tb/tasks')
export class TaskCfgContainer extends TbContainer<TaskCfg> {
    getTbName(): string { return 'TaskCfg'; }

    /** 某一页签的全部任务（已按 sort 升序；sort 缺省按 id） */
    getByType(type: TaskType): TaskCfg[] {
        return this.cfgs
            .filter(c => c.type === type)
            .sort((a, b) => (a.sort ?? a.id) - (b.sort ?? b.id));
    }

    /** 某个完成条件下的全部任务（上报进度时按它反查要更新哪些任务） */
    getByTarget(target: TaskTarget): TaskCfg[] {
        return this.cfgs.filter(c => c.target === target);
    }

    /** 任务解锁所需等级（缺省 1） */
    getUnlockLevel(cfg: TaskCfg): number {
        return Math.max(1, cfg.unlock_level ?? 1);
    }
}
