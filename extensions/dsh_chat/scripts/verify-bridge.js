/**
 * 验证 DSH 侧那个 bridge 插件（`dsh-profile/plugin/dsh-cocos-bridge/index.js`）。
 *
 * ## 为什么需要它
 *
 * 改插件（加工具、改工具描述）之后想确认「模型真能看到新工具」，最直接的办法是重启 agent ——
 * 但那会**打断正在进行的会话**，而且编辑器也不会告诉你哪里写错了。这个脚本不开编辑器、不碰
 * 正在跑的 agent，只做两件事：
 *
 * 1. **装好的那份 == 源里的那份**（按 sha256 比）：忘了跑 `install-profile.js` 是第一个坑；
 * 2. 在**假 ctx** 上 `apply()` 一次：`defineTool` 会不会收、注册了几个、名字对不对、
 *    描述里那几条「模型唯一的说明书」还在不在。
 *
 * 剩下那一段（DSH 把注册的工具交给模型）由已有的两个工具证明过了 —— 不用为了验证它去重启会话。
 *
 * ```sh
 * node scripts/install-profile.js && node scripts/verify-bridge.js
 * ```
 *
 * ⚠ 为什么是 CJS `.js` 而不是 `.mjs`：本目录的脚本都是 CJS（见 `install-profile.js` 里那条
 * 「TS 会把 import() 降级成 require()」的坑）；插件本身是 ESM，所以这里用**动态 `import()`**。
 *
 * @module dsh_chat/verify-bridge
 */

'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const { PLUGIN_PACKAGE_NAME, resolveDshHome, PROFILE_NAME } = require('./install-profile.js');

/** 插件源文件（真源）。 */
const SOURCE = resolve(__dirname, '..', 'dsh-profile', 'plugin', PLUGIN_PACKAGE_NAME, 'index.js');

/** 一张真 PNG（1×1 透明）——「接上来的会话发图」那条路要真 base64。 */
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
);

/** 五个工具名 —— 少一个/多一个都要红。 */
const EXPECTED_TOOLS = [
    'cocos_execute_code',
    'cocos_describe_api',
    'cocos_editor_state',
    'cocos_capture_view',
    'cocos_logs',
];

/** 描述里必须出现的关键词：它们原本躺在 MCP 服务器的 `initialize.instructions` 里，DSH 不消费那段。 */
const REQUIRED_IN_TEXT = {
    cocos_execute_code: [
        'saveRecipe',
        'findRecipes',
        'runRecipe',
        'cocos_describe_api',
        'snapshot: true',
        'includeEditor',
        'args',
        'cocos_capture_view',
        // context 漏给曾把模型坑掉 10 步（ReferenceError: cc is not defined 看不出是上下文选错）
        'contextInferred',
        // 两个「已知必踩」的封口助手：加载图片 SpriteFrame、编辑态可信的世界矩形
        'loadFrame',
        'worldRect',
    ],
    cocos_describe_api: ['nodeUuid', 'module:fs', 'helpers', 'cc.Camera'],
    cocos_editor_state: ['下一步'],
    cocos_capture_view: ['path', 'blankRatio', '场景视图'],
    // 日志工具的用法要点同样只能在描述里（DSH 不消费 instructions）：三步走、原文引用、clear 的确认口令
    cocos_logs: ['list: true', 'grep', 'confirm', 'F1', '原文'],
};

let failures = 0;

/**
 * 记一条断言结果。
 *
 * @param {string} label - 断言描述。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 附加信息。
 */
function check(label, ok, detail = '') {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        // 早退路径也要红 —— 别只靠结尾那一行（见 verify-replay 踩过的洞）。
        process.exitCode = 1;
    }
}

/**
 * 文件的 sha256。
 *
 * @param {string} file - 绝对路径。
 * @returns {string} 十六进制摘要。
 */
function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
    const installed = join(resolveDshHome(), 'profiles', PROFILE_NAME, 'node_modules', PLUGIN_PACKAGE_NAME, 'index.js');

    check('源文件存在', existsSync(SOURCE), SOURCE);
    check('profile 里那份存在', existsSync(installed), installed);
    if (!existsSync(SOURCE) || !existsSync(installed)) return;
    check(
        'profile 里那份与源一致（忘了跑 install-profile？）',
        sha256(SOURCE) === sha256(installed),
        installed,
    );

    // process.send 不存在 → 插件应当走「没有 IPC」那条分支：打 warning，但**照样注册工具**
    const registered = [];
    const warnings = [];
    const injected = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
        warnings.push(args.map(String).join(' '));
    };

    let mod;
    try {
        mod = await import(pathToFileURL(installed).href);
        mod.apply({
            tools: {
                register(tool) {
                    registered.push(tool);
                },
            },
            /**
             * 插件用 `ctx.inject(['agents'], cb)` 惰性挂控制通道（继续历史会话）。
             * 这里记下它要了什么，并**故意不给回调** —— 模拟「没有 agents 服务的 profile」：
             * 那种情况下三个工具必须照旧注册（工具是主职，不能被附属功能拖垮）。
             */
            inject(deps) {
                injected.push(...deps);
            },
            /** 交互应答者挂在 `ctx.on` 上；这里收下但不触发（本段只验「没有 IPC 时不炸」）。 */
            on() {},
        });
    } catch (error) {
        console.warn = originalWarn;
        check('插件能被加载并 apply()', false, error instanceof Error ? error.message : String(error));
        return;
    }
    console.warn = originalWarn;

    check(`apply() 注册了 ${EXPECTED_TOOLS.length} 个工具`, registered.length === EXPECTED_TOOLS.length, registered.map((t) => t.name).join(' / '));
    check(
        '工具名与预期一致',
        registered.map((t) => t.name).sort().join(',') === [...EXPECTED_TOOLS].sort().join(','),
    );
    check('没有 IPC 时给了人话警告', warnings.some((w) => w.includes('没有 IPC 通道')));
    check('惰性请求了 agents 服务（控制通道用）', injected.includes('agents'), injected.join(', ') || '(没有)');
    check(
        '启动时就登记了三个「现用现取」的服务注入（attachments / commands / fileReferences）',
        ['attachments', 'commands', 'fileReferences'].every((name) => injected.includes(name)),
        injected.join(', ') || '(没有)',
    );
    check(
        '这三个**没有**写进顶层 inject（少一个不该拖垮全部工具）',
        !EXPECTED_TOOLS.some((name) => name === 'attachments'),
        EXPECTED_TOOLS.join(', '),
    );
    check(
        'agents 缺失时工具照旧注册、且不谎报控制通道就绪',
        registered.length === EXPECTED_TOOLS.length && !warnings.some((w) => w.includes('控制通道就绪')),
    );

    for (const tool of registered) {
        console.log(`\n[${tool.name}] ${tool.description.length} 字`);
        check(`  ${tool.name} 有 execute()`, typeof tool.execute === 'function');
        check(`  ${tool.name} 有 output schema`, Boolean(tool.output && tool.output.schema && tool.output.schema.properties.text));
        for (const needle of REQUIRED_IN_TEXT[tool.name] ?? []) {
            check(`  描述里提到 ${needle}`, tool.description.includes(needle));
        }
    }

    await verifyControlChannelImages(mod);
    await verifyControlChannelCancel(mod);
    await verifyServiceChannel(mod);
    await verifyActivityChannel(mod);
    await verifyInteractionChannel(mod);

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * 控制通道的**发图**那段：接上历史会话之后，图片要由我们自己送进附件库。
 *
 * 这一段以前没有任何自动化验证（只有「三条 note 发不进去」这类手工观察），而它是
 * 「继续历史会话之后再贴图」唯一的实现。这里用**假 agents + 假 attachments** 把控制帧
 * 真喂进去（`process.emit('message', …)`），断言四件事：
 *
 * 1. base64 被解码成 `Uint8Array` 且字节一致（附件库拿的是字节，不是字符串）；
 * 2. `mediaType` 原样透传（声明错了附件库会拿字节验出来并拒收）；
 * 3. 内容块是 `[文本, {type:'image', attachment}]` 这个形状 —— 与 SDK 服务端那条路一致；
 * 4. 非规范 base64 在**我们这一层**就被拒（错误信息说得清），而不是丢给附件库报一句英文。
 *
 * @param {any} mod - 已 import 的插件模块。
 */
