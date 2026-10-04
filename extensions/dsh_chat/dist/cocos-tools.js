"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.COCOS_IPC_METHODS = void 0;
exports.runExecuteCode = runExecuteCode;
exports.runCaptureView = runCaptureView;
exports.describeApi = describeApi;
exports.readEditorState = readEditorState;
const constants_1 = require("./constants");
const engine_1 = require("./core/engine");
/** 把任意异常收敛成一句话。 */
function describe(error) {
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
function unwrapSandboxResult(structured) {
    if (!structured || typeof structured !== 'object')
        return structured;
    const envelope = structured;
    return 'result' in envelope ? envelope.result : structured;
}
/** 场景脚本没加载时的统一文案（多数情况是「没有打开场景」）。 */
const SCENE_SCRIPT_HINT = '通常是**当前没有打开场景**（场景进程只在有场景打开时才加载扩展脚本）。' +
    '请在 Cocos Creator 里打开任意场景后重试；若刚启用本扩展，重启一次编辑器更稳。';
/**
 * 在编辑器里执行一段代码（editor 走 vm 沙箱，scene 走本扩展的场景脚本）。
 *
 * @param params - `{context, code, args, timeoutMs, snapshot}`。
 * @returns 工具回执；失败也返回 `ok:false` 而不是抛（让模型看到可读的原因）。
 */
async function runExecuteCode(params) {
    return (0, engine_1.executeCode)(params);
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
async function runCaptureView(params) {
    return (0, engine_1.captureView)(params);
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
async function describeApi(params) {
    const context = params.context === 'scene' ? 'scene' : 'editor';
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    const nodeUuid = typeof params.nodeUuid === 'string' ? params.nodeUuid : '';
    const limit = clampLimit(params.limit);
    try {
        const payload = context === 'editor'
            ? await describeEditorApi(target, limit)
            : await (0, engine_1.describeSceneApi)(target, nodeUuid, limit);
        return { ok: payload.ok !== false, text: JSON.stringify(payload, null, 2), data: payload };
    }
    catch (error) {
        return {
            ok: false,
            text: `查询 API 定义失败（${context} / ${target || '(总览)'}）：${describe(error)}\n${SCENE_SCRIPT_HINT}`,
        };
    }
}
/** 列表类参数统一夹到 1~500（默认 80）。 */
function clampLimit(value) {
    const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 80;
    return Math.max(1, Math.min(500, raw));
}
/**
 * 常用调用速查 —— 放总览里，让模型少走几轮试错。
 *
 * 这几条是**纯文本知识**（不是能反射出来的东西），所以写成常量是可以接受的；
 * 逻辑别抄（见 `describeEditorApi` 里 `helpers` 那一档的处理方式）。
 */
const EDITOR_CHEATSHEET = {
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
async function describeEditorApi(target, limit) {
    const editorAny = Editor;
    if (!target) {
        const namespaces = [];
        for (const key of Object.keys(editorAny).sort()) {
            const value = editorAny[key];
            if (!value || typeof value !== 'object')
                continue;
            let methodNames = [];
            try {
                methodNames = Object.keys(value).filter((k) => typeof value[k] === 'function');
            }
            catch {
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
            hint: "用 cocos_describe_api({context:'editor', target:'Editor.Message'}) 看某个命名空间的方法全表；" +
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
        if (!moduleName)
            return { ok: false, error: 'module: 后面要跟模块名，如 module:fs' };
        try {
            const loaded = require(moduleName);
            const keys = Object.keys(loaded || {}).sort();
            return {
                ok: true,
                kind: 'module',
                module: moduleName,
                exportCount: keys.length,
                exports: keys.slice(0, limit),
                hint: `在 cocos_execute_code 里直接 \`return require('${moduleName}')\` 可以拿到真实对象。`,
            };
        }
        catch (error) {
            return { ok: false, error: `require('${moduleName}') 失败：${describe(error)}` };
        }
    }
    // 按点分路径在 Editor 上走（`Editor.Message` 与 `Message` 两种写法都认）
    const parts = target.replace(/^Editor\.?/, '').split('.').filter(Boolean);
    let node = Editor;
    for (const part of parts) {
        if (node === null || node === undefined)
            return { ok: false, error: `找不到 ${target}（在 ${part} 处断链）` };
        node = node[part];
    }
    if (node === null || node === undefined)
        return { ok: false, error: `找不到 ${target}` };
    if (typeof node !== 'object') {
        return { ok: true, kind: 'value', target, value: String(node) };
    }
    const methods = [];
    const values = [];
    for (const key of Object.keys(node).sort()) {
        let entry;
        try {
            entry = node[key];
        }
        catch {
            continue;
        }
        if (typeof entry === 'function')
            methods.push(key);
        else
            values.push(key);
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
async function readEditorState(_params) {
    var _a, _b, _c, _d, _e, _f, _g;
    const lines = [];
    const data = {};
    const problems = [];
    try {
        data.projectPath = Editor.Project.path;
        lines.push(`工程：${Editor.Project.path}`);
    }
    catch (error) {
        problems.push(`工程路径读取失败：${describe(error)}`);
    }
    try {
        data.editorVersion = Editor.App.version;
        data.editorName = Editor.App.name;
        lines.push(`编辑器：${Editor.App.name} ${Editor.App.version}`);
    }
    catch (error) {
        problems.push(`编辑器版本读取失败：${describe(error)}`);
    }
    try {
        const selected = (await Editor.Message.request('scene', 'query-node-tree'));
        if (selected && typeof selected === 'object') {
            data.selection = { uuid: (_a = selected.uuid) !== null && _a !== void 0 ? _a : null, name: (_b = selected.name) !== null && _b !== void 0 ? _b : null };
            lines.push(`选中：${(_c = selected.name) !== null && _c !== void 0 ? _c : '(无名)'}${selected.uuid ? ` [${selected.uuid}]` : ''}`);
        }
        else {
            data.selection = null;
            lines.push('选中：无');
        }
    }
    catch (error) {
        data.selection = null;
        problems.push(`选中信息读取失败：${describe(error)}`);
    }
    // 场景信息要借场景进程（主进程拿不到活的场景树）
    const sceneProbe = await runExecuteCode({
        context: 'scene',
        timeoutMs: 8000,
        code: 'const s = director.getScene();' +
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
    const probe = unwrapSandboxResult(sceneProbe.data);
    if (sceneProbe.ok && probe) {
        data.scene = probe;
        lines.push(probe.hasScene
            ? `场景：${(_d = probe.name) !== null && _d !== void 0 ? _d : '(未命名)'} [${(_e = probe.uuid) !== null && _e !== void 0 ? _e : '-'}]，节点 ${(_f = probe.nodeCount) !== null && _f !== void 0 ? _f : '?'} 个`
            : '场景：未打开');
    }
    else {
        problems.push(`场景信息读取失败：${sceneProbe.text.slice(0, 200)}`);
    }
    // 能力探活：场景脚本在不在 —— 它决定「接下来能不能改场景」
    const sceneScript = await (0, engine_1.pingSceneScript)();
    data.capabilities = { sandbox: constants_1.EXTENSION_NAME, sceneScript };
    lines.push(sceneScript.available
        ? `能力：代码沙箱可用（本扩展的场景脚本已加载，能改场景）`
        : `能力：只读得动编辑器 —— 场景侧不可用：${(_g = sceneScript.reason) !== null && _g !== void 0 ? _g : '场景脚本不可用'}。${SCENE_SCRIPT_HINT}`);
    if (problems.length > 0)
        lines.push('', '⚠ 部分信息没拿到：', ...problems.map((line) => `- ${line}`));
    // 下一步该用什么工具：这几条是**唯一一处模型一定会看到**的用法提示（DSH 不消费 MCP 的 instructions）
    lines.push('', '下一步：', 
    // ⚠ 第一条就是 recipe：实测一整夜里 `findRecipes` 被调用 0 次，而唯一存下的那条 recipe
    //   又因目录改名成了孤儿 —— 提示位不摆在这里，这套机制就永远是空的。
    "- **先找可复用配方**：cocos_execute_code({context:'editor', code:\"return findRecipes()\"}) —— 做 UI/预制件/批量改节点这类活之前先看有没有跑通过的代码", "- 场景树骨架：cocos_execute_code({context:'scene', code:'return tree({maxDepth:2, withComponents:true})'})", "- 组件有哪些属性：cocos_describe_api({context:'scene', target:'cc.Camera', nodeUuid:'<上面查到的 uuid>'})", '- 编辑器 API 总览：cocos_describe_api({context:"editor"})', "- 列资源：cocos_execute_code({code:\"return (await Editor.Message.request('asset-db','query-assets',{pattern:'db://assets/**/*.prefab'})).slice(0,20).map(a=>a.url)\"})");
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
    const gotAnything = Boolean(data.projectPath) || Boolean(data.editorVersion) || Boolean(data.scene) || Boolean(data.selection);
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
exports.COCOS_IPC_METHODS = {
    execute_code: runExecuteCode,
    describe_api: describeApi,
    editor_state: readEditorState,
    capture_view: runCaptureView,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29jb3MtdG9vbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvY29jb3MtdG9vbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBd0NHOzs7QUF1Q0gsd0NBRUM7QUFXRCx3Q0FFQztBQVlELGtDQWtCQztBQXVKRCwwQ0ErR0M7QUF4VkQsMkNBQTZEO0FBQzdELDBDQUF5RztBQUl6RyxtQkFBbUI7QUFDbkIsU0FBUyxRQUFRLENBQUMsS0FBYztJQUM1QixPQUFPLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNsRSxDQUFDO0FBRUQ7Ozs7Ozs7OztHQVNHO0FBQ0gsU0FBUyxtQkFBbUIsQ0FBQyxVQUFtQjtJQUM1QyxJQUFJLENBQUMsVUFBVSxJQUFJLE9BQU8sVUFBVSxLQUFLLFFBQVE7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUNyRSxNQUFNLFFBQVEsR0FBRyxVQUFrQyxDQUFDO0lBQ3BELE9BQU8sUUFBUSxJQUFJLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO0FBQy9ELENBQUM7QUFFRCxvQ0FBb0M7QUFDcEMsTUFBTSxpQkFBaUIsR0FDbkIsdUNBQXVDO0lBQ3ZDLGdEQUFnRCxDQUFDO0FBRXJEOzs7OztHQUtHO0FBQ0ksS0FBSyxVQUFVLGNBQWMsQ0FBQyxNQUErQjtJQUNoRSxPQUFPLElBQUEsb0JBQVcsRUFBQyxNQUFNLENBQUMsQ0FBQztBQUMvQixDQUFDO0FBRUQ7Ozs7Ozs7O0dBUUc7QUFDSSxLQUFLLFVBQVUsY0FBYyxDQUFDLE1BQStCO0lBQ2hFLE9BQU8sSUFBQSxvQkFBVyxFQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFFRDs7Ozs7Ozs7O0dB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SUFDdEcsWUFBWSxFQUFFLGNBQWM7SUFDNUIsWUFBWSxFQUFFLFdBQVc7SUFDekIsWUFBWSxFQUFFLGVBQWU7SUFDN0IsWUFBWSxFQUFFLGNBQWM7Q0FDL0IsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRFNIIOeahOWOn+eUn+W3peWFt+aAjuS5iOiQveWIsOe8lui+keWZqOS4iiDigJTigJQg5Lmf5bCx5pivIElQQyDor7fmsYLnmoTmnI3liqHnq6/lrp7njrDjgIJcbiAqXG4gKiAjIyDlvJXmk47lnKjlk6rvvJrmnKzmianlsZXoh6rluKbvvIzkuI3kvp3otZbliKvnmoTmianlsZVcbiAqXG4gKiDmiafooYzog73lipvvvIjnvJbovpHlmagv5Zy65pmv5Luj56CB5rKZ566x44CB6LaF5pe244CB5pel5b+X5pS26ZuG44CB5bqP5YiX5YyW5LiK6ZmQ44CBZ2l6bW8g5rGh5p+T6L+H5ruk44CB5pKk6ZSA5b+r54Wn44CBXG4gKiByZWNpcGUg5LqU5Lu25aWX77yJ5YWo6YOo5ZyoKirmnKzmianlsZXoh6rlt7EqKueahCBgY29yZS9lbmdpbmUudHNgICsgYHNvdXJjZS9zY2VuZS50c2Ag6YeM77yMXG4gKiDotbDnvJbovpHlmagqKuWGhemDqCoq55qE6YCa6YGT77yM5LiN57uP6L+HIGxvb3BiYWNrIEhUVFDvvJpcbiAqXG4gKiBgYGBcbiAqIERTSCDlrZDov5vnqIsgLS1mb3JrIElQQy0tPiDmnKzmianlsZXkuLvov5vnqIso5pys5paH5Lu2KSAtLWNvcmUvZW5naW5lLS0+IHZtIOaymeeuse+8iGVkaXRvciDkuIrkuIvmlofvvIlcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlC0tPiDmnKzmianlsZXlnLrmma/ohJrmnKzvvIhzY2VuZSDkuIrkuIvmlofvvIlcbiAqIGBgYFxuICpcbiAqIOWcuuaZr+iEmuacrOeUsSBgcGFja2FnZS5qc29uYCDnmoQgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOazqOWGjO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxuICog57yW6L6R5Zmo5ZyoKirmiZPlvIDlnLrmma8qKuaXtuaKiuWug+WKoOi9vei/m+W8leaTjui/m+eoiyDigJTigJQg5omA5Lul44CM5rKh5omT5byA5Zy65pmv44CN5piv5ZSv5LiA5LiA5LiqXG4gKiDpnIDopoHlkJHmqKHlnovop6Pph4rmuIXmpZrnmoTlpLHotKXmqKHlvI/vvIjop4EgYFNDRU5FX1NDUklQVF9ISU5UYO+8ieOAglxuICpcbiAqICMjIOWbm+S4quaWueazle+8jOWFtuS4reS4pOS4quaYr+OAjOWIq+eMnOOAjeeahOaKpOagj1xuICpcbiAqIElQQyDljY/orq7opoHnqoTjgILor63kuYnmlrnms5XotorlsJHvvIxEU0gg5L6n5o+S5Lu255qE5Y+C5pWw5qCh6aqM5LiO6L+Z6YeM55qE5a6e546w6LaK5LiN5a655piT6ZSZ5L2N44CCXG4gKiDpnIDopoHmlrDog73lipvml7bkvJjlhYjmiakgYGV4ZWN1dGVfY29kZWAg55qE55So5rOV77yI5a6D5bCx5piv6YCa55So6YCD55Sf5Y+j77yJ77yM6ICM5LiN5piv5Yqg5paw5pa55rOV44CCXG4gKlxuICogfCDmlrnms5UgfCDop5LoibIgfFxuICogfC0tLXwtLS18XG4gKiB8IGBleGVjdXRlX2NvZGVgIHwg6YCa55So6YCD55Sf5Y+j44CC5YaZ5Luj56CB77yM5LiA5qyh5omn6KGM6YeM5a6M5oiQ44CM5Y+W5pWw5o2uIOKGkiDmlLnnirbmgIEg4oaSIOi/lOWbnue7k+iuuuOAjSB8XG4gKiB8IGBkZXNjcmliZV9hcGlgIHwgKirmuJDov5vlvI/miqvpnLIqKiDigJTigJQg5Yir54yc5byV5pOOL+e8lui+keWZqCBBUEnvvIzmjInpnIDmn6XkuIDkuKrlkb3lkI3nqbrpl7TmiJbkuIDkuKrnsbsgfFxuICogfCBgZWRpdG9yX3N0YXRlYCB8IOaMiemcgOiHquajgO+8muaIkeWcqOWTquS4quW3peeoiy/lnLrmma/jgIHpgInkuK3kuobku4DkuYjjgIHmspnnrrHog73kuI3og73liqggfFxuICogfCBgY2FwdHVyZV92aWV3YCB8ICoq5ZSv5LiA5L6L5aSWKirvvJrmiorlnLrmma/op4blm77lrZjmiJDlm77niYfmlofku7bjgIHlm57ot6/lvoTjgILlg4/ntKDloZ7kuI3ov5vov5Tlm57lgLzkuIrpmZDvvIzlj6rog73ljZXni6zlvIDkuIDmnaHpgJrpgZMgfFxuICpcbiAqICMjIGRlc2NyaWJlX2FwaSDnmoTkuKTkvqfotbDkuobkuKTmnaHkuI3lkIznmoTot69cbiAqXG4gKiAtICoqZWRpdG9yIOS+pyoq77ya57yW6L6R5Zmo5Li76L+b56iL55qE5Y+N5bCE5rKh5pyJ5a+55aSW5raI5oGv77yM5omA5Lul6L+Z6YeM6Ieq5bex5a6e546w77yI57qv5Y+N5bCE77yM57qmIDkwIOihjO+8ie+8jFxuICogICDkvYYgYGhlbHBlcnNgIOS4gOahoyoq5Zue5rKZ566x6ZeuKiogYGhlbHBlck5hbWVzKClgIOKAlOKAlCDliqnmiYvmuIXljZXmmK/mspnnrrHoh6rlt7HnmoTkuovlrp7vvIxcbiAqICAg5oqE5LiA5Lu95b+F54S26L+H5pyf44CCXG4gKiAtICoqc2NlbmUg5L6nKirvvJrovazlj5Hnu5nmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvIhgZGVzY3JpYmVBcGlg77yJ44CC57G755qE5bGe5oCn5ZCN6KaB5LuOIGBfX3Byb3BzX19gICtcbiAqICAg5a6e5pe25a6e5L6L5LiK6K+777yM6YKj6YOo5YiG5pivIGBzY2VuZS50c2Ag6YeM5pyA5LiN6K+l6YeN5YaZ55qE5Luj56CB44CCXG4gKlxuICog4pqgIGBleGVjdXRlLXNjZW5lLXNjcmlwdGAgKirpnIDopoHlnLrmma/ov5vnqIvph4zlt7Lnu4/liqDovb3kuobmnKzmianlsZXohJrmnKwqKu+8iOimgeacieWcuuaZr+aJk+W8gO+8ieOAglxuICog5rKh5Yqg6L295pe25oqb6ZSZIOKAlOKAlCDmiYDku6XpgqPkuIDmoaPlv4XpobvmiorlpLHotKXnv7vor5HmiJDjgIzlhYjmiZPlvIDkuIDkuKrlnLrmma/jgI3jgIJcbiAqL1xuXG5pbXBvcnQgeyBFWFRFTlNJT05fTkFNRSwgdHlwZSBUb29sUmVwbHkgfSBmcm9tICcuL2NvbnN0YW50cyc7XG5pbXBvcnQgeyBjYXB0dXJlVmlldywgZGVzY3JpYmVTY2VuZUFwaSwgZXhlY3V0ZUNvZGUsIHBpbmdTY2VuZVNjcmlwdCBhcyBwaW5nU2NlbmUgfSBmcm9tICcuL2NvcmUvZW5naW5lJztcblxuZXhwb3J0IHR5cGUgeyBUb29sUmVwbHkgfTtcblxuLyoqIOaKiuS7u+aEj+W8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8qKlxuICog5Yml5o6J5rKZ566x57uT5p6c5aSW6Z2i6YKj5bGC5L+h5bCB44CCXG4gKlxuICogYHN0cnVjdHVyZWRgL2BkYXRhYCDnmoTlvaLnirbmmK8gYHsgb2ssIGNvbnRleHQsIGR1cmF0aW9uTXMsIHJlc3VsdCB9YO+8iGByZXN1bHRgIOaJjeaYryBgcmV0dXJuYCDnmoTlgLzvvInvvIxcbiAqIOS9humUmeivr+WIhuaUr+mHjOayoeaciSBgcmVzdWx0YOOAgeWPquaciSBgZXJyb3Jg44CC5omA5Lul6L+Z6YeM5YGa44CM5pyJIHJlc3VsdCDlsLHlj5YgcmVzdWx044CN55qE5a656ZSZ6Kej5YyF77yMXG4gKiDorqnosIPnlKjmlrnmi7/liLDnmoTmsLjov5zmmK8qKuaymeeusemHjCByZXR1cm4g55qE6YKj5Liq5Lic6KW/KirjgIJcbiAqXG4gKiBAcGFyYW0gc3RydWN0dXJlZCAtIOaymeeuseWbnuaJp+eahCBgZGF0YWAg5a2X5q6144CCXG4gKiBAcmV0dXJucyDmspnnrrHov5Tlm57lgLzvvJvml6Dms5XliKTlrprml7bljp/moLfov5Tlm57jgIJcbiAqL1xuZnVuY3Rpb24gdW53cmFwU2FuZGJveFJlc3VsdChzdHJ1Y3R1cmVkOiB1bmtub3duKTogdW5rbm93biB7XG4gICAgaWYgKCFzdHJ1Y3R1cmVkIHx8IHR5cGVvZiBzdHJ1Y3R1cmVkICE9PSAnb2JqZWN0JykgcmV0dXJuIHN0cnVjdHVyZWQ7XG4gICAgY29uc3QgZW52ZWxvcGUgPSBzdHJ1Y3R1cmVkIGFzIHsgcmVzdWx0PzogdW5rbm93biB9O1xuICAgIHJldHVybiAncmVzdWx0JyBpbiBlbnZlbG9wZSA/IGVudmVsb3BlLnJlc3VsdCA6IHN0cnVjdHVyZWQ7XG59XG5cbi8qKiDlnLrmma/ohJrmnKzmsqHliqDovb3ml7bnmoTnu5/kuIDmlofmoYjvvIjlpJrmlbDmg4XlhrXmmK/jgIzmsqHmnInmiZPlvIDlnLrmma/jgI3vvInjgIIgKi9cbmNvbnN0IFNDRU5FX1NDUklQVF9ISU5UID1cbiAgICAn6YCa5bi45pivKirlvZPliY3msqHmnInmiZPlvIDlnLrmma8qKu+8iOWcuuaZr+i/m+eoi+WPquWcqOacieWcuuaZr+aJk+W8gOaXtuaJjeWKoOi9veaJqeWxleiEmuacrO+8ieOAgicgK1xuICAgICfor7flnKggQ29jb3MgQ3JlYXRvciDph4zmiZPlvIDku7vmhI/lnLrmma/lkI7ph43or5XvvJvoi6XliJrlkK/nlKjmnKzmianlsZXvvIzph43lkK/kuIDmrKHnvJbovpHlmajmm7TnqLPjgIInO1xuXG4vKipcbiAqIOWcqOe8lui+keWZqOmHjOaJp+ihjOS4gOauteS7o+egge+8iGVkaXRvciDotbAgdm0g5rKZ566x77yMc2NlbmUg6LWw5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yJ44CCXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIGB7Y29udGV4dCwgY29kZSwgYXJncywgdGltZW91dE1zLCBzbmFwc2hvdH1g44CCXG4gKiBAcmV0dXJucyDlt6Xlhbflm57miafvvJvlpLHotKXkuZ/ov5Tlm54gYG9rOmZhbHNlYCDogIzkuI3mmK/mipvvvIjorqnmqKHlnovnnIvliLDlj6/or7vnmoTljp/lm6DvvInjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkV4ZWN1dGVDb2RlKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIHJldHVybiBleGVjdXRlQ29kZShwYXJhbXMpO1xufVxuXG4vKipcbiAqIOaIquS4gOW8oCoq5Zy65pmv6KeG5Zu+KirlubblrZjmiJDlm77niYfmlofku7bvvIjlrp7njrDlnKggYGNvcmUvZW5naW5lLnRzYCArIGBzb3VyY2Uvc2NlbmUudHNg77yJ44CCXG4gKlxuICog5Li65LuA5LmI5Y2V54us5LiA5Liq5pa55rOV77ya5Zu+54mH5piv5LqM6L+b5Yi2L+Wkp+Wtl+espuS4su+8jOWhnuS4jei/myBgZXhlY3V0ZV9jb2RlYCDnmoTov5Tlm57lgLzkuIrpmZBcbiAqIO+8iOWNleWtl+espuS4siA0MDAwIOWtl++8ieKAlOKAlCDmiYDku6XlroPlv4XpobvmmK/jgIzlt6Xlhbcg4oaSIOiQveebmCDihpIg5Zue6Lev5b6E44CN6L+Z5LiA5p2h54us56uL6YCa6YGT44CCXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIGB7c2F2ZVBhdGg/LCBtYXhXaWR0aD8sIGZvcm1hdD8sIHF1YWxpdHk/LCB3YWl0TXM/LCB0aW1lb3V0TXM/fWDjgIJcbiAqIEByZXR1cm5zIGBkYXRhLnBhdGhgIOaYr+WbvueJh+e7neWvuei3r+W+hO+8jOWPr+ebtOaOpeWWgue7meWbvueJh+ivu+WPluW3peWFt+OAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuQ2FwdHVyZVZpZXcocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgcmV0dXJuIGNhcHR1cmVWaWV3KHBhcmFtcyk7XG59XG5cbi8qKlxuICog5p+l5LiA5LiqIEFQSSDlrprkuYkg4oCU4oCUICoq5riQ6L+b5byP5oqr6ZyyKirvvIzkuZ/mmK/jgIzliKvnjJzlvJXmk44gQVBJ44CN6L+Z5p2h6KeE55+p55qE5omn6KGM6ICF44CCXG4gKlxuICog5Li65LuA5LmI5YC85b6X5Y2V54us5LiA5Liq5bel5YW377ya5qih5Z6L5YaZ57yW6L6R5Zmo5Luj56CB5pe25pyA54ix556O54yc5bGe5oCn5ZCN77yIYGNvbXAuZm92YCDov5jmmK9cbiAqIGBjb21wLmZvdkF4aXNg77yJ77yM54yc6ZSZ5LiA5qyh55qE5Luj5Lu35piv5LiA5pW06L2u5b6A6L+U44CC6L+Z6YeM57uZ55qE5pivKirov5DooYzml7blj43lsIQqKueahOe7k+aenO+8jFxuICog5rC46L+c5q+U5Lu75L2V57yT5a2YL+aWh+aho+aWsO+8m3NjZW5lIOS+p+W4piBgbm9kZVV1aWRgIOaXtui/mOiDveihpeWHuioq5b2T5YmN5YC8KirjgIJcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtjb250ZXh0LCB0YXJnZXQsIG5vZGVVdWlkLCBsaW1pdH1g44CCXG4gKiBAcmV0dXJucyDlt6Xlhbflm57miafvvJtgdGV4dGAg5piv57uZ5qih5Z6L55yL55qEIEpTT07jgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlc2NyaWJlQXBpKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIGNvbnN0IGNvbnRleHQgPSBwYXJhbXMuY29udGV4dCA9PT0gJ3NjZW5lJyA/ICdzY2VuZScgOiAnZWRpdG9yJztcbiAgICBjb25zdCB0YXJnZXQgPSB0eXBlb2YgcGFyYW1zLnRhcmdldCA9PT0gJ3N0cmluZycgPyBwYXJhbXMudGFyZ2V0LnRyaW0oKSA6ICcnO1xuICAgIGNvbnN0IG5vZGVVdWlkID0gdHlwZW9mIHBhcmFtcy5ub2RlVXVpZCA9PT0gJ3N0cmluZycgPyBwYXJhbXMubm9kZVV1aWQgOiAnJztcbiAgICBjb25zdCBsaW1pdCA9IGNsYW1wTGltaXQocGFyYW1zLmxpbWl0KTtcblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPVxuICAgICAgICAgICAgY29udGV4dCA9PT0gJ2VkaXRvcidcbiAgICAgICAgICAgICAgICA/IGF3YWl0IGRlc2NyaWJlRWRpdG9yQXBpKHRhcmdldCwgbGltaXQpXG4gICAgICAgICAgICAgICAgOiBhd2FpdCBkZXNjcmliZVNjZW5lQXBpKHRhcmdldCwgbm9kZVV1aWQsIGxpbWl0KTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHBheWxvYWQub2sgIT09IGZhbHNlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZGF0YTogcGF5bG9hZCB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICB0ZXh0OiBg5p+l6K+iIEFQSSDlrprkuYnlpLHotKXvvIgke2NvbnRleHR9IC8gJHt0YXJnZXQgfHwgJyjmgLvop4gpJ33vvInvvJoke2Rlc2NyaWJlKGVycm9yKX1cXG4ke1NDRU5FX1NDUklQVF9ISU5UfWAsXG4gICAgICAgIH07XG4gICAgfVxufVxuXG4vKiog5YiX6KGo57G75Y+C5pWw57uf5LiA5aS55YiwIDF+NTAw77yI6buY6K6kIDgw77yJ44CCICovXG5mdW5jdGlvbiBjbGFtcExpbWl0KHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHtcbiAgICBjb25zdCByYXcgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnRydW5jKHZhbHVlKSA6IDgwO1xuICAgIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbig1MDAsIHJhdykpO1xufVxuXG4vKipcbiAqIOW4uOeUqOiwg+eUqOmAn+afpSDigJTigJQg5pS+5oC76KeI6YeM77yM6K6p5qih5Z6L5bCR6LWw5Yeg6L2u6K+V6ZSZ44CCXG4gKlxuICog6L+Z5Yeg5p2h5pivKirnuq/mlofmnKznn6Xor4YqKu+8iOS4jeaYr+iDveWPjeWwhOWHuuadpeeahOS4nOilv++8ie+8jOaJgOS7peWGmeaIkOW4uOmHj+aYr+WPr+S7peaOpeWPl+eahO+8m1xuICog6YC76L6R5Yir5oqE77yI6KeBIGBkZXNjcmliZUVkaXRvckFwaWAg6YeMIGBoZWxwZXJzYCDpgqPkuIDmoaPnmoTlpITnkIbmlrnlvI/vvInjgIJcbiAqL1xuY29uc3QgRURJVE9SX0NIRUFUU0hFRVQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAg6LWE5rqQ5p+l6K+iOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogJ2RiOi8vYXNzZXRzLyoqLyoucHJlZmFiJyB9KVwiLFxuICAgIOi1hOa6kOivpuaDhTogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdxdWVyeS1hc3NldC1pbmZvJywgdXJsT3JVdWlkKVwiLFxuICAgIOWIt+aWsOi1hOa6kDogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWZyZXNoLWFzc2V0JywgJ2RiOi8vYXNzZXRzJylcIixcbiAgICDkv53lrZjlnLrmma86IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpXCIsXG4gICAg5omT5byA5Zy65pmvOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ29wZW4tc2NlbmUnLCBzY2VuZUFzc2V0VXVpZClcIixcbiAgICDpgInkuK3otYTmupA6IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnc2V0LWFzc2V0LXV1aWQtc2VsZWN0aW9uJywgdXVpZClcIixcbiAgICDor7vorr7nva46IFwiYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0Q29uZmlnKCc85omp5bGV5ZCNPicsICdrZXknLCAnbG9jYWwnKVwiLFxuICAgIOW3peeoi+i3r+W+hDogJ0VkaXRvci5Qcm9qZWN0LnBhdGgnLFxuICAgIOe8lui+keWZqOeJiOacrDogJ0VkaXRvci5BcHAudmVyc2lvbicsXG4gICAg5o6n5Yi25Y+w5pel5b+XOiAnRWRpdG9yLkxvZ2dlci5xdWVyeSgpJyxcbn07XG5cbi8qKlxuICog57yW6L6R5Zmo5Li76L+b56iL5L6n55qE5Y+N5bCE77yIYGNvcmUvZW5naW5lLnRzYCDph4zmsqHmnInlr7nlupTnmoTlr7nlpJbmtojmga/vvIzmiYDku6Xov5nph4zoh6rlt7Hlrp7njrDvvInjgIJcbiAqXG4gKiDlm5vmoaPvvJrmgLvop4ggLyBgaGVscGVyc2AgLyBgbW9kdWxlOnh4eGAgLyBgRWRpdG9yLlh4eC5ZeXlg44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlc2NyaWJlRWRpdG9yQXBpKHRhcmdldDogc3RyaW5nLCBsaW1pdDogbnVtYmVyKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IGVkaXRvckFueSA9IEVkaXRvciBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgY29uc3QgbmFtZXNwYWNlczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1ldGhvZENvdW50OiBudW1iZXI7IHNhbXBsZTogc3RyaW5nW10gfT4gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoZWRpdG9yQW55KS5zb3J0KCkpIHtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZWRpdG9yQW55W2tleV07XG4gICAgICAgICAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICAgICAgbGV0IG1ldGhvZE5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBtZXRob2ROYW1lcyA9IE9iamVjdC5rZXlzKHZhbHVlIGFzIG9iamVjdCkuZmlsdGVyKFxuICAgICAgICAgICAgICAgICAgICAoaykgPT4gdHlwZW9mICh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba10gPT09ICdmdW5jdGlvbicsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIG1ldGhvZE5hbWVzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBuYW1lc3BhY2VzLnB1c2goeyBuYW1lOiBrZXksIG1ldGhvZENvdW50OiBtZXRob2ROYW1lcy5sZW5ndGgsIHNhbXBsZTogbWV0aG9kTmFtZXMuc2xpY2UoMCwgOCkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAga2luZDogJ2luZGV4JyxcbiAgICAgICAgICAgIGNvbnRleHQ6ICdlZGl0b3InLFxuICAgICAgICAgICAgbmFtZXNwYWNlcyxcbiAgICAgICAgICAgIGNoZWF0c2hlZXQ6IEVESVRPUl9DSEVBVFNIRUVULFxuICAgICAgICAgICAgaGludDpcbiAgICAgICAgICAgICAgICBcIueUqCBjb2Nvc19kZXNjcmliZV9hcGkoe2NvbnRleHQ6J2VkaXRvcicsIHRhcmdldDonRWRpdG9yLk1lc3NhZ2UnfSkg55yL5p+Q5Liq5ZG95ZCN56m66Ze055qE5pa55rOV5YWo6KGo77ybXCIgK1xuICAgICAgICAgICAgICAgIFwidGFyZ2V0OidoZWxwZXJzJyDnnIvmspnnrrHliqnmiYvvvJt0YXJnZXQ6J21vZHVsZTpmcycg55yL5p+Q5LiqIG5vZGUg5qih5Z2X55qE5a+85Ye644CCXCIsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog4pqgICoq5Yir5oqE5Yqp5omL5riF5Y2VKirvvJrlroPnlLHmspnnrrHms6jlhaXvvIhgY29yZS9lbmdpbmUudHNgIOeahCBgYnVpbGRFZGl0b3JIZWxwZXJzYCArIHJlY2lwZSDkupTku7blpZfvvInvvIxcbiAgICAgKiDmioTkuIDku73nmoTkuIvlnLrmmK/jgIzmn6XliLDnmoTlh73mlbDlnKjmspnnrrHph4zkuI3lrZjlnKjjgI3jgILmiYDku6Xov5nkuIDmoaMqKuWbnuaymeeusemXrioq44CCXG4gICAgICovXG4gICAgaWYgKHRhcmdldCA9PT0gJ2hlbHBlcnMnKSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgcnVuRXhlY3V0ZUNvZGUoeyBjb250ZXh0OiAnZWRpdG9yJywgdGltZW91dE1zOiA4MDAwLCBjb2RlOiAncmV0dXJuIGhlbHBlck5hbWVzKCk7JyB9KTtcbiAgICAgICAgY29uc3QgbmFtZXMgPSB1bndyYXBTYW5kYm94UmVzdWx0KHJlcGx5LmRhdGEpO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkobmFtZXMpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGtpbmQ6ICdoZWxwZXJzJywgY29udGV4dDogJ2VkaXRvcicsIGVycm9yOiByZXBseS50ZXh0LnNsaWNlKDAsIDgwMCkgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwga2luZDogJ2hlbHBlcnMnLCBjb250ZXh0OiAnZWRpdG9yJywgaGVscGVyczogbmFtZXMgfTtcbiAgICB9XG5cbiAgICBpZiAodGFyZ2V0LnN0YXJ0c1dpdGgoJ21vZHVsZTonKSkge1xuICAgICAgICBjb25zdCBtb2R1bGVOYW1lID0gdGFyZ2V0LnNsaWNlKCdtb2R1bGU6Jy5sZW5ndGgpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFtb2R1bGVOYW1lKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnbW9kdWxlOiDlkI7pnaLopoHot5/mqKHlnZflkI3vvIzlpoIgbW9kdWxlOmZzJyB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbG9hZGVkID0gcmVxdWlyZShtb2R1bGVOYW1lKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhsb2FkZWQgfHwge30pLnNvcnQoKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICAgICAga2luZDogJ21vZHVsZScsXG4gICAgICAgICAgICAgICAgbW9kdWxlOiBtb2R1bGVOYW1lLFxuICAgICAgICAgICAgICAgIGV4cG9ydENvdW50OiBrZXlzLmxlbmd0aCxcbiAgICAgICAgICAgICAgICBleHBvcnRzOiBrZXlzLnNsaWNlKDAsIGxpbWl0KSxcbiAgICAgICAgICAgICAgICBoaW50OiBg5ZyoIGNvY29zX2V4ZWN1dGVfY29kZSDph4znm7TmjqUgXFxgcmV0dXJuIHJlcXVpcmUoJyR7bW9kdWxlTmFtZX0nKVxcYCDlj6/ku6Xmi7/liLDnnJ/lrp7lr7nosaHjgIJgLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGByZXF1aXJlKCcke21vZHVsZU5hbWV9Jykg5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8g5oyJ54K55YiG6Lev5b6E5ZyoIEVkaXRvciDkuIrotbDvvIhgRWRpdG9yLk1lc3NhZ2VgIOS4jiBgTWVzc2FnZWAg5Lik56eN5YaZ5rOV6YO96K6k77yJXG4gICAgY29uc3QgcGFydHMgPSB0YXJnZXQucmVwbGFjZSgvXkVkaXRvclxcLj8vLCAnJykuc3BsaXQoJy4nKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgbGV0IG5vZGU6IHVua25vd24gPSBFZGl0b3I7XG4gICAgZm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG4gICAgICAgIGlmIChub2RlID09PSBudWxsIHx8IG5vZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsCAke3RhcmdldH3vvIjlnKggJHtwYXJ0fSDlpITmlq3pk77vvIlgIH07XG4gICAgICAgIG5vZGUgPSAobm9kZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbcGFydF07XG4gICAgfVxuICAgIGlmIChub2RlID09PSBudWxsIHx8IG5vZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsCAke3RhcmdldH1gIH07XG4gICAgaWYgKHR5cGVvZiBub2RlICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwga2luZDogJ3ZhbHVlJywgdGFyZ2V0LCB2YWx1ZTogU3RyaW5nKG5vZGUpIH07XG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCB2YWx1ZXM6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZSBhcyBvYmplY3QpLnNvcnQoKSkge1xuICAgICAgICBsZXQgZW50cnk6IHVua25vd247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBlbnRyeSA9IChub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgZW50cnkgPT09ICdmdW5jdGlvbicpIG1ldGhvZHMucHVzaChrZXkpO1xuICAgICAgICBlbHNlIHZhbHVlcy5wdXNoKGtleSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGtpbmQ6ICduYW1lc3BhY2UnLFxuICAgICAgICB0YXJnZXQ6IGBFZGl0b3IuJHtwYXJ0cy5qb2luKCcuJyl9YCxcbiAgICAgICAgbWV0aG9kczogbWV0aG9kcy5zbGljZSgwLCBsaW1pdCksXG4gICAgICAgIG1ldGhvZENvdW50OiBtZXRob2RzLmxlbmd0aCxcbiAgICAgICAgdmFsdWVzOiB2YWx1ZXMuc2xpY2UoMCwgTWF0aC5taW4oMzAsIGxpbWl0KSksXG4gICAgICAgIGhpbnQ6IGDosIPnlKjlvaLlpoIgXFxgYXdhaXQgJHt0YXJnZXR9Lnh4eCguLi4pXFxg77yb5Y+C5pWw6aG65bqP6KeB57yW6L6R5Zmo5a6Y5pa55paH5qGj77yM5oiW55u05o6l6K+V6LCD55yL5oql6ZSZ44CCYCxcbiAgICB9O1xufVxuXG4vKlxuICog5Zy65pmv5L6n55qE5Y+N5bCE77yIYGRlc2NyaWJlU2NlbmVBcGlg77yJ5LiO5o6i5rS777yIYHBpbmdTY2VuZVNjcmlwdGDvvInpg73lnKggYGNvcmUvZW5naW5lLnRzYCDph4wg4oCU4oCUXG4gKiDlroPku6zlj6rmmK8gYGV4ZWN1dGUtc2NlbmUtc2NyaXB0YCDnmoTkuIDlsYLoloTlsIHoo4XvvIzmsqHlv4XopoHlnKjov5nph4zlho3mioTkuIDku73jgIJcbiAqL1xuXG4vKipcbiAqIOeci+S4gOecvOe8lui+keWZqOeOsOWcqOaYr+S7gOS5iOeKtuaAgeOAglxuICpcbiAqIOS4ieWdl+S/oeaBr+adpeiHquS4jeWQjOi/m+eoi++8mlxuICogLSAqKuW3peeoiy/niYjmnKwqKu+8muS4u+i/m+eoi+eahCBgRWRpdG9yLlByb2plY3RgIC8gYEVkaXRvci5BcHBg77ybXG4gKiAtICoq6YCJ5LitKirvvJrkuLvov5vnqIvpl64gYHNjZW5lYCDljIXnmoQgYHF1ZXJ5LW5vZGUtdHJlZWDvvJtcbiAqIC0gKirlnLrmma8qKu+8muWAn+acrOaJqeWxleeahOWcuuaZr+aymeeusei3keS4gOWwj+aute+8iGBkaXJlY3Rvci5nZXRTY2VuZSgpYO+8ieOAglxuICpcbiAqIOWGjeWKoOS4gOWdlyoq6IO95Yqb5o6i5rS7KirvvIjlvojlgLzpkrHnmoTpgqPpg6jliIbvvInvvJrlnLrmma/ohJrmnKzliqDovb3kuobmsqHmnIkg4oCU4oCUXG4gKiDmqKHlnovmja7mraTmj5DliY3nn6XpgZPjgIzmjqXkuIvmnaXog73kuI3og73liqjlnLrmma/jgI3vvIzogIzkuI3mmK/lhpnkuobkuIDlsY/ku6PnoIHmiY3lj5HnjrDmsqHmiZPlvIDlnLrmma/jgIJcbiAqXG4gKiDku7vkvZXkuIDlnZfmi7/kuI3liLDpg70qKuS4jemYu+aWrSoq5pW05L2T4oCU4oCU6L+U5Zue5bey5pyJ55qE6YOo5YiGICsg5LiA5p2hIGDigKbor7vlj5blpLHotKXvvJrljp/lm6Bg77yM5q+U5pW05Liq5bel5YW35aSx6LSl5pyJ55So44CCXG4gKlxuICogQHBhcmFtIF9wYXJhbXMgLSBge3ZlcmJvc2U/fWDvvIjlvZPliY0gdmVyYm9zZSDlj6rlvbHlk43mmK/lkKbpmYTkuIrov5DooYzml7bor4rmlq3vvInjgIJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp+OAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZEVkaXRvclN0YXRlKF9wYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgIGNvbnN0IHByb2JsZW1zOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgZGF0YS5wcm9qZWN0UGF0aCA9IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGxpbmVzLnB1c2goYOW3peeoi++8miR7RWRpdG9yLlByb2plY3QucGF0aH1gKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBwcm9ibGVtcy5wdXNoKGDlt6XnqIvot6/lvoTor7vlj5blpLHotKXvvJoke2Rlc2NyaWJlKGVycm9yKX1gKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBkYXRhLmVkaXRvclZlcnNpb24gPSBFZGl0b3IuQXBwLnZlcnNpb247XG4gICAgICAgIGRhdGEuZWRpdG9yTmFtZSA9IEVkaXRvci5BcHAubmFtZTtcbiAgICAgICAgbGluZXMucHVzaChg57yW6L6R5Zmo77yaJHtFZGl0b3IuQXBwLm5hbWV9ICR7RWRpdG9yLkFwcC52ZXJzaW9ufWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHByb2JsZW1zLnB1c2goYOe8lui+keWZqOeJiOacrOivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gKGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LW5vZGUtdHJlZScpKSBhc1xuICAgICAgICAgICAgfCB7IHV1aWQ/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfVxuICAgICAgICAgICAgfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChzZWxlY3RlZCAmJiB0eXBlb2Ygc2VsZWN0ZWQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICBkYXRhLnNlbGVjdGlvbiA9IHsgdXVpZDogc2VsZWN0ZWQudXVpZCA/PyBudWxsLCBuYW1lOiBzZWxlY3RlZC5uYW1lID8/IG51bGwgfTtcbiAgICAgICAgICAgIGxpbmVzLnB1c2goYOmAieS4re+8miR7c2VsZWN0ZWQubmFtZSA/PyAnKOaXoOWQjSknfSR7c2VsZWN0ZWQudXVpZCA/IGAgWyR7c2VsZWN0ZWQudXVpZH1dYCA6ICcnfWApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGF0YS5zZWxlY3Rpb24gPSBudWxsO1xuICAgICAgICAgICAgbGluZXMucHVzaCgn6YCJ5Lit77ya5pegJyk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkYXRhLnNlbGVjdGlvbiA9IG51bGw7XG4gICAgICAgIHByb2JsZW1zLnB1c2goYOmAieS4reS/oeaBr+ivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgIH1cblxuICAgIC8vIOWcuuaZr+S/oeaBr+imgeWAn+WcuuaZr+i/m+eoi++8iOS4u+i/m+eoi+aLv+S4jeWIsOa0u+eahOWcuuaZr+agke+8iVxuICAgIGNvbnN0IHNjZW5lUHJvYmUgPSBhd2FpdCBydW5FeGVjdXRlQ29kZSh7XG4gICAgICAgIGNvbnRleHQ6ICdzY2VuZScsXG4gICAgICAgIHRpbWVvdXRNczogODAwMCxcbiAgICAgICAgY29kZTpcbiAgICAgICAgICAgICdjb25zdCBzID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTsnICtcbiAgICAgICAgICAgICcgbGV0IG4gPSAwOycgK1xuICAgICAgICAgICAgJyBlYWNoTm9kZSgoKSA9PiB7IG4gKz0gMTsgfSk7JyArXG4gICAgICAgICAgICAnIHJldHVybiB7IGhhc1NjZW5lOiAhIXMsIG5hbWU6IHMgPyBzLm5hbWUgOiBudWxsLCB1dWlkOiBzID8gcy51dWlkIDogbnVsbCwgbm9kZUNvdW50OiBuIH07JyxcbiAgICB9KTtcbiAgICAvKipcbiAgICAgKiDimqAgKirouKnov4fnmoTlnZEqKu+8muaymeeuseWbnuaJp+aYr+Wll+S6huS4gOWxgueahFxuICAgICAqIGB7IG9rLCBjb250ZXh0LCBkdXJhdGlvbk1zLCByZXN1bHQgfWAg4oCU4oCUIOaymeeuseeahOi/lOWbnuWAvOWcqCBgLnJlc3VsdGAg6YeM44CCXG4gICAgICog56ys5LiA54mI55u05o6l5b2TIGB7aGFzU2NlbmV9YCDor7vvvIzkuo7mmK8gYGhhc1NjZW5lYCDmgZLkuLogdW5kZWZpbmVkIOKGkiDnlYzpnaLmsLjov5zmmL7npLpcbiAgICAgKiDjgIzlnLrmma/vvJrmnKrmiZPlvIDjgI3vvIjogIzlnLrmma/lhbblrp7lvIDnnYDjgIE1NDYg5Liq6IqC54K577yJ44CC5bel5YW35pys6Lqr5rKh5oql6ZSZ77yM5omA5Lul54m55Yir6Zq+5Y+R546w44CCXG4gICAgICovXG4gICAgY29uc3QgcHJvYmUgPSB1bndyYXBTYW5kYm94UmVzdWx0KHNjZW5lUHJvYmUuZGF0YSkgYXNcbiAgICAgICAgfCB7IGhhc1NjZW5lPzogYm9vbGVhbjsgbmFtZT86IHN0cmluZzsgdXVpZD86IHN0cmluZzsgbm9kZUNvdW50PzogbnVtYmVyIH1cbiAgICAgICAgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHNjZW5lUHJvYmUub2sgJiYgcHJvYmUpIHtcbiAgICAgICAgZGF0YS5zY2VuZSA9IHByb2JlO1xuICAgICAgICBsaW5lcy5wdXNoKFxuICAgICAgICAgICAgcHJvYmUuaGFzU2NlbmVcbiAgICAgICAgICAgICAgICA/IGDlnLrmma/vvJoke3Byb2JlLm5hbWUgPz8gJyjmnKrlkb3lkI0pJ30gWyR7cHJvYmUudXVpZCA/PyAnLSd9Xe+8jOiKgueCuSAke3Byb2JlLm5vZGVDb3VudCA/PyAnPyd9IOS4qmBcbiAgICAgICAgICAgICAgICA6ICflnLrmma/vvJrmnKrmiZPlvIAnLFxuICAgICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHByb2JsZW1zLnB1c2goYOWcuuaZr+S/oeaBr+ivu+WPluWksei0pe+8miR7c2NlbmVQcm9iZS50ZXh0LnNsaWNlKDAsIDIwMCl9YCk7XG4gICAgfVxuXG4gICAgLy8g6IO95Yqb5o6i5rS777ya5Zy65pmv6ISa5pys5Zyo5LiN5ZyoIOKAlOKAlCDlroPlhrPlrprjgIzmjqXkuIvmnaXog73kuI3og73mlLnlnLrmma/jgI1cbiAgICBjb25zdCBzY2VuZVNjcmlwdCA9IGF3YWl0IHBpbmdTY2VuZSgpO1xuICAgIGRhdGEuY2FwYWJpbGl0aWVzID0geyBzYW5kYm94OiBFWFRFTlNJT05fTkFNRSwgc2NlbmVTY3JpcHQgfTtcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgICBzY2VuZVNjcmlwdC5hdmFpbGFibGVcbiAgICAgICAgICAgID8gYOiDveWKm++8muS7o+eggeaymeeuseWPr+eUqO+8iOacrOaJqeWxleeahOWcuuaZr+iEmuacrOW3suWKoOi9ve+8jOiDveaUueWcuuaZr++8iWBcbiAgICAgICAgICAgIDogYOiDveWKm++8muWPquivu+W+l+WKqOe8lui+keWZqCDigJTigJQg5Zy65pmv5L6n5LiN5Y+v55So77yaJHtzY2VuZVNjcmlwdC5yZWFzb24gPz8gJ+WcuuaZr+iEmuacrOS4jeWPr+eUqCd944CCJHtTQ0VORV9TQ1JJUFRfSElOVH1gLFxuICAgICk7XG5cbiAgICBpZiAocHJvYmxlbXMubGVuZ3RoID4gMCkgbGluZXMucHVzaCgnJywgJ+KaoCDpg6jliIbkv6Hmga/msqHmi7/liLDvvJonLCAuLi5wcm9ibGVtcy5tYXAoKGxpbmUpID0+IGAtICR7bGluZX1gKSk7XG5cbiAgICAvLyDkuIvkuIDmraXor6XnlKjku4DkuYjlt6XlhbfvvJrov5nlh6DmnaHmmK8qKuWUr+S4gOS4gOWkhOaooeWei+S4gOWumuS8mueci+WIsCoq55qE55So5rOV5o+Q56S677yIRFNIIOS4jea2iOi0uSBNQ1Ag55qEIGluc3RydWN0aW9uc++8iVxuICAgIGxpbmVzLnB1c2goXG4gICAgICAgICcnLFxuICAgICAgICAn5LiL5LiA5q2l77yaJyxcbiAgICAgICAgLy8g4pqgIOesrOS4gOadoeWwseaYryByZWNpcGXvvJrlrp7mtYvkuIDmlbTlpJzph4wgYGZpbmRSZWNpcGVzYCDooqvosIPnlKggMCDmrKHvvIzogIzllK/kuIDlrZjkuIvnmoTpgqPmnaEgcmVjaXBlXG4gICAgICAgIC8vICAg5Y+I5Zug55uu5b2V5pS55ZCN5oiQ5LqG5a2k5YS/IOKAlOKAlCDmj5DnpLrkvY3kuI3mkYblnKjov5nph4zvvIzov5nlpZfmnLrliLblsLHmsLjov5zmmK/nqbrnmoTjgIJcbiAgICAgICAgXCItICoq5YWI5om+5Y+v5aSN55So6YWN5pa5KirvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6J2VkaXRvcicsIGNvZGU6XFxcInJldHVybiBmaW5kUmVjaXBlcygpXFxcIn0pIOKAlOKAlCDlgZogVUkv6aKE5Yi25Lu2L+aJuemHj+aUueiKgueCuei/meexu+a0u+S5i+WJjeWFiOeci+acieayoeaciei3kemAmui/h+eahOS7o+eggVwiLFxuICAgICAgICBcIi0g5Zy65pmv5qCR6aqo5p6277yaY29jb3NfZXhlY3V0ZV9jb2RlKHtjb250ZXh0OidzY2VuZScsIGNvZGU6J3JldHVybiB0cmVlKHttYXhEZXB0aDoyLCB3aXRoQ29tcG9uZW50czp0cnVlfSknfSlcIixcbiAgICAgICAgXCItIOe7hOS7tuacieWTquS6m+WxnuaAp++8mmNvY29zX2Rlc2NyaWJlX2FwaSh7Y29udGV4dDonc2NlbmUnLCB0YXJnZXQ6J2NjLkNhbWVyYScsIG5vZGVVdWlkOic85LiK6Z2i5p+l5Yiw55qEIHV1aWQ+J30pXCIsXG4gICAgICAgICctIOe8lui+keWZqCBBUEkg5oC76KeI77yaY29jb3NfZGVzY3JpYmVfYXBpKHtjb250ZXh0OlwiZWRpdG9yXCJ9KScsXG4gICAgICAgIFwiLSDliJfotYTmupDvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvZGU6XFxcInJldHVybiAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCdxdWVyeS1hc3NldHMnLHtwYXR0ZXJuOidkYjovL2Fzc2V0cy8qKi8qLnByZWZhYid9KSkuc2xpY2UoMCwyMCkubWFwKGE9PmEudXJsKVxcXCJ9KVwiLFxuICAgICk7XG5cbiAgICAvKipcbiAgICAgKiDimqAgKipgb2tgIOeahOivreS5ie+8mui/meS4quW3peWFt+OAjOi3keaIkOWKn+S6huayoeacieOAje+8jOS4jeaYr+OAjOavj+S4gOmhuemDveaLv+WIsOS6huayoeacieOAjSoq44CCXG4gICAgICpcbiAgICAgKiDouKnov4fnmoTlnZHvvIjku6Pku7cgNTkg5YiG6ZKf55qE5o6S5p+l5Lya6K+d77yJ77ya5Y6f5p2l5YaZ55qE5pivIGBvazogcHJvYmxlbXMubGVuZ3RoID09PSAwYCDigJTigJQg5LqO5pivXG4gICAgICog44CM5Zub6aG55o6i6ZKI5LiJ6aG55oiQ5Yqf44CB5Y+q5pyJ5Zy65pmv5LiA6aG55aSx6LSl44CN5Lmf5Lya5ZueIGBvazogZmFsc2Vg77yM6ICM5qGl5o6l5L6nXG4gICAgICog77yIYGRzaC1wcm9maWxlL3BsdWdpbi9kc2gtY29jb3MtYnJpZGdlL2luZGV4LmpzYO+8ieingSBgb2s6ZmFsc2VgIOWwsSByZWplY3TvvIxcbiAgICAgKiDmiormlbTmrrXkurror53mlofmoYjlvZPmiJAgYEVycm9yOmAg5oqb5Yiw55So5oi36Z2i5YmN44CC55So5oi355yL5Yiw55qE5piv44CM5LiA5Liq6Ieq5qOA5bel5YW35oql6ZSZ5LqG44CN77yMXG4gICAgICog5LqO5piv5byA5LqG5LiA5p2h5Lya6K+d5Y675p+l44CM5o+S5Lu25piv5LiN5piv5Z2P5LqG44CN4oCU4oCUIOecn+ebuOWPquaYr+mCo+S4quaJqeWxleiiq+emgeeUqOS6huOAglxuICAgICAqXG4gICAgICog546w5Zyo55qE5Y+j5b6E77yaKirlj6ropoHmi7/liLDku7vkvZXkuIDlnZfmnInmlYjkv6Hmga/lsLHnrpfmiJDlip8qKu+8iOW5tumZhCBgZGF0YS5wcm9ibGVtc2Ag5LiOIGBkYXRhLmRlZ3JhZGVkYO+8ie+8jFxuICAgICAqIOWPquacieOAjOS7gOS5iOmDveayoeaLv+WIsOOAjeaJjeeul+Wksei0peOAguS4iumdouazqOmHiumHjOacrOadpeWGmeeahOWwseaYr+OAjOS7u+S9leS4gOWdl+aLv+S4jeWIsOmDveS4jemYu+aWreaVtOS9k+OAje+8jFxuICAgICAqIOS5i+WJjeaYryBgb2tgIOeahOeul+azleS4jui/meWPpeivneiHquebuOefm+ebvuOAglxuICAgICAqL1xuICAgIGNvbnN0IGdvdEFueXRoaW5nID1cbiAgICAgICAgQm9vbGVhbihkYXRhLnByb2plY3RQYXRoKSB8fCBCb29sZWFuKGRhdGEuZWRpdG9yVmVyc2lvbikgfHwgQm9vbGVhbihkYXRhLnNjZW5lKSB8fCBCb29sZWFuKGRhdGEuc2VsZWN0aW9uKTtcblxuICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBnb3RBbnl0aGluZyxcbiAgICAgICAgdGV4dDogbGluZXMuam9pbignXFxuJyksXG4gICAgICAgIGRhdGE6IHsgLi4uZGF0YSwgcHJvYmxlbXMsIGRlZ3JhZGVkOiBwcm9ibGVtcy5sZW5ndGggPiAwIH0sXG4gICAgfTtcbn1cblxuLyoqXG4gKiBJUEMg5pa55rOV5YiG5Y+R6KGo44CCXG4gKlxuICog4pqgIOmUruWQjeW/hemhu+S4jiBEU0gg5L6n5o+S5Lu26YeMIGBpcGNDYWxsKCcuLi4nKWAg55qE5a2X56ym5Liy5LiA6Ie0XG4gKiDvvIjop4EgYGRzaC1wcm9maWxlL3BsdWdpbi9kc2gtY29jb3MtYnJpZGdlL2luZGV4LmpzYO+8ieOAglxuICovXG5leHBvcnQgY29uc3QgQ09DT1NfSVBDX01FVEhPRFM6IFJlY29yZDxzdHJpbmcsIChwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPFRvb2xSZXBseT4+ID0ge1xuICAgIGV4ZWN1dGVfY29kZTogcnVuRXhlY3V0ZUNvZGUsXG4gICAgZGVzY3JpYmVfYXBpOiBkZXNjcmliZUFwaSxcbiAgICBlZGl0b3Jfc3RhdGU6IHJlYWRFZGl0b3JTdGF0ZSxcbiAgICBjYXB0dXJlX3ZpZXc6IHJ1bkNhcHR1cmVWaWV3LFxufTtcbiJdfQ==