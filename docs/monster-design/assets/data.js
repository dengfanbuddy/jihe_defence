/**
 * GlyphData —— 怪物 / 弹道 / 技能图标的设计元数据
 *
 * cfg 字段与 assets/resources/tb/enemies.json 的结构完全一致，
 * 可直接复制粘贴进配置表（id 从 9 开始，接续现有 8 条）。
 */
(function (global) {
    'use strict';

    var TIER = {
        normal: { label: '普通', cls: 'normal' },
        elite: { label: '精英', cls: 'elite' },
        boss: { label: '首领', cls: 'boss' }
    };

    var monsters = [
        {
            code: 'caret_dasher', name: '游标突刺', en: 'Caret Dasher', tier: 'normal',
            role: '突进', element: '—', threat: 2,
            silhouette: '锐角箭头 + 三道速度线',
            behavior: '直线加速冲向核心，接触即自爆式撞击；被击中会短暂失速但不改变航向。',
            design: '参照 Glyphica 里那种"只有一个尖角"的极简敌人：轮廓越少边，玩家越能瞬间读出"这个很快"。速度线是唯一的装饰，且必须落在运动反方向。',
            tell: '尾部三条平行线 —— 场上唯一有"拖影"的普通怪。',
            cfg: {
                id: 9, code: 'caret_dasher', name: '游标突刺', category: 'normal',
                attributes: { atk: 6, maxHp: 30, def: 0, atkSpeed: 1.6, moveSpeed: 2.2, hpRegen: 0 },
                expReward: 9, goldReward: 1, attackRange: 1.2
            }
        },
        {
            code: 'swarm_dot', name: '蜂点群', en: 'Swarm Dot', tier: 'normal',
            role: '群体', element: '—', threat: 2,
            silhouette: '三点编队 + 虚线感知环',
            behavior: '三只共享一条血量，任意一只被击杀其余加速；成群刷新用来铺满屏幕制造压力。',
            design: 'Glyphica 用"一颗实心小圆"当最低级杂兵，本设计把它编组化：单体保持最小信息量，靠编队几何（等边三角）产生辨识度。',
            tell: '顶点那颗带外环的强调色圆点＝队长，优先击杀。',
            cfg: {
                id: 10, code: 'swarm_dot', name: '蜂点群', category: 'normal',
                attributes: { atk: 4, maxHp: 22, def: 0, atkSpeed: 1.2, moveSpeed: 1.5, hpRegen: 0 },
                expReward: 6, goldReward: 1, attackRange: 1.2
            }
        },
        {
            code: 'bracket_guard', name: '括弧卫', en: 'Bracket Guard', tier: 'normal',
            role: '护盾', element: '—', threat: 3,
            silhouette: '两道对开括弧夹住菱形核心',
            behavior: '正面 60° 内伤害减免 70%，侧后方为脆弱点；移动缓慢，负责给后排开路。',
            design: '把"护盾"抽象成排版符号 ( )。两条弧的开口方向就是弱点方向，玩家不需要看血条也知道该绕后。',
            tell: '弧线开口 = 弱点；核心菱形始终朝向移动方向。',
            cfg: {
                id: 11, code: 'bracket_guard', name: '括弧卫', category: 'normal',
                attributes: { atk: 9, maxHp: 120, def: 6, atkSpeed: 0.8, moveSpeed: 0.7, hpRegen: 0 },
                expReward: 18, goldReward: 3, attackRange: 1.8
            }
        },
        {
            code: 'semicolon_splitter', name: '分号裂体', en: 'Semicolon Splitter', tier: 'normal',
            role: '分裂', element: '—', threat: 3,
            silhouette: '上圆核 + 下逗点，外套断裂虚线环',
            behavior: '死亡时分裂成 2 只半血小体（只保留上半的圆核形态），小体不再分裂。',
            design: '分号本身就是"两个部件拼起来的符号"，天然暗示可分割。外圈虚线环用断口暗示"结构不稳定"。',
            tell: '虚线外环 —— 场上唯一有断口环的怪，代表死亡会产生后续。',
            cfg: {
                id: 12, code: 'semicolon_splitter', name: '分号裂体', category: 'normal',
                attributes: { atk: 7, maxHp: 70, def: 2, atkSpeed: 1.0, moveSpeed: 1.0, hpRegen: 0 },
                expReward: 14, goldReward: 2, attackRange: 1.5, skillIds: ['split_on_death']
            }
        },
        {
            code: 'hash_bulwark', name: '井格壁垒', en: 'Hash Bulwark', tier: 'normal',
            role: '重装', element: '—', threat: 3,
            silhouette: '圆角方框 + 井字内网 + 四角强调色',
            behavior: '极慢极硬，受击时格线逐格熄灭作为血量表现；被摧毁后原地留下 3 秒减速地块。',
            design: '方形是全场唯一的"直角剪影"，用来承担坦克语义。内部网格既是装饰也是血量 UI —— 复用 Glyphica"用图形本身显示状态"的思路。',
            tell: '四个角的强调色短线，随血量减少逐个消失。',
            cfg: {
                id: 13, code: 'hash_bulwark', name: '井格壁垒', category: 'normal',
                attributes: { atk: 8, maxHp: 320, def: 12, atkSpeed: 0.45, moveSpeed: 0.4, hpRegen: 1 },
                expReward: 26, goldReward: 4, attackRange: 2.0
            }
        },
        {
            code: 'orbiter_warden', name: '环卫者', en: 'Orbiter Warden', tier: 'elite',
            role: '卫星护体', element: '—', threat: 4,
            silhouette: '同心双环核心 + 三颗绕行卫星',
            behavior: '卫星未清空时本体免疫伤害；卫星可被单独锁定，每 8 秒补充一颗。',
            design: '同心圆是 Glyphica 的"高价值目标"母题（◎）。把免疫做成可见的三颗实体，让玩家自己算"先打哪个"。',
            tell: '绕行卫星的强调色描边环 —— 有环＝还活着＝本体无敌。',
            cfg: {
                id: 14, code: 'orbiter_warden', name: '环卫者', category: 'elite',
                attributes: { atk: 18, maxHp: 380, def: 8, atkSpeed: 0.9, moveSpeed: 0.9, hpRegen: 2 },
                expReward: 48, goldReward: 9, attackRange: 3.5, skillIds: ['satellite_shield']
            }
        },
        {
            code: 'silencer_glyph', name: '缄默者', en: 'Silencer Glyph', tier: 'elite',
            role: '封锁', element: '暗影', threat: 4,
            silhouette: '倒三角被一道粗横杠贯穿',
            behavior: '周期性对英雄施加"缄默"，3 秒内无法释放主动技能；被打断施法会后撤。',
            design: '"删除线"是最直白的禁用符号。倒三角本身有下压感，配合横杠形成"压制"读图。横杠使用强调色，是全场唯一的粗横向元素。',
            tell: '粗横杠会在读条时向两侧延伸 —— 看到延伸就该打断。',
            cfg: {
                id: 15, code: 'silencer_glyph', name: '缄默者', category: 'elite',
                attributes: { atk: 22, maxHp: 220, def: 4, atkSpeed: 0.6, moveSpeed: 0.85, hpRegen: 1 },
                expReward: 55, goldReward: 11, attackRange: 6.5, skillIds: ['silence_field']
            }
        },
        {
            code: 'mirror_shade', name: '镜像残影', en: 'Mirror Shade', tier: 'elite',
            role: '反射', element: '—', threat: 4,
            silhouette: '左厚右薄的对折半环 + 中轴虚线',
            behavior: '正面反射 40% 的投射物伤害回给来源；反射弹道颜色转为强调色以示区分。',
            design: '不对称是关键：左右两半故意用不同粗细和颜色，暗示"一半是本体，一半是镜像"。中轴虚线就是反射面。',
            tell: '中轴虚线；子弹打到它会原路返回并变色。',
            cfg: {
                id: 16, code: 'mirror_shade', name: '镜像残影', category: 'elite',
                attributes: { atk: 16, maxHp: 260, def: 6, atkSpeed: 0.8, moveSpeed: 1.1, hpRegen: 1 },
                expReward: 52, goldReward: 10, attackRange: 2.5, skillIds: ['reflect_aura']
            }
        },
        {
            code: 'weaver_node', name: '织网者', en: 'Weaver Node', tier: 'elite',
            role: '增益中枢', element: '—', threat: 4,
            silhouette: '六边核心 + 五条连线 + 外围节点',
            behavior: '与范围内友军建立连线，每条连线给对方 +15% 攻速；连线可被穿越的弹道打断。',
            design: '直接把 buff 关系"画出来"。Glyphica 里牵引线是很常见的信息层，这里升级成怪物本体的核心识别特征。',
            tell: '场上出现连线＝优先击杀中枢；连线断裂动画即增益消失。',
            cfg: {
                id: 17, code: 'weaver_node', name: '织网者', category: 'elite',
                attributes: { atk: 10, maxHp: 240, def: 5, atkSpeed: 0.7, moveSpeed: 0.75, hpRegen: 3 },
                expReward: 50, goldReward: 12, attackRange: 5.0, skillIds: ['weave_link']
            }
        },
        {
            code: 'vortex_drag', name: '涡卷', en: 'Vortex Drag', tier: 'elite',
            role: '牵引', element: '—', threat: 4,
            silhouette: '两圈半螺线 + 三个内指箭头',
            behavior: '持续把英雄和召唤物往自身方向拖拽；本体不攻击，靠把玩家拖进敌群取胜。',
            design: '螺线是全场唯一的"连续曲线"，跟所有直线/圆形怪物形成绝对区分。箭头方向永远指向内部，把"吸"这个动词图形化。',
            tell: '螺线旋转方向＝牵引方向；停止旋转代表进入冷却。',
            cfg: {
                id: 18, code: 'vortex_drag', name: '涡卷', category: 'elite',
                attributes: { atk: 5, maxHp: 300, def: 7, atkSpeed: 0.5, moveSpeed: 0.6, hpRegen: 2 },
                expReward: 46, goldReward: 10, attackRange: 7.0, skillIds: ['gravity_pull']
            }
        },
        {
            code: 'ember_wisp', name: '灰烬游魂', en: 'Ember Wisp', tier: 'normal',
            role: '留场伤害', element: '灼烧', threat: 3,
            silhouette: '实心火苗 + 内层空心火芯 + 上浮火星',
            behavior: '死亡后在原地留下持续 4 秒的燃烧地块；被冰冻时火芯熄灭，伤害减半。',
            design: '唯一一个"实心填充为主"的怪物，用面积感表达热量。内层描边火芯是留给暗色主题的呼吸口，避免变成一坨死块。',
            tell: '底部的强调色虚线＝死亡后火池的范围预告。',
            cfg: {
                id: 19, code: 'ember_wisp', name: '灰烬游魂', category: 'normal',
                attributes: { atk: 11, maxHp: 65, def: 1, atkSpeed: 1.1, moveSpeed: 1.15, hpRegen: 0 },
                expReward: 16, goldReward: 3, attackRange: 1.5, skillIds: ['burn_pool_on_death']
            }
        },
        {
            code: 'frost_core', name: '霜核', en: 'Frost Core', tier: 'elite',
            role: '减速光环', element: '冰冻', threat: 4,
            silhouette: '六轴晶体 + 分叉枝 + 六边虚线场',
            behavior: '光环内英雄攻速与移速 -25%；本体受到火焰伤害时晶枝逐根折断并永久失去一段光环半径。',
            design: '六轴对称是"冰"的通用语汇。外层六边虚线是光环边界，把数值范围直接画在角色身上 —— 不用额外 UI。',
            tell: '虚线六边＝减速范围，站在框外就安全。',
            cfg: {
                id: 20, code: 'frost_core', name: '霜核', category: 'elite',
                attributes: { atk: 14, maxHp: 280, def: 9, atkSpeed: 0.65, moveSpeed: 0.7, hpRegen: 1 },
                expReward: 54, goldReward: 11, attackRange: 4.5, skillIds: ['frost_aura']
            }
        },
        {
            code: 'editor_eye', name: '编者之眼', en: 'The Editor', tier: 'boss',
            role: '全场审视', element: '暗影', threat: 5,
            silhouette: '横长眼形 + 环状瞳孔 + 上方尖角 + 底座',
            behavior: '阶段一：横扫激光按屏幕水平推进；阶段二：召唤缄默者；阶段三：瞳孔收缩后对英雄全屏点名。',
            design: '直接呼应 Glyphica 首领的"眼型徽记"母题，但把它做得更宽、更扁，让横扫技能的方向预判写在剪影里。底座三角是所有 BOSS 共用的"基座"记号。',
            tell: '瞳孔缩小 = 点名读条；尖角亮起 = 横扫即将开始。',
            cfg: {
                id: 21, code: 'editor_eye', name: '编者之眼', category: 'boss',
                attributes: { atk: 45, maxHp: 3600, def: 18, atkSpeed: 0.55, moveSpeed: 0.5, hpRegen: 6 },
                expReward: 220, goldReward: 55, attackRange: 8.0, skillIds: ['eye_sweep', 'summon_silencer', 'focus_mark']
            }
        },
        {
            code: 'caesura_warden', name: '断句者', en: 'The Caesura', tier: 'boss',
            role: '节奏压制', element: '—', threat: 5,
            silhouette: '双粗竖柱 + 刻度盘 + 左右护弧',
            behavior: '每 20 秒"断句"一次：全场时间静止 1.5 秒，静止结束瞬间释放积攒的全部弹幕。',
            design: '双竖柱取自暂停符号 ‖，把 BOSS 机制直接写成图形。外圈刻度盘＝可读的技能计时器，玩家靠看盘就能倒数。',
            tell: '刻度盘转满一圈＝断句触发；护弧收拢代表进入下一阶段。',
            cfg: {
                id: 22, code: 'caesura_warden', name: '断句者', category: 'boss',
                attributes: { atk: 52, maxHp: 4200, def: 22, atkSpeed: 0.5, moveSpeed: 0.45, hpRegen: 8 },
                expReward: 240, goldReward: 60, attackRange: 5.0, skillIds: ['caesura_freeze', 'burst_release']
            }
        }
    ];

    var projectiles = [
        { code: 'dot_trail', name: '点列弹', en: 'Dot Trail', use: '基础平射', note: '由 12~15 个逐渐变大的圆点组成，头部带一圈半透明外环。Glyphica 的核心弹道语言：不画实体子弹，只画它走过的采样点。' },
        { code: 'arc_lance', name: '弧刺', en: 'Arc Lance', use: '狙击 / 穿透', note: '一条长抛物弧＋末端箭头。强调色只覆盖前半段，形成"能量正在消耗"的读图。' },
        { code: 'chain_fork', name: '链电', en: 'Chain Fork', use: '连锁闪电', note: '折线在节点处分叉，实线＝已结算，虚线＝即将跳跃的下一目标。节点圆点标记跳跃次数。' },
        { code: 'boomerang_arc', name: '回旋弧', en: 'Boomerang Arc', use: '返程弹', note: '开口大弧＋去程实线/返程虚线双轨，返程箭头用强调色，避免与去程混淆。' },
        { code: 'mortar_arc', name: '榴弹弧', en: 'Mortar Arc', use: '抛射 / AOE', note: '虚线抛物线＋地面双层椭圆落点环。落点环先于弹体出现，是唯一"提前告知"的弹道。' },
        { code: 'ink_splatter', name: '溅墨', en: 'Ink Splatter', use: '命中特效', note: '11 根不等长锥形尖刺＋外围碎点，中心留一颗强调色圆。命中反馈全部靠这一套，不用粒子。' },
        { code: 'frost_shard', name: '霜棱', en: 'Frost Shard', use: '冰冻弹', note: '六边晶体弹头＋后方渐疏的斜线尾迹，尾迹用虚线表示"温度散失"。' },
        { code: 'beam_lance', name: '贯穿束', en: 'Beam Lance', use: '持续光束', note: '三层同心线：外层低透明度粗线＝辉光，中层强调色，芯线用墨色保证在亮/暗主题下都可读。' }
    ];

    var icons = [
        { code: 'rapid_fire', name: '连射', en: 'Rapid Fire', note: '三重人字，尺寸递减表示射速叠加。' },
        { code: 'ricochet', name: '弹射', en: 'Ricochet', note: '入射/反射两段线＋虚线地面，直接图解弹跳逻辑。' },
        { code: 'detonate', name: '爆裂', en: 'Detonate', note: '八向长短交替尖刺，中心实心圆＝爆心。' },
        { code: 'freeze', name: '冰封', en: 'Freeze', note: '六轴带分叉，与"霜核"怪物共用同一套晶体语汇。' },
        { code: 'burn', name: '灼烧', en: 'Burn', use: '', note: '实心火苗＋反白火芯＋底部虚线地块，对应"灰烬游魂"。' },
        { code: 'chain_shock', name: '链电', en: 'Chain Shock', note: '闪电实心多边形＋两端节点圆，呼应链电弹道。' },
        { code: 'aegis', name: '护盾', en: 'Aegis', note: '盾形＋对勾，是全套图标里唯一的封闭外轮廓。' },
        { code: 'slow_time', name: '时缓', en: 'Slow Time', note: '钟盘＋指针＋四向刻度，右上虚弧表示"回拨"。' }
    ];

    var vocab = [
        { code: 'ring', name: '同心环', note: '高价值 / 精英目标' },
        { code: 'dot', name: '实心点', note: '最低级杂兵' },
        { code: 'pentagon', name: '多边体', note: '有属性倾向的怪' },
        { code: 'diamond', name: '菱核', note: '核心 / 弱点' },
        { code: 'arc', name: '弧盾', note: '方向性减伤' },
        { code: 'chevron', name: '尖角', note: '高速 / 突进' },
        { code: 'orbit', name: '卫星环', note: '可拆解的护体' },
        { code: 'bar', name: '横杠', note: '封锁 / 状态压制' }
    ];

    var reference = {
        sources: [
            { label: 'Glyphica 官网（实机截图与试玩）', url: 'https://playglyphica.com/' },
            { label: 'Steam 商店页', url: 'https://store.steampowered.com/app/2400160/Glyphica_Typing_Survival/' },
            { label: '中文资料页（游民星空）', url: 'https://ku.gamersky.com/2024/glyphica-survival/' }
        ],
        rules: [
            { k: '画布', v: '纸面米白或近黑底 + 四周暗角，战场中心永远最亮，怪物自然被推到视觉次级。' },
            { k: '配色', v: '严格双色：一个墨色 + 一个强调色（明主题酒红 #A8474B / 暗主题琥珀 #E0B040），灰色只用于辅助信息。' },
            { k: '体量', v: '普通怪 12~18px，精英 22~28px，BOSS 用"徽记"而非放大。屏幕里 90% 的像素是空白。' },
            { k: '线条', v: '主结构 2.2~3px，细节 1.2~1.6px，全部圆头。没有描边阴影、没有渐变、没有高光。' },
            { k: '信息层', v: '词条在头顶、血量是身下一条短横线、倍率是右上角小上标 —— 状态全部用最小图元挂在本体外围。' },
            { k: '虚线约定', v: '虚线一律代表"范围 / 预告 / 尚未发生"，实线代表"已经存在的实体"。' },
            { k: '动效', v: '没有形变动画，只有位移、旋转和透明度。命中反馈靠一次性的墨点飞溅。' }
        ]
    };

    global.GlyphData = {
        TIER: TIER,
        monsters: monsters,
        projectiles: projectiles,
        icons: icons,
        vocab: vocab,
        reference: reference
    };
})(window);
