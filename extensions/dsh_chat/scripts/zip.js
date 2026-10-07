/**
 * 零依赖 ZIP 写入器（store / deflate 两种 method · 自实现 CRC32）。
 *
 * ## 为什么要自己写，而不是引一个库
 *
 * 1. 这个扩展**不带任何第三方运行期依赖**（`package.json` 的 `dependencies` 是空的，
 *    `node_modules` 里只有 `@types/node` / `typescript` / `undici-types` 这些开发期类型包）。
 *    为了「把几十个文件打成一个包」引一个 zip 库，等于给一个编辑器插件加一棵依赖树。
 * 2. 会话导出需要写的 ZIP 子集**极小**，而且刚好避开所有难写的地方：
 *    不带加密、不带 ZIP64、不用 data descriptor、不用流式写。这四样每一样都是
 *    「自己实现最容易写错」的东西 —— 不做，就是最稳的做法（见下面两条边界）。
 * 3. **结构可测**：`verify-history.js` 里用一份**独立写的**字节级解析器把产物读回来逐项对账
 *    （EOCD → 中央目录 → 逐条 local header → 解压 → 逐字节比）。
 *    读的那一侧**不复用本文件的任何常量或函数** —— 复用就等于自己给自己判卷。
 *
 * ## 两条有意为之的边界（撞上就抛错，不产出坏包）
 *
 * - **不做 ZIP64**：条目数 > 65535、单条未压前 > 4 GiB、或整体偏移越过 4 GiB 时**直接抛错**。
 *   会话日志与图片都远小于这个量级；真撞上说明调用方出了问题，报错远好过
 *   「生成了一个别的工具打不开的档」（那种失败在解压方，排查起来最费劲）。
 * - **路径校验是硬门**：条目名必须是相对路径、用 `/`、不含 `..` 段、不含盘符与反斜杠。
 *   这不是洁癖：解压方（资源管理器 / 7-Zip）会拿条目名拼磁盘路径，
 *   一个 `..\..\` 条目就是解压侧的任意写（Zip Slip）。我们**永远不该产出**这种包，
 *   所以校验放在写入口而不是「相信调用方」。
 *
 * ## 用法
 *
 * ```js
 * const { writeZip } = require('./zip');
 * const buffer = writeZip([
 *     { path: 'session.jsonl', text: '...' },
 *     { path: 'media/abc.png', data: pngBuffer, method: 'store' },
 * ]);
 * ```
 *
 * @module dsh_chat/zip
 */

'use strict';

const { deflateRawSync } = require('node:zlib');

// ---------------------------------------------------------------- ZIP 结构常量
// 全写出来，读代码时不用去翻 spec（这些数字在多个地方复用，散落着写迟早写岔一个）。

/** 本地文件头签名 `PK\x03\x04`。 */
const SIG_LOCAL = 0x04034b50;
/** 中央目录头签名 `PK\x01\x02`。 */
const SIG_CENTRAL = 0x02014b50;
/** 中央目录结束记录（EOCD）签名 `PK\x05\x06`。 */
const SIG_EOCD = 0x06054b50;
/** method 0：只存不压。 */
const METHOD_STORE = 0;
/** method 8：deflate（raw，无 zlib 头）。 */
const METHOD_DEFLATE = 8;
/** 通用位标记的 bit 11：条目名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;
/** "version needed to extract"：2.0（deflate 需要的最低版本）。 */
const VERSION_NEEDED = 20;
/** "version made by"：高字节 3 = UNIX（这样 external attributes 里的权限位才有意义）。 */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** UNIX 权限位 `-rw-r--r--` 放在 external attributes 的高 16 位。 */
const UNIX_MODE_FILE = 0o100644;
/** 16 位字段的上限（条目数 / 名字长度）。 */
const MAX_UINT16 = 0xffff;
/** 32 位字段的上限（单条大小 / 偏移）。 */
const MAX_UINT32 = 0xffffffff;

