/**
 * 单元格 ⇄ JSON 值 编解码
 *
 * 解码（Excel → JSON）宽容：既支持简写（`1:320|2:120`），也支持把旧 JSON 直接粘进单元格。
 * 编码（JSON → Excel）稳定：保证「JSON → Excel → JSON」往返一致。
 */
import type { Decoded, FieldDef, RawCell } from './types.ts';
import type { Report } from '../util/report.ts';

/** 解码上下文 */
export interface DecodeCtx {
    report: Report;
    /** 出错位置描述，如 `units.xlsx 第 6 行 id=1001 字段 base_attributes` */
    where: string;
}

const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'y', 't', '是', '真', '√', '✓', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'n', 'f', '否', '假', '×', 'x', 'off']);
/**
 * 视为 JSON null 的字面量。
 * 只认 `null`：`none` 是 stack_mode 的合法取值，不能当 null 吞掉。
 */
const NULL_TOKENS = new Set(['null']);
/** 条目分隔符（`1:320|2:120` 中的 `|`） */
const ENTRY_SEP = /[|;；\n\r]+/;
/** 键值分隔符（`1:320` 中的 `:`） */
const KV_SEP = /[:=＝，,]/;

// ============================ 基础工具 ============================

/** 把 exceljs 的任意单元格值规整为原始标量 */
export function normalizeRaw(value: unknown): RawCell {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value as RawCell;
    if (value instanceof Date) return value.toISOString();
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
        return (obj.richText as { text?: string }[]).map(r => r.text ?? '').join('');
    }
    if ('result' in obj) return normalizeRaw(obj.result); // 公式单元格取计算结果
    if ('text' in obj) return normalizeRaw(obj.text);     // 超链接单元格取显示文本
    if ('error' in obj) return null;                      // #REF! 之类视为空
    return String(value);
}

