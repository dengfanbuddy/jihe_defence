#!/usr/bin/env node
/**
 * audit.mjs —— **「属性到底生不生效」体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**配表里给某个属性的词条，运行时真的把那个属性改了吗？**
 *
 * 做法（不是静态扫描，是**真跑一遍链路**）：
 *   把项目里真实的 `Entity` / `AttributeSystem` / `ModifierSystem` / `Modifier` / `DamagePipeline` /
 *   `BattleEquipSystem` / `Tb_RelicConfig` 源码用 TypeScript 的 `transpileModule` 编成 CJS，
 *   只给它们少数「碰 cc / 配表容器」的依赖打桩；然后用**真实配表**
 *   （`units.json` / `attributes.json` / `modifiers.json` / `relics.json`）驱动：
 *     建英雄 → `RelicSystem.AddRelic(真遗物)` → 推进一帧 → 读属性系统里的**运行时值**。
 *
 * 为什么需要它：属性链路是「贡献 → 下次读取时重算」，**配表写对了代码也不一定生效**
 *   —— 已经踩过的三类坑（本工具就是在抓到它们之后落地的）：
 *     ① modifier 的 `duration` 写成 `null`（Excel 空单元格）→ 效果一帧后就被判过期移除；
 *     ② `percent` 落在**基础值为 0** 的属性上（护甲/回血/回蓝）→ `0 × (1+v) = 0`；
 *     ③ 暴击倍率 base = 100 → 1.0，而 `DamagePipeline.rollCrit` 要求 `倍率 > 1` → 全项目永远不暴击。
 *
 * 用法：
 *   node tools/attr-audit/audit.mjs            # 体检 + 结论（有「加了属性却没变」的条目时退出码 1）
 *   node tools/attr-audit/audit.mjs --hero 1001  # 换个体检用的英雄（缺省 1002 赏金猎人）
 *   npm run audit:attr                          # 在 tools/excel_export 下的等价命令
 *
 * 输出的三段：
 *   1. 逐属性表：每个属性挑一件「给得最多」的真遗物买进去，打印 前 ⇒ 后
 *   2. 暴击专项：暴击率/暴击倍率是否真能打出暴击（打 300 次看伤害值是否只有一种）
 *   3. 数据面提示：文案里承诺了属性、但这一侧没有任何效果承载它的遗物（只提示，不影响退出码）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
const SRC = 'assets/scripts/game';

/** 需要编译的真源码（相对 assets/scripts/game） */
const SOURCES = [
    'battle/types.ts',
    'battle/core/Types.ts',
    'battle/core/AttributeScaling.ts',
    'excel_table/EffectTypes.ts',
    'battle/Modifier.ts',
    'battle/AttributeSystem.ts',
    'battle/ModifierSystem.ts',
    'battle/Entity.ts',
    'battle/DamagePipeline.ts',
    'battle/BattleEquipSystem.ts',
    'excel_table/Tb_RelicConfig.ts',
];

/**
 * 打桩：只桩「cc 表现层 / 配表容器 / 注册表」这些与属性结算无关的依赖，
 * 属性链路（Entity → ModifierSystem → AttributeSystem → DamagePipeline）全部走真代码。
 * 路径相对 `assets/scripts`（与真源码同构，内部的相对 require 才解析得到）。
 */
const STUBS = {
    'game/battle/StatusSystem.js': `exports.StatusSystem = class { constructor() {} get() { return false; } canAttack() { return true; } recollect() {} Clear() {} };`,
    'game/battle/AbilitySystem.js': `exports.AbilitySystem = class { constructor() {} Clear() {} AddAbility() {} Tick() {} getAll() { return []; } getCastableSkills() { return []; } UpgradeAbility() { return null; } };`,
    'game/battle/Projectile.js': `exports.Projectile = class { constructor(o) { Object.assign(this, o); } };`,
    'game/battle/ai/AIRegistry.js': `exports.AIRegistry = { create() { return null; } };`,
    'game/battle/BattleContext.js': `exports.BattleContext = class {};`,
    'game/battle/core/BattleConstUtil.js': `exports.BattleConstUtil = { getCollisionRadiusDefault() { return 14; } };`,
    'game/common/EntityVisualConfig.js': `exports.UnitKind = { Normal: 0, Hero: 1 }; exports.getUnitScale = () => 1; exports.resolveUnitKind = () => 0; exports.FINAL_BOSS_STAGE = 5;`,
    'platform/excel_table/TbConfigDecorator.js': `exports.tb_config = () => (cls) => cls;`,
    'platform/excel_table/TbContainer.js': `exports.TbContainer = class {};`,
    // `Tb_RelicConfig.ts` 现在也 import 了 `TbRoot`（局外池查询 `getOuterRelicCfgs` 要用它），
    // 本体检不跑那条链路，给个**只在被调用时才真读表**的最小壳即可（属性结算路径不会碰它）
    'platform/excel_table/TbRoot.js': `
const fs = require('fs');
const path = require('path');
const relics = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'assets/resources/tb/relics.json'), 'utf8'));
exports.TbRoot = { ins: { getTbContainer() { return { cfgs: relics, size: relics.length, getCfgById: (id) => relics.find((r) => r.id === id) }; } } };
`,
};

