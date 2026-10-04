#!/usr/bin/env node
/**
 * verify-heroes.mjs —— 10 个英雄「普攻 + 一个被动技能」端到端体检（真源码 + 真配表）
 *
 * 为什么需要它（对齐 tools/attr-audit 与 tools/skill-slot-audit 的「真跑源码」套路）：
 *   本项目配表与代码之间有逃逸口，**配表写对了代码也不一定生效** —— 已被三类静默坑咬过
 *   （`duration:null` 一帧判过期 / `percent` 打在 base=0 的属性上 / 暴击倍率 base 口径）。
 *   `audit:slot` 只验「技能槽规则」、`audit:attr` 只验「遗物给属性」，**都不验英雄技能真的打出来什么**。
 *   这个脚本补的就是这一段：把真源码编成 CJS、只桩 cc/容器，用**真配表**建英雄 → 真普攻命中
 *   → 看伤害 / 属性 / 受害者身上的 Modifier / 层数 / 状态，到底是不是设计里写的那样。
 *
 * 覆盖（58 条断言）：
 *   A 表结构与装配（10 英雄）：恰好 1 个技能 / scope=unit / passive / max_level=1 / 挂被动零警告
 *   B **配表 ↔ 资产交叉验证**：每个英雄的 head_icon 与技能 icon 指向的 png 都真的存在
 *   C 幻影刺客 1005：暴击率 +25%、暴击倍率 → 240%
 *   D 卓尔游侠 1006：攻击力 +6；命中施加减速且 **kv 覆盖生效**（移速 -40）
 *   E 水晶室女 1007：魔抗 +20、回蓝 +3；命中 **概率**冰封（random=0 中 / 0.99 不中）
 *   F 莉娜   1008：伤害输出 +20%；命中额外一段法术伤害
 *   G 冥界亚龙 1009：命中施毒、**属性随层数放大**、DoT 每秒结算
 *   H 谜团   1010：攻击力 +8；命中对半径内多个目标溅射
 *
 * ⚠ 顺带钉住一条**引擎现状**（G19/G20）：`ModifierSystem.processTickEffect` 用 `eff.value` 原值、
 *   **不乘 stackCount**，只有 `modify_attr` 会按层数放大。所以「可叠 5 层的毒」DoT 不随层数涨。
 *   冥界亚龙因此设计成「层数放大减速 + DoT 恒定」。想让 DoT 也随层数涨要改那一行。
 *
 * 用法：node tools/hero-audit/verify-heroes.mjs         （违规退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
const RES_DIR = path.join(ROOT, 'assets/resources');
const SRC = 'assets/scripts/game';

const SOURCES = [
    'battle/types.ts',
    'battle/core/Types.ts',
    'battle/core/AttributeScaling.ts',
    'battle/core/BattleConstUtil.ts',
    'excel_table/EffectTypes.ts',
    'excel_table/Tb_AbilityConfig.ts',
    'excel_table/Tb_ModifierConfig.ts',
    'excel_table/Tb_AttributeConfig.ts',
    'battle/Modifier.ts',
    'battle/StatusSystem.ts',
    'battle/ModifierSystem.ts',
    'battle/AttributeSystem.ts',
    'battle/DamagePipeline.ts',
    'battle/Ability.ts',
    'battle/AbilitySystem.ts',
    'battle/EffectExecutor.ts',
    'battle/Targeting.ts',
    'battle/Entity.ts',
    'battle/ScriptedModifiers.ts',
];

const readTb = (name) => JSON.parse(fs.readFileSync(path.join(TB_DIR, `${name}.json`), 'utf8'));

const STUBS = {
    'game/battle/Projectile.js': `exports.Projectile = class { constructor(o) { Object.assign(this, o); } };`,
    'game/battle/ai/AIRegistry.js': `exports.AIRegistry = { create() { return null; } };`,
    'game/battle/BattleContext.js': `exports.BattleContext = class {};`,
    'game/common/EntityVisualConfig.js': `exports.UnitKind = { Normal: 0, Hero: 1 }; exports.getUnitScale = () => 1; exports.resolveUnitKind = () => 0; exports.FINAL_BOSS_STAGE = 5;`,
    'game/excel_table/Tb_BattleConstConfig.js': `exports.BattleConstCfgContainer = class {};`,
    'platform/excel_table/TbConfigDecorator.js': `exports.tb_config = () => (cls) => cls;`,
    'platform/excel_table/TbContainer.js': `exports.TbContainer = class {};`,
    'platform/excel_table/TbRoot.js': `const cfgs = ${JSON.stringify(readTb('battle_constants'))};
const list = Object.keys(cfgs).map((k, i) => ({ id: i + 1, code: k, value: cfgs[k] }));
exports.TbRoot = { ins: { getTbContainer() { return { cfgs: list, size: list.length, getCode: (c) => list.find((x) => x.code === c) }; } } };`,
};

const require = createRequire(import.meta.url);
function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✖ 找不到 typescript');
    process.exit(2);
}
const ts = resolveTypeScript();

function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-heroes-'));
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    const gameDir = path.join(out, SRC);
    for (const rel of SOURCES) {
        const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, SRC, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
            fileName: rel,
        }).outputText;
        const dest = path.join(gameDir, rel.replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js);
    }
    for (const [rel, code] of Object.entries(STUBS)) {
        const dest = path.join(out, 'assets/scripts', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
    }
    return { out, mod: (...p) => require(path.join(gameDir, ...p)) };
}

let passed = 0;
const failures = [];
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✔ ${label}`); return; }
    failures.push(`${label}\n      实际 ${a}\n      期望 ${e}`);
    console.log(`  ✖ ${label}：实际 ${a} / 期望 ${e}`);
}
/** 浮点容差版（属性值是换算出来的浮点，不能直接 deep-equal） */
function near(label, actual, expected, tol = 1e-6) {
    const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
    if (ok) { passed++; console.log(`  ✔ ${label}（${actual}）`); return; }
    failures.push(`${label}\n      实际 ${actual}\n      期望 ${expected}±${tol}`);
    console.log(`  ✖ ${label}：实际 ${actual} / 期望 ${expected}±${tol}`);
}
/**
 * 断「属性差量」并把 before→after 打出来。
 * ⚠ 标签里**不要写死基数** —— 受害怪（2003 游荡者）的移速基础值是 140 不是 300，
 *   第一版把标签写成「300 → 270」，断言虽然是按差量过的，日志却在骗人。
 */
function nearDelta(label, before, after, delta, tol = 1e-6) {
    const d = after - before;
    const ok = typeof d === 'number' && Math.abs(d - delta) <= tol;
    const shown = `${label}（${before} → ${after}，Δ${d}）`;
    if (ok) { passed++; console.log(`  ✔ ${shown}`); return; }
    failures.push(`${label}\n      实际 Δ${d}（${before} → ${after}）\n      期望 Δ${delta}±${tol}`);
    console.log(`  ✖ ${shown}／期望 Δ${delta}±${tol}`);
}

const main = () => {
    const { mod } = build();
    const { Entity } = mod('battle', 'Entity.js');
    const { DamagePipeline } = mod('battle', 'DamagePipeline.js');
    const { EffectExecutor } = mod('battle', 'EffectExecutor.js');
    const { BattleConstUtil } = mod('battle', 'core', 'BattleConstUtil.js');
    const { Modifier_MusketHeadshot, Modifier_EagleEye, Modifier_CounterStorm, Modifier_ZeusThunder } = mod('battle', 'ScriptedModifiers.js');
    const { DamageType, StateType } = mod('battle', 'types.js');
    const { AttributeType } = mod('battle', 'core', 'Types.js');

    BattleConstUtil.markLoaded();

    const units = readTb('units');
    const abilities = readTb('abilities');
    const modifiers = readTb('modifiers');
    const heroes = units.filter((u) => u.team === 1);
    const container = (cfgs) => ({ cfgs, size: cfgs.length, getCfgById: (id) => cfgs.find((c) => c.id === id) });

    /** 溅射类技能需要 findEntitiesInRadius 返回一份可控名单 */
    let radiusResults = [];
    /**
     * @param opts.stripEventsFrom 把该 modifier 的 `events` 摘掉后再进容器 ——
     *   用来做「同一攻击者、同一属性、只差一个 on_attack_landed 动作」的**隔离对照**。
     *   没有它就没法把「命中附伤」和「技能自带的属性加成」分开量（莉娜那条一开始就栽在这）。
     */
    const makeCtx = (opts = {}) => {
        const mods = opts.stripEventsFrom
            ? modifiers.map((m) => (m.id === opts.stripEventsFrom ? { ...m, events: undefined } : m))
            : modifiers;
        const ctx = {
            attributeContainer: container(readTb('attributes')),
            modifierContainer: container(mods),
            abilityContainer: container(abilities),
            bus: { publish() { }, onBattleEvent() { return () => { }; } },
            scriptRegistry: {
                classes: new Map(),
                registerClass(id, cls) { this.classes.set(id, cls); },
                get(id) { return this.classes.get(id); },
                getAction() { return undefined; },
            },
            spawnProjectile() { },
            GetTeamEntities: () => [],
            GetAllEntities: () => [],
            findEntitiesInRadius: () => radiusResults,
            IsRecycled: () => false,
            getUnitDef: (id) => units.find((u) => u.id === id),
            schedule() { },
        };
        ctx.effects = new EffectExecutor(ctx);
        ctx.damagePipeline = new DamagePipeline(ctx);
        // 与 Scene_Game_Stage.initBattle 的注册表一致
        ctx.scriptRegistry.registerClass('Modifier_MusketHeadshot', Modifier_MusketHeadshot);
        ctx.scriptRegistry.registerClass('Modifier_EagleEye', Modifier_EagleEye);
        ctx.scriptRegistry.registerClass('Modifier_CounterStorm', Modifier_CounterStorm);
        ctx.scriptRegistry.registerClass('Modifier_ZeusThunder', Modifier_ZeusThunder);
        return ctx;
    };

    const spawn = (ctx, id, uid, x) => {
        const def = units.find((u) => u.id === id);
        const e = new Entity(def.id, uid, def.name, def.team, ctx);
        e.Reinit(def);
        e.position = { x, y: 0 };
        return e;
    };
    /** 对照组：同一个英雄但一个技能都不带 —— 用来把「技能带来的差量」量出来 */
    const spawnControl = (ctx, id, uid, x = 0) => {
        const def = { ...units.find((u) => u.id === id), abilities: [] };
        const e = new Entity(def.id, uid, def.name, def.team, ctx);
        e.Reinit(def);
        e.position = { x, y: 0 };
        return e;
    };
    const ATT = AttributeType;
    const attr = (e, t) => e.attrs.get(t);
    const withRandom = (v, fn) => {
        const orig = Math.random;
        Math.random = () => v;
        try { return fn(); } finally { Math.random = orig; }
    };
    /** 静音 console.warn 收集（用来断言「挂被动期间没有未注册 script_id」） */
    const captureWarn = (fn) => {
        const out = [];
        const orig = console.warn;
        console.warn = (...a) => out.push(a.map(String).join(' '));
        try { fn(); } finally { console.warn = orig; }
        return out;
    };

    console.log('▌英雄「普攻 + 一个被动」端到端体检（真源码 + 真配表）');
    console.log(`  英雄 ${heroes.length} 个 · 技能表 ${abilities.length} 条 · Modifier ${modifiers.length} 条\n`);

    /* ================= A. 表结构与装配 ================= */
    console.log('▌A 10 个英雄的装配（真建实体 → 挂被动）');
    const heroBuild = [];
    const warnings = captureWarn(() => {
        for (const h of heroes) {
            const c = makeCtx();
            const e = spawn(c, h.id, 900 + h.id, 0);
            heroBuild.push({
                hero: h,
                skills: e.abilities.getAll().map((a) => a.getId()),
                mods: e.modifiers.getAll().map((m) => ({ id: m.getId(), stack: m.getStackCount() })),
                entity: e,
            });
        }
    });
    check('A1 每个英雄恰好 1 个自带技能', heroBuild.map((b) => b.skills.length), heroes.map(() => 1));
    console.log(`      ${heroBuild.map((b) => `${b.hero.name}→${b.skills.join('+')}`).join(' · ')}`);
    check('A2 挂被动期间零警告（无未注册 script_id / 未找到技能定义）', warnings, []);
    check('A3 每个英雄的自带技能都在 abilities.json 里，且 scope=unit / passive / max_level=1',
        heroBuild.map((b) => {
            const a = abilities.find((x) => x.id === b.skills[0]);
            return a ? `${a.scope}/${a.behavior}/${a.max_level}` : '缺失';
        }), heroes.map(() => 'unit/passive/1'));
    check('A4 每个英雄的被动都真的把 Modifier 挂到了自己身上',
        heroBuild.map((b) => b.mods.length >= 1), heroes.map(() => true));
    check('A5 技能 effects 引用的 Modifier 在 modifiers.json 里都存在',
        heroBuild.map((b) => {
            const a = abilities.find((x) => x.id === b.skills[0]);
            const refs = (a?.effects ?? []).filter((e) => e.type === 'apply_modifier').map((e) => e.modifier);
            return refs.every((r) => modifiers.some((m) => m.id === r));
        }), heroes.map(() => true));

    /* ================= B. 配表 ↔ 资产 交叉验证 ================= */
    console.log('\n▌B 配表指向的图真的在磁盘上（配表 ↔ 资产交叉验证）');
    /**
     * ⚠ 判据在 2026-10 分过一次岔：**头像**还是碎图，**技能图**已经进了技能图集。
     *   `textures/skills/<code>_skill` 这些碎图已被 `retire-loose-skill-icons.py` 退掉
     *   （10 张英雄技能图与 30 张肉鸽技能图一起进了 `textures/skills/skills.plist`），
     *   所以技能图要拿**图集帧名**核对，不能再按 `.png` 文件找 —— 否则 10 条全报"不存在"。
     */
    const ATLAS_FRAMES = (() => {
        const p = path.join(RES_DIR, 'textures/skills/skills.plist');
        if (!fs.existsSync(p)) return null;
        const set = new Set();
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/<key>([^<>]+\.png)<\/key>/g)) set.add(m[1]);
        return set;
    })();
    check('B0 技能图集 skills.plist 存在且已导入', ATLAS_FRAMES !== null, true);
    const missing = [];
    for (const h of heroes) {
        for (const [what, rel] of [['head_icon', h.head_icon], ['skill icon', abilities.find((a) => a.id === h.abilities[0])?.icon]]) {
            if (!rel) { missing.push(`${h.name} 的 ${what} 为空`); continue; }
            const isSkillIcon = rel.startsWith('textures/skills/');
            if (isSkillIcon) {
                const frame = `${rel.split('/').pop()}.png`;
                if (!ATLAS_FRAMES?.has(frame)) missing.push(`${h.name} 的 ${what} → 图集里没有帧 ${frame}`);
                continue;
            }
            const p = path.join(RES_DIR, `${rel}.png`);
            if (!fs.existsSync(p)) missing.push(`${h.name} 的 ${what} → ${rel}.png 不存在`);
        }
    }
    check('B1 10 个英雄的头像（碎图）+ 10 张技能图（图集帧）配表指向的资源全部存在', missing, []);

    /* ================= C. 幻影刺客 1005 ================= */
    console.log('\n▌C 幻影刺客 1005「恩赐解脱」= 暴击率 +25% / 倍率 → 240%');
    {
        const pa = heroBuild.find((b) => b.hero.id === 1005).entity;
        const ctrl = spawnControl(makeCtx(), 1005, 700);
        near('C1 暴击率 0 → 0.25', attr(pa, ATT.CritRate), 0.25, 1e-9);
        near('C2 对照组暴击率仍是 0（差量来自技能）', attr(ctrl, ATT.CritRate), 0, 1e-9);
        near('C3 暴击倍率 1.5 → 2.4（`best` 生效，不是 1.5+2.4）', attr(pa, ATT.CritDmg), 2.4, 1e-9);
        near('C4 对照组倍率仍是 1.5', attr(ctrl, ATT.CritDmg), 1.5, 1e-9);
        check('C5 暴击真的能打出来（rollCrit 要求 率>0 且 倍率>1）',
            attr(pa, ATT.CritRate) > 0 && attr(pa, ATT.CritDmg) > 1, true);
    }

    /* ================= D. 卓尔游侠 1006 ================= */
    console.log('\n▌D 卓尔游侠 1006「霜冻之箭」= 攻击力 +6 / 命中减速 -40');
    {
        const b = heroBuild.find((x) => x.hero.id === 1006);
        const drow = b.entity;
        const ctrl = spawnControl(makeCtx(), 1006, 701);
        near('D1 攻击力 32 → 38（+6）', attr(drow, ATT.Atk), 38, 1e-9);
        near('D2 对照组攻击力仍是 32', attr(ctrl, ATT.Atk), 32, 1e-9);

        const victim = spawn(drow.ctxRef, 2003, 801, 350);
        const speedBefore = attr(victim, ATT.MoveSpeed);
        withRandom(0.5, () => drow.resolveAttackHit(victim, drow.getAttackDamage(), DamageType.Physical));
        const slow = victim.modifiers.getAll().find((m) => m.getId() === 2);
        check('D3 命中后受害者身上出现 modifier 2「减速」', !!slow, true);
        check('D4 kv 覆盖生效：kv.slow = -40（不是模板里占位的 -90）', slow?.getKV?.(), { slow: -40 });
        nearDelta('D5 受害者移速被真的减掉 40', speedBefore, attr(victim, ATT.MoveSpeed), -40, 1e-9);
    }

    /* ================= E. 水晶室女 1007 ================= */
    console.log('\n▌E 水晶室女 1007「冰霜结界」= 魔抗 +20 / 回蓝 +3 / 命中 20% 冰封 0.8s');
    {
        const cm = heroBuild.find((b) => b.hero.id === 1007).entity;
        const ctrl = spawnControl(makeCtx(), 1007, 702);
        // ⚠ 属性的**读出单位不统一**（AttributeScaling.SCALE）：魔抗按 `complement` 叠，`.get()` 给的是**比例 0.45**；
        //   而魔法恢复给的是**原值 3**。所以别拿「45」去断魔抗 —— 那是我第一版写错的期望，不是配表错。
        near('E1 魔抗 0.25 → 0.45（即 25% → 45%，+20 百分点）', attr(cm, ATT.MagicResist), 0.45, 1e-9);
        near('E2 对照组魔抗仍是 0.25', attr(ctrl, ATT.MagicResist), 0.25, 1e-9);
        near('E3 魔法恢复 0 → 3（base=0 属性必须用 add，percent 会恒为 0）', attr(cm, ATT.ManaRegen), 3, 1e-9);
        near('E4 对照组魔法恢复仍是 0', attr(ctrl, ATT.ManaRegen), 0, 1e-9);

        const v1 = spawn(cm.ctxRef, 2003, 802, 350);
        withRandom(0, () => cm.resolveAttackHit(v1, cm.getAttackDamage(), DamageType.Physical));
        check('E5 掷中（random=0 < 0.2）→ 受害者被冰封（status.Stunned）',
            v1.status.get(StateType.Stunned), true);

        const v2 = spawn(cm.ctxRef, 2003, 803, 350);
        withRandom(0.99, () => cm.resolveAttackHit(v2, cm.getAttackDamage(), DamageType.Physical));
        check('E6 掷不中（random=0.99 > 0.2）→ 不被冰封（概率真的在掷）',
            v2.status.get(StateType.Stunned), false);
    }

    /* ================= F. 莉娜 1008 ================= */
    console.log('\n▌F 莉娜 1008「神灭斩」= 伤害输出 +20% / 命中附 30 法术伤害');
    {
        const lina = heroBuild.find((b) => b.hero.id === 1008).entity;
        const ctrl = spawnControl(makeCtx(), 1008, 703);
        // 同上：伤害输出倍率 `.get()` 给的是**比例 1.2**（不是 120）
        near('F1 伤害输出倍率 1.0 → 1.2（即 100 → 120，+20 百分点）', attr(lina, ATT.DamageOut), 1.2, 1e-9);
        near('F2 对照组倍率仍是 1.0', attr(ctrl, ATT.DamageOut), 1.0, 1e-9);

        /**
         * ⚠ **隔离对照**（第一版在这里断错了）：莉娜的技能同时给「伤害输出 +20%」和「命中附 30 法术伤害」，
         *   而 +20% 会把**普攻本身**也抬高 —— 于是「有技能 vs 无技能」的伤害差是
         *   `普攻那一段的 +20%` **加上** `30 法术`（实测 34.8，而单算法术只有 28.8）。
         *   要单独量「命中附伤」这一条，必须让两个攻击者**属性完全相同、只差那个 on_attack_landed 动作**：
         *   所以另起一个 ctx，把 modifier 30 的 `events` 摘掉再进容器。
         */
        const stripped = heroBuild.find((b) => b.hero.id === 1008).entity;
        const noEventHero = spawn(makeCtx({ stripEventsFrom: 30 }), 1008, 720, 0);
        check('F3 对照攻击者属性与本体一致（证明隔离干净）',
            [attr(noEventHero, ATT.Atk), attr(noEventHero, ATT.DamageOut)],
            [attr(stripped, ATT.Atk), attr(stripped, ATT.DamageOut)]);

        // 预言机：同一管线上直接打 30 法术伤害
        const oracle = spawn(lina.ctxRef, 2003, 804, 350);
        lina.ctxRef.damagePipeline.ApplyDamage(oracle, lina, 30, DamageType.Magical);
        const oracleLoss = oracle.getMaxHp() - oracle.hp;

        const vA = spawn(lina.ctxRef, 2003, 805, 350);
        const vB = spawn(noEventHero.ctxRef, 2003, 806, 350);
        withRandom(0.5, () => lina.resolveAttackHit(vA, lina.getAttackDamage(), DamageType.Physical));
        withRandom(0.5, () => noEventHero.resolveAttackHit(vB, noEventHero.getAttackDamage(), DamageType.Physical));
        const extra = (vA.getMaxHp() - vA.hp) - (vB.getMaxHp() - vB.hp);
        check('F4 命中额外造成的伤害 == 直接打 30 法术伤害（同一管线预言机）', extra, oracleLoss);
        check('F5 额外伤害 > 0（技能真的触发了）', extra > 0, true);
    }

    /* ================= G. 冥界亚龙 1009 ================= */
    console.log('\n▌G 冥界亚龙 1009「幽冥剧毒」= 命中施毒 / 层数放大减速 / DoT 每秒 8');
    {
        const viper = heroBuild.find((b) => b.hero.id === 1009).entity;
        const victim = spawn(viper.ctxRef, 2003, 807, 350);
        const speedBefore = attr(victim, ATT.MoveSpeed);
        withRandom(0.5, () => viper.resolveAttackHit(victim, viper.getAttackDamage(), DamageType.Physical));
        let poison = victim.modifiers.getAll().find((m) => m.getId() === 32);
        check('G1 命中后受害者身上出现 modifier 32「剧毒」', !!poison, true);
        check('G2 叠加方式 = stack、上限 5 层',
            [poison?.getStackMode?.(), poison?.def?.max_stack], ['stack', 5]);
        nearDelta('G3 1 层 → 移速被减掉 30（每层 -30 真的落到了属性上）', speedBefore, attr(victim, ATT.MoveSpeed), -30, 1e-9);

        // 叠第 2 层：属性按层数放大，这是 `Modifier.resolveAttr` 里 value × stackCount 的效果
        withRandom(0.5, () => viper.resolveAttackHit(victim, viper.getAttackDamage(), DamageType.Physical));
        poison = victim.modifiers.getAll().find((m) => m.getId() === 32);
        check('G4 再次命中 → 叠到 2 层', poison?.getStackCount?.(), 2);
        nearDelta('G5 2 层 → 移速被减掉 60（**属性随层数放大**）', speedBefore, attr(victim, ATT.MoveSpeed), -60, 1e-9);

        // DoT：推进 1 秒
        const hpBefore = victim.hp;
        victim.modifiers.Tick(1.01);
        const dot1 = hpBefore - victim.hp;
        check('G6 推进 1 秒 → DoT 结算一次，掉血 > 0', dot1 > 0, true);

        // ⚠ 引擎现状：tick 效果**不乘层数**（只有 modify_attr 乘）—— 把它钉成断言，防止将来被误当成 bug 改掉
        const hp2 = victim.hp;
        victim.modifiers.Tick(1.01);
        const dot2 = hp2 - victim.hp;
        near('G7 ⚠ 引擎现状：2 层时 DoT 与 1 层等量（tick 不随层数放大，只有属性放大）', dot2, dot1, 1e-9);
    }

    /* ================= H. 谜团 1010 ================= */
    console.log('\n▌H 谜团 1010「黑洞」= 攻击力 +8 / 命中溅射 130 半径 28 法术');
    {
        const enigma = heroBuild.find((b) => b.hero.id === 1010).entity;
        const ctrl = spawnControl(makeCtx(), 1010, 704);
        near('H1 攻击力 26 → 34（+8）', attr(enigma, ATT.Atk), 34, 1e-9);
        near('H2 对照组攻击力仍是 26', attr(ctrl, ATT.Atk), 26, 1e-9);

        const victim = spawn(enigma.ctxRef, 2003, 808, 350);
        const neighbour = spawn(enigma.ctxRef, 2003, 809, 400);
        radiusResults = [victim, neighbour];
        // 预言机：直接对同型目标打 28 法术
        const oracle = spawn(enigma.ctxRef, 2003, 810, 350);
        enigma.ctxRef.damagePipeline.ApplyDamage(oracle, enigma, 28, DamageType.Magical);
        const oracleLoss = oracle.getMaxHp() - oracle.hp;

        withRandom(0.5, () => enigma.resolveAttackHit(victim, enigma.getAttackDamage(), DamageType.Physical));
        const vLoss = victim.getMaxHp() - victim.hp;
        const nLoss = neighbour.getMaxHp() - neighbour.hp;
        radiusResults = [];
        check('H3 半径内的邻居也吃到了溅射（伤害 > 0）', nLoss > 0, true);
        check('H4 邻居吃到的溅射 == 直接打 28 法术（同一管线预言机）', nLoss, oracleLoss);
        check('H5 主目标吃到的比邻居多（还额外吃了那一下普攻）', vLoss > nLoss, true);
    }

    console.log(`\n${failures.length ? `✖ ${failures.length} 条失败（通过 ${passed}）` : `✔ 通过 ${passed} 条断言`}`);
    if (failures.length) {
        for (const f of failures) console.log(`  · ${f}`);
        process.exitCode = 1;
    }
};

main();
