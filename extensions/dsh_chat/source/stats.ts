/**
 * 会话用量：把 DSH 的**会话投影缓存**读成面板能画的那几个数字。
 *
 * ## 数据从哪来
 *
 * ```
 * <DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json
 * ```
 *
 * 这是 `dsh-session-projection-cache` 写下的**投影检查点**：一个会话一个 JSON 文档，
 * 里面 `record.rows.<投影键> = {ver, seq, val}`。本 profile 里挂着的几个单元正好
 * 凑齐面板要的全部数字：
 *
 * | 行 | 谁注册的 | 给了什么 |
 * |---|---|---|
 * | `contextPressure` | `dsh-token-meter` | 窗口上限、上一次请求的 prompt 侧实测、**下一次请求的预估** |
 * | `contextBreakdown` | 同上 | 上下文**组成**（系统提示 / 工具表 / 对话）—— **估算**，见口径 3 |
 * | `tokenUsage` | 同上 | 本会话累计 input / output / cacheRead / cacheWrite |
 * | `sessionStats` | `dsh-session-stats` | 回合数 / 步数 / 模型耗时 / 工具耗时 / 首字 / 解码 |
 * | `costUsage` | `dsh-cost-meter`（**第三方** bundle；⚠ 本 profile **刻意不挂**它，见口径 4） | 花费（**美元**入账；显示成什么币种来自账本，见口径 4） |
 * | `contextTimeline` | `dsh-context`（**第三方** bundle；⚠ 与花费同一个处境：**本 profile 不挂它**，见口径 6） | 上下文随每次模型调用怎么长大：每次调用的 prompt 侧用量、压缩 / 裁剪点、`archiveFloor` |
 * | `todos` | `dsh-tool-todo` | agent 自己写的工作表（`todo_write` 的整份快照） |
 * | `goal` | `dsh-goal` | 目标模式：目标 / 阶段 / 已跑几轮 |
 * | `turnOutline` | `dsh-session-turn-outline` | **整个日志**每一轮的输入与回复摘要（面板转写只留最近 600 条，见口径 5） |
 *
 * ⚠ **`val` 是投影的「状态」，不是客户端的「wire view」。** 两者常常同形，但**不同形的地方
 * 正是会踩坑的地方**：`contextPressure` 的状态里**没有** `projectedTokens`（那是 wire view
 * 现算的），所以占用率只能自己按上游公式算（见口径 2）；`turnOutline` 的状态是
 * `{turns, draft}`，而 wire view 是 `turns` 那个数组本身 —— 当成数组读会**一个字段都读不到**，
 * 而且是静默的（`undefined` 而不是报错）。`scripts/verify-stats.js` 里有一条断言把这份缓存
 * 与 `dsh-session-projection-cache` 的写入路径钉在一起。
 *
 * ## 为什么读盘，而不是问 agent
 *
 * 三条，缺一条这个功能都不成立：
 * 1. SDK 协议里**没有**投影读取 —— 它就 `initialize` / `session/prompt` / `shutdown` 三个方法；
 * 2. `ctx.tokenMeter.measure()` 只有**宿主进程内的插件**拿得到，而面板与 agent 是两个进程；
 * 3. 缓存是**明文 JSON**，所以主进程自己 `readFile` 就够了 —— **不需要 zstd、也不需要
 *    外面那个 node**（对比：会话日志是 zstd 拼接帧，只能 spawn 一个 Node ≥ 22.15 去解）。
 *
 * 顺带的好处：**agent 没在跑也能看**，和「历史会话」一个待遇。
 *
 * ## 六条诚实口径（面板上必须说出来，不许只画数字）
 *
 * 1. **这是检查点，不是实时的。** 重写时机是「会话创建 / `turn/end` / 会话销毁」这三个
 *    必写点，加上两个节流（本 profile 配的是**每 200 条事件或每 5 秒**）。所以 `seq`
 *    只是**水位**：读到的是「至少记到第 `seq` 条事件为止」的账。面板把水位与「落后多少条」
 *    一起显示出来（`behind`），因为「差几十条」和「差一万条」是完全不同的两件事。
 * 2. **占用率用 `projectedTokens`（下一次请求的预估），不用 `pressureTokens`（上一次的实测）。**
 *    `pressureTokens` 是 prompt 侧的**上一次**实测，它在流式期间不动；而压缩（`/compact`）
 *    之后上一次的实测会**偏高**。上游因此额外维护了一个 surface 总数，并发布
 *    `projectedTokens = 样本 + surface 的带符号位移`。公式**照抄**上游 wire view
 *    （`dsh-token-meter/lib/types/usage-projection.js`）：
 *    `max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`。
 *    `scripts/verify-stats.js` 里有一条断言**直接盯着上游那段源码** —— 哪天它改了公式，
 *    这里会红，而不是悄悄算错。
 * 3. **`contextBreakdown` 是估算，而且它不等于占用率那一条。** 上游 README 明说它按
 *    「四字符一个 token」定价，中文与 JSON schema 会明显低估，三行加起来**对不上**
 *    `projectedTokens`。所以面板上它单独一块、标「估算」、**不参与**那条占用条。
 * 4. **花费要读两个文件，而且金额的单位不是面板说了算。**
 *    金额来自投影缓存那一行（`costUsage.totals.cost`），它**恒以美元入账**
 *    （上游 `usdFromCost` 的注释：「账本恒以美元存储」）；显示成 `¥` 还是 `$`、按什么汇率折、
 *    留几位小数 —— 全在 `dsh-cost-meter` 的**账本**
 *    （`<DSH_HOME>/storages/cost-meter/ledger.json` 的 `config`）里。
 *    所以这一份读盘会**顺手读第二个文件**（读不到不影响用量那半，只是按美元原值画并说出来）。
 *    两边都有金额时以**投影缓存**为准（与抽屉里其它行同一个来路），账本那一份只用来
 *    **对账**（差得明显就照实说，见 `costLedgerNote`）与**兜底**（老会话的检查点里没有这一行）。
 *    最后一条：`cost` 为 null 的意思是**这一行不存在**（老会话 / 别的 profile / 还没写过检查点），
 *    **不是**「没花钱」—— 所以面板上绝不画 `$0.0000`。
 *
 *    ⚠ **本 profile 现在不挂 `dsh-cost-meter`**（2026-12 的决定：零第三方 bundle ——
 *    `bundles` 里声明了却没装会让**整棵树起不来**，代价远大于"少一块功能"）。
 *    所以这一行在**新会话**上基本不会出现；但读取器照旧全功能：谁装了它、或者挂着它跑过的
 *    老会话（检查点里已经有这一行），面板就照旧画，**一处都不用改**。
 *    缺了它时面板说的是「本 profile 刻意没挂 + 想用怎么加回来」（措辞在 `cost.ts`）。
 * 5. **进度那三块，缓存给的和事件给的不是一回事**（清单 / 目标 / 回合大纲）。
 *    这一份读的是**整个日志**折出来的，所以它有面板转写里**根本没有**的东西
 *    （面板只留最近 600 条条目、历史回放只读日志尾部 2000 条事件 → 更早的轮次在面板上
 *    连影子都没有，而 `turnOutline` 里 30 轮一条不少）。代价就是它**旧**：缓存攒够 200 条
 *    事件或 5 秒才写一次，所以清单可能比面板上真实发生的事慢几秒。
 *    分工写在 `constants.ts` 的进度那一段：**事件优先、缓存补洞**（合并由宿主做）。
 *    这一份还负责一件事：**`todos` 的投影口径是「每一次 `turn/start` 归零」**
 *    （见 `dsh-tool-todo` 的 `apply`），所以读到的 `null` 有两种意思 ——
 *    「本轮还没写过」和「从来没写过」。宿主拿实时事件里的轮次号分辨这两者，
 *    面板上必须说清楚（把上一轮的表当成这一轮在做的事，就是看板在撒谎）。
 * 6. **上下文增长曲线：主曲线用「实测」，但实测与估算差着一大截，而且这一行不是我们挂的。**
 *    三件事要一起说：
 *    ① **`requests[].prompt` 是 provider 实测**（input + cacheRead + cacheWrite），而
 *    `requests[].{system,tools,user,inject,assistant,tool,total}` 是**估算**（上游按
 *    「四字符一个 token」定价）。本机真数据（470 份缓存 / 40427 条请求）里 `prompt / total`
 *    的 min 0.88、**中位 1.34**、p95 1.63、max 2.69 —— 所以**只画 `total` 会让人以为上下文
 *    占用远低于真实**（最坏低估到 1/2.7）。主曲线取 `prompt`，缺了才回落到 `total`，
 *    并且把回落的那几根**标成估算**（面板画斜纹）。
 *    ② **注册者是第三方 `dsh-context`，本 profile 不挂它**（`dsh-profile/package.json` 里零
 *    第三方 bundle）—— 所以「没有这一行」是**常态路径**，不是读失败；措辞与花费那一行同一套。
 *    `ver` 只认 **13**：不匹配就**丢掉整行**（框架口径是从日志冷折叠、**从不迁移**），
 *    面板如实写「这一行的版本是 N，本读取器只认 13」；唯一的例外是 `ver === 1` + `val` 是空对象，
 *    那是那个插件在**宿主低于它的基线**时注册的降级占位。
 *    ③ **压缩点要合并、聚合不许取平均**：`events[]` 里 `kind` 是 `compaction` / `prune` 的，
 *    按上游 wire view 的规则钉到**它之后的第一条 request** 上；而 `prune` 会**连发**
 *    （本机真数据里有一条会话 52ms 内连发 7 条小 prune、3.0 秒后才是一条大 compaction）——
 *    不合并的话同一根柱上会糊成一片。规模上 `requests` 中位 37 条、p95 322、**max 1500**
 *    （撞宿主的 `maxRequestSteps`），超过阈值按**回合**聚合、取该回合**最后一步**，
 *    **绝不取平均值**（平均会把压缩掉的那一截抹平，而那正是这张图存在的理由）。
 */

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import type {
    ContextTimelineView,
    CostDisplay,
    CostLedgerView,
    GoalView,
    SessionProgress,
    SessionUsage,
    TimelineCutView,
    TimelinePointView,
    TodoStatus,
    TodoView,
    TurnView,
    UsageBuckets,
} from './constants';
import {
    CONTEXT_TIMELINE_FALLBACK_VERSION,
    CONTEXT_TIMELINE_MAX_BARS,
    CONTEXT_TIMELINE_STATE_VERSION,
    contextTimelineBaselineNote,
    contextTimelineEmptyNote,
    contextTimelineVersionNote,
} from './constants';

