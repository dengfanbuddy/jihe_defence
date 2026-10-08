#!/usr/bin/env node
/**
 * diff.mjs —— Cocos 预制件 / 场景的「语义 diff」
 *
 * 回答的问题：**「这次改动，我到底动了哪些节点和字段？」**
 *
 * ── 为什么不用字节级相等 ────────────────────────────────────────────
 * 它回答的是「除我之外有没有字节变」，而不是「我改了什么、改对没有」：
 * 编辑器每存一次盘都会整篇重排（下标、字段顺序、浮点尾数），判红不代表有真问题；
 * 反过来它**永远看不见**「某个引用指到了哪个节点」—— 而那恰恰是改预制件时最该看的东西。
 * 逐字节相等只配用在「确定性重放」的场合（如 `tools/hit-feel-sfx/render.mjs --check`）。
 *
 * ── 为什么不用 `git diff`（行级文本）────────────────────────────────
 * 预制件是**扁平数组 + 按下标 `{"__id__": n}` 互相引用**：往中间插一个对象，
 * 后面**所有**引用的下标都要顺移。实测 `Scene_Menu.prefab`（838 KB / 48069 行，
 * 实际只多了 1 个组件、改了 2 个节点名和 4 个字段）：
 *   · `git diff -U0` = 1173 个 hunk、+1224 / −1185 行，其中 **1147 个新增行是 `__id__` 重编号**
 *   · 本脚本         = 45 ms、6 处实质改动
 *
 * ── 做法 ────────────────────────────────────────────────────────────
 *   ① 解析成数组，按 `cc.Node` / `cc.Scene` 建树，给每个节点算出**路径**当标签；
 *   ② 身份认 `__prefab.fileId`（编辑器给每个序列化元素发的稳定 id）⇒ **改名与移动是精确的**，
 *      不受下标顺移影响；组件也按 fileId 配对（往中间插组件不会带出假 diff）。
 *      文件里没有 fileId 时退化成「按路径认身份」，并明确提示改名会显示成「删 + 增」；
 *   ③ 逐个节点比自身字段、逐个组件比字段；引用 `{"__id__": n}` 一律解成
 *      `@路径`（节点）/ `#cc.Label`（组件等非节点对象）/ `uuid:…`（资源），**指到哪一目了然**；
 *      指向自己或自己后代的引用写成 `@.` / `@./x` —— 于是「父节点改名」不会污染子树里的字段；
 *   ④ 浮点尾数差（默认相对 1e-9）与 `_id` 一类运行时 id 归为**噪声**：单独计数、不影响结论；
 *   ⑤ 子节点的**顺序**单列一项（UI 的 z 序就是兄弟顺序），成员增删只算一次（在新增/删除节点里）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node tools/prefab-diff/diff.mjs <新文件>                  # 旧侧取 git HEAD 里的同一路径（最常用）
 *   node tools/prefab-diff/diff.mjs --a <旧> --b <新>         # 任意两份（含「存盘前快照 vs 存盘后」）
 *   node tools/prefab-diff/diff.mjs <新文件> --path <段>       # 只看某棵子树（按路径段匹配）
 *   node tools/prefab-diff/diff.mjs <新文件> --json           # 结构化输出到 stdout（人读信息改走 stderr）
 *   node tools/prefab-diff/diff.mjs <新文件> --gate --allow 1 # 实质改动 > 1 处就退出码 1
 *   ⚠ 别写 `npm run diff:prefab -- --b <文件>`：本机 npm 会把 `--b`/`--path` 当成自己的配置吃掉
 *     （与 AGENTS.md 里 `json2excel --force` 同一个坑）；npm 那条只适合裸位置参数。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────
 *   0 = 跑通（**默认差异不算失败**，同「看差异」而不是「当门禁」）
 *   1 = 只在 `--gate` 下、且实质改动数 > `--allow`（默认 0）时
 *   2 = 跑不动（文件读不到 / 不是 Cocos 序列化数组 / 取 HEAD 失败 / 参数错）
 *       —— **"跑不动"一律算 2，绝不当成"没改动"**。
 *
 * ── 已知边界（都要如实告诉使用者）──────────────────────────────────
 *   · 只认 Cocos Creator 3.x 的**扁平数组**序列化格式（`.prefab` / `.scene` 同格式）；
 *   · `cc.PrefabInfo` 这类编辑器内部对象折叠成 `#cc.PrefabInfo`，它的 `fileId`/`asset`
 *     指针不进判据（否则每次存盘都是满屏噪声）；
 *   · 组件在节点上的**顺序**进判据（引擎按数组顺序调生命周期），所以那是有意为之的；
 *   · `_id` 是运行时生成的，不进判据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ===================================================================
 * 常量
 * =================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 工程根：缺省 = 从脚本位置往上两级（`tools/prefab-diff/../..`），可用 `--root` 覆盖。
 * 覆盖是给「把这份脚本拷到别的工程/别的位置」用的 —— 它只影响相对路径与 `git HEAD` 的基准。
 */
