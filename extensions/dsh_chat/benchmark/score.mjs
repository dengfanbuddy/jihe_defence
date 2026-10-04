/**
 * BENCH scorer —— **过程指标**（从 DSH 会话日志里算，不看 AI 的自述）。
 *
 * ## 它凭什么能测「过程」
 *
 * 会话日志是 zstd 分帧的 JSONL，里面**每一条工具调用都在**。所以「这次做得好不好」
 * 可以完全脱离 AI 的总结来评：步数、工具分布、`pwsh` 到底打在哪儿、有没有动全局视图状态、
 * 有没有先找 recipe、报错后有没有反复重试、连续多少步没对用户说一个字……
 * 这些正是历史上把「一个登录预制件」拖成 79 步的东西。
 *
 * ## 怎么认领会话
 *
 * 用例的 prompt 以 `[BENCH:<id>]` 开头 —— 这里按标记在最近的日志里找那条会话，
 * 不用手工填 session id。找不到就明说找不到（而不是随便挑一条）。
 *
 * ## 用法
 *
 * ```sh
 * node benchmark/score.mjs                    # 最近 6 条会话，跑全部用例
 * node benchmark/score.mjs --case ui-basic
 * node benchmark/score.mjs --session 37423001-5d1d-452d-9065-62bd4a51e05e --case combo-login
 * node benchmark/score.mjs --recent 12        # 多翻几条历史
 * node benchmark/score.mjs --json
 * ```
 *
 * @module dsh_chat/benchmark/score
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync, constants } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
const PROJECT = resolve(suite.project ?? join(HERE, '..', '..', '..'));

/**
 * DSH 的工程键：`D:\Project\cocos\jihe_defence` → `--D-Project-cocos-jihe_defence--`。
 *
 * 为什么要有这个兜底：`cases.json` 原来把 `projectKey` **写死成作者本机的工程** ——
 * 那份文件一旦跟着插件发出去，别人跑基准就永远在找一个不存在的目录。
 * 现在缺省按当前工作目录推导；`cases.json` 里显式给了才用显式的。
 */
function projectKeyOf(dir) {
    return `--${resolve(dir).replace(/[:\\/]+/g, '-')}--`;
}

/** 基准所属工程的键（`cases.json` 可覆盖；缺省 = 当前工作目录）。 */
const PROJECT_KEY = (suite.projectKey ?? '').trim() || projectKeyOf(process.cwd());

/* ------------------------------------------------------------------ *
 * 会话日志解码（照抄 DSH 的帧扫描口径：zstdDecompressSync 只吃单帧）
 * ------------------------------------------------------------------ */

const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4) return { frames, tornStart: start };
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`第 ${offset} 字节不是 zstd 帧头`);
        offset += 4;
        if (offset === buffer.length) return { frames, tornStart: start };
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3) return { frames, tornStart: start };
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
            offset += payloadBytes;
            if (lastBlock) break;
        }
        if (checksum) {
            if (buffer.length - offset < 4) return { frames, tornStart: start };
            offset += 4;
        }
        frames.push({ start, end: offset });
        if (frames.length >= maxFrames) return { frames };
    }
    return { frames };
}

function decodeLog(buffer) {
    const { frames, tornStart } = scanZstdFrames(buffer);
    const parts = [];
    for (const frame of frames) {
        try {
            parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
        } catch {
            /* 单帧坏了不放弃整份日志 */
        }
    }
    if (tornStart !== undefined && buffer.length - tornStart > 8) {
        try {
            parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }));
        } catch {
            /* 半个帧忽略 */
        }
    }
    return Buffer.concat(parts).toString('utf8');
}

function sessionsRoot() {
    const home = process.env.DSH_HOME?.trim();
    return join(home && home !== '' ? home : join(homedir(), '.dsh'), 'sessions');
}

/** 列出本工程最近的会话（按日志 mtime 倒序）。 */
function recentSessions(limit) {
    const dir = join(sessionsRoot(), PROJECT_KEY);
    if (!existsSync(dir)) return [];
    const rows = [];
    for (const name of readdirSync(dir)) {
        const sessionDir = join(dir, name);
        try {
            if (!statSync(sessionDir).isDirectory()) continue;
        } catch {
            continue;
        }
        let log = null;
        let mtime = 0;
        for (const file of readdirSync(sessionDir)) {
            if (!/^session(\.[^.]+)?\.jsonl(\.zstd)?$/.test(file)) continue;
            const full = join(sessionDir, file);
            const stat = statSync(full);
            if (stat.mtimeMs > mtime) {
                mtime = stat.mtimeMs;
                log = full;
            }
        }
        if (log) rows.push({ id: name, log, mtime });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, limit);
}

