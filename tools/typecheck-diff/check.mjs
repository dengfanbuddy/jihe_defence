#!/usr/bin/env node
/**
 * check.mjs —— TypeScript 全量类型检查的「可比对基线」门禁
 *
 * 回答的问题：**「这次改动，有没有引入新的类型错误？」**
 *
 * 为什么不直接用 `tsc --noEmit` 当门禁：本工程根目录全量 tsc 有 ~249 条历史错误
 * （噪声来自 `tools/excel_export/**` 的 TS5097/TS2591、旧 `platform/**` 的 TS2550、
 * 引擎声明 `@types/jsb.d.ts`·`cc.d.ts` 的 TS2304/TS2314 等），所以裸 tsc 的退出码
 * **恒为红**，它区分不出「这次改坏的类型」和「三个月前就存在的类型」。
 *
 * 本脚本的做法：把「当前错误集合」与基线文件**按整行文本**（不做模糊匹配）比对 ——
 *   · 新增 = 当前 − 基线 → **失败**（退出码 1）
 *   · 消失 = 基线 − 当前 → **只报告，不算失败**（但通常意味着基线该更新了）
 *
 * 用法：
 *   node tools/typecheck-diff/check.mjs                  # 比对基线
 *   node tools/typecheck-diff/check.mjs --update         # 用当前错误全量重写基线（唯一写盘入口）
 *   node tools/typecheck-diff/check.mjs --json           # 结构化输出到 stdout（人读信息改走 stderr）
 *   node tools/typecheck-diff/check.mjs --filter <子串>  # 只打印路径含该子串的错误（不影响退出码口径）
 *   node tools/typecheck-diff/check.mjs --timeout 900000 # 单次 tsc 超时（毫秒，默认 15 分钟）
 *
 * 退出码：
 *   0 = 没有新增错误
 *   1 = 有新增错误
 *   2 = 环境问题（找不到 tsc / tsc 崩溃超时 / 基线不存在 / 出现无位置的配置级错误）
 *       —— **"跑不动"一律算 2，绝不当成"全绿"**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ===================================================================
 * 常量
 * =================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 工程根（= tools/typecheck-diff/../..），所有相对路径都以它为基准 */
const ROOT = path.resolve(HERE, '../..');
/** 基线文件：普通文本、一行一条规范化错误、按「路径 + 行号」排序，可入库可 diff */
const BASELINE_PATH = path.join(HERE, 'baseline.txt');

/**
 * tsc 入口候选（用绝对路径直接喂给 node 执行，**不走 npx**，避免联网/自动安装）。
 * 前两个是工程根本地依赖，后两个是导表工具自带的副本（根目录没装时兜底）。
 */
const TSC_CANDIDATES = [
    'node_modules/typescript/bin/tsc',
    'node_modules/typescript/lib/tsc.js',
    'tools/excel_export/node_modules/typescript/bin/tsc',
    'tools/excel_export/node_modules/typescript/lib/tsc.js',
];

/** 单次 tsc 默认超时（毫秒）。全量检查实测仅数秒，15 分钟足够容纳冷启动/杀毒扫描 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * tsc 输出上限（当前全量输出约 100 KB）。
 * 输出不是走管道而是**重定向到普通文件**（见 `openSink`），所以理论上不会被截断；
 * 这个上限只用来兜住"输出大到不像正常校验结果"的异常情况 —— 超了算环境问题，不算全绿。
 */
const MAX_BUFFER = 64 * 1024 * 1024;
/** 报告里「新增/消失」明细最多打印多少条（超过只提示，避免刷屏） */
const MAX_PRINT = 200;

/** 主格式：`路径(行,列): error TSxxxx: 消息`（`路径` lazy 匹配，兼容路径里带括号/冒号） */
const ERROR_RE = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.*)$/;
/** 无位置的配置级错误：`error TSxxxx: 消息`（tsconfig 读不到、no inputs 之类 —— 校验根本没按预期跑） */
const CONFIG_ERROR_RE = /^error (?<code>TS\d+): (?<msg>.*)$/;

/* ===================================================================
 * 参数与日志
 * =================================================================== */

/**
 * 解析命令行参数。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{update:boolean, json:boolean, filter:string|null, timeoutMs:number, help:boolean}}
 */