let ROOT = path.resolve(HERE, '../..');

/** 顶层数组里这两类对象算「节点」（场景根是 `cc.Scene`，不是 `cc.Node`） */
const NODE_TYPES = new Set(['cc.Node', 'cc.Scene']);
/**
 * 节点自身字段里**不比**的：
 * `__type__`/`__prefab`/`_prefab`（类型与内部信息引用）、`_id`（运行时生成）、
 * `_components`（单列）、`_children`（单列）、
 * `_name`（它就是路径标签，改了名由「改名」那一节报，不该再当字段变化刷一遍）、
 * `_parent`（由 `_children` 决定的回指，路径变了它必然跟着变，报了也是同一件事）。
 */
const SKIP_NODE_FIELDS = new Set([
    '__type__', '__prefab', '_prefab', '_id', '_components', '_children', '_name', '_parent',
]);
/** 组件字段里**不比**的：类型/内部信息引用/运行时 id */
const SKIP_COMP_FIELDS = new Set(['__type__', '__prefab', '_prefab', '_id']);
/** 明细里每类最多打印多少条（`--max` 可改） */
const MAX_DETAIL_DEFAULT = 60;

/* ===================================================================
 * 参数
 * =================================================================== */

const USAGE = `用法：node tools/prefab-diff/diff.mjs <新文件> [选项]

  <新文件>        新侧（位置参数，也可以写成 --b <文件>）
  --a <文件>      旧侧。缺省 = 取 git HEAD 里与 <新文件> 同路径的那一份
  --b <文件>      新侧（与位置参数二选一）
  --path <段>     只报告路径里含这几段**连续节点名**的节点（如 --path ui_difficulty）
  --json          结构化结果写到 stdout；人读报告改走 stderr
  --gate          实质改动数 > --allow 时退出码 1（默认不看差异成败）
  --allow <n>     --gate 下允许的实质改动条数（默认 0）
  --max <n>       每类明细最多打印几条（默认 ${MAX_DETAIL_DEFAULT}）
  --tol <eps>     浮点噪声容差，相对值（默认 1e-9）
  --root <目录>   工程根（缺省 = 脚本位置往上两级；把脚本拷到别处时用它指工程）
  -h, --help      看这段

⚠ 别用 \`npm run diff:prefab -- --b <文件>\`：本机 npm 会把 \`--b\`/\`--path\` 这类旗标当成自己的配置吃掉
  （与 AGENTS.md 里 \`json2excel --force\` 同一个坑）。带旗标时直接跑 node；npm 那条只适合裸位置参数。
  文件路径**先按当前目录、再按工程根**解析 —— 在哪个目录跑都一样。

退出码：0 = 跑通 / 1 = --gate 且有超出 / 2 = 跑不动（当不成"没改动"）`;

function die(msg, code = 2) {
    console.error(`✖ ${msg}`);
    process.exit(code);
}

function parseArgs(argv) {
    const o = {
        a: null, b: null, pathFilter: null, json: false, gate: false,
        allow: 0, max: MAX_DETAIL_DEFAULT, tol: 1e-9,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => {
            const v = argv[++i];
            if (v === undefined) die(`参数 ${k} 缺一个值\n\n${USAGE}`);
            return v;
        };
        const num = () => {
            const v = Number(val());
            if (!Number.isFinite(v)) die(`参数 ${k} 要一个数字`);
            return v;
        };
        if (k === '--a') o.a = val();
        else if (k === '--b') o.b = val();
        else if (k === '--path') o.pathFilter = val().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        else if (k === '--json') o.json = true;
        else if (k === '--gate') o.gate = true;
        else if (k === '--allow') o.allow = num();
        else if (k === '--max') o.max = num();
        else if (k === '--tol') o.tol = num();
        else if (k === '--root') o.root = val();
        else if (k === '-h' || k === '--help') { console.log(USAGE); process.exit(0); }
        else if (k.startsWith('-')) die(`未知参数 ${k}\n\n${USAGE}`);
        else positional.push(k);
    }
    if (positional.length > 1) {
        die(`只认一个新侧文件，多的这些认不出来：${positional.slice(1).join(' ')}\n\n${USAGE}`);
    }
    if (positional.length === 1) {
        if (o.b) die(`同时给了位置参数和 --b，认不准哪个是新侧\n\n${USAGE}`);
        o.b = positional[0];
    }
    if (!o.b) die(`必须给新侧文件（位置参数或 --b）\n\n${USAGE}`);
    return o;
}