/**
 * ⚠ **类型声明在 `constants.ts`**（那是全扩展共享的那一份），这里只做转出。
 *
 * 为什么不在这里声明：面板要画的就是这几个字段，两边各写一份必然漂移
 * （面板少认一个字段 = 那一行永远不显示，而且没人会发现）。
 * `import type` 编译后会被完全擦掉，所以面板那边不会因为这条 import 而拖进 `fs`。
 */
export type {
    ContextTimelineView,
    CostDisplay,
    CostLedgerView,
    GoalView,
    SessionProgress,
    SessionUsage,
    TimelineCutView,
    TimelinePointView,
    TodoStatus,
    TodoView,
    TurnView,
    UsageBuckets,
};

/** 认得的**文档**格式版本（`record.version`）；认不出也照读，只是会加一条 notes。 */
const KNOWN_RECORD_VERSIONS = new Set([5]);

/**
 * 会话 id 的安全白名单。
 *
 * id 会拼进文件路径，所以只放行 `[A-Za-z0-9._-]`，并且显式拒掉 `.` / `..`
 * （口径与 `scripts/session-log.js` 的 `safeNameOf` 一致 —— 两处都挡，谁被改坏了都还有一层）。
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 读一份用量的结果（失败不抛，让面板能显示原因）。 */
export interface SessionUsageResult {
    ok: boolean;
    usage?: SessionUsage;
    error?: string;
}

/**
 * 一次读盘的结果：**同一份文件**里的用量与进度。
 *
 * 为什么把两者放在一次读里：它们在同一份 JSON 里（一个会话一个文件，大的能到 400+ KB），
 * 分两次读就是把同一份文件解析两遍；而且两块的「水位 / 落后多少 / 写于何时」本来就是
 * 同一组事实，分开读会出现「用量说落后 12 条、进度说落后 3 条」这种自相矛盾的画面。
 */
export interface SessionCacheResult {
    ok: boolean;
    usage?: SessionUsage;
    progress?: SessionProgress;
    error?: string;
}

/** 读进度那一份的结果（`notes` 是读的时候发现的口径问题，面板原样显示）。 */
export interface SessionProgressResult {
    progress: SessionProgress;
    notes: string[];
}

/** 面板上一次画多少轮（再多也没人往下翻，而每条都带两段文本）。 */
const MAX_OUTLINE_TURNS = 80;

/**
 * 单条文本的显示上限（超了截断并**显式加省略号** —— 硬切一刀不提就是骗人）。
 *
 * ⚠ 这三个数**在本机真数据上永远不会触发**：上游自己已经裁过一轮
 * （回合大纲的 prompt ≤ 50 字符、response ≤ 120 字符，见 `dsh-session-turn-outline`
 * 的 `PROMPT_PREVIEW_LIMIT` / `RESPONSE_PREVIEW_LIMIT`），清单条目实测最长 152 字符。
 * 它们是**守卫**：哪天上游把上限放开、或者清单条目变成一整段，面板不会被一个
 * 十万字符的条目撑爆（而截断这件事本身是看得见的省略号）。
 */
const TODO_TEXT_LIMIT = 300;
const PROMPT_TEXT_LIMIT = 200;
const RESPONSE_TEXT_LIMIT = 400;

/** 清单状态的白名单（逐字对应 DSH 的 `TodoItem.status`）。 */
const TODO_STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);

/** 目标阶段的白名单（逐字对应 DSH 的 `GoalPhase`）。 */
const GOAL_PHASES = new Set<string>(['active', 'paused', 'blocked', 'complete']);

/**
 * `<DSH_HOME>`（`DSH_HOME` 没设就按 `~/.dsh`）。
 *
 * ⚠ 口径必须与 `history.ts` 的 `sessionsRoot()` 一致 —— 那边也是这么算的。
 * 两处都拼同一个字符串，`scripts/verify-stats.js` 有一条断言把两者钉在一起。
 */
export function dshHome(): string {
    const home = process.env.DSH_HOME?.trim();
    return home && home !== '' ? home : join(homedir(), '.dsh');
}

