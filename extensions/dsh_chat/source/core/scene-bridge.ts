/**
 * 主进程 → 场景进程的调用桥。
 *
 * `Editor.Message.request('scene', 'execute-scene-script', {...})` 是编辑器给扩展的官方口子：
 * 把 `{ name, method, args }` 丢给 scene 包，scene 包找到名为 `name` 的扩展脚本、
 * 调它的 `methods[method](...args)`。
 *
 * 两个必须处理的现实问题：
 *
 * 1. **脚本可能还没加载**。场景进程只在「有场景打开 + scene 包已启动」时才加载扩展脚本。
 *    没加载时 `execute-scene-script` 会抛或返回 undefined —— 所以要能 ping 出「不可用」，
 *    并且把错误翻译成 AI 能据此行动的话（"先打开一个场景"），而不是一句 internals。
 * 2. **失败模式不止一种**，得区分开：IPC 本身炸了 / 脚本没注册 / 脚本执行里抛了。
 *    这三种对使用者的含义完全不同。
 */

import { EXTENSION_NAME } from '../constants';

/** scene 脚本统一返回的形状（见 source/scene.ts 的 finish()） */
export interface SceneScriptEnvelope {
    ok?: boolean;
    error?: { name?: string; message?: string; stack?: string };
    logs?: Array<{ level: string; text: string; atMs: number }>;
    logsTruncated?: boolean;
    durationMs?: number;
    result?: unknown;
    timedOut?: boolean;
    snapshotRequested?: boolean;
    [key: string]: unknown;
}

export class SceneUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SceneUnavailableError';
    }
}

function describeThrow(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object') {
        const anyErr = err as { message?: unknown };
        if (typeof anyErr.message === 'string') return anyErr.message;
    }
    return String(err);
}

/**
 * 调用场景脚本里的一个方法。
 *
 * @throws {SceneUnavailableError} 场景进程/脚本不可用时（提示语面向 AI，可直接照做）
 */
export async function callSceneScript<T = SceneScriptEnvelope>(
    method: string,
    args: unknown[] = [],
): Promise<T> {
    try {
        const value = await Editor.Message.request('scene', 'execute-scene-script', {
            name: EXTENSION_NAME,
            method,
            args,
        });
        if (value === undefined || value === null) {
            throw new SceneUnavailableError(
                `场景脚本方法 ${method} 没有返回任何值。` +
                    '通常是没有打开场景，或扩展刚加载、scene 包还没注册本扩展的脚本。' +
                    '请在 Cocos Creator 里打开任意场景后重试。',
            );
        }
        return value as T;
    } catch (err) {
        if (err instanceof SceneUnavailableError) throw err;
        throw new SceneUnavailableError(
            `调用场景脚本 ${method} 失败：${describeThrow(err)}。` +
                '如果当前没有打开场景，请先在 Cocos Creator 里打开一个场景。',
        );
    }
}

/** 探活：场景脚本是否已加载可用 */
export async function pingScene(): Promise<{ available: boolean; reason?: string }> {
    try {
        const res = await callSceneScript<{ ok?: boolean }>('ping');
        return res && res.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    } catch (err) {
        return { available: false, reason: describeThrow(err) };
    }
}

/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
export async function requestSceneSnapshot(): Promise<boolean> {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    } catch {
        return false;
    }
}