/* ===================================================================
 * 取两份输入
 * =================================================================== */

/** 统一成正斜杠相对路径（报告里好看，也方便喂给 git） */
function relLabel(abs) {
    const r = path.relative(ROOT, abs);
    return (r && !r.startsWith('..') ? r : abs).replace(/\\/g, '/');
}

/**
 * 解析一个输入文件：**先按当前目录、再按工程根**。
 * 于是「在 tools/excel_export 里 `npm run diff:prefab -- ../../assets/x.prefab`」与
 * 「在工程根 `node tools/prefab-diff/diff.mjs assets/x.prefab`」两种写法都对。
 */
function resolveInput(spec) {
    const fromCwd = path.resolve(process.cwd(), spec);
    if (fs.existsSync(fromCwd)) return fromCwd;
    return path.resolve(ROOT, spec);
}

function parseCocos(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        die(`读不到 ${file}：${e.message}`);
    }
    let arr;
    try {
        arr = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
        die(`${file} 不是合法 JSON：${e.message}`);
    }
    if (!Array.isArray(arr)) die(`${file} 顶层不是数组（Cocos 序列化格式应为数组，实际是 ${typeof arr}）`);
    if (!arr.some((o) => o && NODE_TYPES.has(o.__type__))) {
        die(`${file} 里一个 ${[...NODE_TYPES].join(' / ')} 都没有 —— 这不像预制件或场景`);
    }
    return { arr, bytes: fs.statSync(file).size };
}

/**
 * 取 `git HEAD` 里的同一路径。
 * ⚠ 子进程的输出**重定向到临时文件**而不是走管道：本工程的沙箱下管道会 EPERM
 * （同 `tools/typecheck-diff/check.mjs` 的 `openSink`）。副作用是不需要任何 shell。
 */
function parseGitHead(absTarget) {
    const rel = path.relative(ROOT, absTarget);
    if (rel.startsWith('..')) die(`--b 在工程之外（${absTarget}），取不到 HEAD 那份，请显式给 --a`);
    const spec = rel.replace(/\\/g, '/');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefab-diff-'));
    const outFile = path.join(tmpDir, 'blob.json');
    const errFile = path.join(tmpDir, 'err.txt');
    const fdOut = fs.openSync(outFile, 'w');
    const fdErr = fs.openSync(errFile, 'w');
    const r = spawnSync('git', ['-C', ROOT, 'show', `HEAD:${spec}`], { stdio: ['ignore', fdOut, fdErr] });
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
    const errText = fs.readFileSync(errFile, 'utf8').trim();
    if (r.error) die(`跑不动 git：${r.error.message}（要比较任意两份就显式给 --a）`);
    if (r.status !== 0) die(`git show HEAD:${spec} 失败（退出码 ${r.status}）：${errText || '(无输出)'}`);
    const parsed = parseCocos(outFile);   // ⚠ 必须先把临时文件读进来，再清理目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
    return parsed;
}

/* ===================================================================
 * 脚本组件的名字：`__type__` 是压缩 uuid，反查 .meta 换成文件名
 * =================================================================== */

