import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import {
    HIT_FEEL_BUDGET,
    HIT_FEEL_DENSITY,
    HIT_FEEL_INFO,
    HIT_FEEL_SFX_EXTRA,
    HIT_FEEL_TIER_RANK,
    HitFeelTier,
    getTierSpec,
    hitFeelDensityScale,
    hitFeelSfxKey,
    resolveDeathTier,
    resolveHitTier,
    shouldPlayAttackSfx,
} from '../../common/HitFeelConfig';

/**
 * ============================================================
 * HitFeelDirector —— 打击反馈的**全局决策层**（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * 设计文档：`docs/打击反馈设计.md` §5（预算与合并）/ §6（落点）。数值真源：`HitFeelConfig.ts`。
 *
 * ---- 它管什么 / 不管什么（**分工必须清楚**）----
 *   ✅ 管**全局**那几件事：顿帧、慢动作、**战斗内容层位移**、密度统计、**音效账本**（B4）、预算、统计。
 *   ❌ 不管**每个受击者自己**的表现（抖动 / 膨胀 / 层级弹出）—— 那些在 `EntityView` 里，
 *      因为它已经订阅了同一个 `OnTakeDamage`（和 HitFlash / HpBar 一条路），
 *      Key 是 `entity.uid`，天然按目标分组，不需要经手中转。
 *
 *   两者共用**同一个判定函数** `resolveHitTier`，所以"这一下是几档"只有一处实现。
 *
 * ---- 为什么是"上一帧的事件、这一帧生效" ----
 *   命中是在 `ctx.Tick()` 里结算的（`DamagePipeline` Phase 7 发事件），而 `timeScale` 要先于
 *   `ctx.Tick` 传进去、位移要先于渲染写出去。所以本类**按帧累积**：
 *   `OnTakeDamage` 只往累积器里记（同帧多次命中在这里合并成"最高档一次"），
 *   `tick(dtReal)` 在**下一帧开头**提交它 —— 60fps 下 16ms 的延迟不可感知，
 *   而"同帧 20 次 AoE 只产生一次全局表现"这条塔防刚需因此天然成立。
 *
 * ---- 时间账本（本作最容易忽略的一条）----
 *   `elapsed` 与阶段倒计时走**真实时间**、刷怪节奏按 `elapsed` 索引 `SPAWN_BEATS`，
 *   而顿帧只冻结战斗实体（`ctx.Tick`）→ **顿帧是对 DPS 的隐性征税**。
 *   所以这里给顿帧记 1s 滑动账本（上限 `HIT_FEEL_BUDGET.stopMsPerWindow` = 30ms ≈ 3%）。
 */

/** 统计（调试面板 / `audit:hitfeel` 体检脚本读它；不做任何业务判断） */
export interface HitFeelStats {
    /** 命中事件数 */
    hits: number;
    /** 死亡事件数 */
    deaths: number;
    /** 真正生效的顿帧次数（被账本丢掉的见 stopsDropped） */
    stops: number;
    /** 因预算超限被丢弃的顿帧次数 */
    stopsDropped: number;
    /** 累计顿帧毫秒（**时间税 = 它 / 真实时间**，验收判据 ≤ 3%） */
    stopMsTotal: number;
    /** 生效过的位移次数 */
    shakes: number;
    /** 因已有更强位移在播而被忽略的次数 */
    shakesDropped: number;
    /** 生效过的墨色闪帧次数（T5/T6/T7） */
    flashes: number;
    /** 因冷却未到被丢弃的墨闪次数（**丢弃不排队**，见 HIT_FEEL_INFO.flashCooldownSec） */
    flashesDropped: number;
    /** 真正响出来的音效次数（B4；被节流吞掉的见 sfxDropped） */
    sfx: number;
    /** 因 50ms 窗口内已有 2 声而被丢弃的音效次数（**丢弃不排队不补偿**） */
    sfxDropped: number;
    /** 单帧最多命中数（同帧合并前） */
    peakHitsPerFrame: number;
    /** 当前密度衰减系数 k */
    densityK: number;
}

