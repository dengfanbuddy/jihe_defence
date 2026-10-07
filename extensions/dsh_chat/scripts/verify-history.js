/**
 * 会话**搜索 / 导出 / 删除**的回归：拿一个**合成会话树**跑真脚本。
 *
 * ## 为什么不能只拿本工程的真日志跑
 *
 * 真日志适合验「读得出来」（`verify-replay.js` 干的就是那件事），但不适合验**判据**：
 *
 * - 「搜索命中的是**投影后的文本**，不是原始 JSON」—— 真日志里搜不到能区分两者的样本；
 * - 「老形状与新形状的 `tool/result` 都要认」—— 得**同时**造出两份来，而真日志里通常只有一种；
 * - 「`command/done` 不带名字，名字要从配对的 `command/run` 拿」—— 本工程的日志里根本没跑过斜杠命令；
 * - 「`..` / `../..` 删不掉东西」「header.id 与目录名不一致也能定位」—— 这些是**守卫**，
 *   只能在合成树上验（真日志上试一次就是把用户的历史删了）。
 *
 * 所以这里造一棵临时根目录，写出**真的 zstd 拼接帧**（含故意截断的半个尾帧），
 * 用**真的** `session-log.js` 跑 list / read / search / export / delete，逐条断言。
 *
 * ## 2026-12 加的第二段：`directChecks()`（**不 spawn**）
 *
 * 本会话的沙箱**禁止用管道抓子进程输出**：`spawnSync(..., {encoding:'utf8'})` 实测
 * `error.code === 'EPERM'`、`stdout === undefined` —— 于是 `cli()` 抛错、`main()` 的外层
 * catch 把它当「异常」吞掉，**整个 CLI 段一条断言都跑不到**。
 *
 * 所以本文件末尾多了一段 `directChecks()`：`require('../scripts/session-log.js')` 与
 * `require('../scripts/zip.js')` 之后**直接调函数**，覆盖同一批判据的「可用版本」，
 * 并额外覆盖三件 CLI 覆盖不到的事：
 * 1. **会话索引**（跨工程反查子会话、重复 id 不静默取第一个、DFS 前序 + fork 口径）；
 * 2. **导出 ZIP**（用一份**独立写的**字节级解析器把产物读回来：EOCD → 中央目录 →
 *    逐条 local header → 解压 → 逐字节比，连 `manifest.json` 的内容一起对账）；
 * 3. **孤儿附件回收**（唯一引用 vs 跨会话共享、四条交叉验证否决、`incomplete` 时 fail-closed、
 *    dry-run 与真跑同一份清单、墓碑路径）。
 *
 * ⚠ 两段**互不替代**：CLI 段验的是「命令行这条路还通不通」（`parseArgs` 的白名单、
 * 工程键以 `--` 开头不被吞、子进程退出码/JSON stdout），直接调用段验的是逻辑本身。
 * 权限足够的环境里请两段都跑。
 *
 * 全过程只碰系统临时目录，**不读也不写** `<DSH_HOME>`。
 *
 * ```sh
 * node scripts/verify-history.js [--keep]
 * ```
 *
 * @module dsh_chat/verify-history
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { zstdCompressSync, inflateRawSync, crc32: nodeCrc32 } = require('node:zlib');

/** 被测的会话脚本与 ZIP 写入器（**直接 require**，不经过子进程 —— 见文件头第二段）。 */
const S = require('../scripts/session-log.js');
const { writeZip, crc32 } = require('../scripts/zip.js');

const EXT_ROOT = resolve(__dirname, '..');
const CLI = join(EXT_ROOT, 'scripts', 'session-log.js');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        process.exitCode = 1;
    }
};

/**
 * BMP **之外**的字符样本（CJK 扩展 B + 麻将红中），用来验「分帧/编码不许劈开代理对」。
 *
 * ⚠ **必须用 `String.fromCodePoint` 造，不要在源码里写字面量或 `\u{…}` 转义**（2026-12 踩过）：
 * 这个字符（U+20000）在编辑器/工具链里很容易被换成**形近字**（本文件第一版就被换成了
 * U+2000B —— 长得几乎一样），于是**夹具里是 A、断言里是 B**，判据以「找不到那个字符」失败，
 * 而归因方向完全错（看着像「解码把字符弄丢了」）。用 code point 构造，两边永远同一个字符。
 */
const ASTRAL_SAMPLE = String.fromCodePoint(0x20000, 0x1f004);

/**
 * 本环境的 CLI 段**能不能跑**：探一次「用管道抓子进程输出」。
 *
 * 为什么要有这个探测：受限沙箱里 `spawnSync` 拿 stdout 会 EPERM，`cli()` 于是抛错，
 * 而 `main()` 的外层 catch 会把它当异常收掉 —— 结果是**输出里只剩一行异常**，
 * 分不清「CLI 段跑失败了」和「CLI 段根本没跑」。探一下就能把这两种情况分开说清楚。
 *
 * ⚠ 探测本身**不改任何行为**：能跑就照旧跑（权限足够的环境里结果与以前完全一样），
 * 跑不了就在总结里如实标一句「这一段未验证」。
 *
 * @returns {boolean} 管道抓 stdout 是否可用。
 */
function probeCli() {
    try {
        const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("1")'], { encoding: 'utf8', windowsHide: true });
        return String(probe.stdout ?? '') === '1';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- 合成事件

/** 事件工厂（形状**照抄真日志**：header 的字段在顶层，不在 `data` 里）。 */
const EV = {
    /**
     * 会话头行。
     *
     * @param {string} id - 会话 id。
     * @param {string} cwd - 该会话**自己**的 cwd（子会话的工程键按它算，可能与父不同）。
     * @param {number} createdAt - 创建时间。
     * @param {Record<string, unknown>} [extra] - `parentSession` / `origin` / `delegationDepth` / `seedLength` 等（2026-12 加，为了造子会话与 fork）。
     */
    header: (id, cwd, createdAt, extra) => ({ type: 'session', version: 0, id, createdAt, cwd, ...(extra ?? {}) }),
    user: (seq, text, source) => ({
        type: 'user/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { content: [{ type: 'text', text }], source: source ?? { kind: 'user' } },
    }),
    userWithImage: (seq, text, name) => ({
        type: 'user/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: {
            content: [
                { type: 'text', text },
                {
                    type: 'image',
                    // ⚠ `attachmentId` 是**唯一**能把图连回附件库的键（`sha256:<64 hex>`）——
                    // 「导出带像素」与「删会话回收附件」都靠它，所以夹具里就得写全。
                    attachment: {
                        name,
                        mediaType: 'image/png',
                        bytes: 2048,
                        width: 64,
                        height: 32,
                        attachmentId: 'sha256:abababababababababababababababababababababababababababababababab',
                    },
                },
            ],
            source: { kind: 'user' },
        },
    }),
    assistant: (seq, text, reasoning) => ({
        type: 'assistant/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: {
            message: {
                role: 'assistant',
                content: [
                    ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
                    ...(text ? [{ type: 'text', text }] : []),
                ],
            },
        },
    }),
    toolCall: (seq, name, args) => ({
        type: 'tool/call',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { callId: `c${seq}`, name, arguments: args },
    }),
    /** 老形状（`version: 0`）：内容在里层 `{type:'tool-result', content:[…]}`。 */
    toolResultOld: (seq, text, isError) => ({
        type: 'tool/result',
        seq,
        time: 1_700_000_000_000 + seq,
        data: {
            message: {
                source: { kind: 'tool', callId: `c${seq - 1}` },
                content: [{ type: 'tool-result', toolCallId: `c${seq - 1}`, content: [{ type: 'text', text }], isError: !!isError }],
            },
        },
    }),
    /** 新形状（`version: 4`）：内容**就是**这一层。 */
    toolResultNew: (seq, text, isError) => ({
        type: 'tool/result',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { message: { content: [{ type: 'text', text }], isError: !!isError } },
    }),
    title: (seq, title) => ({ type: 'session/title', seq, time: 1_700_000_000_000 + seq, data: { title } }),
    turnStart: (seq) => ({ type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn: 1 } }),
    turnEnd: (seq, kind) => ({ type: 'turn/end', seq, time: 1_700_000_000_000 + seq, data: { reason: { kind } } }),
    commandRun: (seq, commandId, name, args) => ({
        type: 'command/run',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { commandId, name, args, source: { kind: 'user' } },
    }),
    /** ⚠ `command/done` **不带名字**，只能靠 `commandId` 配回 `command/run`。 */
    commandDone: (seq, commandId, kind, text) => ({
        type: 'command/done',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { commandId, kind, text },
    }),
    // ---------------------------------------------------------------- 图片块与 4 条 carrier（2026-12 加）
    /**
     * 一个**图片内容块**（形状照抄真日志：`{type:'image', attachment:{…}}`）。
     *
     * `attachmentId` 是 `sha256:<64 位小写 hex>`（`dsh-attachment-local` 的 `ID_PATTERN`），
     * 也是**唯一**能把会话里的图连回附件库的键。
     *
     * @param {string} attachmentId - `sha256:<hex>`。
     * @param {number} bytes - 日志里声明的字节数。
     * @param {string} [mediaType] - MIME。
     * @param {string} [name] - 原文件名。
     * @returns {Record<string, unknown>} 内容块。
     */
    image: (attachmentId, bytes, mediaType = 'image/png', name = 'x.png') => ({
        type: 'image',
        attachment: { attachmentId, mediaType, bytes, width: 32, height: 32, name },
    }),
    /** 带**任意内容块**的用户消息（用来把图片放进 carrier 1）。 */
    userBlocks: (seq, blocks) => ({
        type: 'user/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { content: blocks, source: { kind: 'user' } },
    }),
    /** 带**任意内容块**的助手消息（carrier 2：`data.message.content[]`）。 */
    assistantBlocks: (seq, blocks) => ({
        type: 'assistant/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { message: { role: 'assistant', content: blocks } },
    }),
    /** `agent/inbox/spliced`（carrier 3：`data.inserted[].content[]`）。 */
    insertedBlocks: (seq, blocks) => ({
        type: 'agent/inbox/spliced',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { inserted: [{ content: blocks }] },
    }),
    /**
     * 流式 chunk（carrier 4：**只有 `block-end` 才算**，`block-start`/`block-delta` 是半成品）。
     *
     * @param {number} seq - 序号。
     * @param {'block-start' | 'block-delta' | 'block-end'} chunkType - chunk 类型。
     * @param {unknown} block - 块。
     * @returns {Record<string, unknown>} 事件。
     */
    chunk: (seq, chunkType, block) => ({
        type: 'assistant/message',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { chunk: { type: chunkType, block } },
    }),
};

