/**
 * stall-probe-mini.js —— `stall-probe.js` 的**单行迷你版**（粘贴最不容易出问题的那个）
 *
 * 什么时候用它：整段 `stall-probe.js`（120 行）贴进 DevTools 控制台总出问题（被 Chrome 的
 * "禁止粘贴"拦、或粘贴被截断）时，把下面这一整行贴进去即可。口径与完整版一致：
 * 逐帧记录"长帧耗时 / 该帧结算的伤害段数 / JS 堆 / draw call"，用 `__mini()` 出表格。
 *
 * 用法（浏览器控制台；完整版见 `stall-probe.js` 的文件头）：
 *   __mini()               → 打印最长的 20 个长帧
 *   __miniThresh = 40      → 改阈值（毫秒，缺省 80）
 *
 * 判据速查（完整版同）：段数上千 + 堆掉下来 ⇒ 段数爆炸 + GC；DC 只有几十 ⇒ 与渲染无关。
 * 自检：`node tools/analysis/stall-probe-smoke.cjs`（用桩对象跑一遍，不需要浏览器）
 */
(()=>{const cc=window.cc;if(!cc||!cc.director){console.error('[mini] 没有 window.cc：不在浏览器里？');return;}const rows=[];let l=performance.now(),i=(window.__dmgMeter?__dmgMeter.instances:0);cc.director.on(cc.Director.EVENT_AFTER_DRAW,()=>{const n=performance.now(),dt=n-l,k=(window.__dmgMeter?__dmgMeter.instances:0),th=(window.__miniThresh||80);if(dt>th){rows.push({ms:Math.round(dt),段:k-i,堆MB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):0,DC:cc.director.root.device.numDrawCalls});if(rows.length>300)rows.shift();}l=n;i=k;});window.__mini=()=>{console.table([...rows].sort((a,b)=>b.ms-a.ms).slice(0,20));return rows.length;};console.log('[mini] 装好了：__mini() 看长帧榜（阈值 80ms，改 __miniThresh）');})()
