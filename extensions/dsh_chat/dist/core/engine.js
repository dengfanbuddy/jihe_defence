"use strict";
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
exports.runEditorCode = runEditorCode;
exports.runSceneCode = runSceneCode;
exports.executeCode = executeCode;
exports.captureView = captureView;
exports.pingSceneScript = pingSceneScript;
exports.describeSceneApi = describeSceneApi;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const recipes_1 = require("./recipes");
const scene_bridge_1 = require("./scene-bridge");
const sandbox_1 = require("./sandbox");
const serialize_1 = require("./serialize");
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
const SERIALIZE_OPTIONS = {
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
};
/** 把任意异常收敛成一句话。 */
function describe(error) {
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
function buildSafeProcess() {
    return {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        versions: { ...process.versions },
        pid: process.pid,
        cwd: () => process.cwd(),
        uptime: () => process.uptime(),
        memoryUsage: () => process.memoryUsage(),
        hrtime: (time) => process.hrtime(time),
    };
}
const sleep = (ms) => new Promise((resolve) => {
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
    ...recipes_1.RECIPE_HELPER_SIGNATURES,
];
/** editor 上下文的起手式助手（recipe 五件套由 `runEditorContext` 另加）。 */
function buildEditorHelpers() {
    return {
        sleep,
        /** 扩展包根目录 —— 想读本插件源码时用 */
        extensionRoot: EXTENSION_ROOT,
        /** 当前工程根目录 */
        projectPath: () => Editor.Project.path,
        /** 把相对/绝对路径统一成绝对路径（相对工程的路径按工程根解析） */
        resolveProjectPath: (p) => (path.isAbsolute(p) ? p : path.join(Editor.Project.path, p)),
        /** 列目录（只返回名字，避免一次吐太多） */
        listDir: (dir) => {
            const abs = path.isAbsolute(dir) ? dir : path.join(Editor.Project.path, dir);
            return fs.readdirSync(abs);
        },
        /** 读 JSON（配表脚本经常要干这个） */
        readJson: (file) => {
            const abs = path.isAbsolute(file) ? file : path.join(Editor.Project.path, file);
            return JSON.parse(fs.readFileSync(abs, 'utf-8'));
        },
        helperNames: () => [...EDITOR_HELPER_SIGNATURES],
    };
}
/** 把沙箱日志行转成响应里的字符串数组 */
function formatLogLines(logs) {
    return logs.map((l) => `[${l.level}] ${l.text}`);
}
/** 夹一个调用方传进来的超时（模型与面板都可能给脏值） */
function clampTimeout(value, fallback) {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(100, Math.min(300000, Math.trunc(raw)));
}
/** 整数夹取（截图参数用）。 */
function clampInt(value, min, max, fallback) {
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
async function runEditorCode(code, args, timeoutMs) {
    var _a, _b, _c, _d;
    // 惰性持有执行器：recipe 助手要能调「跑一段代码」，而那段代码又需要同样的全局量
    // （包括 recipe 助手自己）—— 互相引用，所以必须晚绑定。
    const runnerRef = { current: null };
    const { helpers: recipeHelpers } = (0, recipes_1.buildRecipeHelpers)({
        projectPath: Editor.Project.path,
        context: 'editor',
        defaultTimeoutMs: timeoutMs,
        getRunner: () => {
            const runner = runnerRef.current;
            if (!runner)
                throw new Error('recipe 执行器尚未就绪');
            return runner;
        },
    });
    const globals = {
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
    runnerRef.current = async (recipeCode, recipeArgs, nestedTimeoutMs) => {
        const nested = await (0, sandbox_1.runInSandbox)({
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
    const run = await (0, sandbox_1.runInSandbox)({
        code,
        globals,
        label: 'dsh-editor',
        ...sandboxOptions,
        timeoutMs,
    });
    const serialized = (0, serialize_1.safeSerialize)(run.result, SERIALIZE_OPTIONS);
    // 「上下文选错了」不能只回一句 cc is not defined（见 explainError 里记的实测代价）
    const error = run.ok ? null : explainError((_a = run.error) !== null && _a !== void 0 ? _a : { name: 'Error', message: '编辑器侧执行失败' }, 'editor');
    const envelope = {
        ok: run.ok,
        context: 'editor',
        durationMs: run.durationMs,
        ...(run.ok ? { result: serialized.value } : { error }),
    };
    if (run.logs.length > 0)
        envelope.logs = formatLogLines(run.logs);
    if (run.logsTruncated)
        envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (run.timedOut)
        envelope.timedOut = true;
    if (serialized.truncated) {
        const notes = (_b = envelope.notes) !== null && _b !== void 0 ? _b : [];
        notes.push(`返回值被截断（命中限制：${serialized.limits.join(', ')}）`);
        envelope.notes = notes;
    }
    const text = JSON.stringify(envelope, null, 2);
    return run.ok
        ? { ok: true, text, data: envelope }
        : {
            ok: false,
            text,
            error: `${(_c = error === null || error === void 0 ? void 0 : error.name) !== null && _c !== void 0 ? _c : 'Error'}: ${(_d = error === null || error === void 0 ? void 0 : error.message) !== null && _d !== void 0 ? _d : '编辑器侧执行失败'}`,
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
async function runSceneCode(code, args, timeoutMs, wantSnapshot) {
    var _a, _b, _c, _d, _e, _f, _g;
    let sceneResult;
    try {
        sceneResult = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.runCode, [
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
    }
    catch (err) {
        const message = err instanceof scene_bridge_1.SceneUnavailableError ? err.message : describe(err);
        const envelope = { ok: false, context: 'scene', error: message };
        return { ok: false, text: JSON.stringify(envelope, null, 2), error: message, data: envelope };
    }
    const ok = sceneResult.ok === true;
    // 场景侧返回的是引擎里的活对象，必须过一遍序列化再进响应
    const serialized = (0, serialize_1.safeSerialize)(sceneResult.result, SERIALIZE_OPTIONS);
    // 快照登记：脚本内 snapshot() 置位，或调用方显式要求
    let snapshotTaken;
    if (ok && (sceneResult.snapshotRequested === true || wantSnapshot)) {
        snapshotTaken = await requestSceneSnapshot();
    }
    const rawError = sceneResult.error;
    const error = ok ? null : explainError({ name: (_a = rawError === null || rawError === void 0 ? void 0 : rawError.name) !== null && _a !== void 0 ? _a : 'Error', message: (_b = rawError === null || rawError === void 0 ? void 0 : rawError.message) !== null && _b !== void 0 ? _b : '场景执行失败' }, 'scene');
    const envelope = {
        ok,
        context: 'scene',
        durationMs: (_c = sceneResult.durationMs) !== null && _c !== void 0 ? _c : 0,
        ...(ok ? { result: serialized.value } : { error }),
    };
    const sceneLogs = Array.isArray(sceneResult.logs)
        ? sceneResult.logs
        : [];
    if (sceneLogs.length > 0)
        envelope.logs = formatLogLines(sceneLogs);
    if (sceneResult.logsTruncated)
        envelope.notes = ['日志超出条数上限，后续输出已丢弃'];
    if (sceneResult.timedOut)
        envelope.timedOut = true;
    if (snapshotTaken !== undefined)
        envelope.undoSnapshot = snapshotTaken;
    if (serialized.truncated) {
        const notes = (_d = envelope.notes) !== null && _d !== void 0 ? _d : [];
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
        const notes = (_e = envelope.notes) !== null && _e !== void 0 ? _e : [];
        notes.push(`这次改动真生效了（已登记撤销快照），而且代码有 ${code.length} 字 —— ` +
            '如果以后还会用（建树 / 按契约搭 UI / 批量改节点 / 存预制件），' +
            '把**同一段代码**用 saveRecipe(名字, <这段代码>, {description, params, returns}) 存下来：' +
            '下次开工 findRecipes 就能找到它，不用从零再写一遍。' +
            '（一次性的探索直接 return 就行，别存。）');
        envelope.notes = notes;
    }
    const text = JSON.stringify(envelope, null, 2);
    return ok
        ? { ok: true, text, data: envelope }
        : {
            ok: false,
            text,
            error: `${(_f = error === null || error === void 0 ? void 0 : error.name) !== null && _f !== void 0 ? _f : 'Error'}: ${(_g = error === null || error === void 0 ? void 0 : error.message) !== null && _g !== void 0 ? _g : '场景执行失败'}`,
            data: envelope,
        };
}
/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
async function requestSceneSnapshot() {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    }
    catch {
        return false;
    }
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
const SCENE_ONLY_MARKERS = [
    { pattern: /(^|[^A-Za-z0-9_$.])cc\s*[.[(]/, name: 'cc' },
    { pattern: /(^|[^A-Za-z0-9_$.])director\s*[.[(]/, name: 'director' },
    { pattern: /(^|[^A-Za-z0-9_$.])(nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|findViewCanvas)\s*\(/, name: '场景助手（nodeByPath 等）' },
    { pattern: /(^|[^A-Za-z0-9_$.])(tree|dump|captureView|loadFrame|worldRect)\s*\(/, name: 'tree/dump/captureView/loadFrame/worldRect' },
];
/** 「这段代码只能在 editor 跑」的判据。 */
const EDITOR_ONLY_MARKERS = [
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
const WEAK_SCENE_NAMES = /\b(cc|cocos|director|nodeByPath|nodeByUuid|eachNode|contentChildren|isEditorNode|worldRect|loadFrame|captureView)\b/;
/** 命中清单里的哪几个（给回执里的人话说明用）。 */
function markersOf(code, markers) {
    const hit = [];
    for (const marker of markers) {
        if (marker.pattern.test(code) && hit.indexOf(marker.name) < 0)
            hit.push(marker.name);
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
function inferContext(code) {
    const sceneMarkers = markersOf(code, SCENE_ONLY_MARKERS);
    const editorMarkers = markersOf(code, EDITOR_ONLY_MARKERS);
    if (sceneMarkers.length > 0)
        return { context: 'scene', sceneMarkers, editorMarkers };
    if (editorMarkers.length > 0)
        return { context: 'editor', sceneMarkers, editorMarkers };
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
function explainError(error, context) {
    var _a, _b, _c;
    if (error.name !== 'ReferenceError')
        return error;
    const missed = (_c = (_b = (_a = /^(?<id>[A-Za-z_$][\w$]*) is not defined$/.exec(error.message.trim())) === null || _a === void 0 ? void 0 : _a.groups) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
    if (!missed)
        return error;
    const sceneGlobals = ['cc', 'cocos', 'director', 'scene', 'js', 'nodeByPath', 'nodeByUuid', 'eachNode', 'contentChildren', 'isEditorNode', 'tree', 'dump', 'captureView', 'find'];
    const editorGlobals = ['Editor', 'require', 'module', 'exports', '__dirname', '__filename', 'fs', 'path', 'os', 'Buffer', 'projectPath', 'resolveProjectPath', 'listDir', 'readJson', 'extensionRoot'];
    if (context === 'editor' && sceneGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message: `${error.message}\n` +
                `↑ 「${missed}」是**场景上下文**才有的（这次跑在 editor 沙箱里，那里只有 Editor / require / fs）。\n` +
                `改法：cocos_execute_code({ context: 'scene', code: … })。\n` +
                `下次也可以只写 context，两边通用：改节点/组件 → 'scene'；资源库/工程设置/读盘 → 'editor'。`,
        };
    }
    if (context === 'scene' && editorGlobals.indexOf(missed) >= 0) {
        return {
            name: error.name,
            message: `${error.message}\n` +
                `↑ 「${missed}」是**编辑器主进程**才有的（这次跑在场景进程里）。\n` +
                `改法：cocos_execute_code({ context: 'editor', code: … }) —— 资源库（asset-db）、工程设置、构建都走它。`,
        };
    }
    return error;
}
/** `cocos_execute_code` 的实现：一次执行里完成「取数据 → 改状态 → 返回结论」。 */
async function executeCode(params) {
    var _a;
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code.trim()) {
        return { ok: false, text: 'execute_code：code 是空的。', error: 'code 不能为空' };
    }
    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args)
        ? params.args
        : {};
    /**
     * `context` 的三种情况，**都要说清是哪一种**：
     * ① 显式给了 → 照做（后面出错时按这个上下文翻译错误）；
     * ② 没给 → 按代码里的标识符推断，并在回执里注明 `contextInferred: true`
     *    （悄悄替模型做决定但不告诉它，下次它还是会漏写）；
     * ③ 推断也不成立 → editor（无副作用的那个）。
     */
    const explicit = params.context === 'scene' ? 'scene' : params.context === 'editor' ? 'editor' : null;
    const inferred = explicit === null ? inferContext(code) : null;
    const context = explicit !== null && explicit !== void 0 ? explicit : inferred.context;
    const reply = context === 'scene'
        ? await runSceneCode(code, args, timeoutMs, params.snapshot === true)
        : await runEditorCode(code, args, timeoutMs);
    /**
     * 没给 context 的那次：把「我替你选了哪个、凭什么」写进回执。
     *
     * 写在**信封**（`data`）里而不是只写在文本里，是为了 `unwrapSandboxResult` 之外的调用方
     * （面板、日志）也看得到；文本里同样会出现 —— 模型只读文本。
     */
    if (inferred) {
        const envelope = reply.data;
        if (envelope) {
            envelope.contextInferred = true;
            const why = context === 'scene'
                ? `代码里出现了 ${inferred.sceneMarkers.join(' / ')}`
                : inferred.editorMarkers.length > 0
                    ? `代码里出现了 ${inferred.editorMarkers.join(' / ')}`
                    : '代码里没有只属于某一侧的标识符';
            const notes = (_a = envelope.notes) !== null && _a !== void 0 ? _a : [];
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
function defaultCapturePath(format) {
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
async function captureView(params) {
    var _a, _b;
    const format = params.format === 'jpeg' || params.format === 'jpg' ? 'jpeg' : 'png';
    const savePath = typeof params.savePath === 'string' && params.savePath.trim()
        ? path.resolve(params.savePath.trim())
        : defaultCapturePath(format);
    const maxWidth = clampInt(params.maxWidth, 32, 4096, 640);
    const quality = typeof params.quality === 'number' && Number.isFinite(params.quality)
        ? Math.min(1, Math.max(0.1, params.quality))
        : 0.9;
    const waitMs = clampInt(params.waitMs, 0, 5000, 800);
    const timeoutMs = clampTimeout(params.timeoutMs, SANDBOX_DEFAULTS.timeoutMs);
    const run = await runSceneCode(CAPTURE_VIEW_SCENE_CODE, { savePath, maxWidth, format, quality, waitMs }, timeoutMs, false);
    const fail = (message, extra) => {
        const payload = { ok: false, error: message, ...(extra !== null && extra !== void 0 ? extra : {}) };
        return { ok: false, text: JSON.stringify(payload, null, 2), error: message, data: payload };
    };
    const envelope = run.data;
    if (!envelope || envelope.ok !== true) {
        // 场景侧已经把原因说清楚了（没开场景 / 执行报错），原样传回去
        return run;
    }
    const captured = envelope.result;
    if (!captured || captured.ok !== true) {
        return fail(String((captured && captured.error) || '截图失败（场景侧没有返回图片）'), { scene: captured !== null && captured !== void 0 ? captured : null });
    }
    // 场景侧能落盘就落盘了（返回 path）；否则回传分块 base64，这里拼回来写盘 ——
    // 沙箱返回值有「单字符串 4000 字」上限，整张图塞不进一个字段。
    const filePath = typeof captured.path === 'string' && captured.path ? captured.path : savePath;
    if (captured.transport !== 'file') {
        const chunks = Array.isArray(captured.chunks) ? captured.chunks.map((c) => String(c)) : [];
        const base64 = chunks.join('');
        if (!base64)
            return fail('截图没有产出图片数据', { scene: captured });
        try {
            const dir = path.dirname(filePath);
            if (dir)
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        }
        catch (err) {
            return fail(`写入截图文件失败：${describe(err)}`, { path: filePath, scene: captured });
        }
    }
    let bytes = typeof captured.bytes === 'number' ? captured.bytes : 0;
    try {
        bytes = fs.statSync(filePath).size;
    }
    catch {
        /* 尺寸读不到不影响使用 */
    }
    const blankRatio = typeof captured.blankRatio === 'number' ? captured.blankRatio : null;
    const blank = blankRatio !== null && blankRatio >= 0.95;
    const payload = {
        ok: true,
        path: filePath,
        width: captured.width,
        height: captured.height,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        format: (_a = captured.format) !== null && _a !== void 0 ? _a : format,
        bytes,
        blankRatio,
        // 视图状态（visibleSize / designResolution / canvas / visibleMatchesDesign）——
        // 空白帧时用来判断「是不是编辑器场景视图的设备模拟被改过」
        view: (_b = captured.view) !== null && _b !== void 0 ? _b : null,
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
    if (captured.saveError)
        payload.sceneWriteError = captured.saveError;
    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
}
/** 探活：场景进程里本扩展的脚本加载了吗（`cocos_editor_state` 用它说明「能不能动场景」）。 */
async function pingSceneScript() {
    try {
        const value = await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.ping);
        return value && value.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    }
    catch (err) {
        return { available: false, reason: describe(err) };
    }
}
/**
 * 场景侧的反射 —— 转发给本扩展的场景脚本（那 200 多行「从 `__props__` + 实时实例读属性名」
 * 的逻辑一行都不用重写）。
 */
async function describeSceneApi(target, nodeUuid, limit) {
    const value = (await (0, scene_bridge_1.callSceneScript)(SCENE_METHOD.describeApi, [
        { target, nodeUuid: nodeUuid || undefined, limit },
    ]));
    if (!value || typeof value !== 'object') {
        throw new Error('场景脚本 describeApi 没有返回结果。');
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5naW5lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL2NvcmUvZW5naW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E2Qkc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBc0pILHNDQXlHQztBQVdELG9DQTRGQztBQXdKRCxrQ0FvREM7QUFrQkQsa0NBNEZDO0FBR0QsMENBT0M7QUFNRCw0Q0FhQztBQTNyQkQsdUNBQXlCO0FBQ3pCLHVDQUF5QjtBQUN6QiwyQ0FBNkI7QUFHN0IsdUNBS21CO0FBQ25CLGlEQUF3RTtBQUN4RSx1Q0FBeUM7QUFDekMsMkNBQWlGO0FBSWpGLDBDQUEwQztBQUMxQyxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFFM0Qsd0RBQXdEO0FBQ3hELE1BQU0sZ0JBQWdCLEdBQUc7SUFDckIsK0NBQStDO0lBQy9DLFNBQVMsRUFBRSxLQUFLO0lBQ2hCLE9BQU8sRUFBRSxHQUFHO0lBQ1osWUFBWSxFQUFFLElBQUk7Q0FDckIsQ0FBQztBQUVGLGtFQUFrRTtBQUNsRSxNQUFNLGlCQUFpQixHQUE4QjtJQUNqRCxRQUFRLEVBQUUsQ0FBQztJQUNYLGNBQWMsRUFBRSxHQUFHO0lBQ25CLGFBQWEsRUFBRSxFQUFFO0lBQ2pCLGVBQWUsRUFBRSxJQUFJO0NBQ3hCLENBQUM7QUFFRixxRUFBcUU7QUFDckUsTUFBTSxZQUFZLEdBQUc7SUFDakIsSUFBSSxFQUFFLE1BQU07SUFDWixPQUFPLEVBQUUsU0FBUztJQUNsQixXQUFXLEVBQUUsYUFBYTtDQUNwQixDQUFDO0FBRVgsbUJBQW1CO0FBQ25CLFNBQVMsUUFBUSxDQUFDLEtBQWM7SUFDNUIsT0FBTyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENB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QyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDnvJbovpHlmajmiafooYzlvJXmk44g4oCU4oCUIGRzaF9jaGF0IOiHquW3seeahOOAjOS7o+eggeaymeeuseOAje+8jOS4jeWGjeWAnyBkZmFuX21jcDLjgIJcbiAqXG4gKiAjIyDov5nkuIDlsYLlnKjlk6rjgIHlubLku4DkuYhcbiAqXG4gKiBgYGBcbiAqIERTSCDlrZDov5vnqIsgLS1mb3JrIElQQy0tPiDmnKzmianlsZXkuLvov5vnqIsoY29jb3MtdG9vbHMpIC0tPiDmnKzmqKHlnZdcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilJzilIAgZWRpdG9yIOS4iuS4i+aWh++8mnZtIOaymeeuse+8iGNvcmUvc2FuZGJveO+8iVxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlOKUgCBzY2VuZSDkuIrkuIvmlofvvJrmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvIhzb3VyY2Uvc2NlbmUudHPvvIlcbiAqIGBgYFxuICpcbiAqIOWFqOeoiyoq5LiN57uP6L+HIGxvb3BiYWNrIEhUVFAqKu+8iOWvueavlCBNQ1Ag55qEIDEyNy4wLjAuMTo4NzMx77yJ77yM5Lmf5LiN57uP6L+H56ys5LqM5Liq5omp5bGV77yaXG4gKiDlnLrmma/ohJrmnKzmmK/mnKzmianlsZUgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOiHquW3seazqOWGjOeahO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxuICog5Li76L+b56iL5L6n55qE5omn6KGM5Zmo5bCx5piv5pys5paH5Lu244CC6IO95Yqb6Z2i5LiO5Y6f5YWI5aSN55So55qE6YKj5aWXKirpgJDmnaHlr7npvZAqKu+8mlxuICog5ZCM5LiA5aWX6LaF5pe25Y+j5b6E44CB5ZCM5LiA5aWX5bqP5YiX5YyW5LiK6ZmQ44CB5ZCM5LiA5aWX5Yqp5omL77yIYGVhY2hOb2RlYCAvIGB0cmVlYCAvIGBub2RlQnlQYXRoYCAvXG4gKiBgZHVtcGAgLyBgc25hcHNob3RgIC8gcmVjaXBlIOS6lOS7tuWllyDigKbvvInvvIzmiYDku6XmqKHlnovnmoTnlKjms5XkuIDkuKrlrZfpg73kuI3nlKjmlLnjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYggZWRpdG9yIOS4jiBzY2VuZSDnmoTmiafooYzmlrnlvI/kuI3lkIzvvIjkuI3og73nu5/kuIDvvIlcbiAqXG4gKiAtICoqZWRpdG9y77yI5pys5qih5Z2X77yJKirvvJpgdm0uY3JlYXRlQ29udGV4dGAg6ZqU56a75rKZ566x44CC5Li76L+b56iL6YeM6LeR77yM6ZqU56a76LaK5Lil6LaK5aW944CCXG4gKiAtICoqc2NlbmXvvIhzb3VyY2Uvc2NlbmUudHPvvIkqKu+8mmB2bS5ydW5JblRoaXNDb250ZXh0YCDlkIwgcmVhbG0gKyDlkIzmraXotoXml7bjgIJcbiAqICAg5byV5pOO6L+b56iLKirkuI3og70qKuaNoiByZWFsbSDigJTigJQg5rKZ566x6YeM6YCg5Ye65p2l55qEIGB7fWAgLyBgW11gIOWcqOW8leaTjueahCBgaW5zdGFuY2VvZmAg5Yik5pat5LiL5Li65YGH77yMXG4gKiAgIOS8muiuqeS4gOWghuW8leaTjiBBUEkg5Ye6546w6Zq+5p+l55qE6K+h5byC6KGM5Li644CC57uG6IqC6KeBIHNjZW5lLnRzIOWktOmDqOazqOmHiuOAglxuICpcbiAqICMjIOi2heaXtueahOivmuWunui+ueeVjFxuICpcbiAqIGB2bWAg55qEIGB0aW1lb3V0YCDlj6rnrqHlkIzmraXmrrXvvJvlvILmraXpnaAgYFByb21pc2UucmFjZWAg6K6h5pe25ZmoIOKAlOKAlCDlroPlj6rorqkqKuiwg+eUqOaWuSoq5LiN5YaN562J77yMXG4gKiAqKuS4jeS8muecn+eahOadgOaOiSoq5bey57uP5Zyo6LeR55qE5byC5q2l5Luj56CB77yITm9kZSDmsqHmnInmiqLljaDlvI/lj5bmtojvvInjgIJcbiAqIOaJgOS7peWIq+WcqOaymeeusemHjOWGmSBgYXdhaXQgbmV3IFByb21pc2UoKCkgPT4ge30pYCDov5nnp43kuI3lj6/nu5PmnZ/nmoTnrYnlvoXjgIJcbiAqL1xuXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgKiBhcyBvcyBmcm9tICdvcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQgeyB0eXBlIFRvb2xSZXBseSB9IGZyb20gJy4uL2NvbnN0YW50cyc7XG5pbXBvcnQge1xuICAgIGJ1aWxkUmVjaXBlSGVscGVycyxcbiAgICBSRUNJUEVfSEVMUEVSX1NJR05BVFVSRVMsXG4gICAgdHlwZSBSZWNpcGVSdW5uZXIsXG4gICAgdHlwZSBSZWNpcGVSdW5PdXRjb21lLFxufSBmcm9tICcuL3JlY2lwZXMnO1xuaW1wb3J0IHsgY2FsbFNjZW5lU2NyaXB0LCBTY2VuZVVuYXZhaWxhYmxlRXJyb3IgfSBmcm9tICcuL3NjZW5lLWJyaWRnZSc7XG5pbXBvcnQgeyBydW5JblNhbmRib3ggfSBmcm9tICcuL3NhbmRib3gnO1xuaW1wb3J0IHsgZm9ybWF0SW5saW5lLCBzYWZlU2VyaWFsaXplLCB0eXBlIFNlcmlhbGl6ZU9wdGlvbnMgfSBmcm9tICcuL3NlcmlhbGl6ZSc7XG5cbmV4cG9ydCB0eXBlIENvZGVDb250ZXh0ID0gJ2VkaXRvcicgfCAnc2NlbmUnO1xuXG4vKiog5omp5bGV5YyF5qC555uu5b2V77yIYGRpc3QvY29yZS9lbmdpbmUuanNgIOW+gOS4iuS4pOe6p++8ieOAgiAqL1xuY29uc3QgRVhURU5TSU9OX1JPT1QgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCAnLi4nLCAnLi4nKTtcblxuLyoqIOaymeeusem7mOiupOWAvO+8iOWOn+WFiOWcqCBkZmFuX21jcDIg55qE6K6+572u6Z2i5p2/6YeM6LCD77yb5pys5omp5bGV5LiN6K6+6Z2i5p2/77yM5pS55oiQ5bi46YePICsg5Y2V5aSE5Y+v5pS577yJ44CCICovXG5jb25zdCBTQU5EQk9YX0RFRkFVTFRTID0ge1xuICAgIC8qKiBgY29jb3NfZXhlY3V0ZV9jb2RlYCDmsqHkvKAgdGltZW91dE1zIOaXtueahOm7mOiupOi2heaXtiAqL1xuICAgIHRpbWVvdXRNczogMTUwMDAsXG4gICAgbWF4TG9nczogMjAwLFxuICAgIG1heExvZ0xlbmd0aDogNDAwMCxcbn07XG5cbi8qKiDov5Tlm57lgLzluo/liJfljJbkuIrpmZDvvJrmt7HluqYgNiAvIOaVsOe7hCAxMDAgLyDlr7nosaEgNjAg6ZSuIC8g5Y2V5a2X56ym5LiyIDQwMDAg5a2X77yI5LiO5bel5YW35o+P6L+w6YeM5YaZ55qE5LiA6Ie077yJ44CCICovXG5jb25zdCBTRVJJQUxJWkVfT1BUSU9OUzogUGFydGlhbDxTZXJpYWxpemVPcHRpb25zPiA9IHtcbiAgICBtYXhEZXB0aDogNixcbiAgICBtYXhBcnJheUxlbmd0aDogMTAwLFxuICAgIG1heE9iamVjdEtleXM6IDYwLFxuICAgIG1heFN0cmluZ0xlbmd0aDogNDAwMCxcbn07XG5cbi8qKiDlnLrmma/ohJrmnKzms6jlhoznmoTmlrnms5XlkI3vvIjkuI4gcGFja2FnZS5qc29uIOeahCBgY29udHJpYnV0aW9ucy5zY2VuZS5tZXRob2RzYCDlr7npvZDvvInjgIIgKi9cbmNvbnN0IFNDRU5FX01FVEhPRCA9IHtcbiAgICBwaW5nOiAncGluZycsXG4gICAgcnVuQ29kZTogJ3J1bkNvZGUnLFxuICAgIGRlc2NyaWJlQXBpOiAnZGVzY3JpYmVBcGknLFxufSBhcyBjb25zdDtcblxuLyoqIOaKiuS7u+aEj+W8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZWRpdG9yIOS4iuS4i+aWh+eahOaymeeuseWFqOWxgOmHj1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog5pq06Zyy57uZ5rKZ566x55qEIGBwcm9jZXNzYCDop4blm77jgIJcbiAqXG4gKiDliLvmhI/oo4HmjokgYGV4aXRgIC8gYGtpbGxgIC8gYGVudmDvvJpcbiAqIC0gYGV4aXRgIOS8muiuqee8lui+keWZqOS4u+i/m+eoi+ebtOaOpeaMguaOie+8iEFJIOaJi+a7keS4gOasoeWwseW+l+mHjeWQr+e8lui+keWZqO+8jOi/mOWPr+iDveS4ouacquS/neWtmOeahOWcuuaZr++8ie+8m1xuICogLSBgZW52YCDph4zluLjmnIkgdG9rZW4v5a+G6ZKl77yM6buY6K6k5LiN57uZ5a6D6aG65omL5oqE6L+b5qih5Z6L5LiK5LiL5paH55qE5py65Lya44CCXG4gKlxuICog6ZyA6KaB55qE6K+dIGByZXF1aXJlKCdwcm9jZXNzJylgIOS7jeeEtuaLv+W+l+WIsOecn+eahCDigJTigJQg6L+Z5pivKirpmLLmiYvmu5HvvIzkuI3mmK/pmLLotormnYMqKuOAglxuICovXG5mdW5jdGlvbiBidWlsZFNhZmVQcm9jZXNzKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICBwbGF0Zm9ybTogcHJvY2Vzcy5wbGF0Zm9ybSxcbiAgICAgICAgYXJjaDogcHJvY2Vzcy5hcmNoLFxuICAgICAgICB2ZXJzaW9uOiBwcm9jZXNzLnZlcnNpb24sXG4gICAgICAgIHZlcnNpb25zOiB7IC4uLnByb2Nlc3MudmVyc2lvbnMgfSxcbiAgICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgICAgY3dkOiAoKSA9PiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICB1cHRpbWU6ICgpID0+IHByb2Nlc3MudXB0aW1lKCksXG4gICAgICAgIG1lbW9yeVVzYWdlOiAoKSA9PiBwcm9jZXNzLm1lbW9yeVVzYWdlKCksXG4gICAgICAgIGhydGltZTogKHRpbWU/OiBbbnVtYmVyLCBudW1iZXJdKSA9PiBwcm9jZXNzLmhydGltZSh0aW1lKSxcbiAgICB9O1xufVxuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5tYXgoMCwgTWF0aC5taW4oNjAwMDAsIE1hdGgudHJ1bmMoTnVtYmVyKG1zKSkgfHwgMCkpKTtcbiAgICB9KTtcblxuLyoqXG4gKiBlZGl0b3Ig6LW35omL5byP5Yqp5omL55qE562+5ZCN5riF5Y2VIOKAlOKAlCDlkIzkuIDku73lhoXlrrnml6Lms6jlhaXmspnnrrHjgIHkuZ/nlKjkuo4gYGRlc2NyaWJlX2FwaWAg5bGV56S644CCXG4gKlxuICogcmVjaXBlIOmCo+S6lOadoeS5n+WcqOi/memHjO+8muWug+S7rCoq5piv5Yqp5omL44CB5LiN5piv5bel5YW3KirvvIzlt6XlhbfliJfooajlj6rmnInlm5vkuKpcbiAqIO+8iGBjb2Nvc19leGVjdXRlX2NvZGVgIC8gYGNvY29zX2Rlc2NyaWJlX2FwaWAgLyBgY29jb3NfZWRpdG9yX3N0YXRlYCAvIGBjb2Nvc19jYXB0dXJlX3ZpZXdg77yJ44CCXG4gKi9cbmNvbnN0IEVESVRPUl9IRUxQRVJfU0lHTkFUVVJFUyA9IFtcbiAgICAnc2xlZXAobXMpIOKGkiBQcm9taXNlJyxcbiAgICAnZXh0ZW5zaW9uUm9vdCDihpIgc3RyaW5n77yI5pys5o+S5Lu255uu5b2V77yJJyxcbiAgICAncHJvamVjdFBhdGgoKSDihpIgc3RyaW5nJyxcbiAgICAncmVzb2x2ZVByb2plY3RQYXRoKHApIOKGkiBzdHJpbmfvvIjnm7jlr7not6/lvoTmjInlt6XnqIvmoLnop6PmnpDvvIknLFxuICAgICdsaXN0RGlyKGRpcikg4oaSIHN0cmluZ1tdJyxcbiAgICAncmVhZEpzb24oZmlsZSkg4oaSIGFueScsXG4gICAgLi4uUkVDSVBFX0hFTFBFUl9TSUdOQVRVUkVTLFxuXSBhcyBjb25zdDtcblxuLyoqIGVkaXRvciDkuIrkuIvmlofnmoTotbfmiYvlvI/liqnmiYvvvIhyZWNpcGUg5LqU5Lu25aWX55SxIGBydW5FZGl0b3JDb250ZXh0YCDlj6bliqDvvInjgIIgKi9cbmZ1bmN0aW9uIGJ1aWxkRWRpdG9ySGVscGVycygpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2xlZXAsXG4gICAgICAgIC8qKiDmianlsZXljIXmoLnnm67lvZUg4oCU4oCUIOaDs+ivu+acrOaPkuS7tua6kOeggeaXtueUqCAqL1xuICAgICAgICBleHRlbnNpb25Sb290OiBFWFRFTlNJT05fUk9PVCxcbiAgICAgICAgLyoqIOW9k+WJjeW3peeoi+agueebruW9lSAqL1xuICAgICAgICBwcm9qZWN0UGF0aDogKCkgPT4gRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgLyoqIOaKiuebuOWvuS/nu53lr7not6/lvoTnu5/kuIDmiJDnu53lr7not6/lvoTvvIjnm7jlr7nlt6XnqIvnmoTot6/lvoTmjInlt6XnqIvmoLnop6PmnpDvvIkgKi9cbiAgICAgICAgcmVzb2x2ZVByb2plY3RQYXRoOiAocDogc3RyaW5nKSA9PiAocGF0aC5pc0Fic29sdXRlKHApID8gcCA6IHBhdGguam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCBwKSksXG4gICAgICAgIC8qKiDliJfnm67lvZXvvIjlj6rov5Tlm57lkI3lrZfvvIzpgb/lhY3kuIDmrKHlkJDlpKrlpJrvvIkgKi9cbiAgICAgICAgbGlzdERpcjogKGRpcjogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuICAgICAgICAgICAgY29uc3QgYWJzID0gcGF0aC5pc0Fic29sdXRlKGRpcikgPyBkaXIgOiBwYXRoLmpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgZGlyKTtcbiAgICAgICAgICAgIHJldHVybiBmcy5yZWFkZGlyU3luYyhhYnMpO1xuICAgICAgICB9LFxuICAgICAgICAvKiog6K+7IEpTT07vvIjphY3ooajohJrmnKznu4/luLjopoHlubLov5nkuKrvvIkgKi9cbiAgICAgICAgcmVhZEpzb246IChmaWxlOiBzdHJpbmcpOiB1bmtub3duID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFicyA9IHBhdGguaXNBYnNvbHV0ZShmaWxlKSA/IGZpbGUgOiBwYXRoLmpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgZmlsZSk7XG4gICAgICAgICAgICByZXR1cm4gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMoYWJzLCAndXRmLTgnKSk7XG4gICAgICAgIH0sXG4gICAgICAgIGhlbHBlck5hbWVzOiAoKSA9PiBbLi4uRURJVE9SX0hFTFBFUl9TSUdOQVRVUkVTXSxcbiAgICB9O1xufVxuXG4vKiog5oqK5rKZ566x5pel5b+X6KGM6L2s5oiQ5ZON5bqU6YeM55qE5a2X56ym5Liy5pWw57uEICovXG5mdW5jdGlvbiBmb3JtYXRMb2dMaW5lcyhsb2dzOiBBcnJheTx7IGxldmVsOiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9Pik6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gbG9ncy5tYXAoKGwpID0+IGBbJHtsLmxldmVsfV0gJHtsLnRleHR9YCk7XG59XG5cbi8qKiDlpLnkuIDkuKrosIPnlKjmlrnkvKDov5vmnaXnmoTotoXml7bvvIjmqKHlnovkuI7pnaLmnb/pg73lj6/og73nu5nohI/lgLzvvIkgKi9cbmZ1bmN0aW9uIGNsYW1wVGltZW91dCh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gICAgY29uc3QgcmF3ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgoMTAwLCBNYXRoLm1pbigzMDAwMDAsIE1hdGgudHJ1bmMocmF3KSkpO1xufVxuXG4vKiog5pW05pWw5aS55Y+W77yI5oiq5Zu+5Y+C5pWw55So77yJ44CCICovXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogdW5rbm93biwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC50cnVuYyh2YWx1ZSkgOiBmYWxsYmFjaztcbiAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIG4pKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlZGl0b3Ig5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKue8lui+keWZqOS4u+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6ZqU56a75rKZ566x77yJ44CCXG4gKlxuICog6L+U5Zue55qEIGBkYXRhYCDlsLHmmK/nu5nmqKHlnovnnIvnmoTpgqPkuKrkv6HlsIEgYHtvaywgY29udGV4dCwgZHVyYXRpb25NcywgcmVzdWx0fGVycm9yLCBsb2dzLCBub3Rlc+KApn1g77ybXG4gKiBgdGV4dGAg5piv5a6D55qEIEpTT04g5paH5pys44CCKirkv6HlsIHlvaLnirblv4Xpobvkv53mjIHnqLPlrpoqKiDigJTigJQgYGNvY29zX2VkaXRvcl9zdGF0ZWAg5LmL57G755qE6LCD55So5pa5XG4gKiDpnaAgYCdyZXN1bHQnIGluIGVudmVsb3BlYCDop6PljIXvvIjop4EgY29jb3MtdG9vbHMg55qEIGB1bndyYXBTYW5kYm94UmVzdWx0YO+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRWRpdG9yQ29kZShcbiAgICBjb2RlOiBzdHJpbmcsXG4gICAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIC8vIOaDsOaAp+aMgeacieaJp+ihjOWZqO+8mnJlY2lwZSDliqnmiYvopoHog73osIPjgIzot5HkuIDmrrXku6PnoIHjgI3vvIzogIzpgqPmrrXku6PnoIHlj4jpnIDopoHlkIzmoLfnmoTlhajlsYDph49cbiAgICAvLyDvvIjljIXmi6wgcmVjaXBlIOWKqeaJi+iHquW3se+8ieKAlOKAlCDkupLnm7jlvJXnlKjvvIzmiYDku6Xlv4XpobvmmZrnu5HlrprjgIJcbiAgICBjb25zdCBydW5uZXJSZWY6IHsgY3VycmVudDogUmVjaXBlUnVubmVyIHwgbnVsbCB9ID0geyBjdXJyZW50OiBudWxsIH07XG5cbiAgICBjb25zdCB7IGhlbHBlcnM6IHJlY2lwZUhlbHBlcnMgfSA9IGJ1aWxkUmVjaXBlSGVscGVycyh7XG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxuICAgICAgICBjb250ZXh0OiAnZWRpdG9yJyxcbiAgICAgICAgZGVmYXVsdFRpbWVvdXRNczogdGltZW91dE1zLFxuICAgICAgICBnZXRSdW5uZXI6ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJ1bm5lciA9IHJ1bm5lclJlZi5jdXJyZW50O1xuICAgICAgICAgICAgaWYgKCFydW5uZXIpIHRocm93IG5ldyBFcnJvcigncmVjaXBlIOaJp+ihjOWZqOWwmuacquWwsee7qicpO1xuICAgICAgICAgICAgcmV0dXJuIHJ1bm5lcjtcbiAgICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBFZGl0b3IsXG4gICAgICAgIHJlcXVpcmUsXG4gICAgICAgIG1vZHVsZSxcbiAgICAgICAgZXhwb3J0cyxcbiAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICBfX2ZpbGVuYW1lLFxuICAgICAgICBmcyxcbiAgICAgICAgcGF0aCxcbiAgICAgICAgb3MsXG4gICAgICAgIEJ1ZmZlcixcbiAgICAgICAgcHJvY2VzczogYnVpbGRTYWZlUHJvY2VzcygpLFxuICAgICAgICBzZXRUaW1lb3V0LFxuICAgICAgICBjbGVhclRpbWVvdXQsXG4gICAgICAgIHNldEludGVydmFsLFxuICAgICAgICBjbGVhckludGVydmFsLFxuICAgICAgICBzZXRJbW1lZGlhdGUsXG4gICAgICAgIGFyZ3MsXG4gICAgICAgIC4uLmJ1aWxkRWRpdG9ySGVscGVycygpLFxuICAgICAgICAuLi5yZWNpcGVIZWxwZXJzLFxuICAgIH07XG5cbiAgICBjb25zdCBzYW5kYm94T3B0aW9ucyA9IHtcbiAgICAgICAgbWF4TG9nczogU0FOREJPWF9ERUZBVUxUUy5tYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgIH07XG5cbiAgICAvKiogcmVjaXBlIOeahOaJp+ihjOWZqO+8muWQjOS4gOS4quaymeeuseacuuWItu+8jOeLrOeri+eahOi2heaXtuS4juaXpeW/l+e8k+WGsiAqL1xuICAgIHJ1bm5lclJlZi5jdXJyZW50ID0gYXN5bmMgKFxuICAgICAgICByZWNpcGVDb2RlOiBzdHJpbmcsXG4gICAgICAgIHJlY2lwZUFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICBuZXN0ZWRUaW1lb3V0TXM6IG51bWJlcixcbiAgICApOiBQcm9taXNlPFJlY2lwZVJ1bk91dGNvbWU+ID0+IHtcbiAgICAgICAgY29uc3QgbmVzdGVkID0gYXdhaXQgcnVuSW5TYW5kYm94KHtcbiAgICAgICAgICAgIGNvZGU6IHJlY2lwZUNvZGUsXG4gICAgICAgICAgICBnbG9iYWxzOiB7IC4uLmdsb2JhbHMsIGFyZ3M6IHJlY2lwZUFyZ3MgfSxcbiAgICAgICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvci1yZWNpcGUnLFxuICAgICAgICAgICAgLi4uc2FuZGJveE9wdGlvbnMsXG4gICAgICAgICAgICB0aW1lb3V0TXM6IG5lc3RlZFRpbWVvdXRNcyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogbmVzdGVkLm9rLFxuICAgICAgICAgICAgcmVzdWx0OiBuZXN0ZWQucmVzdWx0LFxuICAgICAgICAgICAgZXJyb3I6IG5lc3RlZC5lcnJvcixcbiAgICAgICAgICAgIGxvZ3M6IG5lc3RlZC5sb2dzLmxlbmd0aCA+IDAgPyBmb3JtYXRMb2dMaW5lcyhuZXN0ZWQubG9ncykgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBkdXJhdGlvbk1zOiBuZXN0ZWQuZHVyYXRpb25NcyxcbiAgICAgICAgICAgIHRpbWVkT3V0OiBuZXN0ZWQudGltZWRPdXQsXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGNvbnN0IHJ1biA9IGF3YWl0IHJ1bkluU2FuZGJveCh7XG4gICAgICAgIGNvZGUsXG4gICAgICAgIGdsb2JhbHMsXG4gICAgICAgIGxhYmVsOiAnZHNoLWVkaXRvcicsXG4gICAgICAgIC4uLnNhbmRib3hPcHRpb25zLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShydW4ucmVzdWx0LCBTRVJJQUxJWkVfT1BUSU9OUyk7XG4gICAgLy8g44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN5LiN6IO95Y+q5Zue5LiA5Y+lIGNjIGlzIG5vdCBkZWZpbmVk77yI6KeBIGV4cGxhaW5FcnJvciDph4zorrDnmoTlrp7mtYvku6Pku7fvvIlcbiAgICBjb25zdCBlcnJvciA9IHJ1bi5vayA/IG51bGwgOiBleHBsYWluRXJyb3IocnVuLmVycm9yID8/IHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogJ+e8lui+keWZqOS+p+aJp+ihjOWksei0pScgfSwgJ2VkaXRvcicpO1xuICAgIGNvbnN0IGVudmVsb3BlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IHJ1bi5vayxcbiAgICAgICAgY29udGV4dDogJ2VkaXRvcicsXG4gICAgICAgIGR1cmF0aW9uTXM6IHJ1bi5kdXJhdGlvbk1zLFxuICAgICAgICAuLi4ocnVuLm9rID8geyByZXN1bHQ6IHNlcmlhbGl6ZWQudmFsdWUgfSA6IHsgZXJyb3IgfSksXG4gICAgfTtcbiAgICBpZiAocnVuLmxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHJ1bi5sb2dzKTtcbiAgICBpZiAocnVuLmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAocnVuLnRpbWVkT3V0KSBlbnZlbG9wZS50aW1lZE91dCA9IHRydWU7XG4gICAgaWYgKHNlcmlhbGl6ZWQudHJ1bmNhdGVkKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChg6L+U5Zue5YC86KKr5oiq5pat77yI5ZG95Lit6ZmQ5Yi277yaJHtzZXJpYWxpemVkLmxpbWl0cy5qb2luKCcsICcpfe+8iWApO1xuICAgICAgICBlbnZlbG9wZS5ub3RlcyA9IG5vdGVzO1xuICAgIH1cblxuICAgIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShlbnZlbG9wZSwgbnVsbCwgMik7XG4gICAgcmV0dXJuIHJ1bi5va1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICfnvJbovpHlmajkvqfmiafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2NlbmUg5LiK5LiL5paH5omn6KGMXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiDlnKgqKuW8leaTjuWcuuaZr+i/m+eoiyoq6YeM5omn6KGM5LiA5q615Luj56CB77yI6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yJ44CCXG4gKlxuICogQHBhcmFtIHdhbnRTbmFwc2hvdCAtIOiwg+eUqOaWueaYvuW8j+imgeaxgueZu+iusOS4gOasoeaSpOmUgOW/q+eFp++8iOiEmuacrOWGhSBgc25hcHNob3QoKWAg5Lmf5Lya572u5ZCM5LiA5Liq5qCH5b+X77yJ44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5TY2VuZUNvZGUoXG4gICAgY29kZTogc3RyaW5nLFxuICAgIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIHRpbWVvdXRNczogbnVtYmVyLFxuICAgIHdhbnRTbmFwc2hvdDogYm9vbGVhbixcbik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgbGV0IHNjZW5lUmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgICBzY2VuZVJlc3VsdCA9IGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oU0NFTkVfTUVUSE9ELnJ1bkNvZGUsIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBjb2RlLFxuICAgICAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgICAgICAgdGltZW91dE1zLFxuICAgICAgICAgICAgICAgIG1heExvZ3M6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9ncyxcbiAgICAgICAgICAgICAgICBtYXhMb2dMZW5ndGg6IFNBTkRCT1hfREVGQVVMVFMubWF4TG9nTGVuZ3RoLFxuICAgICAgICAgICAgICAgIC8vIOW3peeoi+aguSoq55Sx5Li76L+b56iL57uZKirvvIjov5nph4zmi7/lvpfliLAgRWRpdG9yLlByb2plY3QucGF0aO+8ie+8muWcuuaZr+i/m+eoi+mHjOeahFxuICAgICAgICAgICAgICAgIC8vIGBFZGl0b3JgIOaYr+e8lui+keWZqOazqOWFpeeahOWFqOWxgOmHj++8jOacquW/heavj+S4queJiOacrOmDveWunuWIsOiDveivuyBQcm9qZWN0LnBhdGgg4oCU4oCUXG4gICAgICAgICAgICAgICAgLy8gYGxvYWRGcmFtZWAg6KaB6Z2g5a6D5Y676K+7IGAubWV0YWDvvIjop4Egc2NlbmUudHMg6YeMIGxvYWRGcmFtZSDnmoTor7TmmI7vvInvvIxcbiAgICAgICAgICAgICAgICAvLyDlsJHov5nkuIDkuKrlrZfmrrXlsLHkvJrpgIDljJbmiJDjgIzlj6rmnIkgdXVpZCDog73nlKjjgI3jgIJcbiAgICAgICAgICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgU2NlbmVVbmF2YWlsYWJsZUVycm9yID8gZXJyLm1lc3NhZ2UgOiBkZXNjcmliZShlcnIpO1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHsgb2s6IGZhbHNlLCBjb250ZXh0OiAnc2NlbmUnLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KGVudmVsb3BlLCBudWxsLCAyKSwgZXJyb3I6IG1lc3NhZ2UsIGRhdGE6IGVudmVsb3BlIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb2sgPSBzY2VuZVJlc3VsdC5vayA9PT0gdHJ1ZTtcbiAgICAvLyDlnLrmma/kvqfov5Tlm57nmoTmmK/lvJXmk47ph4znmoTmtLvlr7nosaHvvIzlv4Xpobvov4fkuIDpgY3luo/liJfljJblho3ov5vlk43lupRcbiAgICBjb25zdCBzZXJpYWxpemVkID0gc2FmZVNlcmlhbGl6ZShzY2VuZVJlc3VsdC5yZXN1bHQsIFNFUklBTElaRV9PUFRJT05TKTtcblxuICAgIC8vIOW/q+eFp+eZu+iusO+8muiEmuacrOWGhSBzbmFwc2hvdCgpIOe9ruS9je+8jOaIluiwg+eUqOaWueaYvuW8j+imgeaxglxuICAgIGxldCBzbmFwc2hvdFRha2VuOiBib29sZWFuIHwgdW5kZWZpbmVkO1xuICAgIGlmIChvayAmJiAoc2NlbmVSZXN1bHQuc25hcHNob3RSZXF1ZXN0ZWQgPT09IHRydWUgfHwgd2FudFNuYXBzaG90KSkge1xuICAgICAgICBzbmFwc2hvdFRha2VuID0gYXdhaXQgcmVxdWVzdFNjZW5lU25hcHNob3QoKTtcbiAgICB9XG5cbiAgICBjb25zdCByYXdFcnJvciA9IHNjZW5lUmVzdWx0LmVycm9yIGFzIHsgbmFtZT86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGVycm9yID0gb2sgPyBudWxsIDogZXhwbGFpbkVycm9yKHsgbmFtZTogcmF3RXJyb3I/Lm5hbWUgPz8gJ0Vycm9yJywgbWVzc2FnZTogcmF3RXJyb3I/Lm1lc3NhZ2UgPz8gJ+WcuuaZr+aJp+ihjOWksei0pScgfSwgJ3NjZW5lJyk7XG5cbiAgICBjb25zdCBlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIG9rLFxuICAgICAgICBjb250ZXh0OiAnc2NlbmUnLFxuICAgICAgICBkdXJhdGlvbk1zOiBzY2VuZVJlc3VsdC5kdXJhdGlvbk1zID8/IDAsXG4gICAgICAgIC4uLihvayA/IHsgcmVzdWx0OiBzZXJpYWxpemVkLnZhbHVlIH0gOiB7IGVycm9yIH0pLFxuICAgIH07XG4gICAgY29uc3Qgc2NlbmVMb2dzID0gQXJyYXkuaXNBcnJheShzY2VuZVJlc3VsdC5sb2dzKVxuICAgICAgICA/IChzY2VuZVJlc3VsdC5sb2dzIGFzIEFycmF5PHsgbGV2ZWw6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0+KVxuICAgICAgICA6IFtdO1xuICAgIGlmIChzY2VuZUxvZ3MubGVuZ3RoID4gMCkgZW52ZWxvcGUubG9ncyA9IGZvcm1hdExvZ0xpbmVzKHNjZW5lTG9ncyk7XG4gICAgaWYgKHNjZW5lUmVzdWx0LmxvZ3NUcnVuY2F0ZWQpIGVudmVsb3BlLm5vdGVzID0gWyfml6Xlv5fotoXlh7rmnaHmlbDkuIrpmZDvvIzlkI7nu63ovpPlh7rlt7LkuKLlvIMnXTtcbiAgICBpZiAoc2NlbmVSZXN1bHQudGltZWRPdXQpIGVudmVsb3BlLnRpbWVkT3V0ID0gdHJ1ZTtcbiAgICBpZiAoc25hcHNob3RUYWtlbiAhPT0gdW5kZWZpbmVkKSBlbnZlbG9wZS51bmRvU25hcHNob3QgPSBzbmFwc2hvdFRha2VuO1xuICAgIGlmIChzZXJpYWxpemVkLnRydW5jYXRlZCkge1xuICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgIG5vdGVzLnB1c2goYOi/lOWbnuWAvOiiq+aIquaWre+8iOWRveS4remZkOWItu+8miR7c2VyaWFsaXplZC5saW1pdHMuam9pbignLCAnKX3vvIlgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDmlLnlrozlnLrmma/kuYvlkI4qKuaPkOmGkuWtmCByZWNpcGUqKiDigJTigJQg6L+Z5p2h5LiN5piv6KOF6aWw44CCXG4gICAgICpcbiAgICAgKiDln7rlh4bph4zmnIDnqLPlrprnmoTkuIDmnaHlt67or4TlsLHmmK/jgIzlpI3nlKggMCDpobnjgI3vvJrkuIDmlbTmrrXot5HpgJrnmoTlu7rmoJHku6PnoIHvvIjlrp7mtYsgNTJLQiDlj5HlvoDnvJbovpHlmajjgIFcbiAgICAgKiA1MCDmraXph4wgMzUg5q2l5pivIGBjb2Nvc19leGVjdXRlX2NvZGVg77yJ5aaC5p6c5rKh5a2Y5oiQIHJlY2lwZe+8jOS4i+asoeaNouS8muivneWwsSoq5LuO6Zu25YaN5p2l5LiA6YGNKipcbiAgICAgKiDvvIjljoblj7LkuIrjgIzlgZrkuIDkuKrnmbvlvZXnlYzpnaLpooTliLbku7bjgI3ooqvlgZrkuoYgMyDmrKHnnJ/ot5EgKyAxIOasoeWkreaKmO+8jOe6piAxMzEg5YiG6ZKf77yJ44CCXG4gICAgICpcbiAgICAgKiDop6blj5HmnaHku7bliLvmhI/mlLbnqoTvvIzlhY3lvpflj5jmiJDmr4/mnaHlm57miafpg73otLTnmoTlup/or53vvJpcbiAgICAgKiDikaAg6L+Z5LiA6L2u55yf55qE5pS55LqG5Zy65pmv77yI55m76K6w5LqG5pKk6ZSA5b+r54Wn77yJ77yb4pGhIOS7o+eggeWkn+mVv++8iOKJpTEyMDAg5a2X77yM55+t5o6i6ZKI5LiN5b+F5a2Y77yJ77ybXG4gICAgICog4pGiIOayoei2heaXtu+8iOi2heaXtueahOmCo+asoeW+gOW+gOayoei3keWujO+8jOWtmOS4i+adpeaYr+S4quWdke+8ieOAglxuICAgICAqL1xuICAgIGlmIChvayAmJiBzbmFwc2hvdFRha2VuID09PSB0cnVlICYmICFzY2VuZVJlc3VsdC50aW1lZE91dCAmJiBjb2RlLmxlbmd0aCA+PSAxMjAwKSB7XG4gICAgICAgIGNvbnN0IG5vdGVzID0gKGVudmVsb3BlLm5vdGVzIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkKSA/PyBbXTtcbiAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgIGDov5nmrKHmlLnliqjnnJ/nlJ/mlYjkuobvvIjlt7LnmbvorrDmkqTplIDlv6vnhafvvInvvIzogIzkuJTku6PnoIHmnIkgJHtjb2RlLmxlbmd0aH0g5a2XIOKAlOKAlCBgICtcbiAgICAgICAgICAgICAgICAn5aaC5p6c5Lul5ZCO6L+Y5Lya55So77yI5bu65qCRIC8g5oyJ5aWR57qm5pCtIFVJIC8g5om56YeP5pS56IqC54K5IC8g5a2Y6aKE5Yi25Lu277yJ77yMJyArXG4gICAgICAgICAgICAgICAgJ+aKiioq5ZCM5LiA5q615Luj56CBKirnlKggc2F2ZVJlY2lwZSjlkI3lrZcsIDzov5nmrrXku6PnoIE+LCB7ZGVzY3JpcHRpb24sIHBhcmFtcywgcmV0dXJuc30pIOWtmOS4i+adpe+8micgK1xuICAgICAgICAgICAgICAgICfkuIvmrKHlvIDlt6UgZmluZFJlY2lwZXMg5bCx6IO95om+5Yiw5a6D77yM5LiN55So5LuO6Zu25YaN5YaZ5LiA6YGN44CCJyArXG4gICAgICAgICAgICAgICAgJ++8iOS4gOasoeaAp+eahOaOoue0ouebtOaOpSByZXR1cm4g5bCx6KGM77yM5Yir5a2Y44CC77yJJyxcbiAgICAgICAgKTtcbiAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICB9XG5cbiAgICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkoZW52ZWxvcGUsIG51bGwsIDIpO1xuICAgIHJldHVybiBva1xuICAgICAgICA/IHsgb2s6IHRydWUsIHRleHQsIGRhdGE6IGVudmVsb3BlIH1cbiAgICAgICAgOiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgICAgZXJyb3I6IGAke2Vycm9yPy5uYW1lID8/ICdFcnJvcid9OiAke2Vycm9yPy5tZXNzYWdlID8/ICflnLrmma/miafooYzlpLHotKUnfWAsXG4gICAgICAgICAgICAgIGRhdGE6IGVudmVsb3BlLFxuICAgICAgICAgIH07XG59XG5cbi8qKlxuICog6K+35rGC5LiA5qyh5Zy65pmv5pKk6ZSA5b+r54Wn44CCXG4gKlxuICog5Zy65pmv6ISa5pys6YeM55qEIGBzbmFwc2hvdCgpYCDlj6rnva7moIflv5fkvY3vvIznnJ/mraPnmoTlv6vnhafnlLHov5nph4zlj5Hotbcg4oCU4oCUXG4gKiDlv4XpobvnlLHkuLvov5vnqIvosIPvvIzlm6DkuLrku44gc2NlbmUg6L+b56iL57uZIHNjZW5lIOWMheWPkea2iOaBr+aYr+iHqueOr+OAglxuICovXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0U2NlbmVTbmFwc2hvdCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlr7nlpJbvvJpleGVjdXRlX2NvZGUgLyBjYXB0dXJlX3ZpZXcgLyDmjqLmtLsgLyDlnLrmma/kvqcgZGVzY3JpYmVfYXBpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBFeGVjdXRlQ29kZVBhcmFtcyB7XG4gICAgY29kZT86IHVua25vd247XG4gICAgY29udGV4dD86IHVua25vd247XG4gICAgYXJncz86IHVua25vd247XG4gICAgdGltZW91dE1zPzogdW5rbm93bjtcbiAgICBzbmFwc2hvdD86IHVua25vd247XG59XG5cbi8qKlxuICog44CM6L+Z5q615Luj56CB5Y+q6IO95ZyoIHNjZW5lIOi3keOAjeeahOWIpOaNriDigJTigJQg5LiA5Liq5Liq6YO95pivKirlj6rlnKjlnLrmma/kuIrkuIvmloflrZjlnKjnmoToo7jmoIfor4bnrKYqKuOAglxuICpcbiAqIOS4uuS7gOS5iOimgeacieS4gOS7vea4heWNle+8mmBjb250ZXh0YCDmvI/nu5nml7bvvIzml6flrp7njrDlnKggYGNvY29zLXRvb2xzYC/ov5nph4zpg73mmK9cbiAqIGBwYXJhbXMuY29udGV4dCA9PT0gJ3NjZW5lJyA/ICdzY2VuZScgOiAnZWRpdG9yJ2Ag4oCU4oCUIOS5n+WwseaYryoq6Z2Z6buY5b2T5oiQIGVkaXRvcioq77yMXG4gKiDogIwgZWRpdG9yIOaymeeusemHjOayoeaciSBgY2Ng77yM5LqO5piv5qih5Z6L5ou/5Yiw55qE5piv77yaXG4gKlxuICogYGBgXG4gKiBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRcbiAqIGBgYFxuICpcbiAqIOWunua1i+S7o+S7t++8iDIwMjYtMDktMzAgMTc6NDUg6YKj5p2h5Lya6K+d77yJ77ya5qih5Z6L5a6M5YWo5LiN55+l6YGT6L+Z5piv44CM5LiK5LiL5paH6YCJ6ZSZ5LqG44CN77yMXG4gKiDkuo7mmK/ov57nnYAgMTAg5q2l5Zyo5YGa5a+554Wn5a6e6aqMIOKAlOKAlCDmgIDnlpEgYGFyZ3NgIOaUueWPmOS6huaJp+ihjOeOr+Wig+OAgeaAgOeWkeS7o+eggeWkqumVv+iiq+aIquaWreOAgVxuICog5oCA55aRIHNjZW5lIOi/m+eoi+S4ouS6hiBgY2Ng44CB5oCA55aR5pivIGBzbmFwc2hvdDogdHJ1ZWAg55qE5Ymv5L2c55So77yIKirov5nmnaHmmK/plJnnmoTvvIzop4HkuIsqKu+8ie+8jFxuICog5LiA5q2l6YO95rKh5b6A44CM5oiR5rKh5YaZIGNvbnRleHTjgI3kuIrmg7PjgILmlbTmnaHkvJror50gNTAg5q2l6YeM5pyJIDEwIOatpeiKseWcqOi/meS4iumdouOAglxuICpcbiAqIOKaoCAqKmBzbmFwc2hvdDogdHJ1ZWAg5LiN5piv5Y6f5ZugKirvvIhza2lsbCDph4zmm77ov5nkuYjorrDvvIzlt7Lmm7TmraPvvInvvJpgc25hcHNob3RgIOWPquaYr1xuICog44CM6LeR5a6M5LmL5ZCO6aKd5aSW55m76K6w5LiA5qyh5pKk6ZSA5b+r54Wn44CN77yM5Luj56CB5LuN6LeR5ZyoIHNjZW5lIOaymeeusemHjO+8jGBjY2Ag54Wn5qC35ZyoXG4gKiDvvIhgc2NyaXB0cy92ZXJpZnktY29jb3MtZW5naW5lLmpzYCDph4zmnInkuIDmnaHmlq3oqIDlsLHmmK8gYGNvbnRleHQ6J3NjZW5lJyArIHNuYXBzaG90OnRydWVgIOi3kemAmueahO+8ieOAglxuICog55yf5q2j55qE5Yik5o2u5Y+q5pyJ44CM5pyJ5rKh5pyJ57uZIGNvbnRleHTjgI3jgIJcbiAqL1xuY29uc3QgU0NFTkVfT05MWV9NQVJLRVJTOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSljY1xccypbLlsoXS8sIG5hbWU6ICdjYycgfSxcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pZGlyZWN0b3JcXHMqWy5bKF0vLCBuYW1lOiAnZGlyZWN0b3InIH0sXG4gICAgeyBwYXR0ZXJuOiAvKF58W15BLVphLXowLTlfJC5dKShub2RlQnlQYXRofG5vZGVCeVV1aWR8ZWFjaE5vZGV8Y29udGVudENoaWxkcmVufGlzRWRpdG9yTm9kZXxmaW5kVmlld0NhbnZhcylcXHMqXFwoLywgbmFtZTogJ+WcuuaZr+WKqeaJi++8iG5vZGVCeVBhdGgg562J77yJJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSkodHJlZXxkdW1wfGNhcHR1cmVWaWV3fGxvYWRGcmFtZXx3b3JsZFJlY3QpXFxzKlxcKC8sIG5hbWU6ICd0cmVlL2R1bXAvY2FwdHVyZVZpZXcvbG9hZEZyYW1lL3dvcmxkUmVjdCcgfSxcbl07XG5cbi8qKiDjgIzov5nmrrXku6PnoIHlj6rog73lnKggZWRpdG9yIOi3keOAjeeahOWIpOaNruOAgiAqL1xuY29uc3QgRURJVE9SX09OTFlfTUFSS0VSUzogQXJyYXk8eyBwYXR0ZXJuOiBSZWdFeHA7IG5hbWU6IHN0cmluZyB9PiA9IFtcbiAgICB7IHBhdHRlcm46IC8oXnxbXkEtWmEtejAtOV8kLl0pRWRpdG9yXFxzKlsuW10vLCBuYW1lOiAnRWRpdG9yJyB9LFxuICAgIHsgcGF0dGVybjogLyhefFteQS1aYS16MC05XyQuXSkocmVzb2x2ZVByb2plY3RQYXRofGxpc3REaXJ8cmVhZEpzb258cHJvamVjdFBhdGh8ZXh0ZW5zaW9uUm9vdClcXHMqXFwoPy8sIG5hbWU6ICfnvJbovpHlmajliqnmiYvvvIhwcm9qZWN0UGF0aCDnrYnvvIknIH0sXG5dO1xuXG4vKipcbiAqICoq5byx5Yik5o2uKirvvJrlnLrmma/kvqfni6zmnInnmoTmoIfor4bnrKbvvIzooqvlvZPmiJDmma7pgJrmoIfor4bnrKbnlKjliLDlsLHnrpfvvIhgdHlwZW9mIGNjYOOAgWAhIWNjYOOAgWBpZiAoZWFjaE5vZGUpYOKApu+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOW8uuWIpOaNruS4jeWkn++8muWunua1i+mCo+auteaKiuaooeWei+WdkeS6hiAxMCDmraXnmoTku6PnoIHnoa7lrp7mmK8gYGNjLkxheWVycy5FbnVtLlVJXzJEYO+8iOW8uuWIpOaNruiDveWRveS4re+8ie+8jFxuICog5L2G44CM5peB6L655LiA5Y+lIGByZXR1cm4geyBjY0xvYWRlZDogISFjYyB9YOOAjei/meenjeWGmeazleWQjOagt+ihqOaYjuOAjOaIkeimgeeahOaYr+WcuuaZr+OAje+8jFxuICog6ICM5a6D5pei5rKh5pyJIGBjYy5g44CB5Lmf5rKh5pyJIGBub2RlQnlQYXRoKGDjgILlvLHliKTmja7lj6rlnKgqKuayoeaciee8lui+keWZqOW8uuWIpOaNrioq5pe25omN55Sf5pWI77yMXG4gKiDmiYDku6UgYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywg4oCmKWAg6YKj56eN5Luj56CB5LiN5Lya6KKr5oqi6LWw44CCXG4gKi9cbmNvbnN0IFdFQUtfU0NFTkVfTkFNRVMgPVxuICAgIC9cXGIoY2N8Y29jb3N8ZGlyZWN0b3J8bm9kZUJ5UGF0aHxub2RlQnlVdWlkfGVhY2hOb2RlfGNvbnRlbnRDaGlsZHJlbnxpc0VkaXRvck5vZGV8d29ybGRSZWN0fGxvYWRGcmFtZXxjYXB0dXJlVmlldylcXGIvO1xuXG4vKiog5ZG95Lit5riF5Y2V6YeM55qE5ZOq5Yeg5Liq77yI57uZ5Zue5omn6YeM55qE5Lq66K+d6K+05piO55So77yJ44CCICovXG5mdW5jdGlvbiBtYXJrZXJzT2YoY29kZTogc3RyaW5nLCBtYXJrZXJzOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgbmFtZTogc3RyaW5nIH0+KTogc3RyaW5nW10ge1xuICAgIGNvbnN0IGhpdDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICAgIGlmIChtYXJrZXIucGF0dGVybi50ZXN0KGNvZGUpICYmIGhpdC5pbmRleE9mKG1hcmtlci5uYW1lKSA8IDApIGhpdC5wdXNoKG1hcmtlci5uYW1lKTtcbiAgICB9XG4gICAgcmV0dXJuIGhpdDtcbn1cblxuLyoqXG4gKiDmjqjmlq0gYGNvbnRleHRg77yI5Y+q5Zyo6LCD55So5pa5KirmsqHnu5kqKueahOaXtuWAmeeUqO+8ieOAglxuICpcbiAqIOWbm+e6p++8jOWFiOW8uuWQjuW8se+8mlxuICogMS4g5by65Zy65pmv5Yik5o2u77yIYGNjLmAgLyBgbm9kZUJ5UGF0aChgIC8gYHRyZWUoYCDigKbvvInihpIgc2NlbmXvvJtcbiAqIDIuIOW8uue8lui+keWZqOWIpOaNru+8iGBFZGl0b3IuYCAvIGBwcm9qZWN0UGF0aCgpYCDigKbvvInihpIgZWRpdG9y77ybXG4gKiAzLiDlvLHlnLrmma/liKTmja7vvIjoo7jmoIfor4bnrKYgYGNjYCAvIGBlYWNoTm9kZWAg4oCm77yJ4oaSIHNjZW5l77ybXG4gKiA0LiDpg73msqHmnIkg4oaSIGVkaXRvcu+8iCoq5peg5Ymv5L2c55SoKirnmoTpgqPkuIDkvqfvvJror7vnm5gv5p+l5bqT5LiN5Lya5Yqo55So5oi355qE5Zy65pmv77yJ44CCXG4gKlxuICogQHBhcmFtIGNvZGUgLSDnlKjmiLfku6PnoIHjgIJcbiAqIEByZXR1cm5zIGB7Y29udGV4dCwgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzfWDvvJtgbWFya2Vyc2Ag6Z2e56m66KGo56S644CM5o6o5pat5pyJ5L6d5o2u44CN44CCXG4gKi9cbmZ1bmN0aW9uIGluZmVyQ29udGV4dChjb2RlOiBzdHJpbmcpOiB7XG4gICAgY29udGV4dDogQ29kZUNvbnRleHQ7XG4gICAgc2NlbmVNYXJrZXJzOiBzdHJpbmdbXTtcbiAgICBlZGl0b3JNYXJrZXJzOiBzdHJpbmdbXTtcbn0ge1xuICAgIGNvbnN0IHNjZW5lTWFya2VycyA9IG1hcmtlcnNPZihjb2RlLCBTQ0VORV9PTkxZX01BUktFUlMpO1xuICAgIGNvbnN0IGVkaXRvck1hcmtlcnMgPSBtYXJrZXJzT2YoY29kZSwgRURJVE9SX09OTFlfTUFSS0VSUyk7XG4gICAgaWYgKHNjZW5lTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnMsIGVkaXRvck1hcmtlcnMgfTtcbiAgICBpZiAoZWRpdG9yTWFya2Vycy5sZW5ndGggPiAwKSByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG4gICAgaWYgKFdFQUtfU0NFTkVfTkFNRVMudGVzdChjb2RlKSkge1xuICAgICAgICByZXR1cm4geyBjb250ZXh0OiAnc2NlbmUnLCBzY2VuZU1hcmtlcnM6IFsnY2MgLyDlnLrmma/liqnmiYvvvIjoo7jmoIfor4bnrKbvvIknXSwgZWRpdG9yTWFya2VycyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBjb250ZXh0OiAnZWRpdG9yJywgc2NlbmVNYXJrZXJzLCBlZGl0b3JNYXJrZXJzIH07XG59XG5cbi8qKlxuICog5oqK44CM5LiK5LiL5paH6YCJ6ZSZ44CN6L+Z57G76ZSZ6K+v57+76K+R5oiQKirlj6/miafooYznmoTkuIDlj6Xor50qKuOAglxuICpcbiAqIGBSZWZlcmVuY2VFcnJvcjogY2MgaXMgbm90IGRlZmluZWRgIOacrOi6q+ayoemUme+8jOmUmeeahOaYr+S4gOeCuee6v+e0oumDveS4jee7mSDigJTigJRcbiAqIOaooeWei+mdouWvueWug+WPquS8muWOu+WBmuWvueeFp+WunumqjO+8iOingSB7QGxpbmsgU0NFTkVfT05MWV9NQVJLRVJTfSDph4znmoTlrp7mtYvku6Pku7fvvInjgIJcbiAqIOi/memHjOaKiuW3suefpeeahOWHoOS4quijuOagh+ivhuespuiupOWHuuadpe+8jOebtOaOpeivtOa4heOAjOS9oOi3keWcqOWTquS4quS4iuS4i+aWh+OAgeivpeaUueaIkOS7gOS5iOOAjeOAglxuICpcbiAqIEBwYXJhbSBlcnJvciAtIOaymeeusemUmeivr+S/oeaBr+OAglxuICogQHBhcmFtIGNvbnRleHQgLSDlrp7pmYXot5HlnKjlk6rkuKrkuIrkuIvmlofjgIJcbiAqIEByZXR1cm5zIOe/u+ivkeWQjueahOmUmeivr+S/oeaBr+OAglxuICovXG5mdW5jdGlvbiBleHBsYWluRXJyb3IoZXJyb3I6IHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfSwgY29udGV4dDogQ29kZUNvbnRleHQpOiB7IG5hbWU6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICAgIGlmIChlcnJvci5uYW1lICE9PSAnUmVmZXJlbmNlRXJyb3InKSByZXR1cm4gZXJyb3I7XG4gICAgY29uc3QgbWlzc2VkID0gL14oPzxpZD5bQS1aYS16XyRdW1xcdyRdKikgaXMgbm90IGRlZmluZWQkLy5leGVjKGVycm9yLm1lc3NhZ2UudHJpbSgpKT8uZ3JvdXBzPy5pZCA/PyAnJztcbiAgICBpZiAoIW1pc3NlZCkgcmV0dXJuIGVycm9yO1xuXG4gICAgY29uc3Qgc2NlbmVHbG9iYWxzID0gWydjYycsICdjb2NvcycsICdkaXJlY3RvcicsICdzY2VuZScsICdqcycsICdub2RlQnlQYXRoJywgJ25vZGVCeVV1aWQnLCAnZWFjaE5vZGUnLCAnY29udGVudENoaWxkcmVuJywgJ2lzRWRpdG9yTm9kZScsICd0cmVlJywgJ2R1bXAnLCAnY2FwdHVyZVZpZXcnLCAnZmluZCddO1xuICAgIGNvbnN0IGVkaXRvckdsb2JhbHMgPSBbJ0VkaXRvcicsICdyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJywgJ19fZGlybmFtZScsICdfX2ZpbGVuYW1lJywgJ2ZzJywgJ3BhdGgnLCAnb3MnLCAnQnVmZmVyJywgJ3Byb2plY3RQYXRoJywgJ3Jlc29sdmVQcm9qZWN0UGF0aCcsICdsaXN0RGlyJywgJ3JlYWRKc29uJywgJ2V4dGVuc2lvblJvb3QnXTtcblxuICAgIGlmIChjb250ZXh0ID09PSAnZWRpdG9yJyAmJiBzY2VuZUdsb2JhbHMuaW5kZXhPZihtaXNzZWQpID49IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5hbWU6IGVycm9yLm5hbWUsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICAgIGAke2Vycm9yLm1lc3NhZ2V9XFxuYCArXG4gICAgICAgICAgICAgICAgYOKGkSDjgIwke21pc3NlZH3jgI3mmK8qKuWcuuaZr+S4iuS4i+aWhyoq5omN5pyJ55qE77yI6L+Z5qyh6LeR5ZyoIGVkaXRvciDmspnnrrHph4zvvIzpgqPph4zlj6rmnIkgRWRpdG9yIC8gcmVxdWlyZSAvIGZz77yJ44CCXFxuYCArXG4gICAgICAgICAgICAgICAgYOaUueazle+8mmNvY29zX2V4ZWN1dGVfY29kZSh7IGNvbnRleHQ6ICdzY2VuZScsIGNvZGU6IOKApiB9KeOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDkuIvmrKHkuZ/lj6/ku6Xlj6rlhpkgY29udGV4dO+8jOS4pOi+uemAmueUqO+8muaUueiKgueCuS/nu4Tku7Yg4oaSICdzY2VuZSfvvJvotYTmupDlupMv5bel56iL6K6+572uL+ivu+ebmCDihpIgJ2VkaXRvcifjgIJgLFxuICAgICAgICB9O1xuICAgIH1cbiAgICBpZiAoY29udGV4dCA9PT0gJ3NjZW5lJyAmJiBlZGl0b3JHbG9iYWxzLmluZGV4T2YobWlzc2VkKSA+PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBuYW1lOiBlcnJvci5uYW1lLFxuICAgICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgICAgICBgJHtlcnJvci5tZXNzYWdlfVxcbmAgK1xuICAgICAgICAgICAgICAgIGDihpEg44CMJHttaXNzZWR944CN5pivKirnvJbovpHlmajkuLvov5vnqIsqKuaJjeacieeahO+8iOi/measoei3keWcqOWcuuaZr+i/m+eoi+mHjO+8ieOAglxcbmAgK1xuICAgICAgICAgICAgICAgIGDmlLnms5XvvJpjb2Nvc19leGVjdXRlX2NvZGUoeyBjb250ZXh0OiAnZWRpdG9yJywgY29kZTog4oCmIH0pIOKAlOKAlCDotYTmupDlupPvvIhhc3NldC1kYu+8ieOAgeW3peeoi+iuvue9ruOAgeaehOW7uumDvei1sOWug+OAgmAsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiBlcnJvcjtcbn1cblxuLyoqIGBjb2Nvc19leGVjdXRlX2NvZGVgIOeahOWunueOsO+8muS4gOasoeaJp+ihjOmHjOWujOaIkOOAjOWPluaVsOaNriDihpIg5pS554q25oCBIOKGkiDov5Tlm57nu5PorrrjgI3jgIIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlQ29kZShwYXJhbXM6IEV4ZWN1dGVDb2RlUGFyYW1zKTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBjb25zdCBjb2RlID0gdHlwZW9mIHBhcmFtcy5jb2RlID09PSAnc3RyaW5nJyA/IHBhcmFtcy5jb2RlIDogJyc7XG4gICAgaWYgKCFjb2RlLnRyaW0oKSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6ICdleGVjdXRlX2NvZGXvvJpjb2RlIOaYr+epuueahOOAgicsIGVycm9yOiAnY29kZSDkuI3og73kuLrnqbonIH07XG4gICAgfVxuXG4gICAgY29uc3QgdGltZW91dE1zID0gY2xhbXBUaW1lb3V0KHBhcmFtcy50aW1lb3V0TXMsIFNBTkRCT1hfREVGQVVMVFMudGltZW91dE1zKTtcbiAgICBjb25zdCBhcmdzID1cbiAgICAgICAgcGFyYW1zLmFyZ3MgJiYgdHlwZW9mIHBhcmFtcy5hcmdzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShwYXJhbXMuYXJncylcbiAgICAgICAgICAgID8gKHBhcmFtcy5hcmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgICAgICAgOiB7fTtcblxuICAgIC8qKlxuICAgICAqIGBjb250ZXh0YCDnmoTkuInnp43mg4XlhrXvvIwqKumDveimgeivtOa4heaYr+WTquS4gOenjSoq77yaXG4gICAgICog4pGgIOaYvuW8j+e7meS6hiDihpIg54Wn5YGa77yI5ZCO6Z2i5Ye66ZSZ5pe25oyJ6L+Z5Liq5LiK5LiL5paH57+76K+R6ZSZ6K+v77yJ77ybXG4gICAgICog4pGhIOayoee7mSDihpIg5oyJ5Luj56CB6YeM55qE5qCH6K+G56ym5o6o5pat77yM5bm25Zyo5Zue5omn6YeM5rOo5piOIGBjb250ZXh0SW5mZXJyZWQ6IHRydWVgXG4gICAgICogICAg77yI5oKE5oKE5pu/5qih5Z6L5YGa5Yaz5a6a5L2G5LiN5ZGK6K+J5a6D77yM5LiL5qyh5a6D6L+Y5piv5Lya5ryP5YaZ77yJ77ybXG4gICAgICog4pGiIOaOqOaWreS5n+S4jeaIkOeriyDihpIgZWRpdG9y77yI5peg5Ymv5L2c55So55qE6YKj5Liq77yJ44CCXG4gICAgICovXG4gICAgY29uc3QgZXhwbGljaXQ6IENvZGVDb250ZXh0IHwgbnVsbCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6IHBhcmFtcy5jb250ZXh0ID09PSAnZWRpdG9yJyA/ICdlZGl0b3InIDogbnVsbDtcbiAgICBjb25zdCBpbmZlcnJlZCA9IGV4cGxpY2l0ID09PSBudWxsID8gaW5mZXJDb250ZXh0KGNvZGUpIDogbnVsbDtcbiAgICBjb25zdCBjb250ZXh0OiBDb2RlQ29udGV4dCA9IGV4cGxpY2l0ID8/IGluZmVycmVkIS5jb250ZXh0O1xuXG4gICAgY29uc3QgcmVwbHkgPVxuICAgICAgICBjb250ZXh0ID09PSAnc2NlbmUnXG4gICAgICAgICAgICA/IGF3YWl0IHJ1blNjZW5lQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMsIHBhcmFtcy5zbmFwc2hvdCA9PT0gdHJ1ZSlcbiAgICAgICAgICAgIDogYXdhaXQgcnVuRWRpdG9yQ29kZShjb2RlLCBhcmdzLCB0aW1lb3V0TXMpO1xuXG4gICAgLyoqXG4gICAgICog5rKh57uZIGNvbnRleHQg55qE6YKj5qyh77ya5oqK44CM5oiR5pu/5L2g6YCJ5LqG5ZOq5Liq44CB5Yet5LuA5LmI44CN5YaZ6L+b5Zue5omn44CCXG4gICAgICpcbiAgICAgKiDlhpnlnKgqKuS/oeWwgSoq77yIYGRhdGFg77yJ6YeM6ICM5LiN5piv5Y+q5YaZ5Zyo5paH5pys6YeM77yM5piv5Li65LqGIGB1bndyYXBTYW5kYm94UmVzdWx0YCDkuYvlpJbnmoTosIPnlKjmlrlcbiAgICAgKiDvvIjpnaLmnb/jgIHml6Xlv5fvvInkuZ/nnIvlvpfliLDvvJvmlofmnKzph4zlkIzmoLfkvJrlh7rnjrAg4oCU4oCUIOaooeWei+WPquivu+aWh+acrOOAglxuICAgICAqL1xuICAgIGlmIChpbmZlcnJlZCkge1xuICAgICAgICBjb25zdCBlbnZlbG9wZSA9IHJlcGx5LmRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChlbnZlbG9wZSkge1xuICAgICAgICAgICAgZW52ZWxvcGUuY29udGV4dEluZmVycmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IHdoeSA9XG4gICAgICAgICAgICAgICAgY29udGV4dCA9PT0gJ3NjZW5lJ1xuICAgICAgICAgICAgICAgICAgICA/IGDku6PnoIHph4zlh7rnjrDkuoYgJHtpbmZlcnJlZC5zY2VuZU1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICA6IGluZmVycmVkLmVkaXRvck1hcmtlcnMubGVuZ3RoID4gMFxuICAgICAgICAgICAgICAgICAgICAgID8gYOS7o+eggemHjOWHuueOsOS6hiAke2luZmVycmVkLmVkaXRvck1hcmtlcnMuam9pbignIC8gJyl9YFxuICAgICAgICAgICAgICAgICAgICAgIDogJ+S7o+eggemHjOayoeacieWPquWxnuS6juafkOS4gOS+p+eahOagh+ivhuespic7XG4gICAgICAgICAgICBjb25zdCBub3RlcyA9IChlbnZlbG9wZS5ub3RlcyBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCkgPz8gW107XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGDmsqHnu5kgY29udGV4dO+8jOaMieOAjCR7d2h5feOAjeaOqOaWreS4uiAnJHtjb250ZXh0fSfvvIjkuIvmrKHor7fmmL7lvI/kvKAgY29udGV4dO+8iWApO1xuICAgICAgICAgICAgZW52ZWxvcGUubm90ZXMgPSBub3RlcztcbiAgICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgcmVwbHkudGV4dCA9PT0gJ3N0cmluZycgPyByZXBseS50ZXh0IDogJyc7XG4gICAgICAgICAgICByZXBseS50ZXh0ID0gdGV4dC5yZXBsYWNlKC9cXG4kLywgYFxcbi8vIGNvbnRleHQg5pyq57uZ77yM5oyJ44CMJHt3aHl944CN5o6o5pat5Li6ICcke2NvbnRleHR9J1xcbmApO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXBseTtcbn1cblxuLyoqIOWcuuaZr+S+p+aIquWbvuWKqeaJi+WbuuWumui1sOi/meS4gOihjO+8iOecn+ato+eahOWunueOsOWcqCBzb3VyY2Uvc2NlbmUudHMg55qEIGBjYXB0dXJlVmlld2Ag6YeM77yJ44CCICovXG5jb25zdCBDQVBUVVJFX1ZJRVdfU0NFTkVfQ09ERSA9ICdyZXR1cm4gYXdhaXQgY2FwdHVyZVZpZXcoYXJncyk7JztcblxuLyoqIOaIquWbvum7mOiupOiQveebmOebruW9le+8muezu+e7n+S4tOaXtuebruW9le+8jOS4juWFt+S9k+W3peeoi+aXoOWFs+OAgiAqL1xuZnVuY3Rpb24gZGVmYXVsdENhcHR1cmVQYXRoKGZvcm1hdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBkaXIgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksICdkc2gtY29jb3MtY2FwdHVyZXMnKTtcbiAgICBjb25zdCBzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csICctJyk7XG4gICAgcmV0dXJuIHBhdGguam9pbihkaXIsIGBzY2VuZS12aWV3LSR7c3RhbXB9LiR7Zm9ybWF0ID09PSAnanBlZycgPyAnanBnJyA6ICdwbmcnfWApO1xufVxuXG4vKipcbiAqIOaIquS4gOW8oCoq5Zy65pmv6KeG5Zu+KirlubblrZjmiJDlm77niYfmlofku7bvvIhgY29jb3NfY2FwdHVyZV92aWV3YCDnmoTlrp7njrDvvInjgIJcbiAqXG4gKiDkuLrku4DkuYjljZXni6zkuIDmnaHpgJrpgZPvvJrlm77niYfmmK/kuozov5vliLYv5aSn5a2X56ym5Liy77yM5aGe5LiN6L+bIGBleGVjdXRlX2NvZGVgIOeahOi/lOWbnuWAvOS4iumZkFxuICog77yI5Y2V5a2X56ym5LiyIDQwMDAg5a2X77yJ4oCU4oCUIOaJgOS7peWug+W/hemhu+aYr+OAjOW3peWFtyDihpIg6JC955uYIOKGkiDlm57ot6/lvoTjgI3jgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVWaWV3KHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIGNvbnN0IGZvcm1hdCA9IHBhcmFtcy5mb3JtYXQgPT09ICdqcGVnJyB8fCBwYXJhbXMuZm9ybWF0ID09PSAnanBnJyA/ICdqcGVnJyA6ICdwbmcnO1xuICAgIGNvbnN0IHNhdmVQYXRoID1cbiAgICAgICAgdHlwZW9mIHBhcmFtcy5zYXZlUGF0aCA9PT0gJ3N0cmluZycgJiYgcGFyYW1zLnNhdmVQYXRoLnRyaW0oKVxuICAgICAgICAgICAgPyBwYXRoLnJlc29sdmUocGFyYW1zLnNhdmVQYXRoLnRyaW0oKSlcbiAgICAgICAgICAgIDogZGVmYXVsdENhcHR1cmVQYXRoKGZvcm1hdCk7XG4gICAgY29uc3QgbWF4V2lkdGggPSBjbGFtcEludChwYXJhbXMubWF4V2lkdGgsIDMyLCA0MDk2LCA2NDApO1xuICAgIGNvbnN0IHF1YWxpdHkgPVxuICAgICAgICB0eXBlb2YgcGFyYW1zLnF1YWxpdHkgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShwYXJhbXMucXVhbGl0eSlcbiAgICAgICAgICAgID8gTWF0aC5taW4oMSwgTWF0aC5tYXgoMC4xLCBwYXJhbXMucXVhbGl0eSkpXG4gICAgICAgICAgICA6IDAuOTtcbiAgICBjb25zdCB3YWl0TXMgPSBjbGFtcEludChwYXJhbXMud2FpdE1zLCAwLCA1MDAwLCA4MDApO1xuICAgIGNvbnN0IHRpbWVvdXRNcyA9IGNsYW1wVGltZW91dChwYXJhbXMudGltZW91dE1zLCBTQU5EQk9YX0RFRkFVTFRTLnRpbWVvdXRNcyk7XG5cbiAgICBjb25zdCBydW4gPSBhd2FpdCBydW5TY2VuZUNvZGUoQ0FQVFVSRV9WSUVXX1NDRU5FX0NPREUsIHsgc2F2ZVBhdGgsIG1heFdpZHRoLCBmb3JtYXQsIHF1YWxpdHksIHdhaXRNcyB9LCB0aW1lb3V0TXMsIGZhbHNlKTtcblxuICAgIGNvbnN0IGZhaWwgPSAobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVG9vbFJlcGx5ID0+IHtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSwgLi4uKGV4dHJhID8/IHt9KSB9O1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBlcnJvcjogbWVzc2FnZSwgZGF0YTogcGF5bG9hZCB9O1xuICAgIH07XG5cbiAgICBjb25zdCBlbnZlbG9wZSA9IHJ1bi5kYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGlmICghZW52ZWxvcGUgfHwgZW52ZWxvcGUub2sgIT09IHRydWUpIHtcbiAgICAgICAgLy8g5Zy65pmv5L6n5bey57uP5oqK5Y6f5Zug6K+05riF5qWa5LqG77yI5rKh5byA5Zy65pmvIC8g5omn6KGM5oql6ZSZ77yJ77yM5Y6f5qC35Lyg5Zue5Y67XG4gICAgICAgIHJldHVybiBydW47XG4gICAgfVxuXG4gICAgY29uc3QgY2FwdHVyZWQgPSBlbnZlbG9wZS5yZXN1bHQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgaWYgKCFjYXB0dXJlZCB8fCBjYXB0dXJlZC5vayAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gZmFpbChTdHJpbmcoKGNhcHR1cmVkICYmIGNhcHR1cmVkLmVycm9yKSB8fCAn5oiq5Zu+5aSx6LSl77yI5Zy65pmv5L6n5rKh5pyJ6L+U5Zue5Zu+54mH77yJJyksIHsgc2NlbmU6IGNhcHR1cmVkID8/IG51bGwgfSk7XG4gICAgfVxuXG4gICAgLy8g5Zy65pmv5L6n6IO96JC955uY5bCx6JC955uY5LqG77yI6L+U5ZueIHBhdGjvvInvvJvlkKbliJnlm57kvKDliIblnZcgYmFzZTY077yM6L+Z6YeM5ou85Zue5p2l5YaZ55uYIOKAlOKAlFxuICAgIC8vIOaymeeusei/lOWbnuWAvOacieOAjOWNleWtl+espuS4siA0MDAwIOWtl+OAjeS4iumZkO+8jOaVtOW8oOWbvuWhnuS4jei/m+S4gOS4quWtl+auteOAglxuICAgIGNvbnN0IGZpbGVQYXRoID0gdHlwZW9mIGNhcHR1cmVkLnBhdGggPT09ICdzdHJpbmcnICYmIGNhcHR1cmVkLnBhdGggPyBjYXB0dXJlZC5wYXRoIDogc2F2ZVBhdGg7XG4gICAgaWYgKGNhcHR1cmVkLnRyYW5zcG9ydCAhPT0gJ2ZpbGUnKSB7XG4gICAgICAgIGNvbnN0IGNodW5rcyA9IEFycmF5LmlzQXJyYXkoY2FwdHVyZWQuY2h1bmtzKSA/IGNhcHR1cmVkLmNodW5rcy5tYXAoKGMpID0+IFN0cmluZyhjKSkgOiBbXTtcbiAgICAgICAgY29uc3QgYmFzZTY0ID0gY2h1bmtzLmpvaW4oJycpO1xuICAgICAgICBpZiAoIWJhc2U2NCkgcmV0dXJuIGZhaWwoJ+aIquWbvuayoeacieS6p+WHuuWbvueJh+aVsOaNricsIHsgc2NlbmU6IGNhcHR1cmVkIH0pO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZGlyID0gcGF0aC5kaXJuYW1lKGZpbGVQYXRoKTtcbiAgICAgICAgICAgIGlmIChkaXIpIGZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgQnVmZmVyLmZyb20oYmFzZTY0LCAnYmFzZTY0JykpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWlsKGDlhpnlhaXmiKrlm77mlofku7blpLHotKXvvJoke2Rlc2NyaWJlKGVycil9YCwgeyBwYXRoOiBmaWxlUGF0aCwgc2NlbmU6IGNhcHR1cmVkIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGJ5dGVzID0gdHlwZW9mIGNhcHR1cmVkLmJ5dGVzID09PSAnbnVtYmVyJyA/IGNhcHR1cmVkLmJ5dGVzIDogMDtcbiAgICB0cnkge1xuICAgICAgICBieXRlcyA9IGZzLnN0YXRTeW5jKGZpbGVQYXRoKS5zaXplO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiDlsLrlr7jor7vkuI3liLDkuI3lvbHlk43kvb/nlKggKi9cbiAgICB9XG5cbiAgICBjb25zdCBibGFua1JhdGlvID0gdHlwZW9mIGNhcHR1cmVkLmJsYW5rUmF0aW8gPT09ICdudW1iZXInID8gY2FwdHVyZWQuYmxhbmtSYXRpbyA6IG51bGw7XG4gICAgY29uc3QgYmxhbmsgPSBibGFua1JhdGlvICE9PSBudWxsICYmIGJsYW5rUmF0aW8gPj0gMC45NTtcblxuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgcGF0aDogZmlsZVBhdGgsXG4gICAgICAgIHdpZHRoOiBjYXB0dXJlZC53aWR0aCxcbiAgICAgICAgaGVpZ2h0OiBjYXB0dXJlZC5oZWlnaHQsXG4gICAgICAgIHNvdXJjZVdpZHRoOiBjYXB0dXJlZC5zb3VyY2VXaWR0aCxcbiAgICAgICAgc291cmNlSGVpZ2h0OiBjYXB0dXJlZC5zb3VyY2VIZWlnaHQsXG4gICAgICAgIGZvcm1hdDogY2FwdHVyZWQuZm9ybWF0ID8/IGZvcm1hdCxcbiAgICAgICAgYnl0ZXMsXG4gICAgICAgIGJsYW5rUmF0aW8sXG4gICAgICAgIC8vIOinhuWbvueKtuaAge+8iHZpc2libGVTaXplIC8gZGVzaWduUmVzb2x1dGlvbiAvIGNhbnZhcyAvIHZpc2libGVNYXRjaGVzRGVzaWdu77yJ4oCU4oCUXG4gICAgICAgIC8vIOepuueZveW4p+aXtueUqOadpeWIpOaWreOAjOaYr+S4jeaYr+e8lui+keWZqOWcuuaZr+inhuWbvueahOiuvuWkh+aooeaLn+iiq+aUuei/h+OAjVxuICAgICAgICB2aWV3OiBjYXB0dXJlZC52aWV3ID8/IG51bGwsXG4gICAgICAgIHRyYW5zcG9ydDogY2FwdHVyZWQudHJhbnNwb3J0ID09PSAnZmlsZScgPyAnc2NlbmUnIDogJ2VkaXRvcicsXG4gICAgfTtcbiAgICAvKipcbiAgICAgKiDimqAgKirnqbrnmb3luKfkuI3mmK/jgIzlho3or5XkuIDmrKHjgI3og73op6PlhrPnmoQqKu+8jOaJgOS7peW/hemhu+e7memAgOi3r+OAglxuICAgICAqXG4gICAgICog5Y6G5Y+y77yIMjAyNi0wOS0zMCAwNDoyMyDkvJror53vvInvvJpgY2FwdHVyZV92aWV3YCDogIHogIHlrp7lrp7lm57kuoYgYGJsYW5rUmF0aW86IDFg77yMXG4gICAgICog5L2G5Y+q6YWN5LqG5LiA5Y+l44CM5o6l6L+RIDEg6K+05piO5Z+65pys5piv56m65Zu+44CN4oCU4oCUIOaooeWei+S6juaYr+iHquW3seW+gOS4i+ivle+8mumHjeivlSBgd2FpdE1zYCDihpIgYHNlbGVjdGAvYGZvY3VzLWNhbWVyYWBcbiAgICAgKiDihpIgYGNjLlJlbmRlclRleHR1cmVgIOemu+WxjyDihpIg5pyA5ZCO55So6IqC54K55pWw5o2uICsgQ2FudmFzMkQg5omL57uY5biD5bGA5a+554Wn5Zu+77yMKirmlbTmlbQgMTYg5q2lKirjgIJcbiAgICAgKiDogIznnJ/nm7jmmK/vvJrkuKTlpKnliY3mnInkurrvvIjlsLHmmK/lroPoh6rlt7HvvInnlKggYHNldERlc2lnblJlc29sdXRpb25TaXplYCDmiorlnLrmma/op4blm77nmoTorr7lpIfmqKHmi5/lvITlnY/kuobvvIxcbiAgICAgKiDov5nkuKrlt67lvILmnKzmnaXlsLHlnKggYHZpZXdgIOmHjOmHj+W+l+WHuuadpeOAglxuICAgICAqL1xuICAgIHBheWxvYWQuaGludCA9IGJsYW5rXG4gICAgICAgID8gJ+i/meaYr+epuuWbvu+8iGJsYW5rUmF0aW/iiYgx77yJ77yMKirliKvlho3ph43or5XmiKrlm74qKu+8iOaNoiB3YWl0TXMgLyDph43mlrDogZrnhKYgLyDmjaIgbWF4V2lkdGgg6YO95LiN5Lya5Y+Y77yJ4oCU4oCUIOWFiOeciyBgdmlld2Ag5YaN5Yaz5a6a77yM5oyJ6aG65bqP5YGa77yaJyArXG4gICAgICAgICAgJ+KRoCBgdmlldy52aXNpYmxlTWF0Y2hlc0Rlc2lnbiA9PT0gZmFsc2Vg77ya57yW6L6R5Zmo5Zy65pmv6KeG5Zu+55qEKirorr7lpIfmqKHmi5/ooqvmlLnov4cqKu+8iOWOhuWPsuS4iuaYr+acieS6uuiwg+S6hiBgY2Mudmlldy5zZXREZXNpZ25SZXNvbHV0aW9uU2l6ZWDvvInigJTigJQg5Zyo5Zy65pmv6KeG5Zu+5bel5YW35qCP6YeN5paw6YCJ5LiA5qyh6K6+5aSH5YiG6L6o546H5Y2z5Y+v5oGi5aSN77yM57qv6KeG5Zu+6K6+572u44CB5LiN5b2x5ZON5Zy65pmv5LiO6aKE5Yi25Lu25pWw5o2u77ybJyArXG4gICAgICAgICAgJ+KRoSBgdmlldy52aXNpYmxlTWF0Y2hlc0Rlc2lnbiA9PT0gdHJ1ZWAg5Y205LuN54S256m677ya6K+05piOKirov5nkuKrnjq/looPlvZPkuIvnoa7lrp7lj5bkuI3liLDnlLvpnaIqKu+8iOWunua1i+WcqOe8lui+keWZqOacgOWwj+WMli/ooqvpga7mjKHjgIHlnLrmma/op4blm77mnKrmuLLmn5Pml7blsLHmmK/ov5nmoLfvvInigJTigJQg5LiN6KaB6Ieq5bu656a75bGP5riy5p+T5Zmo77yI5Y6G5Y+y5LiK5pyJ5Lq65Li65q2k6Iqx5LqGIDE2IOatpe+8ie+8jOebtOaOpei9rOaVsOWAvOWIpOaNru+8mycgK1xuICAgICAgICAgICfikaIg55S76Z2i6aqM5pS25pS555SoKirmlbDlgLzliKTmja4qKu+8mmB3b3JsZFJlY3Qobm9kZSlgIOaLv+ecn+WunuS4lueVjOefqeW9oiAvIOiHquW3seeul+mHjeWPoOS4jui2iueVjCAvIOmAkOiKgueCueivuyBjb2xvcsK3Y29udGVudFNpemXvvJsnICtcbiAgICAgICAgICAn4pGjIOehruWunumcgOimgeiCieecvOehruiupOaXtu+8jOaMieiKgueCueecn+WunuaVsOaNruWHuuS4gOW8oOW4g+WxgOWvueeFp+Wbvu+8iOWOhuWPsuWBmuazle+8mmB3b3JsZFJlY3RgIOWvvOWHuuihjCDihpIg6ISa5pys55S7IFBORyDihpIg5Zu+54mH6K+75Y+W77yJ77yM5bm25Zyo5Lqk5LuY6YeMKirlpoLlrp7lo7DmmI7jgIznnJ/lrp7muLLmn5PmiKrlm77mnKrlrozmiJDjgI0qKuOAgidcbiAgICAgICAgOiAn55So5Zu+54mH6K+75Y+W6IO95Yqb5omT5byAIHBhdGgg55yL5LiA55y855S76Z2i77yM5YaN5Yaz5a6a5LiL5LiA5q2l44CCJztcbiAgICBpZiAoY2FwdHVyZWQuc2F2ZUVycm9yKSBwYXlsb2FkLnNjZW5lV3JpdGVFcnJvciA9IGNhcHR1cmVkLnNhdmVFcnJvcjtcblxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZGF0YTogcGF5bG9hZCB9O1xufVxuXG4vKiog5o6i5rS777ya5Zy65pmv6L+b56iL6YeM5pys5omp5bGV55qE6ISa5pys5Yqg6L295LqG5ZCX77yIYGNvY29zX2VkaXRvcl9zdGF0ZWAg55So5a6D6K+05piO44CM6IO95LiN6IO95Yqo5Zy65pmv44CN77yJ44CCICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGluZ1NjZW5lU2NyaXB0KCk6IFByb21pc2U8eyBhdmFpbGFibGU6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBjYWxsU2NlbmVTY3JpcHQ8eyBvaz86IGJvb2xlYW4gfT4oU0NFTkVfTUVUSE9ELnBpbmcpO1xuICAgICAgICByZXR1cm4gdmFsdWUgJiYgdmFsdWUub2sgPyB7IGF2YWlsYWJsZTogdHJ1ZSB9IDogeyBhdmFpbGFibGU6IGZhbHNlLCByZWFzb246ICflnLrmma/ohJrmnKzov5Tlm57lvILluLgnIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IGF2YWlsYWJsZTogZmFsc2UsIHJlYXNvbjogZGVzY3JpYmUoZXJyKSB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDlnLrmma/kvqfnmoTlj43lsIQg4oCU4oCUIOi9rOWPkee7meacrOaJqeWxleeahOWcuuaZr+iEmuacrO+8iOmCoyAyMDAg5aSa6KGM44CM5LuOIGBfX3Byb3BzX19gICsg5a6e5pe25a6e5L6L6K+75bGe5oCn5ZCN44CNXG4gKiDnmoTpgLvovpHkuIDooYzpg73kuI3nlKjph43lhpnvvInjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlc2NyaWJlU2NlbmVBcGkoXG4gICAgdGFyZ2V0OiBzdHJpbmcsXG4gICAgbm9kZVV1aWQ6IHN0cmluZyxcbiAgICBsaW1pdDogbnVtYmVyLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHZhbHVlID0gKGF3YWl0IGNhbGxTY2VuZVNjcmlwdDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oU0NFTkVfTUVUSE9ELmRlc2NyaWJlQXBpLCBbXG4gICAgICAgIHsgdGFyZ2V0LCBub2RlVXVpZDogbm9kZVV1aWQgfHwgdW5kZWZpbmVkLCBsaW1pdCB9LFxuICAgIF0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WcuuaZr+iEmuacrCBkZXNjcmliZUFwaSDmsqHmnInov5Tlm57nu5PmnpzjgIInKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuIl19