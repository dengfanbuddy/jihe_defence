#!/usr/bin/env node
/**
 * verify-skills.mjs —— 局内肉鸽技能「已落地效果 + 换技能不漏属性」端到端体检（真源码 + 真配表）
 *
 * 为什么需要它（对齐 tools/attr-audit / tools/skill-slot-audit / tools/hero-audit 的「真跑源码」套路）：
 *   `audit:slot` 只验**技能槽规则**（锁定/落槽/升级），`audit:hero` 只验**英雄自带技能**，
 *   两个都**不验肉鸽技能真的生效了什么**。而本轮落地的 6 条技能全是 `passive` + `modify_attr`，
 *   正是「配表写对了代码也可能不生效」的高危区（`duration:null` 一帧判过期 / `percent` 打在
 *   base=0 上 / 暴击倍率 `best` 写成 `add` —— 三类静默坑都被咬过）。
 *
 * 覆盖：
 *   A **换技能不漏属性**（`AbilitySystem.RemoveAbility` 的真 bug，回归测试）
 *     A1 `modify_attr` 型技能摘掉后属性回到基线
 *     A2 `apply_modifier` 型技能摘掉后 Modifier 真的从实体上消失
 *     A3 `Clear()` 同样干净（对象池复用路径）
 *   B 104 迅捷 / 105 鹰眼 / 106 强健 / 107 暴击机芯 / 130 恶魔契约：1/2/3 级属性逐级对上
 *   C 107 三阶的暴击倍率走 `best`（= max(base,170)=1.7，不是 base+Σv 的累加）
 *   D 130 的**负向** percent 真的把最大生命压下去（且当前生命被钳回，不出 hp>maxHp 脏数据）
 *   E 103 嗜血：1/2/3 级挂的是 34/35/36，**升级会摘掉旧的那条**（同源只留一条）
 *   F 103 嗜血**真打一下**：英雄掉血 → 普攻命中 → 回复量 == 本次最终伤害 × 比例
 *   G 配表 ↔ 资产：这 6 条技能 icon 指向的 png 真的存在
 *
 * 用法：node tools/skill-audit/verify-skills.mjs        （违规退出码 1）
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

/** 编真源码清单（与 tools/hero-audit 同一份；新增被审计的源码时要同步两处） */
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
    'battle/ShopSkillModifiers.ts',
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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-skills-'));
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
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✔ ${label}`); return; }
    failures.push(`${label}\n      实际 ${a}\n      期望 ${e}`);
    console.log(`  ✖ ${label}：实际 ${a} / 期望 ${e}`);
}
function near(label, actual, expected, tol = 1e-6) {
    const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
    if (ok) { passed++; console.log(`  ✔ ${label}（${actual}）`); return; }
    failures.push(`${label}\n      实际 ${actual}\n      期望 ${expected}±${tol}`);
    console.log(`  ✖ ${label}：实际 ${actual} / 期望 ${expected}±${tol}`);
}
/** 断「属性差量」并把 before→after 打出来；标签里不要写死基数，不同单位的 base 不一样 */
function nearDelta(label, before, after, delta, tol = 1e-6) {
    const d = after - before;
    const shown = `${label}（${before} → ${after}，Δ${d}）`;
    if (typeof d === 'number' && Math.abs(d - delta) <= tol) { passed++; console.log(`  ✔ ${shown}`); return; }
    failures.push(`${label}\n      实际 Δ${d}（${before} → ${after}）\n      期望 Δ${delta}±${tol}`);
    console.log(`  ✖ ${shown}／期望 Δ${delta}±${tol}`);
}

const main = () => {
    const { mod } = build();
    const { Entity } = mod('battle', 'Entity.js');
    const { DamagePipeline } = mod('battle', 'DamagePipeline.js');
    const { EffectExecutor } = mod('battle', 'EffectExecutor.js');
    const { BattleConstUtil } = mod('battle', 'core', 'BattleConstUtil.js');
    const { AttributeScaling } = mod('battle', 'core', 'AttributeScaling.js');
    const { DamageType, StateType, BattleEvents } = mod('battle', 'types.js');
    const { AttributeType } = mod('battle', 'core', 'Types.js');
    const { SHOP_MOD, SHOP_SKILL_SCRIPT_CLASSES } = mod('battle', 'ShopSkillModifiers.js');

    BattleConstUtil.markLoaded();

    const units = readTb('units');
    const abilities = readTb('abilities');
    const modifiers = readTb('modifiers');
    const container = (cfgs) => ({ cfgs, size: cfgs.length, getCfgById: (id) => cfgs.find((c) => c.id === id) });

    const makeCtx = () => {
        /**
         * 真事件的**最小实现**（不是空壳）。
         *
         * 为什么必须真：30 条肉鸽技能里有 4 条（111 淘金 / 122 击杀回响 / 125 元素军阵，
         * 以及 109 三阶的击杀加速）**只能挂总线**（`on_kill` 只 publish、不派发给 Modifier），
         * 空壳 bus 会让它们"看起来过了断言其实一次都没触发"。
         * 同时还验了 `Modifier.OnDestroy` 里的 `bus.off` 到底有没有把订阅摘掉 ——
         * 实体走对象池复用，不摘会重复计数（这是审查里点名的三条纪律之一）。
         */
        const handlers = new Map();
        const entities = [];
        const bus = {
            handlers,
            on(type, handler, caller) {
                if (!handlers.has(type)) handlers.set(type, new Set());
                const entry = { handler, caller };
                handlers.get(type).add(entry);
                return () => handlers.get(type)?.delete(entry);
            },
            off(type, handler, caller) {
                const set = handlers.get(type);
                if (!set) return;
                for (const e of [...set]) {
                    if (e.handler === handler && (caller === undefined || e.caller === caller)) set.delete(e);
                }
            },
            publish(type, event) {
                const set = handlers.get(type);
                if (!set) return;
                for (const e of [...set]) e.handler.call(e.caller, event);
            },
        };
        bus.onBattleEvent = (type, handler, caller) => bus.on(type, handler, caller);

        const ctx = {
            attributeContainer: container(readTb('attributes')),
            modifierContainer: container(modifiers),
            abilityContainer: container(abilities),
            bus,
            scriptRegistry: {
                classes: new Map(),
                registerClass(id, cls) { this.classes.set(id, cls); },
                get(id) { return this.classes.get(id); },
                getAction() { return undefined; },
            },
            spawnProjectile() { },
            GetTeamEntities: (team) => entities.filter((e) => e.team === team && !e.IsDead()),
            GetAllEntities: () => [...entities],
            findEntitiesInRadius(center, radius, teamFilter) {
                const cx = center?.position?.x ?? 0;
                const cy = center?.position?.y ?? 0;
                return entities.filter((e) => {
                    if (e.IsDead()) return false;
                    if (teamFilter !== undefined && e.team !== teamFilter) return false;
                    const dx = (e.position?.x ?? 0) - cx;
                    const dy = (e.position?.y ?? 0) - cy;
                    return dx * dx + dy * dy <= radius * radius;
                });
            },
            IsRecycled: () => false,
            getUnitDef: (id) => units.find((u) => u.id === id),
            schedule() { },
            entities,
        };
        ctx.effects = new EffectExecutor(ctx);
        ctx.damagePipeline = new DamagePipeline(ctx);
        for (const name of Object.keys(SHOP_SKILL_SCRIPT_CLASSES)) {
            ctx.scriptRegistry.registerClass(name, SHOP_SKILL_SCRIPT_CLASSES[name]);
        }
        return ctx;
    };

    /**
     * 造一个「一个技能都不带」的英雄 —— 这是能量出「技能带来的差量」的前提。
     * 直接改 units.json 的副本把 abilities 清空，而不是造一个假实体。
     */
    const hero = (ctx, id = 1001, extra = {}) => {
        const def = { ...units.find((u) => u.id === id), abilities: [], ...extra };
        const e = new Entity(def.id, def.id, def.name, def.team, ctx);
        e.Reinit(def);
        e.position = { x: 0, y: 0 };
        ctx.entities.push(e);
        return e;
    };
    const monster = (ctx, id = 2001, uid = 9001, x = 200) => {
        const def = units.find((u) => u.id === id);
        const e = new Entity(def.id, uid, def.name, def.team, ctx);
        e.Reinit(def);
        e.position = { x, y: 0 };
        ctx.entities.push(e);
        return e;
    };
    const ATT = AttributeType;
    const Stunned = StateType.Stunned;

    /**
     * 「木桩」—— 数值可控的敌人，供所有"逐点算得出期望值"的断言用。
     *
     * 三件事必须做，否则伤害算不出整数、断言会变成玄学：
     *   · **把血量堆到很大** → 一整段测试里木桩不会中途死掉（死了之后后面的伤害全归零）；
     *   · **护甲/魔抗归零** → 物理走双曲减伤、法术固定 25% 减免，不归零就要在期望值里带上它们；
     *   · **英雄暴击率归零** → `DamagePipeline` 第 2 阶段对**每一次**伤害都会 roll 暴击
     *     （不是只有普攻），不清零则伤害随时翻 1.5 倍，任何精确断言都会随机失败。
     */
    const dummy = (ctx, uid, x, y = 0, hp = 100000) => {
        const m = monster(ctx, 2001, uid, x);
        m.position = { x, y };
        m.attrs.setBase(1, hp);
        m.hp = m.getMaxHp();
        m.attrs.setBase(6, 0);      // 护甲
        m.attrs.setBase(7, 0);      // 魔抗
        /**
         * 移速钉成 300。
         * ⚠ **不能假设怪物移速就是 `attributes.json` 的默认 300** —— 怪物行会覆盖它，
         *   而属性 5 有 `min: 50` 的下限：实测某只怪 base=100，减 120 会被钳成 50，
         *   于是「每层 -60」的断言量不出差量（两层和一层都是 50，断言假通过）。
         */
        m.attrs.setBase(5, 300);
        return m;
    };
    const noCrit = (h) => { h.attrs.setBase(ATT.CritRate, 0); return h; };

    /**
     * 复刻 `Entity.Attack` 的派发顺序（**不是**随便调一下 resolveAttackHit）。
     * 顺序很关键：109 首击要判「目标满血」，而 `on_attack_landed` 是在扣血**之后**派发的 →
     * 只能在 `on_attack_start` 记标记、在 landed 消费。这里两处都发，与真实现一致。
     */
    const meleeHit = (h, m, dmg) => {
        const d = dmg ?? h.getAttackDamage();
        h.ctxRef.bus.publish('on_attack_start', { attacker: h, target: m, damage: d });
        h.modifiers.DispatchEvent('on_attack_start', { attacker: h, target: m, damage: d });
        return h.resolveAttackHit(m, d, DamageType.Physical);
    };

    /** 临时把 Math.random 钉成固定值（剧本化"必定格挡"/"必定闪避"/"必定不暴击"） */
    const withRandom = (value, fn) => {
        const orig = Math.random;
        Math.random = () => value;
        try { return fn(); } finally { Math.random = orig; }
    };

    /** 量一段操作让某个实体掉了多少血 */
    const lossOf = (e, fn) => {
        const before = e.hp;
        fn();
        return before - e.hp;
    };

    /** 属性条目 → 运行时增量（缩放型 int 要过 AttributeScaling，percent 不过） */
    const rt = (attrId, value, mode) => (mode === 'percent' ? value / 100 : AttributeScaling.normalize(attrId, value));

    /* ================= A. 换技能不漏属性（真 bug 的回归测试） ================= */
    console.log('\n【A】换技能不漏属性 —— AbilitySystem.RemoveAbility / Clear');
    {
        const ctx = makeCtx();
        const h = hero(ctx);
        const base4 = h.attrs.get(ATT.AtkSpeed);
        const baseHp = h.getMaxHp();

        // A1 modify_attr 型（104 迅捷）
        h.abilities.AddAbility(104);
        const afterAdd = h.attrs.get(ATT.AtkSpeed);
        nearDelta('A1 挂上 104 后攻速上升', base4, afterAdd, rt(4, 8, 'add'));
        check('A1 挂上 104 后实体上有 1 条技能 Modifier', h.modifiers.getAll().filter((m) => m.origin === 'ability:104').length, 1);

        h.abilities.RemoveAbility(104);
        near('A1 ★ 摘掉 104 后攻速回到基线（漏属性 bug 的回归断言）', h.attrs.get(ATT.AtkSpeed), base4, 1e-9);
        check('A1 摘掉后 origin=ability:104 的 Modifier 清空', h.modifiers.getAll().filter((m) => m.origin === 'ability:104').length, 0);

        // A2 apply_modifier 型（103 嗜血 → 挂 modifier 34）
        h.abilities.AddAbility(103);
        check('A2 挂上 103 后有 1 条嗜血 Modifier', h.modifiers.getAll().filter((m) => m.getId() === 34).length, 1);
        h.abilities.RemoveAbility(103);
        check('A2 ★ 摘掉 103 后嗜血 Modifier 也没了', h.modifiers.getAll().filter((m) => /^ability:103/.test(m.origin ?? '')).length, 0);

        // A3 Clear()（对象池复用路径）
        h.abilities.AddAbility(106);
        h.abilities.AddAbility(130);
        const boosted = h.getMaxHp();
        check('A3 挂两条技能后最大生命变了', boosted !== baseHp, true);
        h.abilities.Clear();
        near('A3 ★ Clear() 后最大生命回到基线', h.getMaxHp(), baseHp, 1e-6);
        check('A3 Clear() 后技能列表为空', h.abilities.getAll().length, 0);

        // A4 摘掉「加最大生命」的技能时，当前生命要跟着钳回（第二个真 bug 的回归断言）
        h.FullHeal();
        h.abilities.AddAbility(106);          // 强健 +12%~+35% 最大生命
        h.FullHeal();                          // 满血，hp == 新的上限
        const hpWithBuff = h.hp;
        check('A4 挂着强健时是满血', Math.abs(hpWithBuff - h.getMaxHp()) < 1e-6, true);
        h.abilities.RemoveAbility(106);
        check('A4 ★ 摘掉强健后 hp 被钳回新上限（不留 hp > maxHp）', h.hp > h.getMaxHp() + 1e-6, false);
        console.log(`     （${Math.round(h.hp)} / ${Math.round(h.getMaxHp())}）`);
    }

    /* ================= B. 6 条技能的 1/2/3 级属性 ================= */
    console.log('\n【B】纯声明式技能的 1/2/3 级属性逐级对上');
    /** 挂上技能 → 逐级 setLevel → 读属性 */
    const probe = (skillId, attrId, mode, levels) => {
        const ctx = makeCtx();
        const h = hero(ctx);
        const base = h.attrs.get(attrId);
        const a = h.abilities.AddAbility(skillId);
        const name = abilities.find((r) => r.id === skillId).name;
        for (const [lv, value] of levels.entries()) {
            a.setLevel(lv + 1);
            const got = h.attrs.get(attrId);
            const expect = mode === 'percent' ? base * (1 + value / 100) : base + rt(attrId, value, mode);
            near(`B ${name} Lv${lv + 1} attr${attrId}`, got, expect, 1e-6);
        }
    };
    probe(104, ATT.AtkSpeed, 'add', [8, 15, 35]);
    probe(105, ATT.AtkRange, 'percent', [12, 20, 45]);
    probe(106, ATT.MaxHp, 'percent', [12, 22, 35]);
    probe(107, ATT.CritRate, 'add', [8, 15, 24]);
    probe(130, ATT.Atk, 'percent', [40, 60, 100]);

    /* ================= C. 107 三阶暴击倍率走 best ================= */
    console.log('\n【C】107 三阶的暴击倍率走 `best`（不是累加）');
    {
        const ctx = makeCtx();
        const h = hero(ctx);
        const base15 = h.attrs.get(ATT.CritDmg);
        console.log(`     （暴击倍率 base = ${base15}）`);
        const a = h.abilities.AddAbility(107);
        a.setLevel(3);
        near('C 三阶暴击倍率 = max(base, 1.7)', h.attrs.get(ATT.CritDmg), Math.max(base15, 1.7), 1e-9);
        check('C 不是累加（若写成 add 会是 base+1.7）', h.attrs.get(ATT.CritDmg) < base15 + 1.7, true);
    }

    /* ================= D. 130 负向 percent 真的压最大生命 ================= */
    console.log('\n【D】130 恶魔契约的负向最大生命');
    {
        const ctx = makeCtx();
        const h = hero(ctx);
        const baseHp = h.getMaxHp();
        const baseAtk = h.attrs.get(ATT.Atk);
        h.abilities.AddAbility(130);
        near('D 一级最大生命 = base × 0.85', h.getMaxHp(), baseHp * 0.85, 1e-6);
        near('D 一级攻击力 = base × 1.40', h.attrs.get(ATT.Atk), baseAtk * 1.4, 1e-6);
        const a = h.abilities.getAbility(130);
        a.setLevel(3);
        near('D 三级最大生命 = base × 0.60', h.getMaxHp(), baseHp * 0.6, 1e-6);
        // 满血买「减最大生命」不能出现 hp > maxHp（脏数据会让 HUD 显示 1200/1000）
        check('D ★ 满血时不会出现 hp > maxHp（脏数据）', h.hp > h.getMaxHp() + 1e-6, false);
        console.log(`     （当前生命 ${Math.round(h.hp)} / 上限 ${Math.round(h.getMaxHp())}）`);
    }

    /* ================= E. 103 嗜血升级会摘掉旧的那条 ================= */
    console.log('\n【E】103 嗜血 1/2/3 级挂 34/35/36，升级摘旧挂新');
    {
        const ctx = makeCtx();
        const h = hero(ctx);
        const a = h.abilities.AddAbility(103);
        const bloodMods = () => h.modifiers.getAll().filter((m) => [34, 35, 36].includes(m.getId()));
        check('E 一级只有 34 一条', bloodMods().map((m) => m.getId()), [34]);
        a.setLevel(2);
        check('E 二级只剩 35（旧的 34 被摘掉）', bloodMods().map((m) => m.getId()), [35]);
        a.setLevel(3);
        check('E 三级只剩 36', bloodMods().map((m) => m.getId()), [36]);
        // 三阶的确实挂在 on_attack_landed 上（而不是随便挂一条同名 Modifier）
        check('E 三级那条挂在 on_attack_landed', (bloodMods()[0].def.events ?? []).map((e) => e.event), ['on_attack_landed']);
    }

    /* ================= F. 103 嗜血真打一下 ================= */
    console.log('\n【F】103 嗜血：真普攻命中 → 真的回血');
    {
        for (const [lv, ratio] of [[1, 0.05], [2, 0.09], [3, 0.14]]) {
            const ctx = makeCtx();
            const h = hero(ctx);
            const a = h.abilities.AddAbility(103);
            a.setLevel(lv);
            const m = monster(ctx);
            // 先把英雄打进残血，否则 Heal 会被最大生命钳住、量不出回复量
            h.ChangeHp(-Math.round(h.getMaxHp() * 0.6));
            const before = h.hp;
            const dmg = h.resolveAttackHit(m, h.getAttackDamage(), DamageType.Physical);
            const healed = h.hp - before;
            near(`F 嗜血 Lv${lv} 回复量 == 本次最终伤害(${dmg}) × ${ratio}`, healed, dmg * ratio, 0.51); // Heal 内部可能取整
        }
    }

    /* ================= G. 配表 ↔ 技能图集 ================= */
    console.log('\n【G】技能 icon 指向的帧真的在图集里');
    /**
     * ⚠ 判据在 2026-10 换过一次：碎图退掉之后，`abilities.icon` 指向的**不再是一个文件**
     *   （`textures/skills/<code>` 已经不存在了），而是 `skills.plist` 里的一个**帧名**。
     *   所以这里改成"读图集帧集 + 逐条核对"，否则 40 条会集体报"文件不存在"。
     */
    const atlasFrames = (() => {
        const p = path.join(RES_DIR, 'textures/skills/skills.plist');
        if (!fs.existsSync(p)) return null;
        const txt = fs.readFileSync(p, 'utf8');
        const set = new Set();
        for (const m of txt.matchAll(/<key>([^<>]+\.png)<\/key>/g)) set.add(m[1]);
        return set;
    })();
    check('G 图集 skills.plist 存在', atlasFrames !== null, true);
    if (atlasFrames) {
        const shopIcons = abilities.filter((r) => r.scope === 'shop' && r.icon)
            .map((r) => `${r.icon.split('/').pop()}.png`);
        const missFrame = shopIcons.filter((n) => !atlasFrames.has(n));
        check(`G 30 个商店技能的 icon 全部在图集里（图集 ${atlasFrames.size} 帧）`, missFrame, []);
    }

    /* ================= H. 30 条技能的战斗效果覆盖（静态对账） ================= */
    console.log('\n【H】30 条商店技能的效果覆盖 + 脚本注册对账');
    {
        const shop = abilities.filter((r) => r.scope === 'shop');
        check('H1 商店技能条数', shop.length, 30);
        const noEffect = shop.filter((r) => !(r.effects?.length > 0) && !r.script_id)
            .map((r) => `${r.id} ${r.name}`);
        check('H2 ★ 每一行都有 effects 或 script_id（上一轮是 30 条全空）', noEffect, []);

        // 每个 apply_modifier 引用的 modifier 必须真的存在
        const modIds = new Set(modifiers.map((r) => r.id));
        const bad = [];
        for (const r of shop) {
            for (const key of ['effects', 'effects_lv2', 'effects_lv3']) {
                for (const e of r[key] ?? []) {
                    if (e.type === 'apply_modifier' && !modIds.has(e.modifier)) bad.push(`${r.id}.${key}→${e.modifier}`);
                }
            }
        }
        check('H3 所有 apply_modifier 引用的 Modifier 都存在', bad, []);

        // 脚本 modifier 的 script_id 必须在 TS 注册表里（漏注册 = 运行时静默降级成普通 Modifier）
        const declared = modifiers.filter((r) => r.script_id).map((r) => r.script_id);
        const notRegistered = declared.filter((s) => !(s in SHOP_SKILL_SCRIPT_CLASSES)
            && !['Modifier_EagleEye', 'Modifier_CounterStorm', 'Modifier_ZeusThunder', 'Modifier_MusketHeadshot'].includes(s));
        check('H4 ★ 所有 script_id（含英雄那 4 个）都能在注册表里找到', notRegistered, []);

        const classNames = Object.keys(SHOP_SKILL_SCRIPT_CLASSES);
        const orphan = classNames.filter((c) => !declared.includes(c));
        check('H5 注册表里没有"没有配表行"的孤儿类', orphan, []);

        // 被动挂的常驻脚本效果写成限时 = "过一会技能就没了"（duration 必须是 -1）
        // 例外是两条挂在**敌人**身上的 DoT（灼烧/毒液）—— 它们本来就该是限时的
        const enemySideDot = [SHOP_MOD.Ignite, SHOP_MOD.Poison];
        const wrongDur = modifiers.filter((r) => classNames.includes(r.script_id)
            && !enemySideDot.includes(r.id) && r.duration !== -1)
            .map((r) => `${r.id} duration=${r.duration}`);
        check('H6 脚本型被动 Modifier 的 duration 都是 -1（永久）', wrongDur, []);
        const dotDur = modifiers.filter((r) => enemySideDot.includes(r.id)).map((r) => r.duration > 0);
        check('H6b 两条敌人侧 DoT 反而是限时的（4 秒）', dotDur, [true, true]);
    }

    /* ================= I. 原因①「要按攻击力算伤害」 ================= */
    console.log('\n【I】按攻击力算伤害：倍率跟着 atk 走，不写死数值');
    {
        // I1 101 分裂弹：追加段数 + 每段伤害
        for (const [lv, count, pct] of [[1, 1, 0.5], [2, 2, 0.6], [3, 3, 0.7]]) {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(101).setLevel(lv);
            const atk = h.getAttackDamage();
            // 普攻本身打掉 atk（护甲/魔抗归零、无暴击）→ 多出来的就是追加段
            const extra = lossOf(m, () => meleeHit(h, m)) - atk;
            near(`I1 101 Lv${lv} 追加 ${count} 段 × ${pct}·atk`, extra, count * Math.round(atk * pct), 1);
        }
        // I1b 攻击力翻倍 → 追加伤害也翻倍（证明它读的是 atk，不是写死数值）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(101);
            const atk = h.getAttackDamage();
            const extra1 = lossOf(m, () => meleeHit(h, m)) - atk;
            h.attrs.setBase(ATT.Atk, atk * 2);
            const atk2 = h.getAttackDamage();
            const extra2 = lossOf(m, () => meleeHit(h, m, atk2)) - atk2;
            near('I1b 攻击力 ×2 → 分裂弹追加伤害 ×2', extra2, extra1 * 2, 1);
        }

        // I2 102 穿透弹：只打「身后 + 锥角内」的，锥角外的不打
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const v = dummy(ctx, 9001, 200);
            const behind1 = dummy(ctx, 9002, 300);
            const behind2 = dummy(ctx, 9003, 400);
            const offAxis = dummy(ctx, 9004, 300, 400);   // 投影 300 / 垂距 400 → 锥角外
            h.abilities.AddAbility(102).setLevel(2);      // count=2 pct=0.72
            const atk = h.getAttackDamage();
            meleeHit(h, v);
            near('I2 102 Lv2 身后第 1 个吃穿透伤害', behind1.getMaxHp() - behind1.hp, Math.round(atk * 0.72), 1);
            near('I2 102 Lv2 身后第 2 个也吃', behind2.getMaxHp() - behind2.hp, Math.round(atk * 0.72), 1);
            near('I2 ★ 102 锥角外的敌人一点没吃', offAxis.getMaxHp() - offAxis.hp, 0, 1e-6);
        }

        // I3 115 榴弹：半径内吃溅射、半径外不吃；伤害随档位涨
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const v = dummy(ctx, 9001, 200);
            const near1 = dummy(ctx, 9002, 260);    // 距中弹者 60px = 1.2m
            const far1 = dummy(ctx, 9003, 400);     // 距中弹者 200px = 4m
            h.abilities.AddAbility(115);
            const atk = h.getAttackDamage();
            meleeHit(h, v);
            near('I3 115 Lv1 半径 1.5m 内的敌人吃 80%·atk', near1.getMaxHp() - near1.hp, Math.round(atk * 0.8), 1);
            near('I3 ★ 115 半径外的敌人不吃', far1.getMaxHp() - far1.hp, 0, 1e-6);
        }

        // I4 119 雷链：跳数与衰减曲线（首跳 100%，之后每跳 ×decay）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const v = dummy(ctx, 9001, 200);
            const c1 = dummy(ctx, 9002, 260);
            const c2 = dummy(ctx, 9003, 320);
            const c3 = dummy(ctx, 9004, 380);
            h.abilities.AddAbility(119).setLevel(2);      // jumps=3 decay=0.6
            const atk = h.getAttackDamage();
            meleeHit(h, v);
            near('I4 119 Lv2 第 1 跳 = 100%·atk', c1.getMaxHp() - c1.hp, atk, 1);
            near('I4 119 Lv2 第 2 跳 = 60%·atk', c2.getMaxHp() - c2.hp, Math.round(atk * 0.6), 1);
            near('I4 119 Lv2 第 3 跳 = 36%·atk', c3.getMaxHp() - c3.hp, Math.round(atk * 0.36), 1);
        }
    }

    /* ================= J. 原因②「要一个条件判断」 ================= */
    console.log('\n【J】条件判断：满血 / 残血 / 满层 —— 声明式动作没有 if');
    {
        // J1 109 首击：满血才触发（**在伤害之前**判定，所以走 on_attack_start 记标记）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const full = dummy(ctx, 9001, 200);
            const hurt = dummy(ctx, 9002, 400);
            hurt.hp = Math.round(hurt.getMaxHp() * 0.5);
            h.abilities.AddAbility(109).setLevel(2);      // pct=0.45
            const atk = h.getAttackDamage();
            near('J1 109 Lv2 满血目标追加 45%·atk', lossOf(full, () => meleeHit(h, full)) - atk, Math.round(atk * 0.45), 1);
            near('J1 ★ 109 残血目标不追加（只吃普攻）', lossOf(hurt, () => meleeHit(h, hurt)) - atk, 0, 1);
        }
        // J2 121 影剪：斩杀线上下
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const above = dummy(ctx, 9001, 200);
            above.hp = Math.round(above.getMaxHp() * 0.5);
            const below = dummy(ctx, 9002, 400);
            below.hp = Math.round(below.getMaxHp() * 0.35);
            h.abilities.AddAbility(121).setLevel(2);      // threshold 0.4 pct 0.3
            const atk = h.getAttackDamage();
            near('J2 121 Lv2 血线之上只吃普攻', lossOf(above, () => meleeHit(h, above)) - atk, 0, 1);
            near('J2 ★ 121 血线之下追加 30%·atk', lossOf(below, () => meleeHit(h, below)) - atk, Math.round(atk * 0.3), 1);
        }
        // J3 120 静电磁场：满 5 层才引爆
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(120);
            const atk = h.getAttackDamage();
            const stacks = [];
            let last = 0;
            for (let i = 0; i < 5; i++) {
                last = lossOf(m, () => meleeHit(h, m));
                stacks.push(m.modifiers.getStackCount(SHOP_MOD.StaticStack));
            }
            // 第 5 次命中的**同一个回调里**就引爆并清空了层数，所以读到的第 5 个值是 0
            check('J3 120 前 4 次命中逐层累积', stacks.slice(0, 4), [1, 2, 3, 4]);
            check('J3 ★ 120 第 5 次命中当场引爆并清空层数', stacks[4], 0);
            near('J3 ★ 120 第 5 次的伤害 = 普攻 + 引爆 150%·atk', last - atk, Math.round(atk * 1.5), 1);
        }
        // J4 117 寒刃：满 3 层冻结
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(117).setLevel(3);      // maxLayers 3 freezeSec 1.5
            const baseMs = m.attrs.get(ATT.MoveSpeed);
            meleeHit(h, m);
            near('J4 117 一层减速 20%（Δ-60）', m.attrs.get(ATT.MoveSpeed), baseMs - 60, 1e-6);
            meleeHit(h, m);
            check('J4 117 Lv3 两次命中后是 2 层', m.modifiers.findByOrigin(SHOP_MOD.FrostSlow, 'ability:117').getStackCount(), 2);
            check('J4 117 Lv3 2 层时还没冻住', m.status.get(Stunned), false);
            near('J4 ★ 117 两层减速 40%（Δ-120，层数真的叠上去了）', m.attrs.get(ATT.MoveSpeed), baseMs - 120, 1e-6);
            meleeHit(h, m);
            check('J4 ★ 117 Lv3 满 3 层时冻结', m.status.get(Stunned), true);
            check('J4 ★ 117 冻结后冰冻层数被清掉', m.modifiers.findByOrigin(SHOP_MOD.FrostSlow, 'ability:117'), undefined);
        }
    }

    /* ================= K. 原因③「要写事件里的可变字段」 ================= */
    console.log('\n【K】护盾/格挡：往 on_block_damage 的 `blocked` 里写数');
    {
        // K1 112 圣盾：池子吸收 + 破池充能
        {
            // ① 小额伤害：完全被吸收（用干净的 ctx，免得池子被前一步预先消耗）
            {
                const ctx = makeCtx();
                const h = hero(ctx);
                const src = dummy(ctx, 9001, 400);
                h.abilities.AddAbility(112);
                const m0 = h.modifiers.find(SHOP_MOD.DivineShield);
                near('K1 112 护盾池 = 最大生命 × 8%', m0.getShieldPool(), h.getMaxHp() * 0.08, 1e-6);
                const small = Math.round(h.getMaxHp() * 0.02);
                near('K1 ★ 112 小额伤害被护盾完全吸收（一点血没掉）',
                    lossOf(h, () => ctx.damagePipeline.ApplyDamage(h, src, small, DamageType.Physical)), 0, 1);
                check('K1 112 吸收后池子按吸收量减少',
                    Math.abs(m0.getShieldPool() - (h.getMaxHp() * 0.08 - small)) < 1e-6, true);
            }
            // ② 破池那一下：只有超出剩余池子的部分打进血里
            {
                const ctx = makeCtx();
                const h = hero(ctx);
                const src = dummy(ctx, 9001, 400);
                h.abilities.AddAbility(112);
                const m0 = h.modifiers.find(SHOP_MOD.DivineShield);
                const pool = m0.getShieldPool();               // 25.6（小数，未被取整）
                const raw = Math.ceil(pool) + 100;             // 保证盖过池子
                const expect = raw - pool;                     // 池子按实际值扣，不取整
                near('K1 ★ 112 破池那一下：只有超出护盾的部分打进血里',
                    lossOf(h, () => ctx.damagePipeline.ApplyDamage(h, src, raw, DamageType.Physical)), expect, 1);
                check('K1 112 破池后池子归零', m0.getShieldPool() <= 1e-6, true);
                h.Tick(7);                                     // recharge 6 秒
                near('K1 112 充能 6 秒后池子回满', m0.getShieldPool(), h.getMaxHp() * 0.08, 1e-6);
            }
        }
        // K2 108 铁壳 l3：概率格挡（把随机数钉住，验两种分支都通）
        {
            /**
             * 这里用 **Pure 伤害**把「格挡」单独隔出来量。
             * 因为 108 三阶还有另一半是**声明式**的 `[6 护甲, +7]`，而护甲是双曲减伤
             * （+7 ≈ 29.6% 物理减免）—— 用物理伤害量格挡，期望值里会混进护甲那一项
             * （第一版就是这么写错的：以为减半是 200，实际 140.8）。
             */
            const build = () => {
                const ctx = makeCtx();
                const h = hero(ctx);
                const src = dummy(ctx, 9001, 400);
                h.abilities.AddAbility(108).setLevel(3);
                return { ctx, h, src, raw: 100 };   // ⚠ 别超过英雄的当前生命（ChangeHp 会钳到 maxHp，量出来的是 320 不是 400）
            };
            const a = build();
            near('K2 108 Lv3 的声明式那半句：护甲 +7', a.h.attrs.get(ATT.Def), 7, 1e-6);
            const blocked = withRandom(0, () => lossOf(a.h, () => a.ctx.damagePipeline.ApplyDamage(a.h, a.src, a.raw, DamageType.Pure)));
            near('K2 ★ 108 Lv3 随机数落在几率内 → 伤害减半', blocked, a.raw * 0.5, 1);
            const b = build();
            const notBlocked = withRandom(0.99, () => lossOf(b.h, () => b.ctx.damagePipeline.ApplyDamage(b.h, b.src, b.raw, DamageType.Pure)));
            near('K2 108 Lv3 随机数落在几率外 → 全额吃下', notBlocked, b.raw, 1);
            check('K2 108 Lv1/Lv2 没有格挡那半句（只有护甲）',
                (abilities.find((r) => r.id === 108).effects ?? []).map((e) => e.type), ['modify_attr']);
        }
    }

    /* ================= L. 原因④「要挂总线事件」 ================= */
    console.log('\n【L】总线事件：on_kill 只 publish、不派发给 Modifier');
    {
        // L1 111 淘金
        for (const [lv, gold] of [[1, 1], [2, 2], [3, 3]]) {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(111).setLevel(lv);
            const before = h.gold;
            const seen = [];
            ctx.bus.on(BattleEvents.OnGoldGained, (e) => seen.push(e.amount));
            ctx.damagePipeline.ApplyDamage(m, h, 1e7, DamageType.Physical);
            check(`L1 111 Lv${lv} 击杀后金币 +${gold}`, h.gold - before, gold);
            check(`L1 111 Lv${lv} 且发了 on_gold_gained（HUD 才会跳）`, seen, [gold]);
        }
        // L1b 收尾：技能摘掉后总线订阅必须也摘掉（否则对象池复用会重复加金）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            h.abilities.AddAbility(111);
            check('L1b 挂上 111 后 bus 上有 1 个 on_kill 订阅', ctx.bus.handlers.get(BattleEvents.OnKill).size, 1);
            h.abilities.RemoveAbility(111);
            check('L1b ★ 摘掉 111 后 on_kill 订阅被 off 干净', (ctx.bus.handlers.get(BattleEvents.OnKill) ?? new Set()).size, 0);
        }
        // L2 122 击杀回响
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const victim = dummy(ctx, 9001, 200);
            const splash = dummy(ctx, 9002, 260);     // 距死者 60px < 1.5m
            h.abilities.AddAbility(122);
            const atk = h.getAttackDamage();
            ctx.damagePipeline.ApplyDamage(victim, h, 1e7, DamageType.Physical);
            near('L2 ★ 122 击杀后在死者位置引发回响', splash.getMaxHp() - splash.hp, Math.round(atk * 1.25), 1);
        }
        // L3 129 时间回廊 —— 唯一一条能真的拦住死亡的技能
        {
            const ctx = makeCtx();
            const h = hero(ctx);
            const src = dummy(ctx, 9001, 400);
            h.abilities.AddAbility(129);
            h.hp = 1000;
            const max = h.getMaxHp();
            ctx.damagePipeline.ApplyDamage(h, src, 1e7, DamageType.Physical);
            check('L3 ★ 129 致命伤被拦下：没死', h.IsDead(), false);
            near('L3 ★ 129 回复到最大生命 × 30%', h.hp, max * 0.3, 1e-6);
            ctx.damagePipeline.ApplyDamage(h, src, 1e7, DamageType.Physical);
            check('L3 ★ 129 冷却内的第二次致命伤不再拦（真的会死）', h.IsDead(), true);
        }
        // L4 125 元素军阵：击杀攒层 → 普攻倾泻
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            h.abilities.AddAbility(125).setLevel(2);      // perKill 3 / max 5 / pctPerStack 0.45
            const legion = h.modifiers.find(SHOP_MOD.ElementalLegion);
            for (let i = 0; i < 3; i++) {
                const k = dummy(ctx, 9100 + i, 200);
                ctx.damagePipeline.ApplyDamage(k, h, 1e7, DamageType.Physical);
            }
            check('L4 125 击杀 3 个攒到 1 层', legion.getStacks(), 1);
            const target = dummy(ctx, 9200, 200);
            const atk = h.getAttackDamage();
            near('L4 ★ 125 普攻倾泻：额外 45%·atk × 1 层',
                lossOf(target, () => meleeHit(h, target)) - atk, Math.round(atk * 0.45), 1);
            check('L4 ★ 125 倾泻后层数清零', legion.getStacks(), 0);
        }
    }

    /* ================= M. 引擎钩子：on_evade ================= */
    console.log('\n【M】闪避事件（本轮补的引擎派发）');
    {
        const ctx = makeCtx();
        const h = noCrit(hero(ctx));
        const attacker = dummy(ctx, 9001, 200);
        h.abilities.AddAbility(127);
        h.attrs.setBase(ATT.Evasion, 100);                 // 闪避 100%
        const seen = [];
        ctx.bus.on(BattleEvents.OnEvade, (e) => seen.push(e.target === h));
        const atkHero = h.getAttackDamage();
        const taken = withRandom(0, () => lossOf(h, () => attacker.resolveAttackHit(h, 500, DamageType.Physical)));
        near('M 闪避成功 → 英雄一点伤害都没吃', taken, 0, 1e-6);
        check('M ★ 闪避时发了 on_evade（并且 target 是闪避者）', seen, [true]);
        near('M ★ 127 Lv1 闪避后反击 150%·atk 打回来源',
            attacker.getMaxHp() - attacker.hp, Math.round(atkHero * 1.5), 1);
    }

    /* ================= N. 层数上限 / 分级切换 ================= */
    console.log('\n【N】层数上限与分级切换（脚本相对 tick_damage 的改进点）');
    {
        // N1 116 燃刃：低档的层数上限由脚本钳住
        for (const [lv, cap] of [[1, 2], [2, 4], [3, 6]]) {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(116).setLevel(lv);
            for (let i = 0; i < 8; i++) meleeHit(h, m);
            check(`N1 116 Lv${lv} 打 8 下后最多叠 ${cap} 层`,
                m.modifiers.findByOrigin(SHOP_MOD.Ignite, 'ability:116').getStackCount(), cap);
        }
        // N2 118 毒刃：DoT 真的随层数放大（配表的 tick_damage 做不到这件事）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            h.abilities.AddAbility(118).setLevel(2);          // dpsPct 0.10
            meleeHit(h, m);
            meleeHit(h, m);
            const atk = h.getAttackDamage();
            const dps = Math.round(atk * 0.1);
            near('N2 ★ 118 每秒伤害 = 单层 dps × 层数（2 层就是两倍）',
                lossOf(m, () => m.Tick(1)), dps * 2, 1);
            near('N2 118 再走 1 秒还是同样的量', lossOf(m, () => m.Tick(1)), dps * 2, 1);
        }
        // N3 换级后 kv 是当前档的，且不会留两条
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 200);
            const a = h.abilities.AddAbility(101);
            a.setLevel(3);
            check('N3 ★ 换级后 origin=ability:101 只有 1 条 Modifier',
                h.modifiers.getAll().filter((x) => x.origin === 'ability:101').length, 1);
            const atk = h.getAttackDamage();
            const extra = lossOf(m, () => meleeHit(h, m)) - atk;
            near('N3 ★ 换级后生效的是三档（3 段 × 70%）', extra, 3 * Math.round(atk * 0.7), 1);
        }
    }

    /* ================= P. 周期性行为（cd 是死代码，只能自己计时） ================= */
    console.log('\n【P】周期性 / 光环：自己 OnTick 计时（modifiers.cd 是死代码）');
    {
        // P1 123 哨兵炮台
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 50);
            h.abilities.AddAbility(123);
            const atk = h.getAttackDamage();
            h.Tick(0.5);
            near('P1 123 不到间隔不开火', m.getMaxHp() - m.hp, 0, 1e-6);
            h.Tick(0.5);
            near('P1 ★ 123 到点自动对最近敌人开火 50%·atk', m.getMaxHp() - m.hp, Math.round(atk * 0.5), 1);
        }
        // P2 128 战旗：自身增伤（声明式）+ 光环破甲（脚本）
        {
            const ctx = makeCtx();
            const h = noCrit(hero(ctx));
            const m = dummy(ctx, 9001, 100);
            h.abilities.AddAbility(128).setLevel(2);
            near('P2 128 Lv2 自身伤害输出 = 1.22', h.attrs.get(ATT.DamageOut), 1.22, 1e-6);
            check('P2 128 Lv2 光环还没扫到，敌人护甲没变', m.attrs.get(ATT.Def), 0);
            h.Tick(1);
            near('P2 ★ 128 Lv2 光环每秒给范围内敌人破甲 3 点', m.attrs.get(ATT.Def), -3, 1e-6);
        }
        // P3 108/110/128 的「l1 没有脚本那半句」—— 保证声明式与脚本的分工没串档
        {
            check('P3 110 过载三档全是纯声明式 modify_attr',
                [110].map((id) => (abilities.find((r) => r.id === id).effects_lv3 ?? []).map((e) => e.type)),
                [['modify_attr']]);
            check('P3 117 的减速模板是声明式（只有满层冻结走脚本）',
                (modifiers.find((r) => r.id === SHOP_MOD.FrostSlow).effects ?? []).map((e) => e.type), ['modify_attr']);
            check('P3 120 的层数是声明式标记行（没有 effects 键 = 纯计数，没有行为）',
                modifiers.find((r) => r.id === SHOP_MOD.StaticStack).effects, undefined);
        }
    }

    /* ================= 汇总 ================= */
    console.log('\n' + '-'.repeat(64));
    if (failures.length === 0) {
        console.log(`✔ 通过 ${passed} 条断言`);
        return 0;
    }
    console.log(`✖ 失败 ${failures.length} 条 / 通过 ${passed} 条：`);
    for (const f of failures) console.log(`   · ${f}`);
    return 1;
};

process.exit(main());
