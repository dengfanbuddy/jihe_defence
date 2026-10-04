/**
 * 火山方舟（Ark）图片生成 API 客户端
 *
 * 端点：POST {baseUrl}/images/generations
 * 鉴权：Authorization: Bearer <ARK_API_KEY>
 * 文档：https://www.volcengine.com/docs/82379/1541523
 *
 * 只做三件事：拼请求体、发请求（带超时/重试）、把图片字节拿回来。
 * 任何业务判断（尺寸是否合法、是否支持透明通道）都不在这里做。
 */

import { sleep, backoffMs, bufToDataUrl } from './util.mjs';

export const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
    'RateLimitExceeded',
    'ServerOverloaded',
    'InternalError',
    'InternalServiceError',
    'ServiceUnavailable',
    'Timeout',
    'RequestTimeout',
]);

/** 把方舟返回的错误码翻成「人话 + 下一步怎么办」 */
export function explainError(code, message = '', status = 0) {
    const c = String(code || '');
    const m = String(message || '');
    const both = `${c} ${m}`;
    if (/Authentication|InvalidApiKey|Unauthorized|401/i.test(both))
        return 'API Key 无效或没有带上。请在「设置」里粘贴火山方舟的长效 API Key（控制台 → API Key 管理）。';
    if (/AccessDenied|403|Forbidden/i.test(both))
        return '没有该模型的调用权限。去火山方舟控制台「开通管理」把这个模型开通。';
    if (/ModelNotOpen|ModelNotFound|model.*not.*(found|exist)|does not exist/i.test(both))
        return '模型 ID 不对，或这个模型还没开通。控制台「开通管理」里开通后，用「模型 ID」（形如 doubao-seedream-5-0-flash-260628）或 Endpoint ID。';
    if (/QuotaExceeded|InsufficientBalance|AccountOverdue|欠费|余额/i.test(both))
        return '账户余额不足或额度用尽，请到火山方舟控制台充值／提额。';
    if (/RateLimitExceeded|429|Throttling|too many requests/i.test(both))
        return '触发限流。把「并发」调小（建议 1~2）或稍后重试。';
    if (/SensitiveContent|RiskContent|content.*(policy|moderation)|审核/i.test(both))
        return '内容审核未通过。换一版提示词或换一张目标图再试。';
    if (/InvalidParameter|invalid.*(size|image|prompt|background)/i.test(both))
        return '参数不被该模型接受。检查尺寸档位/自定义宽高、output_format、background 是否与所选模型匹配。';
    if (status >= 500) return '服务端错误，已自动重试；持续失败可稍后再试。';
    return '接口返回错误，详见下方原始信息。';
}

/** 归一化错误对象 */
export function makeArkError({ status = 0, code = '', message = '', param = '', raw = null, requestId = '' }) {
    const err = new Error(message || code || `HTTP ${status}`);
    err.name = 'ArkError';
    err.status = status;
    err.code = code;
    err.param = param;
    err.raw = raw;
    err.requestId = requestId;
    err.hint = explainError(code, message, status);
    return err;
}

/**
 * 构造 /images/generations 的请求体
 * @param {object} o
 * @param {string} o.model       模型 ID / Endpoint ID
 * @param {string} o.prompt      提示词
 * @param {string[]} o.images    参考图（data URL 或公网 URL），[] 表示文生图
 * @param {string} o.size        尺寸档位（1K/2K/4K）或 `宽x高`
 * @param {string} o.outputFormat png | jpeg
 * @param {string} o.background  opaque | transparent
 * @param {boolean} o.watermark  是否加水印（我们要无水印 → false）
 * @param {string} o.responseFormat url | b64_json
 * @param {string} o.optimizePrompt none | fast | standard
 * @param {string} o.sequential  disabled | auto
 */
export function buildBody(o) {
    const body = {
        model: o.model,
        prompt: o.prompt,
        response_format: o.responseFormat || 'b64_json',
        watermark: !!o.watermark,
    };
    if (o.images && o.images.length) body.image = o.images.length === 1 ? o.images[0] : o.images;
    if (o.size) body.size = o.size;
    if (o.outputFormat) body.output_format = o.outputFormat;
    if (o.background && o.background !== 'opaque') body.background = o.background;
    if (o.optimizePrompt && o.optimizePrompt !== 'none') body.optimize_prompt_options = { mode: o.optimizePrompt };
    if (o.sequential && o.sequential !== 'disabled') body.sequential_image_generation = o.sequential;
    return body;
}

/**
 * 调用方舟并返回图片字节
 * @returns {Promise<{images: Buffer[], format: string, size: string, usage: object, ms: number, attempts: number, requestId: string, requestBody: object}>}
 */
