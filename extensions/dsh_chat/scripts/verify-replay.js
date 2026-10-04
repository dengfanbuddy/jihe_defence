/**
 * 回放（把历史会话读回面板）的**真实数据回归**。
 *
 * ## 为什么值得单独一个脚本
 *
 * 回放这条路上踩过一个**静默**的坑：`tool/result` 的事件形状在两种日志里不一样
 * （老日志内容在 `message.content[0].content`，新 `version: 4` 日志直接是 `message.content`）。
 * 只认一种的后果是「每张工具卡片 `done: true` 但结果一个字都没有」——
 * 不报错、不抛异常，只是看着像工具没输出。这种 bug 只能靠**拿真日志跑一遍**抓。
 *
 * 这里挑本工程最近几条有内容的会话，逐条回放并断言：
 *
 * - 每条都能读出事件（帧扫描器 + 解压链路通了）；
 * - 用户 / 助手 / 思考至少出现两类（投影没把内容吃掉）；
 * - **工具卡片里「有结果」的占比 > 0**（形状容错的哨兵 —— 这条就是上面那个坑）；
 * - 换会话时转写代数递增（面板靠它清空重画）。
 *
 * 只读：不写任何文件、不启动 agent、不碰正在跑的会话。
 *
 * ```sh
 * node scripts/verify-replay.js [--limit 3] [--project <工程根>]
 * ```
 *
 * @module dsh_chat/verify-replay
 */

'use strict';

const { join, resolve } = require('node:path');

/** 面板脚本会摸到编辑器全局对象，这里给一份最小替身（只为让 host 能加载+读日志）。 */
function installEditorStub(projectPath) {
    global.Editor = {
        Project: { path: projectPath },
        App: { name: 'stub', version: '0.0.0' },
        Profile: {
            getConfig: async () => undefined,
            setConfig: async () => undefined,
        },
        Message: {
            request: async () => undefined,
            broadcast: () => undefined,
        },
        Panel: { define: (options) => options },
    };
}

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        // ⚠ 在这里就置退出码，**不要只靠结尾那一行** ——
        // 本脚本原本在最关键的失败上 `if (!listed.ok) return;` 早退，
        // 于是「连会话都列不出来」反而 exit 0（跟 score.mjs 恒 exit 0 是同一类洞）。
        process.exitCode = 1;
    }
};

async function main() {
    const argv = process.argv.slice(2);
    const limitIndex = argv.indexOf('--limit');
    const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 4;
    const projectIndex = argv.indexOf('--project');
    const project = projectIndex >= 0 ? resolve(argv[projectIndex + 1]) : resolve(__dirname, '..', '..', '..');

    installEditorStub(project);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DshHost } = require(join(__dirname, '..', 'dist', 'dsh-host.js'));

    const host = new DshHost();
    const listed = await host.historyList(20);
    check('能列出历史会话', listed.ok === true, listed.error || `${listed.sessions?.length} 条`);
    if (!listed.ok) return;

    const candidates = (listed.sessions ?? []).filter((session) => session.turns > 0).slice(0, limit);
    check('至少有一条有内容的会话可回放', candidates.length > 0);
    if (candidates.length === 0) return;

    let previousGeneration = host.snapshot().generation;
    for (const session of candidates) {
        console.log(`\n[${session.id.slice(0, 12)}] ${JSON.stringify((session.title || '').slice(0, 40))} · ${session.turns} 轮`);
        const opened = await host.loadHistory(session.id);
        check('  回放成功', opened.ok === true, opened.error || `${opened.events} 条事件`);
        if (!opened.ok) continue;

        const snapshot = host.snapshot();
        check('  代数递增（面板据此清空重画）', snapshot.generation === previousGeneration + 1, `${previousGeneration} → ${snapshot.generation}`);
        previousGeneration = snapshot.generation;
        check('  标成「只读历史」', snapshot.sessionKind === 'history' && snapshot.history?.live === false);

        const entries = host.eventsSince(0).entries;
        const kinds = {};
        for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
        console.log(`  条目：${Object.entries(kinds).map(([kind, count]) => `${kind}×${count}`).join(' ')}`);

        const textKinds = ['user', 'agent', 'thinking'].filter((kind) => (kinds[kind] ?? 0) > 0);
        check('  至少两类文本条目（投影没吃掉内容）', textKinds.length >= 2, textKinds.join(', '));

        const tools = entries.filter((entry) => entry.kind === 'tool' && entry.tool);
        const withOutput = tools.filter((entry) => typeof entry.tool.output === 'string' && entry.tool.output.length > 0);
        if (tools.length > 0) {
            console.log(`  工具卡片：${tools.length} 张，其中有结果的 ${withOutput.length} 张`);
            check('  ★工具结果没被形状差异吃掉（形状容错哨兵）', withOutput.length > 0, `${withOutput.length}/${tools.length}`);
            check('  工具卡片带名字', tools.every((entry) => entry.tool.name && entry.tool.name !== 'unknown'));
        }
    }

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(`[verify-replay] 异常：${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
});