/** 档位强弱顺序（= `HIT_FEEL_TIER_RANK`；同帧多次命中只保留最强的那个） */
const TIER_RANK = HIT_FEEL_TIER_RANK;

export class HitFeelDirector {
    /**
     * 当前局的导演实例（表现层单例句柄）。
     *
     * 为什么需要它：`EntityView` 是**对象池异步创建**的（`EntityViewPool.acquire` 走
     * `resources.load` 回调），`bind(entity, prefabPath)` 拿不到构造参数，而密度衰减系数 k
     * 是**全局**状态。与其把它一路穿进 `MonsterPool → EntityViewPool`，
     * 不如按工程既有习惯（`UIManager.ins` / `BattleConstUtil`）给一个静态句柄。
     * 只有读（`densityScale`），没有任何写入方依赖它。
     */
    static active: HitFeelDirector | null = null;

    private ctx: BattleContext | null = null;
    private unsubs: (() => void)[] = [];

    /** 本类自己的时钟（只被 `tick(dtReal)` 推进；不读 `Date.now()`，便于体检脚本用假时钟真跑） */
    private clock = 0;

    // ---- 本帧累积器（事件写入、tick 提交）----
    private frameTier: HitFeelTier = HitFeelTier.None;
    private frameDirX = 0;
    private frameDirY = 0;
    private frameHits = 0;

    // ---- 顿帧 ----
    private stopRemainMs = 0;
    private stopUsedMs = 0;
    private stopWindowStart = -Infinity;

    // ---- 慢动作 ----
    private slowRemainMs = 0;
    private slowScale = 1;

    // ---- 内容层位移 ----
    private shakeRemainMs = 0;
    private shakeDurMs = 0;
    private shakeElapsedMs = 0;
    private shakeAmp = 0;
    private shakeFreq = 0;
    private shakeDirX = 0;
    private shakeDirY = 0;
    private shakePhase = 0;
    /** 本帧算好的位移（Scene 每帧把它写到战斗内容层；**绝不写 entity.position**） */
    shakeX = 0;
    shakeY = 0;

    // ---- 墨色闪帧（B3 / C10：全屏 overlay 的 α）----
    private flashRemainMs = 0;
    private flashDurMs = 0;
    private flashPeakAlpha = 0;
    private flashCooldownMs = 0;

    // ---- 音效（B4）----
    /**
     * 音效播放回调（**由场景注入**；null = 静音，但账本照记）。
     *
     * 为什么用回调注入而不是直接 `import AudioMgr`：本类是**纯 TS、无 cc 依赖**的决策层，
     * 而 `AudioMgr` 是 cc 组件（`AudioSource` / `director.addPersistRootNode`）——
     * 一旦 import 进来，这个文件就再也不能被体检脚本直接真跑了（那正是它现在能被真跑的原因）。
     * 所以导演只回答"**该不该响 / 响哪一个 / 多大声**"，"怎么响"归平台层。
     */
    sfxPlayer: ((key: string, volume: number) => void) | null = null;
    /** 音效节流窗口内的播放时间戳（秒，本类自己的时钟 —— 不用 Date.now，便于假时钟真跑） */
    private sfxStamps: number[] = [];

    // ---- 密度窗口 ----
    private hitTimes: number[] = [];

    readonly stats: HitFeelStats = {
        hits: 0, deaths: 0, stops: 0, stopsDropped: 0, stopMsTotal: 0,
        shakes: 0, shakesDropped: 0, flashes: 0, flashesDropped: 0,
        sfx: 0, sfxDropped: 0,
        peakHitsPerFrame: 0, densityK: 1,
    };

    // ============ 生命周期 ============

