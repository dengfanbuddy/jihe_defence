/**
 * 怪物图鉴（Boss 体系） —— 逻辑
 * 数据源：data-monsters-a/b/c.js（window.MONSTER_DATA_A/B/C）
 * 美术：   art-boss.js（window.MonsterSigil）+ monster-design 的 GlyphArt 调色板
 */
(function () {
    'use strict';

    var A = window.GlyphArt;           // 调色板 + 工具
    var M = window.MonsterSigil;       // 怪物徽记生成器
    var DATA = [].concat(
        window.MONSTER_DATA_A || [],
        window.MONSTER_DATA_B || [],
        window.MONSTER_DATA_C || []
    );

    var state = { theme: 'light', size: 512, bg: false, cat: '全部', elem: '全部', stage: '全部' };

    var CATS = {
        small: { n: '小怪', cls: '' },
        elite: { n: '精英', cls: 'elite' },
        stage_boss: { n: '阶段Boss', cls: 'boss' },
        gold_boss: { n: '金币Boss', cls: 'boss' },
        kill_boss: { n: '击杀Boss', cls: 'boss' },
        defense_boss: { n: '防守Boss', cls: 'boss' },
        final_boss: { n: '最终Boss', cls: 'boss' }
    };
    var ELEMS = ['物理', '火', '冰', '毒', '雷', '暗', '无'];
    var STAGES = ['1', '2', '3', '4'];

    function el(id) { return document.getElementById(id); }
    function pal() { return A.PALETTES[state.theme]; }
    function n(v) { return (Math.round(v * 100) / 100).toString(); }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    /* ---- 徽记 SVG ---- */
    function monsterSvg(m, opts) {
        return M.svg(m, pal(), opts || {});
    }

    /* ---- 下载器 ---- */
    function saveBlob(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
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
    function dlSvg(m) {
        saveBlob(new Blob([monsterSvg(m, { size: state.size })], { type: 'image/svg+xml;charset=utf-8' }),
            'mon_' + m.code + '_' + state.theme + '.svg');
        toast('已下载 ' + m.code + '.svg');
    }
    function dlPng(m) {
        var str = monsterSvg(m, { size: state.size });
        rasterize(str, state.size, state.size, function (b) {
            if (b) { saveBlob(b, 'mon_' + m.code + '_' + state.theme + '.png'); toast('已下载 PNG'); }
        });
    }
    var tTimer = null;
    function toast(m2) {
        var t = el('toast'); t.textContent = m2; t.classList.add('show');
        clearTimeout(tTimer); tTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
    }

    /* ---- 卡片渲染 ---- */
    function stat(v, k) { return '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>'; }
    function tags(list) { return (list || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(''); }

    function skillLine(s) {
        return '<div class="sk-row"><span class="sk-lv">' + esc(s.cd ? 'CD ' + s.cd + 's' : '被动') + '</span><span class="sk-txt"><b>' + esc(s.name) + '：</b>' + esc(s.desc) + '</span></div>';
    }
    function activeCount(m) {
        return (m.skills || []).filter(function (s) { return s.cd; }).length;
    }

    function monsterCard(m) {
        var c = CATS[m.cat] || { n: m.cat, cls: '' };
        var noAtk = m.attacks === false;
        var atkStats = noAtk
            ? stat('—', 'ATK') + stat(m.stats.hp, 'HP') + stat(m.stats.def, 'DEF') + stat('不攻击', 'AI')
            : stat(m.stats.atk, 'ATK') + stat(m.stats.hp, 'HP') + stat(m.stats.def, 'DEF') +
              stat(m.stats.ms, 'MOVE') + stat(m.stats.range + 'm', 'RNG') + stat(m.atkInterval + 's', 'INTV');
        var reward = m.reward && (m.reward.gold || m.reward.exp)
            ? '<p class="note" style="margin-top:8px"><b>掉落：</b>' + (m.reward.gold ? m.reward.gold + ' 金 ' : '') + (m.reward.exp ? m.reward.exp + ' 经验' : '') + '</p>' : '';
        return '<div class="card" data-cat="' + m.cat + '" data-elem="' + m.element + '" data-stage="' + (m.stage || '') + '">' +
            '<div class="tile sq"><span class="tier-tag">' + esc(m.en) + ' · ' + (m.element) + '</span>' + monsterSvg(m) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + esc(m.name) + '</h3>' +
            '<span class="en">' + esc(m.en) + '</span><span class="code">' + esc(m.code) + '</span></div>' +
            '<div class="tags" style="margin-top:2px">' +
            '<span class="tag ' + c.cls + '">' + c.n + '</span>' +
            (m.stage ? '<span class="tag">阶段 ' + m.stage + '</span>' : '<span class="tag">全局</span>') +
            '<span class="tag">' + esc(m.element) + '</span>' +
            '<span class="tag">' + esc(m.shape) + '</span>' +
            '</div>' +
            '<p class="note" style="margin-top:8px"><b>定位：</b>' + esc(m.role) + '</p>' +
            (noAtk ? '<p class="note" style="color:var(--accent)"><b>⚠ 不攻击</b>：' + esc(m.ai.desc) + '</p>' : '<p class="note"><b>AI：</b>' + esc(m.ai.desc) + '</p>') +
            '<div class="stats">' + atkStats + '</div>' +
            (m.skills && m.skills.length
                ? '<div class="sk-box"><div class="sk-head"><b>技能</b><span>' +
                  activeCount(m) + (m.cat === 'final_boss' ? ' 主动 · ' : ' / ') + m.skills.length + (m.cat === 'final_boss' ? ' 含被动' : ' 个') + '</span></div>' +
                  m.skills.map(skillLine).join('') + '</div>'
                : '') +
            reward +
            '<p class="note" style="margin-top:8px"><b>剪影：</b>' + esc(m.design) + '</p>' +
            '<p class="note"><b>识别点：</b>' + esc(m.tell) + '</p>' +
            '<p class="note" style="font-size:11.5px;color:var(--muted)"><b>应对：</b>' + esc(m.build) + '</p>' +
            '<details><summary>Dota2 参考</summary><p class="note" style="margin-top:8px;font-size:11.5px">' + esc(m.dota) + '</p></details>' +
            '<div class="dl-row"><button class="btn tiny" data-svg="' + m.code + '">SVG</button>' +
            '<button class="btn tiny" data-png="' + m.code + '">PNG</button>' +
            '<button class="btn tiny" data-copy="' + m.code + '">复制代码</button></div>' +
            '</div></div>';
    }

    /* ---- 阶段 / 全局 / 最终 三大区 ---- */
    function stageMonsters(stage, cat) {
        return DATA.filter(function (m) { return m.stage === stage && m.cat === cat; });
    }

    function renderStageGrid() {
        var out = '';
        STAGES.forEach(function (s) {
            var smalls = stageMonsters(+s, 'small');
            var elites = stageMonsters(+s, 'elite');
            var boss = stageMonsters(+s, 'stage_boss');
            if (!smalls.length && !elites.length && !boss.length) return;
            out += '<h3 class="sec-hdd" style="color:var(--ink)">阶段 ' + s + ' · 小怪 ' + smalls.length + ' · 精英 ' + elites.length + ' · 守关 Boss ' + boss.length + '</h3>';
            if (smalls.length) out += '<div class="sec-sub">小怪</div><div class="grid">' + smalls.map(monsterCard).join('') + '</div>';
            if (elites.length) out += '<div class="sec-sub">精英</div><div class="grid">' + elites.map(monsterCard).join('') + '</div>';
            if (boss.length) out += '<div class="sec-sub">守关 Boss</div><div class="grid">' + boss.map(monsterCard).join('') + '</div>';
        });
        el('stageGrid').innerHTML = out;
    }

    function renderSpecialGrid() {
        var specials = DATA.filter(function (m) { return m.cat === 'gold_boss' || m.cat === 'kill_boss' || m.cat === 'defense_boss'; });
        el('specialGrid').innerHTML = specials.map(monsterCard).join('');
    }

    function renderFinalGrid() {
        var finals = DATA.filter(function (m) { return m.cat === 'final_boss'; });
        el('finalGrid').innerHTML = finals.map(monsterCard).join('');
    }

    /* ---- 难度循环表 ---- */
    function renderCycle() {
        var finals = DATA.filter(function (m) { return m.cat === 'final_boss'; }).sort(function (a, b) { return a.id - b.id; });
        var order = ['fire', 'ice', 'dark', 'lightning', 'poison', 'physical'];
        // 构建一张难度 → Boss 表
        var rows = [];
        for (var i = 0; i < finals.length; i++) {
            var lo = i * 5 + 1, hi = i * 5 + 5;
            rows.push(finals[i]);
        }
        el('cycleTable').innerHTML =
            '<thead><tr><th>难度</th><th>最终Boss</th><th>元素</th><th>HP</th><th>ATK</th><th>主动技能</th></tr></thead><tbody>' +
            rows.map(function (m, i) {
                var lo = i * 5 + 1, hi = i * 5 + 5;
                return '<tr><td>' + lo + ' - ' + hi + '</td><td>' + esc(m.name) + '</td>' +
                    '<td>' + esc(m.element) + '</td><td>' + m.stats.hp + '</td><td>' + m.stats.atk + '</td>' +
                    '<td>' + activeCount(m) + '</td></tr>';
            }).join('') + '</tbody>';
        var note = '<p class="sec-desc" style="margin-top:8px">难度 1-5 → ' + finals[0].name + ' … 难度 96-100 → ' + finals[finals.length - 1].name +
            '。<b>难度 100 之后：</b>循环这 ' + finals.length + ' 只 Boss，仅按 <code>difficultyMultiplier</code> 提高属性（HP/ATK/护甲/移速随难度线性增长），Boss 类型与技能不变。</p>';
        el('cycleNote').innerHTML = note;
    }

    /* ---- 过滤展示（全图鉴汇总视图） ---- */
    function renderFilters() {
        var catChips = ['全部'].concat(Object.keys(CATS)).map(function (k) {
            var c = k === '全部' ? DATA.length : DATA.filter(function (m) { return m.cat === k; }).length;
            return '<button class="chip ' + (state.cat === k ? 'on' : '') + '" data-cat="' + k + '">' +
                (k === '全部' ? '全部' : CATS[k].n) + ' ' + c + '</button>';
        }).join('');
        var elemChips = ['全部'].concat(ELEMS).map(function (e) {
            var c = e === '全部' ? DATA.length : DATA.filter(function (m) { return m.element === e; }).length;
            return '<button class="chip ' + (state.elem === e ? 'on' : '') + '" data-elem="' + e + '">' + e + ' ' + c + '</button>';
        }).join('');
        var stageChips = ['全部'].concat(STAGES).map(function (s) {
            var c = s === '全部' ? DATA.length : DATA.filter(function (m) { return m.stage === +s; }).length;
            return '<button class="chip ' + (state.stage === s ? 'on' : '') + '" data-stage="' + s + '">阶段' + s + ' ' + c + '</button>';
        }).join('');
        el('mFilters').innerHTML = catChips + '<div class="filters" style="margin:6px 0 0">' + elemChips + '</div><div class="filters" style="margin:6px 0 0">' + stageChips + '</div>';
    }

    function renderCatalog() {
        var list = DATA.filter(function (m) {
            return (state.cat === '全部' || m.cat === state.cat) &&
                   (state.elem === '全部' || m.element === state.elem) &&
                   (state.stage === '全部' || m.stage === +state.stage);
        });
        el('catalogGrid').innerHTML = list.map(monsterCard).join('');
        el('catalogCount').textContent = list.length + ' / ' + DATA.length;
    }

    /* ---- 总览统计 ---- */
    function renderOverview() {
        var byCat = {};
        DATA.forEach(function (m) { byCat[m.cat] = (byCat[m.cat] || 0) + 1; });
        el('ovTotal').textContent = DATA.length;
        el('ovCat').innerHTML = Object.keys(CATS).map(function (k) {
            var c = byCat[k] || 0;
            return '<div class="ov-card"><b>' + c + '</b><span>' + CATS[k].n + '</span></div>';
        }).join('');
        var byElem = ELEMS.map(function (e) {
            var c = DATA.filter(function (m) { return m.element === e; }).length;
            return { name: e, count: c };
        }).sort(function (a, b) { return b.count - a.count; });
        el('ovElem').innerHTML = byElem.map(function (e) {
            var pct = Math.round(e.count / DATA.length * 100);
            return '<div class="arche"><span class="arche-n">' + esc(e.name) + '</span><span class="arche-bar"><i style="width:' + pct + '%"></i></span><span class="arche-c">' + e.count + '</span></div>';
        }).join('');
    }

    /* ---- 配置导出 ---- */
    function renderConfig() {
        el('cfgOut').value = JSON.stringify({
            monsters: DATA,
            difficulty_cycle: {
                final_boss_count: DATA.filter(function (m) { return m.cat === 'final_boss'; }).length,
                levels_per_boss: 5,
                note: '难度1-5=Boss1 … 难度96-100=Boss20；之后每5级循环这20只，仅按difficultyMultiplier提高属性。'
            }
        }, null, 2);
    }

    function renderAll() {
        if (el('brandMark') && DATA[0]) el('brandMark').innerHTML = monsterSvg(DATA.find(function (m) { return m.cat === 'stage_boss'; }) || DATA[0]);
        renderOverview();
        renderStageGrid();
        renderSpecialGrid();
        renderFinalGrid();
        renderCycle();
        renderFilters();
        renderCatalog();
        renderConfig();
    }

    /* ---- 事件 ---- */
    function bind() {
        el('themeSel').addEventListener('change', function () {
            state.theme = this.value;
            document.documentElement.setAttribute('data-theme', state.theme);
            renderStageGrid(); renderSpecialGrid(); renderFinalGrid(); renderCatalog(); renderConfig();
        });
        el('scaleSel').addEventListener('change', function () { state.size = +this.value; });
        el('bgChk').addEventListener('change', function () { state.bg = this.checked; });

        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('button') : null;
            if (!t) return;
            if (t.dataset.cat) { state.cat = t.dataset.cat; renderFilters(); renderCatalog(); return; }
            if (t.dataset.elem) { state.elem = t.dataset.elem; renderFilters(); renderCatalog(); return; }
            if (t.dataset.stage) { state.stage = t.dataset.stage; renderFilters(); renderCatalog(); return; }
            if (t.dataset.svg) { var m = findMon(t.dataset.svg); if (m) dlSvg(m); return; }
            if (t.dataset.png) { var m2 = findMon(t.dataset.png); if (m2) dlPng(m2); return; }
            if (t.dataset.copy) {
                var m3 = findMon(t.dataset.copy);
                if (m3) copyInner(monsterSvg(m3), '已复制 ' + m3.code + ' 徽记');
                return;
            }
            if (t.dataset.dump) {
                saveBlob(new Blob([JSON.stringify({
                    monsters: DATA,
                    difficulty_cycle: {
                        final_boss_count: DATA.filter(function (m) { return m.cat === 'final_boss'; }).length,
                        levels_per_boss: 5,
                        note: '难度1-5=Boss1 … 难度96-100=Boss20；之后每5级循环这20只，仅按difficultyMultiplier提高属性。'
                    }
                }, null, 2)], { type: 'application/json;charset=utf-8' }), 'monster-design.json');
                toast('已下载 monster-design.json');
                return;
            }
        });
    }
    function findMon(code) { return DATA.filter(function (m) { return m.code === code; })[0]; }
    function copyInner(txt, msg) {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast(msg); } catch (e) { toast('复制失败'); }
        ta.remove();
    }

    /* ---- 左侧章节导航：平滑跳转 + 滚动高亮 ---- */
    function initSideNav() {
        var items = Array.prototype.slice.call(document.querySelectorAll('.side-nav a'));
        if (!items.length) return;

        // 平滑滚动（避开 sticky 顶栏高度）
        items.forEach(function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                var href = a.getAttribute('href');
                if (href === '#top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
                var target = document.querySelector(href);
                if (target) {
                    var top = target.getBoundingClientRect().top + window.pageYOffset - 62;
                    window.scrollTo({ top: top, behavior: 'smooth' });
                }
            });
        });

        // 目标集合（含 body 顶部）
        var targets = items.map(function (a) {
            var id = a.getAttribute('data-spy');
            return { id: id, el: id === 'top' ? document.body : document.getElementById(id) };
        }).filter(function (t) { return t.el; });

        function update() {
            var pos = window.pageYOffset + 92; // 顶栏 + 一点余量
            var current = targets[0] ? targets[0].id : null;
            targets.forEach(function (t) {
                if (t.el.offsetTop <= pos) current = t.id;
            });
            // 滚到底时高亮"回顶部"
            if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) {
                current = 'top';
            }
            items.forEach(function (a) {
                a.classList.toggle('on', a.getAttribute('data-spy') === current);
            });
        }

        window.addEventListener('scroll', update, { passive: true });
        update();
    }

    document.documentElement.setAttribute('data-theme', state.theme);
    renderAll();
    bind();
    initSideNav();
    window.MonsterApp = { DATA: DATA, monsterSvg: monsterSvg };
})();
