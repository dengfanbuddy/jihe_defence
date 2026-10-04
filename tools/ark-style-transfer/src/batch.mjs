/**
 * 批量任务引擎
 *
 * 一张图一个任务：读图 → 调接口 → 抠图 → 落盘。支持并发、重试、跳过已完成、取消、
 * 以及「只重跑抠图」（用上次模型直出的 _raw 图，不再花钱调接口）。
 * 进度与每条结果通过事件回调推给服务端（再经 SSE 推给浏览器）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { newId, listImages, runPool, log, warn, toCsv } from './util.mjs';
import { processOne } from './pipeline.mjs';
import { findModel } from './config.mjs';

const jobs = new Map();

export function getJob(id) {
    return jobs.get(id) || null;
}

export function listJobs() {
    return [...jobs.values()].map((j) => j.snapshot());
}

export function createJob(opts) {
    const job = new BatchJob(opts);
    jobs.set(job.id, job);
    // 只保留最近 30 个任务
    const all = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (all.length > 30) jobs.delete(all.shift().id);
    return job;
}

export class BatchJob extends EventEmitter {
    constructor(opts) {
        super();
        this.id = newId('job');
        this.createdAt = Date.now();
        this.opts = opts;
        this.status = 'pending'; // pending | running | done | cancelled | failed
        this.cancelled = false;
        this.items = [];
        this.startedAt = 0;
        this.finishedAt = 0;
        this.error = '';
        this.outDir = opts.outDir;
        this.mode = opts.mode || 'generate';
        this.estimate = null;
    }

    snapshot() {
        const done = this.items.filter((i) => i.status === 'done').length;
        const failed = this.items.filter((i) => i.status === 'failed').length;
        const skipped = this.items.filter((i) => i.status === 'skipped').length;
        const running = this.items.filter((i) => i.status === 'running').length;
        const total = this.items.length;
        const finished = done + failed + skipped;
        const elapsed = (this.finishedAt || Date.now()) - (this.startedAt || Date.now());
        const per = finished > 0 ? elapsed / finished : 0;
        return {
            id: this.id,
            status: this.status,
            mode: this.mode,
            outDir: this.outDir,
            total,
            done,
            failed,
            skipped,
            running,
            pending: total - finished - running,
            percent: total ? Math.round((finished / total) * 100) : 0,
            elapsedMs: elapsed,
            etaMs: per > 0 ? Math.round(per * (total - finished)) : 0,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
            items: this.items,
            opts: {
                inDir: this.opts.inDir,
                recursive: this.opts.recursive,
                limit: this.opts.limit,
                concurrency: this.opts.concurrency,
                retries: this.opts.retries,
                skipExisting: this.opts.skipExisting,
                model: this.opts.params?.resolvedModel || this.opts.params?.model,
            },
        };
    }

    cancel(reason = '用户取消') {
        if (this.status !== 'running' && this.status !== 'pending') return false;
        this.cancelled = true;
        this.error = reason;
        this.emit('log', { level: 'warn', message: reason });
        this.controller?.abort();
        return true;
    }

    async run() {
        const { params, ref, outDir, inDir, recursive, limit, offset, skipExisting } = this.opts;
        this.status = 'running';
        this.startedAt = Date.now();
        this.controller = new AbortController();
        try {
            const files = listImages(inDir, { recursive, limit, offset });
            this.items = files.map((f) => ({
                name: path.basename(f, path.extname(f)),
                file: f,
                status: 'pending',
                ms: 0,
                attempts: 0,
                message: '',
                warnings: [],
                outputPath: '',
                thumbPath: '',
                width: 0,
                height: 0,
            }));
            this.emit('log', { level: 'info', message: `共 ${files.length} 张待处理 → ${outDir}` });
            this.emit('progress', this.snapshot());

            const model = findModel(params.resolvedModel);
            const price = model?.priceCNY ?? 0.2;
            this.estimate = { count: this.items.length, priceCNY: price, totalCNY: +(this.items.length * price).toFixed(2) };

            await runPool(
                this.items,
                params.concurrency,
                async (item, i) => {
                    if (this.cancelled) {
                        item.status = 'skipped';
                        item.message = '已取消';
                        return;
                    }
                    const destExt = params.alphaMode === 'none' && params.outputFormat === 'jpeg' ? '.jpg' : '.png';
                    const dest = path.join(outDir, item.name + destExt);
                    // 断点续跑：两种模式都按「目标文件是否已存在」判断（只重跑抠图时想全量重做就取消勾选）
                    if (skipExisting && fs.existsSync(dest)) {
                        item.status = 'skipped';
                        item.message = '已存在，跳过';
                        item.outputPath = dest;
                        this.emit('item', item);
                        this.emit('progress', this.snapshot());
                        return;
                    }
                    item.status = 'running';
                    this.emit('item', item);
                    this.emit('progress', this.snapshot());
                    try {
                        const r = await processOne({
                            params,
                            apiKey: this.opts.apiKey,
                            baseUrl: this.opts.baseUrl,
                            ref,
                            target: { path: item.file },
                            outDir,
                            outName: item.name,
                            mode: this.mode,
                            signal: this.controller.signal,
                            onStep: (s) => this.emit('step', { name: item.name, step: s }),
                        });
                        item.status = 'done';
                        item.outputPath = r.outputPath;
                        item.thumbPath = r.thumbPath;
                        item.width = r.width;
                        item.height = r.height;
                        item.ms = r.ms;
                        item.attempts = r.attempts;
                        item.warnings = r.warnings || [];
                        item.alpha = r.alpha;
                        item.bytes = r.bytes;
                        item.usage = r.usage;
                    } catch (e) {
                        item.status = 'failed';
                        item.message = e?.message || String(e);
                        item.errorCode = e?.code || '';
                        item.errorHint = e?.hint || '';
                        item.errorStatus = e?.status || 0;
                        item.attempts = e?.attempts || 0;
                        warn(`失败 ${item.name}：${item.message}`);
                    }
                    this.emit('item', item);
                    this.emit('progress', this.snapshot());
                },
                () => this.cancelled
            );

            this.status = this.cancelled ? 'cancelled' : 'done';
        } catch (e) {
            this.status = 'failed';
            this.error = e?.message || String(e);
            warn('批量任务异常：', this.error);
        } finally {
            this.finishedAt = Date.now();
            try {
                this.writeReport();
            } catch (e) {
                warn('写报告失败：', e.message);
            }
            this.emit('progress', this.snapshot());
            this.emit('finished', this.snapshot());
            log(`任务 ${this.id} ${this.status}：成功/失败/跳过 = ${this.snapshot().done}/${this.snapshot().failed}/${this.snapshot().skipped}`);
        }
    }

    /** 写 _report.json / _report.csv（便于人工复核与二次处理） */
    writeReport() {
        const s = this.snapshot();
        fs.mkdirSync(this.outDir, { recursive: true });
        const payload = {
            jobId: this.id,
            status: s.status,
            mode: s.mode,
            inDir: this.opts.inDir,
            outDir: this.outDir,
            params: { ...this.opts.params, prompt: `${(this.opts.params.prompt || '').slice(0, 200)}…` },
            apiKeyUsed: this.opts.apiKey ? 'yes' : 'no',
            ref: this.opts.ref?.path || (this.opts.ref?.dataUrl ? '(上传的参考图)' : ''),
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            elapsedMs: s.elapsedMs,
            counts: { total: s.total, done: s.done, failed: s.failed, skipped: s.skipped },
            estimate: this.estimate,
            items: this.items.map((i) => ({
                name: i.name,
                status: i.status,
                file: i.file,
                outputPath: i.outputPath,
                ms: i.ms,
                width: i.width,
                height: i.height,
                bytes: i.bytes,
                message: i.message,
                errorCode: i.errorCode || '',
                errorHint: i.errorHint || '',
                warnings: i.warnings,
                alpha: i.alpha
                    ? {
                          mode: i.alpha?.mode,
                          keyColor: i.alpha?.keyColor,
                          // 优先用「成品实测」的透明占比（写盘后的那张图，任何模式都有），
                          // 退回色键中间态统计（老报告字段兼容）
                          transparentRatio: i.alpha?.output?.transparentRatio ?? i.alpha?.stats?.transparentRatio,
                          partialRatio: i.alpha?.output?.partialRatio ?? i.alpha?.stats?.partialRatio,
                          alphaOk: i.alpha?.alphaOk,
                          bbox: i.alpha?.output?.bbox ?? i.alpha?.stats?.bbox,
                          warnings: i.alpha?.stats?.warnings,
                      }
                    : null,
            })),
        };
        fs.writeFileSync(path.join(this.outDir, '_report.json'), JSON.stringify(payload, null, 2), 'utf8');
        const cols = [
            'name',
            'status',
            'outputPath',
            'ms',
            'width',
            'height',
            'bytes',
            'message',
            'errorCode',
            'keyColor',
            'transparentRatio',
            'alphaOk',
            'warnings',
        ];
        const rows = payload.items.map((i) => ({
            name: i.name,
            status: i.status,
            outputPath: i.outputPath,
            ms: i.ms,
            width: i.width,
            height: i.height,
            bytes: i.bytes,
            message: i.message,
            errorCode: i.errorCode,
            keyColor: i.alpha?.keyColor || '',
            transparentRatio: i.alpha?.transparentRatio != null ? i.alpha.transparentRatio.toFixed(4) : '',
            alphaOk: i.alpha ? (i.alpha.alphaOk === false ? 'NO-TRANSPARENCY' : 'ok') : '',
            warnings: (i.warnings || []).join(' / '),
        }));
        fs.writeFileSync(path.join(this.outDir, '_report.csv'), '\ufeff' + toCsv(rows, cols), 'utf8');
        this.reportPath = path.join(this.outDir, '_report.json');
    }
}