async function verifyControlChannelImages(mod) {
    console.log('\n控制通道：接上来的会话发图');

    /** 送进假附件库的批次。 */
    const saved = [];
    const followedUp = [];
    const replies = [];
    const attachmentsStore = {
        async saveImages(inputs) {
            saved.push(inputs);
            return inputs.map((input, index) => ({
                attachmentId: `att${index + 1}`,
                mediaType: input.mediaType,
                bytes: input.data.byteLength,
                width: 1,
                height: 1,
                ...(input.name ? { name: input.name } : {}),
            }));
        },
    };
    const agents = {
        async resume({ resumeSessionId }) {
            return {
                agent: {
                    id: 'agent-1',
                    followup(message) {
                        followedUp.push(message);
                    },
                },
                sessionId: resumeSessionId,
            };
        },
    };

    // 假 ctx：`inject(['agents'], cb)` 这次**真回调**（与上面那次故意不回调的用法互补）
    //
    // ⚠ 服务一律走 `inject` 交出去，**不走 `get`** —— 这是真 cordis 的口径（实测）：
    //    `ctx.get('attachments')` 在真运行时恒为 undefined，只有 inject 才拿得到。
    //    假 ctx 的 `get` 以前什么都给，于是「附件库那条路」在本地一直是绿的，
    //    真运行时却报「本 profile 没挂附件库」（2026-12 被 verify-profile-rows.js 抓到）。
    const ctx = {
        tools: { register() {} },
        inject(deps, callback) {
            const name = deps[0];
            if (typeof callback !== 'function') return;
            if (name === 'agents') callback({ agents, get: () => agents });
            else if (name === 'attachments') callback({ attachments: attachmentsStore });
            else if (name === 'commands' || name === 'fileReferences') callback({});
        },
        get() {
            return undefined;
        },
        /** 交互应答者（本段不验它，只要求 apply() 不炸）。 */
        on() {},
    };
    mod.apply(ctx);

    const originalSend = process.send;
    // node 里 `process.send` 只在 fork 出来的子进程上存在；这里自己装一个，把回执接下来
    process.send = (frame) => {
        replies.push(frame);
    };
    /** 喂一帧控制帧并等回执（回执走 `process.send`，见上）。 */
    const controlFrame = async (id, method, params) => {
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params });
        for (let waited = 0; waited < 200 && !replies.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        return replies.find((frame) => frame.id === id);
    };

    try {
        const resumed = await controlFrame(1, 'session/resume', { sessionId: 'sess-1' });
        check('session/resume 成功（需要 agents 服务）', Boolean(resumed && resumed.ok), JSON.stringify(resumed));

        const withImage = await controlFrame(2, 'session/prompt', {
            sessionId: 'sess-1',
            text: '看一眼这张图',
            images: [{ mimeType: 'image/png', data: TINY_PNG.toString('base64'), name: 'a.png' }],
        });
        check('带图的 session/prompt 成功', Boolean(withImage && withImage.ok), JSON.stringify(withImage));
        check('图片真的送进了附件库', saved.length === 1 && saved[0].length === 1, String(saved.length));
        const input = saved[0] ? saved[0][0] : {};
        check('进附件库的是字节（不是 base64 字符串）', input.data instanceof Uint8Array, typeof input.data);
        check('字节数与源一致', input.data && input.data.byteLength === TINY_PNG.length, String(input.data && input.data.byteLength));
        check('mediaType 原样透传', input.mediaType === 'image/png', String(input.mediaType));
        check('名字也带上了（附件库只当显示名）', input.name === 'a.png', String(input.name));

        const message = followedUp[followedUp.length - 1];
        const content = (message && message.content) || [];
        check('投喂的是一条用户消息', Boolean(message && message.id), JSON.stringify(message && message.id));
        check(
            '内容块顺序 = [文本, 图片]',
            content.length === 2 && content[0].type === 'text' && content[1].type === 'image',
            content.map((block) => block.type).join(','),
        );
        check(
            '图片块是 {type:image, attachment}（与 SDK 服务端同形状）',
            Boolean(content[1] && content[1].attachment && content[1].attachment.attachmentId === 'att1'),
            JSON.stringify(content[1]),
        );

        const textOnly = await controlFrame(3, 'session/prompt', { sessionId: 'sess-1', text: '只发字' });
        check('纯文本仍然可以（不发图片时不动附件库）', Boolean(textOnly && textOnly.ok) && saved.length === 1, String(saved.length));

        const padded = TINY_PNG.toString('base64');
        const badData = await controlFrame(4, 'session/prompt', {
            sessionId: 'sess-1',
            text: '坏数据',
            // 换行塞在**中间**：两头的空白是会被 trim 掉的（那是善意的归一化），
            // 但中间夹了东西就是真的「非规范 base64」——附件库的解码器会拒，我们也要先说清楚
            images: [{ mimeType: 'image/png', data: `${padded.slice(0, 6)}\n${padded.slice(6)}` }],
        });
        check(
            '非规范 base64 在这一层就被拒（错误说得清）',
            Boolean(badData && badData.ok === false && String(badData.error).includes('规范形式')),
            String(badData && badData.error),
        );

        const unpadded = await controlFrame(7, 'session/prompt', {
            sessionId: 'sess-1',
            text: '缺填充',
            images: [{ mimeType: 'image/png', data: padded.replace(/=+$/, '') }],
        });
        check(
            '缺少 base64 填充也会被拒（解码结果与再编码对不上）',
            Boolean(unpadded && unpadded.ok === false),
            String(unpadded && unpadded.error),
        );

        const empty = await controlFrame(5, 'session/prompt', { sessionId: 'sess-1' });
        check('文本与图片都空 → 明确报错', Boolean(empty && empty.ok === false), String(empty && empty.error));

        const unknown = await controlFrame(6, 'session/prompt', { sessionId: '别人家的会话', text: 'hi' });
        check(
            '没有 session/resume 过的会话被拒（不误投喂）',
            Boolean(unknown && unknown.ok === false && String(unknown.error).includes('session/resume')),
            String(unknown && unknown.error),
        );
    } finally {
        if (originalSend === undefined) delete process.send;
        else process.send = originalSend;
    }
}

