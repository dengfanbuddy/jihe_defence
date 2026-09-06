/**
 * 集合防御 · 形象设计页逻辑
 * 渲染 / 主题 / 体量对照 / 战场预览 / SVG·PNG 导出
 */
(function () {
    'use strict';

    var A = window.GlyphArt, O = window.GlyphArtOurs, D = window.GlyphDataOurs;
    var U = A.util;

    var state = { theme: 'light', size: 512, bg: false, filter: 'all' };

    function el(id) { return document.getElementById(id); }
    function pal() { return A.PALETTES[state.theme]; }
    function n(v) { return (Math.round(v * 100) / 100).toString(); }

    var KIND = {
        hero: { label: '我方', cls: '' },
        normal: { label: '普通', cls: 'normal' },
        elite: { label: '精英', cls: 'elite' },
        boss: { label: '首领', cls: 'boss' },
        gold_boss: { label: '金币首领', cls: 'boss' },
        exp_boss: { label: '经验首领', cls: 'boss' }
    };

    /* ============================================================ SVG 组装 */

    function vbOf(kind) {
        var v = O.VIEWBOX[kind].split(' ');
        return { w: +v[2], h: +v[3] };
    }

    function svgString(kind, code, opts) {
        opts = opts || {};
        var p = pal(), fn = O[kind][code];
        if (!fn) return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        var vb = vbOf(kind);
        var w = opts.size || vb.w;
        var h = opts.size ? Math.round(opts.size * vb.h / vb.w) : vb.h;
        var bg = '';
        if (opts.bg) {
            var gid = 'bg_' + kind + '_' + code;
            bg = '<defs><radialGradient id="' + gid + '" cx="50%" cy="46%" r="72%">' +
                '<stop offset="0" stop-color="' + p.paper + '"/><stop offset="1" stop-color="' + p.bgEdge + '"/></radialGradient></defs>' +
                '<rect width="' + vb.w + '" height="' + vb.h + '" fill="url(#' + gid + ')"/>';
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + vb.w + ' ' + vb.h +
            '" width="' + w + '" height="' + h + '">' + bg + fn(p) + '</svg>';
    }

    /* ============================================================ 下载 */

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
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            c.toBlob(cb, 'image/png');
        };
        img.onerror = function () { toast('栅格化失败'); cb(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    }

    function fileName(kind, code, ext) {
        var k = { units: 'unit', shots: 'shot', marks: 'mark', ai: 'ai' }[kind] || kind;
        return 'jihe_' + k + '_' + code + '_' + state.theme + '.' + ext;
    }

    function downloadSvg(kind, code) {
        saveBlob(new Blob([svgString(kind, code, { size: state.size, bg: state.bg })],
            { type: 'image/svg+xml;charset=utf-8' }), fileName(kind, code, 'svg'));
        toast('已下载 ' + fileName(kind, code, 'svg'));
    }

    function downloadPng(kind, code, done) {
        var vb = vbOf(kind), w = state.size, h = Math.round(state.size * vb.h / vb.w);
        rasterize(svgString(kind, code, { size: w, bg: state.bg }), w, h, function (b) {
            if (b) saveBlob(b, fileName(kind, code, 'png'));
            if (done) done(); else toast('已下载 ' + fileName(kind, code, 'png'));
        });
    }

    var tTimer = null;
    function toast(msg) {
        var t = el('toast');
        t.textContent = msg; t.classList.add('show');
        clearTimeout(tTimer);
        tTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
    }

    function copyText(txt, msg) {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast(msg); } catch (e) { toast('复制失败'); }
        ta.remove();
    }

    function allJobs() {
        var jobs = [];
        D.units.forEach(function (u) { jobs.push({ kind: 'units', code: u.code }); });
        D.shots.forEach(function (s) { jobs.push({ kind: 'shots', code: s.code }); });
        D.marks.forEach(function (m) { jobs.push({ kind: 'marks', code: m.code }); });
        D.ai.forEach(function (a) { jobs.push({ kind: 'ai', code: a.code }); });
        return jobs;
    }

    function batch(jobs, ext) {
        toast('开始导出 ' + jobs.length + ' 个 ' + ext.toUpperCase() + ' …');
        var i = 0;
        (function next() {
            if (i >= jobs.length) { toast('全部 ' + jobs.length + ' 个文件导出完成'); return; }
            var j = jobs[i++];
            if (ext === 'svg') { downloadSvg(j.kind, j.code); setTimeout(next, 220); }
            else downloadPng(j.kind, j.code, function () { setTimeout(next, 220); });
        })();
    }

    /* ============================================================ 卡片 */

    function dlRow(kind, code) {
        return '<div class="dl-row">' +
            '<button class="btn tiny" data-svg="' + kind + '|' + code + '">SVG</button>' +
            '<button class="btn tiny" data-png="' + kind + '|' + code + '">PNG</button>' +
            '<button class="btn tiny" data-copy="' + kind + '|' + code + '">复制代码</button></div>';
    }

    function stat(v, k) { return '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>'; }

    function unitCard(u) {
        var k = KIND[u.kind], s = u.stats;
        var tags = '<span class="tag ' + k.cls + '">' + k.label + '</span>' +
            '<span class="tag">r ' + u.radius + '</span>' +
            '<span class="tag">' + (u.ai || '') + '</span>';
        var extra = u.abilities ? '<p class="note"><b>技能：</b>' + u.abilities + '</p>' : '';
        if (u.shot) extra += '<p class="note"><b>弹道：</b>' + u.shot + '</p>';
        if (u.reward) extra += '<p class="note"><b>掉落：</b>' + u.reward + '</p>';
        if (u.warn) extra += '<p class="note" style="color:var(--accent)"><b>⚠ 配置提示：</b>' + u.warn + '</p>';
        return '<div class="card" data-kind="' + u.kind + '">' +
            '<div class="tile sq"><span class="tier-tag">' + u.en + ' · id ' + u.id + '</span>' +
            svgString('units', u.code, {}) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + u.name + '</h3><span class="code">' + u.code + '</span></div>' +
            '<div class="tags">' + tags + '</div>' +
            '<p class="note"><b>剪影：</b>' + u.silhouette + '</p>' +
            extra +
            '<p class="note"><b>识别点：</b>' + u.tell + '</p>' +
            '<div class="stats">' +
            stat(s.hp, 'HP') + stat(s.atk, 'ATK') + stat(s.def, 'ARM') +
            stat(s.ms, 'MOVE') + stat(s.range, 'RANGE') + stat(u.atkInterval + 's', 'INTV') +
            '</div>' +
            '<details><summary>设计说明</summary><p class="note" style="margin-top:8px">' + u.design + '</p></details>' +
            '<details><summary>配置出处</summary><pre>units.json  id=' + u.id + '\nteam=' + u.team +
            '\ncollision_radius=' + u.radius + '\nattack_interval=' + u.atkInterval +
            '\nai=' + (u.ai || '-') + '\nprefab=' + (u.prefab || '-') + '</pre></details>' +
            dlRow('units', u.code) + '</div></div>';
    }

    function shotCard(s) {
        return '<div class="card">' +
            '<div class="tile pj"><span class="tier-tag">' + s.en + '</span>' + svgString('shots', s.code, {}) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + s.name + '</h3><span class="code">' + s.code + '</span></div>' +
            '<div class="tags"><span class="tag">' + s.src + '</span></div>' +
            '<p class="note"><b>参数：</b>' + s.spec + '</p>' +
            '<p class="note">' + s.note + '</p>' +
            dlRow('shots', s.code) + '</div></div>';
    }

    function markCard(m) {
        return '<div class="card">' +
            '<div class="tile ic" style="padding:16px">' + svgString('marks', m.code, {}) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display" style="font-size:16px">' + m.name + '</h3>' +
            '<span class="en" style="font-size:10px">' + m.el + '</span></div>' +
            '<span class="code">' + m.code + '</span>' +
            '<p class="note" style="font-size:11.5px"><b>' + m.spec + '</b></p>' +
            '<p class="note" style="font-size:11.5px">' + m.note + '</p>' +
            dlRow('marks', m.code) + '</div></div>';
    }

    function aiCard(a) {
        return '<div class="card">' +
            '<div class="tile" style="aspect-ratio:200/140"><span class="tier-tag">' + a.en + '</span>' +
            svgString('ai', a.code, {}) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + a.name + '</h3><span class="code">' + a.code + '</span></div>' +
            '<div class="tags"><span class="tag">' + a.usedBy + '</span></div>' +
            '<p class="note">' + a.note + '</p>' +
            dlRow('ai', a.code) + '</div></div>';
    }

    /* ============================================================ 体量对照尺 */

    function buildRuler() {
        var p = pal(), K = 2.3, GAP = 22, PAD = 30;
        var list = D.units.filter(function (u) { return u.kind !== 'hero'; })
            .sort(function (a, b) { return a.radius - b.radius; });
        var hero = D.units.filter(function (u) { return u.code === 'hero_knight'; });
        list = hero.concat(list);

        var w = PAD * 2, i;
        for (i = 0; i < list.length; i++) w += list[i].radius * 2 * K + GAP;
        w -= GAP;
        var maxR = list[list.length - 1].radius * K;
        var H = maxR * 2 + 120, cy = maxR + 34;

        var out = ['<rect width="' + n(w) + '" height="' + n(H) + '" fill="none"/>'];
        out.push('<path d="M' + PAD + ' ' + n(cy + maxR + 22) + ' H' + n(w - PAD) + '" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 6"/>');

        var x = PAD;
        list.forEach(function (u) {
            var R = u.radius * K, cx = x + R;
            var sc = R * 2.1 / 120;
            out.push('<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(R) + '" fill="none" stroke="' +
                (u.kind === 'hero' ? p.ink : p.muted) + '" stroke-width="1.2" stroke-dasharray="3 5"/>');
            out.push('<g transform="translate(' + n(cx - 60 * sc) + ',' + n(cy - 60 * sc) + ') scale(' + n(sc) + ')">' +
                O.units[u.code](p) + '</g>');
            out.push('<text x="' + n(cx) + '" y="' + n(cy + maxR + 44) + '" text-anchor="middle" font-family="Georgia,serif" font-size="15" fill="' + p.ink + '">' + u.name + '</text>');
            out.push('<text x="' + n(cx) + '" y="' + n(cy + maxR + 60) + '" text-anchor="middle" font-family="Consolas,monospace" font-size="11" fill="' + p.muted + '">r ' + u.radius + '</text>');
            out.push('<path d="M' + n(cx) + ' ' + n(cy + maxR + 16) + ' V' + n(cy + maxR + 28) + '" stroke="' + p.muted + '" stroke-width="1.2"/>');
            x += R * 2 + GAP;
        });

        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n(w) + ' ' + n(H) +
            '" width="' + n(w) + '" height="' + n(H) + '">' + out.join('') + '</svg>';
    }

    /* ============================================================ 战场预览 */

    var SCENE = [
        { code: 'mon_goblin', x: 210, y: 108, s: 0.5 },
        { code: 'mon_goblin', x: 156, y: 158, s: 0.5 },
        { code: 'mon_troll', x: 268, y: 320, s: 0.66 },
        { code: 'mon_wanderer', x: 118, y: 268, s: 0.6 },
        { code: 'mon_orbiter', x: 690, y: 140, s: 0.62 },
        { code: 'mon_slammer', x: 796, y: 306, s: 0.7 },
        { code: 'mon_abyss_lord', x: 618, y: 356, s: 0.86 }
    ];

    var PARTY = [
        { code: 'hero_knight', x: 430, y: 236, s: 0.58 },
        { code: 'hero_mage', x: 496, y: 190, s: 0.56 },
        { code: 'hero_bounty', x: 500, y: 288, s: 0.56 }
    ];

    function trailPath(p, x0, y0, x1, y1, count) {
        var s = '';
        for (var i = 0; i < count; i++) {
            var t = i / (count - 1);
            s += '<circle cx="' + n(x0 + (x1 - x0) * t) + '" cy="' + n(y0 + (y1 - y0) * t) +
                '" r="' + n(1 + t * 2.6) + '" fill="' + p.ink + '" opacity="' + n(0.12 + t * 0.6) + '"/>';
        }
        return s;
    }

    function buildArena() {
        var p = pal(), W = 960, H = 440;
        var out = [];
        out.push('<defs><radialGradient id="arenaBg2" cx="50%" cy="50%" r="70%">' +
            '<stop offset="0" stop-color="' + p.paper + '"/><stop offset="1" stop-color="' + p.bgEdge + '"/></radialGradient></defs>');
        out.push('<rect width="' + W + '" height="' + H + '" fill="url(#arenaBg2)"/>');

        /* HUD */
        out.push('<text x="480" y="40" text-anchor="middle" font-family="Bebas Neue, Consolas, monospace" font-size="28" letter-spacing="3" fill="' + p.ink + '">WAVE 07</text>');
        out.push('<text x="480" y="58" text-anchor="middle" font-family="Georgia,serif" font-size="13" fill="' + p.muted + '">深渊领主 · 阶段 2 / 4</text>');
        out.push('<rect x="404" y="68" width="152" height="6" fill="' + p.muted + '" opacity=".3"/>');
        out.push('<rect x="404" y="68" width="98" height="6" fill="' + p.accent + '"/>');

        /* 环绕魔轨道 */
        out.push('<circle cx="470" cy="238" r="230" fill="none" stroke="' + p.muted + '" stroke-width="1" stroke-dasharray="2 9"/>');

        /* 怪物 */
        SCENE.forEach(function (u) {
            var half = 60 * u.s;
            out.push('<g transform="translate(' + n(u.x - half) + ',' + n(u.y - half) + ') scale(' + n(u.s) + ')">' + O.units[u.code](p) + '</g>');
            out.push('<path d="M' + n(u.x - 15) + ' ' + n(u.y + half + 10) + ' H' + n(u.x + 15) + '" stroke="' + p.muted + '" stroke-width="2.4" opacity=".45"/>');
            out.push('<path d="M' + n(u.x - 15) + ' ' + n(u.y + half + 10) + ' H' + n(u.x + 3) + '" stroke="' + p.ink + '" stroke-width="2.4"/>');
        });

        /* 状态标记挂在怪物头顶 */
        out.push('<g transform="translate(' + (268 - 18) + ',' + (320 - 70) + ') scale(0.5)">' + O.marks.burn(p) + '</g>');
        out.push('<g transform="translate(' + (796 + 34) + ',' + (306 - 40) + ') scale(0.5)">' + O.marks.freeze(p) + '</g>');
        out.push('<g transform="translate(' + (690 + 28) + ',' + (140 - 50) + ') scale(0.5)">' + O.marks.bounty_mark(p) + '</g>');

        /* 我方 */
        PARTY.forEach(function (u) {
            var half = 60 * u.s;
            out.push('<g transform="translate(' + n(u.x - half) + ',' + n(u.y - half) + ') scale(' + n(u.s) + ')">' + O.units[u.code](p) + '</g>');
        });
        out.push('<path d="M420 330 H540" stroke="' + p.ink + '" stroke-width="2.6"/>');
        out.push('<text x="480" y="348" text-anchor="middle" font-family="Consolas,monospace" font-size="12" fill="' + p.muted + '">1370 / 1370</text>');

        /* 弹道：飞镖 → 重击者，冰霜弹 → 环绕魔，火球 → 巨魔 */
        out.push(trailPath(p, 520, 288, 760, 302, 12));
        out.push('<g transform="translate(772,296) scale(0.42) translate(-118,-42)">' + O.shots.shuriken_t3(p) + '</g>');
        out.push(trailPath(p, 516, 186, 660, 148, 10));
        out.push('<g transform="translate(668,140) scale(0.38) translate(-114,-40)">' + O.shots.frost_bolt(p) + '</g>');
        out.push('<g transform="translate(330,300) scale(0.5) translate(-80,-45)">' + O.shots.fireball(p) + '</g>');

        /* 命中溅墨与伤害数字 */
        out.push('<g transform="translate(796,306) scale(0.42) translate(-80,-45)" opacity="0.5">' + A.projectiles.ink_splatter(p) + '</g>');
        out.push('<text x="820" y="272" font-family="Consolas,monospace" font-size="15" fill="' + p.accent + '">100</text>');
        out.push('<text x="300" y="292" font-family="Consolas,monospace" font-size="13" fill="' + p.muted + '">60</text>');
        out.push('<text x="712" y="112" font-family="Consolas,monospace" font-size="12" fill="' + p.muted + '">25</text>');

        /* 单位名（俯视角小标签） */
        [['哥布林', 210, 78], ['巨魔', 268, 274], ['游荡者', 118, 216], ['环绕魔', 690, 96], ['重击者', 796, 250], ['深渊领主', 618, 292]]
            .forEach(function (t) {
                out.push('<text x="' + t[1] + '" y="' + t[2] + '" text-anchor="middle" font-family="Georgia,serif" font-size="14" fill="' + p.ink + '" opacity=".72">' + t[0] + '</text>');
            });

        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + out.join('') + '</svg>';
    }

    /* ============================================================ 渲染 */

    function renderFilters() {
        var mons = D.units.filter(function (u) { return u.kind !== 'hero'; });
        var kinds = ['all', 'normal', 'elite', 'boss', 'gold_boss', 'exp_boss'];
        el('mFilters').innerHTML = kinds.map(function (k) {
            var c = k === 'all' ? mons.length : mons.filter(function (m) { return m.kind === k; }).length;
            if (!c) return '';
            var label = k === 'all' ? '全部' : KIND[k].label;
            return '<button class="chip ' + (state.filter === k ? 'on' : '') + '" data-filter="' + k + '">' + label + ' ' + c + '</button>';
        }).join('');
    }

    function renderMonsters() {
        var list = D.units.filter(function (u) {
            return u.kind !== 'hero' && (state.filter === 'all' || u.kind === state.filter);
        });
        el('monGrid').innerHTML = list.map(unitCard).join('');
    }

    function renderAll() {
        var p = pal();
        el('brandMark').innerHTML = svgString('units', 'hero_bounty', {});
        el('rules').innerHTML = D.rules.map(function (r) {
            return '<div class="rule"><b>' + r.k + '</b><span>' + r.v + '</span></div>';
        }).join('');
        el('heroGrid').innerHTML = D.units.filter(function (u) { return u.kind === 'hero'; }).map(unitCard).join('');
        el('aiGrid').innerHTML = D.ai.map(aiCard).join('');
        el('shotGrid').innerHTML = D.shots.map(shotCard).join('');
        el('markGrid').innerHTML = D.marks.map(markCard).join('');
        el('ruler').innerHTML = buildRuler();
        el('arena').innerHTML = buildArena();
        renderFilters();
        renderMonsters();
    }

    /* ============================================================ 事件 */

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

        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('button') : null;
            if (!t) return;
            if (t.dataset.filter) { state.filter = t.dataset.filter; renderFilters(); renderMonsters(); return; }
            if (t.dataset.svg) { var a = t.dataset.svg.split('|'); downloadSvg(a[0], a[1]); return; }
            if (t.dataset.png) { var b = t.dataset.png.split('|'); downloadPng(b[0], b[1]); return; }
            if (t.dataset.copy) {
                var c = t.dataset.copy.split('|');
                copyText(svgString(c[0], c[1], { size: state.size, bg: state.bg }), '已复制 ' + c[1] + ' 的 SVG 代码');
                return;
            }
            var big = { 'ruler-svg': buildRuler, 'ruler-png': buildRuler, 'arena-svg': buildArena, 'arena-png': buildArena }[t.dataset.dl];
            if (!big) return;
            var str = big();
            var name = t.dataset.dl.indexOf('ruler') === 0 ? 'jihe_size_ruler_' : 'jihe_arena_';
            if (t.dataset.dl.indexOf('svg') > 0) {
                saveBlob(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }), name + state.theme + '.svg');
                toast('已下载 SVG');
            } else {
                var m = str.match(/width="([\d.]+)" height="([\d.]+)"/);
                var w = m ? +m[1] : 960, h = m ? +m[2] : 440;
                var k = Math.max(1, state.size / 480);
                rasterize(str, Math.round(w * k), Math.round(h * k), function (blob) {
                    if (blob) { saveBlob(blob, name + state.theme + '.png'); toast('已下载 PNG'); }
                });
            }
        });
    }

    document.documentElement.setAttribute('data-theme', state.theme);
    renderAll();
    bind();

    window.GlyphAppOurs = { state: state, svgString: svgString, buildArena: buildArena, buildRuler: buildRuler };
})();
