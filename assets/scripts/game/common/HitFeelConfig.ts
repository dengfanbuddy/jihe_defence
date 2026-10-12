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
    /**
     * T3 精英：命中精英及以上。
     *
     * ⚠ 原设计还写着"或技能伤害（`ability != null`）" —— **那个前提在实机里不成立、已作废**：
     * `dmgEvent.ability` 恒为 `undefined`（`Entity.Attack` 把 ability 写死成 undefined、
     * `EffectExecutor` 调 `ApplyDamage` 时不传 ability）⇒ 下面 `resolveHitTier` 里那条分支是死代码，
     * 留着只为"载荷形状变了也读得对"。**技能由 `HitShapeKind`（形态层）承担，见文件后半的 B5 章节。**
     */
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

    // ---- 数量（技能形态层消费，见 HIT_FEEL_SHAPES）----
    /**
     * 技能形态图形（链折线 / 爆炸环 / 多段叠印 / **扇形**）同时在场上限。
     *
     * ⚠ **它是一份独立的额度，不与印痕共用**，这不是偷懒而是刻意的：
     * 一次技能形态图形**替代** N 个个体印痕（N = 被打中的怪物数），
     * 所以形态层越活跃、印痕层越清闲 —— 两边共用一个额度会让"技能救不了糊屏"。
     * 上限取得很小（8）：形态是"这一下是什么"的**答案**，同一瞬间不该有 8 个答案。
     */
    shapeAliveMax: 8,
    /**
     * 技能形态图形每秒新建上限（1s 滑动窗口；超限**丢弃并计数**，不排队不补偿）。
     *
     * 12/s 的量级依据：形态只在"一次普攻引发的多目标结算"上产生，
     * 而攻速上限 3 次/秒、每次最多一个形态 → 常态远低于它。
     */
    shapeSpawnPerSecMax: 12,
    /** 形态新建速率的统计窗口（秒） */
    shapeSpawnWindowSec: 1.0,

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
 * 技能形态层（B5）—— **力度台阶之外的第二根轴**
 * ============================================================
 *
 * ---- 为什么必须有这一层（这是 B0~B4 留下的唯一空洞）----
 * B0~B4 只有**一根轴**：档位（T0~T7）回答「打谁多重」。它的判据是 `target.unitKind` + `isCrit`，
 * 而**不包含"这一下是什么技能"**。设计文档 §4 原本写着 T3 的触发条件之一是「`ability != null` 的技能伤害」，
 * 但**那个前提在实机里不成立**：`dmgEvent.ability` 恒为 `undefined`
 * （`Entity.Attack` 把 ability 写死成 undefined，`EffectExecutor` 的 `damage`/`aoe_damage`
 * 调 `ApplyDamage` 时根本不传 ability，全工程 39 处 `ApplyDamage` 没有一处能传出它）。
 * ⇒ **玩家所有技能伤害（30 个肉鸽技能 + 43 个遗物钩子 + 4 个机制神器 + 掉落 Buff）都落在 T0，
 * 与一次普通普攻逐图元相同** —— 榴弹炸 6 只怪 = 屏幕上 1 个刻度 + 1 个 26px 细环。
 *
 * ---- 第二根轴回答什么 ----
 *   · 第一根轴（档位）：**多重** —— 顿帧多久、抖多少、几个环、几条刻度；
 *   · 第二根轴（形态）：**是什么** —— 链式？爆炸？多段？全场？
 * 两根轴**正交**：一次技能爆炸打普通怪 = 形态 Blast + 档位 T0（个体印痕被形态吸收，所以看不见 T0 的弱）。
 *
 * ---- 形态是怎么判出来的（**纯表现层推断，战斗侧零改动**）----
 * 靠一个已经存在的事实：**一次 chain / AoE 的 N 次结算全部落在同一帧**
 * （`EventBus.publish` 是同步的，`DamagePipeline` 第 7 阶段逐目标发 `OnTakeDamage`）。
 * 于是「同源 + 同帧 + 一次普攻锚点」的命中点集合就是一次技能的**全部落点**，几何形状足以分类。
 * 锚点（`OnAttackLanded` 的目标 / `OnKill` 的死者）是关键：
 *   · 它把"技能打出来的一片"与"两个互不相干的 DoT 恰好在同一帧跳字"分开
 *     —— 后者没有锚点，**不会被误判成技能**（这是本规则最重要的一条保险）；
 *   · 它同时给出爆炸的**圆心**。
 *
 * ---- 分类规则（几何口径，**刻意不看伤害数值**）----
 * 追踪弹/遗物连锁用的是**定值不衰减**的伤害、雷链用的是递减伤害、AoE 用的是同一个值，
 * 所以"按伤害模式区分"区分不出来（前两者数值上完全同形）。最终按"哪种画法最能解释玩家看到的事"分：
 *   1. 只有一个目标、但同帧被打 ≥2 次 → **Multi**（分裂弹的"额外子弹"）；
 *   2. 全部落点都在锚点 80px 内 → **Blast**（挤成一堆，画"面"才有信息）；
 *   3. 落点散开、且能用「从锚点贪心取最近未命中」串起来（= `chain()` 的原始规则）→ **Chain**（画"线"）；
 *   4. 落点又多又远（≥6 个 且 >225px）→ **Fullscreen**（天怒那种全场）。
 * ⚠ **已知的降级**：短跳距的链式弹射（跳距 < 80px）会落进第 2 条、被画成爆炸环 ——
 * 这在几何上无法与 AoE 区分（两者的落点分布完全同形），而爆炸环同样读作"这一片被技能打了一下"，
 * 是可接受的降级。要精确区分必须让战斗侧在 `chain()`/`aoe()` 上打标（设计文档 §13 的"路 B"）。
 *
 * ⚠ **第二处已知降级（如实记下，别当它不存在）**：**同源的多目标周期性伤害**（典型是
 * `Modifier_Poison` 的"死亡传染"一次给一片怪挂上同一个 DoT，此后它们**每秒同帧一起跳字**）
 * 只要与一次普攻落在**同一帧**，就会被当成"一次技能"。
 * 为什么挡不住：`Scene_Game_Stage.tick` 里 `heroAI()`（普攻 + 同步引发的技能伤害）排在 `ctx.Tick()`
 * （DoT 计时）**之前**，所以 DoT 那几条命中正好跟在本批锚点之后，**几何与顺序上都与"技能打了一片"同形**；
 * 而伤害数值也区分不出来（DoT 单跳与 AoE 用的是同一个值）。
 * 影响面：只在"一片怪挂着同一个 DoT"的构筑里出现，表现为**多出一个环/一条短折线**（不会漏画、不影响数值）。
 * 要根治同样得走"路 B"（或者给 `ApplyDamage` 加一个 `isTick` 标记 —— 那正是设计文档 §2 口径 5 否掉的做法）。
 */
