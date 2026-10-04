/**
 * BENCH oracle —— **产物断言**（独立于被测 AI 的自述）。
 *
 * ## 为什么必须有它
 *
 * 历史教训：会话里说「做完了」是对的，但产物会消失（一夜之间 4 次尝试的预制件全没了）、
 * 也会「看起来加上了其实没生效」（`duration: null` 那一类）。所以判据只认两样东西：
 *
 * 1. **磁盘上的产物**（这里的 `checks`）—— 直接解析 `.prefab` / `.scene` 的 JSON；
 * 2. **会话日志里的过程指标**（`check` 里以 `log-` 开头的那些）—— 交给 `score.mjs`。
 *
 * 两者都不看 AI 自己的总结。AI 写的 `result.json` 只用来做**虚报检测**。
 *
 * ## 用法
 *
 * ```sh
 * node benchmark/oracle.mjs                     # 跑全部用例的磁盘断言
 * node benchmark/oracle.mjs --case ui-basic     # 只跑一条
 * node benchmark/oracle.mjs --probes            # 额外打印「需要粘到 dsh_chat 面板里跑」的编辑器探针
 * node benchmark/oracle.mjs --editor-report editor.json   # 把探针结果并排显示（人工/模型判定）
 * ```
 *
 * ## 支持的 check 类型
 *
 * | kind | 作用 |
 * |---|---|
 * | `file-glob` | 按 glob 找文件；`min` / `exactly` 约束数量 |
 * | `dir-glob` | 同上（语义分开只为可读性） |
 * | `file-contains` / `file-not-contains` | 文本包含断言 |
 * | `prefab-stats` | 解析 `.prefab`/`.scene`：节点数、组件类型、节点名、**是否有非 cc.* 组件**、**是否引用了工程资源** |
 * | `manifest-required` | 要求 AI 写下 `assets/bench/<id>/result.json`（用于虚报检测） |
 * | `log-*` | **本文件不处理**，交给 `score.mjs` |
 *
 * @module dsh_chat/benchmark/oracle
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = HERE;

/** 参数解析（只认 `--key [value]`）。 */
function parseArgv(argv) {
    const out = { case: null, probes: false, editorReport: null, json: false, inspect: null };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--case') out.case = argv[++i] ?? null;
        else if (token === '--probes') out.probes = true;
        else if (token === '--editor-report') out.editorReport = argv[++i] ?? null;
        else if (token === '--json') out.json = true;
        else if (token === '--inspect') out.inspect = argv[++i] ?? null;
    }
    return out;
}

const args = parseArgv(process.argv.slice(2));
const suite = JSON.parse(readFileSync(join(BENCH_ROOT, 'cases.json'), 'utf8'));
const PROJECT = resolve(suite.project ?? join(BENCH_ROOT, '..', '..', '..'));

/** 把 glob（只支持 `**` `*`）转成正则；项目的用例只用这两种。 */
function globToRegExp(pattern) {
    const normalized = pattern.replace(/\\/g, '/');
    let re = '';
    for (let i = 0; i < normalized.length; i += 1) {
        const ch = normalized[i];
        if (ch === '*' && normalized[i + 1] === '*') {
            re += '.*';
            i += 1;
            if (normalized[i + 1] === '/') i += 1;
        } else if (ch === '*') re += '[^/]*';
        else if ('\\^$.|?+()[]{}'.includes(ch)) re += `\\${ch}`;
        else re += ch;
    }
    return new RegExp(`^${re}$`);
}

/** 递归列文件（跳过 node_modules / library / temp / .git）。 */
function listFiles(root, acc = []) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp' || entry.name === '.git') continue;
        const full = join(root, entry.name);
        if (entry.isDirectory()) listFiles(full, acc);
        else acc.push(full.replace(/\\/g, '/'));
    }
    return acc;
}

/** 工程内所有文件（用于 glob；缓存一次）。 */
let FILE_CACHE = null;
function projectFiles() {
    if (!FILE_CACHE) FILE_CACHE = listFiles(PROJECT);
    return FILE_CACHE;
}

/** 按 glob 匹配工程内相对路径。 */
function matchGlob(pattern) {
    const re = globToRegExp(pattern);
    const root = PROJECT.replace(/\\/g, '/');
    return projectFiles()
        .map((f) => f.slice(root.length + 1))
        .filter((rel) => re.test(rel));
}

