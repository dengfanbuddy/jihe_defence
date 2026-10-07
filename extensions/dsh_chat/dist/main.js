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
 * 把一个「面板传来的数字」收进 `[min, max]`（不是数字就退回默认值）。
 *
 * 面板是**输入**而不是自己人（同 `sendMessage`/`readImage` 的口径）：谁都能
 * `Editor.Message.request('dsh_chat', ...)`，所以预算这类东西必须在这一层夹死，
 * 不能让一份 `budgetMs: 600000` 把磁盘扫穿。
 *
 * @param value - 面板给的值。
 * @param min - 下限。
 * @param max - 上限。
 * @param fallback - 不是数字时用谁。
 * @returns 夹好的整数。
 */
function clampNumber(value, min, max, fallback) {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, number));
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
        // 同一条事实还有个用途：交互（提问/授权）到达时判断「有没有人能回答」。
        // 面板不在就立刻放行，别让模型干等 —— 见 DshHost.gateInteraction 的注释。
        host.notePanelActivity();
        const since = Number((_a = payload === null || payload === void 0 ? void 0 : payload.since) !== null && _a !== void 0 ? _a : 0);
        return { ok: true, ...host.eventsSince(Number.isFinite(since) ? since : 0) };
    },
    /**
     * 回答一次「需要人拍板」的交互（面板上那块对话框：模型提问 / 授权请求 / 计划评审）。
     *
     * 形状校验在 `DshHost.answerInteraction` 里（面板是渲染进程，它说的不可信）；
     * 失败**不抛**，回一句人话让面板原样显示（同 `sendMessage` 的口径）。
     */
    async interactionAnswer(payload) {
        await ensureReady();
        return host.answerInteraction(payload);
    },
    /**
     * 列这个 agent 能用的斜杠命令（面板输入 `/` 时弹的那张表）。
     *
     * 命令全在宿主里（`/compact` `/plan` `/goal` `/feedback` …），SDK 协议没有这一层，
     * 所以走插件控制帧。失败**不抛**，回 `{ok:false, error}` 让面板当一条提示显示。
     */
    async commandList() {
        await ensureReady();
        return host.commandList();
    },
    /** 执行一条斜杠命令行（结果不进模型历史；面板只在失败时额外提示一句）。 */
    async commandRun(payload) {
        await ensureReady();
        return host.runCommand(payload === null || payload === void 0 ? void 0 : payload.line);
    },
    /** 列 `@路径` 候选（面板的 `@` 补全；边打字边问，所以这条路要便宜）。 */
    async fileReference(payload) {
        await ensureReady();
        return host.fileReference(payload === null || payload === void 0 ? void 0 : payload.query);
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
    /**
     * 在**所有**历史会话里做全文搜索（面板历史抽屉里的「搜全文」）。
     *
     * 预算是**面板传上来的**（面板知道自己在等多久），这一层只做上限收敛：
     * 谁都能调 `Editor.Message.request`，不能让它拿着一份 `--max-sessions=100000` 把
     * 磁盘扫穿。上限的取法照抄脚本的默认值再放宽一档。
     */
    async historySearch(payload) {
        await ensureReady();
        const query = typeof (payload === null || payload === void 0 ? void 0 : payload.query) === 'string' ? payload.query.trim() : '';
        if (!query)
            return { ok: false, error: 'history-search：搜索词是空的' };
        if (query.length > 200)
            return { ok: false, error: 'history-search：搜索词太长了（最多 200 字）' };
        return host.historySearch(query, {
            limit: clampNumber(payload === null || payload === void 0 ? void 0 : payload.limit, 1, 50, 20),
            perSession: clampNumber(payload === null || payload === void 0 ? void 0 : payload.perSession, 1, 6, 3),
            maxSessions: clampNumber(payload === null || payload === void 0 ? void 0 : payload.maxSessions, 1, 500, 150),
            budgetMs: clampNumber(payload === null || payload === void 0 ? void 0 : payload.budgetMs, 500, 30000, 6000),
        });
    },
    /** 把一条历史会话导出成文件（`md` 转写 / `jsonl` 原样日志 / `zip` 对齐 DSH 的那一份）。 */
    async historyExport(payload) {
        var _a;
        await ensureReady();
        const sessionId = String((_a = payload === null || payload === void 0 ? void 0 : payload.sessionId) !== null && _a !== void 0 ? _a : '').trim();
        if (!sessionId)
            return { ok: false, error: 'history-export：缺少 sessionId' };
        return host.historyExport(sessionId, (payload === null || payload === void 0 ? void 0 : payload.format) === 'jsonl' ? 'jsonl' : (payload === null || payload === void 0 ? void 0 : payload.format) === 'zip' ? 'zip' : 'md');
    },
    /**
     * 删掉一条历史会话（不带 `dryRun` 就是真删）。
     *
     * ⚠ 这一条是**不可逆**的，所以面板的流程是「点 🗑 → 主进程 dry-run 报清单 →
     * 面板显示『将删除 1 个文件 · 70 KB』→ 再点一次才是真删」。二次确认不在这一层，
     * 但这一层保证 `dryRun` 与真删走的是**同一份清单**（同一个脚本、同一段代码）。
     *
     * `reclaim` 是**顺带回收无引用附件**（默认关，见 `history.ts` 那段：超预算就一个都不搬、
     * 每个候选复算 sha256、时间窗保护、只搬墓碑）。它是**分钟级**操作，
     * 所以 dry-run 那一趟也要带上它 —— 否则用户看不到「要等多久、有几个候选」。
     */
    async historyDelete(payload) {
        var _a;
        await ensureReady();
        const sessionId = String((_a = payload === null || payload === void 0 ? void 0 : payload.sessionId) !== null && _a !== void 0 ? _a : '').trim();
        if (!sessionId)
            return { ok: false, error: 'history-delete：缺少 sessionId' };
        return host.historyDelete(sessionId, (payload === null || payload === void 0 ? void 0 : payload.dryRun) === true, (payload === null || payload === void 0 ? void 0 : payload.reclaim) === true);
    },
    /**
     * 读当前会话的**读数**：用量（token 累计 / 上下文占用 / 花费）+ 进度（清单 / 目标 / 回合目录）。
     *
     * 面板上三条来路都会打到这里：用量抽屉的「刷新」、进度抽屉的「刷新」，以及**打开抽屉**时
     * 的那一次。平时不需要面板催 —— 主进程在回合结束（缓存恰好在 `turn/end` 写检查点）与跑完
     * 斜杠命令（`/compact` 就是靠它才看得到变化）之后自己会读，并走广播推给面板。
     *
     * 两条东西一起给的理由：它们在**同一份文件**里（一次读盘、一次解析），而且共用同一组
     * 新鲜度事实（水位 / 落后多少 / 写于何时）—— 分成两次读会出现两边说的水位不一样。
     *
     * 这一条**不需要 node 探测**：投影缓存是明文 JSON，主进程自己读盘就行
     * （对比：会话日志是 zstd，必须 spawn 一个外部 node）。
     */
    async sessionUsage() {
        await ensureReady();
        return host.refreshUsage();
    },
    /**
     * 读**当前会话的「活动」**：后台任务（jobs）+ 子 agent（subagents）。
     *
     * 与用量/进度那两条**刻意不同**：那两个读的是磁盘上的检查点（明文 JSON，主进程自己读盘就行），
     * 而这两块**只活在运行时进程的内存里** —— 所以只能走插件控制帧借宿主的注册表
     * （同斜杠命令、`@` 路径那条路）。也因此：**agent 没在跑就什么都看不到**，
     * 这与「历史会话的用量照样能看」不一样，面板要如实说。
     *
     * 面板只在**打开「活动」抽屉时**（以及点刷新时）打这里，宿主不起定时器 ——
     * 这两个服务没有可订阅的变化事件（job 输出的增长不触发任何通知），
     * 自己起轮询只会白烧 IPC。
     */
    async panelActivity() {
        await ensureReady();
        return host.panelActivity();
    },
    /**
     * 中断一个**子 agent** 的当前一轮（面板上那一行的按钮）。
     *
     * ⚠ 语义是「这一轮别做了」，不是「杀掉它」—— 会话与上下文都留着（同「停止本轮」）。
     */
    async subagentInterrupt(payload) {
        await ensureReady();
        return host.subagentInterrupt(payload === null || payload === void 0 ? void 0 : payload.subagentId);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRzs7O0FBaWhCSCxvQkFHQztBQUdELHdCQUdDO0FBeGhCRCwrQkFBNEI7QUFFNUIsMkNBQWdFO0FBQ2hFLHlDQUFxQztBQUNyQyxxQ0FXa0I7QUFDbEIseUNBQXVFO0FBZXZFOzs7Ozs7O0dBT0c7QUFDSCw4REFBOEQ7QUFDOUQsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLCtCQUErQixDQUV4RCxDQUFDO0FBRUYsb0JBQW9CO0FBQ3BCLE1BQU0sSUFBSSxHQUFHLElBQUksa0JBQU8sRUFBRSxDQUFDO0FBRTNCLGVBQWU7QUFDZixJQUFJLFlBQVksR0FBeUIsSUFBSSxDQUFDO0FBRTlDLDZDQUE2QztBQUM3QyxJQUFJLFdBQVcsR0FBeUIsSUFBSSxDQUFDO0FBRTdDLDJDQUEyQztBQUMzQyxNQUFNLFdBQVcsR0FBeUQsRUFBRSxDQUFDO0FBRTdFOzs7Ozs7R0FNRztBQUNILE1BQU0sU0FBUyxHQUFHLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUM7QUFFMUMsNEJBQTRCO0FBQzVCLE1BQU0saUJBQWlCLEdBQUcsQ0FBQyxDQUFDO0FBRTVCLGtDQUFrQztBQUNsQyxTQUFTLGFBQWE7SUFDbEIsT0FBTyxJQUFBLFdBQUksRUFBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDakMsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7R0FZRztBQUNILFNBQVMsV0FBVyxDQUFDLEtBQWMsRUFBRSxHQUFXLEVBQUUsR0FBVyxFQUFFLFFBQWdCO0lBQzNFLE1BQU0sTUFBTSxHQUFHLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtB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QU8sSUFBSSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxVQUFVLENBQUMsQ0FBQztJQUN2RCxDQUFDO0lBRUQsV0FBVztJQUNYLEtBQUssQ0FBQyxXQUFXO1FBQ2IsTUFBTSxXQUFXLEVBQUUsQ0FBQztRQUNwQixPQUFPLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBQSxzQkFBVyxHQUFFLEVBQUUsQ0FBQztJQUNqRCxDQUFDO0lBRUQsd0NBQXdDO0lBQ3hDLEtBQUssQ0FBQyxjQUFjLENBQUMsS0FBYztRQUMvQixNQUFNLFdBQVcsRUFBRSxDQUFDO1FBQ3BCLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBQSx5QkFBYyxFQUFDLDBCQUFjLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDN0QsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3BCLE9BQU8sRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQ2xDLENBQUM7SUFFRCx1Q0FBdUM7SUFDdkMsS0FBSyxDQUFDLGNBQWM7UUFDaEIsTUFBTSxXQUFXLEVBQUUsQ0FBQztRQUNwQixPQUFPLFdBQVcsRUFBRSxDQUFDO0lBQ3pCLENBQUM7Q0FDSixDQUFDO0FBRUYsdUNBQXVDO0FBQ3ZDLFNBQWdCLElBQUk7SUFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsNkJBQWlCLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELEtBQUssV0FBVyxFQUFFLENBQUM7QUFDdkIsQ0FBQztBQUVELDRDQUE0QztBQUM1QyxTQUFnQixNQUFNO0lBQ2xCLEtBQUssSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO0lBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLENBQUMsQ0FBQztBQUM5QyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDmianlsZXkuLvov5vnqIvlhaXlj6PvvIjnvJbovpHlmaggTm9kZSDnjq/looPvvInjgIJcbiAqXG4gKiDogYzotKPlsLHkuInku7bvvJpcbiAqXG4gKiAxLiAqKuijhemFjSoq77ya6K+76K6+572u44CB5o6i5rWLIG5vZGUvZHNo44CB5bmC562J5Zyw5oqKIGBkc2gtcHJvZmlsZS9gIOWQjOatpeWIsCBgJERTSF9IT01FL3Byb2ZpbGVzL2NvY29zYO+8m1xuICogMi4gKirmiZjnrqEqKu+8muaMgeacieWUr+S4gOeahCBgRHNoSG9zdGDvvIhmb3JrIERTSCDlrZDov5vnqIvjgIHmjqUgU0RLIOWNj+iuruOAgeaOpSBJUEMg5bel5YW377yJ77ybXG4gKiAzLiAqKumdouadv+a2iOaBryoq77ya6Z2i5p2/77yI5riy5p+T6L+b56iL77yJ6YCa6L+HIGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdkc2hfY2hhdCcsIC4uLilgIOaJk+WIsOi/memHjOOAglxuICpcbiAqICMjIOWFs+S6jiBgbG9hZCgpYCDnmoTlvILmraVcbiAqXG4gKiBDb2NvcyDkuI3kvJogYXdhaXQgYGxvYWQoKWDjgILogIzor7vorr7nva7jgIHlhpkgcHJvZmlsZSDpg73mmK/lvILmraXnmoTvvIzmiYDku6XnlKggYHJlYWR5UHJvbWlzZWBcbiAqIOaKiuWIneWni+WMluaUtuaVm+aIkOS4gOS4quWPr+etieW+heWFpeWPo++8muS7u+S9leWvueWkluaWueazleWFiCBgYXdhaXQgZW5zdXJlUmVhZHkoKWDvvIxcbiAqIOmdouadv+aXoOiuuuWkmuaXqeiwg+i/m+adpemDveS4jeS8muivu+WIsOWNiuWIneWni+WMlueKtuaAge+8iOWQjOS4gOS4quWll+i3r++8jOWunua1i+acieaViO+8ieOAglxuICpcbiAqICMjIOS4uuS7gOS5iOS4jeWcqOi/memHjOiHquWKqOWQr+WKqCBhZ2VudFxuICpcbiAqIOWQr+WKqOS4gOasoeimgeWKoOi9veaVtOajtSBEU0gg5o+S5Lu25qCR77yI5Ya35ZCv5Yqo5Yeg5Y2B56eS44CB54Ot5ZCv5Yqo5a6e5rWLIDIuMyDnp5LvvInjgILnlKjmiLflj6/og73lj6rmmK/miZPlvIDnvJbovpHlmajlhpnku6PnoIHvvIxcbiAqIOaJgOS7pem7mOiupOetlueVpeaYr+OAjOmdouadv+aJk+W8gOaXtuaMieiuvue9ruiHquWKqOWQr+WKqOOAje+8jOiAjOS4jeaYr+e8lui+keWZqOS4gOW8gOWwsei1t+OAglxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHsgRVhURU5TSU9OX05BTUUsIEVYVEVOU0lPTl9WRVJTSU9OIH0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgRHNoSG9zdCB9IGZyb20gJy4vZHNoLWhvc3QnO1xuaW1wb3J0IHtcbiAgICBNQVhfTElTVEVEX0lNQUdFUyxcbiAgICBkYlVybFRvUGF0aCxcbiAgICBmb3JtYXRCeXRlcyxcbiAgICBpc0ltYWdlUGF0aCxcbiAgICBtZXJnZVByb2plY3RJbWFnZXMsXG4gICAgcHJvamVjdEltYWdlc0Zyb21Bc3NldERiLFxuICAgIHJlYWRJbWFnZUZpbGUsXG4gICAgc2NhbkltYWdlRmlsZXMsXG4gICAgdmFsaWRhdGVJbWFnZUJhdGNoLFxuICAgIHR5cGUgUHJvamVjdEltYWdlLFxufSBmcm9tICcuL2ltYWdlcyc7XG5pbXBvcnQgeyBnZXRTZXR0aW5ncywgbG9hZFNldHRpbmdzLCB1cGRhdGVTZXR0aW5ncyB9IGZyb20gJy4vc2V0dGluZ3MnO1xuXG4vKiog5a6J6KOF5oql5ZGK6YeM57uZ6Z2i5p2/55yL55qE5a2X5q6144CCICovXG5pbnRlcmZhY2UgSW5zdGFsbFJlcG9ydCB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgcHJvZmlsZURpcj86IHN0cmluZztcbiAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgIGNoYW5nZXM/OiBzdHJpbmdbXTtcbiAgICAvKiog6L+Q6KGM5pyf5L6d6LWW5qCh6aqMIOKAlOKAlCDnvLogYnVuZGxlIOaXtiBwcm9maWxl44CM6KOF5aW95LqG44CN5L2GIDQg5Liq5bel5YW35Lya5pW05L2T5Yqg6L295aSx6LSl44CCICovXG4gICAgZGVwcz86IHsgb2s6IGJvb2xlYW47IHJvb3Q6IHN0cmluZzsgbWlzc2luZzogc3RyaW5nW10gfTtcbiAgICAvKiog5a6J6KOF5Zmo57uZ5Ye655qE44CB5b+F6aG76K6p55So5oi355yL6KeB55qE6K2m5ZGK44CCICovXG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcbiAgICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqXG4gKiDlronoo4XlmajmmK8gKipDb21tb25KUyoq77yIYHNjcmlwdHMvaW5zdGFsbC1wcm9maWxlLmpzYO+8ie+8jOi/memHjOebtOaOpSBgcmVxdWlyZWDjgIJcbiAqXG4gKiDimqAgKirouKnov4fnmoTlnZEqKu+8muWug+WOn+adpeaYryBFU00gYC5tanNg77yM55SoIGBhd2FpdCBpbXBvcnQoKWAg5Yqg6L29IOKAlOKAlCDkvYbmnKzmianlsZXmjIlcbiAqIGBtb2R1bGU6IENvbW1vbkpTYCDnvJbor5HvvIwqKlR5cGVTY3JpcHQg5Lya5oqKIGBpbXBvcnQoKWAg6ZmN57qn5oiQIGByZXF1aXJlKClgKirvvIxcbiAqIOS6juaYr+i/kOihjOaXtuaLvyBgZmlsZTovLy8uLi5gIOeahCBVUkwg5Y67IHJlcXVpcmXvvIzmiqUgYENhbm5vdCBmaW5kIG1vZHVsZSAnZmlsZTovLy8uLi4nYOOAglxuICog5Zug5Li65aSW6Z2i5pyJIHRyeS9jYXRjaO+8jOWug+WPquWPmOaIkOS4gOihjCB3YXJuaW5n77yI55eH54q25piv44CMcHJvZmlsZSDkuIDnm7TmsqHlkIzmraXvvIzkvYbmsqHkurrnn6XpgZPjgI3vvInjgIJcbiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbmNvbnN0IGluc3RhbGxlciA9IHJlcXVpcmUoJy4uL3NjcmlwdHMvaW5zdGFsbC1wcm9maWxlLmpzJykgYXMge1xuICAgIGluc3RhbGxQcm9maWxlOiAob3B0aW9ucz86IG9iamVjdCkgPT4gSW5zdGFsbFJlcG9ydDtcbn07XG5cbi8qKiDllK/kuIDnmoQgYWdlbnQg5a6/5Li744CCICovXG5jb25zdCBob3N0ID0gbmV3IERzaEhvc3QoKTtcblxuLyoqIOWIneWni+WMluWPqui3keS4gOasoeOAgiAqL1xubGV0IHJlYWR5UHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuXG4vKiog5pyA6L+R5LiA5qyhIHByb2ZpbGUg5ZCM5q2l55qE57uT5p6c77yI6Z2i5p2/6KaB5pi+56S65aSx6LSl5Y6f5Zug77yM5LiN6IO95Y+q5ZCe6L+b5pel5b+X77yJ44CCICovXG5sZXQgbGFzdEluc3RhbGw6IEluc3RhbGxSZXBvcnQgfCBudWxsID0gbnVsbDtcblxuLyoqIOmdouadv+iHquajgOWbnuS8oOeahOacgOi/keWHoOadoe+8iOingSBgbWV0aG9kcy5wYW5lbFByb2JlYO+8ieOAgiAqL1xuY29uc3QgcGFuZWxQcm9iZXM6IEFycmF5PHsgYXQ6IG51bWJlcjsgZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfT4gPSBbXTtcblxuLyoqXG4gKiDpnaLmnb/ova7or6LorqHmlbDvvIhgZ2V0LWV2ZW50c2Ag55qE6LCD55So5qyh5pWw77yJ44CCXG4gKlxuICog5a2Y5Zyo55qE55CG55Sx5b6I5YW35L2T77ya6Z2i5p2/Kirmm77nu48qKuWPquWcqCBgbGlzdGVuZXJzLnNob3dgIOmHjOi1t+i9ruivou+8jOiAjOmCo+S4qumSqeWtkOayoeeUn+aViCDihpJcbiAqIOi9ruivouagueacrOayoei3ke+8jOihqOeOsOaIkOOAjOS4iuS4gOi9rueahOWbnuWkjeimgeetieS4i+S4gOasoeWPkemAgeaJjeWHuueOsOOAjeOAguW9k+aXtuS7juWklumDqOWujOWFqOeci+S4jeWHuuadpe+8jFxuICog5Y+q6IO96Z2g54yc44CC5pyJ5LqG6L+Z5Liq6K6h5pWw77yM44CM6Z2i5p2/5Zyo5LiN5Zyo6L2u6K+i44CN5Y+Y5oiQ5LiA5p2h5Y+v5p+l55qE5LqL5a6e44CCXG4gKi9cbmNvbnN0IHBhbmVsUG9sbCA9IHsgY291bnQ6IDAsIGxhc3RBdDogMCB9O1xuXG4vKiog6Ieq5qOA5Y+q55WZ5pyA6L+R5Yeg5p2h77yM5Yir5oqK6ZW/5Lya6K+d6LeR5oiQ5YaF5a2Y5rOE5ryP44CCICovXG5jb25zdCBQQU5FTF9QUk9CRV9MSU1JVCA9IDg7XG5cbi8qKiDmianlsZXmoLnnm67lvZXvvIhgZGlzdC9tYWluLmpzYCDlvoDkuIrkuKTnuqfvvInjgIIgKi9cbmZ1bmN0aW9uIGV4dGVuc2lvblJvb3QoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbihfX2Rpcm5hbWUsICcuLicpO1xufVxuXG4vKipcbiAqIOaKiuS4gOS4quOAjOmdouadv+S8oOadpeeahOaVsOWtl+OAjeaUtui/myBgW21pbiwgbWF4XWDvvIjkuI3mmK/mlbDlrZflsLHpgIDlm57pu5jorqTlgLzvvInjgIJcbiAqXG4gKiDpnaLmnb/mmK8qKui+k+WFpSoq6ICM5LiN5piv6Ieq5bex5Lq677yI5ZCMIGBzZW5kTWVzc2FnZWAvYHJlYWRJbWFnZWAg55qE5Y+j5b6E77yJ77ya6LCB6YO96IO9XG4gKiBgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnZHNoX2NoYXQnLCAuLi4pYO+8jOaJgOS7pemihOeul+i/meexu+S4nOilv+W/hemhu+WcqOi/meS4gOWxguWkueatu++8jFxuICog5LiN6IO96K6p5LiA5Lu9IGBidWRnZXRNczogNjAwMDAwYCDmiorno4Hnm5jmiavnqb/jgIJcbiAqXG4gKiBAcGFyYW0gdmFsdWUgLSDpnaLmnb/nu5nnmoTlgLzjgIJcbiAqIEBwYXJhbSBtaW4gLSDkuIvpmZDjgIJcbiAqIEBwYXJhbSBtYXggLSDkuIrpmZDjgIJcbiAqIEBwYXJhbSBmYWxsYmFjayAtIOS4jeaYr+aVsOWtl+aXtueUqOiwgeOAglxuICogQHJldHVybnMg5aS55aW955qE5pW05pWw44CCXG4gKi9cbmZ1bmN0aW9uIGNsYW1wTnVtYmVyKHZhbHVlOiB1bmtub3duLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICAgIGNvbnN0IG51bWJlciA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGguZmxvb3IodmFsdWUpIDogZmFsbGJhY2s7XG4gICAgcmV0dXJuIE1hdGgubWluKG1heCwgTWF0aC5tYXgobWluLCBudW1iZXIpKTtcbn1cblxuLyoqXG4gKiDluYLnrYnlnLDmiorlt6XnqIvph4znmoQgYGRzaC1wcm9maWxlL2Ag5ZCM5q2l5YiwIGAkRFNIX0hPTUUvcHJvZmlsZXMvY29jb3MvYOOAglxuICpcbiAqIEByZXR1cm5zIOWuieijheaKpeWRiu+8m+Wksei0peS4jeaKm++8iOWug+S4jeivpeaMoeS9j+aVtOS4quaJqeWxle+8jOS9hioq5b+F6aG7Kirog73ooqvpnaLmnb/nnIvop4HvvInjgIJcbiAqL1xuZnVuY3Rpb24gc3luY1Byb2ZpbGUoKTogSW5zdGFsbFJlcG9ydCB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwb3J0ID0gaW5zdGFsbGVyLmluc3RhbGxQcm9maWxlKCk7XG4gICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgYFtkc2hfY2hhdF0gcHJvZmlsZSAke3JlcG9ydC52ZXJzaW9ufSDlt7LlsLHkvY3vvJoke3JlcG9ydC5wcm9maWxlRGlyfWAgK1xuICAgICAgICAgICAgICAgIChyZXBvcnQuY2hhbmdlcz8ubGVuZ3RoID8gYO+8iCR7cmVwb3J0LmNoYW5nZXMubGVuZ3RofSDlpITlj5jmm7TvvIlgIDogJ++8iOaXoOWPmOabtO+8iScpLFxuICAgICAgICApO1xuICAgICAgICAvLyDimqAg5Yir5Zyo6L+Z6YeM5YaZ5q27IGBvazogdHJ1ZWDjgIJwcm9maWxlIOaWh+S7tuijheWlveS6hiDiiaAg6L+Z5Y+w5py65Zmo6IO955So77yaXG4gICAgICAgIC8vIOe8uiBgZHNoLWJhc2VgIC8gYGRzaC1zZGstYXBwYCDml7YgcHJvZmlsZSDnnIvotbfmnaXkuIDliIfmraPluLjvvIzogIzmqKHlnovmiYvph4wgNCDkuKrlt6XlhbflhajmsqHkuoZcbiAgICAgICAgLy8g77yI6KaB562JIGluaXRpYWxpemUg6LaF5pe25oiW5oqlXCLmnKrnn6XnmoTnvJbovpHlmajmlrnms5VcIuaJjeWPkeeOsO+8ieOAguaJgOS7pSBvayDlj43mmKDnmoTmmK8qKuWPr+eUqOaApyoq77yMXG4gICAgICAgIC8vIOW5tuaKiuWOn+WboOWGmei/myBgZXJyb3Jg77yI6Z2i5p2/5bey5pyJ5pi+56S65aSx6LSl5Y6f5Zug55qE6YKj5p2h6Lev77yJ44CCXG4gICAgICAgIGNvbnN0IGRlcHNPayA9IHJlcG9ydC5kZXBzID8gcmVwb3J0LmRlcHMub2sgOiB0cnVlO1xuICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVwb3J0Lndhcm5pbmdzID8/IFtdKSBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g4pqgICR7bGluZX1gKTtcbiAgICAgICAgbGFzdEluc3RhbGwgPSB7XG4gICAgICAgICAgICAuLi5yZXBvcnQsXG4gICAgICAgICAgICBvazogZGVwc09rLFxuICAgICAgICAgICAgZXJyb3I6IGRlcHNPayA/IHVuZGVmaW5lZCA6IChyZXBvcnQud2FybmluZ3MgPz8gW10pLmpvaW4oJyAnKSxcbiAgICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g5ZCM5q2lIHByb2ZpbGUg5aSx6LSl77yaJHttZXNzYWdlfWApO1xuICAgICAgICBsYXN0SW5zdGFsbCA9IHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9O1xuICAgIH1cbiAgICByZXR1cm4gbGFzdEluc3RhbGw7XG59XG5cbi8qKiDliJ3lp4vljJbvvJror7vorr7nva4g4oaSIOaOoua1i+i/kOihjOaXtiDihpIg6KOFIHByb2ZpbGXjgILlj6rot5HkuIDmrKHjgIIgKi9cbmZ1bmN0aW9uIGVuc3VyZVJlYWR5KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghcmVhZHlQcm9taXNlKSB7XG4gICAgICAgIHJlYWR5UHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBsb2FkU2V0dGluZ3MoRVhURU5TSU9OX05BTUUpO1xuICAgICAgICAgICAgaG9zdC5wcm9iZVJ1bnRpbWUoKTtcbiAgICAgICAgICAgIHN5bmNQcm9maWxlKCk7XG4gICAgICAgIH0pKCk7XG4gICAgfVxuICAgIHJldHVybiByZWFkeVByb21pc2U7XG59XG5cbi8qKlxuICog5ZyoICoqSW5zcGVjdG9yIOaXgei+uSoq5omT5byA6Z2i5p2/77yI5omT5byA5aSx6LSl5YiZ6YCA5Zue5rWu5Yqo56qX5Y+j77yJ44CCXG4gKlxuICog4pqgIOWunua1i++8mmBFZGl0b3IuUGFuZWwub3BlbkJlc2lkZSgpYCDlr7kqKuW3sue7j+aJk+W8gCoq55qE6Z2i5p2/6L+U5ZueIGBmYWxzZWAg5LiU5LuA5LmI6YO95LiN5YGa77yMXG4gKiDmiYDku6XjgIzlgZzpnaDjgI3ov5nmnaHot6/lv4XpobvlhYggYGNsb3NlKClg77yI6KeBIGBkb2NrUGFuZWxg77yJ44CCXG4gKlxuICogQHJldHVybnMg5omT5byA57uT5p6c77yMYGFjdGlvbmAg6K+05piO5pyA5ZCO5piv5YGc6Z2g6L+Y5piv5rWu5Yqo44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG9wZW5CZXNpZGVJbnNwZWN0b3IoKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBhY3Rpb24/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICB0cnkge1xuICAgICAgICBpZiAoYXdhaXQgRWRpdG9yLlBhbmVsLm9wZW5CZXNpZGUoJ2luc3BlY3RvcicsIEVYVEVOU0lPTl9OQU1FKSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2Jlc2lkZS1pbnNwZWN0b3InIH07XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0gb3BlbkJlc2lkZSDlpLHotKXvvIzmlLnnlKjmta7liqjnqpflj6PvvJoke1N0cmluZyhlcnJvcil9YCk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5vcGVuKEVYVEVOU0lPTl9OQU1FKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2Zsb2F0aW5nJyB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSB9O1xuICAgIH1cbn1cblxuLyoqIOWvueWkluaWueazle+8iOW/hemhu+S4jiBwYWNrYWdlLmpzb24g55qEIGBjb250cmlidXRpb25zLm1lc3NhZ2VzYCDkuIDkuIDlr7nlupTvvInjgIIgKi9cbmV4cG9ydCBjb25zdCBtZXRob2RzOiB7IFtrZXk6IHN0cmluZ106ICguLi5hcmdzOiBhbnlbXSkgPT4gYW55IH0gPSB7XG4gICAgLyoqIOaJk+W8gOmdouadv++8iOiPnOWNlemhueeUqO+8ieOAguW3sue7j+W8gOedgOWwseiBmueEpu+8jOayoeW8gOWwsSoq5YGc5ZyoIEluc3BlY3RvciDml4HovrkqKuOAgiAqL1xuICAgIGFzeW5jIG9wZW5QYW5lbCgpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChhd2FpdCBFZGl0b3IuUGFuZWwuaGFzKEVYVEVOU0lPTl9OQU1FKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5mb2N1cyhFWFRFTlNJT05fTkFNRSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2ZvY3VzZWQnIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyog5o6i5rWL5aSx6LSl5bCx55u05o6l5b6A5LiL6LWw5Y675omT5byAICovXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9wZW5CZXNpZGVJbnNwZWN0b3IoKTtcbiAgICB9LFxuXG4gICAgLyoqIOW8uuWItuWBnOmdoOWIsCBJbnNwZWN0b3Ig5peB6L6577yI6Z2i5p2/5bey57uP5rWu552A5pe255So77ya5YWI5YWz5YaN5Zyo5peB6L655byA77yJ44CCICovXG4gICAgYXN5bmMgZG9ja1BhbmVsKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKGF3YWl0IEVkaXRvci5QYW5lbC5oYXMoRVhURU5TSU9OX05BTUUpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLmNsb3NlKEVYVEVOU0lPTl9OQU1FKTtcbiAgICAgICAgICAgICAgICAvLyDlhbPpl63liLAgcmVvcGVuIOS5i+mXtOe7mee8lui+keWZqOS4gOeCueaXtumXtO+8iOWunua1i+S4jeeVmei/meS4gOS4i+S8muWBtuWPkeWksei0pe+8iVxuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDI1MCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIOWFs+S4jeaOieS5n+e7p+e7reWwneivleaJk+W8gCAqL1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvcGVuQmVzaWRlSW5zcGVjdG9yKCk7XG4gICAgfSxcblxuICAgIC8qKiDlkK/liqggYWdlbnTjgIIgKi9cbiAgICBhc3luYyBzdGFydEFnZW50KCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gaG9zdC5zdGFydCgpO1xuICAgIH0sXG5cbiAgICAvKiog5YGc5q2iIGFnZW5044CCICovXG4gICAgYXN5bmMgc3RvcEFnZW50KCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gaG9zdC5zdG9wKCk7XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOS4reaWrSoq5b2T5YmN6L+Z5LiA6L2uKirvvIjkuI3liqggYWdlbnQg6L+b56iL44CB5LiN5Yqo5Lya6K+d77yJ44CCXG4gICAgICpcbiAgICAgKiDkuI4gYHN0b3BBZ2VudGAg55qE5YiG5bel5YaZ5Zyo6L+Z6YeM77yM5YWN5b6X6Z2i5p2/6YKj5L6n5YaN6Kej6YeK5LiA6YGN77yaXG4gICAgICog44CM5YGc5q2i5pys6L2u44CNPSDov5nkuIDova7liKvlgZrkuobvvIjkvJror53kuI7kuIrkuIvmloflhajnlZnnnYDvvIzmjqXnnYDor7TvvInvvJtcbiAgICAgKiDjgIzlgZzmraLjgI09IOaVtOS4qiBhZ2VudCDov5vnqIvkuIvnur/vvIjopoHph43lkK/vvIzph43lkK/lkI7oh6rliqjmjqXlm57kuIrmrKHkvJror53vvInjgIJcbiAgICAgKi9cbiAgICBhc3luYyBpbnRlcnJ1cHQoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiBob3N0LmludGVycnVwdCgpO1xuICAgIH0sXG5cbiAgICAvKiog6Z2i5p2/6L2u6K+i77ya54q25oCBICsg6K6+572uICsg6L+Q6KGM5pe26Lev5b6EICsg5pyA6L+R5LiA5qyhIHByb2ZpbGUg5ZCM5q2l57uT5p6c44CCICovXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGV4dGVuc2lvbjogeyBuYW1lOiBFWFRFTlNJT05fTkFNRSwgdmVyc2lvbjogRVhURU5TSU9OX1ZFUlNJT04sIHJvb3Q6IGV4dGVuc2lvblJvb3QoKSB9LFxuICAgICAgICAgICAgYWdlbnQ6IGhvc3Quc25hcHNob3QoKSxcbiAgICAgICAgICAgIHNldHRpbmdzOiBnZXRTZXR0aW5ncygpLFxuICAgICAgICAgICAgcHJvZmlsZTogbGFzdEluc3RhbGwsXG4gICAgICAgICAgICBwYW5lbDogcGFuZWxQcm9iZXMsXG4gICAgICAgICAgICBwYW5lbFBvbGw6IHsgY291bnQ6IHBhbmVsUG9sbC5jb3VudCwgbGFzdEF0OiBwYW5lbFBvbGwubGFzdEF0LCBtc1NpbmNlTGFzdDogcGFuZWxQb2xsLmxhc3RBdCA/IERhdGUubm93KCkgLSBwYW5lbFBvbGwubGFzdEF0IDogbnVsbCB9LFxuICAgICAgICB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDpnaLmnb/oh6rmo4Dlm57kvKDvvIjmuLLmn5Pov5vnqIsg4oaSIOS4u+i/m+eoi++8ieOAglxuICAgICAqXG4gICAgICog6Z2i5p2/6YeM55qE5oql6ZSZ77yI6YCJ5oup5Zmo5rKh6Kej5p6Q5Ye65p2l44CB5biD5bGA6auY5bqm5aGM5oiQIDDigKbvvInku6XliY3lj6rog73pnaDkurrljrvnvJbovpHlmajmjqfliLblj7Dph4znnIvvvIxcbiAgICAgKiDogIzmjqfliLblj7DkuIDooYzooYzliLflvpflvojlv6vjgILov5nph4znlZnkuIDmnaHpgJrpgZPvvJrpnaLmnb/miorjgIzmiJHnnIvliLDnmoToh6rlt7HjgI3miqXkuIrmnaXvvIxcbiAgICAgKiDkuLvov5vnqIvlrZjmnIDov5Hlh6DmrKHvvIxgZ2V0LXN0YXRlYCDluKblm57ljrvvvIzkuo7mmK/lpJbpg6jvvIjnvJbovpHlmaggTUNQIC8g5pel5b+X77yJ6IO955u05o6l6K+75Yiw44CCXG4gICAgICpcbiAgICAgKiDlj6rmlLbmlbDmja7jgIHkuI3miafooYzku7vkvZXkuJzopb/vvJrpnaLmnb/mmK/muLLmn5Pov5vnqIvvvIzlroPor7TnmoTku7vkvZXlhoXlrrnpg73kuI3lj6/kv6HjgIJcbiAgICAgKi9cbiAgICBhc3luYyBwYW5lbFByb2JlKHBheWxvYWQ6IHVua25vd24pIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSB7XG4gICAgICAgICAgICBhdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGRhdGE6IHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09ICdvYmplY3QnID8gKHBheWxvYWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogeyByYXc6IHBheWxvYWQgfSxcbiAgICAgICAgfTtcbiAgICAgICAgcGFuZWxQcm9iZXMucHVzaChlbnRyeSk7XG4gICAgICAgIHdoaWxlIChwYW5lbFByb2Jlcy5sZW5ndGggPiBQQU5FTF9QUk9CRV9MSU1JVCkgcGFuZWxQcm9iZXMuc2hpZnQoKTtcbiAgICAgICAgY29uc3Qgc3VtbWFyeSA9IEpTT04uc3RyaW5naWZ5KGVudHJ5LmRhdGEpLnNsaWNlKDAsIDQwMCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbZHNoX2NoYXRdIOmdouadv+iHquajgO+8miR7c3VtbWFyeX1gKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9LFxuXG4gICAgLyoqIOWinumHj+aLieWPlui9rOWGme+8iOW5v+aSreS4ouS6huS5n+iDvemdoOWug+i/veW5s++8ieOAgiAqL1xuICAgIGFzeW5jIGdldEV2ZW50cyhwYXlsb2FkOiB7IHNpbmNlPzogbnVtYmVyIH0gfCB1bmRlZmluZWQpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgLy8g5Y+q5pyJ6Z2i5p2/5Lya6LCD6L+Z5Liq5pa55rOVIOKAlOKAlCDorqHmlbDlsLHmmK/jgIzpnaLmnb/lnKjkuI3lnKjova7or6LjgI3nmoTlnLDpnaLnnJ/nm7jvvIjmjpLmn6XnlKjvvIlcbiAgICAgICAgcGFuZWxQb2xsLmNvdW50ICs9IDE7XG4gICAgICAgIHBhbmVsUG9sbC5sYXN0QXQgPSBEYXRlLm5vdygpO1xuICAgICAgICAvLyDlkIzkuIDmnaHkuovlrp7ov5jmnInkuKrnlKjpgJTvvJrkuqTkupLvvIjmj5Dpl64v5o6I5p2D77yJ5Yiw6L6+5pe25Yik5pat44CM5pyJ5rKh5pyJ5Lq66IO95Zue562U44CN44CCXG4gICAgICAgIC8vIOmdouadv+S4jeWcqOWwseeri+WIu+aUvuihjO+8jOWIq+iuqeaooeWei+W5suetiSDigJTigJQg6KeBIERzaEhvc3QuZ2F0ZUludGVyYWN0aW9uIOeahOazqOmHiuOAglxuICAgICAgICBob3N0Lm5vdGVQYW5lbEFjdGl2aXR5KCk7XG4gICAgICAgIGNvbnN0IHNpbmNlID0gTnVtYmVyKHBheWxvYWQ/LnNpbmNlID8/IDApO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgLi4uaG9zdC5ldmVudHNTaW5jZShOdW1iZXIuaXNGaW5pdGUoc2luY2UpID8gc2luY2UgOiAwKSB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDlm57nrZTkuIDmrKHjgIzpnIDopoHkurrmi43mnb/jgI3nmoTkuqTkupLvvIjpnaLmnb/kuIrpgqPlnZflr7nor53moYbvvJrmqKHlnovmj5Dpl64gLyDmjojmnYPor7fmsYIgLyDorqHliJLor4TlrqHvvInjgIJcbiAgICAgKlxuICAgICAqIOW9oueKtuagoemqjOWcqCBgRHNoSG9zdC5hbnN3ZXJJbnRlcmFjdGlvbmAg6YeM77yI6Z2i5p2/5piv5riy5p+T6L+b56iL77yM5a6D6K+055qE5LiN5Y+v5L+h77yJ77ybXG4gICAgICog5aSx6LSlKirkuI3mipsqKu+8jOWbnuS4gOWPpeS6uuivneiuqemdouadv+WOn+agt+aYvuekuu+8iOWQjCBgc2VuZE1lc3NhZ2VgIOeahOWPo+W+hO+8ieOAglxuICAgICAqL1xuICAgIGFzeW5jIGludGVyYWN0aW9uQW5zd2VyKHBheWxvYWQ6IHVua25vd24pIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgcmV0dXJuIGhvc3QuYW5zd2VySW50ZXJhY3Rpb24ocGF5bG9hZCk7XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWIl+i/meS4qiBhZ2VudCDog73nlKjnmoTmlpzmnaDlkb3ku6TvvIjpnaLmnb/ovpPlhaUgYC9gIOaXtuW8ueeahOmCo+W8oOihqO+8ieOAglxuICAgICAqXG4gICAgICog5ZG95Luk5YWo5Zyo5a6/5Li76YeM77yIYC9jb21wYWN0YCBgL3BsYW5gIGAvZ29hbGAgYC9mZWVkYmFja2Ag4oCm77yJ77yMU0RLIOWNj+iuruayoeaciei/meS4gOWxgu+8jFxuICAgICAqIOaJgOS7pei1sOaPkuS7tuaOp+WItuW4p+OAguWksei0pSoq5LiN5oqbKirvvIzlm54gYHtvazpmYWxzZSwgZXJyb3J9YCDorqnpnaLmnb/lvZPkuIDmnaHmj5DnpLrmmL7npLrjgIJcbiAgICAgKi9cbiAgICBhc3luYyBjb21tYW5kTGlzdCgpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgcmV0dXJuIGhvc3QuY29tbWFuZExpc3QoKTtcbiAgICB9LFxuXG4gICAgLyoqIOaJp+ihjOS4gOadoeaWnOadoOWRveS7pOihjO+8iOe7k+aenOS4jei/m+aooeWei+WOhuWPsu+8m+mdouadv+WPquWcqOWksei0peaXtumineWkluaPkOekuuS4gOWPpe+8ieOAgiAqL1xuICAgIGFzeW5jIGNvbW1hbmRSdW4ocGF5bG9hZDogeyBsaW5lPzogdW5rbm93biB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiBob3N0LnJ1bkNvbW1hbmQocGF5bG9hZD8ubGluZSk7XG4gICAgfSxcblxuICAgIC8qKiDliJcgYEDot6/lvoRgIOWAmemAie+8iOmdouadv+eahCBgQGAg6KGl5YWo77yb6L655omT5a2X6L656Zeu77yM5omA5Lul6L+Z5p2h6Lev6KaB5L6/5a6c77yJ44CCICovXG4gICAgYXN5bmMgZmlsZVJlZmVyZW5jZShwYXlsb2FkOiB7IHF1ZXJ5PzogdW5rbm93biB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiBob3N0LmZpbGVSZWZlcmVuY2UocGF5bG9hZD8ucXVlcnkpO1xuICAgIH0sXG5cbiAgICAvKiog5Y+R5LiA5p2h55So5oi35raI5oGv77yI5paH5pysICsg5Y+v6YCJ5Zu+54mH77yJ44CCICovXG4gICAgYXN5bmMgc2VuZE1lc3NhZ2UocGF5bG9hZDogeyB0ZXh0Pzogc3RyaW5nOyBpbWFnZXM/OiB1bmtub3duIH0gfCB1bmRlZmluZWQpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgLy8g5Zu+54mH5Zyo6L+Z5LiA5bGC5YaN6aqM5LiA6YGN77ya6Z2i5p2/5piv5riy5p+T6L+b56iL77yM5a6D6K+055qE5YaF5a655LiN5Y+v5L+h77yI5ZCMIGBwYW5lbFByb2JlYCDnmoTlj6PlvoTvvInjgIJcbiAgICAgICAgLy8g5qCh6aqM5aSx6LSlKirkuI3mipsqKu+8jOWbnuS4gOWPpeS6uuivneiuqemdouadv+WOn+agt+aYvuekuuOAglxuICAgICAgICBjb25zdCBjaGVja2VkID0gdmFsaWRhdGVJbWFnZUJhdGNoKHBheWxvYWQ/LmltYWdlcyk7XG4gICAgICAgIGlmIChjaGVja2VkLm9rID09PSBmYWxzZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogY2hlY2tlZC5lcnJvciB9O1xuICAgICAgICByZXR1cm4gaG9zdC5zZW5kKFN0cmluZyhwYXlsb2FkPy50ZXh0ID8/ICcnKSwgY2hlY2tlZC5pbWFnZXMpO1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJflt6XnqIvph4znmoTlm77niYfvvIjpnaLmnb/kuIrpgqPkuKrlm77niYfpgInmi6nlmajvvInjgIJcbiAgICAgKlxuICAgICAqICoq5Li76Lev5piv6LWE5rqQ5bqTKirvvIhgYXNzZXQtZGJgIOeahCBgcXVlcnktYXNzZXRzYO+8ie+8muWug+aYr+e8lui+keWZqOmHjOeUqOaIt+ecn+eci+W+l+ingeeahOmCo+S7veS6i+Wunu+8jFxuICAgICAqIOi/mOmhuuW4pue7meWHuiBgZGI6Ly9hc3NldHMvLi4uYCDov5nkuKrlj6/or7sgVVJM44CCKirlhZzlupXmmK/miavnm67lvZUqKu+8muWGhee9ruaJqeWxleeahOa2iOaBr+WQjeWtly/lj4LmlbBcbiAgICAgKiDpmo/niYjmnKzlj6/og73lj5jvvIzmi7/kuI3liLDml7boh7PlsJHopoHog73pgInlm74g4oCU4oCUIOS4pOWll+e7k+aenOaMiee7neWvuei3r+W+hOWOu+mHje+8iOingSBgbWVyZ2VQcm9qZWN0SW1hZ2VzYO+8ieOAglxuICAgICAqL1xuICAgIGFzeW5jIGxpc3RJbWFnZXMoKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHByb2plY3RQYXRoID0gRWRpdG9yLlByb2plY3QucGF0aDtcbiAgICAgICAgbGV0IHNvdXJjZTogJ2Fzc2V0LWRiJyB8ICdzY2FuJyA9ICdhc3NldC1kYic7XG4gICAgICAgIGxldCBwcmltYXJ5OiBQcm9qZWN0SW1hZ2VbXSA9IFtdO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgcm93cyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcbiAgICAgICAgICAgICAgICAncXVlcnktYXNzZXRzJyxcbiAgICAgICAgICAgICAgICB7IHBhdHRlcm46ICdkYjovL2Fzc2V0cy8qKi8qJyB9LFxuICAgICAgICAgICAgICAgIFsndXJsJywgJ25hbWUnLCAnZGlzcGxheU5hbWUnLCAndXVpZCcsICdmaWxlJywgJ210aW1lJ10sXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcHJpbWFyeSA9IHByb2plY3RJbWFnZXNGcm9tQXNzZXREYihyb3dzLCBwcm9qZWN0UGF0aCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtkc2hfY2hhdF0g6LWE5rqQ5bqT5p+l6K+i5aSx6LSl77yM5pS555So55uu5b2V5omr5o+P77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZmFsbGJhY2s6IFByb2plY3RJbWFnZVtdID0gW107XG4gICAgICAgIGlmIChwcmltYXJ5Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgc291cmNlID0gJ3NjYW4nO1xuICAgICAgICAgICAgZmFsbGJhY2sgPSBzY2FuSW1hZ2VGaWxlcyhqb2luKHByb2plY3RQYXRoLCAnYXNzZXRzJyksIE1BWF9MSVNURURfSU1BR0VTKS5tYXAoKGZpbGUpID0+ICh7XG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtmaWxlLnJlbH1gLFxuICAgICAgICAgICAgICAgIHBhdGg6IGZpbGUucGF0aCxcbiAgICAgICAgICAgICAgICBuYW1lOiBmaWxlLm5hbWUsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IGZpbGUuYnl0ZXMsXG4gICAgICAgICAgICAgICAgcmVsOiBgYXNzZXRzLyR7ZmlsZS5yZWx9YCxcbiAgICAgICAgICAgICAgICBzb3VyY2U6ICdzY2FuJyBhcyBjb25zdCxcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGltYWdlcyA9IG1lcmdlUHJvamVjdEltYWdlcyhwcmltYXJ5LCBmYWxsYmFjaywgTUFYX0xJU1RFRF9JTUFHRVMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBzb3VyY2UsXG4gICAgICAgICAgICBwcm9qZWN0UGF0aCxcbiAgICAgICAgICAgIHRvdGFsOiBpbWFnZXMubGVuZ3RoLFxuICAgICAgICAgICAgLyoqIOebruW9leaJq+aPj+i/meadoei3r+aLv+S4jeWIsOWtl+iKguaVsO+8iOi1hOa6kOW6k+mCo+adoeacie+8ie+8jOmdouadv+aMiemcgOaYvuekuuOAgiAqL1xuICAgICAgICAgICAgaW1hZ2VzLFxuICAgICAgICB9O1xuICAgIH0sXG5cbiAgICAvKiog6K+75LiA5byg5bel56iL5Zu+54mH77yI6L2s5oiQ6KeE6IyDIGJhc2U2NCDlm57nu5npnaLmnb/vvJrlgZrnvKnnlaXlm74gKyDnnJ/opoHlj5HpgIHml7bnm7TmjqXnlKjvvInjgIIgKi9cbiAgICBhc3luYyByZWFkSW1hZ2UocGF5bG9hZDogeyB1cmw/OiBzdHJpbmc7IHBhdGg/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgICAgIGNvbnN0IHJhd1VybCA9IHR5cGVvZiBwYXlsb2FkPy51cmwgPT09ICdzdHJpbmcnID8gcGF5bG9hZC51cmwudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IHJhd1BhdGggPSB0eXBlb2YgcGF5bG9hZD8ucGF0aCA9PT0gJ3N0cmluZycgPyBwYXlsb2FkLnBhdGgudHJpbSgpIDogJyc7XG4gICAgICAgIGxldCBmaWxlID0gcmF3UGF0aDtcbiAgICAgICAgaWYgKCFmaWxlICYmIHJhd1VybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XG4gICAgICAgICAgICBjb25zdCBtYXBwZWQgPSBkYlVybFRvUGF0aChwcm9qZWN0UGF0aCwgcmF3VXJsKTtcbiAgICAgICAgICAgIGlmICghbWFwcGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg6L+Z5Liq6LWE5rqQ5Zyw5Z2A5pig5bCE5LiN5Yiw5paH5Lu277yaJHtyYXdVcmx9YCB9O1xuICAgICAgICAgICAgZmlsZSA9IG1hcHBlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWZpbGUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdyZWFkLWltYWdl77ya57y65bCRIHVybCDmiJYgcGF0aCcgfTtcbiAgICAgICAgaWYgKCFpc0ltYWdlUGF0aChmaWxlKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOS4jeaYr+iupOW+l+eahOWbvueJh++8miR7ZmlsZX1gIH07XG5cbiAgICAgICAgLy8g5Y+q5YWB6K646K+7Kirlt6XnqIvlhoUqKueahOWbvueJh++8mumdouadv+S8oOadpeeahOi3r+W+hOimgeW9k+i+k+WFpeS4jeWPr+S/oeWkhOeQhu+8iOWQjCBzZW5kTWVzc2FnZSDnmoTlj6PlvoTvvInjgIJcbiAgICAgICAgY29uc3Qgcm9vdCA9IGpvaW4ocHJvamVjdFBhdGgsICcnKS5yZXBsYWNlKC9bXFxcXC9dKyQvLCAnJyk7XG4gICAgICAgIGlmICghZmlsZS5zdGFydHNXaXRoKHJvb3QpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5Y+q6IO96K+75bel56iL55uu5b2V5YaF55qE5Zu+54mH77yIJHtyb290fSDkuYvlpJbnmoTkuIDlvovmi5Lnu53vvInvvJoke2ZpbGV9YCB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVhZEltYWdlRmlsZShmaWxlLCB7IHByb2plY3RQYXRoIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgY29uc29sZS5sb2coYFtkc2hfY2hhdF0g6K+75Zu+ICR7cmVzdWx0Lm5hbWV977yIJHtmb3JtYXRCeXRlcyhyZXN1bHQuYnl0ZXMpfe+8ieKGkiAke3Jlc3VsdC5taW1lVHlwZX1gKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9LFxuXG4gICAgLyoqIOW8gOaWsOS8muivneOAgiAqL1xuICAgIGFzeW5jIG5ld1Nlc3Npb24oKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCAuLi5ob3N0Lm5ld1Nlc3Npb24oKSB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJfmnKzlt6XnqIvnmoTljoblj7LkvJror53vvIjpnaLmnb/lj7PkuIrop5LjgIzljoblj7LjgI3vvInjgIJcbiAgICAgKlxuICAgICAqIOebtOaOpeivuyBEU0gg55qE5Lya6K+d5pel5b+X77yIYDxEU0hfSE9NRT4vc2Vzc2lvbnMvPOW3peeoi+mUrj4v4oCmYO+8ieKAlOKAlCAqKmFnZW50IOayoeWcqOi3keaXtuS5n+iDveWIlyoq77yMXG4gICAgICog5omA5Lul44CM5oiR5YGc5o6J5LqG77yM5LmL5YmN6IGK55qE6L+Y6IO95om+5Zue5p2l5ZCX44CN6L+Z5Lu25LqL5pyJ562U5qGI44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeUxpc3QocGF5bG9hZDogeyBsaW1pdD86IG51bWJlciB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IGxpbWl0ID0gTnVtYmVyKHBheWxvYWQ/LmxpbWl0ID8/IDIwKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIC4uLihhd2FpdCBob3N0Lmhpc3RvcnlMaXN0KE51bWJlci5pc0Zpbml0ZShsaW1pdCkgJiYgbGltaXQgPiAwID8gTWF0aC5taW4oMTAwLCBsaW1pdCkgOiAyMCkpIH07XG4gICAgfSxcblxuICAgIC8qKiDmiorkuIDmnaHljoblj7LkvJror53lm57mlL7liLDlr7nor53ljLrvvIjlj6ror7vvvJvmjqXnnYDogYropoHlho3osIMgaGlzdG9yeS1yZXN1bWXvvInjgIIgKi9cbiAgICBhc3luYyBoaXN0b3J5T3BlbihwYXlsb2FkOiB7IHNlc3Npb25JZD86IHN0cmluZyB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IFN0cmluZyhwYXlsb2FkPy5zZXNzaW9uSWQgPz8gJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFzZXNzaW9uSWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdoaXN0b3J5LW9wZW7vvJrnvLrlsJEgc2Vzc2lvbklkJyB9O1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgLi4uKGF3YWl0IGhvc3QubG9hZEhpc3Rvcnkoc2Vzc2lvbklkKSkgfTtcbiAgICB9LFxuXG4gICAgLyoqICoq5o6l5LiKKirkuIDmnaHljoblj7LkvJror53vvIjmj5Lku7YgYGFnZW50cy5yZXN1bWVg77yJ4oCU4oCU5LmL5ZCO55qE5raI5oGv5bim552A5a6D55qE5LiK5LiL5paH44CCICovXG4gICAgYXN5bmMgaGlzdG9yeVJlc3VtZShwYXlsb2FkOiB7IHNlc3Npb25JZD86IHN0cmluZyB9IHwgdW5kZWZpbmVkKSB7XG4gICAgICAgIGF3YWl0IGVuc3VyZVJlYWR5KCk7XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBwYXlsb2FkPy5zZXNzaW9uSWQgPT09ICdzdHJpbmcnICYmIHBheWxvYWQuc2Vzc2lvbklkLnRyaW0oKSA/IHBheWxvYWQuc2Vzc2lvbklkLnRyaW0oKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIC4uLihhd2FpdCBob3N0LnJlc3VtZUhpc3Rvcnkoc2Vzc2lvbklkKSkgfTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5ZyoKirmiYDmnIkqKuWOhuWPsuS8muivnemHjOWBmuWFqOaWh+aQnOe0ou+8iOmdouadv+WOhuWPsuaKveWxiemHjOeahOOAjOaQnOWFqOaWh+OAje+8ieOAglxuICAgICAqXG4gICAgICog6aKE566X5pivKirpnaLmnb/kvKDkuIrmnaXnmoQqKu+8iOmdouadv+efpemBk+iHquW3seWcqOetieWkmuS5he+8ie+8jOi/meS4gOWxguWPquWBmuS4iumZkOaUtuaVm++8mlxuICAgICAqIOiwgemDveiDveiwgyBgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdGDvvIzkuI3og73orqnlroPmi7/nnYDkuIDku70gYC0tbWF4LXNlc3Npb25zPTEwMDAwMGAg5oqKXG4gICAgICog56OB55uY5omr56m/44CC5LiK6ZmQ55qE5Y+W5rOV54Wn5oqE6ISa5pys55qE6buY6K6k5YC85YaN5pS+5a695LiA5qGj44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeVNlYXJjaChwYXlsb2FkOiB7IHF1ZXJ5Pzogc3RyaW5nOyBsaW1pdD86IG51bWJlcjsgcGVyU2Vzc2lvbj86IG51bWJlcjsgbWF4U2Vzc2lvbnM/OiBudW1iZXI7IGJ1ZGdldE1zPzogbnVtYmVyIH0gfCB1bmRlZmluZWQpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgY29uc3QgcXVlcnkgPSB0eXBlb2YgcGF5bG9hZD8ucXVlcnkgPT09ICdzdHJpbmcnID8gcGF5bG9hZC5xdWVyeS50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFxdWVyeSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2hpc3Rvcnktc2VhcmNo77ya5pCc57Si6K+N5piv56m655qEJyB9O1xuICAgICAgICBpZiAocXVlcnkubGVuZ3RoID4gMjAwKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaGlzdG9yeS1zZWFyY2jvvJrmkJzntKLor43lpKrplb/kuobvvIjmnIDlpJogMjAwIOWtl++8iScgfTtcbiAgICAgICAgcmV0dXJuIGhvc3QuaGlzdG9yeVNlYXJjaChxdWVyeSwge1xuICAgICAgICAgICAgbGltaXQ6IGNsYW1wTnVtYmVyKHBheWxvYWQ/LmxpbWl0LCAxLCA1MCwgMjApLFxuICAgICAgICAgICAgcGVyU2Vzc2lvbjogY2xhbXBOdW1iZXIocGF5bG9hZD8ucGVyU2Vzc2lvbiwgMSwgNiwgMyksXG4gICAgICAgICAgICBtYXhTZXNzaW9uczogY2xhbXBOdW1iZXIocGF5bG9hZD8ubWF4U2Vzc2lvbnMsIDEsIDUwMCwgMTUwKSxcbiAgICAgICAgICAgIGJ1ZGdldE1zOiBjbGFtcE51bWJlcihwYXlsb2FkPy5idWRnZXRNcywgNTAwLCAzMF8wMDAsIDZfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgfSxcblxuICAgIC8qKiDmiorkuIDmnaHljoblj7LkvJror53lr7zlh7rmiJDmlofku7bvvIhgbWRgIOi9rOWGmSAvIGBqc29ubGAg5Y6f5qC35pel5b+XIC8gYHppcGAg5a+56b2QIERTSCDnmoTpgqPkuIDku73vvInjgIIgKi9cbiAgICBhc3luYyBoaXN0b3J5RXhwb3J0KHBheWxvYWQ6IHsgc2Vzc2lvbklkPzogc3RyaW5nOyBmb3JtYXQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSBTdHJpbmcocGF5bG9hZD8uc2Vzc2lvbklkID8/ICcnKS50cmltKCk7XG4gICAgICAgIGlmICghc2Vzc2lvbklkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaGlzdG9yeS1leHBvcnTvvJrnvLrlsJEgc2Vzc2lvbklkJyB9O1xuICAgICAgICByZXR1cm4gaG9zdC5oaXN0b3J5RXhwb3J0KFxuICAgICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgICAgcGF5bG9hZD8uZm9ybWF0ID09PSAnanNvbmwnID8gJ2pzb25sJyA6IHBheWxvYWQ/LmZvcm1hdCA9PT0gJ3ppcCcgPyAnemlwJyA6ICdtZCcsXG4gICAgICAgICk7XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWIoOaOieS4gOadoeWOhuWPsuS8muivne+8iOS4jeW4piBgZHJ5UnVuYCDlsLHmmK/nnJ/liKDvvInjgIJcbiAgICAgKlxuICAgICAqIOKaoCDov5nkuIDmnaHmmK8qKuS4jeWPr+mAhioq55qE77yM5omA5Lul6Z2i5p2/55qE5rWB56iL5piv44CM54K5IPCfl5Eg4oaSIOS4u+i/m+eoiyBkcnktcnVuIOaKpea4heWNlSDihpJcbiAgICAgKiDpnaLmnb/mmL7npLrjgI7lsIbliKDpmaQgMSDkuKrmlofku7YgwrcgNzAgS0LjgI/ihpIg5YaN54K55LiA5qyh5omN5piv55yf5Yig44CN44CC5LqM5qyh56Gu6K6k5LiN5Zyo6L+Z5LiA5bGC77yMXG4gICAgICog5L2G6L+Z5LiA5bGC5L+d6K+BIGBkcnlSdW5gIOS4juecn+WIoOi1sOeahOaYryoq5ZCM5LiA5Lu95riF5Y2VKirvvIjlkIzkuIDkuKrohJrmnKzjgIHlkIzkuIDmrrXku6PnoIHvvInjgIJcbiAgICAgKlxuICAgICAqIGByZWNsYWltYCDmmK8qKumhuuW4puWbnuaUtuaXoOW8leeUqOmZhOS7tioq77yI6buY6K6k5YWz77yM6KeBIGBoaXN0b3J5LnRzYCDpgqPmrrXvvJrotoXpooTnrpflsLHkuIDkuKrpg73kuI3mkKzjgIFcbiAgICAgKiDmr4/kuKrlgJnpgInlpI3nrpcgc2hhMjU244CB5pe26Ze056qX5L+d5oqk44CB5Y+q5pCs5aKT56KR77yJ44CC5a6D5pivKirliIbpkp/nuqcqKuaTjeS9nO+8jFxuICAgICAqIOaJgOS7pSBkcnktcnVuIOmCo+S4gOi2n+S5n+imgeW4puS4iuWugyDigJTigJQg5ZCm5YiZ55So5oi355yL5LiN5Yiw44CM6KaB562J5aSa5LmF44CB5pyJ5Yeg5Liq5YCZ6YCJ44CN44CCXG4gICAgICovXG4gICAgYXN5bmMgaGlzdG9yeURlbGV0ZShwYXlsb2FkOiB7IHNlc3Npb25JZD86IHN0cmluZzsgZHJ5UnVuPzogYm9vbGVhbjsgcmVjbGFpbT86IGJvb2xlYW4gfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSBTdHJpbmcocGF5bG9hZD8uc2Vzc2lvbklkID8/ICcnKS50cmltKCk7XG4gICAgICAgIGlmICghc2Vzc2lvbklkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaGlzdG9yeS1kZWxldGXvvJrnvLrlsJEgc2Vzc2lvbklkJyB9O1xuICAgICAgICByZXR1cm4gaG9zdC5oaXN0b3J5RGVsZXRlKHNlc3Npb25JZCwgcGF5bG9hZD8uZHJ5UnVuID09PSB0cnVlLCBwYXlsb2FkPy5yZWNsYWltID09PSB0cnVlKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog6K+75b2T5YmN5Lya6K+d55qEKiror7vmlbAqKu+8mueUqOmHj++8iHRva2VuIOe0r+iuoSAvIOS4iuS4i+aWh+WNoOeUqCAvIOiKsei0ue+8iSsg6L+b5bqm77yI5riF5Y2VIC8g55uu5qCHIC8g5Zue5ZCI55uu5b2V77yJ44CCXG4gICAgICpcbiAgICAgKiDpnaLmnb/kuIrkuInmnaHmnaXot6/pg73kvJrmiZPliLDov5nph4zvvJrnlKjph4/mir3lsYnnmoTjgIzliLfmlrDjgI3jgIHov5vluqbmir3lsYnnmoTjgIzliLfmlrDjgI3vvIzku6Xlj4oqKuaJk+W8gOaKveWxiSoq5pe2XG4gICAgICog55qE6YKj5LiA5qyh44CC5bmz5pe25LiN6ZyA6KaB6Z2i5p2/5YKsIOKAlOKAlCDkuLvov5vnqIvlnKjlm57lkIjnu5PmnZ/vvIjnvJPlrZjmgbDlpb3lnKggYHR1cm4vZW5kYCDlhpnmo4Dmn6XngrnvvInkuI7ot5HlroxcbiAgICAgKiDmlpzmnaDlkb3ku6TvvIhgL2NvbXBhY3RgIOWwseaYr+mdoOWug+aJjeeci+W+l+WIsOWPmOWMlu+8ieS5i+WQjuiHquW3seS8muivu++8jOW5tui1sOW5v+aSreaOqOe7memdouadv+OAglxuICAgICAqXG4gICAgICog5Lik5p2h5Lic6KW/5LiA6LW357uZ55qE55CG55Sx77ya5a6D5Lus5ZyoKirlkIzkuIDku73mlofku7YqKumHjO+8iOS4gOasoeivu+ebmOOAgeS4gOasoeino+aekO+8ie+8jOiAjOS4lOWFseeUqOWQjOS4gOe7hFxuICAgICAqIOaWsOmynOW6puS6i+Wunu+8iOawtOS9jSAvIOiQveWQjuWkmuWwkSAvIOWGmeS6juS9leaXtu+8ieKAlOKAlCDliIbmiJDkuKTmrKHor7vkvJrlh7rnjrDkuKTovrnor7TnmoTmsLTkvY3kuI3kuIDmoLfjgIJcbiAgICAgKlxuICAgICAqIOi/meS4gOadoSoq5LiN6ZyA6KaBIG5vZGUg5o6i5rWLKirvvJrmipXlvbHnvJPlrZjmmK/mmI7mlocgSlNPTu+8jOS4u+i/m+eoi+iHquW3seivu+ebmOWwseihjFxuICAgICAqIO+8iOWvueavlO+8muS8muivneaXpeW/l+aYryB6c3Rk77yM5b+F6aG7IHNwYXduIOS4gOS4quWklumDqCBub2Rl77yJ44CCXG4gICAgICovXG4gICAgYXN5bmMgc2Vzc2lvblVzYWdlKCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gaG9zdC5yZWZyZXNoVXNhZ2UoKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog6K+7KirlvZPliY3kvJror53nmoTjgIzmtLvliqjjgI0qKu+8muWQjuWPsOS7u+WKoe+8iGpvYnPvvIkrIOWtkCBhZ2VudO+8iHN1YmFnZW50c++8ieOAglxuICAgICAqXG4gICAgICog5LiO55So6YePL+i/m+W6pumCo+S4pOadoSoq5Yi75oSP5LiN5ZCMKirvvJrpgqPkuKTkuKror7vnmoTmmK/no4Hnm5jkuIrnmoTmo4Dmn6XngrnvvIjmmI7mlocgSlNPTu+8jOS4u+i/m+eoi+iHquW3seivu+ebmOWwseihjO+8ie+8jFxuICAgICAqIOiAjOi/meS4pOWdlyoq5Y+q5rS75Zyo6L+Q6KGM5pe26L+b56iL55qE5YaF5a2Y6YeMKiog4oCU4oCUIOaJgOS7peWPquiDvei1sOaPkuS7tuaOp+WItuW4p+WAn+Wuv+S4u+eahOazqOWGjOihqFxuICAgICAqIO+8iOWQjOaWnOadoOWRveS7pOOAgWBAYCDot6/lvoTpgqPmnaHot6/vvInjgILkuZ/lm6DmraTvvJoqKmFnZW50IOayoeWcqOi3keWwseS7gOS5iOmDveeci+S4jeWIsCoq77yMXG4gICAgICog6L+Z5LiO44CM5Y6G5Y+y5Lya6K+d55qE55So6YeP54Wn5qC36IO955yL44CN5LiN5LiA5qC377yM6Z2i5p2/6KaB5aaC5a6e6K+044CCXG4gICAgICpcbiAgICAgKiDpnaLmnb/lj6rlnKgqKuaJk+W8gOOAjOa0u+WKqOOAjeaKveWxieaXtioq77yI5Lul5Y+K54K55Yi35paw5pe277yJ5omT6L+Z6YeM77yM5a6/5Li75LiN6LW35a6a5pe25ZmoIOKAlOKAlFxuICAgICAqIOi/meS4pOS4quacjeWKoeayoeacieWPr+iuoumYheeahOWPmOWMluS6i+S7tu+8iGpvYiDovpPlh7rnmoTlop7plb/kuI3op6blj5Hku7vkvZXpgJrnn6XvvInvvIxcbiAgICAgKiDoh6rlt7Hotbfova7or6Llj6rkvJrnmb3ng6cgSVBD44CCXG4gICAgICovXG4gICAgYXN5bmMgcGFuZWxBY3Rpdml0eSgpIHtcbiAgICAgICAgYXdhaXQgZW5zdXJlUmVhZHkoKTtcbiAgICAgICAgcmV0dXJuIGhvc3QucGFuZWxBY3Rpdml0eSgpO1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDkuK3mlq3kuIDkuKoqKuWtkCBhZ2VudCoqIOeahOW9k+WJjeS4gOi9ru+8iOmdouadv+S4iumCo+S4gOihjOeahOaMiemSru+8ieOAglxuICAgICAqXG4gICAgICog4pqgIOivreS5ieaYr+OAjOi/meS4gOi9ruWIq+WBmuS6huOAje+8jOS4jeaYr+OAjOadgOaOieWug+OAjeKAlOKAlCDkvJror53kuI7kuIrkuIvmlofpg73nlZnnnYDvvIjlkIzjgIzlgZzmraLmnKzova7jgI3vvInjgIJcbiAgICAgKi9cbiAgICBhc3luYyBzdWJhZ2VudEludGVycnVwdChwYXlsb2FkOiB7IHN1YmFnZW50SWQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gaG9zdC5zdWJhZ2VudEludGVycnVwdChwYXlsb2FkPy5zdWJhZ2VudElkKTtcbiAgICB9LFxuXG4gICAgLyoqIOivu+iuvue9ruOAgiAqL1xuICAgIGFzeW5jIGdldFNldHRpbmdzKCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IGdldFNldHRpbmdzKCkgfTtcbiAgICB9LFxuXG4gICAgLyoqIOaUueiuvue9ru+8iOaUueWujOmHjeaWsOaOoua1i+i/kOihjOaXtu+8jOiuqSBub2RlL2RzaCDot6/lvoTnq4vljbPnlJ/mlYjvvInjgIIgKi9cbiAgICBhc3luYyB1cGRhdGVTZXR0aW5ncyhwYXRjaDogdW5rbm93bikge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IHVwZGF0ZVNldHRpbmdzKEVYVEVOU0lPTl9OQU1FLCBwYXRjaCk7XG4gICAgICAgIGhvc3QucHJvYmVSdW50aW1lKCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXR0aW5ncyB9O1xuICAgIH0sXG5cbiAgICAvKiog5omL5bel5L+uIHByb2ZpbGXvvIjpnaLmnb/kuIrnmoTjgIzkv67lpI0gcHJvZmlsZeOAjeaMiemSru+8ieOAgiAqL1xuICAgIGFzeW5jIGluc3RhbGxQcm9maWxlKCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVSZWFkeSgpO1xuICAgICAgICByZXR1cm4gc3luY1Byb2ZpbGUoKTtcbiAgICB9LFxufTtcblxuLyoqIOaJqeWxleWKoOi9veaXtuinpuWPkeOAguS4jSBhd2FpdCDlvILmraXliJ3lp4vljJbvvIhDb2NvcyDkuI3nrYnvvInjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge1xuICAgIGNvbnNvbGUubG9nKGBbZHNoX2NoYXRdIOaJqeWxleW3suWKoOi9vSB2JHtFWFRFTlNJT05fVkVSU0lPTn1gKTtcbiAgICB2b2lkIGVuc3VyZVJlYWR5KCk7XG59XG5cbi8qKiDmianlsZXljbjovb3ml7bop6blj5Eg4oCU4oCUIOW/hemhu+aKiuWtkOi/m+eoi+aUtuW5suWHgO+8jOWQpuWImeS8mueVmeS4i+WtpOWEvyBub2RlIOi/m+eoi+OAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcbiAgICB2b2lkIGhvc3QuZGlzcG9zZSgpO1xuICAgIGNvbnNvbGUubG9nKCdbZHNoX2NoYXRdIOaJqeWxleW3suWNuOi9ve+8jGFnZW50IOW3suWBnOatoicpO1xufVxuIl19