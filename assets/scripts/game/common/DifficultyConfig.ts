/**
 * ============================================================
 * DifficultyConfig —— 难度（关卡）曲线的**唯一数值真源**（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * 「难度 N」= 难度选择弹窗（`Scene_Menu/ui_difficulty`）里的第 N 格，1 ~ `DIFFICULTY_MAX`。
 * 本文件只做**一件事**：把「档位 → 倍率」算出来。它不知道谁在用它，也不碰任何节点/存档。
 *
 * ── 公式来自设计稿（不要在这里创新）──
 *   `docs/prd/阶段模式_局内规则详解.md` §4.6 敌人难度缩放：
 *
 *     敌人 HP      = 基础 × 阶段倍率 × (1.10)^(N-1)      ← HP_BASE
 *     敌人伤害     = 基础 × 阶段倍率 × (1.08)^(N-1)      ← ATK_BASE
 *     Boss HP      = 基础 × (1.12)^(N-1)                 ← BOSS_HP_BASE（关底/最终 Boss 专属）
 *     刷新间隔     = 基础间隔 × (0.97)^(N-1)             ← SPAWN_GAP_BASE
 *     金币/经验收益 = 基础 × (1.06)^(N-1)                ← REWARD_BASE
 *
 *   · 阶段倍率（1.0 / 1.6 / 2.4 / 3.6）**不由本文件负责** —— 它已经在刷怪表与单位配置里了，
 *     本文件给的是**叠在它上面的那一个乘区**（`Scene_Game_Stage` 把两者相乘）。
 *   · 档 1 的倍率恒等于 1：**档 1 = 当前基准平衡**，一个数都不动（这是"老玩家重开一局"的回归点）。
 *
 * ── 两条必须知道的口径 ──
 *   ① **刷新间隔有下限**（`SPAWN_GAP_MIN`）。设计稿的 0.97^(N-1) 是按「难度 1~10」推的：
 *      0.97^99 ≈ 0.049 意味着 20 倍出怪速率 —— 那会同时撞上 `SPAWN_ALIVE_HARD`（同屏 50 的性能保险丝）
 *      与「间隔是呼吸旋钮、不是难度旋钮」这条定论（`docs/局内刷怪节奏设计.md`）：
 *      **后期难度只能靠"每只怪更肉"承担，不能靠"一秒比一秒多"**。所以速率在 `SPAWN_GAP_MIN` 处封顶
 *      （默认 0.75 → 最多 +33% 出怪速率，约在档 20 触顶，见该常量的注释）。
 *   ② **曲线是指数的，且刻意比收益涨得快**（HP > 收益）：差额**必须由局外成长补**
 *      （`docs/数值设计调研报告_肉鸽塔防.md` §4：每难度净需多 ~3~4% 输出）。
 *      **2026-11 起五个底数整体开平方**，所以这条差额的**每档**斜率也减半
 *      （HP/收益 每档比 1.0377 → 1.0187），但**整条阶梯的总差额几乎不变**
 *      （1.0377^49 ≈ 6.2 vs 1.0187^99 ≈ 6.3）—— 也就是"局外要补多少"这件事没有被改掉，
 *      改的只是"把这件事摊到 100 档还是 50 档"。样本值见 `curveTable()`：
 *      档 10 ≈ 怪 HP ×1.53；档 30 ≈ ×3.98；档 100 ≈ ×112。**本作局外成长目前远达不到这条曲线** ——
 *      要调软就改下面五个 BASE（例如全改 1.02 → 档 100 ≈ ×7），不用动任何别的文件。
 *      完整契约（弹窗四态 / 五个落点 / 验收清单）见 `docs/difficulty-select/README.md`；
 *      **定标与全部对账见 `docs/difficulty-curve/README.md`**（含求解器与图表页）。
 *
 * @example
 * ```ts
 * import { enemyHpMul, enemyAtkMul, describeLevel } from '../common/DifficultyConfig';
 *
 * // 局内（Scene_Game_Stage）：把倍率乘到怪物的基础属性上
 * const hpMul = enemyHpMul(level);
 * const atkMul = enemyAtkMul(level);
 *
 * // 日志/调试：一句话说清这一档到底多难
 * console.log(describeLevel(37));
 * // → 关卡 37（第 4 段 · 尖兵）· 怪HP ×30.91 · 怪攻 ×15.97 · BossHP ×59.14 · 收益 ×8.15 · 刷怪间隔 ×0.75
 * ```
 */

/** 难度档位总数（弹窗里 100 个格子；也是 `LevelData` 解锁推进的上限） */
export const DIFFICULTY_MAX = 100;

