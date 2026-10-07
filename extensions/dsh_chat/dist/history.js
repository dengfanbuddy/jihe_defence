"use strict";
/**
 * 历史会话：把 DSH 的会话日志**列出来**、**读回来**。
 *
 * ## 日志在哪、长什么样
 *
 * ```
 * <DSH_HOME>/sessions/<工程键>/<会话 id>/session[.v4].jsonl.zstd
 * ```
 *
 * 「工程键」是 DSH 的 `projectKey(cwd)`（`D:\Project\cocos\jihe_defence` →
 * `--D-Project-cocos-jihe_defence--`）。文件是 **zstd 拼接帧**容器。
 *
 * ## 为什么要 spawn 一个 node 子进程来读
 *
 * 解压要 `node:zlib` 的 zstd API，那是 **Node ≥ 22.15** 才有的；而**编辑器主进程跑在
 * Electron 31（Node 20.15）里，没有这个 API**。所以解压这件事只能交给外面那个 node
 * （`paths.ts` 探测出来的、也是用来跑 dsh 的那个），主进程只负责「找到文件、决定读哪个」。
 * 真正干活的脚本是 `scripts/session-log.js`（帧扫描照抄 DSH 的实现，见那边的注释）。
 *
 * ## 为什么不用 DSH 自己的接口
 *
 * SDK profile 的协议只有 `initialize` / `session/prompt` / `shutdown`：
 * **没有任何「列会话 / 读日志」的方法**（`dsh-session-query`、`dsh-session-log-export`
 * 这些包都是给宿主进程内部的 cordis 上下文用的，不是给 SDK 客户端的）。
 * 好在日志是**明文可读的 JSONL**，直接读盘反而更稳：**agent 没在跑的时候也能看历史**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectKey = projectKey;
exports.sessionsRoot = sessionsRoot;
exports.listHistory = listHistory;
exports.readHistory = readHistory;
exports.titleOfEvents = titleOfEvents;
exports.loggedTitleOf = loggedTitleOf;
exports.searchHistory = searchHistory;
exports.exportHistory = exportHistory;
exports.deleteHistory = deleteHistory;
const child_process_1 = require("child_process");
const os_1 = require("os");
const path_1 = require("path");
/** 单次 spawn 的上限：读 5MB 日志实测亚秒级，给足余量。 */
const READER_TIMEOUT_MS = 20000;
/**
 * DSH 的工程键（**照抄** `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey`）。
 *
 * 规则：`/` `\` `:` 折叠成一个 `-`；`[A-Za-z0-9._-]` 原样；其余字符转义成 `~XXXX`（大写十六进制）；
 * 最后包成 `--…--`，截断到 251 字符。
 *
 * @param cwd - 工程根目录。
 * @returns 会话根目录下的工程子目录名。
 */
function projectKey(cwd) {
    if (!cwd)
        throw new Error('projectKey：工程路径是空的');
    let readable = '';
    let separatorRun = false;
    for (let index = 0; index < cwd.length; index += 1) {
        const code = cwd.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun)
                readable += '-';
            separatorRun = true;
        }
        else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        }
        else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
/** `<DSH_HOME>/sessions`（`DSH_HOME` 没设就按 `~/.dsh`，与 DSH 自己同口径）。 */
function sessionsRoot() {
    var _a;
    const home = (_a = process.env.DSH_HOME) === null || _a === void 0 ? void 0 : _a.trim();
    return (0, path_1.join)(home && home !== '' ? home : (0, path_1.join)((0, os_1.homedir)(), '.dsh'), 'sessions');
}
/** 读取器脚本的路径（`dist/history.js` → `<扩展根>/scripts/session-log.js`）。 */
function readerPath() {
    return (0, path_1.resolve)(__dirname, '..', 'scripts', 'session-log.js');
}
/** 把异常收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 跑一次读取器，返回它 stdout 上那行 JSON。
 *
 * ⚠ 参数用**数组**传（不经 shell）：工程键本身以 `--` 开头，任何字符串拼接/命令行解析都会踩坑。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param args - 子命令与开关。
 * @param timeoutMs - 这一次的上限（搜索/导出比列表慢，各有各的尺度）。
 */
function runReader(nodeExe, args, timeoutMs = READER_TIMEOUT_MS) {
    return new Promise((resolvePromise, rejectPromise) => {
        var _a, _b, _c, _d;
        let child;
        try {
            child = (0, child_process_1.spawn)(nodeExe, [readerPath(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            rejectPromise(new Error(`启动 node 读会话日志失败：${describe(error)}`));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill();
            }
            catch {
                /* 已经退了 */
            }
            rejectPromise(new Error(`读会话日志超时（${timeoutMs}ms）`));
        }, timeoutMs);
        (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding('utf8');
        (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.setEncoding('utf8');
        (_c = child.stdout) === null || _c === void 0 ? void 0 : _c.on('data', (chunk) => {
            stdout += chunk;
            // 一份日志的投影不该超过这个量级；超了就是哪儿不对，别把主进程撑爆
            if (stdout.length > 64 * 1024 * 1024) {
                try {
                    child.kill();
                }
                catch {
                    /* 忽略 */
                }
            }
        });
        (_d = child.stderr) === null || _d === void 0 ? void 0 : _d.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new Error(`读会话日志失败：${describe(error)}`));
        });
        child.on('close', () => {
            var _a;
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const line = (_a = stdout.trim().split('\n').pop()) !== null && _a !== void 0 ? _a : '';
            try {
                resolvePromise(JSON.parse(line));
            }
            catch {
                rejectPromise(new Error(`读会话日志的输出不是 JSON：${line.slice(0, 200) || '(空)'}` +
                    (stderr ? `；stderr：${stderr.trim().slice(0, 200)}` : '')));
            }
        });
    });
}
/** 缺 node 时的统一文案（这不是「没装 dsh」那么明显，说清楚为什么读不了）。 */
const NO_NODE_HINT = '读会话日志需要一个 **Node ≥ 22.15**（日志是 zstd 压缩的，编辑器自带的 Electron/Node 20 解不开）。' +
    '请在设置里填「node 路径」，或把 node 加到 PATH。';
/**
 * 列出本工程的历史会话（按最后修改时间倒序）。
 *
 * @param nodeExe - 用来跑读取器的 node（`paths.ts` 探测出来的那个）。
 * @param cwd - 工程根目录。
 * @param limit - 最多几条。
 * @returns `{ok, sessions?, error?}`；失败不抛，让面板能显示原因。
 */
async function listHistory(nodeExe, cwd, limit = 20) {
    var _a;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    try {
        const payload = await runReader(nodeExe, [
            'list',
            '--root',
            sessionsRoot(),
            '--project',
            projectKey(cwd),
            '--limit',
            String(limit),
        ]);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '读取器返回失败') };
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        return { ok: true, sessions };
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/**
 * 读一个会话的事件（回放用）。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param cwd - 工程根目录。
 * @param sessionId - 会话 id。
 * @param maxEvents - 最多保留多少条（从尾部保留）。
 * @returns `{ok, events?, error?}`。
 */
async function readHistory(nodeExe, cwd, sessionId, maxEvents = 2000) {
    var _a, _b;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    if (!sessionId)
        return { ok: false, error: 'readHistory：会话 id 是空的' };
    try {
        const payload = await runReader(nodeExe, [
            'read',
            '--root',
            sessionsRoot(),
            '--project',
            projectKey(cwd),
            '--id',
            sessionId,
            '--max-events',
            String(maxEvents),
        ]);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '读取器返回失败') };
        return {
            ok: true,
            header: ((_b = payload.header) !== null && _b !== void 0 ? _b : null),
            events: Array.isArray(payload.events) ? payload.events : [],
            total: typeof payload.total === 'number' ? payload.total : undefined,
            frameCount: typeof payload.frameCount === 'number' ? payload.frameCount : undefined,
            torn: payload.torn === true,
        };
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/**
 * 从事件流里取一条「像标题」的首条用户消息（列表接口给了标题，回放路径要自己算一遍）。
 *
 * ⚠ **这条回退现在很少被用到了**：会话日志里本来就有权威标题（`session/title` 事件，
 * 由 `dsh-session-title` 追加），`session-log.js` 已经把它一起投影出来 ——
 * 优先用 `titleOfEvents` 上面那个 `loggedTitleOf`。这一条保留给「旧日志里没有
 * `session/title`」的情况（本 profile 早期跑出来的会话）。
 *
 * @param events - `readHistory` 返回的事件。
 * @returns 标题（最多 80 字）；取不到返回空串。
 */
function titleOfEvents(events) {
    var _a, _b, _c;
    for (const event of events) {
        if (event.type !== 'user/message')
            continue;
        const data = ((_a = event.data) !== null && _a !== void 0 ? _a : {});
        const source = data.source;
        if (source && source.kind !== 'user')
            continue;
        const content = ((_b = data.content) !== null && _b !== void 0 ? _b : (_c = data.message) === null || _c === void 0 ? void 0 : _c.content);
        if (!Array.isArray(content))
            continue;
        const text = content
            .filter((block) => {
            const candidate = block;
            return (candidate === null || candidate === void 0 ? void 0 : candidate.type) === 'text' && typeof candidate.text === 'string';
        })
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text)
            return text.slice(0, 80);
    }
    return '';
}
/**
 * 从事件流里取**会话日志自己记的**标题（`session/title`，最新一条胜出）。
 *
 * 为什么优先它而不是首条用户消息：`dsh-session-title` 会把标题规范化（清控制字符、
 * 按字节安全截断），而 `session-title-llm` 打开后还会补一条**模型生成**的修订
 * （「较新的修订取代旧的」是服务自己的保证）。首条用户消息只是它的兜底来源。
 *
 * @param events - `readHistory` 返回的事件。
 * @returns 标题；没有则空串。
 */
function loggedTitleOf(events) {
    var _a;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'session/title')
            continue;
        const data = ((_a = event.data) !== null && _a !== void 0 ? _a : {});
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title)
            return title.slice(0, 120);
    }
    return '';
}
/** 搜索的时间上限：给脚本自己的 `budgetMs` 留足余量（它还要解压、投影、排序）。 */
const SEARCH_TIMEOUT_SLACK_MS = 30000;
/**
 * 在**所有**会话日志里做字面子串全文搜索。
 *
 * 三条口径（都写在 `session-log.js` 的 `searchSessions` 旁边，这里只重复最要紧的）：
 * 1. **字面子串**（大小写不敏感、空白弹性），不是分词 —— 中文按字断词才搜得到；
 * 2. **有预算**，而且**如实报告覆盖率**（`partial` / `stoppedBy` / `scanned` / `available`）；
 * 3. **会话按最后修改时间倒序走**，所以停下来时手里是「最新的 N 条匹配」。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param cwd - 工程根目录。
 * @param query - 查询串（1~200 字；空白切成多个词，词之间是 AND）。
 * @param options - 预算。
 * @returns 命中列表与覆盖率；失败不抛。
 */