function parseArgs(argv) {
    const opts = { update: false, json: false, filter: null, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--update') opts.update = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--filter') {
            opts.filter = argv[++i] ?? '';
            if (!opts.filter) throw new Error('--filter 后面要跟一个子串');
        } else if (a.startsWith('--filter=')) {
            opts.filter = a.slice('--filter='.length);
        } else if (a === '--timeout') {
            const ms = Number(argv[++i]);
            if (!Number.isFinite(ms) || ms <= 0) throw new Error('--timeout 后面要跟一个正整数毫秒数');
            opts.timeoutMs = ms;
        } else if (a.startsWith('--timeout=')) {
            const ms = Number(a.slice('--timeout='.length));
            if (!Number.isFinite(ms) || ms <= 0) throw new Error('--timeout 后面要跟一个正整数毫秒数');
            opts.timeoutMs = ms;
        } else {
            throw new Error(`不认识的参数：${a}`);
        }
    }
    return opts;
}

/** `--json` 模式下人读信息改走 stderr，保证 stdout 是一份可直接 `JSON.parse` 的纯 JSON */
let humanToStderr = false;
/** 人读日志（进度/摘要） */
function log(line = '') {
    if (humanToStderr) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
}
/** 错误日志（永远走 stderr） */
function errlog(line = '') {
    process.stderr.write(`${line}\n`);
}

const HELP_TEXT = [
    '用法：node tools/typecheck-diff/check.mjs [选项]',
    '',
    '  （无选项）            比对基线：出现「基线里没有的错误」→ 退出码 1',
    '  --update              把当前错误全量写成新基线（唯一写盘入口）',
    '  --json                结构化输出到 stdout（人读信息走 stderr）',
    '  --filter <子串>       只打印路径含该子串的错误（诊断用，不改变退出码口径）',
    '  --timeout <毫秒>      单次 tsc 超时（默认 900000）',
    '  -h, --help            显示本帮助',
    '',
    '退出码：0 = 无新增错误；1 = 有新增错误；2 = 环境问题（跑不动，绝不当成全绿）',
].join('\n');

/* ===================================================================
 * 规范化
 * =================================================================== */

/**
 * 把一条 tsc 输出行归一成**稳定的一行文本**。
 * 归一内容：① Windows 反斜杠 → `/`；② 工程根内的绝对路径 → 相对工程根的 `/` 路径
 * （工程根外的绝对路径保持原样，例如引擎声明 `C:/ProgramData/cocos/...`，跨盘符没法相对化）；
 * ③ 消息里的连续空白折叠成一个空格并去首尾空白。
 * @param {string} rawLine 原始输出行（未 trim）
 * @returns {{path:string, line:number, col:number, code:string, msg:string, text:string}|null}
 *          不是错误行（相关提示行、空行）返回 null
 */
function normalizeLine(rawLine) {
    const line = rawLine.replace(/\r$/, '');
    const m = ERROR_RE.exec(line);
    if (!m) return null;
    const filePath = normalizePath(m.groups.file);
    const lineNo = Number(m.groups.line);
    const colNo = Number(m.groups.col);
    const code = m.groups.code;
    const msg = m.groups.msg.replace(/\s+/g, ' ').trim();
    return { path: filePath, line: lineNo, col: colNo, code, msg, text: `${filePath}(${lineNo},${colNo}): error ${code}: ${msg}` };
}

/**
 * 路径归一：统一 `/`，工程根内的绝对路径转成相对工程根的路径。
 * @param {string} p 原始路径
 * @returns {string} 归一后的路径
 */
function normalizePath(p) {
    let s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!s) return s;
    // 绝对路径（含 `C:/...`）：工程根内相对化，根外保持原样（跨盘符无法相对化）
    const abs = path.resolve(ROOT, s);
    if (path.isAbsolute(s) && isInside(ROOT, abs)) return relPosix(abs);
    if (!path.isAbsolute(s) && isInside(ROOT, abs)) return relPosix(abs);
    return s;
}

/** 绝对路径是否落在某目录内（`path.relative` 不以 `..` 开头即视为在内） */
function isInside(dir, abs) {
    const r = path.relative(dir, abs);
    return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}
