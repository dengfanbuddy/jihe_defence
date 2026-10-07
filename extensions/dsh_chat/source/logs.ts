/**
 * `cocos_logs` 的实现：把工程里的**日志文件**读成事实。
 *
 * ## 为什么要有它
 *
 * 编辑器控制台里那些字，模型看不见：它只能看到自己写的那段代码的 `return`。
 * 于是「引擎抛了异常」「组件在 `onDestroy` 里炸了」「资源导入被拒」这类
 * **只出现在控制台/日志文件里**的事实，过去只能靠人复述 —— 而人复述的往往是结论，不是原文。
 *
 * 这里只做三件事：**找到日志文件 → 按条件筛行 → 原样回（文件路径 + 行号 + 原文）**。
 *
 * ## 三条口径
 *
 * 1. **回事实，不做判断**：不认识"这是哪类 bug"，也不给结论、不建议怎么改。
 *    判断留给调用方（人或工程侧脚本）。
 * 2. **不绑业务**：目录名、文件名、行内容都不带工程语义；换一个 Cocos 工程照样能用。
 *    「哪些目录算日志目录」是一张**通用候选表**（`LOG_DIR_CANDIDATES`），
 *    命中不了就用 `dir` / `files` 显式给。
 * 3. **只读，且读得动就报得出来**：单文件只尾读最后 `LOG_TAIL_BYTES`（默认 2MB）；
 *    目录不存在、文件为空、被编辑器占着读不了 —— 每一种都**如实说**，不静默跳过。
 *
 * ⚠ **写盘只有一个口**：`clear`。它把日志文件**截断成 0 字节**（不是删除 ——
 * Windows 上删除被占用中的文件会失败，而截断可用）。必须同时给 `confirm: 'clear'`，
 * 否则直接拒绝并告诉调用方该传什么。
 *
 * @module dsh_chat/logs
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, truncateSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import type { ToolReply } from './constants';

/**
 * 相对**工程根**去探的日志目录（通用候选，与具体工程无关）。
 *
 * 顺序 = 列表展示顺序（越像日志目录的排越前）；但**全都扫**，不是命中一个就停 ——
 * 不同版本的编辑器把日志放在不同地方，只认第一个等于自己给自己挖坑。
 */
export const LOG_DIR_CANDIDATES = [
    'temp/logs',
    'logs',
    'local/logs',
    'temp/asset-db/log',
    'local',
    'temp',
];

/** 只读这些扩展名的文件：`temp/` 下还有一堆 json / 二进制，读进来只会变成噪声。 */
const LOG_EXTENSIONS = new Set(['.log', '.txt']);

/** 单文件**尾读**上限（字节）。日志可能几百 MB，全读会卡死编辑器主进程。 */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** 单文件默认最多回多少行。 */
const DEFAULT_TAIL_LINES = 200;

/** 单文件行数上限（`tail` 再大也夹到这里）。 */
const MAX_TAIL_LINES = 2000;

/** 一次调用回给模型的字符预算（超了就截断并说明）。 */
const MAX_TEXT_CHARS = 40_000;

/** 一次最多处理多少个文件（按修改时间倒序取最新的这些）。 */
const MAX_FILES = 40;

/** `clear` 必须带的确认口令。 */
export const CLEAR_CONFIRM = 'clear';

/** 一个被扫到的日志文件。 */
interface LogFile {
    /** 绝对路径 */
    path: string;
    /** 展示用编号（`F1` / `F2`…），正文里用它指代，省得每行都印一遍长路径 */
    id: string;
    bytes: number;
    modifiedAt: string;
    /** 实际读进来多少字节（尾读时小于 `bytes`） */
    readBytes: number;
}

/** 一行命中。 */
interface LogHit {
    file: string;
    line: number;
    text: string;
}

/** 一个被扫的目录。 */
interface ScannedDir {
    path: string;
    exists: boolean;
    fileCount: number;
}

/** `readLogs` 的筛选/输出选项（都由工具参数来，这里只做归一化）。 */
interface ReadLogsOptions {
    dir: string;
    files: string[];
    list: boolean;
    tail: number;
    grep: string;
    regex: boolean;
    caseSensitive: boolean;
    since: number | null;
    sinceRaw: string;
    clear: boolean;
    confirm: string;
}

