/**
 * Excel 读写（基于 exceljs）
 *
 * 统一表结构（每张表一个 sheet）：
 *   第 1 行：字段名（英文，= JSON 键名）
 *   第 2 行：类型（int/number/string/bool/enum/json/attrpairs/...）
 *   第 3 行：中文说明
 *   第 4 行起：数据行（一行 = 一条记录）
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { encodeCell, normalizeRaw } from './codec.ts';
import type { RawCell, TableSchema } from './types.ts';

/** 表头所占行数（数据从第 4 行开始） */
export const HEADER_ROWS = 3;

/** 解析出的整张 sheet */
export interface SheetData {
    /** 数据行：rowNo 为 Excel 真实行号（1 基），cells 与表头列一一对应 */
    rows: { rowNo: number; cells: RawCell[] }[];
    /** 第 1 行字段名 */
    headers: string[];
    /** 第 2 行类型 */
    types: string[];
    /** 第 3 行说明 */
    descs: string[];
    /** sheet 名 */
    sheetName: string;
}

const STYLE = {
    headerFill: 'FF1F4E79',
    typeFill: 'FFDCE6F1',
    descFill: 'FFF2F2F2',
    border: 'FFBFBFBF',
};

/** 读取 xlsx 的第一个 sheet */
export async function readSheet(file: string): Promise<SheetData> {
    if (!fs.existsSync(file)) {
        throw new Error(`文件不存在：${file}`);
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error(`工作表为空：${file}`);

    const headers = rowTexts(ws, 1);
    const types = rowTexts(ws, 2);
    const descs = rowTexts(ws, 3);

    // 列数 = 表头行最后一个非空单元格（忽略尾部空列）
    let colCount = lastNonBlank(headers);
    if (colCount === 0) throw new Error(`${path.basename(file)} 第 1 行没有表头（字段名）`);

    // 数据区最大列（超出表头的部分也要读出来，便于报错）
    const raw: { rowNo: number; cells: RawCell[] }[] = [];
    const rowCount = ws.rowCount;
    for (let r = HEADER_ROWS + 1; r <= rowCount; r++) {
        const row = ws.getRow(r);
        const maxCol = Math.max(colCount, lastNonBlankRow(row, row.cellCount));
        const cells: RawCell[] = [];
        for (let c = 1; c <= maxCol; c++) {
            cells.push(normalizeRaw(row.getCell(c).value));
        }
        // 整行空白则跳过（方便表格中间留空行）
        if (cells.every(v => v === null || (typeof v === 'string' && v.trim() === ''))) continue;
        raw.push({ rowNo: r, cells });
    }

    // 以数据区实际用到的列数为准（表头缺失的列在导出时专门报错）
    for (const row of raw) colCount = Math.max(colCount, row.cells.length);

    const pad = (arr: string[]): string[] => {
        const out = arr.slice(0, colCount);
        while (out.length < colCount) out.push('');
        return out;
    };

    return {
        rows: raw,
        headers: pad(headers),
        types: pad(types),
        descs: pad(descs),
        sheetName: ws.name,
    };
}

/** 把记录写入 xlsx（覆盖生成） */
export async function writeTableFile(
    schema: TableSchema,
    rows: Record<string, unknown>[],
    outFile: string,
): Promise<void> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'jihe-excel-export';
    wb.created = new Date(0); // 固定时间，避免每次生成文件二进制 diff
    const ws = wb.addWorksheet(schema.name);

    const fields = schema.fields;
    ws.addRow(fields.map(f => f.key));
    ws.addRow(fields.map(f => f.type));
    ws.addRow(fields.map(f => f.desc));

    // 表头样式
    const styleHeader = (rowNo: number, fill: string, opts: { bold?: boolean; italic?: boolean }): void => {
        const row = ws.getRow(rowNo);
        row.height = rowNo === 3 ? 22 : 20;
        for (let c = 1; c <= fields.length; c++) {
            const cell = row.getCell(c);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
            cell.font = {
                size: rowNo === 1 ? 11 : 10,
                bold: opts.bold ?? false,
                italic: opts.italic ?? false,
                color: { argb: rowNo === 1 ? 'FFFFFFFF' : 'FF404040' },
                name: '微软雅黑',
            };
            cell.alignment = { vertical: 'middle', horizontal: rowNo === 3 ? 'left' : 'center', wrapText: rowNo === 3 };
            cell.border = thinBorder();
        }
        row.commit();
    };
    styleHeader(1, STYLE.headerFill, { bold: true });
    styleHeader(2, STYLE.typeFill, { italic: true });
    styleHeader(3, STYLE.descFill, {});

    // 数据行
    for (const rec of rows) {
        const values: RawCell[] = fields.map(f => {
            if (f.meta) {
                const v = rec[f.key];
                return v === undefined || v === null ? null : String(v);
            }
            return encodeCell(rec[f.key], f);
        });
        const row = ws.addRow(values);
        for (let c = 1; c <= fields.length; c++) {
            const cell = row.getCell(c);
            cell.font = { size: 10, name: '微软雅黑' };
            cell.alignment = { vertical: 'middle', wrapText: false };
            cell.border = thinBorder();
        }
        row.commit();
    }

    // 枚举列加下拉框（含预留空行，方便继续往下填）
    // 注意：exceljs 的 .d.ts 漏声明了 worksheet.dataValidations（运行时存在），故此处做一次断言
    const validations = (ws as unknown as { dataValidations: { add(range: string, v: unknown): void } }).dataValidations;
    const lastRow = Math.max(rows.length + HEADER_ROWS, 60) + 100;
    fields.forEach((f, i) => {
        if (f.type !== 'enum' || !f.enumValues?.length) return;
        const col = columnName(i + 1);
        validations.add(`${col}${HEADER_ROWS + 1}:${col}${lastRow}`, {
            type: 'list',
            allowBlank: true,
            formulae: [`"${f.enumValues.join(',')}"`],
            showErrorMessage: true,
            errorTitle: '取值非法',
            error: `只能是：${f.enumValues.join(' / ')}`,
        });
    });

    // 列宽：表头/说明/数据三者取最长
    fields.forEach((f, i) => {
        const dataLen = rows.reduce((max, rec) => {
            const v = rec[f.key];
            if (v === undefined || v === null) return max;
            return Math.max(max, displayWidth(String(typeof v === 'object' ? JSON.stringify(v) : v)));
        }, 0);
        const w = Math.max(displayWidth(f.key) + 2, displayWidth(f.desc) / 2, Math.min(dataLen + 2, 60), 10);
        ws.getColumn(i + 1).width = Math.min(Math.max(w, 10), 60);
    });

    // 冻结前 3 行 + 首列（主键），滚动时不丢表头
    // 注意：故意不加自动筛选，避免策划点「排序」把表头行卷进数据区
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROWS }];

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await wb.xlsx.writeFile(outFile);
}

