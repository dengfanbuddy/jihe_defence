"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DshHost = void 0;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const path_1 = require("path");
const cocos_tools_1 = require("./cocos-tools");
const constants_1 = require("./constants");
const history_1 = require("./history");
const images_1 = require("./images");
const paths_1 = require("./paths");
const sdk_client_1 = require("./sdk-client");
const settings_1 = require("./settings");
const stats_1 = require("./stats");
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
function bundledSkillDir() {
    return (0, path_1.join)(__dirname, '..', 'skills');
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
const PANEL_QUIET_MS = 60000;
/** 交互载荷的长度上限（面板是渲染进程，插件也可能出错 —— 别让一条脏数据把 UI 撑死）。 */
const INTERACTION_LIMITS = { questions: 8, options: 12, text: 4000, detail: 40000 };
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
const USAGE_REFRESH_AFTER_COMMAND_MS = [900, 6000];
/** 从 ContentBlock[] 里取纯文本。 */
function textOfBlocks(blocks) {
    if (!Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'text') {
            const text = block.text;
            if (typeof text === 'string' && text)
                parts.push(text);
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
function imagesOfBlocks(blocks) {
    var _a;
    if (!Array.isArray(blocks))
        return [];
    const out = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type !== 'image')
            continue;
        const ref = typed.attachment;
        out.push({
            name: ref === null || ref === void 0 ? void 0 : ref.name,
            mimeType: (_a = ref === null || ref === void 0 ? void 0 : ref.mediaType) !== null && _a !== void 0 ? _a : typed.mimeType,
            bytes: typeof (ref === null || ref === void 0 ? void 0 : ref.bytes) === 'number' ? ref.bytes : undefined,
            width: typeof (ref === null || ref === void 0 ? void 0 : ref.width) === 'number' ? ref.width : undefined,
            height: typeof (ref === null || ref === void 0 ? void 0 : ref.height) === 'number' ? ref.height : undefined,
        });
    }
    return out;
}
/** 一张待发送的图 → SDK 的内容块（`data` 必须是规范 base64，见 `source/images.ts`）。 */
function imageBlockOf(image) {
    const block = { type: 'image', data: image.data, mimeType: image.mimeType };
    if (image.name)
        block.name = image.name;
    return block;
}
/** 把异常/未知收敛成一句话。 */
function describe(error) {
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
function toolResultOf(message) {
    const typed = (message !== null && message !== void 0 ? message : {});
    const content = typed.content;
    if (!Array.isArray(content))
        return { text: '', isError: typed.isError === true };
    const wrapper = content[0];
    const blocks = (wrapper === null || wrapper === void 0 ? void 0 : wrapper.type) === 'tool-result' && Array.isArray(wrapper.content) ? wrapper.content : content;
    return {
        text: textOfBlocks(blocks),
        isError: (wrapper === null || wrapper === void 0 ? void 0 : wrapper.isError) === true || typed.isError === true,
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
function sanitizeInteraction(raw, id) {
    var _a;
    if (!raw || typeof raw !== 'object')
        return null;
    const source = raw;
    const kind = source.kind === 'approval' ? 'approval' : source.kind === 'question' ? 'question' : null;
    if (!kind)
        return null;
    const cut = (value, limit) => {
        if (typeof value !== 'string' || !value)
            return undefined;
        return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
    };
    const view = {
        id,
        kind,
        at: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : Date.now(),
    };
    const agentId = cut(source.agentId, 128);
    if (agentId)
        view.agentId = agentId;
    const sessionId = cut(source.sessionId, 128);
    if (sessionId)
        view.sessionId = sessionId;
    if (kind === 'approval') {
        view.toolName = (_a = cut(source.toolName, 200)) !== null && _a !== void 0 ? _a : '(未知工具)';
        const callId = cut(source.callId, 128);
        if (callId)
            view.callId = callId;
        const reason = cut(source.reason, INTERACTION_LIMITS.text);
        if (reason)
            view.reason = reason;
        return view;
    }
    const questions = Array.isArray(source.questions) ? source.questions.slice(0, INTERACTION_LIMITS.questions) : [];
    const items = [];
    for (const entry of questions) {
        if (!entry || typeof entry !== 'object')
            continue;
        const question = entry;
        const questionId = cut(question.id, 128);
        const text = cut(question.question, INTERACTION_LIMITS.text);
        if (!questionId || !text)
            continue;
        const item = { id: questionId, question: text };
        const detail = cut(question.detail, INTERACTION_LIMITS.detail);
        if (detail)
            item.detail = detail;
        const header = cut(question.header, 200);
        if (header)
            item.header = header;
        if (Array.isArray(question.options)) {
            const options = [];
            for (const option of question.options.slice(0, INTERACTION_LIMITS.options)) {
                if (!option || typeof option !== 'object')
                    continue;
                const label = cut(option.label, 200);
                if (!label)
                    continue;
                const description = cut(option.description, 500);
                options.push({ label, ...(description === undefined ? {} : { description }) });
            }
            if (options.length > 0)
                item.options = options;
        }
        if (question.multiSelect === true)
            item.multiSelect = true;
        const intent = question.intent && typeof question.intent === 'object' ? question.intent : null;
        if (intent) {
            const intentKind = cut(intent.kind, 64);
            const approve = cut(intent.approve, 200);
            if (intentKind && approve)
                item.intent = { kind: intentKind, approve };
        }
        items.push(item);
    }
    // 一道题都没有的 question 交互是坏的：登记了也没法回答
    if (items.length === 0)
        return null;
    view.questions = items;
    return view;
}
/**
 * 转写里那条「这里问过我」的 note（**只描述，不代替对话框**）。
 *
 * @param view - 已收敛的交互。
 * @returns 一行文字。
 */
function describeInteraction(view) {
    var _a, _b, _c;
    if (view.kind === 'approval') {
        return `⚠ 需要你批准：${(_a = view.toolName) !== null && _a !== void 0 ? _a : '这次操作'}${view.reason ? `\n${view.reason}` : ''}`;
    }
    const first = (_b = view.questions) === null || _b === void 0 ? void 0 : _b[0];
    const header = (first === null || first === void 0 ? void 0 : first.header) ? `【${first.header}】` : '';
    const count = view.questions && view.questions.length > 1 ? `（共 ${view.questions.length} 问）` : '';
    return `❓ 模型在等你回答：${header}${(_c = first === null || first === void 0 ? void 0 : first.question) !== null && _c !== void 0 ? _c : ''}${count}`;
}
/**
 * 校验面板送回来的答案（面板是渲染进程，它说的不可信）。
 *
 * @param raw - `[{id, selected?, custom?}]`。
 * @returns 合法条目；空条目被丢掉（空数组 = 这次回答无效）。
 */
function normalizeAnswerItems(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object')
            continue;
        const item = entry;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id)
            continue;
        const selected = Array.isArray(item.selected)
            ? item.selected.filter((value) => typeof value === 'string' && value !== '').slice(0, INTERACTION_LIMITS.options)
            : [];
        const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.slice(0, INTERACTION_LIMITS.text) : undefined;
        if (selected.length === 0 && custom === undefined)
            continue;
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
function normalizeCommands(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object')
            continue;
        const item = entry;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        // 命令名的合法字符集由注册表保证（小写字母/数字/_/-）；这里只做长度与形状的兜底，
        // 别自己实现一套语法 —— 语法在 `ctx.commands` 那边，抄一份必然漂移。
        if (!name || name.length > 40 || /\s/.test(name))
            continue;
        const view = {
            name,
            description: typeof item.description === 'string' ? item.description.slice(0, 200) : '',
        };
        if (typeof item.hint === 'string' && item.hint)
            view.hint = item.hint.slice(0, 80);
        if (item.images === true)
            view.images = true;
        out.push(view);
        if (out.length >= COMMAND_LIMIT)
            break;
    }
    return out;
}
/**
 * 收敛插件送回的 `@` 候选。
 *
 * @param raw - 插件回的 `candidates` 数组。
 * @returns 干净的候选数组。
 */
function normalizeReferences(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object')
            continue;
        const item = entry;
        const path = typeof item.path === 'string' ? item.path.trim() : '';
        if (!path || path.length > 400)
            continue;
        out.push({ path, kind: item.kind === 'directory' ? 'directory' : 'file' });
        if (out.length >= REFERENCE_LIMIT)
            break;
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
function normalizeActivity(jobsRaw, subsRaw, notes, at) {
    const jobs = [];
    for (const entry of Array.isArray(jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.jobs) ? jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.jobs : []) {
        if (!entry || typeof entry !== 'object')
            continue;
        const item = entry;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id)
            continue;
        const status = typeof item.status === 'string' ? item.status : '';
        jobs.push({
            id,
            kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : '',
            label: typeof item.label === 'string' ? item.label.slice(0, 400) : '',
            status: (JOB_STATUSES.has(status) ? status : 'unknown'),
            detail: typeof item.detail === 'string' ? item.detail.slice(0, 200) : null,
            startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) ? item.startedAt : null,
            finishedAt: typeof item.finishedAt === 'number' && Number.isFinite(item.finishedAt) ? item.finishedAt : null,
            ownerSessionId: typeof item.ownerSessionId === 'string' ? item.ownerSessionId : '',
            depth: typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : null,
        });
        if (jobs.length >= JOB_LIMIT)
            break;
    }
    const subagents = [];
    for (const entry of Array.isArray(subsRaw === null || subsRaw === void 0 ? void 0 : subsRaw.subagents) ? subsRaw === null || subsRaw === void 0 ? void 0 : subsRaw.subagents : []) {
        if (!entry || typeof entry !== 'object')
            continue;
        const item = entry;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id)
            continue;
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
        if (subagents.length >= SUBAGENT_LIMIT)
            break;
    }
    // 插件自己报的「截断了 / 某个拥有者列不出来」也是说明的一部分，原样带上去
    if ((jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.truncated) === true) {
        notes.push(`后台任务只画了最近 ${JOB_LIMIT} 条（一共 ${typeof jobsRaw.total === 'number' ? jobsRaw.total : '?'} 条）。`);
    }
    for (const error of Array.isArray(jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.errors) ? jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.errors : []) {
        if (typeof error === 'string' && error)
            notes.push(`有一个会话的后台任务列不出来：${error.slice(0, 200)}`);
    }
    if ((subsRaw === null || subsRaw === void 0 ? void 0 : subsRaw.truncated) === true) {
        notes.push(`子 agent 只画了前 ${SUBAGENT_LIMIT} 个（一共 ${typeof subsRaw.total === 'number' ? subsRaw.total : '?'} 个）。`);
    }
    return {
        jobs,
        subagents,
        jobsAvailable: (jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.available) === true,
        subagentsAvailable: (subsRaw === null || subsRaw === void 0 ? void 0 : subsRaw.available) === true,
        jobsReason: typeof (jobsRaw === null || jobsRaw === void 0 ? void 0 : jobsRaw.reason) === 'string' ? jobsRaw.reason : null,
        subagentsReason: typeof (subsRaw === null || subsRaw === void 0 ? void 0 : subsRaw.reason) === 'string' ? subsRaw.reason : null,
        notes,
        at,
    };
}
/** DSH 子进程的宿主。整个扩展只有这一个实例（`main.ts` 里持有）。 */
class DshHost {
    constructor() {
        this.child = null;
        this.client = null;
        this.status = 'stopped';
        this.running = false;
        this.sessionId = null;
        this.lastBootMs = null;
        this.lastError = null;
        this.runtime = { nodeExe: null, nodeSource: '未探测', dshBin: null, dshSource: '未探测' };
        /**
         * 当前 sessionId 的来历。
         *
         * - `sdk`：SDK 协议 `session/prompt` 懒创建出来的会话（老路子）；
         * - `resumed`：插件用 `agents.resume` **真正接上**的历史会话 —— 发消息走控制帧；
         * - `history`：只是把历史日志回放到面板上（只读，还没接上）。
         */
        this.sessionKind = 'sdk';
        /**
         * 当前会话的标题（`session/title` 事件折出来的**最新一条**）。
         *
         * 它不来自 SDK 协议 —— 标题是**会话日志里的一条事件**（`dsh-session-title`
         * 追加的仅写日志事件），所以和别的会话事件走同一条 `session.event` 流。
         * 两条来源：确定性回退（首条用户消息的前几个词，同步就有）与 `session-title-llm`
         * （**异步**：另发一次模型请求，比首轮回答慢一拍才追上，较新者胜出）。
         */
        this.sessionTitle = null;
        /**
         * `command/run` 记下的命令名，供配对的 `command/done` 用。
         *
         * 为什么要配：`command/done` 只带结果文本，**不带命令名**（注册表按 `commandId` 配对）。
         * 只在**回放**时用得上（实时那条结果由面板自己画，见 `runCommand`）。
         */
        this.commandNames = new Map();
        /** 非空 = 对话区正在显示一条历史会话。 */
        this.historyView = null;
        /**
         * 当前会话的用量（从 DSH 的**会话投影缓存**读的，见 `stats.ts`）。
         *
         * 三条触发时机：**回合结束**（缓存恰好在 `turn/end` 写检查点）、**换会话**、**面板主动要**。
         * 不做定时轮询 —— 检查点本身就是攒着写的，读得再勤也只是同一份数字，
         * 而这份文件在大会话上能到几百 KB。
         */
        this.usage = null;
        /** `usage` 为 null 时的原因（「还没读数」与「读失败」在面板上是两句话）。 */
        this.usageNote = null;
        /** 用量变了但还没广播（它不是转写条目，`dirty` 盯不到它）。 */
        this.usageDirty = false;
        /**
         * 本会话**实时水位**：日志里最后一条事件的 `seq`。
         *
         * 只用来算缓存记录「落后多少条」（`behind`）—— 检查点是攒着写的，所以面板必须能说
         * 「这个数字是记到第几条为止的」。只统计**实时**事件（回放历史时不记：那是另一条会话的编号）。
         */
        this.lastEventSeq = 0;
        /** 排着的「晚一点再读一次用量」的定时器（见 `scheduleUsageRefresh`）。 */
        this.usageTimers = [];
        // ---- 进度（清单 / 目标 / 回合目录）----
        //
        // 两条来路，合并规则只有一条：**事件优先、缓存补洞**（见 `mergeProgress`）：
        // - `todo/write` / `turn/start` / `goal/change` 三个**实时事件**：精确，但只覆盖面板
        //   转写窗口里的那一段（历史回放只读日志尾部的 2000 条事件）；
        // - 会话投影缓存：整个日志折出来的（回合大纲连 600 条窗口之外的轮次都有），但旧。
        /** 实时事件给出的清单（`todo/write` 的整份快照）。null = 还没见过任何一份。 */
        this.todos = null;
        /** 那份清单是**第几轮**写的（0 = 不知道，`turn/start` 不在回放窗口里时就会这样）。 */
        this.todosTurn = 0;
        /** 现在在第几轮（`turn/start` 给的）。 */
        this.currentTurn = 0;
        /** 事件流里见过的目标；`goalSeen` 区分「没有目标」与「还没见过 `goal/change`」。 */
        this.goal = null;
        this.goalSeen = false;
        /** 缓存那一份清单 / 目标（**只在事件里没有这一块时**才用，见 `progressView`）。 */
        this.checkpointTodos = null;
        this.checkpointGoal = null;
        /**
         * 第几轮 → 转写条目号（`turn/start` 到达时记下「下一条会拿到几号」）。
         *
         * 为什么要这张表：面板的条目号是**宿主自己的计数器**，而回合大纲给的 `seq` 是
         * **会话事件序号**，两者毫不相干 —— 只把大纲发给面板，那些「第 N 轮」就只能看不能点。
         * `turn/start` 之后第一条上屏的条目（正常就是那一轮的用户消息）就是跳转落点。
         */
        this.turnAnchors = new Map();
        /** `turn/start` 已经到了、但第一条条目还没上屏：等 `append` 来绑锚点。 */
        this.pendingAnchorTurn = null;
        /** 回合大纲（缓存给的整个日志，带 `entrySeq` 之后就是面板要画的那一份）。 */
        this.outline = null;
        /** 口径说明：读盘那一路 + 三个实时事件各自的（分开存，免得互相覆盖）。 */
        this.checkpointNotes = [];
        this.todoNotes = [];
        this.goalNotes = [];
        /** 进度变了但还没广播。 */
        this.progressDirty = false;
        /** 上一次广播出去的进度（JSON），用来免掉「一个字节都没变」的那些广播。 */
        this.progressJson = '';
        /** 至少成功读过一次检查点（「一份真的没有回合的白记录」也算成功）。 */
        this.progressSeen = false;
        /** 进度那一份读失败 / 还没有读数时的原因。 */
        this.progressNote = null;
        /** 缓存里的水位（进度里 `turns` / `goal` 那两块的新鲜度）。 */
        this.progressSeq = null;
        this.progressBehind = null;
        this.progressUpdatedAt = 0;
        this.entries = [];
        this.seq = 0;
        this.revision = 0;
        /** 转写代数：清空/换会话就 +1（面板据此丢弃旧条目）。 */
        this.generation = 0;
        /** 控制帧（面板→插件）的请求号与在飞请求。 */
        this.ctlSeq = 0;
        this.ctlPending = new Map();
        /** 流式中的条目（文本 / 思考各一条，回合内复用）。 */
        this.textStream = null;
        this.reasoningStream = null;
        /** callId → 工具条目，用于把 `tool/result` 配回 `tool/call`。 */
        this.toolByCallId = new Map();
        /**
         * 正在等人类拍板的交互（插件经 `kind:'ask'` 送来的），按发起顺序排。
         *
         * 一般 0 或 1 条；用 Map 是为了让「子 agent 的授权请求」与「主会话的提问」重叠时
         * 两条都能显示、都能回答，而不是排队等着。
         */
        this.interactions = new Map();
        /**
         * 面板最近一次活动的时刻（`get-events` 轮询）。
         *
         * 用途只有一个：**面板不在时别让模型干等** —— 交互请求到达时若面板早已不轮询
         * （编辑器关了那个面板、或者只在终端跑这个 profile），立刻按「没人能回答」处理，
         * 行为与没有这套交互通道时一致（提问报错、授权失败关闭）。
         */
        this.lastPanelActivity = 0;
        /** 本帧内被改动过的条目（广播用）。 */
        this.dirty = new Set();
        this.flushTimer = null;
        /** 标题变了但还没广播（标题不是转写条目，`dirty` 盯不到它）。 */
        this.titleDirty = false;
        this.stderrTail = [];
        this.stderrBuffer = '';
        this.listeners = new Set();
    }
    // ---------------------------------------------------------------- 对外只读
    /** 注册更新回调（`main.ts` 用它发广播）。返回注销函数。 */
    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** 当前快照。 */
    snapshot() {
        var _a, _b;
        return {
            status: this.status,
            running: this.running,
            sessionId: this.sessionId,
            sessionKind: this.sessionKind,
            history: this.historyView ? { ...this.historyView } : null,
            generation: this.generation,
            pid: (_b = (_a = this.child) === null || _a === void 0 ? void 0 : _a.pid) !== null && _b !== void 0 ? _b : null,
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
    notePanelActivity() {
        this.lastPanelActivity = Date.now();
    }
    /** 增量拉取：返回 `rev > since` 的条目（同一 seq 会被反复返回，面板原地更新）。 */
    eventsSince(since) {
        const from = Number.isFinite(since) ? since : 0;
        return {
            entries: this.entries.filter((entry) => entry.rev > from),
            revision: this.revision,
            generation: this.generation,
        };
    }
    /** 探测一次运行时（面板要在没启动时也能显示「将用哪个 node/dsh」）。 */
    probeRuntime() {
        this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
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
    async start() {
        var _a;
        if (this.status === 'ready' || this.status === 'starting')
            return { ok: true };
        const settings = (0, settings_1.getSettings)();
        this.runtime = (0, paths_1.resolveRuntime)(settings);
        if (!this.runtime.nodeExe) {
            return this.fail('找不到可用的 node。请在 DSH 面板设置里填「node 路径」，或把 node 加到 PATH。' +
                '（注意：编辑器自带的 Electron 不是 node，不能拿来跑 dsh。）');
        }
        if (!this.runtime.dshBin) {
            return this.fail('找不到 dsh CLI 入口。请在设置里填「dsh bin.js 路径」（通常形如 ' +
                '`<npm 全局目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`）。');
        }
        const cwd = settings.workdir || Editor.Project.path;
        this.setStatus('starting');
        this.lastError = null;
        this.stderrTail = [];
        this.stderrBuffer = '';
        const startedAt = Date.now();
        try {
            this.child = (0, child_process_1.fork)(this.runtime.dshBin, ['--profile', constants_1.PROFILE_NAME], {
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
            });
        }
        catch (error) {
            return this.fail(`启动 dsh 子进程失败：${describe(error)}`);
        }
        this.attachChild(this.child);
        try {
            const params = {
                cwd,
                provider: settings.provider,
                model: settings.model,
            };
            if (settings.reasoningEffort)
                params.reasoningEffort = settings.reasoningEffort;
            if (settings.maxTokens > 0)
                params.maxTokens = settings.maxTokens;
            await ((_a = this.client) === null || _a === void 0 ? void 0 : _a.initialize(params));
        }
        catch (error) {
            const message = describe(error);
            // 起不来就别留半死的进程
            this.killChild();
            return this.fail(`初始化失败：${message}`);
        }
        this.lastBootMs = Date.now() - startedAt;
        this.setStatus('ready');
        this.append('note', `agent 已就绪（${this.lastBootMs}ms） 模型 ${settings.provider}/${settings.model}；工作目录 ${cwd}`);
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
    async restoreLastSession(cwd) {
        var _a, _b, _c, _d, _e, _f;
        try {
            const listed = await (0, history_1.listHistory)(this.runtime.nodeExe, cwd, 5);
            if (!listed.ok)
                throw new Error((_a = listed.error) !== null && _a !== void 0 ? _a : '列历史会话失败');
            const candidate = (_c = ((_b = listed.sessions) !== null && _b !== void 0 ? _b : []).find((session) => session.turns > 0)) !== null && _c !== void 0 ? _c : ((_d = listed.sessions) !== null && _d !== void 0 ? _d : [])[0];
            if (!candidate) {
                this.sessionId = (0, crypto_1.randomUUID)();
                this.sessionKind = 'sdk';
                this.append('note', '还没聊过，已开新会话。');
                return;
            }
            const opened = await this.loadHistory(candidate.id, { quiet: true });
            if (!opened.ok)
                throw new Error((_e = opened.error) !== null && _e !== void 0 ? _e : '读历史会话失败');
            const resumed = await this.resumeHistory(candidate.id);
            if (!resumed.ok)
                throw new Error((_f = resumed.error) !== null && _f !== void 0 ? _f : '继续会话失败');
        }
        catch (error) {
            this.sessionId = (0, crypto_1.randomUUID)();
            this.sessionKind = 'sdk';
            this.historyView = null;
            this.append('note', `没能接上上次的会话（${describe(error)}）—— 已开新会话 ${String(this.sessionId).slice(0, 8)}…。` +
                '历史仍在右上角「历史」里。');
        }
    }
    /**
     * 列历史会话（面板上的「历史」按钮）。
     *
     * @param limit - 最多几条。
     * @returns `{ok, sessions?, error?}`。
     */
    async historyList(limit = 20) {
        var _a, _b, _c;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const listed = await (0, history_1.listHistory)(this.runtime.nodeExe, cwd, limit);
        if (!listed.ok)
            return { ok: false, error: listed.error };
        const current = (_b = (_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId) !== null && _b !== void 0 ? _b : null;
        const sessions = ((_c = listed.sessions) !== null && _c !== void 0 ? _c : []).map((session) => ({
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
    async loadHistory(sessionId, options = {}) {
        var _a, _b, _c, _d, _e;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const read = await (0, history_1.readHistory)(this.runtime.nodeExe, cwd, sessionId);
        if (!read.ok)
            return { ok: false, error: read.error };
        const events = (_a = read.events) !== null && _a !== void 0 ? _a : [];
        this.resetTranscript();
        this.historyView = {
            sessionId,
            // 优先用日志自己记的标题（`session/title`，可能是模型生成的），
            // 没有才回退到「首条用户消息」（旧日志 / 事件被 maxEvents 截掉时）。
            title: (0, history_1.loggedTitleOf)(events) || (0, history_1.titleOfEvents)(events) || '(无标题)',
            createdAt: (_c = ((_b = read.header) !== null && _b !== void 0 ? _b : {}).createdAt) !== null && _c !== void 0 ? _c : null,
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
        let jumpEntry;
        for (const event of events) {
            const before = this.seq;
            this.handleSessionEvent(event, true, sessionId);
            if (options.jumpTo === undefined || Number((_d = event.seq) !== null && _d !== void 0 ? _d : -1) !== options.jumpTo)
                continue;
            // 新增了条目 → 就是它；没新增（工具结果补进已有卡片）→ 找刚刚被 touch 的那条
            jumpEntry = this.seq > before ? before + 1 : this.entrySeqOfRev(this.revision);
        }
        if (!options.quiet) {
            this.append('note', `以上是历史会话 ${sessionId.slice(0, 8)}… 的 ${events.length} 条记录（只读回放，共 ${(_e = read.total) !== null && _e !== void 0 ? _e : events.length} 条）。` +
                '想接着聊就点上面的「继续此会话」。');
        }
        if (options.jumpTo !== undefined) {
            // 转写只留最近 `MAX_ENTRIES` 条：命中太靠前时那一条已经被挤掉了。
            // 这时候**明说**，别让用户以为「搜到了却打不开」。
            if (jumpEntry !== undefined && !this.entries.some((entry) => entry.seq === jumpEntry)) {
                this.append('note', `搜索命中的那一条在很靠前的位置（第 ${options.jumpTo} 条事件），` +
                    `而转写只保留最近 ${MAX_ENTRIES} 条 —— 它已经不在窗口里了，可以导出这份日志来查。`);
                return { ok: true, events: events.length };
            }
        }
        return { ok: true, events: events.length, entrySeq: jumpEntry };
    }
    /** 找「刚被 touch 的那一条」（`rev` 是最后一次改动的版本号，全转写唯一）。 */
    entrySeqOfRev(rev) {
        for (const entry of this.entries)
            if (entry.rev === rev)
                return entry.seq;
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
    async resumeHistory(sessionId) {
        var _a, _b;
        const target = sessionId !== null && sessionId !== void 0 ? sessionId : (_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId;
        if (!target)
            return { ok: false, error: '没有可继续的会话（先从「历史」里打开一条）' };
        if (this.status !== 'ready' || !this.child) {
            return { ok: false, error: 'agent 没在跑 —— 先点「启动」再继续这条会话' };
        }
        const settings = (0, settings_1.getSettings)();
        try {
            const result = await this.callChild('session/resume', {
                sessionId: target,
                provider: settings.provider,
                model: settings.model,
                reasoningEffort: settings.reasoningEffort || undefined,
                maxTokens: settings.maxTokens > 0 ? settings.maxTokens : undefined,
            }, 180000);
            this.sessionId = target;
            this.sessionKind = 'resumed';
            if (this.historyView)
                this.historyView = { ...this.historyView, sessionId: target, live: true };
            else {
                this.historyView = { sessionId: target, title: '(未回放)', createdAt: null, messageCount: 0, live: true };
            }
            this.append('note', `已接上会话 ${target.slice(0, 8)}…（agent ${String((_b = result.agentId) !== null && _b !== void 0 ? _b : '?').slice(0, 8)}…）——` +
                '接下来的消息会带着它的上下文。');
            // 接上的这条会话有自己的用量记录（缓存按会话 id 存），立刻换成它的
            void this.refreshUsage();
            return { ok: true, sessionId: target };
        }
        catch (error) {
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
    async historySearch(query, options = {}) {
        var _a, _b;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const found = await (0, history_1.searchHistory)(this.runtime.nodeExe, cwd, query, options);
        if (!found.ok)
            return { ok: false, error: found.error };
        // 只做形状收敛（脚本那边已经是给人看的形状了），不做语义判断
        const hits = ((_a = found.hits) !== null && _a !== void 0 ? _a : []).map((raw) => {
            var _a;
            const snippets = Array.isArray(raw.snippets) ? raw.snippets : [];
            return {
                id: String((_a = raw.id) !== null && _a !== void 0 ? _a : ''),
                title: typeof raw.title === 'string' ? raw.title : '',
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
                updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
                bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
                turns: typeof raw.turns === 'number' ? raw.turns : 0,
                hits: typeof raw.hits === 'number' ? raw.hits : 0,
                seq: typeof raw.seq === 'number' ? raw.seq : 0,
                snippets: snippets.map((snippet) => {
                    var _a, _b;
                    return ({
                        role: String((_a = snippet.role) !== null && _a !== void 0 ? _a : ''),
                        label: typeof snippet.label === 'string' ? snippet.label : String((_b = snippet.role) !== null && _b !== void 0 ? _b : ''),
                        seq: typeof snippet.seq === 'number' ? snippet.seq : 0,
                        snippet: typeof snippet.snippet === 'string' ? snippet.snippet : '',
                    });
                }),
            };
        });
        return {
            ok: true,
            query: found.query,
            hits,
            scanned: found.scanned,
            available: found.available,
            partial: found.partial === true,
            stoppedBy: (_b = found.stoppedBy) !== null && _b !== void 0 ? _b : null,
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
    async historyExport(sessionId, format = 'md') {
        var _a, _b, _c, _d, _e;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const target = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!target)
            return { ok: false, error: 'history-export：缺少 sessionId' };
        const result = await (0, history_1.exportHistory)(this.runtime.nodeExe, cwd, target, format);
        if (!result.ok) {
            this.append('error', `导出会话失败：${(_a = result.error) !== null && _a !== void 0 ? _a : '未知原因'}`);
            return { ok: false, error: result.error };
        }
        const what = result.format === 'jsonl' ? '原样日志' : result.format === 'zip' ? 'ZIP（含子会话与附件）' : '转写';
        this.append('note', `已导出会话 ${String((_b = result.id) !== null && _b !== void 0 ? _b : target).slice(0, 8)}…（${what} · ` +
            `${(_c = result.events) !== null && _c !== void 0 ? _c : 0} 条 · ${(0, images_1.formatBytes)((_d = result.bytes) !== null && _d !== void 0 ? _d : 0)}）→ ${result.path}`);
        if (result.subagents) {
            /**
             * ⚠ **subagent 与 fork 分开说**：两者在日志头里的判据不同
             * （`origin === 'subagent'` vs「有 parentSession 但没有 origin」），
             * 而「含 5 个子会话」这句话里，用户真正关心的是「几个是我派出去的 agent」。
             */
            const parts = [`子孙 ${result.subagents.total} 个`];
            parts.push(`其中子 agent ${result.subagents.subagentCount} · fork ${result.subagents.forkCount}`);
            if (result.subagents.maxDepth !== null)
                parts.push(`最深第 ${result.subagents.maxDepth} 层`);
            if (result.subagents.dangling.length > 0)
                parts.push(`有 ${result.subagents.dangling.length} 个的父级在索引里找不到`);
            if (result.subagents.incomplete)
                parts.push('索引扫描超了预算，子孙可能不全');
            this.append('note', `ZIP 里的会话：${parts.join(' · ')}`);
        }
        if (result.media) {
            this.append('note', `ZIP 里的附件：${result.media.count} 个${result.media.missing > 0 ? `（另有 ${result.media.missing} 个引用读不到文件）` : ''}`);
        }
        // 脚本交代的话（活跃会话可能少最后几条 / 缺媒体 / 索引超预算）—— 原样搬进转写
        for (const line of (_e = result.notes) !== null && _e !== void 0 ? _e : [])
            this.append('note', `导出说明：${line}`);
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
    async historyDelete(sessionId, dryRun = false, reclaim = false) {
        var _a, _b, _c, _d, _e;
        if (!this.runtime.nodeExe)
            this.runtime = (0, paths_1.resolveRuntime)((0, settings_1.getSettings)());
        const cwd = (0, settings_1.getSettings)().workdir || Editor.Project.path;
        const target = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!target)
            return { ok: false, error: 'history-delete：缺少 sessionId' };
        if (target === this.sessionId) {
            return {
                ok: false,
                error: '这是 agent 当前正在用的会话 —— 先在面板上点「新会话」，再回来删它（不然 agent 下一次落盘会把它重新建出来）',
            };
        }
        const viewing = ((_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId) === target;
        const result = await (0, history_1.deleteHistory)(this.runtime.nodeExe, cwd, target, dryRun, { reclaimAttachments: reclaim });
        if (!result.ok)
            return { ok: false, error: result.error };
        if (dryRun)
            return { ...result, cleared: false };
        let cleared = false;
        if (viewing) {
            // 面板正显示这条（只读回放）：清掉，回到「空会话」状态
            this.historyView = null;
            this.sessionKind = 'sdk';
            this.resetTranscript();
            cleared = true;
        }
        this.append('note', `已删除历史会话 ${String((_b = result.id) !== null && _b !== void 0 ? _b : target).slice(0, 8)}…（${(_c = result.fileCount) !== null && _c !== void 0 ? _c : 0} 个文件 · ` +
            `${(0, images_1.formatBytes)((_d = result.bytes) !== null && _d !== void 0 ? _d : 0)}）。图片附件是全局去重的，**不随会话删除**。`);
        /**
         * 附件回收那一趟的结果：**三句话都要说**（候选几个 / 搬了几个 / 有没有被预算截断），
         * 因为这一块最容易让人误会成「一键腾空间」：
         * 本机实测 797 个对象**全都被引用**，所以正常情况下 `orphans` 就是 0 ——
         * 不说「候选里有几个还被别人引用着」，用户会以为功能坏了。
         */
        if (result.reclaim) {
            const r = result.reclaim;
            this.append('note', `附件回收：候选 ${r.candidates} 个（这条会话引用的）→ 其中 ${r.referenced} 个仍被别的会话引用、` +
                `${r.orphans} 个已无引用 → 搬进墓碑 ${r.trashed} 个（${(0, images_1.formatBytes)(r.bytesFreed)}）。` +
                `全库扫了 ${r.scanned.sessions} 条会话（${(0, images_1.formatBytes)(r.scanned.bytes)} / ${Math.round(r.scanned.elapsedMs / 1000)} 秒）。`);
            if (r.incomplete) {
                this.append('error', `附件回收**一个都没搬**：全库扫描没扫完（${(_e = r.incompleteReason) !== null && _e !== void 0 ? _e : '超预算'}）—— ` +
                    '这是有意的（判据不全时误删不可逆），会话本身已经删掉了。');
            }
            else if (r.trashed === 0) {
                this.append('note', '这次没有可回收的附件（候选里每一个都还被别的会话引用着）—— 附件是不可重建的，所以回收只搬"全库都引用不到"的那几个。');
            }
            // 被否决的候选（hash 不符 / 时间窗 / 读不到…）：前几条列出来，别让它静默
            const skipped = r.skipped.filter((entry) => entry.reason !== 'still-referenced');
            if (skipped.length > 0) {
                this.append('note', `回收时跳过 ${skipped.length} 个（不是"还在用"，是别的守卫拦下的）：` +
                    skipped.slice(0, 4).map((entry) => `${entry.id.slice(0, 14)}…（${entry.reason}）`).join('、'));
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
    async refreshUsage() {
        var _a, _b, _c, _d, _e;
        const target = (_b = (_a = this.historyView) === null || _a === void 0 ? void 0 : _a.sessionId) !== null && _b !== void 0 ? _b : this.sessionId;
        if (!target) {
            this.applyUsage(null, '还没有会话 —— agent 启动、发出第一条消息之后才有用量。');
            this.applyCheckpointProgress(null, null, '还没有会话 —— 进度要等 agent 起过、会话落过检查点才有。');
            return { ok: false, usage: null, note: this.usageNote, progress: null, progressNote: this.progressNote };
        }
        let result;
        try {
            result = await (0, stats_1.readSessionCache)(target, {
                liveSeq: this.lastEventSeq > 0 ? this.lastEventSeq : undefined,
            });
        }
        catch (error) {
            result = { ok: false, error: describe(error) };
        }
        if (result.ok !== true || !result.usage) {
            this.applyUsage(null, (_c = result.error) !== null && _c !== void 0 ? _c : '读用量失败');
            this.applyCheckpointProgress(null, null, (_d = result.error) !== null && _d !== void 0 ? _d : '读进度失败');
            return { ok: false, usage: null, note: this.usageNote, progress: null, progressNote: this.progressNote };
        }
        this.applyUsage(result.usage, null);
        /**
         * 进度那一半**单独失败不算整份失败**（`readSessionCache` 也是这么分的）：
         * 缓存里没有进度行时说「这块没有」，而不是把用量一起说成「读失败」。
         */
        this.applyCheckpointProgress((_e = result.progress) !== null && _e !== void 0 ? _e : null, result.usage, result.progress ? null : '这份缓存记录里没有进度那几行（清单 / 目标 / 回合大纲）。');
        return { ok: true, usage: this.usage, note: null, progress: this.progressView(), progressNote: this.progressNote };
    }
    /**
     * 换一份用量。
     *
     * 内容一样就一个字节都不动：这个函数会在「回合结束」「跑完命令」「面板点刷新」三处被调，
     * 而多数时候读到的是同一份数字 —— 白广播一次会让面板无谓地重画一遍抽屉。
     */
    applyUsage(next, note) {
        const same = this.usageNote === note && JSON.stringify(this.usage) === JSON.stringify(next);
        this.usage = next;
        this.usageNote = note;
        if (same)
            return;
        this.usageDirty = true;
        this.scheduleFlush();
    }
    /**
     * 排一次「晚一点读用量」。默认一个点，跑斜杠命令时两个点（见常量上的注释）。
     *
     * @param delays - 相对现在的毫秒数（会先清掉上一批，避免连点攒出一堆定时器）。
     */
    scheduleUsageRefresh(delays = [USAGE_REFRESH_DELAY_MS]) {
        this.clearUsageTimers();
        for (const delay of delays) {
            this.usageTimers.push(setTimeout(() => {
                void this.refreshUsage();
            }, Math.max(0, delay)));
        }
    }
    /** 清掉排着的读用量定时器（读之前会先清，`cleanup` 也要清）。 */
    clearUsageTimers() {
        for (const timer of this.usageTimers)
            clearTimeout(timer);
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
    applyCheckpointProgress(progress, usage, note) {
        var _a, _b, _c;
        this.checkpointTodos = progress ? progress.todos : null;
        this.checkpointGoal = progress ? progress.goal : null;
        this.outline = progress ? { turns: progress.turns, turnsTotal: progress.turnsTotal, draft: progress.draft } : null;
        this.progressSeq = (_a = usage === null || usage === void 0 ? void 0 : usage.seq) !== null && _a !== void 0 ? _a : null;
        this.progressBehind = (_b = usage === null || usage === void 0 ? void 0 : usage.behind) !== null && _b !== void 0 ? _b : null;
        this.progressUpdatedAt = (_c = usage === null || usage === void 0 ? void 0 : usage.updatedAt) !== null && _c !== void 0 ? _c : 0;
        this.progressNote = note;
        if (progress)
            this.progressSeen = true;
        this.touchProgress();
    }
    /** 收下一条 `todo/write`（整份快照，替换掉上一份）。 */
    applyLiveTodos(value) {
        const notes = [];
        // 认不出的条目：宁少不假，但要说出来（notes 会进 `progressView().notes`）
        this.todoNotes = notes;
        this.todos = (0, stats_1.parseTodos)(value, notes);
        // 记下「这一轮里写的」；`currentTurn` 为 0 = 还没见到 `turn/start`，那就按「不知道」记
        this.todosTurn = this.currentTurn;
        this.touchProgress();
    }
    /** 收下一条 `goal/change`（完整快照或墓碑）。 */
    applyLiveGoal(value) {
        const notes = [];
        this.goal = (0, stats_1.parseGoalChange)(value, notes);
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
    markTurnStart(turn) {
        this.currentTurn = turn;
        this.pendingAnchorTurn = turn;
        this.touchProgress();
    }
    /** `append` 的尾巴上调用：把「待绑的轮次」绑到刚上屏的那一条上。 */
    bindTurnAnchor(entrySeq) {
        if (this.pendingAnchorTurn === null)
            return;
        this.turnAnchors.set(this.pendingAnchorTurn, entrySeq);
        this.pendingAnchorTurn = null;
        this.touchProgress();
    }
    /** 把进度整块归零（换会话 / 回放另一条会话）。 */
    resetProgress() {
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
    touchProgress() {
        const json = JSON.stringify(this.progressView());
        if (json === this.progressJson)
            return;
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
    progressView() {
        var _a, _b, _c, _d, _e, _f;
        const hasLive = this.todos !== null || this.goal !== null || this.turnAnchors.size > 0;
        const hasCheckpoint = this.checkpointSeen();
        if (!hasLive && !hasCheckpoint)
            return null;
        const notes = [...this.checkpointNotes, ...this.todoNotes, ...this.goalNotes];
        // ---- 清单：事件优先 ----
        let todos = null;
        let todosSource = null;
        if (this.todos !== null) {
            todos = this.todos;
            todosSource = 'events';
            if (this.checkpointTodos !== null && JSON.stringify(this.checkpointTodos) !== JSON.stringify(this.todos)) {
                notes.push('检查点里的清单和事件流里的不一样 —— 面板用的是**事件流**那一份（缓存攒够 200 条事件或 5 秒才写一次，最多落后这么多）。');
            }
        }
        else if (this.checkpointTodos !== null) {
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
        const turns = ((_b = (_a = this.outline) === null || _a === void 0 ? void 0 : _a.turns) !== null && _b !== void 0 ? _b : []).map((turn) => ({
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
            turnsTotal: (_d = (_c = this.outline) === null || _c === void 0 ? void 0 : _c.turnsTotal) !== null && _d !== void 0 ? _d : turns.length,
            draft: (_f = (_e = this.outline) === null || _e === void 0 ? void 0 : _e.draft) !== null && _f !== void 0 ? _f : '',
            seq: this.progressSeq,
            behind: this.progressBehind,
            updatedAt: this.progressUpdatedAt,
            notes,
        };
    }
    /** 回合目录里那一轮的跳转落点（那一轮的条目已经被 600 条上限挤掉时给 null）。 */
    resolveAnchor(turn, present) {
        const anchor = this.turnAnchors.get(turn);
        if (anchor === undefined)
            return null;
        return present.has(anchor) ? anchor : null;
    }
    /** 有没有一份成功的检查点（用它而不是 `outline !== null`：一份真的没有回合的白记录也是成功的）。 */
    checkpointSeen() {
        return this.progressSeen;
    }
    /**
     * 发一条控制帧并等回执（面板→插件那一路）。
     *
     * 与工具帧（`kind: 'req'`）共用 IPC 通道，靠 `kind` 区分；回执在 `attachChild` 的
     * 消息路由里按 `id` 配对。
     */
    callChild(method, params, timeoutMs = 60000) {
        const child = this.child;
        if (!child)
            return Promise.reject(new Error('agent 子进程不在'));
        const id = ++this.ctlSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ctlPending.delete(id);
                reject(new Error(`控制帧 ${method} 在 ${timeoutMs}ms 内没有回执（插件版本过旧？` +
                    '本扩展要求 dsh-cocos-bridge 支持控制通道，先跑一次 scripts/install-profile.js）'));
            }, timeoutMs);
            this.ctlPending.set(id, { resolve, reject, timer });
            try {
                child.send({ __tag: constants_1.IPC_TAG, kind: 'ctl', id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.ctlPending.delete(id);
                reject(new Error(`发送控制帧失败：${describe(error)}`));
            }
        });
    }
    /** 停止 agent。先走协议 `shutdown`（服务端会自己退出），兜底再 kill。 */
    async stop() {
        if (!this.child) {
            this.setStatus('stopped');
            return { ok: true };
        }
        this.setStatus('stopping');
        const child = this.child;
        const client = this.client;
        try {
            await (client === null || client === void 0 ? void 0 : client.shutdown());
        }
        catch (error) {
            console.warn(`[dsh_chat] shutdown 请求没走完（继续 kill）：${describe(error)}`);
        }
        // 服务端通常会自己 exit；给它 1.5s，然后兜底。
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) {
                    try {
                        child.kill();
                    }
                    catch {
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
    async interrupt() {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        try {
            /**
             * ⚠ **不拿 `this.running` 当闸门**：它来自 `session.status` 通知，可能在
             * 「面板刚重开」「通知还没到」时是陈旧的 `false`；而**谁在跑**这件事，
             * 运行时里的 `agent.status` 才是真源。所以一律问插件，由它回 `cancelled`。
             */
            const result = await this.callChild('session/cancel', { sessionId: this.sessionId }, 15000);
            const cancelled = result.cancelled === true;
            const status = typeof result.status === 'string' ? result.status : undefined;
            this.append('note', cancelled ? '已请求中断这一轮（会话保留，可以接着说）' : '这一轮已经结束了');
            // 乐观收敛：中断请求已受理时，本地 running 立刻置位，别等下一次通知
            // （面板那个按钮的禁用态靠它，不然会有一小段「看起来没反应」）
            if (cancelled)
                this.running = false;
            return { ok: true, cancelled, status };
        }
        catch (error) {
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
    async commandList() {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        try {
            const result = await this.callChild('commands/list', { sessionId: this.sessionId }, 20000);
            return { ok: true, commands: normalizeCommands(result.commands) };
        }
        catch (error) {
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
    async runCommand(line) {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        const text = typeof line === 'string' ? line.trim() : '';
        if (!text.startsWith('/'))
            return { ok: false, error: '斜杠命令必须以 "/" 开头' };
        if (text.length > 2000)
            return { ok: false, error: '斜杠命令太长了（上限 2000 字符）' };
        try {
            const result = await this.callChild('commands/run', { sessionId: this.sessionId, line: text }, 120000);
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
        }
        catch (error) {
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
    async fileReference(query) {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        const text = typeof query === 'string' ? query.slice(0, 400) : '';
        try {
            const result = await this.callChild('fileref/list', { sessionId: this.sessionId, query: text }, 20000);
            return { ok: true, candidates: normalizeReferences(result.candidates) };
        }
        catch (error) {
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
    async panelActivity() {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        const sessionId = this.sessionId;
        const notes = [];
        const [jobsRaw, subsRaw] = await Promise.all([
            this.callChild('jobs/list', { sessionId }, 20000).catch((error) => {
                notes.push(`后台任务读不出来：${describe(error)}`);
                return null;
            }),
            this.callChild('subagents/list', { sessionId }, 20000).catch((error) => {
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
    async subagentInterrupt(subagentId) {
        if (this.status !== 'ready' || !this.child)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId)
            return { ok: false, error: '还没有会话' };
        const target = typeof subagentId === 'string' ? subagentId.trim() : '';
        if (!target)
            return { ok: false, error: 'subagent-interrupt：缺少 subagentId' };
        try {
            await this.callChild('subagents/interrupt', { parentSessionId: this.sessionId, subagentId: target }, 20000);
            this.append('note', `已请求中断子 agent ${target.slice(0, 8)}… 的当前一轮（会话与上下文都留着）`);
            return { ok: true, subagentId: target };
        }
        catch (error) {
            return { ok: false, error: describe(error) };
        }
    }
    /** 开一个新会话（新的 sessionId；旧会话在 DSH 侧仍按日志留在磁盘上）。 */
    newSession() {
        // 否则它会一直挂在运行时里（下次 resume 同一个 id 会撞上）。
        if (this.sessionKind === 'resumed' && this.sessionId) {
            const previous = this.sessionId;
            void this.callChild('session/dispose', { sessionId: previous }).catch((error) => {
                console.warn(`[dsh_chat] 释放会话 ${previous.slice(0, 8)}… 失败：${describe(error)}`);
            });
        }
        this.sessionId = (0, crypto_1.randomUUID)();
        this.sessionKind = 'sdk';
        this.historyView = null;
        this.resetTranscript();
        this.append('note', `已开新会话 ${this.sessionId.slice(0, 8)}…（上一段对话仍在右上角「历史」里，随时可以接着聊）`);
        return { ok: true, sessionId: this.sessionId };
    }
    /**
     * 清空对话区（换会话/回放历史前调用）。
     *
     * **代数 +1** 是给面板的信号：面板只按 `rev` 拉增量，没法表达「某条被删掉了」，
     * 所以「清空」这件事必须有一个独立的、单调递增的记号（`generation`）。
     */
    resetTranscript() {
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
    async send(text, images = []) {
        const content = typeof text === 'string' ? text.trim() : '';
        const attachments = images.filter((image) => image && typeof image.data === 'string' && image.data);
        if (!content && attachments.length === 0)
            return { ok: false, error: '消息是空的' };
        if (this.status !== 'ready' || !this.client)
            return { ok: false, error: 'agent 还没就绪' };
        if (!this.sessionId) {
            this.sessionId = (0, crypto_1.randomUUID)();
            this.sessionKind = 'sdk';
        }
        // 内容块：文本在前、图片在后（附件库按顺序把 image 块换成附件引用，顺序即消息顺序）
        const blocks = [];
        if (content)
            blocks.push({ type: 'text', text: content });
        for (const image of attachments)
            blocks.push(imageBlockOf(image));
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
            }
            catch (error) {
                const message = describe(error);
                this.append('error', `发送失败（已接上的历史会话走控制帧）：${message}`);
                return { ok: false, error: message };
            }
        }
        try {
            const result = (await this.client.prompt(this.sessionId, blocks));
            return { ok: true, messageId: result === null || result === void 0 ? void 0 : result.messageId };
        }
        catch (error) {
            const message = describe(error);
            this.append('error', `发送失败：${message}`);
            return { ok: false, error: message };
        }
    }
    /** 扩展卸载时调用：断开一切、杀掉子进程。 */
    async dispose() {
        var _a;
        this.listeners.clear();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.child) {
            try {
                (_a = this.client) === null || _a === void 0 ? void 0 : _a.dispose();
            }
            catch {
                /* 忽略 */
            }
            this.killChild();
        }
        this.cleanup();
        this.status = 'stopped';
    }
    // ---------------------------------------------------------------- 子进程接线
    attachChild(child) {
        var _a, _b, _c;
        this.client = new sdk_client_1.SdkClient(child, (method, params) => this.handleNotification(method, params));
        this.client.attach();
        (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding('utf8');
        (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.setEncoding('utf8');
        (_c = child.stderr) === null || _c === void 0 ? void 0 : _c.on('data', (chunk) => this.handleStderr(chunk));
        // 原生工具调用：DSH 插件 → 本进程；控制帧回执、交互请求也走这条通道
        child.on('message', (frame) => {
            const typed = frame;
            if (typed && typed.__tag === constants_1.IPC_TAG && typed.kind === 'ctl-res') {
                this.handleControlReply(typed);
                return;
            }
            if (typed && typed.__tag === constants_1.IPC_TAG && typed.kind === 'ask') {
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
            this.fail(`agent 进程退出了（code=${code !== null && code !== void 0 ? code : 'null'}${signal ? `, signal=${signal}` : ''}）`);
        });
    }
    /** 收尾：摘监听、清引用（不 kill）。 */
    cleanup() {
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
    killChild() {
        const child = this.child;
        if (!child)
            return;
        try {
            if (child.exitCode === null)
                child.kill();
        }
        catch {
            /* 已经没了 */
        }
    }
    handleStderr(chunk) {
        this.stderrBuffer += chunk;
        for (;;) {
            const newline = this.stderrBuffer.indexOf('\n');
            if (newline < 0)
                break;
            const line = this.stderrBuffer.slice(0, newline).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (!line)
                continue;
            this.stderrTail.push(line);
            while (this.stderrTail.length > MAX_STDERR_LINES)
                this.stderrTail.shift();
            if ((0, settings_1.getSettings)().showStderrNotes)
                this.append('note', `stderr: ${line}`);
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
    handleControlReply(frame) {
        var _a;
        const id = Number(frame.id);
        const entry = this.ctlPending.get(id);
        if (!entry)
            return;
        this.ctlPending.delete(id);
        clearTimeout(entry.timer);
        if (frame.ok === false) {
            entry.reject(new Error(String((_a = frame.error) !== null && _a !== void 0 ? _a : '插件返回失败')));
            return;
        }
        entry.resolve((frame.result && typeof frame.result === 'object' ? frame.result : {}));
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
    handleAskFrame(frame) {
        const id = typeof frame.id === 'string' ? frame.id.trim() : '';
        if (!id)
            return;
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
            if (!view)
                return;
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
    gateInteraction(view) {
        const quiet = this.lastPanelActivity === 0 || Date.now() - this.lastPanelActivity > PANEL_QUIET_MS;
        if (!quiet)
            return;
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
    async answerInteraction(payload) {
        var _a;
        const raw = (payload !== null && payload !== void 0 ? payload : {});
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const view = this.interactions.get(id);
        if (!view)
            return { ok: false, error: '这次交互已经结束了（回答过 / 被取消 / agent 重启过）' };
        const action = raw.action === 'dismiss' ? 'dismiss' : raw.action === 'delegate' ? 'delegate' : 'answer';
        const params = { id, action };
        if (action === 'answer') {
            if (view.kind === 'approval') {
                const outcome = String((_a = raw.outcome) !== null && _a !== void 0 ? _a : '');
                if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
                    return { ok: false, error: `授权结果只能是 allowed-once / rejected / cancelled，收到 "${outcome}"` };
                }
                params.outcome = outcome;
            }
            else {
                const answers = normalizeAnswerItems(raw.answers);
                if (answers.length === 0)
                    return { ok: false, error: '回答是空的：选一个选项，或者写一句自定义回答。' };
                params.answers = answers;
            }
        }
        try {
            await this.callChild('interaction/answer', params, 30000);
        }
        catch (error) {
            const message = describe(error);
            this.append('error', `回答没有送出去：${message}`);
            return { ok: false, error: message };
        }
        return { ok: true };
    }
    async handleIpcFrame(frame) {
        var _a, _b, _c, _d;
        if (!frame || typeof frame !== 'object')
            return;
        const request = frame;
        if (request.__tag !== constants_1.IPC_TAG || request.kind !== 'req' || request.id === undefined)
            return;
        const method = String((_a = request.method) !== null && _a !== void 0 ? _a : '');
        const params = request.params && typeof request.params === 'object' ? request.params : {};
        const handler = cocos_tools_1.COCOS_IPC_METHODS[method];
        let reply;
        if (!handler) {
            reply = {
                ok: false,
                text: `dsh_chat：未知的编辑器方法 "${method}"（扩展版本与 profile 版本可能不匹配，请重新打开面板或重载扩展）。`,
            };
        }
        else {
            try {
                reply = await handler(params);
            }
            catch (error) {
                reply = { ok: false, text: `编辑器侧处理 "${method}" 时抛错：${describe(error)}` };
            }
        }
        try {
            // 失败时**必须**把原因放进 `error`：DSH 侧插件只读帧上的 `error`（读不到就回落成
            // 一句没有信息量的「编辑器返回失败」）。这里少了它，`result.text` 里那句真原因
            // 就永远到不了模型眼前 —— 实测为此盲试了十几轮。
            (_b = this.child) === null || _b === void 0 ? void 0 : _b.send({
                __tag: constants_1.IPC_TAG,
                kind: 'res',
                id: request.id,
                ok: reply.ok,
                ...(reply.ok ? {} : { error: (_d = (_c = reply.error) !== null && _c !== void 0 ? _c : reply.text) !== null && _d !== void 0 ? _d : '编辑器侧执行失败（没有给出原因）' }),
                result: reply,
            });
        }
        catch (error) {
            console.warn(`[dsh_chat] 回执 IPC 失败：${describe(error)}`);
        }
    }
    // ---------------------------------------------------------------- 通知处理
    handleNotification(method, params) {
        var _a, _b, _c, _d;
        switch (method) {
            case 'session.event': {
                const event = params.event;
                if (event && typeof event === 'object') {
                    this.handleSessionEvent(event, false, String((_a = params.sessionId) !== null && _a !== void 0 ? _a : ''));
                }
                break;
            }
            case 'session.status': {
                this.running = params.status === 'running';
                if (!this.running)
                    this.finishStreams();
                this.scheduleFlush();
                break;
            }
            case 'subagent.started': {
                this.append('note', `子 agent 启动：${String((_b = params.agentId) !== null && _b !== void 0 ? _b : '')}`);
                break;
            }
            case 'subagent.finished': {
                this.append('note', `子 agent 结束：${String((_c = params.agentId) !== null && _c !== void 0 ? _c : '')}（${String((_d = params.status) !== null && _d !== void 0 ? _d : '')}）`);
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
    handleSessionEvent(event, replay = false, sessionId = '') {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
        // 接上历史会话之后，运行时里可能同时有「老的 SDK 会话」和「接上来的会话」两个 id，
        // 不按 id 过滤的话两段对话会串在一起。子 agent 的会话同样被挡掉（它另有
        // subagent.started/finished 两条 note）。
        if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId)
            return;
        // 实时水位（缓存记录「落后多少条」的参照）。只记**实时**的：回放历史时那些 seq
        // 属于另一条会话，混进来会让 `behind` 算成一个荒唐的数。
        const envelopeSeq = Number((_a = event.seq) !== null && _a !== void 0 ? _a : 0);
        if (!replay && Number.isFinite(envelopeSeq) && envelopeSeq > this.lastEventSeq) {
            this.lastEventSeq = envelopeSeq;
        }
        const data = (event.data && typeof event.data === 'object' ? event.data : {});
        switch (String((_b = event.type) !== null && _b !== void 0 ? _b : '')) {
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
                if (!replay && sessionId && this.sessionId && sessionId !== this.sessionId)
                    break;
                const title = typeof data.title === 'string' ? data.title.trim() : '';
                if (!title || title === this.sessionTitle)
                    break;
                this.sessionTitle = title;
                this.titleDirty = true;
                this.scheduleFlush();
                break;
            }
            case 'command/run': {
                // 记下名字，等 `command/done` 配（回放时才有用，见字段注释）
                const commandId = String((_c = data.commandId) !== null && _c !== void 0 ? _c : '');
                if (commandId)
                    this.commandNames.set(commandId, String((_d = data.name) !== null && _d !== void 0 ? _d : ''));
                break;
            }
            case 'command/done': {
                const commandId = String((_e = data.commandId) !== null && _e !== void 0 ? _e : '');
                const name = (_f = this.commandNames.get(commandId)) !== null && _f !== void 0 ? _f : '';
                this.commandNames.delete(commandId);
                /**
                 * 只在**回放**时画：实时那条结果由面板自己画（`runCommand` 的控制回执带
                 * `known`/`kind` 结构，比这条日志事件更准）。两处都画就会看到两遍。
                 * 与 `user/message` 是同一个纪律。
                 */
                if (!replay)
                    break;
                const text = typeof data.text === 'string' ? data.text.trim() : '';
                const failed = data.kind === 'error';
                this.append('note', `命令 /${name || '(未知)'} ${failed ? '失败' : '完成'}${text ? `：${text}` : ''}`);
                break;
            }
            case 'user/message': {
                // 自己发的那条已经在 send() 里回显过了；这里只把「注入的上下文」记成一行 note，
                // 否则转写里会混进一大堆 AGENTS.md / skill 正文。
                const source = data.source;
                if ((source === null || source === void 0 ? void 0 : source.kind) === 'plugin' && source.form === 'notice' && source.summary) {
                    this.append('note', `注入上下文：${source.summary}`);
                }
                else if (replay && (!source || source.kind === 'user')) {
                    // 回放时用户消息必须画出来（实时那条由 send() 负责；历史里没有 send()）
                    const blocks = (_g = data.content) !== null && _g !== void 0 ? _g : (_h = data.message) === null || _h === void 0 ? void 0 : _h.content;
                    const text = textOfBlocks(blocks);
                    const images = imagesOfBlocks(blocks);
                    // 纯图片消息（没有文字）在日志里是一堆 image 块 —— 也要上屏，只画碎片
                    if (text || images.length > 0)
                        this.append('user', text, undefined, images);
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = data.chunk;
                if (!chunk)
                    break;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    this.pushStream('agent', chunk.text);
                else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string')
                    this.pushStream('thinking', chunk.text);
                break;
            }
            case 'assistant/message': {
                const message = data.message;
                const text = textOfBlocks(message === null || message === void 0 ? void 0 : message.content);
                const interrupted = data.interrupted === true;
                if (replay) {
                    // 回放：思考块也在 content 里（实时是 chunk 流），按块顺序还原
                    for (const block of Array.isArray(message === null || message === void 0 ? void 0 : message.content) ? message === null || message === void 0 ? void 0 : message.content : []) {
                        const typed = block;
                        if ((typed === null || typed === void 0 ? void 0 : typed.type) === 'reasoning' && typeof typed.text === 'string' && typed.text.trim()) {
                            this.append('thinking', typed.text);
                        }
                    }
                    if (text)
                        this.append('agent', text);
                }
                else if (this.textStream) {
                    // 用「拼装好的完整消息」盖掉流式累积（同一 seq → 面板原地替换，不会出现两遍）
                    if (text)
                        this.textStream.text = text;
                    this.touch(this.textStream);
                    this.textStream = null;
                }
                else if (text) {
                    this.append('agent', text);
                }
                this.finishReasoningStream();
                if (interrupted)
                    this.append('note', '本轮被中断（以上是已产出的内容）');
                break;
            }
            case 'tool/call': {
                this.finishStreams();
                const callId = String((_j = data.callId) !== null && _j !== void 0 ? _j : '');
                const entry = this.append('tool', undefined, {
                    name: String((_k = data.name) !== null && _k !== void 0 ? _k : 'unknown'),
                    callId,
                    args: typeof data.arguments === 'string' ? data.arguments : undefined,
                    done: false,
                });
                if (callId)
                    this.toolByCallId.set(callId, entry);
                break;
            }
            case 'tool/result': {
                const message = data.message;
                const callId = String((_q = (_m = (_l = message === null || message === void 0 ? void 0 : message.source) === null || _l === void 0 ? void 0 : _l.callId) !== null && _m !== void 0 ? _m : (_p = (_o = message === null || message === void 0 ? void 0 : message.content) === null || _o === void 0 ? void 0 : _o[0]) === null || _p === void 0 ? void 0 : _p.toolCallId) !== null && _q !== void 0 ? _q : '');
                const entry = callId ? this.toolByCallId.get(callId) : undefined;
                // ⚠ 文本与 isError 的取法见 `toolResultOf`（新老日志形状不同，只认一种会静默丢结果）
                const result = toolResultOf(message);
                const output = result.text;
                const isError = result.isError || data.error !== undefined;
                const shown = output.length > TOOL_OUTPUT_DISPLAY_LIMIT
                    ? `${output.slice(0, TOOL_OUTPUT_DISPLAY_LIMIT)}\n…（已截断，完整结果已交给模型）`
                    : output;
                if (entry) {
                    // `endedAt` 只给面板算耗时用（`entry.at` 是发起时刻）
                    entry.tool = { ...entry.tool, done: true, ok: !isError, output: shown, endedAt: Date.now() };
                    this.touch(entry);
                    if (callId)
                        this.toolByCallId.delete(callId);
                }
                else {
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
                const raw = data.reason;
                const kind = typeof raw === 'string' ? raw : String((_r = raw === null || raw === void 0 ? void 0 : raw.kind) !== null && _r !== void 0 ? _r : '');
                if (kind && kind !== 'completed') {
                    const detail = typeof raw === 'object' && ((_s = raw === null || raw === void 0 ? void 0 : raw.error) === null || _s === void 0 ? void 0 : _s.message) ? `：${raw.error.message}` : '';
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
                this.markTurnStart(Number((_t = data.turn) !== null && _t !== void 0 ? _t : 0));
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
    append(kind, text, tool, images) {
        const entry = { seq: ++this.seq, rev: ++this.revision, kind, at: Date.now(), text, tool };
        if (images && images.length > 0)
            entry.images = images;
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
    touch(entry) {
        entry.rev = ++this.revision;
        this.dirty.add(entry);
        this.scheduleFlush();
    }
    /** 流式追加：第一条 delta 建条目，后续原地增长（同一 seq，面板原地替换）。 */
    pushStream(kind, delta) {
        var _a;
        let entry = kind === 'agent' ? this.textStream : this.reasoningStream;
        if (!entry) {
            // append() 自己会标脏 + 排刷
            entry = this.append(kind, delta);
            if (kind === 'agent')
                this.textStream = entry;
            else
                this.reasoningStream = entry;
            return;
        }
        entry.text = `${(_a = entry.text) !== null && _a !== void 0 ? _a : ''}${delta}`;
        this.touch(entry);
    }
    /** 结束流式（收尾成静态条目）。 */
    finishStreams() {
        this.textStream = null;
        this.finishReasoningStream();
    }
    finishReasoningStream() {
        if (!this.reasoningStream)
            return;
        if (!this.reasoningStream.text) {
            // 空的思考条目没有意义，从转写里摘掉
            const index = this.entries.indexOf(this.reasoningStream);
            if (index >= 0)
                this.entries.splice(index, 1);
            this.dirty.delete(this.reasoningStream);
        }
        this.reasoningStream = null;
    }
    // ---------------------------------------------------------------- 广播
    setStatus(status) {
        this.status = status;
        this.scheduleFlush();
    }
    fail(message) {
        this.lastError = message;
        this.status = 'error';
        this.append('error', message);
        return { ok: false, error: message };
    }
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }
    flush() {
        // ⚠ 标题变化**不会**动 `dirty`（它不是转写条目），所以要单独当一个「有东西要发」的理由。
        // 少了这一条，`session/title` 事件会静默地只改内存、面板要等下一次转写变化才看到。
        // 用量同理（`usageDirty`）：它是回合结束才刷的，等下一次转写变化可能永远等不到。
        // 进度（`progressDirty`）也一样，而且它比用量更急（清单是回合**中间**写的）。
        if (this.dirty.size === 0 && !this.titleDirty && !this.usageDirty && !this.progressDirty)
            return;
        this.titleDirty = false;
        const usageChanged = this.usageDirty;
        this.usageDirty = false;
        const progressChanged = this.progressDirty;
        this.progressDirty = false;
        const batch = [...this.dirty].slice(0, FLUSH_BATCH_LIMIT);
        for (const entry of batch)
            this.dirty.delete(entry);
        if (this.dirty.size > 0)
            this.scheduleFlush();
        const update = {
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
            }
            catch (error) {
                console.warn(`[dsh_chat] 更新回调抛错：${describe(error)}`);
            }
        }
        try {
            Editor.Message.broadcast(constants_1.BROADCAST_CHANNEL, update);
        }
        catch {
            // 广播是保险丝而非主路：面板还有轮询兜底，这里失败不算错。
        }
    }
}
exports.DshHost = DshHost;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHNoLWhvc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvZHNoLWhvc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW9CRzs7O0FBRUgsaURBQXdEO0FBQ3hELG1DQUFvQztBQUNwQywrQkFBNEI7QUFFNUIsK0NBQWtEO0FBQ2xELDJDQW9DcUI7QUFDckIsdUNBV21CO0FBQ25CLHFDQUF3RDtBQUN4RCxtQ0FBK0Q7QUFDL0QsNkNBQXlDO0FBQ3pDLHlDQUF5QztBQUN6QyxtQ0FBdUg7QUFFdkg7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxTQUFTLGVBQWU7SUFDcEIsT0FBTyxJQUFBLFdBQUksRUFBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNDLENBQUM7QUFFRCx1Q0FBdUM7QUFDdkMsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDO0FBRXhCLHVCQUF1QjtBQUN2QixNQUFNLGdCQUFnQixHQUFHLEVBQUUsQ0FBQztBQUU1QixzQ0FBc0M7QUFDdEMsTUFBTSx5QkFBeUIsR0FBRyxJQUFJLENBQUM7QUFFdkMsZ0NBQWdDO0FBQ2hDLE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDO0FBRTlCOzs7Ozs7R0FNRztBQUNILE1BQU0sY0FBYyxHQUFHLEtBQU0sQ0FBQztBQUU5QixvREFBb0Q7QUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsT0FBTyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSyxFQUFFLE1BQU0sRUFBRSxLQUFNLEVBQUUsQ0FBQztBQUV0RixvQ0FBb0M7QUFDcEMsTUFBTSxpQkFBaUIsR0FBRyxFQUFFLENBQUM7QUFFN0I7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLHNCQUFzQixHQUFHLEdBQUcsQ0FBQztBQUVuQzs7Ozs7O0dBTUc7QUFDSCxNQUFNLDhCQUE4QixHQUFHLENBQUMsR0FBRyxFQUFFLElBQUss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RUFBRTtZQUNyRSxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBc0I7WUFDNUUsTUFBTSxFQUFFLE9BQU8sSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUMxRSxTQUFTLEVBQUUsT0FBTyxJQUFJLENBQUMsU0FBUyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUN4RyxVQUFVLEVBQUUsT0FBTyxJQUFJLENBQUMsVUFBVSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUM1RyxjQUFjLEVBQUUsT0FBTyxJQUFJLENBQUMsY0FBYyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUNsRixLQUFLLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSTtTQUMzRixDQUFDLENBQUM7UUFDSCxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksU0FBUztZQUFFLE1BQU07SUFDeEMsQ0FBQztJQUVELE1BQU0sU0FBUyxHQUFtQixFQUFFLENBQUM7SUFDckMsS0FBSyxNQUFNLEtBQUssSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFD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QztRQUNELElBQUksQ0FBQztZQUNELE1BQU0sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLDZCQUFpQixFQUFFLE1BQTJCLENBQUMsQ0FBQztRQUM3RSxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsK0JBQStCO1FBQ25DLENBQUM7SUFDTCxDQUFDO0NBQ0o7QUF6aEVELDBCQXloRUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFnZW50IOWuv+S4u++8muaJmOeuoeOAjOiiqyBmb3JrIOWHuuadpeeahCBEU0gg5a2Q6L+b56iL44CN77yM5bm25oqK5a6D55qE5LiJ5p2h5rWB5o6l6LW35p2l44CCXG4gKlxuICogYGBgXG4gKiAgICAgICAgICAgICAgICAgICAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIERTSCDlrZDov5vnqIvvvIjns7vnu58gbm9kZe+8jC0tcHJvZmlsZSBjb2Nvc++8ieKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkFxuICogICDpnaLmnb/vvIjmuLLmn5Pov5vnqIvvvIkgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIJcbiAqICAgICAg4payICDilrIgICAgICAgICAgIOKUgiAgc3Rkb3V0IOKUgOKUgCBTREsgSlNPTi1SUEPvvIhpbml0aWFsaXplIC8gc2Vzc2lvbi5wcm9tcHQgLyBzZXNzaW9uLmV2ZW5077yJ4pSCXG4gKiAgICAgIOKUgiAg4pSCIGJyb2FkY2FzdCDilIIgIHN0ZGVyciDilIDilIAg5o+S5Lu25pel5b+X77yI6K+K5pat5bC+5be077yM5LiN6L+b5LiK5LiL5paH77yJICAgICAgICAgICAgICAgICAgICAgICAgICDilIJcbiAqICAgICAg4pSCICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilKQgIGlwYyAgICDilIDilIAg5Y6f55Sf5bel5YW36LCD55So77yIY29jb3NfZXhlY3V0ZV9jb2RlIOKGkiDmnKzov5vnqIsg4oaSIOacrOaJqeWxleaymeeusS/lnLrmma/ohJrmnKzvvIkgIOKUglxuICogICAgICDilIIgICAgICAgICAgICAgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmFxuICogICAgICDilJTilIDilIAgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdC9nZXQtZXZlbnRz77yI6L2u6K+i5YWc5bqV77yJXG4gKlxuICogIyMg5LiJ5p2h5Y+j5b6EXG4gKlxuICogMS4gKipzdGRvdXQg5piv5Y2P6K6u77yMc3RkZXJyIOaYr+aXpeW/l++8jGlwYyDmmK/lt6XlhbcqKuOAguS4ieiAhee7neS4jea3t+eUqO+8mlxuICogICAgc3Rkb3V0IOS4iuacieadgui0qOihjOWPquS8muiuoeaVsOi3s+i/h++8iOingSBgU2RrQ2xpZW50YO+8ie+8jOS4jeS8muaJk+aWreWvueivneOAglxuICogMi4gKirpnaLmnb/kuKTmnaHot6/pg73og73mi7/liLDmm7TmlrAqKu+8muW5v+aSre+8iOW/q++8jOS9hiBgX19wcm90ZWN0ZWRfX2Ag5piv5L+d5oqk5o6l5Y+j77yJKyDova7or6JcbiAqICAgIGBnZXQtZXZlbnRzYO+8iOaFouS4gOeCue+8jOS9huS4gOWumuWIsO+8ieOAguS4pOadoei3r+WQiOW5tui/m+WQjOS4gOS7vSBgTWFwPHNlcSwgRW50cnk+YO+8jOmdoCBgc2VxYC9gcmV2YCDluYLnrYnjgIJcbiAqIDMuICoq5a2Q6L+b56iL5LiA5a6a6KaB5pS25bmy5YeAKirvvJpgdW5sb2FkKClg44CB57yW6L6R5Zmo6YCA5Ye644CBYWdlbnQg6Ieq5bexIGBleGl0YO+8jOS4ieadoei3r+mDveimgeiQveWIsFxuICogICAg5ZCM5LiA5LiqIGBjbGVhbnVwKClg77yb5ZCm5YiZ5Lya55WZ5LiL5a2k5YS/IG5vZGUg6L+b56iL5Y2g552AIENQVeOAglxuICovXG5cbmltcG9ydCB7IGZvcmssIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHsgQ09DT1NfSVBDX01FVEhPRFMgfSBmcm9tICcuL2NvY29zLXRvb2xzJztcbmltcG9ydCB7XG4gICAgQlJPQURDQVNUX0NIQU5ORUwsXG4gICAgSVBDX1RBRyxcbiAgICBQUk9GSUxFX05BTUUsXG4gICAgdHlwZSBBY3Rpdml0eVZpZXcsXG4gICAgdHlwZSBBZ2VudFNuYXBzaG90LFxuICAgIHR5cGUgQWdlbnRTdGF0dXMsXG4gICAgdHlwZSBDb21tYW5kVmlldyxcbiAgICB0eXBlIEVudHJ5LFxuICAgIHR5cGUgRW50cnlJbWFnZSxcbiAgICB0eXBlIEVudHJ5S2luZCxcbiAgICB0eXBlIEV2ZW50c1BheWxvYWQsXG4gICAgdHlwZSBIaXN0b3J5RGVsZXRlVmlldyxcbiAgICB0eXBlIEhpc3RvcnlFeHBvcnRWaWV3LFxuICAgIHR5cGUgSGlzdG9yeVNlYXJjaEhpdFZpZXcsXG4gICAgdHlwZSBIaXN0b3J5U2VhcmNoVmlldyxcbiAgICB0eXBlIEhpc3RvcnlTbmlwcGV0VmlldyxcbiAgICB0eXBlIEhpc3RvcnlTZXNzaW9uVmlldyxcbiAgICB0eXBlIEhpc3RvcnlWaWV3LFxuICAgIHR5cGUgSG9zdFVwZGF0ZVZpZXcsXG4gICAgdHlwZSBKb2JWaWV3LFxuICAgIHR5cGUgU2Vzc2lvblVzYWdlLFxuICAgIHR5cGUgSW50ZXJhY3Rpb25BbnN3ZXJJdGVtLFxuICAgIHR5cGUgSW50ZXJhY3Rpb25BcHByb3ZhbE91dGNvbWUsXG4gICAgdHlwZSBJbnRlcmFjdGlvbkRlY2lzaW9uLFxuICAgIHR5cGUgSW50ZXJhY3Rpb25RdWVzdGlvbixcbiAgICB0eXBlIEludGVyYWN0aW9uUXVlc3Rpb25PcHRpb24sXG4gICAgdHlwZSBJbnRlcmFjdGlvblZpZXcsXG4gICAgdHlwZSBSZWZlcmVuY2VDYW5kaWRhdGUsXG4gICAgdHlwZSBTZXNzaW9uS2luZCxcbiAgICB0eXBlIFN1YmFnZW50VmlldyxcbiAgICB0eXBlIEdvYWxWaWV3LFxuICAgIHR5cGUgUHJvZ3Jlc3NWaWV3LFxuICAgIHR5cGUgVG9kb1ZpZXcsXG4gICAgdHlwZSBUdXJuVmlldyxcbiAgICB0eXBlIFRvb2xFbnRyeSxcbn0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHtcbiAgICBkZWxldGVIaXN0b3J5LFxuICAgIGV4cG9ydEhpc3RvcnksXG4gICAgbGlzdEhpc3RvcnksXG4gICAgbG9nZ2VkVGl0bGVPZixcbiAgICByZWFkSGlzdG9yeSxcbiAgICBzZWFyY2hIaXN0b3J5LFxuICAgIHRpdGxlT2ZFdmVudHMsXG4gICAgdHlwZSBIaXN0b3J5RXhwb3J0Rm9ybWF0LFxuICAgIHR5cGUgSGlzdG9yeVNlYXJjaE9wdGlvbnMsXG4gICAgdHlwZSBIaXN0b3J5U2Vzc2lvbixcbn0gZnJvbSAnLi9oaXN0b3J5JztcbmltcG9ydCB7IGZvcm1hdEJ5dGVzLCB0eXBlIFZhbGlkSW1hZ2UgfSBmcm9tICcuL2ltYWdlcyc7XG5pbXBvcnQgeyByZXNvbHZlUnVudGltZSwgdHlwZSBSZXNvbHZlZFJ1bnRpbWUgfSBmcm9tICcuL3BhdGhzJztcbmltcG9ydCB7IFNka0NsaWVudCB9IGZyb20gJy4vc2RrLWNsaWVudCc7XG5pbXBvcnQgeyBnZXRTZXR0aW5ncyB9IGZyb20gJy4vc2V0dGluZ3MnO1xuaW1wb3J0IHsgcGFyc2VHb2FsQ2hhbmdlLCBwYXJzZVRvZG9zLCByZWFkU2Vzc2lvbkNhY2hlLCB0eXBlIFNlc3Npb25DYWNoZVJlc3VsdCwgdHlwZSBTZXNzaW9uUHJvZ3Jlc3MgfSBmcm9tICcuL3N0YXRzJztcblxuLyoqXG4gKiDpmo/mianlsZXlj5HluIPnmoTpgJrnlKggc2tpbGwg55uu5b2V77yIYDzmianlsZXmoLk+L3NraWxsc2DvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjopoHmmL7lvI/ms6jlhaXvvJpEU0gg55qEIGBAZGVlcHNlZWstYWkvZHNoLXNraWxsLWZpbGVzeXN0ZW1gIOS8muivu+eOr+Wig+WPmOmHj1xuICogYERTSF9CVU5ETEVEX1NLSUxMX0RJUmAg5bm25oqK5a6D5b2T5oiQICoqYnVuZGxlZCDmoLkqKuaJq+aPj++8iGByYW5rID0gNjAwYO+8jOWFqOihqOacgOS9juS8mOWFiOe6p++8ieOAglxuICog5LqO5piv44CM5byV5pOOL+e8lui+keWZqOaTjeS9nOeahOmAmueUqOefpeivhuOAjSoq6Lef552A5o+S5Lu26LWwKiog4oCU4oCUIOaNouS4quW3peeoi+ijheS4iuWwseacie+8jFxuICog6ICM5bel56iL6Ieq5bex55qEIGAuYWdlbnRzL3NraWxscy9g77yIcmFuayAyMDDvvInjgIHnlKjmiLfnuqcgYH4vLmFnZW50cy9za2lsbHMvYO+8iHJhbmsgNTAw77yJ5LuN54S25LyY5YWI44CCXG4gKlxuICog4pqgICoq5ZCM5ZCN5piv44CM5pW05L2T6KaG55uW44CN6ICM5LiN5piv44CM5ZCI5bm244CNKirvvIhgZHNoLXNraWxsYCDnmoQgYGNvbGxlY3RMYXllcmAg5oyJIHJhbmsg5Y2H5bqPICsg5oyJ5ZCN5a2X5Y676YeN77yJ77yMXG4gKiDmiYDku6XmtojotLnlt6XnqIvph4wqKuS4jeimgSoq5YaN5pS+5LiA5Liq5ZCM5ZCN55qEIGBjb2Nvcy1lZGl0b3Itb3BzYCDigJTigJQg6YKj5Lya5oqK5o+S5Lu26L+Z5Lu95pW05Liq5ZCD5o6J44CCXG4gKiDlrozmlbTlj6PlvoTop4EgYHNraWxscy9SRUFETUUubWRg44CCXG4gKi9cbmZ1bmN0aW9uIGJ1bmRsZWRTa2lsbERpcigpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKF9fZGlybmFtZSwgJy4uJywgJ3NraWxscycpO1xufVxuXG4vKiog6L2s5YaZ5L+d55WZ5LiK6ZmQ77yI6LaF5Ye65Lii5pyA6ICB55qE77yJ44CC6Z2i5p2/5Y+q55yL5pyA6L+R6L+Z5Lqb77yM5aSf55So5LiU5LiN5rao5YaF5a2Y44CCICovXG5jb25zdCBNQVhfRU5UUklFUyA9IDYwMDtcblxuLyoqIHN0ZGVyciDor4rmlq3lsL7lt7Tkv53nlZnooYzmlbDjgIIgKi9cbmNvbnN0IE1BWF9TVERFUlJfTElORVMgPSA0MDtcblxuLyoqIOW3peWFt+e7k+aenOWcqCoq6Z2i5p2/5LiKKirnmoTmiKrmlq3plb/luqbvvIjmqKHlnovmi7/liLDnmoTku43mmK/lrozmlbTnu5PmnpzvvInjgIIgKi9cbmNvbnN0IFRPT0xfT1VUUFVUX0RJU1BMQVlfTElNSVQgPSA0MDAwO1xuXG4vKiog5bm/5pKt6IqC5rWB77ya5rWB5byP5aKe6YeP5Y+v6IO95b6I5a+G77yM5pSS5Yiw5LiA5Liq6Ze06ZqU5YaN5o6o5LiA5qyh44CCICovXG5jb25zdCBGTFVTSF9JTlRFUlZBTF9NUyA9IDEyMDtcblxuLyoqXG4gKiDjgIzpnaLmnb/ov5jlnKjlkJfjgI3nmoTliKTlrprnqpflj6PvvIjmr6vnp5LvvInjgIJcbiAqXG4gKiDpnaLmnb/nqbrpl7Lml7YgODAwbXMg5LiA6Lez77yI6LeR5Yqo5pe2IDMwMG1z77yJ77yM5omA5LulIDYwcyDmmK/kuKrmnoHlrr3nmoTliKTmja4g4oCU4oCUIOWug+WPqueUqOadpeWMuuWIhlxuICog44CM6Z2i5p2/5byA552A77yM5Y+q5piv5Lq66L+Y5rKh54K544CN5ZKM44CM5qC55pys5rKh5Lq65Zyo55yL44CN44CC5ZCO6ICF5b+F6aG756uL5Yi75pS+6KGM77yI562J5LqO5rKh5Lq66IO95Zue562U77yJ77yMXG4gKiDlkKbliJnmqKHlnovkvJrkuIDnm7TljaHlnKjpgqPkuIDpl67kuIrvvIznm7TliLDlt6XlhbfosIPnlKjotoXml7bjgIJcbiAqL1xuY29uc3QgUEFORUxfUVVJRVRfTVMgPSA2MF8wMDA7XG5cbi8qKiDkuqTkupLovb3ojbfnmoTplb/luqbkuIrpmZDvvIjpnaLmnb/mmK/muLLmn5Pov5vnqIvvvIzmj5Lku7bkuZ/lj6/og73lh7rplJkg4oCU4oCUIOWIq+iuqeS4gOadoeiEj+aVsOaNruaKiiBVSSDmkpHmrbvvvInjgIIgKi9cbmNvbnN0IElOVEVSQUNUSU9OX0xJTUlUUyA9IHsgcXVlc3Rpb25zOiA4LCBvcHRpb25zOiAxMiwgdGV4dDogNF8wMDAsIGRldGFpbDogNDBfMDAwIH07XG5cbi8qKiDkuIDmrKHlub/mkq3mkLrluKbnmoTmnaHnm67kuIrpmZDvvIjotoXlh7rnmoTpnaDova7or6LooaXpvZDvvIzpgb/lhY3ljZXluKfov4flpKfvvInjgIIgKi9cbmNvbnN0IEZMVVNIX0JBVENIX0xJTUlUID0gNjA7XG5cbi8qKlxuICog5Zue5ZCI57uT5p2f5ZCO6ZqU5aSa5LmF5Y676K+75LiA5qyh55So6YeP77yI5q+r56eS77yJ44CCXG4gKlxuICog4pqgICoq5LiN6IO956uL5Yi76K+7KirvvJrnvJPlrZjmgbDlpb3lnKggYHR1cm4vZW5kYCDlhpnkuIDmrKHmo4Dmn6XngrnvvIzkvYbpgqPmmK8gKiphZ2VudCDov5vnqIvph4wqKueahOebkeWQrOWZqOW5sueahOa0u++8jFxuICog5LiO5oiR5Lus5pS25Yiw55qEIGBzZXNzaW9uL2V2ZW50YCDpgJrnn6XmmK/kuKTmnaHot6/vvIzosIHlhYjliLDmsqHmnInkv53or4HjgILnq4vliLvor7vmnInlj6/og73or7vliLDjgIzkuIrkuIDmnaHkuovku7bkuLrmraLjgI1cbiAqIOeahOi0piDigJTigJQg55So6YeP5pWw5a2X6YCa5bi45LiN5Y+X5b2x5ZON77yM5L2GIGBzZXNzaW9uU3RhdHMudHVybnNgIOS8muWwkeS4gOS4quWbnuWQiO+8jOeci+edgOWwseWDj+OAjOWbnuWQiOaVsOS4jeWvueOAjeOAglxuICog6L+Z5LiA54K55a6e5rWL5LiN5Ye65p2l77yI5pys5py65Lik56eN6aG65bqP6YO95Y+v6IO977yJ77yM5omA5Lul55So5LiA5Liq44CM562J5LiA5ouN44CN55qE5Zu65a6a5bu26L+f5YWc5L2P77yMXG4gKiDlubblnKjpnaLmnb/kuIrlpoLlrp7mmL7npLrmsLTkvY3kuI7okL3lkI7mnaHmlbDvvJvnnJ/opoHnq4vliLvnnIvvvIzmir3lsYnph4zmnInjgIzliLfmlrDjgI3jgIJcbiAqL1xuY29uc3QgVVNBR0VfUkVGUkVTSF9ERUxBWV9NUyA9IDcwMDtcblxuLyoqXG4gKiDot5HlrozkuIDmnaHmlpzmnaDlkb3ku6TkuYvlkI7ooaXor7vnlKjph4/nmoTkuKTkuKrml7bliLvvvIjmr6vnp5LvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjmmK/kuKTkuKrvvJpgL2NvbXBhY3RgIOi/meexu+WRveS7pCoq56uL5Yi7KirmlLnkuobkuIrkuIvmlofvvIzkvYbmo4Dmn6XngrnmmK8qKuaUkuedgOWGmSoq55qEXG4gKiDvvIjmnKwgcHJvZmlsZSDphY3nmoTmmK/mr48gMjAwIOadoeS6i+S7tuaIluavjyA1IOenku+8ie+8jOaJgOS7peesrOS4gOS4queCueivu+WIsOeahOaYr+aXp+aVsOOAgeesrOS6jOS4queCueaJjeaYr+aWsOaVsOOAglxuICog5LiN6KGl6L+Z5LiA5omL55qE6K+d77yM55So5oi35Y6L57yp5a6M5Lya55uv552A5LiA5Liq5rKh5Y+Y55qE5Y2g55So546H5Y+R5ZGG44CCXG4gKi9cbmNvbnN0IFVTQUdFX1JFRlJFU0hfQUZURVJfQ09NTUFORF9NUyA9IFs5MDAsIDZfMDAwXTtcblxuLyoqIOmdouadvy/lhbblroPnm5HlkKzogIXmlLbliLDnmoTmjqjpgIHvvIjnsbvlnovlrprkuYnlnKggY29uc3RhbnRz77yM6Z2i5p2/5YWx55So5ZCM5LiA5Lu977yJ44CCICovXG5leHBvcnQgdHlwZSB7IEhvc3RVcGRhdGVWaWV3IGFzIEhvc3RVcGRhdGUgfSBmcm9tICcuL2NvbnN0YW50cyc7XG4vKiog5LuOIENvbnRlbnRCbG9ja1tdIOmHjOWPlue6r+aWh+acrOOAgiAqL1xuZnVuY3Rpb24gdGV4dE9mQmxvY2tzKGJsb2NrczogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGJsb2NrcykpIHJldHVybiAnJztcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuICAgICAgICBpZiAoYmxvY2sgJiYgdHlwZW9mIGJsb2NrID09PSAnb2JqZWN0JyAmJiAoYmxvY2sgYXMgeyB0eXBlPzogc3RyaW5nIH0pLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgY29uc3QgdGV4dCA9IChibG9jayBhcyB7IHRleHQ/OiBzdHJpbmcgfSkudGV4dDtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgJiYgdGV4dCkgcGFydHMucHVzaCh0ZXh0KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGFydHMuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICog5LuOIENvbnRlbnRCbG9ja1tdIOmHjOWPluWbvueJh+eahCoq5YWD5pWw5o2uKirvvIjlm57mlL7ljoblj7Lml7bnlKjvvInjgIJcbiAqXG4gKiDkuKTnp43lvaLnirbpg73opoHorqTvvIznkIbnlLHlkowgYHRvb2xSZXN1bHRPZmAg5LiA5qC377yIRFNIIOWNh+i/h+eJiO+8ie+8mlxuICpcbiAqIHwg5p2l5rqQIHwg5Zu+54mH5Z2XIHxcbiAqIHwtLS18LS0tfFxuICogfCDmiJHku6zlj5Hlh7rljrvnmoTvvIjpnaLmnb8gZWNob++8iSB8IGB7dHlwZTonaW1hZ2UnLCBkYXRhLCBtaW1lVHlwZX1gIOKAlOKAlCDov5jmsqHov5vpmYTku7blupMgfFxuICogfCDkvJror53ml6Xlv5fph4zorrDkuIvmnaXnmoQgfCBge3R5cGU6J2ltYWdlJywgYXR0YWNobWVudDp7bWVkaWFUeXBlLCBieXRlcywgd2lkdGgsIGhlaWdodCwgbmFtZT99fWAgfFxuICpcbiAqIOaXpeW/l+mHjOmCo+adoSoq5rKh5pyJ5YOP57SgKirvvIjlrZfoioLlj6blrZjlnKjpmYTku7blupPvvInvvIzmiYDku6XpnaLmnb/kuIrljoblj7Lmtojmga/lj6rog73nlLvjgIzlm77lkI0gKyDlsLrlr7jjgI3vvIxcbiAqIOi/meS5n+ato+aYryBgRW50cnlJbWFnZWAg5Y+q5pyJ5YWD5pWw5o2u55qE5Y6f5Zug44CCXG4gKlxuICogQHBhcmFtIGJsb2NrcyAtIGB1c2VyL21lc3NhZ2VgIOeahCBgZGF0YS5jb250ZW50YOOAglxuICogQHJldHVybnMg5Zu+54mH5YWD5pWw5o2u5YiX6KGo77yI6aG65bqP5Y2z5raI5oGv6YeM55qE6aG65bqP77yJ44CCXG4gKi9cbmZ1bmN0aW9uIGltYWdlc09mQmxvY2tzKGJsb2NrczogdW5rbm93bik6IEVudHJ5SW1hZ2VbXSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGJsb2NrcykpIHJldHVybiBbXTtcbiAgICBjb25zdCBvdXQ6IEVudHJ5SW1hZ2VbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG4gICAgICAgIGlmICghYmxvY2sgfHwgdHlwZW9mIGJsb2NrICE9PSAnb2JqZWN0JykgY29udGludWU7XG4gICAgICAgIGNvbnN0IHR5cGVkID0gYmxvY2sgYXMge1xuICAgICAgICAgICAgdHlwZT86IHN0cmluZztcbiAgICAgICAgICAgIG1pbWVUeXBlPzogc3RyaW5nO1xuICAgICAgICAgICAgYXR0YWNobWVudD86IHsgbWVkaWFUeXBlPzogc3RyaW5nOyBieXRlcz86IG51bWJlcjsgd2lkdGg/OiBudW1iZXI7IGhlaWdodD86IG51bWJlcjsgbmFtZT86IHN0cmluZyB9O1xuICAgICAgICB9O1xuICAgICAgICBpZiAodHlwZWQudHlwZSAhPT0gJ2ltYWdlJykgY29udGludWU7XG4gICAgICAgIGNvbnN0IHJlZiA9IHR5cGVkLmF0dGFjaG1lbnQ7XG4gICAgICAgIG91dC5wdXNoKHtcbiAgICAgICAgICAgIG5hbWU6IHJlZj8ubmFtZSxcbiAgICAgICAgICAgIG1pbWVUeXBlOiByZWY/Lm1lZGlhVHlwZSA/PyB0eXBlZC5taW1lVHlwZSxcbiAgICAgICAgICAgIGJ5dGVzOiB0eXBlb2YgcmVmPy5ieXRlcyA9PT0gJ251bWJlcicgPyByZWYuYnl0ZXMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB3aWR0aDogdHlwZW9mIHJlZj8ud2lkdGggPT09ICdudW1iZXInID8gcmVmLndpZHRoIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgaGVpZ2h0OiB0eXBlb2YgcmVmPy5oZWlnaHQgPT09ICdudW1iZXInID8gcmVmLmhlaWdodCA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDkuIDlvKDlvoXlj5HpgIHnmoTlm74g4oaSIFNESyDnmoTlhoXlrrnlnZfvvIhgZGF0YWAg5b+F6aG75piv6KeE6IyDIGJhc2U2NO+8jOingSBgc291cmNlL2ltYWdlcy50c2DvvInjgIIgKi9cbmZ1bmN0aW9uIGltYWdlQmxvY2tPZihpbWFnZTogVmFsaWRJbWFnZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBibG9jazogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6ICdpbWFnZScsIGRhdGE6IGltYWdlLmRhdGEsIG1pbWVUeXBlOiBpbWFnZS5taW1lVHlwZSB9O1xuICAgIGlmIChpbWFnZS5uYW1lKSBibG9jay5uYW1lID0gaW1hZ2UubmFtZTtcbiAgICByZXR1cm4gYmxvY2s7XG59XG5cbi8qKiDmiorlvILluLgv5pyq55+l5pS25pWb5oiQ5LiA5Y+l6K+d44CCICovXG5mdW5jdGlvbiBkZXNjcmliZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiDku44gYHRvb2wvcmVzdWx0YCDnmoQgbWVzc2FnZSDph4zlj5bjgIzmlofmnKwgKyDmmK/kuI3mmK/plJnor6/jgI3igJTigJQgKirkuKTnp43lvaLnirbpg73opoHorqQqKuOAglxuICpcbiAqIOi/meS4jeaYr+a0geeZlu+8jOaYr+Wunua1i+aSnuWHuuadpeeahO+8muWQjOS4gOWkqeeahOS4pOS4quS8muivneaXpeW/l+W9oueKtuS4jeS4gOagt++8iERTSCDljYfov4fniYjvvInjgIJcbiAqXG4gKiB8IOadpea6kCB8IGBtZXNzYWdlLmNvbnRlbnRgIHxcbiAqIHwtLS18LS0tfFxuICogfCDlrp7ml7bkuovku7YgLyDogIHml6Xlv5fvvIhgdmVyc2lvbjogMGDvvIkgfCBgWyB7IHR5cGU6ICd0b29sLXJlc3VsdCcsIHRvb2xDYWxsSWQsIGNvbnRlbnQ6IFvlnZfigKZdLCBpc0Vycm9yIH0gXWAg4oCU4oCUIOWGheWuueWcqCoq6YeM5bGCKiogfFxuICogfCDmlrDml6Xlv5fvvIhgdmVyc2lvbjogNGDvvIkgfCBgWyB7IHR5cGU6ICd0ZXh0JywgdGV4dCB9IF1gIOKAlOKAlCDlhoXlrrkqKuWwseaYryoq6L+Z5LiA5bGCIHxcbiAqXG4gKiDlj6rorqTliY3kuIDnp43nmoTor53vvIzlm57mlL7mlrDml6Xlv5fml7YqKuavj+W8oOW3peWFt+WNoeeJh+eahOe7k+aenOmDveaYr+epuueahCoq77yIYGRvbmU6IHRydWVgIOWNtOS4gOS4quWtl+ayoeacie+8jFxuICog55yL6LW35p2l5YOP5bel5YW35rKh6L6T5Ye677yJ77yM6ICM5LiU5LiN5oql6ZSZ44CCYGlzRXJyb3JgIOWQjOeQhu+8muaWsOW9oueKtuaMguWcqOWkluWxgiBgbWVzc2FnZS5pc0Vycm9yYOOAglxuICpcbiAqIEBwYXJhbSBtZXNzYWdlIC0gYGRhdGEubWVzc2FnZWDjgIJcbiAqIEByZXR1cm5zIOaWh+acrOS4jumUmeivr+agh+iusOOAglxuICovXG5mdW5jdGlvbiB0b29sUmVzdWx0T2YobWVzc2FnZTogdW5rbm93bik6IHsgdGV4dDogc3RyaW5nOyBpc0Vycm9yOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IHR5cGVkID0gKG1lc3NhZ2UgPz8ge30pIGFzIHsgY29udGVudD86IHVua25vd247IGlzRXJyb3I/OiB1bmtub3duIH07XG4gICAgY29uc3QgY29udGVudCA9IHR5cGVkLmNvbnRlbnQ7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGNvbnRlbnQpKSByZXR1cm4geyB0ZXh0OiAnJywgaXNFcnJvcjogdHlwZWQuaXNFcnJvciA9PT0gdHJ1ZSB9O1xuXG4gICAgY29uc3Qgd3JhcHBlciA9IGNvbnRlbnRbMF0gYXMgeyB0eXBlPzogc3RyaW5nOyBjb250ZW50PzogdW5rbm93bjsgaXNFcnJvcj86IHVua25vd24gfSB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBibG9ja3MgPSB3cmFwcGVyPy50eXBlID09PSAndG9vbC1yZXN1bHQnICYmIEFycmF5LmlzQXJyYXkod3JhcHBlci5jb250ZW50KSA/IHdyYXBwZXIuY29udGVudCA6IGNvbnRlbnQ7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdGV4dDogdGV4dE9mQmxvY2tzKGJsb2NrcyksXG4gICAgICAgIGlzRXJyb3I6IHdyYXBwZXI/LmlzRXJyb3IgPT09IHRydWUgfHwgdHlwZWQuaXNFcnJvciA9PT0gdHJ1ZSxcbiAgICB9O1xufVxuXG4vKipcbiAqIOaKiuaPkuS7tumAgeadpeeahOS6pOS6kui9veiNt+aUtuaVm+aIkOmdouadv+iDveWuieWFqOa4suafk+eahOW9oueKtuOAglxuICpcbiAqIOS4uuS7gOS5iOS4jeS/oeaPkuS7tu+8muWug+aYr+aIkeS7rOiHquW3seWGmeeahO+8jOS9hioq6L296I2355qE5rqQ5aS05piv6L+Q6KGM5pe2KirvvIjmqKHlnovnu5nnmoQgYGRldGFpbGAg5Y+v6IO9XG4gKiDlsLHmmK/lh6DkuIflrZfnmoTorqHliJLjgIHpgInpobnlj6/og73lh6DljYHkuKrvvInvvIzogIzpnaLmnb/mmK8gRE9NIOa4suafkyDigJTigJQg5LiA5p2h6LaF6ZW/5paH5pys6IO95oqK56qE6Z2i5p2/5pKR54iG44CCXG4gKiDov5nph4zlj6rlgZrjgIzmiKrmlq0gKyDkuKLpnZ7ms5XpobnjgI3vvIzkuI3lgZror63kuYnliKTmlq3vvIjor63kuYnlnKjmj5Lku7bkuI7ov5DooYzml7bpgqPkuKTlsYLvvInjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0g5o+S5Lu257uZ55qEIGBpbnRlcmFjdGlvbmAg5a+56LGh44CCXG4gKiBAcGFyYW0gaWQgLSDluKfkuIrnmoTkuqTkupIgaWTvvIgqKuS7peW4p+S4uuWHhioq77yM5LiN5L+h5Lu76L296I236YeM55qE6YKj5Lu977yJ44CCXG4gKiBAcmV0dXJucyDmlLbmlZvlkI7nmoTop4blm77vvJvlvaLnirbmoLnmnKzkuI3lr7nml7bov5Tlm54gbnVsbOOAglxuICovXG5mdW5jdGlvbiBzYW5pdGl6ZUludGVyYWN0aW9uKHJhdzogdW5rbm93biwgaWQ6IHN0cmluZyk6IEludGVyYWN0aW9uVmlldyB8IG51bGwge1xuICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBzb3VyY2UgPSByYXcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3Qga2luZCA9IHNvdXJjZS5raW5kID09PSAnYXBwcm92YWwnID8gJ2FwcHJvdmFsJyA6IHNvdXJjZS5raW5kID09PSAncXVlc3Rpb24nID8gJ3F1ZXN0aW9uJyA6IG51bGw7XG4gICAgaWYgKCFraW5kKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IGN1dCA9ICh2YWx1ZTogdW5rbm93biwgbGltaXQ6IG51bWJlcik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICF2YWx1ZSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA+IGxpbWl0ID8gYCR7dmFsdWUuc2xpY2UoMCwgbGltaXQpfeKApu+8iOW3suaIquaWre+8iWAgOiB2YWx1ZTtcbiAgICB9O1xuXG4gICAgY29uc3QgdmlldzogSW50ZXJhY3Rpb25WaWV3ID0ge1xuICAgICAgICBpZCxcbiAgICAgICAga2luZCxcbiAgICAgICAgYXQ6IHR5cGVvZiBzb3VyY2UuYXQgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShzb3VyY2UuYXQpID8gc291cmNlLmF0IDogRGF0ZS5ub3coKSxcbiAgICB9O1xuICAgIGNvbnN0IGFnZW50SWQgPSBjdXQoc291cmNlLmFnZW50SWQsIDEyOCk7XG4gICAgaWYgKGFnZW50SWQpIHZpZXcuYWdlbnRJZCA9IGFnZW50SWQ7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gY3V0KHNvdXJjZS5zZXNzaW9uSWQsIDEyOCk7XG4gICAgaWYgKHNlc3Npb25JZCkgdmlldy5zZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XG5cbiAgICBpZiAoa2luZCA9PT0gJ2FwcHJvdmFsJykge1xuICAgICAgICB2aWV3LnRvb2xOYW1lID0gY3V0KHNvdXJjZS50b29sTmFtZSwgMjAwKSA/PyAnKOacquefpeW3peWFtyknO1xuICAgICAgICBjb25zdCBjYWxsSWQgPSBjdXQoc291cmNlLmNhbGxJZCwgMTI4KTtcbiAgICAgICAgaWYgKGNhbGxJZCkgdmlldy5jYWxsSWQgPSBjYWxsSWQ7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9IGN1dChzb3VyY2UucmVhc29uLCBJTlRFUkFDVElPTl9MSU1JVFMudGV4dCk7XG4gICAgICAgIGlmIChyZWFzb24pIHZpZXcucmVhc29uID0gcmVhc29uO1xuICAgICAgICByZXR1cm4gdmlldztcbiAgICB9XG5cbiAgICBjb25zdCBxdWVzdGlvbnMgPSBBcnJheS5pc0FycmF5KHNvdXJjZS5xdWVzdGlvbnMpID8gc291cmNlLnF1ZXN0aW9ucy5zbGljZSgwLCBJTlRFUkFDVElPTl9MSU1JVFMucXVlc3Rpb25zKSA6IFtdO1xuICAgIGNvbnN0IGl0ZW1zOiBJbnRlcmFjdGlvblF1ZXN0aW9uW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHF1ZXN0aW9ucykge1xuICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBxdWVzdGlvbiA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBxdWVzdGlvbklkID0gY3V0KHF1ZXN0aW9uLmlkLCAxMjgpO1xuICAgICAgICBjb25zdCB0ZXh0ID0gY3V0KHF1ZXN0aW9uLnF1ZXN0aW9uLCBJTlRFUkFDVElPTl9MSU1JVFMudGV4dCk7XG4gICAgICAgIGlmICghcXVlc3Rpb25JZCB8fCAhdGV4dCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGl0ZW06IEludGVyYWN0aW9uUXVlc3Rpb24gPSB7IGlkOiBxdWVzdGlvbklkLCBxdWVzdGlvbjogdGV4dCB9O1xuICAgICAgICBjb25zdCBkZXRhaWwgPSBjdXQocXVlc3Rpb24uZGV0YWlsLCBJTlRFUkFDVElPTl9MSU1JVFMuZGV0YWlsKTtcbiAgICAgICAgaWYgKGRldGFpbCkgaXRlbS5kZXRhaWwgPSBkZXRhaWw7XG4gICAgICAgIGNvbnN0IGhlYWRlciA9IGN1dChxdWVzdGlvbi5oZWFkZXIsIDIwMCk7XG4gICAgICAgIGlmIChoZWFkZXIpIGl0ZW0uaGVhZGVyID0gaGVhZGVyO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShxdWVzdGlvbi5vcHRpb25zKSkge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uczogSW50ZXJhY3Rpb25RdWVzdGlvbk9wdGlvbltdID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IG9wdGlvbiBvZiBxdWVzdGlvbi5vcHRpb25zLnNsaWNlKDAsIElOVEVSQUNUSU9OX0xJTUlUUy5vcHRpb25zKSkge1xuICAgICAgICAgICAgICAgIGlmICghb3B0aW9uIHx8IHR5cGVvZiBvcHRpb24gIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGN1dCgob3B0aW9uIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5sYWJlbCwgMjAwKTtcbiAgICAgICAgICAgICAgICBpZiAoIWxhYmVsKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBkZXNjcmlwdGlvbiA9IGN1dCgob3B0aW9uIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5kZXNjcmlwdGlvbiwgNTAwKTtcbiAgICAgICAgICAgICAgICBvcHRpb25zLnB1c2goeyBsYWJlbCwgLi4uKGRlc2NyaXB0aW9uID09PSB1bmRlZmluZWQgPyB7fSA6IHsgZGVzY3JpcHRpb24gfSkgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5sZW5ndGggPiAwKSBpdGVtLm9wdGlvbnMgPSBvcHRpb25zO1xuICAgICAgICB9XG4gICAgICAgIGlmIChxdWVzdGlvbi5tdWx0aVNlbGVjdCA9PT0gdHJ1ZSkgaXRlbS5tdWx0aVNlbGVjdCA9IHRydWU7XG4gICAgICAgIGNvbnN0IGludGVudCA9IHF1ZXN0aW9uLmludGVudCAmJiB0eXBlb2YgcXVlc3Rpb24uaW50ZW50ID09PSAnb2JqZWN0JyA/IChxdWVzdGlvbi5pbnRlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICAgICAgaWYgKGludGVudCkge1xuICAgICAgICAgICAgY29uc3QgaW50ZW50S2luZCA9IGN1dChpbnRlbnQua2luZCwgNjQpO1xuICAgICAgICAgICAgY29uc3QgYXBwcm92ZSA9IGN1dChpbnRlbnQuYXBwcm92ZSwgMjAwKTtcbiAgICAgICAgICAgIGlmIChpbnRlbnRLaW5kICYmIGFwcHJvdmUpIGl0ZW0uaW50ZW50ID0geyBraW5kOiBpbnRlbnRLaW5kLCBhcHByb3ZlIH07XG4gICAgICAgIH1cbiAgICAgICAgaXRlbXMucHVzaChpdGVtKTtcbiAgICB9XG4gICAgLy8g5LiA6YGT6aKY6YO95rKh5pyJ55qEIHF1ZXN0aW9uIOS6pOS6kuaYr+Wdj+eahO+8mueZu+iusOS6huS5n+ayoeazleWbnuetlFxuICAgIGlmIChpdGVtcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgIHZpZXcucXVlc3Rpb25zID0gaXRlbXM7XG4gICAgcmV0dXJuIHZpZXc7XG59XG5cbi8qKlxuICog6L2s5YaZ6YeM6YKj5p2h44CM6L+Z6YeM6Zeu6L+H5oiR44CN55qEIG5vdGXvvIgqKuWPquaPj+i/sO+8jOS4jeS7o+abv+Wvueivneahhioq77yJ44CCXG4gKlxuICogQHBhcmFtIHZpZXcgLSDlt7LmlLbmlZvnmoTkuqTkupLjgIJcbiAqIEByZXR1cm5zIOS4gOihjOaWh+Wtl+OAglxuICovXG5mdW5jdGlvbiBkZXNjcmliZUludGVyYWN0aW9uKHZpZXc6IEludGVyYWN0aW9uVmlldyk6IHN0cmluZyB7XG4gICAgaWYgKHZpZXcua2luZCA9PT0gJ2FwcHJvdmFsJykge1xuICAgICAgICByZXR1cm4gYOKaoCDpnIDopoHkvaDmibnlh4bvvJoke3ZpZXcudG9vbE5hbWUgPz8gJ+i/measoeaTjeS9nCd9JHt2aWV3LnJlYXNvbiA/IGBcXG4ke3ZpZXcucmVhc29ufWAgOiAnJ31gO1xuICAgIH1cbiAgICBjb25zdCBmaXJzdCA9IHZpZXcucXVlc3Rpb25zPy5bMF07XG4gICAgY29uc3QgaGVhZGVyID0gZmlyc3Q/LmhlYWRlciA/IGDjgJAke2ZpcnN0LmhlYWRlcn3jgJFgIDogJyc7XG4gICAgY29uc3QgY291bnQgPSB2aWV3LnF1ZXN0aW9ucyAmJiB2aWV3LnF1ZXN0aW9ucy5sZW5ndGggPiAxID8gYO+8iOWFsSAke3ZpZXcucXVlc3Rpb25zLmxlbmd0aH0g6Zeu77yJYCA6ICcnO1xuICAgIHJldHVybiBg4p2TIOaooeWei+WcqOetieS9oOWbnuetlO+8miR7aGVhZGVyfSR7Zmlyc3Q/LnF1ZXN0aW9uID8/ICcnfSR7Y291bnR9YDtcbn1cblxuLyoqXG4gKiDmoKHpqozpnaLmnb/pgIHlm57mnaXnmoTnrZTmoYjvvIjpnaLmnb/mmK/muLLmn5Pov5vnqIvvvIzlroPor7TnmoTkuI3lj6/kv6HvvInjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0gYFt7aWQsIHNlbGVjdGVkPywgY3VzdG9tP31dYOOAglxuICogQHJldHVybnMg5ZCI5rOV5p2h55uu77yb56m65p2h55uu6KKr5Lii5o6J77yI56m65pWw57uEID0g6L+Z5qyh5Zue562U5peg5pWI77yJ44CCXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFuc3dlckl0ZW1zKHJhdzogdW5rbm93bik6IEludGVyYWN0aW9uQW5zd2VySXRlbVtdIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IG91dDogSW50ZXJhY3Rpb25BbnN3ZXJJdGVtW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJhdykge1xuICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBpdGVtID0gZW50cnkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIGl0ZW0uaWQgPT09ICdzdHJpbmcnID8gaXRlbS5pZC50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFpZCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheShpdGVtLnNlbGVjdGVkKVxuICAgICAgICAgICAgPyBpdGVtLnNlbGVjdGVkLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBzdHJpbmcgPT4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSAhPT0gJycpLnNsaWNlKDAsIElOVEVSQUNUSU9OX0xJTUlUUy5vcHRpb25zKVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgY29uc3QgY3VzdG9tID0gdHlwZW9mIGl0ZW0uY3VzdG9tID09PSAnc3RyaW5nJyAmJiBpdGVtLmN1c3RvbS50cmltKCkgPyBpdGVtLmN1c3RvbS5zbGljZSgwLCBJTlRFUkFDVElPTl9MSU1JVFMudGV4dCkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChzZWxlY3RlZC5sZW5ndGggPT09IDAgJiYgY3VzdG9tID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaCh7IGlkLCBzZWxlY3RlZCwgLi4uKGN1c3RvbSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGN1c3RvbSB9KSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIG91dC5zbGljZSgwLCBJTlRFUkFDVElPTl9MSU1JVFMucXVlc3Rpb25zKTtcbn1cblxuLyoqIOaWnOadoOWRveS7pOWIl+ihqOeahOi3qOi/m+eoi+S4iumZkO+8iOmdouadv+aYr+S4queqhOaKveWxie+8jOWGjeWkmuS5n+eUu+S4jeS4i++8ieOAgiAqL1xuY29uc3QgQ09NTUFORF9MSU1JVCA9IDEyMDtcblxuLyoqIGBAYCDlgJnpgInnmoTot6jov5vnqIvkuIrpmZDvvIjkuI7mj5Dkvpvmlrnoh6rlt7HnmoQgYG1heFJlc3VsdHNgIOebuOS6kueLrOeri++8ieOAgiAqL1xuY29uc3QgUkVGRVJFTkNFX0xJTUlUID0gNDA7XG5cbi8qKlxuICog5pS25pWb5o+S5Lu26YCB5Zue55qE5pac5p2g5ZG95Luk5YiX6KGo44CCXG4gKlxuICog5Y+j5b6E5ZCM5YW25a6D6Leo6L+b56iL6L296I2377yaKirlj6rnlZnpnaLmnb/nlLvlvpfkuIvnmoTlrZfmrrUqKuOAgemAkOmhueaIquaWreOAgeaVtOihqOiuvuS4iumZkOOAglxuICog5ZCN5a2X5LiN5ZCI5rOV55qE5pW05p2h5Lii5o6J77yI5ZG95Luk5ZCN5pivIGAvYCDlkI7pnaLpgqPkuIDmrrXvvIzpnaLmnb/opoHpnaDlroPmi7zlkb3ku6TooYzvvInjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0g5o+S5Lu25Zue55qEIGBjb21tYW5kc2Ag5pWw57uE44CCXG4gKiBAcmV0dXJucyDlubLlh4DnmoTlkb3ku6Top4blm77mlbDnu4TjgIJcbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplQ29tbWFuZHMocmF3OiB1bmtub3duKTogQ29tbWFuZFZpZXdbXSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiBbXTtcbiAgICBjb25zdCBvdXQ6IENvbW1hbmRWaWV3W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJhdykge1xuICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBpdGVtID0gZW50cnkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgaXRlbS5uYW1lID09PSAnc3RyaW5nJyA/IGl0ZW0ubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgLy8g5ZG95Luk5ZCN55qE5ZCI5rOV5a2X56ym6ZuG55Sx5rOo5YaM6KGo5L+d6K+B77yI5bCP5YaZ5a2X5q+NL+aVsOWtly9fLy3vvInvvJvov5nph4zlj6rlgZrplb/luqbkuI7lvaLnirbnmoTlhZzlupXvvIxcbiAgICAgICAgLy8g5Yir6Ieq5bex5a6e546w5LiA5aWX6K+t5rOVIOKAlOKAlCDor63ms5XlnKggYGN0eC5jb21tYW5kc2Ag6YKj6L6577yM5oqE5LiA5Lu95b+F54S25ryC56e744CCXG4gICAgICAgIGlmICghbmFtZSB8fCBuYW1lLmxlbmd0aCA+IDQwIHx8IC9cXHMvLnRlc3QobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB2aWV3OiBDb21tYW5kVmlldyA9IHtcbiAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogdHlwZW9mIGl0ZW0uZGVzY3JpcHRpb24gPT09ICdzdHJpbmcnID8gaXRlbS5kZXNjcmlwdGlvbi5zbGljZSgwLCAyMDApIDogJycsXG4gICAgICAgIH07XG4gICAgICAgIGlmICh0eXBlb2YgaXRlbS5oaW50ID09PSAnc3RyaW5nJyAmJiBpdGVtLmhpbnQpIHZpZXcuaGludCA9IGl0ZW0uaGludC5zbGljZSgwLCA4MCk7XG4gICAgICAgIGlmIChpdGVtLmltYWdlcyA9PT0gdHJ1ZSkgdmlldy5pbWFnZXMgPSB0cnVlO1xuICAgICAgICBvdXQucHVzaCh2aWV3KTtcbiAgICAgICAgaWYgKG91dC5sZW5ndGggPj0gQ09NTUFORF9MSU1JVCkgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog5pS25pWb5o+S5Lu26YCB5Zue55qEIGBAYCDlgJnpgInjgIJcbiAqXG4gKiBAcGFyYW0gcmF3IC0g5o+S5Lu25Zue55qEIGBjYW5kaWRhdGVzYCDmlbDnu4TjgIJcbiAqIEByZXR1cm5zIOW5suWHgOeahOWAmemAieaVsOe7hOOAglxuICovXG5mdW5jdGlvbiBub3JtYWxpemVSZWZlcmVuY2VzKHJhdzogdW5rbm93bik6IFJlZmVyZW5jZUNhbmRpZGF0ZVtdIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IG91dDogUmVmZXJlbmNlQ2FuZGlkYXRlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJhdykge1xuICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBpdGVtID0gZW50cnkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgaXRlbS5wYXRoID09PSAnc3RyaW5nJyA/IGl0ZW0ucGF0aC50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFwYXRoIHx8IHBhdGgubGVuZ3RoID4gNDAwKSBjb250aW51ZTtcbiAgICAgICAgb3V0LnB1c2goeyBwYXRoLCBraW5kOiBpdGVtLmtpbmQgPT09ICdkaXJlY3RvcnknID8gJ2RpcmVjdG9yeScgOiAnZmlsZScgfSk7XG4gICAgICAgIGlmIChvdXQubGVuZ3RoID49IFJFRkVSRU5DRV9MSU1JVCkgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDlkI7lj7Dku7vliqHkuI7lrZAgYWdlbnQg55qE6Leo6L+b56iL5LiK6ZmQ77yI6Z2i5p2/5piv5Liq56qE5oq95bGJ77yM5YaN5aSa5Lmf55S75LiN5LiL77yJ44CCICovXG5jb25zdCBKT0JfTElNSVQgPSA0MDtcbmNvbnN0IFNVQkFHRU5UX0xJTUlUID0gNDA7XG5cbi8qKiBqb2Ig54q25oCB55qE5ZCI5rOV5YC8ICsg5LiA5LiqIGB1bmtub3duYO+8iCoq5LiN6K6k6K+G55qE57ud5LiN54ycKirvvIzop4EgYEpvYlZpZXcuc3RhdHVzYCDnmoTms6jph4rvvInjgIIgKi9cbmNvbnN0IEpPQl9TVEFUVVNFUyA9IG5ldyBTZXQoWydydW5uaW5nJywgJ3N0b3BwaW5nJywgJ2NvbXBsZXRlZCcsICdraWxsZWQnLCAnZmFpbGVkJ10pO1xuXG4vKipcbiAqIOaUtuaVm+aPkuS7tumAgeWbnueahOOAjOa0u+WKqOOAjeS4pOWdl++8iOWQjuWPsOS7u+WKoSArIOWtkCBhZ2VudO+8ieOAglxuICpcbiAqIOS4juaWnOadoOWRveS7pOOAgWBAYCDlgJnpgInlkIzkuIDmnaHnuqrlvovvvJoqKuWPqueVmemdouadv+eUu+W+l+S4i+eahOWtl+autSoq44CB6YCQ6aG55oiq5pat44CB5pW06KGo6K6+5LiK6ZmQ44CCXG4gKiDov5nph4zlj6blpJblgZrkuInku7bmj5Lku7bkuI3or6XnrqHnmoTkuovvvJpcbiAqIDEuICoq5pWw5YC85a2X5q615LiA5b6L6L+HIGBudW0oKWAqKu+8iOi3qOi/m+eoi+adpeeahOS4nOilv+W9k+i+k+WFpeS4jeWPr+S/oe+8mmBOYU5gIC8g5a2X56ym5LiyIC8g57y65aSx6YO95Y+v6IO977yJ77ybXG4gKiAyLiAqKuiupOS4jeWHuueahOeKtuaAgeiQveWIsCBgdW5rbm93bmAqKu+8iOeFp+WunuivtOWHuuadpe+8jOWIq+eMnOaIkCBydW5uaW5nIOKAlOKAlOOAjOeci+i1t+adpeWcqOi3keOAjeavlOOAjOS4jeefpemBk+OAjeabtOezn++8ie+8m1xuICogMy4g5oqK44CM5pyN5Yqh57y65aSx44CN5LiO44CM5YiX5LiN5Ye65p2l44CN55qE5Y6f5ZugKirlkITlvZLlkITkvY0qKuWcsOWGmei/myBgQWN0aXZpdHlWaWV3YOOAglxuICpcbiAqIEBwYXJhbSByYXcgLSDmj5Lku7YgYGpvYnMvbGlzdGAgKyBgc3ViYWdlbnRzL2xpc3RgIOeahOS4pOasoeWbnuaJp+OAglxuICogQHJldHVybnMg6Z2i5p2/6KaB55S755qE6YKj5LiA5Lu977yIKirmsLjov5zov5Tlm57lr7nosaEqKu+8jOWTquaAleS4pOadoemDveWksei0pe+8ieOAglxuICovXG5mdW5jdGlvbiBub3JtYWxpemVBY3Rpdml0eShcbiAgICBqb2JzUmF3OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwsXG4gICAgc3Vic1JhdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsLFxuICAgIG5vdGVzOiBzdHJpbmdbXSxcbiAgICBhdDogbnVtYmVyLFxuKTogQWN0aXZpdHlWaWV3IHtcbiAgICBjb25zdCBqb2JzOiBKb2JWaWV3W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIEFycmF5LmlzQXJyYXkoam9ic1Jhdz8uam9icykgPyAoam9ic1Jhdz8uam9icyBhcyB1bmtub3duW10pIDogW10pIHtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgaXRlbSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyA/IGl0ZW0uaWQudHJpbSgpIDogJyc7XG4gICAgICAgIGlmICghaWQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBzdGF0dXMgPSB0eXBlb2YgaXRlbS5zdGF0dXMgPT09ICdzdHJpbmcnID8gaXRlbS5zdGF0dXMgOiAnJztcbiAgICAgICAgam9icy5wdXNoKHtcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAga2luZDogdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgPyBpdGVtLmtpbmQuc2xpY2UoMCwgNDApIDogJycsXG4gICAgICAgICAgICBsYWJlbDogdHlwZW9mIGl0ZW0ubGFiZWwgPT09ICdzdHJpbmcnID8gaXRlbS5sYWJlbC5zbGljZSgwLCA0MDApIDogJycsXG4gICAgICAgICAgICBzdGF0dXM6IChKT0JfU1RBVFVTRVMuaGFzKHN0YXR1cykgPyBzdGF0dXMgOiAndW5rbm93bicpIGFzIEpvYlZpZXdbJ3N0YXR1cyddLFxuICAgICAgICAgICAgZGV0YWlsOiB0eXBlb2YgaXRlbS5kZXRhaWwgPT09ICdzdHJpbmcnID8gaXRlbS5kZXRhaWwuc2xpY2UoMCwgMjAwKSA6IG51bGwsXG4gICAgICAgICAgICBzdGFydGVkQXQ6IHR5cGVvZiBpdGVtLnN0YXJ0ZWRBdCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGl0ZW0uc3RhcnRlZEF0KSA/IGl0ZW0uc3RhcnRlZEF0IDogbnVsbCxcbiAgICAgICAgICAgIGZpbmlzaGVkQXQ6IHR5cGVvZiBpdGVtLmZpbmlzaGVkQXQgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpdGVtLmZpbmlzaGVkQXQpID8gaXRlbS5maW5pc2hlZEF0IDogbnVsbCxcbiAgICAgICAgICAgIG93bmVyU2Vzc2lvbklkOiB0eXBlb2YgaXRlbS5vd25lclNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBpdGVtLm93bmVyU2Vzc2lvbklkIDogJycsXG4gICAgICAgICAgICBkZXB0aDogdHlwZW9mIGl0ZW0uZGVwdGggPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpdGVtLmRlcHRoKSA/IGl0ZW0uZGVwdGggOiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGpvYnMubGVuZ3RoID49IEpPQl9MSU1JVCkgYnJlYWs7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViYWdlbnRzOiBTdWJhZ2VudFZpZXdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgQXJyYXkuaXNBcnJheShzdWJzUmF3Py5zdWJhZ2VudHMpID8gKHN1YnNSYXc/LnN1YmFnZW50cyBhcyB1bmtub3duW10pIDogW10pIHtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgaXRlbSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyA/IGl0ZW0uaWQudHJpbSgpIDogJyc7XG4gICAgICAgIGlmICghaWQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBzdGF0dXMgPSB0eXBlb2YgaXRlbS5zdGF0dXMgPT09ICdzdHJpbmcnID8gaXRlbS5zdGF0dXMgOiAnJztcbiAgICAgICAgc3ViYWdlbnRzLnB1c2goe1xuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBraW5kOiBpdGVtLmtpbmQgPT09ICdkaWFnbm9zdGljJyA/ICdkaWFnbm9zdGljJyA6ICdjaGlsZCcsXG4gICAgICAgICAgICBsYWJlbDogdHlwZW9mIGl0ZW0ubGFiZWwgPT09ICdzdHJpbmcnID8gaXRlbS5sYWJlbC5zbGljZSgwLCAyMDApIDogJycsXG4gICAgICAgICAgICBtb2RlOiBpdGVtLm1vZGUgPT09ICdjb250aW51YWJsZScgPyAnY29udGludWFibGUnIDogJ29uZS1zaG90JyxcbiAgICAgICAgICAgIGRlcHRoOiB0eXBlb2YgaXRlbS5kZXB0aCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGl0ZW0uZGVwdGgpID8gaXRlbS5kZXB0aCA6IG51bGwsXG4gICAgICAgICAgICBoYXNDaGlsZHJlbjogaXRlbS5oYXNDaGlsZHJlbiA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIGFjdGl2aXR5OiBpdGVtLmFjdGl2aXR5ID09PSAncnVubmluZycgPyAncnVubmluZycgOiAnaW5hY3RpdmUnLFxuICAgICAgICAgICAgcmVhc29uOiB0eXBlb2YgaXRlbS5yZWFzb24gPT09ICdzdHJpbmcnID8gaXRlbS5yZWFzb24uc2xpY2UoMCwgNjApIDogbnVsbCxcbiAgICAgICAgICAgIHN0YXR1czogc3RhdHVzID09PSAncnVubmluZycgPyAncnVubmluZycgOiBzdGF0dXMgPT09ICdpZGxlJyA/ICdpZGxlJyA6ICdyZWFkeScsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc3ViYWdlbnRzLmxlbmd0aCA+PSBTVUJBR0VOVF9MSU1JVCkgYnJlYWs7XG4gICAgfVxuXG4gICAgLy8g5o+S5Lu26Ieq5bex5oql55qE44CM5oiq5pat5LqGIC8g5p+Q5Liq5oul5pyJ6ICF5YiX5LiN5Ye65p2l44CN5Lmf5piv6K+05piO55qE5LiA6YOo5YiG77yM5Y6f5qC35bim5LiK5Y67XG4gICAgaWYgKGpvYnNSYXc/LnRydW5jYXRlZCA9PT0gdHJ1ZSkge1xuICAgICAgICBub3Rlcy5wdXNoKGDlkI7lj7Dku7vliqHlj6rnlLvkuobmnIDov5EgJHtKT0JfTElNSVR9IOadoe+8iOS4gOWFsSAke3R5cGVvZiBqb2JzUmF3LnRvdGFsID09PSAnbnVtYmVyJyA/IGpvYnNSYXcudG90YWwgOiAnPyd9IOadoe+8ieOAgmApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGVycm9yIG9mIEFycmF5LmlzQXJyYXkoam9ic1Jhdz8uZXJyb3JzKSA/IChqb2JzUmF3Py5lcnJvcnMgYXMgdW5rbm93bltdKSA6IFtdKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnICYmIGVycm9yKSBub3Rlcy5wdXNoKGDmnInkuIDkuKrkvJror53nmoTlkI7lj7Dku7vliqHliJfkuI3lh7rmnaXvvJoke2Vycm9yLnNsaWNlKDAsIDIwMCl9YCk7XG4gICAgfVxuICAgIGlmIChzdWJzUmF3Py50cnVuY2F0ZWQgPT09IHRydWUpIHtcbiAgICAgICAgbm90ZXMucHVzaChg5a2QIGFnZW50IOWPqueUu+S6huWJjSAke1NVQkFHRU5UX0xJTUlUfSDkuKrvvIjkuIDlhbEgJHt0eXBlb2Ygc3Vic1Jhdy50b3RhbCA9PT0gJ251bWJlcicgPyBzdWJzUmF3LnRvdGFsIDogJz8nfSDkuKrvvInjgIJgKTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBqb2JzLFxuICAgICAgICBzdWJhZ2VudHMsXG4gICAgICAgIGpvYnNBdmFpbGFibGU6IGpvYnNSYXc/LmF2YWlsYWJsZSA9PT0gdHJ1ZSxcbiAgICAgICAgc3ViYWdlbnRzQXZhaWxhYmxlOiBzdWJzUmF3Py5hdmFpbGFibGUgPT09IHRydWUsXG4gICAgICAgIGpvYnNSZWFzb246IHR5cGVvZiBqb2JzUmF3Py5yZWFzb24gPT09ICdzdHJpbmcnID8gam9ic1Jhdy5yZWFzb24gOiBudWxsLFxuICAgICAgICBzdWJhZ2VudHNSZWFzb246IHR5cGVvZiBzdWJzUmF3Py5yZWFzb24gPT09ICdzdHJpbmcnID8gc3Vic1Jhdy5yZWFzb24gOiBudWxsLFxuICAgICAgICBub3RlcyxcbiAgICAgICAgYXQsXG4gICAgfTtcbn1cblxuLyoqIERTSCDlrZDov5vnqIvnmoTlrr/kuLvjgILmlbTkuKrmianlsZXlj6rmnInov5nkuIDkuKrlrp7kvovvvIhgbWFpbi50c2Ag6YeM5oyB5pyJ77yJ44CCICovXG5leHBvcnQgY2xhc3MgRHNoSG9zdCB7XG5cbiAgICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIGNsaWVudDogU2RrQ2xpZW50IHwgbnVsbCA9IG51bGw7XG4gICAgcHJpdmF0ZSBzdGF0dXM6IEFnZW50U3RhdHVzID0gJ3N0b3BwZWQnO1xuICAgIHByaXZhdGUgcnVubmluZyA9IGZhbHNlO1xuICAgIHByaXZhdGUgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIGxhc3RCb290TXM6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHJ1bnRpbWU6IFJlc29sdmVkUnVudGltZSA9IHsgbm9kZUV4ZTogbnVsbCwgbm9kZVNvdXJjZTogJ+acquaOoua1iycsIGRzaEJpbjogbnVsbCwgZHNoU291cmNlOiAn5pyq5o6i5rWLJyB9O1xuXG4gICAgLyoqXG4gICAgICog5b2T5YmNIHNlc3Npb25JZCDnmoTmnaXljobjgIJcbiAgICAgKlxuICAgICAqIC0gYHNka2DvvJpTREsg5Y2P6K6uIGBzZXNzaW9uL3Byb21wdGAg5oeS5Yib5bu65Ye65p2l55qE5Lya6K+d77yI6ICB6Lev5a2Q77yJ77ybXG4gICAgICogLSBgcmVzdW1lZGDvvJrmj5Lku7bnlKggYGFnZW50cy5yZXN1bWVgICoq55yf5q2j5o6l5LiKKirnmoTljoblj7LkvJror50g4oCU4oCUIOWPkea2iOaBr+i1sOaOp+WItuW4p++8m1xuICAgICAqIC0gYGhpc3Rvcnlg77ya5Y+q5piv5oqK5Y6G5Y+y5pel5b+X5Zue5pS+5Yiw6Z2i5p2/5LiK77yI5Y+q6K+777yM6L+Y5rKh5o6l5LiK77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXNzaW9uS2luZDogU2Vzc2lvbktpbmQgPSAnc2RrJztcblxuICAgIC8qKlxuICAgICAqIOW9k+WJjeS8muivneeahOagh+mimO+8iGBzZXNzaW9uL3RpdGxlYCDkuovku7bmipjlh7rmnaXnmoQqKuacgOaWsOS4gOadoSoq77yJ44CCXG4gICAgICpcbiAgICAgKiDlroPkuI3mnaXoh6ogU0RLIOWNj+iuriDigJTigJQg5qCH6aKY5pivKirkvJror53ml6Xlv5fph4znmoTkuIDmnaHkuovku7YqKu+8iGBkc2gtc2Vzc2lvbi10aXRsZWBcbiAgICAgKiDov73liqDnmoTku4Xlhpnml6Xlv5fkuovku7bvvInvvIzmiYDku6XlkozliKvnmoTkvJror53kuovku7botbDlkIzkuIDmnaEgYHNlc3Npb24uZXZlbnRgIOa1geOAglxuICAgICAqIOS4pOadoeadpea6kO+8muehruWumuaAp+WbnumAgO+8iOmmluadoeeUqOaIt+a2iOaBr+eahOWJjeWHoOS4quivje+8jOWQjOatpeWwseacie+8ieS4jiBgc2Vzc2lvbi10aXRsZS1sbG1gXG4gICAgICog77yIKirlvILmraUqKu+8muWPpuWPkeS4gOasoeaooeWei+ivt+axgu+8jOavlOmmlui9ruWbnuetlOaFouS4gOaLjeaJjei/veS4iu+8jOi+g+aWsOiAheiDnOWHuu+8ieOAglxuICAgICAqL1xuICAgIHByaXZhdGUgc2Vzc2lvblRpdGxlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICAgIC8qKlxuICAgICAqIGBjb21tYW5kL3J1bmAg6K6w5LiL55qE5ZG95Luk5ZCN77yM5L6b6YWN5a+555qEIGBjb21tYW5kL2RvbmVgIOeUqOOAglxuICAgICAqXG4gICAgICog5Li65LuA5LmI6KaB6YWN77yaYGNvbW1hbmQvZG9uZWAg5Y+q5bim57uT5p6c5paH5pys77yMKirkuI3luKblkb3ku6TlkI0qKu+8iOazqOWGjOihqOaMiSBgY29tbWFuZElkYCDphY3lr7nvvInjgIJcbiAgICAgKiDlj6rlnKgqKuWbnuaUvioq5pe255So5b6X5LiK77yI5a6e5pe26YKj5p2h57uT5p6c55Sx6Z2i5p2/6Ieq5bex55S777yM6KeBIGBydW5Db21tYW5kYO+8ieOAglxuICAgICAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgY29tbWFuZE5hbWVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblxuICAgIC8qKiDpnZ7nqbogPSDlr7nor53ljLrmraPlnKjmmL7npLrkuIDmnaHljoblj7LkvJror53jgIIgKi9cbiAgICBwcml2YXRlIGhpc3RvcnlWaWV3OiBIaXN0b3J5VmlldyB8IG51bGwgPSBudWxsO1xuXG4gICAgLyoqXG4gICAgICog5b2T5YmN5Lya6K+d55qE55So6YeP77yI5LuOIERTSCDnmoQqKuS8muivneaKleW9see8k+WtmCoq6K+755qE77yM6KeBIGBzdGF0cy50c2DvvInjgIJcbiAgICAgKlxuICAgICAqIOS4ieadoeinpuWPkeaXtuacuu+8mioq5Zue5ZCI57uT5p2fKirvvIjnvJPlrZjmgbDlpb3lnKggYHR1cm4vZW5kYCDlhpnmo4Dmn6XngrnvvInjgIEqKuaNouS8muivnSoq44CBKirpnaLmnb/kuLvliqjopoEqKuOAglxuICAgICAqIOS4jeWBmuWumuaXtui9ruivoiDigJTigJQg5qOA5p+l54K55pys6Lqr5bCx5piv5pSS552A5YaZ55qE77yM6K+75b6X5YaN5Yuk5Lmf5Y+q5piv5ZCM5LiA5Lu95pWw5a2X77yMXG4gICAgICog6ICM6L+Z5Lu95paH5Lu25Zyo5aSn5Lya6K+d5LiK6IO95Yiw5Yeg55m+IEtC44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSB1c2FnZTogU2Vzc2lvblVzYWdlIHwgbnVsbCA9IG51bGw7XG5cbiAgICAvKiogYHVzYWdlYCDkuLogbnVsbCDml7bnmoTljp/lm6DvvIjjgIzov5jmsqHor7vmlbDjgI3kuI7jgIzor7vlpLHotKXjgI3lnKjpnaLmnb/kuIrmmK/kuKTlj6Xor53vvInjgIIgKi9cbiAgICBwcml2YXRlIHVzYWdlTm90ZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgICAvKiog55So6YeP5Y+Y5LqG5L2G6L+Y5rKh5bm/5pKt77yI5a6D5LiN5piv6L2s5YaZ5p2h55uu77yMYGRpcnR5YCDnm6/kuI3liLDlroPvvInjgIIgKi9cbiAgICBwcml2YXRlIHVzYWdlRGlydHkgPSBmYWxzZTtcblxuICAgIC8qKlxuICAgICAqIOacrOS8muivnSoq5a6e5pe25rC05L2NKirvvJrml6Xlv5fph4zmnIDlkI7kuIDmnaHkuovku7bnmoQgYHNlcWDjgIJcbiAgICAgKlxuICAgICAqIOWPqueUqOadpeeul+e8k+WtmOiusOW9leOAjOiQveWQjuWkmuWwkeadoeOAje+8iGBiZWhpbmRg77yJ4oCU4oCUIOajgOafpeeCueaYr+aUkuedgOWGmeeahO+8jOaJgOS7pemdouadv+W/hemhu+iDveivtFxuICAgICAqIOOAjOi/meS4quaVsOWtl+aYr+iusOWIsOesrOWHoOadoeS4uuatoueahOOAjeOAguWPque7n+iuoSoq5a6e5pe2Kirkuovku7bvvIjlm57mlL7ljoblj7Lml7bkuI3orrDvvJrpgqPmmK/lj6bkuIDmnaHkvJror53nmoTnvJblj7fvvInjgIJcbiAgICAgKi9cbiAgICBwcml2YXRlIGxhc3RFdmVudFNlcSA9IDA7XG5cbiAgICAvKiog5o6S552A55qE44CM5pma5LiA54K55YaN6K+75LiA5qyh55So6YeP44CN55qE5a6a5pe25Zmo77yI6KeBIGBzY2hlZHVsZVVzYWdlUmVmcmVzaGDvvInjgIIgKi9cbiAgICBwcml2YXRlIHVzYWdlVGltZXJzOiBOb2RlSlMuVGltZW91dFtdID0gW107XG5cbiAgICAvLyAtLS0tIOi/m+W6pu+8iOa4heWNlSAvIOebruaghyAvIOWbnuWQiOebruW9le+8iS0tLS1cbiAgICAvL1xuICAgIC8vIOS4pOadoeadpei3r++8jOWQiOW5tuinhOWImeWPquacieS4gOadoe+8mioq5LqL5Lu25LyY5YWI44CB57yT5a2Y6KGl5rSeKirvvIjop4EgYG1lcmdlUHJvZ3Jlc3Ng77yJ77yaXG4gICAgLy8gLSBgdG9kby93cml0ZWAgLyBgdHVybi9zdGFydGAgLyBgZ29hbC9jaGFuZ2VgIOS4ieS4qioq5a6e5pe25LqL5Lu2KirvvJrnsr7noa7vvIzkvYblj6ropobnm5bpnaLmnb9cbiAgICAvLyAgIOi9rOWGmeeql+WPo+mHjOeahOmCo+S4gOaute+8iOWOhuWPsuWbnuaUvuWPquivu+aXpeW/l+WwvumDqOeahCAyMDAwIOadoeS6i+S7tu+8ie+8m1xuICAgIC8vIC0g5Lya6K+d5oqV5b2x57yT5a2Y77ya5pW05Liq5pel5b+X5oqY5Ye65p2l55qE77yI5Zue5ZCI5aSn57qy6L+eIDYwMCDmnaHnqpflj6PkuYvlpJbnmoTova7mrKHpg73mnInvvInvvIzkvYbml6fjgIJcblxuICAgIC8qKiDlrp7ml7bkuovku7bnu5nlh7rnmoTmuIXljZXvvIhgdG9kby93cml0ZWAg55qE5pW05Lu95b+r54Wn77yJ44CCbnVsbCA9IOi/mOayoeingei/h+S7u+S9leS4gOS7veOAgiAqL1xuICAgIHByaXZhdGUgdG9kb3M6IFRvZG9WaWV3W10gfCBudWxsID0gbnVsbDtcblxuICAgIC8qKiDpgqPku73muIXljZXmmK8qKuesrOWHoOi9rioq5YaZ55qE77yIMCA9IOS4jeefpemBk++8jGB0dXJuL3N0YXJ0YCDkuI3lnKjlm57mlL7nqpflj6Pph4zml7blsLHkvJrov5nmoLfvvInjgIIgKi9cbiAgICBwcml2YXRlIHRvZG9zVHVybiA9IDA7XG5cbiAgICAvKiog546w5Zyo5Zyo56ys5Yeg6L2u77yIYHR1cm4vc3RhcnRgIOe7meeahO+8ieOAgiAqL1xuICAgIHByaXZhdGUgY3VycmVudFR1cm4gPSAwO1xuXG4gICAgLyoqIOS6i+S7tua1gemHjOingei/h+eahOebruagh++8m2Bnb2FsU2VlbmAg5Yy65YiG44CM5rKh5pyJ55uu5qCH44CN5LiO44CM6L+Y5rKh6KeB6L+HIGBnb2FsL2NoYW5nZWDjgI3jgIIgKi9cbiAgICBwcml2YXRlIGdvYWw6IEdvYWxWaWV3IHwgbnVsbCA9IG51bGw7XG4gICAgcHJpdmF0ZSBnb2FsU2VlbiA9IGZhbHNlO1xuXG4gICAgLyoqIOe8k+WtmOmCo+S4gOS7vea4heWNlSAvIOebruagh++8iCoq5Y+q5Zyo5LqL5Lu26YeM5rKh5pyJ6L+Z5LiA5Z2X5pe2KirmiY3nlKjvvIzop4EgYHByb2dyZXNzVmlld2DvvInjgIIgKi9cbiAgICBwcml2YXRlIGNoZWNrcG9pbnRUb2RvczogVG9kb1ZpZXdbXSB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgY2hlY2twb2ludEdvYWw6IEdvYWxWaWV3IHwgbnVsbCA9IG51bGw7XG5cbiAgICAvKipcbiAgICAgKiDnrKzlh6Dova4g4oaSIOi9rOWGmeadoeebruWPt++8iGB0dXJuL3N0YXJ0YCDliLDovr7ml7borrDkuIvjgIzkuIvkuIDmnaHkvJrmi7/liLDlh6Dlj7fjgI3vvInjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOimgei/meW8oOihqO+8mumdouadv+eahOadoeebruWPt+aYryoq5a6/5Li76Ieq5bex55qE6K6h5pWw5ZmoKirvvIzogIzlm57lkIjlpKfnurLnu5nnmoQgYHNlcWAg5pivXG4gICAgICogKirkvJror53kuovku7bluo/lj7cqKu+8jOS4pOiAheavq+S4jeebuOW5siDigJTigJQg5Y+q5oqK5aSn57qy5Y+R57uZ6Z2i5p2/77yM6YKj5Lqb44CM56ysIE4g6L2u44CN5bCx5Y+q6IO955yL5LiN6IO954K544CCXG4gICAgICogYHR1cm4vc3RhcnRgIOS5i+WQjuesrOS4gOadoeS4iuWxj+eahOadoeebru+8iOato+W4uOWwseaYr+mCo+S4gOi9rueahOeUqOaIt+a2iOaBr++8ieWwseaYr+i3s+i9rOiQveeCueOAglxuICAgICAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgdHVybkFuY2hvcnMgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpO1xuXG4gICAgLyoqIGB0dXJuL3N0YXJ0YCDlt7Lnu4/liLDkuobjgIHkvYbnrKzkuIDmnaHmnaHnm67ov5jmsqHkuIrlsY/vvJrnrYkgYGFwcGVuZGAg5p2l57uR6ZSa54K544CCICovXG4gICAgcHJpdmF0ZSBwZW5kaW5nQW5jaG9yVHVybjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbiAgICAvKiog5Zue5ZCI5aSn57qy77yI57yT5a2Y57uZ55qE5pW05Liq5pel5b+X77yM5bimIGBlbnRyeVNlcWAg5LmL5ZCO5bCx5piv6Z2i5p2/6KaB55S755qE6YKj5LiA5Lu977yJ44CCICovXG4gICAgcHJpdmF0ZSBvdXRsaW5lOiB7IHR1cm5zOiBUdXJuVmlld1tdOyB0dXJuc1RvdGFsOiBudW1iZXI7IGRyYWZ0OiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuXG4gICAgLyoqIOWPo+W+hOivtOaYju+8muivu+ebmOmCo+S4gOi3ryArIOS4ieS4quWunuaXtuS6i+S7tuWQhOiHqueahO+8iOWIhuW8gOWtmO+8jOWFjeW+l+S6kuebuOimhueblu+8ieOAgiAqL1xuICAgIHByaXZhdGUgY2hlY2twb2ludE5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIHByaXZhdGUgdG9kb05vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIHByaXZhdGUgZ29hbE5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgLyoqIOi/m+W6puWPmOS6huS9hui/mOayoeW5v+aSreOAgiAqL1xuICAgIHByaXZhdGUgcHJvZ3Jlc3NEaXJ0eSA9IGZhbHNlO1xuXG4gICAgLyoqIOS4iuS4gOasoeW5v+aSreWHuuWOu+eahOi/m+W6pu+8iEpTT07vvInvvIznlKjmnaXlhY3mjonjgIzkuIDkuKrlrZfoioLpg73msqHlj5jjgI3nmoTpgqPkupvlub/mkq3jgIIgKi9cbiAgICBwcml2YXRlIHByb2dyZXNzSnNvbiA9ICcnO1xuXG4gICAgLyoqIOiHs+WwkeaIkOWKn+ivu+i/h+S4gOasoeajgOafpeeCue+8iOOAjOS4gOS7veecn+eahOayoeacieWbnuWQiOeahOeZveiusOW9leOAjeS5n+eul+aIkOWKn++8ieOAgiAqL1xuICAgIHByaXZhdGUgcHJvZ3Jlc3NTZWVuID0gZmFsc2U7XG5cbiAgICAvKiog6L+b5bqm6YKj5LiA5Lu96K+75aSx6LSlIC8g6L+Y5rKh5pyJ6K+75pWw5pe255qE5Y6f5Zug44CCICovXG4gICAgcHJpdmF0ZSBwcm9ncmVzc05vdGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gICAgLyoqIOe8k+WtmOmHjOeahOawtOS9je+8iOi/m+W6pumHjCBgdHVybnNgIC8gYGdvYWxgIOmCo+S4pOWdl+eahOaWsOmynOW6pu+8ieOAgiAqL1xuICAgIHByaXZhdGUgcHJvZ3Jlc3NTZXE6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgcHJvZ3Jlc3NCZWhpbmQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgcHJvZ3Jlc3NVcGRhdGVkQXQgPSAwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBlbnRyaWVzOiBFbnRyeVtdID0gW107XG4gICAgcHJpdmF0ZSBzZXEgPSAwO1xuICAgIHByaXZhdGUgcmV2aXNpb24gPSAwO1xuXG4gICAgLyoqIOi9rOWGmeS7o+aVsO+8mua4heepui/mjaLkvJror53lsLEgKzHvvIjpnaLmnb/mja7mraTkuKLlvIPml6fmnaHnm67vvInjgIIgKi9cbiAgICBwcml2YXRlIGdlbmVyYXRpb24gPSAwO1xuXG4gICAgLyoqIOaOp+WItuW4p++8iOmdouadv+KGkuaPkuS7tu+8ieeahOivt+axguWPt+S4juWcqOmjnuivt+axguOAgiAqL1xuICAgIHByaXZhdGUgY3RsU2VxID0gMDtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGN0bFBlbmRpbmcgPSBuZXcgTWFwPG51bWJlciwgeyByZXNvbHZlOiAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB2b2lkOyByZWplY3Q6IChlcnJvcjogRXJyb3IpID0+IHZvaWQ7IHRpbWVyOiBOb2RlSlMuVGltZW91dCB9PigpO1xuXG4gICAgLyoqIOa1geW8j+S4reeahOadoeebru+8iOaWh+acrCAvIOaAneiAg+WQhOS4gOadoe+8jOWbnuWQiOWGheWkjeeUqO+8ieOAgiAqL1xuICAgIHByaXZhdGUgdGV4dFN0cmVhbTogRW50cnkgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHJlYXNvbmluZ1N0cmVhbTogRW50cnkgfCBudWxsID0gbnVsbDtcblxuICAgIC8qKiBjYWxsSWQg4oaSIOW3peWFt+adoeebru+8jOeUqOS6juaKiiBgdG9vbC9yZXN1bHRgIOmFjeWbniBgdG9vbC9jYWxsYOOAgiAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9vbEJ5Q2FsbElkID0gbmV3IE1hcDxzdHJpbmcsIEVudHJ5PigpO1xuXG4gICAgLyoqXG4gICAgICog5q2j5Zyo562J5Lq657G75ouN5p2/55qE5Lqk5LqS77yI5o+S5Lu257uPIGBraW5kOidhc2snYCDpgIHmnaXnmoTvvInvvIzmjInlj5Hotbfpobrluo/mjpLjgIJcbiAgICAgKlxuICAgICAqIOS4gOiIrCAwIOaIliAxIOadoe+8m+eUqCBNYXAg5piv5Li65LqG6K6p44CM5a2QIGFnZW50IOeahOaOiOadg+ivt+axguOAjeS4juOAjOS4u+S8muivneeahOaPkOmXruOAjemHjeWPoOaXtlxuICAgICAqIOS4pOadoemDveiDveaYvuekuuOAgemDveiDveWbnuetlO+8jOiAjOS4jeaYr+aOkumYn+etieedgOOAglxuICAgICAqL1xuICAgIHByaXZhdGUgcmVhZG9ubHkgaW50ZXJhY3Rpb25zID0gbmV3IE1hcDxzdHJpbmcsIEludGVyYWN0aW9uVmlldz4oKTtcblxuICAgIC8qKlxuICAgICAqIOmdouadv+acgOi/keS4gOasoea0u+WKqOeahOaXtuWIu++8iGBnZXQtZXZlbnRzYCDova7or6LvvInjgIJcbiAgICAgKlxuICAgICAqIOeUqOmAlOWPquacieS4gOS4qu+8mioq6Z2i5p2/5LiN5Zyo5pe25Yir6K6p5qih5Z6L5bmy562JKiog4oCU4oCUIOS6pOS6kuivt+axguWIsOi+vuaXtuiLpemdouadv+aXqeW3suS4jei9ruivolxuICAgICAqIO+8iOe8lui+keWZqOWFs+S6humCo+S4qumdouadv+OAgeaIluiAheWPquWcqOe7iOerr+i3kei/meS4qiBwcm9maWxl77yJ77yM56uL5Yi75oyJ44CM5rKh5Lq66IO95Zue562U44CN5aSE55CG77yMXG4gICAgICog6KGM5Li65LiO5rKh5pyJ6L+Z5aWX5Lqk5LqS6YCa6YGT5pe25LiA6Ie077yI5o+Q6Zeu5oql6ZSZ44CB5o6I5p2D5aSx6LSl5YWz6Zet77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBsYXN0UGFuZWxBY3Rpdml0eSA9IDA7XG5cbiAgICAvKiog5pys5bin5YaF6KKr5pS55Yqo6L+H55qE5p2h55uu77yI5bm/5pKt55So77yJ44CCICovXG4gICAgcHJpdmF0ZSByZWFkb25seSBkaXJ0eSA9IG5ldyBTZXQ8RW50cnk+KCk7XG4gICAgcHJpdmF0ZSBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xuXG4gICAgLyoqIOagh+mimOWPmOS6huS9hui/mOayoeW5v+aSre+8iOagh+mimOS4jeaYr+i9rOWGmeadoeebru+8jGBkaXJ0eWAg55uv5LiN5Yiw5a6D77yJ44CCICovXG4gICAgcHJpdmF0ZSB0aXRsZURpcnR5ID0gZmFsc2U7XG5cbiAgICBwcml2YXRlIHN0ZGVyclRhaWw6IHN0cmluZ1tdID0gW107XG4gICAgcHJpdmF0ZSBzdGRlcnJCdWZmZXIgPSAnJztcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgbGlzdGVuZXJzID0gbmV3IFNldDwodXBkYXRlOiBIb3N0VXBkYXRlVmlldykgPT4gdm9pZD4oKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5a+55aSW5Y+q6K+7XG5cbiAgICAvKiog5rOo5YaM5pu05paw5Zue6LCD77yIYG1haW4udHNgIOeUqOWug+WPkeW5v+aSre+8ieOAgui/lOWbnuazqOmUgOWHveaVsOOAgiAqL1xuICAgIG9uVXBkYXRlKGxpc3RlbmVyOiAodXBkYXRlOiBIb3N0VXBkYXRlVmlldykgPT4gdm9pZCk6ICgpID0+IHZvaWQge1xuICAgICAgICB0aGlzLmxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgICByZXR1cm4gKCkgPT4gdGhpcy5saXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICB9XG5cbiAgICAvKiog5b2T5YmN5b+r54Wn44CCICovXG4gICAgc25hcHNob3QoKTogQWdlbnRTbmFwc2hvdCB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGF0dXM6IHRoaXMuc3RhdHVzLFxuICAgICAgICAgICAgcnVubmluZzogdGhpcy5ydW5uaW5nLFxuICAgICAgICAgICAgc2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCxcbiAgICAgICAgICAgIHNlc3Npb25LaW5kOiB0aGlzLnNlc3Npb25LaW5kLFxuICAgICAgICAgICAgaGlzdG9yeTogdGhpcy5oaXN0b3J5VmlldyA/IHsgLi4udGhpcy5oaXN0b3J5VmlldyB9IDogbnVsbCxcbiAgICAgICAgICAgIGdlbmVyYXRpb246IHRoaXMuZ2VuZXJhdGlvbixcbiAgICAgICAgICAgIHBpZDogdGhpcy5jaGlsZD8ucGlkID8/IG51bGwsXG4gICAgICAgICAgICBsYXN0Qm9vdE1zOiB0aGlzLmxhc3RCb290TXMsXG4gICAgICAgICAgICBsYXN0RXJyb3I6IHRoaXMubGFzdEVycm9yLFxuICAgICAgICAgICAgZW50cnlDb3VudDogdGhpcy5lbnRyaWVzLmxlbmd0aCxcbiAgICAgICAgICAgIHJldmlzaW9uOiB0aGlzLnJldmlzaW9uLFxuICAgICAgICAgICAgaW50ZXJhY3Rpb25zOiBbLi4udGhpcy5pbnRlcmFjdGlvbnMudmFsdWVzKCldLFxuICAgICAgICAgICAgdGl0bGU6IHRoaXMuc2Vzc2lvblRpdGxlLFxuICAgICAgICAgICAgdXNhZ2U6IHRoaXMudXNhZ2UgPyB7IC4uLnRoaXMudXNhZ2UgfSA6IG51bGwsXG4gICAgICAgICAgICB1c2FnZU5vdGU6IHRoaXMudXNhZ2VOb3RlLFxuICAgICAgICAgICAgcHJvZ3Jlc3M6IHRoaXMucHJvZ3Jlc3NWaWV3KCksXG4gICAgICAgICAgICBwcm9ncmVzc05vdGU6IHRoaXMucHJvZ3Jlc3NOb3RlLFxuICAgICAgICAgICAgcnVudGltZToge1xuICAgICAgICAgICAgICAgIG5vZGVFeGU6IHRoaXMucnVudGltZS5ub2RlRXhlLFxuICAgICAgICAgICAgICAgIGRzaEJpbjogdGhpcy5ydW50aW1lLmRzaEJpbixcbiAgICAgICAgICAgICAgICBub2RlU291cmNlOiB0aGlzLnJ1bnRpbWUubm9kZVNvdXJjZSxcbiAgICAgICAgICAgICAgICBkc2hTb3VyY2U6IHRoaXMucnVudGltZS5kc2hTb3VyY2UsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RkZXJyVGFpbDogWy4uLnRoaXMuc3RkZXJyVGFpbF0sXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog6K6w5LiA5qyh44CM6Z2i5p2/6L+Y5rS7552A44CN77yIYG1haW4udHNgIOWcqOmdouadv+i9ruivouaXtuiwg++8ieOAglxuICAgICAqXG4gICAgICog6KeBIGBQQU5FTF9RVUlFVF9NU2Ag55qE5rOo6YeK77ya6L+Z5piv44CM5pyJ5Lq66IO95Zue562U5ZCX44CN55qE5ZSv5LiA5Yik5o2u44CCXG4gICAgICovXG4gICAgbm90ZVBhbmVsQWN0aXZpdHkoKTogdm9pZCB7XG4gICAgICAgIHRoaXMubGFzdFBhbmVsQWN0aXZpdHkgPSBEYXRlLm5vdygpO1xuICAgIH1cblxuICAgIC8qKiDlop7ph4/mi4nlj5bvvJrov5Tlm54gYHJldiA+IHNpbmNlYCDnmoTmnaHnm67vvIjlkIzkuIAgc2VxIOS8muiiq+WPjeWkjei/lOWbnu+8jOmdouadv+WOn+WcsOabtOaWsO+8ieOAgiAqL1xuICAgIGV2ZW50c1NpbmNlKHNpbmNlOiBudW1iZXIpOiBFdmVudHNQYXlsb2FkIHtcbiAgICAgICAgY29uc3QgZnJvbSA9IE51bWJlci5pc0Zpbml0ZShzaW5jZSkgPyBzaW5jZSA6IDA7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBlbnRyaWVzOiB0aGlzLmVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkucmV2ID4gZnJvbSksXG4gICAgICAgICAgICByZXZpc2lvbjogdGhpcy5yZXZpc2lvbixcbiAgICAgICAgICAgIGdlbmVyYXRpb246IHRoaXMuZ2VuZXJhdGlvbixcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiog5o6i5rWL5LiA5qyh6L+Q6KGM5pe277yI6Z2i5p2/6KaB5Zyo5rKh5ZCv5Yqo5pe25Lmf6IO95pi+56S644CM5bCG55So5ZOq5LiqIG5vZGUvZHNo44CN77yJ44CCICovXG4gICAgcHJvYmVSdW50aW1lKCk6IFJlc29sdmVkUnVudGltZSB7XG4gICAgICAgIHRoaXMucnVudGltZSA9IHJlc29sdmVSdW50aW1lKGdldFNldHRpbmdzKCkpO1xuICAgICAgICByZXR1cm4gdGhpcy5ydW50aW1lO1xuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g55Sf5ZG95ZGo5pyfXG5cbiAgICAvKipcbiAgICAgKiDlkK/liqggYWdlbnTjgIJcbiAgICAgKlxuICAgICAqIOW5guetie+8muW3sue7j+WcqOi3keaIluato+WcqOi1t+WwseebtOaOpei/lOWbnuaIkOWKn+OAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtvaywgZXJyb3I/fWDvvJvlpLHotKUqKuS4jeaKmyoq77yM6K6p6Z2i5p2/6IO95pi+56S65Y6f5Zug44CCXG4gICAgICovXG4gICAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICh0aGlzLnN0YXR1cyA9PT0gJ3JlYWR5JyB8fCB0aGlzLnN0YXR1cyA9PT0gJ3N0YXJ0aW5nJykgcmV0dXJuIHsgb2s6IHRydWUgfTtcblxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IGdldFNldHRpbmdzKCk7XG4gICAgICAgIHRoaXMucnVudGltZSA9IHJlc29sdmVSdW50aW1lKHNldHRpbmdzKTtcbiAgICAgICAgaWYgKCF0aGlzLnJ1bnRpbWUubm9kZUV4ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZmFpbChcbiAgICAgICAgICAgICAgICAn5om+5LiN5Yiw5Y+v55So55qEIG5vZGXjgILor7flnKggRFNIIOmdouadv+iuvue9rumHjOWhq+OAjG5vZGUg6Lev5b6E44CN77yM5oiW5oqKIG5vZGUg5Yqg5YiwIFBBVEjjgIInICtcbiAgICAgICAgICAgICAgICAgICAgJ++8iOazqOaEj++8mue8lui+keWZqOiHquW4pueahCBFbGVjdHJvbiDkuI3mmK8gbm9kZe+8jOS4jeiDveaLv+adpei3kSBkc2jjgILvvIknLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXRoaXMucnVudGltZS5kc2hCaW4pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZhaWwoXG4gICAgICAgICAgICAgICAgJ+aJvuS4jeWIsCBkc2ggQ0xJIOWFpeWPo+OAguivt+WcqOiuvue9rumHjOWhq+OAjGRzaCBiaW4uanMg6Lev5b6E44CN77yI6YCa5bi45b2i5aaCICcgK1xuICAgICAgICAgICAgICAgICAgICAnYDxucG0g5YWo5bGA55uu5b2VPlxcXFxub2RlX21vZHVsZXNcXFxcQGRlZXBzZWVrLWFpXFxcXGRzaFxcXFxsaWJcXFxcYmluLmpzYO+8ieOAgicsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY3dkID0gc2V0dGluZ3Mud29ya2RpciB8fCBFZGl0b3IuUHJvamVjdC5wYXRoO1xuICAgICAgICB0aGlzLnNldFN0YXR1cygnc3RhcnRpbmcnKTtcbiAgICAgICAgdGhpcy5sYXN0RXJyb3IgPSBudWxsO1xuICAgICAgICB0aGlzLnN0ZGVyclRhaWwgPSBbXTtcbiAgICAgICAgdGhpcy5zdGRlcnJCdWZmZXIgPSAnJztcbiAgICAgICAgY29uc3Qgc3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdGhpcy5jaGlsZCA9IGZvcmsodGhpcy5ydW50aW1lLmRzaEJpbiwgWyctLXByb2ZpbGUnLCBQUk9GSUxFX05BTUVdLCB7XG4gICAgICAgICAgICAgICAgLy8g4pqgIOW/hemhu+aYvuW8j+e7mSBleGVjUGF0aO+8mum7mOiupOS8mueUqOe8lui+keWZqOeahCBgcHJvY2Vzcy5leGVjUGF0aGDvvIhDb2Nvc0NyZWF0b3IuZXhl77yJXG4gICAgICAgICAgICAgICAgZXhlY1BhdGg6IHRoaXMucnVudGltZS5ub2RlRXhlLFxuICAgICAgICAgICAgICAgIGN3ZCxcbiAgICAgICAgICAgICAgICBzdGRpbzogWydwaXBlJywgJ3BpcGUnLCAncGlwZScsICdpcGMnXSxcbiAgICAgICAgICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgICBlbnY6IHtcbiAgICAgICAgICAgICAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgICAgICAgICAgICAgIC8vIOmaj+aJqeWxleWPkeW4g+eahOmAmueUqCBza2lsbCDmoLkg4oCU4oCUIOiuqeOAjOW8leaTji/nvJbovpHlmajmk43kvZznmoTpgJrnlKjnn6Xor4bjgI3ot5/nnYDmj5Lku7botbDvvIxcbiAgICAgICAgICAgICAgICAgICAgLy8g5o2i5bel56iL6KOF5LiK5bCx5pyJ44CC6KeBIGJ1bmRsZWRTa2lsbERpcigpIOS4jiBza2lsbHMvUkVBRE1FLm1k44CCXG4gICAgICAgICAgICAgICAgICAgIERTSF9CVU5ETEVEX1NLSUxMX0RJUjogYnVuZGxlZFNraWxsRGlyKCksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAvLyBgd2luZG93c0hpZGVgIOaYr+ecn+WunuWtmOWcqOeahOmAiemhue+8iFdpbmRvd3Mg5LiK5Yir5by56buR5qGG77yJ77yM5L2G5pys5Zyw55qEIEB0eXBlcy9ub2RlXG4gICAgICAgICAgICAgICAgLy8g5q+U5a6D5pen44CBRm9ya09wdGlvbnMg6YeM6L+Y5rKh5aOw5piO77yM5omA5Lul6L+Z6YeM5pat6KiA5LiA5LiL6ICM5LiN5piv5Yig5o6J6L+Z5Liq6YCJ6aG544CCXG4gICAgICAgICAgICB9IGFzIGltcG9ydCgnY2hpbGRfcHJvY2VzcycpLkZvcmtPcHRpb25zKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZhaWwoYOWQr+WKqCBkc2gg5a2Q6L+b56iL5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmF0dGFjaENoaWxkKHRoaXMuY2hpbGQpO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICAgICAgICAgIGN3ZCxcbiAgICAgICAgICAgICAgICBwcm92aWRlcjogc2V0dGluZ3MucHJvdmlkZXIsXG4gICAgICAgICAgICAgICAgbW9kZWw6IHNldHRpbmdzLm1vZGVsLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncy5yZWFzb25pbmdFZmZvcnQpIHBhcmFtcy5yZWFzb25pbmdFZmZvcnQgPSBzZXR0aW5ncy5yZWFzb25pbmdFZmZvcnQ7XG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MubWF4VG9rZW5zID4gMCkgcGFyYW1zLm1heFRva2VucyA9IHNldHRpbmdzLm1heFRva2VucztcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5jbGllbnQ/LmluaXRpYWxpemUocGFyYW1zIGFzIHsgY3dkOiBzdHJpbmc7IHByb3ZpZGVyOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmcgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGVzY3JpYmUoZXJyb3IpO1xuICAgICAgICAgICAgLy8g6LW35LiN5p2l5bCx5Yir55WZ5Y2K5q2755qE6L+b56iLXG4gICAgICAgICAgICB0aGlzLmtpbGxDaGlsZCgpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZmFpbChg5Yid5aeL5YyW5aSx6LSl77yaJHttZXNzYWdlfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5sYXN0Qm9vdE1zID0gRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdDtcbiAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3JlYWR5Jyk7XG4gICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgYGFnZW50IOW3suWwsee7qu+8iCR7dGhpcy5sYXN0Qm9vdE1zfW1z77yJIOaooeWeiyAke3NldHRpbmdzLnByb3ZpZGVyfS8ke3NldHRpbmdzLm1vZGVsfe+8m+W3peS9nOebruW9lSAke2N3ZH1gLFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIOWQr+WKqOWQjioq5o6l552A5LiK5qyh6IGKKirvvJpEU0gg55qEIHdlYiDnq6/kuZ/mmK/ov5nkuKrooYzkuLrvvIjpnaLmnb/oh6rlt7HkuI3luKbno4Hnm5jovazlhpnvvIzmiYDku6Xov5jopoHmiorljoblj7Llm57mlL7kuIDpgY3vvIlcbiAgICAgICAgYXdhaXQgdGhpcy5yZXN0b3JlTGFzdFNlc3Npb24oY3dkKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDlkK/liqjlkI7oh6rliqjmgaLlpI3jgIzmnKzlt6XnqIvmnIDov5HkuIDmnaHmnInlhoXlrrnnmoTkvJror53jgI3jgIJcbiAgICAgKlxuICAgICAqICMjIOS4uuS7gOS5iOm7mOiupOimgei/meS5iOWBmlxuICAgICAqXG4gICAgICog5LiA5qyh44CM5YGc5q2iIOKGkiDlkK/liqjjgI3lnKggRFNIIOS+p+aYryoq5o2i5LqG5LiA5Liq6L+Q6KGM5pe2KirvvIzogIwgU0RLIOWNj+iurumHjOeahCBgc2Vzc2lvbi9wcm9tcHRgXG4gICAgICog5Y+q5LyaIGBjcmVhdGVgIOaWsOS8muivne+8iOaooeWei+S+p+ayoeacieS7u+S9leWOhuWPsuS4iuS4i+aWh++8ieKAlOKAlCDmiYDku6XogIHku6PnoIHph4wgYHN0YXJ0KClgIOavj+asoVxuICAgICAqIOmaj+S+v+aKveS4gOS4quaWsCB1dWlk77yM5pWI5p6c5bCx5piv44CM5LiA6YeN5ZCv77yM5LmL5YmN6IGK55qE5YWo5rKh5LqG44CN44CC55So5oi355yL5Yiw55qE5q2j5piv6L+Z5Liq44CCXG4gICAgICpcbiAgICAgKiDotbDmj5Lku7bmjqfliLbluKfnmoQgYHNlc3Npb24vcmVzdW1lYCDmiY3mmK8qKuecn+aBouWkjSoq77yIYGFnZW50cy5yZXN1bWVg77yM5qih5Z6L5bim552A5LiK5LiL5paH5Zue5p2l77yJ77yMXG4gICAgICog6aG65bim5oqK6L+Z5q615Y6G5Y+y5Zue5pS+5Yiw6Z2i5p2/5LiK77yM5LqO5piv6YeN5ZCv5YmN5ZCO55qE6KeC5oSf5piv6L+e57ut55qE44CCXG4gICAgICpcbiAgICAgKiDlpLHotKXkuI3oh7Tlkb3vvJrpgIDlm57jgIzmlrDkvJror53jgI3lubbmiorljp/lm6Dlhpnov5vovazlhpnvvIjkuI3nhLbnlKjmiLflj6rkvJrnnIvliLDkuIDniYfnqbrnmb3vvInjgIJcbiAgICAgKi9cbiAgICBwcml2YXRlIGFzeW5jIHJlc3RvcmVMYXN0U2Vzc2lvbihjd2Q6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbGlzdGVkID0gYXdhaXQgbGlzdEhpc3RvcnkodGhpcy5ydW50aW1lLm5vZGVFeGUsIGN3ZCwgNSk7XG4gICAgICAgICAgICBpZiAoIWxpc3RlZC5vaykgdGhyb3cgbmV3IEVycm9yKGxpc3RlZC5lcnJvciA/PyAn5YiX5Y6G5Y+y5Lya6K+d5aSx6LSlJyk7XG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSAobGlzdGVkLnNlc3Npb25zID8/IFtdKS5maW5kKChzZXNzaW9uKSA9PiBzZXNzaW9uLnR1cm5zID4gMCkgPz8gKGxpc3RlZC5zZXNzaW9ucyA/PyBbXSlbMF07XG4gICAgICAgICAgICBpZiAoIWNhbmRpZGF0ZSkge1xuICAgICAgICAgICAgICAgIHRoaXMuc2Vzc2lvbklkID0gcmFuZG9tVVVJRCgpO1xuICAgICAgICAgICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnc2RrJztcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsICfov5jmsqHogYrov4fvvIzlt7LlvIDmlrDkvJror53jgIInKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IHRoaXMubG9hZEhpc3RvcnkoY2FuZGlkYXRlLmlkLCB7IHF1aWV0OiB0cnVlIH0pO1xuICAgICAgICAgICAgaWYgKCFvcGVuZWQub2spIHRocm93IG5ldyBFcnJvcihvcGVuZWQuZXJyb3IgPz8gJ+ivu+WOhuWPsuS8muivneWksei0pScpO1xuICAgICAgICAgICAgY29uc3QgcmVzdW1lZCA9IGF3YWl0IHRoaXMucmVzdW1lSGlzdG9yeShjYW5kaWRhdGUuaWQpO1xuICAgICAgICAgICAgaWYgKCFyZXN1bWVkLm9rKSB0aHJvdyBuZXcgRXJyb3IocmVzdW1lZC5lcnJvciA/PyAn57un57ut5Lya6K+d5aSx6LSlJyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25JZCA9IHJhbmRvbVVVSUQoKTtcbiAgICAgICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnc2RrJztcbiAgICAgICAgICAgIHRoaXMuaGlzdG9yeVZpZXcgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoXG4gICAgICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgICAgIGDmsqHog73mjqXkuIrkuIrmrKHnmoTkvJror53vvIgke2Rlc2NyaWJlKGVycm9yKX3vvInigJTigJQg5bey5byA5paw5Lya6K+dICR7U3RyaW5nKHRoaXMuc2Vzc2lvbklkKS5zbGljZSgwLCA4KX3igKbjgIJgICtcbiAgICAgICAgICAgICAgICAgICAgJ+WOhuWPsuS7jeWcqOWPs+S4iuinkuOAjOWOhuWPsuOAjemHjOOAgicsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5YiX5Y6G5Y+y5Lya6K+d77yI6Z2i5p2/5LiK55qE44CM5Y6G5Y+y44CN5oyJ6ZKu77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gbGltaXQgLSDmnIDlpJrlh6DmnaHjgIJcbiAgICAgKiBAcmV0dXJucyBge29rLCBzZXNzaW9ucz8sIGVycm9yP31g44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeUxpc3QobGltaXQgPSAyMCk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgc2Vzc2lvbnM/OiBIaXN0b3J5U2Vzc2lvblZpZXdbXTsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAoIXRoaXMucnVudGltZS5ub2RlRXhlKSB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShnZXRTZXR0aW5ncygpKTtcbiAgICAgICAgY29uc3QgY3dkID0gZ2V0U2V0dGluZ3MoKS53b3JrZGlyIHx8IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IGxpc3RlZCA9IGF3YWl0IGxpc3RIaXN0b3J5KHRoaXMucnVudGltZS5ub2RlRXhlLCBjd2QsIGxpbWl0KTtcbiAgICAgICAgaWYgKCFsaXN0ZWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGxpc3RlZC5lcnJvciB9O1xuXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSB0aGlzLmhpc3RvcnlWaWV3Py5zZXNzaW9uSWQgPz8gbnVsbDtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbnMgPSAobGlzdGVkLnNlc3Npb25zID8/IFtdKS5tYXAoKHNlc3Npb246IEhpc3RvcnlTZXNzaW9uKSA9PiAoe1xuICAgICAgICAgICAgaWQ6IHNlc3Npb24uaWQsXG4gICAgICAgICAgICB0aXRsZTogc2Vzc2lvbi50aXRsZSxcbiAgICAgICAgICAgIGNyZWF0ZWRBdDogc2Vzc2lvbi5jcmVhdGVkQXQsXG4gICAgICAgICAgICB1cGRhdGVkQXQ6IHNlc3Npb24udXBkYXRlZEF0LFxuICAgICAgICAgICAgYnl0ZXM6IHNlc3Npb24uYnl0ZXMsXG4gICAgICAgICAgICB0dXJuczogc2Vzc2lvbi50dXJucyxcbiAgICAgICAgICAgIGN1cnJlbnQ6IHNlc3Npb24uaWQgPT09IGN1cnJlbnQsXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHNlc3Npb25zIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5oqK5LiA5p2h5Y6G5Y+y5Lya6K+dKirlm57mlL7liLDlr7nor53ljLoqKu+8iOWPquivu++8ieOAglxuICAgICAqXG4gICAgICog5Zue5pS+6LWw55qE5piv44CM5ZCM5LiA5Lu95LqL5Lu25rWB44CN77ya5pel5b+X6YeM55qE5LqL5Lu25ZKM5a6e5pe26YCa55+l5piv5ZCM5p6E55qEXG4gICAgICog77yIYHt0eXBlLCBzZXEsIHRpbWUsIGRhdGF9YO+8ie+8jOaJgOS7pei/memHjOaKiiBgaGFuZGxlU2Vzc2lvbkV2ZW50YCDnmoQgYHJlcGxheWAg5qGj5omT5byA77yMXG4gICAgICog6K6p5Y6G5Y+y6LWw5LiA6YGNKirlkozlrp7ml7blrozlhajkuIDmoLcqKueahOaKleW9semAu+i+kSDigJTigJQg5LiN5Y+m5YaZ5LiA5aWX5riy5p+T6KeE5YiZ77yM5bCx5LiN5Lya5Lik6L655LiN5LiA6Ie044CCXG4gICAgICpcbiAgICAgKiDimqAg5a6e5rWL77yIYC50bXAvdmVyaWZ5LXJlc3VtZS5tanNg77yJ77yaYGFnZW50cy5yZXN1bWVgICoq5LiN5LyaKirmiorljoblj7Lkuovku7bph43mlL7lh7rmnaXvvIxcbiAgICAgKiDmiYDku6Xov5nmrrXlm57mlL7kuI3mmK/jgIzlpJrmraTkuIDkuL7jgI3vvIzogIzmmK/jgIzkuI3nlLvlsLHmsqHmnInjgI3jgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAgICAgKiBAcGFyYW0gb3B0aW9ucy5xdWlldCAtIOiHquWKqOaBouWkjeaXtuS4jeWIt+mCo+S4pOihjCBub3Rl77yI6YG/5YWN5ZCv5Yqo5bCx5LiA5bGP5a2X77yJ44CCXG4gICAgICogQHBhcmFtIG9wdGlvbnMuanVtcFRvIC0g5Zue5pS+5a6M5oOzKirmu5rliLAqKueahOmCo+adoeS6i+S7tueahCBzZXHvvIjlhajmlofmkJzntKLlkb3kuK3ml7bnlKjvvInjgIJcbiAgICAgKiBAcmV0dXJucyBge29rLCBldmVudHM/LCBlbnRyeVNlcT8sIGVycm9yP31g77ybYGVudHJ5U2VxYCDmmK/ovazlhpnph4znmoTmnaHnm67lj7fjgIJcbiAgICAgKi9cbiAgICBhc3luYyBsb2FkSGlzdG9yeShcbiAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmcsXG4gICAgICAgIG9wdGlvbnM6IHsgcXVpZXQ/OiBib29sZWFuOyBqdW1wVG8/OiBudW1iZXIgfSA9IHt9LFxuICAgICk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgZXZlbnRzPzogbnVtYmVyOyBlbnRyeVNlcT86IG51bWJlcjsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAoIXRoaXMucnVudGltZS5ub2RlRXhlKSB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShnZXRTZXR0aW5ncygpKTtcbiAgICAgICAgY29uc3QgY3dkID0gZ2V0U2V0dGluZ3MoKS53b3JrZGlyIHx8IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IHJlYWQgPSBhd2FpdCByZWFkSGlzdG9yeSh0aGlzLnJ1bnRpbWUubm9kZUV4ZSwgY3dkLCBzZXNzaW9uSWQpO1xuICAgICAgICBpZiAoIXJlYWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlYWQuZXJyb3IgfTtcblxuICAgICAgICBjb25zdCBldmVudHMgPSByZWFkLmV2ZW50cyA/PyBbXTtcbiAgICAgICAgdGhpcy5yZXNldFRyYW5zY3JpcHQoKTtcbiAgICAgICAgdGhpcy5oaXN0b3J5VmlldyA9IHtcbiAgICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICAgIC8vIOS8mOWFiOeUqOaXpeW/l+iHquW3seiusOeahOagh+mimO+8iGBzZXNzaW9uL3RpdGxlYO+8jOWPr+iDveaYr+aooeWei+eUn+aIkOeahO+8ie+8jFxuICAgICAgICAgICAgLy8g5rKh5pyJ5omN5Zue6YCA5Yiw44CM6aaW5p2h55So5oi35raI5oGv44CN77yI5pen5pel5b+XIC8g5LqL5Lu26KKrIG1heEV2ZW50cyDmiKrmjonml7bvvInjgIJcbiAgICAgICAgICAgIHRpdGxlOiBsb2dnZWRUaXRsZU9mKGV2ZW50cykgfHwgdGl0bGVPZkV2ZW50cyhldmVudHMpIHx8ICco5peg5qCH6aKYKScsXG4gICAgICAgICAgICBjcmVhdGVkQXQ6ICgocmVhZC5oZWFkZXIgPz8ge30pIGFzIHsgY3JlYXRlZEF0PzogbnVtYmVyIH0pLmNyZWF0ZWRBdCA/PyBudWxsLFxuICAgICAgICAgICAgbWVzc2FnZUNvdW50OiBldmVudHMubGVuZ3RoLFxuICAgICAgICAgICAgbGl2ZTogZmFsc2UsXG4gICAgICAgIH07XG4gICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnaGlzdG9yeSc7XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIOWbnuaUvueahOWQjOaXtuaKiuOAjOS6i+S7tiBzZXEg4oaSIOi9rOWGmeadoeebriBzZXHjgI3mjaLnrpflh7rmnaXjgIJcbiAgICAgICAgICpcbiAgICAgICAgICog5Li65LuA5LmI6ZyA6KaB5o2i566X77ya5Lik6L655pivKirkuKTlpZfnvJblj7cqKu+8jOiAjOS4lOS4jeaYr+S4gOWvueS4gCDigJTigJQg5pel5b+X6YeM55qEXG4gICAgICAgICAqIGB0b29sL3Jlc3VsdGAg5Y+q5piv5oqKIGB0b29sL2NhbGxgIOmCo+W8oOWNoeeJh+ihpeS4iue7k+aenO+8iCoq5LiN5paw5aKe5p2h55uuKirvvInvvIxcbiAgICAgICAgICogYHNlc3Npb24vdGl0bGVgIOW5suiEhuS4jeS4iuWxj+OAguaQnOe0oue7meeahOaYr+S6i+S7tiBzZXHvvIjpgqPmmK/lroPlnKjml6Xlv5fph4znnIvliLDnmoTkvY3nva7vvInvvIxcbiAgICAgICAgICog6Z2i5p2/6KaB55qE5piv5p2h55uuIHNlce+8iOmCo+aYryBET00g5LiK55qE5L2N572u77yJ77yM5Lit6Ze06L+Z5bGC57+76K+R5Y+q5pyJ5Zue5pS+55qE5Lq65YGa5b6X5LqG44CCXG4gICAgICAgICAqL1xuICAgICAgICBsZXQganVtcEVudHJ5OiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gICAgICAgIGZvciAoY29uc3QgZXZlbnQgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgICBjb25zdCBiZWZvcmUgPSB0aGlzLnNlcTtcbiAgICAgICAgICAgIHRoaXMuaGFuZGxlU2Vzc2lvbkV2ZW50KGV2ZW50LCB0cnVlLCBzZXNzaW9uSWQpO1xuICAgICAgICAgICAgaWYgKG9wdGlvbnMuanVtcFRvID09PSB1bmRlZmluZWQgfHwgTnVtYmVyKGV2ZW50LnNlcSA/PyAtMSkgIT09IG9wdGlvbnMuanVtcFRvKSBjb250aW51ZTtcbiAgICAgICAgICAgIC8vIOaWsOWinuS6huadoeebriDihpIg5bCx5piv5a6D77yb5rKh5paw5aKe77yI5bel5YW357uT5p6c6KGl6L+b5bey5pyJ5Y2h54mH77yJ4oaSIOaJvuWImuWImuiiqyB0b3VjaCDnmoTpgqPmnaFcbiAgICAgICAgICAgIGp1bXBFbnRyeSA9IHRoaXMuc2VxID4gYmVmb3JlID8gYmVmb3JlICsgMSA6IHRoaXMuZW50cnlTZXFPZlJldih0aGlzLnJldmlzaW9uKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghb3B0aW9ucy5xdWlldCkge1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoXG4gICAgICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgICAgIGDku6XkuIrmmK/ljoblj7LkvJror50gJHtzZXNzaW9uSWQuc2xpY2UoMCwgOCl94oCmIOeahCAke2V2ZW50cy5sZW5ndGh9IOadoeiusOW9le+8iOWPquivu+WbnuaUvu+8jOWFsSAke3JlYWQudG90YWwgPz8gZXZlbnRzLmxlbmd0aH0g5p2h77yJ44CCYCArXG4gICAgICAgICAgICAgICAgICAgICfmg7PmjqXnnYDogYrlsLHngrnkuIrpnaLnmoTjgIznu6fnu63mraTkvJror53jgI3jgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLmp1bXBUbyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAvLyDovazlhpnlj6rnlZnmnIDov5EgYE1BWF9FTlRSSUVTYCDmnaHvvJrlkb3kuK3lpKrpnaDliY3ml7bpgqPkuIDmnaHlt7Lnu4/ooqvmjKTmjonkuobjgIJcbiAgICAgICAgICAgIC8vIOi/meaXtuWAmSoq5piO6K+0KirvvIzliKvorqnnlKjmiLfku6XkuLrjgIzmkJzliLDkuobljbTmiZPkuI3lvIDjgI3jgIJcbiAgICAgICAgICAgIGlmIChqdW1wRW50cnkgIT09IHVuZGVmaW5lZCAmJiAhdGhpcy5lbnRyaWVzLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS5zZXEgPT09IGp1bXBFbnRyeSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZChcbiAgICAgICAgICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgICAgICAgICBg5pCc57Si5ZG95Lit55qE6YKj5LiA5p2h5Zyo5b6I6Z2g5YmN55qE5L2N572u77yI56ysICR7b3B0aW9ucy5qdW1wVG99IOadoeS6i+S7tu+8ie+8jGAgK1xuICAgICAgICAgICAgICAgICAgICAgICAgYOiAjOi9rOWGmeWPquS/neeVmeacgOi/kSAke01BWF9FTlRSSUVTfSDmnaEg4oCU4oCUIOWug+W3sue7j+S4jeWcqOeql+WPo+mHjOS6hu+8jOWPr+S7peWvvOWHuui/meS7veaXpeW/l+adpeafpeOAgmAsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgZXZlbnRzOiBldmVudHMubGVuZ3RoIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGV2ZW50czogZXZlbnRzLmxlbmd0aCwgZW50cnlTZXE6IGp1bXBFbnRyeSB9O1xuICAgIH1cblxuICAgIC8qKiDmib7jgIzliJrooqsgdG91Y2gg55qE6YKj5LiA5p2h44CN77yIYHJldmAg5piv5pyA5ZCO5LiA5qyh5pS55Yqo55qE54mI5pys5Y+377yM5YWo6L2s5YaZ5ZSv5LiA77yJ44CCICovXG4gICAgcHJpdmF0ZSBlbnRyeVNlcU9mUmV2KHJldjogbnVtYmVyKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmVudHJpZXMpIGlmIChlbnRyeS5yZXYgPT09IHJldikgcmV0dXJuIGVudHJ5LnNlcTtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiAqKuecn+ato+aOpeS4iioq5LiA5p2h5Y6G5Y+y5Lya6K+d77yI5o+S5Lu25L6nIGBhZ2VudHMucmVzdW1lYO+8ieOAglxuICAgICAqXG4gICAgICog5o6l5LiK5LmL5ZCO77yaYHNlc3Npb25JZGAg5oyH5ZCR5a6D44CB5ZCO57ut5raI5oGv6LWw5o6n5Yi25bin5oqV5ZaC77yIYGFnZW50LmZvbGxvd3VwYO+8ie+8jFxuICAgICAqIOiAjOa1geW8j+S6i+S7tuS7jeS7jiBTREsg55qEIGBzZXNzaW9uLmV2ZW50YCDpgJrnn6Xlm57mnaXvvIjpgqPkuKrorqLpmIXopobnm5bov5DooYzml7bph4znmoQqKuaJgOaciSoq5Lya6K+d77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gc2Vzc2lvbklkIC0g5Lya6K+dIGlk77yb55yB55Wl5YiZ55So5b2T5YmN5Zue5pS+55qE6YKj5p2h44CCXG4gICAgICogQHJldHVybnMgYHtvaywgc2Vzc2lvbklkPywgZXJyb3I/fWDjgIJcbiAgICAgKi9cbiAgICBhc3luYyByZXN1bWVIaXN0b3J5KHNlc3Npb25JZD86IHN0cmluZyk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IHNlc3Npb25JZCA/PyB0aGlzLmhpc3RvcnlWaWV3Py5zZXNzaW9uSWQ7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5Y+v57un57ut55qE5Lya6K+d77yI5YWI5LuO44CM5Y6G5Y+y44CN6YeM5omT5byA5LiA5p2h77yJJyB9O1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2hpbGQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdhZ2VudCDmsqHlnKjot5Eg4oCU4oCUIOWFiOeCueOAjOWQr+WKqOOAjeWGjee7p+e7rei/meadoeS8muivnScgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gZ2V0U2V0dGluZ3MoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY2FsbENoaWxkKFxuICAgICAgICAgICAgICAgICdzZXNzaW9uL3Jlc3VtZScsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBzZXNzaW9uSWQ6IHRhcmdldCxcbiAgICAgICAgICAgICAgICAgICAgcHJvdmlkZXI6IHNldHRpbmdzLnByb3ZpZGVyLFxuICAgICAgICAgICAgICAgICAgICBtb2RlbDogc2V0dGluZ3MubW9kZWwsXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbmluZ0VmZm9ydDogc2V0dGluZ3MucmVhc29uaW5nRWZmb3J0IHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgbWF4VG9rZW5zOiBzZXR0aW5ncy5tYXhUb2tlbnMgPiAwID8gc2V0dGluZ3MubWF4VG9rZW5zIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgMTgwXzAwMCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25JZCA9IHRhcmdldDtcbiAgICAgICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAncmVzdW1lZCc7XG4gICAgICAgICAgICBpZiAodGhpcy5oaXN0b3J5VmlldykgdGhpcy5oaXN0b3J5VmlldyA9IHsgLi4udGhpcy5oaXN0b3J5Vmlldywgc2Vzc2lvbklkOiB0YXJnZXQsIGxpdmU6IHRydWUgfTtcbiAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlzdG9yeVZpZXcgPSB7IHNlc3Npb25JZDogdGFyZ2V0LCB0aXRsZTogJyjmnKrlm57mlL4pJywgY3JlYXRlZEF0OiBudWxsLCBtZXNzYWdlQ291bnQ6IDAsIGxpdmU6IHRydWUgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgICAgICdub3RlJyxcbiAgICAgICAgICAgICAgICBg5bey5o6l5LiK5Lya6K+dICR7dGFyZ2V0LnNsaWNlKDAsIDgpfeKApu+8iGFnZW50ICR7U3RyaW5nKHJlc3VsdC5hZ2VudElkID8/ICc/Jykuc2xpY2UoMCwgOCl94oCm77yJ4oCU4oCUYCArXG4gICAgICAgICAgICAgICAgICAgICfmjqXkuIvmnaXnmoTmtojmga/kvJrluKbnnYDlroPnmoTkuIrkuIvmlofjgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIC8vIOaOpeS4iueahOi/meadoeS8muivneacieiHquW3seeahOeUqOmHj+iusOW9le+8iOe8k+WtmOaMieS8muivnSBpZCDlrZjvvInvvIznq4vliLvmjaLmiJDlroPnmoRcbiAgICAgICAgICAgIHZvaWQgdGhpcy5yZWZyZXNoVXNhZ2UoKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXNzaW9uSWQ6IHRhcmdldCB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRlc2NyaWJlKGVycm9yKTtcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdlcnJvcicsIGDnu6fnu63kvJror53lpLHotKXvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiAqKuWFqOaWh+aQnOe0oioq5omA5pyJ5Y6G5Y+y5Lya6K+d77yI6Z2i5p2/5Y6G5Y+y5oq95bGJ6YeM55qE44CM5pCc5YWo5paH44CN77yJ44CCXG4gICAgICpcbiAgICAgKiDnm7TmjqXor7vnm5jvvIhgc2Vzc2lvbi1sb2cuanMgc2VhcmNoYO+8ie+8jOaJgOS7pSAqKmFnZW50IOayoeWcqOi3keS5n+iDveaQnCoq77yb5Luj5Lu35piv5a6DXG4gICAgICog5piv44CM5a2X6Z2i5a2Q5Liy5omr5o+PICsg56Gs6aKE566X44CN77yM5YGc5LiL5p2l5pe2Kirmm7TogIHnmoTkvJror53msqHnnIsqKiDigJTigJQg6L+Z5LiA54K55b+F6aG75Y6f5qC3XG4gICAgICog6L2s57uZ6Z2i5p2/77yIYHBhcnRpYWxgIC8gYHN0b3BwZWRCeWAgLyBgc2Nhbm5lZGAgLyBgYXZhaWxhYmxlYCDkuIDkuKrpg73kuI3orrjlkJ7vvInjgIJcbiAgICAgKlxuICAgICAqIOS4uuS7gOS5iOS4jeiuqemdouadv+ebtOaOpeivtOOAjOaJvuWIsCBOIOadoeOAjeWwseWujOS6i++8muaQnOe0ouaYr+WUr+S4gOS8muiuqeeUqOaItyoq55u45L+h57uT6K66KirnmoTlip/og73vvIxcbiAgICAgKiDjgIzlj6rmiavkuoYgNiDkuKrkvJror53ljbTor7Tmib7liLDkuoYgMyDmnaHjgI3lkozjgIzmiavkuoblhajpg6ggMTA3IOS4quOAjeaYr+WujOWFqOS4jeWQjOeahOS4pOS7tuS6i+OAglxuICAgICAqXG4gICAgICogQHBhcmFtIHF1ZXJ5IC0g5p+l6K+i5Liy77yI56m655m95YiH5oiQ5aSa5Liq6K+N77yM6K+N5LmL6Ze0IEFORO+8ieOAglxuICAgICAqIEBwYXJhbSBvcHRpb25zIC0g6aKE566X77yI6Z2i5p2/5LiN5Lyg5bCx55So6ISa5pys55qE6buY6K6k5YC877yJ44CCXG4gICAgICogQHJldHVybnMg5ZG95Lit5YiX6KGo5LiO6KaG55uW546H44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeVNlYXJjaChxdWVyeTogc3RyaW5nLCBvcHRpb25zOiBIaXN0b3J5U2VhcmNoT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxIaXN0b3J5U2VhcmNoVmlldz4ge1xuICAgICAgICBpZiAoIXRoaXMucnVudGltZS5ub2RlRXhlKSB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShnZXRTZXR0aW5ncygpKTtcbiAgICAgICAgY29uc3QgY3dkID0gZ2V0U2V0dGluZ3MoKS53b3JrZGlyIHx8IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgc2VhcmNoSGlzdG9yeSh0aGlzLnJ1bnRpbWUubm9kZUV4ZSwgY3dkLCBxdWVyeSwgb3B0aW9ucyk7XG4gICAgICAgIGlmICghZm91bmQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGZvdW5kLmVycm9yIH07XG5cbiAgICAgICAgLy8g5Y+q5YGa5b2i54q25pS25pWb77yI6ISa5pys6YKj6L655bey57uP5piv57uZ5Lq655yL55qE5b2i54q25LqG77yJ77yM5LiN5YGa6K+t5LmJ5Yik5patXG4gICAgICAgIGNvbnN0IGhpdHM6IEhpc3RvcnlTZWFyY2hIaXRWaWV3W10gPSAoZm91bmQuaGl0cyA/PyBbXSkubWFwKChyYXcpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHNuaXBwZXRzID0gQXJyYXkuaXNBcnJheShyYXcuc25pcHBldHMpID8gKHJhdy5zbmlwcGV0cyBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4pIDogW107XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGlkOiBTdHJpbmcocmF3LmlkID8/ICcnKSxcbiAgICAgICAgICAgICAgICB0aXRsZTogdHlwZW9mIHJhdy50aXRsZSA9PT0gJ3N0cmluZycgPyByYXcudGl0bGUgOiAnJyxcbiAgICAgICAgICAgICAgICBjcmVhdGVkQXQ6IHR5cGVvZiByYXcuY3JlYXRlZEF0ID09PSAnbnVtYmVyJyA/IHJhdy5jcmVhdGVkQXQgOiBudWxsLFxuICAgICAgICAgICAgICAgIHVwZGF0ZWRBdDogdHlwZW9mIHJhdy51cGRhdGVkQXQgPT09ICdudW1iZXInID8gcmF3LnVwZGF0ZWRBdCA6IDAsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IHR5cGVvZiByYXcuYnl0ZXMgPT09ICdudW1iZXInID8gcmF3LmJ5dGVzIDogMCxcbiAgICAgICAgICAgICAgICB0dXJuczogdHlwZW9mIHJhdy50dXJucyA9PT0gJ251bWJlcicgPyByYXcudHVybnMgOiAwLFxuICAgICAgICAgICAgICAgIGhpdHM6IHR5cGVvZiByYXcuaGl0cyA9PT0gJ251bWJlcicgPyByYXcuaGl0cyA6IDAsXG4gICAgICAgICAgICAgICAgc2VxOiB0eXBlb2YgcmF3LnNlcSA9PT0gJ251bWJlcicgPyByYXcuc2VxIDogMCxcbiAgICAgICAgICAgICAgICBzbmlwcGV0czogc25pcHBldHMubWFwKFxuICAgICAgICAgICAgICAgICAgICAoc25pcHBldCk6IEhpc3RvcnlTbmlwcGV0VmlldyA9PiAoe1xuICAgICAgICAgICAgICAgICAgICAgICAgcm9sZTogU3RyaW5nKHNuaXBwZXQucm9sZSA/PyAnJyksXG4gICAgICAgICAgICAgICAgICAgICAgICBsYWJlbDogdHlwZW9mIHNuaXBwZXQubGFiZWwgPT09ICdzdHJpbmcnID8gc25pcHBldC5sYWJlbCA6IFN0cmluZyhzbmlwcGV0LnJvbGUgPz8gJycpLFxuICAgICAgICAgICAgICAgICAgICAgICAgc2VxOiB0eXBlb2Ygc25pcHBldC5zZXEgPT09ICdudW1iZXInID8gc25pcHBldC5zZXEgOiAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgc25pcHBldDogdHlwZW9mIHNuaXBwZXQuc25pcHBldCA9PT0gJ3N0cmluZycgPyBzbmlwcGV0LnNuaXBwZXQgOiAnJyxcbiAgICAgICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIHF1ZXJ5OiBmb3VuZC5xdWVyeSxcbiAgICAgICAgICAgIGhpdHMsXG4gICAgICAgICAgICBzY2FubmVkOiBmb3VuZC5zY2FubmVkLFxuICAgICAgICAgICAgYXZhaWxhYmxlOiBmb3VuZC5hdmFpbGFibGUsXG4gICAgICAgICAgICBwYXJ0aWFsOiBmb3VuZC5wYXJ0aWFsID09PSB0cnVlLFxuICAgICAgICAgICAgc3RvcHBlZEJ5OiBmb3VuZC5zdG9wcGVkQnkgPz8gbnVsbCxcbiAgICAgICAgICAgIGVsYXBzZWRNczogZm91bmQuZWxhcHNlZE1zLFxuICAgICAgICAgICAgc2Nhbm5lZEJ5dGVzOiBmb3VuZC5zY2FubmVkQnl0ZXMsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5oqK5LiA5p2h5Lya6K+d5a+85Ye65oiQ5paH5Lu277yIYG1kYCDovazlhpkgLyBganNvbmxgIOWOn+agt+aXpeW/lyAvIGB6aXBgIOWvuem9kCBEU0gg5a6Y5pa56YKj5LiA5Lu977yJ44CCXG4gICAgICpcbiAgICAgKiDlhpnlnKjlk6rjgIHkuLrku4DkuYjkuI3lhpnov5vlt6XnqIsg4oCU4oCUIOingSBgaGlzdG9yeS50c2Ag55qEIGBleHBvcnRIaXN0b3J5YOOAglxuICAgICAqIOWvvOWHuui/meS7tuS6iyoq5LiN5YaZ6L+b5Lya6K+d5pel5b+XKirvvIjovazlhpnph4zpgqPooYwgbm90ZSDlj6rlnKjmnKzpnaLmnb/lhoXlrZjph4zvvInvvIzmiYDku6VcbiAgICAgKiDjgIzmiJHlr7zlh7rov4fjgI3kuI3kvJrlj5jmiJDmqKHlnovkuIrkuIvmlofnmoTkuIDpg6jliIbjgIJcbiAgICAgKlxuICAgICAqIGB6aXBgIOmCo+S4gOi3ryoq5LiO5Y+m5aSW5Lik5p2h5LiN5piv5LiA5Zue5LqLKirvvJrlroPluKblrZDlrZnkvJror53kuI7pmYTku7blg4/ntKDvvIzmiYDku6XmhaLvvIjopoHop6PljovlrZDlrZnml6Xlv5fjgIFcbiAgICAgKiDor7vkuIDloIbpmYTku7bvvInjgILovazlhpnph4zpgqPooYwgbm90ZSDlm6DmraTopoHmiooqKuWtkOWtmeaVsO+8iHN1YmFnZW50IOS4jiBmb3JrIOWIhuW8gO+8iSoq44CBKirpmYTku7bmlbAqKuOAgVxuICAgICAqIOS7peWPiioq6ISa5pys5Lqk5Luj55qE5rOo5oSP5LqL6aG5KirvvIjlsKTlhbbmmK/jgIzlvZPliY3mtLvot4PkvJror53lj6/og73lsJHmnIDlkI7lh6DmnaHjgI3vvInkuIDotbflhpnlh7rmnaUg4oCU4oCUXG4gICAgICog5LiN54S255So5oi35ou/5Yiw5LiA5LiqIHppcCDmoLnmnKzkuI3nn6XpgZPph4zpnaLmnInku4DkuYjjgIHkuZ/kuI3nn6XpgZPlroPkuLrku4DkuYjkuI3lrozmlbTjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAgICAgKiBAcGFyYW0gZm9ybWF0IC0gYG1kYCAvIGBqc29ubGAgLyBgemlwYOOAglxuICAgICAqIEByZXR1cm5zIOWGmeWHuueahOi3r+W+hOS4juS9k+enr+OAglxuICAgICAqL1xuICAgIGFzeW5jIGhpc3RvcnlFeHBvcnQoc2Vzc2lvbklkOiBzdHJpbmcsIGZvcm1hdDogSGlzdG9yeUV4cG9ydEZvcm1hdCA9ICdtZCcpOiBQcm9taXNlPEhpc3RvcnlFeHBvcnRWaWV3PiB7XG4gICAgICAgIGlmICghdGhpcy5ydW50aW1lLm5vZGVFeGUpIHRoaXMucnVudGltZSA9IHJlc29sdmVSdW50aW1lKGdldFNldHRpbmdzKCkpO1xuICAgICAgICBjb25zdCBjd2QgPSBnZXRTZXR0aW5ncygpLndvcmtkaXIgfHwgRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQudHJpbSgpIDogJyc7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaGlzdG9yeS1leHBvcnTvvJrnvLrlsJEgc2Vzc2lvbklkJyB9O1xuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4cG9ydEhpc3RvcnkodGhpcy5ydW50aW1lLm5vZGVFeGUsIGN3ZCwgdGFyZ2V0LCBmb3JtYXQpO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgYOWvvOWHuuS8muivneWksei0pe+8miR7cmVzdWx0LmVycm9yID8/ICfmnKrnn6Xljp/lm6AnfWApO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcmVzdWx0LmVycm9yIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgd2hhdCA9IHJlc3VsdC5mb3JtYXQgPT09ICdqc29ubCcgPyAn5Y6f5qC35pel5b+XJyA6IHJlc3VsdC5mb3JtYXQgPT09ICd6aXAnID8gJ1pJUO+8iOWQq+WtkOS8muivneS4jumZhOS7tu+8iScgOiAn6L2s5YaZJztcbiAgICAgICAgdGhpcy5hcHBlbmQoXG4gICAgICAgICAgICAnbm90ZScsXG4gICAgICAgICAgICBg5bey5a+85Ye65Lya6K+dICR7U3RyaW5nKHJlc3VsdC5pZCA/PyB0YXJnZXQpLnNsaWNlKDAsIDgpfeKApu+8iCR7d2hhdH0gwrcgYCArXG4gICAgICAgICAgICAgICAgYCR7cmVzdWx0LmV2ZW50cyA/PyAwfSDmnaEgwrcgJHtmb3JtYXRCeXRlcyhyZXN1bHQuYnl0ZXMgPz8gMCl977yJ4oaSICR7cmVzdWx0LnBhdGh9YCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHJlc3VsdC5zdWJhZ2VudHMpIHtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog4pqgICoqc3ViYWdlbnQg5LiOIGZvcmsg5YiG5byA6K+0KirvvJrkuKTogIXlnKjml6Xlv5flpLTph4znmoTliKTmja7kuI3lkIxcbiAgICAgICAgICAgICAqIO+8iGBvcmlnaW4gPT09ICdzdWJhZ2VudCdgIHZz44CM5pyJIHBhcmVudFNlc3Npb24g5L2G5rKh5pyJIG9yaWdpbuOAje+8ie+8jFxuICAgICAgICAgICAgICog6ICM44CM5ZCrIDUg5Liq5a2Q5Lya6K+d44CN6L+Z5Y+l6K+d6YeM77yM55So5oi355yf5q2j5YWz5b+D55qE5piv44CM5Yeg5Liq5piv5oiR5rS+5Ye65Y6755qEIGFnZW5044CN44CCXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGNvbnN0IHBhcnRzID0gW2DlrZDlrZkgJHtyZXN1bHQuc3ViYWdlbnRzLnRvdGFsfSDkuKpgXTtcbiAgICAgICAgICAgIHBhcnRzLnB1c2goYOWFtuS4reWtkCBhZ2VudCAke3Jlc3VsdC5zdWJhZ2VudHMuc3ViYWdlbnRDb3VudH0gwrcgZm9yayAke3Jlc3VsdC5zdWJhZ2VudHMuZm9ya0NvdW50fWApO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5zdWJhZ2VudHMubWF4RGVwdGggIT09IG51bGwpIHBhcnRzLnB1c2goYOacgOa3seesrCAke3Jlc3VsdC5zdWJhZ2VudHMubWF4RGVwdGh9IOWxgmApO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5zdWJhZ2VudHMuZGFuZ2xpbmcubGVuZ3RoID4gMCkgcGFydHMucHVzaChg5pyJICR7cmVzdWx0LnN1YmFnZW50cy5kYW5nbGluZy5sZW5ndGh9IOS4queahOeItue6p+WcqOe0ouW8lemHjOaJvuS4jeWIsGApO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5zdWJhZ2VudHMuaW5jb21wbGV0ZSkgcGFydHMucHVzaCgn57Si5byV5omr5o+P6LaF5LqG6aKE566X77yM5a2Q5a2Z5Y+v6IO95LiN5YWoJyk7XG4gICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGBaSVAg6YeM55qE5Lya6K+d77yaJHtwYXJ0cy5qb2luKCcgwrcgJyl9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5tZWRpYSkge1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoXG4gICAgICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgICAgIGBaSVAg6YeM55qE6ZmE5Lu277yaJHtyZXN1bHQubWVkaWEuY291bnR9IOS4qiR7cmVzdWx0Lm1lZGlhLm1pc3NpbmcgPiAwID8gYO+8iOWPpuaciSAke3Jlc3VsdC5tZWRpYS5taXNzaW5nfSDkuKrlvJXnlKjor7vkuI3liLDmlofku7bvvIlgIDogJyd9YCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8g6ISa5pys5Lqk5Luj55qE6K+d77yI5rS76LeD5Lya6K+d5Y+v6IO95bCR5pyA5ZCO5Yeg5p2hIC8g57y65aqS5L2TIC8g57Si5byV6LaF6aKE566X77yJ4oCU4oCUIOWOn+agt+aQrOi/m+i9rOWGmVxuICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVzdWx0Lm5vdGVzID8/IFtdKSB0aGlzLmFwcGVuZCgnbm90ZScsIGDlr7zlh7ror7TmmI7vvJoke2xpbmV9YCk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5Yig5o6J5LiA5p2h5Y6G5Y+y5Lya6K+d77yIKirlhYggZHJ5LXJ1biDmi7/muIXljZXvvIzlho3nnJ/liKAqKu+8ieOAglxuICAgICAqXG4gICAgICog5Zub5p2h5a6I5Y2r77yI6YO95Zyo6L+Z5LiA5bGC77yM5Zug5Li65Y+q5pyJ6L+Z6YeM55+l6YGT6L+Q6KGM5pe255qE54q25oCB77yJ77yaXG4gICAgICogMS4gKiphZ2VudCDlvZPliY3mraPlnKjnlKjnmoTpgqPmnaHkuI3orrjliKAqKiDigJTigJQg6L+Q6KGM5pe25omL6YeM5pSl552A5a6D77yM5LiL5LiA5qyh6JC955uY5Lya5oqK55uu5b2VXG4gICAgICogICAgKirph43mlrDlu7rlh7rmnaUqKu+8iOihqOeOsOWwseaYr+OAjOWIoOS6huS9huWug+WPiOWbnuadpeS6huOAje+8ie+8m1xuICAgICAqIDIuIOmdouadv+ato+WPquivu+WbnuaUvueahOmCo+adoeWPr+S7peWIoO+8jOS9huWIoOWujOimgeaKiuWvueivneWMuua4heaOie+8iOWQpuWImeWBnOWcqOS4gOS7veW3sue7j+S4jeWtmOWcqOeahOWGheWuueS4iu+8ie+8m1xuICAgICAqIDMuIOm7mOiupCoq5LiN5Yqo6ZmE5Lu2Kiog4oCU4oCUIOWbvueJh+aMieWGheWuueWtmOWcqCBgPERTSF9IT01FPi9hdHRhY2htZW50c2DvvIzot6jkvJror53ljrvph43lhbHnlKjvvJtcbiAgICAgKiA0LiDmiZPlvIAgYHJlY2xhaW1gIOaXtuaJjemhuuW4puWbnuaUtioq5YWo5bqT5bey5peg5byV55SoKirnmoTpmYTku7bvvJrlroPmmK8qKuWIhumSn+e6pyoq55qE77yMXG4gICAgICogICAg6ICM5LiU6LaF6aKE566X5bCxKirkuIDkuKrpg73kuI3mkKwqKu+8iGZhaWwtY2xvc2Vk77yM5Y+j5b6E5ZyoIGBoaXN0b3J5LnRzYCDkuI7ohJrmnKzph4zvvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAgICAgKiBAcGFyYW0gZHJ5UnVuIC0g5Y+q5oql5riF5Y2V77yI6Z2i5p2/55qE5LqM5qyh56Gu6K6k55So5a6D77yJ44CCXG4gICAgICogQHBhcmFtIHJlY2xhaW0gLSDpobrluKblm57mlLbml6DlvJXnlKjpmYTku7bvvIjpu5jorqTlhbPvvJtkcnktcnVuIOS5n+imgeW4puS4iu+8jOWQpuWImeeci+S4jeWIsOWAmemAieaVsO+8ieOAglxuICAgICAqIEByZXR1cm5zIOa4heWNlSAvIOaYr+WQpuecn+WIoOS6hu+8m2BjbGVhcmVkYCDooajnpLrpobrmiYvmuIXmjonkuobmraPlnKjlm57mlL7nmoTpgqPmnaHjgIJcbiAgICAgKi9cbiAgICBhc3luYyBoaXN0b3J5RGVsZXRlKHNlc3Npb25JZDogc3RyaW5nLCBkcnlSdW4gPSBmYWxzZSwgcmVjbGFpbSA9IGZhbHNlKTogUHJvbWlzZTxIaXN0b3J5RGVsZXRlVmlldz4ge1xuICAgICAgICBpZiAoIXRoaXMucnVudGltZS5ub2RlRXhlKSB0aGlzLnJ1bnRpbWUgPSByZXNvbHZlUnVudGltZShnZXRTZXR0aW5ncygpKTtcbiAgICAgICAgY29uc3QgY3dkID0gZ2V0U2V0dGluZ3MoKS53b3JrZGlyIHx8IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIXRhcmdldCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2hpc3RvcnktZGVsZXRl77ya57y65bCRIHNlc3Npb25JZCcgfTtcblxuICAgICAgICBpZiAodGFyZ2V0ID09PSB0aGlzLnNlc3Npb25JZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6ICfov5nmmK8gYWdlbnQg5b2T5YmN5q2j5Zyo55So55qE5Lya6K+dIOKAlOKAlCDlhYjlnKjpnaLmnb/kuIrngrnjgIzmlrDkvJror53jgI3vvIzlho3lm57mnaXliKDlroPvvIjkuI3nhLYgYWdlbnQg5LiL5LiA5qyh6JC955uY5Lya5oqK5a6D6YeN5paw5bu65Ye65p2l77yJJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB2aWV3aW5nID0gdGhpcy5oaXN0b3J5Vmlldz8uc2Vzc2lvbklkID09PSB0YXJnZXQ7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlbGV0ZUhpc3RvcnkodGhpcy5ydW50aW1lLm5vZGVFeGUsIGN3ZCwgdGFyZ2V0LCBkcnlSdW4sIHsgcmVjbGFpbUF0dGFjaG1lbnRzOiByZWNsYWltIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcmVzdWx0LmVycm9yIH07XG5cbiAgICAgICAgaWYgKGRyeVJ1bikgcmV0dXJuIHsgLi4ucmVzdWx0LCBjbGVhcmVkOiBmYWxzZSB9O1xuXG4gICAgICAgIGxldCBjbGVhcmVkID0gZmFsc2U7XG4gICAgICAgIGlmICh2aWV3aW5nKSB7XG4gICAgICAgICAgICAvLyDpnaLmnb/mraPmmL7npLrov5nmnaHvvIjlj6ror7vlm57mlL7vvInvvJrmuIXmjonvvIzlm57liLDjgIznqbrkvJror53jgI3nirbmgIFcbiAgICAgICAgICAgIHRoaXMuaGlzdG9yeVZpZXcgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5zZXNzaW9uS2luZCA9ICdzZGsnO1xuICAgICAgICAgICAgdGhpcy5yZXNldFRyYW5zY3JpcHQoKTtcbiAgICAgICAgICAgIGNsZWFyZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgYOW3suWIoOmZpOWOhuWPsuS8muivnSAke1N0cmluZyhyZXN1bHQuaWQgPz8gdGFyZ2V0KS5zbGljZSgwLCA4KX3igKbvvIgke3Jlc3VsdC5maWxlQ291bnQgPz8gMH0g5Liq5paH5Lu2IMK3IGAgK1xuICAgICAgICAgICAgICAgIGAke2Zvcm1hdEJ5dGVzKHJlc3VsdC5ieXRlcyA/PyAwKX3vvInjgILlm77niYfpmYTku7bmmK/lhajlsYDljrvph43nmoTvvIwqKuS4jemaj+S8muivneWIoOmZpCoq44CCYCxcbiAgICAgICAgKTtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOmZhOS7tuWbnuaUtumCo+S4gOi2n+eahOe7k+aenO+8mioq5LiJ5Y+l6K+d6YO96KaB6K+0KirvvIjlgJnpgInlh6DkuKogLyDmkKzkuoblh6DkuKogLyDmnInmsqHmnInooqvpooTnrpfmiKrmlq3vvInvvIxcbiAgICAgICAgICog5Zug5Li66L+Z5LiA5Z2X5pyA5a655piT6K6p5Lq66K+v5Lya5oiQ44CM5LiA6ZSu6IW+56m66Ze044CN77yaXG4gICAgICAgICAqIOacrOacuuWunua1iyA3OTcg5Liq5a+56LGhKirlhajpg73ooqvlvJXnlKgqKu+8jOaJgOS7peato+W4uOaDheWGteS4iyBgb3JwaGFuc2Ag5bCx5pivIDAg4oCU4oCUXG4gICAgICAgICAqIOS4jeivtOOAjOWAmemAiemHjOacieWHoOS4qui/mOiiq+WIq+S6uuW8leeUqOedgOOAje+8jOeUqOaIt+S8muS7peS4uuWKn+iDveWdj+S6huOAglxuICAgICAgICAgKi9cbiAgICAgICAgaWYgKHJlc3VsdC5yZWNsYWltKSB7XG4gICAgICAgICAgICBjb25zdCByID0gcmVzdWx0LnJlY2xhaW07XG4gICAgICAgICAgICB0aGlzLmFwcGVuZChcbiAgICAgICAgICAgICAgICAnbm90ZScsXG4gICAgICAgICAgICAgICAgYOmZhOS7tuWbnuaUtu+8muWAmemAiSAke3IuY2FuZGlkYXRlc30g5Liq77yI6L+Z5p2h5Lya6K+d5byV55So55qE77yJ4oaSIOWFtuS4rSAke3IucmVmZXJlbmNlZH0g5Liq5LuN6KKr5Yir55qE5Lya6K+d5byV55So44CBYCArXG4gICAgICAgICAgICAgICAgICAgIGAke3Iub3JwaGFuc30g5Liq5bey5peg5byV55SoIOKGkiDmkKzov5vlopPnopEgJHtyLnRyYXNoZWR9IOS4qu+8iCR7Zm9ybWF0Qnl0ZXMoci5ieXRlc0ZyZWVkKX3vvInjgIJgICtcbiAgICAgICAgICAgICAgICAgICAgYOWFqOW6k+aJq+S6hiAke3Iuc2Nhbm5lZC5zZXNzaW9uc30g5p2h5Lya6K+d77yIJHtmb3JtYXRCeXRlcyhyLnNjYW5uZWQuYnl0ZXMpfSAvICR7TWF0aC5yb3VuZChyLnNjYW5uZWQuZWxhcHNlZE1zIC8gMTAwMCl9IOenku+8ieOAgmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHIuaW5jb21wbGV0ZSkge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgICAgICAgICAnZXJyb3InLFxuICAgICAgICAgICAgICAgICAgICBg6ZmE5Lu25Zue5pS2KirkuIDkuKrpg73msqHmkKwqKu+8muWFqOW6k+aJq+aPj+ayoeaJq+WujO+8iCR7ci5pbmNvbXBsZXRlUmVhc29uID8/ICfotoXpooTnrpcnfe+8ieKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAgICAgICAgICfov5nmmK/mnInmhI/nmoTvvIjliKTmja7kuI3lhajml7bor6/liKDkuI3lj6/pgIbvvInvvIzkvJror53mnKzouqvlt7Lnu4/liKDmjonkuobjgIInLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHIudHJhc2hlZCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgICAgICAgICAnbm90ZScsXG4gICAgICAgICAgICAgICAgICAgICfov5nmrKHmsqHmnInlj6/lm57mlLbnmoTpmYTku7bvvIjlgJnpgInph4zmr4/kuIDkuKrpg73ov5jooqvliKvnmoTkvJror53lvJXnlKjnnYDvvInigJTigJQg6ZmE5Lu25piv5LiN5Y+v6YeN5bu655qE77yM5omA5Lul5Zue5pS25Y+q5pCsXCLlhajlupPpg73lvJXnlKjkuI3liLBcIueahOmCo+WHoOS4quOAgicsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIOiiq+WQpuWGs+eahOWAmemAie+8iGhhc2gg5LiN56ymIC8g5pe26Ze056qXIC8g6K+75LiN5Yiw4oCm77yJ77ya5YmN5Yeg5p2h5YiX5Ye65p2l77yM5Yir6K6p5a6D6Z2Z6buYXG4gICAgICAgICAgICBjb25zdCBza2lwcGVkID0gci5za2lwcGVkLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnJlYXNvbiAhPT0gJ3N0aWxsLXJlZmVyZW5jZWQnKTtcbiAgICAgICAgICAgIGlmIChza2lwcGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZChcbiAgICAgICAgICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgICAgICAgICBg5Zue5pS25pe26Lez6L+HICR7c2tpcHBlZC5sZW5ndGh9IOS4qu+8iOS4jeaYr1wi6L+Y5Zyo55SoXCLvvIzmmK/liKvnmoTlrojljavmi6bkuIvnmoTvvInvvJpgICtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNraXBwZWQuc2xpY2UoMCwgNCkubWFwKChlbnRyeSkgPT4gYCR7ZW50cnkuaWQuc2xpY2UoMCwgMTQpfeKApu+8iCR7ZW50cnkucmVhc29ufe+8iWApLmpvaW4oJ+OAgScpLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBjbGVhcmVkIH07XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDnlKjph49cblxuICAgIC8qKlxuICAgICAqIOivu+S4gOasoeW9k+WJjeS8muivneeahCoq6K+75pWwKirvvJrnlKjph4/vvIh0b2tlbiDntK/orqEgLyDkuIrkuIvmlofljaDnlKggLyDoirHotLnvvIkrIOi/m+W6pu+8iOa4heWNlSAvIOebruaghyAvIOWbnuWQiOebruW9le+8ieOAglxuICAgICAqXG4gICAgICog6K+755qE5pivICoqRFNIIOeahOS8muivneaKleW9see8k+WtmCoq77yIYDxEU0hfSE9NRT4vc3RvcmFnZXMvc2Vzc2lvbl9wcm9qY2FjaGUvc2Vzc2lvbnMvPGlkPi5qc29uYO+8ieKAlOKAlFxuICAgICAqIOS4jeaYr+mXriBhZ2VudCDopoHnmoTvvJpTREsg5Y2P6K6u6YeM5rKh5pyJ5oqV5b2x6K+75Y+W77yMYGN0eC50b2tlbk1ldGVyYCDkuZ/lj6rmnInlrr/kuLvov5vnqIvlhoXnmoTmj5Lku7bmi7/lvpfliLDjgIJcbiAgICAgKiDov5nmmK8qKuaYjuaWhyBKU09OKirvvIzmiYDku6XkuLvov5vnqIvnm7TmjqXor7vnm5jvvIzov57pgqPkuKrlpJbpg6ggbm9kZSDpg73kuI3pnIDopoHjgIJcbiAgICAgKlxuICAgICAqIOS4pOi+uSoq5LiA6LW36K+744CB5LiA6LW35ZueKirvvJrlkIzkuIDku73mlofku7bvvIjkuIDmrKHop6PmnpDvvInvvIzlkIzkuIDnu4TmlrDpspzluqbkuovlrp7vvIjmsLTkvY0gLyDokL3lkI4gLyDlhpnkuo7kvZXml7bvvInigJTigJRcbiAgICAgKiDliIblvIDor7vkvJrlh7rnjrDjgIznlKjph4/or7TokL3lkI4gMTIg5p2h44CB6L+b5bqm6K+06JC95ZCOIDMg5p2h44CN6L+Z56eN6Ieq55u455+b55u+55qE55S76Z2i44CCXG4gICAgICpcbiAgICAgKiDlm5vmnaHlj6PlvoTvvIjpg73opoHljp/moLfovaznu5npnaLmnb/vvIzkuIDmnaHpg73kuI3orrjlkJ7vvInvvJpcbiAgICAgKiAxLiAqKuivu+Wksei0pSDiiaAg5rKh5pyJ6K+75pWwKiog4oCU4oCUIOWJjeiAheaYryBlcnJvcuOAgeWQjuiAheaYr+i/meS4quS8muivnei/mOayoeiQvei/h+ajgOafpeeCue+8jOmdouadv+S4iuaYr+S4pOWPpeivne+8m1xuICAgICAqIDIuICoq5Y+q6K+75LiN562J5LqO5a6e5pe2Kiog4oCU4oCUIOiusOW9leW4pioq5rC05L2NKirvvIhgc2VxYO+8ie+8jOaIkeS7rOaKiuW9k+WJjeWunuaXtuawtOS9jeS4gOi1t+mAkuS4i+WOu+eulyBgYmVoaW5kYO+8m1xuICAgICAqIDMuICoq6Z2i5p2/5q2j5Y+q6K+75Zue5pS+5Y6G5Y+y5Lya6K+d5pe277yM6K+755qE5piv6YKj5p2h5Lya6K+dKiog4oCU4oCUIOS4jeeEtuS8muaLv+a0u+S8muivneeahOaVsOWtl+WOu+mFjeWOhuWPsueahOi9rOWGme+8m1xuICAgICAqIDQuICoq6L+b5bqm6YKj5LiA5Y2K5Y2V54us5aSx6LSl5LiN566X5pW05Lu95aSx6LSlKiog4oCU4oCUIOe8k+WtmOmHjOayoeaciei/m+W6puihjOaXtuivtOOAjOi/meS4gOWdl+ayoeacieOAje+8jFxuICAgICAqICAgIOiAjOS4jeaYr+aKiueUqOmHj+S4gOi1t+ivtOaIkOOAjOivu+Wksei0peOAje+8iOeUqOmHj+WGs+Wumumdouadv+S4iumCo+mil+WNoOeUqOeOhyBjaGlwIOaYvuS4jeaYvuekuu+8ieOAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtvaywgdXNhZ2UsIG5vdGUsIHByb2dyZXNzLCBwcm9ncmVzc05vdGV9YO+8m+Wksei0peS4jeaKm+OAglxuICAgICAqL1xuICAgIGFzeW5jIHJlZnJlc2hVc2FnZSgpOiBQcm9taXNlPHtcbiAgICAgICAgb2s6IGJvb2xlYW47XG4gICAgICAgIHVzYWdlOiBTZXNzaW9uVXNhZ2UgfCBudWxsO1xuICAgICAgICBub3RlOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICBwcm9ncmVzczogUHJvZ3Jlc3NWaWV3IHwgbnVsbDtcbiAgICAgICAgcHJvZ3Jlc3NOb3RlOiBzdHJpbmcgfCBudWxsO1xuICAgIH0+IHtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gdGhpcy5oaXN0b3J5Vmlldz8uc2Vzc2lvbklkID8/IHRoaXMuc2Vzc2lvbklkO1xuICAgICAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICAgICAgdGhpcy5hcHBseVVzYWdlKG51bGwsICfov5jmsqHmnInkvJror50g4oCU4oCUIGFnZW50IOWQr+WKqOOAgeWPkeWHuuesrOS4gOadoea2iOaBr+S5i+WQjuaJjeacieeUqOmHj+OAgicpO1xuICAgICAgICAgICAgdGhpcy5hcHBseUNoZWNrcG9pbnRQcm9ncmVzcyhudWxsLCBudWxsLCAn6L+Y5rKh5pyJ5Lya6K+dIOKAlOKAlCDov5vluqbopoHnrYkgYWdlbnQg6LW36L+H44CB5Lya6K+d6JC96L+H5qOA5p+l54K55omN5pyJ44CCJyk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHVzYWdlOiBudWxsLCBub3RlOiB0aGlzLnVzYWdlTm90ZSwgcHJvZ3Jlc3M6IG51bGwsIHByb2dyZXNzTm90ZTogdGhpcy5wcm9ncmVzc05vdGUgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQ6IFNlc3Npb25DYWNoZVJlc3VsdDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHJlYWRTZXNzaW9uQ2FjaGUodGFyZ2V0LCB7XG4gICAgICAgICAgICAgICAgbGl2ZVNlcTogdGhpcy5sYXN0RXZlbnRTZXEgPiAwID8gdGhpcy5sYXN0RXZlbnRTZXEgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9IHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoZXJyb3IpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5vayAhPT0gdHJ1ZSB8fCAhcmVzdWx0LnVzYWdlKSB7XG4gICAgICAgICAgICB0aGlzLmFwcGx5VXNhZ2UobnVsbCwgcmVzdWx0LmVycm9yID8/ICfor7vnlKjph4/lpLHotKUnKTtcbiAgICAgICAgICAgIHRoaXMuYXBwbHlDaGVja3BvaW50UHJvZ3Jlc3MobnVsbCwgbnVsbCwgcmVzdWx0LmVycm9yID8/ICfor7vov5vluqblpLHotKUnKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgdXNhZ2U6IG51bGwsIG5vdGU6IHRoaXMudXNhZ2VOb3RlLCBwcm9ncmVzczogbnVsbCwgcHJvZ3Jlc3NOb3RlOiB0aGlzLnByb2dyZXNzTm90ZSB9O1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYXBwbHlVc2FnZShyZXN1bHQudXNhZ2UsIG51bGwpO1xuICAgICAgICAvKipcbiAgICAgICAgICog6L+b5bqm6YKj5LiA5Y2KKirljZXni6zlpLHotKXkuI3nrpfmlbTku73lpLHotKUqKu+8iGByZWFkU2Vzc2lvbkNhY2hlYCDkuZ/mmK/ov5nkuYjliIbnmoTvvInvvJpcbiAgICAgICAgICog57yT5a2Y6YeM5rKh5pyJ6L+b5bqm6KGM5pe26K+044CM6L+Z5Z2X5rKh5pyJ44CN77yM6ICM5LiN5piv5oqK55So6YeP5LiA6LW36K+05oiQ44CM6K+75aSx6LSl44CN44CCXG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmFwcGx5Q2hlY2twb2ludFByb2dyZXNzKFxuICAgICAgICAgICAgcmVzdWx0LnByb2dyZXNzID8/IG51bGwsXG4gICAgICAgICAgICByZXN1bHQudXNhZ2UsXG4gICAgICAgICAgICByZXN1bHQucHJvZ3Jlc3MgPyBudWxsIDogJ+i/meS7vee8k+WtmOiusOW9lemHjOayoeaciei/m+W6pumCo+WHoOihjO+8iOa4heWNlSAvIOebruaghyAvIOWbnuWQiOWkp+e6su+8ieOAgicsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB1c2FnZTogdGhpcy51c2FnZSwgbm90ZTogbnVsbCwgcHJvZ3Jlc3M6IHRoaXMucHJvZ3Jlc3NWaWV3KCksIHByb2dyZXNzTm90ZTogdGhpcy5wcm9ncmVzc05vdGUgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDmjaLkuIDku73nlKjph4/jgIJcbiAgICAgKlxuICAgICAqIOWGheWuueS4gOagt+WwseS4gOS4quWtl+iKgumDveS4jeWKqO+8mui/meS4quWHveaVsOS8muWcqOOAjOWbnuWQiOe7k+adn+OAjeOAjOi3keWujOWRveS7pOOAjeOAjOmdouadv+eCueWIt+aWsOOAjeS4ieWkhOiiq+iwg++8jFxuICAgICAqIOiAjOWkmuaVsOaXtuWAmeivu+WIsOeahOaYr+WQjOS4gOS7veaVsOWtlyDigJTigJQg55m95bm/5pKt5LiA5qyh5Lya6K6p6Z2i5p2/5peg6LCT5Zyw6YeN55S75LiA6YGN5oq95bGJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBhcHBseVVzYWdlKG5leHQ6IFNlc3Npb25Vc2FnZSB8IG51bGwsIG5vdGU6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgICAgICAgY29uc3Qgc2FtZSA9IHRoaXMudXNhZ2VOb3RlID09PSBub3RlICYmIEpTT04uc3RyaW5naWZ5KHRoaXMudXNhZ2UpID09PSBKU09OLnN0cmluZ2lmeShuZXh0KTtcbiAgICAgICAgdGhpcy51c2FnZSA9IG5leHQ7XG4gICAgICAgIHRoaXMudXNhZ2VOb3RlID0gbm90ZTtcbiAgICAgICAgaWYgKHNhbWUpIHJldHVybjtcbiAgICAgICAgdGhpcy51c2FnZURpcnR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5o6S5LiA5qyh44CM5pma5LiA54K56K+755So6YeP44CN44CC6buY6K6k5LiA5Liq54K577yM6LeR5pac5p2g5ZG95Luk5pe25Lik5Liq54K577yI6KeB5bi46YeP5LiK55qE5rOo6YeK77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gZGVsYXlzIC0g55u45a+5546w5Zyo55qE5q+r56eS5pWw77yI5Lya5YWI5riF5o6J5LiK5LiA5om577yM6YG/5YWN6L+e54K55pSS5Ye65LiA5aCG5a6a5pe25Zmo77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBzY2hlZHVsZVVzYWdlUmVmcmVzaChkZWxheXM6IG51bWJlcltdID0gW1VTQUdFX1JFRlJFU0hfREVMQVlfTVNdKTogdm9pZCB7XG4gICAgICAgIHRoaXMuY2xlYXJVc2FnZVRpbWVycygpO1xuICAgICAgICBmb3IgKGNvbnN0IGRlbGF5IG9mIGRlbGF5cykge1xuICAgICAgICAgICAgdGhpcy51c2FnZVRpbWVycy5wdXNoKFxuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB2b2lkIHRoaXMucmVmcmVzaFVzYWdlKCk7XG4gICAgICAgICAgICAgICAgfSwgTWF0aC5tYXgoMCwgZGVsYXkpKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKiog5riF5o6J5o6S552A55qE6K+755So6YeP5a6a5pe25Zmo77yI6K+75LmL5YmN5Lya5YWI5riF77yMYGNsZWFudXBgIOS5n+imgea4he+8ieOAgiAqL1xuICAgIHByaXZhdGUgY2xlYXJVc2FnZVRpbWVycygpOiB2b2lkIHtcbiAgICAgICAgZm9yIChjb25zdCB0aW1lciBvZiB0aGlzLnVzYWdlVGltZXJzKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB0aGlzLnVzYWdlVGltZXJzID0gW107XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDov5vluqZcbiAgICAvL1xuICAgIC8vIOS4ieWdl++8mioq5b6F5Yqe5riF5Y2VKirvvIhhZ2VudCDoh6rlt7HlhpnnmoTlt6XkvZzooajvvInjgIEqKuebruaghyoq44CBKirlm57lkIjnm67lvZUqKuOAglxuICAgIC8vXG4gICAgLy8g5ZCI5bm26KeE5YiZ5Y+q5pyJ5LiA5p2h77yaKirkuovku7bkvJjlhYjjgIHnvJPlrZjooaXmtJ4qKuOAguS4uuS7gOS5iOi/meadoeinhOWImeaYr+WvueeahO+8mlxuICAgIC8vIOS4pOi+ueaKmOeahOaYryoq5ZCM5LiA5Lu95LqL5Lu25pel5b+XKirvvIzlt67liKvlj6rlnKjjgIzmipjliLDnrKzlh6DmnaHjgI3igJTigJRcbiAgICAvLyAgIOS6i+S7tu+8mueyvuehru+8jOS9huWPquimhueblumdouadv+i9rOWGmeeql+WPo+mHjOmCo+S4gOaute+8iOWOhuWPsuWbnuaUvuWPquivu+aXpeW/l+WwvumDqOeahCAyMDAwIOadoeS6i+S7tu+8ie+8m1xuICAgIC8vICAg57yT5a2Y77ya5pW05Liq5pel5b+X77yI5Zue5ZCI5aSn57qy6L+eIDYwMCDmnaHnqpflj6PkuYvlpJbnmoTova7mrKHpg73mnInvvInvvIzkvYbmnIDlpJrokL3lkI4gMjAwIOadoeS6i+S7tiAvIDUg56eS44CCXG4gICAgLy8g5omA5Lul44CM5LqL5Lu26YeM5pyJ5bCx55So5LqL5Lu255qE44CN5rC46L+c5pu05o6l6L+R55yf55u477yb57yT5a2Y5Y+q5Zyo5LqL5Lu2KirmsqHmnIkqKui/meS4gOWdl+aXtuihpeS4ilxuICAgIC8vIO+8iOWFuOWei++8muacgOWQjumCo+asoSBgdG9kb193cml0ZWAg6JC95Zyo5Zue5pS+56qX5Y+j5LmL5aSW77yJ44CC5Lik6L656YO95pyJ6ICM5LiU5LiN5LiA5qC35pe2KiropoHor7Tlh7rmnaUqKu+8jFxuICAgIC8vIOS4jeiDvem7mOm7mOaMkeS4gOS4qiDigJTigJQg6YKj5q2j5piv44CM6Z2i5p2/55yL6LW35p2l5piv5a+555qE44CB5L2G5ZKMIGFnZW50IOiusOW+l+eahOS4jeS4gOagt+OAjeeahOadpea6kOOAglxuXG4gICAgLyoqXG4gICAgICog5pS25LiLKirnvJPlrZgqKue7meeahOmCo+S4gOWNiui/m+W6pu+8iGByZWZyZXNoVXNhZ2VgIOivu+WbnuadpeeahO+8ieOAglxuICAgICAqXG4gICAgICogQHBhcmFtIHByb2dyZXNzIC0g57yT5a2Y6YeM55qE6L+b5bqm77yb5b2i54q26K6k5LiN5Ye65pe25pivIG51bGzjgIJcbiAgICAgKiBAcGFyYW0gdXNhZ2UgLSDlkIzkuIDku73mlofku7bor7vlh7rmnaXnmoTnlKjph4/vvIjmsLTkvY0gLyDokL3lkI4gLyDlhpnkuo7kvZXml7bpg73lnKjlroPouqvkuIrvvInjgIJcbiAgICAgKiBAcGFyYW0gbm90ZSAtIOivu+Wksei0peaIluiAheOAjOi/meS7veiusOW9lemHjOayoeaciei/m+W6pumCo+WHoOihjOOAjeeahOWOn+WboOOAglxuICAgICAqL1xuICAgIHByaXZhdGUgYXBwbHlDaGVja3BvaW50UHJvZ3Jlc3MocHJvZ3Jlc3M6IFNlc3Npb25Qcm9ncmVzcyB8IG51bGwsIHVzYWdlOiBTZXNzaW9uVXNhZ2UgfCBudWxsLCBub3RlOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gICAgICAgIHRoaXMuY2hlY2twb2ludFRvZG9zID0gcHJvZ3Jlc3MgPyBwcm9ncmVzcy50b2RvcyA6IG51bGw7XG4gICAgICAgIHRoaXMuY2hlY2twb2ludEdvYWwgPSBwcm9ncmVzcyA/IHByb2dyZXNzLmdvYWwgOiBudWxsO1xuICAgICAgICB0aGlzLm91dGxpbmUgPSBwcm9ncmVzcyA/IHsgdHVybnM6IHByb2dyZXNzLnR1cm5zLCB0dXJuc1RvdGFsOiBwcm9ncmVzcy50dXJuc1RvdGFsLCBkcmFmdDogcHJvZ3Jlc3MuZHJhZnQgfSA6IG51bGw7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NTZXEgPSB1c2FnZT8uc2VxID8/IG51bGw7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NCZWhpbmQgPSB1c2FnZT8uYmVoaW5kID8/IG51bGw7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NVcGRhdGVkQXQgPSB1c2FnZT8udXBkYXRlZEF0ID8/IDA7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NOb3RlID0gbm90ZTtcbiAgICAgICAgaWYgKHByb2dyZXNzKSB0aGlzLnByb2dyZXNzU2VlbiA9IHRydWU7XG4gICAgICAgIHRoaXMudG91Y2hQcm9ncmVzcygpO1xuICAgIH1cblxuICAgIC8qKiDmlLbkuIvkuIDmnaEgYHRvZG8vd3JpdGVg77yI5pW05Lu95b+r54Wn77yM5pu/5o2i5o6J5LiK5LiA5Lu977yJ44CCICovXG4gICAgcHJpdmF0ZSBhcHBseUxpdmVUb2Rvcyh2YWx1ZTogdW5rbm93bik6IHZvaWQge1xuICAgICAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgLy8g6K6k5LiN5Ye655qE5p2h55uu77ya5a6B5bCR5LiN5YGH77yM5L2G6KaB6K+05Ye65p2l77yIbm90ZXMg5Lya6L+bIGBwcm9ncmVzc1ZpZXcoKS5ub3Rlc2DvvIlcbiAgICAgICAgdGhpcy50b2RvTm90ZXMgPSBub3RlcztcbiAgICAgICAgdGhpcy50b2RvcyA9IHBhcnNlVG9kb3ModmFsdWUsIG5vdGVzKTtcbiAgICAgICAgLy8g6K6w5LiL44CM6L+Z5LiA6L2u6YeM5YaZ55qE44CN77ybYGN1cnJlbnRUdXJuYCDkuLogMCA9IOi/mOayoeingeWIsCBgdHVybi9zdGFydGDvvIzpgqPlsLHmjInjgIzkuI3nn6XpgZPjgI3orrBcbiAgICAgICAgdGhpcy50b2Rvc1R1cm4gPSB0aGlzLmN1cnJlbnRUdXJuO1xuICAgICAgICB0aGlzLnRvdWNoUHJvZ3Jlc3MoKTtcbiAgICB9XG5cbiAgICAvKiog5pS25LiL5LiA5p2hIGBnb2FsL2NoYW5nZWDvvIjlrozmlbTlv6vnhafmiJblopPnopHvvInjgIIgKi9cbiAgICBwcml2YXRlIGFwcGx5TGl2ZUdvYWwodmFsdWU6IHVua25vd24pOiB2b2lkIHtcbiAgICAgICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIHRoaXMuZ29hbCA9IHBhcnNlR29hbENoYW5nZSh2YWx1ZSwgbm90ZXMpO1xuICAgICAgICB0aGlzLmdvYWxOb3RlcyA9IG5vdGVzO1xuICAgICAgICAvLyDimqAg6KeB6L+HIGBnb2FsL2NoYW5nZWAg5LmL5ZCO77yM44CM5rKh5pyJ55uu5qCH44CN5bCx5Y+Y5oiQKirkuovku7bor7TnmoQqKu+8iOWPr+iDveaYr+WImuiiq+a4heaOie+8ie+8jFxuICAgICAgICAvLyDkuI3og73lho3orqnnvJPlrZjph4zml6fnmoTpgqPkuIDku73nm5blm57mnaXjgIJcbiAgICAgICAgdGhpcy5nb2FsU2VlbiA9IHRydWU7XG4gICAgICAgIHRoaXMudG91Y2hQcm9ncmVzcygpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOiusOS4i+OAjOi/meS4gOi9ruWvueW6lOi9rOWGmemHjOeahOWTquS4gOadoeOAjeOAglxuICAgICAqXG4gICAgICogYHR1cm4vc3RhcnRgIOWIsOi+vuaXtui/mOS4jeefpemBk+esrOS4gOadoeadoeebruaYr+WHoOWPt++8iOeUqOaIt+a2iOaBr+i/mOayoeS4iuWxj++8ie+8jOaJgOS7peWFiOiusCoq5b6F57uRKipcbiAgICAgKiDnmoTova7mrKHvvIznrYnkuIvkuIDmrKEgYGFwcGVuZGAg5YaN57uR5LiK55yf5Y+356CB44CCYHR1cm4vc3RhcnRgIOS5i+WQjioq5LuA5LmI6YO95rKh5LiK5bGPKirml7ZcbiAgICAgKiDov5nkuIDova7lsLHkuI3nu5HvvIjpgqPkuIDova7msqHmnInlj6/ot7PnmoTlnLDmlrnvvIzpnaLmnb/kvJrnhaflrp7or7TvvIzogIzkuI3mmK/ot7PliLDkuIDkuKrliKvnmoTova7mrKHljrvvvInjgIJcbiAgICAgKi9cbiAgICBwcml2YXRlIG1hcmtUdXJuU3RhcnQodHVybjogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIHRoaXMuY3VycmVudFR1cm4gPSB0dXJuO1xuICAgICAgICB0aGlzLnBlbmRpbmdBbmNob3JUdXJuID0gdHVybjtcbiAgICAgICAgdGhpcy50b3VjaFByb2dyZXNzKCk7XG4gICAgfVxuXG4gICAgLyoqIGBhcHBlbmRgIOeahOWwvuW3tOS4iuiwg+eUqO+8muaKiuOAjOW+hee7keeahOi9ruasoeOAjee7keWIsOWImuS4iuWxj+eahOmCo+S4gOadoeS4iuOAgiAqL1xuICAgIHByaXZhdGUgYmluZFR1cm5BbmNob3IoZW50cnlTZXE6IG51bWJlcik6IHZvaWQge1xuICAgICAgICBpZiAodGhpcy5wZW5kaW5nQW5jaG9yVHVybiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICB0aGlzLnR1cm5BbmNob3JzLnNldCh0aGlzLnBlbmRpbmdBbmNob3JUdXJuLCBlbnRyeVNlcSk7XG4gICAgICAgIHRoaXMucGVuZGluZ0FuY2hvclR1cm4gPSBudWxsO1xuICAgICAgICB0aGlzLnRvdWNoUHJvZ3Jlc3MoKTtcbiAgICB9XG5cbiAgICAvKiog5oqK6L+b5bqm5pW05Z2X5b2S6Zu277yI5o2i5Lya6K+dIC8g5Zue5pS+5Y+m5LiA5p2h5Lya6K+d77yJ44CCICovXG4gICAgcHJpdmF0ZSByZXNldFByb2dyZXNzKCk6IHZvaWQge1xuICAgICAgICB0aGlzLnRvZG9zID0gbnVsbDtcbiAgICAgICAgdGhpcy50b2Rvc1R1cm4gPSAwO1xuICAgICAgICB0aGlzLmN1cnJlbnRUdXJuID0gMDtcbiAgICAgICAgdGhpcy5nb2FsID0gbnVsbDtcbiAgICAgICAgdGhpcy5nb2FsU2VlbiA9IGZhbHNlO1xuICAgICAgICB0aGlzLm91dGxpbmUgPSBudWxsO1xuICAgICAgICB0aGlzLmNoZWNrcG9pbnRUb2RvcyA9IG51bGw7XG4gICAgICAgIHRoaXMuY2hlY2twb2ludEdvYWwgPSBudWxsO1xuICAgICAgICB0aGlzLmNoZWNrcG9pbnROb3RlcyA9IFtdO1xuICAgICAgICB0aGlzLnRvZG9Ob3RlcyA9IFtdO1xuICAgICAgICB0aGlzLmdvYWxOb3RlcyA9IFtdO1xuICAgICAgICB0aGlzLnR1cm5BbmNob3JzLmNsZWFyKCk7XG4gICAgICAgIHRoaXMucGVuZGluZ0FuY2hvclR1cm4gPSBudWxsO1xuICAgICAgICB0aGlzLnByb2dyZXNzU2VlbiA9IGZhbHNlO1xuICAgICAgICB0aGlzLnByb2dyZXNzTm90ZSA9IG51bGw7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NTZXEgPSBudWxsO1xuICAgICAgICB0aGlzLnByb2dyZXNzQmVoaW5kID0gbnVsbDtcbiAgICAgICAgdGhpcy5wcm9ncmVzc1VwZGF0ZWRBdCA9IDA7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NEaXJ0eSA9IHRydWU7XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NKc29uID0gJyc7XG4gICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgIH1cblxuICAgIC8qKiDlj5jkuobmiY3lub/mkq3vvIjlpJrmlbDml7blgJnov5nkupvlrZfmrrXkuIDkuKrlrZfoioLpg73msqHliqjvvInjgIIgKi9cbiAgICBwcml2YXRlIHRvdWNoUHJvZ3Jlc3MoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGpzb24gPSBKU09OLnN0cmluZ2lmeSh0aGlzLnByb2dyZXNzVmlldygpKTtcbiAgICAgICAgaWYgKGpzb24gPT09IHRoaXMucHJvZ3Jlc3NKc29uKSByZXR1cm47XG4gICAgICAgIHRoaXMucHJvZ3Jlc3NKc29uID0ganNvbjtcbiAgICAgICAgdGhpcy5wcm9ncmVzc0RpcnR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog6Z2i5p2/6KaB55qE6YKj5LiA5Lu96L+b5bqm77yIKirlkIjlubbkuYvlkI7nmoTmiJDlk4EqKu+8ieOAglxuICAgICAqXG4gICAgICogQHJldHVybnMg5LiA5qyh5oiQ5Yqf55qE5qOA5p+l54K56K+76YO95rKh5pyJ44CB5Lmf5rKh5pyJ5Lu75L2V5a6e5pe25LqL5Lu25pe26L+U5ZueIG51bGxcbiAgICAgKiAgIO+8iOmdouadv+aNruatpOaYvuekuuOAjOi/mOayoeaciei/m+W6puOAjSsgYHByb2dyZXNzTm90ZWAg6YeM55qE5Y6f5Zug77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBwcm9ncmVzc1ZpZXcoKTogUHJvZ3Jlc3NWaWV3IHwgbnVsbCB7XG4gICAgICAgIGNvbnN0IGhhc0xpdmUgPSB0aGlzLnRvZG9zICE9PSBudWxsIHx8IHRoaXMuZ29hbCAhPT0gbnVsbCB8fCB0aGlzLnR1cm5BbmNob3JzLnNpemUgPiAwO1xuICAgICAgICBjb25zdCBoYXNDaGVja3BvaW50ID0gdGhpcy5jaGVja3BvaW50U2VlbigpO1xuICAgICAgICBpZiAoIWhhc0xpdmUgJiYgIWhhc0NoZWNrcG9pbnQpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGNvbnN0IG5vdGVzID0gWy4uLnRoaXMuY2hlY2twb2ludE5vdGVzLCAuLi50aGlzLnRvZG9Ob3RlcywgLi4udGhpcy5nb2FsTm90ZXNdO1xuXG4gICAgICAgIC8vIC0tLS0g5riF5Y2V77ya5LqL5Lu25LyY5YWIIC0tLS1cbiAgICAgICAgbGV0IHRvZG9zOiBUb2RvVmlld1tdIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGxldCB0b2Rvc1NvdXJjZTogJ2V2ZW50cycgfCAnY2hlY2twb2ludCcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgaWYgKHRoaXMudG9kb3MgIT09IG51bGwpIHtcbiAgICAgICAgICAgIHRvZG9zID0gdGhpcy50b2RvcztcbiAgICAgICAgICAgIHRvZG9zU291cmNlID0gJ2V2ZW50cyc7XG4gICAgICAgICAgICBpZiAodGhpcy5jaGVja3BvaW50VG9kb3MgIT09IG51bGwgJiYgSlNPTi5zdHJpbmdpZnkodGhpcy5jaGVja3BvaW50VG9kb3MpICE9PSBKU09OLnN0cmluZ2lmeSh0aGlzLnRvZG9zKSkge1xuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgICAgICfmo4Dmn6Xngrnph4znmoTmuIXljZXlkozkuovku7bmtYHph4znmoTkuI3kuIDmoLcg4oCU4oCUIOmdouadv+eUqOeahOaYryoq5LqL5Lu25rWBKirpgqPkuIDku73vvIjnvJPlrZjmlJLlpJ8gMjAwIOadoeS6i+S7tuaIliA1IOenkuaJjeWGmeS4gOasoe+8jOacgOWkmuiQveWQjui/meS5iOWkmu+8ieOAgicsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICh0aGlzLmNoZWNrcG9pbnRUb2RvcyAhPT0gbnVsbCkge1xuICAgICAgICAgICAgdG9kb3MgPSB0aGlzLmNoZWNrcG9pbnRUb2RvcztcbiAgICAgICAgICAgIHRvZG9zU291cmNlID0gJ2NoZWNrcG9pbnQnO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gLS0tLSDnm67moIfvvJrkuovku7bkvJjlhYjvvIhgZ29hbC9jaGFuZ2VgIOeahOWik+eikSA9IOebruagh+iiq+a4heaOie+8jOS5n+eul+OAjOS6i+S7tumHjOacieOAje+8iS0tLS1cbiAgICAgICAgaWYgKHRoaXMuZ29hbFNlZW4gJiYgdGhpcy5nb2FsICE9PSBudWxsICYmIHRoaXMuY2hlY2twb2ludEdvYWwgIT09IG51bGwgJiYgSlNPTi5zdHJpbmdpZnkodGhpcy5jaGVja3BvaW50R29hbCkgIT09IEpTT04uc3RyaW5naWZ5KHRoaXMuZ29hbCkpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goJ+ajgOafpeeCuemHjOeahOebruagh+WSjOS6i+S7tua1gemHjOeahOS4jeS4gOagtyDigJTigJQg6Z2i5p2/55So55qE5pivKirkuovku7bmtYEqKumCo+S4gOS7veOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGdvYWwgPSB0aGlzLmdvYWxTZWVuID8gdGhpcy5nb2FsIDogdGhpcy5jaGVja3BvaW50R29hbDtcblxuICAgICAgICAvLyAtLS0tIOWbnuWQiOebruW9le+8muWPquaciee8k+WtmOacie+8iOS6i+S7tua1gemHjOayoeacieOAjOaVtOS4quaXpeW/l+OAjei/meS4quamguW/te+8iS0tLS1cbiAgICAgICAgY29uc3QgcHJlc2VudCA9IG5ldyBTZXQodGhpcy5lbnRyaWVzLm1hcCgoZW50cnkpID0+IGVudHJ5LnNlcSkpO1xuICAgICAgICBjb25zdCB0dXJuczogVHVyblZpZXdbXSA9ICh0aGlzLm91dGxpbmU/LnR1cm5zID8/IFtdKS5tYXAoKHR1cm4pID0+ICh7XG4gICAgICAgICAgICAuLi50dXJuLFxuICAgICAgICAgICAgZW50cnlTZXE6IHRoaXMucmVzb2x2ZUFuY2hvcih0dXJuLnR1cm4sIHByZXNlbnQpLFxuICAgICAgICB9KSk7XG4gICAgICAgIC8vIOS6i+S7tumHjOingei/h+OAgeS9huWkp+e6sumHjOayoeacieeahOi9ruasoe+8iOWkp+e6sue8uuS6hiAvIOi/meS4gOi9ruWImuW8gOi/mOayoeaKmOi/m+WOu++8ie+8muiHs+WwkeaKiui9ruasoeWIl+WHuuadpVxuICAgICAgICBpZiAodGhpcy5vdXRsaW5lID09PSBudWxsICYmIHRoaXMudHVybkFuY2hvcnMuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgW3R1cm4sIGFuY2hvcl0gb2YgWy4uLnRoaXMudHVybkFuY2hvcnMuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBhWzBdIC0gYlswXSkpIHtcbiAgICAgICAgICAgICAgICB0dXJucy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgdHVybixcbiAgICAgICAgICAgICAgICAgICAgcHJvbXB0OiAnJyxcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2U6ICcnLFxuICAgICAgICAgICAgICAgICAgICBlbnRyeVNlcTogcHJlc2VudC5oYXMoYW5jaG9yKSA/IGFuY2hvciA6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIHNlcTogbnVsbCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB0b2RvcyxcbiAgICAgICAgICAgIHRvZG9zU291cmNlLFxuICAgICAgICAgICAgdG9kb3NUdXJuOiB0aGlzLnRvZG9zVHVybiA+IDAgPyB0aGlzLnRvZG9zVHVybiA6IG51bGwsXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIOa4heWNleavlOW9k+WJjei9ruasoeaXpyA9ICoqRFNIIOeahOaKleW9seWPo+W+hOW3sue7j+aKiua4heWNleW9kumbtuS6hioq77yI5q+P5LiA5qyhIGB0dXJuL3N0YXJ0YCDpg73lvZLpm7bvvInvvIxcbiAgICAgICAgICAgICAqIOS5n+WwseaYr+OAjOacrOi9riBhZ2VudCDov5jmsqHlhpnmuIXljZXjgI3jgILov5nml7blgJnpnaLmnb/kuIrpgqPkuIDku73mmK8qKuS4iuS4gOi9rueahOihqCoq77yM5b+F6aG75qCH5Ye65p2l44CCXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIHN0YWxlOiB0aGlzLnRvZG9zVHVybiA+IDAgJiYgdGhpcy5jdXJyZW50VHVybiA+IHRoaXMudG9kb3NUdXJuLFxuICAgICAgICAgICAgY3VycmVudFR1cm46IHRoaXMuY3VycmVudFR1cm4sXG4gICAgICAgICAgICBnb2FsLFxuICAgICAgICAgICAgdHVybnMsXG4gICAgICAgICAgICB0dXJuc1RvdGFsOiB0aGlzLm91dGxpbmU/LnR1cm5zVG90YWwgPz8gdHVybnMubGVuZ3RoLFxuICAgICAgICAgICAgZHJhZnQ6IHRoaXMub3V0bGluZT8uZHJhZnQgPz8gJycsXG4gICAgICAgICAgICBzZXE6IHRoaXMucHJvZ3Jlc3NTZXEsXG4gICAgICAgICAgICBiZWhpbmQ6IHRoaXMucHJvZ3Jlc3NCZWhpbmQsXG4gICAgICAgICAgICB1cGRhdGVkQXQ6IHRoaXMucHJvZ3Jlc3NVcGRhdGVkQXQsXG4gICAgICAgICAgICBub3RlcyxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiog5Zue5ZCI55uu5b2V6YeM6YKj5LiA6L2u55qE6Lez6L2s6JC954K577yI6YKj5LiA6L2u55qE5p2h55uu5bey57uP6KKrIDYwMCDmnaHkuIrpmZDmjKTmjonml7bnu5kgbnVsbO+8ieOAgiAqL1xuICAgIHByaXZhdGUgcmVzb2x2ZUFuY2hvcih0dXJuOiBudW1iZXIsIHByZXNlbnQ6IFNldDxudW1iZXI+KTogbnVtYmVyIHwgbnVsbCB7XG4gICAgICAgIGNvbnN0IGFuY2hvciA9IHRoaXMudHVybkFuY2hvcnMuZ2V0KHR1cm4pO1xuICAgICAgICBpZiAoYW5jaG9yID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gcHJlc2VudC5oYXMoYW5jaG9yKSA/IGFuY2hvciA6IG51bGw7XG4gICAgfVxuXG4gICAgLyoqIOacieayoeacieS4gOS7veaIkOWKn+eahOajgOafpeeCue+8iOeUqOWug+iAjOS4jeaYryBgb3V0bGluZSAhPT0gbnVsbGDvvJrkuIDku73nnJ/nmoTmsqHmnInlm57lkIjnmoTnmb3orrDlvZXkuZ/mmK/miJDlip/nmoTvvInjgIIgKi9cbiAgICBwcml2YXRlIGNoZWNrcG9pbnRTZWVuKCk6IGJvb2xlYW4ge1xuICAgICAgICByZXR1cm4gdGhpcy5wcm9ncmVzc1NlZW47XG4gICAgfVxuICAgIC8qKlxuICAgICAqIOWPkeS4gOadoeaOp+WItuW4p+W5tuetieWbnuaJp++8iOmdouadv+KGkuaPkuS7tumCo+S4gOi3r++8ieOAglxuICAgICAqXG4gICAgICog5LiO5bel5YW35bin77yIYGtpbmQ6ICdyZXEnYO+8ieWFseeUqCBJUEMg6YCa6YGT77yM6Z2gIGBraW5kYCDljLrliIbvvJvlm57miaflnKggYGF0dGFjaENoaWxkYCDnmoRcbiAgICAgKiDmtojmga/ot6/nlLHph4zmjIkgYGlkYCDphY3lr7njgIJcbiAgICAgKi9cbiAgICBwcml2YXRlIGNhbGxDaGlsZChcbiAgICAgICAgbWV0aG9kOiBzdHJpbmcsXG4gICAgICAgIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgIHRpbWVvdXRNcyA9IDYwXzAwMCxcbiAgICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICAgICAgaWYgKCFjaGlsZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcignYWdlbnQg5a2Q6L+b56iL5LiN5ZyoJykpO1xuXG4gICAgICAgIGNvbnN0IGlkID0gKyt0aGlzLmN0bFNlcTtcbiAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5jdGxQZW5kaW5nLmRlbGV0ZShpZCk7XG4gICAgICAgICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBg5o6n5Yi25binICR7bWV0aG9kfSDlnKggJHt0aW1lb3V0TXN9bXMg5YaF5rKh5pyJ5Zue5omn77yI5o+S5Lu254mI5pys6L+H5pen77yfYCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ+acrOaJqeWxleimgeaxgiBkc2gtY29jb3MtYnJpZGdlIOaUr+aMgeaOp+WItumAmumBk++8jOWFiOi3keS4gOasoSBzY3JpcHRzL2luc3RhbGwtcHJvZmlsZS5qc++8iScsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0sIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICB0aGlzLmN0bFBlbmRpbmcuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCwgdGltZXIgfSk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNoaWxkLnNlbmQoeyBfX3RhZzogSVBDX1RBRywga2luZDogJ2N0bCcsIGlkLCBtZXRob2QsIHBhcmFtcyB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgICAgICB0aGlzLmN0bFBlbmRpbmcuZGVsZXRlKGlkKTtcbiAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGDlj5HpgIHmjqfliLbluKflpLHotKXvvJoke2Rlc2NyaWJlKGVycm9yKX1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKiDlgZzmraIgYWdlbnTjgILlhYjotbDljY/orq4gYHNodXRkb3duYO+8iOacjeWKoeerr+S8muiHquW3semAgOWHuu+8ie+8jOWFnOW6leWGjSBraWxs44CCICovXG4gICAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICAgICAgaWYgKCF0aGlzLmNoaWxkKSB7XG4gICAgICAgICAgICB0aGlzLnNldFN0YXR1cygnc3RvcHBlZCcpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnNldFN0YXR1cygnc3RvcHBpbmcnKTtcbiAgICAgICAgY29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IGNsaWVudD8uc2h1dGRvd24oKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSBzaHV0ZG93biDor7fmsYLmsqHotbDlrozvvIjnu6fnu60ga2lsbO+8ie+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICB9XG4gICAgICAgIC8vIOacjeWKoeerr+mAmuW4uOS8muiHquW3sSBleGl077yb57uZ5a6DIDEuNXPvvIznhLblkI7lhZzlupXjgIJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjaGlsZC5raWxsKCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgICAgLyog5bey57uP5rKh5LqGICovXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfSwgMTUwMCk7XG4gICAgICAgICAgICBjaGlsZC5vbmNlKCdleGl0JywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmNsZWFudXAoKTtcbiAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3N0b3BwZWQnKTtcbiAgICAgICAgdGhpcy5hcHBlbmQoJ25vdGUnLCAnYWdlbnQg5bey5YGc5q2iJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5Lit5patKirlvZPliY3ov5nkuIDova4qKu+8iOmdouadv+S4iumCo+S4quOAjOWBnOatouacrOi9ruOAjeaMiemSru+8ieOAglxuICAgICAqXG4gICAgICogIyMg5Li65LuA5LmI5a6D5b+F6aG75pyJ77yM5Lul5Y+K5Li65LuA5LmI5Y+q6IO96L+Z5LmI5YGaXG4gICAgICpcbiAgICAgKiBTREsg5Y2P6K6u5Y+q5pyJIGBpbml0aWFsaXplYCAvIGBzZXNzaW9uL3Byb21wdGAgLyBgc2h1dGRvd25gIOS4ieS4quaWueazle+8jFxuICAgICAqICoq5rKh5pyJ44CM5Y+W5raI6L+Z5LiA6L2u44CNKirvvJvogIzkuJQgYHNlc3Npb24vcHJvbXB0YCDnmoTlm57miaflj6rmmK/jgIzlhaXpmJ/miJDlip/jgI1cbiAgICAgKiDvvIhgU2Vzc2lvblByb21wdFJlc3VsdGAg5pivIGR1cmFibGUgZW5xdWV1ZSByZWNlaXB077yJ77yM5ou/5Yiw5Zue5omn4omg6L+Z5LiA6L2u57uT5p2f44CCXG4gICAgICog5omA5Lul5Zyo5Yqg6L+Z5p2h6YCa6YGT5LmL5YmN77yM6Z2i5p2/5LiK5ZSv5LiA55qE44CM5YGc5q2i44CN5pivKirmnYDmjonmlbTkuKogYWdlbnQg6L+b56iLKiog4oCU4oCUXG4gICAgICog5Lya6K+d44CB5a2QIGFnZW5044CB5q2j5Zyo6LeR55qE5bel5YW35LiA6LW35rKh77yM5LiL5LiA5Y+l6L+Y6KaB6YeN5paw5ZCv5YqoICsg6Ieq5Yqo5o6l5LiK5LiL5paH44CCXG4gICAgICog44CMQUkg5oOz5q2q5LqG5oOz5pS55Y+j44CN6L+Z56eN5pyA5bi46KeB55qE5Zy65pmv77yM5Luj5Lu36auY5b6X56a76LCx44CCXG4gICAgICpcbiAgICAgKiDnnJ/mraPog73lj5bmtojnmoTmmK/ov5DooYzml7blhoXpg6jnmoQgYEFnZW50LmNhbmNlbChjYXVzZSlg77yM6ICM5a6D5Y+q5pyJ5o+S5Lu26IO96LCDXG4gICAgICog77yI6KeBIGBkc2gtY29jb3MtYnJpZGdlYCDnmoQgYHNlc3Npb24vY2FuY2VsYO+8ieOAgui/meadoeaWueazleWwseaYr+mCo+S4gOatpeeahOi9rOWPke+8mlxuICAgICAqXG4gICAgICogYGBgXG4gICAgICog6Z2i5p2/44CM5YGc5q2i5pys6L2u44CN4oaSIOS4u+i/m+eoiyBpbnRlcnJ1cHQoKSDihpIgY3RsIHNlc3Npb24vY2FuY2VsIHtzZXNzaW9uSWR9XG4gICAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4oaSIOaPkuS7tiBhZ2VudHMuZ2V0KHNlc3Npb25JZCkuY2FuY2VsKHtraW5kOid1c2VyJ30pXG4gICAgICogYGBgXG4gICAgICpcbiAgICAgKiAjIyDkuInmnaHlj6PlvoRcbiAgICAgKlxuICAgICAqIDEuICoq5rKh5Zyo6LeR5bCx5LiN566X6ZSZKirvvJpgcnVubmluZ2Ag5Li65YGH55u05o6l5Zue5LiA5Y+lIG5vdGXvvIzkuI3miZPmibDmj5Lku7Yg4oCU4oCUXG4gICAgICogICAg5oyJ6ZKu5LiO44CM6L+Z5LiA6L2u5Yia5aW96Ieq5bex57uT5p2f44CN5LmL6Ze05pyJ5aSp54S256ue5oCB77yM5oql57qi5piv6K+v5oql44CCXG4gICAgICogMi4gKirkuK3mlq3kuI3mmK/lm57mu5oqKu+8muW3sue7j+S6p+WHuueahOaWh+acrCAvIOW3sue7j+i3keWujOeahOW3peWFt+iwg+eUqOmDveeVmeedgFxuICAgICAqICAgIO+8iGBhc3Npc3RhbnQvbWVzc2FnZWAg55qEIGBpbnRlcnJ1cHRlZGAg5LiOIGB0dXJuL2VuZGAg55qEIGBhYm9ydGVkYCDkvJrliLDvvIzovazlhpnph4zkvJrlpJrkuIDmnaEgbm90Ze+8ieOAglxuICAgICAqIDMuICoq5LiN5YqoIGBzZXNzaW9uSWRgKirvvJrkuK3mlq3kuYvlkI7mjqXnnYDor7TvvIzov5jmmK/lkIzkuIDkuKrkvJror53jgIHlkIzkuIDmrrXkuIrkuIvmlofjgIJcbiAgICAgKlxuICAgICAqIEByZXR1cm5zIGB7b2ssIGNhbmNlbGxlZD8sIHN0YXR1cz8sIGVycm9yP31g44CCXG4gICAgICovXG4gICAgYXN5bmMgaW50ZXJydXB0KCk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgY2FuY2VsbGVkPzogYm9vbGVhbjsgc3RhdHVzPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICh0aGlzLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCAhdGhpcy5jaGlsZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2FnZW50IOi/mOayoeWwsee7qicgfTtcbiAgICAgICAgaWYgKCF0aGlzLnNlc3Npb25JZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+i/mOayoeacieS8muivnScgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog4pqgICoq5LiN5ou/IGB0aGlzLnJ1bm5pbmdgIOW9k+mXuOmXqCoq77ya5a6D5p2l6IeqIGBzZXNzaW9uLnN0YXR1c2Ag6YCa55+l77yM5Y+v6IO95ZyoXG4gICAgICAgICAgICAgKiDjgIzpnaLmnb/liJrph43lvIDjgI3jgIzpgJrnn6Xov5jmsqHliLDjgI3ml7bmmK/pmYjml6fnmoQgYGZhbHNlYO+8m+iAjCoq6LCB5Zyo6LeRKirov5nku7bkuovvvIxcbiAgICAgICAgICAgICAqIOi/kOihjOaXtumHjOeahCBgYWdlbnQuc3RhdHVzYCDmiY3mmK/nnJ/mupDjgILmiYDku6XkuIDlvovpl67mj5Lku7bvvIznlLHlroPlm54gYGNhbmNlbGxlZGDjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5jYWxsQ2hpbGQoJ3Nlc3Npb24vY2FuY2VsJywgeyBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkIH0sIDE1XzAwMCk7XG4gICAgICAgICAgICBjb25zdCBjYW5jZWxsZWQgPSByZXN1bHQuY2FuY2VsbGVkID09PSB0cnVlO1xuICAgICAgICAgICAgY29uc3Qgc3RhdHVzID0gdHlwZW9mIHJlc3VsdC5zdGF0dXMgPT09ICdzdHJpbmcnID8gcmVzdWx0LnN0YXR1cyA6IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgY2FuY2VsbGVkID8gJ+W3suivt+axguS4reaWrei/meS4gOi9ru+8iOS8muivneS/neeVme+8jOWPr+S7peaOpeedgOivtO+8iScgOiAn6L+Z5LiA6L2u5bey57uP57uT5p2f5LqGJyk7XG4gICAgICAgICAgICAvLyDkuZDop4LmlLbmlZvvvJrkuK3mlq3or7fmsYLlt7Llj5fnkIbml7bvvIzmnKzlnLAgcnVubmluZyDnq4vliLvnva7kvY3vvIzliKvnrYnkuIvkuIDmrKHpgJrnn6VcbiAgICAgICAgICAgIC8vIO+8iOmdouadv+mCo+S4quaMiemSrueahOemgeeUqOaAgemdoOWug++8jOS4jeeEtuS8muacieS4gOWwj+auteOAjOeci+i1t+adpeayoeWPjeW6lOOAje+8iVxuICAgICAgICAgICAgaWYgKGNhbmNlbGxlZCkgdGhpcy5ydW5uaW5nID0gZmFsc2U7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgY2FuY2VsbGVkLCBzdGF0dXMgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBkZXNjcmliZShlcnJvcik7XG4gICAgICAgICAgICB0aGlzLmFwcGVuZCgnZXJyb3InLCBg5Lit5pat5aSx6LSl77yaJHttZXNzYWdlfWApO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDmnI3liqHpgJrpgZPvvIjmlpzmnaDlkb3ku6QgLyBA6Lev5b6E77yJXG4gICAgLy9cbiAgICAvLyDov5nkuKTmoLfog73lipsqKuS4gOebtOmDveWcqOWuv+S4u+mHjCoq77yIYGN0eC5jb21tYW5kc2AgLyBgY3R4LmZpbGVSZWZlcmVuY2VzYO+8ie+8jFxuICAgIC8vIOWPquaYr+WOn+acrOWPquaciSBgZHNoLXdlYi1hcHBgIOeahOa1j+iniOWZqOmCo+S4gOWNiuWcqOa2iOi0ue+8jOiAjCBTREsg5Y2P6K6u5LiA5Liq6YO96KGo6L6+5LiN5LqG44CCXG4gICAgLy8g5o+S5Lu277yIYGRzaC1jb2Nvcy1icmlkZ2Vg77yJ5oqK6L+Z5Lik5Liq5pyN5Yqh5oyJIGFnZW50IOi9rOWHuuadpe+8jOi/meS4ieadoeaWueazleWwseaYr+aJqeWxleS+p+eahOi9rOWPkSArIOaUtuaVm+OAglxuXG4gICAgLyoqXG4gICAgICog5YiX5b2T5YmNIGFnZW50IOiDveeUqOeahOaWnOadoOWRveS7pO+8iOmdouadv+i+k+WFpSBgL2Ag5pe25by555qE6YKj5byg6KGo77yJ44CCXG4gICAgICpcbiAgICAgKiDlkb3ku6TmmK8qKuaMiSBhZ2VudCoqIOafpeeahO+8iOazqOWGjOihqOaUr+aMgSBhZ2VudCDkvZznlKjln5/pga7olL3lkIzlkI3lhajlsYDlrprkuYnvvInvvIxcbiAgICAgKiDmiYDku6XmsqHmnInkvJror53ml7bmsqHlvpflj6/liJcg4oCU4oCUIOebtOaOpeWbniBgYWdlbnQg6L+Y5rKh5bCx57uqIC8g6L+Y5rKh5pyJ5Lya6K+dYO+8jFxuICAgICAqIOiAjOS4jeaYr+WbnuS4gOW8oOepuuihqO+8iOepuuihqOS8muiuqemdouadv+S7peS4uuOAjOi/meS4qiBwcm9maWxlIOayoeacieWRveS7pOOAje+8ieOAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtvaywgY29tbWFuZHM/LCBlcnJvcj99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1hbmRMaXN0KCk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgY29tbWFuZHM/OiBDb21tYW5kVmlld1tdOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICh0aGlzLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCAhdGhpcy5jaGlsZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2FnZW50IOi/mOayoeWwsee7qicgfTtcbiAgICAgICAgaWYgKCF0aGlzLnNlc3Npb25JZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+i/mOayoeacieS8muivnScgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY2FsbENoaWxkKCdjb21tYW5kcy9saXN0JywgeyBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkIH0sIDIwXzAwMCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgY29tbWFuZHM6IG5vcm1hbGl6ZUNvbW1hbmRzKHJlc3VsdC5jb21tYW5kcykgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGRlc2NyaWJlKGVycm9yKSB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5omn6KGM5LiA5p2h5pac5p2g5ZG95Luk6KGM44CCXG4gICAgICpcbiAgICAgKiAjIyDkuInmnaHlj6PlvoRcbiAgICAgKlxuICAgICAqIDEuICoq57uT5p6c55S75Zyo6L2s5YaZ6YeM77yM5LiN5Zyo6Z2i5p2/55qE5Li05pe25rWu5bGC6YeMKirvvJrlkb3ku6TnmoTmiafooYzlnKjkvJror53ml6Xlv5fkuK3nlZnkuItcbiAgICAgKiAgICBgY29tbWFuZC9ydW5gICsgYGNvbW1hbmQvZG9uZWAg5Lik5p2h5LqL5Lu277yIKirkuI3ov5vmqKHlnovljoblj7IqKu+8ie+8jOaJgOS7peWug+WkqeeEtuWxnuS6juS8muivne+8m1xuICAgICAqICAgIOmdouadv+WIt+aWsCAvIOaNouS8muivnSAvIOWbnuaUvuS5i+WQju+8jOi/meS4gOadoSBub3RlIOi/mOWcqO+8iOWbnuaUvumCo+adoeWIhuaUr+ingSBgaGFuZGxlU2Vzc2lvbkV2ZW50YO+8ieOAglxuICAgICAqIDIuICoqYGtub3duOmZhbHNlYCDkuI7jgIzlkb3ku6TmiqXplJnjgI3mmK/kuKTku7bkuosqKu+8muWJjeiAheaYr+OAjOivreazleS4jeWQiOazleaIluWQjeWtl+S4jeiupOivhuOAjVxuICAgICAqICAgIO+8iOazqOWGjOihqOi/nueUn+WRveWRqOacn+S6i+S7tumDveayoeiusO+8ie+8jOWQjuiAheaYr+WRveS7pOecn+eahOi3keS6huS9hui/lOWbniBlcnJvcuOAglxuICAgICAqICAgIOS4pOiAheeahOaWh+ahiOS4jeS4gOagt++8jOWIq+WQiOW5tuaIkOS4gOWPpeOAjOWRveS7pOWksei0peOAjeOAglxuICAgICAqIDMuICoq5LiN5YGa5LmQ6KeC5Zue5pi+KirvvJrlkb3ku6Tlj6/og73mlLnkvJror53nirbmgIHvvIhgL2NvbXBhY3RgIOS8muWOi+e8qeWOhuWPsuOAgWAvcGxhbmAg5Lya5YiH5qih5byP77yJ77yMXG4gICAgICogICAg5YWI55S75LiA5p2h44CM5bey5Y+R6YCB44CN5YaN6KKr55yf57uT5p6c55uW5o6J77yM55yL6LW35p2l5YOP5oqW5LqG5LiA5LiL44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gbGluZSAtIOWujOaVtOWRveS7pOihjO+8iOW/hemhu+S7pSBgL2Ag5byA5aS077yJ44CCXG4gICAgICogQHJldHVybnMgYHtvaywga25vd24/LCBraW5kPywgdGV4dD8sIGVycm9yP31g44CCXG4gICAgICovXG4gICAgYXN5bmMgcnVuQ29tbWFuZChsaW5lOiB1bmtub3duKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBrbm93bj86IGJvb2xlYW47IGtpbmQ/OiAnc3VjY2VzcycgfCAnZXJyb3InOyB0ZXh0Pzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gICAgICAgIGlmICh0aGlzLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCAhdGhpcy5jaGlsZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2FnZW50IOi/mOayoeWwsee7qicgfTtcbiAgICAgICAgaWYgKCF0aGlzLnNlc3Npb25JZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+i/mOayoeacieS8muivnScgfTtcbiAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBsaW5lID09PSAnc3RyaW5nJyA/IGxpbmUudHJpbSgpIDogJyc7XG4gICAgICAgIGlmICghdGV4dC5zdGFydHNXaXRoKCcvJykpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfmlpzmnaDlkb3ku6Tlv4Xpobvku6UgXCIvXCIg5byA5aS0JyB9O1xuICAgICAgICBpZiAodGV4dC5sZW5ndGggPiAyMDAwKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5pac5p2g5ZG95Luk5aSq6ZW/5LqG77yI5LiK6ZmQIDIwMDAg5a2X56ym77yJJyB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5jYWxsQ2hpbGQoJ2NvbW1hbmRzL3J1bicsIHsgc2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCwgbGluZTogdGV4dCB9LCAxMjBfMDAwKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQua25vd24gIT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gYOayoeaciei/meS4quaWnOadoOWRveS7pO+8miR7dGV4dC5zcGxpdCgvXFxzKy8pWzBdfWA7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgbWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBrbm93bjogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBmYWlsZWQgPSByZXN1bHQua2luZCA9PT0gJ2Vycm9yJztcbiAgICAgICAgICAgIGNvbnN0IG91dHB1dCA9IHR5cGVvZiByZXN1bHQudGV4dCA9PT0gJ3N0cmluZycgPyByZXN1bHQudGV4dC50cmltKCkgOiAnJztcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOWRveS7pCAke3RleHQuc3BsaXQoL1xccysvKVswXX0gJHtmYWlsZWQgPyAn5aSx6LSlJyA6ICflrozmiJAnfSR7b3V0cHV0ID8gYO+8miR7b3V0cHV0fWAgOiAnJ31gKTtcbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICog6aG65bim6KGl6K+755So6YeP77yaYC9jb21wYWN0YCDmraPmmK8qKuS4uuS6hioq5pS55LiK5LiL5paH5omN55So55qE77yM6ICM55So5oi355yL55qE5bCx5piv5Y2g55So546H44CCXG4gICAgICAgICAgICAgKiDkuKTkuKrml7bliLvvvIjop4HluLjph4/ms6jph4rvvInvvJrmo4Dmn6XngrnmmK/mlJLnnYDlhpnnmoTvvIznrKzkuIDkuKrngrnor7vliLDnmoTlvojlj6/og73ov5jmmK/ml6fmlbDjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgdGhpcy5zY2hlZHVsZVVzYWdlUmVmcmVzaChVU0FHRV9SRUZSRVNIX0FGVEVSX0NPTU1BTkRfTVMpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGtub3duOiB0cnVlLCBraW5kOiBmYWlsZWQgPyAnZXJyb3InIDogJ3N1Y2Nlc3MnLCB0ZXh0OiBvdXRwdXQgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBkZXNjcmliZShlcnJvcik7XG4gICAgICAgICAgICB0aGlzLmFwcGVuZCgnZXJyb3InLCBg5ZG95Luk5rKh5pyJ5omn6KGM77yaJHttZXNzYWdlfWApO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5YiXIGBA6Lev5b6EYCDlgJnpgInvvIjpnaLmnb/nmoQgYEBgIOihpeWFqO+8ieOAglxuICAgICAqXG4gICAgICog6Z2i5p2/5LyaKirovrnmiZPlrZfovrnpl64qKu+8jOaJgOS7pei/meadoei3r+imgeS+v+WunO+8muaPkOS+m+aWueiHquW3seW4pue8k+WtmO+8iGB0b29sL3Jlc3VsdGAg5LmL5ZCO5ZCO5Y+w6YeN5bu677yJ77yMXG4gICAgICog5oiR5Lus6L+Z6L655Y+q5YGa5b2i54q25pS25pWb5LiO5LiK6ZmQ44CC5p+l6K+i5Liy5Y6f5qC36YCP5LygIOKAlOKAlCAqKuihpeWFqOivreS5iSoq77yI5qih57OK5o6S5bqP44CB55uu5b2V5bim5bC+5pac5p2g44CBXG4gICAgICog5ZOq5Lqb55uu5b2V5LiN6YGN5Y6G77yJ55Sx5o+Q5L6b5pa55oul5pyJ77yM5oqE5LiA5Lu95b+F54S25ryC56e744CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcXVlcnkgLSBgQGAg5oiWIGBAXCJgIOS5i+WQjuWIsOWFieagh+S5i+mXtOeahOaWh+acrOOAglxuICAgICAqIEByZXR1cm5zIGB7b2ssIGNhbmRpZGF0ZXM/LCBlcnJvcj99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIGZpbGVSZWZlcmVuY2UocXVlcnk6IHVua25vd24pOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGNhbmRpZGF0ZXM/OiBSZWZlcmVuY2VDYW5kaWRhdGVbXTsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2hpbGQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdhZ2VudCDov5jmsqHlsLHnu6onIH07XG4gICAgICAgIGlmICghdGhpcy5zZXNzaW9uSWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfov5jmsqHmnInkvJror50nIH07XG4gICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgcXVlcnkgPT09ICdzdHJpbmcnID8gcXVlcnkuc2xpY2UoMCwgNDAwKSA6ICcnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5jYWxsQ2hpbGQoJ2ZpbGVyZWYvbGlzdCcsIHsgc2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCwgcXVlcnk6IHRleHQgfSwgMjBfMDAwKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBjYW5kaWRhdGVzOiBub3JtYWxpemVSZWZlcmVuY2VzKHJlc3VsdC5jYW5kaWRhdGVzKSB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoZXJyb3IpIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDor7vjgIzmtLvliqjjgI3mir3lsYnpgqPkuKTlnZfvvJrlkI7lj7Dku7vliqHvvIhqb2Jz77yJKyDlrZAgYWdlbnTvvIhzdWJhZ2VudHPvvInjgIJcbiAgICAgKlxuICAgICAqICMjIOWbm+adoeWPo+W+hFxuICAgICAqXG4gICAgICogMS4gKirkuIDmrKHor7vkuKTlnZcqKu+8iOS4pOadoeaOp+WItuW4p+W5tuWPkeWPkeWHuuWOu++8jGBQcm9taXNlLmFsbGAg5pS277yJ44CC5a6D5Lus5rKh5pyJ5YWx5Lqr54q25oCB77yMXG4gICAgICogICAg5L2GKirlhbHnlKjkuIDnu4Tor7TmmI4qKu+8iOaIquaWreOAgeWIl+S4jeWHuuadpeeahOWOn+WboO+8ie+8jOWIhuS4pOasoeivu+S8muiuqemdouadv+mCo+Wdl+ivtOaYjuS4gOS8muWEv+acieS4gOS8muWEv+ayoeacieOAglxuICAgICAqIDIuICoq5Lik5Z2X5ZCE6Ieq5oiQ6LSlKirvvJrkuIDkuKrmnI3liqHnvLrlpLHkuI3or6Xorqnlj6bkuIDlnZfkuZ/nqbrnmb0g4oCU4oCUIOaJgOS7peS4pOasoeiwg+eUqOWQhOiHqiBjYXRjaO+8jFxuICAgICAqICAgIOWksei0peeahOmCo+S4gOWdl+WPqueVmSBgKlJlYXNvbmDvvIjpnaLmnb/or7TjgIznnIvkuI3liLAgKyDkuLrku4DkuYjjgI3vvInvvIzlj6bkuIDlnZfnhafnlLvjgIJcbiAgICAgKiAzLiAqKui/meaYr1wi6K+75LiA5qyhXCLnmoTnrZTmoYjvvIzkuI3mmK/lrp7ml7bmtYEqKu+8mmBhdGAg5bim5LiK5pe25Yi777yM6Z2i5p2/5o2u5q2k6K+044CM5Yeg56eS5YmN44CN44CCXG4gICAgICogICAg6LCB5Zyo5LuA5LmI5pe25YCZ6K+755Sx6Z2i5p2/5Yaz5a6a77yI5omT5byA5oq95bGJIC8g54K55Yi35paw77yJ77yM5a6/5Li75LiN6Ieq5bex6LW35a6a5pe25ZmoIOKAlOKAlFxuICAgICAqICAgIOi/meS4pOS4quacjeWKoea0u+WcqOi/kOihjOaXtuWGheWtmOmHjO+8jCoq5rKh5pyJ5Y+Y5YyW5LqL5Lu2Kirlj6/orqLpmIXvvIhgb25Kb2JzQ2hhbmdlZGAg5Y+q5Zyo6ZuG5ZCI5Y+Y5YyW5pe25ZON77yMXG4gICAgICogICAg6L6T5Ye65aKe6ZW/5LiN6Kem5Y+R77yJ77yM6L2u6K+i5piv5ZSv5LiA6K+a5a6e55qE6YCJ5oup44CCXG4gICAgICogNC4gKirkuI3or7sgam9iIOeahOi+k+WHuioq77yI6KeBIGBjb25zdGFudHMudHNgIOeahCBgSm9iVmlld2DvvInvvJrmj5Lku7bpgqPmrKHosIPnlKjlj6rnlKggYGxpc3QoKWAvYGdldCgpYOOAglxuICAgICAqXG4gICAgICogQHJldHVybnMgYHtvaywgYWN0aXZpdHk/LCBlcnJvcj99YO+8m2BvazpmYWxzZWAg5Y+q5ZyoIGFnZW50IOmDveayoei1t+adpeaXtuWHuueOsOOAglxuICAgICAqL1xuICAgIGFzeW5jIHBhbmVsQWN0aXZpdHkoKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBhY3Rpdml0eT86IEFjdGl2aXR5VmlldzsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBpZiAodGhpcy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIXRoaXMuY2hpbGQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdhZ2VudCDov5jmsqHlsLHnu6onIH07XG4gICAgICAgIGlmICghdGhpcy5zZXNzaW9uSWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfov5jmsqHmnInkvJror50nIH07XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuc2Vzc2lvbklkO1xuICAgICAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgW2pvYnNSYXcsIHN1YnNSYXddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgdGhpcy5jYWxsQ2hpbGQoJ2pvYnMvbGlzdCcsIHsgc2Vzc2lvbklkIH0sIDIwXzAwMCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaChg5ZCO5Y+w5Lu75Yqh6K+75LiN5Ye65p2l77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHRoaXMuY2FsbENoaWxkKCdzdWJhZ2VudHMvbGlzdCcsIHsgc2Vzc2lvbklkIH0sIDIwXzAwMCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaChg5a2QIGFnZW50IOivu+S4jeWHuuadpe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfSksXG4gICAgICAgIF0pO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aXZpdHk6IG5vcm1hbGl6ZUFjdGl2aXR5KGpvYnNSYXcsIHN1YnNSYXcsIG5vdGVzLCBEYXRlLm5vdygpKSB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOS4reaWreS4gOS4quWtkCBhZ2VudCDnmoTlvZPliY3kuIDova7jgIJcbiAgICAgKlxuICAgICAqIOKaoCDlj6rlgZwqKuW9k+WJjei/meS4gOi9rioq77yI5Lya6K+d5LiO5LiK5LiL5paH6YO955WZ552A77yJ77yM5omA5Lul6Z2i5p2/55qE5paH5qGI5LiN6K645YaZ5oiQ44CM5p2A5o6J5a2QIGFnZW5044CN44CCXG4gICAgICog55uu5qCH5LiN5a2Y5Zyo5pe25pyN5Yqh6Ieq5bex5piv6Z2Z6buYIG5vLW9wIOKAlOKAlCDpgqPnp43mg4XlhrXmiJHku6zlm54gYG9rOnRydWVg77yM5Zug5Li644CM5a6D5bey57uP57uT5p2f5LqG44CNXG4gICAgICog5LiO44CM5Lit5pat5oiQ5Yqf44CN5a+555So5oi35piv5ZCM5LiA5Lu25LqL77yI5oyJ6ZKu5oyJ5LiL5Y6755qE6YKj5LiA5Yi75a6D5Yia5aW96LeR5a6M77yJ44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gc3ViYWdlbnRJZCAtIOWtkOS8muivnSBpZOOAglxuICAgICAqIEByZXR1cm5zIGB7b2ssIHN1YmFnZW50SWQ/LCBlcnJvcj99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIHN1YmFnZW50SW50ZXJydXB0KHN1YmFnZW50SWQ6IHVua25vd24pOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IHN1YmFnZW50SWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICAgICAgaWYgKHRoaXMuc3RhdHVzICE9PSAncmVhZHknIHx8ICF0aGlzLmNoaWxkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnYWdlbnQg6L+Y5rKh5bCx57uqJyB9O1xuICAgICAgICBpZiAoIXRoaXMuc2Vzc2lvbklkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn6L+Y5rKh5pyJ5Lya6K+dJyB9O1xuICAgICAgICBjb25zdCB0YXJnZXQgPSB0eXBlb2Ygc3ViYWdlbnRJZCA9PT0gJ3N0cmluZycgPyBzdWJhZ2VudElkLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIXRhcmdldCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ3N1YmFnZW50LWludGVycnVwdO+8mue8uuWwkSBzdWJhZ2VudElkJyB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5jYWxsQ2hpbGQoJ3N1YmFnZW50cy9pbnRlcnJ1cHQnLCB7IHBhcmVudFNlc3Npb25JZDogdGhpcy5zZXNzaW9uSWQsIHN1YmFnZW50SWQ6IHRhcmdldCB9LCAyMF8wMDApO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ25vdGUnLCBg5bey6K+35rGC5Lit5pat5a2QIGFnZW50ICR7dGFyZ2V0LnNsaWNlKDAsIDgpfeKApiDnmoTlvZPliY3kuIDova7vvIjkvJror53kuI7kuIrkuIvmlofpg73nlZnnnYDvvIlgKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdWJhZ2VudElkOiB0YXJnZXQgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGRlc2NyaWJlKGVycm9yKSB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqIOW8gOS4gOS4quaWsOS8muivne+8iOaWsOeahCBzZXNzaW9uSWTvvJvml6fkvJror53lnKggRFNIIOS+p+S7jeaMieaXpeW/l+eVmeWcqOejgeebmOS4iu+8ieOAgiAqL1xuICAgIG5ld1Nlc3Npb24oKTogeyBvazogYm9vbGVhbjsgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsIH0geyAgICAgICAgLy8g5o6l5LiK5p2l55qE5Y6G5Y+y5Lya6K+d5pivKirmj5Lku7bmjIHmnInnmoQgYWdlbnQqKu+8muW8gOaWsOS8muivneWwseimgeaYvuW8j+aUvuaOieWug++8jFxuICAgICAgICAvLyDlkKbliJnlroPkvJrkuIDnm7TmjILlnKjov5DooYzml7bph4zvvIjkuIvmrKEgcmVzdW1lIOWQjOS4gOS4qiBpZCDkvJrmkp7kuIrvvInjgIJcbiAgICAgICAgaWYgKHRoaXMuc2Vzc2lvbktpbmQgPT09ICdyZXN1bWVkJyAmJiB0aGlzLnNlc3Npb25JZCkge1xuICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSB0aGlzLnNlc3Npb25JZDtcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYWxsQ2hpbGQoJ3Nlc3Npb24vZGlzcG9zZScsIHsgc2Vzc2lvbklkOiBwcmV2aW91cyB9KS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g6YeK5pS+5Lya6K+dICR7cHJldmlvdXMuc2xpY2UoMCwgOCl94oCmIOWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG4gICAgICAgIHRoaXMuc2Vzc2lvbktpbmQgPSAnc2RrJztcbiAgICAgICAgdGhpcy5oaXN0b3J5VmlldyA9IG51bGw7XG4gICAgICAgIHRoaXMucmVzZXRUcmFuc2NyaXB0KCk7XG4gICAgICAgIHRoaXMuYXBwZW5kKFxuICAgICAgICAgICAgJ25vdGUnLFxuICAgICAgICAgICAgYOW3suW8gOaWsOS8muivnSAke3RoaXMuc2Vzc2lvbklkLnNsaWNlKDAsIDgpfeKApu+8iOS4iuS4gOauteWvueivneS7jeWcqOWPs+S4iuinkuOAjOWOhuWPsuOAjemHjO+8jOmaj+aXtuWPr+S7peaOpeedgOiBiu+8iWAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXNzaW9uSWQ6IHRoaXMuc2Vzc2lvbklkIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog5riF56m65a+56K+d5Yy677yI5o2i5Lya6K+dL+WbnuaUvuWOhuWPsuWJjeiwg+eUqO+8ieOAglxuICAgICAqXG4gICAgICogKirku6PmlbAgKzEqKiDmmK/nu5npnaLmnb/nmoTkv6Hlj7fvvJrpnaLmnb/lj6rmjIkgYHJldmAg5ouJ5aKe6YeP77yM5rKh5rOV6KGo6L6+44CM5p+Q5p2h6KKr5Yig5o6J5LqG44CN77yMXG4gICAgICog5omA5Lul44CM5riF56m644CN6L+Z5Lu25LqL5b+F6aG75pyJ5LiA5Liq54us56uL55qE44CB5Y2V6LCD6YCS5aKe55qE6K6w5Y+377yIYGdlbmVyYXRpb25g77yJ44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNldFRyYW5zY3JpcHQoKTogdm9pZCB7XG4gICAgICAgIHRoaXMuZW50cmllcy5sZW5ndGggPSAwO1xuICAgICAgICB0aGlzLnNlcSA9IDA7XG4gICAgICAgIHRoaXMuZ2VuZXJhdGlvbiArPSAxO1xuICAgICAgICB0aGlzLnRleHRTdHJlYW0gPSBudWxsO1xuICAgICAgICB0aGlzLnJlYXNvbmluZ1N0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMudG9vbEJ5Q2FsbElkLmNsZWFyKCk7XG4gICAgICAgIHRoaXMuZGlydHkuY2xlYXIoKTtcbiAgICAgICAgLy8g5qCH6aKY5LiO5ZG95Luk5ZCN6YO95piv44CM5bGe5LqO5LiK5LiA5Liq5Lya6K+d44CN55qE5Lic6KW/77ya5o2i5Lya6K+d5b+F6aG75riF5o6J77yM5ZCm5YiZ5paw5Lya6K+d5Lya6aG2552AXG4gICAgICAgIC8vIOS4iuS4gOS4quS8muivneeahOagh+mimC/lkb3ku6TorrDlvZXvvIzogIzkuJTlm57mlL7ml7YgYGNvbW1hbmQvZG9uZWAg5Lya6YWN5Yiw6ZSZ55qE5ZG95Luk5ZCN44CCXG4gICAgICAgIHRoaXMuc2Vzc2lvblRpdGxlID0gbnVsbDtcbiAgICAgICAgdGhpcy5jb21tYW5kTmFtZXMuY2xlYXIoKTtcbiAgICAgICAgdGhpcy50aXRsZURpcnR5ID0gdHJ1ZTtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOeUqOmHj+S4juWunuaXtuawtOS9jeS5n+aYr+OAjOWxnuS6juS4iuS4gOS4quS8muivneOAjeeahOS4nOilv++8muS4jea4heeahOivne+8jOaWsOS8muivneS8mumhtuedgOS4iuS4gOS4quS8muivneeahFxuICAgICAgICAgKiDljaDnlKjnjofvvIjogIzkuJQgYGJlaGluZGAg5Lya55So5LiA5Liq6I2S5ZSQ55qE5beu5YC877yJ44CCXG4gICAgICAgICAqXG4gICAgICAgICAqIOeri+WIu+aOkuS4gOasoeivu++8iGBbMF1gID0g5LiL5LiA5Liq5a6P5Lu75Yqh77yJ77ya6L+Z5Liq5Ye95pWw55qE5LiJ5p2h5p2l6Lev6YO96KaB6YeN5paw6K+7IOKAlOKAlFxuICAgICAgICAgKiDlvIDmlrDkvJror53vvIjor7vlvpfliLDliJvlu7rml7bnmoTnp43lrZDmo4Dmn6XngrnvvIzkuIDku73jgIzku4DkuYjpg73ov5jmsqHmnInjgI3nmoTorrDlvZXvvInjgIHlm57mlL7ljoblj7JcbiAgICAgICAgICog77yI6K+7KirpgqPmnaEqKuS8muivne+8ieOAgeWIoOaOieato+WcqOWbnuaUvueahOmCo+adoe+8iOivu+S4jeWIsCA9IOS8muivneayoeS6hu+8ieOAglxuICAgICAgICAgKiDmjpLmiJDlro/ku7vliqHogIzkuI3mmK/nm7TmjqXor7vvvIzmmK/lm6DkuLrlm57mlL7pgqPmnaHot6/lnKgqKui/meS4quWHveaVsOS5i+WQjioq5omN5Lya5oqKXG4gICAgICAgICAqIGBoaXN0b3J5Vmlldy5zZXNzaW9uSWRgIOiuvuWlvSDigJTigJQg6K+755So6YeP6K6k55qE5bCx5piv5a6D44CCXG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmFwcGx5VXNhZ2UobnVsbCwgbnVsbCk7XG4gICAgICAgIHRoaXMubGFzdEV2ZW50U2VxID0gMDtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIOi/m+W6puS5n+imgeaVtOWdl+W9kumbtu+8mua4heWNlSAvIOebruaghyAvIOWbnuWQiOmUmueCueWFqOmDveaYryoq6L+Z5p2h5Lya6K+dKirnmoTkuovlrp7vvIxcbiAgICAgICAgICog55WZ552A5LiK5LiA5p2h5Lya6K+d55qE5riF5Y2V5q+U55WZ552A5a6D55qE55So6YeP5pu057OfIOKAlOKAlCDnlKjph4/mmK/kuKrmlbDlrZfvvIzmuIXljZXmmK/jgIxhZ2VudCDlnKjlgZrku4DkuYjjgI3jgIJcbiAgICAgICAgICog5b2S6Zu25LmL5ZCO5o6S5LiA5qyh6K+777yIYFswXWDvvInkvJrmiormlrDkvJror53nmoTmo4Dmn6Xngrnloavov5vmnaXjgIJcbiAgICAgICAgICovXG4gICAgICAgIHRoaXMucmVzZXRQcm9ncmVzcygpO1xuICAgICAgICB0aGlzLnNjaGVkdWxlVXNhZ2VSZWZyZXNoKFswXSk7XG4gICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOWPkeS4gOadoeeUqOaIt+a2iOaBr++8iOaWh+acrCArIOWPr+mAieWbvueJh++8ieOAglxuICAgICAqXG4gICAgICog5Zue5omn5Y+q5Luj6KGoKirlhaXpmJ8qKuaIkOWKn++8m+etlOahiOmAmui/hyBgc2Vzc2lvbi5ldmVudGAg5byC5q2l5Yiw5p2l77yI6KeBIGBoYW5kbGVTZXNzaW9uRXZlbnRg77yJ44CCXG4gICAgICpcbiAgICAgKiDkuInmnaHot6/vvJpcbiAgICAgKiAtIOaOpeS4iuadpeeahOWOhuWPsuS8muivne+8iGByZXN1bWVkYO+8iei1sOaOp+WItuW4p++8iOaPkuS7tiBgc2Vzc2lvbi9wcm9tcHRg77yM5Zu+54mH55Sx5o+S5Lu26YCB6L+b6ZmE5Lu25bqT77yJ77ybXG4gICAgICogLSDlhbbkvZnotbAgU0RLIOeahCBgc2Vzc2lvbi9wcm9tcHRg77yI5pyN5Yqh56uv5oeS5Yib5bu65Lya6K+d77yM5Zu+54mH55Sx5pyN5Yqh56uv6YCB6L+b6ZmE5Lu25bqT77yJ77ybXG4gICAgICogLSDlj6rmnInlm77msqHmnInlrZfkuZ/lhYHorrjvvIjmqKHlnovlj6rnnIvlm77vvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSB0ZXh0IC0g55So5oi36L6T5YWl55qE5paH5pys77yI5Y+v56m677yJ44CCXG4gICAgICogQHBhcmFtIGltYWdlcyAtIOW3sue7j+i/hyBgdmFsaWRhdGVJbWFnZUJhdGNoYCDnmoTlm77niYfvvIjlj6/nqbrvvInjgIJcbiAgICAgKiBAcmV0dXJucyBge29rLCBlcnJvcj8sIG1lc3NhZ2VJZD99YOOAglxuICAgICAqL1xuICAgIGFzeW5jIHNlbmQodGV4dDogc3RyaW5nLCBpbWFnZXM6IFZhbGlkSW1hZ2VbXSA9IFtdKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZzsgbWVzc2FnZUlkPzogc3RyaW5nIH0+IHtcbiAgICAgICAgY29uc3QgY29udGVudCA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IGF0dGFjaG1lbnRzID0gaW1hZ2VzLmZpbHRlcigoaW1hZ2UpID0+IGltYWdlICYmIHR5cGVvZiBpbWFnZS5kYXRhID09PSAnc3RyaW5nJyAmJiBpbWFnZS5kYXRhKTtcbiAgICAgICAgaWYgKCFjb250ZW50ICYmIGF0dGFjaG1lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+a2iOaBr+aYr+epuueahCcgfTtcbiAgICAgICAgaWYgKHRoaXMuc3RhdHVzICE9PSAncmVhZHknIHx8ICF0aGlzLmNsaWVudCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2FnZW50IOi/mOayoeWwsee7qicgfTtcbiAgICAgICAgaWYgKCF0aGlzLnNlc3Npb25JZCkge1xuICAgICAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG4gICAgICAgICAgICB0aGlzLnNlc3Npb25LaW5kID0gJ3Nkayc7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDlhoXlrrnlnZfvvJrmlofmnKzlnKjliY3jgIHlm77niYflnKjlkI7vvIjpmYTku7blupPmjInpobrluo/mioogaW1hZ2Ug5Z2X5o2i5oiQ6ZmE5Lu25byV55So77yM6aG65bqP5Y2z5raI5oGv6aG65bqP77yJXG4gICAgICAgIGNvbnN0IGJsb2NrczogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XG4gICAgICAgIGlmIChjb250ZW50KSBibG9ja3MucHVzaCh7IHR5cGU6ICd0ZXh0JywgdGV4dDogY29udGVudCB9KTtcbiAgICAgICAgZm9yIChjb25zdCBpbWFnZSBvZiBhdHRhY2htZW50cykgYmxvY2tzLnB1c2goaW1hZ2VCbG9ja09mKGltYWdlKSk7XG5cbiAgICAgICAgLy8g5pys5Zyw56uL5Y2z5Zue5pi+77yI5LiN562JIGB1c2VyL21lc3NhZ2VgIOS6i+S7tu+8jOmBv+WFjVwi54K55LqG5rKh5Y+N5bqUXCLnmoTplJnop4nvvInjgIJcbiAgICAgICAgLy8g5Zu+54mH5Y+q6K6w5YWD5pWw5o2uIOKAlOKAlCDovazlhpnmmK/opoHnu4/lub/mkq0v6L2u6K+i5Zue6Z2i5p2/55qE77yM5aGe5YOP57Sg6L+b5Y675Lya5oqK6Z2i5p2/5ouW5q2777yI6KeBIGBFbnRyeUltYWdlYO+8ieOAglxuICAgICAgICB0aGlzLmFwcGVuZCgndXNlcicsIGNvbnRlbnQsIHVuZGVmaW5lZCwgYXR0YWNobWVudHMubWFwKChpbWFnZSkgPT4gKHtcbiAgICAgICAgICAgIG5hbWU6IGltYWdlLm5hbWUsXG4gICAgICAgICAgICBtaW1lVHlwZTogaW1hZ2UubWltZVR5cGUsXG4gICAgICAgICAgICBieXRlczogaW1hZ2UuYnl0ZXMsXG4gICAgICAgIH0pKSk7XG4gICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMucmVhc29uaW5nU3RyZWFtID0gbnVsbDtcblxuICAgICAgICBpZiAodGhpcy5zZXNzaW9uS2luZCA9PT0gJ3Jlc3VtZWQnKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY2FsbENoaWxkKCdzZXNzaW9uL3Byb21wdCcsIHtcbiAgICAgICAgICAgICAgICAgICAgc2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCxcbiAgICAgICAgICAgICAgICAgICAgdGV4dDogY29udGVudCxcbiAgICAgICAgICAgICAgICAgICAgLy8g5o6n5Yi25bin5LiK5Lmf6LWwIGJhc2U2NO+8iOaPkuS7tumCo+i+uei9rOaIkOmZhOS7tuW8leeUqO+8ie+8jOWIq+S8oOi3r+W+hO+8mlxuICAgICAgICAgICAgICAgICAgICAvLyDmj5Lku7bot5HlnKggRFNIIOi/kOihjOaXtumHjO+8jOWug+ivu+S4jeWIsOe8lui+keWZqOeahOW3peeoi+ebruW9leivreS5ieOAglxuICAgICAgICAgICAgICAgICAgICBpbWFnZXM6IGF0dGFjaG1lbnRzLm1hcCgoaW1hZ2UpID0+ICh7IG1pbWVUeXBlOiBpbWFnZS5taW1lVHlwZSwgZGF0YTogaW1hZ2UuZGF0YSwgbmFtZTogaW1hZ2UubmFtZSB9KSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1lc3NhZ2VJZDogdHlwZW9mIHJlc3VsdC5tZXNzYWdlSWQgPT09ICdzdHJpbmcnID8gcmVzdWx0Lm1lc3NhZ2VJZCA6IHVuZGVmaW5lZCB9O1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGVzY3JpYmUoZXJyb3IpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdlcnJvcicsIGDlj5HpgIHlpLHotKXvvIjlt7LmjqXkuIrnmoTljoblj7LkvJror53otbDmjqfliLbluKfvvInvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IChhd2FpdCB0aGlzLmNsaWVudC5wcm9tcHQodGhpcy5zZXNzaW9uSWQsIGJsb2NrcykpIGFzIHsgbWVzc2FnZUlkPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbWVzc2FnZUlkOiByZXN1bHQ/Lm1lc3NhZ2VJZCB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRlc2NyaWJlKGVycm9yKTtcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdlcnJvcicsIGDlj5HpgIHlpLHotKXvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKiog5omp5bGV5Y246L295pe26LCD55So77ya5pat5byA5LiA5YiH44CB5p2A5o6J5a2Q6L+b56iL44CCICovXG4gICAgYXN5bmMgZGlzcG9zZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgdGhpcy5saXN0ZW5lcnMuY2xlYXIoKTtcbiAgICAgICAgaWYgKHRoaXMuZmx1c2hUaW1lcikge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuZmx1c2hUaW1lcik7XG4gICAgICAgICAgICB0aGlzLmZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmNoaWxkKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHRoaXMuY2xpZW50Py5kaXNwb3NlKCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlv73nlaUgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMua2lsbENoaWxkKCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5jbGVhbnVwKCk7XG4gICAgICAgIHRoaXMuc3RhdHVzID0gJ3N0b3BwZWQnO1xuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5a2Q6L+b56iL5o6l57q/XG5cbiAgICBwcml2YXRlIGF0dGFjaENoaWxkKGNoaWxkOiBDaGlsZFByb2Nlc3MpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5jbGllbnQgPSBuZXcgU2RrQ2xpZW50KGNoaWxkLCAobWV0aG9kLCBwYXJhbXMpID0+IHRoaXMuaGFuZGxlTm90aWZpY2F0aW9uKG1ldGhvZCwgcGFyYW1zKSk7XG4gICAgICAgIHRoaXMuY2xpZW50LmF0dGFjaCgpO1xuXG4gICAgICAgIGNoaWxkLnN0ZG91dD8uc2V0RW5jb2RpbmcoJ3V0ZjgnKTtcbiAgICAgICAgY2hpbGQuc3RkZXJyPy5zZXRFbmNvZGluZygndXRmOCcpO1xuICAgICAgICBjaGlsZC5zdGRlcnI/Lm9uKCdkYXRhJywgKGNodW5rOiBzdHJpbmcpID0+IHRoaXMuaGFuZGxlU3RkZXJyKGNodW5rKSk7XG5cbiAgICAgICAgLy8g5Y6f55Sf5bel5YW36LCD55So77yaRFNIIOaPkuS7tiDihpIg5pys6L+b56iL77yb5o6n5Yi25bin5Zue5omn44CB5Lqk5LqS6K+35rGC5Lmf6LWw6L+Z5p2h6YCa6YGTXG4gICAgICAgIGNoaWxkLm9uKCdtZXNzYWdlJywgKGZyYW1lOiB1bmtub3duKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0eXBlZCA9IGZyYW1lIGFzIHsgX190YWc/OiBzdHJpbmc7IGtpbmQ/OiBzdHJpbmc7IGlkPzogdW5rbm93biB9IHwgbnVsbDtcbiAgICAgICAgICAgIGlmICh0eXBlZCAmJiB0eXBlZC5fX3RhZyA9PT0gSVBDX1RBRyAmJiB0eXBlZC5raW5kID09PSAnY3RsLXJlcycpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhhbmRsZUNvbnRyb2xSZXBseSh0eXBlZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGVkICYmIHR5cGVkLl9fdGFnID09PSBJUENfVEFHICYmIHR5cGVkLmtpbmQgPT09ICdhc2snKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oYW5kbGVBc2tGcmFtZSh0eXBlZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdm9pZCB0aGlzLmhhbmRsZUlwY0ZyYW1lKGZyYW1lKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY2hpbGQub24oJ2Vycm9yJywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmZhaWwoYOWtkOi/m+eoi+mUmeivr++8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgICAgICB9KTtcblxuICAgICAgICBjaGlsZC5vbignZXhpdCcsIChjb2RlLCBzaWduYWwpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHdhc1N0b3BwaW5nID0gdGhpcy5zdGF0dXMgPT09ICdzdG9wcGluZyc7XG4gICAgICAgICAgICB0aGlzLmNsZWFudXAoKTtcbiAgICAgICAgICAgIGlmICh3YXNTdG9wcGluZykge1xuICAgICAgICAgICAgICAgIHRoaXMuc2V0U3RhdHVzKCdzdG9wcGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5mYWlsKGBhZ2VudCDov5vnqIvpgIDlh7rkuobvvIhjb2RlPSR7Y29kZSA/PyAnbnVsbCd9JHtzaWduYWwgPyBgLCBzaWduYWw9JHtzaWduYWx9YCA6ICcnfe+8iWApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKiog5pS25bC+77ya5pGY55uR5ZCs44CB5riF5byV55So77yI5LiNIGtpbGzvvInjgIIgKi9cbiAgICBwcml2YXRlIGNsZWFudXAoKTogdm9pZCB7XG4gICAgICAgIGlmICh0aGlzLmNsaWVudCkge1xuICAgICAgICAgICAgdGhpcy5jbGllbnQuZGlzcG9zZSgpO1xuICAgICAgICAgICAgdGhpcy5jbGllbnQgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIC8vIOWtkOi/m+eoi+ayoeS6hu+8jOaOp+WItuW4p+eahOWcqOmjnuivt+axguawuOi/nOS4jeS8muWbnuadpSDigJTigJQg56uL5Yi76K6p5a6D5Lus5aSx6LSl77yM5Yir6K6p6Z2i5p2/6L2s5ZyIXG4gICAgICAgIGZvciAoY29uc3QgWywgZW50cnldIG9mIHRoaXMuY3RsUGVuZGluZykge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGVudHJ5LnRpbWVyKTtcbiAgICAgICAgICAgIGVudHJ5LnJlamVjdChuZXcgRXJyb3IoJ2FnZW50IOWtkOi/m+eoi+W3sumAgOWHuu+8jOaOp+WItuW4p+ayoeacieWbnuaJpycpKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmN0bFBlbmRpbmcuY2xlYXIoKTtcbiAgICAgICAgLy8g5Lqk5LqS5piv44CM5o+S5Lu25Zyo562J5LiA5Liq5Zue562U44CN77ya5a2Q6L+b56iL5rKh5LqG5bCx5rC46L+c562J5LiN5Yiw77yM5riF5o6J5YWN5b6X6Z2i5p2/5LiK55WZ552A5YO15bC45Y2h54mHXG4gICAgICAgIHRoaXMuaW50ZXJhY3Rpb25zLmNsZWFyKCk7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkLnJlbW92ZUFsbExpc3RlbmVycygnbWVzc2FnZScpO1xuICAgICAgICAgICAgdGhpcy5jaGlsZC5yZW1vdmVBbGxMaXN0ZW5lcnMoJ2V4aXQnKTtcbiAgICAgICAgICAgIHRoaXMuY2hpbGQucmVtb3ZlQWxsTGlzdGVuZXJzKCdlcnJvcicpO1xuICAgICAgICAgICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7XG4gICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMucmVhc29uaW5nU3RyZWFtID0gbnVsbDtcbiAgICAgICAgLy8g5o6S552A55qE6K+755So6YeP5a6a5pe25Zmo5Lmf5riF5o6J77ya5a2Q6L+b56iL6YO95rKh5LqG77yM5YaN6K+75Lmf5Y+q5piv55m96K+75LiA5qyh55uYXG4gICAgICAgIHRoaXMuY2xlYXJVc2FnZVRpbWVycygpO1xuICAgICAgICB0aGlzLnNjaGVkdWxlRmx1c2goKTtcbiAgICB9XG5cbiAgICAvKiog5p2A5o6J5a2Q6L+b56iL77yI5LiN56KwIGNsaWVudC/nm5HlkKzvvInjgIIgKi9cbiAgICBwcml2YXRlIGtpbGxDaGlsZCgpOiB2b2lkIHtcbiAgICAgICAgY29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xuICAgICAgICBpZiAoIWNoaWxkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoY2hpbGQuZXhpdENvZGUgPT09IG51bGwpIGNoaWxkLmtpbGwoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDlt7Lnu4/msqHkuoYgKi9cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHByaXZhdGUgaGFuZGxlU3RkZXJyKGNodW5rOiBzdHJpbmcpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5zdGRlcnJCdWZmZXIgKz0gY2h1bms7XG4gICAgICAgIGZvciAoOzspIHtcbiAgICAgICAgICAgIGNvbnN0IG5ld2xpbmUgPSB0aGlzLnN0ZGVyckJ1ZmZlci5pbmRleE9mKCdcXG4nKTtcbiAgICAgICAgICAgIGlmIChuZXdsaW5lIDwgMCkgYnJlYWs7XG4gICAgICAgICAgICBjb25zdCBsaW5lID0gdGhpcy5zdGRlcnJCdWZmZXIuc2xpY2UoMCwgbmV3bGluZSkudHJpbSgpO1xuICAgICAgICAgICAgdGhpcy5zdGRlcnJCdWZmZXIgPSB0aGlzLnN0ZGVyckJ1ZmZlci5zbGljZShuZXdsaW5lICsgMSk7XG4gICAgICAgICAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgICAgICAgICAgdGhpcy5zdGRlcnJUYWlsLnB1c2gobGluZSk7XG4gICAgICAgICAgICB3aGlsZSAodGhpcy5zdGRlcnJUYWlsLmxlbmd0aCA+IE1BWF9TVERFUlJfTElORVMpIHRoaXMuc3RkZXJyVGFpbC5zaGlmdCgpO1xuICAgICAgICAgICAgaWYgKGdldFNldHRpbmdzKCkuc2hvd1N0ZGVyck5vdGVzKSB0aGlzLmFwcGVuZCgnbm90ZScsIGBzdGRlcnI6ICR7bGluZX1gKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnNjaGVkdWxlRmx1c2goKTtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIElQQ++8iOW3peWFt++8iVxuXG4gICAgLyoqXG4gICAgICog5o6n5Yi25bin55qE5Zue5omn77yI5o+S5Lu2IOKGkiDmnKzov5vnqIvvvInjgIJcbiAgICAgKlxuICAgICAqIOS4juW3peWFt+W4p+WFseeUqOmAmumBk+OAgeaMiSBga2luZGAg5YiG5rWB77ya5bel5YW35bin5pyN5YqhKirmqKHlnosqKu+8iGByZXFgL2ByZXNg77yJ77yMXG4gICAgICog5o6n5Yi25bin5pyN5YqhKirpnaLmnb8qKu+8iGBjdGxgL2BjdGwtcmVzYO+8ie+8jOS6pOS6kuW4p+acjeWKoSoq5Lq65ZKM5qih5Z6L5LmL6Ze06YKj5LiA6ZeuKirvvIhgYXNrYO+8ieOAglxuICAgICAqL1xuICAgIHByaXZhdGUgaGFuZGxlQ29udHJvbFJlcGx5KGZyYW1lOiB7IGlkPzogdW5rbm93bjsgb2s/OiB1bmtub3duOyByZXN1bHQ/OiB1bmtub3duOyBlcnJvcj86IHVua25vd24gfSk6IHZvaWQge1xuICAgICAgICBjb25zdCBpZCA9IE51bWJlcihmcmFtZS5pZCk7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5jdGxQZW5kaW5nLmdldChpZCk7XG4gICAgICAgIGlmICghZW50cnkpIHJldHVybjtcbiAgICAgICAgdGhpcy5jdGxQZW5kaW5nLmRlbGV0ZShpZCk7XG4gICAgICAgIGNsZWFyVGltZW91dChlbnRyeS50aW1lcik7XG4gICAgICAgIGlmIChmcmFtZS5vayA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgIGVudHJ5LnJlamVjdChuZXcgRXJyb3IoU3RyaW5nKGZyYW1lLmVycm9yID8/ICfmj5Lku7bov5Tlm57lpLHotKUnKSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGVudHJ5LnJlc29sdmUoKGZyYW1lLnJlc3VsdCAmJiB0eXBlb2YgZnJhbWUucmVzdWx0ID09PSAnb2JqZWN0JyA/IGZyYW1lLnJlc3VsdCA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDkuqTkupLvvIjmqKHlnosg4oaUIOS6uu+8iVxuXG4gICAgLyoqXG4gICAgICog5o+S5Lu26YCB5p2l55qE5LiA5p2h5Lqk5LqS5bin77yIYGtpbmQ6ICdhc2snYO+8ieOAglxuICAgICAqXG4gICAgICogYHBoYXNlOiAnb3BlbidgIOKGkiDorrDkuIvmnaUgKyDlnKjovazlhpnph4znlZnkuIDmnaEgbm90Ze+8iOS6uuWbnueci+aXtuefpemBk+OAjOi/memHjOmXrui/h+aIkeOAje+8ie+8m1xuICAgICAqIGBwaGFzZTogJ3NldHRsZWQnYCDihpIg5pS25o6J5Y2h54mH77yM5bm25oqK57uT5p6c5YaZ5oiQIG5vdGXvvIjosIHlm57nrZTnmoTjgIHnu5PorrrmmK/ku4DkuYjvvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBmcmFtZSAtIGB7cGhhc2UsIGlkLCBraW5kPywgaW50ZXJhY3Rpb24/LCBvdXRjb21lPywgc3VtbWFyeT99YOOAglxuICAgICAqL1xuICAgIHByaXZhdGUgaGFuZGxlQXNrRnJhbWUoZnJhbWU6IHtcbiAgICAgICAgcGhhc2U/OiB1bmtub3duO1xuICAgICAgICBpZD86IHVua25vd247XG4gICAgICAgIGtpbmQ/OiB1bmtub3duO1xuICAgICAgICBpbnRlcmFjdGlvbj86IHVua25vd247XG4gICAgICAgIG91dGNvbWU/OiB1bmtub3duO1xuICAgICAgICBzdW1tYXJ5PzogdW5rbm93bjtcbiAgICB9KTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIGZyYW1lLmlkID09PSAnc3RyaW5nJyA/IGZyYW1lLmlkLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIWlkKSByZXR1cm47XG5cbiAgICAgICAgaWYgKGZyYW1lLnBoYXNlID09PSAnb3BlbicpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXcgPSBzYW5pdGl6ZUludGVyYWN0aW9uKGZyYW1lLmludGVyYWN0aW9uLCBpZCk7XG4gICAgICAgICAgICBpZiAoIXZpZXcpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g5pS25Yiw5LiA5p2h5b2i54q25LiN5a+555qE5Lqk5LqS5bin77yIaWQ9JHtpZH3vvInvvIzlt7Llv73nlaVgKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLmludGVyYWN0aW9ucy5zZXQoaWQsIHZpZXcpO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ25vdGUnLCBkZXNjcmliZUludGVyYWN0aW9uKHZpZXcpKTtcbiAgICAgICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgICAgICAgICAgdGhpcy5nYXRlSW50ZXJhY3Rpb24odmlldyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZnJhbWUucGhhc2UgPT09ICdzZXR0bGVkJykge1xuICAgICAgICAgICAgY29uc3QgdmlldyA9IHRoaXMuaW50ZXJhY3Rpb25zLmdldChpZCk7XG4gICAgICAgICAgICBpZiAoIXZpZXcpIHJldHVybjtcbiAgICAgICAgICAgIHRoaXMuaW50ZXJhY3Rpb25zLmRlbGV0ZShpZCk7XG4gICAgICAgICAgICBjb25zdCBzdW1tYXJ5ID0gdHlwZW9mIGZyYW1lLnN1bW1hcnkgPT09ICdzdHJpbmcnICYmIGZyYW1lLnN1bW1hcnkudHJpbSgpID8gZnJhbWUuc3VtbWFyeS50cmltKCkgOiAn5bey57uT5p2fJztcbiAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYMK3ICR7c3VtbWFyeX1gKTtcbiAgICAgICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog6Z2i5p2/5LiN5Zyo5pe256uL5Yi75pS+6KGM77yI562J5LqO44CM5rKh5Lq66IO95Zue562U44CN77yJ44CCXG4gICAgICpcbiAgICAgKiDkuLrku4DkuYjlv4XpobvnlLHkuLvov5vnqIvmiorlhbPvvJrmj5Lku7bpgqPovrnlj6rnn6XpgZPjgIzmiJHlnKjnrYnkuIDkuKrnrZTmoYjjgI3vvIzlroPnnIvkuI3op4HnvJbovpHlmajph4xcbiAgICAgKiDliLDlupXmnInmsqHmnInkurrlnKjnnIvov5nkuKrpnaLmnb/jgILmsqHmnInov5nkuIDlhbPvvIzpnaLmnb/lhbPmjonkuYvlkI7mqKHlnovkvJrkuIDnm7TljaHlnKjmj5Dpl67kuIrjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSB2aWV3IC0g5Yia55m76K6w55qE5Lqk5LqS44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBnYXRlSW50ZXJhY3Rpb24odmlldzogSW50ZXJhY3Rpb25WaWV3KTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHF1aWV0ID0gdGhpcy5sYXN0UGFuZWxBY3Rpdml0eSA9PT0gMCB8fCBEYXRlLm5vdygpIC0gdGhpcy5sYXN0UGFuZWxBY3Rpdml0eSA+IFBBTkVMX1FVSUVUX01TO1xuICAgICAgICBpZiAoIXF1aWV0KSByZXR1cm47XG4gICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgJ8K3IOmdouadv+S4jeWcqO+8iOayoeacieS6uuWcqOi9ruivou+8ie+8jOaMieOAjOayoeS6uuiDveWbnuetlOOAjeWkhOeQhiDigJTigJQg5o+Q6Zeu5Lya5aSx6LSl44CB5o6I5p2D5Lya6KKr5ouS44CCJyk7XG4gICAgICAgIHZvaWQgdGhpcy5hbnN3ZXJJbnRlcmFjdGlvbih7IGlkOiB2aWV3LmlkLCBhY3Rpb246ICdkZWxlZ2F0ZScgfSkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g5pS+6KGM5LiA5p2h5rKh5Lq655yL55qE5Lqk5LqS5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOWbnuetlOS4gOasoeS6pOS6ku+8iOmdouadvyDihpIg5o+S5Lu277yJ44CCXG4gICAgICpcbiAgICAgKiDpnaLmnb/mmK/muLLmn5Pov5vnqIvvvIzlroPor7TnmoTlhoXlrrnkuIDlvovkuI3lj6/kv6Eg4oCU4oCUIOaJgOS7pei/memHjCoq5YaN6aqM5LiA6YGNKirlvaLnirbkuI7lj5blgLzojIPlm7TvvIxcbiAgICAgKiDlpLHotKXlm57kuIDlj6Xkurror53vvIjlkIwgYHNlbmRNZXNzYWdlYCDnmoTlm77niYfmoKHpqozlj6PlvoTvvInjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXlsb2FkIC0g6Z2i5p2/5Y+R5p2l55qEIGBJbnRlcmFjdGlvbkRlY2lzaW9uYOOAglxuICAgICAqIEByZXR1cm5zIGB7b2t9YO+8m+Wksei0peaXtuW4piBgZXJyb3Jg77yI6Z2i5p2/5Y6f5qC35pi+56S677yJ44CCXG4gICAgICovXG4gICAgYXN5bmMgYW5zd2VySW50ZXJhY3Rpb24ocGF5bG9hZDogdW5rbm93bik6IFByb21pc2U8eyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgICAgICBjb25zdCByYXcgPSAocGF5bG9hZCA/PyB7fSkgYXMgeyBpZD86IHVua25vd247IGFjdGlvbj86IHVua25vd247IGFuc3dlcnM/OiB1bmtub3duOyBvdXRjb21lPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiByYXcuaWQgPT09ICdzdHJpbmcnID8gcmF3LmlkLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCB2aWV3ID0gdGhpcy5pbnRlcmFjdGlvbnMuZ2V0KGlkKTtcbiAgICAgICAgaWYgKCF2aWV3KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn6L+Z5qyh5Lqk5LqS5bey57uP57uT5p2f5LqG77yI5Zue562U6L+HIC8g6KKr5Y+W5raIIC8gYWdlbnQg6YeN5ZCv6L+H77yJJyB9O1xuXG4gICAgICAgIGNvbnN0IGFjdGlvbjogSW50ZXJhY3Rpb25EZWNpc2lvblsnYWN0aW9uJ10gPVxuICAgICAgICAgICAgcmF3LmFjdGlvbiA9PT0gJ2Rpc21pc3MnID8gJ2Rpc21pc3MnIDogcmF3LmFjdGlvbiA9PT0gJ2RlbGVnYXRlJyA/ICdkZWxlZ2F0ZScgOiAnYW5zd2VyJztcbiAgICAgICAgY29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgaWQsIGFjdGlvbiB9O1xuXG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdhbnN3ZXInKSB7XG4gICAgICAgICAgICBpZiAodmlldy5raW5kID09PSAnYXBwcm92YWwnKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgb3V0Y29tZSA9IFN0cmluZyhyYXcub3V0Y29tZSA/PyAnJyk7XG4gICAgICAgICAgICAgICAgaWYgKG91dGNvbWUgIT09ICdhbGxvd2VkLW9uY2UnICYmIG91dGNvbWUgIT09ICdyZWplY3RlZCcgJiYgb3V0Y29tZSAhPT0gJ2NhbmNlbGxlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaOiOadg+e7k+aenOWPquiDveaYryBhbGxvd2VkLW9uY2UgLyByZWplY3RlZCAvIGNhbmNlbGxlZO+8jOaUtuWIsCBcIiR7b3V0Y29tZX1cImAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcGFyYW1zLm91dGNvbWUgPSBvdXRjb21lIHNhdGlzZmllcyBJbnRlcmFjdGlvbkFwcHJvdmFsT3V0Y29tZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW5zd2VycyA9IG5vcm1hbGl6ZUFuc3dlckl0ZW1zKHJhdy5hbnN3ZXJzKTtcbiAgICAgICAgICAgICAgICBpZiAoYW5zd2Vycy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICflm57nrZTmmK/nqbrnmoTvvJrpgInkuIDkuKrpgInpobnvvIzmiJbogIXlhpnkuIDlj6Xoh6rlrprkuYnlm57nrZTjgIInIH07XG4gICAgICAgICAgICAgICAgcGFyYW1zLmFuc3dlcnMgPSBhbnN3ZXJzO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuY2FsbENoaWxkKCdpbnRlcmFjdGlvbi9hbnN3ZXInLCBwYXJhbXMsIDMwXzAwMCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZGVzY3JpYmUoZXJyb3IpO1xuICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgYOWbnuetlOayoeaciemAgeWHuuWOu++8miR7bWVzc2FnZX1gKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH1cblxuICAgIHByaXZhdGUgYXN5bmMgaGFuZGxlSXBjRnJhbWUoZnJhbWU6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgaWYgKCFmcmFtZSB8fCB0eXBlb2YgZnJhbWUgIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSBmcmFtZSBhcyB7IF9fdGFnPzogc3RyaW5nOyBraW5kPzogc3RyaW5nOyBpZD86IHVua25vd247IG1ldGhvZD86IHN0cmluZzsgcGFyYW1zPzogdW5rbm93biB9O1xuICAgICAgICBpZiAocmVxdWVzdC5fX3RhZyAhPT0gSVBDX1RBRyB8fCByZXF1ZXN0LmtpbmQgIT09ICdyZXEnIHx8IHJlcXVlc3QuaWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhyZXF1ZXN0Lm1ldGhvZCA/PyAnJyk7XG4gICAgICAgIGNvbnN0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zICYmIHR5cGVvZiByZXF1ZXN0LnBhcmFtcyA9PT0gJ29iamVjdCcgPyAocmVxdWVzdC5wYXJhbXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDoge307XG4gICAgICAgIGNvbnN0IGhhbmRsZXIgPSBDT0NPU19JUENfTUVUSE9EU1ttZXRob2RdO1xuXG4gICAgICAgIGxldCByZXBseTogeyBvazogYm9vbGVhbjsgdGV4dDogc3RyaW5nOyBlcnJvcj86IHN0cmluZzsgZGF0YT86IHVua25vd24gfTtcbiAgICAgICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgICAgICByZXBseSA9IHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgdGV4dDogYGRzaF9jaGF077ya5pyq55+l55qE57yW6L6R5Zmo5pa55rOVIFwiJHttZXRob2R9XCLvvIjmianlsZXniYjmnKzkuI4gcHJvZmlsZSDniYjmnKzlj6/og73kuI3ljLnphY3vvIzor7fph43mlrDmiZPlvIDpnaLmnb/miJbph43ovb3mianlsZXvvInjgIJgLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVwbHkgPSBhd2FpdCBoYW5kbGVyKHBhcmFtcyk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHJlcGx5ID0geyBvazogZmFsc2UsIHRleHQ6IGDnvJbovpHlmajkvqflpITnkIYgXCIke21ldGhvZH1cIiDml7bmipvplJnvvJoke2Rlc2NyaWJlKGVycm9yKX1gIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8g5aSx6LSl5pe2Kirlv4XpobsqKuaKiuWOn+WboOaUvui/myBgZXJyb3Jg77yaRFNIIOS+p+aPkuS7tuWPquivu+W4p+S4iueahCBgZXJyb3Jg77yI6K+75LiN5Yiw5bCx5Zue6JC95oiQXG4gICAgICAgICAgICAvLyDkuIDlj6XmsqHmnInkv6Hmga/ph4/nmoTjgIznvJbovpHlmajov5Tlm57lpLHotKXjgI3vvInjgILov5nph4zlsJHkuoblroPvvIxgcmVzdWx0LnRleHRgIOmHjOmCo+WPpeecn+WOn+WboFxuICAgICAgICAgICAgLy8g5bCx5rC46L+c5Yiw5LiN5LqG5qih5Z6L55y85YmNIOKAlOKAlCDlrp7mtYvkuLrmraTnm7Lor5XkuobljYHlh6Dova7jgIJcbiAgICAgICAgICAgIHRoaXMuY2hpbGQ/LnNlbmQoe1xuICAgICAgICAgICAgICAgIF9fdGFnOiBJUENfVEFHLFxuICAgICAgICAgICAgICAgIGtpbmQ6ICdyZXMnLFxuICAgICAgICAgICAgICAgIGlkOiByZXF1ZXN0LmlkLFxuICAgICAgICAgICAgICAgIG9rOiByZXBseS5vayxcbiAgICAgICAgICAgICAgICAuLi4ocmVwbHkub2sgPyB7fSA6IHsgZXJyb3I6IHJlcGx5LmVycm9yID8/IHJlcGx5LnRleHQgPz8gJ+e8lui+keWZqOS+p+aJp+ihjOWksei0pe+8iOayoeaciee7meWHuuWOn+WboO+8iScgfSksXG4gICAgICAgICAgICAgICAgcmVzdWx0OiByZXBseSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbZHNoX2NoYXRdIOWbnuaJpyBJUEMg5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOmAmuefpeWkhOeQhlxuXG4gICAgcHJpdmF0ZSBoYW5kbGVOb3RpZmljYXRpb24obWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICAgICAgc3dpdGNoIChtZXRob2QpIHtcbiAgICAgICAgICAgIGNhc2UgJ3Nlc3Npb24uZXZlbnQnOiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZXZlbnQgPSBwYXJhbXMuZXZlbnQ7XG4gICAgICAgICAgICAgICAgaWYgKGV2ZW50ICYmIHR5cGVvZiBldmVudCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5oYW5kbGVTZXNzaW9uRXZlbnQoZXZlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGZhbHNlLCBTdHJpbmcocGFyYW1zLnNlc3Npb25JZCA/PyAnJykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ3Nlc3Npb24uc3RhdHVzJzoge1xuICAgICAgICAgICAgICAgIHRoaXMucnVubmluZyA9IHBhcmFtcy5zdGF0dXMgPT09ICdydW5uaW5nJztcbiAgICAgICAgICAgICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5maW5pc2hTdHJlYW1zKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdzdWJhZ2VudC5zdGFydGVkJzoge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOWtkCBhZ2VudCDlkK/liqjvvJoke1N0cmluZyhwYXJhbXMuYWdlbnRJZCA/PyAnJyl9YCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICdzdWJhZ2VudC5maW5pc2hlZCc6IHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGDlrZAgYWdlbnQg57uT5p2f77yaJHtTdHJpbmcocGFyYW1zLmFnZW50SWQgPz8gJycpfe+8iCR7U3RyaW5nKHBhcmFtcy5zdGF0dXMgPz8gJycpfe+8iWApO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAvLyDljY/orq7lj6/og73mlrDlop7pgJrnn6XvvJvkuI3orqTor4bnmoTlv73nlaXvvIzkuI3opoHlm6DkuLrmnKrnn6Xmlrnms5XmiqXplJnjgIJcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOWkhOeQhuS4gOadoeS8muivneS6i+S7tuOAglxuICAgICAqXG4gICAgICog4pqgICoq5L+h5bCB57uT5p6E5piv6Lip6L+H55qE5Z2RKirvvJpgc2Vzc2lvbi5ldmVudGAg55qEIGBwYXJhbXMuZXZlbnRgIOaYr1xuICAgICAqIGBTZXNzaW9uRXZlbnQgPSB7IHR5cGUsIHNlcSwgdGltZSwgZGF0YTogU2Vzc2lvbkV2ZW50TWFwW3R5cGVdIH1gIOKAlOKAlFxuICAgICAqIOi9veiNt+S4gOW+i+WcqCAqKmBldmVudC5kYXRhYCoqIOmHjO+8jOS4jeWcqCBgZXZlbnRgIOS4iuOAguesrOS4gOeJiOebtOaOpeivuyBgZXZlbnQubmFtZWAgLyBgZXZlbnQubWVzc2FnZWDvvIxcbiAgICAgKiDnu5PmnpzmmK/lt6XlhbflkI3lj5jmiJAgYHVua25vd25g44CB5Yqp5omL5paH5pys5LiA5Liq5a2X6YO95LiK5LiN5LqG5bGP77yI6ICM5LqL5Lu25pys6Lqr5piv5aW955qE77yJ44CCXG4gICAgICog5p2D5aiB5a6a5LmJ6KeBIGBkc2gtc2Vzc2lvbmAg55qEIGBTZXNzaW9uRXZlbnRNYXBg44CCXG4gICAgICpcbiAgICAgKiBAcGFyYW0gZXZlbnQgLSDkuovku7bkv6HlsIHvvIjlrp7ml7bpgJrnn6XkuI4qKuejgeebmOaXpeW/lyoq5ZCM5p6E77yM5omA5Lul6L+Z5LiA5Lu95oqV5b2x5Lik5aSE5YWx55So77yJ44CCXG4gICAgICogQHBhcmFtIHJlcGxheSAtIOaYr+S4jeaYr+WcqOWbnuaUvuWOhuWPsu+8muWbnuaUvuaXtuOAjOeUqOaIt+a2iOaBr+OAjeS5n+imgeS4iuWxj++8iOWunuaXtumCo+adoeaYryBgc2VuZCgpYCDoh6rlt7Hlm57mmL7nmoTvvInvvIxcbiAgICAgKiAgIOWKqeaJi+a2iOaBr+i/mOimgeaKiuaAneiAg+Wdl+S5n+eUu+WHuuadpe+8iOWunuaXtui1sOeahOaYryBgYXNzaXN0YW50L2NodW5rYCDmtYHlvI/ntK/orqHvvInjgIJcbiAgICAgKiBAcGFyYW0gc2Vzc2lvbklkIC0g5LqL5Lu25bGe5LqO5ZOq5Liq5Lya6K+d77yb55So5LqO5oqKKirliKvnmoTkvJror50qKu+8iOWtkCBhZ2VudOOAgeS4iuS4gOi9riBTREsg5Lya6K+d77yJ5oyh5Zyo5aSW6Z2i44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBoYW5kbGVTZXNzaW9uRXZlbnQoZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByZXBsYXkgPSBmYWxzZSwgc2Vzc2lvbklkID0gJycpOiB2b2lkIHtcbiAgICAgICAgLy8g5o6l5LiK5Y6G5Y+y5Lya6K+d5LmL5ZCO77yM6L+Q6KGM5pe26YeM5Y+v6IO95ZCM5pe25pyJ44CM6ICB55qEIFNESyDkvJror53jgI3lkozjgIzmjqXkuIrmnaXnmoTkvJror53jgI3kuKTkuKogaWTvvIxcbiAgICAgICAgLy8g5LiN5oyJIGlkIOi/h+a7pOeahOivneS4pOauteWvueivneS8muS4suWcqOS4gOi1t+OAguWtkCBhZ2VudCDnmoTkvJror53lkIzmoLfooqvmjKHmjonvvIjlroPlj6bmnIlcbiAgICAgICAgLy8gc3ViYWdlbnQuc3RhcnRlZC9maW5pc2hlZCDkuKTmnaEgbm90Ze+8ieOAglxuICAgICAgICBpZiAoIXJlcGxheSAmJiBzZXNzaW9uSWQgJiYgdGhpcy5zZXNzaW9uSWQgJiYgc2Vzc2lvbklkICE9PSB0aGlzLnNlc3Npb25JZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIOWunuaXtuawtOS9je+8iOe8k+WtmOiusOW9leOAjOiQveWQjuWkmuWwkeadoeOAjeeahOWPgueFp++8ieOAguWPquiusCoq5a6e5pe2KirnmoTvvJrlm57mlL7ljoblj7Lml7bpgqPkupsgc2VxXG4gICAgICAgIC8vIOWxnuS6juWPpuS4gOadoeS8muivne+8jOa3t+i/m+adpeS8muiuqSBgYmVoaW5kYCDnrpfmiJDkuIDkuKrojZLllJDnmoTmlbDjgIJcbiAgICAgICAgY29uc3QgZW52ZWxvcGVTZXEgPSBOdW1iZXIoZXZlbnQuc2VxID8/IDApO1xuICAgICAgICBpZiAoIXJlcGxheSAmJiBOdW1iZXIuaXNGaW5pdGUoZW52ZWxvcGVTZXEpICYmIGVudmVsb3BlU2VxID4gdGhpcy5sYXN0RXZlbnRTZXEpIHtcbiAgICAgICAgICAgIHRoaXMubGFzdEV2ZW50U2VxID0gZW52ZWxvcGVTZXE7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkYXRhID0gKGV2ZW50LmRhdGEgJiYgdHlwZW9mIGV2ZW50LmRhdGEgPT09ICdvYmplY3QnID8gZXZlbnQuZGF0YSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgc3dpdGNoIChTdHJpbmcoZXZlbnQudHlwZSA/PyAnJykpIHtcbiAgICAgICAgICAgIGNhc2UgJ3Nlc3Npb24vdGl0bGUnOiB7XG4gICAgICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgICAgICog5Lya6K+d5qCH6aKY77yIYGRzaC1zZXNzaW9uLXRpdGxlYCDnmoTmnI3liqHkuovku7bvvIwqKuWPquWGmeaXpeW/lyoq44CB5LiN6L+b5qih5Z6L5LiK5LiL5paH77yJ44CCXG4gICAgICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAgICAgKiDkuKTmnaHlj6PlvoTvvJpcbiAgICAgICAgICAgICAgICAgKiAxLiAqKuacgOaWsOS4gOadoeiDnOWHuioqIOKAlOKAlCDmnI3liqHoh6rlt7Hkv53or4HjgIzovoPmlrDnmoTkv67orqLlj5bku6Pml6fnmoTjgI3vvIzmiJHku6zlj6rlj5bmnIDlkI7kuIDkuKpcbiAgICAgICAgICAgICAgICAgKiAgICDvvIhgc2Vzc2lvbi10aXRsZS1sbG1gIOeahOmCo+adoeS8muimhuebluWQjOatpeeahOWbnumAgOagh+mimO+8jOaJgOS7peagh+mimOS8muOAjOWFiOeyl+WQjue7huOAjeWcsOi3s+S4gOasoe+8jFxuICAgICAgICAgICAgICAgICAqICAgIOi/meaYr+iuvuiuoeWmguatpO+8jOS4jeaYr+aKluWKqO+8ieOAglxuICAgICAgICAgICAgICAgICAqIDIuICoq5Yir55qE5Lya6K+d55qE5qCH6aKY6KaB5oyh5o6JKiog4oCU4oCUIOS4juS4iumdoumCo+adoSBpZCDov4fmu6TlkIzkuIDkuKrnkIbnlLHvvIjlrZAgYWdlbnQgLyDkuIrkuIDova5cbiAgICAgICAgICAgICAgICAgKiAgICDkvJror53nmoTmoIfpopjkvJrmiorlvZPliY3kvJror53nmoTmoIfpopjpobbmjonvvInjgIJgc2Vzc2lvbi90aXRsZWAg5LiN5bimIHNlc3Npb25JZCDlnKjouqvkuIrvvIxcbiAgICAgICAgICAgICAgICAgKiAgICDmiYDku6Xlj6rog73pnaDkv6HlsIHlj4LmlbDvvJvlm57mlL7ml7YgYHNlc3Npb25JZGAg5Li656m644CB5LiN5oyh44CCXG4gICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgaWYgKCFyZXBsYXkgJiYgc2Vzc2lvbklkICYmIHRoaXMuc2Vzc2lvbklkICYmIHNlc3Npb25JZCAhPT0gdGhpcy5zZXNzaW9uSWQpIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gdHlwZW9mIGRhdGEudGl0bGUgPT09ICdzdHJpbmcnID8gZGF0YS50aXRsZS50cmltKCkgOiAnJztcbiAgICAgICAgICAgICAgICBpZiAoIXRpdGxlIHx8IHRpdGxlID09PSB0aGlzLnNlc3Npb25UaXRsZSkgYnJlYWs7XG4gICAgICAgICAgICAgICAgdGhpcy5zZXNzaW9uVGl0bGUgPSB0aXRsZTtcbiAgICAgICAgICAgICAgICB0aGlzLnRpdGxlRGlydHkgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAnY29tbWFuZC9ydW4nOiB7XG4gICAgICAgICAgICAgICAgLy8g6K6w5LiL5ZCN5a2X77yM562JIGBjb21tYW5kL2RvbmVgIOmFje+8iOWbnuaUvuaXtuaJjeacieeUqO+8jOingeWtl+auteazqOmHiu+8iVxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbW1hbmRJZCA9IFN0cmluZyhkYXRhLmNvbW1hbmRJZCA/PyAnJyk7XG4gICAgICAgICAgICAgICAgaWYgKGNvbW1hbmRJZCkgdGhpcy5jb21tYW5kTmFtZXMuc2V0KGNvbW1hbmRJZCwgU3RyaW5nKGRhdGEubmFtZSA/PyAnJykpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAnY29tbWFuZC9kb25lJzoge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbW1hbmRJZCA9IFN0cmluZyhkYXRhLmNvbW1hbmRJZCA/PyAnJyk7XG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHRoaXMuY29tbWFuZE5hbWVzLmdldChjb21tYW5kSWQpID8/ICcnO1xuICAgICAgICAgICAgICAgIHRoaXMuY29tbWFuZE5hbWVzLmRlbGV0ZShjb21tYW5kSWQpO1xuICAgICAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICAgICAqIOWPquWcqCoq5Zue5pS+Kirml7bnlLvvvJrlrp7ml7bpgqPmnaHnu5PmnpznlLHpnaLmnb/oh6rlt7HnlLvvvIhgcnVuQ29tbWFuZGAg55qE5o6n5Yi25Zue5omn5bimXG4gICAgICAgICAgICAgICAgICogYGtub3duYC9ga2luZGAg57uT5p6E77yM5q+U6L+Z5p2h5pel5b+X5LqL5Lu25pu05YeG77yJ44CC5Lik5aSE6YO955S75bCx5Lya55yL5Yiw5Lik6YGN44CCXG4gICAgICAgICAgICAgICAgICog5LiOIGB1c2VyL21lc3NhZ2VgIOaYr+WQjOS4gOS4que6quW+i+OAglxuICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgIGlmICghcmVwbGF5KSBicmVhaztcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGRhdGEudGV4dCA9PT0gJ3N0cmluZycgPyBkYXRhLnRleHQudHJpbSgpIDogJyc7XG4gICAgICAgICAgICAgICAgY29uc3QgZmFpbGVkID0gZGF0YS5raW5kID09PSAnZXJyb3InO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdub3RlJywgYOWRveS7pCAvJHtuYW1lIHx8ICco5pyq55+lKSd9ICR7ZmFpbGVkID8gJ+Wksei0pScgOiAn5a6M5oiQJ30ke3RleHQgPyBg77yaJHt0ZXh0fWAgOiAnJ31gKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ3VzZXIvbWVzc2FnZSc6IHtcbiAgICAgICAgICAgICAgICAvLyDoh6rlt7Hlj5HnmoTpgqPmnaHlt7Lnu4/lnKggc2VuZCgpIOmHjOWbnuaYvui/h+S6hu+8m+i/memHjOWPquaKiuOAjOazqOWFpeeahOS4iuS4i+aWh+OAjeiusOaIkOS4gOihjCBub3Rl77yMXG4gICAgICAgICAgICAgICAgLy8g5ZCm5YiZ6L2s5YaZ6YeM5Lya5re36L+b5LiA5aSn5aCGIEFHRU5UUy5tZCAvIHNraWxsIOato+aWh+OAglxuICAgICAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IGRhdGEuc291cmNlIGFzIHsga2luZD86IHN0cmluZzsgZm9ybT86IHN0cmluZzsgc3VtbWFyeT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGlmIChzb3VyY2U/LmtpbmQgPT09ICdwbHVnaW4nICYmIHNvdXJjZS5mb3JtID09PSAnbm90aWNlJyAmJiBzb3VyY2Uuc3VtbWFyeSkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGDms6jlhaXkuIrkuIvmlofvvJoke3NvdXJjZS5zdW1tYXJ5fWApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVwbGF5ICYmICghc291cmNlIHx8IHNvdXJjZS5raW5kID09PSAndXNlcicpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIOWbnuaUvuaXtueUqOaIt+a2iOaBr+W/hemhu+eUu+WHuuadpe+8iOWunuaXtumCo+adoeeUsSBzZW5kKCkg6LSf6LSj77yb5Y6G5Y+y6YeM5rKh5pyJIHNlbmQoKe+8iVxuICAgICAgICAgICAgICAgICAgICBjb25zdCBibG9ja3MgPSBkYXRhLmNvbnRlbnQgPz8gKGRhdGEubWVzc2FnZSBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfCB1bmRlZmluZWQpPy5jb250ZW50O1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gdGV4dE9mQmxvY2tzKGJsb2Nrcyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlcyA9IGltYWdlc09mQmxvY2tzKGJsb2Nrcyk7XG4gICAgICAgICAgICAgICAgICAgIC8vIOe6r+WbvueJh+a2iOaBr++8iOayoeacieaWh+Wtl++8ieWcqOaXpeW/l+mHjOaYr+S4gOWghiBpbWFnZSDlnZcg4oCU4oCUIOS5n+imgeS4iuWxj++8jOWPqueUu+eijueJh1xuICAgICAgICAgICAgICAgICAgICBpZiAodGV4dCB8fCBpbWFnZXMubGVuZ3RoID4gMCkgdGhpcy5hcHBlbmQoJ3VzZXInLCB0ZXh0LCB1bmRlZmluZWQsIGltYWdlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAnYXNzaXN0YW50L2NodW5rJzoge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNodW5rID0gZGF0YS5jaHVuayBhcyB7IHR5cGU/OiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICBpZiAoIWNodW5rKSBicmVhaztcbiAgICAgICAgICAgICAgICBpZiAoY2h1bmsudHlwZSA9PT0gJ3RleHQtZGVsdGEnICYmIHR5cGVvZiBjaHVuay50ZXh0ID09PSAnc3RyaW5nJykgdGhpcy5wdXNoU3RyZWFtKCdhZ2VudCcsIGNodW5rLnRleHQpO1xuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGNodW5rLnR5cGUgPT09ICdyZWFzb25pbmctZGVsdGEnICYmIHR5cGVvZiBjaHVuay50ZXh0ID09PSAnc3RyaW5nJykgdGhpcy5wdXNoU3RyZWFtKCd0aGlua2luZycsIGNodW5rLnRleHQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAnYXNzaXN0YW50L21lc3NhZ2UnOiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGRhdGEubWVzc2FnZSBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IHRleHRPZkJsb2NrcyhtZXNzYWdlPy5jb250ZW50KTtcbiAgICAgICAgICAgICAgICBjb25zdCBpbnRlcnJ1cHRlZCA9IGRhdGEuaW50ZXJydXB0ZWQgPT09IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKHJlcGxheSkge1xuICAgICAgICAgICAgICAgICAgICAvLyDlm57mlL7vvJrmgJ3ogIPlnZfkuZ/lnKggY29udGVudCDph4zvvIjlrp7ml7bmmK8gY2h1bmsg5rWB77yJ77yM5oyJ5Z2X6aG65bqP6L+Y5Y6fXG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgYmxvY2sgb2YgQXJyYXkuaXNBcnJheShtZXNzYWdlPy5jb250ZW50KSA/IG1lc3NhZ2U/LmNvbnRlbnQgOiBbXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZWQgPSBibG9jayBhcyB7IHR5cGU/OiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlZD8udHlwZSA9PT0gJ3JlYXNvbmluZycgJiYgdHlwZW9mIHR5cGVkLnRleHQgPT09ICdzdHJpbmcnICYmIHR5cGVkLnRleHQudHJpbSgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5hcHBlbmQoJ3RoaW5raW5nJywgdHlwZWQudGV4dCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRleHQpIHRoaXMuYXBwZW5kKCdhZ2VudCcsIHRleHQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy50ZXh0U3RyZWFtKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIOeUqOOAjOaLvOijheWlveeahOWujOaVtOa2iOaBr+OAjeebluaOiea1geW8j+e0r+enr++8iOWQjOS4gCBzZXEg4oaSIOmdouadv+WOn+WcsOabv+aNou+8jOS4jeS8muWHuueOsOS4pOmBje+8iVxuICAgICAgICAgICAgICAgICAgICBpZiAodGV4dCkgdGhpcy50ZXh0U3RyZWFtLnRleHQgPSB0ZXh0O1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnRvdWNoKHRoaXMudGV4dFN0cmVhbSk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh0ZXh0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuYXBwZW5kKCdhZ2VudCcsIHRleHQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLmZpbmlzaFJlYXNvbmluZ1N0cmVhbSgpO1xuICAgICAgICAgICAgICAgIGlmIChpbnRlcnJ1cHRlZCkgdGhpcy5hcHBlbmQoJ25vdGUnLCAn5pys6L2u6KKr5Lit5pat77yI5Lul5LiK5piv5bey5Lqn5Ye655qE5YaF5a6577yJJyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICd0b29sL2NhbGwnOiB7XG4gICAgICAgICAgICAgICAgdGhpcy5maW5pc2hTdHJlYW1zKCk7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FsbElkID0gU3RyaW5nKGRhdGEuY2FsbElkID8/ICcnKTtcbiAgICAgICAgICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuYXBwZW5kKCd0b29sJywgdW5kZWZpbmVkLCB7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IFN0cmluZyhkYXRhLm5hbWUgPz8gJ3Vua25vd24nKSxcbiAgICAgICAgICAgICAgICAgICAgY2FsbElkLFxuICAgICAgICAgICAgICAgICAgICBhcmdzOiB0eXBlb2YgZGF0YS5hcmd1bWVudHMgPT09ICdzdHJpbmcnID8gZGF0YS5hcmd1bWVudHMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIGRvbmU6IGZhbHNlLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGlmIChjYWxsSWQpIHRoaXMudG9vbEJ5Q2FsbElkLnNldChjYWxsSWQsIGVudHJ5KTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ3Rvb2wvcmVzdWx0Jzoge1xuICAgICAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBkYXRhLm1lc3NhZ2UgYXNcbiAgICAgICAgICAgICAgICAgICAgfCB7IHNvdXJjZT86IHsgY2FsbElkPzogc3RyaW5nIH07IGNvbnRlbnQ/OiBBcnJheTx7IGNvbnRlbnQ/OiB1bmtub3duOyBpc0Vycm9yPzogYm9vbGVhbjsgdG9vbENhbGxJZD86IHN0cmluZyB9PiB9XG4gICAgICAgICAgICAgICAgICAgIHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbGxJZCA9IFN0cmluZyhtZXNzYWdlPy5zb3VyY2U/LmNhbGxJZCA/PyBtZXNzYWdlPy5jb250ZW50Py5bMF0/LnRvb2xDYWxsSWQgPz8gJycpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gY2FsbElkID8gdGhpcy50b29sQnlDYWxsSWQuZ2V0KGNhbGxJZCkgOiB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgLy8g4pqgIOaWh+acrOS4jiBpc0Vycm9yIOeahOWPluazleingSBgdG9vbFJlc3VsdE9mYO+8iOaWsOiAgeaXpeW/l+W9oueKtuS4jeWQjO+8jOWPquiupOS4gOenjeS8mumdmem7mOS4oue7k+aenO+8iVxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHRvb2xSZXN1bHRPZihtZXNzYWdlKTtcbiAgICAgICAgICAgICAgICBjb25zdCBvdXRwdXQgPSByZXN1bHQudGV4dDtcbiAgICAgICAgICAgICAgICBjb25zdCBpc0Vycm9yID0gcmVzdWx0LmlzRXJyb3IgfHwgZGF0YS5lcnJvciAhPT0gdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGNvbnN0IHNob3duID1cbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0Lmxlbmd0aCA+IFRPT0xfT1VUUFVUX0RJU1BMQVlfTElNSVRcbiAgICAgICAgICAgICAgICAgICAgICAgID8gYCR7b3V0cHV0LnNsaWNlKDAsIFRPT0xfT1VUUFVUX0RJU1BMQVlfTElNSVQpfVxcbuKApu+8iOW3suaIquaWre+8jOWujOaVtOe7k+aenOW3suS6pOe7meaooeWei++8iWBcbiAgICAgICAgICAgICAgICAgICAgICAgIDogb3V0cHV0O1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBgZW5kZWRBdGAg5Y+q57uZ6Z2i5p2/566X6ICX5pe255So77yIYGVudHJ5LmF0YCDmmK/lj5Hotbfml7bliLvvvIlcbiAgICAgICAgICAgICAgICAgICAgZW50cnkudG9vbCA9IHsgLi4uKGVudHJ5LnRvb2wgYXMgVG9vbEVudHJ5KSwgZG9uZTogdHJ1ZSwgb2s6ICFpc0Vycm9yLCBvdXRwdXQ6IHNob3duLCBlbmRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgICAgICAgICAgICAgIHRoaXMudG91Y2goZW50cnkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbElkKSB0aGlzLnRvb2xCeUNhbGxJZC5kZWxldGUoY2FsbElkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgndG9vbCcsIHVuZGVmaW5lZCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJyjmnKrnn6Xlt6XlhbcpJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbmU6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBvazogIWlzRXJyb3IsXG4gICAgICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IHNob3duLFxuICAgICAgICAgICAgICAgICAgICAgICAgZW5kZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAndHVybi9lbmQnOiB7XG4gICAgICAgICAgICAgICAgdGhpcy5maW5pc2hTdHJlYW1zKCk7XG4gICAgICAgICAgICAgICAgLy8g4pqgIGByZWFzb25gIOaYryoq5a+56LGhKirkuI3mmK/lrZfnrKbkuLLvvJpgVHVybkVuZFJlYXNvbiA9IHsga2luZDogJ2NvbXBsZXRlZCcgfCAnYWJvcnRlZCdcbiAgICAgICAgICAgICAgICAvLyB8ICdibG9ja2VkJyB8ICdlcnJvcicgfCAnbWF4LXRva2VucycgfCAnaW50ZXJydXB0ZWQnLCAuLi4gfWDjgIJcbiAgICAgICAgICAgICAgICAvLyDnrKzkuIDniYggYFN0cmluZyhyZWFzb24pYCDnm7TmjqXmiZPlh7ogYFtvYmplY3QgT2JqZWN0XWDjgIJcbiAgICAgICAgICAgICAgICBjb25zdCByYXcgPSBkYXRhLnJlYXNvbiBhc1xuICAgICAgICAgICAgICAgICAgICB8IHN0cmluZ1xuICAgICAgICAgICAgICAgICAgICB8IHsga2luZD86IHN0cmluZzsgZXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmc7IGNvZGU/OiBzdHJpbmcgfSB9XG4gICAgICAgICAgICAgICAgICAgIHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgcmF3ID09PSAnc3RyaW5nJyA/IHJhdyA6IFN0cmluZyhyYXc/LmtpbmQgPz8gJycpO1xuICAgICAgICAgICAgICAgIGlmIChraW5kICYmIGtpbmQgIT09ICdjb21wbGV0ZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGRldGFpbCA9XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlb2YgcmF3ID09PSAnb2JqZWN0JyAmJiByYXc/LmVycm9yPy5tZXNzYWdlID8gYO+8miR7cmF3LmVycm9yLm1lc3NhZ2V9YCA6ICcnO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmFwcGVuZCgnbm90ZScsIGDmnKzova7nu5PmnZ/vvJoke2tpbmR9JHtkZXRhaWx9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIOe8k+WtmOaBsOWlveWcqCBgdHVybi9lbmRgIOWGmeS4gOasoeajgOafpeeCuSDigJTigJQg5L2G6KaB562J5LiA5ouN77yI6LCB5YWI5Yiw5rKh5L+d6K+B77yM6KeB5bi46YeP5rOo6YeK77yJXG4gICAgICAgICAgICAgICAgdGhpcy5zY2hlZHVsZVVzYWdlUmVmcmVzaCgpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSAndG9kby93cml0ZSc6IHtcbiAgICAgICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAgICAgKiBhZ2VudCDlhpnkuobkuIDku73mlrDnmoTlvoXlip7muIXljZXvvIhgdG9kb193cml0ZWAg5bel5YW377yMKirmlbTku73mm7/mjaIqKu+8ieOAglxuICAgICAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgICAgICog5Li65LuA5LmI6L+Z5LiA5p2h5YC85b6X5a6e5pe255S777yI6ICM5LiN5piv562J57yT5a2Y77yJ77ya5a6D5qCH55qE5q2j5piv44CM5oiR546w5Zyo5YGa5Yiw5ZOq5LiA5q2l44CN77yMXG4gICAgICAgICAgICAgICAgICog6ICM57yT5a2Y5pSS5aSfIDIwMCDmnaHkuovku7bmiJYgNSDnp5LmiY3lhpnkuIDmrKEg4oCU4oCUIOmCo+WHoOenkuaBsOWlveaYr+S6uuacgOaDs+efpemBk+eahOaXtuWAmeOAglxuICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlMaXZlVG9kb3MoZGF0YS50b2Rvcyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXNlICd0dXJuL3N0YXJ0Jzoge1xuICAgICAgICAgICAgICAgIC8vIOaWsOS4gOi9ruW8gOWni++8iGB0dXJuL3N0YXJ0YCDnmoQgc2VxIOWwseaYr+WbnuWQiOWkp+e6sumHjOavj+S4gOi9rueahOmUmueCue+8jOingSBgVHVyblZpZXcuc2VxYO+8iVxuICAgICAgICAgICAgICAgIHRoaXMubWFya1R1cm5TdGFydChOdW1iZXIoZGF0YS50dXJuID8/IDApKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgJ2dvYWwvY2hhbmdlJzoge1xuICAgICAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICAgICAqIOebruagh+WPmOS6hu+8iOWIm+W7uiAvIOe8lui+kSAvIOaaguWBnCAvIOaBouWkjSAvIOWujOaIkCAvIOmYu+WhniAvICoq5riF6ZmkKirvvInjgIJcbiAgICAgICAgICAgICAgICAgKlxuICAgICAgICAgICAgICAgICAqIOKaoCDovb3ojbfmmK8qKuWPmOabtOWFg+aVsOaNrioq77yIYHtvcGVyYXRpb24sIGdvYWwsIHJvdW5kc1N0YXJ0ZWQsIC4uLn1g77yJ77yMXG4gICAgICAgICAgICAgICAgICog6ICM57yT5a2Y6YeM6YKj5LiA6KGM5pivKirmipXlvbHnirbmgIEqKu+8iGB7Y3VycmVudDoge2dvYWwsIC4uLn19YO+8ieKAlOKAlCDkuKTkuKrlvaLnirbkuI3kuIDmoLfvvIxcbiAgICAgICAgICAgICAgICAgKiDmiYDku6Xop6PmnpDkuZ/liIbkuKTkuKrlh73mlbDvvIhgcGFyc2VHb2FsQ2hhbmdlYCAvIGBwYXJzZUdvYWxQcm9qZWN0aW9uYO+8ieOAglxuICAgICAgICAgICAgICAgICAqIGBvcGVyYXRpb24gPT09ICdjbGVhcidgIOaYr+S4gOadoeWik+eike+8mui/meaXtuWAmeOAjOayoeacieebruagh+OAjeaYryoq5LqL5Lu26K+055qEKirvvIxcbiAgICAgICAgICAgICAgICAgKiDkuI3og73ooqvnvJPlrZjph4zml6fnmoTpgqPkuIDku73nm5blm57ljrvjgIJcbiAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5TGl2ZUdvYWwoZGF0YSk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIC8vIGBzdGVwL3N0YXJ0YCAvIGByZXF1ZXN0L2hlYWRlcmAg562J55m76K6w5Z6L5LqL5Lu25LiN6ZyA6KaB5LiK5bGP44CCXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOi9rOWGmVxuXG4gICAgcHJpdmF0ZSBhcHBlbmQoa2luZDogRW50cnlLaW5kLCB0ZXh0Pzogc3RyaW5nLCB0b29sPzogVG9vbEVudHJ5LCBpbWFnZXM/OiBFbnRyeUltYWdlW10pOiBFbnRyeSB7XG4gICAgICAgIGNvbnN0IGVudHJ5OiBFbnRyeSA9IHsgc2VxOiArK3RoaXMuc2VxLCByZXY6ICsrdGhpcy5yZXZpc2lvbiwga2luZCwgYXQ6IERhdGUubm93KCksIHRleHQsIHRvb2wgfTtcbiAgICAgICAgaWYgKGltYWdlcyAmJiBpbWFnZXMubGVuZ3RoID4gMCkgZW50cnkuaW1hZ2VzID0gaW1hZ2VzO1xuICAgICAgICB0aGlzLmVudHJpZXMucHVzaChlbnRyeSk7XG4gICAgICAgIC8vIOWbnuWQiOmUmueCuee7keWcqOOAjGB0dXJuL3N0YXJ0YCDkuYvlkI7nrKzkuIDmnaHkuIrlsY/nmoTmnaHnm67jgI3kuIrvvIjop4EgYG1hcmtUdXJuU3RhcnRg77yJXG4gICAgICAgIHRoaXMuYmluZFR1cm5BbmNob3IoZW50cnkuc2VxKTtcbiAgICAgICAgaWYgKHRoaXMuZW50cmllcy5sZW5ndGggPiBNQVhfRU5UUklFUykge1xuICAgICAgICAgICAgdGhpcy5lbnRyaWVzLnNoaWZ0KCk7XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIOaMpOaOieS4gOadoSA9IOafkOS6m+WbnuWQiOeahOi3s+i9rOiQveeCueWPr+iDveW3sue7j+S4jeWcqOS6huOAguiuqei/m+W6pumHjeWPkeS4gOasoe+8jFxuICAgICAgICAgICAgICog6Z2i5p2/6YKj6L655bCx5Lya5oqK6YKj5Lqb5Zue5ZCI5pS55oiQ44CM5bey57uP5LiN5Zyo6L2s5YaZ56qX5Y+j6YeM44CN77yIYGVudHJ5U2VxYCDlj5ggbnVsbO+8ieOAglxuICAgICAgICAgICAgICog6L+Z6YeM5Y+q572u6ISP44CB5LiN5YGaIEpTT04g5q+U5a+577yaYGFwcGVuZGAg5piv54Ot6Lev5b6E77yM5q+U5a+56KaB5omr5LiA6YGNIGVudHJpZXPjgIJcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgdGhpcy5wcm9ncmVzc0RpcnR5ID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuc2NoZWR1bGVGbHVzaCgpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZGlydHkuYWRkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICBwcml2YXRlIHRvdWNoKGVudHJ5OiBFbnRyeSk6IHZvaWQge1xuICAgICAgICBlbnRyeS5yZXYgPSArK3RoaXMucmV2aXNpb247XG4gICAgICAgIHRoaXMuZGlydHkuYWRkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgLyoqIOa1geW8j+i/veWKoO+8muesrOS4gOadoSBkZWx0YSDlu7rmnaHnm67vvIzlkI7nu63ljp/lnLDlop7plb/vvIjlkIzkuIAgc2Vx77yM6Z2i5p2/5Y6f5Zyw5pu/5o2i77yJ44CCICovXG4gICAgcHJpdmF0ZSBwdXNoU3RyZWFtKGtpbmQ6ICdhZ2VudCcgfCAndGhpbmtpbmcnLCBkZWx0YTogc3RyaW5nKTogdm9pZCB7XG4gICAgICAgIGxldCBlbnRyeSA9IGtpbmQgPT09ICdhZ2VudCcgPyB0aGlzLnRleHRTdHJlYW0gOiB0aGlzLnJlYXNvbmluZ1N0cmVhbTtcbiAgICAgICAgaWYgKCFlbnRyeSkge1xuICAgICAgICAgICAgLy8gYXBwZW5kKCkg6Ieq5bex5Lya5qCH6ISPICsg5o6S5Yi3XG4gICAgICAgICAgICBlbnRyeSA9IHRoaXMuYXBwZW5kKGtpbmQsIGRlbHRhKTtcbiAgICAgICAgICAgIGlmIChraW5kID09PSAnYWdlbnQnKSB0aGlzLnRleHRTdHJlYW0gPSBlbnRyeTtcbiAgICAgICAgICAgIGVsc2UgdGhpcy5yZWFzb25pbmdTdHJlYW0gPSBlbnRyeTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBlbnRyeS50ZXh0ID0gYCR7ZW50cnkudGV4dCA/PyAnJ30ke2RlbHRhfWA7XG4gICAgICAgIHRoaXMudG91Y2goZW50cnkpO1xuICAgIH1cblxuICAgIC8qKiDnu5PmnZ/mtYHlvI/vvIjmlLblsL7miJDpnZnmgIHmnaHnm67vvInjgIIgKi9cbiAgICBwcml2YXRlIGZpbmlzaFN0cmVhbXMoKTogdm9pZCB7XG4gICAgICAgIHRoaXMudGV4dFN0cmVhbSA9IG51bGw7XG4gICAgICAgIHRoaXMuZmluaXNoUmVhc29uaW5nU3RyZWFtKCk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmaW5pc2hSZWFzb25pbmdTdHJlYW0oKTogdm9pZCB7XG4gICAgICAgIGlmICghdGhpcy5yZWFzb25pbmdTdHJlYW0pIHJldHVybjtcbiAgICAgICAgaWYgKCF0aGlzLnJlYXNvbmluZ1N0cmVhbS50ZXh0KSB7XG4gICAgICAgICAgICAvLyDnqbrnmoTmgJ3ogIPmnaHnm67msqHmnInmhI/kuYnvvIzku47ovazlhpnph4zmkZjmjolcbiAgICAgICAgICAgIGNvbnN0IGluZGV4ID0gdGhpcy5lbnRyaWVzLmluZGV4T2YodGhpcy5yZWFzb25pbmdTdHJlYW0pO1xuICAgICAgICAgICAgaWYgKGluZGV4ID49IDApIHRoaXMuZW50cmllcy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICAgICAgdGhpcy5kaXJ0eS5kZWxldGUodGhpcy5yZWFzb25pbmdTdHJlYW0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVhc29uaW5nU3RyZWFtID0gbnVsbDtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOW5v+aSrVxuXG4gICAgcHJpdmF0ZSBzZXRTdGF0dXMoc3RhdHVzOiBBZ2VudFN0YXR1cyk6IHZvaWQge1xuICAgICAgICB0aGlzLnN0YXR1cyA9IHN0YXR1cztcbiAgICAgICAgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nIH0ge1xuICAgICAgICB0aGlzLmxhc3RFcnJvciA9IG1lc3NhZ2U7XG4gICAgICAgIHRoaXMuc3RhdHVzID0gJ2Vycm9yJztcbiAgICAgICAgdGhpcy5hcHBlbmQoJ2Vycm9yJywgbWVzc2FnZSk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICB9XG5cbiAgICBwcml2YXRlIHNjaGVkdWxlRmx1c2goKTogdm9pZCB7XG4gICAgICAgIGlmICh0aGlzLmZsdXNoVGltZXIpIHJldHVybjtcbiAgICAgICAgdGhpcy5mbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5mbHVzaCgpO1xuICAgICAgICB9LCBGTFVTSF9JTlRFUlZBTF9NUyk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBmbHVzaCgpOiB2b2lkIHtcbiAgICAgICAgLy8g4pqgIOagh+mimOWPmOWMlioq5LiN5LyaKirliqggYGRpcnR5YO+8iOWug+S4jeaYr+i9rOWGmeadoeebru+8ie+8jOaJgOS7peimgeWNleeLrOW9k+S4gOS4quOAjOacieS4nOilv+imgeWPkeOAjeeahOeQhueUseOAglxuICAgICAgICAvLyDlsJHkuobov5nkuIDmnaHvvIxgc2Vzc2lvbi90aXRsZWAg5LqL5Lu25Lya6Z2Z6buY5Zyw5Y+q5pS55YaF5a2Y44CB6Z2i5p2/6KaB562J5LiL5LiA5qyh6L2s5YaZ5Y+Y5YyW5omN55yL5Yiw44CCXG4gICAgICAgIC8vIOeUqOmHj+WQjOeQhu+8iGB1c2FnZURpcnR5YO+8ie+8muWug+aYr+WbnuWQiOe7k+adn+aJjeWIt+eahO+8jOetieS4i+S4gOasoei9rOWGmeWPmOWMluWPr+iDveawuOi/nOetieS4jeWIsOOAglxuICAgICAgICAvLyDov5vluqbvvIhgcHJvZ3Jlc3NEaXJ0eWDvvInkuZ/kuIDmoLfvvIzogIzkuJTlroPmr5TnlKjph4/mm7TmgKXvvIjmuIXljZXmmK/lm57lkIgqKuS4remXtCoq5YaZ55qE77yJ44CCXG4gICAgICAgIGlmICh0aGlzLmRpcnR5LnNpemUgPT09IDAgJiYgIXRoaXMudGl0bGVEaXJ0eSAmJiAhdGhpcy51c2FnZURpcnR5ICYmICF0aGlzLnByb2dyZXNzRGlydHkpIHJldHVybjtcbiAgICAgICAgdGhpcy50aXRsZURpcnR5ID0gZmFsc2U7XG4gICAgICAgIGNvbnN0IHVzYWdlQ2hhbmdlZCA9IHRoaXMudXNhZ2VEaXJ0eTtcbiAgICAgICAgdGhpcy51c2FnZURpcnR5ID0gZmFsc2U7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzQ2hhbmdlZCA9IHRoaXMucHJvZ3Jlc3NEaXJ0eTtcbiAgICAgICAgdGhpcy5wcm9ncmVzc0RpcnR5ID0gZmFsc2U7XG4gICAgICAgIGNvbnN0IGJhdGNoID0gWy4uLnRoaXMuZGlydHldLnNsaWNlKDAsIEZMVVNIX0JBVENIX0xJTUlUKTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaCkgdGhpcy5kaXJ0eS5kZWxldGUoZW50cnkpO1xuICAgICAgICBpZiAodGhpcy5kaXJ0eS5zaXplID4gMCkgdGhpcy5zY2hlZHVsZUZsdXNoKCk7XG4gICAgICAgIGNvbnN0IHVwZGF0ZTogSG9zdFVwZGF0ZVZpZXcgPSB7XG4gICAgICAgICAgICBlbnRyaWVzOiBiYXRjaCxcbiAgICAgICAgICAgIHJldmlzaW9uOiB0aGlzLnJldmlzaW9uLFxuICAgICAgICAgICAgZ2VuZXJhdGlvbjogdGhpcy5nZW5lcmF0aW9uLFxuICAgICAgICAgICAgc3RhdHVzOiB0aGlzLnN0YXR1cyxcbiAgICAgICAgICAgIHJ1bm5pbmc6IHRoaXMucnVubmluZyxcbiAgICAgICAgICAgIC8vIOaVtOS7veS6pOS6ku+8iOS4jeaYr+WinumHj++8ie+8mumdouadv+aNruatpOaKiuOAjOeOsOWcqOW/hemhu+eCueS4gOS4i+OAjeeahOmCo+Wdl+eUu+WHuuadpSAvIOaUtuaOiVxuICAgICAgICAgICAgaW50ZXJhY3Rpb25zOiBbLi4udGhpcy5pbnRlcmFjdGlvbnMudmFsdWVzKCldLFxuICAgICAgICAgICAgLy8g5qCH6aKY5ZCM55CG5pW05Lu95Y+R77yI5a6D5Y+q5pyJ5LiA5Liq5YC877yM5aKe6YeP5rKh5pyJ5oSP5LmJ77yJXG4gICAgICAgICAgICB0aXRsZTogdGhpcy5zZXNzaW9uVGl0bGUsXG4gICAgICAgIH07XG4gICAgICAgIGlmICh1c2FnZUNoYW5nZWQpIHtcbiAgICAgICAgICAgIHVwZGF0ZS51c2FnZSA9IHRoaXMudXNhZ2UgPyB7IC4uLnRoaXMudXNhZ2UgfSA6IG51bGw7XG4gICAgICAgICAgICB1cGRhdGUudXNhZ2VOb3RlID0gdGhpcy51c2FnZU5vdGU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHByb2dyZXNzQ2hhbmdlZCkge1xuICAgICAgICAgICAgdXBkYXRlLnByb2dyZXNzID0gdGhpcy5wcm9ncmVzc1ZpZXcoKTtcbiAgICAgICAgICAgIHVwZGF0ZS5wcm9ncmVzc05vdGUgPSB0aGlzLnByb2dyZXNzTm90ZTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIHRoaXMubGlzdGVuZXJzKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGxpc3RlbmVyKHVwZGF0ZSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSDmm7TmlrDlm57osIPmipvplJnvvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2UuYnJvYWRjYXN0KEJST0FEQ0FTVF9DSEFOTkVMLCB1cGRhdGUgYXMgdW5rbm93biBhcyBvYmplY3QpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIOW5v+aSreaYr+S/nemZqeS4neiAjOmdnuS4u+i3r++8mumdouadv+i/mOaciei9ruivouWFnOW6le+8jOi/memHjOWksei0peS4jeeul+mUmeOAglxuICAgICAgICB9XG4gICAgfVxufVxuIl19