export enum HitShapeKind {
    /** 普通命中：形态层不介入，走档位印痕（T0~T7） */
    None = 'none',
    /** 链式弹射（119 雷链 / 114 追踪弹 / 120 静电磁场 / 遗物「连锁」）：沿跳点画折线 */
    Chain = 'chain',
    /** 圆形爆炸（115 榴弹 / 120 引爆 / 126 暴击连锁 / Boss 深渊诅咒 / 遗物溅射·暴击回响·击杀爆炸）：扩散环到真实半径 */
    Blast = 'blast',
    /** 同目标多段（101 分裂弹）：沿伤害方向叠印 */
    Multi = 'multi',
    /**
     * **扇形**（2026-11 新增：Boss「恐惧咆哮」/ 神器「天怒」）：从顶点向外快速扩散的扇面。
     *
     * 为什么要有它（用户口径「最好不要有全屏范围技能，最好是攻击范围内；如果要大范围，
     * 可以是扇形，但也要有所表现，比如从中心向外快速扩散」）：
     *   · 圆形（Blast）回答的是"以某点为中心炸了多大一片"，它**没有朝向**；
     *   · 近战的"正前方一击"、Boss 的"咆哮"在语义上是**有朝向的一段** ——
     *     画成圆会读成"这是个光环"，画成扇面才读得出"它朝我这边吼了一下"。
     * 半径仍然**等于真实作用半径**（与 Blast 同一条硬口径），只是多了 `dirX/dirY/halfAngleDeg`。
     */
    Fan = 'fan',
}

