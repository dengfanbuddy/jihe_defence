/**
 * Agent 宿主：托管「被 fork 出来的 DSH 子进程」，并把它的三条流接起来。
 *
 * ```
 *                    ┌─────────────── DSH 子进程（系统 node，--profile cocos）──────────────┐
 *   面板（渲染进程）  │                                                                      │
 *      ▲  ▲           │  stdout ── SDK JSON-RPC（initialize / session.prompt / session.event）│
 *      │  │ broadcast │  stderr ── 插件日志（诊断尾巴，不进上下文）                          │
 *      │  └───────────┤  ipc    ── 原生工具调用（cocos_execute_code → 本进程 → 本扩展沙箱/场景脚本）  │
 *      │              └──────────────────────────────────────────────────────────────────────┘
 *      └── Editor.Message.request/get-events（轮询兜底）
 *
 * ## 三条口径
 *
 * 1. **stdout 是协议，stderr 是日志，ipc 是工具**。三者绝不混用：
 *    stdout 上有杂质行只会计数跳过（见 `SdkClient`），不会打断对话。
 * 2. **面板两条路都能拿到更新**：广播（快，但 `__protected__` 是保护接口）+ 轮询
 *    `get-events`（慢一点，但一定到）。两条路合并进同一份 `Map<seq, Entry>`，靠 `seq`/`rev` 幂等。
 * 3. **子进程一定要收干净**：`unload()`、编辑器退出、agent 自己 `exit`，三条路都要落到
 *    同一个 `cleanup()`；否则会留下孤儿 node 进程占着 CPU。
 */

import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';

import { COCOS_IPC_METHODS } from './cocos-tools';
import {
    BROADCAST_CHANNEL,
    IPC_TAG,
    PROFILE_NAME,
    type ActivityView,
    type AgentSnapshot,
    type AgentStatus,
    type CommandView,
    type Entry,
    type EntryImage,
    type EntryKind,
    type EventsPayload,
    type HistoryDeleteView,
    type HistoryExportView,
    type HistorySearchHitView,
    type HistorySearchView,
    type HistorySnippetView,
    type HistorySessionView,
    type HistoryView,
    type HostUpdateView,
    type JobView,
    type SessionUsage,
    type InteractionAnswerItem,
    type InteractionApprovalOutcome,
    type InteractionDecision,
    type InteractionQuestion,
    type InteractionQuestionOption,
    type InteractionView,
    type ReferenceCandidate,
    type SessionKind,
    type SubagentView,
    type GoalView,
    type ProgressView,
    type TodoView,
    type TurnView,
    type ToolEntry,
} from './constants';
import {
    deleteHistory,
    exportHistory,
    listHistory,
    loggedTitleOf,
    readHistory,
    searchHistory,
    titleOfEvents,
    type HistoryExportFormat,
    type HistorySearchOptions,
    type HistorySession,
} from './history';
import { formatBytes, type ValidImage } from './images';
import { resolveRuntime, type ResolvedRuntime } from './paths';
import { SdkClient } from './sdk-client';
import { getSettings } from './settings';
import { parseGoalChange, parseTodos, readSessionCache, type SessionCacheResult, type SessionProgress } from './stats';

/**
 * 随扩展发布的通用 skill 目录（`<扩展根>/skills`）。
 *
 * 为什么要显式注入：DSH 的 `@deepseek-ai/dsh-skill-filesystem` 会读环境变量
 * `DSH_BUNDLED_SKILL_DIR` 并把它当成 **bundled 根**扫描（`rank = 600`，全表最低优先级）。
 * 于是「引擎/编辑器操作的通用知识」**跟着插件走** —— 换个工程装上就有，
 * 而工程自己的 `.agents/skills/`（rank 200）、用户级 `~/.agents/skills/`（rank 500）仍然优先。
 *
 * ⚠ **同名是「整体覆盖」而不是「合并」**（`dsh-skill` 的 `collectLayer` 按 rank 升序 + 按名字去重），
 * 所以消费工程里**不要**再放一个同名的 `cocos-editor-ops` —— 那会把插件这份整个吃掉。
 * 完整口径见 `skills/README.md`。
 */
function bundledSkillDir(): string {
    return join(__dirname, '..', 'skills');
}

/** 转写保留上限（超出丢最老的）。面板只看最近这些，够用且不涨内存。 */
const MAX_ENTRIES = 600;

/** stderr 诊断尾巴保留行数。 */
const MAX_STDERR_LINES = 40;

/** 工具结果在**面板上**的截断长度（模型拿到的仍是完整结果）。 */
const TOOL_OUTPUT_DISPLAY_LIMIT = 4000;

/** 广播节流：流式增量可能很密，攒到一个间隔再推一次。 */
const FLUSH_INTERVAL_MS = 120;

/**
 * 「面板还在吗」的判定窗口（毫秒）。
 *
 * 面板空闲时 800ms 一跳（跑动时 300ms），所以 60s 是个极宽的判据 —— 它只用来区分
 * 「面板开着，只是人还没点」和「根本没人在看」。后者必须立刻放行（等于没人能回答），
 * 否则模型会一直卡在那一问上，直到工具调用超时。
 */
const PANEL_QUIET_MS = 60_000;

/** 交互载荷的长度上限（面板是渲染进程，插件也可能出错 —— 别让一条脏数据把 UI 撑死）。 */
const INTERACTION_LIMITS = { questions: 8, options: 12, text: 4_000, detail: 40_000 };

/** 一次广播携带的条目上限（超出的靠轮询补齐，避免单帧过大）。 */
const FLUSH_BATCH_LIMIT = 60;

/**
 * 回合结束后隔多久去读一次用量（毫秒）。
 *
 * ⚠ **不能立刻读**：缓存恰好在 `turn/end` 写一次检查点，但那是 **agent 进程里**的监听器干的活，
 * 与我们收到的 `session/event` 通知是两条路，谁先到没有保证。立刻读有可能读到「上一条事件为止」
 * 的账 —— 用量数字通常不受影响，但 `sessionStats.turns` 会少一个回合，看着就像「回合数不对」。
 * 这一点实测不出来（本机两种顺序都可能），所以用一个「等一拍」的固定延迟兜住，
 * 并在面板上如实显示水位与落后条数；真要立刻看，抽屉里有「刷新」。
 */
const USAGE_REFRESH_DELAY_MS = 700;

/**
 * 跑完一条斜杠命令之后补读用量的两个时刻（毫秒）。
 *
 * 为什么是两个：`/compact` 这类命令**立刻**改了上下文，但检查点是**攒着写**的
 * （本 profile 配的是每 200 条事件或每 5 秒），所以第一个点读到的是旧数、第二个点才是新数。
 * 不补这一手的话，用户压缩完会盯着一个没变的占用率发呆。
 */
const USAGE_REFRESH_AFTER_COMMAND_MS = [900, 6_000];

/** 面板/其它监听者收到的推送（类型定义在 constants，面板共用同一份）。 */
export type { HostUpdateView as HostUpdate } from './constants';
/** 从 ContentBlock[] 里取纯文本。 */
function textOfBlocks(blocks: unknown): string {
    if (!Array.isArray(blocks)) return '';
    const parts: string[] = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const text = (block as { text?: string }).text;
            if (typeof text === 'string' && text) parts.push(text);
        }
    }
    return parts.join('\n');
}

/**
 * 从 ContentBlock[] 里取图片的**元数据**（回放历史时用）。
 *
 * 两种形状都要认，理由和 `toolResultOf` 一样（DSH 升过版）：
 *
 * | 来源 | 图片块 |
 * |---|---|
 * | 我们发出去的（面板 echo） | `{type:'image', data, mimeType}` —— 还没进附件库 |
 * | 会话日志里记下来的 | `{type:'image', attachment:{mediaType, bytes, width, height, name?}}` |
 *
 * 日志里那条**没有像素**（字节另存在附件库），所以面板上历史消息只能画「图名 + 尺寸」，
 * 这也正是 `EntryImage` 只有元数据的原因。
 *
 * @param blocks - `user/message` 的 `data.content`。
 * @returns 图片元数据列表（顺序即消息里的顺序）。
 */
function imagesOfBlocks(blocks: unknown): EntryImage[] {
    if (!Array.isArray(blocks)) return [];
    const out: EntryImage[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as {
            type?: string;
            mimeType?: string;
            attachment?: { mediaType?: string; bytes?: number; width?: number; height?: number; name?: string };
        };
        if (typed.type !== 'image') continue;
        const ref = typed.attachment;
        out.push({
            name: ref?.name,
            mimeType: ref?.mediaType ?? typed.mimeType,
            bytes: typeof ref?.bytes === 'number' ? ref.bytes : undefined,
            width: typeof ref?.width === 'number' ? ref.width : undefined,
            height: typeof ref?.height === 'number' ? ref.height : undefined,
        });
    }
    return out;
}

/** 一张待发送的图 → SDK 的内容块（`data` 必须是规范 base64，见 `source/images.ts`）。 */
function imageBlockOf(image: ValidImage): Record<string, unknown> {
    const block: Record<string, unknown> = { type: 'image', data: image.data, mimeType: image.mimeType };
    if (image.name) block.name = image.name;
    return block;
}

/** 把异常/未知收敛成一句话。 */
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 从 `tool/result` 的 message 里取「文本 + 是不是错误」—— **两种形状都要认**。
 *
 * 这不是洁癖，是实测撞出来的：同一天的两个会话日志形状不一样（DSH 升过版）。
 *
 * | 来源 | `message.content` |
 * |---|---|
 * | 实时事件 / 老日志（`version: 0`） | `[ { type: 'tool-result', toolCallId, content: [块…], isError } ]` —— 内容在**里层** |
 * | 新日志（`version: 4`） | `[ { type: 'text', text } ]` —— 内容**就是**这一层 |
 *
 * 只认前一种的话，回放新日志时**每张工具卡片的结果都是空的**（`done: true` 却一个字没有，
 * 看起来像工具没输出），而且不报错。`isError` 同理：新形状挂在外层 `message.isError`。
 *
 * @param message - `data.message`。
 * @returns 文本与错误标记。
 */
function toolResultOf(message: unknown): { text: string; isError: boolean } {
    const typed = (message ?? {}) as { content?: unknown; isError?: unknown };
    const content = typed.content;
    if (!Array.isArray(content)) return { text: '', isError: typed.isError === true };

    const wrapper = content[0] as { type?: string; content?: unknown; isError?: unknown } | undefined;
    const blocks = wrapper?.type === 'tool-result' && Array.isArray(wrapper.content) ? wrapper.content : content;
    return {
        text: textOfBlocks(blocks),
        isError: wrapper?.isError === true || typed.isError === true,
    };
}

/**
 * 把插件送来的交互载荷收敛成面板能安全渲染的形状。
 *
 * 为什么不信插件：它是我们自己写的，但**载荷的源头是运行时**（模型给的 `detail` 可能
 * 就是几万字的计划、选项可能几十个），而面板是 DOM 渲染 —— 一条超长文本能把窄面板撑爆。
 * 这里只做「截断 + 丢非法项」，不做语义判断（语义在插件与运行时那两层）。
 *
 * @param raw - 插件给的 `interaction` 对象。
 * @param id - 帧上的交互 id（**以帧为准**，不信任载荷里的那份）。
 * @returns 收敛后的视图；形状根本不对时返回 null。
 */
function sanitizeInteraction(raw: unknown, id: string): InteractionView | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const kind = source.kind === 'approval' ? 'approval' : source.kind === 'question' ? 'question' : null;
    if (!kind) return null;

    const cut = (value: unknown, limit: number): string | undefined => {
        if (typeof value !== 'string' || !value) return undefined;
        return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
    };

    const view: InteractionView = {
        id,
        kind,
        at: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : Date.now(),
    };
    const agentId = cut(source.agentId, 128);
    if (agentId) view.agentId = agentId;
    const sessionId = cut(source.sessionId, 128);
    if (sessionId) view.sessionId = sessionId;

    if (kind === 'approval') {
        view.toolName = cut(source.toolName, 200) ?? '(未知工具)';
        const callId = cut(source.callId, 128);
        if (callId) view.callId = callId;
        const reason = cut(source.reason, INTERACTION_LIMITS.text);
        if (reason) view.reason = reason;
        return view;
    }

    const questions = Array.isArray(source.questions) ? source.questions.slice(0, INTERACTION_LIMITS.questions) : [];
    const items: InteractionQuestion[] = [];
    for (const entry of questions) {
        if (!entry || typeof entry !== 'object') continue;
        const question = entry as Record<string, unknown>;
        const questionId = cut(question.id, 128);
        const text = cut(question.question, INTERACTION_LIMITS.text);
        if (!questionId || !text) continue;
        const item: InteractionQuestion = { id: questionId, question: text };
        const detail = cut(question.detail, INTERACTION_LIMITS.detail);
        if (detail) item.detail = detail;
        const header = cut(question.header, 200);
        if (header) item.header = header;
        if (Array.isArray(question.options)) {
            const options: InteractionQuestionOption[] = [];
            for (const option of question.options.slice(0, INTERACTION_LIMITS.options)) {
                if (!option || typeof option !== 'object') continue;
                const label = cut((option as Record<string, unknown>).label, 200);
                if (!label) continue;
                const description = cut((option as Record<string, unknown>).description, 500);
                options.push({ label, ...(description === undefined ? {} : { description }) });
            }
            if (options.length > 0) item.options = options;
        }
        if (question.multiSelect === true) item.multiSelect = true;
        const intent = question.intent && typeof question.intent === 'object' ? (question.intent as Record<string, unknown>) : null;
        if (intent) {
            const intentKind = cut(intent.kind, 64);
            const approve = cut(intent.approve, 200);
            if (intentKind && approve) item.intent = { kind: intentKind, approve };
        }
        items.push(item);
    }
    // 一道题都没有的 question 交互是坏的：登记了也没法回答
    if (items.length === 0) return null;
    view.questions = items;
    return view;
}