/**
 * 建 `assets/**\/*.meta` 的 `uuid → 路径` 索引。
 *
 * 口径来自实战：**「这个预制件有没有引用工程资源」= 它里面的 `__uuid__` 能不能在 meta 索引里找到**。
 * 找不到的是引擎内置资源（`db://internal/...`）——这正是历史会话里用过的判定方法。
 */
let UUID_INDEX = null;
function projectUuidIndex() {
    if (UUID_INDEX) return UUID_INDEX;
    const index = new Map();
    for (const rel of matchGlob('assets/**/*.meta')) {
        try {
            const meta = JSON.parse(readFileSync(join(PROJECT, rel), 'utf8'));
            if (meta && typeof meta.uuid === 'string') index.set(meta.uuid, rel);
        } catch {
            /* 坏 meta 跳过 */
        }
    }
    UUID_INDEX = index;
    return index;
}

/**
 * 结构型 `__type__`（它们不是「组件」，统计组件时排除）。
 *
 * ⚠ 口径是**拿真预制件标定出来的**（`--inspect` 跑 `View_Game_Stage.prefab`）：
 * 一个正常工程的预制件里，`cc.CompPrefabInfo`（每个组件一份的预制件元数据）有 458 条、
 * `cc.TargetInfo` / `cc.PrefabInstance` 各 4 条 —— 不排掉的话「组件种类」这个数会虚高得没法看。
 */
const STRUCTURAL_TYPES = new Set([
    'cc.Prefab',
    'cc.PrefabInfo',
    'cc.Node',
    'cc.Scene',
    'cc.SceneAsset',
    'cc.SceneGlobals',
    'cc.ScenePrefab',
    'cc.CompPrefabInfo',
    'cc.PrefabInstance',
    'cc.TargetInfo',
    'cc.PropertyOverrideInfo',
]);

/**
 * 「不算脚本」的非 `cc.` 类型（白名单）。
 *
 * `CCPropertyOverrideInfo`（注意没有 `cc.` 前缀）是**嵌套预制件**的合法产物，
 * 不是项目脚本；不白名单化的话，任何用到嵌套预制件的用例都会被误判成「挂了脚本」。
 * 项目脚本的 `__type__` 是那种短 id（形如 `159488l1QBP7YNY/rbpy78a`），一定会被揪出来。
 */
const NON_CC_ALLOWLIST = new Set(['CCPropertyOverrideInfo']);

/**
 * 解析一个 `.prefab` / `.scene`，抽出断言需要的事实。
 *
 * Cocos 3.x 的产物是**数组**：每个元素带 `__type__`，互相用 `{"__id__": n}` 引用。
 *
 * @param file - 绝对路径。
 * @returns 统计结果，或 `{ parseError }`。
 */
function analyzeSerializedAsset(file) {
    let json;
    try {
        json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return { parseError: error instanceof Error ? error.message : String(error) };
    }
    if (!Array.isArray(json)) return { parseError: '产物不是数组（不是 Cocos 3.x 的序列化格式）' };

    const nodes = [];
    const componentTypes = new Map();
    const allTypes = new Set();
    const uuids = new Set();

    const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (typeof value.__uuid__ === 'string') uuids.add(value.__uuid__);
        for (const key of Object.keys(value)) walk(value[key]);
    };

    for (const entry of json) {
        if (!entry || typeof entry !== 'object') continue;
        const type = entry.__type__;
        if (typeof type === 'string') allTypes.add(type);
        if (type === 'cc.Node') {
            nodes.push({
                name: typeof entry._name === 'string' ? entry._name : '',
                active: entry._active !== false,
                childCount: Array.isArray(entry._children) ? entry._children.length : 0,
                componentCount: Array.isArray(entry._components) ? entry._components.length : 0,
            });
        } else if (typeof type === 'string' && type.startsWith('cc.') && !STRUCTURAL_TYPES.has(type)) {
            componentTypes.set(type, (componentTypes.get(type) ?? 0) + 1);
        }
        walk(entry);
    }

    const uuidIndex = projectUuidIndex();
    const projectRefs = [];
    for (const uuid of uuids) {
        const base = uuid.split('@')[0];
        const hit = uuidIndex.get(base) ?? uuidIndex.get(uuid);
        if (hit) projectRefs.push({ uuid, meta: hit });
    }

    const nonCcTypes = [...allTypes].filter((t) => !t.startsWith('cc.') && !NON_CC_ALLOWLIST.has(t));
    return {
        nodeCount: nodes.length,
        names: nodes.map((n) => n.name),
        inactiveNodes: nodes.filter((n) => !n.active).map((n) => n.name),
        componentTypes: Object.fromEntries([...componentTypes.entries()].sort()),
        allTypes: [...allTypes].sort(),
        nonCcTypes: nonCcTypes.sort(),
        uuidCount: uuids.size,
        projectRefs,
    };
}

