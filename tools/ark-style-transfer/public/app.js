/* 火山方舟 · 图片风格迁移 —— 前端逻辑（无框架，单文件） */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** 与后端 DEFAULT_PARAMS 同构的界面状态 */
const S = {
    cfg: null,
    params: {},
    ref: null, // {name, dataUrl} | {path, name}
    target: null,
    outDir: '',
    result: null,
    jobId: null,
    es: null,
    items: new Map(),
    scan: null,
    lastResultMeta: null,
};

const PARAM_FIELDS = [
    'prompt', 'styleDesc', 'labelImages', 'appendKeyInstruction', 'model', 'customModel', 'useRef',
    'sizeMode', 'sizeTier', 'sizeW', 'sizeH', 'optimizePrompt', 'outputFormat', 'jpegQuality',
    'watermark', 'sequential', 'inputMaxEdge', 'inputUpscale', 'timeoutMs', 'retries',
    'alphaMode', 'keyColor', 'keyAuto', 'keyTolerance', 'localGrow', 'despill', 'shrinkEdge',
    'trim', 'trimMargin', 'padSquare', 'padSquarePad', 'outSize', 'outDir',
];

/** 批量页的控件 id 与读法（不在 PARAM_FIELDS 里，单独读写，保证批量设置也能记住） */
const BATCH_FIELDS = [
    ['inDir', 'b_inDir', 'text'],
    ['concurrency', 'b_concurrency', 'number'],
    ['retries', 'b_retries', 'number'],
    ['recursive', 'b_recursive', 'checkbox'],
    ['limit', 'b_limit', 'number'],
    ['skipExisting', 'b_skipExisting', 'checkbox'],
];

/* ------------------------------------------------------------------ 小工具 */

function toast(msg, kind = '', title = '') {
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.innerHTML = `${title ? `<b>${escapeHtml(title)}</b>` : ''}${escapeHtml(msg)}`;
    $('#toasts').appendChild(d);
    setTimeout(() => {
        d.style.opacity = '0';
        d.style.transition = 'opacity .3s';
        setTimeout(() => d.remove(), 320);
    }, kind === 'err' ? 12000 : 5200);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, body, method = 'POST') {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    }
    const json = await res.json();
    if (!res.ok && json.error) throw Object.assign(new Error(json.error), json);
    return json;
}

