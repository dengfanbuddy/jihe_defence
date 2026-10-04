import { UnitKind } from './EntityVisualConfig';

/**
 * ============================================================
 * HitFeelConfig —— 打击反馈的**唯一数值真源**（档位 / 预算 / 衰减）
 * ============================================================
 *
 * 设计文档：`docs/打击反馈设计.md`（「图纸印痕」）。**改打击感只动这一个文件**。
 * 演示台可视化：`tools/hit-feel-preview/` 的预设「本作建议」（两边不一致以设计文档为准）。
 *
 * 与 `EntityVisualConfig` / `DamageTextConfig` 同一条约定：**本文件不依赖 cc**
 * （只存数值与纯函数），逻辑层与表现层都能安全引用，也便于体检脚本直接真跑。
 *
 * ---- 三条法则（任何新增表现都要过）----
 *   ① **因果要有时间差**：命中瞬间让战斗时间停一下（顿帧），比任何特效都便宜、都有效。
 *   ② **力度要有台阶**：打哥布林与打 Boss 必须一眼分得出（见 TIERS）。
 *   ③ **表现要会自己收敛**：塔防后期 3 次/秒 × 6 只/批，任何"每次都拉满"的表现都会糊屏
 *      （见 BUDGET 与 hitFeelDensityScale）。
 *
 * ---- 为什么不做发光 / 白闪 / 粒子 / 后处理 ----
 * 战场底是 `#EBF4FB`（浅底图纸风）：加法混合趋白 → 发光与白闪**做了也看不见**，
 * 粒子/光晕在 `docs/美术风格预设.md` §0 的反面清单里，工程也没有后处理管线。
 * 所以本作的打击感只能靠**时间（顿帧）、位移（抖动/震屏）、线条（印痕）**三样。
 */

/** 打击反馈档位（**力度的唯一语言**：玩家不看飘字就该知道打中了什么） */
export enum HitFeelTier {
    /** 不产生任何表现（英雄死亡等"由结算面板接管"的事件走它） */
    None = 'none',
    /** T0 微：普攻命中未击杀 / DoT 跳一下 —— 最弱档，也是最高频档 */
    Micro = 'micro',
    /** T1 重：暴击命中 */
    Crit = 'crit',
    /** T2 击杀：普通怪死亡 */
    Kill = 'kill',
    /** T3 精英/技能：命中精英及以上，或技能伤害（`ability != null`） */
    Elite = 'elite',
    /** T4 Boss 命中 */
    BossHit = 'boss_hit',
    /** T5 大击杀：精英 / Boss 死亡 */
    BigKill = 'big_kill',
    /** T6 我被打：英雄受击 */
    HeroHurt = 'hero_hurt',
    /** T7 通关：最终 Boss 死亡 */
    Clear = 'clear',
}

/** 印痕规格（**B2 的 `HitVfxLayer` 消费**；B1 不读它，但档位表必须是一份完整的表） */
export interface HitMarkSpec {
    /** 刻度短线（沿伤害方向，像尺寸标注的端头）条数；0 = 不画 */
    ticks: number;
    /** 细环（只描边不填充）层数；0 = 不画 */
    rings: number;
    /**
     * 最外层细环的扩散半径（像素）；0 = 用默认 26
     *
     * ⚠ 它是**按体型**定的、不是按力度定的：Boss 体型 ×1.5~2，同样的 26px 环在 Boss 身上等于看不见，
     *   所以 Boss 档（56px）刻意大于暴击档（40px）。**力度由刻度条数 / 环层数 / 对位十字承载**
     *   （体检脚本 `npm run audit:hitfeel` 的第 ⑨ 组就是照这个口径断言的）。
     */
    ringRadius: number;
    /** 细环线宽（像素）；0 = 用默认 1 */
    lineWidth: number;
    /** 是否画对位十字（制图对位标记） */
    cross: boolean;
    /** 死亡碎片数量（纯色方块/三角）；0 = 不出碎片 */
    shards: number;
}

/** 慢动作规格（只给值得停下来看的档位；暴击**不**慢放，见设计文档 §4） */
export interface HitSlowMo {
    /** 时间缩放（0.35 = 放慢到 35%） */
    scale: number;
    /** 持续时长（**真实**毫秒） */
    ms: number;
}

