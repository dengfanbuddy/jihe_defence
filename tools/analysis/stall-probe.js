/**
 * stall-probe.js —— **长帧探针**（贴进浏览器控制台用，不进 assets/）
 *
 * 解决什么问题：profiler 只告诉你"Game Logic 2ms / Renderer 1ms / 帧耗时 37ms"，
 * 剩下那几十毫秒（以及偶发的 1 秒）**它量不到** —— GC、DevTools 控制台、贴图上传、
 * 一次性重活都在这些格子之外。本探针**在每一帧上打点**，把"这一帧为什么长"直接记账：
 *
 *   · 帧耗时（超过阈值就单独记一条）
 *   · 这一帧的段数（`__dmgMeter.instances` 的增量 ← 段数爆炸的直接证据）
 *   · 这一帧里 console 调用的次数 + 重复最多的几条（DevTools 刷屏的证据）
 *   · 这一帧前后的 JS 堆（`performance.memory`，Chrome 才有）：**堆掉下来 = 刚发生 GC**
 *   · 这一帧的 draw call / 三角形（`device.numDrawCalls / numTris`）
 *
 * 用法（**浏览器** DevTools 的 Console 里贴，不是 Node）：
 *   __stall()        → 帧耗时分位（中位/p95/最长）+ 最长的 20 帧（含上面每一列）
 *   __stallLog()     → 打印 console 刷屏榜（哪条日志、刷了多少次）
 *   __stallThresh    → 长帧阈值，缺省 80（毫秒）；控制台里直接改，例如 `__stallThresh = 40`
 *   __stallData      → 原始数据（`{rows, raw}`；关掉 DevTools 期间照样在记）
 *   __stallReset()   → 清空记录
 *   __stallStop()    → 停止记录并还原 console
 *
 * 建议流程：贴完后**关掉 DevTools** 打一场（DevTools 自己也要吃性能）→ 卡过之后按 F12 →
 * 输入 `__stall()`。数据一直在记，重开面板不影响。
 *
 * 判据速查：
 *   长帧那一行 `段数` 上千 + `堆` 明显下跌   ⇒ 伤害段数爆炸 → GC 停顿（改段数，不是改 draw call）
 *   长帧那一行 `console` 几十上百          ⇒ DevTools 控制台被刷屏（去掉热路径日志）
 *   长帧行 `DC` 只有几十、`三角` 几百       ⇒ **与渲染无关**，别去优化 draw call
 *   中位数就已经 >30ms                     ⇒ 不是"偶发长帧"，是每帧都慢 ⇒ 找每帧都做的事
 */
