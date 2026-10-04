/**
 * DSH 的原生工具怎么落到编辑器上 —— 也就是 IPC 请求的服务端实现。
 *
 * ## 引擎在哪：本扩展自带，不依赖别的扩展
 *
 * 执行能力（编辑器/场景代码沙箱、超时、日志收集、序列化上限、gizmo 污染过滤、撤销快照、
 * recipe 五件套）全部在**本扩展自己**的 `core/engine.ts` + `source/scene.ts` 里，
 * 走编辑器**内部**的通道，不经过 loopback HTTP：
 *
 * ```
 * DSH 子进程 --fork IPC--> 本扩展主进程(本文件) --core/engine--> vm 沙箱（editor 上下文）
 *                                                          └--> 本扩展场景脚本（scene 上下文）
 * ```
 *
 * 场景脚本由 `package.json` 的 `contributions.scene` 注册（`dist/scene.js`），
 * 编辑器在**打开场景**时把它加载进引擎进程 —— 所以「没打开场景」是唯一一个
 * 需要向模型解释清楚的失败模式（见 `SCENE_SCRIPT_HINT`）。
 *
 * ## 四个方法，其中两个是「别猜」的护栏
 *
 * IPC 协议要窄。语义方法越少，DSH 侧插件的参数校验与这里的实现越不容易错位。
 * 需要新能力时优先扩 `execute_code` 的用法（它就是通用逃生口），而不是加新方法。
 *
 * | 方法 | 角色 |
 * |---|---|
 * | `execute_code` | 通用逃生口。写代码，一次执行里完成「取数据 → 改状态 → 返回结论」 |
 * | `describe_api` | **渐进式披露** —— 别猜引擎/编辑器 API，按需查一个命名空间或一个类 |
 * | `editor_state` | 按需自检：我在哪个工程/场景、选中了什么、沙箱能不能动 |
 * | `capture_view` | **唯一例外**：把场景视图存成图片文件、回路径。像素塞不进返回值上限，只能单独开一条通道 |
 *
 * ## describe_api 的两侧走了两条不同的路
 *
 * - **editor 侧**：编辑器主进程的反射没有对外消息，所以这里自己实现（纯反射，约 90 行），
 *   但 `helpers` 一档**回沙箱问** `helperNames()` —— 助手清单是沙箱自己的事实，
 *   抄一份必然过期。
 * - **scene 侧**：转发给本扩展的场景脚本（`describeApi`）。类的属性名要从 `__props__` +
 *   实时实例上读，那部分是 `scene.ts` 里最不该重写的代码。
 *
 * ⚠ `execute-scene-script` **需要场景进程里已经加载了本扩展脚本**（要有场景打开）。
 * 没加载时抛错 —— 所以那一档必须把失败翻译成「先打开一个场景」。
 */

import { EXTENSION_NAME, type ToolReply } from './constants';
import { captureView, describeSceneApi, executeCode, pingSceneScript as pingScene } from './core/engine';

export type { ToolReply };

/** 把任意异常收敛成一句话。 */
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 剥掉沙箱结果外面那层信封。
 *
 * `structured`/`data` 的形状是 `{ ok, context, durationMs, result }`（`result` 才是 `return` 的值），
 * 但错误分支里没有 `result`、只有 `error`。所以这里做「有 result 就取 result」的容错解包，
 * 让调用方拿到的永远是**沙箱里 return 的那个东西**。
 *
 * @param structured - 沙箱回执的 `data` 字段。
 * @returns 沙箱返回值；无法判定时原样返回。
 */
function unwrapSandboxResult(structured: unknown): unknown {
    if (!structured || typeof structured !== 'object') return structured;
    const envelope = structured as { result?: unknown };
    return 'result' in envelope ? envelope.result : structured;
}

