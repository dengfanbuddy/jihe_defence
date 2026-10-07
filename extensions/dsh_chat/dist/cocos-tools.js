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
 * ## 五个方法，其中两个是「别猜」的护栏
 *
 * IPC 协议要窄。语义方法越少，DSH 侧插件的参数校验与这里的实现越不容易错位。
 * 需要新能力时优先扩 `execute_code` 的用法（它就是通用逃生口），而不是加新方法。
 *
 * | 方法 | 角色 |
 * |---|---|
 * | `execute_code` | 通用逃生口。写代码，一次执行里完成「取数据 → 改状态 → 返回结论」 |
 * | `describe_api` | **渐进式披露** —— 别猜引擎/编辑器 API，按需查一个命名空间或一个类 |
 * | `editor_state` | 按需自检：我在哪个工程/场景、选中了什么、沙箱能不能动 |
 * | `capture_view` | **例外一**：把场景视图（或某个节点）存成图片文件、回路径。像素塞不进返回值上限，只能单独开一条通道。默认会**先取景再截**（`fit`），因为屏幕上那一帧未必是全景 |
 * | `read_logs` | **例外二**：读工程里的日志文件。控制台/日志文件里的字**代码拿不到**（那是另一个进程的输出），只能单独开一条通道。实现在 `logs.ts` |
 *
 * ## 出口统一补 `refs`
 *
 * 每个方法的回执都会经 `withRefs` 过一道：把结果里出现过的**全形 uuid / `db://` 路径**
 * 去重后排进文案结尾（结构化版本在 `data.refs`）。理由是它直接省掉一轮往返 ——
 * 不然模型要么重查一次，要么凭记忆编一个（`SKILL.md` 里专门写过「别猜 uuid」）。
 * 这一层**只做搬运，不做判断**：不认识"哪个 uuid 更重要"，也从不改写原有文案。
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
const serialize_1 = require("./core/serialize");
const logs_1 = require("./logs");
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
 * 截一张**场景视图**（或其中一个节点）并存成图片文件（实现在 `core/engine.ts` +
 * `source/capture.ts` + `source/scene.ts`）。
 *
 * 为什么单独一个方法：图片是二进制/大字符串，塞不进 `execute_code` 的返回值上限
 * （单字符串 4000 字）—— 所以它必须是「工具 → 落盘 → 回路径」这一条独立通道。
 *
 * 两条通道（回执里的 `method` 会写明是哪条）：**主进程 Electron**（`webContents.capturePage()`
 * 读合成后的画面，空图时 `invalidate()` 逼一次重绘）优先；场景进程读 GL 后备缓冲只作兜底。
 *
 * `fit` 是「用户缩放过之后，屏幕上那一帧未必是全景」的解法：截图前先把相机摆到框住目标的位置、
 * 截完立刻还原（`auto` 只在需要时才动相机；`none` 完全不动）。账本在回执的 `framing` 里。
 *
 * @param params - `{savePath?, node?, padding?, fit?, maxWidth?, format?, quality?, waitMs?, timeoutMs?}`。
 *   `node` 给 uuid 或路径（`Canvas/skill_details`）时只截那一个节点；
 *   `fit` = `auto`（默认）/ `scene` / `node` / `none`（详见 `core/engine.ts` 的 `captureView`）。
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
 * 给回执补一段 `refs`（可复用的标识）—— 每个方法都过这一道。
 *
 * 两条口径：
 *
 * 1. **只在抽到东西时动回执**：一条都没有就原样返回，绝不留下空壳字段。
 * 2. **抽取失败不算失败**：`refs` 是附加信息，它自己抛错绝不能把一次成功的调用变成失败
 *    （所以包在 try 里，静默放过）。
 *
 * 文案追加在 `text` 结尾（模型只读 `text` —— 桥接侧 `OUTPUT.render` 只渲染它）；
 * 结构化版本放 `data.refs`（面板与留档用）。
 *
 * @param handler - 原来的方法实现。
 * @returns 包了一层的方法实现。
 */
function withRefs(handler) {
    return async (params) => {
        var _a;
        const reply = await handler(params);
        try {
            const collection = (0, serialize_1.collectRefs)((_a = reply.data) !== null && _a !== void 0 ? _a : reply.text);
            const block = (0, serialize_1.formatRefs)(collection);
            if (!block)
                return reply;
            const data = reply.data;
            reply.data =
                data && typeof data === 'object' && !Array.isArray(data)
                    ? { ...data, refs: collection.refs }
                    : { result: data, refs: collection.refs };
            reply.text = `${reply.text}${block}`;
        }
        catch {
            /* refs 是附加信息：抽不出来就不加，不影响这次调用 */
        }
        return reply;
    };
}
/**
 * IPC 方法分发表。
 *
 * ⚠ 键名必须与 DSH 侧插件里 `ipcCall('...')` 的字符串一致
 * （见 `dsh-profile/plugin/dsh-cocos-bridge/index.js`）。
 */
