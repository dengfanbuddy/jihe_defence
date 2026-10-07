"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dshHome = dshHome;
exports.projectionRoot = projectionRoot;
exports.usageRecordPath = usageRecordPath;
exports.rowsOf = rowsOf;
exports.parseTodos = parseTodos;
exports.parseGoalProjection = parseGoalProjection;
exports.parseGoalChange = parseGoalChange;
exports.parseTurnOutline = parseTurnOutline;
exports.parseContextTimeline = parseContextTimeline;
exports.progressOf = progressOf;
exports.costLedgerPath = costLedgerPath;
exports.localDayKey = localDayKey;
exports.costDisplayOf = costDisplayOf;
exports.costFactsOf = costFactsOf;
exports.profileManifestPath = profileManifestPath;
exports.readCostMount = readCostMount;
exports.readCostLedger = readCostLedger;
exports.normalizeUsageRecord = normalizeUsageRecord;
exports.readSessionCache = readSessionCache;
exports.readSessionUsage = readSessionUsage;
const promises_1 = require("fs/promises");
const os_1 = require("os");
const path_1 = require("path");
const constants_1 = require("./constants");
/** 认得的**文档**格式版本（`record.version`）；认不出也照读，只是会加一条 notes。 */
const KNOWN_RECORD_VERSIONS = new Set([5]);
/**
 * 会话 id 的安全白名单。
 *
 * id 会拼进文件路径，所以只放行 `[A-Za-z0-9._-]`，并且显式拒掉 `.` / `..`
 * （口径与 `scripts/session-log.js` 的 `safeNameOf` 一致 —— 两处都挡，谁被改坏了都还有一层）。
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
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
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);
/** 目标阶段的白名单（逐字对应 DSH 的 `GoalPhase`）。 */
const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete']);
/**
 * `<DSH_HOME>`（`DSH_HOME` 没设就按 `~/.dsh`）。
 *
 * ⚠ 口径必须与 `history.ts` 的 `sessionsRoot()` 一致 —— 那边也是这么算的。
 * 两处都拼同一个字符串，`scripts/verify-stats.js` 有一条断言把两者钉在一起。
 */
function dshHome() {
    var _a;
    const home = (_a = process.env.DSH_HOME) === null || _a === void 0 ? void 0 : _a.trim();
    return home && home !== '' ? home : (0, path_1.join)((0, os_1.homedir)(), '.dsh');
}
/** 投影缓存的会话记录目录：`<DSH_HOME>/storages/session_projcache/sessions`。 */
function projectionRoot() {
    return (0, path_1.join)(dshHome(), 'storages', 'session_projcache', 'sessions');
}
/** 一条会话的缓存记录路径。 */
function usageRecordPath(sessionId) {
    return (0, path_1.join)(projectionRoot(), `${sessionId}.json`);
}
// ---------------------------------------------------------------- 取值小工具
//
// 缓存里的数字来自**别的进程**，形状随上游版本变。所以这里一律「认得出就用、
// 认不出就当没有」，绝不 `as number` 硬转 —— 一个 NaN 画到面板上就是一条骗人的进度条。
/** 非负有限数才认（`undefined` / `null` / `NaN` / 负数 / 字符串一律 null）。 */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
/** 正整数才认（窗口上限这类）。 */
function positive(value) {
    const value2 = num(value);
    return value2 !== null && value2 > 0 ? value2 : null;
}
/** 字符串才认（trim 后非空）。 */
function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
/** 纯对象才认（数组、null、标量一律不算）—— 读别家的 JSON 时到处都要这一句。 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * 从 `record.rows` 里取一行的 `val`（**原样**，数组也照给）。
 *
 * ⚠ 与 `rowValue` 的区别很重要：`todos` 那一行的状态**本身就是数组**，
 * 用只认对象的 `rowValue` 读它，读到的永远是 `null` —— 而且不报错，
 * 表现为「这个会话从来没有清单」（其实是有的）。这一对函数就是为这件事分家的。
 */
