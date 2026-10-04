#!/usr/bin/env node
/**
 * audit.mjs —— **技能槽规则体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**"技能槽的锁定 / 落槽 / 升级规则，代码真的按定案的口径跑吗？"**
 *
 * 做法（不是静态扫描，是**真跑一遍**）：
 *   把项目里真实的 `SkillSlots` / `Ability` / `AbilitySystem` / `AbilityDesc` /
 *   `platform/reactivity`（真 `ref`）用 TypeScript 的 `transpileModule` 编成 CJS，
 *   只给「cc / 配表容器」这些与规则无关的依赖打桩；然后用**真配表**（`abilities.json`）驱动：
 *     建英雄 → attachHero(自带技能) → grant(肉鸽技能) → 锁定/解锁 → 换英雄 → 读槽位状态
 *
 * 为什么需要它：技能槽的口径全是**规则**（谁被替换、什么时候升级、全锁定怎么办），
 * 这些在编辑器里靠手点很难覆盖全（尤其是"未锁定槽都满了 → 替换最低索引的那个"
 * 与"优先填空槽"这两条只在特定槽位组合下才分叉）。这里把每条口径写成一个断言。
 *
 * 用法：
 *   node tools/skill-slot-audit/audit.mjs
 *   npm run audit:slot        # 在 tools/excel_export 下的等价命令
 *
 * 退出码：有断言失败 = 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
const SRC = 'assets/scripts';

/** 需要编译的真源码（相对 assets/scripts；platform/reactivity 整个目录另算） */
const SOURCES = [
    'game/battle/types.ts',
    'game/battle/core/Types.ts',
    'game/battle/core/AttributeScaling.ts',
    'game/excel_table/EffectTypes.ts',
    'game/excel_table/Tb_AbilityConfig.ts',
    'game/battle/Ability.ts',
    'game/battle/AbilitySystem.ts',
    'game/battle/AbilityDesc.ts',
    'game/battle/SkillSlots.ts',
    // 详情面板组件（纯 CC 组件，靠下面的 `cc` 打桩在 Node 里跑起来）
    'game/ui/scenes/scene_game_stage/cmps/skill_slot/SkillDetailPanel.ts',
];

/**
 * `cc` 打桩：只实现 `SkillDetailPanel` 用到的那几个东西
 * （`_decorator` / `Color` / `Component` / `Label` / `Node` / `Sprite` / `UITransform`），
 * 外加一个 `buildTree(prefab, idx)`：**按真预制件的节点/组件数据构出一棵同构的假节点树**
 * （名字 / size / anchor / Label 文案与颜色都照抄），这样面板逻辑能对着真结构跑。
 */