/**
 * 控制通道的**中断**那段：`session/cancel` → 运行时 `Agent.cancel({kind:'user'})`。
 *
 * 这一段是「AI 思考到一半要改口」唯一的实现，而且 SDK 协议**表达不了它**
 * （只有 initialize / session/prompt / shutdown），所以更不能靠手测：
 * 两条会话来源（本插件 resume 的 / SDK 服务端建的）各走一条取 Agent 的路，
 * 加上「没在跑」与「找不到」两种边界，一共四条断言。
 *
 * @param {any} mod - 已 import 的插件模块。
 */
async function verifyControlChannelCancel(mod) {
    console.log('\n控制通道：中断当前一轮（session/cancel）');

    const cancelled = [];
    /** 本插件 resume 出来的会话（走 ownedSessions）。 */
    const ownedAgent = {
        id: 'agent-owned',
        status: 'running',
        cancel(cause) {
            cancelled.push({ id: this.id, cause });
            this.status = 'idle';
        },
    };
    /** SDK 服务端建的会话：本插件**不持有** handle，只能靠 `agents.get()` 找到。 */
    const sdkAgent = {
        id: 'agent-sdk',
        status: 'running',
        cancel(cause) {
            cancelled.push({ id: this.id, cause });
            this.status = 'idle';
        },
    };

    const agents = {
        async resume({ resumeSessionId }) {
            return {
                agent: { ...ownedAgent, id: ownedAgent.id, followup() {}, cancel: ownedAgent.cancel.bind(ownedAgent) },
                sessionId: resumeSessionId,
            };
        },
        get(id) {
            if (id === 'agent-sdk-session') return sdkAgent;
            return undefined;
        },
    };

    const ctx = {
        tools: { register() {} },
        inject(deps, callback) {
            if (deps.includes('agents') && typeof callback === 'function') {
                callback({ agents, get: (name) => (name === 'agents' ? agents : undefined) });
            }
        },
        get() {
            return undefined;
        },
        /** 交互应答者（本段不验它，只要求 apply() 不炸）。 */
        on() {},
    };
    mod.apply(ctx);

    const originalSend = process.send;
    const replies = [];
    process.send = (frame) => {
        replies.push(frame);
    };
    const controlFrame = async (id, method, params) => {
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params });
        for (let waited = 0; waited < 200 && !replies.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        return replies.find((frame) => frame.id === id);
    };


    try {
        // ① 本插件 resume 的会话：走 ownedSessions
        const owned = await controlFrame(20, 'session/resume', { sessionId: 'sess-owned' });
        check('session/resume 先接上一个会话（中断要有对象）', Boolean(owned && owned.ok), JSON.stringify(owned));
        const cancelOwned = await controlFrame(21, 'session/cancel', { sessionId: 'sess-owned' });
        check(
            '中断 resume 出来的会话：真调到 Agent.cancel（cause = {kind:"user"}）',
            Boolean(cancelOwned && cancelOwned.ok && cancelOwned.result.cancelled === true) &&
                cancelled.length === 1 &&
                cancelled[0].cause &&
                cancelled[0].cause.kind === 'user',
            JSON.stringify({ reply: cancelOwned && cancelOwned.result, cancelled }),
        );

        // ② SDK 服务端建的会话：本插件不持有，必须靠 agents.get() 找到
        const cancelSdk = await controlFrame(22, 'session/cancel', { sessionId: 'agent-sdk-session' });
        check(
            '中断 SDK 建的会话：靠 agents.get(sessionId) 找到同一个 agent（不要求先 resume）',
            Boolean(cancelSdk && cancelSdk.ok && cancelSdk.result.cancelled === true) &&
                cancelled.length === 2 &&
                cancelled[1].id === 'agent-sdk',
            JSON.stringify({ reply: cancelSdk && cancelSdk.result, cancelled }),
        );

        // ③ 没在跑：是竞态不是错误（按钮按下时这一轮可能刚好自己结束）
        const idle = await controlFrame(23, 'session/cancel', { sessionId: 'agent-sdk-session' });
        check(
            '没在跑时回 {cancelled:false} 而不是报错（面板会把它当误报弹红条）',
            Boolean(idle && idle.ok && idle.result.cancelled === false) && cancelled.length === 2,
            JSON.stringify(idle && idle.result),
        );

        // ④ 找不到的会话：说清楚，别静默成功
        const missing = await controlFrame(24, 'session/cancel', { sessionId: '不存在的会话' });
        check(
            '找不到 agent 时不静默成功（ok:false + 说得清）',
            Boolean(missing && missing.ok === false && String(missing.error).includes('不存在的会话')),
            String(missing && missing.error),
        );

        const emptyId = await controlFrame(25, 'session/cancel', {});
        check('空 sessionId 被拒', Boolean(emptyId && emptyId.ok === false), String(emptyId && emptyId.error));

        // ping 要如实报「能不能中断」——面板/排查都靠它
        const pong = await controlFrame(26, 'ping', {});
        check(
            'ping 报告 cancel 能力（agents 服务在就有）',
            Boolean(pong && pong.ok && pong.result.cancel === true),
            JSON.stringify(pong && pong.result),
        );
    } finally {
        if (originalSend === undefined) delete process.send;
        else process.send = originalSend;
    }
}

/**
 * 服务通道：把宿主自己的两个**面向人的**注册表（斜杠命令 / `@路径` 候选）借给面板。
 *
 * 这一段修的是「SDK 协议表达不了、而宿主里明明有」的两类能力：
 * 面板以前**一个斜杠命令都用不了**（`/compact` `/plan` `/goal` `/feedback` 全在宿主里躺着），
 * 也**没有任何 `@路径` 补全**。这里用**假 commands + 假 fileReferences** 把控制帧真喂进去，
 * 断言六件事：
 *
 * 1. `commands/list` 只投影出面板画得下的字段（name/description/hint/images）；
 * 2. `commands/run` **走注册表自己的分派**（我们不解析命令行），`undefined` → `known:false`
 *    而不是一个错误帧 —— 「名字不认识」与「命令跑了但报错」是两件事；
 * 3. `commands/run` 把 agent、空图片数组、AbortSignal 三个参数**按注册表的签名**传对；
 * 4. `fileref/list` 收敛载荷（条数上限 + 超长路径丢弃 + `kind` 只留 file/directory）；
 * 5. 服务不在时**报得出人话**（提到该挂哪个 bundle），而不是 `Cannot read property of null`；
 * 6. `ping` 的两个能力位如实反映服务在不在（面板据此决定显不显示 `/` 与 `@` 入口）。
 *
 * @param {any} mod - 已 import 的插件模块。
 */
