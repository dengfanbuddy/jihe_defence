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

/** 四个工具名 —— 少一个/多一个都要红。 */
const EXPECTED_TOOLS = [
    'cocos_execute_code',
    'cocos_describe_api',
    'cocos_editor_state',
    'cocos_capture_view',
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
        });
    } catch (error) {
        console.warn = originalWarn;
        check('插件能被加载并 apply()', false, error instanceof Error ? error.message : String(error));
        return;
    }
    console.warn = originalWarn;

    check('apply() 注册了 4 个工具', registered.length === 4, registered.map((t) => t.name).join(' / '));
    check(
        '工具名与预期一致',
        registered.map((t) => t.name).sort().join(',') === [...EXPECTED_TOOLS].sort().join(','),
    );
    check('没有 IPC 时给了人话警告', warnings.some((w) => w.includes('没有 IPC 通道')));
    check('惰性请求了 agents 服务（控制通道用）', injected.includes('agents'), injected.join(', ') || '(没有)');
    check(
        'agents 缺失时工具照旧注册、且不谎报控制通道就绪',
        registered.length === 4 && !warnings.some((w) => w.includes('控制通道就绪')),
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
    const ctx = {
        tools: { register() {} },
        inject(deps, callback) {
            if (deps.includes('agents') && typeof callback === 'function') {
                callback({ agents, get: (name) => (name === 'agents' ? agents : undefined) });
            }
        },
        get(name) {
            return name === 'attachments' ? attachmentsStore : undefined;
        },
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

main().catch((error) => {
    console.error(`[verify-bridge] 异常：${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
});
