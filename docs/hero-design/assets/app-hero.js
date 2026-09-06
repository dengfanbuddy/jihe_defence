/**
 * 英雄设计页 —— 逻辑
 * 数据源：data-heroes-a/b/c.js（window.HERO_DATA_A/B/C）
 *         data-items.js（window.ITEM_DATA）
 *         data-skills.js（window.RSKILL_DATA / KBUFF_DATA）
 */
(function () {
    'use strict';

    var A = window.GlyphArt;         // 复用 monster-design 的调色板
    var S = window.HeroSigil;        // 英雄徽记生成器

    var HEROES = [].concat(
        window.HERO_DATA_A || [], window.HERO_DATA_B || [], window.HERO_DATA_C || []
    );
    var ITEMS = window.ITEM_DATA || [];
    var RSKILLS = window.RSKILL_DATA || [];
    var KBUFFS = window.KBUFF_DATA || [];

    var state = { theme: 'light', size: 512, bg: false, arche: '全部', elem: '全部', itemQ: '全部', skillQ: '全部' };
    var ARCHES = ['物理暴击', '远程点杀', '法术爆发', '元素持续', '控制减速', '坦克反伤', '召唤增殖', '经济成长'];
    var ELEMS = ['物理', '火', '冰', '毒', '雷', '暗', '无'];
    var QITEM = { white: { n: '白', c: 'q-white' }, blue: { n: '蓝', c: 'q-blue' }, gold: { n: '黄', c: 'q-gold' }, red: { n: '红', c: 'q-red' } };
    var QSKILL = { common: { n: '白', c: 'q-white' }, rare: { n: '蓝', c: 'q-blue' }, epic: { n: '黄', c: 'q-gold' }, legendary: { n: '红', c: 'q-red' } };
    var DRAW = window.RSKILL_DRAW || [];

    function el(id) { return document.getElementById(id); }
    function pal() { return A.PALETTES[state.theme]; }
    function n(v) { return (Math.round(v * 100) / 100).toString(); }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function buildByCode(code) { return (ITEMS.filter(function (i) { return i.code === code; })[0] || {}).name || code; }

    /* ---- 徽记 SVG ---- */
    function heroSvg(h, opts) {
        var p = pal();
        var s = S.svg(h, p, opts || {});
        return s;
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
    function dlSvg(h) {
        saveBlob(new Blob([heroSvg(h, { size: state.size })], { type: 'image/svg+xml;charset=utf-8' }),
            'hero_' + h.code + '_' + state.theme + '.svg');
        toast('已下载 ' + h.code + '.svg');
    }
    function dlPng(h) {
        var str = heroSvg(h, { size: state.size });
        rasterize(str, state.size, state.size, function (b) {
            if (b) { saveBlob(b, 'hero_' + h.code + '_' + state.theme + '.png'); toast('已下载 PNG'); }
        });
    }
    var tTimer = null;
    function toast(m) {
        var t = el('toast'); t.textContent = m; t.classList.add('show');
        clearTimeout(tTimer); tTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
    }

    /* ---- 卡片渲染 ---- */
    function tags(list, cls) {
        return list.map(function (t) { return '<span class="tag ' + (cls || '') + '">' + esc(t) + '</span>'; }).join('');
    }

    function skillRows(obj, kind) {
        var label = kind === 'passive' ? '被动' : kind === 'attack' ? '普攻' : '技能';
        var rows = [
            ['Lv.1', obj.lv1, ''], ['Lv.10', obj.lv10, 'up'], ['Lv.20', obj.lv20, 'up'], ['Lv.30', obj.lv30, 'up']
        ];
        return rows.map(function (r) {
            return '<div class="sk-row"><span class="sk-lv">' + r[0] + '</span><span class="sk-txt">' + esc(r[1]) + '</span></div>';
        }).join('');
    }
    function staticSkillRows(obj, kind) {
        var label = kind === 'passive' ? '被动' : kind === 'attack' ? '普攻' : '技能';
        return '<div class="sk-row"><span class="sk-lv">固定</span><span class="sk-txt">' +
            esc(obj && (obj.desc || obj.lv1 || '') || '') + '</span></div>';
    }

    function heroCard(h) {
        var archCls = { '坦克反伤': '', '召唤增殖': '', '控制减速': '', '经济成长': '' }[h.archetype] || '';
        return '<div class="card hero" id="hero' + h.id + '">' +
            '<div class="tile sq"><span class="tier-tag">' + esc(h.en) + ' · Lv.1</span>' + heroSvg(h) + '</div>' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + esc(h.name) + '</h3>' +
            '<span class="en">' + esc(h.en) + '</span><span class="code">' + esc(h.code) + '</span></div>' +
            '<div class="tags" style="margin-top:2px">' +
            '<span class="tag ' + archCls + '">' + esc(h.archetype) + '</span>' +
            '<span class="tag">' + esc(h.element) + '</span>' +
            '<span class="tag">' + esc(h.growth) + '</span>' +
            '<span class="tag">难度 ' + h.difficulty + '</span>' +
            '</div>' +
            '<p class="note" style="margin-top:8px"><b>定位：</b>' + esc(h.role) + '</p>' +
            '<div class="stats">' +
            stat(h.base.atk, 'ATK') + stat(h.base.hp, 'HP') + stat(h.base.range + 'm', 'RNG') +
            stat(h.base.def, 'ARM') + stat(h.base.aspd, 'ASPD') + stat(h.base.crit + '%', 'CRIT') +
            '</div>' +
            '<div class="sk-box">' +
            '<div class="sk-head"><b>' + esc(h.passive.name) + '</b><span>被动</span></div>' + staticSkillRows(h.passive, 'passive') +
            '<div class="sk-head"><b>' + esc(h.attack.name) + '</b><span>普攻</span></div>' + staticSkillRows(h.attack, 'attack') +
            '<div class="sk-head"><b>' + esc(h.skill.name) + '</b><span>技能 · 随等级升级</span></div>' + skillRows(h.skill, 'skill') +
            '</div>' +
            '<p class="note" style="margin-top:10px"><b>推荐构筑：</b>' + esc(stripPrefix(h.build, '推荐构筑')) + '</p>' +
            '<p class="note"><b>提示：</b>' + esc(h.tip) + '</p>' +
            '<p class="note" style="font-size:11.5px;color:var(--muted)"><b>解锁：</b>' +
            esc((h.unlock && h.unlock.ach) || '') + '</p>' +
            '<details><summary>局外成长侧重</summary><pre>' + esc('成长类型: ' + h.growth + '\n每级增量: ' + growthText(h.growth)) + '</pre></details>' +
            '<div class="dl-row"><button class="btn tiny" data-svg="' + h.code + '">SVG</button>' +
            '<button class="btn tiny" data-png="' + h.code + '">PNG</button>' +
            '<button class="btn tiny" data-copy="' + h.code + '">复制代码</button></div>' +
            '</div></div>';
    }

    function growthText(g) {
        var m = {
            '攻击型': '攻击+3 生命+12 射程+0.1 护甲+0.5 攻速+0.03 暴击+0.5% 闪避+0.2% 回复+0.05',
            '均衡型': '攻击+2 生命+18 射程+0.1 护甲+0.8 攻速+0.02 暴击+0.3% 闪避+0.3% 回复+0.08',
            '生存型': '攻击+1.5 生命+25 射程+0.05 护甲+1.0 攻速+0.01 暴击+0.2% 闪避+0.3% 回复+0.12',
            '攻速型': '攻击+2 生命+14 射程+0.08 护甲+0.4 攻速+0.04 暴击+0.4% 闪避+0.3% 回复+0.06',
            '暴击型': '攻击+2.5 生命+10 射程+0.05 护甲+0.3 攻速+0.02 暴击+0.6% 闪避+0.4% 回复+0.04'
        };
        return m[g] || '—';
    }
    function stat(v, k) { return '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>'; }
    function stripPrefix(s, pre) {
        var t = (s == null ? '' : String(s)).trim();
        if (pre && t.indexOf(pre) === 0) t = t.slice(pre.length);
        while (t.charAt(0) === '：' || t.charAt(0) === ':') t = t.slice(1);
        return t.trim();
    }

    /* ---- 物品卡（带图标 / 4 品质 / 无合成） ---- */
    function itemCard(it) {
        var q = QITEM[it.quality] || QITEM.white;
        var stars = '★★★★★'.slice(0, { white: 1, blue: 2, gold: 3, red: 4 }[it.quality] || 1);
        return '<div class="card item" data-q="' + it.quality + '" data-tag="' + esc(it.tags.join(',')) + '">' +
            '<div class="item-head">' +
            '<span class="item-icon"><img src="' + esc(it.img) + '" alt="' + esc(it.name) + '" loading="lazy" onerror="this.style.display=\'none\'"></span>' +
            '<span class="item-title"><b class="display">' + esc(it.name) + '</b>' +
            '<span class="en">' + esc(it.en || it.name) + '</span></span>' +
            '<span class="q-badge ' + q.c + '">' + q.n + '</span>' +
            '</div>' +
            '<div class="item-meta"><span class="q-stars">' + stars + '</span><span class="cost">' + it.cost + ' 金</span></div>' +
            '<div class="tags" style="margin-top:8px">' + tags(it.tags || []) + '</div>' +
            '<div class="suggest">' + esc(it.suggest || '') + '</div>' +
            (it.attr && it.attr.length ? '<div class="attr-line">' + it.attr.map(function (a) { return '<span>' + esc(a) + '</span>'; }).join('<span class="dot">·</span>') + '</div>' : '') +
            (it.effect ? '<p class="note" style="margin-top:8px"><b>效果：</b>' + esc(it.effect) + '</p>' : '') +
            (it.lore ? '<p class="note" style="margin-top:6px;color:var(--muted);font-size:11.5px">' + esc(it.lore.slice(0, 60)) + '</p>' : '') +
            '</div>';
    }
    function attrCN(k) {
        return { atk: '攻击', hp: '生命', range: '射程', def: '护甲', aspd: '攻速', crit: '暴击', dodge: '闪避', regen: '回复', cdr: '冷却', gold: '金币', summon: '召唤物', elem: '元素' }[k] || k;
    }

    function skillCard(s) {
        var q = QSKILL[s.rarity] || QSKILL.common;
        var w = window.RSKILL_QUAL_NAME || {};
        return '<div class="card item" data-q="' + s.rarity + '">' +
            '<div class="item-head">' +
            '<span class="skill-glyph ' + q.c + '">' + esc((s.name || '').slice(0, 1)) + '</span>' +
            '<span class="item-title"><b class="display">' + esc(s.name) + '</b>' +
            '<span class="en">' + esc(s.en) + '</span></span>' +
            '<span class="q-badge ' + q.c + '">' + q.n + '</span>' +
            '</div>' +
            '<div class="item-meta"><span class="cost">抽取权重 ' + s.weight + '</span></div>' +
            '<div class="tags" style="margin-top:8px">' + tags(s.tags || []) + '</div>' +
            '<div class="sk-box">' +
            '<div class="sk-row"><span class="sk-lv">Lv.1</span><span class="sk-txt">' + esc(s.lv1) + '</span></div>' +
            '<div class="sk-row up"><span class="sk-lv">Lv.2</span><span class="sk-txt">' + esc(s.lv2) + '</span></div>' +
            '<div class="sk-row up"><span class="sk-lv">Lv.3</span><span class="sk-txt">' + esc(s.lv3) + '</span></div>' +
            '</div>' +
            (s.synergy ? '<p class="note" style="margin-top:8px;font-size:11.5px;color:var(--muted)"><b>联动：</b>' + esc(s.synergy) + '</p>' : '') +
            '</div>';
    }

    function buffCard(b) {
        var special = b.stat === 'special';
        return '<div class="card item">' +
            '<div class="card-body">' +
            '<div class="name-row"><h3 class="display">' + esc(b.name) + '</h3>' +
            '<span class="en">' + (special ? '特殊' : attrCN(b.stat)) + '型</span></div>' +
            '<p class="note" style="margin-top:8px"><b>单次：</b>' + esc(b.per) + '</p>' +
            '<p class="note"><b>叠加：</b>上限 ' + b.max + ' 层 · ' + (special ? '价格' + b.price + ' 击杀点' : '单价 ' + b.price + ' · 每次 ×' + b.growth) + '</p>' +
            '<div class="tags" style="margin-top:6px">' + tags(b.tags || []) + '</div>' +
            (b.note ? '<p class="note" style="margin-top:8px;font-size:11.5px;color:var(--muted)">' + esc(b.note) + '</p>' : '') +
            '</div></div>';
    }

    /* ---- 区段渲染 ---- */
    function renderOverview() {
        el('ovHeroCount').textContent = HEROES.length;
        el('ovItemCount').textContent = ITEMS.length;
        el('ovSkillCount').textContent = RSKILLS.length;
        el('ovBuffCount').textContent = KBUFFS.length;

        var archCount = ARCHES.map(function (a) {
            var c = HEROES.filter(function (h) { return h.archetype === a; }).length;
            return { name: a, count: c };
        }).sort(function (x, y) { return y.count - x.count; });
        el('ovArche').innerHTML = archCount.map(function (a) {
            var pct = Math.round(a.count / HEROES.length * 100);
            return '<div class="arche"><span class="arche-n">' + esc(a.name) + '</span>' +
                '<span class="arche-bar"><i style="width:' + pct + '%"></i></span>' +
                '<span class="arche-c">' + a.count + ' 位</span></div>';
        }).join('');

        el('ovTable').innerHTML = '<tbody>' + HEROES.map(function (h) {
            return '<tr><td>' + esc(h.name) + '</td><td>' + esc(h.en) + '</td>' +
                '<td>' + esc(h.archetype) + '</td><td>' + esc(h.element) + '</td><td>' + esc(h.growth) + '</td>' +
                '<td>' + h.base.atk + '</td><td>' + h.base.hp + '</td><td>' + h.base.range + 'm</td>' +
                '<td>' + h.base.aspd + '</td><td>' + h.difficulty + '</td>' +
                '<td><a href="#hero' + h.id + '">' + esc(h.unlock && h.unlock.ach || '') + '</a></td></tr>';
        }).join('') + '</tbody>';
    }

    function renderHeroes() {
        var list = HEROES.filter(function (h) {
            return (state.arche === '全部' || h.archetype === state.arche) &&
                   (state.elem === '全部' || h.element === state.elem);
        });
        el('heroGrid').innerHTML = list.map(heroCard).join('');
        el('heroCount').textContent = list.length + ' / ' + HEROES.length;
    }

    function renderFilters() {
        var archChips = ['全部'].concat(ARCHES).map(function (a) {
            return '<button class="chip ' + (state.arche === a ? 'on' : '') + '" data-arche="' + a + '">' + a + '</button>';
        }).join('');
        var elemChips = ['全部'].concat(ELEMS).map(function (e) {
            return '<button class="chip ' + (state.elem === e ? 'on' : '') + '" data-elem="' + e + '">' + e + '</button>';
        }).join('');
        el('archFilters').innerHTML = archChips;
        el('elemFilters').innerHTML = elemChips;

        // 道具品质筛选
        var itemChips = ['全部'].concat(['white', 'blue', 'gold', 'red']).map(function (q) {
            var c = q === '全部' ? ITEMS.length : ITEMS.filter(function (i) { return i.quality === q; }).length;
            var n = q === '全部' ? '全部' : QITEM[q].n;
            return '<button class="chip ' + (state.itemQ === q ? 'on' : '') + '" data-itemq="' + q + '">' + n + ' ' + c + '</button>';
        }).join('');
        el('itemFilters').innerHTML = itemChips;

        // 技能品质筛选
        var skillChips = ['全部'].concat(['common', 'rare', 'epic', 'legendary']).map(function (r) {
            var c = r === '全部' ? RSKILLS.length : RSKILLS.filter(function (s) { return s.rarity === r; }).length;
            var n = r === '全部' ? '全部' : QSKILL[r].n;
            return '<button class="chip ' + (state.skillQ === r ? 'on' : '') + '" data-skillq="' + r + '">' + n + ' ' + c + '</button>';
        }).join('');
        el('skillFilters').innerHTML = skillChips;
    }

    function renderItems() {
        var order = ['white', 'blue', 'gold', 'red'];
        var box = el('itemGrid');
        var list = ITEMS.filter(function (i) { return state.itemQ === '全部' || i.quality === state.itemQ; });
        el('itemCount').textContent = list.length + ' / ' + ITEMS.length;
        box.innerHTML = order.map(function (q) {
            var group = list.filter(function (i) { return i.quality === q; });
            if (!group.length) return '';
            return '<h3 class="sec-hdd" style="color:var(--ink)"><span class="q-dot ' + QITEM[q].c + '"></span>' + QITEM[q].n +
                ' · ' + group.length + '</h3>' +
                '<div class="grid">' + group.map(itemCard).join('') + '</div>';
        }).join('');
    }

    function renderSkills() {
        var order = ['common', 'rare', 'epic', 'legendary'];
        var list = RSKILLS.filter(function (s) { return state.skillQ === '全部' || s.rarity === state.skillQ; });
        el('skillCount').textContent = list.length + ' / ' + RSKILLS.length;
        el('skillGrid').innerHTML = order.map(function (r) {
            var group = list.filter(function (s) { return s.rarity === r; });
            if (!group.length) return '';
            return '<h3 class="sec-hdd" style="color:var(--ink)"><span class="q-dot ' + QSKILL[r].c + '"></span>' + QSKILL[r].n +
                ' · ' + group.length + '</h3>' +
                '<div class="grid">' + group.map(skillCard).join('') + '</div>';
        }).join('');
    }

    function renderLegend(elId) {
        var host = el(elId);
        if (!host) return;
        var keys = elId === 'itemLegend' ? ['white', 'blue', 'gold', 'red'] : ['common', 'rare', 'epic', 'legendary'];
        var map = elId === 'itemLegend' ? QITEM : QSKILL;
        host.innerHTML = keys.map(function (k) {
            return '<span class="q-legend-item"><span class="q-chip ' + map[k].c + '">' + map[k].n + '</span>' +
                ({ white: '普通', blue: '稀有', gold: '史诗', red: '传说' }[k] || '') + '</span>';
        }).join('');
    }

    function renderDraw() {
        var host = el('drawTable');
        if (!host || !DRAW.length) return;
        var head = '<tr><th>英雄等级</th><th class="q-th q-white">白</th><th class="q-th q-blue">蓝</th>' +
            '<th class="q-th q-gold">黄</th><th class="q-th q-red">红</th></tr>';
        var rows = DRAW.map(function (d) {
            return '<tr><td>' + esc(d.band) + '</td>' +
                '<td>' + d.white + '%</td><td>' + d.blue + '%</td><td>' + d.gold + '%</td><td>' + d.red + '%</td></tr>';
        }).join('');
        host.innerHTML = head + rows;
    }

    function renderBuffs() {
        el('buffGrid').innerHTML = KBUFFS.map(buffCard).join('');
    }

    function renderConfig() {
        el('cfgOut').value = JSON.stringify({
            heroes: HEROES,
            items: ITEMS,
            roguelike_skills: RSKILLS,
            kill_shop_buffs: KBUFFS
        }, null, 2);
    }

    function renderAll() {
        if (el('brandMark') && HEROES[0]) el('brandMark').innerHTML = heroSvg(HEROES[0]);
        renderOverview();
        renderFilters();
        renderHeroes();
        renderItems();
        renderLegend('itemLegend');
        renderSkills();
        renderLegend('skillLegend');
        renderDraw();
        renderBuffs();
        renderConfig();
    }

    /* ---- 事件 ---- */
    function bind() {
        el('themeSel').addEventListener('change', function () {
            state.theme = this.value;
            document.documentElement.setAttribute('data-theme', state.theme);
            renderHeroes(); renderItems(); el('cfgOut').value = '';
            el('cfgOut').value = JSON.stringify({ heroes: HEROES, items: ITEMS, roguelike_skills: RSKILLS, kill_shop_buffs: KBUFFS }, null, 2);
        });
        el('scaleSel').addEventListener('change', function () { state.size = +this.value; });
        el('bgChk').addEventListener('change', function () { state.bg = this.checked; });

        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('button') : null;
            if (!t) return;
            if (t.dataset.arche) { state.arche = t.dataset.arche; renderFilters(); renderHeroes(); return; }
            if (t.dataset.elem) { state.elem = t.dataset.elem; renderFilters(); renderHeroes(); return; }
            if (t.dataset.itemq) { state.itemQ = t.dataset.itemq; renderFilters(); renderItems(); return; }
            if (t.dataset.skillq) { state.skillQ = t.dataset.skillq; renderFilters(); renderSkills(); return; }
            if (t.dataset.svg) { var h = findHero(t.dataset.svg); if (h) dlSvg(h); return; }
            if (t.dataset.png) { var h2 = findHero(t.dataset.png); if (h2) dlPng(h2); return; }
            if (t.dataset.copy) {
                var h3 = findHero(t.dataset.copy);
                if (h3) copyInner(heroSvg(h3), '已复制 ' + h3.code + ' 徽记');
                return;
            }
            if (t.dataset.dump) {
                saveBlob(new Blob([JSON.stringify({ heroes: HEROES, items: ITEMS, roguelike_skills: RSKILLS, kill_shop_buffs: KBUFFS }, null, 2)],
                    { type: 'application/json;charset=utf-8' }), 'hero-design.json');
                toast('已下载 hero-design.json');
                return;
            }
        });
    }
    function findHero(code) { return HEROES.filter(function (h) { return h.code === code; })[0]; }
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

        var targets = items.map(function (a) {
            var id = a.getAttribute('data-spy');
            return { id: id, el: id === 'top' ? document.body : document.getElementById(id) };
        }).filter(function (t) { return t.el; });

        function update() {
            var pos = window.pageYOffset + 92;
            var current = targets[0] ? targets[0].id : null;
            targets.forEach(function (t) {
                if (t.el.offsetTop <= pos) current = t.id;
            });
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
    window.HeroApp = { HEROES: HEROES, ITEMS: ITEMS, RSKILLS: RSKILLS, KBUFFS: KBUFFS, heroSvg: heroSvg };
})();
