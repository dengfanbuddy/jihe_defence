/**
 * JSON → Excel（首刷 / 从 JSON 回灌表格）
 *
 * 用途：
 *   1. 首次把 assets/resources/tb/*.json 刷成 xlsx 交给策划
 *   2. JSON 被批量改动后，再把改动同步回表格（会覆盖表格内容，需 --force）
 */
import fs from 'node:fs';
import type { Report } from '../util/report.ts';
import { writeTableFile } from './excelIo.ts';
import type { TableSchema } from './types.ts';

export interface JsonToExcelResult {
    /** 生成的记录行数 */
    rows: number;
    /** 目录 */
    outFile: string;
}

/** 读取 JSON 文件 */
export function readJsonFile(file: string): unknown {
    if (!fs.existsSync(file)) throw new Error(`JSON 不存在：${file}`);
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
}

/** JSON 数据 → 表格记录行（两种顶层结构统一成「一行一条」） */
export function jsonToRecords(schema: TableSchema, json: unknown, report: Report): Record<string, unknown>[] {
    if (schema.format === 'kv') {
        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
            report.error(`${schema.name}.json 顶层应为对象（KV 结构）`);
            return [];
        }
        return Object.entries(json as Record<string, unknown>).map(([key, value]) => ({
            key,
            value,
            desc: schema.kvDesc?.[key] ?? '',
        }));
    }

    if (!Array.isArray(json)) {
        report.error(`${schema.name}.json 顶层应为数组`);
        return [];
    }
    const rows = json as Record<string, unknown>[];
    const known = new Set(schema.fields.map(f => f.key));
    rows.forEach((rec, i) => {
        for (const k of Object.keys(rec)) {
            if (!known.has(k)) {
                report.warn(`${schema.name}.json 第 ${i + 1} 条存在表结构外的字段 "${k}"，已忽略（如需要请先在 schema.ts 中加列）`);
            }
        }
    });
    return rows;
}

/** 生成（覆盖）xlsx */
export async function jsonToExcel(
    schema: TableSchema,
    jsonFile: string,
    outFile: string,
    report: Report,
): Promise<JsonToExcelResult> {
    const json = readJsonFile(jsonFile);
    const rows = jsonToRecords(schema, json, report);
    await writeTableFile(schema, rows, outFile);
    return { rows: rows.length, outFile };
}