/** 绝对路径 → 相对工程根的 `/` 路径 */
function relPosix(abs) {
    return path.relative(ROOT, abs).replace(/\\/g, '/');
}

/**
 * 记录排序：先路径（字节序，保证跨机器稳定）、再行号、再列号、再错误码。
 * @param {{path:string,line:number,col:number,code:string,text:string}} a
 * @param {{path:string,line:number,col:number,code:string,text:string}} b
 */
function compareRecord(a, b) {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.col !== b.col) return a.col - b.col;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.text === b.text) return 0;
    return a.text < b.text ? -1 : 1;
}

/**
 * 解析 tsc 原始输出，得到去重排序后的错误记录与配置级错误。
 * @param {string} raw tsc 的 stdout + stderr
 * @returns {{errors:Array<object>, configErrors:string[]}}
 */
function parseOutput(raw) {
    const errors = [];
    const configErrors = [];
    const seen = new Set();
    for (const rawLine of raw.split(/\r?\n/)) {
        const rec = normalizeLine(rawLine);
        if (rec) {
            if (!seen.has(rec.text)) {
                seen.add(rec.text);
                errors.push(rec);
            }
            continue;
        }
        const cfg = CONFIG_ERROR_RE.exec(rawLine.replace(/\r$/, ''));
        if (cfg) configErrors.push(`${rawLine.replace(/\r$/, '').trim()}`);
    }
    errors.sort(compareRecord);
    return { errors, configErrors };
}

/* ===================================================================
 * 基线读写
 * =================================================================== */

/**
 * 读取基线文件。
 * @returns {{exists:boolean, records:Array<object>, texts:Set<string>}}
 */
function readBaseline() {
    if (!fs.existsSync(BASELINE_PATH)) return { exists: false, records: [], texts: new Set() };
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    const records = [];
    const texts = new Set();
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;                       // 空行忽略（含文件末尾换行）
        if (texts.has(t)) continue;             // 手改基线造成重复行时按一条算
        texts.add(t);
        const rec = normalizeLine(t);
        records.push(rec || { path: t, line: 0, col: 0, code: '', msg: '', text: t });
    }
    records.sort(compareRecord);
    return { exists: true, records, texts };
}

/**
 * 写基线文件（唯一写盘入口）。`\n` 换行、UTF-8、无 BOM、末尾一个换行。
 * @param {Array<object>} records 已排序的错误记录
 */
function writeBaseline(records) {
    fs.mkdirSync(HERE, { recursive: true });
    const body = records.map((r) => r.text).join('\n');
    fs.writeFileSync(BASELINE_PATH, records.length ? `${body}\n` : '', 'utf8');
}

/* ===================================================================
 * 跑 tsc
 * =================================================================== */

/**
 * 找一个可用的 tsc 入口。
 * @returns {string|null} 绝对路径
 */
function resolveTsc() {
    if (process.env.TYPECHECK_TSC && fs.existsSync(process.env.TYPECHECK_TSC)) return process.env.TYPECHECK_TSC;
    for (const rel of TSC_CANDIDATES) {
        const abs = path.join(ROOT, rel);
        if (fs.existsSync(abs)) return abs;
    }
    return null;
}

/**
 * 打开一个"接住子进程输出"的落盘文件描述符。
 *
 * 为什么不用管道（`stdio: 'pipe'`）：① 管道有 `maxBuffer` 上限，超了会被截断 ——
 * 截断的校验输出会变成"错误少了"，也就是**假的绿**；② 受限沙箱环境里进程间命名管道可能被拒
 * （实测本机受限模式下 `spawnSync(..., {stdio:'pipe'})` 直接 EPERM，而**写普通文件的 fd 正常**）。
 * 所以这里统一把 tsc 的 stdout/stderr 重定向到一个临时普通文件，跑完读回来、立刻删掉。
 *
 * @returns {{fd:number, file:string, cleanup:() => void}|null} 打不开任何候选目录时返回 null
 */
function openSink() {
    const stamp = `${process.pid}-${Date.now()}`;
    for (const dir of [os.tmpdir(), HERE]) {
        const file = path.join(dir, `.typecheck-diff-${stamp}.log`);
        try {
            const fd = fs.openSync(file, 'w');
            return { fd, file, cleanup: () => { try { fs.rmSync(file, { force: true }); } catch { /* 删不掉不影响结论 */ } } };
        } catch {
            // 换下一个候选目录
        }
    }
    return null;
}

