import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import {
    HIT_FEEL_BUDGET,
    HIT_FEEL_DENSITY,
    HIT_FEEL_INFO,
    HIT_FEEL_SFX_EXTRA,
    HIT_FEEL_TIER_RANK,
    HitFeelTier,
    HitShapeKind,
    getShapeSpec,
    getTierSpec,
    hitFeelDensityScale,
    hitFeelSfxKey,
    resolveDeathTier,
    resolveHitShape,
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
    /** 判出技能形态的帧数（B5；**同一帧多次也只在合并后算一次**） */
    shapeFrames: number;
    /** 其中链式折线 / 爆炸 / 多段 / **扇形**各自的帧数 */
    chainFrames: number;
    blastFrames: number;
    multiFrames: number;
    fanFrames: number;
    /**
     * 其中**由战斗侧显式上报**（`OnSkillShape`，路 B）定出形状的帧数。
     *
     * 与 `shapeFrames` 相对：差值就是"靠落点几何猜出来"的那部分。
     */
    reportedFrames: number;
}

/** 档位强弱顺序（= `HIT_FEEL_TIER_RANK`；同帧多次命中只保留最强的那个） */
const TIER_RANK = HIT_FEEL_TIER_RANK;

/**
 * 形态强弱顺序（同帧有多个上报时只留最强的那个）。
 *
 * 排序依据 = `HIT_FEEL_SHAPES` 的 `stopMs`（Fan 28 > Blast 25 > Chain 20 > Multi 15），
 * 也就是"这一下值多少顿帧"。改任何一个形态的顿帧额度都要顺手复核这张表。
 */