/**
 * 单个形态的**力度 + 画法**规格。
 *
 * ⚠ 这里的 `stopMs` 走的是**和档位表同一本账**（`HIT_FEEL_BUDGET.stopMsPerWindow` 的 1s 滑窗），
 * 所以形态只是"让技能够得着这本账的额度"，而不是绕过它 —— 时间税 ≤3% 的硬口径不变。
 */
export interface HitShapeSpec {
    /** 顿帧请求（毫秒；最终由账本决定能不能真停，与档位表同一条链路） */
    stopMs: number;
    /** 内容层位移请求（像素；最终由 `shakeMaxPx` 钳制） */
    shakePx: number;
    shakeMs: number;
    shakeFreq: number;
    /** 音效键（空串 = 不发声）。**复用已有音，不新增素材**：形态的音效区分留待 B5 之后单独渲染 */
    sfx: string;
    sfxVolume: number;
    sfxVariants: number;
    /** 图形寿命（毫秒） */
    lifeMs: number;
    /** 线宽（像素） */
    lineWidth: number;
    /**
     * 起始不透明度峰值。
     *
     * ⚠ **与印痕刻意不是一档**：形态层取 **0.85~0.95**（同时最多 8 个，是"这一下是什么"的**答案**，
     * 压在整屏怪堆上必须一次读出来）；印痕那一档才是 ≤0.55（同时最多 24 个，是背景层的"盖章"，
     * 见 `HIT_FEEL_MARK.ringAlpha` 的"浅底上墨线压到 1.0 会像 UI 边框"）。
     * 两者同 α 会出现"满屏都一样重"，所以这条区分是**结构性的**、不是调参。
     */
    alpha: number;
}

/**
 * 形态参数表。
 *
 * 三条取值口径：
 *   · **寿命 180~280ms**：比个体印痕（90~120ms）长 —— 它是"一次技能"，值得多看一眼；
 *     但都短于 300ms，避免后期多个形态叠在场上互相干扰。
 *   · **线宽 2.0~2.8px**：落在风格预设 §3 的"1.2~3px、圆头、只描边不填充"区间内。
 *     ⚠ 2026-11 由 1.4~1.8px **加粗**上来 —— 用户口径「爆炸的圈、扇形看着太浅，看不清」。
 *     加粗（而不是加发光）是设计文档 §3 的 C3 明确指定的路子：**浅底上加法发光/白闪做了也看不见**，
 *     要"更重"只能靠**描边加粗**与**环**（同 §9 不做清单）。
 *   · **顿帧 20~30ms**：与 T3 同级（技能本来就该比普攻重），且单次不超过账本上限。
 */
export const HIT_FEEL_SHAPES: Record<HitShapeKind, HitShapeSpec> = {
    [HitShapeKind.None]: {
        stopMs: 0, shakePx: 0, shakeMs: 0, shakeFreq: 0,
        sfx: '', sfxVolume: 0, sfxVariants: 1, lifeMs: 0, lineWidth: 0, alpha: 0,
    },
    [HitShapeKind.Chain]: {
        stopMs: 20, shakePx: 2, shakeMs: 100, shakeFreq: 24,
        sfx: 'hit_heavy', sfxVolume: 0.55, sfxVariants: 1, lifeMs: 240, lineWidth: 2.2, alpha: 0.88,
    },
    [HitShapeKind.Blast]: {
        stopMs: 25, shakePx: 3, shakeMs: 120, shakeFreq: 22,
        sfx: 'hit_heavy', sfxVolume: 0.62, sfxVariants: 1, lifeMs: 260, lineWidth: 2.8, alpha: 0.95,
    },
    [HitShapeKind.Multi]: {
        stopMs: 15, shakePx: 2, shakeMs: 90, shakeFreq: 26,
        sfx: 'hit_heavy', sfxVolume: 0.45, sfxVariants: 1, lifeMs: 200, lineWidth: 2.0, alpha: 0.85,
    },
    [HitShapeKind.Fan]: {
        stopMs: 28, shakePx: 4, shakeMs: 160, shakeFreq: 21,
        sfx: 'hit_heavy', sfxVolume: 0.70, sfxVariants: 1, lifeMs: 280, lineWidth: 2.6, alpha: 0.95,
    },
};

