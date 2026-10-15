import { DamageType } from './types';

/**
 * ============================================================
 * DamageMeter —— 「伤害段数账本」（**只读诊断**；纯 TS，无 cc 依赖）
 * ============================================================
 *
 * ── 为什么会有它（2026-11 用户报「最终 Boss 265 万血，画面卡一下就死了」）──
 *   全工程的伤害只有两种形态：**小固定值**（配表里最大也就几十点）与 **「攻击力 × 百分比」**，
 *   而攻击力那一侧的每一个乘区都有配表上限（攻速 ≤5.0 / 暴击率 ≤1.0 / 爆伤与增伤 ≤50 倍区间）。
 *   ⇒ **没有任何一段能单独打出百万**。"秒杀"只可能来自**段数爆炸**：一次普攻衍生十几~几十段
 *   追加伤害（每段各自 roll 暴击），或者钩子之间互相触发（`on_deal_damage` / `on_kill` 系）。
 *   但在这之前，工程里**没有任何地方数过段数** —— 只能靠猜。本模块就是那个"数段数"的地方。
 *
 * ── 三个出口（分别回答三个问题）──
 *   ① **这一帧结算了多少段？** → `beginFrame` / `endFrame`（帧边界由 `BattleContext.Tick` 划）：
 *      单帧段数（或 1 秒滑窗段数）超阈值就当场 `console.warn` 一行，附**帧内来源 Top3**。
 *   ② **这些段是谁打的？** → 按**来源标签**聚合（`byTag`）。标签不是管道自带的，而是调用方
 *      在进管线前压栈的（`pushTag` / `withTag`，见 `ModifierSystem` / `EffectExecutor` /
 *      `Entity.resolveAttackHit` 的接线点）。
 *   ③ **谁挨得最多、有没有真的递归？** → `byTarget`（按 `名字#uid` 聚合）＋ `depthGuardHits`
 *      （`DamagePipeline` 的深度保险丝被触发过几次；**>0 就是"伤害链在自我递归"最硬的证据**）。
 *
 * ── 四条口径（改这里之前先读）──
 *   ① **软开关**：`enabled = false` 时，所有 `record*` 立刻返回，只剩下"接线点"的一进一出
 *      （`withTag` 的两次数组操作；标签字符串由 `tagOfModifier` 缓存 ⇒ **禁用路径上零分配**）。
 *      控制台 `__dmgMeter.enabled = false` 随时关掉。
 *   ② **标签是"栈"不是"当前值"**：钩子 A 打出的伤害会再触发钩子 B，B 的标签必须能盖住 A、
 *      打完再还原 ⇒ `pushTag`/`popTag`/`withTag`（栈顶 = 这一段的归属）。
 *      所以 `pushTag`/`popTag` **不受 `enabled` 影响**（保持出入栈成对，避免错位）。
 *   ③ **只记账、绝不参与结算**：不改伤害、不发事件、不碰实体；`record*` 内部不抛异常
 *      （诊断代码坏了不许拖垮战斗）。
 *   ④ **帧边界只有一处**：`BattleContext.Tick` 的开头 `beginFrame()`、结尾 `endFrame()`。
 *      在 `ctx.Tick` **之外**发生的伤害（例如场景在 `tick` 里单独调的 `ctx.mines.tick`）
 *      会算进**下一帧** —— 量级判断不受影响，但别拿单帧数字去对某一次爆炸的精确归属。
 *
 * ── 用法 ──
 *   · 边打边看：控制台 `__dmgMeterReport()`（打一份文本账本，**不置"已收尾"标记**）
 *   · 本局结束：`finish(原因)` —— 宿主 `endRun()`（打完）与 `exit()`（中途退出）各调一次，
 *     第二次被 `hasDumped()` 挡掉（同一份账不打两遍）；若 `ctx` 已经没了则打一行告警顶上
 *   · 结构化：`window.__dmgMeter`（`byTag` / `byTarget` / `peak` / `maxWindow` 都在上面）
 *   · 关掉：`__dmgMeter.enabled = false`
 *   · 接线点清单（漏一处就是"那一段没有名字"→ 归到 `未标注`）：
 *     `ModifierSystem`（钩子与 DoT）· `EffectExecutor`（声明式动作与脚本）·
 *     `Entity.resolveAttackHit`（普攻/技能命中）· `Projectile`（弹道）· `BattleContext`（地雷）
 */
