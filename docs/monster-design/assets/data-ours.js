/**
 * GlyphDataOurs —— 本作单位/弹道/状态的设计元数据
 * 数值全部取自项目真实配置：
 *   units.json（base_attributes 按 attributes.json 解码）
 *   abilities.json / element_effects.json
 */
(function (global) {
    'use strict';

    /* attributes.json: 1生命 2魔法 3攻击 4攻速% 5移速 6护甲 7魔抗 8闪避 9生命回复 16攻击距离 */

    var units = [
        {
            code: 'hero_knight', id: 1, team: 1, name: '骑士', en: 'Knight', kind: 'hero',
            radius: 26, atkInterval: 1.7, ai: '玩家/队伍单位', prefab: 'prefabs/units/hero_knight',
            abilities: '战吼（+8s增益）· 圣光术（治疗 80）',
            shot: '近战，无弹道',
            stats: { hp: 500, mp: 100, atk: 42, as: '100%', ms: 320, def: 5, mr: '25%', range: 100 },
            silhouette: '菱核 + 左右厚弧 + 底部双震荡线',
            design: '近战唯一拥有"包裹式外弧"的单位，弧的厚度就是它 500 血 + 5 护甲的视觉重量。底部两条虚线是战吼的冲击波，只在开技能时点亮。',
            tell: '攻击距离仅 100，剪影里没有任何射击构件 —— 看到双弧就知道必须贴脸。'
        },
        {
            code: 'hero_mage', id: 2, team: 1, name: '法师', en: 'Mage', kind: 'hero',
            radius: 26, atkInterval: 1.7, ai: '玩家/队伍单位', prefab: 'prefabs/units/hero_mage',
            abilities: '火球术（60 伤 + 灼烧 3s）· 霜冻新星（40 伤 / 半径 250）',
            shot: 'frost_bolt（冰霜弹）',
            stats: { hp: 350, mp: 260, atk: 25, as: '100%', ms: 300, def: 1, mr: '30%', range: 500 },
            silhouette: '同心双环 + 六向霜芒 + 顶部火球蓄能点',
            design: '同心环＝远程核心（射程 500）。六角虚线框直接画出霜冻新星 250 的作用半径，顶端那颗强调色圆点是火球术的读条位。一个剪影同时交代了两套技能。',
            tell: '六角虚线框亮起 = 霜冻新星进入冷却结束；顶点圆点变实 = 火球即将出手。'
        },
        {
            code: 'hero_bounty', id: 3, team: 1, name: '赏金猎人', en: 'Bounty Hunter', kind: 'hero',
            radius: 26, atkInterval: 0.85, ai: '玩家/队伍单位', prefab: 'prefabs/units/hero_bounty',
            abilities: '飞镖三阶（50→75→100）· 偷钱被动 · 赏金标记',
            shot: 'shuriken（飞镖，弹速 1200）',
            stats: { hp: 520, mp: 100, atk: 50, as: '120%', ms: 315, def: 4, mr: '25%', range: 550, regen: 3 },
            silhouette: '三叶飞镖 + 外圈金币虚线环 + 右上标记十字',
            design: '本体就是它的弹道（三叶星），强化"人即武器"。外圈虚线金环对应偷钱被动，右上角十字是赏金标记的施加源；两个被动都被画进了同一个剪影。',
            tell: '攻击间隔 0.85s 是全队最快 —— 三叶星的旋转速度直接绑定攻速表现。'
        },

        {
            code: 'mon_goblin', id: 4, team: 2, name: '哥布林', en: 'Goblin', kind: 'normal',
            radius: 10, atkInterval: 2, ai: 'chase', prefab: 'prefabs/unit/monsters/one',
            reward: '金 2 · 经验 8',
            stats: { hp: 100, mp: 30, atk: 0, as: '100%', ms: 240, def: 0, mr: '25%', range: 100 },
            silhouette: '一颗实心圆 + 一个前指尖角',
            design: '碰撞半径只有 10，是全场最小单位，因此只允许两个图元：色块 + 方向。尖角同时承担"朝向"和"chase AI"的语义，速度线表示 240 的移速在杂兵里偏快。',
            tell: '场上唯一"没有任何附件"的怪 —— 看到纯色块就可以无脑清。',
            warn: 'units.json 中攻击力配置为 0，若期望它造成接触伤害需要补值。'
        },
        {
            code: 'mon_troll', id: 5, team: 2, name: '巨魔', en: 'Troll', kind: 'normal',
            radius: 24, atkInterval: 2, ai: 'chase（speedMul 0.9）', prefab: 'prefabs/units/monster_5',
            reward: '金 4 · 经验 15',
            stats: { hp: 240, mp: 20, atk: 16, as: '100%', ms: 220, def: 3, mr: '25%', range: 100 },
            silhouette: '厚实五边形 + 双肩横杠 + 钝头方向线',
            design: '和哥布林同为 chase，但半径 24 是它的 2.4 倍，所以用"多边形 + 肩线"把体积撑出来。方向线做成钝头（不是尖角），对应 0.9 倍速度修正 —— 同一 AI 的两档速度靠头部形状区分。',
            tell: '肩部两道横杠＝有护甲（3 点），子弹打上去会有减伤反馈。'
        },
        {
            code: 'mon_wanderer', id: 6, team: 2, name: '游荡者', en: 'Wanderer', kind: 'normal',
            radius: 18, atkInterval: 2, ai: 'wander（游荡 150 / 仇恨 350）', prefab: 'prefabs/units/monster_6',
            reward: '金 2 · 经验 6',
            stats: { hp: 80, mp: 20, atk: 7, as: '100%', ms: 200, def: 0, mr: '20%', range: 90 },
            silhouette: '空心环 + 断续折线轨迹 + 外圈大虚线仇恨圈',
            design: '唯一"空心"的杂兵 —— 空心＝尚未锁定目标。身后的断续折线是 wander 的随机路径，外圈 46 半径的虚线圈按比例对应 350 的仇恨范围：玩家踏进去它才会实心化并直冲。',
            tell: '环由空心变实心＝已进入仇恨，路径从折线变直线。'
        },
        {
            code: 'mon_orbiter', id: 7, team: 2, name: '环绕魔', en: 'Orbiter', kind: 'normal',
            radius: 18, atkInterval: 2, ai: 'orbit（半径 200 / 角速 1.8）', prefab: 'prefabs/units/monster_7',
            reward: '金 3 · 经验 10',
            stats: { hp: 90, mp: 40, atk: 6, as: '100%', ms: 260, def: 0, mr: '30%', range: 120 },
            silhouette: '轨道虚线圆 + 位于轨道上的小环 + 切线箭头',
            design: '它永远不朝你直冲，所以剪影的重点不是本体而是"轨道"。本体被故意画在轨道顶端而非画面中心，配合切线箭头，一眼说明"要打它得预判提前量"。',
            tell: '轨道中心的小十字＝它绕的是英雄，不是场地中心。'
        },
        {
            code: 'mon_slammer', id: 8, team: 2, name: '重击者', en: 'Slammer', kind: 'elite',
            radius: 26, atkInterval: 3, ai: 'attack_stop（前摇 0.5s / 停顿 2.5s）', prefab: 'prefabs/units/monster_8',
            reward: '金 6 · 经验 25',
            stats: { hp: 320, mp: 20, atk: 24, as: '80%', ms: 180, def: 5, mr: '25%', range: 100 },
            silhouette: '方形砧块 + 顶部蓄力刻度扇 + 地面冲击椭圆',
            design: '精英的唯一直角剪影。顶部那圈虚线扇和三根刻度就是 0.5s 前摇的可视化——刻度点亮到顶即落锤；地面双层椭圆是攻击后 2.5s 停顿期间的落点提示，也是玩家的输出窗口。',
            tell: '刻度扇亮 = 别贴脸；椭圆变实 = 它停住了，白给 2.5 秒输出。'
        },
        {
            code: 'mon_abyss_lord', id: 9, team: 2, name: '深渊领主', en: 'Abyss Lord', kind: 'boss',
            radius: 40, atkInterval: 2.5, ai: 'boss（4 阶段 / 火球术每 6s）', prefab: 'prefabs/units/monster_9',
            reward: '金 40 · 经验 200',
            stats: { hp: 3000, mp: 300, atk: 60, as: '80%', ms: 200, def: 12, mr: '35%', range: 180 },
            silhouette: '四段破碎外环 + 八向内芒 + 强调色核心 + BOSS 底座',
            design: '外环被拆成 4 段弧，正好对应 100% / 70% / 40% / 20% 四个阶段阈值：每破一阶熄灭一段，玩家不看血条也知道它要换行为了。内核是火球术的蓄能点。',
            tell: '外环剩几段＝还剩几个阶段；只剩一段时它进入 1.8 倍速的 attack_stop 狂暴。'
        },
        {
            code: 'mon_gold_golem', id: 10, team: 2, name: '黄金魔像', en: 'Gold Golem', kind: 'gold_boss',
            radius: 38, atkInterval: 2.2, ai: 'chase（speedMul 0.7）', prefab: 'prefabs/units/monster_9',
            reward: '金 250 · 经验 5',
            stats: { hp: 2200, mp: 60, atk: 30, as: '40%', ms: 120, def: 4, mr: '20%', range: 120 },
            silhouette: '双层方框 + 中心钱币 + 四角铆钉 + 底部三枚金币',
            design: '赏金型 BOSS，视觉上必须"一看就想打"。它是全场唯一把奖励画在身上的单位：底部三枚金币环＝250 金掉落。移速 120 + 攻速 40% 是全场最慢，所以剪影用完全静态的对称方框，没有任何方向性构件。',
            tell: '底部金币环 —— 见到就优先集火，它几乎不会威胁你。'
        },
        {
            code: 'mon_exp_sage', id: 11, team: 2, name: '经验贤者', en: 'Exp Sage', kind: 'exp_boss',
            radius: 36, atkInterval: 2.4, ai: 'boss（圣光术每 8s）', prefab: 'prefabs/units/monster_9',
            reward: '金 1 · 经验 800',
            stats: { hp: 1800, mp: 240, atk: 40, as: '70%', ms: 150, def: 8, mr: '30%', range: 140 },
            silhouette: '12 道长短交替光芒 + 圆环 + 中心三角',
            design: '与黄金魔像成对：一个给钱一个给经验，因此共用"奖励写在身上"的规则，但把金币换成放射光芒（对应 sun_light 技能）。长短交替的 12 道芒是全场信息密度最高的外围装饰，用来表达 800 经验的稀有度。',
            tell: '光芒同时是技能预警：全部变实并延长＝圣光术即将落下。'
        }
    ];

    var shots = [
        {
            code: 'shuriken_t1', name: '飞镖 · 一阶', en: 'Shuriken T1', src: 'abilities.json #8',
            spec: '物理 50 · 弹速 1200 · 目标最近',
            note: '三叶星弹头 + 直线点列尾迹。尾迹严格直线，因为 Projectile.ts 是匀速直线推进；末端十字＝发射瞬间锁定的终点快照（目标跑掉也会飞到原点）。'
        },
        {
            code: 'shuriken_t3', name: '飞镖 · 三阶', en: 'Judgement Shuriken', src: 'abilities.json #10',
            spec: '物理 100 · 附加灼烧 3s · 偷金 20',
            note: '在一阶基础上加外圈虚线环（升级标识）与右上金币符号（steal_gold）。同一武器的三个阶段共用剪影，只叠加附件 —— 玩家一眼看出自己升到了几阶。'
        },
        {
            code: 'frost_bolt', name: '冰霜弹', en: 'Frost Bolt', src: 'units.json · 法师普攻',
            spec: '法师普攻投射物 · 射程 500',
            note: '六角晶体弹头 + 后方渐疏斜线。尾迹用虚线表示温度散失，与「冰冻」状态标记共用同一套六轴语汇。'
        },
        {
            code: 'fireball', name: '火球术', en: 'Fireball', src: 'abilities.json #1',
            spec: '魔法 60 · 冷却 3s · 施法距离 600 · 附加灼烧',
            note: '实心圆弹头 + 三条递进的燃烧尾流（由细到粗、由灰到强调色）。命中后右侧的三道短线是点燃残留，直接引出 burn 状态。'
        },
        {
            code: 'poison_dart', name: '毒镖', en: 'Poison Dart', src: 'abilities.json #11',
            spec: '同时锁定 5 个目标 · 弹速 1000',
            note: '唯一的扇形多发弹道：5 条线对应 target_count 5，虚线段是飞行中、实线段是已进入命中判定。发射点画成小环，强调"一次施法多个弹体"。'
        },
        {
            code: 'lightning_chain', name: '闪电链', en: 'Lightning Chain', src: 'abilities.json #5 / element #4',
            spec: '脚本技能 · 弹跳 1 次 · 递减 50%',
            note: '主段实线、跳跃段虚线且更细，末端目标用半透明填充表示只承受 50% 伤害。跳跃次数＝虚线段数量，配置改成 2 跳时直接加一段即可。'
        },
        {
            code: 'frost_nova', name: '霜冻新星', en: 'Frost Nova', src: 'abilities.json #2',
            spec: 'AOE 40 伤 · 半径 250 · 附加冰冻',
            note: '不是弹道而是范围表现：三层同心椭圆（俯视角压扁）+ 八向冰芒。最外层虚线是 250 的真实边界，中层实线是伤害生效帧的扩散环。'
        },
        {
            code: 'sun_light', name: '圣光', en: 'Sun Light', src: 'units.json · 经验贤者技能',
            spec: 'BOSS 技能 · 每 8s 一次',
            note: '自上而下的梯形光柱 + 地面椭圆落点。落点环先出现（预警），光柱后落下 —— 全套表现里唯一"先地面后天空"的时序。'
        }
    ];

    var marks = [
        { code: 'burn', name: '灼烧', en: 'Burn', el: '火', spec: '每 1s 造成 15% 伤害 · 最多 10 层 · 5s', note: '火苗 + 底部层数点。层数点是所有可叠加状态的统一表达。' },
        { code: 'freeze', name: '冰冻', en: 'Freeze', el: '冰', spec: '每层减速 20% · 满 3 层硬控 1.5s', note: '六轴雪花 + 3 格层数点，点满即触发硬控，玩家可以数点预判。' },
        { code: 'poison', name: '毒液', en: 'Poison', el: '毒', spec: '每 1s 造成 10% 伤害 · 最多 10 层', note: '液滴 + 内部气泡，与灼烧同构但填充更暗、轮廓更圆。' },
        { code: 'chain_lightning', name: '连锁闪电', en: 'Chain Lightning', el: '雷', spec: '弹跳 1 次 · 50% 伤害 · 独占', note: '闪电本体 + 两端节点环，节点数＝可跳跃目标数。独占型状态一律不画层数点。' },
        { code: 'explosive', name: '爆炸', en: 'Explosive', el: '爆', spec: '半径 2.5 · 100% 溅射 · 独占', note: '十向长短交替尖刺 + 外圈虚线＝溅射半径。' },
        { code: 'shadow', name: '暗影', en: 'Shadow', el: '暗', spec: '低于 30% 生命时斩杀伤害 ×1.3', note: '半填充圆＝生命被"吃掉"的部分，下方标尺上的强调色刻度就是 30% 斩杀线。' },
        { code: 'static_mark', name: '静电磁场', en: 'Static Mark', el: '雷', spec: '最多 5 层 · 4s', note: '中心闪电 + 环上 5 个电点，点亮几个就是几层，与闪电链共用雷系语汇。' },
        { code: 'bounty_mark', name: '赏金标记', en: 'Bounty Mark', el: '物理', spec: '独占 · 5s · 击杀掉落加成', note: '准星十字 + 强调色环，是唯一由我方施加在敌人身上的正向标记，因此用"瞄准"而非"侵蚀"的图形。' },
        { code: 'corrosive', name: '腐蚀', en: 'Corrosive', el: '毒', spec: '每层减速 15% · 最多 3 层 · 3s', note: '缺口环＝护甲被腐蚀掉一块，与毒液同色系但用"破损"而非"液滴"区分。' }
    ];

    var ai = [
        { code: 'chase', name: '直线追击', en: 'ChaseAI', usedBy: '哥布林 · 巨魔 · 黄金魔像', note: '最短路径直冲，speedMul 决定速度档位。视觉上体现为单位有明确朝向构件（尖角/方向线）。' },
        { code: 'wander', name: '游荡巡逻', en: 'WanderAI', usedBy: '游荡者', note: '在 150 半径内随机游走，玩家进入 350 仇恨圈后切 1.1 倍速直冲。视觉上体现为空心 → 实心的状态切换。' },
        { code: 'orbit', name: '环绕射击', en: 'OrbitAI', usedBy: '环绕魔', note: '以英雄为圆心、半径 200、角速 1.8 绕行，每 2.5s 攻击一次。视觉重点是轨道而非本体。' },
        { code: 'attack_stop', name: '蓄力停顿', en: 'AttackStopAI', usedBy: '重击者', note: '0.5s 前摇 → 攻击 → 2.5s 完全停顿。前摇与停顿都必须有专属图元，否则玩家无法抓输出窗口。' },
        { code: 'boss_phases', name: '阶段切换', en: 'BossAI', usedBy: '深渊领主', note: '按生命比例 1.0 / 0.7 / 0.4 / 0.2 依次切换 chase → orbit → chase(1.6x) → attack_stop(1.8x)，四段外环即四个阶段。' }
    ];

    var rules = [
        { k: '阵营色', v: '我方＝墨色主导 + 强调色核心；敌方＝强调色主导 + 墨色轮廓。满屏时靠"谁是实心色块"分敌我。' },
        { k: '体量即配置', v: '所有单位的绘制尺寸严格按 units.json 的 collision_radius 等比（10 / 18 / 24 / 26 / 36 / 38 / 40）。' },
        { k: 'AI 即附件', v: 'chase＝朝向尖角，wander＝仇恨虚线圈，orbit＝轨道弧，attack_stop＝蓄力刻度，boss＝分段外环。附件不进本体。' },
        { k: '奖励可视化', v: '金币型/经验型 BOSS 把掉落画在身上（金币环 / 放射光芒），让玩家优先级判断不依赖 UI。' },
        { k: '弹道即代码', v: 'Projectile.ts 是匀速直线 + 终点快照，所以所有普攻弹道一律直线尾迹 + 末端锁定十字，不画追踪曲线。' },
        { k: '状态层数', v: '可叠加状态（intensity）画底部层数点，独占状态（exclusive）不画点 —— 直接对应 element_effects.json 的 stackRule。' }
    ];

    global.GlyphDataOurs = { units: units, shots: shots, marks: marks, ai: ai, rules: rules };
})(window);
