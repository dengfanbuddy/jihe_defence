/**
 * dc-probe.js —— 运行时 draw call 探针（**贴进浏览器控制台用，不进 assets/**）
 *
 * 作用：读引擎这一帧真正提交的 2D 批次（`director.root.batcher2D.batches`），按**贴图**拆账，
 * 直接回答两个问题：
 *   ① 这 50~60 个 draw call 分别花在哪张贴图上？
 *   ② 光靠"重排节点顺序 + 同贴图打进图集"最多能降到多少（= 去重后的贴图数）？
 *
 * 用法（浏览器 / Web 预览，战斗中随时）：
 *   1. 把本文件整段贴进控制台回车 → 之后每帧自动记录；
 *   2. 输入 `__dc()`      → 打印最近一帧的拆账（战斗中多打几次，取典型值）
 *      输入 `__dcMax()`   → 打印峰值帧（DC 最高那一帧）
 *      输入 `__dcStop()`  → 停止记录
 *
 * 口径提醒：
 *   · `batcher2D.batches` 是**本帧 2D 批次**，3D 相机的 draw call 不在里面（本项目战斗基本是 2D，
 *     差一个 3D 相机的话把总数 +1~2 看）；
 *   · Label（TTF，cacheMode=NONE）每张都有**自己的一张 canvas 贴图**，所以在拆账里表现为
 *     "一堆只出现 1 次的贴图" —— 见输出里的「只出现一次」计数；
 *   · "理论下限"忽略了材质/混合模式/模板（Mask）带来的额外批次，是**乐观下限**，
 *     实际能到的值要更高一点（Mask 每个 +2，自定义材质各自成批）。
 */
(() => {
    const cc = window.cc;
    if (!cc?.director?.root) { console.error('[dc-probe] 找不到 window.cc / director.root'); return; }
    if (window.__dcStop) window.__dcStop();

    const batcher = cc.director.root.batcher2D;
    if (!batcher?.batches) { console.error('[dc-probe] 拿不到 batcher2D.batches（引擎版本不匹配？）'); return; }

    const texName = (t, hash) => {
        if (!t) return '(no-texture)';
        const n = t.name;
        return n && n !== '' ? n : '#' + hash;
    };

    const snapshot = () => {
        const arr = batcher.batches.array;
        const n = batcher.batches.length;
        const byTex = new Map();
        let total = 0;
        for (let i = 0; i < n; i++) {
            const b = arr[i];
            if (!b) continue;
            total++;
            const key = texName(b.texture, b.textureHash) + (b.model ? ' [model]' : '');
            const e = byTex.get(key) ?? { dc: 0, verts: 0, inds: 0 };
            e.dc++;
            const ia = b.inputAssembler;
            if (ia) { e.verts += ia.vertexCount || 0; e.inds += ia.indexCount || 0; }
            byTex.set(key, e);
        }
        return { total, byTex };
    };

    let best = null;
    const onFrame = () => {
        const snap = snapshot();
        if (!best || snap.total > best.total) best = snap;
    };
    cc.director.on(cc.Director.EVENT_AFTER_DRAW, onFrame);

    const report = (snap, tag) => {
        const list = [...snap.byTex.entries()].sort((a, b) => b[1].dc - a[1].dc);
        const unique1 = list.filter(([, v]) => v.dc === 1).length;
        const floor = list.length;
        console.log(`%c[dc-probe] ${tag}：2D draw call = ${snap.total}`
            + `  ·  不同贴图 = ${floor}（= 重排+图集后的乐观下限）`
            + `  ·  只出现 1 次的贴图 = ${unique1}（其中大部分是 Label 的独占 canvas 贴图）`,
            'color:#0a0;font-weight:bold');
        console.table(list.map(([tex, v]) => ({
            贴图: tex.slice(0, 46),
            批次数: v.dc,
            可省: v.dc - 1,
            顶点: v.verts,
        })));
        return snap;
    };

    window.__dc = (top = 200) => {
        const snap = snapshot();
        return report(snap, '当前帧');
    };
    window.__dcMax = () => (best ? report(best, '峰值帧') : console.warn('[dc-probe] 还没记录到帧'));
    window.__dcStop = () => {
        cc.director.off(cc.Director.EVENT_AFTER_DRAW, onFrame);
        console.log('[dc-probe] 已停止记录');
        window.__dcStop = null;
    };
    console.log('[dc-probe] 已开始记录。战斗中输入 __dc() 看当前帧，__dcMax() 看峰值帧，__dcStop() 停止。');
})();
