/**
 * 图片附件那条链路的**纯逻辑**自检 —— 不开编辑器、不碰正在跑的 agent。
 *
 * ## 为什么要有它
 *
 * 「插图 → 发给模型」这条路上，几乎每一步的失败都是**静默**的：MIME 不在白名单、
 * base64 不是规范形式、文件太大、路径映射错、子资源被当成图 —— 这些都不会在面板上报错，
 * 只会表现为「模型说没看到图」或者「点了没反应」。而它们全都是 `source/images.ts` 里
 * 几行纯函数就能判定的东西。
 *
 * 所以这里拿一个**临时目录**当真工程跑一遍：扫目录、读文件、校验批次、筛选、映射 URL。
 *
 * ```sh
 * cd extensions/dsh_chat && npm run build && node scripts/verify-images.js
 * ```
 *
 * @module dsh_chat/verify-images
 */

'use strict';

const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const PROJECT_ROOT = resolve(ROOT, '..', '..');
const FIXTURE = join(PROJECT_ROOT, '.tmp', 'verify-images');

/** 一张真 PNG（1×1 透明）—— 被读的东西只要字节够真，不要求能解码。 */
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
);

let failures = 0;

/**
 * 记一条断言结果。
 *
 * @param {string} label - 断言描述。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 附加信息。
 */
function check(label, ok, detail = '') {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        // 早退路径也要红 —— 别只靠结尾那一行（见 verify-replay 踩过的洞）。
        process.exitCode = 1;
    }
}

/** 造一遍临时工程结构。 */
function makeFixture() {
    rmSync(FIXTURE, { recursive: true, force: true });
    const assets = join(FIXTURE, 'assets');
    mkdirSync(join(assets, 'textures', 'hero'), { recursive: true });
    mkdirSync(join(assets, '.hidden'), { recursive: true });
    mkdirSync(join(assets, 'scripts'), { recursive: true });
    writeFileSync(join(assets, 'textures', 'hero', 'a.png'), TINY_PNG);
    writeFileSync(join(assets, 'textures', 'hero', 'b.PNG'), TINY_PNG);
    writeFileSync(join(assets, 'textures', 'bg.jpeg'), TINY_PNG);
    writeFileSync(join(assets, 'textures', 'anim.gif'), TINY_PNG);
    writeFileSync(join(assets, 'textures', 'pic.webp'), TINY_PNG);
    writeFileSync(join(assets, 'textures', 'note.txt'), 'not an image');
    writeFileSync(join(assets, '.hidden', 'secret.png'), TINY_PNG);
    writeFileSync(join(assets, 'scripts', 'Main.ts'), 'export class Main {}');
    writeFileSync(join(assets, 'textures', 'big.png'), Buffer.alloc(4096, 7));
    return assets;
}