/** 投影缓存的会话记录目录：`<DSH_HOME>/storages/session_projcache/sessions`。 */
export function projectionRoot(): string {
    return join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

/** 一条会话的缓存记录路径。 */
export function usageRecordPath(sessionId: string): string {
    return join(projectionRoot(), `${sessionId}.json`);
}

// ---------------------------------------------------------------- 取值小工具
//
// 缓存里的数字来自**别的进程**，形状随上游版本变。所以这里一律「认得出就用、
// 认不出就当没有」，绝不 `as number` 硬转 —— 一个 NaN 画到面板上就是一条骗人的进度条。

/** 非负有限数才认（`undefined` / `null` / `NaN` / 负数 / 字符串一律 null）。 */
function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 正整数才认（窗口上限这类）。 */
function positive(value: unknown): number | null {
    const value2 = num(value);
    return value2 !== null && value2 > 0 ? value2 : null;
}

/** 字符串才认（trim 后非空）。 */
function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 纯对象才认（数组、null、标量一律不算）—— 读别家的 JSON 时到处都要这一句。 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 `record.rows` 里取一行的 `val`（**原样**，数组也照给）。
 *
 * ⚠ 与 `rowValue` 的区别很重要：`todos` 那一行的状态**本身就是数组**，
 * 用只认对象的 `rowValue` 读它，读到的永远是 `null` —— 而且不报错，
 * 表现为「这个会话从来没有清单」（其实是有的）。这一对函数就是为这件事分家的。
 */
function rowVal(rows: Record<string, unknown>, key: string): unknown {
    const row = rows[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    return (row as { val?: unknown }).val;
}

/** 从 `record.rows` 里取一行的 `val`，**只认对象**（用量那几行都是对象）。 */
function rowValue(rows: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = rowVal(rows, key);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/** 取 `record.rows` 里出现过的**最大** `seq`（= 这份记录的水位）。 */
function watermarkOf(rows: Record<string, unknown>): number | null {
    let best: number | null = null;
    for (const row of Object.values(rows)) {
        if (!row || typeof row !== 'object') continue;
        const seq = num((row as { seq?: unknown }).seq);
        if (seq === null) continue;
        best = best === null ? seq : Math.max(best, seq);
    }
    return best;
}

/** 四个桶；四个都不是数就当没有。 */
function bucketsOf(value: unknown): UsageBuckets | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const input = num(raw.input) ?? num(raw.uncachedInputTokens);
    const output = num(raw.output) ?? num(raw.outputTokens);
    const cacheRead = num(raw.cacheRead) ?? num(raw.cacheReadTokens);
    const cacheWrite = num(raw.cacheWrite) ?? num(raw.cacheWriteTokens);
    if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
    return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
}

// ---------------------------------------------------------------- 归一化

/**
 * 从整份文档里取出 `record.rows`（**用量与进度共用的第一道门**）。
 *
 * 三种「形状不对」各自有各自的话 —— 面板上这三句话完全不同：文件坏了、DSH 换了格式、
 * 或者这份记录本来就是空的。
 */
export function rowsOf(raw: unknown): { rows: Record<string, unknown> } | { error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: '投影缓存的记录不是一个对象' };
    }
    const record = (raw as Record<string, unknown>).record;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { error: '投影缓存的记录里没有 record 字段' };
    }
    const rowsRaw = (record as { rows?: unknown }).rows;
    if (!rowsRaw || typeof rowsRaw !== 'object' || Array.isArray(rowsRaw)) {
        return { error: '投影缓存的记录里没有 record.rows（DSH 的缓存格式变了？）' };
    }
    return { rows: rowsRaw as Record<string, unknown> };
}

/** 截断并显式加省略号（不这么干就是在无声地改内容）。 */
function cut(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** `str()` 的数组版本：把一项里的字符串字段取出来，认不出就 null。 */
function field(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
}

/**
 * `todos` 行 → 面板的清单。
 *
 * `null` / `[]` / 有内容**是三件事**：`null` 是「这份记录里没有清单」，`[]` 是
 * 「agent 明确写了一份空表」（`todo_write` 允许空数组吗？工具 schema 要求
 * `required: true` 的数组，空数组是合法的），有内容就是有内容 —— 面板上第 1 与第 3 种
 * 的写法完全不同，所以这里一个都不许合并。
 */
export function parseTodos(value: unknown, notes: string[]): TodoView[] | null {
    if (!Array.isArray(value)) return null;
    if (value.length === 0) return [];
    const todos: TodoView[] = [];
    let dropped = 0;
    for (const item of value) {
        const content = str(field(item, 'content'));
        const status = String(field(item, 'status') ?? '');
        if (!content || !TODO_STATUSES.has(status)) {
            dropped++;
            continue;
        }
        todos.push({ content: cut(content, TODO_TEXT_LIMIT), status: status as TodoStatus });
    }
    if (dropped > 0) {
        // 宁少不假：认不出的条目丢掉，但**说出来**（不说的话面板上就是「清单短了几条」）
        notes.push(
            `这份清单里有 ${dropped} 条读不出来（DSH 的清单条目形状变了？）—— 面板上只列了认得的那 ${todos.length} 条。`,
        );
    }
    return todos;
}

/**
 * 一份目标快照（`GoalSnapshot` + 投影额外带的轮次与时间）→ 面板的目标。
 *
 * 三个调用方形状不同但内容同源，所以读取只写一份：
 * - 缓存里的 `goal` 行：`{current: {goal, roundsStarted, updatedAt}, ...}`
 * - `goal/change` 事件：`{operation, goal, roundsStarted, updatedAt, ...}`
 * 差别只是「快照挂在哪个字段上」、「轮次写在哪一层」，由调用方取好再传进来。
 */
function goalFrom(args: {
    snapshot: unknown;
    roundsStarted: unknown;
    updatedAt: unknown;
}): GoalView | null {
    const objective = str(field(args.snapshot, 'objective'));
    const phase = String(field(args.snapshot, 'phase') ?? '');
    if (!objective || !GOAL_PHASES.has(phase)) return null;
    const blocked = field(args.snapshot, 'blockedReason');
    return {
        objective: cut(objective, PROMPT_TEXT_LIMIT * 2),
        phase: phase as GoalView['phase'],
        roundsStarted: num(args.roundsStarted) ?? 0,
        maxGoalRounds: num(field(args.snapshot, 'maxGoalRounds')) ?? 0,
        blockedReason: str(field(blocked, 'message')) ?? str(field(blocked, 'code')),
        updatedAt: num(args.updatedAt) ?? 0,
    };
}

/**
 * 缓存里 `goal` 那一行（**投影状态**）→ 面板的目标。
 *
 * ⚠ 这一行的形状是 `{current, seenGoalIds, failure}`，真正的内容在 `current.goal` 里
 * （`current` 是投影的当前值，`goal` 才是快照）。`current` 为 null = 没有目标
 * （本机 490 份记录里绝大多数都是这样）。
 */
export function parseGoalProjection(value: unknown, notes: string[]): GoalView | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const current = field(value, 'current');
    const goal = goalFrom({
        snapshot: field(current, 'goal'),
        roundsStarted: field(current, 'roundsStarted'),
        updatedAt: field(current, 'updatedAt'),
    });
    if (!goal && current) {
        // 有 `current` 却读不出目标 = 形状变了，要说出来（静默当成「没有目标」会让用户
        // 以为这个会话本来就没有目标）
        notes.push('这条会话有一个目标，但它的形状面板认不出来（DSH 的 goal 记录变了？）。');
    }
    // 失败记录（`failure`）与目标本身是两件事：失败不等于没有目标，所以分开说。
    // ⚠ 上游这一栏是**字符串**（`z.string().min(1).nullable()`，内容是
    // `goal replay failed at session event <seq>: <message>`），不是对象 —— 先按字符串读，
    // 读不出来再试对象（防它哪天改成结构化）。
    const failure = field(value, 'failure');
    if (failure) {
        const reason =
            str(failure) ?? str(field(failure, 'message')) ?? str(field(failure, 'reason')) ?? str(field(failure, 'code'));
        notes.push(`这个目标有一条失败记录${reason ? `：${cut(reason, 200)}` : '（形状不认识，只能确认它存在）'}。`);
    }
    return goal;
}

/**
 * `goal/change` **事件**的载荷 → 面板的目标。
 *
 * ⚠ 两个形状差异都要处理，这是本文件里最容易读错的一处：
 * 1. 事件带的是**变更元数据**（`{operation, goal, roundsStarted, createdAt, updatedAt}`），
 *    不是缓存里那种投影状态（没有 `current` 这一层，快照直接在 `goal` 上）；
 * 2. `operation === 'clear'` 是一条**墓碑** —— 载荷里**没有** `goal`，它的意思是
 *    「目标被清掉了」，所以返回 null 是**正确结果**，不是读失败。
 */
