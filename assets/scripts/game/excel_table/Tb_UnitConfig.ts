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
    head_icon:string;
    team: number;
    /**
     * 单位大类：'hero'（英雄，team=1）/ 'monster'（怪物，team=2）。
     * 与 team 并存：team 供战斗逻辑（敌我阵营）使用，category 供分类/池子/统计使用。
     */
    category?: 'hero' | 'monster';
    /** 怪物子类型（category='monster' 时）：normal 普通 / elite 精英 / boss 关底·Boss·经济 Boss */
    subtype?: 'normal' | 'elite' | 'boss';
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
    /**
     * 普攻索敌策略（nearest/farthest/lowest_hp/strongest/random，缺省 nearest）。
     * 英雄普攻不算技能：索敌仅由本字段决定，Scene_Game_Stage.heroAI 按它选普攻目标。
     *
     * ⚠️ 本字段**只在"重新索敌"时生效**：普攻是粘性锁定（resolveAttackTarget），
     * 一旦锁定就一直打同一个目标，直到它死亡/被回收/离开射程（且射程内有别的敌人）；
     * 两个例外：① 嘲讽（Entity.forcedTarget）会立刻改打嘲讽者；
     * ② 玩家点选的目标（Scene_Game_Stage.manualTarget）在射程内时优先于本字段挑出来的那个。
     *
     * 语义：先在**攻击范围内**过滤候选，再按策略挑选 ——
     * 即 farthest = 攻击范围内最远的敌人（不是全图最远，射程外一律不索敌）。
     * 例：火枪(超远程点杀) 配 "farthest" = 锁定射程内最靠外的那只，然后打到它死。
     */
    attack_targeting?: string;
    /**
     * 普攻投射物标识（远程攻击表现，如 'shuriken'）。
     * 配置后 Entity.Attack 走"发射弹道 → 命中时结算"两阶段；缺省 = 近战即时命中。
     */
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
     * 奖励类型：normal/elite/boss/gold_boss/exp_boss/kill_boss。
     * gold_boss/exp_boss 为专门的经济 BUFF boss，击杀一次性大量奖励（见数值设计文档）。
     * kill_boss 为「击杀 Boss」——表现层与 gold_boss 同色同体型（E74C3C ×1.5），
     * 受击色不同（FFA500）；配色/缩放口径见 game/common/EntityVisualConfig.ts。
     */
    rewardType?: string;
    /** AI 脚本配置（怪物/Boss 行为；缺省 = 不挂 AI，由外部控制） */
    ai?: { type: string; params?: Record<string, any> };
    /** 碰撞半径（像素）——用于实体分离/防重叠；缺省取战斗常量 collisionRadiusDefault（默认 26） */
    collision_radius?: number;
    /** 单位预制件路径（表现层实例化用，如 'prefabs/units/monster_goblin'） */
    prefab?: string;
    /**
     * 普攻弹道预制件路径（如 'prefabs/unit/projectiles/projectile_1'）。
     * 仅在配置了 attack_projectile 时生效；未配置则回退到
     * Scene_Game_Stage.DEFAULT_PROJECTILE_PREFAB（美术资源未就位时的统一占位）。
     */
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
