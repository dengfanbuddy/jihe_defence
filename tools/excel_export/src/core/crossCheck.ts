/**
 * 跨表关联校验：导表后检查 id 引用是否都能落地。
 *
 * 覆盖：
 *   - units.abilities / abilities.upgrades_to → abilities 表
 *   - units.base_attributes / growthValues / modifiers.effects 的属性条目 → attributes 表
 *   - effects/events 里的 modifier 引用 → modifiers 表
 *   - effects/events 的 action.type、event 名 → 代码支持的枚举
 *   - modifiers.effects 的声明式效果类型 / 状态名 / 周期间隔 → EffectTypes + StateType
 *   - relics.scope（inner/outer/both）与两侧的 description_* 与 modifiers_* 列的配套关系
 *   - relics.modifiers_inner / modifiers_outer（同一件遗物的局内版 + 局外版）的 Modifier 引用与 kv 参数 → modifiers 表的效果模板
 *   - abilities.scope（unit/shop/both）：含 shop 时必须配齐 rarity/stage/max_level（抽取必需列）
 *   - abilities.effects / effects_lv2 / effects_lv3 的动作类型与 Modifier 引用 → modifiers 表
 *   - kill_buffs.attr_id 的属性编号 → attributes 表
 *
 * 只导部分表时（--table），被引用表若不在本次范围内，会回退读取磁盘上的 JSON；
 * 两者都没有则跳过该组校验并给出说明，避免误报。
 */
import type { TableSchema } from './types.ts';
import type { Report } from '../util/report.ts';

/** EffectExecutor 支持的动作类型（见 battle/EffectExecutor.ts） */
const ACTION_TYPES = new Set([
    'damage', 'aoe_damage', 'projectile', 'heal', 'apply_modifier', 'remove_modifier',
    'lifesteal', 'reflect', 'steal_gold', 'modify_attr', 'execute_script',
]);

/** 声明式效果类型（见 excel_table/EffectTypes.ts 的 ModifierEffect，用于 modifiers.effects） */
const MODIFIER_EFFECT_TYPES = new Set([
    'modify_attr', 'apply_state', 'tick_damage', 'tick_heal', 'tick_apply_modifier',
]);

/** StateType 状态名（见 battle/types.ts） */
const STATE_NAMES = new Set([
    'stunned', 'rooted', 'silenced', 'muted', 'disarmed', 'hexed',
    'invulnerable', 'magic_immune', 'break_passives', 'ethereal', 'untargetable',
]);

/** 属性叠加方式（见 battle/types.ts 的 AttributeStackMode） */
const STACK_MODES = new Set(['add', 'percent', 'multiply', 'complement', 'best']);

/** BattleEvents 事件名（见 battle/types.ts） */
const EVENT_NAMES = new Set([
    'on_attack_start', 'on_attack_landed', 'on_take_damage', 'on_deal_damage', 'on_death',
    'on_ability_cast', 'on_heal', 'on_modifier_added', 'on_modifier_removed', 'on_modifier_refreshed',
    'on_state_changed', 'on_relic_added', 'on_relic_removed', 'on_kill', 'on_battle_start',
    'on_attack_projectile', 'on_projectile_hit', 'on_projectile_miss', 'on_entity_added', 'on_entity_removed',
]);

/** 遗物作用域：inner = 只有局内版 / outer = 只有局外版 / both = 两侧都有 */
const RELIC_SCOPES = new Set(['inner', 'outer', 'both']);
/** 遗物局外分类（hero_specific 已随英雄专属装备删除，2026-07） */
const RELIC_CATEGORIES = new Set(['d2_basic', 'd2_upgrade', 'd2_neutral']);

/** 技能归属：unit = 单位自带（units.json 的 abilities 引用）/ shop = 肉鸽商店抽取池 / both = 两侧都出 */
const ABILITY_SCOPES = new Set(['unit', 'shop', 'both']);

export interface TableOutput {
    schema: TableSchema;
    /** array 表 = 记录数组；kv 表 = 键值对象 */
    data: unknown;
    /** 数据行 Excel 行号（与记录顺序一致） */
    rowNos: number[];
}

