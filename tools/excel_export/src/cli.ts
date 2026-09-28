#!/usr/bin/env node
/**
 * 导表工具 CLI
 *
 *   npm run export                    # excel2json：excel/*.xlsx → assets/resources/tb/*.json
 *   npm run export -- --table units   # 只导一张表
 *   npm run check                     # 只校验不写盘（CI 用）
 *   npm run import                    # json2excel：由 JSON 首刷/回灌表格
 *   npm run verify                    # 往返自检 JSON→表格→JSON 是否一致
 *   npm run list                      # 列出所有表与字段
 *
 * 参数：--table <名> --excel-dir <目录> --json-dir <目录> --check --strict --force --no-cross-check
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TABLES, getTable } from './core/schema.ts';
import { excelToJson, writeJsonFile } from './core/excelToJson.ts';
import { jsonToExcel, jsonToRecords, readJsonFile } from './core/jsonToExcel.ts';
import { writeTableFile } from './core/excelIo.ts';
import { crossCheck } from './core/crossCheck.ts';
import type { TableOutput } from './core/crossCheck.ts';
import { Report } from './util/report.ts';
import { diffJson } from './util/diff.ts';
import { DEFAULT_EXCEL_DIR, TOOL_DIR, fromRoot, toRootRelative } from './util/paths.ts';
import type { TableSchema } from './core/types.ts';

// ============================ 终端输出 ============================

const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: string, s: string): string => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const c = {
    red: (s: string) => paint('31', s),
    green: (s: string) => paint('32', s),
    yellow: (s: string) => paint('33', s),
    blue: (s: string) => paint('36', s),
    gray: (s: string) => paint('90', s),
    bold: (s: string) => paint('1', s),
};

const log = (msg = ''): void => console.log(msg);

function printReport(report: Report, strict: boolean): void {
    const maxShow = 60;
    if (report.warnings.length) {
        log(c.yellow(`\n⚠ 警告 ${report.warnings.length} 条${strict ? '（--strict：视为错误）' : ''}：`));
        for (const w of report.warnings.slice(0, maxShow)) log('  ' + c.yellow('· ') + w);
        if (report.warnings.length > maxShow) log(c.gray(`  ... 其余 ${report.warnings.length - maxShow} 条已省略`));
    }
    if (report.errors.length) {
        log(c.red(`\n✖ 错误 ${report.errors.length} 条：`));
        for (const e of report.errors.slice(0, maxShow)) log('  ' + c.red('· ') + e);
        if (report.errors.length > maxShow) log(c.gray(`  ... 其余 ${report.errors.length - maxShow} 条已省略`));
    }
}

// ============================ 参数 ============================

const OPTIONS = {
    table: { type: 'string' },
    'excel-dir': { type: 'string' },
    'json-dir': { type: 'string' },
    check: { type: 'boolean' },
    strict: { type: 'boolean' },
    force: { type: 'boolean' },
    'no-cross-check': { type: 'boolean' },
    help: { type: 'boolean' },
} as const;

interface Ctx {
    excelDir: string;
    jsonDir: string;
    strict: boolean;
    check: boolean;
    force: boolean;
    crossCheck: boolean;
    tables: TableSchema[];
}

function parseCtx(): { command: string; ctx: Ctx } {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: OPTIONS,
        allowPositionals: true,
    });
    const command = positionals[0] ?? (values.help ? 'help' : 'excel2json');

    const excelDir = values['excel-dir'] ? path.resolve(values['excel-dir']) : DEFAULT_EXCEL_DIR;
    const jsonDir = values['json-dir'] ? path.resolve(values['json-dir']) : fromRoot('assets/resources/tb');

    let tables = TABLES;
    if (values.table) {
        const picked = values.table.split(',').map(s => s.trim()).filter(Boolean).map(name => {
            const t = getTable(name);
            if (!t) {
                log(c.red(`未知表名：${name}（可用：${TABLES.map(x => x.name).join(', ')}）`));
                process.exit(2);
            }
            return t;
        });
        tables = picked;
    }

    return {
        command,
        ctx: {
            excelDir,
            jsonDir,
            strict: values.strict === true,
            check: values.check === true,
            force: values.force === true,
            crossCheck: values['no-cross-check'] !== true,
            tables,
        },
    };
}

// ============================ excel2json（导表） ============================

async function cmdExcel2Json(ctx: Ctx): Promise<number> {
    log(c.bold(`▌导表 Excel → JSON`));
    log(c.gray(`  表格目录：${toRootRelative(ctx.excelDir)}`));
    log(c.gray(`  输出目录：${toRootRelative(ctx.jsonDir)}${ctx.check ? '（--check 只校验不写盘）' : ''}`));

    const report = new Report();
    const outputs = new Map<string, TableOutput>();

    for (const schema of ctx.tables) {
        const excelFile = path.join(ctx.excelDir, schema.excelFile);
        if (!fs.existsSync(excelFile)) {
            report.error(`表格不存在：${toRootRelative(excelFile)}（可用 npm run import 由 JSON 生成）`);
            continue;
        }
        const local = new Report();
        const res = await excelToJson(schema, excelFile, local);
        if (local.ok) {
            outputs.set(schema.name, { schema, data: res.data, rowNos: res.rowNos });
            log(`  ${c.green('✔')} ${schema.name.padEnd(18)} ${String(res.rows).padStart(4)} 条  ${c.gray(schema.label)}`);
        } else {
            log(`  ${c.red('✖')} ${schema.name.padEnd(18)} ${c.red(`${local.errors.length} 个错误`)}`);
        }
        report.merge(local);
    }

    if (ctx.crossCheck && report.ok && outputs.size > 0) {
        // 只导部分表时，被引用表回退读磁盘 JSON，避免误报「id 不存在」
        crossCheck(outputs, report, name => {
            const file = path.join(ctx.jsonDir, `${name}.json`);
            if (!fs.existsSync(file)) return undefined;
            try {
                const json = readJsonFile(file);
                const data = Array.isArray(json) ? json : Object.entries(json as Record<string, unknown>)
                    .map(([key, value]) => ({ id: Number(key), key, value }));
                return { data, rowNos: data.map(() => 0), label: `${name}.json` };
            } catch {
                return undefined;
            }
        });
    }

    printReport(report, ctx.strict);

    if (!report.pass(ctx.strict)) {
        log(c.red('\n✖ 导表失败，未写入任何文件。'));
        return 1;
    }

    // 与现有 JSON 比对（check 模式下作为失败依据，正常模式下仅提示变更）
    let changed = 0;
    const pending: { schema: TableSchema; file: string; data: unknown }[] = [];
    for (const [name, out] of outputs) {
        const file = path.join(ctx.jsonDir, `${name}.json`);
        let diffCount = -1;
        if (fs.existsSync(file)) {
            const before = readJsonFile(file);
            diffCount = diffJson(before, out.data, 5).count;
        }
        if (diffCount !== 0) changed++;
        pending.push({ schema: out.schema, file, data: out.data });
        if (diffCount > 0) log(c.gray(`  ~ ${name}.json 有 ${diffCount} 处变更`));
    }

    if (ctx.check) {
        log(changed === 0
            ? c.green('\n✔ 校验通过，Excel 与 JSON 完全一致。')
            : c.yellow(`\n⚠ 校验通过，但有 ${changed} 张表与 JSON 不一致（未写盘）。执行 npm run export 可写入。`));
        return changed === 0 ? 0 : 1;
    }

    for (const p of pending) {
        writeJsonFile(p.file, p.data);
    }
    log(c.green(`\n✔ 导表完成：${pending.length} 张表，${changed} 张有变更。`));
    return 0;
}

// ============================ json2excel（首刷/回灌） ============================

async function cmdJson2Excel(ctx: Ctx): Promise<number> {
    log(c.bold('▌生成表格 JSON → Excel'));
    log(c.gray(`  输出目录：${toRootRelative(ctx.excelDir)}`));

    const report = new Report();
    let count = 0;

    for (const schema of ctx.tables) {
        const jsonFile = path.join(ctx.jsonDir, `${schema.name}.json`);
        if (!fs.existsSync(jsonFile)) {
            report.warn(`${schema.name}.json 不存在，跳过`);
            continue;
        }
        const outFile = path.join(ctx.excelDir, schema.excelFile);
        if (fs.existsSync(outFile) && !ctx.force) {
            report.warn(`${schema.excelFile} 已存在，跳过（如需覆盖请加 --force，覆盖会丢弃表格中的手工修改）`);
            continue;
        }
        const res = await jsonToExcel(schema, jsonFile, outFile, report);
        log(`  ${c.green('✔')} ${schema.excelFile.padEnd(24)} ${String(res.rows).padStart(4)} 行  ${c.gray(schema.label)}`);
        count++;
    }

    printReport(report, ctx.strict);
    if (!report.pass(ctx.strict)) {
        log(c.red('\n✖ 生成失败。'));
        return 1;
    }
    log(c.green(`\n✔ 完成：生成 ${count} 个表格文件。`));
    return 0;
}

// ============================ verify（往返自检） ============================

async function cmdVerify(ctx: Ctx): Promise<number> {
    const tmpDir = path.join(TOOL_DIR, '.tmp', 'verify');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    log(c.bold('▌往返自检 JSON → Excel → JSON'));
    log(c.gray(`  临时目录：${toRootRelative(tmpDir)}`));

    let failed = 0;
    const report = new Report();

    try {
        for (const schema of ctx.tables) {
            const jsonFile = path.join(ctx.jsonDir, `${schema.name}.json`);
            if (!fs.existsSync(jsonFile)) {
                report.warn(`${schema.name}.json 不存在，跳过`);
                continue;
            }
            const original = readJsonFile(jsonFile);
            const writeReport = new Report();
            const rows = jsonToRecords(schema, original, writeReport);

            const tmpFile = path.join(tmpDir, schema.excelFile);
            await writeTableFile(schema, rows, tmpFile);

            const readReport = new Report();
            const back = await excelToJson(schema, tmpFile, readReport);

            const local = new Report();
            local.merge(writeReport);
            local.merge(readReport);

            if (!local.ok) {
                log(`  ${c.red('✖')} ${schema.name.padEnd(18)} 编解码报错`);
                printReport(local, ctx.strict);
                report.merge(local);
                failed++;
                continue;
            }

            const d = diffJson(original, back.data, 5);
            if (d.count === 0) {
                log(`  ${c.green('✔')} ${schema.name.padEnd(18)} ${String(back.rows).padStart(4)} 条  往返一致`);
            } else {
                failed++;
                log(`  ${c.red('✖')} ${schema.name.padEnd(18)} ${d.count} 处不一致`);
                for (const line of d.diffs) log('      ' + c.red('· ') + line);
            }
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    printReport(report, ctx.strict);
    if (failed > 0) {
        log(c.red(`\n✖ 自检失败：${failed} 张表往返不一致（说明字段类型配置有损，请检查 schema.ts 的类型）。`));
        return 1;
    }
    log(c.green('\n✔ 自检通过：所有表 JSON ⇄ Excel 往返无损。'));
    return 0;
}

// ============================ list ============================

function cmdList(ctx: Ctx): number {
    for (const t of ctx.tables) {
        log(c.bold(`\n${t.name}.xlsx`) + c.gray(`  →  ${t.jsonPath}  [${t.format === 'kv' ? 'KV 表' : '数组表'}]  主键=${t.primaryKey}`));
        log(c.gray(`  ${t.label}`));
        for (const f of t.fields) {
            const flag = f.required ? c.red('*') : ' ';
            const meta = f.meta ? c.gray('（辅助列，不导出）') : '';
            log(`   ${flag} ${f.key.padEnd(26)} ${c.blue(f.type.padEnd(12))} ${f.desc}${meta}`);
        }
    }
    log(c.gray('\n（* = 必填字段）'));
    return 0;
}

// ============================ help ============================

function cmdHelp(): number {
    log(c.bold('\n集合防御 · 导表工具（tools/excel_export）\n'));
    log('用法：node src/cli.ts <命令> [参数]\n');
    log(c.bold('命令：'));
    log('  excel2json   导表：excel/*.xlsx → assets/resources/tb/*.json（默认命令，可省略）');
    log('  json2excel   生成表格：JSON → excel/*.xlsx（首刷，或 JSON 改动后回灌）');
    log('  verify       往返自检：JSON → Excel → JSON 是否无损');
    log('  list         列出所有表/字段/类型');
    log(c.bold('\n参数：'));
    log('  --table <名[,名]>   只处理指定表，如 --table units,abilities');
    log('  --excel-dir <目录>  表格目录（默认 tools/excel_export/excel）');
    log('  --json-dir <目录>   JSON 目录（默认 assets/resources/tb）');
    log('  --check             只校验不写盘；Excel 与 JSON 不一致时返回码 1');
    log('  --strict            警告也视为失败');
    log('  --force             json2excel 覆盖已存在的表格');
    log('  --no-cross-check    跳过跨表 id 关联校验');
    log(c.bold('\n表格约定：'));
    log('  第 1 行 = 字段名，第 2 行 = 类型，第 3 行 = 中文说明，第 4 行起 = 数据');
    log('  嵌套字段用简写，如 base_attributes = 1:320|2:120（也支持直接粘贴 JSON）');
    log('  详见 README.md');
    return 0;
}

// ============================ 入口 ============================

async function main(): Promise<void> {
    const { command, ctx } = parseCtx();
    const code = await (async (): Promise<number> => {
        switch (command) {
            case 'excel2json':
            case 'export':
                return cmdExcel2Json(ctx);
            case 'json2excel':
            case 'import':
                return cmdJson2Excel(ctx);
            case 'verify':
                return cmdVerify(ctx);
            case 'list':
                return cmdList(ctx);
            case 'help':
                return cmdHelp();
            default:
                log(c.red(`未知命令：${command}`));
                cmdHelp();
                return 2;
        }
    })();
    process.exitCode = code;
}

main().catch(e => {
    log(c.red(`\n✖ 执行异常：${e instanceof Error ? e.message : String(e)}`));
    if (e instanceof Error && e.stack && process.env.DEBUG) log(c.gray(e.stack));
    process.exitCode = 1;
});
