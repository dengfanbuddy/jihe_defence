/**
 * 编辑器执行引擎 —— dsh_chat 自己的「代码沙箱」，不再借 dfan_mcp2。
 *
 * ## 这一层在哪、干什么
 *
 * ```
 * DSH 子进程 --fork IPC--> 本扩展主进程(cocos-tools) --> 本模块
 *                                                     ├─ editor 上下文：vm 沙箱（core/sandbox）
 *                                                     └─ scene 上下文：本扩展的场景脚本（source/scene.ts）
 * ```
 *
 * 全程**不经过 loopback HTTP**（对比 MCP 的 127.0.0.1:8731），也不经过第二个扩展：
 * 场景脚本是本扩展 `contributions.scene` 自己注册的（`dist/scene.js`），
 * 主进程侧的执行器就是本文件。能力面与原先复用的那套**逐条对齐**：
 * 同一套超时口径、同一套序列化上限、同一套助手（`eachNode` / `tree` / `nodeByPath` /
 * `dump` / `snapshot` / recipe 五件套 …），所以模型的用法一个字都不用改。
 *
 * ## 为什么 editor 与 scene 的执行方式不同（不能统一）
 *
 * - **editor（本模块）**：`vm.createContext` 隔离沙箱。主进程里跑，隔离越严越好。
 * - **scene（source/scene.ts）**：`vm.runInThisContext` 同 realm + 同步超时。
 *   引擎进程**不能**换 realm —— 沙箱里造出来的 `{}` / `[]` 在引擎的 `instanceof` 判断下为假，
 *   会让一堆引擎 API 出现难查的诡异行为。细节见 scene.ts 头部注释。
 *
 * ## 超时的诚实边界
 *
 * `vm` 的 `timeout` 只管同步段；异步靠 `Promise.race` 计时器 —— 它只让**调用方**不再等，
 * **不会真的杀掉**已经在跑的异步代码（Node 没有抢占式取消）。
 * 所以别在沙箱里写 `await new Promise(() => {})` 这种不可结束的等待。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type ToolReply } from '../constants';
import {
    buildRecipeHelpers,
    RECIPE_HELPER_SIGNATURES,
    type RecipeRunner,
    type RecipeRunOutcome,
} from './recipes';
import { callSceneScript, SceneUnavailableError } from './scene-bridge';
import { runInSandbox } from './sandbox';
import { formatInline, safeSerialize, type SerializeOptions } from './serialize';

export type CodeContext = 'editor' | 'scene';

/** 扩展包根目录（`dist/core/engine.js` 往上两级）。 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/** 沙箱默认值（原先在 dfan_mcp2 的设置面板里调；本扩展不设面板，改成常量 + 单处可改）。 */
const SANDBOX_DEFAULTS = {
    /** `cocos_execute_code` 没传 timeoutMs 时的默认超时 */
    timeoutMs: 15000,
    maxLogs: 200,
    maxLogLength: 4000,
};

/** 返回值序列化上限：深度 6 / 数组 100 / 对象 60 键 / 单字符串 4000 字（与工具描述里写的一致）。 */
const SERIALIZE_OPTIONS: Partial<SerializeOptions> = {
    maxDepth: 6,
    maxArrayLength: 100,
    maxObjectKeys: 60,
    maxStringLength: 4000,
};

/** 场景脚本注册的方法名（与 package.json 的 `contributions.scene.methods` 对齐）。 */
const SCENE_METHOD = {
    ping: 'ping',
    runCode: 'runCode',
    describeApi: 'describeApi',
} as const;

/** 把任意异常收敛成一句话。 */
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// editor 上下文的沙箱全局量
// ---------------------------------------------------------------------------

/**
 * 暴露给沙箱的 `process` 视图。
 *
 * 刻意裁掉 `exit` / `kill` / `env`：
 * - `exit` 会让编辑器主进程直接挂掉（AI 手滑一次就得重启编辑器，还可能丢未保存的场景）；
 * - `env` 里常有 token/密钥，默认不给它顺手抄进模型上下文的机会。
 *
 * 需要的话 `require('process')` 仍然拿得到真的 —— 这是**防手滑，不是防越权**。
 */