/**
 * 转写里那条「这里问过我」的 note（**只描述，不代替对话框**）。
 *
 * @param view - 已收敛的交互。
 * @returns 一行文字。
 */
function describeInteraction(view: InteractionView): string {
    if (view.kind === 'approval') {
        return `⚠ 需要你批准：${view.toolName ?? '这次操作'}${view.reason ? `\n${view.reason}` : ''}`;
    }
    const first = view.questions?.[0];
    const header = first?.header ? `【${first.header}】` : '';
    const count = view.questions && view.questions.length > 1 ? `（共 ${view.questions.length} 问）` : '';
    return `❓ 模型在等你回答：${header}${first?.question ?? ''}${count}`;
}

/**
 * 校验面板送回来的答案（面板是渲染进程，它说的不可信）。
 *
 * @param raw - `[{id, selected?, custom?}]`。
 * @returns 合法条目；空条目被丢掉（空数组 = 这次回答无效）。
 */
function normalizeAnswerItems(raw: unknown): InteractionAnswerItem[] {
    if (!Array.isArray(raw)) return [];
    const out: InteractionAnswerItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        const selected = Array.isArray(item.selected)
            ? item.selected.filter((value): value is string => typeof value === 'string' && value !== '').slice(0, INTERACTION_LIMITS.options)
            : [];
        const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.slice(0, INTERACTION_LIMITS.text) : undefined;
        if (selected.length === 0 && custom === undefined) continue;
        out.push({ id, selected, ...(custom === undefined ? {} : { custom }) });
    }
    return out.slice(0, INTERACTION_LIMITS.questions);
}

/** 斜杠命令列表的跨进程上限（面板是个窄抽屉，再多也画不下）。 */
const COMMAND_LIMIT = 120;

/** `@` 候选的跨进程上限（与提供方自己的 `maxResults` 相互独立）。 */
const REFERENCE_LIMIT = 40;

/**
 * 收敛插件送回的斜杠命令列表。
 *
 * 口径同其它跨进程载荷：**只留面板画得下的字段**、逐项截断、整表设上限。
 * 名字不合法的整条丢掉（命令名是 `/` 后面那一段，面板要靠它拼命令行）。
 *
 * @param raw - 插件回的 `commands` 数组。
 * @returns 干净的命令视图数组。
 */
function normalizeCommands(raw: unknown): CommandView[] {
    if (!Array.isArray(raw)) return [];
    const out: CommandView[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        // 命令名的合法字符集由注册表保证（小写字母/数字/_/-）；这里只做长度与形状的兜底，
        // 别自己实现一套语法 —— 语法在 `ctx.commands` 那边，抄一份必然漂移。
        if (!name || name.length > 40 || /\s/.test(name)) continue;
        const view: CommandView = {
            name,
            description: typeof item.description === 'string' ? item.description.slice(0, 200) : '',
        };
        if (typeof item.hint === 'string' && item.hint) view.hint = item.hint.slice(0, 80);
        if (item.images === true) view.images = true;
        out.push(view);
        if (out.length >= COMMAND_LIMIT) break;
    }
    return out;
}

/**
 * 收敛插件送回的 `@` 候选。
 *
 * @param raw - 插件回的 `candidates` 数组。
 * @returns 干净的候选数组。
 */
function normalizeReferences(raw: unknown): ReferenceCandidate[] {
    if (!Array.isArray(raw)) return [];
    const out: ReferenceCandidate[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const path = typeof item.path === 'string' ? item.path.trim() : '';
        if (!path || path.length > 400) continue;
        out.push({ path, kind: item.kind === 'directory' ? 'directory' : 'file' });
        if (out.length >= REFERENCE_LIMIT) break;
    }
    return out;
}

/** 后台任务与子 agent 的跨进程上限（面板是个窄抽屉，再多也画不下）。 */
const JOB_LIMIT = 40;
const SUBAGENT_LIMIT = 40;

/** job 状态的合法值 + 一个 `unknown`（**不认识的绝不猜**，见 `JobView.status` 的注释）。 */
const JOB_STATUSES = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);

/**
 * 收敛插件送回的「活动」两块（后台任务 + 子 agent）。
 *
 * 与斜杠命令、`@` 候选同一条纪律：**只留面板画得下的字段**、逐项截断、整表设上限。
 * 这里另外做三件插件不该管的事：
 * 1. **数值字段一律过 `num()`**（跨进程来的东西当输入不可信：`NaN` / 字符串 / 缺失都可能）；
 * 2. **认不出的状态落到 `unknown`**（照实说出来，别猜成 running ——「看起来在跑」比「不知道」更糟）；
 * 3. 把「服务缺失」与「列不出来」的原因**各归各位**地写进 `ActivityView`。
 *
 * @param raw - 插件 `jobs/list` + `subagents/list` 的两次回执。
 * @returns 面板要画的那一份（**永远返回对象**，哪怕两条都失败）。
 */
function normalizeActivity(
    jobsRaw: Record<string, unknown> | null,
    subsRaw: Record<string, unknown> | null,
    notes: string[],
    at: number,
): ActivityView {
    const jobs: JobView[] = [];
    for (const entry of Array.isArray(jobsRaw?.jobs) ? (jobsRaw?.jobs as unknown[]) : []) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        const status = typeof item.status === 'string' ? item.status : '';
        jobs.push({
            id,
            kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : '',
            label: typeof item.label === 'string' ? item.label.slice(0, 400) : '',
            status: (JOB_STATUSES.has(status) ? status : 'unknown') as JobView['status'],
            detail: typeof item.detail === 'string' ? item.detail.slice(0, 200) : null,
            startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? item.startedAt : null,
            finishedAt: typeof item.finishedAt === 'number' && Number.isFinite(item.finishedAt) ? item.finishedAt : null,
            ownerSessionId: typeof item.ownerSessionId === 'string' ? item.ownerSessionId : '',
            depth: typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : null,
        });
        if (jobs.length >= JOB_LIMIT) break;
    }

    const subagents: SubagentView[] = [];
    for (const entry of Array.isArray(subsRaw?.subagents) ? (subsRaw?.subagents as unknown[]) : []) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        const status = typeof item.status === 'string' ? item.status : '';
        subagents.push({
            id,
            kind: item.kind === 'diagnostic' ? 'diagnostic' : 'child',
            label: typeof item.label === 'string' ? item.label.slice(0, 200) : '',
            mode: item.mode === 'continuable' ? 'continuable' : 'one-shot',
            depth: typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : null,
            hasChildren: item.hasChildren === true,
            activity: item.activity === 'running' ? 'running' : 'inactive',
            reason: typeof item.reason === 'string' ? item.reason.slice(0, 60) : null,
            status: status === 'running' ? 'running' : status === 'idle' ? 'idle' : 'ready',
        });
        if (subagents.length >= SUBAGENT_LIMIT) break;
    }

    // 插件自己报的「截断了 / 某个拥有者列不出来」也是说明的一部分，原样带上去
    if (jobsRaw?.truncated === true) {
        notes.push(`后台任务只画了最近 ${JOB_LIMIT} 条（一共 ${typeof jobsRaw.total === 'number' ? jobsRaw.total : '?'} 条）。`);
    }
    for (const error of Array.isArray(jobsRaw?.errors) ? (jobsRaw?.errors as unknown[]) : []) {
        if (typeof error === 'string' && error) notes.push(`有一个会话的后台任务列不出来：${error.slice(0, 200)}`);
    }
    if (subsRaw?.truncated === true) {
        notes.push(`子 agent 只画了前 ${SUBAGENT_LIMIT} 个（一共 ${typeof subsRaw.total === 'number' ? subsRaw.total : '?'} 个）。`);
    }

    return {
        jobs,
        subagents,
        jobsAvailable: jobsRaw?.available === true,
        subagentsAvailable: subsRaw?.available === true,
        jobsReason: typeof jobsRaw?.reason === 'string' ? jobsRaw.reason : null,
        subagentsReason: typeof subsRaw?.reason === 'string' ? subsRaw.reason : null,
        notes,
        at,
    };
}

/** DSH 子进程的宿主。整个扩展只有这一个实例（`main.ts` 里持有）。 */
export class DshHost {

    private child: ChildProcess | null = null;
    private client: SdkClient | null = null;
    private status: AgentStatus = 'stopped';
    private running = false;
    private sessionId: string | null = null;
    private lastBootMs: number | null = null;
    private lastError: string | null = null;
    private runtime: ResolvedRuntime = { nodeExe: null, nodeSource: '未探测', dshBin: null, dshSource: '未探测' };

    /**
     * 当前 sessionId 的来历。
     *
     * - `sdk`：SDK 协议 `session/prompt` 懒创建出来的会话（老路子）；
     * - `resumed`：插件用 `agents.resume` **真正接上**的历史会话 —— 发消息走控制帧；
     * - `history`：只是把历史日志回放到面板上（只读，还没接上）。
     */
    private sessionKind: SessionKind = 'sdk';

    /**
     * 当前会话的标题（`session/title` 事件折出来的**最新一条**）。
     *
     * 它不来自 SDK 协议 —— 标题是**会话日志里的一条事件**（`dsh-session-title`
     * 追加的仅写日志事件），所以和别的会话事件走同一条 `session.event` 流。
     * 两条来源：确定性回退（首条用户消息的前几个词，同步就有）与 `session-title-llm`
     * （**异步**：另发一次模型请求，比首轮回答慢一拍才追上，较新者胜出）。
     */
    private sessionTitle: string | null = null;

    /**
     * `command/run` 记下的命令名，供配对的 `command/done` 用。
     *
     * 为什么要配：`command/done` 只带结果文本，**不带命令名**（注册表按 `commandId` 配对）。
     * 只在**回放**时用得上（实时那条结果由面板自己画，见 `runCommand`）。
     */
    private readonly commandNames = new Map<string, string>();

    /** 非空 = 对话区正在显示一条历史会话。 */
    private historyView: HistoryView | null = null;

    /**
     * 当前会话的用量（从 DSH 的**会话投影缓存**读的，见 `stats.ts`）。
     *
     * 三条触发时机：**回合结束**（缓存恰好在 `turn/end` 写检查点）、**换会话**、**面板主动要**。
     * 不做定时轮询 —— 检查点本身就是攒着写的，读得再勤也只是同一份数字，
     * 而这份文件在大会话上能到几百 KB。
     */
    private usage: SessionUsage | null = null;

    /** `usage` 为 null 时的原因（「还没读数」与「读失败」在面板上是两句话）。 */
    private usageNote: string | null = null;

    /** 用量变了但还没广播（它不是转写条目，`dirty` 盯不到它）。 */
    private usageDirty = false;

    /**
     * 本会话**实时水位**：日志里最后一条事件的 `seq`。
     *
     * 只用来算缓存记录「落后多少条」（`behind`）—— 检查点是攒着写的，所以面板必须能说
     * 「这个数字是记到第几条为止的」。只统计**实时**事件（回放历史时不记：那是另一条会话的编号）。
     */
    private lastEventSeq = 0;

    /** 排着的「晚一点再读一次用量」的定时器（见 `scheduleUsageRefresh`）。 */
    private usageTimers: NodeJS.Timeout[] = [];

    // ---- 进度（清单 / 目标 / 回合目录）----
    //
    // 两条来路，合并规则只有一条：**事件优先、缓存补洞**（见 `mergeProgress`）：
    // - `todo/write` / `turn/start` / `goal/change` 三个**实时事件**：精确，但只覆盖面板
    //   转写窗口里的那一段（历史回放只读日志尾部的 2000 条事件）；
    // - 会话投影缓存：整个日志折出来的（回合大纲连 600 条窗口之外的轮次都有），但旧。

    /** 实时事件给出的清单（`todo/write` 的整份快照）。null = 还没见过任何一份。 */
    private todos: TodoView[] | null = null;

    /** 那份清单是**第几轮**写的（0 = 不知道，`turn/start` 不在回放窗口里时就会这样）。 */
    private todosTurn = 0;

    /** 现在在第几轮（`turn/start` 给的）。 */
    private currentTurn = 0;

    /** 事件流里见过的目标；`goalSeen` 区分「没有目标」与「还没见过 `goal/change`」。 */
    private goal: GoalView | null = null;
    private goalSeen = false;

    /** 缓存那一份清单 / 目标（**只在事件里没有这一块时**才用，见 `progressView`）。 */
    private checkpointTodos: TodoView[] | null = null;
    private checkpointGoal: GoalView | null = null;

    /**
     * 第几轮 → 转写条目号（`turn/start` 到达时记下「下一条会拿到几号」）。
     *
     * 为什么要这张表：面板的条目号是**宿主自己的计数器**，而回合大纲给的 `seq` 是
     * **会话事件序号**，两者毫不相干 —— 只把大纲发给面板，那些「第 N 轮」就只能看不能点。
     * `turn/start` 之后第一条上屏的条目（正常就是那一轮的用户消息）就是跳转落点。
     */
    private readonly turnAnchors = new Map<number, number>();

    /** `turn/start` 已经到了、但第一条条目还没上屏：等 `append` 来绑锚点。 */
    private pendingAnchorTurn: number | null = null;

    /** 回合大纲（缓存给的整个日志，带 `entrySeq` 之后就是面板要画的那一份）。 */
    private outline: { turns: TurnView[]; turnsTotal: number; draft: string } | null = null;

    /** 口径说明：读盘那一路 + 三个实时事件各自的（分开存，免得互相覆盖）。 */
    private checkpointNotes: string[] = [];
    private todoNotes: string[] = [];
    private goalNotes: string[] = [];

    /** 进度变了但还没广播。 */
    private progressDirty = false;

    /** 上一次广播出去的进度（JSON），用来免掉「一个字节都没变」的那些广播。 */
    private progressJson = '';

    /** 至少成功读过一次检查点（「一份真的没有回合的白记录」也算成功）。 */
    private progressSeen = false;

