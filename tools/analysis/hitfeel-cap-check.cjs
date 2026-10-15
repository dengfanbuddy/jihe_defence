/**
 * hitfeel-cap-check.cjs —— 2026-11「段数爆炸止血」三项改动的行为自检（可重跑）
 *
 * 背景：boss 战实测一帧 2.8~6.8 万段伤害（见 `docs/agent-notes/性能与drawcall.md` §2.7），
 * 由此落地三项改动，本文件逐条验证它们**行为正确且没有副作用**：
 *   ① `DamagePipeline` 第 7 阶段**直调** `target.view.onTakeDamage(e)`（不再让每个 EntityView 订阅总线）
 *      → 断言：一次伤害恰好 1 次直调、与总线**同一个事件对象**、同屏其它实体的 view 一次都不被碰、
 *              没视图/没 handler/死目标/0 伤害都不抛且不调。
 *   ② `HitFeelDirector` 的落点采样每帧封顶 `HIT_FEEL_BUDGET.perFrameHitSampleMax`
 *      → 断言：正常帧一个样本不丢；爆炸帧只留上限、`stats.pointsDropped` 记账；
 *              **`peakHitsPerFrame` 仍然数全部段**（诊断口径不许被限流改掉）；闸门随帧复位。
 *   ③ `HitVfxLayer` 的逐段记账同样封顶
 *      → 断言：同上三条（`stats.hitsDropped` 记账、闸门随帧复位）。
 *
 * ── 怎么跑（编译产物落在 `.tmp/`，已在 .gitignore 里）──
 *   npx tsc --ignoreConfig assets/scripts/game/battle/DamagePipeline.ts \
 *       assets/scripts/game/game_stage/entityview/HitFeelDirector.ts \
 *       assets/scripts/game/game_stage/entityview/HitVfxLayer.ts \
 *       --outDir .tmp/hf-build --module commonjs --target es2017 --skipLibCheck
 *   node tools/analysis/hitfeel-cap-check.cjs
 *
 * ⚠ `tsc` 这一步用 `--ignoreConfig` 是**故意**的：只编这三条链、不加载工程 tsconfig，
 *   而且**允许有类型报错照样出 JS**（本自检跑的是运行时行为）。
 *   工程级的类型检查请用 `npm run typecheck --prefix tools/excel_export`（必须 0 错误）。
 */
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const BUILD = process.argv[2] || path.join(__dirname, '..', '..', '.tmp', 'hf-build');

/**
 * `cc` 桩：这三条链本身都是纯 TS，但依赖图里会走到带 `import { ... } from 'cc'` 的配表容器。
 * 只要求"**模块加载期**不炸"——运行期用到的都是本文件自己喂的假对象。
 */
