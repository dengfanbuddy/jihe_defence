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
 * ## 七个方法，其中几个是「别猜 / 别瞎试」的护栏
 *
 * IPC 协议要窄。语义方法越少，DSH 侧插件的参数校验与这里的实现越不容易错位。
 * 需要新能力时优先扩 `execute_code` 的用法（它就是通用逃生口），而不是加新方法。
 *
 * | 方法 | 角色 |
 * |---|---|
 * | `execute_code` | 通用逃生口。写代码，一次执行里完成「取数据 → 改状态 → 返回结论」 |
 * | `describe_api` | **渐进式披露** —— 别猜引擎/编辑器 API，按需查一个命名空间或一个类 |
 * | `editor_state` | 按需自检：我在哪个工程/场景、选中了什么、沙箱能不能动 |
 * | `capture_view` | **例外一**：把场景视图（或某个节点）存成图片文件、回路径。像素塞不进返回值上限，只能单独开一条通道。默认会**先取景再截**（`fit`），因为屏幕上那一帧未必是全景；`view` 说明"我要的是编辑器场景还是跑着的游戏" |
 * | `read_logs` | **例外二**：读工程里的日志文件。控制台/日志文件里的字**代码拿不到**（那是另一个进程的输出），只能单独开一条通道。实现在 `logs.ts` |
 * | `click_node` | **例外三**：点下去。`sendInputEvent` 发的是**真事件**（走 Chromium 自己的输入管线），改不了状态的那种"调一下回调"不算数。实现在 `input.ts` |
 * | `send_keys` | 同上，键盘那一半（快捷键 / 输入文字） |
 *
 * ⛔ **原来还有第八个 `runtime`（运行预览的只读状态探针），2026-10-09 整条删掉了。**
 * 它的前身是五个开关（`play` / `stop` / `pause` / `resume` / `step`，2026-10-08 撤掉，理由见
 * `docs/冻结诊断.md`）；撤到最后发现**只读那一格也没有消费者**：运行态的判据早就在
 * **截图与点击链路里**（场景脚本的 `viewMetrics.runtime` → `capture_view` 的 `mode` /
 * `click_node` 的运行态拒绝），而它本身只回答"现在是不是运行态"这一句 ——
 * 要看画面直接截图就够，多一个工具只是多一处要维护的说明。
 * 谁想把它加回来：先读 `docs/冻结诊断.md`，并且**永远不要**加"能开预览"的入口。
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
exports.runClickNode = runClickNode;
exports.runSendKeys = runSendKeys;
const constants_1 = require("./constants");
const engine_1 = require("./core/engine");
const serialize_1 = require("./core/serialize");
const input_1 = require("./input");
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
    "- **先找可复用配方**：cocos_execute_code({context:'editor', code:\"return findRecipes()\"}) —— 做 UI/预制件/批量改节点这类活之前先看有没有跑通过的代码", "- 场景树骨架：cocos_execute_code({context:'scene', code:'return tree({maxDepth:2, withComponents:true})'})", "- 组件有哪些属性：cocos_describe_api({context:'scene', target:'cc.Camera', nodeUuid:'<上面查到的 uuid>'})", '- 编辑器 API 总览：cocos_describe_api({context:"editor"})', "- 列资源：cocos_execute_code({code:\"return (await Editor.Message.request('asset-db','query-assets',{pattern:'db://assets/**/*.prefab'})).slice(0,20).map(a=>a.url)\"})", 
    /**
     * 界面交互（点按 / 按键）是两条**独立通道**，不在 `execute_code` 的射程里 ——
     * 这里必须点一次名：模型在"改完 UI 想验一下"时最容易只想到截图与读节点数据。
     */
    "- **点一下试试**：cocos_click_node({node:'<节点路径>'})（真鼠标事件；运行态下要改用坐标，见该工具说明）", 
    /**
     * ⚠ 开场景这条**必须点出来**：真机实测 2026-11 —— `open-scene` 传 `db://` 路径
     * **不是"打开那个场景"**，而是开出一个**新的未命名 2D 场景**（根 uuid 每次都不同、
     * 磁盘上文件没变），而且**不报错**，接着往下做就会在空场景里改东西。
     * 传资源 **uuid** 才是开它。详见 skill 的「坑 15」。
     */
    "- 要开别的场景：open-scene 给**资源 uuid**（`ba018ca9-…` 这种），**别给 `db://` 路径** —— 实测给路径会开出**一个新的空场景**且不报错（skill 坑 15）");
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
 * 点一个节点 / 一个坐标 —— **真事件**（`webContents.sendInputEvent`，见 `source/input.ts`）。
 *
 * ## 为什么这是"让 agent 自己验收界面"的那一件
 *
 * 改完 UI 能截图看，但"这个按钮点下去有没有反应"以前只能请人去点。这里把
 * 一次真实的鼠标按下/抬起发给那一页，按钮的回调、列表的选中、拖拽，全都照常触发。
 *
 * ## 两种给点法（**先说清各自成立的条件**）
 *
 * | 给法 | 投影 | 什么时候能信 |
 * |---|---|---|
 * | `node`（uuid 或路径） | 场景脚本按**编辑器相机**把节点世界矩形投到页面 CSS 像素 | **编辑态**（编辑器正在显示场景）—— 那时画面就是编辑器相机画的 |
 * | `x` / `y`（`space:"view"` 页面 CSS 像素，或 `"uv"` 0~1） | 不投影，直接用 | **任何状态**：运行态（game view）下画面是游戏相机画的，节点投影不成立，这时只能用坐标 |
 *
 * ⚠ **运行态下给 `node` 会被拒**（不是"算不准"，是**那一刻它压根不成立**：
 * 运行态由游戏自己的相机渲染，编辑器相机被藏起来了）。这不是缺陷，是如实拒绝 ——
 * 按错的投影点下去，比点不动更坏（它会点到别的东西上，而回执看着像成功了）。
 *
 * ## 「我点到底点到哪了」的两条自检（都不是判"对错"，是给事实）
 *
 * 1. `probe`（默认 true，只在编辑态给 `node` 时有意义）：点之前问一次场景脚本的
 *    `pick(x, y)` —— 编辑器自己的命中测试认为**这个点是哪个节点**，原样附上。
 *    它与 `node` 不一致就说明投影或节点选错了。
 * 2. **点前后各截一张图对比**（`cocos_capture_view`）—— 这是唯一能证明
 *    "Chromium 真的把那一下送到了"的办法；`probe` 只能证明"我们算的坐标在页面上是对的"。
 *
 * @param params - `{node?, x?, y?, space?, button?, clickCount?, modifiers?, probe?, pressMs?, timeoutMs?}`。
 * @returns 回执里带**真发出去的那几条事件**（类型/坐标/按键/修饰键）与打到哪一页。
 */
async function runClickNode(params) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const nodeRef = typeof params.node === 'string' ? params.node.trim() : '';
    const hasPoint = typeof params.x === 'number' || typeof params.y === 'number';
    if (nodeRef && hasPoint) {
        return clickFail('`node` 与 `x`/`y` 只能给一个：前者按节点投影算点，后者直接用你给的坐标。');
    }
    if (!nodeRef && !hasPoint) {
        return clickFail('要给 `node`（节点 uuid 或路径）或 `x`/`y`（坐标）中的一个。');
    }
    const space = params.space === undefined ? 'view' : String(params.space);
    if (space !== 'view' && space !== 'uv') {
        return clickFail(`space 只认 "view"（页面 CSS 像素，默认）与 "uv"（0~1 的比例），收到 ${JSON.stringify(params.space)}。`);
    }
    if (!nodeRef && space === 'view') {
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return clickFail(`space:"view" 要 x 与 y 都是有限数，收到 ${JSON.stringify(params.x)} / ${JSON.stringify(params.y)}。`);
        }
    }
    // ---- ① 问几何（节点矩形 / 页面尺寸 / 现在是不是运行态）----
    const geometry = await (0, engine_1.readNodeGeometry)(nodeRef);
    if (geometry.ok !== true) {
        return clickFail(`拿不到页面几何：${describe(geometry.error)}。${SCENE_SCRIPT_HINT}`);
    }
    const page = (geometry.page || {});
    const runtime = (geometry.runtime || {});
    const running = runtime.running === true;
    const href = typeof page.href === 'string' ? page.href : '';
    const nodeInfo = (geometry.node || null);
    // ---- ② 算出那个点（页面 CSS 像素）----
    let px = 0;
    let py = 0;
    let how = '';
    if (nodeRef) {
        if (running) {
            return clickFail(`现在是**运行态**（编辑器内预览跑着游戏），按节点投影点不了：那一刻画面由**游戏自己的相机**渲染，` +
                '而节点矩形是用**编辑器相机**投出来的 —— 两者不是同一个取景，按它点会点到别的地方去。\n' +
                '两条可用路：① 请**人在编辑器工具栏上按停止**，回到编辑态再点（适合点 UI 的静态布局）；' +
                '② 直接用坐标：先 `cocos_capture_view({view:"game"})` 看清画面，再用 `cocos_click_node({x, y, space:"uv"})`。', { mode: { actual: (_a = runtime.mode) !== null && _a !== void 0 ? _a : 'unknown', running: true, sources: (_b = runtime.sources) !== null && _b !== void 0 ? _b : null } });
        }
        if (!nodeInfo || nodeInfo.found !== true) {
            return clickFail(`没找到节点「${nodeRef}」${nodeInfo && nodeInfo.note ? `（${nodeInfo.note}）` : ''}（uuid 用 node.uuid，路径形如 Canvas/panel/btn）。`, { mode: { actual: (_c = runtime.mode) !== null && _c !== void 0 ? _c : 'unknown', running: false, sources: (_d = runtime.sources) !== null && _d !== void 0 ? _d : null } });
        }
        if (!nodeInfo.rect) {
            return clickFail(`节点「${nodeInfo.name || nodeRef}」算不出在页面上的矩形${nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 点不了中心。`, { node: nodeInfo });
        }
        const rect = nodeInfo.rect;
        px = rect.x + rect.width / 2;
        py = rect.y + rect.height / 2;
        how = `节点矩形中心（rect ${rect.x},${rect.y} ${rect.width}×${rect.height}）`;
    }
    else if (space === 'uv') {
        const ux = Number(params.x);
        const uy = Number(params.y);
        if (!Number.isFinite(ux) || !Number.isFinite(uy)) {
            return clickFail(`space:"uv" 要 x 与 y 都是 0~1 的有限数，收到 ${JSON.stringify(params.x)} / ${JSON.stringify(params.y)}。`);
        }
        const cssWidth = typeof page.cssWidth === 'number' ? page.cssWidth : 0;
        const cssHeight = typeof page.cssHeight === 'number' ? page.cssHeight : 0;
        if (!cssWidth || !cssHeight) {
            return clickFail('space:"uv" 要按页面尺寸折算，但场景脚本没量到页面宽高 —— 改用 space:"view" 自己乘。');
        }
        px = ux * cssWidth;
        py = uy * cssHeight;
        how = `uv(${ux}, ${uy}) × 页面 ${cssWidth}×${cssHeight}`;
    }
    else {
        px = Number(params.x);
        py = Number(params.y);
        how = '直接给的页面 CSS 像素坐标';
    }
    // ---- ③ probe：点之前问一次「编辑器认为这个点上是哪个节点」（只在编辑态成立）----
    let probe = null;
    /**
     * 只要算出了一个点就探一次（**不只是给 `node` 时**）：坐标是调用方给的，同样值得知道
     * "编辑器自己的命中测试认为那儿是什么" —— 它与调用方的预期不一致时，这一步就省掉了一轮瞎试。
     * `probe:false` 可以关掉。
     */
    const wantProbe = params.probe !== false;
    if (wantProbe) {
        probe = running
            ? {
                skipped: '运行态下不做命中探测：`pick` 用的也是编辑器相机（与节点投影同一个取景），那一刻同样不成立',
            }
            : await probePoint(px, py);
    }
    // ---- ④ 真发出去 ----
    const outcome = await (0, input_1.clickAt)(px, py, {
        button: params.button === undefined ? undefined : String(params.button),
        clickCount: typeof params.clickCount === 'number' ? params.clickCount : undefined,
        modifiers: Array.isArray(params.modifiers) ? params.modifiers : undefined,
        pressMs: typeof params.pressMs === 'number' ? params.pressMs : undefined,
        focusWindow: params.focusWindow === false ? false : undefined,
    }, href);
    const payload = {
        ok: outcome.ok,
        point: { x: Math.round(px), y: Math.round(py), space: 'view', how },
        mode: { actual: (_e = runtime.mode) !== null && _e !== void 0 ? _e : 'unknown', running, sources: (_f = runtime.sources) !== null && _f !== void 0 ? _f : null },
        target: (_g = outcome.target) !== null && _g !== void 0 ? _g : null,
        matchedBy: (_h = outcome.matchedBy) !== null && _h !== void 0 ? _h : null,
        focused: (_j = outcome.focused) !== null && _j !== void 0 ? _j : null,
        window: (_k = outcome.window) !== null && _k !== void 0 ? _k : null,
        events: outcome.events,
        probe,
    };
    if (!outcome.ok) {
        payload.error = outcome.error;
        if (outcome.contents)
            payload.contents = outcome.contents;
        payload.hint = '打不到那一页时先 `cocos_execute_code({context:"scene", code:"return 1"})` 确认场景进程可用（没开场景时场景视图网页也不在）。';
        return { ok: false, text: JSON.stringify(payload, null, 2), error: String(outcome.error || '点击失败'), data: payload };
    }
    /**
     * ⚠ 窗口没焦点时**必须把这句话放在最前面**：那时"事件发出去了"与"页面收到了"是两件事，
     * 而回执默认看着像成功（就是本工程最防的那种假绿）。
     */
    if (outcome.window && outcome.window.focused === false) {
        payload.hint = outcome.window.note;
    }
    else if (probe && !probe.skipped && probe.verdict === 'hit') {
        payload.hint =
            '这一下真发出去了（窗口焦点没问题）。**要证明点对了，点前后各截一张图对比**（`probe` 只能证明"这个坐标在页面上是它"，证明不了"Chromium 把它送到了"）。';
    }
    else {
        payload.hint = '这一下真发出去了。点前后各截一张图对比才知道有没有生效。';
    }
    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
}
/** 点节点失败时的统一回执（不抛，让模型看到可读的原因）。 */
function clickFail(message, extra) {
    const payload = { ok: false, error: message, ...(extra !== null && extra !== void 0 ? extra : {}) };
    return { ok: false, text: JSON.stringify(payload, null, 2), error: message, data: payload };
}
/**
 * 问一次「这个点是哪个节点」—— 走场景沙箱里的 `pick(x, y)`（编辑器自己的命中测试）。
 *
 * ⚠ 它是**事实**，不是判据：回执把 `verdict` / `hit` / 命中个数原样带回来，
 * 由调用方决定"这算不算点对了"（本扩展不认识"该点到哪个节点"）。
 */
async function probePoint(x, y) {
    try {
        const reply = await (0, engine_1.executeCode)({
            context: 'scene',
            timeoutMs: 8000,
            code: 'const r = pick(args.x, args.y); return { verdict: r.verdict, hit: r.hit, hitCount: (r.hits || []).length, invisibleCount: (r.invisible || []).length };',
            args: { x, y },
        });
        const value = unwrapSandboxResult(reply.data);
        if (!reply.ok || !value)
            return { error: reply.text.slice(0, 300) };
        return value;
    }
    catch (error) {
        return { error: describe(error) };
    }
}
/**
 * 发一次键盘动作（**真事件**），等价于在那一页上真的按了几下键。
 *
 * `key` 走按下/抬起（快捷键、方向键、Esc 这类"按一下"的动作）；
 * `text` 走 `char`（真的往聚焦的输入框里打字）。两者可以一起给（例如 `{key:'Enter'}`）。
 *
 * ⚠ **本工具不抢焦点**（`webContents.focus()` 会打断用户正在别处打字）：
 * 回执里的 `focused` 是**如实报出**目标页当时有没有键盘焦点。要往输入框打字而 `focused` 为 false 时，
 * 先用 `cocos_click_node` 点一下那个输入框（真点击会把焦点带过去）再发字。
 *
 * @param params - `{key?, text?, modifiers?, pressMs?, target?}`。
 */