export async function generateImage(opts, { onStep = () => {}, signal } = {}) {
    const {
        apiKey,
        baseUrl = BASE_URL,
        timeoutMs = 300000,
        retries = 2,
        ...rest
    } = opts;

    if (!apiKey) throw makeArkError({ code: 'NoApiKey', message: '未配置 API Key' });

    const body = buildBody(rest);
    // 容错：baseUrl 允许被写成完整端点（…/images/generations），这里剥掉，免得拼出重复路径
    const root = String(baseUrl).trim().replace(/\s+/g, '').replace(/\/+$/, '').replace(/\/images\/generations$/i, '');
    const url = `${root}/images/generations`;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal?.aborted) throw makeArkError({ code: 'Aborted', message: '已取消' });
        if (attempt > 0) {
            const wait = backoffMs(attempt - 1);
            onStep({ phase: 'retry', attempt, wait, error: lastErr?.message });
            await sleep(wait);
        }
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
        const t0 = Date.now();
        try {
            onStep({ phase: 'request', attempt: attempt + 1 });
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: ac.signal,
            });
            const requestId = res.headers.get('x-request-id') || res.headers.get('x-tt-logid') || '';
            const text = await res.text();
            let json = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (!res.ok) {
                const e = json?.error || json || {};
                lastErr = makeArkError({
                    status: res.status,
                    code: e.code || e.error?.code || `HTTP_${res.status}`,
                    message: e.message || text.slice(0, 600),
                    param: e.param || '',
                    raw: json ?? text.slice(0, 1000),
                    requestId,
                });
                if (!RETRYABLE_STATUS.has(res.status) && !RETRYABLE_CODES.has(lastErr.code)) throw lastErr;
                continue;
            }
            if (!json) {
                lastErr = makeArkError({ status: res.status, code: 'BadResponse', message: text.slice(0, 600), requestId });
                continue;
            }
            if (json.error) {
                const e = json.error;
                lastErr = makeArkError({
                    status: res.status,
                    code: e.code || 'Error',
                    message: e.message || '接口返回 error',
                    param: e.param,
                    raw: json,
                    requestId,
                });
                if (!RETRYABLE_CODES.has(lastErr.code)) throw lastErr;
                continue;
            }
            const data = Array.isArray(json.data) ? json.data : [];
            if (!data.length) {
                lastErr = makeArkError({ status: res.status, code: 'EmptyData', message: '接口没有返回图片', raw: json, requestId });
                continue;
            }
            onStep({ phase: 'download', count: data.length });
            const images = [];
            let format = data[0].output_format || rest.outputFormat || 'png';
            for (const item of data) {
                if (item.b64_json) {
                    images.push(Buffer.from(item.b64_json, 'base64'));
                } else if (item.url) {
                    const r = await fetch(item.url, { signal: ac.signal });
                    if (!r.ok) throw makeArkError({ status: r.status, code: 'DownloadFailed', message: `下载生成图失败：HTTP ${r.status}` });
                    images.push(Buffer.from(await r.arrayBuffer()));
                }
                if (item.output_format) format = item.output_format;
            }
            return {
                images,
                format,
                size: data[0].size || '',
                usage: json.usage || null,
                ms: Date.now() - t0,
                attempts: attempt + 1,
                requestId,
                requestBody: sanitizeBody(body),
            };
        } catch (e) {
            const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
            if (isAbort && signal?.aborted) throw makeArkError({ code: 'Aborted', message: '已取消' });
            const err =
                e?.name === 'ArkError'
                    ? e
                    : makeArkError({
                          status: 0,
                          code: isAbort ? 'Timeout' : 'NetworkError',
                          message: isAbort ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : e?.message || String(e),
                      });
            lastErr = err;
            if (!RETRYABLE_CODES.has(err.code) && err.status && !RETRYABLE_STATUS.has(err.status)) throw err;
            if (err.code === 'DownloadFailed') throw err;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
    throw lastErr || makeArkError({ code: 'Unknown', message: '调用失败' });
}

/** 日志/界面里展示请求体时，把超长的 base64 图片换成摘要 */
export function sanitizeBody(body) {
    const clone = { ...body };
    if (clone.image) {
        const arr = Array.isArray(clone.image) ? clone.image : [clone.image];
        const desc = arr.map((s) => (typeof s === 'string' && s.startsWith('data:') ? `${s.slice(0, 24)}…(${Math.round(s.length / 1024)}KB)` : s));
        clone.image = Array.isArray(clone.image) ? desc : desc[0];
    }
    if (typeof clone.prompt === 'string' && clone.prompt.length > 1200) clone.prompt = `${clone.prompt.slice(0, 1200)}…`;
    return clone;
}

/** 把内存里的图片转成接口可接受的 data URL（工具函数，便于测试） */
export function imageToDataUrl(buf, format = 'png') {
    return bufToDataUrl(buf, format);
}

