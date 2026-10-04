/**
 * TaskConfig.ts — 任务配置门面
 *
 * 数据源：`assets/resources/tb/tasks.json`（编辑源 `tools/excel_export/excel/tasks.xlsx`）
 * 容器：`excel_table/Tb_TaskConfig.ts`
 *
 * 这层只做「读配置」，不含任何进度与领奖逻辑（那些在 `data/funcs/TaskData.ts`）：
 *   TaskConfig.getTasks('daily')       // 日任务（已按 sort 排序）
 *   TaskConfig.getTask(1002)           // 按 id 取
 *   TaskConfig.getUnlockLevel(cfg)     // 解锁等级（缺省 1）
 *
 * 容错：配表未加载完成时返回空结果（与 ShopConfig / BattleConstUtil 一致），
 * 调用方（TaskData）拿到空列表只会「没有任务」，不会崩。
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
import { TaskCfgContainer } from '../../excel_table/Tb_TaskConfig';
import type { TaskCfg, TaskTarget, TaskType } from '../../excel_table/Tb_TaskConfig';

export type { TaskCfg, TaskTarget, TaskType };

export class TaskConfig {
    /** 取容器（未加载时返回 null，不抛异常） */
    private static _container(): TaskCfgContainer | null {
        try {
            return TbRoot.ins.getTbContainer(TaskCfgContainer);
        } catch {
            return null;
        }
    }

    /** 配置表是否就绪（诊断用） */
    static isReady(): boolean {
        return !!TaskConfig._container()?.size;
    }

    /** 某一页签的任务（daily / weekly，已按 sort 升序） */
    static getTasks(type: TaskType): TaskCfg[] {
        return TaskConfig._container()?.getByType(type) ?? [];
    }

    /** 全部任务 */
    static getAll(): TaskCfg[] {
        return TaskConfig._container()?.cfgs ?? [];
    }

    /** 按 id 取任务 */
    static getTask(id: number): TaskCfg | undefined {
        return TaskConfig._container()?.getCfgById(id);
    }

    /** 某个完成条件下的所有任务（进度上报时反查用） */
    static getByTarget(target: TaskTarget): TaskCfg[] {
        return TaskConfig._container()?.getByTarget(target) ?? [];
    }

    /** 任务的解锁等级（缺省 1 = 不限制） */
    static getUnlockLevel(cfg: TaskCfg): number {
        return Math.max(1, cfg.unlock_level ?? 1);
    }

    /** 任务的目标数量（防御性：配 0 或负数时按 1 处理，避免"一进游戏就完成"） */
    static getCount(cfg: TaskCfg): number {
        return Math.max(1, cfg.count ?? 1);
    }

    /** 任务的进度文案（如 `78/100`；进度按目标数量钳制） */
    static getProgressText(cfg: TaskCfg, progress: number): string {
        const count = TaskConfig.getCount(cfg);
        return `${Math.min(Math.max(0, progress), count)}/${count}`;
    }
}
