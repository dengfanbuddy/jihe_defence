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

import * as fs from 'fs';
import * as path from 'path';

/** 工程根下的存放目录（可入库；不写进 .gitignore 是有意的） */
export const RECIPE_DIR_NAME = '.dsh-mcp';

/** 存放目录下的子目录名 */
export const RECIPE_SUBDIR = 'recipes';

/** recipe 文件扩展名 */
export const RECIPE_EXT = '.js';

/** 元数据块标记 */
const MARKER = '@dsh-recipe';

/** recipe 可以在哪个上下文跑 */
export type RecipeContext = 'editor' | 'scene' | 'any';

export interface RecipeMeta {
    name: string;
    /** 一句话说清「这代码干什么」—— 它同时是 `findRecipes` 的检索文本 */
    description?: string;
    /** 入参说明：key 是 `args` 上的字段名 */
    params?: Record<string, string>;
    /** 该在哪个上下文执行；`any` 或不写 = 都行 */
    context?: RecipeContext;
    /** 返回值说明（给调用方看「能拿到什么」） */
    returns?: string;
    /** 首次落盘时间（ISO） */
    createdAt?: string;
    /** 最近一次成功执行的时间（ISO）—— 过期判断的唯一依据 */
    verifiedAt?: string;
}

export interface RecipeRecord {
    name: string;
    meta: RecipeMeta;
    /** 可执行代码体（不含元数据块） */
    code: string;
    /** 绝对路径 */
    file: string;
    /** 文件字节数 */
    bytes: number;
}

/** recipe 根目录（不保证存在） */
export function recipesRoot(projectPath: string): string {
    return path.join(projectPath, RECIPE_DIR_NAME, RECIPE_SUBDIR);
}

/**
 * 把用户给的 recipe 名规范化成安全文件名。
 *
 * 只放行 `[A-Za-z0-9._-]`：名字要跨平台、要能直接当文件名，
 * 而且**必须挡住路径穿越**（`../../foo` 会写到工程外面去）。
 */
export function normalizeRecipeName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) throw new Error('recipe 名不能为空');
    if (name.length > 80) throw new Error(`recipe 名过长（${name.length} > 80）：${name}`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(
            `recipe 名只允许字母/数字/点/下划线/连字符，收到：${name}（提示：用 kebab-case，如 create-2d-scene）`,
        );
    }
    // `.` 与 `..` 单独成名的路径穿越
    if (name === '.' || name === '..') throw new Error(`recipe 名非法：${name}`);
    return name;
}

/** recipe 文件绝对路径 */
export function recipeFile(projectPath: string, name: string): string {
    return path.join(recipesRoot(projectPath), `${normalizeRecipeName(name)}${RECIPE_EXT}`);
}

/**
 * 解析 recipe 源码 → 元数据 + 代码体。
 *
 * 刻意写得「坏输入不抛异常」：读到一个手写坏的 recipe 不应该让整次 `findRecipes` 崩掉，
 * 而是让它以「无元数据」的姿态出现在列表里，模型自己决定要不要打开看。
 */
export function parseRecipe(source: unknown): { meta: RecipeMeta; code: string } {
    const text = typeof source === 'string' ? source : '';
    const fallback = { meta: { name: '' } as RecipeMeta, code: text };

    const markerAt = text.indexOf(MARKER);
    if (markerAt < 0) return fallback;
    const blockStart = text.indexOf('/*', markerAt >= 3 ? markerAt - 3 : 0);
    if (blockStart < 0) return fallback;
    const blockEnd = text.indexOf('*/', markerAt);
    if (blockEnd < 0) return fallback;

    const jsonText = text.slice(markerAt + MARKER.length, blockEnd).trim();
    let meta: RecipeMeta;
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
        meta = parsed as RecipeMeta;
    } catch {
        return fallback;
    }

    // 代码体 = 元数据块之后的所有内容（去掉紧随其后的一个换行，让行号从 1 开始像用户写的那样）
    let code = text.slice(blockEnd + 2);
    if (code.startsWith('\r\n')) code = code.slice(2);
    else if (code.startsWith('\n')) code = code.slice(1);

    return { meta, code };
}

/** 组装 recipe 文件内容（元数据块 + 代码体） */
export function formatRecipe(name: string, code: string, meta: Partial<RecipeMeta> = {}): string {
    const normalized: RecipeMeta = { ...meta, name };
    // 固定 key 顺序，让 git diff 稳定（不然每次保存字段顺序都可能变）
    const ordered: Record<string, unknown> = { name: normalized.name };
    for (const key of ['description', 'context', 'params', 'returns', 'createdAt', 'verifiedAt'] as const) {
        const value = normalized[key];
        if (value !== undefined && value !== null && value !== '') ordered[key] = value;
    }
    const body = code.endsWith('\n') ? code : `${code}\n`;
    return `/* ${MARKER}\n${JSON.stringify(ordered, null, 2)}\n*/\n${body}`;
}

