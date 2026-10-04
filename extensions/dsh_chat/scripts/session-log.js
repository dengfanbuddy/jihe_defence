/**
 * 会话日志读取器 —— **用系统 node 跑**（不是编辑器自带的 Electron）。
 *
 * ## 为什么单独一个脚本、为什么要另一个 node
 *
 * DSH 的会话日志是 `<DSH_HOME>/sessions/<工程键>/<会话 id>/session[.v4].jsonl.zstd`：
 * 一个 **zstd 拼接帧**容器（每次落盘一个独立帧，所以文件能有几百帧）。
 * 解压它需要 `node:zlib` 的 zstd API，而那是 **Node ≥ 22.15** 才有的；
 * 编辑器主进程跑在 Electron 31（Node 20.15）里 —— **它没有这个 API**。
 *
 * 于是：主进程负责「找到文件、决定读哪个」，这个脚本负责「解压 + 投影」，
 * 用扩展已经用来跑 dsh 的那个 node（`paths.ts` 探测出来的，本机是 v24）跑它。
 *
 * ## 帧扫描是照抄 DSH 的，不是自己凑的
 *
 * `Node 的 zstdDecompressSync 只吃**一个**完整帧`（多帧拼接直接当第一帧结束就返回），
 * 所以必须先按帧头结构把边界算出来再逐帧解压。这里的 `scanZstdFrames` 是
 * `@deepseek-ai/dsh-session-persistence-jsonl` 里同名函数的移植（magic → 帧头描述符 →
 * 可选字段 → 块循环 → checksum），包括「末尾半个帧」的处理：**能解多少解多少**，
 * 这正是 DSH 自己从崩溃/中断的日志里恢复内容用的同一条路。
 *
 * ## 用法（stdout 只有一行 JSON，调用方不用管退出码）
 *
 * ```sh
 * node session-log.js list --root <sessions 根> --project <工程键> [--limit 20]
 * node session-log.js read --root <sessions 根> --project <工程键> --id <会话 id> [--max-events 2000]
 * ```
 *
 * @module dsh_chat/session-log
 */

'use strict';

const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { zstdDecompressSync } = require('node:zlib');

/** zstd 帧 magic（小端 0x28 0xB5 0x2F 0xFD 读成 uint32）。 */
const ZSTD_MAGIC = 4247762216;

/** 列表时为了拿「首条用户消息」最多读多少字节。 */
const TITLE_SCAN_BYTES = 384 * 1024;

/** 单条工具结果在日志侧就截断的长度（面板只显示 4000，没必要把整坨搬过去）。 */
const TOOL_RESULT_LIMIT = 8000;

/** 投影时保留的事件类型 —— 其余（各种 chunk / step / request）是流式中间态，回放用不上。 */
const KEPT_TYPES = new Set(['session', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']);

/**
 * 按帧头结构扫出所有**完整** zstd 帧的边界（照抄 DSH 的实现）。
 *
 * @param {Buffer} buffer - 当前文件里已经存在的字节。
 * @param {number} [maxFrames] - 最多找几个完整帧（列表只要第一帧的头）。
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}} 完整帧范围；末尾没写完的帧只给起点。
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4) return { frames, tornStart: start };
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            throw new Error(`第 ${offset} 字节不是 zstd 帧头（文件可能不是拼接帧容器）`);
        }
        offset += 4;
        if (offset === buffer.length) return { frames, tornStart: start };

        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 24) !== 0) throw new Error(`第 ${offset - 1} 字节的帧头保留位不为 0`);
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
        offset += remainingHeaderBytes;

        // 块循环：3 字节块头 = 1 位 last + 2 位 type + 21 位 size
        for (;;) {
            if (buffer.length - offset < 3) return { frames, tornStart: start };
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            if (blockType === 3) throw new Error(`第 ${offset - 3} 字节的块类型保留（0b11）`);
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
            offset += payloadBytes;
            if (lastBlock) break;
        }

        if (checksum) {
            if (buffer.length - offset < 4) return { frames, tornStart: start };
            offset += 4;
        }
        frames.push({ start, end: offset });
        if (frames.length >= maxFrames) return { frames };
    }
    return { frames };
}

/**
 * 把整个容器的所有完整帧解压成一块文本（末尾半个帧的能解多少解多少）。
 *
 * @param {Buffer} buffer - 文件字节。
 * @returns {{text: string, frameCount: number, torn: boolean}} 拼接后的文本与诊断。
 */
function decodeAll(buffer) {
    const { frames, tornStart } = scanZstdFrames(buffer);
    const parts = [];
    for (const frame of frames) {
        try {
            parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
        } catch (error) {
            // 单帧坏了不放弃整份日志：跳过它，把其余的读出来（日志是只读资料，能看多少算多少）
            console.error(`[session-log] 第 ${frame.start} 字节的帧解压失败：${error.message}`);
        }
    }
    if (tornStart !== undefined && buffer.length - tornStart > 8) {
        // 末尾半个帧：用 flush 模式解出已写好的部分（与 DSH 的 decompressZstdPrefix 同口径）
        try {
            parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: require('node:zlib').constants.ZSTD_e_flush }));
        } catch {
            /* 半个帧本来就随时可能解不出来，忽略 */
        }
    }
    return { text: Buffer.concat(parts).toString('utf8'), frameCount: frames.length, torn: tornStart !== undefined };
}

