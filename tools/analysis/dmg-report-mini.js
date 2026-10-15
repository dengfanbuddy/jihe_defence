/* =====================================================================================
 * dmg-report-mini.js —— 「段数爆炸」排查片段（**整份文件直接粘进控制台**即可）
 * =====================================================================================
 *
 * 为什么要有它（2026-11 用户报 SyntaxError: Unexpected token '...' at VM4616:1:27）：
 *   原本给的是**两条**语句：
 *       __dmgMeter.depthGuardHits
 *       [...__dmgMeter.byTag].sort(...)...
 *   粘进控制台时被并成了一行 —— `__dmgMeter.depthGuardHits`（25 字符）后面直接接上
 *   `[...`，于是 `[` 落在第 26 列、`...` 落在第 27 列，**正好是报错的位置**：
 *   展开运算符被塞进了「成员访问的方括号」里，解析期就炸，第二句根本没跑。
 *
 *   ⇒ 本片段的写法约束（都是为了"怎么粘都不会坏"）：
 *     ① **只有一条语句**（一个 IIFE），不存在"两行并一行"这回事；
 *     ② **没有展开运算符**（`...`）、**没有箭头函数**、**没有模板字符串** —— 全用
 *        `function` 与字符串拼接，任何老引擎/任何粘贴路径都不会变形；
 *     ③ 任何一行单独被截断，它自己就是**语法错误**（会立刻报出来），**不会**静默变成
 *        "少查了一半"的半份数据。
 *
 * 用法：全选本文件（连注释一起复制也行，`//` 注释控制台照样吃）→ 粘进 DevTools 控制台回车。
 *   输出：一行 JSON（结构化，可直接贴给 AI），并顺手 `copy()` 到剪贴板（非 DevTools 环境自动跳过）。
 *   想直接看文本账本也行，那是另外两条**各自独立**的语句（**一次只粘一条**）：
 *       __dmgMeterReport();
 *       __runStatsDump();
 *
 * 读法（哪几个数决定"根因是不是递归链"）：
 *   · depthGuardHits > 0        → 伤害链确实在自我递归（被 DamagePipeline.MAX_DEPTH 拦下的段已丢弃）
 *   · topTag[0][1] 极大         → 这一条标签就是"段数工厂"（报告里 `名字#id@origin`，origin 指向遗物/技能）
 *   · topTarget[0][1] 极大      → 谁在挨（Boss 还是小怪）；跟 `段数 × 存活实体数` 的放大一起看
 *   · run.relics / run.skills   → 这一局拿了什么，用来对上面那个 origin 找源头
 * ===================================================================================== */
(function(){var m=window.__dmgMeter,r=window.__runStats,o={};if(m){o.depthGuardHits=m.depthGuardHits;o.calls=m.calls;o.instances=m.instances;o.damage=Math.round(m.damage);o.frames=m.frames;o.peak=m.peak;o.window=m.maxWindow;o.topTag=[];m.byTag.forEach(function(v,k){o.topTag.push([k,v.n,Math.round(v.dmg)])});o.topTag.sort(function(a,b){return b[1]-a[1]});o.topTag=o.topTag.slice(0,10);o.topTarget=[];m.byTarget.forEach(function(v,k){o.topTarget.push([k,v.n,Math.round(v.dmg)])});o.topTarget.sort(function(a,b){return b[1]-a[1]});o.topTarget=o.topTarget.slice(0,8);o.byType=[];m.byType.forEach(function(v,k){o.byType.push([k,v.n])})}if(r){o.run={hero:r.meta&&r.meta.heroName,elapsed:r.meta&&r.meta.elapsed,stage:r.meta&&r.meta.stage,maxPhase:r.meta&&r.meta.maxPhase,result:r.meta&&r.meta.result,kills:r.combat&&r.combat.kills,damageDealt:r.combat&&Math.round(r.combat.damageDealt),relics:((r.relics&&r.relics.list)||[]).map(function(x){return x.name+'#'+x.id}),artifacts:(r.artifacts&&r.artifacts.byId)||{},skills:(r.skills||[]).map(function(x){return x.kind+' '+x.name+' Lv'+x.level+'@槽'+x.slot}),finalSlots:r.finalSkillSlots||[],buffs:(r.buffs||[]).slice(0,20).map(function(x){return x.name+' x'+x.times})}}if(!m&&!r){console.log('dmg-report-mini: __dmgMeter 与 __runStats 都不在 —— 确认已经进过局内战斗');return null}console.log(JSON.stringify(o,null,1));try{copy(JSON.stringify(o))}catch(e){}return o})()