const imgUrl = (src, w = 0) => {
    if (!src) return '';
    const raw = src.dataUrl ? src.dataUrl : `/api/image?path=${encodeURIComponent(src.path)}${w ? `&w=${w}` : ''}`;
    return raw;
};
const pathUrl = (p, w = 0) => (p ? `/api/image?path=${encodeURIComponent(p)}${w ? `&w=${w}` : ''}` : '');
const fmtMs = (ms) => (!ms ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtBytes = (n) => (!n ? '-' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtEta = (ms) => {
    if (!ms) return '-';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/* ------------------------------------------------------------------ 启动 */

async function boot() {
    bindEvents();
    try {
        S.cfg = await api('/api/config', null, 'GET');
    } catch (e) {
        toast(`无法连接本地服务：${e.message}`, 'err');
        return;
    }
    S.params = { ...S.cfg.defaults };
    renderModels();
    renderPresets();
    applyParams(S.params);
    S.outDir = S.params.outDir || S.cfg.defaultOutDir;
    $('#f_outDir').value = S.outDir;
    $('#b_outDir').value = S.outDir;
    refreshKeyBadge();
    $('#s_baseUrl').value = S.cfg.baseUrl;
    updatePromptPreview();
}

function refreshKeyBadge() {
    const b = $('#keyBadge');
    if (!S.cfg) return;
    if (S.cfg.hasKey) {
        b.className = 'badge ok';
        b.textContent = `API Key ${S.cfg.keyMask}${S.cfg.keySource === 'env' ? '（环境变量）' : ''}`;
    } else {
        b.className = 'badge bad';
        b.textContent = '未配置 API Key —— 点「设置」';
    }
}

/* ------------------------------------------------------------------ 表单 ⇄ 状态 */

function renderModels() {
    const sel = $('#f_model');
    const cur = sel.value;
    const all = S.cfg.models;
    // ✓/✗ 用「免费校验」的真实结果（账户模型列表里带日期的别名其实不能生图，不能当依据）
    const mark = (m) => (m.probed === null || m.probed === undefined ? '' : m.probed ? '✓ ' : '✗ ');
    let html = '<optgroup label="内置模型（✗ = 校验过不可用，点「校验模型 ID」刷新）">';
    html += all.map((m) => `<option value="${m.id}">${mark(m)}${escapeHtml(m.label)} — ${m.id}</option>`).join('');
    html += '</optgroup>';
    const known = new Set(all.flatMap((m) => [m.id, ...(m.aliases || [])]));
    const account = (S.cfg.accountModels || []).filter((id) => !known.has(id));
    if (account.length) {
        const when = S.cfg.accountModelsAt ? new Date(S.cfg.accountModelsAt).toLocaleString('zh-CN') : '';
        html += `<optgroup label="账户模型列表里还有 ${account.length} 个（列表不代表能生图，选中后点「校验模型 ID」）">`;
        html += account.map((id) => `<option value="${id}">${escapeHtml(id)}</option>`).join('');
        html += '</optgroup>';
    }
    sel.innerHTML = html;
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

/** 免费校验当前（或全部）模型 ID 能不能用于图片生成 */
async function probeModels(all = false) {
    if (!S.cfg.hasKey) {
        toast('先配置 API Key', 'err');
        return openModal();
    }
    const id = currentModelId();
    const btn = $('#btnProbeModel');
    if (btn) btn.disabled = true;
    $('#genStatus').textContent = all ? '正在校验全部模型 ID…' : `正在校验 ${id}…`;
    try {
        const r = await api('/api/models/probe', all ? { all: true } : { model: id });
        S.cfg = await api('/api/config', null, 'GET');
        renderModels();
        syncModelUi();
        if (all) {
            const bad = (r.results || []).filter((x) => x.usable === false);
            const good = (r.results || []).filter((x) => x.usable === true);
            toast(`可用 ${good.length} 个，不可用 ${bad.length} 个（共校验 ${r.results.length} 个，未计费）`, 'ok', '模型校验完成');
        } else {
            const one = r.results?.[0];
            toast(
                one?.usable ? `${id} 可用于图片生成（未计费）` : `${id} 不可用：${one?.message || one?.code || ''}`,
                one?.usable ? 'ok' : 'err',
                '模型校验'
            );
        }
    } catch (e) {
        toast(e.message, 'err', '校验失败');
    } finally {
        if (btn) btn.disabled = false;
        $('#genStatus').textContent = '';
    }
}

/** 问方舟「我这个 Key 能用哪些模型」，把真实 ID 列进下拉 */
async function fetchAccountModels(silent = false) {
    if (!S.cfg.hasKey) {
        if (!silent) {
            toast('先配置 API Key', 'err');
            openModal();
        }
        return null;
    }
    const btns = [$('#btnFetchModels'), $('#btnFetchModels2')].filter(Boolean);
    btns.forEach((b) => (b.disabled = true));
    if (!silent) $('#genStatus').textContent = '正在拉取账户模型…';
    try {
        const r = await api('/api/models', {});
        if (!r.ok) {
            if (!silent) toast(r.error, 'err', '拉取失败');
            return r;
        }
        S.cfg.accountModels = r.ids;
        S.cfg.accountModelsAt = r.at;
        renderModels();
        const rel = r.relevant || [];
        toast(
            `账户里共 ${r.ids.length} 个模型${rel.length ? `，图片相关 ${rel.length} 个：\n${rel.slice(0, 8).join('\n')}` : ''}`,
            'ok',
            '已拉取账户模型'
        );
        if (rel.length && !rel.some((id) => id === currentModelId())) {
            toast(`当前选的「${currentModelId()}」不在账户可用列表里，建议改成上面列出的图片模型`, 'warn');
        }
        return r;
    } catch (e) {
        if (!silent) toast(e.message, 'err', '拉取失败');
        return null;
    } finally {
        btns.forEach((b) => (b.disabled = false));
        $('#genStatus').textContent = '';
    }
}

function currentModelId() {
    return ($('#f_customModel').value || '').trim() || $('#f_model').value;
}

/** 报错文案像不像「模型 ID 不对 / 没开通」 */
function isModelProblem(r) {
    return /model/i.test(`${r.code || ''} ${r.error || ''}`) && /not.*(exist|found)|no access|access to it|ModelNotOpen|ModelNotFound|不存在|未开通/i.test(`${r.code || ''} ${r.error || ''} ${r.hint || ''}`);
}

function renderPresets() {
    const sel = $('#presetSel');
    sel.innerHTML = `<option value="">提示词预设…</option>` + S.cfg.presets.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
}

function applyParams(p) {
    for (const name of PARAM_FIELDS) {
        const el = document.getElementById(`f_${name}`);
        if (!el) continue;
        const v = p[name];
        if (el.type === 'checkbox') el.checked = !!v;
        else if (v !== undefined && v !== null) el.value = v;
    }
    // timeoutMs 界面用秒
    if (p.timeoutMs) $('#f_timeoutMs').value = Math.round(p.timeoutMs / 1000);
    else $('#f_timeoutMs').value = 300;
    // 批量页控件也恢复上次的值
    for (const [name, id, kind] of BATCH_FIELDS) {
        const el = document.getElementById(id);
        if (!el || p[name] === undefined || p[name] === null) continue;
        if (kind === 'checkbox') el.checked = !!p[name];
        else el.value = p[name];
    }
    syncModelUi();
    syncAlphaUi();
    syncSizeUi();
    syncRanges();
}

function readParams() {
    const p = {};
    for (const name of PARAM_FIELDS) {
        const el = document.getElementById(`f_${name}`);
        if (!el) continue;
        if (el.type === 'checkbox') p[name] = el.checked;
        else if (el.type === 'number' || el.type === 'range') p[name] = el.value === '' ? 0 : Number(el.value);
        else p[name] = el.value;
    }
    p.timeoutMs = (Number($('#f_timeoutMs').value) || 300) * 1000;
    // 批量页控件（与单图页分开，但同样会被记住）
    for (const [name, id, kind] of BATCH_FIELDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (kind === 'checkbox') p[name] = el.checked;
        else if (kind === 'number') p[name] = Number(el.value) || 0;
        else p[name] = el.value.trim();
    }
    p.retriesSingle = p.retries;
    p.outDir = S.outDir;
    return p;
}

function syncModelUi() {
    const id = $('#f_customModel').value.trim() || $('#f_model').value;
    const m = S.cfg.models.find((x) => x.id === id || (x.aliases || []).includes(id));
    const tierSel = $('#f_sizeTier');
    const tiers = m ? m.sizeTiers : ['1K', '2K', '4K'];
    const cur = tierSel.value;
    tierSel.innerHTML = tiers.map((t) => `<option value="${t}">${t}</option>`).join('');
    tierSel.value = tiers.includes(cur) ? cur : m?.defaultSize || tiers[0];
    const caps = [];
    caps.push(`<span class="chip">${m ? escapeHtml(m.label) : '自定义模型 ID'}</span>`);
    if (m && m.probed === false) caps.push('<span class="chip warn">✗ 校验过：该 ID 不能生图</span>');
    else if (m && m.probed === true) caps.push('<span class="chip ok">✓ 校验过可用</span>');
    else if (id) caps.push('<span class="chip">未校验（点「校验模型 ID」）</span>');
    caps.push(`<span class="chip">尺寸 ${tiers.join('/')}</span>`);
    caps.push(`<span class="chip">参考图 ≤ ${m?.maxRefImages ?? 14} 张</span>`);
    caps.push(`<span class="chip ${m?.png ? 'ok' : 'warn'}">${m?.png ? 'PNG 输出' : '仅 jpeg'}</span>`);
    caps.push(`<span class="chip ${m?.transparent ? 'ok' : ''}">${m?.transparent ? '接口透明：仅保留单图已有 alpha' : '接口透明未标注'}</span>`);
    if (m?.priceCNY) caps.push(`<span class="chip">≈${m.priceCNY} 元/张</span>`);
    $('#modelCaps').innerHTML = caps.join('');
    if (m?.notes) $('#modelCaps').title = m.notes;
    syncSizeUi();
}

function syncSizeUi() {
    $('#f_sizeTier').disabled = $('#f_sizeMode').value !== 'tier';
    const showWarn = $('#f_sizeMode').value === 'custom';
    $('#wrapCustomSize').style.opacity = showWarn ? '1' : '.45';
}

function syncAlphaUi() {
    const mode = $('#f_alphaMode').value;
    const useRef = $('#f_useRef').checked;
    $('#chromaBox').style.display = mode === 'chroma' ? '' : 'none';
    const chips = [];
    let tip = '';
    if (mode === 'chroma') {
        chips.push('<span class="chip ok">本地色键抠图</span>');
        if ($('#f_keyAuto').checked) chips.push('<span class="chip">自动探测背景色</span>');
        if ($('#f_despill').checked) chips.push('<span class="chip">去溢色</span>');
        if (Number($('#f_shrinkEdge').value) > 0) chips.push(`<span class="chip">收边 ${$('#f_shrinkEdge').value}px</span>`);
        tip = '提示词里要求一个纯色背景（如 #FF00FF），模型直出后本地抠掉 —— 双图风格迁移只能走这条路。';
    } else if (mode === 'api') {
        chips.push('<span class="chip warn">接口直出透明：仅 1 张输入图</span>');
        tip =
            '方舟的 background=transparent 是「<b>保留</b>输入图已有的透明通道」，不是去背景，且要求恰好 1 张输入图、' +
            '该图至少有 1 个透明像素（否则接口直接报 400）。不透明图标要透明背景，请改用「色键抠图」。';
        if (useRef) {
            chips.push('<span class="chip err">与参考图互斥</span>');
            tip += '<br><b class="err">已启用参考图 —— 这两者不能同时用，生成会被拒绝（不会扣费）。</b>';
        }
    } else if (mode === 'source') {
        chips.push('<span class="chip">沿用目标图 alpha</span>');
        tip = '目标图本身就是抠好的透明 PNG 时用；输出的透明区域完全照抄目标图。';
    } else {
        chips.push('<span class="chip warn">不透明</span>');
        tip = '不做任何透明处理 → <b>输出一定是不透明的 PNG</b>，提示词里写"透明背景"也没用（模型给不出 alpha 通道）。';
    }
    if ($('#f_padSquare').checked) chips.push(`<span class="chip">补方形 ${$('#f_outSize').value || '原尺寸'}</span>`);
    $('#alphaChips').innerHTML = chips.join('');
    $('#alphaTip').innerHTML = tip;
    const prompt = $('#f_prompt').value || '';
    if (mode === 'none' && /透明|去背|抠图|transparent/i.test(prompt)) {
        $('#alphaTip').innerHTML +=
            '<br><b class="err">注意：提示词里要求了透明背景，但处理方式是「不处理」→ 拿到的会是不透明图。</b>';
    }
}

function syncRanges() {
    $('#tolVal').textContent = $('#f_keyTolerance').value;
    $('#growVal').textContent = $('#f_localGrow').value;
    $('#shrinkVal').textContent = $('#f_shrinkEdge').value;
}

let promptTimer = null;
function updatePromptPreview() {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(async () => {
        const p = readParams();
        const count = p.useRef && S.ref ? 2 : 1;
        try {
            const r = await api('/api/prompt/preview', { params: p, imageCount: count });
            $('#promptPreview').textContent = r.prompt || '(空)';
        } catch {
            /* 忽略预览失败 */
        }
    }, 220);
}

/* ------------------------------------------------------------------ 选图 */

function setImage(kind, src, name) {
    S[kind] = src ? { ...src, name: name || src.name || '' } : null;
    renderPicks();
    updatePromptPreview();
    if (kind === 'ref') renderBatchRef();
}

function renderPicks() {
    for (const kind of ['ref', 'target']) {
        const img = document.querySelector(`[data-preview="${kind}"]`);
        const ph = document.querySelector(`[data-ph="${kind}"]`);
        const src = S[kind];
        if (src) {
            img.src = imgUrl(src, 400);
            img.classList.remove('hidden');
            ph.classList.add('hidden');
        } else {
            img.removeAttribute('src');
            img.classList.add('hidden');
            ph.classList.remove('hidden');
        }
    }
}

function renderBatchRef() {
    const img = $('#b_refThumb');
    const ph = $('#b_refPh');
    if (S.ref) {
        img.src = imgUrl(S.ref, 200);
        img.classList.remove('hidden');
        ph.classList.add('hidden');
        $('#b_refName').textContent = `参考图：${S.ref.name || S.ref.path || '（已选）'}`;
    } else {
        img.removeAttribute('src');
        img.classList.add('hidden');
        ph.classList.remove('hidden');
        $('#b_refName').textContent = '未选择参考图（会用「单图调试台」里选的那张）';
    }
}

function fileToSource(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.onload = () => resolve({ dataUrl: fr.result, name: file.name });
        fr.readAsDataURL(file);
    });
}

async function assignFiles(kind, files) {
    const f = files?.[0];
    if (!f) return;
    if (!/^image\//.test(f.type) && !/\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i.test(f.name)) {
        toast(`${f.name} 不是图片`, 'err');
        return;
    }
    setImage(kind, await fileToSource(f), f.name);
    document.querySelector(`[data-path="${kind}"]`).value = '';
}

function pickFile(kind) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => assignFiles(kind, inp.files);
    inp.click();
}

/* ------------------------------------------------------------------ 单图生成 */

/** 「接口直出透明」与参考图互斥（接口要求恰好 1 张输入图）—— 生成/批量前统一拦截，避免白花钱 */
function apiTransparentConflict(p) {
    return p.alphaMode === 'api' && !!p.useRef;
}

function warnApiTransparentConflict() {
    toast(
        '「接口直出透明」只接受 1 张输入图，不能和参考图一起用（风格迁移做不了）',
        'err',
        '要做「参考图风格迁移 + 透明背景」→ 处理方式改用「色键抠图」；要单图接口透明 → 关掉「使用参考图」'
    );
}

async function generate() {
    const p = readParams();
    if (!p.useRef || !S.target) {
        if (!S.target) return toast('请先选择目标图', 'err');
    }
    if (p.useRef && !S.ref) return toast('开启了「使用参考图」但没选参考图；或关掉它走单图重绘', 'err');
    if (apiTransparentConflict(p)) return warnApiTransparentConflict();
    if (!S.cfg.hasKey) {
        toast('还没配置 API Key', 'err', '请先在右上角「设置」里填写火山方舟 API Key');
        openModal();
        return;
    }
    setBusy(true, '正在生成…');
    $('#cardError').classList.add('hidden');
    const t0 = Date.now();
    try {
        const r = await api('/api/generate', {
            params: p,
            ref: S.ref ? passable(S.ref) : null,
            target: passable(S.target),
            outDir: S.outDir,
        });
        if (!r.ok) return showError(r);
        showResult(r);
        persistParams(p);
        toast(`完成，用时 ${fmtMs(r.totalMs || Date.now() - t0)}${r.warnings?.length ? `（${r.warnings.length} 条提示）` : ''}`, 'ok');
    } catch (e) {
        showError({ error: e.message, hint: e.hint || '', code: e.code || '' });
    } finally {
        setBusy(false);
    }
}

/** 只把服务端需要的字段传过去（dataUrl 优先，否则 path） */
function passable(src) {
    if (!src) return null;
    if (src.dataUrl) return { dataUrl: src.dataUrl, name: src.name };
    return { path: src.path, name: src.name };
}

async function realpha() {
    const p = readParams();
    if (!S.target?.path && !S.lastResultMeta) return toast('先用「生成」跑一次（直出图会存在 _raw/），才能只重跑抠图', 'err');
    setBusy(true, '正在重跑抠图…');
    try {
        const r = await api('/api/generate', {
            params: p,
            target: passable(S.target),
            outName: S.lastResultMeta?.name,
            outDir: S.outDir,
            mode: 'realpha',
        });
        if (!r.ok) return showError(r);
        showResult(r);
        toast('已按新参数重跑抠图（没有再调接口）', 'ok');
    } catch (e) {
        showError({ error: e.message });
    } finally {
        setBusy(false);
    }
}

async function showError(r) {
    $('#cardError').classList.remove('hidden');
    const rows = [
        ['错误', r.error],
        r.code ? ['错误码', `${r.code}${r.status ? ` (HTTP ${r.status})` : ''}`] : null,
        r.hint ? ['怎么办', r.hint] : null,
        r.requestId ? ['RequestId', r.requestId] : null,
        r.raw ? ['原始返回', r.raw] : null,
        r.paramsWarnings?.length ? ['参数提示', r.paramsWarnings.join('；')] : null,
    ].filter(Boolean);
    const paint = (extra = '') =>
        ($('#errBody').innerHTML = `<div class="kv">${rows
            .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="val" style="color:${k === '怎么办' ? 'var(--warn)' : 'inherit'}">${escapeHtml(v)}</dd>`)
            .join('')}${extra}</div>`);
    paint();
    toast(r.error, 'err', r.code || '失败');
    setBusy(false);

    // 模型 ID 不对是最常见的坑（ID 带版本日期，随时会更新）→ 自动去问账户到底有哪些模型
    if (isModelProblem(r)) {
        $('#btnFetchModels2').classList.remove('hidden');
        const res = await fetchAccountModels(true);
        if (res?.ok && res.relevant?.length) {
            paint(
                `<dt>账户可用的图片模型</dt><dd class="val" style="color:var(--ok)">${res.relevant
                    .map(escapeHtml)
                    .join('<br />')}</dd><dt>下一步</dt><dd class="val">把上面某个模型 ID 粘到「自定义模型 ID」那一栏，再点生成</dd>`
            );
            toast(`你账户里有 ${res.relevant.length} 个图片模型，已列在错误卡片里`, 'ok', '找到可用的模型 ID');
        } else if (res && !res.ok) {
            paint(
                `<dt>备注</dt><dd class="val" style="color:var(--warn)">自动拉取账户模型失败：${escapeHtml(
                    res.hint || res.error || ''
                )}</dd>`
            );
        }
    }
}

function showResult(r) {
    S.result = r;
    S.lastResultMeta = r;
    $('#resEmpty').classList.add('hidden');
    const img = $('#resMain');
    img.src = `${pathUrl(r.outputPath)}&t=${Date.now()}`;
    img.classList.remove('hidden');
    $('#resMeta').textContent = `${r.width}×${r.height} · ${fmtBytes(r.bytes)} · ${fmtMs(r.ms)}`;
    ['btnDownload', 'btnReveal', 'btnCopyPath'].forEach((id) => ($(`#${id}`).disabled = false));
    // 对比
    document.querySelector('[data-cmp="target"]').src = S.target ? imgUrl(S.target, 400) : '';
    document.querySelector('[data-cmp="raw"]').src = pathUrl(r.rawPath, 400);
    document.querySelector('[data-cmp="out"]').src = `${pathUrl(r.outputPath, 400)}&t=${Date.now()}`;
    // QC
    const qc = [];
    const push = (k, v, cls = '') => qc.push(`<dt>${k}</dt><dd class="val ${cls}">${v}</dd>`);
    push('输出文件', r.outputPath);
    push('模型', r.requestBody?.model || '');
    push('接口尺寸', r.apiSize || '-');
    push('接口格式', r.apiFormat || '-');
    push('重试次数', r.attempts ?? 0);
    if (r.requestId) push('RequestId', r.requestId);
    if (r.usage) push('用量', JSON.stringify(r.usage));
    push('总耗时', `${fmtMs(r.ms)}（接口 ${fmtMs(r.apiMs)}）`);
    // 发出去的输入图（"换了参考图却没区别"第一个要确认的就是这个）
    if (r.inputs?.length) {
        push('输入图', r.inputs.map((i) => {
            const size = i.sourceWidth === i.sentWidth && i.sourceHeight === i.sentHeight
                ? `${i.sourceWidth}×${i.sourceHeight}`
                : `${i.sourceWidth}×${i.sourceHeight} → ${i.sentWidth}×${i.sentHeight}`;
            const flag = i.upscaled ? ' ⚠放大' : '';
            return `${escapeHtml(i.role)}：${escapeHtml(i.name || '')} ${size}${flag}`;
        }).join('<br />'));
    }
    if (r.alpha?.mode === 'chroma' && r.alpha.stats) {
        push('键色', `${r.alpha.keyColor}${r.alpha.keyDetected ? '（自动探测）' : ''}`);
        push('透明占比', `${(r.alpha.stats.transparentRatio * 100).toFixed(1)}%（半透明 ${(r.alpha.stats.partialRatio * 100).toFixed(1)}%）`);
        push('主体范围', r.alpha.stats.bbox ? `${r.alpha.stats.bbox.w}×${r.alpha.stats.bbox.h}` : '-');
        push('边缘修正', `${r.alpha.stats.edgePixelsFixed} px`);
    } else if (r.alpha?.mode === 'api') {
        push('透明来源', '接口直出 background=transparent');
    } else if (r.alpha?.mode === 'source') {
        push('透明来源', '沿用目标图 alpha');
    } else if (r.alpha?.mode === 'none') {
        push('透明来源', '未做透明处理（输出不透明 PNG）', 'err');
    }
    // 成品实测（量的是写盘后的那张图，不是中间态）—— 透明处理没生效时这里一定看得出来
    if (r.alpha?.output) {
        const t = r.alpha.output.transparentRatio * 100;
        const half = r.alpha.output.partialRatio * 100;
        if (r.alpha.alphaOk === false) {
            push('成品透明占比', `${t.toFixed(2)}%（半透明 ${half.toFixed(2)}%）—— 没有透明像素！`, 'err');
        } else if (r.alpha.mode !== 'none') {
            push('成品透明占比', `${t.toFixed(1)}%（半透明 ${half.toFixed(1)}%）`);
        }
    }
    const warns = [...(r.warnings || [])];
    if (warns.length) qc.push(`<dt>提示</dt><dd class="val" style="color:var(--warn)">${warns.map(escapeHtml).join('<br />')}</dd>`);
    qc.push(`<dt>提示词</dt><dd class="val" style="white-space:pre-wrap">${escapeHtml(r.prompt || '')}</dd>`);
    $('#qcBody').innerHTML = qc.join('');
}

