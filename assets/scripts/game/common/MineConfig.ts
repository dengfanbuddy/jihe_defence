/**
 * MineConfig —— 「骷髅地雷」的**数值真源**（纯 TS 常量，无 cc 依赖、无 import）
 *
 * 流派定位：**召唤增殖**（场上多出"自主工作的东西"）。骷髅王（`units#1010`）的发动机。
 *
 * ── 三条已定案的口径（用户 2026-11）──
 *   ① **满上限就停手**（不再布雷、也不替换最老的）⇒ "上限"是唯一真约束，
 *      玩法是"提前把雷铺在敌人必经之路上"；
 *   ② **物理伤害** —— 与斧王的**纯粹**反伤、莉娜的**法术**持续伤害三条线分开；
 *   ③ **不会被摧毁、无时限** —— 地雷不是实体（不进 `ctx.entities`、没有 hp、不进对象池），
 *      所以它不吃 AoE、不会被 AI 索敌、也不会过期；唯一让它消失的方式是被踩。
 *
 * ── 为什么数值全在这一个文件 + 配表 kv 里 ──
 *   `BattleMines` 一个数都不写死：**基础参数**（间隔/上限/半径/伤害）来自英雄技能那条
 *   `apply_modifier` 的 `kv`，**遗物改造**（急造/雷区/重装/扩爆/燃烧雷/连锁雷）来自遗物钩子
 *   各自的 `kv`。两者都挂成 Modifier，`BattleMines` 每帧用**重算式**（不是增量累加）
 *   从 `hero.modifiers.getAll()` 现读 —— 与 `ArchetypeTally` 同一条口径：
 *   换英雄 / 买第二层 / 遗物被移除都天然正确，不需要任何 add/remove 记账。
 *
 * ⚠ 键名是**配表 ↔ 代码的唯一契约**：改这里必须同时改
 *   `tools/excel_export/excel/*.xlsx` 的 kv 与 `relic-inner-design.mjs` 里的钩子声明。
 */

/** 地雷相关的 kv 键名（配表里 `modifiers[].kv` 用的就是这些字面量） */
export const MINE_KV = {    /** 布雷间隔（秒）—— **基础参数**，只有英雄技能那条行给 */
    interval: 'mineInterval',
    /** 地雷上限（颗）—— **基础参数** */
    cap: 'mineCap',
    /** 触发半径（像素）—— **基础参数** */
    triggerRadius: 'mineTriggerRadius',
    /** 爆炸半径（像素）—— **基础参数** */
    blastRadius: 'mineBlastRadius',
    /** 爆炸伤害（攻击力百分比）—— **基础参数** */
    damagePct: 'mineDamagePct',

    /** 遗物·急造：布雷间隔 −X%（百分数，多件相加后再乘） */
    yieldPct: 'mineYieldPct',
    /** 遗物·雷区：地雷上限 +N */
    capAdd: 'mineCapAdd',
    /** 遗物·重装：爆炸伤害 +X% 攻击力 */
    blastPct: 'mineBlastPct',
    /** 遗物·扩爆：爆炸半径 +X 像素 */
    radiusAdd: 'mineRadiusAdd',
    /** 遗物·燃烧雷：爆炸后留下燃烧地面，每秒 攻击力 ×X% */
    burnPct: 'mineBurnPct',
    /** 遗物·连锁雷：引爆时最多连带引爆 N 颗相邻地雷 */
    chain: 'mineChain',

    /** 局内技能·陷阱：**击杀敌人时**在死者位置留一颗雷（上限 N 颗，与英雄雷共用池） */
    onKill: 'mineOnKill',
} as const;

/**
 * **全部地雷 kv 键名**（`MINE_KV` 的值集），给"配表键名写错就喊一声"那类校验用。
 *
 * ⚠ 为什么不用 `Object.values(MINE_KV)`：本工程 `tsconfig` 的 `lib` 只到 **ES2015**
 *   （同一条限制让 `Array.prototype.includes` 也用不了，`RelicHooks` 里写着"用 indexOf"）。
 *   这里用 `for...in` 现推，仍然是**一份真源**（加键只改 `MINE_KV` 一处）。
 */
export const MINE_KV_LIST: string[] = (() => {
    const out: string[] = [];
    for (const k in MINE_KV) out.push((MINE_KV as Record<string, string>)[k]);
    return out;
})();