export class DamageMeter {

    // ============ 软开关与阈值 ============

    /** 总开关（false = 全链路只留一次布尔判断） */
    enabled = true;
    /** 单帧段数告警阈值（约 60fps 下"一帧几十段"已经远超正常普攻节奏） */
    burstWarnInstances = 60;
    /** 1 秒滑窗段数告警阈值（0 = 不查这一条） */
    burstWarnPerSecond = 500;
    /** 最多打印几条告警（防刷屏；完整账本随时用 `report()` 看） */
    warnLimit = 8;

    // ============ 本局累计 ============

    /** 进入伤害管线的**调用次数**（含被免疫/已死/深度保险丝挡下的那些） */
    calls = 0;
    /** 真正扣血的**段数** */
    instances = 0;
    /** 段数对应的**实际伤害**合计 */
    damage = 0;
    /** 划过的帧数（`beginFrame` 次数） */
    frames = 0;
    /** `DamagePipeline` 深度保险丝触发次数（>0 = 伤害链在自我递归） */
    depthGuardHits = 0;

    /** 单帧段数峰值（报告与告警都用它） */
    readonly peak = { frame: 0, instances: 0, damage: 0, top: '' };

    /** 1 秒滑窗峰值（按帧近似的窗口，见文件头口径④） */
    readonly maxWindow = { frame: 0, instances: 0, damage: 0 };

    /** 按来源标签聚合（本局累计）—— 「这些段是谁打的」 */
    readonly byTag = new Map<string, DamageBucket>();
    /** 按目标聚合（本局累计，key = `名字#uid`）—— 「谁挨得最多」 */
    readonly byTarget = new Map<string, DamageTargetBucket>();
    /** 按伤害类型聚合（本局累计）—— 「这些段吃不吃护甲」 */
    readonly byType = new Map<string, DamageBucket>();

    // ============ 发布口 ============

    /**
     * 账本的发布口（缺省挂 `window.__dmgMeter` + `__dmgMeterReport()`）。
     * 体检/回放脚本可以替换它把账本接住（与 `RunStats.publisher` 同一口径）。
     */
    publisher: (meter: DamageMeter) => void = defaultPublish;

    // ============ 内部状态 ============

    /** 来源标签栈（栈顶 = 当前这一段的归属） */
    private tagStack: string[] = [];
    /** 单帧计数 */
    private frameInstances = 0;
    private frameDamage = 0;
    private frameDepthGuard = 0;
    private readonly frameTags = new Map<string, DamageBucket>();
    private readonly frameTargets = new Map<string, DamageTargetBucket>();
    /** 已打印的告警条数 */
    private warns = 0;
    /** 本局账本是否已经**收尾**打印过（`finish`；宿主 `exit()` 靠它防重复，见 `hasDumped`） */
    private dumped = false;
    /** 每秒窗口用的环形缓冲（段数 / 伤害） */
    private readonly ringInst = new Int32Array(RING_FRAMES);
    private readonly ringDmg = new Float64Array(RING_FRAMES);
    private ringIdx = 0;
    private ringFilled = 0;
    /** Modifier → 标签的缓存（标签只与 名字/id/origin 有关，创建后不变） */
    private readonly tagCache = new WeakMap<object, string>();

    /**
     * 目标实体 → `{ raw, label, key }` 的缓存（**热路径上不现拼字符串**）。
     *
     * 为什么要它：`recordInstance` 是**每一段伤害**都会走的一次调用，而原来的
     * `${name}#${uid}` 是**每段现拼一个字符串**再丢给 `Map.get`（临时串只做键、随即被丢）。
     * 这与本工程既有纪律一致（`RelicHooks` / 本文件都写着"热路径不现拼字符串"）。
     *
     * ⚠ **别把它当成性能修复**：2026-11 实测（`tools/analysis/damage-meter-cache-check.cjs`，
     *   Node/V8，200 万段）旧写法 11ms、堆 +0.3MB，新写法 25ms、堆 +0MB ——
     *   V8 的年轻代处理"短命小字符串"几乎免费，缓存反而让每次调用慢 ~7ns（换算到"一帧 1 万段"
     *   只有 0.07ms）。所以排障 FPS 掉到 1 时**不要**从这条路上找 GC，用
     *   `tools/analysis/stall-probe.js` 看长帧那一行的"段数 / console / 堆变化"。
     *
     * ⚠ **必须比对 `target.name` 的现名**，不能只按对象缓存：实体是对象池复用的，
     * `Entity.Reinit` 会重写 `name`（`if (def.name !== undefined) this.name = def.name`），
     * 只认对象会让"被复用成另一种怪"的实体一直挂着旧名字（报告里就认错人了）。
     * 现名本身就是字符串，比较不产生新对象 ⇒ 快路径依然是零分配。
     */
    private readonly targetCache = new WeakMap<object, TargetInfo>();