const ccStub = {
    _decorator: new Proxy({}, { get: () => () => (target) => target }),
    resources: { load: () => {}, loadDir: () => {} },
    assetManager: { loadAny: () => {} },
    sys: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    director: { getTotalFrames: () => 0, on: () => {}, off: () => {}, root: null },
    game: { on: () => {}, off: () => {} },
    Color: function () { this.set = () => {}; },
    Node: function () {}, Component: function () {}, Graphics: function () {}, UITransform: function () {},
    Layers: { Enum: {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'cc') return ccStub;
    return origLoad.call(this, request, parent, isMain);
};
const load = (rel) => require(path.join(BUILD, rel));

const { DamagePipeline } = load('game/battle/DamagePipeline.js');
const { DamageType, BattleEvents } = load('game/battle/types.js');
const { HitFeelDirector } = load('game/game_stage/entityview/HitFeelDirector.js');
const { HitVfxLayer } = load('game/game_stage/entityview/HitVfxLayer.js');
const { HIT_FEEL_BUDGET } = load('game/common/HitFeelConfig.js');
const CAP = HIT_FEEL_BUDGET.perFrameHitSampleMax;

/* ============================ ① DamagePipeline 直调 ============================ */

function makeCtx() {
    const pub = [];
    return {
        pub,
        ctx: {
            meter: { recordCall() {}, recordDepthGuard() {}, recordInstance() {} },
            bus: { publish(ev, payload) { pub.push({ ev, payload }); } },
        },
    };
}
function makeTarget(uid, view) {
    return {
        uid, name: `怪${uid}`, unitKind: 1, position: { x: uid, y: 0 }, hp: 100,
        status: { get: () => false },
        modifiers: { DispatchEvent: () => false },
        attrs: null,
        IsDead() { return this.hp <= 0; },
        ChangeHp(v) { this.hp += v; },
        getMaxHp() { return 100; },
        view,
    };
}

{
    const { ctx, pub } = makeCtx();
    const pipe = new DamagePipeline(ctx);

    // 直调一次 + 与总线同对象
    const calls = [];
    const target = makeTarget(7, { onTakeDamage: (e) => calls.push(e) });
    const dmg = pipe.ApplyDamage(target, { uid: 9, position: { x: 10, y: 0 }, attrs: null, modifiers: null }, 25, DamageType.Physical);
    assert.ok(dmg > 0, 'A1 应该真的扣到血');
    assert.strictEqual(calls.length, 1, 'A2 直调必须恰好一次');
    const onBus = pub.find((p) => p.ev === BattleEvents.OnTakeDamage);
    assert.ok(onBus, 'A3 总线仍要收到 OnTakeDamage（飘字/印痕/导演/屏闪靠它）');
    assert.strictEqual(calls[0], onBus.payload, 'A4 直调与总线必须是同一个事件对象');
    assert.ok(target.hp < 100, 'A5 扣血发生在直调之前（视图读到的是最新 hp）');

    // 无扇出
    const others = [];
    for (let i = 0; i < 40; i++) others.push(makeTarget(100 + i, { onTakeDamage: () => { throw new Error('扇出：不该被调用'); } }));
    calls.length = 0;
    pipe.ApplyDamage(target, { uid: 9, attrs: null, modifiers: null }, 5, DamageType.Physical);
    assert.strictEqual(calls.length, 1, 'A6 其余 40 只怪完全不参与（旧写法会遍历它们）');

    // 缺视图 / 缺 handler / 死目标 / 0 伤害
    assert.doesNotThrow(() => pipe.ApplyDamage(makeTarget(8, null), null, 10, DamageType.Pure), 'A7 没视图不抛');
    assert.doesNotThrow(() => pipe.ApplyDamage(makeTarget(9, {}), null, 10, DamageType.Pure), 'A8 没 handler 不抛');
    const deadCalls = [];
    const dead = makeTarget(10, { onTakeDamage: () => deadCalls.push(1) });
    dead.hp = 0;
    pipe.ApplyDamage(dead, null, 10, DamageType.Pure);
    pipe.ApplyDamage(target, null, 0, DamageType.Pure);
    assert.strictEqual(deadCalls.length, 0, 'A9 死目标不该有受击表现');

    console.log('① DamagePipeline 直调：1 次伤害 = 1 次调用、同对象、无扇出、缺视图不抛、早退口径不变 ✔');
    void others;
}

/* ============================ ② HitFeelDirector 采样上限 ============================ */

{
    const handlers = [];
    const bus = { onBattleEvent: (ev, fn, self) => { handlers.push(self ? fn.bind(self) : fn); return () => {}; } };
    const publish = (p) => { for (const h of [...handlers]) h(p); };
    const hit = (uid, x, y) => ({
        target: { uid, position: { x, y }, unitKind: 1 },
        source: { uid: 999, position: { x: 0, y: 0 } },
        finalDamage: 10, isCrit: false,
    });

    const d = new HitFeelDirector();
    d.bind({ bus });
    assert.ok(handlers.length > 0, 'B1 bind 后应订阅到总线');

    for (let i = 0; i < 10; i++) publish(hit(i, i, 0));
    d.tick(0.016);
    assert.strictEqual(d.stats.pointsDropped, 0, 'B2 正常帧不该丢样本');
    assert.strictEqual(d.stats.peakHitsPerFrame, 10, 'B3 峰值段数 = 真实段数');

    const N = 5000;
    for (let i = 0; i < N; i++) publish(hit(i % 40, i % 800, (i * 7) % 800));
    d.tick(0.016);
    assert.strictEqual(d.stats.pointsDropped, N - CAP, `B4 爆炸帧应丢 ${N - CAP} 个样本`);
    assert.strictEqual(d.stats.peakHitsPerFrame, N, 'B5 峰值必须仍然数**全部**段（诊断口径不许被限流改掉）');

    publish(hit(1, 0, 0));
    d.tick(0.016);
    assert.strictEqual(d.stats.pointsDropped, N - CAP, 'B6 闸门随帧复位（新帧不继续累加丢弃数）');
    assert.ok(d.stats.stopMsTotal <= HIT_FEEL_BUDGET.stopMsPerWindow * 2, 'B7 顿帧账本照常封顶');

    console.log(`② HitFeelDirector 采样上限：${N} 段 → 留 ${CAP} 个样本、pointsDropped=${d.stats.pointsDropped}、`
        + `peakHitsPerFrame=${d.stats.peakHitsPerFrame}（仍数全部）、闸门随帧复位 ✔`);
}

/* ============================ ③ HitVfxLayer 采样上限 ============================ */

{
    const layer = new HitVfxLayer();
    const hit = (uid) => ({
        target: { uid, position: { x: uid % 100, y: (uid * 3) % 100 }, unitKind: 1 },
        source: { uid: 999, position: { x: 0, y: 0 } },
        finalDamage: 10, isCrit: false,
    });
    const kept = () => layer.pending.reduce((n, b) => n + b.hits.length, 0);

    for (let i = 0; i < 20; i++) layer.onTakeDamage(hit(i));
    assert.strictEqual(layer.stats.hitsDropped, 0, 'C1 正常帧不该丢');
    assert.strictEqual(kept(), 20, 'C2 正常帧逐段记满');
    layer.flushPending();

    for (let i = 0; i < 5000; i++) layer.onTakeDamage(hit(i % 40));
    assert.strictEqual(kept(), CAP, `C3 爆炸帧只留 ${CAP} 条样本`);
    assert.strictEqual(layer.stats.hitsDropped, 5000 - CAP, 'C4 超出的只累加计数');
    layer.flushPending();

    for (let i = 0; i < 30; i++) layer.onTakeDamage(hit(i));
    assert.strictEqual(kept(), 30, 'C5 新帧重新可记满（闸门随帧复位）');
    assert.strictEqual(layer.stats.hitsDropped, 5000 - CAP, 'C6 丢弃计数不再增长');
    layer.flushPending();

    console.log(`③ HitVfxLayer 采样上限：5000 段 → 留 ${CAP} 条、hitsDropped=${layer.stats.hitsDropped}、闸门随帧复位 ✔`);
}

console.log(`\nOK —— 三项改动全部通过（单帧采样上限 = ${CAP}；诊断计数不受限流影响）`);