/**
 * 属性名（报告用）—— **从 `attributes.json` 现读**，不再手写一张表。
 *
 * 为什么改数据驱动（2026-10）：手写表会漂移 —— 局内遗物重做把 12/13 合并成「12 受伤减免（全能）」、
 * 13 退役、新增 21~27（金币获取/经验获取/冷却缩减/抽卡折扣/吸血/攻击回复/攻击回蓝），
 * 手写表既报着不存在的 13、又把 7 个新属性整段漏掉（新属性恰好是最容易"加了却没变"的那批）。
 */
const ATTR_NAME = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(TB_DIR, 'attributes.json'), 'utf8')).map((a) => [a.id, a.name]),
);

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

/** 编译到系统临时目录（不污染仓库），返回可 require 的模块工厂 */
function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-attr-audit-'));
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

// ============================ 真配表 + 假上下文 ============================

const readTb = (name) => JSON.parse(fs.readFileSync(path.join(TB_DIR, `${name}.json`), 'utf8'));
const container = (cfgs) => ({ cfgs, getCfgById: (id) => cfgs.find((c) => c.id === id) });

function makeCtx({ DamagePipeline, Modifier }) {
    const units = readTb('units');
    /**
     * 脚本 Modifier 逃逸口（2026-10 局内遗物重做后必须有）：
     * 遗物的钩子效果是 `modifiers.json` 里 `script_id` 指向 `battle/RelicHooks.ts` 的行，
     * 而 `ModifierSystem.createModifier` 会去 `ctx.scriptRegistry.get(...)` 取类 —— 假上下文没有它就直接抛
     * `Cannot read properties of undefined (reading 'get')`。
     * 属性体检只关心**属性贡献**，钩子逻辑需要真实战斗语义（索敌 / 事件总线 / 伤害管线），在假上下文里跑不起来，
     * 所以这里注入一个**惰性 Modifier 子类**：既不抛错，也不会刷一屏"script_id 未注册"的警告。
     */
    class InertScriptModifier extends Modifier { }
    const ctx = {
        attributeContainer: container(readTb('attributes')),
        modifierContainer: container(readTb('modifiers')),
        abilityContainer: container(readTb('abilities')),
        scriptRegistry: { get: () => InertScriptModifier },
        bus: { publish() { }, onBattleEvent() { return () => { }; } },
        getRelicDef: (id) => readTb('relics').find((r) => r.id === id),
        getUnitDef: (id) => units.find((u) => u.id === id),
        IsRecycled: () => false,
    };
    ctx.damagePipeline = new DamagePipeline(ctx);
    return ctx;
}

// ============================ 体检 ============================

/** 这一侧（局内版）所有属性词条 */
function innerAttrs(relic) {
    return (relic.modifiers_inner ?? []).flatMap((m) => m?.kv?.attrs ?? []);
}

