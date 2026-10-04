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
    /**
     * 受伤减免倍率（**全能减免**：物理与法术都减）
     * 2026-10：原「12 物理受伤 / 13 魔法受伤」两条合并成这一条，13（IncomingMagical）**退役**。
     * 消费点 `DamagePipeline.collectIncomingMultiplier` 现在一律取本属性，不再按伤害类型分支。
     */
    IncomingDamage = 12,
    // 13 空号（原 IncomingMagical，已并入 12 —— 不要再分配出去）
    CritRate = 14,          // 暴击率
    CritDmg = 15,           // 暴击倍率
    AtkRange = 16,          // 攻击距离

    /* ---------- 21~27：局内遗物新增（2026-10 遗物重做） ---------- */
    GoldGain = 21,          // 金币获取（%，无上限轴）
    ExpGain = 22,           // 经验获取（%，无上限轴）
    CooldownReduce = 23,    // 冷却缩减（%，上限 50）
    DrawDiscount = 24,      // 遗物抽取费用折扣（%，上限 80）
    Lifesteal = 25,         // 吸血（%，只对普攻伤害生效，无上限轴）
    HitHeal = 26,           // 攻击回复（每次普攻命中回复的固定生命，无上限轴）
    HitMana = 27,           // 攻击回蓝（每次普攻命中回复的固定魔法，无上限轴）
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
    [AttributeType.IncomingDamage]: '受伤减免',
    [AttributeType.CritRate]: '暴击率',
    [AttributeType.CritDmg]: '暴击倍率',
    [AttributeType.AtkRange]: '攻击距离',
    [AttributeType.GoldGain]: '金币获取',
    [AttributeType.ExpGain]: '经验获取',
    [AttributeType.CooldownReduce]: '冷却缩减',
    [AttributeType.DrawDiscount]: '抽卡折扣',
    [AttributeType.Lifesteal]: '吸血',
    [AttributeType.HitHeal]: '攻击回复',
    [AttributeType.HitMana]: '攻击回蓝',
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

/** 装备品质（沿用旧装备数字口径：1 / 1.3 / 1.6 / 2；由遗物 rarity 换算而来，`percent` 加成需 ≥1.6） */
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

/** 局外装备配置（业务层类型；数据源 = `relics.json` 里**有局外版**的遗物，即 `modifiers_outer` / `description_outer`） */
export interface EquipmentConfig {
    id: number;
    name: string;
    description: string;
    category: EquipmentCategory | string;
    quality: WeaponQuality;
    /** 属性加成（二维数组：[[属性编号, 值], ...]） */
    attributes: AttributeArray;
    /** 属性分层映射（数组：[[属性编号, 'flat'|'percent'], ...]） */
    bonusTypes?: [number, BonusLayerType][];
    allPercent?: number;
}
