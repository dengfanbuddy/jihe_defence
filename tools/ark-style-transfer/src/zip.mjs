/** 极简 ZIP 打包（stored/deflate），零依赖：用于「打包下载处理结果」 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
}

function dosTime(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

/**
 * 把文件列表打成 zip Buffer
 * @param {{name:string, path:string}[]} files  name = zip 内的路径（用 / 分隔）
 */
export function zipFiles(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosTime();

    for (const f of files) {
        const data = fs.readFileSync(f.path);
        const crc = crc32(data);
        const deflated = zlib.deflateRawSync(data, { level: 6 });
        const useDeflate = deflated.length < data.length;
        const body = useDeflate ? deflated : data;
        const method = useDeflate ? 8 : 0;
        const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, nameBuf, body);

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4); // version made by
        cen.writeUInt16LE(20, 6); // version needed
        cen.writeUInt16LE(0, 8);
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(time, 12);
        cen.writeUInt16LE(date, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(body.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30);
        cen.writeUInt16LE(0, 32);
        cen.writeUInt16LE(0, 34);
        cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }

    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...chunks, centralBuf, end]);
}

/** 列出目录（不递归子目录）里匹配扩展名的文件 */
export function collectByExt(dir, exts) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && exts.includes(path.extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