function main() {
    const argv = process.argv.slice(2);
    const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
    const heroId = Number(opt('--hero', '1002'));

    const { out, mod } = build();
    const { Entity } = mod('battle', 'Entity.js');
    const { DamagePipeline } = mod('battle', 'DamagePipeline.js');
    const { RelicSystem } = mod('battle', 'BattleEquipSystem.js');
    const { Modifier } = mod('battle', 'Modifier.js');
    const ctx = makeCtx({ DamagePipeline, Modifier });

    const units = readTb('units');
    const relics = readTb('relics');
    const heroDef = units.find((u) => u.id === heroId && u.category === 'hero');
    if (!heroDef) { console.error(`✖ 找不到英雄 ${heroId}（units.json 的 category=hero）`); process.exit(2); }
    const spawn = (id) => {
        const def = units.find((u) => u.id === id);
        return new Entity(def.id, id, def.name, def.team, ctx, def.base_attributes);
    };

    console.log('▌属性生效体检（tools/attr-audit/audit.mjs）');
    console.log(`  数据：assets/resources/tb 　英雄：#${heroDef.id} ${heroDef.name}` +
        `（攻击 ${(heroDef.base_attributes.find((a) => a[0] === 3) ?? [])[1] ?? 0}）`);
    console.log('  读数是 AttributeSystem 的**运行时值**（百分比型属性已换算成 float，如 0.14 = 14%）');
    console.log('');

    const innerRelics = relics.filter((r) => r.scope === 'inner' || r.scope === 'both');
    const dead = [];

    console.log('| 属性 | 最强词条的那件遗物 | 词条 | 前 ⇒ 后 | 判定 |');
    console.log('|---|---|---|---|---|');
    for (const attrId of Object.keys(ATTR_NAME).map(Number).sort((a, b) => a - b)) {
        const cands = [];
        for (const r of innerRelics) {
            for (const a of innerAttrs(r)) if (a[0] === attrId) cands.push({ r, a });
        }
        if (!cands.length) {
            console.log(`| ${attrId} ${ATTR_NAME[attrId]} | —— | —— | —— | ⚠ 没有任何遗物给这个属性 |`);
            continue;
        }
        cands.sort((x, y) => Math.abs(y.a[1]) - Math.abs(x.a[1]));
        const { r, a } = cands[0];

        const hero = spawn(heroId);
        const before = hero.attrs.get(attrId);
        new RelicSystem(hero, ctx).AddRelic(r.id);
        hero.modifiers.Tick(0.016);                 // 推进一帧：永久效果必须还在（踩过 null duration 的坑）
        const after = hero.attrs.get(attrId);
        const moved = Math.abs(after - before) > 1e-9;
        if (!moved) dead.push({ attrId, relic: r, attr: a, before, after });
        console.log(`| ${attrId} ${ATTR_NAME[attrId]} | #${r.id} ${r.name} [${r.rarity}] | \`${JSON.stringify(a)}\` | ${before} ⇒ **${after}** | ${moved ? '✅' : '❌ 加了却没变'} |`);
    }

    // ---- 暴击专项：属性涨了 ≠ 会暴击 ----
    console.log('');
    console.log('▌暴击专项（暴击率涨了，还得真的能打出暴击）');
    const crit = critProbe(ctx, spawn, heroId, relics, RelicSystem);
    console.log(`  暴击率 = ${crit.rate}　暴击倍率 = ${crit.mult}　`
        + '（`DamagePipeline.rollCrit` 要求 暴击率 > 0 且 倍率 > 1）');
    console.log(`  打了 300 次，出现 ${crit.values.length} 种伤害值：${crit.values.slice(0, 6).join(' / ')}${crit.values.length > 6 ? ' …' : ''}`);
    console.log(crit.mult > 1
        ? '  ✅ 暴击倍率 > 1，暴击率词条能打出高倍伤害'
        : '  ❌ 暴击倍率 ≤ 1 → 暴击永远不会发生（暴击率词条纯装饰）');

    // ---- 数据面提示：文案承诺了属性、但这一侧没有任何效果承载 ----
    console.log('');
    console.log('▌数据面提示（不影响退出码）');
    const descGaps = findDescriptionGaps(relics);
    if (descGaps.length) {
        console.log(`  文案写了属性、但这一侧没有任何 \`modifiers\`（获得后无效果）的遗物：${descGaps.length} 件`);
        for (const g of descGaps.slice(0, 12)) console.log(`    · #${g.id} ${g.name}：${g.terms.join('、')}`);
        if (descGaps.length > 12) console.log(`    ... 其余 ${descGaps.length - 12} 件见 \`npm run check:affix\``);
    } else {
        console.log('  ✅ 没有「文案承诺了属性却没有效果承载」的遗物');
    }

    fs.rmSync(out, { recursive: true, force: true });

    console.log('');
    if (dead.length) {
        console.log(`✖ 体检未通过：${dead.length} 个属性「加了却没变」`);
        for (const d of dead) {
            console.log(`  · ${ATTR_NAME[d.attrId]}：#${d.relic.id} ${d.relic.name} 词条 ${JSON.stringify(d.attr)} → ${d.before} ⇒ ${d.after}`);
        }
        process.exitCode = 1;
    } else {
        console.log('✔ 体检通过：每件给属性的遗物都真的把属性改了，没有「加了却没变」的词条');
    }
}

/** 买一件暴击装 + 打 300 次，看伤害值有几种（只有一种 = 从不暴击） */
function critProbe(ctx, spawn, heroId, relics, RelicSystem) {
    const critRelic = relics.find((r) => innerAttrs(r).some((a) => a[0] === 14));
    const hero = spawn(heroId);
    if (critRelic) {
        new RelicSystem(hero, ctx).AddRelic(critRelic.id);
        hero.modifiers.Tick(0.016);
    }
    const atk = hero.getAttackDamage();
    const values = new Set();
    for (let i = 0; i < 300; i++) {
        const m = spawn(2001);                       // 哥布林（护甲 0，不吃减免干扰）
        values.add(Math.round(ctx.damagePipeline.ApplyDamage(m, hero, atk, 'physical') * 100) / 100);
    }
    return { rate: hero.attrs.get(14), mult: hero.attrs.get(15), values: [...values] };
}

/** 文案提到属性词条、但这一侧一项效果都没有的遗物（等价于 check:affix 的「获得后无任何效果」） */
function findDescriptionGaps(relics) {
    const out = [];
    for (const r of relics) {
        const sides = [];
        if (r.scope === 'inner' || r.scope === 'both') sides.push(['inner', r.description_inner, r.modifiers_inner]);
        if (r.scope === 'outer' || r.scope === 'both') sides.push(['outer', r.description_outer, r.modifiers_outer]);
        for (const [, desc, mods] of sides) {
            if (!desc || (mods ?? []).length || r.script_id) continue;
            // 只报「文案里确实有属性数值」的（纯机制文案如「砍树」不算）
            const terms = String(desc).split(/[，、；|]/)
                .map((s) => s.trim())
                .filter((s) => /^[^0-9]{1,6}\s*[+＋-]?\s*[\d.]+%?(\/s)?$/.test(s));
            if (terms.length) out.push({ id: r.id, name: r.name, terms });
        }
    }
    return out;
}

main();
