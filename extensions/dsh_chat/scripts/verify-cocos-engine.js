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
            '/**',
            ' * 主循环时钟：帧计数与两个暂停位 —— 真机验收之后 `readSceneMode` 要读它们',
            ' * （「冻住没有」只有帧计数能作证：实测 pause 之后 1.5s +0、step 恰好 +1）。',
            ' * 测试里改 `clock.frames` 模拟「又跑了几帧」。',
            ' */',
            'const clock = { frames: 100, directorPaused: false, gamePaused: false };',
            '/** 场景：默认 null（既有断言依赖「没开场景」），Electron 那组测试用 `director.__scene = …` 装上 */',
            'const director = {',
            '    __scene: null,',
            '    getScene() { return director.__scene; },',
            '    getTotalFrames() { return clock.frames; },',
            '    isPaused() { return clock.directorPaused; },',
            '    pause() { clock.directorPaused = true; },',
            '    resume() { clock.directorPaused = false; },',
            '};',
            'function Node() {}',
            "Node.__props__ = ['name', 'position', 'active'];",
            'function Camera() {}',
            "Camera.__props__ = ['fov', 'near', 'far', 'orthoHeight'];",
            'function SpriteFrame() {}',
            'function UITransform() {}',
            'function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }',
            '/** `Rect` 是取景第二级（`_adjustToCenter(margin, rect)`）要构造的实参 —— 缺了它那条路会静默降级 */',
            'function Rect(x, y, width, height) { this.x = x || 0; this.y = y || 0; this.width = width || 0; this.height = height || 0; }',
            '/**',
            ' * `pick` 靠 `getComponent(cc.Sprite)` 这类调用认「这个节点画不画得出东西」，',
            ' * 所以要有一批**哨兵构造器**（假节点在 getComponent 里比对它们）。',
            ' * 它们不带任何行为 —— 被测的是「认不认得出」，不是「怎么渲染」。',
            ' */',
            'function Sprite() {}',
            'function Label() {}',
            'function RichText() {}',
            'function Graphics() {}',
            'function Mask() {}',
            'function UIOpacity() {}',
            '/** `isEditorNode` 优先走 `CCObject.Flags.HideInHierarchy`（取不到才回落到实测值 1024）*/',
            'const CCObject = { Flags: { HideInHierarchy: 1024 } };',
            '/** 场景视图画布：默认 0×0（`findViewCanvas` 会判成不可用），测试里换成真的尺寸 */',
            'const canvas = {',
            '    width: 0,',
            '    height: 0,',
            '    getContext: () => ({}),',
            '    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),',
            '};',
            'const game = {',
            '    canvas,',
            '    isPaused() { return clock.gamePaused; },',
            '    pause() { clock.gamePaused = true; },',
            '    resume() { clock.gamePaused = false; },',
            '};',
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
            '    game,',
            '    clock,',
            '    canvas,',
            '    js: { getClassName: (cls) => (cls && cls.name) || "FakeClass" },',
            '    Node,',
            '    Camera,',
            '    SpriteFrame,',
            '    UITransform,',
            '    Vec3,',
            '    Rect,',
            '    Sprite,',
            '    Label,',
            '    RichText,',
            '    Graphics,',
            '    Mask,',
            '    UIOpacity,',
            '    CCObject,',
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
    /**
     * 假的 `cce.PreviewPlay`（真机验收之后它是**运行态的唯一判据**：`_state`）。
     *
     * `_state` 走 `'stop' → 'play' → 'pause'`；`start/stop/pause/step` 按 `directBehavior` 行事：
     * - `'ok'`（默认）：真的改 `_state`（真机实测直调这四个都生效）；
     * - `'silent'`：**什么都不做**（照抄真机上的 `editor-preview-call-method`：回 ok 而一帧不动）；
     * - `'throw'`：抛错（照抄真机上那个 `setAttribute` 错）。
     */
    const fakePlay = {
        _state: 'stop',
        isPause() {
            return fakePlay._state === 'pause';
        },
        start() {
            fakePlay.calls.push(['start', []]);
            if (directBehavior === 'silent') return Promise.resolve();
            if (directBehavior === 'throw') return Promise.reject(new Error('模拟直调抛错'));
            fakePlay._state = 'play';
            clockRef.frames += 1;
            return Promise.resolve();
        },
        stop() {
            fakePlay.calls.push(['stop', []]);
            if (directBehavior === 'silent') return Promise.resolve();
            if (directBehavior === 'throw') return Promise.reject(new Error('模拟直调抛错'));
            fakePlay._state = 'stop';
            return Promise.resolve();
        },
        pause(isPause) {
            fakePlay.calls.push(['pause', [isPause]]);
            if (directBehavior === 'silent') return Promise.resolve();
            if (directBehavior === 'throw') return Promise.reject(new Error('模拟直调抛错'));
            if (isPause) {
                fakePlay._state = 'pause';
                clockRef.directorPaused = true;
                clockRef.gamePaused = true;
            } else {
                fakePlay._state = 'play';
                clockRef.directorPaused = false;
                clockRef.gamePaused = false;
            }
            return Promise.resolve();
        },
        step() {
            fakePlay.calls.push(['step', []]);
            if (directBehavior === 'silent') return Promise.resolve();
            if (directBehavior === 'throw') return Promise.reject(new Error('模拟直调抛错'));
            clockRef.frames += 1;
            return Promise.resolve();
        },
        /** 直调过哪些方法（断言"到底调了谁"） */
        calls: [],
    };

    let directBehavior = 'ok';
    /** 假 `cc` 里的那块时钟（`clock.frames` / 两个暂停位）—— 与假引擎同一份 */
    const clockRef = require(join(FAKE_PROJECT, 'node_modules', 'cc')).clock;

    const state = {
        sceneAvailable: options.sceneAvailable !== false,
        snapshots: 0,
        calls: [],
        /**
         * 运行预览（game view）那两条消息的桩：`editor-preview-set-play` /
         * `editor-preview-call-method`。默认**都成功**（回 true），
         * 每组测试可以按需改成「编辑器拒绝了这一下」（回 false）。
         */
        previewReject: false,
        /** `editor-preview-call-method` 收到的调用（`[method, ...args]`），断言"到底发了哪条" */
        previewCalls: [],
        /** `editor-preview-set-play` 收到的目标状态 */
        playCalls: [],
        /** `Message.send` 发出去的每一条（`{name, message, args}`）—— 新口径**不等回执**，靠它断言"发了什么" */
        sentMessages: [],
        /**
         * 那条消息到底有没有把状态带过去。
         *
         * `'works'` = 照抄"正常编辑器"（改 `fakePlay._state`）；
         * `'silent'` = **照抄真机**：消息回 ok 而状态一动不动（真机上 `step`/`resume` 就是这样）；
         * `'throw'` = 消息抛错（真机上 `pause` 就是这样）。
         */
        messageRoute: 'works',
        /** 直调 `cce.PreviewPlay` 的行为（`'ok'` / `'silent'` / `'throw'`） */
        set directBehavior(value) {
            directBehavior = value;
        },
        get directBehavior() {
            return directBehavior;
        },
        /** 假的 `cce.PreviewPlay`（测试可以直接改 `state.previewPlay._state`） */
        previewPlay: fakePlay,
        /** `query-scene-mode` 回什么（默认这条消息在真编辑器里"只有声明、没有调用方"，这里模拟回得出 general） */
        sceneMode: 'general',
        /** 让 `query-scene-mode` 抛错（验「消息不通 ≠ 不在运行态」） */
        sceneModeError: false,
    };

    /**
     * 消息对状态的影响（**这一处是"编辑器到底做没做"的唯一入口**）。
     *
     * 两条路都走它：`request`（老口径）与 `send`（新口径）—— 因为真机上
     * **副作用与回执是两件事**（`set-play(true)` 不回执但预览起来了）。
     */
    const applyPreviewMessage = (message, first, rest) => {
        if (state.messageRoute === 'throw') throw new Error("Cannot read properties of undefined (reading 'setAttribute')");
        if (state.messageRoute === 'silent') return;
        if (message === 'editor-preview-set-play') {
            fakePlay._state = first === true ? 'play' : 'stop';
            return;
        }
        if (message === 'editor-preview-call-method') {
            const args = Array.isArray(rest) ? rest : [];
            if (first === 'pause') fakePlay._state = args[0] === true ? 'pause' : 'play';
        }
    };

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
            /**
             * ⚠ 末尾收成 `...rest` 而不是固定三个参数：`editor-preview-call-method` 是
             * `request('scene', 消息, 方法名, ...参数)` 这种**多参**形状，写死三参就会把
             * 方法名之后的参数静默丢掉 —— 那正是"断言看着绿、其实没验到"的经典来源。
             */
            async request(name, message, payload, ...rest) {
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
                /**
                 * 运行预览那三条消息（真编辑器里由 scene 包处理，见 `source/preview.ts` 的出处表）：
                 * 桩的行为照抄编辑器工具栏的用法 —— `set-play` 回目标状态、`call-method` 回"做到没有"。
                 */
                if (name === 'scene' && message === 'query-scene-mode') {
                    if (state.sceneModeError) throw new Error('Message does not exist: query-scene-mode');
                    return state.sceneMode;
                }
                if (name === 'scene' && message === 'editor-preview-set-play') {
                    state.playCalls.push(payload);
                    applyPreviewMessage(message, payload, rest);
                    return state.previewReject ? !payload : payload;
                }
                if (name === 'scene' && message === 'editor-preview-call-method') {
                    /** 形状照抄真用法：第一个参是**方法名**，后面是给那个方法的参数（`pause` 收一个布尔） */
                    state.previewCalls.push({ method: payload, args: rest });
                    applyPreviewMessage(message, payload, rest);
                    return state.previewReject ? false : true;
                }
                throw new Error(`未桩的编辑器消息：${name} / ${message}`);
            },
            /**
             * 新口径走的是 `send`（**不等回执**）：真机实测 `set-play(true)` 120s 不回执，
             * 而它的副作用其实发生了 —— 所以这里也照抄"副作用照做、回执没有"。
             */
            send(name, message, ...args) {
                state.calls.push(`send:${name}/${message}`);
                state.sentMessages.push({ name, message, args });
                if (name !== 'scene') return;
                if (message === 'editor-preview-set-play') {
                    state.playCalls.push(args[0]);
                    applyPreviewMessage(message, args[0]);
                    return;
                }
                if (message === 'editor-preview-call-method') {
                    state.previewCalls.push({ method: args[0], args: args.slice(1) });
                    applyPreviewMessage(message, args[0], args.slice(1));
                }
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

// ---------------------------------------------------------------------------
// 假 Electron —— `capture_view` 的**正路**全靠它才能在普通 Node 里被真跑
// ---------------------------------------------------------------------------
//
// `capture.ts` 只在编辑器主进程里 require 得到 `electron`，普通 Node 是 MODULE_NOT_FOUND。
// 所以这里用 `Module._load` 把它拦下来 —— `require.cache` 塞不进一个**根本不存在**的模块。
//
// ⚠ 必须**从一开头就装好**：`capture.ts` 缓存 require 的结果，
// 等跑到那一组测试再装就晚了（缓存里已经是「没有 electron」）。

/**
 * 一张假图。
 *
 * `toPNG()` 的内容里带尺寸（`PNG 100x50`），于是「**落盘的图到底是多大**」
 * 可以直接从文件里读出来 —— 裁切/缩放的算术错了立刻看得见，不用去猜。
 */
function makeFakeImage(width, height, blank) {
    const calls = [];
    const image = {
        __width: width,
        __height: height,
        __blank: Boolean(blank),
        /** 每次 crop/resize 都记一笔：断言"到底按哪个矩形裁的" */
        __calls: calls,
        getSize: () => ({ width: image.__width, height: image.__height }),
        getScaleFactor: () => 2,
        isEmpty: () => false,
        /** 空图 = 全 0 字节（透明），与 `blankRatioOf` 的判据一致 */
        toBitmap() {
            const buffer = Buffer.alloc(image.__width * image.__height * 4);
            if (!image.__blank) {
                for (let i = 0; i < buffer.length; i += 4) {
                    buffer[i] = 200;
                    buffer[i + 1] = 100;
                    buffer[i + 2] = 50;
                    buffer[i + 3] = 255;
                }
            }
            return buffer;
        },
        toPNG: () => Buffer.from(`PNG ${image.__width}x${image.__height}`),
        toJPEG: (quality) => Buffer.from(`JPG ${image.__width}x${image.__height} q${quality}`),
        crop(rect) {
            calls.push({ kind: 'crop', rect });
            return makeFakeImage(rect.width, rect.height, image.__blank);
        },
        resize(options) {
            calls.push({ kind: 'resize', options });
            return makeFakeImage(options.width, options.height, image.__blank);
        },
    };
    return image;
}

/** 假 webContents = 场景视图那一页；行为可切换（首张空图 / 一直空 / 图比页面大…）。 */
function makeFakeView(url) {
    return {
        id: 42,
        invalidateCalls: 0,
        captureCalls: 0,
        /** **每一次** `sendInputEvent` 的入参原样记下来（「到底发了什么」的唯一证据） */
        inputEvents: [],
        /** 目标页有没有键盘焦点（`cocos_send_keys` 只如实报，不抢） */
        focused: true,
        /** **下一次**抓图返回空图 —— 用来验「invalidate 逼重绘」 */
        blankNext: false,
        /** 一直空 —— 用来验退路文案 */
        alwaysBlank: false,
        /** capturePage 出的图尺寸：默认 = 页面 CSS 尺寸（DIP）；调大用来验「图与页面不等比时自纠正」 */
        imageSize: { width: 600, height: 400 },
        lastImage: null,
        getType: () => 'webview',
        getURL: () => url,
        getTitle: () => 'Scene',
        isDestroyed: () => false,
        getZoomFactor: () => 1,
        invalidate() {
            this.invalidateCalls += 1;
        },
        sendInputEvent(event) {
            this.inputEvents.push(JSON.parse(JSON.stringify(event)));
        },
        isFocused() {
            return this.focused;
        },
        getOwnerBrowserWindow: () => ({
            id: 1,
            getTitle: () => 'Cocos Creator',
            isVisible: () => true,
            isMinimized: () => false,
            /** 窗口焦点：`sendInputEvent` 能不能生效的前提（假的那份默认有焦点） */
            isFocused: () => fakeElectron.windowFocused,
            focus() {
                fakeElectron.focusCalls += 1;
                fakeElectron.windowFocused = true;
            },
        }),
        async capturePage() {
            this.captureCalls += 1;
            const blank = this.alwaysBlank || this.blankNext;
            this.blankNext = false;
            this.lastImage = makeFakeImage(this.imageSize.width, this.imageSize.height, blank);
            return this.lastImage;
        },
    };
}

/**
 * 装一套「2D 场景视图」的现场：真场景树（`Canvas` → `card`）+ **真正交模型**的编辑器相机。
 *
 * ## 相机为什么要建模，不能恒等映射
 *
 * 取景的第三级（手工摆相机）算的是「像素/世界单位」与「把内容中心挪到视口中心」——
 * 在恒等映射下这些算式**怎么错都看不出来**（除一下 1 还是它自己）。所以这里按引擎的口径建模
 * （`resources/.../cocos/render-scene/scene/camera.ts` 的 `Mat4.ortho(-x, x, -y, y)`，其中
 * `y = orthoHeight` → **orthoHeight 是可见世界高度的半高**）：
 *
 * ```
 * screen.x = W/2 + (world.x − cam.x) · k        k = H / (2 · orthoHeight)
 * screen.y = H/2 + (world.y − cam.y) · k        （左下原点、y 向上，与 worldToScreen 一致）
 * ```
 *
 * 数字全部好手算：`W×H = 1200×800`（相机像素，dpr = 2 → 页面 600×400 CSS），
 * `orthoHeight = 400` → `k = 1` → **屏幕像素 = 世界单位**，可见世界 `x ∈ [-300,300]`、`y ∈ [-200,200]`。
 * `Canvas` 正好 600×400（铺满画布），`card` 200×100 在 (100,50)（居中偏右上）。
 *
 * ## 控制手柄（测试要能"让某一级取景失灵"）
 *
 * - `flags.focusCovers = false`：假装编辑器 `focus()` 框不全 → 逼出第二级；
 * - `flags.adjustCovers = false`：再假装控制器也框不全 → 逼出第三级（手工）；
 * - `flags.infoRestores = false`：假装 `focus(null, savedInfo)` 还原不了 → 逼出「直接写回相机字段」；
 * - `flags.failWrites = true`：让写相机直接抛 → 验 `restored:false` 的如实回执。
 *
 * @param {any} cc - 假 cc 模块。
 * @param {{ cardUuid?: string, canvasUuid?: string }} [options]
 */
function installFakeSceneView(cc, options = {}) {
    const cardUuid = options.cardUuid || 'card-uuid';
    const canvasUuid = options.canvasUuid || 'canvas-uuid';

    const state = {
        /** 相机像素（= 画布 device 像素） */
        W: 1200,
        H: 800,
        pos: { x: 0, y: 0, z: -1000 },
        orthoHeight: 400,
        is2D: true,
    };
    /** 每一笔取景/还原都记下来 —— 「到底调没调相机」靠它断 */
    const calls = [];
    const flags = { focusCovers: true, adjustCovers: true, infoRestores: true, failWrites: false };

    const k = () => state.H / (2 * state.orthoHeight);

    // ---- 场景树：scene → Canvas(600×400) → card(200×100 @ (100,50)) ----
    const canvasTransform = { width: 600, height: 400, anchorX: 0.5, anchorY: 0.5 };
    const cardTransform = { width: 200, height: 100, anchorX: 0.5, anchorY: 0.5 };
    const fakeScene = {
        name: 'Main',
        uuid: 'scene-uuid',
        parent: null,
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1, z: 1 },
        children: [],
        getComponent: () => null,
    };
    const canvasNode = {
        name: 'Canvas',
        uuid: canvasUuid,
        parent: fakeScene,
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1, z: 1 },
        children: [],
        worldPosition: { x: 0, y: 0, z: 0 },
        worldScale: { x: 1, y: 1, z: 1 },
        getComponent: (cls) => (cls === cc.UITransform ? canvasTransform : null),
    };
    const card = {
        name: 'Card',
        uuid: cardUuid,
        parent: canvasNode,
        // position 与 worldPosition **保持一致**（世界矩形与投影都靠这两个，口径不能各说各话）
        position: { x: 100, y: 50 },
        scale: { x: 1, y: 1, z: 1 },
        children: [],
        worldPosition: { x: 100, y: 50, z: 0 },
        worldScale: { x: 1, y: 1, z: 1 },
        getComponent: (cls) => (cls === cc.UITransform ? cardTransform : null),
    };
    canvasNode.children = [card];
    fakeScene.children = [canvasNode];

    const findByUuid = (uuid) => {
        const stack = [fakeScene];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.uuid === uuid) return node;
            for (const child of node.children || []) stack.push(child);
        }
        return null;
    };
    fakeScene.getChildByUuid = findByUuid;

    /** 节点的世界矩形（`worldRect` 的口径：position + anchor + contentSize 自洽累加，不旋转） */
    const worldRectOf = (node) => {
        const ut = node.getComponent(cc.UITransform);
        if (!ut || !(ut.width > 0) || !(ut.height > 0)) return null;
        let sx = 1;
        let sy = 1;
        let anchorX = 0;
        let anchorY = 0;
        const chain = [];
        for (let cursor = node; cursor; cursor = cursor.parent) chain.push(cursor);
        for (let i = chain.length - 2; i >= 0; i -= 1) {
            const parent = chain[i + 1];
            const ps = parent.scale || { x: 1, y: 1 };
            sx *= typeof ps.x === 'number' ? ps.x : 1;
            sy *= typeof ps.y === 'number' ? ps.y : 1;
            const pos = chain[i].position || { x: 0, y: 0 };
            anchorX += sx * pos.x;
            anchorY += sy * pos.y;
        }
        const cx = anchorX + sx * (0.5 - ut.anchorX) * ut.width;
        const cy = anchorY + sy * (0.5 - ut.anchorY) * ut.height;
        const width = sx * ut.width;
        const height = sy * ut.height;
        return { cx, cy, width, height, left: cx - width / 2, right: cx + width / 2, bottom: cy - height / 2, top: cy + height / 2 };
    };

    /** 把相机摆到「框住这块世界矩形」（编辑器 focus / 控制器适配的两级都走它） */
    const fitTo = (box) => {
        const margin = 0.08; // 与 scene.ts 的 FIT_MARGIN 同量级即可（这里只要求"能框全"）
        const wantK = Math.min((state.W * (1 - margin * 2)) / box.width, (state.H * (1 - margin * 2)) / box.height);
        state.orthoHeight = state.H / (2 * wantK);
        state.pos = { x: box.cx, y: box.cy, z: state.pos.z };
    };
    const boxOfUuids = (uuids) => {
        let left = Infinity;
        let right = -Infinity;
        let bottom = Infinity;
        let top = -Infinity;
        for (const uuid of uuids || []) {
            const node = findByUuid(uuid);
            const rect = node ? worldRectOf(node) : null;
            if (!rect) continue;
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
            bottom = Math.min(bottom, rect.bottom);
            top = Math.max(top, rect.top);
        }
        if (left === Infinity) return null;
        return { cx: (left + right) / 2, cy: (bottom + top) / 2, width: right - left, height: top - bottom, left, right, bottom, top };
    };

    const cam = {
        camera: { width: state.W, height: state.H },
        screenScale: 1,
        node: {
            get worldPosition() {
                return state.pos;
            },
            set worldPosition(value) {
                state.pos = value;
            },
            setWorldPosition(x, y, z) {
                if (flags.failWrites) throw new Error('（假相机）写位置失败');
                state.pos = { x, y, z };
            },
        },
        get orthoHeight() {
            return state.orthoHeight;
        },
        set orthoHeight(value) {
            if (flags.failWrites) throw new Error('（假相机）写 orthoHeight 失败');
            state.orthoHeight = value;
        },
        worldToScreen(point) {
            const scale = k();
            return {
                x: state.W / 2 + (point.x - state.pos.x) * scale,
                y: state.H / 2 + (point.y - state.pos.y) * scale,
                z: 0,
            };
        },
        /** `pick` 会顺带把屏幕点反投影成世界坐标（回执里带 `world`）—— 夹具得有这条逆映射 */
        screenToWorld(point) {
            const scale = k();
            return {
                x: (point.x - state.W / 2) / scale + state.pos.x,
                y: (point.y - state.H / 2) / scale + state.pos.y,
                z: 0,
            };
        },
    };

    /** 视角快照（假版的 `EditorCameraInfo`：够还原就行） */
    const snapshot = () => ({ position: { ...state.pos }, orthoHeight: state.orthoHeight });

    const manager = {
        get is2D() {
            return state.is2D;
        },
        camera: cam,
        getCurCameraInfo() {
            return { __state: snapshot(), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 1, viewCenter: { ...state.pos } };
        },
        focus(uuids, info, immediate) {
            calls.push({ kind: 'focus', uuids: uuids ? uuids.slice() : null, hasInfo: Boolean(info), immediate });
            if (info) {
                /** 还原通道：把记下来的那份视角写回去（`infoRestores=false` 时假装它不灵） */
                if (flags.infoRestores && info.__state) {
                    state.pos = { ...info.__state.position };
                    state.orthoHeight = info.__state.orthoHeight;
                }
                return;
            }
            if (!uuids || uuids.length === 0) return;
            if (!flags.focusCovers) return;
            const box = boxOfUuids(uuids);
            if (box) fitTo(box);
        },
        controller2D: {
            _adjustToCenter(marginPercentage, contentBounds, immediate) {
                calls.push({
                    kind: 'adjust',
                    marginPercentage,
                    rect: contentBounds ? { ...contentBounds } : null,
                    immediate,
                });
                if (!flags.adjustCovers || !contentBounds) return;
                fitTo({
                    cx: contentBounds.x + contentBounds.width / 2,
                    cy: contentBounds.y + contentBounds.height / 2,
                    width: contentBounds.width,
                    height: contentBounds.height,
                });
            },
        },
    };

    return {
        state,
        flags,
        calls,
        manager,
        cam,
        scene: fakeScene,
        canvasNode,
        card,
        findAllCalls: (kind) => calls.filter((call) => call.kind === kind),
        moveCamera: (x, y) => {
            state.pos = { x, y, z: state.pos.z };
        },
        /**
         * 把 card 挪到某个世界位置。
         *
         * ⚠ 必须**同时**改 `position` 与 `worldPosition`：现实里节点的世界坐标就是从局部坐标
         * 推出来的，两个口径一定自洽；测试里只改一个的话，
         * `worldRect()`（走 `position` 链）与 `projectNodeRect()`（走 `worldPosition`）
         * 会算出**两个不同的矩形** —— 那种"假得不像"的现场会让取景测试得出错误结论（踩过）。
         */
        placeCard: (x, y) => {
            card.position = { x, y };
            card.worldPosition = { x, y, z: 0 };
        },
        setContentSize: (width, height) => {
            canvasTransform.width = width;
            canvasTransform.height = height;
        },
        reset: () => {
            state.pos = { x: 0, y: 0, z: -1000 };
            state.orthoHeight = 400;
            canvasTransform.width = 600;
            canvasTransform.height = 400;
            calls.length = 0;
            flags.focusCovers = true;
            flags.adjustCovers = true;
            flags.infoRestores = true;
            flags.failWrites = false;
        },
    };
}

