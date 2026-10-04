/**
 * 验证「本扩展自带的编辑器引擎」（`core/engine.ts` + `source/scene.ts`）。
 *
 * ## 为什么需要它
 *
 * 迁移之前，编辑器的执行能力是**借** dfan_mcp2 的；搬进来之后，那条依赖没了，
 * 但**没有任何编译期信号**能证明它真的还能跑：沙箱是 vm、场景脚本在另一个进程、
 * recipe 要走真实文件系统。这个脚本不开编辑器、不碰正在跑的 agent，用**假 Editor + 假 cc**
 * 把整条链路真跑一遍：
 *
 * ```
 * cocos-tools(IPC 服务端) → core/engine → ① vm 沙箱（editor 上下文）
 *                                       → ② 真 dist/scene.js 的 runCode（scene 上下文）
 * ```
 *
 * 「真 dist/scene.js」是关键：`execute-scene-script` 这一档在真编辑器里由 scene 包转发，
 * 这里用桩把 `Editor.Message.request('scene','execute-scene-script',{name,method,args})`
 * 直接打到 `require('../dist/scene.js').methods[method]` —— 于是**场景脚本本身**也被真跑了。
 *
 * ```sh
 * npm run build && node scripts/verify-cocos-engine.js
 * ```
 *
 * ⚠ 假定 dist 是新的：改完 TS 先 build（本脚本只验证构建产物）。
 *
 * @module dsh_chat/verify-cocos-engine
 */

'use strict';

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');

/** 扩展根目录（`scripts/` 的上一级）。 */
const EXT_ROOT = resolve(__dirname, '..');

/** 一次性的「假工程」目录：工程根、cc 桩、recipe 全落在这里，跑完可以整个删掉。 */
const FAKE_PROJECT = join(os.tmpdir(), 'dsh-chat-verify-engine');

/** 场景脚本报告不可用时的错误文案（与真编辑器一致，用来验证降级提示）。 */
const SCENE_MISSING_MESSAGE = 'Scenario scripts do not exist: dsh_chat';

let failures = 0;
let checks = 0;

/**
 * 记一条断言结果。
 *
 * @param {string} label - 断言描述。
 * @param {boolean} ok - 是否通过。
 * @param {unknown} [detail] - 失败时要打出来的证据。
 */