/** 被引用表的数据来源：本次导出的结果，或磁盘上的 JSON */
export type TableResolver = (name: string) => { data: unknown; rowNos: number[]; label: string } | undefined;

export function crossCheck(outputs: Map<string, TableOutput>, report: Report, fallback: TableResolver): void {
    const cache = new Map<string, { data: unknown; rowNos: number[]; label: string } | undefined>();
    const resolve = (name: string): { data: unknown; rowNos: number[]; label: string } | undefined => {
        if (cache.has(name)) return cache.get(name);
        const own = outputs.get(name);
        const res = own
            ? { data: own.data, rowNos: own.rowNos, label: `${name}.xlsx` }
            : fallback(name);
        cache.set(name, res);
        return res;
    };

    const warnMissing = new Set<string>();
    const rowsOf = (name: string): { rec: Record<string, unknown>; where: string }[] => {
        const t = resolve(name);
        if (!t || !Array.isArray(t.data)) {
            if (!warnMissing.has(name)) {
                warnMissing.add(name);
                report.warn(`找不到 ${name} 表数据，跳过与之相关的关联校验（如需完整校验请一并导出该表）`);
            }
            return [];
        }
        return (t.data as Record<string, unknown>[]).map((rec, i) => {
            const rowNo = t.rowNos[i];
            const pos = rowNo ? ` 第 ${rowNo} 行` : '';
            return { rec, where: `${t.label}${pos} [id=${String(rec.id)}]` };
        });
    };
    const idsOf = (name: string): Set<number> | null => {
        const t = resolve(name);
        if (!t || !Array.isArray(t.data)) {
            if (!warnMissing.has(name)) {
                warnMissing.add(name);
                report.warn(`找不到 ${name} 表数据，跳过与之相关的关联校验（如需完整校验请一并导出该表）`);
            }
            return null;
        }
        const out = new Set<number>();
        for (const rec of t.data as Record<string, unknown>[]) {
            if (typeof rec.id === 'number') out.add(rec.id);
        }
        return out;
    };

    const attrIds = idsOf('attributes');
    const abilityIds = idsOf('abilities');
    const modifierIds = idsOf('modifiers');

    /** 同一 (类别, id) 只报第一条，避免每行刷屏 */
    const reported = new Map<string, { count: number; where: string }>();
    const reportRef = (label: string, id: unknown, where: string, suffix = ''): void => {
        const key = `${label}#${String(id)}`;
        const hit = reported.get(key);
        if (hit) {
            hit.count++;
            return;
        }
        reported.set(key, { count: 1, where });
        report.error(`${where}: 引用了不存在的${label} ${String(id)}${suffix}`);
    };

    const checkId = (id: unknown, set: Set<number> | null, label: string, where: string): void => {
        if (set === null || typeof id !== 'number') return;
        if (!set.has(id)) reportRef(label, id, where);
    };
    const checkAttrId = (id: unknown, where: string): void => {
        if (attrIds === null || typeof id !== 'number') return;
        if (!attrIds.has(id)) reportRef('属性编号', id, where, '（见 attributes.xlsx）');
    };
    /** 只取 [[id, 值], ...] 形式的 id 列表 */
    const pairIds = (v: unknown): unknown[] =>
        Array.isArray(v) ? v.filter(e => Array.isArray(e)).map(e => (e as unknown[])[0]) : [];

    // ---------- units ----------
    for (const { rec, where } of rowsOf('units')) {
        for (const id of (Array.isArray(rec.abilities) ? rec.abilities : [])) {
            checkId(id, abilityIds, '技能id', where);
        }
        for (const id of pairIds(rec.base_attributes)) checkAttrId(id, where);
        for (const id of pairIds(rec.growthValues)) checkAttrId(id, where);
    }

    // ---------- modifiers（效果已原子化：effects 里一条 effect 一件事） ----------
    /** Modifier 记录索引：遗物块要靠它校验 kv 参数是否被效果模板消费 */
    const modifierById = new Map<number, Record<string, unknown>>();
    let emptyModifiers = 0;
    for (const { rec, where } of rowsOf('modifiers')) {
        if (typeof rec.id === 'number') modifierById.set(rec.id, rec);
        const effects = Array.isArray(rec.effects) ? rec.effects : [];
        for (const raw of effects) {
            const eff = (raw ?? {}) as Record<string, unknown>;
            const type = String(eff.type);
            if (!MODIFIER_EFFECT_TYPES.has(type)) {
                report.warn(`${where}: effects 里的效果类型 "${type}" 不是声明式效果（见 EffectTypes.ModifierEffect）`);
                continue;
            }
            switch (type) {
                case 'modify_attr': {
                    const attrs = Array.isArray(eff.attrs) ? eff.attrs : [];
                    if (!attrs.length && eff.attrs_var === undefined) {
                        report.warn(`${where}: modify_attr 既没有 attrs 也没有 attrs_var（该效果不产生任何属性）`);
                    }
                    for (const e of attrs) {
                        if (Array.isArray(e)) {
                            checkAttrId(e[0], where);
                            if (e[2] !== undefined && !STACK_MODES.has(String(e[2]))) {
                                report.warn(`${where}: modify_attr 的叠加方式 "${String(e[2])}" 无效（add/percent/multiply/complement/best）`);
                            }
                        } else {
                            const obj = (e ?? {}) as Record<string, unknown>;
                            checkAttrId(obj.attr, where);
                            if (obj.mode !== undefined && !STACK_MODES.has(String(obj.mode))) {
                                report.warn(`${where}: modify_attr 的叠加方式 "${String(obj.mode)}" 无效`);
                            }
                        }
                    }
                    break;
                }
                case 'apply_state':
                    if (!STATE_NAMES.has(String(eff.state))) {
                        report.warn(`${where}: apply_state 的状态 "${String(eff.state)}" 不在 StateType 列表中（见 battle/types.ts）`);
                    }
                    break;
                case 'tick_damage':
                case 'tick_heal':
                case 'tick_apply_modifier': {
                    if (!(typeof eff.interval === 'number' && eff.interval > 0)) {
                        report.warn(`${where}: ${type} 缺少正的 interval（秒）`);
                    }
                    if (type === 'tick_apply_modifier') checkId(eff.modifier, modifierIds, 'Modifier', where);
                    break;
                }
            }
        }
        /**
         * 「挂上去不产生任何效果」= 纯计数/标记型 Modifier（如 `技能·静电层数`：
         * 它只承载 `stack_mode:stack` 的层数，让「满 5 层引爆」这个条件有个可数、可到期、
         * 可被驱散的东西，效果本身由脚本读层数后触发）。
         *
         * 这类行**一律 `is_hidden: true`**（不出现在 Buff 栏），所以判据放它们过去 ——
         * 否则每加一个计数器就要挨一条告警，真告警会被噪声淹掉。
         * 非隐藏行仍然照查：那是「加了 Modifier 却忘了给效果」的典型写法错误。
         */
        if (!effects.length && !Array.isArray(rec.events) && !rec.script_id && !rec.is_hidden) emptyModifiers++;
        walkEvents(rec.events, where, report, checkId, modifierIds);
    }
    if (emptyModifiers > 0) {
        report.warn(`${emptyModifiers} 条 Modifier 既没有 effects/events 也没有 script_id（挂上去不产生任何效果）`);
    }

    // ---------- abilities（单位技能 + 肉鸽额外技能，同一张表） ----------
    let emptyShopSkills = 0;
    for (const { rec, where } of rowsOf('abilities')) {
        if (rec.upgrades_to !== undefined && rec.upgrades_to !== null) {
            checkId(rec.upgrades_to, abilityIds, '技能id(upgrades_to)', where);
        }
        // 每级效果都是「动作数组」，逐级校验（effects=1 级 / effects_lv2 / effects_lv3=整体覆盖）
        checkActions(rec.effects, where, report, checkId, modifierIds);
        checkActions(rec.effects_lv2, `${where}.effects_lv2`, report, checkId, modifierIds);
        checkActions(rec.effects_lv3, `${where}.effects_lv3`, report, checkId, modifierIds);

        // scope 必填：决定这个技能出现在哪一侧（单位自带 / 商店抽取池 / 两侧都出）
        const scope = rec.scope;
        if (scope === undefined || scope === null || scope === '') {
            report.error(`${where}: 缺少 scope（必须 unit=单位自带 / shop=肉鸽商店 / both=两侧都出）`);
        } else if (!ABILITY_SCOPES.has(String(scope))) {
            report.error(`${where}: scope "${String(scope)}" 非法（必须 unit / shop / both）`);
        }

        const inShop = scope === 'shop' || scope === 'both';
        if (inShop) {
            // 商店技能靠这几个列进抽取池，缺一个就抽不出来 / 抽出来是空壳
            for (const key of ['rarity', 'stage', 'max_level']) {
                if (rec[key] === undefined || rec[key] === null) {
                    report.error(`${where}: scope 含 shop，但缺少 ${key}（rarity/stage/max_level 都是抽取必需列）`);
                }
            }
            if (typeof rec.max_level === 'number' && (rec.max_level < 1 || rec.max_level > 3)) {
                report.warn(`${where}: max_level=${rec.max_level}，技能最高只支持 3 级`);
            }
            if (typeof rec.stage === 'number' && (rec.stage < 1 || rec.stage > 4)) {
                report.warn(`${where}: stage=${rec.stage} 超出 1~4（阶段门槛只到 4）`);
            }
            // 只有文案、没有动作也没有 script_id = 抽到之后不会产生任何战斗效果
            const hasAction = (Array.isArray(rec.effects) && rec.effects.length > 0)
                || (Array.isArray(rec.effects_lv2) && rec.effects_lv2.length > 0)
                || (Array.isArray(rec.effects_lv3) && rec.effects_lv3.length > 0);
            if (!hasAction && !rec.script_id) emptyShopSkills++;
        }
    }
    if (emptyShopSkills > 0) {
        report.warn(`${emptyShopSkills} 个商店技能既没有 effects 也没有 script_id（能抽到、能进技能槽，但还没有战斗效果）`);
    }

    // ---------- relics（一件遗物一行：局内版 270 / 两侧都有 28 / 仅局外版 9） ----------
    let emptyRelics = 0;
    for (const { rec, where } of rowsOf('relics')) {
        const scope = rec.scope;
        if (scope === undefined || scope === null || scope === '') {
            report.error(`${where}: 缺少 scope（必须 inner=只有局内版 / outer=只有局外版 / both=两侧都有）`);
        } else if (!RELIC_SCOPES.has(String(scope))) {
            report.error(`${where}: scope "${String(scope)}" 非法（必须 inner / outer / both）`);
        }
        const hasInner = scope === 'inner' || scope === 'both';
        const hasOuter = scope === 'outer' || scope === 'both';

        const modsOf = (side: string): unknown[] => {
            const v = rec[`modifiers_${side}`];
            return Array.isArray(v) ? v : [];
        };

        // 两侧的列必须与 scope 对上：说了有某一侧，就得有那一侧的效果（描述 / modifiers / script_id 至少一样）
        const sides: Array<'inner' | 'outer'> = ['inner', 'outer'];
        for (const side of sides) {
            const declared = side === 'inner' ? hasInner : hasOuter;
            const desc = rec[`description_${side}`];
            const filled = (typeof desc === 'string' && desc !== '') || modsOf(side).length > 0;
            if (declared && !filled && !rec.script_id) {
                report.warn(`${where}: scope 含 ${side}，但 description_${side} / modifiers_${side} 都是空的（这一侧没有任何效果）`);
            }
            if (!declared && filled) {
                report.error(`${where}: 填了 ${side} 侧的效果（description_${side} / modifiers_${side}），但 scope="${String(scope)}" 不含 ${side}`);
            }
        }

        const category = rec.category;
        if (category !== undefined && category !== null && category !== '' && !RELIC_CATEGORIES.has(String(category))) {
            report.warn(`${where}: category "${String(category)}" 不在 d2_basic / d2_upgrade / d2_neutral 内（英雄专属装备已删除）`);
        }

        const allMods: unknown[] = [...modsOf('inner'), ...modsOf('outer')];
        if (!allMods.length && !rec.script_id) emptyRelics++;
        for (const m of allMods) {
            const entry = (m ?? {}) as Record<string, unknown>;
            checkId(entry.modifier, modifierIds, 'Modifier', where);
            if (typeof entry.modifier !== 'number') continue;
            const def = modifierById.get(entry.modifier);
            if (!def) continue;
            const kv = (entry.kv ?? {}) as Record<string, unknown>;
            // 效果模板声明的外部参数（attrs_var）必须由该遗物条目提供，否则效果不产生任何东西
            for (const raw of (Array.isArray(def.effects) ? def.effects : [])) {
                const eff = (raw ?? {}) as Record<string, unknown>;
                const key = eff.attrs_var;
                if (typeof key !== 'string') continue;
                const list = kv[key];
                if (!Array.isArray(list) || !list.length) {
                    report.error(`${where}: 引用的 Modifier ${String(entry.modifier)} 需要外部参数 kv.${key}（属性列表），当前缺失或为空`);
                    continue;
                }
                // 外置的属性条目同样要校验属性编号与叠加方式
                for (const e of list) {
                    if (Array.isArray(e)) {
                        checkAttrId(e[0], where);
                        if (e[2] !== undefined && !STACK_MODES.has(String(e[2]))) {
                            report.warn(`${where}: kv.${key} 的叠加方式 "${String(e[2])}" 无效（add/percent/multiply/complement/best）`);
                        }
                    } else {
                        checkAttrId((e as Record<string, unknown>)?.attr, where);
                    }
                }
            }
        }
    }
    if (emptyRelics > 0) {
        report.warn(`${emptyRelics} 条遗物两侧都没有 modifiers 也没有 script_id（获得后不产生任何效果）`);
    }

    // ---------- kill_buffs ----------
    for (const { rec, where } of rowsOf('kill_buffs')) {
        if (typeof rec.attr_id === 'number') checkAttrId(rec.attr_id, where);
        if (rec.stat === 'special' && !rec.script_id) {
            report.warn(`${where}: special 型击杀 Buff 未配置 script_id，运行时无法生效`);
        }
    }

    // 同类重复错误合并提示
    const merged = Array.from(reported.entries()).filter(([, v]) => v.count > 1);
    if (merged.length > 0) {
        const total = merged.reduce((n, [, v]) => n + v.count - 1, 0);
        report.warn(`另有 ${total} 处同类引用错误（相同 id 已合并，共 ${merged.length} 类）`);
    }
}