    /** 进度那一份读失败 / 还没有读数时的原因。 */
    private progressNote: string | null = null;

    /** 缓存里的水位（进度里 `turns` / `goal` 那两块的新鲜度）。 */
    private progressSeq: number | null = null;
    private progressBehind: number | null = null;
    private progressUpdatedAt = 0;

    private readonly entries: Entry[] = [];
    private seq = 0;
    private revision = 0;

    /** 转写代数：清空/换会话就 +1（面板据此丢弃旧条目）。 */
    private generation = 0;

    /** 控制帧（面板→插件）的请求号与在飞请求。 */
    private ctlSeq = 0;
    private readonly ctlPending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

    /** 流式中的条目（文本 / 思考各一条，回合内复用）。 */
    private textStream: Entry | null = null;
    private reasoningStream: Entry | null = null;

    /** callId → 工具条目，用于把 `tool/result` 配回 `tool/call`。 */
    private readonly toolByCallId = new Map<string, Entry>();

    /**
     * 正在等人类拍板的交互（插件经 `kind:'ask'` 送来的），按发起顺序排。
     *
     * 一般 0 或 1 条；用 Map 是为了让「子 agent 的授权请求」与「主会话的提问」重叠时
     * 两条都能显示、都能回答，而不是排队等着。
     */
    private readonly interactions = new Map<string, InteractionView>();

    /**
     * 面板最近一次活动的时刻（`get-events` 轮询）。
     *
     * 用途只有一个：**面板不在时别让模型干等** —— 交互请求到达时若面板早已不轮询
     * （编辑器关了那个面板、或者只在终端跑这个 profile），立刻按「没人能回答」处理，
     * 行为与没有这套交互通道时一致（提问报错、授权失败关闭）。
     */
    private lastPanelActivity = 0;

    /** 本帧内被改动过的条目（广播用）。 */
    private readonly dirty = new Set<Entry>();
    private flushTimer: NodeJS.Timeout | null = null;

    /** 标题变了但还没广播（标题不是转写条目，`dirty` 盯不到它）。 */
    private titleDirty = false;

    private stderrTail: string[] = [];
    private stderrBuffer = '';

    private readonly listeners = new Set<(update: HostUpdateView) => void>();

    // ---------------------------------------------------------------- 对外只读

    /** 注册更新回调（`main.ts` 用它发广播）。返回注销函数。 */
    onUpdate(listener: (update: HostUpdateView) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** 当前快照。 */
    snapshot(): AgentSnapshot {
        return {
            status: this.status,
            running: this.running,
            sessionId: this.sessionId,
            sessionKind: this.sessionKind,
            history: this.historyView ? { ...this.historyView } : null,
            generation: this.generation,
            pid: this.child?.pid ?? null,
            lastBootMs: this.lastBootMs,
            lastError: this.lastError,
            entryCount: this.entries.length,
            revision: this.revision,
            interactions: [...this.interactions.values()],
            title: this.sessionTitle,
            usage: this.usage ? { ...this.usage } : null,
            usageNote: this.usageNote,
            progress: this.progressView(),
            progressNote: this.progressNote,
            runtime: {
                nodeExe: this.runtime.nodeExe,
                dshBin: this.runtime.dshBin,
                nodeSource: this.runtime.nodeSource,
                dshSource: this.runtime.dshSource,
            },
            stderrTail: [...this.stderrTail],
        };
    }

    /**
     * 记一次「面板还活着」（`main.ts` 在面板轮询时调）。
     *
     * 见 `PANEL_QUIET_MS` 的注释：这是「有人能回答吗」的唯一判据。
     */
    notePanelActivity(): void {
        this.lastPanelActivity = Date.now();
    }

    /** 增量拉取：返回 `rev > since` 的条目（同一 seq 会被反复返回，面板原地更新）。 */
    eventsSince(since: number): EventsPayload {
        const from = Number.isFinite(since) ? since : 0;
        return {
            entries: this.entries.filter((entry) => entry.rev > from),
            revision: this.revision,
            generation: this.generation,
        };
    }

    /** 探测一次运行时（面板要在没启动时也能显示「将用哪个 node/dsh」）。 */
    probeRuntime(): ResolvedRuntime {
        this.runtime = resolveRuntime(getSettings());
        return this.runtime;
    }

    // ---------------------------------------------------------------- 生命周期

    /**
     * 启动 agent。
     *
     * 幂等：已经在跑或正在起就直接返回成功。
     *
     * @returns `{ok, error?}`；失败**不抛**，让面板能显示原因。
     */
    async start(): Promise<{ ok: boolean; error?: string }> {
        if (this.status === 'ready' || this.status === 'starting') return { ok: true };

        const settings = getSettings();
        this.runtime = resolveRuntime(settings);
        if (!this.runtime.nodeExe) {
            return this.fail(
                '找不到可用的 node。请在 DSH 面板设置里填「node 路径」，或把 node 加到 PATH。' +
                    '（注意：编辑器自带的 Electron 不是 node，不能拿来跑 dsh。）',
            );
        }
        if (!this.runtime.dshBin) {
            return this.fail(
                '找不到 dsh CLI 入口。请在设置里填「dsh bin.js 路径」（通常形如 ' +
                    '`<npm 全局目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`）。',
            );
        }

        const cwd = settings.workdir || Editor.Project.path;
        this.setStatus('starting');
        this.lastError = null;
        this.stderrTail = [];
        this.stderrBuffer = '';
        const startedAt = Date.now();

        try {
            this.child = fork(this.runtime.dshBin, ['--profile', PROFILE_NAME], {
                // ⚠ 必须显式给 execPath：默认会用编辑器的 `process.execPath`（CocosCreator.exe）
                execPath: this.runtime.nodeExe,
                cwd,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                windowsHide: true,
                env: {
                    ...process.env,
                    // 随扩展发布的通用 skill 根 —— 让「引擎/编辑器操作的通用知识」跟着插件走，
                    // 换工程装上就有。见 bundledSkillDir() 与 skills/README.md。
                    DSH_BUNDLED_SKILL_DIR: bundledSkillDir(),
                },
                // `windowsHide` 是真实存在的选项（Windows 上别弹黑框），但本地的 @types/node
                // 比它旧、ForkOptions 里还没声明，所以这里断言一下而不是删掉这个选项。
            } as import('child_process').ForkOptions);
        } catch (error) {
            return this.fail(`启动 dsh 子进程失败：${describe(error)}`);
        }

        this.attachChild(this.child);

        try {
            const params: Record<string, unknown> = {
                cwd,
                provider: settings.provider,
                model: settings.model,
            };
            if (settings.reasoningEffort) params.reasoningEffort = settings.reasoningEffort;
            if (settings.maxTokens > 0) params.maxTokens = settings.maxTokens;

            await this.client?.initialize(params as { cwd: string; provider: string; model: string });
        } catch (error) {
            const message = describe(error);
            // 起不来就别留半死的进程
            this.killChild();
            return this.fail(`初始化失败：${message}`);
        }

        this.lastBootMs = Date.now() - startedAt;
        this.setStatus('ready');
        this.append(
            'note',
            `agent 已就绪（${this.lastBootMs}ms） 模型 ${settings.provider}/${settings.model}；工作目录 ${cwd}`,
        );

        // 启动后**接着上次聊**：DSH 的 web 端也是这个行为（面板自己不带磁盘转写，所以还要把历史回放一遍）
        await this.restoreLastSession(cwd);
        return { ok: true };
    }

    /**
     * 启动后自动恢复「本工程最近一条有内容的会话」。
     *
     * ## 为什么默认要这么做
     *
     * 一次「停止 → 启动」在 DSH 侧是**换了一个运行时**，而 SDK 协议里的 `session/prompt`
     * 只会 `create` 新会话（模型侧没有任何历史上下文）—— 所以老代码里 `start()` 每次
     * 随便抽一个新 uuid，效果就是「一重启，之前聊的全没了」。用户看到的正是这个。
     *
     * 走插件控制帧的 `session/resume` 才是**真恢复**（`agents.resume`，模型带着上下文回来），
     * 顺带把这段历史回放到面板上，于是重启前后的观感是连续的。
     *
     * 失败不致命：退回「新会话」并把原因写进转写（不然用户只会看到一片空白）。
     */
    private async restoreLastSession(cwd: string): Promise<void> {
        try {
            const listed = await listHistory(this.runtime.nodeExe, cwd, 5);
            if (!listed.ok) throw new Error(listed.error ?? '列历史会话失败');
            const candidate = (listed.sessions ?? []).find((session) => session.turns > 0) ?? (listed.sessions ?? [])[0];
            if (!candidate) {
                this.sessionId = randomUUID();
                this.sessionKind = 'sdk';
                this.append('note', '还没聊过，已开新会话。');
                return;
            }

            const opened = await this.loadHistory(candidate.id, { quiet: true });
            if (!opened.ok) throw new Error(opened.error ?? '读历史会话失败');
            const resumed = await this.resumeHistory(candidate.id);
            if (!resumed.ok) throw new Error(resumed.error ?? '继续会话失败');
        } catch (error) {
            this.sessionId = randomUUID();
            this.sessionKind = 'sdk';
            this.historyView = null;
            this.append(
                'note',
                `没能接上上次的会话（${describe(error)}）—— 已开新会话 ${String(this.sessionId).slice(0, 8)}…。` +
                    '历史仍在右上角「历史」里。',
            );
        }
    }

    /**
     * 列历史会话（面板上的「历史」按钮）。
     *
     * @param limit - 最多几条。
     * @returns `{ok, sessions?, error?}`。
     */
    async historyList(limit = 20): Promise<{ ok: boolean; sessions?: HistorySessionView[]; error?: string }> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const listed = await listHistory(this.runtime.nodeExe, cwd, limit);
        if (!listed.ok) return { ok: false, error: listed.error };

        const current = this.historyView?.sessionId ?? null;
        const sessions = (listed.sessions ?? []).map((session: HistorySession) => ({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            bytes: session.bytes,
            turns: session.turns,
            current: session.id === current,
        }));
        return { ok: true, sessions };
    }

    /**
     * 把一条历史会话**回放到对话区**（只读）。
     *
     * 回放走的是「同一份事件流」：日志里的事件和实时通知是同构的
     * （`{type, seq, time, data}`），所以这里把 `handleSessionEvent` 的 `replay` 档打开，
     * 让历史走一遍**和实时完全一样**的投影逻辑 —— 不另写一套渲染规则，就不会两边不一致。
     *
     * ⚠ 实测（`.tmp/verify-resume.mjs`）：`agents.resume` **不会**把历史事件重放出来，
     * 所以这段回放不是「多此一举」，而是「不画就没有」。
     *
     * @param sessionId - 会话 id。
     * @param options.quiet - 自动恢复时不刷那两行 note（避免启动就一屏字）。
     * @param options.jumpTo - 回放完想**滚到**的那条事件的 seq（全文搜索命中时用）。
     * @returns `{ok, events?, entrySeq?, error?}`；`entrySeq` 是转写里的条目号。
     */
    async loadHistory(
        sessionId: string,
        options: { quiet?: boolean; jumpTo?: number } = {},
    ): Promise<{ ok: boolean; events?: number; entrySeq?: number; error?: string }> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const read = await readHistory(this.runtime.nodeExe, cwd, sessionId);
        if (!read.ok) return { ok: false, error: read.error };

        const events = read.events ?? [];
        this.resetTranscript();
        this.historyView = {
            sessionId,
            // 优先用日志自己记的标题（`session/title`，可能是模型生成的），
            // 没有才回退到「首条用户消息」（旧日志 / 事件被 maxEvents 截掉时）。
            title: loggedTitleOf(events) || titleOfEvents(events) || '(无标题)',
            createdAt: ((read.header ?? {}) as { createdAt?: number }).createdAt ?? null,
            messageCount: events.length,
            live: false,
        };
        this.sessionKind = 'history';

        /**
         * 回放的同时把「事件 seq → 转写条目 seq」换算出来。
         *
         * 为什么需要换算：两边是**两套编号**，而且不是一对一 —— 日志里的
         * `tool/result` 只是把 `tool/call` 那张卡片补上结果（**不新增条目**），
         * `session/title` 干脆不上屏。搜索给的是事件 seq（那是它在日志里看到的位置），
         * 面板要的是条目 seq（那是 DOM 上的位置），中间这层翻译只有回放的人做得了。
         */
        let jumpEntry: number | undefined;
        for (const event of events) {
            const before = this.seq;
            this.handleSessionEvent(event, true, sessionId);
            if (options.jumpTo === undefined || Number(event.seq ?? -1) !== options.jumpTo) continue;
            // 新增了条目 → 就是它；没新增（工具结果补进已有卡片）→ 找刚刚被 touch 的那条
            jumpEntry = this.seq > before ? before + 1 : this.entrySeqOfRev(this.revision);
        }

        if (!options.quiet) {
            this.append(
                'note',
                `以上是历史会话 ${sessionId.slice(0, 8)}… 的 ${events.length} 条记录（只读回放，共 ${read.total ?? events.length} 条）。` +
                    '想接着聊就点上面的「继续此会话」。',
            );
        }

