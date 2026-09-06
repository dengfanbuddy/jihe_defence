/**
 * data-heroes-c —— 英雄数据（id 21-30）
 * 被动/普攻为静态单条；仅技能 Lv1/10/20/30 升级。
 * 纯 ES5 对象字面量数组，浏览器 <script> 直接加载，禁止 export/import。
 * 8 属性: atk / hp / range / def / aspd / crit / dodge / regen
 * 上限: 射程15m / 攻速3.0 / 暴击60% / 闪避40% / 护甲减伤70%
 * 流派: 物理暴击 / 远程点杀 / 法术爆发 / 元素持续 / 控制减速 / 坦克反伤 / 召唤增殖 / 经济成长
 */

window.HERO_DATA_C = [
    // ============ 21 修补匠 Tinker ============
    {
        id: 21,
        code: 'tinker',
        name: '修补匠',
        en: 'Tinker',
        archetype: '法术爆发',
        role: '技能循环 | 冷却刷新 | 远程轰炸',
        element: '火',
        growth: '攻击型',
        tend: { atk: '高', hp: '低', range: '高', def: '低', aspd: '中', crit: '中', dodge: '中', regen: '中' },
        base: { atk: 25, hp: 120, range: 7, def: 3, aspd: 1.2, crit: 5, dodge: 5, regen: 1.0 },
        difficulty: 4,
        unlock: { gold: 12000, ach: '单局释放技能 120 次' },
        passive: { name: '刷新引擎', desc: '技能命中敌人返还8%冷却；每击杀1个敌人即刻重置主技能冷却。' },
        attack: { name: '充能激光', desc: '发射激光造成100%攻击力伤害，命中叠加1层灼烧(每秒15%攻击力)。' },
        skill: {
            name: '热导飞弹',
            lv1: '锁定最近敌人发射热导飞弹，落点爆炸(半径2.5m)造成250%攻击力伤害。',
            lv10: '伤害提升至350%，爆炸半径增至3.0m。',
            lv20: '导弹分裂为2枚，总伤害500%；命中额外叠加1层灼烧。',
            lv30: '导弹分裂为3枚每枚250%伤害，爆炸可暴击并叠加1层静电磁场。'
        },
        build: '推荐构筑：堆技能伤害与冷却，围绕导弹爆炸铺灼烧。',
        tip: '技能命中刷新冷却，善用被动循环爆发。'
    },

    // ============ 22 钢背兽 Bristleback ============
    {
        id: 22,
        code: 'bristleback',
        name: '钢背兽',
        en: 'Bristleback',
        archetype: '坦克反伤',
        role: '身板承伤 | 反击反伤 | 破甲腐蚀',
        element: '毒',
        growth: '生存型',
        tend: { atk: '低', hp: '极高', range: '中', def: '极高', aspd: '低', crit: '中', dodge: '中', regen: '中' },
        base: { atk: 12, hp: 400, range: 5, def: 15, aspd: 0.8, crit: 5, dodge: 5, regen: 1.0 },
        difficulty: 3,
        unlock: { gold: 9500, ach: '单局受到伤害 6000 点' },
        passive: { name: '硬背', desc: '背部受到伤害降低70%；受击时反弹20%攻击力伤害并叠1层腐蚀。' },
        attack: { name: '针刺爆射', desc: '向范围3m敌人喷刺，造成80%攻击力伤害并叠加1层毒液(每秒10%)。' },
        skill: {
            name: '黏液破甲',
            lv1: '喷射黏液(范围3.5m)破甲40%，使敌人腐蚀(每层减速15%)叠3层。',
            lv10: '破甲提升至55%；腐蚀减速增至每层20%。',
            lv20: '破甲70%、范围扩至4.5m；针刺爆射伤害提升至100%。',
            lv30: '破甲85%；命中额外叠3层毒液，针刺命中触发爆炸(半径2.5m)。'
        },
        build: '推荐构筑：堆护甲减伤与反伤，破甲腐蚀后针刺收割。',
        tip: '背对敌人减伤，靠破甲反伤持续压制。'
    },

    // ============ 23 半人马战行者 Centaur Warrunner ============
    {
        id: 23,
        code: 'centaur',
        name: '半人马战行者',
        en: 'Centaur Warrunner',
        archetype: '坦克反伤',
        role: '近战霸体 | 反击重踏 | 归返反伤',
        element: '无',
        growth: '生存型',
        tend: { atk: '中', hp: '极高', range: '近', def: '高', aspd: '低', crit: '中', dodge: '中', regen: '中' },
        base: { atk: 18, hp: 400, range: 3.5, def: 10, aspd: 0.8, crit: 5, dodge: 5, regen: 1.0 },
        difficulty: 3,
        unlock: { gold: 9000, ach: '单局触发反击重踏 80 次' },
        passive: { name: '归返反击', desc: '受击时反弹45%攻击力伤害，并使来源叠加1层腐蚀(减速15%)。' },
        attack: { name: '重踏震击', desc: '踏击范围2.5m内敌人，造成100%攻击力伤害并眩晕0.5秒。' },
        skill: {
            name: '反击重踏',
            lv1: '对3m范围敌人造成180%攻击力伤害并眩晕1秒，自身获得15%护盾。',
            lv10: '伤害提升至250%；眩晕1.2秒，护盾提升至25%。',
            lv20: '伤害350%、范围4m；命中叠加2层腐蚀。',
            lv30: '伤害500%、眩晕1.5秒；命中后40%概率触发一次归返反击。'
        },
        build: '推荐构筑：护甲与格挡叠减伤，反伤配合腐蚀磨群。',
        tip: '踩踏眩晕控场，反伤跟腐蚀持续压制。'
    },

    // ============ 24 圣堂刺客 Templar Assassin ============
    {
        id: 24,
        code: 'templar',
        name: '圣堂刺客',
        en: 'Templar Assassin',
        archetype: '物理暴击',
        role: '折光护盾 | 灵能陷阱 | 破甲暴击',
        element: '暗',
        growth: '暴击型',
        tend: { atk: '高', hp: '低', range: '中', def: '低', aspd: '中', crit: '极高', dodge: '中', regen: '中' },
        base: { atk: 25, hp: 120, range: 5, def: 3, aspd: 1.2, crit: 15, dodge: 5, regen: 1.0 },
        difficulty: 3,
        unlock: { gold: 13500, ach: '单局暴击触发 200 次' },
        passive: { name: '折光', desc: '获得3层折光，每层抵挡1次攻击伤害；层数破碎后暴击率+10%持续3秒。' },
        attack: { name: '灵能尖刺', desc: '普攻造成100%攻击力伤害并破甲20%；暴击时追加50%攻击力伤害。' },
        skill: {
            name: '灵能陷阱',
            lv1: '放置1座灵能陷阱(存留8秒)，触发时减速60%、破甲30%，持续3秒。',
            lv10: '陷阱增至2座，存留12秒；触发造成200%攻击力伤害。',
            lv20: '触发伤害300%、破甲45%；陷阱内敌人暴击率+15%。',
            lv30: '陷阱3座，触发伤害450%；被触发敌人受到伤害+25%。'
        },
        build: '推荐构筑：折光护盾保命，灵能破甲喂暴击收割。',
        tip: '先埋陷阱再破甲暴击，脆皮刺客别硬吃。'
    },

    // ============ 25 瘟疫法师 Necrophos ============
    {
        id: 25,
        code: 'necrophos',
        name: '瘟疫法师',
        en: 'Necrophos',
        archetype: '元素持续',
        role: '死亡脉冲 | 毒素削弱 | 镰刀斩杀',
        element: '毒',
        growth: '均衡型',
        tend: { atk: '高', hp: '中', range: '中', def: '中', aspd: '中', crit: '低', dodge: '低', regen: '高' },
        base: { atk: 25, hp: 180, range: 5, def: 6, aspd: 1.2, crit: 3, dodge: 2, regen: 2.0 },
        difficulty: 4,
        unlock: { gold: 11000, ach: '单局镰刀斩杀 80 个敌人' },
        passive: { name: '枯萎灵气', desc: '周围3m敌人每秒流失3%最大生命，并降低40%受治疗。' },
        attack: { name: '死亡脉冲', desc: '脉冲伤害4m内敌人100%攻击力，并回复自身5%最大生命。' },
        skill: {
            name: '镰刀斩杀',
            lv1: '对生命<30%敌人挥镰，造成300%攻击力伤害并触发斩杀(暗影×1.3)。',
            lv10: '斩杀阈值提升至40%，伤害提升至400%。',
            lv20: '伤害500%；斩杀成功立即重置死亡脉冲冷却。',
            lv30: '伤害650%、斩杀阈值50%；超额斩伤转化为自身回复。'
        },
        build: '推荐构筑：毒雾持续压低血线，镰刀收割回血。',
        tip: '先铺DOT压低血线，镰刀专收残血。'
    },

    // ============ 26 天怒法师 Skywrath Mage ============
    {
        id: 26,
        code: 'skywrath',
        name: '天怒法师',
        en: 'Skywrath Mage',
        archetype: '法术爆发',
        role: '高速奥术 | 印记易伤 | 法术爆发',
        element: '雷',
        growth: '攻速型',
        tend: { atk: '高', hp: '低', range: '中', def: '低', aspd: '快', crit: '中', dodge: '中', regen: '中' },
        base: { atk: 25, hp: 120, range: 5, def: 3, aspd: 1.6, crit: 5, dodge: 5, regen: 1.0 },
        difficulty: 4,
        unlock: { gold: 13000, ach: '单局技能命中敌人 300 次' },
        passive: { name: '奥术印记', desc: '普攻命中叠印记，每层削弱敌人20%魔抗；印记期间技能伤害+15%。' },
        attack: { name: '奥术之弧', desc: '普攻发射奥术弹造成100%攻击力伤害，并叠加1层奥术印记。' },
        skill: {
            name: '远古封印',
            lv1: '封印单体3秒，使其受到法术伤害+30%并减速50%。',
            lv10: '封印时间4秒，法术易伤提升至50%。',
            lv20: '改为范围4m封印，法术易伤+70%。',
            lv30: '封印5秒、法术易伤+100%；引爆目标所有静电磁场。'
        },
        build: '推荐构筑：高速普攻叠印记，封印后法术爆发。',
        tip: '先叠印记再封印，法伤集中爆发。'
    },

    // ============ 27 育母蜘蛛 Broodmother ============
    {
        id: 27,
        code: 'broodmother',
        name: '育母蜘蛛',
        en: 'Broodmother',
        archetype: '召唤增殖',
        role: '织网增益 | 毒液叠层 | 蜘蛛增殖',
        element: '毒',
        growth: '均衡型',
        tend: { atk: '高', hp: '中', range: '近', def: '低', aspd: '快', crit: '中', dodge: '中', regen: '中' },
        base: { atk: 25, hp: 180, range: 3.5, def: 3, aspd: 1.6, crit: 5, dodge: 5, regen: 1.0 },
        difficulty: 4,
        unlock: { gold: 10500, ach: '单局召唤蜘蛛 150 只' },
        passive: { name: '蛛网领域', desc: '3.5m内结成蛛网，友军攻速+15%、移速+20%，敌方减速25%。' },
        attack: { name: '毒牙撕咬', desc: '普攻造成100%攻击力伤害，并叠加1层毒液(每秒10%)。' },
        skill: {
            name: '蜘蛛增殖',
            lv1: '召唤3只小蜘蛛(继承40%攻击力，存留8秒，上限10只)，攻击叠毒液。',
            lv10: '召唤4只，继承55%攻击力，存留10秒，上限15只。',
            lv20: '召唤6只，继承70%，存留12秒；蜘蛛死亡自爆(半径1m)。',
            lv30: '召唤8只，继承90%，存留15秒，上限20只。'
        },
        build: '推荐构筑：铺网拉攻速，蜘蛛大军叠毒液爆炸。',
        tip: '蜘蛛继承攻击力，速刷增殖滚雪球。'
    },

    // ============ 28 寒冬飞龙 Winter Wyvern ============
    {
        id: 28,
        code: 'winter',
        name: '寒冬飞龙',
        en: 'Winter Wyvern',
        archetype: '控制减速',
        role: '极寒诅咒 | 冰冻控场 | 严寒烧灼',
        element: '冰',
        growth: '生存型',
        tend: { atk: '低', hp: '高', range: '中', def: '中', aspd: '低', crit: '中', dodge: '中', regen: '高' },
        base: { atk: 12, hp: 280, range: 5, def: 6, aspd: 0.8, crit: 5, dodge: 5, regen: 2.0 },
        difficulty: 3,
        unlock: { gold: 11500, ach: '单局冰冻敌人 200 次' },
        passive: { name: '严寒护甲', desc: '被攻击时攻击者被冰冻(每层减速20%)；自身护甲减伤+8%。' },
        attack: { name: '严寒烧灼', desc: '喷吐极寒烈焰，造成80%攻击力伤害并叠1层冰冻(减速20%)。' },
        skill: {
            name: '极寒诅咒',
            lv1: '诅咒范围2.5m敌人叠3层冰冻，满层硬控1.5秒。',
            lv10: '诅咒范围扩至3.5m，硬控时长2秒，伤害+40%。',
            lv20: '被冻敌人受到伤害+50%，并触发一次爆炸(半径2.5m)。',
            lv30: '硬控2.5秒；冻住敌人冰抗-30%持续5秒。'
        },
        build: '推荐构筑：叠冰冻硬控，减伤拉高生存磨群。',
        tip: '冻住关键敌人，借严寒护甲保命。'
    },

    // ============ 29 灰烬之灵 Ember Spirit ============
    {
        id: 29,
        code: 'ember',
        name: '灰烬之灵',
        en: 'Ember Spirit',
        archetype: '物理暴击',
        role: '残焰位移 | 灼热爆伤 | 火焰之灵',
        element: '火',
        growth: '暴击型',
        tend: { atk: '高', hp: '低', range: '中', def: '低', aspd: '中', crit: '极高', dodge: '中', regen: '中' },
        base: { atk: 25, hp: 120, range: 5, def: 3, aspd: 1.2, crit: 15, dodge: 5, regen: 1.0 },
        difficulty: 4,
        unlock: { gold: 15000, ach: '单局暴击 250 次' },
        passive: { name: '火焰之灵', desc: '获得火焰护盾(减伤12%)；暴击时护盾反击周围敌人叠1层灼烧。' },
        attack: { name: '烈焰之刃', desc: '普攻造成110%攻击力伤害；暴击时追加25%伤害并叠1层灼烧。' },
        skill: {
            name: '残焰突袭',
            lv1: '埋设1枚残焰(存留6秒)；引爆时瞬移并造成250%攻击力范围伤害。',
            lv10: '残焰增至2枚，伤害提升至350%；瞬移后攻速+20%持续3秒。',
            lv20: '残焰3枚，伤害500%；引爆生成火焰之灵护盾(减伤30%，3秒)。',
            lv30: '伤害700%；残焰引爆令周围2.5m敌人叠满10层灼烧。'
        },
        build: '推荐构筑：暴击叠灼烧，残焰引爆溅射割群。',
        tip: '残焰引爆爆发，护盾抗压控场。'
    },

    // ============ 30 混沌骑士 Chaos Knight ============
    {
        id: 30,
        code: 'chaos',
        name: '混沌骑士',
        en: 'Chaos Knight',
        archetype: '物理暴击',
        role: '幻象增殖 | 混乱之箭 | 随机暴击',
        element: '无',
        growth: '攻击型',
        tend: { atk: '极高', hp: '中', range: '近', def: '中', aspd: '低', crit: '高', dodge: '中', regen: '中' },
        base: { atk: 32, hp: 180, range: 3.5, def: 6, aspd: 0.8, crit: 10, dodge: 5, regen: 1.0 },
        difficulty: 5,
        unlock: { gold: 16000, ach: '单局击杀敌人 300 个' },
        passive: { name: '混沌之力', desc: '攻击15%概率造成暴击伤害×2.5(混乱之箭)，并眩晕目标0.5秒。' },
        attack: { name: '混沌之刃', desc: '普攻造成100%攻击力伤害，可触发被动混乱暴击。' },
        skill: {
            name: '幻象军团',
            lv1: '召唤1个幻象(继承40%攻击力，存留8秒，上限6个)，共享暴击。',
            lv10: '召唤2个幻象，继承55%攻击力，存留10秒。',
            lv20: '召唤3个幻象，继承70%，存留12秒；死亡自爆(半径1.5m)。',
            lv30: '召唤4个幻象，继承90%，存留15秒；幻象攻击15%概率眩晕。'
        },
        build: '推荐构筑：幻象吃攻击力，堆攻击横扫全场。',
        tip: '先召幻象再爆发，依靠攻击成长碾压。'
    }
];
