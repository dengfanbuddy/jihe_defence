"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLEAR_CONFIRM = exports.LOG_DIR_CANDIDATES = void 0;
exports.parseLineTime = parseLineTime;
exports.readLogs = readLogs;
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * 相对**工程根**去探的日志目录（通用候选，与具体工程无关）。
 *
 * 顺序 = 列表展示顺序（越像日志目录的排越前）；但**全都扫**，不是命中一个就停 ——
 * 不同版本的编辑器把日志放在不同地方，只认第一个等于自己给自己挖坑。
 */
exports.LOG_DIR_CANDIDATES = [
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
const MAX_TEXT_CHARS = 40000;
/** 一次最多处理多少个文件（按修改时间倒序取最新的这些）。 */
const MAX_FILES = 40;
/** `clear` 必须带的确认口令。 */
exports.CLEAR_CONFIRM = 'clear';
/** 把任意异常收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 人类可读的字节数。 */
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** 本地时间的 `YYYY-MM-DD HH:mm:ss`。 */
function formatTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
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
function parseLineTime(line) {
    const m = /^\s*\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(line);
    if (!m)
        return null;
    const [, y, mo, d, h, mi, s, ms] = m;
    const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms ? Number(ms.padEnd(3, '0')) : 0).getTime();
    return Number.isFinite(ts) ? ts : null;
}
/** `since` 参数：数字（毫秒）或可被 `Date` 解析的字符串；解析不了回 null（并在文案里说明）。 */
function parseSince(raw) {
    const text = raw.trim();
    if (!text)
        return null;
    if (/^\d{10,}$/.test(text))
        return Number(text);
    const ts = Date.parse(text);
    return Number.isFinite(ts) ? ts : null;
}
/** 尾读一个文件（最多 `LOG_TAIL_BYTES`），回行数组；读不动时抛。 */
function readTailLines(file) {
    const size = (0, fs_1.statSync)(file).size;
    const readBytes = Math.min(size, LOG_TAIL_BYTES);
    if (readBytes === 0)
        return { lines: [], readBytes: 0 };
    const fd = (0, fs_1.openSync)(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(readBytes);
        const read = (0, fs_1.readSync)(fd, buffer, 0, readBytes, size - readBytes);
        const text = buffer.subarray(0, read).toString('utf8');
        const lines = text.split(/\r?\n/);
        // 尾读是从中间切进去的：第一行可能是半截，只在「确实截断了」时丢掉它
        if (size > readBytes && lines.length > 1)
            lines.shift();
        return { lines, readBytes: read };
    }
    finally {
        (0, fs_1.closeSync)(fd);
    }
}
/** 归一化参数（工具侧来的都是 `unknown`）。 */
function normalizeOptions(params, projectPath) {
    const num = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    const sinceRaw = typeof params.since === 'string' ? params.since : typeof params.since === 'number' ? String(params.since) : '';
    const dirRaw = typeof params.dir === 'string' ? params.dir.trim() : '';
    return {
        dir: dirRaw ? ((0, path_1.isAbsolute)(dirRaw) ? dirRaw : (0, path_1.resolve)(projectPath, dirRaw)) : '',
        files: Array.isArray(params.files)
            ? params.files
                .filter((v) => typeof v === 'string' && v.trim() !== '')
                .map((v) => ((0, path_1.isAbsolute)(v) ? v : (0, path_1.resolve)(projectPath, v)))
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
function makeLineFilter(options) {
    if (!options.grep)
        return { test: () => true };
    if (options.regex) {
        try {
            const re = new RegExp(options.grep, options.caseSensitive ? '' : 'i');
            return { test: (line) => re.test(line) };
        }
        catch (error) {
            return { test: () => false, error: `grep 不是合法正则：${describe(error)}` };
        }
    }
    const needle = options.caseSensitive ? options.grep : options.grep.toLowerCase();
    return { test: (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle) };
}
/** 收集要读的文件：显式 `files` 优先，否则按 `dir` / 通用候选目录扫。 */
function collectFiles(options, projectPath) {
    const problems = [];
    const dirs = [];
    const paths = [];
    if (options.files.length > 0) {
        for (const file of options.files) {
            if (!(0, fs_1.existsSync)(file)) {
                problems.push(`指定的文件不存在：${file}`);
                continue;
            }
            paths.push(file);
        }
    }
    else {
        const wanted = options.dir ? [options.dir] : exports.LOG_DIR_CANDIDATES;
        for (const dir of wanted) {
            const abs = options.dir ? dir : (0, path_1.join)(projectPath, dir);
            const shown = options.dir ? abs : dir;
            let names = [];
            try {
                if (!(0, fs_1.existsSync)(abs)) {
                    dirs.push({ path: shown, exists: false, fileCount: 0 });
                    continue;
                }
                if (!(0, fs_1.statSync)(abs).isDirectory()) {
                    dirs.push({ path: shown, exists: false, fileCount: 0 });
                    problems.push(`候选路径存在但不是目录（${shown}）`);
                    continue;
                }
                names = (0, fs_1.readdirSync)(abs).filter((name) => {
                    const dot = name.lastIndexOf('.');
                    return dot > 0 && LOG_EXTENSIONS.has(name.slice(dot).toLowerCase());
                });
            }
            catch (error) {
                dirs.push({ path: shown, exists: true, fileCount: 0 });
                problems.push(`目录读不了（${shown}）：${describe(error)}`);
                continue;
            }
            dirs.push({ path: shown, exists: true, fileCount: names.length });
            for (const name of names)
                paths.push((0, path_1.join)(abs, name));
        }
    }
    const files = [];
    const seen = new Set();
    for (const path of paths) {
        if (seen.has(path))
            continue;
        seen.add(path);
        try {
            const stat = (0, fs_1.statSync)(path);
            if (!stat.isFile())
                continue;
            files.push({
                path,
                id: '',
                bytes: stat.size,
                modifiedAt: formatTime(stat.mtimeMs),
                readBytes: 0,
            });
        }
        catch (error) {
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
function clearFiles(files) {
    const cleared = [];
    const problems = [];
    for (const file of files) {
        try {
            (0, fs_1.truncateSync)(file.path, 0);
            cleared.push({ path: file.path, bytesBefore: file.bytes });
        }
        catch (error) {
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
async function readLogs(params) {
    let projectPath = '';
    try {
        projectPath = Editor.Project.path;
    }
    catch (error) {
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
    const notes = [];
    if (options.sinceRaw && options.since === null) {
        notes.push(`\`since\` 解析不了（${options.sinceRaw}），这一条被忽略 —— 认 ISO 时间或毫秒时间戳。`);
    }
    const { files, dirs, problems } = collectFiles(options, projectPath);
    // ---- 清空：唯一一个写盘口，必须显式确认 ----
    if (options.clear) {
        if (options.confirm !== exports.CLEAR_CONFIRM) {
            return {
                ok: false,
                text: `cocos_logs 要清空日志得显式确认：` +
                    `cocos_logs({ clear: true, confirm: "${exports.CLEAR_CONFIRM}" })` +
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
        if (allProblems.length > 0)
            lines.push('', '⚠ 有问题：', ...allProblems.map((line) => `- ${line}`));
        return {
            ok: cleared.length > 0,
            text: lines.join('\n'),
            error: cleared.length > 0 ? undefined : '没有清掉任何文件',
            data: { projectPath, cleared, problems: allProblems },
        };
    }
    // ---- 列文件：定位"日志到底在哪"这一步单独给一个档 ----
    const header = [`工程：${projectPath}`, `扫到的目录（${dirs.length} 个）：`];
    for (const dir of dirs) {
        header.push(`- ${dir.exists ? '✓' : '✗'} ${dir.path}${dir.exists ? `（${dir.fileCount} 个日志文件）` : '（不存在）'}`);
    }
    if (dirs.length === 0)
        header.push('- （用了 files 参数，没有扫目录）');
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
    const hits = [];
    const fileStats = [];
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
        let lines = [];
        try {
            const read = readTailLines(file.path);
            lines = read.lines;
            file.readBytes = read.readBytes;
        }
        catch (error) {
            fileStats.push({ file, matched: 0, shown: 0, error: describe(error) });
            continue;
        }
        const matched = [];
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!filter.test(line))
                continue;
            if (options.since !== null) {
                const ts = parseLineTime(line);
                // 行里没有时间戳就**保留**（宁可多给一行，也不要因为格式不认识而漏掉现场）
                if (ts !== null && ts < options.since)
                    continue;
            }
            matched.push({ file: file.id, line: i + 1, text: line });
        }
        const shown = matched.slice(-options.tail);
        fileStats.push({ file, matched: matched.length, shown: shown.length });
        hits.push(...shown);
    }
    // ---- 组装文案（按文件分组，行号是**该文件里的行号**）----
    const body = [];
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
        if (truncatedText)
            break;
        body.push('');
    }
    const tailNotes = [];
    if (truncatedText)
        tailNotes.push(`正文超过 ${MAX_TEXT_CHARS} 字符预算，后面的行没回（缩小 grep 或调小 tail 再试）`);
    if (files.some((file) => file.bytes > LOG_TAIL_BYTES)) {
        tailNotes.push(`有文件大于 ${formatBytes(LOG_TAIL_BYTES)}，只读了**尾部**（行号是尾读窗口内的行号，不是全文件行号）`);
    }
    if (options.grep)
        tailNotes.push(`筛选：${options.regex ? '正则' : '子串'} / ${options.caseSensitive ? '区分大小写' : '不区分大小写'}`);
    const totalMatched = fileStats.reduce((sum, stat) => sum + stat.matched, 0);
    if (totalMatched === 0)
        tailNotes.push('没有任何行命中筛选条件（文件是读到了的，见上面每个文件的命中数）');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9ncy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9sb2dzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EwQkc7OztBQW1ISCxzQ0FjQztBQTBLRCw0QkF3TUM7QUFqZkQsMkJBQW9HO0FBQ3BHLCtCQUFpRDtBQUlqRDs7Ozs7R0FLRztBQUNVLFFBQUEsa0JBQWtCLEdBQUc7SUFDOUIsV0FBVztJQUNYLE1BQU07SUFDTixZQUFZO0lBQ1osbUJBQW1CO0lBQ25CLE9BQU87SUFDUCxNQUFNO0NBQ1QsQ0FBQztBQUVGLHFEQUFxRDtBQUNyRCxNQUFNLGNBQWMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBRWpELDZDQUE2QztBQUM3QyxNQUFNLGNBQWMsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQztBQUV2QyxtQkFBbUI7QUFDbkIsTUFBTSxrQkFBa0IsR0FBRyxHQUFHLENBQUM7QUFFL0IsK0JBQStCO0FBQy9CLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQztBQUU1QiwrQkFBK0I7QUFDL0IsTUFBTSxjQUFjLEdBQUcsS0FBTSxDQUFDO0FBRTlCLGtDQUFrQztBQUNsQyxNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUM7QUFFckIsd0JBQXdCO0FBQ1gsUUFBQSxhQUFhLEdBQUcsT0FBTyxDQUFDO0FBMkNyQyxtQkFBbUI7QUFDbkIsU0FBUyxRQUFRLENBQUMsS0FBYztJQUM1QixPQUFPLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNsRSxDQUFDO0FBRUQsZ0JBQWdCO0FBQ2hCLFNBQVMsV0FBVyxDQUFDLEtBQWE7SUFDOUIsSUFBSSxLQUFLLEdBQUcsSUFBSTtRQUFFLE9BQU8sR0FBRyxLQUFL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SSxDQUFDLE9BQU87Z0JBQ3JCLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSztnQkFDakIsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNsRCxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDL0MsQ0FBQyxDQUFDO1lBQ0gsT0FBTyxFQUFFLElBQUk7WUFDYixTQUFTLEVBQUUsYUFBYTtZQUN4QixRQUFRO1NBQ1g7S0FDSixDQUFDO0FBQ04sQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogYGNvY29zX2xvZ3NgIOeahOWunueOsO+8muaKiuW3peeoi+mHjOeahCoq5pel5b+X5paH5Lu2Kiror7vmiJDkuovlrp7jgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjopoHmnInlroNcbiAqXG4gKiDnvJbovpHlmajmjqfliLblj7Dph4zpgqPkupvlrZfvvIzmqKHlnovnnIvkuI3op4HvvJrlroPlj6rog73nnIvliLDoh6rlt7HlhpnnmoTpgqPmrrXku6PnoIHnmoQgYHJldHVybmDjgIJcbiAqIOS6juaYr+OAjOW8leaTjuaKm+S6huW8guW4uOOAjeOAjOe7hOS7tuWcqCBgb25EZXN0cm95YCDph4zngrjkuobjgI3jgIzotYTmupDlr7zlhaXooqvmi5LjgI3ov5nnsbtcbiAqICoq5Y+q5Ye6546w5Zyo5o6n5Yi25Y+wL+aXpeW/l+aWh+S7tumHjCoq55qE5LqL5a6e77yM6L+H5Y675Y+q6IO96Z2g5Lq65aSN6L+wIOKAlOKAlCDogIzkurrlpI3ov7DnmoTlvoDlvoDmmK/nu5PorrrvvIzkuI3mmK/ljp/mlofjgIJcbiAqXG4gKiDov5nph4zlj6rlgZrkuInku7bkuovvvJoqKuaJvuWIsOaXpeW/l+aWh+S7tiDihpIg5oyJ5p2h5Lu2562b6KGMIOKGkiDljp/moLflm57vvIjmlofku7bot6/lvoQgKyDooYzlj7cgKyDljp/mlofvvIkqKuOAglxuICpcbiAqICMjIOS4ieadoeWPo+W+hFxuICpcbiAqIDEuICoq5Zue5LqL5a6e77yM5LiN5YGa5Yik5patKirvvJrkuI3orqTor4ZcIui/meaYr+WTquexuyBidWdcIu+8jOS5n+S4jee7mee7k+iuuuOAgeS4jeW7uuiuruaAjuS5iOaUueOAglxuICogICAg5Yik5pat55WZ57uZ6LCD55So5pa577yI5Lq65oiW5bel56iL5L6n6ISa5pys77yJ44CCXG4gKiAyLiAqKuS4jee7keS4muWKoSoq77ya55uu5b2V5ZCN44CB5paH5Lu25ZCN44CB6KGM5YaF5a656YO95LiN5bim5bel56iL6K+t5LmJ77yb5o2i5LiA5LiqIENvY29zIOW3peeoi+eFp+agt+iDveeUqOOAglxuICogICAg44CM5ZOq5Lqb55uu5b2V566X5pel5b+X55uu5b2V44CN5piv5LiA5bygKirpgJrnlKjlgJnpgInooagqKu+8iGBMT0dfRElSX0NBTkRJREFURVNg77yJ77yMXG4gKiAgICDlkb3kuK3kuI3kuoblsLHnlKggYGRpcmAgLyBgZmlsZXNgIOaYvuW8j+e7meOAglxuICogMy4gKirlj6ror7vvvIzkuJTor7vlvpfliqjlsLHmiqXlvpflh7rmnaUqKu+8muWNleaWh+S7tuWPquWwvuivu+acgOWQjiBgTE9HX1RBSUxfQllURVNg77yI6buY6K6kIDJNQu+8ie+8m1xuICogICAg55uu5b2V5LiN5a2Y5Zyo44CB5paH5Lu25Li656m644CB6KKr57yW6L6R5Zmo5Y2g552A6K+75LiN5LqGIOKAlOKAlCDmr4/kuIDnp43pg70qKuWmguWunuivtCoq77yM5LiN6Z2Z6buY6Lez6L+H44CCXG4gKlxuICog4pqgICoq5YaZ55uY5Y+q5pyJ5LiA5Liq5Y+jKirvvJpgY2xlYXJg44CC5a6D5oqK5pel5b+X5paH5Lu2KirmiKrmlq3miJAgMCDlrZfoioIqKu+8iOS4jeaYr+WIoOmZpCDigJTigJRcbiAqIFdpbmRvd3Mg5LiK5Yig6Zmk6KKr5Y2g55So5Lit55qE5paH5Lu25Lya5aSx6LSl77yM6ICM5oiq5pat5Y+v55So77yJ44CC5b+F6aG75ZCM5pe257uZIGBjb25maXJtOiAnY2xlYXInYO+8jFxuICog5ZCm5YiZ55u05o6l5ouS57ud5bm25ZGK6K+J6LCD55So5pa56K+l5Lyg5LuA5LmI44CCXG4gKlxuICogQG1vZHVsZSBkc2hfY2hhdC9sb2dzXG4gKi9cblxuaW1wb3J0IHsgY2xvc2VTeW5jLCBleGlzdHNTeW5jLCBvcGVuU3luYywgcmVhZFN5bmMsIHJlYWRkaXJTeW5jLCBzdGF0U3luYywgdHJ1bmNhdGVTeW5jIH0gZnJvbSAnZnMnO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQgdHlwZSB7IFRvb2xSZXBseSB9IGZyb20gJy4vY29uc3RhbnRzJztcblxuLyoqXG4gKiDnm7jlr7kqKuW3peeoi+aguSoq5Y675o6i55qE5pel5b+X55uu5b2V77yI6YCa55So5YCZ6YCJ77yM5LiO5YW35L2T5bel56iL5peg5YWz77yJ44CCXG4gKlxuICog6aG65bqPID0g5YiX6KGo5bGV56S66aG65bqP77yI6LaK5YOP5pel5b+X55uu5b2V55qE5o6S6LaK5YmN77yJ77yb5L2GKirlhajpg73miasqKu+8jOS4jeaYr+WRveS4reS4gOS4quWwseWBnCDigJTigJRcbiAqIOS4jeWQjOeJiOacrOeahOe8lui+keWZqOaKiuaXpeW/l+aUvuWcqOS4jeWQjOWcsOaWue+8jOWPquiupOesrOS4gOS4quetieS6juiHquW3see7meiHquW3seaMluWdkeOAglxuICovXG5leHBvcnQgY29uc3QgTE9HX0RJUl9DQU5ESURBVEVTID0gW1xuICAgICd0ZW1wL2xvZ3MnLFxuICAgICdsb2dzJyxcbiAgICAnbG9jYWwvbG9ncycsXG4gICAgJ3RlbXAvYXNzZXQtZGIvbG9nJyxcbiAgICAnbG9jYWwnLFxuICAgICd0ZW1wJyxcbl07XG5cbi8qKiDlj6ror7vov5nkupvmianlsZXlkI3nmoTmlofku7bvvJpgdGVtcC9gIOS4i+i/mOacieS4gOWghiBqc29uIC8g5LqM6L+b5Yi277yM6K+76L+b5p2l5Y+q5Lya5Y+Y5oiQ5Zmq5aOw44CCICovXG5jb25zdCBMT0dfRVhURU5TSU9OUyA9IG5ldyBTZXQoWycubG9nJywgJy50eHQnXSk7XG5cbi8qKiDljZXmlofku7YqKuWwvuivuyoq5LiK6ZmQ77yI5a2X6IqC77yJ44CC5pel5b+X5Y+v6IO95Yeg55m+IE1C77yM5YWo6K+75Lya5Y2h5q2757yW6L6R5Zmo5Li76L+b56iL44CCICovXG5jb25zdCBMT0dfVEFJTF9CWVRFUyA9IDIgKiAxMDI0ICogMTAyNDtcblxuLyoqIOWNleaWh+S7tum7mOiupOacgOWkmuWbnuWkmuWwkeihjOOAgiAqL1xuY29uc3QgREVGQVVMVF9UQUlMX0xJTkVTID0gMjAwO1xuXG4vKiog5Y2V5paH5Lu26KGM5pWw5LiK6ZmQ77yIYHRhaWxgIOWGjeWkp+S5n+WkueWIsOi/memHjO+8ieOAgiAqL1xuY29uc3QgTUFYX1RBSUxfTElORVMgPSAyMDAwO1xuXG4vKiog5LiA5qyh6LCD55So5Zue57uZ5qih5Z6L55qE5a2X56ym6aKE566X77yI6LaF5LqG5bCx5oiq5pat5bm26K+05piO77yJ44CCICovXG5jb25zdCBNQVhfVEVYVF9DSEFSUyA9IDQwXzAwMDtcblxuLyoqIOS4gOasoeacgOWkmuWkhOeQhuWkmuWwkeS4quaWh+S7tu+8iOaMieS/ruaUueaXtumXtOWAkuW6j+WPluacgOaWsOeahOi/meS6m++8ieOAgiAqL1xuY29uc3QgTUFYX0ZJTEVTID0gNDA7XG5cbi8qKiBgY2xlYXJgIOW/hemhu+W4pueahOehruiupOWPo+S7pOOAgiAqL1xuZXhwb3J0IGNvbnN0IENMRUFSX0NPTkZJUk0gPSAnY2xlYXInO1xuXG4vKiog5LiA5Liq6KKr5omr5Yiw55qE5pel5b+X5paH5Lu244CCICovXG5pbnRlcmZhY2UgTG9nRmlsZSB7XG4gICAgLyoqIOe7neWvuei3r+W+hCAqL1xuICAgIHBhdGg6IHN0cmluZztcbiAgICAvKiog5bGV56S655So57yW5Y+377yIYEYxYCAvIGBGMmDigKbvvInvvIzmraPmlofph4znlKjlroPmjIfku6PvvIznnIHlvpfmr4/ooYzpg73ljbDkuIDpgY3plb/ot6/lvoQgKi9cbiAgICBpZDogc3RyaW5nO1xuICAgIGJ5dGVzOiBudW1iZXI7XG4gICAgbW9kaWZpZWRBdDogc3RyaW5nO1xuICAgIC8qKiDlrp7pmYXor7vov5vmnaXlpJrlsJHlrZfoioLvvIjlsL7or7vml7blsI/kuo4gYGJ5dGVzYO+8iSAqL1xuICAgIHJlYWRCeXRlczogbnVtYmVyO1xufVxuXG4vKiog5LiA6KGM5ZG95Lit44CCICovXG5pbnRlcmZhY2UgTG9nSGl0IHtcbiAgICBmaWxlOiBzdHJpbmc7XG4gICAgbGluZTogbnVtYmVyO1xuICAgIHRleHQ6IHN0cmluZztcbn1cblxuLyoqIOS4gOS4quiiq+aJq+eahOebruW9leOAgiAqL1xuaW50ZXJmYWNlIFNjYW5uZWREaXIge1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBleGlzdHM6IGJvb2xlYW47XG4gICAgZmlsZUNvdW50OiBudW1iZXI7XG59XG5cbi8qKiBgcmVhZExvZ3NgIOeahOetm+mAiS/ovpPlh7rpgInpobnvvIjpg73nlLHlt6Xlhbflj4LmlbDmnaXvvIzov5nph4zlj6rlgZrlvZLkuIDljJbvvInjgIIgKi9cbmludGVyZmFjZSBSZWFkTG9nc09wdGlvbnMge1xuICAgIGRpcjogc3RyaW5nO1xuICAgIGZpbGVzOiBzdHJpbmdbXTtcbiAgICBsaXN0OiBib29sZWFuO1xuICAgIHRhaWw6IG51bWJlcjtcbiAgICBncmVwOiBzdHJpbmc7XG4gICAgcmVnZXg6IGJvb2xlYW47XG4gICAgY2FzZVNlbnNpdGl2ZTogYm9vbGVhbjtcbiAgICBzaW5jZTogbnVtYmVyIHwgbnVsbDtcbiAgICBzaW5jZVJhdzogc3RyaW5nO1xuICAgIGNsZWFyOiBib29sZWFuO1xuICAgIGNvbmZpcm06IHN0cmluZztcbn1cblxuLyoqIOaKiuS7u+aEj+W8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8qKiDkurrnsbvlj6/or7vnmoTlrZfoioLmlbDjgIIgKi9cbmZ1bmN0aW9uIGZvcm1hdEJ5dGVzKGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGlmIChieXRlcyA8IDEwMjQpIHJldHVybiBgJHtieXRlc30gQmA7XG4gICAgaWYgKGJ5dGVzIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsoYnl0ZXMgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gICAgcmV0dXJuIGAkeyhieXRlcyAvIDEwMjQgLyAxMDI0KS50b0ZpeGVkKDEpfSBNQmA7XG59XG5cbi8qKiDmnKzlnLDml7bpl7TnmoQgYFlZWVktTU0tREQgSEg6bW06c3Ng44CCICovXG5mdW5jdGlvbiBmb3JtYXRUaW1lKG1zOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShtcyk7XG4gICAgY29uc3QgcGFkID0gKG46IG51bWJlcik6IHN0cmluZyA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgJzAnKTtcbiAgICByZXR1cm4gKFxuICAgICAgICBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7cGFkKGQuZ2V0TW9udGgoKSArIDEpfS0ke3BhZChkLmdldERhdGUoKSl9IGAgK1xuICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfToke3BhZChkLmdldFNlY29uZHMoKSl9YFxuICAgICk7XG59XG5cbi8qKlxuICog5LuO5LiA6KGM5pel5b+X6YeM5oqg5Ye65pe26Ze05oiz44CCXG4gKlxuICog6K6k5LiJ56eN5YaZ5rOV77yI6YO95piv5ZCE54mI5pys57yW6L6R5Zmo55yf5a6e5Ye6546w6L+H55qE5byA5aS077yJ77yaXG4gKiBgWzIwMjYtMTAtMDYgMDY6MDQ6NDldYOOAgWAyMDI2LTEwLTA2IDA2OjA0OjQ5LjEyM2DjgIFgMjAyNi0xMC0wNlQwNjowNDo0OWDjgIJcbiAqXG4gKiBAcGFyYW0gbGluZSAtIOS4gOihjOWOn+aWh+OAglxuICogQHJldHVybnMg5q+r56eS5pe26Ze05oiz77yb6L+Z6KGM5rKh5pyJ5Y+v6K+G5Yir55qE5pe26Ze05oiz5pe25ZueIG51bGzvvIgqKuiwg+eUqOaWueimgeaMiVwi5L+d55WZXCLlpITnkIYqKu+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMaW5lVGltZShsaW5lOiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgICBjb25zdCBtID0gL15cXHMqXFxbPyhcXGR7NH0pLShcXGR7Mn0pLShcXGR7Mn0pWyBUXShcXGR7Mn0pOihcXGR7Mn0pOihcXGR7Mn0pKD86Wy4sXShcXGR7MSwzfSkpPy8uZXhlYyhsaW5lKTtcbiAgICBpZiAoIW0pIHJldHVybiBudWxsO1xuICAgIGNvbnN0IFssIHksIG1vLCBkLCBoLCBtaSwgcywgbXNdID0gbTtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKFxuICAgICAgICBOdW1iZXIoeSksXG4gICAgICAgIE51bWJlcihtbykgLSAxLFxuICAgICAgICBOdW1iZXIoZCksXG4gICAgICAgIE51bWJlcihoKSxcbiAgICAgICAgTnVtYmVyKG1pKSxcbiAgICAgICAgTnVtYmVyKHMpLFxuICAgICAgICBtcyA/IE51bWJlcihtcy5wYWRFbmQoMywgJzAnKSkgOiAwLFxuICAgICkuZ2V0VGltZSgpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodHMpID8gdHMgOiBudWxsO1xufVxuXG4vKiogYHNpbmNlYCDlj4LmlbDvvJrmlbDlrZfvvIjmr6vnp5LvvInmiJblj6/ooqsgYERhdGVgIOino+aekOeahOWtl+espuS4su+8m+ino+aekOS4jeS6huWbniBudWxs77yI5bm25Zyo5paH5qGI6YeM6K+05piO77yJ44CCICovXG5mdW5jdGlvbiBwYXJzZVNpbmNlKHJhdzogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgY29uc3QgdGV4dCA9IHJhdy50cmltKCk7XG4gICAgaWYgKCF0ZXh0KSByZXR1cm4gbnVsbDtcbiAgICBpZiAoL15cXGR7MTAsfSQvLnRlc3QodGV4dCkpIHJldHVybiBOdW1iZXIodGV4dCk7XG4gICAgY29uc3QgdHMgPSBEYXRlLnBhcnNlKHRleHQpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodHMpID8gdHMgOiBudWxsO1xufVxuXG4vKiog5bC+6K+75LiA5Liq5paH5Lu277yI5pyA5aSaIGBMT0dfVEFJTF9CWVRFU2DvvInvvIzlm57ooYzmlbDnu4TvvJvor7vkuI3liqjml7bmipvjgIIgKi9cbmZ1bmN0aW9uIHJlYWRUYWlsTGluZXMoZmlsZTogc3RyaW5nKTogeyBsaW5lczogc3RyaW5nW107IHJlYWRCeXRlczogbnVtYmVyIH0ge1xuICAgIGNvbnN0IHNpemUgPSBzdGF0U3luYyhmaWxlKS5zaXplO1xuICAgIGNvbnN0IHJlYWRCeXRlcyA9IE1hdGgubWluKHNpemUsIExPR19UQUlMX0JZVEVTKTtcbiAgICBpZiAocmVhZEJ5dGVzID09PSAwKSByZXR1cm4geyBsaW5lczogW10sIHJlYWRCeXRlczogMCB9O1xuICAgIGNvbnN0IGZkID0gb3BlblN5bmMoZmlsZSwgJ3InKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBidWZmZXIgPSBCdWZmZXIuYWxsb2NVbnNhZmUocmVhZEJ5dGVzKTtcbiAgICAgICAgY29uc3QgcmVhZCA9IHJlYWRTeW5jKGZkLCBidWZmZXIsIDAsIHJlYWRCeXRlcywgc2l6ZSAtIHJlYWRCeXRlcyk7XG4gICAgICAgIGNvbnN0IHRleHQgPSBidWZmZXIuc3ViYXJyYXkoMCwgcmVhZCkudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICAgICAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KC9cXHI/XFxuLyk7XG4gICAgICAgIC8vIOWwvuivu+aYr+S7juS4remXtOWIh+i/m+WOu+eahO+8muesrOS4gOihjOWPr+iDveaYr+WNiuaIqu+8jOWPquWcqOOAjOehruWunuaIquaWreS6huOAjeaXtuS4ouaOieWug1xuICAgICAgICBpZiAoc2l6ZSA+IHJlYWRCeXRlcyAmJiBsaW5lcy5sZW5ndGggPiAxKSBsaW5lcy5zaGlmdCgpO1xuICAgICAgICByZXR1cm4geyBsaW5lcywgcmVhZEJ5dGVzOiByZWFkIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgY2xvc2VTeW5jKGZkKTtcbiAgICB9XG59XG5cbi8qKiDlvZLkuIDljJblj4LmlbDvvIjlt6XlhbfkvqfmnaXnmoTpg73mmK8gYHVua25vd25g77yJ44CCICovXG5mdW5jdGlvbiBub3JtYWxpemVPcHRpb25zKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHByb2plY3RQYXRoOiBzdHJpbmcpOiBSZWFkTG9nc09wdGlvbnMge1xuICAgIGNvbnN0IG51bSA9ICh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciA9PlxuICAgICAgICB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnRydW5jKHZhbHVlKSA6IGZhbGxiYWNrO1xuICAgIGNvbnN0IHNpbmNlUmF3ID0gdHlwZW9mIHBhcmFtcy5zaW5jZSA9PT0gJ3N0cmluZycgPyBwYXJhbXMuc2luY2UgOiB0eXBlb2YgcGFyYW1zLnNpbmNlID09PSAnbnVtYmVyJyA/IFN0cmluZyhwYXJhbXMuc2luY2UpIDogJyc7XG4gICAgY29uc3QgZGlyUmF3ID0gdHlwZW9mIHBhcmFtcy5kaXIgPT09ICdzdHJpbmcnID8gcGFyYW1zLmRpci50cmltKCkgOiAnJztcbiAgICByZXR1cm4ge1xuICAgICAgICBkaXI6IGRpclJhdyA/IChpc0Fic29sdXRlKGRpclJhdykgPyBkaXJSYXcgOiByZXNvbHZlKHByb2plY3RQYXRoLCBkaXJSYXcpKSA6ICcnLFxuICAgICAgICBmaWxlczogQXJyYXkuaXNBcnJheShwYXJhbXMuZmlsZXMpXG4gICAgICAgICAgICA/IHBhcmFtcy5maWxlc1xuICAgICAgICAgICAgICAgICAgLmZpbHRlcigodik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2LnRyaW0oKSAhPT0gJycpXG4gICAgICAgICAgICAgICAgICAubWFwKCh2KSA9PiAoaXNBYnNvbHV0ZSh2KSA/IHYgOiByZXNvbHZlKHByb2plY3RQYXRoLCB2KSkpXG4gICAgICAgICAgICA6IFtdLFxuICAgICAgICBsaXN0OiBwYXJhbXMubGlzdCA9PT0gdHJ1ZSxcbiAgICAgICAgdGFpbDogTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX1RBSUxfTElORVMsIG51bShwYXJhbXMudGFpbCwgREVGQVVMVF9UQUlMX0xJTkVTKSkpLFxuICAgICAgICBncmVwOiB0eXBlb2YgcGFyYW1zLmdyZXAgPT09ICdzdHJpbmcnID8gcGFyYW1zLmdyZXAgOiAnJyxcbiAgICAgICAgcmVnZXg6IHBhcmFtcy5yZWdleCA9PT0gdHJ1ZSxcbiAgICAgICAgY2FzZVNlbnNpdGl2ZTogcGFyYW1zLmNhc2VTZW5zaXRpdmUgPT09IHRydWUsXG4gICAgICAgIHNpbmNlOiBwYXJzZVNpbmNlKHNpbmNlUmF3KSxcbiAgICAgICAgc2luY2VSYXcsXG4gICAgICAgIGNsZWFyOiBwYXJhbXMuY2xlYXIgPT09IHRydWUsXG4gICAgICAgIGNvbmZpcm06IHR5cGVvZiBwYXJhbXMuY29uZmlybSA9PT0gJ3N0cmluZycgPyBwYXJhbXMuY29uZmlybSA6ICcnLFxuICAgIH07XG59XG5cbi8qKiDpgKDkuIDkuKrnrZvooYzlmajvvIjlrZDkuLLmiJbmraPliJnvvJvkuI3ljLrliIblpKflsI/lhpnmmK/pu5jorqTvvIzlm6DkuLrml6Xlv5fph4znmoTlpKflsI/lhpnlvoDlvoDkuI3kuIDoh7TvvInjgIIgKi9cbmZ1bmN0aW9uIG1ha2VMaW5lRmlsdGVyKG9wdGlvbnM6IFJlYWRMb2dzT3B0aW9ucyk6IHsgdGVzdDogKGxpbmU6IHN0cmluZykgPT4gYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfSB7XG4gICAgaWYgKCFvcHRpb25zLmdyZXApIHJldHVybiB7IHRlc3Q6ICgpID0+IHRydWUgfTtcbiAgICBpZiAob3B0aW9ucy5yZWdleCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmUgPSBuZXcgUmVnRXhwKG9wdGlvbnMuZ3JlcCwgb3B0aW9ucy5jYXNlU2Vuc2l0aXZlID8gJycgOiAnaScpO1xuICAgICAgICAgICAgcmV0dXJuIHsgdGVzdDogKGxpbmUpID0+IHJlLnRlc3QobGluZSkgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHRlc3Q6ICgpID0+IGZhbHNlLCBlcnJvcjogYGdyZXAg5LiN5piv5ZCI5rOV5q2j5YiZ77yaJHtkZXNjcmliZShlcnJvcil9YCB9O1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG5lZWRsZSA9IG9wdGlvbnMuY2FzZVNlbnNpdGl2ZSA/IG9wdGlvbnMuZ3JlcCA6IG9wdGlvbnMuZ3JlcC50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiB7IHRlc3Q6IChsaW5lKSA9PiAob3B0aW9ucy5jYXNlU2Vuc2l0aXZlID8gbGluZSA6IGxpbmUudG9Mb3dlckNhc2UoKSkuaW5jbHVkZXMobmVlZGxlKSB9O1xufVxuXG4vKiog5pS26ZuG6KaB6K+755qE5paH5Lu277ya5pi+5byPIGBmaWxlc2Ag5LyY5YWI77yM5ZCm5YiZ5oyJIGBkaXJgIC8g6YCa55So5YCZ6YCJ55uu5b2V5omr44CCICovXG5mdW5jdGlvbiBjb2xsZWN0RmlsZXMoXG4gICAgb3B0aW9uczogUmVhZExvZ3NPcHRpb25zLFxuICAgIHByb2plY3RQYXRoOiBzdHJpbmcsXG4pOiB7IGZpbGVzOiBMb2dGaWxlW107IGRpcnM6IFNjYW5uZWREaXJbXTsgcHJvYmxlbXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IHByb2JsZW1zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGRpcnM6IFNjYW5uZWREaXJbXSA9IFtdO1xuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgaWYgKG9wdGlvbnMuZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2Ygb3B0aW9ucy5maWxlcykge1xuICAgICAgICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSB7XG4gICAgICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg5oyH5a6a55qE5paH5Lu25LiN5a2Y5Zyo77yaJHtmaWxlfWApO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcGF0aHMucHVzaChmaWxlKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHdhbnRlZCA9IG9wdGlvbnMuZGlyID8gW29wdGlvbnMuZGlyXSA6IExPR19ESVJfQ0FORElEQVRFUztcbiAgICAgICAgZm9yIChjb25zdCBkaXIgb2Ygd2FudGVkKSB7XG4gICAgICAgICAgICBjb25zdCBhYnMgPSBvcHRpb25zLmRpciA/IGRpciA6IGpvaW4ocHJvamVjdFBhdGgsIGRpcik7XG4gICAgICAgICAgICBjb25zdCBzaG93biA9IG9wdGlvbnMuZGlyID8gYWJzIDogZGlyO1xuICAgICAgICAgICAgbGV0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoIWV4aXN0c1N5bmMoYWJzKSkge1xuICAgICAgICAgICAgICAgICAgICBkaXJzLnB1c2goeyBwYXRoOiBzaG93biwgZXhpc3RzOiBmYWxzZSwgZmlsZUNvdW50OiAwIH0pO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGlycy5wdXNoKHsgcGF0aDogc2hvd24sIGV4aXN0czogZmFsc2UsIGZpbGVDb3VudDogMCB9KTtcbiAgICAgICAgICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg5YCZ6YCJ6Lev5b6E5a2Y5Zyo5L2G5LiN5piv55uu5b2V77yIJHtzaG93bn3vvIlgKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoYWJzKS5maWx0ZXIoKG5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZG90ID0gbmFtZS5sYXN0SW5kZXhPZignLicpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZG90ID4gMCAmJiBMT0dfRVhURU5TSU9OUy5oYXMobmFtZS5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBkaXJzLnB1c2goeyBwYXRoOiBzaG93biwgZXhpc3RzOiB0cnVlLCBmaWxlQ291bnQ6IDAgfSk7XG4gICAgICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg55uu5b2V6K+75LiN5LqG77yIJHtzaG93bn3vvInvvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGRpcnMucHVzaCh7IHBhdGg6IHNob3duLCBleGlzdHM6IHRydWUsIGZpbGVDb3VudDogbmFtZXMubGVuZ3RoIH0pO1xuICAgICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSBwYXRocy5wdXNoKGpvaW4oYWJzLCBuYW1lKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBmaWxlczogTG9nRmlsZVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgICAgICBpZiAoc2Vlbi5oYXMocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWVuLmFkZChwYXRoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXQgPSBzdGF0U3luYyhwYXRoKTtcbiAgICAgICAgICAgIGlmICghc3RhdC5pc0ZpbGUoKSkgY29udGludWU7XG4gICAgICAgICAgICBmaWxlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgICAgIGlkOiAnJyxcbiAgICAgICAgICAgICAgICBieXRlczogc3RhdC5zaXplLFxuICAgICAgICAgICAgICAgIG1vZGlmaWVkQXQ6IGZvcm1hdFRpbWUoc3RhdC5tdGltZU1zKSxcbiAgICAgICAgICAgICAgICByZWFkQnl0ZXM6IDAsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHByb2JsZW1zLnB1c2goYOaWh+S7tuivu+S4jeWIsOWFg+S/oeaBr++8iCR7cGF0aH3vvInvvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIOaWsOeahOWcqOWJje+8muaXpeW/l+WcuuaZr+mHjFwi5pyA6L+R55qEXCLlh6DkuY7mgLvmmK/mnIDnm7jlhbPnmoRcbiAgICBmaWxlcy5zb3J0KChhLCBiKSA9PiAoYS5tb2RpZmllZEF0IDwgYi5tb2RpZmllZEF0ID8gMSA6IGEubW9kaWZpZWRBdCA+IGIubW9kaWZpZWRBdCA/IC0xIDogMCkpO1xuICAgIGNvbnN0IGtlcHQgPSBmaWxlcy5zbGljZSgwLCBNQVhfRklMRVMpO1xuICAgIGlmIChmaWxlcy5sZW5ndGggPiBrZXB0Lmxlbmd0aCkge1xuICAgICAgICBwcm9ibGVtcy5wdXNoKGDml6Xlv5fmlofku7YgJHtmaWxlcy5sZW5ndGh9IOS4qu+8jOWPquWkhOeQhuacgOaWsOeahCAke01BWF9GSUxFU30g5Liq77yI6KaB5pu05aSa5bCx55SoIGZpbGVzIOaYvuW8j+eCueWQje+8iWApO1xuICAgIH1cbiAgICBrZXB0LmZvckVhY2goKGZpbGUsIGluZGV4KSA9PiB7XG4gICAgICAgIGZpbGUuaWQgPSBgRiR7aW5kZXggKyAxfWA7XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgZmlsZXM6IGtlcHQsIGRpcnMsIHByb2JsZW1zIH07XG59XG5cbi8qKiDmuIXnqbrvvIjmiKrmlq3vvInnu5nlrprnmoTml6Xlv5fmlofku7bjgIIgKi9cbmZ1bmN0aW9uIGNsZWFyRmlsZXMoZmlsZXM6IExvZ0ZpbGVbXSk6IHsgY2xlYXJlZDogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGJ5dGVzQmVmb3JlOiBudW1iZXIgfT47IHByb2JsZW1zOiBzdHJpbmdbXSB9IHtcbiAgICBjb25zdCBjbGVhcmVkOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgYnl0ZXNCZWZvcmU6IG51bWJlciB9PiA9IFtdO1xuICAgIGNvbnN0IHByb2JsZW1zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdHJ1bmNhdGVTeW5jKGZpbGUucGF0aCwgMCk7XG4gICAgICAgICAgICBjbGVhcmVkLnB1c2goeyBwYXRoOiBmaWxlLnBhdGgsIGJ5dGVzQmVmb3JlOiBmaWxlLmJ5dGVzIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcHJvYmxlbXMucHVzaChg5riF5LiN5o6J77yIJHtmaWxlLnBhdGh977yJ77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgY2xlYXJlZCwgcHJvYmxlbXMgfTtcbn1cblxuLyoqXG4gKiDor7vlt6XnqIvph4znmoTml6Xlv5fmlofku7bvvIhgY29jb3NfbG9nc2Ag55qE5a6e546w77yJ44CCXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIGB7ZGlyPywgZmlsZXM/LCBsaXN0PywgdGFpbD8sIGdyZXA/LCByZWdleD8sIGNhc2VTZW5zaXRpdmU/LCBzaW5jZT8sIGNsZWFyPywgY29uZmlybT99YOOAglxuICogQHJldHVybnMg5bel5YW35Zue5omn44CCYHRleHRgIOaYr+e7meaooeWei+eci+eahOOAjOebruW9lSDihpIg5paH5Lu2IOKGkiDooYzjgI3kuInmrrXkuovlrp7vvJtgZGF0YWAg5piv5ZCM5YaF5a6555qE57uT5p6E5YyW54mI5pys44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkTG9ncyhwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBsZXQgcHJvamVjdFBhdGggPSAnJztcbiAgICB0cnkge1xuICAgICAgICBwcm9qZWN0UGF0aCA9IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcHJvamVjdFBhdGggPSAnJztcbiAgICB9XG4gICAgaWYgKCFwcm9qZWN0UGF0aCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgdGV4dDogJ2NvY29zX2xvZ3PvvJrmi7/kuI3liLDlt6XnqIvot6/lvoTvvIhgRWRpdG9yLlByb2plY3QucGF0aGAg5LiN5Y+v55So77yJ77yM5peg5rOV5a6a5L2N5pel5b+X55uu5b2V44CC5Y+v5Lul5pS555SoIGBmaWxlc2Ag57uZ57ud5a+56Lev5b6E44CCJyxcbiAgICAgICAgICAgIGVycm9yOiAn5ou/5LiN5Yiw5bel56iL6Lev5b6EJyxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBvcHRpb25zID0gbm9ybWFsaXplT3B0aW9ucyhwYXJhbXMsIHByb2plY3RQYXRoKTtcbiAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAob3B0aW9ucy5zaW5jZVJhdyAmJiBvcHRpb25zLnNpbmNlID09PSBudWxsKSB7XG4gICAgICAgIG5vdGVzLnB1c2goYFxcYHNpbmNlXFxgIOino+aekOS4jeS6hu+8iCR7b3B0aW9ucy5zaW5jZVJhd33vvInvvIzov5nkuIDmnaHooqvlv73nlaUg4oCU4oCUIOiupCBJU08g5pe26Ze05oiW5q+r56eS5pe26Ze05oiz44CCYCk7XG4gICAgfVxuXG4gICAgY29uc3QgeyBmaWxlcywgZGlycywgcHJvYmxlbXMgfSA9IGNvbGxlY3RGaWxlcyhvcHRpb25zLCBwcm9qZWN0UGF0aCk7XG5cbiAgICAvLyAtLS0tIOa4heepuu+8muWUr+S4gOS4gOS4quWGmeebmOWPo++8jOW/hemhu+aYvuW8j+ehruiupCAtLS0tXG4gICAgaWYgKG9wdGlvbnMuY2xlYXIpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMuY29uZmlybSAhPT0gQ0xFQVJfQ09ORklSTSkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgdGV4dDpcbiAgICAgICAgICAgICAgICAgICAgYGNvY29zX2xvZ3Mg6KaB5riF56m65pel5b+X5b6X5pi+5byP56Gu6K6k77yaYCArXG4gICAgICAgICAgICAgICAgICAgIGBjb2Nvc19sb2dzKHsgY2xlYXI6IHRydWUsIGNvbmZpcm06IFwiJHtDTEVBUl9DT05GSVJNfVwiIH0pYCArXG4gICAgICAgICAgICAgICAgICAgIGDvvIjkvJrmiormlofku7YqKuaIquaWreaIkCAwIOWtl+iKgioq77yM5LiN5piv5Yig5o6J77yJYCArXG4gICAgICAgICAgICAgICAgICAgIChmaWxlcy5sZW5ndGggPiAwID8gYOOAguacrOasoeS8mua4hSAke2ZpbGVzLmxlbmd0aH0g5Liq5paH5Lu277yaXFxuJHtmaWxlcy5tYXAoKGYpID0+IGAtICR7Zi5wYXRofe+8iCR7Zm9ybWF0Qnl0ZXMoZi5ieXRlcyl977yJYCkuam9pbignXFxuJyl9YCA6ICfjgIInKSxcbiAgICAgICAgICAgICAgICBlcnJvcjogJ2NsZWFyIOe8uuWwkSBjb25maXJtJyxcbiAgICAgICAgICAgICAgICBkYXRhOiB7IHByb2plY3RQYXRoLCBmaWxlczogZmlsZXMubWFwKChmKSA9PiBmLnBhdGgpIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHsgY2xlYXJlZCwgcHJvYmxlbXM6IGNsZWFyUHJvYmxlbXMgfSA9IGNsZWFyRmlsZXMoZmlsZXMpO1xuICAgICAgICBjb25zdCBsaW5lcyA9IFtcbiAgICAgICAgICAgIGDlt7LmuIXnqbogJHtjbGVhcmVkLmxlbmd0aH0g5Liq5pel5b+X5paH5Lu277yI5oiq5pat5oiQIDAg5a2X6IqC77yJ77yaYCxcbiAgICAgICAgICAgIC4uLmNsZWFyZWQubWFwKChpdGVtKSA9PiBgLSAke2l0ZW0ucGF0aH3vvIjljp8gJHtmb3JtYXRCeXRlcyhpdGVtLmJ5dGVzQmVmb3JlKX3vvIlgKSxcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYWxsUHJvYmxlbXMgPSBbLi4ucHJvYmxlbXMsIC4uLmNsZWFyUHJvYmxlbXNdO1xuICAgICAgICBpZiAoYWxsUHJvYmxlbXMubGVuZ3RoID4gMCkgbGluZXMucHVzaCgnJywgJ+KaoCDmnInpl67popjvvJonLCAuLi5hbGxQcm9ibGVtcy5tYXAoKGxpbmUpID0+IGAtICR7bGluZX1gKSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogY2xlYXJlZC5sZW5ndGggPiAwLFxuICAgICAgICAgICAgdGV4dDogbGluZXMuam9pbignXFxuJyksXG4gICAgICAgICAgICBlcnJvcjogY2xlYXJlZC5sZW5ndGggPiAwID8gdW5kZWZpbmVkIDogJ+ayoeaciea4heaOieS7u+S9leaWh+S7ticsXG4gICAgICAgICAgICBkYXRhOiB7IHByb2plY3RQYXRoLCBjbGVhcmVkLCBwcm9ibGVtczogYWxsUHJvYmxlbXMgfSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIOWIl+aWh+S7tu+8muWumuS9jVwi5pel5b+X5Yiw5bqV5Zyo5ZOqXCLov5nkuIDmraXljZXni6znu5nkuIDkuKrmoaMgLS0tLVxuICAgIGNvbnN0IGhlYWRlcjogc3RyaW5nW10gPSBbYOW3peeoi++8miR7cHJvamVjdFBhdGh9YCwgYOaJq+WIsOeahOebruW9le+8iCR7ZGlycy5sZW5ndGh9IOS4qu+8ie+8mmBdO1xuICAgIGZvciAoY29uc3QgZGlyIG9mIGRpcnMpIHtcbiAgICAgICAgaGVhZGVyLnB1c2goYC0gJHtkaXIuZXhpc3RzID8gJ+KckycgOiAn4pyXJ30gJHtkaXIucGF0aH0ke2Rpci5leGlzdHMgPyBg77yIJHtkaXIuZmlsZUNvdW50fSDkuKrml6Xlv5fmlofku7bvvIlgIDogJ++8iOS4jeWtmOWcqO+8iSd9YCk7XG4gICAgfVxuICAgIGlmIChkaXJzLmxlbmd0aCA9PT0gMCkgaGVhZGVyLnB1c2goJy0g77yI55So5LqGIGZpbGVzIOWPguaVsO+8jOayoeacieaJq+ebruW9le+8iScpO1xuXG4gICAgaWYgKGZpbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCB0ZXh0ID0gW1xuICAgICAgICAgICAgLi4uaGVhZGVyLFxuICAgICAgICAgICAgJycsXG4gICAgICAgICAgICAn5rKh5pyJ5Y+v6K+755qE5pel5b+X5paH5Lu244CCJyxcbiAgICAgICAgICAgICflj6/og73nmoTljp/lm6DvvJrnvJbovpHlmajov5jmsqHlhpnov4fml6Xlv5fvvIhgcHJvamVjdC5sb2dgIOWtmOWcqOS9huS4uiAwIOWtl+iKguaYr+ato+W4uOeahO+8ie+8mycsXG4gICAgICAgICAgICAn5oiW5pel5b+X5Zyo5Yir5aSEIOKAlOKAlCDnlKggYGRpcmDvvIjkuIDkuKrnu53lr7nnm67lvZXvvInmiJYgYGZpbGVzYO+8iOiLpeW5sue7neWvueaWh+S7tui3r+W+hO+8ieebtOaOpeeCueWQjeOAgicsXG4gICAgICAgICAgICAuLi4ocHJvYmxlbXMubGVuZ3RoID4gMCA/IFsnJywgJ+KaoCDov4fnqIvkuK3nmoTpl67popjvvJonLCAuLi5wcm9ibGVtcy5tYXAoKGxpbmUpID0+IGAtICR7bGluZX1gKV0gOiBbXSksXG4gICAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgdGV4dCwgZXJyb3I6ICfmsqHmnInmib7liLDml6Xlv5fmlofku7YnLCBkYXRhOiB7IHByb2plY3RQYXRoLCBkaXJzLCBmaWxlczogW10sIHByb2JsZW1zIH0gfTtcbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy5saXN0KSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBbXG4gICAgICAgICAgICAuLi5oZWFkZXIsXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgIGDml6Xlv5fmlofku7YgJHtmaWxlcy5sZW5ndGh9IOS4qu+8iOaMieS/ruaUueaXtumXtOWAkuW6j++8ie+8mmAsXG4gICAgICAgICAgICAuLi5maWxlcy5tYXAoKGZpbGUpID0+IGAtICR7ZmlsZS5pZH0gJHtmaWxlLnBhdGh9ICAke2Zvcm1hdEJ5dGVzKGZpbGUuYnl0ZXMpfSAgJHtmaWxlLm1vZGlmaWVkQXR9YCksXG4gICAgICAgICAgICAuLi4ocHJvYmxlbXMubGVuZ3RoID4gMCA/IFsnJywgJ+KaoCDov4fnqIvkuK3nmoTpl67popjvvJonLCAuLi5wcm9ibGVtcy5tYXAoKGxpbmUpID0+IGAtICR7bGluZX1gKV0gOiBbXSksXG4gICAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXh0LCBkYXRhOiB7IHByb2plY3RQYXRoLCBkaXJzLCBmaWxlcywgcHJvYmxlbXMgfSB9O1xuICAgIH1cblxuICAgIC8vIC0tLS0g6K+76KGMICsg562b6KGMIC0tLS1cbiAgICBjb25zdCBmaWx0ZXIgPSBtYWtlTGluZUZpbHRlcihvcHRpb25zKTtcbiAgICBpZiAoZmlsdGVyLmVycm9yKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICB0ZXh0OiBgY29jb3NfbG9nc++8miR7ZmlsdGVyLmVycm9yfVxcbu+8iOaKiiByZWdleCDlhbPmjonlsLHmmK/mjInlrZDkuLLmib7vvIznibnmrorlrZfnrKbkuI3nlKjovazkuYnjgILvvIlgLFxuICAgICAgICAgICAgZXJyb3I6IGZpbHRlci5lcnJvcixcbiAgICAgICAgICAgIGRhdGE6IHsgcHJvamVjdFBhdGgsIGRpcnMsIGZpbGVzOiBmaWxlcy5tYXAoKGYpID0+IGYucGF0aCkgfSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBoaXRzOiBMb2dIaXRbXSA9IFtdO1xuICAgIGNvbnN0IGZpbGVTdGF0czogQXJyYXk8eyBmaWxlOiBMb2dGaWxlOyBtYXRjaGVkOiBudW1iZXI7IHNob3duOiBudW1iZXI7IHNraXBwZWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+ID0gW107XG4gICAgbGV0IHRydW5jYXRlZFRleHQgPSBmYWxzZTtcblxuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICBpZiAob3B0aW9ucy5zaW5jZSAhPT0gbnVsbCAmJiBuZXcgRGF0ZShmaWxlLm1vZGlmaWVkQXQucmVwbGFjZSgnICcsICdUJykpLmdldFRpbWUoKSA8IG9wdGlvbnMuc2luY2UpIHtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog5paH5Lu25pW05L2T5q+UIGBzaW5jZWAg6L+Y5penIOKHkiDph4zpnaLkuI3lj6/og73mnInmm7TmlrDnmoTooYzjgIJcbiAgICAgICAgICAgICAqIOeUqCoq5paH5Lu25L+u5pS55pe26Ze0KirlhYjnrZvkuIDliIDmmK/lronlhajnmoTvvJrml6Xlv5flj6rkvJrlvoDlkI7ov73liqDjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZmlsZVN0YXRzLnB1c2goeyBmaWxlLCBtYXRjaGVkOiAwLCBzaG93bjogMCwgc2tpcHBlZDogYOacgOWQjuS/ruaUueaXtumXtOaXqeS6jiBzaW5jZWAgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgbGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZWFkID0gcmVhZFRhaWxMaW5lcyhmaWxlLnBhdGgpO1xuICAgICAgICAgICAgbGluZXMgPSByZWFkLmxpbmVzO1xuICAgICAgICAgICAgZmlsZS5yZWFkQnl0ZXMgPSByZWFkLnJlYWRCeXRlcztcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGZpbGVTdGF0cy5wdXNoKHsgZmlsZSwgbWF0Y2hlZDogMCwgc2hvd246IDAsIGVycm9yOiBkZXNjcmliZShlcnJvcikgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG1hdGNoZWQ6IExvZ0hpdFtdID0gW107XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTtcbiAgICAgICAgICAgIGlmICghZmlsdGVyLnRlc3QobGluZSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc2luY2UgIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0cyA9IHBhcnNlTGluZVRpbWUobGluZSk7XG4gICAgICAgICAgICAgICAgLy8g6KGM6YeM5rKh5pyJ5pe26Ze05oiz5bCxKirkv53nlZkqKu+8iOWugeWPr+Wkmue7meS4gOihjO+8jOS5n+S4jeimgeWboOS4uuagvOW8j+S4jeiupOivhuiAjOa8j+aOieeOsOWcuu+8iVxuICAgICAgICAgICAgICAgIGlmICh0cyAhPT0gbnVsbCAmJiB0cyA8IG9wdGlvbnMuc2luY2UpIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbWF0Y2hlZC5wdXNoKHsgZmlsZTogZmlsZS5pZCwgbGluZTogaSArIDEsIHRleHQ6IGxpbmUgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc2hvd24gPSBtYXRjaGVkLnNsaWNlKC1vcHRpb25zLnRhaWwpO1xuICAgICAgICBmaWxlU3RhdHMucHVzaCh7IGZpbGUsIG1hdGNoZWQ6IG1hdGNoZWQubGVuZ3RoLCBzaG93bjogc2hvd24ubGVuZ3RoIH0pO1xuICAgICAgICBoaXRzLnB1c2goLi4uc2hvd24pO1xuICAgIH1cblxuICAgIC8vIC0tLS0g57uE6KOF5paH5qGI77yI5oyJ5paH5Lu25YiG57uE77yM6KGM5Y+35pivKiror6Xmlofku7bph4znmoTooYzlj7cqKu+8iS0tLS1cbiAgICBjb25zdCBib2R5OiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBjaGFycyA9IDA7XG4gICAgZm9yIChjb25zdCBzdGF0IG9mIGZpbGVTdGF0cykge1xuICAgICAgICBjb25zdCBtaW5lID0gaGl0cy5maWx0ZXIoKGhpdCkgPT4gaGl0LmZpbGUgPT09IHN0YXQuZmlsZS5pZCk7XG4gICAgICAgIGNvbnN0IHN1ZmZpeCA9IHN0YXQuZXJyb3JcbiAgICAgICAgICAgID8gYOivu+Wksei0pe+8miR7c3RhdC5lcnJvcn1gXG4gICAgICAgICAgICA6IHN0YXQuc2tpcHBlZFxuICAgICAgICAgICAgICA/IGDot7Pov4fvvJoke3N0YXQuc2tpcHBlZH1gXG4gICAgICAgICAgICAgIDogYOWRveS4rSAke3N0YXQubWF0Y2hlZH0g6KGMJHtzdGF0LnNob3duIDwgc3RhdC5tYXRjaGVkID8gYO+8jOWPquaYvuekuuacgOWQjiAke3N0YXQuc2hvd259IOihjGAgOiAnJ31gO1xuICAgICAgICBjb25zdCB0YWlsZWQgPSBzdGF0LmZpbGUuYnl0ZXMgPiBMT0dfVEFJTF9CWVRFUyAmJiBzdGF0LmZpbGUucmVhZEJ5dGVzID4gMCA/ICcg44CU5bey5bC+6K+744CVJyA6ICcnO1xuICAgICAgICBib2R5LnB1c2goYCR7c3RhdC5maWxlLmlkfSAke3N0YXQuZmlsZS5wYXRofSAgJHtmb3JtYXRCeXRlcyhzdGF0LmZpbGUuYnl0ZXMpfSAgJHtzdGF0LmZpbGUubW9kaWZpZWRBdH0gICR7c3VmZml4fSR7dGFpbGVkfWApO1xuICAgICAgICBmb3IgKGNvbnN0IGhpdCBvZiBtaW5lKSB7XG4gICAgICAgICAgICBjb25zdCBsaW5lID0gYCR7c3RhdC5maWxlLmlkfToke2hpdC5saW5lfSAgJHtoaXQudGV4dH1gO1xuICAgICAgICAgICAgaWYgKGNoYXJzICsgbGluZS5sZW5ndGggPiBNQVhfVEVYVF9DSEFSUykge1xuICAgICAgICAgICAgICAgIHRydW5jYXRlZFRleHQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2hhcnMgKz0gbGluZS5sZW5ndGggKyAxO1xuICAgICAgICAgICAgYm9keS5wdXNoKGxpbmUpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0cnVuY2F0ZWRUZXh0KSBicmVhaztcbiAgICAgICAgYm9keS5wdXNoKCcnKTtcbiAgICB9XG5cbiAgICBjb25zdCB0YWlsTm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHRydW5jYXRlZFRleHQpIHRhaWxOb3Rlcy5wdXNoKGDmraPmlofotoXov4cgJHtNQVhfVEVYVF9DSEFSU30g5a2X56ym6aKE566X77yM5ZCO6Z2i55qE6KGM5rKh5Zue77yI57yp5bCPIGdyZXAg5oiW6LCD5bCPIHRhaWwg5YaN6K+V77yJYCk7XG4gICAgaWYgKGZpbGVzLnNvbWUoKGZpbGUpID0+IGZpbGUuYnl0ZXMgPiBMT0dfVEFJTF9CWVRFUykpIHtcbiAgICAgICAgdGFpbE5vdGVzLnB1c2goYOacieaWh+S7tuWkp+S6jiAke2Zvcm1hdEJ5dGVzKExPR19UQUlMX0JZVEVTKX3vvIzlj6ror7vkuoYqKuWwvumDqCoq77yI6KGM5Y+35piv5bC+6K+756qX5Y+j5YaF55qE6KGM5Y+377yM5LiN5piv5YWo5paH5Lu26KGM5Y+377yJYCk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLmdyZXApIHRhaWxOb3Rlcy5wdXNoKGDnrZvpgInvvJoke29wdGlvbnMucmVnZXggPyAn5q2j5YiZJyA6ICflrZDkuLInfSAvICR7b3B0aW9ucy5jYXNlU2Vuc2l0aXZlID8gJ+WMuuWIhuWkp+Wwj+WGmScgOiAn5LiN5Yy65YiG5aSn5bCP5YaZJ31gKTtcbiAgICBjb25zdCB0b3RhbE1hdGNoZWQgPSBmaWxlU3RhdHMucmVkdWNlKChzdW0sIHN0YXQpID0+IHN1bSArIHN0YXQubWF0Y2hlZCwgMCk7XG4gICAgaWYgKHRvdGFsTWF0Y2hlZCA9PT0gMCkgdGFpbE5vdGVzLnB1c2goJ+ayoeacieS7u+S9leihjOWRveS4reetm+mAieadoeS7tu+8iOaWh+S7tuaYr+ivu+WIsOS6hueahO+8jOingeS4iumdouavj+S4quaWh+S7tueahOWRveS4reaVsO+8iScpO1xuXG4gICAgY29uc3QgdGV4dCA9IFtcbiAgICAgICAgLi4uaGVhZGVyLFxuICAgICAgICAnJyxcbiAgICAgICAgYOaXpeW/l+aWh+S7tiAke2ZpbGVzLmxlbmd0aH0g5Liq77yM5ZG95LitICR7dG90YWxNYXRjaGVkfSDooYzvvJpgLFxuICAgICAgICAnJyxcbiAgICAgICAgLi4uYm9keSxcbiAgICAgICAgLi4uKHRhaWxOb3Rlcy5sZW5ndGggPiAwID8gWyfimqAg6K+05piO77yaJywgLi4udGFpbE5vdGVzLm1hcCgobGluZSkgPT4gYC0gJHtsaW5lfWApXSA6IFtdKSxcbiAgICAgICAgLi4uKHByb2JsZW1zLmxlbmd0aCA+IDAgfHwgbm90ZXMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBbJycsICfimqAg5YW25LuW77yaJywgLi4uWy4uLm5vdGVzLCAuLi5wcm9ibGVtc10ubWFwKChsaW5lKSA9PiBgLSAke2xpbmV9YCldXG4gICAgICAgICAgICA6IFtdKSxcbiAgICBdLmpvaW4oJ1xcbicpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHRleHQsXG4gICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgIHByb2plY3RQYXRoLFxuICAgICAgICAgICAgZGlycyxcbiAgICAgICAgICAgIGZpbGVzOiBmaWxlU3RhdHMubWFwKChzdGF0KSA9PiAoe1xuICAgICAgICAgICAgICAgIGlkOiBzdGF0LmZpbGUuaWQsXG4gICAgICAgICAgICAgICAgcGF0aDogc3RhdC5maWxlLnBhdGgsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IHN0YXQuZmlsZS5ieXRlcyxcbiAgICAgICAgICAgICAgICByZWFkQnl0ZXM6IHN0YXQuZmlsZS5yZWFkQnl0ZXMsXG4gICAgICAgICAgICAgICAgbW9kaWZpZWRBdDogc3RhdC5maWxlLm1vZGlmaWVkQXQsXG4gICAgICAgICAgICAgICAgbWF0Y2hlZDogc3RhdC5tYXRjaGVkLFxuICAgICAgICAgICAgICAgIHNob3duOiBzdGF0LnNob3duLFxuICAgICAgICAgICAgICAgIC4uLihzdGF0LnNraXBwZWQgPyB7IHNraXBwZWQ6IHN0YXQuc2tpcHBlZCB9IDoge30pLFxuICAgICAgICAgICAgICAgIC4uLihzdGF0LmVycm9yID8geyBlcnJvcjogc3RhdC5lcnJvciB9IDoge30pLFxuICAgICAgICAgICAgfSkpLFxuICAgICAgICAgICAgbWF0Y2hlczogaGl0cyxcbiAgICAgICAgICAgIHRydW5jYXRlZDogdHJ1bmNhdGVkVGV4dCxcbiAgICAgICAgICAgIHByb2JsZW1zLFxuICAgICAgICB9LFxuICAgIH07XG59XG4iXX0=