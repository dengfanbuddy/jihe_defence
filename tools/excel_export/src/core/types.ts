/**
 * 配表工具核心类型定义
 *
 * 设计目标：用一张 Excel 表描述一份 tb JSON，字段类型决定了
 * 「单元格文本 ⇄ JSON 值」的编解码方式。
 */

/**
 * 单元格数据类型
 *
 * | 类型 | 单元格写法 | JSON 结果 |
 * |---|---|---|
 * | `int` / `number` | `3` / `2.5` | `3` / `2.5` |
 * | `string` | `火枪` | `"火枪"` |
 * | `bool` | `1` / `0` / `true` / `是` | `true` / `false` |
 * | `enum` | `hero`（带下拉框） | `"hero"` |
 * | `json` | `[{"type":"damage","value":60}]` | 原样解析（必须合法 JSON） |
 * | `anyvalue` | `100` / `def/(def+100)` / `[1,5]` | `100` / `"def/(def+100)"` / `[1,5]` |
 * | `attrpairs` | `1:320\|9:1.5` | `[[1,320],[9,1.5]]` |
 * | `floatpairs` | `1:12\|6:0.3` | `[[1,12],[6,0.3]]` |
 * | `modprops` | `13:0\|5:-90@slow` | `[[13,0],[5,{"value":-90,"var":"slow"}]]` |
 * | `kvnum` | `atk:2\|critRate:0.1` | `{"atk":2,"critRate":0.1}` |
 * | `kvstr` | `atk:flat\|hp:percent` | `{"atk":"flat","hp":"percent"}` |
 * | `intarray` | `12,16` 或 `12\|16` | `[12,16]` |
 * | `numberarray` | `20,40,60` | `[20,40,60]` |
 * | `stringarray` | `fire,ice` | `["fire","ice"]` |
 *
 * 所有类型都容忍 JSON 原写法（以 `[` / `{` 开头的单元格按 JSON 解析），
 * 方便从旧 JSON 直接粘贴内容。
 */
export type CellType =
    | 'int'
    | 'number'
    | 'string'
    | 'bool'
    | 'enum'
    | 'json'
    | 'anyvalue'
    | 'attrpairs'
    | 'floatpairs'
    | 'modprops'
    | 'kvnum'
    | 'kvstr'
    | 'intarray'
    | 'numberarray'
    | 'stringarray';

/** 字段定义（= Excel 一列） */
export interface FieldDef {
    /** JSON 键名，同时是 Excel 第 1 行表头 */
    key: string;
    /** 单元格类型 */
    type: CellType;
    /** 中文说明，写入 Excel 第 3 行 */
    desc: string;
    /** `enum` 类型的候选值（写入下拉框，并参与校验） */
    enumValues?: string[];
    /** 必填字段：单元格为空时报错 */
    required?: boolean;
    /** 仅 Excel 辅助列，不导出到 JSON（如 battle_constants 的 desc 列） */
    meta?: boolean;
}

/** 一张表的完整描述 */
export interface TableSchema {
    /** 表名（同时也是 JSON 文件名与 xlsx 文件名），如 `units` */
    name: string;
    /** 中文表名，用于日志/说明 */
    label: string;
    /**
     * JSON 顶层结构：
     * - `array`：数组表，一行 = 一条记录（绝大多数表）
     * - `kv`：键值表，一行 = 一个 key（battle_constants.json）
     */
    format: 'array' | 'kv';
    /** JSON 输出路径（相对项目根目录） */
    jsonPath: string;
    /** Excel 文件名（相对 excel 目录） */
    excelFile: string;
    /** 主键字段名（用于查重、报错定位），kv 表为 `key` */
    primaryKey: string;
    /** 字段列表，顺序 = Excel 列顺序 = JSON 键顺序 */
    fields: FieldDef[];
    /** kv 表：key → 中文说明，生成 Excel 时填充 `desc` 列 */
    kvDesc?: Record<string, string>;
}

/** 解析后的单元格原始值 */
export type RawCell = string | number | boolean | null;

/** 解码结果：present=false 表示单元格为空（该键不输出） */
export interface Decoded {
    present: boolean;
    value: unknown;
}
