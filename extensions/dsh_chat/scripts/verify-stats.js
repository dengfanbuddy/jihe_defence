/**
 * 会话**用量**（token / 上下文占用）的回归：合成一份投影缓存跑真读取器 + 与上游口径对账。
 *
 * ## 为什么不能只拿本机的真缓存跑
 *
 * 真缓存适合验「读得出来」，验不了**判据** —— 本机的 490 份记录里没有一份能用来验：
 *
 * - 「压缩后的修正公式」得**同时**造出 `surfaceTokens < sampledSurfaceTokens` 的样本
 *   （真记录里恰好有一份，但那是运气，不是判据）；
 * - 「字段缺一半」「版本号不认识」「JSON 坏了」「id 越界」这些是**守卫**，只能在合成语料上验；
 * - 「花费缺失时必须是 null 而不是 0」—— 真缓存上分不清「没花钱」和「没有这项数据」。
 *
 * ## 三类断言
 *
 * | 类 | 验什么 | 为什么值钱 |
 * |---|---|---|
 * | **上游口径** | 直接读 `dsh-token-meter` 的源码，钉住 `projectedTokens` 的公式与 `stateVersion` | 公式是**照抄**来的；上游一改，这里必须红，而不是静默算错 |
 * | **profile 挂载** | 真跑 `dsh --profile cocos --dump-config`（实测 ~100ms） | 面板的数据源全在 bundle 里；哪天 DSH 不再挂 token-meter，面板就是一片空白 |
 * | **合成语料** | 临时 `DSH_HOME` 下的投影缓存，跑真 `dist/stats.js` | 守卫与缺字段的口径 |
 *
 * 全过程只碰系统临时目录；对**真** `<DSH_HOME>` 只做**只读**普查（目录不存在就跳过）。
 *
 * ```sh
 * node scripts/verify-stats.js [--keep]
 * ```
 *
 * ⚠ 假定 `dist/` 是新的（改完 TS 先 `npm run build`）。
 *
 * @module dsh_chat/verify-stats
 */

'use strict';

const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync, utimesSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const EXT_ROOT = resolve(__dirname, '..');
/** 安装器本体（`[2c]` 那一节要拿它跑「别人没装第三方插件」的分发场景）。 */
const install = require('./install-profile.js');
const { resolveDshHome, PROFILE_NAME, PLUGIN_PACKAGE_NAME } = install;

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        process.exitCode = 1;
    }
};

// ---------------------------------------------------------------- 记录工厂

/**
 * 造一份缓存记录。**形状照抄真记录**（`{version, record:{identity, rows}}`，
 * 行是 `{ver, seq, val}`），默认值取的是本机真记录里见过的量级。
 *
 * @param {object} [patch] - 覆盖字段；`rows` 里给 `null` 表示**删掉这一行**。
 * @returns {object} 可以直接 `JSON.stringify` 的文档。
 */
function record(patch = {}) {
    const rows = {
        contextPressure: {
            ver: 4,
            seq: 900,
            val: { surfaceTokens: 60782, contextWindow: 1_000_000, pressureTokens: 85811, sampledSurfaceTokens: 57836 },
        },
        contextBreakdown: { ver: 2, seq: 900, val: { systemTokens: 1769, toolsTokens: 10763, messageTokens: 60782 } },
        tokenUsage: {
            ver: 2,
            seq: 900,
            val: {
                totals: { uncachedInputTokens: 691370, outputTokens: 429503, cacheReadTokens: 153424640, cacheWriteTokens: 0 },
                last: { turn: 6, step: 45, buckets: { uncachedInputTokens: 168, outputTokens: 366, cacheReadTokens: 172160, cacheWriteTokens: 0 } },
            },
        },
        sessionStats: {
            ver: 1,
            seq: 900,
            val: { turns: 6, steps: 743, llmMs: 2_671_113, toolMs: 438_231, ttftMs: 1_070_229, ttftSteps: 743, decodeMs: 1_600_884, decodeTokens: 450_703 },
        },
        costUsage: {
            ver: 8,
            seq: 900,
            val: {
                provider: 'deepseek-official',
                model: 'deepseek-v4-flash-vision-exp',
                totals: { input: 769619, output: 450703, cacheRead: 156776192, cacheWrite: 0, reasoning: 170881, cost: 1.5802035320000016 },
            },
        },
        modelSelection: { ver: 2, seq: 900, val: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'high' } } },
        // ---- 进度那三行：**形状照抄真记录**（都是投影**状态**，不是客户端 wire view）----
        todos: {
            ver: 2,
            seq: 900,
            val: [
                { content: '读 config 与 schema', status: 'completed' },
                { content: '写 progressOf 的解析', status: 'in_progress' },
                { content: '跑 verify-stats', status: 'pending' },
            ],
        },
        goal: {
            ver: 6,
            seq: 900,
            val: {
                current: {
                    goal: { id: 'goal-1', revision: 2, objective: '把进度面板做出来', phase: 'active', maxGoalRounds: 12 },
                    roundsStarted: 3,
                    createdAt: 1_791_104_776_707,
                    updatedAt: 1_791_104_800_000,
                },
                seenGoalIds: ['goal-1'],
                failure: null,
            },
        },
        turnOutline: {
            ver: 2,
            seq: 900,
            val: {
                turns: [
                    { turn: 1, seq: 3, prompt: '把用量面板做出来', response: '做完了，验证通过。' },
                    { turn: 2, seq: 400, prompt: '顺手把进度也做了', response: '待办清单已经能实时看到。' },
                ],
                draft: '正在写第三轮的回复',
            },
        },
        plan: { ver: 3, seq: 900, val: { active: false, wanted: null, running: null, activeAtLastHeader: false } },
        // ---- 上下文增长曲线：**形状照抄真缓存**（`record.rows.contextTimeline = {ver, seq, val}`，
        //      `val` 是**投影状态** —— `requests` / `events` / `archiveFloor`，不是 wire view 的
        //      `nodes` / `current` / `archive`；照 wire view 读会一个字段都读不到，而且是静默的）。
        //      默认给一份**小的**（3 次调用 + 1 次压缩），够验接线；判据在 [11b] 里用纯函数跑。
        contextTimeline: {
            ver: 13,
            seq: 900,
            val: {
                surface: [],
                sums: { user: 1200, inject: 300, assistant: 40_000, tool: 12_000 },
                systemTokens: 1825,
                toolsTokens: 7037,
                contextWindow: 1_000_000,
                requests: [
                    { time: 1_791_000_000_000, seq: 100, system: 1825, tools: 7037, user: 1000, inject: 300, assistant: 0, tool: 0, total: 10_000, turn: 1, step: 1, prompt: 13_400 },
                    { time: 1_791_000_060_000, seq: 200, system: 1825, tools: 7037, user: 1000, inject: 300, assistant: 4000, tool: 900, total: 30_000, turn: 2, step: 1, prompt: 40_200 },
                    { time: 1_791_000_120_000, seq: 300, system: 1825, tools: 7037, user: 1000, inject: 300, assistant: 12_000, tool: 4200, total: 60_000, turn: 2, step: 2, prompt: 80_400 },
                ],
                events: [{ seq: 210, time: 1_791_000_090_000, kind: 'compaction', tokens: 200_000, count: 42 }],
                archived: [],
            },
        },
        ...(patch.rows ?? {}),
    };
    for (const key of Object.keys(rows)) if (rows[key] === null) delete rows[key];
    return {
        version: patch.version === undefined ? 5 : patch.version,
        record: {
            identity: {
                createdAt: 1_791_104_776_707,
                cwd: 'D:\\Project\\cocos\\jihe_defence',
                isSeeded: false,
                inheritedEventCount: 0,
                ...(patch.identity ?? {}),
            },
            rows,
        },
    };
}

/** 把一份记录写到合成缓存里（`--root` 指的是 `storages` 那一层）。 */
function writeRecord(root, id, document) {
    mkdirSync(join(root, 'session_projcache', 'sessions'), { recursive: true });
    const file = join(root, 'session_projcache', 'sessions', `${id}.json`);
    writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document), 'utf8');
    return file;
}

// ---------------------------------------------------------------- 主流程

