/** 路径解析：所有默认路径都相对本工具/项目根目录推导，可在命令行覆盖 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/tools/excel_export/src/util

/** 工具根目录 tools/excel_export */
export const TOOL_DIR = path.resolve(HERE, '../..');

/** 项目根目录 */
export const PROJECT_ROOT = path.resolve(TOOL_DIR, '../..');

/** 默认 Excel 目录 */
export const DEFAULT_EXCEL_DIR = path.join(TOOL_DIR, 'excel');

/** 相对项目根目录的路径 → 绝对路径 */
export function fromRoot(rel: string): string {
    return path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
}

/** 相对项目根目录显示（日志更短） */
export function toRootRelative(abs: string): string {
    const rel = path.relative(PROJECT_ROOT, abs);
    return rel.startsWith('..') ? abs : rel;
}