/** 每段多少档（弹窗按 10 段 × 10 档 组织，见 `docs/difficulty-select/prompts.md` §0） */
export const DIFFICULTY_TIER_SIZE = 10;

/**
 * 十段段名（第 1~10 段）—— 取自设计稿的难度段命名，**只用于日志与文案**。
 *
 * ⚠ 弹窗预制件里**没有**段页签节点（那份设计稿的 10 个段页签还没落地），
 *   所以这组名字目前只出现在 `describe()` 的日志里，不作为界面文案。
 */
export const DIFFICULTY_TIER_NAMES: readonly string[] = [
    '新兵', '老兵', '精锐', '尖兵', '猎手', '督军', '破阵', '铁壁', '屠城', '终焉',
];

/* ===================================================================
 * 曲线底数（**要调难度曲线只改这五行**）
 *
 * ⚠ 2026-11 **整体开平方**（`新底数 = 旧底数^0.5`）—— 语义是
 *   **「难度阶梯压缩一倍：旧第 N 档的强度 = 新第 2N 档」**，所以：
 *   · **第 1 档一个数都没动**（任何底数的 0 次方都是 1）⇒ "档 1 = 基准平衡"这条口径不变；
 *   · 旧的**第 50 档**（最高成长玩家"正正好"的那一档）现在是**第 100 档**；
 *   · 旧的第 51~100 档是**死区**（`1.12^99 ≈ ×7.1 万`，没有任何成长跟得上，
 *     最高成长在旧第 100 档要打 **13454 秒**），压缩后整条阶梯都够得着。
 *
 *   为什么必须**五个一起**压：只压 Boss 血 ⇒ 小怪相对变肉；只压 HP 不压 ATK ⇒
 *   高难度"更肉且更疼"惩罚叠加；只压 HP 不压收益 ⇒ 金币溢出（遗物池抽穿后没有出口）。
 *
 *   定标口径（用户 2026-11）：**最高成长 · 难度 100 · 最终 Boss = 30 秒定标 × 取 75% = 40 秒**。
 *   求解器：`node tools/difficulty-curve/tune.mjs`（扫 k 报落点）；复核：`sim.mjs`。
 *   实测（真表真源码 · 10 英雄 · 每格 4 局）：最高成长在**新第 100 档 ≈ 44 秒**（±10% 落到 40s 目标上）。
 *   口径与全部判据见 `docs/difficulty-curve/README.md`。
 * =================================================================== */

/** 普通怪 HP 底数（设计稿 1.10 → 2026-11 开平方） */
const HP_BASE = 1.0488;
/** 怪物伤害底数（设计稿 1.08 → 开平方；刻意低于 HP —— 秒杀感比"打不动"更劝退） */
const ATK_BASE = 1.0392;
/** 关底/最终 Boss 的 HP 底数（设计稿 1.12 → 开平方；Boss 是门槛，涨得比小怪快） */
const BOSS_HP_BASE = 1.0583;
/** 金币/经验收益底数（设计稿 1.06 → 开平方） */
const REWARD_BASE = 1.0296;
/** 刷怪间隔底数（设计稿 0.97 → 开平方；<1 = 档位越高刷得越快） */
const SPAWN_GAP_BASE = 0.9849;

/**
 * 刷怪间隔倍率的**下限**（= 出怪速率上限）。
 * 见文件头口径 ①：默认 0.75（最多 +33% 速率）。
 * ⚠ 触顶档位随 `SPAWN_GAP_BASE` 走：底数 0.97 时约在**档 10**；2026-11 开平方后约在**档 20**
 *   （`0.9849^(N-1) = 0.75 ⇒ N ≈ 20`）—— 与"阶梯压缩一倍"同一条口径。
 */
export const SPAWN_GAP_MIN = 0.75;

/* ===================================================================
 * 倍率（查表，不每次 pow —— 每只怪出生都要算一次）
 * =================================================================== */

/** 把任意输入收敛成合法的档位（1 ~ DIFFICULTY_MAX；非法值一律当档 1） */
export function clampLevel(level: number): number {
    if (!Number.isFinite(level)) return 1;
    const n = Math.floor(level);
    if (n < 1) return 1;
    return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
}