/**
 * Cocos 把 uuid 压成 23 个字符：前 5 位是原 uuid 的前 5 位十六进制，其余 27 位十六进制按
 * 每 3 位（=12 bit）编成 4 位 base64 —— 所以 `//` 是 base64 里正常会出现的字符，不是分隔符。
 * 这里只做「反查用」的解压；解不出来就退回按前 5 位匹配（并在名字后面标个 `？`）。
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = '0123456789abcdef';

function decompressUuid(compressed) {
    if (typeof compressed !== 'string' || compressed.length !== 23) return null;
    let hex = compressed.slice(0, 5);
    for (let i = 5; i < 23; i += 2) {
        const l = B64.indexOf(compressed[i]);
        const r = B64.indexOf(compressed[i + 1]);
        if (l < 0 || r < 0) return null;
        hex += HEX[l >> 2] + HEX[((l & 3) << 2) | (r >> 4)] + HEX[r & 15];
    }
    return hex;   // 32 位十六进制（无短横）
}

let SCRIPT_INDEX = null;

/** 扫 `assets` 下的 `*.ts.meta` / `*.js.meta` 建「uuid → 文件名」索引（本工程 239 个，一次性） */
function scriptIndex() {
    if (SCRIPT_INDEX) return SCRIPT_INDEX;
    SCRIPT_INDEX = new Map();
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(path.join(dir, e.name));
                continue;
            }
            if (!e.name.endsWith('.ts.meta') && !e.name.endsWith('.js.meta')) continue;
            let text;
            try { text = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
            const m = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(text);
            if (!m) continue;
            SCRIPT_INDEX.set(m[1].replace(/-/g, ''), e.name.slice(0, -'.meta'.length));
        }
    };
    walk(path.join(ROOT, 'assets'));
    return SCRIPT_INDEX;
}

/** `dff15hlqOVI7KPApq4fA3Mk` → `Cmp_Game.ts`；认不出来就原样返回 */
function typeLabel(type) {
    if (typeof type !== 'string' || type.startsWith('cc.')) return type;
    const idx = scriptIndex();
    const full = decompressUuid(type);
    if (full && idx.has(full)) return idx.get(full);
    const head = type.slice(0, 5);
    for (const [uuid, name] of idx) if (uuid.startsWith(head)) return `${name}？`;
    return type;
}

/* ===================================================================
 * 建树 / 签名
 * =================================================================== */

function normalizeNumber(v, tol) {
    if (typeof v !== 'number' || Number.isInteger(v)) return v;
    // 只做「尾数噪声」的归一：留 12 位有效数字，1e-12 级别的抖动在这里就被抹平
    const r = Number(v.toPrecision(12));
    return r;
}

/**
 * 建索引：节点路径、父子关系、组件归属，以及每个元素的身份键。
 * 身份优先 `__prefab.fileId`（稳定），没有就退回路径。
 */
function indexSide(arr) {
    const fileIdOf = (o) => {
        // ⚠ 节点用 `_prefab`、组件用 `__prefab`（实测 321 / 665），两个都要认
        const p = o && (o.__prefab ?? o._prefab);
        if (!p || typeof p.__id__ !== 'number') return null;
        const info = arr[p.__id__];
        const fid = info && info.fileId;
        return typeof fid === 'string' && fid ? fid : null;
    };
    const nodeIdx = [];
    arr.forEach((o, i) => { if (o && NODE_TYPES.has(o.__type__)) nodeIdx.push(i); });
    const isNode = new Set(nodeIdx);
    const kidsOf = (i) => (arr[i]._children ?? [])
        .map((c) => (c && typeof c.__id__ === 'number' ? c.__id__ : -1))
        .filter((j) => isNode.has(j));

    const parentOf = new Map();
    for (const i of nodeIdx) for (const j of kidsOf(i)) parentOf.set(j, i);
    const roots = nodeIdx.filter((i) => !parentOf.has(i));

    const paths = new Map();
    const walk = (i, prefix) => {
        const name = arr[i]._name ?? '?';
        const sibs = (parentOf.has(i) ? kidsOf(parentOf.get(i)) : roots).map((j) => arr[j]._name ?? '?');
        const dup = sibs.filter((s) => s === name).length > 1;
        const p = prefix ? `${prefix}/${name}${dup ? `#${sibs.indexOf(name)}` : ''}` : name;
        paths.set(i, p);
        for (const j of kidsOf(i)) walk(j, p);
    };
    for (const r of roots) walk(r, '');
    return { arr, nodeIdx, kidsOf, parentOf, roots, paths, fileIdOf, isNode };
}

/**
 * 引用渲染：`@路径`（节点）/ `#cc.Label`（非节点对象）/ `uuid:…`（资源）；自身与后代写成 `@.` / `@./x`。
 * ⚠ 节点引用走的是**规范路径** `canonOf`（改名后取新名字那一份）：否则「把 `card` 改名成 `stage`」
 * 会让所有指着它后代的引用都显示成「改了」—— 同一件事被报了 N 遍。
 */