    constructor() {
        this.publish();
    }

    // ============ 帧边界 ============

    /** 帧开始（由 `BattleContext.Tick` 调用） */
    beginFrame(): void {
        if (!this.enabled) return;
        this.frames++;
    }

    /**
     * 帧结束：结算这一帧、更新峰值/滑窗、必要时告警（由 `BattleContext.Tick` 调用）。
     *
     * 这里是**唯一的告警点**：只有"跨帧"才看得出"一帧里堆了多少段"，
     * 单看某一发伤害是看不出来的（每一段自己都很正常，问题在段数）。
     */
    endFrame(): void {
        if (!this.enabled) return;

        // 1 秒滑窗（按帧近似；只在账面有量时才算，空帧几乎零成本）
        if (this.frameInstances > 0) {
            this.ringInst[this.ringIdx] = this.frameInstances;
            this.ringDmg[this.ringIdx] = this.frameDamage;
            this.ringIdx = (this.ringIdx + 1) % RING_FRAMES;
            if (this.ringFilled < RING_FRAMES) this.ringFilled++;
        }
        const n = Math.min(this.ringFilled, WINDOW_FRAMES);
        let winInst = 0;
        let winDmg = 0;
        for (let k = 0; k < n; k++) {
            const idx = (this.ringIdx - 1 - k + RING_FRAMES * 2) % RING_FRAMES;
            winInst += this.ringInst[idx];
            winDmg += this.ringDmg[idx];
        }
        if (winInst > this.maxWindow.instances) {
            this.maxWindow.instances = winInst;
            this.maxWindow.damage = winDmg;
            this.maxWindow.frame = this.frames;
        }

        // 峰值帧（连带把"这一帧是谁打的"一起钉住，事后可查）
        if (this.frameInstances > this.peak.instances) {
            this.peak.frame = this.frames;
            this.peak.instances = this.frameInstances;
            this.peak.damage = this.frameDamage;
            this.peak.top = topText(this.frameTags, 3);
        }

        // 告警（单帧 / 1 秒滑窗两条判据）
        const burstFrame = this.frameInstances >= this.burstWarnInstances;
        const burstWin = this.burstWarnPerSecond > 0 && winInst >= this.burstWarnPerSecond;
        if ((burstFrame || burstWin) && this.warns < this.warnLimit) {
            this.warns++;
            const total = this.maxWindow.instances;
            console.warn(
                `[伤害段数] 第 ${this.frames} 帧结算 ${this.frameInstances} 段 / ${fmt(this.frameDamage)} 伤`
                + `（阈值：单帧 ${this.burstWarnInstances}${burstWin ? ` · 1 秒滑窗 ${winInst} ≥ ${this.burstWarnPerSecond}` : ''}）`
                + `｜来源 Top3: ${topText(this.frameTags, 3) || '（无）'}`
                + `｜目标 Top1: ${topTargetText(this.frameTargets, 1) || '（无）'}`
                + (this.depthGuardHits > 0 ? `｜递归保险丝累计 ${this.depthGuardHits} 次` : '')
                + `｜峰值 ${this.peak.instances} 段 / 滑窗峰值 ${total} 段`
                + `｜告警 ${this.warns}/${this.warnLimit} 条，完整账本 __dmgMeterReport()`,
            );
        }

        // 收尾：帧内计数清零（Map 复用，不重新分配）
        this.depthGuardHits += this.frameDepthGuard;
        this.frameDepthGuard = 0;
        this.frameInstances = 0;
        this.frameDamage = 0;
        this.frameTags.clear();
        this.frameTargets.clear();
    }

    // ============ 记账（由伤害管线与接线点调用） ============

