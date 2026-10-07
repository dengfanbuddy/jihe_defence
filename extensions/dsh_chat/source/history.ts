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

import { spawn } from 'child_process';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** 一条历史会话的摘要（面板列表用）。 */
export interface HistorySession {
    /** 会话 id（同时也是 DSH 侧恢复会话用的 key）。 */
    id: string;
    /** 首条用户消息（拿不到就是空串）。 */
    title: string;
    /** 会话创建时刻（来自日志头）。 */
    createdAt: number | null;
    /** 日志最后写入时刻。 */
    updatedAt: number;
    /** 日志字节数。 */
    bytes: number;
    /** 日志里出现过多少个回合（`turn/start` 计数）。 */
    turns: number;
}

/** 读日志的结果。 */
export interface HistoryReadResult {
    ok: boolean;
    error?: string;
    /** 日志头（含 `id` / `cwd` / `createdAt`）。 */
    header?: Record<string, unknown> | null;
    /** 保留了哪些事件（`user/message` / `assistant/message` / `tool/call` / `tool/result` …）。 */
    events?: Array<Record<string, unknown>>;
    /** 事件总数（截断前）。 */
    total?: number;
    /** zstd 帧数（诊断用）。 */
    frameCount?: number;
    /** 末尾是否有半个帧（崩溃/正在写）。 */
    torn?: boolean;
}

/** 单次 spawn 的上限：读 5MB 日志实测亚秒级，给足余量。 */
const READER_TIMEOUT_MS = 20_000;

/**
 * DSH 的工程键（**照抄** `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey`）。
 *
 * 规则：`/` `\` `:` 折叠成一个 `-`；`[A-Za-z0-9._-]` 原样；其余字符转义成 `~XXXX`（大写十六进制）；
 * 最后包成 `--…--`，截断到 251 字符。
 *
 * @param cwd - 工程根目录。
 * @returns 会话根目录下的工程子目录名。
 */
export function projectKey(cwd: string): string {
    if (!cwd) throw new Error('projectKey：工程路径是空的');
    let readable = '';
    let separatorRun = false;
    for (let index = 0; index < cwd.length; index += 1) {
        const code = cwd.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun) readable += '-';
            separatorRun = true;
        } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        } else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** `<DSH_HOME>/sessions`（`DSH_HOME` 没设就按 `~/.dsh`，与 DSH 自己同口径）。 */
export function sessionsRoot(): string {
    const home = process.env.DSH_HOME?.trim();
    return join(home && home !== '' ? home : join(homedir(), '.dsh'), 'sessions');
}

/** 读取器脚本的路径（`dist/history.js` → `<扩展根>/scripts/session-log.js`）。 */
function readerPath(): string {
    return resolve(__dirname, '..', 'scripts', 'session-log.js');
}

/** 把异常收敛成一句话。 */
function describe(error: unknown): string {
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
function runReader(
    nodeExe: string,
    args: string[],
    timeoutMs = READER_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, rejectPromise) => {
        let child;
        try {
            child = spawn(nodeExe, [readerPath(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            rejectPromise(new Error(`启动 node 读会话日志失败：${describe(error)}`));
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                child.kill();
            } catch {
                /* 已经退了 */
            }
            rejectPromise(new Error(`读会话日志超时（${timeoutMs}ms）`));
        }, timeoutMs);

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
            // 一份日志的投影不该超过这个量级；超了就是哪儿不对，别把主进程撑爆
            if (stdout.length > 64 * 1024 * 1024) {
                try {
                    child.kill();
                } catch {
                    /* 忽略 */
                }
            }
        });
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new Error(`读会话日志失败：${describe(error)}`));
        });

        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const line = stdout.trim().split('\n').pop() ?? '';
            try {
                resolvePromise(JSON.parse(line) as Record<string, unknown>);
            } catch {
                rejectPromise(
                    new Error(
                        `读会话日志的输出不是 JSON：${line.slice(0, 200) || '(空)'}` +
                            (stderr ? `；stderr：${stderr.trim().slice(0, 200)}` : ''),
                    ),
                );
            }
        });
    });
}

/** 缺 node 时的统一文案（这不是「没装 dsh」那么明显，说清楚为什么读不了）。 */
const NO_NODE_HINT =
    '读会话日志需要一个 **Node ≥ 22.15**（日志是 zstd 压缩的，编辑器自带的 Electron/Node 20 解不开）。' +
    '请在设置里填「node 路径」，或把 node 加到 PATH。';

/**
 * 列出本工程的历史会话（按最后修改时间倒序）。
 *
 * @param nodeExe - 用来跑读取器的 node（`paths.ts` 探测出来的那个）。
 * @param cwd - 工程根目录。
 * @param limit - 最多几条。
 * @returns `{ok, sessions?, error?}`；失败不抛，让面板能显示原因。
 */