/**
 * CRC32 查表（IEEE 802.3 多项式 0xEDB88320，与 ZIP 规范同一条）。
 *
 * 为什么自己算而不是用 `zlib.crc32`：那个 API 是 Node 20.12 才加的，而这个脚本
 * 声称「跑在系统 node 上」（本机 v24，能用），但 `zip.js` 是通用件 ——
 * 通用件不该把「能不能用」押在一个版本边界上，而查表法只有十几行、也更好测
 * （`verify-history.js` 会拿 `zlib.crc32` 做一次**交叉验证**：两条独立实现算出同一个值）。
 */
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC_TABLE[index] = value >>> 0;
}

/**
 * 算一段字节的 CRC32（无符号 32 位）。
 *
 * @param {Buffer | Uint8Array} buffer - 待算字节。
 * @returns {number} CRC32。
 */
function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 时间 → ZIP 的 DOS 日期时间（两个 uint16）。
 *
 * ⚠ **夹到 1980..2107**：DOS 的年字段是「年 - 1980」的 7 位值，
 * 早于 1980 的 mtime（git checkout 出来的文件、或 `utimesSync(0)` 造出来的夹具）
 * 会让 `year - 1980` 变成负数，写进 uint16 就成了一个天文数字年份，
 * 解压方会显示一个荒谬的日期。夹一下，代价只是日期不准，而不是结构可疑。
 *
 * ⚠ **秒只有 2 秒精度**（DOS 格式本来就 5 位秒 / 2），奇数秒会被舍去 —— 这是规范限制，
 * 不是 bug；所以**不要拿 DOS 时间做精确定序**，条目顺序才是我们自己的口径。
 *
 * @param {number} ms - 毫秒时间戳。
 * @returns {{time: number, date: number}} DOS 时间字段。
 */
function dosDateTime(ms) {
    const at = new Date(Number.isFinite(ms) ? ms : Date.now());
    const year = Math.min(2107, Math.max(1980, at.getFullYear()));
    const time = ((at.getHours() & 0x1f) << 11) | ((at.getMinutes() & 0x3f) << 5) | ((at.getSeconds() >> 1) & 0x1f);
    const date = ((year - 1980) << 9) | (((at.getMonth() + 1) & 0x0f) << 5) | (at.getDate() & 0x1f);
    return { time: time & MAX_UINT16, date: date & MAX_UINT16 };
}

/**
 * 条目名的安全校验（**这是防 Zip Slip 的那道门**，见文件头）。
 *
 * @param {string} path - 条目名。
 * @returns {string} 原样返回（校验通过）。
 */
function assertSafeEntryPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('ZIP 条目缺少 path');
    if (path.length > 200) throw new Error(`ZIP 条目名太长了：${JSON.stringify(path.slice(0, 60))}`);
    if (path.startsWith('/') || path.endsWith('/')) throw new Error(`ZIP 条目名不能以 / 开头或结尾：${path}`);
    if (path.includes('\\')) throw new Error(`ZIP 条目名必须用 / 而不是反斜杠：${path}`);
    if (/^[A-Za-z]:/.test(path)) throw new Error(`ZIP 条目名不能带盘符：${path}`);
    for (const segment of path.split('/')) {
        // 空段 = `a//b`；`.` / `..` 段 = 路径穿越。两者都直接拒。
        if (!segment || segment === '.' || segment === '..') throw new Error(`ZIP 条目名里有非法路径段：${path}`);
    }
    return path;
}

/**
 * 把调用方给的一条条目收敛成 `{name, nameBytes, raw, method, mtime}`。
 *
 * @param {unknown} entry - `{path, data} | {path, text}`（可选 `method` / `mtime`）。
 * @param {number} defaultMethod - 缺省 method。
 * @param {number} fallbackMtime - 缺省时间。
 * @returns {{name: string, nameBytes: Buffer, raw: Buffer, method: number, mtime: number}} 收敛后的条目。
 */
function normalizeEntry(entry, defaultMethod, fallbackMtime) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const name = assertSafeEntryPath(source.path);
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > MAX_UINT16) throw new Error(`ZIP 条目名的 UTF-8 字节数超了：${name}`);

    let raw;
    if (Buffer.isBuffer(source.data)) raw = source.data;
    else if (source.data instanceof Uint8Array) raw = Buffer.from(source.data);
    else if (typeof source.text === 'string') raw = Buffer.from(source.text, 'utf8');
    else throw new Error(`ZIP 条目 ${name} 既没有 data 也没有 text`);
    if (raw.length > MAX_UINT32) throw new Error(`ZIP 条目 ${name} 超过 4 GiB（这个写入器不做 ZIP64）`);

    const method = source.method === 'store' ? METHOD_STORE : source.method === 'deflate' ? METHOD_DEFLATE : defaultMethod;
    const mtime = Number.isFinite(source.mtime) ? Number(source.mtime) : source.mtime instanceof Date ? source.mtime.getTime() : fallbackMtime;
    return { name, nameBytes, raw, method, mtime };
}