function makeRefRenderer(side, canonOf, canonOwner) {
    return (v) => {
        if (v && typeof v === 'object') {
            if (typeof v.__id__ === 'number') {
                const t = side.arr[v.__id__];
                if (!t) return `<悬空:${v.__id__}>`;
                if (NODE_TYPES.has(t.__type__)) {
                    const p = canonOf(v.__id__) ?? side.paths.get(v.__id__) ?? (t._name ?? '?');
                    const rel = p === canonOwner ? '.' : (p.startsWith(`${canonOwner}/`) ? `.${p.slice(canonOwner.length)}` : p);
                    return `@${rel}`;
                }
                return `#${t.__type__ ?? '?'}`;
            }
            if (v.__uuid__ !== undefined) return `uuid:${v.__uuid__}`;
        }
        return undefined;
    };
}

/** 把一个对象的自身字段规范化（引用解成字符串） */
function normFields(owner, skip, ref, tol) {
    const out = {};
    for (const k of Object.keys(owner)) {
        if (skip.has(k)) continue;
        out[k] = normValue(owner[k], ref, tol);
    }
    return out;
}

function normValue(v, ref, tol) {
    if (Array.isArray(v)) return v.map((x) => normValue(x, ref, tol));
    if (v && typeof v === 'object') {
        const r = ref(v);
        if (r !== undefined) return r;
        const o = {};
        for (const k of Object.keys(v)) { if (k !== '__type__') o[k] = normValue(v[k], ref, tol); }
        return o;
    }
    return normalizeNumber(v, tol);
}

/** 每个节点一条记录：路径、身份、父节点身份、子节点身份序列、自身字段、组件列表（组件也按身份配对） */
function signSide(side, tol, keys, canonOf) {
    const recs = new Map();
    let withFid = 0;
    const noFid = [];
    for (const i of side.nodeIdx) {
        const node = side.arr[i];
        const p = side.paths.get(i);
        const fid = side.fileIdOf(node);
        if (fid) withFid++;
        else noFid.push(p);
        const ref = makeRefRenderer(side, canonOf, canonOf(i) ?? p);
        const comps = [];
        for (const c of (node._components ?? [])) {
            const comp = side.arr[c && c.__id__];
            if (!comp) continue;
            const cfid = side.fileIdOf(comp);
            comps.push({
                key: cfid ? `fid:${cfid}` : `pos:${comps.length}:${comp.__type__}`,
                type: comp.__type__,
                hasFid: !!cfid,
                fields: normFields(comp, SKIP_COMP_FIELDS, ref, tol),
            });
        }
        recs.set(keys.get(i), {
            i,
            path: p,
            fid,
            /* 父节点身份：用它判断「真的换了父节点」，而不是「父节点改了名」 */
            parentKey: side.parentOf.has(i) ? keys.get(side.parentOf.get(i)) : '',
            /* 子节点身份序列：UI 的 z 序就是它；成员增删不在这一项里报（另有新增/删除节点） */
            kids: side.kidsOf(i).map((j) => keys.get(j)),
            self: normFields(node, SKIP_NODE_FIELDS, ref, tol),
            comps,
        });
    }
    return { recs, withFid, noFid };
}

/* ===================================================================
 * 比对
 * =================================================================== */

const isNoise = (a, b, tol) => {
    if (typeof a === 'number' && typeof b === 'number') {
        return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * tol;
    }
    if (typeof a === 'string' && typeof b === 'string' && a !== b) {
        // 等长的 id 类字符串（运行时生成、重排）算噪声；引用（@/#/uuid:）与普通文案算真变化
        return /^[0-9a-zA-Z+/=_-]{16,}$/.test(a) && a.length === b.length;
    }
    return false;
};

function leafDiff(a, b, prefix, out, tol) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const bothObj = a && b && typeof a === 'object' && typeof b === 'object';
    if (bothObj && Array.isArray(a) === Array.isArray(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) leafDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, tol);
        return;
    }
    out.push({ field: prefix, from: a, to: b, noise: isNoise(a, b, tol) });
}