/** 把任意异常收敛成一句话。 */
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 人类可读的字节数。 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 本地时间的 `YYYY-MM-DD HH:mm:ss`。 */
function formatTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

/**
 * 从一行日志里抠出时间戳。
 *
 * 认三种写法（都是各版本编辑器真实出现过的开头）：
 * `[2026-10-06 06:04:49]`、`2026-10-06 06:04:49.123`、`2026-10-06T06:04:49`。
 *
 * @param line - 一行原文。
 * @returns 毫秒时间戳；这行没有可识别的时间戳时回 null（**调用方要按"保留"处理**）。
 */
export function parseLineTime(line: string): number | null {
    const m = /^\s*\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(line);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, ms] = m;
    const ts = new Date(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
        ms ? Number(ms.padEnd(3, '0')) : 0,
    ).getTime();
    return Number.isFinite(ts) ? ts : null;
}

/** `since` 参数：数字（毫秒）或可被 `Date` 解析的字符串；解析不了回 null（并在文案里说明）。 */
function parseSince(raw: string): number | null {
    const text = raw.trim();
    if (!text) return null;
    if (/^\d{10,}$/.test(text)) return Number(text);
    const ts = Date.parse(text);
    return Number.isFinite(ts) ? ts : null;
}

/** 尾读一个文件（最多 `LOG_TAIL_BYTES`），回行数组；读不动时抛。 */
function readTailLines(file: string): { lines: string[]; readBytes: number } {
    const size = statSync(file).size;
    const readBytes = Math.min(size, LOG_TAIL_BYTES);
    if (readBytes === 0) return { lines: [], readBytes: 0 };
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(readBytes);
        const read = readSync(fd, buffer, 0, readBytes, size - readBytes);
        const text = buffer.subarray(0, read).toString('utf8');
        const lines = text.split(/\r?\n/);
        // 尾读是从中间切进去的：第一行可能是半截，只在「确实截断了」时丢掉它
        if (size > readBytes && lines.length > 1) lines.shift();
        return { lines, readBytes: read };
    } finally {
        closeSync(fd);
    }
}

/** 归一化参数（工具侧来的都是 `unknown`）。 */
function normalizeOptions(params: Record<string, unknown>, projectPath: string): ReadLogsOptions {
    const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    const sinceRaw = typeof params.since === 'string' ? params.since : typeof params.since === 'number' ? String(params.since) : '';
    const dirRaw = typeof params.dir === 'string' ? params.dir.trim() : '';
    return {
        dir: dirRaw ? (isAbsolute(dirRaw) ? dirRaw : resolve(projectPath, dirRaw)) : '',
        files: Array.isArray(params.files)
            ? params.files
                  .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
                  .map((v) => (isAbsolute(v) ? v : resolve(projectPath, v)))
            : [],
        list: params.list === true,
        tail: Math.max(1, Math.min(MAX_TAIL_LINES, num(params.tail, DEFAULT_TAIL_LINES))),
        grep: typeof params.grep === 'string' ? params.grep : '',
        regex: params.regex === true,
        caseSensitive: params.caseSensitive === true,
        since: parseSince(sinceRaw),
        sinceRaw,
        clear: params.clear === true,
        confirm: typeof params.confirm === 'string' ? params.confirm : '',
    };
}

/** 造一个筛行器（子串或正则；不区分大小写是默认，因为日志里的大小写往往不一致）。 */
function makeLineFilter(options: ReadLogsOptions): { test: (line: string) => boolean; error?: string } {
    if (!options.grep) return { test: () => true };
    if (options.regex) {
        try {
            const re = new RegExp(options.grep, options.caseSensitive ? '' : 'i');
            return { test: (line) => re.test(line) };
        } catch (error) {
            return { test: () => false, error: `grep 不是合法正则：${describe(error)}` };
        }
    }
    const needle = options.caseSensitive ? options.grep : options.grep.toLowerCase();
    return { test: (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle) };
}

