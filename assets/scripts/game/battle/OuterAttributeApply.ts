/**
 * OuterAttributeApply.ts —— 把**局外加成**落到一个实体的基础属性上（局外属性进战斗的唯一落地点）
 *
 * ## 它解决什么
 *
 * 局外成长（图鉴里的遗物，`data/configs/EquipmentConfig.getAllEquipmentBonuses()`）算出来的是一组
 * `OuterBonusGroup`（flat / percent 两层）。**这组数此前没有任何运行时消费点** ——
 * 玩家在局外收集了一堆遗物，进战斗的攻击力还是配置里那个数（`docs/shop/README.md` §4 第 9 条）。
 * 本文件就是那个缺失的消费点。
 *
 * ## 落在哪一层：**基础属性（base）**，不是 Modifier 贡献
 *
 * 三条理由（改之前先读）：
 *   ① 局外成长的公式是 `final = base × (1 + percent) + flat`（`OuterAttributeCalculator` 的文件头），
 *      而 `AttributeSystem` 结算贡献的顺序正是 **percent 先、add 后**、两者都作用在 `base` 上
 *      （`AttributeSystem.combine`）。**把结果直接写进 base，等价于"这个英雄生来就有这么多基础属性"**，
 *      与"局外成长改变的是英雄本体"这件事在语义上一致。
 *   ② **开局满血是对的**：`Entity.Reinit` 里 `hp = getMaxHp()` 是在基础属性就位之后取的。
 *      如果改走 Modifier，血量上限变了却要额外走一趟 `ApplyWithMaxHpCarry`（"加最大生命补当前生命"
 *      的唯一入口），多一条容易漏的路径。
 *   ③ 落点必须**早于** `hero.bind()`：血条（`HpBar`）在 bind 时按当时的 `getMaxHp()` 建。
 *
 * ## 两条口径
 *
 *   · **只动基础值，不动 percent 层对成长值的复利**：局外加成按**配置基础值**乘算，
 *     之后再叠加局内成长（`applyHeroGrowth` 走 `addBase`，是加法）。
 *     所以「局外 +10% 生命」永远只放大配置里那 100 点，不会把 30 级成长出来的血也放大一遍 ——
 *     这是可预期的，也是英雄页读数（`HeroConfig.getAttrRows`）能对上的口径。
 *   · **`percent` 打在基础值为 0 的属性上恒为 0**（护甲 / 闪避 / 回血那批）：
 *     这不是本文件的 bug，是全工程的属性口径（`docs/agent-notes/配表与数值口径.md`）——
 *     给这些属性加值必须走 `add`（`flat` 层）。局外遗物侧的门禁（`relicToBonusGroup`）已经保证这点。
 */

import { AttributeScaling } from './core/AttributeScaling';
import { AttributeType, OuterBonusGroup } from './core/Types';

/**
 * 能读写"基础属性"的最小口子。
 * `AttributeSystem` 天然满足（`getBase` 给**运行时 float**、`setBase` 吃**配置 int**）；
 * 体检传一个记账替身即可，不必拉起整个 `Entity`。
 */
export interface IBaseAttrTarget {
    /** 读基础值（运行时 float：`0.08` = 闪避 8%） */
    getBase(id: number): number;
    /** 写基础值（**配置 int**：闪避写 `8` 而不是 `0.08`） */
    setBase(id: number, value: number): void;
}

/** 一条属性的落点结果（日志 / 体检 / 将来的属性总览页共用） */
export interface OuterBonusApplyRow {
    attrId: AttributeType;
    /** 落点前的基础值（运行时 float） */
    before: number;
    /** 落点后**实际存进去**的基础值（运行时 float；按配置 int 精度取整后的回读值） */
    after: number;
    /** 这一条吃到的固定值层（运行时 float） */
    flat: number;
    /** 这一条吃到的百分比层（小数：`0.14` = +14%） */
    percent: number;
}

/**
 * 带基础属性 + 生命/魔法的实体（`Entity` 的结构子集，避免 battle 内部互相 import）。
 * 结构类型在这里是**有意的**：体检可以用一个 20 行的替身满足它。
 */
