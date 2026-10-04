/**
 * 沙箱执行器 —— Code Mode 的「入口闸门」。
 *
 * 把一段用户（AI）写的 JS 跑起来，收集它的 `return` 值、`console.*` 输出、错误与耗时。
 *
 * ## 代码约定
 *
 * 用户代码被包进 `(async () => { ... })()`，因此顶层可以直接：
 * - `return <值>` —— 这就是本次执行的返回值
 * - `await ...` —— 顶层 await
 *
 * 注入的全局量直接以裸标识符出现（`cc`、`scene`、`Editor`…），不是挂在某个 `ctx` 上 ——
 * 少一层前缀，模型少写一堆字符。
 *
 * ## 两层超时（重要）
 *
 * `vm` 的 `timeout` 选项**只管同步执行段**。也就是说：
 * - `while(true){}` → 被 vm 的 timeout 掐死 ✅
 * - `await new Promise(()=>{})` → vm 不管，靠外层 `Promise.race` 的计时器 reject ✅
 *
 * 但外层计时器只能让**调用方**不再等，**沙箱里的异步代码并不会被真正杀掉**
 * （Node 没有抢占式取消）。所以超时后的清理要谨慎：本模块只报告超时，
 * 不假装已经终止了那段代码。要绝对隔离只能上子进程，那成本不是编辑器插件该付的。
 *
 * ## 安全性说明（不要被这个类名误导）
 *
 * `vm` **不是安全边界**。它挡得住手滑（不污染宿主全局、同步死循环能被掐），
 * 挡不住有意越界（`this.constructor.constructor('return process')()` 之类的逃逸是已知的）。
 * 本插件的信任模型是「你本机、你自己的 AI 客户端」，不是「跑陌生人的代码」。
 * 真正起作用的安全边界是 **HTTP 只绑 127.0.0.1**（见 mcp/server.ts）。
 */

import * as vm from 'vm';
import { formatInline } from './serialize';

export type SandboxLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface SandboxLogEntry {
    level: SandboxLogLevel;
    text: string;
    /** 相对本次执行开始的毫秒偏移，便于对齐时序 */
    atMs: number;
}

export interface SandboxRunOptions {
    /** 用户代码（顶层支持 `return` / `await`） */
    code: string;
    /** 注入沙箱的全局量，key 即裸标识符名 */
    globals: Record<string, unknown>;
    /** 超时毫秒 */
    timeoutMs: number;
    /** 用于 vm 文件名与错误信息，不含扩展名 */
    label: string;
    /** 单条日志最大字符数 */
    maxLogLength?: number;
    /** 日志条数上限 */
    maxLogs?: number;
}

export interface SandboxErrorInfo {
    name: string;
    message: string;
    stack?: string;
}

export interface SandboxRunResult {
    ok: boolean;
    /** 用户代码 `return` 的原值（未经序列化） */
    result?: unknown;
    logs: SandboxLogEntry[];
    error?: SandboxErrorInfo;
    durationMs: number;
    /** 是否因超时失败 */
    timedOut: boolean;
    /** 是否因日志条数上限而丢弃了后续日志 */
    logsTruncated: boolean;
}

class SandboxTimeoutError extends Error {
    readonly isSandboxTimeout = true;
    constructor(timeoutMs: number) {
        super(`执行超时（${timeoutMs}ms）`);
        this.name = 'SandboxTimeoutError';
    }
}

/** 跨 realm 安全的 Error 归一化：沙箱里抛出的 Error 在宿主侧 `instanceof Error` 为 false */
function normalizeError(err: unknown): SandboxErrorInfo {
    if (err === null || err === undefined) {
        return { name: 'Error', message: String(err) };
    }
    if (typeof err === 'object') {
        const anyErr = err as { name?: unknown; message?: unknown; stack?: unknown };
        const name = typeof anyErr.name === 'string' && anyErr.name ? anyErr.name : 'Error';
        const message =
            typeof anyErr.message === 'string' && anyErr.message ? anyErr.message : formatInline(err);
        const stack = typeof anyErr.stack === 'string' ? anyErr.stack : undefined;
        return { name, message, stack };
    }
    return { name: 'Error', message: String(err) };
}