/** 单元格是否为空 */
export function isBlank(raw: RawCell): boolean {
    return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

/** 是否显式写 null（用于 `damage_type: null` 这类保留 null 的字段） */
function isNullToken(raw: RawCell): boolean {
    return typeof raw === 'string' && NULL_TOKENS.has(raw.trim().toLowerCase());
}

/** 去掉多余空白后的文本 */
function text(raw: RawCell): string {
    return typeof raw === 'string' ? raw.trim() : String(raw);
}

function toNumber(raw: RawCell): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const t = text(raw).replace(/[＋+]/g, '');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function toInt(raw: RawCell): number | null {
    const n = toNumber(raw);
    if (n === null) return null;
    const i = Math.trunc(n);
    if (i !== n) return null; // 明确报错：配置了小数
    return i;
}

function toBool(raw: RawCell): boolean | null {
    if (typeof raw === 'boolean') return raw;
    const t = text(raw).toLowerCase();
    if (TRUE_TOKENS.has(t)) return true;
    if (FALSE_TOKENS.has(t)) return false;
    return null;
}

/** 拆成条目数组：`1:320|2:120` → `['1:320','2:120']` */
function splitEntries(src: string): string[] {
    return src.split(ENTRY_SEP).map(s => s.trim()).filter(s => s !== '');
}

/** 尝试把单元格当 JSON 解析，失败返回 undefined（不影响简写解析） */
function tryParseJson(src: string): unknown {
    const t = src.trim();
    if (!t.startsWith('[') && !t.startsWith('{')) return undefined;
    try {
        return JSON.parse(t);
    } catch {
        return undefined;
    }
}

/** 任意值：JSON 优先，失败按纯文本（KV 表的 value 列用） */
function parseAnyValue(src: string): unknown {
    const t = src.trim();
    try {
        return JSON.parse(t);
    } catch {
        return t;
    }
}

function numText(n: number): string {
    return String(n);
}

// ============================ 解码：Excel → JSON ============================

/**
 * 解码一个单元格。
 * @returns `{present:false}` 表示单元格为空且该字段可省略（不写入 JSON）
 */
export function decodeCell(raw: RawCell, field: FieldDef, ctx: DecodeCtx): Decoded {
    if (isBlank(raw)) {
        if (field.required) {
            ctx.report.error(`${ctx.where}: 必填字段为空`);
        }
        return { present: false, value: undefined };
    }
    // 显式 null（大小写不敏感）
    if (isNullToken(raw) && field.type !== 'string') {
        return { present: true, value: null };
    }

    switch (field.type) {
        case 'string':
            return { present: true, value: text(raw) };

        case 'enum': {
            const v = text(raw);
            if (field.enumValues && !field.enumValues.includes(v)) {
                ctx.report.warn(`${ctx.where}: 枚举值 "${v}" 不在候选 [${field.enumValues.join('/')}] 内`);
            }
            return { present: true, value: v };
        }

        case 'int': {
            const n = toInt(raw);
            if (n === null) {
                ctx.report.error(`${ctx.where}: 期望整数，实际 "${text(raw)}"`);
                return { present: false, value: undefined };
            }
            return { present: true, value: n };
        }

        case 'number': {
            const n = toNumber(raw);
            if (n === null) {
                ctx.report.error(`${ctx.where}: 期望数字，实际 "${text(raw)}"`);
                return { present: false, value: undefined };
            }
            return { present: true, value: n };
        }

        case 'bool': {
            const b = toBool(raw);
            if (b === null) {
                ctx.report.error(`${ctx.where}: 期望布尔值（1/0/true/false/是/否），实际 "${text(raw)}"`);
                return { present: false, value: undefined };
            }
            return { present: true, value: b };
        }

        case 'json': {
            const parsed = tryParseJson(text(raw));
            if (parsed === undefined) {
                ctx.report.error(`${ctx.where}: JSON 解析失败，实际 "${text(raw)}"`);
                return { present: false, value: undefined };
            }
            return { present: true, value: parsed };
        }

        case 'anyvalue':
            // 任意值：先按 JSON 解析（数字/数组/对象/字符串），解析不了就按普通文本
            return { present: true, value: parseAnyValue(text(raw)) };

        case 'attrpairs':
        case 'floatpairs': {
            const v = parsePairs(text(raw), 'number', field, ctx);
            return { present: v !== undefined, value: v };
        }

        case 'modprops': {
            const v = parseModProps(text(raw), ctx);
            return { present: v !== undefined, value: v };
        }

        case 'kvnum':
        case 'kvstr': {
            const v = parseKv(text(raw), field.type === 'kvnum' ? 'number' : 'string', ctx);
            return { present: v !== undefined, value: v };
        }

        case 'intarray':
        case 'numberarray':
        case 'stringarray': {
            const itemType = field.type === 'intarray' ? 'int' : field.type === 'numberarray' ? 'number' : 'string';
            const v = parseArray(text(raw), itemType, ctx);
            return { present: v !== undefined, value: v };
        }

        default:
            ctx.report.error(`${ctx.where}: 未知字段类型 ${(field as FieldDef).type}`);
            return { present: false, value: undefined };
    }
}

/** `[[属性id, 数值], ...]` */
function parsePairs(src: string, kind: 'int' | 'number', field: FieldDef, ctx: DecodeCtx): unknown {
    const asJson = tryParseJson(src);
    let entries: unknown[] | null = null;
    if (Array.isArray(asJson)) {
        if (asJson.length === 0) return []; // 空数组字面量 []
        // [[1,320],[2,120]] 或 [1,320]
        entries = Array.isArray(asJson[0]) ? (asJson as unknown[]) : [asJson];
    } else {
        entries = splitEntries(src).map(item => {
            const m = splitOnce(item);
            if (!m) return null;
            const id = toInt(m[0]);
            const val = kind === 'int' ? toInt(m[1]) : toNumber(m[1]);
            if (id === null || val === null) return null;
            return [id, val];
        });
        if (entries.some(e => e === null)) {
            ctx.report.error(`${ctx.where}: 属性对格式应为 "属性id:数值|属性id:数值"，实际 "${src}"`);
            return undefined;
        }
    }

    const out: [number, number][] = [];
    for (const e of entries) {
        if (!Array.isArray(e) || e.length < 2) {
            ctx.report.error(`${ctx.where}: 属性对格式错误（应为 [属性id, 数值]），实际 "${JSON.stringify(e)}"`);
            return undefined;
        }
        const id = toInt(e[0] as RawCell);
        const val = kind === 'int' ? toInt(e[1] as RawCell) : toNumber(e[1] as RawCell);
        if (id === null || val === null) {
            ctx.report.error(`${ctx.where}: 属性对数值非法 "${JSON.stringify(e)}"（属性id 与数值都必须是${kind === 'int' ? '整数' : '数字'}）`);
            return undefined;
        }
        out.push([id, val]);
    }
    return out;
}

/** `[[属性id, 数值 或 {value,var,mode}], ...]` */
function parseModProps(src: string, ctx: DecodeCtx): unknown {
    const asJson = tryParseJson(src);
    if (Array.isArray(asJson)) {
        for (const e of asJson) {
            if (!Array.isArray(e) || e.length < 2) {
                ctx.report.error(`${ctx.where}: properties 条目应为 [属性id, 数值] 或 [属性id, {value,var,mode}]，实际 "${JSON.stringify(e)}"`);
                return undefined;
            }
        }
        return asJson;
    }

    const out: [number, unknown][] = [];
    for (const item of splitEntries(src)) {
        const m = splitOnce(item);
        if (!m) {
            ctx.report.error(`${ctx.where}: properties 格式应为 "属性id:数值@变量#叠加方式"，实际 "${item}"`);
            return undefined;
        }
        const id = toInt(m[0]);
        // `-90@slow#add` → 数值 -90 / 变量 slow / 叠加方式 add
        let rest = m[1].trim();
        let mode: string | undefined;
        const hashAt = rest.indexOf('#');
        if (hashAt >= 0) {
            mode = rest.slice(hashAt + 1).trim();
            rest = rest.slice(0, hashAt).trim();
        }
        let varName: string | undefined;
        const atAt = rest.indexOf('@');
        if (atAt >= 0) {
            varName = rest.slice(atAt + 1).trim();
            rest = rest.slice(0, atAt).trim();
        }
        const value = toNumber(rest);
        if (id === null || value === null) {
            ctx.report.error(`${ctx.where}: properties 数值非法 "${item}"`);
            return undefined;
        }
        if (varName || mode) {
            const entry: Record<string, unknown> = { value };
            if (varName) entry.var = varName;
            if (mode) entry.mode = mode;
            out.push([id, entry]);
        } else {
            out.push([id, value]);
        }
    }
    return out;
}

/** `{键: 值}` */
function parseKv(src: string, kind: 'number' | 'string', ctx: DecodeCtx): unknown {
    const asJson = tryParseJson(src);
    if (asJson && typeof asJson === 'object' && !Array.isArray(asJson)) {
        return asJson;
    }
    const out: Record<string, unknown> = {};
    for (const item of splitEntries(src)) {
        const m = splitOnce(item);
        if (!m) {
            ctx.report.error(`${ctx.where}: 键值格式应为 "键:值|键:值"，实际 "${item}"`);
            return undefined;
        }
        const key = m[0].trim();
        if (kind === 'number') {
            const n = toNumber(m[1]);
            if (n === null) {
                ctx.report.error(`${ctx.where}: 键 "${key}" 的值应为数字，实际 "${m[1]}"`);
                return undefined;
            }
            out[key] = n;
        } else {
            out[key] = m[1].trim();
        }
    }
    return out;
}

/** `[a, b, c]` */
function parseArray(src: string, itemType: 'int' | 'number' | 'string', ctx: DecodeCtx): unknown {
    const asJson = tryParseJson(src);
    if (Array.isArray(asJson)) return asJson;
    if (src.trim() === '') return [];
    const items = src.split(/[,，|;；、\s]+/).map(s => s.trim()).filter(s => s !== '');
    if (itemType === 'string') return items;
    const out: number[] = [];
    for (const it of items) {
        const n = itemType === 'int' ? toInt(it) : toNumber(it);
        if (n === null) {
            ctx.report.error(`${ctx.where}: 数组元素 "${it}" 应为${itemType === 'int' ? '整数' : '数字'}`);
            return undefined;
        }
        out.push(n);
    }
    return out;
}

/** 按第一个分隔符切成两段 */
function splitOnce(item: string): [string, string] | null {
    const idx = item.search(KV_SEP);
    if (idx <= 0) return null;
    const head = item.slice(0, idx).trim();
    const tail = item.slice(idx + 1).trim();
    if (head === '' || tail === '') return null;
    return [head, tail];
}

// ============================ 编码：JSON → Excel ============================

/** 把 JSON 值编码为单元格值 */
export function encodeCell(value: unknown, field: FieldDef): RawCell {
    if (value === undefined || value === null) {
        // null 写字面量 "null"，解码时还原为 null（保留 damage_type: null 这类语义）
        return value === null ? 'null' : null;
    }

    switch (field.type) {
        case 'int':
        case 'number':
            return typeof value === 'number' ? value : Number(value);

        case 'bool':
            return value === true || value === 'true' || value === 1;

        case 'string':
        case 'enum':
            return String(value);

        case 'json':
            return JSON.stringify(value);

        case 'anyvalue':
            // 字符串直接写原文（不加引号），其余按 JSON 文本写
            return typeof value === 'string' ? value : JSON.stringify(value);

        case 'attrpairs':
        case 'floatpairs': {
            const arr = value as [number, unknown][];
            if (arr.length === 0) return '[]'; // 空数组写字面量，避免被判为空单元格而丢字段
            return arr.map(([id, v]) => `${id}:${numText(Number(v))}`).join('|');
        }

        case 'modprops': {
            const arr = value as [number, unknown][];
            if (arr.length === 0) return '[]';
            return arr.map(([id, v]) => {
                if (v === null || typeof v !== 'object') return `${id}:${numText(Number(v))}`;
                const o = v as { value?: number; var?: string; mode?: string };
                let s = `${id}:${numText(Number(o.value ?? 0))}`;
                if (o.var) s += `@${o.var}`;
                if (o.mode) s += `#${o.mode}`;
                return s;
            }).join('|');
        }

        case 'kvnum':
        case 'kvstr': {
            const obj = value as Record<string, unknown>;
            if (Object.keys(obj).length === 0) return '{}';
            return Object.entries(obj)
                .map(([k, v]) => `${k}:${v}`)
                .join('|');
        }

        case 'intarray':
        case 'numberarray':
        case 'stringarray': {
            const arr = value as unknown[];
            return arr.length === 0 ? '[]' : arr.join(',');
        }

        default:
            return String(value);
    }
}
