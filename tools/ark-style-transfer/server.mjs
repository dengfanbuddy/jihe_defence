#!/usr/bin/env node
/**
 * 火山方舟 · 图片风格迁移工具 —— 本地 Web 服务
 *
 *   node server.mjs                  # 默认 http://127.0.0.1:8788
 *   node server.mjs --port 9000      # 换端口
 *   node server.mjs --host 0.0.0.0   # 局域网可访问（默认只绑本机）
 *
 * 只绑 127.0.0.1，接口没有鉴权 —— 不要把它暴露到公网。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import sharp from 'sharp';

import {
    MODELS,
    PROMPT_PRESETS,
    DEFAULT_PARAMS,
    ROOT,
    PUBLIC_DIR,
    DEFAULT_OUT_DIR,
    loadConfig,
    saveConfig,
    effectiveApiKey,
    effectiveBaseUrl,
    imagesEndpoint,
    mergedDefaults,
    normalizeParams,
    findModel,
    modelIds,
    ensureDirs,
} from './src/config.mjs';
import { processOne, composePrompt } from './src/pipeline.mjs';
import { listModels, probeModelId } from './src/ark.mjs';
import { createJob, getJob, listJobs } from './src/batch.mjs';
import { listImages, resolveUserPath, mimeOf, fmtBytes, isImageFile, log, warn } from './src/util.mjs';
import { zipFiles, collectByExt } from './src/zip.mjs';

const argv = process.argv.slice(2);
function arg(name, def = null) {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) {
        const v = argv[i + 1];
        return v && !v.startsWith('--') ? v : true;
    }
    return def;
}
if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`火山方舟 · 图片风格迁移工具

用法：node server.mjs [--port 8788] [--host 127.0.0.1] [--no-open]

  参考图 + 目标图 → 同风格图标（透明背景、无水印），支持批量处理整个文件夹。
  API Key 可在网页里填（保存在 .data/config.json），也可用环境变量 ARK_API_KEY。
`);
    process.exit(0);
}

const PORT = Number(arg('port', process.env.PORT || 8788));
const HOST = String(arg('host', '127.0.0.1'));

ensureDirs();

// ---------------------------------------------------------------- 工具

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
}

function readBody(req, limit = 200 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error(`JSON 解析失败：${e.message}`));
            }
        });
        req.on('error', reject);
    });
}

function maskKey(k) {
    if (!k) return '';
    return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`;
}

// ---------------------------------------------------------------- 路由

const routes = {
    'GET /api/config': (req, res) => {
        const cfg = loadConfig();
        const key = effectiveApiKey();
        const account = cfg.accountModels || [];
        const accountSet = new Set(account);
        const probe = cfg.modelProbe || {};
        sendJson(res, 200, {
            // available: 是否出现在「账户模型列表」里（仅作发现用，**不代表能用于生图**）
            // probed   : 免费校验过的真实结果 —— true 可用 / false 不可用 / null 未校验（这才可信）
            models: MODELS.map((m) => {
                const ids = modelIds(m);
                const hit = ids.map((id) => probe[id]).find((x) => x);
                return {
                    ...m,
                    available: account.length ? ids.some((id) => accountSet.has(id)) : null,
                    probed: hit ? hit.usable : null,
                    probedAt: hit ? hit.at : 0,
                };
            }),
            presets: PROMPT_PRESETS,
            defaults: mergedDefaults(),
            hasKey: !!key,
            keyMask: maskKey(cfg.apiKey || process.env.ARK_API_KEY || ''),
            keySource: cfg.apiKey ? 'ui' : process.env.ARK_API_KEY ? 'env' : 'none',
            baseUrl: effectiveBaseUrl(),
            imagesEndpoint: imagesEndpoint(),
            defaultOutDir: DEFAULT_OUT_DIR,
            accountModels: cfg.accountModels || [],
            accountModelsAt: cfg.accountModelsAt || 0,
            toolRoot: ROOT,
            node: process.version,
            cwd: process.cwd(),
        });
    },

    'POST /api/config': async (req, res) => {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim();
        if (body.params && typeof body.params === 'object') {
            const cur = loadConfig();
            patch.params = { ...(cur.params || {}), ...body.params };
        }
        const saved = saveConfig(patch);
        sendJson(res, 200, {
            ok: true,
            hasKey: !!effectiveApiKey(),
            keyMask: maskKey(saved.apiKey || process.env.ARK_API_KEY || ''),
            baseUrl: effectiveBaseUrl(),
        });
    },

    'POST /api/prompt/preview': async (req, res) => {
        const body = await readBody(req);
        const { params } = normalizeParams(body.params || {});
        sendJson(res, 200, { prompt: composePrompt(params, body.imageCount ?? (params.useRef ? 2 : 1)) });
    },

    'POST /api/generate': async (req, res) => {
        const body = await readBody(req);
        const { params, warnings } = normalizeParams(body.params || {});
        const mode = body.mode === 'realpha' ? 'realpha' : 'generate';
        const apiKey = body.apiKey?.trim() || effectiveApiKey();
        // 只重跑抠图不调接口，没有 Key 也应该能跑
        if (!apiKey && mode === 'generate')
            return sendJson(res, 400, { ok: false, error: '未配置 API Key', hint: '点右上角「设置」填入火山方舟 API Key，或设置环境变量 ARK_API_KEY 后重启服务' });
        const outDir = resolveUserPath(body.outDir || params.outDir || DEFAULT_OUT_DIR);
        fs.mkdirSync(outDir, { recursive: true });
        const t0 = Date.now();
        try {
            const result = await processOne({
                params,
                apiKey,
                baseUrl: effectiveBaseUrl(),
                ref: body.ref,
                target: body.target,
                outDir,
                outName: body.outName,
                mode,
            });
            sendJson(res, 200, { ...result, warnings: [...warnings, ...(result.warnings || [])], totalMs: Date.now() - t0 });
        } catch (e) {
            warn('单图处理失败：', e.message);
            sendJson(res, 200, {
                ok: false,
                error: e.message,
                code: e.code || '',
                status: e.status || 0,
                hint: e.hint || '',
                requestId: e.requestId || '',
                raw: e.raw ? JSON.stringify(e.raw).slice(0, 2000) : '',
                paramsWarnings: warnings,
            });
        }
    },

    /**
     * 拉取当前账户可用的模型列表。
     * 存在的意义：模型 ID 带版本日期（如 doubao-seedream-5-0-flash-260915），
     * 内置表里的 ID 随时可能过期 —— 这里直接问账户「你到底有哪些模型」，并把结果记到配置里。
     */
    'POST /api/models': async (req, res) => {
        const body = await readBody(req);
        const apiKey = body.apiKey?.trim() || effectiveApiKey();
        if (!apiKey) return sendJson(res, 400, { ok: false, error: '未配置 API Key', hint: '先在「设置」里填 API Key' });
        try {
            const { ids, endpoint, raw } = await listModels({ apiKey, baseUrl: body.baseUrl || effectiveBaseUrl() });
            const relevant = ids.filter((id) => /seedream|seededit/i.test(id));
            saveConfig({ accountModels: ids, accountModelsAt: Date.now() });
            log(`拉取账户模型成功：共 ${ids.length} 个（图片相关 ${relevant.length} 个）← ${endpoint}`);
            sendJson(res, 200, { ok: true, ids, relevant, endpoint, raw, at: Date.now() });
        } catch (e) {
            warn('拉取模型列表失败：', e.message);
            sendJson(res, 200, {
                ok: false,
                error: e.message,
                code: e.code || '',
                status: e.status || 0,
                hint:
                    e.hint ||
                    '该端点在此账号/区域可能不开放列表查询 —— 到火山方舟控制台「开通管理 / 模型广场」复制模型 ID，粘到「自定义模型 ID」那一栏（会记住，下次不用再填）',
                raw: e.raw ? String(typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw)).slice(0, 1200) : '',
            });
        }
    },

    /**
     * 免费校验模型 ID 能不能用于图片生成（尺寸 1x1 + 坏图 → 不可能真出图、不计费）。
     * 不带参数时只校验当前选的模型；`{all:true}` 校验内置表里的全部 ID 与别名。
     */
    'POST /api/models/probe': async (req, res) => {
        const body = await readBody(req);
        const apiKey = body.apiKey?.trim() || effectiveApiKey();
        if (!apiKey) return sendJson(res, 400, { ok: false, error: '未配置 API Key', hint: '先在「设置」里填 API Key' });
        const baseUrl = body.baseUrl || effectiveBaseUrl();
        const list = body.all
            ? [...new Set(MODELS.flatMap((m) => modelIds(m)))]
            : [body.model || mergedDefaults().model].filter(Boolean);
        const results = [];
        for (const id of list) {
            const r = await probeModelId({ apiKey, baseUrl, model: id });
            results.push(r);
            log(`校验模型 ${id} → ${r.usable === true ? '可用' : r.usable === false ? '不可用' : '未知'}（${r.code}）`);
        }
        const cur = loadConfig().modelProbe || {};
        for (const r of results) cur[r.model] = { usable: r.usable, code: r.code, status: r.status, at: Date.now() };
        saveConfig({ modelProbe: cur });
        sendJson(res, 200, { ok: true, results, probe: cur });
    },

    'POST /api/scan': async (req, res) => {
        const body = await readBody(req);
        const dir = resolveUserPath(body.dir || '');
        if (!dir) return sendJson(res, 400, { ok: false, error: '请填写输入文件夹' });
        if (!fs.existsSync(dir)) return sendJson(res, 400, { ok: false, error: `文件夹不存在：${dir}` });
        try {
            const files = listImages(dir, { recursive: !!body.recursive, limit: Number(body.limit) || 0, offset: Number(body.offset) || 0 });
            const model = findModel(body.model || '') || findModel(DEFAULT_PARAMS.model);
            const outDir = resolveUserPath(body.outDir || DEFAULT_OUT_DIR);
            const withInfo = files.slice(0, 400).map((f) => {
                const st = fs.statSync(f);
                return { name: path.basename(f), path: f, size: st.size };
            });
            sendJson(res, 200, {
                ok: true,
                dir,
                outDir,
                count: files.length,
                truncated: files.length > withInfo.length,
                files: withInfo,
                estimate:
                    model?.priceCNY != null
                        ? { model: model.label, unitCNY: model.priceCNY, totalCNY: +(files.length * model.priceCNY).toFixed(2) }
                        : null,
            });
        } catch (e) {
            sendJson(res, 400, { ok: false, error: e.message });
        }
    },

    'POST /api/batch': async (req, res) => {
        const body = await readBody(req);
        const { params, warnings } = normalizeParams(body.params || {});
        const apiKey = body.apiKey?.trim() || effectiveApiKey();
        const mode = body.mode === 'realpha' ? 'realpha' : 'generate';
        if (!apiKey && mode === 'generate')
            return sendJson(res, 400, { ok: false, error: '未配置 API Key', hint: '点右上角「设置」填入火山方舟 API Key' });
        const inDir = resolveUserPath(body.inDir || params.inDir || '');
        const outDir = resolveUserPath(body.outDir || params.outDir || DEFAULT_OUT_DIR);
        if (!inDir || !fs.existsSync(inDir)) return sendJson(res, 400, { ok: false, error: `输入文件夹不存在：${inDir || '(空)'}` });
        if (inDir === outDir) return sendJson(res, 400, { ok: false, error: '输入与输出文件夹不能相同（会覆盖原图）' });
        fs.mkdirSync(outDir, { recursive: true });
        const job = createJob({
            params,
            apiKey,
            baseUrl: effectiveBaseUrl(),
            ref: body.ref,
            inDir,
            outDir,
            mode,
            recursive: !!body.recursive,
            limit: Number(body.limit) || 0,
            offset: Number(body.offset) || 0,
            skipExisting: body.skipExisting !== false,
        });
        job.run().catch((e) => warn('job run error', e));
        sendJson(res, 200, { ok: true, jobId: job.id, warnings, outDir, inDir });
    },

    'GET /api/jobs': (req, res) => sendJson(res, 200, { ok: true, jobs: listJobs() }),

    'POST /api/batch/cancel': async (req, res) => {
        const body = await readBody(req);
        const job = getJob(body.jobId);
        if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });
        sendJson(res, 200, { ok: job.cancel('用户取消') });
    },

    'POST /api/reveal': async (req, res) => {
        const body = await readBody(req);
        const p = resolveUserPath(body.path || '');
        if (!p || !fs.existsSync(p)) return sendJson(res, 400, { ok: false, error: `路径不存在：${p}` });
        const target = fs.statSync(p).isDirectory() ? p : path.dirname(p);
        execFile('explorer.exe', [target], () => {}); // explorer 常返回非 0，忽略
        sendJson(res, 200, { ok: true, path: target });
    },

    /** 打包下载：默认打包输出目录里的成品图（不含 _raw/_thumb） */
    'POST /api/zip': async (req, res) => {
        const body = await readBody(req);
        const dir = resolveUserPath(body.dir || '');
        if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { ok: false, error: `路径不存在：${dir}` });
        let files = collectByExt(dir, ['.png', '.jpg', '.jpeg', '.webp']);
        if (body.only?.length) {
            const want = new Set(body.only.map((n) => n.toLowerCase()));
            files = files.filter((f) => want.has(path.basename(f.name, path.extname(f.name)).toLowerCase()));
        }
        if (!files.length) return sendJson(res, 400, { ok: false, error: '该目录下没有可打包的图片' });
        const buf = zipFiles(files);
        const name = `${path.basename(dir) || 'icons'}_${new Date().toISOString().slice(0, 10)}.zip`;
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
            'Content-Length': buf.length,
        });
        res.end(buf);
    },

    'GET /api/report': async (req, res, url) => {
        const dir = resolveUserPath(url.searchParams.get('dir') || '');
        const p = path.join(dir, '_report.json');
        if (!fs.existsSync(p)) return sendJson(res, 404, { ok: false, error: '没有找到 _report.json' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(fs.readFileSync(p));
    },

    /** 预览本地图片：?path=...&w=200（带 w 时返回缩略图） */
    'GET /api/image': async (req, res, url) => {
        const p = resolveUserPath(url.searchParams.get('path') || '');
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
            res.writeHead(404);
            return res.end('not found');
        }
        if (!isImageFile(p)) {
            res.writeHead(415);
            return res.end('not an image');
        }
        const w = Number(url.searchParams.get('w')) || 0;
        try {
            if (w > 0) {
                const buf = await sharp(p, { failOn: 'none' })
                    .resize({ width: w, height: w, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .png()
                    .toBuffer();
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
                return res.end(buf);
            }
            const st = fs.statSync(p);
            res.writeHead(200, { 'Content-Type': mimeOf(p), 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
            fs.createReadStream(p).pipe(res);
        } catch (e) {
            res.writeHead(500);
            res.end(`read error: ${e.message}`);
        }
    },
};

// ---------------------------------------------------------------- SSE

function handleEvents(req, res, jobId) {
    const job = getJob(jobId);
    if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onProgress = (s) => send('progress', s);
    const onItem = (i) => send('item', { name: i.name, status: i.status, ms: i.ms, message: i.message, outputPath: i.outputPath, thumbPath: i.thumbPath, warnings: i.warnings, errorHint: i.errorHint, width: i.width, height: i.height });
    const onStep = (s) => send('step', s);
    const onLog = (l) => send('log', l);
    const onFinished = (s) => {
        send('finished', s);
        cleanup();
        res.end();
    };
    const cleanup = () => {
        job.off('progress', onProgress);
        job.off('item', onItem);
        job.off('step', onStep);
        job.off('log', onLog);
        job.off('finished', onFinished);
        clearInterval(heartbeat);
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    job.on('progress', onProgress);
    job.on('item', onItem);
    job.on('step', onStep);
    job.on('log', onLog);
    job.on('finished', onFinished);
    req.on('close', cleanup);
    send('progress', job.snapshot());
    // 迟到的/重连的客户端要能补齐已经跑完的条目：快照里带全量 items，另外补发一遍 item 事件
    for (const item of job.items) {
        if (item.status !== 'pending') onItem(item);
    }
    if (job.status !== 'running' && job.status !== 'pending') onFinished(job.snapshot());
}

// ---------------------------------------------------------------- 静态资源

async function serveStatic(res, rel) {
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
        // SSE
        const m = /^\/api\/batch\/([^/]+)\/events$/.exec(pathname);
        if (m && req.method === 'GET') return handleEvents(req, res, m[1]);
        const m2 = /^\/api\/batch\/([^/]+)$/.exec(pathname);
        if (m2 && req.method === 'GET') {
            const job = getJob(m2[1]);
            if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });
            return sendJson(res, 200, { ok: true, job: job.snapshot() });
        }
        const key = `${req.method} ${pathname}`;
        const handler = routes[key];
        if (handler) return await handler(req, res, url);
        if (req.method === 'GET' || req.method === 'HEAD') {
            return serveStatic(res, pathname === '/' ? 'index.html' : pathname);
        }
        sendJson(res, 404, { ok: false, error: `未知接口 ${key}` });
    } catch (e) {
        warn('请求处理异常', pathname, e.message);
        try {
            sendJson(res, 500, { ok: false, error: e.message });
        } catch {
            /* ignore */
        }
    }
});

function listen(port, attempt = 0) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 10) {
            warn(`端口 ${port} 被占用，试 ${port + 1}`);
            listen(port + 1, attempt + 1);
        } else {
            console.error('服务启动失败：', e.message);
            process.exit(1);
        }
    });
    server.listen(port, HOST, () => {
        const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${port}`;
        console.log('');
        console.log('  火山方舟 · 图片风格迁移工具');
        console.log(`  ▸ 打开界面： ${url}`);
        console.log(`  ▸ 工具目录： ${ROOT}`);
        console.log(`  ▸ 默认输出： ${DEFAULT_OUT_DIR}`);
        console.log(`  ▸ API Key ： ${effectiveApiKey() ? `已配置（${maskKey(effectiveApiKey())}）` : '未配置 —— 打开界面右上角「设置」填写，或设环境变量 ARK_API_KEY'}`);
        console.log('');
        if (arg('open', true) !== false && process.platform === 'win32') {
            execFile('cmd', ['/c', 'start', '', url], () => {});
        }
    });
}

listen(PORT);