// ============================ 内部工具 ============================

function thinBorder(): Partial<ExcelJS.Borders> {
    const side: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: STYLE.border } };
    return { top: side, left: side, bottom: side, right: side };
}

/** 读取某一行的文本（1 基行号） */
function rowTexts(ws: ExcelJS.Worksheet, rowNo: number): string[] {
    const row = ws.getRow(rowNo);
    const out: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
        const v = normalizeRaw(row.getCell(c).value);
        out.push(v === null ? '' : String(v).trim());
    }
    return out;
}

/** 最后一个非空元素的下标 + 1 */
function lastNonBlank(arr: string[]): number {
    let n = 0;
    arr.forEach((v, i) => {
        if (v !== '') n = i + 1;
    });
    return n;
}

/** 最后一个有值单元格的列号 */
function lastNonBlankRow(row: ExcelJS.Row, cellCount: number): number {
    let n = 0;
    for (let c = 1; c <= cellCount; c++) {
        const v = normalizeRaw(row.getCell(c).value);
        if (v !== null && String(v).trim() !== '') n = c;
    }
    return n;
}

/** 列号 → 列名（1 → A，27 → AA） */
export function columnName(n: number): string {
    let s = '';
    let x = n;
    while (x > 0) {
        const m = (x - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        x = Math.floor((x - 1) / 26);
    }
    return s;
}

/** 显示宽度（中文按 2 个字符算） */
function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    return w;
}