/**
 * 假 electron 模块：`getAllWebContents()` 返回什么由每组测试自己摆。
 *
 * `nativeImage` 是给 `probe()`（editor 上下文）用的：真实现是 Electron 拿 Chromium 的解码器
 * 把任意图片变成 BGRA 原始像素。假的那份**不真解码**，而是按一张固定表回像素 ——
 * 被测的是「BGRA 索引对不对、四角/中心/统计算得对不对」，不是「Electron 会不会解码」。
 * （真解码那一步没法在纯 Node 里覆盖，这一点在断言描述里如实写着。）
 */
const fakeElectron = {
    views: [],
    /** 装那一页的窗口有没有焦点（`sendInputEvent` 的前提）—— 每组测试自己摆 */
    windowFocused: true,
    /** `focus()` 被调了几次（提前台这件事必须能被断言到） */
    focusCalls: 0,
    webContents: {
        getAllWebContents: () => fakeElectron.views,
        fromId: (id) => fakeElectron.views.find((view) => view.id === id),
    },
    /** 4×4，四角全透明、其余纯白 —— 一张典型的「可染色图标」 */
    nativeImage: {
        sheet: null,
        /** 名字命中它的当成「解不开的图」（真实现里格式不对就是这个表现） */
        undecodable: /round_2/,
        createFromPath(file) {
            const sheet = fakeElectron.nativeImage.sheet;
            const empty = { getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) };
            if (!sheet || fakeElectron.nativeImage.undecodable.test(String(file))) return empty;
            const w = sheet.width;
            const h = sheet.height;
            const bitmap = Buffer.alloc(w * h * 4);
            for (let y = 0; y < h; y += 1) {
                for (let x = 0; x < w; x += 1) {
                    const isCorner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
                    const o = (y * w + x) * 4;
                    // BGRA
                    bitmap[o] = isCorner ? 0 : sheet.b;
                    bitmap[o + 1] = isCorner ? 0 : sheet.g;
                    bitmap[o + 2] = isCorner ? 0 : sheet.r;
                    bitmap[o + 3] = isCorner ? 0 : 255;
                }
            }
            return { getSize: () => ({ width: w, height: h }), toBitmap: () => bitmap };
        },
    },
};