/** 单档的完整参数 */
export interface HitFeelTierSpec {
    /** 顿帧时长（毫秒，**请求值**；能不能真停由 BUDGET 的账本决定） */
    stopMs: number;
    /** 慢动作；null = 不慢放 */
    slowMo: HitSlowMo | null;
    /** 战斗内容层位移（像素，**请求值**；最终由 BUDGET.shakeMaxPx 钳制） */
    shakePx: number;
    /** 位移是否沿伤害方向（true = 方向性；false = 随机抖） */
    shakeDirectional: boolean;
    /** 位移持续时长（毫秒） */
    shakeMs: number;
    /** 位移振荡频率（Hz） */
    shakeFreq: number;
    /** 受击者原地抖动幅度（像素，表现层 offset，**绝不写 entity.position**） */
    hitShakePx: number;
    /** 受击者原地抖动时长（毫秒） */
    hitShakeMs: number;
    /** 受击者原地抖动频率（Hz）：80~150ms 内约 1.5~2.5 个来回，"高频小幅"才像被打到 */
    hitShakeFreq: number;
    /**
     * 受击者膨胀比例（0.13 = 受击瞬间放大 13% 再弹回）。
     *
     * 为什么是**各向同性膨胀**而不是经典的挤压拉伸：挤压拉伸要沿"伤害轴"变形，
     * 而伤害轴是**径向**的（英雄在中心、怪在外圈），不旋转节点就没法对齐；
     * 而旋转徽记会让小尺寸剪影被转歪 —— 风格预设 §10 明确"单位识别不许依赖细节、小尺寸必须强剪影"。
     * 所以取"被打得鼓一下"这个等价但轴向无关的形态。
     */
    punchPct: number;
    /** 膨胀回落时长（毫秒） */
    punchMs: number;
    /** 层级弹出时长（毫秒，怪群重叠时把被击中的那只短暂置顶）；0 = 不弹出 */
    zPopMs: number;
    /** 印痕规格（B2 消费） */
    mark: HitMarkSpec;
    /** 墨色闪帧 alpha（B3 消费；0 = 不闪。**浅底上只有墨色能用，白闪看不见**） */
    flashFrameAlpha: number;
    /**
     * 音效键（B4 消费；**空串 = 不发声**）。
     *
     * 只写**键名**：不带 `sfx/` 前缀（`AudioMgr.playSFX` 自己补）、不带扩展名、
     * 也不带变体后缀（后缀由 `hitFeelSfxKey` 按 `sfxVariants` 随机挑）。
     * 文件在 `assets/resources/sfx/`，由 `tools/hit-feel-sfx/` **离线渲染**（自研生成器，
     * 参数就是从演示台那份 Web Audio 合成搬过来的，所以风格与这份文档天然一致，且无第三方素材授权问题）。
     */
    sfx: string;
    /**
     * 音效播放音量（0~1；最终 = `AudioSource.volume × 它`）。
     *
     * ⚠ **不吃密度系数 k**：密度已经由"每 50ms 最多 2 声"的节流管住，
     * 再让每一声都变轻，后期打击反馈会整体"消失" —— 与顿帧 / 飘字 / 延迟血条同侧（它们是**信息**，不是装饰）。
     */
    sfxVolume: number;
    /**
     * 音高变体数（1 / 2 / 3）—— 只给**高频、需要听出差异**的三个档位（T0 普攻 / T1 暴击 / T2 击杀）。
     *
     * 为什么不做"播放时变调"：引擎 3.8 的 `AudioSource.playOneShot(clip, volumeScale)` **没有音高参数**，
     * `AudioSource` 也没有 `playbackRate`（只有 clip / loop / volume / play / pause / stop）
     * → 音高随机只能靠**预渲染的多份文件**（设计文档 §12.4）。
     */
    sfxVariants: number;
}

/** 空印痕（省得每档都写一遍） */
const NO_MARK: HitMarkSpec = { ticks: 0, rings: 0, ringRadius: 0, lineWidth: 0, cross: false, shards: 0 };