function buildSafeProcess(): Record<string, unknown> {
    return {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        versions: { ...process.versions },
        pid: process.pid,
        cwd: () => process.cwd(),
        uptime: () => process.uptime(),
        memoryUsage: () => process.memoryUsage(),
        hrtime: (time?: [number, number]) => process.hrtime(time),
    };
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Math.min(60000, Math.trunc(Number(ms)) || 0)));
    });

/**
 * editor 起手式助手的签名清单 —— 同一份内容既注入沙箱、也用于 `describe_api` 展示。
 *
 * recipe 那五条也在这里：它们**是助手、不是工具**，工具列表只有四个
 * （`cocos_execute_code` / `cocos_describe_api` / `cocos_editor_state` / `cocos_capture_view`）。
 */
const EDITOR_HELPER_SIGNATURES = [
    'sleep(ms) → Promise',
    'extensionRoot → string（本插件目录）',
    'projectPath() → string',
    'resolveProjectPath(p) → string（相对路径按工程根解析）',
    'listDir(dir) → string[]',
    'readJson(file) → any',
    ...RECIPE_HELPER_SIGNATURES,
] as const;

/** editor 上下文的起手式助手（recipe 五件套由 `runEditorContext` 另加）。 */
function buildEditorHelpers(): Record<string, unknown> {
    return {
        sleep,
        /** 扩展包根目录 —— 想读本插件源码时用 */
        extensionRoot: EXTENSION_ROOT,
        /** 当前工程根目录 */
        projectPath: () => Editor.Project.path,
        /** 把相对/绝对路径统一成绝对路径（相对工程的路径按工程根解析） */
        resolveProjectPath: (p: string) => (path.isAbsolute(p) ? p : path.join(Editor.Project.path, p)),
        /** 列目录（只返回名字，避免一次吐太多） */
        listDir: (dir: string): string[] => {
            const abs = path.isAbsolute(dir) ? dir : path.join(Editor.Project.path, dir);
            return fs.readdirSync(abs);
        },
        /** 读 JSON（配表脚本经常要干这个） */
        readJson: (file: string): unknown => {
            const abs = path.isAbsolute(file) ? file : path.join(Editor.Project.path, file);
            return JSON.parse(fs.readFileSync(abs, 'utf-8'));
        },
        helperNames: () => [...EDITOR_HELPER_SIGNATURES],
    };
}

/** 把沙箱日志行转成响应里的字符串数组 */
function formatLogLines(logs: Array<{ level: string; text: string }>): string[] {
    return logs.map((l) => `[${l.level}] ${l.text}`);
}

/** 夹一个调用方传进来的超时（模型与面板都可能给脏值） */
function clampTimeout(value: unknown, fallback: number): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(100, Math.min(300000, Math.trunc(raw)));
}

/** 整数夹取（截图参数用）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// editor 上下文执行
// ---------------------------------------------------------------------------

/**
 * 在**编辑器主进程**里执行一段代码（隔离沙箱）。
 *
 * 返回的 `data` 就是给模型看的那个信封 `{ok, context, durationMs, result|error, logs, notes…}`；
 * `text` 是它的 JSON 文本。**信封形状必须保持稳定** —— `cocos_editor_state` 之类的调用方
 * 靠 `'result' in envelope` 解包（见 cocos-tools 的 `unwrapSandboxResult`）。
 */