    /** 进入管线一次（**含**最终没扣到血的那些：免疫/已死/被格挡/深度保险丝） */
    recordCall(): void {
        if (!this.enabled) return;
        this.calls++;
    }

    /** 深度保险丝触发一次（`DamagePipeline.MAX_DEPTH` 拦下的那一段） */
    recordDepthGuard(): void {
        if (!this.enabled) return;
        this.frameDepthGuard++;
    }

    /** 真正扣血的一段（`DamagePipeline` 第 6 阶段扣血成功后调用） */
    recordInstance(target: any, damage: number, damageType?: DamageType): void {
        if (!this.enabled) return;
        const dmg = Number.isFinite(damage) ? (damage as number) : 0;
        const tag = this.currentTag();
        // 目标键/显示名走缓存（稳定态零分配，成本口径见 targetCache 注释）
        const info = this.targetInfoOf(target);
        const key = info.key;
        const name = info.label;

        // 帧内
        this.frameInstances++;
        this.frameDamage += dmg;
        bump(this.frameTags, tag, dmg);
        bumpTarget(this.frameTargets, key, name, dmg);
        // 本局
        this.instances++;
        this.damage += dmg;
        bump(this.byTag, tag, dmg);
        bumpTarget(this.byTarget, key, name, dmg);
        bump(this.byType, damageType ?? 'unknown', dmg);
    }

    // ============ 来源标签栈 ============

    /**
     * 压入一个来源标签（**不受 `enabled` 影响**：出栈必须成对，否则栈会错位）。
     *
     * ⚠ 标签字符串请用 `tagOfModifier` / 常量拼好的**缓存值**，不要在调用点现拼 ——
     * 关闭账本时现拼字符串依然会分配，那就违背了"软开关零成本"。
     */
    pushTag(tag: string): void {
        this.tagStack.push(tag);
    }

    /** 弹出栈顶标签（与 `pushTag` 成对） */
    popTag(): void {
        this.tagStack.pop();
    }

    /**
     * 压栈 → 执行 → 出栈（异常也会出栈）。
     *
     * ⚠ **只给低频调用点用**（技能动作 / 弹道命中 / 普攻命中 / 地雷：每秒几次~几十次）。
     *   每帧 × 每实体 × 每条 Modifier 的热路径（`ModifierSystem.Tick` / `DispatchEvent`）
     *   **必须**写成显式的 `pushTag` + `try` + `popTag`：回调写法每次都要分配一个闭包，
     *   而那是本工程明确要避免的每帧分配（同 `RelicHooks` 文件头"避免每帧分配"的纪律）。
     */
    withTag<T>(tag: string, fn: () => T): T {
        this.tagStack.push(tag);
        try {
            return fn();
        } finally {
            this.tagStack.pop();
        }
    }

    /** 当前段的归属标签（无标签 = `未标注`，报告里会显式列出来） */
    currentTag(): string {
        const n = this.tagStack.length;
        return n > 0 ? this.tagStack[n - 1] : UNTAGGED;
    }

    /**
     * 取某个 Modifier 的来源标签：`名字#id@origin`
     * （如 `遗物·暴击回响#211@relic:1030`）。名字/来源组**创建后不变** ⇒ 缓存到实例上，
     * 每帧每 Modifier 只是一次 `WeakMap` 查找，不分配字符串。
     */
    tagOfModifier(m: any): string {
        if (!m) return UNTAGGED;
        const cached = this.tagCache.get(m);
        if (cached !== undefined) return cached;
        const id = (typeof m.getId === 'function') ? m.getId() : (m.def?.id ?? 0);
        const name = m.def?.name ?? '效果';
        const origin = m.origin ? `@${m.origin}` : '';
        const tag = `${name}#${id}${origin}`;
        this.tagCache.set(m, tag);
        return tag;
    }