export interface IOuterBonusEntity {
    /** 实体自己的属性系统（`Entity.attrs`）—— 基础属性的读写都经过它 */
    attrs: IBaseAttrTarget;
    /** 当前生命（会被重置到新上限） */
    hp: number;
    /** 当前魔法（会被重置到新上限） */
    mana: number;
    getMaxHp(): number;
    getMaxMana(): number;
}

/** 这个加成组里出现过的属性 id（升序；两层都为 0 的会被调用方跳过） */
export function outerBonusAttrIds(group: OuterBonusGroup | null | undefined): AttributeType[] {
    const ids = new Set<number>();
    if (!group) return [];
    for (const layer of ['flat', 'percent'] as const) {
        const rec = group[layer];
        if (!rec) continue;
        for (const key of Object.keys(rec)) ids.add(Number(key));
    }
    return [...ids].filter((id) => Number.isFinite(id)).sort((a, b) => a - b) as AttributeType[];
}

/**
 * 把一组局外加成落到目标的基础属性上。**幂等性由调用方负责**：同一个实体上跑两次 = 加成吃了两遍
 * （调用点只有 `selectHero`，那里每次都是**新建的实体**，所以重复吃不到）。
 *
 * 单位口径是这里唯一的坑：`getBase` 给运行时 float、`setBase` 吃配置 int，
 * 所以回写必须过 `AttributeScaling.denormalize`（与 `Scene_Game_Stage.mulBaseAttr` 同一条口径）。
 * 缩放的百分比型属性会被取整到整百分点（配置表本身就是 int 语义，`100 = 100%`）。
 *
 * @returns 逐条结果（空的加成组 → 空数组，调用方据此跳过"重置血量"）
 */
export function applyOuterBonuses(target: IBaseAttrTarget, group: OuterBonusGroup | null | undefined): OuterBonusApplyRow[] {
    const rows: OuterBonusApplyRow[] = [];
    if (!target || !group) return rows;

    for (const attrId of outerBonusAttrIds(group)) {
        const flat = Number(group.flat?.[attrId] ?? 0);
        const percent = Number(group.percent?.[attrId] ?? 0);
        if (!Number.isFinite(flat) || !Number.isFinite(percent)) continue;
        if (flat === 0 && percent === 0) continue;

        const before = target.getBase(attrId);
        // 局外公式：final = base × (1 + percent) + flat（percent 是对**基础值**乘算，不复利）
        const after = before * (1 + percent) + flat;
        target.setBase(attrId, AttributeScaling.denormalize(attrId, after));
        rows.push({ attrId, before, after: target.getBase(attrId), flat, percent });
    }

    return rows;
}

/**
 * 实体级落点：先落基础属性，再**把当前生命/魔法重置到新上限**。
 *
 * 为什么要重置：`Entity.Reinit` 里的 `hp = getMaxHp()` 是在**局外加成之前**跑的，
 * 所以"局外 +200 生命"会变成"上限涨了 200、当前血还是旧的" —— 开局第一帧就是残血。
 * 开局（英雄刚创建、一点伤害都没吃）重置到满血是**唯一正确**的选择，
 * 与"升级不回血"那条口径不冲突：那条说的是**升级**，这里说的是**出生**。
 */
export function applyOuterBonusesToEntity(entity: IOuterBonusEntity, group: OuterBonusGroup | null | undefined): OuterBonusApplyRow[] {
    const rows = applyOuterBonuses(entity.attrs, group);
    if (rows.length) {
        entity.hp = entity.getMaxHp();
        entity.mana = entity.getMaxMana();
    }
    return rows;
}

/** 一句话摘要（开局日志用；没有任何加成时返回空串，调用方据此不打印） */
export function describeOuterBonus(rows: OuterBonusApplyRow[]): string {
    if (!rows || !rows.length) return '';
    return rows
        .map((r) => `属性 ${r.attrId} ${fmt(r.before)} → ${fmt(r.after)}`)
        .join(' / ');
}

function fmt(v: number): string {
    return Math.abs(v) >= 100 ? v.toFixed(0) : (Math.round(v * 100) / 100).toString();
}