function setBusy(busy, text = '') {
    $('#btnGenerate').disabled = busy;
    $('#btnRealpha').disabled = busy;
    $('#genStatus').textContent = busy ? text : '';
}

async function persistParams(p) {
    try {
        await api('/api/config', { params: p });
    } catch {
        /* 忽略 */
    }
}

/* ------------------------------------------------------------------ 批量 */

async function scan() {
    const dir = $('#b_inDir').value.trim();
    if (!dir) return toast('请填写输入文件夹', 'err');
    const p = readParams();
    $('#scanResult').textContent = '扫描中…';
    try {
        const r = await api('/api/scan', {
            dir,
            outDir: S.outDir,
            recursive: p.recursive,
            limit: p.limit,
            model: $('#f_customModel').value.trim() || $('#f_model').value,
        });
        if (!r.ok) {
            $('#scanResult').innerHTML = `<span class="err">${escapeHtml(r.error)}</span>`;
            return;
        }
        S.scan = r;
        $('#scanResult').innerHTML =
            `输入目录：<code>${escapeHtml(r.dir)}</code><br />找到 <b>${r.count}</b> 张图片` +
            (r.truncated ? `（下方只预览前 ${r.files.length} 张）` : '') +
            `<br />输出目录：<code>${escapeHtml(r.outDir)}</code>` +
            (r.estimate
                ? `<br />预估费用：<b>${r.estimate.totalCNY} 元</b>（${escapeHtml(r.estimate.model)} ≈ ${r.estimate.unitCNY} 元/张 × ${r.count}）`
                : '');
        updateCost(r.count, r.estimate);
    } catch (e) {
        $('#scanResult').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
    }
}