/** 档位参数表（**这张表就是"力度的台阶"**，改手感只动它） */
export const HIT_FEEL_TIERS: Record<HitFeelTier, HitFeelTierSpec> = {
    // 不产生表现兜底档
    [HitFeelTier.None]: {
        stopMs: 0, slowMo: null, shakePx: 0, shakeDirectional: false, shakeMs: 0, shakeFreq: 0,
        hitShakePx: 0, hitShakeMs: 0, hitShakeFreq: 0, punchPct: 0, punchMs: 0, zPopMs: 0,
        mark: NO_MARK, flashFrameAlpha: 0, sfx: '', sfxVolume: 0, sfxVariants: 1,
    },
    // T0 微：普攻未击杀 / DoT。**高频档，必须极克制**（无顿帧、无位移）
    [HitFeelTier.Micro]: {
        stopMs: 0, slowMo: null, shakePx: 0, shakeDirectional: false, shakeMs: 0, shakeFreq: 0,
        hitShakePx: 2, hitShakeMs: 80, hitShakeFreq: 16, punchPct: 0.06, punchMs: 120, zPopMs: 0,
        mark: { ticks: 1, rings: 1, ringRadius: 26, lineWidth: 1, cross: false, shards: 0 },
        flashFrameAlpha: 0, sfx: 'hit_light', sfxVolume: 0.35, sfxVariants: 3,
    },
    // T1 重：暴击 —— 与普攻**一眼可分**（停一下 + 十字 + 双环），但**不慢放**（慢放留给大事件）
    // ⚠ 30ms = 账本上限：一次暴击就把这一秒的额度用满，所以同秒的第二次暴击不会再停（见 HIT_FEEL_BUDGET）
    [HitFeelTier.Crit]: {
        stopMs: 30, slowMo: null, shakePx: 3, shakeDirectional: false, shakeMs: 100, shakeFreq: 26,
        hitShakePx: 3, hitShakeMs: 110, hitShakeFreq: 22, punchPct: 0.13, punchMs: 150, zPopMs: 0,
        mark: { ticks: 3, rings: 2, ringRadius: 40, lineWidth: 1.4, cross: true, shards: 0 },
        flashFrameAlpha: 0, sfx: 'hit_crit', sfxVolume: 0.70, sfxVariants: 2,
    },
    // T2 击杀：普通怪。⚠ 早期"一发一个哥布林"时频率 = 攻击频率（1.2/s），所以顿帧给得很短
    [HitFeelTier.Kill]: {
        stopMs: 25, slowMo: null, shakePx: 2, shakeDirectional: false, shakeMs: 90, shakeFreq: 22,
        hitShakePx: 0, hitShakeMs: 0, hitShakeFreq: 0, punchPct: 0, punchMs: 0, zPopMs: 0,
        mark: { ticks: 0, rings: 2, ringRadius: 30, lineWidth: 1.2, cross: false, shards: 4 },
        flashFrameAlpha: 0, sfx: 'kill_normal', sfxVolume: 0.65, sfxVariants: 3,
    },
    // T3 精英 / 技能命中：线加粗一档，读作"打到硬东西了"
    [HitFeelTier.Elite]: {
        stopMs: 30, slowMo: null, shakePx: 2, shakeDirectional: false, shakeMs: 90, shakeFreq: 24,
        hitShakePx: 3, hitShakeMs: 100, hitShakeFreq: 20, punchPct: 0.10, punchMs: 130, zPopMs: 200,
        mark: { ticks: 2, rings: 1, ringRadius: 32, lineWidth: 2.2, cross: false, shards: 0 },
        flashFrameAlpha: 0, sfx: 'hit_heavy', sfxVolume: 0.60, sfxVariants: 1,
    },
    // T4 Boss 命中：环更大、弹出更久（Boss 体型 ×1.5~2，普通规格在它身上会"看不见"）
    [HitFeelTier.BossHit]: {
        stopMs: 30, slowMo: null, shakePx: 3, shakeDirectional: false, shakeMs: 110, shakeFreq: 24,
        hitShakePx: 4, hitShakeMs: 120, hitShakeFreq: 20, punchPct: 0.12, punchMs: 150, zPopMs: 250,
        mark: { ticks: 3, rings: 1, ringRadius: 56, lineWidth: 1.6, cross: false, shards: 0 },
        flashFrameAlpha: 0, sfx: 'hit_boss', sfxVolume: 0.65, sfxVariants: 1,
    },
    // T5 大击杀：精英 / Boss 死亡 —— 峰值档（慢动作 + 碎片 + 三环 + 墨闪）
    [HitFeelTier.BigKill]: {
        stopMs: 60, slowMo: { scale: 0.35, ms: 180 }, shakePx: 6, shakeDirectional: true, shakeMs: 200, shakeFreq: 20,
        hitShakePx: 0, hitShakeMs: 0, hitShakeFreq: 0, punchPct: 0, punchMs: 0, zPopMs: 0,
        mark: { ticks: 0, rings: 3, ringRadius: 60, lineWidth: 1.4, cross: false, shards: 8 },
        flashFrameAlpha: 0.08, sfx: 'kill_big', sfxVolume: 0.85, sfxVariants: 1,
    },
    // T6 我被打：英雄受击。位移**方向性**（从攻击者指向英雄 = 伤害传播方向）→ 读作"从那边来的"
    [HitFeelTier.HeroHurt]: {
        stopMs: 30, slowMo: null, shakePx: 4, shakeDirectional: true, shakeMs: 160, shakeFreq: 28,
        hitShakePx: 0, hitShakeMs: 0, hitShakeFreq: 0, punchPct: 0, punchMs: 0, zPopMs: 0,
        mark: { ticks: 0, rings: 1, ringRadius: 40, lineWidth: 1.6, cross: false, shards: 0 },
        flashFrameAlpha: 0.06, sfx: 'hero_hurt', sfxVolume: 0.90, sfxVariants: 1,
    },
    // T7 通关：最终 Boss 死亡 —— 一局只有一次，做满
    [HitFeelTier.Clear]: {
        stopMs: 90, slowMo: { scale: 0.25, ms: 420 }, shakePx: 8, shakeDirectional: true, shakeMs: 320, shakeFreq: 18,
        hitShakePx: 0, hitShakeMs: 0, hitShakeFreq: 0, punchPct: 0, punchMs: 0, zPopMs: 0,
        mark: { ticks: 0, rings: 4, ringRadius: 90, lineWidth: 1.6, cross: false, shards: 12 },
        flashFrameAlpha: 0.10, sfx: 'clear', sfxVolume: 1.00, sfxVariants: 1,
    },
};

/** 取档位参数（未知档位兜底为最弱档） */
export function getTierSpec(tier: HitFeelTier): HitFeelTierSpec {
    return HIT_FEEL_TIERS[tier] ?? HIT_FEEL_TIERS[HitFeelTier.Micro];
}

/**
 * 档位强弱顺序（数值越大越强）。
 *
 * **必须只有这一份**：有两个消费者按它做"谁更强"的判断，各写一份迟早会分叉 ——
 *   · `HitFeelDirector.mergeFrame` —— 同帧多次命中只保留**最强**的那一档（塔防刚需，见设计文档 §5.1）；
 *   · `HitVfxLayer.evictIfFull` —— 印痕并发超限时先淘汰**最弱档**（同档再比谁更老，见 §5.3）。
 *
 * 注意它**不是**档位表的顺序：T1 暴击(4) 压过 T4 Boss 命中(3)，因为"暴击"是全游戏最稀有的
 * 单次命中事件；而 T6 我被打(5) 又压过暴击 —— 自己掉血永远是最该被看见的那件事。
 */
export const HIT_FEEL_TIER_RANK: Record<HitFeelTier, number> = {
    [HitFeelTier.None]: -1,
    [HitFeelTier.Micro]: 0,
    [HitFeelTier.Kill]: 1,
    [HitFeelTier.Elite]: 2,
    [HitFeelTier.BossHit]: 3,
    [HitFeelTier.Crit]: 4,
    [HitFeelTier.HeroHurt]: 5,
    [HitFeelTier.BigKill]: 6,
    [HitFeelTier.Clear]: 7,
};

/**
 * 预算与合并口径（塔防特有 —— 打击感不是"做不做得出"，而是"扛不扛得住"）
 *
 * 每一条都**必须丢弃并计数**（计数进 `HitFeelDirector.stats`），不允许排队/补偿。
 */