/** 单条 check 的结果。 */
function checkResult(caseId, label, ok, detail) {
    return { caseId, label, ok, detail };
}

/**
 * 跑一条用例的磁盘断言。
 *
 * @param testCase - `cases.json` 里的一条。
 * @returns `{ results, probes, skippedLogChecks }`。
 */
function runCase(testCase) {
    const results = [];
    const probes = testCase.editorProbe ?? [];
    const skippedLogChecks = [];
    const manifestPath = join(PROJECT, 'assets', 'bench', testCase.id, 'result.json');

    for (const check of testCase.checks ?? []) {
        const kind = check.kind;
        if (kind.startsWith('log-')) {
            skippedLogChecks.push(kind);
            continue;
        }
        const label = check.label ?? kind;

        if (kind === 'file-glob' || kind === 'dir-glob') {
            const hits = matchGlob(check.pattern);
            let ok = hits.length > 0;
            const notes = [];
            if (typeof check.min === 'number') {
                ok = hits.length >= check.min;
                notes.push(`≥${check.min}`);
            }
            if (typeof check.exactly === 'number') {
                ok = hits.length === check.exactly;
                notes.push(`=${check.exactly}`);
            }
            results.push(checkResult(testCase.id, `${label} (${check.pattern}${notes.length ? ', ' + notes.join(',') : ''})`, ok, `${hits.length} 个：${hits.slice(0, 4).join(', ')}`));
            continue;
        }

        if (kind === 'file-contains' || kind === 'file-not-contains') {
            const file = join(PROJECT, check.file);
            if (!existsSync(file)) {
                results.push(checkResult(testCase.id, `${label} (${check.file})`, false, '文件不存在'));
                continue;
            }
            const text = readFileSync(file, 'utf8');
            const has = text.includes(check.text);
            results.push(checkResult(testCase.id, `${label} (${check.file} 含 "${check.text}")`, kind === 'file-contains' ? has : !has, has ? '命中' : '未命中'));
            continue;
        }

        if (kind === 'manifest-required') {
            results.push(checkResult(testCase.id, 'AI 写了 result.json（虚报检测用）', existsSync(manifestPath), existsSync(manifestPath) ? manifestPath.replace(PROJECT, '') : '缺失'));
            continue;
        }

        if (kind === 'prefab-stats') {
            const file = join(PROJECT, check.file);
            if (!existsSync(file)) {
                results.push(checkResult(testCase.id, `${label} (${basename(check.file)})`, false, '产物不存在'));
                continue;
            }
            const stat = analyzeSerializedAsset(file);
            if (stat.parseError) {
                results.push(checkResult(testCase.id, `${label} (${basename(check.file)})`, false, `解析失败：${stat.parseError}`));
                continue;
            }
            const problems = [];
            if (Array.isArray(check.nodeCount)) {
                const [lo, hi] = check.nodeCount;
                if (stat.nodeCount < lo || stat.nodeCount > hi) problems.push(`节点数 ${stat.nodeCount} 不在 [${lo}, ${hi}]`);
            }
            if (check.noNonCcTypes && stat.nonCcTypes.length > 0) problems.push(`有非 cc.* 组件：${stat.nonCcTypes.join(', ')}`);
            if (check.noProjectAssetRefs && stat.projectRefs.length > 0) {
                problems.push(`引用了 ${stat.projectRefs.length} 个工程资源：${stat.projectRefs.slice(0, 3).map((r) => r.meta).join(', ')}`);
            }
            for (const component of check.requireComponents ?? []) {
                if (!stat.componentTypes[component]) problems.push(`缺组件 ${component}`);
            }
            for (const name of check.requireNodeNames ?? []) {
                if (!stat.names.includes(name)) problems.push(`缺节点 ${name}`);
            }
            if (check.forbidNodeNamePrefix) {
                const bad = stat.names.filter((n) => n.startsWith(check.forbidNodeNamePrefix));
                if (bad.length) problems.push(`残留节点 ${bad.slice(0, 5).join(', ')}`);
            }
            const summary = `${stat.nodeCount} 节点 / ${Object.keys(stat.componentTypes).length} 种组件 / 内置或工程引用 ${stat.uuidCount - stat.projectRefs.length}+${stat.projectRefs.length}`;
            results.push(checkResult(testCase.id, `${label} (${basename(check.file)})`, problems.length === 0, problems.length ? problems.join('；') : summary));
            continue;
        }

        results.push(checkResult(testCase.id, `${label} (${kind})`, false, `未知的 check 类型：${kind}`));
    }

    return { results, probes, skippedLogChecks };
}