function diffSides(A, B, opts) {
    const out = {
        addedNodes: [], removedNodes: [], renamed: [], reordered: [],
        addedComps: [], removedComps: [], fields: [], noiseCount: 0, realCount: 0,
    };
    /**
     * `--path` 按**路径段**匹配（连续的几段节点名就算命中）：
     * 于是 `--path ui_difficulty` 能命中 `Scene_Menu/ui_difficulty`，
     * `--path right/game` 能命中 `Scene_Menu/content/right/game`。
     */
    const inFilter = (p) => {
        if (!opts.pathFilter) return true;
        const segs = p.split('/');
        const f = opts.pathFilter.split('/');
        for (let i = 0; i + f.length <= segs.length; i++) {
            if (f.every((s, k) => segs[i + k] === s)) return true;
        }
        return false;
    };

    for (const [key, rb] of B.recs) {
        if (!A.recs.has(key)) out.addedNodes.push({ path: rb.path, comps: rb.comps.map((c) => c.type) });
    }
    for (const [key, ra] of A.recs) {
        if (!B.recs.has(key)) out.removedNodes.push({ path: ra.path, comps: ra.comps.map((c) => c.type) });
    }

    /*
     * 改名 / 移动：**只报改名子树的顶**。
     * 后代的路径也变了，但那是同一件事 —— 每个后代都列一行只会在同一件事上刷屏（实测 2 处改名
     * 会变成 16 行）。所以「父节点也改了名」的那些跳过，由祖先那一行带出跟随节点数。
     * 「换了父节点」用的是**父节点的身份键**：父节点只是改了个名不算移动。
     */
    for (const [key, rb] of B.recs) {
        const ra = A.recs.get(key);
        if (!ra || ra.path === rb.path) continue;
        const parentMoved = ra.parentKey !== rb.parentKey;
        const pa = ra.parentKey ? A.recs.get(ra.parentKey) : null;
        const pb = rb.parentKey ? B.recs.get(rb.parentKey) : null;
        if (!parentMoved && pa && pb && pa.path !== pb.path) continue;   // 祖先那一行代表它
        if (!inFilter(ra.path) && !inFilter(rb.path)) continue;
        const follow = [...B.recs.values()].filter((r) => {
            if (!r.path.startsWith(`${rb.path}/`)) return false;
            const a = A.recs.get(r.fid ? `fid:${r.fid}` : `path:${r.path}`);
            return !!a && a.path === `${ra.path}${r.path.slice(rb.path.length)}`;
        }).length;
        out.renamed.push({
            from: ra.path,
            to: rb.path,
            follow,
            moved: parentMoved ? `${pa ? pa.path : '(根)'} → ${pb ? pb.path : '(根)'}` : null,
        });
    }

    for (const [key, rb] of B.recs) {
        const ra = A.recs.get(key);
        if (!ra) continue;

        const renamed = ra.path !== rb.path;
        if (!inFilter(rb.path) && !inFilter(ra.path)) continue;

        // ① 节点自身字段
        const selfFields = [];
        leafDiff(ra.self, rb.self, '', selfFields, opts.tol);
        for (const f of selfFields) addField(out, f, { kind: '节点', path: rb.path, wasPath: renamed ? ra.path : null });

        // ② 子节点顺序（成员增删另算，这里只报「集合没变但顺序变了」）
        const setA = [...ra.kids].sort().join('\u0000');
        const setB = [...rb.kids].sort().join('\u0000');
        if (setA === setB && ra.kids.join('\u0000') !== rb.kids.join('\u0000')) {
            out.reordered.push({ path: rb.path, from: ra.kids.length, to: rb.kids.length });
        }

        // ③ 组件：按身份配对
        const byKeyA = new Map(ra.comps.map((c) => [c.key, c]));
        for (const cb of rb.comps) {
            const ca = byKeyA.get(cb.key);
            if (!ca) {
                out.addedComps.push({ path: rb.path, type: cb.type, fields: cb.fields, assumedIdentity: !cb.hasFid });
                continue;
            }
            byKeyA.delete(cb.key);
            const cf = [];
            leafDiff(ca.fields, cb.fields, '', cf, opts.tol);
            for (const f of cf) addField(out, f, { kind: '组件', compType: cb.type, path: rb.path, wasPath: renamed ? ra.path : null });
        }
        for (const ca of byKeyA.values()) {
            out.removedComps.push({ path: rb.path, type: ca.type, fields: ca.fields, assumedIdentity: !ca.hasFid });
        }
    }
    return out;
}

const parentLabel = (p) => p.split('/').slice(0, -1).join('/');

function addField(out, f, where) {
    if (f.noise) { out.noiseCount++; return; }
    out.realCount++;
    out.fields.push({ ...where, field: f.field, from: f.from, to: f.to });
}

/* ===================================================================
 * 输出
 * =================================================================== */

const showVal = (v) => {
    if (v === undefined) return '(无)';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
};

