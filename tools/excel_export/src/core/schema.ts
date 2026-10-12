/**
 * 配表定义（唯一需要维护「字段结构」的地方）
 *
 * 新增字段：在对应表的 fields 里加一行即可，Excel 列由工具自动生成。
 * 新增表：在下面加一个 TableSchema，并在 TABLES 中登记。
 */
import type { FieldDef, TableSchema } from './types.ts';

/** JSON 输出目录（相对项目根） */
export const JSON_DIR = 'assets/resources/tb';

/** 项目内置的权威表（战斗核心 7 张 + 肉鸽商店 3 张） */
export const TABLES: TableSchema[] = [
    // ==================== units：英雄 + 怪物统一实体表 ====================
    {
        name: 'units',
        label: '单位表（英雄/怪物）',
        format: 'array',
        jsonPath: `${JSON_DIR}/units.json`,
        excelFile: 'units.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '唯一ID（英雄 1000 段 / 怪物 2000 段）', required: true },
            { key: 'name', type: 'string', desc: '显示名', required: true },
            { key: 'head_icon', type: 'string', desc: '头像资源路径（textures/heros/xxx）' },
            { key: 'team', type: 'int', desc: '阵营：1=英雄 2=怪物', required: true },
            {
                key: 'category', type: 'enum', desc: '单位大类（供分类/池子使用）',
                enumValues: ['hero', 'monster'],
            },
            {
                key: 'subtype', type: 'enum', desc: '怪物子类型（英雄留空）',
                enumValues: ['normal', 'elite', 'boss'],
            },
            {
                key: 'base_attributes', type: 'attrpairs', required: true,
                desc: '基础属性 [[属性id, 值]]：百分比型属性(攻速/魔抗/闪避/暴率/暴伤/倍率)按 100=100% 填整数，其余填原值',
            },
            { key: 'abilities', type: 'intarray', desc: '技能ID列表（abilities.json 的 id，逗号分隔）' },
            { key: 'scale', type: 'number', desc: '等级成长系数（预留）' },
            { key: 'attack_interval', type: 'number', desc: '普攻基础间隔（秒），实际冷却 = 该值 / 攻速' },
            {
                key: 'attack_targeting', type: 'enum', desc: '普攻索敌策略（缺省 nearest）',
                enumValues: ['nearest', 'farthest', 'lowest_hp', 'strongest', 'random'],
            },
            { key: 'attack_projectile', type: 'string', desc: '普攻投射物标识（留空 = 近战即时命中）' },
            { key: 'attack_projectile_speed', type: 'number', desc: '普攻弹道速度（像素/秒，缺省 1200）' },
            { key: 'attack_projectile_prefab', type: 'string', desc: '普攻弹道预制件路径' },
            { key: 'gold', type: 'number', desc: '初始金币（英雄 0）' },
            { key: 'goldReward', type: 'number', desc: '击杀金币基数（缺省取 battle_constants.enemyDropGoldDefault）' },
            { key: 'expReward', type: 'number', desc: '击杀经验基数（缺省取 battle_constants.enemyDropExpDefault）' },
            {
                key: 'killReward', type: 'number',
                desc: '击杀数奖励（击杀商店的货币；每杀该单位给几点，缺省 1）。'
                    + '玩家自己放的「击杀怪」（rewardType=kill_boss）靠这一列给一次性大额',
            },
            {
                key: 'rewardType', type: 'enum', desc: '奖励类型（gold_boss/exp_boss 为经济BOSS，kill_boss 为击杀BOSS）',
                enumValues: ['normal', 'elite', 'boss', 'gold_boss', 'exp_boss', 'kill_boss'],
            },
            { key: 'ai', type: 'json', desc: 'AI 配置 JSON：{"type":"chase","params":{...}}' },
            { key: 'collision_radius', type: 'number', desc: '碰撞半径（像素，缺省 26）' },
            { key: 'prefab', type: 'string', desc: '单位预制件路径' },
            {
                key: 'growthValues', type: 'floatpairs',
                desc: '每级成长 [[属性id, 成长值]]（float 语义，暴击 0.005 = 0.5%/级；仅英雄填）',
            },
        ],
    },

    // ==================== attributes：属性字典 ====================
    {
        name: 'attributes',
        label: '属性字典表',
        format: 'array',
        jsonPath: `${JSON_DIR}/attributes.json`,
        excelFile: 'attributes.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '属性编号（对齐 battle/core/Types.ts 的 AttributeType）', required: true },
            { key: 'name', type: 'string', desc: '属性显示名', required: true },
            {
                key: 'stack_mode', type: 'enum', desc: '默认叠加方式（percent = 对基础值同类加法叠加后乘算一次）', required: true,
                enumValues: ['add', 'percent', 'multiply', 'complement', 'best'],
            },
            { key: 'base', type: 'number', desc: '初始基础值' },
            { key: 'min', type: 'number', desc: '最小值钳制' },
            { key: 'max', type: 'number', desc: '最大值钳制' },
        ],
    },

    // ==================== abilities：技能表（单位技能 + 肉鸽额外技能，一张表） ====================
    //  2026-09 合并：原 `shop_skills` 表（30 个肉鸽额外技能）并入本表，靠 `scope` 区分技能出现在哪一侧：
    //    scope=unit  单位自带（units.json 的 abilities 引用它）
    //    scope=shop  肉鸽商店抽取池（额外技能，id 段 101~130）
    //    scope=both  两侧都出
    //  多级统一为「一行多级」：`max_level` 说明最高几级（1~3），`lv1/lv2/lv3` 是各级效果描述，
    //  `effects` 是 1 级效果，`effects_lv2/effects_lv3` 是更高一级的**整体覆盖**（留空 = 沿用上一级）。
    //  ⚠ 单位技能那条老的 `upgrades_to` 链**只剩兜底**（火枪鹰眼 12→13→14→15 是孤儿行，没有引用方）：
    //    它一行 = 一个形态、`max_level=1`，靠换 id 升阶。**2026-11 起现役英雄技能都改成一行多级**
    //    （赏金 7「悬赏」/ 宙斯 19「雷霆之核」= `max_level 3`，随英雄 Lv.15/Lv.30 升级；
    //    宙斯原来那条 19→20→21→22 的四阶链已收敛进 19，20/21/22 三行删除）。
    //    两套机制并存、按行各自生效，但**新技能一律用一行多级**。
    {
        name: 'abilities',
        label: '技能表',
        format: 'array',
        jsonPath: `${JSON_DIR}/abilities.json`,
        excelFile: 'abilities.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '技能ID（单位技能 1~99 / 肉鸽额外技能 101~130）', required: true },
            { key: 'name', type: 'string', desc: '技能名', required: true },
            { key: 'code', type: 'string', desc: '唯一英文代码（程序引用用；单位技能可留空）' },
            { key: 'name_en', type: 'string', desc: '英文名（展示/校对用）' },
            {
                key: 'scope', type: 'enum', required: true,
                desc: '归属：unit=单位自带（units.json 的 abilities 引用）· shop=肉鸽商店抽取池 · both=两侧都出',
                enumValues: ['unit', 'shop', 'both'],
            },
            { key: 'icon', type: 'string', desc: '图标资源路径' },
            {
                key: 'behavior', type: 'enum', desc: '施放行为', required: true,
                enumValues: ['passive', 'attack', 'no_target', 'unit_target', 'point', 'aoe', 'toggle'],
            },
            { key: 'cooldown', type: 'number', desc: '冷却（秒）', required: true },
            { key: 'mana_cost', type: 'number', desc: '魔法消耗' },
            { key: 'cast_range', type: 'number', desc: '施法距离（像素，0=自身）' },
            { key: 'cast_point', type: 'number', desc: '施法前摇（秒）' },
            {
                key: 'damage_type', type: 'enum', desc: '伤害类型（留空/填 null 表示无伤害）',
                enumValues: ['physical', 'magical', 'pure'],
            },
            { key: 'damage', type: 'number', desc: '快捷伤害字段（可被 effects 覆盖）' },
            {
                key: 'targeting', type: 'enum', desc: '索敌策略（缺省 nearest）',
                enumValues: ['nearest', 'farthest', 'lowest_hp', 'strongest', 'random'],
            },
            {
                key: 'effects', type: 'json', required: true,
                desc: '效果 JSON 数组，如 [{"type":"damage","value":60}]；动作类型见 Tb_AbilityConfig.ConfigAction',
            },
            { key: 'script_id', type: 'string', desc: '复杂逻辑代码类名（逃逸口）' },
            { key: 'level', type: 'int', desc: '当前等级（预留）' },
            { key: 'level_damage', type: 'numberarray', desc: '每级伤害，如 20,40,60' },
            { key: 'upgrades_to', type: 'int', desc: '升级形态的技能ID（**单位技能**的换 id 升阶链；肉鸽技能不用它，改用 max_level 原地升级）' },
            { key: 'projectile_prefab', type: 'string', desc: '技能弹道预制件路径' },

            /* ── 以下为「一行多级」+ 商店抽取所需列（原 shop_skills 表并入） ── */

            {
                key: 'rarity', type: 'enum', desc: '品质（**只有商店技能填**：白/蓝/黄/红，同 relics.rarity 四档；单位技能留空）',
                enumValues: ['common', 'rare', 'epic', 'legendary'],
            },
            { key: 'stage', type: 'int', desc: '抽取阶段门槛 1~4（商店技能必填；阶段推导同 shop_constants.stageMaxByPhase）' },
            { key: 'weight', type: 'int', desc: '同品质内的抽取权重（留空按 1）' },
            { key: 'max_level', type: 'int', desc: '最高等级 1~3（重复抽到同名技能 +1 级，满级后不再进池；单位技能填 1）' },
            { key: 'tags', type: 'stringarray', desc: '流派标签' },
            { key: 'lv1', type: 'string', desc: '1 级效果描述（给玩家看；留空时运行时按 cooldown/effects 自动拼一句话兜底）' },
            { key: 'lv2', type: 'string', desc: '2 级效果描述' },
            { key: 'lv3', type: 'string', desc: '3 级效果描述（满级）' },
            {
                key: 'effects_lv2', type: 'json',
                desc: '2 级效果**整体覆盖** `effects`（留空 = 沿用 1 级；动作类型见 ConfigAction）',
            },
            {
                key: 'effects_lv3', type: 'json',
                desc: '3 级效果**整体覆盖**（留空 = 沿用上一级）',
            },
            { key: 'synergy', type: 'string', desc: '联动说明（设计参考，不参与结算）' },
        ],
    },

    // ==================== modifiers：Buff/DoT 表 ====================
    {
        name: 'modifiers',
        label: 'Modifier(Buff)表',
        format: 'array',
        jsonPath: `${JSON_DIR}/modifiers.json`,
        excelFile: 'modifiers.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: 'Modifier ID', required: true },
            { key: 'name', type: 'string', desc: '名称', required: true },
            { key: 'icon', type: 'string', desc: '图标资源路径' },
            { key: 'is_debuff', type: 'bool', desc: '是否负面效果（1/0）', required: true },
            { key: 'is_hidden', type: 'bool', desc: '是否在 Buff 栏隐藏（1/0）' },
            {
                key: 'bar_show', type: 'bool',
                desc: '**允许进 HUD 状态栏**（1/0；2026-11 新增）—— 白名单：只有标 1 的行才可能出现在英雄头像下方那一行。'
                    + '标 1 的两类：① 会挂到**英雄**身上的限时/负面（如 燃烧 / 无敌 / 属性修改共享模板）；'
                    + '② 常驻载体里「有就绪/层数可讲」的脚本行（如 遗物·蓄力 / 不屈 / 圣盾）。'
                    + '⚠ 只打怪的 debuff（遗物减速 / 毒 / 点燃那一族）**一律不标** —— 英雄栏看不到它们',
            },
            {
                key: 'bar_text', type: 'string',
                desc: '状态栏格子的**占位短标**（≤2 汉字，如「燃烧」「蓄力」）。'
                    + '留空 = 运行期按来源取名兜底（共享模板 1000 的限时实例按 origin 取药水/遗物/技能名）。'
                    + '⚠ 图标素材就绪后走**已有**的 `icon` 列（图标资源路径），本列不改成路径',
            },
            { key: 'dispel_level', type: 'int', desc: '可驱散等级：0=不可驱散 1=普通 2=强 3=极强' },
            {
                key: 'desc', type: 'string',
                desc: '**状态说明**（2026-11 新增）：点 HUD 状态栏那一格时弹出的说明面板上写的那句话。'
                    + '留空 = 面板退化成一个通用句（「持续 N 秒 / 永久」+ 正面/负面）。'
                    + '⚠ 只对 `bar_show = 1`（可能出现在英雄状态栏上）的行有意义 —— 其余行玩家点不到。'
                    + '⚠ 正文框宽约 270px、字号 16：建议 ≤ 30 汉字，超了会换行（面板高度按两行预留）',
            },
            { key: 'duration', type: 'number', desc: '默认持续（秒），-1 = 永久', required: true },
            { key: 'cd', type: 'number', desc: '该效果自己的冷却（秒），0/留空 = 无冷却；带 cd 的被动各实例独立计时' },
            {
                key: 'stack_mode', type: 'enum', desc: '同名叠加方式', required: true,
                enumValues: ['none', 'refresh', 'stack', 'renew'],
            },
            { key: 'max_stack', type: 'int', desc: 'stack 模式层数上限' },
            { key: 'strongest_only', type: 'bool', desc: '最强互斥：同 id 只保留最强实例（1/0）' },
            {
                key: 'effects', type: 'json',
                desc: '原子效果列表 JSON（一个效果一件事）。例：'
                    + '[{"type":"modify_attr","attrs":[[3,14,"percent"]]}] 属性修改；'
                    + '[{"type":"modify_attr","attrs_var":"attrs"}] 属性与数值由施加方 kv.attrs 传入（共享模板用）；'
                    + '[{"type":"apply_state","state":"stunned"}] 状态；'
                    + '[{"type":"tick_damage","interval":1,"value":10,"damage_type":"magical"}] 周期伤害；'
                    + '[{"type":"tick_heal","interval":1,"value":20}]；'
                    + '[{"type":"tick_apply_modifier","interval":3,"modifier":1}]。'
                    + '叠加方式：percent=百分数(14=+14%,对基础属性) / add=固定值 / multiply=小数且复利',
            },
            { key: 'events', type: 'json', desc: '事件绑定 JSON，如 [{"event":"on_attack_landed","actions":[...]}]' },
            { key: 'script_id', type: 'string', desc: '复杂逻辑代码类名（逃逸口）' },
        ],
    },

    // ==================== relics：遗物表（一件遗物一行；局内 / 局外各一套效果） ====================
    //  局内局外是**同一件遗物**：id / name / icon / rarity 共用一套，
    //  只有 `modifiers_*` 与 `description_*` 分「局内版 / 局外版」两套（见 docs/配置规则_品质与词条门禁.md §1.1）。
    //  某件遗物在哪一侧出现，由 `scope` 说明；对应侧的列留空即表示没有那一版。
    {
        name: 'relics',
        label: '遗物表（一件一行 · 局内 + 局外）',
        format: 'array',
        jsonPath: `${JSON_DIR}/relics.json`,
        excelFile: 'relics.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '遗物ID（手工 demo 1~5 / 设计稿道具 1001~1293 / 仅局外 1294~1302）', required: true },
            { key: 'name', type: 'string', desc: '名称（局内局外是同一件遗物，共用一个名字）', required: true },
            { key: 'code', type: 'string', desc: '唯一英文代码（程序引用用；有局外版的取自原装备表，d2_*/d2n_*）' },
            { key: 'icon', type: 'string', desc: '图标资源路径（局内局外**共用**同一张图）' },
            {
                key: 'rarity', type: 'enum', desc: '品质 4 档（白/蓝/黄/红，**局内局外同一阶梯**）', required: true,
                enumValues: ['common', 'rare', 'epic', 'legendary'],
            },
            {
                key: 'scope', type: 'enum', required: true,
                desc: '作用域：inner=只有局内版（肉鸽商店抽取池）/ outer=只有局外版（跨局永久收集）/ both=两侧都有',
                enumValues: ['inner', 'outer', 'both'],
            },
            { key: 'category', type: 'string', desc: '局外分类 d2_basic / d2_upgrade / d2_neutral（只有局外版才填）' },
            {
                key: 'tags', type: 'stringarray',
                desc: '流派标签（1~3 个，**由设计真源的 tagsOf() 从钩子与属性推出来**，不手写）。'
                    + '词表与 abilities.tags / kill_buffs.tags **共用同一套 8 个词**：'
                    + '远程点杀 / 坦克反伤 / 物理暴击 / 法术爆发 / 召唤增殖 / 元素持续 / 经济成长 / 控制减速。'
                    + '⚠ 与 `category`（Dota2 来源分类）不是一回事 —— category 只有 37 件局外版有，且不可当流派用',
            },
            { key: 'description_inner', type: 'string', desc: '**局内版**效果描述（给玩家看；没有局内版则留空）' },
            {
                key: 'modifiers_inner', type: 'json',
                desc: '**局内版**永久 Modifier 列表 JSON，如 [{"modifier":1000,"kv":{"attrs":[[3,14,"percent"]]}}]。'
                    + '纯属性加成统一引用「属性修改」共享模板 id=1000，属性与数值写在 kv.attrs（不加新模板）',
            },
            { key: 'description_outer', type: 'string', desc: '**局外版**效果描述（没有局外版则留空）' },
            {
                key: 'modifiers_outer', type: 'json',
                desc: '**局外版**永久 Modifier 列表 JSON（口径同上；局外是跨局永久加成，**只给固定值 add**）。'
                    + '⚠ 形状（给哪几条属性）由局内身份决定、数值由品质预算决定，生成器 `scripts/gen-relics-outer.mjs`，'
                    + '规则真源 `scripts/lib/relic-outer-design.mjs`；比例型属性（攻速/暴击/闪避/魔抗…）一律不给',
            },
            {
                key: 'effects_outer', type: 'json',
                desc: '**局外版的「局内开局初始值」**（只有红件填，一件一条）：`[{"code":"run_start_gold","value":10}]`，'
                    + '`code` 取自 `common/AchievementEffectMeta.ts` 的 `ACH_EFFECT_CODES`（红件词缀与成就 / 增益券**共用同一套 code 与封顶**）。'
                    + '⚠ 它不是 Modifier —— 由 `Scene_Game_Stage.snapshotAchieveEffects()` 在开局快照里读走，'
                    + '写成 Modifier 会变成"战斗里挂一个没人读的被动"',
            },
            { key: 'script_id', type: 'string', desc: '复杂遗物逻辑代码类名（逃逸口；局内局外共用一行）' },
        ],
    },

    // ==================== （equipments 表已并入 relics：同一件遗物的局外版） ====================

    // ==================== （shop_skills 表已并入 abilities：同一张技能表，靠 scope 区分归属） ====================

    // ==================== kill_buffs：**神器**表（局内击杀数商店；名字沿用旧称，见 docs/artifact-drop/README.md） ===
    {
        name: 'kill_buffs',
        label: '神器表（击杀数商店 · 永久可叠层）',
        format: 'array',
        jsonPath: `${JSON_DIR}/kill_buffs.json`,
        excelFile: 'kill_buffs.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '神器 ID', required: true },
            { key: 'code', type: 'string', desc: '唯一代码（英文，程序引用用）', required: true },
            { key: 'name', type: 'string', desc: '名称', required: true },
            {
                key: 'icon', type: 'string',
                desc: '图标资源路径（`textures/artifacts/<code>`，resources 相对、**不带扩展名**）。'
                    + '2026-11 补齐：出图 → `make-delivery.py` → `build-atlas.py` 打成 `textures/artifacts/artifacts.plist`，'
                    + '**帧名就是本行的 `code`**；写法与遗物 / 技能图标完全一致（见 docs/artifact-buff-icons/README.md）。'
                    + '⚠ 留空 = 摊位 `content/head/inner` 什么都不画（那张占位图已随遗物图集一起退场）',
            },
            {
                key: 'stat', type: 'enum', required: true,
                desc: '作用属性；special = **机制型**（天怒/波次补给/战地急救/滚雪球）—— 属性列表达不出来，'
                    + '效果写在 modifiers 列（引用有 script_id 的 Modifier 行），实现在 battle/SpecialBuffs.ts',
                enumValues: ['atk', 'hp', 'range', 'def', 'aspd', 'crit', 'dodge', 'regen', 'special'],
            },
            { key: 'attr_id', type: 'int', desc: '对应 AttributeType 编号（atk=3 / hp=1 / range=16 / def=6 / aspd=4 / crit=14 / dodge=8 / regen=9；stat=special 留空）' },
            { key: 'per', type: 'number', desc: '每层加成（百分比整数：8 = +8%，0.6 = +0.6%），special 型填 0（数值全在 modifiers[].kv）' },
            { key: 'per_desc', type: 'string', desc: '每层效果原文 —— ⚠ **会显示在商店格子上**，随层数变化的部分要写全（如「（每层 +50%）」）' },
            { key: 'max_stack', type: 'int', desc: '层数上限；**已满层的神器不再进摊位**（见 BuffShop.pool）' },
            { key: 'price', type: 'int', desc: '首层价格（击杀数）' },
            { key: 'price_growth', type: 'number', desc: '同一件**每买一层**的价格系数（1.35 = 每层 ×1.35）；与「刷新费阶梯」是两回事' },
            { key: 'tags', type: 'stringarray', desc: '流派标签' },
            {
                key: 'modifiers', type: 'json',
                desc: '**机制型专用**（stat=special）：效果引用的 Modifier 列表 JSON，写法同 relics.modifiers_inner。'
                    + '例如 [{"modifier":240,"kv":{"killsPer":10,"boomPct":200,"boomPctPerStack":50}}]。'
                    + '⚠ 被引用的行**必须有 script_id**（否则挂了也没有任何行为）；'
                    + '⚠ 这里不写 duration（神器一律永久）、也不写 stack（当前层数由 BuffShop 注入）；'
                    + '⚠ 属性型神器**留空**（属性走 attr_id / per，不在这里配）',
            },
            { key: 'note', type: 'string', desc: '设计备注（上限/叠加说明）' },
        ],
    },

    // ==================== battle_items：局内掉落 Buff 表（**可用道具**，装进 6 格小背包） ====================
    //  ⚠ 与 `kill_buffs`（**神器**：永久、可叠层、花击杀数买）是**两条轨**，别混：
    //     · 神器 = 构筑决策（抽到什么就永久变强）；
    //     · 本表 = 操作决策（**什么时候按**）—— 捡到不生效，玩家点格子才生效，一次性消耗
    //       （绝大多数**限时**，一条 `duration = 0` 即刻生效）。
    //  口径见 docs/artifact-drop/README.md。
    //  ⚠ 与 `bag_items`（**局外**背包 80 格、跨局、全屏页）也不是一回事。
    {
        name: 'battle_items',
        label: '局内掉落 Buff 表（可用道具）',
        format: 'array',
        jsonPath: `${JSON_DIR}/battle_items.json`,
        excelFile: 'battle_items.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '道具 ID', required: true },
            { key: 'code', type: 'string', desc: '唯一代码（英文，程序引用用）', required: true },
            { key: 'name', type: 'string', desc: '名称', required: true },
            { key: 'desc', type: 'string', desc: '一句话效果（飘字 / 背包 tooltip 用）', required: true },
            { key: 'icon', type: 'string', desc: '图标资源路径（HUD 背包格子用；本批不接 UI，先留空）' },
            {
                key: 'rarity', type: 'enum', desc: '品质（决定展示色；掉落权重另由 weight 决定）', required: true,
                enumValues: ['common', 'rare', 'epic', 'legendary'],
            },
            { key: 'weight', type: 'int', desc: '掉落权重（留空按 1）；同一池子里按权重随机' },
            {
                key: 'duration', type: 'number', required: true,
                desc: '效果时长（秒）。`> 0` = 限时（本表绝大多数）；`= 0` = **即刻生效**'
                    + '（施加那一帧就结算完、不留状态，现只有「血包」一条）—— 两种都要真配。'
                    + '⚠ 不要给「最大生命」这类上限类属性：上限回落而当前生命不回落会出现 hp > maxHp 的脏数据',
            },
            {
                key: 'modifiers', type: 'json',
                desc: '生效时施加到**英雄**身上的 Modifier 列表 JSON，写法同 relics.modifiers_inner。'
                    + '例如 [{"modifier":6,"kv":{}}] = 无敌（mod 6 是现成的 apply_state invulnerable）；'
                    + '纯属性走共享模板 1000：{"modifier":1000,"kv":{"attrs":[[3,60,"percent"]]}}。'
                    + '时长由**本行的 duration** 统一注入，条目里不用再写 duration',
            },
            { key: 'tags', type: 'stringarray', desc: '流派标签（与 abilities / kill_buffs / relics 共用一套 8 个词）' },
            { key: 'note', type: 'string', desc: '设计备注' },
        ],
    },

    // ==================== shop_draw：肉鸽品质抽取概率表 ====================
    {
        name: 'shop_draw',
        label: '肉鸽品质抽取概率表',
        format: 'array',
        jsonPath: `${JSON_DIR}/shop_draw.json`,
        excelFile: 'shop_draw.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '档位ID', required: true },
            { key: 'band', type: 'string', desc: '档位说明（英雄等级段）', required: true },
            { key: 'level_min', type: 'int', desc: '英雄等级下限（含）', required: true },
            { key: 'level_max', type: 'int', desc: '英雄等级上限（含）', required: true },
            { key: 'common', type: 'number', desc: '白（普通）权重 %', required: true },
            { key: 'rare', type: 'number', desc: '蓝（稀有）权重 %', required: true },
            { key: 'epic', type: 'number', desc: '黄（史诗）权重 %', required: true },
            { key: 'legendary', type: 'number', desc: '红（传说）权重 %', required: true },
            { key: 'upgrade_chance', type: 'number', desc: '越阶概率 %：抽到 stage > 当前阶段 的下一阶段内容的概率（详见 shop_constants.stageMaxByPhase）' },
        ],
    },

    // ==================== shop_constants：肉鸽商店常量（KV 表） ====================
    {
        name: 'shop_constants',
        label: '肉鸽商店常量表',
        format: 'kv',
        jsonPath: `${JSON_DIR}/shop_constants.json`,
        excelFile: 'shop_constants.xlsx',
        primaryKey: 'key',
        fields: [
            { key: 'key', type: 'string', desc: '常量名（程序内 ShopConfig.getNumber/getArray 使用）', required: true },
            { key: 'value', type: 'anyvalue', desc: '常量值：数字 / 字符串 / 数组（[1,2,3,4]）/ 对象（{"common":60}）', required: true },
            { key: 'desc', type: 'string', desc: '中文说明（仅表格辅助列，不导出）', meta: true },
        ],
        kvDesc: {
            optionCount: '每次抽取展示的选项数（道具 + 技能混合池）',
            pickCount: '每次抽取可选择的选项数（选 1 后其余置灰，只能再次付费抽取）',
            drawCostBase: '首次抽取费用（金币）',
            drawCostStep: '每次抽取后的费用增量（金币）',
            drawCostCap: '抽取费用上限（金币）；到达后保持不再增长（0 = 不封顶）',
            drawCostResetEachPhase: '是否每阶段重置抽取次数（1=重置回 drawCostBase，0=整局累计）',
            stageMaxByPhase: '各阶段可抽取的最高 stage（数组，索引 0 = 阶段 1）；越阶判定见 shop_draw.upgrade_chance',
            skillMaxPerDraw: '每次抽取里的技能选项数上限（0~2：抽到的技能个数不会超过它；0 = 永不出技能）',
            skillDrawChance: '每次抽取「出技能」的概率 %（默认 20 = 20% 有技能 / 80% 一个技能都不出）；品质概率不受它影响',
            skillCountWeight: '出技能时抽到几个的权重（{"1":70,"2":30} = 1 个 70% / 2 个 30%；只认 1 ~ skillMaxPerDraw 的键，未配即 1 个）',
            duplicateSkillUpgrade: '抽到已拥有技能时是否转为升级（1=是，满级后不可选；0=不可选）',
            maxSkillSlots: '技能槽上限（技能型选项超过该数量后不可再选新技能）',
            adFreeDrawEnabled: '是否开放「看广告免费抽一次」（1=开放）',
            adFreeDrawPerRun: '每局广告免费抽取次数上限',
            adExtraPickEnabled: '是否开放「看广告额外选 1 个」（1=开放；在本次已置灰的选项中再选 1 个）',
            adExtraPickCount: '广告额外可选的选项数',
            adRefreshEnabled: '是否开放「看广告免费刷新本次抽取」（1=开放，重抽但选项数不变）',
            killBuffPriceGrowth: '神器默认价格系数（**同一件每买一层**的价格 ×；单个神器的 price_growth 优先）',
            killBuffMaxStackDefault: '神器默认层数上限（单个神器的 max_stack 优先）',
            killBuffRefreshCost: '击杀商店（神器）刷新一次摊位的**首次**费用（单位 = **击杀数**，不是金币；金币只用于选英雄刷新与遗物抽取）',
            killBuffRefreshCostStep: '神器**付费刷新**每次递增的费用（击杀数）；免费刷新 / 广告刷新**不递增**（见 docs/artifact-drop/README.md §12）',
            killBuffRefreshCostCap: '神器单次刷新费用上限（击杀数）；到达后保持不再增长（0 = 不封顶）。⚠ 刷新**次数**本身不封顶，封的只是单价',
            killBuffFreeRefreshPerRun: '每局**开局白送**的神器免费刷新次数（不花击杀数、也不抬高后续单价）；0 = 不白送',
            killBuffRefreshAdFreePerRun: '每局神器的「看广告免费刷新」次数（同样不抬高单价）；0 = 关掉这条通道。'
                + '⚠ 这个键原先只在代码里当默认值（1），配表里没有 ⇒ 设计者改不动，2026-11 补上',
            heroSelectRefreshCost: '选英雄面板刷新一次候选的费用（金币）',
        },
    },

    // ==================== mall_items：局外商城商品表 ====================
    //  ⚠ 与 shop_constants / shop_draw / kill_buffs（**局内**肉鸽商店）不是一回事：
    //   这一张是**局外全屏商城**的商品（入口 = 主界面底部「商城」页签 + 顶栏三格的「+」），
    //   卖的全是**既有资源的加速**（金币 / 通用英雄经验 / 账号经验 / 抽取次数 / 券），
    //   一律靠**激励视频**获得，外加每天 1 次不看广告的「每日补给」（kind = free）。
    //   口径真源：docs/shop/README.md §2（卖什么 / 给多少 / 为什么）；数值依据在同文件 §2.0。
    //  ⚠ 局内那套经济（金币只给选英雄刷新 + 遗物抽取、击杀数只给击杀商店）与本表**互不相干**，
    //   本表发的金币进 `ItemData.currencies.gold`（局外金币），不是 `hero.gold`。
    {
        name: 'mall_items',
        label: '局外商城商品表',
        format: 'array',
        jsonPath: `${JSON_DIR}/mall_items.json`,
        excelFile: 'mall_items.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '商品ID', required: true },
            { key: 'key', type: 'string', desc: '商品标识（= 代码里的 ShopItemKey：gold/hero_exp/acc_exp/relic_draw/boost/ad_ticket，每日补给是 daily_free）；界面按它回推是哪一个格子', required: true },
            {
                key: 'kind', type: 'enum', required: true,
                desc: '获取方式：free = 每日免费（不看广告，每天 1 次）/ ad = 看一次激励视频领一份',
                enumValues: ['free', 'ad'],
            },
            { key: 'name', type: 'string', desc: '商品名（写入格子的 name 标签）', required: true },
            { key: 'subtitle', type: 'string', desc: '副标题（写入格子的 sub 标签；留空 = 该格不写 sub）' },
            { key: 'amount_text', type: 'string', desc: '数量文案（写入格子的 amount 标签，如「+300 金币」）' },
            { key: 'grants', type: 'json', desc: '发放内容（**一项一件**）：[{"type":"gold","amount":300}]；type = gold|hero_exp|acc_exp|relic_draw|boost|ad_ticket', required: true },
            { key: 'daily_limit', type: 'int', desc: '每日次数上限（每日补给填 1；0 = 不限）', required: true },
            { key: 'placement', type: 'string', desc: '广告位标识（kind=ad 必填，原样传给 AdMgr.showRewardVideo 做埋点；free 商品留空）' },
            { key: 'sort', type: 'int', desc: '排序（升序；决定界面上格子的先后）' },
        ],
    },

    // ==================== bag_items：通用道具表（局外背包） ====================
    //  一行一件「玩家可能持有的道具」—— 背包（`prefabs/ui/views/bag/View_Bag`）照着它铺格子：
    //  格子的图标 / 名字 / 描述 / 品质底框色 / 堆叠上限**全部来自本表**，代码里不写死任何一件道具。
    //  ⚠ 本表是**道具字典**（长什么样、叫什么），**不是存量**：存量在存档模块 `data/funcs/BagData.ts`
    //    （按 `key` 记数量）。两者靠 `key` 对上 —— 表里删一行 = 背包里那一格立刻消失（存量还在存档里）。
    //  ⚠ 与 `relics` 表（遗物，id 1001~1302）**不是一回事**：遗物有自己的表与页面（左侧「遗物」页），
    //    不进背包；背包装的是券 / 次数这类**可堆叠的持有物**。
    //  口径真源：`docs/bag/README.md`。
    {
        name: 'bag_items',
        label: '通用道具表（局外背包）',
        format: 'array',
        jsonPath: `${JSON_DIR}/bag_items.json`,
        excelFile: 'bag_items.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '道具ID（1001 起，一件一行）', required: true },
            {
                key: 'key', type: 'string', required: true,
                desc: '唯一标识（**代码与存档按它记账**）：ad_ticket / outer_draw_ticket / boost_<成就效果code>',
            },
            { key: 'name', type: 'string', desc: '道具名（详情面板第一行；**≤ 8 个汉字**，详情面板的 name 框 200×38 / fs24 是 CLAMP，长了会被裁字）', required: true },
            {
                key: 'desc', type: 'string',
                desc: '一句话说明（详情面板正文第一行；**≤ 12 个汉字** —— 正文框 200×64 / fs16 只放得下两行、每行约 12 字）',
            },
            {
                key: 'use_hint', type: 'string',
                desc: '「为什么不能手动用 / 怎么生效」那一行（详情面板正文第二行，**≤ 12 个汉字**；'
                    + '`effect_code` 非空的行这一行会被效果文案顶掉）',
            },
            { key: 'icon', type: 'string', desc: '图标资源路径（resources 相对、**不带扩展名**；留空 = 保留预制件占位图，别填不存在的路径）' },
            {
                key: 'rarity', type: 'enum', required: true,
                desc: '品质（决定格子底框色；色值唯一真源 `game/common/RelicRarityColor.ts`）',
                enumValues: ['common', 'rare', 'epic', 'legendary'],
            },
            { key: 'stack_max', type: 'int', desc: '单格堆叠上限（**0 = 不限**；超上限时 `BagData.addItem` 拒绝，不会静默吞掉）', required: true },
            { key: 'usable', type: 'bool', desc: '能不能手动点「使用」（0 = 按钮置灰；本期全部 0 —— 这些道具都是入局/抽取时自动抵扣）', required: true },
            { key: 'sellable', type: 'bool', desc: '能不能「出售」（0 = 按钮置灰；本期全部 0 —— 本项目金币是抽取燃料，不开回收口）', required: true },
            { key: 'sell_price', type: 'int', desc: '出售单价（局外金币；`sellable=0` 时无意义，填 0）' },
            { key: 'expire_hours', type: 'number', desc: '有效期（小时；**0/留空 = 永久** → 格子不显示倒计时。当前全部永久，倒计时那条路径见 BagItem）' },
            {
                key: 'effect_code', type: 'enum',
                desc: '**增益券专用**：这张券对应哪条成就效果（`boost_*` 行必填，其它行留空）',
                enumValues: [
                    'run_start_gold', 'run_start_kill_points', 'shop_option_plus', 'shop_draw_discount', 'ad_free_draw',
                    'kill_buff_discount', 'gold_gain_bonus', 'battle_exp_bonus', 'hero_start_level',
                    'hero_select_free', 'relic_start_gift',
                ],
            },
            { key: 'sort', type: 'int', desc: '排序（升序；决定背包里格子的先后）', required: true },
        ],
    },

    // ==================== tasks：任务表（日/周任务，完成后发账号经验 + 金币） ====================
    //  奖励口径（2026-09 改）：**不再由对局结束统一发放**，而是「完成任务 → 领奖」时发
    //  （账号经验进 DataCenter.playerInfo / 金币进 DataCenter.itemData.Gold）。
    //  对局只负责上报进度：击杀 / 通关 / 阶段 / 英雄等级…见 `game/data/funcs/TaskData.ts` 的 TargetMode。
    {
        name: 'tasks',
        label: '任务表（日/周）',
        format: 'array',
        jsonPath: `${JSON_DIR}/tasks.json`,
        excelFile: 'tasks.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '任务ID（日任务 1001 段 / 周任务 2001 段）', required: true },
            {
                key: 'type', type: 'enum', required: true,
                desc: '任务类型：决定重置周期与所在页签（daily=每日 0 点重置 / weekly=每周一重置）',
                enumValues: ['daily', 'weekly'],
            },
            { key: 'name', type: 'string', desc: '任务名（列表项标题）', required: true },
            { key: 'desc', type: 'string', desc: '任务描述（列表项副标题，可换行 \\n）' },
            {
                key: 'target', type: 'enum', required: true,
                desc: '完成条件（程序按它把对局事件换算成进度；模式见 TaskData.TargetMode）',
                enumValues: [
                    'login', 'play_games', 'victory', 'kill_enemies', 'gold_earned', 'spend_gold',
                    'relics_picked', 'skills_used', 'buffs_bought', 'stage_reached', 'hero_level', 'level_reached',
                ],
            },
            { key: 'param', type: 'string', desc: '条件参数（预留：如指定英雄/关卡 id，留空 = 不限）' },
            { key: 'count', type: 'int', desc: '目标数量（进度 ≥ count 即可领奖）', required: true },
            { key: 'reward_exp', type: 'int', desc: '奖励·**账号经验**（进 PlayerInfo，升级判定见等级表）', required: true },
            { key: 'reward_gold', type: 'int', desc: '奖励·**金币**（进 ItemData.currencies.gold）', required: true },
            { key: 'unlock_level', type: 'int', desc: '解锁所需账号等级（留空/1 = 不限制；高于当前等级的任务不展示）' },
            { key: 'sort', type: 'int', desc: '同页签内排序（升序）' },
        ],
    },

    // ==================== achievements：成就表（一次性永久目标，分档给金币 + 特殊效果） ====================
    //  与 tasks 的分工（设计稿 `docs/成就系统设计.md`）：
    //    · tasks = 日/周**周期性**任务，奖励账号经验 + 金币，周期到了会重置；
    //    · achievements = **一次性永久**目标，奖励金币，**核心成就的末档**额外给 1 个特殊效果。
    //  **一行 = 一档**（不是一行一成就）：同一条成就的多档用 `group` 串起来，
    //  好处是每档能写各自的 `count` / `param` / `desc` / `reward_gold` / `effect_code`，
    //  且"已领到第几档"天然是一个游标。
    //  id 段位：31xx 等级 / 32xx 闯关 / 33xx 战斗 / 34xx 经济 / 35xx 收集 / 36xx 挑战（段内顺序编号）。
    //  ⚠ **档位数不固定**（2026-11 起）：以前恰好 3 档（铜/银/金），现在按成长空间定 ——
    //  账号等级 20 档（每 5 级一阶直到 100 级）/ 收集类 6~7 档 / 通关类 5~6 档，
    //  界面文案相应改成「阶段N」。全表由 `scripts/gen-achievements.mjs` 生成（设计真源在那个脚本里）。
    //  门禁（运行时 `AchievementCfgContainer.afterHandle` 告警 + `npm run audit:achieve` 硬校验）：
    //  同 group 的 tier 从 1 连续、count 与 reward_gold 严格递增、
    //  `effect_code` **只允许出现在该 group 的最大 tier**、同一 effect_code 全表最多 1 个来源、
    //  `run_*` 型必须写正整数 `param`。
    {
        name: 'achievements',
        label: '成就表',
        format: 'array',
        jsonPath: `${JSON_DIR}/achievements.json`,
        excelFile: 'achievements.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '成就ID（31xx 等级 / 32xx 闯关 / 33xx 战斗 / 34xx 经济 / 35xx 收集 / 36xx 挑战）', required: true },
            { key: 'group', type: 'string', desc: '成就组（**同一条成就的多档共用**，如 st_clear；程序按它归并成一条展示）', required: true },
            { key: 'tier', type: 'int', desc: '档位序号（**1 起、组内连续**；界面文案 = 「阶段N」，**档位数不限**：账号等级 20 档 / 收集类 6~7 档）', required: true },
            {
                key: 'category', type: 'enum', required: true,
                desc: '分类（界面页签）',
                enumValues: ['level', 'stage', 'combat', 'economy', 'collect', 'challenge'],
            },
            { key: 'name', type: 'string', desc: '成就名（同一 group 的各行写同一个名字）', required: true },
            { key: 'desc', type: 'string', desc: '成就描述（**逐档可不同**，卡面显示的是「下一档」那一行；⚠ 卡面只有 2 行位置 ≈ ≤26 个汉字宽）' },
            { key: 'icon', type: 'string', desc: '图标资源路径（textures/achievements/<group>，不带扩展名）；空 = 回落占位图' },
            {
                key: 'target', type: 'enum', required: true,
                desc: '完成条件（程序按它把对局事件换算成进度；模式见 docs/成就系统设计.md §3.3）',
                enumValues: [
                    // 与 tasks 共用的 12 个
                    'login', 'play_games', 'victory', 'kill_enemies', 'gold_earned', 'spend_gold',
                    'relics_picked', 'skills_used', 'buffs_bought', 'stage_reached', 'hero_level', 'level_reached',
                    // 成就新增（累计 / 峰值 / 标记）
                    'level_up_count', 'login_streak', 'survive_time', 'kill_in_run', 'gold_in_run',
                    'clear_no_damage', 'clear_fast', 'clear_low_hp', 'run_no_relic_clear', 'clear_one_skill',
                    'damage_dealt', 'crit_hits', 'draw_count', 'relic_collected', 'buff_types', 'skills_picked',
                    // 成就新增·「门槛 × 局数」（**计数单位是「局」**，门槛写在 param；见 ACH_RUN_TARGETS）
                    'run_stage', 'run_hero_level', 'run_kill', 'run_gold', 'run_survive',
                ],
            },
            { key: 'param', type: 'string', desc: '条件参数：`run_*` 型 = **门槛**（正整数：阶段数/等级/击杀数/金币/秒），其余类型留空（容器会对漏填/错填告警）' },
            { key: 'count', type: 'int', desc: '目标数量（累加型 = 累计到这么多；峰值型 = 达到这么多），必须 > 0', required: true },
            { key: 'reward_gold', type: 'int', desc: '奖励·**局外金币**（进 ItemData.currencies.gold；**不发账号经验**）', required: true },
            {
                key: 'effect_code', type: 'enum',
                desc: '**特殊效果**标识（只允许出现在该 group 的最大 tier 上；留空 = 该档纯金币）',
                enumValues: [
                    'run_start_gold', 'run_start_kill_points', 'shop_option_plus', 'shop_draw_discount', 'ad_free_draw',
                    'kill_buff_discount', 'gold_gain_bonus', 'battle_exp_bonus', 'hero_start_level',
                    'hero_select_free', 'relic_start_gift',
                ],
            },
            { key: 'effect_value', type: 'int', desc: '效果数值（effect_code 非空时必填；百分比类填**百分数**：10 = 10%）' },
            { key: 'silent', type: 'int', desc: '1 = 隐藏成就（达成前不展示）；缺省 0' },
            { key: 'sort', type: 'int', desc: '同分类内排序（升序）' },
        ],
    },

    // ==================== player_levels：账号等级表 ====================
    //  等级经验口径的唯一来源（替代 battle_constants 里的 playerExpFormulaBase/Ratio 公式）：
    //  `exp` = 从本级升到下一级所需经验；满级行的 `exp` 填 0（不再升级）。
    //  与等级挂钩的口子都放这里（升级金币奖励 / 解锁的功能标识），后续新功能加列即可。
    {
        name: 'player_levels',
        label: '账号等级表',
        format: 'array',
        jsonPath: `${JSON_DIR}/player_levels.json`,
        excelFile: 'player_levels.xlsx',
        primaryKey: 'id',
        fields: [
            { key: 'id', type: 'int', desc: '**等级**（1 起，主键；与 PlayerInfo.level 对应）', required: true },
            { key: 'exp', type: 'int', desc: '从本级升到下一级所需经验（**0 = 满级**，满级后经验不再累积）', required: true },
            { key: 'reward_gold', type: 'int', desc: '升到本级时发放的一次性金币奖励（1 级通常为 0）' },
            {
                key: 'unlock_features', type: 'stringarray',
                desc: '该等级解锁的功能标识（程序用 LevelConfig.hasFeature(level, code) 判定；空 = 无新解锁）',
            },
            { key: 'desc', type: 'string', desc: '等级展示文案（如「解锁：每周任务」，可留空）' },
        ],
    },

    // ==================== battle_constants：全局常量（KV 表） ====================
    {
        name: 'battle_constants',
        label: '战斗常量表',
        format: 'kv',
        jsonPath: `${JSON_DIR}/battle_constants.json`,
        excelFile: 'battle_constants.xlsx',
        primaryKey: 'key',
        fields: [
            { key: 'key', type: 'string', desc: '常量名（程序内 BattleConstUtil.getNumber/getString 使用）', required: true },
            { key: 'value', type: 'anyvalue', desc: '常量值：数字 / 字符串 / 数组（[1,5,12,20]）', required: true },
            { key: 'desc', type: 'string', desc: '中文说明（仅表格辅助列，不导出）', meta: true },
        ],
        kvDesc: {
            defenseFormula: '防御减伤公式（字符串，代码未消费，仅记录）',
            minDamage: '最小伤害（伤害下限）',
            critRateCap: '暴击率上限（0.6=60%）',
            critDmgBase: '基础暴击倍率（0.5=额外50%）',
            dodgeCap: '闪避上限（0.4=40%）',
            atkSpeedCap: '攻速上限（倍率，3.0=300%）',
            atkRangeCap: '攻击距离上限（米）',
            shadowKillThreshold: '残血斩杀阈值（血量低于该比例触发）',
            levelSuppressThreshold: '等级压制阈值（等级差达到该值开始压制）',
            levelSuppressRatePerLevel: '每级压制伤害系数（0.03=3%/级）',
            freezeStunDuration: '冰冻满层转眩晕时长（秒）',
            freezeMaxStacks: '冰冻最大层数',
            freezeSlowPerStack: '每层冰冻减速（0.2=20%）',
            burnDmgRatio: '燃烧伤害系数',
            poisonDmgRatio: '中毒伤害系数',
            equipSlotCount: '局外装备槽位数量',
            initialEnergy: '初始能量',
            initialHp: '初始生命',
            initialGold: '初始金币',
            initialStamina: '初始体力',
            maxItemSlots: '道具格上限',
            initialPhase: '初始阶段序号',
            heroExpFormulaBase: '英雄升级经验基数',
            heroExpFormulaRatio: '英雄升级经验系数',
            heroUnlockCostBase: '英雄解锁·金币基准价（英雄列表里**序号最靠前**的那位；默认解锁的英雄不消耗）',
            heroUnlockCostGrowth: '英雄解锁·每靠后一位的涨价系数（按 units.json 英雄条目 id 升序的序号：价 = 基准 × 系数^序号）',
            heroLevelUpGoldBase: '英雄升级（Lv.1→2）所需金币',
            heroLevelUpGoldRatio: '英雄升级·每级涨价系数（Lv.N→N+1 消耗 = 基数 × 系数^(N-1)）',
            playerExpFormulaBase: '玩家升级经验基数（⚠ 等级经验现在以 player_levels 等级表为准，本值只在等级表不可用时回落）',
            playerExpFormulaRatio: '玩家升级经验系数（⚠ 同上：等级表不可用时的回落值）',
            battleExpFormulaBase: '局内升级经验基数',
            battleExpFormulaRatio: '局内升级经验系数',
            // ⚠ 这里**没有** `battleLevelMax`：局内英雄等级不封顶（2026-11 用户口径
            //   「取消等级限制，以前是 30 级」）—— 这个键连同行一起从表里删掉了。
            //   想再加回上限，请连 `Scene_Game_Stage.addBattleExp` 的 while 条件一起改，
            //   并想清楚"后期经验白吃"这条（见该方法的注释）。
            clearRewardPlayerExpBase: '通关奖励·玩家经验基数（⚠ 已无消费方：奖励改为「完成任务发放」，见 tasks.json）',
            clearRewardHeroExpBase: '**一局结算·通用英雄经验基数**（键名里的 clear 是历史读法：2026-11 起它不是"通关才发"那个数，而是「阶段 × 时间」加权后的**满额**。口径真源 = assets/scripts/game/common/RunClearHeroExp.ts 的文件头；通关约等于满额 ⇒ 80 与旧口径"通关固定 80"逐字相同）',
            enemyDropExpDefault: '怪物掉落经验默认值',
            enemyDropGoldDefault: '怪物掉落金币默认值',
            rewardTimeBasePerSec: '时间通胀系数（每秒）',
            rewardTimeCap: '时间通胀上限',
            rewardBossGoldBonus: '经济BOSS·金币加成',
            rewardBossExpBonus: '经济BOSS·经验加成',
            projectileSpeedDefault: '弹道默认速度（像素/秒）',
            projectileMaxDistDefault: '弹道默认最大距离（像素）',
            collisionDetectThreshold: '碰撞检测阈值',
            collisionRadiusDefault: '默认碰撞半径（像素）',
            separationStrength: '单位分离强度',
            aiIdleWaitTime: 'AI 待机等待时间（秒）',
            aiAttackRangeDefault: 'AI 默认攻击距离（米）',
            aiChaseBufferRatio: 'AI 追击缓冲比例',
            aiAttackSpeedDefault: 'AI 默认攻速',
            phaseDefaultRemainingTime: '阶段默认剩余时间（秒）',
            skillSlotCount: '技能槽数量',
            skillSlotUnlockLevels: '技能槽解锁等级（数组）',
            pxPerMeter: '1 米 = 多少像素（距离换算口径：设计稿/文案里的 m × 本值 = 配表像素，用于击退/牵引等位移）',
            outerDrawCostBase: '局外遗物抽取·当天第一次抽取的价格（金币；每天 0 点重置回本值）',
            outerDrawCostStep: '局外遗物抽取·每付费抽一次涨多少（当天第 N 抽 = 基数 + 步长 × (N-1)，付费才涨；抽券不涨）',
            outerDrawCostCap: '局外遗物抽取·当天单抽价格封顶（0 = 不封顶；十连 = 接下来 10 抽价格逐个累加）',
            runClearGoldBase: '一局打完发的局外金币·**第 1 局**的曲线值（口径真源 = `assets/scripts/game/common/RunClearReward.ts` 的文件头；只算"真正打完一局"，中途退出不发）',
            runClearGoldDecay: '一局打完发的局外金币·**每往后一局的衰减系数**（0.6 = 每局只剩 60%；到 floor 就停）',
            runClearGoldFloor: '一局打完发的局外金币·曲线下限（衰减到这里不再降 —— 这就是"头几局高、后面很少"的那个"很少"）',
            runClearGoldStageDivisor: '一局打完发的局外金币·完成系数分母（到达第几阶段算打满；3 = 阶段 1/2/3+ 分别给 1/3、2/3、满额。用来堵"反复开局送死刷金币"）',
            runHeroExpWeightStage: '**一局结算·英雄经验**·阶段维度的权重（现 0.6；与下一行之和 = 1。口径真源 = assets/scripts/game/common/RunClearHeroExp.ts 的文件头，**胜负都发**、不是只有通关）',
            runHeroExpWeightTime: '一局结算·英雄经验·**时间维度**的权重（现 0.4；两个维度是**相加**不是相乘 —— 打得快与打得久各自都能换经验）',
            runHeroExpStageFull: '一局结算·英雄经验·阶段**打满**的档位（现 5 = 打到 Boss 阶段就满；阶段进度 = 到达阶段 ÷ 本值，夹 0~1）',
            runHeroExpTimeFull: '一局结算·英雄经验·时间**打满**的秒数（现 600 = 存活 10 分钟就满；时间进度 = 存活秒数 ÷ 本值，夹 0~1）',
            runHeroExpMin: '一局结算·英雄经验·**保底下限**（现 8：真正打完一局就有，准备期阵亡也给；这一对上下限就是用户口径「给一个范围」）',
            runHeroExpMax: '一局结算·英雄经验·**单局上限**（现 1600；难度 100 档满额 ≈ 80 × 17.96 ≈ 1437，所以正常玩法够不到封顶，它只兜底配表被调歪）',
            settleAdMulMin: '结算面板「看广告翻倍」·**倍率下限**（现 1.0；倍率在面板弹出时就掷好并画在按钮上，配 1.0 表示允许出现"这一档没赚头"，见 common/RewardAdBonus 口径 ①）',
            settleAdMulMax: '结算面板「看广告翻倍」·**倍率上限**（现 3.0；用户口径「看广告给 1~3 倍的奖励」）',
            settleAdMulDecimals: '结算面板「看广告翻倍」·**小数位数**（现 1 = 用户口径「可以有一位小数」；倍率按档位掷，保证掷出来的数逐字节等于显示的「×2.3」）',
            shopAdDailyTotalLimit: '局外商城·每日广告总次数上限（跨商品共用一本账，界面底部「今日广告 N/14」）',
            reviveAdPerRun: '局内·**每局**「看广告复活」的次数上限（0 = 关掉这一条：英雄阵亡时只认背包里的局内复活券；复活券本身能用几次由背包存量决定，不受本键约束）',
            shopAdCardNeedWatches: '局外商城·免广告卡需要累计观看的广告次数（攒满即可领；= 每日上限 × 期望天数）',
            shopAdCardHours: '局外商城·免广告卡生效时长（小时；生效期间局内那两个广告位不再拉起广告）',
            shopStreakMuls: '局外商城·每日补给的连续登录加成（**下标 = 连续天数 - 1**：`[1,1,1.5,1.5,1.5,1.5,2]` = 1~2 天 ×1 / 3~6 天 ×1.5 / ≥7 天 ×2；超出长度按最后一项）',
            shopStreakGiftDay: '局外商城·每日补给在连续登录达到该天数时额外送券（0 = 不送）',
            shopStreakGiftTickets: '局外商城·上面那条额外送的本局增益券张数',
            shopBoostTicketValues: '局外商城·**本局增益券**（A5）每种效果一张券给多少：`{"run_start_gold":50,…}`，键 = `achievements.effect_code` 的 11 个候选取值之一（2026-11 起含 `run_start_kill_points`），值 = **一张券折算的效果数值**（百分比类填百分数，如 10 = 10%）；券的合计仍受 `AchievementEffectMeta` 的 `cap` 约束（已达 cap 的效果不再发券）',
        },
    },
];

/** 按表名取表定义 */
export function getTable(name: string): TableSchema | undefined {
    return TABLES.find(t => t.name === name);
}

/** 表的主键字段定义 */
export function primaryField(t: TableSchema): FieldDef {
    const f = t.fields.find(x => x.key === t.primaryKey);
    if (!f) throw new Error(`表 ${t.name} 未定义主键字段 ${t.primaryKey}`);
    return f;
}
