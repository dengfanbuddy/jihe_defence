import type { AttributeArray } from '../battle/core/Types';
import { AttributeType } from '../battle/core/Types';

/**
 * ConfigLoader —— 配置工具函数集
 *
 * 说明：
 *   - 战斗配置（attributes/modifiers/abilities/relics/units）已改为 TbRoot 管线加载
 *     （见 excel_table/Tb_*Config.ts），不再需要本类的 Load 方法/ApplyToContext。
 *   - 本类保留配置数据归一化工具（二维数组/对象互转、旧字符串键映射），
 *     供局外装备等仍使用字符串键的配置转换。
 */
export class ConfigLoader {
    /**
     * 归一化属性配置为二维数组 [[attrId, value], ...]
     * 兼容两种写法：
     *   - 数组形式：[[1, 100], [3, 20]]（推荐）
     *   - 对象形式：{ "maxHp": 100, "atk": 20 }（旧配置兼容，自动映射）
     */
    static NormalizeAttributeArray(input: AttributeArray | Record<string, number> | undefined | null): AttributeArray {
        if (!input) return [];
        if (Array.isArray(input)) return input as AttributeArray;
        // 对象形式：key 可能是属性编号字符串或属性名，统一转编号
        const arr: AttributeArray = [];
        for (const [k, v] of Object.entries(input)) {
            const id = Number(k);
            arr.push([Number.isNaN(id) ? ConfigLoader.nameToAttrId(k) : id, v]);
        }
        return arr;
    }

    /** 属性名 → 编号（兼容旧配置 { "atk": 100 } 形式） */
    static nameToAttrId(name: string): AttributeType {
        const map: Record<string, AttributeType> = {
            maxHp: 1, max_hp: 1, MaxHp: 1,
            maxMana: 2, max_mana: 2, MaxMana: 2,
            atk: 3, attack_damage: 3, AttackDamage: 3,
            atkSpeed: 4, attack_speed: 4, AttackSpeed: 4,
            moveSpeed: 5, move_speed: 5, MoveSpeed: 5,
            def: 6, armor: 6, Def: 6,
            magicResist: 7, magic_resist: 7, MagicResist: 7,
            evasion: 8, dodge: 8, Evasion: 8,
            hpRegen: 9, hp_regen: 9, HpRegen: 9,
            manaRegen: 10, mana_regen: 10, ManaRegen: 10,
            damageOut: 11, damage_out: 11, DamageOut: 11,
            incomingPhysical: 12, incoming_physical: 12,
            incomingMagical: 13, incoming_magical: 13,
            critRate: 14, crit_chance: 14, CritRate: 14,
            critDmg: 15, crit_multiplier: 15, CritDmg: 15,
            atkRange: 16, attack_range: 16, AtkRange: 16,
            lightningDmg: 17, LightningDmg: 17,
            poisonDmg: 18, PoisonDmg: 18,
            burnDmg: 19, BurnDmg: 19,
            freezeDuration: 20, FreezeDuration: 20,
        };
        return (map[name] ?? AttributeType.Atk) as AttributeType;
    }
}
