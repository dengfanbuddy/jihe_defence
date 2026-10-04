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
 */
function runReader(
    nodeExe: string,
    args: string[],
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
            rejectPromise(new Error(`读会话日志超时（${READER_TIMEOUT_MS}ms）`));
        }, READER_TIMEOUT_MS);

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