function updateCost(count, estimate) {
    const n = count ?? S.scan?.count ?? 0;
    const est = estimate ?? S.scan?.estimate;
    const mode = $('#b_mode').value;
    if (!n) {
        $('#costBox').textContent = '先填输入文件夹并点「扫描」，这里会显示张数与预估费用。';
        return;
    }
    if (mode === 'realpha') {
        $('#costBox').textContent = `「只重跑抠图」不会调用接口、不产生费用：用 ${S.outDir}\\_raw\\ 里已生成的直出图重新抠一遍。`;
        return;
    }
    const total = est ? est.totalCNY : (n * 0.2).toFixed(2);
    $('#costBox').innerHTML =
        `⚠ 批量会真实计费：约 <b>${n}</b> 张 × ${est ? est.unitCNY : 0.2} 元 ≈ <b>${total} 元</b>（实际以火山方舟账单为准）。` +
        `建议先把「只处理前 N 张」填 <b>3</b> 跑通，再改成 0 全量。输出与输入同名、不会覆盖原图。`;
}

async function startBatch() {
    const p = readParams();
    const inDir = $('#b_inDir').value.trim();
    if (!inDir) return toast('请填写输入文件夹', 'err');
    const mode = $('#b_mode').value;
    if (mode === 'generate' && !S.cfg.hasKey) {
        openModal();
        return toast('还没配置 API Key', 'err');
    }
    if (mode === 'generate' && p.useRef && !S.ref) {
        return toast('开启了「使用参考图」但没选参考图', 'err');
    }
    if (mode === 'generate' && apiTransparentConflict(p)) return warnApiTransparentConflict();
    $('#resultGrid').innerHTML = '<div class="muted">跑完后这里会显示对照。</div>';
    $('#itemList').innerHTML = '';
    S.items.clear();
    const r = await api('/api/batch', {
        params: p,
        ref: S.ref ? passable(S.ref) : null,
        inDir,
        outDir: S.outDir,
        mode,
        recursive: p.recursive,
        limit: p.limit,
        skipExisting: p.skipExisting,
    });
    if (!r.ok) return toast(r.error, 'err');
    S.jobId = r.jobId;
    $('#btnStart').disabled = true;
    $('#btnCancel').disabled = false;
    $('#btnZip').disabled = true;
    $('#btnReport').disabled = true;
    attachEvents(r.jobId);
    (r.warnings || []).forEach((w) => toast(w, 'warn'));
}

