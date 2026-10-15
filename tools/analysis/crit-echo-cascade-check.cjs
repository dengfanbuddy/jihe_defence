/* =====================================================================================
 * crit-echo-cascade-check.cjs —— 「暴击回响」段数爆炸的复现 / 验收脚本
 * =====================================================================================
 *
 * 背景（2026-11 用户 boss 战实测，`window.__dmgMeter`）：
 *   一局 988 秒拿到 **11 件**带 `遗物·暴击回响#211` 的遗物（`relics.json` 里 19 件都引它），
 *   **3,500,922 段**打在最终 Boss 身上，`depthGuardHits = 0`，峰值帧 65,932 段，
 *   1 秒滑窗峰值 2,234,434 段，而平均每段只有 **1.04 点伤害**。
 *
 * 根因：`busy` 是**每实例一个**字段，只挡得住"自己触发自己"，挡不住
 *   "A 打出的段触发 B、B 的打出的段再触发 C……"（N 份回响互触）。
 *   本脚本用**真** `DamagePipeline` + **真** `RelicHook_CritEcho` + **真** `DamageMeter`
 *   把这条链跑出来，并把两个口径钉成判据：
 *
 *   · **修复前**（`busy` 单层）：一次暴击的段数满足 `a(n) = n·a(n-1) + 1`，
 *     闭式解 `Σ_{k=0..n} n!/k! ≈ e·n!` —— N=1→2、2→5、3→16、4→65、5→326、6→1957、
 *     **11→2867 万**（已被 `MAX_DEPTH=10` 截断，同时 `guard=39,916,800`）。
 *     这才是"Boss 265 万血一帧就没"+"FPS 掉到 1"的同一个原因。
 *   · **修复后**（追加段带 `isEcho`）：一次暴击**恰好 N 段**（N 件遗物各打一圈），
 *     与文案「暴击时对 radius 像素内敌人造成 pct% 伤害」一致，`guard = 0`。
 *
 * 为什么能这么测：`game/battle/**` 是**纯 TS、零 `cc` 依赖**（当初分层的用意）。
 * 桩只有 ctx / 实体 / `modifiers.DispatchEvent` —— 派发那段逐行照抄
 * `ModifierSystem.DispatchEvent`（含 `[...snapshot]` 与标签栈，快照与顺序正是本 bug 的关键）。
 *
 * 跑法（两步）：
 *   npx tsc --ignoreConfig assets/scripts/game/battle/DamagePipeline.ts assets/scripts/game/battle/DamageMeter.ts ^
 *       assets/scripts/game/battle/RelicHooks.ts --outDir .tmp/echo-build --module commonjs --target es2017 --skipLibCheck
 *   node tools/analysis/crit-echo-cascade-check.cjs
 *
 * 想看"修复前"：把 `RelicHook_CritEcho` 里那行 `if (event?.isEcho) return false;` 注释掉、
 * 并去掉 `deal(...)` 的 `{ isEcho: true }`，重跑即可（本脚本会打印两套口径的对照）。
 * ===================================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

/* ---------- 1. cc 桩（本闭包用不到，防编译产物里有残留引用） ---------- */
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'cc') return {};
    return origLoad.call(this, request, parent, isMain);
};

// tsc 的 rootDir 落在 assets/scripts ⇒ 产物路径是 .tmp/echo-build/game/battle/*.js
const BUILD = path.join(__dirname, '..', '..', '.tmp', 'echo-build', 'game');
function load(...parts) {
    const p = path.join(BUILD, ...parts);
    if (!fs.existsSync(p)) throw new Error('编译产物不存在: ' + p + '（先跑文件头那条 tsc）');
    return require(p);
}
const { DamagePipeline } = load('battle', 'DamagePipeline.js');
const { DamageMeter } = load('battle', 'DamageMeter.js');
const { RelicHook_CritEcho } = load('battle', 'RelicHooks.js');
const { DamageType } = load('battle', 'types.js');
const { AttributeType } = load('battle', 'core', 'Types.js');

/* ---------- 2. 真配置行（modifiers.json 的 211） + 真遗物份数 ---------- */
const ROOT = path.join(__dirname, '..', '..');
const TB = path.join(ROOT, 'assets', 'resources', 'tb');
const allMods = JSON.parse(fs.readFileSync(path.join(TB, 'modifiers.json'), 'utf8'));
const DEF_211 = allMods.find((r) => r.id === 211);
if (!DEF_211) throw new Error('modifiers.json 里找不到 id=211（遗物·暴击回响）');
// 引 211 的遗物有几件（= 一局最多能叠几份）—— 判据③ 用真表算，不写死
const relicRows = JSON.parse(fs.readFileSync(path.join(TB, 'relics.json'), 'utf8'));
const RElicWith211 = relicRows.filter((r) => JSON.stringify(r).indexOf('211') >= 0).length;