/**
 * 跑一次全量 `tsc --noEmit`。
 *
 * 三个刻意的选择：
 *   ① **用 `process.execPath` + 绝对路径**执行 tsc —— 不用 `npx`（npx 在缺包时会联网安装）；
 *   ② 显式 `--pretty false` —— 管道/文件里 tsc 本来就不上色，但显式关掉才能保证输出**一行一条**，
 *      否则彩色/折叠模式下解析不到任何 `error TS` 行，会被误判成"全绿"；
 *   ③ 输出重定向到普通文件而不是管道，见 `openSink`。
 *
 * @param {string} tscPath tsc 入口绝对路径
 * @param {number} timeoutMs 超时毫秒
 * @returns {{ok:boolean, problem:string|null, errors:Array<object>, configErrors:string[],
 *            exitCode:number|null, signal:string|null, elapsedMs:number, stdoutTail:string}}
 */
function runTsc(tscPath, timeoutMs) {
    const started = Date.now();
    const sink = openSink();
    if (!sink) {
        return {
            ok: false, problem: '既写不了系统临时目录、也写不了 tools/typecheck-diff/，无法接住 tsc 输出',
            errors: [], configErrors: [], exitCode: null, signal: null, elapsedMs: 0, stdoutTail: '',
        };
    }
    let res;
    try {
        res = spawnSync(process.execPath, [tscPath, '--noEmit', '--pretty', 'false'], {
            cwd: ROOT,
            stdio: ['ignore', sink.fd, sink.fd],
            timeout: timeoutMs,
            windowsHide: true,
        });
    } finally {
        fs.closeSync(sink.fd);
    }
    const elapsedMs = Date.now() - started;
    let raw = '';
    let readProblem = null;
    try {
        const st = fs.statSync(sink.file);
        if (st.size > MAX_BUFFER) {
            readProblem = `tsc 输出 ${(st.size / 1048576).toFixed(1)} MB，超过 ${MAX_BUFFER / 1048576} MB 上限`;
        } else {
            raw = fs.readFileSync(sink.file, 'utf8');
        }
    } catch (e) {
        readProblem = `读不到 tsc 输出文件：${e.message}`;
    }
    sink.cleanup();

    const parsed = parseOutput(raw);
    const fail = (problem) => ({
        ok: false, problem, errors: parsed.errors, configErrors: parsed.configErrors,
        exitCode: res.status, signal: res.signal || null, elapsedMs, stdoutTail: tail(raw),
    });

    if (res.error) {
        const code = /** @type {NodeJS.ErrnoException} */ (res.error).code;
        if (code === 'ETIMEDOUT') return fail(`tsc 超过 ${Math.round(timeoutMs / 1000)} 秒没跑完（--timeout 可调大）`);
        return fail(`tsc 进程启动失败：${res.error.message}`);
    }
    if (res.signal) return fail(`tsc 被信号终止（${res.signal}）`);
    if (res.status === null || res.status === undefined) return fail('tsc 没有返回退出码（进程异常退出）');
    if (readProblem) return fail(readProblem);
    // 一条 `error TS` 都没解析到、退出码却非 0 → 校验根本没跑起来（例如 tsconfig 坏掉）。
    // 注意：有错误时 tsc 自己的退出码本来就是 1 或 2，所以这里必须"先看有没有解析到错误"。
    if (parsed.errors.length === 0 && res.status !== 0) {
        return fail(`tsc 退出码 ${res.status} 且输出里没有任何 "error TS" 行 —— 校验没跑起来`);
    }
    return {
        ok: true, problem: null, errors: parsed.errors, configErrors: parsed.configErrors,
        exitCode: res.status, signal: null, elapsedMs, stdoutTail: tail(raw),
    };
}

/** 取输出末尾若干行（环境问题报告用） */
function tail(raw, lines = 12) {
    const arr = raw.split(/\r?\n/).filter((l) => l.trim());
    return arr.slice(-lines).join('\n');
}

/* ===================================================================
 * 主流程
 * =================================================================== */