/** 场景脚本没加载时的统一文案（多数情况是「没有打开场景」）。 */
const SCENE_SCRIPT_HINT =
    '通常是**当前没有打开场景**（场景进程只在有场景打开时才加载扩展脚本）。' +
    '请在 Cocos Creator 里打开任意场景后重试；若刚启用本扩展，重启一次编辑器更稳。';

/**
 * 在编辑器里执行一段代码（editor 走 vm 沙箱，scene 走本扩展的场景脚本）。
 *
 * @param params - `{context, code, args, timeoutMs, snapshot}`。
 * @returns 工具回执；失败也返回 `ok:false` 而不是抛（让模型看到可读的原因）。
 */
export async function runExecuteCode(params: Record<string, unknown>): Promise<ToolReply> {
    return executeCode(params);
}

/**
 * 截一张**场景视图**并存成图片文件（实现在 `core/engine.ts` + `source/scene.ts`）。
 *
 * 为什么单独一个方法：图片是二进制/大字符串，塞不进 `execute_code` 的返回值上限
 * （单字符串 4000 字）—— 所以它必须是「工具 → 落盘 → 回路径」这一条独立通道。
 *
 * @param params - `{savePath?, maxWidth?, format?, quality?, waitMs?, timeoutMs?}`。
 * @returns `data.path` 是图片绝对路径，可直接喂给图片读取工具。
 */
export async function runCaptureView(params: Record<string, unknown>): Promise<ToolReply> {
    return captureView(params);
}

/**
 * 查一个 API 定义 —— **渐进式披露**，也是「别猜引擎 API」这条规矩的执行者。
 *
 * 为什么值得单独一个工具：模型写编辑器代码时最爱瞎猜属性名（`comp.fov` 还是
 * `comp.fovAxis`），猜错一次的代价是一整轮往返。这里给的是**运行时反射**的结果，
 * 永远比任何缓存/文档新；scene 侧带 `nodeUuid` 时还能补出**当前值**。
 *
 * @param params - `{context, target, nodeUuid, limit}`。
 * @returns 工具回执；`text` 是给模型看的 JSON。
 */
export async function describeApi(params: Record<string, unknown>): Promise<ToolReply> {
    const context = params.context === 'scene' ? 'scene' : 'editor';
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    const nodeUuid = typeof params.nodeUuid === 'string' ? params.nodeUuid : '';
    const limit = clampLimit(params.limit);

    try {
        const payload =
            context === 'editor'
                ? await describeEditorApi(target, limit)
                : await describeSceneApi(target, nodeUuid, limit);
        return { ok: payload.ok !== false, text: JSON.stringify(payload, null, 2), data: payload };
    } catch (error) {
        return {
            ok: false,
            text: `查询 API 定义失败（${context} / ${target || '(总览)'}）：${describe(error)}\n${SCENE_SCRIPT_HINT}`,
        };
    }
}

/** 列表类参数统一夹到 1~500（默认 80）。 */
function clampLimit(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 80;
    return Math.max(1, Math.min(500, raw));
}

/**
 * 常用调用速查 —— 放总览里，让模型少走几轮试错。
 *
 * 这几条是**纯文本知识**（不是能反射出来的东西），所以写成常量是可以接受的；
 * 逻辑别抄（见 `describeEditorApi` 里 `helpers` 那一档的处理方式）。
 */
const EDITOR_CHEATSHEET: Record<string, string> = {
    资源查询: "await Editor.Message.request('asset-db', 'query-assets', { pattern: 'db://assets/**/*.prefab' })",
    资源详情: "await Editor.Message.request('asset-db', 'query-asset-info', urlOrUuid)",
    刷新资源: "await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets')",
    保存场景: "await Editor.Message.request('scene', 'save-scene')",
    打开场景: "await Editor.Message.request('scene', 'open-scene', sceneAssetUuid)",
    选中资源: "await Editor.Message.request('asset-db', 'set-asset-uuid-selection', uuid)",
    读设置: "await Editor.Profile.getConfig('<扩展名>', 'key', 'local')",
    工程路径: 'Editor.Project.path',
    编辑器版本: 'Editor.App.version',
    控制台日志: 'Editor.Logger.query()',
};