async function searchHistory(nodeExe, cwd, query, options = {}) {
    var _a, _b;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text)
        return { ok: false, error: '搜索词是空的' };
    if (text.length > 200)
        return { ok: false, error: '搜索词太长了（最多 200 字）' };
    const args = [
        'search',
        '--root',
        sessionsRoot(),
        '--project',
        projectKey(cwd),
        '--query',
        text,
    ];
    const push = (flag, value) => {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
            args.push(flag, String(Math.floor(value)));
    };
    push('--limit', options.limit);
    push('--per-session', options.perSession);
    push('--max-sessions', options.maxSessions);
    push('--max-bytes', options.maxBytes);
    push('--budget-ms', options.budgetMs);
    try {
        const payload = await runReader(nodeExe, args, ((_a = options.budgetMs) !== null && _a !== void 0 ? _a : 6000) + SEARCH_TIMEOUT_SLACK_MS);
        if (payload.ok !== true)
            return { ok: false, error: String((_b = payload.error) !== null && _b !== void 0 ? _b : '搜索失败') };
        return {
            ok: true,
            query: typeof payload.query === 'string' ? payload.query : text,
            hits: Array.isArray(payload.hits) ? payload.hits : [],
            scanned: numberOrUndefined(payload.scanned),
            available: numberOrUndefined(payload.available),
            partial: payload.partial === true,
            stoppedBy: typeof payload.stoppedBy === 'string' ? payload.stoppedBy : null,
            elapsedMs: numberOrUndefined(payload.elapsedMs),
            scannedBytes: numberOrUndefined(payload.scannedBytes),
        };
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/** 把「可能是数字」的值收敛成 number | undefined。 */
function numberOrUndefined(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/**
 * 把一条会话导出成文件。
 *
 * 落在 `<DSH_HOME>/exports/<工程键>/`（**不往工程目录里写**：导出物是「看一眼就删」
 * 的东西，扔进工程只会污染 git）。`md` / `jsonl` 两条路**不带图片像素** ——
 * 它们按内容存在 `<DSH_HOME>/attachments`，跨会话去重共用；想要像素就走 `zip`
 * （`--with-media`），那一份会把引用到的图一起打进去。
 *
 * ## `zip` 那一路（2026-12 加）为什么值得单独一档
 *
 * 它是**对齐 DSH 官方导出**的那一份布局（`dsh-session-log-export` 的产物）：
 * 别人拿到这个 zip 能用同一套工具读。代价是**慢**（要解压子孙会话日志 + 读一堆附件），
 * 所以它是**显式的一档**（面板上一个单独的按钮），不是给 md 加两个开关。
 *
 * ⚠ 那条路有一句必须带出来的话：**当前活跃会话可能少最后几条** ——
 * DSH 自己导出前会先 `flush`，而我们只是读静态文件（读的时候用 stat→读→stat 复检，
 * 不稳定就如实写在 `notes` 里）。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param cwd - 工程根目录。
 * @param sessionId - 会话 id。
 * @param format - `md` / `jsonl` / `zip`。
 * @param options.withSubagents - zip 那一路是否带子孙（默认 true）。
 * @param options.withMedia - zip 那一路是否带附件像素（默认 true）。
 * @returns 写出的路径与体积；失败不抛。
 */
async function exportHistory(nodeExe, cwd, sessionId, format = 'md', options = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id)
        return { ok: false, error: 'exportHistory：会话 id 是空的' };
    const zip = format === 'zip';
    try {
        const args = [
            'export',
            '--root',
            sessionsRoot(),
            '--project',
            projectKey(cwd),
            '--id',
            id,
            '--format',
            zip ? 'zip' : format === 'jsonl' ? 'jsonl' : 'md',
        ];
        if (zip) {
            // CLI 侧 zip 默认就带这两样；显式写出来是为了让「面板点了什么」与「脚本收到什么」一一对得上
            if (options.withSubagents !== false)
                args.push('--with-subagents');
            if (options.withMedia !== false)
                args.push('--with-media');
        }
        // zip 要解压子孙日志 + 读附件，比 md 慢得多（本机一条几千轮的会话实测秒级到十几秒）
        const payload = await runReader(nodeExe, args, zip ? 300000 : 120000);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '导出失败') };
        const result = {
            ok: true,
            id: typeof payload.id === 'string' ? payload.id : id,
            title: typeof payload.title === 'string' ? payload.title : '',
            format: typeof payload.format === 'string' ? payload.format : format,
            path: typeof payload.path === 'string' ? payload.path : '',
            dir: typeof payload.dir === 'string' ? payload.dir : '',
            bytes: numberOrUndefined(payload.bytes),
            events: numberOrUndefined(payload.events),
        };
        if (Array.isArray(payload.notes) && payload.notes.length > 0) {
            result.notes = payload.notes.filter((line) => typeof line === 'string');
        }
        if (Array.isArray(payload.missingMedia) && payload.missingMedia.length > 0) {
            result.missingMedia = payload.missingMedia.filter((line) => typeof line === 'string');
        }
        const rawSubs = payload.subagents;
        if (rawSubs && typeof rawSubs === 'object') {
            const subs = rawSubs;
            result.subagents = {
                total: (_b = numberOrUndefined(subs.total)) !== null && _b !== void 0 ? _b : 0,
                subagentCount: (_c = numberOrUndefined(subs.subagentCount)) !== null && _c !== void 0 ? _c : 0,
                forkCount: (_d = numberOrUndefined(subs.forkCount)) !== null && _d !== void 0 ? _d : 0,
                maxDepth: (_e = numberOrUndefined(subs.maxDepth)) !== null && _e !== void 0 ? _e : null,
                dangling: Array.isArray(subs.dangling) ? subs.dangling.filter((x) => typeof x === 'string') : [],
                incomplete: subs.incomplete === true,
            };
        }
        const rawMedia = payload.media;
        if (rawMedia && typeof rawMedia === 'object') {
            const media = rawMedia;
            result.media = {
                count: (_f = numberOrUndefined(media.count)) !== null && _f !== void 0 ? _f : 0,
                missing: (_g = numberOrUndefined(media.missing)) !== null && _g !== void 0 ? _g : 0,
                namingDeviation: typeof media.namingDeviation === 'string' ? media.namingDeviation : null,
            };
        }
        const rawZip = payload.zip;
        if (rawZip && typeof rawZip === 'object') {
            const facts = rawZip;
            result.zip = {
                fileName: typeof facts.fileName === 'string' ? facts.fileName : '',
                entries: (_h = numberOrUndefined(facts.entries)) !== null && _h !== void 0 ? _h : 0,
            };
        }
        return result;
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/**
 * 删掉一条会话（**只删会话目录本身**，附件默认不碰）。
 *
 * `dryRun` 那趟只为拿清单（面板拿它做二次确认：「将删除 1 个文件 · 1.7 MB」），
 * 真删是第二次点击 —— 一次点错就把一段历史抹了，这个险不值得冒。
 *
 * ## 附件回收（`reclaimAttachments`，**默认关**）
 *
 * 附件（图片）按内容存在 `<DSH_HOME>/attachments/v1/objects/…`，**跨会话去重共用**，
 * DSH 自己也不回收。所以默认删除**不会**动它们，也不会因此腾出图片占的空间 ——
 * 面板上必须说这句话。
 *
 * 打开这个开关时，脚本会在**删目录之前**算一遍「这条会话引用的附件里，哪些全库没人再引用」，
 * 然后把它们**搬进墓碑**（`attachments/v1/.trash-<日期>/`，同盘 rename，**永不 unlink**）。
 * 三条硬口径（都在脚本里，别在面板上重新发明）：
 * ① **超预算 = 一个都不搬**（`incomplete: true`，fail-closed）；
 * ② 每个候选都要**复算 sha256 与 bytes** 对得上才搬；
 * ③ 时间窗（最近 1 小时动过的对象跳过 —— 别的进程可能刚写、日志还没落盘）。
 *
 * ⚠ 它的**耗时是分钟级**（本机 498 条会话 / 569 MB 全库扫描：解压 60.8s + 解析 8.2s），
 * 所以面板上要**先说要等 1~2 分钟**，而不是让人以为按下去没反应。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param cwd - 工程根目录。
 * @param sessionId - 会话 id。
 * @param dryRun - 只报清单不动盘。
 * @param options.reclaimAttachments - 顺带回收无引用附件（默认关）。
 * @returns 清单与是否真删了；失败不抛。
 */
async function deleteHistory(nodeExe, cwd, sessionId, dryRun = false, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id)
        return { ok: false, error: 'deleteHistory：会话 id 是空的' };
    const reclaim = options.reclaimAttachments === true;
    try {
        const args = ['delete', '--root', sessionsRoot(), '--project', projectKey(cwd), '--id', id];
        if (dryRun)
            args.push('--dry-run');
        if (reclaim)
            args.push('--reclaim-attachments');
        // 带回收时是**分钟级**：超时给足（脚本自己还有一层预算，这里只是别把它掐死）
        const payload = await runReader(nodeExe, args, reclaim ? 300000 : 60000);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '删除失败') };
        const result = {
            ok: true,
            id: typeof payload.id === 'string' ? payload.id : id,
            dir: typeof payload.dir === 'string' ? payload.dir : '',
            removed: payload.removed === true,
            fileCount: numberOrUndefined(payload.fileCount),
            bytes: numberOrUndefined(payload.bytes),
        };
        const rawReclaim = payload.reclaim;
        if (rawReclaim && typeof rawReclaim === 'object') {
            const facts = rawReclaim;
            const scanned = ((_b = facts.scanned) !== null && _b !== void 0 ? _b : {});
            result.reclaim = {
                dryRun: facts.dryRun === true,
                candidates: (_c = numberOrUndefined(facts.candidates)) !== null && _c !== void 0 ? _c : 0,
                referenced: (_d = numberOrUndefined(facts.referenced)) !== null && _d !== void 0 ? _d : 0,
                orphans: (_e = numberOrUndefined(facts.orphans)) !== null && _e !== void 0 ? _e : 0,
                trashed: (_f = numberOrUndefined(facts.trashed)) !== null && _f !== void 0 ? _f : 0,
                bytesFreed: (_g = numberOrUndefined(facts.bytesFreed)) !== null && _g !== void 0 ? _g : 0,
                incomplete: facts.incomplete === true,
                incompleteReason: typeof facts.incompleteReason === 'string' ? facts.incompleteReason : null,
                scanned: {
                    sessions: (_h = numberOrUndefined(scanned.sessions)) !== null && _h !== void 0 ? _h : 0,
                    bytes: (_j = numberOrUndefined(scanned.bytes)) !== null && _j !== void 0 ? _j : 0,
                    elapsedMs: (_k = numberOrUndefined(scanned.elapsedMs)) !== null && _k !== void 0 ? _k : 0,
                },
                skipped: Array.isArray(facts.skipped)
                    ? facts.skipped
                        .filter((entry) => Boolean(entry) && typeof entry === 'object')
                        .map((entry) => { var _a, _b; return ({ id: String((_a = entry.id) !== null && _a !== void 0 ? _a : ''), reason: String((_b = entry.reason) !== null && _b !== void 0 ? _b : '') }); })
                    : [],
                trashDir: typeof facts.trashDir === 'string' ? facts.trashDir : '',
            };
        }
        return result;
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGlzdG9yeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9oaXN0b3J5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXlCRzs7QUFrREgsZ0NBbUJDO0FBR0Qsb0NBR0M7QUF5R0Qsa0NBc0JDO0FBV0Qsa0NBZ0NDO0FBYUQsc0NBb0JDO0FBWUQsc0NBU0M7QUFpREQsc0NBOENDO0FBc0hELHNDQWdGQztBQStCRCxzQ0F3REM7QUFycUJELGlEQUFzQztBQUN0QywyQkFBNkI7QUFDN0IsK0JBQXFDO0FBa0NyQyx1Q0FBdUM7QUFDdkMsTUFBTSxpQkFBaUIsR0FBRyxLQUFNLENBQUM7QUFFakM7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFnQixVQUFVLENBQUMsR0FBVztJQUNsQyxJQUFJLENBQUMsR0FBRztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUNoRCxJQUFJLFFBQVEsR0FBRyxFQUFFLENBQUM7SUFDbEIsSUFBSSxZQUFZLEdBQUcsS0FBSyxDQUFDO0lBQ3pCLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxHQUFHLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqRCxNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25DLE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsSUFBSSxFQUFFLEtBQUssR0FBRyxJQUFJLEVBQUUsS0FBSyxJQUFJLElBQUksRUFBRSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQzFDLElBQUksQ0FBQyxZQUFZO2dCQUFFLFFBQVEsSUFBSSxHQUFHLENBQUM7WUFDbkMsWUFBWSxHQUFHLElBQUksQ0FBQztRQUN4QixDQUFDO2FBQU0sSUFBSSxFQUFFLEtBQUssR0FBRyxJ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QUNSLFFBQVEsRUFBRSxPQUFPLEtBQUssQ0FBQyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFO2FBQ3JFLENBQUM7UUFDTixDQUFDO1FBQ0QsT0FBTyxNQUFNLENBQUM7SUFDbEIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDYixPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7SUFDakQsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOWOhuWPsuS8muivne+8muaKiiBEU0gg55qE5Lya6K+d5pel5b+XKirliJflh7rmnaUqKuOAgSoq6K+75Zue5p2lKirjgIJcbiAqXG4gKiAjIyDml6Xlv5flnKjlk6rjgIHplb/ku4DkuYjmoLdcbiAqXG4gKiBgYGBcbiAqIDxEU0hfSE9NRT4vc2Vzc2lvbnMvPOW3peeoi+mUrj4vPOS8muivnSBpZD4vc2Vzc2lvblsudjRdLmpzb25sLnpzdGRcbiAqIGBgYFxuICpcbiAqIOOAjOW3peeoi+mUruOAjeaYryBEU0gg55qEIGBwcm9qZWN0S2V5KGN3ZClg77yIYEQ6XFxQcm9qZWN0XFxjb2Nvc1xcamloZV9kZWZlbmNlYCDihpJcbiAqIGAtLUQtUHJvamVjdC1jb2Nvcy1qaWhlX2RlZmVuY2UtLWDvvInjgILmlofku7bmmK8gKip6c3RkIOaLvOaOpeW4pyoq5a655Zmo44CCXG4gKlxuICogIyMg5Li65LuA5LmI6KaBIHNwYXduIOS4gOS4qiBub2RlIOWtkOi/m+eoi+adpeivu1xuICpcbiAqIOino+WOi+imgSBgbm9kZTp6bGliYCDnmoQgenN0ZCBBUEnvvIzpgqPmmK8gKipOb2RlIOKJpSAyMi4xNSoqIOaJjeacieeahO+8m+iAjCoq57yW6L6R5Zmo5Li76L+b56iL6LeR5ZyoXG4gKiBFbGVjdHJvbiAzMe+8iE5vZGUgMjAuMTXvvInph4zvvIzmsqHmnInov5nkuKogQVBJKirjgILmiYDku6Xop6Pljovov5nku7bkuovlj6rog73kuqTnu5nlpJbpnaLpgqPkuKogbm9kZVxuICog77yIYHBhdGhzLnRzYCDmjqLmtYvlh7rmnaXnmoTjgIHkuZ/mmK/nlKjmnaXot5EgZHNoIOeahOmCo+S4qu+8ie+8jOS4u+i/m+eoi+WPqui0n+i0o+OAjOaJvuWIsOaWh+S7tuOAgeWGs+Wumuivu+WTquS4quOAjeOAglxuICog55yf5q2j5bmy5rS755qE6ISa5pys5pivIGBzY3JpcHRzL3Nlc3Npb24tbG9nLmpzYO+8iOW4p+aJq+aPj+eFp+aKhCBEU0gg55qE5a6e546w77yM6KeB6YKj6L6555qE5rOo6YeK77yJ44CCXG4gKlxuICogIyMg5Li65LuA5LmI5LiN55SoIERTSCDoh6rlt7HnmoTmjqXlj6NcbiAqXG4gKiBTREsgcHJvZmlsZSDnmoTljY/orq7lj6rmnIkgYGluaXRpYWxpemVgIC8gYHNlc3Npb24vcHJvbXB0YCAvIGBzaHV0ZG93bmDvvJpcbiAqICoq5rKh5pyJ5Lu75L2V44CM5YiX5Lya6K+dIC8g6K+75pel5b+X44CN55qE5pa55rOVKirvvIhgZHNoLXNlc3Npb24tcXVlcnlg44CBYGRzaC1zZXNzaW9uLWxvZy1leHBvcnRgXG4gKiDov5nkupvljIXpg73mmK/nu5nlrr/kuLvov5vnqIvlhoXpg6jnmoQgY29yZGlzIOS4iuS4i+aWh+eUqOeahO+8jOS4jeaYr+e7mSBTREsg5a6i5oi356uv55qE77yJ44CCXG4gKiDlpb3lnKjml6Xlv5fmmK8qKuaYjuaWh+WPr+ivu+eahCBKU09OTCoq77yM55u05o6l6K+755uY5Y+N6ICM5pu056iz77yaKiphZ2VudCDmsqHlnKjot5HnmoTml7blgJnkuZ/og73nnIvljoblj7IqKuOAglxuICovXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnb3MnO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xuXG4vKiog5LiA5p2h5Y6G5Y+y5Lya6K+d55qE5pGY6KaB77yI6Z2i5p2/5YiX6KGo55So77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIEhpc3RvcnlTZXNzaW9uIHtcbiAgICAvKiog5Lya6K+dIGlk77yI5ZCM5pe25Lmf5pivIERTSCDkvqfmgaLlpI3kvJror53nlKjnmoQga2V577yJ44CCICovXG4gICAgaWQ6IHN0cmluZztcbiAgICAvKiog6aaW5p2h55So5oi35raI5oGv77yI5ou/5LiN5Yiw5bCx5piv56m65Liy77yJ44CCICovXG4gICAgdGl0bGU6IHN0cmluZztcbiAgICAvKiog5Lya6K+d5Yib5bu65pe25Yi777yI5p2l6Ieq5pel5b+X5aS077yJ44CCICovXG4gICAgY3JlYXRlZEF0OiBudW1iZXIgfCBudWxsO1xuICAgIC8qKiDml6Xlv5fmnIDlkI7lhpnlhaXml7bliLvjgIIgKi9cbiAgICB1cGRhdGVkQXQ6IG51bWJlcjtcbiAgICAvKiog5pel5b+X5a2X6IqC5pWw44CCICovXG4gICAgYnl0ZXM6IG51bWJlcjtcbiAgICAvKiog5pel5b+X6YeM5Ye6546w6L+H5aSa5bCR5Liq5Zue5ZCI77yIYHR1cm4vc3RhcnRgIOiuoeaVsO+8ieOAgiAqL1xuICAgIHR1cm5zOiBudW1iZXI7XG59XG5cbi8qKiDor7vml6Xlv5fnmoTnu5PmnpzjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGlzdG9yeVJlYWRSZXN1bHQge1xuICAgIG9rOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICAgIC8qKiDml6Xlv5flpLTvvIjlkKsgYGlkYCAvIGBjd2RgIC8gYGNyZWF0ZWRBdGDvvInjgIIgKi9cbiAgICBoZWFkZXI/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw7XG4gICAgLyoqIOS/neeVmeS6huWTquS6m+S6i+S7tu+8iGB1c2VyL21lc3NhZ2VgIC8gYGFzc2lzdGFudC9tZXNzYWdlYCAvIGB0b29sL2NhbGxgIC8gYHRvb2wvcmVzdWx0YCDigKbvvInjgIIgKi9cbiAgICBldmVudHM/OiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgLyoqIOS6i+S7tuaAu+aVsO+8iOaIquaWreWJje+8ieOAgiAqL1xuICAgIHRvdGFsPzogbnVtYmVyO1xuICAgIC8qKiB6c3RkIOW4p+aVsO+8iOiviuaWreeUqO+8ieOAgiAqL1xuICAgIGZyYW1lQ291bnQ/OiBudW1iZXI7XG4gICAgLyoqIOacq+WwvuaYr+WQpuacieWNiuS4quW4p++8iOW0qea6gy/mraPlnKjlhpnvvInjgIIgKi9cbiAgICB0b3JuPzogYm9vbGVhbjtcbn1cblxuLyoqIOWNleasoSBzcGF3biDnmoTkuIrpmZDvvJror7sgNU1CIOaXpeW/l+Wunua1i+S6muenkue6p++8jOe7mei2s+S9memHj+OAgiAqL1xuY29uc3QgUkVBREVSX1RJTUVPVVRfTVMgPSAyMF8wMDA7XG5cbi8qKlxuICogRFNIIOeahOW3peeoi+mUru+8iCoq54Wn5oqEKiogYEBkZWVwc2Vlay1haS9kc2gtc2Vzc2lvbi1wZXJzaXN0ZW5jZS1qc29ubGAg55qEIGBwcm9qZWN0S2V5YO+8ieOAglxuICpcbiAqIOinhOWIme+8mmAvYCBgXFxgIGA6YCDmipjlj6DmiJDkuIDkuKogYC1g77ybYFtBLVphLXowLTkuXy1dYCDljp/moLfvvJvlhbbkvZnlrZfnrKbovazkuYnmiJAgYH5YWFhYYO+8iOWkp+WGmeWNgeWFrei/m+WItu+8ie+8m1xuICog5pyA5ZCO5YyF5oiQIGAtLeKApi0tYO+8jOaIquaWreWIsCAyNTEg5a2X56ym44CCXG4gKlxuICogQHBhcmFtIGN3ZCAtIOW3peeoi+agueebruW9leOAglxuICogQHJldHVybnMg5Lya6K+d5qC555uu5b2V5LiL55qE5bel56iL5a2Q55uu5b2V5ZCN44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0S2V5KGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAoIWN3ZCkgdGhyb3cgbmV3IEVycm9yKCdwcm9qZWN0S2V577ya5bel56iL6Lev5b6E5piv56m655qEJyk7XG4gICAgbGV0IHJlYWRhYmxlID0gJyc7XG4gICAgbGV0IHNlcGFyYXRvclJ1biA9IGZhbHNlO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBjd2QubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGNvZGUgPSBjd2QuY2hhckNvZGVBdChpbmRleCk7XG4gICAgICAgIGNvbnN0IGNoID0gU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlKTtcbiAgICAgICAgaWYgKGNoID09PSAnLycgfHwgY2ggPT09ICdcXFxcJyB8fCBjaCA9PT0gJzonKSB7XG4gICAgICAgICAgICBpZiAoIXNlcGFyYXRvclJ1bikgcmVhZGFibGUgKz0gJy0nO1xuICAgICAgICAgICAgc2VwYXJhdG9yUnVuID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChjaCAhPT0gJ34nICYmIC9eW0EtWmEtejAtOS5fLV0kLy50ZXN0KGNoKSkge1xuICAgICAgICAgICAgcmVhZGFibGUgKz0gY2g7XG4gICAgICAgICAgICBzZXBhcmF0b3JSdW4gPSBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlYWRhYmxlICs9IGB+JHtjb2RlLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpLnBhZFN0YXJ0KDQsICcwJyl9YDtcbiAgICAgICAgICAgIHNlcGFyYXRvclJ1biA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBgLS0keyhyZWFkYWJsZS5yZXBsYWNlKC9eLSsvLCAnJykgfHwgJ3Jvb3QnKS5zbGljZSgwLCAyNTEpfS0tYDtcbn1cblxuLyoqIGA8RFNIX0hPTUU+L3Nlc3Npb25zYO+8iGBEU0hfSE9NRWAg5rKh6K6+5bCx5oyJIGB+Ly5kc2hg77yM5LiOIERTSCDoh6rlt7HlkIzlj6PlvoTvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXNzaW9uc1Jvb3QoKTogc3RyaW5nIHtcbiAgICBjb25zdCBob21lID0gcHJvY2Vzcy5lbnYuRFNIX0hPTUU/LnRyaW0oKTtcbiAgICByZXR1cm4gam9pbihob21lICYmIGhvbWUgIT09ICcnID8gaG9tZSA6IGpvaW4oaG9tZWRpcigpLCAnLmRzaCcpLCAnc2Vzc2lvbnMnKTtcbn1cblxuLyoqIOivu+WPluWZqOiEmuacrOeahOi3r+W+hO+8iGBkaXN0L2hpc3RvcnkuanNgIOKGkiBgPOaJqeWxleaguT4vc2NyaXB0cy9zZXNzaW9uLWxvZy5qc2DvvInjgIIgKi9cbmZ1bmN0aW9uIHJlYWRlclBhdGgoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gcmVzb2x2ZShfX2Rpcm5hbWUsICcuLicsICdzY3JpcHRzJywgJ3Nlc3Npb24tbG9nLmpzJyk7XG59XG5cbi8qKiDmiorlvILluLjmlLbmlZvmiJDkuIDlj6Xor53jgIIgKi9cbmZ1bmN0aW9uIGRlc2NyaWJlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xufVxuXG4vKipcbiAqIOi3keS4gOasoeivu+WPluWZqO+8jOi/lOWbnuWugyBzdGRvdXQg5LiK6YKj6KGMIEpTT07jgIJcbiAqXG4gKiDimqAg5Y+C5pWw55SoKirmlbDnu4QqKuS8oO+8iOS4jee7jyBzaGVsbO+8ie+8muW3peeoi+mUruacrOi6q+S7pSBgLS1gIOW8gOWktO+8jOS7u+S9leWtl+espuS4suaLvOaOpS/lkb3ku6TooYzop6PmnpDpg73kvJrouKnlnZHjgIJcbiAqXG4gKiBAcGFyYW0gbm9kZUV4ZSAtIOeUqOadpei3keivu+WPluWZqOeahCBub2Rl44CCXG4gKiBAcGFyYW0gYXJncyAtIOWtkOWRveS7pOS4juW8gOWFs+OAglxuICogQHBhcmFtIHRpbWVvdXRNcyAtIOi/meS4gOasoeeahOS4iumZkO+8iOaQnOe0oi/lr7zlh7rmr5TliJfooajmhaLvvIzlkITmnInlkITnmoTlsLrluqbvvInjgIJcbiAqL1xuZnVuY3Rpb24gcnVuUmVhZGVyKFxuICAgIG5vZGVFeGU6IHN0cmluZyxcbiAgICBhcmdzOiBzdHJpbmdbXSxcbiAgICB0aW1lb3V0TXMgPSBSRUFERVJfVElNRU9VVF9NUyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVQcm9taXNlLCByZWplY3RQcm9taXNlKSA9PiB7XG4gICAgICAgIGxldCBjaGlsZDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNoaWxkID0gc3Bhd24obm9kZUV4ZSwgW3JlYWRlclBhdGgoKSwgLi4uYXJnc10sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJlamVjdFByb21pc2UobmV3IEVycm9yKGDlkK/liqggbm9kZSDor7vkvJror53ml6Xlv5flpLHotKXvvJoke2Rlc2NyaWJlKGVycm9yKX1gKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3Rkb3V0ID0gJyc7XG4gICAgICAgIGxldCBzdGRlcnIgPSAnJztcbiAgICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY2hpbGQua2lsbCgpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgLyog5bey57uP6YCA5LqGICovXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZWplY3RQcm9taXNlKG5ldyBFcnJvcihg6K+75Lya6K+d5pel5b+X6LaF5pe277yIJHt0aW1lb3V0TXN9bXPvvIlgKSk7XG4gICAgICAgIH0sIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgY2hpbGQuc3Rkb3V0Py5zZXRFbmNvZGluZygndXRmOCcpO1xuICAgICAgICBjaGlsZC5zdGRlcnI/LnNldEVuY29kaW5nKCd1dGY4Jyk7XG4gICAgICAgIGNoaWxkLnN0ZG91dD8ub24oJ2RhdGEnLCAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgc3Rkb3V0ICs9IGNodW5rO1xuICAgICAgICAgICAgLy8g5LiA5Lu95pel5b+X55qE5oqV5b2x5LiN6K+l6LaF6L+H6L+Z5Liq6YeP57qn77yb6LaF5LqG5bCx5piv5ZOq5YS/5LiN5a+577yM5Yir5oqK5Li76L+b56iL5pKR54iGXG4gICAgICAgICAgICBpZiAoc3Rkb3V0Lmxlbmd0aCA+IDY0ICogMTAyNCAqIDEwMjQpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjaGlsZC5raWxsKCk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNoaWxkLnN0ZGVycj8ub24oJ2RhdGEnLCAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgc3RkZXJyICs9IGNodW5rO1xuICAgICAgICB9KTtcblxuICAgICAgICBjaGlsZC5vbignZXJyb3InLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICByZWplY3RQcm9taXNlKG5ldyBFcnJvcihg6K+75Lya6K+d5pel5b+X5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCkpO1xuICAgICAgICB9KTtcblxuICAgICAgICBjaGlsZC5vbignY2xvc2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgY29uc3QgbGluZSA9IHN0ZG91dC50cmltKCkuc3BsaXQoJ1xcbicpLnBvcCgpID8/ICcnO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXNvbHZlUHJvbWlzZShKU09OLnBhcnNlKGxpbmUpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJlamVjdFByb21pc2UoXG4gICAgICAgICAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGDor7vkvJror53ml6Xlv5fnmoTovpPlh7rkuI3mmK8gSlNPTu+8miR7bGluZS5zbGljZSgwLCAyMDApIHx8ICco56m6KSd9YCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKHN0ZGVyciA/IGDvvJtzdGRlcnLvvJoke3N0ZGVyci50cmltKCkuc2xpY2UoMCwgMjAwKX1gIDogJycpLFxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuXG4vKiog57y6IG5vZGUg5pe255qE57uf5LiA5paH5qGI77yI6L+Z5LiN5piv44CM5rKh6KOFIGRzaOOAjemCo+S5iOaYjuaYvu+8jOivtOa4healmuS4uuS7gOS5iOivu+S4jeS6hu+8ieOAgiAqL1xuY29uc3QgTk9fTk9ERV9ISU5UID1cbiAgICAn6K+75Lya6K+d5pel5b+X6ZyA6KaB5LiA5LiqICoqTm9kZSDiiaUgMjIuMTUqKu+8iOaXpeW/l+aYryB6c3RkIOWOi+e8qeeahO+8jOe8lui+keWZqOiHquW4pueahCBFbGVjdHJvbi9Ob2RlIDIwIOino+S4jeW8gO+8ieOAgicgK1xuICAgICfor7flnKjorr7nva7ph4zloavjgIxub2RlIOi3r+W+hOOAje+8jOaIluaKiiBub2RlIOWKoOWIsCBQQVRI44CCJztcblxuLyoqXG4gKiDliJflh7rmnKzlt6XnqIvnmoTljoblj7LkvJror53vvIjmjInmnIDlkI7kv67mlLnml7bpl7TlgJLluo/vvInjgIJcbiAqXG4gKiBAcGFyYW0gbm9kZUV4ZSAtIOeUqOadpei3keivu+WPluWZqOeahCBub2Rl77yIYHBhdGhzLnRzYCDmjqLmtYvlh7rmnaXnmoTpgqPkuKrvvInjgIJcbiAqIEBwYXJhbSBjd2QgLSDlt6XnqIvmoLnnm67lvZXjgIJcbiAqIEBwYXJhbSBsaW1pdCAtIOacgOWkmuWHoOadoeOAglxuICogQHJldHVybnMgYHtvaywgc2Vzc2lvbnM/LCBlcnJvcj99YO+8m+Wksei0peS4jeaKm++8jOiuqemdouadv+iDveaYvuekuuWOn+WboOOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdEhpc3RvcnkoXG4gICAgbm9kZUV4ZTogc3RyaW5nIHwgbnVsbCxcbiAgICBjd2Q6IHN0cmluZyxcbiAgICBsaW1pdCA9IDIwLFxuKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBzZXNzaW9ucz86IEhpc3RvcnlTZXNzaW9uW107IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICBpZiAoIW5vZGVFeGUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IE5PX05PREVfSElOVCB9O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBhd2FpdCBydW5SZWFkZXIobm9kZUV4ZSwgW1xuICAgICAgICAgICAgJ2xpc3QnLFxuICAgICAgICAgICAgJy0tcm9vdCcsXG4gICAgICAgICAgICBzZXNzaW9uc1Jvb3QoKSxcbiAgICAgICAgICAgICctLXByb2plY3QnLFxuICAgICAgICAgICAgcHJvamVjdEtleShjd2QpLFxuICAgICAgICAgICAgJy0tbGltaXQnLFxuICAgICAgICAgICAgU3RyaW5nKGxpbWl0KSxcbiAgICAgICAgXSk7XG4gICAgICAgIGlmIChwYXlsb2FkLm9rICE9PSB0cnVlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcocGF5bG9hZC5lcnJvciA/PyAn6K+75Y+W5Zmo6L+U5Zue5aSx6LSlJykgfTtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbnMgPSBBcnJheS5pc0FycmF5KHBheWxvYWQuc2Vzc2lvbnMpID8gKHBheWxvYWQuc2Vzc2lvbnMgYXMgSGlzdG9yeVNlc3Npb25bXSkgOiBbXTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHNlc3Npb25zIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoZXJyb3IpIH07XG4gICAgfVxufVxuXG4vKipcbiAqIOivu+S4gOS4quS8muivneeahOS6i+S7tu+8iOWbnuaUvueUqO+8ieOAglxuICpcbiAqIEBwYXJhbSBub2RlRXhlIC0g55So5p2l6LeR6K+75Y+W5Zmo55qEIG5vZGXjgIJcbiAqIEBwYXJhbSBjd2QgLSDlt6XnqIvmoLnnm67lvZXjgIJcbiAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAqIEBwYXJhbSBtYXhFdmVudHMgLSDmnIDlpJrkv53nlZnlpJrlsJHmnaHvvIjku47lsL7pg6jkv53nlZnvvInjgIJcbiAqIEByZXR1cm5zIGB7b2ssIGV2ZW50cz8sIGVycm9yP31g44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkSGlzdG9yeShcbiAgICBub2RlRXhlOiBzdHJpbmcgfCBudWxsLFxuICAgIGN3ZDogc3RyaW5nLFxuICAgIHNlc3Npb25JZDogc3RyaW5nLFxuICAgIG1heEV2ZW50cyA9IDIwMDAsXG4pOiBQcm9taXNlPEhpc3RvcnlSZWFkUmVzdWx0PiB7XG4gICAgaWYgKCFub2RlRXhlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBOT19OT0RFX0hJTlQgfTtcbiAgICBpZiAoIXNlc3Npb25JZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ3JlYWRIaXN0b3J577ya5Lya6K+dIGlkIOaYr+epuueahCcgfTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcnVuUmVhZGVyKG5vZGVFeGUsIFtcbiAgICAgICAgICAgICdyZWFkJyxcbiAgICAgICAgICAgICctLXJvb3QnLFxuICAgICAgICAgICAgc2Vzc2lvbnNSb290KCksXG4gICAgICAgICAgICAnLS1wcm9qZWN0JyxcbiAgICAgICAgICAgIHByb2plY3RLZXkoY3dkKSxcbiAgICAgICAgICAgICctLWlkJyxcbiAgICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICAgICctLW1heC1ldmVudHMnLFxuICAgICAgICAgICAgU3RyaW5nKG1heEV2ZW50cyksXG4gICAgICAgIF0pO1xuICAgICAgICBpZiAocGF5bG9hZC5vayAhPT0gdHJ1ZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKHBheWxvYWQuZXJyb3IgPz8gJ+ivu+WPluWZqOi/lOWbnuWksei0pScpIH07XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGhlYWRlcjogKHBheWxvYWQuaGVhZGVyID8/IG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCxcbiAgICAgICAgICAgIGV2ZW50czogQXJyYXkuaXNBcnJheShwYXlsb2FkLmV2ZW50cykgPyAocGF5bG9hZC5ldmVudHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KSA6IFtdLFxuICAgICAgICAgICAgdG90YWw6IHR5cGVvZiBwYXlsb2FkLnRvdGFsID09PSAnbnVtYmVyJyA/IHBheWxvYWQudG90YWwgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBmcmFtZUNvdW50OiB0eXBlb2YgcGF5bG9hZC5mcmFtZUNvdW50ID09PSAnbnVtYmVyJyA/IHBheWxvYWQuZnJhbWVDb3VudCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHRvcm46IHBheWxvYWQudG9ybiA9PT0gdHJ1ZSxcbiAgICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnJvcikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog5LuO5LqL5Lu25rWB6YeM5Y+W5LiA5p2h44CM5YOP5qCH6aKY44CN55qE6aaW5p2h55So5oi35raI5oGv77yI5YiX6KGo5o6l5Y+j57uZ5LqG5qCH6aKY77yM5Zue5pS+6Lev5b6E6KaB6Ieq5bex566X5LiA6YGN77yJ44CCXG4gKlxuICog4pqgICoq6L+Z5p2h5Zue6YCA546w5Zyo5b6I5bCR6KKr55So5Yiw5LqGKirvvJrkvJror53ml6Xlv5fph4zmnKzmnaXlsLHmnInmnYPlqIHmoIfpopjvvIhgc2Vzc2lvbi90aXRsZWAg5LqL5Lu277yMXG4gKiDnlLEgYGRzaC1zZXNzaW9uLXRpdGxlYCDov73liqDvvInvvIxgc2Vzc2lvbi1sb2cuanNgIOW3sue7j+aKiuWug+S4gOi1t+aKleW9seWHuuadpSDigJTigJRcbiAqIOS8mOWFiOeUqCBgdGl0bGVPZkV2ZW50c2Ag5LiK6Z2i6YKj5LiqIGBsb2dnZWRUaXRsZU9mYOOAgui/meS4gOadoeS/neeVmee7meOAjOaXp+aXpeW/l+mHjOayoeaciVxuICogYHNlc3Npb24vdGl0bGVg44CN55qE5oOF5Ya177yI5pysIHByb2ZpbGUg5pep5pyf6LeR5Ye65p2l55qE5Lya6K+d77yJ44CCXG4gKlxuICogQHBhcmFtIGV2ZW50cyAtIGByZWFkSGlzdG9yeWAg6L+U5Zue55qE5LqL5Lu244CCXG4gKiBAcmV0dXJucyDmoIfpopjvvIjmnIDlpJogODAg5a2X77yJ77yb5Y+W5LiN5Yiw6L+U5Zue56m65Liy44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZU9mRXZlbnRzKGV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIGV2ZW50cykge1xuICAgICAgICBpZiAoZXZlbnQudHlwZSAhPT0gJ3VzZXIvbWVzc2FnZScpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gKGV2ZW50LmRhdGEgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBkYXRhLnNvdXJjZSBhcyB7IGtpbmQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHNvdXJjZSAmJiBzb3VyY2Uua2luZCAhPT0gJ3VzZXInKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgY29udGVudCA9IChkYXRhLmNvbnRlbnQgPz8gKGRhdGEubWVzc2FnZSBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfCB1bmRlZmluZWQpPy5jb250ZW50KSBhcyB1bmtub3duO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB0ZXh0ID0gY29udGVudFxuICAgICAgICAgICAgLmZpbHRlcigoYmxvY2spOiBibG9jayBpcyB7IHR5cGU6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGJsb2NrIGFzIHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FuZGlkYXRlPy50eXBlID09PSAndGV4dCcgJiYgdHlwZW9mIGNhbmRpZGF0ZS50ZXh0ID09PSAnc3RyaW5nJztcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAubWFwKChibG9jaykgPT4gYmxvY2sudGV4dClcbiAgICAgICAgICAgIC5qb2luKCcgJylcbiAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAgICAgICAgIC50cmltKCk7XG4gICAgICAgIGlmICh0ZXh0KSByZXR1cm4gdGV4dC5zbGljZSgwLCA4MCk7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxuLyoqXG4gKiDku47kuovku7bmtYHph4zlj5YqKuS8muivneaXpeW/l+iHquW3seiusOeahCoq5qCH6aKY77yIYHNlc3Npb24vdGl0bGVg77yM5pyA5paw5LiA5p2h6IOc5Ye677yJ44CCXG4gKlxuICog5Li65LuA5LmI5LyY5YWI5a6D6ICM5LiN5piv6aaW5p2h55So5oi35raI5oGv77yaYGRzaC1zZXNzaW9uLXRpdGxlYCDkvJrmiormoIfpopjop4TojIPljJbvvIjmuIXmjqfliLblrZfnrKbjgIFcbiAqIOaMieWtl+iKguWuieWFqOaIquaWre+8ie+8jOiAjCBgc2Vzc2lvbi10aXRsZS1sbG1gIOaJk+W8gOWQjui/mOS8muihpeS4gOadoSoq5qih5Z6L55Sf5oiQKirnmoTkv67orqJcbiAqIO+8iOOAjOi+g+aWsOeahOS/ruiuouWPluS7o+aXp+eahOOAjeaYr+acjeWKoeiHquW3seeahOS/neivge+8ieOAgummluadoeeUqOaIt+a2iOaBr+WPquaYr+Wug+eahOWFnOW6leadpea6kOOAglxuICpcbiAqIEBwYXJhbSBldmVudHMgLSBgcmVhZEhpc3RvcnlgIOi/lOWbnueahOS6i+S7tuOAglxuICogQHJldHVybnMg5qCH6aKY77yb5rKh5pyJ5YiZ56m65Liy44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2dnZWRUaXRsZU9mKGV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KTogc3RyaW5nIHtcbiAgICBmb3IgKGxldCBpbmRleCA9IGV2ZW50cy5sZW5ndGggLSAxOyBpbmRleCA+PSAwOyBpbmRleCAtPSAxKSB7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gZXZlbnRzW2luZGV4XTtcbiAgICAgICAgaWYgKGV2ZW50LnR5cGUgIT09ICdzZXNzaW9uL3RpdGxlJykgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSAoZXZlbnQuZGF0YSA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGNvbnN0IHRpdGxlID0gdHlwZW9mIGRhdGEudGl0bGUgPT09ICdzdHJpbmcnID8gZGF0YS50aXRsZS50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKHRpdGxlKSByZXR1cm4gdGl0bGUuc2xpY2UoMCwgMTIwKTtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWFqOaWh+aQnOe0olxuXG4vKiog5pCc57Si55qE6aKE566X77yI6Z2i5p2/5LiN5Lyg5pe255So6L+Z5Lu977yb5LiOIGBzZXNzaW9uLWxvZy5qc2Ag55qEIGBTRUFSQ0hfREVGQVVMVFNgIOWQjOWPo+W+hO+8ieOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBIaXN0b3J5U2VhcmNoT3B0aW9ucyB7XG4gICAgLyoqIOacgOWkmuWHoOadoeS8muivne+8myoq5ZCM5pe25Lmf5piv44CM5om+5Yiw6L+Z5LmI5aSa5bCx5pS25bel44CN55qE5YGc5q2i5p2h5Lu2KirvvIjop4HohJrmnKzph4znmoTms6jph4rvvInjgIIgKi9cbiAgICBsaW1pdD86IG51bWJlcjtcbiAgICAvKiog5q+P5p2h5Lya6K+d5pyA5aSa5Yeg5Liq54mH5q6144CCICovXG4gICAgcGVyU2Vzc2lvbj86IG51bWJlcjtcbiAgICAvKiog5pyA5aSa5qOA5p+l5Yeg5Liq5Lya6K+d55uu5b2V44CCICovXG4gICAgbWF4U2Vzc2lvbnM/OiBudW1iZXI7XG4gICAgLyoqIOacgOWkmuivu+WkmuWwkeWOi+e8qeWtl+iKguOAgiAqL1xuICAgIG1heEJ5dGVzPzogbnVtYmVyO1xuICAgIC8qKiDml7bpl7TpooTnrpfvvIjmr6vnp5LvvInjgIIgKi9cbiAgICBidWRnZXRNcz86IG51bWJlcjtcbn1cblxuLyoqIOaQnOe0ouWbnuaJp++8iOWtl+auteS4juiEmuacrOeahOi+k+WHuuWQjOW9ou+8jOmdouadv+WPqueUu+S4jeeul++8ieOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBIaXN0b3J5U2VhcmNoUmVzdWx0IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgICBxdWVyeT86IHN0cmluZztcbiAgICBoaXRzPzogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICAgIHNjYW5uZWQ/OiBudW1iZXI7XG4gICAgYXZhaWxhYmxlPzogbnVtYmVyO1xuICAgIHBhcnRpYWw/OiBib29sZWFuO1xuICAgIHN0b3BwZWRCeT86IHN0cmluZyB8IG51bGw7XG4gICAgZWxhcHNlZE1zPzogbnVtYmVyO1xuICAgIHNjYW5uZWRCeXRlcz86IG51bWJlcjtcbn1cblxuLyoqIOaQnOe0oueahOaXtumXtOS4iumZkO+8mue7meiEmuacrOiHquW3seeahCBgYnVkZ2V0TXNgIOeVmei2s+S9memHj++8iOWug+i/mOimgeino+WOi+OAgeaKleW9seOAgeaOkuW6j++8ieOAgiAqL1xuY29uc3QgU0VBUkNIX1RJTUVPVVRfU0xBQ0tfTVMgPSAzMF8wMDA7XG5cbi8qKlxuICog5ZyoKirmiYDmnIkqKuS8muivneaXpeW/l+mHjOWBmuWtl+mdouWtkOS4suWFqOaWh+aQnOe0ouOAglxuICpcbiAqIOS4ieadoeWPo+W+hO+8iOmDveWGmeWcqCBgc2Vzc2lvbi1sb2cuanNgIOeahCBgc2VhcmNoU2Vzc2lvbnNgIOaXgei+ue+8jOi/memHjOWPqumHjeWkjeacgOimgee0p+eahO+8ie+8mlxuICogMS4gKirlrZfpnaLlrZDkuLIqKu+8iOWkp+Wwj+WGmeS4jeaVj+aEn+OAgeepuueZveW8ueaAp++8ie+8jOS4jeaYr+WIhuivjSDigJTigJQg5Lit5paH5oyJ5a2X5pat6K+N5omN5pCc5b6X5Yiw77ybXG4gKiAyLiAqKuaciemihOeulyoq77yM6ICM5LiUKirlpoLlrp7miqXlkYropobnm5bnjocqKu+8iGBwYXJ0aWFsYCAvIGBzdG9wcGVkQnlgIC8gYHNjYW5uZWRgIC8gYGF2YWlsYWJsZWDvvInvvJtcbiAqIDMuICoq5Lya6K+d5oyJ5pyA5ZCO5L+u5pS55pe26Ze05YCS5bqP6LWwKirvvIzmiYDku6XlgZzkuIvmnaXml7bmiYvph4zmmK/jgIzmnIDmlrDnmoQgTiDmnaHljLnphY3jgI3jgIJcbiAqXG4gKiBAcGFyYW0gbm9kZUV4ZSAtIOeUqOadpei3keivu+WPluWZqOeahCBub2Rl44CCXG4gKiBAcGFyYW0gY3dkIC0g5bel56iL5qC555uu5b2V44CCXG4gKiBAcGFyYW0gcXVlcnkgLSDmn6Xor6LkuLLvvIgxfjIwMCDlrZfvvJvnqbrnmb3liIfmiJDlpJrkuKror43vvIzor43kuYvpl7TmmK8gQU5E77yJ44CCXG4gKiBAcGFyYW0gb3B0aW9ucyAtIOmihOeul+OAglxuICogQHJldHVybnMg5ZG95Lit5YiX6KGo5LiO6KaG55uW546H77yb5aSx6LSl5LiN5oqb44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZWFyY2hIaXN0b3J5KFxuICAgIG5vZGVFeGU6IHN0cmluZyB8IG51bGwsXG4gICAgY3dkOiBzdHJpbmcsXG4gICAgcXVlcnk6IHN0cmluZyxcbiAgICBvcHRpb25zOiBIaXN0b3J5U2VhcmNoT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxIaXN0b3J5U2VhcmNoUmVzdWx0PiB7XG4gICAgaWYgKCFub2RlRXhlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBOT19OT0RFX0hJTlQgfTtcbiAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIHF1ZXJ5ID09PSAnc3RyaW5nJyA/IHF1ZXJ5LnRyaW0oKSA6ICcnO1xuICAgIGlmICghdGV4dCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+aQnOe0ouivjeaYr+epuueahCcgfTtcbiAgICBpZiAodGV4dC5sZW5ndGggPiAyMDApIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfmkJzntKLor43lpKrplb/kuobvvIjmnIDlpJogMjAwIOWtl++8iScgfTtcblxuICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgICdzZWFyY2gnLFxuICAgICAgICAnLS1yb290JyxcbiAgICAgICAgc2Vzc2lvbnNSb290KCksXG4gICAgICAgICctLXByb2plY3QnLFxuICAgICAgICBwcm9qZWN0S2V5KGN3ZCksXG4gICAgICAgICctLXF1ZXJ5JyxcbiAgICAgICAgdGV4dCxcbiAgICBdO1xuICAgIGNvbnN0IHB1c2ggPSAoZmxhZzogc3RyaW5nLCB2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogdm9pZCA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwKSBhcmdzLnB1c2goZmxhZywgU3RyaW5nKE1hdGguZmxvb3IodmFsdWUpKSk7XG4gICAgfTtcbiAgICBwdXNoKCctLWxpbWl0Jywgb3B0aW9ucy5saW1pdCk7XG4gICAgcHVzaCgnLS1wZXItc2Vzc2lvbicsIG9wdGlvbnMucGVyU2Vzc2lvbik7XG4gICAgcHVzaCgnLS1tYXgtc2Vzc2lvbnMnLCBvcHRpb25zLm1heFNlc3Npb25zKTtcbiAgICBwdXNoKCctLW1heC1ieXRlcycsIG9wdGlvbnMubWF4Qnl0ZXMpO1xuICAgIHB1c2goJy0tYnVkZ2V0LW1zJywgb3B0aW9ucy5idWRnZXRNcyk7XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcnVuUmVhZGVyKG5vZGVFeGUsIGFyZ3MsIChvcHRpb25zLmJ1ZGdldE1zID8/IDZfMDAwKSArIFNFQVJDSF9USU1FT1VUX1NMQUNLX01TKTtcbiAgICAgICAgaWYgKHBheWxvYWQub2sgIT09IHRydWUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhwYXlsb2FkLmVycm9yID8/ICfmkJzntKLlpLHotKUnKSB9O1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBxdWVyeTogdHlwZW9mIHBheWxvYWQucXVlcnkgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5xdWVyeSA6IHRleHQsXG4gICAgICAgICAgICBoaXRzOiBBcnJheS5pc0FycmF5KHBheWxvYWQuaGl0cykgPyAocGF5bG9hZC5oaXRzIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PikgOiBbXSxcbiAgICAgICAgICAgIHNjYW5uZWQ6IG51bWJlck9yVW5kZWZpbmVkKHBheWxvYWQuc2Nhbm5lZCksXG4gICAgICAgICAgICBhdmFpbGFibGU6IG51bWJlck9yVW5kZWZpbmVkKHBheWxvYWQuYXZhaWxhYmxlKSxcbiAgICAgICAgICAgIHBhcnRpYWw6IHBheWxvYWQucGFydGlhbCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIHN0b3BwZWRCeTogdHlwZW9mIHBheWxvYWQuc3RvcHBlZEJ5ID09PSAnc3RyaW5nJyA/IHBheWxvYWQuc3RvcHBlZEJ5IDogbnVsbCxcbiAgICAgICAgICAgIGVsYXBzZWRNczogbnVtYmVyT3JVbmRlZmluZWQocGF5bG9hZC5lbGFwc2VkTXMpLFxuICAgICAgICAgICAgc2Nhbm5lZEJ5dGVzOiBudW1iZXJPclVuZGVmaW5lZChwYXlsb2FkLnNjYW5uZWRCeXRlcyksXG4gICAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoZXJyb3IpIH07XG4gICAgfVxufVxuXG4vKiog5oqK44CM5Y+v6IO95piv5pWw5a2X44CN55qE5YC85pS25pWb5oiQIG51bWJlciB8IHVuZGVmaW5lZOOAgiAqL1xuZnVuY3Rpb24gbnVtYmVyT3JVbmRlZmluZWQodmFsdWU6IHVua25vd24pOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlr7zlh7ogLyDliKDpmaRcblxuLyoqIOWvvOWHuuWbnuaJp+OAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBIaXN0b3J5RXhwb3J0UmVzdWx0IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgICBpZD86IHN0cmluZztcbiAgICB0aXRsZT86IHN0cmluZztcbiAgICBmb3JtYXQ/OiBzdHJpbmc7XG4gICAgcGF0aD86IHN0cmluZztcbiAgICBkaXI/OiBzdHJpbmc7XG4gICAgYnl0ZXM/OiBudW1iZXI7XG4gICAgZXZlbnRzPzogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIFpJUCDpgqPkuIDot6/nmoTlrZDlrZnkvJror53kuovlrp7vvIjlj6rmnInluKYgYC0td2l0aC1zdWJhZ2VudHNgIOaJjeS8muacie+8ieOAglxuICAgICAqXG4gICAgICog4pqgIGBzdWJhZ2VudENvdW50YCDkuI4gYGZvcmtDb3VudGAgKirliIblvIDmiqUqKu+8jOS4jeiuuOWQiOaIkOS4gOS4quOAjOWtkOWtmeaVsOOAje+8mlxuICAgICAqIOS4pOiAheWcqOS8muivneaXpeW/l+WktOmHjOeahOWIpOaNruS4jeWQjO+8iGBvcmlnaW4gPT09ICdzdWJhZ2VudCdgIHZz44CM5pyJIGBwYXJlbnRTZXNzaW9uYCDkvYbmsqHmnIkgb3JpZ2lu44CN77yJ77yMXG4gICAgICog6ICM55So5oi355yL5Yiw44CM5ZCrIDUg5Liq5a2Q5Lya6K+d44CN5pe25oOz55+l6YGT55qE5piv44CM6L+ZIDUg5Liq6YeM5pyJ5Yeg5Liq5piv5oiR55yf5q2j5rS+5Ye65Y6755qEIGFnZW5044CN44CCXG4gICAgICovXG4gICAgc3ViYWdlbnRzPzoge1xuICAgICAgICB0b3RhbDogbnVtYmVyO1xuICAgICAgICBzdWJhZ2VudENvdW50OiBudW1iZXI7XG4gICAgICAgIGZvcmtDb3VudDogbnVtYmVyO1xuICAgICAgICBtYXhEZXB0aDogbnVtYmVyIHwgbnVsbDtcbiAgICAgICAgLyoqIOe0ouW8lemHjOafpeS4jeWIsOeItue6p+eahOS8muivne+8iOaCrOepuuW8leeUqO+8ieKAlOKAlCDlpoLlrp7luKblh7rljrvvvIzkuI3lgYfoo4XmoJHmmK/lrozmlbTnmoTjgIIgKi9cbiAgICAgICAgZGFuZ2xpbmc6IHN0cmluZ1tdO1xuICAgICAgICBpbmNvbXBsZXRlOiBib29sZWFuO1xuICAgIH07XG4gICAgLyoqIFpJUCDpgqPkuIDot6/nmoTpmYTku7bkuovlrp7jgIIgKi9cbiAgICBtZWRpYT86IHsgY291bnQ6IG51bWJlcjsgbWlzc2luZzogbnVtYmVyOyBuYW1pbmdEZXZpYXRpb246IHN0cmluZyB8IG51bGwgfTtcbiAgICAvKiog5byV55So5LqG5L2GKiror7vkuI3liLDmlofku7YqKueahOmZhOS7tiBpZO+8iOe8uuWkseWwseWmguWunuivtO+8jOS4jemdmem7mOWwkeWvvO+8ieOAgiAqL1xuICAgIG1pc3NpbmdNZWRpYT86IHN0cmluZ1tdO1xuICAgIC8qKiDov5nkuIDotp/opoHkuqTku6PnmoTor53vvIjmtLvot4PkvJror53lj6/og73lsJHmnIDlkI7lh6DmnaEgLyDntKLlvJXotoXpooTnrpcgLyDnvLrlqpLkvZPigKbvvInjgIIgKi9cbiAgICBub3Rlcz86IHN0cmluZ1tdO1xuICAgIC8qKiBaSVAg6Ieq5bex55qE5LqL5a6e77yI5paH5Lu25ZCN5LiO5p2h55uu5pWw77yJ44CCICovXG4gICAgemlwPzogeyBmaWxlTmFtZTogc3RyaW5nOyBlbnRyaWVzOiBudW1iZXIgfTtcbn1cblxuLyoqIOWIoOmZpOWbnuaJp+OAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBIaXN0b3J5RGVsZXRlUmVzdWx0IHtcbiAgICBvazogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgICBpZD86IHN0cmluZztcbiAgICBkaXI/OiBzdHJpbmc7XG4gICAgcmVtb3ZlZD86IGJvb2xlYW47XG4gICAgZmlsZUNvdW50PzogbnVtYmVyO1xuICAgIGJ5dGVzPzogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIOOAjOWIoOS8muivneaXtumhuuW4puWbnuaUtuaXoOW8leeUqOmZhOS7tuOAjemCo+S4gOi2n+eahOe7k+aenO+8iGAtLXJlY2xhaW0tYXR0YWNobWVudHNgIOaJjeacie+8ieOAglxuICAgICAqXG4gICAgICog4pqgIOi/meS4gOWdlyoq5aSp54S25piv44CM5Y+v6IO95LuA5LmI6YO95rKh5YGa44CNKirvvJrmnKzmnLrlrp7mtYsgNzk3IOS4qumZhOS7tuWvueixoSoq5YWo6YO96KKr6Iez5bCR5LiA5p2h5Lya6K+d5byV55SoKirvvIxcbiAgICAgKiDmiYDku6UgYG9ycGhhbnNgIOmAmuW4uOaYryAw77yM6ICM5LiUKirotoXpooTnrpfml7YgYGluY29tcGxldGU6IHRydWVgIOS4lOS4gOS4qumDveS4jeaQrCoq77yIZmFpbC1jbG9zZWTvvInjgIJcbiAgICAgKiDpnaLmnb/kuIrkuI3orrjmiorlroPlrqPkvKDmiJDjgIzkuIDplK7ohb7nqbrpl7TjgI3igJTigJQg5a6D5Y+q5Zyo5Yig6L+H44CM5byV55So5ZSv5LiA44CN55qE5Lya6K+d5LmL5ZCO5omN5pyJ5rS75bmy44CCXG4gICAgICovXG4gICAgcmVjbGFpbT86IHtcbiAgICAgICAgZHJ5UnVuOiBib29sZWFuO1xuICAgICAgICBjYW5kaWRhdGVzOiBudW1iZXI7XG4gICAgICAgIHJlZmVyZW5jZWQ6IG51bWJlcjtcbiAgICAgICAgb3JwaGFuczogbnVtYmVyO1xuICAgICAgICB0cmFzaGVkOiBudW1iZXI7XG4gICAgICAgIGJ5dGVzRnJlZWQ6IG51bWJlcjtcbiAgICAgICAgLyoqIOWFqOW6k+aJq+aPj+iiq+mihOeul+S4reaWrSDih5IgKirkuIDkuKrpg73msqHmkKwqKu+8iOi/meS4gOadoeW/hemhu+WOn+agt+eUu+WHuuadpe+8ieOAgiAqL1xuICAgICAgICBpbmNvbXBsZXRlOiBib29sZWFuO1xuICAgICAgICBpbmNvbXBsZXRlUmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICAvKiog5YWo5bqT5omr5o+P55qE5Y+j5b6E77yI5Yeg5p2h5Lya6K+dIC8g5aSa5bCR5a2X6IqCIC8g5aSa5LmF77yJ44CCICovXG4gICAgICAgIHNjYW5uZWQ6IHsgc2Vzc2lvbnM6IG51bWJlcjsgYnl0ZXM6IG51bWJlcjsgZWxhcHNlZE1zOiBudW1iZXIgfTtcbiAgICAgICAgLyoqIOiiq+WQpuWGs+eahOWAmemAieS4juWOn+WboO+8iGBzdGlsbC1yZWZlcmVuY2VkYCAvIGBoYXNoLW1pc21hdGNoYCAvIGByZWNlbnRgIOKApu+8ieOAgiAqL1xuICAgICAgICBza2lwcGVkOiBBcnJheTx7IGlkOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+O1xuICAgICAgICB0cmFzaERpcjogc3RyaW5nO1xuICAgIH07XG59XG5cbi8qKlxuICog5a+85Ye65qC85byP44CCXG4gKlxuICogLSBgbWRgID0g57uZ5Lq66K+755qE6L2s5YaZ77ybXG4gKiAtIGBqc29ubGAgPSDop6PljovlkI7ljp/moLfnmoTml6Xlv5fvvIjnu5nlt6XlhbflkIPvvInvvJtcbiAqIC0gYHppcGAgPSAqKuWvuem9kCBEU0gg5a6Y5pa55a+85Ye655qE6YKj5LiA5Lu9KirvvJpgc2Vzc2lvbi5qc29ubGAgKyBgc3ViYWdlbnRzLzxpZD4vc2Vzc2lvbi5qc29ubGBcbiAqICAgKyBgbWVkaWEvPGhleD4uPGV4dD5g77yI5aSW5Yqg5oiR5Lus6Ieq5bex55qEIGBtYW5pZmVzdC5qc29uYO+8ieOAglxuICogICDimqAg5a6DKirpu5jorqTlsLHluKblrZDlrZnkuI7pmYTku7blg4/ntKAqKu+8iHppcCDnmoTmhI/kuYnlsLHmmK/pgqPku73luIPlsYDvvInvvIzmiYDku6XpnaLmnb/kuIrpgqPkuKrmjInpkq7lhpnnnYBcbiAqICAg44CM5ZCr5a2Q5Lya6K+d5LiO6ZmE5Lu244CN77yM6ICM5LiN5piv57uZ5Lik5Liq5byA5YWz6K6p5Lq654yc44CCXG4gKi9cbmV4cG9ydCB0eXBlIEhpc3RvcnlFeHBvcnRGb3JtYXQgPSAnbWQnIHwgJ2pzb25sJyB8ICd6aXAnO1xuXG4vKipcbiAqIOaKiuS4gOadoeS8muivneWvvOWHuuaIkOaWh+S7tuOAglxuICpcbiAqIOiQveWcqCBgPERTSF9IT01FPi9leHBvcnRzLzzlt6XnqIvplK4+L2DvvIgqKuS4jeW+gOW3peeoi+ebruW9lemHjOWGmSoq77ya5a+85Ye654mp5piv44CM55yL5LiA55y85bCx5Yig44CNXG4gKiDnmoTkuJzopb/vvIzmiZTov5vlt6XnqIvlj6rkvJrmsaHmn5MgZ2l077yJ44CCYG1kYCAvIGBqc29ubGAg5Lik5p2h6LevKirkuI3luKblm77niYflg4/ntKAqKiDigJTigJRcbiAqIOWug+S7rOaMieWGheWuueWtmOWcqCBgPERTSF9IT01FPi9hdHRhY2htZW50c2DvvIzot6jkvJror53ljrvph43lhbHnlKjvvJvmg7PopoHlg4/ntKDlsLHotbAgYHppcGBcbiAqIO+8iGAtLXdpdGgtbWVkaWFg77yJ77yM6YKj5LiA5Lu95Lya5oqK5byV55So5Yiw55qE5Zu+5LiA6LW35omT6L+b5Y6744CCXG4gKlxuICogIyMgYHppcGAg6YKj5LiA6Lev77yIMjAyNi0xMiDliqDvvInkuLrku4DkuYjlgLzlvpfljZXni6zkuIDmoaNcbiAqXG4gKiDlroPmmK8qKuWvuem9kCBEU0gg5a6Y5pa55a+85Ye6KirnmoTpgqPkuIDku73luIPlsYDvvIhgZHNoLXNlc3Npb24tbG9nLWV4cG9ydGAg55qE5Lqn54mp77yJ77yaXG4gKiDliKvkurrmi7/liLDov5nkuKogemlwIOiDveeUqOWQjOS4gOWll+W3peWFt+ivu+OAguS7o+S7t+aYryoq5oWiKirvvIjopoHop6PljovlrZDlrZnkvJror53ml6Xlv5cgKyDor7vkuIDloIbpmYTku7bvvInvvIxcbiAqIOaJgOS7peWug+aYryoq5pi+5byP55qE5LiA5qGjKirvvIjpnaLmnb/kuIrkuIDkuKrljZXni6znmoTmjInpkq7vvInvvIzkuI3mmK/nu5kgbWQg5Yqg5Lik5Liq5byA5YWz44CCXG4gKlxuICog4pqgIOmCo+adoei3r+acieS4gOWPpeW/hemhu+W4puWHuuadpeeahOivne+8mioq5b2T5YmN5rS76LeD5Lya6K+d5Y+v6IO95bCR5pyA5ZCO5Yeg5p2hKiog4oCU4oCUXG4gKiBEU0gg6Ieq5bex5a+85Ye65YmN5Lya5YWIIGBmbHVzaGDvvIzogIzmiJHku6zlj6rmmK/or7vpnZnmgIHmlofku7bvvIjor7vnmoTml7blgJnnlKggc3RhdOKGkuivu+KGknN0YXQg5aSN5qOA77yMXG4gKiDkuI3nqLPlrprlsLHlpoLlrp7lhpnlnKggYG5vdGVzYCDph4zvvInjgIJcbiAqXG4gKiBAcGFyYW0gbm9kZUV4ZSAtIOeUqOadpei3keivu+WPluWZqOeahCBub2Rl44CCXG4gKiBAcGFyYW0gY3dkIC0g5bel56iL5qC555uu5b2V44CCXG4gKiBAcGFyYW0gc2Vzc2lvbklkIC0g5Lya6K+dIGlk44CCXG4gKiBAcGFyYW0gZm9ybWF0IC0gYG1kYCAvIGBqc29ubGAgLyBgemlwYOOAglxuICogQHBhcmFtIG9wdGlvbnMud2l0aFN1YmFnZW50cyAtIHppcCDpgqPkuIDot6/mmK/lkKbluKblrZDlrZnvvIjpu5jorqQgdHJ1Ze+8ieOAglxuICogQHBhcmFtIG9wdGlvbnMud2l0aE1lZGlhIC0gemlwIOmCo+S4gOi3r+aYr+WQpuW4pumZhOS7tuWDj+e0oO+8iOm7mOiupCB0cnVl77yJ44CCXG4gKiBAcmV0dXJucyDlhpnlh7rnmoTot6/lvoTkuI7kvZPnp6/vvJvlpLHotKXkuI3mipvjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4cG9ydEhpc3RvcnkoXG4gICAgbm9kZUV4ZTogc3RyaW5nIHwgbnVsbCxcbiAgICBjd2Q6IHN0cmluZyxcbiAgICBzZXNzaW9uSWQ6IHN0cmluZyxcbiAgICBmb3JtYXQ6IEhpc3RvcnlFeHBvcnRGb3JtYXQgPSAnbWQnLFxuICAgIG9wdGlvbnM6IHsgd2l0aFN1YmFnZW50cz86IGJvb2xlYW47IHdpdGhNZWRpYT86IGJvb2xlYW4gfSA9IHt9LFxuKTogUHJvbWlzZTxIaXN0b3J5RXhwb3J0UmVzdWx0PiB7XG4gICAgaWYgKCFub2RlRXhlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBOT19OT0RFX0hJTlQgfTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnRyaW0oKSA6ICcnO1xuICAgIGlmICghaWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdleHBvcnRIaXN0b3J577ya5Lya6K+dIGlkIOaYr+epuueahCcgfTtcbiAgICBjb25zdCB6aXAgPSBmb3JtYXQgPT09ICd6aXAnO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgICAgICAnZXhwb3J0JyxcbiAgICAgICAgICAgICctLXJvb3QnLFxuICAgICAgICAgICAgc2Vzc2lvbnNSb290KCksXG4gICAgICAgICAgICAnLS1wcm9qZWN0JyxcbiAgICAgICAgICAgIHByb2plY3RLZXkoY3dkKSxcbiAgICAgICAgICAgICctLWlkJyxcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgJy0tZm9ybWF0JyxcbiAgICAgICAgICAgIHppcCA/ICd6aXAnIDogZm9ybWF0ID09PSAnanNvbmwnID8gJ2pzb25sJyA6ICdtZCcsXG4gICAgICAgIF07XG4gICAgICAgIGlmICh6aXApIHtcbiAgICAgICAgICAgIC8vIENMSSDkvqcgemlwIOm7mOiupOWwseW4pui/meS4pOagt++8m+aYvuW8j+WGmeWHuuadpeaYr+S4uuS6huiuqeOAjOmdouadv+eCueS6huS7gOS5iOOAjeS4juOAjOiEmuacrOaUtuWIsOS7gOS5iOOAjeS4gOS4gOWvueW+l+S4ilxuICAgICAgICAgICAgaWYgKG9wdGlvbnMud2l0aFN1YmFnZW50cyAhPT0gZmFsc2UpIGFyZ3MucHVzaCgnLS13aXRoLXN1YmFnZW50cycpO1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMud2l0aE1lZGlhICE9PSBmYWxzZSkgYXJncy5wdXNoKCctLXdpdGgtbWVkaWEnKTtcbiAgICAgICAgfVxuICAgICAgICAvLyB6aXAg6KaB6Kej5Y6L5a2Q5a2Z5pel5b+XICsg6K+76ZmE5Lu277yM5q+UIG1kIOaFouW+l+Wkmu+8iOacrOacuuS4gOadoeWHoOWNg+i9rueahOS8muivneWunua1i+enkue6p+WIsOWNgeWHoOenku+8iVxuICAgICAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcnVuUmVhZGVyKG5vZGVFeGUsIGFyZ3MsIHppcCA/IDMwMF8wMDAgOiAxMjBfMDAwKTtcbiAgICAgICAgaWYgKHBheWxvYWQub2sgIT09IHRydWUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhwYXlsb2FkLmVycm9yID8/ICflr7zlh7rlpLHotKUnKSB9O1xuICAgICAgICBjb25zdCByZXN1bHQ6IEhpc3RvcnlFeHBvcnRSZXN1bHQgPSB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGlkOiB0eXBlb2YgcGF5bG9hZC5pZCA9PT0gJ3N0cmluZycgPyBwYXlsb2FkLmlkIDogaWQsXG4gICAgICAgICAgICB0aXRsZTogdHlwZW9mIHBheWxvYWQudGl0bGUgPT09ICdzdHJpbmcnID8gcGF5bG9hZC50aXRsZSA6ICcnLFxuICAgICAgICAgICAgZm9ybWF0OiB0eXBlb2YgcGF5bG9hZC5mb3JtYXQgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5mb3JtYXQgOiBmb3JtYXQsXG4gICAgICAgICAgICBwYXRoOiB0eXBlb2YgcGF5bG9hZC5wYXRoID09PSAnc3RyaW5nJyA/IHBheWxvYWQucGF0aCA6ICcnLFxuICAgICAgICAgICAgZGlyOiB0eXBlb2YgcGF5bG9hZC5kaXIgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5kaXIgOiAnJyxcbiAgICAgICAgICAgIGJ5dGVzOiBudW1iZXJPclVuZGVmaW5lZChwYXlsb2FkLmJ5dGVzKSxcbiAgICAgICAgICAgIGV2ZW50czogbnVtYmVyT3JVbmRlZmluZWQocGF5bG9hZC5ldmVudHMpLFxuICAgICAgICB9O1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwYXlsb2FkLm5vdGVzKSAmJiBwYXlsb2FkLm5vdGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJlc3VsdC5ub3RlcyA9IHBheWxvYWQubm90ZXMuZmlsdGVyKChsaW5lOiB1bmtub3duKTogbGluZSBpcyBzdHJpbmcgPT4gdHlwZW9mIGxpbmUgPT09ICdzdHJpbmcnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1pc3NpbmdNZWRpYSkgJiYgcGF5bG9hZC5taXNzaW5nTWVkaWEubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcmVzdWx0Lm1pc3NpbmdNZWRpYSA9IHBheWxvYWQubWlzc2luZ01lZGlhLmZpbHRlcigobGluZTogdW5rbm93bik6IGxpbmUgaXMgc3RyaW5nID0+IHR5cGVvZiBsaW5lID09PSAnc3RyaW5nJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3U3VicyA9IHBheWxvYWQuc3ViYWdlbnRzO1xuICAgICAgICBpZiAocmF3U3VicyAmJiB0eXBlb2YgcmF3U3VicyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IHN1YnMgPSByYXdTdWJzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgcmVzdWx0LnN1YmFnZW50cyA9IHtcbiAgICAgICAgICAgICAgICB0b3RhbDogbnVtYmVyT3JVbmRlZmluZWQoc3Vicy50b3RhbCkgPz8gMCxcbiAgICAgICAgICAgICAgICBzdWJhZ2VudENvdW50OiBudW1iZXJPclVuZGVmaW5lZChzdWJzLnN1YmFnZW50Q291bnQpID8/IDAsXG4gICAgICAgICAgICAgICAgZm9ya0NvdW50OiBudW1iZXJPclVuZGVmaW5lZChzdWJzLmZvcmtDb3VudCkgPz8gMCxcbiAgICAgICAgICAgICAgICBtYXhEZXB0aDogbnVtYmVyT3JVbmRlZmluZWQoc3Vicy5tYXhEZXB0aCkgPz8gbnVsbCxcbiAgICAgICAgICAgICAgICBkYW5nbGluZzogQXJyYXkuaXNBcnJheShzdWJzLmRhbmdsaW5nKSA/IHN1YnMuZGFuZ2xpbmcuZmlsdGVyKCh4OiB1bmtub3duKTogeCBpcyBzdHJpbmcgPT4gdHlwZW9mIHggPT09ICdzdHJpbmcnKSA6IFtdLFxuICAgICAgICAgICAgICAgIGluY29tcGxldGU6IHN1YnMuaW5jb21wbGV0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3TWVkaWEgPSBwYXlsb2FkLm1lZGlhO1xuICAgICAgICBpZiAocmF3TWVkaWEgJiYgdHlwZW9mIHJhd01lZGlhID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgY29uc3QgbWVkaWEgPSByYXdNZWRpYSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICAgIHJlc3VsdC5tZWRpYSA9IHtcbiAgICAgICAgICAgICAgICBjb3VudDogbnVtYmVyT3JVbmRlZmluZWQobWVkaWEuY291bnQpID8/IDAsXG4gICAgICAgICAgICAgICAgbWlzc2luZzogbnVtYmVyT3JVbmRlZmluZWQobWVkaWEubWlzc2luZykgPz8gMCxcbiAgICAgICAgICAgICAgICBuYW1pbmdEZXZpYXRpb246IHR5cGVvZiBtZWRpYS5uYW1pbmdEZXZpYXRpb24gPT09ICdzdHJpbmcnID8gbWVkaWEubmFtaW5nRGV2aWF0aW9uIDogbnVsbCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3WmlwID0gcGF5bG9hZC56aXA7XG4gICAgICAgIGlmIChyYXdaaXAgJiYgdHlwZW9mIHJhd1ppcCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGZhY3RzID0gcmF3WmlwIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgcmVzdWx0LnppcCA9IHtcbiAgICAgICAgICAgICAgICBmaWxlTmFtZTogdHlwZW9mIGZhY3RzLmZpbGVOYW1lID09PSAnc3RyaW5nJyA/IGZhY3RzLmZpbGVOYW1lIDogJycsXG4gICAgICAgICAgICAgICAgZW50cmllczogbnVtYmVyT3JVbmRlZmluZWQoZmFjdHMuZW50cmllcykgPz8gMCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnJvcikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog5Yig5o6J5LiA5p2h5Lya6K+d77yIKirlj6rliKDkvJror53nm67lvZXmnKzouqsqKu+8jOmZhOS7tum7mOiupOS4jeeisO+8ieOAglxuICpcbiAqIGBkcnlSdW5gIOmCo+i2n+WPquS4uuaLv+a4heWNle+8iOmdouadv+aLv+Wug+WBmuS6jOasoeehruiupO+8muOAjOWwhuWIoOmZpCAxIOS4quaWh+S7tiDCtyAxLjcgTULjgI3vvInvvIxcbiAqIOecn+WIoOaYr+esrOS6jOasoeeCueWHuyDigJTigJQg5LiA5qyh54K56ZSZ5bCx5oqK5LiA5q615Y6G5Y+y5oq55LqG77yM6L+Z5Liq6Zmp5LiN5YC85b6X5YaS44CCXG4gKlxuICogIyMg6ZmE5Lu25Zue5pS277yIYHJlY2xhaW1BdHRhY2htZW50c2DvvIwqKum7mOiupOWFsyoq77yJXG4gKlxuICog6ZmE5Lu277yI5Zu+54mH77yJ5oyJ5YaF5a655a2Y5ZyoIGA8RFNIX0hPTUU+L2F0dGFjaG1lbnRzL3YxL29iamVjdHMv4oCmYO+8jCoq6Leo5Lya6K+d5Y676YeN5YWx55SoKirvvIxcbiAqIERTSCDoh6rlt7HkuZ/kuI3lm57mlLbjgILmiYDku6Xpu5jorqTliKDpmaQqKuS4jeS8mioq5Yqo5a6D5Lus77yM5Lmf5LiN5Lya5Zug5q2k6IW+5Ye65Zu+54mH5Y2g55qE56m66Ze0IOKAlOKAlFxuICog6Z2i5p2/5LiK5b+F6aG76K+06L+Z5Y+l6K+d44CCXG4gKlxuICog5omT5byA6L+Z5Liq5byA5YWz5pe277yM6ISa5pys5Lya5ZyoKirliKDnm67lvZXkuYvliY0qKueul+S4gOmBjeOAjOi/meadoeS8muivneW8leeUqOeahOmZhOS7tumHjO+8jOWTquS6m+WFqOW6k+ayoeS6uuWGjeW8leeUqOOAje+8jFxuICog54S25ZCO5oqK5a6D5LusKirmkKzov5vlopPnopEqKu+8iGBhdHRhY2htZW50cy92MS8udHJhc2gtPOaXpeacnz4vYO+8jOWQjOebmCByZW5hbWXvvIwqKuawuOS4jSB1bmxpbmsqKu+8ieOAglxuICog5LiJ5p2h56Gs5Y+j5b6E77yI6YO95Zyo6ISa5pys6YeM77yM5Yir5Zyo6Z2i5p2/5LiK6YeN5paw5Y+R5piO77yJ77yaXG4gKiDikaAgKirotoXpooTnrpcgPSDkuIDkuKrpg73kuI3mkKwqKu+8iGBpbmNvbXBsZXRlOiB0cnVlYO+8jGZhaWwtY2xvc2Vk77yJ77ybXG4gKiDikaEg5q+P5Liq5YCZ6YCJ6YO96KaBKirlpI3nrpcgc2hhMjU2IOS4jiBieXRlcyoqIOWvueW+l+S4iuaJjeaQrO+8m1xuICog4pGiIOaXtumXtOeql++8iOacgOi/kSAxIOWwj+aXtuWKqOi/h+eahOWvueixoei3s+i/hyDigJTigJQg5Yir55qE6L+b56iL5Y+v6IO95Yia5YaZ44CB5pel5b+X6L+Y5rKh6JC955uY77yJ44CCXG4gKlxuICog4pqgIOWug+eahCoq6ICX5pe25piv5YiG6ZKf57qnKirvvIjmnKzmnLogNDk4IOadoeS8muivnSAvIDU2OSBNQiDlhajlupPmiavmj4/vvJrop6PljosgNjAuOHMgKyDop6PmnpAgOC4yc++8ie+8jFxuICog5omA5Lul6Z2i5p2/5LiK6KaBKirlhYjor7TopoHnrYkgMX4yIOWIhumSnyoq77yM6ICM5LiN5piv6K6p5Lq65Lul5Li65oyJ5LiL5Y675rKh5Y+N5bqU44CCXG4gKlxuICogQHBhcmFtIG5vZGVFeGUgLSDnlKjmnaXot5Hor7vlj5blmajnmoQgbm9kZeOAglxuICogQHBhcmFtIGN3ZCAtIOW3peeoi+agueebruW9leOAglxuICogQHBhcmFtIHNlc3Npb25JZCAtIOS8muivnSBpZOOAglxuICogQHBhcmFtIGRyeVJ1biAtIOWPquaKpea4heWNleS4jeWKqOebmOOAglxuICogQHBhcmFtIG9wdGlvbnMucmVjbGFpbUF0dGFjaG1lbnRzIC0g6aG65bim5Zue5pS25peg5byV55So6ZmE5Lu277yI6buY6K6k5YWz77yJ44CCXG4gKiBAcmV0dXJucyDmuIXljZXkuI7mmK/lkKbnnJ/liKDkuobvvJvlpLHotKXkuI3mipvjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUhpc3RvcnkoXG4gICAgbm9kZUV4ZTogc3RyaW5nIHwgbnVsbCxcbiAgICBjd2Q6IHN0cmluZyxcbiAgICBzZXNzaW9uSWQ6IHN0cmluZyxcbiAgICBkcnlSdW4gPSBmYWxzZSxcbiAgICBvcHRpb25zOiB7IHJlY2xhaW1BdHRhY2htZW50cz86IGJvb2xlYW4gfSA9IHt9LFxuKTogUHJvbWlzZTxIaXN0b3J5RGVsZXRlUmVzdWx0PiB7XG4gICAgaWYgKCFub2RlRXhlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBOT19OT0RFX0hJTlQgfTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnRyaW0oKSA6ICcnO1xuICAgIGlmICghaWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdkZWxldGVIaXN0b3J577ya5Lya6K+dIGlkIOaYr+epuueahCcgfTtcbiAgICBjb25zdCByZWNsYWltID0gb3B0aW9ucy5yZWNsYWltQXR0YWNobWVudHMgPT09IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYXJncyA9IFsnZGVsZXRlJywgJy0tcm9vdCcsIHNlc3Npb25zUm9vdCgpLCAnLS1wcm9qZWN0JywgcHJvamVjdEtleShjd2QpLCAnLS1pZCcsIGlkXTtcbiAgICAgICAgaWYgKGRyeVJ1bikgYXJncy5wdXNoKCctLWRyeS1ydW4nKTtcbiAgICAgICAgaWYgKHJlY2xhaW0pIGFyZ3MucHVzaCgnLS1yZWNsYWltLWF0dGFjaG1lbnRzJyk7XG4gICAgICAgIC8vIOW4puWbnuaUtuaXtuaYryoq5YiG6ZKf57qnKirvvJrotoXml7bnu5notrPvvIjohJrmnKzoh6rlt7Hov5jmnInkuIDlsYLpooTnrpfvvIzov5nph4zlj6rmmK/liKvmiorlroPmjpDmrbvvvIlcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IGF3YWl0IHJ1blJlYWRlcihub2RlRXhlLCBhcmdzLCByZWNsYWltID8gMzAwXzAwMCA6IDYwXzAwMCk7XG4gICAgICAgIGlmIChwYXlsb2FkLm9rICE9PSB0cnVlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcocGF5bG9hZC5lcnJvciA/PyAn5Yig6Zmk5aSx6LSlJykgfTtcbiAgICAgICAgY29uc3QgcmVzdWx0OiBIaXN0b3J5RGVsZXRlUmVzdWx0ID0ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBpZDogdHlwZW9mIHBheWxvYWQuaWQgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5pZCA6IGlkLFxuICAgICAgICAgICAgZGlyOiB0eXBlb2YgcGF5bG9hZC5kaXIgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5kaXIgOiAnJyxcbiAgICAgICAgICAgIHJlbW92ZWQ6IHBheWxvYWQucmVtb3ZlZCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIGZpbGVDb3VudDogbnVtYmVyT3JVbmRlZmluZWQocGF5bG9hZC5maWxlQ291bnQpLFxuICAgICAgICAgICAgYnl0ZXM6IG51bWJlck9yVW5kZWZpbmVkKHBheWxvYWQuYnl0ZXMpLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCByYXdSZWNsYWltID0gcGF5bG9hZC5yZWNsYWltO1xuICAgICAgICBpZiAocmF3UmVjbGFpbSAmJiB0eXBlb2YgcmF3UmVjbGFpbSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGZhY3RzID0gcmF3UmVjbGFpbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICAgIGNvbnN0IHNjYW5uZWQgPSAoZmFjdHMuc2Nhbm5lZCA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgICByZXN1bHQucmVjbGFpbSA9IHtcbiAgICAgICAgICAgICAgICBkcnlSdW46IGZhY3RzLmRyeVJ1biA9PT0gdHJ1ZSxcbiAgICAgICAgICAgICAgICBjYW5kaWRhdGVzOiBudW1iZXJPclVuZGVmaW5lZChmYWN0cy5jYW5kaWRhdGVzKSA/PyAwLFxuICAgICAgICAgICAgICAgIHJlZmVyZW5jZWQ6IG51bWJlck9yVW5kZWZpbmVkKGZhY3RzLnJlZmVyZW5jZWQpID8/IDAsXG4gICAgICAgICAgICAgICAgb3JwaGFuczogbnVtYmVyT3JVbmRlZmluZWQoZmFjdHMub3JwaGFucykgPz8gMCxcbiAgICAgICAgICAgICAgICB0cmFzaGVkOiBudW1iZXJPclVuZGVmaW5lZChmYWN0cy50cmFzaGVkKSA/PyAwLFxuICAgICAgICAgICAgICAgIGJ5dGVzRnJlZWQ6IG51bWJlck9yVW5kZWZpbmVkKGZhY3RzLmJ5dGVzRnJlZWQpID8/IDAsXG4gICAgICAgICAgICAgICAgaW5jb21wbGV0ZTogZmFjdHMuaW5jb21wbGV0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICAgICAgICBpbmNvbXBsZXRlUmVhc29uOiB0eXBlb2YgZmFjdHMuaW5jb21wbGV0ZVJlYXNvbiA9PT0gJ3N0cmluZycgPyBmYWN0cy5pbmNvbXBsZXRlUmVhc29uIDogbnVsbCxcbiAgICAgICAgICAgICAgICBzY2FubmVkOiB7XG4gICAgICAgICAgICAgICAgICAgIHNlc3Npb25zOiBudW1iZXJPclVuZGVmaW5lZChzY2FubmVkLnNlc3Npb25zKSA/PyAwLFxuICAgICAgICAgICAgICAgICAgICBieXRlczogbnVtYmVyT3JVbmRlZmluZWQoc2Nhbm5lZC5ieXRlcykgPz8gMCxcbiAgICAgICAgICAgICAgICAgICAgZWxhcHNlZE1zOiBudW1iZXJPclVuZGVmaW5lZChzY2FubmVkLmVsYXBzZWRNcykgPz8gMCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHNraXBwZWQ6IEFycmF5LmlzQXJyYXkoZmFjdHMuc2tpcHBlZClcbiAgICAgICAgICAgICAgICAgICAgPyBmYWN0cy5za2lwcGVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKGVudHJ5KTogZW50cnkgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4gQm9vbGVhbihlbnRyeSkgJiYgdHlwZW9mIGVudHJ5ID09PSAnb2JqZWN0JylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLm1hcCgoZW50cnkpID0+ICh7IGlkOiBTdHJpbmcoZW50cnkuaWQgPz8gJycpLCByZWFzb246IFN0cmluZyhlbnRyeS5yZWFzb24gPz8gJycpIH0pKVxuICAgICAgICAgICAgICAgICAgICA6IFtdLFxuICAgICAgICAgICAgICAgIHRyYXNoRGlyOiB0eXBlb2YgZmFjdHMudHJhc2hEaXIgPT09ICdzdHJpbmcnID8gZmFjdHMudHJhc2hEaXIgOiAnJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnJvcikgfTtcbiAgICB9XG59XG4iXX0=