function attachEvents(jobId) {
    S.es?.close();
    const es = new EventSource(`/api/batch/${jobId}/events`);
    S.es = es;
    es.addEventListener('progress', (ev) => renderProgress(JSON.parse(ev.data)));
    es.addEventListener('item', (ev) => {
        const it = JSON.parse(ev.data);
        S.items.set(it.name, it);
        renderItemRow(it);
    });
    es.addEventListener('log', (ev) => {
        const l = JSON.parse(ev.data);
        if (l.level === 'warn') toast(l.message, 'warn');
    });
    es.addEventListener('finished', (ev) => {
        const s = JSON.parse(ev.data);
        renderProgress(s);
        es.close();
        S.es = null;
        $('#btnStart').disabled = false;
        $('#btnCancel').disabled = true;
        $('#btnZip').disabled = false;
        $('#btnReport').disabled = false;
        renderGrid(s);
        toast(`批量结束：成功 ${s.done} / 失败 ${s.failed} / 跳过 ${s.skipped}，用时 ${fmtMs(s.elapsedMs)}`, s.failed ? 'warn' : 'ok');
        if (s.failed) showFailures(s);
    });
    es.onerror = () => {
        if (S.es) toast('进度连接中断（任务可能仍在后台跑）', 'warn');
    };
}