export const HIT_FEEL_BUDGET = {
    // ---- 时间（顿帧的账本）----
    /**
     * 顿帧账本窗口（秒）。
     *
     * ⚠ **为什么顿帧要记账**：`elapsed` 与阶段倒计时走**真实时间**、刷怪节奏按 `elapsed` 索引
     * `SPAWN_BEATS`，而顿帧只冻结战斗实体（`ctx.Tick`）→ 等价于"每秒少打一点输出，但刷怪照常"。
     * 所以顿帧是**对 DPS 的隐性征税**，必须封顶（30ms/s ≈ 3%）。
     */
    stopWindowSec: 1.0,
    /** 窗口内顿帧总量上限（毫秒）—— 常规档位**实际**的单次上限也是它（先到先占，一次最多 30ms） */
    stopMsPerWindow: 30,
    /**
     * 单次顿帧的**物理**上限（毫秒）：无障碍/观感安全阀 —— 任何一次顿帧都不许超过它。
     *
     * 与 `stopMsPerWindow` 的分工（两个旋钮各管一件事，别混）：
     *   · **常规档位**（普攻/暴击/击杀/精英/Boss/英雄受击）：单次 = `min(请求, 账本剩余)`
     *     → 窗口一开时一次最多拿 `stopMsPerWindow`(30ms)，窗口用光就丢弃。
     *   · **峰值档位**（T5 大击杀 / T7 通关）：单次 = `min(请求, stopHardMaxMs)`，
     *     并且**把那一秒的账本一次吃满**（此后 1s 内不再有任何顿帧，绝不叠加）。
     * 所以档位表里常规档位的 `stopMs` 都 ≤ 30 —— 写大了也拿不到，只会让表与实现不一致。
     */
    stopHardMaxMs: 90,
    /**
     * 顿帧期间的时间缩放。
     *
     * ⚠ **不用 0 而用 0.02**：`ctx.Tick(0)` 会让一整条链路吃 dt=0
     * （Modifier 周期、DoT 的 `while` 补齐、AI 移动、弹道推进、缓动归一化），
     * 任何一处对 dt 做了除法或"到点才推进"的假设都可能出边界问题；
     * 而 0.02×（每帧 0.3ms）在 60fps 下与"完全停住"肉眼无差。
     */
    stopTimeScale: 0.02,

    // ---- 空间（战斗内容层位移）----
    /** 位移记账窗口（秒） */
    shakeWindowSec: 0.5,
    /** 窗口内位移上限（像素）：**取最大，不相加**（同帧 20 次命中不能叠成 88px） */
    shakeMaxPx: 6,

    // ---- 数量（B2 的印痕层消费）----
    /** 印痕（含起手印痕）同时在场上限；超限先淘汰**最弱档里最老的**那个 */
    markAliveMax: 24,
    /** 印痕（含起手印痕）每秒新建上限；超限**丢弃 + 计数**，不排队不补偿 */
    markSpawnPerSecMax: 60,
    /** 新建速率的统计窗口（秒） */
    markSpawnWindowSec: 1.0,
    /** 碎片同时在场上限；超限淘汰最老的（碎片是"残骸"，没有档位可分） */
    shardAliveMax: 48,

    // ---- 墨色闪帧（B3 消费）----
    /**
     * 单次墨闪时长（毫秒）—— 设计要求单次 ≤ 50ms。
     *
     * 50ms = 3 帧（60fps）：再长就从"闪了一下"变成"屏幕暗了一下"。
     */
    flashMs: 50,
    /** 墨闪 α 硬上限（设计要求 ≤ 0.10；档位表里 T5/T6/T7 分别是 0.08/0.06/0.10） */
    flashMaxAlpha: 0.10,
    /**
     * 墨闪冷却（秒）—— 设计要求 1.5s。
     *
     * **这条比时长更重要**：浅底上墨色是"重"的，连闪会读成"屏幕在抽"。
     * 冷却期内**直接丢弃**（不排队、不补偿），并计入 `stats.flashesDropped`。
     */
    flashCooldownSec: 1.5,

    // ---- 音效（B4 消费）----
    /**
     * 音效节流窗口（毫秒）—— 设计要求 50ms。
     *
     * ⚠ **音效是唯一"每次命中都必然比一次表现更贵"的东西**：印痕并发有上限、位移取最大、
     * 顿帧有账本，而音频是"每响一声就真的多一路混音"。后期 3 次/秒 × 6 只/批时，
     * 不节流会直接糊成白噪音 —— 所以这里按**时间窗口**而不是"按数量"记账。
     */
    sfxWindowMs: 50,
    /** 窗口内最多响几声（超限**丢弃并计数**，不排队不补偿）—— 设计要求 2 声 */
    sfxMaxPerWindow: 2,

    // ---- 掉帧守卫 ----
    /**
     * dt 钳制区间（秒）。低于下限视为无效帧；高于上限说明卡了（演示台实测踩过
     * `(ts - lastT)/1000 || 0.016` 里 **0 是 falsy** → rAF 成簇时每个空帧白推 16ms 战斗，
     * 命中数变成理论值的 3~5 倍）。
     */
    dtMinSec: 0.001,
    dtMaxSec: 0.05,
} as const;

