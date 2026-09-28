import { UNIT_VISUALS, UnitKind } from './EntityVisualConfig';

/**
 * ============================================================
 * DamageTextConfig —— 飘伤害字的唯一数据来源（配色 / 尺度 / 寿命 / 合并与上限）
 * ============================================================
 *
 * 与 EntityVisualConfig 同一条约定：本文件**不依赖 cc**（只存 0xRRGGBB 整数与数值），
 * 表现层（DamageTextLayer）负责转 cc.Color 与绘制。
 *
 * ---- 设计口径（一个视觉通道只承载一个含义，避免通道打架）----
 *   颜色 → **打谁**：英雄受击一律红（直接复用 EntityVisualConfig 里英雄的受击闪烁色），
 *                   其余白（与普通怪的受击闪烁色一致）→ 玩家一眼分清"我掉血"和"怪掉血"
 *   尺度 → **打击分量**：暴击 = 1.6× 字号 + 左侧一枚实心菱形标
 *   运动 → **力度**：暴击起跳带 pop 回弹、上浮更高更慢
 *   寿命 → **优先级**：暴击最长（看得清），普通最短（不占屏）
 *   数字 → 只有量级，不带任何文字（不写"伤害"/"暴击"/"+43"）
 *
 * **为什么颜色不用来区分暴击**：颜色通道已经被单位配色与受击色占满
 * （见 EntityVisualConfig：普通 6B8E9B / 精英 9B59B6 / 各 Boss …，受击色 白/紫/橙/青…），
 * 再拿它表示暴击，会出现"紫色数字到底是暴击、还是魔法伤害、还是精英怪挨打"的三义性。
 * 普通与暴击的分野交给**尺度和几何形状**，颜色留给玩家真正需要秒判的信息。
 */

/** 飘字档位（决定尺度 / 寿命 / 运动 / 几何标；颜色与档位正交，见文件头） */
export enum DamageTextTier {
    /** 普通伤害 */
    Normal = 'normal',
    /** 暴击伤害 */
    Crit = 'crit',
}

/** 单个档位的表现参数（改手感只动这张表） */
export interface DamageTextStyle {
    /** 字号倍率（实际字号 = DAMAGE_TEXT.baseFontSize × scale × 英雄受击加成 × pop） */
    scale: number;
    /** 颜色 0xRRGGBB（普通伤害 / 怪物受击） */
    color: number;
    /** 英雄受击色 0xRRGGBB（优先级最高，覆盖 color） */
    heroColor: number;
    /** 存活时长（秒） */
    life: number;
    /** 上浮总高度（世界单位 ≈ 像素） */
    rise: number;
    /** 起始缩放倍率（1 = 不弹）；暴击靠它做出"砸下来"的顿挫 */
    pop: number;
    /** pop 回落到 1 所用时长（秒）；0 = 不做 pop */
    popTime: number;
    /**
     * 暴击几何标（实心小菱形，贴在数字左侧）的半宽倍率（相对字号）；0 = 不画
     *
     * 为什么是"左侧一枚菱形"而不是"菱形框把数字框住"：框的宽高比会随位数变化 ——
     * 3 位数还像个菱形，4 位数就扁成"透镜"，既不像有意为之又极占屏（本层并发上限 24 个）。
     * 左侧标与位数无关、恒定占 ~20×22px，且数字本身的轮廓保持干净：
     * 一堆飘字互相重叠时，小菱形不会像外框那样互相切出一道道噪音。
     * 三种画法的并排对比见 docs/damage-text-mockup.png 底部（框定高 / 框自适应高 / 左侧菱形标）。
     */
    marker: number;
    /** 暴击几何标：半高倍率（比半宽略高一点，菱形更"挺"） */
    markerHeight: number;
    /** 暴击几何标：与数字之间的间距倍率 */
    markerGap: number;
    /** 从寿命的百分之几开始淡出（0~1） */
    fadeFrom: number;
    /** 淘汰优先级：数字越大越不容易被并发上限挤掉 */
    priority: number;
}