    /**
     * 取某个目标实体的 `{ label, key }`（`key` 与报告口径逐字一致：`名字#uid`）。
     *
     * 零分配快路径：命中缓存直接返回（`target.name` 是字符串本身，比较不产生新对象）；
     * 只有"首见"与"池化复用后换了名字"这两种情况才会拼一次字符串。
     *
     * @param target 目标实体（可以是任何东西：非对象目标走现拼的兜底分支，不进缓存）
     */
    private targetInfoOf(target: any): TargetInfo {
        if (!target || typeof target !== 'object') {
            const label = targetLabel(target);
            return { raw: '', label, key: `${label}#-1` };
        }
        const raw = (typeof target.name === 'string' && target.name.length > 0) ? target.name : '';
        const cached = this.targetCache.get(target);
        if (cached !== undefined && cached.raw === raw) return cached;
        const label = raw !== '' ? raw
            : ((target.id === undefined || target.id === null) ? '未知目标' : `unit#${target.id}`);
        const info: TargetInfo = { raw, label, key: `${label}#${target.uid ?? -1}` };
        this.targetCache.set(target, info);
        return info;
    }

    // ============ 文本出口 ============

    /**
     * 打一份文本账本到控制台（控制台 `__dmgMeterReport()` 也是它）。
     *
     * ⚠ **不置「已打印」标记**（口径同 `RunStats.dumpRun`）：手动催一份之后，
     *   本局真正结束那一次照样出完整报告（不然"看一眼就把收尾吃掉了"）。
     */
    dump(): void {
        this.printReport();
    }

    /**
     * **收尾**：打一份完整账本（带"结束于哪条路"）并**记下"已经打印过"** —— 由宿主
     * `endRun()`（打完）与 `exit()`（中途退出）调，与 `RunStats.finishRun` 同一口径。
     *
     * 为什么要那个标记：`endRun()` 之后玩家点「确定」必然再走一次 `exit()`，
     * 而这一局已经停了（`finished = true` ⇒ 账本数字不再变化）——
     * 没有标记就会把**逐字相同**的一大块账打两遍，淹没在控制台里。
     *
     * @param reason 收尾路径（`endRun(victory/boss_killed)` / `exit 中途退出` …），只用于报告首行
     */
    finish(reason: string): void {
        if (this.dumped) return;
        this.dumped = true;
        this.printReport(reason);
    }

    /** 本局账本是否已经**收尾**打印过（宿主 `exit()` 靠它决定要不要补一份"中途退出"） */
    hasDumped(): boolean {
        return this.dumped;
    }

    /**
     * 一行摘要（给别的日志当附表用，如 `Scene_Game_Stage` 的「战斗结算」头部）。
     *
     * 为什么要有它：整块账本打在收尾的**最后一步**，而"最后一步"在收尾中途出任何岔子
     * （读配表失败 / 面板脚本异常）时会被跳过 —— 用户 2026-11 报过"结束时控制台没有打印"。
     * 一行摘要放在**收尾的第一条日志**里，等于把最关键的段数证据提前钉住。
     */
    summary(): string {
        return `管线调用 ${fmt(this.calls)} 次 / 扣血 ${fmt(this.instances)} 段 / 合计 ${fmt(this.damage)} 伤`
            + ` / ${fmt(this.frames)} 帧 ｜ 峰值帧 第 ${fmt(this.peak.frame)} 帧 ${fmt(this.peak.instances)} 段`
            + ` ｜ 1 秒滑窗峰值 ${fmt(this.maxWindow.instances)} 段`
            + ` ｜ 递归保险丝 ${fmt(this.depthGuardHits)} 次`;
    }

    /**
     * 生成 → 打印（`dump` / `finish` 共用；**绝不抛**）。
     *
     * 拼装失败也必须留下**看得见的一行**：静默无输出是最坏的失败模式
     * （与 `RunStats.renderAndPrint` 同一条纪律 —— 那正是"结束时什么都没打"的成因）。
     */
    private printReport(reason?: string): void {
        let text: string;
        try {
            text = this.report(reason);
        } catch (e) {
            console.log('[伤害段数] 账本拼装失败（不影响战斗结算；结构化数据仍可读 window.__dmgMeter）', e);
            return;
        }
        console.log(text);
    }