async function main() {
    console.log(`\n=== 假工程：${FAKE_PROJECT} ===`);
    rmSync(FAKE_PROJECT, { recursive: true, force: true });
    mkdirSync(FAKE_PROJECT, { recursive: true });
    makeFakeCc();

    /**
     * 假 `cc` 模块 —— **在 [2c] 那节之前就要拿到**（那节要拿它搭 `pick` 的夹具）。
     * 后面 [6b] 那节也用它（原来是就地 require 的，见那里的注释）。
     */
    const cc = require(join(FAKE_PROJECT, 'node_modules', 'cc'));
    /** 假引擎的主循环时钟：`frames` 与两个暂停位（`readSceneMode` 读它、「冻住没有」靠它说话） */
    const clock = cc.clock;

    /** 让 `require('electron')` 拿到假的那一份（真编辑器主进程里才是真的）。 */
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, ...rest) {
        if (request === 'electron') return fakeElectron;
        return originalLoad.call(this, request, ...rest);
    };

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
        '五个场景方法都注册了（ping / runCode / describeApi / viewMetrics / fitView）',
        ['ping', 'runCode', 'describeApi', 'viewMetrics', 'fitView'].every((m) => sceneMethods.includes(m)) &&
            /**
             * ⚠ 反向也要钉住：`runtimeControl`（运行预览开关）**已于 2026-10-08 撤掉** ——
             * 它若被谁悄悄加回来，这里当场红（理由见 `cocos_runtime` 的工具说明与 `docs/冻结诊断.md`）。
             */
            !sceneMethods.includes('runtimeControl'),
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
    console.log('\n[2c] 四个「把一轮试错压成一次调用」的助手：pick / labelFit / snapshotTree+diffTree');
    // ---------------------------------------------------------------------
    /**
     * 这一节的断言全部对应**实测走过的弯路**（每条 check 的描述里写着是哪一条）。
     * 夹具刻意做得像那个真实场景：一个 Canvas 装着一张卡，
     * 旁边挂一棵编辑器装饰（`hideFlags = HideInHierarchy`）盖住卡的**外面**。
     */
    const pickView = installFakeSceneView(cc);
    const snapPath = join(FAKE_PROJECT, 'snapshot-report.json');
    const diffPath = join(FAKE_PROJECT, 'diff-report.json');
    global.window = {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 1,
        location: { href: 'file:///fake/2d-webview.html' },
    };
    globalThis.cce = { Camera: { camera: pickView.cam, is2D: true } };

    /**
     * 搭夹具的代码 —— 在场景沙箱里跑，所以能直接用 `cc`。
     * ⚠ 局部名一律带 `fx` 前缀：场景沙箱里已经有 `scene` / `cc` / `director` 这些全局量，
     * 直接叫 `scene` 会 `Identifier 'scene' has already been declared`（踩过）。
     *
     * 树（世界坐标；夹具里 `k = 1`、屏幕 1200×800、dpr = 1，
     * 于是**世界坐标 = 设备像素、y 向上**，而页面 CSS 坐标 **y 向下**）：
     *
     * ```
     * Canvas(600×400 @ 0,0)              → 页面 CSS x∈[300,900] y∈[200,600]
     * ├─ Card(200×100 @ 100,50)          → 页面 CSS x∈[600,800] y∈[300,400]
     * │  ├─ bg  (200×100 @ 0,0)  Sprite 白   ← 卡片底
     * │  └─ label(160×40 @ 0,0)  Label  '你好'  ← 压在 bg 上面
     * └─ gone(200×100 @ -200,-150) Sprite 但 active=false  → 页面 CSS x∈[300,500] y∈[500,600]
     * Editor Scene Foreground(1200×800 @ 0,0)  ← 铺满整页（只在内容没有的地方冒出来）
     * ```
     */
    const PICK_FIXTURE = [
        'const fxUt = (w, h) => ({ width: w, height: h, anchorX: 0.5, anchorY: 0.5 });',
        'const fxFrame = { uuid: "frame-uuid", name: "rect_rd_20" };',
        'const fxMk = (name, size, position, comps, extra) => Object.assign({',
        '    name, uuid: name + "-uuid", position,',
        '    scale: { x: 1, y: 1, z: 1 },',
        '    worldScale: { x: 1, y: 1, z: 1 },',
        '    worldPosition: { x: position.x, y: position.y, z: 0 },',
        '    active: true, activeInHierarchy: true, hideFlags: 0,',
        '    parent: null, children: [],',
        // `components` 是快照的取数口径（真引擎里 Node 有这个 getter）
        '    components: comps ? comps.slice() : [],',
        '    getComponent: (cls) => (cls === cc.UITransform ? fxUt(size.width, size.height) : (comps || []).find((c) => c instanceof cls) || null),',
        '    getChildByName: () => null,',
        '    getSiblingIndex: () => 0,',
        '}, extra || {});',
        /**
         * 组件必须是哨兵构造器的**真实例**（`new cc.Sprite()`）：`snapshotNodeProps` 是按
         * `comp.constructor.name` 查白名单的，普通对象字面量的名字是 `Object`，
         * 会被当成"没有需要记的字段"**静默跳过** —— 第一版夹具就栽在这（改了 fontSize 但 diff 里没有）。
         */
        'const fxSprite = () => Object.assign(new cc.Sprite(), { spriteFrame: fxFrame, color: { r: 255, g: 255, b: 255, a: 255 } });',
        'const fxLabel = (text) => Object.assign(new cc.Label(), { string: text, fontSize: 16, lineHeight: 0, overflow: 1, enableWrapText: true, color: { r: 0, g: 0, b: 0, a: 255 }, fontFamily: "Arial" });',
        'const fxRoot = fxMk("Main", { width: 0, height: 0 }, { x: 0, y: 0 }, null);',
        'const fxCanvas = fxMk("Canvas", { width: 600, height: 400 }, { x: 0, y: 0 }, null);',
        'const fxCard = fxMk("Card", { width: 200, height: 100 }, { x: 100, y: 50 }, null);',
        'const fxBg = fxMk("bg", { width: 200, height: 100 }, { x: 0, y: 0 }, [fxSprite()]);',
        'const fxLab = fxMk("label", { width: 160, height: 40 }, { x: 0, y: 0 }, [fxLabel("你好")]);',
        'const fxGone = fxMk("gone", { width: 200, height: 100 }, { x: -200, y: -150 }, [fxSprite()], { active: false, activeInHierarchy: false });',
        'const fxEditor = fxMk("Editor Scene Foreground", { width: 1200, height: 800 }, { x: 0, y: 0 }, null, { hideFlags: 1024 });',
        'const fxWire = (parent, child) => {',
        '    child.parent = parent;',
        '    parent.children.push(child);',
        '    parent.getChildByName = (target) => parent.children.find((c) => c.name === target) || null;',
        '    return child;',
        '};',
        'fxWire(fxRoot, fxCanvas); fxWire(fxRoot, fxEditor);',
        'fxWire(fxCanvas, fxCard); fxWire(fxCanvas, fxGone);',
        'fxWire(fxCard, fxBg); fxWire(fxCard, fxLab);',
        // worldPosition 要和 position 链自洽（夹具注释里那条实测教训）
        'const fxFixWorld = (n) => { for (const c of n.children) { c.worldPosition = { x: n.worldPosition.x + c.position.x, y: n.worldPosition.y + c.position.y, z: 0 }; fxFixWorld(c); } };',
        'fxFixWorld(fxRoot);',
        'cc.director.__scene = fxRoot;',
        'return { ok: true, children: fxRoot.children.length };',
    ].join('\n');

    const fixture = await scene.methods.runCode({ code: PICK_FIXTURE, timeoutMs: 5000 });
    check('pick 夹具搭好了（Canvas→Card→bg/label + 一个 inactive 节点 + 一棵编辑器装饰）', fixture.ok === true, fixture);

    const pickCenter = await scene.methods.runCode({
        code: 'return pick(700, 350);',
        timeoutMs: 5000,
    });
    {
        const r = (pickCenter && pickCenter.result) || {};
        check(
            'pick：页面 CSS 坐标命中节点，且**最上面**的那个排第一（label 压在 bg 上）',
            pickCenter.ok === true && r.verdict === 'content' && r.hit && r.hit.name === 'label' && r.hits.length === 2,
            { verdict: r.verdict, hits: (r.hits || []).map((h) => h.name), hit: r.hit && r.hit.name },
        );
        check(
            'pick：矩形换算与截图同一套口径（Card 应落在页面 CSS x∈[600,800] y∈[300,400]）',
            r.hits && r.hits[1] && Math.round(r.hits[1].rect.x) === 600 && Math.round(r.hits[1].rect.y) === 300,
            r.hits && r.hits[1] && r.hits[1].rect,
        );
        check(
            'pick：顺带把世界坐标算出来（省得调用方自己反投影）',
            r.world && Math.round(r.world.x) === 100 && Math.round(r.world.y) === 50,
            r.world,
        );
        check(
            'pick：纯容器（Canvas/Card 没有渲染组件）**不进 invisible** —— 它本来就不该画东西',
            Array.isArray(r.invisible) && r.invisible.every((row) => row.name !== 'Canvas' && row.name !== 'Card'),
            r.invisible,
        );
    }

    const pickUv = await scene.methods.runCode({
        code: 'const a = pick(700, 350); const b = pick(700 / 1200, 350 / 800, { space: "uv" }); return { same: a.hit && b.hit && a.hit.uuid === b.hit.uuid, verdict: b.verdict };',
        timeoutMs: 5000,
    });
    check(
        'pick(space:"uv") 与 view 命中同一个节点 —— 截图被 maxWidth 缩过时不用自己反算',
        pickUv.ok === true && pickUv.result.same === true,
        pickUv.result,
    );

    /**
     * **这一条是本节的中心**：截图里有个东西，节点树里却没有。
     *
     * 实测原样重演过一遍：花了 16 轮枚举/直方图/反算坐标，最后才承认那玩意儿是
     * 编辑器移动 gizmo 的 XY 手柄。这里的判据要能**一次说清**，
     * 而不是回一个让人不敢信的空列表。
     *
     * `(150, 100)` 落在 Canvas 之外（Canvas 占页面 CSS x∈[300,900] y∈[200,600]）、
     * 但落在 `Editor Scene Foreground`（铺满整页）之内。
     */
    const pickOverlay = await scene.methods.runCode({
        code: 'return pick(150, 100);',
        timeoutMs: 5000,
    });
    {
        const r = (pickOverlay && pickOverlay.result) || {};
        check(
            'pick：内容没有、编辑器装饰有 → verdict = "editor-overlay"（紫方块那 16 轮的答案）',
            pickOverlay.ok === true && r.verdict === 'editor-overlay' && r.hits.length === 0 && r.editorHits.length === 1,
            { verdict: r.verdict, hits: r.hits && r.hits.length, editorHits: r.editorHits && r.editorHits.length },
        );
        check(
            'pick：并明说「它不在场景数据里，别去节点树/预制件里找」',
            typeof r.note === 'string' && /不在场景数据里/.test(r.note),
            r.note,
        );
    }

    /**
     * `(400, 550)` → 世界 (-200, -150)，正好在 `gone`（200×100 @ (-200,-150)）里：
     * 它**盖住了这一点却是 inactive 的**。「这里怎么什么都没画出来」的答案就是它。
     */
    const pickInvisible = await scene.methods.runCode({
        code: 'return pick(400, 550);',
        timeoutMs: 5000,
    });
    check(
        'pick：盖住了这一点但 active=false 的节点进 invisible 并**带上原因**（"这里怎么什么都没画"）',
        pickInvisible.ok === true &&
            pickInvisible.result.invisible.some((row) => row.name === 'gone' && /active/.test(String(row.reason))),
        pickInvisible.result && pickInvisible.result.invisible,
    );

    const pickNoCamera = await scene.methods.runCode({
        code: 'const saved = globalThis.cce; delete globalThis.cce; let out; try { pick(700, 350); out = { threw: false }; } catch (e) { out = { threw: true, message: e.message }; } globalThis.cce = saved; return out;',
        timeoutMs: 5000,
    });
    check(
        'pick：拿不到编辑器相机时**抛错**（明说"不是这个点上没有节点"），不给静默空结果',
        pickNoCamera.ok === true &&
            pickNoCamera.result.threw === true &&
            /相机/.test(pickNoCamera.result.message) &&
            /不是"这个点上没有节点"/.test(pickNoCamera.result.message),
        pickNoCamera.result,
    );

    const pickBadSpace = await scene.methods.runCode({
        code: 'try { pick(0, 0, { space: "pixel" }); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }',
        timeoutMs: 5000,
    });
    check(
        'pick：space 写错会抛出可照做的错误',
        pickBadSpace.ok === true && pickBadSpace.result.threw === true && /'view'/.test(pickBadSpace.result.message),
        pickBadSpace.result,
    );

    // ---- labelFit：把实测的两处真 bug 钉成回归 ----------------------------------
    /**
     * **历史 bug #1**（成就卡描述被裁）：`detail` 220×44、fs16、`CLAMP` + 换行，
     * 编辑器默认 `lineHeight = 1.3 × 16 = 20.8`。最长的一条描述折成 2 行 →
     * 第 2 行（进度 `20/20`）**整行被裁掉，界面上一个字都看不见**。
     * 修法是框加高到 72、行进给改成 1.5 × 16 = 24。
     *
     * 这一条同时也是「行进给公式」的判据：`最多行数 = floor(框高/行进给 − 0.26)`
     * → `floor(44/20.8 − 0.26) = 1`，与实测「第 2 行整行消失」完全一致。
     */
    const fitBug = await scene.methods.runCode({
        code: [
            "const spec = { text: '在击杀商店购买过不同种类的Buff（共20种）。', fontSize: 16, width: 220, height: 44, lineHeight: 20.8, overflow: 'CLAMP', wrap: true };",
            'const before = labelFit(spec);', // 修之前
            'const after = labelFit(spec, { width: 210, height: 72, lineHeight: 24 });', // 修之后
            'return { before, after };',
        ].join('\n'),
        timeoutMs: 5000,
    });
    {
        const before = (fitBug.result && fitBug.result.before) || {};
        const after = (fitBug.result && fitBug.result.after) || {};
        check(
            'labelFit：复现历史 bug —— 220×44 / 行进给 20.8 时 2 行只放得下 1 行',
            fitBug.ok === true && before.lineCount === 2 && before.maxLinesFit === 1 && before.fitsHeight === false,
            { lineCount: before.lineCount, maxLinesFit: before.maxLinesFit, fits: before.fits },
        );
        check(
            'labelFit：把**看不见的那一行**原样交出来（不是只说"会裁"）—— 被裁的正是进度那半句',
            typeof before.clippedText === 'string' &&
                before.clippedText.length > 0 &&
                before.clippedText.indexOf('20种') >= 0 &&
                before.visibleLines === 1,
            { clippedText: before.clippedText, visibleLines: before.visibleLines },
        );
        check(
            'labelFit：修法一算就成立 —— 210×72 / 行进给 24 → 2 行放得下',
            after.lineCount === 2 && after.maxLinesFit === 2 && after.fits === true && after.clippedText === '',
            { lineCount: after.lineCount, maxLinesFit: after.maxLinesFit, fits: after.fits },
        );
        check(
            'labelFit：回执里带上 `formula`（公式是从实测反推的，别当黑箱）',
            typeof before.formula === 'string' && before.formula.indexOf('1.26') >= 0,
            before.formula,
        );
        check(
            'labelFit：没有 DOM 时明说宽度是**估**的（method=estimate）',
            before.method === 'estimate' && before.confidence === 'low',
            { method: before.method, confidence: before.confidence },
        );
    }

    /**
     * 含空格的拉丁串：引擎按**词**折行，这里按**字符**折 —— 两者行数会不一样，
     * 所以必须**主动提醒**，而不是给一个看起来很确定的 `fits`。
     */
    const fitSpace = await scene.methods.runCode({
        code: 'return labelFit({ text: "Buff duration up 20 percent now", fontSize: 14, width: 60, height: 200, lineHeight: 18, wrap: true });',
        timeoutMs: 5000,
    });
    check(
        'labelFit：文本含空格时主动提醒「引擎按词折、这里按字符折」（行数可能对不上）',
        fitSpace.ok === true &&
            Array.isArray(fitSpace.result.reasons) &&
            fitSpace.result.reasons.some((r) => /按\*\*词\*\*折行/.test(r)),
        fitSpace.result && fitSpace.result.reasons,
    );

    /**
     * **历史 bug #2**（效果名被截）：`property/name` 只有 56px 宽，
     * 而 6 个汉字的词按 1em/字要 84px —— 名字被截。
     * 「CJK = 1em」这条是从引擎量出来的（`'啊'` 在 fs20 下宽 20.0），不是假设。
     */
    const fitCjk = await scene.methods.runCode({
        code: 'return labelFit({ text: "局内初始金币", fontSize: 14, width: 56, height: 16, lineHeight: 0, overflow: "CLAMP", wrap: false });',
        timeoutMs: 5000,
    });
    {
        const r = (fitCjk && fitCjk.result) || {};
        check(
            'labelFit：6 个汉字在 fs14 下要 84px —— 56px 的框判为放不下（历史 bug #2）',
            fitCjk.ok === true && r.maxLineWidth === 84 && r.fitsWidth === false && r.overflowX === 28,
            { maxLineWidth: r.maxLineWidth, fitsWidth: r.fitsWidth, overflowX: r.overflowX },
        );
        check(
            'labelFit：不换行时只有 1 行，行进给回落到 fontSize（不是 fontSize × 1.26）',
            r.lineCount === 1 && r.advance === 14 && /fontSize/.test(String(r.advanceSource)),
            { lineCount: r.lineCount, advance: r.advance, advanceSource: r.advanceSource },
        );
    }
    /**
     * canvas 真量这条路 —— 注入一个假 `document`，让 `measureText` 回一个**确定性**的宽度。
     * 钉住的是「有 DOM 就真量、且回执如实报 method=canvas」。
     */
    const fitCanvas = await scene.methods.runCode({
        code: [
            'const realDoc = globalThis.document;',
            'globalThis.document = { createElement: () => ({ getContext: () => ({ font: "", measureText: (s) => ({ width: s.length * 10 }) }) }) };',
            'const out = labelFit({ text: "abcdefgh", fontSize: 20, width: 1000, height: 100, lineHeight: 0, wrap: true });',
            'globalThis.document = realDoc;',
            'return out;',
        ].join('\n'),
        timeoutMs: 5000,
    });
    check(
        'labelFit：页面上有 DOM 就真量（method=canvas），宽度来自 measureText 而不是估算表',
        fitCanvas.ok === true && fitCanvas.result.method === 'canvas' && fitCanvas.result.maxLineWidth === 80,
        { method: fitCanvas.result && fitCanvas.result.method, maxLineWidth: fitCanvas.result && fitCanvas.result.maxLineWidth },
    );

    const fitBadTarget = await scene.methods.runCode({
        code: 'try { labelFit(42); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }',
        timeoutMs: 5000,
    });
    check(
        'labelFit：target 不是节点/组件/spec 时抛出带用法的错误',
        fitBadTarget.ok === true && fitBadTarget.result.threw === true && /spec 对象/.test(fitBadTarget.result.message),
        fitBadTarget.result,
    );

    // ---- snapshotTree / diffTree：把「我到底改了什么」变成一次调用 ------------------
    /**
     * 顺带钉住两个真实教训：
     * 1. **键必须是节点路径**，不是 uuid —— 编辑器存盘后 uuid 会换一批，
     *    按 uuid 做键的话 before/after 会变成「删了 N 个、加了 N 个」；
     * 2. **新增节点里名字像探针的要单独挑出来** —— 实测漏删过探针卡片与实验节点。
     */
    const snapDiff = await scene.methods.runCode({
        code: [
            'snapshotTree(null, { label: "v-before" });',
            // 改两处：一个 Label 的字号、一个节点的 active
            'nodeByPath("Canvas/Card/label").getComponent(cc.Label).fontSize = 22;',
            'nodeByPath("Canvas/Card/bg").active = false;',
            'snapshotTree(null, { label: "v-after" });',
            'return diffTree("v-before", "v-after");',
        ].join('\n'),
        timeoutMs: 5000,
    });
    {
        const r = (snapDiff && snapDiff.result) || {};
        const flat = {};
        for (const row of r.changed || []) for (const key of Object.keys(row.props)) flat[`${row.path}|${key}`] = row.props[key];
        check(
            'snapshotTree/diffTree：改了两个属性就只回那两条（键摊平成 `Type.field`，带 from/to）',
            snapDiff.ok === true &&
                r.counts.changed === 2 &&
                flat['./Canvas/Card/label|Label.fontSize'] &&
                flat['./Canvas/Card/label|Label.fontSize'].from === 16 &&
                flat['./Canvas/Card/label|Label.fontSize'].to === 22,
            { counts: r.counts, keys: Object.keys(flat) },
        );
        check(
            'snapshotTree/diffTree：active 的变化也在（`./Canvas/Card/bg|active`）',
            Boolean(flat['./Canvas/Card/bg|active']) && flat['./Canvas/Card/bg|active'].to === false,
            flat['./Canvas/Card/bg|active'],
        );
        check(
            'snapshotTree：**键是路径**（`./Canvas/Card/label`）—— 存盘换 uuid 也照样能比',
            Object.keys(flat).every((k) => k.indexOf('./') === 0),
            Object.keys(flat),
        );
        check(
            'snapshotTree：默认**剪掉编辑器装饰**（gizmo 是编辑器重建的，留着会造假 diff）',
            !Object.keys(flat).some((k) => /Editor Scene Foreground/.test(k)) &&
                r.counts.beforeNodes === 6 &&
                r.counts.unchanged === 4,
            { beforeNodes: r.counts.beforeNodes, unchanged: r.counts.unchanged },
        );
    }

    const snapSave = await scene.methods.runCode({
        code: [
            'const a = snapshotTree(null, { label: "v-saved", saveTo: args.path });',
            'const b = snapshotTree(null, { label: "v-saved2" });',
            'const d = diffTree("v-saved", "v-saved2", { saveTo: args.report });',
            'return { saved: a.saved, report: d.saved, changed: d.counts.changed, bytes: a.bytes, leaked: d.suspectLeaks };',
        ].join('\n'),
        args: { path: snapPath, report: join(FAKE_PROJECT, 'diff-report.json') },
        timeoutMs: 5000,
    });
    check(
        'snapshotTree/diffTree：saveTo 真落盘；同一棵树连拍两次 → 0 条改动（说明哈希/比对口径自洽，不抖）',
        snapSave.ok === true &&
            snapSave.result.saved === snapPath &&
            existsSync(snapPath) &&
            snapSave.result.report === diffPath &&
            existsSync(diffPath) &&
            snapSave.result.changed === 0 &&
            snapSave.result.bytes > 0,
        snapSave.ok ? snapSave.result : snapSave,
    );

    /**
     * 「忘了删临时节点」这一条是真踩过的：探针卡片与实验节点留在预制件里，
     * 靠下一次开编辑器人工发现。所以 diff 要**主动点名**像探针的新增节点。
     */
    const snapLeak = await scene.methods.runCode({
        code: [
            'snapshotTree(null, { label: "leak-before" });',
            'const host = nodeByPath("Canvas");',
            'host.children.push({',
            '    name: "__probe_card", uuid: "probe-uuid", position: { x: 0, y: 0 }, scale: { x: 1, y: 1, z: 1 },',
            '    worldPosition: { x: 0, y: 0, z: 0 }, worldScale: { x: 1, y: 1, z: 1 },',
            '    active: true, activeInHierarchy: true, hideFlags: 0, parent: host, children: [],',
            '    getComponent: () => null, getSiblingIndex: () => 0,',
            '});',
            'snapshotTree(null, { label: "leak-after" });',
            'const d = diffTree("leak-before", "leak-after");',
            'host.children.pop();', // 收尾：别把夹具留在树里影响后面的断言
            'return { added: d.counts.added, leaks: d.suspectLeaks };',
        ].join('\n'),
        timeoutMs: 5000,
    });
    check(
        'diffTree：新增节点里名字像临时探针的会被**单独点名**（suspectLeaks）—— 实测漏删过探针卡片',
        snapLeak.ok === true &&
            snapLeak.result.added === 1 &&
            Array.isArray(snapLeak.result.leaks) &&
            snapLeak.result.leaks.some((p) => p.indexOf('__probe_card') >= 0),
        snapLeak.ok ? snapLeak.result : snapLeak,
    );

    const snapHash = await scene.methods.runCode({
        code: 'const a = snapshotTree(null, { label: "h1" }); const b = snapshotTree(null, { label: "h2" }); return { same: a.hash === b.hash, bytes: a.bytes > 0, nodeCount: a.nodeCount, keptBefore: a.kept.indexOf("v-before") >= 0 };',
        timeoutMs: 5000,
    });
    check(
        'snapshotTree：内容没变则哈希相同（**哈希不含 `at` 时间戳** —— 否则跨毫秒就红）；快照**跨调用还在**（`kept` 里能看到前面那些 label）',
        snapHash.ok === true &&
            snapHash.result.same === true &&
            snapHash.result.keptBefore === true &&
            snapHash.result.nodeCount === 6,
        snapHash.ok ? snapHash.result : snapHash,
    );

    const snapMissing = await scene.methods.runCode({
        code: 'try { diffTree("nope", "h1"); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }',
        timeoutMs: 5000,
    });
    check(
        'diffTree：label 不存在时抛出并**列出已有的那些**（不是回一个空 diff 让人以为没改动）',
        snapMissing.ok === true && snapMissing.result.threw === true && /已有的/.test(snapMissing.result.message),
        snapMissing.result,
    );

    // 收尾：把这一节装上的全局量撤掉，别影响后面几节（与 [6c] 同一规矩）
    delete global.window;
    delete globalThis.cce;
    cc.director.__scene = null;

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

    // ---- probe：图片的像素级事实（editor 侧走 Electron 的 nativeImage）------------
    /**
     * 三个实测反复出现、原先只能靠「打开图片看」或**猜**的问题：
     * ① `rect_rd_10.png` 存不存在；② `rect_board_rd_10` 中心是空的（是"环"不是"板"）；
     * ③ `achivement.png` 是深色图形、**染不了色**。
     *
     * ⚠ 诚实边界：假 `nativeImage` **不真解码**（纯 Node 里没 Chromium）。它按一张固定表回 BGRA，
     * 所以这一节钉的是「索引/四角/中心/统计算得对」，**真解码那一步没被覆盖**。
     */
    const probeDir = join(FAKE_PROJECT, 'assets', 'resources', 'textures', 'probe');
    mkdirSync(probeDir, { recursive: true });
    const probePng = join(probeDir, 'tintable.png');
    // 一个真的 8 字节 PNG 头 + 内容（内容无所谓，`fs.existsSync` 与 `.meta` 才是被测的）
    writeFileSync(probePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]));
    writeFileSync(
        join(probeDir, 'tintable.png.meta'),
        JSON.stringify({ ver: '1.0.26', importer: 'image', uuid: '7d8f9b89-0000-4000-8000-000000000000' }),
        'utf8',
    );
    writeFileSync(
        join(probeDir, 'tintable_round_2.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]),
    );

    // 「可染色」的那张：4×4、四角透明、其余纯白
    fakeElectron.nativeImage.sheet = { width: 4, height: 4, r: 255, g: 255, b: 255 };
    const probeOk = await engine.executeCode({
        context: 'editor',
        code: "return probe(args.path, { x: 0, y: 0 });",
        args: { path: 'db://assets/resources/textures/probe/tintable.png' },
    });
    {
        const r = (probeOk.data && probeOk.data.result) || {};
        check(
            'probe：db://assets 路径解析 + 尺寸 + 中心/四角像素（四角透明、中心白）',
            probeOk.ok === true && r.ok === true && r.width === 4 && r.height === 4 && r.center.hex === '#ffffffff',
            { ok: r.ok, width: r.width, center: r.center },
        );
        check(
            'probe：明确回答「这图能不能用 Sprite.color 染色」（四角透明 + 主体白 → 能）',
            r.tint && r.tint.canvasLike === true && r.tint.whiteish === true && /可染色/.test(r.tint.note),
            r.tint,
        );
        check(
            'probe：透明比例算得对（16 个像素里 4 个角是透明的）',
            r.alpha && r.alpha.transparentRatio === 0.25 && r.alpha.min === 0 && r.alpha.max === 255,
            r.alpha,
        );
        check(
            'probe：`engineBuiltin` 认得出引擎内置贴图 uuid（与 audit:ui 的 P4 同一条判据）',
            r.engineBuiltin === true && r.uuid === '7d8f9b89-0000-4000-8000-000000000000',
            { uuid: r.uuid, engineBuiltin: r.engineBuiltin },
        );
        check(
            'probe：给坐标就读那个像素（(0,0) 是透明的）',
            r.at && r.at.hex === '#00000000' && r.at.rgba.a === 0,
            r.at,
        );
        check(
            'probe：回执里说明坐标是**整张图**的像素（图集子帧要自己换算 rect）',
            typeof r.note === 'string' && /整张图/.test(r.note),
            r.note,
        );
    }

    const probeMissing = await engine.executeCode({
        context: 'editor',
        code: "return probe('db://assets/resources/textures/probe/tintable_round_10.png');",
    });
    check(
        'probe：文件不存在时**顺手列出名字相近的**（"rect_rd_10.png 到底有没有"这类问题一次答完）',
        probeMissing.ok === true &&
            probeMissing.data.result.exists === false &&
            Array.isArray(probeMissing.data.result.nearby) &&
            probeMissing.data.result.nearby.some((n) => n.indexOf('tintable_round_2') >= 0),
        probeMissing.data && probeMissing.data.result,
    );

    const probeInternal = await engine.executeCode({
        context: 'editor',
        code: "try { probe('db://internal/default_ui/default_sprite.png'); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }",
    });
    check(
        'probe：db://internal（引擎内置，不在工程目录）明说，不是静默失败',
        probeInternal.ok === true &&
            probeInternal.data.result.threw === true &&
            /引擎内置/.test(probeInternal.data.result.message),
        probeInternal.data && probeInternal.data.result,
    );

    const probeEmpty = await engine.executeCode({
        context: 'editor',
        code: "try { probe(''); return { threw: false }; } catch (e) { return { threw: true, message: e.message }; }",
    });
    check(
        'probe：空 ref 抛出带用法的错误',
        probeEmpty.ok === true && probeEmpty.data.result.threw === true && /db:\/\/assets/.test(probeEmpty.data.result.message),
        probeEmpty.data && probeEmpty.data.result,
    );

    const probeUndecodable = await engine.executeCode({
        context: 'editor',
        code: "return probe('db://assets/resources/textures/probe/tintable_round_2.png');",
    });
    check(
        'probe：解不开的图如实回 ok=false（不是回一张全 0 的"像素"让人当真数据）',
        probeUndecodable.ok === true &&
            probeUndecodable.data.result.ok === false &&
            probeUndecodable.data.result.exists === true &&
            /解不开/.test(String(probeUndecodable.data.result.error)),
        probeUndecodable.data && probeUndecodable.data.result,
    );

    const probeInList = await engine.executeCode({
        context: 'editor',
        code: 'return helperNames().filter((s) => s.indexOf("probe(") === 0);',
    });
    check(
        'probe 出现在 editor 的助手清单里（`describe_api` 靠它，不列进去 = 模型看不见）',
        probeInList.ok === true && probeInList.data.result.length === 1,
        probeInList.data && probeInList.data.result,
    );

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
    console.log('\n[6b] capture_view 的 Electron 通道（假 webContents + 真几何换算）');
    // ---------------------------------------------------------------------
    state.sceneAvailable = true;

    /**
     * 装一个「2D 场景视图」的现场，数字全部好手算：
     *
     * - 页面 600×400 **CSS**，画布 1200×800 **device**（dpr = 2）；
     * - 编辑器相机 1200×800 像素、`orthoHeight = 400` → **k = 1**（屏幕像素 = 世界单位），
     *   可见世界 `x ∈ [-300,300]`、`y ∈ [-200,200]`；
     * - 内容：`Canvas` 600×400 铺满画布 + `card` 200×100 在 (100,50)（世界矩形 x∈[0,200]、y∈[0,100]）。
     *
     * 手工核对（`projectNodeRect` 的三步：除 dpr → y 翻转 → 加画布偏移）：
     *
     * ```
     * 相机像素：x = 600 + wx ∈ [600, 800]   y = 400 + wy ∈ [400, 500]
     * 除 dpr=2：x ∈ [300, 400]              y ∈ [200, 250]
     * y 翻转  ：y' = (800 − y)/2 ∈ [150, 200]
     * → CSS 矩形 (300, 150, 100, 50)
     * ```
     */
    // `cc` 已在 main() 开头 require（[2c] 那节要先用它）—— 这里不再重复声明。
    const PAGE_HREF = 'file:///editor/3d-webview.html?url=main';
    /** 场景进程里 `pageGeometry()` 读的就是 `window.*` —— 这里给一个只有这几项的假 window */
    global.window = { location: { href: PAGE_HREF }, innerWidth: 600, innerHeight: 400, devicePixelRatio: 2 };
    cc.game.canvas = {
        width: 1200,
        height: 800,
        getContext: () => ({}),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    };
    /** 编辑器相机的全局单例（`cce.Camera.camera` 就是 `EditorCameraComponent`，本身是 `cc.Camera`） */
    const stage = installFakeSceneView(cc);
    const card = stage.card;
    const fakeScene = stage.scene;
    cc.director.__scene = fakeScene;
    globalThis.cce = { Camera: stage.manager };

    const metrics = await scene.methods.viewMetrics({ node: 'card-uuid' });
    check(
        'viewMetrics 报出页面 href / 画布几何 / 编辑器相机',
        metrics.ok === true &&
            metrics.page.href === PAGE_HREF &&
            metrics.canvas.deviceWidth === 1200 &&
            metrics.canvas.cssWidth === 600 &&
            metrics.camera.available === true &&
            metrics.camera.height === 800,
        metrics,
    );
    check(
        'viewMetrics 把节点换算成页面 CSS 像素（相机左下原点 → 除 dpr → y 翻转）',
        metrics.node && JSON.stringify(metrics.node.rect) === '{"x":300,"y":150,"width":100,"height":50}',
        metrics.node,
    );

    const view = makeFakeView(PAGE_HREF);
    fakeElectron.views = [view];
    const shotPath = join(FAKE_PROJECT, 'shot-view.png');
    const shot = await engine.captureView({ savePath: shotPath, maxWidth: 4096 });
    check(
        'capture_view 走 Electron 通道并落盘（method: electron）',
        shot.ok === true && shot.data.method === 'electron' && existsSync(shotPath),
        shot.data && { ok: shot.data.ok, method: shot.data.method, fallback: shot.data.electronFallback, error: shot.error },
    );
    check(
        '按场景脚本报来的 href 精确定位那个 webContents（不是「随便挑一个 webview」）',
        shot.data.matchedBy === 'href' && shot.data.contents.url === PAGE_HREF && shot.data.contents.id === 42,
        shot.data.contents,
    );
    check(
        '整张视图：不裁不缩，出图 = 抓到的原图（600×400）',
        shot.data.target.kind === 'view' &&
            shot.data.width === 600 &&
            shot.data.height === 400 &&
            readFileSync(shotPath, 'utf8') === 'PNG 600x400',
        { width: shot.data.width, height: shot.data.height, file: readFileSync(shotPath, 'utf8') },
    );
    check(
        '抓到好图那次：回执里**没有** `useInvalidate` / `forcedRepaint` 这两格了（本扩展不再有"逼重绘"这个旋钮）',
        shot.data.blankRatio < 0.05 &&
            shot.data.useInvalidate === undefined &&
            shot.data.forcedRepaint === undefined &&
            view.invalidateCalls === 0,
        { blankRatio: shot.data.blankRatio, useInvalidate: shot.data.useInvalidate, forcedRepaint: shot.data.forcedRepaint, invalidateCalls: view.invalidateCalls },
    );

    view.invalidateCalls = 0;
    /** 连"要了才排"也没了：就算调用方硬塞 `forceRepaint:true`（旧参数），代码里也没有任何一处会去碰合成器 */
    const repaintShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-repaint.png'), maxWidth: 4096, forceRepaint: true });
    check(
        '旧参数 `forceRepaint:true` 已经**失效**（不是"默认关掉"，是根本没有这个动作）：一次 `invalidate()` 都不发，回执也不再有那两格',
        repaintShot.ok === true &&
            repaintShot.data.forcedRepaint === undefined &&
            view.invalidateCalls === 0,
        { forcedRepaint: repaintShot.data.forcedRepaint, invalidateCalls: view.invalidateCalls },
    );
    view.invalidateCalls = 0;

    const nodePath = join(FAKE_PROJECT, 'shot-node.png');
    const nodeShot = await engine.captureView({ node: 'card-uuid', savePath: nodePath, maxWidth: 4096 });
    const nodeCrop = view.lastImage.__calls.filter((call) => call.kind === 'crop').pop();
    check(
        '节点截图：按场景侧算出的 CSS 矩形裁（(300,150,100,50)，图与页面 1:1）',
        nodeShot.ok === true &&
            nodeShot.data.target.kind === 'node' &&
            nodeShot.data.target.name === 'Card' &&
            Boolean(nodeCrop) &&
            JSON.stringify(nodeCrop.rect) === '{"x":300,"y":150,"width":100,"height":50}',
        { crop: nodeCrop, target: nodeShot.data.target },
    );
    check('节点截图的落盘尺寸 = 裁切尺寸（PNG 100x50）', readFileSync(nodePath, 'utf8') === 'PNG 100x50', readFileSync(nodePath, 'utf8'));
    check(
        '节点本来就在画布里 → `fit:auto` **不动相机**（用户视角不该为一张截图被挪）',
        nodeShot.data.framing.applied === null && stage.findAllCalls('focus').length === 0,
        { framing: nodeShot.data.framing, focusCalls: stage.findAllCalls('focus').length },
    );
    const idleViewShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-fit-idle.png'), maxWidth: 4096 });
    check(
        '「不用取景」是正常情况：`note` 留空（约定：note 非空 = 有事），原因写在 `framing.why` 里',
        idleViewShot.ok === true && !idleViewShot.data.framing.note && /没动相机/.test(String(idleViewShot.data.framing.why || '')),
        idleViewShot.data.framing,
    );

    /**
     * padding 给足（200）就能同时踩到**两侧越界**：矩形变成 (100, −50, 500, 450)，
     * 上沿越出图顶、下沿越出图底 —— 夹完正好 (100, 0, 500, 400)。
     */
    const paddedPath = join(FAKE_PROJECT, 'shot-padded.png');
    const padded = await engine.captureView({ node: 'card-uuid', padding: 200, savePath: paddedPath, maxWidth: 4096 });
    const paddedCrop = view.lastImage.__calls.filter((call) => call.kind === 'crop').pop();
    check(
        'padding 生效，且越界的两侧都被夹回图内（上沿 0、下沿 400）',
        padded.ok === true && Boolean(paddedCrop) && JSON.stringify(paddedCrop.rect) === '{"x":100,"y":0,"width":500,"height":400}',
        paddedCrop,
    );
    check('padding 后的落盘尺寸跟着变（PNG 500x400）', readFileSync(paddedPath, 'utf8') === 'PNG 500x400', readFileSync(paddedPath, 'utf8'));

    view.blankNext = true;
    view.invalidateCalls = 0;
    const healedPath = join(FAKE_PROJECT, 'shot-healed.png');
    const healed = await engine.captureView({ savePath: healedPath, maxWidth: 4096 });
    check(
        '第一张是空图 → **不重试、不逼重绘**（空就是空，如实报）；也**不许**静默换成别的图',
        healed.ok === true &&
            healed.data.useInvalidate === undefined &&
            healed.data.blankRatio >= 0.95 &&
            view.invalidateCalls === 0 &&
            view.captureCalls >= 1,
        { blankRatio: healed.data.blankRatio, useInvalidate: healed.data.useInvalidate, invalidateCalls: view.invalidateCalls, captureCalls: view.captureCalls },
    );

    view.alwaysBlank = true;
    const blankShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-blank.png'), maxWidth: 4096 });
    check(
        '全是空图 → ok:true 但如实报 blankRatio + 「别再重试截图」的退路',
        blankShot.ok === true && blankShot.data.blankRatio >= 0.95 && /别再重试截图/.test(blankShot.data.hint),
        { blankRatio: blankShot.data.blankRatio, hint: String(blankShot.data.hint).slice(0, 60) },
    );
    view.alwaysBlank = false;

    // 图比页面大（按设备像素出图）→ 裁切必须按**实测比值**放大，而不是假定 1:1
    view.imageSize = { width: 1200, height: 800 };
    const bigPath = join(FAKE_PROJECT, 'shot-big.png');
    const bigShot = await engine.captureView({ node: 'card-uuid', savePath: bigPath, maxWidth: 4096 });
    const bigCrop = view.lastImage.__calls.filter((call) => call.kind === 'crop').pop();
    check(
        '图与页面不等比时按实测比值换算（1200/600 = 2 → 裁切矩形也 ×2）',
        bigShot.ok === true &&
            Boolean(bigCrop) &&
            JSON.stringify(bigCrop.rect) === '{"x":600,"y":300,"width":200,"height":100}' &&
            readFileSync(bigPath, 'utf8') === 'PNG 200x100',
        { crop: bigCrop, file: readFileSync(bigPath, 'utf8') },
    );
    view.imageSize = { width: 600, height: 400 };

    // 节点找不到 → 不裁，退成整张视图，并把原因写进回执
    const missPath = join(FAKE_PROJECT, 'shot-miss.png');
    const missShot = await engine.captureView({ node: 'not-a-node', savePath: missPath, maxWidth: 4096 });
    check(
        '节点找不到时退成整张视图，并说清为什么（不是裁一个瞎猜的框）',
        missShot.ok === true &&
            missShot.data.target.kind === 'node' &&
            typeof missShot.data.note === 'string' &&
            /整张场景视图/.test(missShot.data.note) &&
            readFileSync(missPath, 'utf8') === 'PNG 600x400',
        { note: missShot.data.note, file: readFileSync(missPath, 'utf8') },
    );

    // 节点远在图外（矩形与图**压根不相交**）→ 不能给一张 1 像素宽的"有效裁切"，要退回整张视图
    const farPosition = { ...card.worldPosition };
    stage.placeCard(100000, 50);
    stage.calls.length = 0;

    /** `fit:'none'` = **老行为**（明确要"按当前视角原样截"时才走这条） */
    const outsidePath = join(FAKE_PROJECT, 'shot-outside.png');
    const outsideShot = await engine.captureView({ node: 'card-uuid', fit: 'none', savePath: outsidePath, maxWidth: 4096 });
    check(
        '`fit:none` + 节点在图外 → 退回整张视图（不是裁一条 1 像素的边）',
        outsideShot.ok === true &&
            outsideShot.data.target.crop === null &&
            outsideShot.data.framing.applied === null &&
            stage.findAllCalls('focus').length === 0 &&
            /整张场景视图/.test(String(outsideShot.data.note || '')) &&
            readFileSync(outsidePath, 'utf8') === 'PNG 600x400',
        { crop: outsideShot.data.target.crop, note: outsideShot.data.note, framing: outsideShot.data.framing },
    );
    check(
        '`fit:none` 时如实说「没拍全」（`framing.before.covered = false`）而不是假装没事',
        outsideShot.data.framing.before && outsideShot.data.framing.before.covered === false && /fit:"scene"/.test(String(outsideShot.data.framing.note || '')),
        outsideShot.data.framing,
    );

    /** 默认 `fit:'auto'` = **自动取景把它救回来** —— 这正是「缩放过之后节点截不到」的解法 */
    const rescuePath = join(FAKE_PROJECT, 'shot-rescue.png');
    /** 救之前先记下用户此刻的视角（还原对不对，跟它比） */
    const cameraBeforeRescue = { pos: { ...stage.state.pos }, orthoHeight: stage.state.orthoHeight };
    const rescueShot = await engine.captureView({ node: 'card-uuid', savePath: rescuePath, maxWidth: 4096 });
    const rescueCrop = rescueShot.data.target.crop;
    check(
        '节点在图外 + `fit:auto` → 先把节点框进画布再裁（不再退成整张视图）',
        rescueShot.ok === true &&
            Boolean(rescueCrop) &&
            Math.abs(rescueCrop.width - 504) <= 2 &&
            Math.abs(rescueCrop.height - 252) <= 2 &&
            rescueShot.data.framing.method === 'focus' &&
            rescueShot.data.framing.after.covered === true,
        { crop: rescueCrop, framing: rescueShot.data.framing },
    );
    check(
        '救完之后**相机还原**（用户视角没被留在节点那儿）',
        rescueShot.data.framing.restored === true &&
            rescueShot.data.framing.restoreMethod === 'info' &&
            Math.abs(stage.state.pos.x - cameraBeforeRescue.pos.x) < 0.5 &&
            Math.abs(stage.state.pos.y - cameraBeforeRescue.pos.y) < 0.5 &&
            Math.abs(stage.state.orthoHeight - cameraBeforeRescue.orthoHeight) < 1,
        {
            restored: rescueShot.data.framing.restored,
            method: rescueShot.data.framing.restoreMethod,
            now: { pos: stage.state.pos, orthoHeight: stage.state.orthoHeight },
            before: cameraBeforeRescue,
        },
    );
    stage.placeCard(farPosition.x, farPosition.y);

    // 一个 webContents 都没有 → 退回老路，且说清为什么退（这是"两个通道"关系的核心）
    fakeElectron.views = [];
    const noViewReply = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-noview.png') });
    check(
        '抓不到场景视图的 webContents → 退回场景进程那条路，并给出 electronFallback 说明',
        noViewReply.ok === false &&
            noViewReply.data &&
            typeof noViewReply.data.electronFallback === 'string' &&
            /webContents/.test(noViewReply.data.electronFallback),
        { ok: noViewReply.ok, electronFallback: noViewReply.data && noViewReply.data.electronFallback },
    );
    fakeElectron.views = [view];

    // ---------------------------------------------------------------------
    console.log('\n[6c] 取景（fit）：用户缩放过之后，也要能把该拍的拍全');
    // ---------------------------------------------------------------------
    // 这一段验的是「截图前先摆相机」这条链：**摆一级 → 逼一帧 → 量一遍 → 验不过就降级**。
    // 判据全部来自真代码（`dist/scene.js` 的 fitView / viewMetrics.framing + `dist/core/engine.js`
    // 的 runFitChain），假相机则是**真·正交模型**（见 installFakeSceneView），
    // 所以第三级「手工摆相机」的算式在这里也能被验真假。

    stage.reset();
    stage.calls.length = 0;

    /** ① `contentBounds()` 助手：场景到底有多大（这是取景量的那块矩形） */
    const boundsRun = await scene.methods.runCode({
        code: 'return contentBounds();',
        projectPath: FAKE_PROJECT,
    });
    const bounds = boundsRun.result;
    check(
        'contentBounds() 量的是**真实内容**（Canvas 600×400 + card），且给出可聚焦的 uuid',
        boundsRun.ok === true &&
            bounds.width === 600 &&
            bounds.height === 400 &&
            bounds.left === -300 &&
            bounds.top === 200 &&
            bounds.count === 2 &&
            JSON.stringify(bounds.uuids) === '["canvas-uuid"]',
        boundsRun,
    );

    /** ② 内容正好铺满可见世界的一半边长 → 拍全了（`covered`），面积占 1/4 */
    const sceneMetrics = await scene.methods.viewMetrics({ fit: { kind: 'scene' } });
    check(
        'viewMetrics 报出「目标拍全了没有」（covered / areaRatio / 四边余量 / 量的是哪块矩形）',
        sceneMetrics.framing &&
            sceneMetrics.framing.covered === true &&
            sceneMetrics.framing.areaRatio === 0.25 &&
            sceneMetrics.framing.edges.left > 0 &&
            sceneMetrics.framing.edges.right > 0 &&
            sceneMetrics.framing.target.source === 'contentBounds' &&
            sceneMetrics.framing.target.uuids === 1 &&
            sceneMetrics.framing.target.world.width === 600,
        sceneMetrics.framing,
    );

    /** ③ 把相机挪到很远（= 用户缩放到别处了）→ `fit:none` 如实报"没拍全"，且一根手指都不碰相机 */
    stage.moveCamera(5000, 0);
    stage.calls.length = 0;
    view.invalidateCalls = 0;
    const nonePath = join(FAKE_PROJECT, 'shot-fit-none.png');
    const noneShot = await engine.captureView({ fit: 'none', savePath: nonePath, maxWidth: 4096 });
    check(
        '`fit:none` + 视角偏了：照样截图，但回执明说「没拍全」并给出改法（不擅自动用户视角）',
        noneShot.ok === true &&
            noneShot.data.framing.applied === null &&
            noneShot.data.framing.before.covered === false &&
            /fit:"scene"/.test(String(noneShot.data.framing.note || '')) &&
            /** ⚠ 相机一次没动（这里的 0 说的是这件事）；抓图前那次重绘**默认也不排**了（2026-10-08 现场），所以这里也是 0 */
            stage.calls.length === 0 &&
            view.invalidateCalls === 0 &&
            readFileSync(nonePath, 'utf8') === 'PNG 600x400',
        { framing: noneShot.data.framing, camCalls: stage.calls.length, invalidateCalls: view.invalidateCalls },
    );
    check(
        '`fit:none` 时覆盖率是**量出来的**（areaRatio 归零 = 内容整块跑到画布外了）',
        noneShot.data.framing.before.areaRatio === 0 && noneShot.data.framing.before.edges.left < 0,
        noneShot.data.framing.before,
    );

    /** ④ 同一现场 + 默认 `auto` → 自动取景 → 拍全 → **还原** */
    view.invalidateCalls = 0;
    stage.calls.length = 0;
    const autoPath = join(FAKE_PROJECT, 'shot-fit-auto.png');
    const autoShot = await engine.captureView({ savePath: autoPath, maxWidth: 4096 });
    check(
        '`fit:auto` + 视角偏了 → 先取景再截，`framing` 记下「之前没拍全 / 之后拍全了」',
        autoShot.ok === true &&
            autoShot.data.framing.requested === 'auto' &&
            autoShot.data.framing.applied === 'scene' &&
            autoShot.data.framing.before.covered === false &&
            autoShot.data.framing.after.covered === true &&
            autoShot.data.framing.method === 'focus' &&
            autoShot.data.framing.step === 0,
        autoShot.data.framing,
    );
    check(
        '取景走的是**编辑器自己的聚焦**（`cce.Camera.focus(uuids, undefined, true)`，uuid 来自 contentBounds），还原走 `focus(null, info)`',
        stage.findAllCalls('focus').length === 2 &&
            JSON.stringify(stage.findAllCalls('focus')[0].uuids) === '["canvas-uuid"]' &&
            stage.findAllCalls('focus')[0].immediate === true &&
            stage.findAllCalls('focus')[0].hasInfo === false &&
            stage.findAllCalls('focus')[1].uuids === null &&
            stage.findAllCalls('focus')[1].hasInfo === true,
        stage.findAllCalls('focus'),
    );
    check(
        '取景之后**一次 `invalidate()` 都没有**（2026-10-08 口径：本扩展不碰合成器 —— 相机动完就量，可能读到重画前那一帧，靠"多量几轮"而不是逼帧来兜）',
        view.invalidateCalls === 0,
        { invalidateCalls: view.invalidateCalls },
    );
    check(
        '截完**视角还原**（编辑器自己的还原通道，method: info）',
        autoShot.data.framing.restored === true &&
            autoShot.data.framing.restoreMethod === 'info' &&
            Math.abs(stage.state.pos.x - 5000) < 0.5 &&
            Math.abs(stage.state.orthoHeight - 400) < 1,
        { framing: autoShot.data.framing, pos: stage.state.pos, orthoHeight: stage.state.orthoHeight },
    );

    /** ⑤ 第一级失灵（`focus` 框不全）→ 必须**降级**到 2D 控制器的适配，而不是将就用 */
    stage.moveCamera(5000, 0);
    stage.flags.focusCovers = false;
    stage.calls.length = 0;
    const adjustShot = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-adjust.png'), maxWidth: 4096 });
    check(
        '第一级（编辑器 focus）框不全 → 降级到第二级（controller2D._adjustToCenter，显式传矩形）',
        adjustShot.ok === true &&
            adjustShot.data.framing.method === 'adjust' &&
            adjustShot.data.framing.step === 1 &&
            adjustShot.data.framing.after.covered === true &&
            stage.findAllCalls('adjust')[0].rect.width === 600 &&
            stage.findAllCalls('adjust')[0].immediate === true,
        { framing: adjustShot.data.framing, adjustCalls: stage.findAllCalls('adjust') },
    );

    /** ⑥ 两级都失灵 → 第三级**手工摆相机**（算式要真的对，所以假相机是按引擎口径建模的） */
    stage.flags.adjustCovers = false;
    stage.calls.length = 0;
    const manualShot = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-manual.png'), maxWidth: 4096 });
    check(
        '两级都框不全 → 第三级手工摆相机，**量出来的缩放与位置真能框全**（covered 是量出来的）',
        manualShot.ok === true &&
            manualShot.data.framing.method === 'manual' &&
            manualShot.data.framing.step === 2 &&
            manualShot.data.framing.after.covered === true &&
            typeof manualShot.data.framing.detail.scale === 'number',
        { framing: manualShot.data.framing, orthoHeight: stage.state.orthoHeight },
    );
    check(
        '手工那一级是按「像素/世界单位」反算的（603.4 / 238.1 这类数不是拍脑袋来的）',
        manualShot.data.framing.detail.pxPerUnitBefore > 0 &&
            manualShot.data.framing.detail.pxPerUnitWanted > manualShot.data.framing.detail.pxPerUnitBefore &&
            manualShot.data.framing.detail.scale < 400,
        manualShot.data.framing.detail,
    );

    /**
     * ⑦ 三级都失灵（focus 框不全 + 控制器框不全 + 写相机被拒）→ 不许假装成功，
     *    要明说「这张图可能仍然不是全景」，并且**照常把图给你**。
     */
    stage.reset();
    stage.moveCamera(5000, 0);
    stage.flags.focusCovers = false;
    stage.flags.adjustCovers = false;
    stage.flags.failWrites = true;
    const hopeless = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-hopeless.png'), maxWidth: 4096 });
    check(
        '取景彻底失败 → 截图照给，但 `framing.note` 明说「可能仍然不是全景」（不许假装成功）',
        hopeless.ok === true &&
            hopeless.data.framing.method === null &&
            hopeless.data.framing.after.covered === false &&
            /可能仍然不是全景/.test(String(hopeless.data.framing.note || '')),
        hopeless.data.framing,
    );
    /**
     * 关键的一条：**`method` 为 null 也要还原**。第三级手工摆相机是「先写 orthoHeight 再挪位置」，
     * 可能写了一半才失败（那时 `method` 仍是 null，但相机已经被动过了）——
     * 所以主进程只要**尝试过**取景就必须调一次还原（还原是幂等的）。
     */
    check(
        '取景没成功（`method: null`）也照样还原视角（第三级可能已经写了一半）',
        hopeless.data.framing.restored === true,
        { restored: hopeless.data.framing.restored, note: hopeless.data.framing.note },
    );

    /** ⑧ 内容小得看不清（哪怕"拍全了"）→ `auto` 也顺手取景；`fit:none` 仍然一根手指都不碰 */
    stage.reset();
    stage.setContentSize(100, 100);
    const tinyMetrics = await scene.methods.viewMetrics({ fit: { kind: 'scene' } });
    check(
        '内容只占画布 1% 时：`.covered` 是 true（确实全在画里）但 `areaRatio` 很小 —— 两个数分开报',
        tinyMetrics.framing.covered === true && tinyMetrics.framing.areaRatio < 0.15,
        tinyMetrics.framing,
    );
    stage.calls.length = 0;
    const tinyShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-fit-tiny.png'), maxWidth: 4096 });
    check(
        '`auto` 对「小得看不清」也会取景（缩到 10% 看全局时，截图里那一小块根本没法看）',
        tinyShot.ok === true &&
            tinyShot.data.framing.before.covered === true &&
            Boolean(tinyShot.data.framing.method) &&
            tinyShot.data.framing.after.areaRatio > tinyShot.data.framing.before.areaRatio,
        tinyShot.data.framing,
    );
    /**
     * 顺带验到一件真事：这一次 `focus(['canvas-uuid'])` **只框住了 Canvas，没框住探出头的 card**，
     * 于是「量着验」把它挡下来了 → 自动降级到第二级（显式传整个内容矩形）。
     * 这正是「不猜编辑器内部怎么算、只看量出来的结果」的价值。
     */
    check(
        'focus 只框住了一半内容时不会将就 —— 量出没拍全就降级（`method: adjust`）',
        tinyShot.data.framing.method === 'adjust' && tinyShot.data.framing.after.covered === true,
        tinyShot.data.framing,
    );
    stage.calls.length = 0;
    await engine.captureView({ fit: 'none', savePath: join(FAKE_PROJECT, 'shot-fit-tiny-none.png'), maxWidth: 4096 });
    check('`fit:none` 连"小得看不清"也不管（要原样就得原样）', stage.calls.length === 0, stage.calls);
    stage.setContentSize(600, 400);

    /** ⑨ 还原：编辑器自己的通道失灵 → 退回**直接写回相机字段**，并且要说清走的哪条 */
    stage.reset();
    stage.moveCamera(5000, 0);
    stage.flags.infoRestores = false;
    const rawRestore = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-rawrestore.png'), maxWidth: 4096 });
    check(
        '`focus(null, savedInfo)` 还原不了 → 退回直接写回相机字段（`restoreMethod: raw`），仍然算还原成功',
        rawRestore.ok === true &&
            rawRestore.data.framing.restored === true &&
            rawRestore.data.framing.restoreMethod === 'raw' &&
            Math.abs(stage.state.pos.x - 5000) < 0.5 &&
            Math.abs(stage.state.orthoHeight - 400) < 1,
        { framing: rawRestore.data.framing, pos: stage.state.pos, orthoHeight: stage.state.orthoHeight },
    );

    /** ⑩ 两条还原通道都断 → `restored:false` + 明说「视角停在取景后的位置」（不假装） */
    stage.reset();
    stage.moveCamera(5000, 0);
    stage.flags.infoRestores = false;
    stage.flags.failWrites = true;
    const brokenRestore = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-norestore.png'), maxWidth: 4096 });
    check(
        '还原彻底失败 → `restored:false` + 明确告诉用户「场景视图停在取景后的位置」（不许假装还原了）',
        brokenRestore.ok === true &&
            brokenRestore.data.framing.restored === false &&
            /视角没有还原成功/.test(String(brokenRestore.data.framing.note || '')),
        brokenRestore.data.framing,
    );

    /** ⑪ 取景目标写错 / 参数不认：说一声，但别把截图搞失败 */
    stage.reset();
    const badFit = await engine.captureView({ fit: 'nonsense', savePath: join(FAKE_PROJECT, 'shot-fit-badmode.png'), maxWidth: 4096 });
    check(
        '`fit` 传了不认的值 → 按 auto 处理，并在回执里说一句（不静默）',
        badFit.ok === true && /fit 只认/.test(String(badFit.data.fitNote || '')),
        { fitNote: badFit.data.fitNote, framing: badFit.data.framing },
    );
    const nodeFitNoNode = await engine.captureView({ fit: 'node', savePath: join(FAKE_PROJECT, 'shot-fit-nonode.png'), maxWidth: 4096 });
    check(
        '`fit:"node"` 却没给 `node` → 不取景，并说清为什么（不是静默按 auto 跑）',
        nodeFitNoNode.ok === true && nodeFitNoNode.data.framing.applied === null && /需要同时给/.test(String(nodeFitNoNode.data.framing.note || '')),
        nodeFitNoNode.data.framing,
    );

    /** ⑫ 兜底通道（场景进程读像素）**不取景** —— 必须在回执里说清，否则用户会以为图是全的 */
    fakeElectron.views = [];
    const fallbackWithFit = await engine.captureView({ fit: 'scene', savePath: join(FAKE_PROJECT, 'shot-fit-fallback.png') });
    fakeElectron.views = [view];
    check(
        '退回兜底通道时明说「这条路不取景」（`fitIgnored`），而不是让用户以为图是全的',
        fallbackWithFit.ok === false && /不取景/.test(String(fallbackWithFit.data.fitIgnored || '')),
        fallbackWithFit.data,
    );

    // 收尾：把这一节装上的全局量撤掉，别影响后面几节
    delete global.window;
    delete globalThis.cce;
    cc.director.__scene = null;

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
    console.log('\n[8] cocos_logs（真写文件、真读回来）+ 出口 refs（uuid / db:// 去重）');
    // ---------------------------------------------------------------------
    /**
     * 夹具刻意全是**通用日志**（不含任何工程语义）：三条日志覆盖
     * 「找得到 / 筛得准 / 拒绝得清楚 / 清空要确认 / 尾读要说明」五件事。
     */
    const logDir = join(FAKE_PROJECT, 'temp', 'logs');
    mkdirSync(logDir, { recursive: true });
    const projectLog = join(logDir, 'project.log');
    const appLog = join(logDir, 'app.log');
    const dbUrlInLog = 'db://assets/anything/where.png';
    writeFileSync(
        projectLog,
        [
            '[2026-10-05 10:00:00] 这一行比 since 早，必须被筛掉',
            '[2026-10-06 06:04:48] note: 字面量 ( 括号 不能被当正则',
            '[2026-10-06 06:04:49] boom: something failed at step 3',
            `[2026-10-06 06:04:50] after the error ${dbUrlInLog}`,
        ].join('\n'),
        'utf8',
    );
    writeFileSync(appLog, '[2026-10-06 06:05:00] boom: 第二个文件也命中\n', 'utf8');

    const logList = await tools.COCOS_IPC_METHODS.read_logs({ list: true });
    check(
        'read_logs(list) 从通用候选目录里找到夹具（temp/logs）',
        logList.ok === true && logList.data.files.length >= 2,
        logList.text.split('\n').slice(0, 10).join(' | '),
    );
    check(
        'read_logs(list) 如实报「哪些目录存在、哪些不存在」（不静默跳过）',
        Array.isArray(logList.data.dirs) &&
            logList.data.dirs.some((dir) => dir.exists === true) &&
            logList.data.dirs.some((dir) => dir.exists === false),
        JSON.stringify(logList.data.dirs),
    );

    const logGrep = await tools.COCOS_IPC_METHODS.read_logs({ grep: 'boom', files: [projectLog, appLog] });
    const projectHits = (logGrep.data.matches || []).filter((hit) => hit.text.includes('step 3'));
    check(
        'read_logs(grep) 命中真行、且带行号（不是只回一句「找到 N 条」）',
        logGrep.ok === true && projectHits.length === 1 && projectHits[0].line === 3,
        JSON.stringify(logGrep.data.matches || []),
    );
    check(
        'read_logs(grep) 两个文件都扫（不是只看第一个）',
        new Set((logGrep.data.matches || []).map((hit) => hit.file)).size === 2,
        JSON.stringify((logGrep.data.matches || []).map((hit) => hit.file)),
    );

    const literalGrep = await tools.COCOS_IPC_METHODS.read_logs({ grep: '(', files: [projectLog] });
    check(
        '默认按子串找：grep "(" 不用转义也能命中（把 regex 关掉的意义）',
        literalGrep.ok === true && (literalGrep.data.matches || []).length === 1,
        JSON.stringify(literalGrep.data.matches || []),
    );

    const badRegex = await tools.COCOS_IPC_METHODS.read_logs({ grep: '([', regex: true, files: [projectLog] });
    check(
        '非法正则回 ok:false + 人话原因（不是抛栈）',
        badRegex.ok === false && /正则/.test(errorText(badRegex)),
        errorText(badRegex),
    );

    const sinceReply = await tools.COCOS_IPC_METHODS.read_logs({ since: '2026-10-06 06:04:49', files: [projectLog] });
    check(
        'since 按行内时间戳筛：早的行没了、晚的行还在',
        sinceReply.ok === true &&
            !sinceReply.text.includes('必须被筛掉') &&
            sinceReply.text.includes('after the error'),
        sinceReply.text.split('\n').slice(-6).join(' | '),
    );

    const needConfirm = await tools.COCOS_IPC_METHODS.read_logs({ clear: true, files: [projectLog] });
    check(
        'clear 不给 confirm 就被拒，且告诉调用方该传什么',
        needConfirm.ok === false && /confirm/.test(errorText(needConfirm)),
        errorText(needConfirm).slice(0, 200),
    );
    check(
        '被拒的 clear **没有副作用**（文件还是原样）',
        readFileSync(projectLog, 'utf8').includes('boom'),
        readFileSync(projectLog, 'utf8').slice(0, 80),
    );

    const missingFile = await tools.COCOS_IPC_METHODS.read_logs({ files: [join(logDir, 'nope.log')] });
    check(
        '显式点名的文件不存在时如实说（ok:false + 指出是哪个文件）',
        missingFile.ok === false && missingFile.text.includes('nope.log'),
        missingFile.text.split('\n').slice(0, 4).join(' | '),
    );

    const refsFromLogs = await tools.COCOS_IPC_METHODS.read_logs({ grep: 'after the error', files: [projectLog] });
    check(
        'read_logs 也走 refs 出口：日志里出现的 db:// 路径被抽出来',
        Array.isArray(refsFromLogs.data.refs) && refsFromLogs.data.refs.some((ref) => ref.value === dbUrlInLog),
        JSON.stringify(refsFromLogs.data.refs || null),
    );

    // 超大文件：只读尾部，且必须在文案里说明「行号是尾读窗口内的」
    const bigLog = join(logDir, 'big.log');
    const bigLines = [];
    for (let i = 0; i < 60_000; i += 1) bigLines.push(`[2026-10-06 07:00:00] filler ${i} ................`);
    bigLines.push('[2026-10-06 07:10:00] LAST-LINE-MARKER');
    writeFileSync(bigLog, bigLines.join('\n'), 'utf8');
    const bigReply = await tools.COCOS_IPC_METHODS.read_logs({ files: [bigLog], tail: 3 });
    check(
        '超大日志只读尾部：能拿到最后一行，且文案注明「已尾读」',
        bigReply.ok === true && bigReply.text.includes('LAST-LINE-MARKER') && bigReply.text.includes('已尾读'),
        bigReply.text.split('\n').slice(-5).join(' | '),
    );

    const cleared = await tools.COCOS_IPC_METHODS.read_logs({ clear: true, confirm: 'clear', files: [projectLog] });
    check(
        'clear + confirm 真清空（截断成 0 字节，不删文件）',
        cleared.ok === true && existsSync(projectLog) && readFileSync(projectLog, 'utf8') === '',
        `${cleared.text.split('\n')[0]} / 现存 ${existsSync(projectLog)} / ${readFileSync(projectLog, 'utf8').length} 字节`,
    );

    // ── refs 出口（每个方法都过 `withRefs`）────────────────────────────────
    const serialize = require(join(EXT_ROOT, 'dist', 'core', 'serialize.js'));
    const REF_UUID = '11111111-2222-3333-4444-555555555555';
    const refsSample = serialize.collectRefs({
        node: `[Node name=card uuid=${REF_UUID}]`,
        frame: 'db://assets/resources/textures/common/white_4x4.png',
        sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@f9941',
        sameAgain: REF_UUID,
        // 压缩型 uuid（22 个 base64 字符）：刻意**不抽** —— 任意长单词都会命中，抽出来就是噪声
        noise: 'aBcDeFgHiJkLmNoPqRsTuV',
    });
    check(
        'refs 抽全形 uuid / db:// 路径 / 子资源 uuid@xxxx，且按出现顺序去重',
        refsSample.refs.length === 3 && refsSample.total === 3 && refsSample.refs[0].value === REF_UUID,
        JSON.stringify(refsSample.refs),
    );
    check(
        'refs 不抽压缩型 uuid（噪声控制）',
        !refsSample.refs.some((ref) => ref.value === 'aBcDeFgHiJkLmNoPqRsTuV'),
        JSON.stringify(refsSample.refs.map((ref) => ref.value)),
    );
    check('refs 为空时不产出空壳文案', serialize.formatRefs(serialize.collectRefs({ a: 1 })) === '');

    const refsReply = await tools.COCOS_IPC_METHODS.execute_code({
        context: 'editor',
        code: `return { uuid: '${REF_UUID}', url: 'db://assets/whatever/x.png' };`,
    });
    check(
        'execute_code 的文案结尾带上 refs 段（模型只读 text）',
        refsReply.ok === true && refsReply.text.includes('--- refs（') && refsReply.text.includes(REF_UUID),
        refsReply.text.split('\n').slice(-4).join(' | '),
    );
    check(
        'refs 同时进了结构化结果（面板/留档用）',
        Array.isArray(refsReply.data.refs) && refsReply.data.refs.length === 2,
        JSON.stringify(refsReply.data.refs || null),
    );
    const noRefsReply = await tools.COCOS_IPC_METHODS.execute_code({ context: 'editor', code: 'return 1 + 2;' });
    check(
        '没有可复用标识时不加 refs（不留空壳字段、不改文案）',
        noRefsReply.ok === true && !noRefsReply.text.includes('--- refs（') && noRefsReply.data.refs === undefined,
        noRefsReply.text.slice(-40),
    );

    // ---------------------------------------------------------------------
    console.log('\n[9] 点按 / 按键 / 运行态（真发事件 + 真问编辑器）');
    // ---------------------------------------------------------------------
    /**
     * 这一节验的是「让 agent 自己验收界面」那三件（`click_node` / `send_keys` / `runtime`）。
     *
     * 两件必须钉住的事：
     * ① **发出去的到底是什么** —— 假 webContents 把每次 `sendInputEvent` 的入参原样记下来，
     *    断言逐字比对（坐标 / 按键 / 连击 / 修饰键），而不是"调用没报错就算过"；
     * ② **不该发的时候一个都不发** —— 运行态按节点点会被拒、参数写错会被拒，
     *    这些路径必须**零副作用**（假页上的事件数不变）。
     */
    /**
     * ⚠ 先把 [6b] 收尾时拆掉的那套现场**重新装上**（那边 `delete global.window` /
     * `delete globalThis.cce` / `cc.director.__scene = null` 是刻意的：后面的节不该依赖它）。
     * 不重装的话这里会退化成"节点找不到"，而那种红看着像被测代码坏了、其实只是夹具没了。
     */
    global.window = { location: { href: PAGE_HREF }, innerWidth: 600, innerHeight: 400, devicePixelRatio: 2 };
    /**
     * 场景页上真实存在的 `cce` 单例（编辑器场景页就有）——**含 `SceneFacadeManager`**：
     * 少了它，「现在是什么模式」这条就无从谈起（真编辑器里它一直在，只是模式会变）。
     */
    const generalFacade = { getCurrentFacade: () => ({ modeName: 'general' }), queryMode: () => 'general' };
    const previewFacade = { getCurrentFacade: () => ({ modeName: 'preview' }), queryMode: () => 'preview' };
    globalThis.cce = { Camera: stage.manager, SceneFacadeManager: generalFacade };
    cc.director.__scene = fakeScene;
    stage.reset();
    view.alwaysBlank = false;
    view.imageSize = { width: 600, height: 400 };
    view.inputEvents.length = 0;
    fakeElectron.windowFocused = true;
    fakeElectron.focusCalls = 0;
    state.previewReject = false;
    state.previewCalls.length = 0;
    state.playCalls.length = 0;
    state.sceneMode = 'general';

    // ---- 9a. 点节点：坐标 = 场景侧算出的 CSS 矩形中心 ----
    const clickNode = await tools.COCOS_IPC_METHODS.click_node({ node: 'card-uuid' });
    check(
        '点节点：坐标 = 场景侧算出的 CSS 矩形中心（card 矩形 (300,150,100,50) → 中心 (350,175)）',
        clickNode.ok === true && clickNode.data.point.x === 350 && clickNode.data.point.y === 175,
        clickNode.text ? clickNode.text.slice(0, 400) : clickNode.data,
    );
    check(
        '真发出去的是三条事件：mouseMove → mouseDown → mouseUp（坐标逐字一致、都是左键）',
        JSON.stringify(view.inputEvents.map((event) => [event.type, event.x, event.y, event.button])) ===
            JSON.stringify([
                ['mouseMove', 350, 175, undefined],
                ['mouseDown', 350, 175, 'left'],
                ['mouseUp', 350, 175, 'left'],
            ]),
        view.inputEvents,
    );
    check(
        '回执里带**真发出去的那几条**（events 与假页收到的一致）',
        Array.isArray(clickNode.data.events) &&
            clickNode.data.events.length === 3 &&
            clickNode.data.events[1].type === 'mouseDown' &&
            clickNode.data.events[1].clickCount === 1,
        clickNode.data.events,
    );
    check(
        'probe：点之前问了一次 `pick`（编辑态才有），回执里带着它自己的判词',
        clickNode.data.probe && typeof clickNode.data.probe.verdict === 'string',
        clickNode.data.probe,
    );
    check(
        '窗口焦点如实报（有焦点时不提前台、也不说"可能没送达"）',
        clickNode.data.window && clickNode.data.window.focused === true && clickNode.data.window.focusedByUs === false && fakeElectron.focusCalls === 0,
        { window: clickNode.data.window, focusCalls: fakeElectron.focusCalls },
    );

    // ---- 9b. 窗口没焦点：必须提前台并如实记，别给一个"看着成功了" ----
    fakeElectron.windowFocused = false;
    view.inputEvents.length = 0;
    const focusClick = await tools.COCOS_IPC_METHODS.click_node({ node: 'card-uuid' });
    check(
        '窗口没焦点时：自动提到前台、回执记 focusedByUs:true（否则这一下可能根本没送达）',
        focusClick.data.window.focused === true && focusClick.data.window.focusedByUs === true && fakeElectron.focusCalls === 1,
        { window: focusClick.data.window, focusCalls: fakeElectron.focusCalls },
    );
    fakeElectron.windowFocused = false;
    view.inputEvents.length = 0;
    const noFocusClick = await tools.COCOS_IPC_METHODS.click_node({ node: 'card-uuid', focusWindow: false });
    check(
        '关掉自动提前台后仍没焦点 → 回执**直说**「可能没被送达」（不假装成功）',
        noFocusClick.data.window.focused === false &&
            /没被送达/.test(String(noFocusClick.data.window.note)) &&
            /没被送达/.test(String(noFocusClick.data.hint)),
        { window: noFocusClick.data.window, hint: noFocusClick.data.hint },
    );
    fakeElectron.windowFocused = true;

    // ---- 9c. 坐标给法：view / uv ----
    view.inputEvents.length = 0;
    const uvClick = await tools.COCOS_IPC_METHODS.click_node({ x: 0.25, y: 0.5, space: 'uv' });
    check(
        'space:"uv" 按页面尺寸折算（0.25×600=150、0.5×400=200）—— 截图缩过就用它',
        uvClick.ok === true && uvClick.data.point.x === 150 && uvClick.data.point.y === 200 && uvClick.data.point.space === 'view',
        uvClick.data && uvClick.data.point,
    );
    check(
        'uv 那条也真发出去了（mouseDown 落在 (150,200)）',
        view.inputEvents.some((event) => event.type === 'mouseDown' && event.x === 150 && event.y === 200),
        view.inputEvents,
    );

    view.inputEvents.length = 0;
    const dblClick = await tools.COCOS_IPC_METHODS.click_node({ x: 10, y: 20, button: 'right', clickCount: 2, modifiers: ['ctrl', 'Shift'] });
    check(
        '双击 + 右键 + 修饰键：连击第二次带 clickCount:2，且 `ctrl`/`Shift` 被归一成 control/shift',
        JSON.stringify(view.inputEvents.filter((event) => event.type === 'mouseDown')) ===
            JSON.stringify([
                { type: 'mouseDown', x: 10, y: 20, button: 'right', clickCount: 1, modifiers: ['control', 'shift'] },
                { type: 'mouseDown', x: 10, y: 20, button: 'right', clickCount: 2, modifiers: ['control', 'shift'] },
            ]),
        view.inputEvents,
    );

    // ---- 9d. 运行态：按节点点**必须被拒**（那种投影在那一刻不成立）----
    /**
     * ⚠ **这个开关是 `PreviewPlay._state`，不是 facade**（2026-11 真机验收的结论）：
     * 真机上预览**跑着**的时候 `facadeMode` / `queryMode` **仍然是 `general`**，所以
     * 下面这一组刻意把 facade 留在 `general` —— 判据要是写回 facade，这条拒绝就**永远不触发**。
     */
    state.previewPlay._state = 'play';
    globalThis.cce = {
        ...(globalThis.cce || {}),
        SceneFacadeManager: generalFacade,
        PreviewPlay: state.previewPlay,
    };
    view.inputEvents.length = 0;
    const runningClick = await tools.COCOS_IPC_METHODS.click_node({ node: 'card-uuid' });
    check(
        '运行态按节点点：**被拒**（ok:false + 说清"那一刻的投影不成立" + 给出两条可用路）',
        runningClick.ok === false &&
            /运行态/.test(errorText(runningClick)) &&
            /工具栏上按停止/.test(errorText(runningClick)) &&
            /space:"uv"/.test(errorText(runningClick)),
        errorText(runningClick).slice(0, 200),
    );
    check(
        '而且判据是 `_state` —— facade 那两条当时**仍写着 general**（真机实测的样子）',
        runningClick.data.mode.actual === 'preview' && runningClick.data.mode.sources.facadeMode === 'general',
        runningClick.data.mode,
    );
    check('被拒时**一个事件都没发**（不是"发完再说不行"）', view.inputEvents.length === 0, view.inputEvents);

    view.inputEvents.length = 0;
    const runningUvClick = await tools.COCOS_IPC_METHODS.click_node({ x: 0.5, y: 0.5, space: 'uv' });
    check(
        '运行态给坐标**照常能点**（这正是运行态唯一可用的给法）',
        runningUvClick.ok === true &&
            runningUvClick.data.mode.running === true &&
            view.inputEvents.some((event) => event.type === 'mouseDown' && event.x === 300 && event.y === 200),
        { point: runningUvClick.data.point, events: view.inputEvents.length },
    );
    check(
        '运行态下 probe 明确写「跳过」（pick 用的也是编辑器相机，同样不成立）',
        runningUvClick.data.probe !== null &&
            /运行态/.test(String(runningUvClick.data.probe.skipped || '')) &&
            runningClick.data.mode.running === true,
        { probe: runningUvClick.data.probe },
    );

    // ---- 9e. 抓图在运行态下的两条硬后果 ----
    const runningShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-running.png'), maxWidth: 4096 });
    check(
        '运行态抓图：`mode.actual` 如实报 preview（`view:"game"` 要的正是它）',
        runningShot.ok === true && runningShot.data.mode.actual === 'preview' && runningShot.data.mode.running === true,
        runningShot.data && runningShot.data.mode,
    );
    check(
        '判据摆在回执里：`mode.sources.previewState`（`_state` 原值）+ `mode.paused` + 帧计数',
        runningShot.data.mode.sources.previewState === 'play' &&
            runningShot.data.mode.paused === false &&
            typeof runningShot.data.mode.sources.totalFrames === 'number',
        runningShot.data.mode,
    );

    // 冻住态：`_state='pause'` → `paused:true`（真机实测这个标志与帧计数一致）
    state.previewPlay._state = 'pause';
    const pausedShot = await engine.captureView({ savePath: join(FAKE_PROJECT, 'shot-paused.png'), maxWidth: 4096 });
    check(
        '冻住态：`_state="pause"` → `running:true` + `paused:true`（画面还是游戏，只是不走了）',
        pausedShot.data.mode.actual === 'preview' && pausedShot.data.mode.running === true && pausedShot.data.mode.paused === true,
        pausedShot.data.mode,
    );
    state.previewPlay._state = 'play';
    view.lastImage.__calls.length = 0;
    const runningNodeShot = await engine.captureView({ node: 'card-uuid', savePath: join(FAKE_PROJECT, 'shot-running-node.png'), maxWidth: 4096 });
    check(
        '运行态**不按节点裁图**（矩形是编辑器相机投的，按它裁会错位）—— 退回整张 + 说清为什么',
        runningNodeShot.data.target.crop === null &&
            /运行态/.test(String(runningNodeShot.data.note)) &&
            view.lastImage.__calls.filter((call) => call.kind === 'crop').length === 0 &&
            readFileSync(join(FAKE_PROJECT, 'shot-running-node.png'), 'utf8') === 'PNG 600x400',
        { note: runningNodeShot.data.note, file: readFileSync(join(FAKE_PROJECT, 'shot-running-node.png'), 'utf8') },
    );
    const gameShot = await engine.captureView({ view: 'game', savePath: join(FAKE_PROJECT, 'shot-game.png'), maxWidth: 4096 });
    check(
        '`view:"game"` 要的东西拿到了 → **不加**"要的和拿的不一致"那句（`mode.note` 空）',
        gameShot.ok === true && gameShot.data.mode.requested === 'game' && gameShot.data.mode.note === undefined,
        gameShot.data && gameShot.data.mode,
    );
    check(
        '但运行态下 `fit` 那句说明仍在（落在 `framing.note` / `data.note`，说的是"取景被忽略"而不是"拿错画面"）',
        /不取景/.test(String(gameShot.data.framing.note || '')) &&
            /不取景/.test(String(gameShot.data.note || '')) &&
            gameShot.data.framing.requested === 'none',
        { note: gameShot.data.note, framing: gameShot.data.framing },
    );
    const sceneWantedShot = await engine.captureView({ view: 'scene', savePath: join(FAKE_PROJECT, 'shot-scene-want.png'), maxWidth: 4096 });
    check(
        '运行态下要 `view:"scene"` → **明说这张图是游戏画面**（不假装成功，且给的是"人自己按停止"这条真路）',
        sceneWantedShot.ok === true && /游戏画面/.test(String(sceneWantedShot.data.note)) && /工具栏/.test(String(sceneWantedShot.data.note)),
        sceneWantedShot.data && sceneWantedShot.data.note,
    );

    // 回到编辑态（后面几组按"编辑态"验）
    globalThis.cce = { Camera: stage.manager, SceneFacadeManager: generalFacade };
    const editShot = await engine.captureView({ node: 'card-uuid', savePath: join(FAKE_PROJECT, 'shot-edit-again.png'), maxWidth: 4096 });
    check(
        '回到编辑态：节点裁图照旧（(300,150,100,50)）—— 运行态那条限制没有误伤编辑态',
        editShot.ok === true &&
            editShot.data.mode.actual === 'general' &&
            readFileSync(join(FAKE_PROJECT, 'shot-edit-again.png'), 'utf8') === 'PNG 100x50',
        { mode: editShot.data.mode, file: readFileSync(join(FAKE_PROJECT, 'shot-edit-again.png'), 'utf8') },
    );

    // ---- 9f. 按键 ----
    view.inputEvents.length = 0;
    const keys = await tools.COCOS_IPC_METHODS.send_keys({ key: 'Escape' });
    check(
        '按一下键：keyDown → keyUp（keyCode 原样用 Electron 加速键名）',
        keys.ok === true &&
            JSON.stringify(view.inputEvents.map((event) => [event.type, event.keyCode])) ===
                JSON.stringify([
                    ['keyDown', 'Escape'],
                    ['keyUp', 'Escape'],
                ]),
        view.inputEvents,
    );
    view.inputEvents.length = 0;
    const typing = await tools.COCOS_IPC_METHODS.send_keys({ text: 'ab', modifiers: ['meta'] });
    check(
        '输入文字：逐字发 `char`（不是 keyDown），修饰键只跟着 keyUp/keyDown 那条走',
        typing.ok === true &&
            JSON.stringify(view.inputEvents.map((event) => [event.type, event.keyCode, event.modifiers])) ===
                JSON.stringify([
                    ['char', 'a', undefined],
                    ['char', 'b', undefined],
                ]),
        view.inputEvents,
    );
    const tooLong = await tools.COCOS_IPC_METHODS.send_keys({ text: 'x'.repeat(201) });
    check(
        'text 超过上限被拒（挡住"把一整份日志打进去"），且**一个字都没发**',
        tooLong.ok === false && /200/.test(errorText(tooLong)) && view.inputEvents.length === 2,
        errorText(tooLong).slice(0, 120),
    );
    const badModifier = await tools.COCOS_IPC_METHODS.send_keys({ key: 'A', modifiers: ['hyper'] });
    check('拼错的修饰键被拒（不静默丢掉 —— 否则"我明明发了 ctrl"会变成假话）', badModifier.ok === false, errorText(badModifier).slice(0, 120));
    const noKey = await tools.COCOS_IPC_METHODS.send_keys({});
    check('key 与 text 都不给 → 报错且不发事件', noKey.ok === false && view.inputEvents.length === 2, errorText(noKey).slice(0, 120));

    // 页面没有键盘焦点时如实报（**本工具不抢网页内焦点**）
    view.focused = false;
    const unfocusedKeys = await tools.COCOS_IPC_METHODS.send_keys({ text: 'x' });
    check(
        '网页没有键盘焦点时如实报 `focused:false` + 提示"先点一下那个输入框"',
        unfocusedKeys.data.focused === false && /焦点/.test(String(unfocusedKeys.data.hint)),
        { focused: unfocusedKeys.data.focused, hint: unfocusedKeys.data.hint },
    );
    view.focused = true;

    // ---- 9g. 运行态：**只读**（开关已于 2026-10-08 撤掉，这一节钉住"撤干净了"）----
    /**
     * ⚠ 这一节在 2026-10-08 之后**变了性质**：原来验的是「直调优先 / 消息兜底」那套开关逻辑，
     * 现在验的是**那些开关真的没有入口了** —— 场景面板黑屏/画面停住两次现场都在同一条时间线上
     * （`docs/冻结诊断.md`），撤掉之后的判据是：
     *
     * ① `state` 照旧把两条独立来源摆出来（只读，一条消息都不发、一次直调都没有）；
     * ② 五个改状态的动作**全部被拒**，而且**零副作用**（不发消息、不碰 `cce.PreviewPlay`）；
     * ③ 拒的文案要说清**为什么**撤（不是"参数错了"那种让人再试一次的错）。
     */
    state.sceneMode = 'general';
    globalThis.cce = { ...(globalThis.cce || {}), SceneFacadeManager: generalFacade, PreviewPlay: state.previewPlay };
    state.previewPlay._state = 'stop';
    state.previewPlay.calls.length = 0;
    state.sentMessages.length = 0;
    state.playCalls.length = 0;
    state.previewCalls.length = 0;

    const runtimeState = await tools.COCOS_IPC_METHODS.runtime({ action: 'state' });
    check(
        'runtime(state)：两条独立来源都摆出来（编辑器消息 + 场景进程 cce 单例）',
        runtimeState.ok === true &&
            runtimeState.data.editorMessage.message === 'query-scene-mode' &&
            runtimeState.data.editorMessage.mode === 'general' &&
            runtimeState.data.scene &&
            runtimeState.data.scene.mode === 'general' &&
            runtimeState.data.scene.running === false,
        { editorMessage: runtimeState.data.editorMessage, scene: runtimeState.data.scene },
    );
    check(
        'runtime(state) 只读：**一条消息都没发、一次直调都没有**，且回执里 `readOnly:true` 明写',
        state.sentMessages.length === 0 && state.previewPlay.calls.length === 0 && runtimeState.data.readOnly === true,
        { sentMessages: state.sentMessages, directCalls: state.previewPlay.calls, readOnly: runtimeState.data.readOnly },
    );

    /**
     * ②③ 五个改状态的动作**全被拒**：判据三件 —— `ok:false`、**零副作用**、文案里点名"为什么撤"。
     * 用循环逐个 action 验，别只验一个（漏一个就等于留了一个后门）。
     */
    for (const action of ['play', 'stop', 'pause', 'resume', 'step']) {
        state.sentMessages.length = 0;
        state.previewPlay.calls.length = 0;
        state.directBehavior = 'ok';
        state.messageRoute = 'works';
        const refused = await tools.COCOS_IPC_METHODS.runtime({ action, waitMs: 0 });
        check(
            `runtime(${action}) 已被拒（ok:false + 零副作用：不发消息、不碰 cce.PreviewPlay）`,
            refused.ok === false &&
                state.sentMessages.length === 0 &&
                state.previewPlay.calls.length === 0,
            { error: errorText(refused).slice(0, 120), sentMessages: state.sentMessages, directCalls: state.previewPlay.calls },
        );
        check(
            `runtime(${action}) 的拒绝文案说清**为什么撤**（点名黑屏/冻结诊断，而不是"参数错了"）`,
            /撤掉/.test(errorText(refused)) && /黑屏/.test(errorText(refused)) && /冻结诊断/.test(errorText(refused)),
            errorText(refused).slice(0, 240),
        );
    }

    /**
     * 用户自己按了工具栏播放键之后，`state` 必须**照样如实报**（本工具只是不能开，不是不能看）。
     */
    state.previewPlay._state = 'play';
    const userPlayed = await tools.COCOS_IPC_METHODS.runtime({ action: 'state' });
    check(
        '用户自己开了预览时：`state` 照旧如实报 `running:true` + `previewState:"play"`（只读不等于看不见）',
        userPlayed.ok === true &&
            userPlayed.data.scene.running === true &&
            userPlayed.data.before.previewState === 'play' &&
            state.previewPlay.calls.length === 0,
        { scene: userPlayed.data.scene, before: userPlayed.data.before },
    );
    state.previewPlay._state = 'stop';

    /**
     * ⑥ `_state` 读不到时**不许猜**：回退到 facade，并且 `note` 必须说出来。
     * （真机上 facade 判不出运行态 —— 这条 note 就是"我知道我不准"。）
     */
    state.sceneMode = 'preview';
    globalThis.cce = { ...(globalThis.cce || {}), SceneFacadeManager: previewFacade, PreviewPlay: undefined };
    const noState = await tools.COCOS_IPC_METHODS.runtime({ action: 'state' });
    check(
        '拿不到 `_state` 时：回退到 facade，但 `note` 明说"这条判据不可信"（不安静地猜）',
        noState.ok === true &&
            noState.data.scene.running === true &&
            /cce\.PreviewPlay/.test(String(noState.data.scene.note || '')) &&
            /判不出/.test(String(noState.data.scene.note || '')),
        noState.data.scene,
    );
    globalThis.cce = { ...(globalThis.cce || {}), SceneFacadeManager: generalFacade, PreviewPlay: state.previewPlay };

    // `query-scene-mode` 这条消息不通 ≠ 不在运行态：两条来源各报各的
    state.sceneModeError = true;
    const noMessage = await tools.COCOS_IPC_METHODS.runtime({ action: 'state' });
    check(
        '`query-scene-mode` 抛错时：如实记原文，**另一条来源照样用**（消息不通 ≠ 状态未知）',
        noMessage.ok === true &&
            noMessage.data.editorMessage.ok === false &&
            /Message does not exist/.test(String(noMessage.data.editorMessage.error)) &&
            noMessage.data.scene.mode === 'general',
        { editorMessage: noMessage.data.editorMessage, scene: noMessage.data.scene },
    );
    state.sceneModeError = false;

    const badAction = await tools.COCOS_IPC_METHODS.runtime({ action: 'timeScale' });
    check(
        'runtime 只认 `state`（`timeScale` 同样被拒）—— 引擎里本来就没有全局倍率这个旋钮，不给"看着像能用"的名字',
        badAction.ok === false && /只认/.test(errorText(badAction)) && /state/.test(errorText(badAction)),
        errorText(badAction).slice(0, 140),
    );


    // ---- 9h. 参数校验：错的值一律**拒绝**，绝不"猜一个" ----
    view.inputEvents.length = 0;
    for (const [label, params, needle] of [
        ['node 与 x/y 同时给', { node: 'card-uuid', x: 1, y: 2 }, '只能给一个'],
        ['什么都不给', {}, '要给'],
        ['space 写错', { x: 1, y: 2, space: 'screen' }, 'space'],
        ['view 模式下坐标不是数', { x: 'a', y: 2 }, '有限数'],
        ['button 写错', { x: 1, y: 2, button: 'primary' }, 'button'],
        ['修饰键写错', { x: 1, y: 2, modifiers: ['hyper'] }, '修饰键'],
    ]) {
        const reply = await tools.COCOS_IPC_METHODS.click_node(params);
        check(
            `参数校验：${label} → 被拒且说得清`,
            reply.ok === false && errorText(reply).includes(needle),
            errorText(reply).slice(0, 120),
        );
    }
    check('参数被拒时**一个事件都没发**', view.inputEvents.length === 0, view.inputEvents);

    // 找错了页 / 没开场景：回执要带现场（否则"点不动"只能靠猜）
    const savedViews = fakeElectron.views;
    fakeElectron.views = [];
    const noPage = await tools.COCOS_IPC_METHODS.click_node({ x: 1, y: 2 });
    check(
        '找不到那一页时：ok:false + 说清"没有找到场景视图的 webContents"',
        noPage.ok === false && /webContents/.test(errorText(noPage)),
        errorText(noPage).slice(0, 140),
    );
    fakeElectron.views = savedViews;

    // 回到编辑态的现场，免得影响后面的收尾断言
    globalThis.cce = { Camera: stage.manager };

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