/**
 * 从任意响应结构里捞出「看起来像模型 ID」的字符串。
 * 方舟/兼容 OpenAI 的网关返回结构不止一种（data[] / items[] / Result.Items[] / models[]），
 * 这里不假设 schema，直接在 JSON 里递归找形状像模型 ID 的字符串，避免结构一变就取不到。
 */
export function extractModelIds(json, limit = 300) {
    const ids = new Set();
    const looksLikeId = (v) =>
        typeof v === 'string' &&
        v.length >= 6 &&
        v.length <= 120 &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) &&
        /(doubao|seedream|seededit|seedance|seed-|dola|ep-|endpoint)/i.test(v);
    const walk = (node, depth = 0) => {
        if (node === null || node === undefined || depth > 8 || ids.size >= limit) return;
        if (Array.isArray(node)) {
            for (const v of node) walk(v, depth + 1);
            return;
        }
        if (typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === 'string' && looksLikeId(v) && /^(id|model|model_id|ModelId|modelId|Id|name|Name)$/.test(k)) {
                    ids.add(v);
                } else {
                    walk(v, depth + 1);
                }
            }
            return;
        }
        if (looksLikeId(node)) ids.add(node);
    };
    walk(json);
    return [...ids].sort();
}

/**
 * 拉取「当前 API Key 能用哪些模型」。
 * 方舟数据面按 OpenAI 兼容方式实现，通常可以 GET /models 列出可用模型；
 * 若该端点在当前账号/区域不可用，把接口原始报错带回去（由界面提示改用控制台复制的模型 ID），不静默失败。
 */
export async function listModels({ apiKey, baseUrl = BASE_URL, timeoutMs = 20000 } = {}) {
    if (!apiKey) throw makeArkError({ code: 'NoApiKey', message: '未配置 API Key' });
    const root = String(baseUrl).replace(/\/+$/, '').replace(/\/images\/generations$/i, '');
    const attempts = [`${root}/models`, `${root}/models?limit=200`];
    let lastErr = null;
    for (const url of attempts) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                signal: ac.signal,
            });
            const text = await res.text();
            let json = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (!res.ok) {
                const e = json?.error || json || {};
                lastErr = makeArkError({
                    status: res.status,
                    code: e.code || `HTTP_${res.status}`,
                    message: e.message || text.slice(0, 400),
                    raw: json ?? text.slice(0, 600),
                });
                continue;
            }
            const ids = extractModelIds(json);
            if (!ids.length) {
                lastErr = makeArkError({ code: 'NoModelsParsed', message: '接口返回成功，但没解析出模型 ID', raw: text.slice(0, 800) });
                continue;
            }
            return { ids, endpoint: url, raw: text.slice(0, 1500) };
        } catch (e) {
            lastErr = e?.name === 'ArkError' ? e : makeArkError({ code: 'NetworkError', message: e?.message || String(e) });
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || makeArkError({ code: 'Unknown', message: '拉取模型列表失败' });
}

/**
 * 免费校验一个模型 ID 能不能用于图片生成。
 *
 * 原理：发一个**不可能生成成功**的请求（尺寸 1x1 + 一张 1 字节的坏图），
 * 然后看报错落在哪一类：
 *   - `InvalidEndpointOrModel.NotFound`  → 模型 ID 不可用（未开通 / 名字不对）
 *   - 其它错误（参数错、图片解码错…）    → 说明网关已经认了这个模型，ID 可用
 * 因为请求本身不可能通过参数校验，所以不会真的出图、不会计费。
 */
export async function probeModelId({ apiKey, baseUrl = BASE_URL, model, timeoutMs = 30000 } = {}) {
    if (!apiKey) throw makeArkError({ code: 'NoApiKey', message: '未配置 API Key' });
    const root = String(baseUrl).replace(/\/+$/, '').replace(/\/images\/generations$/i, '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetch(`${root}/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                prompt: 'x',
                image: 'data:image/png;base64,iVBORw0KGgo=', // 故意给一张坏图，保证不会被真的执行
                size: '1x1',
                response_format: 'b64_json',
                watermark: false,
            }),
            signal: ac.signal,
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        const e = json?.error || {};
        const code = e.code || `HTTP_${res.status}`;
        const message = e.message || text.slice(0, 300);
        const modelMissing = /InvalidEndpointOrModel|ModelNotOpen|ModelNotFound/i.test(code) || /does not exist or you do not have access/i.test(message);
        return {
            model,
            usable: res.ok ? true : !modelMissing,
            generated: res.ok, // 真出图了（意料之外，说明参数校验被跳过）
            status: res.status,
            code,
            message,
            ms: Date.now() - t0,
        };
    } catch (err) {
        return {
            model,
            usable: null,
            status: 0,
            code: err?.name === 'AbortError' ? 'Timeout' : 'NetworkError',
            message: err?.message || String(err),
            ms: Date.now() - t0,
        };
    } finally {
        clearTimeout(timer);
    }
}