/**
 * 编辑器主进程侧的反射（`core/engine.ts` 里没有对应的对外消息，所以这里自己实现）。
 *
 * 四档：总览 / `helpers` / `module:xxx` / `Editor.Xxx.Yyy`。
 */
async function describeEditorApi(target: string, limit: number): Promise<Record<string, unknown>> {
    const editorAny = Editor as unknown as Record<string, unknown>;

    if (!target) {
        const namespaces: Array<{ name: string; methodCount: number; sample: string[] }> = [];
        for (const key of Object.keys(editorAny).sort()) {
            const value = editorAny[key];
            if (!value || typeof value !== 'object') continue;
            let methodNames: string[] = [];
            try {
                methodNames = Object.keys(value as object).filter(
                    (k) => typeof (value as Record<string, unknown>)[k] === 'function',
                );
            } catch {
                methodNames = [];
            }
            namespaces.push({ name: key, methodCount: methodNames.length, sample: methodNames.slice(0, 8) });
        }
        return {
            ok: true,
            kind: 'index',
            context: 'editor',
            namespaces,
            cheatsheet: EDITOR_CHEATSHEET,
            hint:
                "用 cocos_describe_api({context:'editor', target:'Editor.Message'}) 看某个命名空间的方法全表；" +
                "target:'helpers' 看沙箱助手；target:'module:fs' 看某个 node 模块的导出。",
        };
    }

    /**
     * ⚠ **别抄助手清单**：它由沙箱注入（`core/engine.ts` 的 `buildEditorHelpers` + recipe 五件套），
     * 抄一份的下场是「查到的函数在沙箱里不存在」。所以这一档**回沙箱问**。
     */
    if (target === 'helpers') {
        const reply = await runExecuteCode({ context: 'editor', timeoutMs: 8000, code: 'return helperNames();' });
        const names = unwrapSandboxResult(reply.data);
        if (!Array.isArray(names)) {
            return { ok: false, kind: 'helpers', context: 'editor', error: reply.text.slice(0, 800) };
        }
        return { ok: true, kind: 'helpers', context: 'editor', helpers: names };
    }

    if (target.startsWith('module:')) {
        const moduleName = target.slice('module:'.length).trim();
        if (!moduleName) return { ok: false, error: 'module: 后面要跟模块名，如 module:fs' };
        try {
            const loaded = require(moduleName) as Record<string, unknown>;
            const keys = Object.keys(loaded || {}).sort();
            return {
                ok: true,
                kind: 'module',
                module: moduleName,
                exportCount: keys.length,
                exports: keys.slice(0, limit),
                hint: `在 cocos_execute_code 里直接 \`return require('${moduleName}')\` 可以拿到真实对象。`,
            };
        } catch (error) {
            return { ok: false, error: `require('${moduleName}') 失败：${describe(error)}` };
        }
    }

    // 按点分路径在 Editor 上走（`Editor.Message` 与 `Message` 两种写法都认）
    const parts = target.replace(/^Editor\.?/, '').split('.').filter(Boolean);
    let node: unknown = Editor;
    for (const part of parts) {
        if (node === null || node === undefined) return { ok: false, error: `找不到 ${target}（在 ${part} 处断链）` };
        node = (node as Record<string, unknown>)[part];
    }
    if (node === null || node === undefined) return { ok: false, error: `找不到 ${target}` };
    if (typeof node !== 'object') {
        return { ok: true, kind: 'value', target, value: String(node) };
    }

    const methods: string[] = [];
    const values: string[] = [];
    for (const key of Object.keys(node as object).sort()) {
        let entry: unknown;
        try {
            entry = (node as Record<string, unknown>)[key];
        } catch {
            continue;
        }
        if (typeof entry === 'function') methods.push(key);
        else values.push(key);
    }

    return {
        ok: true,
        kind: 'namespace',
        target: `Editor.${parts.join('.')}`,
        methods: methods.slice(0, limit),
        methodCount: methods.length,
        values: values.slice(0, Math.min(30, limit)),
        hint: `调用形如 \`await ${target}.xxx(...)\`；参数顺序见编辑器官方文档，或直接试调看报错。`,
    };
}