const CC_STUB = `
class Color {
    constructor(r = 255, g = 255, b = 255, a = 255) { this.r = r; this.g = g; this.b = b; this.a = a; }
    clone() { return new Color(this.r, this.g, this.b, this.a); }
}
class UITransform {
    constructor() { this.node = null; this._w = 0; this._h = 0; this._ax = 0.5; this._ay = 0.5; }
    get width() { return this._w; }
    get height() { return this._h; }
    get anchorX() { return this._ax; }
    get anchorY() { return this._ay; }
    setContentSize(w, h) { this._w = w; this._h = h; }
    setAnchorPoint(x, y) { this._ax = x; this._ay = y; }
}
class Label {
    // 与 Cocos 同口径：color 的 getter 返回**内部那个对象**（不是拷贝）—— 能验出"忘了 clone 就串色"
    constructor() { this.node = null; this._color = new Color(255, 255, 255, 255); this.string = ''; this.fontSize = 20; this.lineHeight = 0; }
    get color() { return this._color; }
    set color(v) { this._color = v; }
}
class Sprite { constructor() { this.node = null; this.spriteFrame = null; this.color = new Color(); this.fillRange = 0; } }
class Component { constructor() { this.node = null; } }
class Node {
    constructor(name = '') { this.name = name; this._children = []; this.parent = null; this._active = true; this._components = []; this.isValid = true; }
    get children() { return this._children; }
    get active() { return this._active; }
    set active(v) { this._active = !!v; }
    get activeInHierarchy() { return this._active && (!this.parent || this.parent.activeInHierarchy); }
    get worldPosition() { return { x: 0, y: 0, z: 0 }; }
    get components() { return this._components; }
    getChildByName(n) { return this._children.find((c) => c.name === n) || null; }
    getSiblingIndex() { return this.parent ? this.parent._children.indexOf(this) : 0; }
    getComponent(t) { return this._components.find((c) => c instanceof t) || null; }
    addComponent(t) { const c = new t(); c.node = this; this._components.push(c); return c; }
    on() { }
    off() { }
}
Node.EventType = { TOUCH_START: 'touch-start', TOUCH_MOVE: 'touch-move', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel' };
const _decorator = { ccclass: () => (cls) => cls, property: () => () => { } };
function buildTree(prefab, idx) {
    const e = prefab[idx];
    const node = new Node(e._name);
    node._active = !!e._active;
    for (const ref of e._components || []) {
        const comp = prefab[ref.__id__];
        if (comp.__type__ === 'cc.UITransform') {
            const u = new UITransform(); u.node = node;
            u.setContentSize(comp._contentSize.width, comp._contentSize.height);
            u.setAnchorPoint(comp._anchorPoint.x, comp._anchorPoint.y);
            node._components.push(u);
        } else if (comp.__type__ === 'cc.Label') {
            const l = new Label(); l.node = node;
            l.string = comp._string; l.fontSize = comp._fontSize; l.lineHeight = comp._lineHeight;
            l._color = new Color(comp._color.r, comp._color.g, comp._color.b, comp._color.a);
            node._components.push(l);
        } else if (comp.__type__ === 'cc.Sprite') {
            const s = new Sprite(); s.node = node; node._components.push(s);
        }
    }
    for (const ch of e._children || []) {
        const child = buildTree(prefab, ch.__id__);
        child.parent = node;
        node._children.push(child);
    }
    return node;
}
module.exports = { _decorator, Color, Component, Label, Node, Sprite, UITransform, buildTree };
`;

/**
 * 打桩：只桩「cc / 配表容器 / 注册表」这类与技能槽规则无关的依赖。
 * 规则链（SkillSlots → AbilitySystem → Ability → Tb_AbilityConfig 的等级助手）全部走真代码。
 */
const STUBS = {
    'platform/excel_table/TbConfigDecorator': `exports.tb_config = () => (cls) => cls;`,
    'platform/excel_table/TbContainer': `exports.TbContainer = class { constructor() { this.cfgs = []; } getCfgById(id) { return this.cfgs.find((c) => c.id === id); } };`,
    // 详情面板只用 ShopConfig 的两个查询 → 打桩成「读真 abilities.json + 复用真 abilityMaxLevel」
    'game/data/configs/ShopConfig': `const fs = require('fs');
const { abilityMaxLevel } = require('../../excel_table/Tb_AbilityConfig.js');
const abilities = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(TB_DIR, 'abilities.json'))}, 'utf8'));
exports.ShopConfig = {
    getAbility: (id) => abilities.find((a) => a.id === id),
    getSkillMaxLevel: (cfg) => abilityMaxLevel(cfg),
};`,
};

// ============================ 编译真源码 ============================

const require = createRequire(import.meta.url);

function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✖ 找不到 typescript（请在项目根目录或 tools/excel_export 下装好依赖）');
    process.exit(2);
}
const ts = resolveTypeScript();

/** 递归收集某个目录下的 .ts（platform/reactivity 是整个目录一起编） */
function collectTs(absDir, prefix) {
    const out = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) out.push(...collectTs(path.join(absDir, entry.name), rel));
        else if (entry.name.endsWith('.ts')) out.push(rel);
    }
    return out;
}

function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-skill-slot-audit-'));
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));

    const files = [...SOURCES, ...collectTs(path.join(ROOT, SRC, 'platform/reactivity'), 'platform/reactivity')];
    for (const rel of files) {
        const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, SRC, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
            fileName: rel,
        }).outputText;
        const dest = path.join(out, SRC, rel.replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js);
    }
    for (const [rel, code] of Object.entries(STUBS)) {
        if (!code) continue;
        const dest = path.join(out, SRC, `${rel}.js`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
    }
    // 裸模块名 'cc' → <out>/node_modules/cc/index.js（面板组件 require('cc') 走这里）
    const ccDir = path.join(out, 'node_modules/cc');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'index.js'), CC_STUB);
    return { out, mod: (...p) => require(path.join(out, SRC, ...p)) };
}