/** 校验动作数组（effects / events[].actions / projectile.hit_effects） */
function checkActions(
    actions: unknown,
    where: string,
    report: Report,
    checkId: (id: unknown, set: Set<number> | null, label: string, where: string) => void,
    modifierIds: Set<number> | null,
): void {
    if (!Array.isArray(actions)) return;
    for (const raw of actions) {
        if (!raw || typeof raw !== 'object') continue;
        const action = raw as Record<string, unknown>;
        const type = action.type;
        if (typeof type === 'string' && !ACTION_TYPES.has(type)) {
            report.error(`${where}: effects 动作类型 "${type}" 不被 EffectExecutor 支持`);
        }
        if (type === 'apply_modifier' || type === 'remove_modifier') {
            checkId(action.modifier, modifierIds, 'Modifier', where);
        }
        if (type === 'projectile') {
            checkActions(action.hit_effects, where, report, checkId, modifierIds);
        }
    }
}

/** 校验 events 数组 */
function walkEvents(
    events: unknown,
    where: string,
    report: Report,
    checkId: (id: unknown, set: Set<number> | null, label: string, where: string) => void,
    modifierIds: Set<number> | null,
): void {
    if (!Array.isArray(events)) return;
    for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.event === 'string' && !EVENT_NAMES.has(e.event)) {
            report.warn(`${where}: 事件名 "${e.event}" 不在 BattleEvents 列表中`);
        }
        checkActions(e.actions, where, report, checkId, modifierIds);
    }
}