    /** 文本账本（只读；任何时刻都能打，不必等这一局结束） */
    report(reason?: string): string {
        const L: string[] = [];
        const line = (s = '') => L.push(s);

        line('='.repeat(78));
        line(' 伤害段数账本（DamageMeter · 只读诊断，不参与任何战斗结算）');
        if (reason) line(` 收尾     : ${reason}`);
        line('='.repeat(78));
        line(`  累计     : 管线调用 ${fmt(this.calls)} 次 / 实际扣血 ${fmt(this.instances)} 段`
            + ` / 合计 ${fmt(this.damage)} 伤 / ${fmt(this.frames)} 帧`);
        if (this.frames > 0) {
            line(`  平均     : ${(this.instances / this.frames).toFixed(2)} 段/帧`
                + ` · ${fmt(this.damage / this.frames)} 伤/帧`);
        }
        line(`  峰值帧   : 第 ${fmt(this.peak.frame)} 帧 ${fmt(this.peak.instances)} 段`
            + ` / ${fmt(this.peak.damage)} 伤${this.peak.top ? '  ← ' + this.peak.top : ''}`);
        line(`  1 秒滑窗 : 最大 ${fmt(this.maxWindow.instances)} 段 / ${fmt(this.maxWindow.damage)} 伤`
            + `（第 ${fmt(this.maxWindow.frame)} 帧附近；窗口按 ${WINDOW_FRAMES} 帧近似）`);
        line(`  递归保险丝: ${fmt(this.depthGuardHits)} 次`
            + (this.depthGuardHits > 0
                ? '（>0 = 伤害链确实在自我递归：被 MAX_DEPTH 拦下的段已丢弃，查 DamagePipeline.MAX_DEPTH）'
                : '（0 = 没有递归链）'));

        if (this.byType.size > 0) {
            const seg: string[] = [];
            for (const row of topRows(this.byType, 4)) {
                seg.push(`${typeLabel(row.key)} ${fmt(row.b.n)}段/${fmt(row.b.dmg)}伤`);
            }
            line(`  伤害类型 : ${seg.join(' · ')}`);
        }

        line('');
        line(`  按来源（段数 Top ${TOP_N}）—— 「这些段是谁打的」：`);
        const tags = topRows(this.byTag, TOP_N);
        if (tags.length === 0) {
            line('      （本局还没有任何伤害）');
        } else {
            for (const row of tags) {
                line(`      ${padStart(fmt(row.b.n), 8)} 段 ${padStart(pct(row.b.dmg, this.damage), 6)}`
                    + `  ${padStart(fmt(row.b.dmg), 12)} 伤   ${row.key}`);
            }
        }

        line('');
        line('  按目标（段数 Top 8）—— 「谁挨得最多」：');
        const targets = topTargetRows(this.byTarget, 8);
        if (targets.length === 0) {
            line('      （本局还没有任何伤害）');
        } else {
            for (const row of targets) {
                line(`      ${padStart(fmt(row.b.n), 8)} 段 ${padStart(pct(row.b.dmg, this.damage), 6)}`
                    + `  ${padStart(fmt(row.b.dmg), 12)} 伤   ${row.key}`);
            }
        }

        line('');
        line('  提示：`__dmgMeter.enabled = false` 可关掉本账本；'
            + '结构化数据见 `window.__dmgMeter`（byTag / byTarget / peak / maxWindow）。');
        return L.join('\n');
    }

    // ============ 内部 ============

    private publish(): void {
        try {
            this.publisher(this);
        } catch (_e) {
            // 只读诊断：发布失败（无 window / 被别的脚本占用）绝不影响战斗
        }
    }
}

/* =====================================================================================
 * 类型与常量
 * ===================================================================================== */

/** 一个聚合桶：段数 + 实际伤害 */
export interface DamageBucket {
    n: number;
    dmg: number;
}

/** 目标桶（多存一个显示名，报告直接读） */
export interface DamageTargetBucket extends DamageBucket {
    name: string;
}

/**
 * 一个目标实体的缓存项（`DamageMeter.targetCache` 的值）。
 *
 * · `raw` = 取缓存那一刻的 `target.name`（空串 = 这个实体没有名字），**只用来比对现名**；
 * · `label` = 报告里显示的名字（没名字时是 `unit#<id>` 或 `未知目标`）；
 * · `key` = `byTarget` / `frameTargets` 的聚合键，格式 `名字#uid`（**不要改格式**，
 *   控制台的 `__dmgMeter.byTarget` 与报告都按它读）。
 */
interface TargetInfo {
    raw: string;
    label: string;
    key: string;
}

/** 滑窗用的环形缓冲长度（帧）—— ≥ 窗口长度即可，多留几倍便于事后回溯 */
const RING_FRAMES = 240;
/** 「1 秒」窗口的帧数（按 60fps 近似；本账本只用于定位量级，不追求毫秒精度） */
const WINDOW_FRAMES = 60;
/** 报告里"按来源"列几行 */
const TOP_N = 15;
/** 没有任何标签时的兜底名（报告里显式列出来 = 有接线点漏了） */
const UNTAGGED = '未标注';