function render(report, opts) {
    const L = [];
    const cap = (list) => {
        const shown = list.slice(0, opts.max);
        const more = list.length - shown.length;
        return { shown, more };
    };
    L.push('');
    L.push(`【新增节点】${report.addedNodes.length} 个`);
    if (!report.addedNodes.length) L.push('  （无）');
    for (const n of cap(report.addedNodes).shown) {
        L.push(`  + ${n.path}${n.comps.length ? `   [${n.comps.map((t) => typeLabel(t)).join(', ')}]` : ''}`);
    }
    if (report.addedNodes.length > opts.max) L.push(`  … 还有 ${report.addedNodes.length - opts.max} 个`);

    L.push(`【删除节点】${report.removedNodes.length} 个`);
    if (!report.removedNodes.length) L.push('  （无）');
    for (const n of cap(report.removedNodes).shown) {
        L.push(`  - ${n.path}${n.comps.length ? `   [${n.comps.map((t) => typeLabel(t)).join(', ')}]` : ''}`);
    }
    if (report.removedNodes.length > opts.max) L.push(`  … 还有 ${report.removedNodes.length - opts.max} 个`);

    L.push(`【改名 / 移动】${report.renamed.length} 处`);
    if (!report.renamed.length) L.push('  （无）');
    for (const r of cap(report.renamed).shown) {
        L.push(`  ~ ${r.from}`);
        L.push(`    → ${r.to}${r.follow ? `   （子树 ${r.follow} 个节点跟随）` : ''}${r.moved ? `   ⚠ 换了父节点：${r.moved}` : ''}`);
    }

    if (report.reordered.length) {
        L.push(`【子节点顺序变了】${report.reordered.length} 处（UI 的 z 序就是它）`);
        for (const r of cap(report.reordered).shown) L.push(`  ↕ ${r.path}`);
    }

    L.push(`【新增组件】${report.addedComps.length} 个`);
    if (!report.addedComps.length) L.push('  （无）');
    for (const c of cap(report.addedComps).shown) {
        L.push(`  + ${c.path}   ${typeLabel(c.type)}${c.assumedIdentity ? '   ⚠ 这份文件没有 fileId，这个组件是按位置认的' : ''}`);
        for (const [k, v] of Object.entries(c.fields)) L.push(`        ${k} = ${showVal(v)}`);
    }

    L.push(`【删除组件】${report.removedComps.length} 个`);
    if (!report.removedComps.length) L.push('  （无）');
    for (const c of cap(report.removedComps).shown) L.push(`  - ${c.path}   ${typeLabel(c.type)}`);

    L.push(`【字段改动】${report.fields.length} 处`);
    if (!report.fields.length) L.push('  （无）');
    for (const f of cap(report.fields).shown) {
        L.push(`  · ${f.path}${f.wasPath ? `（原 ${f.wasPath}）` : ''}   ${f.kind}${f.compType ? ` ${typeLabel(f.compType)}` : ''}`);
        L.push(`        ${f.field || '(整个对象)'}: ${showVal(f.from)}  →  ${showVal(f.to)}`);
    }
    if (report.fields.length > opts.max) L.push(`  … 还有 ${report.fields.length - opts.max} 处`);
    L.push('');
    return L.join('\n');
}