/**
 * 把文本切成 n 段（模拟「一次落盘一个帧」的拼接帧容器）。
 *
 * ⚠ **不许把 UTF-16 代理对劈开**（2026-12 修）：`Buffer.from(半个代理对, 'utf8')`
 * 会把它写成 U+FFFD（`\uFFFD`），于是「分帧」这件事本身就制造了一个数据损坏 ——
 * 而 `decodeAll` 拼回来之后看到的是一个**看起来正常但内容变了**的字符，
 * 断言会以一个很难归因的方式失败（真实场景：中文 BMP 外的字，比如 `𠀋`/`🀄`）。
 * 所以每块末尾若是**高代理**（0xD800-0xDBFF）就回退 1 个 code unit，把它挪到下一块开头。
 *
 * （真 DSH 是按**字节**切帧的，而 `decodeAll` 是「先把所有帧拼成 Buffer 再一次性
 *   `toString('utf8')`」—— 所以真实链路天然不会劈开代理对；要小心的只有夹具。）
 *
 * @param {string} text - 待切文本。
 * @param {number} parts - 目标块数（实际块数可能与它不同）。
 * @returns {string[]} 切好的块。
 */
function splitEven(text, parts) {
    const size = Math.ceil(text.length / parts);
    const chunks = [];
    for (let at = 0; at < text.length; at += size) {
        let end = Math.min(text.length, at + size);
        if (end < text.length) {
            const unit = text.charCodeAt(end - 1);
            if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
        }
        chunks.push(text.slice(at, end));
    }
    return chunks.length > 0 ? chunks : [text];
}

/**
 * 写一个会话目录。
 *
 * @param {string} root - 合成 sessions 根。
 * @param {string} project - 工程键。
 * @param {string} dirName - 目录名（**故意允许与 header.id 不同**）。
 * @param {Array<Record<string, unknown>>} events - 事件。
 * @param {{frames?: number, torn?: boolean, ageSeconds?: number, legacy?: Array<Record<string, unknown>>}} [options] - 切成几帧 / 末尾是否留半个帧 / 相对「现在」往回多少秒（决定列表顺序）/ 额外写一份**更旧的格式残留**（`session.v4.jsonl.zstd`）。
 * @returns {string} 会话目录的绝对路径。
 */
function writeSession(root, project, dirName, events, options = {}) {
    const dir = join(root, project, dirName);
    mkdirSync(dir, { recursive: true });
    const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const frames = splitEven(text, options.frames ?? 3).map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')));
    let buffer = Buffer.concat(frames);
    if (options.torn) {
        // 末尾半个帧：真实日志在「正在写 / 崩过」时就是这样，读的时候必须能解多少解多少
        buffer = Buffer.concat([buffer, zstdCompressSync(Buffer.from('{"type":"user/mess', 'utf8')).subarray(0, 14)]);
    }
    const log = join(dir, 'session.jsonl.zstd');
    writeFileSync(log, buffer);
    // ⚠ 修改时间要**显式**写：四个目录是在同一毫秒级里造出来的，靠写入顺序定序是碰运气，
    // 而「列表按最后修改时间倒序」正是这里要验的东西之一。
    const when = (Date.now() - (options.ageSeconds ?? 0) * 1000) / 1000;
    utimesSync(log, when, when);

    if (options.legacy) {
        /**
         * 更旧的格式残留。真实现场（`session-1aba7f97-…`）：两个文件并存，
         * 当前格式 `session.jsonl.zstd`（14381 行）与旧残留 `session.v4.jsonl.zstd`（3090 行），
         * 而**当前格式的版本号是 0**（`SESSION_FORMAT_VERSION = 0`）—— 带 `.vN` 的才是老的。
         *
         * ⚠ 这里把残留的 mtime 故意设成**比当前那份更新**：旧实现按「带 `.v` 优先」挑错了文件，
         * 而「按 mtime 取最新」同样会挑错 —— 这条夹具把两种错法一起钉住。
         */
        const legacyLog = join(dir, 'session.v4.jsonl.zstd');
        const legacyText = `${options.legacy.map((event) => JSON.stringify(event)).join('\n')}\n`;
        writeFileSync(legacyLog, zstdCompressSync(Buffer.from(legacyText, 'utf8')));
        utimesSync(legacyLog, when + 3600, when + 3600);
    }
    return dir;
}

// ---------------------------------------------------------------- 合成语料

const PROJECT = '--D-Project-cocos-jihe_defence--';
const OTHER_PROJECT = '--D-Project-other--';
const CWD = 'D:\\Project\\cocos\\jihe_defence';
const ALPHA_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BETA_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const GAMMA_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

/** 一条「只有标题里有那个词」的会话，用来验「标题也算内容」。 */
const TITLE_ONLY_ID = 'dddddddd-4444-4444-8444-dddddddddddd';

/**
 * 造出整棵语料树。
 *
 * | 目录 | header.id | 最后活动 | 特点 |
 * |---|---|---|---|
 * | `alpha` | ALPHA_ID | 30 秒前 | 有 `session/title`（模型生成的标题）、老形状工具结果、`turn/end: completed` |
 * | `beta` | BETA_ID | 现在（最新） | 没有 `session/title`（标题回退首条用户消息）、斜杠命令、新形状工具结果、图片块、两个回合、`turn/end: aborted`、末尾半个帧 |
 * | `session-gamma` | GAMMA_ID | 20 秒前 | **目录名与 header.id 不一样**（定位要按 header.id 找得到） |
 * | `delta` | TITLE_ONLY_ID | 40 秒前 | 只在 `session/title` 里有那个词 |
 *
 * @param {string} root - 合成 sessions 根。
 */
function buildCorpus(root) {
    writeSession(
        root,
        PROJECT,
        'alpha',
        [
            EV.header(ALPHA_ID, CWD, 1_700_000_000_000),
            EV.turnStart(1),
            EV.user(2, '看一下打击反馈的落地口径'),
            // ⚠ 这段故意写长：片段是**截**出来的，短文本会整段返回、验不出省略号
            EV.assistant(3, `${'（铺垫）'.repeat(20)}本作是浅底图纸风，打击感靠印痕，不做发光。${'（收尾）'.repeat(20)}`, '先读设计文档再回答。'),
            EV.toolCall(4, 'read', '{"file_path":"docs/打击反馈设计.md"}'),
            EV.toolResultOld(5, '档位表 T0~T7 · 顿帧 1s 账本 ≤30ms'),
            EV.turnEnd(6, 'completed'),
            EV.title(7, '打击反馈落地口径'),
        ],
        { frames: 4, ageSeconds: 30 },
    );

    writeSession(
        root,
        PROJECT,
        'beta',
        [
            EV.header(BETA_ID, CWD, 1_700_000_100_000),
            EV.turnStart(1),
            EV.userWithImage(2, '把这张图存成 prefab 参考', 'ref.png'),
            EV.commandRun(3, 'cmd-1', 'compact', ' keep 20'),
            EV.commandDone(4, 'cmd-1', 'success', '已压缩到 18k tokens'),
            EV.assistant(5, '好的。', '先看看这个 prefab 现在长什么样。'),
            EV.toolCall(6, 'grep', '{"pattern":"打击"}'),
            EV.toolResultNew(7, '代码块示例：\n```js\nconst 打击感 = "印痕";\n```\n结束'),
            EV.assistant(8, '围栏要跟着内容加长，别被三引号撕开。'),
            EV.turnEnd(9, 'aborted'),
            // 第二个回合：验「回合之间拉分隔线」
            EV.turnStart(10),
            EV.user(11, '再补一句'),
            EV.assistant(12, '好。'),
            EV.turnEnd(13, 'completed'),
        ],
        { frames: 3, torn: true, ageSeconds: 0,
            // 更旧的格式残留（真实现场里就有）：这份里那句话**绝不该**出现在任何回放/搜索结果里
            legacy: [
                EV.header(BETA_ID, CWD, 1_700_000_100_000),
                EV.user(1, '旧格式残留里才有的一句话，当前那份里没有这句'),
                EV.turnEnd(2, 'completed'),
            ] },
    );

    writeSession(
        root,
        PROJECT,
        `session-${GAMMA_ID}`,
        [
            EV.header(GAMMA_ID, CWD, 1_700_000_050_000),
            EV.turnStart(1),
            EV.user(2, '顿帧会拖慢刷怪节奏吗'),
            EV.assistant(3, '不会：顿帧只缩 ctx.Tick，stage 的 elapsed 走真实 dt。'),
            EV.turnEnd(4, 'completed'),
        ],
        { frames: 2, ageSeconds: 20 },
    );

    writeSession(
        root,
        PROJECT,
        'delta',
        [EV.header(TITLE_ONLY_ID, CWD, 1_700_000_000_000), EV.title(1, '印痕密度衰减公式推导')],
        { frames: 1, ageSeconds: 40 },
    );

    // 另一个工程：**任何命令都不许把它算进来**
    writeSession(root, OTHER_PROJECT, 'other', [EV.header('99999999-9999-4999-8999-999999999999', 'D:\\Project\\other', 1_700_000_000_000), EV.user(1, '打击感 印痕 无关工程的会话')], { ageSeconds: 0 });
}

