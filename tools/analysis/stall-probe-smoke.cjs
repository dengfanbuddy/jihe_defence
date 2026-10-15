/**
 * stall-probe-smoke.cjs —— 用桩对象把 `stall-probe.js` / `stall-probe-mini.js` 各跑一遍
 * （不需要浏览器，不依赖 Cocos）。
 *
 * 为什么要有它：这两个探针是"贴进浏览器控制台"的东西，**改完没法在工程里编译检查**，
 * 所以用桩模拟 `window.cc` / `performance` / `__dmgMeter`，验证三件事：
 *   ① IIFE 跑起来不抛异常（贴进控制台不会炸）；
 *   ② 一个 900ms 的长帧确实被记下来，且那一行带着"段数 / 堆变化 / DC"；
 *   ③ `__stallStop()` / `__mini` 这些出口都在（且 stop 会解绑、还原 console）。
 *
 * 用法： node tools/analysis/stall-probe-smoke.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;

function withStubs(fn) {
    const listeners = [];
    globalThis.window = globalThis;
    globalThis.cc = {
        director: {
            on: (e, cb) => listeners.push(cb),
            off: (e, cb) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
            root: { device: { numDrawCalls: 82, numTris: 516 } },
        },
        Director: { EVENT_AFTER_DRAW: 'after-draw' },
    };
    globalThis.__dmgMeter = { instances: 0, frames: 0 };
    let now = 0;
    globalThis.performance = { now: () => now, memory: { usedJSHeapSize: 50 * 1048576 } };
    /** 推进 n 个 16ms 的帧，然后插一个"巨卡"帧（可选带段数） */
    const frames = (n, segsPerFrame = 3) => {
        for (let i = 0; i < n; i++) {
            now += 16;
            globalThis.__dmgMeter.instances += segsPerFrame;
            globalThis.__dmgMeter.frames++;
            for (const cb of [...listeners]) cb();
        }
    };
    const stall = (ms, segs) => {
        now += ms;
        globalThis.__dmgMeter.instances += segs;
        globalThis.__dmgMeter.frames++;
        for (const cb of [...listeners]) cb();
    };
    const run = (file) => eval(fs.readFileSync(path.join(here, file), 'utf8'));
    try {
        fn({ run, frames, stall, listeners, heap: (mb) => { globalThis.performance.memory.usedJSHeapSize = mb * 1048576; } });
    } finally {
        delete globalThis.cc;
        delete globalThis.__dmgMeter;
        delete globalThis.__stall;
        delete globalThis.__stallLog;
        delete globalThis.__stallReset;
        delete globalThis.__stallStop;
        delete globalThis.__stallData;
        delete globalThis.__stallThresh;
        delete globalThis.__mini;
    }
}

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✗'} ${msg}`); if (!cond) failed++; };

/* ---------------- 完整版 ---------------- */
withStubs(({ run, frames, stall, listeners, heap }) => {
    console.log('== stall-probe.js ==');
    run('stall-probe.js');
    ok(typeof globalThis.__stall === 'function', 'IIFE 装上了 __stall()');
    frames(20);
    heap(30);                       // 堆掉下来 = 刚 GC 过
    stall(900, 5000);               // 一帧 900ms、期间结算 5000 段
    frames(10);
    const out = globalThis.__stall();
    ok(out.frames === 31, `记录了全部 31 帧（实际 ${out.frames}）`);
    ok(out.longFrames === 1, `只把 900ms 那帧算成长帧（实际 ${out.longFrames}）`);
    const row = out.top[0];
    ok(row['耗时ms'] === 900 && row.段数 === 5000 && row.DC === 82, '长帧行带着耗时/段数/DC');
    ok(row['堆变化MB'] === -20, `长帧行记下了堆变化（实际 ${row['堆变化MB']}MB）`);
    ok(globalThis.__stallData.raw.length === 31, '__stallData 里留着原始帧数据');
    globalThis.__stallStop();
    ok(listeners.length === 0, '__stallStop() 解绑了帧回调');
});

/* ---------------- 迷你版 ---------------- */
withStubs(({ run, frames, stall }) => {
    console.log('== stall-probe-mini.js ==');
    run('stall-probe-mini.js');
    ok(typeof globalThis.__mini === 'function', '迷你版装上了 __mini()');
    frames(10);
    stall(700, 4000);
    frames(5);
    const n = globalThis.__mini();
    ok(n === 1, `只抓到那 1 个 700ms 长帧（实际 ${n}）`);
});

console.log(failed === 0 ? '\nOK —— 两个探针的烟测全过' : `\n有 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
