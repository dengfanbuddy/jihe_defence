/**
 * Excel → JSON（导表主流程）
 *
 * 流程：读表 → 校验表头 → 逐行解码 → 主键查重 → 输出 JSON
 * 表头约定见 excelIo.ts；字段类型/简写见 codec.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeCell, isBlank } from './codec.ts';
import { HEADER_ROWS, readSheet } from './excelIo.ts';
import type { DecodeCtx } from './codec.ts';
import type { FieldDef, RawCell, TableSchema } from './types.ts';
import type { Report } from '../util/report.ts';

export interface ExcelToJsonResult {
    /** 解析出的数据（array 表 = 数组，kv 表 = 对象） */
    data: unknown;
    /** 记录数 */
    rows: number;
    /** 数据行在 Excel 中的行号（与 data 顺序一致，供交叉校验定位） */
    rowNos: number[];
}

/** 导表：Excel → 内存中的数据（不落盘） */
export async function excelToJson(
    schema: TableSchema,
    excelFile: string,
    report: Report,
): Promise<ExcelToJsonResult> {
    const sheet = await readSheet(excelFile);
    const file = path.basename(excelFile);
    const fields = schema.fields;

    // ---------- 1. 表头校验 ----------
    const fieldByKey = new Map<string, FieldDef>(fields.map(f => [f.key, f]));
    /** 列下标 → 字段定义 */
    const colFields = new Map<number, FieldDef>();
    const usedKeys = new Set<string>();

    for (let i = 0; i < sheet.headers.length; i++) {
        const header = sheet.headers[i];
        const hasData = sheet.rows.some(r => !isBlank(r.cells[i] ?? null));
        if (header === '') {
            if (hasData) {
                report.error(`${file}: 第 ${i + 1} 列（${columnLabel(i)}列）有数据但第 1 行缺少字段名`);
            }
            continue;
        }
        // `#` / `_` 开头 = 备注列，忽略
        if (header.startsWith('#') || header.startsWith('_')) continue;

        const field = fieldByKey.get(header);
        if (!field) {
            report.error(`${file}: 未知字段列 "${header}"（第 ${i + 1} 列）。如需新增字段请先在 src/core/schema.ts 中登记`);
            continue;
        }
        if (usedKeys.has(header)) {
            report.error(`${file}: 字段列 "${header}" 重复出现`);
            continue;
        }
        usedKeys.add(header);
        colFields.set(i, field);

        const declared = (sheet.types[i] ?? '').trim();
        if (declared && declared !== field.type) {
            report.warn(`${file}: 字段 "${header}" 第 2 行声明类型为 ${declared}，工具按 ${field.type} 处理`);
        }
    }

    // 必填字段必须有对应列
    for (const f of fields) {
        if (f.required && !usedKeys.has(f.key)) {
            report.error(`${file}: 缺少必填字段列 "${f.key}"`);
        }
    }
    // 主键列缺失属于致命错误，继续逐行解析只会刷屏
    if (!usedKeys.has(schema.primaryKey)) {
        report.error(`${file}: 缺少主键列 "${schema.primaryKey}"`);
        return { data: schema.format === 'kv' ? {} : [], rows: 0, rowNos: [] };
    }

    // ---------- 2. 逐行解码 ----------
    const records: Record<string, unknown>[] = [];
    const rowNos: number[] = [];
    const seen = new Map<string, number>(); // 主键 → 行号

    for (const row of sheet.rows) {
        // 主键原文（用于报错定位）
        const pkField = colFields.entries();
        let pkText = '';
        for (const [idx, f] of pkField) {
            if (f.key === schema.primaryKey) {
                const v = row.cells[idx];
                pkText = v === null || v === undefined ? '' : String(v);
                break;
            }
        }
        const where = `${file} 第 ${row.rowNo} 行${pkText ? ` [${schema.primaryKey}=${pkText}]` : ''}`;

        const rec: Record<string, unknown> = {};
        const ctx: DecodeCtx = { report, where };
        for (const [idx, field] of colFields) {
            const raw: RawCell = row.cells[idx] ?? null;
            const dec = decodeCell(raw, field, ctx);
            if (dec.present) rec[field.key] = dec.value;
        }

        // 主键必填 + 查重
        const pk = rec[schema.primaryKey];
        if (pk === undefined || pk === null || pk === '') {
            report.error(`${where}: 主键 "${schema.primaryKey}" 为空`);
            continue;
        }
        const pkKey = String(pk);
        if (seen.has(pkKey)) {
            report.error(`${where}: 主键 "${schema.primaryKey}" 重复（已在第 ${seen.get(pkKey)} 行出现）`);
            continue;
        }
        seen.set(pkKey, row.rowNo);

        // 去掉 meta 列（如 battle_constants 的 desc）
        for (const f of fields) {
            if (f.meta) delete rec[f.key];
        }
        records.push(rec);
        rowNos.push(row.rowNo);
    }

    // 有错误就不产出数据（导表流程会拒绝写盘，避免脏数据落盘）
    if (report.errors.length > 0) {
        return { data: schema.format === 'kv' ? {} : [], rows: 0, rowNos: [] };
    }

    // ---------- 3. 组装顶层结构 ----------
    if (schema.format === 'kv') {
        const obj: Record<string, unknown> = {};
        for (const rec of records) {
            obj[String(rec.key)] = rec.value;
        }
        return { data: obj, rows: records.length, rowNos };
    }
    return { data: records, rows: records.length, rowNos };
}

/** A、B、C… 列名（第 n 列，1 基） */
function columnLabel(index0: number): string {
    let n = index0 + 1;
    let s = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** 写出 JSON 文件（两空格缩进，与项目现有格式一致） */
export function writeJsonFile(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