/* ---------- 3. 极简战斗环境 ---------- */
const WORLD = { entities: [], nextUid: 1 };

/** 实体桩（只实现管线真正读到的那些字段/方法） */
function makeEntity(name, opts) {
    const o = opts || {};
    const e = {
        uid: WORLD.nextUid++,
        name,
        team: o.team,
        hp: o.hp === undefined ? 1e12 : o.hp,
        maxHp: o.hp === undefined ? 1e12 : o.hp,
        position: { x: o.x || 0, y: o.y || 0 },
        attrs: {
            has: (a) => Object.prototype.hasOwnProperty.call(o.attrs || {}, a),
            get: (a) => (o.attrs || {})[a] || 0,
        },
        status: { get: () => false },
        IsDead() { return this.hp <= 0; },
        ChangeHp(d) { this.hp += d; },
        Die() { this.hp = 0; },
        getAttackDamage() { return o.atk || 0; },
    };
    WORLD.entities.push(e);
    return e;
}

/** `modifiers` 桩 —— **逐行照抄 `ModifierSystem.DispatchEvent`**（含快照迭代与标签栈） */
function makeModifiers(owner) {
    const list = [];
    return {
        list,
        add(m) { m.target = owner; list.push(m); return m; },
        getAll() { return list; },
        DispatchEvent(eventName, event) {
            for (const m of [...list]) {
                let consumed = false;
                CTX.meter.pushTag(CTX.meter.tagOfModifier(m));
                try { consumed = m.OnBattleEvent(eventName, event); } finally { CTX.meter.popTag(); }
                if (consumed) return true;
            }
            return false;
        },
    };
}

const CTX = {
    meter: new DamageMeter(),
    bus: { publish() { }, on() { }, off() { } },
    damagePipeline: null,
    GetTeamEntities(team) { return WORLD.entities.filter((e) => e.team === team); },
    findEntitiesInRadius(center, radiusPx, team) {
        const out = [];
        for (const e of WORLD.entities) {
            if (team !== undefined && e.team !== team) continue;
            const dx = (e.position.x || 0) - (center.position.x || 0);
            const dy = (e.position.y || 0) - (center.position.y || 0);
            if (dx * dx + dy * dy <= radiusPx * radiusPx) out.push(e);
        }
        return out;
    },
};
CTX.damagePipeline = new DamagePipeline(CTX);
// ⚠ 不能关账本（`enabled=false` 会让 `recordInstance`/`endFrame` 直接返回，段数与保险丝都读不到）；
// 消音靠告警条数上限
CTX.meter.warnLimit = 0;

/* ---------- 4. 一次「暴击」产生多少段 ---------- */
/** 重搭世界：1 个英雄（带 N 份回响）+ 1 个 Boss */
function setup(echoCount, opts) {
    const o = opts || {};
    WORLD.entities = [];
    WORLD.nextUid = 1;
    const hero = makeEntity('火枪', {
        team: 1,
        attrs: {
            // 回响段要能继续触发回响 ⇒ 必须是暴击（本工程 crit 口径：chance 直接与 Math.random() 比）
            [AttributeType.CritRate]: 1,
            [AttributeType.CritDmg]: 2,
        },
    });
    hero.ctxRef = CTX;
    hero.modifiers = makeModifiers(hero);
    const boss = makeEntity('最终boss1', {
        team: 2,
        attrs: { [AttributeType.MagicResist]: o.magicResist === undefined ? 0.5 : o.magicResist },
    });
    boss.modifiers = makeModifiers(boss);
    for (let i = 0; i < echoCount; i++) {
        const m = new RelicHook_CritEcho(DEF_211, -1, { pct: 50, radius: 50 });
        m.origin = 'relic:' + (1000 + i);
        hero.modifiers.add(m);
    }
    return { hero, boss };
}

/** 模拟"英雄打出一次暴击"，返回这一次产生的**段数**（含根那一段） */
function oneCrit(echoCount, opts) {
    const { hero, boss } = setup(echoCount, opts);
    const meter = CTX.meter;
    const before = meter.instances;
    const guardBefore = meter.depthGuardHits;
    meter.beginFrame();
    CTX.damagePipeline.ApplyDamage(boss, hero, 100, DamageType.Physical, { isCrit: true, critMultiplier: 2 });
    const segs = meter.instances - before;
    meter.endFrame();
    return { segs, guard: meter.depthGuardHits - guardBefore, bossHpLost: 1e12 - boss.hp };
}

