/**
 * 怪物数据 · B 组 —— 阶段 3 & 阶段 4 + 全局特殊（共 17 只）
 * window.MONSTER_DATA_B
 * 数值按「阶段难度倍率」缩放：阶段3 = 2.4，阶段4 = 3.6。
 * 阶段3「万毒沼泽」· 毒/暗，阶段4「寒霜之巅」· 冰/雷。
 */
(function (global) {
    'use strict';
    global.MONSTER_DATA_B = [

        /* ================================================================ 阶段 3「万毒沼泽」 · 毒/暗 · 倍率 2.4 */
        {
            id: 15, code: 'mon_venom_fang', name: '毒牙鼠', en: 'Venom Fang Rat',
            cat: 'small', stage: 3, element: '毒', shape: 'beast',
            ai: { type: 'chase', params: { speedMul: 1.2 }, desc: '低伏疾冲，毒牙附着持续毒液。' },
            atkInterval: 2.8, attacks: true,
            stats: { hp: 150, atk: 22, def: 2, ms: 1.2, range: 1.5, crit: 5, dodge: 10, regen: 0.5 },
            reward: { gold: 5, exp: 30 },
            role: '毒系快攻杂兵，叠毒。',
            dota: '对应 element_effects 毒液（poison）的小怪载体。',
            skills: [],
            design: '四足细兽 + 毒液液滴标记，体型小但尾巴长 = 攻频慢蓄力。',
            tell: '底部液滴点 = 会叠毒，别被它贴身。',
            build: '远程清，控制毒液层数。',
            tags: ['近战', '毒', '持续']
        },
        {
            id: 16, code: 'mon_bog_hulk', name: '沼泽巨兽', en: 'Bog Hulk',
            cat: 'small', stage: 3, element: '暗', shape: 'brute',
            ai: { type: 'chase', params: { speedMul: 0.85 }, desc: '迟缓厚实前排，吸负面状态。' },
            atkInterval: 3.5, attacks: true,
            stats: { hp: 260, atk: 28, def: 5, ms: 0.85, range: 2, crit: 3, dodge: 4, regen: 2 },
            reward: { gold: 6, exp: 38 },
            role: '沼泽前排，耐打。',
            dota: '参考 dota2 沼泽系高血前排怪。',
            skills: [],
            design: '厚重方躯 + 暗色底部标记（虚线 = 暗影），体量大。',
            tell: '深色大块 = 血厚，但伤害不高。',
            build: '用穿透或持续灼烧磨，别浪费单体爆发。',
            tags: ['近战', '暗', '前排']
        },
        {
            id: 17, code: 'mon_pustule_spider', name: '脓疱蜘蛛', en: 'Pustule Spider',
            cat: 'small', stage: 3, element: '毒', shape: 'swarm',
            ai: { type: 'orbit', params: { orbitRadius: 180, angularSpeed: 1.7, attackInterval: 2.8 }, desc: '绕场吐毒网，靠伤害爆裂。' },
            atkInterval: 2.8, attacks: true,
            stats: { hp: 130, atk: 25, def: 2, ms: 1.3, range: 5, crit: 6, dodge: 12, regen: 0.5 },
            reward: { gold: 5, exp: 32 },
            role: '远程毒系小怪，绕后吐网。',
            dota: '参考 dota2 蜘蛛（Broodmother）的吐网与爆裂。',
            skills: [],
            design: '集群蛛形 + 轨道弧，毒液点在外围。',
            tell: '看到轨道弧 = 在绕你，别被吐网命中。',
            build: '优先清理远程毒源。',
            tags: ['远程', '毒', '环绕']
        },
        {
            id: 18, code: 'elite_plague_priest', name: '瘟疫祭司', en: 'Plague Priest',
            cat: 'elite', stage: 3, element: '毒', shape: 'caster',
            ai: { type: 'wander', params: { wanderRadius: 170, aggroRange: 360, wanderSpeedMul: 0.5, chaseSpeedMul: 1.1 }, desc: '游荡施法，毒雾扩散。' },
            atkInterval: 3.3, attacks: true,
            stats: { hp: 720, atk: 58, def: 12, ms: 0.95, range: 6.5, crit: 12, dodge: 12, regen: 4 },
            reward: { gold: 30, exp: 140 },
            role: '毒系远程精英，铺毒雾。',
            dota: '参考 dota2 瘟疫法师的毒雾扩散。',
            skills: [
                { name: '毒雾', cd: 9, behavior: 'aoe', desc: '在目标区域喷放毒雾，范围内持续中毒。' }
            ],
            design: '施法者环 + 大虚线游荡圈，毒液标记；双外环 = 精英。',
            tell: '虚线圈大 = 远程毒雾施法源，优先压制。',
            build: '先手击杀，别让毒雾铺满。',
            tags: ['远程', '精英', '毒', 'AOE']
        },
        {
            id: 19, code: 'elite_shadow_reaver', name: '暗影掠夺者', en: 'Shadow Reaver',
            cat: 'elite', stage: 3, element: '暗', shape: 'wraith',
            ai: { type: 'chase', params: { speedMul: 1.25 }, desc: '高速贴近斩杀低血目标。' },
            atkInterval: 2.7, attacks: true,
            stats: { hp: 620, atk: 66, def: 10, ms: 1.25, range: 2, crit: 20, dodge: 16, regen: 3 },
            reward: { gold: 32, exp: 150 },
            role: '高暴击近战精英，专挑残血。',
            dota: '参考 dota2 暗影系的高爆发刺杀定位。',
            skills: [],
            design: '亡灵兜帽（wraith）+ 底部虚线暗影标记 = 暴击/斩杀倾向。',
            tell: '兜帽最黑的精英 = 高暴击，注意你低血英雄直接点名。',
            build: '别让残血单位独自面对它。',
            tags: ['近战', '暗', '暴击']
        },
        {
            id: 20, code: 'elite_bile_titan', name: '苦胆巨像', en: 'Bile Titan',
            cat: 'elite', stage: 3, element: '毒', shape: 'colossus',
            ai: { type: 'attack_stop', params: { stopDuration: 2.5, windupTime: 0.6 }, desc: '巨像砸地蓄力，范围剧毒。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 1400, atk: 72, def: 20, ms: 0.8, range: 2.5, crit: 8, dodge: 6, regen: 6 },
            reward: { gold: 36, exp: 170 },
            role: '超硬毒系前排精英，AOE 毒爆。',
            dota: '参考 dota2 魔像/巨像的砸地范围毒。',
            skills: [{ name: '苦胆迸裂', cd: 8, behavior: 'aoe', desc: '砸地向四周迸裂毒液，范围内成群中毒。' }],
            design: '巨像方块剪影（colossus）+ 蓄力扇 + 双外环，毒液点在底部。',
            tell: '巨型方块 = 块头大血厚，蓄力扇亮 = 范围毒赶紧拉开。',
            build: '躲开砸地范围，用穿刺武器磨它的高护甲。',
            tags: ['近战', '精英', '毒', '巨像']
        },
        {
            id: 21, code: 'boss_thorn_queen', name: '荆棘女王', en: 'Thorn Queen',
            cat: 'stage_boss', stage: 3, element: '毒', shape: 'hydra',
            ai: { type: 'boss', params: { skillInterval: 6, skillId: 'venom_spread', phases: [{ hpRatio: 1.0, behavior: 'orbit', params: { orbitRadius: 240, angularSpeed: 1.1 } }, { hpRatio: 0.55, behavior: 'chase', params: { speedMul: 1.3 } }] }, desc: '阶段一环绕铺毒，过半转剧毒冲刺。' },
            atkInterval: 2.8, attacks: true,
            stats: { hp: 7800, atk: 135, def: 28, ms: 1.0, range: 4, crit: 20, dodge: 14, regen: 10 },
            reward: { gold: 170, exp: 760 },
            role: '阶段3守关 Boss，毒雾覆盖全场。',
            dota: '参考 dota2 剧毒/蛇形 Boss 的毒雾+冲刺压迫。',
            skills: [
                { name: '毒雾弥漫', cd: 6, behavior: 'aoe', desc: '全场多处喷毒雾，持续蔓延毒液。' },
                { name: '荆棘冲刺', cd: 0, behavior: 'charge', desc: '血量低于 55% 后周期性带毒突进。' },
                { name: '剧毒再生', cd: 0, behavior: 'passive', desc: '附近存在中毒敌人时持续回复生命。' }
            ],
            design: '多头蛇剪影（hydra）+ 四段外环，毒液标记遍布 = 全场毒雾。',
            tell: '外环过半断 = 进入冲刺，注意它带毒突进的方向。',
            build: '别让它靠近中毒单位回血，散开躲毒雾。',
            tags: ['boss', '阶段3', '毒', 'AOE']
        },

        /* ================================================================ 阶段 4「寒霜之巅」 · 冰/雷 · 倍率 3.6 */
        {
            id: 22, code: 'mon_frost_imp', name: '冰霜小鬼', en: 'Frost Imp',
            cat: 'small', stage: 4, element: '冰', shape: 'swarm',
            ai: { type: 'chase', params: { speedMul: 1.3 }, desc: '快速贴近，命中减速。' },
            atkInterval: 2.6, attacks: true,
            stats: { hp: 180, atk: 26, def: 2, ms: 1.3, range: 1.5, crit: 5, dodge: 12, regen: 0.5 },
            reward: { gold: 6, exp: 42 },
            role: '冰系快攻杂兵，减速拖节奏。',
            dota: '对应 element_effects 冰冻（freeze）的小怪载体。',
            skills: [],
            design: '集群冰点 + 六轴冰晶标记（底部） = 减速堆叠。',
            tell: '蓝色小点 = 会叠减速，别被围。',
            build: '远程清理，防减速叠满硬控。',
            tags: ['近战', '冰', '减速']
        },
        {
            id: 23, code: 'mon_thunder_wisp', name: '雷灵', en: 'Thunder Wisp',
            cat: 'small', stage: 4, element: '雷', shape: 'caster',
            ai: { type: 'orbit', params: { orbitRadius: 200, angularSpeed: 1.6, attackInterval: 2.7 }, desc: '绕场释放连锁闪电。' },
            atkInterval: 2.7, attacks: true,
            stats: { hp: 150, atk: 30, def: 2, ms: 1.35, range: 6, crit: 8, dodge: 14, regen: 0.5 },
            reward: { gold: 6, exp: 45 },
            role: '雷系远程小怪，弹跳伤害。',
            dota: '对应 element_effects 连锁闪电（chain_lightning）的小怪载体。',
            skills: [],
            design: '施法者环 + 折线闪电标记（底部） = 会弹跳。',
            tell: '看到折线 = 会弹到下一次，分散站位。',
            build: '最优先清理，弹跳最缠人。',
            tags: ['远程', '雷', '弹跳']
        },
        {
            id: 24, code: 'mon_glacier_guard', name: '冰川卫兵', en: 'Glacier Guard',
            cat: 'small', stage: 4, element: '冰', shape: 'sentinel',
            ai: { type: 'attack_stop', params: { stopDuration: 2.2, windupTime: 0.5 }, desc: '蓄力挥冰锤，带范围冻结。' },
            atkInterval: 3.2, attacks: true,
            stats: { hp: 320, atk: 34, def: 6, ms: 0.9, range: 2, crit: 8, dodge: 8, regen: 1.5 },
            reward: { gold: 7, exp: 50 },
            role: '冰系前排杂兵，蓄力冻结。',
            dota: '参考 dota2 冰川/树精的冰锤蓄力。',
            skills: [],
            design: '哨卫方块 + 蓄力扇，冰晶标记 = 会冻结。',
            tell: '蓄力扇亮 = 别站它要砸的范围。',
            build: '抓硬直窗口输出。',
            tags: ['近战', '冰', '蓄力']
        },
        {
            id: 25, code: 'elite_storm_giant', name: '风暴巨人', en: 'Storm Giant',
            cat: 'elite', stage: 4, element: '雷', shape: 'colossus',
            ai: { type: 'chase', params: { speedMul: 0.95 }, desc: '缓慢逼近，重踏范围麻痹。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 1600, atk: 88, def: 22, ms: 0.95, range: 2.5, crit: 12, dodge: 8, regen: 6 },
            reward: { gold: 34, exp: 160 },
            role: '雷系重装精英，重踏控场。',
            dota: '参考 dota2 巨人/风暴重击的麻痹。',
            skills: [{ name: '雷电重踏', cd: 8, behavior: 'aoe', desc: '重踏地面，范围内麻痹并连锁。' }],
            design: '巨像方块 + 折线闪电标记 + 双外环，强调色核心 = 重踏。',
            tell: '大块 + 闪电 = 一踏就麻痹一片，拉开站位。',
            build: '用远程消耗，别进它重踏圈。',
            tags: ['近战', '精英', '雷', 'AOE']
        },
        {
            id: 26, code: 'elite_ice_queen', name: '冰霜女王', en: 'Ice Queen',
            cat: 'elite', stage: 4, element: '冰', shape: 'wraith',
            ai: { type: 'orbit', params: { orbitRadius: 230, angularSpeed: 1.3, attackInterval: 3.0 }, desc: '绕场冰封，范围冻结。' },
            atkInterval: 3.0, attacks: true,
            stats: { hp: 980, atk: 78, def: 14, ms: 1.1, range: 7, crit: 15, dodge: 14, regen: 4 },
            reward: { gold: 36, exp: 175 },
            role: '冰系远程精英，大范围冻结。',
            dota: '参考 dota2 冰霜女妖的冰封控场。',
            skills: [{ name: '冰封新星', cd: 9, behavior: 'aoe', desc: '冻结周围一片区域，范围内敌人叠加冰冻。' }],
            design: '亡灵兜帽 + 轨道弧 + 六轴冰晶标记，双外环 = 精英。',
            tell: '顶部冰晶亮 = 即将大冻结，全队散了。',
            build: '最优先处理，它一冻就控整队。',
            tags: ['远程', '精英', '冰', '控制']
        },
        {
            id: 27, code: 'elite_volcanic_drake', name: '火山龙兽', en: 'Volcanic Drake',
            cat: 'elite', stage: 4, element: '火', shape: 'serpent',
            ai: { type: 'chase', params: { speedMul: 1.15 }, desc: '疾速龙形逼近，命中溅射灼烧。' },
            atkInterval: 2.9, attacks: true,
            stats: { hp: 1200, atk: 82, def: 18, ms: 1.15, range: 3, crit: 14, dodge: 10, regen: 5 },
            reward: { gold: 30, exp: 150 },
            role: '火系重装精英，溅射灼烧。',
            dota: '参考 dota2 龙兽的火系溅射。',
            skills: [{ name: '熔岩溅落', cd: 8, behavior: 'aoe', desc: '喷吐熔岩，命中区域溅射灼烧。' }],
            design: '龙形（serpent）+ 火苗标记 + 双外环，强调色头部 = 溅射源。',
            tell: '龙形 + 火 = 命中会溅射，别聚堆。',
            build: '拉开间距，躲它喷吐。',
            tags: ['近战', '精英', '火', '溅射']
        },
        {
            id: 28, code: 'boss_winter_tyrant', name: '凛冬暴君', en: 'Winter Tyrant',
            cat: 'stage_boss', stage: 4, element: '冰', shape: 'colossus',
            ai: { type: 'boss', params: { skillInterval: 6, skillId: 'blizzard', phases: [{ hpRatio: 1.0, behavior: 'chase', params: { speedMul: 0.8 } }, { hpRatio: 0.5, behavior: 'orbit', params: { orbitRadius: 260, angularSpeed: 1.0 } }] }, desc: '阶段一逼近砸冰，过半转环绕放暴风雪。' },
            atkInterval: 3.4, attacks: true,
            stats: { hp: 11500, atk: 180, def: 36, ms: 0.85, range: 4, crit: 18, dodge: 10, regen: 14 },
            reward: { gold: 230, exp: 1050 },
            role: '阶段4守关 Boss，全屏冰封威胁。',
            dota: '参考 dota2 冰霜系 Boss 的暴风雪+冻结控场。',
            skills: [
                { name: '暴风雪', cd: 6, behavior: 'aoe', desc: '召唤多轮冰锥砸向随机区域，命中冻结。' },
                { name: '绝对零度', cd: 0, behavior: 'passive', desc: '自身周围持续释放冰霜，范围内敌人减速叠满即冻结。' },
                { name: '冰盖冲撞', cd: 0, behavior: 'charge', desc: '血量低于 50% 后环绕并撞击一次。' }
            ],
            design: '巨像方块 + 六轴冰晶 + 四段外环，冰晶亮 = 暴风雪在读条。',
            tell: '外环过半 = 转环绕，注意全屏冰锥落点。',
            build: '分散站位，它读暴风雪时全员散开。',
            tags: ['boss', '阶段4', '冰', 'AOE']
        },

        /* ================================================================ 全局特殊首领（不攻击 · 任务/收益型） */
        {
            id: 29, code: 'boss_gold_hoarder', name: '黄金囤积者', en: 'Gold Hoarder',
            cat: 'gold_boss', stage: null, element: '无', shape: 'sentinel',
            ai: { type: 'passive', params: {}, desc: '不主动攻击，只在场上游走，击杀后爆金币。' },
            atkInterval: 0, attacks: false,
            stats: { hp: 2600, atk: 0, def: 8, ms: 0.6, range: 0, crit: 0, dodge: 0, regen: 0 },
            reward: { gold: 400, exp: 40 },
            role: '全局金币首领，击杀收益极高（不攻击）。',
            dota: '对应 units.json rewardType=gold_boss（黄金魔像）的"奖励画在身上"；参考 dota2 赏金/肉山掉落。',
            skills: [],
            design: '哨卫方块 + 禁攻杠（两端锁状）+ 中央金币图标，四角铆钉 = 牢不可破。',
            tell: '身上有禁攻杠和金币 = 不攻击、打死给钱，优先级最高。',
            build: '只要它出现，最短时间集火抢钱。',
            tags: ['全局', '金币', '不攻击']
        },
        {
            id: 30, code: 'boss_kill_master', name: '击杀大师', en: 'Kill Master',
            cat: 'kill_boss', stage: null, element: '暗', shape: 'wraith',
            ai: { type: 'passive', params: {}, desc: '不主动攻击，出现一段时间内击杀数触发奖励（同屏存活的"击杀计数目标"）。' },
            atkInterval: 0, attacks: false,
            stats: { hp: 3000, atk: 0, def: 10, ms: 0.75, range: 0, crit: 0, dodge: 0, regen: 0 },
            reward: { gold: 120, exp: 600 },
            role: '全局击杀首领，限时击杀拿经验（不攻击）。',
            dota: '参考 dota2 击杀悬赏目标（高经验）定位，限定存活时间。',
            skills: [],
            design: '亡灵兜帽 + 禁攻杠 + 中央准星（kill 图标），暗影标记在底部。',
            tell: '准星 + 禁攻 = 限时击杀目标，经验巨额，时间到消失。',
            build: '卡好时间，最短时间击杀拿满 600 经验。',
            tags: ['全局', '击杀', '经验']
        },
        {
            id: 31, code: 'boss_bastion_watcher', name: '壁垒守望者', en: 'Bastion Watcher',
            cat: 'defense_boss', stage: null, element: '物理', shape: 'colossus',
            ai: { type: 'passive', params: {}, desc: '不主动攻击，是敌方防线核心 —— 我方需攻破它才能推进，防守侧可短暂站桩输出。' },
            atkInterval: 0, attacks: false,
            stats: { hp: 9000, atk: 0, def: 30, ms: 0.5, range: 0, crit: 0, dodge: 0, regen: 0 },
            reward: { gold: 0, exp: 300 },
            role: '敌方防守 Boss —— 攻防核心（不攻击，纯防守要拆）。',
            dota: '对应"敌方防守首领"：参考 dota2 防守塔/基地攻防核心的站桩定位。',
            skills: [{ name: '铜墙铁壁', cd: 12, behavior: 'passive', desc: '周期性获得护盾与减伤，需先拆护甲层。' }],
            design: '巨像方块 + 禁攻杠 + 中央盾徽，外环盾形 = 每次周期刷新护盾。',
            tell: '盾徽 + 禁攻 = 纯防守要拆，周期刷盾别浪费爆发。',
            build: '攒爆发一波拆盾，或用持续灼烧/腐蚀消耗它高护甲。',
            tags: ['全局', '防守', '不攻击']
        }
    ];
})(window);
