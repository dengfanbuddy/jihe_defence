/**
 * Glyph 图鉴 —— 页面逻辑
 * 渲染 / 主题切换 / 筛选 / SVG·PNG 导出（纯前端，双击 index.html 即可用）
 */
(function () {
    'use strict';

    var A = window.GlyphArt, D = window.GlyphData;

    var state = {
        theme: 'light',
        size: 512,
        bg: false,
        filter: 'all'
    };

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var el = function (id) { return document.getElementById(id); };
    function pal() { return A.PALETTES[state.theme]; }

    /* ============================================================ SVG 组装 */

    function viewBoxOf(kind) {
        var v = A.VIEWBOX[kind].split(' ');
        return { w: +v[2], h: +v[3] };
    }

    /**
     * @param kind monsters | projectiles | icons | vocab
     * @param code 图形 code
     * @param opts {size:number|0, bg:boolean}
     */
    function svgString(kind, code, opts) {
        opts = opts || {};
        var p = pal();
        var fn = A[kind][code];
        if (!fn) return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        var vb = viewBoxOf(kind);
        var w = opts.size || vb.w;
        var h = opts.size ? Math.round(opts.size * vb.h / vb.w) : vb.h;
        var bg = '';
        if (opts.bg) {
            var gid = 'bg_' + code;
            bg = '<defs><radialGradient id="' + gid + '" cx="50%" cy="46%" r="72%">' +
                '<stop offset="0" stop-color="' + p.paper + '"/>' +
                '<stop offset="1" stop-color="' + p.bgEdge + '"/></radialGradient></defs>' +
                '<rect width="' + vb.w + '" height="' + vb.h + '" fill="url(#' + gid + ')"/>';
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + vb.w + ' ' + vb.h +
            '" width="' + w + '" height="' + h + '">' + bg + fn(p) + '</svg>';
    }

    /* ============================================================ 下载工具 */

    function saveBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    function rasterize(str, w, h, cb) {
        var img = new Image();
        img.onload = function () {
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            c.toBlob(function (b) { cb(b); }, 'image/png');
        };
        img.onerror = function () { toast('栅格化失败：' + w + '×' + h); cb(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    }

    function fileName(kind, code, ext) {
        var k = { monsters: 'monster', projectiles: 'shot', icons: 'icon', vocab: 'vocab' }[kind] || kind;
        return 'glyph_' + k + '_' + code + '_' + state.theme + '.' + ext;
    }

    function downloadSvg(kind, code) {
        var str = svgString(kind, code, { size: state.size, bg: state.bg });
        saveBlob(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }), fileName(kind, code, 'svg'));
        toast('已下载 ' + fileName(kind, code, 'svg'));
    }

    function downloadPng(kind, code, done) {
        var vb = viewBoxOf(kind);
        var w = state.size, h = Math.round(state.size * vb.h / vb.w);
        var str = svgString(kind, code, { size: w, bg: state.bg });
        rasterize(str, w, h, function (blob) {
            if (blob) saveBlob(blob, fileName(kind, code, 'png'));
            if (done) done(); else toast('已下载 ' + fileName(kind, code, 'png'));
        });
    }

    function copyText(txt, msg) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(txt).then(function () { toast(msg); }, function () { fallback(); });
        } else fallback();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast(msg); } catch (e) { toast('复制失败，请手动选择文本'); }
            ta.remove();
        }
    }

    var toastTimer = null;
    function toast(msg) {
        var t = el('toast');
        t.textContent = msg; t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
    }

    /** 顺序批量下载，避免浏览器丢包 */
    function batch(jobs, ext) {
        if (!jobs.length) return;
        toast('开始导出 ' + jobs.length + ' 个 ' + ext.toUpperCase() + ' …');
        var i = 0;
        (function next() {
            if (i >= jobs.length) { toast('全部 ' + jobs.length + ' 个文件导出完成'); return; }
            var j = jobs[i++];
            if (ext === 'svg') { downloadSvg(j.kind, j.code); setTimeout(next, 220); }
            else { downloadPng(j.kind, j.code, function () { setTimeout(next, 220); }); }
        })();
    }

    function allJobs() {
        var jobs = [];
        D.monsters.forEach(function (m) { jobs.push({ kind: 'monsters', code: m.code }); });
        D.projectiles.forEach(function (m) { jobs.push({ kind: 'projectiles', code: m.code }); });
        D.icons.forEach(function (m) { jobs.push({ kind: 'icons', code: m.code }); });
        return jobs;
    }

    /* ============================================================ 卡片渲染 */

    function tile(kind, code, cls, extra) {
        return '<div class="tile ' + cls + '">' + (extra || '') + svgString(kind, code, {}) + '</div>';
    }

    function dlRow(kind, code) {
        return '<div class="dl-row">' +
            '<button class="btn tiny" data-svg="' + kind + '|' + code + '">SVG</button>' +
            '<button class="btn tiny" data-png="' + kind + '|' + code + '">PNG</button>' +
            '<button class="btn tiny" data-copy="' + kind + '|' + code + '">复制代码</button>' +
            '</div>';
    }

    function threatDots(n) {
        var s = '<div class="threat">';
        for (var i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
        return s + '</div>';
    }

    function cfgLine(cfg) {
        return JSON.stringify(cfg)
            .replace(/","/g, '", "')
            .replace(/,"/g, ', "')
            .replace(/":/g, '": ')
            .replace(/:\{/g, ': {')
            .replace(/,(\d)/g, ', $1');
    }

    function monsterCard(m) {
        var t = D.TIER[m.tier], a = m.cfg.attributes;
        var tags = '<span class="tag ' + t.cls + '">' + t.label + '</span>' +
            '<span class="tag">' + m.role + '</span>' +
            (m.element !== '—' ? '<span class="tag">' + m.element + '</span>' : '');
        return '<div class="card" data-tier="' + m.tier + '">' +
            tile('monsters', m.code, 'sq',
                '<span class="tier-tag">' + m.en + '</span>' + threatDots(m.threat)) +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + m.name + '</h3><span class="code">' + m.code + '</span></div>' +
            '<div class="tags">' + tags + '</div>' +
            '<p class="note"><b>剪影：</b>' + m.silhouette + '</p>' +
            '<p class="note"><b>行为：</b>' + m.behavior + '</p>' +
            '<p class="note"><b>识别点：</b>' + m.tell + '</p>' +
            '<div class="stats">' +
            stat(a.maxHp, 'HP') + stat(a.atk, 'ATK') + stat(a.def, 'DEF') +
            stat(a.moveSpeed, 'SPD') + stat(m.cfg.attackRange, 'RANGE') + stat(m.cfg.expReward, 'EXP') +
            '</div>' +
            '<details><summary>设计说明</summary><p class="note" style="margin-top:8px">' + m.design + '</p></details>' +
            '<details><summary>enemies.json 配置</summary><pre>' + escapeHtml(cfgLine(m.cfg)) + '</pre></details>' +
            dlRow('monsters', m.code) +
            '</div></div>';
    }

    function stat(v, k) { return '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>'; }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function projectileCard(p) {
        return '<div class="card">' +
            tile('projectiles', p.code, 'pj', '<span class="tier-tag">' + p.en + '</span>') +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + p.name + '</h3><span class="code">' + p.code + '</span></div>' +
            '<div class="tags"><span class="tag">' + p.use + '</span></div>' +
            '<p class="note">' + p.note + '</p>' +
            dlRow('projectiles', p.code) +
            '</div></div>';
    }

    function iconCard(ic) {
        return '<div class="card">' +
            tile('icons', ic.code, 'ic') +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display" style="font-size:16px">' + ic.name + '</h3></div>' +
            '<span class="code">' + ic.code + '</span>' +
            '<p class="note">' + ic.note + '</p>' +
            dlRow('icons', ic.code) +
            '</div></div>';
    }

    /* ============================================================ 战场预览 */

    var SCENE = [
        { code: 'caret_dasher', x: 172, y: 118, s: 0.62, word: 'surge', mult: 2 },
        { code: 'swarm_dot', x: 782, y: 132, s: 0.60, word: 'cluster' },
        { code: 'bracket_guard', x: 236, y: 344, s: 0.66, word: 'guard', mult: 3 },
        { code: 'orbiter_warden', x: 726, y: 330, s: 0.72, word: 'warden' },
        { code: 'ember_wisp', x: 604, y: 128, s: 0.58, word: 'ember' },
        { code: 'frost_core', x: 118, y: 244, s: 0.64, word: 'frost' },
        { code: 'silencer_glyph', x: 866, y: 244, s: 0.55, word: 'mute' }
    ];

    function bullet(p, path, dur, delay) {
        return '<g opacity="0.95">' +
            '<circle cx="-14" cy="0" r="1.6" fill="' + p.ink + '" opacity=".35"/>' +
            '<circle cx="-8" cy="0" r="2.4" fill="' + p.ink + '" opacity=".6"/>' +
            '<circle cx="-2" cy="0" r="3.2" fill="' + p.ink + '" opacity=".85"/>' +
            '<circle cx="5" cy="0" r="4.6" fill="' + p.accent + '"/>' +
            '<animateMotion dur="' + dur + 's" begin="' + delay + 's" repeatCount="indefinite" rotate="auto" path="' + path + '"/>' +
            '</g>';
    }

    function buildArena() {
        var p = pal(), W = 960, H = 440, cx = 480, cy = 246;
        var out = [];

        out.push('<defs><radialGradient id="arenaBg" cx="50%" cy="50%" r="70%">' +
            '<stop offset="0" stop-color="' + p.paper + '"/><stop offset="1" stop-color="' + p.bgEdge + '"/></radialGradient></defs>');
        out.push('<rect width="' + W + '" height="' + H + '" fill="url(#arenaBg)"/>');

        /* HUD */
        out.push('<text x="' + cx + '" y="40" text-anchor="middle" font-family="Bebas Neue, Consolas, monospace" font-size="30" letter-spacing="3" fill="' + p.ink + '">08:42:31</text>');
        out.push('<text x="' + cx + '" y="60" text-anchor="middle" font-family="Georgia, serif" font-size="14" fill="' + p.muted + '">Level 3 · Weaver</text>');
        out.push('<rect x="' + (cx - 52) + '" y="70" width="104" height="5" fill="' + p.muted + '" opacity=".35"/>');
        out.push('<rect x="' + (cx - 52) + '" y="70" width="62" height="5" fill="' + p.ink + '"/>');

        /* 敌人 */
        SCENE.forEach(function (u) {
            var half = 60 * u.s;
            out.push('<g class="a-unit" style="--dx:' + (u.x > cx ? -10 : 10) + 'px;--dy:' + (u.y > cy ? -8 : 8) + 'px;animation-delay:-' + (u.x % 7) + 's">' +
                '<g transform="translate(' + (u.x - half) + ',' + (u.y - half) + ') scale(' + u.s + ')">' + A.monsters[u.code](p) + '</g>' +
                '<text x="' + u.x + '" y="' + (u.y - half - 14) + '" text-anchor="middle" font-family="Georgia, serif" font-size="19" fill="' + p.ink + '" opacity=".78">' + u.word + '</text>' +
                (u.mult ? '<text x="' + (u.x + u.word.length * 5 + 8) + '" y="' + (u.y - half - 22) + '" font-family="Georgia, serif" font-size="11" fill="' + p.muted + '">' + u.mult + '</text>' : '') +
                '<path d="M' + (u.x - 16) + ' ' + (u.y + half + 12) + ' H' + (u.x + 16) + '" stroke="' + p.muted + '" stroke-width="2.4" opacity=".5"/>' +
                '<path d="M' + (u.x - 16) + ' ' + (u.y + half + 12) + ' H' + (u.x + 4) + '" stroke="' + p.ink + '" stroke-width="2.4"/>' +
                '</g>');
        });

        /* 玩家核心 */
        out.push('<g><circle cx="' + cx + '" cy="' + cy + '" r="17" fill="none" stroke="' + p.ink + '" stroke-width="2.4"/>' +
            '<circle cx="' + cx + '" cy="' + cy + '" r="9" fill="none" stroke="' + p.ink + '" stroke-width="1.6"/>' +
            '<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="' + p.accent + '"/>' +
            '<circle class="a-spin" cx="' + cx + '" cy="' + cy + '" r="30" fill="none" stroke="' + p.muted + '" stroke-width="1.1" stroke-dasharray="3 9" style="transform-origin:' + cx + 'px ' + cy + 'px"/>' +
            '<path d="M' + (cx - 34) + ' ' + (cy + 48) + ' H' + (cx + 34) + '" stroke="' + p.ink + '" stroke-width="2.6"/>' +
            '<text x="' + cx + '" y="' + (cy + 64) + '" text-anchor="middle" font-family="Consolas, monospace" font-size="12" fill="' + p.muted + '">300 / 300</text>' +
            '<text x="' + cx + '" y="' + (cy + 96) + '" text-anchor="middle" font-family="Georgia, serif" font-size="16" fill="' + p.ink + '" opacity=".8">Word Rush ×4</text>' +
            '<text x="' + cx + '" y="' + (cy + 112) + '" text-anchor="middle" font-family="Georgia, serif" font-size="10" fill="' + p.accent + '">+40% Rate of Fire</text>' +
            '</g>');

        /* 弹道 */
        out.push(bullet(p, 'M' + cx + ' ' + cy + ' Q 340 150 172 118', 1.6, 0));
        out.push(bullet(p, 'M' + cx + ' ' + cy + ' Q 640 300 726 330', 2.0, .5));
        out.push(bullet(p, 'M' + cx + ' ' + cy + ' Q 660 150 782 132', 1.8, 1.0));

        /* 命中溅墨 */
        out.push('<g transform="translate(726,330) scale(0.5) translate(-80,-45)" opacity="0.55">' + A.projectiles.ink_splatter(p) + '</g>');

        /* 伤害数字 */
        out.push('<text x="205" y="96" font-family="Consolas, monospace" font-size="13" fill="' + p.muted + '">12</text>');
        out.push('<text x="756" y="300" font-family="Consolas, monospace" font-size="15" fill="' + p.accent + '">31</text>');
        out.push('<text x="640" y="118" font-family="Consolas, monospace" font-size="11" fill="' + p.muted + '">8</text>');

        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + out.join('') + '</svg>';
    }

    /* ============================================================ 渲染入口 */

    function renderStatic() {
        var p = pal();

        el('brandMark').innerHTML = svgString('monsters', 'orbiter_warden', {});

        el('srcs').innerHTML = D.reference.sources.map(function (s) {
            return '<a href="' + s.url + '" target="_blank" rel="noopener">' + s.label + ' ↗</a>';
        }).join('');

        el('swatches').innerHTML = [
            ['画布 Canvas', p.bg], ['暗角 Vignette', p.bgEdge], ['墨色 Ink', p.ink],
            ['辅助 Muted', p.muted], ['强调 Accent', p.accent], ['反白 On-Accent', p.onAccent]
        ].map(function (s) {
            return '<div class="sw"><i style="background:' + s[1] + '"></i><b>' + s[0] + '</b><span>' + s[1] + '</span></div>';
        }).join('');

        el('rules').innerHTML = D.reference.rules.map(function (r) {
            return '<div class="rule"><b>' + r.k + '</b><span>' + r.v + '</span></div>';
        }).join('');

        el('vocab').innerHTML = D.vocab.map(function (v) {
            return '<div class="vocab-item">' +
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="52" height="52">' + A.vocab[v.code](p) + '</svg>' +
                '<b>' + v.name + '</b><span>' + v.note + '</span></div>';
        }).join('');

        el('pGrid').innerHTML = D.projectiles.map(projectileCard).join('');
        el('iGrid').innerHTML = D.icons.map(iconCard).join('');
        el('arena').innerHTML = buildArena();

        el('cfgOut').value = D.monsters.map(function (m) { return '  ' + cfgLine(m.cfg) + ','; }).join('\n');
    }

    function renderMonsters() {
        var list = D.monsters.filter(function (m) {
            return state.filter === 'all' || m.tier === state.filter;
        });
        el('mGrid').innerHTML = list.map(monsterCard).join('');
    }

    function renderFilters() {
        var opts = [['all', '全部 ' + D.monsters.length]];
        ['normal', 'elite', 'boss'].forEach(function (t) {
            var c = D.monsters.filter(function (m) { return m.tier === t; }).length;
            opts.push([t, D.TIER[t].label + ' ' + c]);
        });
        el('mFilters').innerHTML = opts.map(function (o) {
            return '<button class="chip ' + (state.filter === o[0] ? 'on' : '') + '" data-filter="' + o[0] + '">' + o[1] + '</button>';
        }).join('');
    }

    function renderAll() {
        renderStatic();
        renderFilters();
        renderMonsters();
    }

    /* ============================================================ 事件绑定 */

    function bind() {
        el('themeSel').addEventListener('change', function () {
            state.theme = this.value;
            document.documentElement.setAttribute('data-theme', state.theme);
            renderAll();
        });
        el('scaleSel').addEventListener('change', function () { state.size = +this.value; });
        el('bgChk').addEventListener('change', function () { state.bg = this.checked; });

        el('dlAllSvg').addEventListener('click', function () { batch(allJobs(), 'svg'); });
        el('dlAllPng').addEventListener('click', function () { batch(allJobs(), 'png'); });

        el('copyCfg').addEventListener('click', function () {
            copyText(el('cfgOut').value, '已复制 ' + D.monsters.length + ' 条配置');
        });
        el('dlCfg').addEventListener('click', function () {
            var arr = D.monsters.map(function (m) { return m.cfg; });
            var txt = '[\n' + arr.map(function (c) { return '  ' + cfgLine(c); }).join(',\n') + '\n]\n';
            saveBlob(new Blob([txt], { type: 'application/json;charset=utf-8' }), 'enemies_new.json');
            toast('已下载 enemies_new.json');
        });

        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('button') : null;
            if (!t) return;

            if (t.dataset.filter) {
                state.filter = t.dataset.filter;
                renderFilters(); renderMonsters();
                return;
            }
            if (t.dataset.svg) { var a = t.dataset.svg.split('|'); downloadSvg(a[0], a[1]); return; }
            if (t.dataset.png) { var b = t.dataset.png.split('|'); downloadPng(b[0], b[1]); return; }
            if (t.dataset.copy) {
                var c = t.dataset.copy.split('|');
                copyText(svgString(c[0], c[1], { size: state.size, bg: state.bg }), '已复制 ' + c[1] + ' 的 SVG 代码');
                return;
            }
            if (t.dataset.dl === 'arena-svg') {
                saveBlob(new Blob([buildArena()], { type: 'image/svg+xml;charset=utf-8' }), 'glyph_arena_' + state.theme + '.svg');
                toast('已下载战场预览 SVG'); return;
            }
            if (t.dataset.dl === 'arena-png') {
                var scale = Math.max(1, state.size / 480);
                rasterize(buildArena(), Math.round(960 * scale), Math.round(440 * scale), function (blob) {
                    if (blob) { saveBlob(blob, 'glyph_arena_' + state.theme + '.png'); toast('已下载战场预览 PNG'); }
                });
            }
        });
    }

    /* ============================================================ 启动 */
    document.documentElement.setAttribute('data-theme', state.theme);
    renderAll();
    bind();

    /* 对外暴露，方便其它页面复用同一套组装逻辑 */
    window.GlyphApp = {
        state: state,
        svgString: svgString,
        buildArena: buildArena,
        setTheme: function (t) { el('themeSel').value = t; el('themeSel').dispatchEvent(new Event('change')); }
    };
})();
