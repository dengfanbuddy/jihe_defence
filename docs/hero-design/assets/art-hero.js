/**
 * HeroSigil —— 英雄徽记生成器（Glyph 风格，参数化）
 *
 * 不逐英雄手绘，而是由「流派形状 + 属性倾向 + 元素标记 + 稀有度环」合成，
 * 保证 30 个英雄各有可辨识剪影、且整体美术统一。导出图不含 <text>。
 *
 * 每个英雄输出 viewBox 0 0 120 120 的 SVG 内部标记。
 * 流派 → 本体形状；最高倾向 → 内芯；元素 → 外围标记；局外成长侧重 → 基座。
 */
(function (global) {
    'use strict';

    var U = global.GlyphArt.util;
    var poly = U.poly, ptOn = U.ptOn, arrow = U.arrowHead;
    function n(v) { return (Math.round(v * 100) / 100).toString(); }
    function g(inner) { return '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>'; }

    /* 流派 → 本体轮廓（都在 120×120 内，中心 60,60） */
    var ARCH = {
        '物理暴击': function (p) {
            var b = '';
            for (var i = 0; i < 5; i++) {
                var t = ptOn(60, 60, 34, -90 + i * 72), l = ptOn(60, 60, 7, -90 + i * 72 + 36), r = ptOn(60, 60, 7, -90 + i * 72 - 36);
                b += '<path d="M' + n(l[0]) + ' ' + n(l[1]) + ' L' + n(t[0]) + ' ' + n(t[1]) + ' L' + n(r[0]) + ' ' + n(r[1]) + ' Z" fill="none" stroke="' + p.ink + '" stroke-width="3"/>';
            }
            return g([b, '<circle cx="60" cy="60" r="7" fill="' + p.accent + '"/>'].join(''));
        },
        '远程点杀': function (p) {
            return g([
                '<path d="M22 52 H40 M14 60 H38 M22 68 H40" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M40 34 L84 60 L40 86 L54 60 Z" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="62" cy="60" r="5" fill="' + p.accent + '"/>',
                '<circle cx="84" cy="60" r="3" fill="' + p.ink + '"/>'
            ].join(''));
        },
        '法术爆发': function (p) {
            var s = '';
            for (var i = 0; i < 8; i++) {
                var d = i * 45, a = ptOn(60, 60, 20, d), b = ptOn(60, 60, i % 2 ? 32 : 40, d);
                s += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="' + (i % 2 ? 1.8 : 3) + '"/>';
            }
            return g([s, '<circle cx="60" cy="60" r="13" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="60" cy="60" r="5.5" fill="' + p.accent + '"/>'].join(''));
        },
        '元素持续': function (p) {
            var s = '';
            for (var i = 0; i < 6; i++) {
                var d = -90 + i * 60, a = ptOn(60, 60, 0, d), b = ptOn(60, 60, 34, d);
                s += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="2.4"/>';
                var f = ptOn(60, 60, 22, d), ra = d * Math.PI / 180;
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(ra + .7) * 8) + ' ' + n(f[1] + Math.sin(ra + .7) * 8) + '" stroke="' + p.ink + '" stroke-width="1.4"/>';
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(ra - .7) * 8) + ' ' + n(f[1] + Math.sin(ra - .7) * 8) + '" stroke="' + p.ink + '" stroke-width="1.4"/>';
            }
            return g([s, '<circle cx="60" cy="60" r="9" fill="' + p.accent + '"/>'].join(''));
        },
        '控制减速': function (p) {
            return g([
                '<path d="M60 16 L104 60 L60 104 L16 60 Z" stroke="' + p.muted + '" stroke-width="1.4" stroke-dasharray="5 6"/>',
                '<path d="M60 26 A 34 34 0 1 0 94 60" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<path d="M60 34 A 26 26 0 1 1 86 60" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<circle cx="60" cy="60" r="4.5" fill="' + p.ink + '"/>',
                '<circle cx="30" cy="30" r="3" fill="' + p.accent + '"/><circle cx="90" cy="30" r="3" fill="' + p.accent + '"/>'
            ].join(''));
        },
        '坦克反伤': function (p) {
            return g([
                '<rect x="32" y="34" width="56" height="52" rx="6" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<path d="M46 48 H74 M46 62 H74 M46 76 H74" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<path d="M20 46 L34 46 M20 72 L34 72 M100 46 L86 46 M100 72 L86 72" stroke="' + p.accent + '" stroke-width="3"/>'
            ].join(''));
        },
        '召唤增殖': function (p) {
            var s = '';
            for (var i = 0; i < 4; i++) {
                var q = ptOn(60, 60, 34, -90 + i * 90);
                s += '<path d="M60 60 L' + n(q[0]) + ' ' + n(q[1]) + '" stroke="' + p.ink + '" stroke-width="1.6"/>';
                s += '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="7" fill="none" stroke="' + p.accent + '" stroke-width="2.2"/>';
            }
            return g([s, '<circle cx="60" cy="60" r="12" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="60" cy="60" r="5.5" fill="' + p.accent + '"/>'].join(''));
        },
        '经济成长': function (p) {
            var c = '<circle cx="40" cy="88" r="7" fill="none" stroke="' + p.accent + '" stroke-width="2.2"/>' +
                '<circle cx="60" cy="92" r="7" fill="none" stroke="' + p.accent + '" stroke-width="2.2"/>' +
                '<circle cx="80" cy="88" r="7" fill="none" stroke="' + p.accent + '" stroke-width="2.2"/>';
            return g([
                '<circle cx="60" cy="60" r="34" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<circle cx="60" cy="60" r="21" stroke="' + p.ink + '" stroke-width="1.6"/>',
                '<circle cx="60" cy="60" r="9" stroke="' + p.ink + '" stroke-width="2"/>',
                '<circle cx="60" cy="60" r="3.4" fill="' + p.accent + '"/>',
                c
            ].join(''));
        }
    };

    /* 元素 → 外围标记（本体下方） */
    var ELEM = {
        '火': '<path d="M34 96 L38 90 M46 94 L50 86 M58 94 L60 84" stroke="__C__" stroke-width="2"/>',
        '冰': '<path d="M34 92 L40 84 M50 92 L50 82 M66 92 L60 84" stroke="__C__" stroke-width="2"/>',
        '毒': '<circle cx="38" cy="90" r="2.5" fill="__C__"/><circle cx="52" cy="94" r="2" fill="__C__"/><circle cx="66" cy="90" r="2.5" fill="__C__"/>',
        '雷': '<path d="M36 88 L46 96 L60 88 L74 96" stroke="__C__" stroke-width="2"/>',
        '暗': '<path d="M38 92 L52 86 L68 92" stroke="__C__" stroke-width="2" stroke-dasharray="4 4"/>',
        '无': '',
        '物理': '<path d="M38 90 H52 M68 90 H82" stroke="__C__" stroke-width="2"/>'
    };

    /* 成长侧重 → 基座弧（本体下方） */
    var GROWTH = {
        '攻击型': '<path d="M28 108 H92" stroke="__P__" stroke-width="2.6"/>',
        '均衡型': '<path d="M32 106 L60 114 L88 106" stroke="__P__" stroke-width="2.4"/>',
        '生存型': '<path d="M40 106 A 20 20 0 0 1 80 106" stroke="__P__" stroke-width="2.6"/>',
        '攻速型': '<path d="M30 108 H48 M72 108 H90" stroke="__P__" stroke-width="2.6"/>',
        '暴击型': '<path d="M34 108 L60 100 L86 108" stroke="__P__" stroke-width="2.6"/>'
    };

    /**
     * 生成英雄徽记
     * @param h 英雄对象（至少含 archetype/element/growth/base）
     * @param p 调色板
     */
    function hero(h, p) {
        var arch = ARCH[h.archetype] || ARCH['远程点杀'];
        var elem = ELEM[h.element] || '';
        var grow = GROWTH[h.growth] || GROWTH['均衡型'];
        var elemMark = elem.replace(/__C__/g, p.accent);
        var growMark = grow.replace(/__P__/g, p.muted);
        return g([
            arch(p),
            elemMark,
            growMark,
            topMark(h, p)
        ].join(''));
    }

    /* 按最高属性在外圈加一颗强调点 */
    function topMark(h, p) {
        var pads = { atk: -90, hp: -18, range: 54, def: 126, aspd: 198, crit: 270, dodge: 342, regen: 414 };
        var keys = ['atk', 'hp', 'range', 'def', 'aspd', 'crit', 'dodge', 'regen'];
        var best = keys[0], v = -1;
        keys.forEach(function (k) { if (h.base && (h.base[k] || 0) > v) { v = h.base[k]; best = k; } });
        var deg = pads[best] || -90;
        var q = ptOn(60, 60, 50, deg);
        return '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="3.6" fill="' + p.accent + '" opacity="0.9"/>';
    }

    /* 供收藏页展示的纯图形 SVG（不含文字） */
    function svg(h, p, opts) {
        opts = opts || {};
        var vb = '0 0 120 120';
        var w = opts.size || 120, hh = opts.size ? Math.round(opts.size * 1) : 120;
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" width="' + w + '" height="' + hh + '">' + hero(h, p) + '</svg>';
    }

    global.HeroSigil = { hero: hero, svg: svg, ARCH: ARCH };
})(window);
