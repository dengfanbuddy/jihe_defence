/**
 * DSH SDK 协议客户端：在子进程的 stdio 上跑**按换行分帧的 JSON-RPC 2.0**。
 *
 * 协议面很小（`dsh-sdk-protocol` 就这么多）：
 *
 * | 方向 | 方法 | 说明 |
 * |---|---|---|
 * | c→s | `initialize` | `{cwd, provider, model, reasoningEffort?, maxTokens?}` → `{serverInfo}` |
 * | c→s | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}`（只是入队回执，不是答案） |
 * | c→s | `shutdown` | 服务端回完就把自己 `process.exit(0)` |
 * | s→c | `session.event` | 会话事件（`user/message`、`assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`…） |
 * | s→c | `session.status` | `running` / `idle` |
 * | s→c | `subagent.started` / `subagent.finished` | 子 agent 生命周期 |
 *
 * ## 两条必须守住的纪律
 *
 * 1. **stdout 只属于协议帧**。任何杂质行（插件误用 `console.log`）都可能出现，
 *    所以解析失败就**跳过并计数**，绝不因为一行垃圾把整条流搞死。计数会在状态里暴露出来，
 *    真出问题看得见。
 * 2. **`session/prompt` 的返回不代表答案**。答案通过 `session.event` 异步推来，
 *    所以「问完」与「答完」是两件事：前者看请求回执，后者看 `turn/end`。
 */

import type { ChildProcess } from 'child_process';

/** 一条服务端推来的通知。 */
export interface SdkNotification {
    method: string;
    params: Record<string, unknown>;
}

/** 在飞请求的记账。 */
interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    label: string;
}

/** 请求默认超时。`initialize` 要加载整棵树 + 解析适配器，给得宽一些。 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** SDK 协议客户端。 */
export class SdkClient {
    private buffer = '';
    private readonly pending = new Map<string, Pending>();
    private seq = 0;
    private malformedLines = 0;
    private disposed = false;

    /**
     * @param child - 已 fork 的子进程（必须有 stdin/stdout 管道）。
     * @param onNotification - 通知回调（`session.event` 等）。
     */
    constructor(
        private readonly child: ChildProcess,
        private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    ) {}

    /** 杂质行计数（非 JSON 或结构不对的行），用于诊断。 */
    get malformed(): number {
        return this.malformedLines;
    }

    /** 挂上 stdout 监听。 */
    attach(): void {
        this.child.stdout?.setEncoding('utf8');
        this.child.stdout?.on('data', this.handleData);
    }

    /** 摘掉监听并让所有在飞请求失败。 */
    dispose(): void {
        this.disposed = true;
        this.child.stdout?.off('data', this.handleData);
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`dsh chat：连接已关闭（${entry.label} 未完成）`));
        }
        this.pending.clear();
    }

    /**
     * 发一个请求并等回执。
     *
     * @param method - JSON-RPC 方法名。
     * @param params - 参数。
     * @param timeoutMs - 超时。
     * @returns 回执的 `result`。
     */
    request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
        if (this.disposed) return Promise.reject(new Error('dsh chat：连接已关闭'));
        const id = `c_${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`dsh chat：${method} 在 ${timeoutMs}ms 内没有回执`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, label: method });
            try {
                this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * 握手。必须在任何 `session/prompt` 之前完成——服务端在初始化期间解析路由，
     * 失败会明确报错而不是悄悄回落默认模型。
     */
    initialize(params: { cwd: string; provider: string; model: string; reasoningEffort?: string; maxTokens?: number }): Promise<unknown> {
        return this.request('initialize', params, 180_000);
    }

    /**
     * 提交一条用户消息。返回的 `messageId` 只代表**入队**成功。
     *
     * ## 图片是**编码块**，不是路径
     *
     * `contentBlocks` 逐字就是用户消息的内容，而图片只有一种合法形式：
     * `{type:'image', data, mimeType}` —— 服务端在 `session/prompt` 里把它交给附件库
     * （`admitEncodedImages`）落成 `{type:'image', attachment}`，**没有**「给我个文件路径」这种入口。
     * 详见 `dsh-sdk-protocol` 的 `SdkPromptContentBlock`。
     *
     * @param sessionId - 会话 id（未知 id 会被懒创建）。
     * @param blocks - 内容块（文本 + 图片，顺序即消息顺序）。
     * @returns `{messageId}`。
     */
    prompt(sessionId: string, blocks: Array<Record<string, unknown>>): Promise<unknown> {
        return this.request('session/prompt', { sessionId, contentBlocks: blocks }, 120_000);
    }

    /** 请求关闭。服务端回完即自行退出（所以调用方不必再 kill，但我们仍会兜底 kill）。 */
    shutdown(): Promise<unknown> {
        return this.request('shutdown', {}, 30_000);
    }

    private readonly handleData = (chunk: string): void => {
        this.buffer += chunk;
        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) break;
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this.handleLine(line);
        }
    };

    private handleLine(line: string): void {
        let frame: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            frame = parsed as Record<string, unknown>;
        } catch {
            // 不是协议帧 —— 多半是某个插件往 stdout 写了日志。跳过并计数，不打断整条流。
            this.malformedLines += 1;
            return;
        }

        const id = frame.id;
        const method = frame.method;

        // 回执：只有 id
        if (id !== undefined && method === undefined) {
            const entry = this.pending.get(String(id));
            if (!entry) return;
            clearTimeout(entry.timer);
            this.pending.delete(String(id));
            if (frame.error && typeof frame.error === 'object') {
                const error = frame.error as { code?: number; message?: string };
                entry.reject(new Error(`${entry.label} 失败：${error.message ?? '未知错误'}${error.code === undefined ? '' : `（code ${error.code}）`}`));
            } else {
                entry.resolve(frame.result);
            }
            return;
        }

        // 通知：只有 method
        if (method !== undefined && id === undefined) {
            const params = frame.params && typeof frame.params === 'object' ? (frame.params as Record<string, unknown>) : {};
            this.onNotification(String(method), params);
            return;
        }

        // 服务端反向请求：当前协议没有（README 明确写了「未使用的功能」），忽略即可。
    }
}