/**
 * ============================================================
 * 印痕画法（**B2 的 `HitVfxLayer` 消费**：刻度 / 细环 / 对位十字 / 碎片 / 起手印痕）
 * ============================================================
 *
 * 「画多大、画多细、什么颜色、活多久」全部在这里；**每个档位画几条、几个环**在 `HIT_FEEL_TIERS[].mark`。
 * 两者分工别混：前者是**画法**（一份），后者是**力度**（按档）。
 *
 * ---- 调色板只有三个色（这是刻意的）----
 * 风格预设允许的颜色是「墨 + 青绿 + 英雄暗红」，而设计文档 §2 口径 4 把**颜色通道整个分配给「打谁」**：
 * 打怪 = 墨，打英雄 = 英雄红。于是：
 *   · **伤害类型 / 暴击 / 力度一律不靠颜色**（靠刻度条数、环层数、对位十字的形状）；
 *   · **印痕一律不取单位本体的受击色** —— `UNIT_VISUALS` 里那套 `#E74C3C` / `#00FFFF` 是原型期口径，
 *     `docs/美术风格预设.md` §9-4 记着"实机敌人是灰调墨线徽记"这处真实规范冲突（尚未拍板）。
 *     取单位色会把高饱和色直接带进印痕，等于用打击反馈替那处冲突做了决定 —— 所以不取。
 *     若主美拍板"印痕跟随单位色"，改的只是 `shardColorsOf()` 一处。
 */
export const HIT_FEEL_MARK = {
    // ---- 调色板（0xRRGGBB；与美术风格预设的 token 对齐）----
    /** `c-ink-900` 墨：印痕主色（"实线 = 已存在的实体"） */
    ink: 0x14181b,
    /** `c-ink-700` 冷板岩灰：需要退一档的元素（目前只用于碎片的次级块） */
    inkSoft: 0x445054,
    /** 英雄红：**只用于"这一下打在英雄身上"**（与 `UNIT_VISUALS.hero.hitColor` 同一个色） */
    heroRed: 0xff4c4c,

    /**
     * 线宽下限（像素）。
     *
     * 密度衰减 k 会乘到线宽上，而 `k` 最小 0.55、最细档位线宽 1px → 0.55px 在浅底上等于消失。
     * 所以**尺寸可以无限压细、线宽不许低于这个值**（0.8px 是这批设备上还能分辨的极限）。
     */
    minLineWidth: 0.8,

    // ---- 刻度 tick（尺寸标注的端头：垂直于伤害方向的短线）----
    /** 单条刻度长度（像素） */
    tickLength: 10,
    /** 刻度线宽（像素） */
    tickWidth: 1.6,
    /** 相邻刻度的间距（像素）—— 刻度按"沿伤害方向一字排开"布置，奇数条正好盖在命中点上 */
    tickGap: 6,
    /** 刻度寿命（毫秒） */
    tickLifeMs: 90,
    /** 整组刻度沿伤害方向外移的距离（像素）：读作"被这一下顶开" */
    tickDrift: 6,
    /** 刻度淡出曲线：`alpha = (1-t)^tickFadePow`（指数 > 1 → 前段更实、末段掉得快） */
    tickFadePow: 1,

    // ---- 细环 ring（只描边不填充，见 GraphCircle 的既有口径）----
    /** 环的起始半径（像素）：从命中点"炸开"而不是突然出现一个圈 */
    ringFrom: 6,
    /** 单层环的寿命（毫秒） */
    ringLifeMs: 120,
    /** 环的起始不透明度（最高档也只有 0.55 —— 浅底上墨线压到 1.0 会像 UI 边框） */
    ringAlpha: 0.55,
    /** 多层环的**逐层延迟**（毫秒）：让三环/四环读作"一波一波扩散"而不是"同心圈叠着" */
    ringStaggerMs: 18,
    /** 最内层环的半径占比（外层 = 1.0 × ringRadius，内层从这个比例起） */
    ringInnerRatio: 0.6,
    /** 环半径的缓动指数（`r = from + (to-from) × t^pow`，< 1 → 起步快、末段收） */
    ringGrowPow: 0.55,

    // ---- 对位十字 cross（制图对位标记 = 暴击的**形状**签名）----
    /** 臂长（像素，从命中点往两侧各这么长） */
    crossArm: 5,
    /** 线宽（像素） */
    crossWidth: 2.2,
    /** 寿命（毫秒） */
    crossLifeMs: 110,

    // ---- 碎片 shard（**只在死亡时**出现，见设计文档 §9 不做清单）----
    /** 碎片边长下限 / 上限（像素）—— 按块序在这两者之间取，避免"一排一模一样的小方块" */
    shardSizeMin: 3,
    shardSizeMax: 4.5,
    /** 乘完密度系数 k 之后的尺寸下限（像素）：再小就是"看不见的灰点"，不如不画 */
    shardSizeFloor: 2.2,
    /** 碎片寿命（毫秒，比印痕长：印痕是"盖章"，碎片是"残骸"） */
    shardLifeMs: 260,
    /** 初速下限 / 上限（像素/秒） */
    shardSpeedMin: 60,
    shardSpeedMax: 140,
    /** 相对伤害方向的散射半角（弧度，±25°）—— 全沿一条线会读成"子弹"而不是"碎开" */
    shardSpreadRad: 0.44,
    /** 出生点离命中点的距离（像素）：从本体外缘起飞，不从中心 */
    shardBirthRadius: 8,
    /** 碎片是否减速（true = 初速最快、末段滑停；俯视视角没有重力，所以靠它读"减速"） */
    shardDecay: 0.55,

    // ---- 起手印痕（前摇的替代品：**不延后结算**，只在出手瞬间画一道虚线预告）----
    /** 虚线段数 */
    attackDashes: 3,
    /** 每段长度 / 段间距（像素） */
    attackDashLen: 6,
    attackDashGap: 4,
    /** 起点离攻击者的距离（像素）：从本体外缘起笔 */
    attackOffset: 14,
    /** 线宽（像素） */
    attackWidth: 1.4,
    /** 寿命（毫秒）：比印痕更短 —— 它是"预告"，不是"结果" */
    attackLifeMs: 80,
    /** 起始不透明度（虚线 + 低不透明 = 风格预设里的"预告线"语法） */
    attackAlpha: 0.5,
    /** 整组虚线沿伤害方向滑出的距离（像素）：读作"打出去了" */
    attackSlide: 10,

    // ---- 闪避斜杠（B3 / F3 几何符号：「没打中」也要有形状，而不是什么都不发生）----
    /**
     * 斜杠长度 / 线宽 / 寿命（像素 / 像素 / 毫秒）。
     *
     * 画在被闪避者的**头顶上方**（`evadeOffsetY`）而不是身上：它表达的是"这一下没落下来"，
     * 画在身体上会被读成"受击的一种"。颜色用次级墨灰（比印痕淡一档）—— 闪避是**缺席**，不是事件。
     *
     * 另两个符号（F3 的"免疫圆 / 格挡方"）**暂时做不了**：格挡走的是 Modifier 的
     * `on_block_damage` 派发、**总线没有事件**；免疫则没有可判据的载荷（`finalDamage === 0`
     * 也可能是纯减伤到 0）。要接它们得先补一条总线事件，届时按同样的画法加两个 kind 即可。
     */
    evadeLen: 18,
    evadeWidth: 2.4,
    evadeLifeMs: 160,
    /** 离被闪避者中心的高度（像素，正数 = 上方） */
    evadeOffsetY: 16,

    // ---- 合并（G2：档位相同且目标相邻 → 合成一次，读作"这一片被盖了一章"）----
    /**
     * 合并的时间窗口（秒）。
     *
     * 取 40ms 而不是"严格同帧"：60fps 一帧 16.7ms，AoE 的 N 次命中**有可能被分到相邻两帧**
     * （`ctx.Tick` 里同一帧结算完，但掉帧/多段伤害会让它跨帧）—— 严格同帧会让本该合成一片的
     * 印痕在帧边界上裂成两片，看起来像"抖了一下"。
     */
    mergeWindowSec: 0.04,
    /** 合并的距离阈值（像素）：80px ≈ 3 个哥布林直径，正好是"这一片"的视觉尺度 */
    mergeRadius: 80,
} as const;

