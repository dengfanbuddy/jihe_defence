/**
 * damage-meter-cache-check.cjs —— `DamageMeter` 目标键缓存的行为 + 成本自检（2026-11 加缓存时建的）
 *
 * 背景：`DamageMeter.recordInstance` 是**每一段伤害**都会走的调用，原来每次都现拼
 * `${名字}#${uid}` 再丢给 `Map.get`（临时字符串只做键、随即被丢）。2026-11 改成
 * 按实体缓存（`WeakMap` + 现名比对，见那个 `targetCache` 的注释）。
 *
 * 这个脚本做两件事：
 *   ① **行为等价**：键格式（`名字#uid`）、池化复用改名后的失效、无名目标的 `unit#<id>` 兜底、
 *      非对象目标的兜底 —— 都要与"每段现拼字符串"的旧实现逐字一致；
 *   ② **成本实测**：顺带量一下"旧写法（每段拼字符串）vs 新写法（WeakMap 命中）"的
 *      CPU 与堆增长，用来**判断它到底值不值得**（结论见文件末尾的实测值）。
 *
 * 用法（两步，`tsc` 只编这两个纯 TS 文件 —— 它们不依赖 cc）：
 *   npx tsc --ignoreConfig assets/scripts/game/battle/DamageMeter.ts assets/scripts/game/battle/types.ts \
 *       --outDir .tmp/dc-build --module commonjs --target es2017 --skipLibCheck
 *   node tools/analysis/damage-meter-cache-check.cjs .tmp/dc-build
 *
 * （编译产物落在 `.tmp/` 下 —— 那个目录已在 `.gitignore` 里，别改到 `tools/` 里面去。）
 */
const path = require('node:path');
const assert = require('node:assert');

const buildDir = process.argv[2] || path.join(__dirname, '..', '..', '.tmp', 'dc-build');
const { DamageMeter } = require(path.join(__dirname, path.relative(__dirname, path.resolve(buildDir, 'DamageMeter.js'))));

/* ============================ ① 行为等价 ============================ */

const m = new DamageMeter();

// A. 键格式：名字#uid（报告与控制台都按它读，不许改）
const t = { uid: 7, name: '哥布林', id: 2001 };
m.recordInstance(t, 10);
assert.deepStrictEqual([...m.byTarget.keys()], ['哥布林#7'], 'A 键格式');
assert.strictEqual(m.instances, 1);
assert.strictEqual(m.damage, 10);

// B. 快路径：同一目标 + 同一现名 → 直接返回同一条缓存（0 分配）
assert.strictEqual(m.targetInfoOf(t), m.targetInfoOf(t), 'B 快路径命中');

// C. 池化复用改名 → 必须失效（否则报告会认错人；旧实现天然是对的）
t.name = '巨魔';
m.recordInstance(t, 5);
assert.deepStrictEqual([...m.byTarget.keys()].sort(), ['哥布林#7', '巨魔#7'], 'C 改名后各自成桶');

// D. 无名目标 → unit#<id> 兜底
m.recordInstance({ uid: 8, id: 2002 }, 1);
assert.ok(m.byTarget.has('unit#2002#8'), 'D 无名兜底');

// E. 非对象目标 → 未知目标#-1（与旧实现一致）
m.recordInstance(null, 1);
m.recordInstance(undefined, 1);
assert.ok(m.byTarget.has('未知目标#-1'), 'E 非对象兜底');

// F. 帧边界 / 峰值 / 告警上限仍然工作
const m2 = new DamageMeter();
m2.beginFrame();
for (let i = 0; i < 5; i++) m2.recordInstance(t, 2);
m2.recordInstance(undefined, 1);
m2.endFrame();
assert.strictEqual(m2.peak.instances, 6, 'F 单帧段数峰值');

console.log('① 行为等价：全部断言通过（键格式 / 改名失效 / 两种兜底 / 帧账本）');

/* ============================ ② 成本实测 ============================ */

const N = 2000000;
const hot = { uid: 7, name: '哥布林', id: 2001 };

/** 旧写法：每段现拼 `<名字>#<uid>` */
function oldPath(target) {
    const name = (typeof target.name === 'string' && target.name.length > 0) ? target.name
        : ((target.id === undefined || target.id === null) ? '未知目标' : `unit#${target.id}`);
    return `${name}#${target.uid ?? -1}`;
}
/** 新写法：WeakMap + 现名比对 */
const cache = new WeakMap();
function newPath(target) {
    const raw = (typeof target.name === 'string' && target.name.length > 0) ? target.name : '';
    const hit = cache.get(target);
    if (hit !== undefined && hit.raw === raw) return hit;
    const label = raw !== '' ? raw : ((target.id === undefined) ? '未知目标' : `unit#${target.id}`);
    const info = { raw, label, key: `${label}#${target.uid ?? -1}` };
    cache.set(target, info);
    return info;
}
const bench = (label, fn) => {
    const h0 = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    let sink = 0;
    for (let i = 0; i < N; i++) {
        const k = fn(hot);
        sink += (typeof k === 'string' ? k.length : k.key.length);
    }
    const ms = Date.now() - t0;
    const h1 = process.memoryUsage().heapUsed;
    console.log(`② ${label}：${ms}ms / ${N} 段（${(ms * 1e6 / N).toFixed(1)}ns 每段），`
        + `堆增长 ${((h1 - h0) / 1048576).toFixed(1)}MB，sink=${sink}`);
};
bench('旧（每段拼字符串）', oldPath);
bench('新（WeakMap 缓存）  ', newPath);

/**
 * 实测结论（2026-11，Node 24 / V8）：
 *   · 旧写法 2M 段 ≈ 9ms、堆 +0.3MB；新写法 ≈ 24ms、堆 +0MB。
 *   ⇒ **这条不是瓶颈**：V8 的年轻代处理"短命小字符串"几乎免费，缓存反而让每次调用慢 ~7ns
 *     （换算到"一帧 1 万段"= 0.07ms，噪声级）。
 *   ⇒ 保留它的理由**不是性能**，而是与工程既有纪律一致（`DamageMeter` 文件头与 `RelicHooks`
 *     都写着"热路径不现拼字符串"）。**排查 FPS 掉到 1 时别再从这条路上找 GC** ——
 *     要用 `tools/analysis/stall-probe.js` 看长帧那一行到底是"段数"还是"console"。
 */
