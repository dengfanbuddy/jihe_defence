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
 * node session-log.js list   --root <sessions 根> --project <工程键> [--limit 20]
 * node session-log.js read   --root <sessions 根> --project <工程键> --id <会话 id> [--max-events 2000]
 * node session-log.js search --root <sessions 根> --project <工程键> --query <词…> [--limit 30]
 * node session-log.js export --root <sessions 根> --project <工程键> --id <会话 id> [--format md|jsonl|zip] [--out <目录>]
 *                            [--with-subagents] [--with-media] [--zip] [--attachments <附件库>]
 * node session-log.js delete --root <sessions 根> --project <工程键> --id <会话 id> [--dry-run]
 *                            [--reclaim-attachments] [--with-subagents] [--attachments <附件库>]
 * ```
 *
 * ## 2026-12 加的三件（导出对齐 DSH / 回收无引用附件 / 可测）
 *
 * 1. **`--format=zip`（= `--zip`）**：产出与 DSH 官方导出**同一布局**的包
 *    （`session.jsonl` + `subagents/<safeId>/session.jsonl` + `media/<hex>.<ext>`），
 *    但**多写一份 `manifest.json`**（DSH 不写），并把 `media/` 条目名**故意去掉 `sha256:` 前缀**
 *    —— 带冒号的名字在 Windows 上解压会出问题（详见 `buildZip` 的 JSDoc）。
 * 2. **`--reclaim-attachments`**：删会话时顺带把**变成孤儿**的附件像素搬进墓碑目录
 *    （`<DSH_HOME>/attachments/v1/.trash-<yyyyMMdd>/`），**只移动、永不 unlink**，默认不开。
 * 3. **`module.exports`**：本文件底部的纯逻辑都能 `require` 出来直接测
 *    （本会话的沙箱**禁止用管道抓子进程输出**，所以 `verify-history.js` 里那些 spawn CLI 的
 *    断言跑不起来；新加的断言一律 `require` 本文件直接调，见该文件）。
 *
 * ## 为什么搜索/导出/删除也在这里，而不是走宿主的 `ctx.sessionQuery`
 *
 * 本 profile 里 `session-query-sqlite` 是 **关着的**（`openAt: never`、`path: ':memory:'`，
 * 见 `--dump-config`），所以 `searchSessions` / `searchEvents` 一律
 * `SESSION_QUERY_SEARCH_DISABLED`。而它继承来的 `filterEvents(id, {text})` 虽然能用，
 * 却是**逐会话**的（跨会话要循环调用，每次都「载入并校验整份日志」），而且跑在宿主的
 * 事件循环上 —— 面板搜一次就能把正在跑的 agent 卡住几秒。
 *
 * 更要紧的是 **CJK**：那条路是 SQLite FTS5 的 `unicode61` 分词器（按 token 匹配，
 * 中文一句话常常就是一个 token），搜「打击感」基本搜不到东西。这里做的是
 * **字面子串扫描**（大小写不敏感、空白弹性），中文按字断词，才是这个面板要的语义。
 *
 * 放在独立进程里还额外买到两件事：**agent 没在跑也能搜**，以及**不会阻塞任何人**。
 *
 * @module dsh_chat/session-log
 */

'use strict';

const {
    readFileSync,
    readdirSync,
    statSync,
    existsSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    openSync,
    readSync,
    closeSync,
    renameSync,
    copyFileSync,
    unlinkSync,
} = require('node:fs');
const { join, resolve, sep, dirname } = require('node:path');
const { zstdDecompressSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { writeZip } = require('./zip');

/** zstd 帧 magic（小端 0x28 0xB5 0x2F 0xFD 读成 uint32）。 */
const ZSTD_MAGIC = 4247762216;

/** 列表时为了拿「首条用户消息」最多读多少字节。 */
const TITLE_SCAN_BYTES = 384 * 1024;

/**
 * 读**头部帧**时最多读文件的前多少字节。
 *
 * 为什么要有这个上限：`readHeader` 原本是 `readFileSync` **整份**读进来再只解第一帧。
 * 而「建索引」（按 id 反查 / 找子会话）这个动作要把**所有工程的所有会话**都点一遍 ——
 * 本机实测 280+ 条、单条最大 5 MB，那就是几百 MB 的 IO 换每条约 300 字节的 header。
 * 首帧只含一行 header，64 KB 足够；只有首帧在这个前缀里**没结束**时才退回整份读
 * （那种日志是少数派，值得多读一次）。
 */
const HEADER_READ_BYTES = 64 * 1024;

/** 单条工具结果在日志侧就截断的长度（面板只显示 4000，没必要把整坨搬过去）。 */
const TOOL_RESULT_LIMIT = 8000;

/**
 * 投影时保留的事件类型 —— 其余（各种 chunk / step / request）是流式中间态，回放用不上。
 *
 * `session/title` 必须在列：它是**会话日志自己的标题**（`dsh-session-title` 追加的仅写日志事件，
 * 最新一条胜出）。面板以前只能拿「首条用户消息」当标题，而 `session-title-llm` 打开后
 * 那条标题是**模型生成的**、比首条消息准得多 —— 不投影它，面板就只能看见回退标题。
 */
const KEPT_TYPES = new Set([
    'session',
    'session/title',
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'turn/end',
    // 斜杠命令的生命周期（`command/run` 带名字、`command/done` 带结果，按 commandId 配对）。
    // 它们不是模型消息，但**是人做过的事** —— 回放时不画，历史里就会凭空少掉「我 /compact 过」。
    'command/run',
    'command/done',
    /**
     * 进度那三块的来源事件（2026-12 加）。
     *
     * ⚠ 这三个**不上屏**（`dsh-host.ts` 的 `handleSessionEvent` 里只更新进度，不 append），
     * 但它们必须**进回放流** —— 否则「回放一条历史会话」时：
     *   · 没有 `turn/start` → 一条回合锚点都绑不出来 → 回合目录整列**能看不能点**；
     *   · 没有 `todo/write` → 面板只能靠检查点兜底（那条路最多落后 5 秒，且历史会话本来就旧）；
     *   · 没有 `goal/change` → 目标那一块同样只能靠检查点。
     * 代价极小（每回合 3 条小事件，`step/*` 那种噪声仍然不投影），换来的是
     * **回放走的就是实时那条投影逻辑**（这个文件头一直在讲的那条纪律）。
     */
    'turn/start',
    'todo/write',
    'goal/change',
]);

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
 * 在会话目录里挑日志文件。
 *
 * ## ⚠ 2026-12 修的真 bug：这里的优先级以前是**反的**
 *
 * 旧实现写的是「版本化的（`session.v4.jsonl.zstd`）优先，其次最新的」—— 而事实相反：
 * **当前格式版本是 `SESSION_FORMAT_VERSION = 0`**（`dsh-session/lib/types/types.d.ts:55`），
 * 物理文件名**恒为** `session.jsonl.zstd`（`dsh-session-persistence-jsonl/lib/index.js:1389`
 * 的 `findLog` 只认这个精确名），**带 `.vN` 的才是更老的那一代残留**。
 *
 * 真实反例（本机 `--D-Project-cocos-jihe_defence--\session-1aba7f97-…\`，两个文件并存）：
 * | 文件 | 大小 | 行数 | 头 `version` | 末行 `seq` |
 * |---|---|---|---|---|
 * | `session.jsonl.zstd`（当前） | 5.06 MB | **14381** | 0 | **387154** |
 * | `session.v4.jsonl.zstd`（残留） | 2.91 MB | 3090 | 4 | 3088 |
 * → 旧逻辑挑了残留那份，于是**面板对这条会话只显示 3090/14381 行、标题与搜索全部基于过期快照**。
 *
 * 现在的顺序：**精确名（`.jsonl.zstd`）→ 精确名（`.jsonl`）→ 版本化残留（按 mtime 取最新）**。
 * 残留之所以**不直接忽略**：本机有 1 条会话**只有** `session.v4.jsonl.zstd`
 * （DSH 自己看不见它 —— `listArtifacts` 里 `if (!pathExists) continue;` 会跳过），
 * 我们读得动就等于**多看见一条会话**，那是优势，保留。
 *
 * @param {string} dir - 会话目录。
 * @returns {{log: string | null, ignoredLegacy: string[]}} 选中的日志与**被忽略的更旧残留**（面板要如实说）。
 */
function pickLogFile(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return { log: null, ignoredLegacy: [] };
    }
    const candidates = names.filter((name) => /^session(\.[^.]+)?\.jsonl(\.zstd)?$/.test(name));
    if (candidates.length === 0) return { log: null, ignoredLegacy: [] };
    /** 当前格式的精确名（`session.jsonl.zstd` / 未压缩的 `session.jsonl`）。 */
    const current = ['session.jsonl.zstd', 'session.jsonl'].filter((name) => candidates.includes(name));
    if (current.length > 0) {
        return {
            log: join(dir, current[0]),
            ignoredLegacy: candidates.filter((name) => !current.includes(name)),
        };
    }
    // 只剩版本化残留：按 mtime 取最新的一份（它们都是历史，谁新谁更全）
    const legacy = candidates.slice().sort((a, b) => {
        try {
            return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs;
        } catch {
            return 0;
        }
    });
    return { log: join(dir, legacy[0]), ignoredLegacy: legacy.slice(1) };
}

/**
 * 只读一个文件的**前 N 字节**（`readHeader` 用）。
 *
 * 为什么不用 `readFileSync` 再 `subarray`：`readFileSync` 会把整份文件读进内存 ——
 * 对 5 MB 的日志来说，为了 300 字节的 header 付 5 MB 的读盘与内存，是白花的
 * （建索引要遍历几百条会话，这笔钱会乘几百倍）。`openSync` + `readSync` 只取前缀。
 *
 * @param {string} path - 文件。
 * @param {number} maxBytes - 前缀字节上限。
 * @returns {Buffer} 前缀（文件更短就是整份）。
 */
function readHeadBytes(path, maxBytes) {
    const handle = openSync(path, 'r');
    try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const read = readSync(handle, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, read);
    } finally {
        // 无论读成败都要关句柄：Windows 上泄漏的句柄会让后面的删除/改名失败
        closeSync(handle);
    }
}

/**
 * 读一个会话文件的**头部帧**（只有几十字节，但含 id / cwd / createdAt / parentSession）。
 *
 * ⚠ 头部行与事件**同格式**（`{type:'session', version:0, id, createdAt, cwd, parentSession?,
 * seedLength?, origin?, delegationDepth?}`，见 `dsh-session` 的 header 类型）。
 * 这里**只保证第一行**：子会话关系全靠它，所以它必须便宜 —— 见 `HEADER_READ_BYTES`。
 *
 * @param {string} path - 日志文件。
 * @returns {Record<string, unknown> | null} 解析出的 header；读不出来返回 null。
 */
function readHeader(path) {
    let buffer;
    try {
        buffer = readHeadBytes(path, HEADER_READ_BYTES);
    } catch {
        return null;
    }
    if (!path.endsWith('.zstd')) {
        // 未压缩的旧格式：第一行就是 header。若前缀里连换行都没有，说明第一行比前缀还长 → 退回整份读。
        if (!buffer.includes(10) && buffer.length >= HEADER_READ_BYTES) {
            try {
                buffer = readFileSync(path);
            } catch {
                return null;
            }
        }
        const line = buffer.toString('utf8').split('\n')[0]?.trim();
        try {
            return line ? JSON.parse(line) : null;
        } catch {
            return null;
        }
    }
    try {
        let scan = scanZstdFrames(buffer, 1);
        if (scan.frames.length === 0 && buffer.length >= HEADER_READ_BYTES) {
            // 首帧比前缀还大（头帧里塞了别的东西）：极少数，退回整份读，宁可慢也不读错
            buffer = readFileSync(path);
            scan = scanZstdFrames(buffer, 1);
        }
        if (scan.frames.length === 0) return null;
        const line = zstdDecompressSync(buffer.subarray(scan.frames[0].start, scan.frames[0].end))
            .toString('utf8')
            .split('\n')[0]
            ?.trim();
        return line ? JSON.parse(line) : null;
    } catch {
        return null;
    }
}

/**
 * DSH 口径的**稳定读**：`stat` → 读 → `stat`，两次的 `size + mtimeNs` **一致**才算这一眼是稳定的。
 *
 * 为什么必须这么做：会话日志是**正在被宿主追加写**的文件。裸 `readFileSync` 拿到的可能是
 * 「写了一半」的一眼 —— 末尾挂着半行 JSON（`parseEvents` 会跳过它，看起来没事），
 * 但更坏的情况是**读到一半时文件又被追加**，于是内容前后不属于同一时刻。
 * DSH 的 `readStableFile` 就是这么做的，我们照抄：最多 3 次，仍不稳定就用最后一次
 * 并**如实报 `stable: false`**（而不是假装这次读是权威的）。
 *
 * ⚠ 用 `{ bigint: true }` 才有 `mtimeNs` —— 毫秒级的 `mtimeMs` 对「同一毫秒内又追加了几 KB」
 * 这种情况分辨不出来，等于没做双检。
 *
 * @param {string} path - 文件。
 * @param {number} [attempts] - 最多读几次。
 * @returns {{bytes: Buffer, stable: boolean, attempts: number, size: number, mtimeMs: number}} 字节与稳定性诊断。
 */
function stableRead(path, attempts = 3) {
    let bytes = null;
    let lastStat = null;
    for (let index = 0; index < attempts; index += 1) {
        const before = statSync(path, { bigint: true });
        bytes = readFileSync(path);
        const after = statSync(path, { bigint: true });
        lastStat = after;
        // `bytes.length` 也要对：文件在两次 stat 之间被截断过的话，读回来的会短于 after.size
        if (before.size === after.size && before.mtimeNs === after.mtimeNs && BigInt(bytes.length) === after.size) {
            return { bytes, stable: true, attempts: index + 1, size: Number(after.size), mtimeMs: Number(after.mtimeMs) };
        }
    }
    return {
        bytes,
        stable: false,
        attempts,
        size: bytes ? bytes.length : 0,
        mtimeMs: lastStat ? Number(lastStat.mtimeMs) : 0,
    };
}

/**
 * 列出 `<sessions 根>` 下**所有工程目录**（DSH 的 `listProjectDirs()` 同一件事）。
 *
 * 为什么反查子会话必须遍历所有工程目录：**会话目录里的 `cwd` 是它自己的**，
 * 子 agent 的 cwd 完全可以落在另一个工程（本机实测就有：父在 `jihe_defence`、
 * 子在同一次跑里换过目录）。所以「按 parentSession 找子会话」如果只在当前工程目录里找，
 * 就会**静默漏掉**一整支子树 —— DSH 自己也是遍历所有工程目录找的。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @returns {string[]} 工程键目录名（排序，便于复现）。
 */
function listProjectDirs(root) {
    let names;
    try {
        names = readdirSync(root);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        try {
            if (statSync(join(root, name)).isDirectory()) out.push(name);
        } catch {
            /* 目录在两行之间消失了（别的进程在清理）：跳过，不因此整趟失败 */
        }
    }
    return out.sort();
}

/**
 * 解压一个日志文件成文本（非 `.zstd` 的旧格式直接按 UTF-8 读）。
 *
 * @param {string} path - 日志文件。
 * @returns {string} 文本。
 */
function decodeText(path) {
    const bytes = readFileSync(path);
    return path.endsWith('.zstd') ? decodeAll(bytes).text : bytes.toString('utf8');
}

/**
 * 把一段文本按行解析成事件（坏行/末尾半行直接跳过）。
 *
 * @param {string} text - `decodeText` 出来的文本。
 * @returns {Array<Record<string, unknown>>} 事件数组。
 */
function parseEvents(text) {
    const events = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const event = JSON.parse(trimmed);
            if (event && typeof event === 'object') events.push(event);
        } catch {
            /* 末尾半行/坏行跳过：日志是只读资料，能读多少算多少 */
        }
    }
    return events;
}

/** 从事件数组里取「第一条真正的用户消息」当标题（日志里没有 `session/title` 时的回退）。 */
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
 * 从事件数组里取**会话日志自己记的**标题（`session/title`，最新一条胜出）。
 *
 * 两条口径：
 * 1. **优先它**：`dsh-session-title` 会规范化标题（清控制字符、按 UTF-8 字节安全截断），
 *    而 `session-title-llm` 还会补一条**模型生成**的修订 —— 首条用户消息只是它的兜底来源。
 * 2. **只在扫描窗口内找**：列表接口只解码每个日志的**头部** `TITLE_SCAN_BYTES`（20 条会话
 *    要按 MB 读，不能整份解），所以极长的首轮（工具结果把标题挤到窗口外）会退回首条用户消息。
 *    这条局限是**故意的**：标题的权威读取路径是面板打开会话时的 `read`（那份是全量的）。
 *
 * @param {Array<Record<string, unknown>>} events - 头部窗口里的事件。
 * @returns {string} 标题；没有则空串。
 */
function loggedTitleOf(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'session/title') continue;
        const title = typeof event.data?.title === 'string' ? event.data.title.trim() : '';
        if (title) return title.slice(0, 120);
    }
    return '';
}

/**
 * 枚举一个工程下的会话目录（**search / export / delete / list 四处共用**）。
 *
 * 为什么要共用：这四处都得回答同一个问题 ——「哪个目录、哪个日志文件、多大、什么时候改的」。
 * 各写一份的下场很具体：删除时按目录名删、导出时按 header.id 找文件，两边一旦对不上
 * （`session-<uuid>` 这种目录名与 header 里的 id 不是一回事），就会出现
 * 「列表上有、点进去找不到」或者更糟的「删错了目录」。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键目录名。
 * @returns {Array<{name: string, dir: string, log: string, size: number, mtimeMs: number, header: Record<string, unknown> | null, ignoredLegacy: string[]}>} 按最后修改时间倒序。
 */
function sessionDirs(root, project) {
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

        const picked = pickLogFile(sessionDir);
        if (!picked.log) continue;
        const log = picked.log;
        let logStat;
        try {
            logStat = statSync(log);
        } catch {
            continue;
        }
        rows.push({
            name,
            dir: sessionDir,
            log,
            size: logStat.size,
            mtimeMs: logStat.mtimeMs,
            header: readHeader(log),
            ignoredLegacy: picked.ignoredLegacy,
        });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return rows;
}

/** 一个会话目录的**权威 id**（header 里那个；拿不到才退回目录名）。 */
function sessionIdOf(entry) {
    const id = entry.header && typeof entry.header.id === 'string' ? entry.header.id.trim() : '';
    return id || entry.name;
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
    const rows = [];
    for (const entry of sessionDirs(root, project)) {
        const header = entry.header;
        if (!header) continue;

        // 标题：多读一点（最多 TITLE_SCAN_BYTES），只为拿首条用户消息
        let title = '';
        let turns = 0;
        try {
            const bytes = readFileSync(entry.log);
            const head = bytes.length > TITLE_SCAN_BYTES ? bytes.subarray(0, TITLE_SCAN_BYTES) : bytes;
            const decoded = entry.log.endsWith('.zstd') ? decodeAll(head).text : head.toString('utf8');
            const events = parseEvents(decoded);
            title = loggedTitleOf(events) || titleOf(events);
            turns = events.filter((event) => event.type === 'turn/start').length;
        } catch {
            /* 标题拿不到不影响列出这条会话 */
        }

        rows.push({
            id: sessionIdOf(entry),
            dirName: entry.name,
            createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
            cwd: typeof header.cwd === 'string' ? header.cwd : null,
            updatedAt: Math.round(entry.mtimeMs),
            bytes: entry.size,
            title,
            turns,
            file: entry.log,
            // 更旧的格式残留（`session.v4.jsonl.zstd` 那一类）：**如实带出去**，
            // 面板标一句「盘上还有一份更旧的」—— 不说的话，用户看到"同一会话两个文件"会以为我们读错了。
            ignoredLegacy: entry.ignoredLegacy,
        });
        if (rows.length >= limit) break;
    }
    return rows;
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
    const entry = locateSession(root, project, id);
    const bytes = readFileSync(entry.log);
    const { text, frameCount, torn } = entry.log.endsWith('.zstd')
        ? decodeAll(bytes)
        : { text: bytes.toString('utf8'), frameCount: 0, torn: false };

    const kept = [];
    for (const event of parseEvents(text)) {
        if (!KEPT_TYPES.has(event.type)) continue;

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

// ---------------------------------------------------------------- 会话定位（读/导出/删共用）

/**
 * 一个「朴素名字」（目录名 / 会话 id）的校验。
 *
 * **这是删除那条路的守卫**：只允许 `[A-Za-z0-9._-]`，且拒绝 `.` / `..`。
 * 会话 id 是 DSH 生成的 uuid 或 `session-<uuid>`，正常都落在这个集合里；
 * 而面板传来的东西要当**输入**看（同 `main.ts` 对图片路径的口径），
 * 一个 `..\\..\\` 就能把删除变成「删掉整个工程」。
 *
 * @param {unknown} raw - 原始值。
 * @param {string} label - 出错时写进消息里的名字。
 * @returns {string} 收紧后的名字。
 */
function safeNameOf(raw, label) {
    const name = String(raw ?? '').trim();
    if (!name) throw new Error(`${label} 不能是空的`);
    if (name === '.' || name === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
        throw new Error(`${label} 不合法：${JSON.stringify(name.slice(0, 64))}（只允许字母/数字/点/下划线/短横）`);
    }
    return name;
}

/**
 * 把「面板给的一个会话 id」定位到磁盘上的会话目录。
 *
 * 为什么不能直接 `join(root, project, id)`：**目录名与 header 里的 id 不总是同一个东西** ——
 * 本工程里既有 `<uuid>` 目录，也有 `session-<uuid>` 目录，而面板列表显示的是 `header.id`。
 * 只按目录名找的后果是「列表上有这条、点进去说找不到」。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {unknown} id - 会话 id（或目录名）。
 * @returns {ReturnType<typeof sessionDirs>[number]} 命中的目录条目。
 */
function locateSession(root, project, id) {
    const wanted = safeNameOf(id, '会话 id');
    const entries = sessionDirs(root, project);
    const direct = entries.find((entry) => entry.name === wanted);
    if (direct) return direct;
    const byHeader = entries.find((entry) => sessionIdOf(entry) === wanted);
    if (byHeader) return byHeader;
    throw new Error(`找不到会话 ${wanted}（${join(root, project)} 下既没有同名目录，也没有哪条会话的 header.id 是它）`);
}

/**
 * 断言目标路径在这个基准目录**里面**。
 *
 * @param {string} base - 允许的基准目录。
 * @param {string} target - 要操作的路径。
 * @returns {string} `target` 的绝对路径。
 */
function ensureInside(base, target) {
    const outer = resolve(base);
    const inner = resolve(target);
    if (inner !== outer && !inner.startsWith(outer + sep)) {
        throw new Error(`拒绝操作基准目录之外的路径：${inner}（基准 ${outer}）`);
    }
    return inner;
}

// ---------------------------------------------------------------- 会话索引（按 id 反查 · 跨工程）

/** 建索引时的预算（面板要即时反馈，不能让「遍历几百条会话」把界面挂住）。 */
const INDEX_DEFAULTS = {
    /** 最多看几条会话（按目录顺序，不是按时间 —— 索引要的是「全集」而不是「最新的几条」）。 */
    maxSessions: 5000,
    /** 时间预算（毫秒）。 */
    budgetMs: 5000,
};

/**
 * 扫 `<root>` 下**所有工程目录**的所有会话目录，每个只解**头部帧**拿 header，建一张索引。
 *
 * ## 为什么需要它
 *
 * 「导出时带上子孙会话」和「删会话时回收无引用附件」都要回答同一个问题：
 * **这个 id 的日志在磁盘上哪儿？** 而 `locateSession` 只在**一个工程目录**里找。
 * 子会话的 cwd 可能属于别的工程，所以必须跨工程反查（见 `listProjectDirs` 的说明）。
 *
 * ## 为什么是「解头部帧」而不是「读整份」
 *
 * 索引要的是 header 里那 8 个字段（id / cwd / createdAt / parentSession / origin /
 * delegationDepth / seedLength + 目录与文件元信息），整份日志（本机最大 5 MB）里
 * 99.99% 的内容与索引无关。只读前缀 + 只解第一帧（`HEADER_READ_BYTES`）把这件事从
 * 「几百 MB」压到「每条约 100 KB」。
 *
 * ## ⚠ `parentSession` 存在 **≠** 是子 agent
 *
 * 本机实测：280 条有 `parentSession`，其中 **278 条 `origin === 'subagent'`** ——
 * 剩下的 2 条是 **fork**（`/fork` 出来的独立会话，日志上也有父，但它不是「子 agent」）。
 * 所以判「是不是子 agent」只能看 `origin === 'subagent'`（或 `delegationDepth >= 1`），
 * 不能看有没有父。这一点在回执里**分开报**（见 `exportSession` 的 `subagents.subagentCount`
 * 与 `forkCount`）—— 混成一句「有 N 条子会话」就是在骗人。
 *
 * ## 重复 id 不静默取第一个
 *
 * 同一个 id 出现在多个工程目录（复制/恢复过会话目录就会出现）：这里**不替调用方选**，
 * 而是把它放进 `duplicates` 并**从 `byId` 里摘掉** —— 摘掉是关键，因为「留在 byId 里」
 * 就等于「静默用了第一个」。要用的地方走 `resolveInIndex`（歧义时**指名道姓报错**，DSH 自己也是直接抛）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {{projects?: string[], maxSessions?: number, budgetMs?: number}} [options] - `projects` 可显式限定工程目录。
 * @returns {{root: string, entries: Array<Record<string, unknown>>, byId: Map<string, Record<string, unknown>>, duplicates: Array<{id: string, entries: Array<Record<string, unknown>>}>, scanned: {projects: number, sessions: number, bytes: number, elapsedMs: number}, incomplete: boolean, errors: string[]}} 索引与诊断。
 */
function buildSessionIndex(root, options = {}) {
    const started = Date.now();
    const maxSessions = positive(options.maxSessions, INDEX_DEFAULTS.maxSessions);
    const budgetMs = positive(options.budgetMs, INDEX_DEFAULTS.budgetMs);
    const projects = Array.isArray(options.projects) ? options.projects : listProjectDirs(root);

    const entries = [];
    const errors = [];
    let bytes = 0;
    let incomplete = false;

    for (const projectKey of projects) {
        if (entries.length >= maxSessions || Date.now() - started > budgetMs) {
            incomplete = true;
            break;
        }
        let names;
        try {
            names = readdirSync(join(root, projectKey));
        } catch (error) {
            errors.push(`${projectKey}：读不动（${error.message}）`);
            continue;
        }
        for (const dirName of names) {
            if (entries.length >= maxSessions || Date.now() - started > budgetMs) {
                incomplete = true;
                break;
            }
            const dir = join(root, projectKey, dirName);
            let dirStat;
            try {
                dirStat = statSync(dir);
            } catch {
                continue;
            }
            if (!dirStat.isDirectory()) continue;

            const picked = pickLogFile(dir);
            if (!picked.log) continue;
            let logStat;
            try {
                logStat = statSync(picked.log);
            } catch {
                continue;
            }
            const header = readHeader(picked.log);
            // 只认会话日志：目录里可能有别的文件，header 形状不对的不进索引（宁可少一条，也不塞脏数据）
            if (!header || header.type !== 'session') continue;

            entries.push({
                id: sessionIdOf({ header, name: dirName }),
                dirName,
                cwd: typeof header.cwd === 'string' ? header.cwd : null,
                createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
                parentSession: typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : null,
                origin: typeof header.origin === 'string' && header.origin ? header.origin : null,
                delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
                seedLength: typeof header.seedLength === 'number' ? header.seedLength : null,
                projectKey,
                dir,
                log: picked.log,
                ignoredLegacy: picked.ignoredLegacy,
                mtimeMs: Math.round(logStat.mtimeMs),
                size: logStat.size,
            });
            bytes += logStat.size;
        }
    }

    const grouped = new Map();
    for (const entry of entries) {
        const list = grouped.get(entry.id);
        if (list) list.push(entry);
        else grouped.set(entry.id, [entry]);
    }
    const byId = new Map();
    const duplicates = [];
    for (const [id, list] of grouped) {
        if (list.length === 1) byId.set(id, list[0]);
        else duplicates.push({ id, entries: list });
    }

    return {
        root,
        entries,
        byId,
        duplicates,
        scanned: { projects: projects.length, sessions: entries.length, bytes, elapsedMs: Date.now() - started },
        incomplete,
        errors,
    };
}

/**
 * 索引里按 id（或目录名）**唯一**定位一条会话；歧义时**指名道姓地报错**。
 *
 * 为什么不能「取第一个」：同一个 id 出现在两个工程目录里时，两个候选可能内容不同
 * （一份是复制出来的旧快照）。静默取第一个的后果是**导出/回收错了对象** ——
 * 而「回收附件」那条路是不可逆的（虽然只搬墓碑），所以宁可停下让人看清楚再决定。
 *
 * @param {ReturnType<typeof buildSessionIndex>} index - 索引。
 * @param {unknown} id - 会话 id（或目录名）。
 * @returns {Record<string, unknown>} 命中的条目。
 */
function resolveInIndex(index, id) {
    const wanted = safeNameOf(id, '会话 id');
    const matches = index.entries.filter((entry) => entry.id === wanted || entry.dirName === wanted);
    if (matches.length === 0) throw new Error(`索引里没有会话 ${wanted}（扫了 ${index.scanned.projects} 个工程目录 / ${index.scanned.sessions} 条会话）`);
    if (matches.length > 1) {
        const where = matches.map((entry) => `\n  - ${entry.projectKey}/${entry.dirName} → ${entry.log}`).join('');
        throw new Error(`会话 ${wanted} 在索引里有 ${matches.length} 处，拒绝替你猜：${where}`);
    }
    return matches[0];
}

/**
 * 按 `parentSession` 递归出**子孙会话**（DFS 前序）。
 *
 * 两条口径：
 * 1. **fork 也算子孙**（照抄 DSH 的导出口径）：只要 `parentSession` 指过来就算。
 *    所以「有几个是 subagent（origin）、几个是 fork」是**回执要分开报**的事，
 *    不是「要不要包含」的事。
 * 2. **前序 + 防环**：`seen` 挡环（日志被手改过就可能出现互相指向的父链，
 *    没有 `seen` 就是一个死循环）。同一个子节点只出一次。
 *
 * ⚠ 有重复 id 的子会话**直接抛错**：DFS 里 `seen` 会把第二个同 id 的节点吞掉，
 * 那正是「静默取第一个」—— 见 `resolveInIndex` 的同一条理由。
 *
 * @param {ReturnType<typeof buildSessionIndex>} index - 索引。
 * @param {string} rootId - 根会话 id。
 * @param {{maxDepth?: number}} [options] - 深度上限（防畸形父子链）。
 * @returns {{descendants: Array<{entry: Record<string, unknown>, depth: number}>, dangling: Array<{id: string, parentSession: string}>}} 子孙（前序）与**断链**诊断。
 */
function descendantsOf(index, rootId, options = {}) {
    const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : 32;
    const duplicateIds = new Set(index.duplicates.map((row) => row.id));

    const childrenOf = new Map();
    for (const entry of index.entries) {
        if (!entry.parentSession) continue;
        const list = childrenOf.get(entry.parentSession);
        if (list) list.push(entry);
        else childrenOf.set(entry.parentSession, [entry]);
    }
    // 定序：目录顺序是文件系统的顺序（跨机器/跨次运行都不一样）。按 createdAt（旧的先）
    // 再按 id 兜底，产物才是**可复现**的 —— 一个每次导出顺序都不同的包，没法做基线对账。
    for (const list of childrenOf.values()) {
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
    }

    const seen = new Set([rootId]);
    const descendants = [];
    const walk = (parentId, depth) => {
        if (depth > maxDepth) return;
        for (const child of childrenOf.get(parentId) ?? []) {
            if (duplicateIds.has(child.id)) {
                throw new Error(`子会话 ${child.id} 在索引里有重复，拒绝替你猜是哪一份（${child.projectKey}/${child.dirName}）`);
            }
            if (seen.has(child.id)) continue; // 防环
            seen.add(child.id);
            descendants.push({ entry: child, depth });
            walk(child.id, depth + 1);
        }
    };
    walk(rootId, 1);

    // 断链：有会话声称父是某个 id，但那个 id 不在索引里（父被删了、或父在另一台机器上）。
    // 如实收集（只收没有父的那一层），面板可以说一句「有 N 条会话的父已经不在盘上」。
    const dangling = [];
    for (const entry of index.entries) {
        if (!entry.parentSession || seen.has(entry.id)) continue;
        if (index.byId.has(entry.parentSession)) continue;
        dangling.push({ id: entry.id, parentSession: entry.parentSession });
        if (dangling.length >= 20) break;
    }
    return { descendants, dangling };
}

/**
 * 一条会话条目是不是「子 agent」（**不是**「有没有父」）。
 *
 * 判据照抄 DSH 的 `origin === 'subagent'`；`delegationDepth >= 1` 作为兜底
 * （老日志可能没有 `origin` 字段 —— 本机 280 条里就有一部分只有 depth）。
 *
 * @param {Record<string, unknown>} entry - 索引条目。
 * @returns {boolean} 是不是子 agent。
 */
function isSubagentEntry(entry) {
    if (entry.origin === 'subagent') return true;
    if (entry.origin) return false; // 有别的 origin（比如 fork）就不是 subagent，别拿 depth 乱兜
    return typeof entry.delegationDepth === 'number' && entry.delegationDepth >= 1;
}

// ---------------------------------------------------------------- 文本抽取（搜索与导出共用）

/**
 * 从 `ContentBlock[]` 里取纯文本（与面板 `dsh-host.ts` 的 `textOfBlocks` 同一口径）。
 *
 * @param {unknown} blocks - 内容块数组。
 * @returns {string} 文本。
 */
function textOfBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    const parts = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('\n');
}

/** 从内容块里取**思考块**（回放/导出时思考在 `content` 里，与实时的 chunk 流不同）。 */
function reasoningOfBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    const parts = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
            parts.push(block.text);
        }
    }
    return parts.join('\n');
}

/** 图片块的**元数据**（日志里只有附件引用，没有像素）。 */
function imageRefsOfBlocks(blocks) {
    if (!Array.isArray(blocks)) return [];
    const out = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object' || block.type !== 'image') continue;
        const ref = block.attachment;
        out.push({
            name: (ref && typeof ref.name === 'string' && ref.name) || (typeof block.name === 'string' ? block.name : ''),
            mimeType: (ref && ref.mediaType) || block.mimeType || '',
            bytes: ref && typeof ref.bytes === 'number' ? ref.bytes : null,
            width: ref && typeof ref.width === 'number' ? ref.width : null,
            height: ref && typeof ref.height === 'number' ? ref.height : null,
            /**
             * ⚠ **别把这一项去掉**（2026-12 补上）：它是**唯一**能把会话里的图连回附件库的键。
             *
             * 形状是 `sha256:<64 位小写 hex>`（`dsh-attachment-local/lib/index.js:259` 的
             * `ID_PATTERN`），物理文件在 `<DSH_HOME>/attachments/v1/objects/<hex 前 2 位>/<hex>`
             * —— 「导出含附件像素」与「删会话时回收无引用附件」两件事都靠它。
             * 以前这里只留了 name/mediaType/bytes/wh/height（**给人看的元数据**），
             * 于是那两件事都得先回来改这个函数。显式留 `null` 也不用空串：
             * 空串会让「没有 id」和「id 是空」分不开。
             */
            attachmentId: typeof ref?.attachmentId === 'string' && ref.attachmentId ? ref.attachmentId : null,
        });
    }
    return out;
}

/**
 * `tool/result` 的文本与错误标记 —— **两种形状都要认**（与面板 `toolResultOf` 同一口径）。
 *
 * | 来源 | `message.content` |
 * |---|---|
 * | 实时事件 / 老日志（`version: 0`） | `[ { type: 'tool-result', toolCallId, content: [块…], isError } ]` —— 内容在**里层** |
 * | 新日志（`version: 4`） | `[ { type: 'text', text } ]` —— 内容**就是**这一层 |
 *
 * @param {unknown} message - `data.message`。
 * @returns {{text: string, isError: boolean}} 文本与错误标记。
 */
function toolResultOf(message) {
    const typed = message && typeof message === 'object' ? message : {};
    const content = typed.content;
    if (!Array.isArray(content)) return { text: '', isError: typed.isError === true };
    const wrapper = content[0];
    const blocks = wrapper && wrapper.type === 'tool-result' && Array.isArray(wrapper.content) ? wrapper.content : content;
    return { text: textOfBlocks(blocks), isError: !!(wrapper && wrapper.isError === true) || typed.isError === true };
}

/** 行内空白折平（搜索文档与片段都按折平后的文本说话，片段里才不会出现换行）。 */
function flatten(text) {
    return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * 把一条事件投影成「可搜索的一段话」（一条事件可能出两条：回答 + 思考）。
 *
 * 只投影**人看得懂**的那部分：文本、思考、工具名与参数、工具结果、命令。
 * 不投影流式中间态（chunk/step）—— 那是同一句话的半成品，会把命中数灌水。
 *
 * @param {Record<string, unknown>} event - 会话事件。
 * @returns {Array<{seq: number, time: number, role: string, label: string, text: string}>} 搜索文档。
 */
function docsOf(event) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const base = { seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) };
    switch (event.type) {
        case 'session/title': {
            const title = typeof data.title === 'string' ? data.title.trim() : '';
            return title ? [{ ...base, role: 'title', label: '标题', text: title }] : [];
        }
        case 'user/message': {
            const source = data.source;
            const content = data.content ?? (data.message && data.message.content);
            if (source && source.kind === 'plugin') {
                const summary = typeof source.summary === 'string' ? source.summary.trim() : '';
                return summary ? [{ ...base, role: 'note', label: '注入的上下文', text: summary }] : [];
            }
            if (source && source.kind !== 'user') return [];
            const text = textOfBlocks(content);
            return text ? [{ ...base, role: 'user', label: '你', text }] : [];
        }
        case 'assistant/message': {
            const content = data.message && data.message.content;
            const out = [];
            const thinking = reasoningOfBlocks(content);
            if (thinking) out.push({ ...base, role: 'thinking', label: '思考', text: thinking });
            const text = textOfBlocks(content);
            if (text) out.push({ ...base, role: 'assistant', label: '我', text });
            return out;
        }
        case 'tool/call': {
            const name = typeof data.name === 'string' ? data.name : '';
            const args = typeof data.arguments === 'string' ? data.arguments : '';
            const text = `${name} ${args}`.trim();
            return text ? [{ ...base, role: 'tool', label: `工具 ${name || '?'}`, text }] : [];
        }
        case 'tool/result': {
            const text = toolResultOf(data.message).text;
            return text ? [{ ...base, role: 'tool-result', label: '工具结果', text }] : [];
        }
        case 'command/run': {
            const name = typeof data.name === 'string' ? data.name : '';
            const args = typeof data.args === 'string' ? data.args : '';
            return [{ ...base, role: 'command', label: '命令', text: `/${name}${args}`.trim() }];
        }
        case 'command/done': {
            const text = typeof data.text === 'string' ? data.text.trim() : '';
            return text ? [{ ...base, role: 'command-result', label: '命令结果', text }] : [];
        }
        default:
            return [];
    }
}

// ---------------------------------------------------------------- 附件库（像素 · 孤儿回收）

/**
 * 附件 id 的形状（照抄 `dsh-attachment-local` 的 `ID_PATTERN`）：`sha256:<64 位小写 hex>`。
 *
 * 物理文件在 `<DSH_HOME>/attachments/v1/objects/<hex 前 2 位>/<hex 全部 64 位>`。
 * **没有索引、没有引用计数、没有 GC**（DSH 官方 README 原话：`nothing collects unreferenced objects`），
 * 所以「谁引用了哪个对象」只能靠**扫会话日志**得出来 —— 这正是下面这些函数存在的理由。
 */
const ATTACHMENT_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;

/** media type → 扩展名（DSH 导出的 `media/<id>.<ext>` 用的是同一套四种像素格式）。 */
const MEDIA_EXTENSIONS = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
]);

/** 回收附件的缺省预算与时间窗。 */
const RECLAIM_DEFAULTS = {
    /**
     * 全库扫描的时间预算（毫秒）。
     *
     * ⚠ **这个数不是拍的，是量出来的**（本机 2026-12）：`<DSH_HOME>` 下 498 条会话 /
     * **569 MB** 压缩日志，其中「解压」就要 **60.8 秒**（zstd 是单线程的，这是硬成本），
     * 逐行 `JSON.parse` 再加 8.2 秒 → 全库扫描约 **66 秒**。
     * 所以预算必须给到「一分钟以上」，否则在这个体量下**永远 `incomplete`、永远一条都不回收**
     * —— fail-closed 是对的，但一个「永远什么都不做」的功能等于没做。
     * 面板要提醒用户这一步是分钟级的（它是子进程，不会卡住界面，但人会觉得慢）。
     */
    budgetMs: 120000,
    /** 全库扫描最多看几条会话。 */
    maxSessions: 5000,
    /** 全库扫描最多读多少**压缩后**字节（1 GiB ≈ 本机体量的两倍，留了增长余量）。 */
    maxBytes: 1024 * 1024 * 1024,
    /**
     * 时间窗：**最近 1 小时内改过**的对象一律不回收。
     *
     * 为什么必须有这条：对象是别的 DSH 进程刚写下去的，而**会话日志可能还没 flush**
     * （引用它的那条日志此刻还没落盘）→ 我们在「全库未被引用」这一步会把它误判成孤儿。
     * 一小时是保守值：代价只是「刚生成、刚删会话的图晚点才回收」，而另一边是不可逆的误删。
     */
    minAgeMs: 60 * 60 * 1000,
};

/**
 * 附件库根（`<DSH_HOME>/attachments`）。
 *
 * 为什么从 sessions 根推出来：`sessions` 与 `attachments` 是 `<DSH_HOME>` 下的兄弟目录，
 * 而 CLI 只拿得到 sessions 根（`paths.ts` 给的就是它）。`--attachments` 可覆盖 ——
 * **测试必须在临时目录里造一个合成库**，绝不能碰真实的 `C:\Users\wx\.dsh`。
 *
 * @param {string} sessionsRoot - `<DSH_HOME>/sessions`。
 * @param {unknown} [override] - `--attachments` 给的值。
 * @returns {string} 附件库根（绝对路径）。
 */
function attachmentsRootOf(sessionsRoot, override) {
    const given = typeof override === 'string' ? override.trim() : '';
    return given ? resolve(given) : join(dirname(resolve(sessionsRoot)), 'attachments');
}

/**
 * `sha256:<hex>` → `<hex>`（形状不对给 null）。
 *
 * @param {unknown} attachmentId - 日志里的附件 id。
 * @returns {string | null} 64 位小写 hex。
 */
function hexOfAttachmentId(attachmentId) {
    const match = ATTACHMENT_ID_PATTERN.exec(String(attachmentId ?? '').trim());
    return match ? match[1] : null;
}

/**
 * 选导出用的扩展名：先看 mediaType，再看原文件名的后缀，最后 `bin`。
 *
 * ⚠ 扩展名只影响**文件名**，不影响内容（像素是原样搬的）。给 `bin` 是兜底而不是失败：
 * 日志是外部输入，遇到没见过的 mediaType 时「导出一份名字不好看的真像素」远好过「导不出来」。
 *
 * @param {unknown} mediaType - `image/png` 之类。
 * @param {unknown} name - 原文件名。
 * @returns {string} 扩展名（不带点）。
 */
function extOfMediaType(mediaType, name) {
    const known = MEDIA_EXTENSIONS.get(String(mediaType ?? '').toLowerCase());
    if (known) return known;
    const suffix = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''));
    return suffix ? suffix[1].toLowerCase() : 'bin';
}

/**
 * 在内容块里**深度递归**找图片块。
 *
 * ⚠ **命中之后不再往下走**：图片块里的 `attachment` 不会再嵌图片块，继续递归只会把
 * attachment 自己的字段再扫一遍（白花时间，也容易重复计数）。
 *
 * ⚠ **放宽了一条判据**：规范里命中条件是 `block.type === 'image' && block.attachment`，
 * 这里额外接受「`attachment.attachmentId` 长得像 sha256 id」的形状（不看 `type`）。
 * 这是**故意放宽**的，因为两边代价差着量级：漏掉一个引用 →
 * 「回收孤儿附件」会把它当真孤儿搬进墓碑（**不可逆**，虽然搬的是墓碑目录不是 unlink，
 * 但用户看不见它了）；多记一个引用 → 最多是「少回收一个文件」。宁可宽。
 *
 * @param {unknown} node - 内容块（可能是数组/对象/标量）。
 * @param {(attachment: Record<string, unknown>, isImageShape: boolean) => void} onImage - 命中回调。
 * @param {number} depth - 当前深度（防畸形数据的无限深）。
 * @returns {boolean} 子树里有没有命中过图片块。
 */
function walkImageBlocks(node, onImage, depth) {
    if (depth > 32) return false;
    if (Array.isArray(node)) {
        let found = false;
        for (const item of node) {
            if (walkImageBlocks(item, onImage, depth + 1)) found = true;
        }
        return found;
    }
    if (!node || typeof node !== 'object') return false;

    const attachment = node.attachment && typeof node.attachment === 'object' ? node.attachment : null;
    const isImageShape = node.type === 'image' && attachment !== null;
    const hasIdShape =
        attachment !== null &&
        typeof attachment.attachmentId === 'string' &&
        ATTACHMENT_ID_PATTERN.test(attachment.attachmentId.trim());
    if (isImageShape || hasIdShape) {
        onImage(attachment ?? {}, isImageShape);
        return true;
    }

    let found = false;
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object' && walkImageBlocks(value, onImage, depth + 1)) found = true;
    }
    return found;
}

/**
 * 从事件数组里收集**图片附件引用**（4 条 carrier 路径 + 深度递归）。
 *
 * 4 条 carrier（DSH 只有这四处会写图片块）：
 * | # | 路径 | 出处 |
 * |---|---|---|
 * | 1 | `event.data.content[]` | `user/message` |
 * | 2 | `event.data.message.content[]` | `tool/result`、`assistant/message` |
 * | 3 | `event.data.inserted[].content[]` | `agent/inbox/spliced` |
 * | 4 | `event.data.chunk.block` | **仅当** `data.chunk.type === 'block-end'` |
 *
 * ⚠ 第 4 条为什么要卡 `block-end`：流式 chunk 里同一个块会以 `block-start` / `block-delta` /
 * `block-end` 出现好几次，**只有 `block-end` 带完整的块**（delta 里的形状是半成品）。
 * 不卡它就会出现「同一个引用被记成好几次」以及「从来不是块的东西被当块扫」。
 *
 * @param {Array<Record<string, unknown>>} events - 会话事件。
 * @returns {{refs: Map<string, Record<string, unknown>>, blocks: number, withoutId: number}} 引用表（键 = `sha256:<hex>`）与诊断。
 */
function collectImageRefs(events) {
    const refs = new Map();
    let blocks = 0;
    let withoutId = 0;

    const onImage = (attachment, isImageShape) => {
        if (isImageShape) blocks += 1;
        const raw = typeof attachment.attachmentId === 'string' ? attachment.attachmentId.trim() : '';
        if (!ATTACHMENT_ID_PATTERN.test(raw)) {
            if (isImageShape) withoutId += 1;
            return;
        }
        const claimed = Number.isFinite(attachment.bytes) ? Number(attachment.bytes) : null;
        const existing = refs.get(raw);
        if (existing) {
            existing.count += 1;
            if (claimed !== null) existing.claimedSizes.add(claimed);
            if (!existing.mediaType && typeof attachment.mediaType === 'string') existing.mediaType = attachment.mediaType;
            if (!existing.name && typeof attachment.name === 'string') existing.name = attachment.name;
            return;
        }
        refs.set(raw, {
            attachmentId: raw,
            mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : '',
            name: typeof attachment.name === 'string' ? attachment.name : '',
            width: Number.isFinite(attachment.width) ? Number(attachment.width) : null,
            height: Number.isFinite(attachment.height) ? Number(attachment.height) : null,
            bytes: claimed,
            /** 日志里写的**所有**大小声明（校验时要与实际文件大小对，见 `findOrphanAttachments`）。 */
            claimedSizes: new Set(claimed === null ? [] : [claimed]),
            count: 1,
        });
    };

    for (const event of events) {
        const data = event && typeof event === 'object' ? event.data : null;
        if (!data || typeof data !== 'object') continue;
        if (data.content) walkImageBlocks(data.content, onImage, 0);
        if (data.message && typeof data.message === 'object' && data.message.content) walkImageBlocks(data.message.content, onImage, 0);
        if (Array.isArray(data.inserted)) {
            for (const item of data.inserted) {
                if (item && typeof item === 'object' && item.content) walkImageBlocks(item.content, onImage, 0);
            }
        }
        const chunk = data.chunk;
        if (chunk && typeof chunk === 'object' && chunk.type === 'block-end' && chunk.block) walkImageBlocks(chunk.block, onImage, 0);
    }
    return { refs, blocks, withoutId };
}

/**
 * 一段日志文本 → 图片引用（`collectImageRefs` 的文本入口）。
 *
 * @param {string} text - `decodeText` 出来的文本。
 * @returns {ReturnType<typeof collectImageRefs>} 引用与诊断。
 */
function collectImageRefsInText(text) {
    return collectImageRefs(parseEvents(text));
}

/** 字节 → 日志文本（`.zstd` 走拼接帧解码，旧格式直接按 UTF-8）。 */
function textOfLogBytes(bytes, log) {
    return String(log).endsWith('.zstd') ? decodeAll(bytes).text : bytes.toString('utf8');
}

/**
 * 读一条会话的日志（**稳定读**）并收集它的图片引用。
 *
 * @param {{log: string, dirName?: string}} entry - 会话条目（至少要 `log`）。
 * @returns {ReturnType<typeof collectImageRefs> & {stable: boolean, attempts: number, size: number}} 引用与读稳定性诊断。
 */
function refsOfLog(entry) {
    const read = stableRead(entry.log);
    const collected = collectImageRefsInText(textOfLogBytes(read.bytes, entry.log));
    return { ...collected, stable: read.stable, attempts: read.attempts, size: read.size };
}

/**
 * 全库扫描：**所有工程目录的所有会话日志**里出现过的 attachmentId。
 *
 * ⚠ `excludeLogs` 是这条路的**关键参数**，不是可选项：算孤儿时要把「即将被删的那几条会话」
 * 排除掉。不排除的话，候选集（= 那些会话引用到的 id）与「全库仍被引用」的交集**恒为空** ——
 * 因为候选的定义就是「被即将删掉的那条会话引用」，它当然会被扫到。
 * 换句话说：不排除就等于这个功能永远不干活。见 `findOrphanAttachments`。
 *
 * 预算是硬的（会话数 / 压缩字节 / 毫秒），超了就**如实报 `incomplete`** 并由调用方 fail-closed
 * （一条都不删）—— 半途而废的扫描会得出「很多附件没人引用」的假结论，那正是最危险的方向。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {{excludeLogs?: Set<string>, budgetMs?: number, maxSessions?: number, maxBytes?: number}} [options] - 预算与排除集（**绝对路径**）。
 * @returns {{referenced: Map<string, {claimedSizes: Set<number>, count: number}>, scanned: {sessions: number, bytes: number, elapsedMs: number}, incomplete: boolean, stoppedBy: string | null, errors: string[]}} 全库引用表与覆盖率。
 */
function scanAllAttachmentRefs(root, options = {}) {
    const started = Date.now();
    const budgetMs = positive(options.budgetMs, RECLAIM_DEFAULTS.budgetMs);
    const maxSessions = positive(options.maxSessions, RECLAIM_DEFAULTS.maxSessions);
    const maxBytes = positive(options.maxBytes, RECLAIM_DEFAULTS.maxBytes);
    const exclude = options.excludeLogs instanceof Set ? options.excludeLogs : new Set();

    const referenced = new Map();
    const errors = [];
    let sessions = 0;
    let bytes = 0;
    let stoppedBy = null;

    const projects = listProjectDirs(root);
    outer: for (const projectKey of projects) {
        let names;
        try {
            names = readdirSync(join(root, projectKey));
        } catch (error) {
            errors.push(`${projectKey}：读不动（${error.message}）`);
            continue;
        }
        for (const dirName of names) {
            if (sessions >= maxSessions) {
                stoppedBy = 'sessions';
                break outer;
            }
            if (Date.now() - started > budgetMs) {
                stoppedBy = 'time';
                break outer;
            }
            const dir = join(root, projectKey, dirName);
            let dirStat;
            try {
                dirStat = statSync(dir);
            } catch {
                continue;
            }
            if (!dirStat.isDirectory()) continue;

            const picked = pickLogFile(dir);
            if (!picked.log) continue;
            if (exclude.has(resolve(picked.log))) continue;

            let logStat;
            try {
                logStat = statSync(picked.log);
            } catch {
                continue;
            }
            // 字节预算：至少让第一条过（否则 maxBytes 比最小日志还小的时候就一条都扫不了，
            // 那种配置下「扫了 0 条」会被误当成「全库没人引用」）
            if (sessions > 0 && bytes + logStat.size > maxBytes) {
                stoppedBy = 'bytes';
                break outer;
            }

            let text;
            try {
                text = decodeText(picked.log);
            } catch (error) {
                errors.push(`${projectKey}/${dirName}：读不动（${error.message}）`);
                sessions += 1;
                bytes += logStat.size;
                continue;
            }
            sessions += 1;
            bytes += logStat.size;

            /**
             * **预筛**：解压后的文本里连 `attachmentId` 这个键名都没有，就整条跳过解析。
             *
             * 为什么它对**结果**没有影响：能被记进 `referenced` 的 id，只可能来自
             * `attachment.attachmentId` 这个字段 —— 也就是说那个键名必然**字面出现**在日志文本里。
             * 所以「文本里没有这个子串」⇒「这条会话一个引用都没有」，是等价变换而不是近似。
             *
             * 为什么值得做：本机实测 498 条会话里只有 **100 条**含附件引用，
             * 逐行 `JSON.parse` 那一趟是 8.2 秒（解压那 60.8 秒是省不掉的，见 `RECLAIM_DEFAULTS`）——
             * 这一步把其中约六成省掉。与 `searchSessions` 里的预筛是同一套路。
             */
            if (!text.includes('attachmentId')) continue;

            const collected = collectImageRefsInText(text);
            for (const [id, ref] of collected.refs) {
                const known = referenced.get(id);
                if (!known) {
                    referenced.set(id, { claimedSizes: new Set(ref.claimedSizes), count: ref.count });
                    continue;
                }
                known.count += ref.count;
                for (const size of ref.claimedSizes) known.claimedSizes.add(size);
            }
        }
    }

    return {
        referenced,
        scanned: { sessions, bytes, elapsedMs: Date.now() - started },
        incomplete: stoppedBy !== null,
        stoppedBy,
        errors,
    };
}

/**
 * 墓碑目标的路径（**纯函数**，dry-run 与真跑共用它 → 清单逐字一致）。
 *
 * @param {string} trashDir - `<attachments>/v1/.trash-<yyyyMMdd>`。
 * @param {string} hex - 64 位 hex。
 * @returns {string} `…/.trash-20261231/<hex 前 2 位>/<hex>`。
 */
function trashTargetOf(trashDir, hex) {
    return join(trashDir, hex.slice(0, 2), hex);
}

/**
 * 算「删掉这条会话（可选含子孙）之后，哪些附件变成孤儿」。
 *
 * ## 规则一条都不省（每条都有理由）
 *
 * 1. **候选**：要删的那条会话（`withSubagents` 时含子孙）引用到的 id 集合。
 * 2. **孤儿 = 候选 ∩ 全库未被引用** —— 是**交集**不是差集。
 *    差集（候选里所有 id）会把**跨会话共享**的附件一起回收掉；本机已实证同一个 sha256
 *    出现在两条会话里，而那正是「按内容去重、跨会话共用」的常态，不是例外。
 *    全库扫描**必须排除即将被删的那几条日志**（理由见 `scanAllAttachmentRefs`）。
 * 3. **交叉验证**：每个孤儿都要 `stat` 到物理文件、**复算文件字节的 sha256 与 id 相符**
 *    （`node:crypto`），并核对日志里写的 `bytes` 与实际大小 —— 不一致就**不删**并报告。
 *    内容寻址的对象名**就是**它内容的哈希：算不出来或对不上，说明这个文件不是我们以为的东西，
 *    那它更可能是别人的东西。
 * 4. **必过时间窗**：最近 1 小时改过的跳过（`RECLAIM_DEFAULTS.minAgeMs`）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {unknown} id - 会话 id。
 * @param {{withSubagents?: boolean, attachments?: string, budgetMs?: number, maxSessions?: number, maxBytes?: number, minAgeMs?: number, now?: number}} [options] - 开关与预算。
 * @returns {Record<string, unknown>} 清单（`orphans` 是**唯一**的可回收列表）。
 */
function findOrphanAttachments(root, project, id, options = {}) {
    const started = Date.now();
    const withSubagents = options.withSubagents === true;
    const attachmentsRoot = attachmentsRootOf(root, options.attachments);
    const objectsDir = join(attachmentsRoot, 'v1', 'objects');
    const minAgeMs = Number.isFinite(options.minAgeMs) ? Number(options.minAgeMs) : RECLAIM_DEFAULTS.minAgeMs;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const errors = [];

    // ---- 1. 候选
    const rootEntry = locateSession(root, project, id);
    const index = buildSessionIndex(root, { budgetMs: options.indexBudgetMs });
    const included = [{ entry: rootEntry, depth: 0 }];
    let dangling = [];
    if (withSubagents) {
        const walked = descendantsOf(index, sessionIdOf(rootEntry));
        included.push(...walked.descendants);
        dangling = walked.dangling;
    }
    const candidates = new Map();
    for (const item of included) {
        try {
            const collected = refsOfLog(item.entry);
            for (const [refId, ref] of collected.refs) {
                const known = candidates.get(refId);
                if (!known) {
                    candidates.set(refId, { ...ref, claimedSizes: new Set(ref.claimedSizes) });
                    continue;
                }
                known.count += ref.count;
                for (const size of ref.claimedSizes) known.claimedSizes.add(size);
            }
        } catch (error) {
            errors.push(`读 ${item.entry.dirName ?? item.entry.log} 失败：${error.message}`);
        }
    }

    // ---- 2. 全库（排除即将被删的那几条）
    const excludeLogs = new Set(included.map((item) => resolve(item.entry.log)));
    const scan = scanAllAttachmentRefs(root, {
        excludeLogs,
        budgetMs: options.budgetMs,
        maxSessions: options.maxSessions,
        maxBytes: options.maxBytes,
    });
    errors.push(...scan.errors);

    // ---- 3. 孤儿 + 交叉验证
    const orphans = [];
    const skipped = [];
    const skippedPlan = (refId, reason, extra) => skipped.push({ attachmentId: refId, reason, ...(extra ?? {}) });

    for (const [refId, ref] of candidates) {
        if (scan.incomplete) continue; // fail-closed：清单留空（下面统一记 skipped）
        if (scan.referenced.has(refId)) {
            skippedPlan(refId, 'still-referenced');
            continue;
        }
        const hex = hexOfAttachmentId(refId);
        if (!hex) {
            skippedPlan(refId, 'bad-id');
            continue;
        }
        const from = join(objectsDir, hex.slice(0, 2), hex);
        let stat;
        try {
            stat = statSync(from);
        } catch (error) {
            // 不在盘上：没有可回收的东西，不是错误（别的进程可能已经处理过）
            skippedPlan(refId, error.code === 'ENOENT' ? 'missing' : 'stat-failed', { error: error.message });
            continue;
        }
        if (!stat.isFile()) {
            skippedPlan(refId, 'not-a-file');
            continue;
        }
        if (now - stat.mtimeMs < minAgeMs) {
            skippedPlan(refId, 'recent', { modifiedAt: Math.round(stat.mtimeMs) });
            continue;
        }
        let bytes;
        try {
            bytes = readFileSync(from);
        } catch (error) {
            skippedPlan(refId, 'unreadable', { error: error.message });
            errors.push(`${refId}：读不出像素（${error.message}）`);
            continue;
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== hex) {
            // 内容寻址的对象名对不上内容：这个文件不是我们以为的那个东西 → 不删
            skippedPlan(refId, 'hash-mismatch', { sha256: digest });
            continue;
        }
        if (ref.claimedSizes.size > 0 && !ref.claimedSizes.has(bytes.length)) {
            // 日志里写的字节数与实际文件不一致：**写回不一致就不删**（面板要能看见两边数字）
            skippedPlan(refId, 'size-mismatch', {
                sizeClaimed: [...ref.claimedSizes].sort((a, b) => a - b),
                sizeActual: bytes.length,
            });
            continue;
        }
        orphans.push({
            attachmentId: refId,
            hex,
            from,
            bytes: bytes.length,
            mediaType: ref.mediaType || '',
            name: ref.name || '',
            refCount: ref.count,
        });
    }

    if (scan.incomplete) {
        for (const refId of candidates.keys()) skippedPlan(refId, 'scan-incomplete');
    }

    return {
        attachmentsRoot,
        objectsDir,
        /** 墓碑目录：`<attachments>/v1/.trash-<yyyyMMdd>`（**同盘**，所以搬迁是 rename 而不是复制）。 */
        trashDir: join(attachmentsRoot, 'v1', `.trash-${stampOf(now).slice(0, 8)}`),
        includedSessions: included.length,
        candidates: candidates.size,
        referenced: scan.referenced.size,
        orphans,
        skipped,
        scanned: scan.scanned,
        incomplete: scan.incomplete,
        stoppedBy: scan.stoppedBy,
        dangling,
        errors,
        elapsedMs: Date.now() - started,
    };
}

/**
 * 把清单里的附件**搬进墓碑目录**（`--dry-run` 时一条都不动，但清单逐字一致）。
 *
 * ## 为什么是「搬」而不是「删」
 *
 * 删会话时顺手回收附件，是**在别人的数据上做不可逆的操作**。这个脚本的作者只能证明
 * 「按当前这份扫描，它看起来没人引用」，而扫描本身是有预算、可能不完整、也可能被
 * 「还没 flush 的日志」骗过的。所以这条路的终局动作只能是**移动**：
 * 移到 `<attachments>/v1/.trash-<yyyyMMdd>/…`，同盘 rename（**不是复制**：同盘 rename 是原子的，
 * 也不花 IO）。想彻底删就让人自己去删那个目录 —— 本脚本**不提供 `--purge`**。
 *
 * ⚠ 只碰 `objects/<bucket>/<hex>` 这**一种**路径，不碰 `request-images/`、不碰 `tmp/`，
 * 也不碰 `objects/` 与分桶目录本身（那些目录里可能还有别的对象）。
 *
 * ⚠ `ENOENT` 当**成功**：别的 DSH 进程可能刚好处理过同一个对象，
 * 「搬的时候它已经不在了」与「搬成功」对我们的目的是同一件事，报错只会制造噪声。
 *
 * @param {Array<{attachmentId: string, hex: string, from: string, bytes: number}>} items - `findOrphanAttachments` 的 `orphans`。
 * @param {{dryRun?: boolean, trashDir: string}} options - `trashDir` 必给（由 find 阶段算出，dry-run 与真跑同一个）。
 * @returns {{trashed: number, bytesFreed: number, trashedList: Array<Record<string, unknown>>, errors: string[]}} 执行结果。
 */
function trashAttachments(items, options = {}) {
    const dryRun = options.dryRun === true;
    const trashDir = String(options.trashDir ?? '');
    if (!trashDir) throw new Error('trashAttachments 需要 trashDir（墓碑目录）');
    const list = Array.isArray(items) ? items : [];
    const trashedList = [];
    const errors = [];
    let trashed = 0;
    let bytesFreed = 0;

    for (const item of list) {
        const to = trashTargetOf(trashDir, item.hex);
        if (dryRun) {
            trashedList.push({ attachmentId: item.attachmentId, from: item.from, to, bytes: item.bytes, moved: false, reason: 'dry-run' });
            continue;
        }
        try {
            // 目标目录必须落在墓碑目录里（hex 已经过 `hexOfAttachmentId` 校验，这里是第二道门）
            ensureInside(trashDir, to);
            mkdirSync(dirname(to), { recursive: true });
            renameSync(item.from, to);
            trashed += 1;
            bytesFreed += item.bytes;
            trashedList.push({ attachmentId: item.attachmentId, from: item.from, to, bytes: item.bytes, moved: true, reason: 'renamed' });
        } catch (error) {
            if (error.code === 'ENOENT') {
                // 别的进程已经处理过 → 当成功（见 JSDoc），不报错
                trashedList.push({ attachmentId: item.attachmentId, from: item.from, to, bytes: 0, moved: false, reason: 'already-gone' });
                continue;
            }
            if (error.code === 'EXDEV') {
                // 跨盘 rename 会失败。退回「复制 + 删源」：仍然是把数据搬进墓碑，
                // 而不是原地 unlink（本轮不提供任何直接删的路径）。
                try {
                    copyFileSync(item.from, to);
                    unlinkSync(item.from);
                    trashed += 1;
                    bytesFreed += item.bytes;
                    trashedList.push({ attachmentId: item.attachmentId, from: item.from, to, bytes: item.bytes, moved: true, reason: 'copied' });
                } catch (copyError) {
                    errors.push(`${item.attachmentId}：跨盘搬迁失败（${copyError.message}）`);
                }
                continue;
            }
            errors.push(`${item.attachmentId}：搬不动（${error.message}）`);
        }
    }

    return { trashed, bytesFreed, trashedList, errors };
}

/**
 * 「算清单 → 搬墓碑」的**唯一入口**（dry-run 与真跑共用同一份清单与同一段搬迁代码）。
 *
 * 拆成两半（find / trash）正是为了让 `--dry-run` **不是**另一条代码路径：
 * dry-run 只是 `trashAttachments` 的一个分支，清单本身一个字都不差。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {unknown} id - 会话 id。
 * @param {{dryRun?: boolean, withSubagents?: boolean, attachments?: string, budgetMs?: number, maxSessions?: number, maxBytes?: number, minAgeMs?: number, now?: number}} [options] - 开关与预算。
 * @returns {Record<string, unknown>} 回执（**每个字段都能被面板原样显示**）。
 */
function reclaimAttachments(root, project, id, options = {}) {
    const dryRun = options.dryRun === true;
    const plan = findOrphanAttachments(root, project, id, options);
    const outcome = trashAttachments(plan.orphans, { dryRun, trashDir: plan.trashDir });
    return {
        dryRun,
        attachmentsRoot: plan.attachmentsRoot,
        trashDir: plan.trashDir,
        includedSessions: plan.includedSessions,
        scanned: plan.scanned,
        candidates: plan.candidates,
        referenced: plan.referenced,
        orphans: plan.orphans.length,
        trashed: outcome.trashed,
        bytesFreed: outcome.bytesFreed,
        incomplete: plan.incomplete,
        incompleteReason: plan.incomplete ? `全库扫描超预算（${plan.stoppedBy}）→ 一条都不删` : null,
        stoppedBy: plan.stoppedBy,
        skipped: plan.skipped,
        orphanList: plan.orphans.map((item) => ({
            attachmentId: item.attachmentId,
            bytes: item.bytes,
            mediaType: item.mediaType,
            name: item.name,
            refCount: item.refCount,
        })),
        trashList: outcome.trashedList,
        dangling: plan.dangling,
        errors: [...plan.errors, ...outcome.errors],
        elapsedMs: plan.elapsedMs,
    };
}

// ---------------------------------------------------------------- 全文搜索

/** 直接命令行跑时的默认预算（面板会显式传它自己那份）。 */
const SEARCH_DEFAULTS = {
    /**
     * 最多返回几条会话，**同时也是「找到这么多就收工」的停止条件**。
     *
     * 为什么把它当停止条件而不是「扫完再取前 N」：本工程 107 个会话、159 MB 压缩日志，
     * 全量扫一遍要几十秒，而面板是要即时反馈的。会话按修改时间倒序走，所以停下来时
     * 「最新的 N 条匹配」已经拿到手了 —— 代价是更老的会话没看，这一点如实报出去
     * （`partial` + `stoppedBy: 'limit'`）比假装搜全了强。
     */
    limit: 20,
    /** 每条会话最多给几个片段。 */
    perSession: 3,
    /** 最多检查几个会话目录（按修改时间倒序，新的先看）。 */
    maxSessions: 150,
    /** 最多读多少**压缩后**字节（解压后可能是它的好几倍）。 */
    maxBytes: 48 * 1024 * 1024,
    /** 时间预算（毫秒）：到点就停，不会把面板/命令行挂住。 */
    budgetMs: 6000,
};

/** 片段前后各留多少字。 */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 90;

/** 一条会话里最多数多少次命中（防止「的」这种词把计数变成无意义的十万级数字）。 */
const HIT_COUNT_CAP = 9999;

/** 把查询串切成词（空白分隔，最多 8 个，全小写）。 */
function queryTerms(query) {
    return String(query ?? '')
        .split(/\s+/)
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
}

/** 一个词在文本里出现几次（大小写不敏感，最多数到 cap）。 */
function countOccurrences(text, term, cap) {
    let count = 0;
    let from = 0;
    for (;;) {
        const at = text.indexOf(term, from);
        if (at < 0) return count;
        count += 1;
        if (count >= cap) return count;
        from = at + term.length;
    }
}

/**
 * 给一条文档做命中排序：命中的词越多越靠前，同分按出现位置靠前的优先。
 *
 * @param {Array<{role: string, text: string, seq: number}>} docs - 该会话的文档。
 * @param {string[]} terms - 查询词（小写）。
 * @param {number} perSession - 最多出几个片段。
 * @returns {{snippets: Array<Record<string, unknown>>, hits: number}} 片段与总命中数。
 */
function rankDocs(docs, terms, perSession) {
    const flat = [];
    let hits = 0;
    for (const doc of docs) {
        const text = flatten(doc.text);
        if (!text) continue;
        const lower = text.toLowerCase();
        const matched = terms.filter((term) => lower.includes(term));
        if (matched.length === 0) continue;
        for (const term of matched) hits += countOccurrences(lower, term, HIT_COUNT_CAP - hits);
        flat.push({ doc, text, lower, matched });
    }
    flat.sort((a, b) => b.matched.length - a.matched.length || a.doc.seq - b.doc.seq);

    const snippets = [];
    for (const row of flat) {
        if (snippets.length >= perSession) break;
        // 先找所有词里**位置最靠前**的那个，片段就围着它切
        let at = -1;
        let length = 0;
        for (const term of row.matched) {
            const index = row.lower.indexOf(term);
            if (index >= 0 && (at < 0 || index < at)) {
                at = index;
                length = term.length;
            }
        }
        if (at < 0) continue;
        const start = Math.max(0, at - SNIPPET_BEFORE);
        const end = Math.min(row.text.length, at + length + SNIPPET_AFTER);
        snippets.push({
            role: row.doc.role,
            label: row.doc.label,
            seq: row.doc.seq,
            time: row.doc.time,
            terms: row.matched.length,
            snippet: `${start > 0 ? '…' : ''}${row.text.slice(start, end)}${end < row.text.length ? '…' : ''}`,
        });
    }
    return { snippets, hits };
}

/**
 * 全工程会话的**字面子串**全文搜索。
 *
 * 两段式：先用整份解压文本做一次**预筛**（不解析 JSON，只做子串判断 —— 绝大多数会话
 * 会在这一步被排除，而 JSON.parse 每一行才是真正贵的那一步），命中的会话才投影成文档、
 * 算命中数与片段。
 *
 * 预算是**硬的**：会话数、压缩字节数、毫秒三个上限谁先到就停，并且**如实报告**
 * （`partial` / `stoppedBy` / `scanned` / `available`）—— 搜索界面最怕的不是慢，
 * 是「悄悄只搜了一半却看起来像搜全了」。会话按修改时间倒序处理，所以停下来的地方
 * 是「最老的那些没看」，返回的也**就是「最新的 N 条匹配」**（不再按命中次数重排：
 * 重排会让「停止条件」与「结果顺序」互相打架，而在这个面板里「最近聊过」比
 * 「命中次数多」更接近用户要找的东西；命中次数只作为一条元信息显示）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {Record<string, unknown>} options - `query` / `limit` / `perSession` / `maxSessions` / `maxBytes` / `budgetMs`。
 * @returns {Record<string, unknown>} 命中列表与**覆盖率**。
 */
function searchSessions(root, project, options) {
    const query = String(options.query ?? '').trim();
    if (!query) throw new Error('search 需要 --query');
    if (query.length > 200) throw new Error('search 的 --query 太长了（最多 200 字）');
    const terms = queryTerms(query);
    if (terms.length === 0) throw new Error('search 的 --query 里没有可搜的词');

    const limit = positive(options.limit, SEARCH_DEFAULTS.limit);
    const perSession = positive(options.perSession, SEARCH_DEFAULTS.perSession);
    const maxSessions = positive(options.maxSessions, SEARCH_DEFAULTS.maxSessions);
    const maxBytes = positive(options.maxBytes, SEARCH_DEFAULTS.maxBytes);
    const budgetMs = positive(options.budgetMs, SEARCH_DEFAULTS.budgetMs);

    const started = Date.now();
    const entries = sessionDirs(root, project);
    const hits = [];
    let scanned = 0;
    let scannedBytes = 0;
    let stoppedBy = null;

    // 折平的条件：查询里出现了**可能大小写不同**的字符。
    // 纯中文/数字/符号的查询（这个工程里最常见的那些）不需要折平 —— 省掉的是一次
    // 几十 MB 的整串复制，而预筛正是这条路上最热的一步。
    // ⚠ 判据不能只看「小写化之后变了没有」：查 `ctx.tick` 而日志里写的是 `ctx.Tick`，
    //   小写查询也需要折平才知道命不命中（这条是合成语料里当场抓出来的）。
    const foldCase = query !== query.toLowerCase() || /[a-z]/.test(query);

    for (const entry of entries) {
        if (scanned >= maxSessions) {
            stoppedBy = 'sessions';
            break;
        }
        if (scannedBytes + entry.size > maxBytes) {
            stoppedBy = 'bytes';
            break;
        }
        if (Date.now() - started > budgetMs) {
            stoppedBy = 'time';
            break;
        }

        let text;
        try {
            text = decodeText(entry.log);
        } catch (error) {
            console.error(`[session-log] 读 ${entry.name} 失败：${error.message}`);
            scanned += 1;
            continue;
        }
        scanned += 1;
        scannedBytes += entry.size;

        // 预筛：整份文本里得**同时**有所有词。这一步不解析 JSON，一次判断就能排掉整个会话。
        const probe = foldCase ? text.toLowerCase() : text;
        if (!terms.every((term) => probe.includes(term))) continue;

        const events = parseEvents(text);
        const docs = [];
        for (const event of events) for (const doc of docsOf(event)) docs.push(doc);
        const ranked = rankDocs(docs, terms, perSession);
        if (ranked.snippets.length === 0) continue;

        const best = ranked.snippets[0];
        hits.push({
            id: sessionIdOf(entry),
            dirName: entry.name,
            title: loggedTitleOf(events) || titleOf(events),
            createdAt: entry.header && typeof entry.header.createdAt === 'number' ? entry.header.createdAt : null,
            updatedAt: Math.round(entry.mtimeMs),
            bytes: entry.size,
            turns: events.filter((event) => event.type === 'turn/start').length,
            hits: ranked.hits,
            /** 最靠前那条命中的**事件 seq**（面板据此在回放后直接跳到那一条）。 */
            seq: best.seq,
            snippets: ranked.snippets,
        });
        if (hits.length >= limit) {
            stoppedBy = 'limit';
            break;
        }
    }

    return {
        ok: true,
        query,
        terms,
        hits,
        scanned,
        matched: hits.length,
        available: entries.length,
        partial: stoppedBy !== null,
        stoppedBy,
        scannedBytes,
        elapsedMs: Date.now() - started,
    };
}

// ---------------------------------------------------------------- 导出

/** 数值型开关的收敛（非正数/非数字就退回默认）。 */
function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/** `20261005-034130`。 */
function stampOf(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}

/** 标题 → 文件名里能用的短横线串（汉字留着，其它一律折成 `-`）。 */
function slugOf(text, fallback) {
    const cleaned = String(text ?? '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return cleaned || fallback;
}

/**
 * 代码围栏：文本里若本身有 ` ``` ` 就加长，免得嵌套把文档撕开。
 *
 * @param {string} text - 代码内容。
 * @param {string} [lang] - 语言标记。
 * @returns {string} 围栏块。
 */
