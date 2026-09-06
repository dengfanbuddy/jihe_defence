/**
 * GlyphArtOurs —— 集合防御 · 本作专属形象库
 *
 * 与 GlyphArt 共用调色板与工具函数，但所有造型都绑定本项目的真实配置：
 *   units.json          → 单位造型、碰撞半径、AI 类型
 *   abilities.json      → 弹道与技能表现
 *   element_effects.json→ 状态标记
 *
 * 阵营色规则（本作新增的硬约定）：
 *   我方（team 1）= 墨色主导 + 强调色核心
 *   敌方（team 2）= 强调色主导 + 墨色轮廓
 * 这样在满屏单位时，玩家靠"谁是实心色块"就能秒分敌我。
 */
(function (global) {
    'use strict';

    var U = global.GlyphArt.util;
    var poly = U.poly, ptOn = U.ptOn, arrow = U.arrowHead, spiral = U.spiral;

    function n(v) { return (Math.round(v * 100) / 100).toString(); }
    function g(inner) { return '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>'; }

    /** 生成一串沿直线的点列尾迹（对应 Projectile.ts 的匀速直线推进） */
    function trail(x0, y0, x1, y1, count, p, rMin, rMax) {
        var s = '';
        for (var i = 0; i < count; i++) {
            var t = i / (count - 1);
            s += '<circle cx="' + n(x0 + (x1 - x0) * t) + '" cy="' + n(y0 + (y1 - y0) * t) +
                '" r="' + n(rMin + (rMax - rMin) * t) + '" fill="' + p.ink +
                '" opacity="' + n(0.15 + t * 0.6) + '"/>';
        }
        return s;
    }

    /* ================================================================ 单位 viewBox 0 0 120 120 */
    var units = {

        /* —— 我方 team 1 —— */

        /* 骑士：近战 / 战吼 / 圣光术 */
        hero_knight: function (p) {
            return g([
                '<path d="M26 36 A 36 36 0 0 0 26 84" stroke="' + p.ink + '" stroke-width="4.6"/>',
                '<path d="M94 36 A 36 36 0 0 1 94 84" stroke="' + p.ink + '" stroke-width="4.6"/>',
                '<path d="M60 30 L84 60 L60 90 L36 60 Z" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<circle cx="60" cy="60" r="8" fill="' + p.accent + '"/>',
                '<path d="M34 102 H86" stroke="' + p.muted + '" stroke-width="2.2" stroke-dasharray="6 5"/>',
                '<path d="M44 110 H76" stroke="' + p.muted + '" stroke-width="1.6" stroke-dasharray="4 5"/>',
                '<path d="M60 14 V24" stroke="' + p.ink + '" stroke-width="2.4"/>'
            ].join(''));
        },

        /* 法师：冰霜弹普攻 / 火球术 / 霜冻新星 */
        hero_mage: function (p) {
            var spokes = '';
            for (var i = 0; i < 6; i++) {
                var deg = -90 + i * 60;
                var a = ptOn(60, 60, 22, deg), b = ptOn(60, 60, 34, deg);
                spokes += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.muted + '" stroke-width="1.6"/>';
            }
            return g([
                '<polygon points="' + poly(60, 60, 44, 6, -90) + '" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="4 6"/>',
                spokes,
                '<circle cx="60" cy="60" r="21" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="60" cy="60" r="12" stroke="' + p.ink + '" stroke-width="1.6"/>',
                '<circle cx="60" cy="60" r="5" fill="' + p.accent + '"/>',
                '<circle cx="60" cy="20" r="6.5" fill="' + p.accent + '"/>',
                '<circle cx="60" cy="20" r="11" stroke="' + p.accent + '" stroke-width="1.2"/>'
            ].join(''));
        },

        /* 赏金猎人：飞镖三阶 / 偷钱被动 / 赏金标记 */
        hero_bounty: function (p) {
            var blades = '';
            for (var i = 0; i < 3; i++) {
                var deg = -90 + i * 120;
                var tip = ptOn(60, 60, 30, deg);
                var l = ptOn(60, 60, 11, deg + 30), r = ptOn(60, 60, 11, deg - 30);
                blades += '<path d="M' + n(l[0]) + ' ' + n(l[1]) + ' L' + n(tip[0]) + ' ' + n(tip[1]) +
                    ' L' + n(r[0]) + ' ' + n(r[1]) + ' Z" fill="' + p.ink + '"/>';
            }
            return g([
                '<circle cx="60" cy="60" r="40" stroke="' + p.accent + '" stroke-width="1.6" stroke-dasharray="6 7"/>',
                blades,
                '<circle cx="60" cy="60" r="7" stroke="' + p.ink + '" stroke-width="2"/>',
                '<circle cx="60" cy="60" r="3" fill="' + p.accent + '"/>',
                '<path d="M92 22 H108 M100 14 V30" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<circle cx="100" cy="22" r="9" stroke="' + p.accent + '" stroke-width="1.4"/>'
            ].join(''));
        },

        /* —— 敌方 team 2 —— */

        /* 哥布林：最小杂兵 · chase · r10 */
        mon_goblin: function (p) {
            return g([
                '<path d="M22 50 H36 M16 60 H34 M22 70 H36" stroke="' + p.muted + '" stroke-width="2"/>',
                '<circle cx="56" cy="60" r="16" fill="' + p.accent + '"/>',
                '<circle cx="56" cy="60" r="16" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<path d="M72 48 L96 60 L72 72 Z" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 巨魔：厚重五边 · chase 0.9x · r24 */
        mon_troll: function (p) {
            return g([
                '<polygon points="' + poly(56, 62, 32, 5, -90) + '" fill="' + p.accent + '"/>',
                '<polygon points="' + poly(56, 62, 32, 5, -90) + '" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M20 44 H36 M76 44 H92" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<path d="M92 62 H106" stroke="' + p.ink + '" stroke-width="2.6"/>',
                arrow(106, 62, 0, 9, p.ink, 2.6),
                '<circle cx="56" cy="62" r="6" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 游荡者：wander · 感知圈 350 · r18 */
        mon_wanderer: function (p) {
            return g([
                '<circle cx="60" cy="60" r="46" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 7"/>',
                '<path d="M24 88 L38 70 L30 54 L48 44 L44 28" stroke="' + p.ink + '" stroke-width="1.6" stroke-dasharray="5 5"/>',
                '<circle cx="60" cy="60" r="17" stroke="' + p.accent + '" stroke-width="3.4"/>',
                '<circle cx="60" cy="60" r="6" fill="' + p.accent + '"/>',
                '<path d="M84 42 L98 32" stroke="' + p.muted + '" stroke-width="1.6"/>',
                arrow(98, 32, -35, 8, p.muted, 1.6)
            ].join(''));
        },

        /* 环绕魔：orbit 半径 200 · 角速 1.8 · r18 */
        mon_orbiter: function (p) {
            return g([
                '<circle cx="60" cy="66" r="42" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="2 7"/>',
                '<path d="M40 22 L52 18 M78 32 L88 24" stroke="' + p.muted + '" stroke-width="1.4"/>',
                '<circle cx="60" cy="66" r="4" fill="' + p.muted + '"/>',
                '<path d="M50 66 H70 M60 56 V76" stroke="' + p.muted + '" stroke-width="1.2"/>',
                '<circle cx="60" cy="24" r="13" stroke="' + p.accent + '" stroke-width="3.4"/>',
                '<circle cx="60" cy="24" r="5" fill="' + p.accent + '"/>',
                '<path d="M76 26 H94" stroke="' + p.ink + '" stroke-width="2.2"/>',
                arrow(94, 26, 6, 9, p.ink, 2.2)
            ].join(''));
        },

        /* 重击者：attack_stop · 前摇 0.5s · 停顿 2.5s · 精英 · r26 */
        mon_slammer: function (p) {
            return g([
                '<path d="M24 40 A 38 38 0 0 1 96 40" stroke="' + p.ink + '" stroke-width="2" stroke-dasharray="5 5"/>',
                '<path d="M34 30 V22 M60 24 V14 M86 30 V22" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<rect x="34" y="44" width="52" height="42" rx="5" fill="' + p.accent + '"/>',
                '<rect x="34" y="44" width="52" height="42" rx="5" stroke="' + p.ink + '" stroke-width="3"/>',
                '<path d="M46 58 H74 M46 72 H74" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<ellipse cx="60" cy="98" rx="40" ry="9" stroke="' + p.muted + '" stroke-width="1.6" stroke-dasharray="5 6"/>',
                '<ellipse cx="60" cy="98" rx="22" ry="5" stroke="' + p.accent + '" stroke-width="1.6"/>'
            ].join(''));
        },

        /* 深渊领主：boss · 4 阶段 · 火球术 · r40 */
        mon_abyss_lord: function (p) {
            var arcs = '', spikes = '';
            for (var i = 0; i < 4; i++) {
                var a0 = -90 + i * 90 + 8, a1 = -90 + (i + 1) * 90 - 8;
                var s = ptOn(60, 58, 46, a0), e = ptOn(60, 58, 46, a1);
                arcs += '<path d="M' + n(s[0]) + ' ' + n(s[1]) + ' A 46 46 0 0 1 ' + n(e[0]) + ' ' + n(e[1]) +
                    '" stroke="' + (i === 0 ? p.accent : p.ink) + '" stroke-width="' + (i === 0 ? 3.6 : 2.4) + '"/>';
            }
            for (var k = 0; k < 8; k++) {
                var d = k * 45, a = ptOn(60, 58, 20, d), b = ptOn(60, 58, 29, d);
                spikes += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="' + (k % 2 ? 1.6 : 2.6) + '"/>';
            }
            return g([
                arcs, spikes,
                '<circle cx="60" cy="58" r="19" stroke="' + p.ink + '" stroke-width="3"/>',
                '<circle cx="60" cy="58" r="10" fill="' + p.accent + '"/>',
                '<path d="M40 104 H80" stroke="' + p.ink + '" stroke-width="3.2"/>',
                '<path d="M52 108 L68 108 L60 118 Z" fill="' + p.ink + '"/>'
            ].join(''));
        },

        /* 黄金魔像：gold_boss · 掉落 250 金 · r38 */
        mon_gold_golem: function (p) {
            return g([
                '<rect x="26" y="26" width="68" height="62" rx="7" fill="' + p.accent + '" opacity="0.18"/>',
                '<rect x="26" y="26" width="68" height="62" rx="7" stroke="' + p.ink + '" stroke-width="3.4"/>',
                '<rect x="38" y="38" width="44" height="38" rx="4" stroke="' + p.accent + '" stroke-width="2.6"/>',
                '<circle cx="60" cy="57" r="10" fill="' + p.accent + '"/>',
                '<circle cx="60" cy="57" r="4" fill="' + p.ink + '"/>',
                '<circle cx="34" cy="34" r="2.6" fill="' + p.ink + '"/><circle cx="86" cy="34" r="2.6" fill="' + p.ink + '"/>',
                '<circle cx="34" cy="80" r="2.6" fill="' + p.ink + '"/><circle cx="86" cy="80" r="2.6" fill="' + p.ink + '"/>',
                '<circle cx="42" cy="102" r="6" stroke="' + p.accent + '" stroke-width="2"/>',
                '<circle cx="60" cy="104" r="6" stroke="' + p.accent + '" stroke-width="2"/>',
                '<circle cx="78" cy="102" r="6" stroke="' + p.accent + '" stroke-width="2"/>'
            ].join(''));
        },

        /* 经验贤者：exp_boss · 800 经验 · 圣光术 · r36 */
        mon_exp_sage: function (p) {
            var rays = '';
            for (var i = 0; i < 12; i++) {
                var d = i * 30;
                var a = ptOn(60, 58, 30, d), b = ptOn(60, 58, i % 2 ? 40 : 46, d);
                rays += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) +
                    '" stroke="' + (i % 2 ? p.muted : p.accent) + '" stroke-width="' + (i % 2 ? 1.6 : 2.6) + '"/>';
            }
            return g([
                rays,
                '<circle cx="60" cy="58" r="27" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M60 40 L74 68 L46 68 Z" fill="' + p.accent + '"/>',
                '<path d="M60 40 L74 68 L46 68 Z" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<circle cx="60" cy="61" r="4" fill="' + p.ink + '"/>',
                '<path d="M42 104 H78" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<path d="M50 112 H70" stroke="' + p.muted + '" stroke-width="1.8"/>'
            ].join(''));
        }
    };

    /* ================================================================ 弹道 viewBox 0 0 160 90 */
    var shots = {

        /* 飞镖·一阶：物理 50 / 弹速 1200 / 直线匀速 + 终点快照 */
        shuriken_t1: function (p) {
            var blades = '';
            for (var i = 0; i < 3; i++) {
                var deg = -90 + i * 120;
                var tip = ptOn(122, 42, 17, deg), l = ptOn(122, 42, 6, deg + 34), r = ptOn(122, 42, 6, deg - 34);
                blades += '<path d="M' + n(l[0]) + ' ' + n(l[1]) + ' L' + n(tip[0]) + ' ' + n(tip[1]) + ' L' + n(r[0]) + ' ' + n(r[1]) + ' Z" fill="' + p.ink + '"/>';
            }
            return g([
                trail(14, 62, 108, 46, 11, p, 1.1, 3),
                blades,
                '<circle cx="122" cy="42" r="4" stroke="' + p.accent + '" stroke-width="1.8"/>',
                '<path d="M146 30 V54 M138 42 H154" stroke="' + p.accent + '" stroke-width="1.6" stroke-dasharray="3 3"/>',
                '<circle cx="14" cy="62" r="3" fill="' + p.muted + '"/>'
            ].join(''));
        },

        /* 审判飞镖·三阶：物理 100 + 点燃 + 偷金 20 */
        shuriken_t3: function (p) {
            var blades = '';
            for (var i = 0; i < 3; i++) {
                var deg = -90 + i * 120;
                var tip = ptOn(118, 42, 20, deg), l = ptOn(118, 42, 7, deg + 34), r = ptOn(118, 42, 7, deg - 34);
                blades += '<path d="M' + n(l[0]) + ' ' + n(l[1]) + ' L' + n(tip[0]) + ' ' + n(tip[1]) + ' L' + n(r[0]) + ' ' + n(r[1]) + ' Z" fill="' + p.accent + '"/>';
                blades += '<path d="M' + n(l[0]) + ' ' + n(l[1]) + ' L' + n(tip[0]) + ' ' + n(tip[1]) + ' L' + n(r[0]) + ' ' + n(r[1]) + ' Z" stroke="' + p.ink + '" stroke-width="1.4"/>';
            }
            return g([
                trail(10, 64, 100, 46, 12, p, 1.1, 3.2),
                '<circle cx="118" cy="42" r="27" stroke="' + p.accent + '" stroke-width="1.2" stroke-dasharray="4 5"/>',
                blades,
                '<circle cx="118" cy="42" r="5" stroke="' + p.ink + '" stroke-width="2"/>',
                '<circle cx="150" cy="18" r="7" stroke="' + p.accent + '" stroke-width="2"/>',
                '<path d="M150 12 V24" stroke="' + p.accent + '" stroke-width="1.6"/>'
            ].join(''));
        },

        /* 冰霜弹：法师普攻 frost_bolt */
        frost_bolt: function (p) {
            return g([
                '<path d="M16 62 l14 -6 M40 56 l14 -6 M64 50 l14 -6" stroke="' + p.muted + '" stroke-width="2"/>',
                '<path d="M20 48 l12 -5 M48 42 l12 -5" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 3"/>',
                '<polygon points="' + poly(114, 40, 19, 6, -90) + '" fill="' + p.accent + '"/>',
                '<polygon points="' + poly(114, 40, 19, 6, -90) + '" stroke="' + p.ink + '" stroke-width="2"/>',
                '<path d="M114 21 V59 M98 31 L130 49 M98 49 L130 31" stroke="' + p.ink + '" stroke-width="1.4"/>',
                '<path d="M140 24 l8 -5 M142 58 l9 4" stroke="' + p.muted + '" stroke-width="1.4"/>'
            ].join(''));
        },

        /* 火球术：技能弹道 60 伤害 + 灼烧 3s */
        fireball: function (p) {
            return g([
                '<path d="M12 66 C 34 60 40 46 36 34" stroke="' + p.muted + '" stroke-width="2" stroke-dasharray="4 5"/>',
                '<path d="M28 70 C 54 62 62 48 58 34" stroke="' + p.muted + '" stroke-width="2.4"/>',
                '<path d="M46 74 C 76 66 84 50 80 36" stroke="' + p.accent + '" stroke-width="2.6" opacity="0.7"/>',
                '<circle cx="112" cy="42" r="17" fill="' + p.accent + '"/>',
                '<circle cx="112" cy="42" r="17" stroke="' + p.ink + '" stroke-width="2.2"/>',
                '<circle cx="112" cy="42" r="8" stroke="' + p.ink + '" stroke-width="1.6"/>',
                '<path d="M136 24 l8 -8 M142 46 l10 0 M134 62 l7 8" stroke="' + p.accent + '" stroke-width="2"/>'
            ].join(''));
        },

        /* 毒镖：no_target 散射 5 目标 / 弹速 1000 */
        poison_dart: function (p) {
            var s = '';
            for (var i = 0; i < 5; i++) {
                var deg = -40 + i * 20;
                var e = ptOn(16, 45, 108, deg), m = ptOn(16, 45, 92, deg);
                s += '<path d="M' + n(ptOn(16, 45, 22, deg)[0]) + ' ' + n(ptOn(16, 45, 22, deg)[1]) +
                    ' L' + n(m[0]) + ' ' + n(m[1]) + '" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="4 4"/>';
                s += '<path d="M' + n(m[0]) + ' ' + n(m[1]) + ' L' + n(e[0]) + ' ' + n(e[1]) + '" stroke="' + p.ink + '" stroke-width="2.2"/>';
                s += '<circle cx="' + n(e[0]) + '" cy="' + n(e[1]) + '" r="4" fill="' + p.accent + '"/>';
            }
            return g([s, '<circle cx="16" cy="45" r="7" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<circle cx="16" cy="45" r="2.6" fill="' + p.accent + '"/>'].join(''));
        },

        /* 闪电链：脚本技能 / 弹跳 1 次 / 50% 递减 */
        lightning_chain: function (p) {
            return g([
                '<path d="M10 46 L34 26 L50 54 L74 28" stroke="' + p.ink + '" stroke-width="2.6"/>',
                '<circle cx="74" cy="28" r="7" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<path d="M80 34 L100 60 L120 34" stroke="' + p.accent + '" stroke-width="2.2" stroke-dasharray="5 4"/>',
                '<circle cx="120" cy="34" r="5.5" fill="' + p.accent + '" opacity="0.55"/>',
                '<circle cx="120" cy="34" r="9" stroke="' + p.accent + '" stroke-width="1.4"/>',
                '<path d="M136 22 h10 M138 46 h11 M132 62 h9" stroke="' + p.muted + '" stroke-width="1.4"/>',
                '<circle cx="10" cy="46" r="3" fill="' + p.muted + '"/>'
            ].join(''));
        },

        /* 霜冻新星：AOE 半径 250 */
        frost_nova: function (p) {
            var sp = '';
            for (var i = 0; i < 8; i++) {
                var d = i * 45;
                var a = ptOn(80, 45, 14, d), b = ptOn(80, 45, 27, d);
                sp += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="2"/>';
            }
            return g([
                '<ellipse cx="80" cy="45" rx="74" ry="40" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="4 6"/>',
                '<ellipse cx="80" cy="45" rx="54" ry="29" stroke="' + p.accent + '" stroke-width="2.2"/>',
                '<ellipse cx="80" cy="45" rx="34" ry="18" stroke="' + p.accent + '" stroke-width="1.4" opacity="0.6"/>',
                sp,
                '<polygon points="' + poly(80, 45, 11, 6, -90) + '" fill="' + p.accent + '"/>'
            ].join(''));
        },

        /* 圣光：经验贤者技能 sun_light */
        sun_light: function (p) {
            var rays = '';
            for (var i = 0; i < 7; i++) {
                var x = 46 + i * 12;
                rays += '<path d="M' + x + ' 8 V' + (26 + (i % 2) * 8) + '" stroke="' + p.muted + '" stroke-width="1.6" stroke-dasharray="3 4"/>';
            }
            return g([
                rays,
                '<path d="M44 10 L116 10 L100 62 L60 62 Z" fill="' + p.accent + '" opacity="0.16"/>',
                '<path d="M44 10 L60 62 M116 10 L100 62" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<ellipse cx="80" cy="66" rx="34" ry="10" stroke="' + p.accent + '" stroke-width="2.4"/>',
                '<ellipse cx="80" cy="66" rx="16" ry="5" stroke="' + p.ink + '" stroke-width="1.6"/>',
                '<path d="M22 40 h10 M128 40 h10" stroke="' + p.muted + '" stroke-width="1.6"/>'
            ].join(''));
        }
    };

    /* ================================================================ 状态标记 viewBox 0 0 72 72 */
    function pips(count, max, p) {
        var s = '';
        for (var i = 0; i < max; i++) {
            var x = 36 - (max - 1) * 4 + i * 8;
            s += '<circle cx="' + x + '" cy="64" r="2.6" fill="' + (i < count ? p.accent : p.muted) + '"/>';
        }
        return s;
    }

    var marks = {
        /* 灼烧：每秒 15% / 最多 10 层 */
        burn: function (p) {
            return g([
                '<path d="M36 10 C 48 26 52 32 52 40 A 16 16 0 0 1 20 40 C 20 30 30 24 36 10 Z" fill="' + p.accent + '"/>',
                '<path d="M36 10 C 48 26 52 32 52 40 A 16 16 0 0 1 20 40 C 20 30 30 24 36 10 Z" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<path d="M36 32 C 41 39 42 42 42 45 A 6 6 0 0 1 30 45 C 30 41 33 38 36 32 Z" stroke="' + p.ink + '" stroke-width="1.4"/>',
                pips(4, 5, p)
            ].join(''));
        },
        /* 冰冻：3 层触发硬控 1.5s */
        freeze: function (p) {
            var s = '';
            for (var i = 0; i < 6; i++) {
                var d = -90 + i * 60, a = ptOn(36, 34, 0, d), b = ptOn(36, 34, 22, d);
                s += '<path d="M36 34 L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="2.2"/>';
                var f = ptOn(36, 34, 14, d), ra = d * Math.PI / 180;
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(ra + .7) * 7) + ' ' + n(f[1] + Math.sin(ra + .7) * 7) + '" stroke="' + p.ink + '" stroke-width="1.4"/>';
                s += '<path d="M' + n(f[0]) + ' ' + n(f[1]) + ' L' + n(f[0] + Math.cos(ra - .7) * 7) + ' ' + n(f[1] + Math.sin(ra - .7) * 7) + '" stroke="' + p.ink + '" stroke-width="1.4"/>';
            }
            return g([s, '<circle cx="36" cy="34" r="7" fill="' + p.accent + '"/>', pips(3, 3, p)].join(''));
        },
        /* 毒液：每秒 10% / 最多 10 层 */
        poison: function (p) {
            return g([
                '<path d="M36 10 C 48 28 52 34 52 40 A 16 16 0 0 1 20 40 C 20 34 24 28 36 10 Z" fill="' + p.accent + '" opacity="0.85"/>',
                '<path d="M36 10 C 48 28 52 34 52 40 A 16 16 0 0 1 20 40 C 20 34 24 28 36 10 Z" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<circle cx="30" cy="40" r="3" fill="' + p.ink + '"/><circle cx="41" cy="35" r="2.2" fill="' + p.ink + '"/>',
                '<circle cx="40" cy="46" r="1.8" fill="' + p.ink + '"/>',
                pips(3, 5, p)
            ].join(''));
        },
        /* 连锁闪电：弹跳 1 次 / 50% */
        chain_lightning: function (p) {
            return g([
                '<path d="M40 8 L22 36 H34 L30 58 L50 30 H38 Z" fill="' + p.accent + '"/>',
                '<path d="M40 8 L22 36 H34 L30 58 L50 30 H38 Z" stroke="' + p.ink + '" stroke-width="1.5"/>',
                '<circle cx="14" cy="18" r="4" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<circle cx="58" cy="48" r="4" stroke="' + p.ink + '" stroke-width="1.8"/>',
                '<path d="M18 22 L26 30 M54 44 L46 36" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 3"/>'
            ].join(''));
        },
        /* 爆炸：半径 2.5 / 100% 溅射 */
        explosive: function (p) {
            var s = '';
            for (var i = 0; i < 10; i++) {
                var d = i * 36, a = ptOn(36, 34, 14, d), b = ptOn(36, 34, i % 2 ? 22 : 28, d);
                s += '<path d="M' + n(a[0]) + ' ' + n(a[1]) + ' L' + n(b[0]) + ' ' + n(b[1]) + '" stroke="' + p.ink + '" stroke-width="' + (i % 2 ? 1.5 : 2.4) + '"/>';
            }
            return g([
                '<circle cx="36" cy="34" r="30" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 5"/>',
                s, '<circle cx="36" cy="34" r="11" fill="' + p.accent + '"/>'
            ].join(''));
        },
        /* 暗影：低于 30% 血斩杀 ×1.3 */
        shadow: function (p) {
            return g([
                '<circle cx="36" cy="34" r="24" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M36 10 A 24 24 0 0 0 36 58 A 8 24 0 0 1 36 10 Z" fill="' + p.ink + '"/>',
                '<path d="M8 48 H64" stroke="' + p.accent + '" stroke-width="2.4" stroke-dasharray="5 4"/>',
                '<path d="M12 44 V52" stroke="' + p.accent + '" stroke-width="2.4"/>',
                pips(2, 5, p)
            ].join(''));
        },
        /* 静电磁场：5 层 / 4s */
        static_mark: function (p) {
            var s = '';
            for (var i = 0; i < 5; i++) {
                var q = ptOn(36, 34, 24, -90 + i * 72);
                s += '<circle cx="' + n(q[0]) + '" cy="' + n(q[1]) + '" r="3.4" fill="' + p.accent + '"/>';
            }
            return g([
                '<circle cx="36" cy="34" r="24" stroke="' + p.muted + '" stroke-width="1.4" stroke-dasharray="4 5"/>',
                '<circle cx="36" cy="34" r="13" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<path d="M38 22 L28 38 H36 L34 48 L46 32 H38 Z" fill="' + p.ink + '"/>',
                s, pips(5, 5, p)
            ].join(''));
        },
        /* 赏金标记：击杀掉落加成 */
        bounty_mark: function (p) {
            return g([
                '<circle cx="36" cy="34" r="21" stroke="' + p.accent + '" stroke-width="2.6"/>',
                '<path d="M36 6 V18 M36 50 V62 M8 34 H20 M52 34 H64" stroke="' + p.ink + '" stroke-width="2.4"/>',
                '<circle cx="36" cy="34" r="9" stroke="' + p.ink + '" stroke-width="1.6"/>',
                '<circle cx="36" cy="34" r="4" fill="' + p.accent + '"/>'
            ].join(''));
        },
        /* 腐蚀：减速 15% / 3 层 */
        corrosive: function (p) {
            return g([
                '<path d="M36 12 A 22 22 0 1 1 20 50" stroke="' + p.ink + '" stroke-width="2.8"/>',
                '<path d="M22 24 L30 32 M46 20 L40 28 M50 44 L42 40" stroke="' + p.accent + '" stroke-width="2"/>',
                '<circle cx="36" cy="34" r="8" fill="' + p.accent + '" opacity="0.85"/>',
                '<circle cx="36" cy="34" r="8" stroke="' + p.ink + '" stroke-width="1.4"/>',
                pips(2, 3, p)
            ].join(''));
        }
    };

    /* ================================================================ AI 行为图 viewBox 0 0 200 140 */
    function heroDot(p, x, y) {
        return '<circle cx="' + x + '" cy="' + y + '" r="11" fill="none" stroke="' + p.ink + '" stroke-width="2.2"/>' +
            '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + p.accent + '"/>';
    }
    function monDot(p, x, y, r) {
        return '<circle cx="' + x + '" cy="' + y + '" r="' + (r || 7) + '" fill="' + p.accent + '"/>' +
            '<circle cx="' + x + '" cy="' + y + '" r="' + (r || 7) + '" fill="none" stroke="' + p.ink + '" stroke-width="1.4"/>';
    }

    var ai = {
        chase: function (p) {
            return g([
                '<path d="M24 108 L150 44" stroke="' + p.ink + '" stroke-width="1.8" stroke-dasharray="6 5"/>',
                arrow(150, 44, -27, 11, p.ink, 2.2),
                monDot(p, 24, 108, 8), heroDot(p, 164, 36),
                '<text x="72" y="80" font-family="Consolas,monospace" font-size="11" fill="' + p.muted + '">speedMul</text>'
            ].join(''));
        },
        wander: function (p) {
            return g([
                '<circle cx="70" cy="72" r="54" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 6"/>',
                '<circle cx="70" cy="72" r="26" stroke="' + p.muted + '" stroke-width="1.1" stroke-dasharray="2 5"/>',
                '<path d="M70 72 L52 58 L64 44 L88 52 L78 70 L94 84" stroke="' + p.ink + '" stroke-width="1.6" stroke-dasharray="5 4"/>',
                '<path d="M94 84 L158 58" stroke="' + p.accent + '" stroke-width="2.2"/>',
                arrow(158, 58, -22, 10, p.accent, 2.2),
                monDot(p, 94, 84, 7), heroDot(p, 170, 52)
            ].join(''));
        },
        orbit: function (p) {
            return g([
                '<circle cx="100" cy="72" r="52" stroke="' + p.muted + '" stroke-width="1.3" stroke-dasharray="3 7"/>',
                '<path d="M100 20 A 52 52 0 0 1 148 56" stroke="' + p.accent + '" stroke-width="2.4"/>',
                arrow(148, 56, 55, 10, p.accent, 2.4),
                '<path d="M100 30 L100 62" stroke="' + p.muted + '" stroke-width="1.2" stroke-dasharray="3 4"/>',
                monDot(p, 100, 20, 8), heroDot(p, 100, 72),
                '<text x="112" y="112" font-family="Consolas,monospace" font-size="11" fill="' + p.muted + '">ω 1.8</text>'
            ].join(''));
        },
        attack_stop: function (p) {
            return g([
                '<path d="M18 96 L92 68" stroke="' + p.ink + '" stroke-width="1.8" stroke-dasharray="6 5"/>',
                '<path d="M104 40 V96" stroke="' + p.ink + '" stroke-width="2.2" stroke-dasharray="4 4"/>',
                '<path d="M78 46 A 34 34 0 0 1 132 46" stroke="' + p.accent + '" stroke-width="2.4" stroke-dasharray="5 4"/>',
                '<path d="M86 36 V28 M104 30 V20 M124 36 V28" stroke="' + p.accent + '" stroke-width="2"/>',
                monDot(p, 104, 72, 10),
                '<ellipse cx="104" cy="104" rx="34" ry="8" stroke="' + p.muted + '" stroke-width="1.5" stroke-dasharray="4 5"/>',
                heroDot(p, 170, 60),
                '<text x="18" y="122" font-family="Consolas,monospace" font-size="11" fill="' + p.muted + '">windup 0.5s → stop 2.5s</text>'
            ].join(''));
        },
        boss_phases: function (p) {
            var seg = '', labels = ['1.0', '0.7', '0.4', '0.2'];
            for (var i = 0; i < 4; i++) {
                var x = 16 + i * 44;
                seg += '<rect x="' + x + '" y="24" width="38" height="12" rx="2" fill="' + (i ? 'none' : p.accent) + '" stroke="' + p.ink + '" stroke-width="1.6"/>';
                seg += '<text x="' + (x + 19) + '" y="18" text-anchor="middle" font-family="Consolas,monospace" font-size="10" fill="' + p.muted + '">' + labels[i] + '</text>';
            }
            var icons = [
                '<path d="M26 76 L52 62" stroke="' + p.ink + '" stroke-width="2"/>' + arrow(52, 62, -28, 8, p.ink, 2),
                '<circle cx="94" cy="70" r="15" stroke="' + p.ink + '" stroke-width="1.6" stroke-dasharray="3 5"/><circle cx="94" cy="55" r="4" fill="' + p.accent + '"/>',
                '<path d="M114 78 L152 58" stroke="' + p.accent + '" stroke-width="2.6"/>' + arrow(152, 58, -28, 9, p.accent, 2.6),
                '<path d="M170 58 V84" stroke="' + p.ink + '" stroke-width="2.4" stroke-dasharray="4 4"/><path d="M160 54 A 16 16 0 0 1 182 54" stroke="' + p.accent + '" stroke-width="2"/>'
            ].join('');
            return g([
                seg, icons,
                '<text x="100" y="118" text-anchor="middle" font-family="Consolas,monospace" font-size="10" fill="' + p.muted + '">chase → orbit → chase 1.6x → attack_stop</text>'
            ].join(''));
        }
    };

    global.GlyphArtOurs = {
        VIEWBOX: { units: '0 0 120 120', shots: '0 0 160 90', marks: '0 0 72 72', ai: '0 0 200 140' },
        units: units,
        shots: shots,
        marks: marks,
        ai: ai
    };
})(window);