export async function runEditorCode(
    code: string,
    args: Record<string, unknown>,
    timeoutMs: number,
): Promise<ToolReply> {
    // 惰性持有执行器：recipe 助手要能调「跑一段代码」，而那段代码又需要同样的全局量
    // （包括 recipe 助手自己）—— 互相引用，所以必须晚绑定。
    const runnerRef: { current: RecipeRunner | null } = { current: null };

    const { helpers: recipeHelpers } = buildRecipeHelpers({
        projectPath: Editor.Project.path,
        context: 'editor',
        defaultTimeoutMs: timeoutMs,
        getRunner: () => {
            const runner = runnerRef.current;
            if (!runner) throw new Error('recipe 执行器尚未就绪');
            return runner;
        },
    });

    const globals: Record<string, unknown> = {
        Editor,
        require,
        module,
        exports,
        __dirname,
        __filename,
        fs,
        path,
        os,
        Buffer,
        process: buildSafeProcess(),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        setImmediate,
        args,
        ...buildEditorHelpers(),
        ...recipeHelpers,
    };

    const sandboxOptions = {
        maxLogs: SANDBOX_DEFAULTS.maxLogs,
        maxLogLength: SANDBOX_DEFAULTS.maxLogLength,
    };

    /** recipe 的执行器：同一个沙箱机制，独立的超时与日志缓冲 */
    runnerRef.current = async (
        recipeCode: string,
        recipeArgs: Record<string, unknown>,
        nestedTimeoutMs: number,
    ): Promise<RecipeRunOutcome> => {
        const nested = await runInSandbox({
            code: recipeCode,
            globals: { ...globals, args: recipeArgs },
            label: 'dsh-editor-recipe',
            ...sandboxOptions,
            timeoutMs: nestedTimeoutMs,
        });
        return {
            ok: nested.ok,
            result: nested.result,
            error: nested.error,
            logs: nested.logs.length > 0 ? formatLogLines(nested.logs) : undefined,
            durationMs: nested.durationMs,
            timedOut: nested.timedOut,
        };
    };

    const run = await runInSandbox({
        code,
        globals,
        label: 'dsh-editor',
        ...sandboxOptions,
        timeoutMs,
    });

    const serialized = safeSerialize(run.result, SERIALIZE_OPTIONS);
    // 「上下文选错了」不能只回一句 cc is not defined（见 explainError 里记的实测代价）
    const error = run.ok ? null : explainError(run.error ?? { name: 'Error', message: '编辑器侧执行失败' }, 'editor');
    const envelope: Record<string, unknown> = {
        ok: run.ok,
        context: 'editor',
        durationMs: run.durationMs,
        ...(run.ok ? { result: serialized.value } : { error }),
    };
    if (run.logs.length > 0) envelope.logs = formatLogLines(run.logs);
    if (run.logsTruncated) envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (run.timedOut) envelope.timedOut = true;
    if (serialized.truncated) {
        const notes = (envelope.notes as string[] | undefined) ?? [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }

    const text = JSON.stringify(envelope, null, 2);
    return run.ok
        ? { ok: true, text, data: envelope }
        : {
              ok: false,
              text,
              error: `${error?.name ?? 'Error'}: ${error?.message ?? '编辑器侧执行失败'}`,
              data: envelope,
          };
}

// ---------------------------------------------------------------------------
// scene 上下文执行
// ---------------------------------------------------------------------------

/**
 * 在**引擎场景进程**里执行一段代码（转发给本扩展的场景脚本）。
 *
 * @param wantSnapshot - 调用方显式要求登记一次撤销快照（脚本内 `snapshot()` 也会置同一个标志）。
 */
export async function runSceneCode(
    code: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    wantSnapshot: boolean,
): Promise<ToolReply> {
    let sceneResult: Record<string, unknown>;
    try {
        sceneResult = await callSceneScript<Record<string, unknown>>(SCENE_METHOD.runCode, [
            {
                code,
                args,
                timeoutMs,
                maxLogs: SANDBOX_DEFAULTS.maxLogs,
                maxLogLength: SANDBOX_DEFAULTS.maxLogLength,
                // 工程根**由主进程给**（这里拿得到 Editor.Project.path）：场景进程里的
                // `Editor` 是编辑器注入的全局量，未必每个版本都实到能读 Project.path ——
                // `loadFrame` 要靠它去读 `.meta`（见 scene.ts 里 loadFrame 的说明），
                // 少这一个字段就会退化成「只有 uuid 能用」。
                projectPath: Editor.Project.path,
            },
        ]);
    } catch (err) {
        const message = err instanceof SceneUnavailableError ? err.message : describe(err);
        const envelope = { ok: false, context: 'scene', error: message };
        return { ok: false, text: JSON.stringify(envelope, null, 2), error: message, data: envelope };
    }

    const ok = sceneResult.ok === true;
    // 场景侧返回的是引擎里的活对象，必须过一遍序列化再进响应
    const serialized = safeSerialize(sceneResult.result, SERIALIZE_OPTIONS);

    // 快照登记：脚本内 snapshot() 置位，或调用方显式要求
    let snapshotTaken: boolean | undefined;
    if (ok && (sceneResult.snapshotRequested === true || wantSnapshot)) {
        snapshotTaken = await requestSceneSnapshot();
    }

    const rawError = sceneResult.error as { name?: string; message?: string } | undefined;
    const error = ok ? null : explainError({ name: rawError?.name ?? 'Error', message: rawError?.message ?? '场景执行失败' }, 'scene');

    const envelope: Record<string, unknown> = {
        ok,
        context: 'scene',
        durationMs: sceneResult.durationMs ?? 0,
        ...(ok ? { result: serialized.value } : { error }),
    };
    const sceneLogs = Array.isArray(sceneResult.logs)
        ? (sceneResult.logs as Array<{ level: string; text: string }>)
        : [];
    if (sceneLogs.length > 0) envelope.logs = formatLogLines(sceneLogs);
    if (sceneResult.logsTruncated) envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (sceneResult.timedOut) envelope.timedOut = true;
    if (snapshotTaken !== undefined) envelope.undoSnapshot = snapshotTaken;
    if (serialized.truncated) {
        const notes = (envelope.notes as string[] | undefined) ?? [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }

    /**
     * 改完场景之后**提醒存 recipe** —— 这条不是装饰。
     *
     * 基准里最稳定的一条差评就是「复用 0 项」：一整段跑通的建树代码（实测 52KB 发往编辑器、
     * 50 步里 35 步是 `cocos_execute_code`）如果没存成 recipe，下次换会话就**从零再来一遍**
     * （历史上「做一个登录界面预制件」被做了 3 次真跑 + 1 次夭折，约 131 分钟）。
     *
     * 触发条件刻意收窄，免得变成每条回执都贴的废话：
     * ① 这一轮真的改了场景（登记了撤销快照）；② 代码够长（≥1200 字，短探针不必存）；
     * ③ 没超时（超时的那次往往没跑完，存下来是个坑）。
     */
    if (ok && snapshotTaken === true && !sceneResult.timedOut && code.length >= 1200) {
        const notes = (envelope.notes as string[] | undefined) ?? [];
        notes.push(
            `这次改动真生效了（已登记撤销快照），而且代码有 ${code.length} 字 —— ` +
                '如果以后还会用（建树 / 按契约搭 UI / 批量改节点 / 存预制件），' +
                '把**同一段代码**用 saveRecipe(名字, <这段代码>, {description, params, returns}) 存下来：' +
                '下次开工 findRecipes 就能找到它，不用从零再写一遍。' +
                '（一次性的探索直接 return 就行，别存。）',
        );
        envelope.notes = notes;
    }

    const text = JSON.stringify(envelope, null, 2);
    return ok
        ? { ok: true, text, data: envelope }
        : {
              ok: false,
              text,
              error: `${error?.name ?? 'Error'}: ${error?.message ?? '场景执行失败'}`,
              data: envelope,
          };
}

/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
async function requestSceneSnapshot(): Promise<boolean> {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 对外：execute_code / capture_view / 探活 / 场景侧 describe_api
// ---------------------------------------------------------------------------

export interface ExecuteCodeParams {
    code?: unknown;
    context?: unknown;
    args?: unknown;
    timeoutMs?: unknown;
    snapshot?: unknown;
}

/**
 * 「这段代码只能在 scene 跑」的判据 —— 一个个都是**只在场景上下文存在的裸标识符**。
 *
 * 为什么要有一份清单：`context` 漏给时，旧实现在 `cocos-tools`/这里都是
 * `params.context === 'scene' ? 'scene' : 'editor'` —— 也就是**静默当成 editor**，
 * 而 editor 沙箱里没有 `cc`，于是模型拿到的是：
 *
 * ```
 * ReferenceError: cc is not defined
 * ```
 *
 * 实测代价（2026-09-30 17:45 那条会话）：模型完全不知道这是「上下文选错了」，
 * 于是连着 10 步在做对照实验 —— 怀疑 `args` 改变了执行环境、怀疑代码太长被截断、
 * 怀疑 scene 进程丢了 `cc`、怀疑是 `snapshot: true` 的副作用（**这条是错的，见下**），
 * 一步都没往「我没写 context」上想。整条会话 50 步里有 10 步花在这上面。
 *
 * ⚠ **`snapshot: true` 不是原因**（skill 里曾这么记，已更正）：`snapshot` 只是
 * 「跑完之后额外登记一次撤销快照」，代码仍跑在 scene 沙箱里，`cc` 照样在
 * （`scripts/verify-cocos-engine.js` 里有一条断言就是 `context:'scene' + snapshot:true` 跑通的）。
 * 真正的判据只有「有没有给 context」。
 */
const SCENE_ONLY_MARKERS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /(^|[^A-Za-z0-9_$.])cc\s*[.[(]/, name: 'cc' },
    { pattern: /(^|[^A-Za-z0-9_$.])director\s*[.[(]/, name: 'director' },
    { pattern: /(^|[^A-Za-z0-9_$.])(nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|findViewCanvas)\s*\(/, name: '场景助手（nodeByPath 等）' },
    { pattern: /(^|[^A-Za-z0-9_$.])(tree|dump|captureView|loadFrame|worldRect)\s*\(/, name: 'tree/dump/captureView/loadFrame/worldRect' },
];

/** 「这段代码只能在 editor 跑」的判据。 */
const EDITOR_ONLY_MARKERS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /(^|[^A-Za-z0-9_$.])Editor\s*[.[]/, name: 'Editor' },
    { pattern: /(^|[^A-Za-z0-9_$.])(resolveProjectPath|listDir|readJson|projectPath|extensionRoot)\s*\(?/, name: '编辑器助手（projectPath 等）' },
];

/**
 * **弱判据**：场景侧独有的标识符，被当成普通标识符用到就算（`typeof cc`、`!!cc`、`if (eachNode)`…）。
 *
 * 为什么强判据不够：实测那段把模型坑了 10 步的代码确实是 `cc.Layers.Enum.UI_2D`（强判据能命中），
 * 但「旁边一句 `return { ccLoaded: !!cc }`」这种写法同样表明「我要的是场景」，
 * 而它既没有 `cc.`、也没有 `nodeByPath(`。弱判据只在**没有编辑器强判据**时才生效，
 * 所以 `Editor.Message.request('asset-db', …)` 那种代码不会被抢走。
 */
const WEAK_SCENE_NAMES =
    /\b(cc|cocos|director|nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|worldRect|loadFrame|captureView)\b/;

/** 命中清单里的哪几个（给回执里的人话说明用）。 */
function markersOf(code: string, markers: Array<{ pattern: RegExp; name: string }>): string[] {
    const hit: string[] = [];
    for (const marker of markers) {
        if (marker.pattern.test(code) && hit.indexOf(marker.name) < 0) hit.push(marker.name);
    }
    return hit;
}

/**
 * 推断 `context`（只在调用方**没给**的时候用）。
 *
 * 四级，先强后弱：
 * 1. 强场景判据（`cc.` / `nodeByPath(` / `tree(` …）→ scene；
 * 2. 强编辑器判据（`Editor.` / `projectPath()` …）→ editor；
 * 3. 弱场景判据（裸标识符 `cc` / `eachNode` …）→ scene；
 * 4. 都没有 → editor（**无副作用**的那一侧：读盘/查库不会动用户的场景）。
 *
 * @param code - 用户代码。
 * @returns `{context, sceneMarkers, editorMarkers}`；`markers` 非空表示「推断有依据」。
 */
function inferContext(code: string): {
    context: CodeContext;
    sceneMarkers: string[];
    editorMarkers: string[];
} {
    const sceneMarkers = markersOf(code, SCENE_ONLY_MARKERS);
    const editorMarkers = markersOf(code, EDITOR_ONLY_MARKERS);
    if (sceneMarkers.length > 0) return { context: 'scene', sceneMarkers, editorMarkers };
    if (editorMarkers.length > 0) return { context: 'editor', sceneMarkers, editorMarkers };
    if (WEAK_SCENE_NAMES.test(code)) {
        return { context: 'scene', sceneMarkers: ['cc / 场景助手（裸标识符）'], editorMarkers };
    }
    return { context: 'editor', sceneMarkers, editorMarkers };
}

/**
 * 把「上下文选错」这类错误翻译成**可执行的一句话**。
 *
 * `ReferenceError: cc is not defined` 本身没错，错的是一点线索都不给 ——
 * 模型面对它只会去做对照实验（见 {@link SCENE_ONLY_MARKERS} 里的实测代价）。
 * 这里把已知的几个裸标识符认出来，直接说清「你跑在哪个上下文、该改成什么」。
 *
 * @param error - 沙箱错误信息。
 * @param context - 实际跑在哪个上下文。
 * @returns 翻译后的错误信息。
 */
function explainError(error: { name: string; message: string }, context: CodeContext): { name: string; message: string } {
    if (error.name !== 'ReferenceError') return error;
    const missed = /^(?<id>[A-Za-z_$][\w$]*) is not defined$/.exec(error.message.trim())?.groups?.id ?? '';
    if (!missed) return error;

    const sceneGlobals = ['cc', 'cocos', 'director', 'scene', 'js', 'nodeByPath', 'nodeByUuid', 'eachNode', 'contentChildren', 'isEditorNode', 'tree', 'dump', 'captureView', 'find'];
    const editorGlobals = ['Editor', 'require', 'module', 'exports', '__dirname', '__filename', 'fs', 'path', 'os', 'Buffer', 'projectPath', 'resolveProjectPath', 'listDir', 'readJson', 'extensionRoot'];

    if (context === 'editor' && sceneGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message:
                `${error.message}\n` +
                `↑ 「${missed}」是**场景上下文**才有的（这次跑在 editor 沙箱里，那里只有 Editor / require / fs）。\n` +
                `改法：cocos_execute_code({ context: 'scene', code: … })。\n` +
                `下次也可以只写 context，两边通用：改节点/组件 → 'scene'；资源库/工程设置/读盘 → 'editor'。`,
        };
    }
    if (context === 'scene' && editorGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message:
                `${error.message}\n` +
                `↑ 「${missed}」是**编辑器主进程**才有的（这次跑在场景进程里）。\n` +
                `改法：cocos_execute_code({ context: 'editor', code: … }) —— 资源库（asset-db）、工程设置、构建都走它。`,
        };
    }
    return error;
}

/** `cocos_execute_code` 的实现：一次执行里完成「取数据 → 改状态 → 返回结论」。 */
export async function executeCode(params: ExecuteCodeParams): Promise<ToolReply> {
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code.trim()) {
        return { ok: false, text: 'execute_code：code 是空的。', error: 'code 不能为空' };
    }

    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    const args =
        params.args && typeof params.args === 'object' && !Array.isArray(params.args)
            ? (params.args as Record<string, unknown>)
            : {};

    /**
     * `context` 的三种情况，**都要说清是哪一种**：
     * ① 显式给了 → 照做（后面出错时按这个上下文翻译错误）；
     * ② 没给 → 按代码里的标识符推断，并在回执里注明 `contextInferred: true`
     *    （悄悄替模型做决定但不告诉它，下次它还是会漏写）；
     * ③ 推断也不成立 → editor（无副作用的那个）。
     */
    const explicit: CodeContext | null = params.context === 'scene' ? 'scene' : params.context === 'editor' ? 'editor' : null;
    const inferred = explicit === null ? inferContext(code) : null;
    const context: CodeContext = explicit ?? inferred!.context;

    const reply =
        context === 'scene'
            ? await runSceneCode(code, args, timeoutMs, params.snapshot === true)
            : await runEditorCode(code, args, timeoutMs);

    /**
     * 没给 context 的那次：把「我替你选了哪个、凭什么」写进回执。
     *
     * 写在**信封**（`data`）里而不是只写在文本里，是为了 `unwrapSandboxResult` 之外的调用方
     * （面板、日志）也看得到；文本里同样会出现 —— 模型只读文本。
     */
    if (inferred) {
        const envelope = reply.data as Record<string, unknown> | undefined;
        if (envelope) {
            envelope.contextInferred = true;
            const why =
                context === 'scene'
                    ? `代码里出现了 ${inferred.sceneMarkers.join(' / ')}`
                    : inferred.editorMarkers.length > 0
                      ? `代码里出现了 ${inferred.editorMarkers.join(' / ')}`
                      : '代码里没有只属于某一侧的标识符';
            const notes = (envelope.notes as string[] | undefined) ?? [];
            notes.push(`没给 context，按「${why}」推断为 '${context}'（下次请显式传 context）`);
            envelope.notes = notes;
            const text = typeof reply.text === 'string' ? reply.text : '';
            reply.text = text.replace(/\n$/, `\n// context 未给，按「${why}」推断为 '${context}'\n`);
        }
    }
    return reply;
}

/** 场景侧截图助手固定走这一行（真正的实现在 source/scene.ts 的 `captureView` 里）。 */
const CAPTURE_VIEW_SCENE_CODE = 'return await captureView(args);';

/** 截图默认落盘目录：系统临时目录，与具体工程无关。 */
function defaultCapturePath(format: string): string {
    const dir = path.join(os.tmpdir(), 'dsh-cocos-captures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `scene-view-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
}

/**
 * 截一张**场景视图**并存成图片文件（`cocos_capture_view` 的实现）。
 *
 * 为什么单独一条通道：图片是二进制/大字符串，塞不进 `execute_code` 的返回值上限
 * （单字符串 4000 字）—— 所以它必须是「工具 → 落盘 → 回路径」。
 */
export async function captureView(params: Record<string, unknown>): Promise<ToolReply> {
    const format = params.format === 'jpeg' || params.format === 'jpg' ? 'jpeg' : 'png';
    const savePath =
        typeof params.savePath === 'string' && params.savePath.trim()
            ? path.resolve(params.savePath.trim())
            : defaultCapturePath(format);
    const maxWidth = clampInt(params.maxWidth, 32, 4096, 640);
    const quality =
        typeof params.quality === 'number' && Number.isFinite(params.quality)
            ? Math.min(1, Math.max(0.1, params.quality))
            : 0.9;
    const waitMs = clampInt(params.waitMs, 0, 5000, 800);
    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);

    const run = await runSceneCode(CAPTURE_VIEW_SCENE_CODE, { savePath, maxWidth, format, quality, waitMs }, timeoutMs, false);

    const fail = (message: string, extra?: Record<string, unknown>): ToolReply => {
        const payload = { ok: false, error: message, ...(extra ?? {}) };
        return { ok: false, text: JSON.stringify(payload, null, 2), error: message, data: payload };
    };

    const envelope = run.data as Record<string, unknown> | undefined;
    if (!envelope || envelope.ok !== true) {
        // 场景侧已经把原因说清楚了（没开场景 / 执行报错），原样传回去
        return run;
    }

    const captured = envelope.result as Record<string, unknown> | undefined;
    if (!captured || captured.ok !== true) {
        return fail(String((captured && captured.error) || '截图失败（场景侧没有返回图片）'), { scene: captured ?? null });
    }

    // 场景侧能落盘就落盘了（返回 path）；否则回传分块 base64，这里拼回来写盘 ——
    // 沙箱返回值有「单字符串 4000 字」上限，整张图塞不进一个字段。
    const filePath = typeof captured.path === 'string' && captured.path ? captured.path : savePath;
    if (captured.transport !== 'file') {
        const chunks = Array.isArray(captured.chunks) ? captured.chunks.map((c) => String(c)) : [];
        const base64 = chunks.join('');
        if (!base64) return fail('截图没有产出图片数据', { scene: captured });
        try {
            const dir = path.dirname(filePath);
            if (dir) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        } catch (err) {
            return fail(`写入截图文件失败：${describe(err)}`, { path: filePath, scene: captured });
        }
    }

    let bytes = typeof captured.bytes === 'number' ? captured.bytes : 0;
    try {
        bytes = fs.statSync(filePath).size;
    } catch {
        /* 尺寸读不到不影响使用 */
    }

    const blankRatio = typeof captured.blankRatio === 'number' ? captured.blankRatio : null;
    const blank = blankRatio !== null && blankRatio >= 0.95;

    const payload: Record<string, unknown> = {
        ok: true,
        path: filePath,
        width: captured.width,
        height: captured.height,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        format: captured.format ?? format,
        bytes,
        blankRatio,
        // 视图状态（visibleSize / designResolution / canvas / visibleMatchesDesign）——
        // 空白帧时用来判断「是不是编辑器场景视图的设备模拟被改过」
        view: captured.view ?? null,
        transport: captured.transport === 'file' ? 'scene' : 'editor',
    };
    /**
     * ⚠ **空白帧不是「再试一次」能解决的**，所以必须给退路。
     *
     * 历史（2026-09-30 04:23 会话）：`capture_view` 老老实实回了 `blankRatio: 1`，
     * 但只配了一句「接近 1 说明基本是空图」—— 模型于是自己往下试：重试 `waitMs` → `select`/`focus-camera`
     * → `cc.RenderTexture` 离屏 → 最后用节点数据 + Canvas2D 手绘布局对照图，**整整 16 步**。
     * 而真相是：两天前有人（就是它自己）用 `setDesignResolutionSize` 把场景视图的设备模拟弄坏了，
     * 这个差异本来就在 `view` 里量得出来。
     */
    payload.hint = blank
        ? '这是空图（blankRatio≈1），**别再重试截图**（换 waitMs / 重新聚焦 / 换 maxWidth 都不会变）—— 先看 `view` 再决定，按顺序做：' +
          '① `view.visibleMatchesDesign === false`：编辑器场景视图的**设备模拟被改过**（历史上是有人调了 `cc.view.setDesignResolutionSize`）—— 在场景视图工具栏重新选一次设备分辨率即可恢复，纯视图设置、不影响场景与预制件数据；' +
          '② `view.visibleMatchesDesign === true` 却仍然空：说明**这个环境当下确实取不到画面**（实测在编辑器最小化/被遮挡、场景视图未渲染时就是这样）—— 不要自建离屏渲染器（历史上有人为此花了 16 步），直接转数值判据；' +
          '③ 画面验收改用**数值判据**：`worldRect(node)` 拿真实世界矩形 / 自己算重叠与越界 / 逐节点读 color·contentSize；' +
          '④ 确实需要肉眼确认时，按节点真实数据出一张布局对照图（历史做法：`worldRect` 导出行 → 脚本画 PNG → 图片读取），并在交付里**如实声明「真实渲染截图未完成」**。'
        : '用图片读取能力打开 path 看一眼画面，再决定下一步。';
    if (captured.saveError) payload.sceneWriteError = captured.saveError;

    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
}

/** 探活：场景进程里本扩展的脚本加载了吗（`cocos_editor_state` 用它说明「能不能动场景」）。 */
export async function pingSceneScript(): Promise<{ available: boolean; reason?: string }> {
    try {
        const value = await callSceneScript<{ ok?: boolean }>(SCENE_METHOD.ping);
        return value && value.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    } catch (err) {
        return { available: false, reason: describe(err) };
    }
}

/**
 * 场景侧的反射 —— 转发给本扩展的场景脚本（那 200 多行「从 `__props__` + 实时实例读属性名」
 * 的逻辑一行都不用重写）。
 */
export async function describeSceneApi(
    target: string,
    nodeUuid: string,
    limit: number,
): Promise<Record<string, unknown>> {
    const value = (await callSceneScript<Record<string, unknown>>(SCENE_METHOD.describeApi, [
        { target, nodeUuid: nodeUuid || undefined, limit },
    ])) as Record<string, unknown> | undefined;

    if (!value || typeof value !== 'object') {
        throw new Error('场景脚本 describeApi 没有返回结果。');
    }
    return value;
}