/** 取形态规格（未知形态兜底为 None = 不介入） */
export function getShapeSpec(kind: HitShapeKind): HitShapeSpec {
    return HIT_FEEL_SHAPES[kind] ?? HIT_FEEL_SHAPES[HitShapeKind.None];
}

/**
 * 形态层的**分类与画法**参数。
 *
 * 分类阈值（前三条）与画法参数（其余）放在一起：它们只有这一份实现，
 * 而"阈值"与"画法"必须一起调 —— 把阈值调大就会改变哪些技能落到哪个形状上。
 */
export const HIT_FEEL_SHAPE = {
    // ---- 分类阈值 ----
    /**
     * 落点"挤成一堆"的判定半径（像素）。
     *
     * 取 80 = `HIT_FEEL_MARK.mergeRadius`，**刻意同值**：超过它，个体印痕就已经不再合并了，
     * 说明落点分布已经"散开"、画线比画面更有信息。两处若要分别调，这条注释失效、需重估。
     */
    blastRadiusMax: 80,
    /**
     * 链式串接的单跳上限（像素）。
     *
     * 取 260 = `ShopSkillModifiers` / `RelicHooks` 里那份 `CHAIN_RANGE_PX`（两处硬编码常量，
     * 也是 114/119/120/遗物连锁的 `kv.range` 默认值）。它是"这个游戏的链到底能跳多远"的唯一口径。
     */
    chainHopMax: 260,
    /**
     * 同一批命中的时间窗口（秒）。
     *
     * 取 40ms 与 `HIT_FEEL_MARK.mergeWindowSec` **同值同理由**：60fps 一帧 16.7ms，
     * 同一次技能的 N 次结算有可能被分到相邻两帧（掉帧 / 多段），严格"同一帧"会让一批在帧边界上裂开。
     */
    batchWindowSec: 0.04,

    // ---- 通用画法（四种形态共用）----
    /**
     * 淡出曲线：`α = spec.alpha × (1 − t^fadePow)`（`t` = 已过寿命比例，0→1）。
     *
     * ⚠ 2026-11 由**线性** `× (1 − t)` 改成现在这个"先实后收"的指数，起因是用户口径
     * 「爆炸的圈、扇形看着太浅，看不清」。线性淡出配 200~280ms 的寿命意味着
     * **它一生里有大半时间只剩半透明**（t=0.5 时 α 已经腰斩到 0.48）—— 峰值再高也只是"闪一下"。
     * 改成 >1 的指数之后：前 2/3 寿命都压在峰值附近（t=0.5 → 仍有峰值的 70%），
     * 最后 1/3 一口气收到 0，读作**"这一笔画得实、收得干脆"** ——
     * 正是风格预设里"实线 = 已存在的实体"那条语法（与档位印痕的"盖章"共用同一条语义）。
     *
     * 与 `alpha`、`lineWidth` 的分工：这三条一起构成"看得见"——α 决定**有多黑**、
     * 线宽决定**有多粗**、这一条决定**黑多久**。三者都只作用于形态层，
     * 印痕层（`HIT_FEEL_MARK`）不受影响：那是背景层，本来就该淡一档。
     */
    fadePow: 1.7,

    // ---- 链折线（Chain）画法 ----
    /**
     * 折线的锯齿幅度（像素）与每段的拆分数。
     *
     * 为什么要锯齿：两点之间一条**直线**读作"弹道"（本作已经有弹道拖尾），
     * 而"电"的语言是**折线**。中点垂直偏移 ±`jagPx`，每段拆 `jagSegments` 折 ——
     * 拆 3 折 + 偏移 3.2px 在 260px 的跳距上约 2° 偏角，看得出折、不显得歪。
     * ⚠ 锯齿靠**折点坐标**实现，**不旋转节点**（口径 5：图纸不该歪）。
     */
    chainJagPx: 3.2,
    chainJagSegments: 3,
    /** 逐段显现的延迟（毫秒）—— 读作"电一段一段跳过去"，而不是"整条线突然出现" */
    chainSegDelayMs: 22,
    /** 每个落点的端头刻度长度 / 线宽（像素）：制图里"尺寸线两端"的语法，读作"接上了" */
    chainEndTickLen: 7,
    chainEndTickWidth: 2.2,

    // ---- 爆炸扩散环（Blast）画法 ----
    /** 环层数（逐层延迟扩散，与档位印痕的细环同一套画法） */
    blastRings: 2,
    blastRingStaggerMs: 24,
    /**
     * 环的起始半径比例（0.25 = 从真实半径的 25% 起扩到 100%）。
     *
     * ⚠ 与档位印痕的细环**反向**：那边是"从 6px 起扩到 26px"（猜一个视觉尺度），
     * 这边是"扩到**真实作用半径**" —— 这是本层存在的主要理由：
     * 玩家第一次能看见"我这颗榴弹到底盖住了多大一片"（`kv.radiusM = 1.5` → 75px）。
     */
    blastRingFromRatio: 0.25,
    /** 环上等距刻度条数（制图"尺寸标注"语法，读作"这一圈就是范围"） */
    blastRadialTicks: 8,
    /** 环上刻度的长度 / 线宽（像素） */
    blastTickLen: 6,
    blastTickWidth: 1.9,
    /** 半径的视觉下限 / 上限（像素）：炸到 1 只也要看得出是个环；大范围爆炸不许把环画到屏幕外 */
    blastMinRadiusPx: 24,
    blastRadiusDrawMax: 260,
    /** 环半径的缓动指数（< 1 → 起步快、末段收，与档位印痕同口径） */
    blastGrowPow: 0.55,

    // ---- 扇形扩散（Fan）画法 ----
    /**
     * 扇面里**逐层向外**画几条弧（每条延迟 `fanRingStaggerMs` 出现）。
     *
     * 三条比一条好：一条弧读作"一条曲线"，三条错开的外扩弧才读作"**一波推出去**"
     * （与档位印痕的"细环逐层延迟"、Blast 的双环同一条语法）。
     */
    fanRings: 3,
    fanRingStaggerMs: 30,
    /** 弧的径向分段数（用折线逼近弧 —— 全工程只用 moveTo/lineTo/circle，不引入 arc） */
    fanArcSegments: 10,
    /**
     * 半径的缓动指数（0.45 < Blast 的 0.55 → **起步更快**）。
     *
     * 用户口径的原话是"从中心**快速**向外扩散"，而扇形是近战/Boss 的"一瞬间的出手"，
     * 比爆炸更该有"刷地铺开"的速度感。
     */
    fanGrowPow: 0.45,
    /**
     * 扇面内的径向排线数（不含两条边）。
     *
     * "纸面排线"是风格预设 §0 的基本语法（与全场扫线同源）；放在扇面里读作
     * "这一片被扫过一遍"，而且它**自带方向**（每一条都从顶点出发），比一圈弧更能说明"朝向"。
     */
    fanRadialLines: 5,
    /** 弧两端那两条边的端头刻度长度 / 线宽（制图"尺寸线两端"的语法，读作"扇面的边界在这里"） */
    fanEdgeTickLen: 8,
    fanEdgeTickWidth: 2.4,
    /** 半径的视觉下限 / 上限（像素）—— 与 Blast 同一理由，但上限更大（扇形本来就大） */
    fanMinRadiusPx: 28,
    fanRadiusDrawMax: 320,
    /** 上报里没给半角时的兜底半角（度）：40° 半角 = 80° 扇面，读作"正前方一下" */
    fanDefaultHalfAngleDeg: 40,
    /** 半角的安全夹取范围（度）：太窄读成一条线、太宽读成一个圆 */
    fanMinHalfAngleDeg: 8,
    fanMaxHalfAngleDeg: 170,

    // ---- 多段叠印（Multi）画法 ----
    /** 相邻两段的沿伤害方向偏移（像素）与逐段延迟（毫秒）—— 读作"一节一节打出去" */
    multiDriftPx: 5,
    multiStaggerMs: 34,
    /** 最多画几段（分裂弹最多 count=3，留 1 段余量；超出的段只计数不画） */
    multiMaxStacks: 4,

    // ---- 「击杀锚点的一小片」的判定上限 ----
    /**
     * 击杀锚点（`OnKill`）的一批落点**仍然读作"一次爆炸"**的最大扩散半径（像素）。
     *
     * 原先是 `fullscreenMinRadius`（225，配合"≥6 个落点就画全场扫线"那一支）。
     * 2026-11 去掉 Fullscreen 之后，这条阈值只剩一个作用：**超过它就不介入**
     * （退回个体印痕），因为落点铺得那么开时，一个环已经解释不了"发生了什么"，
     * 而画一条横扫整屏的排线正是用户明确否掉的观感。
     */
    killBlastRadiusMax: 225,
} as const;