/** 人读的标题行 */
function banner(title) {
    log('');
    log(`▌${title}`);
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        errlog(`✘ 参数错误：${e.message}`);
        errlog('');
        errlog(HELP_TEXT);
        return 2;
    }
    if (opts.help) {
        log(HELP_TEXT);
        return 0;
    }
    humanToStderr = opts.json;

    /** @type {Record<string, any>} */
    const report = {
        tool: 'typecheck-diff',
        ok: false,
        exitCode: 2,
        projectRoot: ROOT,
        tsc: null,
        baseline: { path: path.relative(ROOT, BASELINE_PATH).replace(/\\/g, '/'), count: 0, updated: false, existedBefore: false },
        currentCount: 0,
        newCount: 0,
        fixedCount: 0,
        filter: opts.filter,
        newErrors: [],
        fixedErrors: [],
        configErrors: [],
        environment: null,
    };
    /** 环境问题收口：报告 + 退出码 2 */
    const envFail = (message, detail = '') => {
        report.environment = { message, detail };
        report.ok = false;
        report.exitCode = 2;
        banner('环境问题');
        log(`  ✘ ${message}`);
        if (detail) for (const l of detail.split('\n')) log(`    │ ${l}`);
        log('');
        log(`✘ 环境问题 —— 本次没有得出"有没有新增类型错误"的结论（退出码 2）`);
        emitJson(opts, report);
        return 2;
    };

    // ---- ① 环境准备 ----
    banner('类型检查基线比对（tools/typecheck-diff）');
    const tscPath = resolveTsc();
    log(`  · 工程根 : ${ROOT}`);
    if (!tscPath) {
        report.tsc = { path: null };
        return envFail(
            '找不到 tsc（依次找过：' + TSC_CANDIDATES.join(' / ') + '）',
            '请先在工程根安装 typescript 依赖；本脚本刻意不用 npx，避免联网自动安装。',
        );
    }
    log(`  · tsc    : ${path.relative(ROOT, tscPath).replace(/\\/g, '/')}`);
    report.tsc = { path: path.relative(ROOT, tscPath).replace(/\\/g, '/') };

    const baseline = readBaseline();
    report.baseline.existedBefore = baseline.exists;
    report.baseline.count = baseline.records.length;
    const baselineShown = path.relative(ROOT, BASELINE_PATH).replace(/\\/g, '/');
    // 首次运行：基线不存在 → **不自动写**，明确要求先跑 --update
    if (!baseline.exists && !opts.update) {
        return envFail(
            `基线不存在：${baselineShown} —— 先跑 --update 生成基线`,
            '（基线不会被自动创建：否则"第一次跑就全绿"会掩盖掉所有历史错误。）',
        );
    }
    log(`  · 基线   : ${baselineShown}（${baseline.exists ? `${baseline.records.length} 条` : '不存在，本次将由 --update 创建'}）`);
    log(`  · 开始全量 \`tsc --noEmit\`（实测数秒~数分钟，请稍候）…`);

    // ---- ② 跑全量 tsc ----
    const run = runTsc(tscPath, opts.timeoutMs);
    const elapsedSec = (run.elapsedMs / 1000).toFixed(1);
    report.tsc.exitCode = run.exitCode;
    report.tsc.elapsedMs = run.elapsedMs;
    report.configErrors = run.configErrors;
    if (!run.ok) {
        return envFail(`tsc 没跑成功（耗时 ${elapsedSec} 秒）：${run.problem}`, run.stdoutTail);
    }
    log(`  ✔ 全量检查完成，耗时 ${elapsedSec} 秒（tsc 退出码 ${run.exitCode}，错误 ${run.errors.length} 条）`);
    // 无位置的配置级错误：tsc 没按预期跑 → 环境问题（不允许当成"没新增错误"放行）
    if (run.configErrors.length) {
        return envFail(
            `tsc 报出 ${run.configErrors.length} 条无位置的配置级错误 —— 校验没按预期跑`,
            run.configErrors.join('\n'),
        );
    }
    report.currentCount = run.errors.length;

    // ---- ③ --update：用当前错误全量重写基线（唯一写盘入口） ----
    if (opts.update) {
        const currentTexts = new Set(run.errors.map((r) => r.text));
        const added = run.errors.filter((r) => !baseline.texts.has(r.text)).length;
        const removed = baseline.records.filter((r) => !currentTexts.has(r.text)).length;
        writeBaseline(run.errors);
        report.baseline.updated = true;
        report.baseline.count = run.errors.length;
        report.newCount = added;
        report.fixedCount = removed;
        report.ok = true;
        report.exitCode = 0;
        banner('基线已更新');
        log(`  ✔ 写入 ${baselineShown}：${baseline.records.length} 条 → ${run.errors.length} 条`);
        log('');
        if (!report.baseline.existedBefore) {
            log(`✔ 首次建立基线：当前 ${run.errors.length} 条历史错误全部并入（退出码 0）`);
        } else {
            log(`✔ 基线 ${baseline.records.length} 条 → 当前 ${run.errors.length} 条`
                + `（并入新增 ${added} 条 / 剔除消失 ${removed} 条）—— --update 不判失败（退出码 0）`);
        }
        emitJson(opts, report);
        return 0;
    }

    // ---- ④ 比对：新增 = 当前 − 基线；消失 = 基线 − 当前 ----
    const currentTexts = new Set(run.errors.map((r) => r.text));
    const newRecords = run.errors.filter((r) => !baseline.texts.has(r.text));
    const fixedRecords = baseline.records.filter((r) => !currentTexts.has(r.text));
    report.newErrors = newRecords.map((r) => r.text);
    report.fixedErrors = fixedRecords.map((r) => r.text);
    report.newCount = newRecords.length;
    report.fixedCount = fixedRecords.length;
    report.ok = newRecords.length === 0;
    report.exitCode = newRecords.length === 0 ? 0 : 1;

    // `--filter` 只影响打印，不改退出码口径
    const hitFilter = (r) => !opts.filter || r.path.includes(opts.filter);
    const printNew = newRecords.filter(hitFilter);
    const printFixed = fixedRecords.filter(hitFilter);
    const filterNote = opts.filter ? `（--filter ${opts.filter}：只影响打印，退出码按全量算）` : '';

    if (newRecords.length) {
        banner(`新增错误${filterNote}`);
        for (const r of printNew.slice(0, MAX_PRINT)) log(`  ✘ ${r.text}`);
        if (printNew.length > MAX_PRINT) log(`  · 还有 ${printNew.length - MAX_PRINT} 条未打印（见 --json 全量输出）`);
        if (!printNew.length) log(`  · 共 ${newRecords.length} 条新增，但都不含子串 "${opts.filter}"（去掉 --filter 可看全部）`);
    }
    if (fixedRecords.length) {
        banner(`已消失的错误${filterNote}（基线里有、本次没出现 —— 不算失败，但通常意味着基线该更新了）`);
        for (const r of printFixed.slice(0, MAX_PRINT)) log(`  · ${r.text}`);
        if (printFixed.length > MAX_PRINT) log(`  · 还有 ${printFixed.length - MAX_PRINT} 条未打印（见 --json 全量输出）`);
        if (!printFixed.length) log(`  · 共 ${fixedRecords.length} 条消失，但都不含子串 "${opts.filter}"`);
    }

    banner('摘要');
    const summary = `基线 ${baseline.records.length} 条 → 当前 ${run.errors.length} 条 → 新增 ${newRecords.length} 条`
        + `（已消失 ${fixedRecords.length} 条）`;
    log('');
    if (newRecords.length) {
        log(`✘ ${summary} —— 存在基线里没有的错误（退出码 1）`);
        log('  · 处理：改代码修掉；确认是"合理的新错误"再跑 --update 并入基线');
    } else {
        log(`✔ ${summary} —— 没有基线之外的新错误（退出码 0）`);
        if (fixedRecords.length) log('  · 提示：有错误消失了，基线该更新了 → node tools/typecheck-diff/check.mjs --update');
    }
    emitJson(opts, report);
    return report.exitCode;
}

/** `--json` 时把报告打到 stdout（纯 JSON，人读信息已在 stderr） */
function emitJson(opts, report) {
    if (!opts.json) return;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().then((code) => {
    process.exitCode = code;
}).catch((e) => {
    errlog(`✘ 脚本自身异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 2;
});