function main() {
    const images = require(join(ROOT, 'dist', 'images.js'));
    const assets = makeFixture();

    console.log('常量（必须与 DSH 附件库同口径，漂了就是静默失败）');
    check(
        '白名单正好四种（png/jpeg/webp/gif）',
        [...new Set(Object.values(images.IMAGE_MIME_BY_EXT))].sort().join(',') === 'image/gif,image/jpeg,image/png,image/webp',
    );
    check('单张上限 20MB', images.MAX_IMAGE_BYTES === 20 * 1024 * 1024, String(images.MAX_IMAGE_BYTES));
    check('一条消息 20 张', images.MAX_IMAGES_PER_MESSAGE === 20, String(images.MAX_IMAGES_PER_MESSAGE));
    check('合计上限 200MB', images.MAX_MESSAGE_IMAGE_BYTES === 200 * 1024 * 1024, String(images.MAX_MESSAGE_IMAGE_BYTES));

    console.log('\n扩展名 → MIME');
    check('a.png → png', images.mimeOfImagePath('a.png') === 'image/png');
    check('a.PNG 大小写不敏感', images.mimeOfImagePath('a.PNG') === 'image/png');
    check('a.jpeg → jpeg', images.mimeOfImagePath('a.jpeg') === 'image/jpeg');
    check('a.webp → webp', images.mimeOfImagePath('a.webp') === 'image/webp');
    check('a.gif → gif', images.mimeOfImagePath('a.gif') === 'image/gif');
    check('a.bmp 不认（要面板转码）', images.mimeOfImagePath('a.bmp') === null);
    check('a.txt 不认', images.isImagePath('a.txt') === false);

    console.log('\ndb:// ↔ 路径');
    const projectPath = 'D:\\proj\\demo';
    check('assets 挂载点映射', images.dbUrlToPath(projectPath, 'db://assets/a/b.png') === join(projectPath, 'assets', 'a', 'b.png'));
    check('internal 挂载点映射', images.dbUrlToPath(projectPath, 'db://internal/c.png') === join(projectPath, 'internal', 'c.png'));
    check('别的挂载点拒绝（宁可不显示也不拼错路径）', images.dbUrlToPath(projectPath, 'db://custom/x.png') === null);
    check('非 db:// 拒绝', images.dbUrlToPath(projectPath, 'assets/a.png') === null);
    check('路径反推 URL', images.pathToDbUrl(projectPath, join(projectPath, 'assets', 'a', 'b.png')) === 'db://assets/a/b.png');
    check('工程外路径反推为空串', images.pathToDbUrl(projectPath, 'D:\\other\\x.png') === '');
    check('子资源（/spriteFrame）不算图片', images.urlLooksLikeImage('db://assets/a.png/spriteFrame') === false);
    check('本体算图片', images.urlLooksLikeImage('db://assets/a.png') === true);

    console.log('\n扫目录（资源库那条路的兜底）');
    const scanned = images.scanImageFiles(assets);
    const rels = scanned.map((item) => item.rel);
    check('找到 6 张图（png/PNG/jpeg/gif/webp + 一张大 png）', scanned.length === 6, rels.join(', '));
    check('跳过 . 开头的目录', !rels.some((rel) => rel.includes('.hidden')), rels.join(', '));
    check('跳过非图片', !rels.some((rel) => rel.endsWith('.txt') || rel.endsWith('.ts')));
    check('按路径排序（顺序稳定，翻页/截图可比对）', rels.join('|') === [...rels].sort().join('|'), rels.join(', '));
    check('limit 生效', images.scanImageFiles(assets, 2).length === 2);
    check('不存在的目录返回空数组（不抛）', images.scanImageFiles(join(FIXTURE, 'nope')).length === 0);

    console.log('\nasset-db 结果投影');
    const rows = [
        { url: 'db://assets/textures/a.png', name: 'a', uuid: 'u1', file: join(projectPath, 'assets', 'textures', 'a.png') },
        { url: 'db://assets/textures/a.png/spriteFrame', name: 'a', uuid: 'u2' },
        { url: 'db://internal/engine.png', name: 'engine', uuid: 'u3' },
        { url: 'db://assets/readme.txt', name: 'readme', uuid: 'u4' },
        { url: 'db://assets/textures/c.png', displayName: '显示名', uuid: 'u5' },
        'garbage',
        null,
    ];
    const projected = images.projectImagesFromAssetDb(rows, projectPath);
    check('只留下 assets 下的图片本体（internal/子资源/非图都被剔掉）', projected.length === 2, projected.map((item) => item.url).join(', '));
    check('displayName 优先', projected.some((item) => item.name === '显示名'));
    check('没给 file 时由 url 推路径', projected.every((item) => Boolean(item.path)));
    check('非数组输入返回空数组（不抛）', images.projectImagesFromAssetDb('nope', projectPath).length === 0);

    console.log('\n合并 / 去重 / 排序');
    const merged = images.mergeProjectImages(
        [{ url: 'db://assets/b.png', path: join(assets, 'textures', 'hero', 'b.PNG'), name: 'b', rel: 'db://assets/b.png', source: 'asset-db' }],
        scanned.map((item) => ({ url: `db://assets/${item.rel}`, path: item.path, name: item.name, rel: `assets/${item.rel}`, source: 'scan' })),
    );
    check('两套结果按路径去重（主路优先，大小写不同也算同一张）', merged.length === 6, String(merged.length));
    check('合并后仍有序', merged.map((item) => item.rel).join('|') === [...merged.map((item) => item.rel)].sort().join('|'));
    check('limit 生效', images.mergeProjectImages(undefined, merged, 2).length === 2);

    console.log('\n读一张图');
    // projectPath 用临时的那个「工程根」：fixture 里就有 assets/，所以 db:// 能真的映射上
    const read = images.readImageFile(join(assets, 'textures', 'hero', 'a.png'), { projectPath: FIXTURE });
    check('读成功', read.ok === true, read.ok ? '' : read.error);
    check('MIME 由扩展名给出', read.mimeType === 'image/png');
    check('字节数对得上', read.bytes === TINY_PNG.length, String(read.bytes));
    check(
        'base64 是**规范形式**（附件库的解码器要求逐字相等）',
        Buffer.from(read.data, 'base64').toString('base64') === read.data,
    );
    check('带 db:// URL', read.url === 'db://assets/textures/hero/a.png', read.url);
    check('不是图片 → 失败且给原因', images.readImageFile(join(assets, 'textures', 'note.txt')).ok === false);
    check('文件不存在 → 失败且给原因', images.readImageFile(join(assets, 'nope.png')).ok === false);
    const limited = images.readImageFile(join(assets, 'textures', 'big.png'), { maxBytes: 1024 });
    check('超上限 → 拒收（不是压缩）', limited.ok === false && limited.error.includes('上限'), limited.error);

    console.log('\n批次校验（面板 → 主进程这一层再验一遍）');
    check('空数组放行', images.validateImageBatch([]).ok === true);
    check('undefined 放行（老面板只发文字）', images.validateImageBatch(undefined).ok === true);
    check('非数组拒绝', images.validateImageBatch('nope').ok === false);
    const good = { mimeType: 'image/png', data: TINY_PNG.toString('base64'), name: 'a.png' };
    const one = images.validateImageBatch([good]);
    check('合法一张通过', one.ok === true && one.images.length === 1);
    check('带上解码后的字节数', one.ok === true && one.images[0].bytes === TINY_PNG.length);
    check('白名单外的 MIME 拒绝', images.validateImageBatch([{ ...good, mimeType: 'image/bmp' }]).ok === false);
    check('空数据拒绝', images.validateImageBatch([{ ...good, data: '' }]).ok === false);
    check(
        '非规范 base64 拒绝（带换行）',
        images.validateImageBatch([{ ...good, data: `${good.data.slice(0, 8)}\n${good.data.slice(8)}` }]).ok === false,
    );
    check('超过 20 张拒绝', images.validateImageBatch(new Array(21).fill(good)).ok === false);
    check('正好 20 张通过', images.validateImageBatch(new Array(20).fill(good)).ok === true);

    console.log('\n筛选（选择器里的搜索框）');
    const pool = [
        { name: 'gold_boss.png', url: 'db://assets/textures/common/gold_boss.png', rel: 'db://assets/textures/common/gold_boss.png', path: 'x', source: 'scan' },
        { name: 'hero_1.png', url: 'db://assets/textures/heros/hero_1.png', rel: 'db://assets/textures/heros/hero_1.png', path: 'y', source: 'scan' },
    ];
    check('空查询全放行', images.filterProjectImages(pool, '').length === 2);
    check('按名字匹配', images.filterProjectImages(pool, 'gold').length === 1);
    check('按路径匹配', images.filterProjectImages(pool, 'heros').length === 1);
    check('大小写不敏感', images.filterProjectImages(pool, 'GOLD').length === 1);
    check('多词是 AND', images.filterProjectImages(pool, 'textures gold').length === 1);
    check('都不匹配就是空', images.filterProjectImages(pool, 'zzz').length === 0);

    console.log('\n体积显示');
    check('KB', images.formatBytes(62259) === '61KB', images.formatBytes(62259));
    check('MB', images.formatBytes(2.5 * 1024 * 1024) === '2.5MB', images.formatBytes(2.5 * 1024 * 1024));
    check('0 不炸', images.formatBytes(0) === '0KB');

    rmSync(FIXTURE, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