/**
 * 组装一个 ZIP 包的字节。
 *
 * 布局按规范顺序写：**所有 local header + 数据 → 中央目录 → EOCD**。
 * 用 `store` 还是 `deflate` 由调用方给（`method`），缺省 deflate；但 deflate **压不小就退成 store**
 * —— PNG/JPEG 本来就压过一遍，再 deflate 只会多出十几字节的固定头（这是标准做法，
 * 也是「媒体文件用 store」不至于写错的原因：就算调用方漏了 `method`，结果也只是白花一点 CPU）。
 *
 * @param {Array<{path: string, data?: Buffer | Uint8Array, text?: string, method?: 'store' | 'deflate', mtime?: number | Date}>} entries - 条目（**顺序即产物顺序**）。
 * @param {{method?: 'store' | 'deflate', mtime?: number | Date}} [options] - 缺省值。
 * @returns {Buffer} 完整的 .zip 字节。
 */
function writeZip(entries, options = {}) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('writeZip 需要至少一个条目');
    if (entries.length > MAX_UINT16) throw new Error(`条目数 ${entries.length} 超过 65535（这个写入器不做 ZIP64）`);

    const defaultMethod = options.method === 'store' ? METHOD_STORE : METHOD_DEFLATE;
    const fallbackMtime = Number.isFinite(options.mtime) ? Number(options.mtime) : options.mtime instanceof Date ? options.mtime.getTime() : Date.now();

    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const raw of entries) {
        const entry = normalizeEntry(raw, defaultMethod, fallbackMtime);
        let data = entry.raw;
        let method = entry.method;
        if (method === METHOD_DEFLATE) {
            const compressed = deflateRawSync(entry.raw);
            if (compressed.length < entry.raw.length) data = compressed;
            else method = METHOD_STORE; // 压不动就存（见 JSDoc）
        }

        const crc = crc32(entry.raw);
        const { time, date } = dosDateTime(entry.mtime);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(VERSION_NEEDED, 4);
        // 不设 bit 3（data descriptor）：大小与 CRC 在写 local header 时**已经知道**，
        // 用 descriptor 只会让解析方多一条分支，也会让「中央目录 + local header 两处值必须一致」
        // 这条最容易验的不变式失效。
        local.writeUInt16LE(FLAG_UTF8, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(entry.raw.length, 22);
        local.writeUInt16LE(entry.nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, entry.nameBytes, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(SIG_CENTRAL, 0);
        central.writeUInt16LE(VERSION_MADE_BY, 4);
        central.writeUInt16LE(VERSION_NEEDED, 6);
        central.writeUInt16LE(FLAG_UTF8, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(entry.raw.length, 24);
        central.writeUInt16LE(entry.nameBytes.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number start
        central.writeUInt16LE(0, 36); // internal attributes
        // ⚠ 必须 `>>> 0`：`0o100644 << 16` = 0x81A40000，第 31 位是 1，
        // 在 JS 里这是个**负数**的 int32，直接喂 `writeUInt32LE` 会抛 ERR_OUT_OF_RANGE。
        central.writeUInt32LE((UNIX_MODE_FILE << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, entry.nameBytes);

        offset += local.length + entry.nameBytes.length + data.length;
        if (offset > MAX_UINT32) throw new Error('ZIP 超过 4 GiB（这个写入器不做 ZIP64）');
    }

    const centralBuffer = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4); // 本磁盘号
    eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20); // 注释长度

    return Buffer.concat([...locals, centralBuffer, eocd]);
}

module.exports = { writeZip, crc32, dosDateTime, SIG_LOCAL, SIG_CENTRAL, SIG_EOCD, METHOD_STORE, METHOD_DEFLATE };
