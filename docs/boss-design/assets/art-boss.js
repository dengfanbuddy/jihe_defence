/**
 * MonsterSigil —— 怪物 / 首领徽记生成器（Glyph 风格，参数化）
 *
 * 不逐只手绘，而是由「体形原型 + 元素标记 + 档位附件 + AI 附件」合成，
 * 保证 51 只怪物各年级可辨识、且整体美术统一。导出图不含 <text>。
 *
 * 每个怪物输出 viewBox 0 0 120 120 的 SVG 内部标记。
 *   shape     → 本体轮廓（beast / brute / caster / swarm / serpent / sentinel / colossus / wraith / gargoyle / hydra）
 *   element   → 本体下方元素标记
 *   cat       → 档位附件（small 极简 / elite 双外环 / stage_boss 王冠+分段环+基座 / 特殊=禁攻锁+奖励 / final 三重环+王冠+技能珠）
 *   ai        → 外围行为附件（chase 朝向角 / wander 仇恨虚线圈 / orbit 轨道弧 / attack_stop 蓄力扇 / boss 分段环 / passive 禁攻锁）
 */
(function (global) {
    'use strict';

    var U = global.GlyphArt.util;
    var poly = U.poly, ptOn = U.ptOn, arrow = U.arrowHead, spiral = U.spiral;
    function n(v) { return (Math.round(v * 100) / 100).toString(); }
    function g(inner) { return '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>'; }

    /* ================================================================ 体形原型 */
    var BODY = {

        /* 四足野兽（狼 / 雪怪 / 犬类） */
        beast: function (p) {
            var legs = '';
            [[42, 84, 46, 100], [78, 84, 74, 100], [52, 88, 52, 104], [70, 88, 72, 104]].forEach(function (s) {
                legs += '<path d="M' + s[0] + ' ' + s[1] + ' L' + s[2] + ' ' + s[3] + '" stroke="' + p.ink + '" stroke-width="3"/>';
            });
            return g([
                legs,
                '<ellipse cx="60" cy="66" rx="30" ry="20" fill="' + p.accent + '"/>',
                '<ellipse cx="60" cy="66" rx="30" ry="20" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="88" cy="46" r="13" fill="' + p.accent + '"/>',
                '<circle cx="88" cy="46" r="13" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<path d="M88 33 L92 24 L97 32" fill="' + p.ink + '"/>',
                '<circle cx="92" cy="44" r="2.2" fill="' + p.ink + '"/>',
                '<path d="M30 60 C 20 52 16 50 14 44" stroke="' + p.ink + '" stroke-width="6"/>'
            ].join(''));
        },

        /* 重型蛮力（食人魔 / 巨魔 / 熔岩兽） */
        brute: function (p) {
            return g([
                '<path d="M30 38 A 34 34 0 0 1 90 38" stroke="' + p.ink + '" stroke-width="6"/>',
                '<rect x="34" y="38" width="52" height="44" rx="8" fill="' + p.accent + '"/>',
                '<rect x="34" y="38" width="52" height="44" rx="8" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M26 50 H14 M26 70 H14 M94 50 H106 M94 70 H106" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<circle cx="50" cy="58" r="3.4" fill="' + p.ink + '"/><circle cx="70" cy="58" r="3.4" fill="' + p.ink + '"/>',
                '<path d="M52 72 H68" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M44 24 L48 16 M60 22 L60 13 M76 24 L72 16" stroke="' + p.ink + '" stroke-width="2.6"/>'
            ].join(''));
        },

        /* 施法者（萨特 / 女巫 / 法师） */
        caster: function (p) {
            var ring = '', s = '';
            for (var i = 0; i < 8; i++) {
                var d = i * 45, a = ptOn(60, 60, 22, d), b = ptOn(60, 60, i % 2 ? 34 : 41, d);
                ring += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.muted + '" stroke-width="' + (i % 2 ? 1.5 : 2.2) + '"/>';
            }
            return g([
                '<circle cx="60" cy="60" r="46" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="2 7"/>',
                ring,
                '<circle cx="60" cy="60" r="20" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="60" cy="60" r="11" stroke="' + p.ink + '" stroke-width="1.5"/>',
                '<circle cx="60" cy="60" r="5" fill="' + p.accent + '"/>'
            ].join(''));
        },

        /* 集群（蜘蛛幼体 / 烬妖 / 冰霜小鬼） */
        swarm: function (p) {
            var dots = '', legs = '';
            [[42, 70], [78, 70], [60, 88]].forEach(function (c, i) {
                dots += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + (i ? 8 : 10) + '" fill="' + p.accent + '"/>';
                dots += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + (i ? 8 : 10) + '" stroke="' + p.ink + '" stroke-width="1.8"/>';
                var ang = i ? 0 : 0;
                for (var k = 0; k < 4; k++) {
                    var d = 45 + k * 90 + (i ? 90 : 0);
                    legs += '<path d="M' + c[0] + ' ' + c[1] + ' L' + n(c[0] + Math.cos(d * Math.PI / 180) * 15) + ' ' + n(c[1] + Math.sin(d * Math.PI / 180) * 15) + '" stroke="' + p.ink + '" stroke-width="1.7"/>';
                }
            });
            return g([
                '<circle cx="60" cy="60" r="42" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 7"/>',
                legs, dots
            ].join(''));
        },

        /* 巨龙 / 蛇形（熔火巨龙 / 寒冬飞龙） */
        serpent: function (p) {
            var wing = '<path d="M40 34 C 26 18 30 10 24 6 C 40 12 52 22 54 34 Z" fill="' + p.ink + '"/>' +
                '<path d="M62 34 C 76 16 72 8 80 4 C 62 10 50 22 48 34 Z" fill="' + p.ink + '"/>';
            return g([
                wing,
                '<path d="M26 58 C 26 82 94 82 94 58 C 94 44 76 36 60 44 C 44 36 26 44 26 58 Z" fill="' + p.accent + '"/>',
                '<path d="M26 58 C 26 82 94 82 94 58 C 94 44 76 36 60 44 C 44 36 26 44 26 58 Z" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M40 66 C 44 74 48 76 54 74" stroke="' + p.ink + '" stroke-width="2" stroke-dasharray="4 4"/>',
                '<path d="M66 76 L80 88 L92 84" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="94" cy="58" r="4.5" fill="' + p.ink + '"/>',
                '<path d="M46 42 C 40 30 44 24 42 18" stroke="' + p.ink + '" stroke-width="3.4"/>'
            ].join(''));
        },

        /* 哨卫 / 石魔（远古守护者） */
        sentinel: function (p) {
            return g([
                '<rect x="38" y="30" width="44" height="30" rx="3" fill="' + p.accent + '"/>',
                '<rect x="38" y="30" width="44" height="30" rx="3" stroke="' + p.ink + '" stroke-width="3"/>',
                '<rect x="46" y="58" width="28" height="34" rx="2" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M46 40 L42 22 H58 L60 30 M74 40 L78 22 H62" stroke="' + p.muted + '" stroke-width="1.8" stroke-dasharray="4 4"/>',
                '<circle cx="60" cy="74" r="7" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<circle cx="60" cy="74" r="3" fill="' + p.accent + '"/>',
                '<path d="M44 96 H76" stroke="' + p.muted + '" stroke-width="2" stroke-dasharray="4 5"/>'
            ].join(''));
        },

        /* 巨型石魔 / 巨像（岩浆巨人 / 冰川巨人 / 最终 boss 本体） */
        colossus: function (p) {
            var s = '';
            for (var i = 0; i < 6; i++) {
                var d = i * 60, a = ptOn(60, 52, 24, d), b = ptOn(60, 52, i % 2 ? 34 : 40, d);
                s += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="' + (i % 2 ? 1.6 : 2.6) + '"/>';
            }
            return g([
                '<rect x="30" y="32" width="60" height="52" rx="6" fill="' + p.accent + '"/>',
                '<rect x="30" y="32" width="60" height="52" rx="6" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<path d="M42 54 H78 M42 66 H78" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<circle cx="52" cy="45" r="3.4" fill="' + p.ink + '"/><circle cx="68" cy="45" r="3.4" fill="' + p.ink + '"/>',
                s,
                '<path d="M40 30 V18 M60 28 V14 M80 30 V18" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M36 104 H84" stroke="' + p.muted + '" stroke-width="2.4" stroke-dasharray="5 6"/>'
            ].join(''));
        },

        /* 亡灵 / 女妖 */
        wraith: function (p) {
            return g([
                '<path d="M60 14 C 74 14 82 26 82 40 L82 66 C 82 80 74 88 60 88 C 46 88 38 80 38 66 L38 40 C 38 26 46 14 60 14 Z" fill="' + p.accent + '"/>',
                '<path d="M60 14 C 74 14 82 26 82 40 L82 66 C 82 80 74 88 60 88 C 46 88 38 80 38 66 L38 40 C 38 26 46 14 60 14 Z" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M40 76 C 44 84 48 88 50 92 M60 82 C 60 90 60 94 60 98 M80 76 C 76 84 72 88 70 92" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="52" cy="46" r="8" fill="' + p.ink + '"/>',
                '<circle cx="68" cy="46" r="8" fill="' + p.ink + '"/>',
                '<circle cx="52" cy="46" r="2.6" fill="' + p.accent + '"/>',
                '<circle cx="68" cy="46" r="2.6" fill="' + p.accent + '"/>'
            ].join(''));
        },

        /* 石像鬼（有翼） */
        gargoyle: function (p) {
            return g([
                '<path d="M42 38 C 22 26 24 12 18 6 C 30 16 40 28 44 36 Z" fill="' + p.ink + '"/>',
                '<path d="M78 38 C 98 26 96 12 102 6 C 90 16 80 28 76 36 Z" fill="' + p.ink + '"/>',
                '<rect x="44" y="40" width="32" height="40" rx="4" fill="' + p.accent + '"/>',
                '<rect x="44" y="40" width="32" height="40" rx="4" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M60 28 L60 40" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="52" cy="54" r="2.6" fill="' + p.ink + '"/><circle cx="68" cy="54" r="2.6" fill="' + p.ink + '"/>',
                '<path d="M52 74 L60 68 L68 74" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<path d="M50 96 H70" stroke="' + p.muted + '" stroke-width="1.8" stroke-dasharray="4 5"/>'
            ].join(''));
        },

        /* 多头蛇 */
        hydra: function (p) {
            var heads = '';
            [[44, 40], [60, 32], [76, 40]].forEach(function (c, i) {
                heads += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="12" fill="' + p.accent + '"/>';
                heads += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="12" stroke="' + p.ink + '" stroke-width="2.4"/>';
                heads += '<circle cx="' + (c[0] - 3) + '" cy="' + (c[1] - 2) + '" r="2" fill="' + p.ink + '"/>';
            });
            return g([
                heads,
                '<path d="M40 56 C 44 80 76 80 80 56" stroke="' + p.ink + '" stroke-width="3.2" fill="none"/>',
                '<path d="M36 88 C 44 96 76 96 84 88" stroke="' + p.ink + '" stroke-width="3.2" fill="none"/>',
                '<path d="M34 60 C 20 70 16 78 14 90 M86 60 C 100 70 104 78 106 90" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<circle cx="60" cy="66" r="5" fill="' + p.accent + '"/>'
            ].join(''));
        }
    };

    /* ================================================================ 元素标记（本体下方） */
    var ELEM = {
        '物理': '<path d="M38 90 H52 M68 90 H82" stroke="__C__" stroke-width="2.4"/>',
        '火': '<path d="M34 96 L38 90 M46 94 L50 86 M58 94 L60 84" stroke="__C__" stroke-width="2.2"/>',
        '冰': '<path d="M34 92 L40 84 M50 92 L50 82 M66 92 L60 84" stroke="__C__" stroke-width="2.2"/>',
        '毒': '<circle cx="38" cy="90" r="2.8" fill="__C__"/><circle cx="52" cy="94" r="2.2" fill="__C__"/><circle cx="66" cy="90" r="2.8" fill="__C__"/>',
        '雷': '<path d="M36 88 L46 96 L60 88 L74 96" stroke="__C__" stroke-width="2.2"/>',
        '暗': '<path d="M38 92 L52 86 L68 92" stroke="__C__" stroke-width="2.2" stroke-dasharray="4 4"/>',
        '无': ''
    };

    /* ================================================================ AI 附件 */
    function aiAttach(t, p) {
        var ty = (t || 'chase').type;
        if (ty === 'wander') {
            return '<circle cx="60" cy="60" r="52" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 7"/>';
        }
        if (ty === 'orbit') {
            return '<circle cx="60" cy="60" r="50" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="2 7"/>' +
                '<path d="M60 10 A 50 50 0 0 1 95 34" stroke="' + p.accent + '" stroke-width="2.2"/>';
        }
        if (ty === 'attack_stop') {
            return '<path d="M40 22 A 44 44 0 0 1 80 22" stroke="' + p.accent + '" stroke-width="2.4" stroke-dasharray="5 4"/>';
        }
        if (ty === 'passive') {
            return '<path d="M20 30 H100" stroke="' + p.ink + '" stroke-width="5"/>' +
                '<path d="M20 30 L34 24 L34 36 Z" fill="' + p.ink + '"/>' +
                '<path d="M100 30 L86 24 L86 36 Z" fill="' + p.ink + '"/>';
        }
        return '';
    }

    /* ================================================================ 档位附件 */
    function catAttach(c, p) {
        var out = '';
        if (c === 'elite') {
            out += '<circle cx="60" cy="60" r="52" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 7"/>' +
                '<circle cx="60" cy="60" r="57" stroke="' + p.accent + '" stroke-width="1.1" opacity="0.5"/>';
        }
        if (c === 'stage_boss') {
            out += segmentedRing(p, 54, 4) +
                '<path d="M44 20 A 44 44 0 1 0 76 20" stroke="' + p.accent + '" stroke-width="3.4"/>' +
                '<path d="M46 24 L46 8 M60 22 L60 2 M74 24 L74 8" stroke="' + p.ink + '" stroke-width="2.8"/>' +
                '<rect x="44" y="100" width="32" height="7" rx="2" fill="' + p.ink + '"/>';
        }
        if (c === 'gold_boss' || c === 'kill_boss' || c === 'defense_boss') {
            // 禁攻 + 奖励/任务标记
            out += '<circle cx="60" cy="60" r="55" stroke="' + p.accent + '" stroke-width="1.6" stroke-dasharray="5 6"/>';
            var ic = c === 'gold_boss' ? coinIcon(p) : c === 'kill_boss' ? targetIcon(p) : shieldIcon(p);
            out += ic;
        }
        if (c === 'final_boss') {
            out += segmentedRing(p, 55, 6) +
                '<path d="M46 22 L46 6 M60 20 L60 0 M74 22 L74 6" stroke="' + p.ink + '" stroke-width="3"/>' +
                '<rect x="42" y="100" width="36" height="8" rx="2" fill="' + p.ink + '"/>' +
                '<circle cx="60" cy="60" r="40" stroke="' + p.muted + '" stroke-width="1" stroke-dasharray="2 6"/>' +
                skillOrb(p, 24, 30, p.accent) + skillOrb(p, 96, 30, p.accent);
        }
        return out;
    }

    function segmentedRing(p, r, count) {
        var out = '', s = '';
        for (var i = 0; i < count; i++) {
            var a0 = -90 + i * (360 / count) + 8, a1 = -90 + (i + 1) * (360 / count) - 8;
            var st = ptOn(60, 60, r, a0), en = ptOn(60, 60, r, a1);
            s += '<path d="M' + n(st[0]) + ' ' + n(st[1]) + ' A ' + r + ' ' + r + ' 0 0 1 ' + n(en[0]) + ' ' + n(en[1]) +
                '" stroke="' + (i === 0 ? p.accent : p.ink) + '" stroke-width="' + (i === 0 ? 3.2 : 2.2) + '"/>';
        }
        return s;
    }

    function skillOrb(p, x, y, col) {
        return '<circle cx="' + x + '" cy="' + y + '" r="7" fill="' + col + '"/>' +
            '<circle cx="' + x + '" cy="' + y + '" r="11" stroke="' + col + '" stroke-width="1.3" opacity="0.6"/>';
    }

    function coinIcon(p) {
        return '<circle cx="60" cy="60" r="18" stroke="' + p.accent + '" stroke-width="3"/>' +
            '<path d="M60 47 L60 73 M52 54 H68 M52 66 H68" stroke="' + p.accent + '" stroke-width="2.4"/>';
    }
    function targetIcon(p) {
        return '<circle cx="60" cy="60" r="22" stroke="' + p.accent + '" stroke-width="3"/>' +
            '<circle cx="60" cy="60" r="11" stroke="' + p.accent + '" stroke-width="2.4"/>' +
            '<circle cx="60" cy="60" r="3" fill="' + p.accent + '"/>';
    }
    function shieldIcon(p) {
        return '<path d="M60 40 L78 47 V60 C78 72 68 78 60 82 C52 78 42 72 42 60 V47 Z" fill="none" stroke="' + p.accent + '" stroke-width="3"/>' +
            '<path d="M52 60 L58 66 L70 54" stroke="' + p.accent + '" stroke-width="2.4"/>';
    }

    /* ================================================================ 组装 */
    function sigil(m, p) {
        var body = BODY[m.shape] || BODY.beast;
        var elem = (ELEM[m.element] || '').replace(/__C__/g, p.accent);
        return g([
            body(p),
            elem,
            catAttach(m.cat, p),
            aiAttach(m.ai, p)
        ].join(''));
    }

    function svg(m, p, opts) {
        opts = opts || {};
        var w = opts.size || 120, hh = opts.size ? Math.round(opts.size) : 120;
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="' + w + '" height="' + hh + '">' + sigil(m, p) + '</svg>';
    }

    global.MonsterSigil = { sigil: sigil, svg: svg, BODY: BODY };
})(window);
