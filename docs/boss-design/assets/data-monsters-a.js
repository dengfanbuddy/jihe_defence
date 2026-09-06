/**
 * 怪物数据 · A 组 —— 阶段 1 & 阶段 2（共 14 只）
 * window.MONSTER_DATA_A
 * 结构：id / code / name / en / cat / stage / element / shape / ai / atkInterval / attacks / stats / reward / role / dota / skills / design / tell / build / tags
 * 数值按「阶段难度倍率」缩放：阶段1 = 1.0，阶段2 = 1.6。
 * shape 取值：beast/brute/caster/swarm/serpent/sentinel/colossus/wraith/gargoyle/hydra（对应 art-boss.js 的体形原型）
 */
(function (global) {
    'use strict';
    global.MONSTER_DATA_A = [

        /* ================================================================ 阶段 1「初入战场」 · 自然/物理 · 倍率 1.0 */
        {
            id: 1, code: 'mon_kobold', name: '狗头人斥候', en: 'Kobold Scout',
            cat: 'small', stage: 1, element: '物理', shape: 'beast',
            ai: { type: 'chase', params: { speedMul: 1.15 }, desc: '直线冲向最近目标，攻频低，靠数量堆输出。' },
            atkInterval: 3.0, attacks: true,
            stats: { hp: 60, atk: 9, def: 1, ms: 1.15, range: 1.5, crit: 3, dodge: 6, regen: 0 },
            reward: { gold: 2, exp: 10 },
            role: '最基础的近战炮灰，成堆出现。',
            dota: '参考 dota2 野区狗头人（Kobold）群体的低伤高数量节奏。',
            skills: [],
            design: '小型四足 + 细身朝向角，体形用 beast 的轻量剪影；攻频低所以尾巴线拉长，暗示慢速蓄力。',
            tell: '体型最小、朝向角最细 —— 一箭就能清掉，但要防它贴脸叠伤害。',
            build: '群体清场优先级最高，别让它穿越防线。',
            tags: ['近战', '炮灰', '物理']
        },
        {
            id: 2, code: 'mon_treant', name: '移动树苗', en: 'Sapling Treant',
            cat: 'small', stage: 1, element: '物理', shape: 'brute',
            ai: { type: 'chase', params: { speedMul: 0.9 }, desc: '缓慢逼近，皮厚血多。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 90, atk: 12, def: 2, ms: 0.9, range: 2, crit: 2, dodge: 3, regen: 0.5 },
            reward: { gold: 3, exp: 14 },
            role: '略硬的前排杂兵，扛伤拖时间。',
            dota: '参考 dota2 树人（Treant）的高血低速定位。',
            skills: [],
            design: '方形厚躯干 + 双肩粗线，用 brute 的"厚重块"突出血量；底部短横线是再生条。',
            tell: '方形色块 = 有护甲、血量高，优先用穿透/魔法清理。',
            build: '前期集火点之一，但伤害不高。',
            tags: ['近战', '前排', '坦克']
        },
        {
            id: 3, code: 'mon_harpling', name: '枭兽幼雏', en: 'Harpy Fledgling',
            cat: 'small', stage: 1, element: '物理', shape: 'gargoyle',
            ai: { type: 'wander', params: { wanderRadius: 150, aggroRange: 320, wanderSpeedMul: 0.5, chaseSpeedMul: 1.5 }, desc: '空中游荡，玩家靠近才锁定，扑过来切后排。' },
            atkInterval: 2.8, attacks: true,
            stats: { hp: 55, atk: 8, def: 0, ms: 1.5, range: 5, crit: 5, dodge: 12, regen: 0 },
            reward: { gold: 3, exp: 12 },
            role: '远程/机动杂兵，会绕后威胁脆皮。',
            dota: '参考 dota2 枭兽（Harpy）的空中游荡与仇恨判定。',
            skills: [],
            design: '有翼石像鬼剪影，外圈大虚线 = wander 仇恨圈；空心 = 未锁定。',
            tell: '环绕的虚线圈实心化 = 已进入仇恨，注意它的扑脸方向。',
            build: '用射程英雄提前打发，别让它绕后。',
            tags: ['远程', '机动', '空中']
        },
        {
            id: 4, code: 'elite_ogre', name: '食人魔蛮兵', en: 'Ogre Brute',
            cat: 'elite', stage: 1, element: '物理', shape: 'brute',
            ai: { type: 'attack_stop', params: { stopDuration: 2.5, windupTime: 0.5 }, desc: '大力挥击前摇 0.5s，打完硬直 2.5s，是输出窗口。' },
            atkInterval: 3.2, attacks: true,
            stats: { hp: 420, atk: 30, def: 8, ms: 1.0, range: 2, crit: 8, dodge: 6, regen: 2 },
            reward: { gold: 12, exp: 55 },
            role: '近战精英，单发高 + 明显蓄力。',
            dota: '参考 dota2 食人魔（Ogre）的"重击"与攻后硬直。',
            skills: [],
            design: '方形砧块 + 顶部蓄力刻度扇，双外环 = 精英档位；刻度亮满即落锤。',
            tell: '顶部扇形满了别贴脸；它停住 = 白给输出。',
            build: '抓它 2.5s 硬直窗口集火。',
            tags: ['近战', '精英', '物理']
        },
        {
            id: 5, code: 'elite_satyr', name: '萨特猎手', en: 'Satyr Hunter',
            cat: 'elite', stage: 1, element: '物理', shape: 'caster',
            ai: { type: 'orbit', params: { orbitRadius: 200, angularSpeed: 1.5, attackInterval: 3.4 }, desc: '绕英雄环绕射击，射程远但攻频低。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 380, atk: 34, def: 6, ms: 0.95, range: 6, crit: 10, dodge: 12, regen: 1 },
            reward: { gold: 14, exp: 60 },
            role: '远程环绕精英，压迫走位。',
            dota: '参考 dota2 萨特（Satyr）的环绕施法与远程压制。',
            skills: [],
            design: '同心双环施法者剪影 + 外切向弧形轨道线，本体画在轨道顶端。',
            tell: '看到轨道弧就要预判它的下一个位置点。',
            build: '用爆发英雄快速点掉，别让它风筝。',
            tags: ['远程', '精英', '环绕']
        },
        {
            id: 6, code: 'elite_bear', name: '怒熊', en: 'Enraged Bear',
            cat: 'elite', stage: 1, element: '物理', shape: 'beast',
            ai: { type: 'chase', params: { speedMul: 1.05 }, desc: '贴脸就追，皮厚爪狠。' },
            atkInterval: 3.0, attacks: true,
            stats: { hp: 480, atk: 38, def: 9, ms: 1.05, range: 2, crit: 12, dodge: 8, regen: 3 },
            reward: { gold: 16, exp: 70 },
            role: '高血高攻的近战精英，需优先处理。',
            dota: '参考 dota2 野区怒熊（Ursa/野熊）的近战爆发。',
            skills: [],
            design: '四足厚兽剪影，肩部双横杠 = 有护甲，强调色头部是爆发点。',
            tell: '比一般四足大一号、色块更满 = 别单扛。',
            build: '风筝它，或控住集火。',
            tags: ['近战', '精英', '爆发']
        },
        {
            id: 7, code: 'boss_goblin_king', name: '哥布林大王', en: 'Goblin King',
            cat: 'stage_boss', stage: 1, element: '物理', shape: 'brute',
            ai: { type: 'boss', params: { skillInterval: 6, skillId: 'stone_throw', phases: [{ hpRatio: 1.0, behavior: 'chase', params: { speedMul: 0.9 } }, { hpRatio: 0.6, behavior: 'attack_stop', params: { stopDuration: 1.0, speedMul: 1.4 } }] }, desc: '阶段一稳步逼近，血量过半进入加速硬直循环。' },
            atkInterval: 2.9, attacks: true,
            stats: { hp: 2700, atk: 62, def: 16, ms: 0.9, range: 3, crit: 14, dodge: 10, regen: 4 },
            reward: { gold: 60, exp: 260 },
            role: '阶段1守关 Boss，带掷石小技能。',
            dota: '参考 dota2 肉山/前期团长的"掷石 + 冲脸"组合技节奏。',
            skills: [
                { name: '掷石', cd: 6, behavior: 'unit_target', desc: '投掷巨石对最近目标造成高额物理伤害，施法前有扇面预警。' },
                { name: '狂暴加速', cd: 0, behavior: 'passive', desc: '血量低于 60% 后移速提升、攻击进入短硬直循环。' }
            ],
            design: '四段破碎外环（4 阶段阈值）+ 王冠尖 + 基座；首段强调色 = 当前阶段。',
            tell: '外环剩几段 = 还剩几个阶段；剩一段时进入加速狂暴。',
            build: '优先躲开掷石扇面，血量过半后抓它硬直集火。',
            tags: ['boss', '阶段1', '物理', '掷石']
        },

        /* ================================================================ 阶段 2「熔岩之境」 · 火 · 倍率 1.6 */
        {
            id: 8, code: 'mon_ember_imp', name: '烬魔', en: 'Ember Imp',
            cat: 'small', stage: 2, element: '火', shape: 'swarm',
            ai: { type: 'chase', params: { speedMul: 1.25 }, desc: '小体型快速逼近，触碰附带灼烧。' },
            atkInterval: 2.7, attacks: true,
            stats: { hp: 95, atk: 14, def: 1, ms: 1.25, range: 2, crit: 4, dodge: 8, regen: 0 },
            reward: { gold: 4, exp: 18 },
            role: '火系快攻杂兵，成群出现叠灼烧。',
            dota: '对应 element_effects 灼烧（burn）的火系小怪。',
            skills: [],
            design: '集群点状本体（swarm），本体下方三道火苗 = 灼烧标记。',
            tell: '越小越多的火点 = 会叠灼烧，别硬站。',
            build: '远程提前清，别让灼烧叠满 10 层。',
            tags: ['近战', '火', '灼烧']
        },
        {
            id: 9, code: 'mon_lava_lizard', name: '熔岩蜥', en: 'Lava Lizard',
            cat: 'small', stage: 2, element: '火', shape: 'serpent',
            ai: { type: 'chase', params: { speedMul: 1.1 }, desc: '蛇形低伏逼近，攻频略高但单发弱。' },
            atkInterval: 3.1, attacks: true,
            stats: { hp: 130, atk: 18, def: 3, ms: 1.1, range: 2.5, crit: 4, dodge: 7, regen: 0.5 },
            reward: { gold: 5, exp: 22 },
            role: '中血近战杂兵，沾火就燃。',
            dota: '参考 dota2 熔岩/炎属性蛇形小怪。',
            skills: [],
            design: '蛇形剪影（serpent）压低重心，火光在背部；底部火苗 = 灼烧。',
            tell: '蛇身越亮 = 灼烧层越高。',
            build: '控制它的蛇形突进节奏。',
            tags: ['近战', '火', '蛇形']
        },
        {
            id: 10, code: 'mon_flame_wisp', name: '火灵', en: 'Flame Wisp',
            cat: 'small', stage: 2, element: '火', shape: 'caster',
            ai: { type: 'wander', params: { wanderRadius: 160, aggroRange: 340, wanderSpeedMul: 0.5, chaseSpeedMul: 1.4 }, desc: '漂浮游荡，锁定后远程点射。' },
            atkInterval: 2.6, attacks: true,
            stats: { hp: 85, atk: 16, def: 1, ms: 1.4, range: 6, crit: 6, dodge: 14, regen: 0 },
            reward: { gold: 5, exp: 20 },
            role: '远程火系杂兵，射程长攻频低。',
            dota: '参考 dota2 火元素（Elemental）的远程定位。',
            skills: [],
            design: '施法者同心环 + 外围火苗，虚线环 = wander 仇恨圈。',
            tell: '大虚线圈一实心就打你，注意它的远程点射。',
            build: '先手解决远程点射源。',
            tags: ['远程', '火', '游荡']
        },
        {
            id: 11, code: 'elite_fire_guard', name: '火焰守卫', en: 'Flame Guard',
            cat: 'elite', stage: 2, element: '火', shape: 'sentinel',
            ai: { type: 'attack_stop', params: { stopDuration: 2.5, windupTime: 0.5 }, desc: '举盾蓄力 0.5s，落锤有范围灼烧。' },
            atkInterval: 3.2, attacks: true,
            stats: { hp: 640, atk: 46, def: 13, ms: 0.95, range: 2.5, crit: 10, dodge: 8, regen: 3 },
            reward: { gold: 20, exp: 90 },
            role: '火系前排精英，扛住群体灼烧。',
            dota: '参考 dota2 树人/树精卫士的火盾定位。',
            skills: [],
            design: '哨卫方块剪影（sentinel）+ 蓄力扇形，双外环 = 精英。',
            tell: '蓄力扇亮 = 落锤带范围灼烧，别贴阵。',
            build: '远程拉开输出，躲开落锤范围。',
            tags: ['近战', '精英', '火']
        },
        {
            id: 12, code: 'elite_magma_brute', name: '熔岩蛮兽', en: 'Magma Brute',
            cat: 'elite', stage: 2, element: '火', shape: 'brute',
            ai: { type: 'chase', params: { speedMul: 1.05 }, desc: '厚重逼近，皮厚爪重，死亡留火池。' },
            atkInterval: 3.0, attacks: true,
            stats: { hp: 720, atk: 52, def: 14, ms: 1.05, range: 2, crit: 12, dodge: 6, regen: 4 },
            reward: { gold: 22, exp: 100 },
            role: '高血高攻火系精英，死后留灼烧区。',
            dota: '参考 dota2 熔岩魔像（Lava Golem）的死后残留。',
            skills: [],
            design: '厚重方形剪影 + 强调色核心 = 死亡瞬间火池；火苗标记在底部。',
            tell: '红色大块 = 打完不要立刻贴尸体。',
            build: '算好击杀位置，别在火池里开战后排。',
            tags: ['近战', '精英', '火']
        },
        {
            id: 13, code: 'elite_blaze_mage', name: '烈焰术士', en: 'Blaze Mage',
            cat: 'elite', stage: 2, element: '火', shape: 'caster',
            ai: { type: 'orbit', params: { orbitRadius: 220, angularSpeed: 1.4, attackInterval: 3.4 }, desc: '绕场施法，技能是范围火球。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 560, atk: 55, def: 9, ms: 0.9, range: 7, crit: 15, dodge: 12, regen: 2 },
            reward: { gold: 24, exp: 110 },
            role: '远程环绕火系精英，AOE 威胁大。',
            dota: '参考 dota2 火系施法者（如莉娜式火焰）的范围压制。',
            skills: [
                { name: '火球溅射', cd: 8, behavior: 'aoe', desc: '对目标区域投掷火球，范围灼烧。' }
            ],
            design: '施法者环 + 轨道弧 + 顶部火球蓄能点，本体在轨道顶端。',
            tell: '顶部火球点亮 = 即将 AOE，注意分散。',
            build: '优先打断/击杀这个环绕施法源。',
            tags: ['远程', '精英', '火', 'AOE']
        },
        {
            id: 14, code: 'boss_magma_dragon', name: '熔火巨龙', en: 'Magma Dragon',
            cat: 'stage_boss', stage: 2, element: '火', shape: 'serpent',
            ai: { type: 'boss', params: { skillInterval: 6, skillId: 'fire_volley', phases: [{ hpRatio: 1.0, behavior: 'orbit', params: { orbitRadius: 220, angularSpeed: 1.0 } }, { hpRatio: 0.55, behavior: 'chase', params: { speedMul: 1.2 } }] }, desc: '阶段一环绕喷火，过半转地面冲撞。' },
            atkInterval: 3.0, attacks: true,
            stats: { hp: 4300, atk: 98, def: 24, ms: 0.85, range: 4, crit: 16, dodge: 10, regen: 6 },
            reward: { gold: 90, exp: 400 },
            role: '阶段2守关 Boss，火系 AOE 压制。',
            dota: '参考 dota2 巨龙/炎属性龙族的火系吐息组合。',
            skills: [
                { name: '火球散射', cd: 6, behavior: 'aoe', desc: '对全场三处落点投掷火球，命中留下灼烧圈。' },
                { name: '灼烧光环', cd: 0, behavior: 'passive', desc: '靠近它周围的敌人持续叠加灼烧。' },
                { name: '熔岩冲撞', cd: 0, behavior: 'charge', desc: '血量低于 55% 后周期性俯冲撞击。' }
            ],
            design: '蛇形龙体 + 双翼，四段外环对应阶段；首段强调色 = 环绕期。',
            tell: '外环首段熄灭 = 进入冲撞阶段，注意它俯冲直线。',
            build: '分散站位躲火球落点，冲撞期风筝它。',
            tags: ['boss', '阶段2', '火', 'AOE']
        }
    ];
})(window);