/** 一次命中（形态层的输入；只取分类与画法需要的字段） */
export interface HitShapeHit {
    /** 目标实体 uid（同一实体在一批里可能出现多次 = 多段命中） */
    uid: number;
    /** 命中点（逻辑坐标，事件回调里快照过） */
    x: number;
    y: number;
}

/** 一批命中的分类输入 */
export interface HitShapeInput {
    /** 本批命中（同源、同 `batchWindowSec` 窗口内） */
    hits: HitShapeHit[];
    /**
     * 普攻锚点：本批所属那一次普攻命中的目标 uid（0 = 本批不是普攻引发的）。
     * ⚠ **这是"是不是技能"的唯一判据** —— 没有它，两个互不相干的 DoT 恰好同帧跳字会被误判成技能。
     */
    anchorUid: number;
    /** 锚点坐标（普攻目标 / 击杀点） */
    anchorX: number;
    anchorY: number;
    /** 本批是否伴随击杀（天怒、击杀爆炸的判据；无普攻锚点时的第二条路） */
    hasKill: boolean;
}

/** 分类结果 */
export interface HitShapeResult {
    kind: HitShapeKind;
    /**
     * 画折线用的落点（**已按跳序排好**，Chain 专用）。
     *
     * ⚠ 顺序是复刻 `chain()` 的"从当前落点贪心取最近未命中"得到的 —— 规则同源、输入同源，
     * 所以算出来的顺序就是真实的跳序（`OnTakeDamage` 的发布顺序也是这个顺序，两者互为交叉验证）。
     */
    points: { x: number; y: number }[];
    /** 爆炸/扇形/链的中心（圆心或扇形顶点）与半径（像素） */
    cx: number;
    cy: number;
    radius: number;
    /** 多段命中的段数（Multi 专用） */
    stacks: number;
    /**
     * 扇形朝向（单位向量；**Fan 专用**）。
     *
     * 只有显式上报（`battle/SkillShape.ts`）会填它 —— `resolveHitShape` 从落点几何里
     * 推不出朝向（见该函数的注释）。缺省 `(1, 0)`，画出来是"朝右的一扇"，不会画成空。
     */
    dirX?: number;
    dirY?: number;
    /** 扇形**半角**（度；Fan 专用。40 = 总共 80° 的扇面） */
    halfAngleDeg?: number;
}