function showFailures(s) {
    const fails = s.items.filter((i) => i.status === 'failed');
    const byCode = new Map();
    for (const f of fails) {
        const k = `${f.errorCode || 'ERR'} — ${f.errorHint || f.message}`;
        byCode.set(k, (byCode.get(k) || 0) + 1);
    }
    const top = [...byCode].sort((a, b) => b[1] - a[1]).slice(0, 3);
    toast(`${fails.length} 张失败。主要原因：\n` + top.map(([k, n]) => `${n} 张：${k}`).join('\n'), 'err', '批量结果');
    // 失败集中在「模型不存在」时，直接帮用户把账户可用的模型列出来
    const modelProblem = top.length > 0 && /模型/.test(top[0][0]);
    if (modelProblem)
        fetchAccountModels(true).then((res) => {
            if (res?.ok && res.relevant?.length) toast(`账户可用的图片模型：\n${res.relevant.slice(0, 8).join('\n')}`, 'ok', '换一个模型 ID 再跑');
        });
}

function renderProgress(s) {
    const pct = s.total ? Math.round(((s.done + s.failed + s.skipped) / s.total) * 100) : 0;
    $('#bar').style.width = `${pct}%`;
    $('#barText').textContent = `${s.done + s.failed + s.skipped} / ${s.total}（成功 ${s.done} · 失败 ${s.failed} · 跳过 ${s.skipped}）`;
    $('#jobMeta').textContent =
        s.status === 'running'
            ? `运行中：耗时 ${fmtMs(s.elapsedMs)} · 预计剩余 ${fmtEta(s.etaMs)} · 并发 ${s.opts.concurrency}`
            : `状态：${s.status} · 耗时 ${fmtMs(s.elapsedMs)}`;
    $('#listMeta').textContent = `${s.total} 张`;
}

function renderItemRow(it) {
    let row = document.getElementById(`row_${cssId(it.name)}`);
    if (!row) {
        row = document.createElement('div');
        row.className = 'lrow';
        row.id = `row_${cssId(it.name)}`;
        row.innerHTML = `<img loading="lazy" /><div class="nm"></div><div class="st"></div><div class="ms"></div>`;
        $('#itemList').prepend(row);
    }
    const src = it.thumbPath ? pathUrl(it.thumbPath, 80) : S.scan?.files.find((f) => f.name.startsWith(it.name)) ? pathUrl(S.scan.files.find((f) => f.name.startsWith(it.name)).path, 80) : '';
    row.querySelector('img').src = src;
    row.querySelector('.nm').textContent = it.name;
    row.querySelector('.nm').title = it.message || '';
    const st = row.querySelector('.st');
    st.className = `st ${it.status}`;
    st.textContent =
        { pending: '等待', running: '处理中', done: '完成', failed: '失败', skipped: '跳过' }[it.status] || it.status;
    row.querySelector('.ms').textContent = it.ms ? fmtMs(it.ms) : '';
}