/** 全局规则（字号 / 描边 / 合并窗口 / 并发上限 / 排布） */
export const DAMAGE_TEXT = {
    // ============ 字号：觉得大小不对，只动 baseFontSize 这一行 ============
    /**
     * 基准字号（世界单位 ≈ 像素）= **普通伤害的实测字高**
     *
     * 改这一个数就能整体缩放全部飘字（暴击/英雄受击都是它的倍率，见 DAMAGE_TEXT_STYLES.scale）。
     * 参考：战斗单位直径约 50（`battle_constants.collisionRadiusDefault`=26，即半径 26），
     * 所以字高 **16 ≈ 单位直径的 1/3** 属于"看得清又不遮怪"；12 更克制，20 以上会开始糊屏。
     * ⚠ 这是**世界单位**，上屏像素还要乘 Canvas 的适配缩放（设计分辨率 → 实际屏幕）。
     */
    baseFontSize: 16,
    /** 英雄受击额外放大倍率（"我掉血"必须比怪掉血更醒目） */
    heroScaleBonus: 1.15,

    // ============ 描边（白底白字必须压边）============
    /**
     * 描边**溢出量**倍率（相对字号）：描边宽度 = 字宽 + 它 → 每侧多出的暗边 = 字号 × 它 / 2。
     * 0 = 不描边（纯色底、或字号足够大时可以用）。
     * 0.12 × 16 = 1.9px 溢出 → 每侧约 0.96px，是"白字压深色边"刚好能读、又不显得厚重的量。
     */
    outlineGrow: 0.12,
    /**
     * 描边色 0xRRGGBB（深墨色，与项目底色同一套冷色调）
     *
     * 为什么需要：战斗背景是**浅色/白色**，而普通伤害字是白的 —— 白底白字直接看不见。
     * 白字 + 深色描边在**浅底和深底上都能读**，是唯一不用为两套背景各配一套颜色的解法。
     */
    outlineColor: 0x14181b,

    /**
     * 合并窗口（秒）：同一目标 + 同档位 + 同来源的连续伤害，在窗口内**累加成一个数字**而不是叠字。
     * 攻速上限 3 次/秒、DoT 每秒一跳，窗口取 0.15 秒即可吃掉"同一瞬间的多段/多跳"。
     */
    mergeWindow: 0.15,
    /** 全场同时存在的飘字上限，超出时淘汰优先级最低（同优先级淘汰更老的）那个 */
    maxAlive: 24,
    /** 连击阶梯：同一目标连续跳字沿 y 错开的层数（层数 = 已存活数 % ladderSteps） */
    ladderSteps: 3,
    /**
     * 阶梯间距（**相对基准字号的倍率**）：单发永远从基准高度起，连击时才铺成阶梯，不会叠成一坨。
     * 用倍率而不是固定像素：字号是可调的（baseFontSize），间距必须跟着走，
     * 否则把字号调小后相邻数字会直接叠在一起（固定 13px 配 16px 字号就会叠）。
     * 1.25 意味着相邻两个数字之间留出约 1/4 字高的空隙。
     */
    ladderGapRatio: 1.25,
    /** 横向抖散半径（像素）：按 target.uid 稳定散开，AoE 打一片时不重叠（英雄受击不抖，保持居中好读） */
    scatterRadius: 24,
    /** 出生点抬高（相对实体坐标，避免数字糊在怪身上） */
    spawnOffsetY: 26,
    /** 字形笔画粗细（相对字号的倍率） */
    strokeRatio: 0.16,
    /** 字距（相对字号的倍率，含字宽） */
    advanceRatio: 0.92,
} as const;

/** 档位参数表 */
export const DAMAGE_TEXT_STYLES: Record<DamageTextTier, DamageTextStyle> = {
    // 普通伤害：白字、小、短、不弹 —— 高频跳字不抢戏
    [DamageTextTier.Normal]: {
        scale: 1,
        color: 0xffffff,
        heroColor: UNIT_VISUALS[UnitKind.Hero].hitColor,
        life: 0.45,
        rise: 28,
        pop: 1,
        popTime: 0,
        marker: 0,
        markerHeight: 0,
        markerGap: 0,
        fadeFrom: 0.55,
        priority: 1,
    },
    // 暴击：同色但 1.6× 字号 + 左侧实心菱形标 + pop 回弹 + 上浮更高更久 —— 靠尺度与形状宣示，不靠颜色
    [DamageTextTier.Crit]: {
        scale: 1.6,
        color: 0xffffff,
        heroColor: UNIT_VISUALS[UnitKind.Hero].hitColor,
        life: 0.75,
        rise: 46,
        pop: 1.4,
        popTime: 0.16,
        marker: 0.24,
        markerHeight: 0.32,
        markerGap: 0.3,
        fadeFrom: 0.6,
        priority: 3,
    },
};

/** 取档位参数（未知档位兜底为普通） */
export function getDamageTextStyle(tier: DamageTextTier): DamageTextStyle {
    return DAMAGE_TEXT_STYLES[tier] ?? DAMAGE_TEXT_STYLES[DamageTextTier.Normal];
}