async function main() {
    const stats = require(join(EXT_ROOT, 'dist', 'stats.js'));
    const history = require(join(EXT_ROOT, 'dist', 'history.js'));
    const runtime = require(join(EXT_ROOT, 'dist', 'paths.js'));
    const settings = require(join(EXT_ROOT, 'dist', 'settings.js'));

    // ⚠ **先记下真的 DSH_HOME**：下面为了造语料会把它改到临时目录，改完再算就晚了 ——
    // 真的 profile 与真的缓存都在原来那个家底下。（第一版就踩了这个：dump-config 直接 exit 1。）
    const realHome = resolveDshHome();

    const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-stats-'));
    const dshHome = join(tmpRoot, '.dsh');
    const storages = join(dshHome, 'storages');
    mkdirSync(storages, { recursive: true });

    // ⚠ 必须在**任何调用之前**改：读取器每次调用都现读 `DSH_HOME`（它不是模块级常量）。
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;

    try {
        // ============================================================ 1. 路径与口径
        console.log('[1] 路径与 DSH_HOME 口径');
        check('dshHome() 认 DSH_HOME', stats.dshHome() === dshHome, `${stats.dshHome()} vs ${dshHome}`);
        check(
            'dshHome() 与 install-profile 的 resolveDshHome 同一口径',
            resolve(stats.dshHome()) === resolve(resolveDshHome()),
        );
        check(
            'dshHome() 与 history.ts 的 sessionsRoot() 同一口径（同一个 DSH_HOME 下拼出的 sessions）',
            history.sessionsRoot() === join(stats.dshHome(), 'sessions'),
            `${history.sessionsRoot()}`,
        );
        check(
            '缓存根 = <DSH_HOME>/storages/session_projcache/sessions',
            stats.projectionRoot() === join(dshHome, 'storages', 'session_projcache', 'sessions'),
            stats.projectionRoot(),
        );

        // ============================================================ 2. 完整记录
        console.log('\n[2] 一份完整的记录');
        const fullPath = writeRecord(storages, 'full-session', record());
        // mtime 显式设死：不然断言只能比「大致相等」
        const stamp = new Date(1_700_000_000_000);
        utimesSync(fullPath, stamp, stamp);

        const full = await stats.readSessionUsage('full-session', { liveSeq: 1200 });
        check('读得出来', full.ok === true, full.error ?? '');
        const u = full.usage;
        if (u) {
            check('版本号读对了', u.version === 5, String(u.version));
            check('水位取的是行里最大的 seq', u.seq === 900, String(u.seq));
            check('updatedAt 取的是文件 mtime', Math.abs(u.updatedAt - stamp.getTime()) < 2000, String(u.updatedAt));
            check('liveSeq 更大 → behind = 差值', u.behind === 300, String(u.behind));
            check('model / provider 从 costUsage 取', u.model === 'deepseek-v4-flash-vision-exp' && u.provider === 'deepseek-official');
            check('窗口上限', u.context.window === 1_000_000, String(u.context.window));
            check('上一次请求实测 = pressureTokens', u.context.pressure === 85811, String(u.context.pressure));
            check(
                '占用率用**修正后**的预估：max(0, pressure + surface − sampledSurface)',
                u.context.projected === 85811 + 60782 - 57836,
                `${u.context.projected}（期望 ${85811 + 60782 - 57836}）`,
            );
            check('ratio = projected / window 且未钳制', Math.abs(u.context.ratio - u.context.projected / 1_000_000) < 1e-12, String(u.context.ratio));
            check(
                '估算组成三个数分开给（不合并成一个总数）',
                u.context.system === 1769 && u.context.tools === 10763 && u.context.messages === 60782,
            );
            check(
                '累计 token 认的是 uncachedInputTokens 那套命名',
                u.usage.totals && u.usage.totals.input === 691370 && u.usage.totals.cacheRead === 153424640,
                JSON.stringify(u.usage.totals),
            );
            check('最近一步（turn/step/桶）', u.usage.last && u.usage.last.turn === 6 && u.usage.last.step === 45 && u.usage.last.buckets.output === 366);
            check('花费取 costUsage.totals.cost', u.cost && Math.abs(u.cost.amount - 1.5802035320000016) < 1e-9, JSON.stringify(u.cost));
            check('会话统计（回合/步/耗时/首字/解码）', u.session.turns === 6 && u.session.steps === 743 && u.session.decodeTokens === 450703);
            /**
             * 上下文增长曲线走的是**同一次读盘**（它是同一个 JSON 里的另一行）：
             * 所以这里能顺便钉住「宿主没有为了它多读一次盘」这条口径。
             */
            check(
                '上下文增长曲线**同一次读盘**就给出来了（`readSessionUsage` 一个入口，不额外读盘）',
                u.timeline !== null && u.timeline.requests === 3,
                JSON.stringify(u.timeline && { points: u.timeline.points.length, requests: u.timeline.requests }),
            );
            check('一切就绪时曲线也没有话要说（`timelineNote` 是 null）', u.timelineNote === null, String(u.timelineNote));
            check('一切就绪时 notes 是空的（不吓唬人）', u.notes.length === 0, u.notes.join(' ｜ '));
        }

        // ============================================================ 2b. 花费
        console.log('\n[2b] 花费：金额在投影缓存里、**显示口径**在 cost-meter 的账本里');
        const ledgerDir = join(dshHome, 'storages', 'cost-meter');
        const ledgerFile = join(ledgerDir, 'ledger.json');
        check(
            '账本路径与上游同一个位置（<DSH_HOME>/storages/cost-meter/ledger.json）',
            stats.costLedgerPath() === ledgerFile,
            stats.costLedgerPath(),
        );
        check(
            '**没有账本**时：显示口径是 null、给一句原因、而 `notes` 一个字都不加（那不是用量的问题）',
            u.costDisplay === null && typeof u.costNote === 'string' && u.notes.length === 0,
            `${u.costNote} ｜ notes=${u.notes.join(' ｜ ') || '（空）'}`,
        );

        const fakeLedger = {
            version: 3,
            config: { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2, pricingCurrency: 'USD' },
            days: {
                // 跨零点的一条会话：两天各有一半 —— **必须累加**（取最后一条就会少算一半）
                '2026-10-05': {
                    date: '2026-10-05',
                    cost: 3.5,
                    apiCost: 3.5,
                    calls: 1300,
                    sessions: [
                        { id: 'full-session', cost: 1.58, calls: 900, at: 1 },
                        { id: 'other-session', cost: 1.92, calls: 400, at: 2 },
                    ],
                },
                '2026-10-06': { date: '2026-10-06', cost: 0.25, calls: 3, sessions: [{ id: 'full-session', cost: 0.02, calls: 3, at: 3 }] },
            },
        };
        mkdirSync(ledgerDir, { recursive: true });
        writeFileSync(ledgerFile, JSON.stringify(fakeLedger), 'utf8');

        const facts = stats.costFactsOf(fakeLedger, 'full-session', new Date('2026-10-05T12:00:00').getTime());
        check('账本：跨零点的一条会话累加（1.58 + 0.02）', facts && Math.abs(facts.sessionUsd - 1.6) < 1e-9, JSON.stringify(facts));
        check('账本：调用次数也累加（900 + 3）', facts && facts.calls === 903, String(facts && facts.calls));
        check(
            '账本：「今日」认**本地**日期那一天（拿 UTC 会错一天）',
            facts && facts.todayKey === '2026-10-05' && facts.todayUsd === 3.5,
            JSON.stringify(facts),
        );
        check('账本：认不出的形状给 null（不是当成「没花钱」）', stats.costFactsOf({}, 'full-session', Date.now()) === null);
        check('账本：认不出的显示设置给 null（币种/汇率缺一个都不算）', stats.costDisplayOf({ config: { currency: 'CNY' } }) === null);

        const withLedger = await stats.readSessionUsage('full-session');
        check(
            '读到账本之后显示口径齐了（CNY / ¥ / 4 位 / 7.2）',
            withLedger.usage &&
                withLedger.usage.costDisplay?.currency === 'CNY' &&
                withLedger.usage.costDisplay?.symbol === '¥' &&
                withLedger.usage.costDisplay?.decimals === 4 &&
                withLedger.usage.costDisplay?.exchangeRate === 7.2,
            JSON.stringify(withLedger.usage?.costDisplay),
        );
        check('读到账本之后 `costNote` 清空（没有话要说）', withLedger.usage?.costNote === null, String(withLedger.usage?.costNote));
        check(
            '今日那一天的键是本地日期（`YYYY-MM-DD`，两位补零）',
            /^\d{4}-\d{2}-\d{2}$/.test(withLedger.usage?.costLedger?.todayKey ?? ''),
            String(withLedger.usage?.costLedger?.todayKey),
        );

        /**
         * 「这个 profile 挂没挂那个 bundle」是**另一个文件**（`profiles/cocos/package.json`）说的。
         * 这一节临时 DSH_HOME 里本来没有 profile → 应该是 `null`（读不到清单 ⇒ 不猜）。
         */
        check('临时 DSH_HOME 里没有 profile 清单 → costMounted 是 null（不猜）', u.costMounted === null, String(u.costMounted));
        check('bundle 名字由 stats.ts 给（面板话术里要写出来）', u.costBundle === 'dsh-cost-meter', String(u.costBundle));
        mkdirSync(join(dshHome, 'profiles', PROFILE_NAME), { recursive: true });
        writeFileSync(
            stats.profileManifestPath(),
            JSON.stringify({ name: 'dsh-profile-cocos', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
            'utf8',
        );
        check('清单里没有它 → costMounted = false（面板会说「这个 profile 没装」）', (await stats.readCostMount()) === false);
        writeFileSync(
            stats.profileManifestPath(),
            JSON.stringify({ name: 'dsh-profile-cocos', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-cost-meter'] } } }),
            'utf8',
        );
        check('清单里有它 → costMounted = true（面板会说「只是这条会话太老」）', (await stats.readCostMount()) === true);
        writeFileSync(stats.profileManifestPath(), '{ 坏了', 'utf8');
        check('清单坏了 → 还是 null（不是 false：读不到与「真没有」必须分开）', (await stats.readCostMount()) === null);
        rmSync(join(dshHome, 'profiles'), { recursive: true, force: true });

        // 账本坏了：**用量那一半照旧**，只有显示口径没了
        writeFileSync(ledgerFile, '{ 这不是 JSON', 'utf8');
        const brokenLedger = await stats.readSessionUsage('full-session');
        check(
            '账本不是合法 JSON：用量那半照样读得出来（花费也照样有金额）',
            brokenLedger.ok === true && Math.abs(brokenLedger.usage.cost.amount - 1.5802035320000016) < 1e-9,
            brokenLedger.error ?? '',
        );
        check(
            '账本坏了 → `costNote` 说得出原因、显示口径是 null',
            brokenLedger.usage?.costDisplay === null && /JSON/.test(brokenLedger.usage?.costNote ?? ''),
            String(brokenLedger.usage?.costNote),
        );
        writeFileSync(ledgerFile, JSON.stringify(fakeLedger), 'utf8');

        // ---- formatMoney：与**真插件**对拍（装了才跑；没装就说清为什么跳过）----
        const pricingPath = join(realHome, 'profiles', PROFILE_NAME, 'node_modules', 'dsh-cost-meter', 'lib', 'pricing.js');
        if (!existsSync(pricingPath)) {
            console.log(`  ..  没装 dsh-cost-meter（${pricingPath}），跳过「格式化是否逐字一致」的对拍`);
        } else {
            try {
                const mine = require(join(EXT_ROOT, 'dist', 'panels', 'default', 'cost.js'));
                const upstream = await import(pathToFileURL(pricingPath).href);
                const displays = [
                    { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2, pricingCurrency: 'USD' },
                    { currency: 'USD', symbol: '$', decimals: 2, exchangeRate: 1, pricingCurrency: 'USD' },
                    { currency: 'USD', symbol: '$', decimals: 0, exchangeRate: 1, pricingCurrency: 'USD' },
                    { currency: 'CNY', symbol: '¥', decimals: 2, exchangeRate: 0, pricingCurrency: 'CNY' },
                    { currency: 'EUR', symbol: '', decimals: 10, exchangeRate: 0.92, pricingCurrency: 'USD' },
                ];
                // 0 与极小值是要点：极小值必须**自动放宽两位**，否则「花了 0.0003」会印成 0
                const amounts = [0, 0.00003, 0.001, 1.5802035320000016, 2.652012124000002, 1234.5678, 1e6];
                const diffs = [];
                let same = 0;
                for (const display of displays) {
                    for (const amount of amounts) {
                        const a = mine.formatMoney(amount, display);
                        const b = upstream.formatMoney(amount, display);
                        if (a === b) same += 1;
                        else diffs.push(`$${amount}@${display.currency}/d${display.decimals}: ${a} vs ${b}`);
                    }
                }
                check(
                    `formatMoney 与真插件逐字一致（${same}/${displays.length * amounts.length} 组）`,
                    diffs.length === 0 && same > 0,
                    diffs.slice(0, 3).join(' ｜ '),
                );
            } catch (error) {
                check('formatMoney 与真插件对拍', false, `跑不起来：${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // ============================================================ 2c. 分发场景
        console.log('\n[2c] 分发场景：**别人机器上没装那个第三方插件**时，profile 必须起得来');
        /**
         * 这一节防的不是「少一块功能」而是「整个 agent 起不来」：
         * `dsh-app-boot` 的 `loadProfile` 是 `bundles.map(resolveBundleDir)`，而
         * `resolveBundleDir` 解析不到就**直接抛**（实测过：`dsh --profile <探针> --dump-config`
         * 连配置都打不出来）。所以「真源里声明了」与「装出去的那份清单」**不能是同一份内容** ——
         * 装出去的那份要把解析不到的第三方 bundle 摘掉。
         *
         * ⚠ **真源现在一个第三方依赖都没有**（2026-12 的决定：零第三方 bundle，§8 有一条红线
         * 盯着它）。而这条「摘掉」的通用机制还得继续有人验 —— 所以这里改用一份**合成真源**
         * （一个不存在的假第三方包名）来跑：**验的是机制，不是某个具体的包**。
         * 这样即使以后一个第三方包都不挂，这段自愈逻辑也不会烂在没人跑的地方。
         */
        const FAKE_DEP = 'dsh-fake-third-party';
        const fixtureSource = join(tmpRoot, 'fixture-profile');
        mkdirSync(fixtureSource, { recursive: true });
        // installProfile 在没有 cordis.yml 时会 readFileSync 源文件（对缺失的源不兜底），所以补一份。
        copyFileSync(join(EXT_ROOT, 'dsh-profile', 'cordis.yml'), join(fixtureSource, 'cordis.yml'));
        writeFileSync(
            join(fixtureSource, 'package.json'),
            `${JSON.stringify(
                {
                    name: 'dsh-profile-fixture',
                    version: '0.0.0',
                    private: true,
                    dsh: {
                        profile: {
                            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', FAKE_DEP],
                            patchReload: 'live',
                        },
                    },
                    dependencies: { [FAKE_DEP]: '^1.0.0' },
                },
                null,
                4,
            )}\n`,
            'utf8',
        );
        const distHome = join(tmpRoot, 'dist-home');
        mkdirSync(join(distHome, 'profiles'), { recursive: true });
        const distReport = install.installProfile({ dshHome: distHome, sourceDir: fixtureSource });
        const distManifest = JSON.parse(readFileSync(join(distHome, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'));
        const distBundles = distManifest.dsh?.profile?.bundles ?? [];
        check(
            '没装那个第三方 bundle 时：**从装出去的 bundles 里摘掉**（不摘 DSH 启动就抛）',
            !distBundles.includes(FAKE_DEP),
            JSON.stringify(distBundles),
        );
        check(
            'in-box 的 bundle 一个都不动（它们走 dsh 自己的安装目录，不是我们的依赖）',
            distBundles.includes('@deepseek-ai/dsh-base') && distBundles.includes('@deepseek-ai/dsh-sdk-app'),
            JSON.stringify(distBundles),
        );
        check(
            '`dependencies` **原样保留**（意图留着，`dsh plugin --profile cocos install` 才有东西可装 —— 那条命令正是 DSH 报错里推荐的恢复路径）',
            distManifest.dependencies?.[FAKE_DEP] !== undefined,
            JSON.stringify(distManifest.dependencies),
        );
        check(
            '装出去的那份是**幂等**的（再算一次逐字节相同，不会每次加载都白写盘）',
            install.syncProfileManifest(fixtureSource, join(distHome, 'profiles', PROFILE_NAME), distHome).text ===
                readFileSync(join(distHome, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'),
        );
        check(
            '报告里**说了**摘掉这件事（不是默默改 profile）',
            distReport.changes.some((line) => line.includes('摘掉')) && distReport.warnings.some((line) => line.includes('直接抛')),
            distReport.changes.join(' ｜ '),
        );
        check(
            '缺依赖时给出的是 `dsh plugin --profile cocos install`（那条命令真能把依赖装回来）',
            distReport.warnings.some((line) => line.includes('dsh plugin --profile cocos install')),
            distReport.warnings.filter((line) => line.includes('plugin')).join(' ｜ '),
        );
        check(
            '`deps.missingDeclared` 带出来给调用方报红（否则面板上看不出「花费为什么没有」）',
            Array.isArray(distReport.deps?.missingDeclared) && distReport.deps.missingDeclared.includes(FAKE_DEP),
            JSON.stringify(distReport.deps?.missingDeclared),
        );
        // 装上之后必须**自己回来**：真源照旧声明，装出去的那份重新包含它（自愈，两个方向都收敛）
        mkdirSync(join(distHome, 'profiles', PROFILE_NAME, 'node_modules', FAKE_DEP), { recursive: true });
        writeFileSync(
            join(distHome, 'profiles', PROFILE_NAME, 'node_modules', FAKE_DEP, 'package.json'),
            JSON.stringify({ name: FAKE_DEP, version: '0.0.0-test' }),
            'utf8',
        );
        install.installProfile({ dshHome: distHome, sourceDir: fixtureSource });
        const reinstalled = JSON.parse(readFileSync(join(distHome, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'));
        check(
            '装上之后再装一次 profile：那一行**自己回来**（自愈，不需要手工改清单）',
            (reinstalled.dsh?.profile?.bundles ?? []).includes(FAKE_DEP),
            JSON.stringify(reinstalled.dsh?.profile?.bundles),
        );

        // ============================================================ 3. 压缩修正
        console.log('\n[3] 压缩过的记录：占用率必须用修正值，并说出来');
        writeRecord(
            storages,
            'compacted',
            record({
                rows: {
                    contextPressure: {
                        ver: 4,
                        seq: 500,
                        val: { surfaceTokens: 3864, contextWindow: 1_000_000, pressureTokens: 273437, sampledSurfaceTokens: 180625 },
                    },
                },
            }),
        );
        const compacted = await stats.readSessionUsage('compacted');
        check('projected 按公式修正（不是拿 pressure 冒充）', compacted.usage?.context.projected === 273437 + 3864 - 180625, String(compacted.usage?.context.projected));
        check(
            '明说「压缩过」——不说的话用户会以为占用率凭空掉了一大截',
            (compacted.usage?.notes ?? []).some((note) => note.includes('压缩过')),
            (compacted.usage?.notes ?? []).join(' ｜ '),
        );
        writeRecord(storages, 'only-pressure', record({ rows: { sessionStats: null, costUsage: null, modelSelection: null } }));
        const onlyPressure = await stats.readSessionUsage('only-pressure');
        check(
            '没有 sessionStats / costUsage 时读得出来，对应字段是 null',
            onlyPressure.ok === true && onlyPressure.usage?.session.turns === null && onlyPressure.usage?.cost === null,
            onlyPressure.error ?? '',
        );

        // ============================================================ 4. 缺字段
        console.log('\n[4] 缺字段：能给的照给，给不了的退到实测并说明');
        writeRecord(
            storages,
            'no-sample',
            record({
                rows: {
                    contextPressure: { ver: 4, seq: 10, val: { surfaceTokens: 100, contextWindow: 200_000, pressureTokens: 5000 } },
                },
            }),
        );
        const noSample = await stats.readSessionUsage('no-sample');
        check('缺 surface 采样 → 退回实测值', noSample.usage?.context.projected === 5000, String(noSample.usage?.context.projected));
        check(
            '并且说清楚「这是实测不是预估」',
            (noSample.usage?.notes ?? []).some((note) => note.includes('上一次请求的实测')),
            (noSample.usage?.notes ?? []).join(' ｜ '),
        );

        writeRecord(storages, 'no-window', record({ rows: { contextPressure: { ver: 4, seq: 10, val: { surfaceTokens: 100, pressureTokens: 5000 } } } }));
        const noWindow = await stats.readSessionUsage('no-window');
        check('没有窗口上限 → ratio 是 null（不是 0、不是 NaN）', noWindow.usage?.context.ratio === null && noWindow.usage?.context.window === null);
        check('并且说清楚「没有占用率只有绝对量」', (noWindow.usage?.notes ?? []).some((note) => note.includes('不知道窗口上限')), (noWindow.usage?.notes ?? []).join(' ｜ '));

        writeRecord(storages, 'no-pressure', record({ rows: { contextPressure: { ver: 4, seq: 10, val: { surfaceTokens: 100, contextWindow: 200_000 } } } }));
        const noPressure = await stats.readSessionUsage('no-pressure');
        check('连实测都没有 → projected null', noPressure.usage?.context.projected === null);
        check('并且说清楚「provider 还没报过 usage」', (noPressure.usage?.notes ?? []).some((note) => note.includes('还没报过')), (noPressure.usage?.notes ?? []).join(' ｜ '));

        writeRecord(storages, 'no-blocks', record({ rows: { contextPressure: null, contextBreakdown: null, tokenUsage: null, sessionStats: null, costUsage: null, modelSelection: null } }));
        const noBlocks = await stats.readSessionUsage('no-blocks');
        check('整块行都没有时读得出来（不是错误）', noBlocks.ok === true, noBlocks.error ?? '');
        check(
            '并且明说「没有上下文占用记录」「没有 token 计数记录」',
            (noBlocks.usage?.notes ?? []).some((note) => note.includes('没有上下文占用记录')) &&
                (noBlocks.usage?.notes ?? []).some((note) => note.includes('没有 token 计数记录')),
            (noBlocks.usage?.notes ?? []).join(' ｜ '),
        );
        check(
            '**花费缺失时是 null，绝不是 0**（0 会假装「没花钱」）',
            noBlocks.usage?.cost === null,
            JSON.stringify(noBlocks.usage?.cost),
        );

        // ============================================================ 5. 脏数据
        console.log('\n[5] 脏数据：数字只认有限非负数，不许把 NaN 画成进度条');
        writeRecord(
            storages,
            'dirty',
            record({
                rows: {
                    contextPressure: { ver: 4, seq: 10, val: { surfaceTokens: '100', contextWindow: -5, pressureTokens: NaN, sampledSurfaceTokens: 3 } },
                    tokenUsage: { ver: 2, seq: 10, val: { totals: { uncachedInputTokens: -1, outputTokens: 'x', cacheReadTokens: null }, last: 'nope' } },
                },
            }),
        );
        const dirty = await stats.readSessionUsage('dirty');
        check('脏字段一律当缺失', dirty.usage?.context.window === null && dirty.usage?.context.pressure === null, JSON.stringify(dirty.usage?.context));
        check(
            '四个桶一个数都不是 → 整块当没有（**不**凭空补 0）',
            dirty.usage?.usage.totals === null,
            JSON.stringify(dirty.usage?.usage.totals),
        );
        check('`last` 形状不对时当没有', dirty.usage?.usage.last === null);
        const allNumbers = [];
        const walk = (value) => {
            if (typeof value === 'number') allNumbers.push(value);
            else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
        };
        walk(dirty.usage);
        check('整份结果里没有一个 NaN / Infinity', allNumbers.every((value) => Number.isFinite(value)), `${allNumbers.length} 个数字`);

        // ============================================================ 6. 守卫
        console.log('\n[6] 守卫：id 越界、文件不在、JSON 坏了、格式不认识');
        for (const bad of ['..', '.', 'a/b', 'a\\b', 'x'.repeat(200), '']) {
            const result = await stats.readSessionUsage(bad);
            check(
                `id ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 20)}…` : bad)} 被挡住（不读盘）`,
                result.ok === false && result.error.includes('id'),
                result.error,
            );
        }
        const missing = await stats.readSessionUsage('never-written');
        check(
            '文件不在 → 说「还没有记录」而不是报错（⚠ 措辞是「投影缓存」不是「用量」：同一个原因会显示在**两个**抽屉里）',
            missing.ok === false && missing.error.includes('还没有投影缓存记录'),
            missing.error,
        );

        writeRecord(storages, 'broken', '{"version": 5, "record": {"rows": {');
        const broken = await stats.readSessionUsage('broken');
        check('JSON 坏了 → 明确说不是合法 JSON', broken.ok === false && broken.error.includes('不是合法 JSON'), broken.error);

        writeRecord(storages, 'no-rows', { version: 5, record: { identity: {} } });
        const noRows = await stats.readSessionUsage('no-rows');
        check('没有 record.rows → 明确说形状不认识', noRows.ok === false && noRows.error.includes('rows'), noRows.error);

        for (const shape of [null, [], 'nope', { record: 'nope' }]) {
            const result = stats.normalizeUsageRecord(shape, { id: 'x' });
            check(`normalizeUsageRecord(${JSON.stringify(shape)}) 不崩、明确失败`, result.ok === false && typeof result.error === 'string', result.error);
        }

        writeRecord(storages, 'future', record({ version: 6 }));
        const future = await stats.readSessionUsage('future');
        check('格式版本不认识 → 照读，但**说出来**', future.ok === true && (future.usage?.notes ?? []).some((note) => note.includes('v6')), (future.usage?.notes ?? []).join(' ｜ '));

        writeRecord(
            storages,
            'seeded',
            record({ identity: { isSeeded: true, inheritedEventCount: 1234 } }),
        );
        const seeded = await stats.readSessionUsage('seeded');
        check(
            '接过来的会话要说「合计只算本日志」',
            (seeded.usage?.notes ?? []).some((note) => note.includes('1234')),
            (seeded.usage?.notes ?? []).join(' ｜ '),
        );

        writeRecord(
            storages,
            'overflow',
            record({ rows: { contextPressure: { ver: 4, seq: 10, val: { surfaceTokens: 0, contextWindow: 1000, pressureTokens: 4000 } } } }),
        );
        const overflow = await stats.readSessionUsage('overflow');
        check('超过窗口上限 → ratio > 1 且 notes 说出来（不许悄悄钳到 100%）', (overflow.usage?.context.ratio ?? 0) > 1 && (overflow.usage?.notes ?? []).some((note) => note.includes('超过窗口上限')));

        // ============================================================ 7. 上游口径
        console.log('\n[7] 上游口径对账（公式是照抄来的，变了必须红）');
        const resolved = runtime.resolveRuntime(settings.getSettings ? settings.getSettings() : {});
        const tokenMeterJs = (() => {
            const candidates = [];
            // dsh 自己的安装目录：`…/node_modules/@deepseek-ai/dsh/lib/bin.js` →
            // `…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter`
            if (resolved.dshBin) {
                const dshPkg = resolve(resolved.dshBin, '..', '..');
                candidates.push(join(dshPkg, 'node_modules', '@deepseek-ai', 'dsh-token-meter'));
            }
            // profile 的共享依赖（DSH 安装时就位的那份）
            candidates.push(join(realHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-token-meter'));
            candidates.push(join(EXT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-token-meter'));
            for (const base of candidates) {
                const candidate = join(base, 'lib', 'types', 'usage-projection.js');
                if (existsSync(candidate)) return candidate;
            }
            return null;
        })();
        if (!tokenMeterJs) {
            check('找得到 dsh-token-meter 的源码（口径对账的真源）', false, '没找到 lib/types/usage-projection.js');
        } else {
            const source = readFileSync(tokenMeterJs, 'utf8');
            check(
                'projectedTokens 的公式没变（max(0, pressure + surface − sampledSurface)）',
                /projectedTokens:\s*Math\.max\(0,\s*pressureTokens\s*\+\s*surfaceTokens\s*-\s*sampledSurfaceTokens\)/.test(source),
                tokenMeterJs,
            );
            check(
                'pressure 的口径没变（input + cacheRead + cacheWrite，**不含输出**）',
                /inputTokens\s*\+\s*\(usage\.cacheReadTokens\s*\?\?\s*0\)\s*\+\s*\(usage\.cacheWriteTokens\s*\?\?\s*0\)/.test(source),
            );
            for (const [unit, version] of [['tokenUsage', 2], ['contextPressure', 4]]) {
                const pattern = new RegExp(`key:\\s*'${unit}'[\\s\\S]{0,200}?stateVersion:\\s*${version}\\b`);
                check(
                    `${unit} 的 stateVersion 还是 ${version}（升版了就来人看一眼：字段名/含义变了没）`,
                    pattern.test(source),
                );
            }
        }

        // ============================================================ 7b. 上游口径：进度那三行
        //
        // 这一组盯的是**形状**，因为进度那三行踩的坑和用量不同：
        // 用量是把状态当视图读（字段名恰好对得上，错了也看不出来），而进度是
        // **状态与视图根本不同形** —— `turnOutline` 的状态是 `{turns, draft}`、
        // 视图是 `turns` 那个数组本身；`goal` 的状态多一层 `current`。
        console.log('\n[7b] 上游口径对账（进度：清单 / 目标 / 回合大纲）');
        const pkgDir = (name) => {
            const candidates = [];
            if (resolved.dshBin) candidates.push(join(resolve(resolved.dshBin, '..', '..'), 'node_modules', '@deepseek-ai', name));
            candidates.push(join(realHome, 'profiles', 'node_modules', '@deepseek-ai', name));
            candidates.push(join(EXT_ROOT, 'node_modules', '@deepseek-ai', name));
            for (const base of candidates) if (existsSync(base)) return base;
            return null;
        };
        const readUpstream = (pkg, relative) => {
            const dir = pkgDir(pkg);
            if (!dir) return null;
            const file = join(dir, ...relative);
            return existsSync(file) ? readFileSync(file, 'utf8') : null;
        };

        const cacheSource = readUpstream('dsh-session-projection-cache', ['lib', 'index.js']);
        if (cacheSource === null) {
            check('找得到 dsh-session-projection-cache 的源码', false, '没找到 lib/index.js');
        } else {
            check(
                '缓存行里的 `val` 是投影的**状态**（不是客户端 wire view）—— 这就是为什么占用率要自己算、大纲要多读一层',
                /`val` is the unit's internal state/.test(cacheSource),
            );
        }

        const todoSource = readUpstream('dsh-tool-todo', ['lib', 'index.js']);
        if (todoSource === null) {
            check('找得到 dsh-tool-todo 的源码', false, '没找到 lib/index.js');
        } else {
            check('todos 的投影键与 stateVersion(2) 没变', /key:\s*"todos"[\s\S]{0,400}?stateVersion:\s*2/.test(todoSource));
            check('工具名还是 `todo_write`（面板没读工具调用，但这个前提要成立）', /name:\s*"todo_write"/.test(todoSource));
            check(
                '**清单在每一轮开始时归零**（`turn/start` → null）—— 面板上「本轮还没写清单」那句判据就是它',
                /event\.type === "turn\/start"\)\s*return null/.test(todoSource),
            );
            check(
                '清单状态只有三种（面板的白名单跟着它）',
                /"pending",\s*"in_progress",\s*"completed"/.test(todoSource),
            );
            check('清单是**整份替换**（每次 `todo_write` 都是完整的新表，不是增量）', /COMPLETE task list/.test(todoSource));
        }

        const outlineSource = readUpstream('dsh-session-turn-outline', ['lib', 'types', 'projection.js']);
        if (outlineSource === null) {
            check('找得到 dsh-session-turn-outline 的源码', false, '没找到 lib/types/projection.js');
        } else {
            check(
                '大纲的**状态**是 `{turns, draft}`，而 wire view 就是 `turns` 数组 —— 照视图读会一条都读不到',
                /turns:\s*turnOutlineEntriesSchema/.test(outlineSource) &&
                    /draft:\s*z\.string\(\)/.test(outlineSource) &&
                    /view:\s*state\s*=>\s*state\.turns/.test(outlineSource),
            );
            check('大纲里每一轮的 `seq` 就是那一轮 `turn/start` 的 seq', /seq:\s*event\.seq/.test(outlineSource));
            check('大纲的 stateVersion 还是 2', /stateVersion:\s*2/.test(outlineSource));
            const promptLimit = /PROMPT_PREVIEW_LIMIT\s*=\s*(\d+)/.exec(outlineSource);
            const responseLimit = /RESPONSE_PREVIEW_LIMIT\s*=\s*(\d+)/.exec(outlineSource);
            check(
                '上游自己的预览上限仍然很小（面板的截断阈值是守卫，正常数据上不该触发）',
                Boolean(promptLimit) && Boolean(responseLimit) && Number(promptLimit[1]) <= 200 && Number(responseLimit[1]) <= 400,
                `prompt ≤ ${promptLimit?.[1] ?? '?'} / response ≤ ${responseLimit?.[1] ?? '?'} 字符`,
            );
        }

        const goalSource = readUpstream('dsh-goal', ['lib', 'index.js']);
        if (goalSource === null) {
            check('找得到 dsh-goal 的源码', false, '没找到 lib/index.js');
        } else {
            check(
                '目标的 wire view 是 `state.current`（缓存读的是**状态**，所以多一层 `current`）',
                /view:\s*\(state\)\s*=>\s*state\.current/.test(goalSource),
            );
            check('goal 的 stateVersion 还是 6', /key:\s*"goal"[\s\S]{0,1200}?stateVersion:\s*6/.test(goalSource));
            check(
                '`goal/change` 有 **clear 墓碑**（读不到目标可能是「刚被清掉」，不是读失败）',
                /operation === "clear"/.test(goalSource) && /goal clear tombstone/.test(goalSource),
            );
            check(
                '`failure` 是一句话（字符串），不是对象 —— 面板直接把它显示出来',
                /failure:\s*z\$1\.string\(\)\.min\(1\)\.nullable\(\)/.test(goalSource),
            );
        }

        // ============================================================ 7c. 事件表
        console.log('\n[7c] 实时事件表（进度靠这三个事件实时更新，靠的不是轮询）');
        const eventTypes = (() => {
            const dir = pkgDir('dsh-session');
            if (!dir) return null;
            const file = join(dir, 'lib', 'types', 'known-event-types.js');
            if (!existsSync(file)) return null;
            const source = readFileSync(file, 'utf8');
            const match = /KNOWN_SESSION_EVENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
            if (!match) return null;
            // ⚠ 这个生成物用的是**单引号**（第一版只匹配双引号，结果读到 0 种事件，
            // 五条断言全红 —— 而「0 种」在当时被当成了「事件表里没有」，看起来还挺合理）
            return new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]));
        })();
        if (eventTypes === null) {
            check('读得到会话事件表（known-event-types）', false, '没找到或格式变了');
        } else {
            for (const type of ['todo/write', 'turn/start', 'goal/change']) {
                check(`事件表里有 \`${type}\`（面板实时更新靠它）`, eventTypes.has(type), `${eventTypes.size} 种事件`);
            }
            check(
                '`plan/mode` 存在但**本机 490 份记录里一次都没 active 过** —— 所以没有计划面板（见 [11] 的普查）',
                eventTypes.has('plan/mode'),
            );
            check(
                '有 `compaction/*` 事件（压缩这件事以后可以从「推断」升级成「事实」）',
                eventTypes.has('compaction/start') && eventTypes.has('compaction/summary'),
            );
        }

        // ============================================================ 8. profile 挂载
        console.log('\n[8] cocos profile 真的挂着数据源（真跑 --dump-config，实测 ~100ms）');
        if (!resolved.nodeExe || !resolved.dshBin) {
            check('探测到 node 与 dsh（这一段要真跑 CLI）', false, `${resolved.nodeExe} / ${resolved.dshBin}`);
        } else {
            const dump = spawnSync(resolved.nodeExe, [resolved.dshBin, '--profile', PROFILE_NAME, '--dump-config'], {
                cwd: resolve(EXT_ROOT, '..', '..'),
                // ⚠ 显式带上**真的** DSH_HOME：本脚本把 process.env 改到临时目录去了，
                // 不改回来就会去找一个不存在的 profile（第一版就是这么 exit 1 的）
                env: { ...process.env, DSH_HOME: realHome },
                encoding: 'utf8',
                timeout: 60_000,
                windowsHide: true,
            });
            const config = `${dump.stdout ?? ''}`;
            check('dump-config 跑得出来', config.length > 0, `exit=${dump.status}`);
            check("挂着 token-meter（tokenUsage / contextPressure / contextBreakdown 三个投影的来源）", /- id:\s*token-meter[\s\S]{0,120}dsh-token-meter/.test(config));
            check('挂着 session-projection-cache（这些数字就是它落的盘）', /- id:\s*session-projection-cache/.test(config));
            const everyEvents = /writeEveryEvents:\s*(\d+)/.exec(config);
            const interval = /writeIntervalMs:\s*(\d+)/.exec(config);
            check(
                '缓存的节流参数还在（这就是「数字可能落后一点」的原因）',
                Boolean(everyEvents) && Boolean(interval) && Number(everyEvents[1]) > 0 && Number(interval[1]) > 0,
                `每 ${everyEvents?.[1] ?? '?'} 条事件 / ${interval?.[1] ?? '?'} ms`,
            );
            /**
             * **零第三方 bundle**（2026-12 的决定）。
             *
             * 这里原来盯的是「第三方 `dsh-cost-meter` 那一行：装了就出现、没装就没有」（双向断言）。
             * 口径改了：**我们一个第三方 bundle 都不声明** —— 因为「声明了却没装」的代价
             * 不是「少一块功能」，而是 `resolveBundleDir` 直接抛 ⇒ **整棵树起不来**
             * （面板上只有一句「agent 启动失败」，看不出跟哪个包有关）。
             *
             * 所以现在是一条**红线**，三处一起看：
             *   ① 真源的 `bundles` 里只许有 in-box 的（`@deepseek-ai/`）；
             *   ② `dependencies` 必须是空的；
             *   ③ 这台机器上**装出去的那份**也一样（install-profile 跑过才会同步）。
             * 顺带：`dump-config` 里也不许冒出第三方插件的行 —— 那说明 profile 的合成结果
             * 跟我们的真源已经不是一回事了。
             *
             * ⚠ 想恢复「挂第三方」时，必须**同时**改这条断言与 README 的口径 —— 那是**有意的
             * 决定**，不是随手能改的实现细节（`[2c]` 那套「摘掉」机制本身就是为它准备的）。
             */
            const installedManifest = existsSync(join(realHome, 'profiles', PROFILE_NAME, 'package.json'))
                ? JSON.parse(readFileSync(join(realHome, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'))
                : null;
            const profileManifest = JSON.parse(readFileSync(join(EXT_ROOT, 'dsh-profile', 'package.json'), 'utf8'));
            const bundles = profileManifest.dsh?.profile?.bundles ?? [];
            const thirdParty = bundles.filter((name) => !name.startsWith('@deepseek-ai/'));
            check(
                '真源的 bundles 里只有 in-box（`@deepseek-ai/*`）—— 第三方一个都不声明',
                thirdParty.length === 0,
                thirdParty.length > 0 ? thirdParty.join(',') : bundles.join(','),
            );
            check(
                '而且 `dependencies` 是空的（有依赖就带着「声明了却没装 ⇒ 整棵树起不来」那条风险）',
                Object.keys(profileManifest.dependencies ?? {}).length === 0,
                JSON.stringify(profileManifest.dependencies ?? {}),
            );
            check(
                '装出去的那份也一样干净（差异只可能来自 install-profile 还没跑）',
                !(installedManifest?.dsh?.profile?.bundles ?? []).some((name) => !name.startsWith('@deepseek-ai/')),
                JSON.stringify(installedManifest?.dsh?.profile?.bundles ?? null),
            );
            check(
                'dump-config 里也没有第三方插件的行（它就是「花费」那一块说"本 profile 刻意不挂它"的依据）',
                !/- id:\s*cost-meter/.test(config),
            );
            check('挂着 session-projection（缓存要有地方注册）+ 存储域', /- id:\s*session-projection\b/.test(config) && /- id:\s*storage-domain\b/.test(config));
        }

        // ============================================================ 9. 接线锚点
        console.log('\n[9] 接线锚点（面板/主进程那条路少一环就是空白）');
        const constants = readFileSync(join(EXT_ROOT, 'source', 'constants.ts'), 'utf8');
        const host = readFileSync(join(EXT_ROOT, 'source', 'dsh-host.ts'), 'utf8');
        const pkg = JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8'));
        check("constants.ts 里有 MSG.sessionUsage = 'session-usage'", /sessionUsage:\s*'session-usage'/.test(constants));
        check('package.json 注册了 session-usage 消息', Boolean(pkg.contributions?.messages?.['session-usage']?.methods?.length));
        check('AgentSnapshot 带 usage 字段（状态轮询那条路）', /^\s+usage: SessionUsage \| null;/m.test(constants));
        check('HostUpdateView 带 usage 字段（广播那条路）', /^\s+usage\?: SessionUsage \| null;/m.test(constants));
        check('constants.ts 导出 formatTokens（面板与主进程同一套缩写）', /export function formatTokens/.test(constants));
        check('dsh-host.ts 调 readSessionCache（一次读盘给用量 + 进度）', /readSessionCache\(/.test(host));
        check('dsh-host.ts 把实时水位传下去（behind 靠它）', /liveSeq/.test(host));
        check('dsh-host.ts 在回合结束时刷新用量', /refreshUsage\(/.test(host));
        check('AgentSnapshot 带 progress 字段（状态轮询那条路）', /^\s+progress: ProgressView \| null;/m.test(constants));
        check('HostUpdateView 带 progress 字段（广播那条路 —— 清单是回合**中间**写的，等轮询会迟到）', /^\s+progress\?: ProgressView \| null;/m.test(constants));
        check(
            'dsh-host.ts 实时处理 `todo/write`（清单不等缓存）',
            /case 'todo\/write'/.test(host) && /applyLiveTodos\(/.test(host),
        );
        check('dsh-host.ts 在 `turn/start` 上记回合锚点（回合目录才点得动）', /case 'turn\/start'/.test(host) && /markTurnStart\(/.test(host));
        check('dsh-host.ts 处理 `goal/change`', /case 'goal\/change'/.test(host) && /applyLiveGoal\(/.test(host));
        check('解析只在 stats.ts 一处（宿主不自己读缓存字段）', /export function parseTodos/.test(readFileSync(join(EXT_ROOT, 'source', 'stats.ts'), 'utf8')));

        /**
         * 接线锚点：**活动**（后台任务 / 子 agent）。
         *
         * 与用量/进度那两条**刻意不同**：它们那一列锚点里有 `AgentSnapshot` / `HostUpdateView`
         * 的字段（因为要经状态轮询与广播回面板），而活动这两块**不在快照里** ——
         * 面板自己按节流打一条专门的消息去问（它们只活在运行时内存里，宿主不起定时器）。
         * 所以这里的锚点是「消息注册 + 宿主方法 + 面板那条节流」这几环，
         * 少一环的症状都是**静默空白**（抽屉里什么都没有，也不报错）。
         */
        check("constants.ts 里有 MSG.panelActivity = 'panel-activity'", /panelActivity:\s*'panel-activity'/.test(constants));
        check("constants.ts 里有 MSG.subagentInterrupt = 'subagent-interrupt'", /subagentInterrupt:\s*'subagent-interrupt'/.test(constants));
        check('package.json 注册了 panel-activity 消息', Boolean(pkg.contributions?.messages?.['panel-activity']?.methods?.length));
        check('package.json 注册了 subagent-interrupt 消息', Boolean(pkg.contributions?.messages?.['subagent-interrupt']?.methods?.length));
        check('dsh-host.ts 有 panelActivity（两条控制帧并发打给插件）', /async panelActivity\(/.test(host) && /'jobs\/list'/.test(host) && /'subagents\/list'/.test(host));
        check(
            '活动那两块**没有**塞进 AgentSnapshot（它们只活在运行时内存里，要专门问；塞进去会让每次状态轮询都打两条控制帧）',
            !/^\s+activity: ActivityView \| null;/m.test(constants),
        );
        const panel = readFileSync(join(EXT_ROOT, 'source', 'panels', 'default', 'index.ts'), 'utf8');
        check('面板按节流去问活动（没有推送可订阅，只能问）', /shouldPollActivity\(/.test(panel) && /ACTIVITY_POLL_MS/.test(panel));
        check(
            '面板在「没起 agent」时说清是「内存里没有」而不是「读盘失败」',
            /只活在运行时进程里/.test(panel),
        );
        check(
            '面板如实说「看不到任务的输出」（消费游标那条，README「活动」一节里也写着）',
            /消费游标/.test(panel),
        );
        const bridge = readFileSync(join(EXT_ROOT, 'dsh-profile', 'plugin', PLUGIN_PACKAGE_NAME, 'index.js'), 'utf8');
        check("插件注册了三个控制方法（jobs/list / subagents/list / subagents/interrupt）", /case 'jobs\/list'/.test(bridge) && /case 'subagents\/list'/.test(bridge) && /case 'subagents\/interrupt'/.test(bridge));
        check(
            '🔴 插件里**没有** `jobs.read(`（每个 job 只有一个消费游标，读一次就把模型的 job_output 废掉）',
            !/jobs\.read\(/.test(bridge),
        );

        /**
         * 接线锚点：**导出 zip / 回收附件**（2026-12 加）。
         *
         * 这一组防的是「脚本会了、面板不会」—— 四层里少一层都是**静默**的：
         * 面板上点不出那个按钮、点了传不到脚本、脚本收到的旗标名字对不上。
         * 所以每一层各一条断言，而且都盯着**具体的旗标字符串**（不是"有没有那个函数"）。
         */
        const historySource = readFileSync(join(EXT_ROOT, 'source', 'history.ts'), 'utf8');
        const mainSource = readFileSync(join(EXT_ROOT, 'source', 'main.ts'), 'utf8');
        check('history.ts 会拼 `--format zip`（ZIP 是单独一档，不是给 md 加开关）', /zip \? 'zip' : format === 'jsonl'/.test(historySource));
        check(
            'history.ts 会拼 `--with-subagents` / `--with-media`（zip 那一路显式写出来，好让"面板点了什么"与"脚本收到什么"对得上）',
            /--with-subagents/.test(historySource) && /--with-media/.test(historySource),
        );
        check(
            'history.ts 会拼 `--reclaim-attachments`（默认关，勾了才加）',
            /--reclaim-attachments/.test(historySource) && /options\.reclaimAttachments === true/.test(historySource),
        );
        check('history.ts 把子孙里的 subagent 与 fork **分开**收下来（不是合成一个数）', /subagentCount/.test(historySource) && /forkCount/.test(historySource));
        check('main.ts 把 reclaim 从面板传到宿主', /payload\?\.reclaim === true/.test(mainSource));
        check('main.ts 认 zip 这个 format（面板传字符串，这里收敛成三档之一）', /payload\?\.format === 'zip'/.test(mainSource));
        check('面板上有 zip 那个按钮与「顺带回收」那个勾', /exportHistorySession\(state, sessionId, 'zip'\)/.test(panel) && /dsh-history-reclaim/.test(panel));
        check(
            '面板把「超预算 ⇒ 一个都没搬」与「候选里仍被引用」都画出来（不许只画「回收了 0 个」）',
            /一个都没搬/.test(panel) && /仍被别的会话引用/.test(panel),
        );
        check('npm scripts 里有 verify:history', /verify-history\.js/.test(pkg.scripts?.['verify:history'] ?? ''));
        check('npm run verify 里有 verify-history.js（新功能进了总门禁）', /verify-history\.js/.test(pkg.scripts?.verify ?? ''));
        check('npm run verify 里有 verify-stats.js', /verify-stats\.js/.test(pkg.scripts?.verify ?? ''));
        check('npm scripts 里有 verify:stats', /verify-stats\.js/.test(pkg.scripts?.['verify:stats'] ?? ''));

        // ============================================================ 10. 真缓存只读普查
        console.log('\n[10] 真缓存只读普查（目录不存在就跳过；不写一个字节）');
        const realRoot = join(realHome, 'storages', 'session_projcache', 'sessions');
        if (!existsSync(realRoot)) {
            console.log(`  ..  ${realRoot} 不存在，跳过`);
        } else {
            const files = readdirSync(realRoot).filter((name) => name.endsWith('.json')).slice(0, 40);
            let ok = 0;
            let bad = 0;
            let windows = 0;
            let nonFinite = 0;
            for (const name of files) {
                const result = stats.normalizeUsageRecord(JSON.parse(readFileSync(join(realRoot, name), 'utf8')), { id: name });
                if (!result.ok) {
                    bad += 1;
                    continue;
                }
                ok += 1;
                if (result.usage.context.window !== null) windows += 1;
                const numbers = [];
                const walk = (value) => {
                    if (typeof value === 'number') numbers.push(value);
                    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
                };
                walk(result.usage.context);
                walk(result.usage.usage);
                walk(result.usage.session);
                if (!numbers.every((value) => Number.isFinite(value))) nonFinite += 1;
            }
            check(`真缓存里抽查 ${files.length} 份都认得出来`, ok === files.length && files.length > 0, `ok=${ok} 认不出=${bad}`);
            check('真缓存里确实有窗口上限（面板的占用率不是空谈）', windows > 0, `${windows}/${ok} 有 contextWindow`);
            check('真数据里没有把 NaN 读出来', nonFinite === 0, `${nonFinite} 份有非有限数`);
            console.log(`  ..  设计口径样本：${ok} 份记录，${windows} 份带窗口上限`);
        }

        // ============================================================ 11. 进度：已知答案
        console.log('\n[11] 进度（清单 / 目标 / 回合大纲）：已知答案 + 三种「没有」不许混');
        const cache = await stats.readSessionCache('full-session', { liveSeq: 1200 });
        check('一次读盘同时给出用量与进度', cache.ok === true && Boolean(cache.usage) && Boolean(cache.progress), cache.error ?? '');
        check('两边看到的是同一个水位（分开读会自相矛盾）', cache.usage?.seq === 900 && cache.progress !== undefined);
        const p = cache.progress;
        if (p) {
            check(
                '清单读出来了（三条，状态原样）',
                p.todos !== null && p.todos.length === 3 && p.todos[1].status === 'in_progress',
                JSON.stringify(p.todos),
            );
            check(
                '目标读出来了（**多一层 current**，这是与 wire view 的差别）',
                p.goal !== null && p.goal.objective === '把进度面板做出来' && p.goal.phase === 'active' && p.goal.roundsStarted === 3,
                JSON.stringify(p.goal),
            );
            check(
                '回合大纲读出来了（两条，含输入与回复摘要）',
                p.turns.length === 2 && p.turns[0].prompt === '把用量面板做出来' && p.turns[1].turn === 2,
                JSON.stringify(p.turns),
            );
            check('大纲的 turnsTotal 是**整个日志**的轮次数', p.turnsTotal === 2, String(p.turnsTotal));
            check('正在写的那一轮的草稿也带出来了', p.draft === '正在写第三轮的回复', p.draft);
            check('大纲里的事件 seq 原样带着（排查用）', p.turns[0].seq === 3, String(p.turns[0].seq));
            check('宿主才能填的跳转锚点这一层是 null（`entrySeq` 由 dsh-host 绑）', p.turns.every((turn) => turn.entrySeq === null));
            check('一切就绪时进度 notes 是空的', cache.progress !== undefined && stats.progressOf(JSON.parse(readFileSync(fullPath, 'utf8'))).notes.length === 0);
        }

        console.log('  -- 清单的三种「没有」不许混成一件事 --');
        const noTodos = stats.progressOf(record({ rows: { todos: { ver: 2, seq: 10, val: null } } }));
        check('`todos: null` = 这份记录里没有清单（本轮没写过）', noTodos.progress.todos === null, JSON.stringify(noTodos.progress.todos));
        const emptyTodos = stats.progressOf(record({ rows: { todos: { ver: 2, seq: 10, val: [] } } }));
        check('`todos: []` = agent **明确写了一份空表**（与 null 是两件事）', Array.isArray(emptyTodos.progress.todos) && emptyTodos.progress.todos.length === 0);
        const badTodos = stats.progressOf(
            record({ rows: { todos: { ver: 2, seq: 10, val: [{ content: 'ok', status: 'pending' }, { content: '', status: 'pending' }, { content: 'x', status: 'doing' }, 'nope'] } } }),
        );
        check(
            '认不出的条目丢掉（宁少不假：`doing` 不是合法状态）',
            badTodos.progress.todos.length === 1,
            JSON.stringify(badTodos.progress.todos),
        );
        check('丢掉条目**要说出来**（不说的话面板上就是「清单短了几条」）', badTodos.notes.some((note) => note.includes('3 条读不出来')), badTodos.notes.join(' ｜ '));

        console.log('  -- 目标：空 / 有 / 墓碑 / 失败记录 --');
        check(
            '`current: null` = 没有目标（本机绝大多数会话都是这样）',
            stats.progressOf(record({ rows: { goal: { ver: 6, seq: 10, val: { current: null, seenGoalIds: [], failure: null } } } })).progress.goal === null,
        );
        const goalBlocked = stats.progressOf(
            record({
                rows: {
                    goal: {
                        ver: 6,
                        seq: 10,
                        val: {
                            current: {
                                goal: {
                                    id: 'g',
                                    revision: 1,
                                    objective: '跑不动了',
                                    phase: 'blocked',
                                    maxGoalRounds: 5,
                                    blockedReason: { code: 'no-progress', message: '连续三轮没有进展' },
                                },
                                roundsStarted: 5,
                                updatedAt: 1_791_104_800_000,
                            },
                            seenGoalIds: ['g'],
                            failure: null,
                        },
                    },
                },
            }),
        );
        check(
            '阻塞原因取的是 `blockedReason.message`（不是那个 code）',
            goalBlocked.progress.goal?.blockedReason === '连续三轮没有进展',
            JSON.stringify(goalBlocked.progress.goal),
        );
        const goalFailed = stats.progressOf(
            record({ rows: { goal: { ver: 6, seq: 10, val: { current: null, seenGoalIds: [], failure: 'goal replay failed at session event 42: boom' } } } }),
        );
        check(
            '`failure` 是**字符串**（上游口径），原样说出来',
            goalFailed.notes.some((note) => note.includes('goal replay failed at session event 42')),
            goalFailed.notes.join(' ｜ '),
        );
        check('有失败记录**不等于**有目标', goalFailed.progress.goal === null);

        console.log('  -- 目标：事件那一路（形状与投影**不同**）--');
        const goalEvent = stats.parseGoalChange(
            { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'g2', revision: 1, objective: '事件来的目标', phase: 'active', maxGoalRounds: 3 }, roundsStarted: 0, createdAt: 1, updatedAt: 2 },
            [],
        );
        check(
            '事件载荷直接在 `goal` 上（没有 `current` 这一层）',
            goalEvent !== null && goalEvent.objective === '事件来的目标' && goalEvent.maxGoalRounds === 3,
            JSON.stringify(goalEvent),
        );
        const cleared = stats.parseGoalChange({ kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g2', revision: 2 }, clearedAt: 3 }, []);
        check('`operation: "clear"` 的墓碑 → null 是**正确结果**（不是读失败）', cleared === null);
        const clearNotes = [];
        stats.parseGoalChange({ kind: 'goal/change', version: 1, operation: 'clear', cleared: {}, clearedAt: 3 }, clearNotes);
        check('墓碑路径**不**产生「认不出来」的告警（不然每次清目标都会吓人一跳）', clearNotes.length === 0, clearNotes.join(' ｜ '));
        const weirdNotes = [];
        check('认不出的目标事件 → null + 一句告警', stats.parseGoalChange({ operation: 'resume', goal: { phase: 'active' } }, weirdNotes) === null && weirdNotes.length === 1, weirdNotes.join(' ｜ '));

        console.log('  -- 回合大纲：上限 / 缺行 / 形状 --');
        const manyTurns = [];
        for (let turn = 1; turn <= 120; turn += 1) manyTurns.push({ turn, seq: turn * 10, prompt: `第 ${turn} 轮`, response: `回复 ${turn}` });
        const capped = stats.progressOf(record({ rows: { turnOutline: { ver: 2, seq: 10, val: { turns: manyTurns, draft: '' } } } }));
        check('轮次太多时只留**最近 80 轮**', capped.progress.turns.length === 80, String(capped.progress.turns.length));
        check('留下的是**最后** 80 轮（不是前 80）', capped.progress.turns[0].turn === 41 && capped.progress.turns[79].turn === 120);
        check('截断了要说出来（`turnsTotal` 给全量 + 一句 note）', capped.progress.turnsTotal === 120 && capped.notes.some((note) => note.includes('120 轮')), capped.notes.join(' ｜ '));
        const shuffled = stats.progressOf(
            record({ rows: { turnOutline: { ver: 2, seq: 10, val: { turns: [{ turn: 3 }, { turn: 1 }, { turn: 2 }], draft: '' } } } }),
        );
        check('大纲按轮次升序排（「第 N 轮」这个标题依赖顺序）', shuffled.progress.turns.map((turn) => turn.turn).join(',') === '1,2,3');
        check('大纲缺了 `turns` 字段 → 空大纲，不是崩', stats.progressOf(record({ rows: { turnOutline: { ver: 2, seq: 10, val: { draft: 'x' } } } })).progress.turns.length === 0);
        check('**整个 turnOutline 行都没有** → 空大纲（进度里另外两块照给）', stats.progressOf(record({ rows: { turnOutline: null } })).progress.turns.length === 0);
        check(
            '大纲里认不出的条目要说出来',
            stats.progressOf(record({ rows: { turnOutline: { ver: 2, seq: 10, val: { turns: [{ turn: 1 }, { prompt: '没有轮次号' }, { turn: 'x' }], draft: '' } } } })).notes.some((note) => note.includes('2 条读不出来')),
        );
        check('`progressOf` 对不认识的形状返回 null（调用方要说出来，不许假装「没有清单」）', stats.progressOf({ record: 'nope' }) === null && stats.progressOf(null) === null);

        console.log('  -- 用量与进度分头失败，不许互相牵连 --');
        const usageOnlyPath = writeRecord(storages, 'no-progress-rows', record({ rows: { todos: null, goal: null, turnOutline: null, plan: null } }));
        const usageOnly = await stats.readSessionCache('no-progress-rows');
        check('缓存里没有进度那几行时：用量照给', usageOnly.ok === true && Boolean(usageOnly.usage), usageOnly.error ?? '');
        check(
            '并且**照给**一份空进度（不是 error —— 不然面板会以为整条会话读不了）',
            Boolean(usageOnly.progress) && usageOnly.progress.turns.length === 0 && usageOnly.progress.todos === null,
        );
        const brokenProgress = await stats.readSessionCache('broken');
        check('文件坏了：用量与进度**一起**失败（同一个原因，不编两次）', brokenProgress.ok === false && !brokenProgress.usage && !brokenProgress.progress);
        const wrapper = await stats.readSessionUsage('full-session', { liveSeq: 1200 });
        check('薄包装 readSessionUsage 仍然只给用量（60+ 条旧断言的入口不变）', wrapper.ok === true && wrapper.usage?.seq === 900 && wrapper.progress === undefined);

        // ============================================================ 11b. 上下文增长曲线
        //
        // 这一行（`contextTimeline`）的注册者是**第三方** `dsh-context`，本 profile 不挂它；
        // 缓存里的 `val` 又是**投影状态**（`requests` / `events` / `archiveFloor`），不是客户端
        // wire view（`nodes` / `current` / `archive`）—— 照 wire view 读会**一个字段都读不到**，
        // 而且是静默的（本项目记过的同类坑）。
        //
        // 所以这一节全部是**纯函数**断言（`stats.parseContextTimeline` 不读盘、不 spawn）：
        // 真缓存验「读得出来」，判据只能在合成语料上验。
        console.log('\n[11b] 上下文增长曲线（contextTimeline）：实测 vs 估算 · 压缩点 · 聚合 · 守卫');
        const constantsSource = readFileSync(join(EXT_ROOT, 'source', 'constants.ts'), 'utf8');
        const statsSource = readFileSync(join(EXT_ROOT, 'source', 'stats.ts'), 'utf8');
        const panelSource = readFileSync(join(EXT_ROOT, 'source', 'panels', 'default', 'index.ts'), 'utf8');
        const cssSource = readFileSync(join(EXT_ROOT, 'static', 'style', 'default', 'index.css'), 'utf8');
        const previewSource = readFileSync(join(EXT_ROOT, 'scripts', 'preview-panel.js'), 'utf8');
        const timelineText = require(join(EXT_ROOT, 'dist', 'constants.js'));

        /** 一条请求记录（真形状：`prompt` 是实测、`total` 是估算、`turn`/`step` 是轮次）。 */
        const req = (patch = {}) => ({
            time: 1_791_000_000_000,
            seq: 100,
            system: 1825,
            tools: 7037,
            user: 1000,
            inject: 300,
            assistant: 0,
            tool: 0,
            total: 10_000,
            turn: 1,
            step: 1,
            prompt: 13_400,
            ...patch,
        });
        /** 一条上下文事件（`compaction` / `prune` / `inject` / `model` / `mode`）。 */
        const ev = (patch = {}) => ({ seq: 200, time: 1_791_000_000_000, kind: 'compaction', tokens: 200_000, ...patch });
        /** 一整行 `contextTimeline`（形状与真缓存逐字一致）。 */
        const timelineRow = (requests, events, extra = {}) => ({
            ver: 13,
            seq: 900,
            val: {
                surface: [],
                sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
                systemTokens: 1825,
                toolsTokens: 7037,
                contextWindow: 1_000_000,
                requests,
                events,
                archived: [],
                ...extra,
            },
        });

        // ---- ① 一份正常的：优先用实测的 prompt、压缩点钉对地方、连发的 prune 合并 ----
        console.log('  -- ① 正常一份：柱高用实测 prompt · 压缩点钉在正确的柱上 · 连发的 prune 合并成一个 --');
        const normalRequests = [
            req({ seq: 100, turn: 1, step: 1, prompt: 13_400, total: 10_000 }),
            req({ seq: 200, turn: 1, step: 2, prompt: 40_200, total: 30_000 }),
            req({ seq: 300, turn: 2, step: 1, prompt: 80_400, total: 60_000 }),
            req({ seq: 400, turn: 2, step: 2, prompt: 100_500, total: 75_000 }),
        ];
        const normalEvents = [
            // 三条 prune **同一 tick 连发**（相隔 20ms）—— 必须合并成一个标记
            ev({ seq: 210, time: 1_791_000_090_000, kind: 'prune', tokens: 1000 }),
            ev({ seq: 212, time: 1_791_000_090_020, kind: 'prune', tokens: 1500 }),
            ev({ seq: 214, time: 1_791_000_090_040, kind: 'prune', tokens: 500 }),
            // 一条大 compaction，隔着 30 秒 → **不许**并进上面那一组
            ev({ seq: 310, time: 1_791_000_120_000, kind: 'compaction', tokens: 200_000, count: 42 }),
        ];
        const normal = stats.parseContextTimeline(timelineRow(normalRequests, normalEvents));
        check('认得出来，而且没有话要说（`note` 是 null）', normal.timeline !== null && normal.note === null, String(normal.note));
        const normalView = normal.timeline;
        if (normalView) {
            check('水位 / 版本从整行上取', normalView.ver === 13 && normalView.seq === 900, `${normalView.ver} / ${normalView.seq}`);
            check(
                '一次调用一根柱（没到 150 根就不聚合）',
                normalView.points.length === 4 && normalView.requests === 4 && normalView.aggregated === false,
                `${normalView.points.length} 根 / 聚合=${normalView.aggregated}`,
            );
            check(
                '柱高用**实测的 prompt**（不是估算的 total）',
                normalView.points.map((point) => point.tokens).join(',') === '13400,40200,80400,100500',
                normalView.points.map((point) => `${point.prompt}/${point.total}`).join(' '),
            );
            check('一个估算点都没有时 `estimatedCount` 是 0、每一根都不是估算', normalView.estimatedCount === 0 && normalView.points.every((point) => !point.estimated));
            check('max 是柱子里的最大值（面板归一化的分母）', normalView.max === 100_500, String(normalView.max));
            check('最新一根柱的数与实测标记都给了', normalView.lastTokens === 100_500 && normalView.lastEstimated === false);
            check('窗口上限与 archiveFloor 原样带着（没有就是 null，不补 0）', normalView.contextWindow === 1_000_000 && normalView.archiveFloor === null, JSON.stringify({ w: normalView.contextWindow, f: normalView.archiveFloor }));
            check('压缩点总数 = 合并之后的标记数（3 条 prune → 1，compaction → 1）', normalView.cutsTotal === 2, String(normalView.cutsTotal));
            check('前两根柱上没有压缩点', normalView.points[0].cuts.length === 0 && normalView.points[1].cuts.length === 0);
            /**
             * 挂载规则逐字照抄上游 wire view：`while (requests[ri].seq <= ev.seq) ri++`
             * —— 也就是「**它之后的第一条** request」。事件 seq 210/212/214 落在 200 与 300 之间，
             * 所以钉在第 3 根柱（seq 300）上；310 落在 300 与 400 之间 → 第 4 根柱（seq 400）。
             */
            check(
                '压缩点钉在「事件之后的第一条 request」上（200 与 300 之间的事件 → 第 3 根柱）',
                normalView.points[2].cuts.length === 1 && normalView.points[2].seq === 300,
                JSON.stringify(normalView.points.map((point) => point.cuts.length)),
            );
            const merged = normalView.points[2].cuts[0];
            check(
                '**连发的 3 条 prune 合并成一个标记**（净释放求和、`merged` 记条数）',
                merged.kind === 'prune' && merged.merged === 3 && merged.tokens === 3000,
                JSON.stringify(merged),
            );
            const big = normalView.points[3].cuts[0];
            check(
                '隔着 30 秒的那条 compaction 单独一个标记（不并进上面那组）',
                normalView.points[3].cuts.length === 1 && big.kind === 'compaction' && big.merged === 1 && big.count === 42,
                JSON.stringify(big),
            );
            check('柱子上记着它是第几步（回合分带要用）', normalView.points[3].turn === 2 && normalView.points[3].step === 2 && normalView.points[3].steps === 1);
        }
        check(
            '整份结果里没有一个 NaN / Infinity（同 [5] 那条口径）',
            (() => {
                const numbers = [];
                const walk = (value) => {
                    if (typeof value === 'number') numbers.push(value);
                    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
                };
                walk(normalView);
                return numbers.length > 0 && numbers.every((value) => Number.isFinite(value));
            })(),
        );

        // ---- ② 版本不认识：丢掉整行 + 如实写出「版本是几、只认几」 ----
        console.log('  -- ② ver 不认识 → 不画，且说得出「版本」 --');
        const oldVer = stats.parseContextTimeline({ ver: 12, seq: 9, val: { requests: [req()], events: [] } });
        check('`ver: 12` → `timeline === null`（丢掉整行，不按旧版本硬读）', oldVer.timeline === null, JSON.stringify(oldVer.timeline));
        check('并且说得出版本：这一行是 12、本读取器只认 13', oldVer.note.includes('版本') && oldVer.note.includes('12') && oldVer.note.includes('13'), String(oldVer.note));
        check('ver 读不出数（整个字段没了）也当不认识，且不崩', (() => {
            const result = stats.parseContextTimeline({ seq: 9, val: { requests: [req()] } });
            return result.timeline === null && typeof result.note === 'string' && result.note.includes('版本号');
        })());

        // ---- ③ ver 1 + val {} = 那个插件的降级占位（宿主低于它的基线） ----
        console.log('  -- ③ `ver: 1` + `val: {}` → 「低于基线」那句（不是「坏了」） --');
        const baseline = stats.parseContextTimeline({ ver: 1, seq: 9, val: {} });
        check('降级占位 → 不画', baseline.timeline === null);
        check('而且那句说的是「宿主低于基线」（不是「版本不认识」）', /低于/.test(baseline.note) && /基线/.test(baseline.note), String(baseline.note));
        const notBaseline = stats.parseContextTimeline({ ver: 1, seq: 9, val: { requests: [req()] } });
        check(
            '⚠ `ver: 1` 但**状态不是空的** → 走「版本不认识」那条（不能一看版本号就说是占位）',
            /版本/.test(notBaseline.note) && !/低于/.test(notBaseline.note),
            String(notBaseline.note),
        );

        // ---- ④ requests 为空 → 「还没有请求记录」（与「没有这一行」是两件事） ----
        console.log('  -- ④ `requests: []` → 「还没有请求记录」 --');
        const empty = stats.parseContextTimeline(timelineRow([], []));
        check('没有请求记录 → 不画（空坐标轴比没有更糟）', empty.timeline === null);
        check('那句里写着「还没有请求记录」', /还没有请求记录/.test(empty.note), String(empty.note));
        const absent = stats.parseContextTimeline(undefined);
        check(
            '⚠ **这一行根本不存在**（本 profile 的常态：注册者是第三方）→ 既没有曲线，也**没有 note**',
            absent.timeline === null && absent.note === null,
            String(absent.note),
        );
        check('`null` / 形状不对的整行也有话说（不静默）', stats.parseContextTimeline(null).note === null && typeof stats.parseContextTimeline('nope').note === 'string');
        const noRequestsField = stats.parseContextTimeline({ ver: 13, seq: 9, val: {} });
        check('状态里连 `requests` 都没有 → 说清是形状不认识（不是「还没有请求记录」）', /requests/.test(noRequestsField.note), String(noRequestsField.note));

        // ---- ⑤ 估算回落：没有实测 prompt 的点必须被标成估算 ----
        console.log('  -- ⑤ 估算回落（`prompt` 缺失 → 用 `total`，并且标成估算） --');
        const estimated = stats.parseContextTimeline(
            timelineRow(
                [
                    req({ seq: 100, prompt: 13_400, total: 10_000 }),
                    { seq: 200, total: 30_000, turn: 1, step: 2 },
                    { seq: 300, total: 60_000, turn: 2, step: 1 },
                    req({ seq: 400, prompt: 100_500, total: 75_000, turn: 2, step: 2 }),
                ],
                [],
            ),
        );
        check('回落的那两根被标成估算、柱高取的是 total', (() => {
            const points = estimated.timeline.points;
            return points[0].estimated === false && points[1].estimated === true && points[1].tokens === 30_000 && points[1].prompt === null && points[2].estimated === true && points[3].estimated === false;
        })(), JSON.stringify(estimated.timeline.points.map((point) => ({ t: point.tokens, e: point.estimated }))));
        check('`estimatedCount` 数得对（2 根），面板据此说「不许混进实测里」', estimated.timeline.estimatedCount === 2, String(estimated.timeline.estimatedCount));
        check(
            '实测与估算的比值确实是 1.34 那一档（面板「为什么用 prompt」那句话的依据）',
            Math.abs(13_400 / 10_000 - timelineText.CONTEXT_TIMELINE_RATIO_MEDIAN) < 0.1,
            `${(13_400 / 10_000).toFixed(2)} vs ${timelineText.CONTEXT_TIMELINE_RATIO_MEDIAN}`,
        );

        // ---- ⑥ 超过阈值按回合聚合：点数变少、**落差保留**、取的是最后一步 ----
        console.log('  -- ⑥ 超过 150 根 → 按回合聚合（点数变少，但压缩的落差必须还在） --');
        const longRequests = [];
        for (let index = 0; index < 400; index += 1) {
            const turn = Math.floor(index / 50) + 1;
            const step = (index % 50) + 1;
            // 每轮 50 步；第 5 轮起被压缩过（~265k → ~115k），所以聚合之后那个落差分毫不少
            const base = turn <= 4 ? 60_000 + (turn - 1) * 60_000 + step * 500 : 90_000 + (turn - 5) * 8_000 + step * 500;
            longRequests.push(req({ seq: (index + 1) * 100, turn, step, prompt: base, total: Math.round(base / 1.34) }));
        }
        const longRow = stats.parseContextTimeline(
            timelineRow(longRequests, [ev({ seq: 20_050, time: 1_791_000_500_000, kind: 'compaction', tokens: 150_000, count: 190 })]),
        );
        const longView = longRow.timeline;
        check('400 次调用被聚合了', longView && longView.aggregated === true && longView.requests === 400, JSON.stringify(longView && { bars: longView.points.length, agg: longView.aggregated }));
        check('按**回合**聚合（8 轮 → 8 根柱，点数明显变少）', longView.points.length === 8, String(longView.points.length));
        check('柱宽（`steps`）加起来还是 400 步（聚合没有丢步）', longView.points.reduce((sum, point) => sum + point.steps, 0) === 400, longView.points.map((point) => point.steps).join(','));
        check('取的是该回合的**最后一步**（第 4 根柱 = 第 200 次调用）', longView.points[3].seq === 20_000 && longView.points[3].tokens === 265_000, JSON.stringify({ seq: longView.points[3].seq, tokens: longView.points[3].tokens }));
        check(
            '**落差保留了**：压缩那一截在聚合之后仍然是一大截（-150k）',
            longView.points[4].tokens - longView.points[3].tokens === -150_000,
            `第 4→5 根：${longView.points[3].tokens} → ${longView.points[4].tokens}`,
        );
        check(
            '压缩点跟着聚合并到同一根柱上（不会因为聚合就丢）',
            longView.points[4].cuts.length === 1 && longView.points[4].cuts[0].count === 190,
            JSON.stringify(longView.points.map((point) => point.cuts.length)),
        );
        const just150 = stats.parseContextTimeline(timelineRow(longRequests.slice(0, 150), []));
        const just151 = stats.parseContextTimeline(timelineRow(longRequests.slice(0, 151), []));
        check(
            '阈值边界：150 根**不**聚合、151 根才聚合（`CONTEXT_TIMELINE_MAX_BARS`）',
            just150.timeline.aggregated === false && just150.timeline.points.length === 150 && just151.timeline.aggregated === true && just151.timeline.points.length < 151,
            `${just150.timeline.points.length}/${just150.timeline.aggregated} · ${just151.timeline.points.length}/${just151.timeline.aggregated}`,
        );
        check('阈值常量就是 150（面板的说明里写着这个数，两处不许漂）', timelineText.CONTEXT_TIMELINE_MAX_BARS === 150 && /CONTEXT_TIMELINE_MAX_BARS/.test(constantsSource));

        // ---- ⑦ 脏数据：不崩、不补 0、丢几条说几条 ----
        console.log('  -- ⑦ 脏数据（字符串 / NaN / 负数 / 缺 seq）不崩、不补 0 --');
        const dirtyTimeline = stats.parseContextTimeline(
            timelineRow(
                [
                    { seq: 100, prompt: '1000', total: 500, turn: 1, step: 1 }, // prompt 是字符串 → 回落 total
                    { seq: 'x', total: NaN }, // total 是 NaN → 丢掉
                    { seq: 300, total: -5 }, // 负数 → 丢掉
                    { seq: 400 }, // 两个字段都没有 → 丢掉
                    'nope',
                    null,
                    { seq: 500, prompt: 0, total: 0, turn: 2, step: 1 }, // 真值就是 0 → 留着（不补也不编）
                    { total: 700, turn: 2, step: 2 }, // 缺 seq → 留着，但 seq 是 null（钉不了压缩点）
                ],
                [
                    ev({ seq: 450, kind: 'prune', tokens: 1000 }),
                    // 这条事件的 seq 在**所有请求之后**（会话刚压缩完就结束了）→ 只能钉最后一根柱
                    ev({ seq: 9999, kind: 'compaction', tokens: 500, count: 3, time: 1_791_000_600_000 }),
                ],
            ),
        );
        const dirtyView = dirtyTimeline.timeline;
        check('脏数据不崩、整份读得出来', dirtyView !== null, String(dirtyTimeline.note));
        check('认不出的记录被丢掉并计数（8 条里丢掉 5 条：字符串 seq / NaN / 负数 / 缺字段 / 不是对象）', dirtyView.dropped === 5 && dirtyView.requests === 3, `dropped=${dirtyView.dropped} kept=${dirtyView.requests}`);
        check(
            '**没有为它们补 0**：留下的柱高就是能读出来的那几个数（500 / 0 / 700）',
            dirtyView.points.map((point) => point.tokens).join(',') === '500,0,700',
            dirtyView.points.map((point) => point.tokens).join(','),
        );
        check('字符串型 `prompt` 当缺失 → 回落 total 并标成估算', dirtyView.points[0].estimated === true && dirtyView.points[0].prompt === null);
        check('缺 `seq` 的那根 seq 是 null（不是编一个号），而且它照样画出来', dirtyView.points[2].seq === null && dirtyView.points[2].tokens === 700);
        check(
            '压缩点照常钉在「事件之后的第一条 request」上（seq 450 → 第 2 根柱）',
            dirtyView.points[1].cuts.length === 1 && dirtyView.points[1].cuts[0].kind === 'prune',
            JSON.stringify(dirtyView.points.map((point) => point.cuts.length)),
        );
        check(
            '事件的 seq 在**所有请求之后**时钉在最后一根柱上（不静默丢掉那个压缩点）',
            dirtyView.points[2].cuts.length === 1 && dirtyView.points[2].cuts[0].kind === 'compaction',
            JSON.stringify(dirtyView.points[2].cuts),
        );
        const noSeqView = stats.parseContextTimeline(
            timelineRow([{ total: 100, turn: 1, step: 1 }, { total: 200, turn: 1, step: 2 }], [ev({ seq: 450, kind: 'prune', tokens: 10 })]),
        ).timeline;
        check(
            '请求里一个 `seq` 都没有时也照样钉（钉在最后一根柱上，而不是不画）',
            noSeqView.points[1].cuts.length === 1,
            JSON.stringify(noSeqView.points.map((point) => point.cuts.length)),
        );
        check(
            '整份结果里没有一个 NaN / Infinity',
            (() => {
                const numbers = [];
                const walk = (value) => {
                    if (typeof value === 'number') numbers.push(value);
                    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
                };
                walk(dirtyView);
                return numbers.length > 0 && numbers.every((value) => Number.isFinite(value));
            })(),
        );
        const allDirty = stats.parseContextTimeline(timelineRow([{ seq: 1 }, { total: 'x' }], []));
        check(
            '`requests` 有内容但一条都读不出柱高 → 说「形状变了」（不是「还没有请求记录」）',
            allDirty.timeline === null && /形状变了/.test(allDirty.note),
            String(allDirty.note),
        );

        // ---- ⑧ `timelineNote` 不许混进 `notes`（与花费那条纪律一样） ----
        console.log('  -- ⑧ 曲线的问题归 `timelineNote`，不许混进用量的 `notes` --');
        writeRecord(storages, 'timeline-oldver', record({ rows: { contextTimeline: { ver: 12, seq: 900, val: { requests: [req()], events: [] } } } }));
        const oldVerRead = await stats.readSessionUsage('timeline-oldver');
        check('读得出来（曲线的版本不认识**不影响**用量那一半）', oldVerRead.ok === true && oldVerRead.usage.timeline === null, oldVerRead.error ?? '');
        check('原因写在 `timelineNote` 里', typeof oldVerRead.usage.timelineNote === 'string' && oldVerRead.usage.timelineNote.includes('12'), String(oldVerRead.usage.timelineNote));
        check('⚠ 用量的 `notes` 里**一个字都不加**（那是用量本身的口径问题，两回事）', oldVerRead.usage.notes.length === 0, oldVerRead.usage.notes.join(' ｜ '));
        writeRecord(storages, 'timeline-dropped', record({ rows: { contextTimeline: timelineRow([req({ seq: 100 }), { seq: 200, total: 'x' }], []) } }));
        const droppedRead = await stats.readSessionUsage('timeline-dropped');
        check('记不出的请求条数也照样读得出来（面板据此说「丢了几条」）', droppedRead.usage.timeline.dropped === 1, JSON.stringify(droppedRead.usage.timeline && droppedRead.usage.timeline.points.length));

        // ---- ⑨ 面板那几句话：已知答案（纯函数，DOM 代码测不了，文字能测） ----
        console.log('  -- ⑨ 面板上那几句话的原文（`timelineTextOf` 的已知答案表） --');
        const absentText = timelineText.timelineTextOf({ timeline: null, note: null });
        check('没有这一行时**不画图**（headline / 图例都是空）', absentText.headline === null && absentText.legend.length === 0, JSON.stringify(absentText.headline));
        check(
            '并且明说「由第三方 dsh-context 注册、本 profile 不挂它、只有 web/desktop profile 跑的会话才有」',
            absentText.notes.some((note) => note.includes('这一行由第三方 dsh-context 注册，本 profile 不挂它')) &&
                absentText.notes.some((note) => note.includes('web/desktop profile')),
            absentText.notes.join(' ｜ '),
        );
        check('顺带说清「缓存目录是共享的」（不然会被当成「这台机器没有上下文数据」）', absentText.notes.some((note) => note.includes('共享')), absentText.notes.length + ' 句');
        const skippedText = timelineText.timelineTextOf({ timeline: null, note: '这一行的版本是 12，本读取器只认 13。' });
        check('有原因时**原因排第一句**（顺序有意义：先说为什么没有，再说这一行是谁注册的）', skippedText.notes[0] === '这一行的版本是 12，本读取器只认 13。' && skippedText.notes.length === 3, JSON.stringify(skippedText.notes.map((note) => note.slice(0, 12))));
        const drawnText = timelineText.timelineTextOf({ timeline: normalView, note: null });
        check('画出来了：头部写「共 4 次模型调用 · 一次调用一根柱」', /共 4 次模型调用/.test(drawnText.headline) && /一次调用一根柱/.test(drawnText.headline), String(drawnText.headline));
        check('头部还写着最新一根是多少、占窗口多少', /最新一次 实测 100\.5k/.test(drawnText.headline) && /占窗口 1\.0M 的 10\.1%/.test(drawnText.headline), String(drawnText.headline));
        check('图例三格：实测（prompt）/ 估算（total）/ 压缩点，一个都不少', drawnText.legend.length === 3 && drawnText.legend.map((item) => item.swatch).join(',') === 'measured,estimated,cut', JSON.stringify(drawnText.legend.map((item) => item.swatch)));
        check(
            '「为什么用 prompt 而不是 total」写在说明里，并且带着 1.34 / p95 / 最大那三个数',
            drawnText.notes.some((note) => note.includes('1.34') && note.includes('1.63') && note.includes('2.69')),
            drawnText.notes[0],
        );
        const aggregatedText = timelineText.timelineTextOf({ timeline: longView, note: null });
        check(
            '聚合了就说「为什么**不许取平均**」（平均会把压缩掉的那一截抹平）',
            aggregatedText.notes.some((note) => note.includes('按回合聚合') && note.includes('平均')),
            aggregatedText.notes.join(' ｜ '),
        );
        check('聚合时头部也写着「按回合聚合成 8 根柱」', /按回合聚合成 8 根柱/.test(aggregatedText.headline), String(aggregatedText.headline));
        const floorText = timelineText.timelineTextOf({
            timeline: { ...normalView, archiveFloor: 473_046 },
            note: null,
        });
        check(
            '`archiveFloor` 存在时那句话必须出现（小于它的删除记录已被缓存裁掉）',
            floorText.notes.some((note) => note.includes('archiveFloor') && note.includes('473046') && note.includes('裁掉')),
            floorText.notes.join(' ｜ '),
        );
        const noWindowText = timelineText.timelineTextOf({ timeline: { ...normalView, contextWindow: null }, note: null });
        check(
            '没有 `contextWindow` → 明说「不画占用率百分比」（分母不知道就不补）',
            noWindowText.notes.some((note) => note.includes('没有窗口上限') && note.includes('不画占用率百分比')),
            noWindowText.notes.join(' ｜ '),
        );
        check('有窗口上限时说得清「分母是这一行给的，不是面板编的」', drawnText.notes.some((note) => note.includes('不是面板编的')), drawnText.notes.join(' ｜ '));
        const estimatedText = timelineText.timelineTextOf({ timeline: estimated.timeline, note: null });
        check('有估算柱时明说「不许混进实测里」', estimatedText.notes.some((note) => note.includes('2 根柱没有实测') && note.includes('不许混进实测里')), estimatedText.notes.join(' ｜ '));
        const dirtyText = timelineText.timelineTextOf({ timeline: dirtyView, note: null });
        check('丢过记录就说丢了几条（并且说清没有补 0）', dirtyText.notes.some((note) => note.includes('5 条请求记录认不出来') && note.includes('没有为它们补一个 0')), dirtyText.notes.join(' ｜ '));
        const noCutsText = timelineText.timelineTextOf({ timeline: { ...normalView, cutsTotal: 0 }, note: null });
        check('一次压缩都没有时说「一次都没发生过」（曲线一路涨是实情）', noCutsText.notes.some((note) => note.includes('一次压缩 / 裁剪都没发生过')), noCutsText.notes.join(' ｜ '));
        const allSentences = [absentText, skippedText, drawnText, aggregatedText, floorText, noWindowText, estimatedText, dirtyText, noCutsText]
            .flatMap((text) => [...(text.headline === null ? [] : [text.headline]), ...text.legend.map((item) => item.label), ...text.notes]);
        check(
            '⚠ 这些话里**一个 `**` 都不许有**（面板是 textContent，星号会原样画出来 —— 这个坑踩过三次）',
            allSentences.every((text) => !text.includes('**')),
            allSentences.find((text) => text.includes('**')) ?? '',
        );
        check('每句话都不是空的（空字符串会被当成「这里没有说明」）', allSentences.every((text) => text.trim().length > 0), `${allSentences.length} 句`);
        check('那三句「为什么不画」的生成器与预览器用的是**同一份**（preview 从 dist 里 require，不手写）', /contextTimelineVersionNote/.test(previewSource) && /contextTimelineEmptyNote/.test(previewSource));

        // ---- ⑩ 接线锚点：少一环就是一块空白，而且不报错 ----
        console.log('  -- ⑩ 接线锚点（读取器 → constants → 面板 → CSS → 预览） --');
        check('`SessionUsage` 带 `timeline` 字段（照抄 cost 那一对的摆法）', /^\s+timeline: ContextTimelineView \| null;/m.test(constantsSource));
        check('`SessionUsage` 带 `timelineNote` 字段', /^\s+timelineNote: string \| null;/m.test(constantsSource));
        check('视图类型在 `constants.ts` 里（面板与主进程共用一份）', /export interface ContextTimelineView/.test(constantsSource) && /export interface TimelinePointView/.test(constantsSource));
        check('解析只在 `stats.ts` 一处（宿主不自己读缓存字段）', /export function parseContextTimeline/.test(statsSource));
        check('`normalizeUsageRecord` 把结果贴到用量上（没有第二次读盘）', /timeline: timelineParse\.timeline/.test(statsSource) && /timelineNote: timelineParse\.note/.test(statsSource));
        check('文件头那几条口径里写着「第三方注册 / 本 profile 不挂」', /注册者是第三方/.test(statsSource) && /本 profile 不挂它/.test(statsSource));
        check('文件头写着「实测 vs 估算」与那道 1.34 倍', /1\.34/.test(statsSource) && /只画 `total`/.test(statsSource));
        check('面板画这一块（`usageBlock` 里挂 `timelineLines(usage)`）', /timelineLines\(usage\)/.test(panelSource) && /'上下文增长'/.test(panelSource));
        check('柱宽固定 + 横向滚动（挤柱子的画法会把落差抹平）', /TIMELINE_SLOT_PX/.test(panelSource) && /overflow-x: auto/.test(cssSource));
        check('压缩点画竖线 + ✂', /dsh-timeline-cut-mark/.test(panelSource) && /dsh-timeline-cut\b/.test(cssSource));
        check('回合分带 / 标签在（`dsh-timeline-band`）', /'dsh-timeline-band'/.test(panelSource) && /\.dsh-timeline-band\b/.test(cssSource));
        check(
            '面板用到的 13 个类名在 CSS 里都有定义（写错不报错，只是没样式）',
            ['dsh-timeline-head', 'dsh-timeline-scroll', 'dsh-timeline-bands', 'dsh-timeline-band', 'dsh-timeline-band-label', 'dsh-timeline-plot', 'dsh-timeline-slot', 'dsh-timeline-bar', 'dsh-timeline-cut', 'dsh-timeline-cut-mark', 'dsh-timeline-legend', 'dsh-timeline-legend-item', 'dsh-timeline-swatch'].every(
                (name) => new RegExp(`\\.${name}[\\s,:{[]`).test(cssSource),
            ),
        );
        check('面板只用 `createElement`（不碰 innerHTML）', !/innerHTML/.test(panelSource));
        check('预览器认得 `?timeline=` 那四个状态', /'timeline'/.test(previewSource) && /timelineOldverNote/.test(previewSource) && /timelineEmptyNote/.test(previewSource));
        check('README 里有这一节（`## 上下文增长曲线`）', /^## 上下文增长曲线/m.test(readFileSync(join(EXT_ROOT, 'README.md'), 'utf8')));

        // ============================================================ 12. 真缓存只读普查（进度）
        console.log('\n[12] 真缓存只读普查：进度那三行到底有多少内容（不写一个字节）');
        if (!existsSync(realRoot)) {
            console.log(`  ..  ${realRoot} 不存在，跳过`);
        } else {
            const all = readdirSync(realRoot).filter((name) => name.endsWith('.json'));
            let parsed = 0;
            let withTodos = 0;
            let todoItems = 0;
            let withGoal = 0;
            let withOutline = 0;
            let outlineTurns = 0;
            let planActive = 0;
            let violations = [];
            const statuses = new Set();
            // 上下文增长曲线（同一趟扫描顺手统计，见下面那段注释）
            let withTimelineRow = 0;
            let drawnTimeline = 0;
            let aggregatedTimeline = 0;
            let timelinePoints = 0;
            let timelineCuts = 0;
            const timelineVers = new Map();
            for (const name of all) {
                let document;
                try {
                    document = JSON.parse(readFileSync(join(realRoot, name), 'utf8'));
                } catch {
                    continue;
                }
                const result = stats.progressOf(document);
                if (!result) {
                    violations.push(`${name}: progressOf 认不出`);
                    continue;
                }
                parsed += 1;
                if (result.progress.todos !== null) {
                    withTodos += 1;
                    if (result.progress.todos.length > 0) todoItems += result.progress.todos.length;
                    for (const todo of result.progress.todos) statuses.add(todo.status);
                }
                if (result.progress.goal !== null) withGoal += 1;
                if (result.progress.turns.length > 0) {
                    withOutline += 1;
                    outlineTurns += result.progress.turns.length;
                }
                // 不变量：轮次必须严格升序、必须是正数（面板的「第 N 轮」直接印这个数）
                for (let index = 0; index < result.progress.turns.length; index += 1) {
                    const turn = result.progress.turns[index];
                    if (!Number.isInteger(turn.turn) || turn.turn < 1) violations.push(`${name}: 轮次不是正整数 ${turn.turn}`);
                    if (index > 0 && turn.turn <= result.progress.turns[index - 1].turn) violations.push(`${name}: 轮次没有严格升序`);
                }
                const rows = document.record?.rows ?? {};
                if (rows.plan?.val?.active === true) planActive += 1;
                /**
                 * 顺带把**上下文增长曲线**那一行也普查一遍（同一趟只读扫，不多读一个字节）：
                 * 它由第三方 `dsh-context` 注册，所以「有多少份缓存带这一行、`ver` 是什么」
                 * 是「本 profile 不挂它」那句面板话术的**唯一事实依据**（别的 profile 跑的
                 * 会话也落在这个共享目录里）。
                 */
                if (rows.contextTimeline !== undefined) {
                    withTimelineRow += 1;
                    const ver = rows.contextTimeline?.ver;
                    timelineVers.set(ver, (timelineVers.get(ver) ?? 0) + 1);
                    const timelineResult = stats.parseContextTimeline(rows.contextTimeline);
                    if (timelineResult.timeline) {
                        drawnTimeline += 1;
                        if (timelineResult.timeline.aggregated) aggregatedTimeline += 1;
                        timelineCuts += timelineResult.timeline.cutsTotal;
                        timelinePoints += timelineResult.timeline.points.length;
                    } else if (timelineResult.note === null) {
                        // 这一行在，却既画不出曲线、也没有一句解释 —— 那正是「静默空白」那种坏法
                        violations.push(`${name}: contextTimeline 既没有曲线也没有说明`);
                    }
                }
            }
            check(`真缓存的 ${all.length} 份记录，进度都读得出来（一份都没认不出）`, violations.length === 0 && parsed === all.length, violations.slice(0, 3).join(' ｜ '));
            check(
                '清单状态只出现了白名单里的三种',
                [...statuses].every((status) => ['pending', 'in_progress', 'completed'].includes(status)),
                [...statuses].join(','),
            );
            console.log(
                `  ..  有清单的 ${withTodos}/${parsed} 份（共 ${todoItems} 条）· 有目标的 ${withGoal} 份 · ` +
                    `有回合大纲的 ${withOutline} 份（共 ${outlineTurns} 轮）`,
            );
            console.log(
                `  ..  上下文增长曲线：${withTimelineRow}/${all.length} 份缓存带这一行（ver 分布 ${[...timelineVers].map(([ver, count]) => `${ver}×${count}`).join(', ') || '（无）'}）· ` +
                    `其中 ${drawnTimeline} 份画得出来（${aggregatedTimeline} 份按回合聚合）· 共 ${timelinePoints} 根柱 / ${timelineCuts} 个压缩点`,
            );
            check(
                '这一行的 `ver` 分布里只有本读取器认的那个（多一个版本号就说明上游升级了 stateVersion —— 面板会说「不认识」）',
                [...timelineVers.keys()].every((ver) => ver === 13),
                [...timelineVers].map(([ver, count]) => `${ver}×${count}`).join(', ') || '（这台机器还没有这一行）',
            );
            check(
                '带这一行的缓存里，读得出曲线的比例与上面那条 `..` 一致（读不出的一定有话要说）',
                drawnTimeline <= withTimelineRow,
                `${drawnTimeline}/${withTimelineRow}`,
            );
            check(
                '本机 490 份里 `plan.active` **一次都没 true** —— 这就是没有「计划面板」的判据（有数据了再来加）',
                planActive === 0,
                `${planActive} 份 active`,
            );
            check('清单那一行确实在真的有内容的记录里出现过（不是空谈）', withTodos > 0, `${withTodos} 份有清单`);
            check('回合大纲出现得很普遍（面板上大部分会话都有目录）', withOutline > parsed / 2, `${withOutline}/${parsed}`);
        }

        // ============================================================ 12b. 真账本只读普查（花费）
        console.log('\n[12b] 真账本只读普查：cost-meter 到底记了多少（不写一个字节）');
        const realLedger = join(realHome, 'storages', 'cost-meter', 'ledger.json');
        if (!existsSync(realLedger)) {
            console.log(`  ..  ${realLedger} 不存在，跳过（那个插件还没在这台机器上跑过）`);
        } else {
            const ledgerRaw = JSON.parse(readFileSync(realLedger, 'utf8'));
            const display = stats.costDisplayOf(ledgerRaw);
            const dayKeys = Object.keys(ledgerRaw.days ?? {});
            let sessionRecords = 0;
            let total = 0;
            const bad = [];
            for (const [key, day] of Object.entries(ledgerRaw.days ?? {})) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) bad.push(`日期键 ${key} 不是 YYYY-MM-DD`);
                for (const entry of Array.isArray(day.sessions) ? day.sessions : []) {
                    if (typeof entry.id !== 'string' || !Number.isFinite(entry.cost)) {
                        bad.push(`${key} 里有一条会话记录缺 id/cost`);
                        continue;
                    }
                    sessionRecords += 1;
                    total += entry.cost;
                }
            }
            check('真账本的显示设置读得出来（币种/符号/小数位/汇率）', display !== null, JSON.stringify(display));
            check('真账本里每一条会话记录都能用（id 是字符串、cost 是有限数）', bad.length === 0, bad.slice(0, 3).join(' ｜ '));
            console.log(
                `  ..  ${dayKeys.length} 天 · ${sessionRecords} 条会话记录 · 累计 $${total.toFixed(2)}（美元账本口径）· ` +
                    `显示 ${display ? `${display.symbol}（汇率 ${display.exchangeRate}，${display.decimals} 位）` : '不认识'}`,
            );

            /**
             * **两个来源交叉**：真缓存（检查点）与真账本（账单）都有金额的会话里，有多少条会触发
             * 面板上那句「两处金额对不上」—— 那句话不是装饰，所以要知道它有多常见。
             */
            let both = 0;
            let mismatch = 0;
            for (const name of existsSync(realRoot) ? readdirSync(realRoot).filter((n) => n.endsWith('.json')) : []) {
                const id = name.replace(/\.json$/, '');
                const factsOfLedger = stats.costFactsOf(ledgerRaw, id, Date.now());
                if (!factsOfLedger || factsOfLedger.sessionUsd === null) continue;
                let document;
                try {
                    document = JSON.parse(readFileSync(join(realRoot, name), 'utf8'));
                } catch {
                    continue;
                }
                const cached = document?.record?.rows?.costUsage?.val?.totals?.cost;
                if (typeof cached !== 'number') continue;
                both += 1;
                if (Math.abs(cached - factsOfLedger.sessionUsd) > Math.max(0.0001, Math.abs(factsOfLedger.sessionUsd) * 0.01)) mismatch += 1;
            }
            console.log(`  ..  两边都有金额的 ${both} 条会话，其中 ${mismatch} 条超出容差（面板会为它们多说一句）`);
        }

        console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);    } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
        if (!process.argv.includes('--keep')) rmSync(tmpRoot, { recursive: true, force: true });
        else console.log(`\n合成语料保留在：${tmpRoot}`);
    }
}

main().catch((error) => {
    console.error(`verify-stats 崩了：${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
});