function fence(text, lang) {
    const runs = String(text).match(/`+/g) ?? [];
    let ticks = '```';
    for (const run of runs) if (run.length >= ticks.length) ticks = '`'.repeat(run.length + 1);
    return `${ticks}${lang ?? ''}\n${text}\n${ticks}`;
}

/** 字节数 → `1.7 MB`（与面板 `formatBytes` 同口径的粗略版，导出文件里只为可读）。 */
function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** 时间戳 → ISO（导出文件里用绝对时间，不用面板那种 `09-30 00:36`）。 */
function isoOf(ms) {
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '未知';
}

/**
 * 把事件流渲染成一份**给人读的 markdown**。
 *
 * 形状取舍：一条消息一个 `##`，一次工具调用一个 `###`（参数与结果挂在它下面），
 * 每个回合之间拉一条 `---`。命令生命周期按 `commandId` 配对（`command/done` 自己不带名字）。
 *
 * @param {Array<Record<string, unknown>>} events - 会话事件（**未过滤**，这里自己挑）。
 * @param {Record<string, unknown>} meta - 标题 / id / 路径 / 时间等，写进文件头。
 * @returns {string} markdown 文本。
 */
function renderMarkdown(events, meta) {
    const lines = [];
    lines.push(`# ${meta.title || '(无标题)'}`);
    lines.push('');
    lines.push(`- 会话：\`${meta.id}\``);
    if (meta.cwd) lines.push(`- 工程：\`${meta.cwd}\``);
    lines.push(`- 创建：${isoOf(meta.createdAt)} · 最后活动：${isoOf(meta.updatedAt)}`);
    lines.push(`- 回合：${meta.turns} · 事件：${meta.eventCount} · 日志：${humanBytes(meta.logBytes)}`);
    lines.push(`- 导出：${isoOf(Date.now())}（DSH 会话日志 ${meta.logFile}）`);
    lines.push('');
    lines.push('> 图片附件只有引用信息 —— 像素存在 `<DSH_HOME>/attachments`（按内容去重、跨会话共用），不随这份导出走。');
    lines.push('');

    const commandNames = new Map();
    let turnOpened = false;
    const push = (text) => {
        if (!text) return;
        const flat = text.replace(/\n{3,}/g, '\n\n').trim();
        if (flat) lines.push(flat, '');
    };

    for (const event of events) {
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        switch (event.type) {
            case 'session/title':
                break; // 标题已经在文件头
            case 'turn/start': {
                if (turnOpened) lines.push('---', '');
                turnOpened = true;
                break;
            }
            case 'user/message': {
                const source = data.source;
                const content = data.content ?? (data.message && data.message.content);
                if (source && source.kind === 'plugin') {
                    const summary = typeof source.summary === 'string' ? source.summary.trim() : '';
                    if (summary) push(`> （注入的上下文）${flatten(summary)}`);
                    break;
                }
                if (source && source.kind !== 'user') break;
                const text = textOfBlocks(content);
                const images = imageRefsOfBlocks(content);
                if (!text && images.length === 0) break;
                lines.push('## 你', '');
                if (text) push(text);
                for (const image of images) {
                    const size = image.bytes === null ? '' : ` · ${humanBytes(image.bytes)}`;
                    const pixels = image.width && image.height ? ` · ${image.width}×${image.height}` : '';
                    push(`> 🖼 ${image.name || '(未命名图)'}${pixels}${size}`);
                }
                break;
            }
            case 'assistant/message': {
                const content = data.message && data.message.content;
                const thinking = reasoningOfBlocks(content);
                if (thinking) {
                    lines.push('## 我（思考）', '');
                    push(thinking);
                }
                const text = textOfBlocks(content);
                if (text) {
                    lines.push('## 我', '');
                    push(text);
                }
                if (data.interrupted === true) push('> ⚠ 这一轮被中断（以上是已产出的内容）');
                break;
            }
            case 'tool/call': {
                const name = typeof data.name === 'string' ? data.name : 'unknown';
                lines.push(`### 工具 \`${name}\``, '');
                const args = typeof data.arguments === 'string' ? data.arguments : '';
                if (args) push(fence(args, 'json'));
                break;
            }
            case 'tool/result': {
                const result = toolResultOf(data.message);
                lines.push(`#### 结果${result.isError ? '（错误）' : ''}`, '');
                if (result.text) push(fence(result.text));
                break;
            }
            case 'command/run': {
                const name = typeof data.name === 'string' ? data.name : '';
                const args = typeof data.args === 'string' ? data.args : '';
                if (data.commandId) commandNames.set(String(data.commandId), name);
                lines.push(`### 命令 \`/${name}\`${args ? ` ${args.trim()}` : ''}`, '');
                break;
            }
            case 'command/done': {
                const name = commandNames.get(String(data.commandId)) ?? '';
                commandNames.delete(String(data.commandId));
                const text = typeof data.text === 'string' ? data.text.trim() : '';
                push(`> 命令 \`/${name}\` ${data.kind === 'error' ? '失败' : '完成'}${text ? `：${flatten(text)}` : ''}`);
                break;
            }
            case 'turn/end': {
                const raw = data.reason;
                const kind = typeof raw === 'string' ? raw : String((raw && raw.kind) || '');
                if (kind && kind !== 'completed') push(`> ⚠ 本轮结束：${kind}`);
                break;
            }
            default:
                break;
        }
    }
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 去掉**末尾**解析不出来的行（日志正在写 / 崩过时会有半行）。
 *
 * 为什么 jsonl 导出必须做这件事：那份文件是**给工具吃的**（jq、脚本、喂别的模型），
 * 末尾挂一行残缺 JSON 会让每一个消费方都在最后一步炸掉 —— 而缺的本来就是一个
 * 没写完的事件，丢掉它才是对的。md 那条路不用管（`parseEvents` 已经跳过坏行）。
 *
 * @param {string} text - 解压出来的原文。
 * @returns {string} 掐掉残缺尾巴的文本。
 */
function dropTornTail(text) {
    const lines = text.split('\n');
    let end = lines.length;
    while (end > 0) {
        const trimmed = lines[end - 1].trim();
        if (!trimmed) {
            end -= 1;
            continue;
        }
        try {
            JSON.parse(trimmed);
        } catch {
            end -= 1;
            continue;
        }
        break;
    }
    return lines.slice(0, end).join('\n');
}

/** 我们这份 `manifest.json` 的 schema 版本（**不是** DSH 的会话格式版本 —— 那个恒为 0）。 */
const MANIFEST_VERSION = 1;

/**
 * 组装导出包的**内容计划**（纯函数：只吃数据，不碰磁盘）。
 *
 * ## 布局（与 DSH 官方导出对齐）
 *
 * ```text
 * dsh-session-<safeId>.zip          safeId = id.replace(/[^A-Za-z0-9_-]/g, '_')
 * ├── session.jsonl                 根会话日志**解压后的明文**，逐字节原样（不重新序列化）
 * ├── subagents/<safeId>/session.jsonl   每个子孙一份（DFS 前序）
 * ├── media/<hex>.<ext>             附件像素
 * └── manifest.json                 我们加的（DSH 不写）
 * ```
 *
 * ## 两处**有意**的偏离，都写在这里，免得后人以为是写错了
 *
 * 1. **`media/` 的条目名去掉 `sha256:` 前缀**（DSH 写的是 `media/sha256:xxxx.png`）。
 *    冒号是 Windows 文件名里的**非法字符** —— 带冒号的名字解压时会失败或被自动改名，
 *    于是「按 manifest 找像素」这件事在 Windows 上直接坏掉。去前缀后名字是纯 hex，
 *    全平台安全；**完整 id 仍然保留在 `manifest.json` 里**，映射关系没丢。
 * 2. **多写一份 `manifest.json`**。DSH 不写，于是它的包是「结构即协议」——
 *    想知道某个 `media/<名字>` 对应哪条引用，只能靠名字反推（还得先接受上面那个冒号问题）。
 *    我们加一份清单：`sessions[]` 给出父子与层级，`media[]` 给出 `attachmentId ↔ path` 的映射。
 *
 * ⚠ `sessions[]` **只列子孙**（根的完整信息在上面的 `root` 里）——
 * 根再列一遍就会有两份可能不一致的副本，而「哪一份是权威」正是清单最该回答的问题。
 *
 * @param {{root: {id: string, title: string, cwd: string, parentSession?: unknown, origin?: unknown, text: string}, sessions?: Array<Record<string, unknown>>, media?: Array<Record<string, unknown>>, exportedAt?: string}} input - 根会话、子孙、媒体与时间。
 * @returns {{entries: Array<Record<string, unknown>>, manifest: Record<string, unknown>}} ZIP 条目计划（**顺序即产物顺序**）与清单。
 */
function buildZip(input) {
    const rootInfo = input.root;
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    const media = Array.isArray(input.media) ? input.media : [];
    const exportedAt = input.exportedAt ?? new Date().toISOString();

    const entries = [{ path: 'session.jsonl', text: rootInfo.text }];
    for (const session of sessions) entries.push({ path: session.path, text: session.text });
    for (const item of media) {
        // media 用 store：PNG/JPEG/GIF/WEBP 本来就压过一遍，deflate 只会白花 CPU
        // （`writeZip` 里还有一条「压不动就退 store」的兜底，所以这里就算漏了也只是慢一点）
        entries.push({ path: item.path, data: item.data, method: 'store' });
    }

    const manifest = {
        version: MANIFEST_VERSION,
        exportedAt,
        root: {
            id: rootInfo.id,
            title: rootInfo.title,
            cwd: rootInfo.cwd,
            parentSession: rootInfo.parentSession ?? null,
            origin: rootInfo.origin ?? null,
            depth: 0,
            path: 'session.jsonl',
        },
        sessions: sessions.map((session) => ({
            id: session.id,
            parentSession: session.parentSession ?? null,
            // `origin` 是**日志里的原值**（`subagent` / 空）。空 + 有 parentSession = fork，
            // 这里**不替它编一个 'fork'** —— 回执里的 `subagents.forkCount` 才是那个判断的出处。
            origin: session.origin ?? null,
            /** ⚠ 这是**导出层级**（相对本包的根），不是 header 的 `delegationDepth`。 */
            depth: session.depth,
            path: session.path,
        })),
        media: media.map((item) => ({
            attachmentId: item.attachmentId,
            path: item.path,
            bytes: item.bytes,
            mediaType: item.mediaType,
        })),
    };
    entries.push({ path: 'manifest.json', text: `${JSON.stringify(manifest, null, 2)}\n` });
    return { entries, manifest };
}

/**
 * 收集「这次导出包含哪些会话 / 引用了哪些附件」——md/jsonl 与 zip 两条路共用。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {Record<string, unknown>} entry - 根会话条目（已定位）。
 * @param {{withSubagents?: boolean, withMedia?: boolean, needText?: boolean, needBytes?: boolean, attachments?: string, indexBudgetMs?: number, maxSessions?: number}} [options] - 开关。
 * @returns {Record<string, unknown>} 根会话文本、子孙清单、媒体清单与全部诊断。
 */
function collectExportScope(root, entry, options = {}) {
    const withSubagents = options.withSubagents === true;
    const withMedia = options.withMedia === true;
    const needText = options.needText === true;
    const needBytes = options.needBytes === true;
    const attachmentsRoot = attachmentsRootOf(root, options.attachments);
    const objectsDir = join(attachmentsRoot, 'v1', 'objects');
    const errors = [];

    /**
     * ⚠ **`--with-subagents` 没给就根本不建索引**。
     *
     * 为什么：建索引要把**所有工程目录的所有会话**的头部帧读一遍（本机 498 条 / 569 MB 实测
     * 147 ms —— 便宜，但不是零）。而 md/jsonl 那条老路（`history.ts` 天天在走）
     * 大多数时候只导一条会话，**完全不需要知道谁是谁的子会话**。
     * 不加这道门，就等于给每一次普通导出白加 147 ms 与一次几百文件的遍历。
     */
    const index = withSubagents ? buildSessionIndex(root, { maxSessions: options.maxSessions, budgetMs: options.indexBudgetMs }) : null;
    const rootId = sessionIdOf(entry);
    const walked = index ? descendantsOf(index, rootId) : { descendants: [], dangling: [] };

    // 根那一条：**稳定读**（正在被写的会话读到的可能是「写了一半」的一眼）
    const rootRead = stableRead(entry.log);
    const rootText = textOfLogBytes(rootRead.bytes, entry.log);
    /**
     * ⚠ **根会话的事件只在需要时全量解析**。
     *
     * 为什么把它做成开关：`jsonl` 那条路的用途就是「原样搬出去」，而 14k 行的日志全量
     * `JSON.parse` 是**几百毫秒的纯浪费**（老实现只在头部窗口里解析一次拿标题）。
     * 真正需要全量的只有三种情况：md（要投影）、zip（要回合数与引用）、withMedia（要引用清单）。
     *
     * ⚠ 但 `stableRead` **无论哪条路都要用**：不解析不等于可以不看稳定性 ——
     * 「原样搬出去」的那份文本要是「写了一半的一眼」，产物里就挂着一行残缺 JSON。
     * （`dropTornTail` 兜的是「末尾半行」，兜不了「读到一半时文件又被追加」。）
     */
    const needEvents = options.needEvents === true || withMedia;
    const rootEvents = needEvents ? parseEvents(rootText) : parseEvents(rootText.slice(0, TITLE_SCAN_BYTES));

    const sessions = [];
    const refs = new Map();
    let subagentCount = 0;
    let forkCount = 0;
    let maxDepth = 0;

    const mergeRefs = (collected) => {
        for (const [refId, ref] of collected.refs) {
            const known = refs.get(refId);
            if (!known) {
                refs.set(refId, { ...ref, claimedSizes: new Set(ref.claimedSizes) });
                continue;
            }
            known.count += ref.count;
            for (const size of ref.claimedSizes) known.claimedSizes.add(size);
        }
    };
    if (withMedia) mergeRefs(collectImageRefs(rootEvents));

    const usedPaths = new Set(['session.jsonl']);
    for (const item of walked.descendants) {
        const child = item.entry;
        maxDepth = Math.max(maxDepth, item.depth);
        if (isSubagentEntry(child)) subagentCount += 1;
        else forkCount += 1;

        // safeId 照抄 DSH：把非 `[A-Za-z0-9_-]` 一律折成 `_`。
        // ⚠ 折完**可能撞车**（`a:b` 与 `a_b` 会折成同一个名字）—— 日志里的 id 都是 uuid，
        //    真撞上说明有人手改过目录。撞了就退一个后缀并**如实记进 warnings**，不静默覆盖。
        let safeId = String(child.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
        let path = `subagents/${safeId}/session.jsonl`;
        let suffix = 1;
        while (usedPaths.has(path)) {
            suffix += 1;
            path = `subagents/${safeId}-${suffix}/session.jsonl`;
        }
        usedPaths.add(path);
        if (suffix > 1) errors.push(`子会话 ${child.id} 的 safeId 与别的会话撞了，退成 ${safeId}-${suffix}（目录被手改过就会出现这种）`);

        const row = {
            id: child.id,
            parentSession: child.parentSession,
            origin: child.origin,
            depth: item.depth,
            projectKey: child.projectKey,
            dirName: child.dirName,
            path,
        };
        if (needText || withMedia) {
            try {
                const read = stableRead(child.log);
                const text = textOfLogBytes(read.bytes, child.log);
                if (needText) row.text = text;
                if (withMedia) mergeRefs(collectImageRefsInText(text));
                row.stable = read.stable;
            } catch (error) {
                errors.push(`读子会话 ${child.dirName} 失败：${error.message}`);
                if (needText) row.text = '';
            }
        }
        sessions.push(row);
    }

    // ---- 媒体：**缺失要如实报**（不要静默少导）
    const media = [];
    const missingMedia = [];
    if (withMedia) {
        // 按 id 排序：产物顺序才是可复现的（扫描顺序依赖文件系统）
        for (const refId of [...refs.keys()].sort()) {
            const ref = refs.get(refId);
            const hex = hexOfAttachmentId(refId);
            if (!hex) {
                missingMedia.push({ attachmentId: refId, reason: 'bad-id' });
                continue;
            }
            const from = join(objectsDir, hex.slice(0, 2), hex);
            const path = `media/${hex}.${extOfMediaType(ref.mediaType, ref.name)}`;
            let bytes = 0;
            let data = null;
            try {
                if (needBytes) {
                    data = readFileSync(from);
                    bytes = data.length;
                } else {
                    bytes = statSync(from).size;
                }
            } catch (error) {
                missingMedia.push({
                    attachmentId: refId,
                    hex,
                    path: from,
                    reason: error.code === 'ENOENT' ? 'missing' : 'unreadable',
                    error: error.message,
                });
                continue;
            }
            media.push({ attachmentId: refId, hex, path, bytes, mediaType: ref.mediaType || '', data, refCount: ref.count });
        }
    }

    return {
        rootId,
        rootText,
        rootEvents,
        rootRead,
        // 标题取「会话日志自己记的 `session/title`（最新一条胜出）」优先，没有才回退首条用户消息
        // —— 与 list/read 那条路同一口径（`dsh-session-title` 会规范化标题，LLM 标题比首条消息准）。
        title: loggedTitleOf(rootEvents) || titleOf(rootEvents),
        sessions,
        media,
        missingMedia,
        refs,
        subagentCount,
        forkCount,
        maxDepth,
        dangling: walked.dangling,
        /** 没建索引时（没要子孙）如实给 null —— 不是「扫了 0 条」，面板别把这两件事混起来显示。 */
        indexScan: index ? index.scanned : null,
        indexIncomplete: index ? index.incomplete : false,
        errors,
    };
}

/**
 * 导出成 ZIP（**对齐 DSH 官方布局** + 一份我们自己加的 manifest）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {Record<string, unknown>} entry - 根会话条目（已定位）。
 * @param {Record<string, unknown>} options - `out` / `subagents` / `media` / `attachments` 等。
 * @returns {Record<string, unknown>} 写出的路径、条目清单与全部诊断。
 */
function exportZip(root, project, entry, options) {
    const scope = collectExportScope(root, entry, { ...options, needText: true, needBytes: true });
    const header = entry.header ?? {};
    const rootId = scope.rootId;
    const outDir = resolve(String(options.out ?? '') || join(dirname(resolve(root)), 'exports', project));
    mkdirSync(outDir, { recursive: true });

    // 文件名对齐 DSH：`dsh-session-<safeId>.zip`
    const safeId = String(rootId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    let file = join(outDir, `dsh-session-${safeId}.zip`);
    for (let index = 2; existsSync(file) && index < 100; index += 1) file = join(outDir, `dsh-session-${safeId}-${index}.zip`);

    const built = buildZip({
        root: {
            id: rootId,
            title: scope.title,
            cwd: typeof header.cwd === 'string' ? header.cwd : '',
            parentSession: header.parentSession ?? null,
            origin: header.origin ?? null,
            // ⚠ **原样明文**：不重新序列化、不 dropTornTail。
            //    jsonl 那条路会掐掉末尾半行（那份文件是喂 jq/别的模型的，半行会让消费方在最后一步炸），
            //    但 ZIP 里的这一份是**归档**：它的用途是「原样留底 / 以后能再解一次」，
            //    动它一个字节就不再是原件了。
            text: scope.rootText,
        },
        sessions: scope.sessions,
        media: scope.media,
        exportedAt: new Date().toISOString(),
    });
    const zipBytes = writeZip(built.entries);
    writeFileSync(file, zipBytes);

    const notes = [];
    /**
     * ⚠ 这一句是**必须带**的：DSH 官方导出会先把正在写的会话 flush 到磁盘再打包，
     * 而我们是从**静态文件**读的 —— 正在跑的这条会话，最后几条事件可能还在宿主的缓冲里没落盘。
     * 我们**做不到**那个 flush（拿不到宿主的写入口），所以只能把局限写在回执里。
     */
    notes.push('当前活跃会话可能少最后几条：DSH 导出前会先把会话 flush 到磁盘，我们读的是静态文件，做不到那一步（只保证「读到的这一眼前后一致」）。');
    if (!scope.rootRead.stable) {
        notes.push(`根会话日志在 ${scope.rootRead.attempts} 次重读后仍在变化 —— 这一份极可能少了最后几条，建议先把 agent 停下来再导一次。`);
    }
    if (scope.sessions.some((session) => session.stable === false)) {
        notes.push('有子会话日志在重读后仍在变化（同上：可能少最后几条）。');
    }
    if (scope.indexIncomplete) {
        notes.push(`会话索引扫描超预算（只看了 ${scope.indexScan.sessions} 条）—— 子孙可能不全。`);
    }
    if (scope.missingMedia.length > 0) {
        notes.push(`有 ${scope.missingMedia.length} 个引用的附件在库里找不到物理文件（见 missingMedia）—— 会话里引用了它，但像素导不出来。`);
    }
    for (const error of scope.errors) notes.push(error);

    return {
        ok: true,
        id: rootId,
        title: scope.title,
        format: 'zip',
        path: file,
        dir: outDir,
        /** zip 文件本身的字节数。 */
        bytes: zipBytes.length,
        /** zip 的条目数（zip 这条路上「条数」的含义变了，所以显式写在注释里而不是含糊过去）。 */
        events: built.entries.length,
        /** 根会话的回合数（解出来的）。 */
        turns: scope.rootEvents.filter((event) => event.type === 'turn/start').length,
        zip: {
            fileName: file.slice(outDir.length + 1),
            bytes: zipBytes.length,
            entries: built.entries.map((item) => ({
                path: item.path,
                bytes: item.text !== undefined ? Buffer.byteLength(item.text, 'utf8') : item.data.length,
                method: item.data === undefined ? 'deflate' : 'store',
            })),
            manifest: built.manifest,
        },
        subagents: {
            /** 子孙总数（**fork 也算**，口径照抄 DSH）。 */
            total: scope.sessions.length,
            /** 其中 `origin === 'subagent'` 的（真正的子 agent）。 */
            subagentCount: scope.subagentCount,
            /** 其中「有父但不是 subagent」的（本机实测就是 `/fork` 出来的那种：有 parentSession + seedLength、depth 0、没有 origin）。 */
            forkCount: scope.forkCount,
            maxDepth: scope.maxDepth,
            sessions: scope.sessions.map((session) => ({
                id: session.id,
                parentSession: session.parentSession,
                origin: session.origin,
                depth: session.depth,
                projectKey: session.projectKey,
                dirName: session.dirName,
                path: session.path,
            })),
            dangling: scope.dangling,
            indexScan: scope.indexScan,
            incomplete: scope.indexIncomplete,
        },
        media: {
            count: scope.media.length,
            entries: scope.media.map((item) => ({ attachmentId: item.attachmentId, path: item.path, bytes: item.bytes, mediaType: item.mediaType })),
            missing: scope.missingMedia,
            /** ⚠ **有意偏离 DSH**：`media/` 条目名去掉 `sha256:` 前缀（Windows 文件名不许带冒号）。 */
            namingDeviation: 'media/<hex>.<ext>（去掉了 sha256: 前缀 —— Windows 文件名不允许冒号）；完整 id 在 manifest.json 里。',
        },
        missingMedia: scope.missingMedia,
        notes,
    };
}

/**
 * 导出一个会话（markdown 或**原样 JSONL**）。
 *
 * 两种格式对应两种用途：`md` 是给人/给模型看的转写，`jsonl` 是把日志**解压后原样**
 * 写出去（不投影、不截断 —— 想拿它做统计或喂别的工具时，中间任何一层投影都是损失）。
 *
 * 落在 `<DSH_HOME>/exports/<工程键>/`（`--out` 可改）：**不往工程目录里写** ——
 * 导出物属于「看一眼就删」的东西，扔进工程只会污染 git。
 *
 * ⚠ **md/jsonl 的回执字段保持不变**（面板 `source/history.ts` 那条老路在吃它）：
 * 不带新开关时返回的就是原来那 9 个键。`--with-subagents` / `--with-media` / `--zip`
 * 只在**额外**的键里加东西（`subagents` / `media` / `missingMedia` / `notes`）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {unknown} id - 会话 id。
 * @param {Record<string, unknown>} options - `format`（`md` | `jsonl` | `zip`）/ `out` / `withSubagents` / `withMedia` / `zip` / `attachments`。
 * @returns {Record<string, unknown>} 写出的路径与体积（+ 新开关带来的清单与诊断）。
 */
function exportSession(root, project, id, options = {}) {
    const entry = locateSession(root, project, id);
    const zip = options.zip === true || options.format === 'zip';
    /**
     * ⚠ **zip 默认带上子孙与媒体**（本轮没有提供「关掉」的旗标）。
     *
     * 理由：`--format=zip` 的意义就是「对齐 DSH 官方的导出布局」，而那份布局里
     * `subagents/` 与 `media/` 是**组成部分**；要一份「只有根会话的 zip」是个没有用途的中间态
     * （想要单条会话的文本，md/jsonl 才是对的格式）。
     * 于是在 zip 上这两个旗标是**显式重复**，而在 md/jsonl 上它们负责
     * 「把清单与缺失诊断报出来」（md 里塞不进像素，只能报）。
     */
    const withSubagents = zip || options.withSubagents === true;
    const withMedia = zip || options.withMedia === true;
    if (zip) return exportZip(root, project, entry, { ...options, withSubagents, withMedia });

    const format = options.format === 'jsonl' ? 'jsonl' : 'md';
    const scope = collectExportScope(root, entry, { ...options, withSubagents, withMedia, needText: false, needBytes: false, needEvents: format === 'md' });
    const text = scope.rootText;
    const events = format === 'jsonl' ? null : scope.rootEvents;
    // jsonl 是「原样搬出去」，所以不解析整份（几万行的 JSON.parse 纯属白花）；
    // 但文件名要用标题，所以在**头部窗口**里解析一次拿它。
    const head = events ?? parseEvents(text.slice(0, TITLE_SCAN_BYTES));

    const title = loggedTitleOf(head) || titleOf(head);
    const turns = events ? events.filter((event) => event.type === 'turn/start').length : 0;
    const header = entry.header ?? {};

    const stem = `${stampOf(Date.now())}-${slugOf(title, 'session')}-${entry.name.slice(0, 8)}`;
    const outDir = resolve(String(options.out ?? '') || join(dirname(resolve(root)), 'exports', project));
    mkdirSync(outDir, { recursive: true });

    let file = join(outDir, `${stem}.${format}`);
    for (let index = 2; existsSync(file) && index < 100; index += 1) file = join(outDir, `${stem}-${index}.${format}`);

    const content =
        format === 'jsonl'
            ? `${dropTornTail(text).replace(/\n+$/, '')}\n`
            : renderMarkdown(events, {
                  title,
                  id: sessionIdOf(entry),
                  cwd: typeof header.cwd === 'string' ? header.cwd : '',
                  createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
                  updatedAt: Math.round(entry.mtimeMs),
                  turns,
                  eventCount: events.length,
                  logBytes: entry.size,
                  logFile: entry.log,
              });

    writeFileSync(file, content, 'utf8');
    const receipt = {
        ok: true,
        id: sessionIdOf(entry),
        title,
        format,
        path: file,
        dir: outDir,
        bytes: Buffer.byteLength(content, 'utf8'),
        /** md = 投影后的事件条数；jsonl = 原样搬出去的行数。 */
        events: content.split('\n').filter((line) => line.trim()).length,
        turns,
    };
    if (withSubagents || withMedia) {
        // 新开关带来的都是**额外**键：老消费者（history.ts）只看它认识的那几个，加键不影响它
        receipt.subagents = {
            total: scope.sessions.length,
            subagentCount: scope.subagentCount,
            forkCount: scope.forkCount,
            maxDepth: scope.maxDepth,
            sessions: scope.sessions.map((session) => ({
                id: session.id,
                parentSession: session.parentSession,
                origin: session.origin,
                depth: session.depth,
                projectKey: session.projectKey,
                dirName: session.dirName,
                path: session.path,
            })),
            dangling: scope.dangling,
            indexScan: scope.indexScan,
            incomplete: scope.indexIncomplete,
        };
        receipt.media = {
            count: scope.media.length,
            entries: scope.media.map((item) => ({ attachmentId: item.attachmentId, path: item.path, bytes: item.bytes, mediaType: item.mediaType })),
            missing: scope.missingMedia,
        };
        receipt.missingMedia = scope.missingMedia;
        const notes = [];
        if (withMedia && !zip) notes.push(`图片像素不在 ${format} 里（那种格式装不了二进制）—— 上面的 media 清单是「谁引用了哪些附件」，要像素请用 --format=zip。`);
        if (scope.indexIncomplete) notes.push(`会话索引扫描超预算（只看了 ${scope.indexScan.sessions} 条）—— 子孙可能不全。`);
        for (const error of scope.errors) notes.push(error);
        if (notes.length > 0) receipt.notes = notes;
    }
    return receipt;
}

// ---------------------------------------------------------------- 删除

/** 递归列一个目录里的文件（删除前的「你有什么要删」如实报告）。 */
function inventory(dir) {
    const files = [];
    let bytes = 0;
    const walk = (current) => {
        for (const name of readdirSync(current)) {
            const full = join(current, name);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) walk(full);
            else {
                files.push({ name: full.slice(dir.length + 1), bytes: stat.size });
                bytes += stat.size;
            }
        }
    };
    walk(dir);
    return { files, bytes };
}

/**
 * 删掉一条会话（**只删会话目录本身**）。
 *
 * 三件事必须说清楚：
 * 1. **`--dry-run` 先报清单**：面板拿它做二次确认（「将删除 1 个文件 · 1.7 MB」），
 *    真删是第二次点击，不会一次点错就没了。
 * 2. **附件默认不跟着删**：图片按内容存在 `<DSH_HOME>/attachments/v1/objects/…`，
 *    跨会话共用（同一张图只存一份），DSH 自己也不回收 —— 删会话不会误删别人的图，
 *    但也不会因此腾出图片的空间。要回收就显式加 `--reclaim-attachments`（见 `reclaimAttachments`）。
 * 3. **正在跑的会话删不掉**：这是**宿主层**的守卫（`dsh-host.ts` 拒绝删当前会话），
 *    因为脚本这一侧看不到运行时状态；真要硬删，agent 下一次落盘会把目录重新建出来。
 *
 * ⚠ `--with-subagents` 在 delete 上**只影响候选集**（回收附件时把子孙引用的也当成候选），
 * **不动子孙的会话目录** —— 删会话是用户点的那一下，擅自把删除面扩大到一整棵子树
 * 是另一件事，本轮不做（那需要面板上单独的确认）。
 *
 * @param {string} root - `<DSH_HOME>/sessions`。
 * @param {string} project - 工程键。
 * @param {unknown} id - 会话 id。
 * @param {boolean | Record<string, unknown>} options - `true` = dry-run（老签名，兼容直接传布尔）；或 `{dryRun, reclaimAttachments, withSubagents, attachments, budgetMs, maxSessions, maxBytes, minAgeMs}`。
 * @returns {Record<string, unknown>} 清单与是否真删了（+ 开启回收时的 `reclaim`）。
 */
function deleteSession(root, project, id, options = {}) {
    const opts = typeof options === 'boolean' ? { dryRun: options } : options ?? {};
    const dryRun = opts.dryRun === true;
    const base = join(root, project);
    const entry = locateSession(root, project, id);
    const dir = ensureInside(base, entry.dir);
    const { files, bytes } = inventory(dir);

    /**
     * ⚠ **回收必须在删目录之前算**：候选集的定义是「即将消失的那几条日志引用过什么」，
     * 会话目录一删就再也算不出来了（日志是唯一能反推引用的东西 —— 附件库本身没有索引）。
     * 顺序反了的话，这个功能会永远报「候选 0 个」。
     */
    let reclaim = null;
    if (opts.reclaimAttachments === true) {
        reclaim = reclaimAttachments(root, project, id, {
            dryRun,
            withSubagents: opts.withSubagents === true,
            attachments: opts.attachments,
            budgetMs: opts.budgetMs,
            maxSessions: opts.maxSessions,
            maxBytes: opts.maxBytes,
            minAgeMs: opts.minAgeMs,
        });
    }

    if (dryRun !== true) rmSync(dir, { recursive: true, force: true });
    const receipt = {
        ok: true,
        id: sessionIdOf(entry),
        dirName: entry.name,
        dir,
        dryRun,
        removed: dryRun !== true,
        fileCount: files.length,
        files: files.slice(0, 50),
        bytes,
    };
    if (reclaim) receipt.reclaim = reclaim;
    return receipt;
}

/** 已知的开关名（`--key value` 里判断「下一个 token 到底是不是值」要有一份白名单）。 */
const FLAGS = new Set([
    'root',
    'project',
    'id',
    'limit',
    'max-events',
    'query',
    'format',
    'out',
    'per-session',
    'max-sessions',
    'max-bytes',
    'budget-ms',
    'dry-run',
    // 2026-12 新增（导出对齐 DSH / 回收无引用附件）
    'with-subagents',
    'with-media',
    'zip',
    'attachments',
    'reclaim-attachments',
    // ⚠ **没有 `--purge`**，这是有意的：回收只搬墓碑、永不 unlink，
    //    不可逆的旗标本轮不提供（见 `trashAttachments` 的 JSDoc）。
]);

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

/** 布尔开关的判定：`--flag`（parseArgs 给 `true`）与 `--flag=true`（给字符串 `'true'`）都算开。 */
function isOn(args, name) {
    const value = args[name];
    return value === true || value === 'true' || value === '1' || value === '';
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
    if (command === 'search') {
        return searchSessions(root, project, {
            query: typeof args.query === 'string' ? args.query : '',
            limit: args.limit,
            perSession: args['per-session'],
            maxSessions: args['max-sessions'],
            maxBytes: args['max-bytes'],
            budgetMs: args['budget-ms'],
        });
    }
    if (command === 'export') {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) throw new Error('export 需要 --id');
        return exportSession(root, project, id, {
            format: typeof args.format === 'string' ? args.format : 'md',
            out: typeof args.out === 'string' ? args.out : '',
            zip: isOn(args, 'zip'),
            withSubagents: isOn(args, 'with-subagents'),
            withMedia: isOn(args, 'with-media'),
            attachments: typeof args.attachments === 'string' ? args.attachments : '',
            budgetMs: args['budget-ms'],
            maxSessions: args['max-sessions'],
            maxBytes: args['max-bytes'],
        });
    }
    if (command === 'delete') {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) throw new Error('delete 需要 --id');
        return deleteSession(root, project, id, {
            dryRun: isOn(args, 'dry-run'),
            reclaimAttachments: isOn(args, 'reclaim-attachments'),
            withSubagents: isOn(args, 'with-subagents'),
            attachments: typeof args.attachments === 'string' ? args.attachments : '',
            budgetMs: args['budget-ms'],
            maxSessions: args['max-sessions'],
            maxBytes: args['max-bytes'],
        });
    }
    throw new Error(`未知命令 "${command}"（只认 list / read / search / export / delete）`);
}

/**
 * 导出**纯逻辑**给测试与面板复用（2026-12 加）。
 *
 * 为什么要导出而不是只留 CLI：本会话的沙箱**禁止用管道抓子进程输出**
 * （`spawn`/`spawnSync` 拿 stdout 会 EPERM），所以 `verify-history.js` 里那批
 * 「spawn 一个 node 跑 CLI 再解析 stdout」的断言在受限环境下**跑不起来**。
 * 把纯逻辑导出之后，同一条判据可以直接 `require` 进来断言 —— 不走子进程、不碰 stdout。
 * 也因此下面用 `require.main === module` 包住 CLI 入口：**被 require 时绝不能执行命令**。
 */
module.exports = {
    // 容器 / 解码
    scanZstdFrames,
    decodeAll,
    decodeText,
    parseEvents,
    textOfLogBytes,
    stableRead,
    readHeader,
    readHeadBytes,
    // 定位 / 索引
    pickLogFile,
    sessionDirs,
    sessionIdOf,
    locateSession,
    listProjectDirs,
    buildSessionIndex,
    resolveInIndex,
    descendantsOf,
    isSubagentEntry,
    ensureInside,
    safeNameOf,
    // 附件
    ATTACHMENT_ID_PATTERN,
    RECLAIM_DEFAULTS,
    attachmentsRootOf,
    hexOfAttachmentId,
    extOfMediaType,
    collectImageRefs,
    collectImageRefsInText,
    refsOfLog,
    scanAllAttachmentRefs,
    trashTargetOf,
    findOrphanAttachments,
    trashAttachments,
    reclaimAttachments,
    // 导出
    buildZip,
    collectExportScope,
    exportSession,
    renderMarkdown,
    dropTornTail,
    stampOf,
    slugOf,
    // 删除
    deleteSession,
    inventory,
    // 其余
    listSessions,
    readSession,
    searchSessions,
    FLAGS,
    parseArgs,
    main,
};

if (require.main === module) {
    try {
        const payload = main();
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        process.exitCode = 1;
    }
}