exports.COCOS_IPC_METHODS = {
    execute_code: withRefs(runExecuteCode),
    describe_api: withRefs(describeApi),
    editor_state: withRefs(readEditorState),
    capture_view: withRefs(runCaptureView),
    read_logs: withRefs(logs_1.readLogs),
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29jb3MtdG9vbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvY29jb3MtdG9vbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FnREc7OztBQXlDSCx3Q0FFQztBQW9CRCx3Q0FFQztBQVlELGtDQWtCQztBQXVKRCwwQ0ErR0M7QUFuV0QsMkNBQTZEO0FBQzdELDBDQUF5RztBQUN6RyxnREFBMkQ7QUFDM0QsaUNBQWtDO0FBSWxDLG1CQUFtQjtBQUNuQixTQUFTLFFBQVEsQ0FBQyxLQUFjO0lBQzVCLE9BQU8sS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2xFLENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLG1CQUFtQixDQUFDLFVBQW1CO0lBQzVDLElBQUksQ0FBQyxVQUFVLElBQUksT0FBTyxVQUFVLEtBQUssUUFBUTtRQUFFLE9BQU8sVUFBVSxDQUFDO0lBQ3JFLE1BQU0sUUFBUSxHQUFHLFVBQWtDLENBQUM7SUFDcEQsT0FBTyxRQUFRLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUM7QUFDL0QsQ0FBQztBQUVELG9DQUFvQztBQUNwQyxNQUFNLGlCQUFpQixHQUNuQix1Q0FBdUM7SUFDdkMsZ0RBQWdELENBQUM7QUFFckQ7Ozs7O0dBS0c7QUFDSSxLQUFLLFVBQVUsY0FBYyxDQUFDLE1BQStCO0lBQ2hFLE9BQU8sSUFBQSxvQkFBVyxFQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFFRDs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFDSSxLQUFLLFVBQVUsY0FBYyxDQUFDLE1BQStCO0lBQ2hFLE9BQU8sSUFBQSxvQkFBVyxF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bkMsWUFBWSxFQUFFLFFBQVEsQ0FBQyxlQUFlLENBQUM7SUFDdkMsWUFBWSxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUM7SUFDdEMsU0FBUyxFQUFFLFFBQVEsQ0FBQyxlQUFRLENBQUM7Q0FDaEMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRFNIIOeahOWOn+eUn+W3peWFt+aAjuS5iOiQveWIsOe8lui+keWZqOS4iiDigJTigJQg5Lmf5bCx5pivIElQQyDor7fmsYLnmoTmnI3liqHnq6/lrp7njrDjgIJcbiAqXG4gKiAjIyDlvJXmk47lnKjlk6rvvJrmnKzmianlsZXoh6rluKbvvIzkuI3kvp3otZbliKvnmoTmianlsZVcbiAqXG4gKiDmiafooYzog73lipvvvIjnvJbovpHlmagv5Zy65pmv5Luj56CB5rKZ566x44CB6LaF5pe244CB5pel5b+X5pS26ZuG44CB5bqP5YiX5YyW5LiK6ZmQ44CBZ2l6bW8g5rGh5p+T6L+H5ruk44CB5pKk6ZSA5b+r54Wn44CBXG4gKiByZWNpcGUg5LqU5Lu25aWX77yJ5YWo6YOo5ZyoKirmnKzmianlsZXoh6rlt7EqKueahCBgY29yZS9lbmdpbmUudHNgICsgYHNvdXJjZS9zY2VuZS50c2Ag6YeM77yMXG4gKiDotbDnvJbovpHlmagqKuWGhemDqCoq55qE6YCa6YGT77yM5LiN57uP6L+HIGxvb3BiYWNrIEhUVFDvvJpcbiAqXG4gKiBgYGBcbiAqIERTSCDlrZDov5vnqIsgLS1mb3JrIElQQy0tPiDmnKzmianlsZXkuLvov5vnqIso5pys5paH5Lu2KSAtLWNvcmUvZW5naW5lLS0+IHZtIOaymeeuse+8iGVkaXRvciDkuIrkuIvmlofvvIlcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlC0tPiDmnKzmianlsZXlnLrmma/ohJrmnKzvvIhzY2VuZSDkuIrkuIvmlofvvIlcbiAqIGBgYFxuICpcbiAqIOWcuuaZr+iEmuacrOeUsSBgcGFja2FnZS5qc29uYCDnmoQgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOazqOWGjO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxuICog57yW6L6R5Zmo5ZyoKirmiZPlvIDlnLrmma8qKuaXtuaKiuWug+WKoOi9vei/m+W8leaTjui/m+eoiyDigJTigJQg5omA5Lul44CM5rKh5omT5byA5Zy65pmv44CN5piv5ZSv5LiA5LiA5LiqXG4gKiDpnIDopoHlkJHmqKHlnovop6Pph4rmuIXmpZrnmoTlpLHotKXmqKHlvI/vvIjop4EgYFNDRU5FX1NDUklQVF9ISU5UYO+8ieOAglxuICpcbiAqICMjIOS6lOS4quaWueazle+8jOWFtuS4reS4pOS4quaYr+OAjOWIq+eMnOOAjeeahOaKpOagj1xuICpcbiAqIElQQyDljY/orq7opoHnqoTjgILor63kuYnmlrnms5XotorlsJHvvIxEU0gg5L6n5o+S5Lu255qE5Y+C5pWw5qCh6aqM5LiO6L+Z6YeM55qE5a6e546w6LaK5LiN5a655piT6ZSZ5L2N44CCXG4gKiDpnIDopoHmlrDog73lipvml7bkvJjlhYjmiakgYGV4ZWN1dGVfY29kZWAg55qE55So5rOV77yI5a6D5bCx5piv6YCa55So6YCD55Sf5Y+j77yJ77yM6ICM5LiN5piv5Yqg5paw5pa55rOV44CCXG4gKlxuICogfCDmlrnms5UgfCDop5LoibIgfFxuICogfC0tLXwtLS18XG4gKiB8IGBleGVjdXRlX2NvZGVgIHwg6YCa55So6YCD55Sf5Y+j44CC5YaZ5Luj56CB77yM5LiA5qyh5omn6KGM6YeM5a6M5oiQ44CM5Y+W5pWw5o2uIOKGkiDmlLnnirbmgIEg4oaSIOi/lOWbnue7k+iuuuOAjSB8XG4gKiB8IGBkZXNjcmliZV9hcGlgIHwgKirmuJDov5vlvI/miqvpnLIqKiDigJTigJQg5Yir54yc5byV5pOOL+e8lui+keWZqCBBUEnvvIzmjInpnIDmn6XkuIDkuKrlkb3lkI3nqbrpl7TmiJbkuIDkuKrnsbsgfFxuICogfCBgZWRpdG9yX3N0YXRlYCB8IOaMiemcgOiHquajgO+8muaIkeWcqOWTquS4quW3peeoiy/lnLrmma/jgIHpgInkuK3kuobku4DkuYjjgIHmspnnrrHog73kuI3og73liqggfFxuICogfCBgY2FwdHVyZV92aWV3YCB8ICoq5L6L5aSW5LiAKirvvJrmiorlnLrmma/op4blm77vvIjmiJbmn5DkuKroioLngrnvvInlrZjmiJDlm77niYfmlofku7bjgIHlm57ot6/lvoTjgILlg4/ntKDloZ7kuI3ov5vov5Tlm57lgLzkuIrpmZDvvIzlj6rog73ljZXni6zlvIDkuIDmnaHpgJrpgZPjgILpu5jorqTkvJoqKuWFiOWPluaZr+WGjeaIqioq77yIYGZpdGDvvInvvIzlm6DkuLrlsY/luZXkuIrpgqPkuIDluKfmnKrlv4XmmK/lhajmma8gfFxuICogfCBgcmVhZF9sb2dzYCB8ICoq5L6L5aSW5LqMKirvvJror7vlt6XnqIvph4znmoTml6Xlv5fmlofku7bjgILmjqfliLblj7Av5pel5b+X5paH5Lu26YeM55qE5a2XKirku6PnoIHmi7/kuI3liLAqKu+8iOmCo+aYr+WPpuS4gOS4qui/m+eoi+eahOi+k+WHuu+8ie+8jOWPquiDveWNleeLrOW8gOS4gOadoemAmumBk+OAguWunueOsOWcqCBgbG9ncy50c2AgfFxuICpcbiAqICMjIOWHuuWPo+e7n+S4gOihpSBgcmVmc2BcbiAqXG4gKiDmr4/kuKrmlrnms5XnmoTlm57miafpg73kvJrnu48gYHdpdGhSZWZzYCDov4fkuIDpgZPvvJrmiornu5Pmnpzph4zlh7rnjrDov4fnmoQqKuWFqOW9oiB1dWlkIC8gYGRiOi8vYCDot6/lvoQqKlxuICog5Y676YeN5ZCO5o6S6L+b5paH5qGI57uT5bC+77yI57uT5p6E5YyW54mI5pys5ZyoIGBkYXRhLnJlZnNg77yJ44CC55CG55Sx5piv5a6D55u05o6l55yB5o6J5LiA6L2u5b6A6L+UIOKAlOKAlFxuICog5LiN54S25qih5Z6L6KaB5LmI6YeN5p+l5LiA5qyh77yM6KaB5LmI5Yet6K6w5b+G57yW5LiA5Liq77yIYFNLSUxMLm1kYCDph4zkuJPpl6jlhpnov4fjgIzliKvnjJwgdXVpZOOAje+8ieOAglxuICog6L+Z5LiA5bGCKirlj6rlgZrmkKzov5DvvIzkuI3lgZrliKTmlq0qKu+8muS4jeiupOivhlwi5ZOq5LiqIHV1aWQg5pu06YeN6KaBXCLvvIzkuZ/ku47kuI3mlLnlhpnljp/mnInmlofmoYjjgIJcbiAqXG4gKiAjIyBkZXNjcmliZV9hcGkg55qE5Lik5L6n6LWw5LqG5Lik5p2h5LiN5ZCM55qE6LevXG4gKlxuICogLSAqKmVkaXRvciDkvqcqKu+8mue8lui+keWZqOS4u+i/m+eoi+eahOWPjeWwhOayoeacieWvueWklua2iOaBr++8jOaJgOS7pei/memHjOiHquW3seWunueOsO+8iOe6r+WPjeWwhO+8jOe6piA5MCDooYzvvInvvIxcbiAqICAg5L2GIGBoZWxwZXJzYCDkuIDmoaMqKuWbnuaymeeusemXrioqIGBoZWxwZXJOYW1lcygpYCDigJTigJQg5Yqp5omL5riF5Y2V5piv5rKZ566x6Ieq5bex55qE5LqL5a6e77yMXG4gKiAgIOaKhOS4gOS7veW/heeEtui/h+acn+OAglxuICogLSAqKnNjZW5lIOS+pyoq77ya6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yIYGRlc2NyaWJlQXBpYO+8ieOAguexu+eahOWxnuaAp+WQjeimgeS7jiBgX19wcm9wc19fYCArXG4gKiAgIOWunuaXtuWunuS+i+S4iuivu++8jOmCo+mDqOWIhuaYryBgc2NlbmUudHNgIOmHjOacgOS4jeivpemHjeWGmeeahOS7o+eggeOAglxuICpcbiAqIOKaoCBgZXhlY3V0ZS1zY2VuZS1zY3JpcHRgICoq6ZyA6KaB5Zy65pmv6L+b56iL6YeM5bey57uP5Yqg6L295LqG5pys5omp5bGV6ISa5pysKirvvIjopoHmnInlnLrmma/miZPlvIDvvInjgIJcbiAqIOayoeWKoOi9veaXtuaKm+mUmSDigJTigJQg5omA5Lul6YKj5LiA5qGj5b+F6aG75oqK5aSx6LSl57+76K+R5oiQ44CM5YWI5omT5byA5LiA5Liq5Zy65pmv44CN44CCXG4gKi9cblxuaW1wb3J0IHsgRVhURU5TSU9OX05BTUUsIHR5cGUgVG9vbFJlcGx5IH0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgY2FwdHVyZVZpZXcsIGRlc2NyaWJlU2NlbmVBcGksIGV4ZWN1dGVDb2RlLCBwaW5nU2NlbmVTY3JpcHQgYXMgcGluZ1NjZW5lIH0gZnJvbSAnLi9jb3JlL2VuZ2luZSc7XG5pbXBvcnQgeyBjb2xsZWN0UmVmcywgZm9ybWF0UmVmcyB9IGZyb20gJy4vY29yZS9zZXJpYWxpemUnO1xuaW1wb3J0IHsgcmVhZExvZ3MgfSBmcm9tICcuL2xvZ3MnO1xuXG5leHBvcnQgdHlwZSB7IFRvb2xSZXBseSB9O1xuXG4vKiog5oqK5Lu75oSP5byC5bi45pS25pWb5oiQ5LiA5Y+l6K+d44CCICovXG5mdW5jdGlvbiBkZXNjcmliZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiDliaXmjonmspnnrrHnu5PmnpzlpJbpnaLpgqPlsYLkv6HlsIHjgIJcbiAqXG4gKiBgc3RydWN0dXJlZGAvYGRhdGFgIOeahOW9oueKtuaYryBgeyBvaywgY29udGV4dCwgZHVyYXRpb25NcywgcmVzdWx0IH1g77yIYHJlc3VsdGAg5omN5pivIGByZXR1cm5gIOeahOWAvO+8ie+8jFxuICog5L2G6ZSZ6K+v5YiG5pSv6YeM5rKh5pyJIGByZXN1bHRg44CB5Y+q5pyJIGBlcnJvcmDjgILmiYDku6Xov5nph4zlgZrjgIzmnIkgcmVzdWx0IOWwseWPliByZXN1bHTjgI3nmoTlrrnplJnop6PljIXvvIxcbiAqIOiuqeiwg+eUqOaWueaLv+WIsOeahOawuOi/nOaYryoq5rKZ566x6YeMIHJldHVybiDnmoTpgqPkuKrkuJzopb8qKuOAglxuICpcbiAqIEBwYXJhbSBzdHJ1Y3R1cmVkIC0g5rKZ566x5Zue5omn55qEIGBkYXRhYCDlrZfmrrXjgIJcbiAqIEByZXR1cm5zIOaymeeusei/lOWbnuWAvO+8m+aXoOazleWIpOWumuaXtuWOn+agt+i/lOWbnuOAglxuICovXG5mdW5jdGlvbiB1bndyYXBTYW5kYm94UmVzdWx0KHN0cnVjdHVyZWQ6IHVua25vd24pOiB1bmtub3duIHtcbiAgICBpZiAoIXN0cnVjdHVyZWQgfHwgdHlwZW9mIHN0cnVjdHVyZWQgIT09ICdvYmplY3QnKSByZXR1cm4gc3RydWN0dXJlZDtcbiAgICBjb25zdCBlbnZlbG9wZSA9IHN0cnVjdHVyZWQgYXMgeyByZXN1bHQ/OiB1bmtub3duIH07XG4gICAgcmV0dXJuICdyZXN1bHQnIGluIGVudmVsb3BlID8gZW52ZWxvcGUucmVzdWx0IDogc3RydWN0dXJlZDtcbn1cblxuLyoqIOWcuuaZr+iEmuacrOayoeWKoOi9veaXtueahOe7n+S4gOaWh+ahiO+8iOWkmuaVsOaDheWGteaYr+OAjOayoeacieaJk+W8gOWcuuaZr+OAje+8ieOAgiAqL1xuY29uc3QgU0NFTkVfU0NSSVBUX0hJTlQgPVxuICAgICfpgJrluLjmmK8qKuW9k+WJjeayoeacieaJk+W8gOWcuuaZryoq77yI5Zy65pmv6L+b56iL5Y+q5Zyo5pyJ5Zy65pmv5omT5byA5pe25omN5Yqg6L295omp5bGV6ISa5pys77yJ44CCJyArXG4gICAgJ+ivt+WcqCBDb2NvcyBDcmVhdG9yIOmHjOaJk+W8gOS7u+aEj+WcuuaZr+WQjumHjeivle+8m+iLpeWImuWQr+eUqOacrOaJqeWxle+8jOmHjeWQr+S4gOasoee8lui+keWZqOabtOeos+OAgic7XG5cbi8qKlxuICog5Zyo57yW6L6R5Zmo6YeM5omn6KGM5LiA5q615Luj56CB77yIZWRpdG9yIOi1sCB2bSDmspnnrrHvvIxzY2VuZSDotbDmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvInjgIJcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtjb250ZXh0LCBjb2RlLCBhcmdzLCB0aW1lb3V0TXMsIHNuYXBzaG90fWDjgIJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m+Wksei0peS5n+i/lOWbniBgb2s6ZmFsc2VgIOiAjOS4jeaYr+aKm++8iOiuqeaooeWei+eci+WIsOWPr+ivu+eahOWOn+WboO+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRXhlY3V0ZUNvZGUocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgcmV0dXJuIGV4ZWN1dGVDb2RlKHBhcmFtcyk7XG59XG5cbi8qKlxuICog5oiq5LiA5bygKirlnLrmma/op4blm74qKu+8iOaIluWFtuS4reS4gOS4quiKgueCue+8ieW5tuWtmOaIkOWbvueJh+aWh+S7tu+8iOWunueOsOWcqCBgY29yZS9lbmdpbmUudHNgICtcbiAqIGBzb3VyY2UvY2FwdHVyZS50c2AgKyBgc291cmNlL3NjZW5lLnRzYO+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOWNleeLrOS4gOS4quaWueazle+8muWbvueJh+aYr+S6jOi/m+WIti/lpKflrZfnrKbkuLLvvIzloZ7kuI3ov5sgYGV4ZWN1dGVfY29kZWAg55qE6L+U5Zue5YC85LiK6ZmQXG4gKiDvvIjljZXlrZfnrKbkuLIgNDAwMCDlrZfvvInigJTigJQg5omA5Lul5a6D5b+F6aG75piv44CM5bel5YW3IOKGkiDokL3nm5gg4oaSIOWbnui3r+W+hOOAjei/meS4gOadoeeLrOeri+mAmumBk+OAglxuICpcbiAqIOS4pOadoemAmumBk++8iOWbnuaJp+mHjOeahCBgbWV0aG9kYCDkvJrlhpnmmI7mmK/lk6rmnaHvvInvvJoqKuS4u+i/m+eoiyBFbGVjdHJvbioq77yIYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgXG4gKiDor7vlkIjmiJDlkI7nmoTnlLvpnaLvvIznqbrlm77ml7YgYGludmFsaWRhdGUoKWAg6YC85LiA5qyh6YeN57uY77yJ5LyY5YWI77yb5Zy65pmv6L+b56iL6K+7IEdMIOWQjuWkh+e8k+WGsuWPquS9nOWFnOW6leOAglxuICpcbiAqIGBmaXRgIOaYr+OAjOeUqOaIt+e8qeaUvui/h+S5i+WQju+8jOWxj+W5leS4iumCo+S4gOW4p+acquW/heaYr+WFqOaZr+OAjeeahOino+azle+8muaIquWbvuWJjeWFiOaKiuebuOacuuaRhuWIsOahhuS9j+ebruagh+eahOS9jee9ruOAgVxuICog5oiq5a6M56uL5Yi76L+Y5Y6f77yIYGF1dG9gIOWPquWcqOmcgOimgeaXtuaJjeWKqOebuOacuu+8m2Bub25lYCDlrozlhajkuI3liqjvvInjgILotKbmnKzlnKjlm57miafnmoQgYGZyYW1pbmdgIOmHjOOAglxuICpcbiAqIEBwYXJhbSBwYXJhbXMgLSBge3NhdmVQYXRoPywgbm9kZT8sIHBhZGRpbmc/LCBmaXQ/LCBtYXhXaWR0aD8sIGZvcm1hdD8sIHF1YWxpdHk/LCB3YWl0TXM/LCB0aW1lb3V0TXM/fWDjgIJcbiAqICAgYG5vZGVgIOe7mSB1dWlkIOaIlui3r+W+hO+8iGBDYW52YXMvc2tpbGxfZGV0YWlsc2DvvInml7blj6rmiKrpgqPkuIDkuKroioLngrnvvJtcbiAqICAgYGZpdGAgPSBgYXV0b2DvvIjpu5jorqTvvIkvIGBzY2VuZWAgLyBgbm9kZWAgLyBgbm9uZWDvvIjor6bop4EgYGNvcmUvZW5naW5lLnRzYCDnmoQgYGNhcHR1cmVWaWV3YO+8ieOAglxuICogQHJldHVybnMgYGRhdGEucGF0aGAg5piv5Zu+54mH57ud5a+56Lev5b6E77yM5Y+v55u05o6l5ZaC57uZ5Zu+54mH6K+75Y+W5bel5YW344CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DYXB0dXJlVmlldyhwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICByZXR1cm4gY2FwdHVyZVZpZXcocGFyYW1zKTtcbn1cblxuLyoqXG4gKiDmn6XkuIDkuKogQVBJIOWumuS5iSDigJTigJQgKirmuJDov5vlvI/miqvpnLIqKu+8jOS5n+aYr+OAjOWIq+eMnOW8leaTjiBBUEnjgI3ov5nmnaHop4Tnn6nnmoTmiafooYzogIXjgIJcbiAqXG4gKiDkuLrku4DkuYjlgLzlvpfljZXni6zkuIDkuKrlt6XlhbfvvJrmqKHlnovlhpnnvJbovpHlmajku6PnoIHml7bmnIDniLHnno7njJzlsZ7mgKflkI3vvIhgY29tcC5mb3ZgIOi/mOaYr1xuICogYGNvbXAuZm92QXhpc2DvvInvvIznjJzplJnkuIDmrKHnmoTku6Pku7fmmK/kuIDmlbTova7lvoDov5TjgILov5nph4znu5nnmoTmmK8qKui/kOihjOaXtuWPjeWwhCoq55qE57uT5p6c77yMXG4gKiDmsLjov5zmr5Tku7vkvZXnvJPlrZgv5paH5qGj5paw77ybc2NlbmUg5L6n5bimIGBub2RlVXVpZGAg5pe26L+Y6IO96KGl5Ye6KirlvZPliY3lgLwqKuOAglxuICpcbiAqIEBwYXJhbSBwYXJhbXMgLSBge2NvbnRleHQsIHRhcmdldCwgbm9kZVV1aWQsIGxpbWl0fWDjgIJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m2B0ZXh0YCDmmK/nu5nmqKHlnovnnIvnmoQgSlNPTuOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVzY3JpYmVBcGkocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgY29uc3QgY29udGV4dCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6ICdlZGl0b3InO1xuICAgIGNvbnN0IHRhcmdldCA9IHR5cGVvZiBwYXJhbXMudGFyZ2V0ID09PSAnc3RyaW5nJyA/IHBhcmFtcy50YXJnZXQudHJpbSgpIDogJyc7XG4gICAgY29uc3Qgbm9kZVV1aWQgPSB0eXBlb2YgcGFyYW1zLm5vZGVVdWlkID09PSAnc3RyaW5nJyA/IHBhcmFtcy5ub2RlVXVpZCA6ICcnO1xuICAgIGNvbnN0IGxpbWl0ID0gY2xhbXBMaW1pdChwYXJhbXMubGltaXQpO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9XG4gICAgICAgICAgICBjb250ZXh0ID09PSAnZWRpdG9yJ1xuICAgICAgICAgICAgICAgID8gYXdhaXQgZGVzY3JpYmVFZGl0b3JBcGkodGFyZ2V0LCBsaW1pdClcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGRlc2NyaWJlU2NlbmVBcGkodGFyZ2V0LCBub2RlVXVpZCwgbGltaXQpO1xuICAgICAgICByZXR1cm4geyBvazogcGF5bG9hZC5vayAhPT0gZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBkYXRhOiBwYXlsb2FkIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIHRleHQ6IGDmn6Xor6IgQVBJIOWumuS5ieWksei0pe+8iCR7Y29udGV4dH0gLyAke3RhcmdldCB8fCAnKOaAu+iniCknfe+8ie+8miR7ZGVzY3JpYmUoZXJyb3IpfVxcbiR7U0NFTkVfU0NSSVBUX0hJTlR9YCxcbiAgICAgICAgfTtcbiAgICB9XG59XG5cbi8qKiDliJfooajnsbvlj4LmlbDnu5/kuIDlpLnliLAgMX41MDDvvIjpu5jorqQgODDvvInjgIIgKi9cbmZ1bmN0aW9uIGNsYW1wTGltaXQodmFsdWU6IHVua25vd24pOiBudW1iZXIge1xuICAgIGNvbnN0IHJhdyA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgudHJ1bmModmFsdWUpIDogODA7XG4gICAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKDUwMCwgcmF3KSk7XG59XG5cbi8qKlxuICog5bi455So6LCD55So6YCf5p+lIOKAlOKAlCDmlL7mgLvop4jph4zvvIzorqnmqKHlnovlsJHotbDlh6Dova7or5XplJnjgIJcbiAqXG4gKiDov5nlh6DmnaHmmK8qKue6r+aWh+acrOefpeivhioq77yI5LiN5piv6IO95Y+N5bCE5Ye65p2l55qE5Lic6KW/77yJ77yM5omA5Lul5YaZ5oiQ5bi46YeP5piv5Y+v5Lul5o6l5Y+X55qE77ybXG4gKiDpgLvovpHliKvmioTvvIjop4EgYGRlc2NyaWJlRWRpdG9yQXBpYCDph4wgYGhlbHBlcnNgIOmCo+S4gOaho+eahOWkhOeQhuaWueW8j++8ieOAglxuICovXG5jb25zdCBFRElUT1JfQ0hFQVRTSEVFVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICDotYTmupDmn6Xor6I6IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiAnZGI6Ly9hc3NldHMvKiovKi5wcmVmYWInIH0pXCIsXG4gICAg6LWE5rqQ6K+m5oOFOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmxPclV1aWQpXCIsXG4gICAg5Yi35paw6LWE5rqQOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlZnJlc2gtYXNzZXQnLCAnZGI6Ly9hc3NldHMnKVwiLFxuICAgIOS/neWtmOWcuuaZrzogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJylcIixcbiAgICDmiZPlvIDlnLrmma86IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnb3Blbi1zY2VuZScsIHNjZW5lQXNzZXRVdWlkKVwiLFxuICAgIOmAieS4rei1hOa6kDogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdzZXQtYXNzZXQtdXVpZC1zZWxlY3Rpb24nLCB1dWlkKVwiLFxuICAgIOivu+iuvue9rjogXCJhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRDb25maWcoJzzmianlsZXlkI0+JywgJ2tleScsICdsb2NhbCcpXCIsXG4gICAg5bel56iL6Lev5b6EOiAnRWRpdG9yLlByb2plY3QucGF0aCcsXG4gICAg57yW6L6R5Zmo54mI5pysOiAnRWRpdG9yLkFwcC52ZXJzaW9uJyxcbiAgICDmjqfliLblj7Dml6Xlv5c6ICdFZGl0b3IuTG9nZ2VyLnF1ZXJ5KCknLFxufTtcblxuLyoqXG4gKiDnvJbovpHlmajkuLvov5vnqIvkvqfnmoTlj43lsITvvIhgY29yZS9lbmdpbmUudHNgIOmHjOayoeacieWvueW6lOeahOWvueWklua2iOaBr++8jOaJgOS7pei/memHjOiHquW3seWunueOsO+8ieOAglxuICpcbiAqIOWbm+aho++8muaAu+iniCAvIGBoZWxwZXJzYCAvIGBtb2R1bGU6eHh4YCAvIGBFZGl0b3IuWHh4Lll5eWDjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVzY3JpYmVFZGl0b3JBcGkodGFyZ2V0OiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgZWRpdG9yQW55ID0gRWRpdG9yIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICBjb25zdCBuYW1lc3BhY2VzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbWV0aG9kQ291bnQ6IG51bWJlcjsgc2FtcGxlOiBzdHJpbmdbXSB9PiA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhlZGl0b3JBbnkpLnNvcnQoKSkge1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBlZGl0b3JBbnlba2V5XTtcbiAgICAgICAgICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgY29udGludWU7XG4gICAgICAgICAgICBsZXQgbWV0aG9kTmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG1ldGhvZE5hbWVzID0gT2JqZWN0LmtleXModmFsdWUgYXMgb2JqZWN0KS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICAgIChrKSA9PiB0eXBlb2YgKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXSA9PT0gJ2Z1bmN0aW9uJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kTmFtZXMgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG5hbWVzcGFjZXMucHVzaCh7IG5hbWU6IGtleSwgbWV0aG9kQ291bnQ6IG1ldGhvZE5hbWVzLmxlbmd0aCwgc2FtcGxlOiBtZXRob2ROYW1lcy5zbGljZSgwLCA4KSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBraW5kOiAnaW5kZXgnLFxuICAgICAgICAgICAgY29udGV4dDogJ2VkaXRvcicsXG4gICAgICAgICAgICBuYW1lc3BhY2VzLFxuICAgICAgICAgICAgY2hlYXRzaGVldDogRURJVE9SX0NIRUFUU0hFRVQsXG4gICAgICAgICAgICBoaW50OlxuICAgICAgICAgICAgICAgIFwi55SoIGNvY29zX2Rlc2NyaWJlX2FwaSh7Y29udGV4dDonZWRpdG9yJywgdGFyZ2V0OidFZGl0b3IuTWVzc2FnZSd9KSDnnIvmn5DkuKrlkb3lkI3nqbrpl7TnmoTmlrnms5XlhajooajvvJtcIiArXG4gICAgICAgICAgICAgICAgXCJ0YXJnZXQ6J2hlbHBlcnMnIOeci+aymeeuseWKqeaJi++8m3RhcmdldDonbW9kdWxlOmZzJyDnnIvmn5DkuKogbm9kZSDmqKHlnZfnmoTlr7zlh7rjgIJcIixcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDimqAgKirliKvmioTliqnmiYvmuIXljZUqKu+8muWug+eUseaymeeuseazqOWFpe+8iGBjb3JlL2VuZ2luZS50c2Ag55qEIGBidWlsZEVkaXRvckhlbHBlcnNgICsgcmVjaXBlIOS6lOS7tuWll++8ie+8jFxuICAgICAqIOaKhOS4gOS7veeahOS4i+WcuuaYr+OAjOafpeWIsOeahOWHveaVsOWcqOaymeeusemHjOS4jeWtmOWcqOOAjeOAguaJgOS7pei/meS4gOahoyoq5Zue5rKZ566x6ZeuKirjgIJcbiAgICAgKi9cbiAgICBpZiAodGFyZ2V0ID09PSAnaGVscGVycycpIHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBydW5FeGVjdXRlQ29kZSh7IGNvbnRleHQ6ICdlZGl0b3InLCB0aW1lb3V0TXM6IDgwMDAsIGNvZGU6ICdyZXR1cm4gaGVscGVyTmFtZXMoKTsnIH0pO1xuICAgICAgICBjb25zdCBuYW1lcyA9IHVud3JhcFNhbmRib3hSZXN1bHQocmVwbHkuZGF0YSk7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShuYW1lcykpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwga2luZDogJ2hlbHBlcnMnLCBjb250ZXh0OiAnZWRpdG9yJywgZXJyb3I6IHJlcGx5LnRleHQuc2xpY2UoMCwgODAwKSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBraW5kOiAnaGVscGVycycsIGNvbnRleHQ6ICdlZGl0b3InLCBoZWxwZXJzOiBuYW1lcyB9O1xuICAgIH1cblxuICAgIGlmICh0YXJnZXQuc3RhcnRzV2l0aCgnbW9kdWxlOicpKSB7XG4gICAgICAgIGNvbnN0IG1vZHVsZU5hbWUgPSB0YXJnZXQuc2xpY2UoJ21vZHVsZTonLmxlbmd0aCkudHJpbSgpO1xuICAgICAgICBpZiAoIW1vZHVsZU5hbWUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdtb2R1bGU6IOWQjumdouimgei3n+aooeWdl+WQje+8jOWmgiBtb2R1bGU6ZnMnIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBsb2FkZWQgPSByZXF1aXJlKG1vZHVsZU5hbWUpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKGxvYWRlZCB8fCB7fSkuc29ydCgpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgICAgICBraW5kOiAnbW9kdWxlJyxcbiAgICAgICAgICAgICAgICBtb2R1bGU6IG1vZHVsZU5hbWUsXG4gICAgICAgICAgICAgICAgZXhwb3J0Q291bnQ6IGtleXMubGVuZ3RoLFxuICAgICAgICAgICAgICAgIGV4cG9ydHM6IGtleXMuc2xpY2UoMCwgbGltaXQpLFxuICAgICAgICAgICAgICAgIGhpbnQ6IGDlnKggY29jb3NfZXhlY3V0ZV9jb2RlIOmHjOebtOaOpSBcXGByZXR1cm4gcmVxdWlyZSgnJHttb2R1bGVOYW1lfScpXFxgIOWPr+S7peaLv+WIsOecn+WunuWvueixoeOAgmAsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYHJlcXVpcmUoJyR7bW9kdWxlTmFtZX0nKSDlpLHotKXvvJoke2Rlc2NyaWJlKGVycm9yKX1gIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDmjInngrnliIbot6/lvoTlnKggRWRpdG9yIOS4iui1sO+8iGBFZGl0b3IuTWVzc2FnZWAg5LiOIGBNZXNzYWdlYCDkuKTnp43lhpnms5Xpg73orqTvvIlcbiAgICBjb25zdCBwYXJ0cyA9IHRhcmdldC5yZXBsYWNlKC9eRWRpdG9yXFwuPy8sICcnKS5zcGxpdCgnLicpLmZpbHRlcihCb29sZWFuKTtcbiAgICBsZXQgbm9kZTogdW5rbm93biA9IEVkaXRvcjtcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcbiAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fe+8iOWcqCAke3BhcnR9IOWkhOaWremTvu+8iWAgfTtcbiAgICAgICAgbm9kZSA9IChub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtwYXJ0XTtcbiAgICB9XG4gICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fWAgfTtcbiAgICBpZiAodHlwZW9mIG5vZGUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBraW5kOiAndmFsdWUnLCB0YXJnZXQsIHZhbHVlOiBTdHJpbmcobm9kZSkgfTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2RzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhub2RlIGFzIG9iamVjdCkuc29ydCgpKSB7XG4gICAgICAgIGxldCBlbnRyeTogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGVudHJ5ID0gKG5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiBlbnRyeSA9PT0gJ2Z1bmN0aW9uJykgbWV0aG9kcy5wdXNoKGtleSk7XG4gICAgICAgIGVsc2UgdmFsdWVzLnB1c2goa2V5KTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAga2luZDogJ25hbWVzcGFjZScsXG4gICAgICAgIHRhcmdldDogYEVkaXRvci4ke3BhcnRzLmpvaW4oJy4nKX1gLFxuICAgICAgICBtZXRob2RzOiBtZXRob2RzLnNsaWNlKDAsIGxpbWl0KSxcbiAgICAgICAgbWV0aG9kQ291bnQ6IG1ldGhvZHMubGVuZ3RoLFxuICAgICAgICB2YWx1ZXM6IHZhbHVlcy5zbGljZSgwLCBNYXRoLm1pbigzMCwgbGltaXQpKSxcbiAgICAgICAgaGludDogYOiwg+eUqOW9ouWmgiBcXGBhd2FpdCAke3RhcmdldH0ueHh4KC4uLilcXGDvvJvlj4LmlbDpobrluo/op4HnvJbovpHlmajlrpjmlrnmlofmoaPvvIzmiJbnm7TmjqXor5XosIPnnIvmiqXplJnjgIJgLFxuICAgIH07XG59XG5cbi8qXG4gKiDlnLrmma/kvqfnmoTlj43lsITvvIhgZGVzY3JpYmVTY2VuZUFwaWDvvInkuI7mjqLmtLvvvIhgcGluZ1NjZW5lU2NyaXB0YO+8iemDveWcqCBgY29yZS9lbmdpbmUudHNgIOmHjCDigJTigJRcbiAqIOWug+S7rOWPquaYryBgZXhlY3V0ZS1zY2VuZS1zY3JpcHRgIOeahOS4gOWxguiWhOWwgeijhe+8jOayoeW/heimgeWcqOi/memHjOWGjeaKhOS4gOS7veOAglxuICovXG5cbi8qKlxuICog55yL5LiA55y857yW6L6R5Zmo546w5Zyo5piv5LuA5LmI54q25oCB44CCXG4gKlxuICog5LiJ5Z2X5L+h5oGv5p2l6Ieq5LiN5ZCM6L+b56iL77yaXG4gKiAtICoq5bel56iLL+eJiOacrCoq77ya5Li76L+b56iL55qEIGBFZGl0b3IuUHJvamVjdGAgLyBgRWRpdG9yLkFwcGDvvJtcbiAqIC0gKirpgInkuK0qKu+8muS4u+i/m+eoi+mXriBgc2NlbmVgIOWMheeahCBgcXVlcnktbm9kZS10cmVlYO+8m1xuICogLSAqKuWcuuaZryoq77ya5YCf5pys5omp5bGV55qE5Zy65pmv5rKZ566x6LeR5LiA5bCP5q6177yIYGRpcmVjdG9yLmdldFNjZW5lKClg77yJ44CCXG4gKlxuICog5YaN5Yqg5LiA5Z2XKirog73lipvmjqLmtLsqKu+8iOW+iOWAvOmSseeahOmCo+mDqOWIhu+8ie+8muWcuuaZr+iEmuacrOWKoOi9veS6huayoeaciSDigJTigJRcbiAqIOaooeWei+aNruatpOaPkOWJjeefpemBk+OAjOaOpeS4i+adpeiDveS4jeiDveWKqOWcuuaZr+OAje+8jOiAjOS4jeaYr+WGmeS6huS4gOWxj+S7o+eggeaJjeWPkeeOsOayoeaJk+W8gOWcuuaZr+OAglxuICpcbiAqIOS7u+S9leS4gOWdl+aLv+S4jeWIsOmDvSoq5LiN6Zi75patKirmlbTkvZPigJTigJTov5Tlm57lt7LmnInnmoTpg6jliIYgKyDkuIDmnaEgYOKApuivu+WPluWksei0pe+8muWOn+WboGDvvIzmr5TmlbTkuKrlt6XlhbflpLHotKXmnInnlKjjgIJcbiAqXG4gKiBAcGFyYW0gX3BhcmFtcyAtIGB7dmVyYm9zZT99YO+8iOW9k+WJjSB2ZXJib3NlIOWPquW9seWTjeaYr+WQpumZhOS4iui/kOihjOaXtuiviuaWre+8ieOAglxuICogQHJldHVybnMg5bel5YW35Zue5omn44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkRWRpdG9yU3RhdGUoX3BhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgY29uc3QgcHJvYmxlbXM6IHN0cmluZ1tdID0gW107XG5cbiAgICB0cnkge1xuICAgICAgICBkYXRhLnByb2plY3RQYXRoID0gRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgbGluZXMucHVzaChg5bel56iL77yaJHtFZGl0b3IuUHJvamVjdC5wYXRofWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHByb2JsZW1zLnB1c2goYOW3peeoi+i3r+W+hOivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIGRhdGEuZWRpdG9yVmVyc2lvbiA9IEVkaXRvci5BcHAudmVyc2lvbjtcbiAgICAgICAgZGF0YS5lZGl0b3JOYW1lID0gRWRpdG9yLkFwcC5uYW1lO1xuICAgICAgICBsaW5lcy5wdXNoKGDnvJbovpHlmajvvJoke0VkaXRvci5BcHAubmFtZX0gJHtFZGl0b3IuQXBwLnZlcnNpb259YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg57yW6L6R5Zmo54mI5pys6K+75Y+W5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktbm9kZS10cmVlJykpIGFzXG4gICAgICAgICAgICB8IHsgdXVpZD86IHN0cmluZzsgbmFtZT86IHN0cmluZyB9XG4gICAgICAgICAgICB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHNlbGVjdGVkICYmIHR5cGVvZiBzZWxlY3RlZCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGRhdGEuc2VsZWN0aW9uID0geyB1dWlkOiBzZWxlY3RlZC51dWlkID8/IG51bGwsIG5hbWU6IHNlbGVjdGVkLm5hbWUgPz8gbnVsbCB9O1xuICAgICAgICAgICAgbGluZXMucHVzaChg6YCJ5Lit77yaJHtzZWxlY3RlZC5uYW1lID8/ICco5peg5ZCNKSd9JHtzZWxlY3RlZC51dWlkID8gYCBbJHtzZWxlY3RlZC51dWlkfV1gIDogJyd9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkYXRhLnNlbGVjdGlvbiA9IG51bGw7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKCfpgInkuK3vvJrml6AnKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRhdGEuc2VsZWN0aW9uID0gbnVsbDtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg6YCJ5Lit5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgfVxuXG4gICAgLy8g5Zy65pmv5L+h5oGv6KaB5YCf5Zy65pmv6L+b56iL77yI5Li76L+b56iL5ou/5LiN5Yiw5rS755qE5Zy65pmv5qCR77yJXG4gICAgY29uc3Qgc2NlbmVQcm9iZSA9IGF3YWl0IHJ1bkV4ZWN1dGVDb2RlKHtcbiAgICAgICAgY29udGV4dDogJ3NjZW5lJyxcbiAgICAgICAgdGltZW91dE1zOiA4MDAwLFxuICAgICAgICBjb2RlOlxuICAgICAgICAgICAgJ2NvbnN0IHMgPSBkaXJlY3Rvci5nZXRTY2VuZSgpOycgK1xuICAgICAgICAgICAgJyBsZXQgbiA9IDA7JyArXG4gICAgICAgICAgICAnIGVhY2hOb2RlKCgpID0+IHsgbiArPSAxOyB9KTsnICtcbiAgICAgICAgICAgICcgcmV0dXJuIHsgaGFzU2NlbmU6ICEhcywgbmFtZTogcyA/IHMubmFtZSA6IG51bGwsIHV1aWQ6IHMgPyBzLnV1aWQgOiBudWxsLCBub2RlQ291bnQ6IG4gfTsnLFxuICAgIH0pO1xuICAgIC8qKlxuICAgICAqIOKaoCAqKui4qei/h+eahOWdkSoq77ya5rKZ566x5Zue5omn5piv5aWX5LqG5LiA5bGC55qEXG4gICAgICogYHsgb2ssIGNvbnRleHQsIGR1cmF0aW9uTXMsIHJlc3VsdCB9YCDigJTigJQg5rKZ566x55qE6L+U5Zue5YC85ZyoIGAucmVzdWx0YCDph4zjgIJcbiAgICAgKiDnrKzkuIDniYjnm7TmjqXlvZMgYHtoYXNTY2VuZX1gIOivu++8jOS6juaYryBgaGFzU2NlbmVgIOaBkuS4uiB1bmRlZmluZWQg4oaSIOeVjOmdouawuOi/nOaYvuekulxuICAgICAqIOOAjOWcuuaZr++8muacquaJk+W8gOOAje+8iOiAjOWcuuaZr+WFtuWunuW8gOedgOOAgTU0NiDkuKroioLngrnvvInjgILlt6XlhbfmnKzouqvmsqHmiqXplJnvvIzmiYDku6XnibnliKvpmr7lj5HnjrDjgIJcbiAgICAgKi9cbiAgICBjb25zdCBwcm9iZSA9IHVud3JhcFNhbmRib3hSZXN1bHQoc2NlbmVQcm9iZS5kYXRhKSBhc1xuICAgICAgICB8IHsgaGFzU2NlbmU/OiBib29sZWFuOyBuYW1lPzogc3RyaW5nOyB1dWlkPzogc3RyaW5nOyBub2RlQ291bnQ/OiBudW1iZXIgfVxuICAgICAgICB8IHVuZGVmaW5lZDtcbiAgICBpZiAoc2NlbmVQcm9iZS5vayAmJiBwcm9iZSkge1xuICAgICAgICBkYXRhLnNjZW5lID0gcHJvYmU7XG4gICAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgICAgICBwcm9iZS5oYXNTY2VuZVxuICAgICAgICAgICAgICAgID8gYOWcuuaZr++8miR7cHJvYmUubmFtZSA/PyAnKOacquWRveWQjSknfSBbJHtwcm9iZS51dWlkID8/ICctJ31d77yM6IqC54K5ICR7cHJvYmUubm9kZUNvdW50ID8/ICc/J30g5LiqYFxuICAgICAgICAgICAgICAgIDogJ+WcuuaZr++8muacquaJk+W8gCcsXG4gICAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg5Zy65pmv5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtzY2VuZVByb2JlLnRleHQuc2xpY2UoMCwgMjAwKX1gKTtcbiAgICB9XG5cbiAgICAvLyDog73lipvmjqLmtLvvvJrlnLrmma/ohJrmnKzlnKjkuI3lnKgg4oCU4oCUIOWug+WGs+WumuOAjOaOpeS4i+adpeiDveS4jeiDveaUueWcuuaZr+OAjVxuICAgIGNvbnN0IHNjZW5lU2NyaXB0ID0gYXdhaXQgcGluZ1NjZW5lKCk7XG4gICAgZGF0YS5jYXBhYmlsaXRpZXMgPSB7IHNhbmRib3g6IEVYVEVOU0lPTl9OQU1FLCBzY2VuZVNjcmlwdCB9O1xuICAgIGxpbmVzLnB1c2goXG4gICAgICAgIHNjZW5lU2NyaXB0LmF2YWlsYWJsZVxuICAgICAgICAgICAgPyBg6IO95Yqb77ya5Luj56CB5rKZ566x5Y+v55So77yI5pys5omp5bGV55qE5Zy65pmv6ISa5pys5bey5Yqg6L2977yM6IO95pS55Zy65pmv77yJYFxuICAgICAgICAgICAgOiBg6IO95Yqb77ya5Y+q6K+75b6X5Yqo57yW6L6R5ZmoIOKAlOKAlCDlnLrmma/kvqfkuI3lj6/nlKjvvJoke3NjZW5lU2NyaXB0LnJlYXNvbiA/PyAn5Zy65pmv6ISa5pys5LiN5Y+v55SoJ33jgIIke1NDRU5FX1NDUklQVF9ISU5UfWAsXG4gICAgKTtcblxuICAgIGlmIChwcm9ibGVtcy5sZW5ndGggPiAwKSBsaW5lcy5wdXNoKCcnLCAn4pqgIOmDqOWIhuS/oeaBr+ayoeaLv+WIsO+8micsIC4uLnByb2JsZW1zLm1hcCgobGluZSkgPT4gYC0gJHtsaW5lfWApKTtcblxuICAgIC8vIOS4i+S4gOatpeivpeeUqOS7gOS5iOW3peWFt++8mui/meWHoOadoeaYryoq5ZSv5LiA5LiA5aSE5qih5Z6L5LiA5a6a5Lya55yL5YiwKirnmoTnlKjms5Xmj5DnpLrvvIhEU0gg5LiN5raI6LS5IE1DUCDnmoQgaW5zdHJ1Y3Rpb25z77yJXG4gICAgbGluZXMucHVzaChcbiAgICAgICAgJycsXG4gICAgICAgICfkuIvkuIDmraXvvJonLFxuICAgICAgICAvLyDimqAg56ys5LiA5p2h5bCx5pivIHJlY2lwZe+8muWunua1i+S4gOaVtOWknOmHjCBgZmluZFJlY2lwZXNgIOiiq+iwg+eUqCAwIOasoe+8jOiAjOWUr+S4gOWtmOS4i+eahOmCo+adoSByZWNpcGVcbiAgICAgICAgLy8gICDlj4jlm6Dnm67lvZXmlLnlkI3miJDkuoblraTlhL8g4oCU4oCUIOaPkOekuuS9jeS4jeaRhuWcqOi/memHjO+8jOi/meWll+acuuWItuWwseawuOi/nOaYr+epuueahOOAglxuICAgICAgICBcIi0gKirlhYjmib7lj6/lpI3nlKjphY3mlrkqKu+8mmNvY29zX2V4ZWN1dGVfY29kZSh7Y29udGV4dDonZWRpdG9yJywgY29kZTpcXFwicmV0dXJuIGZpbmRSZWNpcGVzKClcXFwifSkg4oCU4oCUIOWBmiBVSS/pooTliLbku7Yv5om56YeP5pS56IqC54K56L+Z57G75rS75LmL5YmN5YWI55yL5pyJ5rKh5pyJ6LeR6YCa6L+H55qE5Luj56CBXCIsXG4gICAgICAgIFwiLSDlnLrmma/moJHpqqjmnrbvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6J3NjZW5lJywgY29kZToncmV0dXJuIHRyZWUoe21heERlcHRoOjIsIHdpdGhDb21wb25lbnRzOnRydWV9KSd9KVwiLFxuICAgICAgICBcIi0g57uE5Lu25pyJ5ZOq5Lqb5bGe5oCn77yaY29jb3NfZGVzY3JpYmVfYXBpKHtjb250ZXh0OidzY2VuZScsIHRhcmdldDonY2MuQ2FtZXJhJywgbm9kZVV1aWQ6JzzkuIrpnaLmn6XliLDnmoQgdXVpZD4nfSlcIixcbiAgICAgICAgJy0g57yW6L6R5ZmoIEFQSSDmgLvop4jvvJpjb2Nvc19kZXNjcmliZV9hcGkoe2NvbnRleHQ6XCJlZGl0b3JcIn0pJyxcbiAgICAgICAgXCItIOWIl+i1hOa6kO+8mmNvY29zX2V4ZWN1dGVfY29kZSh7Y29kZTpcXFwicmV0dXJuIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsJ3F1ZXJ5LWFzc2V0cycse3BhdHRlcm46J2RiOi8vYXNzZXRzLyoqLyoucHJlZmFiJ30pKS5zbGljZSgwLDIwKS5tYXAoYT0+YS51cmwpXFxcIn0pXCIsXG4gICAgKTtcblxuICAgIC8qKlxuICAgICAqIOKaoCAqKmBva2Ag55qE6K+t5LmJ77ya6L+Z5Liq5bel5YW344CM6LeR5oiQ5Yqf5LqG5rKh5pyJ44CN77yM5LiN5piv44CM5q+P5LiA6aG56YO95ou/5Yiw5LqG5rKh5pyJ44CNKirjgIJcbiAgICAgKlxuICAgICAqIOi4qei/h+eahOWdke+8iOS7o+S7tyA1OSDliIbpkp/nmoTmjpLmn6XkvJror53vvInvvJrljp/mnaXlhpnnmoTmmK8gYG9rOiBwcm9ibGVtcy5sZW5ndGggPT09IDBgIOKAlOKAlCDkuo7mmK9cbiAgICAgKiDjgIzlm5vpobnmjqLpkojkuInpobnmiJDlip/jgIHlj6rmnInlnLrmma/kuIDpobnlpLHotKXjgI3kuZ/kvJrlm54gYG9rOiBmYWxzZWDvvIzogIzmoaXmjqXkvqdcbiAgICAgKiDvvIhgZHNoLXByb2ZpbGUvcGx1Z2luL2RzaC1jb2Nvcy1icmlkZ2UvaW5kZXguanNg77yJ6KeBIGBvazpmYWxzZWAg5bCxIHJlamVjdO+8jFxuICAgICAqIOaKiuaVtOauteS6uuivneaWh+ahiOW9k+aIkCBgRXJyb3I6YCDmipvliLDnlKjmiLfpnaLliY3jgILnlKjmiLfnnIvliLDnmoTmmK/jgIzkuIDkuKroh6rmo4Dlt6XlhbfmiqXplJnkuobjgI3vvIxcbiAgICAgKiDkuo7mmK/lvIDkuobkuIDmnaHkvJror53ljrvmn6XjgIzmj5Lku7bmmK/kuI3mmK/lnY/kuobjgI3igJTigJQg55yf55u45Y+q5piv6YKj5Liq5omp5bGV6KKr56aB55So5LqG44CCXG4gICAgICpcbiAgICAgKiDnjrDlnKjnmoTlj6PlvoTvvJoqKuWPquimgeaLv+WIsOS7u+S9leS4gOWdl+acieaViOS/oeaBr+Wwseeul+aIkOWKnyoq77yI5bm26ZmEIGBkYXRhLnByb2JsZW1zYCDkuI4gYGRhdGEuZGVncmFkZWRg77yJ77yMXG4gICAgICog5Y+q5pyJ44CM5LuA5LmI6YO95rKh5ou/5Yiw44CN5omN566X5aSx6LSl44CC5LiK6Z2i5rOo6YeK6YeM5pys5p2l5YaZ55qE5bCx5piv44CM5Lu75L2V5LiA5Z2X5ou/5LiN5Yiw6YO95LiN6Zi75pat5pW05L2T44CN77yMXG4gICAgICog5LmL5YmN5pivIGBva2Ag55qE566X5rOV5LiO6L+Z5Y+l6K+d6Ieq55u455+b55u+44CCXG4gICAgICovXG4gICAgY29uc3QgZ290QW55dGhpbmcgPVxuICAgICAgICBCb29sZWFuKGRhdGEucHJvamVjdFBhdGgpIHx8IEJvb2xlYW4oZGF0YS5lZGl0b3JWZXJzaW9uKSB8fCBCb29sZWFuKGRhdGEuc2NlbmUpIHx8IEJvb2xlYW4oZGF0YS5zZWxlY3Rpb24pO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGdvdEFueXRoaW5nLFxuICAgICAgICB0ZXh0OiBsaW5lcy5qb2luKCdcXG4nKSxcbiAgICAgICAgZGF0YTogeyAuLi5kYXRhLCBwcm9ibGVtcywgZGVncmFkZWQ6IHByb2JsZW1zLmxlbmd0aCA+IDAgfSxcbiAgICB9O1xufVxuXG4vKipcbiAqIOe7meWbnuaJp+ihpeS4gOautSBgcmVmc2DvvIjlj6/lpI3nlKjnmoTmoIfor4bvvInigJTigJQg5q+P5Liq5pa55rOV6YO96L+H6L+Z5LiA6YGT44CCXG4gKlxuICog5Lik5p2h5Y+j5b6E77yaXG4gKlxuICogMS4gKirlj6rlnKjmir3liLDkuJzopb/ml7bliqjlm57miacqKu+8muS4gOadoemDveayoeacieWwseWOn+agt+i/lOWbnu+8jOe7neS4jeeVmeS4i+epuuWjs+Wtl+auteOAglxuICogMi4gKirmir3lj5blpLHotKXkuI3nrpflpLHotKUqKu+8mmByZWZzYCDmmK/pmYTliqDkv6Hmga/vvIzlroPoh6rlt7HmipvplJnnu53kuI3og73miorkuIDmrKHmiJDlip/nmoTosIPnlKjlj5jmiJDlpLHotKVcbiAqICAgIO+8iOaJgOS7peWMheWcqCB0cnkg6YeM77yM6Z2Z6buY5pS+6L+H77yJ44CCXG4gKlxuICog5paH5qGI6L+95Yqg5ZyoIGB0ZXh0YCDnu5PlsL7vvIjmqKHlnovlj6ror7sgYHRleHRgIOKAlOKAlCDmoaXmjqXkvqcgYE9VVFBVVC5yZW5kZXJgIOWPqua4suafk+Wug++8ie+8m1xuICog57uT5p6E5YyW54mI5pys5pS+IGBkYXRhLnJlZnNg77yI6Z2i5p2/5LiO55WZ5qGj55So77yJ44CCXG4gKlxuICogQHBhcmFtIGhhbmRsZXIgLSDljp/mnaXnmoTmlrnms5Xlrp7njrDjgIJcbiAqIEByZXR1cm5zIOWMheS6huS4gOWxgueahOaWueazleWunueOsOOAglxuICovXG5mdW5jdGlvbiB3aXRoUmVmcyhcbiAgICBoYW5kbGVyOiAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTxUb29sUmVwbHk+LFxuKTogKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgcmV0dXJuIGFzeW5jIChwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+ID0+IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBoYW5kbGVyKHBhcmFtcyk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjb2xsZWN0aW9uID0gY29sbGVjdFJlZnMocmVwbHkuZGF0YSA/PyByZXBseS50ZXh0KTtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gZm9ybWF0UmVmcyhjb2xsZWN0aW9uKTtcbiAgICAgICAgICAgIGlmICghYmxvY2spIHJldHVybiByZXBseTtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSByZXBseS5kYXRhO1xuICAgICAgICAgICAgcmVwbHkuZGF0YSA9XG4gICAgICAgICAgICAgICAgZGF0YSAmJiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoZGF0YSlcbiAgICAgICAgICAgICAgICAgICAgPyB7IC4uLihkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSwgcmVmczogY29sbGVjdGlvbi5yZWZzIH1cbiAgICAgICAgICAgICAgICAgICAgOiB7IHJlc3VsdDogZGF0YSwgcmVmczogY29sbGVjdGlvbi5yZWZzIH07XG4gICAgICAgICAgICByZXBseS50ZXh0ID0gYCR7cmVwbHkudGV4dH0ke2Jsb2NrfWA7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogcmVmcyDmmK/pmYTliqDkv6Hmga/vvJrmir3kuI3lh7rmnaXlsLHkuI3liqDvvIzkuI3lvbHlk43ov5nmrKHosIPnlKggKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVwbHk7XG4gICAgfTtcbn1cblxuLyoqXG4gKiBJUEMg5pa55rOV5YiG5Y+R6KGo44CCXG4gKlxuICog4pqgIOmUruWQjeW/hemhu+S4jiBEU0gg5L6n5o+S5Lu26YeMIGBpcGNDYWxsKCcuLi4nKWAg55qE5a2X56ym5Liy5LiA6Ie0XG4gKiDvvIjop4EgYGRzaC1wcm9maWxlL3BsdWdpbi9kc2gtY29jb3MtYnJpZGdlL2luZGV4LmpzYO+8ieOAglxuICovXG5leHBvcnQgY29uc3QgQ09DT1NfSVBDX01FVEhPRFM6IFJlY29yZDxzdHJpbmcsIChwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPFRvb2xSZXBseT4+ID0ge1xuICAgIGV4ZWN1dGVfY29kZTogd2l0aFJlZnMocnVuRXhlY3V0ZUNvZGUpLFxuICAgIGRlc2NyaWJlX2FwaTogd2l0aFJlZnMoZGVzY3JpYmVBcGkpLFxuICAgIGVkaXRvcl9zdGF0ZTogd2l0aFJlZnMocmVhZEVkaXRvclN0YXRlKSxcbiAgICBjYXB0dXJlX3ZpZXc6IHdpdGhSZWZzKHJ1bkNhcHR1cmVWaWV3KSxcbiAgICByZWFkX2xvZ3M6IHdpdGhSZWZzKHJlYWRMb2dzKSxcbn07XG4iXX0=