/** 从锚点出发的贪心最近邻串接（复刻 `ShopSkillModifiers.chain()` 的取点规则）；串不完返回 null */
function greedyWalk(
    startX: number, startY: number,
    pts: { x: number; y: number }[],
): { x: number; y: number }[] | null {
    const left = pts.slice();
    const order: { x: number; y: number }[] = [];
    let cx = startX;
    let cy = startY;
    const r2 = HIT_FEEL_SHAPE.chainHopMax * HIT_FEEL_SHAPE.chainHopMax;
    while (left.length > 0) {
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < left.length; i++) {
            const dx = left[i].x - cx;
            const dy = left[i].y - cy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
        }
        if (best < 0 || bestD > r2) return null;    // 跳不到 → 不是一条链
        const p = left[best];
        order.push(p);
        left.splice(best, 1);
        cx = p.x;
        cy = p.y;
    }
    return order;
}

/**
 * 一批命中 → 形态（**本层唯一的判定点**）。
 *
 * 判定顺序（先专后泛，与 `resolveHitTier` 同一条思路）：
 *   ① 单目标多段 → Multi
 *   ② 有普攻锚点且落点全在锚点附近 → Blast
 *   ③ 有普攻锚点且能串成链 → Chain（串不成 → 退回 Blast）
 *   ④ 无普攻锚点但有击杀锚点的一小片 → Blast
 *   ⑤ 其余 → null（形态层不介入，退回档位印痕）
 *
 * ⚠ **这里永远判不出 `Fan`**：扇形（Boss 咆哮 / 神器天怒）是**有朝向**的作用域，
 *   而批次的落点里根本没有"朝向"这条信息（只打中一个目标时更是什么都推不出来）。
 *   所以 Fan 一律走 `battle/SkillShape.ts` 的**显式上报**（`OnSkillShape`），
 *   判据与结算几何同源 —— 见 `docs/打击反馈设计.md` §13.4 的"路 B"。
 *
 * ⚠ **Fullscreen 已在 2026-11 删除**（用户口径「最好不要有全屏范围技能」）：
 *   原先"无锚点 + 点多且散"会画一条横扫整屏的排线，而那个观感的唯一来源是神器天怒 ——
 *   它现在是一个**扇形**（见 `SpecialBuffs.KillBuff_Skyfall`）。删掉整条路径之后，
 *   铺得过开的批次一律**退回个体印痕**（每个受击者身上照旧有自己的印痕，
 *   只是不再有一条"解释一切"的横扫线）。
 *
 * @returns 形态；`null` = 不介入 —— **调用方必须按"不介入"处理，不许兜底成某个形状**
 */
