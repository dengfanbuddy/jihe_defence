/**
 * 怪物数据 · C 组 —— 最终 Boss（共 20 只）
 * window.MONSTER_DATA_C
 * 本作设 100 级难度：每 5 级换一个最终 Boss（难度1-5=Boss1 … 难度96-100=Boss20）。
 * 难度 100 之后循环这 20 只，仅按难度倍率提高属性（见 generateFinalBoss 说明）。
 * 最终 Boss 都有 1~2 个主动技能。元素尽量覆盖全部 7 系。
 */
(function (global) {
    'use strict';
    var BASE = {
        hp: 12000, atk: 160, def: 30, ms: 1.0, range: 4, crit: 15, dodge: 10, regen: 10,
        gold: 400, exp: 1200
    };

    /* 每只最终 Boss 的差异化偏置（0 表示用基准值） */
    var DEFS = [
        { code: 'final_doom',   name: '末日使者',   en: 'Doom Bringer',    element: '火', shape: 'brute',
          elemStrong: true, role: '高攻火系灭世者，烧尽一切。',
          skills: [{ name: '末日烈焰', cd: 8, behavior: 'aoe', desc: '全场落下多段火雨（灼烧），命中点易燃。' },
                   { name: '末日诅咒', cd: 0, behavior: 'passive', desc: '血量低于 50% 后攻击附加灼烧，无视部分魔抗。' }],
          bias: { atk: 1.4, ms: 0.9, range: 4 } },
        { code: 'final_void',   name: '虚空领主',   en: 'Void Lord',       element: '暗', shape: 'wraith',
          elemStrong: true, role: '高暴暗影刺客，专斩残血。',
          skills: [{ name: '虚空撕裂', cd: 8, behavior: 'unit_target', desc: '锁定当前血量最低单位造成暗影斩杀，低于 30% 血翻倍。' },
                   { name: '幽冥闪现', cd: 12, behavior: 'dash', desc: '闪现到目标身后并撕裂。' }],
          bias: { atk: 1.2, crit: 1.5, dodge: 1.5, ms: 1.25, range: 3 } },
        { code: 'final_frost',  name: '霜寒王座',   en: 'Frost Throne',    element: '冰', shape: 'colossus',
          elemStrong: true, role: '场控冰封巨像，冻结全队。',
          skills: [{ name: '冰封新星', cd: 9, behavior: 'aoe', desc: '全场大范围冰封，命中叠加冰冻。' },
                   { name: '绝对零度', cd: 0, behavior: 'passive', desc: '周围持续冰霜，靠得越近减速越重。' }],
          bias: { hp: 1.3, def: 1.3, ms: 0.8, range: 4 } },
        { code: 'final_storm',  name: '风暴王',     en: 'Storm King',       element: '雷', shape: 'caster',
          elemStrong: true, role: '连锁闪电收割者，弹跳压制。',
          skills: [{ name: '连锁风暴', cd: 7, behavior: 'chain', desc: '强力连锁闪电多次弹跳，递减攻击目标。' },
                   { name: '静电共震', cd: 0, behavior: 'passive', desc: '每次弹跳给目标叠加静电磁场。' }],
          bias: { atk: 1.3, ms: 1.1, crit: 1.3, range: 6 } },
        { code: 'final_venom',  name: '剧毒之核',   en: 'Venom Core',      element: '毒', shape: 'hydra',
          elemStrong: true, role: '毒雾永动机，铺满全场。',
          skills: [{ name: '剧毒弥漫', cd: 8, behavior: 'aoe', desc: '全场无数毒雾蔓延，持续中毒。' },
                   { name: '毒发爆裂', cd: 0, behavior: 'passive', desc: '中毒目标死亡时爆裂溅射更高毒伤。' }],
          bias: { hp: 1.4, def: 1.2, ms: 0.9, range: 4 } },
        { code: 'final_phys',   name: '力量化身',   en: 'Avatar of Might', element: '物理', shape: 'colossus',
          elemStrong: true, role: '破甲纯肉巨像，反震换血。',
          skills: [{ name: '大地震荡', cd: 8, behavior: 'aoe', desc: '震击地面，物伤 + 短暂范围晕眩。' },
                   { name: '坚韧壁垒', cd: 0, behavior: 'passive', desc: '被普攻命中时反震少量真实伤害。' }],
          bias: { hp: 1.5, def: 1.5, atk: 1.1, range: 3 } },
        { code: 'final_bane',   name: '梦魇之主',   en: 'Bane Master',     element: '暗', shape: 'wraith',
          elemStrong: true, role: '睡控单体杀手。',
          skills: [{ name: '梦魇降临', cd: 9, behavior: 'unit_target', desc: '让最强目标陷入沉睡并持续流失生命。' },
                   { name: '折磨侵蚀', cd: 0, behavior: 'passive', desc: '对沉睡目标伤害提升。' }],
          bias: { atk: 1.2, crit: 1.3, ms: 1.1, range: 5 } },
        { code: 'final_magma',  name: '熔火之核',   en: 'Molten Core',     element: '火', shape: 'serpent',
          elemStrong: true, role: '喷射熔岩的龙形灭世者。',
          skills: [{ name: '熔岩喷发', cd: 8, behavior: 'aoe', desc: '喷吐多道熔岩射线，命中溅射灼烧。' },
                   { name: '地火奔流', cd: 0, behavior: 'passive', desc: '走过之处留下持续灼烧火池。' }],
          bias: { atk: 1.35, ms: 1.15, range: 5 } },
        { code: 'final_shadow', name: '噬影者',     en: 'Shadow Devourer', element: '暗', shape: 'wraith',
          elemStrong: true, role: '吸血红暗影刺客。',
          skills: [{ name: '噬影收割', cd: 8, behavior: 'aoe', desc: '对一片暗影标记，引爆后重伤并回复自身。' },
                   { name: '暗影步', cd: 0, behavior: 'passive', desc: '受致命伤时短暂隐身闪避。' }],
          bias: { atk: 1.25, dodge: 1.6, ms: 1.2, range: 4 } },
        { code: 'final_ancient', name: '远古守卫',   en: 'Ancient Warden', element: '物理', shape: 'sentinel',
          elemStrong: true, role: '高防坚盾堡垒，越打越硬。',
          skills: [{ name: '荆棘护甲', cd: 8, behavior: 'passive', desc: '周期获得反伤护盾。' },
                   { name: '磐石壁垒', cd: 0, behavior: 'passive', desc: '血量越低护甲越高。' }],
          bias: { hp: 1.55, def: 1.6, ms: 0.7, range: 3 } },
        { code: 'final_light',  name: '光明神使',   en: 'Light Herald',    element: '无', shape: 'caster',
          elemStrong: true, role: '净化光系爆发法师。',
          skills: [{ name: '圣光审判', cd: 8, behavior: 'aoe', desc: '向全体敌人方向降下圣光，高额魔法伤害。' },
                   { name: '净化之光', cd: 0, behavior: 'passive', desc: '被它命中的增益效果被短暂移除。' }],
          bias: { atk: 1.4, ms: 1.1, range: 6 } },
        { code: 'final_beast',  name: '蛮荒巨兽',   en: 'Wild Behemoth',   element: '物理', shape: 'beast',
          elemStrong: true, role: '冲撞原野兽王。',
          skills: [{ name: '狂野冲撞', cd: 8, behavior: 'charge', desc: '直线冲撞目标，沿途击退并晕眩。' },
                   { name: '嗜血狂暴', cd: 0, behavior: 'passive', desc: '每击杀一个敌人攻击力提升。' }],
          bias: { hp: 1.4, atk: 1.2, ms: 1.3, range: 2 } },
        { code: 'final_ice',    name: '极冰巨兽',   en: 'Glacial Beast',   element: '冰', shape: 'colossus',
          elemStrong: true, role: '冰封全场重装甲。',
          skills: [{ name: '冰封大地', cd: 8, behavior: 'aoe', desc: '全场降温，范围减速叠满即冻结。' },
                   { name: '冰霜之躯', cd: 0, behavior: 'passive', desc: '被攻击时降低攻击者攻速。' }],
          bias: { hp: 1.5, def: 1.4, ms: 0.75, range: 3 } },
        { code: 'final_thunder', name: '雷霆战神',   en: 'Thunder God',     element: '雷', shape: 'brute',
          elemStrong: true, role: '近战爆发雷神。',
          skills: [{ name: '雷霆重击', cd: 8, behavior: 'unit_target', desc: '对最近目标雷系重击并麻痹。' },
                   { name: '雷电护体', cd: 0, behavior: 'passive', desc: '受击时有几率放电弹开伤害。' }],
          bias: { atk: 1.4, hp: 1.3, ms: 1.1, range: 2 } },
        { code: 'final_hydra',  name: '九头蛇祖',   en: 'Grand Hydra',     element: '毒', shape: 'hydra',
          elemStrong: true, role: '多头剧毒墙，喷毒清场。',
          skills: [{ name: '毒液奔流', cd: 8, behavior: 'aoe', desc: '多方向喷吐持续毒液。' },
                   { name: '再生之躯', cd: 0, behavior: 'passive', desc: '未被攻击时快速回复生命。' }],
          bias: { hp: 1.6, def: 1.2, regen: 2, range: 4 } },
        { code: 'final_poison', name: '瘴气魔王',   en: 'Miasma King',     element: '毒', shape: 'brute',
          elemStrong: true, role: '持续毒雾重炮。',
          skills: [{ name: '瘴气笼罩', cd: 8, behavior: 'aoe', desc: '形成持续毒雾区域，无法驱散。' },
                   { name: '毒血沸腾', cd: 0, behavior: 'passive', desc: '被攻击时溅射周围中毒。' }],
          bias: { atk: 1.35, hp: 1.4, ms: 0.9, range: 3 } },
        { code: 'final_golem',  name: '天崩魔像',   en: 'Skyfall Golem',   element: '物理', shape: 'colossus',
          elemStrong: true, role: '落石暴雨巨像。',
          skills: [{ name: '天崩地裂', cd: 8, behavior: 'aoe', desc: '召唤巨石砸落，大范围物理伤害。' },
                   { name: '石肤硬化', cd: 0, behavior: 'passive', desc: '周期获得高额减伤。' }],
          bias: { hp: 1.55, def: 1.5, ms: 0.8, range: 4 } },
        { code: 'final_serpent', name: '深海巨蟒',   en: 'Abyss Serpent',   element: '雷', shape: 'serpent',
          elemStrong: true, role: '环绕电击海蛇。',
          skills: [{ name: '连环电涌', cd: 8, behavior: 'chain', desc: '全场高压电涌弹跳攻击。' },
                   { name: '深渊缠绕', cd: 0, behavior: 'passive', desc: '击中时短暂缠绕目标。' }],
          bias: { atk: 1.3, ms: 1.2, range: 5 } },
        { code: 'final_wraith', name: '群鬼之王',   en: 'Spectre King',    element: '暗', shape: 'wraith',
          elemStrong: true, role: '亡灵召唤王。',
          skills: [{ name: '亡者大军', cd: 8, behavior: 'summon', desc: '召唤一批可被快速清除的亡灵小怪。' },
                   { name: '灵魂虹吸', cd: 0, behavior: 'passive', desc: '对召唤物存活时获得减伤。' }],
          bias: { atk: 1.3, crit: 1.4, ms: 1.15, range: 4 } },
        { code: 'final_primal', name: '原始湮灭者', en: 'Primal Annihilator', element: '物理', shape: 'colossus',
          elemStrong: true, role: '全属性均衡的终极化身。',
          skills: [{ name: '湮灭冲击', cd: 8, behavior: 'aoe', desc: '全场强力冲击，高额混合伤害。' },
                   { name: '原始之力', cd: 0, behavior: 'passive', desc: '血量越低攻速与移速越高。' }],
          bias: { hp: 1.45, atk: 1.3, def: 1.3, ms: 1.1, range: 4 } }
    ];

    function build(d, i) {
        var bias = d.bias || {};
        var hp = Math.round(BASE.hp * (bias.hp || 1) * (1 + i * 0.12));
        var atk = Math.round(BASE.atk * (bias.atk || 1));
        var def = Math.round(BASE.def * (bias.def || 1));
        var ms = +(BASE.ms * (bias.ms || 1)).toFixed(2);
        var range = Math.round(BASE.range * (bias.range || 1));
        var crit = Math.round(BASE.crit * (bias.crit || 1));
        var dodge = Math.round(BASE.dodge * (bias.dodge || 1));
        var regen = Math.round(BASE.regen * (bias.regen || 1));
        var gold = Math.round(BASE.gold * (1 + i * 0.1));
        var exp = Math.round(BASE.exp * (1 + i * 0.1));
        return {
            id: 32 + i, code: d.code, name: d.name, en: d.en,
            cat: 'final_boss', stage: null,
            element: d.element, shape: d.shape,
            ai: { type: 'boss', params: { skillInterval: 8, skillId: d.code }, desc: '最终 Boss，按难度分档循环登场。' },
            atkInterval: 2.5, attacks: true,
            stats: { hp: hp, atk: atk, def: def, ms: ms, range: range, crit: crit, dodge: dodge, regen: regen },
            reward: { gold: gold, exp: exp },
            role: d.role,
            dota: '参考 dota2 强度最高的单体型 Boss 设定，作为高难终局验证。',
            skills: d.skills,
            design: '最终 Boss 用三重环 + 王冠尖 + 双技能珠表现：左珠=主动技能1，右珠=主动技能2。',
            tell: '三重环 + 王冠 = 终局 Boss；技能珠数量 = 主动技能数。',
            build: '终局战优先处理它的主动技能 cycle，控好爆发窗口。',
            tags: ['最终Boss', d.element, '难度' + (1 + i), '终局']
        };
    }

    global.MONSTER_DATA_C = DEFS.map(build);
    /* 难度档位说明：难度1-5 → DEFS[0] … 难度96-100 → DEFS[19]；之后每 5 级循环，仅按 difficultyMultiplier 提高属性。 */
})(window);
