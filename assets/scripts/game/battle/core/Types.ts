/**
 * battle/core/Types —— 局外属性 / 装备 / 战斗常量的类型定义（兼容层）
 *
 * 说明：
 *   - 新战斗核心类型在 `battle/types.ts`（DamageType/StateType 等）
 *   - 本文件保留旧代码（OuterAttributeCalculator / EquipmentConfig / data/index）
 *     引用的局外属性类型，接口不变
 */

/**
 * 属性类型（统一 number 枚举）
 *
 * 全项目共用一套编号：
 *   - 局内战斗属性（attributes.json 的 id 直接使用这些编号）
 *   - 配置表属性统一用二维数组形式：[[1, 100], [3, 20]] 表示 maxHp+100, atk+20
 */
export enum AttributeType {
    MaxHp = 1,              // 最大生命
    MaxMana = 2,            // 最大魔法
    Atk = 3,                // 攻击力（局内 attack_damage）
    AtkSpeed = 4,           // 攻击速度（倍率）
    MoveSpeed = 5,          // 移动速度
    Def = 6,                // 护甲（局内 armor）
    MagicResist = 7,        // 魔法抗性（补数乘法）
    Evasion = 8,            // 闪避（补数乘法）
    HpRegen = 9,            // 生命恢复/秒
    ManaRegen = 10,         // 魔法恢复/秒
    DamageOut = 11,         // 伤害输出倍率
    IncomingPhysical = 12,  // 物理受伤倍率
    IncomingMagical = 13,   // 魔法受伤倍率
    CritRate = 14,          // 暴击率
    CritDmg = 15,           // 暴击倍率
    AtkRange = 16,          // 攻击距离

}

/** 属性编号 → 属性名（调试/日志用） */
export const AttributeTypeName: Record<AttributeType, string> = {
    [AttributeType.MaxHp]: '最大生命',
    [AttributeType.MaxMana]: '最大魔法',
    [AttributeType.Atk]: '攻击力',
    [AttributeType.AtkSpeed]: '攻击速度',
    [AttributeType.MoveSpeed]: '移动速度',
    [AttributeType.Def]: '护甲',
    [AttributeType.MagicResist]: '魔法抗性',
    [AttributeType.Evasion]: '闪避',
    [AttributeType.HpRegen]: '生命恢复',
    [AttributeType.ManaRegen]: '魔法恢复',
    [AttributeType.DamageOut]: '伤害输出',
    [AttributeType.IncomingPhysical]: '物理受伤',
    [AttributeType.IncomingMagical]: '魔法受伤',
    [AttributeType.CritRate]: '暴击率',
    [AttributeType.CritDmg]: '暴击倍率',
    [AttributeType.AtkRange]: '攻击距离',
};

/** 属性配置的二维数组形式：[[attrId, value], ...] */
export type AttributeArray = [number, number][];

/** 装备类别 */
export enum EquipmentCategory {
    Weapon = 'weapon',
    Armor = 'armor',
    Accessory = 'accessory',
    HeroSpecific = 'hero_specific',
    Consumable = 'consumable',
}

/** 武器品质（数字，>=2.5 视为百分比加成层） */
export type WeaponQuality = number;

/** 加成层类型（v2 简化：flat 固定值 / percent 百分比） */
export type BonusLayerType = 'flat' | 'percent';

/** 局外加成组（2 层结构，key 为属性编号） */
export interface OuterBonusGroup {
    flat: Partial<Record<AttributeType, number>>;
    percent: Partial<Record<AttributeType, number>>;
}

/** 某个功能（装备/天赋/成就）的加成贡献 */
export interface FeatureBonus {
    featureName: string;
    bonuses: OuterBonusGroup;
}

/** 装备配置（业务层类型，来自 equipments.json） */
export interface EquipmentConfig {
    id: number;
    name: string;
    description: string;
    category: EquipmentCategory | string;
    quality: WeaponQuality;
    heroId?: string;
    /** 属性加成（二维数组：[[属性编号, 值], ...]） */
    attributes: AttributeArray;
    /** 属性分层映射（数组：[[属性编号, 'flat'|'percent'], ...]） */
    bonusTypes?: [number, BonusLayerType][];
    allPercent?: number;
}