/**
 * ============================================================
 * 信息层（B3）——“屏幕层”与 HUD 的数值口径
 * ============================================================
 *
 * 消费方两个：
 *   · `game_stage/entityview/HitScreenLayer.ts` —— 屏幕边缘受伤角标 / 连击计数 / 击杀落款 / 奖励飞入；
 *   · `ui/scenes/scene_game_stage/cmps/View_Game_Stage.ts` —— HUD 数值弹跳（`hudPop*`）。
 *
 * **分工**：力度台阶（每档闪多少、抖多少）在 `HIT_FEEL_TIERS`；墨闪的时长/α 上限/冷却在
 * `HIT_FEEL_BUDGET`（它是"有账本的预算项"，与顿帧同性质）；这里只回答
 * “这类信息长什么样、活多久、显示阈值是多少”。
 *
 * ⚠ **血条的残影条不在这里** —— 血条的数值口径唯一真源是 `EntityHpBarConfig.ts`
 * （同一条“一个东西只有一个文件”的规矩，见该文件头）。
 */
export const HIT_FEEL_INFO = {
    // ---- F7 屏幕边缘受伤角标（英雄受击时四角报红；**硬边直角标，不用渐变**）----
    /** 角标不透明度峰值（设计要求 0.9） */
    hurtMarkAlpha: 0.9,
    /**
     * 角标颜色 —— `c-danger #C0392B`（风格预设 §9-3 的建议值）。
     *
     * **为什么不用英雄受击色 `#FF4C4C`**：那个是"单位受击色"，语义是**打谁**（口径 4 把颜色通道
     * 整个分配给了"打谁"）；搬到整屏边框上会变成界面里的第四种强调色 —— 风格预设 §10 明确
     * "一个界面里出现第三种强调色"就是违规。而 `c-danger` 的定义正是"只用于文字与细线"，
     * 3px 的角标标线正好落在它的适用范围内。
     */
    hurtMarkColor: 0xc0392b,
    /** 角标存活时长（毫秒）—— 比墨闪长得多：它是"报红"，不是"闪一下" */
    hurtMarkMs: 320,
    /** 直角标每条边的长度（像素） */
    hurtMarkArm: 26,
    /** 直角标线宽（像素） */
    hurtMarkWidth: 3,
    /** 直角标离屏幕边缘的距离（像素） */
    hurtMarkInset: 14,

    // ---- F4 连击计数 ----
    /**
     * 断连窗口（秒）—— 设计要求 2.5s。
     *
     * ⚠ **本作把“连击”定义成“连续击杀”而不是“连续命中”**（设计文档 §7 的原话是“连续命中累计”）：
     * 本作是**自动攻击**的塔防，普攻间隔 833ms（攻速 1.2）永远小于断连窗口 → 只要场上还有怪，
     * 命中就永不断连，计数只会单调涨到几百 —— 那正是“读不出我正在变强”。
     * 击杀才是**离散、有节奏**的事件（怪群一来一串、波次之间会断），所以计击杀。
     */
    comboWindowSec: 2.5,
    /** 低于这个连击数不显示（1 连击没有任何信息量，别占屏幕） */
    comboMinShow: 2,
    /** 连击数字的字号（像素） */
    comboFontSize: 26,
    /** 连击数字的整体淡出时长（毫秒）—— 断连不是“啪”地消失，而是松掉 */
    comboFadeMs: 300,
    /** 连击窗口条的尺寸（像素）：一条细线，长度 = 剩余窗口比例 */
    comboBarWidth: 72,
    comboBarHeight: 3,
    /** 连击块离屏幕左缘的距离（像素） */
    comboInsetX: 26,
    /** 连击块的基准高度（相对屏幕中心，像素；负 = 中心偏下） */
    comboOffsetY: -60,

    // ---- F8 击杀提示（“给每一次击杀一个落款”）----
    /** 落款存活时长（毫秒）—— 设计要求 1.2s */
    killTagMs: 1200,
    /** 落款上浮距离（像素） */
    killTagRisePx: 28,
    /** 落款数字（本次击杀的金币/经验）的字号（像素） */
    killTagFontSize: 15,
    /** 落款左侧短横的长度 / 线宽（像素）：制图里的“引线” */
    killTagLineLen: 14,
    killTagLineWidth: 2,

    // ---- F9 金币 / 经验飞入 ----
    /** 飞行时长（毫秒）—— 设计要求 0.45s */
    lootMs: 450,
    /** 奖励块边长（像素） */
    lootSize: 5,
    /** 飞行轨迹拱起的高度（像素，垂直于起终点连线）—— 直线飞太"机械" */
    lootArcPx: 46,
    /** 没有 HUD 锚点时的退化飞行距离（像素，朝右上） */
    lootFallbackPx: 64,
    /** 同屏奖励块上限（超限淘汰最老的） */
    lootAliveMax: 12,

    // ---- F10 HUD 数值弹跳 ----
    /** 弹跳峰值比例（0.25 = 1.25×） */
    hudPopPct: 0.25,
    /** 弹跳回落时长（毫秒） */
    hudPopMs: 180,
} as const;