/*
 * 场景侧的反射（`describeSceneApi`）与探活（`pingSceneScript`）都在 `core/engine.ts` 里 ——
 * 它们只是 `execute-scene-script` 的一层薄封装，没必要在这里再抄一份。
 */

/**
 * 看一眼编辑器现在是什么状态。
 *
 * 三块信息来自不同进程：
 * - **工程/版本**：主进程的 `Editor.Project` / `Editor.App`；
 * - **选中**：主进程问 `scene` 包的 `query-node-tree`；
 * - **场景**：借本扩展的场景沙箱跑一小段（`director.getScene()`）。
 *
 * 再加一块**能力探活**（很值钱的那部分）：场景脚本加载了没有 ——
 * 模型据此提前知道「接下来能不能动场景」，而不是写了一屏代码才发现没打开场景。
 *
 * 任何一块拿不到都**不阻断**整体——返回已有的部分 + 一条 `…读取失败：原因`，比整个工具失败有用。
 *
 * @param _params - `{verbose?}`（当前 verbose 只影响是否附上运行时诊断）。
 * @returns 工具回执。
 */
export async function readEditorState(_params: Record<string, unknown>): Promise<ToolReply> {
    const lines: string[] = [];
    const data: Record<string, unknown> = {};
    const problems: string[] = [];

    try {
        data.projectPath = Editor.Project.path;
        lines.push(`工程：${Editor.Project.path}`);
    } catch (error) {
        problems.push(`工程路径读取失败：${describe(error)}`);
    }

    try {
        data.editorVersion = Editor.App.version;
        data.editorName = Editor.App.name;
        lines.push(`编辑器：${Editor.App.name} ${Editor.App.version}`);
    } catch (error) {
        problems.push(`编辑器版本读取失败：${describe(error)}`);
    }

    try {
        const selected = (await Editor.Message.request('scene', 'query-node-tree')) as
            | { uuid?: string; name?: string }
            | undefined;
        if (selected && typeof selected === 'object') {
            data.selection = { uuid: selected.uuid ?? null, name: selected.name ?? null };
            lines.push(`选中：${selected.name ?? '(无名)'}${selected.uuid ? ` [${selected.uuid}]` : ''}`);
        } else {
            data.selection = null;
            lines.push('选中：无');
        }
    } catch (error) {
        data.selection = null;
        problems.push(`选中信息读取失败：${describe(error)}`);
    }

    // 场景信息要借场景进程（主进程拿不到活的场景树）
    const sceneProbe = await runExecuteCode({
        context: 'scene',
        timeoutMs: 8000,
        code:
            'const s = director.getScene();' +
            ' let n = 0;' +
            ' eachNode(() => { n += 1; });' +
            ' return { hasScene: !!s, name: s ? s.name : null, uuid: s ? s.uuid : null, nodeCount: n };',
    });
    /**
     * ⚠ **踩过的坑**：沙箱回执是套了一层的
     * `{ ok, context, durationMs, result }` —— 沙箱的返回值在 `.result` 里。
     * 第一版直接当 `{hasScene}` 读，于是 `hasScene` 恒为 undefined → 界面永远显示
     * 「场景：未打开」（而场景其实开着、546 个节点）。工具本身没报错，所以特别难发现。
     */
    const probe = unwrapSandboxResult(sceneProbe.data) as
        | { hasScene?: boolean; name?: string; uuid?: string; nodeCount?: number }
        | undefined;
    if (sceneProbe.ok && probe) {
        data.scene = probe;
        lines.push(
            probe.hasScene
                ? `场景：${probe.name ?? '(未命名)'} [${probe.uuid ?? '-'}]，节点 ${probe.nodeCount ?? '?'} 个`
                : '场景：未打开',
        );
    } else {
        problems.push(`场景信息读取失败：${sceneProbe.text.slice(0, 200)}`);
    }

    // 能力探活：场景脚本在不在 —— 它决定「接下来能不能改场景」
    const sceneScript = await pingScene();
    data.capabilities = { sandbox: EXTENSION_NAME, sceneScript };
    lines.push(
        sceneScript.available
            ? `能力：代码沙箱可用（本扩展的场景脚本已加载，能改场景）`
            : `能力：只读得动编辑器 —— 场景侧不可用：${sceneScript.reason ?? '场景脚本不可用'}。${SCENE_SCRIPT_HINT}`,
    );

    if (problems.length > 0) lines.push('', '⚠ 部分信息没拿到：', ...problems.map((line) => `- ${line}`));

    // 下一步该用什么工具：这几条是**唯一一处模型一定会看到**的用法提示（DSH 不消费 MCP 的 instructions）
    lines.push(
        '',
        '下一步：',
        // ⚠ 第一条就是 recipe：实测一整夜里 `findRecipes` 被调用 0 次，而唯一存下的那条 recipe
        //   又因目录改名成了孤儿 —— 提示位不摆在这里，这套机制就永远是空的。
        "- **先找可复用配方**：cocos_execute_code({context:'editor', code:\"return findRecipes()\"}) —— 做 UI/预制件/批量改节点这类活之前先看有没有跑通过的代码",
        "- 场景树骨架：cocos_execute_code({context:'scene', code:'return tree({maxDepth:2, withComponents:true})'})",
        "- 组件有哪些属性：cocos_describe_api({context:'scene', target:'cc.Camera', nodeUuid:'<上面查到的 uuid>'})",
        '- 编辑器 API 总览：cocos_describe_api({context:"editor"})',
        "- 列资源：cocos_execute_code({code:\"return (await Editor.Message.request('asset-db','query-assets',{pattern:'db://assets/**/*.prefab'})).slice(0,20).map(a=>a.url)\"})",
    );

    /**
     * ⚠ **`ok` 的语义：这个工具「跑成功了没有」，不是「每一项都拿到了没有」**。
     *
     * 踩过的坑（代价 59 分钟的排查会话）：原来写的是 `ok: problems.length === 0` —— 于是
     * 「四项探针三项成功、只有场景一项失败」也会回 `ok: false`，而桥接侧
     * （`dsh-profile/plugin/dsh-cocos-bridge/index.js`）见 `ok:false` 就 reject，
     * 把整段人话文案当成 `Error:` 抛到用户面前。用户看到的是「一个自检工具报错了」，
     * 于是开了一条会话去查「插件是不是坏了」—— 真相只是那个扩展被禁用了。
     *
     * 现在的口径：**只要拿到任何一块有效信息就算成功**（并附 `data.problems` 与 `data.degraded`），
     * 只有「什么都没拿到」才算失败。上面注释里本来写的就是「任何一块拿不到都不阻断整体」，
     * 之前是 `ok` 的算法与这句话自相矛盾。
     */
    const gotAnything =
        Boolean(data.projectPath) || Boolean(data.editorVersion) || Boolean(data.scene) || Boolean(data.selection);

    return {
        ok: gotAnything,
        text: lines.join('\n'),
        data: { ...data, problems, degraded: problems.length > 0 },
    };
}

/**
 * IPC 方法分发表。
 *
 * ⚠ 键名必须与 DSH 侧插件里 `ipcCall('...')` 的字符串一致
 * （见 `dsh-profile/plugin/dsh-cocos-bridge/index.js`）。
 */
export const COCOS_IPC_METHODS: Record<string, (params: Record<string, unknown>) => Promise<ToolReply>> = {
    execute_code: runExecuteCode,
    describe_api: describeApi,
    editor_state: readEditorState,
    capture_view: runCaptureView,
};
