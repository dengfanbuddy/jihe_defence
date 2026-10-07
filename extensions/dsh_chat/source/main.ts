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

import { join } from 'path';

import { EXTENSION_NAME, EXTENSION_VERSION } from './constants';
import { DshHost } from './dsh-host';
import {
    MAX_LISTED_IMAGES,
    dbUrlToPath,
    formatBytes,
    isImagePath,
    mergeProjectImages,
    projectImagesFromAssetDb,
    readImageFile,
    scanImageFiles,
    validateImageBatch,
    type ProjectImage,
} from './images';
import { getSettings, loadSettings, updateSettings } from './settings';

/** 安装报告里给面板看的字段。 */
interface InstallReport {
    ok: boolean;
    profileDir?: string;
    version?: string;
    changes?: string[];
    /** 运行期依赖校验 —— 缺 bundle 时 profile「装好了」但 4 个工具会整体加载失败。 */
    deps?: { ok: boolean; root: string; missing: string[] };
    /** 安装器给出的、必须让用户看见的警告。 */
    warnings?: string[];
    error?: string;
}

/**
 * 安装器是 **CommonJS**（`scripts/install-profile.js`），这里直接 `require`。
 *
 * ⚠ **踩过的坑**：它原来是 ESM `.mjs`，用 `await import()` 加载 —— 但本扩展按
 * `module: CommonJS` 编译，**TypeScript 会把 `import()` 降级成 `require()`**，
 * 于是运行时拿 `file:///...` 的 URL 去 require，报 `Cannot find module 'file:///...'`。
 * 因为外面有 try/catch，它只变成一行 warning（症状是「profile 一直没同步，但没人知道」）。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../scripts/install-profile.js') as {
    installProfile: (options?: object) => InstallReport;
};

/** 唯一的 agent 宿主。 */
const host = new DshHost();

/** 初始化只跑一次。 */
let readyPromise: Promise<void> | null = null;

/** 最近一次 profile 同步的结果（面板要显示失败原因，不能只吞进日志）。 */
let lastInstall: InstallReport | null = null;

/** 面板自检回传的最近几条（见 `methods.panelProbe`）。 */
const panelProbes: Array<{ at: number; data: Record<string, unknown> }> = [];

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
function extensionRoot(): string {
    return join(__dirname, '..');
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
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, number));
}

/**
 * 幂等地把工程里的 `dsh-profile/` 同步到 `$DSH_HOME/profiles/cocos/`。
 *
 * @returns 安装报告；失败不抛（它不该挡住整个扩展，但**必须**能被面板看见）。
 */