/**
 * 缺省值（**只用于容错**：配表漏填某个键时的兜底，不是"设计数值"）。
 *
 * ⚠ 上限的**设计值 5** 写在英雄技能那一行的 kv 里（`abilities.json#28`），
 *   这里的 5 只是"表里没写时别把上限当成 0（= 一颗都放不出）"。
 */
export const MINE_DEFAULTS = {
    /** 布雷间隔（秒） */
    interval: 6,
    /** 地雷上限（颗）—— 用户定案：5 */
    cap: 5,
    /** 触发半径（像素）：敌人中心进入即引爆 */
    triggerRadius: 45,
    /**
     * 爆炸半径（像素）—— 2026-11 从 **110 → 50**（用户口径：攻击范围才 200，爆炸就 100 多，不合理）。
     *
     * 设计值在 `abilities#28` 的 kv（`50 / 55 / 60` 逐级），这里只是"表里没写时"的兜底。
     * ⚠ 与老口径的两点差异：
     *   · 50 = **1 米**（`battle_constants.pxPerMeter` = 50），读作"只炸到踩上来那一只和紧挨着的一只"；
     *   · 50 < `minGap` 60 ⇒ 一发爆炸**不再能顺带引爆相邻地雷**，连锁完全由「连锁雷」钩子
     *     （`chainRadius` 90）显式决定 —— "要不要连锁"从运气变成了一件遗物。
     */
    blastRadius: 50,
    /** 爆炸伤害（攻击力百分比） */
    damagePct: 180,
    /** 布雷半径系数：`攻击范围 × 该系数` = 布雷圆半径（留边，避免贴脸出圈） */
    placeRadiusMul: 0.85,
    /** 两颗地雷之间的最小间距（像素）：挨太近会被一次连环踩爆，"上限 5"就失去意义 */
    minGap: 60,
    /** 布雷间隔的下限（秒）：遗物叠「急造」也不许快到 0（否则一帧一颗） */
    intervalMin: 1,
    /** 「燃烧雷」地面的持续时间（秒） */
    burnSeconds: 3,
    /** 「连锁雷」的相邻判定半径（像素） */
    chainRadius: 90,
    /** 放不下时最多重掷几次（重掷仍失败**照放**，永不静默停手 —— 见 `BattleMines.place`） */
    placeRetry: 8,
} as const;

/** 地雷是不是"英雄在当前这一刻真的会布雷"：没有任何地雷行时为 false（非骷髅王英雄天然不布雷） */
export const MINE_INACTIVE_HINT = '当前英雄没有地雷技能/遗物 —— 本局不布雷';

/**
 * 表现层常量（`game_stage/entityview/MineLayer.ts` 用）。
 *
 * ⚠ **色值必须来自 `docs/art-style/tokens.json`**（本作是双色制：一支青绿 + 一支墨灰，
 *   浅底图纸风）。这里只用三档灰蓝与两支既有色，**不新增颜色**：
 *   · `mineStroke` / `mineCore` = `c-ink-600` #6A696B（战斗 HUD 图标与正文）
 *   · `armedColor` = `c-range-line` #C0CCD1（**战场范围圈**专用色 —— 虚线在这里的语义正好是
 *     "待触发/预告"，与 tokens 的 `shapes.dashedMeaning` 一致）
 *   · `burnColor` = `c-range-line-2` #8CA8B3（第二层范围圈）
 *   `audit:mine` 会把这三个色对着 tokens.json 核一遍（运行期写的色 `audit:ui` 扫不到）。
 */