async function runSendKeys(params) {
    var _a, _b, _c, _d;
    const key = typeof params.key === 'string' ? params.key.trim() : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!key && !text)
        return clickFail('要给 `key`（按一下某个键）或 `text`（输入一段字）中的至少一个。');
    /** 目标页的 href：场景脚本报的最确定；拿不到就退回按 URL 特征找（`findSceneView` 的兜底） */
    const geometry = await (0, engine_1.readNodeGeometry)('');
    const href = geometry.ok === true && typeof (geometry.page || {}).href === 'string' ? geometry.page.href : '';
    const outcome = await (0, input_1.sendKeys)({
        key,
        text,
        modifiers: Array.isArray(params.modifiers) ? params.modifiers : undefined,
        pressMs: typeof params.pressMs === 'number' ? params.pressMs : undefined,
        focusWindow: params.focusWindow === false ? false : undefined,
    }, href);
    const payload = {
        ok: outcome.ok,
        key: key || null,
        text: text || null,
        target: (_a = outcome.target) !== null && _a !== void 0 ? _a : null,
        matchedBy: (_b = outcome.matchedBy) !== null && _b !== void 0 ? _b : null,
        focused: (_c = outcome.focused) !== null && _c !== void 0 ? _c : null,
        window: (_d = outcome.window) !== null && _d !== void 0 ? _d : null,
        events: outcome.events,
        hrefSource: href ? '场景脚本报的 location.href' : '没量到 href，按 URL 特征找的',
    };
    if (!outcome.ok) {
        payload.error = outcome.error;
        if (outcome.contents)
            payload.contents = outcome.contents;
        return { ok: false, text: JSON.stringify(payload, null, 2), error: String(outcome.error || '发按键失败'), data: payload };
    }
    if (outcome.window && outcome.window.focused === false) {
        payload.hint = outcome.window.note;
    }
    else if (outcome.focused === false) {
        payload.hint = '目标页当时**没有**键盘焦点 —— 打字类（text）多半不会进输入框；先用 cocos_click_node 点一下那个输入框再来。';
    }
    else {
        payload.hint = '按键发出去了；点前后各截一张图（或再读一次状态）才知道有没有生效。';
    }
    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
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
 * IPC 方法分发表 —— **七个**。
 *
 * ⚠ 键名必须与 DSH 侧插件里 `ipcCall('...')` 的字符串一致
 * （见 `dsh-profile/plugin/dsh-cocos-bridge/index.js`）。
 *
 * ⛔ 原来那张表里有第八个键 `runtime`（运行预览的只读状态探针），**2026-10-09 删掉**：
 * 它的前身是五个开关（2026-10-08 撤掉），撤到只剩只读之后仍然**没有任何消费者** ——
 * 运行态判据在截图/点击链路里，不在这个工具里（理由见文件头的表下面那一段）。
 */