// ============================ 真配表 ============================

const readTb = (name) => JSON.parse(fs.readFileSync(path.join(TB_DIR, `${name}.json`), 'utf8'));
const abilities = readTb('abilities');
const units = readTb('units');

/** 极简 AbilityCfgContainer：真 `AbilitySystem` 只用到 `getCfgById` */
const abilityContainer = {
    cfgs: abilities,
    getCfgById: (id) => abilities.find((a) => a.id === id),
};

// ============================ 断言 ============================

let passed = 0;
const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
        return;
    }
    failures.push(`${label}\n      实际 ${a}\n      期望 ${e}`);
}

const main = () => {
    const { out: OUT_DIR, mod } = build();
    const { SkillSlots, SKILL_SLOT_COUNT } = mod('game', 'battle', 'SkillSlots.js');
    const { AbilitySystem } = mod('game', 'battle', 'AbilitySystem.js');
    const { abilityLevelDesc, abilityMaxLevel, abilityEffectsAtLevel } = mod('game', 'excel_table', 'Tb_AbilityConfig.js');
    const { describeAbility, describeEffectsAtLevel } = mod('game', 'battle', 'AbilityDesc.js');

    console.log('▌技能槽规则体检（tools/skill-slot-audit/audit.mjs）');
    console.log(`  数据：assets/resources/tb/abilities.json（${abilities.length} 条）`);
    const shopSkills = abilities.filter((a) => a.scope === 'shop').map((a) => a.id).sort((x, y) => x - y);
    console.log(`  肉鸽技能 ${shopSkills.length} 个（id ${shopSkills[0]}~${shopSkills[shopSkills.length - 1]}）`);
    // 现役英雄（units.json team=1）：每个只带 1 个技能 —— 它天然占槽 0（英雄专属槽，永久锁定）
    const heroes = units.filter((u) => u.category === 'hero' || u.team === 1);
    console.log(`  英雄 ${heroes.length} 个（普攻 + 一个技能）：`
        + heroes.map((h) => `${h.name}→${(h.abilities ?? [])[0] ?? '无'}`).join(' · '));
    console.log(`  槽位数 ${SKILL_SLOT_COUNT}\n`);

    /* ---- 测试用英雄：真 AbilitySystem + 真 Ability ---- */
    // ⚠ Ability 的 ctx 是**从施放者身上取**的（`get ctx() { return this.caster.ctx }`），
    //   所以假英雄既要传给 AbilitySystem，也要自己挂一份 ctx —— 真 Entity 就是这么组织的。
    // ⚠ 下面的英雄**故意塞 2 个自带技能**：现役英雄已经收敛成"普攻 + 一个技能"（见 ⑭），
    //   而"新技能优先填空槽" vs "未锁定槽满了才替换最低索引槽"这两条口径只有在
    //   「槽 0 被自带技能锁住 + 槽 1 还有别的自带技能」时才分叉，所以这里用合成英雄覆盖该分支。
    const makeHero = (unitSkillIds) => {
        const ctx = {
            scriptRegistry: { get: () => undefined },
            effects: { execute: () => { } },
            bus: { publish: () => { } },
        };
        const hero = { ctx, abilities: null };
        hero.abilities = new AbilitySystem(hero, ctx, abilityContainer);
        for (const id of unitSkillIds) hero.abilities.AddAbility(id);
        return hero;
    };

    const slotView = (slots) => slots.slots.value.map((s) => `${s.skillId}${s.locked ? 'L' : ''}${s.level > 1 ? `(${s.level})` : ''}`);

    const slots = new SkillSlots({
        getHero: () => currentHero,
        getMaxLevel: (id) => abilityMaxLevel(abilityContainer.getCfgById(id) ?? {}),
        hasSkill: (id) => !!abilityContainer.getCfgById(id),
        // 宿主用它把英雄技能列表重新投影到 store —— 每次「真的改了槽位」都要响一次
        onChanged: () => { changedCount++; },
    });

    let currentHero = null;
    let changedCount = 0;

    /* ============ ① 初始态：槽 0 默认锁定，其余未锁定 ============ */
    check('① 初始态：4 个空槽、只有槽 0 锁定',
        slots.slots.value.map((s) => `${s.skillId}/${s.locked}`),
        ['0/true', '0/false', '0/false', '0/false']);

    /* ============ ② 英雄自带技能从最低索引开始占位 ============ */
    // 合成英雄自带 12（鹰眼瞄准·一阶，主动）+ 16（爆头冲击·被动，火枪现役的唯一技能）
    currentHero = makeHero([12, 16]);
    slots.attachHero(currentHero, [12, 16]);
    check('② 自带技能按顺序占 0/1，槽 0 锁定', slotView(slots), ['12L', '16', '0', '0']);

    /* ============ ③ 新技能优先填空着的未锁定槽 ============ */
    let r = slots.grant(101);
    check('③ grant(101) → 填槽 2（不是顶掉槽 1 的自带技能）',
        [r.ok, r.kind, r.index], [true, 'filled', 2]);
    r = slots.grant(102);
    check('③ grant(102) → 填槽 3', [r.ok, r.kind, r.index], [true, 'filled', 3]);
    check('③ 英雄实体上也挂上了这两个技能',
        currentHero.abilities.getAll().map((a) => a.getId()).sort((a, b) => a - b), [12, 16, 101, 102]);

    /* ============ ④ 未锁定槽都满了 → 替换最低索引的未锁定槽 ============ */
    r = slots.grant(103);
    check('④ grant(103) → 顶掉槽 1（最低索引的未锁定槽，不是槽 2/3）',
        [r.ok, r.kind, r.index, r.replacedId], [true, 'replaced', 1, 16]);
    check('④ 被顶掉的 16 从英雄身上摘掉了（于是重新回到抽取池）',
        currentHero.abilities.getAbility(16), undefined);
    check('④ 槽 0 的自带技能没被动过', slotView(slots), ['12L', '103', '101', '102']);

    /* ============ ⑤ 重复获得 → 原地升级（不新增槽、不换槽） ============ */
    r = slots.grant(101);
    check('⑤ grant(101) 第二次 → 槽 2 升到 Lv.2', [r.ok, r.kind, r.index, r.level], [true, 'upgraded', 2, 2]);
    r = slots.grant(101);
    check('⑤ 第三次 → Lv.3（101 的 max_level=3）', [r.ok, r.kind, r.level], [true, 'upgraded', 3]);
    r = slots.grant(101);
    check('⑤ 第四次 → 满级被拒', [r.ok, r.reason], [false, 'max_level']);
    check('⑤ 满级后槽位没变', slotView(slots), ['12L', '103', '101(3)', '102']);
    check('⑤ Ability 实例的等级同步到了 3', currentHero.abilities.getAbility(101).getLevel(), 3);

    /* ============ ⑥ 锁定/解锁：槽 0 永久锁定，其余可切 ============ */
    check('⑥ 点槽 0 的锁 → 被拒（英雄专属技能槽）', slots.toggleLock(0), false);
    check('⑥ 点槽 3 的锁 → 锁上', [slots.toggleLock(3), slots.slots.value[3].locked], [true, true]);
    check('⑥ 槽 0 仍然是锁的', slots.slots.value[0].locked, true);

    /* ============ ⑦ 全锁定 → all_locked（UI 据此飘字） ============ */
    slots.toggleLock(1);
    slots.toggleLock(2);
    check('⑦ 锁完 1/2/3 后没有可替换的槽', slots.hasReplaceableSlot(), false);
    r = slots.grant(104);
    check('⑦ grant(104) → all_locked', [r.ok, r.reason], [false, 'all_locked']);
    check('⑦ 被拒时槽位一点没动', slotView(slots), ['12L', '103L', '101L(3)', '102L']);

    /* ============ ⑧ 解锁一个空槽 → 优先填它（不顶掉已锁的） ============ */
    slots.toggleLock(3); // 槽 3 里已有 102，解锁后仍会被当作"可替换"
    check('⑧ 解锁槽 3 后可替换', slots.hasReplaceableSlot(), true);
    r = slots.grant(104);
    check('⑧ grant(104) → 顶掉槽 3 的 102（唯一未锁定槽）',
        [r.ok, r.kind, r.index, r.replacedId], [true, 'replaced', 3, 102]);

    /* ============ ⑨ 换英雄：自带技能重排，肉鸽技能尽量留在原槽 ============ */
    // 宙斯（1003）自带 19（雷霆之核·一阶，被动）
    currentHero = makeHero([19]);
    slots.attachHero(currentHero, [19]);
    check('⑨ 换英雄后槽 0 = 新英雄的自带技能（仍锁定）', slotView(slots), ['19L', '103L', '101L(3)', '104']);
    check('⑨ 肉鸽技能重新挂到新英雄身上（等级一起带过来）',
        currentHero.abilities.getAll().map((a) => `${a.getId()}:${a.getLevel()}`).sort(), ['101:3', '103:1', '104:1', '19:1']);
    check('⑨ 锁定状态按索引保留（槽 1/2 仍是锁的）',
        slots.slots.value.map((s) => s.locked), [true, true, true, false]);

    /* ============ ⑩ 冷却投影（圆形填充的数据源） ============ */
    const ability102 = null; // 已不在槽里
    const ability104 = currentHero.abilities.getAbility(104);
    // 101 是肉鸽技能（cd 0），借单位技能 1（火球术 cooldown=3）验一下比例换算
    slots.grant(1); // 槽 3 未锁定且已被 104 占着 → 顶掉 104
    const fireball = currentHero.abilities.getAbility(1);
    fireball.cooldownRemaining = 1.5; // 3 秒冷却走了一半
    slots.tick();
    const cd = slots.cooldowns.value;
    check('⑩ 火球术（cd 3s）剩 1.5s → 槽 3 的冷却进度 = 0.5', cd[3], 0.5);
    check('⑩ 无冷却的槽进度为 0', [cd[0], cd[1], cd[2]], [0, 0, 0]);
    fireball.cooldownRemaining = 0;
    slots.tick();
    check('⑩ 冷却结束后进度归 0', slots.cooldowns.value[3], 0);
    void ability102;

    /* ============ ⑪ 等级文案 / 效果（详情面板的数据源） ============ */
    const sk101 = abilityContainer.getCfgById(101); // 分裂弹：common / L3
    check('⑪ 分裂弹 max_level = 3', abilityMaxLevel(sk101), 3);
    /**
     * ⚠ 这条原本是「文案 == **设计稿原文**」（断言 `startsWith('普攻额外射出')` /
     *   `includes('2 枚')`）。2026-10 的重设计**改了这 24 条技能的文案**
     *   （原稿描述的机制在本作不存在，比如"射出子弹"实际是追加伤害段、"召唤炮台"改成周期性开火），
     *   所以钉死设计稿措辞就会把"照设计稿写"当成必须 —— 而新文案才是对的。
     *
     *   但这条断言的**真正意图**要保住：「逐级取到的是**配表里那一档**的原文」，
     *   而不是回落成上一级、更不是自动拼句兜底。所以改成自洽校验 + 三档互不相同。
     */
    const lvTexts = [abilityLevelDesc(sk101, 1), abilityLevelDesc(sk101, 2), abilityLevelDesc(sk101, 3)];
    check('⑪ Lv.1 / Lv.2 / Lv.3 逐级取到配表里那一档的原文（不是回落/自动拼句）',
        lvTexts, [sk101.lv1, sk101.lv2, sk101.lv3]);
    check('⑪ 三档文案互不相同（否则"取到原文"这条会假通过）',
        new Set(lvTexts).size, 3);
    check('⑪ 等级越界被钳住（传 9 取满级文案）', abilityLevelDesc(sk101, 9), sk101.lv3);

    const fireballCfg = abilityContainer.getCfgById(1);
    check('⑪ 单位技能没写 lv1 文案 → 详情按 effects 反推',
        describeEffectsAtLevel(fireballCfg, 1).includes('60'), true);
    check('⑪ 单位技能的基础信息带上冷却/耗蓝',
        [describeAbility(fireballCfg, 1).includes('冷却 3 秒'), describeAbility(fireballCfg, 1).includes('耗蓝 20')],
        [true, true]);
    check('⑪ max_level=1 的技能效果数组不随等级变（effects_lv2 为空）',
        abilityEffectsAtLevel(fireballCfg, 1).length, abilityEffectsAtLevel(fireballCfg, 3).length);

    /* ============ ⑫ 复位 ============ */
    slots.reset();
    check('⑫ reset 后回到初始态', slotView(slots), ['0L', '0', '0', '0']);

    /* ============ ⑬ onChanged 钩子：只在"真的改了槽位"时响（宿主靠它重投影 heroSkills） ============ */
    // 到复位为止「真的改了」的次数（被拒的 ⑤满级 / ⑦全锁定 都不该响）：
    //   ③×2 填槽 + ④ 替换 + ⑤×2 升级 + ⑧ 替换 + ⑩ 替换 = 7
    const before = changedCount;
    check('⑬ 只有成功改动才响 onChanged（被拒的不响）', before, 7);
    // ⚠ attachHero 自己**不**响：换英雄时宿主 `selectHero` 紧接着就会 syncHeroToStore 一次，
    //   这里再响一次是重复投影（口径写在 SkillSlotsDeps.onChanged 的注释里）
    slots.grant(104); // 复位后槽 1~3 空且未锁定 → 填进去并响一次
    check('⑬ 成功落槽会再响一次', changedCount, before + 1);

    /* ============ ⑭ 英雄技能收敛：默认「普攻 + 一个技能」 ============ */
    // 2026-09 定案：现役英雄（units.json team=1）自带技能**恰好 1 个** —— 普攻不是技能条目
    // （由 attack_interval + 攻击力属性驱动，见 Tb_AbilityConfig 的 behavior='attack' 说明）。
    // 这条曾经不成立（火枪 12+16、斧王 17+18 各两个），所以这里按**真配表**兜住回归。
    const heroSkillViolations = heroes
        .filter((h) => (Array.isArray(h.abilities) ? h.abilities.length : 0) !== 1)
        .map((h) => `${h.id} ${h.name}: ${JSON.stringify(h.abilities ?? null)}`);
    check('⑭ 每个英雄自带技能恰好 1 个（普攻 + 一个技能）', heroSkillViolations, []);

    /* ============ ⑮ 详情面板：预制件契约 + 每一级文案 ============ */
    // 面板节点与行节点都是**代码按名字找**的（`SKILL_DETAILS_NODE` / `lv_detail*`）：
    // 预制件里改个名字不会有任何编译错误，只会"长按没反应 / 面板是空的"，所以按真预制件兜一层。
    const prefabPath = path.join(ROOT, 'assets/resources/prefabs/ui/scenes/scene_game_stage/cmps/View_Game_Stage.prefab');
    const prefab = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
    const pNode = (id) => prefab[id];
    const pChildren = (n) => (n?._children ?? []).map((c) => pNode(c.__id__));
    const pFind = (n, name) => pChildren(n).find((c) => c._name === name);
    const pIsLabel = (n) => !!n && (n._components ?? []).some((c) => pNode(c.__id__).__type__ === 'cc.Label');

    const detailsIdx = prefab.findIndex((e) => e.__type__ === 'cc.Node' && e._name === 'skill_details');
    check('⑮ 预制件里有详情面板节点 skill_details', detailsIdx >= 0, true);
    if (detailsIdx >= 0) {
        const details = pNode(detailsIdx);
        // HUD 用 `host.getChildByName('skill_details')` 找它 → 必须是 HUD 的**直接**子节点
        check('⑮ skill_details 是 HUD 根节点的直接子节点（否则 getChildByName 找不到）',
            pNode(details._parent.__id__)._name, 'View_Game_Stage');
        const rows = pChildren(details).filter((n) => n._name.startsWith('lv_detail'));
        check('⑮ 行数 = 技能等级上限 3（有几级显示几行，多出来的等级没有行可显示）', rows.length, 3);
        const brokenRows = rows
            .filter((row) => !pIsLabel(pFind(pFind(row, 'lv_node'), 'lv')) || !pIsLabel(pFind(pFind(row, 'desc_node'), 'lv')))
            .map((row) => row._name);
        check('⑮ 每一行都有 `lv_node/lv` 与 `desc_node/lv` 两个 Label', brokenRows, []);
    }
    // 每一级都要有自己的文案：缺一级 → 那一行会回落显示上一级的文字（看起来像复制粘贴）
    const missingLevelText = [];
    for (const cfg of abilities.filter((a) => a.scope === 'shop' || a.scope === 'both')) {
        for (let lv = 1; lv <= abilityMaxLevel(cfg); lv++) {
            if (!abilityLevelDesc(cfg, lv).trim()) missingLevelText.push(`${cfg.id} lv${lv}`);
        }
    }
    check('⑮ 每个肉鸽技能的每一级都有文案（缺了那一行会重复上一级）', missingLevelText, []);

    /* ============ ⑯ 详情面板行为：真组件跑在真预制件子树上 ============ */
    // 面板是「一行 = 一级」的纯表现逻辑（行数 / 逐级文案 / 当前级绿字），
    // 全部建立在**按名字取节点**之上 —— 名字改了不会有编译错误、只会"长按没反应"或"面板空白"。
    // 这里用真预制件的 `skill_details` 子树（假 Node 同构复刻）跑真 `SkillDetailPanel`。
    const logs = { warn: [], info: [] };
    globalThis.ezgame = {
        warn: (...a) => logs.warn.push(a.map(String).join(' ')),
        error: (...a) => logs.warn.push(a.map(String).join(' ')),
        info: (...a) => logs.info.push(a.map(String).join(' ')),
    };
    const ccStub = require(path.join(OUT_DIR, 'node_modules/cc/index.js'));
    const panelNode = detailsIdx >= 0 ? ccStub.buildTree(prefab, detailsIdx) : null;
    const { SkillDetailPanel } = mod('game', 'ui', 'scenes', 'scene_game_stage', 'cmps', 'skill_slot', 'SkillDetailPanel.js');
    const panel = new SkillDetailPanel();
    panel.node = panelNode;
    panelNode._components.push(panel);
    panel.bind();

    const pRows = panelNode.children.filter((c) => c.name.indexOf('lv_detail') === 0);
    const pTag = (r) => r.getChildByName('lv_node').getChildByName('lv').getComponent(ccStub.Label);
    const pDesc = (r) => r.getChildByName('desc_node').getChildByName('lv').getComponent(ccStub.Label);
    const rgb = (c) => `${c.r},${c.g},${c.b}`;
    const GREEN = '34,177,76';
    const BLACK = '0,0,0';

    check('⑯ bind 认到 3 行、且先收起面板', [pRows.length, panelNode.active], [3, false]);
    check('⑯ bind 没报结构问题', logs.warn, []);

    const sk101Panel = abilities.find((a) => a.id === 101); // 分裂弹：max_level=3，三级都有文案
    panel.show(101, 2);
    check('⑯ 3 级技能 → 显示 3 行、标签 lv.1/lv.2/lv.3',
        [panelNode.active, ...pRows.map((r) => `${r.active ? 1 : 0}:${pTag(r).string}`)],
        [true, '1:lv.1', '1:lv.2', '1:lv.3']);
    check('⑯ 当前等级（lv.2）绿字，其余还原成作者原色',
        pRows.map((r) => rgb(pTag(r).color)), [BLACK, GREEN, BLACK]);
    check('⑯ 每行文案取该级自己的（不是整段抄一遍）',
        pRows.map((r, i) => pDesc(r).string === sk101Panel[`lv${i + 1}`]), [true, true, true]);
    check('⑯ 行高按文案撑高（>= 预制件里的 60）',
        pRows.map((r) => r.getComponent(ccStub.UITransform).height >= 60), [true, true, true]);

    panel.show(101, 1);
    check('⑯ 换到 lv.1：绿字跟着走，原来那行必须还原（否则上一级的绿字留在原地）',
        pRows.map((r) => rgb(pTag(r).color)), [GREEN, BLACK, BLACK]);

    panel.show(16, 1); // 单位技能：max_level=1
    check('⑯ 1 级技能只显示 1 行（有几级显示几行）',
        pRows.map((r) => (r.active ? 1 : 0)), [1, 0, 0]);
    check('⑯ 单位技能没有 lv1 文案时按 effects 反推，不会留空',
        pDesc(pRows[0]).string.length > 0, true);

    panel.hide();
    check('⑯ hide 收起面板', panelNode.active, false);
    check('⑯ 整个过程没有 warn', logs.warn, []);

    // ============================ 汇总 ============================
    console.log(`✔ 通过 ${passed} 条断言`);
    if (failures.length) {
        console.log(`\n✖ ${failures.length} 条失败：`);
        for (const f of failures) console.log(`  · ${f}`);
        process.exitCode = 1;
        return;
    }
    console.log('✔ 技能槽口径全部符合定案：槽 0 永久锁定 / 优先填空槽 / 满了替换最低索引未锁定槽 / 全锁定拒发 / 重复升级封顶');
};

main();