/** 把参数说明归一化成 `{字段名: 说明}`（接受数组或对象两种写法） */
function normalizeParams(raw: unknown): Record<string, string> | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) {
        const out: Record<string, string> = {};
        for (const item of raw) {
            if (typeof item === 'string' && item.trim()) out[item.trim()] = '';
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    if (typeof raw === 'object') {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            out[key] = typeof value === 'string' ? value : String(value ?? '');
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    return undefined;
}

/** 规范化调用方给的元数据（保存路径与解析路径共用，保证两侧口径一致） */
export function normalizeRecipeMeta(raw: unknown, fallbackName?: string): RecipeMeta {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const meta: RecipeMeta = {
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallbackName || '',
    };
    if (typeof input.description === 'string' && input.description.trim()) {
        meta.description = input.description.trim();
    }
    const params = normalizeParams(input.params);
    if (params) meta.params = params;
    if (input.context === 'editor' || input.context === 'scene' || input.context === 'any') {
        meta.context = input.context;
    }
    if (typeof input.returns === 'string' && input.returns.trim()) meta.returns = input.returns.trim();
    if (typeof input.createdAt === 'string' && input.createdAt) meta.createdAt = input.createdAt;
    if (typeof input.verifiedAt === 'string' && input.verifiedAt) meta.verifiedAt = input.verifiedAt;
    return meta;
}

/**
 * 列出全部 recipe。
 *
 * 目录不存在 → 空数组（**不是异常**）：第一次用的人不该看到一条报错。
 * 坏文件 → 以无元数据的形态列出，而不是整个列表失败。
 */
export function listRecipeRecords(projectPath: string): RecipeRecord[] {
    const root = recipesRoot(projectPath);
    let entries: string[];
    try {
        entries = fs.readdirSync(root);
    } catch {
        return [];
    }

    const out: RecipeRecord[] = [];
    for (const entry of entries.sort()) {
        if (!entry.toLowerCase().endsWith(RECIPE_EXT)) continue;
        const file = path.join(root, entry);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;

        const fallbackName = entry.slice(0, -RECIPE_EXT.length);
        let raw = '';
        try {
            raw = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        const parsed = parseRecipe(raw);
        const meta = normalizeRecipeMeta(parsed.meta, fallbackName);
        if (!meta.name) meta.name = fallbackName;
        out.push({ name: meta.name, meta, code: parsed.code, file, bytes: stat.size });
    }
    return out;
}

/** 读单条 recipe；不存在返回 null */
export function readRecipeRecord(projectPath: string, name: string): RecipeRecord | null {
    const file = recipeFile(projectPath, name);
    let raw: string;
    let bytes = 0;
    try {
        raw = fs.readFileSync(file, 'utf-8');
        bytes = fs.statSync(file).size;
    } catch {
        return null;
    }
    const parsed = parseRecipe(raw);
    const meta = normalizeRecipeMeta(parsed.meta, normalizeRecipeName(name));
    if (!meta.name) meta.name = normalizeRecipeName(name);
    return { name: meta.name, meta, code: parsed.code, file, bytes };
}

/**
 * 落盘一条 recipe（幂等覆盖）。
 *
 * `createdAt` 在**已存在**时沿用旧值 —— 否则每次保存都刷新「创建时间」，
 * 那个字段就没意义了。`verifiedAt` 同理沿用（由 {@link touchRecipeVerified} 单独推进）。
 */
export function writeRecipeRecord(
    projectPath: string,
    name: string,
    code: string,
    meta: Partial<RecipeMeta> = {},
): RecipeRecord {
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
    normalized.createdAt = previous?.meta.createdAt || normalized.createdAt || now;
    if (previous?.meta.verifiedAt) normalized.verifiedAt = normalized.verifiedAt || previous.meta.verifiedAt;

    const text = formatRecipe(safeName, code, normalized);
    const file = recipeFile(projectPath, safeName);
    fs.writeFileSync(file, text, 'utf-8');
    const bytes = Buffer.byteLength(text, 'utf-8');

    // 目录里放一份说明，免得人类看到 `.dsh-mcp/` 不知道这是什么、该不该入库
    const readme = path.join(path.dirname(root), 'README.md');
    if (!fs.existsSync(readme)) {
        try {
            fs.writeFileSync(readme, RECIPE_README, 'utf-8');
        } catch {
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
export function deleteRecipeRecord(projectPath: string, name: string): boolean {
    const file = recipeFile(projectPath, name);
    try {
        fs.unlinkSync(file);
        return true;
    } catch {
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
export function touchRecipeVerified(projectPath: string, name: string): string | null {
    let record: RecipeRecord | null;
    try {
        record = readRecipeRecord(projectPath, name);
    } catch {
        return null;
    }
    if (!record) return null;

    const now = new Date();
    const previous = record.meta.verifiedAt ? new Date(record.meta.verifiedAt) : null;
    const sameDay =
        previous instanceof Date &&
        !Number.isNaN(previous.getTime()) &&
        previous.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    if (sameDay) return null;

    const iso = now.toISOString();
    try {
        const text = formatRecipe(record.name, record.code, { ...record.meta, verifiedAt: iso });
        fs.writeFileSync(record.file, text, 'utf-8');
    } catch {
        return null;
    }
    return iso;
}

/** 距离上次验证过了多少天（没验证过返回 null） */
export function daysSinceVerified(meta: RecipeMeta, now: number = Date.now()): number | null {
    if (!meta.verifiedAt) return null;
    const at = new Date(meta.verifiedAt).getTime();
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.floor((now - at) / 86400000));
}

/** `context` 与当前执行上下文是否相容 */
export function contextMatches(meta: RecipeMeta, current: 'editor' | 'scene'): boolean {
    const want = meta.context;
    if (!want || want === 'any') return true;
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
const ONE_OFF_PATTERNS: ReadonlyArray<{ id: string; re: RegExp; hint: string }> = [
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

/** 门禁结论：`problems` 非空即拒绝落盘；`warnings` 只提示。 */
export interface RecipeReuseCheckResult {
    ok: boolean;
    problems: Array<{ id: string; message: string; hint?: string }>;
    warnings: string[];
}

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
export function checkRecipeReusability(
    name: string,
    code: string,
    meta: Pick<RecipeMeta, 'description' | 'returns' | 'params'>,
): RecipeReuseCheckResult {
    const problems: RecipeReuseCheckResult['problems'] = [];
    const warnings: string[] = [];

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
        warnings.push(
            '没有声明任何参数：只能原样重跑。如果它确实每次都一样（纯查询），可以不管；' +
                '否则把会变的部分提成 args 再存。',
        );
    } else {
        for (const [key, text] of params) {
            if (!key) continue;
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

// ---------------------------------------------------------------------------
// 沙箱助手工厂 —— 注入 execute_code 的助手函数（不是独立 MCP tool）
// ---------------------------------------------------------------------------

/** 一次 recipe 执行的产出（各上下文把自家的执行结果适配成它） */
export interface RecipeRunOutcome {
    ok: boolean;
    result?: unknown;
    error?: unknown;
    logs?: unknown;
    durationMs?: number;
    timedOut?: boolean;
}

/**
 * 执行一段 recipe 代码体。
 *
 * **由调用方注入**，因为两个上下文的执行机制完全不同：
 * editor 走 `vm.createContext` 沙箱，scene 走场景进程的 `vm.runInThisContext`。
 * 本模块只负责「取代码 / 判断能不能跑 / 记账」，不关心怎么跑。
 */
export type RecipeRunner = (
    code: string,
    args: Record<string, unknown>,
    timeoutMs: number,
) => Promise<RecipeRunOutcome>;

export interface RecipeHelperOptions {
    /** 工程根绝对路径（editor 与 scene 都能拿到 `Editor.Project.path`） */
    projectPath: string;
    /** 当前执行上下文，用于校验 recipe 的 `context` 声明 */
    context: 'editor' | 'scene';
    /** 取执行器。**惰性**：helpers 与执行器互相引用，必须晚绑定 */
    getRunner: () => RecipeRunner;
    /** runRecipe 未指定超时时的默认值 */
    defaultTimeoutMs?: number;
}

/** 列表最多回这么多条，避免把上下文灌满 */
const LIST_LIMIT = 40;

/** recipe 互相调用的最大深度（允许组合，但不允许跑飞） */
const MAX_RECIPE_DEPTH = 4;

function errorOf(err: unknown): string {
    if (err && typeof err === 'object') {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message) return message;
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
export function buildRecipeHelpers(options: RecipeHelperOptions): {
    helpers: Record<string, unknown>;
    /** 暴露出来供测试断言递归深度 */
    state: { depth: number };
} {
    const projectPath = options.projectPath;
    const context = options.context;
    const state = { depth: 0 };
    const helpers: Record<string, unknown> = {};

    /** 统一的「参数不合法」返回，顺便把正确用法回给模型 */
    const invalidName = (err: unknown): Record<string, unknown> => ({
        ok: false,
        error: errorOf(err),
        hint: '名字用 kebab-case（如 create-2d-scene），只允许字母/数字/点/下划线/连字符。',
    });

    helpers.findRecipes = (keyword?: unknown): Record<string, unknown> => {
        let records: RecipeRecord[];
        try {
            records = listRecipeRecords(projectPath);
        } catch (err) {
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

        const notes: string[] = [];
        if (needle && matched.length === 0 && records.length > 0) {
            notes.push(`没有匹配 "${needle}" 的 recipe；现有 ${records.length} 条，去掉关键词可看全部。`);
        }
        if (matched.length > LIST_LIMIT) {
            notes.push(`共 ${matched.length} 条，只回前 ${LIST_LIMIT} 条。`);
        }
        const stale = items.filter((item) => (item.daysSinceVerified ?? 0) > 30);
        if (stale.length > 0) {
            notes.push(
                `${stale.length} 条超过 30 天没跑通（见 daysSinceVerified）——跑之前先 readRecipe 看一眼，` +
                    '过期的 path/API 比没有 recipe 更坑。',
            );
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
                      hint:
                          '还没有 recipe。跑通一段好用的代码后，用 ' +
                          'saveRecipe("kebab-case-名字", <同一段代码>, {description:"…", params:{…}, context:"' +
                          context +
                          '", returns:"…"}) 把它固化下来。',
                  }
                : {}),
        };
    };

    helpers.readRecipe = (name: unknown): Record<string, unknown> => {
        let record: RecipeRecord | null;
        try {
            record = readRecipeRecord(projectPath, String(name));
        } catch (err) {
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

    helpers.saveRecipe = (
        name: unknown,
        code: unknown,
        meta?: unknown,
    ): Record<string, unknown> => {
        if (typeof code !== 'string' || !code.trim()) {
            return { ok: false, error: 'code 不能为空' };
        }
        const rawName = typeof name === 'string' ? name : String(name ?? '');
        let normalized: RecipeMeta;
        try {
            normalized = normalizeRecipeMeta(meta, rawName.trim());
        } catch (err) {
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
                hint:
                    'recipe 只存「以后还能再用一次」的代码：把会变的部分提成 args，写清 description 与 returns；' +
                    '只对这一次成立的结果，直接 return 出来就好，不用落盘。',
            };
        }

        let record: RecipeRecord;
        let overwritten = false;
        try {
            const safe = normalizeRecipeName(rawName);
            // 先探一下是否已存在 —— 覆盖别人的 recipe 是件该被知道的事
            overwritten = fs.existsSync(recipeFile(projectPath, safe));
            // 没写 context 就记成当前上下文 —— 这是最有用的默认值
            if (!normalized.context) normalized.context = context;
            record = writeRecipeRecord(projectPath, safe, code, normalized);
        } catch (err) {
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

    helpers.runRecipe = async (
        name: unknown,
        recipeArgs?: unknown,
        opts?: { timeoutMs?: number },
    ): Promise<Record<string, unknown>> => {
        let record: RecipeRecord | null;
        try {
            record = readRecipeRecord(projectPath, String(name));
        } catch (err) {
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
                error:
                    `recipe "${record.name}" 声明 context="${record.meta.context}"，` +
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

        const timeoutMs =
            typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0
                ? Math.min(opts.timeoutMs, 600000)
                : options.defaultTimeoutMs ?? 15000;

        // 用 Object.create(null) 做入参容器：recipe 里写 args.hasOwnProperty 之类的
        // 不会撞上 Object.prototype（沙箱里我们本来就给的是净化过的对象）。
        const callArgs: Record<string, unknown> = {};
        if (recipeArgs && typeof recipeArgs === 'object' && !Array.isArray(recipeArgs)) {
            for (const [key, value] of Object.entries(recipeArgs as Record<string, unknown>)) {
                callArgs[key] = value;
            }
        } else if (recipeArgs !== undefined && recipeArgs !== null) {
            callArgs.value = recipeArgs;
        }

        const startedAt = Date.now();
        state.depth += 1;
        try {
            const outcome = await options.getRunner()(record.code, callArgs, timeoutMs);
            const durationMs = outcome.durationMs ?? Date.now() - startedAt;
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
        } catch (err) {
            return { ok: false, recipe: record.name, error: errorOf(err) };
        } finally {
            state.depth -= 1;
        }
    };

    helpers.deleteRecipe = (name: unknown): Record<string, unknown> => {
        try {
            const removed = deleteRecipeRecord(projectPath, String(name));
            return removed
                ? { ok: true, name: String(name), deleted: true }
                : { ok: false, name: String(name), deleted: false, error: '文件不存在' };
        } catch (err) {
            return invalidName(err);
        }
    };

    return { helpers, state };
}

/** `describe_api` 与 `helperNames()` 共用的助手签名清单 */
export const RECIPE_HELPER_SIGNATURES: ReadonlyArray<string> = [
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