function rowVal(rows, key) {
    const row = rows[key];
    if (!row || typeof row !== 'object' || Array.isArray(row))
        return undefined;
    return row.val;
}
/** 从 `record.rows` 里取一行的 `val`，**只认对象**（用量那几行都是对象）。 */
function rowValue(rows, key) {
    const value = rowVal(rows, key);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
/** 取 `record.rows` 里出现过的**最大** `seq`（= 这份记录的水位）。 */
function watermarkOf(rows) {
    let best = null;
    for (const row of Object.values(rows)) {
        if (!row || typeof row !== 'object')
            continue;
        const seq = num(row.seq);
        if (seq === null)
            continue;
        best = best === null ? seq : Math.max(best, seq);
    }
    return best;
}
/** 四个桶；四个都不是数就当没有。 */
function bucketsOf(value) {
    var _a, _b, _c, _d;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    const input = (_a = num(raw.input)) !== null && _a !== void 0 ? _a : num(raw.uncachedInputTokens);
    const output = (_b = num(raw.output)) !== null && _b !== void 0 ? _b : num(raw.outputTokens);
    const cacheRead = (_c = num(raw.cacheRead)) !== null && _c !== void 0 ? _c : num(raw.cacheReadTokens);
    const cacheWrite = (_d = num(raw.cacheWrite)) !== null && _d !== void 0 ? _d : num(raw.cacheWriteTokens);
    if (input === null && output === null && cacheRead === null && cacheWrite === null)
        return null;
    return { input: input !== null && input !== void 0 ? input : 0, output: output !== null && output !== void 0 ? output : 0, cacheRead: cacheRead !== null && cacheRead !== void 0 ? cacheRead : 0, cacheWrite: cacheWrite !== null && cacheWrite !== void 0 ? cacheWrite : 0 };
}
// ---------------------------------------------------------------- 归一化
/**
 * 从整份文档里取出 `record.rows`（**用量与进度共用的第一道门**）。
 *
 * 三种「形状不对」各自有各自的话 —— 面板上这三句话完全不同：文件坏了、DSH 换了格式、
 * 或者这份记录本来就是空的。
 */
function rowsOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: '投影缓存的记录不是一个对象' };
    }
    const record = raw.record;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { error: '投影缓存的记录里没有 record 字段' };
    }
    const rowsRaw = record.rows;
    if (!rowsRaw || typeof rowsRaw !== 'object' || Array.isArray(rowsRaw)) {
        return { error: '投影缓存的记录里没有 record.rows（DSH 的缓存格式变了？）' };
    }
    return { rows: rowsRaw };
}
/** 截断并显式加省略号（不这么干就是在无声地改内容）。 */
function cut(text, limit) {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
/** `str()` 的数组版本：把一项里的字符串字段取出来，认不出就 null。 */
function field(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value[key];
}
/**
 * `todos` 行 → 面板的清单。
 *
 * `null` / `[]` / 有内容**是三件事**：`null` 是「这份记录里没有清单」，`[]` 是
 * 「agent 明确写了一份空表」（`todo_write` 允许空数组吗？工具 schema 要求
 * `required: true` 的数组，空数组是合法的），有内容就是有内容 —— 面板上第 1 与第 3 种
 * 的写法完全不同，所以这里一个都不许合并。
 */
function parseTodos(value, notes) {
    var _a;
    if (!Array.isArray(value))
        return null;
    if (value.length === 0)
        return [];
    const todos = [];
    let dropped = 0;
    for (const item of value) {
        const content = str(field(item, 'content'));
        const status = String((_a = field(item, 'status')) !== null && _a !== void 0 ? _a : '');
        if (!content || !TODO_STATUSES.has(status)) {
            dropped++;
            continue;
        }
        todos.push({ content: cut(content, TODO_TEXT_LIMIT), status: status });
    }
    if (dropped > 0) {
        // 宁少不假：认不出的条目丢掉，但**说出来**（不说的话面板上就是「清单短了几条」）
        notes.push(`这份清单里有 ${dropped} 条读不出来（DSH 的清单条目形状变了？）—— 面板上只列了认得的那 ${todos.length} 条。`);
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
function goalFrom(args) {
    var _a, _b, _c, _d, _e;
    const objective = str(field(args.snapshot, 'objective'));
    const phase = String((_a = field(args.snapshot, 'phase')) !== null && _a !== void 0 ? _a : '');
    if (!objective || !GOAL_PHASES.has(phase))
        return null;
    const blocked = field(args.snapshot, 'blockedReason');
    return {
        objective: cut(objective, PROMPT_TEXT_LIMIT * 2),
        phase: phase,
        roundsStarted: (_b = num(args.roundsStarted)) !== null && _b !== void 0 ? _b : 0,
        maxGoalRounds: (_c = num(field(args.snapshot, 'maxGoalRounds'))) !== null && _c !== void 0 ? _c : 0,
        blockedReason: (_d = str(field(blocked, 'message'))) !== null && _d !== void 0 ? _d : str(field(blocked, 'code')),
        updatedAt: (_e = num(args.updatedAt)) !== null && _e !== void 0 ? _e : 0,
    };
}
/**
 * 缓存里 `goal` 那一行（**投影状态**）→ 面板的目标。
 *
 * ⚠ 这一行的形状是 `{current, seenGoalIds, failure}`，真正的内容在 `current.goal` 里
 * （`current` 是投影的当前值，`goal` 才是快照）。`current` 为 null = 没有目标
 * （本机 490 份记录里绝大多数都是这样）。
 */
function parseGoalProjection(value, notes) {
    var _a, _b, _c;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
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
        const reason = (_c = (_b = (_a = str(failure)) !== null && _a !== void 0 ? _a : str(field(failure, 'message'))) !== null && _b !== void 0 ? _b : str(field(failure, 'reason'))) !== null && _c !== void 0 ? _c : str(field(failure, 'code'));
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
function parseGoalChange(data, notes) {
    var _a;
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return null;
    const operation = String((_a = field(data, 'operation')) !== null && _a !== void 0 ? _a : '');
    if (operation === 'clear')
        return null;
    const goal = goalFrom({
        snapshot: field(data, 'goal'),
        roundsStarted: field(data, 'roundsStarted'),
        updatedAt: field(data, 'updatedAt'),
    });
    if (!goal) {
        notes.push(operation
            ? `目标变更（${cut(operation, 40)}）的事件载荷面板认不出来（DSH 的 goal 事件变了？）。`
            : '目标变更的事件载荷面板认不出来（DSH 的 goal 事件变了？）。');
    }
    return goal;
}
/**
 * `turnOutline` 行 → 回合大纲。
 *
 * ⚠ 状态是 `{turns, draft}`（**不是**那个数组本身 —— 那是客户端 wire view，
 * 照 wire view 读会一条都读不到）。`draft` 是「正在写的那一轮」的回复草稿。
 */
function parseTurnOutline(value, notes) {
    var _a, _b, _c;
    const empty = { turns: [], turnsTotal: 0, draft: '' };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return empty;
    const list = field(value, 'turns');
    const draft = (_a = str(field(value, 'draft'))) !== null && _a !== void 0 ? _a : '';
    if (!Array.isArray(list))
        return { ...empty, draft };
    const all = [];
    let dropped = 0;
    for (const item of list) {
        const turn = positive(field(item, 'turn'));
        if (turn === null) {
            dropped++;
            continue;
        }
        all.push({
            turn,
            prompt: cut((_b = str(field(item, 'prompt'))) !== null && _b !== void 0 ? _b : '', PROMPT_TEXT_LIMIT),
            response: cut((_c = str(field(item, 'response'))) !== null && _c !== void 0 ? _c : '', RESPONSE_TEXT_LIMIT),
            entrySeq: null,
            seq: num(field(item, 'seq')),
        });
    }
    if (dropped > 0)
        notes.push(`回合大纲里有 ${dropped} 条读不出来（DSH 的大纲条目形状变了？）。`);
    // 上游保证严格升序，这里还是排一遍：面板的「第 N 轮」标题依赖顺序，乱了比缺了更难看
    all.sort((a, b) => a.turn - b.turn);
    if (all.length <= MAX_OUTLINE_TURNS)
        return { turns: all, turnsTotal: all.length, draft };
    notes.push(`回合大纲一共 ${all.length} 轮，面板上只列最近 ${MAX_OUTLINE_TURNS} 轮（每条都带两段摘要，全发太重）。`);
    return { turns: all.slice(-MAX_OUTLINE_TURNS), turnsTotal: all.length, draft };
}
/**
 * 空的**投影状态**才算降级占位（`ver: 1` + `val: {}`）。
 *
 * 为什么判「空对象」而不是只判版本号：`ver 1` 是那个插件降级 unit 的版本，而它的状态
 * 永远是不带任何键的 `{}`（`init: () => ({})`、`apply` 是恒等）—— 所以两者同时成立
 * 才是「宿主太老」，单独一个 `ver: 1` 不足以这么说。
 */
function isEmptyState(value) {
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
function parseContextTimeline(row) {
    var _a, _b, _c, _d;
    /**
     * 这一行**根本不存在** → 既没有曲线也没有话要说：那是**常态**（注册者是第三方
     * `dsh-context`，本 profile 不挂它），措辞由面板给（`timelineTextOf` 那两句）。
     * 在这里编一句话的话，面板就分不出「没有这一行」与「这一行读不出来」了。
     */
    if (row === undefined || row === null)
        return { timeline: null, note: null };
    if (!isRecord(row)) {
        return { timeline: null, note: `上下文增长那一行不是一个 {ver, seq, val} 对象（缓存格式变了？）—— 所以不画。` };
    }
    const ver = num(row.ver);
    const val = row.val;
    if (ver === null) {
        return { timeline: null, note: '上下文增长那一行没有版本号，按当前口径不敢硬读，所以不画。' };
    }
    if (ver === constants_1.CONTEXT_TIMELINE_FALLBACK_VERSION && isEmptyState(val)) {
        return { timeline: null, note: (0, constants_1.contextTimelineBaselineNote)(ver) };
    }
    if (ver !== constants_1.CONTEXT_TIMELINE_STATE_VERSION) {
        return { timeline: null, note: (0, constants_1.contextTimelineVersionNote)(ver) };
    }
    if (!isRecord(val)) {
        return { timeline: null, note: '上下文增长这一行的状态不是一个对象（形状面板认不出来，所以不画）。' };
    }
    const rawRequests = val.requests;
    if (!Array.isArray(rawRequests)) {
        return { timeline: null, note: '上下文增长这一行里没有 requests 数组（形状面板认不出来，所以不画）。' };
    }
    if (rawRequests.length === 0) {
        return { timeline: null, note: (0, constants_1.contextTimelineEmptyNote)() };
    }
    // ---- ① 归一化：每个请求一个点（柱高优先取实测的 prompt）----
    const raw = [];
    let dropped = 0;
    for (const item of rawRequests) {
        const prompt = num(field(item, 'prompt'));
        const total = num(field(item, 'total'));
        const tokens = prompt !== null && prompt !== void 0 ? prompt : total;
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
    const groups = [];
    let carriedTurn = null;
    for (let index = 0; index < raw.length; index += 1) {
        const point = raw[index];
        /**
         * 轮次号缺失时**并进上一轮**（第一个就缺则归入 `null` 那一组）——
         * 为什么不自己编一个轮次：面板上「第 N 轮」是给人对账用的，编出来的号
         * 会让人去找一个并不存在的轮次。
         */
        if (point.turn !== null)
            carriedTurn = point.turn;
        const turn = (_a = point.turn) !== null && _a !== void 0 ? _a : carriedTurn;
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.turn === turn) {
            lastGroup.last = index;
            lastGroup.count += 1;
            if (point.stepCount !== null)
                lastGroup.stepCount = Math.max((_b = lastGroup.stepCount) !== null && _b !== void 0 ? _b : 0, point.stepCount);
            continue;
        }
        groups.push({ last: index, count: 1, turn, stepCount: point.stepCount });
    }
    const aggregated = raw.length > constants_1.CONTEXT_TIMELINE_MAX_BARS;
    /** 聚合前的下标 → 要画的柱的下标（压缩点靠它钉上来）。 */
    const barOfRaw = new Array(raw.length).fill(0);
    const points = [];
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
            for (let index = cursor; index <= group.last; index += 1)
                barOfRaw[index] = points.length - 1;
            cursor = group.last + 1;
        }
    }
    else {
        for (let index = 0; index < raw.length; index += 1) {
            points.push(pointOf(raw[index], index + 1, 1, raw[index].stepCount));
            barOfRaw[index] = index;
        }
    }
    // ---- ③ 压缩点：钉到「它之后的第一条 request」，同一处连发的合并成一个标记 ----
    const events = Array.isArray(val.events) ? val.events : [];
    const markers = points.map(() => []);
    let cutsTotal = 0;
    for (const event of events) {
        const kind = str(field(event, 'kind'));
        if (kind !== 'compaction' && kind !== 'prune')
            continue;
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
        if (rawIndex < 0)
            rawIndex = raw.length - 1;
        const bar = barOfRaw[rawIndex];
        const list = markers[bar];
        const time = num(field(event, 'time'));
        const tokens = (_c = num(field(event, 'tokens'))) !== null && _c !== void 0 ? _c : 0;
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
            if (kind === 'compaction')
                previous.kind = 'compaction';
            if (count !== null)
                previous.count = ((_d = previous.count) !== null && _d !== void 0 ? _d : 0) + count;
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
    for (let index = 0; index < points.length; index += 1)
        points[index].cuts = markers[index];
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
function pointOf(source, index, steps, stepCount) {
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
        steps: Math.max(steps, stepCount !== null && stepCount !== void 0 ? stepCount : 1),
        cuts: [],
    };
}
/** 同一根柱上「算一次」的时间窗（毫秒）：连发的 prune 落在这个窗里就合成一个标记。 */
const TIMELINE_MERGE_MS = 5000;
/**
 * 把一份缓存记录文档归一化成进度。**纯函数**（不打日志、不碰盘），所以能直接测。
 *
 * 形状认不出就返回 null（调用方要说出来，不要假装「这个会话没有清单」）。
 */
function progressOf(raw) {
    const gate = rowsOf(raw);
    if ('error' in gate)
        return null;
    const notes = [];
    const progress = {
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
function costLedgerPath() {
    return (0, path_1.join)(dshHome(), 'storages', 'cost-meter', 'ledger.json');
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
function localDayKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/**
 * 从账本里取显示设置。**认不出形状就 null**（不猜默认值 —— 猜错了就是悄悄改别人的钱该显示成多少）。
 */
function costDisplayOf(raw) {
    if (!isRecord(raw))
        return null;
    const config = isRecord(raw.config) ? raw.config : null;
    if (!config)
        return null;
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
function costFactsOf(raw, sessionId, nowMs) {
    if (!isRecord(raw))
        return null;
    const days = isRecord(raw.days) ? raw.days : null;
    if (!days)
        return null;
    const todayKey = localDayKey(nowMs);
    let sessionUsd = null;
    let calls = null;
    let scanned = 0;
    for (const day of Object.values(days)) {
        if (scanned >= MAX_LEDGER_DAYS)
            break;
        scanned += 1;
        if (!isRecord(day) || !Array.isArray(day.sessions))
            continue;
        for (const entry of day.sessions) {
            if (!isRecord(entry) || str(entry.id) !== sessionId)
                continue;
            // 跨零点的一条会话会**同时**出现在两天的 sessions 里，所以是**累加**而不是取最后一条。
            const cost = num(entry.cost);
            if (cost !== null)
                sessionUsd = (sessionUsd !== null && sessionUsd !== void 0 ? sessionUsd : 0) + cost;
            const count = num(entry.calls);
            if (count !== null)
                calls = (calls !== null && calls !== void 0 ? calls : 0) + count;
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
function profileManifestPath() {
    return (0, path_1.join)(dshHome(), 'profiles', PROFILE_NAME, 'package.json');
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
async function readCostMount() {
    var _a, _b;
    try {
        const text = await (0, promises_1.readFile)(profileManifestPath(), 'utf8');
        const manifest = JSON.parse(text);
        const bundles = (_b = (_a = manifest.dsh) === null || _a === void 0 ? void 0 : _a.profile) === null || _b === void 0 ? void 0 : _b.bundles;
        if (!Array.isArray(bundles))
            return null;
        return bundles.includes(COST_METER_BUNDLE);
    }
    catch {
        return null;
    }
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
async function readCostLedger(sessionId, nowMs = Date.now()) {
    const file = costLedgerPath();
    let text;
    try {
        const info = await (0, promises_1.stat)(file);
        if (info.size > MAX_LEDGER_BYTES) {
            return {
                display: null,
                facts: null,
                error: `cost-meter 的账本有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过面板愿意读的上限（${MAX_LEDGER_BYTES / 1024 / 1024} MB），所以没有显示币种与对账数据。`,
            };
        }
        text = await (0, promises_1.readFile)(file, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return { display: null, facts: null, error: '读不到 cost-meter 的账本（那个插件还没跑过，或者它换了位置）。' };
        }
        return { display: null, facts: null, error: `读不了 cost-meter 的账本：${describe(error)}` };
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
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
function attachCostLedger(usage, ledger, mounted) {
    var _a;
    usage.costDisplay = ledger.display;
    usage.costLedger = ledger.facts;
    usage.costNote = (_a = ledger.error) !== null && _a !== void 0 ? _a : null;
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
function normalizeUsageRecord(raw, meta) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const gate = rowsOf(raw);
    if ('error' in gate)
        return { ok: false, error: gate.error };
    const document = raw;
    const rows = gate.rows;
    const notes = [];
    const version = num(document.version);
    if (version === null || !KNOWN_RECORD_VERSIONS.has(version)) {
        notes.push(`缓存记录的格式版本是 v${version === null ? '?' : version}，本面板是按 v5 认的 —— ` +
            '下面是尽力而为读出来的，数字可能与 DSH 自己的口径对不上。');
    }
    // ⚠ 身份那一层在 `record` 上（不在 `record.rows` 上）—— 所以这里得从文档再取一次，
    // 不能拿 `rowsOf` 给的那半截。
    const identityRaw = ((_a = document.record.identity) !== null && _a !== void 0 ? _a : {});
    const inheritedEvents = (_b = num(identityRaw.inheritedEventCount)) !== null && _b !== void 0 ? _b : 0;
    const seeded = identityRaw.isSeeded === true;
    if (seeded || inheritedEvents > 0) {
        notes.push(`这条会话是从别的会话接过来的（前面还有 ${inheritedEvents} 条事件不在本日志里），` +
            '所以下面「本会话累计」只算这份日志记下的部分。');
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
    let projected = null;
    if (pressure !== null && surface !== null && sampledSurface !== null) {
        projected = Math.max(0, pressure + surface - sampledSurface);
        if (surface < sampledSurface) {
            // surface 变小 = 那次采样之后上下文被**压缩**过（`/compact`、或上下文裁剪）。
            // 不说这一句的话，用户会看到「占用率突然掉了一大截」而不知道为什么。
            notes.push(`这份记录里上下文被压缩过（surface ${sampledSurface} → ${surface}），` +
                '所以占用率用的是「修正后的预估」，不是上一次请求的实测 —— 数字变小是正常的。');
        }
    }
    else if (pressure !== null) {
        projected = pressure;
        notes.push('这条记录里缺下一次请求的预估（缓存里没有 surface 采样），' +
            '所以占用率用的是「上一次请求的实测」—— 压缩过的话它会偏高一点。');
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
    }
    else {
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
    let last = null;
    if (usageRaw && usageRaw.last && typeof usageRaw.last === 'object') {
        const lastRaw = usageRaw.last;
        const buckets = bucketsOf(lastRaw.buckets);
        if (buckets) {
            last = { turn: (_c = num(lastRaw.turn)) !== null && _c !== void 0 ? _c : 0, step: (_d = num(lastRaw.step)) !== null && _d !== void 0 ? _d : 0, buckets };
        }
    }
    if (usageRaw === null)
        notes.push('这条会话没有 token 计数记录。');
    // ---- 花费（单位恒为**美元**；显示成什么币种由账本决定，见 `attachCostLedger`） ----
    const costRaw = rowValue(rows, 'costUsage');
    const costTotals = costRaw ? ((_e = costRaw.totals) !== null && _e !== void 0 ? _e : null) : null;
    const costAmount = costTotals ? num(costTotals.cost) : null;
    const cost = costAmount === null
        ? null
        : {
            amount: costAmount,
            provider: (_f = str(costRaw === null || costRaw === void 0 ? void 0 : costRaw.provider)) !== null && _f !== void 0 ? _f : '',
            model: (_g = str(costRaw === null || costRaw === void 0 ? void 0 : costRaw.model)) !== null && _g !== void 0 ? _g : '',
        };
    // ---- 上下文增长（第三方 `dsh-context` 注册的那一行；本 profile 不挂它 → 常态是没有） ----
    //
    // ⚠ 这一份**不额外读盘**：它与用量其它几行在**同一份 JSON** 里（`readSessionCache`
    // 一次读盘全给），所以加这块对 I/O 的影响是零。
    const timelineParse = parseContextTimeline(rows.contextTimeline);
    // ---- 会话统计 ----
    const statsRaw = rowValue(rows, 'sessionStats');
    const session = {
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
    const lastUsed = selectionRaw ? ((_h = selectionRaw.lastUsed) !== null && _h !== void 0 ? _h : null) : null;
    const model = (_j = str(costRaw === null || costRaw === void 0 ? void 0 : costRaw.model)) !== null && _j !== void 0 ? _j : (lastUsed ? str(lastUsed.model) : null);
    const provider = (_k = str(costRaw === null || costRaw === void 0 ? void 0 : costRaw.provider)) !== null && _k !== void 0 ? _k : (lastUsed ? str(lastUsed.provider) : null);
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
async function readSessionCache(sessionId, options = {}) {
    var _a;
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id)
        return { ok: false, error: '会话 id 是空的' };
    if (id === '.' || id === '..' || !SAFE_ID.test(id)) {
        return { ok: false, error: `会话 id 不像一个 id：${id.slice(0, 40)}` };
    }
    const file = usageRecordPath(id);
    let text;
    let updatedAt = 0;
    try {
        const info = await (0, promises_1.stat)(file);
        updatedAt = info.mtimeMs;
        text = await (0, promises_1.readFile)(file, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return { ok: false, error: '这条会话还没有投影缓存记录（DSH 会在创建 / 每轮结束 / 关闭时写一次检查点）。' };
        }
        return { ok: false, error: `读不了投影缓存：${describe(error)}` };
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, error: `投影缓存不是合法 JSON（${describe(error)}）—— 文件：${file}` };
    }
    const usage = normalizeUsageRecord(raw, { id, updatedAt, liveSeq: options.liveSeq });
    if (!usage.ok || !usage.usage)
        return { ok: false, error: (_a = usage.error) !== null && _a !== void 0 ? _a : '这份记录里读不出用量' };
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
async function readSessionUsage(sessionId, options = {}) {
    const result = await readSessionCache(sessionId, options);
    return result.ok && result.usage ? { ok: true, usage: result.usage } : { ok: false, error: result.error };
}
/** 把异常收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc3RhdHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdHRzs7QUFxSEgsMEJBR0M7QUFHRCx3Q0FFQztBQUdELDBDQUVDO0FBZ0ZELHdCQWFDO0FBcUJELGdDQXFCQztBQW9DRCxrREF3QkM7QUFXRCwwQ0FpQkM7QUFRRCw0Q0E0QkM7QUFpRUQsb0RBK0xDO0FBK0JELGdDQVVDO0FBY0Qsd0NBRUM7QUFjRCxrQ0FJQztBQUtELHNDQWFDO0FBa0JELGtDQXlCQztBQW1CRCxrREFFQztBQVdELHNDQVVDO0FBcUJELHdDQW9DQztBQTRCRCxvREFvTEM7QUF3QkQsNENBaURDO0FBUUQsNENBTUM7QUFycENELDBDQUE2QztBQUM3QywyQkFBNkI7QUFDN0IsK0JBQTRCO0FBZ0I1QiwyQ0FPcUI7QUF3QnJCLDJEQUEyRDtBQUMzRCxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUUzQzs7Ozs7R0FLRztBQUNILE1BQU0sT0FBTyxHQUFHLHlCQUF5QixDQUFDO0FBNkIxQyxxQ0FBcUM7QUFDckMsTUFBTSxpQkFBaUIsR0FBRyxFQUFFLENBQUM7QUFFN0I7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUFDNUIsTUFBTSxpQkFBaUIsR0FBRyxHQUFHLENBQUM7QUFDOUIsTUFBTSxtQkFBbUIsR0FBRyxHQUFHLENBQUM7QUFFaEMsOENBQThDO0FBQzlDLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFTLENBQUMsU0FBUyxFQUFFLGFBQWEsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBRS9FLHdD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QUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2xFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOS8muivneeUqOmHj++8muaKiiBEU0gg55qEKirkvJror53mipXlvbHnvJPlrZgqKuivu+aIkOmdouadv+iDveeUu+eahOmCo+WHoOS4quaVsOWtl+OAglxuICpcbiAqICMjIOaVsOaNruS7juWTquadpVxuICpcbiAqIGBgYFxuICogPERTSF9IT01FPi9zdG9yYWdlcy9zZXNzaW9uX3Byb2pjYWNoZS9zZXNzaW9ucy885Lya6K+dIGlkPi5qc29uXG4gKiBgYGBcbiAqXG4gKiDov5nmmK8gYGRzaC1zZXNzaW9uLXByb2plY3Rpb24tY2FjaGVgIOWGmeS4i+eahCoq5oqV5b2x5qOA5p+l54K5KirvvJrkuIDkuKrkvJror53kuIDkuKogSlNPTiDmlofmoaPvvIxcbiAqIOmHjOmdoiBgcmVjb3JkLnJvd3MuPOaKleW9semUrj4gPSB7dmVyLCBzZXEsIHZhbH1g44CC5pysIHByb2ZpbGUg6YeM5oyC552A55qE5Yeg5Liq5Y2V5YWD5q2j5aW9XG4gKiDlh5HpvZDpnaLmnb/opoHnmoTlhajpg6jmlbDlrZfvvJpcbiAqXG4gKiB8IOihjCB8IOiwgeazqOWGjOeahCB8IOe7meS6huS7gOS5iCB8XG4gKiB8LS0tfC0tLXwtLS18XG4gKiB8IGBjb250ZXh0UHJlc3N1cmVgIHwgYGRzaC10b2tlbi1tZXRlcmAgfCDnqpflj6PkuIrpmZDjgIHkuIrkuIDmrKHor7fmsYLnmoQgcHJvbXB0IOS+p+Wunua1i+OAgSoq5LiL5LiA5qyh6K+35rGC55qE6aKE5LywKiogfFxuICogfCBgY29udGV4dEJyZWFrZG93bmAgfCDlkIzkuIogfCDkuIrkuIvmlocqKue7hOaIkCoq77yI57O757uf5o+Q56S6IC8g5bel5YW36KGoIC8g5a+56K+d77yJ4oCU4oCUICoq5Lyw566XKirvvIzop4Hlj6PlvoQgMyB8XG4gKiB8IGB0b2tlblVzYWdlYCB8IOWQjOS4iiB8IOacrOS8muivnee0r+iuoSBpbnB1dCAvIG91dHB1dCAvIGNhY2hlUmVhZCAvIGNhY2hlV3JpdGUgfFxuICogfCBgc2Vzc2lvblN0YXRzYCB8IGBkc2gtc2Vzc2lvbi1zdGF0c2AgfCDlm57lkIjmlbAgLyDmraXmlbAgLyDmqKHlnovogJfml7YgLyDlt6XlhbfogJfml7YgLyDpppblrZcgLyDop6PnoIEgfFxuICogfCBgY29zdFVzYWdlYCB8IGBkc2gtY29zdC1tZXRlcmDvvIgqKuesrOS4ieaWuSoqIGJ1bmRsZe+8m+KaoCDmnKwgcHJvZmlsZSAqKuWIu+aEj+S4jeaMgioq5a6D77yM6KeB5Y+j5b6EIDTvvIkgfCDoirHotLnvvIgqKue+juWFgyoq5YWl6LSm77yb5pi+56S65oiQ5LuA5LmI5biB56eN5p2l6Ieq6LSm5pys77yM6KeB5Y+j5b6EIDTvvIkgfFxuICogfCBgY29udGV4dFRpbWVsaW5lYCB8IGBkc2gtY29udGV4dGDvvIgqKuesrOS4ieaWuSoqIGJ1bmRsZe+8m+KaoCDkuI7oirHotLnlkIzkuIDkuKrlpITlooPvvJoqKuacrCBwcm9maWxlIOS4jeaMguWugyoq77yM6KeB5Y+j5b6EIDbvvIkgfCDkuIrkuIvmlofpmo/mr4/mrKHmqKHlnovosIPnlKjmgI7kuYjplb/lpKfvvJrmr4/mrKHosIPnlKjnmoQgcHJvbXB0IOS+p+eUqOmHj+OAgeWOi+e8qSAvIOijgeWJqueCueOAgWBhcmNoaXZlRmxvb3JgIHxcbiAqIHwgYHRvZG9zYCB8IGBkc2gtdG9vbC10b2RvYCB8IGFnZW50IOiHquW3seWGmeeahOW3peS9nOihqO+8iGB0b2RvX3dyaXRlYCDnmoTmlbTku73lv6vnhafvvIkgfFxuICogfCBgZ29hbGAgfCBgZHNoLWdvYWxgIHwg55uu5qCH5qih5byP77ya55uu5qCHIC8g6Zi25q61IC8g5bey6LeR5Yeg6L2uIHxcbiAqIHwgYHR1cm5PdXRsaW5lYCB8IGBkc2gtc2Vzc2lvbi10dXJuLW91dGxpbmVgIHwgKirmlbTkuKrml6Xlv5cqKuavj+S4gOi9rueahOi+k+WFpeS4juWbnuWkjeaRmOimge+8iOmdouadv+i9rOWGmeWPqueVmeacgOi/kSA2MDAg5p2h77yM6KeB5Y+j5b6EIDXvvIkgfFxuICpcbiAqIOKaoCAqKmB2YWxgIOaYr+aKleW9seeahOOAjOeKtuaAgeOAje+8jOS4jeaYr+WuouaIt+err+eahOOAjHdpcmUgdmlld+OAjeOAgioqIOS4pOiAheW4uOW4uOWQjOW9ou+8jOS9hioq5LiN5ZCM5b2i55qE5Zyw5pa5XG4gKiDmraPmmK/kvJrouKnlnZHnmoTlnLDmlrkqKu+8mmBjb250ZXh0UHJlc3N1cmVgIOeahOeKtuaAgemHjCoq5rKh5pyJKiogYHByb2plY3RlZFRva2Vuc2DvvIjpgqPmmK8gd2lyZSB2aWV3XG4gKiDnjrDnrpfnmoTvvInvvIzmiYDku6XljaDnlKjnjoflj6rog73oh6rlt7HmjInkuIrmuLjlhazlvI/nrpfvvIjop4Hlj6PlvoQgMu+8ie+8m2B0dXJuT3V0bGluZWAg55qE54q25oCB5pivXG4gKiBge3R1cm5zLCBkcmFmdH1g77yM6ICMIHdpcmUgdmlldyDmmK8gYHR1cm5zYCDpgqPkuKrmlbDnu4TmnKzouqsg4oCU4oCUIOW9k+aIkOaVsOe7hOivu+S8mioq5LiA5Liq5a2X5q616YO96K+75LiN5YiwKirvvIxcbiAqIOiAjOS4lOaYr+mdmem7mOeahO+8iGB1bmRlZmluZWRgIOiAjOS4jeaYr+aKpemUme+8ieOAgmBzY3JpcHRzL3ZlcmlmeS1zdGF0cy5qc2Ag6YeM5pyJ5LiA5p2h5pat6KiA5oqK6L+Z5Lu957yT5a2YXG4gKiDkuI4gYGRzaC1zZXNzaW9uLXByb2plY3Rpb24tY2FjaGVgIOeahOWGmeWFpei3r+W+hOmSieWcqOS4gOi1t+OAglxuICpcbiAqICMjIOS4uuS7gOS5iOivu+ebmO+8jOiAjOS4jeaYr+mXriBhZ2VudFxuICpcbiAqIOS4ieadoe+8jOe8uuS4gOadoei/meS4quWKn+iDvemDveS4jeaIkOeri++8mlxuICogMS4gU0RLIOWNj+iurumHjCoq5rKh5pyJKirmipXlvbHor7vlj5Yg4oCU4oCUIOWug+WwsSBgaW5pdGlhbGl6ZWAgLyBgc2Vzc2lvbi9wcm9tcHRgIC8gYHNodXRkb3duYCDkuInkuKrmlrnms5XvvJtcbiAqIDIuIGBjdHgudG9rZW5NZXRlci5tZWFzdXJlKClgIOWPquaciSoq5a6/5Li76L+b56iL5YaF55qE5o+S5Lu2Kirmi7/lvpfliLDvvIzogIzpnaLmnb/kuI4gYWdlbnQg5piv5Lik5Liq6L+b56iL77ybXG4gKiAzLiDnvJPlrZjmmK8qKuaYjuaWhyBKU09OKirvvIzmiYDku6XkuLvov5vnqIvoh6rlt7EgYHJlYWRGaWxlYCDlsLHlpJ/kuoYg4oCU4oCUICoq5LiN6ZyA6KaBIHpzdGTjgIHkuZ/kuI3pnIDopoFcbiAqICAgIOWklumdoumCo+S4qiBub2RlKirvvIjlr7nmr5TvvJrkvJror53ml6Xlv5fmmK8genN0ZCDmi7zmjqXluKfvvIzlj6rog70gc3Bhd24g5LiA5LiqIE5vZGUg4omlIDIyLjE1IOWOu+ino++8ieOAglxuICpcbiAqIOmhuuW4pueahOWlveWkhO+8mioqYWdlbnQg5rKh5Zyo6LeR5Lmf6IO955yLKirvvIzlkozjgIzljoblj7LkvJror53jgI3kuIDkuKrlvoXpgYfjgIJcbiAqXG4gKiAjIyDlha3mnaHor5rlrp7lj6PlvoTvvIjpnaLmnb/kuIrlv4Xpobvor7Tlh7rmnaXvvIzkuI3orrjlj6rnlLvmlbDlrZfvvIlcbiAqXG4gKiAxLiAqKui/meaYr+ajgOafpeeCue+8jOS4jeaYr+WunuaXtueahOOAgioqIOmHjeWGmeaXtuacuuaYr+OAjOS8muivneWIm+W7uiAvIGB0dXJuL2VuZGAgLyDkvJror53plIDmr4HjgI3ov5nkuInkuKpcbiAqICAgIOW/heWGmeeCue+8jOWKoOS4iuS4pOS4quiKgua1ge+8iOacrCBwcm9maWxlIOmFjeeahOaYryoq5q+PIDIwMCDmnaHkuovku7bmiJbmr48gNSDnp5IqKu+8ieOAguaJgOS7pSBgc2VxYFxuICogICAg5Y+q5pivKirmsLTkvY0qKu+8muivu+WIsOeahOaYr+OAjOiHs+WwkeiusOWIsOesrCBgc2VxYCDmnaHkuovku7bkuLrmraLjgI3nmoTotKbjgILpnaLmnb/miormsLTkvY3kuI7jgIzokL3lkI7lpJrlsJHmnaHjgI1cbiAqICAgIOS4gOi1t+aYvuekuuWHuuadpe+8iGBiZWhpbmRg77yJ77yM5Zug5Li644CM5beu5Yeg5Y2B5p2h44CN5ZKM44CM5beu5LiA5LiH5p2h44CN5piv5a6M5YWo5LiN5ZCM55qE5Lik5Lu25LqL44CCXG4gKiAyLiAqKuWNoOeUqOeOh+eUqCBgcHJvamVjdGVkVG9rZW5zYO+8iOS4i+S4gOasoeivt+axgueahOmihOS8sO+8ie+8jOS4jeeUqCBgcHJlc3N1cmVUb2tlbnNg77yI5LiK5LiA5qyh55qE5a6e5rWL77yJ44CCKipcbiAqICAgIGBwcmVzc3VyZVRva2Vuc2Ag5pivIHByb21wdCDkvqfnmoQqKuS4iuS4gOasoSoq5a6e5rWL77yM5a6D5Zyo5rWB5byP5pyf6Ze05LiN5Yqo77yb6ICM5Y6L57yp77yIYC9jb21wYWN0YO+8iVxuICogICAg5LmL5ZCO5LiK5LiA5qyh55qE5a6e5rWL5LyaKirlgY/pq5gqKuOAguS4iua4uOWboOatpOmineWklue7tOaKpOS6huS4gOS4qiBzdXJmYWNlIOaAu+aVsO+8jOW5tuWPkeW4g1xuICogICAgYHByb2plY3RlZFRva2VucyA9IOagt+acrCArIHN1cmZhY2Ug55qE5bim56ym5Y+35L2N56e7YOOAguWFrOW8jyoq54Wn5oqEKirkuIrmuLggd2lyZSB2aWV3XG4gKiAgICDvvIhgZHNoLXRva2VuLW1ldGVyL2xpYi90eXBlcy91c2FnZS1wcm9qZWN0aW9uLmpzYO+8ie+8mlxuICogICAgYG1heCgwLCBwcmVzc3VyZVRva2VucyArIHN1cmZhY2VUb2tlbnMgLSBzYW1wbGVkU3VyZmFjZVRva2Vucylg44CCXG4gKiAgICBgc2NyaXB0cy92ZXJpZnktc3RhdHMuanNgIOmHjOacieS4gOadoeaWreiogCoq55u05o6l55uv552A5LiK5ri46YKj5q615rqQ56CBKiog4oCU4oCUIOWTquWkqeWug+aUueS6huWFrOW8j++8jFxuICogICAg6L+Z6YeM5Lya57qi77yM6ICM5LiN5piv5oKE5oKE566X6ZSZ44CCXG4gKiAzLiAqKmBjb250ZXh0QnJlYWtkb3duYCDmmK/kvLDnrpfvvIzogIzkuJTlroPkuI3nrYnkuo7ljaDnlKjnjofpgqPkuIDmnaHjgIIqKiDkuIrmuLggUkVBRE1FIOaYjuivtOWug+aMiVxuICogICAg44CM5Zub5a2X56ym5LiA5LiqIHRva2Vu44CN5a6a5Lu377yM5Lit5paH5LiOIEpTT04gc2NoZW1hIOS8muaYjuaYvuS9juS8sO+8jOS4ieihjOWKoOi1t+adpSoq5a+55LiN5LiKKipcbiAqICAgIGBwcm9qZWN0ZWRUb2tlbnNg44CC5omA5Lul6Z2i5p2/5LiK5a6D5Y2V54us5LiA5Z2X44CB5qCH44CM5Lyw566X44CN44CBKirkuI3lj4LkuI4qKumCo+adoeWNoOeUqOadoeOAglxuICogNC4gKiroirHotLnopoHor7vkuKTkuKrmlofku7bvvIzogIzkuJTph5Hpop3nmoTljZXkvY3kuI3mmK/pnaLmnb/or7TkuobnrpfjgIIqKlxuICogICAg6YeR6aKd5p2l6Ieq5oqV5b2x57yT5a2Y6YKj5LiA6KGM77yIYGNvc3RVc2FnZS50b3RhbHMuY29zdGDvvInvvIzlroMqKuaBkuS7pee+juWFg+WFpei0pioqXG4gKiAgICDvvIjkuIrmuLggYHVzZEZyb21Db3N0YCDnmoTms6jph4rvvJrjgIzotKbmnKzmgZLku6Xnvo7lhYPlrZjlgqjjgI3vvInvvJvmmL7npLrmiJAgYMKlYCDov5jmmK8gYCRg44CB5oyJ5LuA5LmI5rGH546H5oqY44CBXG4gKiAgICDnlZnlh6DkvY3lsI/mlbAg4oCU4oCUIOWFqOWcqCBgZHNoLWNvc3QtbWV0ZXJgIOeahCoq6LSm5pysKipcbiAqICAgIO+8iGA8RFNIX0hPTUU+L3N0b3JhZ2VzL2Nvc3QtbWV0ZXIvbGVkZ2VyLmpzb25gIOeahCBgY29uZmlnYO+8iemHjOOAglxuICogICAg5omA5Lul6L+Z5LiA5Lu96K+755uY5LyaKirpobrmiYvor7vnrKzkuozkuKrmlofku7YqKu+8iOivu+S4jeWIsOS4jeW9seWTjeeUqOmHj+mCo+WNiu+8jOWPquaYr+aMiee+juWFg+WOn+WAvOeUu+W5tuivtOWHuuadpe+8ieOAglxuICogICAg5Lik6L656YO95pyJ6YeR6aKd5pe25LulKirmipXlvbHnvJPlrZgqKuS4uuWHhu+8iOS4juaKveWxiemHjOWFtuWug+ihjOWQjOS4gOS4quadpei3r++8ie+8jOi0puacrOmCo+S4gOS7veWPqueUqOadpVxuICogICAgKirlr7notKYqKu+8iOW3ruW+l+aYjuaYvuWwseeFp+WunuivtO+8jOingSBgY29zdExlZGdlck5vdGVg77yJ5LiOKirlhZzlupUqKu+8iOiAgeS8muivneeahOajgOafpeeCuemHjOayoeaciei/meS4gOihjO+8ieOAglxuICogICAg5pyA5ZCO5LiA5p2h77yaYGNvc3RgIOS4uiBudWxsIOeahOaEj+aAneaYryoq6L+Z5LiA6KGM5LiN5a2Y5ZyoKirvvIjogIHkvJror50gLyDliKvnmoQgcHJvZmlsZSAvIOi/mOayoeWGmei/h+ajgOafpeeCue+8ie+8jFxuICogICAgKirkuI3mmK8qKuOAjOayoeiKsemSseOAjeKAlOKAlCDmiYDku6XpnaLmnb/kuIrnu53kuI3nlLsgYCQwLjAwMDBg44CCXG4gKlxuICogICAg4pqgICoq5pysIHByb2ZpbGUg546w5Zyo5LiN5oyCIGBkc2gtY29zdC1tZXRlcmAqKu+8iDIwMjYtMTIg55qE5Yaz5a6a77ya6Zu256ys5LiJ5pa5IGJ1bmRsZSDigJTigJRcbiAqICAgIGBidW5kbGVzYCDph4zlo7DmmI7kuobljbTmsqHoo4XkvJrorqkqKuaVtOajteagkei1t+S4jeadpSoq77yM5Luj5Lu36L+c5aSn5LqOXCLlsJHkuIDlnZflip/og71cIu+8ieOAglxuICogICAg5omA5Lul6L+Z5LiA6KGM5ZyoKirmlrDkvJror50qKuS4iuWfuuacrOS4jeS8muWHuueOsO+8m+S9huivu+WPluWZqOeFp+aXp+WFqOWKn+iDve+8muiwgeijheS6huWug+OAgeaIluiAheaMguedgOWug+i3kei/h+eahFxuICogICAg6ICB5Lya6K+d77yI5qOA5p+l54K56YeM5bey57uP5pyJ6L+Z5LiA6KGM77yJ77yM6Z2i5p2/5bCx54Wn5pen55S777yMKirkuIDlpITpg73kuI3nlKjmlLkqKuOAglxuICogICAg57y65LqG5a6D5pe26Z2i5p2/6K+055qE5piv44CM5pysIHByb2ZpbGUg5Yi75oSP5rKh5oyCICsg5oOz55So5oCO5LmI5Yqg5Zue5p2l44CN77yI5o6q6L6e5ZyoIGBjb3N0LnRzYO+8ieOAglxuICogNS4gKirov5vluqbpgqPkuInlnZfvvIznvJPlrZjnu5nnmoTlkozkuovku7bnu5nnmoTkuI3mmK/kuIDlm57kuosqKu+8iOa4heWNlSAvIOebruaghyAvIOWbnuWQiOWkp+e6su+8ieOAglxuICogICAg6L+Z5LiA5Lu96K+755qE5pivKirmlbTkuKrml6Xlv5cqKuaKmOWHuuadpeeahO+8jOaJgOS7peWug+aciemdouadv+i9rOWGmemHjCoq5qC55pys5rKh5pyJKirnmoTkuJzopb9cbiAqICAgIO+8iOmdouadv+WPqueVmeacgOi/kSA2MDAg5p2h5p2h55uu44CB5Y6G5Y+y5Zue5pS+5Y+q6K+75pel5b+X5bC+6YOoIDIwMDAg5p2h5LqL5Lu2IOKGkiDmm7Tml6nnmoTova7mrKHlnKjpnaLmnb/kuIpcbiAqICAgIOi/nuW9seWtkOmDveayoeacie+8jOiAjCBgdHVybk91dGxpbmVgIOmHjCAzMCDova7kuIDmnaHkuI3lsJHvvInjgILku6Pku7flsLHmmK/lroMqKuaXpyoq77ya57yT5a2Y5pSS5aSfIDIwMCDmnaFcbiAqICAgIOS6i+S7tuaIliA1IOenkuaJjeWGmeS4gOasoe+8jOaJgOS7pea4heWNleWPr+iDveavlOmdouadv+S4iuecn+WunuWPkeeUn+eahOS6i+aFouWHoOenkuOAglxuICogICAg5YiG5bel5YaZ5ZyoIGBjb25zdGFudHMudHNgIOeahOi/m+W6pumCo+S4gOaute+8mioq5LqL5Lu25LyY5YWI44CB57yT5a2Y6KGl5rSeKirvvIjlkIjlubbnlLHlrr/kuLvlgZrvvInjgIJcbiAqICAgIOi/meS4gOS7vei/mOi0n+i0o+S4gOS7tuS6i++8mioqYHRvZG9zYCDnmoTmipXlvbHlj6PlvoTmmK/jgIzmr4/kuIDmrKEgYHR1cm4vc3RhcnRgIOW9kumbtuOAjSoqXG4gKiAgICDvvIjop4EgYGRzaC10b29sLXRvZG9gIOeahCBgYXBwbHlg77yJ77yM5omA5Lul6K+75Yiw55qEIGBudWxsYCDmnInkuKTnp43mhI/mgJ0g4oCU4oCUXG4gKiAgICDjgIzmnKzova7ov5jmsqHlhpnov4fjgI3lkozjgIzku47mnaXmsqHlhpnov4fjgI3jgILlrr/kuLvmi7/lrp7ml7bkuovku7bph4znmoTova7mrKHlj7fliIbovqjov5nkuKTogIXvvIxcbiAqICAgIOmdouadv+S4iuW/hemhu+ivtOa4healmu+8iOaKiuS4iuS4gOi9rueahOihqOW9k+aIkOi/meS4gOi9ruWcqOWBmueahOS6i++8jOWwseaYr+eci+adv+WcqOaSkuiwju+8ieOAglxuICogNi4gKirkuIrkuIvmloflop7plb/mm7Lnur/vvJrkuLvmm7Lnur/nlKjjgIzlrp7mtYvjgI3vvIzkvYblrp7mtYvkuI7kvLDnrpflt67nnYDkuIDlpKfmiKrvvIzogIzkuJTov5nkuIDooYzkuI3mmK/miJHku6zmjILnmoTjgIIqKlxuICogICAg5LiJ5Lu25LqL6KaB5LiA6LW36K+077yaXG4gKiAgICDikaAgKipgcmVxdWVzdHNbXS5wcm9tcHRgIOaYryBwcm92aWRlciDlrp7mtYsqKu+8iGlucHV0ICsgY2FjaGVSZWFkICsgY2FjaGVXcml0Ze+8ie+8jOiAjFxuICogICAgYHJlcXVlc3RzW10ue3N5c3RlbSx0b29scyx1c2VyLGluamVjdCxhc3Npc3RhbnQsdG9vbCx0b3RhbH1gIOaYryoq5Lyw566XKirvvIjkuIrmuLjmjIlcbiAqICAgIOOAjOWbm+Wtl+espuS4gOS4qiB0b2tlbuOAjeWumuS7t++8ieOAguacrOacuuecn+aVsOaNru+8iDQ3MCDku73nvJPlrZggLyA0MDQyNyDmnaHor7fmsYLvvInph4wgYHByb21wdCAvIHRvdGFsYFxuICogICAg55qEIG1pbiAwLjg444CBKirkuK3kvY0gMS4zNCoq44CBcDk1IDEuNjPjgIFtYXggMi42OSDigJTigJQg5omA5LulKirlj6rnlLsgYHRvdGFsYCDkvJrorqnkurrku6XkuLrkuIrkuIvmlodcbiAqICAgIOWNoOeUqOi/nOS9juS6juecn+Wunioq77yI5pyA5Z2P5L2O5Lyw5YiwIDEvMi4377yJ44CC5Li75puy57q/5Y+WIGBwcm9tcHRg77yM57y65LqG5omN5Zue6JC95YiwIGB0b3RhbGDvvIxcbiAqICAgIOW5tuS4lOaKiuWbnuiQveeahOmCo+WHoOaguSoq5qCH5oiQ5Lyw566XKirvvIjpnaLmnb/nlLvmlpznurnvvInjgIJcbiAqICAgIOKRoSAqKuazqOWGjOiAheaYr+esrOS4ieaWuSBgZHNoLWNvbnRleHRg77yM5pysIHByb2ZpbGUg5LiN5oyC5a6DKirvvIhgZHNoLXByb2ZpbGUvcGFja2FnZS5qc29uYCDph4zpm7ZcbiAqICAgIOesrOS4ieaWuSBidW5kbGXvvInigJTigJQg5omA5Lul44CM5rKh5pyJ6L+Z5LiA6KGM44CN5pivKirluLjmgIHot6/lvoQqKu+8jOS4jeaYr+ivu+Wksei0pe+8m+aOqui+nuS4juiKsei0uemCo+S4gOihjOWQjOS4gOWll+OAglxuICogICAgYHZlcmAg5Y+q6K6kICoqMTMqKu+8muS4jeWMuemFjeWwsSoq5Lii5o6J5pW06KGMKirvvIjmoYbmnrblj6PlvoTmmK/ku47ml6Xlv5flhrfmipjlj6DjgIEqKuS7juS4jei/geenuyoq77yJ77yMXG4gKiAgICDpnaLmnb/lpoLlrp7lhpnjgIzov5nkuIDooYznmoTniYjmnKzmmK8gTu+8jOacrOivu+WPluWZqOWPquiupCAxM+OAje+8m+WUr+S4gOeahOS+i+WkluaYryBgdmVyID09PSAxYCArIGB2YWxgIOaYr+epuuWvueixoe+8jFxuICogICAg6YKj5piv6YKj5Liq5o+S5Lu25ZyoKirlrr/kuLvkvY7kuo7lroPnmoTln7rnur8qKuaXtuazqOWGjOeahOmZjee6p+WNoOS9jeOAglxuICogICAg4pGiICoq5Y6L57yp54K56KaB5ZCI5bm244CB6IGa5ZCI5LiN6K645Y+W5bmz5Z2HKirvvJpgZXZlbnRzW11gIOmHjCBga2luZGAg5pivIGBjb21wYWN0aW9uYCAvIGBwcnVuZWAg55qE77yMXG4gKiAgICDmjInkuIrmuLggd2lyZSB2aWV3IOeahOinhOWImemSieWIsCoq5a6D5LmL5ZCO55qE56ys5LiA5p2hIHJlcXVlc3QqKiDkuIrvvJvogIwgYHBydW5lYCDkvJoqKui/nuWPkSoqXG4gKiAgICDvvIjmnKzmnLrnnJ/mlbDmja7ph4zmnInkuIDmnaHkvJror50gNTJtcyDlhoXov57lj5EgNyDmnaHlsI8gcHJ1bmXjgIEzLjAg56eS5ZCO5omN5piv5LiA5p2h5aSnIGNvbXBhY3Rpb27vvInigJTigJRcbiAqICAgIOS4jeWQiOW5tueahOivneWQjOS4gOagueafseS4iuS8mueziuaIkOS4gOeJh+OAguinhOaooeS4iiBgcmVxdWVzdHNgIOS4reS9jSAzNyDmnaHjgIFwOTUgMzIy44CBKiptYXggMTUwMCoqXG4gKiAgICDvvIjmkp7lrr/kuLvnmoQgYG1heFJlcXVlc3RTdGVwc2DvvInvvIzotoXov4fpmIjlgLzmjIkqKuWbnuWQiCoq6IGa5ZCI44CB5Y+W6K+l5Zue5ZCIKirmnIDlkI7kuIDmraUqKu+8jFxuICogICAgKirnu53kuI3lj5blubPlnYflgLwqKu+8iOW5s+Wdh+S8muaKiuWOi+e8qeaOieeahOmCo+S4gOaIquaKueW5s++8jOiAjOmCo+ato+aYr+i/meW8oOWbvuWtmOWcqOeahOeQhueUse+8ieOAglxuICovXG5cbmltcG9ydCB7IHJlYWRGaWxlLCBzdGF0IH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ29zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHR5cGUge1xuICAgIENvbnRleHRUaW1lbGluZVZpZXcsXG4gICAgQ29zdERpc3BsYXksXG4gICAgQ29zdExlZGdlclZpZXcsXG4gICAgR29hbFZpZXcsXG4gICAgU2Vzc2lvblByb2dyZXNzLFxuICAgIFNlc3Npb25Vc2FnZSxcbiAgICBUaW1lbGluZUN1dFZpZXcsXG4gICAgVGltZWxpbmVQb2ludFZpZXcsXG4gICAgVG9kb1N0YXR1cyxcbiAgICBUb2RvVmlldyxcbiAgICBUdXJuVmlldyxcbiAgICBVc2FnZUJ1Y2tldHMsXG59IGZyb20gJy4vY29uc3RhbnRzJztcbmltcG9ydCB7XG4gICAgQ09OVEVYVF9USU1FTElORV9GQUxMQkFDS19WRVJTSU9OLFxuICAgIENPTlRFWFRfVElNRUxJTkVfTUFYX0JBUlMsXG4gICAgQ09OVEVYVF9USU1FTElORV9TVEFURV9WRVJTSU9OLFxuICAgIGNvbnRleHRUaW1lbGluZUJhc2VsaW5lTm90ZSxcbiAgICBjb250ZXh0VGltZWxpbmVFbXB0eU5vdGUsXG4gICAgY29udGV4dFRpbWVsaW5lVmVyc2lvbk5vdGUsXG59IGZyb20gJy4vY29uc3RhbnRzJztcblxuLyoqXG4gKiDimqAgKirnsbvlnovlo7DmmI7lnKggYGNvbnN0YW50cy50c2AqKu+8iOmCo+aYr+WFqOaJqeWxleWFseS6q+eahOmCo+S4gOS7ve+8ie+8jOi/memHjOWPquWBmui9rOWHuuOAglxuICpcbiAqIOS4uuS7gOS5iOS4jeWcqOi/memHjOWjsOaYju+8mumdouadv+imgeeUu+eahOWwseaYr+i/meWHoOS4quWtl+aute+8jOS4pOi+ueWQhOWGmeS4gOS7veW/heeEtua8guenu1xuICog77yI6Z2i5p2/5bCR6K6k5LiA5Liq5a2X5q61ID0g6YKj5LiA6KGM5rC46L+c5LiN5pi+56S677yM6ICM5LiU5rKh5Lq65Lya5Y+R546w77yJ44CCXG4gKiBgaW1wb3J0IHR5cGVgIOe8luivkeWQjuS8muiiq+WujOWFqOaTpuaOie+8jOaJgOS7pemdouadv+mCo+i+ueS4jeS8muWboOS4uui/meadoSBpbXBvcnQg6ICM5ouW6L+bIGBmc2DjgIJcbiAqL1xuZXhwb3J0IHR5cGUge1xuICAgIENvbnRleHRUaW1lbGluZVZpZXcsXG4gICAgQ29zdERpc3BsYXksXG4gICAgQ29zdExlZGdlclZpZXcsXG4gICAgR29hbFZpZXcsXG4gICAgU2Vzc2lvblByb2dyZXNzLFxuICAgIFNlc3Npb25Vc2FnZSxcbiAgICBUaW1lbGluZUN1dFZpZXcsXG4gICAgVGltZWxpbmVQb2ludFZpZXcsXG4gICAgVG9kb1N0YXR1cyxcbiAgICBUb2RvVmlldyxcbiAgICBUdXJuVmlldyxcbiAgICBVc2FnZUJ1Y2tldHMsXG59O1xuXG4vKiog6K6k5b6X55qEKirmlofmoaMqKuagvOW8j+eJiOacrO+8iGByZWNvcmQudmVyc2lvbmDvvInvvJvorqTkuI3lh7rkuZ/nhafor7vvvIzlj6rmmK/kvJrliqDkuIDmnaEgbm90ZXPjgIIgKi9cbmNvbnN0IEtOT1dOX1JFQ09SRF9WRVJTSU9OUyA9IG5ldyBTZXQoWzVdKTtcblxuLyoqXG4gKiDkvJror50gaWQg55qE5a6J5YWo55m95ZCN5Y2V44CCXG4gKlxuICogaWQg5Lya5ou86L+b5paH5Lu26Lev5b6E77yM5omA5Lul5Y+q5pS+6KGMIGBbQS1aYS16MC05Ll8tXWDvvIzlubbkuJTmmL7lvI/mi5LmjokgYC5gIC8gYC4uYFxuICog77yI5Y+j5b6E5LiOIGBzY3JpcHRzL3Nlc3Npb24tbG9nLmpzYCDnmoQgYHNhZmVOYW1lT2ZgIOS4gOiHtCDigJTigJQg5Lik5aSE6YO95oyh77yM6LCB6KKr5pS55Z2P5LqG6YO96L+Y5pyJ5LiA5bGC77yJ44CCXG4gKi9cbmNvbnN0IFNBRkVfSUQgPSAvXltBLVphLXowLTkuXy1dezEsMTI4fSQvO1xuXG4vKiog6K+75LiA5Lu955So6YeP55qE57uT5p6c77yI5aSx6LSl5LiN5oqb77yM6K6p6Z2i5p2/6IO95pi+56S65Y6f5Zug77yJ44CCICovXG5leHBvcnQgaW50ZXJmYWNlIFNlc3Npb25Vc2FnZVJlc3VsdCB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgdXNhZ2U/OiBTZXNzaW9uVXNhZ2U7XG4gICAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8qKlxuICog5LiA5qyh6K+755uY55qE57uT5p6c77yaKirlkIzkuIDku73mlofku7YqKumHjOeahOeUqOmHj+S4jui/m+W6puOAglxuICpcbiAqIOS4uuS7gOS5iOaKiuS4pOiAheaUvuWcqOS4gOasoeivu+mHjO+8muWug+S7rOWcqOWQjOS4gOS7vSBKU09OIOmHjO+8iOS4gOS4quS8muivneS4gOS4quaWh+S7tu+8jOWkp+eahOiDveWIsCA0MDArIEtC77yJ77yMXG4gKiDliIbkuKTmrKHor7vlsLHmmK/miorlkIzkuIDku73mlofku7bop6PmnpDkuKTpgY3vvJvogIzkuJTkuKTlnZfnmoTjgIzmsLTkvY0gLyDokL3lkI7lpJrlsJEgLyDlhpnkuo7kvZXml7bjgI3mnKzmnaXlsLHmmK9cbiAqIOWQjOS4gOe7hOS6i+Wunu+8jOWIhuW8gOivu+S8muWHuueOsOOAjOeUqOmHj+ivtOiQveWQjiAxMiDmnaHjgIHov5vluqbor7TokL3lkI4gMyDmnaHjgI3ov5nnp43oh6rnm7jnn5vnm77nmoTnlLvpnaLjgIJcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uQ2FjaGVSZXN1bHQge1xuICAgIG9rOiBib29sZWFuO1xuICAgIHVzYWdlPzogU2Vzc2lvblVzYWdlO1xuICAgIHByb2dyZXNzPzogU2Vzc2lvblByb2dyZXNzO1xuICAgIGVycm9yPzogc3RyaW5nO1xufVxuXG4vKiog6K+76L+b5bqm6YKj5LiA5Lu955qE57uT5p6c77yIYG5vdGVzYCDmmK/or7vnmoTml7blgJnlj5HnjrDnmoTlj6PlvoTpl67popjvvIzpnaLmnb/ljp/moLfmmL7npLrvvInjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvblByb2dyZXNzUmVzdWx0IHtcbiAgICBwcm9ncmVzczogU2Vzc2lvblByb2dyZXNzO1xuICAgIG5vdGVzOiBzdHJpbmdbXTtcbn1cblxuLyoqIOmdouadv+S4iuS4gOasoeeUu+WkmuWwkei9ru+8iOWGjeWkmuS5n+ayoeS6uuW+gOS4i+e/u++8jOiAjOavj+adoemDveW4puS4pOauteaWh+acrO+8ieOAgiAqL1xuY29uc3QgTUFYX09VVExJTkVfVFVSTlMgPSA4MDtcblxuLyoqXG4gKiDljZXmnaHmlofmnKznmoTmmL7npLrkuIrpmZDvvIjotoXkuobmiKrmlq3lubYqKuaYvuW8j+WKoOecgeeVpeWPtyoqIOKAlOKAlCDnoazliIfkuIDliIDkuI3mj5DlsLHmmK/pqpfkurrvvInjgIJcbiAqXG4gKiDimqAg6L+Z5LiJ5Liq5pWwKirlnKjmnKzmnLrnnJ/mlbDmja7kuIrmsLjov5zkuI3kvJrop6blj5EqKu+8muS4iua4uOiHquW3seW3sue7j+ijgei/h+S4gOi9rlxuICog77yI5Zue5ZCI5aSn57qy55qEIHByb21wdCDiiaQgNTAg5a2X56ym44CBcmVzcG9uc2Ug4omkIDEyMCDlrZfnrKbvvIzop4EgYGRzaC1zZXNzaW9uLXR1cm4tb3V0bGluZWBcbiAqIOeahCBgUFJPTVBUX1BSRVZJRVdfTElNSVRgIC8gYFJFU1BPTlNFX1BSRVZJRVdfTElNSVRg77yJ77yM5riF5Y2V5p2h55uu5a6e5rWL5pyA6ZW/IDE1MiDlrZfnrKbjgIJcbiAqIOWug+S7rOaYryoq5a6I5Y2rKirvvJrlk6rlpKnkuIrmuLjmiorkuIrpmZDmlL7lvIDjgIHmiJbogIXmuIXljZXmnaHnm67lj5jmiJDkuIDmlbTmrrXvvIzpnaLmnb/kuI3kvJrooqvkuIDkuKpcbiAqIOWNgeS4h+Wtl+espueahOadoeebruaSkeeIhu+8iOiAjOaIquaWrei/meS7tuS6i+acrOi6q+aYr+eci+W+l+ingeeahOecgeeVpeWPt++8ieOAglxuICovXG5jb25zdCBUT0RPX1RFWFRfTElNSVQgPSAzMDA7XG5jb25zdCBQUk9NUFRfVEVYVF9MSU1JVCA9IDIwMDtcbmNvbnN0IFJFU1BPTlNFX1RFWFRfTElNSVQgPSA0MDA7XG5cbi8qKiDmuIXljZXnirbmgIHnmoTnmb3lkI3ljZXvvIjpgJDlrZflr7nlupQgRFNIIOeahCBgVG9kb0l0ZW0uc3RhdHVzYO+8ieOAgiAqL1xuY29uc3QgVE9ET19TVEFUVVNFUyA9IG5ldyBTZXQ8c3RyaW5nPihbJ3BlbmRpbmcnLCAnaW5fcHJvZ3Jlc3MnLCAnY29tcGxldGVkJ10pO1xuXG4vKiog55uu5qCH6Zi25q6155qE55m95ZCN5Y2V77yI6YCQ5a2X5a+55bqUIERTSCDnmoQgYEdvYWxQaGFzZWDvvInjgIIgKi9cbmNvbnN0IEdPQUxfUEhBU0VTID0gbmV3IFNldDxzdHJpbmc+KFsnYWN0aXZlJywgJ3BhdXNlZCcsICdibG9ja2VkJywgJ2NvbXBsZXRlJ10pO1xuXG4vKipcbiAqIGA8RFNIX0hPTUU+YO+8iGBEU0hfSE9NRWAg5rKh6K6+5bCx5oyJIGB+Ly5kc2hg77yJ44CCXG4gKlxuICog4pqgIOWPo+W+hOW/hemhu+S4jiBgaGlzdG9yeS50c2Ag55qEIGBzZXNzaW9uc1Jvb3QoKWAg5LiA6Ie0IOKAlOKAlCDpgqPovrnkuZ/mmK/ov5nkuYjnrpfnmoTjgIJcbiAqIOS4pOWkhOmDveaLvOWQjOS4gOS4quWtl+espuS4su+8jGBzY3JpcHRzL3ZlcmlmeS1zdGF0cy5qc2Ag5pyJ5LiA5p2h5pat6KiA5oqK5Lik6ICF6ZKJ5Zyo5LiA6LW344CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkc2hIb21lKCk6IHN0cmluZyB7XG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkRTSF9IT01FPy50cmltKCk7XG4gICAgcmV0dXJuIGhvbWUgJiYgaG9tZSAhPT0gJycgPyBob21lIDogam9pbihob21lZGlyKCksICcuZHNoJyk7XG59XG5cbi8qKiDmipXlvbHnvJPlrZjnmoTkvJror53orrDlvZXnm67lvZXvvJpgPERTSF9IT01FPi9zdG9yYWdlcy9zZXNzaW9uX3Byb2pjYWNoZS9zZXNzaW9uc2DjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0aW9uUm9vdCgpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKGRzaEhvbWUoKSwgJ3N0b3JhZ2VzJywgJ3Nlc3Npb25fcHJvamNhY2hlJywgJ3Nlc3Npb25zJyk7XG59XG5cbi8qKiDkuIDmnaHkvJror53nmoTnvJPlrZjorrDlvZXot6/lvoTjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZVJlY29yZFBhdGgoc2Vzc2lvbklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHByb2plY3Rpb25Sb290KCksIGAke3Nlc3Npb25JZH0uanNvbmApO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWPluWAvOWwj+W3peWFt1xuLy9cbi8vIOe8k+WtmOmHjOeahOaVsOWtl+adpeiHqioq5Yir55qE6L+b56iLKirvvIzlvaLnirbpmo/kuIrmuLjniYjmnKzlj5jjgILmiYDku6Xov5nph4zkuIDlvovjgIzorqTlvpflh7rlsLHnlKjjgIFcbi8vIOiupOS4jeWHuuWwseW9k+ayoeacieOAje+8jOe7neS4jSBgYXMgbnVtYmVyYCDnoazovawg4oCU4oCUIOS4gOS4qiBOYU4g55S75Yiw6Z2i5p2/5LiK5bCx5piv5LiA5p2h6aqX5Lq655qE6L+b5bqm5p2h44CCXG5cbi8qKiDpnZ7otJ/mnInpmZDmlbDmiY3orqTvvIhgdW5kZWZpbmVkYCAvIGBudWxsYCAvIGBOYU5gIC8g6LSf5pWwIC8g5a2X56ym5Liy5LiA5b6LIG51bGzvvInjgIIgKi9cbmZ1bmN0aW9uIG51bSh2YWx1ZTogdW5rbm93bik6IG51bWJlciB8IG51bGwge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPj0gMCA/IHZhbHVlIDogbnVsbDtcbn1cblxuLyoqIOato+aVtOaVsOaJjeiupO+8iOeql+WPo+S4iumZkOi/meexu++8ieOAgiAqL1xuZnVuY3Rpb24gcG9zaXRpdmUodmFsdWU6IHVua25vd24pOiBudW1iZXIgfCBudWxsIHtcbiAgICBjb25zdCB2YWx1ZTIgPSBudW0odmFsdWUpO1xuICAgIHJldHVybiB2YWx1ZTIgIT09IG51bGwgJiYgdmFsdWUyID4gMCA/IHZhbHVlMiA6IG51bGw7XG59XG5cbi8qKiDlrZfnrKbkuLLmiY3orqTvvIh0cmltIOWQjumdnuepuu+8ieOAgiAqL1xuZnVuY3Rpb24gc3RyKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpICE9PSAnJyA/IHZhbHVlLnRyaW0oKSA6IG51bGw7XG59XG5cbi8qKiDnuq/lr7nosaHmiY3orqTvvIjmlbDnu4TjgIFudWxs44CB5qCH6YeP5LiA5b6L5LiN566X77yJ4oCU4oCUIOivu+WIq+WutueahCBKU09OIOaXtuWIsOWkhOmDveimgei/meS4gOWPpeOAgiAqL1xuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuXG4vKipcbiAqIOS7jiBgcmVjb3JkLnJvd3NgIOmHjOWPluS4gOihjOeahCBgdmFsYO+8iCoq5Y6f5qC3KirvvIzmlbDnu4TkuZ/nhafnu5nvvInjgIJcbiAqXG4gKiDimqAg5LiOIGByb3dWYWx1ZWAg55qE5Yy65Yir5b6I6YeN6KaB77yaYHRvZG9zYCDpgqPkuIDooYznmoTnirbmgIEqKuacrOi6q+WwseaYr+aVsOe7hCoq77yMXG4gKiDnlKjlj6rorqTlr7nosaHnmoQgYHJvd1ZhbHVlYCDor7vlroPvvIzor7vliLDnmoTmsLjov5zmmK8gYG51bGxgIOKAlOKAlCDogIzkuJTkuI3miqXplJnvvIxcbiAqIOihqOeOsOS4uuOAjOi/meS4quS8muivneS7juadpeayoeaciea4heWNleOAje+8iOWFtuWunuaYr+acieeahO+8ieOAgui/meS4gOWvueWHveaVsOWwseaYr+S4uui/meS7tuS6i+WIhuWutueahOOAglxuICovXG5mdW5jdGlvbiByb3dWYWwocm93czogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGtleTogc3RyaW5nKTogdW5rbm93biB7XG4gICAgY29uc3Qgcm93ID0gcm93c1trZXldO1xuICAgIGlmICghcm93IHx8IHR5cGVvZiByb3cgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocm93KSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4gKHJvdyBhcyB7IHZhbD86IHVua25vd24gfSkudmFsO1xufVxuXG4vKiog5LuOIGByZWNvcmQucm93c2Ag6YeM5Y+W5LiA6KGM55qEIGB2YWxg77yMKirlj6rorqTlr7nosaEqKu+8iOeUqOmHj+mCo+WHoOihjOmDveaYr+Wvueixoe+8ieOAgiAqL1xuZnVuY3Rpb24gcm93VmFsdWUocm93czogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGtleTogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgICBjb25zdCB2YWx1ZSA9IHJvd1ZhbChyb3dzLCBrZXkpO1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vKiog5Y+WIGByZWNvcmQucm93c2Ag6YeM5Ye6546w6L+H55qEKirmnIDlpKcqKiBgc2VxYO+8iD0g6L+Z5Lu96K6w5b2V55qE5rC05L2N77yJ44CCICovXG5mdW5jdGlvbiB3YXRlcm1hcmtPZihyb3dzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlciB8IG51bGwge1xuICAgIGxldCBiZXN0OiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBPYmplY3QudmFsdWVzKHJvd3MpKSB7XG4gICAgICAgIGlmICghcm93IHx8IHR5cGVvZiByb3cgIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgc2VxID0gbnVtKChyb3cgYXMgeyBzZXE/OiB1bmtub3duIH0pLnNlcSk7XG4gICAgICAgIGlmIChzZXEgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgICAgICBiZXN0ID0gYmVzdCA9PT0gbnVsbCA/IHNlcSA6IE1hdGgubWF4KGJlc3QsIHNlcSk7XG4gICAgfVxuICAgIHJldHVybiBiZXN0O1xufVxuXG4vKiog5Zub5Liq5qG277yb5Zub5Liq6YO95LiN5piv5pWw5bCx5b2T5rKh5pyJ44CCICovXG5mdW5jdGlvbiBidWNrZXRzT2YodmFsdWU6IHVua25vd24pOiBVc2FnZUJ1Y2tldHMgfCBudWxsIHtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHJhdyA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IGlucHV0ID0gbnVtKHJhdy5pbnB1dCkgPz8gbnVtKHJhdy51bmNhY2hlZElucHV0VG9rZW5zKTtcbiAgICBjb25zdCBvdXRwdXQgPSBudW0ocmF3Lm91dHB1dCkgPz8gbnVtKHJhdy5vdXRwdXRUb2tlbnMpO1xuICAgIGNvbnN0IGNhY2hlUmVhZCA9IG51bShyYXcuY2FjaGVSZWFkKSA/PyBudW0ocmF3LmNhY2hlUmVhZFRva2Vucyk7XG4gICAgY29uc3QgY2FjaGVXcml0ZSA9IG51bShyYXcuY2FjaGVXcml0ZSkgPz8gbnVtKHJhdy5jYWNoZVdyaXRlVG9rZW5zKTtcbiAgICBpZiAoaW5wdXQgPT09IG51bGwgJiYgb3V0cHV0ID09PSBudWxsICYmIGNhY2hlUmVhZCA9PT0gbnVsbCAmJiBjYWNoZVdyaXRlID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4geyBpbnB1dDogaW5wdXQgPz8gMCwgb3V0cHV0OiBvdXRwdXQgPz8gMCwgY2FjaGVSZWFkOiBjYWNoZVJlYWQgPz8gMCwgY2FjaGVXcml0ZTogY2FjaGVXcml0ZSA/PyAwIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5b2S5LiA5YyWXG5cbi8qKlxuICog5LuO5pW05Lu95paH5qGj6YeM5Y+W5Ye6IGByZWNvcmQucm93c2DvvIgqKueUqOmHj+S4jui/m+W6puWFseeUqOeahOesrOS4gOmBk+mXqCoq77yJ44CCXG4gKlxuICog5LiJ56eN44CM5b2i54q25LiN5a+544CN5ZCE6Ieq5pyJ5ZCE6Ieq55qE6K+dIOKAlOKAlCDpnaLmnb/kuIrov5nkuInlj6Xor53lrozlhajkuI3lkIzvvJrmlofku7blnY/kuobjgIFEU0gg5o2i5LqG5qC85byP44CBXG4gKiDmiJbogIXov5nku73orrDlvZXmnKzmnaXlsLHmmK/nqbrnmoTjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJvd3NPZihyYXc6IHVua25vd24pOiB7IHJvd3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0gfCB7IGVycm9yOiBzdHJpbmcgfSB7XG4gICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgICAgIHJldHVybiB7IGVycm9yOiAn5oqV5b2x57yT5a2Y55qE6K6w5b2V5LiN5piv5LiA5Liq5a+56LGhJyB9O1xuICAgIH1cbiAgICBjb25zdCByZWNvcmQgPSAocmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5yZWNvcmQ7XG4gICAgaWYgKCFyZWNvcmQgfHwgdHlwZW9mIHJlY29yZCAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyZWNvcmQpKSB7XG4gICAgICAgIHJldHVybiB7IGVycm9yOiAn5oqV5b2x57yT5a2Y55qE6K6w5b2V6YeM5rKh5pyJIHJlY29yZCDlrZfmrrUnIH07XG4gICAgfVxuICAgIGNvbnN0IHJvd3NSYXcgPSAocmVjb3JkIGFzIHsgcm93cz86IHVua25vd24gfSkucm93cztcbiAgICBpZiAoIXJvd3NSYXcgfHwgdHlwZW9mIHJvd3NSYXcgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocm93c1JhdykpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICfmipXlvbHnvJPlrZjnmoTorrDlvZXph4zmsqHmnIkgcmVjb3JkLnJvd3PvvIhEU0gg55qE57yT5a2Y5qC85byP5Y+Y5LqG77yf77yJJyB9O1xuICAgIH1cbiAgICByZXR1cm4geyByb3dzOiByb3dzUmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IH07XG59XG5cbi8qKiDmiKrmlq3lubbmmL7lvI/liqDnnIHnlaXlj7fvvIjkuI3ov5nkuYjlubLlsLHmmK/lnKjml6Dlo7DlnLDmlLnlhoXlrrnvvInjgIIgKi9cbmZ1bmN0aW9uIGN1dCh0ZXh0OiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBzdHJpbmcge1xuICAgIHJldHVybiB0ZXh0Lmxlbmd0aCA+IGxpbWl0ID8gYCR7dGV4dC5zbGljZSgwLCBsaW1pdCl94oCmYCA6IHRleHQ7XG59XG5cbi8qKiBgc3RyKClgIOeahOaVsOe7hOeJiOacrO+8muaKiuS4gOmhuemHjOeahOWtl+espuS4suWtl+auteWPluWHuuadpe+8jOiupOS4jeWHuuWwsSBudWxs44CCICovXG5mdW5jdGlvbiBmaWVsZCh2YWx1ZTogdW5rbm93biwga2V5OiBzdHJpbmcpOiB1bmtub3duIHtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuICh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba2V5XTtcbn1cblxuLyoqXG4gKiBgdG9kb3NgIOihjCDihpIg6Z2i5p2/55qE5riF5Y2V44CCXG4gKlxuICogYG51bGxgIC8gYFtdYCAvIOacieWGheWuuSoq5piv5LiJ5Lu25LqLKirvvJpgbnVsbGAg5piv44CM6L+Z5Lu96K6w5b2V6YeM5rKh5pyJ5riF5Y2V44CN77yMYFtdYCDmmK9cbiAqIOOAjGFnZW50IOaYjuehruWGmeS6huS4gOS7veepuuihqOOAje+8iGB0b2RvX3dyaXRlYCDlhYHorrjnqbrmlbDnu4TlkJfvvJ/lt6Xlhbcgc2NoZW1hIOimgeaxglxuICogYHJlcXVpcmVkOiB0cnVlYCDnmoTmlbDnu4TvvIznqbrmlbDnu4TmmK/lkIjms5XnmoTvvInvvIzmnInlhoXlrrnlsLHmmK/mnInlhoXlrrkg4oCU4oCUIOmdouadv+S4iuesrCAxIOS4juesrCAzIOenjVxuICog55qE5YaZ5rOV5a6M5YWo5LiN5ZCM77yM5omA5Lul6L+Z6YeM5LiA5Liq6YO95LiN6K645ZCI5bm244CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRvZG9zKHZhbHVlOiB1bmtub3duLCBub3Rlczogc3RyaW5nW10pOiBUb2RvVmlld1tdIHwgbnVsbCB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHRvZG9zOiBUb2RvVmlld1tdID0gW107XG4gICAgbGV0IGRyb3BwZWQgPSAwO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiB2YWx1ZSkge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gc3RyKGZpZWxkKGl0ZW0sICdjb250ZW50JykpO1xuICAgICAgICBjb25zdCBzdGF0dXMgPSBTdHJpbmcoZmllbGQoaXRlbSwgJ3N0YXR1cycpID8/ICcnKTtcbiAgICAgICAgaWYgKCFjb250ZW50IHx8ICFUT0RPX1NUQVRVU0VTLmhhcyhzdGF0dXMpKSB7XG4gICAgICAgICAgICBkcm9wcGVkKys7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICB0b2Rvcy5wdXNoKHsgY29udGVudDogY3V0KGNvbnRlbnQsIFRPRE9fVEVYVF9MSU1JVCksIHN0YXR1czogc3RhdHVzIGFzIFRvZG9TdGF0dXMgfSk7XG4gICAgfVxuICAgIGlmIChkcm9wcGVkID4gMCkge1xuICAgICAgICAvLyDlroHlsJHkuI3lgYfvvJrorqTkuI3lh7rnmoTmnaHnm67kuKLmjonvvIzkvYYqKuivtOWHuuadpSoq77yI5LiN6K+055qE6K+d6Z2i5p2/5LiK5bCx5piv44CM5riF5Y2V55+t5LqG5Yeg5p2h44CN77yJXG4gICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICBg6L+Z5Lu95riF5Y2V6YeM5pyJICR7ZHJvcHBlZH0g5p2h6K+75LiN5Ye65p2l77yIRFNIIOeahOa4heWNleadoeebruW9oueKtuWPmOS6hu+8n++8ieKAlOKAlCDpnaLmnb/kuIrlj6rliJfkuoborqTlvpfnmoTpgqMgJHt0b2Rvcy5sZW5ndGh9IOadoeOAgmAsXG4gICAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0b2Rvcztcbn1cblxuLyoqXG4gKiDkuIDku73nm67moIflv6vnhafvvIhgR29hbFNuYXBzaG90YCArIOaKleW9semineWkluW4pueahOi9ruasoeS4juaXtumXtO+8ieKGkiDpnaLmnb/nmoTnm67moIfjgIJcbiAqXG4gKiDkuInkuKrosIPnlKjmlrnlvaLnirbkuI3lkIzkvYblhoXlrrnlkIzmupDvvIzmiYDku6Xor7vlj5blj6rlhpnkuIDku73vvJpcbiAqIC0g57yT5a2Y6YeM55qEIGBnb2FsYCDooYzvvJpge2N1cnJlbnQ6IHtnb2FsLCByb3VuZHNTdGFydGVkLCB1cGRhdGVkQXR9LCAuLi59YFxuICogLSBgZ29hbC9jaGFuZ2VgIOS6i+S7tu+8mmB7b3BlcmF0aW9uLCBnb2FsLCByb3VuZHNTdGFydGVkLCB1cGRhdGVkQXQsIC4uLn1gXG4gKiDlt67liKvlj6rmmK/jgIzlv6vnhafmjILlnKjlk6rkuKrlrZfmrrXkuIrjgI3jgIHjgIzova7mrKHlhpnlnKjlk6rkuIDlsYLjgI3vvIznlLHosIPnlKjmlrnlj5blpb3lho3kvKDov5vmnaXjgIJcbiAqL1xuZnVuY3Rpb24gZ29hbEZyb20oYXJnczoge1xuICAgIHNuYXBzaG90OiB1bmtub3duO1xuICAgIHJvdW5kc1N0YXJ0ZWQ6IHVua25vd247XG4gICAgdXBkYXRlZEF0OiB1bmtub3duO1xufSk6IEdvYWxWaWV3IHwgbnVsbCB7XG4gICAgY29uc3Qgb2JqZWN0aXZlID0gc3RyKGZpZWxkKGFyZ3Muc25hcHNob3QsICdvYmplY3RpdmUnKSk7XG4gICAgY29uc3QgcGhhc2UgPSBTdHJpbmcoZmllbGQoYXJncy5zbmFwc2hvdCwgJ3BoYXNlJykgPz8gJycpO1xuICAgIGlmICghb2JqZWN0aXZlIHx8ICFHT0FMX1BIQVNFUy5oYXMocGhhc2UpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBibG9ja2VkID0gZmllbGQoYXJncy5zbmFwc2hvdCwgJ2Jsb2NrZWRSZWFzb24nKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBvYmplY3RpdmU6IGN1dChvYmplY3RpdmUsIFBST01QVF9URVhUX0xJTUlUICogMiksXG4gICAgICAgIHBoYXNlOiBwaGFzZSBhcyBHb2FsVmlld1sncGhhc2UnXSxcbiAgICAgICAgcm91bmRzU3RhcnRlZDogbnVtKGFyZ3Mucm91bmRzU3RhcnRlZCkgPz8gMCxcbiAgICAgICAgbWF4R29hbFJvdW5kczogbnVtKGZpZWxkKGFyZ3Muc25hcHNob3QsICdtYXhHb2FsUm91bmRzJykpID8/IDAsXG4gICAgICAgIGJsb2NrZWRSZWFzb246IHN0cihmaWVsZChibG9ja2VkLCAnbWVzc2FnZScpKSA/PyBzdHIoZmllbGQoYmxvY2tlZCwgJ2NvZGUnKSksXG4gICAgICAgIHVwZGF0ZWRBdDogbnVtKGFyZ3MudXBkYXRlZEF0KSA/PyAwLFxuICAgIH07XG59XG5cbi8qKlxuICog57yT5a2Y6YeMIGBnb2FsYCDpgqPkuIDooYzvvIgqKuaKleW9seeKtuaAgSoq77yJ4oaSIOmdouadv+eahOebruagh+OAglxuICpcbiAqIOKaoCDov5nkuIDooYznmoTlvaLnirbmmK8gYHtjdXJyZW50LCBzZWVuR29hbElkcywgZmFpbHVyZX1g77yM55yf5q2j55qE5YaF5a655ZyoIGBjdXJyZW50LmdvYWxgIOmHjFxuICog77yIYGN1cnJlbnRgIOaYr+aKleW9seeahOW9k+WJjeWAvO+8jGBnb2FsYCDmiY3mmK/lv6vnhafvvInjgIJgY3VycmVudGAg5Li6IG51bGwgPSDmsqHmnInnm67moIdcbiAqIO+8iOacrOacuiA0OTAg5Lu96K6w5b2V6YeM57ud5aSn5aSa5pWw6YO95piv6L+Z5qC377yJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUdvYWxQcm9qZWN0aW9uKHZhbHVlOiB1bmtub3duLCBub3Rlczogc3RyaW5nW10pOiBHb2FsVmlldyB8IG51bGwge1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY3VycmVudCA9IGZpZWxkKHZhbHVlLCAnY3VycmVudCcpO1xuICAgIGNvbnN0IGdvYWwgPSBnb2FsRnJvbSh7XG4gICAgICAgIHNuYXBzaG90OiBmaWVsZChjdXJyZW50LCAnZ29hbCcpLFxuICAgICAgICByb3VuZHNTdGFydGVkOiBmaWVsZChjdXJyZW50LCAncm91bmRzU3RhcnRlZCcpLFxuICAgICAgICB1cGRhdGVkQXQ6IGZpZWxkKGN1cnJlbnQsICd1cGRhdGVkQXQnKSxcbiAgICB9KTtcbiAgICBpZiAoIWdvYWwgJiYgY3VycmVudCkge1xuICAgICAgICAvLyDmnIkgYGN1cnJlbnRgIOWNtOivu+S4jeWHuuebruaghyA9IOW9oueKtuWPmOS6hu+8jOimgeivtOWHuuadpe+8iOmdmem7mOW9k+aIkOOAjOayoeacieebruagh+OAjeS8muiuqeeUqOaIt1xuICAgICAgICAvLyDku6XkuLrov5nkuKrkvJror53mnKzmnaXlsLHmsqHmnInnm67moIfvvIlcbiAgICAgICAgbm90ZXMucHVzaCgn6L+Z5p2h5Lya6K+d5pyJ5LiA5Liq55uu5qCH77yM5L2G5a6D55qE5b2i54q26Z2i5p2/6K6k5LiN5Ye65p2l77yIRFNIIOeahCBnb2FsIOiusOW9leWPmOS6hu+8n++8ieOAgicpO1xuICAgIH1cbiAgICAvLyDlpLHotKXorrDlvZXvvIhgZmFpbHVyZWDvvInkuI7nm67moIfmnKzouqvmmK/kuKTku7bkuovvvJrlpLHotKXkuI3nrYnkuo7msqHmnInnm67moIfvvIzmiYDku6XliIblvIDor7TjgIJcbiAgICAvLyDimqAg5LiK5ri46L+Z5LiA5qCP5pivKirlrZfnrKbkuLIqKu+8iGB6LnN0cmluZygpLm1pbigxKS5udWxsYWJsZSgpYO+8jOWGheWuueaYr1xuICAgIC8vIGBnb2FsIHJlcGxheSBmYWlsZWQgYXQgc2Vzc2lvbiBldmVudCA8c2VxPjogPG1lc3NhZ2U+YO+8ie+8jOS4jeaYr+WvueixoSDigJTigJQg5YWI5oyJ5a2X56ym5Liy6K+777yMXG4gICAgLy8g6K+75LiN5Ye65p2l5YaN6K+V5a+56LGh77yI6Ziy5a6D5ZOq5aSp5pS55oiQ57uT5p6E5YyW77yJ44CCXG4gICAgY29uc3QgZmFpbHVyZSA9IGZpZWxkKHZhbHVlLCAnZmFpbHVyZScpO1xuICAgIGlmIChmYWlsdXJlKSB7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9XG4gICAgICAgICAgICBzdHIoZmFpbHVyZSkgPz8gc3RyKGZpZWxkKGZhaWx1cmUsICdtZXNzYWdlJykpID8/IHN0cihmaWVsZChmYWlsdXJlLCAncmVhc29uJykpID8/IHN0cihmaWVsZChmYWlsdXJlLCAnY29kZScpKTtcbiAgICAgICAgbm90ZXMucHVzaChg6L+Z5Liq55uu5qCH5pyJ5LiA5p2h5aSx6LSl6K6w5b2VJHtyZWFzb24gPyBg77yaJHtjdXQocmVhc29uLCAyMDApfWAgOiAn77yI5b2i54q25LiN6K6k6K+G77yM5Y+q6IO956Gu6K6k5a6D5a2Y5Zyo77yJJ33jgIJgKTtcbiAgICB9XG4gICAgcmV0dXJuIGdvYWw7XG59XG5cbi8qKlxuICogYGdvYWwvY2hhbmdlYCAqKuS6i+S7tioq55qE6L296I23IOKGkiDpnaLmnb/nmoTnm67moIfjgIJcbiAqXG4gKiDimqAg5Lik5Liq5b2i54q25beu5byC6YO96KaB5aSE55CG77yM6L+Z5piv5pys5paH5Lu26YeM5pyA5a655piT6K+76ZSZ55qE5LiA5aSE77yaXG4gKiAxLiDkuovku7bluKbnmoTmmK8qKuWPmOabtOWFg+aVsOaNrioq77yIYHtvcGVyYXRpb24sIGdvYWwsIHJvdW5kc1N0YXJ0ZWQsIGNyZWF0ZWRBdCwgdXBkYXRlZEF0fWDvvInvvIxcbiAqICAgIOS4jeaYr+e8k+WtmOmHjOmCo+enjeaKleW9seeKtuaAge+8iOayoeaciSBgY3VycmVudGAg6L+Z5LiA5bGC77yM5b+r54Wn55u05o6l5ZyoIGBnb2FsYCDkuIrvvInvvJtcbiAqIDIuIGBvcGVyYXRpb24gPT09ICdjbGVhcidgIOaYr+S4gOadoSoq5aKT56KRKiog4oCU4oCUIOi9veiNt+mHjCoq5rKh5pyJKiogYGdvYWxg77yM5a6D55qE5oSP5oCd5pivXG4gKiAgICDjgIznm67moIfooqvmuIXmjonkuobjgI3vvIzmiYDku6Xov5Tlm54gbnVsbCDmmK8qKuato+ehrue7k+aenCoq77yM5LiN5piv6K+75aSx6LSl44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUdvYWxDaGFuZ2UoZGF0YTogdW5rbm93biwgbm90ZXM6IHN0cmluZ1tdKTogR29hbFZpZXcgfCBudWxsIHtcbiAgICBpZiAoIWRhdGEgfHwgdHlwZW9mIGRhdGEgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoZGF0YSkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IG9wZXJhdGlvbiA9IFN0cmluZyhmaWVsZChkYXRhLCAnb3BlcmF0aW9uJykgPz8gJycpO1xuICAgIGlmIChvcGVyYXRpb24gPT09ICdjbGVhcicpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGdvYWwgPSBnb2FsRnJvbSh7XG4gICAgICAgIHNuYXBzaG90OiBmaWVsZChkYXRhLCAnZ29hbCcpLFxuICAgICAgICByb3VuZHNTdGFydGVkOiBmaWVsZChkYXRhLCAncm91bmRzU3RhcnRlZCcpLFxuICAgICAgICB1cGRhdGVkQXQ6IGZpZWxkKGRhdGEsICd1cGRhdGVkQXQnKSxcbiAgICB9KTtcbiAgICBpZiAoIWdvYWwpIHtcbiAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgIG9wZXJhdGlvblxuICAgICAgICAgICAgICAgID8gYOebruagh+WPmOabtO+8iCR7Y3V0KG9wZXJhdGlvbiwgNDApfe+8ieeahOS6i+S7tui9veiNt+mdouadv+iupOS4jeWHuuadpe+8iERTSCDnmoQgZ29hbCDkuovku7blj5jkuobvvJ/vvInjgIJgXG4gICAgICAgICAgICAgICAgOiAn55uu5qCH5Y+Y5pu055qE5LqL5Lu26L296I236Z2i5p2/6K6k5LiN5Ye65p2l77yIRFNIIOeahCBnb2FsIOS6i+S7tuWPmOS6hu+8n++8ieOAgicsXG4gICAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBnb2FsO1xufVxuXG4vKipcbiAqIGB0dXJuT3V0bGluZWAg6KGMIOKGkiDlm57lkIjlpKfnurLjgIJcbiAqXG4gKiDimqAg54q25oCB5pivIGB7dHVybnMsIGRyYWZ0fWDvvIgqKuS4jeaYryoq6YKj5Liq5pWw57uE5pys6LqrIOKAlOKAlCDpgqPmmK/lrqLmiLfnq68gd2lyZSB2aWV377yMXG4gKiDnhacgd2lyZSB2aWV3IOivu+S8muS4gOadoemDveivu+S4jeWIsO+8ieOAgmBkcmFmdGAg5piv44CM5q2j5Zyo5YaZ55qE6YKj5LiA6L2u44CN55qE5Zue5aSN6I2J56i/44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVR1cm5PdXRsaW5lKHZhbHVlOiB1bmtub3duLCBub3Rlczogc3RyaW5nW10pOiB7IHR1cm5zOiBUdXJuVmlld1tdOyB0dXJuc1RvdGFsOiBudW1iZXI7IGRyYWZ0OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZW1wdHkgPSB7IHR1cm5zOiBbXSwgdHVybnNUb3RhbDogMCwgZHJhZnQ6ICcnIH07XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gZW1wdHk7XG4gICAgY29uc3QgbGlzdCA9IGZpZWxkKHZhbHVlLCAndHVybnMnKTtcbiAgICBjb25zdCBkcmFmdCA9IHN0cihmaWVsZCh2YWx1ZSwgJ2RyYWZ0JykpID8/ICcnO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShsaXN0KSkgcmV0dXJuIHsgLi4uZW1wdHksIGRyYWZ0IH07XG4gICAgY29uc3QgYWxsOiBUdXJuVmlld1tdID0gW107XG4gICAgbGV0IGRyb3BwZWQgPSAwO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBsaXN0KSB7XG4gICAgICAgIGNvbnN0IHR1cm4gPSBwb3NpdGl2ZShmaWVsZChpdGVtLCAndHVybicpKTtcbiAgICAgICAgaWYgKHR1cm4gPT09IG51bGwpIHtcbiAgICAgICAgICAgIGRyb3BwZWQrKztcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGFsbC5wdXNoKHtcbiAgICAgICAgICAgIHR1cm4sXG4gICAgICAgICAgICBwcm9tcHQ6IGN1dChzdHIoZmllbGQoaXRlbSwgJ3Byb21wdCcpKSA/PyAnJywgUFJPTVBUX1RFWFRfTElNSVQpLFxuICAgICAgICAgICAgcmVzcG9uc2U6IGN1dChzdHIoZmllbGQoaXRlbSwgJ3Jlc3BvbnNlJykpID8/ICcnLCBSRVNQT05TRV9URVhUX0xJTUlUKSxcbiAgICAgICAgICAgIGVudHJ5U2VxOiBudWxsLFxuICAgICAgICAgICAgc2VxOiBudW0oZmllbGQoaXRlbSwgJ3NlcScpKSxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChkcm9wcGVkID4gMCkgbm90ZXMucHVzaChg5Zue5ZCI5aSn57qy6YeM5pyJICR7ZHJvcHBlZH0g5p2h6K+75LiN5Ye65p2l77yIRFNIIOeahOWkp+e6suadoeebruW9oueKtuWPmOS6hu+8n++8ieOAgmApO1xuICAgIC8vIOS4iua4uOS/neivgeS4peagvOWNh+W6j++8jOi/memHjOi/mOaYr+aOkuS4gOmBje+8mumdouadv+eahOOAjOesrCBOIOi9ruOAjeagh+mimOS+nei1lumhuuW6j++8jOS5seS6huavlOe8uuS6huabtOmavueci1xuICAgIGFsbC5zb3J0KChhLCBiKSA9PiBhLnR1cm4gLSBiLnR1cm4pO1xuICAgIGlmIChhbGwubGVuZ3RoIDw9IE1BWF9PVVRMSU5FX1RVUk5TKSByZXR1cm4geyB0dXJuczogYWxsLCB0dXJuc1RvdGFsOiBhbGwubGVuZ3RoLCBkcmFmdCB9O1xuICAgIG5vdGVzLnB1c2goYOWbnuWQiOWkp+e6suS4gOWFsSAke2FsbC5sZW5ndGh9IOi9ru+8jOmdouadv+S4iuWPquWIl+acgOi/kSAke01BWF9PVVRMSU5FX1RVUk5TfSDova7vvIjmr4/mnaHpg73luKbkuKTmrrXmkZjopoHvvIzlhajlj5HlpKrph43vvInjgIJgKTtcbiAgICByZXR1cm4geyB0dXJuczogYWxsLnNsaWNlKC1NQVhfT1VUTElORV9UVVJOUyksIHR1cm5zVG90YWw6IGFsbC5sZW5ndGgsIGRyYWZ0IH07XG59XG5cbi8qKlxuICogYGNvbnRleHRUaW1lbGluZWAg6YKj5LiA6KGM6K+75Ye65p2l55qE5Lik5qC35Lic6KW/44CCXG4gKlxuICog5Li65LuA5LmI5LiN5piv44CM5Y+q6L+U5Zue6KeG5Zu+44CN77ya6L+Z5LiA6KGMKirmsqHnlLvlh7rmnaUqKueahOWbm+enjeadpei3r++8iOeJiOacrOS4jeiupOivhiAvIOWuv+S4u+S9juS6juWfuue6vyAvXG4gKiDov5jmsqHmnInor7fmsYLorrDlvZUgLyDlvaLnirbor7vkuI3lh7rmnaXvvInkuI7jgIznlLvlh7rmnaXkuobjgI3mmK/lkIzkuIDku7bkuovnmoTkuKTkuKrnu5PmnpzvvIzogIznrKzkuIDnp43mg4XlhrXkuItcbiAqIOinhuWbvuW/heeEtuaYryBudWxsIOKAlOKAlCDljp/lm6Dlj6rog73ku47nrKzkuozkuKrlrZfmrrXluKblh7rljrvvvIjpnaLmnb/opoHnlKgqKuWOn+aWhyoq6K+05Ye65piv5ZOq5LiA56eN77yJ44CCXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29udGV4dFRpbWVsaW5lUGFyc2VSZXN1bHQge1xuICAgIC8qKiDlvZLkuIDljJYgKyDogZrlkIjlpb3nmoTmm7Lnur/vvJvor7vkuI3lh7rmnaXlsLHmmK8gbnVsbOOAgiAqL1xuICAgIHRpbWVsaW5lOiBDb250ZXh0VGltZWxpbmVWaWV3IHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiDov5nkuIDooYzkuLrku4DkuYjmsqHnlLvlh7rmnaUgLyDor7vnmoTml7blgJnmnInku4DkuYjlj6PlvoTpl67popjjgIJcbiAgICAgKiDimqAg5a6D5pivIGBTZXNzaW9uVXNhZ2UudGltZWxpbmVOb3RlYCDnmoTllK/kuIDmnaXmupDvvIwqKuS4jei/myBgdXNhZ2Uubm90ZXNgKirvvIjop4HpgqPph4znmoTms6jph4rvvInjgIJcbiAgICAgKi9cbiAgICBub3RlOiBzdHJpbmcgfCBudWxsO1xufVxuXG4vKiogYHBhcnNlQ29udGV4dFRpbWVsaW5lYCDlhoXpg6jnmoTkuK3pl7TmgIHvvJrkuIDkuKror7fmsYLlvZLkuIDljJbkuYvlkI7nmoTmoLflrZDvvIjogZrlkIjliY3vvInjgIIgKi9cbmludGVyZmFjZSBSYXdUaW1lbGluZVBvaW50IHtcbiAgICBzZXE6IG51bWJlciB8IG51bGw7XG4gICAgdGltZTogbnVtYmVyIHwgbnVsbDtcbiAgICB0dXJuOiBudW1iZXIgfCBudWxsO1xuICAgIHN0ZXA6IG51bWJlciB8IG51bGw7XG4gICAgdG9rZW5zOiBudW1iZXI7XG4gICAgcHJvbXB0OiBudW1iZXIgfCBudWxsO1xuICAgIHRvdGFsOiBudW1iZXIgfCBudWxsO1xuICAgIGVzdGltYXRlZDogYm9vbGVhbjtcbiAgICAvKiog6K6w5b2V6Ieq5bex5bim55qEIGBzdGVwQ291bnRg77yI5LiK5ri4IHNjaGVtYSDph4zmnInvvIzkvYbmnKzmnLrnnJ/mlbDmja7ph4wqKuS4gOadoemDveayoeaciSoq77yM6KeB5LiL6Z2i55qE5rOo6YeK77yJ44CCICovXG4gICAgc3RlcENvdW50OiBudW1iZXIgfCBudWxsO1xufVxuXG4vKipcbiAqIOepuueahCoq5oqV5b2x54q25oCBKirmiY3nrpfpmY3nuqfljaDkvY3vvIhgdmVyOiAxYCArIGB2YWw6IHt9YO+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOWIpOOAjOepuuWvueixoeOAjeiAjOS4jeaYr+WPquWIpOeJiOacrOWPt++8mmB2ZXIgMWAg5piv6YKj5Liq5o+S5Lu26ZmN57qnIHVuaXQg55qE54mI5pys77yM6ICM5a6D55qE54q25oCBXG4gKiDmsLjov5zmmK/kuI3luKbku7vkvZXplK7nmoQgYHt9YO+8iGBpbml0OiAoKSA9PiAoe30pYOOAgWBhcHBseWAg5piv5oGS562J77yJ4oCU4oCUIOaJgOS7peS4pOiAheWQjOaXtuaIkOeri1xuICog5omN5piv44CM5a6/5Li75aSq6ICB44CN77yM5Y2V54us5LiA5LiqIGB2ZXI6IDFgIOS4jei2s+S7pei/meS5iOivtOOAglxuICovXG5mdW5jdGlvbiBpc0VtcHR5U3RhdGUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgICByZXR1cm4gaXNSZWNvcmQodmFsdWUpICYmIE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGggPT09IDA7XG59XG5cbi8qKlxuICogYGNvbnRleHRUaW1lbGluZWAg6YKj5LiA6KGMIOKGkiDpnaLmnb/og73nlLvnmoTkuIDmnaHmm7Lnur/jgIIqKue6r+WHveaVsCoq77yI5LiN56Kw55uY44CB5LiN5omT5pel5b+X77yJ77yM5omA5Lul6IO955u05o6l5rWL44CCXG4gKlxuICog5bmy5Zub5Lu25LqL77yM57y65LiA5Lu26L+Z5byg5Zu+5bCx5piv6ZSZ55qE77yaXG4gKiAxLiAqKuW9oueKtuivhuWIqyoq77ya5Y+q6K6kIGB2ZXIgPT09IDEzYO+8iOS4iua4uCBgZHNoLWNvbnRleHRgIOeahCBgc3RhdGVWZXJzaW9uYO+8ieOAguiupOS4jeWHuueahOW9oueKtlxuICogICAg5LiA5b6L6L+U5ZueIG51bGwg6ICM5LiN5piv54ycIOKAlOKAlCDnjJzlh7rmnaXnmoTlvaLnirbnlLvlnKjpnaLmnb/kuIrvvIzmr5TmsqHmnInov5nlnZfmm7Tns5/vvIjlroPnnIvotbfmnaXmmK/lr7nnmoTvvInvvJtcbiAqIDIuICoq5b2S5LiA5YyWKirvvJrmn7Hpq5gqKuS8mOWFiOWPliBwcm92aWRlciDlrp7mtYvnmoQgYHByb21wdGAqKu+8jOe8uuS6huaJjeWbnuiQveWIsOS8sOeul+eahCBgdG90YWxgXG4gKiAgICDlubbmiorov5nkuIDmoLnmoIfmiJAgYGVzdGltYXRlZGDvvIjnnJ/mnLrph4wgYHByb21wdCAvIHRvdGFsYCDnmoTkuK3kvY3mmK8gMS4zNCDigJTigJQg5Y+q55S7IHRvdGFsXG4gKiAgICDkvJrorqnkurrku6XkuLrljaDnlKjov5zkvY7kuo7nnJ/lrp7vvIzop4Hmlofku7blpLTlj6PlvoQgNu+8ie+8m1xuICogMy4gKirogZrlkIgqKu+8mui2hei/hyBgQ09OVEVYVF9USU1FTElORV9NQVhfQkFSU2Ag5qC55bCx5oyJKirlm57lkIgqKuiBmuWQiO+8jOWPluivpeWbnuWQiOeahCoq5pyA5ZCO5LiA5q2lKipcbiAqICAgIO+8iOS4jeaYr+W5s+Wdh+WAvCDigJTigJQg5bmz5Z2H5Lya5oqK5Y6L57yp5o6J55qE6YKj5LiA5oiq5oq55bmz77yM6ICM6YKj5q2j5piv6L+Z5byg5Zu+6KaB55yL55qE5Lic6KW/77yJ77ybXG4gKiA0LiAqKuaMguWOi+e8qeeCuSoq77yaYGV2ZW50c1tdYCDph4znmoQgYGNvbXBhY3Rpb25gIC8gYHBydW5lYCDpkonliLAqKuWug+S5i+WQjueahOesrOS4gOadoSByZXF1ZXN0Kiog5LiKXG4gKiAgICDvvIjop4TliJnpgJDlrZfnhafmioTkuIrmuLggd2lyZSB2aWV3IOeahCBgYnVpbGRUaW1lbGluZVZpZXdg77yaYHdoaWxlIChyZXF1ZXN0c1tyaV0uc2VxIDw9IGV2LnNlcSkgcmkrK2DvvInvvIxcbiAqICAgIOW5tuS4lOaKiuOAjOmSieWcqOWQjOS4gOagueafseS4iiArIOaXtumXtOebuOi/keOAjeeahOi/nuWPkeS6i+S7tioq5ZCI5bm25oiQ5LiA5Liq5qCH6K6wKirvvIjlrp7mtYvmnIkgNTJtcyDlhoVcbiAqICAgIOi/nuWPkSA3IOadoSBwcnVuZSDnmoTvvInjgIJcbiAqXG4gKiDimqAg5LiA5LiqIDAg6YO95LiN6K646KGl77ya6K6k5LiN5Ye655qE6K+35rGCKirkuKLmjonlubborqHmlbAqKu+8iGBkcm9wcGVkYO+8ie+8jOeql+WPo+S4iumZkOe8uuWkseWwseS4jee7meeZvuWIhuavlOOAglxuICpcbiAqIEBwYXJhbSByb3cgLSBgcmVjb3JkLnJvd3MuY29udGV4dFRpbWVsaW5lYO+8iOaVtOihjCBge3Zlciwgc2VxLCB2YWx9YO+8ie+8m+i/meS4gOihjOS4jeWtmOWcqOaXtuS8oCB1bmRlZmluZWTjgIJcbiAqIEByZXR1cm5zIGB7dGltZWxpbmUsIG5vdGV9YO+8m2B0aW1lbGluZSA9PT0gbnVsbGAg5pe2IGBub3RlYCDor7Tlvpflh7rmmK/lk6rkuIDnp43jgIzmsqHmnInjgI3jgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29udGV4dFRpbWVsaW5lKHJvdzogdW5rbm93bik6IENvbnRleHRUaW1lbGluZVBhcnNlUmVzdWx0IHtcbiAgICAvKipcbiAgICAgKiDov5nkuIDooYwqKuagueacrOS4jeWtmOWcqCoqIOKGkiDml6LmsqHmnInmm7Lnur/kuZ/msqHmnInor53opoHor7TvvJrpgqPmmK8qKuW4uOaAgSoq77yI5rOo5YaM6ICF5piv56ys5LiJ5pa5XG4gICAgICogYGRzaC1jb250ZXh0YO+8jOacrCBwcm9maWxlIOS4jeaMguWug++8ie+8jOaOqui+nueUsemdouadv+e7me+8iGB0aW1lbGluZVRleHRPZmAg6YKj5Lik5Y+l77yJ44CCXG4gICAgICog5Zyo6L+Z6YeM57yW5LiA5Y+l6K+d55qE6K+d77yM6Z2i5p2/5bCx5YiG5LiN5Ye644CM5rKh5pyJ6L+Z5LiA6KGM44CN5LiO44CM6L+Z5LiA6KGM6K+75LiN5Ye65p2l44CN5LqG44CCXG4gICAgICovXG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkIHx8IHJvdyA9PT0gbnVsbCkgcmV0dXJuIHsgdGltZWxpbmU6IG51bGwsIG5vdGU6IG51bGwgfTtcbiAgICBpZiAoIWlzUmVjb3JkKHJvdykpIHtcbiAgICAgICAgcmV0dXJuIHsgdGltZWxpbmU6IG51bGwsIG5vdGU6IGDkuIrkuIvmloflop7plb/pgqPkuIDooYzkuI3mmK/kuIDkuKoge3Zlciwgc2VxLCB2YWx9IOWvueixoe+8iOe8k+WtmOagvOW8j+WPmOS6hu+8n++8ieKAlOKAlCDmiYDku6XkuI3nlLvjgIJgIH07XG4gICAgfVxuXG4gICAgY29uc3QgdmVyID0gbnVtKHJvdy52ZXIpO1xuICAgIGNvbnN0IHZhbCA9IHJvdy52YWw7XG4gICAgaWYgKHZlciA9PT0gbnVsbCkge1xuICAgICAgICByZXR1cm4geyB0aW1lbGluZTogbnVsbCwgbm90ZTogJ+S4iuS4i+aWh+WinumVv+mCo+S4gOihjOayoeacieeJiOacrOWPt++8jOaMieW9k+WJjeWPo+W+hOS4jeaVouehrOivu++8jOaJgOS7peS4jeeUu+OAgicgfTtcbiAgICB9XG4gICAgaWYgKHZlciA9PT0gQ09OVEVYVF9USU1FTElORV9GQUxMQkFDS19WRVJTSU9OICYmIGlzRW1wdHlTdGF0ZSh2YWwpKSB7XG4gICAgICAgIHJldHVybiB7IHRpbWVsaW5lOiBudWxsLCBub3RlOiBjb250ZXh0VGltZWxpbmVCYXNlbGluZU5vdGUodmVyKSB9O1xuICAgIH1cbiAgICBpZiAodmVyICE9PSBDT05URVhUX1RJTUVMSU5FX1NUQVRFX1ZFUlNJT04pIHtcbiAgICAgICAgcmV0dXJuIHsgdGltZWxpbmU6IG51bGwsIG5vdGU6IGNvbnRleHRUaW1lbGluZVZlcnNpb25Ob3RlKHZlcikgfTtcbiAgICB9XG4gICAgaWYgKCFpc1JlY29yZCh2YWwpKSB7XG4gICAgICAgIHJldHVybiB7IHRpbWVsaW5lOiBudWxsLCBub3RlOiAn5LiK5LiL5paH5aKe6ZW/6L+Z5LiA6KGM55qE54q25oCB5LiN5piv5LiA5Liq5a+56LGh77yI5b2i54q26Z2i5p2/6K6k5LiN5Ye65p2l77yM5omA5Lul5LiN55S777yJ44CCJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IHJhd1JlcXVlc3RzID0gdmFsLnJlcXVlc3RzO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShyYXdSZXF1ZXN0cykpIHtcbiAgICAgICAgcmV0dXJuIHsgdGltZWxpbmU6IG51bGwsIG5vdGU6ICfkuIrkuIvmloflop7plb/ov5nkuIDooYzph4zmsqHmnIkgcmVxdWVzdHMg5pWw57uE77yI5b2i54q26Z2i5p2/6K6k5LiN5Ye65p2l77yM5omA5Lul5LiN55S777yJ44CCJyB9O1xuICAgIH1cbiAgICBpZiAocmF3UmVxdWVzdHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiB7IHRpbWVsaW5lOiBudWxsLCBub3RlOiBjb250ZXh0VGltZWxpbmVFbXB0eU5vdGUoKSB9O1xuICAgIH1cblxuICAgIC8vIC0tLS0g4pGgIOW9kuS4gOWMlu+8muavj+S4quivt+axguS4gOS4queCue+8iOafsemrmOS8mOWFiOWPluWunua1i+eahCBwcm9tcHTvvIktLS0tXG4gICAgY29uc3QgcmF3OiBSYXdUaW1lbGluZVBvaW50W10gPSBbXTtcbiAgICBsZXQgZHJvcHBlZCA9IDA7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHJhd1JlcXVlc3RzKSB7XG4gICAgICAgIGNvbnN0IHByb21wdCA9IG51bShmaWVsZChpdGVtLCAncHJvbXB0JykpO1xuICAgICAgICBjb25zdCB0b3RhbCA9IG51bShmaWVsZChpdGVtLCAndG90YWwnKSk7XG4gICAgICAgIGNvbnN0IHRva2VucyA9IHByb21wdCA/PyB0b3RhbDtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIGBwcm9tcHRgIOS4jiBgdG90YWxgIOmDveivu+S4jeWHuuadpe+8iOWtl+espuS4siAvIE5hTiAvIOi0n+aVsCAvIOaVtOS4quWtl+auteayoeS6hu+8ieKGkiAqKuS4ouaOiSoq44CCXG4gICAgICAgICAqIOS4uuS7gOS5iOS4ouaOieiAjOS4jeaYr+ihpSAw77ya6KGlIDAg5Lya55S75Ye65LiA5qC544CM6L+Z6YeM5b6I55yB44CN55qE5p+x5a2QIOKAlOKAlCDpgqPmmK/nvJblh7rmnaXnmoTlvaLnirbvvIxcbiAgICAgICAgICog6ICM55yf5a6e5oOF5Ya15Y+q5piv44CM6L+Z5LiA5p2h6K+75LiN5Ye65p2l44CN44CC5Lii5Yeg5p2h5bCx5Zyo6Z2i5p2/5LiK6K+05Yeg5p2h77yIYGRyb3BwZWRg77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBpZiAodG9rZW5zID09PSBudWxsKSB7XG4gICAgICAgICAgICBkcm9wcGVkICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICByYXcucHVzaCh7XG4gICAgICAgICAgICBzZXE6IG51bShmaWVsZChpdGVtLCAnc2VxJykpLFxuICAgICAgICAgICAgdGltZTogbnVtKGZpZWxkKGl0ZW0sICd0aW1lJykpLFxuICAgICAgICAgICAgdHVybjogbnVtKGZpZWxkKGl0ZW0sICd0dXJuJykpLFxuICAgICAgICAgICAgc3RlcDogbnVtKGZpZWxkKGl0ZW0sICdzdGVwJykpLFxuICAgICAgICAgICAgdG9rZW5zLFxuICAgICAgICAgICAgcHJvbXB0LFxuICAgICAgICAgICAgdG90YWwsXG4gICAgICAgICAgICBlc3RpbWF0ZWQ6IHByb21wdCA9PT0gbnVsbCxcbiAgICAgICAgICAgIHN0ZXBDb3VudDogcG9zaXRpdmUoZmllbGQoaXRlbSwgJ3N0ZXBDb3VudCcpKSxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChyYXcubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIOaciSByZXF1ZXN0cyDkvYbkuIDmnaHpg73or7vkuI3lh7rmnaUgPSDlvaLnirblj5jkuobvvIjopoHljLrliKvkuo7jgIzov5jmsqHmnInor7fmsYLorrDlvZXjgI3vvIlcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHRpbWVsaW5lOiBudWxsLFxuICAgICAgICAgICAgbm90ZTogYOi/meS4gOihjOaciSAke3Jhd1JlcXVlc3RzLmxlbmd0aH0g5p2h6K+35rGC6K6w5b2V77yM5L2G5LiA5p2h6YO96K+75LiN5Ye65p+x6auY77yIcHJvbXB0IOS4jiB0b3RhbCDpg73kuI3lnKggLyDkuI3mmK/mlbDvvInigJTigJQg5b2i54q25Y+Y5LqG77yM5omA5Lul5LiN55S744CCYCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoSDogZrlkIjvvJrotoXov4fpmIjlgLzmjInlm57lkIjvvIzlj5bor6Xlm57lkIjmnIDlkI7kuIDmraXvvIgqKuS4jeWPluW5s+Wdhyoq77yJLS0tLVxuICAgIGNvbnN0IGdyb3VwczogeyBsYXN0OiBudW1iZXI7IGNvdW50OiBudW1iZXI7IHR1cm46IG51bWJlciB8IG51bGw7IHN0ZXBDb3VudDogbnVtYmVyIHwgbnVsbCB9W10gPSBbXTtcbiAgICBsZXQgY2FycmllZFR1cm46IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCByYXcubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICAgIGNvbnN0IHBvaW50ID0gcmF3W2luZGV4XTtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOi9ruasoeWPt+e8uuWkseaXtioq5bm26L+b5LiK5LiA6L2uKirvvIjnrKzkuIDkuKrlsLHnvLrliJnlvZLlhaUgYG51bGxgIOmCo+S4gOe7hO+8ieKAlOKAlFxuICAgICAgICAgKiDkuLrku4DkuYjkuI3oh6rlt7HnvJbkuIDkuKrova7mrKHvvJrpnaLmnb/kuIrjgIznrKwgTiDova7jgI3mmK/nu5nkurrlr7notKbnlKjnmoTvvIznvJblh7rmnaXnmoTlj7dcbiAgICAgICAgICog5Lya6K6p5Lq65Y675om+5LiA5Liq5bm25LiN5a2Y5Zyo55qE6L2u5qyh44CCXG4gICAgICAgICAqL1xuICAgICAgICBpZiAocG9pbnQudHVybiAhPT0gbnVsbCkgY2FycmllZFR1cm4gPSBwb2ludC50dXJuO1xuICAgICAgICBjb25zdCB0dXJuID0gcG9pbnQudHVybiA/PyBjYXJyaWVkVHVybjtcbiAgICAgICAgY29uc3QgbGFzdEdyb3VwID0gZ3JvdXBzW2dyb3Vwcy5sZW5ndGggLSAxXTtcbiAgICAgICAgaWYgKGxhc3RHcm91cCAmJiBsYXN0R3JvdXAudHVybiA9PT0gdHVybikge1xuICAgICAgICAgICAgbGFzdEdyb3VwLmxhc3QgPSBpbmRleDtcbiAgICAgICAgICAgIGxhc3RHcm91cC5jb3VudCArPSAxO1xuICAgICAgICAgICAgaWYgKHBvaW50LnN0ZXBDb3VudCAhPT0gbnVsbCkgbGFzdEdyb3VwLnN0ZXBDb3VudCA9IE1hdGgubWF4KGxhc3RHcm91cC5zdGVwQ291bnQgPz8gMCwgcG9pbnQuc3RlcENvdW50KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGdyb3Vwcy5wdXNoKHsgbGFzdDogaW5kZXgsIGNvdW50OiAxLCB0dXJuLCBzdGVwQ291bnQ6IHBvaW50LnN0ZXBDb3VudCB9KTtcbiAgICB9XG4gICAgY29uc3QgYWdncmVnYXRlZCA9IHJhdy5sZW5ndGggPiBDT05URVhUX1RJTUVMSU5FX01BWF9CQVJTO1xuXG4gICAgLyoqIOiBmuWQiOWJjeeahOS4i+aghyDihpIg6KaB55S755qE5p+x55qE5LiL5qCH77yI5Y6L57yp54K56Z2g5a6D6ZKJ5LiK5p2l77yJ44CCICovXG4gICAgY29uc3QgYmFyT2ZSYXc6IG51bWJlcltdID0gbmV3IEFycmF5KHJhdy5sZW5ndGgpLmZpbGwoMCk7XG4gICAgY29uc3QgcG9pbnRzOiBUaW1lbGluZVBvaW50Vmlld1tdID0gW107XG4gICAgaWYgKGFnZ3JlZ2F0ZWQpIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOKaoCDmmKDlsITlv4XpobsqKuS4gOauteS4gOauteWcsOWhqyoq77yIYGN1cnNvcmAg5b6A5Y+z5o6o77yJ77ya5q+P5LiA57uE6YO95oqK44CM5Yiw5pys57uE5pyA5ZCO5LiA5qC56K+35rGC5Li65q2i44CNXG4gICAgICAgICAqIOeahOS4i+agh+WFqOWhq+aIkOacrOe7hOeahOafseWPt+eahOivne+8jOWQjuS4gOe7hOeahOWhq+WFheS8mioq6KaG55uWKirliY3pnaLlh6Dnu4Qg4oCU4oCUIOWOi+e8qeeCueWwseS8muWFqOiiq+mSieWIsFxuICAgICAgICAgKiDmnIDlkI7kuIDmoLnmn7HkuIrvvIjov5nkuKogYnVnIOWcqCBgdmVyaWZ5LXN0YXRzYCDnmoTjgIzljovnvKnngrnot5/nnYDogZrlkIjlubbliLDlkIzkuIDmoLnmn7HkuIrjgI3pgqPmnaHmlq3oqIDkuIpcbiAgICAgICAgICog546w6L+H5LiA5qyh77yaNDAwIOagueafseiBmuWQiOaIkCA4IOague+8jOagh+iusOWNtOeUu+WcqOacgOWPs+i+uemCo+S4gOague+8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgbGV0IGN1cnNvciA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgICAgICAgICBwb2ludHMucHVzaChwb2ludE9mKHJhd1tncm91cC5sYXN0XSwgcG9pbnRzLmxlbmd0aCArIDEsIGdyb3VwLmNvdW50LCBncm91cC5zdGVwQ291bnQpKTtcbiAgICAgICAgICAgIGZvciAobGV0IGluZGV4ID0gY3Vyc29yOyBpbmRleCA8PSBncm91cC5sYXN0OyBpbmRleCArPSAxKSBiYXJPZlJhd1tpbmRleF0gPSBwb2ludHMubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGN1cnNvciA9IGdyb3VwLmxhc3QgKyAxO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHJhdy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgICAgICAgIHBvaW50cy5wdXNoKHBvaW50T2YocmF3W2luZGV4XSwgaW5kZXggKyAxLCAxLCByYXdbaW5kZXhdLnN0ZXBDb3VudCkpO1xuICAgICAgICAgICAgYmFyT2ZSYXdbaW5kZXhdID0gaW5kZXg7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoiDljovnvKnngrnvvJrpkonliLDjgIzlroPkuYvlkI7nmoTnrKzkuIDmnaEgcmVxdWVzdOOAje+8jOWQjOS4gOWkhOi/nuWPkeeahOWQiOW5tuaIkOS4gOS4quagh+iusCAtLS0tXG4gICAgY29uc3QgZXZlbnRzID0gQXJyYXkuaXNBcnJheSh2YWwuZXZlbnRzKSA/IHZhbC5ldmVudHMgOiBbXTtcbiAgICBjb25zdCBtYXJrZXJzOiBUaW1lbGluZUN1dFZpZXdbXVtdID0gcG9pbnRzLm1hcCgoKSA9PiBbXSk7XG4gICAgbGV0IGN1dHNUb3RhbCA9IDA7XG4gICAgZm9yIChjb25zdCBldmVudCBvZiBldmVudHMpIHtcbiAgICAgICAgY29uc3Qga2luZCA9IHN0cihmaWVsZChldmVudCwgJ2tpbmQnKSk7XG4gICAgICAgIGlmIChraW5kICE9PSAnY29tcGFjdGlvbicgJiYga2luZCAhPT0gJ3BydW5lJykgY29udGludWU7XG4gICAgICAgIGNvbnN0IGV2ZW50U2VxID0gbnVtKGZpZWxkKGV2ZW50LCAnc2VxJykpO1xuICAgICAgICBsZXQgcmF3SW5kZXggPSAtMTtcbiAgICAgICAgaWYgKGV2ZW50U2VxICE9PSBudWxsKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgcmF3Lmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHJhd1tpbmRleF0uc2VxO1xuICAgICAgICAgICAgICAgIGlmIChjYW5kaWRhdGUgIT09IG51bGwgJiYgY2FuZGlkYXRlID4gZXZlbnRTZXEpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3SW5kZXggPSBpbmRleDtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDmib7kuI3liLDjgIzlroPkuYvlkI7nmoTnrKzkuIDmnaEgcmVxdWVzdOOAjeeahOS4pOenjeaDheWGtemDvemSieWcqCoq5pyA5ZCO5LiA5qC55p+xKirkuIrvvJpcbiAgICAgICAgICog4pGgIOS6i+S7tuWPkeeUn+WcqOacgOWQjuS4gOasoeiwg+eUqOS5i+WQju+8iOS8muivneWImuWOi+e8qeWujOWwsee7k+adn+S6hu+8ie+8m+KRoSDor7fmsYLorrDlvZXph4zmsqHmnIkgc2Vx44CCXG4gICAgICAgICAqIOS4uuS7gOS5iOS4jeS4ou+8muS4iua4uCB3aXJlIHZpZXcg5Lmf5LiN5Lya5oqK5LqL5Lu25Lii5o6J77yI5a6D5Y+q5b6A5LqL5Lu25LiK6KGlIHR1cm4vc3RlcO+8ie+8jFxuICAgICAgICAgKiDogIzkuKLmjonnmoTooajnjrDmmK/jgIzmmI7mmI7ljovnvKnov4fvvIzlm77kuIrljbTku4DkuYjpg73msqHmnInjgI3igJTigJQg6YKj5piv6L+Z5Z2X5pyA5a655piT54qv55qE6ZSZ44CCXG4gICAgICAgICAqL1xuICAgICAgICBpZiAocmF3SW5kZXggPCAwKSByYXdJbmRleCA9IHJhdy5sZW5ndGggLSAxO1xuICAgICAgICBjb25zdCBiYXIgPSBiYXJPZlJhd1tyYXdJbmRleF07XG4gICAgICAgIGNvbnN0IGxpc3QgPSBtYXJrZXJzW2Jhcl07XG4gICAgICAgIGNvbnN0IHRpbWUgPSBudW0oZmllbGQoZXZlbnQsICd0aW1lJykpO1xuICAgICAgICBjb25zdCB0b2tlbnMgPSBudW0oZmllbGQoZXZlbnQsICd0b2tlbnMnKSkgPz8gMDtcbiAgICAgICAgY29uc3QgY291bnQgPSBudW0oZmllbGQoZXZlbnQsICdjb3VudCcpKTtcbiAgICAgICAgY29uc3QgcHJldmlvdXMgPSBsaXN0W2xpc3QubGVuZ3RoIC0gMV07XG4gICAgICAgIC8qKlxuICAgICAgICAgKiDlkIjlubbvvJoqKuWQjOS4gOagueafsSArIOaXtumXtOebuOi/kSoq44CC5pe26Ze056qX5Y+WIDUg56eS77yM5L6d5o2u5piv5pys5py655yf5pWw5o2u6YeM6YKj5LiA5LiyXG4gICAgICAgICAqIO+8iDcg5p2hIHBydW5lIOWcqCA1Mm1zIOWGhei/nuWPke+8jDMuMCDnp5LlkI7miY3mmK/kuIDmnaHlpKcgY29tcGFjdGlvbiDigJTigJQg5YmNIDcg5p2h5ZCI5bm244CBXG4gICAgICAgICAqIOmCo+adoSBjb21wYWN0aW9uIOWNleeLrOS4gOS4quagh+iusO+8jOWboOS4uuWug+malOedgCAzIOenkuS4lOmHj+e6p+WujOWFqOS4jeWQjO+8ieOAglxuICAgICAgICAgKi9cbiAgICAgICAgaWYgKHByZXZpb3VzICYmIHRpbWUgIT09IG51bGwgJiYgcHJldmlvdXMudGltZSAhPT0gbnVsbCAmJiB0aW1lIC0gcHJldmlvdXMudGltZSA8PSBUSU1FTElORV9NRVJHRV9NUykge1xuICAgICAgICAgICAgcHJldmlvdXMudG9rZW5zICs9IHRva2VucztcbiAgICAgICAgICAgIHByZXZpb3VzLm1lcmdlZCArPSAxO1xuICAgICAgICAgICAgaWYgKGtpbmQgPT09ICdjb21wYWN0aW9uJykgcHJldmlvdXMua2luZCA9ICdjb21wYWN0aW9uJztcbiAgICAgICAgICAgIGlmIChjb3VudCAhPT0gbnVsbCkgcHJldmlvdXMuY291bnQgPSAocHJldmlvdXMuY291bnQgPz8gMCkgKyBjb3VudDtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGxpc3QucHVzaCh7XG4gICAgICAgICAgICBraW5kLFxuICAgICAgICAgICAgdG9rZW5zLFxuICAgICAgICAgICAgY291bnQsXG4gICAgICAgICAgICBtZXJnZWQ6IDEsXG4gICAgICAgICAgICB0aW1lLFxuICAgICAgICAgICAgc2VxOiBudW0oZmllbGQoZXZlbnQsICdzZXEnKSksXG4gICAgICAgIH0pO1xuICAgICAgICBjdXRzVG90YWwgKz0gMTtcbiAgICB9XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHBvaW50cy5sZW5ndGg7IGluZGV4ICs9IDEpIHBvaW50c1tpbmRleF0uY3V0cyA9IG1hcmtlcnNbaW5kZXhdO1xuXG4gICAgY29uc3QgdG9rZW5zID0gcG9pbnRzLm1hcCgocG9pbnQpID0+IHBvaW50LnRva2Vucyk7XG4gICAgY29uc3QgbGFzdCA9IHBvaW50c1twb2ludHMubGVuZ3RoIC0gMV07XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdGltZWxpbmU6IHtcbiAgICAgICAgICAgIHZlcixcbiAgICAgICAgICAgIHNlcTogbnVtKHJvdy5zZXEpLFxuICAgICAgICAgICAgcG9pbnRzLFxuICAgICAgICAgICAgcmVxdWVzdHM6IHJhdy5sZW5ndGgsXG4gICAgICAgICAgICBhZ2dyZWdhdGVkLFxuICAgICAgICAgICAgZHJvcHBlZCxcbiAgICAgICAgICAgIG1heDogTWF0aC5tYXgoMCwgLi4udG9rZW5zKSxcbiAgICAgICAgICAgIGVzdGltYXRlZENvdW50OiBwb2ludHMuZmlsdGVyKChwb2ludCkgPT4gcG9pbnQuZXN0aW1hdGVkKS5sZW5ndGgsXG4gICAgICAgICAgICBsYXN0VG9rZW5zOiBsYXN0LnRva2VucyxcbiAgICAgICAgICAgIGxhc3RFc3RpbWF0ZWQ6IGxhc3QuZXN0aW1hdGVkLFxuICAgICAgICAgICAgY29udGV4dFdpbmRvdzogcG9zaXRpdmUodmFsLmNvbnRleHRXaW5kb3cpLFxuICAgICAgICAgICAgYXJjaGl2ZUZsb29yOiBudW0odmFsLmFyY2hpdmVGbG9vciksXG4gICAgICAgICAgICBjdXRzVG90YWwsXG4gICAgICAgIH0sXG4gICAgICAgIG5vdGU6IG51bGwsXG4gICAgfTtcbn1cblxuLyoqIOeUseS4gOS4quivt+axguiusOW9lemAoOS4gOagueafse+8iGBpbmRleGAg5pivIDEg6LW355qE5p+x5Y+377yMYHN0ZXBzYCDmmK/ov5nmoLnmn7Hku6Pooajlh6DmraXvvInjgIIgKi9cbmZ1bmN0aW9uIHBvaW50T2Yoc291cmNlOiBSYXdUaW1lbGluZVBvaW50LCBpbmRleDogbnVtYmVyLCBzdGVwczogbnVtYmVyLCBzdGVwQ291bnQ6IG51bWJlciB8IG51bGwpOiBUaW1lbGluZVBvaW50VmlldyB7XG4gICAgLyoqXG4gICAgICog4pqgIOafseWuveeUqCoq6K+35rGC5p2h5pWwKirvvIhgc3RlcHNg77yJ77yM5LiN5piv6K6w5b2V6Ieq5bim55qEIGBzdGVwQ291bnRg77ya5pys5py6IDQ3MCDku73nnJ/nvJPlrZjph4xcbiAgICAgKiBgc3RlcENvdW50YCAqKuS4gOasoemDveayoeWHuueOsOi/hyoq77yI5LiK5ri4IHNjaGVtYSDph4zmnInov5nkuKrlrZfmrrXvvIzkvYbmsqHkurrlhpnlroPvvInigJTigJRcbiAgICAgKiDmi7/lroPlvZPllK/kuIDnmoTlrr3luqbkvp3mja7vvIzogZrlkIjlh7rmnaXnmoTmn7Hlrr3kvJrlhajmmK8gMeOAguS4pOS4qumDveacieaXtuWPluWkp+eahOmCo+S4quOAglxuICAgICAqL1xuICAgIHJldHVybiB7XG4gICAgICAgIGluZGV4LFxuICAgICAgICB0b2tlbnM6IHNvdXJjZS50b2tlbnMsXG4gICAgICAgIHByb21wdDogc291cmNlLnByb21wdCxcbiAgICAgICAgdG90YWw6IHNvdXJjZS50b3RhbCxcbiAgICAgICAgZXN0aW1hdGVkOiBzb3VyY2UuZXN0aW1hdGVkLFxuICAgICAgICB0dXJuOiBzb3VyY2UudHVybixcbiAgICAgICAgc3RlcDogc291cmNlLnN0ZXAsXG4gICAgICAgIHNlcTogc291cmNlLnNlcSxcbiAgICAgICAgc3RlcHM6IE1hdGgubWF4KHN0ZXBzLCBzdGVwQ291bnQgPz8gMSksXG4gICAgICAgIGN1dHM6IFtdLFxuICAgIH07XG59XG5cbi8qKiDlkIzkuIDmoLnmn7HkuIrjgIznrpfkuIDmrKHjgI3nmoTml7bpl7TnqpfvvIjmr6vnp5LvvInvvJrov57lj5HnmoQgcHJ1bmUg6JC95Zyo6L+Z5Liq56qX6YeM5bCx5ZCI5oiQ5LiA5Liq5qCH6K6w44CCICovXG5jb25zdCBUSU1FTElORV9NRVJHRV9NUyA9IDVfMDAwO1xuXG4vKipcbiAqIOaKiuS4gOS7vee8k+WtmOiusOW9leaWh+aho+W9kuS4gOWMluaIkOi/m+W6puOAgioq57qv5Ye95pWwKirvvIjkuI3miZPml6Xlv5fjgIHkuI3norDnm5jvvInvvIzmiYDku6Xog73nm7TmjqXmtYvjgIJcbiAqXG4gKiDlvaLnirborqTkuI3lh7rlsLHov5Tlm54gbnVsbO+8iOiwg+eUqOaWueimgeivtOWHuuadpe+8jOS4jeimgeWBh+ijheOAjOi/meS4quS8muivneayoeaciea4heWNleOAje+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvZ3Jlc3NPZihyYXc6IHVua25vd24pOiBTZXNzaW9uUHJvZ3Jlc3NSZXN1bHQgfCBudWxsIHtcbiAgICBjb25zdCBnYXRlID0gcm93c09mKHJhdyk7XG4gICAgaWYgKCdlcnJvcicgaW4gZ2F0ZSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcHJvZ3Jlc3M6IFNlc3Npb25Qcm9ncmVzcyA9IHtcbiAgICAgICAgdG9kb3M6IHBhcnNlVG9kb3Mocm93VmFsKGdhdGUucm93cywgJ3RvZG9zJyksIG5vdGVzKSxcbiAgICAgICAgZ29hbDogcGFyc2VHb2FsUHJvamVjdGlvbihyb3dWYWwoZ2F0ZS5yb3dzLCAnZ29hbCcpLCBub3RlcyksXG4gICAgICAgIC4uLnBhcnNlVHVybk91dGxpbmUocm93VmFsKGdhdGUucm93cywgJ3R1cm5PdXRsaW5lJyksIG5vdGVzKSxcbiAgICB9O1xuICAgIHJldHVybiB7IHByb2dyZXNzLCBub3RlcyB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOiKsei0ue+8mui0puacrFxuLy9cbi8vIOmHkemineWcqOaKleW9see8k+WtmOmHjO+8iGBjb3N0VXNhZ2UudG90YWxzLmNvc3Rg77yMKirmgZLkuLrnvo7lhYMqKu+8ie+8jOiAjOOAjOaYvuekuuaIkOS7gOS5iOW4geenjeOAgeaMieS7gOS5iOaxh+eOh+OAgVxuLy8g55WZ5Yeg5L2N5bCP5pWw44CN5ZyoIGBkc2gtY29zdC1tZXRlcmAg6Ieq5bex55qE6LSm5pys6YeM44CC5omA5Lul6L+Z5LiA6IqC5YWo5pivKirnuq/lh73mlbAqKu+8mlxuLy8g5LiK5ri45oCO5LmI5qC85byP5YyW77yM6L+Z6YeM5bCx5oCO5LmI5qC85byP5YyW77yI6YCQ5a2X56e75qSN77yJ77yM5ZCm5YiZ6Z2i5p2/5LiK5LiOIHdlYiDpgqPovrnmmL7npLrnmoTpkrHkvJrplb/lvpfkuI3kuIDmoLfjgIJcblxuLyoqXG4gKiBgZHNoLWNvc3QtbWV0ZXJgIOeahOi0puacrOi3r+W+hO+8mmA8RFNIX0hPTUU+L3N0b3JhZ2VzL2Nvc3QtbWV0ZXIvbGVkZ2VyLmpzb25g44CCXG4gKlxuICog4pqgIOWug+aYryoq6L+Z5Y+w5py65Zmo5YWx5Lqr55qEKirvvIjkuI3liIblt6XnqIvjgIHkuI3liIYgcHJvZmlsZe+8ie+8mmBkYXlzWyc85pel5pyfPiddLmNvc3RgIOaYr1xuICogKirmiYDmnInlt6XnqIvliqDotbfmnaUqKueahOS4gOWkqe+8jOaJgOS7pemdouadv+S4iumCo+S4gOihjOW/hemhu+WGmeOAjOWFqOmDqOW3peeoi+OAjeOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY29zdExlZGdlclBhdGgoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbihkc2hIb21lKCksICdzdG9yYWdlcycsICdjb3N0LW1ldGVyJywgJ2xlZGdlci5qc29uJyk7XG59XG5cbi8qKiDotKbmnKzotoXov4fov5nkuKrlpKflsI/lsLHkuI3or7vkuobvvIjkuIDmrKHor7vnm5jopoHmlbTkuKogYEpTT04ucGFyc2Vg77yJ44CC55yf5a6e6LSm5pys5pivIDE4MCDlpKnjgIHlh6Dnmb4gS0LjgIIgKi9cbmNvbnN0IE1BWF9MRURHRVJfQllURVMgPSA4ICogMTAyNCAqIDEwMjQ7XG5cbi8qKiDmnIDlpJrmiavov5nkuYjlpJrlpKnvvIjotKbmnKzoh6rlt7HphY3nmoTmmK8gYGhpc3RvcnlEYXlzOiAxODBg77yb5YaN5aSa6K+05piO6L+Z5Lu96LSm5pys6KKr5Lq65pS56L+H77yJ44CCICovXG5jb25zdCBNQVhfTEVER0VSX0RBWVMgPSA0MDA7XG5cbi8qKlxuICog5LiK5ri4IGBsb2NhbERheUtleWAg55qEKirpgJDlrZfnp7vmpI0qKu+8iGBkc2gtY29zdC1tZXRlci9saWIvc3RvcmUuanNg77yJ44CCXG4gKlxuICog6LSm5pys55qEIGBkYXlzYCDplK7mmK8qKuacrOWcsOaXtuWMuioq55qEIGBZWVlZLU1NLUREYOOAgueUqCBgdG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMClgIOaLvyBVVENcbiAqIOaXpeacn+WcqOS4nOWFq+WMuuS8mioq6ZSZ5LiA5aSpKirvvIjkuIvljYggOCDngrnkuYvlkI7vvInvvIzkuo7mmK/jgIzku4rml6XjgI3pgqPkuIDooYzkvJrmjIflkJHliY3kuIDlpKnnmoTotKbjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsRGF5S2V5KG1zOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShtcyk7XG4gICAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7XG4gICAgcmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtwYWQoZC5nZXRNb250aCgpICsgMSl9LSR7cGFkKGQuZ2V0RGF0ZSgpKX1gO1xufVxuXG4vKipcbiAqIOS7jui0puacrOmHjOWPluaYvuekuuiuvue9ruOAgioq6K6k5LiN5Ye65b2i54q25bCxIG51bGwqKu+8iOS4jeeMnOm7mOiupOWAvCDigJTigJQg54yc6ZSZ5LqG5bCx5piv5oKE5oKE5pS55Yir5Lq655qE6ZKx6K+l5pi+56S65oiQ5aSa5bCR77yJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb3N0RGlzcGxheU9mKHJhdzogdW5rbm93bik6IENvc3REaXNwbGF5IHwgbnVsbCB7XG4gICAgaWYgKCFpc1JlY29yZChyYXcpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBjb25maWcgPSBpc1JlY29yZChyYXcuY29uZmlnKSA/IHJhdy5jb25maWcgOiBudWxsO1xuICAgIGlmICghY29uZmlnKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBjdXJyZW5jeSA9IHN0cihjb25maWcuY3VycmVuY3kpO1xuICAgIGNvbnN0IHN5bWJvbCA9IHN0cihjb25maWcuc3ltYm9sKTtcbiAgICBjb25zdCBkZWNpbWFscyA9IG51bShjb25maWcuZGVjaW1hbHMpO1xuICAgIGNvbnN0IGV4Y2hhbmdlUmF0ZSA9IG51bShjb25maWcuZXhjaGFuZ2VSYXRlKTtcbiAgICBjb25zdCBwcmljaW5nQ3VycmVuY3kgPSBzdHIoY29uZmlnLnByaWNpbmdDdXJyZW5jeSk7XG4gICAgaWYgKGN1cnJlbmN5ID09PSBudWxsIHx8IHN5bWJvbCA9PT0gbnVsbCB8fCBkZWNpbWFscyA9PT0gbnVsbCB8fCBleGNoYW5nZVJhdGUgPT09IG51bGwgfHwgcHJpY2luZ0N1cnJlbmN5ID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4geyBjdXJyZW5jeSwgc3ltYm9sLCBkZWNpbWFscywgZXhjaGFuZ2VSYXRlLCBwcmljaW5nQ3VycmVuY3kgfTtcbn1cblxuLyoqXG4gKiDotKbmnKzph4zkuI4qKuafkOS4gOadoeS8muivnSoq5pyJ5YWz55qE5LqL5a6e44CCKirnuq/lh73mlbAqKu+8iOS4jeaJk+aXpeW/l+OAgeS4jeeisOebmO+8ie+8jOaJgOS7peiDveebtOaOpea1i+OAglxuICpcbiAqIOKaoCAqKuagvOW8j+WMluS4jeWcqOi/memHjCoq77yaYGZvcm1hdE1vbmV5YCDnmoTllK/kuIDlrp7njrDmmK8gYHBhbmVscy9kZWZhdWx0L2Nvc3QudHNgXG4gKiDvvIjpgqPmmK/pnaLmnb/opoHnlLvnmoTmloflrZfvvIzlt7Lnn6XnrZTmoYjooajlnKggYHZlcmlmeS1wYW5lbGAg6YeM77yM5LiO55yf5o+S5Lu25a+55ouN55qE5pat6KiA5ZyoXG4gKiBgdmVyaWZ5LXN0YXRzYCDph4zvvInjgILov5nkuIDku73lj6rnrqEqKuivu+aVsOaNrioq77yM5Lik5aSE5ZCE5YaZ5LiA5Lu95qC85byP5YyW5b+F54S25ryC56e744CCXG4gKlxuICog5LiJ56eN44CM5rKh5pyJ44CN5YiG5b6X5b6I5riF5qWa77yM6Z2i5p2/5LiK55qE6K+d5Lmf5a6M5YWo5LiN5LiA5qC377yaXG4gKiAtIOaVtOS7vei0puacrOW9oueKtuS4jeiupOivhiDihpIg6L+U5ZueICoqbnVsbCoq77yI6LCD55So5pa55oyJ44CM6K+75LiN5Yiw6LSm5pys44CN5aSE55CG77yM5LiN6IO95b2T5oiQ44CM5rKh6Iqx6ZKx44CN77yJ77ybXG4gKiAtIOi0puacrOiupOivhuOAgeS9huayoeaciSBgZGF5c2Ag4oaSIOi/lOWbnuS4gOS7vSoq5YWoIG51bGwqKiDnmoTkuovlrp7vvIjmmL7npLrorr7nva7ov5jog73nlKjvvInvvJtcbiAqIC0g6LSm5pys6YeM5bCx5piv5rKh5pyJ6L+Z5p2h5Lya6K+dIOKGkiBgc2Vzc2lvblVzZGAg5pivIG51bGzvvIjogIHkvJror50v5a+85YWl5rKh6KaG55uW5YiwIOKGkiDpnaLmnb/or7TjgIzotKbmnKzph4zkuZ/msqHmnInjgI3vvInjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0gYEpTT04ucGFyc2VgIOS5i+WQjueahOaVtOS7vei0puacrOOAglxuICogQHBhcmFtIHNlc3Npb25JZCAtIOimgeafpeeahOS8muivnSBpZO+8iOi0puacrOmHjCBgZGF5c1vml6XmnJ9dLnNlc3Npb25zW10uaWRg77yJ44CCXG4gKiBAcGFyYW0gbm93TXMgLSDjgIzku4rlpKnjgI3mjInlk6rkuKrml7bliLvnrpfvvIjmnKzlnLDml6XmnJ/vvIzop4EgYGxvY2FsRGF5S2V5YO+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY29zdEZhY3RzT2YocmF3OiB1bmtub3duLCBzZXNzaW9uSWQ6IHN0cmluZywgbm93TXM6IG51bWJlcik6IENvc3RMZWRnZXJWaWV3IHwgbnVsbCB7XG4gICAgaWYgKCFpc1JlY29yZChyYXcpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBkYXlzID0gaXNSZWNvcmQocmF3LmRheXMpID8gcmF3LmRheXMgOiBudWxsO1xuICAgIGlmICghZGF5cykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdG9kYXlLZXkgPSBsb2NhbERheUtleShub3dNcyk7XG5cbiAgICBsZXQgc2Vzc2lvblVzZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGNhbGxzOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgc2Nhbm5lZCA9IDA7XG4gICAgZm9yIChjb25zdCBkYXkgb2YgT2JqZWN0LnZhbHVlcyhkYXlzKSkge1xuICAgICAgICBpZiAoc2Nhbm5lZCA+PSBNQVhfTEVER0VSX0RBWVMpIGJyZWFrO1xuICAgICAgICBzY2FubmVkICs9IDE7XG4gICAgICAgIGlmICghaXNSZWNvcmQoZGF5KSB8fCAhQXJyYXkuaXNBcnJheShkYXkuc2Vzc2lvbnMpKSBjb250aW51ZTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBkYXkuc2Vzc2lvbnMpIHtcbiAgICAgICAgICAgIGlmICghaXNSZWNvcmQoZW50cnkpIHx8IHN0cihlbnRyeS5pZCkgIT09IHNlc3Npb25JZCkgY29udGludWU7XG4gICAgICAgICAgICAvLyDot6jpm7bngrnnmoTkuIDmnaHkvJror53kvJoqKuWQjOaXtioq5Ye6546w5Zyo5Lik5aSp55qEIHNlc3Npb25zIOmHjO+8jOaJgOS7peaYryoq57Sv5YqgKirogIzkuI3mmK/lj5bmnIDlkI7kuIDmnaHjgIJcbiAgICAgICAgICAgIGNvbnN0IGNvc3QgPSBudW0oZW50cnkuY29zdCk7XG4gICAgICAgICAgICBpZiAoY29zdCAhPT0gbnVsbCkgc2Vzc2lvblVzZCA9IChzZXNzaW9uVXNkID8/IDApICsgY29zdDtcbiAgICAgICAgICAgIGNvbnN0IGNvdW50ID0gbnVtKGVudHJ5LmNhbGxzKTtcbiAgICAgICAgICAgIGlmIChjb3VudCAhPT0gbnVsbCkgY2FsbHMgPSAoY2FsbHMgPz8gMCkgKyBjb3VudDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHRvZGF5ID0gaXNSZWNvcmQoZGF5c1t0b2RheUtleV0pID8gZGF5c1t0b2RheUtleV0gOiBudWxsO1xuICAgIHJldHVybiB7IHNlc3Npb25Vc2QsIGNhbGxzLCB0b2RheVVzZDogdG9kYXkgPyBudW0odG9kYXkuY29zdCkgOiBudWxsLCB0b2RheUtleSB9O1xufVxuXG4vKipcbiAqIOiKsei0uemCo+S4gOihjOeahOazqOWGjOiAhSDigJTigJQg5LiA5LiqKirnrKzkuInmlrkqKiBidW5kbGXvvIjkuI3mmK8gRFNIIOiHquW4pueahO+8ieOAglxuICpcbiAqIOWQjeWtl+WcqOi/memHjOWGmeS4gOasoe+8jOWPpuWkluS4pOWkhOmDveS7juWug+a0vueUn++8mnByb2ZpbGUg5riF5Y2V55qE5p+l5om+77yIYHJlYWRDb3N0TW91bnRg77yJ5LiO6Z2i5p2/6K+d5pyvXG4gKiDvvIhgY29zdFRleHRPZmAg55qEIGBidW5kbGVgIOWFpeWPgu+8ieOAglxuICpcbiAqIOKaoCAqKuacrCBwcm9maWxlIOS4jeaMguWugyoq77yIMjAyNi0xMiDlhrPlrprvvJpgZHNoLXByb2ZpbGUvcGFja2FnZS5qc29uYCDph4zpm7bnrKzkuInmlrkgYnVuZGxl77yJ44CCXG4gKiBgcmVhZENvc3RNb3VudCgpYCDlm6DmraTkvJrov5Tlm54gYGZhbHNlYO+8jOmdouadv+eFp+WunuivtFwi5rKh5oyC44CB5oOz55So5oCO5LmI5Yqg5Zue5p2lXCIg4oCU4oCUIOi/meadoeivu+ebmFxuICog5LmL5omA5Lul55WZ552A77yM5piv5Zug5Li6KirliKvnmoQgcHJvZmlsZSDnmoTkvJror50qKuS4jioq6ICB5Lya6K+dKirpg73ov5jluKbnnYAgYGNvc3RVc2FnZWDvvIxcbiAqIOiAjFwi5Li65LuA5LmI6L+Z5LiA5p2h5rKh5pyJ6YeR6aKdXCLnmoTkuInnp43mnaXot6/lv4XpobvliIblvpfmuIXvvIjop4EgYGNvc3QudHNgIOeahCBgbm9SZWNvcmROb3RlYO+8ieOAglxuICovXG5jb25zdCBDT1NUX01FVEVSX0JVTkRMRSA9ICdkc2gtY29zdC1tZXRlcic7XG5cbi8qKiBwcm9maWxlIOebruW9leWQje+8iOS4jiBgaW5zdGFsbC1wcm9maWxlLmpzYCDnmoQgYFBST0ZJTEVfTkFNRWAg5ZCM5LiA5Liq5YC877yJ44CCICovXG5jb25zdCBQUk9GSUxFX05BTUUgPSAnY29jb3MnO1xuXG4vKiogcHJvZmlsZSDmuIXljZXvvJpgPERTSF9IT01FPi9wcm9maWxlcy9jb2Nvcy9wYWNrYWdlLmpzb25g44CCICovXG5leHBvcnQgZnVuY3Rpb24gcHJvZmlsZU1hbmlmZXN0UGF0aCgpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKGRzaEhvbWUoKSwgJ3Byb2ZpbGVzJywgUFJPRklMRV9OQU1FLCAncGFja2FnZS5qc29uJyk7XG59XG5cbi8qKlxuICog6L+Z5LiqIHByb2ZpbGUg5oyC5rKh5oyC6Iqx6LS56YKj5Liq56ys5LiJ5pa5IGJ1bmRsZeOAgioq57qv6K+755uY77yM5LiN54ycKirjgIJcbiAqXG4gKiDkuLrku4DkuYjopoHor7vlroPvvJpgY29zdFVzYWdlYCDpgqPkuIDooYznvLrlpLHmnInkuInnp43mnaXot6/vvIjogIHkvJror50gLyDov5nkuKogcHJvZmlsZSDmsqHoo4Xmj5Lku7YgL1xuICog5Yir55qEIHByb2ZpbGUg55qE5Lya6K+d77yJ77yM5Y+q55yL57yT5a2Y5YiG5LiN5Ye65p2l77yM6ICM5LiJ56eN55qE55WM6Z2i6K+d5pyv5a6M5YWo5LiN5ZCMIOKAlOKAlFxuICog5bCk5YW244CM6L+Z5LiqIHByb2ZpbGUg5rKh6KOF44CN5pe255So5oi355yf5q2j6ZyA6KaB55qE5pivKirkuIDmnaHog73nm7TmjqXnspjnmoTlkb3ku6QqKuOAglxuICpcbiAqIEByZXR1cm5zIGB0cnVlYCDmjILnnYAgLyBgZmFsc2VgIOa4heWNlemHjOayoeacieWugyAvIGBudWxsYCDor7vkuI3liLDmuIXljZXvvIjpgqPlsLHkuI3njJzvvIzpnaLmnb/or7TliIbkuI3muIXvvInjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRDb3N0TW91bnQoKTogUHJvbWlzZTxib29sZWFuIHwgbnVsbD4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZWFkRmlsZShwcm9maWxlTWFuaWZlc3RQYXRoKCksICd1dGY4Jyk7XG4gICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZSh0ZXh0KSBhcyB7IGRzaD86IHsgcHJvZmlsZT86IHsgYnVuZGxlcz86IHVua25vd24gfSB9IH07XG4gICAgICAgIGNvbnN0IGJ1bmRsZXMgPSBtYW5pZmVzdC5kc2g/LnByb2ZpbGU/LmJ1bmRsZXM7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShidW5kbGVzKSkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiBidW5kbGVzLmluY2x1ZGVzKENPU1RfTUVURVJfQlVORExFKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vKiog6K+76LSm5pys55qE57uT5p6c77yIKiror7vkuI3liLDkuI3mmK/plJnor68qKu+8mumCo+WPquaYr+ayoeacieaYvuekuuiuvue9ruOAgeayoeacieWvuei0puaVsOaNru+8ieOAgiAqL2V4cG9ydCBpbnRlcmZhY2UgQ29zdExlZGdlclJlc3VsdCB7XG4gICAgLyoqIOivu+S4jeWKqCAvIOWkquWkpyAvIOW9oueKtuS4jeiupOivhueahOWOn+WboO+8iOmdouadv+WOn+agt+ivtOWHuuadpe+8ieOAgiAqL1xuICAgIGVycm9yPzogc3RyaW5nO1xuICAgIC8qKiDmmL7npLrorr7nva7vvIjluIHnp40gLyDmsYfnjocgLyDlsI/mlbDkvY3vvInvvJvorqTkuI3lh7rlsLHmmK8gbnVsbOOAgiAqL1xuICAgIGRpc3BsYXk6IENvc3REaXNwbGF5IHwgbnVsbDtcbiAgICAvKiog5LiO6L+Z5p2h5Lya6K+d5pyJ5YWz55qE5LqL5a6e77yb6LSm5pys6YeM5rKh5pyJ6L+Z5p2h5Lya6K+d44CB5oiW6ICF6LSm5pys6K+75LiN5Yiw77yM5bCx5pivIG51bGzjgIIgKi9cbiAgICBmYWN0czogQ29zdExlZGdlclZpZXcgfCBudWxsO1xufVxuXG4vKipcbiAqIOivu+S4gOasoei0puacrOOAglxuICpcbiAqIOKaoCDov5nmmK8qKuesrOS6jOS4quaWh+S7tioq77yI55So6YeP5Zyo5oqV5b2x57yT5a2Y6YeM77yM5pi+56S66K6+572u5Zyo6L+Z6YeM77yJ44CC5LiK5ri45oqK5a6D5pW05Liq5a+56LGh6JC955uY77yMXG4gKiDmiYDku6Xlj6rog73mlbTkuKogYEpTT04ucGFyc2Vg77yb55yf5a6e6LSm5pys77yIMTgwIOWkqe+8ieWHoOeZviBLQu+8jOaJk+W8gOaKveWxieaXtuivu+S4gOasoeaYr+WPr+S7peaOpeWPl+eahOOAglxuICog6K+75LiN5YiwKirnu53kuI3lvbHlk40qKueUqOmHj+mCo+WNiiDigJTigJQg6LCD55So5pa55ou/5YiwIGBlcnJvcmAg5bCx54Wn5a6e6K+05LiA5Y+l77yM54S25ZCO5oyJ576O5YWD5Y6f5YC855S744CCXG4gKlxuICogQHBhcmFtIHNlc3Npb25JZCAtIOimgeafpeeahOS8muivnSBpZOOAglxuICogQHBhcmFtIG5vd01zIC0g44CM5LuK5aSp44CN5oyJ5ZOq5Liq5pe25Yi7566X77yI6buY6K6k546w5Zyo77yb5rWL6K+V5Lya5Lyg5Zu65a6a5YC877yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkQ29zdExlZGdlcihzZXNzaW9uSWQ6IHN0cmluZywgbm93TXM6IG51bWJlciA9IERhdGUubm93KCkpOiBQcm9taXNlPENvc3RMZWRnZXJSZXN1bHQ+IHtcbiAgICBjb25zdCBmaWxlID0gY29zdExlZGdlclBhdGgoKTtcbiAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBzdGF0KGZpbGUpO1xuICAgICAgICBpZiAoaW5mby5zaXplID4gTUFYX0xFREdFUl9CWVRFUykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBkaXNwbGF5OiBudWxsLFxuICAgICAgICAgICAgICAgIGZhY3RzOiBudWxsLFxuICAgICAgICAgICAgICAgIGVycm9yOiBgY29zdC1tZXRlciDnmoTotKbmnKzmnIkgJHsoaW5mby5zaXplIC8gMTAyNCAvIDEwMjQpLnRvRml4ZWQoMSl9IE1C77yM6LaF6L+H6Z2i5p2/5oS/5oSP6K+755qE5LiK6ZmQ77yIJHtNQVhfTEVER0VSX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1C77yJ77yM5omA5Lul5rKh5pyJ5pi+56S65biB56eN5LiO5a+56LSm5pWw5o2u44CCYCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgdGV4dCA9IGF3YWl0IHJlYWRGaWxlKGZpbGUsICd1dGY4Jyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc3QgY29kZSA9IChlcnJvciBhcyB7IGNvZGU/OiBzdHJpbmcgfSkuY29kZTtcbiAgICAgICAgaWYgKGNvZGUgPT09ICdFTk9FTlQnKSB7XG4gICAgICAgICAgICByZXR1cm4geyBkaXNwbGF5OiBudWxsLCBmYWN0czogbnVsbCwgZXJyb3I6ICfor7vkuI3liLAgY29zdC1tZXRlciDnmoTotKbmnKzvvIjpgqPkuKrmj5Lku7bov5jmsqHot5Hov4fvvIzmiJbogIXlroPmjaLkuobkvY3nva7vvInjgIInIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgZGlzcGxheTogbnVsbCwgZmFjdHM6IG51bGwsIGVycm9yOiBg6K+75LiN5LqGIGNvc3QtbWV0ZXIg55qE6LSm5pys77yaJHtkZXNjcmliZShlcnJvcil9YCB9O1xuICAgIH1cblxuICAgIGxldCByYXc6IHVua25vd247XG4gICAgdHJ5IHtcbiAgICAgICAgcmF3ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBkaXNwbGF5OiBudWxsLCBmYWN0czogbnVsbCwgZXJyb3I6IGBjb3N0LW1ldGVyIOeahOi0puacrOS4jeaYr+WQiOazlSBKU09O77yIJHtkZXNjcmliZShlcnJvcil977yJYCB9O1xuICAgIH1cblxuICAgIGNvbnN0IGRpc3BsYXkgPSBjb3N0RGlzcGxheU9mKHJhdyk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZGlzcGxheSxcbiAgICAgICAgZmFjdHM6IGNvc3RGYWN0c09mKHJhdywgc2Vzc2lvbklkLCBub3dNcyksXG4gICAgICAgIC4uLihkaXNwbGF5ID09PSBudWxsXG4gICAgICAgICAgICA/IHsgZXJyb3I6ICfotKbmnKzor7vliLDkuobvvIzkvYbph4zpnaLnmoTmmL7npLrorr7nva7orqTkuI3lh7rmnaXvvIjluIHnp40gLyDmsYfnjoflrZfmrrXnvLrlpLHvvInigJTigJQg6Z2i5p2/5oyJ6LSm5pys5Y6f5YC877yI576O5YWD77yJ5pi+56S644CCJyB9XG4gICAgICAgICAgICA6IHt9KSxcbiAgICB9O1xufVxuXG4vKipcbiAqIOaKiui0puacrOmCo+S4gOS7veS6i+Wunui0tOWIsOeUqOmHj+S4iu+8iCoq5aSW5YqgKirjgIzov5nkuKogcHJvZmlsZSDliLDlupXmjILmsqHmjILpgqPkuKogYnVuZGxl44CN77yJ44CCXG4gKlxuICog4pqgICoq5LiA5Y+l6K+d6YO95LiN5YaZ6L+bIGBub3Rlc2AqKu+8mui0puacrOivu+S4jeWIsOWPquW9seWTjeOAjOiKsei0ueaYvuekuuaIkOS7gOS5iOW4geenjeOAje+8jFxuICog5LiO55So6YeP55qE5Y+j5b6E5peg5YWz77yb6ICM44CM5LiJ57y65LiA44CN55qE6K+d5pyv77yI5rKh6KOFIC8g5aSq6ICBIC8g5Yir55qEIHByb2ZpbGXvvInkuZ/mmK/oirHotLnpgqPkuIDlnZfoh6rlt7HnmoTkuovjgIJcbiAqIOi/meS4pOexu+aOqui+numDveWcqCBgcGFuZWxzL2RlZmF1bHQvY29zdC50c2DvvIhgY29zdFRleHRPZmDvvInph4wg4oCU4oCUIOmCo+mHjOaJjeacieW3suefpeetlOahiOihqOOAglxuICpcbiAqIEBwYXJhbSB1c2FnZSAtIOW9kuS4gOWMluWlveeahOeUqOmHj++8iCoq5bCx5ZywKirmlLnvvJrotLTlm5vkuKrlrZfmrrXvvInjgIJcbiAqIEBwYXJhbSBsZWRnZXIgLSDor7votKbmnKznmoTnu5PmnpzjgIJcbiAqIEBwYXJhbSBtb3VudGVkIC0g6L+Z5LiqIHByb2ZpbGUg5oyC5rKh5oyC6YKj5LiqIGJ1bmRsZe+8iGBudWxsYCA9IOivu+S4jeWIsOa4heWNle+8ieOAglxuICovXG5mdW5jdGlvbiBhdHRhY2hDb3N0TGVkZ2VyKHVzYWdlOiBTZXNzaW9uVXNhZ2UsIGxlZGdlcjogQ29zdExlZGdlclJlc3VsdCwgbW91bnRlZDogYm9vbGVhbiB8IG51bGwpOiB2b2lkIHtcbiAgICB1c2FnZS5jb3N0RGlzcGxheSA9IGxlZGdlci5kaXNwbGF5O1xuICAgIHVzYWdlLmNvc3RMZWRnZXIgPSBsZWRnZXIuZmFjdHM7XG4gICAgdXNhZ2UuY29zdE5vdGUgPSBsZWRnZXIuZXJyb3IgPz8gbnVsbDtcbiAgICB1c2FnZS5jb3N0TW91bnRlZCA9IG1vdW50ZWQ7XG4gICAgdXNhZ2UuY29zdEJ1bmRsZSA9IENPU1RfTUVURVJfQlVORExFO1xufVxuXG4vKipcbiAqIOaKiuS4gOS7vee8k+WtmOiusOW9leW9kuS4gOWMluaIkCBgU2Vzc2lvblVzYWdlYOOAgioq57qv5Ye95pWwKirvvIjkuI3miZPml6Xlv5fjgIHkuI3norDnm5jvvInvvIzmiYDku6Xog73nm7TmjqXmtYvjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0gYEpTT04ucGFyc2VgIOS5i+WQjueahOaVtOS7veaWh+aho+OAglxuICogQHBhcmFtIG1ldGEgLSDmlofku7blsYLpnaLnmoTkuovlrp7vvIhpZCAvIG10aW1lIC8g5a6e5pe25rC05L2N77yJ44CCXG4gKiBAcmV0dXJucyBge29rOmZhbHNlLCBlcnJvcn1gIOihqOekuui/meS7veiusOW9lSoq5b2i54q25LiN6K6k6K+GKirvvIjosIPnlKjmlrnopoHor7Tlh7rmnaXvvIzkuI3opoHlgYfoo4XmsqHmnInnlKjph4/vvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVVzYWdlUmVjb3JkKFxuICAgIHJhdzogdW5rbm93bixcbiAgICBtZXRhOiB7IGlkOiBzdHJpbmc7IHVwZGF0ZWRBdD86IG51bWJlcjsgbGl2ZVNlcT86IG51bWJlciB9LFxuKTogU2Vzc2lvblVzYWdlUmVzdWx0IHtcbiAgICBjb25zdCBnYXRlID0gcm93c09mKHJhdyk7XG4gICAgaWYgKCdlcnJvcicgaW4gZ2F0ZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZ2F0ZS5lcnJvciB9O1xuICAgIGNvbnN0IGRvY3VtZW50ID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IHJvd3MgPSBnYXRlLnJvd3M7XG5cbiAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCB2ZXJzaW9uID0gbnVtKGRvY3VtZW50LnZlcnNpb24pO1xuICAgIGlmICh2ZXJzaW9uID09PSBudWxsIHx8ICFLTk9XTl9SRUNPUkRfVkVSU0lPTlMuaGFzKHZlcnNpb24pKSB7XG4gICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICBg57yT5a2Y6K6w5b2V55qE5qC85byP54mI5pys5pivIHYke3ZlcnNpb24gPT09IG51bGwgPyAnPycgOiB2ZXJzaW9ufe+8jOacrOmdouadv+aYr+aMiSB2NSDorqTnmoQg4oCU4oCUIGAgK1xuICAgICAgICAgICAgICAgICfkuIvpnaLmmK/lsL3lipvogIzkuLror7vlh7rmnaXnmoTvvIzmlbDlrZflj6/og73kuI4gRFNIIOiHquW3seeahOWPo+W+hOWvueS4jeS4iuOAgicsXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgLy8g4pqgIOi6q+S7vemCo+S4gOWxguWcqCBgcmVjb3JkYCDkuIrvvIjkuI3lnKggYHJlY29yZC5yb3dzYCDkuIrvvInigJTigJQg5omA5Lul6L+Z6YeM5b6X5LuO5paH5qGj5YaN5Y+W5LiA5qyh77yMXG4gICAgLy8g5LiN6IO95ou/IGByb3dzT2ZgIOe7meeahOmCo+WNiuaIquOAglxuICAgIGNvbnN0IGlkZW50aXR5UmF3ID0gKChkb2N1bWVudC5yZWNvcmQgYXMgeyBpZGVudGl0eT86IHVua25vd24gfSkuaWRlbnRpdHkgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IGluaGVyaXRlZEV2ZW50cyA9IG51bShpZGVudGl0eVJhdy5pbmhlcml0ZWRFdmVudENvdW50KSA/PyAwO1xuICAgIGNvbnN0IHNlZWRlZCA9IGlkZW50aXR5UmF3LmlzU2VlZGVkID09PSB0cnVlO1xuICAgIGlmIChzZWVkZWQgfHwgaW5oZXJpdGVkRXZlbnRzID4gMCkge1xuICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgYOi/meadoeS8muivneaYr+S7juWIq+eahOS8muivneaOpei/h+adpeeahO+8iOWJjemdoui/mOaciSAke2luaGVyaXRlZEV2ZW50c30g5p2h5LqL5Lu25LiN5Zyo5pys5pel5b+X6YeM77yJ77yMYCArXG4gICAgICAgICAgICAgICAgJ+aJgOS7peS4i+mdouOAjOacrOS8muivnee0r+iuoeOAjeWPqueul+i/meS7veaXpeW/l+iusOS4i+eahOmDqOWIhuOAgicsXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2VxID0gd2F0ZXJtYXJrT2Yocm93cyk7XG4gICAgY29uc3QgbGl2ZVNlcSA9IG51bShtZXRhLmxpdmVTZXEpO1xuICAgIGNvbnN0IGJlaGluZCA9IHNlcSAhPT0gbnVsbCAmJiBsaXZlU2VxICE9PSBudWxsICYmIGxpdmVTZXEgPiBzZXEgPyBsaXZlU2VxIC0gc2VxIDogbnVsbDtcblxuICAgIC8vIC0tLS0g5LiK5LiL5paH5Y2g55SoIC0tLS1cbiAgICBjb25zdCBwcmVzc3VyZVJhdyA9IHJvd1ZhbHVlKHJvd3MsICdjb250ZXh0UHJlc3N1cmUnKTtcbiAgICBjb25zdCBicmVha2Rvd25SYXcgPSByb3dWYWx1ZShyb3dzLCAnY29udGV4dEJyZWFrZG93bicpO1xuICAgIGNvbnN0IHdpbmRvdyA9IHByZXNzdXJlUmF3ID8gcG9zaXRpdmUocHJlc3N1cmVSYXcuY29udGV4dFdpbmRvdykgOiBudWxsO1xuICAgIGNvbnN0IHByZXNzdXJlID0gcHJlc3N1cmVSYXcgPyBudW0ocHJlc3N1cmVSYXcucHJlc3N1cmVUb2tlbnMpIDogbnVsbDtcbiAgICBjb25zdCBzdXJmYWNlID0gcHJlc3N1cmVSYXcgPyBudW0ocHJlc3N1cmVSYXcuc3VyZmFjZVRva2VucykgOiBudWxsO1xuICAgIGNvbnN0IHNhbXBsZWRTdXJmYWNlID0gcHJlc3N1cmVSYXcgPyBudW0ocHJlc3N1cmVSYXcuc2FtcGxlZFN1cmZhY2VUb2tlbnMpIDogbnVsbDtcblxuICAgIC8qKlxuICAgICAqIOKaoCAqKuWFrOW8j+eFp+aKhOS4iua4uCoq77yIYGRzaC10b2tlbi1tZXRlcmAg55qEIGBjb250ZXh0UHJlc3N1cmVgIHdpcmUgdmlld++8ie+8mlxuICAgICAqXG4gICAgICogYGBganNcbiAgICAgKiBwcm9qZWN0ZWRUb2tlbnM6IE1hdGgubWF4KDAsIHByZXNzdXJlVG9rZW5zICsgc3VyZmFjZVRva2VucyAtIHNhbXBsZWRTdXJmYWNlVG9rZW5zKVxuICAgICAqIGBgYFxuICAgICAqXG4gICAgICog5Li65LuA5LmI5LiN55SoIGBwcmVzc3VyZVRva2Vuc2Ag5b2T5Y2g55So546H77ya5a6D5pivKirkuIrkuIDmrKEqKuivt+axgueahOWunua1i++8jOWOi+e8qeS5i+WQjuS8muWBj+mrmO+8m1xuICAgICAqIOS4iua4uOS4uuatpOe7tOaKpOS6hiBzdXJmYWNlIOS9jeenu++8jGBwcm9qZWN0ZWRgIOaJjeaYr+OAjOS4i+S4gOasoeivt+axguWkp+amguimgeWkmuWwkeOAjeOAglxuICAgICAqIOS4iua4uOagt+acrOaIliBzdXJmYWNlIOe8uuS4gOS4quWwseS4jee7mSDigJTigJQg6YKj5bCx6YCA5Zue5a6e5rWL77yM5bm25ZyoIG5vdGVzIOmHjOivtOa4healmuOAglxuICAgICAqL1xuICAgIGxldCBwcm9qZWN0ZWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIGlmIChwcmVzc3VyZSAhPT0gbnVsbCAmJiBzdXJmYWNlICE9PSBudWxsICYmIHNhbXBsZWRTdXJmYWNlICE9PSBudWxsKSB7XG4gICAgICAgIHByb2plY3RlZCA9IE1hdGgubWF4KDAsIHByZXNzdXJlICsgc3VyZmFjZSAtIHNhbXBsZWRTdXJmYWNlKTtcbiAgICAgICAgaWYgKHN1cmZhY2UgPCBzYW1wbGVkU3VyZmFjZSkge1xuICAgICAgICAgICAgLy8gc3VyZmFjZSDlj5jlsI8gPSDpgqPmrKHph4fmoLfkuYvlkI7kuIrkuIvmlofooqsqKuWOi+e8qSoq6L+H77yIYC9jb21wYWN0YOOAgeaIluS4iuS4i+aWh+ijgeWJqu+8ieOAglxuICAgICAgICAgICAgLy8g5LiN6K+06L+Z5LiA5Y+l55qE6K+d77yM55So5oi35Lya55yL5Yiw44CM5Y2g55So546H56qB54S25o6J5LqG5LiA5aSn5oiq44CN6ICM5LiN55+l6YGT5Li65LuA5LmI44CCXG4gICAgICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgICAgIGDov5nku73orrDlvZXph4zkuIrkuIvmlofooqvljovnvKnov4fvvIhzdXJmYWNlICR7c2FtcGxlZFN1cmZhY2V9IOKGkiAke3N1cmZhY2V977yJ77yMYCArXG4gICAgICAgICAgICAgICAgICAgICfmiYDku6XljaDnlKjnjofnlKjnmoTmmK/jgIzkv67mraPlkI7nmoTpooTkvLDjgI3vvIzkuI3mmK/kuIrkuIDmrKHor7fmsYLnmoTlrp7mtYsg4oCU4oCUIOaVsOWtl+WPmOWwj+aYr+ato+W4uOeahOOAgicsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChwcmVzc3VyZSAhPT0gbnVsbCkge1xuICAgICAgICBwcm9qZWN0ZWQgPSBwcmVzc3VyZTtcbiAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICfov5nmnaHorrDlvZXph4znvLrkuIvkuIDmrKHor7fmsYLnmoTpooTkvLDvvIjnvJPlrZjph4zmsqHmnIkgc3VyZmFjZSDph4fmoLfvvInvvIwnICtcbiAgICAgICAgICAgICAgICAn5omA5Lul5Y2g55So546H55So55qE5piv44CM5LiK5LiA5qyh6K+35rGC55qE5a6e5rWL44CN4oCU4oCUIOWOi+e8qei/h+eahOivneWug+S8muWBj+mrmOS4gOeCueOAgicsXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmF0aW8gPSBwcm9qZWN0ZWQgIT09IG51bGwgJiYgd2luZG93ICE9PSBudWxsICYmIHdpbmRvdyA+IDAgPyBwcm9qZWN0ZWQgLyB3aW5kb3cgOiBudWxsO1xuICAgIGlmIChyYXRpbyAhPT0gbnVsbCAmJiByYXRpbyA+IDEpIHtcbiAgICAgICAgbm90ZXMucHVzaCgn6aKE5Lyw55qEIHByb21wdCDlt7Lnu4/otoXov4fnqpflj6PkuIrpmZDkuoYg4oCU4oCUIOS4i+S4gOasoeivt+axguimgeS5iOiiq+WOi+e8qe+8jOimgeS5iOS8muiiq+aLkuOAgicpO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRleHQgPSB7XG4gICAgICAgIHdpbmRvdyxcbiAgICAgICAgcHJvamVjdGVkLFxuICAgICAgICBwcmVzc3VyZSxcbiAgICAgICAgcmF0aW8sXG4gICAgICAgIHN5c3RlbTogYnJlYWtkb3duUmF3ID8gbnVtKGJyZWFrZG93blJhdy5zeXN0ZW1Ub2tlbnMpIDogbnVsbCxcbiAgICAgICAgdG9vbHM6IGJyZWFrZG93blJhdyA/IG51bShicmVha2Rvd25SYXcudG9vbHNUb2tlbnMpIDogbnVsbCxcbiAgICAgICAgbWVzc2FnZXM6IGJyZWFrZG93blJhdyA/IG51bShicmVha2Rvd25SYXcubWVzc2FnZVRva2VucykgOiBudWxsLFxuICAgIH07XG4gICAgaWYgKHByZXNzdXJlUmF3ID09PSBudWxsKSB7XG4gICAgICAgIG5vdGVzLnB1c2goJ+i/meadoeS8muivneayoeacieS4iuS4i+aWh+WNoOeUqOiusOW9le+8iOWug+WPr+iDveWkquaXp++8jOaIluiAhei/mOayoeWPkei/h+ivt+axgu+8ieOAgicpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChwcmVzc3VyZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaCgn6L+Z5p2h6K6w5b2V6YeM5rKh5pyJIHByb21wdCDkvqfnmoTlrp7mtYvvvIhwcm92aWRlciDov5jmsqHmiqXov4cgdXNhZ2XvvInvvIzmiYDku6Xnu5nkuI3lh7rljaDnlKjnjofjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAod2luZG93ID09PSBudWxsKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKCfkuI3nn6XpgZPnqpflj6PkuIrpmZDvvIhEU0gg6L+Y5rKh6K6w5YiwIHJlcXVlc3QvY29udGV4dCDpgqPmnaHorrDlvZXvvInvvIzmiYDku6XmsqHmnInljaDnlKjnjofvvIzlj6rmnInnu53lr7nph4/jgIInKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0gdG9rZW4g57Sv6K6hIC0tLS1cbiAgICBjb25zdCB1c2FnZVJhdyA9IHJvd1ZhbHVlKHJvd3MsICd0b2tlblVzYWdlJyk7XG4gICAgY29uc3QgdG90YWxzUmF3ID0gdXNhZ2VSYXcgPyB1c2FnZVJhdy50b3RhbHMgOiBudWxsO1xuICAgIGNvbnN0IHRvdGFscyA9IGJ1Y2tldHNPZih0b3RhbHNSYXcpO1xuICAgIGxldCBsYXN0OiBTZXNzaW9uVXNhZ2VbJ3VzYWdlJ11bJ2xhc3QnXSA9IG51bGw7XG4gICAgaWYgKHVzYWdlUmF3ICYmIHVzYWdlUmF3Lmxhc3QgJiYgdHlwZW9mIHVzYWdlUmF3Lmxhc3QgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IGxhc3RSYXcgPSB1c2FnZVJhdy5sYXN0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBidWNrZXRzID0gYnVja2V0c09mKGxhc3RSYXcuYnVja2V0cyk7XG4gICAgICAgIGlmIChidWNrZXRzKSB7XG4gICAgICAgICAgICBsYXN0ID0geyB0dXJuOiBudW0obGFzdFJhdy50dXJuKSA/PyAwLCBzdGVwOiBudW0obGFzdFJhdy5zdGVwKSA/PyAwLCBidWNrZXRzIH07XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKHVzYWdlUmF3ID09PSBudWxsKSBub3Rlcy5wdXNoKCfov5nmnaHkvJror53msqHmnIkgdG9rZW4g6K6h5pWw6K6w5b2V44CCJyk7XG5cbiAgICAvLyAtLS0tIOiKsei0ue+8iOWNleS9jeaBkuS4uioq576O5YWDKirvvJvmmL7npLrmiJDku4DkuYjluIHnp43nlLHotKbmnKzlhrPlrprvvIzop4EgYGF0dGFjaENvc3RMZWRnZXJg77yJIC0tLS1cbiAgICBjb25zdCBjb3N0UmF3ID0gcm93VmFsdWUocm93cywgJ2Nvc3RVc2FnZScpO1xuICAgIGNvbnN0IGNvc3RUb3RhbHMgPSBjb3N0UmF3ID8gKChjb3N0UmF3LnRvdGFscyA/PyBudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwpIDogbnVsbDtcbiAgICBjb25zdCBjb3N0QW1vdW50ID0gY29zdFRvdGFscyA/IG51bShjb3N0VG90YWxzLmNvc3QpIDogbnVsbDtcbiAgICBjb25zdCBjb3N0ID1cbiAgICAgICAgY29zdEFtb3VudCA9PT0gbnVsbFxuICAgICAgICAgICAgPyBudWxsXG4gICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgIGFtb3VudDogY29zdEFtb3VudCxcbiAgICAgICAgICAgICAgICAgIHByb3ZpZGVyOiBzdHIoY29zdFJhdz8ucHJvdmlkZXIpID8/ICcnLFxuICAgICAgICAgICAgICAgICAgbW9kZWw6IHN0cihjb3N0UmF3Py5tb2RlbCkgPz8gJycsXG4gICAgICAgICAgICAgIH07XG5cbiAgICAvLyAtLS0tIOS4iuS4i+aWh+WinumVv++8iOesrOS4ieaWuSBgZHNoLWNvbnRleHRgIOazqOWGjOeahOmCo+S4gOihjO+8m+acrCBwcm9maWxlIOS4jeaMguWugyDihpIg5bi45oCB5piv5rKh5pyJ77yJIC0tLS1cbiAgICAvL1xuICAgIC8vIOKaoCDov5nkuIDku70qKuS4jemineWkluivu+ebmCoq77ya5a6D5LiO55So6YeP5YW25a6D5Yeg6KGM5ZyoKirlkIzkuIDku70gSlNPTioqIOmHjO+8iGByZWFkU2Vzc2lvbkNhY2hlYFxuICAgIC8vIOS4gOasoeivu+ebmOWFqOe7me+8ie+8jOaJgOS7peWKoOi/meWdl+WvuSBJL08g55qE5b2x5ZON5piv6Zu244CCXG4gICAgY29uc3QgdGltZWxpbmVQYXJzZSA9IHBhcnNlQ29udGV4dFRpbWVsaW5lKHJvd3MuY29udGV4dFRpbWVsaW5lKTtcblxuICAgIC8vIC0tLS0g5Lya6K+d57uf6K6hIC0tLS1cbiAgICBjb25zdCBzdGF0c1JhdyA9IHJvd1ZhbHVlKHJvd3MsICdzZXNzaW9uU3RhdHMnKTsgICAgY29uc3Qgc2Vzc2lvbiA9IHtcbiAgICAgICAgdHVybnM6IHN0YXRzUmF3ID8gbnVtKHN0YXRzUmF3LnR1cm5zKSA6IG51bGwsXG4gICAgICAgIHN0ZXBzOiBzdGF0c1JhdyA/IG51bShzdGF0c1Jhdy5zdGVwcykgOiBudWxsLFxuICAgICAgICBsbG1Nczogc3RhdHNSYXcgPyBudW0oc3RhdHNSYXcubGxtTXMpIDogbnVsbCxcbiAgICAgICAgdG9vbE1zOiBzdGF0c1JhdyA/IG51bShzdGF0c1Jhdy50b29sTXMpIDogbnVsbCxcbiAgICAgICAgdHRmdE1zOiBzdGF0c1JhdyA/IG51bShzdGF0c1Jhdy50dGZ0TXMpIDogbnVsbCxcbiAgICAgICAgdHRmdFN0ZXBzOiBzdGF0c1JhdyA/IG51bShzdGF0c1Jhdy50dGZ0U3RlcHMpIDogbnVsbCxcbiAgICAgICAgZGVjb2RlTXM6IHN0YXRzUmF3ID8gbnVtKHN0YXRzUmF3LmRlY29kZU1zKSA6IG51bGwsXG4gICAgICAgIGRlY29kZVRva2Vuczogc3RhdHNSYXcgPyBudW0oc3RhdHNSYXcuZGVjb2RlVG9rZW5zKSA6IG51bGwsXG4gICAgfTtcblxuICAgIC8vIC0tLS0g5qih5Z6LIC8g5L6b5bqU5ZWG77ya5LyY5YWI6Iqx6LS56K6w5b2V77yI5a6D6L+eIHByb3ZpZGVyIOS4gOi1t+iusO+8ie+8jOmAgOWbnuaooeWei+mAieaLqemCo+S4gOihjCAtLS0tXG4gICAgY29uc3Qgc2VsZWN0aW9uUmF3ID0gcm93VmFsdWUocm93cywgJ21vZGVsU2VsZWN0aW9uJyk7XG4gICAgY29uc3QgbGFzdFVzZWQgPSBzZWxlY3Rpb25SYXcgPyAoKHNlbGVjdGlvblJhdy5sYXN0VXNlZCA/PyBudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwpIDogbnVsbDtcbiAgICBjb25zdCBtb2RlbCA9IHN0cihjb3N0UmF3Py5tb2RlbCkgPz8gKGxhc3RVc2VkID8gc3RyKGxhc3RVc2VkLm1vZGVsKSA6IG51bGwpO1xuICAgIGNvbnN0IHByb3ZpZGVyID0gc3RyKGNvc3RSYXc/LnByb3ZpZGVyKSA/PyAobGFzdFVzZWQgPyBzdHIobGFzdFVzZWQucHJvdmlkZXIpIDogbnVsbCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdXNhZ2U6IHtcbiAgICAgICAgICAgIGlkOiBtZXRhLmlkLFxuICAgICAgICAgICAgdmVyc2lvbixcbiAgICAgICAgICAgIHNlcSxcbiAgICAgICAgICAgIGJlaGluZCxcbiAgICAgICAgICAgIHVwZGF0ZWRBdDogdHlwZW9mIG1ldGEudXBkYXRlZEF0ID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUobWV0YS51cGRhdGVkQXQpID8gbWV0YS51cGRhdGVkQXQgOiAwLFxuICAgICAgICAgICAgaWRlbnRpdHk6IHtcbiAgICAgICAgICAgICAgICBjd2Q6IHN0cihpZGVudGl0eVJhdy5jd2QpLFxuICAgICAgICAgICAgICAgIHNlZWRlZCxcbiAgICAgICAgICAgICAgICBpbmhlcml0ZWRFdmVudHMsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgbW9kZWwsXG4gICAgICAgICAgICBwcm92aWRlcixcbiAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICB1c2FnZTogeyB0b3RhbHMsIGxhc3QgfSxcbiAgICAgICAgICAgIGNvc3QsXG4gICAgICAgICAgICAvLyDov5nkuKTkuKrlrZfmrrXmnaXoh6oqKuWPpuS4gOS4quaWh+S7tioq77yI6LSm5pys77yJ77yM5omA5Lul6L+Z6YeM5Y+q5Y2g5L2N77yM55SxIGBhdHRhY2hDb3N0TGVkZ2VyYCDloavjgIJcbiAgICAgICAgICAgIGNvc3REaXNwbGF5OiBudWxsLFxuICAgICAgICAgICAgY29zdExlZGdlcjogbnVsbCxcbiAgICAgICAgICAgIGNvc3ROb3RlOiBudWxsLFxuICAgICAgICAgICAgY29zdE1vdW50ZWQ6IG51bGwsXG4gICAgICAgICAgICBjb3N0QnVuZGxlOiBDT1NUX01FVEVSX0JVTkRMRSxcbiAgICAgICAgICAgIC8vIOi/meS4gOihjO+8iGBjb250ZXh0VGltZWxpbmVg77yJ5LiO6Iqx6LS56YKj5Yeg6KGM5LiN5LiA5qC377ya5a6DKirlkIzkuIDmrKHor7vnm5gqKuWwseaLv+WIsOS6hu+8jFxuICAgICAgICAgICAgLy8g5omA5Lul6L+Z6YeM55u05o6l57uZ57uT5p6c77yM5LiN6ZyA6KaB56ys5LqM5qyh6K+755uY44CB5Lmf5rKh5pyJIGBhdHRhY2gqYCDpgqPkuIDmraXjgIJcbiAgICAgICAgICAgIHRpbWVsaW5lOiB0aW1lbGluZVBhcnNlLnRpbWVsaW5lLFxuICAgICAgICAgICAgdGltZWxpbmVOb3RlOiB0aW1lbGluZVBhcnNlLm5vdGUsXG4gICAgICAgICAgICBzZXNzaW9uLFxuICAgICAgICAgICAgbm90ZXMsXG4gICAgICAgIH0sXG4gICAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDor7vnm5hcblxuLyoqXG4gKiDor7vkuIDmnaHkvJror53nmoTnvJPlrZjorrDlvZXvvIgqKuS4gOasoeivu+ebmO+8jOeUqOmHj+S4jui/m+W6puS4gOi1t+e7mSoq77yJ77yM6aG65omL6KGl5LiA5qyh6LSm5pys6YeM55qE6Iqx6LS55Y+j5b6E44CCXG4gKlxuICog5Li65LuA5LmI5ZCI5oiQ5LiA5qyh6K+777ya5Lik6ICF5ZyoKirlkIzkuIDku73mlofku7YqKumHjO+8iOWkp+eahOiDveWIsCA0MDArIEtC77yJ77yM5YiG5Lik5qyh6K+75bCx5piv5oqK5ZCM5LiA5Lu9XG4gKiBKU09OIOino+aekOS4pOmBje+8m+iAjOS4lOS4pOWdl+eahOOAjOawtOS9jSAvIOiQveWQjuWkmuWwkSAvIOWGmeS6juS9leaXtuOAjeacrOadpeWwseaYr+WQjOS4gOe7hOS6i+WuniDigJTigJRcbiAqIOWIhuW8gOivu+S8muWHuueOsOOAjOeUqOmHj+ivtOiQveWQjiAxMiDmnaHjgIHov5vluqbor7TokL3lkI4gMyDmnaHjgI3ov5nnp43oh6rnm7jnn5vnm77nmoTnlLvpnaLjgIJcbiAqXG4gKiDimqAg6Iqx6LS56YKj5Z2X6L+Y6KaB6K+7KirnrKzkuozkuKrmlofku7YqKu+8iGBkc2gtY29zdC1tZXRlcmAg55qE6LSm5pys77yM5Yeg55m+IEtC77yJ77ya6YeR6aKd5Zyo57yT5a2Y6YeM44CBXG4gKiAqKuaYvuekuuaIkOS7gOS5iOW4geenjSoq5Zyo6LSm5pys6YeM44CC6LSm5pys6K+75LiN5Yiw5Y+q5piv5bCR5LiA5bGC5pi+56S65Y+j5b6E77yM57ud5LiN6K6p55So6YeP6YKj5Y2K5aSx6LSl44CCXG4gKlxuICog5LiJ56eN44CM5rKh5pyJ44CN6KaB5YiG5riF5qWa77yI6Z2i5p2/5LiK55qE6K+d5a6M5YWo5LiN5LiA5qC377yJ77yaXG4gKiAtICoq5rKh5om+5YiwKirvvJrov5nmnaHkvJror53ov5jmsqHokL3ov4fmo4Dmn6XngrnvvIjmlrDkvJror53nrKzkuIDova7kuYvliY3jgIHmiJbogIXnqbrkvJror53vvInvvJtcbiAqIC0gKiror7vkuI3liqgqKu+8muaWh+S7tuWcqOS9hiBKU09OIOWdj+S6hu+8iOWGmeWIsOS4gOWNiuaWreeUte+8n++8ieKAlOKAlCDkuIrmuLjnmoTnrZbnlaXmmK/jgIzlpIfku73lubbot7Pov4fjgI3vvIxcbiAqICAg5omA5Lul5q2j5bi45LiN5Lya5Y+R55Sf77yM5Y+R55Sf5LqG5bCx6KaB6K+05Ye65p2l77ybXG4gKiAtICoq5b2i54q25LiN6K6k6K+GKirvvJpEU0gg5o2i5LqG57yT5a2Y5qC85byP77yIYG5vcm1hbGl6ZVVzYWdlUmVjb3JkYCDkvJrnu5nor53vvInjgIJcbiAqXG4gKiBAcGFyYW0gc2Vzc2lvbklkIC0g5Lya6K+dIGlk77yIPSDnvJPlrZjmlofku7blkI3vvJtgW0EtWmEtejAtOS5fLV1g77yM6KeBIGBTQUZFX0lEYO+8ieOAglxuICogQHBhcmFtIG9wdGlvbnMubGl2ZVNlcSAtIOW9k+WJjeWunuaXtuawtOS9je+8iOWuv+S4u+S7juS6i+S7tua1geS4iuiusOeahO+8ie+8jOeUqOadpeeulyBgYmVoaW5kYOOAglxuICogQHJldHVybnMgYHtvaywgdXNhZ2U/LCBwcm9ncmVzcz8sIGVycm9yP31g77yb5aSx6LSl5LiN5oqb44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkU2Vzc2lvbkNhY2hlKFxuICAgIHNlc3Npb25JZDogc3RyaW5nLFxuICAgIG9wdGlvbnM6IHsgbGl2ZVNlcT86IG51bWJlciB9ID0ge30sXG4pOiBQcm9taXNlPFNlc3Npb25DYWNoZVJlc3VsdD4ge1xuICAgIGNvbnN0IGlkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQudHJpbSgpIDogJyc7XG4gICAgaWYgKCFpZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+S8muivnSBpZCDmmK/nqbrnmoQnIH07XG4gICAgaWYgKGlkID09PSAnLicgfHwgaWQgPT09ICcuLicgfHwgIVNBRkVfSUQudGVzdChpZCkpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOS8muivnSBpZCDkuI3lg4/kuIDkuKogaWTvvJoke2lkLnNsaWNlKDAsIDQwKX1gIH07XG4gICAgfVxuXG4gICAgY29uc3QgZmlsZSA9IHVzYWdlUmVjb3JkUGF0aChpZCk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICBsZXQgdXBkYXRlZEF0ID0gMDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgc3RhdChmaWxlKTtcbiAgICAgICAgdXBkYXRlZEF0ID0gaW5mby5tdGltZU1zO1xuICAgICAgICB0ZXh0ID0gYXdhaXQgcmVhZEZpbGUoZmlsZSwgJ3V0ZjgnKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCBjb2RlID0gKGVycm9yIGFzIHsgY29kZT86IHN0cmluZyB9KS5jb2RlO1xuICAgICAgICBpZiAoY29kZSA9PT0gJ0VOT0VOVCcpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfov5nmnaHkvJror53ov5jmsqHmnInmipXlvbHnvJPlrZjorrDlvZXvvIhEU0gg5Lya5Zyo5Yib5bu6IC8g5q+P6L2u57uT5p2fIC8g5YWz6Zet5pe25YaZ5LiA5qyh5qOA5p+l54K577yJ44CCJyB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDor7vkuI3kuobmipXlvbHnvJPlrZjvvJoke2Rlc2NyaWJlKGVycm9yKX1gIH07XG4gICAgfVxuXG4gICAgbGV0IHJhdzogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgICByYXcgPSBKU09OLnBhcnNlKHRleHQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDmipXlvbHnvJPlrZjkuI3mmK/lkIjms5UgSlNPTu+8iCR7ZGVzY3JpYmUoZXJyb3Ipfe+8ieKAlOKAlCDmlofku7bvvJoke2ZpbGV9YCB9O1xuICAgIH1cblxuICAgIGNvbnN0IHVzYWdlID0gbm9ybWFsaXplVXNhZ2VSZWNvcmQocmF3LCB7IGlkLCB1cGRhdGVkQXQsIGxpdmVTZXE6IG9wdGlvbnMubGl2ZVNlcSB9KTtcbiAgICBpZiAoIXVzYWdlLm9rIHx8ICF1c2FnZS51c2FnZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogdXNhZ2UuZXJyb3IgPz8gJ+i/meS7veiusOW9lemHjOivu+S4jeWHuueUqOmHjycgfTtcbiAgICAvKipcbiAgICAgKiDov5vluqborqTkuI3lh7rlvaLnirYqKuS4jeeul+aVtOS7veWksei0pSoq77ya55So6YeP5piv5Li75L2T77yI5Y2g55So546H5Yaz5a6a6Z2i5p2/5LiK6YKj6aKXIGNoaXAg5pi+5LiN5pi+56S677yJ77yMXG4gICAgICog6L+b5bqm57y65LqG5bCx5Y+q5piv44CM5riF5Y2VIC8g5Zue5ZCI55uu5b2V6L+Z5LiA5Z2X56m6552A44CN77yM5a6/5Li75Lya54Wn5a6e6K+077yI5LiN5piv6Z2Z6buY56m6552A77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgcHJvZ3Jlc3MgPSBwcm9ncmVzc09mKHJhdyk7XG4gICAgLyoqXG4gICAgICog6Iqx6LS555qEKirmmL7npLrlj6PlvoQqKuWcqOesrOS6jOS4quaWh+S7tumHjO+8iGBkc2gtY29zdC1tZXRlcmAg55qE6LSm5pys77yJ77ya5biB56eN44CB5rGH546H44CB5bCP5pWw5L2N77ybXG4gICAgICog6L+Y6aG65omL6K+75LiA5LiLIHByb2ZpbGUg5riF5Y2V77yI6YKj6YeM6Z2i5YaZ552AKirov5nkuKogcHJvZmlsZSDliLDlupXmjILmsqHmjIIqKumCo+S4quesrOS4ieaWuSBidW5kbGUg4oCU4oCUXG4gICAgICog44CM5rKh6KOF44CN5LiO44CM5Lya6K+d5aSq6ICB44CN5Zyo55WM6Z2i5LiK5piv5Lik5Y+l5a6M5YWo5LiN5ZCM55qE6K+d77yJ44CCXG4gICAgICog5Lik6ICF6YO9KirkuI3nrpfmlbTku73lpLHotKUqKiDigJTigJQg6K+75LiN5Yiw5bCx5oyJ576O5YWD5Y6f5YC855S744CB6K+d5pyv6YCA5Zue44CM5YiG5LiN5riF44CN77yM5bm25oqK5Y6f5Zug5YaZ6L+bIG5vdGVz44CCXG4gICAgICog6L+Z5LiA5q2l5Y+q5Zyo6L+Z5LiA5p2h5Lya6K+dKirnnJ/nmoTor7vlh7rmnaXkuoYqKuS5i+WQjuaJjeWBmu+8iOivu+Wksei0peaXtuayoeW/heimgeWGjeWOu+ivu+mCo+S4pOS4quaWh+S7tu+8ieOAglxuICAgICAqL1xuICAgIGNvbnN0IFtsZWRnZXIsIG1vdW50ZWRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW3JlYWRDb3N0TGVkZ2VyKGlkKSwgcmVhZENvc3RNb3VudCgpXSk7XG4gICAgYXR0YWNoQ29zdExlZGdlcih1c2FnZS51c2FnZSwgbGVkZ2VyLCBtb3VudGVkKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdXNhZ2U6IHVzYWdlLnVzYWdlLCAuLi4ocHJvZ3Jlc3MgPyB7IHByb2dyZXNzOiBwcm9ncmVzcy5wcm9ncmVzcyB9IDoge30pIH07XG59XG5cbi8qKlxuICog6K+75LiA5p2h5Lya6K+d55qE55So6YeP77yIYHJlYWRTZXNzaW9uQ2FjaGVgIOeahOiWhOWMheijhe+8ieOAglxuICpcbiAqIOeVmeedgOi/meS4quWFpeWPo+eahOeQhueUse+8mueUqOmHj+eahOWPo+W+hOaciSA2MCsg5p2h5pat6KiA55uv552A77yIYHNjcmlwdHMvdmVyaWZ5LXN0YXRzLmpzYO+8ie+8jFxuICog6YKj5Lqb5pat6KiA5YWz5b+D55qE5piv44CM5b2S5LiA5YyW5LmL5ZCO5piv5LiN5piv6L+Z5Yeg5Liq5pWw44CN77yM5LiN6K+l6KKr6L+b5bqm6YKj5LiA5Y2K55qE5a2X5q615Y+Y5YyW54m16L+e44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkU2Vzc2lvblVzYWdlKFxuICAgIHNlc3Npb25JZDogc3RyaW5nLFxuICAgIG9wdGlvbnM6IHsgbGl2ZVNlcT86IG51bWJlciB9ID0ge30sXG4pOiBQcm9taXNlPFNlc3Npb25Vc2FnZVJlc3VsdD4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlYWRTZXNzaW9uQ2FjaGUoc2Vzc2lvbklkLCBvcHRpb25zKTtcbiAgICByZXR1cm4gcmVzdWx0Lm9rICYmIHJlc3VsdC51c2FnZSA/IHsgb2s6IHRydWUsIHVzYWdlOiByZXN1bHQudXNhZ2UgfSA6IHsgb2s6IGZhbHNlLCBlcnJvcjogcmVzdWx0LmVycm9yIH07XG59XG5cbi8qKiDmiorlvILluLjmlLbmlZvmiJDkuIDlj6Xor53jgIIgKi9cbmZ1bmN0aW9uIGRlc2NyaWJlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xufVxuIl19