function loadEvents(logPath) {
    const buffer = readFileSync(logPath);
    const text = logPath.endsWith('.zstd') ? decodeLog(buffer) : buffer.toString('utf8');
    return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 过程指标
 * ------------------------------------------------------------------ */

const argsOf = (call) => call.data?.input ?? call.data?.arguments ?? call.data?.args ?? {};
const argsText = (call) => {
    const value = argsOf(call);
    return typeof value === 'string' ? value : JSON.stringify(value);
};

/** 从事件流里抽出一份「过程画像」。 */
function profileSession(events) {
    const times = events.map((e) => e.time).filter((t) => typeof t === 'number');
    const calls = events.filter((e) => e.type === 'tool/call');
    const steps = events.filter((e) => e.type === 'step/start');

    const distribution = {};
    const signatures = new Map();
    const editorInstallHits = [];
    const allArgs = [];

    for (const call of calls) {
        const name = call.data?.name ?? '?';
        const text = argsText(call);
        distribution[name] = (distribution[name] ?? 0) + 1;
        allArgs.push(text);
        const key = `${name}::${text}`;
        signatures.set(key, (signatures.get(key) ?? 0) + 1);
        // pwsh 打向编辑器安装目录 = 历史头号浪费（实测 25/25 次都打在那里）
        // ⚠ 工具入参在日志里是 JSON 字符串，Windows 路径的反斜杠被转义成 `\\` —— 判定前先归一化，
        //   否则这条纪律项会永远显示 0（第一次跑就踩了）。
        if (name === 'pwsh' && /ProgramData[\\/]+cocos|[Cc]ocos[\\/]+editors/i.test(text.replace(/\\\\/g, '\\'))) {
            editorInstallHits.push(text.slice(0, 120));
        }
    }

    // 每个 step 是否对用户说了话（assistant 文本块）
    const textByStep = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message') continue;
        const content = event.data?.content ?? event.data?.message?.content;
        if (!Array.isArray(content)) continue;
        const hasText = content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
        if (!hasText) continue;
        const step = event.data?.step ?? null;
        if (step !== null) textByStep.set(step, (textByStep.get(step) ?? 0) + 1);
    }
    const stepNumbers = steps.map((s) => s.data?.step ?? 0).sort((a, b) => a - b);
    let silentRun = 0;
    let maxSilentRun = 0;
    for (const step of stepNumbers) {
        if (textByStep.has(step)) silentRun = 0;
        else {
            silentRun += 1;
            maxSilentRun = Math.max(maxSilentRun, silentRun);
        }
    }
    /**
     * ⚠ 兜底：`assistant/message` 不一定带 `step` 字段（不同 DSH 版本/事件形状）。
     * 带不上时上面的循环会把每一步都算成「静默」，这不是事实。退化成「步数 − 说过话的消息数」这个下界。
     */
    const textMessages = [...textByStep.values()].reduce((a, b) => a + b, 0);
    const silentFromSteps = maxSilentRun;
    if (textByStep.size === 0 && textMessages === 0) {
        const textEventCount = events.filter((e) => {
            if (e.type !== 'assistant/message') return false;
            const content = e.data?.content ?? e.data?.message?.content;
            return Array.isArray(content) && content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
        }).length;
        maxSilentRun = Math.max(0, steps.length - textEventCount);
        textByStep.set(-1, textEventCount);
    }

    const repeats = [...signatures.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    const joined = allArgs.join('\n');

    return {
        minutes: times.length ? (Math.max(...times) - Math.min(...times)) / 60000 : 0,
        steps: steps.length,
        calls: calls.length,
        distribution,
        editorInstallHits,
        repeats,
        maxRepeat: repeats.length ? repeats[0][1] : 1,
        silentSteps: maxSilentRun,
        userTexts: textByStep.size,
        joined,
        events,
    };
}

/** 过程断言：把 `log-*` 的 check 逐条判掉。 */
function runLogChecks(testCase, profile) {
    const out = [];
    const push = (label, ok, detail, level = 'fail') => out.push({ label, ok, detail, level });

    for (const tool of testCase.forbid ?? []) {
        const n = profile.distribution[tool] ?? 0;
        push(`禁用工具 ${tool}（出现 ${n} 次）`, n === 0, n === 0 ? '未出现' : `出现了 ${n} 次`);
    }
    for (const tool of testCase.requireTools ?? []) {
        const n = profile.distribution[tool] ?? 0;
        push(`必须用工具 ${tool}（出现 ${n} 次）`, n > 0, n > 0 ? '用过' : '一次都没用');
    }

    for (const check of testCase.checks ?? []) {
        if (!check.kind.startsWith('log-')) continue;
        if (check.kind === 'log-require-tool') {
            const n = profile.distribution[check.tool] ?? 0;
            push(`过程：必须调用 ${check.tool}`, n > 0, n > 0 ? `调用 ${n} 次` : '一次都没调用');
        } else if (check.kind === 'log-forbid-tool') {
            const n = profile.distribution[check.tool] ?? 0;
            push(`过程：禁止调用 ${check.tool} —— ${check.reason ?? ''}`, n === 0, n === 0 ? '未出现' : `出现了 ${n} 次`);
        } else if (check.kind === 'log-require-substring') {
            const hit = profile.joined.includes(check.text);
            push(`过程：必须出现 "${check.text}"`, hit, hit ? '命中' : '未命中');
        } else if (check.kind === 'log-forbid-substring') {
            const hit = profile.joined.includes(check.text);
            push(`过程：禁止出现 "${check.text}" —— ${check.reason ?? ''}`, !hit, hit ? '出现了（越界）' : '未出现');
        } else if (check.kind === 'log-forbid-node-name-prefix') {
            // 只在 args 里找「像节点名」的 __Xxx 字面量；**是建过探针的信号，不等于没清干净**
            const found = [...profile.joined.matchAll(/['"]__[A-Za-z0-9_]+['"]/g)].map((m) => m[0].replace(/['"]/g, ''));
            const unique = [...new Set(found)];
            push(
                `过程：探针节点前缀 ${check.prefix}（建过 ${unique.length} 个）`,
                unique.length === 0,
                unique.length === 0 ? '没建过探针节点' : `${unique.slice(0, 6).join(', ')} —— 是否清干净由编辑器探针判定（此项为提示级）`,
                'warn',
            );
        } else if (check.kind === 'log-forbid-retry-burst') {
            const n = profile.distribution[check.tool] ?? 0;
            push(`过程：${check.tool} 调用次数 ≤ ${check.max} —— ${check.reason ?? ''}`, n <= check.max, `实际 ${n} 次`);
        } else if (check.kind === 'log-max-consecutive-silent-steps') {
            push(
                `过程：最长连续静默步数 ≤ ${check.max} —— ${check.reason ?? ''}`,
                profile.silentSteps <= check.max,
                `实际 ${profile.silentSteps} 步（全程只有 ${profile.userTexts} 步对用户说了话）`,
            );
        } else if (check.kind === 'log-max-tool-repeats') {
            push(`过程：同参数重复调用 ≤ ${check.max}`, profile.maxRepeat <= check.max + 1, `最多重复 ${profile.maxRepeat} 次`);
        }
    }
    return out;
}

/** 效率：与预算比对。 */
function scoreEfficiency(testCase, profile) {
    const budget = testCase.budget ?? {};
    const rows = [];
    const axis = (label, actual, limit, unit) => {
        if (typeof limit !== 'number' || limit <= 0) return 1;
        const ratio = actual / limit;
        const score = ratio <= 1 ? 1 : Math.max(0, 1 - (ratio - 1));
        rows.push({ label, actual, limit, unit, ratio, score });
        return score;
    };
    const parts = [
        axis('步数', profile.steps, budget.steps, '步'),
        axis('工具调用', profile.calls, budget.toolCalls, '次'),
        axis('时长', Number(profile.minutes.toFixed(1)), budget.minutes, 'min'),
    ];
    const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1;
    return { rows, score };
}

/** 纪律：越界项。 */
function scoreDiscipline(profile) {
    const items = [];
    items.push({ label: 'pwsh 打编辑器安装目录', count: profile.editorInstallHits.length, limit: 0 });
    items.push({ label: '动全局视图状态', count: /setDesignResolutionSize/.test(profile.joined) ? 1 : 0, limit: 0 });
    items.push({ label: '往真实场景写（Main/Loading/Game_Stage）', count: /Main\.scene|Loading\.scene|Game_Stage\.scene/.test(profile.joined) ? 1 : 0, limit: 0 });
    const bad = items.filter((i) => i.count > i.limit);
    const score = Math.max(0, 1 - bad.length / items.length);
    return { items, score };
}

/** 复用：知识库闭环。 */
function scoreReuse(profile, testCase) {
    const found = profile.joined.includes('findRecipes');
    const saved = profile.joined.includes('saveRecipe');
    const ran = profile.joined.includes('runRecipe') || profile.joined.includes('readRecipe');
    const recipeFile = readdirSyncSafe(join(PROJECT, '.dsh-mcp', 'recipes')).filter((f) => f.endsWith('.js')).length;
    const score = (found ? 0.4 : 0) + (saved ? 0.4 : 0) + (ran ? 0.2 : 0);
    return { found, saved, ran, recipeFile, score };
}

function readdirSyncSafe(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** 诚实性：AI 写的 result.json vs 磁盘现实（虚报检测）。 */
function scoreHonesty(profile, testCase) {
    const manifestPath = join(PROJECT, 'assets', 'bench', testCase.id, 'result.json');
    if (!existsSync(manifestPath)) {
        return { present: false, claims: 0, missing: 0, score: 0.5, note: '没写 result.json（无法做虚报检测，也不满足用例约定）' };
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        return { present: true, claims: 0, missing: 0, score: 0, note: `result.json 不是合法 JSON：${error.message}` };
    }
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    const missing = artifacts.filter((rel) => !existsSync(join(PROJECT, String(rel))));
    const unfinished = Array.isArray(manifest.unfinished) ? manifest.unfinished : [];
    // 声称的产物必须真的存在；如实写 unfinished 反而是加分项（04:23 那次做对了）
    const score = missing.length > 0 ? 0 : unfinished.length > 0 ? 1 : 1;
    return {
        present: true,
        claims: artifacts.length,
        missing: missing.length,
        missingList: missing.map(String),
        unfinished: unfinished.length,
        score,
        note: missing.length ? `虚报：声称 ${artifacts.length} 个产物，其中 ${missing.length} 个不存在` : `声称产物 ${artifacts.length} 个全部存在；未完成项 ${unfinished.length} 条`,
    };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function parseArgv(argv) {
    const out = { case: null, session: null, recent: 6, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--case') out.case = argv[++i] ?? null;
        else if (argv[i] === '--session') out.session = argv[++i] ?? null;
        else if (argv[i] === '--recent') out.recent = Number(argv[++i] ?? 6) || 6;
        else if (argv[i] === '--json') out.json = true;
    }
    return out;
}

const cli = parseArgv(process.argv.slice(2));
const selected = cli.case ? suite.cases.filter((c) => c.id === cli.case) : suite.cases;
if (selected.length === 0) {
    console.error(`找不到用例 "${cli.case}"；可用：${suite.cases.map((c) => c.id).join(', ')}`);
    process.exit(2);
}

/** 认领会话：优先 `--session`，否则在最近 N 条里按 `[BENCH:id]` 标记找。 */
const cache = new Map();
function eventsFor(session) {
    if (!cache.has(session.log)) cache.set(session.log, loadEvents(session.log));
    return cache.get(session.log);
}

const candidates = cli.session
    ? recentSessions(200).filter((s) => s.id === cli.session || s.log.includes(cli.session))
    : recentSessions(cli.recent);

if (candidates.length === 0) {
    console.error(`在 ${join(sessionsRoot(), PROJECT_KEY)} 下没找到会话日志`);
    process.exit(1);
}

const report = { generatedAt: new Date().toISOString(), cases: [], unmatched: [] };

for (const testCase of selected) {
    const marker = `[BENCH:${testCase.id}]`;
    /**
     * 认领规则：`--session` 是**显式指名**（用于给历史会话补基线，历史日志里当然没有 BENCH 标记），
     * 否则才按提示词里的 `[BENCH:id]` 标记在最近若干条日志里找。
     */
    let claimed = cli.session ? candidates[0] : null;
    if (!claimed) {
        for (const session of candidates) {
            let events;
            try {
                events = eventsFor(session);
            } catch {
                continue;
            }
            if (JSON.stringify(events).includes(marker)) {
                claimed = session;
                break;
            }
        }
    }
    if (!claimed) {
        report.unmatched.push({ id: testCase.id, marker });
        continue;
    }

    const profile = profileSession(eventsFor(claimed));
    const logChecks = runLogChecks(testCase, profile);
    const efficiency = scoreEfficiency(testCase, profile);
    const discipline = scoreDiscipline(profile);
    const reuse = scoreReuse(profile, testCase);
    const honesty = scoreHonesty(profile, testCase);

    const observability = {
        score: profile.silentSteps <= 6 ? 1 : profile.silentSteps <= 15 ? 0.5 : 0,
        silentSteps: profile.silentSteps,
        userTexts: profile.userTexts,
    };

    const processScore =
        efficiency.score * 30 + discipline.score * 30 + reuse.score * 15 + honesty.score * 15 + observability.score * 10;

    report.cases.push({
        id: testCase.id,
        title: testCase.title,
        session: claimed.id,
        budget: testCase.budget ?? null,
        metrics: {
            steps: profile.steps,
            calls: profile.calls,
            minutes: Number(profile.minutes.toFixed(1)),
            distribution: profile.distribution,
            editorInstallHits: profile.editorInstallHits.length,
            silentSteps: profile.silentSteps,
            userTexts: profile.userTexts,
            maxRepeat: profile.maxRepeat,
        },
        efficiency: efficiency.rows,
        discipline: discipline.items,
        logChecks,
        reuse,
        honesty,
        observability,
        processScore: Math.round(processScore),
    });
}

if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log('# BENCH scorer —— 过程指标（判据来自会话日志，不看 AI 自述）\n');
    for (const entry of report.cases) {
        const b = entry.budget ?? {};
        console.log(`## [${entry.id}] ${entry.title}`);
        console.log(`   会话 ${entry.session}`);
        console.log(
            `   实测 ${entry.metrics.steps} 步 / ${entry.metrics.calls} 调用 / ${entry.metrics.minutes} min` +
                (b.steps ? `   预算 ${b.steps} 步 / ${b.toolCalls} 调用 / ${b.minutes} min` : ''),
        );
        console.log(`   工具：${Object.entries(entry.metrics.distribution).sort((a, x) => x[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`);
        for (const row of entry.efficiency) {
            console.log(`   ${row.ratio <= 1 ? '✅' : '❌'} 效率 ${row.label} ${row.actual}${row.unit} / 预算 ${row.limit}（${row.ratio.toFixed(2)}×）`);
        }
        for (const item of entry.discipline) {
            console.log(`   ${item.count <= item.limit ? '✅' : '❌'} 纪律 ${item.label}：${item.count}（上限 ${item.limit}）`);
        }
        for (const check of entry.logChecks) {
            const icon = check.ok ? '✅' : check.level === 'warn' ? '⚠️' : '❌';
            console.log(`   ${icon} ${check.label} —— ${check.detail}`);
        }
        console.log(`   ${entry.reuse.found ? '✅' : '❌'} 复用：findRecipes ${entry.reuse.found ? '有' : '无'} / readRun ${entry.reuse.ran ? '有' : '无'} / saveRecipe ${entry.reuse.saved ? '有' : '无'}（.dsh-mcp/recipes 现有 ${entry.reuse.recipeFile} 条）`);
        console.log(`   ${entry.honesty.missing > 0 ? '❌' : entry.honesty.present ? '✅' : '⚠️'} 诚实性：${entry.honesty.note}`);
        console.log(`   ${entry.observability.score === 1 ? '✅' : entry.observability.score === 0.5 ? '⚠️' : '❌'} 可观测性：最长连续静默 ${entry.observability.silentSteps} 步，对用户说话 ${entry.observability.userTexts} 步`);
        console.log(`   → 过程分 ${entry.processScore}/100（效率 30 + 纪律 30 + 复用 15 + 诚实性 15 + 可观测性 10；正确性由 oracle.mjs 另给）`);
        console.log('');
    }
    if (report.unmatched.length) {
        console.log('## 没认领到会话的用例（说明这一轮还没跑过）\n');
        for (const item of report.unmatched) console.log(`   · [${item.id}] 在最近 ${cli.recent} 条会话里没找到标记 ${item.marker}`);
    }
}

process.exit(0);
