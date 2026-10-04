"use strict";
/**
 * Recipe store —— 「可执行资产」的持久化层。
 *
 * ## 为什么存的是「代码」而不是「知识」
 *
 * 本插件**刻意不做一个「工程知识库」**。对照调研过的同类项目（RomaRogov/cocos-code-mode、
 * shinjiyu/CocosMetaMCP、UTCP code-mode），它们的共识是：
 *
 * | 知识类型 | 归宿 | 判据 |
 * |---|---|---|
 * | 引擎 API 长什么样 | **不存**，运行时反射（`describe_api`） | 存了必然过期，且随时可查 |
 * | 工程专有流程/坑点 | 工程里的 Markdown（`.agents/skills/`） | 需要人策展、能 review、能 diff |
 * | **跑通了的代码** | **本模块的 recipe** | 文件本身不可执行，插件能执行 |
 *
 * 「文件存事实」有个致命弱点：**过期的事实比没有事实更糟**。而「文件存代码」不会 ——
 * 代码过期了会当场报错，不会悄悄给出错误结论。所以这里只存代码，不存结论。
 *
 * ## 格式：一个文件一条 recipe，元数据内嵌
 *
 * ```
 * /* @dsh-recipe
 * { "name": "...", "description": "...", "context": "editor" }
 * *\/
 * <与 execute_code 里一模一样的代码>
 * ```
 *
 * - **单文件**：git 里一眼看得见，不会出现「.js 和 .json 漂移」；
 * - **代码体就是 `execute_code` 的 body**：顶层可 `return` / `await`，`args` 是入参 ——
 *   于是 recipe 与一次成功的探索之间是**复制粘贴**的关系，零心智负担。
 * - **不是跑通了就能存**：`saveRecipe` 过 {@link checkRecipeReusability} 门禁 ——
 *   只收「以后还能再用一次」的代码（有 description/returns、参数真的被用上、无一次性 uuid/绝对路径）。
 *
 * ## 本模块是纯 Node，不 import Editor
 *
 * 因为它要**同时被两个进程加载**：
 * - 主进程（`dist/core/engine.js`）—— 正常 `import`；
 * - **引擎场景进程**（`dist/scene.js`）—— 场景脚本的 `__dirname` 是
 *   `electron.asar/renderer`，相对 require 不通，只能靠
 *   `Editor.Package.getPath('dsh_chat')` 拿到扩展根，再按**绝对路径** require
 *   （实测可行）。
 *
 * 所以这里只接受显式传入的 `projectPath`，绝不自己去问 `Editor.*`。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECIPE_HELPER_SIGNATURES = exports.RECIPE_EXT = exports.RECIPE_SUBDIR = exports.RECIPE_DIR_NAME = void 0;
exports.recipesRoot = recipesRoot;
exports.normalizeRecipeName = normalizeRecipeName;
exports.recipeFile = recipeFile;
exports.parseRecipe = parseRecipe;
exports.formatRecipe = formatRecipe;
exports.normalizeRecipeMeta = normalizeRecipeMeta;
exports.listRecipeRecords = listRecipeRecords;
exports.readRecipeRecord = readRecipeRecord;
exports.writeRecipeRecord = writeRecipeRecord;
exports.deleteRecipeRecord = deleteRecipeRecord;
exports.touchRecipeVerified = touchRecipeVerified;
exports.daysSinceVerified = daysSinceVerified;
exports.contextMatches = contextMatches;
exports.checkRecipeReusability = checkRecipeReusability;
exports.buildRecipeHelpers = buildRecipeHelpers;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** 工程根下的存放目录（可入库；不写进 .gitignore 是有意的） */
exports.RECIPE_DIR_NAME = '.dsh-mcp';
/** 存放目录下的子目录名 */
exports.RECIPE_SUBDIR = 'recipes';
/** recipe 文件扩展名 */
exports.RECIPE_EXT = '.js';
/** 元数据块标记 */
const MARKER = '@dsh-recipe';
/** recipe 根目录（不保证存在） */
function recipesRoot(projectPath) {
    return path.join(projectPath, exports.RECIPE_DIR_NAME, exports.RECIPE_SUBDIR);
}
/**
 * 把用户给的 recipe 名规范化成安全文件名。
 *
 * 只放行 `[A-Za-z0-9._-]`：名字要跨平台、要能直接当文件名，
 * 而且**必须挡住路径穿越**（`../../foo` 会写到工程外面去）。
 */
function normalizeRecipeName(raw) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name)
        throw new Error('recipe 名不能为空');
    if (name.length > 80)
        throw new Error(`recipe 名过长（${name.length} > 80）：${name}`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`recipe 名只允许字母/数字/点/下划线/连字符，收到：${name}（提示：用 kebab-case，如 create-2d-scene）`);
    }
    // `.` 与 `..` 单独成名的路径穿越
    if (name === '.' || name === '..')
        throw new Error(`recipe 名非法：${name}`);
    return name;
}
/** recipe 文件绝对路径 */
function recipeFile(projectPath, name) {
    return path.join(recipesRoot(projectPath), `${normalizeRecipeName(name)}${exports.RECIPE_EXT}`);
}
/**
 * 解析 recipe 源码 → 元数据 + 代码体。
 *
 * 刻意写得「坏输入不抛异常」：读到一个手写坏的 recipe 不应该让整次 `findRecipes` 崩掉，
 * 而是让它以「无元数据」的姿态出现在列表里，模型自己决定要不要打开看。
 */
