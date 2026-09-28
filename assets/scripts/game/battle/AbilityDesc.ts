import { AttributeTypeName, type AttributeType } from './core/Types';
import { AttributeScaling } from './core/AttributeScaling';
import { abilityLevelDesc, abilityMaxLevel } from '../excel_table/Tb_AbilityConfig';
import type { AbilityBehavior, AbilityCfg, ConfigAction } from '../excel_table/Tb_AbilityConfig';

/**
 * AbilityDesc —— **技能详情文案**（纯函数，无 cc 依赖）
 *
 * 为什么需要它：`abilities.json` 里只有肉鸽额外技能（scope=shop）带设计稿写的 `lv1/lv2/lv3` 文案，
 * 单位技能（火球术 / 霜冻新星 / 鹰眼瞄准…）**没有描述列** —— 长按技能槽要弹详情面板，
 * 不能给玩家看一片空白。于是这里按 `behavior` + `cooldown` + `mana_cost` + `effects` **反推一句话**。
 *
 * 优先级（`describeAbility`）：
 *   ① 配表里写了该级文案（`lv1/lv2/lv3`，逐级回落）→ 直接用（策划写的比机器拼的好）
 *   ② 没写 → 按动作数组拼（见 `describeEffects`）
 * 无论走哪条，`describeAbility` 都会另外给出**结构化的一行**（类型 / 冷却 / 耗蓝 / 射程），
 * 详情面板可以把「效果描述」与「基础信息」分两段显示。
 *
 * ⚠ 文案口径：`percent` 叠加方式的配置值是**百分数**（`14` = +14%）；
 *   `add` 打在**缩放型属性**上时配置值是 ×100 的 int（攻速 `50` = +50%），
 *   两者在这里都显示成 `+N%`，非缩放型属性的 `add` 才是固定值（攻击力 `+14`）。
 */

/** 伤害类型的中文名 */
const DAMAGE_TYPE_NAME: Record<string, string> = {
    physical: '物理',
    magical: '魔法',
    pure: '纯粹',
};

/** 行为类型的中文名（详情面板的「技能类型」一行） */
const BEHAVIOR_NAME: Record<AbilityBehavior, string> = {
    passive: '被动',
    attack: '普攻',
    no_target: '无目标',
    unit_target: '指向单位',
    point: '指向地面',
    aoe: '范围',
    toggle: '开关',
};