/**
 * 在会话目录里挑日志文件（新格式带版本号，旧格式没有）。
 *
 * @param {string} dir - 会话目录。
 * @returns {string | null} 绝对路径；没有日志返回 null。
 */
function findLogFile(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return null;
    }
    const candidates = names.filter((name) => /^session(\.[^.]+)?\.jsonl(\.zstd)?$/.test(name));
    if (candidates.length === 0) return null;
    // 版本化的（session.v4.jsonl.zstd）优先，其次最新的
    candidates.sort((a, b) => {
        const versioned = Number(b.includes('.v')) - Number(a.includes('.v'));
        if (versioned !== 0) return versioned;
        return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs;
    });
    return join(dir, candidates[0]);
}

/**
 * 读一个会话文件的**头部帧**（只有几十字节，但含 id / cwd / createdAt）。
 *
 * @param {string} path - 日志文件。
 * @returns {Record<string, unknown> | null} 解析出的 header；读不出来返回 null。
 */
function readHeader(path) {
    let buffer;
    try {
        buffer = readFileSync(path);
    } catch {
        return null;
    }
    if (!path.endsWith('.zstd')) {
        const line = buffer.toString('utf8').split('\n')[0]?.trim();
        try {
            return line ? JSON.parse(line) : null;
        } catch {
            return null;
        }
    }
    try {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length === 0) return null;
        const line = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8').split('\n')[0]?.trim();
        return line ? JSON.parse(line) : null;
    } catch {
        return null;
    }
}

/** 从事件数组里取「第一条真正的用户消息」当标题。 */
function titleOf(events) {
    for (const event of events) {
        if (event.type !== 'user/message') continue;
        const source = event.data?.source;
        if (source && source.kind !== 'user') continue;
        const content = event.data?.content ?? event.data?.message?.content;
        if (!Array.isArray(content)) continue;
        const text = content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text) return text.slice(0, 80);
    }
    return '';
}

/**
 * 列出一个工程下的历史会话。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键目录名。
 * @param {number} limit - 最多返回几条（按修改时间倒序）。
 * @returns {Array<Record<string, unknown>>} 会话摘要。
 */