function isTimeoutError(err: unknown): boolean {
    if (err && typeof err === 'object') {
        const anyErr = err as { isSandboxTimeout?: boolean; code?: unknown; message?: unknown };
        if (anyErr.isSandboxTimeout) return true;
        // Node 自己抛的 vm 超时
        if (anyErr.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return true;
        if (typeof anyErr.message === 'string' && /Script execution timed out/i.test(anyErr.message)) {
            return true;
        }
    }
    return false;
}

interface CapturedConsole {
    sink: SandboxLogEntry[];
    maxLogs: number;
    maxLogLength: number;
    truncated: boolean;
    startedAt: number;
}

function makeCapturedConsole(capture: CapturedConsole): Record<string, (...parts: unknown[]) => void> {
    const push = (level: SandboxLogLevel) => (...parts: unknown[]) => {
        if (capture.sink.length >= capture.maxLogs) {
            capture.truncated = true;
            return;
        }
        const text = parts
            .map((p) => (typeof p === 'string' ? p : formatInline(p, { maxDepth: 4, maxStringLength: 2000 })))
            .join(' ');
        capture.sink.push({
            level,
            text: text.length > capture.maxLogLength ? `${text.slice(0, capture.maxLogLength)}…` : text,
            atMs: Date.now() - capture.startedAt,
        });
    };
    return {
        log: push('log'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        debug: push('debug'),
        trace: push('debug'),
        dir: push('log'),
    };
}

/** 把用户代码包成可 `return` / `await` 的异步 IIFE */
export function wrapUserCode(code: string): string {
    return `(async () => {\n${code}\n})()`;
}

/**
 * 在隔离的 vm 上下文里执行用户代码。
 *
 * @example
 * const run = await runInSandbox({
 *     code: 'return 1 + 1;',
 *     globals: { Editor },
 *     timeoutMs: 15000,
 *     label: 'editor',
 * });
 */
export async function runInSandbox(options: SandboxRunOptions): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const logs: SandboxLogEntry[] = [];
    const maxLogs = options.maxLogs ?? 200;
    const maxLogLength = options.maxLogLength ?? 4000;

    const capture: CapturedConsole = {
        sink: logs,
        maxLogs,
        maxLogLength,
        truncated: false,
        startedAt,
    };

    const finish = (
        partial: Omit<SandboxRunResult, 'logs' | 'durationMs' | 'logsTruncated'>,
    ): SandboxRunResult => ({
        ...partial,
        logs,
        durationMs: Date.now() - startedAt,
        logsTruncated: capture.truncated,
    });

    // ---- 1. 编译期错误（语法错）单独抓，错误信息更干净 ----
    let script: vm.Script;
    try {
        script = new vm.Script(wrapUserCode(options.code), { filename: `${options.label}.js` });
    } catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: false });
    }

    // ---- 2. 组装沙箱全局量 ----
    const sandbox: Record<string, unknown> = {
        console: makeCapturedConsole(capture),
        ...options.globals,
    };
    let context: vm.Context;
    try {
        context = vm.createContext(sandbox, { name: options.label });
    } catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: false });
    }

    // ---- 3. 同步段执行（vm 的 timeout 在这一段生效）----
    let returned: unknown;
    try {
        returned = script.runInContext(context, {
            timeout: options.timeoutMs,
            displayErrors: true,
        });
    } catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: isTimeoutError(err) });
    }

    // ---- 4. 异步段执行（vm 的 timeout 不管 async，靠计时器兜底）----
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            Promise.resolve(returned),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new SandboxTimeoutError(options.timeoutMs)), options.timeoutMs);
            }),
        ]);
        return finish({ ok: true, result, timedOut: false });
    } catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: isTimeoutError(err) });
    } finally {
        if (timer) clearTimeout(timer);
    }
}