function parseRecipe(source) {
    const text = typeof source === 'string' ? source : '';
    const fallback = { meta: { name: '' }, code: text };
    const markerAt = text.indexOf(MARKER);
    if (markerAt < 0)
        return fallback;
    const blockStart = text.indexOf('/*', markerAt >= 3 ? markerAt - 3 : 0);
    if (blockStart < 0)
        return fallback;
    const blockEnd = text.indexOf('*/', markerAt);
    if (blockEnd < 0)
        return fallback;
    const jsonText = text.slice(markerAt + MARKER.length, blockEnd).trim();
    let meta;
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return fallback;
        meta = parsed;
    }
    catch {
        return fallback;
    }
    // 代码体 = 元数据块之后的所有内容（去掉紧随其后的一个换行，让行号从 1 开始像用户写的那样）
    let code = text.slice(blockEnd + 2);
    if (code.startsWith('\r\n'))
        code = code.slice(2);
    else if (code.startsWith('\n'))
        code = code.slice(1);
    return { meta, code };
}
/** 组装 recipe 文件内容（元数据块 + 代码体） */
function formatRecipe(name, code, meta = {}) {
    const normalized = { ...meta, name };
    // 固定 key 顺序，让 git diff 稳定（不然每次保存字段顺序都可能变）
    const ordered = { name: normalized.name };
    for (const key of ['description', 'context', 'params', 'returns', 'createdAt', 'verifiedAt']) {
        const value = normalized[key];
        if (value !== undefined && value !== null && value !== '')
            ordered[key] = value;
    }
    const body = code.endsWith('\n') ? code : `${code}\n`;
    return `/* ${MARKER}\n${JSON.stringify(ordered, null, 2)}\n*/\n${body}`;
}
/** 把参数说明归一化成 `{字段名: 说明}`（接受数组或对象两种写法） */
function normalizeParams(raw) {
    if (!raw)
        return undefined;
    if (Array.isArray(raw)) {
        const out = {};
        for (const item of raw) {
            if (typeof item === 'string' && item.trim())
                out[item.trim()] = '';
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    if (typeof raw === 'object') {
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            out[key] = typeof value === 'string' ? value : String(value !== null && value !== void 0 ? value : '');
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    return undefined;
}
/** 规范化调用方给的元数据（保存路径与解析路径共用，保证两侧口径一致） */
function normalizeRecipeMeta(raw, fallbackName) {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const meta = {
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallbackName || '',
    };
    if (typeof input.description === 'string' && input.description.trim()) {
        meta.description = input.description.trim();
    }
    const params = normalizeParams(input.params);
    if (params)
        meta.params = params;
    if (input.context === 'editor' || input.context === 'scene' || input.context === 'any') {
        meta.context = input.context;
    }
    if (typeof input.returns === 'string' && input.returns.trim())
        meta.returns = input.returns.trim();
    if (typeof input.createdAt === 'string' && input.createdAt)
        meta.createdAt = input.createdAt;
    if (typeof input.verifiedAt === 'string' && input.verifiedAt)
        meta.verifiedAt = input.verifiedAt;
    return meta;
}
/**
 * 列出全部 recipe。
 *
 * 目录不存在 → 空数组（**不是异常**）：第一次用的人不该看到一条报错。
 * 坏文件 → 以无元数据的形态列出，而不是整个列表失败。
 */
function listRecipeRecords(projectPath) {
    const root = recipesRoot(projectPath);
    let entries;
    try {
        entries = fs.readdirSync(root);
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries.sort()) {
        if (!entry.toLowerCase().endsWith(exports.RECIPE_EXT))
            continue;
        const file = path.join(root, entry);
        let stat;
        try {
            stat = fs.statSync(file);
        }
        catch {
            continue;
        }
        if (!stat.isFile())
            continue;
        const fallbackName = entry.slice(0, -exports.RECIPE_EXT.length);
        let raw = '';
        try {
            raw = fs.readFileSync(file, 'utf-8');
        }
        catch {
            continue;
        }
        const parsed = parseRecipe(raw);
        const meta = normalizeRecipeMeta(parsed.meta, fallbackName);
        if (!meta.name)
            meta.name = fallbackName;
        out.push({ name: meta.name, meta, code: parsed.code, file, bytes: stat.size });
    }
    return out;
}
/** 读单条 recipe；不存在返回 null */
function readRecipeRecord(projectPath, name) {
    const file = recipeFile(projectPath, name);
    let raw;
    let bytes = 0;
    try {
        raw = fs.readFileSync(file, 'utf-8');
        bytes = fs.statSync(file).size;
    }
    catch {
        return null;
    }
    const parsed = parseRecipe(raw);
    const meta = normalizeRecipeMeta(parsed.meta, normalizeRecipeName(name));
    if (!meta.name)
        meta.name = normalizeRecipeName(name);
    return { name: meta.name, meta, code: parsed.code, file, bytes };
}
/**
 * 落盘一条 recipe（幂等覆盖）。
 *
 * `createdAt` 在**已存在**时沿用旧值 —— 否则每次保存都刷新「创建时间」，
 * 那个字段就没意义了。`verifiedAt` 同理沿用（由 {@link touchRecipeVerified} 单独推进）。
 */
function writeRecipeRecord(projectPath, name, code, meta = {}) {
    const safeName = normalizeRecipeName(name);
    if (typeof code !== 'string' || !code.trim()) {
        throw new Error('recipe 代码不能为空');
    }
    const root = recipesRoot(projectPath);
    fs.mkdirSync(root, { recursive: true });
    const previous = readRecipeRecord(projectPath, safeName);
    const now = new Date().toISOString();
    const normalized = normalizeRecipeMeta(meta, safeName);
    normalized.name = safeName;
    normalized.createdAt = (previous === null || previous === void 0 ? void 0 : previous.meta.createdAt) || normalized.createdAt || now;
    if (previous === null || previous === void 0 ? void 0 : previous.meta.verifiedAt)
        normalized.verifiedAt = normalized.verifiedAt || previous.meta.verifiedAt;
    const text = formatRecipe(safeName, code, normalized);
    const file = recipeFile(projectPath, safeName);
    fs.writeFileSync(file, text, 'utf-8');
    const bytes = Buffer.byteLength(text, 'utf-8');
    // 目录里放一份说明，免得人类看到 `.dsh-mcp/` 不知道这是什么、该不该入库
    const readme = path.join(path.dirname(root), 'README.md');
    if (!fs.existsSync(readme)) {
        try {
            fs.writeFileSync(readme, RECIPE_README, 'utf-8');
        }
        catch {
            /* 说明文件写不进去不影响主流程 */
        }
    }
    return {
        name: safeName,
        meta: normalizeRecipeMeta(parseRecipe(text).meta, safeName),
        code,
        file,
        bytes,
    };
}
/** 删一条 recipe；返回是否真的删掉了 */
function deleteRecipeRecord(projectPath, name) {
    const file = recipeFile(projectPath, name);
    try {
        fs.unlinkSync(file);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 记一次「这条 recipe 刚刚跑通了」。
 *
 * **每天最多写一次盘**：跑一次就写一次会让 git 天天噪声，
 * 而 `verifiedAt` 的精度本来也只用来判断「是不是几个月没动过了」。
 *
 * @returns 本次是否真的更新了（没更新就返回 null）
 */
function touchRecipeVerified(projectPath, name) {
    let record;
    try {
        record = readRecipeRecord(projectPath, name);
    }
    catch {
        return null;
    }
    if (!record)
        return null;
    const now = new Date();
    const previous = record.meta.verifiedAt ? new Date(record.meta.verifiedAt) : null;
    const sameDay = previous instanceof Date &&
        !Number.isNaN(previous.getTime()) &&
        previous.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    if (sameDay)
        return null;
    const iso = now.toISOString();
    try {
        const text = formatRecipe(record.name, record.code, { ...record.meta, verifiedAt: iso });
        fs.writeFileSync(record.file, text, 'utf-8');
    }
    catch {
        return null;
    }
    return iso;
}
/** 距离上次验证过了多少天（没验证过返回 null） */
function daysSinceVerified(meta, now = Date.now()) {
    if (!meta.verifiedAt)
        return null;
    const at = new Date(meta.verifiedAt).getTime();
    if (Number.isNaN(at))
        return null;
    return Math.max(0, Math.floor((now - at) / 86400000));
}
/** `context` 与当前执行上下文是否相容 */
function contextMatches(meta, current) {
    const want = meta.context;
    if (!want || want === 'any')
        return true;
    return want === current;
}
// ---------------------------------------------------------------------------
// 复用门禁 —— 「跑通了」不等于「值得存」
// ---------------------------------------------------------------------------
/**
 * 一次性标识的判据。
 *
 * 这些值**只对某一次执行成立**（某个节点的 uuid、某台机器上的绝对路径），
 * 存进 recipe 就等于存了一段以后跑不通的代码。它们都该走 `args`。
 */
const ONE_OFF_PATTERNS = [
    {
        id: 'uuid',
        re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
        hint: '把 uuid 变成入参：代码里写 args.uuid，并在 meta.params.uuid 里说明它是什么节点',
    },
    {
        id: 'abs-path',
        re: /(?:[A-Za-z]:[\\/][^'"`\s]|\/(?:Users|home)\/[^'"`\s])/,
        hint: '把绝对路径变成入参（args.dir / args.file），或改用 projectPath() 拼相对路径',
    },
    {
        id: 'temp-path',
        re: /[\\/]\.tmp[\\/]/,
        hint: '别把临时目录写进 recipe（.tmp/ 是一次性产物）',
    },
];
/**
 * 复用门禁：**只有「以后还能再用一次」的代码才许存成 recipe**。
 *
 * 「跑通了」只是必要条件。判据全部可机检，不靠自觉：
 *
 * | 判据 | 规则 | 为什么 |
 * |---|---|---|
 * | 有契约 | `description`（≥8 字）+ `returns`（≥4 字）必填 | 它们同时是 `findRecipes` 的检索文本 —— 没契约的 recipe 等于没索引的代码 |
 * | 有入口 | `params` 里声明的每个键，代码里必须真的出现 `args.<键>` | 声明了却不用 = 抄下来的是一次探索，不是一个函数 |
 * | 无一次性值 | 代码里不许有具体 uuid / 绝对路径 / `.tmp/` | 这类值只对那一次成立，别人（或下一局）跑必然失败 |
 * | 名字可复用 | 名字里不许带日期/时间戳 | `xxx-2026-09-30` 是快照，不是资产 |
 *
 * 没有参数只是**警告**（纯查询类确实可以无参），不拒绝 —— 但会提示「确认它真能复用」。
 *
 * 反例（会被拒）：`return nodeByUuid('3d901b39-…').name` —— 具体 uuid 写死，
 * 以后那个节点一换就废；正解是 `args.uuid` + `meta.params.uuid`。
 */
function checkRecipeReusability(name, code, meta) {
    const problems = [];
    const warnings = [];
    const description = typeof meta.description === 'string' ? meta.description.trim() : '';
    if (description.length < 8) {
        problems.push({
            id: 'no-description',
            message: '缺少 description（≥8 字，说清这段代码干什么）',
            hint: 'meta={description:"把 X 里符合 Y 的节点列出来并返回摘要"}',
        });
    }
    const returns = typeof meta.returns === 'string' ? meta.returns.trim() : '';
    if (returns.length < 4) {
        problems.push({
            id: 'no-returns',
            message: '缺少 returns（≥4 字，说清以后复用它能看到什么）',
            hint: 'meta={returns:"{count, sample:[名字]}"}',
        });
    }
    if (/(?:\d{4}-\d{2}-\d{2}|\d{8})/.test(name)) {
        problems.push({
            id: 'dated-name',
            message: `名字 "${name}" 带日期/时间戳`,
            hint: '名字要能被以后复用（如 create-2d-scene）；一次性的时间点写进 meta.description 里',
        });
    }
    for (const pattern of ONE_OFF_PATTERNS) {
        if (pattern.re.test(code)) {
            problems.push({
                id: pattern.id,
                message: `代码里有一次性值（${pattern.id}）`,
                hint: pattern.hint,
            });
        }
    }
    const params = meta.params && typeof meta.params === 'object' ? Object.entries(meta.params) : [];
    if (params.length === 0) {
        warnings.push('没有声明任何参数：只能原样重跑。如果它确实每次都一样（纯查询），可以不管；' +
            '否则把会变的部分提成 args 再存。');
    }
    else {
        for (const [key, text] of params) {
            if (!key)
                continue;
            const used = code.includes(`args.${key}`) || code.includes(`args['${key}']`) || code.includes(`args["${key}"]`);
            if (!used) {
                problems.push({
                    id: 'param-unused',
                    message: `声明了参数 "${key}"，但代码里没有用到 args.${key}`,
                    hint: `要么在代码里用上它，要么把它从 params 里删掉（params 就是这段代码的复用点）`,
                });
            }
            if (typeof text !== 'string' || !text.trim()) {
                problems.push({
                    id: 'param-undocumented',
                    message: `参数 "${key}" 没有说明`,
                    hint: 'params 的值是一句话说明，如 { uuid: "要查的节点 uuid" }',
                });
            }
        }
    }
    return { ok: problems.length === 0, problems, warnings };
}
/** 列表最多回这么多条，避免把上下文灌满 */
const LIST_LIMIT = 40;
/** recipe 互相调用的最大深度（允许组合，但不允许跑飞） */
const MAX_RECIPE_DEPTH = 4;
function errorOf(err) {
    if (err && typeof err === 'object') {
        const message = err.message;
        if (typeof message === 'string' && message)
            return message;
    }
    return String(err);
}
/**
 * 构造注入沙箱的 recipe 助手。
 *
 * 五个助手覆盖「查 → 读 → 存 → 跑 → 删」一个闭环：
 *
 * | 助手 | 作用 | 对应的调研结论 |
 * |---|---|---|
 * | `findRecipes(kw?)` | **只回索引**：名字/说明/参数/新鲜度 | Anthropic 的 progressive disclosure：先给索引，别给内容 |
 * | `readRecipe(name)` | 按需取回源码，供模型改写复用 | cocos-code-mode 的「工程根 .d.ts 草稿板」 |
 * | `saveRecipe(...)` | 把跑通的代码固化下来 | Anthropic「把代码存成可复用函数」 |
 * | `runRecipe(name,args)` | 直接执行 | CocosMetaMCP 的 L1 Recipe（单参数、幂等） |
 * | `deleteRecipe(name)` | 清理 | —— |
 *
 * ⚠ 这五个**不是 MCP tool**，`tools/list` 只有四个（三个通用 + `capture_view`）。
 */
function buildRecipeHelpers(options) {
    const projectPath = options.projectPath;
    const context = options.context;
    const state = { depth: 0 };
    const helpers = {};
    /** 统一的「参数不合法」返回，顺便把正确用法回给模型 */
    const invalidName = (err) => ({
        ok: false,
        error: errorOf(err),
        hint: '名字用 kebab-case（如 create-2d-scene），只允许字母/数字/点/下划线/连字符。',
    });
    helpers.findRecipes = (keyword) => {
        let records;
        try {
            records = listRecipeRecords(projectPath);
        }
        catch (err) {
            return { ok: false, error: errorOf(err) };
        }
        const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
        const matched = needle
            ? records.filter((record) => {
                const meta = record.meta;
                const haystack = [
                    record.name,
                    meta.description,
                    meta.returns,
                    meta.context,
                    ...Object.keys(meta.params || {}),
                    ...Object.values(meta.params || {}),
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                return haystack.includes(needle);
            })
            : records;
        const items = matched.slice(0, LIST_LIMIT).map((record) => {
            const days = daysSinceVerified(record.meta);
            return {
                name: record.name,
                description: record.meta.description || undefined,
                context: record.meta.context || 'any',
                params: record.meta.params || undefined,
                returns: record.meta.returns || undefined,
                verifiedAt: record.meta.verifiedAt || undefined,
                /** 距上次跑通多少天 —— 判断「还能不能信」的唯一依据 */
                daysSinceVerified: days === null ? undefined : days,
                bytes: record.bytes,
            };
        });
        const notes = [];
        if (needle && matched.length === 0 && records.length > 0) {
            notes.push(`没有匹配 "${needle}" 的 recipe；现有 ${records.length} 条，去掉关键词可看全部。`);
        }
        if (matched.length > LIST_LIMIT) {
            notes.push(`共 ${matched.length} 条，只回前 ${LIST_LIMIT} 条。`);
        }
        const stale = items.filter((item) => { var _a; return ((_a = item.daysSinceVerified) !== null && _a !== void 0 ? _a : 0) > 30; });
        if (stale.length > 0) {
            notes.push(`${stale.length} 条超过 30 天没跑通（见 daysSinceVerified）——跑之前先 readRecipe 看一眼，` +
                '过期的 path/API 比没有 recipe 更坑。');
        }
        return {
            ok: true,
            /** 目录是本次执行时新建/已存在的，模型不需要关心 */
            dir: recipesRoot(projectPath),
            total: records.length,
            count: matched.length,
            recipes: items,
            ...(notes.length > 0 ? { notes } : {}),
            ...(records.length === 0
                ? {
                    hint: '还没有 recipe。跑通一段好用的代码后，用 ' +
                        'saveRecipe("kebab-case-名字", <同一段代码>, {description:"…", params:{…}, context:"' +
                        context +
                        '", returns:"…"}) 把它固化下来。',
                }
                : {}),
        };
    };
    helpers.readRecipe = (name) => {
        let record;
        try {
            record = readRecipeRecord(projectPath, String(name));
        }
        catch (err) {
            return invalidName(err);
        }
        if (!record) {
            return {
                ok: false,
                error: `没有名为 "${String(name)}" 的 recipe`,
                hint: '先用 findRecipes() 看有哪些。',
            };
        }
        return {
            ok: true,
            name: record.name,
            meta: record.meta,
            file: record.file,
            bytes: record.bytes,
            /** 与 execute_code 同构，可直接改写后当作本次执行的代码 */
            code: record.code,
        };
    };
    helpers.saveRecipe = (name, code, meta) => {
        if (typeof code !== 'string' || !code.trim()) {
            return { ok: false, error: 'code 不能为空' };
        }
        const rawName = typeof name === 'string' ? name : String(name !== null && name !== void 0 ? name : '');
        let normalized;
        try {
            normalized = normalizeRecipeMeta(meta, rawName.trim());
        }
        catch (err) {
            return invalidName(err);
        }
        /**
         * **复用门禁**：跑通了不等于值得存。
         *
         * 这里拒掉的是「一次探索的记录」——它们留在对话/返回值里就够了，落盘只会
         * 让 `findRecipes` 里多一条以后跑不通的噪声（过期的代码比没有代码更坑）。
         */
        const gate = checkRecipeReusability(rawName.trim(), code, normalized);
        if (!gate.ok) {
            return {
                ok: false,
                error: `这段代码还不适合存成 recipe：${gate.problems.map((p) => p.message).join('；')}`,
                problems: gate.problems,
                hint: 'recipe 只存「以后还能再用一次」的代码：把会变的部分提成 args，写清 description 与 returns；' +
                    '只对这一次成立的结果，直接 return 出来就好，不用落盘。',
            };
        }
        let record;
        let overwritten = false;
        try {
            const safe = normalizeRecipeName(rawName);
            // 先探一下是否已存在 —— 覆盖别人的 recipe 是件该被知道的事
            overwritten = fs.existsSync(recipeFile(projectPath, safe));
            // 没写 context 就记成当前上下文 —— 这是最有用的默认值
            if (!normalized.context)
                normalized.context = context;
            record = writeRecipeRecord(projectPath, safe, code, normalized);
        }
        catch (err) {
            return invalidName(err);
        }
        return {
            ok: true,
            name: record.name,
            overwritten,
            file: record.file,
            bytes: record.bytes,
            meta: record.meta,
            ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
            hint: `以后可以 runRecipe("${record.name}", args) 直接跑。`,
        };
    };
    helpers.runRecipe = async (name, recipeArgs, opts) => {
        var _a, _b;
        let record;
        try {
            record = readRecipeRecord(projectPath, String(name));
        }
        catch (err) {
            return invalidName(err);
        }
        if (!record) {
            return {
                ok: false,
                error: `没有名为 "${String(name)}" 的 recipe`,
                hint: '先用 findRecipes() 看有哪些。',
            };
        }
        if (!record.code.trim()) {
            return { ok: false, error: `recipe "${record.name}" 的代码体是空的` };
        }
        if (!contextMatches(record.meta, context)) {
            return {
                ok: false,
                error: `recipe "${record.name}" 声明 context="${record.meta.context}"，` +
                    `但当前执行上下文是 "${context}"。`,
                hint: `把这次 execute_code 的 context 改成 "${record.meta.context}" 再跑。`,
            };
        }
        if (state.depth >= MAX_RECIPE_DEPTH) {
            return {
                ok: false,
                error: `recipe 嵌套过深（>${MAX_RECIPE_DEPTH}）：${record.name}`,
                hint: '检查是不是有循环引用（A 调 B、B 又调 A）。',
            };
        }
        const timeoutMs = typeof (opts === null || opts === void 0 ? void 0 : opts.timeoutMs) === 'number' && opts.timeoutMs > 0
            ? Math.min(opts.timeoutMs, 600000)
            : (_a = options.defaultTimeoutMs) !== null && _a !== void 0 ? _a : 15000;
        // 用 Object.create(null) 做入参容器：recipe 里写 args.hasOwnProperty 之类的
        // 不会撞上 Object.prototype（沙箱里我们本来就给的是净化过的对象）。
        const callArgs = {};
        if (recipeArgs && typeof recipeArgs === 'object' && !Array.isArray(recipeArgs)) {
            for (const [key, value] of Object.entries(recipeArgs)) {
                callArgs[key] = value;
            }
        }
        else if (recipeArgs !== undefined && recipeArgs !== null) {
            callArgs.value = recipeArgs;
        }
        const startedAt = Date.now();
        state.depth += 1;
        try {
            const outcome = await options.getRunner()(record.code, callArgs, timeoutMs);
            const durationMs = (_b = outcome.durationMs) !== null && _b !== void 0 ? _b : Date.now() - startedAt;
            if (!outcome.ok) {
                return {
                    ok: false,
                    recipe: record.name,
                    context,
                    durationMs,
                    error: outcome.error,
                    ...(outcome.timedOut ? { timedOut: true } : {}),
                    ...(outcome.logs ? { logs: outcome.logs } : {}),
                    hint: `recipe "${record.name}" 执行失败。用 readRecipe("${record.name}") 看它的代码，或直接改它。`,
                };
            }
            const verifiedAt = touchRecipeVerified(projectPath, record.name);
            return {
                ok: true,
                recipe: record.name,
                context,
                durationMs,
                result: outcome.result,
                ...(outcome.logs ? { logs: outcome.logs } : {}),
                ...(verifiedAt ? { verifiedAt } : {}),
            };
        }
        catch (err) {
            return { ok: false, recipe: record.name, error: errorOf(err) };
        }
        finally {
            state.depth -= 1;
        }
    };
    helpers.deleteRecipe = (name) => {
        try {
            const removed = deleteRecipeRecord(projectPath, String(name));
            return removed
                ? { ok: true, name: String(name), deleted: true }
                : { ok: false, name: String(name), deleted: false, error: '文件不存在' };
        }
        catch (err) {
            return invalidName(err);
        }
    };
    return { helpers, state };
}
/** `describe_api` 与 `helperNames()` 共用的助手签名清单 */
exports.RECIPE_HELPER_SIGNATURES = [
    'findRecipes(keyword?) → {count, recipes:[{name, description, context, params, returns, daysSinceVerified}]}',
    'readRecipe(name) → {meta, code}  // 想改写复用就先读出来',
    'saveRecipe(name, code, meta?) → {file, overwritten, warnings?}  // meta={description, params, context, returns}；**过不了复用门禁会被拒**（要参数化、无一次性值）',
    'runRecipe(name, args?, {timeoutMs}?) → {result, logs, durationMs}',
    'deleteRecipe(name) → {deleted}',
];
const RECIPE_README = `# .dsh-mcp —— dsh_chat 的 recipe 存放处

这里存的是**跑通过、且以后还能再用一次的可执行代码**（recipe），不是文档。

- 每条 recipe 一个 \`.js\` 文件，元数据内嵌在文件头的 \`/* @dsh-recipe {…} */\` 里。
- 代码体与 \`cocos_execute_code\` 里写的代码**完全同构**：顶层可 \`return\` / \`await\`，\`args\` 是入参。
- AI 侧入口（都是沙箱里的助手，不是独立工具）：
  \`findRecipes(关键词?)\` / \`readRecipe(name)\` / \`saveRecipe(name, code, meta?)\` /
  \`runRecipe(name, args?)\` / \`deleteRecipe(name)\`。

## 存进来的门槛（复用门禁）

\`saveRecipe\` 会**拒绝**「一次探索的记录」，只收「以后还能再用一次」的代码：

- 必填 \`description\`（这段代码干什么）与 \`returns\`（复用它能看到什么）；
- \`params\` 声明的每个键，代码里必须真的用到 \`args.<键>\`；
- 代码里不许有具体 uuid、绝对路径、\`.tmp/\` 这类一次性值（应当走 \`args\`）；
- 名字里不许带日期/时间戳。

**建议入库**（跟着工程走，团队共享）。不想共享就把它加进 \`.gitignore\`。

为什么不做一个「工程知识库 JSON」：过期的事实比没有事实更糟，而过期的代码会当场报错。
工程专有的流程与坑点请写进 \`.agents/skills/\`，那里人能策展、能 review。
`;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVjaXBlcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9jb3JlL3JlY2lwZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EwQ0c7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQWdESCxrQ0FFQztBQVFELGtEQVlDO0FBR0QsZ0NBRUM7QUFRRCxrQ0EyQkM7QUFHRCxvQ0FVQztBQXVCRCxrREFpQkM7QUFRRCw4Q0FrQ0M7QUFHRCw0Q0FjQztBQVFELDhDQTBDQztBQUdELGdEQVFDO0FBVUQsa0RBeUJDO0FBR0QsOENBS0M7QUFHRCx3Q0FJQztBQXNERCx3REF3RUM7QUFxRUQsZ0RBcVJDO0FBbnlCRCx1Q0FBeUI7QUFDekIsMkNBQTZCO0FBRTdCLHlDQUF5QztBQUM1QixRQUFBLGVBQWUsR0FBRyxVQUFVLENBQUM7QUFFMUMsaUJBQWlCO0FBQ0osUUFBQSxhQUFhLEdBQUcsU0FBUyxDQUFDO0FBRXZDLG1CQUFtQjtBQUNOLFFBQUEsVUFBVSxHQUFHLEtBQUssQ0FBQztBQUVoQyxhQUFhO0FBQ2IsTUFBTSxNQUFNLEdBQUcsYUFBYSxDQUFDO0FBZ0M3Qix3QkFBd0I7QUFDeEIsU0FBZ0IsV0FBVyxDQUFDLFdBQW1CO0lBQzNDLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsdUJBQWUsRUFBRSxxQkFBYSxDQUFDLENBQUM7QUFDbEUsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsU0FBZ0IsbUJBQW1CLENBQUMsR0FBWTtJQUM1QyxNQUFNLElBQUksR0FBRyxPQUFPLEdBQUcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3ZELElBQUksQ0FBQyxJQUFJO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FB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QU0sRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNuRSxDQUFDO2dCQUFTLENBQUM7WUFDUCxLQUFLLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQztRQUNyQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsT0FBTyxDQUFDLFlBQVksR0FBRyxDQUFDLElBQWEsRUFBMkIsRUFBRTtRQUM5RCxJQUFJLENBQUM7WUFDRCxNQUFNLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDOUQsT0FBTyxPQUFPO2dCQUNWLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFO2dCQUNqRCxDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLENBQUM7UUFDNUUsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDWCxPQUFPLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM1QixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztBQUM5QixDQUFDO0FBRUQsaURBQWlEO0FBQ3BDLFFBQUEsd0JBQXdCLEdBQTBCO0lBQzNELDZHQUE2RztJQUM3RyxnREFBZ0Q7SUFDaEQsNElBQTRJO0lBQzVJLG1FQUFtRTtJQUNuRSxnQ0FBZ0M7Q0FDbkMsQ0FBQztBQUVGLE1BQU0sYUFBYSxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCckIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVjaXBlIHN0b3JlIOKAlOKAlCDjgIzlj6/miafooYzotYTkuqfjgI3nmoTmjIHkuYXljJblsYLjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjlrZjnmoTmmK/jgIzku6PnoIHjgI3ogIzkuI3mmK/jgIznn6Xor4bjgI1cbiAqXG4gKiDmnKzmj5Lku7YqKuWIu+aEj+S4jeWBmuS4gOS4quOAjOW3peeoi+efpeivhuW6k+OAjSoq44CC5a+554Wn6LCD56CU6L+H55qE5ZCM57G76aG555uu77yIUm9tYVJvZ292L2NvY29zLWNvZGUtbW9kZeOAgVxuICogc2hpbmppeXUvQ29jb3NNZXRhTUNQ44CBVVRDUCBjb2RlLW1vZGXvvInvvIzlroPku6znmoTlhbHor4bmmK/vvJpcbiAqXG4gKiB8IOefpeivhuexu+WeiyB8IOW9kuWuvyB8IOWIpOaNriB8XG4gKiB8LS0tfC0tLXwtLS18XG4gKiB8IOW8leaTjiBBUEkg6ZW/5LuA5LmI5qC3IHwgKirkuI3lrZgqKu+8jOi/kOihjOaXtuWPjeWwhO+8iGBkZXNjcmliZV9hcGlg77yJIHwg5a2Y5LqG5b+F54S26L+H5pyf77yM5LiU6ZqP5pe25Y+v5p+lIHxcbiAqIHwg5bel56iL5LiT5pyJ5rWB56iLL+WdkeeCuSB8IOW3peeoi+mHjOeahCBNYXJrZG93bu+8iGAuYWdlbnRzL3NraWxscy9g77yJIHwg6ZyA6KaB5Lq6562W5bGV44CB6IO9IHJldmlld+OAgeiDvSBkaWZmIHxcbiAqIHwgKirot5HpgJrkuobnmoTku6PnoIEqKiB8ICoq5pys5qih5Z2X55qEIHJlY2lwZSoqIHwg5paH5Lu25pys6Lqr5LiN5Y+v5omn6KGM77yM5o+S5Lu26IO95omn6KGMIHxcbiAqXG4gKiDjgIzmlofku7blrZjkuovlrp7jgI3mnInkuKroh7Tlkb3lvLHngrnvvJoqKui/h+acn+eahOS6i+WunuavlOayoeacieS6i+WunuabtOeznyoq44CC6ICM44CM5paH5Lu25a2Y5Luj56CB44CN5LiN5LyaIOKAlOKAlFxuICog5Luj56CB6L+H5pyf5LqG5Lya5b2T5Zy65oql6ZSZ77yM5LiN5Lya5oKE5oKE57uZ5Ye66ZSZ6K+v57uT6K6644CC5omA5Lul6L+Z6YeM5Y+q5a2Y5Luj56CB77yM5LiN5a2Y57uT6K6644CCXG4gKlxuICogIyMg5qC85byP77ya5LiA5Liq5paH5Lu25LiA5p2hIHJlY2lwZe+8jOWFg+aVsOaNruWGheW1jFxuICpcbiAqIGBgYFxuICogLyogQGRzaC1yZWNpcGVcbiAqIHsgXCJuYW1lXCI6IFwiLi4uXCIsIFwiZGVzY3JpcHRpb25cIjogXCIuLi5cIiwgXCJjb250ZXh0XCI6IFwiZWRpdG9yXCIgfVxuICogKlxcL1xuICogPOS4jiBleGVjdXRlX2NvZGUg6YeM5LiA5qih5LiA5qC355qE5Luj56CBPlxuICogYGBgXG4gKlxuICogLSAqKuWNleaWh+S7tioq77yaZ2l0IOmHjOS4gOecvOeci+W+l+inge+8jOS4jeS8muWHuueOsOOAjC5qcyDlkowgLmpzb24g5ryC56e744CN77ybXG4gKiAtICoq5Luj56CB5L2T5bCx5pivIGBleGVjdXRlX2NvZGVgIOeahCBib2R5KirvvJrpobblsYLlj68gYHJldHVybmAgLyBgYXdhaXRg77yMYGFyZ3NgIOaYr+WFpeWPgiDigJTigJRcbiAqICAg5LqO5pivIHJlY2lwZSDkuI7kuIDmrKHmiJDlip/nmoTmjqLntKLkuYvpl7TmmK8qKuWkjeWItueymOi0tCoq55qE5YWz57O777yM6Zu25b+D5pm66LSf5ouF44CCXG4gKiAtICoq5LiN5piv6LeR6YCa5LqG5bCx6IO95a2YKirvvJpgc2F2ZVJlY2lwZWAg6L+HIHtAbGluayBjaGVja1JlY2lwZVJldXNhYmlsaXR5fSDpl6jnpoEg4oCU4oCUXG4gKiAgIOWPquaUtuOAjOS7peWQjui/mOiDveWGjeeUqOS4gOasoeOAjeeahOS7o+egge+8iOaciSBkZXNjcmlwdGlvbi9yZXR1cm5z44CB5Y+C5pWw55yf55qE6KKr55So5LiK44CB5peg5LiA5qyh5oCnIHV1aWQv57ud5a+56Lev5b6E77yJ44CCXG4gKlxuICogIyMg5pys5qih5Z2X5piv57qvIE5vZGXvvIzkuI0gaW1wb3J0IEVkaXRvclxuICpcbiAqIOWboOS4uuWug+imgSoq5ZCM5pe26KKr5Lik5Liq6L+b56iL5Yqg6L29KirvvJpcbiAqIC0g5Li76L+b56iL77yIYGRpc3QvY29yZS9lbmdpbmUuanNg77yJ4oCU4oCUIOato+W4uCBgaW1wb3J0YO+8m1xuICogLSAqKuW8leaTjuWcuuaZr+i/m+eoiyoq77yIYGRpc3Qvc2NlbmUuanNg77yJ4oCU4oCUIOWcuuaZr+iEmuacrOeahCBgX19kaXJuYW1lYCDmmK9cbiAqICAgYGVsZWN0cm9uLmFzYXIvcmVuZGVyZXJg77yM55u45a+5IHJlcXVpcmUg5LiN6YCa77yM5Y+q6IO96Z2gXG4gKiAgIGBFZGl0b3IuUGFja2FnZS5nZXRQYXRoKCdkc2hfY2hhdCcpYCDmi7/liLDmianlsZXmoLnvvIzlho3mjIkqKue7neWvuei3r+W+hCoqIHJlcXVpcmVcbiAqICAg77yI5a6e5rWL5Y+v6KGM77yJ44CCXG4gKlxuICog5omA5Lul6L+Z6YeM5Y+q5o6l5Y+X5pi+5byP5Lyg5YWl55qEIGBwcm9qZWN0UGF0aGDvvIznu53kuI3oh6rlt7Hljrvpl64gYEVkaXRvci4qYOOAglxuICovXG5cbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbi8qKiDlt6XnqIvmoLnkuIvnmoTlrZjmlL7nm67lvZXvvIjlj6/lhaXlupPvvJvkuI3lhpnov5sgLmdpdGlnbm9yZSDmmK/mnInmhI/nmoTvvIkgKi9cbmV4cG9ydCBjb25zdCBSRUNJUEVfRElSX05BTUUgPSAnLmRzaC1tY3AnO1xuXG4vKiog5a2Y5pS+55uu5b2V5LiL55qE5a2Q55uu5b2V5ZCNICovXG5leHBvcnQgY29uc3QgUkVDSVBFX1NVQkRJUiA9ICdyZWNpcGVzJztcblxuLyoqIHJlY2lwZSDmlofku7bmianlsZXlkI0gKi9cbmV4cG9ydCBjb25zdCBSRUNJUEVfRVhUID0gJy5qcyc7XG5cbi8qKiDlhYPmlbDmja7lnZfmoIforrAgKi9cbmNvbnN0IE1BUktFUiA9ICdAZHNoLXJlY2lwZSc7XG5cbi8qKiByZWNpcGUg5Y+v5Lul5Zyo5ZOq5Liq5LiK5LiL5paH6LeRICovXG5leHBvcnQgdHlwZSBSZWNpcGVDb250ZXh0ID0gJ2VkaXRvcicgfCAnc2NlbmUnIHwgJ2FueSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjaXBlTWV0YSB7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIC8qKiDkuIDlj6Xor53or7TmuIXjgIzov5nku6PnoIHlubLku4DkuYjjgI3igJTigJQg5a6D5ZCM5pe25pivIGBmaW5kUmVjaXBlc2Ag55qE5qOA57Si5paH5pysICovXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gICAgLyoqIOWFpeWPguivtOaYju+8mmtleSDmmK8gYGFyZ3NgIOS4iueahOWtl+auteWQjSAqL1xuICAgIHBhcmFtcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgLyoqIOivpeWcqOWTquS4quS4iuS4i+aWh+aJp+ihjO+8m2BhbnlgIOaIluS4jeWGmSA9IOmDveihjCAqL1xuICAgIGNvbnRleHQ/OiBSZWNpcGVDb250ZXh0O1xuICAgIC8qKiDov5Tlm57lgLzor7TmmI7vvIjnu5nosIPnlKjmlrnnnIvjgIzog73mi7/liLDku4DkuYjjgI3vvIkgKi9cbiAgICByZXR1cm5zPzogc3RyaW5nO1xuICAgIC8qKiDpppbmrKHokL3nm5jml7bpl7TvvIhJU0/vvIkgKi9cbiAgICBjcmVhdGVkQXQ/OiBzdHJpbmc7XG4gICAgLyoqIOacgOi/keS4gOasoeaIkOWKn+aJp+ihjOeahOaXtumXtO+8iElTT++8ieKAlOKAlCDov4fmnJ/liKTmlq3nmoTllK/kuIDkvp3mja4gKi9cbiAgICB2ZXJpZmllZEF0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlY2lwZVJlY29yZCB7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG1ldGE6IFJlY2lwZU1ldGE7XG4gICAgLyoqIOWPr+aJp+ihjOS7o+eggeS9k++8iOS4jeWQq+WFg+aVsOaNruWdl++8iSAqL1xuICAgIGNvZGU6IHN0cmluZztcbiAgICAvKiog57ud5a+56Lev5b6EICovXG4gICAgZmlsZTogc3RyaW5nO1xuICAgIC8qKiDmlofku7blrZfoioLmlbAgKi9cbiAgICBieXRlczogbnVtYmVyO1xufVxuXG4vKiogcmVjaXBlIOagueebruW9le+8iOS4jeS/neivgeWtmOWcqO+8iSAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY2lwZXNSb290KHByb2plY3RQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBwYXRoLmpvaW4ocHJvamVjdFBhdGgsIFJFQ0lQRV9ESVJfTkFNRSwgUkVDSVBFX1NVQkRJUik7XG59XG5cbi8qKlxuICog5oqK55So5oi357uZ55qEIHJlY2lwZSDlkI3op4TojIPljJbmiJDlronlhajmlofku7blkI3jgIJcbiAqXG4gKiDlj6rmlL7ooYwgYFtBLVphLXowLTkuXy1dYO+8muWQjeWtl+imgei3qOW5s+WPsOOAgeimgeiDveebtOaOpeW9k+aWh+S7tuWQje+8jFxuICog6ICM5LiUKirlv4XpobvmjKHkvY/ot6/lvoTnqb/otooqKu+8iGAuLi8uLi9mb29gIOS8muWGmeWIsOW3peeoi+WklumdouWOu++8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVjaXBlTmFtZShyYXc6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcmF3ID09PSAnc3RyaW5nJyA/IHJhdy50cmltKCkgOiAnJztcbiAgICBpZiAoIW5hbWUpIHRocm93IG5ldyBFcnJvcigncmVjaXBlIOWQjeS4jeiDveS4uuepuicpO1xuICAgIGlmIChuYW1lLmxlbmd0aCA+IDgwKSB0aHJvdyBuZXcgRXJyb3IoYHJlY2lwZSDlkI3ov4fplb/vvIgke25hbWUubGVuZ3RofSA+IDgw77yJ77yaJHtuYW1lfWApO1xuICAgIGlmICghL15bQS1aYS16MC05Ll8tXSskLy50ZXN0KG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGByZWNpcGUg5ZCN5Y+q5YWB6K645a2X5q+NL+aVsOWtly/ngrkv5LiL5YiS57q/L+i/nuWtl+espu+8jOaUtuWIsO+8miR7bmFtZX3vvIjmj5DnpLrvvJrnlKgga2ViYWItY2FzZe+8jOWmgiBjcmVhdGUtMmQtc2NlbmXvvIlgLFxuICAgICAgICApO1xuICAgIH1cbiAgICAvLyBgLmAg5LiOIGAuLmAg5Y2V54us5oiQ5ZCN55qE6Lev5b6E56m/6LaKXG4gICAgaWYgKG5hbWUgPT09ICcuJyB8fCBuYW1lID09PSAnLi4nKSB0aHJvdyBuZXcgRXJyb3IoYHJlY2lwZSDlkI3pnZ7ms5XvvJoke25hbWV9YCk7XG4gICAgcmV0dXJuIG5hbWU7XG59XG5cbi8qKiByZWNpcGUg5paH5Lu257ud5a+56Lev5b6EICovXG5leHBvcnQgZnVuY3Rpb24gcmVjaXBlRmlsZShwcm9qZWN0UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBwYXRoLmpvaW4ocmVjaXBlc1Jvb3QocHJvamVjdFBhdGgpLCBgJHtub3JtYWxpemVSZWNpcGVOYW1lKG5hbWUpfSR7UkVDSVBFX0VYVH1gKTtcbn1cblxuLyoqXG4gKiDop6PmnpAgcmVjaXBlIOa6kOeggSDihpIg5YWD5pWw5o2uICsg5Luj56CB5L2T44CCXG4gKlxuICog5Yi75oSP5YaZ5b6X44CM5Z2P6L6T5YWl5LiN5oqb5byC5bi444CN77ya6K+75Yiw5LiA5Liq5omL5YaZ5Z2P55qEIHJlY2lwZSDkuI3lupTor6XorqnmlbTmrKEgYGZpbmRSZWNpcGVzYCDltKnmjonvvIxcbiAqIOiAjOaYr+iuqeWug+S7peOAjOaXoOWFg+aVsOaNruOAjeeahOWnv+aAgeWHuueOsOWcqOWIl+ihqOmHjO+8jOaooeWei+iHquW3seWGs+WumuimgeS4jeimgeaJk+W8gOeci+OAglxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWNpcGUoc291cmNlOiB1bmtub3duKTogeyBtZXRhOiBSZWNpcGVNZXRhOyBjb2RlOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgdGV4dCA9IHR5cGVvZiBzb3VyY2UgPT09ICdzdHJpbmcnID8gc291cmNlIDogJyc7XG4gICAgY29uc3QgZmFsbGJhY2sgPSB7IG1ldGE6IHsgbmFtZTogJycgfSBhcyBSZWNpcGVNZXRhLCBjb2RlOiB0ZXh0IH07XG5cbiAgICBjb25zdCBtYXJrZXJBdCA9IHRleHQuaW5kZXhPZihNQVJLRVIpO1xuICAgIGlmIChtYXJrZXJBdCA8IDApIHJldHVybiBmYWxsYmFjaztcbiAgICBjb25zdCBibG9ja1N0YXJ0ID0gdGV4dC5pbmRleE9mKCcvKicsIG1hcmtlckF0ID49IDMgPyBtYXJrZXJBdCAtIDMgOiAwKTtcbiAgICBpZiAoYmxvY2tTdGFydCA8IDApIHJldHVybiBmYWxsYmFjaztcbiAgICBjb25zdCBibG9ja0VuZCA9IHRleHQuaW5kZXhPZignKi8nLCBtYXJrZXJBdCk7XG4gICAgaWYgKGJsb2NrRW5kIDwgMCkgcmV0dXJuIGZhbGxiYWNrO1xuXG4gICAgY29uc3QganNvblRleHQgPSB0ZXh0LnNsaWNlKG1hcmtlckF0ICsgTUFSS0VSLmxlbmd0aCwgYmxvY2tFbmQpLnRyaW0oKTtcbiAgICBsZXQgbWV0YTogUmVjaXBlTWV0YTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGpzb25UZXh0KTtcbiAgICAgICAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIHBhcnNlZCAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShwYXJzZWQpKSByZXR1cm4gZmFsbGJhY2s7XG4gICAgICAgIG1ldGEgPSBwYXJzZWQgYXMgUmVjaXBlTWV0YTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbGxiYWNrO1xuICAgIH1cblxuICAgIC8vIOS7o+eggeS9kyA9IOWFg+aVsOaNruWdl+S5i+WQjueahOaJgOacieWGheWuue+8iOWOu+aOiee0p+maj+WFtuWQjueahOS4gOS4quaNouihjO+8jOiuqeihjOWPt+S7jiAxIOW8gOWni+WDj+eUqOaIt+WGmeeahOmCo+agt++8iVxuICAgIGxldCBjb2RlID0gdGV4dC5zbGljZShibG9ja0VuZCArIDIpO1xuICAgIGlmIChjb2RlLnN0YXJ0c1dpdGgoJ1xcclxcbicpKSBjb2RlID0gY29kZS5zbGljZSgyKTtcbiAgICBlbHNlIGlmIChjb2RlLnN0YXJ0c1dpdGgoJ1xcbicpKSBjb2RlID0gY29kZS5zbGljZSgxKTtcblxuICAgIHJldHVybiB7IG1ldGEsIGNvZGUgfTtcbn1cblxuLyoqIOe7hOijhSByZWNpcGUg5paH5Lu25YaF5a6577yI5YWD5pWw5o2u5Z2XICsg5Luj56CB5L2T77yJICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UmVjaXBlKG5hbWU6IHN0cmluZywgY29kZTogc3RyaW5nLCBtZXRhOiBQYXJ0aWFsPFJlY2lwZU1ldGE+ID0ge30pOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQ6IFJlY2lwZU1ldGEgPSB7IC4uLm1ldGEsIG5hbWUgfTtcbiAgICAvLyDlm7rlrpoga2V5IOmhuuW6j++8jOiuqSBnaXQgZGlmZiDnqLPlrprvvIjkuI3nhLbmr4/mrKHkv53lrZjlrZfmrrXpobrluo/pg73lj6/og73lj5jvvIlcbiAgICBjb25zdCBvcmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZTogbm9ybWFsaXplZC5uYW1lIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2YgWydkZXNjcmlwdGlvbicsICdjb250ZXh0JywgJ3BhcmFtcycsICdyZXR1cm5zJywgJ2NyZWF0ZWRBdCcsICd2ZXJpZmllZEF0J10gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBub3JtYWxpemVkW2tleV07XG4gICAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSAnJykgb3JkZXJlZFtrZXldID0gdmFsdWU7XG4gICAgfVxuICAgIGNvbnN0IGJvZHkgPSBjb2RlLmVuZHNXaXRoKCdcXG4nKSA/IGNvZGUgOiBgJHtjb2RlfVxcbmA7XG4gICAgcmV0dXJuIGAvKiAke01BUktFUn1cXG4ke0pTT04uc3RyaW5naWZ5KG9yZGVyZWQsIG51bGwsIDIpfVxcbiovXFxuJHtib2R5fWA7XG59XG5cbi8qKiDmiorlj4LmlbDor7TmmI7lvZLkuIDljJbmiJAgYHvlrZfmrrXlkI06IOivtOaYjn1g77yI5o6l5Y+X5pWw57uE5oiW5a+56LGh5Lik56eN5YaZ5rOV77yJICovXG5mdW5jdGlvbiBub3JtYWxpemVQYXJhbXMocmF3OiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFyYXcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJhdykge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJyAmJiBpdGVtLnRyaW0oKSkgb3V0W2l0ZW0udHJpbSgpXSA9ICcnO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhvdXQpLmxlbmd0aCA+IDAgPyBvdXQgOiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgcmF3ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICAgICAgb3V0W2tleV0gPSB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUgOiBTdHJpbmcodmFsdWUgPz8gJycpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhvdXQpLmxlbmd0aCA+IDAgPyBvdXQgOiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiDop4TojIPljJbosIPnlKjmlrnnu5nnmoTlhYPmlbDmja7vvIjkv53lrZjot6/lvoTkuI7op6PmnpDot6/lvoTlhbHnlKjvvIzkv53or4HkuKTkvqflj6PlvoTkuIDoh7TvvIkgKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVSZWNpcGVNZXRhKHJhdzogdW5rbm93biwgZmFsbGJhY2tOYW1lPzogc3RyaW5nKTogUmVjaXBlTWV0YSB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ICYmIHR5cGVvZiByYXcgPT09ICdvYmplY3QnID8gcmF3IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IG1ldGE6IFJlY2lwZU1ldGEgPSB7XG4gICAgICAgIG5hbWU6IHR5cGVvZiBpbnB1dC5uYW1lID09PSAnc3RyaW5nJyAmJiBpbnB1dC5uYW1lLnRyaW0oKSA/IGlucHV0Lm5hbWUudHJpbSgpIDogZmFsbGJhY2tOYW1lIHx8ICcnLFxuICAgIH07XG4gICAgaWYgKHR5cGVvZiBpbnB1dC5kZXNjcmlwdGlvbiA9PT0gJ3N0cmluZycgJiYgaW5wdXQuZGVzY3JpcHRpb24udHJpbSgpKSB7XG4gICAgICAgIG1ldGEuZGVzY3JpcHRpb24gPSBpbnB1dC5kZXNjcmlwdGlvbi50cmltKCk7XG4gICAgfVxuICAgIGNvbnN0IHBhcmFtcyA9IG5vcm1hbGl6ZVBhcmFtcyhpbnB1dC5wYXJhbXMpO1xuICAgIGlmIChwYXJhbXMpIG1ldGEucGFyYW1zID0gcGFyYW1zO1xuICAgIGlmIChpbnB1dC5jb250ZXh0ID09PSAnZWRpdG9yJyB8fCBpbnB1dC5jb250ZXh0ID09PSAnc2NlbmUnIHx8IGlucHV0LmNvbnRleHQgPT09ICdhbnknKSB7XG4gICAgICAgIG1ldGEuY29udGV4dCA9IGlucHV0LmNvbnRleHQ7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgaW5wdXQucmV0dXJucyA9PT0gJ3N0cmluZycgJiYgaW5wdXQucmV0dXJucy50cmltKCkpIG1ldGEucmV0dXJucyA9IGlucHV0LnJldHVybnMudHJpbSgpO1xuICAgIGlmICh0eXBlb2YgaW5wdXQuY3JlYXRlZEF0ID09PSAnc3RyaW5nJyAmJiBpbnB1dC5jcmVhdGVkQXQpIG1ldGEuY3JlYXRlZEF0ID0gaW5wdXQuY3JlYXRlZEF0O1xuICAgIGlmICh0eXBlb2YgaW5wdXQudmVyaWZpZWRBdCA9PT0gJ3N0cmluZycgJiYgaW5wdXQudmVyaWZpZWRBdCkgbWV0YS52ZXJpZmllZEF0ID0gaW5wdXQudmVyaWZpZWRBdDtcbiAgICByZXR1cm4gbWV0YTtcbn1cblxuLyoqXG4gKiDliJflh7rlhajpg6ggcmVjaXBl44CCXG4gKlxuICog55uu5b2V5LiN5a2Y5ZyoIOKGkiDnqbrmlbDnu4TvvIgqKuS4jeaYr+W8guW4uCoq77yJ77ya56ys5LiA5qyh55So55qE5Lq65LiN6K+l55yL5Yiw5LiA5p2h5oql6ZSZ44CCXG4gKiDlnY/mlofku7Yg4oaSIOS7peaXoOWFg+aVsOaNrueahOW9ouaAgeWIl+WHuu+8jOiAjOS4jeaYr+aVtOS4quWIl+ihqOWksei0peOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdFJlY2lwZVJlY29yZHMocHJvamVjdFBhdGg6IHN0cmluZyk6IFJlY2lwZVJlY29yZFtdIHtcbiAgICBjb25zdCByb290ID0gcmVjaXBlc1Jvb3QocHJvamVjdFBhdGgpO1xuICAgIGxldCBlbnRyaWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgICBlbnRyaWVzID0gZnMucmVhZGRpclN5bmMocm9vdCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBvdXQ6IFJlY2lwZVJlY29yZFtdID0gW107XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzLnNvcnQoKSkge1xuICAgICAgICBpZiAoIWVudHJ5LnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoUkVDSVBFX0VYVCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aC5qb2luKHJvb3QsIGVudHJ5KTtcbiAgICAgICAgbGV0IHN0YXQ6IGZzLlN0YXRzO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgc3RhdCA9IGZzLnN0YXRTeW5jKGZpbGUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc3RhdC5pc0ZpbGUoKSkgY29udGludWU7XG5cbiAgICAgICAgY29uc3QgZmFsbGJhY2tOYW1lID0gZW50cnkuc2xpY2UoMCwgLVJFQ0lQRV9FWFQubGVuZ3RoKTtcbiAgICAgICAgbGV0IHJhdyA9ICcnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmF3ID0gZnMucmVhZEZpbGVTeW5jKGZpbGUsICd1dGYtOCcpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUmVjaXBlKHJhdyk7XG4gICAgICAgIGNvbnN0IG1ldGEgPSBub3JtYWxpemVSZWNpcGVNZXRhKHBhcnNlZC5tZXRhLCBmYWxsYmFja05hbWUpO1xuICAgICAgICBpZiAoIW1ldGEubmFtZSkgbWV0YS5uYW1lID0gZmFsbGJhY2tOYW1lO1xuICAgICAgICBvdXQucHVzaCh7IG5hbWU6IG1ldGEubmFtZSwgbWV0YSwgY29kZTogcGFyc2VkLmNvZGUsIGZpbGUsIGJ5dGVzOiBzdGF0LnNpemUgfSk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKiDor7vljZXmnaEgcmVjaXBl77yb5LiN5a2Y5Zyo6L+U5ZueIG51bGwgKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkUmVjaXBlUmVjb3JkKHByb2plY3RQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IFJlY2lwZVJlY29yZCB8IG51bGwge1xuICAgIGNvbnN0IGZpbGUgPSByZWNpcGVGaWxlKHByb2plY3RQYXRoLCBuYW1lKTtcbiAgICBsZXQgcmF3OiBzdHJpbmc7XG4gICAgbGV0IGJ5dGVzID0gMDtcbiAgICB0cnkge1xuICAgICAgICByYXcgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZSwgJ3V0Zi04Jyk7XG4gICAgICAgIGJ5dGVzID0gZnMuc3RhdFN5bmMoZmlsZSkuc2l6ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUmVjaXBlKHJhdyk7XG4gICAgY29uc3QgbWV0YSA9IG5vcm1hbGl6ZVJlY2lwZU1ldGEocGFyc2VkLm1ldGEsIG5vcm1hbGl6ZVJlY2lwZU5hbWUobmFtZSkpO1xuICAgIGlmICghbWV0YS5uYW1lKSBtZXRhLm5hbWUgPSBub3JtYWxpemVSZWNpcGVOYW1lKG5hbWUpO1xuICAgIHJldHVybiB7IG5hbWU6IG1ldGEubmFtZSwgbWV0YSwgY29kZTogcGFyc2VkLmNvZGUsIGZpbGUsIGJ5dGVzIH07XG59XG5cbi8qKlxuICog6JC955uY5LiA5p2hIHJlY2lwZe+8iOW5guetieimhueblu+8ieOAglxuICpcbiAqIGBjcmVhdGVkQXRgIOWcqCoq5bey5a2Y5ZyoKirml7bmsr/nlKjml6flgLwg4oCU4oCUIOWQpuWImeavj+asoeS/neWtmOmDveWIt+aWsOOAjOWIm+W7uuaXtumXtOOAje+8jFxuICog6YKj5Liq5a2X5q615bCx5rKh5oSP5LmJ5LqG44CCYHZlcmlmaWVkQXRgIOWQjOeQhuayv+eUqO+8iOeUsSB7QGxpbmsgdG91Y2hSZWNpcGVWZXJpZmllZH0g5Y2V54us5o6o6L+b77yJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZVJlY2lwZVJlY29yZChcbiAgICBwcm9qZWN0UGF0aDogc3RyaW5nLFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgbWV0YTogUGFydGlhbDxSZWNpcGVNZXRhPiA9IHt9LFxuKTogUmVjaXBlUmVjb3JkIHtcbiAgICBjb25zdCBzYWZlTmFtZSA9IG5vcm1hbGl6ZVJlY2lwZU5hbWUobmFtZSk7XG4gICAgaWYgKHR5cGVvZiBjb2RlICE9PSAnc3RyaW5nJyB8fCAhY29kZS50cmltKCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdyZWNpcGUg5Luj56CB5LiN6IO95Li656m6Jyk7XG4gICAgfVxuICAgIGNvbnN0IHJvb3QgPSByZWNpcGVzUm9vdChwcm9qZWN0UGF0aCk7XG4gICAgZnMubWtkaXJTeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcHJldmlvdXMgPSByZWFkUmVjaXBlUmVjb3JkKHByb2plY3RQYXRoLCBzYWZlTmFtZSk7XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZWNpcGVNZXRhKG1ldGEsIHNhZmVOYW1lKTtcbiAgICBub3JtYWxpemVkLm5hbWUgPSBzYWZlTmFtZTtcbiAgICBub3JtYWxpemVkLmNyZWF0ZWRBdCA9IHByZXZpb3VzPy5tZXRhLmNyZWF0ZWRBdCB8fCBub3JtYWxpemVkLmNyZWF0ZWRBdCB8fCBub3c7XG4gICAgaWYgKHByZXZpb3VzPy5tZXRhLnZlcmlmaWVkQXQpIG5vcm1hbGl6ZWQudmVyaWZpZWRBdCA9IG5vcm1hbGl6ZWQudmVyaWZpZWRBdCB8fCBwcmV2aW91cy5tZXRhLnZlcmlmaWVkQXQ7XG5cbiAgICBjb25zdCB0ZXh0ID0gZm9ybWF0UmVjaXBlKHNhZmVOYW1lLCBjb2RlLCBub3JtYWxpemVkKTtcbiAgICBjb25zdCBmaWxlID0gcmVjaXBlRmlsZShwcm9qZWN0UGF0aCwgc2FmZU5hbWUpO1xuICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZSwgdGV4dCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgYnl0ZXMgPSBCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0LCAndXRmLTgnKTtcblxuICAgIC8vIOebruW9lemHjOaUvuS4gOS7veivtOaYju+8jOWFjeW+l+S6uuexu+eci+WIsCBgLmRzaC1tY3AvYCDkuI3nn6XpgZPov5nmmK/ku4DkuYjjgIHor6XkuI3or6XlhaXlupNcbiAgICBjb25zdCByZWFkbWUgPSBwYXRoLmpvaW4ocGF0aC5kaXJuYW1lKHJvb3QpLCAnUkVBRE1FLm1kJyk7XG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKHJlYWRtZSkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMocmVhZG1lLCBSRUNJUEVfUkVBRE1FLCAndXRmLTgnKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDor7TmmI7mlofku7blhpnkuI3ov5vljrvkuI3lvbHlk43kuLvmtYHnqIsgKi9cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICAgIG5hbWU6IHNhZmVOYW1lLFxuICAgICAgICBtZXRhOiBub3JtYWxpemVSZWNpcGVNZXRhKHBhcnNlUmVjaXBlKHRleHQpLm1ldGEsIHNhZmVOYW1lKSxcbiAgICAgICAgY29kZSxcbiAgICAgICAgZmlsZSxcbiAgICAgICAgYnl0ZXMsXG4gICAgfTtcbn1cblxuLyoqIOWIoOS4gOadoSByZWNpcGXvvJvov5Tlm57mmK/lkKbnnJ/nmoTliKDmjonkuoYgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWxldGVSZWNpcGVSZWNvcmQocHJvamVjdFBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZmlsZSA9IHJlY2lwZUZpbGUocHJvamVjdFBhdGgsIG5hbWUpO1xuICAgIHRyeSB7XG4gICAgICAgIGZzLnVubGlua1N5bmMoZmlsZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxufVxuXG4vKipcbiAqIOiusOS4gOasoeOAjOi/meadoSByZWNpcGUg5Yia5Yia6LeR6YCa5LqG44CN44CCXG4gKlxuICogKirmr4/lpKnmnIDlpJrlhpnkuIDmrKHnm5gqKu+8mui3keS4gOasoeWwseWGmeS4gOasoeS8muiuqSBnaXQg5aSp5aSp5Zmq5aOw77yMXG4gKiDogIwgYHZlcmlmaWVkQXRgIOeahOeyvuW6puacrOadpeS5n+WPqueUqOadpeWIpOaWreOAjOaYr+S4jeaYr+WHoOS4quaciOayoeWKqOi/h+S6huOAjeOAglxuICpcbiAqIEByZXR1cm5zIOacrOasoeaYr+WQpuecn+eahOabtOaWsOS6hu+8iOayoeabtOaWsOWwsei/lOWbniBudWxs77yJXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b3VjaFJlY2lwZVZlcmlmaWVkKHByb2plY3RQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGxldCByZWNvcmQ6IFJlY2lwZVJlY29yZCB8IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgcmVjb3JkID0gcmVhZFJlY2lwZVJlY29yZChwcm9qZWN0UGF0aCwgbmFtZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlY29yZCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIGNvbnN0IHByZXZpb3VzID0gcmVjb3JkLm1ldGEudmVyaWZpZWRBdCA/IG5ldyBEYXRlKHJlY29yZC5tZXRhLnZlcmlmaWVkQXQpIDogbnVsbDtcbiAgICBjb25zdCBzYW1lRGF5ID1cbiAgICAgICAgcHJldmlvdXMgaW5zdGFuY2VvZiBEYXRlICYmXG4gICAgICAgICFOdW1iZXIuaXNOYU4ocHJldmlvdXMuZ2V0VGltZSgpKSAmJlxuICAgICAgICBwcmV2aW91cy50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSA9PT0gbm93LnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApO1xuICAgIGlmIChzYW1lRGF5KSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IGlzbyA9IG5vdy50b0lTT1N0cmluZygpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBmb3JtYXRSZWNpcGUocmVjb3JkLm5hbWUsIHJlY29yZC5jb2RlLCB7IC4uLnJlY29yZC5tZXRhLCB2ZXJpZmllZEF0OiBpc28gfSk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMocmVjb3JkLmZpbGUsIHRleHQsICd1dGYtOCcpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIGlzbztcbn1cblxuLyoqIOi3neemu+S4iuasoemqjOivgei/h+S6huWkmuWwkeWkqe+8iOayoemqjOivgei/h+i/lOWbniBudWxs77yJICovXG5leHBvcnQgZnVuY3Rpb24gZGF5c1NpbmNlVmVyaWZpZWQobWV0YTogUmVjaXBlTWV0YSwgbm93OiBudW1iZXIgPSBEYXRlLm5vdygpKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgaWYgKCFtZXRhLnZlcmlmaWVkQXQpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGF0ID0gbmV3IERhdGUobWV0YS52ZXJpZmllZEF0KS5nZXRUaW1lKCk7XG4gICAgaWYgKE51bWJlci5pc05hTihhdCkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChub3cgLSBhdCkgLyA4NjQwMDAwMCkpO1xufVxuXG4vKiogYGNvbnRleHRgIOS4juW9k+WJjeaJp+ihjOS4iuS4i+aWh+aYr+WQpuebuOWuuSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRleHRNYXRjaGVzKG1ldGE6IFJlY2lwZU1ldGEsIGN1cnJlbnQ6ICdlZGl0b3InIHwgJ3NjZW5lJyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHdhbnQgPSBtZXRhLmNvbnRleHQ7XG4gICAgaWYgKCF3YW50IHx8IHdhbnQgPT09ICdhbnknKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gd2FudCA9PT0gY3VycmVudDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlpI3nlKjpl6jnpoEg4oCU4oCUIOOAjOi3kemAmuS6huOAjeS4jeetieS6juOAjOWAvOW+l+WtmOOAjVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog5LiA5qyh5oCn5qCH6K+G55qE5Yik5o2u44CCXG4gKlxuICog6L+Z5Lqb5YC8Kirlj6rlr7nmn5DkuIDmrKHmiafooYzmiJDnq4sqKu+8iOafkOS4quiKgueCueeahCB1dWlk44CB5p+Q5Y+w5py65Zmo5LiK55qE57ud5a+56Lev5b6E77yJ77yMXG4gKiDlrZjov5sgcmVjaXBlIOWwseetieS6juWtmOS6huS4gOauteS7peWQjui3keS4jemAmueahOS7o+eggeOAguWug+S7rOmDveivpei1sCBgYXJnc2DjgIJcbiAqL1xuY29uc3QgT05FX09GRl9QQVRURVJOUzogUmVhZG9ubHlBcnJheTx7IGlkOiBzdHJpbmc7IHJlOiBSZWdFeHA7IGhpbnQ6IHN0cmluZyB9PiA9IFtcbiAgICB7XG4gICAgICAgIGlkOiAndXVpZCcsXG4gICAgICAgIHJlOiAvXFxiWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9XFxiL2ksXG4gICAgICAgIGhpbnQ6ICfmioogdXVpZCDlj5jmiJDlhaXlj4LvvJrku6PnoIHph4zlhpkgYXJncy51dWlk77yM5bm25ZyoIG1ldGEucGFyYW1zLnV1aWQg6YeM6K+05piO5a6D5piv5LuA5LmI6IqC54K5JyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgaWQ6ICdhYnMtcGF0aCcsXG4gICAgICAgIHJlOiAvKD86W0EtWmEtel06W1xcXFwvXVteJ1wiYFxcc118XFwvKD86VXNlcnN8aG9tZSlcXC9bXidcImBcXHNdKS8sXG4gICAgICAgIGhpbnQ6ICfmiornu53lr7not6/lvoTlj5jmiJDlhaXlj4LvvIhhcmdzLmRpciAvIGFyZ3MuZmlsZe+8ie+8jOaIluaUueeUqCBwcm9qZWN0UGF0aCgpIOaLvOebuOWvuei3r+W+hCcsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIGlkOiAndGVtcC1wYXRoJyxcbiAgICAgICAgcmU6IC9bXFxcXC9dXFwudG1wW1xcXFwvXS8sXG4gICAgICAgIGhpbnQ6ICfliKvmiorkuLTml7bnm67lvZXlhpnov5sgcmVjaXBl77yILnRtcC8g5piv5LiA5qyh5oCn5Lqn54mp77yJJyxcbiAgICB9LFxuXTtcblxuLyoqIOmXqOemgee7k+iuuu+8mmBwcm9ibGVtc2Ag6Z2e56m65Y2z5ouS57ud6JC955uY77ybYHdhcm5pbmdzYCDlj6rmj5DnpLrjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVjaXBlUmV1c2VDaGVja1Jlc3VsdCB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgcHJvYmxlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+O1xuICAgIHdhcm5pbmdzOiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiDlpI3nlKjpl6jnpoHvvJoqKuWPquacieOAjOS7peWQjui/mOiDveWGjeeUqOS4gOasoeOAjeeahOS7o+eggeaJjeiuuOWtmOaIkCByZWNpcGUqKuOAglxuICpcbiAqIOOAjOi3kemAmuS6huOAjeWPquaYr+W/heimgeadoeS7tuOAguWIpOaNruWFqOmDqOWPr+acuuajgO+8jOS4jemdoOiHquinie+8mlxuICpcbiAqIHwg5Yik5o2uIHwg6KeE5YiZIHwg5Li65LuA5LmIIHxcbiAqIHwtLS18LS0tfC0tLXxcbiAqIHwg5pyJ5aWR57qmIHwgYGRlc2NyaXB0aW9uYO+8iOKJpTgg5a2X77yJKyBgcmV0dXJuc2DvvIjiiaU0IOWtl++8ieW/heWhqyB8IOWug+S7rOWQjOaXtuaYryBgZmluZFJlY2lwZXNgIOeahOajgOe0ouaWh+acrCDigJTigJQg5rKh5aWR57qm55qEIHJlY2lwZSDnrYnkuo7msqHntKLlvJXnmoTku6PnoIEgfFxuICogfCDmnInlhaXlj6MgfCBgcGFyYW1zYCDph4zlo7DmmI7nmoTmr4/kuKrplK7vvIzku6PnoIHph4zlv4XpobvnnJ/nmoTlh7rnjrAgYGFyZ3MuPOmUrj5gIHwg5aOw5piO5LqG5Y205LiN55SoID0g5oqE5LiL5p2l55qE5piv5LiA5qyh5o6i57Si77yM5LiN5piv5LiA5Liq5Ye95pWwIHxcbiAqIHwg5peg5LiA5qyh5oCn5YC8IHwg5Luj56CB6YeM5LiN6K645pyJ5YW35L2TIHV1aWQgLyDnu53lr7not6/lvoQgLyBgLnRtcC9gIHwg6L+Z57G75YC85Y+q5a+56YKj5LiA5qyh5oiQ56uL77yM5Yir5Lq677yI5oiW5LiL5LiA5bGA77yJ6LeR5b+F54S25aSx6LSlIHxcbiAqIHwg5ZCN5a2X5Y+v5aSN55SoIHwg5ZCN5a2X6YeM5LiN6K645bim5pel5pyfL+aXtumXtOaIsyB8IGB4eHgtMjAyNi0wOS0zMGAg5piv5b+r54Wn77yM5LiN5piv6LWE5LqnIHxcbiAqXG4gKiDmsqHmnInlj4LmlbDlj6rmmK8qKuitpuWRiioq77yI57qv5p+l6K+i57G756Gu5a6e5Y+v5Lul5peg5Y+C77yJ77yM5LiN5ouS57udIOKAlOKAlCDkvYbkvJrmj5DnpLrjgIznoa7orqTlroPnnJ/og73lpI3nlKjjgI3jgIJcbiAqXG4gKiDlj43kvovvvIjkvJrooqvmi5LvvInvvJpgcmV0dXJuIG5vZGVCeVV1aWQoJzNkOTAxYjM5LeKApicpLm5hbWVgIOKAlOKAlCDlhbfkvZMgdXVpZCDlhpnmrbvvvIxcbiAqIOS7peWQjumCo+S4quiKgueCueS4gOaNouWwseW6n++8m+ato+ino+aYryBgYXJncy51dWlkYCArIGBtZXRhLnBhcmFtcy51dWlkYOOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tSZWNpcGVSZXVzYWJpbGl0eShcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgY29kZTogc3RyaW5nLFxuICAgIG1ldGE6IFBpY2s8UmVjaXBlTWV0YSwgJ2Rlc2NyaXB0aW9uJyB8ICdyZXR1cm5zJyB8ICdwYXJhbXMnPixcbik6IFJlY2lwZVJldXNlQ2hlY2tSZXN1bHQge1xuICAgIGNvbnN0IHByb2JsZW1zOiBSZWNpcGVSZXVzZUNoZWNrUmVzdWx0Wydwcm9ibGVtcyddID0gW107XG4gICAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IHR5cGVvZiBtZXRhLmRlc2NyaXB0aW9uID09PSAnc3RyaW5nJyA/IG1ldGEuZGVzY3JpcHRpb24udHJpbSgpIDogJyc7XG4gICAgaWYgKGRlc2NyaXB0aW9uLmxlbmd0aCA8IDgpIHtcbiAgICAgICAgcHJvYmxlbXMucHVzaCh7XG4gICAgICAgICAgICBpZDogJ25vLWRlc2NyaXB0aW9uJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICfnvLrlsJEgZGVzY3JpcHRpb27vvIjiiaU4IOWtl++8jOivtOa4hei/meauteS7o+eggeW5suS7gOS5iO+8iScsXG4gICAgICAgICAgICBoaW50OiAnbWV0YT17ZGVzY3JpcHRpb246XCLmioogWCDph4znrKblkIggWSDnmoToioLngrnliJflh7rmnaXlubbov5Tlm57mkZjopoFcIn0nLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCByZXR1cm5zID0gdHlwZW9mIG1ldGEucmV0dXJucyA9PT0gJ3N0cmluZycgPyBtZXRhLnJldHVybnMudHJpbSgpIDogJyc7XG4gICAgaWYgKHJldHVybnMubGVuZ3RoIDwgNCkge1xuICAgICAgICBwcm9ibGVtcy5wdXNoKHtcbiAgICAgICAgICAgIGlkOiAnbm8tcmV0dXJucycsXG4gICAgICAgICAgICBtZXNzYWdlOiAn57y65bCRIHJldHVybnPvvIjiiaU0IOWtl++8jOivtOa4heS7peWQjuWkjeeUqOWug+iDveeci+WIsOS7gOS5iO+8iScsXG4gICAgICAgICAgICBoaW50OiAnbWV0YT17cmV0dXJuczpcIntjb3VudCwgc2FtcGxlOlvlkI3lrZddfVwifScsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICgvKD86XFxkezR9LVxcZHsyfS1cXGR7Mn18XFxkezh9KS8udGVzdChuYW1lKSkge1xuICAgICAgICBwcm9ibGVtcy5wdXNoKHtcbiAgICAgICAgICAgIGlkOiAnZGF0ZWQtbmFtZScsXG4gICAgICAgICAgICBtZXNzYWdlOiBg5ZCN5a2XIFwiJHtuYW1lfVwiIOW4puaXpeacny/ml7bpl7TmiLNgLFxuICAgICAgICAgICAgaGludDogJ+WQjeWtl+imgeiDveiiq+S7peWQjuWkjeeUqO+8iOWmgiBjcmVhdGUtMmQtc2NlbmXvvInvvJvkuIDmrKHmgKfnmoTml7bpl7Tngrnlhpnov5sgbWV0YS5kZXNjcmlwdGlvbiDph4wnLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgT05FX09GRl9QQVRURVJOUykge1xuICAgICAgICBpZiAocGF0dGVybi5yZS50ZXN0KGNvZGUpKSB7XG4gICAgICAgICAgICBwcm9ibGVtcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBpZDogcGF0dGVybi5pZCxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5Luj56CB6YeM5pyJ5LiA5qyh5oCn5YC877yIJHtwYXR0ZXJuLmlkfe+8iWAsXG4gICAgICAgICAgICAgICAgaGludDogcGF0dGVybi5oaW50LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwYXJhbXMgPSBtZXRhLnBhcmFtcyAmJiB0eXBlb2YgbWV0YS5wYXJhbXMgPT09ICdvYmplY3QnID8gT2JqZWN0LmVudHJpZXMobWV0YS5wYXJhbXMpIDogW107XG4gICAgaWYgKHBhcmFtcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgd2FybmluZ3MucHVzaChcbiAgICAgICAgICAgICfmsqHmnInlo7DmmI7ku7vkvZXlj4LmlbDvvJrlj6rog73ljp/moLfph43ot5HjgILlpoLmnpzlroPnoa7lrp7mr4/mrKHpg73kuIDmoLfvvIjnuq/mn6Xor6LvvInvvIzlj6/ku6XkuI3nrqHvvJsnICtcbiAgICAgICAgICAgICAgICAn5ZCm5YiZ5oqK5Lya5Y+Y55qE6YOo5YiG5o+Q5oiQIGFyZ3Mg5YaN5a2Y44CCJyxcbiAgICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHRleHRdIG9mIHBhcmFtcykge1xuICAgICAgICAgICAgaWYgKCFrZXkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNvZGUuaW5jbHVkZXMoYGFyZ3MuJHtrZXl9YCkgfHwgY29kZS5pbmNsdWRlcyhgYXJnc1snJHtrZXl9J11gKSB8fCBjb2RlLmluY2x1ZGVzKGBhcmdzW1wiJHtrZXl9XCJdYCk7XG4gICAgICAgICAgICBpZiAoIXVzZWQpIHtcbiAgICAgICAgICAgICAgICBwcm9ibGVtcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgaWQ6ICdwYXJhbS11bnVzZWQnLFxuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5aOw5piO5LqG5Y+C5pWwIFwiJHtrZXl9XCLvvIzkvYbku6PnoIHph4zmsqHmnInnlKjliLAgYXJncy4ke2tleX1gLFxuICAgICAgICAgICAgICAgICAgICBoaW50OiBg6KaB5LmI5Zyo5Luj56CB6YeM55So5LiK5a6D77yM6KaB5LmI5oqK5a6D5LuOIHBhcmFtcyDph4zliKDmjonvvIhwYXJhbXMg5bCx5piv6L+Z5q615Luj56CB55qE5aSN55So54K577yJYCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdGV4dCAhPT0gJ3N0cmluZycgfHwgIXRleHQudHJpbSgpKSB7XG4gICAgICAgICAgICAgICAgcHJvYmxlbXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGlkOiAncGFyYW0tdW5kb2N1bWVudGVkJyxcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogYOWPguaVsCBcIiR7a2V5fVwiIOayoeacieivtOaYjmAsXG4gICAgICAgICAgICAgICAgICAgIGhpbnQ6ICdwYXJhbXMg55qE5YC85piv5LiA5Y+l6K+d6K+05piO77yM5aaCIHsgdXVpZDogXCLopoHmn6XnmoToioLngrkgdXVpZFwiIH0nLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgb2s6IHByb2JsZW1zLmxlbmd0aCA9PT0gMCwgcHJvYmxlbXMsIHdhcm5pbmdzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5rKZ566x5Yqp5omL5bel5Y6CIOKAlOKAlCDms6jlhaUgZXhlY3V0ZV9jb2RlIOeahOWKqeaJi+WHveaVsO+8iOS4jeaYr+eLrOeriyBNQ1AgdG9vbO+8iVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiDkuIDmrKEgcmVjaXBlIOaJp+ihjOeahOS6p+WHuu+8iOWQhOS4iuS4i+aWh+aKiuiHquWutueahOaJp+ihjOe7k+aenOmAgumFjeaIkOWug++8iSAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWNpcGVSdW5PdXRjb21lIHtcbiAgICBvazogYm9vbGVhbjtcbiAgICByZXN1bHQ/OiB1bmtub3duO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBsb2dzPzogdW5rbm93bjtcbiAgICBkdXJhdGlvbk1zPzogbnVtYmVyO1xuICAgIHRpbWVkT3V0PzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiDmiafooYzkuIDmrrUgcmVjaXBlIOS7o+eggeS9k+OAglxuICpcbiAqICoq55Sx6LCD55So5pa55rOo5YWlKirvvIzlm6DkuLrkuKTkuKrkuIrkuIvmlofnmoTmiafooYzmnLrliLblrozlhajkuI3lkIzvvJpcbiAqIGVkaXRvciDotbAgYHZtLmNyZWF0ZUNvbnRleHRgIOaymeeuse+8jHNjZW5lIOi1sOWcuuaZr+i/m+eoi+eahCBgdm0ucnVuSW5UaGlzQ29udGV4dGDjgIJcbiAqIOacrOaooeWdl+WPqui0n+i0o+OAjOWPluS7o+eggSAvIOWIpOaWreiDveS4jeiDvei3kSAvIOiusOi0puOAje+8jOS4jeWFs+W/g+aAjuS5iOi3keOAglxuICovXG5leHBvcnQgdHlwZSBSZWNpcGVSdW5uZXIgPSAoXG4gICAgY29kZTogc3RyaW5nLFxuICAgIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuKSA9PiBQcm9taXNlPFJlY2lwZVJ1bk91dGNvbWU+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlY2lwZUhlbHBlck9wdGlvbnMge1xuICAgIC8qKiDlt6XnqIvmoLnnu53lr7not6/lvoTvvIhlZGl0b3Ig5LiOIHNjZW5lIOmDveiDveaLv+WIsCBgRWRpdG9yLlByb2plY3QucGF0aGDvvIkgKi9cbiAgICBwcm9qZWN0UGF0aDogc3RyaW5nO1xuICAgIC8qKiDlvZPliY3miafooYzkuIrkuIvmlofvvIznlKjkuo7moKHpqowgcmVjaXBlIOeahCBgY29udGV4dGAg5aOw5piOICovXG4gICAgY29udGV4dDogJ2VkaXRvcicgfCAnc2NlbmUnO1xuICAgIC8qKiDlj5bmiafooYzlmajjgIIqKuaDsOaApyoq77yaaGVscGVycyDkuI7miafooYzlmajkupLnm7jlvJXnlKjvvIzlv4XpobvmmZrnu5HlrpogKi9cbiAgICBnZXRSdW5uZXI6ICgpID0+IFJlY2lwZVJ1bm5lcjtcbiAgICAvKiogcnVuUmVjaXBlIOacquaMh+Wumui2heaXtuaXtueahOm7mOiupOWAvCAqL1xuICAgIGRlZmF1bHRUaW1lb3V0TXM/OiBudW1iZXI7XG59XG5cbi8qKiDliJfooajmnIDlpJrlm57ov5nkuYjlpJrmnaHvvIzpgb/lhY3miorkuIrkuIvmlofngYzmu6EgKi9cbmNvbnN0IExJU1RfTElNSVQgPSA0MDtcblxuLyoqIHJlY2lwZSDkupLnm7josIPnlKjnmoTmnIDlpKfmt7HluqbvvIjlhYHorrjnu4TlkIjvvIzkvYbkuI3lhYHorrjot5Hpo57vvIkgKi9cbmNvbnN0IE1BWF9SRUNJUEVfREVQVEggPSA0O1xuXG5mdW5jdGlvbiBlcnJvck9mKGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKGVyciAmJiB0eXBlb2YgZXJyID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gKGVyciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH0pLm1lc3NhZ2U7XG4gICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZycgJiYgbWVzc2FnZSkgcmV0dXJuIG1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcoZXJyKTtcbn1cblxuLyoqXG4gKiDmnoTpgKDms6jlhaXmspnnrrHnmoQgcmVjaXBlIOWKqeaJi+OAglxuICpcbiAqIOS6lOS4quWKqeaJi+imhuebluOAjOafpSDihpIg6K+7IOKGkiDlrZgg4oaSIOi3kSDihpIg5Yig44CN5LiA5Liq6Zet546v77yaXG4gKlxuICogfCDliqnmiYsgfCDkvZznlKggfCDlr7nlupTnmoTosIPnoJTnu5PorrogfFxuICogfC0tLXwtLS18LS0tfFxuICogfCBgZmluZFJlY2lwZXMoa3c/KWAgfCAqKuWPquWbnue0ouW8lSoq77ya5ZCN5a2XL+ivtOaYji/lj4LmlbAv5paw6bKc5bqmIHwgQW50aHJvcGljIOeahCBwcm9ncmVzc2l2ZSBkaXNjbG9zdXJl77ya5YWI57uZ57Si5byV77yM5Yir57uZ5YaF5a65IHxcbiAqIHwgYHJlYWRSZWNpcGUobmFtZSlgIHwg5oyJ6ZyA5Y+W5Zue5rqQ56CB77yM5L6b5qih5Z6L5pS55YaZ5aSN55SoIHwgY29jb3MtY29kZS1tb2RlIOeahOOAjOW3peeoi+aguSAuZC50cyDojYnnqL/mnb/jgI0gfFxuICogfCBgc2F2ZVJlY2lwZSguLi4pYCB8IOaKiui3kemAmueahOS7o+eggeWbuuWMluS4i+adpSB8IEFudGhyb3BpY+OAjOaKiuS7o+eggeWtmOaIkOWPr+WkjeeUqOWHveaVsOOAjSB8XG4gKiB8IGBydW5SZWNpcGUobmFtZSxhcmdzKWAgfCDnm7TmjqXmiafooYwgfCBDb2Nvc01ldGFNQ1Ag55qEIEwxIFJlY2lwZe+8iOWNleWPguaVsOOAgeW5guetie+8iSB8XG4gKiB8IGBkZWxldGVSZWNpcGUobmFtZSlgIHwg5riF55CGIHwg4oCU4oCUIHxcbiAqXG4gKiDimqAg6L+Z5LqU5LiqKirkuI3mmK8gTUNQIHRvb2wqKu+8jGB0b29scy9saXN0YCDlj6rmnInlm5vkuKrvvIjkuInkuKrpgJrnlKggKyBgY2FwdHVyZV92aWV3YO+8ieOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSZWNpcGVIZWxwZXJzKG9wdGlvbnM6IFJlY2lwZUhlbHBlck9wdGlvbnMpOiB7XG4gICAgaGVscGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgLyoqIOaatOmcsuWHuuadpeS+m+a1i+ivleaWreiogOmAkuW9kua3seW6piAqL1xuICAgIHN0YXRlOiB7IGRlcHRoOiBudW1iZXIgfTtcbn0ge1xuICAgIGNvbnN0IHByb2plY3RQYXRoID0gb3B0aW9ucy5wcm9qZWN0UGF0aDtcbiAgICBjb25zdCBjb250ZXh0ID0gb3B0aW9ucy5jb250ZXh0O1xuICAgIGNvbnN0IHN0YXRlID0geyBkZXB0aDogMCB9O1xuICAgIGNvbnN0IGhlbHBlcnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgICAvKiog57uf5LiA55qE44CM5Y+C5pWw5LiN5ZCI5rOV44CN6L+U5Zue77yM6aG65L6/5oqK5q2j56Gu55So5rOV5Zue57uZ5qih5Z6LICovXG4gICAgY29uc3QgaW52YWxpZE5hbWUgPSAoZXJyOiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4gKHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogZXJyb3JPZihlcnIpLFxuICAgICAgICBoaW50OiAn5ZCN5a2X55SoIGtlYmFiLWNhc2XvvIjlpoIgY3JlYXRlLTJkLXNjZW5l77yJ77yM5Y+q5YWB6K645a2X5q+NL+aVsOWtly/ngrkv5LiL5YiS57q/L+i/nuWtl+espuOAgicsXG4gICAgfSk7XG5cbiAgICBoZWxwZXJzLmZpbmRSZWNpcGVzID0gKGtleXdvcmQ/OiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBsZXQgcmVjb3JkczogUmVjaXBlUmVjb3JkW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZWNvcmRzID0gbGlzdFJlY2lwZVJlY29yZHMocHJvamVjdFBhdGgpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9yT2YoZXJyKSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbmVlZGxlID0gdHlwZW9mIGtleXdvcmQgPT09ICdzdHJpbmcnID8ga2V5d29yZC50cmltKCkudG9Mb3dlckNhc2UoKSA6ICcnO1xuICAgICAgICBjb25zdCBtYXRjaGVkID0gbmVlZGxlXG4gICAgICAgICAgICA/IHJlY29yZHMuZmlsdGVyKChyZWNvcmQpID0+IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IG1ldGEgPSByZWNvcmQubWV0YTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGhheXN0YWNrID0gW1xuICAgICAgICAgICAgICAgICAgICAgIHJlY29yZC5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIG1ldGEuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICAgICAgICAgICAgbWV0YS5yZXR1cm5zLFxuICAgICAgICAgICAgICAgICAgICAgIG1ldGEuY29udGV4dCxcbiAgICAgICAgICAgICAgICAgICAgICAuLi5PYmplY3Qua2V5cyhtZXRhLnBhcmFtcyB8fCB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgLi4uT2JqZWN0LnZhbHVlcyhtZXRhLnBhcmFtcyB8fCB7fSksXG4gICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgICAgICAgICAgIC5qb2luKCcgJylcbiAgICAgICAgICAgICAgICAgICAgICAudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBoYXlzdGFjay5pbmNsdWRlcyhuZWVkbGUpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiByZWNvcmRzO1xuXG4gICAgICAgIGNvbnN0IGl0ZW1zID0gbWF0Y2hlZC5zbGljZSgwLCBMSVNUX0xJTUlUKS5tYXAoKHJlY29yZCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgZGF5cyA9IGRheXNTaW5jZVZlcmlmaWVkKHJlY29yZC5tZXRhKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgbmFtZTogcmVjb3JkLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246IHJlY29yZC5tZXRhLmRlc2NyaXB0aW9uIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBjb250ZXh0OiByZWNvcmQubWV0YS5jb250ZXh0IHx8ICdhbnknLFxuICAgICAgICAgICAgICAgIHBhcmFtczogcmVjb3JkLm1ldGEucGFyYW1zIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICByZXR1cm5zOiByZWNvcmQubWV0YS5yZXR1cm5zIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB2ZXJpZmllZEF0OiByZWNvcmQubWV0YS52ZXJpZmllZEF0IHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAvKiog6Led5LiK5qyh6LeR6YCa5aSa5bCR5aSpIOKAlOKAlCDliKTmlq3jgIzov5jog73kuI3og73kv6HjgI3nmoTllK/kuIDkvp3mja4gKi9cbiAgICAgICAgICAgICAgICBkYXlzU2luY2VWZXJpZmllZDogZGF5cyA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGRheXMsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IHJlY29yZC5ieXRlcyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBpZiAobmVlZGxlICYmIG1hdGNoZWQubGVuZ3RoID09PSAwICYmIHJlY29yZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaChg5rKh5pyJ5Yy56YWNIFwiJHtuZWVkbGV9XCIg55qEIHJlY2lwZe+8m+eOsOaciSAke3JlY29yZHMubGVuZ3RofSDmnaHvvIzljrvmjonlhbPplK7or43lj6/nnIvlhajpg6jjgIJgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobWF0Y2hlZC5sZW5ndGggPiBMSVNUX0xJTUlUKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGDlhbEgJHttYXRjaGVkLmxlbmd0aH0g5p2h77yM5Y+q5Zue5YmNICR7TElTVF9MSU1JVH0g5p2h44CCYCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc3RhbGUgPSBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChpdGVtLmRheXNTaW5jZVZlcmlmaWVkID8/IDApID4gMzApO1xuICAgICAgICBpZiAoc3RhbGUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICBgJHtzdGFsZS5sZW5ndGh9IOadoei2hei/hyAzMCDlpKnmsqHot5HpgJrvvIjop4EgZGF5c1NpbmNlVmVyaWZpZWTvvInigJTigJTot5HkuYvliY3lhYggcmVhZFJlY2lwZSDnnIvkuIDnnLzvvIxgICtcbiAgICAgICAgICAgICAgICAgICAgJ+i/h+acn+eahCBwYXRoL0FQSSDmr5TmsqHmnIkgcmVjaXBlIOabtOWdkeOAgicsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgLyoqIOebruW9leaYr+acrOasoeaJp+ihjOaXtuaWsOW7ui/lt7LlrZjlnKjnmoTvvIzmqKHlnovkuI3pnIDopoHlhbPlv4MgKi9cbiAgICAgICAgICAgIGRpcjogcmVjaXBlc1Jvb3QocHJvamVjdFBhdGgpLFxuICAgICAgICAgICAgdG90YWw6IHJlY29yZHMubGVuZ3RoLFxuICAgICAgICAgICAgY291bnQ6IG1hdGNoZWQubGVuZ3RoLFxuICAgICAgICAgICAgcmVjaXBlczogaXRlbXMsXG4gICAgICAgICAgICAuLi4obm90ZXMubGVuZ3RoID4gMCA/IHsgbm90ZXMgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihyZWNvcmRzLmxlbmd0aCA9PT0gMFxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgIGhpbnQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICfov5jmsqHmnIkgcmVjaXBl44CC6LeR6YCa5LiA5q615aW955So55qE5Luj56CB5ZCO77yM55SoICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAnc2F2ZVJlY2lwZShcImtlYmFiLWNhc2Ut5ZCN5a2XXCIsIDzlkIzkuIDmrrXku6PnoIE+LCB7ZGVzY3JpcHRpb246XCLigKZcIiwgcGFyYW1zOnvigKZ9LCBjb250ZXh0OlwiJyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAnXCIsIHJldHVybnM6XCLigKZcIn0pIOaKiuWug+WbuuWMluS4i+adpeOAgicsXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGhlbHBlcnMucmVhZFJlY2lwZSA9IChuYW1lOiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBsZXQgcmVjb3JkOiBSZWNpcGVSZWNvcmQgfCBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmVjb3JkID0gcmVhZFJlY2lwZVJlY29yZChwcm9qZWN0UGF0aCwgU3RyaW5nKG5hbWUpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gaW52YWxpZE5hbWUoZXJyKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlY29yZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6IGDmsqHmnInlkI3kuLogXCIke1N0cmluZyhuYW1lKX1cIiDnmoQgcmVjaXBlYCxcbiAgICAgICAgICAgICAgICBoaW50OiAn5YWI55SoIGZpbmRSZWNpcGVzKCkg55yL5pyJ5ZOq5Lqb44CCJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgbmFtZTogcmVjb3JkLm5hbWUsXG4gICAgICAgICAgICBtZXRhOiByZWNvcmQubWV0YSxcbiAgICAgICAgICAgIGZpbGU6IHJlY29yZC5maWxlLFxuICAgICAgICAgICAgYnl0ZXM6IHJlY29yZC5ieXRlcyxcbiAgICAgICAgICAgIC8qKiDkuI4gZXhlY3V0ZV9jb2RlIOWQjOaehO+8jOWPr+ebtOaOpeaUueWGmeWQjuW9k+S9nOacrOasoeaJp+ihjOeahOS7o+eggSAqL1xuICAgICAgICAgICAgY29kZTogcmVjb3JkLmNvZGUsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGhlbHBlcnMuc2F2ZVJlY2lwZSA9IChcbiAgICAgICAgbmFtZTogdW5rbm93bixcbiAgICAgICAgY29kZTogdW5rbm93bixcbiAgICAgICAgbWV0YT86IHVua25vd24sXG4gICAgKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGNvZGUgIT09ICdzdHJpbmcnIHx8ICFjb2RlLnRyaW0oKSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2NvZGUg5LiN6IO95Li656m6JyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJhd05hbWUgPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lIDogU3RyaW5nKG5hbWUgPz8gJycpO1xuICAgICAgICBsZXQgbm9ybWFsaXplZDogUmVjaXBlTWV0YTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZWNpcGVNZXRhKG1ldGEsIHJhd05hbWUudHJpbSgpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gaW52YWxpZE5hbWUoZXJyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiAqKuWkjeeUqOmXqOemgSoq77ya6LeR6YCa5LqG5LiN562J5LqO5YC85b6X5a2Y44CCXG4gICAgICAgICAqXG4gICAgICAgICAqIOi/memHjOaLkuaOieeahOaYr+OAjOS4gOasoeaOoue0oueahOiusOW9leOAjeKAlOKAlOWug+S7rOeVmeWcqOWvueivnS/ov5Tlm57lgLzph4zlsLHlpJ/kuobvvIzokL3nm5jlj6rkvJpcbiAgICAgICAgICog6K6pIGBmaW5kUmVjaXBlc2Ag6YeM5aSa5LiA5p2h5Lul5ZCO6LeR5LiN6YCa55qE5Zmq5aOw77yI6L+H5pyf55qE5Luj56CB5q+U5rKh5pyJ5Luj56CB5pu05Z2R77yJ44CCXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCBnYXRlID0gY2hlY2tSZWNpcGVSZXVzYWJpbGl0eShyYXdOYW1lLnRyaW0oKSwgY29kZSwgbm9ybWFsaXplZCk7XG4gICAgICAgIGlmICghZ2F0ZS5vaykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6IGDov5nmrrXku6PnoIHov5jkuI3pgILlkIjlrZjmiJAgcmVjaXBl77yaJHtnYXRlLnByb2JsZW1zLm1hcCgocCkgPT4gcC5tZXNzYWdlKS5qb2luKCfvvJsnKX1gLFxuICAgICAgICAgICAgICAgIHByb2JsZW1zOiBnYXRlLnByb2JsZW1zLFxuICAgICAgICAgICAgICAgIGhpbnQ6XG4gICAgICAgICAgICAgICAgICAgICdyZWNpcGUg5Y+q5a2Y44CM5Lul5ZCO6L+Y6IO95YaN55So5LiA5qyh44CN55qE5Luj56CB77ya5oqK5Lya5Y+Y55qE6YOo5YiG5o+Q5oiQIGFyZ3PvvIzlhpnmuIUgZGVzY3JpcHRpb24g5LiOIHJldHVybnPvvJsnICtcbiAgICAgICAgICAgICAgICAgICAgJ+WPquWvuei/meS4gOasoeaIkOeri+eahOe7k+aenO+8jOebtOaOpSByZXR1cm4g5Ye65p2l5bCx5aW977yM5LiN55So6JC955uY44CCJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVjb3JkOiBSZWNpcGVSZWNvcmQ7XG4gICAgICAgIGxldCBvdmVyd3JpdHRlbiA9IGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc2FmZSA9IG5vcm1hbGl6ZVJlY2lwZU5hbWUocmF3TmFtZSk7XG4gICAgICAgICAgICAvLyDlhYjmjqLkuIDkuIvmmK/lkKblt7LlrZjlnKgg4oCU4oCUIOimhuebluWIq+S6uueahCByZWNpcGUg5piv5Lu26K+l6KKr55+l6YGT55qE5LqLXG4gICAgICAgICAgICBvdmVyd3JpdHRlbiA9IGZzLmV4aXN0c1N5bmMocmVjaXBlRmlsZShwcm9qZWN0UGF0aCwgc2FmZSkpO1xuICAgICAgICAgICAgLy8g5rKh5YaZIGNvbnRleHQg5bCx6K6w5oiQ5b2T5YmN5LiK5LiL5paHIOKAlOKAlCDov5nmmK/mnIDmnInnlKjnmoTpu5jorqTlgLxcbiAgICAgICAgICAgIGlmICghbm9ybWFsaXplZC5jb250ZXh0KSBub3JtYWxpemVkLmNvbnRleHQgPSBjb250ZXh0O1xuICAgICAgICAgICAgcmVjb3JkID0gd3JpdGVSZWNpcGVSZWNvcmQocHJvamVjdFBhdGgsIHNhZmUsIGNvZGUsIG5vcm1hbGl6ZWQpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiBpbnZhbGlkTmFtZShlcnIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIG5hbWU6IHJlY29yZC5uYW1lLFxuICAgICAgICAgICAgb3ZlcndyaXR0ZW4sXG4gICAgICAgICAgICBmaWxlOiByZWNvcmQuZmlsZSxcbiAgICAgICAgICAgIGJ5dGVzOiByZWNvcmQuYnl0ZXMsXG4gICAgICAgICAgICBtZXRhOiByZWNvcmQubWV0YSxcbiAgICAgICAgICAgIC4uLihnYXRlLndhcm5pbmdzLmxlbmd0aCA+IDAgPyB7IHdhcm5pbmdzOiBnYXRlLndhcm5pbmdzIH0gOiB7fSksXG4gICAgICAgICAgICBoaW50OiBg5Lul5ZCO5Y+v5LulIHJ1blJlY2lwZShcIiR7cmVjb3JkLm5hbWV9XCIsIGFyZ3MpIOebtOaOpei3keOAgmAsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGhlbHBlcnMucnVuUmVjaXBlID0gYXN5bmMgKFxuICAgICAgICBuYW1lOiB1bmtub3duLFxuICAgICAgICByZWNpcGVBcmdzPzogdW5rbm93bixcbiAgICAgICAgb3B0cz86IHsgdGltZW91dE1zPzogbnVtYmVyIH0sXG4gICAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPT4ge1xuICAgICAgICBsZXQgcmVjb3JkOiBSZWNpcGVSZWNvcmQgfCBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmVjb3JkID0gcmVhZFJlY2lwZVJlY29yZChwcm9qZWN0UGF0aCwgU3RyaW5nKG5hbWUpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gaW52YWxpZE5hbWUoZXJyKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlY29yZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6IGDmsqHmnInlkI3kuLogXCIke1N0cmluZyhuYW1lKX1cIiDnmoQgcmVjaXBlYCxcbiAgICAgICAgICAgICAgICBoaW50OiAn5YWI55SoIGZpbmRSZWNpcGVzKCkg55yL5pyJ5ZOq5Lqb44CCJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZWNvcmQuY29kZS50cmltKCkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGByZWNpcGUgXCIke3JlY29yZC5uYW1lfVwiIOeahOS7o+eggeS9k+aYr+epuueahGAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWNvbnRleHRNYXRjaGVzKHJlY29yZC5tZXRhLCBjb250ZXh0KSkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6XG4gICAgICAgICAgICAgICAgICAgIGByZWNpcGUgXCIke3JlY29yZC5uYW1lfVwiIOWjsOaYjiBjb250ZXh0PVwiJHtyZWNvcmQubWV0YS5jb250ZXh0fVwi77yMYCArXG4gICAgICAgICAgICAgICAgICAgIGDkvYblvZPliY3miafooYzkuIrkuIvmlofmmK8gXCIke2NvbnRleHR9XCLjgIJgLFxuICAgICAgICAgICAgICAgIGhpbnQ6IGDmiorov5nmrKEgZXhlY3V0ZV9jb2RlIOeahCBjb250ZXh0IOaUueaIkCBcIiR7cmVjb3JkLm1ldGEuY29udGV4dH1cIiDlho3ot5HjgIJgLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3RhdGUuZGVwdGggPj0gTUFYX1JFQ0lQRV9ERVBUSCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6IGByZWNpcGUg5bWM5aWX6L+H5rex77yIPiR7TUFYX1JFQ0lQRV9ERVBUSH3vvInvvJoke3JlY29yZC5uYW1lfWAsXG4gICAgICAgICAgICAgICAgaGludDogJ+ajgOafpeaYr+S4jeaYr+acieW+queOr+W8leeUqO+8iEEg6LCDIELjgIFCIOWPiOiwgyBB77yJ44CCJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0aW1lb3V0TXMgPVxuICAgICAgICAgICAgdHlwZW9mIG9wdHM/LnRpbWVvdXRNcyA9PT0gJ251bWJlcicgJiYgb3B0cy50aW1lb3V0TXMgPiAwXG4gICAgICAgICAgICAgICAgPyBNYXRoLm1pbihvcHRzLnRpbWVvdXRNcywgNjAwMDAwKVxuICAgICAgICAgICAgICAgIDogb3B0aW9ucy5kZWZhdWx0VGltZW91dE1zID8/IDE1MDAwO1xuXG4gICAgICAgIC8vIOeUqCBPYmplY3QuY3JlYXRlKG51bGwpIOWBmuWFpeWPguWuueWZqO+8mnJlY2lwZSDph4zlhpkgYXJncy5oYXNPd25Qcm9wZXJ0eSDkuYvnsbvnmoRcbiAgICAgICAgLy8g5LiN5Lya5pKe5LiKIE9iamVjdC5wcm90b3R5cGXvvIjmspnnrrHph4zmiJHku6zmnKzmnaXlsLHnu5nnmoTmmK/lh4DljJbov4fnmoTlr7nosaHvvInjgIJcbiAgICAgICAgY29uc3QgY2FsbEFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIGlmIChyZWNpcGVBcmdzICYmIHR5cGVvZiByZWNpcGVBcmdzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShyZWNpcGVBcmdzKSkge1xuICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVjaXBlQXJncyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgICAgICAgICBjYWxsQXJnc1trZXldID0gdmFsdWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAocmVjaXBlQXJncyAhPT0gdW5kZWZpbmVkICYmIHJlY2lwZUFyZ3MgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGNhbGxBcmdzLnZhbHVlID0gcmVjaXBlQXJncztcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgICAgIHN0YXRlLmRlcHRoICs9IDE7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgb3B0aW9ucy5nZXRSdW5uZXIoKShyZWNvcmQuY29kZSwgY2FsbEFyZ3MsIHRpbWVvdXRNcyk7XG4gICAgICAgICAgICBjb25zdCBkdXJhdGlvbk1zID0gb3V0Y29tZS5kdXJhdGlvbk1zID8/IERhdGUubm93KCkgLSBzdGFydGVkQXQ7XG4gICAgICAgICAgICBpZiAoIW91dGNvbWUub2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIHJlY2lwZTogcmVjb3JkLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICAgICAgICAgIGR1cmF0aW9uTXMsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBvdXRjb21lLmVycm9yLFxuICAgICAgICAgICAgICAgICAgICAuLi4ob3V0Y29tZS50aW1lZE91dCA/IHsgdGltZWRPdXQ6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgLi4uKG91dGNvbWUubG9ncyA/IHsgbG9nczogb3V0Y29tZS5sb2dzIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgIGhpbnQ6IGByZWNpcGUgXCIke3JlY29yZC5uYW1lfVwiIOaJp+ihjOWksei0peOAgueUqCByZWFkUmVjaXBlKFwiJHtyZWNvcmQubmFtZX1cIikg55yL5a6D55qE5Luj56CB77yM5oiW55u05o6l5pS55a6D44CCYCxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdmVyaWZpZWRBdCA9IHRvdWNoUmVjaXBlVmVyaWZpZWQocHJvamVjdFBhdGgsIHJlY29yZC5uYW1lKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICAgICAgcmVjaXBlOiByZWNvcmQubmFtZSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICAgIGR1cmF0aW9uTXMsXG4gICAgICAgICAgICAgICAgcmVzdWx0OiBvdXRjb21lLnJlc3VsdCxcbiAgICAgICAgICAgICAgICAuLi4ob3V0Y29tZS5sb2dzID8geyBsb2dzOiBvdXRjb21lLmxvZ3MgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAuLi4odmVyaWZpZWRBdCA/IHsgdmVyaWZpZWRBdCB9IDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlY2lwZTogcmVjb3JkLm5hbWUsIGVycm9yOiBlcnJvck9mKGVycikgfTtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIHN0YXRlLmRlcHRoIC09IDE7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgaGVscGVycy5kZWxldGVSZWNpcGUgPSAobmFtZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZWQgPSBkZWxldGVSZWNpcGVSZWNvcmQocHJvamVjdFBhdGgsIFN0cmluZyhuYW1lKSk7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3ZlZFxuICAgICAgICAgICAgICAgID8geyBvazogdHJ1ZSwgbmFtZTogU3RyaW5nKG5hbWUpLCBkZWxldGVkOiB0cnVlIH1cbiAgICAgICAgICAgICAgICA6IHsgb2s6IGZhbHNlLCBuYW1lOiBTdHJpbmcobmFtZSksIGRlbGV0ZWQ6IGZhbHNlLCBlcnJvcjogJ+aWh+S7tuS4jeWtmOWcqCcgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gaW52YWxpZE5hbWUoZXJyKTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICByZXR1cm4geyBoZWxwZXJzLCBzdGF0ZSB9O1xufVxuXG4vKiogYGRlc2NyaWJlX2FwaWAg5LiOIGBoZWxwZXJOYW1lcygpYCDlhbHnlKjnmoTliqnmiYvnrb7lkI3muIXljZUgKi9cbmV4cG9ydCBjb25zdCBSRUNJUEVfSEVMUEVSX1NJR05BVFVSRVM6IFJlYWRvbmx5QXJyYXk8c3RyaW5nPiA9IFtcbiAgICAnZmluZFJlY2lwZXMoa2V5d29yZD8pIOKGkiB7Y291bnQsIHJlY2lwZXM6W3tuYW1lLCBkZXNjcmlwdGlvbiwgY29udGV4dCwgcGFyYW1zLCByZXR1cm5zLCBkYXlzU2luY2VWZXJpZmllZH1dfScsXG4gICAgJ3JlYWRSZWNpcGUobmFtZSkg4oaSIHttZXRhLCBjb2RlfSAgLy8g5oOz5pS55YaZ5aSN55So5bCx5YWI6K+75Ye65p2lJyxcbiAgICAnc2F2ZVJlY2lwZShuYW1lLCBjb2RlLCBtZXRhPykg4oaSIHtmaWxlLCBvdmVyd3JpdHRlbiwgd2FybmluZ3M/fSAgLy8gbWV0YT17ZGVzY3JpcHRpb24sIHBhcmFtcywgY29udGV4dCwgcmV0dXJuc33vvJsqKui/h+S4jeS6huWkjeeUqOmXqOemgeS8muiiq+aLkioq77yI6KaB5Y+C5pWw5YyW44CB5peg5LiA5qyh5oCn5YC877yJJyxcbiAgICAncnVuUmVjaXBlKG5hbWUsIGFyZ3M/LCB7dGltZW91dE1zfT8pIOKGkiB7cmVzdWx0LCBsb2dzLCBkdXJhdGlvbk1zfScsXG4gICAgJ2RlbGV0ZVJlY2lwZShuYW1lKSDihpIge2RlbGV0ZWR9Jyxcbl07XG5cbmNvbnN0IFJFQ0lQRV9SRUFETUUgPSBgIyAuZHNoLW1jcCDigJTigJQgZHNoX2NoYXQg55qEIHJlY2lwZSDlrZjmlL7lpIRcblxu6L+Z6YeM5a2Y55qE5pivKirot5HpgJrov4fjgIHkuJTku6XlkI7ov5jog73lho3nlKjkuIDmrKHnmoTlj6/miafooYzku6PnoIEqKu+8iHJlY2lwZe+8ie+8jOS4jeaYr+aWh+aho+OAglxuXG4tIOavj+adoSByZWNpcGUg5LiA5LiqIFxcYC5qc1xcYCDmlofku7bvvIzlhYPmlbDmja7lhoXltYzlnKjmlofku7blpLTnmoQgXFxgLyogQGRzaC1yZWNpcGUge+KApn0gKi9cXGAg6YeM44CCXG4tIOS7o+eggeS9k+S4jiBcXGBjb2Nvc19leGVjdXRlX2NvZGVcXGAg6YeM5YaZ55qE5Luj56CBKirlrozlhajlkIzmnoQqKu+8mumhtuWxguWPryBcXGByZXR1cm5cXGAgLyBcXGBhd2FpdFxcYO+8jFxcYGFyZ3NcXGAg5piv5YWl5Y+C44CCXG4tIEFJIOS+p+WFpeWPo++8iOmDveaYr+aymeeusemHjOeahOWKqeaJi++8jOS4jeaYr+eLrOeri+W3peWFt++8ie+8mlxuICBcXGBmaW5kUmVjaXBlcyjlhbPplK7or40/KVxcYCAvIFxcYHJlYWRSZWNpcGUobmFtZSlcXGAgLyBcXGBzYXZlUmVjaXBlKG5hbWUsIGNvZGUsIG1ldGE/KVxcYCAvXG4gIFxcYHJ1blJlY2lwZShuYW1lLCBhcmdzPylcXGAgLyBcXGBkZWxldGVSZWNpcGUobmFtZSlcXGDjgIJcblxuIyMg5a2Y6L+b5p2l55qE6Zeo5qeb77yI5aSN55So6Zeo56aB77yJXG5cblxcYHNhdmVSZWNpcGVcXGAg5LyaKirmi5Lnu50qKuOAjOS4gOasoeaOoue0oueahOiusOW9leOAje+8jOWPquaUtuOAjOS7peWQjui/mOiDveWGjeeUqOS4gOasoeOAjeeahOS7o+egge+8mlxuXG4tIOW/heWhqyBcXGBkZXNjcmlwdGlvblxcYO+8iOi/meauteS7o+eggeW5suS7gOS5iO+8ieS4jiBcXGByZXR1cm5zXFxg77yI5aSN55So5a6D6IO955yL5Yiw5LuA5LmI77yJ77ybXG4tIFxcYHBhcmFtc1xcYCDlo7DmmI7nmoTmr4/kuKrplK7vvIzku6PnoIHph4zlv4XpobvnnJ/nmoTnlKjliLAgXFxgYXJncy486ZSuPlxcYO+8m1xuLSDku6PnoIHph4zkuI3orrjmnInlhbfkvZMgdXVpZOOAgee7neWvuei3r+W+hOOAgVxcYC50bXAvXFxgIOi/meexu+S4gOasoeaAp+WAvO+8iOW6lOW9k+i1sCBcXGBhcmdzXFxg77yJ77ybXG4tIOWQjeWtl+mHjOS4jeiuuOW4puaXpeacny/ml7bpl7TmiLPjgIJcblxuKirlu7rorq7lhaXlupMqKu+8iOi3n+edgOW3peeoi+i1sO+8jOWboumYn+WFseS6q++8ieOAguS4jeaDs+WFseS6q+WwseaKiuWug+WKoOi/myBcXGAuZ2l0aWdub3JlXFxg44CCXG5cbuS4uuS7gOS5iOS4jeWBmuS4gOS4quOAjOW3peeoi+efpeivhuW6kyBKU09O44CN77ya6L+H5pyf55qE5LqL5a6e5q+U5rKh5pyJ5LqL5a6e5pu057Of77yM6ICM6L+H5pyf55qE5Luj56CB5Lya5b2T5Zy65oql6ZSZ44CCXG7lt6XnqIvkuJPmnInnmoTmtYHnqIvkuI7lnZHngrnor7flhpnov5sgXFxgLmFnZW50cy9za2lsbHMvXFxg77yM6YKj6YeM5Lq66IO9562W5bGV44CB6IO9IHJldmlld+OAglxuYDtcbiJdfQ==