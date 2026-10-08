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

import { EXTENSION_NAME, type ToolReply } from './constants';
import {
    captureView,
    describeSceneApi,
    executeCode,
    pingSceneScript as pingScene,
    readNodeGeometry,
    readSceneRuntime,
} from './core/engine';
import { collectRefs, formatRefs } from './core/serialize';
import { clickAt, sendKeys } from './input';
import { readLogs } from './logs';
import { querySceneMode } from './preview';

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
        /**
         * 界面交互（点按 / 按键 / 看一眼运行态）是三条**独立通道**，不在 `execute_code` 的射程里 ——
         * 这里必须点一次名：模型在"改完 UI 想验一下"时最容易只想到截图与读节点数据。
         */
        "- **点一下试试**：cocos_click_node({node:'<节点路径>'})（真鼠标事件；运行态下要改用坐标，见该工具说明）",
        "- 看一眼运行态：cocos_runtime({action:'state'})（**只读**；要跑游戏请人在编辑器工具栏上按播放键，本工具不开预览）",
        /**
         * ⚠ 开场景这条**必须点出来**：真机实测 2026-11 —— `open-scene` 传 `db://` 路径
         * **不是"打开那个场景"**，而是开出一个**新的未命名 2D 场景**（根 uuid 每次都不同、
         * 磁盘上文件没变），而且**不报错**，接着往下做就会在空场景里改东西。
         * 传资源 **uuid** 才是开它。详见 skill 的「坑 15」。
         */
        "- 要开别的场景：open-scene 给**资源 uuid**（`ba018ca9-…` 这种），**别给 `db://` 路径** —— 实测给路径会开出**一个新的空场景**且不报错（skill 坑 15）",
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
export async function runClickNode(params: Record<string, unknown>): Promise<ToolReply> {
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
    const geometry = await readNodeGeometry(nodeRef);
    if (geometry.ok !== true) {
        return clickFail(`拿不到页面几何：${describe(geometry.error)}。${SCENE_SCRIPT_HINT}`);
    }
    const page = (geometry.page || {}) as Record<string, any>;
    const runtime = (geometry.runtime || {}) as Record<string, any>;
    const running = runtime.running === true;
    const href = typeof page.href === 'string' ? page.href : '';

    const nodeInfo = (geometry.node || null) as Record<string, any> | null;

    // ---- ② 算出那个点（页面 CSS 像素）----
    let px = 0;
    let py = 0;
    let how = '';
    if (nodeRef) {
        if (running) {
            return clickFail(
                `现在是**运行态**（编辑器内预览跑着游戏），按节点投影点不了：那一刻画面由**游戏自己的相机**渲染，` +
                    '而节点矩形是用**编辑器相机**投出来的 —— 两者不是同一个取景，按它点会点到别的地方去。\n' +
                    '两条可用路：① 请**人在编辑器工具栏上按停止**，回到编辑态再点（适合点 UI 的静态布局）；' +
                    '② 直接用坐标：先 `cocos_capture_view({view:"game"})` 看清画面，再用 `cocos_click_node({x, y, space:"uv"})`。',
                { mode: { actual: runtime.mode ?? 'unknown', running: true, sources: runtime.sources ?? null } },
            );
        }
        if (!nodeInfo || nodeInfo.found !== true) {
            return clickFail(
                `没找到节点「${nodeRef}」${nodeInfo && nodeInfo.note ? `（${nodeInfo.note}）` : ''}（uuid 用 node.uuid，路径形如 Canvas/panel/btn）。`,
                { mode: { actual: runtime.mode ?? 'unknown', running: false, sources: runtime.sources ?? null } },
            );
        }
        if (!nodeInfo.rect) {
            return clickFail(
                `节点「${nodeInfo.name || nodeRef}」算不出在页面上的矩形${nodeInfo.note ? `（${nodeInfo.note}）` : ''} —— 点不了中心。`,
                { node: nodeInfo },
            );
        }
        const rect = nodeInfo.rect as { x: number; y: number; width: number; height: number };
        px = rect.x + rect.width / 2;
        py = rect.y + rect.height / 2;
        how = `节点矩形中心（rect ${rect.x},${rect.y} ${rect.width}×${rect.height}）`;
    } else if (space === 'uv') {
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
    } else {
        px = Number(params.x);
        py = Number(params.y);
        how = '直接给的页面 CSS 像素坐标';
    }

    // ---- ③ probe：点之前问一次「编辑器认为这个点上是哪个节点」（只在编辑态成立）----
    let probe: Record<string, unknown> | null = null;
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
    const outcome = await clickAt(
        px,
        py,
        {
            button: params.button === undefined ? undefined : (String(params.button) as 'left' | 'right' | 'middle'),
            clickCount: typeof params.clickCount === 'number' ? params.clickCount : undefined,
            modifiers: Array.isArray(params.modifiers) ? (params.modifiers as string[]) : undefined,
            pressMs: typeof params.pressMs === 'number' ? params.pressMs : undefined,
            focusWindow: params.focusWindow === false ? false : undefined,
        },
        href,
    );

    const payload: Record<string, unknown> = {
        ok: outcome.ok,
        point: { x: Math.round(px), y: Math.round(py), space: 'view', how },
        mode: { actual: runtime.mode ?? 'unknown', running, sources: runtime.sources ?? null },
        target: outcome.target ?? null,
        matchedBy: outcome.matchedBy ?? null,
        focused: outcome.focused ?? null,
        window: outcome.window ?? null,
        events: outcome.events,
        probe,
    };
    if (!outcome.ok) {
        payload.error = outcome.error;
        if (outcome.contents) payload.contents = outcome.contents;
        payload.hint = '打不到那一页时先 `cocos_execute_code({context:"scene", code:"return 1"})` 确认场景进程可用（没开场景时场景视图网页也不在）。';
        return { ok: false, text: JSON.stringify(payload, null, 2), error: String(outcome.error || '点击失败'), data: payload };
    }

    /**
     * ⚠ 窗口没焦点时**必须把这句话放在最前面**：那时"事件发出去了"与"页面收到了"是两件事，
     * 而回执默认看着像成功（就是本工程最防的那种假绿）。
     */
    if (outcome.window && outcome.window.focused === false) {
        payload.hint = outcome.window.note;
    } else if (probe && !probe.skipped && probe.verdict === 'hit') {
        payload.hint =
            '这一下真发出去了（窗口焦点没问题）。**要证明点对了，点前后各截一张图对比**（`probe` 只能证明"这个坐标在页面上是它"，证明不了"Chromium 把它送到了"）。';
    } else {
        payload.hint = '这一下真发出去了。点前后各截一张图对比才知道有没有生效。';
    }
    return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
}