async function verifyServiceChannel(mod) {
    console.log('\n服务通道：斜杠命令 / @路径候选（借宿主的两个注册表）');

    const agent = { id: 'agent-svc', status: 'idle' };
    const calls = [];
    const permissions = {
        read: { name: 'read' },
    };
    const commands = {
        list(receiving) {
            calls.push({ op: 'list', agentId: receiving && receiving.id });
            return [
                { name: 'compact', description: 'Compact older conversation history' },
                { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]', images: true } },
                { name: 'goal', description: 'set or view the goal for a long-running task', input: { hint: '<goal>', images: false } },
            ];
        },
        async execute(receiving, line, images, signal) {
            calls.push({
                op: 'execute',
                agentId: receiving && receiving.id,
                line,
                imagesIsArray: Array.isArray(images),
                imagesLength: Array.isArray(images) ? images.length : -1,
                signalAborted: Boolean(signal && signal.aborted),
                signalIsAbortSignal: typeof signal === 'object' && signal !== null && typeof signal.addEventListener === 'function',
            });
            if (line.startsWith('/nope')) return undefined;
            if (line.startsWith('/compact')) {
                return { commandId: 'cmd-2', result: { kind: 'error', text: '没有可压缩的历史' } };
            }
            return { commandId: 'cmd-1', result: { kind: 'success', text: 'Plan mode on.' } };
        },
    };
    const fileReferences = {
        async list(receiving, query, signal) {
            calls.push({
                op: 'fileref',
                agentId: receiving && receiving.id,
                query,
                signalIsAbortSignal: typeof signal === 'object' && signal !== null && typeof signal.addEventListener === 'function',
            });
            // 一条超长路径（跨 IPC 必须丢）+ 60 条正常候选（必须被上限截断）
            const list = [{ path: 'x'.repeat(500), kind: 'file' }];
            for (let index = 0; index < 60; index += 1) {
                list.push({ path: index === 3 ? 'assets/scripts/' : `assets/scripts/file_${index}.ts`, kind: index === 3 ? 'directory' : 'file' });
            }
            return list;
        },
    };

    const services = { commands, fileReferences, agents: undefined, read: permissions.read };
    /**
     * 假 ctx：服务**只经 `inject` 交出去**，`get` 一律 undefined。
     *
     * 这是刻意的、也是真 cordis 的实测口径（见 `verify-profile-rows.js`）：真运行时
     * `ctx.get('commands')` 恒为 undefined。把假 ctx 也做成这样，就等于给「用错取值方式」
     * 装了一条回归网 —— 谁把 `inject` 改回 `ctx.get`，这一组断言立刻红。
     */
    const ctx = {
        tools: { register() {} },
        inject(deps, callback) {
            if (typeof callback !== 'function') return;
            const name = deps[0];
            if (name === 'agents') {
                callback({ agents: { get: (id) => (id === 'agent-svc' ? agent : undefined) } });
                return;
            }
            if (name === 'commands' || name === 'fileReferences') callback({ [name]: services[name] });
            else callback({});
        },
        get() {
            return undefined;
        },
        on() {},
    };
    mod.apply(ctx);

    const originalSend = process.send;
    const replies = [];
    process.send = (frame) => {
        replies.push(frame);
    };
    let frameSeq = 100;
    const controlFrame = async (method, params) => {
        const id = (frameSeq += 1);
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params });
        for (let waited = 0; waited < 200 && !replies.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        const reply = replies.find((frame) => frame.id === id);
        return reply;
    };

    try {
        // ① 列表：只投影面板画得下的字段
        const listed = await controlFrame('commands/list', { sessionId: 'agent-svc' });
        check(
            'commands/list 列出命令（name / description / hint / images）',
            Boolean(listed && listed.ok) &&
                listed.result.commands.length === 3 &&
                listed.result.commands[1].name === 'plan' &&
                listed.result.commands[1].hint === '[off|message]' &&
                listed.result.commands[1].images === true &&
                listed.result.commands[2].images === undefined,
            JSON.stringify(listed && listed.result),
        );
        check(
            'commands/list 是按 agent 查的（同一个注册表按 agent 遮蔽）',
            calls.some((call) => call.op === 'list' && call.agentId === 'agent-svc'),
            JSON.stringify(calls[0]),
        );

        // ② 执行：成功的
        const ran = await controlFrame('commands/run', { sessionId: 'agent-svc', line: '/plan 重构配表' });
        check(
            'commands/run 走注册表自己的分派，回 {known, commandId, kind, text}',
            Boolean(ran && ran.ok) &&
                ran.result.known === true &&
                ran.result.commandId === 'cmd-1' &&
                ran.result.kind === 'success' &&
                ran.result.text === 'Plan mode on.',
            JSON.stringify(ran && ran.result),
        );
        const executeCall = calls.find((call) => call.op === 'execute');
        check(
            '参数按注册表的签名传对：agent / 命令行 / 空图片 / 未中止的 AbortSignal',
            Boolean(executeCall) &&
                executeCall.agentId === 'agent-svc' &&
                executeCall.line === '/plan 重构配表' &&
                executeCall.imagesIsArray === true &&
                executeCall.imagesLength === 0 &&
                executeCall.signalAborted === false &&
                executeCall.signalIsAbortSignal === true,
            JSON.stringify(executeCall),
        );

        // ③ 名字不认识 ≠ 报错：注册表回 undefined，要原样翻译成 known:false
        const unknown = await controlFrame('commands/run', { sessionId: 'agent-svc', line: '/nope' });
        check(
            '未知命令回 known:false（不是错误帧 —— 与「命令跑了但报错」是两件事）',
            Boolean(unknown && unknown.ok === true && unknown.result.known === false),
            JSON.stringify(unknown && unknown.result),
        );

        // ④ 命令自己返回错误：known:true + kind:error + 文本原样
        const boom = await controlFrame('commands/run', { sessionId: 'agent-svc', line: '/compact' });
        check(
            '命令处理器返回 error → kind:error 且文本原样透传',
            Boolean(boom && boom.ok) && boom.result.known === true && boom.result.kind === 'error' && boom.result.text === '没有可压缩的历史',
            JSON.stringify(boom && boom.result),
        );

        // ⑤ 不合法输入要在我们这一层拦（注册表对「没有斜杠」也是 undefined，但那是面板的 bug，要说清）
        const noSlash = await controlFrame('commands/run', { sessionId: 'agent-svc', line: 'plan' });
        check('没有斜杠的输入被拒（面板的 bug，不该悄悄委派给注册表）', Boolean(noSlash && noSlash.ok === false), String(noSlash && noSlash.error));

        const badSession = await controlFrame('commands/run', { sessionId: '查无此会话', line: '/plan' });
        check(
            '找不到 agent 时说得清（不静默成功）',
            Boolean(badSession && badSession.ok === false && String(badSession.error).includes('查无此会话')),
            String(badSession && badSession.error),
        );

        // ⑥ @ 候选：载荷收敛（上限 + 超长路径 + kind 词表）
        const refs = await controlFrame('fileref/list', { sessionId: 'agent-svc', query: 'scripts' });
        check(
            'fileref/list 回候选且带 kind',
            Boolean(refs && refs.ok) && refs.result.candidates.length > 0 && refs.result.candidates[0].kind === 'file',
            JSON.stringify(refs && refs.result && { count: refs.result.candidates.length, first: refs.result.candidates[0] }),
        );
        check(
            '超长路径被丢掉（跨 IPC 不做无上限搬运）',
            Boolean(refs && refs.ok) && !refs.result.candidates.some((item) => item.path.length > 400),
            String(refs && refs.result && refs.result.candidates[0] && refs.result.candidates[0].path.length),
        );
        check(
            '候选条数被上限截断（REFERENCE_LIMIT）',
            Boolean(refs && refs.ok) && refs.result.candidates.length <= 40,
            String(refs && refs.result && refs.result.candidates.length),
        );
        check(
            '目录候选的 kind 是 directory（面板据此决定「选中后继续往下钻」）',
            Boolean(refs && refs.ok) && refs.result.candidates.some((item) => item.kind === 'directory'),
            JSON.stringify(refs && refs.result && refs.result.candidates.filter((item) => item.kind === 'directory')),
        );
        check(
            '查询串原样传给提供方（补全语义由它拥有）',
            calls.some((call) => call.op === 'fileref' && call.query === 'scripts' && call.signalIsAbortSignal === true),
            JSON.stringify(calls.filter((call) => call.op === 'fileref')),
        );

        // ⑦ ping：两个能力位如实报告
        const pong = await controlFrame('ping', {});
        check(
            'ping 报告 commands / fileRef 两个能力位',
            Boolean(pong && pong.ok && pong.result.commands === true && pong.result.fileRef === true),
            JSON.stringify(pong && pong.result),
        );
    } finally {
        if (originalSend === undefined) delete process.send;
        else process.send = originalSend;
    }

    // ⑧ 服务缺失：必须是「说得清的人话」，不是 null 解引用
    const bare = {
        tools: { register() {} },
        inject() {},
        get() {
            return undefined;
        },
        on() {},
    };
    mod.apply(bare);
    const originalSend2 = process.send;
    const replies2 = [];
    process.send = (frame) => {
        replies2.push(frame);
    };
    try {
        for (const [method, needle] of [
            ['commands/list', 'commands'],
            ['fileref/list', 'file-reference-local'],
        ]) {
            const id = `bare-${method}`;
            process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params: { sessionId: 'x' } });
            for (let waited = 0; waited < 200 && !replies2.some((frame) => frame.id === id); waited += 1) {
                await new Promise((done) => setTimeout(done, 5));
            }
            const reply = replies2.find((frame) => frame.id === id);
            check(
                `服务缺失时 ${method} 报人话（提到该挂什么）`,
                Boolean(reply && reply.ok === false && String(reply.error).includes(needle)),
                String(reply && reply.error),
            );
        }
        const id = 'bare-ping';
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method: 'ping', params: {} });
        for (let waited = 0; waited < 200 && !replies2.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        const pong = replies2.find((frame) => frame.id === id);
        check(
            '服务缺失时 ping 的两个能力位是 false（面板据此不显示入口）',
            Boolean(pong && pong.ok && pong.result.commands === false && pong.result.fileRef === false),
            JSON.stringify(pong && pong.result),
        );
    } finally {
        if (originalSend2 === undefined) delete process.send;
        else process.send = originalSend2;
    }
}