function listSessions(root, project, limit) {
    const dir = join(root, project);
    if (!existsSync(dir)) return [];
    const rows = [];
    for (const name of readdirSync(dir)) {
        const sessionDir = join(dir, name);
        let stat;
        try {
            stat = statSync(sessionDir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        const log = findLogFile(sessionDir);
        if (!log) continue;
        const header = readHeader(log);
        if (!header) continue;
        let logStat;
        try {
            logStat = statSync(log);
        } catch {
            continue;
        }

        // 标题：多读一点（最多 TITLE_SCAN_BYTES），只为拿首条用户消息
        let title = '';
        let turns = 0;
        try {
            const bytes = readFileSync(log);
            const head = bytes.length > TITLE_SCAN_BYTES ? bytes.subarray(0, TITLE_SCAN_BYTES) : bytes;
            const decoded = log.endsWith('.zstd') ? decodeAll(head).text : head.toString('utf8');
            const events = decoded
                .split('\n')
                .map((line) => {
                    try {
                        return line.trim() ? JSON.parse(line) : null;
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
            title = titleOf(events);
            turns = events.filter((event) => event.type === 'turn/start').length;
        } catch {
            /* 标题拿不到不影响列出这条会话 */
        }

        rows.push({
            id: typeof header.id === 'string' ? header.id : name,
            dirName: name,
            createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
            cwd: typeof header.cwd === 'string' ? header.cwd : null,
            updatedAt: Math.round(logStat.mtimeMs),
            bytes: logStat.size,
            title,
            turns,
            file: log,
        });
    }
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return rows.slice(0, limit);
}

/**
 * 读一个会话的事件（**只保留回放用得到的**，并做长度截断）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键目录名。
 * @param {string} id - 会话 id。
 * @param {number} maxEvents - 最多返回多少条（从尾部保留）。
 * @returns {{header: unknown, events: Array<Record<string, unknown>>, frameCount: number, torn: boolean}} 事件与诊断。
 */
function readSession(root, project, id, maxEvents) {
    const sessionDir = join(root, project, id);
    const log = findLogFile(sessionDir);
    if (!log) throw new Error(`找不到会话 ${id} 的日志文件（${sessionDir}）`);

    const bytes = readFileSync(log);
    const { text, frameCount, torn } = log.endsWith('.zstd')
        ? decodeAll(bytes)
        : { text: bytes.toString('utf8'), frameCount: 0, torn: false };

    const kept = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event;
        try {
            event = JSON.parse(trimmed);
        } catch {
            continue; // 末尾半行/坏行直接跳过
        }
        if (!event || typeof event !== 'object' || !KEPT_TYPES.has(event.type)) continue;

        // 工具结果可能在日志里就是几十 KB —— 面板只显示前 4000 字，这里先砍
        if (event.type === 'tool/result') {
            const blocks = event.data?.message?.content;
            if (Array.isArray(blocks)) {
                for (const block of blocks) {
                    if (!Array.isArray(block?.content)) continue;
                    for (const inner of block.content) {
                        if (typeof inner?.text === 'string' && inner.text.length > TOOL_RESULT_LIMIT) {
                            inner.text = `${inner.text.slice(0, TOOL_RESULT_LIMIT)}\n…（日志读取时截断）`;
                        }
                    }
                }
            }
        }
        kept.push(event);
    }

    const header = kept.find((event) => event.type === 'session') ?? null;
    const sliced = kept.length > maxEvents ? kept.slice(kept.length - maxEvents) : kept;
    return { header, events: sliced, frameCount, torn, total: kept.length };
}

/** 已知的开关名（`--key value` 里判断「下一个 token 到底是不是值」要有一份白名单）。 */
const FLAGS = new Set(['root', 'project', 'id', 'limit', 'max-events']);

/**
 * 解析 `--key value` / `--key=value` 形式的参数。
 *
 * ⚠ **踩过的坑**：**工程键本身以 `--` 开头**（`--D-Project-cocos-jihe_defence--`，
 * 是 DSH 的 `projectKey()` 规定的），所以「下一个 token 以 `--` 开头就当没给值」
 * 这种常见写法会把工程键整个吞掉 —— 症状是脚本报「必须给 --root 与 --project」，
 * 而命令行看着完全正常。判定只能按**白名单**来，不能按前缀。
 *
 * @param {string[]} argv - 去掉命令名之后的参数。
 * @returns {Record<string, string | boolean>} 解析结果。
 */
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const eq = token.indexOf('=');
        if (eq > 0) {
            out[token.slice(2, eq)] = token.slice(eq + 1);
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        const inline = next !== undefined && !(next.startsWith('--') && FLAGS.has(next.slice(2)));
        if (inline) {
            out[key] = next;
            i += 1;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = parseArgs(argv.slice(1));
    const root = typeof args.root === 'string' ? args.root : null;
    const project = typeof args.project === 'string' ? args.project : null;
    if (!root || !project) throw new Error('必须给 --root 与 --project');

    if (command === 'list') {
        const limit = Number(args.limit ?? 20) || 20;
        return { ok: true, project, sessions: listSessions(root, project, limit) };
    }
    if (command === 'read') {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) throw new Error('read 需要 --id');
        const maxEvents = Number(args['max-events'] ?? 2000) || 2000;
        return { ok: true, sessionId: id, ...readSession(root, project, id, maxEvents) };
    }
    throw new Error(`未知命令 "${command}"（只认 list / read）`);
}

try {
    const payload = main();
    process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
}