export function resolveHitShape(input: HitShapeInput): HitShapeResult | null {
    const hits = input?.hits ?? [];
    if (hits.length < 2) return null;               // 一次单体命中没有"形态"可言

    // 去重成"落点"（同一实体被普攻 + AoE 各打一次只算一个落点，除非它是多段的唯一目标）
    const seen: number[] = [];
    const pts: { x: number; y: number }[] = [];
    for (const h of hits) {
        if (seen.indexOf(h.uid) >= 0) continue;
        seen.push(h.uid);
        pts.push({ x: h.x, y: h.y });
    }
    if (pts.length === 0) return null;

    const ax = input.anchorX;
    const ay = input.anchorY;
    const distToAnchor = (p: { x: number; y: number }) => Math.hypot(p.x - ax, p.y - ay);
    let maxR = 0;
    for (const p of pts) maxR = Math.max(maxR, distToAnchor(p));

    const anchored = input.anchorUid > 0 && seen.indexOf(input.anchorUid) >= 0;

    // ⚠ **普攻必须在最前**：这一批的**第一个**命中必须是锚点自身那一下。
    // 依据是场景的真实帧序 —— `Scene_Game_Stage.tick` 里 `heroAI()`（普攻 + 它同步引发的技能伤害）
    // 排在 `ctx.Tick()`（DoT 计时 / 怪物 AI）**之前**，所以"普攻那一下"永远是本批的第一条命中。
    // 这条守卫挡掉的是"别的伤害先落、普攻后到"的批次（那些不是同一次技能）。
    const anchorFirst = anchored && hits[0]?.uid === input.anchorUid;

    // ① 单目标多段（分裂弹）：同帧同一个目标被打 ≥2 次
    if (pts.length === 1) {
        if (hits.length < 2) return null;
        if (anchorFirst || input.hasKill) {
            return {
                kind: HitShapeKind.Multi, points: pts,
                cx: pts[0].x, cy: pts[0].y, radius: 0, stacks: hits.length,
            };
        }
        return null;
    }

    // ②③ 有普攻锚点且普攻在最前：这一批是"一次普攻引发的一次技能"
    if (anchorFirst) {
        const clusterMax = Math.max(HIT_FEEL_SHAPE.blastMinRadiusPx, Math.min(maxR, HIT_FEEL_SHAPE.blastRadiusDrawMax));
        // ② 挤成一堆 → 画"面"（爆炸环）
        if (maxR <= HIT_FEEL_SHAPE.blastRadiusMax) {
            return {
                kind: HitShapeKind.Blast, points: pts,
                cx: ax, cy: ay, radius: clusterMax, stacks: 0,
            };
        }
        // ③ 散开 → 画"线"（链折线）
        //
        // ⚠ **必须先剔掉与锚点重合的那个落点**：普攻命中的目标就是链首（`chain()` 的 `start`），
        // 它的距离恒为 0 ⇒ 会生成一段"零长折线"，白白占掉一个逐段延迟槽，
        // 让真正意义上的**第一跳晚 `chainSegDelayMs` 才出现**（体检脚本第 ⑱ 组就是这么抓到的）。
        const jumpPts: { x: number; y: number }[] = [];
        for (const p of pts) if (distToAnchor(p) > 1) jumpPts.push(p);
        const walk = jumpPts.length > 0 ? greedyWalk(ax, ay, jumpPts) : null;
        if (walk) {
            return {
                kind: HitShapeKind.Chain, points: walk,
                cx: ax, cy: ay, radius: clusterMax, stacks: 0,
            };
        }
        // 串不成链（跳距超上限）→ 退回爆炸环（宁可画"面"，也别什么都不画）
        return {
            kind: HitShapeKind.Blast, points: pts,
            cx: ax, cy: ay, radius: clusterMax, stacks: 0,
        };
    }

    // ④ 没有普攻锚点：只认"有击杀锚点的一小片"（击杀爆炸 / 击杀回响）→ 爆炸环。
    //    ⚠ 这条**必须严格**：DoT 恰好同帧跳字、光环周期伤害都会落进"同源同帧多目标"。
    //    ⚠ 2026-11 去掉了原来的"点多且散 → 全场扫线"那一支（用户口径：不要全屏范围的表现）。
    //      落点铺得比 `killBlastRadiusMax` 还开时**不介入**（退回个体印痕）——
    //      那不是"什么都不画"：每个受击者身上照旧有自己的印痕，只是没有一条解释一切的横扫线。
    if (input.hasKill && pts.length >= 2 && maxR <= HIT_FEEL_SHAPE.killBlastRadiusMax) {
        const r = Math.max(
            HIT_FEEL_SHAPE.blastMinRadiusPx,
            Math.min(maxR, HIT_FEEL_SHAPE.blastRadiusDrawMax),
        );
        return { kind: HitShapeKind.Blast, points: pts, cx: ax, cy: ay, radius: r, stacks: 0 };
    }

    return null;
}

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
 * ⚠ **`e.ability` 那条分支是死代码**（实机里它恒为 `undefined`，见 `HitFeelTier.Elite` 的注释）——
 * 保留它是为了让"载荷形状万一变了"也读得对，**但不要指望它承担技能分档**：
 * 技能由形态层 `resolveHitShape` 承担（那是"这一下是什么"，与本函数回答的"多重"正交）。
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