function cssId(s) {
    return String(s).replace(/[^a-zA-Z0-9_]/g, '_');
}

function renderGrid(s) {
    const onlyFail = $('#gridFailOnly').checked;
    const items = s.items.filter((i) => (onlyFail ? i.status === 'failed' : i.status === 'done' || i.status === 'failed'));
    if (!items.length) {
        $('#resultGrid').innerHTML = '<div class="muted">没有可显示的条目。</div>';
        return;
    }
    const shown = items.slice(0, 400);
    $('#resultGrid').innerHTML = shown
        .map((i) => {
            const before = pathUrl(i.file, 220);
            const after = i.outputPath ? `${pathUrl(i.outputPath, 220)}&t=1` : '';
            return `<div class="gitem ${i.status === 'failed' ? 'failed' : ''}">
        <div class="pair">
          <div class="box checker"><img loading="lazy" src="${before}" data-full="${pathUrl(i.file)}" title="原图" /></div>
          <div class="box checker">${after ? `<img loading="lazy" src="${after}" data-full="${pathUrl(i.outputPath)}" title="成品" />` : '<span class="ph">失败</span>'}</div>
        </div>
        <div class="nm" title="${escapeHtml(i.file)}">${escapeHtml(i.name)}</div>
        ${i.status === 'failed' ? `<div class="why">${escapeHtml(i.errorHint || i.message)}</div>` : ''}
        ${i.warnings?.length ? `<div class="wn">⚠ ${escapeHtml(i.warnings.join('；'))}</div>` : ''}
      </div>`;
        })
        .join('');
}

/* ------------------------------------------------------------------ 设置 / 弹窗 */

function openModal() {
    $('#s_apiKey').value = '';
    $('#s_apiKey').placeholder = S.cfg?.hasKey ? `已保存（${S.cfg.keyMask}），留空=不改` : '粘贴长效 API Key';
    $('#modal').classList.remove('hidden');
}

async function saveSettings() {
    const body = { baseUrl: $('#s_baseUrl').value.trim() };
    const k = $('#s_apiKey').value.trim();
    if (k) body.apiKey = k;
    await api('/api/config', body);
    S.cfg = await api('/api/config', null, 'GET');
    refreshKeyBadge();
    $('#modal').classList.add('hidden');
    toast('已保存', 'ok');
}

/* ------------------------------------------------------------------ 事件绑定 */

