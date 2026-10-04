#!/usr/bin/env node
/**
 * ============================================================
 * 打击感演示台体检（audit）—— node 里"真跑"页面脚本
 * ============================================================
 *
 * 与工程里 `npm run audit:attr` / `npm run audit:slot` 同一套路：
 * **不重写一份逻辑，而是把真源码跑起来做断言**。
 * 这里把 DOM / canvas 2D / requestAnimationFrame 全部打桩，
 * 把 index.html 里的主脚本原样 `vm.runInContext` 跑起来，
 * 再用确定性的 rAF 时间戳驱动它，逐条验证口径。
 *
 * 用法：node tools/hit-feel-preview/audit.mjs
 * 退出码：0 = 全过，1 = 有断言失败
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'index.html');

/* ====================== 断言器 ====================== */
let pass = 0;
const fails = [];
const groups = [];
let curGroup = '';
function g(name) { curGroup = name; groups.push({ name, lines: [] }); }
function ok(name, cond, detail) {
    const line = (cond ? '  ✓ ' : '  ✗ ') + name + (detail ? '   ' + detail : '');
    groups[groups.length - 1].lines.push(line);
    if (cond) pass++; else fails.push(curGroup + ' / ' + name + (detail ? ' — ' + detail : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

/* ====================== 打桩 ====================== */
const ctx2d = new Proxy({}, {
    get(t, k) {
        if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (k in t) return t[k];
        return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
});
const elCache = new Map();
/* ⚠ 桩必须还原 HTML 上的初始 `value` 属性：页面用 `bindParam` 在启动时读滑杆值
   （`P.spawnMax` 等），若桩一律给 '0'，刷怪会被整个关掉 ——
   这条路径就永远跑不到（本脚本第一版正是这么漏掉的）。 */
const htmlSrc = fs.readFileSync(HTML, 'utf8');
function htmlValue(id) {
    const m = htmlSrc.match(new RegExp('id="' + id + '"[^>]*?value="([^"]*)"'));
    return m ? m[1] : '0';
}
function el(tag, initValue) {
    const e = {
        tagName: tag || 'div', children: [], dataset: {}, style: {}, value: initValue == null ? '0' : initValue,
        checked: false, textContent: '', innerHTML: '', className: '', open: false, width: 0, height: 0,
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); },
        },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return el('div'); },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { width: 900, height: 620, left: 0, top: 0, right: 900, bottom: 620 }; },
        getContext() { return ctx2d; },
    };
    return e;
}
const cvEl = el('canvas');
cvEl.parentElement = { getBoundingClientRect: () => ({ width: 900, height: 620 }) };

