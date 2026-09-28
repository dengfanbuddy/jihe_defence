import { AttributeContribution, AttributeStackMode } from './types';
import { AttributeScaling } from './core/AttributeScaling';
import type { AttributeCfgContainer } from '../excel_table/Tb_AttributeConfig';

/**
 * 属性系统 —— 借鉴 Dota 2 的属性/衍生属性 + Modifier Property 汇总机制
 *
 * 设计：
 *   - 属性定义（叠加方式、钳制范围）来自 TbRoot 配置容器（attributes.json）
 *   - 每个属性 = 基础值 + 所有 Modifier 的贡献汇总
 *   - 四种叠加方式：加法(固定值) / 百分比 / 乘法 / 补数乘法 / 优者生效
 *     · percent = `base × (1 + Σv)`：同类**加法叠加**、只对基础值乘算一次（多来源不复利）
 *     · add     = `+ Σv` 固定值，加在百分比之后
 *   - 修改后标记 dirty，下次读取时统一重算（Dota 2 的 Property Resolution）
 *
 * v2：属性 id 统一为 number（AttributeType 枚举），配置用二维数组 [[id, value]]
 * v3：倍率/百分比型属性（魔抗/攻速/倍率等）配置表统一 int（100=100%），
 *     内部经 AttributeScaling 换算为 float，消费方语义不变（0.25 = 25%）
 */
export class AttributeSystem {
    /** 属性定义容器（TbRoot 全局配置） */
    private defs: AttributeCfgContainer;
    /** 基础值（永久修改：升级、天赋、装备基础；内部存运行时 float） */
    private base = new Map<number, number>();
    /** Modifier 贡献（ModifierSystem 在添加/移除 Modifier 时调用 SetContributions 更新） */
    private contributions = new Map<number, AttributeContribution[]>();
    /** 计算结果缓存 */
    private cache = new Map<number, number>();
    /** 是否有属性变脏 */
    private dirty = false;

    constructor(defs: AttributeCfgContainer, initialBase?: Array<[number, number]> | Record<string, number>) {
        this.defs = defs;
        if (initialBase) {
            if (Array.isArray(initialBase)) {
                // 二维数组形式 [[attrId, value], ...]（value 为配置 int，缩放的自动换算）
                for (const [id, v] of initialBase) {
                    this.base.set(id, AttributeScaling.normalize(id, v));
                }
            } else {
                // 兼容旧对象形式 { "atk": 100 }
                for (const [id, v] of Object.entries(initialBase)) {
                    this.base.set(Number(id), AttributeScaling.normalize(Number(id), v));
                }
            }
        }
        // 所有定义属性写入缓存键（attributes.json base 也是配置 int，统一换算）
        for (const def of defs.cfgs) {
            this.cache.set(def.id, AttributeScaling.normalize(def.id, def.base ?? 0));
        }
        this.dirty = true;
    }

    /** 是否存在该属性定义 */
    has(id: number): boolean {
        return this.defs.getCfgById(id) !== undefined;
    }

    /** 设置基础值（传入配置 int，缩放的自动换算为 float） */
    setBase(id: number, value: number): void {
        this.base.set(id, AttributeScaling.normalize(id, value));
        this.dirty = true;
    }

    /** 增加基础值（delta 为配置 int 语义） */
    addBase(id: number, delta: number): void {
        this.base.set(id, (this.base.get(id) ?? this.getBase(id)) + AttributeScaling.normalize(id, delta));
        this.dirty = true;
    }

    /** 获取基础值（运行时 float 语义） */
    getBase(id: number): number {
        const v = this.base.get(id);
        if (v !== undefined) return v;
        return AttributeScaling.normalize(id, this.defs.getCfgById(id)?.base ?? 0);
    }

    /** 由 ModifierSystem 调用：整体替换某属性的全部贡献 */
    setContributions(id: number, contributions: AttributeContribution[]): void {
        this.contributions.set(id, contributions);
        this.dirty = true;
    }

    /** 清空所有贡献（Modifier 全移除时） */
    clearAllContributions(): void {
        this.contributions.clear();
        this.dirty = true;
    }

    /** 获取属性当前值（必要时重算） */
    get(id: number): number {
        if (this.dirty) this.recalculate();
        const v = this.cache.get(id);
        if (v === undefined) {
            // 未定义的属性：直接返回基础值（宽松模式）
            return this.getBase(id);
        }
        return v;
    }

    /** 获取百分比形式的属性（0.5 = 50%），补数类属性直接给最终抗性 */
    getPercent(id: number): number {
        return this.get(id);
    }

    /** 重算所有属性 */
    private recalculate(): void {
        for (const def of this.defs.cfgs) {
            const id = def.id;
            const base = this.getBase(id);
            const list = this.contributions.get(id);
            let result = base;
            if (list && list.length > 0) {
                result = this.combine(id, base, list, def.stack_mode);
            }
            // 钳制（attributes.json min/max 为配置 int，统一换算）
            if (def.min !== undefined) result = Math.max(AttributeScaling.normalize(id, def.min), result);
            if (def.max !== undefined) result = Math.min(AttributeScaling.normalize(id, def.max), result);
            this.cache.set(id, result);
        }
        this.dirty = false;
    }

    /** 按叠加方式合并贡献（贡献值来自配置 int，按当前属性 id 统一换算为 float） */
    private combine(id: number, base: number, list: AttributeContribution[], defaultMode: AttributeStackMode): number {
        // 按 order 分组排序，保证确定性
        const sorted = [...list].sort((a, b) => a.order - b.order);

        // 按模式分组（属性默认模式 + modifier 覆盖模式），组内存「配置原值」
        const groups = new Map<AttributeStackMode, number[]>();
        for (const c of sorted) {
            const mode = c.mode ?? defaultMode;
            if (!groups.has(mode)) groups.set(mode, []);
            groups.get(mode)!.push(c.value);
        }
        /**
         * 配置值 → 运行时值。
         * - percent：配置值统一是「百分数」（14 = +14%），对所有属性一视同仁，**不走 AttributeScaling**
         * - 其余：走 AttributeScaling（百分比型属性 int = 值×100，如魔抗 20 = 20%）
         */
        const toRuntime = (mode: AttributeStackMode, v: number): number =>
            mode === AttributeStackMode.Percent ? v / 100 : AttributeScaling.normalize(id, v);
        const values = (mode: AttributeStackMode): number[] =>
            (groups.get(mode) ?? []).map(v => toRuntime(mode, v));

        let result = base;

        // percent 最先：只对**基础值**乘算，多来源同类加法叠加（1 + Σv）而不是复利（Π(1+v)）
        const pct = values(AttributeStackMode.Percent);
        if (pct.length) result *= 1 + pct.reduce((s, v) => s + v, 0);

        // 固定值（add）加在百分比之后
        const add = values(AttributeStackMode.Add);
        if (add.length) result += add.reduce((s, v) => s + v, 0);

        const mul = values(AttributeStackMode.Multiply);
        if (mul.length) {
            let factor = 1;
            for (const v of mul) factor *= 1 + v;
            result *= factor;
        }

        const comp = values(AttributeStackMode.Complement);
        if (comp.length) {
            // 补数乘法：final = 1 - (1 - base) × Π(1 - v)
            let survive = 1 - result;
            for (const v of comp) survive *= 1 - v;
            result = 1 - survive;
        }

        const best = values(AttributeStackMode.Best);
        if (best.length > 0) {
            result = Math.max(result, ...best);
        }

        return result;
    }
}
