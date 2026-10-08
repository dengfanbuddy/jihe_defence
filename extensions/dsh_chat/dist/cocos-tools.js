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
 * ## 八个方法，其中几个是「别猜 / 别瞎试」的护栏
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
 * | `runtime` | 运行预览的状态与开关（play/stop/pause/resume/step）—— **"冻住再截图"**靠它消掉时序抖动 |
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
exports.runRuntime = runRuntime;
const constants_1 = require("./constants");
const engine_1 = require("./core/engine");
const serialize_1 = require("./core/serialize");
const input_1 = require("./input");
const logs_1 = require("./logs");
const preview_1 = require("./preview");
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
     * 界面交互（点按 / 按键 / 看一眼运行态）是三条**独立通道**，不在 `execute_code` 的射程里 ——
     * 这里必须点一次名：模型在"改完 UI 想验一下"时最容易只想到截图与读节点数据。
     */
    "- **点一下试试**：cocos_click_node({node:'<节点路径>'})（真鼠标事件；运行态下要改用坐标，见该工具说明）", "- 看一眼运行态：cocos_runtime({action:'state'})（**只读**；要跑游戏请人在编辑器工具栏上按播放键，本工具不开预览）", 
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
 * 看**运行预览**（编辑器里那个 game view）的**状态** —— 只读。
 *
 * ## ⛔ 这里只剩 `state` 一个动作（2026-10-08 撤掉了开关）
 *
 * 原来有六个动作，其中 `play` / `stop` / `pause` / `resume` / `step` 会**从编辑器内部**
 * 起动那块画布上的游戏画面。**整条撤掉**了，两条理由：
 *
 * 1. **它与"编辑器画布黑掉"的两次现场都在同一条时间线上**（`docs/冻结诊断.md`：
 *    04:48 那次跑完预览起停之后场景面板画面停住、切场景也不更新，只能重启编辑器；
 *    14:59 那次面板 agent 加 `Cmp_Game` 时，同一块画布抓回来的是全空的一张图 = 用户看到的黑屏）。
 *    因果没有被单变量实验钉死（同一次窗口里还有"抓图前逼重绘"这一条，那条已按同一口径一起撤了），
 *    但**代价不对称**：留着它，用户随时可能再黑一次屏；撤掉它，损失的是一个在本工程里**跑不起来的**能力
 *    （编辑器内的游戏卡在首场景 `Loading` 的 `loadBundle('scripts')`、进度 `0%`，`bundles` 里只有 `internal`）。
 * 2. **要跑游戏有更干净的路**：编辑器工具栏那颗播放键。走那条路，画面出问题没人会怀疑是工具干的。
 *
 * ## 留下的 `state`：**两段独立来源都摆出来**
 *
 * | 来源 | 问法 | 说明 |
 * |---|---|---|
 * | 编辑器消息 | `query-scene-mode` | 只作一条来源；认不出来就是 `unknown`（见 `source/preview.ts`） |
 * | 场景进程 | `viewMetrics.runtime`（`cce.PreviewPlay._state`） | **运行态的真判据** —— facade 那两条真机实测判不出 |
 *
 * `running: true` 只可能来自**用户自己按了播放键**（本扩展已经开不了预览了）——
 * 这时节点投影 / 按节点裁图 / 按节点点击都不成立（那些都建立在编辑器相机上），
 * 回执里必须说清，别给一个"看着成功"。
 *
 * @param params - `{action?}`：只认 `'state'`（缺省就是它）；别的一律拒绝并说清为什么。
 */
async function runRuntime(params) {
    const action = typeof params.action === 'string' && params.action.trim() ? params.action.trim() : 'state';
    if (action !== 'state') {
        return clickFail(`\`cocos_runtime\` 只认 \`state\`（只读），收到 ${JSON.stringify(params.action)}。` +
            '`play` / `stop` / `pause` / `resume` / `step` 这五个开关**已于 2026-10-08 撤掉** —— ' +
            '它们与两次「编辑器场景画布黑屏/画面停住」的现场同一条时间线（见 `docs/冻结诊断.md`），' +
            '而收益极小：编辑器内跑起来会卡在首场景 Loading 的 `loadBundle(\'scripts\')`（0%）。' +
            '要看游戏画面请在**编辑器工具栏上自己按那颗播放键**，本工具不代劳。');
    }
    const payload = { ok: true, action: 'state' };
    /** 主进程这一侧的问法（编辑器自己的消息）—— 只当一条来源摆出来 */
    const modeProbe = await (0, preview_1.querySceneMode)();
    payload.editorMessage = {
        message: 'query-scene-mode',
        mode: modeProbe.mode,
        raw: modeProbe.raw,
        ok: modeProbe.ok,
        error: modeProbe.error,
        note: modeProbe.note,
    };
    /** 场景进程那一侧的问法（`cce` 单例）—— **运行态的判据在这边** */
    const sceneProbe = await (0, engine_1.readSceneRuntime)();
    payload.scene = sceneProbe.ok ? sceneProbe.runtime : { error: sceneProbe.error };
    payload.before = runtimeSummary(payload.scene);
    payload.after = payload.before;
    payload.readOnly = true;
    payload.hint =
        '`running: true` = 那一页现在画的是**跑着的游戏**（这时节点投影/裁节点都不成立，见 cocos_click_node）；' +
            '`false` = 编辑器场景。判据是 `previewState`（`stop`/`play`/`pause`）—— 真机实测 facade 那两条**判不出**运行态。' +
            '⚠ 本工具**只能看、不能开**：要跑游戏请在编辑器工具栏上自己按播放键。';
    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
}
/**
 * 从场景侧的 runtime 块里挑出"人要看的那几项"（原样搬，不做判断）。
 *
 * ⚠ `gamePaused` 是**引擎自己**的 `cc.game.isPaused()`；预览自己的暂停标志另有一格
 * `previewIsPause`（`cce.PreviewPlay.isPause()`）。两者含义不同，摆在一起看：
 * 实测 `pause(true)` 之后**三个都变 true**，但只有 `frames` 能证明"真的冻住了"。
 */