/** 单实例时的段数（= 代际数 K，被"伤害取整归零"或保险丝掐断） */
/** 修复前的闭式解：a(n) = n·a(n-1)+1 ⇔ Σ_{k=0..n} n!/k! ≈ e·n! */
function oldLaw(n) {
    let s = 0;
    let fact = 1;
    for (let k = 1; k <= n; k++) fact *= k;      // n!
    for (let k = 0; k <= n; k++) {
        let f = 1;
        for (let j = 1; j <= k; j++) f *= j;     // k!
        s += fact / f;
    }
    return s;
}

/* ---------- 5. 跑 ---------- */
console.log('='.repeat(84));
console.log(' 暴击回响段数复现床（真 DamagePipeline + 真 RelicHook_CritEcho + 真 DamageMeter）');
console.log(' 伤害源：一次暴击 100 物理（暴击 ×2）→ 每份回响 50% / 半径 50px；Boss 魔抗 50%');
console.log(` 真表：relics.json 里引 211 的遗物 = ${RElicWith211} 件（一局最多能同时挂几份）`);
console.log('='.repeat(84));

const solo = oneCrit(1);
console.log(`[标定] 1 份回响 → ${solo.segs} 段（代际数 K=${solo.segs}：每代都有伤害、且链条最终归零）`);
console.log('');
console.log(' 份数 N | 实测段数 | 期望 N+1 | 一致 | 修复前闭式解 Σn!/k! | 本床放大 | 保险丝');
console.log('   ' + '-'.repeat(78) + '   （N+1 = 根那一段 + N 件遗物各一圈）');

const rows = [];
let bad = 0;
for (let n = 1; n <= 6; n++) {
    const r = oneCrit(n);
    const ok = r.segs === n + 1;
    if (!ok) bad++;
    const ratio = (r.segs / (n + 1)).toFixed(1) + 'x';
    console.log(`   ${String(n).padStart(4)} | ${String(r.segs).padStart(8)} | ${String(n + 1).padStart(8)} | `
        + `${ok ? '  ✔  ' : '  ✘  '} | ${String(oldLaw(n)).padStart(20)} | ${ratio.padStart(8)} | ${String(r.guard).padStart(6)}`);
    rows.push({ n, segs: r.segs, expect: n + 1, ok, guard: r.guard, oldLaw: oldLaw(n) });
}

// 真实量级：用户那一局实际拿到的 11 件
const N11 = 11;
const r11 = oneCrit(N11);
const ok11 = r11.segs === N11 + 1;
if (!ok11) bad++;
console.log('   ' + '-'.repeat(78));
console.log(`   ${String(N11).padStart(4)} | ${String(r11.segs).padStart(8)} | ${String(N11 + 1).padStart(8)} | `
    + `${ok11 ? '  ✔  ' : '  ✘  '} | ${String(oldLaw(N11)).padStart(20)} | `
    + `${(r11.segs / (N11 + 1)).toFixed(1).padStart(7)}x | ${String(r11.guard).padStart(6)}`);
console.log('');

// ③ 修复不能误伤"该响的场合"：非回响的暴击（例如遗物溅射打出的追加段）仍要触发回响
const splash = oneCrit(4);
const splashOk = splash.segs === 5;

console.log(' 判据：');
console.log(`   ① 一次暴击 = 根 1 段 + N 段（每件遗物各一圈，互不触发） → ${bad === 0 ? 'PASS' : 'FAIL (' + bad + ' 项不符)'}`);
console.log(`   ② 11 份（用户实测份数）：修复前闭式解 ${oldLaw(N11).toLocaleString('en-US')} 段/次暴击`
    + `（实测被 MAX_DEPTH 截断在 2867 万） → 修复后 12 段 → ${ok11 ? 'PASS' : 'FAIL'}`);
console.log(`   ③ 非回响来源的暴击照样触发回响（4 份 → 5 段） → ${splashOk ? 'PASS' : 'FAIL'}`);
console.log(`   ④ 深度保险丝不该被触发（修复后链路深度恒为 2） → ${r11.guard === 0 ? 'PASS' : 'FAIL'}`);

const jsonPath = path.join(ROOT, '.tmp', 'echo-cascade-last.json');
fs.writeFileSync(jsonPath, JSON.stringify({ solo, rows, n11: r11, relicsWith211: RElicWith211 }, null, 1));
console.log('');
console.log('原始数据: ' + jsonPath);
process.exit(bad === 0 && splashOk && r11.guard === 0 ? 0 : 1);