function check(label, ok, detail) {
    checks += 1;
    if (ok) {
        console.log(`  ✅ ${label}`);
        return;
    }
    failures += 1;
    process.exitCode = 1; // 早退路径也要红 —— 别只靠结尾那一行（见 verify-replay 踩过的洞）。
    console.log(`  ❌ ${label}`);
    if (detail !== undefined) console.log(`     证据：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

/** 造一个假的 `cc` 模块（场景脚本 `require('cc')` 时拿到它）。 */
function makeFakeCc() {
    const nodeModules = join(FAKE_PROJECT, 'node_modules', 'cc');
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(
        join(nodeModules, 'index.js'),
        [
            "'use strict';",
            'const director = { getScene: () => null };',
            'function Node() {}',
            "Node.__props__ = ['name', 'position', 'active'];",
            'function Camera() {}',
            "Camera.__props__ = ['fov', 'near', 'far', 'orthoHeight'];",
            'function SpriteFrame() {}',
            'function UITransform() {}',
            /**
             * 假的资源加载：**只认带 `@` 的子资源 uuid**（那才是 SpriteFrame），
             * 裸 uuid 一律回一个「看起来像 Texture2D」的东西 ——
             * 这正是真引擎的行为（图片 uuid 直接加载拿到的是 Texture2D，不是 SpriteFrame），
             * loadFrame 必须据此补一次 `@f9941`。
             */
            'const assetManager = {',
            '    loaded: [],',
            '    loadAny(options, cb) {',
            '        const uuid = String((options && options.uuid) || "");',
            '        assetManager.loaded.push(uuid);',
            '        if (uuid.indexOf("@") >= 0) return cb(null, new SpriteFrame());',
            '        return cb(null, { constructor: { name: "Texture2D" } });',
            '    },',
            '};',
            'module.exports = {',
            '    director,',
            '    js: { getClassName: (cls) => (cls && cls.name) || "FakeClass" },',
            '    Node,',
            '    Camera,',
            '    SpriteFrame,',
            '    UITransform,',
            '    assetManager,',
            '};',
            '',
        ].join('\n'),
        'utf8',
    );
    writeFileSync(join(nodeModules, 'package.json'), '{"name":"cc","version":"0.0.0"}', 'utf8');

    // 工程根下放一个小夹具，验证 readJson() 的「相对路径按工程根解析」
    writeFileSync(join(FAKE_PROJECT, 'verify-fixture.json'), '{"name":"dsh_chat","ok":true}', 'utf8');

    /**
     * 一张假的图片 `.meta`（含 spriteFrame 子资源）—— `loadFrame` 的按路径解析靠它。
     * 子资源键刻意**不用** `f9941`（真的就是它），以证明解析是读 `.meta` 得来的、不是猜的。
     */
    const textureDir = join(FAKE_PROJECT, 'assets', 'resources', 'textures', 'common');
    mkdirSync(textureDir, { recursive: true });
    writeFileSync(
        join(textureDir, 'probe.png.meta'),
        JSON.stringify(
            {
                ver: '1.0.26',
                importer: 'image',
                uuid: 'probe-uuid-0000-0000-000000000000',
                subMetas: {
                    '6c48a': { importer: 'texture', name: 'texture', uuid: 'probe-uuid-0000-0000-000000000000@6c48a' },
                    ab12c: { importer: 'sprite-frame', name: 'spriteFrame', uuid: 'probe-uuid-0000-0000-000000000000@ab12c' },
                },
            },
            null,
            2,
        ),
        'utf8',
    );
}

/**
 * 装一套「假编辑器」：`Editor` 全局 + `Editor.Message.request` 转发到真场景脚本。
 *
 * @param {{ sceneAvailable?: boolean }} [options] - `sceneAvailable: false` 模拟「没打开场景」。
 */
function installFakeEditor(options = {}) {
    const state = { sceneAvailable: options.sceneAvailable !== false, snapshots: 0, calls: [] };

    /** 场景脚本实例（模拟编辑器 scene 包的 `execute-scene-script` 查找）。 */
    let sceneScript = null;
    const loadSceneScript = () => {
        if (!sceneScript) sceneScript = require(join(EXT_ROOT, 'dist', 'scene.js'));
        return sceneScript;
    };

    global.Editor = {
        Project: { path: FAKE_PROJECT },
        App: { version: '3.8.6', name: 'CocosCreator', path: FAKE_PROJECT },
        Package: {
            // 场景脚本按绝对路径 require `dist/core/recipes.js` 就靠它
            getPath: (name) => (name === 'dsh_chat' ? EXT_ROOT : undefined),
        },
        Message: {
            async request(name, message, payload) {
                state.calls.push(`${name}/${message}`);
                if (name === 'scene' && message === 'execute-scene-script') {
                    if (!state.sceneAvailable) throw new Error(SCENE_MISSING_MESSAGE);
                    // 真编辑器按 `name` 在场景进程里找扩展脚本 —— 名字写错就会是「脚本不存在」，
                    // 所以这条契约必须在桩里也成立（我们要的必须是自己的名字）
                    if (payload.name !== 'dsh_chat') throw new Error(`Scenario scripts do not exist: ${payload.name}`);
                    const methods = loadSceneScript().methods || {};
                    const fn = methods[payload.method];
                    if (typeof fn !== 'function') throw new Error(`Message does not exist: ${payload.method}`);
                    return await fn(...(payload.args || []));
                }
                if (name === 'scene' && message === 'snapshot') {
                    state.snapshots += 1;
                    return undefined;
                }
                if (name === 'scene' && message === 'query-node-tree') {
                    return { name: 'scene-2d', uuid: 'fake-scene-uuid' };
                }
                throw new Error(`未桩的编辑器消息：${name} / ${message}`);
            },
            broadcast() {},
        },
        Profile: {
            async getConfig() {
                return {};
            },
            async setConfig() {},
        },
        Logger: { info() {}, warn() {}, error() {}, debug() {} },
    };

    return state;
}

/** 取一段错误文本（回执形状：`{ok, text, error}`）。 */
function errorText(reply) {
    return `${reply && reply.error ? reply.error : ''} ${reply && reply.text ? reply.text : ''}`.trim();
}

async function main() {
    console.log(`\n=== 假工程：${FAKE_PROJECT} ===`);
    rmSync(FAKE_PROJECT, { recursive: true, force: true });
    mkdirSync(FAKE_PROJECT, { recursive: true });
    makeFakeCc();

    const state = installFakeEditor();

    // 先别急着 require：engine/scene 都在调用时才读 Editor 全局，但 cocos-tools 也要求它已就位。
    const engine = require(join(EXT_ROOT, 'dist', 'core', 'engine.js'));
    const scene = require(join(EXT_ROOT, 'dist', 'scene.js'));

    // ---------------------------------------------------------------------
    console.log('\n[1] 契约：场景脚本被正确注册');
    // ---------------------------------------------------------------------
    const pkg = JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8'));
    const sceneContribution = pkg.contributions && pkg.contributions.scene;
    check('package.json 声明了 contributions.scene', Boolean(sceneContribution), sceneContribution);
    check(
        'contributions.scene.script 指向 ./dist/scene.js',
        Boolean(sceneContribution) && sceneContribution.script === './dist/scene.js',
        sceneContribution && sceneContribution.script,
    );
    const sceneMethods = (sceneContribution && sceneContribution.methods) || [];
    check(
        '三个场景方法都注册了（ping / runCode / describeApi）',
        ['ping', 'runCode', 'describeApi'].every((m) => sceneMethods.includes(m)),
        sceneMethods,
    );
    check('dist/scene.js 存在（构建产物）', existsSync(join(EXT_ROOT, 'dist', 'scene.js')));
    check('场景脚本导出 methods', Boolean(scene.methods && typeof scene.methods.runCode === 'function'));

    // ---------------------------------------------------------------------
    console.log('\n[2] 场景脚本本身（真跑 dist/scene.js）');
    // ---------------------------------------------------------------------
    const ping = await scene.methods.ping();
    check('ping() 回 ok（探活靠它）', ping && ping.ok === true, ping);

    const sceneMath = await scene.methods.runCode({ code: 'return 1 + 1', timeoutMs: 5000 });
    check('runCode 真执行并回值（1+1=2）', sceneMath && sceneMath.ok === true && sceneMath.result === 2, sceneMath);

    const sceneHelpers = await scene.methods.runCode({
        code: 'return { eachNode: typeof eachNode, nodeByPath: typeof nodeByPath, tree: typeof tree, dump: typeof dump, snapshot: typeof snapshot, contentChildren: typeof contentChildren, isEditorNode: typeof isEditorNode, captureView: typeof captureView, loadFrame: typeof loadFrame, worldRect: typeof worldRect, saveRecipe: typeof saveRecipe, runRecipe: typeof runRecipe };',
        timeoutMs: 5000,
    });
    const helperTypes = (sceneHelpers && sceneHelpers.result) || {};
    check(
        '助手都注入了沙箱（eachNode/nodeByPath/tree/dump/snapshot/captureView/loadFrame/worldRect + recipe 五件套）',
        Object.values(helperTypes).every((t) => t === 'function'),
        helperTypes,
    );

    // ---------------------------------------------------------------------
    console.log('\n[2b] 两个把「已知必踩」收进插件的助手：loadFrame / worldRect');
    // ---------------------------------------------------------------------
    /**
     * `loadFrame`：按 `db://` 路径走**磁盘上的 .meta** 找到 spriteFrame 子资源。
     *
     * 这一条钉住的是实测事故：模型在编辑器里给 Sprite 赋图，`cc.resources.load('…/spriteFrame')`
     * 报 `Can not parse this input`，`query-assets({pattern:'…/spriteFrame'})` **静默回空数组**，
     * 最后靠手工读 `.meta` 拿到 `@f9941` 才成 —— 三步弯路，每次换个会话重来一遍。
     */
    const frameLoad = await scene.methods.runCode({
        code: "const sf = await loadFrame('db://assets/resources/textures/common/probe.png'); return { cls: sf && sf.constructor && sf.constructor.name, loaded: cc.assetManager.loaded.slice() };",
        timeoutMs: 5000,
    });
    check(
        'loadFrame 按 db:// 路径解析出 SpriteFrame（读 .meta 的 spriteFrame 子资源，不是猜 @f9941）',
        frameLoad.ok === true && frameLoad.result.cls === 'SpriteFrame' && frameLoad.result.loaded.join() === 'probe-uuid-0000-0000-000000000000@ab12c',
        frameLoad,
    );

    const frameInternal = await scene.methods.runCode({
        code: "try { await loadFrame('db://internal/default_ui/default_sprite.png'); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }",
        timeoutMs: 5000,
    });
    check(
        'loadFrame 对 db://internal 明说「映射不到工程目录」（不是静默失败）',
        frameInternal.ok === true && frameInternal.result.threw === true && /internal/.test(frameInternal.result.message),
        frameInternal,
    );

    const frameBad = await scene.methods.runCode({
        code: "try { await loadFrame('随便一段不是引用的东西'); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }",
        timeoutMs: 5000,
    });
    check(
        'loadFrame 认不出的引用会抛出带用法的错误（不给 null 让人猜）',
        frameBad.ok === true && frameBad.result.threw === true && /db:\/\/assets/.test(frameBad.result.message),
        frameBad,
    );

    /**
     * `worldRect`：**用假节点把几何算对** —— 锚点/位置/缩放在一条两层的链上。
     *
     * 手工核对（root 锚点为原点，root 不参与累加）：
     *   panel  scale 2、position (10, 20)  → 锚点 (10,20)，链缩放 2
     *   card   position (-5, -10)，自身 scale 1，contentSize 100×50、anchor (0.5, 0.5)
     *   锚点世界 = (10,20) + 2×(-5,-10) = (0, 0)；尺寸 = 2×(100,50) = (200,100)
     *   → cx,cy = (0,0)，left/right = ∓100，bottom/top = ∓50
     */
    const rectRun = await scene.methods.runCode({
        code: [
            'const ut = (w, h, ax, ay) => ({ width: w, height: h, anchorX: ax === undefined ? 0.5 : ax, anchorY: ay === undefined ? 0.5 : ay });',
            'const mk = (name, position, scale, transform) => ({',
            '    name, position, scale, parent: null,',
            '    getComponent: () => transform,',
            '});',
            'const root = mk("root", { x: 999, y: 999 }, { x: 1, y: 1 }, ut(750, 1334));',
            'const panel = mk("panel", { x: 10, y: 20 }, { x: 2, y: 2 }, ut(200, 200));',
            'const card = mk("card", { x: -5, y: -10 }, { x: 1, y: 1 }, ut(100, 50));',
            'const dot = mk("dot", { x: 7, y: 0 }, { x: 1, y: 1 }, ut(10, 10, 0, 0.5));',
            'panel.parent = root; card.parent = panel; dot.parent = root;',
            'return { inRoot: worldRect(card, { root }), inScene: worldRect(card), anchored: worldRect(dot, { root }) };',
        ].join('\n'),
        timeoutMs: 5000,
    });
    const rect = (rectRun && rectRun.result) || {};
    const inRoot = rect.inRoot || {};
    check(
        'worldRect 的锚点/位置/缩放累加算对（root 不参与累加）',
        rectRun.ok === true &&
            inRoot.cx === 0 &&
            inRoot.cy === 0 &&
            inRoot.width === 200 &&
            inRoot.height === 100 &&
            inRoot.left === -100 &&
            inRoot.right === 100 &&
            inRoot.bottom === -50 &&
            inRoot.top === 50 &&
            inRoot.scaleX === 2,
        rectRun,
    );
    check(
        'worldRect 不回退到 getBoundingBoxToWorld（自带原点口径说明）',
        typeof inRoot.origin === 'string' && inRoot.origin.includes('root'),
        inRoot.origin,
    );
    const anchored = rect.anchored || {};
    check(
        'worldRect 认锚点（anchor (0,0.5)、x=7 的节点中心应偏右半宽）',
        anchored.cx === 12 && anchored.cy === 0,
        anchored,
    );

    const sceneArgs = await scene.methods.runCode({ code: 'return { n: args.n * 2 }', args: { n: 21 }, timeoutMs: 5000 });
    check('args 一路透传到场景沙箱', sceneArgs && sceneArgs.ok === true && sceneArgs.result.n === 42, sceneArgs);

    const sceneTimeout = await scene.methods.runCode({ code: 'while (true) {}', timeoutMs: 300 });
    check(
        '同步死循环被掐断（timedOut）—— 场景进程卡死 = 编辑器冻住',
        sceneTimeout && sceneTimeout.ok === false && sceneTimeout.timedOut === true,
        sceneTimeout,
    );

    // ---------------------------------------------------------------------
    console.log('\n[3] editor 上下文沙箱（core/engine）');
    // ---------------------------------------------------------------------
    const editorRun = await engine.executeCode({
        context: 'editor',
        code: 'return { root: projectPath().length > 0, helpers: helperNames().length, extensionRoot: typeof extensionRoot };',
    });
    check('editor 沙箱能拿到工程根与助手清单', editorRun.ok === true && editorRun.data.result.helpers > 5, editorRun.data);

    const editorArgs = await engine.executeCode({ context: 'editor', code: 'return args.n * 2', args: { n: 21 } });
    check('args 透传到 editor 沙箱', editorArgs.ok === true && editorArgs.data.result === 42, editorArgs.data);

    const editorJson = await engine.executeCode({
        context: 'editor',
        code: "return readJson('verify-fixture.json').name",
    });
    check('readJson 按工程根解析相对路径', editorJson.ok === true && editorJson.data.result === 'dsh_chat', editorJson.data);

    const editorError = await engine.executeCode({ context: 'editor', code: "throw new Error('boom')" });
    check(
        '抛错回 ok:false + 可读原因（不是崩掉）',
        editorError.ok === false && /boom/.test(errorText(editorError)),
        editorError.error,
    );

    const editorTimeout = await engine.executeCode({ context: 'editor', code: 'while (true) {}', timeoutMs: 300 });
    check('editor 沙箱同步死循环也超时', editorTimeout.ok === false && editorTimeout.data.timedOut === true, editorTimeout.data);

    // ---------------------------------------------------------------------
    console.log('\n[4] recipe：复用门禁 + 落盘 + 回跑');
    // ---------------------------------------------------------------------
    const gateUuid = await engine.executeCode({
        context: 'editor',
        code: "return saveRecipe('er-oneoff', \"return nodeByUuid('3d901b39-6168-4dbe-bda3-2641b82f4c7d').name\", { description: '查一个写死 uuid 的节点', params: {}, returns: '节点名' })",
    });
    const gateUuidResult = gateUuid.data && gateUuid.data.result;
    check(
        '门禁：写死 uuid 的代码被拒（一次性值）',
        Boolean(gateUuidResult) && gateUuidResult.ok === false && /uuid/.test(gateUuidResult.error || ''),
        gateUuidResult,
    );

    const gateUnused = await engine.executeCode({
        context: 'editor',
        code: "return saveRecipe('er-unused-param', 'return 1', { description: '声明了参数却没用', params: { n: '一个没被用到的参数' }, returns: '一个数' })",
    });
    const gateUnusedResult = gateUnused.data && gateUnused.data.result;
    check(
        '门禁：声明了参数却没用到 → 拒（抄的是探索不是函数）',
        Boolean(gateUnusedResult) && gateUnusedResult.ok === false && /args\.n/.test(gateUnusedResult.error || ''),
        gateUnusedResult,
    );

    const gateNoMeta = await engine.executeCode({
        context: 'editor',
        code: "return saveRecipe('er-no-meta', 'return args.n', { params: { n: '一个数' } })",
    });
    const gateNoMetaResult = gateNoMeta.data && gateNoMeta.data.result;
    check(
        '门禁：缺 description/returns → 拒',
        Boolean(gateNoMetaResult) && gateNoMetaResult.ok === false && /description/.test(gateNoMetaResult.error || ''),
        gateNoMetaResult,
    );

    const goodCode =
        'const n = args.n;\n' +
        "return { doubled: n * 2, projectReadable: projectPath().length > 0 };";
    const saveGood = await engine.executeCode({
        context: 'editor',
        code: `return saveRecipe('er-double', ${JSON.stringify(goodCode)}, { description: '把入参翻倍并报出工程根是否可读（引擎验证脚本用）', params: { n: '要翻倍的数' }, returns: '{doubled, projectReadable}', context: 'editor' })`,
    });
    const saveGoodResult = saveGood.data && saveGood.data.result;
    check('门禁：合格 recipe 落盘', Boolean(saveGoodResult) && saveGoodResult.ok === true, saveGoodResult);

    const recipeFile = join(FAKE_PROJECT, '.dsh-mcp', 'recipes', 'er-double.js');
    check('落在工程根的 .dsh-mcp/recipes/ 下（不是旧目录）', existsSync(recipeFile), recipeFile);
    if (existsSync(recipeFile)) {
        const text = readFileSync(recipeFile, 'utf8');
        check('文件头带 @dsh-recipe 标记', text.includes('@dsh-recipe'), text.slice(0, 120));
    }
    const readmeFile = join(FAKE_PROJECT, '.dsh-mcp', 'README.md');
    check('目录说明写的是 .dsh-mcp（不是 .dfan-mcp）', existsSync(readmeFile) && readFileSync(readmeFile, 'utf8').includes('.dsh-mcp'));
    check('裸文件只有一个 recipe', readdirSync(join(FAKE_PROJECT, '.dsh-mcp', 'recipes')).filter((f) => f.endsWith('.js')).length === 1);

    const found = await engine.executeCode({ context: 'editor', code: 'return findRecipes()' });
    const foundList = (found.data && found.data.result) || {};
    check('findRecipes 能列出它（索引带 params/returns）', foundList.count === 1 && foundList.recipes[0].name === 'er-double', foundList);

    const ran = await engine.executeCode({
        context: 'editor',
        code: "return await runRecipe('er-double', { n: 4 })",
    });
    // 注意嵌套：外层是沙箱信封，`result` 里才是 runRecipe 自己的回执
    const ranRecipe = ran.data && ran.data.result;
    check('runRecipe 真跑通（4 → 8）', ran.ok === true && ranRecipe && ranRecipe.result.doubled === 8, ran.data);

    const verified = readFileSync(recipeFile, 'utf8');
    check('跑通后回填 verifiedAt', verified.includes('verifiedAt'), verified.slice(0, 200));

    // ---------------------------------------------------------------------
    console.log('\n[5] scene 上下文转发（信封 / 快照 / 序列化）');
    // ---------------------------------------------------------------------
    const sceneRun = await engine.executeCode({
        context: 'scene',
        code: 'return { nodes: typeof eachNode === "function", ccLoaded: !!cc };',
        snapshot: true,
    });
    check('scene 上下文回 ok + result', sceneRun.ok === true && sceneRun.data.result.nodes === true, sceneRun.data);
    check('snapshot:true 由主进程登记撤销快照', sceneRun.data.undoSnapshot === true && state.snapshots === 1, {
        undoSnapshot: sceneRun.data.undoSnapshot,
        snapshots: state.snapshots,
    });

    const sceneThrow = await engine.executeCode({ context: 'scene', code: "throw new Error('scene-boom')" });
    check(
        'scene 侧抛错回结构化 error（不是 undefined）',
        sceneThrow.ok === false && /scene-boom/.test(JSON.stringify(sceneThrow.data.error || '')),
        sceneThrow.data,
    );

    // ---------------------------------------------------------------------
    console.log('\n[5b] context 漏给 / 选错：必须自己说清，而不是回一句 cc is not defined');
    // ---------------------------------------------------------------------
    /**
     * 这一节钉住的是 2026-09-30 17:45 那条会话里最贵的一次弯路：模型**忘了写 context**，
     * 旧实现静默当 editor 跑，回 `ReferenceError: cc is not defined`；模型据此做了 10 步
     * 对照实验（怀疑 args、怀疑代码太长、怀疑 scene 丢了 cc、还错记成 `snapshot: true` 的副作用），
     * 50 步的预算里 10 步花在这里。
     */
    const inferred = await engine.executeCode({
        code: 'return { nodes: typeof eachNode === "function", ccLoaded: !!cc };',
    });
    check(
        '漏给 context + 代码里出现 cc → 自动按 scene 跑（不再静默落到 editor）',
        inferred.ok === true && inferred.data.context === 'scene' && inferred.data.result.ccLoaded === true,
        inferred.data,
    );
    check(
        '推断结果**写在回执里**（contextInferred + notes 说明依据），不悄悄替模型决定',
        inferred.data.contextInferred === true &&
            Array.isArray(inferred.data.notes) &&
            inferred.data.notes.some((n) => n.includes('推断')),
        inferred.data.notes,
    );

    const inferredEditor = await engine.executeCode({
        code: 'return { hasEditor: typeof Editor !== "undefined", root: projectPath().length > 0 };',
    });
    check(
        '漏给 context + 代码里是编辑器专属标识符 → 按 editor 跑',
        inferredEditor.ok === true && inferredEditor.data.context === 'editor' && inferredEditor.data.result.hasEditor === true,
        inferredEditor.data,
    );

    // ⚠ 注意 `typeof cc` **不会**抛 ReferenceError（那是 `typeof 未声明变量` 的合法用法，
    // 返回 "undefined"）—— 要复现真事故必须真去取属性，也就是 `cc.Xxx`
    const wrongContext = await engine.executeCode({ context: 'editor', code: 'return cc.Layers.Enum.UI_2D;' });
    check(
        '显式 context 与代码不符 → 错误里直接给改法（提到 scene）',
        wrongContext.ok === false && /context:\s*'scene'/.test(errorText(wrongContext)),
        errorText(wrongContext).slice(0, 300),
    );

    const wrongContextScene = await engine.executeCode({ context: 'scene', code: 'return require("path").sep;' });
    check(
        '反向（scene 里用 node 模块）也给改法（提到 editor）',
        wrongContextScene.ok === false && /context:\s*'editor'/.test(errorText(wrongContextScene)),
        errorText(wrongContextScene).slice(0, 300),
    );

    /**
     * 长代码 + 真的改了场景 → 回执里提醒存 recipe。
     *
     * 依据是基准里最稳定的一条差评「复用 0 项」：一整段跑通的建树代码没存成 recipe，
     * 下一个会话从零再来（历史上同一个"登录界面预制件"被做了 3 次真跑）。
     */
    const longSceneCode = `// ${'填充'.repeat(700)}\nreturn { ok: true };`;
    const nudged = await engine.executeCode({ context: 'scene', code: longSceneCode, snapshot: true });
    check(
        '长代码 + 改动生效 → 提醒 saveRecipe（复用不再靠自觉）',
        nudged.ok === true &&
            Array.isArray(nudged.data.notes) &&
            nudged.data.notes.some((n) => n.includes('saveRecipe')),
        nudged.data.notes,
    );
    const shortScene = await engine.executeCode({ context: 'scene', code: 'return 1;', snapshot: true });
    check(
        '短探针不提醒（否则每条回执都在喊狼来了）',
        shortScene.ok === true && !(Array.isArray(shortScene.data.notes) && shortScene.data.notes.some((n) => n.includes('saveRecipe'))),
        shortScene.data.notes,
    );

    // ---------------------------------------------------------------------
    console.log('\n[6] 没打开场景时的降级：说得清、能照做');
    // ---------------------------------------------------------------------
    state.sceneAvailable = false;
    const noScene = await engine.executeCode({ context: 'scene', code: 'return 1' });
    check(
        '场景脚本不在时回 ok:false + 含「打开」的可照做提示',
        noScene.ok === false && /打开/.test(errorText(noScene)),
        noScene.error,
    );

    const noSceneCapture = await engine.captureView({});
    check('capture_view 同样给可照做的失败（不是崩）', noSceneCapture.ok === false && /打开/.test(errorText(noSceneCapture)), noSceneCapture.error);

    const noScenePing = await engine.pingSceneScript();
    check('探活回 available:false + 原因', noScenePing.available === false && Boolean(noScenePing.reason), noScenePing);

    const tools = require(join(EXT_ROOT, 'dist', 'cocos-tools.js'));
    const editorStateNoScene = await tools.COCOS_IPC_METHODS.editor_state({});
    check(
        'editor_state 在没场景时仍给出可用信息（降级不崩）',
        editorStateNoScene.text.includes('工程：') && editorStateNoScene.text.includes('只读得动编辑器'),
        editorStateNoScene.text.split('\n').slice(0, 6).join(' | '),
    );
    check(
        'editor_state 不再提 dfan_mcp2（依赖已解除）',
        !/dfan/i.test(editorStateNoScene.text),
        editorStateNoScene.text.slice(0, 200),
    );
    /**
     * ⚠ 这一条是拿 59 分钟换来的：原来 `ok: problems.length === 0`，于是「三项成功、场景一项失败」
     * 也回 `ok:false`，桥接侧见 ok:false 就 reject → 用户看到 `Error: 工程：…`（一个自检工具报错），
     * 然后开了一条会话查「插件是不是坏了」。
     * 口径：**降级 ≠ 失败** —— 拿到任何一块有效信息就回 ok:true，并把 problems/degraded 带上。
     */
    check(
        'editor_state 部分降级不报失败（ok:true + degraded:true + problems 逐条）',
        editorStateNoScene.ok === true &&
            editorStateNoScene.data.degraded === true &&
            Array.isArray(editorStateNoScene.data.problems) &&
            editorStateNoScene.data.problems.length > 0,
        { ok: editorStateNoScene.ok, degraded: editorStateNoScene.data.degraded, problems: editorStateNoScene.data.problems },
    );
    check(
        'editor_state 的「下一步」第一条是可复用配方（recipe 入口必须摆在提示位）',
        /findRecipes/.test(editorStateNoScene.text),
        editorStateNoScene.text.split('\n').filter((line) => /findRecipes/.test(line)).join(' | ').slice(0, 200),
    );

    // 空白帧必须带退路（04:23 会话：只回一句「接近 1 说明基本是空图」→ 模型自建渲染器 16 步）
    const engineBuilt = readFileSync(join(EXT_ROOT, 'dist', 'core', 'engine.js'), 'utf8');
    check(
        'capture_view 的空图回执带可照做的退路（不是只说「是空图」）',
        /别再重试截图/.test(engineBuilt) && /visibleMatchesDesign/.test(engineBuilt),
        'dist/core/engine.js 里应有空图退路文案与视图状态字段',
    );
    const sceneBuilt = readFileSync(join(EXT_ROOT, 'dist', 'scene.js'), 'utf8');
    check(
        '场景侧截图回执带了视图状态（visibleSize / designResolution）',
        /visibleMatchesDesign/.test(sceneBuilt) && /getVisibleSize/.test(sceneBuilt),
        'dist/scene.js 里应有 readViewState',
    );

    // ---------------------------------------------------------------------
    console.log('\n[7] IPC 服务端（cocos-tools）四件套');
    // ---------------------------------------------------------------------
    state.sceneAvailable = true;
    const stateReply = await tools.COCOS_IPC_METHODS.editor_state({});
    check(
        'editor_state 报告沙箱可用',
        stateReply.text.includes('能力：代码沙箱可用'),
        stateReply.text.split('\n').slice(0, 6).join(' | '),
    );
    check('editor_state 选中态来自 scene 包', stateReply.data.selection && stateReply.data.selection.name === 'scene-2d', stateReply.data.selection);

    const execReply = await tools.COCOS_IPC_METHODS.execute_code({ code: 'return 1 + 2', context: 'editor' });
    check('execute_code 回执 ok + text', execReply.ok === true && /"result": 3/.test(execReply.text), execReply.text.slice(0, 120));

    const emptyCode = await tools.COCOS_IPC_METHODS.execute_code({ code: '   ' });
    check('空 code 被拒（不装死）', emptyCode.ok === false && Boolean(emptyCode.error), emptyCode);

    const helpersReply = await tools.COCOS_IPC_METHODS.describe_api({ context: 'editor', target: 'helpers' });
    check(
        'describe_api(helpers) 回沙箱问到的真清单（含 saveRecipe）',
        helpersReply.ok === true && JSON.stringify(helpersReply.data).includes('saveRecipe'),
        helpersReply.text.slice(0, 160),
    );

    const modulesReply = await tools.COCOS_IPC_METHODS.describe_api({ context: 'editor', target: 'module:path' });
    check('describe_api(module:path) 列出导出', modulesReply.ok === true && modulesReply.data.exportCount > 0, modulesReply.text.slice(0, 120));

    const sceneDescribe = await tools.COCOS_IPC_METHODS.describe_api({ context: 'scene', target: 'cc.Node' });
    check(
        'describe_api(scene) 转发给本扩展场景脚本（拿到反射结果）',
        sceneDescribe.ok === true && Boolean(sceneDescribe.data.className),
        sceneDescribe.text.slice(0, 200),
    );

    // ── node 定位（`paths.ts` 曾经 0 覆盖，而里面藏着一条**恒为死代码**的兜底）──────
    // 那个 bug：`join(NVM_SYMLINK ?? 'C:\\nvm4w', 'nodejs', 'node.exe')`，
    // 而 `NVM_SYMLINK` 本身就已经是 `C:\nvm4w\nodejs` → 拼出 `…\nodejs\nodejs\node.exe`，
    // 永远不存在。症状是「PATH 探测失败后仍然找不到 node」，而且**无从察觉**。
    const paths = require(join(EXT_ROOT, 'dist', 'paths.js'));
    const nodeCandidates = paths.knownNodePaths();
    check('knownNodePaths 给出了候选', Array.isArray(nodeCandidates) && nodeCandidates.length > 0, nodeCandidates.join(' | '));
    check(
        '候选里没有「拼两遍 nodejs」的死路径',
        nodeCandidates.every((p) => !/nodejs[\\/]+nodejs/i.test(p)),
        nodeCandidates.join(' | '),
    );
    const runtime = paths.resolveRuntime({ nodePath: '', dshBin: '' });
    check(
        'resolveRuntime 在本机找得到 node',
        typeof runtime.nodeExe === 'string' && runtime.nodeExe !== '' && existsSync(runtime.nodeExe),
        `${runtime.nodeExe}（来源：${runtime.nodeSource}）`,
    );

    // ---------------------------------------------------------------------
    console.log(`\n=== 结果：${checks - failures}/${checks} 通过 ===`);
    if (failures > 0) {
        console.log(`❌ ${failures} 条断言失败（假工程留在 ${FAKE_PROJECT} 里，可自己翻）\n`);
        process.exitCode = 1;
        return;
    }
    console.log(`✅ 全过（假工程留在 ${FAKE_PROJECT} 里，可自己翻）\n`);
}

main().catch((err) => {
    console.error('\n验证脚本自己崩了：', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