/* =====================================================================================
 * 小工具（本文件私有；不进任何战斗路径）
 * ===================================================================================== */

/** 计数桶 +1（Map 复用，不重新分配对象） */
function bump(map: Map<string, DamageBucket>, key: string, dmg: number): void {
    let b = map.get(key);
    if (b === undefined) {
        b = { n: 0, dmg: 0 };
        map.set(key, b);
    }
    b.n++;
    b.dmg += dmg;
}

/** 目标桶 +1（名字只在首次创建时写入） */
function bumpTarget(map: Map<string, DamageTargetBucket>, key: string, name: string, dmg: number): void {
    let b = map.get(key);
    if (b === undefined) {
        b = { n: 0, dmg: 0, name };
        map.set(key, b);
    }
    b.n++;
    b.dmg += dmg;
}

/**
 * 目标显示名（实体名优先，其次单位配置 id）。
 *
 * ⚠ 只在 `targetInfoOf` 的**兜底分支**（目标不是对象）里用：正常实体走的是缓存，
 *   名字那句分支会现拼字符串，**不许把它放回每段伤害的热路径**。
 */
function targetLabel(target: any): string {
    const name = target?.name;
    if (typeof name === 'string' && name.length > 0) return name;
    const id = target?.id;
    return (id === undefined || id === null) ? '未知目标' : `unit#${id}`;
}

/** 段数/伤害降序取前 n 行（同段数按伤害降序，保证确定性） */
function topRows(map: Map<string, DamageBucket>, n: number): Array<{ key: string; b: DamageBucket }> {
    const rows: Array<{ key: string; b: DamageBucket }> = [];
    map.forEach((b, key) => rows.push({ key, b }));
    rows.sort((x, y) => (y.b.n - x.b.n) || (y.b.dmg - x.b.dmg));
    return rows.slice(0, n);
}

/** 目标行同理 */
function topTargetRows(map: Map<string, DamageTargetBucket>, n: number): Array<{ key: string; b: DamageTargetBucket }> {
    const rows: Array<{ key: string; b: DamageTargetBucket }> = [];
    map.forEach((b, key) => rows.push({ key, b }));
    rows.sort((x, y) => (y.b.n - x.b.n) || (y.b.dmg - x.b.dmg));
    return rows.slice(0, n);
}

/** 「来源 段数」单行文本（告警与峰值记录共用） */
function topText(map: Map<string, DamageBucket>, n: number): string {
    return topRows(map, n).map((r) => `${r.key} ${r.b.n}段`).join('、');
}

/** 「目标 段数」单行文本 */
function topTargetText(map: Map<string, DamageTargetBucket>, n: number): string {
    return topTargetRows(map, n).map((r) => `${r.key} ${r.b.n}段`).join('、');
}

/** 伤害类型显示名 */
function typeLabel(key: string): string {
    if (key === DamageType.Physical) return '物理';
    if (key === DamageType.Magical) return '魔法';
    if (key === DamageType.Pure) return '纯粹';
    return '未知';
}

/** 占比文本（合计为 0 时给 0.0%） */
function pct(part: number, total: number): string {
    if (!(total > 0)) return '0.0%';
    return ((part / total) * 100).toFixed(1) + '%';
}

/** 千分位（只处理整数部分；诊断用，不做本地化） */
function fmt(v: number): string {
    if (!Number.isFinite(v)) return 'NaN';
    const n = Math.round(v);
    const neg = n < 0;
    const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
}

/** 右对齐（`lib` 只到 ES2015，没有 `padStart`） */
function padStart(s: string, width: number): string {
    if (s.length >= width) return s;
    return ' '.repeat(width - s.length) + s;
}

/** 缺省发布口：挂到 `window.__dmgMeter` / `__dmgMeterReport()`（同 `window.__runStats` 的口径） */
function defaultPublish(meter: DamageMeter): void {
    const g: any = (typeof window !== 'undefined') ? window : undefined;
    if (!g) return;
    g.__dmgMeter = meter;
    g.__dmgMeterReport = () => meter.dump();
}