/** 主流程。 */
if (args.inspect) {
    // 单文件体检模式：给出题/调断言时用来确认解析口径（`--inspect assets/xxx.prefab`）
    const target = join(PROJECT, args.inspect);
    if (!existsSync(target)) {
        console.error(`找不到文件：${target}`);
        process.exit(2);
    }
    console.log(JSON.stringify(analyzeSerializedAsset(target), null, 2));
    process.exit(0);
}

const selected = args.case ? suite.cases.filter((c) => c.id === args.case) : suite.cases;
if (selected.length === 0) {
    console.error(`找不到用例 "${args.case}"；可用：${suite.cases.map((c) => c.id).join(', ')}`);
    process.exit(2);
}

const report = { project: PROJECT, cases: [] };
let failed = 0;
let passed = 0;
const probeQueue = [];

for (const testCase of selected) {
    const { results, probes, skippedLogChecks } = runCase(testCase);
    const caseFailed = results.filter((r) => !r.ok).length;
    failed += caseFailed;
    passed += results.length - caseFailed;
    report.cases.push({ id: testCase.id, title: testCase.title, level: testCase.level, domain: testCase.domain, results, skippedLogChecks });
    for (const probe of probes) probeQueue.push({ caseId: testCase.id, ...probe });
}

let editorReport = null;
if (args.editorReport) {
    try {
        editorReport = JSON.parse(readFileSync(resolve(args.editorReport), 'utf8'));
    } catch (error) {
        console.error(`读 editor-report 失败：${error instanceof Error ? error.message : error}`);
    }
}

if (args.json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(`# BENCH oracle —— 磁盘产物断言（工程 ${PROJECT}）\n`);
    for (const entry of report.cases) {
        console.log(`## [${entry.id}] ${entry.title}  (L${entry.level} · ${entry.domain})`);
        if (entry.results.length === 0) console.log('   （无用例级磁盘断言；过程指标看 score.mjs，编辑器状态看下方探针）');
        for (const r of entry.results) console.log(`   ${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : ` —— ${r.detail}`}`);
        if (entry.skippedLogChecks.length) console.log(`   ↪ 交给 score.mjs 的过程断言：${[...new Set(entry.skippedLogChecks)].join(', ')}`);
        console.log('');
    }

    if (probeQueue.length) {
        console.log('## 编辑器侧探针（本机跑 oracle 看不到编辑器，需要粘到 dsh_chat 面板里跑一次）\n');
        for (const probe of probeQueue) {
            console.log(`### [${probe.caseId}] ${probe.label}`);
            console.log('```js');
            console.log(`${probe.code}${probe.expect ? `\n// 期望：${probe.expect}` : ''}`);
            console.log('```');
            if (editorReport && Object.prototype.hasOwnProperty.call(editorReport, probe.label)) {
                console.log(`实际：${JSON.stringify(editorReport[probe.label])}\n`);
            }
        }
    }

    console.log(`\n=== 磁盘断言：${passed} 通过 / ${failed} 失败 ===`);
}

process.exit(failed > 0 ? 1 : 0);