(() => {
    const cc = (typeof window !== 'undefined' ? window.cc : undefined) ?? globalThis.cc;
    if (!cc?.director) {
        console.error('[stall] 找不到 window.cc —— 这个探针只能在**浏览器**里跑（Creator 的浏览器预览、'
            + '或构建出来的 web 包），不能在编辑器模拟器/原生窗口里跑，也不是 Node 脚本。'
            + '先确认 `cc` 存在：在控制台输入 cc 回车，应该打印出引擎模块对象。');
        return;
    }
    if (window.__stallStop) window.__stallStop();
    if (!cc.director.on || !cc.Director?.EVENT_AFTER_DRAW) {
        console.error('[stall] 拿不到 cc.Director.EVENT_AFTER_DRAW（引擎版本不匹配？）');
        return;
    }

    // 长帧阈值：控制台里改 `__stallThresh = 40` 立刻生效（缺省 80ms）
    window.__stallThresh = window.__stallThresh || 80;
    const MAX_ROWS = 400;         // 最多留多少条长帧
    const rows = [];
    const raw = [];               // 全部帧（含正常帧），用于"平均值/百分位"

    // ---- console 计数（只计数，不改行为；`__stallStop` 会还原）----
    const orig = {};
    const logCount = new Map();   // 日志（前 60 字）→ 次数
    let consoleInFrame = 0;
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        orig[k] = console[k];
        console[k] = function (...args) {
            try {
                consoleInFrame++;
                const s = String(args[0]).slice(0, 60);
                // 本探针自己的日志不计入刷屏榜（否则一打印表格就把自己算进去）
                if (!s.startsWith('[stall]') && !s.startsWith('%c[stall]') && s[0] !== '┌') {
                    logCount.set(s, (logCount.get(s) ?? 0) + 1);
                }
            } catch (e) { /* 计数失败不许影响日志本身 */ }
            return orig[k].apply(console, args);
        };
    }

    const meter = () => window.__dmgMeter ?? null;
    const heap = () => (typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize : 0);
    const dev = () => cc.director.root?.device ?? null;

    let last = performance.now();
    let lastInst = meter()?.instances ?? 0;
    let lastHeap = heap();

    const onDraw = () => {
        const now = performance.now();
        const dt = now - last;
        const m = meter();
        const inst = m?.instances ?? 0;
        const h = heap();
        const seg = inst - lastInst;
        raw.push(dt);
        if (raw.length > 6000) raw.shift();
        if (dt >= (window.__stallThresh || 80)) {
            const d = dev();
            rows.push({
                帧: m?.frames ?? 0,
                '耗时ms': Math.round(dt),
                段数: seg,                              // ← 这一帧结算了多少段伤害
                堆MB: h ? +(h / 1048576).toFixed(1) : 0,
                '堆变化MB': h ? +((h - lastHeap) / 1048576).toFixed(1) : 0, // 负数大 = 刚 GC 过
                console: consoleInFrame,
                DC: d ? d.numDrawCalls : 0,
                三角: d ? d.numTris : 0,
            });
            if (rows.length > MAX_ROWS) rows.shift();
        }
        last = now; lastInst = inst; lastHeap = h; consoleInFrame = 0;
    };
    cc.director.on(cc.Director.EVENT_AFTER_DRAW, onDraw);

    /** 分位数（只用于打印，帧数上万也不慢） */
    const percentile = (arr, p) => {
        if (!arr.length) return 0;
        const a = [...arr].sort((x, y) => x - y);
        return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]);
    };

    window.__stall = () => {
        const top = [...rows].sort((a, b) => b['耗时ms'] - a['耗时ms']).slice(0, 20);
        const n = raw.length;
        console.log(`%c[stall] 记录 ${n} 帧：中位 ${percentile(raw, 0.5)}ms / p95 ${percentile(raw, 0.95)}ms`
            + ` / 最长 ${Math.round(Math.max(0, ...raw))}ms；其中 >${window.__stallThresh}ms 的长帧 ${rows.length} 个`
            + '（段数 = 这一帧结算的伤害段数；"堆变化MB"为负且大 = 这一帧前后发生了 GC）', 'color:#c00;font-weight:bold');
        console.table(top);
        return { frames: n, longFrames: rows.length, top };
    };
    window.__stallLog = (n = 15) => {
        const list = [...logCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
        console.log('%c[stall] 控制台刷屏榜（日志 → 次数）', 'color:#c00;font-weight:bold');
        console.table(list.map(([msg, count]) => ({ 日志: msg, 次数: count })));
        return list;
    };
    window.__stallReset = () => { rows.length = 0; raw.length = 0; logCount.clear(); console.log('[stall] 已清空'); };
    /** 原始数据（DevTools 关掉时也留着；重开 F12 后照样能读） */
    window.__stallData = { rows, raw };
    window.__stallStop = () => {
        cc.director.off(cc.Director.EVENT_AFTER_DRAW, onDraw);
        for (const k of Object.keys(orig)) console[k] = orig[k];
        window.__stallStop = null;
        console.log('[stall] 已停止记录，console 已还原（数据仍在 __stallData 里）');
    };

    console.log(`[stall] 开始记录（长帧阈值 ${window.__stallThresh}ms，改它立刻生效）。`
        + '战斗中：__stall() 看长帧榜 + 帧耗时分位，__stallLog() 看控制台刷屏榜，__stallStop() 停止。'
        + '建议：先关掉 DevTools 打一场 → 卡过之后再按 F12 输入 __stall()（数据一直在记）。');
})();