// ---------------------------------------------------------------- 合成附件库与独立 ZIP 解析器（2026-12 加）

/**
 * 在合成附件库里写一个对象（**真的算 sha256 当文件名**，路径照抄 DSH 的 `objects/<前 2 位>/<64 位>`）。
 *
 * 为什么必须真算：回收那条路会**复算文件字节的 sha256 与 id 比对**，
 * 用假名字的夹具根本走不到那一步（会先被 `hash-mismatch` 挡掉），那种「测了等于没测」最难发现。
 *
 * @param {string} attachmentsRoot - 合成附件库根（`<root>/attachments`）。
 * @param {Buffer | string} content - 对象内容。
 * @param {{hex?: string, ageSeconds?: number}} [options] - 覆盖文件名（造「名字与内容不符」）/ 相对现在的 ageSeconds（默认 2 小时 → 能过 1 小时时间窗）。
 * @returns {{attachmentId: string, hex: string, bytes: number, path: string}} 对象描述。
 */
function putObject(attachmentsRoot, content, options = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hex = options.hex ?? createHash('sha256').update(buffer).digest('hex');
    const dir = join(attachmentsRoot, 'v1', 'objects', hex.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, hex);
    writeFileSync(path, buffer);
    const when = (Date.now() - (options.ageSeconds ?? 7200) * 1000) / 1000;
    utimesSync(path, when, when);
    return { attachmentId: `sha256:${hex}`, hex, bytes: buffer.length, path };
}

/**
 * **独立写的** ZIP 解析器：EOCD → 中央目录 → 逐条 local header → 解压。
 *
 * ⚠ 为什么另写一份、而且**不复用 `scripts/zip.js` 的任何常量与函数**：
 * 拿被验的代码去读被验的代码 = 自己给自己判卷 —— 两边同一个误解会互相抵消
 * （比如都把某个字段的偏移数错、或都漏了 `>>> 0`），而产物在别人的解压器里是坏的。
 * 这里连签名都写成字面量 `PK\x03\x04` / `PK\x01\x02` / `PK\x05\x06`，就是为了让两份实现
 * 唯一的共同点只有 ZIP 规范本身。
 *
 * 顺带把**跨字段的一致性**也验了（这些恰恰是「自己写 ZIP 最容易写错」的地方）：
 * 中央目录与 local header 的 method / CRC / 压缩后大小 / 原始大小**四处必须逐条相等**，
 * 且解出来的长度要等于 usize、**用 node 的 `zlib.crc32` 复算的 CRC 要等于头里的 CRC**。
 *
 * @param {Buffer} buffer - .zip 字节。
 * @returns {Array<{name: string, flags: number, method: number, raw: Buffer, csize: number, usize: number}>} 条目（按中央目录顺序）。
 */