/**
 * ============================================================
 * 非档位音效（**B4 消费**：出手 / 闪避）
 * ============================================================
 *
 * 为什么它们不在档位表里：档位表的一行 = "一次**命中 / 死亡**的力度台阶"，
 * 而这两声对应的是**别的因果**（出手、打空），没有"档位"可言。
 * 但它们的**节流账本与档位音共用**（`HIT_FEEL_BUDGET.sfxWindowMs / sfxMaxPerWindow`）——
 * 于是"一次出手 whoosh + 一次命中 impact"在同一个 50ms 窗口里正好用满 2 声，这是**有意的**：
 * 近战英雄的一次攻击本来就是"两声合一记"。
 */
export const HIT_FEEL_SFX_EXTRA = {
    /**
     * 出手（对应 B2 的**起手虚线**；前摇的声音替代）—— **只给英雄**。
     *
     * 为什么怪不响：怪走的是同一个 `Entity.Attack()`，怪群围住英雄时每只都在出手，
     * 全响会变成持续底噪；而"怪在打我"这件事由 T6（英雄受击）代表，因果链更清楚。
     */
    attackShot: { key: 'attack_shot', volume: 0.30, variants: 1 },
    /** 闪避（打空了）—— 对应 B3 的闪避斜杠（F3）。**怪闪掉英雄的普攻也要响**：那是"我打空了"的信息 */
    evade: { key: 'evade', volume: 0.40, variants: 1 },
} as const;

/** 音高变体后缀：第 1 份没有后缀，第 2/3 份是 `_v2` / `_v3`（与 `tools/hit-feel-sfx/` 的产物命名一致） */
export const HIT_FEEL_SFX_VARIANT_SUFFIXES = ['', '_v2', '_v3'] as const;

/**
 * 按变体数挑一个具体资源键。
 *
 * @param base 档位表里的 `sfx`（不含后缀）
 * @param variants `sfxVariants`（1 = 只有基础文件）
 * @param roll `[0, 1)` 的随机数 —— **注入而不是在内部调 `Math.random`**：
 *             体检脚本要能确定性地断言"挑到了哪一份"，也让这条规则可以被真跑。
 *
 * `variants` 会被夹到后缀表长度：写了 4 也只会挑到 `_v3`，
 * 免得出现"表里写了 5 个变体、磁盘上只有 3 份"这种静默降级。
 */
export function hitFeelSfxKey(base: string, variants: number, roll: number): string {
    if (!base) return '';
    const n = Math.max(1, Math.min(variants | 0, HIT_FEEL_SFX_VARIANT_SUFFIXES.length));
    if (n <= 1) return base;
    const r = roll >= 1 ? 0.999999 : (roll < 0 ? 0 : roll);
    return base + HIT_FEEL_SFX_VARIANT_SUFFIXES[Math.floor(r * n)];
}

/**
 * 本设计用到的**全部**音效键（含变体后缀，**不含** `sfx/` 前缀）。
 *
 * 三个消费方，所以必须只有一份实现：
 *   · `Scene_Game_Stage.initBattle` 用它**预加载** —— `playSFX` 是"先加载再播"，
 *     战斗中第一次命中才去加载会明显晚半拍（打击反馈里"晚半拍"等于"没响"）；
 *   · `tools/hit-feel-sfx/render.mjs --check` 用它核对产物是否齐全/是否有漂移；
 *   · `npm run audit:hitfeel` 用它核对磁盘上的素材（**缺文件只警告不判失败**：素材是外部的，
 *     不能因为它卡住代码侧的门禁）。
 */