export async function listHistory(
    nodeExe: string | null,
    cwd: string,
    limit = 20,
): Promise<{ ok: boolean; sessions?: HistorySession[]; error?: string }> {
    if (!nodeExe) return { ok: false, error: NO_NODE_HINT };
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
        if (payload.ok !== true) return { ok: false, error: String(payload.error ?? '读取器返回失败') };
        const sessions = Array.isArray(payload.sessions) ? (payload.sessions as HistorySession[]) : [];
        return { ok: true, sessions };
    } catch (error) {
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
export async function readHistory(
    nodeExe: string | null,
    cwd: string,
    sessionId: string,
    maxEvents = 2000,
): Promise<HistoryReadResult> {
    if (!nodeExe) return { ok: false, error: NO_NODE_HINT };
    if (!sessionId) return { ok: false, error: 'readHistory：会话 id 是空的' };
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
        if (payload.ok !== true) return { ok: false, error: String(payload.error ?? '读取器返回失败') };
        return {
            ok: true,
            header: (payload.header ?? null) as Record<string, unknown> | null,
            events: Array.isArray(payload.events) ? (payload.events as Array<Record<string, unknown>>) : [],
            total: typeof payload.total === 'number' ? payload.total : undefined,
            frameCount: typeof payload.frameCount === 'number' ? payload.frameCount : undefined,
            torn: payload.torn === true,
        };
    } catch (error) {
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
export function titleOfEvents(events: Array<Record<string, unknown>>): string {
    for (const event of events) {
        if (event.type !== 'user/message') continue;
        const data = (event.data ?? {}) as Record<string, unknown>;
        const source = data.source as { kind?: string } | undefined;
        if (source && source.kind !== 'user') continue;
        const content = (data.content ?? (data.message as { content?: unknown } | undefined)?.content) as unknown;
        if (!Array.isArray(content)) continue;
        const text = content
            .filter((block): block is { type: string; text: string } => {
                const candidate = block as { type?: string; text?: unknown };
                return candidate?.type === 'text' && typeof candidate.text === 'string';
            })
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text) return text.slice(0, 80);
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
export function loggedTitleOf(events: Array<Record<string, unknown>>): string {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'session/title') continue;
        const data = (event.data ?? {}) as Record<string, unknown>;
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title) return title.slice(0, 120);
    }
    return '';
}

// ---------------------------------------------------------------- 全文搜索

/** 搜索的预算（面板不传时用这份；与 `session-log.js` 的 `SEARCH_DEFAULTS` 同口径）。 */
export interface HistorySearchOptions {
    /** 最多几条会话；**同时也是「找到这么多就收工」的停止条件**（见脚本里的注释）。 */
    limit?: number;
    /** 每条会话最多几个片段。 */
    perSession?: number;
    /** 最多检查几个会话目录。 */
    maxSessions?: number;
    /** 最多读多少压缩字节。 */
    maxBytes?: number;
    /** 时间预算（毫秒）。 */
    budgetMs?: number;
}

/** 搜索回执（字段与脚本的输出同形，面板只画不算）。 */
export interface HistorySearchResult {
    ok: boolean;
    error?: string;
    query?: string;
    hits?: Array<Record<string, unknown>>;
    scanned?: number;
    available?: number;
    partial?: boolean;
    stoppedBy?: string | null;
    elapsedMs?: number;
    scannedBytes?: number;
}

/** 搜索的时间上限：给脚本自己的 `budgetMs` 留足余量（它还要解压、投影、排序）。 */
const SEARCH_TIMEOUT_SLACK_MS = 30_000;

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
export async function searchHistory(
    nodeExe: string | null,
    cwd: string,
    query: string,
    options: HistorySearchOptions = {},
): Promise<HistorySearchResult> {
    if (!nodeExe) return { ok: false, error: NO_NODE_HINT };
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return { ok: false, error: '搜索词是空的' };
    if (text.length > 200) return { ok: false, error: '搜索词太长了（最多 200 字）' };

    const args = [
        'search',
        '--root',
        sessionsRoot(),
        '--project',
        projectKey(cwd),
        '--query',
        text,
    ];
    const push = (flag: string, value: number | undefined): void => {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) args.push(flag, String(Math.floor(value)));
    };
    push('--limit', options.limit);
    push('--per-session', options.perSession);
    push('--max-sessions', options.maxSessions);
    push('--max-bytes', options.maxBytes);
    push('--budget-ms', options.budgetMs);

    try {
        const payload = await runReader(nodeExe, args, (options.budgetMs ?? 6_000) + SEARCH_TIMEOUT_SLACK_MS);
        if (payload.ok !== true) return { ok: false, error: String(payload.error ?? '搜索失败') };
        return {
            ok: true,
            query: typeof payload.query === 'string' ? payload.query : text,
            hits: Array.isArray(payload.hits) ? (payload.hits as Array<Record<string, unknown>>) : [],
            scanned: numberOrUndefined(payload.scanned),
            available: numberOrUndefined(payload.available),
            partial: payload.partial === true,
            stoppedBy: typeof payload.stoppedBy === 'string' ? payload.stoppedBy : null,
            elapsedMs: numberOrUndefined(payload.elapsedMs),
            scannedBytes: numberOrUndefined(payload.scannedBytes),
        };
    } catch (error) {
        return { ok: false, error: describe(error) };
    }
}