function readZip(buffer) {
    const { strictEqual, ok } = require('node:assert');
    const eocdAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    ok(eocdAt >= 0, '找不到 EOCD（PK\x05\x06）');
    const total = buffer.readUInt16LE(eocdAt + 10);
    const cdSize = buffer.readUInt32LE(eocdAt + 12);
    const cdOffset = buffer.readUInt32LE(eocdAt + 16);
    strictEqual(cdOffset + cdSize, eocdAt, '中央目录必须紧贴 EOCD（不能有缝、也不能有注释挡着）');

    const out = [];
    let at = cdOffset;
    for (let index = 0; index < total; index += 1) {
        strictEqual(buffer.readUInt32LE(at), 0x02014b50, '中央目录头签名（PK\x01\x02）');
        const flags = buffer.readUInt16LE(at + 8);
        const method = buffer.readUInt16LE(at + 10);
        const crc = buffer.readUInt32LE(at + 16);
        const csize = buffer.readUInt32LE(at + 20);
        const usize = buffer.readUInt32LE(at + 24);
        const nameLen = buffer.readUInt16LE(at + 28);
        const extraLen = buffer.readUInt16LE(at + 30);
        const commentLen = buffer.readUInt16LE(at + 32);
        const localAt = buffer.readUInt32LE(at + 42);
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLen);

        strictEqual(buffer.readUInt32LE(localAt), 0x04034b50, `local header 签名（${name}）`);
        strictEqual(buffer.readUInt16LE(localAt + 6) & 0x8, 0, `不该有 data descriptor（${name}）`);
        strictEqual(buffer.readUInt16LE(localAt + 8), method, `method 两处要一致（${name}）`);
        strictEqual(buffer.readUInt32LE(localAt + 14), crc, `CRC 两处要一致（${name}）`);
        strictEqual(buffer.readUInt32LE(localAt + 18), csize, `压缩后大小两处要一致（${name}）`);
        strictEqual(buffer.readUInt32LE(localAt + 22), usize, `原始大小两处要一致（${name}）`);
        strictEqual(buffer.toString('utf8', localAt + 30, localAt + 30 + buffer.readUInt16LE(localAt + 26)), name, `条目名两处要一致（${name}）`);

        const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
        const stored = buffer.subarray(dataAt, dataAt + csize);
        const raw = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
        strictEqual(raw.length, usize, `解出来的长度要等于 usize（${name}）`);
        strictEqual(nodeCrc32(raw), crc, `CRC 复算（拿 node 的实现交叉验）（${name}）`);
        out.push({ name, flags, method, raw, csize, usize });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

// ---------------------------------------------------------------- 树语料（会话索引 + 导出 ZIP）

const TREE_PROJ = '--T-proj--';
const TREE_OTHER = '--T-other--';
const TREE_PARENT_ID = 'parent-1111';
const TREE_CHILD_ID = 'child1-2222';
const TREE_GRAND_ID = 'grand-3333';
const TREE_FORK_ID = 'fork-4444';
const TREE_DUP_ID = 'dup-5555';
const TREE_HOLDER_ID = 'holder-6666';
const TREE_LEGACY_ID = 'legacy-7777';

/**
 * 造一棵**跨工程**的合成会话树 + 一个合成附件库（含一个「库里没有文件」的引用）。
 *
 * | 目录 | 工程 | header 里的关系 | 这张图引用谁 |
 * |---|---|---|---|
 * | `parent` | `--T-proj--` | 根（无 parent） | B（`data.content`）、C（`data.message.content`，**库里没有**） |
 * | `child1` | `--T-other--` | `parentSession`=parent、`origin`=subagent、depth 1 | A（`data.content`）、D（**只有 block-end 的 chunk**）、B（`inserted[].content`） |
 * | `grandchild` | `--T-proj--` | 父=child1、origin=subagent、depth 2 | E |
 * | `forkchild` | `--T-proj--` | 父=parent、**没有 origin**、depth 0 + seedLength → **fork** | F |
 * | `dup-a` / `dup-b` | 两个工程 | 同一个 id | —— |
 * | `holder` | `--T-proj--` | 独立 | B（删 parent 时 B 仍被引用） |
 * | `legacy-dir` | `--T-proj--` | 独立，且盘上**多一份旧格式残留** | —— |
 *
 * ⚠ `child1` 故意放在**另一个工程目录**下：子会话的工程键按它**自己的 `cwd`** 算，
 * 所以「按 parentSession 找子会话」不遍历所有工程目录就会漏掉它。
 *
 * @param {string} base - 临时根（会在里面建 `sessions/` 与 `attachments/`）。
 * @returns {Record<string, unknown>} 路径与对象描述。
 */
function buildTreeCorpus(base) {
    const sessions = join(base, 'sessions');
    const attachments = join(base, 'attachments');
    // `request-images/` 与 `tmp/`：回收那条路**一个都不许碰**，所以先放两个标记文件
    mkdirSync(join(attachments, 'v1', 'request-images'), { recursive: true });
    mkdirSync(join(attachments, 'v1', 'tmp'), { recursive: true });
    writeFileSync(join(attachments, 'v1', 'request-images', 'keep.bin'), 'KEEP');
    writeFileSync(join(attachments, 'v1', 'tmp', 'keep.bin'), 'KEEP');

    const objects = {
        A: putObject(attachments, randomBytes(300)),
        B: putObject(attachments, randomBytes(400)),
        D: putObject(attachments, randomBytes(500)),
        E: putObject(attachments, randomBytes(600)),
        F: putObject(attachments, randomBytes(700)),
    };
    /** 只在日志里存在、库里**没有**物理文件的引用（必须进 `missingMedia`）。 */
    const missingId = `sha256:${'c0'.repeat(32)}`;

    writeSession(sessions, TREE_PROJ, 'parent', [
        EV.header(TREE_PARENT_ID, 'D:\\Project\\proj', 1_700_000_000_000),
        EV.turnStart(1),
        // ⚠ 这里带 **BMP 外的字符**：分帧时若劈开代理对，它们会变成 U+FFFD
        EV.userBlocks(2, [{ type: 'text', text: `根会话：中文与代理对 ${ASTRAL_SAMPLE} 都要逐字节原样` }, EV.image(objects.B.attachmentId, objects.B.bytes)]),
        EV.assistantBlocks(3, [{ type: 'text', text: '收到' }, EV.image(missingId, 1234)]),
        EV.turnEnd(4, 'completed'),
        EV.title(5, '导出与回收的夹具'),
    ], { frames: 3 });

    writeSession(sessions, TREE_OTHER, 'child1', [
        EV.header(TREE_CHILD_ID, 'D:\\Project\\other', 1_700_000_100_000, { parentSession: TREE_PARENT_ID, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' }),
        EV.turnStart(1),
        EV.userBlocks(2, [{ type: 'text', text: '子会话' }, EV.image(objects.A.attachmentId, objects.A.bytes)]),
        // carrier 4：`block-start` **不算**，`block-end` 才算（同一个块在流式 chunk 里会出现好几次）
        EV.chunk(3, 'block-start', EV.image(objects.D.attachmentId, objects.D.bytes)),
        EV.chunk(4, 'block-end', EV.image(objects.D.attachmentId, objects.D.bytes)),
        // carrier 3
        EV.insertedBlocks(5, [EV.image(objects.B.attachmentId, objects.B.bytes)]),
        EV.turnEnd(6, 'completed'),
    ], { frames: 2 });

    writeSession(sessions, TREE_PROJ, 'grandchild', [
        EV.header(TREE_GRAND_ID, 'D:\\Project\\proj', 1_700_000_200_000, { parentSession: TREE_CHILD_ID, origin: 'subagent', delegationDepth: 2 }),
        EV.turnStart(1),
        EV.userBlocks(2, [EV.image(objects.E.attachmentId, objects.E.bytes)]),
        EV.turnEnd(3, 'completed'),
    ], { frames: 1 });

    // fork：有 parentSession + seedLength、depth 0、**没有 origin** —— 真机上那 2 条就是这样
    writeSession(sessions, TREE_PROJ, 'forkchild', [
        EV.header(TREE_FORK_ID, 'D:\\Project\\proj', 1_700_000_300_000, { parentSession: TREE_PARENT_ID, seedLength: 278656, delegationDepth: 0 }),
        EV.turnStart(1),
        EV.userBlocks(2, [EV.image(objects.F.attachmentId, objects.F.bytes)]),
        EV.turnEnd(3, 'completed'),
    ], { frames: 1 });

    writeSession(sessions, TREE_PROJ, 'dup-a', [EV.header(TREE_DUP_ID, 'D:\\Project\\proj', 1_700_000_400_000), EV.user(1, 'dup a')], { frames: 1 });
    writeSession(sessions, TREE_OTHER, 'dup-b', [EV.header(TREE_DUP_ID, 'D:\\Project\\other', 1_700_000_500_000), EV.user(1, 'dup b')], { frames: 1 });

    writeSession(sessions, TREE_PROJ, 'holder', [
        EV.header(TREE_HOLDER_ID, 'D:\\Project\\proj', 1_700_000_600_000),
        EV.userBlocks(1, [EV.image(objects.B.attachmentId, objects.B.bytes)]),
    ], { frames: 1 });

    writeSession(sessions, TREE_PROJ, 'legacy-dir', [
        EV.header(TREE_LEGACY_ID, 'D:\\Project\\proj', 1_700_000_700_000),
        EV.user(1, '当前格式那一份'),
    ], { frames: 1, legacy: [EV.header(TREE_LEGACY_ID, 'D:\\Project\\proj', 1_700_000_700_000), EV.user(1, '旧残留')] });

    return { sessions, attachments, objects, missingId };
}

// ---------------------------------------------------------------- 回收语料（孤儿附件）

const RC_PROJ = '--R-proj--';
const RC_S1 = 's1-aaaa';
const RC_S2 = 's2-bbbb';
const RC_S3 = 's3-cccc';
const RC_S4 = 's4-dddd';

/**
 * 造回收用的合成语料：一个「唯一引用」的附件 + 一个「跨会话共享」的附件 + 四条该被否决的。
 *
 * | 会话 | 引用 |
 * |---|---|
 * | `s1` | U（**只有它引用** → 孤儿）、SH（`s2` 也引用 → 共享，绝不许动） |
 * | `s2` | SH |
 * | `s3` | SZ（日志里的 bytes 写错）、HS（文件名与内容不符）、RC（刚改过）、MI（库里没有文件） |
 * | `s4` | 没有图 |
 *
 * @param {string} base - 临时根。
 * @returns {Record<string, unknown>} 路径与对象描述。
 */
function buildReclaimCorpus(base) {
    const sessions = join(base, 'sessions');
    const attachments = join(base, 'attachments');
    mkdirSync(join(attachments, 'v1', 'request-images'), { recursive: true });
    mkdirSync(join(attachments, 'v1', 'tmp'), { recursive: true });
    writeFileSync(join(attachments, 'v1', 'request-images', 'keep.bin'), 'KEEP');
    writeFileSync(join(attachments, 'v1', 'tmp', 'keep.bin'), 'KEEP');

    const uBytes = randomBytes(128);
    const objects = {
        U: putObject(attachments, uBytes),
        SH: putObject(attachments, randomBytes(256)),
        SZ: putObject(attachments, randomBytes(64)),
        // 名字是「别的东西」的 sha256，内容是 random —— 复算必然对不上
        HS: putObject(attachments, randomBytes(96), { hex: createHash('sha256').update('别的东西').digest('hex') }),
        // 刚改过（时间窗内）
        RC: putObject(attachments, randomBytes(72), { ageSeconds: 0 }),
    };
    /** 只在日志里存在、库里没有文件的引用。 */
    const missingId = `sha256:${'0f'.repeat(32)}`;

    writeSession(sessions, RC_PROJ, 's1', [
        EV.header(RC_S1, 'D:\\R', 1_700_000_000_000),
        EV.userBlocks(1, [EV.image(objects.U.attachmentId, objects.U.bytes)]),
        EV.assistantBlocks(2, [EV.image(objects.SH.attachmentId, objects.SH.bytes)]),
    ], { frames: 1 });
    writeSession(sessions, RC_PROJ, 's2', [
        EV.header(RC_S2, 'D:\\R', 1_700_000_000_000),
        EV.userBlocks(1, [EV.image(objects.SH.attachmentId, objects.SH.bytes)]),
    ], { frames: 1 });
    writeSession(sessions, RC_PROJ, 's3', [
        EV.header(RC_S3, 'D:\\R', 1_700_000_000_000),
        EV.userBlocks(1, [
            // ⚠ 声明的 bytes 故意比实际大 999：回收那条路要**核对大小**，不一致就不许删
            EV.image(objects.SZ.attachmentId, objects.SZ.bytes + 999),
            EV.image(objects.HS.attachmentId, objects.HS.bytes),
            EV.image(objects.RC.attachmentId, objects.RC.bytes),
            EV.image(missingId, 10),
        ]),
    ], { frames: 1 });
    writeSession(sessions, RC_PROJ, 's4', [EV.header(RC_S4, 'D:\\R', 1_700_000_000_000), EV.user(1, '没有图的会话')], { frames: 1 });

    return { sessions, attachments, objects, uBytes, missingId };
}

// ---------------------------------------------------------------- 跑 CLI

/**
 * 跑一次真脚本。
 *
 * @param {string[]} args - 命令与开关。
 * @returns {Record<string, unknown>} 脚本 stdout 上那行 JSON。
 */
function cli(args) {
    const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
    const line = String(out.stdout ?? '').trim().split('\n').pop() ?? '';
    if (!line) throw new Error(`CLI 没有输出（${args.join(' ')}）；stderr：${String(out.stderr ?? '').slice(0, 300)}`);
    try {
        return JSON.parse(line);
    } catch {
        throw new Error(`CLI 的输出不是 JSON（${args.join(' ')}）：${line.slice(0, 200)}`);
    }
}

/** 只读一个会话（走 search 的 `--query` 太绕，这里直接用 read）。 */
function readOf(root, id) {
    return cli(['read', `--root=${root}`, `--project=${PROJECT}`, `--id=${id}`, '--max-events=500']);
}

// ---------------------------------------------------------------- 断言

function main() {
    const root = mkdtempSync(join(tmpdir(), 'dsh-history-'));
    const keep = process.argv.includes('--keep');
    try {
        buildCorpus(root);
        console.log(`合成语料：${root}\n`);

        // ---------------- list
        const listed = cli(['list', `--root=${root}`, `--project=${PROJECT}`, '--limit=10']);
        check('list 只列本工程的会话（另一个工程的没混进来）', listed.ok === true && listed.sessions.length === 4, `${listed.sessions?.length} 条`);
        const byId = Object.fromEntries((listed.sessions ?? []).map((session) => [session.id, session]));
        check('list 的 id 用 header.id 而不是目录名', byId[GAMMA_ID] !== undefined && byId['session-' + GAMMA_ID] === undefined);
        check('list 优先用 session/title 当标题', byId[ALPHA_ID]?.title === '打击反馈落地口径', JSON.stringify(byId[ALPHA_ID]?.title));
        check('list 没有 session/title 时回退首条用户消息', byId[BETA_ID]?.title === '把这张图存成 prefab 参考', JSON.stringify(byId[BETA_ID]?.title));
        check('list 按最后修改时间倒序（最新在前）', (listed.sessions ?? []).map((session) => session.id).join(',') === [BETA_ID, GAMMA_ID, ALPHA_ID, TITLE_ONLY_ID].join(','), (listed.sessions ?? []).map((session) => session.id.slice(0, 4)).join(','));
        check('list 数得出回合数', (byId[GAMMA_ID]?.turns ?? 0) === 1, String(byId[GAMMA_ID]?.turns));

        /**
         * **两个日志文件并存时挑哪一份**（2026-12 修的真 bug，`pickLogFile`）。
         *
         * 真实现场：`session-1aba7f97-…` 里当前格式 `session.jsonl.zstd`（14381 行）与旧残留
         * `session.v4.jsonl.zstd`（3090 行）并存，而**当前格式的版本号是 0**
         * （`SESSION_FORMAT_VERSION = 0`）—— 带 `.vN` 的是老的。旧实现按「带 `.v` 优先」挑，
         * 于是面板对这条会话只显示 1/5 的内容，标题、搜索、导出**全部基于过期快照**。
         *
         * 夹具把残留的 mtime 设成**更新**，所以「按 mtime 取最新」这条错路也一起被钉住。
         */
        const betaLog = join(root, PROJECT, 'beta', 'session.jsonl.zstd');
        check(
            '两个日志并存时挑**当前格式**（`session.jsonl.zstd`），不看 mtime',
            byId[BETA_ID]?.file === betaLog && byId[BETA_ID]?.bytes === statSync(betaLog).size,
            `挑了 ${byId[BETA_ID]?.file}（${byId[BETA_ID]?.bytes} 字节）`,
        );
        check(
            '被忽略的旧残留如实带出来（面板要说一句「盘上还有一份更旧的」）',
            (byId[BETA_ID]?.ignoredLegacy ?? []).join(',') === 'session.v4.jsonl.zstd',
            JSON.stringify(byId[BETA_ID]?.ignoredLegacy),
        );

        // ---------------- read（含半个尾帧的容错）
        const beta = readOf(root, BETA_ID);
        check('read 能读回事件（末尾半个帧不影响）', beta.ok === true && beta.events.length > 0, `${beta.events?.length} 条`);
        check('read 只保留回放用得到的事件（chunk 之类不进）', beta.events.every((event) => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end', 'command/run', 'command/done', 'session/title', 'session', 'turn/start'].includes(event.type)));
        const gamma = readOf(root, GAMMA_ID);
        check('read 也认「目录名 ≠ header.id」（按 header.id 能定位）', gamma.ok === true && gamma.events.length > 0, gamma.error ?? '');
        check(
            'read 读的是**当前格式那一份**（旧残留里的独有句子不在回放里）',
            !JSON.stringify(beta.events).includes('旧格式残留里才有的一句话'),
            '读到了旧残留 —— 挑选口径又反了',
        );

        // ---------------- search
        const hit1 = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打击感']);
        check('search 命中（中文按字面子串，不受分词器限制）', hit1.ok === true && hit1.hits.length >= 1, `命中 ${hit1.hits?.length}`);
        check('search 不跨工程', hit1.hits.every((hit) => hit.id !== '99999999-9999-4999-8999-999999999999'));
        const alphaHit = hit1.hits.find((hit) => hit.id === ALPHA_ID);
        check('search 命中的是**投影后的文本**（思考/回答/工具结果里的都算）', alphaHit !== undefined);
        check('search 给片段且片段里有那个词', alphaHit ? alphaHit.snippets.some((snippet) => snippet.snippet.includes('打击感')) : false, JSON.stringify(alphaHit?.snippets?.[0]?.snippet?.slice(0, 60)));
        check('search 的片段带省略号（是截出来的，不是整段）', alphaHit ? alphaHit.snippets.some((snippet) => snippet.snippet.startsWith('…') || snippet.snippet.endsWith('…')) : false);
        check('search 报得出命中标签（知道那句话是谁说的）', alphaHit ? typeof alphaHit.snippets[0].label === 'string' && alphaHit.snippets[0].label.length > 0 : false, alphaHit?.snippets?.[0]?.label);
        check('search 报得出**覆盖率**', typeof hit1.scanned === 'number' && typeof hit1.available === 'number' && hit1.available === 4, `扫 ${hit1.scanned}/${hit1.available}`);
        check('search 扫完整个工程时 partial 为 false（不谎报截断）', hit1.partial === false && hit1.stoppedBy === null, String(hit1.stoppedBy));
        check('search 的 seq 指向命中的那条事件（回放后能跳过去）', typeof alphaHit?.seq === 'number' && alphaHit.seq > 0, String(alphaHit?.seq));

        const limited = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打击感', '--limit=1']);
        check('search 到 limit 就收工，并如实说 partial', limited.hits.length === 1 && limited.partial === true && limited.stoppedBy === 'limit', `${limited.hits.length} 条 / ${limited.stoppedBy}`);
        check('search 收工之后 scanned 小于全量（确实没扫完）', limited.scanned < limited.available, `扫 ${limited.scanned}/${limited.available}`);

        const andSearch = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打击感 刷怪']);
        check('search 多词是 AND（两个词不在同一个会话里就不算命中）', andSearch.hits.length === 0, `命中 ${andSearch.hits.length}`);
        const andSearch2 = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打击感 印痕']);
        check('search 多词 AND：同一个会话里都有就命中', andSearch2.hits.length >= 1, `命中 ${andSearch2.hits.length}`);

        const caseSearch = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=CTX.TICK']);
        check('search 大小写不敏感（查询里带大写也命中）', caseSearch.hits.some((hit) => hit.id === GAMMA_ID), `命中 ${caseSearch.hits.length}`);
        const titleSearch = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=密度衰减']);
        check('search 也搜标题（只有标题里有也能找到）', titleSearch.hits.some((hit) => hit.id === TITLE_ONLY_ID), `命中 ${titleSearch.hits.length}`);
        const toolSearch = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打印 不存在的东西']);
        check('search 搜不到就返回空列表而不是报错', toolSearch.ok === true && toolSearch.hits.length === 0);
        const noQuery = cli(['search', `--root=${root}`, `--project=${PROJECT}`]);
        check('search 缺 --query 报错', noQuery.ok === false && String(noQuery.error).includes('--query'), String(noQuery.error));
        const weird = cli(['search', `--root=${root}`, `--project=${PROJECT}`, '--query=打击"感']);
        check('search 的词里带引号也不会崩（预筛绕开、仍然走投影匹配）', weird.ok === true);

        // ---------------- export
        const exported = cli(['export', `--root=${root}`, `--project=${PROJECT}`, `--id=${BETA_ID}`, '--format=md']);
        check('export 写出了文件', exported.ok === true && existsSync(exported.path), String(exported.path));
        check('export 落在 <sessions 的上一级>/exports/<工程键>/', resolve(exported.dir) === resolve(join(root, '..', 'exports', PROJECT)), exported.dir);
        check('export 的文件名带标题（汉字留着）', /compact|图/.test(String(exported.path)) || String(exported.path).includes(String(exported.id).slice(0, 8)), exported.path);
        const md = readFileSync(exported.path, 'utf8');
        check('md 有标题与元信息（会话 id / 工程 / 时间）', md.startsWith('# ') && md.includes(BETA_ID) && md.includes(CWD));
        check('md 有「你」「我」两栏', md.includes('## 你') && md.includes('## 我'));
        check('md 把思考块单独标出来', md.includes('## 我（思考）'));
        check('md 工具卡片带名字与参数围栏', md.includes('### 工具 `grep`') && md.includes('{"pattern":"打击"}'));
        check('md 认新形状的 tool/result（内容**不在**里层）', md.includes('const 打击感 = "印痕"'));
        check('md 的围栏跟着内容加长（内容里有三引号也不撕开）', md.includes('````'), md.includes('````') ? '' : '没找到四引号围栏');
        check('md 命令结果从配对的 command/run 里取回了名字', md.includes('命令 `/compact`') && md.includes('已压缩到 18k tokens'), '');
        check('md 标出被中断的那一轮', md.includes('本轮结束：aborted'));
        check('md 里图片只有引用信息（不假装带了像素）', md.includes('ref.png') && md.includes('64×32'));
        check('md 每个回合之间拉分隔线', (md.match(/^---$/gm) ?? []).length >= 1);
        check('export 回执里有体积与条数', exported.bytes > 0 && exported.events > 0 && exported.title.length > 0, `${exported.bytes} 字节 / ${exported.events} 条 / ${exported.title}`);

        const jsonl = cli(['export', `--root=${root}`, `--project=${PROJECT}`, `--id=${BETA_ID}`, '--format=jsonl']);
        const raw = readFileSync(jsonl.path, 'utf8').trim().split('\n');
        const rawTypes = new Set(raw.map((line) => JSON.parse(line).type));
        check('jsonl 是**原样**的（连回放用不到的 turn/start 都在）', rawTypes.has('turn/start') && rawTypes.has('command/run'));
        check('jsonl 一条事件一行、行数对得上', raw.length === raw.filter((line) => line.trim()).length && raw.length >= 10, `${raw.length} 行`);

        const exportedGamma = cli(['export', `--root=${root}`, `--project=${PROJECT}`, `--id=${GAMMA_ID}`]);
        check('export 也认「目录名 ≠ header.id」', exportedGamma.ok === true, exportedGamma.error ?? '');
        const missing = cli(['export', `--root=${root}`, `--project=${PROJECT}`, `--id=nope`]);
        check('export 找不到会话时给的是人话', missing.ok === false && String(missing.error).includes('找不到会话'), String(missing.error));

        // ---------------- delete
        const dry = cli(['delete', `--root=${root}`, `--project=${PROJECT}`, `--id=${ALPHA_ID}`, '--dry-run']);
        check('delete --dry-run 报出清单与体积', dry.ok === true && dry.fileCount === 1 && dry.bytes > 0, `${dry.fileCount} 个文件 / ${dry.bytes} 字节`);
        check('delete --dry-run **没有**动盘', existsSync(join(root, PROJECT, 'alpha')) && dry.removed === false);

        for (const [label, id] of [
            ['..', '..'],
            ['../..', '../..'],
            ['带分隔符的路径', 'alpha/../delta'],
            ['反斜杠路径', '..\\..\\x'],
        ]) {
            const rejected = cli(['delete', `--root=${root}`, `--project=${PROJECT}`, `--id=${id}`]);
            check(`delete 拒绝「${label}」`, rejected.ok === false && String(rejected.error).includes('不合法'), String(rejected.error).slice(0, 80));
        }
        const noId = cli(['delete', `--root=${root}`, `--project=${PROJECT}`]);
        check('delete 缺 --id 报错', noId.ok === false && String(noId.error).includes('--id'), String(noId.error));
        check('越界尝试之后盘上什么都没少', readdirSync(join(root, PROJECT)).length === 4, readdirSync(join(root, PROJECT)).join(','));

        const bad = cli(['delete', `--root=${root}`, `--project=${PROJECT}`, '--id=nope']);
        check('delete 找不到会话时报错（不会当成「删了个空的」）', bad.ok === false && String(bad.error).includes('找不到会话'));

        const removed = cli(['delete', `--root=${root}`, `--project=${PROJECT}`, `--id=${ALPHA_ID}`]);
        check('delete 真删了目标会话', removed.ok === true && removed.removed === true && !existsSync(join(root, PROJECT, 'alpha')), removed.error ?? '');
        check('delete 只删目标（别的会话都在）', ['beta', `session-${GAMMA_ID}`, 'delta'].every((name) => existsSync(join(root, PROJECT, name))));
        check('delete 不碰别的工程', existsSync(join(root, OTHER_PROJECT, 'other')));
        const listedAfter = cli(['list', `--root=${root}`, `--project=${PROJECT}`, '--limit=10']);
        check('删完之后 list 少了一条', listedAfter.sessions.length === 3, `${listedAfter.sessions.length} 条`);

        // ---------------- 与 TS 侧的契约（改了一边没改另一边，这里就红）
        const historyTs = readFileSync(join(EXT_ROOT, 'source', 'history.ts'), 'utf8');
        for (const needle of ["'search'", "'export'", "'delete'", "'--per-session'", "'--max-sessions'", "'--budget-ms'", "'--format'", "'--dry-run'"]) {
            check(`history.ts 发得出 ${needle}`, historyTs.includes(needle));
        }
        const constantsTs = readFileSync(join(EXT_ROOT, 'source', 'constants.ts'), 'utf8');
        for (const needle of ['historySearch', 'historyExport', 'historyDelete']) {
            check(`constants.ts 有 ${needle} 这条消息名`, constantsTs.includes(needle));
        }
        const pkg = JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8'));
        for (const name of ['history-search', 'history-export', 'history-delete']) {
            check(`package.json 注册了 ${name}`, pkg.contributions.messages[name] !== undefined);
        }

        console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
        if (!keep) rmSync(root, { recursive: true, force: true });
        else console.log(`（--keep）合成语料留在：${root}`);
    } catch (error) {
        console.error(`[verify-history] 异常：${error instanceof Error ? error.stack : error}`);
        failures += 1;
        if (!keep) rmSync(root, { recursive: true, force: true });
    }
    process.exitCode = failures === 0 ? 0 : 1;
}

main();

// ---------------------------------------------------------------------- 直接调用段（`require`，不 spawn）

/**
 * 同一批判据的**可用版本**：`require` 被测脚本直接调，全程不 spawn。
 *
 * 除了把 CLI 段跑不了的判据补回来，这里还多覆盖三件 CLI 覆盖不到的事（见文件头第二段）：
 * 会话索引、导出 ZIP（用独立解析器读回产物）、孤儿附件回收。
 *
 * ⚠ 所有写入都在 `os.tmpdir()` 下新开的临时目录里，**不读也不写** `<DSH_HOME>`。
 *
 * @returns {void}
 */
function directChecks() {
    let total = 0;
    let failed = 0;
    const dcheck = (label, ok, detail = '') => {
        total += 1;
        if (!ok) failed += 1;
        check(label, ok, detail);
    };

    const base = mkdtempSync(join(tmpdir(), 'dsh-direct-'));
    const keep = process.argv.includes('--keep');
    console.log('\n直接调用段（不 spawn）：合成语料 %s', base);
    try {
        // ============================================================ 1. zip.js 通用行为
        const crcVector = Buffer.from('123456789');
        dcheck('zip.js 的 CRC32 与标准测试向量一致', crc32(crcVector) === 0xcbf43926, `0x${crc32(crcVector).toString(16)}`);
        dcheck(
            'zip.js 的 CRC32 与 node 的 zlib.crc32 交叉验证一致（两条独立实现）',
            [0, 1, 7, 1000, 65536].every((size) => {
                const buffer = randomBytes(size);
                return crc32(buffer) === nodeCrc32(buffer);
            }),
        );
        const zipRoundTrip = writeZip(
            [
                { path: 'session.jsonl', text: '{"a":1}\n中文 \u{20000}\u{1F004}\n' },
                { path: 'subagents/x/session.jsonl', text: 'x'.repeat(5000) },
                { path: 'media/ab.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), method: 'store' },
                { path: 'manifest.json', text: '{"version":1}' },
            ],
            { mtime: Date.UTC(2026, 0, 2, 3, 4, 6) },
        );
        const parsed = readZip(zipRoundTrip);
        const wanted = [
            { path: 'session.jsonl', text: '{"a":1}\n中文 \u{20000}\u{1F004}\n' },
            { path: 'subagents/x/session.jsonl', text: 'x'.repeat(5000) },
            { path: 'media/ab.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), method: 'store' },
            { path: 'manifest.json', text: '{"version":1}' },
        ];
        dcheck('writeZip 往返：条目顺序与名字逐条一致', parsed.map((entry) => entry.name).join(',') === wanted.map((entry) => entry.path).join(','), parsed.map((entry) => entry.name).join(','));
        dcheck('writeZip 往返：内容逐字节一致', parsed.every((entry, index) => entry.raw.equals(Buffer.from(wanted[index].text ?? wanted[index].data))));
        dcheck('writeZip 置了 UTF-8 位（bit 11）', parsed.every((entry) => (entry.flags & 0x800) !== 0));
        dcheck('writeZip 对重复文本用 deflate，对显式 store 的条目用 store', parsed[1].method === 8 && parsed[2].method === 0, `${parsed[1].method} / ${parsed[2].method}`);
        const incompressible = randomBytes(3000);
        const storedZip = readZip(writeZip([{ path: 'r.bin', data: incompressible }]));
        dcheck('writeZip 压不动就退成 store（PNG/JPEG 那种）', storedZip[0].method === 0 && storedZip[0].raw.equals(incompressible));
        dcheck(
            'writeZip 拒绝 Zip Slip 式的条目名（解压侧任意写）',
            ['/abs.txt', 'a\\b.txt', '../x.txt', 'a/../b.txt', 'C:/x.txt', 'a//b.txt', '', 'a/'].every((bad) => {
                try {
                    writeZip([{ path: bad, text: 'x' }]);
                    return false;
                } catch {
                    return true;
                }
            }),
        );

        // ============================================================ 2. 会话索引
        const tree = buildTreeCorpus(join(base, 'tree'));
        const index = S.buildSessionIndex(tree.sessions);
        dcheck('buildSessionIndex 扫到所有工程目录的所有会话', index.entries.length === 8, `${index.entries.length} 条 / ${index.scanned.projects} 个工程 / ${index.scanned.elapsedMs} ms`);
        dcheck('索引每条都带 projectKey / dir / log / mtimeMs', index.entries.every((entry) => entry.projectKey && entry.dir && entry.log && typeof entry.mtimeMs === 'number'));
        dcheck('同一 id 出现在两个工程 → 进 duplicates（不静默取第一个）', index.duplicates.length === 1 && index.duplicates[0].id === TREE_DUP_ID && index.duplicates[0].entries.length === 2);
        dcheck('重复 id **不在** byId 里', !index.byId.has(TREE_DUP_ID));
        dcheck(
            'resolveInIndex 对重复 id 指名道姓报错（两条路径都写在消息里）',
            (() => {
                try {
                    S.resolveInIndex(index, TREE_DUP_ID);
                    return false;
                } catch (error) {
                    return error.message.includes('dup-a') && error.message.includes('dup-b') && error.message.includes('2 处');
                }
            })(),
        );
        dcheck('子会话的 cwd 属于别的工程也能反查到', index.byId.get(TREE_CHILD_ID)?.projectKey === TREE_OTHER, String(index.byId.get(TREE_CHILD_ID)?.projectKey));
        dcheck('索引带出 header 的 parentSession / origin / delegationDepth / seedLength', index.byId.get(TREE_CHILD_ID)?.origin === 'subagent' && index.byId.get(TREE_GRAND_ID)?.delegationDepth === 2 && index.byId.get(TREE_FORK_ID)?.seedLength === 278656);
        dcheck('isSubagentEntry：有父但没有 origin 的是 fork 而不是 subagent', S.isSubagentEntry(index.byId.get(TREE_CHILD_ID)) === true && S.isSubagentEntry(index.byId.get(TREE_FORK_ID)) === false);
        const walked = S.descendantsOf(index, TREE_PARENT_ID);
        dcheck('descendantsOf 是 DFS 前序（child1 → grandchild → forkchild）', walked.descendants.map((row) => row.entry.id).join(',') === [TREE_CHILD_ID, TREE_GRAND_ID, TREE_FORK_ID].join(','), walked.descendants.map((row) => `${row.entry.id}@${row.depth}`).join(','));
        dcheck('子孙的 depth 按层级递增', walked.descendants.map((row) => row.depth).join(',') === '1,2,1');
        dcheck('fork 也算子孙（口径照抄 DSH）', walked.descendants.some((row) => row.entry.id === TREE_FORK_ID));
        const legacyPick = S.pickLogFile(join(tree.sessions, TREE_PROJ, 'legacy-dir'));
        dcheck(
            'pickLogFile 直接调用：优先当前格式（session.jsonl.zstd），不看 mtime',
            legacyPick.log.endsWith('session.jsonl.zstd') && legacyPick.ignoredLegacy.join(',') === 'session.v4.jsonl.zstd',
            `${legacyPick.log} / ${JSON.stringify(legacyPick.ignoredLegacy)}`,
        );

        // ============================================================ 3. 解码 / 稳定读 / 代理对
        const parentLog = join(tree.sessions, TREE_PROJ, 'parent', 'session.jsonl.zstd');
        const parentText = S.decodeAll(readFileSync(parentLog)).text;
        dcheck('多帧拼接解回来之后 BMP 外的字符没被 U+FFFD 顶掉', parentText.includes(ASTRAL_SAMPLE) && !parentText.includes('\uFFFD'), `含样本=${parentText.includes(ASTRAL_SAMPLE)} 含 U+FFFD=${parentText.includes('\uFFFD')}`);
        dcheck('stableRead 在没人写的时候是稳定的', S.stableRead(parentLog).stable === true);
        dcheck('readHeader 只读前缀也能拿到 header（含 parentSession 等字段）', S.readHeader(join(tree.sessions, TREE_OTHER, 'child1', 'session.jsonl.zstd'))?.parentSession === TREE_PARENT_ID);

        // ============================================================ 4. 导出 ZIP
        const exported = S.exportSession(tree.sessions, TREE_PROJ, TREE_PARENT_ID, { format: 'zip' });
        dcheck('export --format=zip 写出文件', exported.ok === true && existsSync(exported.path), String(exported.path));
        dcheck('文件名对齐 DSH：dsh-session-<safeId>.zip', exported.path.endsWith(`dsh-session-${TREE_PARENT_ID}.zip`), exported.path);
        dcheck('落在 <sessions 上一级>/exports/<工程键>/', exported.dir === join(base, 'tree', 'exports', TREE_PROJ), exported.dir);
        dcheck('zip 默认带上子孙与媒体（对齐 DSH 的布局）', exported.subagents.total === 3 && exported.media.count === 5, `子孙 ${exported.subagents.total} / 媒体 ${exported.media.count}`);
        dcheck('回执**分开**报 subagent 与 fork 的条数（不混成一句）', exported.subagents.subagentCount === 2 && exported.subagents.forkCount === 1, `subagent ${exported.subagents.subagentCount} / fork ${exported.subagents.forkCount}`);
        dcheck('附件缺失如实报（missingMedia 里就有那个库里没有的）', exported.missingMedia.length === 1 && exported.missingMedia[0].attachmentId === tree.missingId && exported.missingMedia[0].reason === 'missing', JSON.stringify(exported.missingMedia.map((row) => row.reason)));
        dcheck('「当前活跃会话可能少最后几条」写进了回执', exported.notes.some((note) => note.includes('当前活跃会话可能少最后几条')));
        dcheck('media 回执里写明「有意偏离 DSH」（media/<hex>.<ext> 去掉 sha256: 前缀）', String(exported.media.namingDeviation).includes('sha256:'));

        const zipEntries = readZip(readFileSync(exported.path));
        const names = zipEntries.map((entry) => entry.name);
        dcheck(
            'ZIP 顺序：session.jsonl → subagents… → media… → manifest.json',
            names[0] === 'session.jsonl' && names[names.length - 1] === 'manifest.json' && names.slice(1, -1).every((name) => name.startsWith('subagents/') || name.startsWith('media/')),
            names.join(' | '),
        );
        dcheck('根会话是**解压后的明文逐字节原样**（含代理对）', zipEntries[0].raw.equals(Buffer.from(parentText, 'utf8')) && zipEntries[0].raw.toString('utf8').includes(ASTRAL_SAMPLE), `${zipEntries[0].raw.length} 字节`);
        dcheck('子会话路径用 safeId 且按 DFS 前序', names.slice(1, 4).join(',') === [`subagents/${TREE_CHILD_ID}/session.jsonl`, `subagents/${TREE_GRAND_ID}/session.jsonl`, `subagents/${TREE_FORK_ID}/session.jsonl`].join(','), names.slice(1, 4).join(','));
        dcheck('media/ 条目名去掉了 sha256: 前缀（Windows 文件名不许有冒号）', names.filter((name) => name.startsWith('media/')).every((name) => /^media\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/.test(name)), names.find((name) => name.startsWith('media/')));
        dcheck('媒体用 store（像素不重复压）', zipEntries.filter((entry) => entry.name.startsWith('media/')).every((entry) => entry.method === 0));
        dcheck(
            '媒体像素与附件库里的文件逐字节一致（不是重新编码过的）',
            Object.values(tree.objects).every((object) => {
                const row = exported.media.entries.find((item) => item.attachmentId === object.attachmentId);
                return row !== undefined && zipEntries.find((entry) => entry.name === row.path).raw.equals(readFileSync(object.path));
            }),
        );
        const manifest = JSON.parse(zipEntries[names.length - 1].raw.toString('utf8'));
        dcheck('manifest 的 root 字段齐全（含 depth 0 / path / parentSession / origin）', manifest.version === 1 && manifest.root.id === TREE_PARENT_ID && manifest.root.depth === 0 && manifest.root.path === 'session.jsonl' && manifest.root.parentSession === null && manifest.root.origin === null && typeof manifest.exportedAt === 'string', JSON.stringify(manifest.root));
        dcheck('manifest.sessions 只列子孙、depth 是导出层级', manifest.sessions.length === 3 && manifest.sessions[0].id === TREE_CHILD_ID && manifest.sessions[0].depth === 1 && manifest.sessions[1].depth === 2, JSON.stringify(manifest.sessions.map((row) => `${row.id}@${row.depth}`)));
        dcheck('manifest.sessions 里 fork 的 origin 如实为 null（不替它编一个 fork）', manifest.sessions.find((row) => row.id === TREE_FORK_ID).origin === null);
        dcheck('manifest.media 给出 attachmentId ↔ path 的映射（保留 sha256: 前缀）', manifest.media.length === 5 && manifest.media.every((row) => row.attachmentId.startsWith('sha256:') && row.path.startsWith('media/')) && manifest.media.find((row) => row.attachmentId === tree.objects.A.attachmentId).bytes === tree.objects.A.bytes);
        dcheck('manifest 里的 media path 与 zip 条目名逐个对得上', manifest.media.every((row) => names.includes(row.path)));

        const plainMd = S.exportSession(tree.sessions, TREE_PROJ, TREE_PARENT_ID, { format: 'md' });
        dcheck(
            '不带新旗标时 md 回执**仍然是那 9 个老键**（history.ts 那条老路不许崩）',
            ['ok', 'id', 'title', 'format', 'path', 'dir', 'bytes', 'events', 'turns'].every((key) => key in plainMd) && !('subagents' in plainMd) && !('media' in plainMd) && !('notes' in plainMd),
            Object.keys(plainMd).join(','),
        );
        const plainJsonl = S.exportSession(tree.sessions, TREE_PROJ, TREE_PARENT_ID, { format: 'jsonl' });
        dcheck('jsonl 仍是原样行数（每行都能 JSON.parse）', plainJsonl.events > 3 && readFileSync(plainJsonl.path, 'utf8').trim().split('\n').every((line) => JSON.parse(line)));
        const scopedMd = S.exportSession(tree.sessions, TREE_PROJ, TREE_PARENT_ID, { format: 'md', withSubagents: true, withMedia: true, attachments: tree.attachments });
        dcheck('md + 两个旗标：额外报出子孙与媒体清单（并说像素不在这份里）', scopedMd.subagents.total === 3 && scopedMd.media.count === 5 && scopedMd.missingMedia.length === 1 && String(scopedMd.notes).includes('--format=zip'), JSON.stringify({ s: scopedMd.subagents?.total, m: scopedMd.media?.count }));

        // ============================================================ 5. 孤儿附件回收
        const rc = buildReclaimCorpus(join(base, 'reclaim'));
        const carriers = S.collectImageRefs([
            EV.userBlocks(1, [EV.image(tree.objects.A.attachmentId, tree.objects.A.bytes)]),
            EV.assistantBlocks(2, [EV.image(tree.objects.B.attachmentId, tree.objects.B.bytes)]),
            EV.insertedBlocks(3, [EV.image(tree.objects.D.attachmentId, tree.objects.D.bytes)]),
            EV.chunk(4, 'block-end', EV.image(tree.objects.E.attachmentId, tree.objects.E.bytes)),
            EV.chunk(5, 'block-start', EV.image(tree.objects.F.attachmentId, tree.objects.F.bytes)),
        ]);
        dcheck('collectImageRefs 认 4 条 carrier，且 chunk 只认 block-end', carriers.refs.size === 4 && !carriers.refs.has(tree.objects.F.attachmentId), `${carriers.refs.size} 个`);
        dcheck('collectImageRefs 去重后计数（同一个附件被引用多次只算一条）', S.collectImageRefs([EV.userBlocks(1, [EV.image(tree.objects.A.attachmentId, 1), EV.image(tree.objects.A.attachmentId, 1)])]).refs.get(tree.objects.A.attachmentId).count === 2);
        dcheck('没有 id 的图片块如实计数（withoutId）', S.collectImageRefs([EV.userBlocks(1, [{ type: 'image', attachment: { name: 'x.png' } }])]).withoutId === 1);

        const dry = S.reclaimAttachments(rc.sessions, RC_PROJ, RC_S1, { dryRun: true, attachments: rc.attachments });
        dcheck('dry-run：候选 2 个、孤儿 1 个（共享的那个被排除）', dry.candidates === 2 && dry.orphans === 1 && dry.trashed === 0, JSON.stringify({ c: dry.candidates, o: dry.orphans, t: dry.trashed }));
        dcheck('dry-run：孤儿就是「只有它引用」的那一个', dry.orphanList.map((row) => row.attachmentId).join(',') === rc.objects.U.attachmentId);
        dcheck('dry-run：共享的那个被标成 still-referenced', dry.skipped.some((row) => row.attachmentId === rc.objects.SH.attachmentId && row.reason === 'still-referenced'));
        dcheck('dry-run：清单里的目标路径就在墓碑目录下、moved=false', dry.trashList[0].to.startsWith(join(rc.attachments, 'v1', '.trash-')) && dry.trashList[0].moved === false, dry.trashList[0].to);
        dcheck('dry-run：一个字节都没动（两个对象都还在原地）', existsSync(rc.objects.U.path) && existsSync(rc.objects.SH.path));
        dcheck('dry-run：连墓碑目录都没建出来', !existsSync(dry.trashDir), dry.trashDir);
        dcheck('回收回执字段齐全（面板能原样显示）', ['scanned', 'candidates', 'referenced', 'orphans', 'trashed', 'bytesFreed', 'incomplete', 'errors'].every((key) => key in dry));
        dcheck('回收回执的 scanned 是**全库扫描**的口径', typeof dry.scanned.sessions === 'number' && typeof dry.scanned.bytes === 'number' && typeof dry.scanned.elapsedMs === 'number', JSON.stringify(dry.scanned));

        const partial = S.reclaimAttachments(rc.sessions, RC_PROJ, RC_S1, { dryRun: true, attachments: rc.attachments, maxSessions: 1 });
        dcheck('全库扫描超预算 → incomplete=true 且一条都不删（fail-closed）', partial.incomplete === true && partial.orphans === 0 && partial.trashed === 0, `stoppedBy=${partial.stoppedBy}`);
        dcheck('incomplete 时清单为空、原因如实说', partial.incompleteReason !== null && partial.skipped.every((row) => row.reason === 'scan-incomplete'), String(partial.incompleteReason));
        dcheck('incomplete 之后对象也还在原地', existsSync(rc.objects.U.path) && existsSync(rc.objects.SH.path));

        const delDry = S.deleteSession(rc.sessions, RC_PROJ, RC_S2, { dryRun: true, reclaimAttachments: true, attachments: rc.attachments });
        dcheck('delete --reclaim-attachments --dry-run：回执带 reclaim、会话目录没被动、也没搬东西', delDry.reclaim !== undefined && delDry.removed === false && delDry.reclaim.trashed === 0 && existsSync(join(rc.sessions, RC_PROJ, 's2')), JSON.stringify({ c: delDry.reclaim?.candidates }));

        const real = S.reclaimAttachments(rc.sessions, RC_PROJ, RC_S1, { attachments: rc.attachments });
        dcheck('真跑：只搬走那一个孤儿', real.trashed === 1 && real.bytesFreed === rc.objects.U.bytes, JSON.stringify({ t: real.trashed, b: real.bytesFreed }));
        dcheck('真跑：孤儿不在原地了、而**共享的那个还在原地**', !existsSync(rc.objects.U.path) && existsSync(rc.objects.SH.path));
        const tomb = join(real.trashDir, rc.objects.U.hex.slice(0, 2), rc.objects.U.hex);
        dcheck('真跑：墓碑路径 = .trash-<yyyyMMdd>/<hex 前 2 位>/<hex>', /\.trash-\d{8}$/.test(real.trashDir) && existsSync(tomb), real.trashDir);
        dcheck('真跑：墓碑里的内容与原文件逐字节一致（是搬不是改）', readFileSync(tomb).equals(rc.uBytes));

        const guarded = S.reclaimAttachments(rc.sessions, RC_PROJ, RC_S3, { attachments: rc.attachments });
        const reasons = Object.fromEntries(guarded.skipped.map((row) => [row.attachmentId, row.reason]));
        dcheck('交叉验证：四条否决一个都不搬', guarded.trashed === 0 && guarded.orphans === 0, JSON.stringify({ t: guarded.trashed, o: guarded.orphans }));
        dcheck(
            '四条否决理由各自到位（bytes 不符 / sha256 不符 / 刚改过 / 文件不在）',
            reasons[rc.objects.SZ.attachmentId] === 'size-mismatch' && reasons[rc.objects.HS.attachmentId] === 'hash-mismatch' && reasons[rc.objects.RC.attachmentId] === 'recent' && reasons[rc.missingId] === 'missing',
            JSON.stringify(reasons),
        );
        const sizeMismatch = guarded.skipped.find((row) => row.reason === 'size-mismatch');
        dcheck('大小不符时**两边的数字都报出来**（面板要看得出差在哪）', Array.isArray(sizeMismatch.sizeClaimed) && sizeMismatch.sizeClaimed[0] === rc.objects.SZ.bytes + 999 && sizeMismatch.sizeActual === rc.objects.SZ.bytes, JSON.stringify(sizeMismatch));
        dcheck('交叉验证：被否决的那三个对象还在原地', existsSync(rc.objects.SZ.path) && existsSync(rc.objects.HS.path) && existsSync(rc.objects.RC.path));
        dcheck('ENOENT 当成功：missing 不进 errors', guarded.errors.length === 0, JSON.stringify(guarded.errors));
        dcheck('不碰 request-images/ 与 tmp/', existsSync(join(rc.attachments, 'v1', 'request-images', 'keep.bin')) && existsSync(join(rc.attachments, 'v1', 'tmp', 'keep.bin')) && existsSync(join(tree.attachments, 'v1', 'request-images', 'keep.bin')));
        dcheck('不碰 objects/ 与分桶目录本身', readdirSync(join(rc.attachments, 'v1', 'objects')).every((name) => statSync(join(rc.attachments, 'v1', 'objects', name)).isDirectory()));
        dcheck('墓碑目录与 objects/ 是兄弟（同盘 → rename 而不是复制）', resolve(real.trashDir) === resolve(join(rc.attachments, 'v1', `.trash-${real.trashDir.slice(real.trashDir.lastIndexOf('.trash-') + 7)}`)));

        const del = S.deleteSession(rc.sessions, RC_PROJ, RC_S4, { attachments: rc.attachments });
        dcheck('delete 不带 reclaim 时回执里没有 reclaim 键', del.removed === true && del.reclaim === undefined && !existsSync(join(rc.sessions, RC_PROJ, 's4')));
        dcheck('deleteSession 也吃布尔老签名（history.ts 那条路传的就是布尔）', S.deleteSession(rc.sessions, RC_PROJ, RC_S2, true).dryRun === true);

        // ============================================================ 6. CLI 参数解析（直接调 main）
        const argvBackup = process.argv;
        const withArgv = (args) => {
            process.argv = ['node', 'session-log.js', ...args];
            try {
                return S.main();
            } finally {
                process.argv = argvBackup;
            }
        };
        const cliZip = withArgv(['export', '--root', tree.sessions, '--project', TREE_PROJ, '--id', TREE_PARENT_ID, '--zip']);
        dcheck('CLI：`--zip` 走 zip 分支（顺带验「工程键以 -- 开头不被吞」）', cliZip.format === 'zip' && existsSync(cliZip.path) && cliZip.subagents.total === 3);
        const cliFmt = withArgv(['export', '--root', tree.sessions, `--project=${TREE_PROJ}`, '--id', TREE_PARENT_ID, '--format=zip', '--out', join(base, 'out2')]);
        dcheck('CLI：`--format=zip` 等价于 `--zip`，`--out` 生效', cliFmt.format === 'zip' && cliFmt.dir === join(base, 'out2'));
        const cliMedia = withArgv(['export', '--root', tree.sessions, '--project', TREE_PROJ, '--id', TREE_PARENT_ID, '--format=md', '--with-subagents', '--with-media', '--attachments', tree.attachments]);
        dcheck('CLI：md + 两个旗标也带回执清单', cliMedia.format === 'md' && cliMedia.media.count === 5 && cliMedia.subagents.total === 3);
        const cliDel = withArgv(['delete', '--root', tree.sessions, '--project', TREE_PROJ, '--id', 'legacy-dir', '--dry-run', '--reclaim-attachments', '--attachments', tree.attachments]);
        dcheck('CLI：delete --dry-run --reclaim-attachments 接上了（没动盘也没写墓碑）', cliDel.dryRun === true && cliDel.removed === false && cliDel.reclaim.dryRun === true && cliDel.reclaim.trashed === 0 && existsSync(join(tree.sessions, TREE_PROJ, 'legacy-dir')));
        dcheck(
            'CLI：没有 --purge 这种不可逆旗标（parseArgs 里也没有）',
            (() => {
                try {
                    withArgv(['delete', '--root', tree.sessions, '--project', TREE_PROJ, '--id', TREE_LEGACY_ID, '--purge']);
                    return !S.FLAGS.has('purge');
                } catch {
                    return false;
                }
            })(),
        );
        dcheck(
            'CLI：未知命令仍然报错（没被新分支吃掉）',
            (() => {
                try {
                    withArgv(['purge', '--root', tree.sessions, '--project', TREE_PROJ, '--id', TREE_PARENT_ID]);
                    return false;
                } catch (error) {
                    return String(error.message).includes('未知命令');
                }
            })(),
        );

        dcheck('新旗标都进了 parseArgs 的白名单（否则「下一个 token 是不是值」会判错）', ['with-subagents', 'with-media', 'zip', 'attachments', 'reclaim-attachments'].every((flag) => S.FLAGS.has(flag)));
    } catch (error) {
        console.error(`[verify-history] 直接调用段异常：${error instanceof Error ? error.stack : error}`);
        failed += 1;
        failures += 1;
    } finally {
        if (!keep) rmSync(base, { recursive: true, force: true });
        else console.log(`（--keep）直接调用段的合成语料留在：${base}`);
    }

    console.log(`\n直接调用段：${failed === 0 ? '全部通过' : `${failed} 条失败`}（共 ${total} 条断言，不 spawn）`);
    process.exitCode = failures === 0 ? 0 : 1;
}

if (!probeCli()) {
    console.log('');
    console.log('[未验证] 上面那批 CLI 断言在本环境**没有跑**：本沙箱禁止用管道抓子进程输出');
    console.log('         （`spawnSync(..., {encoding:"utf8"})` 实测 error.code=EPERM、stdout=undefined），');
    console.log('         所以 `cli()` 一抛错就被 main() 的 catch 收走 —— 它们既没通过也没失败。');
    console.log('         请在权限更高的环境重跑本脚本，那一段才会真的执行。');
}

directChecks();