    /** 绑定本局战斗上下文（换局必须重新 bind；旧 ctx 的 bus 随旧上下文丢弃） */
    bind(ctx: BattleContext): void {
        this.unbind();
        this.ctx = ctx;
        if (!ctx?.bus) return;
        // 句柄式退订：onDestroy / unbind 精确移除，避免换局后叠加
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this));
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnDeath, this.onDeath, this));
        // 出手 / 闪避（B4）：**只为了声音**订阅（起手虚线由 HitVfxLayer 自己画，它有自己的订阅）。
        // 为什么放在导演而不是印痕层：声音有**全局**节流账本，而账本属于这一层。
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnAttackStart, this.onAttackStart, this));
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnEvade, this.onEvade, this));
        HitFeelDirector.active = this;
    }

    /** 解绑（换局 / 组件销毁）：退订 + 清空全部计时器与位移，**保证不留下任何残留偏移** */
    unbind(): void {
        for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
        this.unsubs.length = 0;
        this.ctx = null;
        this.reset();
        // 播放回调随场景走：留着它等于把一个已退场的场景闭包挂在单例上
        // （场景每次 initBattle 都会在 bind 之后重新注入，所以这里清掉是安全的）
        this.sfxPlayer = null;
        if (HitFeelDirector.active === this) HitFeelDirector.active = null;
    }

    /** 清空运行时状态（换局必须调：否则上一局的顿帧/位移会带到新一局） */
    reset(): void {
        this.clock = 0;
        this.frameTier = HitFeelTier.None;
        this.frameDirX = 0;
        this.frameDirY = 0;
        this.frameHits = 0;
        this.stopRemainMs = 0;
        this.stopUsedMs = 0;
        this.stopWindowStart = -Infinity;
        this.slowRemainMs = 0;
        this.slowScale = 1;
        this.shakeRemainMs = 0;
        this.shakeDurMs = 0;
        this.shakeElapsedMs = 0;
        this.shakeAmp = 0;
        this.shakeFreq = 0;
        this.shakeDirX = 0;
        this.shakeDirY = 0;
        this.shakePhase = 0;
        this.shakeX = 0;
        this.shakeY = 0;
        this.flashRemainMs = 0;
        this.flashDurMs = 0;
        this.flashPeakAlpha = 0;
        this.flashCooldownMs = 0;
        this.sfxStamps.length = 0;
        this.hitTimes.length = 0;
    }

    // ============ 对外只读面 ============

    /**
     * 本帧战斗时间的缩放（`Scene_Game_Stage.tick` 用它算 `dtCombat`）。
     * 顿帧优先于慢动作（大事件的表现是"先停一下、再慢放"）。
     */
    get timeScale(): number {
        if (this.stopRemainMs > 0) return HIT_FEEL_BUDGET.stopTimeScale;
        if (this.slowRemainMs > 0) return this.slowScale;
        return 1;
    }

    /** 当前是否正在顿帧（供调试/体检脚本断言） */
    get isStopping(): boolean {
        return this.stopRemainMs > 0;
    }

    /** 最近 1 秒的全场命中数 */
    get hitsInLastSec(): number {
        return this.hitTimes.length;
    }

    /** 幅度类表现的衰减系数 k（印痕尺寸 / 受击抖动 / 碎片数都乘它） */
    get densityScale(): number {
        return hitFeelDensityScale(this.hitTimes.length);
    }

    /**
     * 本帧的全屏墨色闪帧不透明度（0 = 不闪）。
     *
     * 消费方 = `HitScreenLayer` 的全屏 overlay —— 覆盖层本身**不做任何判断**，
     * 只把读到的 α 画出来。理由：闪帧是"全局 + 有冷却账本"的表现，与顿帧/位移同一性质，
     * 决策留在导演这一层才能被体检脚本真跑（浅底上墨色是"重"的，冷却期必须真的拦住）。
     */
    get flashAlpha(): number {
        if (this.flashRemainMs <= 0 || this.flashDurMs <= 0) return 0;
        return this.flashPeakAlpha * (this.flashRemainMs / this.flashDurMs);
    }

    /**
     * 本次闪帧的**峰值** α（= 档位表的 `flashFrameAlpha`；0 = 当前没有闪帧在进行）。
     *
     * 与 `flashAlpha` 的区别：后者是"这一帧该画多深"（从峰值线性衰减到 0），前者是"这一档本来多重"。
     * 体检脚本要断言"表里的值与实际闪的一致"，只能断言前者。
     */
    get flashPeak(): number {
        return this.flashRemainMs > 0 ? this.flashPeakAlpha : 0;
    }

    // ============ 每帧 ============

    /**
     * 推进一帧（**必须在 `ctx.Tick` 之前调用**：它要先提交上一帧累积的表现，
     * 产出本帧的 `timeScale` 与 `shakeX/shakeY`）。
     *
     * @param dtReal 真实帧增量（秒，**已过 `clampBattleDt`**）
     */
    tick(dtReal: number): void {
        const dtMs = dtReal * 1000;
        this.clock += dtReal;

        // 1) 提交上一帧累积的全局表现（同帧多次命中在这里合并为"最高档一次"）
        this.flushFrame();

        // 2) 密度窗口裁剪（最近 1 秒的命中时间戳）
        this.pruneHitTimes();

        // 3) 顿帧倒计时（走**真实时间**推进 —— 否则顿帧会把自己冻住）
        if (this.stopRemainMs > 0) {
            this.stopRemainMs -= dtMs;
            if (this.stopRemainMs < 0) this.stopRemainMs = 0;
        }

        // 4) 慢动作倒计时
        if (this.slowRemainMs > 0) {
            this.slowRemainMs -= dtMs;
            if (this.slowRemainMs <= 0) {
                this.slowRemainMs = 0;
                this.slowScale = 1;
            }
        }

        // 4.1) 墨色闪帧：瞬时拉满 → 线性淡出（50ms = 3 帧，够"闪一下"但不够"暗一下"）；
        //      冷却独立计时（**冷却不随闪帧结束而结束**，否则连闪会叠加成"屏幕在抽"）
        if (this.flashRemainMs > 0) {
            this.flashRemainMs -= dtMs;
            if (this.flashRemainMs < 0) this.flashRemainMs = 0;
        }
        if (this.flashCooldownMs > 0) {
            this.flashCooldownMs -= dtMs;
            if (this.flashCooldownMs < 0) this.flashCooldownMs = 0;
        }

        // 5) 内容层位移：沿固定方向往复振荡 + 线性衰减
        if (this.shakeRemainMs > 0) {
            this.shakeElapsedMs += dtMs;
            this.shakeRemainMs -= dtMs;
            if (this.shakeRemainMs <= 0) {
                this.shakeRemainMs = 0;
                this.shakeX = 0;
                this.shakeY = 0;
            } else {
                const t = this.shakeDurMs > 0 ? this.shakeElapsedMs / this.shakeDurMs : 1;
                const decay = 1 - (t > 1 ? 1 : t);
                const phase = this.shakePhase + (this.shakeElapsedMs / 1000) * this.shakeFreq * Math.PI * 2;
                const offset = this.shakeAmp * decay * Math.sin(phase);
                this.shakeX = this.shakeDirX * offset;
                this.shakeY = this.shakeDirY * offset;
            }
        }

        this.stats.densityK = this.densityScale;
    }

    // ============ 事件入口 ============

    /** 命中：只累积（同帧合并），真正的表现在下一帧 `tick` 提交 */
    private onTakeDamage(e: any): void {
        const target = e?.target;
        if (!target) return;
        this.stats.hits++;
        this.frameHits++;
        this.hitTimes.push(this.clock);

        const tier = resolveHitTier(e);
        const dir = this.directionOf(e?.source, target);
        this.mergeFrame(tier, dir);
    }

    /** 死亡：普通怪 T2 / 精英·Boss T5 / 最终 Boss T7（英雄死亡返回 None，交给结算面板） */
    private onDeath(e: any): void {
        const entity = e?.entity;
        if (!entity) return;
        this.stats.deaths++;
        const tier = resolveDeathTier(entity);
        if (tier === HitFeelTier.None) return;
        this.frameHits++;
        // 击杀也算"这一帧发生过事件"，但不计入命中密度（密度衡量的是"跳字有多密"）
        this.mergeFrame(tier, this.directionOf(e?.killer, entity));
    }

    // ============ 内部：合并 / 账本 / 判定 ============

    /** 只保留本帧**最强**的那一档（塔防刚需：同帧 20 次 AoE 不能产生 20 份表现） */
    private mergeFrame(tier: HitFeelTier, dir: { x: number; y: number }): void {
        if (TIER_RANK[tier] > TIER_RANK[this.frameTier]) {
            this.frameTier = tier;
            this.frameDirX = dir.x;
            this.frameDirY = dir.y;
        }
    }

    /** 把本帧累积的最高档转成实际表现（顿帧 / 慢动作 / 位移），然后清空累积器 */
    private flushFrame(): void {
        const tier = this.frameTier;
        if (this.frameHits > this.stats.peakHitsPerFrame) this.stats.peakHitsPerFrame = this.frameHits;
        this.frameTier = HitFeelTier.None;
        this.frameHits = 0;
        if (tier === HitFeelTier.None) return;

        const spec = getTierSpec(tier);

        // 顿帧：能不能真停由账本决定（T5/T7 是"峰值档位"，可以一次吃满那一秒的额度）
        const isPeak = tier === HitFeelTier.BigKill || tier === HitFeelTier.Clear;
        this.requestStop(spec.stopMs, isPeak);

        // 慢动作：同一时刻只留一个，取更强的一个（更慢 / 更长）
        if (spec.slowMo) {
            this.slowScale = Math.min(this.slowScale, spec.slowMo.scale);
            this.slowRemainMs = Math.max(this.slowRemainMs, spec.slowMo.ms);
        }

        // 位移：**取最大、不相加**（幅度恒 ≤ BUDGET.shakeMaxPx）
        this.requestShake(spec.shakePx, spec.shakeMs, spec.shakeFreq, spec.shakeDirectional);

        // 墨色闪帧（C10）：只给 T5/T6/T7（档位表里 flashFrameAlpha > 0 的那三档），且必须过冷却账本
        this.requestFlash(spec.flashFrameAlpha);

        // 音效（B4）：与顿帧/慢放/位移/墨闪**同一条合并链路** —— 同帧 20 次命中只出最强档那一声，
        // 再叠上"50ms 窗口内最多 2 声"的节流（塔防刚需，见 HIT_FEEL_BUDGET.sfxWindowMs）
        this.requestSfx(spec.sfx, spec.sfxVolume, spec.sfxVariants);
    }

    /**
     * 出手（`OnAttackStart`）：**只给英雄**响，对应 B2 的起手虚线。
     *
     * ⚠ 它走**事件时刻**而不是 `flushFrame`：出手音要和怪身上那道虚线同时出现。
     * flushFrame 是下一帧才提交 —— 16ms 的延迟对视觉无感，但"出手"和"命中"是**两件事**，
     * 把出手音也推到下一帧，近战那一记就会变成"两声重叠"而不是"先后因果"。
     */
    private onAttackStart(e: any): void {
        if (!shouldPlayAttackSfx(e)) return;
        this.requestSfx(
            HIT_FEEL_SFX_EXTRA.attackShot.key,
            HIT_FEEL_SFX_EXTRA.attackShot.volume,
            HIT_FEEL_SFX_EXTRA.attackShot.variants,
        );
    }

    /** 闪避（`OnEvade`）：谁闪都响 —— 英雄闪掉是"我躲开了"，怪闪掉是"我打空了"，两者都是信息 */
    private onEvade(): void {
        this.requestSfx(
            HIT_FEEL_SFX_EXTRA.evade.key,
            HIT_FEEL_SFX_EXTRA.evade.volume,
            HIT_FEEL_SFX_EXTRA.evade.variants,
        );
    }

    /**
     * 墨色闪帧请求（1.5s 冷却账本）
     *
     * 三条口径（都在这里拦住，消费方不用管）：
     *   · **只有 T5/T6/T7 有非零 α**（档位表里就写好了，浅底上墨色必须稀缺）；
     *   · 冷却期内**直接丢弃**（不排队、不补偿、不与正在播的那次叠加），计入 `stats.flashesDropped`；
     *   · 同一时刻**只有一层**（正在播就不再起新的一次 —— 否则 α 会叠到 0.16 以上，浅底直接被压暗）。
     */
    private requestFlash(alpha: number): void {
        if (!(alpha > 0)) return;
        if (this.flashCooldownMs > 0 || this.flashRemainMs > 0) {
            this.stats.flashesDropped++;
            return;
        }
        this.flashDurMs = HIT_FEEL_BUDGET.flashMs;
        this.flashRemainMs = this.flashDurMs;
        this.flashPeakAlpha = Math.min(alpha, HIT_FEEL_BUDGET.flashMaxAlpha);
        this.flashCooldownMs = HIT_FEEL_BUDGET.flashCooldownSec * 1000;
        this.stats.flashes++;
    }

    /**
     * 顿帧账本（1s 滑动窗口）
     *
     * 两类档位走两套算法（**这是"两个旋钮各管一件事"的落点**，见 HIT_FEEL_BUDGET 的注释）：
     *   · 常规档位：单次 = `min(请求, 窗口剩余)` —— 窗口快满时**自动缩短**而不是整次丢弃，
     *     只有"窗口已经用光"才丢弃并计数。所以一次暴击拿到的是 30ms（= 窗口上限）而不是档位表里的请求值。
     *   · 峰值档位（T5/T7）：单次 = `min(请求, stopHardMaxMs)`，并且**把账本一次吃满** ——
     *     大击杀/通关那一秒之后不会再有第二次顿帧（绝不叠加）。
     */
    private requestStop(ms: number, isPeak: boolean): void {
        if (!(ms > 0)) return;
        if (this.clock - this.stopWindowStart >= HIT_FEEL_BUDGET.stopWindowSec) {
            this.stopWindowStart = this.clock;
            this.stopUsedMs = 0;
        }
        const remain = HIT_FEEL_BUDGET.stopMsPerWindow - this.stopUsedMs;
        if (remain <= 0) {
            this.stats.stopsDropped++;
            return;
        }
        const use = isPeak
            ? Math.min(ms, HIT_FEEL_BUDGET.stopHardMaxMs)
            : Math.min(ms, remain);
        if (!(use > 0)) {
            this.stats.stopsDropped++;
            return;
        }
        // 峰值档位把账本一次吃满（此后 1s 内不再顿帧）；常规档位按实际用量记账
        this.stopUsedMs = isPeak ? HIT_FEEL_BUDGET.stopMsPerWindow : this.stopUsedMs + use;
        if (this.stopUsedMs > HIT_FEEL_BUDGET.stopMsPerWindow) this.stopUsedMs = HIT_FEEL_BUDGET.stopMsPerWindow;
        // 顿帧时长**累加**（与账本口径一致，便于体检脚本用"顿帧总量 / 真实时间"验时间税）
        this.stopRemainMs += use;
        this.stats.stops++;
        this.stats.stopMsTotal += use;
    }

    /** 位移：幅度取本窗口内的最大值（**不相加**），已在播且不更弱就忽略 */
    private requestShake(px: number, ms: number, freq: number, directional: boolean): void {
        if (!(px > 0) || !(ms > 0)) return;
        const amp = Math.min(px, HIT_FEEL_BUDGET.shakeMaxPx);
        if (amp <= this.shakeAmp && this.shakeRemainMs > 0) {
            this.stats.shakesDropped++;
            return;
        }
        this.shakeAmp = amp;
        this.shakeDurMs = ms;
        this.shakeRemainMs = ms;
        this.shakeElapsedMs = 0;
        this.shakeFreq = freq > 0 ? freq : 22;
        if (directional) {
            this.shakeDirX = this.frameDirX;
            this.shakeDirY = this.frameDirY;
        } else {
            const a = Math.random() * Math.PI * 2;
            this.shakeDirX = Math.cos(a);
            this.shakeDirY = Math.sin(a);
        }
        // 方向退化（来源缺失 / 重合）→ 随机一个方向，避免"震了但看不出来"
        if (this.shakeDirX === 0 && this.shakeDirY === 0) {
            const a = Math.random() * Math.PI * 2;
            this.shakeDirX = Math.cos(a);
            this.shakeDirY = Math.sin(a);
        }
        this.shakePhase = Math.random() * Math.PI * 2;
        this.stats.shakes++;
    }

    /**
     * 音效请求（B4；50ms 窗口内最多 2 声）
     *
     * 三条口径：
     *   · **超限直接丢弃并计数**（`stats.sfxDropped`）—— 不排队、不补偿、不做"下一帧补一声"
     *     （补出来的那一声会跟真正的因果错位，比不响更糟）；
     *   · **音量不吃密度系数 k**：密度已经由节流管住，再让每一声都变轻，后期打击反馈会整体消失；
     *   · 音高随机靠**预渲染的变体**（引擎没有变调 API，见 `HitFeelTierSpec.sfxVariants`），
     *     `Math.random` 只用来挑一份，不参与任何战斗数值。
     *
     * @param base 档位表 / 非档位表里的键名（空串 = 这一档不发声）
     * @param volume 播放音量（0~1）
     * @param variants 音高变体数（1 / 2 / 3）
     */
    private requestSfx(base: string, volume: number, variants: number): void {
        if (!base) return;
        const winSec = HIT_FEEL_BUDGET.sfxWindowMs / 1000;
        let drop = 0;
        while (drop < this.sfxStamps.length && this.clock - this.sfxStamps[drop] >= winSec) drop++;
        if (drop > 0) this.sfxStamps.splice(0, drop);
        if (this.sfxStamps.length >= HIT_FEEL_BUDGET.sfxMaxPerWindow) {
            this.stats.sfxDropped++;
            return;
        }
        this.sfxStamps.push(this.clock);
        this.stats.sfx++;
        // 没有接播放器时**照样占掉这一格**：节流是"该响几声"的账，与"谁来响"无关
        // （体检脚本正是靠这一点，在不依赖任何音频文件的情况下真跑这本账）
        if (!this.sfxPlayer) return;
        this.sfxPlayer(hitFeelSfxKey(base, variants, Math.random()), volume);
    }

    /** 伤害传播方向（source → target，单位向量）；来源缺失时返回 (0,0) 由调用方兜底 */
    private directionOf(source: any, target: any): { x: number; y: number } {
        const sp = source?.position;
        const tp = target?.position;
        if (!sp || !tp) return { x: 0, y: 0 };
        const dx = tp.x - sp.x;
        const dy = tp.y - sp.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (!(len > 0)) return { x: 0, y: 0 };
        return { x: dx / len, y: dy / len };
    }

    /** 裁剪密度窗口（只保留最近 `HIT_FEEL_DENSITY.windowSec` 内的命中时间戳） */
    private pruneHitTimes(): void {
        const from = this.clock - HIT_FEEL_DENSITY.windowSec;
        let drop = 0;
        while (drop < this.hitTimes.length && this.hitTimes[drop] < from) drop++;
        if (drop > 0) this.hitTimes.splice(0, drop);
    }
}