/** 收集要读的文件：显式 `files` 优先，否则按 `dir` / 通用候选目录扫。 */
function collectFiles(
    options: ReadLogsOptions,
    projectPath: string,
): { files: LogFile[]; dirs: ScannedDir[]; problems: string[] } {
    const problems: string[] = [];
    const dirs: ScannedDir[] = [];
    const paths: string[] = [];

    if (options.files.length > 0) {
        for (const file of options.files) {
            if (!existsSync(file)) {
                problems.push(`指定的文件不存在：${file}`);
                continue;
            }
            paths.push(file);
        }
    } else {
        const wanted = options.dir ? [options.dir] : LOG_DIR_CANDIDATES;
        for (const dir of wanted) {
            const abs = options.dir ? dir : join(projectPath, dir);
            const shown = options.dir ? abs : dir;
            let names: string[] = [];
            try {
                if (!existsSync(abs)) {
                    dirs.push({ path: shown, exists: false, fileCount: 0 });
                    continue;
                }
                if (!statSync(abs).isDirectory()) {
                    dirs.push({ path: shown, exists: false, fileCount: 0 });
                    problems.push(`候选路径存在但不是目录（${shown}）`);
                    continue;
                }
                names = readdirSync(abs).filter((name) => {
                    const dot = name.lastIndexOf('.');
                    return dot > 0 && LOG_EXTENSIONS.has(name.slice(dot).toLowerCase());
                });
            } catch (error) {
                dirs.push({ path: shown, exists: true, fileCount: 0 });
                problems.push(`目录读不了（${shown}）：${describe(error)}`);
                continue;
            }
            dirs.push({ path: shown, exists: true, fileCount: names.length });
            for (const name of names) paths.push(join(abs, name));
        }
    }

    const files: LogFile[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        try {
            const stat = statSync(path);
            if (!stat.isFile()) continue;
            files.push({
                path,
                id: '',
                bytes: stat.size,
                modifiedAt: formatTime(stat.mtimeMs),
                readBytes: 0,
            });
        } catch (error) {
            problems.push(`文件读不到元信息（${path}）：${describe(error)}`);
        }
    }

    // 新的在前：日志场景里"最近的"几乎总是最相关的
    files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
    const kept = files.slice(0, MAX_FILES);
    if (files.length > kept.length) {
        problems.push(`日志文件 ${files.length} 个，只处理最新的 ${MAX_FILES} 个（要更多就用 files 显式点名）`);
    }
    kept.forEach((file, index) => {
        file.id = `F${index + 1}`;
    });
    return { files: kept, dirs, problems };
}

/** 清空（截断）给定的日志文件。 */
function clearFiles(files: LogFile[]): { cleared: Array<{ path: string; bytesBefore: number }>; problems: string[] } {
    const cleared: Array<{ path: string; bytesBefore: number }> = [];
    const problems: string[] = [];
    for (const file of files) {
        try {
            truncateSync(file.path, 0);
            cleared.push({ path: file.path, bytesBefore: file.bytes });
        } catch (error) {
            problems.push(`清不掉（${file.path}）：${describe(error)}`);
        }
    }
    return { cleared, problems };
}

/**
 * 读工程里的日志文件（`cocos_logs` 的实现）。
 *
 * @param params - `{dir?, files?, list?, tail?, grep?, regex?, caseSensitive?, since?, clear?, confirm?}`。
 * @returns 工具回执。`text` 是给模型看的「目录 → 文件 → 行」三段事实；`data` 是同内容的结构化版本。
 */