/**
 * 交互通道：本插件**替运行时的两个 waterfall 当应答者**（模型提问 / 授权请求 / 计划评审）。
 *
 * 这一段以前完全没有自动化验证，而它修的是三条「结构性做不到」的症状：
 * `ask_user_question` 报 `NO_PROVIDER`、需要授权的操作一律被拒、计划模式出不来。
 * 这里用**假 ctx.on + 真 waterfall 派发**（照抄 cordis 的 `(...args, next)` 口径）把
 * 整条链路真跑一遍：
 *
 * ```
 * waterfall(request, next) → 插件 ask 帧 → （冒充面板的）控制帧 → 插件回答案
 * ```
 *
 * 覆盖六件事：① 提问能被回答；② 「关掉不答」抛的是 `UserQuestionError/ASK_CANCELLED`
 * （`dsh-plan-mode` 正是按这个 code 认「用户要插话」的）；③ 空答案会委派给下一个应答者
 * （不许把空答案当成答案交上去）；④ 授权四种结果原样回；⑤ 没有 IPC 时**原样委派**
 * （行为与加这段代码之前一致，不许把模型吊死）；⑥ 未知 id 不静默成功。
 *
 * @param {any} mod - 已 import 的插件模块。
 */
async function verifyInteractionChannel(mod) {
    console.log('\n交互通道：替两个 waterfall 当应答者（提问 / 授权 / 计划评审）');

    /** 事件名 → 监听器（真 cordis 的注册表）。 */
    const listeners = new Map();
    const ctx = {
        tools: { register() {} },
        on(name, listener) {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        },
        inject() {},
        get() {
            return undefined;
        },
    };
    mod.apply(ctx);

    const questionListeners = listeners.get('user-questions/request') ?? [];
    const approvalListeners = listeners.get('approval/request') ?? [];
    check('挂上了 user-questions/request 应答者', questionListeners.length === 1, String(questionListeners.length));
    check('挂上了 approval/request 应答者', approvalListeners.length === 1, String(approvalListeners.length));

    const frames = [];
    const originalSend = process.send;
    process.send = (frame) => {
        frames.push(frame);
    };

    /** 等一帧满足条件（插件是异步发帧的，不能同步断言）。 */
    const waitFor = async (predicate) => {
        for (let waited = 0; waited < 200; waited += 1) {
            const hit = frames.find(predicate);
            if (hit) return hit;
            await new Promise((done) => setTimeout(done, 5));
        }
        return undefined;
    };

    /** 等**本段之后**新出现的一条 open 帧（`mark` 用 `frames.length` 取，免得上一条的帧被认成这一条）。 */
    const waitForOpen = async (mark, predicate = () => true) => {
        for (let waited = 0; waited < 200; waited += 1) {
            const hit = frames.slice(mark).find((frame) => frame.kind === 'ask' && frame.phase === 'open' && predicate(frame));
            if (hit) return hit;
            await new Promise((done) => setTimeout(done, 5));
        }
        return undefined;
    };

    /** 冒充扩展主进程发一条控制帧，并等回执。 */
    const controlFrame = async (id, method, params) => {
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params });
        for (let waited = 0; waited < 200 && !frames.some((frame) => frame.kind === 'ctl-res' && frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        return frames.find((frame) => frame.kind === 'ctl-res' && frame.id === id);
    };

    /**
     * 照抄 cordis 的 waterfall：监听器按注册顺序被问，`next()` 交给下一个。
     *
     * @param {string} name - 事件名。
     * @param {Record<string, unknown>} request - 载荷。
     * @param {() => Promise<unknown>} fallback - 最后那个「没人答」的兜底（运行时会给）。
     * @returns {Promise<unknown>} 链的返回值。
     */
    const runWaterfall = (name, request, fallback) => {
        const queue = [...(listeners.get(name) ?? [])];
        const next = () => (queue.shift() ?? fallback)(request, next);
        return next();
    };

    /**
     * **立刻**挂上处理器，把 settle 结果收成 `{ok, value, error}`。
     *
     * 为什么要多这一层：本段里有几步是「先发起 waterfall，再去等插件发帧，最后才 await 结果」——
     * 而「没人答」那条路会**在等待期间**就拒绝。裸 Promise 在那一段时间里没有处理器，
     * Node 会把它当 unhandled rejection **直接杀掉进程**（现象是测试在断言之前就没了，
     * 与真正的失败长得完全不一样）。
     *
     * @param {Promise<unknown>} promise - 要观察的 promise。
     * @returns {Promise<{ok: boolean, value?: unknown, error?: unknown}>} 永不拒绝的包装。
     */
    const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

    try {
        // ① 提问：模型问了一道两选项的题，人在面板上点了一个
        let mark = frames.length;
        const askSettled = settle(
            runWaterfall(
                'user-questions/request',
                { questions: [{ id: 'q1', question: '改哪张表？', options: [{ label: 'relics' }, { label: 'modifiers' }] }], agent: { id: 'agent-1', session: { id: 'sess-1' } } },
                () => Promise.reject(new Error('no answerer')),
            ),
        );
        const open = await waitForOpen(mark);
        check('插件把问题发给了编辑器（ask 帧）', Boolean(open), JSON.stringify(frames.filter((f) => f.kind === 'ask')));
        check('  id 是插件自己发的、可复述', Boolean(open && typeof open.id === 'string' && open.id.startsWith('ask-')), open && open.id);
        check('  形状逐字对齐 AskUserQuestionItem', Boolean(open && open.interaction.questions[0].id === 'q1' && open.interaction.questions[0].options.length === 2));
        check(
            '  只投影字符串（Agent 对象与 AbortSignal 跨不了 IPC）',
            Boolean(open && open.interaction.agentId === 'agent-1' && open.interaction.sessionId === 'sess-1' && open.interaction.agent === undefined),
            JSON.stringify(open && open.interaction),
        );

        const answered = await controlFrame(30, 'interaction/answer', { id: open.id, action: 'answer', answers: [{ id: 'q1', selected: ['relics'] }] });
        check('面板的回答被接受', Boolean(answered && answered.ok && answered.result.settled === true), JSON.stringify(answered));
        const askResult = await askSettled;
        check(
            'waterfall 拿到 {answers}（模型侧就是它）',
            Boolean(askResult.ok && askResult.value.answers[0].id === 'q1' && askResult.value.answers[0].selected[0] === 'relics'),
            JSON.stringify(askResult.value ?? String(askResult.error)),
        );
        const settled = frames.find((frame) => frame.kind === 'ask' && frame.phase === 'settled' && frame.id === open.id);
        check('收尾帧告诉编辑器「答完了」（面板据此收卡片）', Boolean(settled && settled.outcome === 'answered'), JSON.stringify(settled));

        // ② 空答案不许当成答案：委派给下一个应答者（走到兜底）
        mark = frames.length;
        const emptySettled = settle(runWaterfall('user-questions/request', { questions: [{ id: 'q2', question: '还有吗？' }] }, () => Promise.reject(new Error('no answerer'))));
        const emptyOpen = await waitForOpen(mark);
        await controlFrame(31, 'interaction/answer', { id: emptyOpen.id, action: 'answer', answers: [] });
        const emptyResult = await emptySettled;
        check(
            '空答案被当成「没人回答」（委派到兜底，而不是交出空答案）',
            emptyResult.ok === false && String(emptyResult.error?.message) === 'no answerer',
            JSON.stringify(emptyResult.value ?? String(emptyResult.error?.message)),
        );

        // ③ 「关掉不答」= 用户要插话：抛 UserQuestionError/ASK_CANCELLED（plan-mode 认这个 code）
        mark = frames.length;
        const dismissSettled = settle(
            runWaterfall('user-questions/request', { questions: [{ id: 'plan-review', header: 'Plan review', question: '批准这份计划吗？' }] }, () => Promise.reject(new Error('no answerer'))),
        );
        const dismissOpen = await waitForOpen(mark);
        await controlFrame(32, 'interaction/answer', { id: dismissOpen.id, action: 'dismiss' });
        const dismissed = await dismissSettled;
        check(
            '关掉提问 → 抛 {name:"UserQuestionError", code:"ASK_CANCELLED"}（不 import 那个包，按名字+code 认）',
            Boolean(dismissed.ok === false && dismissed.error?.name === 'UserQuestionError' && dismissed.error?.code === 'ASK_CANCELLED'),
            JSON.stringify(dismissed.ok === false ? { name: dismissed.error?.name, code: dismissed.error?.code } : dismissed.value),
        );

        // ④ 授权：允许一次 / 拒绝 / 取消（关掉）三种面板动作
        mark = frames.length;
        const allowPromise = runWaterfall('approval/request', { toolName: 'pwsh', reason: '要写到工作区外', agent: { id: 'agent-2' }, callId: 'call-9' }, () => Promise.resolve('unavailable'));
        const allowOpen = await waitForOpen(mark);
        check(
            '授权请求带着工具名 / 理由 / 调用 id 到了面板',
            Boolean(allowOpen && allowOpen.interaction.reason === '要写到工作区外' && allowOpen.interaction.callId === 'call-9'),
            JSON.stringify(allowOpen && allowOpen.interaction),
        );
        await controlFrame(33, 'interaction/answer', { id: allowOpen.id, action: 'answer', outcome: 'allowed-once' });
        check('「允许一次」原样回给运行时（唯一表示授予的结果）', (await allowPromise) === 'allowed-once');

        mark = frames.length;
        const denyPromise = runWaterfall('approval/request', { toolName: 'pwsh', agent: { id: 'agent-2' } }, () => Promise.resolve('unavailable'));
        const denyOpen = await waitForOpen(mark);
        await controlFrame(34, 'interaction/answer', { id: denyOpen.id, action: 'answer', outcome: 'rejected' });
        check('「拒绝」原样回给运行时', (await denyPromise) === 'rejected');

        mark = frames.length;
        const cancelPromise = runWaterfall('approval/request', { toolName: 'read', agent: { id: 'agent-2' } }, () => Promise.resolve('unavailable'));
        const cancelOpen = await waitForOpen(mark);
        await controlFrame(35, 'interaction/answer', { id: cancelOpen.id, action: 'dismiss' });
        check('关掉授权 → cancelled（不是 rejected：撤回与拒绝是两件事）', (await cancelPromise) === 'cancelled');

        // ⑤ 委派：面板不在（主进程会这么回）→ 走下一个应答者 → 最终 fail closed
        mark = frames.length;
        const delegatePromise = runWaterfall('approval/request', { toolName: 'write', agent: { id: 'agent-3' } }, () => Promise.resolve('unavailable'));
        const delegateOpen = await waitForOpen(mark);
        await controlFrame(36, 'interaction/answer', { id: delegateOpen.id, action: 'delegate' });
        check('「委派」= 交给下一个应答者（最终失败关闭，与加这段代码之前一致）', (await delegatePromise) === 'unavailable');

        // ⑥ 未知 id：说清楚，不静默成功
        const unknown = await controlFrame(37, 'interaction/answer', { id: 'ask-999-999', action: 'answer', answers: [{ id: 'q', selected: ['x'] }] });
        check(
            '未知 id 不静默成功（竞态：用户可能点了两下）',
            Boolean(unknown && unknown.ok && unknown.result.settled === false),
            JSON.stringify(unknown && unknown.result),
        );

        // ⑦ 没有 IPC（从终端直接跑这个 profile）：立刻委派，不许吊死
        //    `hasIpc()` 判的是 `typeof process.send === 'function'`，所以「没有 IPC」只能这么模拟。
        delete process.send;
        let noIpcError = '';
        try {
            await runWaterfall('user-questions/request', { questions: [{ id: 'q3', question: '在吗？' }] }, () => Promise.reject(new Error('no answerer')));
        } catch (error) {
            noIpcError = error instanceof Error ? error.message : String(error);
        }
        check('没有 IPC 时直接委派（走到兜底，不抛栈、不吊死）', noIpcError === 'no answerer', noIpcError);
        process.send = (frame) => {
            frames.push(frame);
        };

        // ⑧ ping 要如实报「这个插件版本能不能回答问题」
        const pong = await controlFrame(38, 'ping', {});
        check('ping 报告 ask 能力（面板据此判断插件版本）', Boolean(pong && pong.ok && pong.result.ask === true), JSON.stringify(pong && pong.result));
    } finally {
        if (originalSend === undefined) delete process.send;
        else process.send = originalSend;
    }
}

