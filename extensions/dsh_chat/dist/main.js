"use strict";
/**
 * 扩展主进程入口（编辑器 Node 环境）。
 *
 * 职责就三件：
 *
 * 1. **装配**：读设置、探测 node/dsh、幂等地把 `dsh-profile/` 同步到 `$DSH_HOME/profiles/cocos`；
 * 2. **托管**：持有唯一的 `DshHost`（fork DSH 子进程、接 SDK 协议、接 IPC 工具）；
 * 3. **面板消息**：面板（渲染进程）通过 `Editor.Message.request('dsh_chat', ...)` 打到这里。
 *
 * ## 关于 `load()` 的异步
 *
 * Cocos 不会 await `load()`。而读设置、写 profile 都是异步的，所以用 `readyPromise`
 * 把初始化收敛成一个可等待入口：任何对外方法先 `await ensureReady()`，
 * 面板无论多早调进来都不会读到半初始化状态（同一个套路，实测有效）。
 *
 * ## 为什么不在这里自动启动 agent
 *
 * 启动一次要加载整棵 DSH 插件树（冷启动几十秒、热启动实测 2.3 秒）。用户可能只是打开编辑器写代码，
 * 所以默认策略是「面板打开时按设置自动启动」，而不是编辑器一开就起。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const constants_1 = require("./constants");
const dsh_host_1 = require("./dsh-host");
const images_1 = require("./images");
const settings_1 = require("./settings");
/**
 * 安装器是 **CommonJS**（`scripts/install-profile.js`），这里直接 `require`。
 *
 * ⚠ **踩过的坑**：它原来是 ESM `.mjs`，用 `await import()` 加载 —— 但本扩展按
 * `module: CommonJS` 编译，**TypeScript 会把 `import()` 降级成 `require()`**，
 * 于是运行时拿 `file:///...` 的 URL 去 require，报 `Cannot find module 'file:///...'`。
 * 因为外面有 try/catch，它只变成一行 warning（症状是「profile 一直没同步，但没人知道」）。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../scripts/install-profile.js');
/** 唯一的 agent 宿主。 */
const host = new dsh_host_1.DshHost();
/** 初始化只跑一次。 */
let readyPromise = null;
/** 最近一次 profile 同步的结果（面板要显示失败原因，不能只吞进日志）。 */
let lastInstall = null;
/** 面板自检回传的最近几条（见 `methods.panelProbe`）。 */
const panelProbes = [];
/**
 * 面板轮询计数（`get-events` 的调用次数）。
 *
 * 存在的理由很具体：面板**曾经**只在 `listeners.show` 里起轮询，而那个钩子没生效 →
 * 轮询根本没跑，表现成「上一轮的回复要等下一次发送才出现」。当时从外部完全看不出来，
 * 只能靠猜。有了这个计数，「面板在不在轮询」变成一条可查的事实。
 */
const panelPoll = { count: 0, lastAt: 0 };
/** 自检只留最近几条，别把长会话跑成内存泄漏。 */
const PANEL_PROBE_LIMIT = 8;
/** 扩展根目录（`dist/main.js` 往上两级）。 */
function extensionRoot() {
    return (0, path_1.join)(__dirname, '..');
}
/**
 * 幂等地把工程里的 `dsh-profile/` 同步到 `$DSH_HOME/profiles/cocos/`。
 *
 * @returns 安装报告；失败不抛（它不该挡住整个扩展，但**必须**能被面板看见）。
 */