export async function readLogs(params: Record<string, unknown>): Promise<ToolReply> {
    let projectPath = '';
    try {
        projectPath = Editor.Project.path;
    } catch (error) {
        projectPath = '';
    }
    if (!projectPath) {
        return {
            ok: false,
            text: 'cocos_logs：拿不到工程路径（`Editor.Project.path` 不可用），无法定位日志目录。可以改用 `files` 给绝对路径。',
            error: '拿不到工程路径',
        };
    }

    const options = normalizeOptions(params, projectPath);
    const notes: string[] = [];
    if (options.sinceRaw && options.since === null) {
        notes.push(`\`since\` 解析不了（${options.sinceRaw}），这一条被忽略 —— 认 ISO 时间或毫秒时间戳。`);
    }

    const { files, dirs, problems } = collectFiles(options, projectPath);

    // ---- 清空：唯一一个写盘口，必须显式确认 ----
    if (options.clear) {
        if (options.confirm !== CLEAR_CONFIRM) {
            return {
                ok: false,
                text:
                    `cocos_logs 要清空日志得显式确认：` +
                    `cocos_logs({ clear: true, confirm: "${CLEAR_CONFIRM}" })` +
                    `（会把文件**截断成 0 字节**，不是删掉）` +
                    (files.length > 0 ? `。本次会清 ${files.length} 个文件：\n${files.map((f) => `- ${f.path}（${formatBytes(f.bytes)}）`).join('\n')}` : '。'),
                error: 'clear 缺少 confirm',
                data: { projectPath, files: files.map((f) => f.path) },
            };
        }
        const { cleared, problems: clearProblems } = clearFiles(files);
        const lines = [
            `已清空 ${cleared.length} 个日志文件（截断成 0 字节）：`,
            ...cleared.map((item) => `- ${item.path}（原 ${formatBytes(item.bytesBefore)}）`),
        ];
        const allProblems = [...problems, ...clearProblems];
        if (allProblems.length > 0) lines.push('', '⚠ 有问题：', ...allProblems.map((line) => `- ${line}`));
        return {
            ok: cleared.length > 0,
            text: lines.join('\n'),
            error: cleared.length > 0 ? undefined : '没有清掉任何文件',
            data: { projectPath, cleared, problems: allProblems },
        };
    }

    // ---- 列文件：定位"日志到底在哪"这一步单独给一个档 ----
    const header: string[] = [`工程：${projectPath}`, `扫到的目录（${dirs.length} 个）：`];
    for (const dir of dirs) {
        header.push(`- ${dir.exists ? '✓' : '✗'} ${dir.path}${dir.exists ? `（${dir.fileCount} 个日志文件）` : '（不存在）'}`);
    }
    if (dirs.length === 0) header.push('- （用了 files 参数，没有扫目录）');

    if (files.length === 0) {
        const text = [
            ...header,
            '',
            '没有可读的日志文件。',
            '可能的原因：编辑器还没写过日志（`project.log` 存在但为 0 字节是正常的）；',
            '或日志在别处 —— 用 `dir`（一个绝对目录）或 `files`（若干绝对文件路径）直接点名。',
            ...(problems.length > 0 ? ['', '⚠ 过程中的问题：', ...problems.map((line) => `- ${line}`)] : []),
        ].join('\n');
        return { ok: false, text, error: '没有找到日志文件', data: { projectPath, dirs, files: [], problems } };
    }

    if (options.list) {
        const text = [
            ...header,
            '',
            `日志文件 ${files.length} 个（按修改时间倒序）：`,
            ...files.map((file) => `- ${file.id} ${file.path}  ${formatBytes(file.bytes)}  ${file.modifiedAt}`),
            ...(problems.length > 0 ? ['', '⚠ 过程中的问题：', ...problems.map((line) => `- ${line}`)] : []),
        ].join('\n');
        return { ok: true, text, data: { projectPath, dirs, files, problems } };
    }

    // ---- 读行 + 筛行 ----
    const filter = makeLineFilter(options);
    if (filter.error) {
        return {
            ok: false,
            text: `cocos_logs：${filter.error}\n（把 regex 关掉就是按子串找，特殊字符不用转义。）`,
            error: filter.error,
            data: { projectPath, dirs, files: files.map((f) => f.path) },
        };
    }

    const hits: LogHit[] = [];
    const fileStats: Array<{ file: LogFile; matched: number; shown: number; skipped?: string; error?: string }> = [];
    let truncatedText = false;

    for (const file of files) {
        if (options.since !== null && new Date(file.modifiedAt.replace(' ', 'T')).getTime() < options.since) {
            /**
             * 文件整体比 `since` 还旧 ⇒ 里面不可能有更新的行。
             * 用**文件修改时间**先筛一刀是安全的：日志只会往后追加。
             */
            fileStats.push({ file, matched: 0, shown: 0, skipped: `最后修改时间早于 since` });
            continue;
        }
        let lines: string[] = [];
        try {
            const read = readTailLines(file.path);
            lines = read.lines;
            file.readBytes = read.readBytes;
        } catch (error) {
            fileStats.push({ file, matched: 0, shown: 0, error: describe(error) });
            continue;
        }

        const matched: LogHit[] = [];
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!filter.test(line)) continue;
            if (options.since !== null) {
                const ts = parseLineTime(line);
                // 行里没有时间戳就**保留**（宁可多给一行，也不要因为格式不认识而漏掉现场）
                if (ts !== null && ts < options.since) continue;
            }
            matched.push({ file: file.id, line: i + 1, text: line });
        }
        const shown = matched.slice(-options.tail);
        fileStats.push({ file, matched: matched.length, shown: shown.length });
        hits.push(...shown);
    }

    // ---- 组装文案（按文件分组，行号是**该文件里的行号**）----
    const body: string[] = [];
    let chars = 0;
    for (const stat of fileStats) {
        const mine = hits.filter((hit) => hit.file === stat.file.id);
        const suffix = stat.error
            ? `读失败：${stat.error}`
            : stat.skipped
              ? `跳过：${stat.skipped}`
              : `命中 ${stat.matched} 行${stat.shown < stat.matched ? `，只显示最后 ${stat.shown} 行` : ''}`;
        const tailed = stat.file.bytes > LOG_TAIL_BYTES && stat.file.readBytes > 0 ? ' 〔已尾读〕' : '';
        body.push(`${stat.file.id} ${stat.file.path}  ${formatBytes(stat.file.bytes)}  ${stat.file.modifiedAt}  ${suffix}${tailed}`);
        for (const hit of mine) {
            const line = `${stat.file.id}:${hit.line}  ${hit.text}`;
            if (chars + line.length > MAX_TEXT_CHARS) {
                truncatedText = true;
                break;
            }
            chars += line.length + 1;
            body.push(line);
        }
        if (truncatedText) break;
        body.push('');
    }

    const tailNotes: string[] = [];
    if (truncatedText) tailNotes.push(`正文超过 ${MAX_TEXT_CHARS} 字符预算，后面的行没回（缩小 grep 或调小 tail 再试）`);
    if (files.some((file) => file.bytes > LOG_TAIL_BYTES)) {
        tailNotes.push(`有文件大于 ${formatBytes(LOG_TAIL_BYTES)}，只读了**尾部**（行号是尾读窗口内的行号，不是全文件行号）`);
    }
    if (options.grep) tailNotes.push(`筛选：${options.regex ? '正则' : '子串'} / ${options.caseSensitive ? '区分大小写' : '不区分大小写'}`);
    const totalMatched = fileStats.reduce((sum, stat) => sum + stat.matched, 0);
    if (totalMatched === 0) tailNotes.push('没有任何行命中筛选条件（文件是读到了的，见上面每个文件的命中数）');

    const text = [
        ...header,
        '',
        `日志文件 ${files.length} 个，命中 ${totalMatched} 行：`,
        '',
        ...body,
        ...(tailNotes.length > 0 ? ['⚠ 说明：', ...tailNotes.map((line) => `- ${line}`)] : []),
        ...(problems.length > 0 || notes.length > 0
            ? ['', '⚠ 其他：', ...[...notes, ...problems].map((line) => `- ${line}`)]
            : []),
    ].join('\n');

    return {
        ok: true,
        text,
        data: {
            projectPath,
            dirs,
            files: fileStats.map((stat) => ({
                id: stat.file.id,
                path: stat.file.path,
                bytes: stat.file.bytes,
                readBytes: stat.file.readBytes,
                modifiedAt: stat.file.modifiedAt,
                matched: stat.matched,
                shown: stat.shown,
                ...(stat.skipped ? { skipped: stat.skipped } : {}),
                ...(stat.error ? { error: stat.error } : {}),
            })),
            matches: hits,
            truncated: truncatedText,
            problems,
        },
    };
}