export function hitFeelSfxKeys(): string[] {
    const keys: string[] = [];
    const push = (base: string, variants: number) => {
        if (!base) return;
        const n = Math.max(1, variants | 0);
        for (let i = 0; i < n; i++) {
            const k = hitFeelSfxKey(base, n, i / n);
            if (k && keys.indexOf(k) < 0) keys.push(k);
        }
    };
    for (const tier of Object.keys(HIT_FEEL_TIERS) as HitFeelTier[]) {
        const spec = HIT_FEEL_TIERS[tier];
        push(spec.sfx, spec.sfxVariants);
    }
    push(HIT_FEEL_SFX_EXTRA.attackShot.key, HIT_FEEL_SFX_EXTRA.attackShot.variants);
    push(HIT_FEEL_SFX_EXTRA.evade.key, HIT_FEEL_SFX_EXTRA.evade.variants);
    // `click` 由 `AudioMgr.defaultTouchStart` 自己引用（平台层不该反过来依赖游戏层配置），
    // 这里登记它**只为"素材要齐"这一条**：它已经写死在平台层里了，缺文件就是每次触摸一次加载失败。
    if (keys.indexOf('click') < 0) keys.push('click');
    return keys;
}

/**
 * `OnAttackStart` 该不该响"出手"音 —— **只给英雄**（理由见 `HIT_FEEL_SFX_EXTRA.attackShot`）。
 *
 * 单独抽成纯函数是为了能被真跑：`OnAttackStart` 是**双方共用**的事件（`Entity.Attack()` 里发的），
 * "只给英雄"这条规则如果散在导演内部，很容易被后来的人当成"漏了怪"改掉。
 */
export function shouldPlayAttackSfx(e: { attacker?: { unitKind?: UnitKind } | null } | null | undefined): boolean {
    return e?.attacker?.unitKind === UnitKind.Hero;
}

/** 密度衰减参数（`k = clamp(minK, 1, 1 / (1 + slope × (n1s − baseline)))`） */
export const HIT_FEEL_DENSITY = {
    /** 统计窗口（秒） */
    windowSec: 1.0,
    /** 基准命中数：不超过它就不衰减（早期一发一杀 ≈ 1.2/s → 全额表现） */
    baseline: 2,
    /** 每多一次命中的衰减斜率 */
    slope: 0.25,
    /** 系数下限（后期怪群也不会把表现压没，只是"变细变小"） */
    minK: 0.55,
} as const;

/**
 * 密度自适应衰减系数（**本作独有，必须有**）
 *
 * 攻速上限 3 次/秒（`atkSpeedCap`）× 多目标 → 后期每秒命中可达 10+ 次。
 * 固定强度的表现到这里必然糊屏，所以**幅度类**表现（印痕尺寸/线宽/环半径/碎片数/受击抖动）
 * 统一乘这个系数；**顿帧不吃它**（顿帧由 BUDGET 的账本控制触发**次数**），
 * **飘字与延迟掉血条也不吃**（它们是信息，不是装饰）。
 *
 * @param hitsInLastSec 最近 1 秒的全场命中数
 */
export function hitFeelDensityScale(hitsInLastSec: number): number {
    const over = hitsInLastSec - HIT_FEEL_DENSITY.baseline;
    if (over <= 0) return 1;
    const k = 1 / (1 + HIT_FEEL_DENSITY.slope * over);
    return k < HIT_FEEL_DENSITY.minK ? HIT_FEEL_DENSITY.minK : k;
}

/** 把 dt 钳到合法区间（掉帧守卫；见 BUDGET.dtMinSec 的注释） */
export function clampBattleDt(dt: number): number {
    if (!(dt > HIT_FEEL_BUDGET.dtMinSec)) return HIT_FEEL_BUDGET.dtMinSec;
    return dt > HIT_FEEL_BUDGET.dtMaxSec ? HIT_FEEL_BUDGET.dtMaxSec : dt;
}

// ============ 事件 → 档位（**唯一的判定点**） ============

/** 该类别的怪是否算 Boss 档（含经济 Boss 与击杀 Boss） */
export function isBossUnitKind(kind: UnitKind): boolean {
    return kind === UnitKind.StageBoss
        || kind === UnitKind.FinalBoss
        || kind === UnitKind.GoldBoss
        || kind === UnitKind.KillBoss;
}

/**
 * `OnTakeDamage` 载荷 → 命中档位
 *
 * 判定顺序（先专后泛）：英雄受击 → 暴击 → 技能 → 精英 → Boss → 普攻/DoT。
 *
 * ⚠ **DoT 与普攻同档（都走 T0）是设计选择，不是妥协**：DoT 单跳本就该用最弱档，
 * 再叠上密度自适应衰减，高频跳字会被自动压到几乎看不见 —— 因此**不需要**给
 * `ApplyDamage` 加 tag（演示台 README §4 第 5 条据此关闭）。
 */
export function resolveHitTier(e: {
    isCrit?: boolean;
    ability?: any;
    target?: { unitKind?: UnitKind } | null;
}): HitFeelTier {
    const kind = e?.target?.unitKind;
    if (kind === UnitKind.Hero) return HitFeelTier.HeroHurt;
    if (e?.isCrit) return HitFeelTier.Crit;
    if (e?.ability) return HitFeelTier.Elite;          // 技能伤害与精英命中同档（T3）
    if (kind === UnitKind.Elite) return HitFeelTier.Elite;
    if (kind !== undefined && isBossUnitKind(kind)) return HitFeelTier.BossHit;
    return HitFeelTier.Micro;
}

/**
 * `OnDeath` 载荷 → 收尾档位（T2/T5/T7；英雄死亡返回 None —— 本局立刻由结算面板接管）
 * @param entity 死亡实体
 */
export function resolveDeathTier(entity: { unitKind?: UnitKind } | null | undefined): HitFeelTier {
    const kind = entity?.unitKind;
    if (kind === UnitKind.Hero) return HitFeelTier.None;
    if (kind === UnitKind.FinalBoss) return HitFeelTier.Clear;
    if (kind === UnitKind.Elite || (kind !== undefined && isBossUnitKind(kind))) return HitFeelTier.BigKill;
    return HitFeelTier.Kill;
}