/** 预生成的倍率表（下标 = 档位 1~100，下标 0 恒为 1 供兜底使用） */
const HP_MUL: number[] = [];
const BOSS_HP_MUL: number[] = [];
const ATK_MUL: number[] = [];
const REWARD_MUL: number[] = [];
const SPAWN_GAP_MUL: number[] = [];
(function buildCurve(): void {
    HP_MUL.push(1);
    BOSS_HP_MUL.push(1);
    ATK_MUL.push(1);
    REWARD_MUL.push(1);
    SPAWN_GAP_MUL.push(1);
    for (let n = 1; n <= DIFFICULTY_MAX; n++) {
        const step = n - 1;   // 档 1 → 指数 0 → 全是 ×1（基准平衡）
        HP_MUL.push(Math.pow(HP_BASE, step));
        BOSS_HP_MUL.push(Math.pow(BOSS_HP_BASE, step));
        ATK_MUL.push(Math.pow(ATK_BASE, step));
        REWARD_MUL.push(Math.pow(REWARD_BASE, step));
        SPAWN_GAP_MUL.push(Math.max(SPAWN_GAP_MIN, Math.pow(SPAWN_GAP_BASE, step)));
    }
})();

/** 普通怪 HP 倍率（档 1 = ×1） */
export function enemyHpMul(level: number): number {
    return HP_MUL[clampLevel(level)] ?? 1;
}

/** 关底/最终 Boss HP 倍率（档 1 = ×1）—— 只给 `UnitKind.StageBoss` / `UnitKind.FinalBoss` 用 */
export function bossHpMul(level: number): number {
    return BOSS_HP_MUL[clampLevel(level)] ?? 1;
}

/** 怪物伤害（攻击力）倍率（档 1 = ×1） */
export function enemyAtkMul(level: number): number {
    return ATK_MUL[clampLevel(level)] ?? 1;
}

/** 金币 / 经验收益倍率（档 1 = ×1）—— 乘在击杀奖励上，与阶段系数、时间通胀**相乘** */
export function rewardMul(level: number): number {
    return REWARD_MUL[clampLevel(level)] ?? 1;
}

/** 刷怪间隔倍率（≤1；档 1 = ×1，越小刷得越快）—— 已按 `SPAWN_GAP_MIN` 封顶 */
export function spawnGapMul(level: number): number {
    return SPAWN_GAP_MUL[clampLevel(level)] ?? 1;
}

/* ===================================================================
 * 文案 / 分段
 * =================================================================== */

/** 档位属于第几段（0 起：0 = 1~10 档 / 9 = 91~100 档） */
export function tierIndex(level: number): number {
    return Math.floor((clampLevel(level) - 1) / DIFFICULTY_TIER_SIZE);
}

/** 档位所属段名（新兵 / 老兵 / … / 终焉） */
export function tierName(level: number): string {
    return DIFFICULTY_TIER_NAMES[tierIndex(level)] ?? DIFFICULTY_TIER_NAMES[0];
}

/**
 * 档位标签（弹窗详情条与主界面统一用它，改文案只改这里）。
 * 两位数补零：档 9 → `关卡 09`（与设计稿的详情条一致；100 档本身是三位，不补零）。
 */
export function levelLabel(level: number): string {
    const n = clampLevel(level);
    return `关卡 ${n < 10 ? '0' + n : '' + n}`;
}

/** 一句话描述某档的强度（开局日志用；也是策划看曲线的最短路径） */
export function describeLevel(level: number): string {
    const n = clampLevel(level);
    const seg = tierIndex(n) + 1;
    return `${levelLabel(n)}（第 ${seg} 段 · ${tierName(n)}）`
        + ` · 怪HP ×${fmt(enemyHpMul(n))} · 怪攻 ×${fmt(enemyAtkMul(n))}`
        + ` · BossHP ×${fmt(bossHpMul(n))} · 收益 ×${fmt(rewardMul(n))}`
        + ` · 刷怪间隔 ×${fmt(spawnGapMul(n))}`;
}

function fmt(v: number): string {
    if (v >= 1000) return v.toFixed(0);
    if (v >= 100) return v.toFixed(1);
    return v.toFixed(2);
}

/**
 * 曲线速查表（每 `step` 档一行）—— 排查"某个档到底多难"时用，也可以直接拖进策划文档。
 * 纯函数、无副作用，运行期不要每帧调（它现算 100 档的字符串）。
 */
export function curveTable(step = 10): string[] {
    const rows: string[] = [];
    const s = Math.max(1, Math.floor(step));
    for (let n = 1; n <= DIFFICULTY_MAX; n += s) {
        rows.push(describeLevel(n));
    }
    if ((DIFFICULTY_MAX - 1) % s !== 0) rows.push(describeLevel(DIFFICULTY_MAX));
    return rows;
}