/** 把「可能是数字」的值收敛成 number | undefined。 */
function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------- 导出 / 删除

/** 导出回执。 */
export interface HistoryExportResult {
    ok: boolean;
    error?: string;
    id?: string;
    title?: string;
    format?: string;
    path?: string;
    dir?: string;
    bytes?: number;
    events?: number;
    /**
     * ZIP 那一路的子孙会话事实（只有带 `--with-subagents` 才会有）。
     *
     * ⚠ `subagentCount` 与 `forkCount` **分开报**，不许合成一个「子孙数」：
     * 两者在会话日志头里的判据不同（`origin === 'subagent'` vs「有 `parentSession` 但没有 origin」），
     * 而用户看到「含 5 个子会话」时想知道的是「这 5 个里有几个是我真正派出去的 agent」。
     */
    subagents?: {
        total: number;
        subagentCount: number;
        forkCount: number;
        maxDepth: number | null;
        /** 索引里查不到父级的会话（悬空引用）—— 如实带出去，不假装树是完整的。 */
        dangling: string[];
        incomplete: boolean;
    };
    /** ZIP 那一路的附件事实。 */
    media?: { count: number; missing: number; namingDeviation: string | null };
    /** 引用了但**读不到文件**的附件 id（缺失就如实说，不静默少导）。 */
    missingMedia?: string[];
    /** 这一趟要交代的话（活跃会话可能少最后几条 / 索引超预算 / 缺媒体…）。 */
    notes?: string[];
    /** ZIP 自己的事实（文件名与条目数）。 */
    zip?: { fileName: string; entries: number };
}

/** 删除回执。 */
export interface HistoryDeleteResult {
    ok: boolean;
    error?: string;
    id?: string;
    dir?: string;
    removed?: boolean;
    fileCount?: number;
    bytes?: number;
    /**
     * 「删会话时顺带回收无引用附件」那一趟的结果（`--reclaim-attachments` 才有）。
     *
     * ⚠ 这一块**天然是「可能什么都没做」**：本机实测 797 个附件对象**全都被至少一条会话引用**，
     * 所以 `orphans` 通常是 0，而且**超预算时 `incomplete: true` 且一个都不搬**（fail-closed）。
     * 面板上不许把它宣传成「一键腾空间」—— 它只在删过「引用唯一」的会话之后才有活干。
     */
    reclaim?: {
        dryRun: boolean;
        candidates: number;
        referenced: number;
        orphans: number;
        trashed: number;
        bytesFreed: number;
        /** 全库扫描被预算中断 ⇒ **一个都没搬**（这一条必须原样画出来）。 */
        incomplete: boolean;
        incompleteReason: string | null;
        /** 全库扫描的口径（几条会话 / 多少字节 / 多久）。 */
        scanned: { sessions: number; bytes: number; elapsedMs: number };
        /** 被否决的候选与原因（`still-referenced` / `hash-mismatch` / `recent` …）。 */
        skipped: Array<{ id: string; reason: string }>;
        trashDir: string;
    };
}

/**
 * 导出格式。
 *
 * - `md` = 给人读的转写；
 * - `jsonl` = 解压后原样的日志（给工具吃）；
 * - `zip` = **对齐 DSH 官方导出的那一份**：`session.jsonl` + `subagents/<id>/session.jsonl`
 *   + `media/<hex>.<ext>`（外加我们自己的 `manifest.json`）。
 *   ⚠ 它**默认就带子孙与附件像素**（zip 的意义就是那份布局），所以面板上那个按钮写着
 *   「含子会话与附件」，而不是给两个开关让人猜。
 */
