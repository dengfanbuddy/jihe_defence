/**
 * GlyphArt —— Glyphica 风格几何美术库
 *
 * 设计约束（全部来自 Glyphica 实机画面的提炼）：
 * 1. 纯几何：只用圆 / 多边形 / 弧 / 折线，不用渐变、不用位图、不用外部字体。
 * 2. 双色制：ink（主墨色） + accent（唯一强调色），muted 只承担辅助信息。
 * 3. 细线条：主结构 2.2~3px，细节 1.2~1.6px，全部 round 端点。
 * 4. 可读剪影：任何怪物缩到 24px 仍能靠"外轮廓"区分。
 * 5. 无文字：导出图不含 <text>，保证 PNG 栅格化 100% 一致。
 *
 * 每个绘制函数签名: (p: Palette) => string(SVG 内部标记)
 *   怪物   viewBox 0 0 120 120
 *   弹道   viewBox 0 0 160 90
 *   图标   viewBox 0 0 96 96
 */
(function (global) {
    'use strict';

    /* ---------------------------------------------------------------- 调色板 */
    var PALETTES = {
        light: {
            key: 'light',
            label: '纸面 / Paper',
            paper: '#F5F3ED',
            bg: '#EAE7E0',
            bgEdge: '#D6D2C8',
            ink: '#4A453F',
            muted: '#A29C92',
            accent: '#A8474B',
            onAccent: '#F2EFE8'
        },
        dark: {
            key: 'dark',
            label: '夜场 / Night',
            paper: '#1D1D1B',
            bg: '#151514',
            bgEdge: '#080807',
            ink: '#DCD8CF',
            muted: '#6E6A62',
            accent: '#E0B040',
            onAccent: '#17160F'
        }
    };

    /* ---------------------------------------------------------------- 工具函数 */
    function n(v) { return (Math.round(v * 100) / 100).toString(); }

    function ptOn(cx, cy, r, deg) {
        var a = deg * Math.PI / 180;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }

    /** 正多边形顶点串 */
    function poly(cx, cy, r, sides, rotDeg) {
        var out = [];
        for (var i = 0; i < sides; i++) {
            var p = ptOn(cx, cy, r, rotDeg + i * 360 / sides);
            out.push(n(p[0]) + ',' + n(p[1]));
        }
        return out.join(' ');
    }

    /** 阿基米德螺线折线 */
    function spiral(cx, cy, turns, r0, r1, steps) {
        var d = '';
        for (var i = 0; i <= steps; i++) {
            var t = i / steps;
            var a = t * turns * Math.PI * 2 - Math.PI / 2;
            var r = r0 + (r1 - r0) * t;
            d += (i ? 'L' : 'M') + n(cx + Math.cos(a) * r) + ' ' + n(cy + Math.sin(a) * r) + ' ';
        }
        return d.trim();
    }

    /** 朝向某点的箭头 */
    function arrowHead(x, y, deg, size, color, w) {
        var a = deg * Math.PI / 180;
        var b1 = a + 2.5, b2 = a - 2.5;
        return '<path d="M' + n(x + Math.cos(b1) * size) + ' ' + n(y + Math.sin(b1) * size) +
            ' L' + n(x) + ' ' + n(y) +
            ' L' + n(x + Math.cos(b2) * size) + ' ' + n(y + Math.sin(b2) * size) +
            '" stroke="' + color + '" stroke-width="' + (w || 2) + '" fill="none"/>';
    }

    function g(inner) {
        return '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>';
    }

    /* ================================================================ 怪物 */
    var monsters = {

        /* 1. 游标突刺 —— 锐角箭头 + 速度线，纯粹的"快" */
        caret_dasher: function (p) {
            return g([
                '<path d="M20 44 H42 M12 60 H38 M20 76 H42" stroke="' + p.muted + '" stroke-width="2"/>',
                '<path d="M46 30 L100 60 L46 90 L59 60 Z" fill="' + p.accent + '"/>',
                '<path d="M46 30 L100 60 L46 90 L59 60 Z" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<circle cx="72" cy="60" r="3.6" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 2. 蜂点群 —— 三点编队，共享一个虚线感知环 */
        swarm_dot: function (p) {
            return g([
                '<circle cx="60" cy="62" r="35" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 7"/>',
                '<path d="M60 38 L42 78 L78 78 Z" stroke="' + p.muted + '" stroke-width="1.2"/>',
                '<circle cx="60" cy="38" r="12.5" stroke="' + p.accent + '" stroke-width="1.3"/>',
                '<circle cx="60" cy="38" r="8" fill="' + p.accent + '"/>',
                '<circle cx="42" cy="78" r="7" fill="' + p.ink + '"/>',
                '<circle cx="78" cy="78" r="7" fill="' + p.ink + '"/>',
                '<circle cx="26" cy="46" r="2.6" fill="' + p.muted + '"/>',
                '<circle cx="96" cy="52" r="2.2" fill="' + p.muted + '"/>',
                '<circle cx="88" cy="92" r="2" fill="' + p.muted + '"/>'
            ].join(''));
        },

        /* 3. 括弧卫 —— 两道对开弧＝正面护盾 */
        bracket_guard: function (p) {
            return g([
                '<path d="M50 26 C 26 44 26 76 50 94" stroke="' + p.ink + '" stroke-width="5"/>',
                '<path d="M70 26 C 94 44 94 76 70 94" stroke="' + p.ink + '" stroke-width="5"/>',
                '<path d="M38 34 H30 M38 86 H30 M82 34 H90 M82 86 H90" stroke="' + p.muted + '" stroke-width="2"/>',
                '<path d="M60 45 L75 60 L60 75 L45 60 Z" fill="' + p.accent + '"/>',
                '<path d="M60 45 L75 60 L60 75 L45 60 Z" stroke="' + p.ink + '" stroke-width="1.8"/>'
            ].join(''));
        },

        /* 4. 分号裂体 —— 上核下逗，死亡后一分为二 */
        semicolon_splitter: function (p) {
            return g([
                '<circle cx="60" cy="60" r="35" stroke="' + p.ink + '" stroke-width="1.6" stroke-dasharray="6 9"/>',
                '<circle cx="60" cy="44" r="13.5" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<circle cx="60" cy="44" r="5.5" fill="' + p.accent + '"/>',
                '<circle cx="60" cy="76" r="9.5" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M55 84 C 57 92 54 95 48 96" stroke="' + p.accent + '" stroke-width="2.8"/>',
                '<path d="M30 60 H22 M98 60 H90" stroke="' + p.muted + '" stroke-width="1.6"/>'
            ].join(''));
        },

        /* 5. 井格壁垒 —— 网格方块，慢而硬 */
        hash_bulwark: function (p) {
            return g([
                '<rect x="28" y="28" width="64" height="64" rx="8" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M49 32 V88 M71 32 V88 M32 49 H88 M32 71 H88" stroke="' + p.muted + '" stroke-width="1.6"/>',
                '<path d="M28 46 V36 M36 28 H46 M92 46 V36 M84 28 H74 M28 74 V84 M36 92 H46 M92 74 V84 M84 92 H74" stroke="' + p.accent + '" stroke-width="3.4"/>',
                '<rect x="52" y="52" width="16" height="16" rx="2" fill="' + p.accent + '"/>'
            ].join(''));
        },

        /* 6. 环卫者 —— 三颗可单独击破的卫星 */
        orbiter_warden: function (p) {
            var sat = '';
            for (var i = 0; i < 3; i++) {
                var q = ptOn(60, 60, 36, -90 + i * 120);
                sat += '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="6" fill="' + p.ink + '"/>';
                sat += '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="10" stroke="' + p.accent + '" stroke-width="1.3"/>';
            }
            return g([
                '<circle cx="60" cy="60" r="36" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="2 7"/>',
                '<circle cx="60" cy="60" r="18" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<circle cx="60" cy="60" r="10" stroke="' + p.ink + '" stroke-width="1.4"/>',
                '<circle cx="60" cy="60" r="4.5" fill="' + p.accent + '"/>',
                sat
            ].join(''));
        },

        /* 7. 缄默者 —— 倒三角被一道横杠封住＝禁用 */
        silencer_glyph: function (p) {
            return g([
                '<path d="M26 38 L94 38 L60 92 Z" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M18 54 H102" stroke="' + p.accent + '" stroke-width="5.5"/>',
                '<circle cx="60" cy="72" r="5.5" fill="' + p.ink + '"/>',
                '<path d="M38 24 V32 M60 18 V28 M82 24 V32" stroke="' + p.muted + '" stroke-width="2"/>',
                '<path d="M26 100 H94" stroke="' + p.muted + '" stroke-width="1.4" stroke-dasharray="5 6"/>'
            ].join(''));
        },

        /* 8. 镜像残影 —— 半环对折，弹道会被反射 */
        mirror_shade: function (p) {
            return g([
                '<path d="M60 20 V100" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="4 6"/>',
                '<path d="M60 28 A 32 32 0 0 0 60 92" stroke="' + p.ink + '" stroke-width="4.4"/>',
                '<path d="M60 37 A 23 23 0 0 1 60 83" stroke="' + p.accent + '" stroke-width="2.8"/>',
                '<circle cx="60" cy="60" r="5" fill="' + p.ink + '"/>',
                '<path d="M14 38 L40 54" stroke="' + p.ink + '" stroke-width="2.4"/>',
                arrowHead(40, 54, 32, 10, p.ink, 2.4),
                '<path d="M40 66 L14 82" stroke="' + p.accent + '" stroke-width="2.4" stroke-dasharray="5 4"/>',
                arrowHead(14, 82, 148, 10, p.accent, 2.4)
            ].join(''));
        },

        /* 9. 织网者 —— 节点越多，友军越强 */
        weaver_node: function (p) {
            var R = 34, nodes = [], i, q;
            for (i = 0; i < 5; i++) nodes.push(ptOn(60, 60, R, -90 + i * 72));
            var spokes = nodes.map(function (q) { return 'M60 60 L' + n(q[0]) + ' ' + n(q[1]); }).join(' ');
            var web = nodes.map(function (q, i) { return (i ? 'L' : 'M') + n(q[0]) + ' ' + n(q[1]); }).join(' ') + ' Z';
            var dots = nodes.map(function (q, i) {
                return '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="' + (i % 2 ? 4 : 5.6) + '" fill="' + (i % 2 ? p.muted : p.accent) + '"/>';
            }).join('');
            return g([
                '<path d="' + web + '" stroke="' + p.muted + '" stroke-width="1.1" stroke-dasharray="5 5"/>',
                '<path d="' + spokes + '" stroke="' + p.ink + '" stroke-width="1.5"/>',
                dots,
                '<polygon points="' + poly(60, 60, 14, 6, -90) + '" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<circle cx="60" cy="60" r="4.2" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 10. 涡卷 —— 螺线＝持续牵引 */
        vortex_drag: function (p) {
            var chev = '';
            for (var i = 0; i < 3; i++) {
                var deg = -90 + i * 120;
                var q = ptOn(60, 60, 46, deg);
                chev += arrowHead(q[0] - Math.cos(deg * Math.PI / 180) * 9, q[1] - Math.sin(deg * Math.PI / 180) * 9, deg + 180, 11, p.accent, 2.8);
            }
            return g([
                '<circle cx="60" cy="60" r="42" stroke="' + p.muted + '" stroke-width="1.1" stroke-dasharray="2 8"/>',
                '<path d="' + spiral(60, 60, 2.35, 5, 34, 140) + '" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="60" cy="60" r="5.5" fill="' + p.accent + '"/>',
                chev
            ].join(''));
        },

        /* 11. 灰烬游魂 —— 灼烧属性，死亡留下火池 */
        ember_wisp: function (p) {
            var body = 'M60 20 C 76 42 82 52 82 64 A 22 22 0 0 1 38 64 C 38 50 50 44 60 20 Z';
            return g([
                '<path d="' + body + '" fill="' + p.accent + '"/>',
                '<path d="' + body + '" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<path d="M60 52 C 67 62 69 66 69 70 A 9 9 0 0 1 51 70 C 51 64 55 60 60 52 Z" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<circle cx="40" cy="30" r="2.8" fill="' + p.muted + '"/>',
                '<circle cx="82" cy="34" r="2.2" fill="' + p.muted + '"/>',
                '<circle cx="60" cy="10" r="2.2" fill="' + p.muted + '"/>',
                '<path d="M32 92 H88" stroke="' + p.accent + '" stroke-width="2" stroke-dasharray="4 5" opacity="0.8"/>'
            ].join(''));
        },

        /* 12. 霜核 —— 冰冻属性，六轴晶体 */
        frost_core: function (p) {
            var spokes = [], forks = [];
            for (var i = 0; i < 6; i++) {
                var deg = -90 + i * 60, a = deg * Math.PI / 180;
                var e = ptOn(60, 60, 32, deg);
                spokes.push('M60 60 L' + n(e[0]) + ' ' + n(e[1]));
                var f = ptOn(60, 60, 21, deg);
                forks.push('M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(a + 0.65) * 10) + ' ' + n(f[1] + Math.sin(a + 0.65) * 10));
                forks.push('M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(a - 0.65) * 10) + ' ' + n(f[1] + Math.sin(a - 0.65) * 10));
            }
            return g([
                '<polygon points="' + poly(60, 60, 38, 6, -90) + '" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="4 6"/>',
                '<path d="' + spokes.join(' ') + '" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<path d="' + forks.join(' ') + '" stroke="' + p.ink + '" stroke-width="1.4"/>',
                '<polygon points="' + poly(60, 60, 12, 6, -90) + '" fill="' + p.accent + '"/>'
            ].join(''));
        },

        /* 13. 编者之眼 —— BOSS，横扫全场的审阅目光 */
        editor_eye: function (p) {
            return g([
                '<path d="M14 62 C 38 32 82 32 106 62 C 82 92 38 92 14 62 Z" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M26 78 C 44 88 76 88 94 78" stroke="' + p.muted + '" stroke-width="1.3"/>',
                '<circle cx="60" cy="62" r="15" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="60" cy="62" r="6.5" fill="' + p.accent + '"/>',
                '<path d="M43 40 L60 18 L77 40" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M24 46 L12 28 M96 46 L108 28" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M38 96 H82" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M52 100 L68 100 L60 114 Z" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 14. 断句者 —— BOSS，双柱＋刻度盘，分阶段切换 */
        caesura_warden: function (p) {
            var ticks = '';
            for (var i = 0; i < 8; i++) {
                var deg = -90 + i * 45;
                var a = ptOn(60, 60, 42, deg), b = ptOn(60, 60, i % 2 ? 50 : 54, deg);
                ticks += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) +
                    '" stroke="' + p.ink + '" stroke-width="' + (i % 2 ? 1.8 : 2.8) + '"/>';
            }
            return g([
                '<circle cx="60" cy="60" r="45" stroke="' + p.muted + '" stroke-width="1.4" stroke-dasharray="2 6"/>',
                ticks,
                '<path d="M60 15 A 45 45 0 0 1 91.8 28.2" stroke="' + p.accent + '" stroke-width="3.4"/>',
                '<path d="M20 40 A 40 40 0 0 0 20 80" stroke="' + p.accent + '" stroke-width="3.6"/>',
                '<path d="M100 40 A 40 40 0 0 1 100 80" stroke="' + p.accent + '" stroke-width="3.6"/>',
                '<path d="M48 32 V88 M72 32 V88" stroke="' + p.ink + '" stroke-width="8.5"/>',
                '<circle cx="60" cy="60" r="6" fill="' + p.accent + '"/>',
                '<circle cx="60" cy="60" r="11.5" stroke="' + p.ink + '" stroke-width="1.4"/>'
            ].join(''));
        }
    };

    /* ================================================================ 弹道 viewBox 0 0 160 90 */
    var projectiles = {

        /* 基础点列弹：Glyphica 最标志性的"一串越来越大的点" */
        dot_trail: function (p) {
            var s = '', last = [0, 0];
            for (var i = 0; i < 15; i++) {
                var t = i / 14;
                var x = 10 + t * 118;
                var y = 70 - Math.pow(t, 1.25) * 34;
                var r = 1.1 + t * 2.9;
                s += '<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' + n(r) + '" fill="' + p.ink + '" opacity="' + n(0.18 + t * 0.82) + '"/>';
                last = [x, y];
            }
            return '<g>' + s +
                '<circle cx="' + n(last[0] + 12) + '" cy="' + n(last[1] - 3) + '" r="6" fill="' + p.accent + '"/>' +
                '<circle cx="' + n(last[0] + 12) + '" cy="' + n(last[1] - 3) + '" r="10.5" fill="none" stroke="' + p.accent + '" stroke-width="1.2" opacity="0.55"/>' +
                '</g>';
        },

        /* 弧刺：狙击/穿透，一条长弧＋箭头 */
        arc_lance: function (p) {
            return g([
                '<path d="M8 80 Q 72 6 152 30" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M8 80 Q 60 22 96 22" stroke="' + p.accent + '" stroke-width="3.4" opacity="0.9"/>',
                arrowHead(152, 30, 17, 13, p.ink, 2.4),
                '<path d="M46 50 l7 4 M74 32 l7 4 M104 26 l7 4" stroke="' + p.muted + '" stroke-width="1.4"/>',
                '<circle cx="8" cy="80" r="3.2" fill="' + p.muted + '"/>'
            ].join(''));
        },

        /* 链电：折线分叉＋节点 */
        chain_fork: function (p) {
            return g([
                '<path d="M6 46 L32 26 L48 56 L74 30" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M74 30 L102 62 L124 40" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<path d="M74 30 L98 14 L122 24" stroke="' + p.accent + '" stroke-width="2.4" stroke-dasharray="5 4"/>',
                '<circle cx="74" cy="30" r="5" fill="' + p.accent + '"/>',
                '<circle cx="124" cy="40" r="4" fill="' + p.ink + '"/>',
                '<circle cx="122" cy="24" r="3.2" fill="' + p.muted + '"/>',
                '<path d="M136 34 l8 -4 M138 48 l9 3" stroke="' + p.muted + '" stroke-width="1.4"/>'
            ].join(''));
        },

        /* 回旋弧：去而复返 */
        boomerang_arc: function (p) {
            return g([
                '<path d="M118 16 A 44 44 0 1 0 118 74" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<path d="M124 26 A 34 34 0 1 0 124 64" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="4 6"/>',
                arrowHead(118, 74, 60, 12, p.accent, 2.8),
                '<circle cx="118" cy="16" r="4.5" fill="' + p.accent + '"/>',
                '<path d="M140 20 h10 M144 45 h10 M140 70 h10" stroke="' + p.muted + '" stroke-width="1.4"/>'
            ].join(''));
        },

        /* 榴弹抛物线＋落点环 */
        mortar_arc: function (p) {
            return g([
                '<path d="M8 78 Q 74 -10 142 58" stroke="' + p.ink + '" stroke-width="1.8" stroke-dasharray="5 6"/>',
                '<ellipse cx="142" cy="70" rx="17" ry="6" stroke="' + p.accent + '" stroke-width="2.2"/>',
                '<ellipse cx="142" cy="70" rx="8" ry="3" stroke="' + p.accent + '" stroke-width="1.4"/>',
                '<circle cx="118" cy="40" r="5.5" fill="' + p.ink + '"/>',
                '<path d="M126 22 l6 -7 M134 32 l9 -3 M112 20 l2 -9" stroke="' + p.muted + '" stroke-width="1.5"/>',
                '<circle cx="8" cy="78" r="3.2" fill="' + p.muted + '"/>'
            ].join(''));
        },

        /* 溅墨命中特效 */
        ink_splatter: function (p) {
            var spikes = '', dots = '';
            for (var i = 0; i < 11; i++) {
                var deg = i * (360 / 11) + 8;
                var len = 20 + (i % 3) * 11;
                var a = deg * Math.PI / 180;
                var tip = [80 + Math.cos(a) * len, 45 + Math.sin(a) * len];
                var b1 = [80 + Math.cos(a + 0.16) * 7, 45 + Math.sin(a + 0.16) * 7];
                var b2 = [80 + Math.cos(a - 0.16) * 7, 45 + Math.sin(a - 0.16) * 7];
                spikes += '<path d="M' + n(b1[0]) + ' ' + n(b1[1]) + ' L' + n(tip[0]) + ' ' + n(tip[1]) + ' L' + n(b2[0]) + ' ' + n(b2[1]) + ' Z" fill="' + p.ink + '"/>';
                var dd = [80 + Math.cos(a) * (len + 9), 45 + Math.sin(a) * (len + 9)];
                dots += '<circle cx="' + n(dd[0]) + '" cy="' + n(dd[1]) + '" r="' + n(1 + (i % 3) * 0.7) + '" fill="' + p.muted + '"/>';
            }
            return '<g>' + spikes + dots + '<circle cx="80" cy="45" r="9" fill="' + p.accent + '"/></g>';
        },

        /* 霜棱：冰冻弹 */
        frost_shard: function (p) {
            return g([
                '<path d="M18 58 l14 -8 M40 52 l14 -8 M62 46 l14 -8" stroke="' + p.muted + '" stroke-width="2"/>',
                '<path d="M22 44 l12 -6 M46 38 l12 -6" stroke="' + p.muted + '" stroke-width="1.4" stroke-dasharray="3 3"/>',
                '<polygon points="' + poly(112, 40, 18, 6, -90) + '" fill="' + p.accent + '"/>',
                '<polygon points="' + poly(112, 40, 18, 6, -90) + '" stroke="' + p.ink + '" stroke-width="2"/>',
                '<path d="M112 22 V58 M96 31 L128 49 M96 49 L128 31" stroke="' + p.ink + '" stroke-width="1.4"/>',
                '<path d="M136 26 l8 -5 M138 56 l9 4" stroke="' + p.muted + '" stroke-width="1.4"/>'
            ].join(''));
        },

        /* 贯穿光束 */
        beam_lance: function (p) {
            return g([
                '<path d="M10 45 H150" stroke="' + p.accent + '" stroke-width="9" opacity="0.32"/>',
                '<path d="M18 45 H146" stroke="' + p.accent + '" stroke-width="4"/>',
                '<path d="M24 45 H142" stroke="' + p.ink + '" stroke-width="1.5"/>',
                '<path d="M42 30 V60 M70 26 V64 M98 30 V60" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 5"/>',
                '<circle cx="150" cy="45" r="6" fill="' + p.ink + '"/>',
                '<path d="M10 32 V58" stroke="' + p.ink + '" stroke-width="2.4"/>'
            ].join(''));
        }
    };

    /* ================================================================ 技能图标 viewBox 0 0 96 96 */
    function badge(p, inner) {
        return '<g>' +
            '<circle cx="48" cy="48" r="46" fill="' + p.accent + '"/>' +
            '<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke="' + p.onAccent + '">' + inner + '</g>' +
            '</g>';
    }

    var icons = {
        rapid_fire: function (p) {
            return badge(p, [
                '<path d="M22 30 L44 48 L22 66" stroke-width="6"/>',
                '<path d="M44 30 L66 48 L44 66" stroke-width="6"/>',
                '<path d="M66 34 L76 48 L66 62" stroke-width="4" opacity="0.7"/>'
            ].join(''));
        },
        ricochet: function (p) {
            return badge(p, [
                '<path d="M20 24 L46 52" stroke-width="5"/>',
                '<path d="M46 52 L72 24" stroke-width="5"/>',
                arrowHead(72, 24, -47, 12, p.onAccent, 5),
                '<path d="M16 68 H80" stroke-width="4" stroke-dasharray="6 6"/>',
                '<circle cx="46" cy="52" r="4.5" fill="' + p.onAccent + '"/>'
            ].join(''));
        },
        detonate: function (p) {
            var s = '';
            for (var i = 0; i < 8; i++) {
                var a = i * 45 * Math.PI / 180;
                s += '<path d="M' + n(48 + Math.cos(a) * 18) + ' ' + n(48 + Math.sin(a) * 18) +
                    ' L' + n(48 + Math.cos(a) * 34) + ' ' + n(48 + Math.sin(a) * 34) + '" stroke-width="' + (i % 2 ? 3 : 5) + '"/>';
            }
            return badge(p, s + '<circle cx="48" cy="48" r="11" fill="' + p.onAccent + '"/>');
        },
        freeze: function (p) {
            var s = '';
            for (var i = 0; i < 6; i++) {
                var deg = -90 + i * 60, a = deg * Math.PI / 180;
                s += '<path d="M48 48 L' + n(48 + Math.cos(a) * 32) + ' ' + n(48 + Math.sin(a) * 32) + '" stroke-width="4.5"/>';
                var f = [48 + Math.cos(a) * 20, 48 + Math.sin(a) * 20];
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(a + 0.7) * 10) + ' ' + n(f[1] + Math.sin(a + 0.7) * 10) + '" stroke-width="3.2"/>';
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(a - 0.7) * 10) + ' ' + n(f[1] + Math.sin(a - 0.7) * 10) + '" stroke-width="3.2"/>';
            }
            return badge(p, s);
        },
        burn: function (p) {
            return badge(p, [
                '<path d="M48 14 C 62 34 68 42 68 52 A 20 20 0 0 1 28 52 C 28 40 40 34 48 14 Z" fill="' + p.onAccent + '" stroke="none"/>',
                '<path d="M48 46 C 54 54 56 58 56 62 A 8 8 0 0 1 40 62 C 40 56 44 52 48 46 Z" fill="' + p.accent + '" stroke="none"/>',
                '<path d="M26 78 H70" stroke-width="4" stroke-dasharray="7 6"/>'
            ].join(''));
        },
        chain_shock: function (p) {
            return badge(p, [
                '<path d="M54 12 L30 50 H46 L40 84 L68 44 H50 Z" fill="' + p.onAccent + '" stroke="none"/>',
                '<circle cx="22" cy="26" r="5" fill="' + p.onAccent + '"/>',
                '<circle cx="76" cy="70" r="5" fill="' + p.onAccent + '"/>'
            ].join(''));
        },
        aegis: function (p) {
            return badge(p, [
                '<path d="M48 16 L76 28 V50 C76 68 60 78 48 82 C36 78 20 68 20 50 V28 Z" stroke-width="5"/>',
                '<path d="M36 48 L45 58 L62 38" stroke-width="5"/>'
            ].join(''));
        },
        slow_time: function (p) {
            return badge(p, [
                '<circle cx="48" cy="50" r="28" stroke-width="5"/>',
                '<path d="M48 32 V50 L62 58" stroke-width="5"/>',
                '<path d="M48 14 V22 M20 50 H28 M76 50 H68 M48 78 V86" stroke-width="4"/>',
                '<path d="M74 24 A 34 34 0 0 0 60 14" stroke-width="3" stroke-dasharray="4 4"/>'
            ].join(''));
        }
    };

    /* ================================================================ 形态词汇（风格说明用的小图元） */
    var vocab = {
        ring: function (p) { return '<circle cx="30" cy="30" r="17" fill="none" stroke="' + p.ink + '" stroke-width="2.4"/><circle cx="30" cy="30" r="7" fill="' + p.accent + '"/>'; },
        dot: function (p) { return '<circle cx="30" cy="30" r="9" fill="' + p.accent + '"/>'; },
        pentagon: function (p) { return '<polygon points="' + poly(30, 30, 18, 5, -90) + '" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="1.6"/>'; },
        diamond: function (p) { return '<path d="M30 12 L48 30 L30 48 L12 30 Z" fill="none" stroke="' + p.ink + '" stroke-width="2.6"/>'; },
        arc: function (p) { return '<path d="M42 12 A 22 22 0 0 0 42 48" fill="none" stroke="' + p.ink + '" stroke-width="3"/>'; },
        chevron: function (p) { return '<path d="M20 12 L42 30 L20 48 L26 30 Z" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="1.6"/>'; },
        orbit: function (p) { return '<circle cx="30" cy="30" r="19" fill="none" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="2 6"/><circle cx="30" cy="30" r="7" fill="none" stroke="' + p.ink + '" stroke-width="2"/><circle cx="49" cy="30" r="4" fill="' + p.ink + '"/>'; },
        bar: function (p) { return '<path d="M12 34 H48" stroke="' + p.ink + '" stroke-width="3"/><path d="M18 24 H42" stroke="' + p.muted + '" stroke-width="2"/>'; }
    };

    global.GlyphArt = {
        PALETTES: PALETTES,
        VIEWBOX: { monsters: '0 0 120 120', projectiles: '0 0 160 90', icons: '0 0 96 96', vocab: '0 0 60 60' },
        RATIO: { monsters: 1, projectiles: 90 / 160, icons: 1, vocab: 1 },
        monsters: monsters,
        projectiles: projectiles,
        icons: icons,
        vocab: vocab,
        util: { poly: poly, spiral: spiral, ptOn: ptOn, arrowHead: arrowHead }
    };
})(window);