function syncProfile(): InstallReport {
    try {
        const report = installer.installProfile();
        console.log(
            `[dsh_chat] profile ${report.version} 已就位：${report.profileDir}` +
                (report.changes?.length ? `（${report.changes.length} 处变更）` : '（无变更）'),
        );
        // ⚠ 别在这里写死 `ok: true`。profile 文件装好了 ≠ 这台机器能用：
        // 缺 `dsh-base` / `dsh-sdk-app` 时 profile 看起来一切正常，而模型手里 4 个工具全没了
        // （要等 initialize 超时或报"未知的编辑器方法"才发现）。所以 ok 反映的是**可用性**，
        // 并把原因写进 `error`（面板已有显示失败原因的那条路）。
        const depsOk = report.deps ? report.deps.ok : true;
        for (const line of report.warnings ?? []) console.warn(`[dsh_chat] ⚠ ${line}`);
        lastInstall = {
            ...report,
            ok: depsOk,
            error: depsOk ? undefined : (report.warnings ?? []).join(' '),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[dsh_chat] 同步 profile 失败：${message}`);
        lastInstall = { ok: false, error: message };
    }
    return lastInstall;
}

/** 初始化：读设置 → 探测运行时 → 装 profile。只跑一次。 */
function ensureReady(): Promise<void> {
    if (!readyPromise) {
        readyPromise = (async () => {
            await loadSettings(EXTENSION_NAME);
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
async function openBesideInspector(): Promise<{ ok: boolean; action?: string; error?: string }> {
    try {
        if (await Editor.Panel.openBeside('inspector', EXTENSION_NAME)) {
            return { ok: true, action: 'beside-inspector' };
        }
    } catch (error) {
        console.warn(`[dsh_chat] openBeside 失败，改用浮动窗口：${String(error)}`);
    }
    try {
        await Editor.Panel.open(EXTENSION_NAME);
        return { ok: true, action: 'floating' };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** 对外方法（必须与 package.json 的 `contributions.messages` 一一对应）。 */
export const methods: { [key: string]: (...args: any[]) => any } = {
    /** 打开面板（菜单项用）。已经开着就聚焦，没开就**停在 Inspector 旁边**。 */
    async openPanel() {
        try {
            if (await Editor.Panel.has(EXTENSION_NAME)) {
                await Editor.Panel.focus(EXTENSION_NAME);
                return { ok: true, action: 'focused' };
            }
        } catch {
            /* 探测失败就直接往下走去打开 */
        }
        return openBesideInspector();
    },

    /** 强制停靠到 Inspector 旁边（面板已经浮着时用：先关再在旁边开）。 */
    async dockPanel() {
        try {
            if (await Editor.Panel.has(EXTENSION_NAME)) {
                await Editor.Panel.close(EXTENSION_NAME);
                // 关闭到 reopen 之间给编辑器一点时间（实测不留这一下会偶发失败）
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        } catch {
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
            extension: { name: EXTENSION_NAME, version: EXTENSION_VERSION, root: extensionRoot() },
            agent: host.snapshot(),
            settings: getSettings(),
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
    async panelProbe(payload: unknown) {
        const entry = {
            at: Date.now(),
            data: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : { raw: payload },
        };
        panelProbes.push(entry);
        while (panelProbes.length > PANEL_PROBE_LIMIT) panelProbes.shift();
        const summary = JSON.stringify(entry.data).slice(0, 400);
        console.log(`[dsh_chat] 面板自检：${summary}`);
        return { ok: true };
    },

    /** 增量拉取转写（广播丢了也能靠它追平）。 */
    async getEvents(payload: { since?: number } | undefined) {
        await ensureReady();
        // 只有面板会调这个方法 —— 计数就是「面板在不在轮询」的地面真相（排查用）
        panelPoll.count += 1;
        panelPoll.lastAt = Date.now();
        // 同一条事实还有个用途：交互（提问/授权）到达时判断「有没有人能回答」。
        // 面板不在就立刻放行，别让模型干等 —— 见 DshHost.gateInteraction 的注释。
        host.notePanelActivity();
        const since = Number(payload?.since ?? 0);
        return { ok: true, ...host.eventsSince(Number.isFinite(since) ? since : 0) };
    },

    /**
     * 回答一次「需要人拍板」的交互（面板上那块对话框：模型提问 / 授权请求 / 计划评审）。
     *
     * 形状校验在 `DshHost.answerInteraction` 里（面板是渲染进程，它说的不可信）；
     * 失败**不抛**，回一句人话让面板原样显示（同 `sendMessage` 的口径）。
     */
    async interactionAnswer(payload: unknown) {
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
    async commandRun(payload: { line?: unknown } | undefined) {
        await ensureReady();
        return host.runCommand(payload?.line);
    },

    /** 列 `@路径` 候选（面板的 `@` 补全；边打字边问，所以这条路要便宜）。 */
    async fileReference(payload: { query?: unknown } | undefined) {
        await ensureReady();
        return host.fileReference(payload?.query);
    },

    /** 发一条用户消息（文本 + 可选图片）。 */
    async sendMessage(payload: { text?: string; images?: unknown } | undefined) {
        await ensureReady();
        // 图片在这一层再验一遍：面板是渲染进程，它说的内容不可信（同 `panelProbe` 的口径）。
        // 校验失败**不抛**，回一句人话让面板原样显示。
        const checked = validateImageBatch(payload?.images);
        if (checked.ok === false) return { ok: false, error: checked.error };
        return host.send(String(payload?.text ?? ''), checked.images);
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
        let source: 'asset-db' | 'scan' = 'asset-db';
        let primary: ProjectImage[] = [];
        try {
            const rows = await Editor.Message.request(
                'asset-db',
                'query-assets',
                { pattern: 'db://assets/**/*' },
                ['url', 'name', 'displayName', 'uuid', 'file', 'mtime'],
            );
            primary = projectImagesFromAssetDb(rows, projectPath);
        } catch (error) {
            console.warn(`[dsh_chat] 资源库查询失败，改用目录扫描：${error instanceof Error ? error.message : String(error)}`);
        }

        let fallback: ProjectImage[] = [];
        if (primary.length === 0) {
            source = 'scan';
            fallback = scanImageFiles(join(projectPath, 'assets'), MAX_LISTED_IMAGES).map((file) => ({
                url: `db://assets/${file.rel}`,
                path: file.path,
                name: file.name,
                bytes: file.bytes,
                rel: `assets/${file.rel}`,
                source: 'scan' as const,
            }));
        }

        const images = mergeProjectImages(primary, fallback, MAX_LISTED_IMAGES);
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
    async readImage(payload: { url?: string; path?: string } | undefined) {
        await ensureReady();
        const projectPath = Editor.Project.path;
        const rawUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
        let file = rawPath;
        if (!file && rawUrl.startsWith('db://')) {
            const mapped = dbUrlToPath(projectPath, rawUrl);
            if (!mapped) return { ok: false, error: `这个资源地址映射不到文件：${rawUrl}` };
            file = mapped;
        }
        if (!file) return { ok: false, error: 'read-image：缺少 url 或 path' };
        if (!isImagePath(file)) return { ok: false, error: `不是认得的图片：${file}` };

        // 只允许读**工程内**的图片：面板传来的路径要当输入不可信处理（同 sendMessage 的口径）。
        const root = join(projectPath, '').replace(/[\\/]+$/, '');
        if (!file.startsWith(root)) {
            return { ok: false, error: `只能读工程目录内的图片（${root} 之外的一律拒绝）：${file}` };
        }

        const result = readImageFile(file, { projectPath });
        if (!result.ok) return result;
        console.log(`[dsh_chat] 读图 ${result.name}（${formatBytes(result.bytes)}）→ ${result.mimeType}`);
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
    async historyList(payload: { limit?: number } | undefined) {
        await ensureReady();
        const limit = Number(payload?.limit ?? 20);
        return { ok: true, ...(await host.historyList(Number.isFinite(limit) && limit > 0 ? Math.min(100, limit) : 20)) };
    },

    /** 把一条历史会话回放到对话区（只读；接着聊要再调 history-resume）。 */
    async historyOpen(payload: { sessionId?: string } | undefined) {
        await ensureReady();
        const sessionId = String(payload?.sessionId ?? '').trim();
        if (!sessionId) return { ok: false, error: 'history-open：缺少 sessionId' };
        return { ok: true, ...(await host.loadHistory(sessionId)) };
    },

    /** **接上**一条历史会话（插件 `agents.resume`）——之后的消息带着它的上下文。 */
    async historyResume(payload: { sessionId?: string } | undefined) {
        await ensureReady();
        const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : undefined;
        return { ok: true, ...(await host.resumeHistory(sessionId)) };
    },

    /**
     * 在**所有**历史会话里做全文搜索（面板历史抽屉里的「搜全文」）。
     *
     * 预算是**面板传上来的**（面板知道自己在等多久），这一层只做上限收敛：
     * 谁都能调 `Editor.Message.request`，不能让它拿着一份 `--max-sessions=100000` 把
     * 磁盘扫穿。上限的取法照抄脚本的默认值再放宽一档。
     */
    async historySearch(payload: { query?: string; limit?: number; perSession?: number; maxSessions?: number; budgetMs?: number } | undefined) {
        await ensureReady();
        const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
        if (!query) return { ok: false, error: 'history-search：搜索词是空的' };
        if (query.length > 200) return { ok: false, error: 'history-search：搜索词太长了（最多 200 字）' };
        return host.historySearch(query, {
            limit: clampNumber(payload?.limit, 1, 50, 20),
            perSession: clampNumber(payload?.perSession, 1, 6, 3),
            maxSessions: clampNumber(payload?.maxSessions, 1, 500, 150),
            budgetMs: clampNumber(payload?.budgetMs, 500, 30_000, 6_000),
        });
    },

    /** 把一条历史会话导出成文件（`md` 转写 / `jsonl` 原样日志 / `zip` 对齐 DSH 的那一份）。 */
    async historyExport(payload: { sessionId?: string; format?: string } | undefined) {
        await ensureReady();
        const sessionId = String(payload?.sessionId ?? '').trim();
        if (!sessionId) return { ok: false, error: 'history-export：缺少 sessionId' };
        return host.historyExport(
            sessionId,
            payload?.format === 'jsonl' ? 'jsonl' : payload?.format === 'zip' ? 'zip' : 'md',
        );
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
    async historyDelete(payload: { sessionId?: string; dryRun?: boolean; reclaim?: boolean } | undefined) {
        await ensureReady();
        const sessionId = String(payload?.sessionId ?? '').trim();
        if (!sessionId) return { ok: false, error: 'history-delete：缺少 sessionId' };
        return host.historyDelete(sessionId, payload?.dryRun === true, payload?.reclaim === true);
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
    async subagentInterrupt(payload: { subagentId?: string } | undefined) {
        await ensureReady();
        return host.subagentInterrupt(payload?.subagentId);
    },

    /** 读设置。 */
    async getSettings() {
        await ensureReady();
        return { ok: true, settings: getSettings() };
    },

    /** 改设置（改完重新探测运行时，让 node/dsh 路径立即生效）。 */
    async updateSettings(patch: unknown) {
        await ensureReady();
        const settings = await updateSettings(EXTENSION_NAME, patch);
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
export function load(): void {
    console.log(`[dsh_chat] 扩展已加载 v${EXTENSION_VERSION}`);
    void ensureReady();
}

/** 扩展卸载时触发 —— 必须把子进程收干净，否则会留下孤儿 node 进程。 */
export function unload(): void {
    void host.dispose();
    console.log('[dsh_chat] 扩展已卸载，agent 已停止');
}