function runtimeSummary(runtime) {
    var _a, _b;
    if (!runtime || typeof runtime !== 'object')
        return null;
    const sources = (runtime.sources || {});
    return {
        mode: (_a = runtime.mode) !== null && _a !== void 0 ? _a : 'unknown',
        running: runtime.running === true,
        paused: typeof runtime.paused === 'boolean' ? runtime.paused : null,
        /** `PreviewPlay._state`（私有字段，原样搬）—— **运行态的唯一判据** */
        previewState: (_b = sources.previewState) !== null && _b !== void 0 ? _b : null,
        previewIsPause: typeof sources.previewIsPause === 'boolean' ? sources.previewIsPause : null,
        /** 帧计数：判「冻住没有 / step 有没有走」只有它能说话 */
        frames: typeof sources.totalFrames === 'number' ? sources.totalFrames : null,
        directorPaused: typeof sources.directorPaused === 'boolean' ? sources.directorPaused : null,
        gamePaused: typeof sources.gamePaused === 'boolean' ? sources.gamePaused : null,
        note: runtime.note,
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
    click_node: withRefs(runClickNode),
    send_keys: withRefs(runSendKeys),
    runtime: withRefs(runRuntime),
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29jb3MtdG9vbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvY29jb3MtdG9vbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FtREc7OztBQWtESCx3Q0FFQztBQW9CRCx3Q0FFQztBQVlELGtDQWtCQztBQXVKRCwwQ0E0SEM7QUFnQ0Qsb0NBZ0pDO0FBMENELGtDQTRDQztBQStCRCxnQ0FvQ0M7QUFsc0JELDJDQUE2RDtBQUM3RCwwQ0FPdUI7QUFDdkIsZ0RBQTJEO0FBQzNELG1DQUE0QztBQUM1QyxpQ0FBa0M7QUFDbEMsdUNBQTJDO0FBSTNDLG1CQUFtQjtBQUNuQixTQUFTLFFBQVEsQ0FBQyxLQUFjO0lBQzVCLE9BQU8sS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2xFLENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLG1CQUFtQixDQUFDLFVBQW1CO0lBQzVDLElBQUksQ0FBQyxVQUFVLElBQUksT0FBTyxVQUFVLEtBQUssUUFBUTtRQUFFLE9BQU8sVUFBVSxDQUFDO0lBQ3JFLE1BQU0sUUFBUSxHQUFHLFVBQWtDLENBQUM7SUFDcEQsT0FBTyxRQUFRLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUM7QUFDL0QsQ0FBQztBQUVELG9DQUFvQztBQUNwQyxNQUFNLGlCQUFpQixHQUNuQix1Q0FBdUM7SUFDdkMsZ0RBQWdELENBQUM7QUFFckQ7Ozs7O0dBS0c7QUFDSSxLQUFLLFVBQVUsY0FBYyxDQUFDLE1BQStCO0lBQ2hFLE9BQU8sSUFBQSxvQkFBVyxFQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFFRDs7Ozs7Ozs7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QUFXLENBQUM7SUFDaEMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxVQUFVLENBQUM7Q0FDaEMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRFNIIOeahOWOn+eUn+W3peWFt+aAjuS5iOiQveWIsOe8lui+keWZqOS4iiDigJTigJQg5Lmf5bCx5pivIElQQyDor7fmsYLnmoTmnI3liqHnq6/lrp7njrDjgIJcbiAqXG4gKiAjIyDlvJXmk47lnKjlk6rvvJrmnKzmianlsZXoh6rluKbvvIzkuI3kvp3otZbliKvnmoTmianlsZVcbiAqXG4gKiDmiafooYzog73lipvvvIjnvJbovpHlmagv5Zy65pmv5Luj56CB5rKZ566x44CB6LaF5pe244CB5pel5b+X5pS26ZuG44CB5bqP5YiX5YyW5LiK6ZmQ44CBZ2l6bW8g5rGh5p+T6L+H5ruk44CB5pKk6ZSA5b+r54Wn44CBXG4gKiByZWNpcGUg5LqU5Lu25aWX77yJ5YWo6YOo5ZyoKirmnKzmianlsZXoh6rlt7EqKueahCBgY29yZS9lbmdpbmUudHNgICsgYHNvdXJjZS9zY2VuZS50c2Ag6YeM77yMXG4gKiDotbDnvJbovpHlmagqKuWGhemDqCoq55qE6YCa6YGT77yM5LiN57uP6L+HIGxvb3BiYWNrIEhUVFDvvJpcbiAqXG4gKiBgYGBcbiAqIERTSCDlrZDov5vnqIsgLS1mb3JrIElQQy0tPiDmnKzmianlsZXkuLvov5vnqIso5pys5paH5Lu2KSAtLWNvcmUvZW5naW5lLS0+IHZtIOaymeeuse+8iGVkaXRvciDkuIrkuIvmlofvvIlcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUlC0tPiDmnKzmianlsZXlnLrmma/ohJrmnKzvvIhzY2VuZSDkuIrkuIvmlofvvIlcbiAqIGBgYFxuICpcbiAqIOWcuuaZr+iEmuacrOeUsSBgcGFja2FnZS5qc29uYCDnmoQgYGNvbnRyaWJ1dGlvbnMuc2NlbmVgIOazqOWGjO+8iGBkaXN0L3NjZW5lLmpzYO+8ie+8jFxuICog57yW6L6R5Zmo5ZyoKirmiZPlvIDlnLrmma8qKuaXtuaKiuWug+WKoOi9vei/m+W8leaTjui/m+eoiyDigJTigJQg5omA5Lul44CM5rKh5omT5byA5Zy65pmv44CN5piv5ZSv5LiA5LiA5LiqXG4gKiDpnIDopoHlkJHmqKHlnovop6Pph4rmuIXmpZrnmoTlpLHotKXmqKHlvI/vvIjop4EgYFNDRU5FX1NDUklQVF9ISU5UYO+8ieOAglxuICpcbiAqICMjIOWFq+S4quaWueazle+8jOWFtuS4reWHoOS4quaYr+OAjOWIq+eMnCAvIOWIq+eejuivleOAjeeahOaKpOagj1xuICpcbiAqIElQQyDljY/orq7opoHnqoTjgILor63kuYnmlrnms5XotorlsJHvvIxEU0gg5L6n5o+S5Lu255qE5Y+C5pWw5qCh6aqM5LiO6L+Z6YeM55qE5a6e546w6LaK5LiN5a655piT6ZSZ5L2N44CCXG4gKiDpnIDopoHmlrDog73lipvml7bkvJjlhYjmiakgYGV4ZWN1dGVfY29kZWAg55qE55So5rOV77yI5a6D5bCx5piv6YCa55So6YCD55Sf5Y+j77yJ77yM6ICM5LiN5piv5Yqg5paw5pa55rOV44CCXG4gKlxuICogfCDmlrnms5UgfCDop5LoibIgfFxuICogfC0tLXwtLS18XG4gKiB8IGBleGVjdXRlX2NvZGVgIHwg6YCa55So6YCD55Sf5Y+j44CC5YaZ5Luj56CB77yM5LiA5qyh5omn6KGM6YeM5a6M5oiQ44CM5Y+W5pWw5o2uIOKGkiDmlLnnirbmgIEg4oaSIOi/lOWbnue7k+iuuuOAjSB8XG4gKiB8IGBkZXNjcmliZV9hcGlgIHwgKirmuJDov5vlvI/miqvpnLIqKiDigJTigJQg5Yir54yc5byV5pOOL+e8lui+keWZqCBBUEnvvIzmjInpnIDmn6XkuIDkuKrlkb3lkI3nqbrpl7TmiJbkuIDkuKrnsbsgfFxuICogfCBgZWRpdG9yX3N0YXRlYCB8IOaMiemcgOiHquajgO+8muaIkeWcqOWTquS4quW3peeoiy/lnLrmma/jgIHpgInkuK3kuobku4DkuYjjgIHmspnnrrHog73kuI3og73liqggfFxuICogfCBgY2FwdHVyZV92aWV3YCB8ICoq5L6L5aSW5LiAKirvvJrmiorlnLrmma/op4blm77vvIjmiJbmn5DkuKroioLngrnvvInlrZjmiJDlm77niYfmlofku7bjgIHlm57ot6/lvoTjgILlg4/ntKDloZ7kuI3ov5vov5Tlm57lgLzkuIrpmZDvvIzlj6rog73ljZXni6zlvIDkuIDmnaHpgJrpgZPjgILpu5jorqTkvJoqKuWFiOWPluaZr+WGjeaIqioq77yIYGZpdGDvvInvvIzlm6DkuLrlsY/luZXkuIrpgqPkuIDluKfmnKrlv4XmmK/lhajmma/vvJtgdmlld2Ag6K+05piOXCLmiJHopoHnmoTmmK/nvJbovpHlmajlnLrmma/ov5jmmK/ot5HnnYDnmoTmuLjmiI9cIiB8XG4gKiB8IGByZWFkX2xvZ3NgIHwgKirkvovlpJbkuowqKu+8muivu+W3peeoi+mHjOeahOaXpeW/l+aWh+S7tuOAguaOp+WItuWPsC/ml6Xlv5fmlofku7bph4znmoTlrZcqKuS7o+eggeaLv+S4jeWIsCoq77yI6YKj5piv5Y+m5LiA5Liq6L+b56iL55qE6L6T5Ye677yJ77yM5Y+q6IO95Y2V54us5byA5LiA5p2h6YCa6YGT44CC5a6e546w5ZyoIGBsb2dzLnRzYCB8XG4gKiB8IGBjbGlja19ub2RlYCB8ICoq5L6L5aSW5LiJKirvvJrngrnkuIvljrvjgIJgc2VuZElucHV0RXZlbnRgIOWPkeeahOaYryoq55yf5LqL5Lu2KirvvIjotbAgQ2hyb21pdW0g6Ieq5bex55qE6L6T5YWl566h57q/77yJ77yM5pS55LiN5LqG54q25oCB55qE6YKj56eNXCLosIPkuIDkuIvlm57osINcIuS4jeeul+aVsOOAguWunueOsOWcqCBgaW5wdXQudHNgIHxcbiAqIHwgYHNlbmRfa2V5c2AgfCDlkIzkuIrvvIzplK7nm5jpgqPkuIDljYrvvIjlv6vmjbfplK4gLyDovpPlhaXmloflrZfvvIkgfFxuICogfCBgcnVudGltZWAgfCDov5DooYzpooTop4jnmoTnirbmgIHkuI7lvIDlhbPvvIhwbGF5L3N0b3AvcGF1c2UvcmVzdW1lL3N0ZXDvvInigJTigJQgKipcIuWGu+S9j+WGjeaIquWbvlwiKirpnaDlroPmtojmjonml7bluo/mipbliqggfFxuICpcbiAqICMjIOWHuuWPo+e7n+S4gOihpSBgcmVmc2BcbiAqXG4gKiDmr4/kuKrmlrnms5XnmoTlm57miafpg73kvJrnu48gYHdpdGhSZWZzYCDov4fkuIDpgZPvvJrmiornu5Pmnpzph4zlh7rnjrDov4fnmoQqKuWFqOW9oiB1dWlkIC8gYGRiOi8vYCDot6/lvoQqKlxuICog5Y676YeN5ZCO5o6S6L+b5paH5qGI57uT5bC+77yI57uT5p6E5YyW54mI5pys5ZyoIGBkYXRhLnJlZnNg77yJ44CC55CG55Sx5piv5a6D55u05o6l55yB5o6J5LiA6L2u5b6A6L+UIOKAlOKAlFxuICog5LiN54S25qih5Z6L6KaB5LmI6YeN5p+l5LiA5qyh77yM6KaB5LmI5Yet6K6w5b+G57yW5LiA5Liq77yIYFNLSUxMLm1kYCDph4zkuJPpl6jlhpnov4fjgIzliKvnjJwgdXVpZOOAje+8ieOAglxuICog6L+Z5LiA5bGCKirlj6rlgZrmkKzov5DvvIzkuI3lgZrliKTmlq0qKu+8muS4jeiupOivhlwi5ZOq5LiqIHV1aWQg5pu06YeN6KaBXCLvvIzkuZ/ku47kuI3mlLnlhpnljp/mnInmlofmoYjjgIJcbiAqXG4gKiAjIyBkZXNjcmliZV9hcGkg55qE5Lik5L6n6LWw5LqG5Lik5p2h5LiN5ZCM55qE6LevXG4gKlxuICogLSAqKmVkaXRvciDkvqcqKu+8mue8lui+keWZqOS4u+i/m+eoi+eahOWPjeWwhOayoeacieWvueWklua2iOaBr++8jOaJgOS7pei/memHjOiHquW3seWunueOsO+8iOe6r+WPjeWwhO+8jOe6piA5MCDooYzvvInvvIxcbiAqICAg5L2GIGBoZWxwZXJzYCDkuIDmoaMqKuWbnuaymeeusemXrioqIGBoZWxwZXJOYW1lcygpYCDigJTigJQg5Yqp5omL5riF5Y2V5piv5rKZ566x6Ieq5bex55qE5LqL5a6e77yMXG4gKiAgIOaKhOS4gOS7veW/heeEtui/h+acn+OAglxuICogLSAqKnNjZW5lIOS+pyoq77ya6L2s5Y+R57uZ5pys5omp5bGV55qE5Zy65pmv6ISa5pys77yIYGRlc2NyaWJlQXBpYO+8ieOAguexu+eahOWxnuaAp+WQjeimgeS7jiBgX19wcm9wc19fYCArXG4gKiAgIOWunuaXtuWunuS+i+S4iuivu++8jOmCo+mDqOWIhuaYryBgc2NlbmUudHNgIOmHjOacgOS4jeivpemHjeWGmeeahOS7o+eggeOAglxuICpcbiAqIOKaoCBgZXhlY3V0ZS1zY2VuZS1zY3JpcHRgICoq6ZyA6KaB5Zy65pmv6L+b56iL6YeM5bey57uP5Yqg6L295LqG5pys5omp5bGV6ISa5pysKirvvIjopoHmnInlnLrmma/miZPlvIDvvInjgIJcbiAqIOayoeWKoOi9veaXtuaKm+mUmSDigJTigJQg5omA5Lul6YKj5LiA5qGj5b+F6aG75oqK5aSx6LSl57+76K+R5oiQ44CM5YWI5omT5byA5LiA5Liq5Zy65pmv44CN44CCXG4gKi9cblxuaW1wb3J0IHsgRVhURU5TSU9OX05BTUUsIHR5cGUgVG9vbFJlcGx5IH0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHtcbiAgICBjYXB0dXJlVmlldyxcbiAgICBkZXNjcmliZVNjZW5lQXBpLFxuICAgIGV4ZWN1dGVDb2RlLFxuICAgIHBpbmdTY2VuZVNjcmlwdCBhcyBwaW5nU2NlbmUsXG4gICAgcmVhZE5vZGVHZW9tZXRyeSxcbiAgICByZWFkU2NlbmVSdW50aW1lLFxufSBmcm9tICcuL2NvcmUvZW5naW5lJztcbmltcG9ydCB7IGNvbGxlY3RSZWZzLCBmb3JtYXRSZWZzIH0gZnJvbSAnLi9jb3JlL3NlcmlhbGl6ZSc7XG5pbXBvcnQgeyBjbGlja0F0LCBzZW5kS2V5cyB9IGZyb20gJy4vaW5wdXQnO1xuaW1wb3J0IHsgcmVhZExvZ3MgfSBmcm9tICcuL2xvZ3MnO1xuaW1wb3J0IHsgcXVlcnlTY2VuZU1vZGUgfSBmcm9tICcuL3ByZXZpZXcnO1xuXG5leHBvcnQgdHlwZSB7IFRvb2xSZXBseSB9O1xuXG4vKiog5oqK5Lu75oSP5byC5bi45pS25pWb5oiQ5LiA5Y+l6K+d44CCICovXG5mdW5jdGlvbiBkZXNjcmliZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuLyoqXG4gKiDliaXmjonmspnnrrHnu5PmnpzlpJbpnaLpgqPlsYLkv6HlsIHjgIJcbiAqXG4gKiBgc3RydWN0dXJlZGAvYGRhdGFgIOeahOW9oueKtuaYryBgeyBvaywgY29udGV4dCwgZHVyYXRpb25NcywgcmVzdWx0IH1g77yIYHJlc3VsdGAg5omN5pivIGByZXR1cm5gIOeahOWAvO+8ie+8jFxuICog5L2G6ZSZ6K+v5YiG5pSv6YeM5rKh5pyJIGByZXN1bHRg44CB5Y+q5pyJIGBlcnJvcmDjgILmiYDku6Xov5nph4zlgZrjgIzmnIkgcmVzdWx0IOWwseWPliByZXN1bHTjgI3nmoTlrrnplJnop6PljIXvvIxcbiAqIOiuqeiwg+eUqOaWueaLv+WIsOeahOawuOi/nOaYryoq5rKZ566x6YeMIHJldHVybiDnmoTpgqPkuKrkuJzopb8qKuOAglxuICpcbiAqIEBwYXJhbSBzdHJ1Y3R1cmVkIC0g5rKZ566x5Zue5omn55qEIGBkYXRhYCDlrZfmrrXjgIJcbiAqIEByZXR1cm5zIOaymeeusei/lOWbnuWAvO+8m+aXoOazleWIpOWumuaXtuWOn+agt+i/lOWbnuOAglxuICovXG5mdW5jdGlvbiB1bndyYXBTYW5kYm94UmVzdWx0KHN0cnVjdHVyZWQ6IHVua25vd24pOiB1bmtub3duIHtcbiAgICBpZiAoIXN0cnVjdHVyZWQgfHwgdHlwZW9mIHN0cnVjdHVyZWQgIT09ICdvYmplY3QnKSByZXR1cm4gc3RydWN0dXJlZDtcbiAgICBjb25zdCBlbnZlbG9wZSA9IHN0cnVjdHVyZWQgYXMgeyByZXN1bHQ/OiB1bmtub3duIH07XG4gICAgcmV0dXJuICdyZXN1bHQnIGluIGVudmVsb3BlID8gZW52ZWxvcGUucmVzdWx0IDogc3RydWN0dXJlZDtcbn1cblxuLyoqIOWcuuaZr+iEmuacrOayoeWKoOi9veaXtueahOe7n+S4gOaWh+ahiO+8iOWkmuaVsOaDheWGteaYr+OAjOayoeacieaJk+W8gOWcuuaZr+OAje+8ieOAgiAqL1xuY29uc3QgU0NFTkVfU0NSSVBUX0hJTlQgPVxuICAgICfpgJrluLjmmK8qKuW9k+WJjeayoeacieaJk+W8gOWcuuaZryoq77yI5Zy65pmv6L+b56iL5Y+q5Zyo5pyJ5Zy65pmv5omT5byA5pe25omN5Yqg6L295omp5bGV6ISa5pys77yJ44CCJyArXG4gICAgJ+ivt+WcqCBDb2NvcyBDcmVhdG9yIOmHjOaJk+W8gOS7u+aEj+WcuuaZr+WQjumHjeivle+8m+iLpeWImuWQr+eUqOacrOaJqeWxle+8jOmHjeWQr+S4gOasoee8lui+keWZqOabtOeos+OAgic7XG5cbi8qKlxuICog5Zyo57yW6L6R5Zmo6YeM5omn6KGM5LiA5q615Luj56CB77yIZWRpdG9yIOi1sCB2bSDmspnnrrHvvIxzY2VuZSDotbDmnKzmianlsZXnmoTlnLrmma/ohJrmnKzvvInjgIJcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtjb250ZXh0LCBjb2RlLCBhcmdzLCB0aW1lb3V0TXMsIHNuYXBzaG90fWDjgIJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m+Wksei0peS5n+i/lOWbniBgb2s6ZmFsc2VgIOiAjOS4jeaYr+aKm++8iOiuqeaooeWei+eci+WIsOWPr+ivu+eahOWOn+WboO+8ieOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRXhlY3V0ZUNvZGUocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgcmV0dXJuIGV4ZWN1dGVDb2RlKHBhcmFtcyk7XG59XG5cbi8qKlxuICog5oiq5LiA5bygKirlnLrmma/op4blm74qKu+8iOaIluWFtuS4reS4gOS4quiKgueCue+8ieW5tuWtmOaIkOWbvueJh+aWh+S7tu+8iOWunueOsOWcqCBgY29yZS9lbmdpbmUudHNgICtcbiAqIGBzb3VyY2UvY2FwdHVyZS50c2AgKyBgc291cmNlL3NjZW5lLnRzYO+8ieOAglxuICpcbiAqIOS4uuS7gOS5iOWNleeLrOS4gOS4quaWueazle+8muWbvueJh+aYr+S6jOi/m+WIti/lpKflrZfnrKbkuLLvvIzloZ7kuI3ov5sgYGV4ZWN1dGVfY29kZWAg55qE6L+U5Zue5YC85LiK6ZmQXG4gKiDvvIjljZXlrZfnrKbkuLIgNDAwMCDlrZfvvInigJTigJQg5omA5Lul5a6D5b+F6aG75piv44CM5bel5YW3IOKGkiDokL3nm5gg4oaSIOWbnui3r+W+hOOAjei/meS4gOadoeeLrOeri+mAmumBk+OAglxuICpcbiAqIOS4pOadoemAmumBk++8iOWbnuaJp+mHjOeahCBgbWV0aG9kYCDkvJrlhpnmmI7mmK/lk6rmnaHvvInvvJoqKuS4u+i/m+eoiyBFbGVjdHJvbioq77yIYHdlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKClgXG4gKiDor7vlkIjmiJDlkI7nmoTnlLvpnaLvvIznqbrlm77ml7YgYGludmFsaWRhdGUoKWAg6YC85LiA5qyh6YeN57uY77yJ5LyY5YWI77yb5Zy65pmv6L+b56iL6K+7IEdMIOWQjuWkh+e8k+WGsuWPquS9nOWFnOW6leOAglxuICpcbiAqIGBmaXRgIOaYr+OAjOeUqOaIt+e8qeaUvui/h+S5i+WQju+8jOWxj+W5leS4iumCo+S4gOW4p+acquW/heaYr+WFqOaZr+OAjeeahOino+azle+8muaIquWbvuWJjeWFiOaKiuebuOacuuaRhuWIsOahhuS9j+ebruagh+eahOS9jee9ruOAgVxuICog5oiq5a6M56uL5Yi76L+Y5Y6f77yIYGF1dG9gIOWPquWcqOmcgOimgeaXtuaJjeWKqOebuOacuu+8m2Bub25lYCDlrozlhajkuI3liqjvvInjgILotKbmnKzlnKjlm57miafnmoQgYGZyYW1pbmdgIOmHjOOAglxuICpcbiAqIEBwYXJhbSBwYXJhbXMgLSBge3NhdmVQYXRoPywgbm9kZT8sIHBhZGRpbmc/LCBmaXQ/LCBtYXhXaWR0aD8sIGZvcm1hdD8sIHF1YWxpdHk/LCB3YWl0TXM/LCB0aW1lb3V0TXM/fWDjgIJcbiAqICAgYG5vZGVgIOe7mSB1dWlkIOaIlui3r+W+hO+8iGBDYW52YXMvc2tpbGxfZGV0YWlsc2DvvInml7blj6rmiKrpgqPkuIDkuKroioLngrnvvJtcbiAqICAgYGZpdGAgPSBgYXV0b2DvvIjpu5jorqTvvIkvIGBzY2VuZWAgLyBgbm9kZWAgLyBgbm9uZWDvvIjor6bop4EgYGNvcmUvZW5naW5lLnRzYCDnmoQgYGNhcHR1cmVWaWV3YO+8ieOAglxuICogQHJldHVybnMgYGRhdGEucGF0aGAg5piv5Zu+54mH57ud5a+56Lev5b6E77yM5Y+v55u05o6l5ZaC57uZ5Zu+54mH6K+75Y+W5bel5YW344CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DYXB0dXJlVmlldyhwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICByZXR1cm4gY2FwdHVyZVZpZXcocGFyYW1zKTtcbn1cblxuLyoqXG4gKiDmn6XkuIDkuKogQVBJIOWumuS5iSDigJTigJQgKirmuJDov5vlvI/miqvpnLIqKu+8jOS5n+aYr+OAjOWIq+eMnOW8leaTjiBBUEnjgI3ov5nmnaHop4Tnn6nnmoTmiafooYzogIXjgIJcbiAqXG4gKiDkuLrku4DkuYjlgLzlvpfljZXni6zkuIDkuKrlt6XlhbfvvJrmqKHlnovlhpnnvJbovpHlmajku6PnoIHml7bmnIDniLHnno7njJzlsZ7mgKflkI3vvIhgY29tcC5mb3ZgIOi/mOaYr1xuICogYGNvbXAuZm92QXhpc2DvvInvvIznjJzplJnkuIDmrKHnmoTku6Pku7fmmK/kuIDmlbTova7lvoDov5TjgILov5nph4znu5nnmoTmmK8qKui/kOihjOaXtuWPjeWwhCoq55qE57uT5p6c77yMXG4gKiDmsLjov5zmr5Tku7vkvZXnvJPlrZgv5paH5qGj5paw77ybc2NlbmUg5L6n5bimIGBub2RlVXVpZGAg5pe26L+Y6IO96KGl5Ye6KirlvZPliY3lgLwqKuOAglxuICpcbiAqIEBwYXJhbSBwYXJhbXMgLSBge2NvbnRleHQsIHRhcmdldCwgbm9kZVV1aWQsIGxpbWl0fWDjgIJcbiAqIEByZXR1cm5zIOW3peWFt+WbnuaJp++8m2B0ZXh0YCDmmK/nu5nmqKHlnovnnIvnmoQgSlNPTuOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVzY3JpYmVBcGkocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgY29uc3QgY29udGV4dCA9IHBhcmFtcy5jb250ZXh0ID09PSAnc2NlbmUnID8gJ3NjZW5lJyA6ICdlZGl0b3InO1xuICAgIGNvbnN0IHRhcmdldCA9IHR5cGVvZiBwYXJhbXMudGFyZ2V0ID09PSAnc3RyaW5nJyA/IHBhcmFtcy50YXJnZXQudHJpbSgpIDogJyc7XG4gICAgY29uc3Qgbm9kZVV1aWQgPSB0eXBlb2YgcGFyYW1zLm5vZGVVdWlkID09PSAnc3RyaW5nJyA/IHBhcmFtcy5ub2RlVXVpZCA6ICcnO1xuICAgIGNvbnN0IGxpbWl0ID0gY2xhbXBMaW1pdChwYXJhbXMubGltaXQpO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9XG4gICAgICAgICAgICBjb250ZXh0ID09PSAnZWRpdG9yJ1xuICAgICAgICAgICAgICAgID8gYXdhaXQgZGVzY3JpYmVFZGl0b3JBcGkodGFyZ2V0LCBsaW1pdClcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGRlc2NyaWJlU2NlbmVBcGkodGFyZ2V0LCBub2RlVXVpZCwgbGltaXQpO1xuICAgICAgICByZXR1cm4geyBvazogcGF5bG9hZC5vayAhPT0gZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBkYXRhOiBwYXlsb2FkIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIHRleHQ6IGDmn6Xor6IgQVBJIOWumuS5ieWksei0pe+8iCR7Y29udGV4dH0gLyAke3RhcmdldCB8fCAnKOaAu+iniCknfe+8ie+8miR7ZGVzY3JpYmUoZXJyb3IpfVxcbiR7U0NFTkVfU0NSSVBUX0hJTlR9YCxcbiAgICAgICAgfTtcbiAgICB9XG59XG5cbi8qKiDliJfooajnsbvlj4LmlbDnu5/kuIDlpLnliLAgMX41MDDvvIjpu5jorqQgODDvvInjgIIgKi9cbmZ1bmN0aW9uIGNsYW1wTGltaXQodmFsdWU6IHVua25vd24pOiBudW1iZXIge1xuICAgIGNvbnN0IHJhdyA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgudHJ1bmModmFsdWUpIDogODA7XG4gICAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKDUwMCwgcmF3KSk7XG59XG5cbi8qKlxuICog5bi455So6LCD55So6YCf5p+lIOKAlOKAlCDmlL7mgLvop4jph4zvvIzorqnmqKHlnovlsJHotbDlh6Dova7or5XplJnjgIJcbiAqXG4gKiDov5nlh6DmnaHmmK8qKue6r+aWh+acrOefpeivhioq77yI5LiN5piv6IO95Y+N5bCE5Ye65p2l55qE5Lic6KW/77yJ77yM5omA5Lul5YaZ5oiQ5bi46YeP5piv5Y+v5Lul5o6l5Y+X55qE77ybXG4gKiDpgLvovpHliKvmioTvvIjop4EgYGRlc2NyaWJlRWRpdG9yQXBpYCDph4wgYGhlbHBlcnNgIOmCo+S4gOaho+eahOWkhOeQhuaWueW8j++8ieOAglxuICovXG5jb25zdCBFRElUT1JfQ0hFQVRTSEVFVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICDotYTmupDmn6Xor6I6IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiAnZGI6Ly9hc3NldHMvKiovKi5wcmVmYWInIH0pXCIsXG4gICAg6LWE5rqQ6K+m5oOFOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmxPclV1aWQpXCIsXG4gICAg5Yi35paw6LWE5rqQOiBcImF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlZnJlc2gtYXNzZXQnLCAnZGI6Ly9hc3NldHMnKVwiLFxuICAgIOS/neWtmOWcuuaZrzogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJylcIixcbiAgICDmiZPlvIDlnLrmma86IFwiYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnb3Blbi1zY2VuZScsIHNjZW5lQXNzZXRVdWlkKVwiLFxuICAgIOmAieS4rei1hOa6kDogXCJhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdzZXQtYXNzZXQtdXVpZC1zZWxlY3Rpb24nLCB1dWlkKVwiLFxuICAgIOivu+iuvue9rjogXCJhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRDb25maWcoJzzmianlsZXlkI0+JywgJ2tleScsICdsb2NhbCcpXCIsXG4gICAg5bel56iL6Lev5b6EOiAnRWRpdG9yLlByb2plY3QucGF0aCcsXG4gICAg57yW6L6R5Zmo54mI5pysOiAnRWRpdG9yLkFwcC52ZXJzaW9uJyxcbiAgICDmjqfliLblj7Dml6Xlv5c6ICdFZGl0b3IuTG9nZ2VyLnF1ZXJ5KCknLFxufTtcblxuLyoqXG4gKiDnvJbovpHlmajkuLvov5vnqIvkvqfnmoTlj43lsITvvIhgY29yZS9lbmdpbmUudHNgIOmHjOayoeacieWvueW6lOeahOWvueWklua2iOaBr++8jOaJgOS7pei/memHjOiHquW3seWunueOsO+8ieOAglxuICpcbiAqIOWbm+aho++8muaAu+iniCAvIGBoZWxwZXJzYCAvIGBtb2R1bGU6eHh4YCAvIGBFZGl0b3IuWHh4Lll5eWDjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVzY3JpYmVFZGl0b3JBcGkodGFyZ2V0OiBzdHJpbmcsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgZWRpdG9yQW55ID0gRWRpdG9yIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICBjb25zdCBuYW1lc3BhY2VzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbWV0aG9kQ291bnQ6IG51bWJlcjsgc2FtcGxlOiBzdHJpbmdbXSB9PiA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhlZGl0b3JBbnkpLnNvcnQoKSkge1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBlZGl0b3JBbnlba2V5XTtcbiAgICAgICAgICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgY29udGludWU7XG4gICAgICAgICAgICBsZXQgbWV0aG9kTmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG1ldGhvZE5hbWVzID0gT2JqZWN0LmtleXModmFsdWUgYXMgb2JqZWN0KS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICAgIChrKSA9PiB0eXBlb2YgKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXSA9PT0gJ2Z1bmN0aW9uJyxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kTmFtZXMgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG5hbWVzcGFjZXMucHVzaCh7IG5hbWU6IGtleSwgbWV0aG9kQ291bnQ6IG1ldGhvZE5hbWVzLmxlbmd0aCwgc2FtcGxlOiBtZXRob2ROYW1lcy5zbGljZSgwLCA4KSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBraW5kOiAnaW5kZXgnLFxuICAgICAgICAgICAgY29udGV4dDogJ2VkaXRvcicsXG4gICAgICAgICAgICBuYW1lc3BhY2VzLFxuICAgICAgICAgICAgY2hlYXRzaGVldDogRURJVE9SX0NIRUFUU0hFRVQsXG4gICAgICAgICAgICBoaW50OlxuICAgICAgICAgICAgICAgIFwi55SoIGNvY29zX2Rlc2NyaWJlX2FwaSh7Y29udGV4dDonZWRpdG9yJywgdGFyZ2V0OidFZGl0b3IuTWVzc2FnZSd9KSDnnIvmn5DkuKrlkb3lkI3nqbrpl7TnmoTmlrnms5XlhajooajvvJtcIiArXG4gICAgICAgICAgICAgICAgXCJ0YXJnZXQ6J2hlbHBlcnMnIOeci+aymeeuseWKqeaJi++8m3RhcmdldDonbW9kdWxlOmZzJyDnnIvmn5DkuKogbm9kZSDmqKHlnZfnmoTlr7zlh7rjgIJcIixcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDimqAgKirliKvmioTliqnmiYvmuIXljZUqKu+8muWug+eUseaymeeuseazqOWFpe+8iGBjb3JlL2VuZ2luZS50c2Ag55qEIGBidWlsZEVkaXRvckhlbHBlcnNgICsgcmVjaXBlIOS6lOS7tuWll++8ie+8jFxuICAgICAqIOaKhOS4gOS7veeahOS4i+WcuuaYr+OAjOafpeWIsOeahOWHveaVsOWcqOaymeeusemHjOS4jeWtmOWcqOOAjeOAguaJgOS7pei/meS4gOahoyoq5Zue5rKZ566x6ZeuKirjgIJcbiAgICAgKi9cbiAgICBpZiAodGFyZ2V0ID09PSAnaGVscGVycycpIHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBydW5FeGVjdXRlQ29kZSh7IGNvbnRleHQ6ICdlZGl0b3InLCB0aW1lb3V0TXM6IDgwMDAsIGNvZGU6ICdyZXR1cm4gaGVscGVyTmFtZXMoKTsnIH0pO1xuICAgICAgICBjb25zdCBuYW1lcyA9IHVud3JhcFNhbmRib3hSZXN1bHQocmVwbHkuZGF0YSk7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShuYW1lcykpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwga2luZDogJ2hlbHBlcnMnLCBjb250ZXh0OiAnZWRpdG9yJywgZXJyb3I6IHJlcGx5LnRleHQuc2xpY2UoMCwgODAwKSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBraW5kOiAnaGVscGVycycsIGNvbnRleHQ6ICdlZGl0b3InLCBoZWxwZXJzOiBuYW1lcyB9O1xuICAgIH1cblxuICAgIGlmICh0YXJnZXQuc3RhcnRzV2l0aCgnbW9kdWxlOicpKSB7XG4gICAgICAgIGNvbnN0IG1vZHVsZU5hbWUgPSB0YXJnZXQuc2xpY2UoJ21vZHVsZTonLmxlbmd0aCkudHJpbSgpO1xuICAgICAgICBpZiAoIW1vZHVsZU5hbWUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdtb2R1bGU6IOWQjumdouimgei3n+aooeWdl+WQje+8jOWmgiBtb2R1bGU6ZnMnIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBsb2FkZWQgPSByZXF1aXJlKG1vZHVsZU5hbWUpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKGxvYWRlZCB8fCB7fSkuc29ydCgpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgICAgICBraW5kOiAnbW9kdWxlJyxcbiAgICAgICAgICAgICAgICBtb2R1bGU6IG1vZHVsZU5hbWUsXG4gICAgICAgICAgICAgICAgZXhwb3J0Q291bnQ6IGtleXMubGVuZ3RoLFxuICAgICAgICAgICAgICAgIGV4cG9ydHM6IGtleXMuc2xpY2UoMCwgbGltaXQpLFxuICAgICAgICAgICAgICAgIGhpbnQ6IGDlnKggY29jb3NfZXhlY3V0ZV9jb2RlIOmHjOebtOaOpSBcXGByZXR1cm4gcmVxdWlyZSgnJHttb2R1bGVOYW1lfScpXFxgIOWPr+S7peaLv+WIsOecn+WunuWvueixoeOAgmAsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYHJlcXVpcmUoJyR7bW9kdWxlTmFtZX0nKSDlpLHotKXvvJoke2Rlc2NyaWJlKGVycm9yKX1gIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDmjInngrnliIbot6/lvoTlnKggRWRpdG9yIOS4iui1sO+8iGBFZGl0b3IuTWVzc2FnZWAg5LiOIGBNZXNzYWdlYCDkuKTnp43lhpnms5Xpg73orqTvvIlcbiAgICBjb25zdCBwYXJ0cyA9IHRhcmdldC5yZXBsYWNlKC9eRWRpdG9yXFwuPy8sICcnKS5zcGxpdCgnLicpLmZpbHRlcihCb29sZWFuKTtcbiAgICBsZXQgbm9kZTogdW5rbm93biA9IEVkaXRvcjtcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcbiAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fe+8iOWcqCAke3BhcnR9IOWkhOaWremTvu+8iWAgfTtcbiAgICAgICAgbm9kZSA9IChub2RlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtwYXJ0XTtcbiAgICB9XG4gICAgaWYgKG5vZGUgPT09IG51bGwgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5YiwICR7dGFyZ2V0fWAgfTtcbiAgICBpZiAodHlwZW9mIG5vZGUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBraW5kOiAndmFsdWUnLCB0YXJnZXQsIHZhbHVlOiBTdHJpbmcobm9kZSkgfTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2RzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhub2RlIGFzIG9iamVjdCkuc29ydCgpKSB7XG4gICAgICAgIGxldCBlbnRyeTogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGVudHJ5ID0gKG5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiBlbnRyeSA9PT0gJ2Z1bmN0aW9uJykgbWV0aG9kcy5wdXNoKGtleSk7XG4gICAgICAgIGVsc2UgdmFsdWVzLnB1c2goa2V5KTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAga2luZDogJ25hbWVzcGFjZScsXG4gICAgICAgIHRhcmdldDogYEVkaXRvci4ke3BhcnRzLmpvaW4oJy4nKX1gLFxuICAgICAgICBtZXRob2RzOiBtZXRob2RzLnNsaWNlKDAsIGxpbWl0KSxcbiAgICAgICAgbWV0aG9kQ291bnQ6IG1ldGhvZHMubGVuZ3RoLFxuICAgICAgICB2YWx1ZXM6IHZhbHVlcy5zbGljZSgwLCBNYXRoLm1pbigzMCwgbGltaXQpKSxcbiAgICAgICAgaGludDogYOiwg+eUqOW9ouWmgiBcXGBhd2FpdCAke3RhcmdldH0ueHh4KC4uLilcXGDvvJvlj4LmlbDpobrluo/op4HnvJbovpHlmajlrpjmlrnmlofmoaPvvIzmiJbnm7TmjqXor5XosIPnnIvmiqXplJnjgIJgLFxuICAgIH07XG59XG5cbi8qXG4gKiDlnLrmma/kvqfnmoTlj43lsITvvIhgZGVzY3JpYmVTY2VuZUFwaWDvvInkuI7mjqLmtLvvvIhgcGluZ1NjZW5lU2NyaXB0YO+8iemDveWcqCBgY29yZS9lbmdpbmUudHNgIOmHjCDigJTigJRcbiAqIOWug+S7rOWPquaYryBgZXhlY3V0ZS1zY2VuZS1zY3JpcHRgIOeahOS4gOWxguiWhOWwgeijhe+8jOayoeW/heimgeWcqOi/memHjOWGjeaKhOS4gOS7veOAglxuICovXG5cbi8qKlxuICog55yL5LiA55y857yW6L6R5Zmo546w5Zyo5piv5LuA5LmI54q25oCB44CCXG4gKlxuICog5LiJ5Z2X5L+h5oGv5p2l6Ieq5LiN5ZCM6L+b56iL77yaXG4gKiAtICoq5bel56iLL+eJiOacrCoq77ya5Li76L+b56iL55qEIGBFZGl0b3IuUHJvamVjdGAgLyBgRWRpdG9yLkFwcGDvvJtcbiAqIC0gKirpgInkuK0qKu+8muS4u+i/m+eoi+mXriBgc2NlbmVgIOWMheeahCBgcXVlcnktbm9kZS10cmVlYO+8m1xuICogLSAqKuWcuuaZryoq77ya5YCf5pys5omp5bGV55qE5Zy65pmv5rKZ566x6LeR5LiA5bCP5q6177yIYGRpcmVjdG9yLmdldFNjZW5lKClg77yJ44CCXG4gKlxuICog5YaN5Yqg5LiA5Z2XKirog73lipvmjqLmtLsqKu+8iOW+iOWAvOmSseeahOmCo+mDqOWIhu+8ie+8muWcuuaZr+iEmuacrOWKoOi9veS6huayoeaciSDigJTigJRcbiAqIOaooeWei+aNruatpOaPkOWJjeefpemBk+OAjOaOpeS4i+adpeiDveS4jeiDveWKqOWcuuaZr+OAje+8jOiAjOS4jeaYr+WGmeS6huS4gOWxj+S7o+eggeaJjeWPkeeOsOayoeaJk+W8gOWcuuaZr+OAglxuICpcbiAqIOS7u+S9leS4gOWdl+aLv+S4jeWIsOmDvSoq5LiN6Zi75patKirmlbTkvZPigJTigJTov5Tlm57lt7LmnInnmoTpg6jliIYgKyDkuIDmnaEgYOKApuivu+WPluWksei0pe+8muWOn+WboGDvvIzmr5TmlbTkuKrlt6XlhbflpLHotKXmnInnlKjjgIJcbiAqXG4gKiBAcGFyYW0gX3BhcmFtcyAtIGB7dmVyYm9zZT99YO+8iOW9k+WJjSB2ZXJib3NlIOWPquW9seWTjeaYr+WQpumZhOS4iui/kOihjOaXtuiviuaWre+8ieOAglxuICogQHJldHVybnMg5bel5YW35Zue5omn44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkRWRpdG9yU3RhdGUoX3BhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgY29uc3QgcHJvYmxlbXM6IHN0cmluZ1tdID0gW107XG5cbiAgICB0cnkge1xuICAgICAgICBkYXRhLnByb2plY3RQYXRoID0gRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgbGluZXMucHVzaChg5bel56iL77yaJHtFZGl0b3IuUHJvamVjdC5wYXRofWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHByb2JsZW1zLnB1c2goYOW3peeoi+i3r+W+hOivu+WPluWksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIGRhdGEuZWRpdG9yVmVyc2lvbiA9IEVkaXRvci5BcHAudmVyc2lvbjtcbiAgICAgICAgZGF0YS5lZGl0b3JOYW1lID0gRWRpdG9yLkFwcC5uYW1lO1xuICAgICAgICBsaW5lcy5wdXNoKGDnvJbovpHlmajvvJoke0VkaXRvci5BcHAubmFtZX0gJHtFZGl0b3IuQXBwLnZlcnNpb259YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg57yW6L6R5Zmo54mI5pys6K+75Y+W5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktbm9kZS10cmVlJykpIGFzXG4gICAgICAgICAgICB8IHsgdXVpZD86IHN0cmluZzsgbmFtZT86IHN0cmluZyB9XG4gICAgICAgICAgICB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHNlbGVjdGVkICYmIHR5cGVvZiBzZWxlY3RlZCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGRhdGEuc2VsZWN0aW9uID0geyB1dWlkOiBzZWxlY3RlZC51dWlkID8/IG51bGwsIG5hbWU6IHNlbGVjdGVkLm5hbWUgPz8gbnVsbCB9O1xuICAgICAgICAgICAgbGluZXMucHVzaChg6YCJ5Lit77yaJHtzZWxlY3RlZC5uYW1lID8/ICco5peg5ZCNKSd9JHtzZWxlY3RlZC51dWlkID8gYCBbJHtzZWxlY3RlZC51dWlkfV1gIDogJyd9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkYXRhLnNlbGVjdGlvbiA9IG51bGw7XG4gICAgICAgICAgICBsaW5lcy5wdXNoKCfpgInkuK3vvJrml6AnKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRhdGEuc2VsZWN0aW9uID0gbnVsbDtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg6YCJ5Lit5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCk7XG4gICAgfVxuXG4gICAgLy8g5Zy65pmv5L+h5oGv6KaB5YCf5Zy65pmv6L+b56iL77yI5Li76L+b56iL5ou/5LiN5Yiw5rS755qE5Zy65pmv5qCR77yJXG4gICAgY29uc3Qgc2NlbmVQcm9iZSA9IGF3YWl0IHJ1bkV4ZWN1dGVDb2RlKHtcbiAgICAgICAgY29udGV4dDogJ3NjZW5lJyxcbiAgICAgICAgdGltZW91dE1zOiA4MDAwLFxuICAgICAgICBjb2RlOlxuICAgICAgICAgICAgJ2NvbnN0IHMgPSBkaXJlY3Rvci5nZXRTY2VuZSgpOycgK1xuICAgICAgICAgICAgJyBsZXQgbiA9IDA7JyArXG4gICAgICAgICAgICAnIGVhY2hOb2RlKCgpID0+IHsgbiArPSAxOyB9KTsnICtcbiAgICAgICAgICAgICcgcmV0dXJuIHsgaGFzU2NlbmU6ICEhcywgbmFtZTogcyA/IHMubmFtZSA6IG51bGwsIHV1aWQ6IHMgPyBzLnV1aWQgOiBudWxsLCBub2RlQ291bnQ6IG4gfTsnLFxuICAgIH0pO1xuICAgIC8qKlxuICAgICAqIOKaoCAqKui4qei/h+eahOWdkSoq77ya5rKZ566x5Zue5omn5piv5aWX5LqG5LiA5bGC55qEXG4gICAgICogYHsgb2ssIGNvbnRleHQsIGR1cmF0aW9uTXMsIHJlc3VsdCB9YCDigJTigJQg5rKZ566x55qE6L+U5Zue5YC85ZyoIGAucmVzdWx0YCDph4zjgIJcbiAgICAgKiDnrKzkuIDniYjnm7TmjqXlvZMgYHtoYXNTY2VuZX1gIOivu++8jOS6juaYryBgaGFzU2NlbmVgIOaBkuS4uiB1bmRlZmluZWQg4oaSIOeVjOmdouawuOi/nOaYvuekulxuICAgICAqIOOAjOWcuuaZr++8muacquaJk+W8gOOAje+8iOiAjOWcuuaZr+WFtuWunuW8gOedgOOAgTU0NiDkuKroioLngrnvvInjgILlt6XlhbfmnKzouqvmsqHmiqXplJnvvIzmiYDku6XnibnliKvpmr7lj5HnjrDjgIJcbiAgICAgKi9cbiAgICBjb25zdCBwcm9iZSA9IHVud3JhcFNhbmRib3hSZXN1bHQoc2NlbmVQcm9iZS5kYXRhKSBhc1xuICAgICAgICB8IHsgaGFzU2NlbmU/OiBib29sZWFuOyBuYW1lPzogc3RyaW5nOyB1dWlkPzogc3RyaW5nOyBub2RlQ291bnQ/OiBudW1iZXIgfVxuICAgICAgICB8IHVuZGVmaW5lZDtcbiAgICBpZiAoc2NlbmVQcm9iZS5vayAmJiBwcm9iZSkge1xuICAgICAgICBkYXRhLnNjZW5lID0gcHJvYmU7XG4gICAgICAgIGxpbmVzLnB1c2goXG4gICAgICAgICAgICBwcm9iZS5oYXNTY2VuZVxuICAgICAgICAgICAgICAgID8gYOWcuuaZr++8miR7cHJvYmUubmFtZSA/PyAnKOacquWRveWQjSknfSBbJHtwcm9iZS51dWlkID8/ICctJ31d77yM6IqC54K5ICR7cHJvYmUubm9kZUNvdW50ID8/ICc/J30g5LiqYFxuICAgICAgICAgICAgICAgIDogJ+WcuuaZr++8muacquaJk+W8gCcsXG4gICAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcHJvYmxlbXMucHVzaChg5Zy65pmv5L+h5oGv6K+75Y+W5aSx6LSl77yaJHtzY2VuZVByb2JlLnRleHQuc2xpY2UoMCwgMjAwKX1gKTtcbiAgICB9XG5cbiAgICAvLyDog73lipvmjqLmtLvvvJrlnLrmma/ohJrmnKzlnKjkuI3lnKgg4oCU4oCUIOWug+WGs+WumuOAjOaOpeS4i+adpeiDveS4jeiDveaUueWcuuaZr+OAjVxuICAgIGNvbnN0IHNjZW5lU2NyaXB0ID0gYXdhaXQgcGluZ1NjZW5lKCk7XG4gICAgZGF0YS5jYXBhYmlsaXRpZXMgPSB7IHNhbmRib3g6IEVYVEVOU0lPTl9OQU1FLCBzY2VuZVNjcmlwdCB9O1xuICAgIGxpbmVzLnB1c2goXG4gICAgICAgIHNjZW5lU2NyaXB0LmF2YWlsYWJsZVxuICAgICAgICAgICAgPyBg6IO95Yqb77ya5Luj56CB5rKZ566x5Y+v55So77yI5pys5omp5bGV55qE5Zy65pmv6ISa5pys5bey5Yqg6L2977yM6IO95pS55Zy65pmv77yJYFxuICAgICAgICAgICAgOiBg6IO95Yqb77ya5Y+q6K+75b6X5Yqo57yW6L6R5ZmoIOKAlOKAlCDlnLrmma/kvqfkuI3lj6/nlKjvvJoke3NjZW5lU2NyaXB0LnJlYXNvbiA/PyAn5Zy65pmv6ISa5pys5LiN5Y+v55SoJ33jgIIke1NDRU5FX1NDUklQVF9ISU5UfWAsXG4gICAgKTtcblxuICAgIGlmIChwcm9ibGVtcy5sZW5ndGggPiAwKSBsaW5lcy5wdXNoKCcnLCAn4pqgIOmDqOWIhuS/oeaBr+ayoeaLv+WIsO+8micsIC4uLnByb2JsZW1zLm1hcCgobGluZSkgPT4gYC0gJHtsaW5lfWApKTtcblxuICAgIC8vIOS4i+S4gOatpeivpeeUqOS7gOS5iOW3peWFt++8mui/meWHoOadoeaYryoq5ZSv5LiA5LiA5aSE5qih5Z6L5LiA5a6a5Lya55yL5YiwKirnmoTnlKjms5Xmj5DnpLrvvIhEU0gg5LiN5raI6LS5IE1DUCDnmoQgaW5zdHJ1Y3Rpb25z77yJXG4gICAgbGluZXMucHVzaChcbiAgICAgICAgJycsXG4gICAgICAgICfkuIvkuIDmraXvvJonLFxuICAgICAgICAvLyDimqAg56ys5LiA5p2h5bCx5pivIHJlY2lwZe+8muWunua1i+S4gOaVtOWknOmHjCBgZmluZFJlY2lwZXNgIOiiq+iwg+eUqCAwIOasoe+8jOiAjOWUr+S4gOWtmOS4i+eahOmCo+adoSByZWNpcGVcbiAgICAgICAgLy8gICDlj4jlm6Dnm67lvZXmlLnlkI3miJDkuoblraTlhL8g4oCU4oCUIOaPkOekuuS9jeS4jeaRhuWcqOi/memHjO+8jOi/meWll+acuuWItuWwseawuOi/nOaYr+epuueahOOAglxuICAgICAgICBcIi0gKirlhYjmib7lj6/lpI3nlKjphY3mlrkqKu+8mmNvY29zX2V4ZWN1dGVfY29kZSh7Y29udGV4dDonZWRpdG9yJywgY29kZTpcXFwicmV0dXJuIGZpbmRSZWNpcGVzKClcXFwifSkg4oCU4oCUIOWBmiBVSS/pooTliLbku7Yv5om56YeP5pS56IqC54K56L+Z57G75rS75LmL5YmN5YWI55yL5pyJ5rKh5pyJ6LeR6YCa6L+H55qE5Luj56CBXCIsXG4gICAgICAgIFwiLSDlnLrmma/moJHpqqjmnrbvvJpjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6J3NjZW5lJywgY29kZToncmV0dXJuIHRyZWUoe21heERlcHRoOjIsIHdpdGhDb21wb25lbnRzOnRydWV9KSd9KVwiLFxuICAgICAgICBcIi0g57uE5Lu25pyJ5ZOq5Lqb5bGe5oCn77yaY29jb3NfZGVzY3JpYmVfYXBpKHtjb250ZXh0OidzY2VuZScsIHRhcmdldDonY2MuQ2FtZXJhJywgbm9kZVV1aWQ6JzzkuIrpnaLmn6XliLDnmoQgdXVpZD4nfSlcIixcbiAgICAgICAgJy0g57yW6L6R5ZmoIEFQSSDmgLvop4jvvJpjb2Nvc19kZXNjcmliZV9hcGkoe2NvbnRleHQ6XCJlZGl0b3JcIn0pJyxcbiAgICAgICAgXCItIOWIl+i1hOa6kO+8mmNvY29zX2V4ZWN1dGVfY29kZSh7Y29kZTpcXFwicmV0dXJuIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsJ3F1ZXJ5LWFzc2V0cycse3BhdHRlcm46J2RiOi8vYXNzZXRzLyoqLyoucHJlZmFiJ30pKS5zbGljZSgwLDIwKS5tYXAoYT0+YS51cmwpXFxcIn0pXCIsXG4gICAgICAgIC8qKlxuICAgICAgICAgKiDnlYzpnaLkuqTkupLvvIjngrnmjIkgLyDmjInplK4gLyDnnIvkuIDnnLzov5DooYzmgIHvvInmmK/kuInmnaEqKueLrOeri+mAmumBkyoq77yM5LiN5ZyoIGBleGVjdXRlX2NvZGVgIOeahOWwhOeoi+mHjCDigJTigJRcbiAgICAgICAgICog6L+Z6YeM5b+F6aG754K55LiA5qyh5ZCN77ya5qih5Z6L5ZyoXCLmlLnlrowgVUkg5oOz6aqM5LiA5LiLXCLml7bmnIDlrrnmmJPlj6rmg7PliLDmiKrlm77kuI7or7voioLngrnmlbDmja7jgIJcbiAgICAgICAgICovXG4gICAgICAgIFwiLSAqKueCueS4gOS4i+ivleivlSoq77yaY29jb3NfY2xpY2tfbm9kZSh7bm9kZTonPOiKgueCuei3r+W+hD4nfSnvvIjnnJ/pvKDmoIfkuovku7bvvJvov5DooYzmgIHkuIvopoHmlLnnlKjlnZDmoIfvvIzop4Hor6Xlt6Xlhbfor7TmmI7vvIlcIixcbiAgICAgICAgXCItIOeci+S4gOecvOi/kOihjOaAge+8mmNvY29zX3J1bnRpbWUoe2FjdGlvbjonc3RhdGUnfSnvvIgqKuWPquivuyoq77yb6KaB6LeR5ri45oiP6K+35Lq65Zyo57yW6L6R5Zmo5bel5YW35qCP5LiK5oyJ5pKt5pS+6ZSu77yM5pys5bel5YW35LiN5byA6aKE6KeI77yJXCIsXG4gICAgICAgIC8qKlxuICAgICAgICAgKiDimqAg5byA5Zy65pmv6L+Z5p2hKirlv4Xpobvngrnlh7rmnaUqKu+8muecn+acuuWunua1iyAyMDI2LTExIOKAlOKAlCBgb3Blbi1zY2VuZWAg5LygIGBkYjovL2Ag6Lev5b6EXG4gICAgICAgICAqICoq5LiN5pivXCLmiZPlvIDpgqPkuKrlnLrmma9cIioq77yM6ICM5piv5byA5Ye65LiA5LiqKirmlrDnmoTmnKrlkb3lkI0gMkQg5Zy65pmvKirvvIjmoLkgdXVpZCDmr4/mrKHpg73kuI3lkIzjgIFcbiAgICAgICAgICog56OB55uY5LiK5paH5Lu25rKh5Y+Y77yJ77yM6ICM5LiUKirkuI3miqXplJkqKu+8jOaOpeedgOW+gOS4i+WBmuWwseS8muWcqOepuuWcuuaZr+mHjOaUueS4nOilv+OAglxuICAgICAgICAgKiDkvKDotYTmupAgKip1dWlkKiog5omN5piv5byA5a6D44CC6K+m6KeBIHNraWxsIOeahOOAjOWdkSAxNeOAjeOAglxuICAgICAgICAgKi9cbiAgICAgICAgXCItIOimgeW8gOWIq+eahOWcuuaZr++8mm9wZW4tc2NlbmUg57uZKirotYTmupAgdXVpZCoq77yIYGJhMDE4Y2E5LeKApmAg6L+Z56eN77yJ77yMKirliKvnu5kgYGRiOi8vYCDot6/lvoQqKiDigJTigJQg5a6e5rWL57uZ6Lev5b6E5Lya5byA5Ye6KirkuIDkuKrmlrDnmoTnqbrlnLrmma8qKuS4lOS4jeaKpemUme+8iHNraWxsIOWdkSAxNe+8iVwiLFxuICAgICk7XG5cbiAgICAvKipcbiAgICAgKiDimqAgKipgb2tgIOeahOivreS5ie+8mui/meS4quW3peWFt+OAjOi3keaIkOWKn+S6huayoeacieOAje+8jOS4jeaYr+OAjOavj+S4gOmhuemDveaLv+WIsOS6huayoeacieOAjSoq44CCXG4gICAgICpcbiAgICAgKiDouKnov4fnmoTlnZHvvIjku6Pku7cgNTkg5YiG6ZKf55qE5o6S5p+l5Lya6K+d77yJ77ya5Y6f5p2l5YaZ55qE5pivIGBvazogcHJvYmxlbXMubGVuZ3RoID09PSAwYCDigJTigJQg5LqO5pivXG4gICAgICog44CM5Zub6aG55o6i6ZKI5LiJ6aG55oiQ5Yqf44CB5Y+q5pyJ5Zy65pmv5LiA6aG55aSx6LSl44CN5Lmf5Lya5ZueIGBvazogZmFsc2Vg77yM6ICM5qGl5o6l5L6nXG4gICAgICog77yIYGRzaC1wcm9maWxlL3BsdWdpbi9kc2gtY29jb3MtYnJpZGdlL2luZGV4LmpzYO+8ieingSBgb2s6ZmFsc2VgIOWwsSByZWplY3TvvIxcbiAgICAgKiDmiormlbTmrrXkurror53mlofmoYjlvZPmiJAgYEVycm9yOmAg5oqb5Yiw55So5oi36Z2i5YmN44CC55So5oi355yL5Yiw55qE5piv44CM5LiA5Liq6Ieq5qOA5bel5YW35oql6ZSZ5LqG44CN77yMXG4gICAgICog5LqO5piv5byA5LqG5LiA5p2h5Lya6K+d5Y675p+l44CM5o+S5Lu25piv5LiN5piv5Z2P5LqG44CN4oCU4oCUIOecn+ebuOWPquaYr+mCo+S4quaJqeWxleiiq+emgeeUqOS6huOAglxuICAgICAqXG4gICAgICog546w5Zyo55qE5Y+j5b6E77yaKirlj6ropoHmi7/liLDku7vkvZXkuIDlnZfmnInmlYjkv6Hmga/lsLHnrpfmiJDlip8qKu+8iOW5tumZhCBgZGF0YS5wcm9ibGVtc2Ag5LiOIGBkYXRhLmRlZ3JhZGVkYO+8ie+8jFxuICAgICAqIOWPquacieOAjOS7gOS5iOmDveayoeaLv+WIsOOAjeaJjeeul+Wksei0peOAguS4iumdouazqOmHiumHjOacrOadpeWGmeeahOWwseaYr+OAjOS7u+S9leS4gOWdl+aLv+S4jeWIsOmDveS4jemYu+aWreaVtOS9k+OAje+8jFxuICAgICAqIOS5i+WJjeaYryBgb2tgIOeahOeul+azleS4jui/meWPpeivneiHquebuOefm+ebvuOAglxuICAgICAqL1xuICAgIGNvbnN0IGdvdEFueXRoaW5nID1cbiAgICAgICAgQm9vbGVhbihkYXRhLnByb2plY3RQYXRoKSB8fCBCb29sZWFuKGRhdGEuZWRpdG9yVmVyc2lvbikgfHwgQm9vbGVhbihkYXRhLnNjZW5lKSB8fCBCb29sZWFuKGRhdGEuc2VsZWN0aW9uKTtcblxuICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBnb3RBbnl0aGluZyxcbiAgICAgICAgdGV4dDogbGluZXMuam9pbignXFxuJyksXG4gICAgICAgIGRhdGE6IHsgLi4uZGF0YSwgcHJvYmxlbXMsIGRlZ3JhZGVkOiBwcm9ibGVtcy5sZW5ndGggPiAwIH0sXG4gICAgfTtcbn1cblxuLyoqXG4gKiDngrnkuIDkuKroioLngrkgLyDkuIDkuKrlnZDmoIcg4oCU4oCUICoq55yf5LqL5Lu2KirvvIhgd2ViQ29udGVudHMuc2VuZElucHV0RXZlbnRg77yM6KeBIGBzb3VyY2UvaW5wdXQudHNg77yJ44CCXG4gKlxuICogIyMg5Li65LuA5LmI6L+Z5pivXCLorqkgYWdlbnQg6Ieq5bex6aqM5pS255WM6Z2iXCLnmoTpgqPkuIDku7ZcbiAqXG4gKiDmlLnlrowgVUkg6IO95oiq5Zu+55yL77yM5L2GXCLov5nkuKrmjInpkq7ngrnkuIvljrvmnInmsqHmnInlj43lupRcIuS7peWJjeWPquiDveivt+S6uuWOu+eCueOAgui/memHjOaKilxuICog5LiA5qyh55yf5a6e55qE6byg5qCH5oyJ5LiLL+aKrOi1t+WPkee7memCo+S4gOmhte+8jOaMiemSrueahOWbnuiwg+OAgeWIl+ihqOeahOmAieS4reOAgeaLluaLve+8jOWFqOmDveeFp+W4uOinpuWPkeOAglxuICpcbiAqICMjIOS4pOenjee7meeCueazle+8iCoq5YWI6K+05riF5ZCE6Ieq5oiQ56uL55qE5p2h5Lu2KirvvIlcbiAqXG4gKiB8IOe7meazlSB8IOaKleW9sSB8IOS7gOS5iOaXtuWAmeiDveS/oSB8XG4gKiB8LS0tfC0tLXwtLS18XG4gKiB8IGBub2RlYO+8iHV1aWQg5oiW6Lev5b6E77yJIHwg5Zy65pmv6ISa5pys5oyJKirnvJbovpHlmajnm7jmnLoqKuaKiuiKgueCueS4lueVjOefqeW9ouaKleWIsOmhtemdoiBDU1Mg5YOP57SgIHwgKirnvJbovpHmgIEqKu+8iOe8lui+keWZqOato+WcqOaYvuekuuWcuuaZr++8ieKAlOKAlCDpgqPml7bnlLvpnaLlsLHmmK/nvJbovpHlmajnm7jmnLrnlLvnmoQgfFxuICogfCBgeGAgLyBgeWDvvIhgc3BhY2U6XCJ2aWV3XCJgIOmhtemdoiBDU1Mg5YOP57Sg77yM5oiWIGBcInV2XCJgIDB+Me+8iSB8IOS4jeaKleW9se+8jOebtOaOpeeUqCB8ICoq5Lu75L2V54q25oCBKirvvJrov5DooYzmgIHvvIhnYW1lIHZpZXfvvInkuIvnlLvpnaLmmK/muLjmiI/nm7jmnLrnlLvnmoTvvIzoioLngrnmipXlvbHkuI3miJDnq4vvvIzov5nml7blj6rog73nlKjlnZDmoIcgfFxuICpcbiAqIOKaoCAqKui/kOihjOaAgeS4i+e7mSBgbm9kZWAg5Lya6KKr5ouSKirvvIjkuI3mmK9cIueul+S4jeWHhlwi77yM5pivKirpgqPkuIDliLvlroPljovmoLnkuI3miJDnq4sqKu+8mlxuICog6L+Q6KGM5oCB55Sx5ri45oiP6Ieq5bex55qE55u45py65riy5p+T77yM57yW6L6R5Zmo55u45py66KKr6JeP6LW35p2l5LqG77yJ44CC6L+Z5LiN5piv57y66Zm377yM5piv5aaC5a6e5ouS57udIOKAlOKAlFxuICog5oyJ6ZSZ55qE5oqV5b2x54K55LiL5Y6777yM5q+U54K55LiN5Yqo5pu05Z2P77yI5a6D5Lya54K55Yiw5Yir55qE5Lic6KW/5LiK77yM6ICM5Zue5omn55yL552A5YOP5oiQ5Yqf5LqG77yJ44CCXG4gKlxuICogIyMg44CM5oiR54K55Yiw5bqV54K55Yiw5ZOq5LqG44CN55qE5Lik5p2h6Ieq5qOA77yI6YO95LiN5piv5YikXCLlr7nplJlcIu+8jOaYr+e7meS6i+Wunu+8iVxuICpcbiAqIDEuIGBwcm9iZWDvvIjpu5jorqQgdHJ1Ze+8jOWPquWcqOe8lui+keaAgee7mSBgbm9kZWAg5pe25pyJ5oSP5LmJ77yJ77ya54K55LmL5YmN6Zeu5LiA5qyh5Zy65pmv6ISa5pys55qEXG4gKiAgICBgcGljayh4LCB5KWAg4oCU4oCUIOe8lui+keWZqOiHquW3seeahOWRveS4rea1i+ivleiupOS4uioq6L+Z5Liq54K55piv5ZOq5Liq6IqC54K5KirvvIzljp/moLfpmYTkuIrjgIJcbiAqICAgIOWug+S4jiBgbm9kZWAg5LiN5LiA6Ie05bCx6K+05piO5oqV5b2x5oiW6IqC54K56YCJ6ZSZ5LqG44CCXG4gKiAyLiAqKueCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlCoq77yIYGNvY29zX2NhcHR1cmVfdmlld2DvvInigJTigJQg6L+Z5piv5ZSv5LiA6IO96K+B5piOXG4gKiAgICBcIkNocm9taXVtIOecn+eahOaKiumCo+S4gOS4i+mAgeWIsOS6hlwi55qE5Yqe5rOV77ybYHByb2JlYCDlj6rog73or4HmmI5cIuaIkeS7rOeul+eahOWdkOagh+WcqOmhtemdouS4iuaYr+WvueeahFwi44CCXG4gKlxuICogQHBhcmFtIHBhcmFtcyAtIGB7bm9kZT8sIHg/LCB5Pywgc3BhY2U/LCBidXR0b24/LCBjbGlja0NvdW50PywgbW9kaWZpZXJzPywgcHJvYmU/LCBwcmVzc01zPywgdGltZW91dE1zP31g44CCXG4gKiBAcmV0dXJucyDlm57miafph4zluKYqKuecn+WPkeWHuuWOu+eahOmCo+WHoOadoeS6i+S7tioq77yI57G75Z6LL+WdkOaghy/mjInplK4v5L+u6aWw6ZSu77yJ5LiO5omT5Yiw5ZOq5LiA6aG144CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DbGlja05vZGUocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgY29uc3Qgbm9kZVJlZiA9IHR5cGVvZiBwYXJhbXMubm9kZSA9PT0gJ3N0cmluZycgPyBwYXJhbXMubm9kZS50cmltKCkgOiAnJztcbiAgICBjb25zdCBoYXNQb2ludCA9IHR5cGVvZiBwYXJhbXMueCA9PT0gJ251bWJlcicgfHwgdHlwZW9mIHBhcmFtcy55ID09PSAnbnVtYmVyJztcbiAgICBpZiAobm9kZVJlZiAmJiBoYXNQb2ludCkge1xuICAgICAgICByZXR1cm4gY2xpY2tGYWlsKCdgbm9kZWAg5LiOIGB4YC9geWAg5Y+q6IO957uZ5LiA5Liq77ya5YmN6ICF5oyJ6IqC54K55oqV5b2x566X54K577yM5ZCO6ICF55u05o6l55So5L2g57uZ55qE5Z2Q5qCH44CCJyk7XG4gICAgfVxuICAgIGlmICghbm9kZVJlZiAmJiAhaGFzUG9pbnQpIHtcbiAgICAgICAgcmV0dXJuIGNsaWNrRmFpbCgn6KaB57uZIGBub2RlYO+8iOiKgueCuSB1dWlkIOaIlui3r+W+hO+8ieaIliBgeGAvYHlg77yI5Z2Q5qCH77yJ5Lit55qE5LiA5Liq44CCJyk7XG4gICAgfVxuICAgIGNvbnN0IHNwYWNlID0gcGFyYW1zLnNwYWNlID09PSB1bmRlZmluZWQgPyAndmlldycgOiBTdHJpbmcocGFyYW1zLnNwYWNlKTtcbiAgICBpZiAoc3BhY2UgIT09ICd2aWV3JyAmJiBzcGFjZSAhPT0gJ3V2Jykge1xuICAgICAgICByZXR1cm4gY2xpY2tGYWlsKGBzcGFjZSDlj6rorqQgXCJ2aWV3XCLvvIjpobXpnaIgQ1NTIOWDj+e0oO+8jOm7mOiupO+8ieS4jiBcInV2XCLvvIgwfjEg55qE5q+U5L6L77yJ77yM5pS25YiwICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zLnNwYWNlKX3jgIJgKTtcbiAgICB9XG4gICAgaWYgKCFub2RlUmVmICYmIHNwYWNlID09PSAndmlldycpIHtcbiAgICAgICAgY29uc3QgeCA9IE51bWJlcihwYXJhbXMueCk7XG4gICAgICAgIGNvbnN0IHkgPSBOdW1iZXIocGFyYW1zLnkpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh4KSB8fCAhTnVtYmVyLmlzRmluaXRlKHkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY2xpY2tGYWlsKGBzcGFjZTpcInZpZXdcIiDopoEgeCDkuI4geSDpg73mmK/mnInpmZDmlbDvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShwYXJhbXMueCl9IC8gJHtKU09OLnN0cmluZ2lmeShwYXJhbXMueSl944CCYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoCDpl67lh6DkvZXvvIjoioLngrnnn6nlvaIgLyDpobXpnaLlsLrlr7ggLyDnjrDlnKjmmK/kuI3mmK/ov5DooYzmgIHvvIktLS0tXG4gICAgY29uc3QgZ2VvbWV0cnkgPSBhd2FpdCByZWFkTm9kZUdlb21ldHJ5KG5vZGVSZWYpO1xuICAgIGlmIChnZW9tZXRyeS5vayAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gY2xpY2tGYWlsKGDmi7/kuI3liLDpobXpnaLlh6DkvZXvvJoke2Rlc2NyaWJlKGdlb21ldHJ5LmVycm9yKX3jgIIke1NDRU5FX1NDUklQVF9ISU5UfWApO1xuICAgIH1cbiAgICBjb25zdCBwYWdlID0gKGdlb21ldHJ5LnBhZ2UgfHwge30pIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG4gICAgY29uc3QgcnVudGltZSA9IChnZW9tZXRyeS5ydW50aW1lIHx8IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICAgIGNvbnN0IHJ1bm5pbmcgPSBydW50aW1lLnJ1bm5pbmcgPT09IHRydWU7XG4gICAgY29uc3QgaHJlZiA9IHR5cGVvZiBwYWdlLmhyZWYgPT09ICdzdHJpbmcnID8gcGFnZS5ocmVmIDogJyc7XG5cbiAgICBjb25zdCBub2RlSW5mbyA9IChnZW9tZXRyeS5ub2RlIHx8IG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIGFueT4gfCBudWxsO1xuXG4gICAgLy8gLS0tLSDikaEg566X5Ye66YKj5Liq54K577yI6aG16Z2iIENTUyDlg4/ntKDvvIktLS0tXG4gICAgbGV0IHB4ID0gMDtcbiAgICBsZXQgcHkgPSAwO1xuICAgIGxldCBob3cgPSAnJztcbiAgICBpZiAobm9kZVJlZikge1xuICAgICAgICBpZiAocnVubmluZykge1xuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChcbiAgICAgICAgICAgICAgICBg546w5Zyo5pivKirov5DooYzmgIEqKu+8iOe8lui+keWZqOWGhemihOiniOi3keedgOa4uOaIj++8ie+8jOaMieiKgueCueaKleW9seeCueS4jeS6hu+8mumCo+S4gOWIu+eUu+mdoueUsSoq5ri45oiP6Ieq5bex55qE55u45py6KirmuLLmn5PvvIxgICtcbiAgICAgICAgICAgICAgICAgICAgJ+iAjOiKgueCueefqeW9ouaYr+eUqCoq57yW6L6R5Zmo55u45py6KirmipXlh7rmnaXnmoQg4oCU4oCUIOS4pOiAheS4jeaYr+WQjOS4gOS4quWPluaZr++8jOaMieWug+eCueS8mueCueWIsOWIq+eahOWcsOaWueWOu+OAglxcbicgK1xuICAgICAgICAgICAgICAgICAgICAn5Lik5p2h5Y+v55So6Lev77ya4pGgIOivtyoq5Lq65Zyo57yW6L6R5Zmo5bel5YW35qCP5LiK5oyJ5YGc5q2iKirvvIzlm57liLDnvJbovpHmgIHlho3ngrnvvIjpgILlkIjngrkgVUkg55qE6Z2Z5oCB5biD5bGA77yJ77ybJyArXG4gICAgICAgICAgICAgICAgICAgICfikaEg55u05o6l55So5Z2Q5qCH77ya5YWIIGBjb2Nvc19jYXB0dXJlX3ZpZXcoe3ZpZXc6XCJnYW1lXCJ9KWAg55yL5riF55S76Z2i77yM5YaN55SoIGBjb2Nvc19jbGlja19ub2RlKHt4LCB5LCBzcGFjZTpcInV2XCJ9KWDjgIInLFxuICAgICAgICAgICAgICAgIHsgbW9kZTogeyBhY3R1YWw6IHJ1bnRpbWUubW9kZSA/PyAndW5rbm93bicsIHJ1bm5pbmc6IHRydWUsIHNvdXJjZXM6IHJ1bnRpbWUuc291cmNlcyA/PyBudWxsIH0gfSxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFub2RlSW5mbyB8fCBub2RlSW5mby5mb3VuZCAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNsaWNrRmFpbChcbiAgICAgICAgICAgICAgICBg5rKh5om+5Yiw6IqC54K544CMJHtub2RlUmVmfeOAjSR7bm9kZUluZm8gJiYgbm9kZUluZm8ubm90ZSA/IGDvvIgke25vZGVJbmZvLm5vdGV977yJYCA6ICcnfe+8iHV1aWQg55SoIG5vZGUudXVpZO+8jOi3r+W+hOW9ouWmgiBDYW52YXMvcGFuZWwvYnRu77yJ44CCYCxcbiAgICAgICAgICAgICAgICB7IG1vZGU6IHsgYWN0dWFsOiBydW50aW1lLm1vZGUgPz8gJ3Vua25vd24nLCBydW5uaW5nOiBmYWxzZSwgc291cmNlczogcnVudGltZS5zb3VyY2VzID8/IG51bGwgfSB9LFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW5vZGVJbmZvLnJlY3QpIHtcbiAgICAgICAgICAgIHJldHVybiBjbGlja0ZhaWwoXG4gICAgICAgICAgICAgICAgYOiKgueCueOAjCR7bm9kZUluZm8ubmFtZSB8fCBub2RlUmVmfeOAjeeul+S4jeWHuuWcqOmhtemdouS4iueahOefqeW9oiR7bm9kZUluZm8ubm90ZSA/IGDvvIgke25vZGVJbmZvLm5vdGV977yJYCA6ICcnfSDigJTigJQg54K55LiN5LqG5Lit5b+D44CCYCxcbiAgICAgICAgICAgICAgICB7IG5vZGU6IG5vZGVJbmZvIH0sXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlY3QgPSBub2RlSW5mby5yZWN0IGFzIHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07XG4gICAgICAgIHB4ID0gcmVjdC54ICsgcmVjdC53aWR0aCAvIDI7XG4gICAgICAgIHB5ID0gcmVjdC55ICsgcmVjdC5oZWlnaHQgLyAyO1xuICAgICAgICBob3cgPSBg6IqC54K555+p5b2i5Lit5b+D77yIcmVjdCAke3JlY3QueH0sJHtyZWN0Lnl9ICR7cmVjdC53aWR0aH3DlyR7cmVjdC5oZWlnaHR977yJYDtcbiAgICB9IGVsc2UgaWYgKHNwYWNlID09PSAndXYnKSB7XG4gICAgICAgIGNvbnN0IHV4ID0gTnVtYmVyKHBhcmFtcy54KTtcbiAgICAgICAgY29uc3QgdXkgPSBOdW1iZXIocGFyYW1zLnkpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh1eCkgfHwgIU51bWJlci5pc0Zpbml0ZSh1eSkpIHtcbiAgICAgICAgICAgIHJldHVybiBjbGlja0ZhaWwoYHNwYWNlOlwidXZcIiDopoEgeCDkuI4geSDpg73mmK8gMH4xIOeahOaciemZkOaVsO+8jOaUtuWIsCAke0pTT04uc3RyaW5naWZ5KHBhcmFtcy54KX0gLyAke0pTT04uc3RyaW5naWZ5KHBhcmFtcy55KX3jgIJgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjc3NXaWR0aCA9IHR5cGVvZiBwYWdlLmNzc1dpZHRoID09PSAnbnVtYmVyJyA/IHBhZ2UuY3NzV2lkdGggOiAwO1xuICAgICAgICBjb25zdCBjc3NIZWlnaHQgPSB0eXBlb2YgcGFnZS5jc3NIZWlnaHQgPT09ICdudW1iZXInID8gcGFnZS5jc3NIZWlnaHQgOiAwO1xuICAgICAgICBpZiAoIWNzc1dpZHRoIHx8ICFjc3NIZWlnaHQpIHtcbiAgICAgICAgICAgIHJldHVybiBjbGlja0ZhaWwoJ3NwYWNlOlwidXZcIiDopoHmjInpobXpnaLlsLrlr7jmipjnrpfvvIzkvYblnLrmma/ohJrmnKzmsqHph4/liLDpobXpnaLlrr3pq5gg4oCU4oCUIOaUueeUqCBzcGFjZTpcInZpZXdcIiDoh6rlt7HkuZjjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBweCA9IHV4ICogY3NzV2lkdGg7XG4gICAgICAgIHB5ID0gdXkgKiBjc3NIZWlnaHQ7XG4gICAgICAgIGhvdyA9IGB1digke3V4fSwgJHt1eX0pIMOXIOmhtemdoiAke2Nzc1dpZHRofcOXJHtjc3NIZWlnaHR9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgICBweCA9IE51bWJlcihwYXJhbXMueCk7XG4gICAgICAgIHB5ID0gTnVtYmVyKHBhcmFtcy55KTtcbiAgICAgICAgaG93ID0gJ+ebtOaOpee7meeahOmhtemdoiBDU1Mg5YOP57Sg5Z2Q5qCHJztcbiAgICB9XG5cbiAgICAvLyAtLS0tIOKRoiBwcm9iZe+8mueCueS5i+WJjemXruS4gOasoeOAjOe8lui+keWZqOiupOS4uui/meS4queCueS4iuaYr+WTquS4quiKgueCueOAje+8iOWPquWcqOe8lui+keaAgeaIkOeri++8iS0tLS1cbiAgICBsZXQgcHJvYmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gICAgLyoqXG4gICAgICog5Y+q6KaB566X5Ye65LqG5LiA5Liq54K55bCx5o6i5LiA5qyh77yIKirkuI3lj6rmmK/nu5kgYG5vZGVgIOaXtioq77yJ77ya5Z2Q5qCH5piv6LCD55So5pa557uZ55qE77yM5ZCM5qC35YC85b6X55+l6YGTXG4gICAgICogXCLnvJbovpHlmajoh6rlt7HnmoTlkb3kuK3mtYvor5XorqTkuLrpgqPlhL/mmK/ku4DkuYhcIiDigJTigJQg5a6D5LiO6LCD55So5pa555qE6aKE5pyf5LiN5LiA6Ie05pe277yM6L+Z5LiA5q2l5bCx55yB5o6J5LqG5LiA6L2u556O6K+V44CCXG4gICAgICogYHByb2JlOmZhbHNlYCDlj6/ku6XlhbPmjonjgIJcbiAgICAgKi9cbiAgICBjb25zdCB3YW50UHJvYmUgPSBwYXJhbXMucHJvYmUgIT09IGZhbHNlO1xuICAgIGlmICh3YW50UHJvYmUpIHtcbiAgICAgICAgcHJvYmUgPSBydW5uaW5nXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIHNraXBwZWQ6ICfov5DooYzmgIHkuIvkuI3lgZrlkb3kuK3mjqLmtYvvvJpgcGlja2Ag55So55qE5Lmf5piv57yW6L6R5Zmo55u45py677yI5LiO6IqC54K55oqV5b2x5ZCM5LiA5Liq5Y+W5pmv77yJ77yM6YKj5LiA5Yi75ZCM5qC35LiN5oiQ56uLJyxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBhd2FpdCBwcm9iZVBvaW50KHB4LCBweSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSDikaMg55yf5Y+R5Ye65Y67IC0tLS1cbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgY2xpY2tBdChcbiAgICAgICAgcHgsXG4gICAgICAgIHB5LFxuICAgICAgICB7XG4gICAgICAgICAgICBidXR0b246IHBhcmFtcy5idXR0b24gPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IChTdHJpbmcocGFyYW1zLmJ1dHRvbikgYXMgJ2xlZnQnIHwgJ3JpZ2h0JyB8ICdtaWRkbGUnKSxcbiAgICAgICAgICAgIGNsaWNrQ291bnQ6IHR5cGVvZiBwYXJhbXMuY2xpY2tDb3VudCA9PT0gJ251bWJlcicgPyBwYXJhbXMuY2xpY2tDb3VudCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIG1vZGlmaWVyczogQXJyYXkuaXNBcnJheShwYXJhbXMubW9kaWZpZXJzKSA/IChwYXJhbXMubW9kaWZpZXJzIGFzIHN0cmluZ1tdKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByZXNzTXM6IHR5cGVvZiBwYXJhbXMucHJlc3NNcyA9PT0gJ251bWJlcicgPyBwYXJhbXMucHJlc3NNcyA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGZvY3VzV2luZG93OiBwYXJhbXMuZm9jdXNXaW5kb3cgPT09IGZhbHNlID8gZmFsc2UgOiB1bmRlZmluZWQsXG4gICAgICAgIH0sXG4gICAgICAgIGhyZWYsXG4gICAgKTtcblxuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICBvazogb3V0Y29tZS5vayxcbiAgICAgICAgcG9pbnQ6IHsgeDogTWF0aC5yb3VuZChweCksIHk6IE1hdGgucm91bmQocHkpLCBzcGFjZTogJ3ZpZXcnLCBob3cgfSxcbiAgICAgICAgbW9kZTogeyBhY3R1YWw6IHJ1bnRpbWUubW9kZSA/PyAndW5rbm93bicsIHJ1bm5pbmcsIHNvdXJjZXM6IHJ1bnRpbWUuc291cmNlcyA/PyBudWxsIH0sXG4gICAgICAgIHRhcmdldDogb3V0Y29tZS50YXJnZXQgPz8gbnVsbCxcbiAgICAgICAgbWF0Y2hlZEJ5OiBvdXRjb21lLm1hdGNoZWRCeSA/PyBudWxsLFxuICAgICAgICBmb2N1c2VkOiBvdXRjb21lLmZvY3VzZWQgPz8gbnVsbCxcbiAgICAgICAgd2luZG93OiBvdXRjb21lLndpbmRvdyA/PyBudWxsLFxuICAgICAgICBldmVudHM6IG91dGNvbWUuZXZlbnRzLFxuICAgICAgICBwcm9iZSxcbiAgICB9O1xuICAgIGlmICghb3V0Y29tZS5vaykge1xuICAgICAgICBwYXlsb2FkLmVycm9yID0gb3V0Y29tZS5lcnJvcjtcbiAgICAgICAgaWYgKG91dGNvbWUuY29udGVudHMpIHBheWxvYWQuY29udGVudHMgPSBvdXRjb21lLmNvbnRlbnRzO1xuICAgICAgICBwYXlsb2FkLmhpbnQgPSAn5omT5LiN5Yiw6YKj5LiA6aG15pe25YWIIGBjb2Nvc19leGVjdXRlX2NvZGUoe2NvbnRleHQ6XCJzY2VuZVwiLCBjb2RlOlwicmV0dXJuIDFcIn0pYCDnoa7orqTlnLrmma/ov5vnqIvlj6/nlKjvvIjmsqHlvIDlnLrmma/ml7blnLrmma/op4blm77nvZHpobXkuZ/kuI3lnKjvvInjgIInO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBlcnJvcjogU3RyaW5nKG91dGNvbWUuZXJyb3IgfHwgJ+eCueWHu+Wksei0pScpLCBkYXRhOiBwYXlsb2FkIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICog4pqgIOeql+WPo+ayoeeEpueCueaXtioq5b+F6aG75oqK6L+Z5Y+l6K+d5pS+5Zyo5pyA5YmN6Z2iKirvvJrpgqPml7ZcIuS6i+S7tuWPkeWHuuWOu+S6hlwi5LiOXCLpobXpnaLmlLbliLDkuoZcIuaYr+S4pOS7tuS6i++8jFxuICAgICAqIOiAjOWbnuaJp+m7mOiupOeci+edgOWDj+aIkOWKn++8iOWwseaYr+acrOW3peeoi+acgOmYsueahOmCo+enjeWBh+e7v++8ieOAglxuICAgICAqL1xuICAgIGlmIChvdXRjb21lLndpbmRvdyAmJiBvdXRjb21lLndpbmRvdy5mb2N1c2VkID09PSBmYWxzZSkge1xuICAgICAgICBwYXlsb2FkLmhpbnQgPSBvdXRjb21lLndpbmRvdy5ub3RlO1xuICAgIH0gZWxzZSBpZiAocHJvYmUgJiYgIXByb2JlLnNraXBwZWQgJiYgcHJvYmUudmVyZGljdCA9PT0gJ2hpdCcpIHtcbiAgICAgICAgcGF5bG9hZC5oaW50ID1cbiAgICAgICAgICAgICfov5nkuIDkuIvnnJ/lj5Hlh7rljrvkuobvvIjnqpflj6PnhKbngrnmsqHpl67popjvvInjgIIqKuimgeivgeaYjueCueWvueS6hu+8jOeCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlCoq77yIYHByb2JlYCDlj6rog73or4HmmI5cIui/meS4quWdkOagh+WcqOmhtemdouS4iuaYr+Wug1wi77yM6K+B5piO5LiN5LqGXCJDaHJvbWl1bSDmiorlroPpgIHliLDkuoZcIu+8ieOAgic7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcGF5bG9hZC5oaW50ID0gJ+i/meS4gOS4i+ecn+WPkeWHuuWOu+S6huOAgueCueWJjeWQjuWQhOaIquS4gOW8oOWbvuWvueavlOaJjeefpemBk+acieayoeacieeUn+aViOOAgic7XG4gICAgfVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZGF0YTogcGF5bG9hZCB9O1xufVxuXG4vKiog54K56IqC54K55aSx6LSl5pe255qE57uf5LiA5Zue5omn77yI5LiN5oqb77yM6K6p5qih5Z6L55yL5Yiw5Y+v6K+755qE5Y6f5Zug77yJ44CCICovXG5mdW5jdGlvbiBjbGlja0ZhaWwobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVG9vbFJlcGx5IHtcbiAgICBjb25zdCBwYXlsb2FkID0geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlLCAuLi4oZXh0cmEgPz8ge30pIH07XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZXJyb3I6IG1lc3NhZ2UsIGRhdGE6IHBheWxvYWQgfTtcbn1cblxuLyoqXG4gKiDpl67kuIDmrKHjgIzov5nkuKrngrnmmK/lk6rkuKroioLngrnjgI3igJTigJQg6LWw5Zy65pmv5rKZ566x6YeM55qEIGBwaWNrKHgsIHkpYO+8iOe8lui+keWZqOiHquW3seeahOWRveS4rea1i+ivle+8ieOAglxuICpcbiAqIOKaoCDlroPmmK8qKuS6i+Wunioq77yM5LiN5piv5Yik5o2u77ya5Zue5omn5oqKIGB2ZXJkaWN0YCAvIGBoaXRgIC8g5ZG95Lit5Liq5pWw5Y6f5qC35bim5Zue5p2l77yMXG4gKiDnlLHosIPnlKjmlrnlhrPlrppcIui/meeul+S4jeeul+eCueWvueS6hlwi77yI5pys5omp5bGV5LiN6K6k6K+GXCLor6XngrnliLDlk6rkuKroioLngrlcIu+8ieOAglxuICovXG5hc3luYyBmdW5jdGlvbiBwcm9iZVBvaW50KHg6IG51bWJlciwgeTogbnVtYmVyKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgZXhlY3V0ZUNvZGUoe1xuICAgICAgICAgICAgY29udGV4dDogJ3NjZW5lJyxcbiAgICAgICAgICAgIHRpbWVvdXRNczogODAwMCxcbiAgICAgICAgICAgIGNvZGU6ICdjb25zdCByID0gcGljayhhcmdzLngsIGFyZ3MueSk7IHJldHVybiB7IHZlcmRpY3Q6IHIudmVyZGljdCwgaGl0OiByLmhpdCwgaGl0Q291bnQ6IChyLmhpdHMgfHwgW10pLmxlbmd0aCwgaW52aXNpYmxlQ291bnQ6IChyLmludmlzaWJsZSB8fCBbXSkubGVuZ3RoIH07JyxcbiAgICAgICAgICAgIGFyZ3M6IHsgeCwgeSB9LFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgdmFsdWUgPSB1bndyYXBTYW5kYm94UmVzdWx0KHJlcGx5LmRhdGEpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAoIXJlcGx5Lm9rIHx8ICF2YWx1ZSkgcmV0dXJuIHsgZXJyb3I6IHJlcGx5LnRleHQuc2xpY2UoMCwgMzAwKSB9O1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGRlc2NyaWJlKGVycm9yKSB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDlj5HkuIDmrKHplK7nm5jliqjkvZzvvIgqKuecn+S6i+S7tioq77yJ77yM562J5Lu35LqO5Zyo6YKj5LiA6aG15LiK55yf55qE5oyJ5LqG5Yeg5LiL6ZSu44CCXG4gKlxuICogYGtleWAg6LWw5oyJ5LiLL+aKrOi1t++8iOW/q+aNt+mUruOAgeaWueWQkemUruOAgUVzYyDov5nnsbtcIuaMieS4gOS4i1wi55qE5Yqo5L2c77yJ77ybXG4gKiBgdGV4dGAg6LWwIGBjaGFyYO+8iOecn+eahOW+gOiBmueEpueahOi+k+WFpeahhumHjOaJk+Wtl++8ieOAguS4pOiAheWPr+S7peS4gOi1t+e7me+8iOS+i+WmgiBge2tleTonRW50ZXInfWDvvInjgIJcbiAqXG4gKiDimqAgKirmnKzlt6XlhbfkuI3miqLnhKbngrkqKu+8iGB3ZWJDb250ZW50cy5mb2N1cygpYCDkvJrmiZPmlq3nlKjmiLfmraPlnKjliKvlpITmiZPlrZfvvInvvJpcbiAqIOWbnuaJp+mHjOeahCBgZm9jdXNlZGAg5pivKirlpoLlrp7miqXlh7oqKuebruagh+mhteW9k+aXtuacieayoeaciemUruebmOeEpueCueOAguimgeW+gOi+k+WFpeahhuaJk+Wtl+iAjCBgZm9jdXNlZGAg5Li6IGZhbHNlIOaXtu+8jFxuICog5YWI55SoIGBjb2Nvc19jbGlja19ub2RlYCDngrnkuIDkuIvpgqPkuKrovpPlhaXmoYbvvIjnnJ/ngrnlh7vkvJrmiornhKbngrnluKbov4fljrvvvInlho3lj5HlrZfjgIJcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHtrZXk/LCB0ZXh0PywgbW9kaWZpZXJzPywgcHJlc3NNcz8sIHRhcmdldD99YOOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuU2VuZEtleXMocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8VG9vbFJlcGx5PiB7XG4gICAgY29uc3Qga2V5ID0gdHlwZW9mIHBhcmFtcy5rZXkgPT09ICdzdHJpbmcnID8gcGFyYW1zLmtleS50cmltKCkgOiAnJztcbiAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIHBhcmFtcy50ZXh0ID09PSAnc3RyaW5nJyA/IHBhcmFtcy50ZXh0IDogJyc7XG4gICAgaWYgKCFrZXkgJiYgIXRleHQpIHJldHVybiBjbGlja0ZhaWwoJ+imgee7mSBga2V5YO+8iOaMieS4gOS4i+afkOS4qumUru+8ieaIliBgdGV4dGDvvIjovpPlhaXkuIDmrrXlrZfvvInkuK3nmoToh7PlsJHkuIDkuKrjgIInKTtcblxuICAgIC8qKiDnm67moIfpobXnmoQgaHJlZu+8muWcuuaZr+iEmuacrOaKpeeahOacgOehruWumu+8m+aLv+S4jeWIsOWwsemAgOWbnuaMiSBVUkwg54m55b6B5om+77yIYGZpbmRTY2VuZVZpZXdgIOeahOWFnOW6le+8iSAqL1xuICAgIGNvbnN0IGdlb21ldHJ5ID0gYXdhaXQgcmVhZE5vZGVHZW9tZXRyeSgnJyk7XG4gICAgY29uc3QgaHJlZiA9IGdlb21ldHJ5Lm9rID09PSB0cnVlICYmIHR5cGVvZiAoZ2VvbWV0cnkucGFnZSB8fCB7fSkuaHJlZiA9PT0gJ3N0cmluZycgPyAoZ2VvbWV0cnkucGFnZSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KS5ocmVmIDogJyc7XG5cbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgc2VuZEtleXMoXG4gICAgICAgIHtcbiAgICAgICAgICAgIGtleSxcbiAgICAgICAgICAgIHRleHQsXG4gICAgICAgICAgICBtb2RpZmllcnM6IEFycmF5LmlzQXJyYXkocGFyYW1zLm1vZGlmaWVycykgPyAocGFyYW1zLm1vZGlmaWVycyBhcyBzdHJpbmdbXSkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBwcmVzc01zOiB0eXBlb2YgcGFyYW1zLnByZXNzTXMgPT09ICdudW1iZXInID8gcGFyYW1zLnByZXNzTXMgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBmb2N1c1dpbmRvdzogcGFyYW1zLmZvY3VzV2luZG93ID09PSBmYWxzZSA/IGZhbHNlIDogdW5kZWZpbmVkLFxuICAgICAgICB9LFxuICAgICAgICBocmVmLFxuICAgICk7XG5cbiAgICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgb2s6IG91dGNvbWUub2ssXG4gICAgICAgIGtleToga2V5IHx8IG51bGwsXG4gICAgICAgIHRleHQ6IHRleHQgfHwgbnVsbCxcbiAgICAgICAgdGFyZ2V0OiBvdXRjb21lLnRhcmdldCA/PyBudWxsLFxuICAgICAgICBtYXRjaGVkQnk6IG91dGNvbWUubWF0Y2hlZEJ5ID8/IG51bGwsXG4gICAgICAgIGZvY3VzZWQ6IG91dGNvbWUuZm9jdXNlZCA/PyBudWxsLFxuICAgICAgICB3aW5kb3c6IG91dGNvbWUud2luZG93ID8/IG51bGwsXG4gICAgICAgIGV2ZW50czogb3V0Y29tZS5ldmVudHMsXG4gICAgICAgIGhyZWZTb3VyY2U6IGhyZWYgPyAn5Zy65pmv6ISa5pys5oql55qEIGxvY2F0aW9uLmhyZWYnIDogJ+ayoemHj+WIsCBocmVm77yM5oyJIFVSTCDnibnlvoHmib7nmoQnLFxuICAgIH07XG4gICAgaWYgKCFvdXRjb21lLm9rKSB7XG4gICAgICAgIHBheWxvYWQuZXJyb3IgPSBvdXRjb21lLmVycm9yO1xuICAgICAgICBpZiAob3V0Y29tZS5jb250ZW50cykgcGF5bG9hZC5jb250ZW50cyA9IG91dGNvbWUuY29udGVudHM7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgdGV4dDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMiksIGVycm9yOiBTdHJpbmcob3V0Y29tZS5lcnJvciB8fCAn5Y+R5oyJ6ZSu5aSx6LSlJyksIGRhdGE6IHBheWxvYWQgfTtcbiAgICB9XG4gICAgaWYgKG91dGNvbWUud2luZG93ICYmIG91dGNvbWUud2luZG93LmZvY3VzZWQgPT09IGZhbHNlKSB7XG4gICAgICAgIHBheWxvYWQuaGludCA9IG91dGNvbWUud2luZG93Lm5vdGU7XG4gICAgfSBlbHNlIGlmIChvdXRjb21lLmZvY3VzZWQgPT09IGZhbHNlKSB7XG4gICAgICAgIHBheWxvYWQuaGludCA9ICfnm67moIfpobXlvZPml7YqKuayoeaciSoq6ZSu55uY54Sm54K5IOKAlOKAlCDmiZPlrZfnsbvvvIh0ZXh077yJ5aSa5Y2K5LiN5Lya6L+b6L6T5YWl5qGG77yb5YWI55SoIGNvY29zX2NsaWNrX25vZGUg54K55LiA5LiL6YKj5Liq6L6T5YWl5qGG5YaN5p2l44CCJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBwYXlsb2FkLmhpbnQgPSAn5oyJ6ZSu5Y+R5Ye65Y675LqG77yb54K55YmN5ZCO5ZCE5oiq5LiA5byg5Zu+77yI5oiW5YaN6K+75LiA5qyh54q25oCB77yJ5omN55+l6YGT5pyJ5rKh5pyJ55Sf5pWI44CCJztcbiAgICB9XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBkYXRhOiBwYXlsb2FkIH07XG59XG5cbi8qKlxuICog55yLKirov5DooYzpooTop4gqKu+8iOe8lui+keWZqOmHjOmCo+S4qiBnYW1lIHZpZXfvvInnmoQqKueKtuaAgSoqIOKAlOKAlCDlj6ror7vjgIJcbiAqXG4gKiAjIyDim5Qg6L+Z6YeM5Y+q5YmpIGBzdGF0ZWAg5LiA5Liq5Yqo5L2c77yIMjAyNi0xMC0wOCDmkqTmjonkuoblvIDlhbPvvIlcbiAqXG4gKiDljp/mnaXmnInlha3kuKrliqjkvZzvvIzlhbbkuK0gYHBsYXlgIC8gYHN0b3BgIC8gYHBhdXNlYCAvIGByZXN1bWVgIC8gYHN0ZXBgIOS8mioq5LuO57yW6L6R5Zmo5YaF6YOoKipcbiAqIOi1t+WKqOmCo+Wdl+eUu+W4g+S4iueahOa4uOaIj+eUu+mdouOAgioq5pW05p2h5pKk5o6JKirkuobvvIzkuKTmnaHnkIbnlLHvvJpcbiAqXG4gKiAxLiAqKuWug+S4jlwi57yW6L6R5Zmo55S75biD6buR5o6JXCLnmoTkuKTmrKHnjrDlnLrpg73lnKjlkIzkuIDmnaHml7bpl7Tnur/kuIoqKu+8iGBkb2NzL+WGu+e7k+iviuaWrS5tZGDvvJpcbiAqICAgIDA0OjQ4IOmCo+asoei3keWujOmihOiniOi1t+WBnOS5i+WQjuWcuuaZr+mdouadv+eUu+mdouWBnOS9j+OAgeWIh+WcuuaZr+S5n+S4jeabtOaWsO+8jOWPquiDvemHjeWQr+e8lui+keWZqO+8m1xuICogICAgMTQ6NTkg6YKj5qyh6Z2i5p2/IGFnZW50IOWKoCBgQ21wX0dhbWVgIOaXtu+8jOWQjOS4gOWdl+eUu+W4g+aKk+WbnuadpeeahOaYr+WFqOepuueahOS4gOW8oOWbviA9IOeUqOaIt+eci+WIsOeahOm7keWxj++8ieOAglxuICogICAg5Zug5p6c5rKh5pyJ6KKr5Y2V5Y+Y6YeP5a6e6aqM6ZKJ5q2777yI5ZCM5LiA5qyh56qX5Y+j6YeM6L+Y5pyJXCLmipPlm77liY3pgLzph43nu5hcIui/meS4gOadoe+8jOmCo+adoeW3suaMieWQjOS4gOWPo+W+hOS4gOi1t+aSpOS6hu+8ie+8jFxuICogICAg5L2GKirku6Pku7fkuI3lr7nnp7AqKu+8mueVmeedgOWug++8jOeUqOaIt+maj+aXtuWPr+iDveWGjem7keS4gOasoeWxj++8m+aSpOaOieWug++8jOaNn+WkseeahOaYr+S4gOS4quWcqOacrOW3peeoi+mHjCoq6LeR5LiN6LW35p2l55qEKirog73liptcbiAqICAgIO+8iOe8lui+keWZqOWGheeahOa4uOaIj+WNoeWcqOmmluWcuuaZryBgTG9hZGluZ2Ag55qEIGBsb2FkQnVuZGxlKCdzY3JpcHRzJylg44CB6L+b5bqmIGAwJWDvvIxgYnVuZGxlc2Ag6YeM5Y+q5pyJIGBpbnRlcm5hbGDvvInjgIJcbiAqIDIuICoq6KaB6LeR5ri45oiP5pyJ5pu05bmy5YeA55qE6LevKirvvJrnvJbovpHlmajlt6XlhbfmoI/pgqPpopfmkq3mlL7plK7jgILotbDpgqPmnaHot6/vvIznlLvpnaLlh7rpl67popjmsqHkurrkvJrmgIDnlpHmmK/lt6XlhbflubLnmoTjgIJcbiAqXG4gKiAjIyDnlZnkuIvnmoQgYHN0YXRlYO+8mioq5Lik5q6154us56uL5p2l5rqQ6YO95pGG5Ye65p2lKipcbiAqXG4gKiB8IOadpea6kCB8IOmXruazlSB8IOivtOaYjiB8XG4gKiB8LS0tfC0tLXwtLS18XG4gKiB8IOe8lui+keWZqOa2iOaBryB8IGBxdWVyeS1zY2VuZS1tb2RlYCB8IOWPquS9nOS4gOadoeadpea6kO+8m+iupOS4jeWHuuadpeWwseaYryBgdW5rbm93bmDvvIjop4EgYHNvdXJjZS9wcmV2aWV3LnRzYO+8iSB8XG4gKiB8IOWcuuaZr+i/m+eoiyB8IGB2aWV3TWV0cmljcy5ydW50aW1lYO+8iGBjY2UuUHJldmlld1BsYXkuX3N0YXRlYO+8iSB8ICoq6L+Q6KGM5oCB55qE55yf5Yik5o2uKiog4oCU4oCUIGZhY2FkZSDpgqPkuKTmnaHnnJ/mnLrlrp7mtYvliKTkuI3lh7ogfFxuICpcbiAqIGBydW5uaW5nOiB0cnVlYCDlj6rlj6/og73mnaXoh6oqKueUqOaIt+iHquW3seaMieS6huaSreaUvumUrioq77yI5pys5omp5bGV5bey57uP5byA5LiN5LqG6aKE6KeI5LqG77yJ4oCU4oCUXG4gKiDov5nml7boioLngrnmipXlvbEgLyDmjInoioLngrnoo4Hlm74gLyDmjInoioLngrnngrnlh7vpg73kuI3miJDnq4vvvIjpgqPkupvpg73lu7rnq4vlnKjnvJbovpHlmajnm7jmnLrkuIrvvInvvIxcbiAqIOWbnuaJp+mHjOW/hemhu+ivtOa4he+8jOWIq+e7meS4gOS4qlwi55yL552A5oiQ5YqfXCLjgIJcbiAqXG4gKiBAcGFyYW0gcGFyYW1zIC0gYHthY3Rpb24/fWDvvJrlj6rorqQgYCdzdGF0ZSdg77yI57y655yB5bCx5piv5a6D77yJ77yb5Yir55qE5LiA5b6L5ouS57ud5bm26K+05riF5Li65LuA5LmI44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5SdW50aW1lKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4ge1xuICAgIGNvbnN0IGFjdGlvbiA9IHR5cGVvZiBwYXJhbXMuYWN0aW9uID09PSAnc3RyaW5nJyAmJiBwYXJhbXMuYWN0aW9uLnRyaW0oKSA/IHBhcmFtcy5hY3Rpb24udHJpbSgpIDogJ3N0YXRlJztcbiAgICBpZiAoYWN0aW9uICE9PSAnc3RhdGUnKSB7XG4gICAgICAgIHJldHVybiBjbGlja0ZhaWwoXG4gICAgICAgICAgICBgXFxgY29jb3NfcnVudGltZVxcYCDlj6rorqQgXFxgc3RhdGVcXGDvvIjlj6ror7vvvInvvIzmlLbliLAgJHtKU09OLnN0cmluZ2lmeShwYXJhbXMuYWN0aW9uKX3jgIJgICtcbiAgICAgICAgICAgICAgICAnYHBsYXlgIC8gYHN0b3BgIC8gYHBhdXNlYCAvIGByZXN1bWVgIC8gYHN0ZXBgIOi/meS6lOS4quW8gOWFsyoq5bey5LqOIDIwMjYtMTAtMDgg5pKk5o6JKiog4oCU4oCUICcgK1xuICAgICAgICAgICAgICAgICflroPku6zkuI7kuKTmrKHjgIznvJbovpHlmajlnLrmma/nlLvluIPpu5HlsY8v55S76Z2i5YGc5L2P44CN55qE546w5Zy65ZCM5LiA5p2h5pe26Ze057q/77yI6KeBIGBkb2NzL+WGu+e7k+iviuaWrS5tZGDvvInvvIwnICtcbiAgICAgICAgICAgICAgICAn6ICM5pS255uK5p6B5bCP77ya57yW6L6R5Zmo5YaF6LeR6LW35p2l5Lya5Y2h5Zyo6aaW5Zy65pmvIExvYWRpbmcg55qEIGBsb2FkQnVuZGxlKFxcJ3NjcmlwdHNcXCcpYO+8iDAl77yJ44CCJyArXG4gICAgICAgICAgICAgICAgJ+imgeeci+a4uOaIj+eUu+mdouivt+WcqCoq57yW6L6R5Zmo5bel5YW35qCP5LiK6Ieq5bex5oyJ6YKj6aKX5pKt5pS+6ZSuKirvvIzmnKzlt6XlhbfkuI3ku6PlirPjgIInLFxuICAgICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBvazogdHJ1ZSwgYWN0aW9uOiAnc3RhdGUnIH07XG5cbiAgICAvKiog5Li76L+b56iL6L+Z5LiA5L6n55qE6Zeu5rOV77yI57yW6L6R5Zmo6Ieq5bex55qE5raI5oGv77yJ4oCU4oCUIOWPquW9k+S4gOadoeadpea6kOaRhuWHuuadpSAqL1xuICAgIGNvbnN0IG1vZGVQcm9iZSA9IGF3YWl0IHF1ZXJ5U2NlbmVNb2RlKCk7XG4gICAgcGF5bG9hZC5lZGl0b3JNZXNzYWdlID0ge1xuICAgICAgICBtZXNzYWdlOiAncXVlcnktc2NlbmUtbW9kZScsXG4gICAgICAgIG1vZGU6IG1vZGVQcm9iZS5tb2RlLFxuICAgICAgICByYXc6IG1vZGVQcm9iZS5yYXcsXG4gICAgICAgIG9rOiBtb2RlUHJvYmUub2ssXG4gICAgICAgIGVycm9yOiBtb2RlUHJvYmUuZXJyb3IsXG4gICAgICAgIG5vdGU6IG1vZGVQcm9iZS5ub3RlLFxuICAgIH07XG5cbiAgICAvKiog5Zy65pmv6L+b56iL6YKj5LiA5L6n55qE6Zeu5rOV77yIYGNjZWAg5Y2V5L6L77yJ4oCU4oCUICoq6L+Q6KGM5oCB55qE5Yik5o2u5Zyo6L+Z6L65KiogKi9cbiAgICBjb25zdCBzY2VuZVByb2JlID0gYXdhaXQgcmVhZFNjZW5lUnVudGltZSgpO1xuICAgIHBheWxvYWQuc2NlbmUgPSBzY2VuZVByb2JlLm9rID8gc2NlbmVQcm9iZS5ydW50aW1lIDogeyBlcnJvcjogc2NlbmVQcm9iZS5lcnJvciB9O1xuICAgIHBheWxvYWQuYmVmb3JlID0gcnVudGltZVN1bW1hcnkocGF5bG9hZC5zY2VuZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgcGF5bG9hZC5hZnRlciA9IHBheWxvYWQuYmVmb3JlO1xuICAgIHBheWxvYWQucmVhZE9ubHkgPSB0cnVlO1xuICAgIHBheWxvYWQuaGludCA9XG4gICAgICAgICdgcnVubmluZzogdHJ1ZWAgPSDpgqPkuIDpobXnjrDlnKjnlLvnmoTmmK8qKui3keedgOeahOa4uOaIjyoq77yI6L+Z5pe26IqC54K55oqV5b2xL+ijgeiKgueCuemDveS4jeaIkOeri++8jOingSBjb2Nvc19jbGlja19ub2Rl77yJ77ybJyArXG4gICAgICAgICdgZmFsc2VgID0g57yW6L6R5Zmo5Zy65pmv44CC5Yik5o2u5pivIGBwcmV2aWV3U3RhdGVg77yIYHN0b3BgL2BwbGF5YC9gcGF1c2Vg77yJ4oCU4oCUIOecn+acuuWunua1iyBmYWNhZGUg6YKj5Lik5p2hKirliKTkuI3lh7oqKui/kOihjOaAgeOAgicgK1xuICAgICAgICAn4pqgIOacrOW3peWFtyoq5Y+q6IO955yL44CB5LiN6IO95byAKirvvJropoHot5HmuLjmiI/or7flnKjnvJbovpHlmajlt6XlhbfmoI/kuIroh6rlt7HmjInmkq3mlL7plK7jgIInO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXh0OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkLCBudWxsLCAyKSwgZGF0YTogcGF5bG9hZCB9O1xufVxuXG4vKipcbiAqIOS7juWcuuaZr+S+p+eahCBydW50aW1lIOWdl+mHjOaMkeWHulwi5Lq66KaB55yL55qE6YKj5Yeg6aG5XCLvvIjljp/moLfmkKzvvIzkuI3lgZrliKTmlq3vvInjgIJcbiAqXG4gKiDimqAgYGdhbWVQYXVzZWRgIOaYryoq5byV5pOO6Ieq5bexKirnmoQgYGNjLmdhbWUuaXNQYXVzZWQoKWDvvJvpooTop4joh6rlt7HnmoTmmoLlgZzmoIflv5flj6bmnInkuIDmoLxcbiAqIGBwcmV2aWV3SXNQYXVzZWDvvIhgY2NlLlByZXZpZXdQbGF5LmlzUGF1c2UoKWDvvInjgILkuKTogIXlkKvkuYnkuI3lkIzvvIzmkYblnKjkuIDotbfnnIvvvJpcbiAqIOWunua1iyBgcGF1c2UodHJ1ZSlgIOS5i+WQjioq5LiJ5Liq6YO95Y+YIHRydWUqKu+8jOS9huWPquaciSBgZnJhbWVzYCDog73or4HmmI5cIuecn+eahOWGu+S9j+S6hlwi44CCXG4gKi9cbmZ1bmN0aW9uIHJ1bnRpbWVTdW1tYXJ5KHJ1bnRpbWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gICAgaWYgKCFydW50aW1lIHx8IHR5cGVvZiBydW50aW1lICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XG4gICAgY29uc3Qgc291cmNlcyA9IChydW50aW1lLnNvdXJjZXMgfHwge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHJldHVybiB7XG4gICAgICAgIG1vZGU6IHJ1bnRpbWUubW9kZSA/PyAndW5rbm93bicsXG4gICAgICAgIHJ1bm5pbmc6IHJ1bnRpbWUucnVubmluZyA9PT0gdHJ1ZSxcbiAgICAgICAgcGF1c2VkOiB0eXBlb2YgcnVudGltZS5wYXVzZWQgPT09ICdib29sZWFuJyA/IHJ1bnRpbWUucGF1c2VkIDogbnVsbCxcbiAgICAgICAgLyoqIGBQcmV2aWV3UGxheS5fc3RhdGVg77yI56eB5pyJ5a2X5q6177yM5Y6f5qC35pCs77yJ4oCU4oCUICoq6L+Q6KGM5oCB55qE5ZSv5LiA5Yik5o2uKiogKi9cbiAgICAgICAgcHJldmlld1N0YXRlOiBzb3VyY2VzLnByZXZpZXdTdGF0ZSA/PyBudWxsLFxuICAgICAgICBwcmV2aWV3SXNQYXVzZTogdHlwZW9mIHNvdXJjZXMucHJldmlld0lzUGF1c2UgPT09ICdib29sZWFuJyA/IHNvdXJjZXMucHJldmlld0lzUGF1c2UgOiBudWxsLFxuICAgICAgICAvKiog5bin6K6h5pWw77ya5Yik44CM5Ya75L2P5rKh5pyJIC8gc3RlcCDmnInmsqHmnInotbDjgI3lj6rmnInlroPog73or7Tor50gKi9cbiAgICAgICAgZnJhbWVzOiB0eXBlb2Ygc291cmNlcy50b3RhbEZyYW1lcyA9PT0gJ251bWJlcicgPyBzb3VyY2VzLnRvdGFsRnJhbWVzIDogbnVsbCxcbiAgICAgICAgZGlyZWN0b3JQYXVzZWQ6IHR5cGVvZiBzb3VyY2VzLmRpcmVjdG9yUGF1c2VkID09PSAnYm9vbGVhbicgPyBzb3VyY2VzLmRpcmVjdG9yUGF1c2VkIDogbnVsbCxcbiAgICAgICAgZ2FtZVBhdXNlZDogdHlwZW9mIHNvdXJjZXMuZ2FtZVBhdXNlZCA9PT0gJ2Jvb2xlYW4nID8gc291cmNlcy5nYW1lUGF1c2VkIDogbnVsbCxcbiAgICAgICAgbm90ZTogcnVudGltZS5ub3RlLFxuICAgIH07XG59XG5cbi8qKlxuICog57uZ5Zue5omn6KGl5LiA5q61IGByZWZzYO+8iOWPr+WkjeeUqOeahOagh+ivhu+8ieKAlOKAlCDmr4/kuKrmlrnms5Xpg73ov4fov5nkuIDpgZPjgIJcbiAqXG4gKiDkuKTmnaHlj6PlvoTvvJpcbiAqXG4gKiAxLiAqKuWPquWcqOaKveWIsOS4nOilv+aXtuWKqOWbnuaJpyoq77ya5LiA5p2h6YO95rKh5pyJ5bCx5Y6f5qC36L+U5Zue77yM57ud5LiN55WZ5LiL56m65aOz5a2X5q6144CCXG4gKiAyLiAqKuaKveWPluWksei0peS4jeeul+Wksei0pSoq77yaYHJlZnNgIOaYr+mZhOWKoOS/oeaBr++8jOWug+iHquW3seaKm+mUmee7neS4jeiDveaKiuS4gOasoeaIkOWKn+eahOiwg+eUqOWPmOaIkOWksei0pVxuICogICAg77yI5omA5Lul5YyF5ZyoIHRyeSDph4zvvIzpnZnpu5jmlL7ov4fvvInjgIJcbiAqXG4gKiDmlofmoYjov73liqDlnKggYHRleHRgIOe7k+Wwvu+8iOaooeWei+WPquivuyBgdGV4dGAg4oCU4oCUIOahpeaOpeS+pyBgT1VUUFVULnJlbmRlcmAg5Y+q5riy5p+T5a6D77yJ77ybXG4gKiDnu5PmnoTljJbniYjmnKzmlL4gYGRhdGEucmVmc2DvvIjpnaLmnb/kuI7nlZnmoaPnlKjvvInjgIJcbiAqXG4gKiBAcGFyYW0gaGFuZGxlciAtIOWOn+adpeeahOaWueazleWunueOsOOAglxuICogQHJldHVybnMg5YyF5LqG5LiA5bGC55qE5pa55rOV5a6e546w44CCXG4gKi9cbmZ1bmN0aW9uIHdpdGhSZWZzKFxuICAgIGhhbmRsZXI6IChwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPFRvb2xSZXBseT4sXG4pOiAocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTxUb29sUmVwbHk+IHtcbiAgICByZXR1cm4gYXN5bmMgKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPFRvb2xSZXBseT4gPT4ge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IGhhbmRsZXIocGFyYW1zKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbGxlY3Rpb24gPSBjb2xsZWN0UmVmcyhyZXBseS5kYXRhID8/IHJlcGx5LnRleHQpO1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBmb3JtYXRSZWZzKGNvbGxlY3Rpb24pO1xuICAgICAgICAgICAgaWYgKCFibG9jaykgcmV0dXJuIHJlcGx5O1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IHJlcGx5LmRhdGE7XG4gICAgICAgICAgICByZXBseS5kYXRhID1cbiAgICAgICAgICAgICAgICBkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShkYXRhKVxuICAgICAgICAgICAgICAgICAgICA/IHsgLi4uKGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLCByZWZzOiBjb2xsZWN0aW9uLnJlZnMgfVxuICAgICAgICAgICAgICAgICAgICA6IHsgcmVzdWx0OiBkYXRhLCByZWZzOiBjb2xsZWN0aW9uLnJlZnMgfTtcbiAgICAgICAgICAgIHJlcGx5LnRleHQgPSBgJHtyZXBseS50ZXh0fSR7YmxvY2t9YDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiByZWZzIOaYr+mZhOWKoOS/oeaBr++8muaKveS4jeWHuuadpeWwseS4jeWKoO+8jOS4jeW9seWTjei/measoeiwg+eUqCAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXBseTtcbiAgICB9O1xufVxuXG4vKipcbiAqIElQQyDmlrnms5XliIblj5HooajjgIJcbiAqXG4gKiDimqAg6ZSu5ZCN5b+F6aG75LiOIERTSCDkvqfmj5Lku7bph4wgYGlwY0NhbGwoJy4uLicpYCDnmoTlrZfnrKbkuLLkuIDoh7RcbiAqIO+8iOingSBgZHNoLXByb2ZpbGUvcGx1Z2luL2RzaC1jb2Nvcy1icmlkZ2UvaW5kZXguanNg77yJ44CCXG4gKi9cbmV4cG9ydCBjb25zdCBDT0NPU19JUENfTUVUSE9EUzogUmVjb3JkPHN0cmluZywgKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8VG9vbFJlcGx5Pj4gPSB7XG4gICAgZXhlY3V0ZV9jb2RlOiB3aXRoUmVmcyhydW5FeGVjdXRlQ29kZSksXG4gICAgZGVzY3JpYmVfYXBpOiB3aXRoUmVmcyhkZXNjcmliZUFwaSksXG4gICAgZWRpdG9yX3N0YXRlOiB3aXRoUmVmcyhyZWFkRWRpdG9yU3RhdGUpLFxuICAgIGNhcHR1cmVfdmlldzogd2l0aFJlZnMocnVuQ2FwdHVyZVZpZXcpLFxuICAgIHJlYWRfbG9nczogd2l0aFJlZnMocmVhZExvZ3MpLFxuICAgIGNsaWNrX25vZGU6IHdpdGhSZWZzKHJ1bkNsaWNrTm9kZSksXG4gICAgc2VuZF9rZXlzOiB3aXRoUmVmcyhydW5TZW5kS2V5cyksXG4gICAgcnVudGltZTogd2l0aFJlZnMocnVuUnVudGltZSksXG59O1xuIl19