const html = htmlSrc;
function jsonBlock(id) {
    const m = html.match(new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>'));
    if (!m) throw new Error('找不到 JSON 块: ' + id);
    return m[1];
}
const documentStub = {
    activeElement: null,
    getElementById(id) {
        if (id === 'project-const') return { textContent: jsonBlock('project-const') };
        if (id === 'features') return { textContent: jsonBlock('features') };
        if (id === 'cv') return cvEl;
        if (!elCache.has(id)) elCache.set(id, el(id === 'groups' ? 'div' : 'input', htmlValue(id)));
        return elCache.get(id);
    },
    querySelector() { return el('div'); },
    querySelectorAll() { return []; },
    createElement: el,
};

let rafCb = null;
let rafSeq = 0;
const sandbox = {
    console,
    document: documentStub,
    navigator: {},
    requestAnimationFrame(cb) { rafCb = cb; return ++rafSeq; },
    devicePixelRatio: 1,
    innerWidth: 1400, innerHeight: 900,
    addEventListener() {},
    setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) { console.error('找不到主脚本'); process.exit(1); }
const code = scripts[scripts.length - 1][1];

let bootErr = null;
try { vm.runInContext(code, sandbox, { filename: 'hit-feel-preview/index.html#main' }); }
catch (e) { bootErr = e; }

g('① 启动');
ok('主脚本在打桩环境下无异常启动', !bootErr, bootErr ? bootErr.message : '');
if (bootErr) { report(); process.exit(1); }
const D = sandbox.HIT_FEEL_DEMO;
ok('导出面已挂载 window.HIT_FEEL_DEMO', !!D);

/* 确定性 rAF 驱动 */
let simTs = 1000;
function pump(frames, dtMs) {
    for (let i = 0; i < frames; i++) {
        if (!rafCb) break;
        const cb = rafCb; rafCb = null;
        simTs += dtMs;
        cb(simTs);
    }
}
function pumpBurst(repeat, dtMsFirst) {
    // 模拟 rAF 成簇：一次推进后同一时间戳连续回调 repeat 次
    simTs += dtMsFirst;
    for (let i = 0; i < repeat; i++) { if (!rafCb) break; const cb = rafCb; rafCb = null; cb(simTs); }
}

/* ====================== ② 开关注册表 ====================== */
g('② 开关注册表');
const F = D.FEATURES;
ok('开关总数 = 47', F.length === 47, '实际 ' + F.length);
const cnt = {}; F.forEach(f => cnt[f.g] = (cnt[f.g] || 0) + 1);
ok('分组计数 = A5 B6 C11 D5 E6 F10 G4',
    cnt.A === 5 && cnt.B === 6 && cnt.C === 11 && cnt.D === 5 && cnt.E === 6 && cnt.F === 10 && cnt.G === 4,
    JSON.stringify(cnt));
const ids = F.map(f => f.id);
ok('开关 id 唯一', new Set(ids).size === ids.length);
const have = F.filter(f => f.st === 'have').map(f => f.id);
ok('「工程已有」标记的正是那 3 项（闪白 C1 / 飘字 F1 / 击退 B3）',
    have.length === 3 && ['B3', 'C1', 'F1'].every(i => have.includes(i)), have.join(','));
ok('每项都有 name/en/why/file/note 与默认强度',
    F.every(f => f.name && f.en && f.why && f.file && f.note && typeof f.d === 'number'));

/* ====================== ③ 帧增量守卫 ====================== */
g('③ 帧增量守卫（rAF 成簇不得让仿真跑飞）');
const before = D.now;
pump(300, 16.7);                                   // 300 帧 × 16.7ms = 5.01s
const advanced = D.now - before;
ok('300 帧 × 16.7ms → 仿真推进 ≈ 5.01s', near(advanced, 5.01, 0.12), '实际 ' + advanced.toFixed(3) + 's');

const t0 = D.now;
pumpBurst(50, 16.7);                               // 1 帧正常 + 49 帧同时间戳空转
const burstAdv = D.now - t0;
ok('成簇 50 帧（同时间戳）只推进 1 帧的时间', near(burstAdv, 0.0167, 0.002), '实际 ' + burstAdv.toFixed(4) + 's');

const t1 = D.now;
pump(10, 900);                                     // 超大增量（切回来后追帧）必须被钳到 50ms
const clampAdv = D.now - t1;
ok('单帧增量被钳在 50ms 以内', clampAdv <= 0.5 + 1e-6, '实际 ' + clampAdv.toFixed(3) + 's（10 帧）');

/* ====================== ④ 预设 ====================== */
g('④ 预设与主开关');
D.applyPreset('current');
const onNow = F.filter(f => D.ON(f.id)).map(f => f.id).sort();
ok('「项目当前」预设 = 恰好 B3/C1/F1 三项', onNow.join(',') === 'B3,C1,F1', onNow.join(','));
D.applyPreset('none');
ok('「无打击感」= 47 项全关', F.every(f => !D.ON(f.id)));
D.applyMaster(100);
ok('主开关 100% → 47 项全开且强度全 1', F.every(f => D.ON(f.id) && D.iv[f.id] === 1));
D.applyMaster(0);
ok('主开关 0% → 47 项全关', F.every(f => !D.ON(f.id)));
D.applyPreset('full');
ok('「全开」预设 = 47 项全开', F.every(f => D.ON(f.id)));

/* ====================== ⑤ 47 项逐个单开不炸 ====================== */
g('⑤ 每项独立开关都能真跑（逐个单开 60 帧）');
D.applyPreset('none');
let soloErr = null, soloId = '';
for (const f of F) {
    D.en[f.id] = true; D.iv[f.id] = 1;
    try { pump(60, 16.7); } catch (e) { soloErr = e; soloId = f.id; break; }
    D.en[f.id] = false;
}
ok('47 项逐个单开各跑 60 帧无异常', !soloErr, soloErr ? soloId + ': ' + soloErr.message : '');
D.applyMaster(100);
let allErr = null;
try { pump(120, 16.7); } catch (e) { allErr = e; }
ok('全开 47 项跑 120 帧无异常', !allErr, allErr ? allErr.message : '');
D.applyMaster(0);
let noneErr = null;
try { pump(120, 16.7); } catch (e) { noneErr = e; }
ok('全关跑 120 帧无异常（基线必须是真"无打击感"）', !noneErr, noneErr ? noneErr.message : '');

/* ====================== ⑥ 伤害口径（对齐 DamagePipeline） ====================== */
g('⑥ 伤害口径 = DamagePipeline.applyResistance / rollCrit');
ok('物理 · 护甲 0 → 不减伤', near(D.resistance({ armor: 0 }, 40, 'physical'), 40));
const phys3 = 40 * (1 - (0.06 * 3) / (1 + 0.06 * 3));
ok('物理 · 护甲 3（巨魔）→ 40×0.8475 = 33.90', near(D.resistance({ armor: 3 }, 40, 'physical'), phys3, 1e-9),
    '实际 ' + D.resistance({ armor: 3 }, 40, 'physical').toFixed(4));
ok('物理 · 护甲 12（深海领主）→ 40×0.5814 = 23.26',
    near(D.resistance({ armor: 12 }, 40, 'physical'), 40 * (1 - 0.72 / 1.72), 1e-9));
ok('魔法 · 魔抗 25% → 30', near(D.resistance({ magicResist: 0.25 }, 40, 'magical'), 30));
ok('纯粹 · 无视一切减免', near(D.resistance({ armor: 99, magicResist: 0.9 }, 40, 'pure'), 40));

D.applyPreset('none');
D.resetStage();
D.P.critRate = 0; D.P.critMult = 1.5;
const goblin = D.spawnMonster('goblin', 100, 0);
D.applyHit(D.hero, goblin, 40, { damageType: 'physical' });
D.endFrame();                                      // 死亡在帧末结算（全局通道要合并后再发）
ok('端到端 · 火枪一发 40 物理秒掉哥布林（40HP / 护甲 0）', goblin.dead === true && near(goblin.hp, 0, 0.01),
    'hp=' + goblin.hp.toFixed(3));
ok('hp ≤ 0 之后再打吃不到伤害（口径同 Entity.IsDead）',
    D.applyHit(D.hero, goblin, 40, { damageType: 'physical' }) === 0);
ok('尸体先留在场上（死透的那一帧仍可被表现层读到位置）', D.monsters.includes(goblin));
const aliveBefore = D.monsters.filter(m => !m.dead).length;
D.updateWorld(0.7);                                // 推 0.7s > 0.6s 回收延时
ok('尸体在 0.6s 后回收（对象池口径）', !D.monsters.includes(goblin), '尸体仍在=' + D.monsters.includes(goblin));
ok('回收不影响存活计数', D.monsters.filter(m => !m.dead).length >= aliveBefore - 0);

D.resetStage();
D.P.critRate = 1;                                  // 必暴击 → rollCrit 确定
const troll = D.spawnMonster('troll', 100, 0);
D.applyHit(D.hero, troll, 40, { damageType: 'physical' });
ok('端到端 · 暴击 1.5× 打在护甲 3 上 = 50.85',
    near(240 - troll.hp, 40 * 1.5 * (1 - 0.18 / 1.18), 1e-6), '实际伤害 ' + (240 - troll.hp).toFixed(4));
ok('暴击被 isCrit 标记（飘字才走暴击档）', D.stats.lastPayload.isCrit === true);
D.P.critRate = 0.15;

/* ====================== ⑦ 火枪技能 16 的两件事 ====================== */
g('⑦ 火枪技能 16（5% 额外伤害 + 击退）');
D.applyPreset('none');
D.resetStage();
const t7 = D.spawnMonster('troll', 200, 0);
D.projectiles.length = 0;
D.applyHit(D.hero, t7, D.hero.atk, { damageType: 'physical' });
D.applyHit(D.hero, t7, D.hero.atk * D.PC.hero.headshotPct, { damageType: 'physical' });
ok('额外伤害 = 攻击力 × 5% = 2', near(D.PC.hero.headshotPct, 0.05) && near(D.hero.atk * 0.05, 2),
    'pct=' + D.PC.hero.headshotPct + ' → ' + (D.hero.atk * 0.05));
ok('额外伤害的 rawDamage = 2（可在事件检查器里直接看到）', near(D.stats.lastPayload.rawDamage, 2));
D.texts.length = 0;
D.applyPreset('none'); D.en.F1 = true;
D.addDamageText(t7, Math.round(40 * (1 - 0.18 / 1.18)), false, false, 'physical');
D.addDamageText(t7, Math.max(1, Math.round(2 * (1 - 0.18 / 1.18))), false, false, 'physical');
ok('飘字合并：0.15s 窗口内同目标同档位累加成一条（34+2=36）',
    D.texts.length === 1 && D.texts[0].value === 36,
    '条数=' + D.texts.length + ' 值=' + (D.texts[0] && D.texts[0].value));

/* ====================== ⑧ 击退 ====================== */
g('⑧ 击退（Entity.ApplyKnockback 口径 / pxPerMeter=50）');
ok('pxPerMeter = 50', D.PC.battleConstants.pxPerMeter === 50);
function knockDistance(realRng, kIntensity, hits) {
    D.applyPreset('none');
    D.en.B3 = true; D.iv.B3 = kIntensity;
    D.P.realRng = realRng;
    D.resetStage();
    const m = D.spawnMonster('troll', 100, 0);
    let moved = 0, times = 0;
    for (let i = 0; i < hits; i++) {
        const bx = m.x;
        D.applyHit(D.hero, m, 1, { damageType: 'physical' });
        const d = m.x - bx;
        if (d > 0.001) { moved += d; times++; }
        m.hp = m.maxHp;                             // 不让它死
    }
    return { avg: times ? moved / times : 0, times, n: hits };
}
const kbDemo = knockDistance(false, 1, 5);
ok('演示模式 · 必触发、距离 = 50×3m×100% = 150px', kbDemo.times === 5 && near(kbDemo.avg, 150, 0.01),
    '触发 ' + kbDemo.times + '/5 平均 ' + kbDemo.avg.toFixed(2) + 'px');
const kbHalf = knockDistance(false, 0.5, 5);
ok('演示模式 · 强度 50% → 75px（强度就是距离）', near(kbHalf.avg, 75, 0.01), kbHalf.avg.toFixed(2) + 'px');
const kbReal = knockDistance(true, 1, 400);
const rate = kbReal.times / kbReal.n;
ok('真实概率模式 · 距离 ≤ 1m(50px)', kbReal.times === 0 || kbReal.avg <= 50.001, '平均 ' + kbReal.avg.toFixed(2) + 'px');
ok('真实概率模式 · 触发率 ≈ 15%（±6%）', Math.abs(rate - 0.15) < 0.06, (rate * 100).toFixed(1) + '% / 400 次');
D.P.realRng = false;
ok('英雄不被推动（immovable 口径）', (() => {
    D.applyPreset('none'); D.en.B3 = true; D.iv.B3 = 1;
    D.resetStage();
    const hx = D.hero.x, hy = D.hero.y;
    const m = D.spawnMonster('troll', 300, 0);
    D.applyHit(m, D.hero, 16, { damageType: 'physical' });
    return near(D.hero.x, hx) && near(D.hero.y, hy);
})());

/* ====================== ⑨ 顿帧 ====================== */
g('⑨ 顿帧 / 慢动作（时间缩放，倒计时走真实时间）');
D.applyPreset('none'); D.en.A2 = true; D.iv.A2 = 1;
D.setTimeOverride(0.03, 0.08);
ok('顿帧被触发（clock.scale < 1）', D.clock.scale < 1 || D.clock.forcedT > 0);
pump(2, 16.7);
ok('顿帧生效中：战斗时间被缩放', D.clock.scale < 0.5, 'scale=' + D.clock.scale);
pump(10, 16.7);
ok('顿帧会自己结束（计数走真实时间，不会卡死）', D.clock.scale === 1, 'scale=' + D.clock.scale);

/* ====================== ⑩ 多目标合并（塔防关键） ====================== */
g('⑩ 多目标表现合并 G2（塔防同帧 AoE）');
function aoeRings(merge) {
    D.applyPreset('none');
    D.en.C4 = true; D.iv.C4 = 1;
    D.en.G2 = merge;
    D.en.G3 = false;                               // 关预算，避免被上限截断干扰计数
    D.resetStage();
    D.vfx.ring.length = 0;
    D.monsters.length = 0;
    const list = [];
    for (let i = 0; i < 20; i++) list.push(D.spawnMonster('goblin', 200 + i * 3, 20));
    list.forEach(m => D.applyHit(D.hero, m, 45, { damageType: 'physical' }));
    D.endFrame();
    return { rings: D.vfx.ring.length, kills: list.filter(m => m.dead).length };
}
const mergedRings = aoeRings(true);
ok('G2 开 · 20 只同帧命中只出 1 个冲击波', mergedRings.rings === 1, '实际 ' + mergedRings.rings);
ok('20 只哥布林（40HP/护甲0）被 45 物理全灭', mergedRings.kills === 20, '实际 ' + mergedRings.kills);
const splitRings = aoeRings(false);
ok('G2 关 · 同样的 20 只变成 20 个冲击波（噪音源就在这里）', splitRings.rings === 20, '实际 ' + splitRings.rings);

g('⑪ 分级 + 钳制 D5');
D.applyPreset('none'); D.en.D1 = true; D.iv.D1 = 0.45; D.en.D5 = false;
D.resetStage(); D.cam.shakeA = 0;
for (let i = 0; i < 10; i++) { const m = D.spawnMonster('goblin', 200, 0); D.applyHit(D.hero, m, 45, {}); D.endFrame(); }
const unclamped = D.cam.shakeA;
D.applyPreset('none'); D.en.D1 = true; D.iv.D1 = 0.45; D.en.D5 = true;
D.resetStage(); D.cam.shakeA = 0;
for (let i = 0; i < 10; i++) { const m = D.spawnMonster('goblin', 200, 0); D.applyHit(D.hero, m, 45, {}); D.endFrame(); }
const clamped = D.cam.shakeA;
ok('D5 关（相加）的震幅显著大于 D5 开（取最大）', clamped < unclamped,
    '取最大 ' + clamped.toFixed(2) + 'px < 相加 ' + unclamped.toFixed(2) + 'px');
D.en.G1 = true;
ok('分级：普通怪预算 0.6 / 最终 Boss 1.5（关分级则一律 1.6）',
    near(D.tierCap({ kind: 'normal' }), 0.6) && near(D.tierCap({ kind: 'final_boss' }), 1.5),
    'normal=' + D.tierCap({ kind: 'normal' }) + ' final_boss=' + D.tierCap({ kind: 'final_boss' }));
D.en.G1 = false;
ok('关掉 G1 → 普通怪也拿满预算 1.6', near(D.tierCap({ kind: 'normal' }), 1.6));
D.en.G1 = true;

/* ====================== ⑫ VFX 预算 G3 ====================== */
g('⑫ VFX 预算 G3');
D.applyPreset('none'); D.en.C5 = true; D.iv.C5 = 1; D.en.C6 = true; D.iv.C6 = 1;
D.en.G3 = true; D.iv.G3 = 1;
D.resetStage();
D.vfx.spark.length = 0; D.vfx.part.length = 0; D.budget.dropped = 0;
for (let i = 0; i < 60; i++) { const m = D.spawnMonster('troll', 200 + i, 0); D.applyHit(D.hero, m, 1, {}); }
ok('G3 开 · 火花不超上限 24', D.vfx.spark.length <= 24, '实际 ' + D.vfx.spark.length);
ok('G3 开 · 粒子不超上限 120', D.vfx.part.length <= 120, '实际 ' + D.vfx.part.length);
ok('G3 开 · 超限有丢弃计数（预算真的在拦）', D.budget.dropped > 0, '丢弃 ' + D.budget.dropped);
D.en.G3 = false;
D.vfx.spark.length = 0;
for (let i = 0; i < 60; i++) { const m = D.spawnMonster('troll', 400 + i, 0); D.applyHit(D.hero, m, 1, {}); }
ok('G3 关 · 无上限（为"爆表"演示保留）', D.vfx.spark.length > 24, '实际 ' + D.vfx.spark.length);

/* ====================== ⑬ 飘字上限与颜色通道 ====================== */
g('⑬ 飘字（DamageTextLayer 口径）');
ok('基准字号 = 16（工程值）', D.PC.damageText.baseFontSize === 16);
ok('并发上限 = 24', D.PC.damageText.maxAlive === 24);
ok('合并窗口 = 0.15s', near(D.PC.damageText.mergeWindow, 0.15));
D.applyPreset('none'); D.en.F1 = true;
D.resetStage();
D.texts.length = 0;
for (let i = 0; i < 60; i++) {
    const m = D.spawnMonster('troll', 100 + i * 40, 0);      // 位置不同 → 不会互相合并
    D.addDamageText(m, 10, false, false, 'physical');
}
ok('并发上限生效：60 次不同目标的飘字被压到 ≤ 24', D.texts.length <= 24, '实际 ' + D.texts.length);
const mkTarget = () => ({ uid: 9001, x: 0, y: 0 });
ok('默认配色 = 打谁（白）', D.texts.length >= 0 && (() => {
    D.texts.length = 0;
    D.addDamageText(mkTarget(), 10, false, false, 'physical');
    return D.texts[0] && D.texts[0].heroHurt === false;
})());
ok('英雄受击 → heroColor 红（颜色通道 = 打谁）', (() => {
    D.texts.length = 0;
    D.addDamageText(mkTarget(), 10, false, true, 'physical');
    return D.texts[0] && D.texts[0].heroHurt === true;
})());
ok('暴击档 = 1.6× 字号 + 左侧菱形标（marker 0.24）', (() => {
    D.texts.length = 0;
    const t = mkTarget(); t.uid = 9002;
    D.addDamageText(t, 60, true, false, 'physical');
    const it = D.texts[0];
    return it && near(it.scale, 1.6) && near(it.marker, 0.24) && it.pop === 1.4;
})());
D.applyPreset('none');

/* ====================== ⑭ 常量与工程真源 ====================== */
g('⑭ 常量快照 = 工程真源');
const pc = D.PC;
ok('hitFlashDuration = 0.08（EntityVisualConfig.HIT_FLASH_DURATION）', near(pc.hitFlashDuration, 0.08));
ok('单位配色 7 类齐全', Object.keys(pc.unitVisuals).length === 7);
ok('普通怪 6B8E9B ×1 / 受击白', pc.unitVisuals.normal.color === '#6b8e9b' && pc.unitVisuals.normal.hitColor === '#ffffff');
ok('最终 Boss 3B1C32 ×2 / 受击青', pc.unitVisuals.final_boss.color === '#3b1c32' && pc.unitVisuals.final_boss.scale === 2);
ok('英雄不染底、受击 FF4C4C', pc.unitVisuals.hero.color === null && pc.unitVisuals.hero.hitColor === '#ff4c4c');
ok('火枪 = 1001 / 攻击 40 / 攻速 1.2 / 射程 250 / 最远索敌', pc.hero.id === 1001 && pc.hero.atk === 40 && pc.hero.atkRange === 250 && pc.hero.attackTargeting === 'farthest');
ok('火枪实际攻击间隔 = 1 / 1.2 = 0.833s', near(pc.hero.attackInterval / pc.hero.atkSpeed, 0.8333, 0.0001));
ok('暴击倍率 base 150 = 1.50×（critDmgBase 0.5）', near(pc.battleConstants.critDmgBase + 1, 1.5) && near(1 + pc.battleConstants.critDmgBase, 1.5));
ok('哥布林 = 2001 / 40HP / 护甲 0 / 攻击 0（打不出伤害）',
    pc.monsters.goblin.maxHp === 40 && pc.monsters.goblin.armor === 0 && pc.monsters.goblin.atk === 0);
ok('美术底色 = 局内 #EBF4FB / 描边 #14181B / HUD 条 #70ACB3',
    pc.art.battleBg === '#EBF4FB' && pc.art.outline === '#14181B' && pc.art.hpBar === '#70ACB3');
ok('弹道速度 = 600（projectileSpeedDefault）', pc.battleConstants.projectileSpeedDefault === 600);

/* ====================== ⑮ 长时间稳定性 ====================== */
g('⑮ 长时间稳定性（模拟真实游玩 60s）');
D.resetStage();                                    // 先清掉前面测试手工塞进去的怪
D.applyMaster(100);
let longErr = null;
try { pump(3600, 16.7); } catch (e) { longErr = e; }
ok('全开连续跑 3600 帧（≈60s）无异常', !longErr, longErr ? longErr.message : '');
const aliveNow = D.monsters.filter(m => !m.dead).length;
const corpse = D.monsters.length - aliveNow;
ok('活着的怪受"同屏怪数"门控（≤ 上限 + 1）', aliveNow <= 6, '存活 ' + aliveNow + ' / 上限 5');
ok('尸体不堆积（0.6s 内回收）', corpse <= 4, '尸体 ' + corpse + '（总 ' + D.monsters.length + '）');
ok('飘字并发始终 ≤ 24', D.texts.length <= 24, '实际 ' + D.texts.length);
ok('特效并发有界（G3 开）', D.vfx.spark.length + D.vfx.part.length + D.vfx.ring.length < 600,
    '实际 ' + (D.vfx.spark.length + D.vfx.part.length + D.vfx.ring.length));
ok('英雄不会被打死（演示场：HP 钳在 ≥ 1）', D.hero.hp >= 1, 'hp=' + D.hero.hp.toFixed(2));
ok('刷怪真的在跑（滑杆值被正确读成 5 只）', D.P.spawnMax === 5 && D.monsters.length > 0,
    'spawnMax=' + D.P.spawnMax + ' 场上 ' + D.monsters.length + ' 只');
ok('hero 真的在输出（60s 内有命中与击杀）', D.stats.hits > 0 && D.stats.kills > 0,
    '命中 ' + D.stats.hits + ' 击杀 ' + D.stats.kills);

/* ====================== 报告 ====================== */
function report() {
    console.log('\n打击感演示台体检 —— node 里真跑 index.html 的主脚本\n' + '='.repeat(66));
    groups.forEach(gr => { console.log('\n' + gr.name); gr.lines.forEach(l => console.log(l)); });
    console.log('\n' + '='.repeat(66));
    console.log('通过 ' + pass + ' 条' + (fails.length ? '，失败 ' + fails.length + ' 条：' : '，全部通过'));
    fails.forEach(f => console.log('  ✗ ' + f));
}
report();
process.exit(fails.length ? 1 : 0);