function syncProfile() {
    var _a, _b, _c;
    try {
        const report = installer.installProfile();
        console.log(`[dsh_chat] profile ${report.version} 已就位：${report.profileDir}` +
            (((_a = report.changes) === null || _a === void 0 ? void 0 : _a.length) ? `（${report.changes.length} 处变更）` : '（无变更）'));
        // ⚠ 别在这里写死 `ok: true`。profile 文件装好了 ≠ 这台机器能用：
        // 缺 `dsh-base` / `dsh-sdk-app` 时 profile 看起来一切正常，而模型手里 4 个工具全没了
        // （要等 initialize 超时或报"未知的编辑器方法"才发现）。所以 ok 反映的是**可用性**，
        // 并把原因写进 `error`（面板已有显示失败原因的那条路）。
        const depsOk = report.deps ? report.deps.ok : true;
        for (const line of (_b = report.warnings) !== null && _b !== void 0 ? _b : [])
            console.warn(`[dsh_chat] ⚠ ${line}`);
        lastInstall = {
            ...report,
            ok: depsOk,
            error: depsOk ? undefined : ((_c = report.warnings) !== null && _c !== void 0 ? _c : []).join(' '),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[dsh_chat] 同步 profile 失败：${message}`);
        lastInstall = { ok: false, error: message };
    }
    return lastInstall;
}
/** 初始化：读设置 → 探测运行时 → 装 profile。只跑一次。 */
function ensureReady() {
    if (!readyPromise) {
        readyPromise = (async () => {
            await (0, settings_1.loadSettings)(constants_1.EXTENSION_NAME);
            host.probeRuntime();
            syncProfile();
        })();
    }
    return readyPromise;
}
/**
 * 在 **Inspector 旁边**打开面板（打开失败则退回浮动窗口）。
 *
 * ⚠ 实测：`Editor.Panel.openBeside()` 对**已经打开**的面板返回 `false` 且什么都不做，
 * 所以「停靠」这条路必须先 `close()`（见 `dockPanel`）。
 *
 * @returns 打开结果，`action` 说明最后是停靠还是浮动。
 */
async function openBesideInspector() {
    try {
        if (await Editor.Panel.openBeside('inspector', constants_1.EXTENSION_NAME)) {
            return { ok: true, action: 'beside-inspector' };
        }
    }
    catch (error) {
        console.warn(`[dsh_chat] openBeside 失败，改用浮动窗口：${String(error)}`);
    }
    try {
        await Editor.Panel.open(constants_1.EXTENSION_NAME);
        return { ok: true, action: 'floating' };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 对外方法（必须与 package.json 的 `contributions.messages` 一一对应）。 */
exports.methods = {
    /** 打开面板（菜单项用）。已经开着就聚焦，没开就**停在 Inspector 旁边**。 */
    async openPanel() {
        try {
            if (await Editor.Panel.has(constants_1.EXTENSION_NAME)) {
                await Editor.Panel.focus(constants_1.EXTENSION_NAME);
                return { ok: true, action: 'focused' };
            }
        }
        catch {
            /* 探测失败就直接往下走去打开 */
        }
        return openBesideInspector();
    },
    /** 强制停靠到 Inspector 旁边（面板已经浮着时用：先关再在旁边开）。 */
    async dockPanel() {
        try {
            if (await Editor.Panel.has(constants_1.EXTENSION_NAME)) {
                await Editor.Panel.close(constants_1.EXTENSION_NAME);
                // 关闭到 reopen 之间给编辑器一点时间（实测不留这一下会偶发失败）
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
        catch {
            /* 关不掉也继续尝试打开 */
        }
        return openBesideInspector();
    },
    /** 启动 agent。 */
    async startAgent() {
        await ensureReady();
        return host.start();
    },
    /** 停止 agent。 */
    async stopAgent() {
        await ensureReady();
        return host.stop();
    },
    /**
     * 中断**当前这一轮**（不动 agent 进程、不动会话）。
     *
     * 与 `stopAgent` 的分工写在这里，免得面板那侧再解释一遍：
     * 「停止本轮」= 这一轮别做了（会话与上下文全留着，接着说）；
     * 「停止」= 整个 agent 进程下线（要重启，重启后自动接回上次会话）。
     */
    async interrupt() {
        await ensureReady();
        return host.interrupt();
    },
    /** 面板轮询：状态 + 设置 + 运行时路径 + 最近一次 profile 同步结果。 */
    async getState() {
        await ensureReady();
        return {
            ok: true,
            extension: { name: constants_1.EXTENSION_NAME, version: constants_1.EXTENSION_VERSION, root: extensionRoot() },
            agent: host.snapshot(),
            settings: (0, settings_1.getSettings)(),
            profile: lastInstall,
            panel: panelProbes,
            panelPoll: { count: panelPoll.count, lastAt: panelPoll.lastAt, msSinceLast: panelPoll.lastAt ? Date.now() - panelPoll.lastAt : null },
        };
    },
    /**
     * 面板自检回传（渲染进程 → 主进程）。
     *
     * 面板里的报错（选择器没解析出来、布局高度塌成 0…）以前只能靠人去编辑器控制台里看，
     * 而控制台一行行刷得很快。这里留一条通道：面板把「我看到的自己」报上来，
     * 主进程存最近几次，`get-state` 带回去，于是外部（编辑器 MCP / 日志）能直接读到。
     *
     * 只收数据、不执行任何东西：面板是渲染进程，它说的任何内容都不可信。
     */
    async panelProbe(payload) {
        const entry = {
            at: Date.now(),
            data: payload && typeof payload === 'object' ? payload : { raw: payload },
        };
        panelProbes.push(entry);
        while (panelProbes.length > PANEL_PROBE_LIMIT)
            panelProbes.shift();
        const summary = JSON.stringify(entry.data).slice(0, 400);
        console.log(`[dsh_chat] 面板自检：${summary}`);
        return { ok: true };
    },
    /** 增量拉取转写（广播丢了也能靠它追平）。 */
    async getEvents(payload) {
        var _a;
        await ensureReady();
        // 只有面板会调这个方法 —— 计数就是「面板在不在轮询」的地面真相（排查用）
        panelPoll.count += 1;
        panelPoll.lastAt = Date.now();
        const since = Number((_a = payload === null || payload === void 0 ? void 0 : payload.since) !== null && _a !== void 0 ? _a : 0);
        return { ok: true, ...host.eventsSince(Number.isFinite(since) ? since : 0) };
    },
    /** 发一条用户消息（文本 + 可选图片）。 */
    async sendMessage(payload) {
        var _a;
        await ensureReady();
        // 图片在这一层再验一遍：面板是渲染进程，它说的内容不可信（同 `panelProbe` 的口径）。
        // 校验失败**不抛**，回一句人话让面板原样显示。
        const checked = (0, images_1.validateImageBatch)(payload === null || payload === void 0 ? void 0 : payload.images);
        if (checked.ok === false)
            return { ok: false, error: checked.error };
        return host.send(String((_a = payload === null || payload === void 0 ? void 0 : payload.text) !== null && _a !== void 0 ? _a : ''), checked.images);
    },
    /**
     * 列工程里的图片（面板上那个图片选择器）。
     *
     * **主路是资源库**（`asset-db` 的 `query-assets`）：它是编辑器里用户真看得见的那份事实，
     * 还顺带给出 `db://assets/...` 这个可读 URL。**兜底是扫目录**：内置扩展的消息名字/参数
     * 随版本可能变，拿不到时至少要能选图 —— 两套结果按绝对路径去重（见 `mergeProjectImages`）。
     */
    async listImages() {
        await ensureReady();
        const projectPath = Editor.Project.path;
        let source = 'asset-db';
        let primary = [];
        try {
            const rows = await Editor.Message.request('asset-db', 'query-assets', { pattern: 'db://assets/**/*' }, ['url', 'name', 'displayName', 'uuid', 'file', 'mtime']);
            primary = (0, images_1.projectImagesFromAssetDb)(rows, projectPath);
        }
        catch (error) {
            console.warn(`[dsh_chat] 资源库查询失败，改用目录扫描：${error instanceof Error ? error.message : String(error)}`);
        }
        let fallback = [];
        if (primary.length === 0) {
            source = 'scan';
            fallback = (0, images_1.scanImageFiles)((0, path_1.join)(projectPath, 'assets'), images_1.MAX_LISTED_IMAGES).map((file) => ({
                url: `db://assets/${file.rel}`,
                path: file.path,
                name: file.name,
                bytes: file.bytes,
                rel: `assets/${file.rel}`,
                source: 'scan',
            }));
        }
        const images = (0, images_1.mergeProjectImages)(primary, fallback, images_1.MAX_LISTED_IMAGES);
        return {
            ok: true,
            source,
            projectPath,
            total: images.length,
            /** 目录扫描这条路拿不到字节数（资源库那条有），面板按需显示。 */
            images,
        };
    },
    /** 读一张工程图片（转成规范 base64 回给面板：做缩略图 + 真要发送时直接用）。 */
    async readImage(payload) {
        await ensureReady();
        const projectPath = Editor.Project.path;
        const rawUrl = typeof (payload === null || payload === void 0 ? void 0 : payload.url) === 'string' ? payload.url.trim() : '';
        const rawPath = typeof (payload === null || payload === void 0 ? void 0 : payload.path) === 'string' ? payload.path.trim() : '';
        let file = rawPath;
        if (!file && rawUrl.startsWith('db://')) {
            const mapped = (0, images_1.dbUrlToPath)(projectPath, rawUrl);
            if (!mapped)
                return { ok: false, error: `这个资源地址映射不到文件：${rawUrl}` };
            file = mapped;
        }
        if (!file)
            return { ok: false, error: 'read-image：缺少 url 或 path' };
        if (!(0, images_1.isImagePath)(file))
            return { ok: false, error: `不是认得的图片：${file}` };
        // 只允许读**工程内**的图片：面板传来的路径要当输入不可信处理（同 sendMessage 的口径）。
        const root = (0, path_1.join)(projectPath, '').replace(/[\\/]+$/, '');
        if (!file.startsWith(root)) {
            return { ok: false, error: `只能读工程目录内的图片（${root} 之外的一律拒绝）：${file}` };
        }
        const result = (0, images_1.readImageFile)(file, { projectPath });
        if (!result.ok)
            return result;
        console.log(`[dsh_chat] 读图 ${result.name}（${(0, images_1.formatBytes)(result.bytes)}）→ ${result.mimeType}`);
        return result;
    },
    /** 开新会话。 */
    async newSession() {
        await ensureReady();
        return { ok: true, ...host.newSession() };
    },
    /**
     * 列本工程的历史会话（面板右上角「历史」）。
     *
     * 直接读 DSH 的会话日志（`<DSH_HOME>/sessions/<工程键>/…`）—— **agent 没在跑时也能列**，
     * 所以「我停掉了，之前聊的还能找回来吗」这件事有答案。
     */
    async historyList(payload) {
        var _a;
        await ensureReady();
        const limit = Number((_a = payload === null || payload === void 0 ? void 0 : payload.limit) !== null && _a !== void 0 ? _a : 20);
        return { ok: true, ...(await host.historyList(Number.isFinite(limit) && limit > 0 ? Math.min(100, limit) : 20)) };
    },
    /** 把一条历史会话回放到对话区（只读；接着聊要再调 history-resume）。 */
    async historyOpen(payload) {
        var _a;
        await ensureReady();
        const sessionId = String((_a = payload === null || payload === void 0 ? void 0 : payload.sessionId) !== null && _a !== void 0 ? _a : '').trim();
        if (!sessionId)
            return { ok: false, error: 'history-open：缺少 sessionId' };
        return { ok: true, ...(await host.loadHistory(sessionId)) };
    },
    /** **接上**一条历史会话（插件 `agents.resume`）——之后的消息带着它的上下文。 */
    async historyResume(payload) {
        await ensureReady();
        const sessionId = typeof (payload === null || payload === void 0 ? void 0 : payload.sessionId) === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : undefined;
        return { ok: true, ...(await host.resumeHistory(sessionId)) };
    },
    /** 读设置。 */
    async getSettings() {
        await ensureReady();
        return { ok: true, settings: (0, settings_1.getSettings)() };
    },
    /** 改设置（改完重新探测运行时，让 node/dsh 路径立即生效）。 */
    async updateSettings(patch) {
        await ensureReady();
        const settings = await (0, settings_1.updateSettings)(constants_1.EXTENSION_NAME, patch);
        host.probeRuntime();
        return { ok: true, settings };
    },
    /** 手工修 profile（面板上的「修复 profile」按钮）。 */
    async installProfile() {
        await ensureReady();
        return syncProfile();
    },
};
/** 扩展加载时触发。不 await 异步初始化（Cocos 不等）。 */
function load() {
    console.log(`[dsh_chat] 扩展已加载 v${constants_1.EXTENSION_VERSION}`);
    void ensureReady();
}
/** 扩展卸载时触发 —— 必须把子进程收干净，否则会留下孤儿 node 进程。 */
function unload() {
    void host.dispose();
    console.log('[dsh_chat] 扩展已卸载，agent 已停止');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRzs7O0FBNFhILG9CQUdDO0FBR0Qsd0JBR0M7QUFuWUQsK0JBQTRCO0FBRTVCLDJDQUFnRTtBQUNoRSx5Q0FBcUM7QUFDckMscUNBV2tCO0FBQ2xCLHlDQUF1RTtBQWV2RTs7Ozs7OztHQU9HO0FBQ0gsOERBQThEO0FBQzlELE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQywrQkFBK0IsQ0FFeEQsQ0FBQztBQUVGLG9CQUFvQjtBQUNwQixNQUFNLElBQUksR0FBRyxJQUFJLGtCQUFPLEVBQUUsQ0FBQztBQUUzQixlQUFlO0FBQ2YsSUFBSSxZQUFZLEdBQXlCLElBQUksQ0FBQztBQUU5Qyw2Q0FBNkM7QUFDN0MsSUFBSSxXQUFXLEdBQXlCLElBQUksQ0FBQztBQUU3QywyQ0FBMkM7QUFDM0MsTUFBTSxXQUFXLEdBQXlELEVBQUUsQ0FBQztBQUU3RTs7Ozs7O0dBTUc7QUFDSCxNQUFNLFNBQVMsR0FBRyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDO0FBRTFDLDRCQUE0QjtBQUM1QixNQUFNLGlCQUFpQixHQUFHLENBQUMsQ0FBQztBQUU1QixrQ0FBa0M7QUFDbEMsU0FBUyxhQUFhO0lBQ2xCLE9BQU8sSUFBQSxXQUFJLEVBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ2pDLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBUyxXQUFXOztJQUNoQixJQUFJLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDMUMsT0FBTyxDQUFDLEdBQUcsQ0FDUCxzQkFBc0IsTUFBTSxDQUFDLE9BQU8sUUFBUSxNQUFNLENBQUMsVUFBVSxFQUFFO1lBQzNELENBQUMsQ0FBQSxNQUFBLE1BQU0sQ0FB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QVEsRUFBRSxDQUFDO0lBQ2xDLENBQUM7SUFFRCx1Q0FBdUM7SUFDdkMsS0FBSyxDQUFDLGNBQWM7UUFDaEIsTUFBTSxXQUFXLEVBQUUsQ0FBQztRQUNwQixPQUFPLFdBQVcsRUFBRSxDQUFDO0lBQ3pCLENBQUM7Q0FDSixDQUFDO0FBRUYsdUNBQXVDO0FBQ3ZDLFNBQWdCLElBQUk7SUFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsNkJBQWlCLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELEtBQUssV0FBVyxFQUFFLENBQUM7QUFDdkIsQ0FBQztBQUVELDRDQUE0QztBQUM1QyxTQUFnQixNQUFNO0lBQ2xCLEtBQUssSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO0lBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLENBQUMsQ0FBQztBQUM5QyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDmianlsZXkuLvov5vnqIvlhaXlj6PvvIjnvJbovpHlmaggTm9kZSDnjq/looPvvInjgIJcbiAqXG4gKiDogYzotKPlsLHkuInku7bvvJpcbiAqXG4gKiAxLiAqKuijhemFjSoq77ya6K+76K6+572u44CB5o6i5rWLIG5vZGUvZHNo44CB5bmC562J5Zyw5oqKIGBkc2gtcHJvZmlsZS9gIOWQjOatpeWIsCBgJERTSF9IT01FL3Byb2ZpbGVzL2NvY29zYO+8m1xuICogMi4gKirmiZjnrqEqKu+8muaMgeacieWUr+S4gOeahCBgRHNoSG9zdGDvvIhmb3JrIERTSCDlrZDov5vnqIvjgIHmjqUgU0RLIOWNj+iuruOAgeaOpSBJUEMg5bel5YW377yJ77ybXG4gKiAzLiAqKumdouadv+a2iOaBryoq77ya6Z2i5p2/77yI5riy5p+T6L+b56iL77yJ6YCa6L+HIGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdkc2hfY2hhdCcsIC4uLilgIOaJk+WIsOi/memHjOOAglxuICpcbiAqICMjIOWFs+S6jiBgbG9hZCgpYCDnmoTlvILmraVcbiAqXG4gKiBDb2NvcyDkuI3kvJogYXdhaXQgYGxvYWQoKWDjgILogIzor7vorr7nva7jgIHlhpkgcHJvZmlsZSDpg73mmK/lvILmraXnmoTvvIzmiYDku6XnlKggYHJlYWR5UHJvbWlzZWBcbiAqIOaKiuWIneWni+WMluaUtuaVm+aIkOS4gOS4quWPr+etieW+heWFpeWPo++8muS7u+S9leWvueWkluaWueazleWFiCBgYXdhaXQgZW5zdXJlUmVhZHkoKWDvvIxcbiAqIOmdouadv+aXoOiuuuWkmuaXqeiwg+i/m+adpemDveS4jeS8muivu+WIsOWNiuWIneWni+WMlueKtuaAge+8iOWQjOS4gOS4quWll+i3r++8jOWunua1i+acieaViO+8ieOAglxuICpcbiAqICMjIOS4uuS7gOS5iOS4jeWcqOi/memHjOiHquWKqOWQr+WKqCBhZ2VudFxuICpcbiAqIOWQr+WKqOS4gOasoeimgeWKoOi9veaVtOajtSBEU0gg5o+S5Lu25qCR77yI5Ya35ZCv5Yqo5Yeg5Y2B56eS44CB54Ot5ZCv5Yqo5a6e5rWLIDIuMyDnp5LvvInjgILnlKjmiLflj6/og73lj6rmmK/miZPlvIDnvJbovpHlmajlhpnku6PnoIHvvIxcbiAqIOaJgOS7pem7mOiupOetlueVpeaYr+OAjOmdouadv+aJk+W8gOaXtuaMieiuvue9ruiHquWKqOWQr+WKqOOAje+8jOiAjOS4jeaYr+e8lui+keWZqOS4gOW8gOWwsei1t+OAglxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHsgRVhURU5TSU9OX05BTUUsIEVYVEVOU0lPTl9WRVJTSU9OIH0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgRHNoSG9zdCB9IGZyb20gJy4vZHNoLWhvc3QnO1xuaW1wb3J0IHtcbiAgICBNQVhfTElTVEVEX0lNQUdFUyxcbiAgICBkYlVybFRvUGF0aCxcbiAgICBmb3JtYXRCeXRlcyxcbiAgICBpc0ltYWdlUGF0aCxcbiAgICBtZXJnZVByb2plY3RJbWFnZXMsXG4gICAgcHJvamVjdEltYWdlc0Zyb21Bc3NldERiLFxuICAgIHJlYWRJbWFnZUZpbGUsXG4gICAgc2NhbkltYWdlRmlsZXMsXG4gICAgdmFsaWRhdGVJbWFnZUJhdGNoLFxuICAgIHR5cGUgUHJvamVjdEltYWdlLFxufSBmcm9tICcuL2ltYWdlcyc7XG5pbXBvcnQgeyBnZXRTZXR0aW5ncywgbG9hZFNldHRpbmdzLCB1cGRhdGVTZXR0aW5ncyB9IGZyb20gJy4vc2V0dGluZ3MnO1xuXG4vKiog5a6J6KOF5oql5ZGK6YeM57uZ6Z2i5p2/55yL55qE5a2X5q6144CCICovXG5pbnRlcmZhY2UgSW5zdGFsbFJlcG9ydCB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgcHJvZmlsZURpcj86IHN0cmluZztcbiAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgIGNoYW5nZXM/OiBzdHJpbmdbXTtcbiAgICAvKiog6L+Q6KGM5pyf5L6d6LWW5qCh6aqMIOKAlOKAlCDnvLogYnVuZGxlIOaXtiBwcm9maWxl44CM6KOF5aW95LqG44CN5L2GIDQg5Liq5bel5YW35Lya5pW05L2T5Yqg6L295aSx6LSl44CCICovXG4gICAgZGVwcz86IHsgb2s6IGJvb2xlYW47IHJvb3Q6IHN0cmluZzsgbWlzc2luZzogc3RyaW5nW10gfTtcbiAgICAvKiog5a6J6KOF5Zmo57uZ5Ye655qE44CB5b+F6aG76K6p55So5oi355yL6KeB55qE6K2m5ZGK44CCICovXG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcbiAgICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqXG4gKiDlronoo4XlmajmmK8gKipDb21tb25KUyoq77yIYHNjcmlwdHMvaW5zdGFsbC1wcm9maWxlLmpzYO+8ie+8jOi/memHjOebtOaOpSBgcmVxdWlyZWDjgIJcbiAqXG4gKiDimqAgKirouKnov4fnmoTlnZEqKu+8muWug+WOn+adpeaYryBFU00gYC5tanNg77yM55SoIGBhd2FpdCBpbXBvcnQoKWAg5Yqg6L29IOKAlOKAlCDkvYbmnKzmianlsZXmjIlcbiAqIGBtb2R1bGU6IENvbW1vbkpTYCDnvJbor5HvvIwqKlR5cGVTY3JpcHQg5Lya5oqKIGBpbXBvcnQoKWAg6ZmN57qn5oiQIGByZXF1aXJlKClgKirvvIxcbiAqIOS6juaYr+i/kOihjOaXtuaLvyBgZmlsZTovLy8uLi5gIOeahCBVUkwg5Y67IHJlcXVpcmXvvIzmiqUgYENhbm5vdCBmaW5kIG1vZHVsZSAnZmlsZTovLy8uLi4nYOOAglxuICog5Zug5Li65aSW6Z2i5pyJIHRyeS9jYXRjaO+8jOWug+WPquWPmOaIkOS4gOihjCB3YXJuaW5n77yI55eH54q25piv44CMcHJvZmlsZSDkuIDnm7TmsqHlkIzmraXvvIzkvYbmsqHkurrnn6XpgZPjgI3vvInjgIJcbiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbmNvbnN0IGluc3RhbGxlciA9IHJlcXVpcmUoJy4uL3NjcmlwdHMvaW5zdGFsbC1wcm9maWxlLmpzJykgYXMge1xuICAgIGluc3RhbGxQcm9maWxlOiAob3B0aW9ucz86IG9iamVjdCkgPT4gSW5zdGFsbFJlcG9ydDtcbn07XG5cbi8qKiDllK/kuIDnmoQgYWdlbnQg5a6/5Li744CCICovXG5jb25zdCBob3N0ID0gbmV3IERzaEhvc3QoKTtcblxuLyoqIOWIneWni+WMluWPqui3keS4gOasoeOAgiAqL1xubGV0IHJlYWR5UHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuXG4vKiog5pyA6L+R5LiA5qyhIHByb2ZpbGUg5ZCM5q2l55qE57uT5p6c77yI6Z2i5p2/6KaB5pi+56S65aSx6LSl5Y6f5Zug77yM5LiN6IO95Y+q5ZCe6L+b5pel5b+X77yJ44CCICovXG5sZXQgbGFzdEluc3RhbGw6IEluc3RhbGxSZXBvcnQgfCBudWxsID0gbnVsbDtcblxuLyoqIOmdouadv+iHquajgOWbnuS8oOeahOacgOi/keWHoOadoe+8iOingSBgbWV0aG9kcy5wYW5lbFByb2JlYO+8ieOAgiAqL1xuY29uc3QgcGFuZWxQcm9iZXM6IEFycmF5PHsgYXQ6IG51bWJlcjsgZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfT4gPSBbXTtcblxuLyoqXG4gKiDpnaLmnb/ova7or6LorqHmlbDvvIhgZ2V0LWV2ZW50c2Ag55qE6LCD55So5qyh5pWw77yJ44CCXG4gKlxuICog5a2Y5Zyo55qE55CG55Sx5b6I5YW35L2T77ya6Z2i5p2/Kirmm77nu48qKuWPquWcqCBgbGlzdGVuZXJzLnNob3dgIOmHjOi1t+i9ruivou+8jOiAjOmCo+S4qumSqeWtkOayoeeUn+aViCDihpJcbiAqIOi9ruivouagueacrOayoei3ke+8jOihqOeOsOaIkOOAjOS4iuS4gOi9rueahOWbnuWkjeimgeetieS4i+S4gOasoeWPkemAgeaJjeWHuueOsOOAjeOAguW9k+aXtuS7juWklumDqOWujOWFqOeci+S4jeWHuuadpe+8jFxuICog5Y+q6IO96Z2g54yc44CC5pyJ5LqG6L+Z5Liq6K6h5pWw77yM44CM6Z2i5p2/5Zyo5LiN5Zyo6L2u6K+i44CN5Y+Y5oiQ5LiA5p2h5Y+v5p+l55qE5LqL5a6e44CCXG4gKi9cbmNvbnN0IHBhbmVsUG9sbCA9IHsgY291bnQ6IDAsIGxhc3RBdDogMCB9O1xuXG4vKiog6Ieq5qOA5Y+q55WZ5pyA6L+R5Yeg5p2h77yM5Yir5oqK6ZW/5Lya6K+d6LeR5oiQ5YaF5a2Y5rOE5ryP44CCICovXG5jb25zdCBQQU5FTF9QUk9CRV9MSU1JVCA9IDg7XG5cbi8qKiDmianlsZXmoLnnm67lvZXvvIhgZGlzdC9tYWluLmpzYCDlvoDkuIrkuKTnuqfvvInjgIIgKi9cbmZ1bmN0aW9uIGV4dGVuc2lvblJvb3QoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbihfX2Rpcm5hbWUsICcuLicpO1xufVxuXG4vKipcbiAqIOW5guetieWcsOaKiuW3peeoi+mHjOeahCBgZHNoLXByb2ZpbGUvYCDlkIzmraXliLAgYCREU0hfSE9NRS9wcm9maWxlcy9jb2Nvcy9g44CCXG4gKlxuICogQHJldHVybnMg5a6J6KOF5oql5ZGK77yb5aSx6LSl5LiN5oqb77yI5a6D5LiN6K+l5oyh5L2P5pW05Liq5omp5bGV77yM5L2GKirlv4XpobsqKuiDveiiq+mdouadv+eci+inge+8ieOAglxuICovXG5mdW5jdGlvbiBzeW5jUHJvZmlsZSgpOiBJbnN0YWxsUmVwb3J0IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBvcnQgPSBpbnN0YWxsZXIuaW5zdGFsbFByb2ZpbGUoKTtcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICBgW2RzaF9jaGF0XSBwcm9maWxlICR7cmVwb3J0LnZlcnNpb259IOW3suWwseS9je+8miR7cmVwb3J0LnByb2ZpbGVEaXJ9YCArXG4gICAgICAgICAgICAgICAgKHJlcG9ydC5jaGFuZ2VzPy5sZW5ndGggPyBg77yIJHtyZXBvcnQuY2hhbmdlcy5sZW5ndGh9IOWkhOWPmOabtO+8iWAgOiAn77yI5peg5Y+Y5pu077yJJyksXG4gICAgICAgICk7XG4gICAgICAgIC8vIOKaoCDliKvlnKjov5nph4zlhpnmrbsgYG9rOiB0cnVlYOOAgnByb2ZpbGUg5paH5Lu26KOF5aW95LqGIOKJoCDov5nlj7DmnLrlmajog73nlKjvvJpcbiAgICAgICAgLy8g57y6IGBkc2gtYmFzZWAgLyBgZHNoLXNkay1hcHBgIOaXtiBwcm9maWxlIOeci+i1t+adpeS4gOWIh+ato+W4uO+8jOiAjOaooeWei+aJi+mHjCA0IOS4quW3peWFt+WFqOayoeS6hlxuICAgICAgICAvLyDvvIjopoHnrYkgaW5pdGlhbGl6ZSDotoXml7bmiJbmiqVcIuacquefpeeahOe8lui+keWZqOaWueazlVwi5omN5Y+R546w77yJ44CC5omA5LulIG9rIOWPjeaYoOeahOaYryoq5Y+v55So5oCnKirvvIxcbiAgICAgICAgLy8g5bm25oqK5Y6f5Zug5YaZ6L+bIGBlcnJvcmDvvIjpnaLmnb/lt7LmnInmmL7npLrlpLHotKXljp/lm6DnmoTpgqPmnaHot6/vvInjgIJcbiAgICAgICAgY29uc3QgZGVwc09rID0gcmVwb3J0LmRlcHMgPyByZXBvcnQuZGVwcy5vayA6IHRydWU7XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiByZXBvcnQud2FybmluZ3MgPz8gW10pIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSDimqAgJHtsaW5lfWApO1xuICAgICAgICBsYXN0SW5zdGFsbCA9IHtcbiAgICAgICAgICAgIC4uLnJlcG9ydCxcbiAgICAgICAgICAgIG9rOiBkZXBzT2ssXG4gICAgICAgICAgICBlcnJvcjogZGVwc09rID8gdW5kZWZpbmVkIDogKHJlcG9ydC53YXJuaW5ncyA/PyBbXSkuam9pbignICcpLFxuICAgICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSDlkIzmraUgcHJvZmlsZSDlpLHotKXvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgIGxhc3RJbnN0YWxsID0geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH07XG4gICAgfVxuICAgIHJldHVybiBsYXN0SW5zdGFsbDtcbn1cblxuLyoqIOWIneWni+WMlu+8muivu+iuvue9riDihpIg5o6i5rWL6L+Q6KGM5pe2IOKGkiDoo4UgcHJvZmlsZeOAguWPqui3keS4gOasoeOAgiAqL1xuZnVuY3Rpb24gZW5zdXJlUmVhZHkoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFyZWFkeVByb21pc2UpIHtcbiAgICAgICAgcmVhZHlQcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IGxvYWRTZXR0aW5ncyhFWFRFTlNJT05fTkFNRSk7XG4gICAgICAgICAgICBob3N0LnByb2JlUnVudGltZSgpO1xuICAgICAgICAgICAgc3luY1Byb2ZpbGUoKTtcbiAgICAgICAgfSkoKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlYWR5UHJvbWlzZTtcbn1cblxuLyoqXG4gKiDlnKggKipJbnNwZWN0b3Ig5peB6L65KirmiZPlvIDpnaLmnb/vvIjmiZPlvIDlpLHotKXliJnpgIDlm57mta7liqjnqpflj6PvvInjgIJcbiAqXG4gKiDimqAg5a6e5rWL77yaYEVkaXRvci5QYW5lbC5vcGVuQmVzaWRlKClgIOWvuSoq5bey57uP5omT5byAKirnmoTpnaLmnb/ov5Tlm54gYGZhbHNlYCDkuJTku4DkuYjpg73kuI3lgZrvvIxcbiAqIOaJgOS7peOAjOWBnOmdoOOAjei/meadoei3r+W/hemhu+WFiCBgY2xvc2UoKWDvvIjop4EgYGRvY2tQYW5lbGDvvInjgIJcbiAqXG4gKiBAcmV0dXJucyDmiZPlvIDnu5PmnpzvvIxgYWN0aW9uYCDor7TmmI7mnIDlkI7mmK/lgZzpnaDov5jmmK/mta7liqjjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gb3BlbkJlc2lkZUluc3BlY3RvcigpOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IGFjdGlvbj86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGlmIChhd2FpdCBFZGl0b3IuUGFuZWwub3BlbkJlc2lkZSgnaW5zcGVjdG9yJywgRVhURU5TSU9OX05BTUUpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnYmVzaWRlLWluc3BlY3RvcicgfTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihgW2RzaF9jaGF0XSBvcGVuQmVzaWRlIOWksei0pe+8jOaUueeUqOa1ruWKqOeql+WPo++8miR7U3RyaW5nKGVycm9yKX1gKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLm9wZW4oRVhURU5TSU9OX05BTUUpO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnZmxvYXRpbmcnIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpIH07XG4gICAgfVxufVxuXG4vKiog5a+55aSW5pa55rOV77yI5b+F6aG75LiOIHBhY2thZ2UuanNvbiDnmoQgYGNvbnRyaWJ1dGlvbnMubWVzc2FnZXNgIOS4gOS4gOWvueW6lO+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IHsgW2tleTogc3RyaW5nXTogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnkgfSA9IHtcbiAgICAvKiog5omT5byA6Z2i5p2/77yI6I+c5Y2V6aG555So77yJ44CC5bey57uP5byA552A5bCx6IGa54Sm77yM5rKh5byA5bCxKirlgZzlnKggSW5zcGVjdG9yIOaXgei+uSoq44CCICovXG4gICAgYXN5bmMgb3BlblBhbmVsKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKGF3YWl0IEVkaXRvci5QYW5lbC5oYXMoRVhURU5TSU9OX05BTUUpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLmZvY3VzKEVYVEVOU0lPTl9OQU1FKTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnZm9jdXNlZCcgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiDmjqLmtYvlpLHotKXlsLHnm7TmjqXlvoDkuIvotbDljrvmiZPlvIAgKi9cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb3BlbkJlc2lkZUluc3BlY3RvcigpO1xuICAgIH0sXG5cbiAgICAvKiog5by65Yi25YGc6Z2g5YiwIEluc3BlY3RvciDml4HovrnvvIjpnaLmnb/lt7Lnu4/mta7nnYDml7bnlKjvvJrlhYjlhbPlho3lnKjml4HovrnlvIDvvInjgIIgKi9cbiAgICBhc3luYyBkb2NrUGFuZWwoKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoYXdhaXQgRWRpdG9yLlBhbmVsLmhhcyhFWFRFTlNJT05fTkFNRSkpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuUGFuZWwuY2xvc2UoRVhURU5TSU9OX05BTUUpO1xuICAgICAgICAgICAgICAgIC8vIOWFs+mXreWIsCByZW9wZW4g5LmL6Ze057uZ57yW6L6R5Zmo5LiA54K55pe26Ze077yI5a6e5rWL5LiN55WZ6L+Z5LiA5LiL5Lya5YG25Y+R5aSx6LSl77yJXG4gICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMjUwKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5YWz5LiN5o6J5Lmf57un57ut5bCd6K+V5omT5byAICovXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9wZW5CZXNpZGVJbnNwZWN0b3IoKTtcbiAgICB9LFxuXG4gICAgLyoqIOWQr+WKqCBhZ2VudOOAgiAqL1xuICAgIGFzeW5jIHN0YXJ0QWdlbnQoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiBob3N0LnN0YXJ0KCk7XG4gICAgfSxcblxuICAgIC8qKiDlgZzmraIgYWdlbnTjgIIgKi9cbiAgICBhc3luYyBzdG9wQWdlbnQoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiBob3N0LnN0b3AoKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5Lit5patKirlvZPliY3ov5nkuIDova4qKu+8iOS4jeWKqCBhZ2VudCDov5vnqIvjgIHkuI3liqjkvJror53vvInjgIJcbiAgICAgKlxuICAgICAqIOS4jiBgc3RvcEFnZW50YCDnmoTliIblt6XlhpnlnKjov5nph4zvvIzlhY3lvpfpnaLmnb/pgqPkvqflho3op6Pph4rkuIDpgY3vvJpcbiAgICAgKiDjgIzlgZzmraLmnKzova7jgI09IOi/meS4gOi9ruWIq+WBmuS6hu+8iOS8muivneS4juS4iuS4i+aWh+WFqOeVmeedgO+8jOaOpeedgOivtO+8ie+8m1xuICAgICAqIOOAjOWBnOatouOAjT0g5pW05LiqIGFnZW50IOi/m+eoi+S4i+e6v++8iOimgemHjeWQr++8jOmHjeWQr+WQjuiHquWKqOaOpeWbnuS4iuasoeS8muivne+8ieOAglxuICAgICAqL1xuICAgIGFzeW5jIGludGVycnVwdCgpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgcmV0dXJuIGhvc3QuaW50ZXJydXB0KCk7XG4gICAgfSxcblxuICAgIC8qKiDpnaLmnb/ova7or6LvvJrnirbmgIEgKyDorr7nva4gKyDov5DooYzml7bot6/lvoQgKyDmnIDov5HkuIDmrKEgcHJvZmlsZSDlkIzmraXnu5PmnpzjgIIgKi9cbiAgICBhc3luYyBnZXRTdGF0ZSgpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgZXh0ZW5zaW9uOiB7IG5hbWU6IEVYVEVOU0lPTl9OQU1FLCB2ZXJzaW9uOiBFWFRFTlNJT05fVkVSU0lPTiwgcm9vdDogZXh0ZW5zaW9uUm9vdCgpIH0sXG4gICAgICAgICAgICBhZ2VudDogaG9zdC5zbmFwc2hvdCgpLFxuICAgICAgICAgICAgc2V0dGluZ3M6IGdldFNldHRpbmdzKCksXG4gICAgICAgICAgICBwcm9maWxlOiBsYXN0SW5zdGFsbCxcbiAgICAgICAgICAgIHBhbmVsOiBwYW5lbFByb2JlcyxcbiAgICAgICAgICAgIHBhbmVsUG9sbDogeyBjb3VudDogcGFuZWxQb2xsLmNvdW50LCBsYXN0QXQ6IHBhbmVsUG9sbC5sYXN0QXQsIG1zU2luY2VMYXN0OiBwYW5lbFBvbGwubGFzdEF0ID8gRGF0ZS5ub3coKSAtIHBhbmVsUG9sbC5sYXN0QXQgOiBudWxsIH0sXG4gICAgICAgIH07XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOmdouadv+iHquajgOWbnuS8oO+8iOa4suafk+i/m+eoiyDihpIg5Li76L+b56iL77yJ44CCXG4gICAgICpcbiAgICAgKiDpnaLmnb/ph4znmoTmiqXplJnvvIjpgInmi6nlmajmsqHop6PmnpDlh7rmnaXjgIHluIPlsYDpq5jluqbloYzmiJAgMOKApu+8ieS7peWJjeWPquiDvemdoOS6uuWOu+e8lui+keWZqOaOp+WItuWPsOmHjOeci++8jFxuICAgICAqIOiAjOaOp+WItuWPsOS4gOihjOihjOWIt+W+l+W+iOW/q+OAgui/memHjOeVmeS4gOadoemAmumBk++8mumdouadv+aKiuOAjOaIkeeci+WIsOeahOiHquW3seOAjeaKpeS4iuadpe+8jFxuICAgICAqIOS4u+i/m+eoi+WtmOacgOi/keWHoOasoe+8jGBnZXQtc3RhdGVgIOW4puWbnuWOu++8jOS6juaYr+WklumDqO+8iOe8lui+keWZqCBNQ1AgLyDml6Xlv5fvvInog73nm7TmjqXor7vliLDjgIJcbiAgICAgKlxuICAgICAqIOWPquaUtuaVsOaNruOAgeS4jeaJp+ihjOS7u+S9leS4nOilv++8mumdouadv+aYr+a4suafk+i/m+eoi++8jOWug+ivtOeahOS7u+S9leWGheWuuemDveS4jeWPr+S/oeOAglxuICAgICAqL1xuICAgIGFzeW5jIHBhbmVsUHJvYmUocGF5bG9hZDogdW5rbm93bikge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHtcbiAgICAgICAgICAgIGF0OiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgZGF0YTogcGF5bG9hZCAmJiB0eXBlb2YgcGF5bG9hZCA9PT0gJ29iamVjdCcgPyAocGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiB7IHJhdzogcGF5bG9hZCB9LFxuICAgICAgICB9O1xuICAgICAgICBwYW5lbFByb2Jlcy5wdXNoKGVudHJ5KTtcbiAgICAgICAgd2hpbGUgKHBhbmVsUHJvYmVzLmxlbmd0aCA+IFBBTkVMX1BST0JFX0xJTUlUKSBwYW5lbFByb2Jlcy5zaGlmdCgpO1xuICAgICAgICBjb25zdCBzdW1tYXJ5ID0gSlNPTi5zdHJpbmdpZnkoZW50cnkuZGF0YSkuc2xpY2UoMCwgNDAwKTtcbiAgICAgICAgY29uc29sZS5sb2coYFtkc2hfY2hhdF0g6Z2i5p2/6Ieq5qOA77yaJHtzdW1tYXJ5fWApO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0sXG5cbiAgICAvKiog5aKe6YeP5ouJ5Y+W6L2s5YaZ77yI5bm/5pKt5Lii5LqG5Lmf6IO96Z2g5a6D6L+95bmz77yJ44CCICovXG4gICAgYXN5bmMgZ2V0RXZlbnRzKHBheWxvYWQ6IHsgc2luY2U/OiBudW1iZXIgfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICAvLyDlj6rmnInpnaLmnb/kvJrosIPov5nkuKrmlrnms5Ug4oCU4oCUIOiuoeaVsOWwseaYr+OAjOmdouadv+WcqOS4jeWcqOi9ruivouOAjeeahOWcsOmdouecn+ebuO+8iOaOkuafpeeUqO+8iVxuICAgICAgICBwYW5lbFBvbGwuY291bnQgKz0gMTtcbiAgICAgICAgcGFuZWxQb2xsLmxhc3RBdCA9IERhdGUubm93KCk7XG4gICAgICAgIGNvbnN0IHNpbmNlID0gTnVtYmVyKHBheWxvYWQ/LnNpbmNlID8/IDApO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgLi4uaG9zdC5ldmVudHNTaW5jZShOdW1iZXIuaXNGaW5pdGUoc2luY2UpID8gc2luY2UgOiAwKSB9O1xuICAgIH0sXG5cbiAgICAvKiog5Y+R5LiA5p2h55So5oi35raI5oGv77yI5paH5pysICsg5Y+v6YCJ5Zu+54mH77yJ44CCICovXG4gICAgYXN5bmMgc2VuZE1lc3NhZ2UocGF5bG9hZDogeyB0ZXh0Pzogc3RyaW5nOyBpbWFnZXM/OiB1bmtub3duIH0gfCB1bmRlZmluZWQpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgLy8g5Zu+54mH5Zyo6L+Z5LiA5bGC5YaN6aqM5LiA6YGN77ya6Z2i5p2/5piv5riy5p+T6L+b56iL77yM5a6D6K+055qE5YaF5a655LiN5Y+v5L+h77yI5ZCMIGBwYW5lbFByb2JlYCDnmoTlj6PlvoTvvInjgIJcbiAgICAgICAgLy8g5qCh6aqM5aSx6LSlKirkuI3mipsqKu+8jOWbnuS4gOWPpeS6uuivneiuqemdouadv+WOn+agt+aYvuekuuOAglxuICAgICAgICBjb25zdCBjaGVja2VkID0gdmFsaWRhdGVJbWFnZUJhdGNoKHBheWxvYWQ/LmltYWdlcyk7XG4gICAgICAgIGlmIChjaGVja2VkLm9rID09PSBmYWxzZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogY2hlY2tlZC5lcnJvciB9O1xuICAgICAgICByZXR1cm4gaG9zdC5zZW5kKFN0cmluZyhwYXlsb2FkPy50ZXh0ID8/ICcnKSwgY2hlY2tlZC5pbWFnZXMpO1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJflt6XnqIvph4znmoTlm77niYfvvIjpnaLmnb/kuIrpgqPkuKrlm77niYfpgInmi6nlmajvvInjgIJcbiAgICAgKlxuICAgICAqICoq5Li76Lev5piv6LWE5rqQ5bqTKirvvIhgYXNzZXQtZGJgIOeahCBgcXVlcnktYXNzZXRzYO+8ie+8muWug+aYr+e8lui+keWZqOmHjOeUqOaIt+ecn+eci+W+l+ingeeahOmCo+S7veS6i+Wunu+8jFxuICAgICAqIOi/mOmhuuW4pue7meWHuiBgZGI6Ly9hc3NldHMvLi4uYCDov5nkuKrlj6/or7sgVVJM44CCKirlhZzlupXmmK/miavnm67lvZUqKu+8muWGhee9ruaJqeWxleeahOa2iOaBr+WQjeWtly/lj4LmlbBcbiAgICAgKiDpmo/niYjmnKzlj6/og73lj5jvvIzmi7/kuI3liLDml7boh7PlsJHopoHog73pgInlm74g4oCU4oCUIOS4pOWll+e7k+aenOaMiee7neWvuei3r+W+hOWOu+mHje+8iOingSBgbWVyZ2VQcm9qZWN0SW1hZ2VzYO+8ieOAglxuICAgICAqL1xuICAgIGFzeW5jIGxpc3RJbWFnZXMoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHByb2plY3RQYXRoID0gRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgbGV0IHNvdXJjZTogJ2Fzc2V0LWRiJyB8ICdzY2FuJyA9ICdhc3NldC1kYic7XG4gICAgICAgIGxldCBwcmltYXJ5OiBQcm9qZWN0SW1hZ2VbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgcm93cyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcbiAgICAgICAgICAgICAgICAncXVlcnktYXNzZXRzJyxcbiAgICAgICAgICAgICAgICB7IHBhdHRlcm46ICdkYjovL2Fzc2V0cy8qKi8qJyB9LFxuICAgICAgICAgICAgICAgIFsndXJsJywgJ25hbWUnLCAnZGlzcGxheU5hbWUnLCAndXVpZCcsICdmaWxlJywgJ210aW1lJ10sXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcHJpbWFyeSA9IHByb2plY3RJbWFnZXNGcm9tQXNzZXREYihyb3dzLCBwcm9qZWN0UGF0aCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g6LWE5rqQ5bqT5p+l6K+i5aSx6LSl77yM5pS555So55uu5b2V5omr5o+P77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZmFsbGJhY2s6IFByb2plY3RJbWFnZVtdID0gW107XG4gICAgICAgIGlmIChwcmltYXJ5Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgc291cmNlID0gJ3NjYW4nO1xuICAgICAgICAgICAgZmFsbGJhY2sgPSBzY2FuSW1hZ2VGaWxlcyhqb2luKHByb2plY3RQYXRoLCAnYXNzZXRzJyksIE1BWF9MSVNURURfSU1BR0VTKS5tYXAoKGZpbGUpID0+ICh7XG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtmaWxlLnJlbH1gLFxuICAgICAgICAgICAgICAgIHBhdGg6IGZpbGUucGF0aCxcbiAgICAgICAgICAgICAgICBuYW1lOiBmaWxlLm5hbWUsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IGZpbGUuYnl0ZXMsXG4gICAgICAgICAgICAgICAgcmVsOiBgYXNzZXRzLyR7ZmlsZS5yZWx9YCxcbiAgICAgICAgICAgICAgICBzb3VyY2U6ICdzY2FuJyBhcyBjb25zdCxcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGltYWdlcyA9IG1lcmdlUHJvamVjdEltYWdlcyhwcmltYXJ5LCBmYWxsYmFjaywgTUFYX0xJU1RFRF9JTUFHRVMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBzb3VyY2UsXG4gICAgICAgICAgICBwcm9qZWN0UGF0aCxcbiAgICAgICAgICAgIHRvdGFsOiBpbWFnZXMubGVuZ3RoLFxuICAgICAgICAgICAgLyoqIOebruW9leaJq+aPj+i/meadoei3r+aLv+S4jeWIsOWtl+iKguaVsO+8iOi1hOa6kOW6k+mCo+adoeacie+8ie+8jOmdouadv+aMiemcgOaYvuekuuOAgiAqL1xuICAgICAgICAgICAgaW1hZ2VzLFxuICAgICAgICB9O1xuICAgIH0sXG5cbiAgICAvKiog6K+75LiA5byg5bel56iL5Zu+54mH77yI6L2s5oiQ6KeE6IyDIGJhc2U2NCDlm57nu5npnaLmnb/vvJrlgZrnvKnnlaXlm74gKyDnnJ/opoHlj5HpgIHml7bnm7TmjqXnlKjvvInjgIIgKi9cbiAgICBhc3luYyByZWFkSW1hZ2UocGF5bG9hZDogeyB1cmw/OiBzdHJpbmc7IHBhdGg/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IHJhd1VybCA9IHR5cGVvZiBwYXlsb2FkPy51cmwgPT09ICdzdHJpbmcnID8gcGF5bG9hZC51cmwudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IHJhd1BhdGggPSB0eXBlb2YgcGF5bG9hZD8ucGF0aCA9PT0gJ3N0cmluZycgPyBwYXlsb2FkLnBhdGgudHJpbSgpIDogJyc7XG4gICAgICAgIGxldCBmaWxlID0gcmF3UGF0aDtcbiAgICAgICAgaWYgKCFmaWxlICYmIHJhd1VybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XG4gICAgICAgICAgICBjb25zdCBtYXBwZWQgPSBkYlVybFRvUGF0aChwcm9qZWN0UGF0aCwgcmF3VXJsKTtcbiAgICAgICAgICAgIGlmICghbWFwcGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg6L+Z5Liq6LWE5rqQ5Zyw5Z2A5pig5bCE5LiN5Yiw5paH5Lu277yaJHtyYXdVcmx9YCB9O1xuICAgICAgICAgICAgZmlsZSA9IG1hcHBlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWZpbGUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdyZWFkLWltYWdl77ya57y65bCRIHVybCDmiJYgcGF0aCcgfTtcbiAgICAgICAgaWYgKCFpc0ltYWdlUGF0aChmaWxlKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOS4jeaYr+iupOW+l+eahOWbvueJh++8miR7ZmlsZX1gIH07XG5cbiAgICAgICAgLy8g5Y+q5YWB6K646K+7Kirlt6XnqIvlhoUqKueahOWbvueJh++8mumdouadv+S8oOadpeeahOi3r+W+hOimgeW9k+i+k+WFpeS4jeWPr+S/oeWkhOeQhu+8iOWQjCBzZW5kTWVzc2FnZSDnmoTlj6PlvoTvvInjgIJcbiAgICAgICAgY29uc3Qgcm9vdCA9IGpvaW4ocHJvamVjdFBhdGgsICcnKS5yZXBsYWNlKC9bXFxcXC9dKyQvLCAnJyk7XG4gICAgICAgIGlmICghZmlsZS5zdGFydHNXaXRoKHJvb3QpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5Y+q6IO96K+75bel56iL55uu5b2V5YaF55qE5Zu+54mH77yIJHtyb290fSDkuYvlpJbnmoTkuIDlvovmi5Lnu53vvInvvJoke2ZpbGV9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVhZEltYWdlRmlsZShmaWxlLCB7IHByb2plY3RQYXRoIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgY29uc29sZS5sb2coYFtkc2hfY2hhdF0g6K+75Zu+ICR7cmVzdWx0Lm5hbWV977yIJHtmb3JtYXRCeXRlcyhyZXN1bHQuYnl0ZXMpfe+8ieKGkiAke3Jlc3VsdC5taW1lVHlwZX1gKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9LFxuXG4gICAgLyoqIOW8gOaWsOS8muivneOAgiAqL1xuICAgIGFzeW5jIG5ld1Nlc3Npb24oKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCAuLi5ob3N0Lm5ld1Nlc3Npb24oKSB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJfmnKzlt6XnqIvnmoTljoblj7LkvJror53vvIjpnaLmnb/lj7PkuIrop5LjgIzljoblj7LjgI3vvInjgIJcbiAgICAgKlxuICAgICAqIOebtOaOpeivuyBEU0gg55qE5Lya6K+d5pel5b+X77yIYDxEU0hfSE9NRT4vc2Vzc2lvbnMvPOW3peeoi+mUrj4v4oCmYO+8ieKAlOKAlCAqKmFnZW50IOayoeWcqOi3keaXtuS5n+iDveWIlyoq77yMXG4gICAgICog5omA5Lul44CM5oiR5YGc5o6J5LqG77yM5LmL5YmN6IGK55qE6L+Y6IO95om+5Zue5p2l5ZCX44CN6L+Z5Lu25LqL5pyJ562U5qGI44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeUxpc3QocGF5bG9hZDogeyBsaW1pdD86IG51bWJlciB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IGxpbWl0ID0gTnVtYmVyKHBheWxvYWQ/LmxpbWl0ID8/IDIwKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIC4uLihhd2FpdCBob3N0Lmhpc3RvcnlMaXN0KE51bWJlci5pc0Zpbml0ZShsaW1pdCkgJiYgbGltaXQgPiAwID8gTWF0aC5taW4oMTAwLCBsaW1pdCkgOiAyMCkpIH07XG4gICAgfSxcblxuICAgIC8qKiDmiorkuIDmnaHljoblj7LkvJror53lm57mlL7liLDlr7nor53ljLrvvIjlj6ror7vvvJvmjqXnnYDogYropoHlho3osIMgaGlzdG9yeS1yZXN1bWXvvInjgIIgKi9cbiAgICBhc3luYyBoaXN0b3J5T3BlbihwYXlsb2FkOiB7IHNlc3Npb25JZD86IHN0cmluZyB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IFN0cmluZyhwYXlsb2FkPy5zZXNzaW9uSWQgPz8gJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFzZXNzaW9uSWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdoaXN0b3J5LW9wZW7vvJrnvLrlsJEgc2Vzc2lvbklkJyB9O1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgLi4uKGF3YWl0IGhvc3QubG9hZEhpc3Rvcnkoc2Vzc2lvbklkKSkgfTtcbiAgICB9LFxuXG4gICAgLyoqICoq5o6l5LiKKirkuIDmnaHljoblj7LkvJror53vvIjmj5Lku7YgYGFnZW50cy5yZXN1bWVg77yJ4oCU4oCU5LmL5ZCO55qE5raI5oGv5bim552A5a6D55qE5LiK5LiL5paH44CCICovXG4gICAgYXN5bmMgaGlzdG9yeVJlc3VtZShwYXlsb2FkOiB7IHNlc3Npb25JZD86IHN0cmluZyB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBwYXlsb2FkPy5zZXNzaW9uSWQgPT09ICdzdHJpbmcnICYmIHBheWxvYWQuc2Vzc2lvbklkLnRyaW0oKSA/IHBheWxvYWQuc2Vzc2lvbklkLnRyaW0oKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIC4uLihhd2FpdCBob3N0LnJlc3VtZUhpc3Rvcnkoc2Vzc2lvbklkKSkgfTtcbiAgICB9LFxuXG4gICAgLyoqIOivu+iuvue9ruOAgiAqL1xuICAgIGFzeW5jIGdldFNldHRpbmdzKCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IGdldFNldHRpbmdzKCkgfTtcbiAgICB9LFxuXG4gICAgLyoqIOaUueiuvue9ru+8iOaUueWujOmHjeaWsOaOoua1i+i/kOihjOaXtu+8jOiuqSBub2RlL2RzaCDot6/lvoTnq4vljbPnlJ/mlYjvvInjgIIgKi9cbiAgICBhc3luYyB1cGRhdGVTZXR0aW5ncyhwYXRjaDogdW5rbm93bikge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IHVwZGF0ZVNldHRpbmdzKEVYVEVOU0lPTl9OQU1FLCBwYXRjaCk7XG4gICAgICAgIGhvc3QucHJvYmVSdW50aW1lKCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXR0aW5ncyB9O1xuICAgIH0sXG5cbiAgICAvKiog5omL5bel5L+uIHByb2ZpbGXvvIjpnaLmnb/kuIrnmoTjgIzkv67lpI0gcHJvZmlsZeOAjeaMiemSru+8ieOAgiAqL1xuICAgIGFzeW5jIGluc3RhbGxQcm9maWxlKCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gc3luY1Byb2ZpbGUoKTtcbiAgICB9LFxufTtcblxuLyoqIOaJqeWxleWKoOi9veaXtuinpuWPkeOAguS4jSBhd2FpdCDlvILmraXliJ3lp4vljJbvvIhDb2NvcyDkuI3nrYnvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge1xuICAgIGNvbnNvbGUubG9nKGBbZHNoX2NoYXRdIOaJqeWxleW3suWKoOi9vSB2JHtFWFRFTlNJT05fVkVSU0lPTn1gKTtcbiAgICB2b2lkIGVuc3VyZVJlYWR5KCk7XG59XG5cbi8qKiDmianlsZXljbjovb3ml7bop6blj5Eg4oCU4oCUIOW/hemhu+aKiuWtkOi/m+eoi+aUtuW5suWHgO+8jOWQpuWImeS8mueVmeS4i+WtpOWEvyBub2RlIOi/m+eoi+OAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcbiAgICB2b2lkIGhvc3QuZGlzcG9zZSgpO1xuICAgIGNvbnNvbGUubG9nKCdbZHNoX2NoYXRdIOaJqeWxleW3suWNuOi9ve+8jGFnZW50IOW3suWBnOatoicpO1xufVxuIl19