/**
 * 活动通道：后台任务（jobs）与子 agent（subagents）。
 *
 * ## 这一组要钉住的三条（全是「错了也不会报错」的那一类）
 *
 * 1. **绝不 `read()` job 的输出。** 每个 job 只有一个消费游标（`read()` 一调就推走），
 *    读了它模型下一次 `job_output` 只会拿到 `(no new output)` —— 面板为了多显示几行，
 *    把模型的工具废掉，这是**代价与收益完全不成比例**的错。假服务里 `read()` 会记账，
 *    断言它**一次都没被调用**。
 * 2. **`list()` 必须带 Agent。** 不带就只剩「无主 job」= 面板永远空白，而且**不报错**。
 *    假服务记下每次 `list` 的 caller，断言它就是我们那条会话（以及子会话）。
 * 3. **中断子 agent 的 authority 必须是 `{kind:'user', parentSessionId}`。**
 *    另一个分支 `{kind:'ancestor', agent}` 是给模型工具用的；用错会被判越权
 *    （`UNAUTHORIZED`），在面板上的表现是「按钮点了没反应」。
 *
 * 顺带钉住：快照里的 `owner`（**Agent 实例，过不了 IPC**）不许透传、
 * 服务缺失要说人话、`ping` 要如实报两个能力位。
 *
 * @param {any} mod - 已 import 的插件模块。
 */
