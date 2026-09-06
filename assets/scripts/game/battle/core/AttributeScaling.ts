import { AttributeType } from './Types';

/**
 * ============================================================
 * AttributeScaling —— 属性数值缩放映射（配置 int 化统一）
 * ============================================================
 *
 * 背景：配置表（units/modifiers/attributes）要求数值统一为 int，
 * 但部分属性在语义上是"倍率 / 百分比"（如魔抗 0.25 = 25%，
 * 攻速 1.2 = 120%，受伤倍率 1.0 = 100%）。
 *
 * 约定：这些属性在配置表里用 int 表示（100 = 100%，25 = 25%），
 * 代码内部运行时仍用 float（0.25 / 1.2）。AttributeSystem
 * 在写入基础值/合并贡献时通过本映射统一换算。
 *
 * 用法：
 *   const scale = AttributeScaling.scale(AttributeType.MagicResist); // 100
 *   const v = AttributeScaling.normalize(AttributeType.MagicResist, 25); // 0.25
 *   const raw = AttributeScaling.denormalize(AttributeType.MagicResist, 0.25); // 25
 */
export class AttributeScaling {
    /** 倍率/百分比型属性的缩放系数：配置值 = 实际值 × scale */
    private static readonly SCALE: Partial<Record<AttributeType, number>> = {
        [AttributeType.AtkSpeed]: 100,        // 1.2 → 120
        [AttributeType.MagicResist]: 100,     // 0.25 → 25
        [AttributeType.Evasion]: 100,         // 0.2 → 20
        [AttributeType.DamageOut]: 100,       // 1.5 → 150
        [AttributeType.IncomingPhysical]: 100,// 1.0 → 100
        [AttributeType.IncomingMagical]: 100, // 1.0 → 100
        [AttributeType.CritRate]: 100,        // 0.3 → 30
        [AttributeType.CritDmg]: 100,         // 1.5 → 150
    };

    /** 某属性是否有缩放（是倍率/百分比型） */
    static isScaled(id: number): boolean {
        return AttributeScaling.SCALE[id as AttributeType] !== undefined;
    }

    /** 某属性的缩放系数（无缩放返回 1） */
    static scale(id: number): number {
        return AttributeScaling.SCALE[id as AttributeType] ?? 1;
    }

    /** 配置 int → 运行时 float（25 → 0.25） */
    static normalize(id: number, configValue: number): number {
        const s = AttributeScaling.scale(id);
        return s !== 1 ? configValue / s : configValue;
    }

    /** 运行时 float → 配置 int（0.25 → 25），用于导出/调试 */
    static denormalize(id: number, runtimeValue: number): number {
        const s = AttributeScaling.scale(id);
        return s !== 1 ? Math.round(runtimeValue * s) : runtimeValue;
    }
}
