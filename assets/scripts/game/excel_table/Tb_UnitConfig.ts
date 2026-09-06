import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import type { AttributeArray } from '../battle/core/Types';

/**
 * 战斗单位配置表（units.json）
 * 参照 Tb_HeroConfig 的容器风格，由 TbRoot 统一加载。
 * 查询：TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(1)
 */
export interface UnitCfg {
    id: number;
    name: string;
    team: number;
    /**
     * 初始基础属性（唯一数据源）：二维数组 [[属性编号, 配置值], ...]
     * 配置值统一 int：倍率/百分比型属性（攻速/魔抗/倍率等）以 100=100% 表示，
     * 由 AttributeSystem 内部经 AttributeScaling 换算为 float。
     */
    base_attributes: AttributeArray;
    abilities: number[];          // AbilityCfg.id 列表（number）
    scale?: number;               // 等级成长系数（可选）
    /** 普攻基础间隔（秒，默认 1.7）；实际冷却 = base / attack_speed */
    attack_interval?: number;
    /** 普攻投射物标识（远程攻击表现，如 'shuriken'） */
    attack_projectile?: string;
    /** 普攻弹道速度（像素/秒，默认 1200） */
    attack_projectile_speed?: number;
    /** 初始金币（可选，供偷钱等经济玩法） */
    gold?: number;
    /**
     * 击杀奖励——金币基数（可选）。缺省取战斗常量 enemyDropGoldDefault。
     * 实际发放 = 本值 × 阶段难度系数 × 时间通胀系数（见 Scene_Game_Stage.grantKillReward）
     */
    goldReward?: number;
    /** 击杀奖励——经验基数（可选）。缺省取战斗常量 enemyDropExpDefault。 */
    expReward?: number;
    /**
     * 奖励类型：normal/elite/boss/gold_boss/exp_boss。
     * gold_boss/exp_boss 为专门的经济 BUFF boss，击杀一次性大量奖励（见数值设计文档）。
     */
    rewardType?: string;
    /** AI 脚本配置（怪物/Boss 行为；缺省 = 不挂 AI，由外部控制） */
    ai?: { type: string; params?: Record<string, any> };
    /** 碰撞半径（像素）——用于实体分离/防重叠；缺省取战斗常量 collisionRadiusDefault（默认 26） */
    collision_radius?: number;
    /** 单位预制件路径（表现层实例化用，如 'prefabs/units/monster_goblin'） */
    prefab?: string;
    /** 普攻弹道预制件路径（如 'prefabs/projectiles/shuriken'） */
    attack_projectile_prefab?: string;
    /**
     * 每级成长属性：二维数组 [[属性序号, 每级成长值], ...]（float 语义，如暴击 0.005 = 0.5%/级）。
     * 英雄单位（team=1）必备；怪物单位无此字段（不做等级成长）。
     */
    growthValues?: number[][];
}

@tb_config(':tb/units')
export class UnitCfgContainer extends TbContainer<UnitCfg> {
  getTbName(): string { return 'UnitCfg'; }
}