export function parseGoalChange(data: unknown, notes: string[]): GoalView | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const operation = String(field(data, 'operation') ?? '');
    if (operation === 'clear') return null;
    const goal = goalFrom({
        snapshot: field(data, 'goal'),
        roundsStarted: field(data, 'roundsStarted'),
        updatedAt: field(data, 'updatedAt'),
    });
    if (!goal) {
        notes.push(
            operation
                ? `目标变更（${cut(operation, 40)}）的事件载荷面板认不出来（DSH 的 goal 事件变了？）。`
                : '目标变更的事件载荷面板认不出来（DSH 的 goal 事件变了？）。',
        );
    }
    return goal;
}

/**
 * `turnOutline` 行 → 回合大纲。
 *
 * ⚠ 状态是 `{turns, draft}`（**不是**那个数组本身 —— 那是客户端 wire view，
 * 照 wire view 读会一条都读不到）。`draft` 是「正在写的那一轮」的回复草稿。
 */
export function parseTurnOutline(value: unknown, notes: string[]): { turns: TurnView[]; turnsTotal: number; draft: string } {
    const empty = { turns: [], turnsTotal: 0, draft: '' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
    const list = field(value, 'turns');
    const draft = str(field(value, 'draft')) ?? '';
    if (!Array.isArray(list)) return { ...empty, draft };
    const all: TurnView[] = [];
    let dropped = 0;
    for (const item of list) {
        const turn = positive(field(item, 'turn'));
        if (turn === null) {
            dropped++;
            continue;
        }
        all.push({
            turn,
            prompt: cut(str(field(item, 'prompt')) ?? '', PROMPT_TEXT_LIMIT),
            response: cut(str(field(item, 'response')) ?? '', RESPONSE_TEXT_LIMIT),
            entrySeq: null,
            seq: num(field(item, 'seq')),
        });
    }
    if (dropped > 0) notes.push(`回合大纲里有 ${dropped} 条读不出来（DSH 的大纲条目形状变了？）。`);
    // 上游保证严格升序，这里还是排一遍：面板的「第 N 轮」标题依赖顺序，乱了比缺了更难看
    all.sort((a, b) => a.turn - b.turn);
    if (all.length <= MAX_OUTLINE_TURNS) return { turns: all, turnsTotal: all.length, draft };
    notes.push(`回合大纲一共 ${all.length} 轮，面板上只列最近 ${MAX_OUTLINE_TURNS} 轮（每条都带两段摘要，全发太重）。`);
    return { turns: all.slice(-MAX_OUTLINE_TURNS), turnsTotal: all.length, draft };
}

/**
 * `contextTimeline` 那一行读出来的两样东西。
 *
 * 为什么不是「只返回视图」：这一行**没画出来**的四种来路（版本不认识 / 宿主低于基线 /
 * 还没有请求记录 / 形状读不出来）与「画出来了」是同一件事的两个结果，而第一种情况下
 * 视图必然是 null —— 原因只能从第二个字段带出去（面板要用**原文**说出是哪一种）。
 */
export interface ContextTimelineParseResult {
    /** 归一化 + 聚合好的曲线；读不出来就是 null。 */
    timeline: ContextTimelineView | null;
    /**
     * 这一行为什么没画出来 / 读的时候有什么口径问题。
     * ⚠ 它是 `SessionUsage.timelineNote` 的唯一来源，**不进 `usage.notes`**（见那里的注释）。
     */
    note: string | null;
}

/** `parseContextTimeline` 内部的中间态：一个请求归一化之后的样子（聚合前）。 */
interface RawTimelinePoint {
    seq: number | null;
    time: number | null;
    turn: number | null;
    step: number | null;
    tokens: number;
    prompt: number | null;
    total: number | null;
    estimated: boolean;
    /** 记录自己带的 `stepCount`（上游 schema 里有，但本机真数据里**一条都没有**，见下面的注释）。 */
    stepCount: number | null;
}

/**
 * 空的**投影状态**才算降级占位（`ver: 1` + `val: {}`）。
 *
 * 为什么判「空对象」而不是只判版本号：`ver 1` 是那个插件降级 unit 的版本，而它的状态
 * 永远是不带任何键的 `{}`（`init: () => ({})`、`apply` 是恒等）—— 所以两者同时成立
 * 才是「宿主太老」，单独一个 `ver: 1` 不足以这么说。
 */
function isEmptyState(value: unknown): boolean {
    return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * `contextTimeline` 那一行 → 面板能画的一条曲线。**纯函数**（不碰盘、不打日志），所以能直接测。
 *
 * 干四件事，缺一件这张图就是错的：
 * 1. **形状识别**：只认 `ver === 13`（上游 `dsh-context` 的 `stateVersion`）。认不出的形状
 *    一律返回 null 而不是猜 —— 猜出来的形状画在面板上，比没有这块更糟（它看起来是对的）；
 * 2. **归一化**：柱高**优先取 provider 实测的 `prompt`**，缺了才回落到估算的 `total`
 *    并把这一根标成 `estimated`（真机里 `prompt / total` 的中位是 1.34 —— 只画 total
 *    会让人以为占用远低于真实，见文件头口径 6）；
 * 3. **聚合**：超过 `CONTEXT_TIMELINE_MAX_BARS` 根就按**回合**聚合，取该回合的**最后一步**
 *    （不是平均值 —— 平均会把压缩掉的那一截抹平，而那正是这张图要看的东西）；
 * 4. **挂压缩点**：`events[]` 里的 `compaction` / `prune` 钉到**它之后的第一条 request** 上
 *    （规则逐字照抄上游 wire view 的 `buildTimelineView`：`while (requests[ri].seq <= ev.seq) ri++`），
 *    并且把「钉在同一根柱上 + 时间相近」的连发事件**合并成一个标记**（实测有 52ms 内
 *    连发 7 条 prune 的）。
 *
 * ⚠ 一个 0 都不许补：认不出的请求**丢掉并计数**（`dropped`），窗口上限缺失就不给百分比。
 *
 * @param row - `record.rows.contextTimeline`（整行 `{ver, seq, val}`）；这一行不存在时传 undefined。
 * @returns `{timeline, note}`；`timeline === null` 时 `note` 说得出是哪一种「没有」。
 */
export function parseContextTimeline(row: unknown): ContextTimelineParseResult {
    /**
     * 这一行**根本不存在** → 既没有曲线也没有话要说：那是**常态**（注册者是第三方
     * `dsh-context`，本 profile 不挂它），措辞由面板给（`timelineTextOf` 那两句）。
     * 在这里编一句话的话，面板就分不出「没有这一行」与「这一行读不出来」了。
     */
    if (row === undefined || row === null) return { timeline: null, note: null };
    if (!isRecord(row)) {
        return { timeline: null, note: `上下文增长那一行不是一个 {ver, seq, val} 对象（缓存格式变了？）—— 所以不画。` };
    }

    const ver = num(row.ver);
    const val = row.val;
    if (ver === null) {
        return { timeline: null, note: '上下文增长那一行没有版本号，按当前口径不敢硬读，所以不画。' };
    }
    if (ver === CONTEXT_TIMELINE_FALLBACK_VERSION && isEmptyState(val)) {
        return { timeline: null, note: contextTimelineBaselineNote(ver) };
    }
    if (ver !== CONTEXT_TIMELINE_STATE_VERSION) {
        return { timeline: null, note: contextTimelineVersionNote(ver) };
    }
    if (!isRecord(val)) {
        return { timeline: null, note: '上下文增长这一行的状态不是一个对象（形状面板认不出来，所以不画）。' };
    }

    const rawRequests = val.requests;
    if (!Array.isArray(rawRequests)) {
        return { timeline: null, note: '上下文增长这一行里没有 requests 数组（形状面板认不出来，所以不画）。' };
    }
    if (rawRequests.length === 0) {
        return { timeline: null, note: contextTimelineEmptyNote() };
    }

    // ---- ① 归一化：每个请求一个点（柱高优先取实测的 prompt）----
    const raw: RawTimelinePoint[] = [];
    let dropped = 0;
    for (const item of rawRequests) {
        const prompt = num(field(item, 'prompt'));
        const total = num(field(item, 'total'));
        const tokens = prompt ?? total;
        /**
         * `prompt` 与 `total` 都读不出来（字符串 / NaN / 负数 / 整个字段没了）→ **丢掉**。
         * 为什么丢掉而不是补 0：补 0 会画出一根「这里很省」的柱子 —— 那是编出来的形状，
         * 而真实情况只是「这一条读不出来」。丢几条就在面板上说几条（`dropped`）。
         */
        if (tokens === null) {
            dropped += 1;
            continue;
        }
        raw.push({
            seq: num(field(item, 'seq')),
            time: num(field(item, 'time')),
            turn: num(field(item, 'turn')),
            step: num(field(item, 'step')),
            tokens,
            prompt,
            total,
            estimated: prompt === null,
            stepCount: positive(field(item, 'stepCount')),
        });
    }
    if (raw.length === 0) {
        // 有 requests 但一条都读不出来 = 形状变了（要区别于「还没有请求记录」）
        return {
            timeline: null,
            note: `这一行有 ${rawRequests.length} 条请求记录，但一条都读不出柱高（prompt 与 total 都不在 / 不是数）—— 形状变了，所以不画。`,
        };
    }

    // ---- ② 聚合：超过阈值按回合，取该回合最后一步（**不取平均**）----
    const groups: { last: number; count: number; turn: number | null; stepCount: number | null }[] = [];
    let carriedTurn: number | null = null;
    for (let index = 0; index < raw.length; index += 1) {
        const point = raw[index];
        /**
         * 轮次号缺失时**并进上一轮**（第一个就缺则归入 `null` 那一组）——
         * 为什么不自己编一个轮次：面板上「第 N 轮」是给人对账用的，编出来的号
         * 会让人去找一个并不存在的轮次。
         */
        if (point.turn !== null) carriedTurn = point.turn;
        const turn = point.turn ?? carriedTurn;
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.turn === turn) {
            lastGroup.last = index;
            lastGroup.count += 1;
            if (point.stepCount !== null) lastGroup.stepCount = Math.max(lastGroup.stepCount ?? 0, point.stepCount);
            continue;
        }
        groups.push({ last: index, count: 1, turn, stepCount: point.stepCount });
    }
    const aggregated = raw.length > CONTEXT_TIMELINE_MAX_BARS;

    /** 聚合前的下标 → 要画的柱的下标（压缩点靠它钉上来）。 */
    const barOfRaw: number[] = new Array(raw.length).fill(0);
    const points: TimelinePointView[] = [];
    if (aggregated) {
        /**
         * ⚠ 映射必须**一段一段地填**（`cursor` 往右推）：每一组都把「到本组最后一根请求为止」
         * 的下标全填成本组的柱号的话，后一组的填充会**覆盖**前面几组 —— 压缩点就会全被钉到
         * 最后一根柱上（这个 bug 在 `verify-stats` 的「压缩点跟着聚合并到同一根柱上」那条断言上
         * 现过一次：400 根柱聚合成 8 根，标记却画在最右边那一根）。
         */
        let cursor = 0;
        for (const group of groups) {
            points.push(pointOf(raw[group.last], points.length + 1, group.count, group.stepCount));
            for (let index = cursor; index <= group.last; index += 1) barOfRaw[index] = points.length - 1;
            cursor = group.last + 1;
        }
    } else {
        for (let index = 0; index < raw.length; index += 1) {
            points.push(pointOf(raw[index], index + 1, 1, raw[index].stepCount));
            barOfRaw[index] = index;
        }
    }

    // ---- ③ 压缩点：钉到「它之后的第一条 request」，同一处连发的合并成一个标记 ----
    const events = Array.isArray(val.events) ? val.events : [];
    const markers: TimelineCutView[][] = points.map(() => []);
    let cutsTotal = 0;
    for (const event of events) {
        const kind = str(field(event, 'kind'));
        if (kind !== 'compaction' && kind !== 'prune') continue;
        const eventSeq = num(field(event, 'seq'));
        let rawIndex = -1;
        if (eventSeq !== null) {
            for (let index = 0; index < raw.length; index += 1) {
                const candidate = raw[index].seq;
                if (candidate !== null && candidate > eventSeq) {
                    rawIndex = index;
                    break;
                }
            }
        }
        /**
         * 找不到「它之后的第一条 request」的两种情况都钉在**最后一根柱**上：
         * ① 事件发生在最后一次调用之后（会话刚压缩完就结束了）；② 请求记录里没有 seq。
         * 为什么不丢：上游 wire view 也不会把事件丢掉（它只往事件上补 turn/step），
         * 而丢掉的表现是「明明压缩过，图上却什么都没有」—— 那是这块最容易犯的错。
         */
        if (rawIndex < 0) rawIndex = raw.length - 1;
        const bar = barOfRaw[rawIndex];
        const list = markers[bar];
        const time = num(field(event, 'time'));
        const tokens = num(field(event, 'tokens')) ?? 0;
        const count = num(field(event, 'count'));
        const previous = list[list.length - 1];
        /**
         * 合并：**同一根柱 + 时间相近**。时间窗取 5 秒，依据是本机真数据里那一串
         * （7 条 prune 在 52ms 内连发，3.0 秒后才是一条大 compaction —— 前 7 条合并、
         * 那条 compaction 单独一个标记，因为它隔着 3 秒且量级完全不同）。
         */
        if (previous && time !== null && previous.time !== null && time - previous.time <= TIMELINE_MERGE_MS) {
            previous.tokens += tokens;
            previous.merged += 1;
            if (kind === 'compaction') previous.kind = 'compaction';
            if (count !== null) previous.count = (previous.count ?? 0) + count;
            continue;
        }
        list.push({
            kind,
            tokens,
            count,
            merged: 1,
            time,
            seq: num(field(event, 'seq')),
        });
        cutsTotal += 1;
    }
    for (let index = 0; index < points.length; index += 1) points[index].cuts = markers[index];

    const tokens = points.map((point) => point.tokens);
    const last = points[points.length - 1];
    return {
        timeline: {
            ver,
            seq: num(row.seq),
            points,
            requests: raw.length,
            aggregated,
            dropped,
            max: Math.max(0, ...tokens),
            estimatedCount: points.filter((point) => point.estimated).length,
            lastTokens: last.tokens,
            lastEstimated: last.estimated,
            contextWindow: positive(val.contextWindow),
            archiveFloor: num(val.archiveFloor),
            cutsTotal,
        },
        note: null,
    };
}

/** 由一个请求记录造一根柱（`index` 是 1 起的柱号，`steps` 是这根柱代表几步）。 */
function pointOf(source: RawTimelinePoint, index: number, steps: number, stepCount: number | null): TimelinePointView {
    /**
     * ⚠ 柱宽用**请求条数**（`steps`），不是记录自带的 `stepCount`：本机 470 份真缓存里
     * `stepCount` **一次都没出现过**（上游 schema 里有这个字段，但没人写它）——
     * 拿它当唯一的宽度依据，聚合出来的柱宽会全是 1。两个都有时取大的那个。
     */
    return {
        index,
        tokens: source.tokens,
        prompt: source.prompt,
        total: source.total,
        estimated: source.estimated,
        turn: source.turn,
        step: source.step,
        seq: source.seq,
        steps: Math.max(steps, stepCount ?? 1),
        cuts: [],
    };
}

/** 同一根柱上「算一次」的时间窗（毫秒）：连发的 prune 落在这个窗里就合成一个标记。 */
const TIMELINE_MERGE_MS = 5_000;

/**
 * 把一份缓存记录文档归一化成进度。**纯函数**（不打日志、不碰盘），所以能直接测。
 *
 * 形状认不出就返回 null（调用方要说出来，不要假装「这个会话没有清单」）。
 */
export function progressOf(raw: unknown): SessionProgressResult | null {
    const gate = rowsOf(raw);
    if ('error' in gate) return null;
    const notes: string[] = [];
    const progress: SessionProgress = {
        todos: parseTodos(rowVal(gate.rows, 'todos'), notes),
        goal: parseGoalProjection(rowVal(gate.rows, 'goal'), notes),
        ...parseTurnOutline(rowVal(gate.rows, 'turnOutline'), notes),
    };
    return { progress, notes };
}

// ---------------------------------------------------------------- 花费：账本
//
// 金额在投影缓存里（`costUsage.totals.cost`，**恒为美元**），而「显示成什么币种、按什么汇率、
// 留几位小数」在 `dsh-cost-meter` 自己的账本里。所以这一节全是**纯函数**：
// 上游怎么格式化，这里就怎么格式化（逐字移植），否则面板上与 web 那边显示的钱会长得不一样。

/**
 * `dsh-cost-meter` 的账本路径：`<DSH_HOME>/storages/cost-meter/ledger.json`。
 *
 * ⚠ 它是**这台机器共享的**（不分工程、不分 profile）：`days['<日期>'].cost` 是
 * **所有工程加起来**的一天，所以面板上那一行必须写「全部工程」。
 */
export function costLedgerPath(): string {
    return join(dshHome(), 'storages', 'cost-meter', 'ledger.json');
}

/** 账本超过这个大小就不读了（一次读盘要整个 `JSON.parse`）。真实账本是 180 天、几百 KB。 */
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** 最多扫这么多天（账本自己配的是 `historyDays: 180`；再多说明这份账本被人改过）。 */
const MAX_LEDGER_DAYS = 400;

/**
 * 上游 `localDayKey` 的**逐字移植**（`dsh-cost-meter/lib/store.js`）。
 *
 * 账本的 `days` 键是**本地时区**的 `YYYY-MM-DD`。用 `toISOString().slice(0, 10)` 拿 UTC
 * 日期在东八区会**错一天**（下午 8 点之后），于是「今日」那一行会指向前一天的账。
 */
export function localDayKey(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 从账本里取显示设置。**认不出形状就 null**（不猜默认值 —— 猜错了就是悄悄改别人的钱该显示成多少）。
 */
export function costDisplayOf(raw: unknown): CostDisplay | null {
    if (!isRecord(raw)) return null;
    const config = isRecord(raw.config) ? raw.config : null;
    if (!config) return null;
    const currency = str(config.currency);
    const symbol = str(config.symbol);
    const decimals = num(config.decimals);
    const exchangeRate = num(config.exchangeRate);
    const pricingCurrency = str(config.pricingCurrency);
    if (currency === null || symbol === null || decimals === null || exchangeRate === null || pricingCurrency === null) {
        return null;
    }
    return { currency, symbol, decimals, exchangeRate, pricingCurrency };
}

/**
 * 账本里与**某一条会话**有关的事实。**纯函数**（不打日志、不碰盘），所以能直接测。
 *
 * ⚠ **格式化不在这里**：`formatMoney` 的唯一实现是 `panels/default/cost.ts`
 * （那是面板要画的文字，已知答案表在 `verify-panel` 里，与真插件对拍的断言在
 * `verify-stats` 里）。这一份只管**读数据**，两处各写一份格式化必然漂移。
 *
 * 三种「没有」分得很清楚，面板上的话也完全不一样：
 * - 整份账本形状不认识 → 返回 **null**（调用方按「读不到账本」处理，不能当成「没花钱」）；
 * - 账本认识、但没有 `days` → 返回一份**全 null** 的事实（显示设置还能用）；
 * - 账本里就是没有这条会话 → `sessionUsd` 是 null（老会话/导入没覆盖到 → 面板说「账本里也没有」）。
 *
 * @param raw - `JSON.parse` 之后的整份账本。
 * @param sessionId - 要查的会话 id（账本里 `days[日期].sessions[].id`）。
 * @param nowMs - 「今天」按哪个时刻算（本地日期，见 `localDayKey`）。
 */
export function costFactsOf(raw: unknown, sessionId: string, nowMs: number): CostLedgerView | null {
    if (!isRecord(raw)) return null;
    const days = isRecord(raw.days) ? raw.days : null;
    if (!days) return null;
    const todayKey = localDayKey(nowMs);

    let sessionUsd: number | null = null;
    let calls: number | null = null;
    let scanned = 0;
    for (const day of Object.values(days)) {
        if (scanned >= MAX_LEDGER_DAYS) break;
        scanned += 1;
        if (!isRecord(day) || !Array.isArray(day.sessions)) continue;
        for (const entry of day.sessions) {
            if (!isRecord(entry) || str(entry.id) !== sessionId) continue;
            // 跨零点的一条会话会**同时**出现在两天的 sessions 里，所以是**累加**而不是取最后一条。
            const cost = num(entry.cost);
            if (cost !== null) sessionUsd = (sessionUsd ?? 0) + cost;
            const count = num(entry.calls);
            if (count !== null) calls = (calls ?? 0) + count;
        }
    }

    const today = isRecord(days[todayKey]) ? days[todayKey] : null;
    return { sessionUsd, calls, todayUsd: today ? num(today.cost) : null, todayKey };
}

/**
 * 花费那一行的注册者 —— 一个**第三方** bundle（不是 DSH 自带的）。
 *
 * 名字在这里写一次，另外两处都从它派生：profile 清单的查找（`readCostMount`）与面板话术
 * （`costTextOf` 的 `bundle` 入参）。
 *
 * ⚠ **本 profile 不挂它**（2026-12 决定：`dsh-profile/package.json` 里零第三方 bundle）。
 * `readCostMount()` 因此会返回 `false`，面板照实说"没挂、想用怎么加回来" —— 这条读盘
 * 之所以留着，是因为**别的 profile 的会话**与**老会话**都还带着 `costUsage`，
 * 而"为什么这一条没有金额"的三种来路必须分得清（见 `cost.ts` 的 `noRecordNote`）。
 */
const COST_METER_BUNDLE = 'dsh-cost-meter';

/** profile 目录名（与 `install-profile.js` 的 `PROFILE_NAME` 同一个值）。 */
const PROFILE_NAME = 'cocos';

/** profile 清单：`<DSH_HOME>/profiles/cocos/package.json`。 */
export function profileManifestPath(): string {
    return join(dshHome(), 'profiles', PROFILE_NAME, 'package.json');
}

/**
 * 这个 profile 挂没挂花费那个第三方 bundle。**纯读盘，不猜**。
 *
 * 为什么要读它：`costUsage` 那一行缺失有三种来路（老会话 / 这个 profile 没装插件 /
 * 别的 profile 的会话），只看缓存分不出来，而三种的界面话术完全不同 ——
 * 尤其「这个 profile 没装」时用户真正需要的是**一条能直接粘的命令**。
 *
 * @returns `true` 挂着 / `false` 清单里没有它 / `null` 读不到清单（那就不猜，面板说分不清）。
 */
export async function readCostMount(): Promise<boolean | null> {
    try {
        const text = await readFile(profileManifestPath(), 'utf8');
        const manifest = JSON.parse(text) as { dsh?: { profile?: { bundles?: unknown } } };
        const bundles = manifest.dsh?.profile?.bundles;
        if (!Array.isArray(bundles)) return null;
        return bundles.includes(COST_METER_BUNDLE);
    } catch {
        return null;
    }
}

/** 读账本的结果（**读不到不是错误**：那只是没有显示设置、没有对账数据）。 */export interface CostLedgerResult {
    /** 读不动 / 太大 / 形状不认识的原因（面板原样说出来）。 */
    error?: string;
    /** 显示设置（币种 / 汇率 / 小数位）；认不出就是 null。 */
    display: CostDisplay | null;
    /** 与这条会话有关的事实；账本里没有这条会话、或者账本读不到，就是 null。 */
    facts: CostLedgerView | null;
}

/**
 * 读一次账本。
 *
 * ⚠ 这是**第二个文件**（用量在投影缓存里，显示设置在这里）。上游把它整个对象落盘，
 * 所以只能整个 `JSON.parse`；真实账本（180 天）几百 KB，打开抽屉时读一次是可以接受的。
 * 读不到**绝不影响**用量那半 —— 调用方拿到 `error` 就照实说一句，然后按美元原值画。
 *
 * @param sessionId - 要查的会话 id。
 * @param nowMs - 「今天」按哪个时刻算（默认现在；测试会传固定值）。
 */
export async function readCostLedger(sessionId: string, nowMs: number = Date.now()): Promise<CostLedgerResult> {
    const file = costLedgerPath();
    let text: string;
    try {
        const info = await stat(file);
        if (info.size > MAX_LEDGER_BYTES) {
            return {
                display: null,
                facts: null,
                error: `cost-meter 的账本有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过面板愿意读的上限（${MAX_LEDGER_BYTES / 1024 / 1024} MB），所以没有显示币种与对账数据。`,
            };
        }
        text = await readFile(file, 'utf8');
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') {
            return { display: null, facts: null, error: '读不到 cost-meter 的账本（那个插件还没跑过，或者它换了位置）。' };
        }
        return { display: null, facts: null, error: `读不了 cost-meter 的账本：${describe(error)}` };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { display: null, facts: null, error: `cost-meter 的账本不是合法 JSON（${describe(error)}）` };
    }

    const display = costDisplayOf(raw);
    return {
        display,
        facts: costFactsOf(raw, sessionId, nowMs),
        ...(display === null
            ? { error: '账本读到了，但里面的显示设置认不出来（币种 / 汇率字段缺失）—— 面板按账本原值（美元）显示。' }
            : {}),
    };
}

/**
 * 把账本那一份事实贴到用量上（**外加**「这个 profile 到底挂没挂那个 bundle」）。
 *
 * ⚠ **一句话都不写进 `notes`**：账本读不到只影响「花费显示成什么币种」，
 * 与用量的口径无关；而「三缺一」的话术（没装 / 太老 / 别的 profile）也是花费那一块自己的事。
 * 这两类措辞都在 `panels/default/cost.ts`（`costTextOf`）里 —— 那里才有已知答案表。
 *
 * @param usage - 归一化好的用量（**就地**改：贴四个字段）。
 * @param ledger - 读账本的结果。
 * @param mounted - 这个 profile 挂没挂那个 bundle（`null` = 读不到清单）。
 */
function attachCostLedger(usage: SessionUsage, ledger: CostLedgerResult, mounted: boolean | null): void {
    usage.costDisplay = ledger.display;
    usage.costLedger = ledger.facts;
    usage.costNote = ledger.error ?? null;
    usage.costMounted = mounted;
    usage.costBundle = COST_METER_BUNDLE;
}

/**
 * 把一份缓存记录归一化成 `SessionUsage`。**纯函数**（不打日志、不碰盘），所以能直接测。
 *
 * @param raw - `JSON.parse` 之后的整份文档。
 * @param meta - 文件层面的事实（id / mtime / 实时水位）。
 * @returns `{ok:false, error}` 表示这份记录**形状不认识**（调用方要说出来，不要假装没有用量）。
 */
export function normalizeUsageRecord(
    raw: unknown,
    meta: { id: string; updatedAt?: number; liveSeq?: number },
): SessionUsageResult {
    const gate = rowsOf(raw);
    if ('error' in gate) return { ok: false, error: gate.error };
    const document = raw as Record<string, unknown>;
    const rows = gate.rows;

    const notes: string[] = [];
    const version = num(document.version);
    if (version === null || !KNOWN_RECORD_VERSIONS.has(version)) {
        notes.push(
            `缓存记录的格式版本是 v${version === null ? '?' : version}，本面板是按 v5 认的 —— ` +
                '下面是尽力而为读出来的，数字可能与 DSH 自己的口径对不上。',
        );
    }

    // ⚠ 身份那一层在 `record` 上（不在 `record.rows` 上）—— 所以这里得从文档再取一次，
    // 不能拿 `rowsOf` 给的那半截。
    const identityRaw = ((document.record as { identity?: unknown }).identity ?? {}) as Record<string, unknown>;
    const inheritedEvents = num(identityRaw.inheritedEventCount) ?? 0;
    const seeded = identityRaw.isSeeded === true;
    if (seeded || inheritedEvents > 0) {
        notes.push(
            `这条会话是从别的会话接过来的（前面还有 ${inheritedEvents} 条事件不在本日志里），` +
                '所以下面「本会话累计」只算这份日志记下的部分。',
        );
    }

    const seq = watermarkOf(rows);
    const liveSeq = num(meta.liveSeq);
    const behind = seq !== null && liveSeq !== null && liveSeq > seq ? liveSeq - seq : null;

    // ---- 上下文占用 ----
    const pressureRaw = rowValue(rows, 'contextPressure');
    const breakdownRaw = rowValue(rows, 'contextBreakdown');
    const window = pressureRaw ? positive(pressureRaw.contextWindow) : null;
    const pressure = pressureRaw ? num(pressureRaw.pressureTokens) : null;
    const surface = pressureRaw ? num(pressureRaw.surfaceTokens) : null;
    const sampledSurface = pressureRaw ? num(pressureRaw.sampledSurfaceTokens) : null;

    /**
     * ⚠ **公式照抄上游**（`dsh-token-meter` 的 `contextPressure` wire view）：
     *
     * ```js
     * projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
     * ```
     *
     * 为什么不用 `pressureTokens` 当占用率：它是**上一次**请求的实测，压缩之后会偏高；
     * 上游为此维护了 surface 位移，`projected` 才是「下一次请求大概要多少」。
     * 上游样本或 surface 缺一个就不给 —— 那就退回实测，并在 notes 里说清楚。
     */
    let projected: number | null = null;
    if (pressure !== null && surface !== null && sampledSurface !== null) {
        projected = Math.max(0, pressure + surface - sampledSurface);
        if (surface < sampledSurface) {
            // surface 变小 = 那次采样之后上下文被**压缩**过（`/compact`、或上下文裁剪）。
            // 不说这一句的话，用户会看到「占用率突然掉了一大截」而不知道为什么。
            notes.push(
                `这份记录里上下文被压缩过（surface ${sampledSurface} → ${surface}），` +
                    '所以占用率用的是「修正后的预估」，不是上一次请求的实测 —— 数字变小是正常的。',
            );
        }
    } else if (pressure !== null) {
        projected = pressure;
        notes.push(
            '这条记录里缺下一次请求的预估（缓存里没有 surface 采样），' +
                '所以占用率用的是「上一次请求的实测」—— 压缩过的话它会偏高一点。',
        );
    }

    const ratio = projected !== null && window !== null && window > 0 ? projected / window : null;
    if (ratio !== null && ratio > 1) {
        notes.push('预估的 prompt 已经超过窗口上限了 —— 下一次请求要么被压缩，要么会被拒。');
    }

    const context = {
        window,
        projected,
        pressure,
        ratio,
        system: breakdownRaw ? num(breakdownRaw.systemTokens) : null,
        tools: breakdownRaw ? num(breakdownRaw.toolsTokens) : null,
        messages: breakdownRaw ? num(breakdownRaw.messageTokens) : null,
    };
    if (pressureRaw === null) {
        notes.push('这条会话没有上下文占用记录（它可能太旧，或者还没发过请求）。');
    } else {
        if (pressure === null) {
            notes.push('这条记录里没有 prompt 侧的实测（provider 还没报过 usage），所以给不出占用率。');
        }
        if (window === null) {
            notes.push('不知道窗口上限（DSH 还没记到 request/context 那条记录），所以没有占用率，只有绝对量。');
        }
    }

    // ---- token 累计 ----
    const usageRaw = rowValue(rows, 'tokenUsage');
    const totalsRaw = usageRaw ? usageRaw.totals : null;
    const totals = bucketsOf(totalsRaw);
    let last: SessionUsage['usage']['last'] = null;
    if (usageRaw && usageRaw.last && typeof usageRaw.last === 'object') {
        const lastRaw = usageRaw.last as Record<string, unknown>;
        const buckets = bucketsOf(lastRaw.buckets);
        if (buckets) {
            last = { turn: num(lastRaw.turn) ?? 0, step: num(lastRaw.step) ?? 0, buckets };
        }
    }
    if (usageRaw === null) notes.push('这条会话没有 token 计数记录。');

    // ---- 花费（单位恒为**美元**；显示成什么币种由账本决定，见 `attachCostLedger`） ----
    const costRaw = rowValue(rows, 'costUsage');
    const costTotals = costRaw ? ((costRaw.totals ?? null) as Record<string, unknown> | null) : null;
    const costAmount = costTotals ? num(costTotals.cost) : null;
    const cost =
        costAmount === null
            ? null
            : {
                  amount: costAmount,
                  provider: str(costRaw?.provider) ?? '',
                  model: str(costRaw?.model) ?? '',
              };

    // ---- 上下文增长（第三方 `dsh-context` 注册的那一行；本 profile 不挂它 → 常态是没有） ----
    //
    // ⚠ 这一份**不额外读盘**：它与用量其它几行在**同一份 JSON** 里（`readSessionCache`
    // 一次读盘全给），所以加这块对 I/O 的影响是零。
    const timelineParse = parseContextTimeline(rows.contextTimeline);

    // ---- 会话统计 ----
    const statsRaw = rowValue(rows, 'sessionStats');    const session = {
        turns: statsRaw ? num(statsRaw.turns) : null,
        steps: statsRaw ? num(statsRaw.steps) : null,
        llmMs: statsRaw ? num(statsRaw.llmMs) : null,
        toolMs: statsRaw ? num(statsRaw.toolMs) : null,
        ttftMs: statsRaw ? num(statsRaw.ttftMs) : null,
        ttftSteps: statsRaw ? num(statsRaw.ttftSteps) : null,
        decodeMs: statsRaw ? num(statsRaw.decodeMs) : null,
        decodeTokens: statsRaw ? num(statsRaw.decodeTokens) : null,
    };

    // ---- 模型 / 供应商：优先花费记录（它连 provider 一起记），退回模型选择那一行 ----
    const selectionRaw = rowValue(rows, 'modelSelection');
    const lastUsed = selectionRaw ? ((selectionRaw.lastUsed ?? null) as Record<string, unknown> | null) : null;
    const model = str(costRaw?.model) ?? (lastUsed ? str(lastUsed.model) : null);
    const provider = str(costRaw?.provider) ?? (lastUsed ? str(lastUsed.provider) : null);

    return {
        ok: true,
        usage: {
            id: meta.id,
            version,
            seq,
            behind,
            updatedAt: typeof meta.updatedAt === 'number' && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0,
            identity: {
                cwd: str(identityRaw.cwd),
                seeded,
                inheritedEvents,
            },
            model,
            provider,
            context,
            usage: { totals, last },
            cost,
            // 这两个字段来自**另一个文件**（账本），所以这里只占位，由 `attachCostLedger` 填。
            costDisplay: null,
            costLedger: null,
            costNote: null,
            costMounted: null,
            costBundle: COST_METER_BUNDLE,
            // 这一行（`contextTimeline`）与花费那几行不一样：它**同一次读盘**就拿到了，
            // 所以这里直接给结果，不需要第二次读盘、也没有 `attach*` 那一步。
            timeline: timelineParse.timeline,
            timelineNote: timelineParse.note,
            session,
            notes,
        },
    };
}

// ---------------------------------------------------------------- 读盘

/**
 * 读一条会话的缓存记录（**一次读盘，用量与进度一起给**），顺手补一次账本里的花费口径。
 *
 * 为什么合成一次读：两者在**同一份文件**里（大的能到 400+ KB），分两次读就是把同一份
 * JSON 解析两遍；而且两块的「水位 / 落后多少 / 写于何时」本来就是同一组事实 ——
 * 分开读会出现「用量说落后 12 条、进度说落后 3 条」这种自相矛盾的画面。
 *
 * ⚠ 花费那块还要读**第二个文件**（`dsh-cost-meter` 的账本，几百 KB）：金额在缓存里、
 * **显示成什么币种**在账本里。账本读不到只是少一层显示口径，绝不让用量那半失败。
 *
 * 三种「没有」要分清楚（面板上的话完全不一样）：
 * - **没找到**：这条会话还没落过检查点（新会话第一轮之前、或者空会话）；
 * - **读不动**：文件在但 JSON 坏了（写到一半断电？）—— 上游的策略是「备份并跳过」，
 *   所以正常不会发生，发生了就要说出来；
 * - **形状不认识**：DSH 换了缓存格式（`normalizeUsageRecord` 会给话）。
 *
 * @param sessionId - 会话 id（= 缓存文件名；`[A-Za-z0-9._-]`，见 `SAFE_ID`）。
 * @param options.liveSeq - 当前实时水位（宿主从事件流上记的），用来算 `behind`。
 * @returns `{ok, usage?, progress?, error?}`；失败不抛。
 */
export async function readSessionCache(
    sessionId: string,
    options: { liveSeq?: number } = {},
): Promise<SessionCacheResult> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return { ok: false, error: '会话 id 是空的' };
    if (id === '.' || id === '..' || !SAFE_ID.test(id)) {
        return { ok: false, error: `会话 id 不像一个 id：${id.slice(0, 40)}` };
    }

    const file = usageRecordPath(id);
    let text: string;
    let updatedAt = 0;
    try {
        const info = await stat(file);
        updatedAt = info.mtimeMs;
        text = await readFile(file, 'utf8');
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') {
            return { ok: false, error: '这条会话还没有投影缓存记录（DSH 会在创建 / 每轮结束 / 关闭时写一次检查点）。' };
        }
        return { ok: false, error: `读不了投影缓存：${describe(error)}` };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { ok: false, error: `投影缓存不是合法 JSON（${describe(error)}）—— 文件：${file}` };
    }

    const usage = normalizeUsageRecord(raw, { id, updatedAt, liveSeq: options.liveSeq });
    if (!usage.ok || !usage.usage) return { ok: false, error: usage.error ?? '这份记录里读不出用量' };
    /**
     * 进度认不出形状**不算整份失败**：用量是主体（占用率决定面板上那颗 chip 显不显示），
     * 进度缺了就只是「清单 / 回合目录这一块空着」，宿主会照实说（不是静默空着）。
     */
    const progress = progressOf(raw);
    /**
     * 花费的**显示口径**在第二个文件里（`dsh-cost-meter` 的账本）：币种、汇率、小数位；
     * 还顺手读一下 profile 清单（那里面写着**这个 profile 到底挂没挂**那个第三方 bundle ——
     * 「没装」与「会话太老」在界面上是两句完全不同的话）。
     * 两者都**不算整份失败** —— 读不到就按美元原值画、话术退回「分不清」，并把原因写进 notes。
     * 这一步只在这一条会话**真的读出来了**之后才做（读失败时没必要再去读那两个文件）。
     */
    const [ledger, mounted] = await Promise.all([readCostLedger(id), readCostMount()]);
    attachCostLedger(usage.usage, ledger, mounted);
    return { ok: true, usage: usage.usage, ...(progress ? { progress: progress.progress } : {}) };
}

/**
 * 读一条会话的用量（`readSessionCache` 的薄包装）。
 *
 * 留着这个入口的理由：用量的口径有 60+ 条断言盯着（`scripts/verify-stats.js`），
 * 那些断言关心的是「归一化之后是不是这几个数」，不该被进度那一半的字段变化牵连。
 */
export async function readSessionUsage(
    sessionId: string,
    options: { liveSeq?: number } = {},
): Promise<SessionUsageResult> {
    const result = await readSessionCache(sessionId, options);
    return result.ok && result.usage ? { ok: true, usage: result.usage } : { ok: false, error: result.error };
}

/** 把异常收敛成一句话。 */
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