        if (options.jumpTo !== undefined) {
            // 转写只留最近 `MAX_ENTRIES` 条：命中太靠前时那一条已经被挤掉了。
            // 这时候**明说**，别让用户以为「搜到了却打不开」。
            if (jumpEntry !== undefined && !this.entries.some((entry) => entry.seq === jumpEntry)) {
                this.append(
                    'note',
                    `搜索命中的那一条在很靠前的位置（第 ${options.jumpTo} 条事件），` +
                        `而转写只保留最近 ${MAX_ENTRIES} 条 —— 它已经不在窗口里了，可以导出这份日志来查。`,
                );
                return { ok: true, events: events.length };
            }
        }
        return { ok: true, events: events.length, entrySeq: jumpEntry };
    }

    /** 找「刚被 touch 的那一条」（`rev` 是最后一次改动的版本号，全转写唯一）。 */
    private entrySeqOfRev(rev: number): number | undefined {
        for (const entry of this.entries) if (entry.rev === rev) return entry.seq;
        return undefined;
    }

    /**
     * **真正接上**一条历史会话（插件侧 `agents.resume`）。
     *
     * 接上之后：`sessionId` 指向它、后续消息走控制帧投喂（`agent.followup`），
     * 而流式事件仍从 SDK 的 `session.event` 通知回来（那个订阅覆盖运行时里的**所有**会话）。
     *
     * @param sessionId - 会话 id；省略则用当前回放的那条。
     * @returns `{ok, sessionId?, error?}`。
     */
    async resumeHistory(sessionId?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
        const target = sessionId ?? this.historyView?.sessionId;
        if (!target) return { ok: false, error: '没有可继续的会话（先从「历史」里打开一条）' };
        if (this.status !== 'ready' || !this.child) {
            return { ok: false, error: 'agent 没在跑 —— 先点「启动」再继续这条会话' };
        }

        const settings = getSettings();
        try {
            const result = await this.callChild(
                'session/resume',
                {
                    sessionId: target,
                    provider: settings.provider,
                    model: settings.model,
                    reasoningEffort: settings.reasoningEffort || undefined,
                    maxTokens: settings.maxTokens > 0 ? settings.maxTokens : undefined,
                },
                180_000,
            );
            this.sessionId = target;
            this.sessionKind = 'resumed';
            if (this.historyView) this.historyView = { ...this.historyView, sessionId: target, live: true };
            else {
                this.historyView = { sessionId: target, title: '(未回放)', createdAt: null, messageCount: 0, live: true };
            }
            this.append(
                'note',
                `已接上会话 ${target.slice(0, 8)}…（agent ${String(result.agentId ?? '?').slice(0, 8)}…）——` +
                    '接下来的消息会带着它的上下文。',
            );
            // 接上的这条会话有自己的用量记录（缓存按会话 id 存），立刻换成它的
            void this.refreshUsage();
            return { ok: true, sessionId: target };
        } catch (error) {
            const message = describe(error);
            this.append('error', `继续会话失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * **全文搜索**所有历史会话（面板历史抽屉里的「搜全文」）。
     *
     * 直接读盘（`session-log.js search`），所以 **agent 没在跑也能搜**；代价是它
     * 是「字面子串扫描 + 硬预算」，停下来时**更老的会话没看** —— 这一点必须原样
     * 转给面板（`partial` / `stoppedBy` / `scanned` / `available` 一个都不许吞）。
     *
     * 为什么不让面板直接说「找到 N 条」就完事：搜索是唯一会让用户**相信结论**的功能，
     * 「只扫了 6 个会话却说找到了 3 条」和「扫了全部 107 个」是完全不同的两件事。
     *
     * @param query - 查询串（空白切成多个词，词之间 AND）。
     * @param options - 预算（面板不传就用脚本的默认值）。
     * @returns 命中列表与覆盖率。
     */
    async historySearch(query: string, options: HistorySearchOptions = {}): Promise<HistorySearchView> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const found = await searchHistory(this.runtime.nodeExe, cwd, query, options);
        if (!found.ok) return { ok: false, error: found.error };

        // 只做形状收敛（脚本那边已经是给人看的形状了），不做语义判断
        const hits: HistorySearchHitView[] = (found.hits ?? []).map((raw) => {
            const snippets = Array.isArray(raw.snippets) ? (raw.snippets as Array<Record<string, unknown>>) : [];
            return {
                id: String(raw.id ?? ''),
                title: typeof raw.title === 'string' ? raw.title : '',
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
                updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
                bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
                turns: typeof raw.turns === 'number' ? raw.turns : 0,
                hits: typeof raw.hits === 'number' ? raw.hits : 0,
                seq: typeof raw.seq === 'number' ? raw.seq : 0,
                snippets: snippets.map(
                    (snippet): HistorySnippetView => ({
                        role: String(snippet.role ?? ''),
                        label: typeof snippet.label === 'string' ? snippet.label : String(snippet.role ?? ''),
                        seq: typeof snippet.seq === 'number' ? snippet.seq : 0,
                        snippet: typeof snippet.snippet === 'string' ? snippet.snippet : '',
                    }),
                ),
            };
        });

        return {
            ok: true,
            query: found.query,
            hits,
            scanned: found.scanned,
            available: found.available,
            partial: found.partial === true,
            stoppedBy: found.stoppedBy ?? null,
            elapsedMs: found.elapsedMs,
            scannedBytes: found.scannedBytes,
        };
    }

    /**
     * 把一条会话导出成文件（`md` 转写 / `jsonl` 原样日志 / `zip` 对齐 DSH 官方那一份）。
     *
     * 写在哪、为什么不写进工程 —— 见 `history.ts` 的 `exportHistory`。
     * 导出这件事**不写进会话日志**（转写里那行 note 只在本面板内存里），所以
     * 「我导出过」不会变成模型上下文的一部分。
     *
     * `zip` 那一路**与另外两条不是一回事**：它带子孙会话与附件像素，所以慢（要解压子孙日志、
     * 读一堆附件）。转写里那行 note 因此要把**子孙数（subagent 与 fork 分开）**、**附件数**、
     * 以及**脚本交代的注意事项**（尤其是「当前活跃会话可能少最后几条」）一起写出来 ——
     * 不然用户拿到一个 zip 根本不知道里面有什么、也不知道它为什么不完整。
     *
     * @param sessionId - 会话 id。
     * @param format - `md` / `jsonl` / `zip`。
     * @returns 写出的路径与体积。
     */
    async historyExport(sessionId: string, format: HistoryExportFormat = 'md'): Promise<HistoryExportView> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const target = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!target) return { ok: false, error: 'history-export：缺少 sessionId' };

        const result = await exportHistory(this.runtime.nodeExe, cwd, target, format);
        if (!result.ok) {
            this.append('error', `导出会话失败：${result.error ?? '未知原因'}`);
            return { ok: false, error: result.error };
        }
        const what = result.format === 'jsonl' ? '原样日志' : result.format === 'zip' ? 'ZIP（含子会话与附件）' : '转写';
        this.append(
            'note',
            `已导出会话 ${String(result.id ?? target).slice(0, 8)}…（${what} · ` +
                `${result.events ?? 0} 条 · ${formatBytes(result.bytes ?? 0)}）→ ${result.path}`,
        );
        if (result.subagents) {
            /**
             * ⚠ **subagent 与 fork 分开说**：两者在日志头里的判据不同
             * （`origin === 'subagent'` vs「有 parentSession 但没有 origin」），
             * 而「含 5 个子会话」这句话里，用户真正关心的是「几个是我派出去的 agent」。
             */
            const parts = [`子孙 ${result.subagents.total} 个`];
            parts.push(`其中子 agent ${result.subagents.subagentCount} · fork ${result.subagents.forkCount}`);
            if (result.subagents.maxDepth !== null) parts.push(`最深第 ${result.subagents.maxDepth} 层`);
            if (result.subagents.dangling.length > 0) parts.push(`有 ${result.subagents.dangling.length} 个的父级在索引里找不到`);
            if (result.subagents.incomplete) parts.push('索引扫描超了预算，子孙可能不全');
            this.append('note', `ZIP 里的会话：${parts.join(' · ')}`);
        }
        if (result.media) {
            this.append(
                'note',
                `ZIP 里的附件：${result.media.count} 个${result.media.missing > 0 ? `（另有 ${result.media.missing} 个引用读不到文件）` : ''}`,
            );
        }
        // 脚本交代的话（活跃会话可能少最后几条 / 缺媒体 / 索引超预算）—— 原样搬进转写
        for (const line of result.notes ?? []) this.append('note', `导出说明：${line}`);
        return result;
    }

    /**
     * 删掉一条历史会话（**先 dry-run 拿清单，再真删**）。
     *
     * 四条守卫（都在这一层，因为只有这里知道运行时的状态）：
     * 1. **agent 当前正在用的那条不许删** —— 运行时手里攥着它，下一次落盘会把目录
     *    **重新建出来**（表现就是「删了但它又回来了」）；
     * 2. 面板正只读回放的那条可以删，但删完要把对话区清掉（否则停在一份已经不存在的内容上）；
     * 3. 默认**不动附件** —— 图片按内容存在 `<DSH_HOME>/attachments`，跨会话去重共用；
     * 4. 打开 `reclaim` 时才顺带回收**全库已无引用**的附件：它是**分钟级**的，
     *    而且超预算就**一个都不搬**（fail-closed，口径在 `history.ts` 与脚本里）。
     *
     * @param sessionId - 会话 id。
     * @param dryRun - 只报清单（面板的二次确认用它）。
     * @param reclaim - 顺带回收无引用附件（默认关；dry-run 也要带上，否则看不到候选数）。
     * @returns 清单 / 是否真删了；`cleared` 表示顺手清掉了正在回放的那条。
     */
    async historyDelete(sessionId: string, dryRun = false, reclaim = false): Promise<HistoryDeleteView> {
        if (!this.runtime.nodeExe) this.runtime = resolveRuntime(getSettings());
        const cwd = getSettings().workdir || Editor.Project.path;
        const target = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!target) return { ok: false, error: 'history-delete：缺少 sessionId' };

        if (target === this.sessionId) {
            return {
                ok: false,
                error: '这是 agent 当前正在用的会话 —— 先在面板上点「新会话」，再回来删它（不然 agent 下一次落盘会把它重新建出来）',
            };
        }

        const viewing = this.historyView?.sessionId === target;
        const result = await deleteHistory(this.runtime.nodeExe, cwd, target, dryRun, { reclaimAttachments: reclaim });
        if (!result.ok) return { ok: false, error: result.error };

        if (dryRun) return { ...result, cleared: false };

        let cleared = false;
        if (viewing) {
            // 面板正显示这条（只读回放）：清掉，回到「空会话」状态
            this.historyView = null;
            this.sessionKind = 'sdk';
            this.resetTranscript();
            cleared = true;
        }
        this.append(
            'note',
            `已删除历史会话 ${String(result.id ?? target).slice(0, 8)}…（${result.fileCount ?? 0} 个文件 · ` +
                `${formatBytes(result.bytes ?? 0)}）。图片附件是全局去重的，**不随会话删除**。`,
        );
        /**
         * 附件回收那一趟的结果：**三句话都要说**（候选几个 / 搬了几个 / 有没有被预算截断），
         * 因为这一块最容易让人误会成「一键腾空间」：
         * 本机实测 797 个对象**全都被引用**，所以正常情况下 `orphans` 就是 0 ——
         * 不说「候选里有几个还被别人引用着」，用户会以为功能坏了。
         */
        if (result.reclaim) {
            const r = result.reclaim;
            this.append(
                'note',
                `附件回收：候选 ${r.candidates} 个（这条会话引用的）→ 其中 ${r.referenced} 个仍被别的会话引用、` +
                    `${r.orphans} 个已无引用 → 搬进墓碑 ${r.trashed} 个（${formatBytes(r.bytesFreed)}）。` +
                    `全库扫了 ${r.scanned.sessions} 条会话（${formatBytes(r.scanned.bytes)} / ${Math.round(r.scanned.elapsedMs / 1000)} 秒）。`,
            );
            if (r.incomplete) {
                this.append(
                    'error',
                    `附件回收**一个都没搬**：全库扫描没扫完（${r.incompleteReason ?? '超预算'}）—— ` +
                        '这是有意的（判据不全时误删不可逆），会话本身已经删掉了。',
                );
            } else if (r.trashed === 0) {
                this.append(
                    'note',
                    '这次没有可回收的附件（候选里每一个都还被别的会话引用着）—— 附件是不可重建的，所以回收只搬"全库都引用不到"的那几个。',
                );
            }
            // 被否决的候选（hash 不符 / 时间窗 / 读不到…）：前几条列出来，别让它静默
            const skipped = r.skipped.filter((entry) => entry.reason !== 'still-referenced');
            if (skipped.length > 0) {
                this.append(
                    'note',
                    `回收时跳过 ${skipped.length} 个（不是"还在用"，是别的守卫拦下的）：` +
                        skipped.slice(0, 4).map((entry) => `${entry.id.slice(0, 14)}…（${entry.reason}）`).join('、'),
                );
            }
        }
        return { ...result, cleared };
    }

    // ---------------------------------------------------------------- 用量

    /**
     * 读一次当前会话的**读数**：用量（token 累计 / 上下文占用 / 花费）+ 进度（清单 / 目标 / 回合目录）。
     *
     * 读的是 **DSH 的会话投影缓存**（`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`）——
     * 不是问 agent 要的：SDK 协议里没有投影读取，`ctx.tokenMeter` 也只有宿主进程内的插件拿得到。
     * 这是**明文 JSON**，所以主进程直接读盘，连那个外部 node 都不需要。
     *
     * 两边**一起读、一起回**：同一份文件（一次解析），同一组新鲜度事实（水位 / 落后 / 写于何时）——
     * 分开读会出现「用量说落后 12 条、进度说落后 3 条」这种自相矛盾的画面。
     *
     * 四条口径（都要原样转给面板，一条都不许吞）：
     * 1. **读失败 ≠ 没有读数** —— 前者是 error、后者是这个会话还没落过检查点，面板上是两句话；
     * 2. **只读不等于实时** —— 记录带**水位**（`seq`），我们把当前实时水位一起递下去算 `behind`；
     * 3. **面板正只读回放历史会话时，读的是那条会话** —— 不然会拿活会话的数字去配历史的转写；
     * 4. **进度那一半单独失败不算整份失败** —— 缓存里没有进度行时说「这一块没有」，
     *    而不是把用量一起说成「读失败」（用量决定面板上那颗占用率 chip 显不显示）。
     *
     * @returns `{ok, usage, note, progress, progressNote}`；失败不抛。
     */
    async refreshUsage(): Promise<{
        ok: boolean;
        usage: SessionUsage | null;
        note: string | null;
        progress: ProgressView | null;
        progressNote: string | null;
    }> {
        const target = this.historyView?.sessionId ?? this.sessionId;
        if (!target) {
            this.applyUsage(null, '还没有会话 —— agent 启动、发出第一条消息之后才有用量。');
            this.applyCheckpointProgress(null, null, '还没有会话 —— 进度要等 agent 起过、会话落过检查点才有。');
            return { ok: false, usage: null, note: this.usageNote, progress: null, progressNote: this.progressNote };
        }

        let result: SessionCacheResult;
        try {
            result = await readSessionCache(target, {
                liveSeq: this.lastEventSeq > 0 ? this.lastEventSeq : undefined,
            });
        } catch (error) {
            result = { ok: false, error: describe(error) };
        }
        if (result.ok !== true || !result.usage) {
            this.applyUsage(null, result.error ?? '读用量失败');
            this.applyCheckpointProgress(null, null, result.error ?? '读进度失败');
            return { ok: false, usage: null, note: this.usageNote, progress: null, progressNote: this.progressNote };
        }
        this.applyUsage(result.usage, null);
        /**
         * 进度那一半**单独失败不算整份失败**（`readSessionCache` 也是这么分的）：
         * 缓存里没有进度行时说「这块没有」，而不是把用量一起说成「读失败」。
         */
        this.applyCheckpointProgress(
            result.progress ?? null,
            result.usage,
            result.progress ? null : '这份缓存记录里没有进度那几行（清单 / 目标 / 回合大纲）。',
        );
        return { ok: true, usage: this.usage, note: null, progress: this.progressView(), progressNote: this.progressNote };
    }

    /**
     * 换一份用量。
     *
     * 内容一样就一个字节都不动：这个函数会在「回合结束」「跑完命令」「面板点刷新」三处被调，
     * 而多数时候读到的是同一份数字 —— 白广播一次会让面板无谓地重画一遍抽屉。
     */
    private applyUsage(next: SessionUsage | null, note: string | null): void {
        const same = this.usageNote === note && JSON.stringify(this.usage) === JSON.stringify(next);
        this.usage = next;
        this.usageNote = note;
        if (same) return;
        this.usageDirty = true;
        this.scheduleFlush();
    }

    /**
     * 排一次「晚一点读用量」。默认一个点，跑斜杠命令时两个点（见常量上的注释）。
     *
     * @param delays - 相对现在的毫秒数（会先清掉上一批，避免连点攒出一堆定时器）。
     */
    private scheduleUsageRefresh(delays: number[] = [USAGE_REFRESH_DELAY_MS]): void {
        this.clearUsageTimers();
        for (const delay of delays) {
            this.usageTimers.push(
                setTimeout(() => {
                    void this.refreshUsage();
                }, Math.max(0, delay)),
            );
        }
    }

    /** 清掉排着的读用量定时器（读之前会先清，`cleanup` 也要清）。 */
    private clearUsageTimers(): void {
        for (const timer of this.usageTimers) clearTimeout(timer);
        this.usageTimers = [];
    }

    // ---------------------------------------------------------------- 进度
    //
    // 三块：**待办清单**（agent 自己写的工作表）、**目标**、**回合目录**。
    //
    // 合并规则只有一条：**事件优先、缓存补洞**。为什么这条规则是对的：
    // 两边折的是**同一份事件日志**，差别只在「折到第几条」——
    //   事件：精确，但只覆盖面板转写窗口里那一段（历史回放只读日志尾部的 2000 条事件）；
    //   缓存：整个日志（回合大纲连 600 条窗口之外的轮次都有），但最多落后 200 条事件 / 5 秒。
    // 所以「事件里有就用事件的」永远更接近真相；缓存只在事件**没有**这一块时补上
    // （典型：最后那次 `todo_write` 落在回放窗口之外）。两边都有而且不一样时**要说出来**，
    // 不能默默挑一个 —— 那正是「面板看起来是对的、但和 agent 记得的不一样」的来源。

    /**
     * 收下**缓存**给的那一半进度（`refreshUsage` 读回来的）。
     *
     * @param progress - 缓存里的进度；形状认不出时是 null。
     * @param usage - 同一份文件读出来的用量（水位 / 落后 / 写于何时都在它身上）。
     * @param note - 读失败或者「这份记录里没有进度那几行」的原因。
     */
    private applyCheckpointProgress(progress: SessionProgress | null, usage: SessionUsage | null, note: string | null): void {
        this.checkpointTodos = progress ? progress.todos : null;
        this.checkpointGoal = progress ? progress.goal : null;
        this.outline = progress ? { turns: progress.turns, turnsTotal: progress.turnsTotal, draft: progress.draft } : null;
        this.progressSeq = usage?.seq ?? null;
        this.progressBehind = usage?.behind ?? null;
        this.progressUpdatedAt = usage?.updatedAt ?? 0;
        this.progressNote = note;
        if (progress) this.progressSeen = true;
        this.touchProgress();
    }

    /** 收下一条 `todo/write`（整份快照，替换掉上一份）。 */
    private applyLiveTodos(value: unknown): void {
        const notes: string[] = [];
        // 认不出的条目：宁少不假，但要说出来（notes 会进 `progressView().notes`）
        this.todoNotes = notes;
        this.todos = parseTodos(value, notes);
        // 记下「这一轮里写的」；`currentTurn` 为 0 = 还没见到 `turn/start`，那就按「不知道」记
        this.todosTurn = this.currentTurn;
        this.touchProgress();
    }

    /** 收下一条 `goal/change`（完整快照或墓碑）。 */
    private applyLiveGoal(value: unknown): void {
        const notes: string[] = [];
        this.goal = parseGoalChange(value, notes);
        this.goalNotes = notes;
        // ⚠ 见过 `goal/change` 之后，「没有目标」就变成**事件说的**（可能是刚被清掉），
        // 不能再让缓存里旧的那一份盖回来。
        this.goalSeen = true;
        this.touchProgress();
    }

    /**
     * 记下「这一轮对应转写里的哪一条」。
     *
     * `turn/start` 到达时还不知道第一条条目是几号（用户消息还没上屏），所以先记**待绑**
     * 的轮次，等下一次 `append` 再绑上真号码。`turn/start` 之后**什么都没上屏**时
     * 这一轮就不绑（那一轮没有可跳的地方，面板会照实说，而不是跳到一个别的轮次去）。
     */
    private markTurnStart(turn: number): void {
        this.currentTurn = turn;
        this.pendingAnchorTurn = turn;
        this.touchProgress();
    }

    /** `append` 的尾巴上调用：把「待绑的轮次」绑到刚上屏的那一条上。 */
    private bindTurnAnchor(entrySeq: number): void {
        if (this.pendingAnchorTurn === null) return;
        this.turnAnchors.set(this.pendingAnchorTurn, entrySeq);
        this.pendingAnchorTurn = null;
        this.touchProgress();
    }

    /** 把进度整块归零（换会话 / 回放另一条会话）。 */
    private resetProgress(): void {
        this.todos = null;
        this.todosTurn = 0;
        this.currentTurn = 0;
        this.goal = null;
        this.goalSeen = false;
        this.outline = null;
        this.checkpointTodos = null;
        this.checkpointGoal = null;
        this.checkpointNotes = [];
        this.todoNotes = [];
        this.goalNotes = [];
        this.turnAnchors.clear();
        this.pendingAnchorTurn = null;
        this.progressSeen = false;
        this.progressNote = null;
        this.progressSeq = null;
        this.progressBehind = null;
        this.progressUpdatedAt = 0;
        this.progressDirty = true;
        this.progressJson = '';
        this.scheduleFlush();
    }

    /** 变了才广播（多数时候这些字段一个字节都没动）。 */
    private touchProgress(): void {
        const json = JSON.stringify(this.progressView());
        if (json === this.progressJson) return;
        this.progressJson = json;
        this.progressDirty = true;
        this.scheduleFlush();
    }

    /**
     * 面板要的那一份进度（**合并之后的成品**）。
     *
     * @returns 一次成功的检查点读都没有、也没有任何实时事件时返回 null
     *   （面板据此显示「还没有进度」+ `progressNote` 里的原因）。
     */
    private progressView(): ProgressView | null {
        const hasLive = this.todos !== null || this.goal !== null || this.turnAnchors.size > 0;
        const hasCheckpoint = this.checkpointSeen();
        if (!hasLive && !hasCheckpoint) return null;

        const notes = [...this.checkpointNotes, ...this.todoNotes, ...this.goalNotes];

        // ---- 清单：事件优先 ----
        let todos: TodoView[] | null = null;
        let todosSource: 'events' | 'checkpoint' | null = null;
        if (this.todos !== null) {
            todos = this.todos;
            todosSource = 'events';
            if (this.checkpointTodos !== null && JSON.stringify(this.checkpointTodos) !== JSON.stringify(this.todos)) {
                notes.push(
                    '检查点里的清单和事件流里的不一样 —— 面板用的是**事件流**那一份（缓存攒够 200 条事件或 5 秒才写一次，最多落后这么多）。',
                );
            }
        } else if (this.checkpointTodos !== null) {
            todos = this.checkpointTodos;
            todosSource = 'checkpoint';
        }

        // ---- 目标：事件优先（`goal/change` 的墓碑 = 目标被清掉，也算「事件里有」）----
        if (this.goalSeen && this.goal !== null && this.checkpointGoal !== null && JSON.stringify(this.checkpointGoal) !== JSON.stringify(this.goal)) {
            notes.push('检查点里的目标和事件流里的不一样 —— 面板用的是**事件流**那一份。');
        }
        const goal = this.goalSeen ? this.goal : this.checkpointGoal;

        // ---- 回合目录：只有缓存有（事件流里没有「整个日志」这个概念）----
        const present = new Set(this.entries.map((entry) => entry.seq));
        const turns: TurnView[] = (this.outline?.turns ?? []).map((turn) => ({
            ...turn,
            entrySeq: this.resolveAnchor(turn.turn, present),
        }));
        // 事件里见过、但大纲里没有的轮次（大纲缺了 / 这一轮刚开还没折进去）：至少把轮次列出来
        if (this.outline === null && this.turnAnchors.size > 0) {
            for (const [turn, anchor] of [...this.turnAnchors.entries()].sort((a, b) => a[0] - b[0])) {
                turns.push({
                    turn,
                    prompt: '',
                    response: '',
                    entrySeq: present.has(anchor) ? anchor : null,
                    seq: null,
                });
            }
        }

        return {
            todos,
            todosSource,
            todosTurn: this.todosTurn > 0 ? this.todosTurn : null,
            /**
             * 清单比当前轮次旧 = **DSH 的投影口径已经把清单归零了**（每一次 `turn/start` 都归零），
             * 也就是「本轮 agent 还没写清单」。这时候面板上那一份是**上一轮的表**，必须标出来。
             */
            stale: this.todosTurn > 0 && this.currentTurn > this.todosTurn,
            currentTurn: this.currentTurn,
            goal,
            turns,
            turnsTotal: this.outline?.turnsTotal ?? turns.length,
            draft: this.outline?.draft ?? '',
            seq: this.progressSeq,
            behind: this.progressBehind,
            updatedAt: this.progressUpdatedAt,
            notes,
        };
    }

    /** 回合目录里那一轮的跳转落点（那一轮的条目已经被 600 条上限挤掉时给 null）。 */
    private resolveAnchor(turn: number, present: Set<number>): number | null {
        const anchor = this.turnAnchors.get(turn);
        if (anchor === undefined) return null;
        return present.has(anchor) ? anchor : null;
    }

    /** 有没有一份成功的检查点（用它而不是 `outline !== null`：一份真的没有回合的白记录也是成功的）。 */
    private checkpointSeen(): boolean {
        return this.progressSeen;
    }
    /**
     * 发一条控制帧并等回执（面板→插件那一路）。
     *
     * 与工具帧（`kind: 'req'`）共用 IPC 通道，靠 `kind` 区分；回执在 `attachChild` 的
     * 消息路由里按 `id` 配对。
     */
    private callChild(
        method: string,
        params: Record<string, unknown>,
        timeoutMs = 60_000,
    ): Promise<Record<string, unknown>> {
        const child = this.child;
        if (!child) return Promise.reject(new Error('agent 子进程不在'));

        const id = ++this.ctlSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ctlPending.delete(id);
                reject(
                    new Error(
                        `控制帧 ${method} 在 ${timeoutMs}ms 内没有回执（插件版本过旧？` +
                            '本扩展要求 dsh-cocos-bridge 支持控制通道，先跑一次 scripts/install-profile.js）',
                    ),
                );
            }, timeoutMs);
            this.ctlPending.set(id, { resolve, reject, timer });
            try {
                child.send({ __tag: IPC_TAG, kind: 'ctl', id, method, params });
            } catch (error) {
                clearTimeout(timer);
                this.ctlPending.delete(id);
                reject(new Error(`发送控制帧失败：${describe(error)}`));
            }
        });
    }

    /** 停止 agent。先走协议 `shutdown`（服务端会自己退出），兜底再 kill。 */
    async stop(): Promise<{ ok: boolean; error?: string }> {
        if (!this.child) {
            this.setStatus('stopped');
            return { ok: true };
        }
        this.setStatus('stopping');
        const child = this.child;
        const client = this.client;
        try {
            await client?.shutdown();
        } catch (error) {
            console.warn(`[dsh_chat] shutdown 请求没走完（继续 kill）：${describe(error)}`);
        }
        // 服务端通常会自己 exit；给它 1.5s，然后兜底。
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) {
                    try {
                        child.kill();
                    } catch {
                        /* 已经没了 */
                    }
                }
                resolve();
            }, 1500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.cleanup();
        this.setStatus('stopped');
        this.append('note', 'agent 已停止');
        return { ok: true };
    }

    /**
     * 中断**当前这一轮**（面板上那个「停止本轮」按钮）。
     *
     * ## 为什么它必须有，以及为什么只能这么做
     *
     * SDK 协议只有 `initialize` / `session/prompt` / `shutdown` 三个方法，
     * **没有「取消这一轮」**；而且 `session/prompt` 的回执只是「入队成功」
     * （`SessionPromptResult` 是 durable enqueue receipt），拿到回执≠这一轮结束。
     * 所以在加这条通道之前，面板上唯一的「停止」是**杀掉整个 agent 进程** ——
     * 会话、子 agent、正在跑的工具一起没，下一句还要重新启动 + 自动接上下文。
     * 「AI 想歪了想改口」这种最常见的场景，代价高得离谱。
     *
     * 真正能取消的是运行时内部的 `Agent.cancel(cause)`，而它只有插件能调
     * （见 `dsh-cocos-bridge` 的 `session/cancel`）。这条方法就是那一步的转发：
     *
     * ```
     * 面板「停止本轮」→ 主进程 interrupt() → ctl session/cancel {sessionId}
     *                                     → 插件 agents.get(sessionId).cancel({kind:'user'})
     * ```
     *
     * ## 三条口径
     *
     * 1. **没在跑就不算错**：`running` 为假直接回一句 note，不打扰插件 ——
     *    按钮与「这一轮刚好自己结束」之间有天然竞态，报红是误报。
     * 2. **中断不是回滚**：已经产出的文本 / 已经跑完的工具调用都留着
     *    （`assistant/message` 的 `interrupted` 与 `turn/end` 的 `aborted` 会到，转写里会多一条 note）。
     * 3. **不动 `sessionId`**：中断之后接着说，还是同一个会话、同一段上下文。
     *
     * @returns `{ok, cancelled?, status?, error?}`。
     */
    async interrupt(): Promise<{ ok: boolean; cancelled?: boolean; status?: string; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        try {
            /**
             * ⚠ **不拿 `this.running` 当闸门**：它来自 `session.status` 通知，可能在
             * 「面板刚重开」「通知还没到」时是陈旧的 `false`；而**谁在跑**这件事，
             * 运行时里的 `agent.status` 才是真源。所以一律问插件，由它回 `cancelled`。
             */
            const result = await this.callChild('session/cancel', { sessionId: this.sessionId }, 15_000);
            const cancelled = result.cancelled === true;
            const status = typeof result.status === 'string' ? result.status : undefined;
            this.append('note', cancelled ? '已请求中断这一轮（会话保留，可以接着说）' : '这一轮已经结束了');
            // 乐观收敛：中断请求已受理时，本地 running 立刻置位，别等下一次通知
            // （面板那个按钮的禁用态靠它，不然会有一小段「看起来没反应」）
            if (cancelled) this.running = false;
            return { ok: true, cancelled, status };
        } catch (error) {
            const message = describe(error);
            this.append('error', `中断失败：${message}`);
            return { ok: false, error: message };
        }
    }

    // ------------------------------------------------- 服务通道（斜杠命令 / @路径）
    //
    // 这两样能力**一直都在宿主里**（`ctx.commands` / `ctx.fileReferences`），
    // 只是原本只有 `dsh-web-app` 的浏览器那一半在消费，而 SDK 协议一个都表达不了。
    // 插件（`dsh-cocos-bridge`）把这两个服务按 agent 转出来，这三条方法就是扩展侧的转发 + 收敛。

    /**
     * 列当前 agent 能用的斜杠命令（面板输入 `/` 时弹的那张表）。
     *
     * 命令是**按 agent** 查的（注册表支持 agent 作用域遮蔽同名全局定义），
     * 所以没有会话时没得可列 —— 直接回 `agent 还没就绪 / 还没有会话`，
     * 而不是回一张空表（空表会让面板以为「这个 profile 没有命令」）。
     *
     * @returns `{ok, commands?, error?}`。
     */
    async commandList(): Promise<{ ok: boolean; commands?: CommandView[]; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        try {
            const result = await this.callChild('commands/list', { sessionId: this.sessionId }, 20_000);
            return { ok: true, commands: normalizeCommands(result.commands) };
        } catch (error) {
            return { ok: false, error: describe(error) };
        }
    }

    /**
     * 执行一条斜杠命令行。
     *
     * ## 三条口径
     *
     * 1. **结果画在转写里，不在面板的临时浮层里**：命令的执行在会话日志中留下
     *    `command/run` + `command/done` 两条事件（**不进模型历史**），所以它天然属于会话；
     *    面板刷新 / 换会话 / 回放之后，这一条 note 还在（回放那条分支见 `handleSessionEvent`）。
     * 2. **`known:false` 与「命令报错」是两件事**：前者是「语法不合法或名字不认识」
     *    （注册表连生命周期事件都没记），后者是命令真的跑了但返回 error。
     *    两者的文案不一样，别合并成一句「命令失败」。
     * 3. **不做乐观回显**：命令可能改会话状态（`/compact` 会压缩历史、`/plan` 会切模式），
     *    先画一条「已发送」再被真结果盖掉，看起来像抖了一下。
     *
     * @param line - 完整命令行（必须以 `/` 开头）。
     * @returns `{ok, known?, kind?, text?, error?}`。
     */
    async runCommand(line: unknown): Promise<{ ok: boolean; known?: boolean; kind?: 'success' | 'error'; text?: string; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        const text = typeof line === 'string' ? line.trim() : '';
        if (!text.startsWith('/')) return { ok: false, error: '斜杠命令必须以 "/" 开头' };
        if (text.length > 2000) return { ok: false, error: '斜杠命令太长了（上限 2000 字符）' };
        try {
            const result = await this.callChild('commands/run', { sessionId: this.sessionId, line: text }, 120_000);
            if (result.known !== true) {
                const message = `没有这个斜杠命令：${text.split(/\s+/)[0]}`;
                this.append('error', message);
                return { ok: false, known: false, error: message };
            }
            const failed = result.kind === 'error';
            const output = typeof result.text === 'string' ? result.text.trim() : '';
            this.append('note', `命令 ${text.split(/\s+/)[0]} ${failed ? '失败' : '完成'}${output ? `：${output}` : ''}`);
            /**
             * 顺带补读用量：`/compact` 正是**为了**改上下文才用的，而用户看的就是占用率。
             * 两个时刻（见常量注释）：检查点是攒着写的，第一个点读到的很可能还是旧数。
             */
            this.scheduleUsageRefresh(USAGE_REFRESH_AFTER_COMMAND_MS);
            return { ok: true, known: true, kind: failed ? 'error' : 'success', text: output };
        } catch (error) {
            const message = describe(error);
            this.append('error', `命令没有执行：${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * 列 `@路径` 候选（面板的 `@` 补全）。
     *
     * 面板会**边打字边问**，所以这条路要便宜：提供方自己带缓存（`tool/result` 之后后台重建），
     * 我们这边只做形状收敛与上限。查询串原样透传 —— **补全语义**（模糊排序、目录带尾斜杠、
     * 哪些目录不遍历）由提供方拥有，抄一份必然漂移。
     *
     * @param query - `@` 或 `@"` 之后到光标之间的文本。
     * @returns `{ok, candidates?, error?}`。
     */
    async fileReference(query: unknown): Promise<{ ok: boolean; candidates?: ReferenceCandidate[]; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        const text = typeof query === 'string' ? query.slice(0, 400) : '';
        try {
            const result = await this.callChild('fileref/list', { sessionId: this.sessionId, query: text }, 20_000);
            return { ok: true, candidates: normalizeReferences(result.candidates) };
        } catch (error) {
            return { ok: false, error: describe(error) };
        }
    }

    /**
     * 读「活动」抽屉那两块：后台任务（jobs）+ 子 agent（subagents）。
     *
     * ## 四条口径
     *
     * 1. **一次读两块**（两条控制帧并发发出去，`Promise.all` 收）。它们没有共享状态，
     *    但**共用一组说明**（截断、列不出来的原因），分两次读会让面板那块说明一会儿有一会儿没有。
     * 2. **两块各自成败**：一个服务缺失不该让另一块也空白 —— 所以两次调用各自 catch，
     *    失败的那一块只留 `*Reason`（面板说「看不到 + 为什么」），另一块照画。
     * 3. **这是"读一次"的答案，不是实时流**：`at` 带上时刻，面板据此说「几秒前」。
     *    谁在什么时候读由面板决定（打开抽屉 / 点刷新），宿主不自己起定时器 ——
     *    这两个服务活在运行时内存里，**没有变化事件**可订阅（`onJobsChanged` 只在集合变化时响，
     *    输出增长不触发），轮询是唯一诚实的选择。
     * 4. **不读 job 的输出**（见 `constants.ts` 的 `JobView`）：插件那次调用只用 `list()`/`get()`。
     *
     * @returns `{ok, activity?, error?}`；`ok:false` 只在 agent 都没起来时出现。
     */
    async panelActivity(): Promise<{ ok: boolean; activity?: ActivityView; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        const sessionId = this.sessionId;
        const notes: string[] = [];
        const [jobsRaw, subsRaw] = await Promise.all([
            this.callChild('jobs/list', { sessionId }, 20_000).catch((error) => {
                notes.push(`后台任务读不出来：${describe(error)}`);
                return null;
            }),
            this.callChild('subagents/list', { sessionId }, 20_000).catch((error) => {
                notes.push(`子 agent 读不出来：${describe(error)}`);
                return null;
            }),
        ]);
        return { ok: true, activity: normalizeActivity(jobsRaw, subsRaw, notes, Date.now()) };
    }

    /**
     * 中断一个子 agent 的当前一轮。
     *
     * ⚠ 只停**当前这一轮**（会话与上下文都留着），所以面板的文案不许写成「杀掉子 agent」。
     * 目标不存在时服务自己是静默 no-op —— 那种情况我们回 `ok:true`，因为「它已经结束了」
     * 与「中断成功」对用户是同一件事（按钮按下去的那一刻它刚好跑完）。
     *
     * @param subagentId - 子会话 id。
     * @returns `{ok, subagentId?, error?}`。
     */
    async subagentInterrupt(subagentId: unknown): Promise<{ ok: boolean; subagentId?: string; error?: string }> {
        if (this.status !== 'ready' || !this.child) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) return { ok: false, error: '还没有会话' };
        const target = typeof subagentId === 'string' ? subagentId.trim() : '';
        if (!target) return { ok: false, error: 'subagent-interrupt：缺少 subagentId' };
        try {
            await this.callChild('subagents/interrupt', { parentSessionId: this.sessionId, subagentId: target }, 20_000);
            this.append('note', `已请求中断子 agent ${target.slice(0, 8)}… 的当前一轮（会话与上下文都留着）`);
            return { ok: true, subagentId: target };
        } catch (error) {
            return { ok: false, error: describe(error) };
        }
    }

    /** 开一个新会话（新的 sessionId；旧会话在 DSH 侧仍按日志留在磁盘上）。 */
    newSession(): { ok: boolean; sessionId: string | null } {        // 接上来的历史会话是**插件持有的 agent**：开新会话就要显式放掉它，
        // 否则它会一直挂在运行时里（下次 resume 同一个 id 会撞上）。
        if (this.sessionKind === 'resumed' && this.sessionId) {
            const previous = this.sessionId;
            void this.callChild('session/dispose', { sessionId: previous }).catch((error) => {
                console.warn(`[dsh_chat] 释放会话 ${previous.slice(0, 8)}… 失败：${describe(error)}`);
            });
        }
        this.sessionId = randomUUID();
        this.sessionKind = 'sdk';
        this.historyView = null;
        this.resetTranscript();
        this.append(
            'note',
            `已开新会话 ${this.sessionId.slice(0, 8)}…（上一段对话仍在右上角「历史」里，随时可以接着聊）`,
        );
        return { ok: true, sessionId: this.sessionId };
    }

    /**
     * 清空对话区（换会话/回放历史前调用）。
     *
     * **代数 +1** 是给面板的信号：面板只按 `rev` 拉增量，没法表达「某条被删掉了」，
     * 所以「清空」这件事必须有一个独立的、单调递增的记号（`generation`）。
     */
    private resetTranscript(): void {
        this.entries.length = 0;
        this.seq = 0;
        this.generation += 1;
        this.textStream = null;
        this.reasoningStream = null;
        this.toolByCallId.clear();
        this.dirty.clear();
        // 标题与命令名都是「属于上一个会话」的东西：换会话必须清掉，否则新会话会顶着
        // 上一个会话的标题/命令记录，而且回放时 `command/done` 会配到错的命令名。
        this.sessionTitle = null;
        this.commandNames.clear();
        this.titleDirty = true;
        /**
         * 用量与实时水位也是「属于上一个会话」的东西：不清的话，新会话会顶着上一个会话的
         * 占用率（而且 `behind` 会用一个荒唐的差值）。
         *
         * 立刻排一次读（`[0]` = 下一个宏任务）：这个函数的三条来路都要重新读 ——
         * 开新会话（读得到创建时的种子检查点，一份「什么都还没有」的记录）、回放历史
         * （读**那条**会话）、删掉正在回放的那条（读不到 = 会话没了）。
         * 排成宏任务而不是直接读，是因为回放那条路在**这个函数之后**才会把
         * `historyView.sessionId` 设好 —— 读用量认的就是它。
         */
        this.applyUsage(null, null);
        this.lastEventSeq = 0;
        /**
         * 进度也要整块归零：清单 / 目标 / 回合锚点全都是**这条会话**的事实，
         * 留着上一条会话的清单比留着它的用量更糟 —— 用量是个数字，清单是「agent 在做什么」。
         * 归零之后排一次读（`[0]`）会把新会话的检查点填进来。
         */
        this.resetProgress();
        this.scheduleUsageRefresh([0]);
        this.scheduleFlush();
    }

    /**
     * 发一条用户消息（文本 + 可选图片）。
     *
     * 回执只代表**入队**成功；答案通过 `session.event` 异步到来（见 `handleSessionEvent`）。
     *
     * 三条路：
     * - 接上来的历史会话（`resumed`）走控制帧（插件 `session/prompt`，图片由插件送进附件库）；
     * - 其余走 SDK 的 `session/prompt`（服务端懒创建会话，图片由服务端送进附件库）；
     * - 只有图没有字也允许（模型只看图）。
     *
     * @param text - 用户输入的文本（可空）。
     * @param images - 已经过 `validateImageBatch` 的图片（可空）。
     * @returns `{ok, error?, messageId?}`。
     */
    async send(text: string, images: ValidImage[] = []): Promise<{ ok: boolean; error?: string; messageId?: string }> {
        const content = typeof text === 'string' ? text.trim() : '';
        const attachments = images.filter((image) => image && typeof image.data === 'string' && image.data);
        if (!content && attachments.length === 0) return { ok: false, error: '消息是空的' };
        if (this.status !== 'ready' || !this.client) return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) {
            this.sessionId = randomUUID();
            this.sessionKind = 'sdk';
        }

        // 内容块：文本在前、图片在后（附件库按顺序把 image 块换成附件引用，顺序即消息顺序）
        const blocks: Array<Record<string, unknown>> = [];
        if (content) blocks.push({ type: 'text', text: content });
        for (const image of attachments) blocks.push(imageBlockOf(image));

        // 本地立即回显（不等 `user/message` 事件，避免"点了没反应"的错觉）。
        // 图片只记元数据 —— 转写是要经广播/轮询回面板的，塞像素进去会把面板拖死（见 `EntryImage`）。
        this.append('user', content, undefined, attachments.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            bytes: image.bytes,
        })));
        this.textStream = null;
        this.reasoningStream = null;

        if (this.sessionKind === 'resumed') {
            try {
                const result = await this.callChild('session/prompt', {
                    sessionId: this.sessionId,
                    text: content,
                    // 控制帧上也走 base64（插件那边转成附件引用），别传路径：
                    // 插件跑在 DSH 运行时里，它读不到编辑器的工程目录语义。
                    images: attachments.map((image) => ({ mimeType: image.mimeType, data: image.data, name: image.name })),
                });
                return { ok: true, messageId: typeof result.messageId === 'string' ? result.messageId : undefined };
            } catch (error) {
                const message = describe(error);
                this.append('error', `发送失败（已接上的历史会话走控制帧）：${message}`);
                return { ok: false, error: message };
            }
        }

        try {
            const result = (await this.client.prompt(this.sessionId, blocks)) as { messageId?: string } | undefined;
            return { ok: true, messageId: result?.messageId };
        } catch (error) {
            const message = describe(error);
            this.append('error', `发送失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /** 扩展卸载时调用：断开一切、杀掉子进程。 */
    async dispose(): Promise<void> {
        this.listeners.clear();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.child) {
            try {
                this.client?.dispose();
            } catch {
                /* 忽略 */
            }
            this.killChild();
        }
        this.cleanup();
        this.status = 'stopped';
    }

    // ---------------------------------------------------------------- 子进程接线

    private attachChild(child: ChildProcess): void {
        this.client = new SdkClient(child, (method, params) => this.handleNotification(method, params));
        this.client.attach();

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => this.handleStderr(chunk));

        // 原生工具调用：DSH 插件 → 本进程；控制帧回执、交互请求也走这条通道
        child.on('message', (frame: unknown) => {
            const typed = frame as { __tag?: string; kind?: string; id?: unknown } | null;
            if (typed && typed.__tag === IPC_TAG && typed.kind === 'ctl-res') {
                this.handleControlReply(typed);
                return;
            }
            if (typed && typed.__tag === IPC_TAG && typed.kind === 'ask') {
                this.handleAskFrame(typed);
                return;
            }
            void this.handleIpcFrame(frame);
        });

        child.on('error', (error) => {
            this.fail(`子进程错误：${describe(error)}`);
        });

        child.on('exit', (code, signal) => {
            const wasStopping = this.status === 'stopping';
            this.cleanup();
            if (wasStopping) {
                this.setStatus('stopped');
                return;
            }
            this.fail(`agent 进程退出了（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`);
        });
    }

    /** 收尾：摘监听、清引用（不 kill）。 */
    private cleanup(): void {
        if (this.client) {
            this.client.dispose();
            this.client = null;
        }
        // 子进程没了，控制帧的在飞请求永远不会回来 —— 立刻让它们失败，别让面板转圈
        for (const [, entry] of this.ctlPending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('agent 子进程已退出，控制帧没有回执'));
        }
        this.ctlPending.clear();
        // 交互是「插件在等一个回答」：子进程没了就永远等不到，清掉免得面板上留着僵尸卡片
        this.interactions.clear();
        if (this.child) {
            this.child.removeAllListeners('message');
            this.child.removeAllListeners('exit');
            this.child.removeAllListeners('error');
            this.child = null;
        }
        this.running = false;
        this.textStream = null;
        this.reasoningStream = null;
        // 排着的读用量定时器也清掉：子进程都没了，再读也只是白读一次盘
        this.clearUsageTimers();
        this.scheduleFlush();
    }

    /** 杀掉子进程（不碰 client/监听）。 */
    private killChild(): void {
        const child = this.child;
        if (!child) return;
        try {
            if (child.exitCode === null) child.kill();
        } catch {
            /* 已经没了 */
        }
    }

    private handleStderr(chunk: string): void {
        this.stderrBuffer += chunk;
        for (;;) {
            const newline = this.stderrBuffer.indexOf('\n');
            if (newline < 0) break;
            const line = this.stderrBuffer.slice(0, newline).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (!line) continue;
            this.stderrTail.push(line);
            while (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift();
            if (getSettings().showStderrNotes) this.append('note', `stderr: ${line}`);
        }
        this.scheduleFlush();
    }

    // ---------------------------------------------------------------- IPC（工具）

    /**
     * 控制帧的回执（插件 → 本进程）。
     *
     * 与工具帧共用通道、按 `kind` 分流：工具帧服务**模型**（`req`/`res`），
     * 控制帧服务**面板**（`ctl`/`ctl-res`），交互帧服务**人和模型之间那一问**（`ask`）。
     */
    private handleControlReply(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): void {
        const id = Number(frame.id);
        const entry = this.ctlPending.get(id);
        if (!entry) return;
        this.ctlPending.delete(id);
        clearTimeout(entry.timer);
        if (frame.ok === false) {
            entry.reject(new Error(String(frame.error ?? '插件返回失败')));
            return;
        }
        entry.resolve((frame.result && typeof frame.result === 'object' ? frame.result : {}) as Record<string, unknown>);
    }

    // ---------------------------------------------------------------- 交互（模型 ↔ 人）

    /**
     * 插件送来的一条交互帧（`kind: 'ask'`）。
     *
     * `phase: 'open'` → 记下来 + 在转写里留一条 note（人回看时知道「这里问过我」）；
     * `phase: 'settled'` → 收掉卡片，并把结果写成 note（谁回答的、结论是什么）。
     *
     * @param frame - `{phase, id, kind?, interaction?, outcome?, summary?}`。
     */
    private handleAskFrame(frame: {
        phase?: unknown;
        id?: unknown;
        kind?: unknown;
        interaction?: unknown;
        outcome?: unknown;
        summary?: unknown;
    }): void {
        const id = typeof frame.id === 'string' ? frame.id.trim() : '';
        if (!id) return;

        if (frame.phase === 'open') {
            const view = sanitizeInteraction(frame.interaction, id);
            if (!view) {
                console.warn(`[dsh_chat] 收到一条形状不对的交互帧（id=${id}），已忽略`);
                return;
            }
            this.interactions.set(id, view);
            this.append('note', describeInteraction(view));
            this.scheduleFlush();
            this.gateInteraction(view);
            return;
        }

        if (frame.phase === 'settled') {
            const view = this.interactions.get(id);
            if (!view) return;
            this.interactions.delete(id);
            const summary = typeof frame.summary === 'string' && frame.summary.trim() ? frame.summary.trim() : '已结束';
            this.append('note', `· ${summary}`);
            this.scheduleFlush();
            return;
        }
    }

    /**
     * 面板不在时立刻放行（等于「没人能回答」）。
     *
     * 为什么必须由主进程把关：插件那边只知道「我在等一个答案」，它看不见编辑器里
     * 到底有没有人在看这个面板。没有这一关，面板关掉之后模型会一直卡在提问上。
     *
     * @param view - 刚登记的交互。
     */
    private gateInteraction(view: InteractionView): void {
        const quiet = this.lastPanelActivity === 0 || Date.now() - this.lastPanelActivity > PANEL_QUIET_MS;
        if (!quiet) return;
        this.append('note', '· 面板不在（没有人在轮询），按「没人能回答」处理 —— 提问会失败、授权会被拒。');
        void this.answerInteraction({ id: view.id, action: 'delegate' }).catch((error) => {
            console.warn(`[dsh_chat] 放行一条没人看的交互失败：${describe(error)}`);
        });
    }

    /**
     * 回答一次交互（面板 → 插件）。
     *
     * 面板是渲染进程，它说的内容一律不可信 —— 所以这里**再验一遍**形状与取值范围，
     * 失败回一句人话（同 `sendMessage` 的图片校验口径）。
     *
     * @param payload - 面板发来的 `InteractionDecision`。
     * @returns `{ok}`；失败时带 `error`（面板原样显示）。
     */
    async answerInteraction(payload: unknown): Promise<{ ok: boolean; error?: string }> {
        const raw = (payload ?? {}) as { id?: unknown; action?: unknown; answers?: unknown; outcome?: unknown };
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const view = this.interactions.get(id);
        if (!view) return { ok: false, error: '这次交互已经结束了（回答过 / 被取消 / agent 重启过）' };

        const action: InteractionDecision['action'] =
            raw.action === 'dismiss' ? 'dismiss' : raw.action === 'delegate' ? 'delegate' : 'answer';
        const params: Record<string, unknown> = { id, action };

        if (action === 'answer') {
            if (view.kind === 'approval') {
                const outcome = String(raw.outcome ?? '');
                if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
                    return { ok: false, error: `授权结果只能是 allowed-once / rejected / cancelled，收到 "${outcome}"` };
                }
                params.outcome = outcome satisfies InteractionApprovalOutcome;
            } else {
                const answers = normalizeAnswerItems(raw.answers);
                if (answers.length === 0) return { ok: false, error: '回答是空的：选一个选项，或者写一句自定义回答。' };
                params.answers = answers;
            }
        }

        try {
            await this.callChild('interaction/answer', params, 30_000);
        } catch (error) {
            const message = describe(error);
            this.append('error', `回答没有送出去：${message}`);
            return { ok: false, error: message };
        }
        return { ok: true };
    }

    private async handleIpcFrame(frame: unknown): Promise<void> {
        if (!frame || typeof frame !== 'object') return;
        const request = frame as { __tag?: string; kind?: string; id?: unknown; method?: string; params?: unknown };
        if (request.__tag !== IPC_TAG || request.kind !== 'req' || request.id === undefined) return;

        const method = String(request.method ?? '');
        const params = request.params && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
        const handler = COCOS_IPC_METHODS[method];

        let reply: { ok: boolean; text: string; error?: string; data?: unknown };
        if (!handler) {
            reply = {
                ok: false,
                text: `dsh_chat：未知的编辑器方法 "${method}"（扩展版本与 profile 版本可能不匹配，请重新打开面板或重载扩展）。`,
            };
        } else {
            try {
                reply = await handler(params);
            } catch (error) {
                reply = { ok: false, text: `编辑器侧处理 "${method}" 时抛错：${describe(error)}` };
            }
        }

        try {
            // 失败时**必须**把原因放进 `error`：DSH 侧插件只读帧上的 `error`（读不到就回落成
            // 一句没有信息量的「编辑器返回失败」）。这里少了它，`result.text` 里那句真原因
            // 就永远到不了模型眼前 —— 实测为此盲试了十几轮。
            this.child?.send({
                __tag: IPC_TAG,
                kind: 'res',
                id: request.id,
                ok: reply.ok,
                ...(reply.ok ? {} : { error: reply.error ?? reply.text ?? '编辑器侧执行失败（没有给出原因）' }),
                result: reply,
            });
        } catch (error) {
            console.warn(`[dsh_chat] 回执 IPC 失败：${describe(error)}`);
        }
    }

    // ---------------------------------------------------------------- 通知处理

    private handleNotification(method: string, params: Record<string, unknown>): void {
        switch (method) {
            case 'session.event': {
                const event = params.event;
                if (event && typeof event === 'object') {
                    this.handleSessionEvent(event as Record<string, unknown>, false, String(params.sessionId ?? ''));
                }
                break;
            }
            case 'session.status': {
                this.running = params.status === 'running';
                if (!this.running) this.finishStreams();
                this.scheduleFlush();
                break;
            }
            case 'subagent.started': {
                this.append('note', `子 agent 启动：${String(params.agentId ?? '')}`);
                break;
            }
            case 'subagent.finished': {
                this.append('note', `子 agent 结束：${String(params.agentId ?? '')}（${String(params.status ?? '')}）`);
                break;
            }
            default:
                // 协议可能新增通知；不认识的忽略，不要因为未知方法报错。
                break;
        }
    }

    /**
     * 处理一条会话事件。
     *
     * ⚠ **信封结构是踩过的坑**：`session.event` 的 `params.event` 是
     * `SessionEvent = { type, seq, time, data: SessionEventMap[type] }` ——
     * 载荷一律在 **`event.data`** 里，不在 `event` 上。第一版直接读 `event.name` / `event.message`，
     * 结果是工具名变成 `unknown`、助手文本一个字都上不了屏（而事件本身是好的）。
     * 权威定义见 `dsh-session` 的 `SessionEventMap`。
     *
     * @param event - 事件信封（实时通知与**磁盘日志**同构，所以这一份投影两处共用）。
     * @param replay - 是不是在回放历史：回放时「用户消息」也要上屏（实时那条是 `send()` 自己回显的），
     *   助手消息还要把思考块也画出来（实时走的是 `assistant/chunk` 流式累计）。
     * @param sessionId - 事件属于哪个会话；用于把**别的会话**（子 agent、上一轮 SDK 会话）挡在外面。
     */
    private handleSessionEvent(event: Record<string, unknown>, replay = false, sessionId = ''): void {
        // 接上历史会话之后，运行时里可能同时有「老的 SDK 会话」和「接上来的会话」两个 id，
        // 不按 id 过滤的话两段对话会串在一起。子 agent 的会话同样被挡掉（它另有
        // subagent.started/finished 两条 note）。
        if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId) return;

        // 实时水位（缓存记录「落后多少条」的参照）。只记**实时**的：回放历史时那些 seq
        // 属于另一条会话，混进来会让 `behind` 算成一个荒唐的数。
        const envelopeSeq = Number(event.seq ?? 0);
        if (!replay && Number.isFinite(envelopeSeq) && envelopeSeq > this.lastEventSeq) {
            this.lastEventSeq = envelopeSeq;
        }

        const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
        switch (String(event.type ?? '')) {
            case 'session/title': {
                /**
                 * 会话标题（`dsh-session-title` 的服务事件，**只写日志**、不进模型上下文）。
                 *
                 * 两条口径：
                 * 1. **最新一条胜出** —— 服务自己保证「较新的修订取代旧的」，我们只取最后一个
                 *    （`session-title-llm` 的那条会覆盖同步的回退标题，所以标题会「先粗后细」地跳一次，
                 *    这是设计如此，不是抖动）。
                 * 2. **别的会话的标题要挡掉** —— 与上面那条 id 过滤同一个理由（子 agent / 上一轮
                 *    会话的标题会把当前会话的标题顶掉）。`session/title` 不带 sessionId 在身上，
                 *    所以只能靠信封参数；回放时 `sessionId` 为空、不挡。
                 */
                if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId) break;
                const title = typeof data.title === 'string' ? data.title.trim() : '';
                if (!title || title === this.sessionTitle) break;
                this.sessionTitle = title;
                this.titleDirty = true;
                this.scheduleFlush();
                break;
            }
            case 'command/run': {
                // 记下名字，等 `command/done` 配（回放时才有用，见字段注释）
                const commandId = String(data.commandId ?? '');
                if (commandId) this.commandNames.set(commandId, String(data.name ?? ''));
                break;
            }
            case 'command/done': {
                const commandId = String(data.commandId ?? '');
                const name = this.commandNames.get(commandId) ?? '';
                this.commandNames.delete(commandId);
                /**
                 * 只在**回放**时画：实时那条结果由面板自己画（`runCommand` 的控制回执带
                 * `known`/`kind` 结构，比这条日志事件更准）。两处都画就会看到两遍。
                 * 与 `user/message` 是同一个纪律。
                 */
                if (!replay) break;
                const text = typeof data.text === 'string' ? data.text.trim() : '';
                const failed = data.kind === 'error';
                this.append('note', `命令 /${name || '(未知)'} ${failed ? '失败' : '完成'}${text ? `：${text}` : ''}`);
                break;
            }
            case 'user/message': {
                // 自己发的那条已经在 send() 里回显过了；这里只把「注入的上下文」记成一行 note，
                // 否则转写里会混进一大堆 AGENTS.md / skill 正文。
                const source = data.source as { kind?: string; form?: string; summary?: string } | undefined;
                if (source?.kind === 'plugin' && source.form === 'notice' && source.summary) {
                    this.append('note', `注入上下文：${source.summary}`);
                } else if (replay && (!source || source.kind === 'user')) {
                    // 回放时用户消息必须画出来（实时那条由 send() 负责；历史里没有 send()）
                    const blocks = data.content ?? (data.message as { content?: unknown } | undefined)?.content;
                    const text = textOfBlocks(blocks);
                    const images = imagesOfBlocks(blocks);
                    // 纯图片消息（没有文字）在日志里是一堆 image 块 —— 也要上屏，只画碎片
                    if (text || images.length > 0) this.append('user', text, undefined, images);
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = data.chunk as { type?: string; text?: string } | undefined;
                if (!chunk) break;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.pushStream('agent', chunk.text);
                else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') this.pushStream('thinking', chunk.text);
                break;
            }
            case 'assistant/message': {
                const message = data.message as { content?: unknown } | undefined;
                const text = textOfBlocks(message?.content);
                const interrupted = data.interrupted === true;
                if (replay) {
                    // 回放：思考块也在 content 里（实时是 chunk 流），按块顺序还原
                    for (const block of Array.isArray(message?.content) ? message?.content : []) {
                        const typed = block as { type?: string; text?: string };
                        if (typed?.type === 'reasoning' && typeof typed.text === 'string' && typed.text.trim()) {
                            this.append('thinking', typed.text);
                        }
                    }
                    if (text) this.append('agent', text);
                } else if (this.textStream) {
                    // 用「拼装好的完整消息」盖掉流式累积（同一 seq → 面板原地替换，不会出现两遍）
                    if (text) this.textStream.text = text;
                    this.touch(this.textStream);
                    this.textStream = null;
                } else if (text) {
                    this.append('agent', text);
                }
                this.finishReasoningStream();
                if (interrupted) this.append('note', '本轮被中断（以上是已产出的内容）');
                break;
            }
            case 'tool/call': {
                this.finishStreams();
                const callId = String(data.callId ?? '');
                const entry = this.append('tool', undefined, {
                    name: String(data.name ?? 'unknown'),
                    callId,
                    args: typeof data.arguments === 'string' ? data.arguments : undefined,
                    done: false,
                });
                if (callId) this.toolByCallId.set(callId, entry);
                break;
            }
            case 'tool/result': {
                const message = data.message as
                    | { source?: { callId?: string }; content?: Array<{ content?: unknown; isError?: boolean; toolCallId?: string }> }
                    | undefined;
                const callId = String(message?.source?.callId ?? message?.content?.[0]?.toolCallId ?? '');
                const entry = callId ? this.toolByCallId.get(callId) : undefined;
                // ⚠ 文本与 isError 的取法见 `toolResultOf`（新老日志形状不同，只认一种会静默丢结果）
                const result = toolResultOf(message);
                const output = result.text;
                const isError = result.isError || data.error !== undefined;
                const shown =
                    output.length > TOOL_OUTPUT_DISPLAY_LIMIT
                        ? `${output.slice(0, TOOL_OUTPUT_DISPLAY_LIMIT)}\n…（已截断，完整结果已交给模型）`
                        : output;
                if (entry) {
                    // `endedAt` 只给面板算耗时用（`entry.at` 是发起时刻）
                    entry.tool = { ...(entry.tool as ToolEntry), done: true, ok: !isError, output: shown, endedAt: Date.now() };
                    this.touch(entry);
                    if (callId) this.toolByCallId.delete(callId);
                } else {
                    this.append('tool', undefined, {
                        name: '(未知工具)',
                        callId,
                        done: true,
                        ok: !isError,
                        output: shown,
                        endedAt: Date.now(),
                    });
                }
                break;
            }
            case 'turn/end': {
                this.finishStreams();
                // ⚠ `reason` 是**对象**不是字符串：`TurnEndReason = { kind: 'completed' | 'aborted'
                // | 'blocked' | 'error' | 'max-tokens' | 'interrupted', ... }`。
                // 第一版 `String(reason)` 直接打出 `[object Object]`。
                const raw = data.reason as
                    | string
                    | { kind?: string; error?: { message?: string; code?: string } }
                    | undefined;
                const kind = typeof raw === 'string' ? raw : String(raw?.kind ?? '');
                if (kind && kind !== 'completed') {
                    const detail =
                        typeof raw === 'object' && raw?.error?.message ? `：${raw.error.message}` : '';
                    this.append('note', `本轮结束：${kind}${detail}`);
                }
                // 缓存恰好在 `turn/end` 写一次检查点 —— 但要等一拍（谁先到没保证，见常量注释）
                this.scheduleUsageRefresh();
                break;
            }
            case 'todo/write': {
                /**
                 * agent 写了一份新的待办清单（`todo_write` 工具，**整份替换**）。
                 *
                 * 为什么这一条值得实时画（而不是等缓存）：它标的正是「我现在做到哪一步」，
                 * 而缓存攒够 200 条事件或 5 秒才写一次 —— 那几秒恰好是人最想知道的时候。
                 */
                this.applyLiveTodos(data.todos);
                break;
            }
            case 'turn/start': {
                // 新一轮开始（`turn/start` 的 seq 就是回合大纲里每一轮的锚点，见 `TurnView.seq`）
                this.markTurnStart(Number(data.turn ?? 0));
                break;
            }
            case 'goal/change': {
                /**
                 * 目标变了（创建 / 编辑 / 暂停 / 恢复 / 完成 / 阻塞 / **清除**）。
                 *
                 * ⚠ 载荷是**变更元数据**（`{operation, goal, roundsStarted, ...}`），
                 * 而缓存里那一行是**投影状态**（`{current: {goal, ...}}`）—— 两个形状不一样，
                 * 所以解析也分两个函数（`parseGoalChange` / `parseGoalProjection`）。
                 * `operation === 'clear'` 是一条墓碑：这时候「没有目标」是**事件说的**，
                 * 不能被缓存里旧的那一份盖回去。
                 */
                this.applyLiveGoal(data);
                break;
            }
            default:
                // `step/start` / `request/header` 等登记型事件不需要上屏。
                break;
        }
    }

    // ---------------------------------------------------------------- 转写

    private append(kind: EntryKind, text?: string, tool?: ToolEntry, images?: EntryImage[]): Entry {
        const entry: Entry = { seq: ++this.seq, rev: ++this.revision, kind, at: Date.now(), text, tool };
        if (images && images.length > 0) entry.images = images;
        this.entries.push(entry);
        // 回合锚点绑在「`turn/start` 之后第一条上屏的条目」上（见 `markTurnStart`）
        this.bindTurnAnchor(entry.seq);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
            /**
             * 挤掉一条 = 某些回合的跳转落点可能已经不在了。让进度重发一次，
             * 面板那边就会把那些回合改成「已经不在转写窗口里」（`entrySeq` 变 null）。
             * 这里只置脏、不做 JSON 比对：`append` 是热路径，比对要扫一遍 entries。
             */
            this.progressDirty = true;
            this.scheduleFlush();
        }
        this.dirty.add(entry);
        this.scheduleFlush();
        return entry;
    }

    private touch(entry: Entry): void {
        entry.rev = ++this.revision;
        this.dirty.add(entry);
        this.scheduleFlush();
    }

    /** 流式追加：第一条 delta 建条目，后续原地增长（同一 seq，面板原地替换）。 */
    private pushStream(kind: 'agent' | 'thinking', delta: string): void {
        let entry = kind === 'agent' ? this.textStream : this.reasoningStream;
        if (!entry) {
            // append() 自己会标脏 + 排刷
            entry = this.append(kind, delta);
            if (kind === 'agent') this.textStream = entry;
            else this.reasoningStream = entry;
            return;
        }
        entry.text = `${entry.text ?? ''}${delta}`;
        this.touch(entry);
    }

    /** 结束流式（收尾成静态条目）。 */
    private finishStreams(): void {
        this.textStream = null;
        this.finishReasoningStream();
    }

    private finishReasoningStream(): void {
        if (!this.reasoningStream) return;
        if (!this.reasoningStream.text) {
            // 空的思考条目没有意义，从转写里摘掉
            const index = this.entries.indexOf(this.reasoningStream);
            if (index >= 0) this.entries.splice(index, 1);
            this.dirty.delete(this.reasoningStream);
        }
        this.reasoningStream = null;
    }

    // ---------------------------------------------------------------- 广播

    private setStatus(status: AgentStatus): void {
        this.status = status;
        this.scheduleFlush();
    }

    private fail(message: string): { ok: false; error: string } {
        this.lastError = message;
        this.status = 'error';
        this.append('error', message);
        return { ok: false, error: message };
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    private flush(): void {
        // ⚠ 标题变化**不会**动 `dirty`（它不是转写条目），所以要单独当一个「有东西要发」的理由。
        // 少了这一条，`session/title` 事件会静默地只改内存、面板要等下一次转写变化才看到。
        // 用量同理（`usageDirty`）：它是回合结束才刷的，等下一次转写变化可能永远等不到。
        // 进度（`progressDirty`）也一样，而且它比用量更急（清单是回合**中间**写的）。
        if (this.dirty.size === 0 && !this.titleDirty && !this.usageDirty && !this.progressDirty) return;
        this.titleDirty = false;
        const usageChanged = this.usageDirty;
        this.usageDirty = false;
        const progressChanged = this.progressDirty;
        this.progressDirty = false;
        const batch = [...this.dirty].slice(0, FLUSH_BATCH_LIMIT);
        for (const entry of batch) this.dirty.delete(entry);
        if (this.dirty.size > 0) this.scheduleFlush();
        const update: HostUpdateView = {
            entries: batch,
            revision: this.revision,
            generation: this.generation,
            status: this.status,
            running: this.running,
            // 整份交互（不是增量）：面板据此把「现在必须点一下」的那块画出来 / 收掉
            interactions: [...this.interactions.values()],
            // 标题同理整份发（它只有一个值，增量没有意义）
            title: this.sessionTitle,
        };
        if (usageChanged) {
            update.usage = this.usage ? { ...this.usage } : null;
            update.usageNote = this.usageNote;
        }
        if (progressChanged) {
            update.progress = this.progressView();
            update.progressNote = this.progressNote;
        }
        for (const listener of this.listeners) {
            try {
                listener(update);
            } catch (error) {
                console.warn(`[dsh_chat] 更新回调抛错：${describe(error)}`);
            }
        }
        try {
            Editor.Message.broadcast(BROADCAST_CHANNEL, update as unknown as object);
        } catch {
            // 广播是保险丝而非主路：面板还有轮询兜底，这里失败不算错。
        }
    }
}