/* ===================================================================
 * 跑
 * =================================================================== */

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.root) ROOT = path.resolve(process.cwd(), opts.root);
    const bAbs = resolveInput(opts.b);
    const t0 = Date.now();

    const bSrc = parseCocos(bAbs);
    const aSrc = opts.a ? parseCocos(resolveInput(opts.a)) : parseGitHead(bAbs);
    const aLabel = opts.a ? relLabel(resolveInput(opts.a)) : `HEAD:${relLabel(bAbs)}`;
    const tParse = Date.now() - t0;

    const t1 = Date.now();
    const A = indexSide(aSrc.arr);
    const B = indexSide(bSrc.arr);
    /** 身份键：有 `fileId` 就用它（稳定），没有就退回路径 */
    const keyMap = (side) => new Map(side.nodeIdx.map((i) => {
        const f = side.fileIdOf(side.arr[i]);
        return [i, f ? `fid:${f}` : `path:${side.paths.get(i)}`];
    }));
    const keysA = keyMap(A);
    const keysB = keyMap(B);
    /** 新侧路径表：引用一律按它渲染，于是「改名」不会污染别处的引用 */
    const pathB = new Map([...keysB].map(([i, k]) => [k, B.paths.get(i)]));
    const canonA = (i) => pathB.get(keysA.get(i)) ?? A.paths.get(i);
    const canonB = (i) => B.paths.get(i);
    const sa = signSide(A, opts.tol, keysA, canonA);
    const sb = signSide(B, opts.tol, keysB, canonB);
    const tIndex = Date.now() - t1;

    const t2 = Date.now();
    const report = diffSides(sa, sb, opts);
    const tDiff = Date.now() - t2;

    const changedNodes = new Set(report.fields.map((f) => f.path)).size;
    const allFid = sa.withFid === sa.recs.size && sb.withFid === sb.recs.size;
    const identity = allFid ? 'fileId' : (sa.withFid + sb.withFid > 0 ? 'mixed' : 'path');
    const identityLabel = identity === 'fileId'
        ? '__prefab.fileId（改名/移动是精确的）'
        : (identity === 'mixed'
            ? `__prefab.fileId（旧 ${sa.withFid}/${sa.recs.size} · 新 ${sb.withFid}/${sb.recs.size} 个节点有，其余按路径认）`
            : '路径（这份文件没有 __prefab.fileId ⇒ 改名会显示成「删 + 增」）');
    const summary = {
        identity,
        withFidA: sa.withFid,
        withFidB: sb.withFid,
        nodesA: sa.recs.size,
        nodesB: sb.recs.size,
        addedNodes: report.addedNodes.length,
        removedNodes: report.removedNodes.length,
        renamed: report.renamed.length,
        reordered: report.reordered.length,
        addedComps: report.addedComps.length,
        removedComps: report.removedComps.length,
        changedNodes,
        realChanges: report.realCount,
        noiseChanges: report.noiseCount,
        ms: { parse: tParse, index: tIndex, diff: tDiff, total: Date.now() - t0 },
    };

    if (opts.json) {
        process.stdout.write(`${JSON.stringify({
            ok: true,
            a: { label: aLabel, bytes: aSrc.bytes, nodes: sa.recs.size, noFileId: sa.noFid },
            b: { label: relLabel(bAbs), bytes: bSrc.bytes, nodes: sb.recs.size, noFileId: sb.noFid },
            summary,
            addedNodes: report.addedNodes,
            removedNodes: report.removedNodes,
            renamed: report.renamed,
            reordered: report.reordered,
            addedComps: report.addedComps,
            removedComps: report.removedComps,
            fields: report.fields,
        }, null, 2)}\n`);
    }

    const head = [
        '',
        'prefab 语义 diff',
        `  旧   ${aLabel}（${(aSrc.bytes / 1024).toFixed(0)} KB · ${sa.recs.size} 个节点）`,
        `  新   ${relLabel(bAbs)}（${(bSrc.bytes / 1024).toFixed(0)} KB · ${sb.recs.size} 个节点）`,
        `  身份 ${identityLabel}`,
        `  汇总 节点 ${summary.nodesA} → ${summary.nodesB} · 新增 ${summary.addedNodes} · 删除 ${summary.removedNodes}`
            + ` · 改名 ${summary.renamed} · 有改动的节点 ${summary.changedNodes}`,
        `  判据 实质改动 ${summary.realChanges} 处 · 噪声（浮点尾数/运行时 id）${summary.noiseChanges} 处`
            + '   （@ = 节点 · # = 组件等非节点对象 · @./x = 相对本节点）',
        `  耗时 parse ${summary.ms.parse}ms · 索引/签名 ${summary.ms.index}ms · 比对 ${summary.ms.diff}ms · 合计 ${summary.ms.total}ms`,
    ].join('\n');

    const body = render(report, opts);
    const sink = opts.json ? process.stderr : process.stdout;
    let hint = '';
    if (opts.pathFilter) {
        const hit = [...sa.recs.values(), ...sb.recs.values()]
            .filter((r) => r.path.split('/').some((_s, i, all) => {
                const segs = opts.pathFilter.split('/');
                return all.slice(i, i + segs.length).join('/') === opts.pathFilter;
            })).length;
        if (!hit) hint = `\n⚠ --path ${opts.pathFilter} 一个节点都没命中（按路径段匹配，试试更短的一段）\n`;
    }
    sink.write(`${head}\n${body}${hint}`);

    if (opts.gate && summary.realChanges > opts.allow) {
        sink.write(`✖ --gate：实质改动 ${summary.realChanges} 处 > 允许的 ${opts.allow} 处\n`);
        process.exit(1);
    }
    process.exit(0);
}

main();
