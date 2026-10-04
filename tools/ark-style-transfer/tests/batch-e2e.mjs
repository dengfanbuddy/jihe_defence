/**
 * 端到端自测（不花接口钱）：用「只重跑抠图」模式跑一遍批量任务，
 * 顺带验证 SSE 进度推送、报告落盘、ZIP 打包。
 *
 *   node tests/batch-e2e.mjs [服务地址]
 *
 * 前置：.data/testin/ 放输入图，.data/testout/_raw/ 放对应的「模型直出图」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const IN = path.join(ROOT, '.data', 'testin');
const OUT = path.join(ROOT, '.data', 'testout');

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};

const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
};

const params = {
    alphaMode: 'chroma',
    keyAuto: true,
    keyTolerance: 68,
    localGrow: 14,
    shrinkEdge: 1,
    despill: true,
    trim: true,
    trimMargin: 2,
    padSquare: true,
    outSize: 256,
    outputFormat: 'png',
    model: 'doubao-seedream-5-0-flash-260628',
};

console.log('\n=== 批量端到端自测（realpha 模式，不调接口）===\n');
fs.mkdirSync(OUT, { recursive: true });

const start = await post('/api/batch', { inDir: IN, outDir: OUT, mode: 'realpha', params, concurrency: 2, retries: 0, skipExisting: false });
check('启动任务成功', start.json?.ok === true, JSON.stringify(start.json).slice(0, 160));
if (!start.json?.ok) process.exit(1);
const jobId = start.json.jobId;
console.log(`  jobId = ${jobId}`);

// --- SSE ---
const events = { progress: 0, item: 0, log: 0, finished: null, steps: [] };
await new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
        ac.abort();
        resolve();
    }, 60000);
    fetch(`${BASE}/api/batch/${jobId}/events`, { signal: ac.signal })
        .then(async (res) => {
            check('SSE 连接建立（text/event-stream）', (res.headers.get('content-type') || '').includes('text/event-stream'), res.headers.get('content-type'));
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const raw = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const ev = /^event: (.+)$/m.exec(raw)?.[1];
                    const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
                    if (ev === 'progress') events.progress++;
                    else if (ev === 'item') events.item++;
                    else if (ev === 'log') events.log++;
                    else if (ev === 'step') events.steps.push(JSON.parse(dataLine));
                    else if (ev === 'finished') events.finished = JSON.parse(dataLine);
                }
                if (events.finished) break;
            }
            clearTimeout(timer);
            ac.abort();
            resolve();
        })
        .catch(() => {
            clearTimeout(timer);
            resolve();
        });
});

check('收到 finished 事件', !!events.finished, `progress=${events.progress} item=${events.item} log=${events.log}`);
const s = events.finished || {};
check('进度事件多次推送', events.progress >= 2, `${events.progress} 次`);
check('每条结果都有 item 事件（含迟连补齐）', events.item >= 3, `${events.item} 次`);
check('任务状态为 done', s.status === 'done', s.status);
check('成功 2 张', s.done === 2, `done=${s.done}`);
check('失败 1 张（缺 _raw 直出图的那张）', s.failed === 1, `failed=${s.failed}`);
const failItem = (s.items || []).find((i) => i.status === 'failed');
check('失败项给出了可读原因', !!failItem?.message && /没找到直出图/.test(failItem.message), failItem?.message);
check('ETA/耗时字段存在', typeof s.elapsedMs === 'number' && s.elapsedMs >= 0, `${s.elapsedMs}ms`);

// --- 产物 ---
console.log('\n--- 产物 ---');
const outs = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'));
check('成品图落盘（2 张）', outs.length === 2, outs.join(', '));
check('报告 JSON 落盘', fs.existsSync(path.join(OUT, '_report.json')));
check('报告 CSV 落盘', fs.existsSync(path.join(OUT, '_report.csv')));
check('缩略图落盘', fs.existsSync(path.join(OUT, '_thumb')) && fs.readdirSync(path.join(OUT, '_thumb')).length === 2);
if (fs.existsSync(path.join(OUT, '_report.json'))) {
    const rep = JSON.parse(fs.readFileSync(path.join(OUT, '_report.json'), 'utf8'));
    check('报告里 counts 正确', rep.counts?.done === 2 && rep.counts?.failed === 1, JSON.stringify(rep.counts));
    const doneItem = rep.items.find((i) => i.status === 'done');
    check('报告里有 alpha 质检字段', (doneItem?.alpha?.transparentRatio ?? 0) > 0.5, JSON.stringify(doneItem?.alpha || {}).slice(0, 140));
    check('报告是合法 UTF-8 中文', /没找到直出图/.test(rep.items.find((i) => i.status === 'failed')?.message || ''), '失败原因中文正常');
}
check('CSV 带 UTF-8 BOM（Excel 打开不乱码）', fs.readFileSync(path.join(OUT, '_report.csv')).slice(0, 3).toString('hex') === 'efbbbf');

// --- 重跑幂等（skipExisting）---
const again = await post('/api/batch', { inDir: IN, outDir: OUT, mode: 'realpha', skipExisting: true, params, concurrency: 1, retries: 0 });
check('二次启动（跳过已存在）成功', again.json?.ok === true, JSON.stringify(again.json).slice(0, 120));
if (again.json?.ok) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await (await fetch(`${BASE}/api/batch/${again.json.jobId}`)).json();
    check('已存在的被跳过', st.job?.skipped >= 2, `skipped=${st.job?.skipped} failed=${st.job?.failed} done=${st.job?.done}`);
    check('状态为 done', st.job?.status === 'done', st.job?.status);
}

// --- ZIP ---
console.log('\n--- ZIP ---');
const zres = await fetch(`${BASE}/api/zip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: OUT }) });
check('ZIP 接口 200', zres.status === 200, String(zres.status));
const zbuf = Buffer.from(await zres.arrayBuffer());
fs.writeFileSync(path.join(ROOT, '.data', 'test.zip'), zbuf);
check('ZIP 头正确（PK\\x03\\x04）', zbuf[0] === 0x50 && zbuf[1] === 0x4b && zbuf[2] === 3 && zbuf[3] === 4, `${zbuf.length} 字节`);
check('ZIP 末尾有 EOCD', zbuf.readUInt32LE(zbuf.length - 22) === 0x06054b50);
const entries = zbuf.readUInt16LE(zbuf.length - 22 + 10);
check('ZIP 条目数 = 2', entries === 2, String(entries));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