export const MINE_LAYER_STYLE = {
    /** 地雷本体圆的半径（像素） */
    mineRadius: 9,
    /** 引信点半径（像素） */
    mineCoreRadius: 2.5,
    /** 本体线宽（像素） */
    mineLineWidth: 1.6,

    // ---- 触发范围（雷达盘）----
    /**
     * 触发半径**虚线圈**的线宽 / 段数。
     *
     * ⚠ 2026-11 起这个圈的半径 = **真实触发半径**（`MineRuntime.triggerRadius`，骷髅王 45px），
     *   不再是过去那个"画在 14px 上的装饰圈"：雷达盘要能回答"敌人走到哪一步会踩响"，
     *   而 14px 的圈与 45px 的判定差了三倍 —— 那是**表现骗人**，不是美术选择。
     */
    triggerLineWidth: 1.2,
    /** 触发虚线圈段数（45px 半径上 24 段刚好读成虚线，与燃烧地面的段数同值） */
    triggerDashCount: 24,
    /**
     * **雷达扫描线**的转速（度/秒）—— 唯一的作用是"让这颗雷看起来在等敌人"，
     * **不参与任何逻辑判定**（触发判定在纯 TS 的 `BattleMines.tick` 里）。
     * 130°/s ≈ 2.8 秒转一圈：比一圈 1 秒的"扫描雷达"慢，因为场上最多同时 5 颗，
     * 快了会变成一片转圈的风扇、抢掉"哪颗雷要炸"的读图注意力。
     */
    sweepDegPerSec: 130,
    /** 扫描线线宽（与触发圈同档，细线不抢本体） */
    sweepLineWidth: 1.2,
    /** 扫描线**尖端的两侧刻度**长度（像素）—— 制图里"箭头"的语法，读作"扫到这里了" */
    sweepTipTickLen: 4,

    /** 燃烧地面的虚线环线宽（比地雷细，避免抢主体） */
    fieldLineWidth: 1.2,
    /** 燃烧地面虚线圈段数 */
    fieldDashCount: 24,

    // ---- 爆炸扩散圈（引爆时画，从原点扩到**真实爆炸半径**）----
    /**
     * 寿命（毫秒）——**与形态层的 `HIT_FEEL_SHAPES[Blast].lifeMs` 同值（260）**。
     *
     * 为什么刻意同值：地雷的爆炸圈现在由雷自己的预制件节点画（见 `MineView`），
     * 而形态层那条**同形状**的环在同一套打击反馈里出现（技能爆炸、击杀爆炸）——
     * 两条路画出来的爆炸必须"同重同快"，否则玩家会读出"地雷的爆炸和技能的爆炸不是一回事"。
     */
    blastLifeMs: 260,
    /** 半径缓动指数（< 1 → **起步快**、末段收）—— 与形态层 `HIT_FEEL_SHAPE.blastGrowPow` 同口径 */
    blastGrowPow: 0.45,
    /** 淡出指数（> 1 → 先实后收，与形态层 `fadePow` 同口径） */
    blastFadePow: 1.7,
    /** 起始不透明度（形态层的 0.85~0.95 那一档：形态是"这一下是什么"的答案，必须一次读出来） */
    blastAlpha: 0.95,
    /** 线宽（= 形态层 Blast 的 2.8px；用户 2026-11 口径「爆炸的圈太浅看不清」→ 靠描边加粗，不靠发光） */
    blastLineWidth: 2.8,
    /** 环上的径向刻度条数 / 长度 / 线宽（制图"尺寸标注"语法，读作"这一圈就是范围"） */
    blastTicks: 8,
    blastTickLen: 6,
    blastTickWidth: 1.9,
    /** 刻度出现的时间比例：环接近到位（35%）之前不画，否则刻度会飘在半径之外、读成"炸歪了" */
    blastTickFrom: 0.35,

    /** 地雷本体/引信色（`c-ink-600`） */
    mineStroke: [106, 105, 107],
    mineCore: [70, 82, 89],
    /** 待触发虚线圈色（`c-range-line`） */
    armedColor: [192, 204, 209],
    /** 燃烧地面色（`c-range-line-2`） */
    burnColor: [140, 168, 179],
    /** 爆炸圈色（= `HitFeelConfig.HIT_FEEL_MARK.ink`，与形态层的爆炸环**同色**，理由见 `blastLifeMs`） */
    blastColor: [20, 24, 27],
} as const;

/**
 * 地雷**预制件路径**（`resources.load` 用，不带扩展名）。
 *
 * ⚠ 2026-11 起每颗雷是**一个预制件节点**（`MineView` + `Graphics`），走对象池；
 *   以前是"整层一个 Graphics、每帧 clear 重画"。路径写在这里而不是散在表现层里：
 *   `MineLayer` 是唯一消费方，而"换一张地雷外观"应该是改这一个常量 + 换一个预制件文件。
 */
export const MINE_PREFAB_PATH = 'prefabs/unit/mines/mine';

/** 表现层节点名（宿主按名字三级取用：预制件里摆好的 → 子树里已有的 → 运行时建一个） */
export const MINE_LAYER_NODE_NAME = 'mine_layer';