/** 点节点失败时的统一回执（不抛，让模型看到可读的原因）。 */
function clickFail(message: string, extra?: Record<string, unknown>): ToolReply {
    const payload = { ok: false, error: message, ...(extra ?? {}) };
    return { ok: false, text: JSON.stringify(payload, null, 2), error: message, data: payload };
}

/**
 * 问一次「这个点是哪个节点」—— 走场景沙箱里的 `pick(x, y)`（编辑器自己的命中测试）。
 *
 * ⚠ 它是**事实**，不是判据：回执把 `verdict` / `hit` / 命中个数原样带回来，
 * 由调用方决定"这算不算点对了"（本扩展不认识"该点到哪个节点"）。
 */
async function probePoint(x: number, y: number): Promise<Record<string, unknown>> {
    try {
        const reply = await executeCode({
            context: 'scene',
            timeoutMs: 8000,
            code: 'const r = pick(args.x, args.y); return { verdict: r.verdict, hit: r.hit, hitCount: (r.hits || []).length, invisibleCount: (r.invisible || []).length };',
            args: { x, y },
        });
        const value = unwrapSandboxResult(reply.data) as Record<string, unknown> | undefined;
        if (!reply.ok || !value) return { error: reply.text.slice(0, 300) };
        return value;
    } catch (error) {
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
export async function runSendKeys(params: Record<string, unknown>): Promise<ToolReply> {
    const key = typeof params.key === 'string' ? params.key.trim() : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!key && !text) return clickFail('要给 `key`（按一下某个键）或 `text`（输入一段字）中的至少一个。');

    /** 目标页的 href：场景脚本报的最确定；拿不到就退回按 URL 特征找（`findSceneView` 的兜底） */
    const geometry = await readNodeGeometry('');
    const href = geometry.ok === true && typeof (geometry.page || {}).href === 'string' ? (geometry.page as Record<string, any>).href : '';

    const outcome = await sendKeys(
        {
            key,
            text,
            modifiers: Array.isArray(params.modifiers) ? (params.modifiers as string[]) : undefined,
            pressMs: typeof params.pressMs === 'number' ? params.pressMs : undefined,
            focusWindow: params.focusWindow === false ? false : undefined,
        },
        href,
    );

    const payload: Record<string, unknown> = {
        ok: outcome.ok,
        key: key || null,
        text: text || null,
        target: outcome.target ?? null,
        matchedBy: outcome.matchedBy ?? null,
        focused: outcome.focused ?? null,
        window: outcome.window ?? null,
        events: outcome.events,
        hrefSource: href ? '场景脚本报的 location.href' : '没量到 href，按 URL 特征找的',
    };
    if (!outcome.ok) {
        payload.error = outcome.error;
        if (outcome.contents) payload.contents = outcome.contents;
        return { ok: false, text: JSON.stringify(payload, null, 2), error: String(outcome.error || '发按键失败'), data: payload };
    }
    if (outcome.window && outcome.window.focused === false) {
        payload.hint = outcome.window.note;
    } else if (outcome.focused === false) {
        payload.hint = '目标页当时**没有**键盘焦点 —— 打字类（text）多半不会进输入框；先用 cocos_click_node 点一下那个输入框再来。';
    } else {
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
export async function runRuntime(params: Record<string, unknown>): Promise<ToolReply> {
    const action = typeof params.action === 'string' && params.action.trim() ? params.action.trim() : 'state';
    if (action !== 'state') {
        return clickFail(
            `\`cocos_runtime\` 只认 \`state\`（只读），收到 ${JSON.stringify(params.action)}。` +
                '`play` / `stop` / `pause` / `resume` / `step` 这五个开关**已于 2026-10-08 撤掉** —— ' +
                '它们与两次「编辑器场景画布黑屏/画面停住」的现场同一条时间线（见 `docs/冻结诊断.md`），' +
                '而收益极小：编辑器内跑起来会卡在首场景 Loading 的 `loadBundle(\'scripts\')`（0%）。' +
                '要看游戏画面请在**编辑器工具栏上自己按那颗播放键**，本工具不代劳。',
        );
    }

    const payload: Record<string, unknown> = { ok: true, action: 'state' };

    /** 主进程这一侧的问法（编辑器自己的消息）—— 只当一条来源摆出来 */
    const modeProbe = await querySceneMode();
    payload.editorMessage = {
        message: 'query-scene-mode',
        mode: modeProbe.mode,
        raw: modeProbe.raw,
        ok: modeProbe.ok,
        error: modeProbe.error,
        note: modeProbe.note,
    };

    /** 场景进程那一侧的问法（`cce` 单例）—— **运行态的判据在这边** */
    const sceneProbe = await readSceneRuntime();
    payload.scene = sceneProbe.ok ? sceneProbe.runtime : { error: sceneProbe.error };
    payload.before = runtimeSummary(payload.scene as Record<string, unknown>);
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
function runtimeSummary(runtime: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!runtime || typeof runtime !== 'object') return null;
    const sources = (runtime.sources || {}) as Record<string, unknown>;
    return {
        mode: runtime.mode ?? 'unknown',
        running: runtime.running === true,
        paused: typeof runtime.paused === 'boolean' ? runtime.paused : null,
        /** `PreviewPlay._state`（私有字段，原样搬）—— **运行态的唯一判据** */
        previewState: sources.previewState ?? null,
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
function withRefs(
    handler: (params: Record<string, unknown>) => Promise<ToolReply>,
): (params: Record<string, unknown>) => Promise<ToolReply> {
    return async (params: Record<string, unknown>): Promise<ToolReply> => {
        const reply = await handler(params);
        try {
            const collection = collectRefs(reply.data ?? reply.text);
            const block = formatRefs(collection);
            if (!block) return reply;
            const data = reply.data;
            reply.data =
                data && typeof data === 'object' && !Array.isArray(data)
                    ? { ...(data as Record<string, unknown>), refs: collection.refs }
                    : { result: data, refs: collection.refs };
            reply.text = `${reply.text}${block}`;
        } catch {
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
export const COCOS_IPC_METHODS: Record<string, (params: Record<string, unknown>) => Promise<ToolReply>> = {
    execute_code: withRefs(runExecuteCode),
    describe_api: withRefs(describeApi),
    editor_state: withRefs(readEditorState),
    capture_view: withRefs(runCaptureView),
    read_logs: withRefs(readLogs),
    click_node: withRefs(runClickNode),
    send_keys: withRefs(runSendKeys),
    runtime: withRefs(runRuntime),
};