/** 保留 1 位小数，且去掉无意义的 `.0` */
function num(v: number): string {
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

/** 百分比数值（0.25 → 25%） */
function pct(ratio: number): string {
    return `${num(Math.round(ratio * 1000) / 10)}%`;
}

/** 属性条目 → 「攻击力 +14%」/「护甲 +1.5」 */
function describeAttrEntry(entry: unknown): string {
    if (Array.isArray(entry)) {
        const [attrId, value, mode] = entry as [number, number, string?];
        return describeAttr(attrId, value, mode);
    }
    const rec = (entry ?? {}) as Record<string, any>;
    return describeAttr(rec.attr, rec.value, rec.mode);
}

function describeAttr(attrId: number, value: number, mode?: string): string {
    const name = AttributeTypeName[attrId as AttributeType] ?? `属性${attrId}`;
    if (!Number.isFinite(value)) return name;
    const sign = value >= 0 ? '+' : '';
    // percent：配置值本身就是要显示的百分数
    if (mode === 'percent') return `${name} ${sign}${num(value)}%`;
    // multiply：小数复利
    if (mode === 'multiply') return `${name} ×${num(1 + value)}`;
    // add（缺省）：缩放型属性的配置值是 ×100 的 int，显示成百分数更直观
    if (AttributeScaling.isScaled(attrId)) return `${name} ${sign}${num(value)}%`;
    return `${name} ${sign}${num(value)}`;
}

/** 一个动作 → 一句中文（认不出的动作返回 null，由调用方兜底） */
function describeAction(action: ConfigAction): string | null {
    const a = action as Record<string, any>;
    switch (a.type) {
        case 'damage':
            return `对目标造成 ${num(a.value)} 点${DAMAGE_TYPE_NAME[a.damage_type] ?? ''}伤害`;
        case 'aoe_damage':
            return `对半径 ${num(a.radius)} 内的敌人造成 ${num(a.value)} 点${DAMAGE_TYPE_NAME[a.damage_type] ?? ''}伤害`;
        case 'heal':
            return `回复 ${num(a.value)} 点生命`;
        case 'apply_modifier':
            return a.duration
                ? `施加效果（持续 ${num(a.duration)} 秒）`
                : '施加一个永久效果';
        case 'remove_modifier':
            return '移除一个效果';
        case 'modify_attr': {
            const list = (Array.isArray(a.attrs) ? a.attrs : []).map(describeAttrEntry);
            return list.length ? list.join('，') : null;
        }
        case 'lifesteal':
            return `按造成伤害的 ${pct(a.ratio ?? 0)} 回复生命`;
        case 'reflect':
            return `反弹 ${pct(a.ratio ?? 0)} 受到的伤害`;
        case 'steal_gold':
            return `偷取 ${num(a.value)} 金币`;
        case 'projectile': {
            const count = a.target_count ?? 1;
            const hit = Array.isArray(a.hit_effects) ? describeEffects(a.hit_effects) : [];
            const head = a.value
                ? `向 ${count} 个目标发射弹道，各造成 ${num(a.value)} 点${DAMAGE_TYPE_NAME[a.damage_type] ?? ''}伤害`
                : `向 ${count} 个目标发射弹道`;
            return [head, ...hit].join('；');
        }
        case 'execute_script':
            return '特殊机制（由代码实现）';
        default:
            return null;
    }
}

/** 动作数组 → 文案行数组（每个动作一行；认不出的动作合成一行「特殊效果」） */
export function describeEffects(effects: ConfigAction[] | undefined): string[] {
    if (!Array.isArray(effects) || !effects.length) return [];
    const out: string[] = [];
    let unknown = 0;
    for (const action of effects) {
        const text = describeAction(action);
        if (text) out.push(text);
        else unknown++;
    }
    if (unknown > 0) out.push(`${unknown} 个特殊效果`);
    return out;
}

/** 详情面板的「基础信息」一行：类型 · 冷却 · 耗蓝 · 射程 */
export function describeBasics(cfg: AbilityCfg, level = 1): string {
    const parts: string[] = [BEHAVIOR_NAME[cfg.behavior] ?? cfg.behavior];
    if (cfg.cooldown > 0) parts.push(`冷却 ${num(cfg.cooldown)} 秒`);
    else if (cfg.behavior !== 'passive') parts.push('无冷却');
    if (cfg.mana_cost > 0) parts.push(`耗蓝 ${num(cfg.mana_cost)}`);
    if (cfg.cast_range && cfg.cast_range > 0) parts.push(`射程 ${num(cfg.cast_range)}`);
    const maxLevel = abilityMaxLevel(cfg);
    if (maxLevel > 1) parts.push(`等级 ${Math.max(1, Math.min(maxLevel, level))}/${maxLevel}`);
    return parts.join(' · ');
}

/**
 * 技能的效果描述（详情面板正文）。
 *
 * @param cfg 技能配置
 * @param level 展示用的等级（1 起；肉鸽技能升级后传当前等级）
 */
export function describeEffectsAtLevel(cfg: AbilityCfg, level = 1): string {
    const authored = abilityLevelDesc(cfg, level);
    if (authored) return authored;
    const lines = describeEffects(cfg.effects);
    if (lines.length) return lines.join('\n');
    // 既没文案也没动作 —— 说清楚而不是留空（肉鸽技能的设计稿阶段就是这个状态）
    return cfg.scope === 'shop' ? '效果待实现（设计稿只给了文字）' : '无附加效果';
}

/**
 * 详情面板完整文案：**效果描述 + 基础信息**两段（用换行分隔）。
 * 面板可以直接把它塞进一个 Label（开了 wrap 与自动高度）。
 */
export function describeAbility(cfg: AbilityCfg, level = 1): string {
    const effect = describeEffectsAtLevel(cfg, level);
    const basics = describeBasics(cfg, level);
    return `${effect}\n${basics}`;
}