async function verifyActivityChannel(mod) {
    console.log('\n活动通道：后台任务（jobs）与子 agent（subagents）');

    /** 会话里的两个 agent：父 + 一个活着的子 agent。 */
    const parent = { id: 'sess-parent', status: 'running' };
    const child = { id: 'sess-child', status: 'idle' };
    const agents = {
        get: (id) => (id === 'sess-parent' ? parent : id === 'sess-child' ? child : undefined),
    };

    const calls = [];
    const jobs = {
        list(caller) {
            calls.push({ op: 'list', caller: caller && caller.id });
            if (caller && caller.id === 'sess-parent') {
                return [
                    // ⚠ `owner` 是一个 **Agent 实例**（过不了 IPC）—— 投影时必须丢掉
                    { id: 'pwsh-1', kind: 'pwsh', label: 'npm run build', status: 'running', owner: parent, startedAt: 200, reported: false },
                    // detail 里有退出码；finishedAt 有值
                    { id: 'pwsh-0', kind: 'pwsh', label: 'git status', status: 'completed', detail: 'exit code: 0', owner: parent, startedAt: 100, finishedAt: 150 },
                    // 不认识的状态 → unknown（不猜、不假装 running）
                    { id: 'bash-9', kind: 'bash', label: 'x'.repeat(500), status: 'wat', owner: parent, startedAt: 50 },
                ];
            }
            if (caller && caller.id === 'sess-child') {
                return [{ id: 'subagent-job-1', kind: 'subagent', label: '子 agent 的活', status: 'running', owner: child, startedAt: 300 }];
            }
            return [];
        },
        // 🔴 面板**永远**不该碰这个：一调就把模型的 job_output 游标推走
        read() {
            calls.push({ op: 'READ-BUG' });
            return { chunks: ['(no new output)'] };
        },
    };

    const subagents = {
        async listDescendants(sessionId) {
            calls.push({ op: 'descendants', sessionId });
            return [
                { id: 'sess-child', kind: 'child', label: '查配表', mode: 'continuable', depth: 1, hasChildren: false, activity: 'running' },
                { id: 'sess-cold', kind: 'child', label: '', mode: 'one-shot', depth: 1, hasChildren: true, activity: 'inactive' },
                { id: 'sess-broken', kind: 'diagnostic', depth: 2, reason: 'corrupt' },
            ];
        },
        async interrupt(targetId, authority) {
            calls.push({ op: 'interrupt', targetId, authority });
        },
    };

    /**
     * 假 ctx：服务**只经 `inject` 交出去**，`get` 一律 undefined（与真 cordis 同口径，
     * 见 `verify-profile-rows.js`）。这条老规矩让「用错取值方式」当场红。
     */
    const ctx = {
        tools: { register() {} },
        inject(deps, callback) {
            if (typeof callback !== 'function') return;
            const name = deps[0];
            if (name === 'agents') callback({ agents });
            else if (name === 'jobs') callback({ jobs });
            else if (name === 'subagents') callback({ subagents });
            else callback({});
        },
        get() {
            return undefined;
        },
        on() {},
    };
    mod.apply(ctx);

    const originalSend = process.send;
    const replies = [];
    process.send = (frame) => {
        replies.push(frame);
    };
    let frameSeq = 500;
    const controlFrame = async (method, params) => {
        const id = (frameSeq += 1);
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params });
        for (let waited = 0; waited < 200 && !replies.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        return replies.find((frame) => frame.id === id);
    };

    try {
        const pong = await controlFrame('ping', {});
        check(
            'ping 报告 jobs / subagents 两个能力位（面板据此决定显不显示「活动」抽屉）',
            Boolean(pong && pong.ok && pong.result.jobs === true && pong.result.subagents === true),
            JSON.stringify(pong && pong.result),
        );

        const listed = await controlFrame('jobs/list', { sessionId: 'sess-parent' });
        const result = (listed && listed.result) || {};
        check('jobs/list 回执带 available 与列表', Boolean(listed && listed.ok) && result.available === true && Array.isArray(result.jobs), JSON.stringify(result && result.jobs));
        check(
            '`list()` 带了 Agent（不带的话只剩「无主 job」= 面板永远空白，且不报错）',
            calls.some((call) => call.op === 'list' && call.caller === 'sess-parent'),
            JSON.stringify(calls.filter((call) => call.op === 'list')),
        );
        check(
            '🔴 **一次都没调 `read()`** —— 那是模型的消费游标，读了它 `job_output` 就废了',
            !calls.some((call) => call.op === 'READ-BUG'),
            JSON.stringify(calls.filter((call) => call.op === 'READ-BUG')),
        );
        check(
            '快照里的 `owner`（Agent 实例）没被透传（它会卡在 `process.send` 上）',
            (result.jobs ?? []).every((job) => !('owner' in job) && !('reported' in job)),
            JSON.stringify(result.jobs?.[0]),
        );
        check(
            '子 agent 的 job 也列出来了，并标出 `ownerSessionId` / `depth`（只查父会话会漏掉最要紧的那种）',
            (result.jobs ?? []).some((job) => job.ownerSessionId === 'sess-child' && job.depth === 1),
            JSON.stringify((result.jobs ?? []).map((job) => job.ownerSessionId)),
        );
        check(
            '新的在前（`startedAt` 倒序）',
            (result.jobs ?? []).map((job) => job.id).join(',') === 'subagent-job-1,pwsh-1,pwsh-0,bash-9',
            (result.jobs ?? []).map((job) => job.id).join(','),
        );
        check(
            '不认识的状态既不猜也不假装（`unknown`），退出码在 `detail` 里原样留着',
            (result.jobs ?? []).some((job) => job.id === 'bash-9' && job.status === 'unknown') &&
                (result.jobs ?? []).some((job) => job.id === 'pwsh-0' && job.detail === 'exit code: 0' && job.finishedAt === 150),
            JSON.stringify((result.jobs ?? []).find((job) => job.id === 'bash-9')),
        );
        check(
            '超长 label（pwsh 传的是整条命令原文）被截断到 400',
            (result.jobs ?? []).every((job) => job.label.length <= 400),
            String((result.jobs ?? []).find((job) => job.id === 'bash-9')?.label.length),
        );
        check(
            '如实报「输出读不到」（面板不许假装能看）',
            result.outputReadable === false,
            JSON.stringify(result.outputReadable),
        );

        const subs = await controlFrame('subagents/list', { sessionId: 'sess-parent' });
        const subResult = (subs && subs.result) || {};
        const rows = subResult.subagents ?? [];
        check(
            'subagents/list 列子孙（按 depth 排序）',
            Boolean(subs && subs.ok) && rows.length === 3 && rows[0].depth <= rows[1].depth,
            JSON.stringify(rows.map((row) => `${row.id}@${row.depth}`)),
        );
        check(
            '状态是**自己合成**的：活着看 `agent.status`，找不到 = ready（照抄 list-agents 的口径）',
            rows.find((row) => row.id === 'sess-child')?.status === 'idle' &&
                rows.find((row) => row.id === 'sess-cold')?.status === 'ready',
            JSON.stringify(rows.map((row) => `${row.id}=${row.status}`)),
        );
        check(
            '`activity` 与 `status` 分开留着（前者是「会话记录驻留」，不是「忙不忙」）',
            rows.find((row) => row.id === 'sess-child')?.activity === 'running' &&
                rows.find((row) => row.id === 'sess-cold')?.activity === 'inactive',
            JSON.stringify(rows.map((row) => `${row.id}=${row.activity}`)),
        );
        check(
            '一次性子 agent 标成 one-shot（面板据此把「发消息」藏起来）',
            rows.find((row) => row.id === 'sess-cold')?.mode === 'one-shot' &&
                rows.find((row) => row.id === 'sess-child')?.mode === 'continuable',
            JSON.stringify(rows.map((row) => `${row.id}=${row.mode}`)),
        );
        check(
            '诊断行带 reason（`corrupt` 这类要说出来，不许当成正常子 agent 画）',
            rows.find((row) => row.id === 'sess-broken')?.kind === 'diagnostic' &&
                rows.find((row) => row.id === 'sess-broken')?.reason === 'corrupt',
            JSON.stringify(rows.find((row) => row.id === 'sess-broken')),
        );
        check(
            '没 label 的子 agent 就是空串（不编一个「子 agent 1」出来）',
            rows.find((row) => row.id === 'sess-cold')?.label === '',
            JSON.stringify(rows.find((row) => row.id === 'sess-cold')?.label),
        );

        const interrupted = await controlFrame('subagents/interrupt', { parentSessionId: 'sess-parent', subagentId: 'sess-child' });
        const interruptCall = calls.find((call) => call.op === 'interrupt');
        check(
            '中断的 authority 是 `{kind:"user", parentSessionId}`（用 ancestor 那支会被判越权）',
            Boolean(interrupted && interrupted.ok) &&
                interruptCall?.targetId === 'sess-child' &&
                interruptCall?.authority?.kind === 'user' &&
                interruptCall?.authority?.parentSessionId === 'sess-parent',
            JSON.stringify(interruptCall),
        );
        check('缺参数时说得清（不去调服务）', Boolean((await controlFrame('subagents/interrupt', { subagentId: 'x' }))?.ok === false));
    } finally {
        if (originalSend === undefined) delete process.send;
        else process.send = originalSend;
    }

    // 服务缺失：必须是「说得清的人话」，而不是 null 解引用（与 commands / fileref 同一条规矩）
    const bare = {
        tools: { register() {} },
        inject() {},
        get() {
            return undefined;
        },
        on() {},
    };
    mod.apply(bare);
    const originalSend2 = process.send;
    const replies2 = [];
    process.send = (frame) => {
        replies2.push(frame);
    };
    try {
        for (const [method, needle] of [
            ['jobs/list', 'jobs'],
            ['subagents/list', 'subagents'],
        ]) {
            const id = `bare-${method}`;
            process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method, params: { sessionId: 'x' } });
            for (let waited = 0; waited < 200 && !replies2.some((frame) => frame.id === id); waited += 1) {
                await new Promise((done) => setTimeout(done, 5));
            }
            const reply = replies2.find((frame) => frame.id === id);
            check(
                `服务缺失时 ${method} 回 available:false + 人话（不是错误帧，也不画空列表）`,
                Boolean(reply && reply.ok === true && reply.result.available === false && String(reply.result.reason).includes(needle)),
                JSON.stringify(reply && reply.result),
            );
        }
        const id = 'bare-ping2';
        process.emit('message', { __tag: 'dsh-cocos-bridge', kind: 'ctl', id, method: 'ping', params: {} });
        for (let waited = 0; waited < 200 && !replies2.some((frame) => frame.id === id); waited += 1) {
            await new Promise((done) => setTimeout(done, 5));
        }
        const pong = replies2.find((frame) => frame.id === id);
        check(
            '服务缺失时 ping 的 jobs / subagents 能力位是 false',
            Boolean(pong && pong.ok && pong.result.jobs === false && pong.result.subagents === false),
            JSON.stringify(pong && pong.result),
        );
    } finally {
        if (originalSend2 === undefined) delete process.send;
        else process.send = originalSend2;
    }
}

main().catch((error) => {
    console.error(`[verify-bridge] 异常：${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
});