export type HistoryExportFormat = 'md' | 'jsonl' | 'zip';

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
export async function exportHistory(
    nodeExe: string | null,
    cwd: string,
    sessionId: string,
    format: HistoryExportFormat = 'md',
    options: { withSubagents?: boolean; withMedia?: boolean } = {},
): Promise<HistoryExportResult> {
    if (!nodeExe) return { ok: false, error: NO_NODE_HINT };
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return { ok: false, error: 'exportHistory：会话 id 是空的' };
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
            if (options.withSubagents !== false) args.push('--with-subagents');
            if (options.withMedia !== false) args.push('--with-media');
        }
        // zip 要解压子孙日志 + 读附件，比 md 慢得多（本机一条几千轮的会话实测秒级到十几秒）
        const payload = await runReader(nodeExe, args, zip ? 300_000 : 120_000);
        if (payload.ok !== true) return { ok: false, error: String(payload.error ?? '导出失败') };
        const result: HistoryExportResult = {
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
            result.notes = payload.notes.filter((line: unknown): line is string => typeof line === 'string');
        }
        if (Array.isArray(payload.missingMedia) && payload.missingMedia.length > 0) {
            result.missingMedia = payload.missingMedia.filter((line: unknown): line is string => typeof line === 'string');
        }
        const rawSubs = payload.subagents;
        if (rawSubs && typeof rawSubs === 'object') {
            const subs = rawSubs as Record<string, unknown>;
            result.subagents = {
                total: numberOrUndefined(subs.total) ?? 0,
                subagentCount: numberOrUndefined(subs.subagentCount) ?? 0,
                forkCount: numberOrUndefined(subs.forkCount) ?? 0,
                maxDepth: numberOrUndefined(subs.maxDepth) ?? null,
                dangling: Array.isArray(subs.dangling) ? subs.dangling.filter((x: unknown): x is string => typeof x === 'string') : [],
                incomplete: subs.incomplete === true,
            };
        }
        const rawMedia = payload.media;
        if (rawMedia && typeof rawMedia === 'object') {
            const media = rawMedia as Record<string, unknown>;
            result.media = {
                count: numberOrUndefined(media.count) ?? 0,
                missing: numberOrUndefined(media.missing) ?? 0,
                namingDeviation: typeof media.namingDeviation === 'string' ? media.namingDeviation : null,
            };
        }
        const rawZip = payload.zip;
        if (rawZip && typeof rawZip === 'object') {
            const facts = rawZip as Record<string, unknown>;
            result.zip = {
                fileName: typeof facts.fileName === 'string' ? facts.fileName : '',
                entries: numberOrUndefined(facts.entries) ?? 0,
            };
        }
        return result;
    } catch (error) {
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
export async function deleteHistory(
    nodeExe: string | null,
    cwd: string,
    sessionId: string,
    dryRun = false,
    options: { reclaimAttachments?: boolean } = {},
): Promise<HistoryDeleteResult> {
    if (!nodeExe) return { ok: false, error: NO_NODE_HINT };
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return { ok: false, error: 'deleteHistory：会话 id 是空的' };
    const reclaim = options.reclaimAttachments === true;
    try {
        const args = ['delete', '--root', sessionsRoot(), '--project', projectKey(cwd), '--id', id];
        if (dryRun) args.push('--dry-run');
        if (reclaim) args.push('--reclaim-attachments');
        // 带回收时是**分钟级**：超时给足（脚本自己还有一层预算，这里只是别把它掐死）
        const payload = await runReader(nodeExe, args, reclaim ? 300_000 : 60_000);
        if (payload.ok !== true) return { ok: false, error: String(payload.error ?? '删除失败') };
        const result: HistoryDeleteResult = {
            ok: true,
            id: typeof payload.id === 'string' ? payload.id : id,
            dir: typeof payload.dir === 'string' ? payload.dir : '',
            removed: payload.removed === true,
            fileCount: numberOrUndefined(payload.fileCount),
            bytes: numberOrUndefined(payload.bytes),
        };
        const rawReclaim = payload.reclaim;
        if (rawReclaim && typeof rawReclaim === 'object') {
            const facts = rawReclaim as Record<string, unknown>;
            const scanned = (facts.scanned ?? {}) as Record<string, unknown>;
            result.reclaim = {
                dryRun: facts.dryRun === true,
                candidates: numberOrUndefined(facts.candidates) ?? 0,
                referenced: numberOrUndefined(facts.referenced) ?? 0,
                orphans: numberOrUndefined(facts.orphans) ?? 0,
                trashed: numberOrUndefined(facts.trashed) ?? 0,
                bytesFreed: numberOrUndefined(facts.bytesFreed) ?? 0,
                incomplete: facts.incomplete === true,
                incompleteReason: typeof facts.incompleteReason === 'string' ? facts.incompleteReason : null,
                scanned: {
                    sessions: numberOrUndefined(scanned.sessions) ?? 0,
                    bytes: numberOrUndefined(scanned.bytes) ?? 0,
                    elapsedMs: numberOrUndefined(scanned.elapsedMs) ?? 0,
                },
                skipped: Array.isArray(facts.skipped)
                    ? facts.skipped
                          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
                          .map((entry) => ({ id: String(entry.id ?? ''), reason: String(entry.reason ?? '') }))
                    : [],
                trashDir: typeof facts.trashDir === 'string' ? facts.trashDir : '',
            };
        }
        return result;
    } catch (error) {
        return { ok: false, error: describe(error) };
    }
}