const SHAPE_RANK: Record<string, number> = {
    [HitShapeKind.None]: 0,
    [HitShapeKind.Multi]: 1,
    [HitShapeKind.Chain]: 2,
    [HitShapeKind.Blast]: 3,
    [HitShapeKind.Fan]: 4,
};

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

    // ---- 本帧累积器：形态推断的输入（B5）----
    /**
     * 本帧的**落点**（同源 + 同帧 = 一次普攻及其引发的全部技能伤害）。
     *
     * 为什么导演也要自己攒一份（`HitVfxLayer` 有一份同样的）：两者提交的时机不同
     * （导演在 `tick` 开头、印痕层在 `update` 开头，谁先谁后由引擎的组件顺序决定），
     * 让其中一方去读另一方的结果会引入"读到上一帧还是这一帧"的时序耦合。
     * 两份缓冲 + **同一个纯函数**（`resolveHitShape`）就没有这个问题，也不会分叉。
     */
    private framePoints: { uid: number; x: number; y: number }[] = [];
    private frameAnchorUid = 0;
    private frameAnchorX = 0;
    private frameAnchorY = 0;
    private frameHasKill = false;
    /**
     * 本帧**显式上报**的形态（`OnSkillShape`；`None` = 本帧没有上报）。
     *
     * 一帧里可能有多个上报（一次 AoE + 一次咆哮），导演只关心"这一帧重不重"，
     * 所以按**强弱**取一个：Fan > Blast > Chain > Multi（与 `HIT_FEEL_SHAPES` 的顿帧强度同序）。
     */
    private frameReportedShape: HitShapeKind = HitShapeKind.None;

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
        shapeFrames: 0, chainFrames: 0, blastFrames: 0, multiFrames: 0, fanFrames: 0, reportedFrames: 0,
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
        // B5 形态层：两个**锚点**。它们不改任何表现强度，只回答"这一批命中是不是一次技能"
        // （没有锚点，两只怪身上的 DoT 恰好同帧跳字会被误判成链式弹射）。
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnAttackLanded, this.onAttackLanded, this));
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnKill, this.onKill, this));
        // 「路 B」：战斗侧显式上报的技能形态。导演要用它拿"这次技能该顿多久/抖多少/响哪一声"，
        // 而这些额度在 `HIT_FEEL_SHAPES` 里是按形态分的 —— 所以**必须**知道形状。
        this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnSkillShape, this.onSkillShape, this));
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
        this.framePoints.length = 0;
        this.frameAnchorUid = 0;
        this.frameAnchorX = 0;
        this.frameAnchorY = 0;
        this.frameHasKill = false;
        this.frameReportedShape = HitShapeKind.None;
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
        // 形态推断的落点（位置必须在回调里快照：实体可能马上被回收）
        if (target.position) {
            this.framePoints.push({ uid: target.uid ?? 0, x: target.position.x, y: target.position.y });
        }

        const tier = resolveHitTier(e);
        const dir = this.directionOf(e?.source, target);
        this.mergeFrame(tier, dir);
    }

    /** 普攻锚点（B5）：一次普攻的目标 = 这一批技能伤害的圆心 / 链首 */
    private onAttackLanded(e: any): void {
        const tgt = e?.target;
        if (!tgt?.position) return;
        this.frameAnchorUid = tgt.uid ?? 0;
        this.frameAnchorX = tgt.position.x;
        this.frameAnchorY = tgt.position.y;
    }

    /** 击杀锚点（B5）：神器天怒的扇形、遗物的击杀爆炸都不是普攻引发的，锚点是死者位置快照 */
    private onKill(e: any): void {
        this.frameHasKill = true;
        const pos = e?.deathPos;
        if (this.frameAnchorUid === 0 && pos) {
            this.frameAnchorUid = -1;              // -1 = 有锚点、但没有锚点自身的命中
            this.frameAnchorX = pos.x ?? 0;
            this.frameAnchorY = pos.y ?? 0;
        }
    }

    /**
     * **显式形态上报**（路 B）：只记"本帧最重的那一个形状"，强度排序与 `HIT_FEEL_SHAPES` 一致。
     *
     * 为什么按强度取一个而不是全收：导演这一层回答的是"**这一帧重不重**"
     * （顿帧/位移/音效都有全局账本，同帧再多事件也只出一份表现），与 `mergeFrame` 同一条口径。
     */
    private onSkillShape(e: any): void {
        const kind = e?.shape as HitShapeKind;
        if (!kind || kind === HitShapeKind.None) return;
        if (SHAPE_RANK[kind] > SHAPE_RANK[this.frameReportedShape]) this.frameReportedShape = kind;
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

    /**
     * 把本帧累积的最高档 + 技能形态转成实际表现（顿帧 / 慢动作 / 位移 / 墨闪 / 音效），然后清空累积器。
     *
     * ---- 两根轴怎么合到一起（B5）----
     * 档位回答"多重"、形态回答"是什么"，两者**正交**，所以这里**取强者而不是相加**：
     *   · 顿帧：`max(档位, 形态)` —— 相加会让"一次技能暴击"吃掉两份额度（账本上限 30ms/1s 不变）；
     *   · 位移：`max(档位, 形态)`（`requestShake` 本身就是"取最大不相加"的口径）；
     *   · 音效：**峰值档位（T5/T7）优先** —— 大击杀/通关那一声比"这是个技能"重要；
     *     其余情况形态优先（技能该有自己的音，现在复用 `hit_heavy`，见 `HIT_FEEL_SHAPES`）。
     *
     * ⚠ 形态**不改变档位本身**（`resolveHitTier` 一行没动）：档位表是"打谁"的唯一语言，
     * 让它随技能变形会让"打 Boss 比打小怪还轻"这类矛盾变得可写。
     */
    private flushFrame(): void {
        const tier = this.frameTier;

        // 形态：**先信"显式上报"（路 B），再退回几何推断（路 A）**。
        // 上报来自战斗侧的同一次结算（`battle/SkillShape.publishSkillShape`），
        // 判据与真实作用几何同源；几何推断则只在没有上报时才用（老效果仍然一个字不改）。
        const wasReported = this.frameReportedShape !== HitShapeKind.None;
        let shapeKind = this.frameReportedShape;
        if (shapeKind === HitShapeKind.None && this.framePoints.length >= 2) {
            const r = resolveHitShape({
                hits: this.framePoints,
                anchorUid: this.frameAnchorUid,
                anchorX: this.frameAnchorX,
                anchorY: this.frameAnchorY,
                hasKill: this.frameHasKill,
            });
            if (r) shapeKind = r.kind;
        }

        if (this.frameHits > this.stats.peakHitsPerFrame) this.stats.peakHitsPerFrame = this.frameHits;
        this.frameTier = HitFeelTier.None;
        this.frameHits = 0;
        this.framePoints.length = 0;
        this.frameAnchorUid = 0;
        this.frameAnchorX = 0;
        this.frameAnchorY = 0;
        this.frameHasKill = false;
        this.frameReportedShape = HitShapeKind.None;

        if (shapeKind !== HitShapeKind.None) {
            this.stats.shapeFrames++;
            if (wasReported) this.stats.reportedFrames++;
            if (shapeKind === HitShapeKind.Chain) this.stats.chainFrames++;
            else if (shapeKind === HitShapeKind.Blast) this.stats.blastFrames++;
            else if (shapeKind === HitShapeKind.Multi) this.stats.multiFrames++;
            else if (shapeKind === HitShapeKind.Fan) this.stats.fanFrames++;
        }

        if (tier === HitFeelTier.None && shapeKind === HitShapeKind.None) return;

        const spec = getTierSpec(tier);
        const shapeSpec = shapeKind === HitShapeKind.None ? null : getShapeSpec(shapeKind);
        const isPeak = tier === HitFeelTier.BigKill || tier === HitFeelTier.Clear;

        // 顿帧：能不能真停由账本决定（T5/T7 是"峰值档位"，可以一次吃满那一秒的额度）
        this.requestStop(Math.max(spec.stopMs, shapeSpec?.stopMs ?? 0), isPeak);

        // 慢动作：同一时刻只留一个，取更强的一个（更慢 / 更长）
        if (spec.slowMo) {
            this.slowScale = Math.min(this.slowScale, spec.slowMo.scale);
            this.slowRemainMs = Math.max(this.slowRemainMs, spec.slowMo.ms);
        }

        // 位移：**取最大、不相加**（幅度恒 ≤ BUDGET.shakeMaxPx）
        // 形态的位移是"方向性"的（从锚点指向落点质心），读作"从那一片来的"
        const sPx = shapeSpec?.shakePx ?? 0;
        if (sPx > spec.shakePx) {
            this.requestShake(sPx, shapeSpec!.shakeMs, shapeSpec!.shakeFreq, true);
        } else {
            this.requestShake(spec.shakePx, spec.shakeMs, spec.shakeFreq, spec.shakeDirectional);
        }

        // 墨色闪帧（C10）：只给 T5/T6/T7（档位表里 flashFrameAlpha > 0 的那三档），且必须过冷却账本
        // ⚠ **形态不申请墨闪**：浅底上墨色是"重"的、1.5s 冷却，技能是高频事件，
        //   让它参与会把"闪一下"稀释成"屏幕在抽"（§9 与 HIT_FEEL_BUDGET.flashCooldownSec 的口径）。
        this.requestFlash(spec.flashFrameAlpha);

        // 音效（B4）：与顿帧/慢放/位移/墨闪**同一条合并链路** —— 同帧 20 次命中只出最强档那一声，
        // 再叠上"50ms 窗口内最多 2 声"的节流（塔防刚需，见 HIT_FEEL_BUDGET.sfxWindowMs）
        if (!isPeak && shapeSpec && shapeSpec.sfx) {
            this.requestSfx(shapeSpec.sfx, shapeSpec.sfxVolume, shapeSpec.sfxVariants);
        } else {
            this.requestSfx(spec.sfx, spec.sfxVolume, spec.sfxVariants);
        }
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