exports.COCOS_IPC_METHODS = {
    execute_code: withRefs(runExecuteCode),
    describe_api: withRefs(describeApi),
    editor_state: withRefs(readEditorState),
    capture_view: withRefs(runCaptureView),
    read_logs: withRefs(logs_1.readLogs),
    click_node: withRefs(runClickNode),
    send_keys: withRefs(runSendKeys),
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29jb3MtdG9vbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvY29jb3MtdG9vbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBMERHOzs7QUFnREgsd0NBRUM7QUFvQkQsd0NBRUM7QUFZRCxrQ0FrQkM7QUF1SkQsMENBMkhDO0FBZ0NELG9DQWdKQztBQTBDRCxrQ0E0Q0M7QUE1bkJELDJDQUE2RDtBQUM3RCwwQ0FNdUI7QUFDdkIsZ0RBQTJEO0FBQzNELG1DQUE0QztBQUM1QyxpQ0FBa0M7QUFJbEMsbUJBQW1CO0FBQ25CLFNBQVMsUUFBUSxDQUFDLEtBQWM7SUFDNUIsT0FBTyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDbEUsQ0FBQztBQUVEOzs7Ozs7Ozs7R0FTRztBQUNILFNBQVMsbUJBQW1CLENBQUMsVUFBbUI7SUFDNUMsSUFBSSxDQUFDLFVBQVUsSUFBSSxPQUFPLFVBQVUsS0FBSyxRQUFRO1FBQUUsT0FBTyxVQUFVLENBQUM7SUFDckUsTUFBTSxRQUFRLEdBQUcsVUFBa0MsQ0FBQztJQUNwRCxPQUFPLFFBQVEsSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQztBQUMvRCxDQUFDO0FBRUQsb0NBQW9DO0FBQ3BDLE1BQU0saUJBQWlCLEdBQ25CLHVDQUF1QztJQUN2QyxnREFBZ0QsQ0FBQztBQUVyRDs7Ozs7R0FLRztBQUNJLEtBQUssVUFBVSxjQUFjLENBQUMsTUFBK0I7SUFDaEUsT0FBTyxJQUFBLG9CQUFXLEVBQUMsTUFBTSxDQUFDLENBQUM7QUFDL0IsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7Ozs7OztHQWlCRztBQUNJ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Q0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2xELEtBQUssQ0FBQyxJQUFJLEdBQUcsR0FBRyxLQUFLLENBQUMsSUFBSSxHQUFHLEtBQUssRUFBRSxDQUFDO1FBQ3pDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxnQ0FBZ0M7UUFDcEMsQ0FBQztRQUNELE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUMsQ0FBQztBQUNOLENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDVSxRQUFBLGlCQUFpQixHQUE0RTtJQUN0RyxZQUFZLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQztJQUN0QyxZQUFZLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQztJQUNuQyxZQUFZLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQztJQUN2QyxZQUFZLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQztJQUN0QyxTQUFTLEVBQUUsUUFBUSxDQUFDLGVBQVEsQ0FBQztJQUM3QixVQUFVLEVBQUUsUUFBUSxDQUFDLFlBQVksQ0FBQztJQUNsQyxTQUFTLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQztDQUNuQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXHJcbiAqIERTSCDnmoTljp/nlJ/lt6XlhbfmgI7kuYjokL3liLDnvJbovpHlmajkuIog4oCU4oCUIOS5n+WwseaYryBJUEMg6K+35rGC55qE5pyN5Yqh56uv5a6e546w44CCXHJcbiAqXHJcbiAqICMjIOW8leaTjuWcqOWTqu+8muacrOaJqeWxleiHquW4pu+8jOS4jeS+nei1luWIq+eahOaJqeWxlVxyXG4gKlxyXG4gKiDmiafooYzog73lipvvvIjnvJbovpHlmagv5Zy65pmv5Luj56CB5rKZ566x44CB6LaF5pe244CB5pel5b+X5pS26ZuG44CB5bqP5YiX5YyW5LiK6ZmQ44CBZ2l6bW8g5rGh5p+T6L+H5ruk44CB5pKk6ZSA5b+r54Wn44CBXHJcbiAqIHJlY2lwZSDkupTku7blpZfvvInlhajpg6jlnKgqKuacrOaJqeWxleiHquW3sSoq55qEIGBjb3JlL2VuZ2luZS50c2AgKyBgc291cmNlL3NjZW5lLnRzYCDph4zvvIxcclxuICog6LWw57yW6L6R5ZmoKirlhoXpg6gqKueahOmAmumBk++8jOS4jee7j+i/hyBsb29wYmFjayBIVFRQ77yaXHJcbiAqXHJcbiAqIGBgYFxyXG4gKiBEU0gg5a2Q6L+b56iLIC0tZm9yayBJUEMtLT4g5pys5omp5bGV5Li76L+b56iLKOacrOaWh+S7tikgLS1jb3JlL2VuZ2luZS0tPiB2bSDmspnnrrHvvIhlZGl0b3Ig5LiK5LiL5paH77yJXHJcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlC0tPiDmnKzmianlsZXlnLrmma/ohJrmnKzvvIhzY2VuZSDkuIrkuIvmlofvvIlcclxuICogYGBgXHJcbiAqXHJcbiAqIOWcuuaZr+iEmuacrOeUsSBgcGFja2FnZS5qc29uYCDnmoQgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOazqOWGjO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxyXG4gKiDnvJbovpHlmajlnKgqKuaJk+W8gOWcuuaZryoq5pe25oqK5a6D5Yqg6L296L+b5byV5pOO6L+b56iLIOKAlOKAlCDmiYDku6XjgIzmsqHmiZPlvIDlnLrmma/jgI3mmK/llK/kuIDkuIDkuKpcclxuICog6ZyA6KaB5ZCR5qih5Z6L6Kej6YeK5riF5qWa55qE5aSx6LSl5qih5byP77yI6KeBIGBTQ0VORV9TQ1JJUFRfSElOVGDvvInjgIJcclxuICpcclxuICogIyMg5LiD5Liq5pa55rOV77yM5YW25Lit5Yeg5Liq5piv44CM5Yir54ycIC8g5Yir556O6K+V44CN55qE5oqk5qCPXHJcbiAqXHJcbiAqIElQQyDljY/orq7opoHnqoTjgILor63kuYnmlrnms5XotorlsJHvvIxEU0gg5L6n5o+S5Lu255qE5Y+C5pWw5qCh6aqM5LiO6L+Z6YeM55qE5a6e546w6LaK5LiN5a655piT6ZSZ5L2N44CCXHJcbiAqIOmcgOimgeaWsOiDveWKm+aXtuS8mOWFiOaJqSBgZXhlY3V0ZV9jb2RlYCDnmoTnlKjms5XvvIjlroPlsLHmmK/pgJrnlKjpgIPnlJ/lj6PvvInvvIzogIzkuI3mmK/liqDmlrDmlrnms5XjgIJcclxuICpcclxuICogfCDmlrnms5UgfCDop5LoibIgfFxyXG4gKiB8LS0tfC0tLXxcclxuICogfCBgZXhlY3V0ZV9jb2RlYCB8IOmAmueUqOmAg+eUn+WPo+OAguWGmeS7o+egge+8jOS4gOasoeaJp+ihjOmHjOWujOaIkOOAjOWPluaVsOaNriDihpIg5pS554q25oCBIOKGkiDov5Tlm57nu5PorrrjgI0gfFxyXG4gKiB8IGBkZXNjcmliZV9hcGlgIHwgKirmuJDov5vlvI/miqvpnLIqKiDigJTigJQg5Yir54yc5byV5pOOL+e8lui+keWZqCBBUEnvvIzmjInpnIDmn6XkuIDkuKrlkb3lkI3nqbrpl7TmiJbkuIDkuKrnsbsgfFxyXG4gKiB8IGBlZGl0b3Jfc3RhdGVgIHwg5oyJ6ZyA6Ieq5qOA77ya5oiR5Zyo5ZOq5Liq5bel56iLL+WcuuaZr+OAgemAieS4reS6huS7gOS5iOOAgeaymeeuseiDveS4jeiDveWKqCB8XHJcbiAqIHwgYGNhcHR1cmVfdmlld2AgfCAqKuS+i+WkluS4gCoq77ya5oqK5Zy65pmv6KeG5Zu+77yI5oiW5p+Q5Liq6IqC54K577yJ5a2Y5oiQ5Zu+54mH5paH5Lu244CB5Zue6Lev5b6E44CC5YOP57Sg5aGe5LiN6L+b6L+U5Zue5YC85LiK6ZmQ77yM5Y+q6IO95Y2V54us5byA5LiA5p2h6YCa6YGT44CC6buY6K6k5LyaKirlhYjlj5bmma/lho3miKoqKu+8iGBmaXRg77yJ77yM5Zug5Li65bGP5bmV5LiK6YKj5LiA5bin5pyq5b+F5piv5YWo5pmv77ybYHZpZXdgIOivtOaYjlwi5oiR6KaB55qE5piv57yW6L6R5Zmo5Zy65pmv6L+Y5piv6LeR552A55qE5ri45oiPXCIgfFxyXG4gKiB8IGByZWFkX2xvZ3NgIHwgKirkvovlpJbkuowqKu+8muivu+W3peeoi+mHjOeahOaXpeW/l+aWh+S7tuOAguaOp+WItuWPsC/ml6Xlv5fmlofku7bph4znmoTlrZcqKuS7o+eggeaLv+S4jeWIsCoq77yI6YKj5piv5Y+m5LiA5Liq6L+b56iL55qE6L6T5Ye677yJ77yM5Y+q6IO95Y2V54us5byA5LiA5p2h6YCa6YGT44CC5a6e546w5ZyoIGBsb2dzLnRzYCB8XHJcbiAqIHwgYGNsaWNrX25vZGVgIHwgKirkvovlpJbkuIkqKu+8mueCueS4i+WOu+OAgmBzZW5kSW5wdXRFdmVudGAg5Y+R55qE5pivKirnnJ/kuovku7YqKu+8iOi1sCBDaHJvbWl1bSDoh6rlt7HnmoTovpPlhaXnrqHnur/vvInvvIzmlLnkuI3kuobnirbmgIHnmoTpgqPnp41cIuiwg+S4gOS4i+Wbnuiwg1wi5LiN566X5pWw44CC5a6e546w5ZyoIGBpbnB1dC50c2AgfFxyXG4gKiB8IGBzZW5kX2tleXNgIHwg5ZCM5LiK77yM6ZSu55uY6YKj5LiA5Y2K77yI5b+r5o236ZSuIC8g6L6T5YWl5paH5a2X77yJIHxcclxuICpcclxuICog4puUICoq5Y6f5p2l6L+Y5pyJ56ys5YWr5LiqIGBydW50aW1lYO+8iOi/kOihjOmihOiniOeahOWPquivu+eKtuaAgeaOoumSiO+8ie+8jDIwMjYtMTAtMDkg5pW05p2h5Yig5o6J5LqG44CCKipcclxuICog5a6D55qE5YmN6Lqr5piv5LqU5Liq5byA5YWz77yIYHBsYXlgIC8gYHN0b3BgIC8gYHBhdXNlYCAvIGByZXN1bWVgIC8gYHN0ZXBg77yMMjAyNi0xMC0wOCDmkqTmjonvvIznkIbnlLHop4FcclxuICogYGRvY3Mv5Ya757uT6K+K5patLm1kYO+8ie+8m+aSpOWIsOacgOWQjuWPkeeOsCoq5Y+q6K+76YKj5LiA5qC85Lmf5rKh5pyJ5raI6LS56ICFKirvvJrov5DooYzmgIHnmoTliKTmja7ml6nlsLHlnKhcclxuICogKirmiKrlm77kuI7ngrnlh7vpk77ot6/ph4wqKu+8iOWcuuaZr+iEmuacrOeahCBgdmlld01ldHJpY3MucnVudGltZWAg4oaSIGBjYXB0dXJlX3ZpZXdgIOeahCBgbW9kZWAgL1xyXG4gKiBgY2xpY2tfbm9kZWAg55qE6L+Q6KGM5oCB5ouS57ud77yJ77yM6ICM5a6D5pys6Lqr5Y+q5Zue562UXCLnjrDlnKjmmK/kuI3mmK/ov5DooYzmgIFcIui/meS4gOWPpSDigJTigJRcclxuICog6KaB55yL55S76Z2i55u05o6l5oiq5Zu+5bCx5aSf77yM5aSa5LiA5Liq5bel5YW35Y+q5piv5aSa5LiA5aSE6KaB57u05oqk55qE6K+05piO44CCXHJcbiAqIOiwgeaDs+aKiuWug+WKoOWbnuadpe+8muWFiOivuyBgZG9jcy/lhrvnu5Por4rmlq0ubWRg77yM5bm25LiUKirmsLjov5zkuI3opoEqKuWKoFwi6IO95byA6aKE6KeIXCLnmoTlhaXlj6PjgIJcclxuICpcclxuICogIyMg5Ye65Y+j57uf5LiA6KGlIGByZWZzYFxyXG4gKlxyXG4gKiDmr4/kuKrmlrnms5XnmoTlm57miafpg73kvJrnu48gYHdpdGhSZWZzYCDov4fkuIDpgZPvvJrmiornu5Pmnpzph4zlh7rnjrDov4fnmoQqKuWFqOW9oiB1dWlkIC8gYGRiOi8vYCDot6/lvoQqKlxyXG4gKiDljrvph43lkI7mjpLov5vmlofmoYjnu5PlsL7vvIjnu5PmnoTljJbniYjmnKzlnKggYGRhdGEucmVmc2DvvInjgILnkIbnlLHmmK/lroPnm7TmjqXnnIHmjonkuIDova7lvoDov5Qg4oCU4oCUXHJcbiAqIOS4jeeEtuaooeWei+imgeS5iOmHjeafpeS4gOasoe+8jOimgeS5iOWHreiusOW/hue8luS4gOS4qu+8iGBTS0lMTC5tZGAg6YeM5LiT6Zeo5YaZ6L+H44CM5Yir54ycIHV1aWTjgI3vvInjgIJcclxuICog6L+Z5LiA5bGCKirlj6rlgZrmkKzov5DvvIzkuI3lgZrliKTmlq0qKu+8muS4jeiupOivhlwi5ZOq5LiqIHV1aWQg5pu06YeN6KaBXCLvvIzkuZ/ku47kuI3mlLnlhpnljp/mnInmlofmoYjjgIJcclxuICpcclxuICogIyMgZGVzY3JpYmVfYXBpIOeahOS4pOS+p+i1sOS6huS4pOadoeS4jeWQjOeahOi3r1xyXG4gKlxyXG4gKiAtICoqZWRpdG9yIOS+pyoq77ya57yW6L6R5Zmo5Li76L+b56iL55qE5Y+N5bCE5rKh5pyJ5a+55aSW5raI5oGv77yM5omA5Lul6L+Z6YeM6Ieq5bex5a6e546w77yI57qv5Y+N5bCE77yM57qmIDkwIOihjO+8ie+8jFxyXG4gKiAgIOS9hiBgaGVscGVyc2Ag5LiA5qGjKirlm57mspnnrrHpl64qKiBgaGVscGVyTmFtZXMoKWAg4oCU4oCUIOWKqeaJi+a4heWNleaYr+aymeeuseiHquW3seeahOS6i+Wunu+8jFxyXG4gKiAgIOaKhOS4gOS7veW/heeEtui/h+acn+OAglxyXG4gKiAtICoqc2NlbmUg5L6nKirvvJrovazlj5Hnu5nmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvIhgZGVzY3JpYmVBcGlg77yJ44CC57G755qE5bGe5oCn5ZCN6KaB5LuOIGBfX3Byb3BzX19gICtcclxuICogICDlrp7ml7blrp7kvovkuIror7vvvIzpgqPpg6jliIbmmK8gYHNjZW5lLnRzYCDph4zmnIDkuI3or6Xph43lhpnnmoTku6PnoIHjgIJcclxuICpcclxuICog4pqgIGBleGVjdXRlLXNjZW5lLXNjcmlwdGAgKirpnIDopoHlnLrmma/ov5vnqIvph4zlt7Lnu4/liqDovb3kuobmnKzmianlsZXohJrmnKwqKu+8iOimgeacieWcuuaZr+aJk+W8gO+8ieOAglxyXG4gKiDmsqHliqDovb3ml7bmipvplJkg4oCU4oCUIOaJgOS7pemCo+S4gOaho+W/hemhu+aKiuWksei0pee/u+ivkeaIkOOAjOWFiOaJk+W8gOS4gOS4quWcuuaZr+OAjeOAglxyXG4gKi9cclxuXHJcbmltcG9ydCB7IEVYVEVOU0lPTl9OQU1FLCB0eXBlIFRvb2xSZXBseSB9IGZyb20gJy4vY29uc3RhbnRzJztcclxuaW1wb3J0IHtcclxuICAgIGNhcHR1cmVWaWV3LFxyXG4gICAgZGVzY3JpYmVTY2VuZUFwaSxcclxuICAgIGV4ZWN1dGVDb2RlLFxyXG4gICAgcGluZ1NjZW5lU2NyaXB0IGFzIHBpbmdTY2VuZSxcclxuICAgIHJlYWROb2RlR2VvbWV0cnksXHJcbn0gZnJvbSAnLi9jb3JlL2VuZ2luZSc7XHJcbmltcG9ydCB7IGNvbGxlY3RSZWZzLCBmb3JtYXRSZWZzIH0gZnJvbSAnLi9jb3JlL3NlcmlhbGl6ZSc7XHJcbmltcG9ydCB7IGNsaWNrQXQsIHNlbmRLZXlzIH0gZnJvbSAnLi9pbnB1dCc7XHJcbmltcG9ydCB7IHJlYWRMb2dzIH0gZnJvbSAnLi9sb2dzJztcclxuXHJcbmV4cG9ydCB0eXBlIHsgVG9vbFJlcGx5IH07XHJcblxyXG4vKiog5oqK5Lu75oSP5byC5bi45pS25pWb5oiQ5LiA5Y+l6K+d44CCICovXHJcbmZ1bmN0aW9uIGRlc2NyaWJlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDliaXmjonmspnnrrHnu5PmnpzlpJbpnaLpgqPlsYLkv6HlsIHjgIJcclxuICpcclxuICogYHN0cnVjdHVyZWRgL2BkYXRhYCDnmoTlvaLnirbmmK8gYHsgb2ssIGNvbnRleHQsIGR1cmF0aW9uTXMsIHJlc3VsdCB9YO+8iGByZXN1bHRgIOaJjeaYryBgcmV0dXJuYCDnmoTlgLzvvInvvIxcclxuICog5L2G6ZSZ6K+v5YiG5pSv6YeM5rKh5pyJIGByZXN1bHRg44CB5Y+q5pyJIGBlcnJvcmDjgILmiYDku6Xov5nph4zlgZrjgIzmnIkgcmVzdWx0IOWwseWPliByZXN1bHTjgI3nmoTlrrnplJnop6PljIXvvIxcclxuICog6K6p6LCD55So5pa55ou/5Yiw55qE5rC46L+c5pivKirmspnnrrHph4wgcmV0dXJuIOeahOmCo+S4quS4nOilvyoq44CCXHJcbiAqXHJcbiAqIEBwYXJhbSBzdHJ1Y3R1cmVkIC0g5rKZ566x5Zue5omn55qEIGBkYXRhYCDlrZfmrrXjgIJcclxuICogQHJldHVybnMg5rKZ566x6L+U5Zue5YC877yb5peg5rOV5Yik5a6a5pe25Y6f5qC36L+U5Zue44CCXHJcbiAqL1xyXG5mdW5jdGlvbiB1bndyYXBTYW5kYm94UmVzdWx0KHN0cnVjdHVyZWQ6IHVua25vd24pOiB1bmtub3duIHtcclxuICAgIGlmICghc3RydWN0dXJlZCB8fCB0eXBlb2Ygc3RydWN0dXJlZCAhPT0gJ29iamVjdCcpIHJldHVybiBzdHJ1Y3R1cmVkO1xyXG4gICAgY29uc3QgZW52ZWxvcGUgPSBzdHJ1Y3R1cmVkIGFzIHsgcmVzdWx0PzogdW5rbm93biB9O1xyXG4gICAgcmV0dXJuICdyZXN1bHQnIGluIGVudmVsb3BlID8gZW52ZWxvcGUucmVzdWx0IDogc3RydWN0dXJlZDtcclxufVxyXG5cclxuLyoqIOWcuuaZr+iEmuacrOayoeWKoOi9veaXtueahOe7n+S4gOaWh+ahiO+8iOWkmuaVsOaDheWGteaYr+OAjOayoeacieaJk+W8gOWcuuaZr+OAje+8ieOAgiAqL1xyXG5jb25zdCBTQ0VORV9TQ1JJUFRfSElOVCA9XHJcbiAgICAn6YCa5bi45pivKirlvZPliY3msqHmnInmiZPlvIDlnLrmma8qKu+8iOWcuuaZr+i/m+eoi+WPquWcqOacieWcuuaZr+aJk+W8gOaXtuaJjeWKoOi9veaJqeWxleiEmuacrO+8ieOAgicgK1xyXG4gICAgJ+ivt+WcqCBDb2NvcyBDcmVhdG9yIOmHjOaJk+W8gOS7u+aEj+WcuuaZr+WQjumHjeivle+8m+iLpeWImuWQr+eUqOacrOaJqeWxle+8jOmHjeWQr+S4gOasoee8lui+keWZqOabtOeos+OAgic7XHJcblxyXG4vKipcclxuICog5Zyo57yW6L6R5Zmo6YeM5omn6KGM5LiA5q615Luj56CB77yIZWRpdG9yIOi1sCB2bSDmspnnrrHvvIxzY2VuZSDotbDmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvInjgIJcclxuICpcclxuICogQHBhcmFtIHBhcmFtcyAtIGB7Y29udGV4dCwgY29kZSwgYXJncywgdGltZW91dE1zLCBzbmFwc2hvdH1g44CCXHJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m+Wksei0peS5n+i/lOWbniBgb2s6ZmFsc2VgIOiAjOS4jeaYr+aKm++8iOiuqeaooeWei+eci+WIsOWPr+ivu+eahOWOn+WboO+8ieOAglxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkV4ZWN1dGVDb2RlKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xyXG4gICAgcmV0dXJuIGV4ZWN1dGVDb2RlKHBhcmFtcyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDmiKrkuIDlvKAqKuWcuuaZr+inhuWbvioq77yI5oiW5YW25Lit5LiA5Liq6IqC54K577yJ5bm25a2Y5oiQ5Zu+54mH5paH5Lu277yI5a6e546w5ZyoIGBjb3JlL2VuZ2luZS50c2AgK1xyXG4gKiBgc291cmNlL2NhcHR1cmUudHNgICsgYHNvdXJjZS9zY2VuZS50c2DvvInjgIJcclxuICpcclxuICog5Li65LuA5LmI5Y2V54us5LiA5Liq5pa55rOV77ya5Zu+54mH5piv5LqM6L+b5Yi2L+Wkp+Wtl+espuS4su+8jOWhnuS4jei/myBgZXhlY3V0ZV9jb2RlYCDnmoTov5Tlm57lgLzkuIrpmZBcclxuICog77yI5Y2V5a2X56ym5LiyIDQwMDAg5a2X77yJ4oCU4oCUIOaJgOS7peWug+W/hemhu+aYr+OAjOW3peWFtyDihpIg6JC955uYIOKGkiDlm57ot6/lvoTjgI3ov5nkuIDmnaHni6znq4vpgJrpgZPjgIJcclxuICpcclxuICog5Lik5p2h6YCa6YGT77yI5Zue5omn6YeM55qEIGBtZXRob2RgIOS8muWGmeaYjuaYr+WTquadoe+8ie+8mioq5Li76L+b56iLIEVsZWN0cm9uKirvvIhgd2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKWBcclxuICog6K+75ZCI5oiQ5ZCO55qE55S76Z2i77yM56m65Zu+5pe2IGBpbnZhbGlkYXRlKClgIOmAvOS4gOasoemHjee7mO+8ieS8mOWFiO+8m+WcuuaZr+i/m+eoi+ivuyBHTCDlkI7lpIfnvJPlhrLlj6rkvZzlhZzlupXjgIJcclxuICpcclxuICogYGZpdGAg5piv44CM55So5oi357yp5pS+6L+H5LmL5ZCO77yM5bGP5bmV5LiK6YKj5LiA5bin5pyq5b+F5piv5YWo5pmv44CN55qE6Kej5rOV77ya5oiq5Zu+5YmN5YWI5oqK55u45py65pGG5Yiw5qGG5L2P55uu5qCH55qE5L2N572u44CBXHJcbiAqIOaIquWujOeri+WIu+i/mOWOn++8iGBhdXRvYCDlj6rlnKjpnIDopoHml7bmiY3liqjnm7jmnLrvvJtgbm9uZWAg5a6M5YWo5LiN5Yqo77yJ44CC6LSm5pys5Zyo5Zue5omn55qEIGBmcmFtaW5nYCDph4zjgIJcclxuICpcclxuICogQHBhcmFtIHBhcmFtcyAtIGB7c2F2ZVBhdGg/LCBub2RlPywgcGFkZGluZz8sIGZpdD8sIG1heFdpZHRoPywgZm9ybWF0PywgcXVhbGl0eT8sIHdhaXRNcz8sIHRpbWVvdXRNcz99YOOAglxyXG4gKiAgIGBub2RlYCDnu5kgdXVpZCDmiJbot6/lvoTvvIhgQ2FudmFzL3NraWxsX2RldGFpbHNg77yJ5pe25Y+q5oiq6YKj5LiA5Liq6IqC54K577ybXHJcbiAqICAgYGZpdGAgPSBgYXV0b2DvvIjpu5jorqTvvIkvIGBzY2VuZWAgLyBgbm9kZWAgLyBgbm9uZWDvvIjor6bop4EgYGNvcmUvZW5naW5lLnRzYCDnmoQgYGNhcHR1cmVWaWV3YO+8ieOAglxyXG4gKiBAcmV0dXJucyBgZGF0YS5wYXRoYCDmmK/lm77niYfnu53lr7not6/lvoTvvIzlj6/nm7TmjqXlloLnu5nlm77niYfor7vlj5blt6XlhbfjgIJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DYXB0dXJlVmlldyhwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcclxuICAgIHJldHVybiBjYXB0dXJlVmlldyhwYXJhbXMpO1xyXG59XHJcblxyXG4vKipcclxuICog5p+l5LiA5LiqIEFQSSDlrprkuYkg4oCU4oCUICoq5riQ6L+b5byP5oqr6ZyyKirvvIzkuZ/mmK/jgIzliKvnjJzlvJXmk44gQVBJ44CN6L+Z5p2h6KeE55+p55qE5omn6KGM6ICF44CCXHJcbiAqXHJcbiAqIOS4uuS7gOS5iOWAvOW+l+WNleeLrOS4gOS4quW3peWFt++8muaooeWei+WGmee8lui+keWZqOS7o+eggeaXtuacgOeIseeejueMnOWxnuaAp+WQje+8iGBjb21wLmZvdmAg6L+Y5pivXHJcbiAqIGBjb21wLmZvdkF4aXNg77yJ77yM54yc6ZSZ5LiA5qyh55qE5Luj5Lu35piv5LiA5pW06L2u5b6A6L+U44CC6L+Z6YeM57uZ55qE5pivKirov5DooYzml7blj43lsIQqKueahOe7k+aenO+8jFxyXG4gKiDmsLjov5zmr5Tku7vkvZXnvJPlrZgv5paH5qGj5paw77ybc2NlbmUg5L6n5bimIGBub2RlVXVpZGAg5pe26L+Y6IO96KGl5Ye6KirlvZPliY3lgLwqKuOAglxyXG4gKlxyXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtjb250ZXh0LCB0YXJnZXQsIG5vZGVVdWlkLCBsaW1pdH1g44CCXHJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m2B0ZXh0YCDmmK/nu5nmqKHlnovnnIvnmoQgSlNPTuOAglxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlc2NyaWJlQXBpKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xyXG4gICAgY29uc3QgY29udGV4dCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6ICdlZGl0b3InO1xyXG4gICAgY29uc3QgdGFyZ2V0ID0gdHlwZW9mIHBhcmFtcy50YXJnZXQgPT09ICdzdHJpbmcnID8gcGFyYW1zLnRhcmdldC50cmltKCkgOiAnJztcclxuICAgIGNvbnN0IG5vZGVVdWlkID0gdHlwZW9mIHBhcmFtcy5ub2RlVXVpZCA9PT0gJ3N0cmluZycgPyBwYXJhbXMubm9kZVV1aWQgOiAnJztcclxuICAgIGNvbnN0IGxpbWl0ID0gY2xhbXBMaW1pdChwYXJhbXMubGltaXQpO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9XHJcbiAgICAgICAgICAgIGNvbnRleHQgPT09ICdlZGl0b3InXHJcbiAgICAgICAgICAgICAgICA/IGF3YWl0IGRlc2NyaWJlRWRpdG9yQXBpKHRhcmdldCwgbGltaXQpXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGRlc2NyaWJlU2NlbmVBcGkodGFyZ2V0LCBub2RlVXVpZCwgbGltaXQpO1xyXG4gICAgICAgIHJldHVybiB7IG9rOiBwYXlsb2FkLm9rICE9PSBmYWxzZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGRhdGE6IHBheWxvYWQgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgb2s6IGZhbHNlLFxyXG4gICAgICAgICAgICB0ZXh0OiBg5p+l6K+iIEFQSSDlrprkuYnlpLHotKXvvIgke2NvbnRleHR9IC8gJHt0YXJnZXQgfHwgJyjmgLvop4gpJ33vvInvvJoke2Rlc2NyaWJlKGVycm9yKX1cXG4ke1NDRU5FX1NDUklQVF9ISU5UfWAsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqIOWIl+ihqOexu+WPguaVsOe7n+S4gOWkueWIsCAxfjUwMO+8iOm7mOiupCA4MO+8ieOAgiAqL1xyXG5mdW5jdGlvbiBjbGFtcExpbWl0KHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHJhdyA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgudHJ1bmModmFsdWUpIDogODA7XHJcbiAgICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oNTAwLCByYXcpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOW4uOeUqOiwg+eUqOmAn+afpSDigJTigJQg5pS+5oC76KeI6YeM77yM6K6p5qih5Z6L5bCR6LWw5Yeg6L2u6K+V6ZSZ44CCXHJcbiAqXHJcbiAqIOi/meWHoOadoeaYryoq57qv5paH5pys55+l6K+GKirvvIjkuI3mmK/og73lj43lsITlh7rmnaXnmoTkuJzopb/vvInvvIzmiYDku6XlhpnmiJDluLjph4/mmK/lj6/ku6XmjqXlj5fnmoTvvJtcclxuICog6YC76L6R5Yir5oqE77yI6KeBIGBkZXNjcmliZUVkaXRvckFwaWAg6YeMIGBoZWxwZXJzYCDpgqPkuIDmoaPnmoTlpITnkIbmlrnlvI/vvInjgIJcclxuICovXHJcbmNvbnN0IEVESVRPUl9DSEVBVFNIRUVUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAg6LWE5rqQ5p+l6K+iOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogJ2RiOi8vYXNzZXRzLyoqLyoucHJlZmFiJyB9KVwiLFxyXG4gICAg6LWE5rqQ6K+m5oOFOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmxPclV1aWQpXCIsXHJcbiAgICDliLfmlrDotYTmupA6IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVmcmVzaC1hc3NldCcsICdkYjovL2Fzc2V0cycpXCIsXHJcbiAgICDkv53lrZjlnLrmma86IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpXCIsXHJcbiAgICDmiZPlvIDlnLrmma86IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnb3Blbi1zY2VuZScsIHNjZW5lQXNzZXRVdWlkKVwiLFxyXG4gICAg6YCJ5Lit6LWE5rqQOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3NldC1hc3NldC11dWlkLXNlbGVjdGlvbicsIHV1aWQpXCIsXHJcbiAgICDor7vorr7nva46IFwiYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0Q29uZmlnKCc85omp5bGV5ZCNPicsICdrZXknLCAnbG9jYWwnKVwiLFxyXG4gICAg5bel56iL6Lev5b6EOiAnRWRpdG9yLlByb2plY3QucGF0aCcsXHJcbiAgICDnvJbovpHlmajniYjmnKw6ICdFZGl0b3IuQXBwLnZlcnNpb24nLFxyXG4gICAg5o6n5Yi25Y+w5pel5b+XOiAnRWRpdG9yLkxvZ2dlci5xdWVyeSgpJyxcclxufTtcclxuXHJcbi8qKlxyXG4gKiDnvJbovpHlmajkuLvov5vnqIvkvqfnmoTlj43lsITvvIhgY29yZS9lbmdpbmUudHNgIOmHjOayoeacieWvueW6lOeahOWvueWklua2iOaBr++8jOaJgOS7pei/memHjOiHquW3seWunueOsO+8ieOAglxyXG4gKlxyXG4gKiDlm5vmoaPvvJrmgLvop4ggLyBgaGVscGVyc2AgLyBgbW9kdWxlOnh4eGAgLyBgRWRpdG9yLlh4eC5ZeXlg44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBkZXNjcmliZUVkaXRvckFwaSh0YXJnZXQ6IHN0cmluZywgbGltaXQ6IG51bWJlcik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IGVkaXRvckFueSA9IEVkaXRvciBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG5cclxuICAgIGlmICghdGFyZ2V0KSB7XHJcbiAgICAgICAgY29uc3QgbmFtZXNwYWNlczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1ldGhvZENvdW50OiBudW1iZXI7IHNhbXBsZTogc3RyaW5nW10gfT4gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhlZGl0b3JBbnkpLnNvcnQoKSkge1xyXG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGVkaXRvckFueVtrZXldO1xyXG4gICAgICAgICAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBsZXQgbWV0aG9kTmFtZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBtZXRob2ROYW1lcyA9IE9iamVjdC5rZXlzKHZhbHVlIGFzIG9iamVjdCkuZmlsdGVyKFxyXG4gICAgICAgICAgICAgICAgICAgIChrKSA9PiB0eXBlb2YgKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXSA9PT0gJ2Z1bmN0aW9uJyxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAgICAgbWV0aG9kTmFtZXMgPSBbXTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBuYW1lc3BhY2VzLnB1c2goeyBuYW1lOiBrZXksIG1ldGhvZENvdW50OiBtZXRob2ROYW1lcy5sZW5ndGgsIHNhbXBsZTogbWV0aG9kTmFtZXMuc2xpY2UoMCwgOCkgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIG9rOiB0cnVlLFxyXG4gICAgICAgICAgICBraW5kOiAnaW5kZXgnLFxyXG4gICAgICAgICAgICBjb250ZXh0OiAnZWRpdG9yJyxcclxuICAgICAgICAgICAgbmFtZXNwYWNlcyxcclxuICAgICAgICAgICAgY2hlYXRzaGVldDogRURJVE9SX0NIRUFUU0hFRVQsXHJcbiAgICAgICAgICAgIGhpbnQ6XHJcbiAgICAgICAgICAgICAgICBcIueUqCBjb2Nvc19kZXNjcmliZV9hcGkoe2NvbnRleHQ6J2VkaXRvcicsIHRhcmdldDonRWRpdG9yLk1lc3NhZ2UnfSkg55yL5p+Q5Liq5ZG95ZCN56m66Ze055qE5pa55rOV5YWo6KGo77ybXCIgK1xyXG4gICAgICAgICAgICAgICAgXCJ0YXJnZXQ6J2hlbHBlcnMnIOeci+aymeeuseWKqeaJi++8m3RhcmdldDonbW9kdWxlOmZzJyDnnIvmn5DkuKogbm9kZSDmqKHlnZfnmoTlr7zlh7rjgIJcIixcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog4pqgICoq5Yir5oqE5Yqp5omL5riF5Y2VKirvvJrlroPnlLHmspnnrrHms6jlhaXvvIhgY29yZS9lbmdpbmUudHNgIOeahCBgYnVpbGRFZGl0b3JIZWxwZXJzYCArIHJlY2lwZSDkupTku7blpZfvvInvvIxcclxuICAgICAqIOaKhOS4gOS7veeahOS4i+WcuuaYr+OAjOafpeWIsOeahOWHveaVsOWcqOaymeeusemHjOS4jeWtmOWcqOOAjeOAguaJgOS7pei/meS4gOahoyoq5Zue5rKZ566x6ZeuKirjgIJcclxuICAgICAqL1xyXG4gICAgaWYgKHRhcmdldCA9PT0gJ2hlbHBlcnMnKSB7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBydW5FeGVjdXRlQ29kZSh7IGNvbnRleHQ6ICdlZGl0b3InLCB0aW1lb3V0TXM6IDgwMDAsIGNvZGU6ICdyZXR1cm4gaGVscGVyTmFtZXMoKTsnIH0pO1xyXG4gICAgICAgIGNvbnN0IG5hbWVzID0gdW53cmFwU2FuZGJveFJlc3VsdChyZXBseS5kYXRhKTtcclxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkobmFtZXMpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwga2luZDogJ2hlbHBlcnMnLCBjb250ZXh0OiAnZWRpdG9yJywgZXJyb3I6IHJlcGx5LnRleHQuc2xpY2UoMCwgODAwKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwga2luZDogJ2hlbHBlcnMnLCBjb250ZXh0OiAnZWRpdG9yJywgaGVscGVyczogbmFtZXMgfTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAodGFyZ2V0LnN0YXJ0c1dpdGgoJ21vZHVsZTonKSkge1xyXG4gICAgICAgIGNvbnN0IG1vZHVsZU5hbWUgPSB0YXJnZXQuc2xpY2UoJ21vZHVsZTonLmxlbmd0aCkudHJpbSgpO1xyXG4gICAgICAgIGlmICghbW9kdWxlTmFtZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ21vZHVsZTog5ZCO6Z2i6KaB6Lef5qih5Z2X5ZCN77yM5aaCIG1vZHVsZTpmcycgfTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBsb2FkZWQgPSByZXF1aXJlKG1vZHVsZU5hbWUpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMobG9hZGVkIHx8IHt9KS5zb3J0KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6ICdtb2R1bGUnLFxyXG4gICAgICAgICAgICAgICAgbW9kdWxlOiBtb2R1bGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgZXhwb3J0Q291bnQ6IGtleXMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgZXhwb3J0czoga2V5cy5zbGljZSgwLCBsaW1pdCksXHJcbiAgICAgICAgICAgICAgICBoaW50OiBg5ZyoIGNvY29zX2V4ZWN1dGVfY29kZSDph4znm7TmjqUgXFxgcmV0dXJuIHJlcXVpcmUoJyR7bW9kdWxlTmFtZX0nKVxcYCDlj6/ku6Xmi7/liLDnnJ/lrp7lr7nosaHjgIJgLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGByZXF1aXJlKCcke21vZHVsZU5hbWV9Jykg5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyDmjInngrnliIbot6/lvoTlnKggRWRpdG9yIOS4iui1sO+8iGBFZGl0b3IuTWVzc2FnZWAg5LiOIGBNZXNzYWdlYCDkuKTnp43lhpnms5Xpg73orqTvvIlcclxuICAgIGNvbnN0IHBhcnRzID0gdGFyZ2V0LnJlcGxhY2UoL15FZGl0b3JcXC4/LywgJycpLnNwbGl0KCcuJykuZmlsdGVyKEJvb2xlYW4pO1xyXG4gICAgbGV0IG5vZGU6IHVua25vd24gPSBFZGl0b3I7XHJcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcclxuICAgICAgICBpZiAobm9kZSA9PT0gbnVsbCB8fCBub2RlID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDmib7kuI3liLAgJHt0YXJnZXR977yI5ZyoICR7cGFydH0g5aSE5pat6ZO+77yJYCB9O1xyXG4gICAgICAgIG5vZGUgPSAobm9kZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbcGFydF07XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZSA9PT0gbnVsbCB8fCBub2RlID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDmib7kuI3liLAgJHt0YXJnZXR9YCB9O1xyXG4gICAgaWYgKHR5cGVvZiBub2RlICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBraW5kOiAndmFsdWUnLCB0YXJnZXQsIHZhbHVlOiBTdHJpbmcobm9kZSkgfTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBtZXRob2RzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgY29uc3QgdmFsdWVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZSBhcyBvYmplY3QpLnNvcnQoKSkge1xyXG4gICAgICAgIGxldCBlbnRyeTogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBlbnRyeSA9IChub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHR5cGVvZiBlbnRyeSA9PT0gJ2Z1bmN0aW9uJykgbWV0aG9kcy5wdXNoKGtleSk7XHJcbiAgICAgICAgZWxzZSB2YWx1ZXMucHVzaChrZXkpO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgb2s6IHRydWUsXHJcbiAgICAgICAga2luZDogJ25hbWVzcGFjZScsXHJcbiAgICAgICAgdGFyZ2V0OiBgRWRpdG9yLiR7cGFydHMuam9pbignLicpfWAsXHJcbiAgICAgICAgbWV0aG9kczogbWV0aG9kcy5zbGljZSgwLCBsaW1pdCksXHJcbiAgICAgICAgbWV0aG9kQ291bnQ6IG1ldGhvZHMubGVuZ3RoLFxyXG4gICAgICAgIHZhbHVlczogdmFsdWVzLnNsaWNlKDAsIE1hdGgubWluKDMwLCBsaW1pdCkpLFxyXG4gICAgICAgIGhpbnQ6IGDosIPnlKjlvaLlpoIgXFxgYXdhaXQgJHt0YXJnZXR9Lnh4eCguLi4pXFxg77yb5Y+C5pWw6aG65bqP6KeB57yW6L6R5Zmo5a6Y5pa55paH5qGj77yM5oiW55u05o6l6K+V6LCD55yL5oql6ZSZ44CCYCxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qXHJcbiAqIOWcuuaZr+S+p+eahOWPjeWwhO+8iGBkZXNjcmliZVNjZW5lQXBpYO+8ieS4juaOoua0u++8iGBwaW5nU2NlbmVTY3JpcHRg77yJ6YO95ZyoIGBjb3JlL2VuZ2luZS50c2Ag6YeMIOKAlOKAlFxyXG4gKiDlroPku6zlj6rmmK8gYGV4ZWN1dGUtc2NlbmUtc2NyaXB0YCDnmoTkuIDlsYLoloTlsIHoo4XvvIzmsqHlv4XopoHlnKjov5nph4zlho3mioTkuIDku73jgIJcclxuICovXHJcblxyXG4vKipcclxuICog55yL5LiA55y857yW6L6R5Zmo546w5Zyo5piv5LuA5LmI54q25oCB44CCXHJcbiAqXHJcbiAqIOS4ieWdl+S/oeaBr+adpeiHquS4jeWQjOi/m+eoi++8mlxyXG4gKiAtICoq5bel56iLL+eJiOacrCoq77ya5Li76L+b56iL55qEIGBFZGl0b3IuUHJvamVjdGAgLyBgRWRpdG9yLkFwcGDvvJtcclxuICogLSAqKumAieS4rSoq77ya5Li76L+b56iL6ZeuIGBzY2VuZWAg5YyF55qEIGBxdWVyeS1ub2RlLXRyZWVg77ybXHJcbiAqIC0gKirlnLrmma8qKu+8muWAn+acrOaJqeWxleeahOWcuuaZr+aymeeusei3keS4gOWwj+aute+8iGBkaXJlY3Rvci5nZXRTY2VuZSgpYO+8ieOAglxyXG4gKlxyXG4gKiDlho3liqDkuIDlnZcqKuiDveWKm+aOoua0uyoq77yI5b6I5YC86ZKx55qE6YKj6YOo5YiG77yJ77ya5Zy65pmv6ISa5pys5Yqg6L295LqG5rKh5pyJIOKAlOKAlFxyXG4gKiDmqKHlnovmja7mraTmj5DliY3nn6XpgZPjgIzmjqXkuIvmnaXog73kuI3og73liqjlnLrmma/jgI3vvIzogIzkuI3mmK/lhpnkuobkuIDlsY/ku6PnoIHmiY3lj5HnjrDmsqHmiZPlvIDlnLrmma/jgIJcclxuICpcclxuICog5Lu75L2V5LiA5Z2X5ou/5LiN5Yiw6YO9KirkuI3pmLvmlq0qKuaVtOS9k+KAlOKAlOi/lOWbnuW3suacieeahOmDqOWIhiArIOS4gOadoSBg4oCm6K+75Y+W5aSx6LSl77ya5Y6f5ZugYO+8jOavlOaVtOS4quW3peWFt+Wksei0peacieeUqOOAglxyXG4gKlxyXG4gKiBAcGFyYW0gX3BhcmFtcyAtIGB7dmVyYm9zZT99YO+8iOW9k+WJjSB2ZXJib3NlIOWPquW9seWTjeaYr+WQpumZhOS4iui/kOihjOaXtuiviuaWre+8ieOAglxyXG4gKiBAcmV0dXJucyDlt6Xlhbflm57miafjgIJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkRWRpdG9yU3RhdGUoX3BhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xyXG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBjb25zdCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xyXG4gICAgY29uc3QgcHJvYmxlbXM6IHN0cmluZ1tdID0gW107XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgICBkYXRhLnByb2plY3RQYXRoID0gRWRpdG9yLlByb2plY3QucGF0aDtcclxuICAgICAgICBsaW5lcy5wdXNoKGDlt6XnqIvvvJoke0VkaXRvci5Qcm9qZWN0LnBhdGh9YCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHByb2JsZW1zLnB1c2goYOW3peeoi+i3r+W+hOivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xyXG4gICAgfVxyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgICAgZGF0YS5lZGl0b3JWZXJzaW9uID0gRWRpdG9yLkFwcC52ZXJzaW9uO1xyXG4gICAgICAgIGRhdGEuZWRpdG9yTmFtZSA9IEVkaXRvci5BcHAubmFtZTtcclxuICAgICAgICBsaW5lcy5wdXNoKGDnvJbovpHlmajvvJoke0VkaXRvci5BcHAubmFtZX0gJHtFZGl0b3IuQXBwLnZlcnNpb259YCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHByb2JsZW1zLnB1c2goYOe8lui+keWZqOeJiOacrOivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xyXG4gICAgfVxyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktbm9kZS10cmVlJykpIGFzXHJcbiAgICAgICAgICAgIHwgeyB1dWlkPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH1cclxuICAgICAgICAgICAgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKHNlbGVjdGVkICYmIHR5cGVvZiBzZWxlY3RlZCA9PT0gJ29iamVjdCcpIHtcclxuICAgICAgICAgICAgZGF0YS5zZWxlY3Rpb24gPSB7IHV1aWQ6IHNlbGVjdGVkLnV1aWQgPz8gbnVsbCwgbmFtZTogc2VsZWN0ZWQubmFtZSA/PyBudWxsIH07XHJcbiAgICAgICAgICAgIGxpbmVzLnB1c2goYOmAieS4re+8miR7c2VsZWN0ZWQubmFtZSA/PyAnKOaXoOWQjSknfSR7c2VsZWN0ZWQudXVpZCA/IGAgWyR7c2VsZWN0ZWQudXVpZH1dYCA6ICcnfWApO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGRhdGEuc2VsZWN0aW9uID0gbnVsbDtcclxuICAgICAgICAgICAgbGluZXMucHVzaCgn6YCJ5Lit77ya5pegJyk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBkYXRhLnNlbGVjdGlvbiA9IG51bGw7XHJcbiAgICAgICAgcHJvYmxlbXMucHVzaChg6YCJ5Lit5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8g5Zy65pmv5L+h5oGv6KaB5YCf5Zy65pmv6L+b56iL77yI5Li76L+b56iL5ou/5LiN5Yiw5rS755qE5Zy65pmv5qCR77yJXHJcbiAgICBjb25zdCBzY2VuZVByb2JlID0gYXdhaXQgcnVuRXhlY3V0ZUNvZGUoe1xyXG4gICAgICAgIGNvbnRleHQ6ICdzY2VuZScsXHJcbiAgICAgICAgdGltZW91dE1zOiA4MDAwLFxyXG4gICAgICAgIGNvZGU6XHJcbiAgICAgICAgICAgICdjb25zdCBzID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTsnICtcclxuICAgICAgICAgICAgJyBsZXQgbiA9IDA7JyArXHJcbiAgICAgICAgICAgICcgZWFjaE5vZGUoKCkgPT4geyBuICs9IDE7IH0pOycgK1xyXG4gICAgICAgICAgICAnIHJldHVybiB7IGhhc1NjZW5lOiAhIXMsIG5hbWU6IHMgPyBzLm5hbWUgOiBudWxsLCB1dWlkOiBzID8gcy51dWlkIDogbnVsbCwgbm9kZUNvdW50OiBuIH07JyxcclxuICAgIH0pO1xyXG4gICAgLyoqXHJcbiAgICAgKiDimqAgKirouKnov4fnmoTlnZEqKu+8muaymeeuseWbnuaJp+aYr+Wll+S6huS4gOWxgueahFxyXG4gICAgICogYHsgb2ssIGNvbnRleHQsIGR1cmF0aW9uTXMsIHJlc3VsdCB9YCDigJTigJQg5rKZ566x55qE6L+U5Zue5YC85ZyoIGAucmVzdWx0YCDph4zjgIJcclxuICAgICAqIOesrOS4gOeJiOebtOaOpeW9kyBge2hhc1NjZW5lfWAg6K+777yM5LqO5pivIGBoYXNTY2VuZWAg5oGS5Li6IHVuZGVmaW5lZCDihpIg55WM6Z2i5rC46L+c5pi+56S6XHJcbiAgICAgKiDjgIzlnLrmma/vvJrmnKrmiZPlvIDjgI3vvIjogIzlnLrmma/lhbblrp7lvIDnnYDjgIE1NDYg5Liq6IqC54K577yJ44CC5bel5YW35pys6Lqr5rKh5oql6ZSZ77yM5omA5Lul54m55Yir6Zq+5Y+R546w44CCXHJcbiAgICAgKi9cclxuICAgIGNvbnN0IHByb2JlID0gdW53cmFwU2FuZGJveFJlc3VsdChzY2VuZVByb2JlLmRhdGEpIGFzXHJcbiAgICAgICAgfCB7IGhhc1NjZW5lPzogYm9vbGVhbjsgbmFtZT86IHN0cmluZzsgdXVpZD86IHN0cmluZzsgbm9kZUNvdW50PzogbnVtYmVyIH1cclxuICAgICAgICB8IHVuZGVmaW5lZDtcclxuICAgIGlmIChzY2VuZVByb2JlLm9rICYmIHByb2JlKSB7XHJcbiAgICAgICAgZGF0YS5zY2VuZSA9IHByb2JlO1xyXG4gICAgICAgIGxpbmVzLnB1c2goXHJcbiAgICAgICAgICAgIHByb2JlLmhhc1NjZW5lXHJcbiAgICAgICAgICAgICAgICA/IGDlnLrmma/vvJoke3Byb2JlLm5hbWUgPz8gJyjmnKrlkb3lkI0pJ30gWyR7cHJvYmUudXVpZCA/PyAnLSd9Xe+8jOiKgueCuSAke3Byb2JlLm5vZGVDb3VudCA/PyAnPyd9IOS4qmBcclxuICAgICAgICAgICAgICAgIDogJ+WcuuaZr++8muacquaJk+W8gCcsXHJcbiAgICAgICAgKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcHJvYmxlbXMucHVzaChg5Zy65pmv5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtzY2VuZVByb2JlLnRleHQuc2xpY2UoMCwgMjAwKX1gKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyDog73lipvmjqLmtLvvvJrlnLrmma/ohJrmnKzlnKjkuI3lnKgg4oCU4oCUIOWug+WGs+WumuOAjOaOpeS4i+adpeiDveS4jeiDveaUueWcuuaZr+OAjVxyXG4gICAgY29uc3Qgc2NlbmVTY3JpcHQgPSBhd2FpdCBwaW5nU2NlbmUoKTtcclxuICAgIGRhdGEuY2FwYWJpbGl0aWVzID0geyBzYW5kYm94OiBFWFRFTlNJT05fTkFNRSwgc2NlbmVTY3JpcHQgfTtcclxuICAgIGxpbmVzLnB1c2goXHJcbiAgICAgICAgc2NlbmVTY3JpcHQuYXZhaWxhYmxlXHJcbiAgICAgICAgICAgID8gYOiDveWKm++8muS7o+eggeaymeeuseWPr+eUqO+8iOacrOaJqeWxleeahOWcuuaZr+iEmuacrOW3suWKoOi9ve+8jOiDveaUueWcuuaZr++8iWBcclxuICAgICAgICAgICAgOiBg6IO95Yqb77ya5Y+q6K+75b6X5Yqo57yW6L6R5ZmoIOKAlOKAlCDlnLrmma/kvqfkuI3lj6/nlKjvvJoke3NjZW5lU2NyaXB0LnJlYXNvbiA/PyAn5Zy65pmv6ISa5pys5LiN5Y+v55SoJ33jgIIke1NDRU5FX1NDUklQVF9ISU5UfWAsXHJcbiAgICApO1xyXG5cclxuICAgIGlmIChwcm9ibGVtcy5sZW5ndGggPiAwKSBsaW5lcy5wdXNoKCcnLCAn4pqgIOmDqOWIhuS/oeaBr+ayoeaLv+WIsO+8micsIC4uLnByb2JsZW1zLm1hcCgobGluZSkgPT4gYC0gJHtsaW5lfWApKTtcclxuXHJcbiAgICAvLyDkuIvkuIDmraXor6XnlKjku4DkuYjlt6XlhbfvvJrov5nlh6DmnaHmmK8qKuWUr+S4gOS4gOWkhOaooeWei+S4gOWumuS8mueci+WIsCoq55qE55So5rOV5o+Q56S677yIRFNIIOS4jea2iOi0uSBNQ1Ag55qEIGluc3RydWN0aW9uc++8iVxyXG4gICAgbGluZXMucHVzaChcclxuICAgICAgICAnJyxcclxuICAgICAgICAn5LiL5LiA5q2l77yaJyxcclxuICAgICAgICAvLyDimqAg56ys5LiA5p2h5bCx5pivIHJlY2lwZe+8muWunua1i+S4gOaVtOWknOmHjCBgZmluZFJlY2lwZXNgIOiiq+iwg+eUqCAwIOasoe+8jOiAjOWUr+S4gOWtmOS4i+eahOmCo+adoSByZWNpcGVcclxuICAgICAgICAvLyAgIOWPiOWboOebruW9leaUueWQjeaIkOS6huWtpOWEvyDigJTigJQg5o+Q56S65L2N5LiN5pGG5Zyo6L+Z6YeM77yM6L+Z5aWX5py65Yi25bCx5rC46L+c5piv56m655qE44CCXHJcbiAgICAgICAgXCItICoq5YWI5om+5Y+v5aSN55So6YWN5pa5KirvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6J2VkaXRvcicsIGNvZGU6XFxcInJldHVybiBmaW5kUmVjaXBlcygpXFxcIn0pIOKAlOKAlCDlgZogVUkv6aKE5Yi25Lu2L+aJuemHj+aUueiKgueCuei/meexu+a0u+S5i+WJjeWFiOeci+acieayoeaciei3kemAmui/h+eahOS7o+eggVwiLFxyXG4gICAgICAgIFwiLSDlnLrmma/moJHpqqjmnrbvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6J3NjZW5lJywgY29kZToncmV0dXJuIHRyZWUoe21heERlcHRoOjIsIHdpdGhDb21wb25lbnRzOnRydWV9KSd9KVwiLFxyXG4gICAgICAgIFwiLSDnu4Tku7bmnInlk6rkupvlsZ7mgKfvvJpjb2Nvc19kZXNjcmliZV9hcGkoe2NvbnRleHQ6J3NjZW5lJywgdGFyZ2V0OidjYy5DYW1lcmEnLCBub2RlVXVpZDonPOS4iumdouafpeWIsOeahCB1dWlkPid9KVwiLFxyXG4gICAgICAgICctIOe8lui+keWZqCBBUEkg5oC76KeI77yaY29jb3NfZGVzY3JpYmVfYXBpKHtjb250ZXh0OlwiZWRpdG9yXCJ9KScsXHJcbiAgICAgICAgXCItIOWIl+i1hOa6kO+8mmNvY29zX2V4ZWN1dGVfY29kZSh7Y29kZTpcXFwicmV0dXJuIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsJ3F1ZXJ5LWFzc2V0cycse3BhdHRlcm46J2RiOi8vYXNzZXRzLyoqLyoucHJlZmFiJ30pKS5zbGljZSgwLDIwKS5tYXAoYT0+YS51cmwpXFxcIn0pXCIsXHJcbiAgICAgICAgLyoqXHJcbiAgICAgICAgICog55WM6Z2i5Lqk5LqS77yI54K55oyJIC8g5oyJ6ZSu77yJ5piv5Lik5p2hKirni6znq4vpgJrpgZMqKu+8jOS4jeWcqCBgZXhlY3V0ZV9jb2RlYCDnmoTlsITnqIvph4wg4oCU4oCUXHJcbiAgICAgICAgICog6L+Z6YeM5b+F6aG754K55LiA5qyh5ZCN77ya5qih5Z6L5ZyoXCLmlLnlrowgVUkg5oOz6aqM5LiA5LiLXCLml7bmnIDlrrnmmJPlj6rmg7PliLDmiKrlm77kuI7or7voioLngrnmlbDmja7jgIJcclxuICAgICAgICAgKi9cclxuICAgICAgICBcIi0gKirngrnkuIDkuIvor5Xor5UqKu+8mmNvY29zX2NsaWNrX25vZGUoe25vZGU6JzzoioLngrnot6/lvoQ+J30p77yI55yf6byg5qCH5LqL5Lu277yb6L+Q6KGM5oCB5LiL6KaB5pS555So5Z2Q5qCH77yM6KeB6K+l5bel5YW36K+05piO77yJXCIsXHJcbiAgICAgICAgLyoqXHJcbiAgICAgICAgICog4pqgIOW8gOWcuuaZr+i/meadoSoq5b+F6aG754K55Ye65p2lKirvvJrnnJ/mnLrlrp7mtYsgMjAyNi0xMSDigJTigJQgYG9wZW4tc2NlbmVgIOS8oCBgZGI6Ly9gIOi3r+W+hFxyXG4gICAgICAgICAqICoq5LiN5pivXCLmiZPlvIDpgqPkuKrlnLrmma9cIioq77yM6ICM5piv5byA5Ye65LiA5LiqKirmlrDnmoTmnKrlkb3lkI0gMkQg5Zy65pmvKirvvIjmoLkgdXVpZCDmr4/mrKHpg73kuI3lkIzjgIFcclxuICAgICAgICAgKiDno4Hnm5jkuIrmlofku7bmsqHlj5jvvInvvIzogIzkuJQqKuS4jeaKpemUmSoq77yM5o6l552A5b6A5LiL5YGa5bCx5Lya5Zyo56m65Zy65pmv6YeM5pS55Lic6KW/44CCXHJcbiAgICAgICAgICog5Lyg6LWE5rqQICoqdXVpZCoqIOaJjeaYr+W8gOWug+OAguivpuingSBza2lsbCDnmoTjgIzlnZEgMTXjgI3jgIJcclxuICAgICAgICAgKi9cclxuICAgICAgICBcIi0g6KaB5byA5Yir55qE5Zy65pmv77yab3Blbi1zY2VuZSDnu5kqKui1hOa6kCB1dWlkKirvvIhgYmEwMThjYTkt4oCmYCDov5nnp43vvInvvIwqKuWIq+e7mSBgZGI6Ly9gIOi3r+W+hCoqIOKAlOKAlCDlrp7mtYvnu5not6/lvoTkvJrlvIDlh7oqKuS4gOS4quaWsOeahOepuuWcuuaZryoq5LiU5LiN5oql6ZSZ77yIc2tpbGwg5Z2RIDE177yJXCIsXHJcbiAgICApO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog4pqgICoqYG9rYCDnmoTor63kuYnvvJrov5nkuKrlt6XlhbfjgIzot5HmiJDlip/kuobmsqHmnInjgI3vvIzkuI3mmK/jgIzmr4/kuIDpobnpg73mi7/liLDkuobmsqHmnInjgI0qKuOAglxyXG4gICAgICpcclxuICAgICAqIOi4qei/h+eahOWdke+8iOS7o+S7tyA1OSDliIbpkp/nmoTmjpLmn6XkvJror53vvInvvJrljp/mnaXlhpnnmoTmmK8gYG9rOiBwcm9ibGVtcy5sZW5ndGggPT09IDBgIOKAlOKAlCDkuo7mmK9cclxuICAgICAqIOOAjOWbm+mhueaOoumSiOS4iemhueaIkOWKn+OAgeWPquacieWcuuaZr+S4gOmhueWksei0peOAjeS5n+S8muWbniBgb2s6IGZhbHNlYO+8jOiAjOahpeaOpeS+p1xyXG4gICAgICog77yIYGRzaC1wcm9maWxlL3BsdWdpbi9kc2gtY29jb3MtYnJpZGdlL2luZGV4LmpzYO+8ieingSBgb2s6ZmFsc2VgIOWwsSByZWplY3TvvIxcclxuICAgICAqIOaKiuaVtOauteS6uuivneaWh+ahiOW9k+aIkCBgRXJyb3I6YCDmipvliLDnlKjmiLfpnaLliY3jgILnlKjmiLfnnIvliLDnmoTmmK/jgIzkuIDkuKroh6rmo4Dlt6XlhbfmiqXplJnkuobjgI3vvIxcclxuICAgICAqIOS6juaYr+W8gOS6huS4gOadoeS8muivneWOu+afpeOAjOaPkuS7tuaYr+S4jeaYr+Wdj+S6huOAjeKAlOKAlCDnnJ/nm7jlj6rmmK/pgqPkuKrmianlsZXooqvnpoHnlKjkuobjgIJcclxuICAgICAqXHJcbiAgICAgKiDnjrDlnKjnmoTlj6PlvoTvvJoqKuWPquimgeaLv+WIsOS7u+S9leS4gOWdl+acieaViOS/oeaBr+Wwseeul+aIkOWKnyoq77yI5bm26ZmEIGBkYXRhLnByb2JsZW1zYCDkuI4gYGRhdGEuZGVncmFkZWRg77yJ77yMXHJcbiAgICAgKiDlj6rmnInjgIzku4DkuYjpg73msqHmi7/liLDjgI3miY3nrpflpLHotKXjgILkuIrpnaLms6jph4rph4zmnKzmnaXlhpnnmoTlsLHmmK/jgIzku7vkvZXkuIDlnZfmi7/kuI3liLDpg73kuI3pmLvmlq3mlbTkvZPjgI3vvIxcclxuICAgICAqIOS5i+WJjeaYryBgb2tgIOeahOeul+azleS4jui/meWPpeivneiHquebuOefm+ebvuOAglxyXG4gICAgICovXHJcbiAgICBjb25zdCBnb3RBbnl0aGluZyA9XHJcbiAgICAgICAgQm9vbGVhbihkYXRhLnByb2plY3RQYXRoKSB8fCBCb29sZWFuKGRhdGEuZWRpdG9yVmVyc2lvbikgfHwgQm9vbGVhbihkYXRhLnNjZW5lKSB8fCBCb29sZWFuKGRhdGEuc2VsZWN0aW9uKTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG9rOiBnb3RBbnl0aGluZyxcclxuICAgICAgICB0ZXh0OiBsaW5lcy5qb2luKCdcXG4nKSxcclxuICAgICAgICBkYXRhOiB7IC4uLmRhdGEsIHByb2JsZW1zLCBkZWdyYWRlZDogcHJvYmxlbXMubGVuZ3RoID4gMCB9LFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOeCueS4gOS4quiKgueCuSAvIOS4gOS4quWdkOaghyDigJTigJQgKirnnJ/kuovku7YqKu+8iGB3ZWJDb250ZW50cy5zZW5kSW5wdXRFdmVudGDvvIzop4EgYHNvdXJjZS9pbnB1dC50c2DvvInjgIJcclxuICpcclxuICogIyMg5Li65LuA5LmI6L+Z5pivXCLorqkgYWdlbnQg6Ieq5bex6aqM5pS255WM6Z2iXCLnmoTpgqPkuIDku7ZcclxuICpcclxuICog5pS55a6MIFVJIOiDveaIquWbvueci++8jOS9hlwi6L+Z5Liq5oyJ6ZKu54K55LiL5Y675pyJ5rKh5pyJ5Y+N5bqUXCLku6XliY3lj6rog73or7fkurrljrvngrnjgILov5nph4zmiopcclxuICog5LiA5qyh55yf5a6e55qE6byg5qCH5oyJ5LiLL+aKrOi1t+WPkee7memCo+S4gOmhte+8jOaMiemSrueahOWbnuiwg+OAgeWIl+ihqOeahOmAieS4reOAgeaLluaLve+8jOWFqOmDveeFp+W4uOinpuWPkeOAglxyXG4gKlxyXG4gKiAjIyDkuKTnp43nu5nngrnms5XvvIgqKuWFiOivtOa4heWQhOiHquaIkOeri+eahOadoeS7tioq77yJXHJcbiAqXHJcbiAqIHwg57uZ5rOVIHwg5oqV5b2xIHwg5LuA5LmI5pe25YCZ6IO95L+hIHxcclxuICogfC0tLXwtLS18LS0tfFxyXG4gKiB8IGBub2RlYO+8iHV1aWQg5oiW6Lev5b6E77yJIHwg5Zy65pmv6ISa5pys5oyJKirnvJbovpHlmajnm7jmnLoqKuaKiuiKgueCueS4lueVjOefqeW9ouaKleWIsOmhtemdoiBDU1Mg5YOP57SgIHwgKirnvJbovpHmgIEqKu+8iOe8lui+keWZqOato+WcqOaYvuekuuWcuuaZr++8ieKAlOKAlCDpgqPml7bnlLvpnaLlsLHmmK/nvJbovpHlmajnm7jmnLrnlLvnmoQgfFxyXG4gKiB8IGB4YCAvIGB5YO+8iGBzcGFjZTpcInZpZXdcImAg6aG16Z2iIENTUyDlg4/ntKDvvIzmiJYgYFwidXZcImAgMH4x77yJIHwg5LiN5oqV5b2x77yM55u05o6l55SoIHwgKirku7vkvZXnirbmgIEqKu+8mui/kOihjOaAge+8iGdhbWUgdmlld++8ieS4i+eUu+mdouaYr+a4uOaIj+ebuOacuueUu+eahO+8jOiKgueCueaKleW9seS4jeaIkOeri++8jOi/meaXtuWPquiDveeUqOWdkOaghyB8XHJcbiAqXHJcbiAqIOKaoCAqKui/kOihjOaAgeS4i+e7mSBgbm9kZWAg5Lya6KKr5ouSKirvvIjkuI3mmK9cIueul+S4jeWHhlwi77yM5pivKirpgqPkuIDliLvlroPljovmoLnkuI3miJDnq4sqKu+8mlxyXG4gKiDov5DooYzmgIHnlLHmuLjmiI/oh6rlt7HnmoTnm7jmnLrmuLLmn5PvvIznvJbovpHlmajnm7jmnLrooqvol4/otbfmnaXkuobvvInjgILov5nkuI3mmK/nvLrpmbfvvIzmmK/lpoLlrp7mi5Lnu50g4oCU4oCUXHJcbiAqIOaMiemUmeeahOaKleW9seeCueS4i+WOu++8jOavlOeCueS4jeWKqOabtOWdj++8iOWug+S8mueCueWIsOWIq+eahOS4nOilv+S4iu+8jOiAjOWbnuaJp+eci+edgOWDj+aIkOWKn+S6hu+8ieOAglxyXG4gKlxyXG4gKiAjIyDjgIzmiJHngrnliLDlupXngrnliLDlk6rkuobjgI3nmoTkuKTmnaHoh6rmo4DvvIjpg73kuI3mmK/liKRcIuWvuemUmVwi77yM5piv57uZ5LqL5a6e77yJXHJcbiAqXHJcbiAqIDEuIGBwcm9iZWDvvIjpu5jorqQgdHJ1Ze+8jOWPquWcqOe8lui+keaAgee7mSBgbm9kZWAg5pe25pyJ5oSP5LmJ77yJ77ya54K55LmL5YmN6Zeu5LiA5qyh5Zy65pmv6ISa5pys55qEXHJcbiAqICAgIGBwaWNrKHgsIHkpYCDigJTigJQg57yW6L6R5Zmo6Ieq5bex55qE5ZG95Lit5rWL6K+V6K6k5Li6Kirov5nkuKrngrnmmK/lk6rkuKroioLngrkqKu+8jOWOn+agt+mZhOS4iuOAglxyXG4gKiAgICDlroPkuI4gYG5vZGVgIOS4jeS4gOiHtOWwseivtOaYjuaKleW9seaIluiKgueCuemAiemUmeS6huOAglxyXG4gKiAyLiAqKueCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlCoq77yIYGNvY29zX2NhcHR1cmVfdmlld2DvvInigJTigJQg6L+Z5piv5ZSv5LiA6IO96K+B5piOXHJcbiAqICAgIFwiQ2hyb21pdW0g55yf55qE5oqK6YKj5LiA5LiL6YCB5Yiw5LqGXCLnmoTlip7ms5XvvJtgcHJvYmVgIOWPquiDveivgeaYjlwi5oiR5Lus566X55qE5Z2Q5qCH5Zyo6aG16Z2i5LiK5piv5a+555qEXCLjgIJcclxuICpcclxuICogQHBhcmFtIHBhcmFtcyAtIGB7bm9kZT8sIHg/LCB5Pywgc3BhY2U/LCBidXR0b24/LCBjbGlja0NvdW50PywgbW9kaWZpZXJzPywgcHJvYmU/LCBwcmVzc01zPywgdGltZW91dE1zP31g44CCXHJcbiAqIEByZXR1cm5zIOWbnuaJp+mHjOW4pioq55yf5Y+R5Ye65Y6755qE6YKj5Yeg5p2h5LqL5Lu2KirvvIjnsbvlnosv5Z2Q5qCHL+aMiemUri/kv67ppbDplK7vvInkuI7miZPliLDlk6rkuIDpobXjgIJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DbGlja05vZGUocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XHJcbiAgICBjb25zdCBub2RlUmVmID0gdHlwZW9mIHBhcmFtcy5ub2RlID09PSAnc3RyaW5nJyA/IHBhcmFtcy5ub2RlLnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgaGFzUG9pbnQgPSB0eXBlb2YgcGFyYW1zLnggPT09ICdudW1iZXInIHx8IHR5cGVvZiBwYXJhbXMueSA9PT0gJ251bWJlcic7XHJcbiAgICBpZiAobm9kZVJlZiAmJiBoYXNQb2ludCkge1xyXG4gICAgICAgIHJldHVybiBjbGlja0ZhaWwoJ2Bub2RlYCDkuI4gYHhgL2B5YCDlj6rog73nu5nkuIDkuKrvvJrliY3ogIXmjInoioLngrnmipXlvbHnrpfngrnvvIzlkI7ogIXnm7TmjqXnlKjkvaDnu5nnmoTlnZDmoIfjgIInKTtcclxuICAgIH1cclxuICAgIGlmICghbm9kZVJlZiAmJiAhaGFzUG9pbnQpIHtcclxuICAgICAgICByZXR1cm4gY2xpY2tGYWlsKCfopoHnu5kgYG5vZGVg77yI6IqC54K5IHV1aWQg5oiW6Lev5b6E77yJ5oiWIGB4YC9geWDvvIjlnZDmoIfvvInkuK3nmoTkuIDkuKrjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNwYWNlID0gcGFyYW1zLnNwYWNlID09PSB1bmRlZmluZWQgPyAndmlldycgOiBTdHJpbmcocGFyYW1zLnNwYWNlKTtcclxuICAgIGlmIChzcGFjZSAhPT0gJ3ZpZXcnICYmIHNwYWNlICE9PSAndXYnKSB7XHJcbiAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChgc3BhY2Ug5Y+q6K6kIFwidmlld1wi77yI6aG16Z2iIENTUyDlg4/ntKDvvIzpu5jorqTvvInkuI4gXCJ1dlwi77yIMH4xIOeahOavlOS+i++8ie+8jOaUtuWIsCAke0pTT04uc3RyaW5naWZ5KHBhcmFtcy5zcGFjZSl944CCYCk7XHJcbiAgICB9XHJcbiAgICBpZiAoIW5vZGVSZWYgJiYgc3BhY2UgPT09ICd2aWV3Jykge1xyXG4gICAgICAgIGNvbnN0IHggPSBOdW1iZXIocGFyYW1zLngpO1xyXG4gICAgICAgIGNvbnN0IHkgPSBOdW1iZXIocGFyYW1zLnkpO1xyXG4gICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHgpIHx8ICFOdW1iZXIuaXNGaW5pdGUoeSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChgc3BhY2U6XCJ2aWV3XCIg6KaBIHgg5LiOIHkg6YO95piv5pyJ6ZmQ5pWw77yM5pS25YiwICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zLngpfSAvICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zLnkpfeOAgmApO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyAtLS0tIOKRoCDpl67lh6DkvZXvvIjoioLngrnnn6nlvaIgLyDpobXpnaLlsLrlr7ggLyDnjrDlnKjmmK/kuI3mmK/ov5DooYzmgIHvvIktLS0tXHJcbiAgICBjb25zdCBnZW9tZXRyeSA9IGF3YWl0IHJlYWROb2RlR2VvbWV0cnkobm9kZVJlZik7XHJcbiAgICBpZiAoZ2VvbWV0cnkub2sgIT09IHRydWUpIHtcclxuICAgICAgICByZXR1cm4gY2xpY2tGYWlsKGDmi7/kuI3liLDpobXpnaLlh6DkvZXvvJoke2Rlc2NyaWJlKGdlb21ldHJ5LmVycm9yKX3jgIIke1NDRU5FX1NDUklQVF9ISU5UfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFnZSA9IChnZW9tZXRyeS5wYWdlIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xyXG4gICAgY29uc3QgcnVudGltZSA9IChnZW9tZXRyeS5ydW50aW1lIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xyXG4gICAgY29uc3QgcnVubmluZyA9IHJ1bnRpbWUucnVubmluZyA9PT0gdHJ1ZTtcclxuICAgIGNvbnN0IGhyZWYgPSB0eXBlb2YgcGFnZS5ocmVmID09PSAnc3RyaW5nJyA/IHBhZ2UuaHJlZiA6ICcnO1xyXG5cclxuICAgIGNvbnN0IG5vZGVJbmZvID0gKGdlb21ldHJ5Lm5vZGUgfHwgbnVsbCkgYXMgUmVjb3JkPHN0cmluZywgYW55PiB8IG51bGw7XHJcblxyXG4gICAgLy8gLS0tLSDikaEg566X5Ye66YKj5Liq54K577yI6aG16Z2iIENTUyDlg4/ntKDvvIktLS0tXHJcbiAgICBsZXQgcHggPSAwO1xyXG4gICAgbGV0IHB5ID0gMDtcclxuICAgIGxldCBob3cgPSAnJztcclxuICAgIGlmIChub2RlUmVmKSB7XHJcbiAgICAgICAgaWYgKHJ1bm5pbmcpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChcclxuICAgICAgICAgICAgICAgIGDnjrDlnKjmmK8qKui/kOihjOaAgSoq77yI57yW6L6R5Zmo5YaF6aKE6KeI6LeR552A5ri45oiP77yJ77yM5oyJ6IqC54K55oqV5b2x54K55LiN5LqG77ya6YKj5LiA5Yi755S76Z2i55SxKirmuLjmiI/oh6rlt7HnmoTnm7jmnLoqKua4suafk++8jGAgK1xyXG4gICAgICAgICAgICAgICAgICAgICfogIzoioLngrnnn6nlvaLmmK/nlKgqKue8lui+keWZqOebuOacuioq5oqV5Ye65p2l55qEIOKAlOKAlCDkuKTogIXkuI3mmK/lkIzkuIDkuKrlj5bmma/vvIzmjInlroPngrnkvJrngrnliLDliKvnmoTlnLDmlrnljrvjgIJcXG4nICtcclxuICAgICAgICAgICAgICAgICAgICAn5Lik5p2h5Y+v55So6Lev77ya4pGgIOivtyoq5Lq65Zyo57yW6L6R5Zmo5bel5YW35qCP5LiK5oyJ5YGc5q2iKirvvIzlm57liLDnvJbovpHmgIHlho3ngrnvvIjpgILlkIjngrkgVUkg55qE6Z2Z5oCB5biD5bGA77yJ77ybJyArXHJcbiAgICAgICAgICAgICAgICAgICAgJ+KRoSDnm7TmjqXnlKjlnZDmoIfvvJrlhYggYGNvY29zX2NhcHR1cmVfdmlldyh7dmlldzpcImdhbWVcIn0pYCDnnIvmuIXnlLvpnaLvvIzlho3nlKggYGNvY29zX2NsaWNrX25vZGUoe3gsIHksIHNwYWNlOlwidXZcIn0pYOOAgicsXHJcbiAgICAgICAgICAgICAgICB7IG1vZGU6IHsgYWN0dWFsOiBydW50aW1lLm1vZGUgPz8gJ3Vua25vd24nLCBydW5uaW5nOiB0cnVlLCBzb3VyY2VzOiBydW50aW1lLnNvdXJjZXMgPz8gbnVsbCB9IH0sXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghbm9kZUluZm8gfHwgbm9kZUluZm8uZm91bmQgIT09IHRydWUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChcclxuICAgICAgICAgICAgICAgIGDmsqHmib7liLDoioLngrnjgIwke25vZGVSZWZ944CNJHtub2RlSW5mbyAmJiBub2RlSW5mby5ub3RlID8gYO+8iCR7bm9kZUluZm8ubm90ZX3vvIlgIDogJyd977yIdXVpZCDnlKggbm9kZS51dWlk77yM6Lev5b6E5b2i5aaCIENhbnZhcy9wYW5lbC9idG7vvInjgIJgLFxyXG4gICAgICAgICAgICAgICAgeyBtb2RlOiB7IGFjdHVhbDogcnVudGltZS5tb2RlID8/ICd1bmtub3duJywgcnVubmluZzogZmFsc2UsIHNvdXJjZXM6IHJ1bnRpbWUuc291cmNlcyA/PyBudWxsIH0gfSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFub2RlSW5mby5yZWN0KSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjbGlja0ZhaWwoXHJcbiAgICAgICAgICAgICAgICBg6IqC54K544CMJHtub2RlSW5mby5uYW1lIHx8IG5vZGVSZWZ944CN566X5LiN5Ye65Zyo6aG16Z2i5LiK55qE55+p5b2iJHtub2RlSW5mby5ub3RlID8gYO+8iCR7bm9kZUluZm8ubm90ZX3vvIlgIDogJyd9IOKAlOKAlCDngrnkuI3kuobkuK3lv4PjgIJgLFxyXG4gICAgICAgICAgICAgICAgeyBub2RlOiBub2RlSW5mbyB9LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZWN0ID0gbm9kZUluZm8ucmVjdCBhcyB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9O1xyXG4gICAgICAgIHB4ID0gcmVjdC54ICsgcmVjdC53aWR0aCAvIDI7XHJcbiAgICAgICAgcHkgPSByZWN0LnkgKyByZWN0LmhlaWdodCAvIDI7XHJcbiAgICAgICAgaG93ID0gYOiKgueCueefqeW9ouS4reW/g++8iHJlY3QgJHtyZWN0Lnh9LCR7cmVjdC55fSAke3JlY3Qud2lkdGh9w5cke3JlY3QuaGVpZ2h0fe+8iWA7XHJcbiAgICB9IGVsc2UgaWYgKHNwYWNlID09PSAndXYnKSB7XHJcbiAgICAgICAgY29uc3QgdXggPSBOdW1iZXIocGFyYW1zLngpO1xyXG4gICAgICAgIGNvbnN0IHV5ID0gTnVtYmVyKHBhcmFtcy55KTtcclxuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh1eCkgfHwgIU51bWJlci5pc0Zpbml0ZSh1eSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChgc3BhY2U6XCJ1dlwiIOimgSB4IOS4jiB5IOmDveaYryAwfjEg55qE5pyJ6ZmQ5pWw77yM5pS25YiwICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zLngpfSAvICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zLnkpfeOAgmApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjc3NXaWR0aCA9IHR5cGVvZiBwYWdlLmNzc1dpZHRoID09PSAnbnVtYmVyJyA/IHBhZ2UuY3NzV2lkdGggOiAwO1xyXG4gICAgICAgIGNvbnN0IGNzc0hlaWdodCA9IHR5cGVvZiBwYWdlLmNzc0hlaWdodCA9PT0gJ251bWJlcicgPyBwYWdlLmNzc0hlaWdodCA6IDA7XHJcbiAgICAgICAgaWYgKCFjc3NXaWR0aCB8fCAhY3NzSGVpZ2h0KSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjbGlja0ZhaWwoJ3NwYWNlOlwidXZcIiDopoHmjInpobXpnaLlsLrlr7jmipjnrpfvvIzkvYblnLrmma/ohJrmnKzmsqHph4/liLDpobXpnaLlrr3pq5gg4oCU4oCUIOaUueeUqCBzcGFjZTpcInZpZXdcIiDoh6rlt7HkuZjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcHggPSB1eCAqIGNzc1dpZHRoO1xyXG4gICAgICAgIHB5ID0gdXkgKiBjc3NIZWlnaHQ7XHJcbiAgICAgICAgaG93ID0gYHV2KCR7dXh9LCAke3V5fSkgw5cg6aG16Z2iICR7Y3NzV2lkdGh9w5cke2Nzc0hlaWdodH1gO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBweCA9IE51bWJlcihwYXJhbXMueCk7XHJcbiAgICAgICAgcHkgPSBOdW1iZXIocGFyYW1zLnkpO1xyXG4gICAgICAgIGhvdyA9ICfnm7TmjqXnu5nnmoTpobXpnaIgQ1NTIOWDj+e0oOWdkOaghyc7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gLS0tLSDikaIgcHJvYmXvvJrngrnkuYvliY3pl67kuIDmrKHjgIznvJbovpHlmajorqTkuLrov5nkuKrngrnkuIrmmK/lk6rkuKroioLngrnjgI3vvIjlj6rlnKjnvJbovpHmgIHmiJDnq4vvvIktLS0tXHJcbiAgICBsZXQgcHJvYmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XHJcbiAgICAvKipcclxuICAgICAqIOWPquimgeeul+WHuuS6huS4gOS4queCueWwseaOouS4gOasoe+8iCoq5LiN5Y+q5piv57uZIGBub2RlYCDml7YqKu+8ie+8muWdkOagh+aYr+iwg+eUqOaWuee7meeahO+8jOWQjOagt+WAvOW+l+efpemBk1xyXG4gICAgICogXCLnvJbovpHlmajoh6rlt7HnmoTlkb3kuK3mtYvor5XorqTkuLrpgqPlhL/mmK/ku4DkuYhcIiDigJTigJQg5a6D5LiO6LCD55So5pa555qE6aKE5pyf5LiN5LiA6Ie05pe277yM6L+Z5LiA5q2l5bCx55yB5o6J5LqG5LiA6L2u556O6K+V44CCXHJcbiAgICAgKiBgcHJvYmU6ZmFsc2VgIOWPr+S7peWFs+aOieOAglxyXG4gICAgICovXHJcbiAgICBjb25zdCB3YW50UHJvYmUgPSBwYXJhbXMucHJvYmUgIT09IGZhbHNlO1xyXG4gICAgaWYgKHdhbnRQcm9iZSkge1xyXG4gICAgICAgIHByb2JlID0gcnVubmluZ1xyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgICAgc2tpcHBlZDogJ+i/kOihjOaAgeS4i+S4jeWBmuWRveS4reaOoua1i++8mmBwaWNrYCDnlKjnmoTkuZ/mmK/nvJbovpHlmajnm7jmnLrvvIjkuI7oioLngrnmipXlvbHlkIzkuIDkuKrlj5bmma/vvInvvIzpgqPkuIDliLvlkIzmoLfkuI3miJDnq4snLFxyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiBhd2FpdCBwcm9iZVBvaW50KHB4LCBweSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gLS0tLSDikaMg55yf5Y+R5Ye65Y67IC0tLS1cclxuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBjbGlja0F0KFxyXG4gICAgICAgIHB4LFxyXG4gICAgICAgIHB5LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgYnV0dG9uOiBwYXJhbXMuYnV0dG9uID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiAoU3RyaW5nKHBhcmFtcy5idXR0b24pIGFzICdsZWZ0JyB8ICdyaWdodCcgfCAnbWlkZGxlJyksXHJcbiAgICAgICAgICAgIGNsaWNrQ291bnQ6IHR5cGVvZiBwYXJhbXMuY2xpY2tDb3VudCA9PT0gJ251bWJlcicgPyBwYXJhbXMuY2xpY2tDb3VudCA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgbW9kaWZpZXJzOiBBcnJheS5pc0FycmF5KHBhcmFtcy5tb2RpZmllcnMpID8gKHBhcmFtcy5tb2RpZmllcnMgYXMgc3RyaW5nW10pIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBwcmVzc01zOiB0eXBlb2YgcGFyYW1zLnByZXNzTXMgPT09ICdudW1iZXInID8gcGFyYW1zLnByZXNzTXMgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIGZvY3VzV2luZG93OiBwYXJhbXMuZm9jdXNXaW5kb3cgPT09IGZhbHNlID8gZmFsc2UgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBocmVmLFxyXG4gICAgKTtcclxuXHJcbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcclxuICAgICAgICBvazogb3V0Y29tZS5vayxcclxuICAgICAgICBwb2ludDogeyB4OiBNYXRoLnJvdW5kKHB4KSwgeTogTWF0aC5yb3VuZChweSksIHNwYWNlOiAndmlldycsIGhvdyB9LFxyXG4gICAgICAgIG1vZGU6IHsgYWN0dWFsOiBydW50aW1lLm1vZGUgPz8gJ3Vua25vd24nLCBydW5uaW5nLCBzb3VyY2VzOiBydW50aW1lLnNvdXJjZXMgPz8gbnVsbCB9LFxyXG4gICAgICAgIHRhcmdldDogb3V0Y29tZS50YXJnZXQgPz8gbnVsbCxcclxuICAgICAgICBtYXRjaGVkQnk6IG91dGNvbWUubWF0Y2hlZEJ5ID8/IG51bGwsXHJcbiAgICAgICAgZm9jdXNlZDogb3V0Y29tZS5mb2N1c2VkID8/IG51bGwsXHJcbiAgICAgICAgd2luZG93OiBvdXRjb21lLndpbmRvdyA/PyBudWxsLFxyXG4gICAgICAgIGV2ZW50czogb3V0Y29tZS5ldmVudHMsXHJcbiAgICAgICAgcHJvYmUsXHJcbiAgICB9O1xyXG4gICAgaWYgKCFvdXRjb21lLm9rKSB7XHJcbiAgICAgICAgcGF5bG9hZC5lcnJvciA9IG91dGNvbWUuZXJyb3I7XHJcbiAgICAgICAgaWYgKG91dGNvbWUuY29udGVudHMpIHBheWxvYWQuY29udGVudHMgPSBvdXRjb21lLmNvbnRlbnRzO1xyXG4gICAgICAgIHBheWxvYWQuaGludCA9ICfmiZPkuI3liLDpgqPkuIDpobXml7blhYggYGNvY29zX2V4ZWN1dGVfY29kZSh7Y29udGV4dDpcInNjZW5lXCIsIGNvZGU6XCJyZXR1cm4gMVwifSlgIOehruiupOWcuuaZr+i/m+eoi+WPr+eUqO+8iOayoeW8gOWcuuaZr+aXtuWcuuaZr+inhuWbvue9kemhteS5n+S4jeWcqO+8ieOAgic7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZXJyb3I6IFN0cmluZyhvdXRjb21lLmVycm9yIHx8ICfngrnlh7vlpLHotKUnKSwgZGF0YTogcGF5bG9hZCB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog4pqgIOeql+WPo+ayoeeEpueCueaXtioq5b+F6aG75oqK6L+Z5Y+l6K+d5pS+5Zyo5pyA5YmN6Z2iKirvvJrpgqPml7ZcIuS6i+S7tuWPkeWHuuWOu+S6hlwi5LiOXCLpobXpnaLmlLbliLDkuoZcIuaYr+S4pOS7tuS6i++8jFxyXG4gICAgICog6ICM5Zue5omn6buY6K6k55yL552A5YOP5oiQ5Yqf77yI5bCx5piv5pys5bel56iL5pyA6Ziy55qE6YKj56eN5YGH57u/77yJ44CCXHJcbiAgICAgKi9cclxuICAgIGlmIChvdXRjb21lLndpbmRvdyAmJiBvdXRjb21lLndpbmRvdy5mb2N1c2VkID09PSBmYWxzZSkge1xyXG4gICAgICAgIHBheWxvYWQuaGludCA9IG91dGNvbWUud2luZG93Lm5vdGU7XHJcbiAgICB9IGVsc2UgaWYgKHByb2JlICYmICFwcm9iZS5za2lwcGVkICYmIHByb2JlLnZlcmRpY3QgPT09ICdoaXQnKSB7XHJcbiAgICAgICAgcGF5bG9hZC5oaW50ID1cclxuICAgICAgICAgICAgJ+i/meS4gOS4i+ecn+WPkeWHuuWOu+S6hu+8iOeql+WPo+eEpueCueayoemXrumimO+8ieOAgioq6KaB6K+B5piO54K55a+55LqG77yM54K55YmN5ZCO5ZCE5oiq5LiA5byg5Zu+5a+55q+UKirvvIhgcHJvYmVgIOWPquiDveivgeaYjlwi6L+Z5Liq5Z2Q5qCH5Zyo6aG16Z2i5LiK5piv5a6DXCLvvIzor4HmmI7kuI3kuoZcIkNocm9taXVtIOaKiuWug+mAgeWIsOS6hlwi77yJ44CCJztcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcGF5bG9hZC5oaW50ID0gJ+i/meS4gOS4i+ecn+WPkeWHuuWOu+S6huOAgueCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlOaJjeefpemBk+acieayoeacieeUn+aViOOAgic7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGRhdGE6IHBheWxvYWQgfTtcclxufVxyXG5cclxuLyoqIOeCueiKgueCueWksei0peaXtueahOe7n+S4gOWbnuaJp++8iOS4jeaKm++8jOiuqeaooeWei+eci+WIsOWPr+ivu+eahOWOn+WboO+8ieOAgiAqL1xyXG5mdW5jdGlvbiBjbGlja0ZhaWwobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVG9vbFJlcGx5IHtcclxuICAgIGNvbnN0IHBheWxvYWQgPSB7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UsIC4uLihleHRyYSA/PyB7fSkgfTtcclxuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGVycm9yOiBtZXNzYWdlLCBkYXRhOiBwYXlsb2FkIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDpl67kuIDmrKHjgIzov5nkuKrngrnmmK/lk6rkuKroioLngrnjgI3igJTigJQg6LWw5Zy65pmv5rKZ566x6YeM55qEIGBwaWNrKHgsIHkpYO+8iOe8lui+keWZqOiHquW3seeahOWRveS4rea1i+ivle+8ieOAglxyXG4gKlxyXG4gKiDimqAg5a6D5pivKirkuovlrp4qKu+8jOS4jeaYr+WIpOaNru+8muWbnuaJp+aKiiBgdmVyZGljdGAgLyBgaGl0YCAvIOWRveS4reS4quaVsOWOn+agt+W4puWbnuadpe+8jFxyXG4gKiDnlLHosIPnlKjmlrnlhrPlrppcIui/meeul+S4jeeul+eCueWvueS6hlwi77yI5pys5omp5bGV5LiN6K6k6K+GXCLor6XngrnliLDlk6rkuKroioLngrlcIu+8ieOAglxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gcHJvYmVQb2ludCh4OiBudW1iZXIsIHk6IG51bWJlcik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBleGVjdXRlQ29kZSh7XHJcbiAgICAgICAgICAgIGNvbnRleHQ6ICdzY2VuZScsXHJcbiAgICAgICAgICAgIHRpbWVvdXRNczogODAwMCxcclxuICAgICAgICAgICAgY29kZTogJ2NvbnN0IHIgPSBwaWNrKGFyZ3MueCwgYXJncy55KTsgcmV0dXJuIHsgdmVyZGljdDogci52ZXJkaWN0LCBoaXQ6IHIuaGl0LCBoaXRDb3VudDogKHIuaGl0cyB8fCBbXSkubGVuZ3RoLCBpbnZpc2libGVDb3VudDogKHIuaW52aXNpYmxlIHx8IFtdKS5sZW5ndGggfTsnLFxyXG4gICAgICAgICAgICBhcmdzOiB7IHgsIHkgfSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCB2YWx1ZSA9IHVud3JhcFNhbmRib3hSZXN1bHQocmVwbHkuZGF0YSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKCFyZXBseS5vayB8fCAhdmFsdWUpIHJldHVybiB7IGVycm9yOiByZXBseS50ZXh0LnNsaWNlKDAsIDMwMCkgfTtcclxuICAgICAgICByZXR1cm4gdmFsdWU7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXNjcmliZShlcnJvcikgfTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIOWPkeS4gOasoemUruebmOWKqOS9nO+8iCoq55yf5LqL5Lu2KirvvInvvIznrYnku7fkuo7lnKjpgqPkuIDpobXkuIrnnJ/nmoTmjInkuoblh6DkuIvplK7jgIJcclxuICpcclxuICogYGtleWAg6LWw5oyJ5LiLL+aKrOi1t++8iOW/q+aNt+mUruOAgeaWueWQkemUruOAgUVzYyDov5nnsbtcIuaMieS4gOS4i1wi55qE5Yqo5L2c77yJ77ybXHJcbiAqIGB0ZXh0YCDotbAgYGNoYXJg77yI55yf55qE5b6A6IGa54Sm55qE6L6T5YWl5qGG6YeM5omT5a2X77yJ44CC5Lik6ICF5Y+v5Lul5LiA6LW357uZ77yI5L6L5aaCIGB7a2V5OidFbnRlcid9YO+8ieOAglxyXG4gKlxyXG4gKiDimqAgKirmnKzlt6XlhbfkuI3miqLnhKbngrkqKu+8iGB3ZWJDb250ZW50cy5mb2N1cygpYCDkvJrmiZPmlq3nlKjmiLfmraPlnKjliKvlpITmiZPlrZfvvInvvJpcclxuICog5Zue5omn6YeM55qEIGBmb2N1c2VkYCDmmK8qKuWmguWunuaKpeWHuioq55uu5qCH6aG15b2T5pe25pyJ5rKh5pyJ6ZSu55uY54Sm54K544CC6KaB5b6A6L6T5YWl5qGG5omT5a2X6ICMIGBmb2N1c2VkYCDkuLogZmFsc2Ug5pe277yMXHJcbiAqIOWFiOeUqCBgY29jb3NfY2xpY2tfbm9kZWAg54K55LiA5LiL6YKj5Liq6L6T5YWl5qGG77yI55yf54K55Ye75Lya5oqK54Sm54K55bim6L+H5Y6777yJ5YaN5Y+R5a2X44CCXHJcbiAqXHJcbiAqIEBwYXJhbSBwYXJhbXMgLSBge2tleT8sIHRleHQ/LCBtb2RpZmllcnM/LCBwcmVzc01zPywgdGFyZ2V0P31g44CCXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuU2VuZEtleXMocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XHJcbiAgICBjb25zdCBrZXkgPSB0eXBlb2YgcGFyYW1zLmtleSA9PT0gJ3N0cmluZycgPyBwYXJhbXMua2V5LnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgdGV4dCA9IHR5cGVvZiBwYXJhbXMudGV4dCA9PT0gJ3N0cmluZycgPyBwYXJhbXMudGV4dCA6ICcnO1xyXG4gICAgaWYgKCFrZXkgJiYgIXRleHQpIHJldHVybiBjbGlja0ZhaWwoJ+imgee7mSBga2V5YO+8iOaMieS4gOS4i+afkOS4qumUru+8ieaIliBgdGV4dGDvvIjovpPlhaXkuIDmrrXlrZfvvInkuK3nmoToh7PlsJHkuIDkuKrjgIInKTtcclxuXHJcbiAgICAvKiog55uu5qCH6aG155qEIGhyZWbvvJrlnLrmma/ohJrmnKzmiqXnmoTmnIDnoa7lrprvvJvmi7/kuI3liLDlsLHpgIDlm57mjIkgVVJMIOeJueW+geaJvu+8iGBmaW5kU2NlbmVWaWV3YCDnmoTlhZzlupXvvIkgKi9cclxuICAgIGNvbnN0IGdlb21ldHJ5ID0gYXdhaXQgcmVhZE5vZGVHZW9tZXRyeSgnJyk7XHJcbiAgICBjb25zdCBocmVmID0gZ2VvbWV0cnkub2sgPT09IHRydWUgJiYgdHlwZW9mIChnZW9tZXRyeS5wYWdlIHx8IHt9KS5ocmVmID09PSAnc3RyaW5nJyA/IChnZW9tZXRyeS5wYWdlIGFzIFJlY29yZDxzdHJpbmcsIGFueT4pLmhyZWYgOiAnJztcclxuXHJcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgc2VuZEtleXMoXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICBrZXksXHJcbiAgICAgICAgICAgIHRleHQsXHJcbiAgICAgICAgICAgIG1vZGlmaWVyczogQXJyYXkuaXNBcnJheShwYXJhbXMubW9kaWZpZXJzKSA/IChwYXJhbXMubW9kaWZpZXJzIGFzIHN0cmluZ1tdKSA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgcHJlc3NNczogdHlwZW9mIHBhcmFtcy5wcmVzc01zID09PSAnbnVtYmVyJyA/IHBhcmFtcy5wcmVzc01zIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBmb2N1c1dpbmRvdzogcGFyYW1zLmZvY3VzV2luZG93ID09PSBmYWxzZSA/IGZhbHNlIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgaHJlZixcclxuICAgICk7XHJcblxyXG4gICAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XHJcbiAgICAgICAgb2s6IG91dGNvbWUub2ssXHJcbiAgICAgICAga2V5OiBrZXkgfHwgbnVsbCxcclxuICAgICAgICB0ZXh0OiB0ZXh0IHx8IG51bGwsXHJcbiAgICAgICAgdGFyZ2V0OiBvdXRjb21lLnRhcmdldCA/PyBudWxsLFxyXG4gICAgICAgIG1hdGNoZWRCeTogb3V0Y29tZS5tYXRjaGVkQnkgPz8gbnVsbCxcclxuICAgICAgICBmb2N1c2VkOiBvdXRjb21lLmZvY3VzZWQgPz8gbnVsbCxcclxuICAgICAgICB3aW5kb3c6IG91dGNvbWUud2luZG93ID8/IG51bGwsXHJcbiAgICAgICAgZXZlbnRzOiBvdXRjb21lLmV2ZW50cyxcclxuICAgICAgICBocmVmU291cmNlOiBocmVmID8gJ+WcuuaZr+iEmuacrOaKpeeahCBsb2NhdGlvbi5ocmVmJyA6ICfmsqHph4/liLAgaHJlZu+8jOaMiSBVUkwg54m55b6B5om+55qEJyxcclxuICAgIH07XHJcbiAgICBpZiAoIW91dGNvbWUub2spIHtcclxuICAgICAgICBwYXlsb2FkLmVycm9yID0gb3V0Y29tZS5lcnJvcjtcclxuICAgICAgICBpZiAob3V0Y29tZS5jb250ZW50cykgcGF5bG9hZC5jb250ZW50cyA9IG91dGNvbWUuY29udGVudHM7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZXJyb3I6IFN0cmluZyhvdXRjb21lLmVycm9yIHx8ICflj5HmjInplK7lpLHotKUnKSwgZGF0YTogcGF5bG9hZCB9O1xyXG4gICAgfVxyXG4gICAgaWYgKG91dGNvbWUud2luZG93ICYmIG91dGNvbWUud2luZG93LmZvY3VzZWQgPT09IGZhbHNlKSB7XHJcbiAgICAgICAgcGF5bG9hZC5oaW50ID0gb3V0Y29tZS53aW5kb3cubm90ZTtcclxuICAgIH0gZWxzZSBpZiAob3V0Y29tZS5mb2N1c2VkID09PSBmYWxzZSkge1xyXG4gICAgICAgIHBheWxvYWQuaGludCA9ICfnm67moIfpobXlvZPml7YqKuayoeaciSoq6ZSu55uY54Sm54K5IOKAlOKAlCDmiZPlrZfnsbvvvIh0ZXh077yJ5aSa5Y2K5LiN5Lya6L+b6L6T5YWl5qGG77yb5YWI55SoIGNvY29zX2NsaWNrX25vZGUg54K55LiA5LiL6YKj5Liq6L6T5YWl5qGG5YaN5p2l44CCJztcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcGF5bG9hZC5oaW50ID0gJ+aMiemUruWPkeWHuuWOu+S6hu+8m+eCueWJjeWQjuWQhOaIquS4gOW8oOWbvu+8iOaIluWGjeivu+S4gOasoeeKtuaAge+8ieaJjeefpemBk+acieayoeacieeUn+aViOOAgic7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGRhdGE6IHBheWxvYWQgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOe7meWbnuaJp+ihpeS4gOautSBgcmVmc2DvvIjlj6/lpI3nlKjnmoTmoIfor4bvvInigJTigJQg5q+P5Liq5pa55rOV6YO96L+H6L+Z5LiA6YGT44CCXHJcbiAqXHJcbiAqIOS4pOadoeWPo+W+hO+8mlxyXG4gKlxyXG4gKiAxLiAqKuWPquWcqOaKveWIsOS4nOilv+aXtuWKqOWbnuaJpyoq77ya5LiA5p2h6YO95rKh5pyJ5bCx5Y6f5qC36L+U5Zue77yM57ud5LiN55WZ5LiL56m65aOz5a2X5q6144CCXHJcbiAqIDIuICoq5oq95Y+W5aSx6LSl5LiN566X5aSx6LSlKirvvJpgcmVmc2Ag5piv6ZmE5Yqg5L+h5oGv77yM5a6D6Ieq5bex5oqb6ZSZ57ud5LiN6IO95oqK5LiA5qyh5oiQ5Yqf55qE6LCD55So5Y+Y5oiQ5aSx6LSlXHJcbiAqICAgIO+8iOaJgOS7peWMheWcqCB0cnkg6YeM77yM6Z2Z6buY5pS+6L+H77yJ44CCXHJcbiAqXHJcbiAqIOaWh+ahiOi/veWKoOWcqCBgdGV4dGAg57uT5bC+77yI5qih5Z6L5Y+q6K+7IGB0ZXh0YCDigJTigJQg5qGl5o6l5L6nIGBPVVRQVVQucmVuZGVyYCDlj6rmuLLmn5PlroPvvInvvJtcclxuICog57uT5p6E5YyW54mI5pys5pS+IGBkYXRhLnJlZnNg77yI6Z2i5p2/5LiO55WZ5qGj55So77yJ44CCXHJcbiAqXHJcbiAqIEBwYXJhbSBoYW5kbGVyIC0g5Y6f5p2l55qE5pa55rOV5a6e546w44CCXHJcbiAqIEByZXR1cm5zIOWMheS6huS4gOWxgueahOaWueazleWunueOsOOAglxyXG4gKi9cclxuZnVuY3Rpb24gd2l0aFJlZnMoXHJcbiAgICBoYW5kbGVyOiAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTxUb29sUmVwbHk+LFxyXG4pOiAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTxUb29sUmVwbHk+IHtcclxuICAgIHJldHVybiBhc3luYyAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiA9PiB7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBoYW5kbGVyKHBhcmFtcyk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY29sbGVjdGlvbiA9IGNvbGxlY3RSZWZzKHJlcGx5LmRhdGEgPz8gcmVwbHkudGV4dCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gZm9ybWF0UmVmcyhjb2xsZWN0aW9uKTtcclxuICAgICAgICAgICAgaWYgKCFibG9jaykgcmV0dXJuIHJlcGx5O1xyXG4gICAgICAgICAgICBjb25zdCBkYXRhID0gcmVwbHkuZGF0YTtcclxuICAgICAgICAgICAgcmVwbHkuZGF0YSA9XHJcbiAgICAgICAgICAgICAgICBkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShkYXRhKVxyXG4gICAgICAgICAgICAgICAgICAgID8geyAuLi4oZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiksIHJlZnM6IGNvbGxlY3Rpb24ucmVmcyB9XHJcbiAgICAgICAgICAgICAgICAgICAgOiB7IHJlc3VsdDogZGF0YSwgcmVmczogY29sbGVjdGlvbi5yZWZzIH07XHJcbiAgICAgICAgICAgIHJlcGx5LnRleHQgPSBgJHtyZXBseS50ZXh0fSR7YmxvY2t9YDtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgLyogcmVmcyDmmK/pmYTliqDkv6Hmga/vvJrmir3kuI3lh7rmnaXlsLHkuI3liqDvvIzkuI3lvbHlk43ov5nmrKHosIPnlKggKi9cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlcGx5O1xyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIElQQyDmlrnms5XliIblj5Hooagg4oCU4oCUICoq5LiD5LiqKirjgIJcclxuICpcclxuICog4pqgIOmUruWQjeW/hemhu+S4jiBEU0gg5L6n5o+S5Lu26YeMIGBpcGNDYWxsKCcuLi4nKWAg55qE5a2X56ym5Liy5LiA6Ie0XHJcbiAqIO+8iOingSBgZHNoLXByb2ZpbGUvcGx1Z2luL2RzaC1jb2Nvcy1icmlkZ2UvaW5kZXguanNg77yJ44CCXHJcbiAqXHJcbiAqIOKblCDljp/mnaXpgqPlvKDooajph4zmnInnrKzlhavkuKrplK4gYHJ1bnRpbWVg77yI6L+Q6KGM6aKE6KeI55qE5Y+q6K+754q25oCB5o6i6ZKI77yJ77yMKioyMDI2LTEwLTA5IOWIoOaOiSoq77yaXHJcbiAqIOWug+eahOWJjei6q+aYr+S6lOS4quW8gOWFs++8iDIwMjYtMTAtMDgg5pKk5o6J77yJ77yM5pKk5Yiw5Y+q5Ymp5Y+q6K+75LmL5ZCO5LuN54S2KirmsqHmnInku7vkvZXmtojotLnogIUqKiDigJTigJRcclxuICog6L+Q6KGM5oCB5Yik5o2u5Zyo5oiq5Zu+L+eCueWHu+mTvui3r+mHjO+8jOS4jeWcqOi/meS4quW3peWFt+mHjO+8iOeQhueUseingeaWh+S7tuWktOeahOihqOS4i+mdoumCo+S4gOaute+8ieOAglxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IENPQ09TX0lQQ19NRVRIT0RTOiBSZWNvcmQ8c3RyaW5nLCAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTxUb29sUmVwbHk+PiA9IHtcclxuICAgIGV4ZWN1dGVfY29kZTogd2l0aFJlZnMocnVuRXhlY3V0ZUNvZGUpLFxyXG4gICAgZGVzY3JpYmVfYXBpOiB3aXRoUmVmcyhkZXNjcmliZUFwaSksXHJcbiAgICBlZGl0b3Jfc3RhdGU6IHdpdGhSZWZzKHJlYWRFZGl0b3JTdGF0ZSksXHJcbiAgICBjYXB0dXJlX3ZpZXc6IHdpdGhSZWZzKHJ1bkNhcHR1cmVWaWV3KSxcclxuICAgIHJlYWRfbG9nczogd2l0aFJlZnMocmVhZExvZ3MpLFxyXG4gICAgY2xpY2tfbm9kZTogd2l0aFJlZnMocnVuQ2xpY2tOb2RlKSxcclxuICAgIHNlbmRfa2V5czogd2l0aFJlZnMocnVuU2VuZEtleXMpLFxyXG59O1xyXG4iXX0=