function bindEvents() {
    // 标签页
    $$('.tab').forEach((t) =>
        t.addEventListener('click', () => {
            $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
            $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
        })
    );

    // 选图：点击 / 拖拽 / 路径
    for (const kind of ['ref', 'target']) {
        const dz = document.querySelector(`.dropzone[data-kind="${kind}"]`);
        dz.addEventListener('click', () => pickFile(kind));
        dz.addEventListener('dragover', (e) => {
            e.preventDefault();
            dz.classList.add('hover');
        });
        dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('hover');
            const f = e.dataTransfer.files?.[0];
            if (f) assignFiles(kind, [f]);
            else {
                const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
                if (url) {
                    const p = url.trim();
                    setImage(kind, { path: p }, p.split(/[\\/]/).pop());
                    document.querySelector(`[data-path="${kind}"]`).value = p;
                }
            }
        });
        const pathInp = document.querySelector(`[data-path="${kind}"]`);
        pathInp.addEventListener('change', () => {
            const p = pathInp.value.trim();
            if (!p) return setImage(kind, null, '');
            setImage(kind, { path: p }, p.split(/[\\/]/).pop());
        });
        pathInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') pathInp.dispatchEvent(new Event('change'));
        });
    }

    $('#btnSwap').addEventListener('click', () => {
        const a = S.ref;
        setImage('ref', S.target, S.target?.name);
        setImage('target', a, a?.name);
    });
    $('#btnClearImgs').addEventListener('click', () => {
        setImage('ref', null, '');
        setImage('target', null, '');
        $$('.path').forEach((i) => (i.value = ''));
    });
    $('#btnPickRef2').addEventListener('click', () => pickFile('ref'));

    // 提示词
    $('#f_prompt').addEventListener('input', updatePromptPreview);
    $('#f_labelImages').addEventListener('change', updatePromptPreview);
    $('#f_appendKeyInstruction').addEventListener('change', updatePromptPreview);
    $('#f_keyColor').addEventListener('input', () => {
        const v = $('#f_keyColor').value.trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) $('#f_keyColorPick').value = v.startsWith('#') ? v : `#${v}`;
        updatePromptPreview();
    });
    $('#f_keyColorPick').addEventListener('input', () => {
        $('#f_keyColor').value = $('#f_keyColorPick').value.toUpperCase();
        updatePromptPreview();
    });
    $('#presetSel').addEventListener('change', () => {
        const i = $('#presetSel').value;
        if (i === '') return;
        $('#f_prompt').value = S.cfg.presets[Number(i)].prompt;
        $('#presetSel').value = '';
        updatePromptPreview();
    });
    $('#btnResetPrompt').addEventListener('click', () => {
        $('#f_prompt').value = S.cfg.presets[0].prompt;
        updatePromptPreview();
    });

    // 参数联动
    $('#f_model').addEventListener('change', syncModelUi);
    $('#f_customModel').addEventListener('input', () => {
        syncModelUi();
        updatePromptPreview();
    });
    $('#f_sizeMode').addEventListener('change', syncSizeUi);
    $('#f_alphaMode').addEventListener('change', () => {
        // 与参考图互斥的组合「不让选中」：当场切回色键抠图并说明（比等到生成时才报错友好，
        // 也不用等用户按下生成才发现钱要白花）
        if (apiTransparentConflict({ alphaMode: $('#f_alphaMode').value, useRef: $('#f_useRef').checked })) {
            $('#f_alphaMode').value = 'chroma';
            toast(
                '「接口直出透明」只接受 1 张输入图，做不了双图风格迁移 —— 已切回「色键抠图」',
                'err',
                '这两个选项互斥'
            );
        }
        syncAlphaUi();
        updatePromptPreview();
    });
    $('#f_useRef').addEventListener('change', () => {
        if (apiTransparentConflict({ alphaMode: $('#f_alphaMode').value, useRef: $('#f_useRef').checked })) {
            $('#f_alphaMode').value = 'chroma';
            toast('参考图需要 2 张输入图 → 透明方式已切回「色键抠图」', 'err', '「接口直出透明」不能用参考图');
        }
        syncAlphaUi();
        updatePromptPreview();
    });
    for (const id of ['f_keyTolerance', 'f_localGrow', 'f_shrinkEdge']) {
        $(`#${id}`).addEventListener('input', () => {
            syncRanges();
            syncAlphaUi();
        });
    }
    for (const id of ['f_keyAuto', 'f_despill', 'f_padSquare', 'f_outSize']) {
        $(`#${id}`).addEventListener('change', syncAlphaUi);
    }

    // 单图动作
    $('#btnGenerate').addEventListener('click', generate);
    $('#btnRealpha').addEventListener('click', realpha);
    $('#btnDownload').addEventListener('click', () => {
        if (S.result) window.open(`/api/image?path=${encodeURIComponent(S.result.outputPath)}`, '_blank');
    });
    $('#btnReveal').addEventListener('click', () => S.result && api('/api/reveal', { path: S.result.outputPath }));
    $('#btnCopyPath').addEventListener('click', async () => {
        if (!S.result) return;
        await navigator.clipboard.writeText(S.result.outputPath);
        toast('路径已复制', 'ok');
    });
    $$('.compare .checker').forEach((c) =>
        c.addEventListener('click', () => {
            const img = c.querySelector('img');
            if (img?.src) openLightbox(img.src);
        })
    );

    // 输出目录
    const setOut = (dir) => {
        S.outDir = dir;
        $('#f_outDir').value = dir;
        $('#b_outDir').value = dir;
    };
    $('#f_outDir').addEventListener('change', () => setOut($('#f_outDir').value.trim()));
    $('#b_outDir').addEventListener('change', () => setOut($('#b_outDir').value.trim()));
    $('#btnOpenOut').addEventListener('click', () => api('/api/reveal', { path: S.outDir }));
    $('#btnOpenOut2').addEventListener('click', () => api('/api/reveal', { path: S.outDir }));

    // 批量
    $('#btnScan').addEventListener('click', scan);
    $('#b_mode').addEventListener('change', () => {
        // 「只重跑抠图」的意义就是拿新参数重抠，默认跳过已生成会让改了参数却毫无反应
        const realpha = $('#b_mode').value === 'realpha';
        $('#b_skipExisting').checked = !realpha;
        updateCost();
    });
    $('#btnStart').addEventListener('click', startBatch);
    $('#btnCancel').addEventListener('click', async () => {
        if (!S.jobId) return;
        await api('/api/batch/cancel', { jobId: S.jobId });
        toast('已请求取消，正在处理中的那张会跑完', 'warn');
    });
    $('#btnZip').addEventListener('click', async () => {
        const res = await fetch('/api/zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: S.outDir }),
        });
        if (!res.ok) return toast('打包失败', 'err');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(S.outDir.split(/[\\/]/).pop() || 'icons')}_${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
    });
    $('#btnReport').addEventListener('click', () => window.open(`/api/report?dir=${encodeURIComponent(S.outDir)}`, '_blank'));
    $('#gridFailOnly').addEventListener('change', () => {
        if (S.es === null && S.jobId) refreshJob();
    });
    $('#btnLoadFirst').addEventListener('click', async () => {
        if (!S.scan?.files?.length) await scan();
        const f = S.scan?.files?.[0];
        if (!f) return toast('先扫描出图片', 'err');
        setImage('target', { path: f.path }, f.name);
        document.querySelector('[data-path="target"]').value = f.path;
        toast(`已载入 ${f.name}，点「生成」先试一张（约 0.1~0.6 元）`, 'ok');
    });

    // 设置
    $('#btnSettings').addEventListener('click', openModal);
    $('#btnFetchModels').addEventListener('click', (e) => {
        e.preventDefault();
        fetchAccountModels();
    });
    $('#btnFetchModels2').addEventListener('click', () => fetchAccountModels());
    $('#btnProbeModel').addEventListener('click', (e) => {
        e.preventDefault();
        probeModels();
    });
    $('#btnCloseModal').addEventListener('click', () => $('#modal').classList.add('hidden'));
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnClearKey').addEventListener('click', async () => {
        await api('/api/config', { apiKey: '' });
        S.cfg = await api('/api/config', null, 'GET');
        refreshKeyBadge();
        toast('已清除界面保存的 Key（环境变量仍可能生效）', 'warn');
    });
    $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            $('#lightbox').classList.add('hidden');
            $('#modal').classList.add('hidden');
        }
    });
    // 网格点图放大（事件委托）
    $('#resultGrid').addEventListener('click', (e) => {
        const img = e.target.closest('img[data-full]');
        if (img) openLightbox(img.dataset.full);
    });
}

function openLightbox(src) {
    $('#lightImg').src = src;
    $('#lightbox').classList.remove('hidden');
}

async function refreshJob() {
    if (!S.jobId) return;
    try {
        const r = await api(`/api/batch/${S.jobId}`, null, 'GET');
        if (!r.ok) return;
        S.items = new Map(r.job.items.map((i) => [i.name, i]));
        renderProgress(r.job);
        renderGrid(r.job);
    } catch {
        /* 忽略 */
    }
}

boot();
