"use strict";
/**
 * 历史会话：把 DSH 的会话日志**列出来**、**读回来**。
 *
 * ## 日志在哪、长什么样
 *
 * ```
 * <DSH_HOME>/sessions/<工程键>/<会话 id>/session[.v4].jsonl.zstd
 * ```
 *
 * 「工程键」是 DSH 的 `projectKey(cwd)`（`D:\Project\cocos\jihe_defence` →
 * `--D-Project-cocos-jihe_defence--`）。文件是 **zstd 拼接帧**容器。
 *
 * ## 为什么要 spawn 一个 node 子进程来读
 *
 * 解压要 `node:zlib` 的 zstd API，那是 **Node ≥ 22.15** 才有的；而**编辑器主进程跑在
 * Electron 31（Node 20.15）里，没有这个 API**。所以解压这件事只能交给外面那个 node
 * （`paths.ts` 探测出来的、也是用来跑 dsh 的那个），主进程只负责「找到文件、决定读哪个」。
 * 真正干活的脚本是 `scripts/session-log.js`（帧扫描照抄 DSH 的实现，见那边的注释）。
 *
 * ## 为什么不用 DSH 自己的接口
 *
 * SDK profile 的协议只有 `initialize` / `session/prompt` / `shutdown`：
 * **没有任何「列会话 / 读日志」的方法**（`dsh-session-query`、`dsh-session-log-export`
 * 这些包都是给宿主进程内部的 cordis 上下文用的，不是给 SDK 客户端的）。
 * 好在日志是**明文可读的 JSONL**，直接读盘反而更稳：**agent 没在跑的时候也能看历史**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectKey = projectKey;
exports.sessionsRoot = sessionsRoot;
exports.listHistory = listHistory;
exports.readHistory = readHistory;
exports.titleOfEvents = titleOfEvents;
const child_process_1 = require("child_process");
const os_1 = require("os");
const path_1 = require("path");
/** 单次 spawn 的上限：读 5MB 日志实测亚秒级，给足余量。 */
const READER_TIMEOUT_MS = 20000;
/**
 * DSH 的工程键（**照抄** `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey`）。
 *
 * 规则：`/` `\` `:` 折叠成一个 `-`；`[A-Za-z0-9._-]` 原样；其余字符转义成 `~XXXX`（大写十六进制）；
 * 最后包成 `--…--`，截断到 251 字符。
 *
 * @param cwd - 工程根目录。
 * @returns 会话根目录下的工程子目录名。
 */
function projectKey(cwd) {
    if (!cwd)
        throw new Error('projectKey：工程路径是空的');
    let readable = '';
    let separatorRun = false;
    for (let index = 0; index < cwd.length; index += 1) {
        const code = cwd.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun)
                readable += '-';
            separatorRun = true;
        }
        else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        }
        else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
/** `<DSH_HOME>/sessions`（`DSH_HOME` 没设就按 `~/.dsh`，与 DSH 自己同口径）。 */
function sessionsRoot() {
    var _a;
    const home = (_a = process.env.DSH_HOME) === null || _a === void 0 ? void 0 : _a.trim();
    return (0, path_1.join)(home && home !== '' ? home : (0, path_1.join)((0, os_1.homedir)(), '.dsh'), 'sessions');
}
/** 读取器脚本的路径（`dist/history.js` → `<扩展根>/scripts/session-log.js`）。 */
function readerPath() {
    return (0, path_1.resolve)(__dirname, '..', 'scripts', 'session-log.js');
}
/** 把异常收敛成一句话。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 跑一次读取器，返回它 stdout 上那行 JSON。
 *
 * ⚠ 参数用**数组**传（不经 shell）：工程键本身以 `--` 开头，任何字符串拼接/命令行解析都会踩坑。
 */
function runReader(nodeExe, args) {
    return new Promise((resolvePromise, rejectPromise) => {
        var _a, _b, _c, _d;
        let child;
        try {
            child = (0, child_process_1.spawn)(nodeExe, [readerPath(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            rejectPromise(new Error(`启动 node 读会话日志失败：${describe(error)}`));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill();
            }
            catch {
                /* 已经退了 */
            }
            rejectPromise(new Error(`读会话日志超时（${READER_TIMEOUT_MS}ms）`));
        }, READER_TIMEOUT_MS);
        (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding('utf8');
        (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.setEncoding('utf8');
        (_c = child.stdout) === null || _c === void 0 ? void 0 : _c.on('data', (chunk) => {
            stdout += chunk;
            // 一份日志的投影不该超过这个量级；超了就是哪儿不对，别把主进程撑爆
            if (stdout.length > 64 * 1024 * 1024) {
                try {
                    child.kill();
                }
                catch {
                    /* 忽略 */
                }
            }
        });
        (_d = child.stderr) === null || _d === void 0 ? void 0 : _d.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new Error(`读会话日志失败：${describe(error)}`));
        });
        child.on('close', () => {
            var _a;
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const line = (_a = stdout.trim().split('\n').pop()) !== null && _a !== void 0 ? _a : '';
            try {
                resolvePromise(JSON.parse(line));
            }
            catch {
                rejectPromise(new Error(`读会话日志的输出不是 JSON：${line.slice(0, 200) || '(空)'}` +
                    (stderr ? `；stderr：${stderr.trim().slice(0, 200)}` : '')));
            }
        });
    });
}
/** 缺 node 时的统一文案（这不是「没装 dsh」那么明显，说清楚为什么读不了）。 */
const NO_NODE_HINT = '读会话日志需要一个 **Node ≥ 22.15**（日志是 zstd 压缩的，编辑器自带的 Electron/Node 20 解不开）。' +
    '请在设置里填「node 路径」，或把 node 加到 PATH。';
/**
 * 列出本工程的历史会话（按最后修改时间倒序）。
 *
 * @param nodeExe - 用来跑读取器的 node（`paths.ts` 探测出来的那个）。
 * @param cwd - 工程根目录。
 * @param limit - 最多几条。
 * @returns `{ok, sessions?, error?}`；失败不抛，让面板能显示原因。
 */
async function listHistory(nodeExe, cwd, limit = 20) {
    var _a;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    try {
        const payload = await runReader(nodeExe, [
            'list',
            '--root',
            sessionsRoot(),
            '--project',
            projectKey(cwd),
            '--limit',
            String(limit),
        ]);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '读取器返回失败') };
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        return { ok: true, sessions };
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/**
 * 读一个会话的事件（回放用）。
 *
 * @param nodeExe - 用来跑读取器的 node。
 * @param cwd - 工程根目录。
 * @param sessionId - 会话 id。
 * @param maxEvents - 最多保留多少条（从尾部保留）。
 * @returns `{ok, events?, error?}`。
 */
async function readHistory(nodeExe, cwd, sessionId, maxEvents = 2000) {
    var _a, _b;
    if (!nodeExe)
        return { ok: false, error: NO_NODE_HINT };
    if (!sessionId)
        return { ok: false, error: 'readHistory：会话 id 是空的' };
    try {
        const payload = await runReader(nodeExe, [
            'read',
            '--root',
            sessionsRoot(),
            '--project',
            projectKey(cwd),
            '--id',
            sessionId,
            '--max-events',
            String(maxEvents),
        ]);
        if (payload.ok !== true)
            return { ok: false, error: String((_a = payload.error) !== null && _a !== void 0 ? _a : '读取器返回失败') };
        return {
            ok: true,
            header: ((_b = payload.header) !== null && _b !== void 0 ? _b : null),
            events: Array.isArray(payload.events) ? payload.events : [],
            total: typeof payload.total === 'number' ? payload.total : undefined,
            frameCount: typeof payload.frameCount === 'number' ? payload.frameCount : undefined,
            torn: payload.torn === true,
        };
    }
    catch (error) {
        return { ok: false, error: describe(error) };
    }
}
/**
 * 从事件流里取一条「像标题」的首条用户消息（列表接口给了标题，回放路径要自己算一遍）。
 *
 * @param events - `readHistory` 返回的事件。
 * @returns 标题（最多 80 字）；取不到返回空串。
 */
function titleOfEvents(events) {
    var _a, _b, _c;
    for (const event of events) {
        if (event.type !== 'user/message')
            continue;
        const data = ((_a = event.data) !== null && _a !== void 0 ? _a : {});
        const source = data.source;
        if (source && source.kind !== 'user')
            continue;
        const content = ((_b = data.content) !== null && _b !== void 0 ? _b : (_c = data.message) === null || _c === void 0 ? void 0 : _c.content);
        if (!Array.isArray(content))
            continue;
        const text = content
            .filter((block) => {
            const candidate = block;
            return (candidate === null || candidate === void 0 ? void 0 : candidate.type) === 'text' && typeof candidate.text === 'string';
        })
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text)
            return text.slice(0, 80);
    }
    return '';
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGlzdG9yeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9oaXN0b3J5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXlCRzs7QUFrREgsZ0NBbUJDO0FBR0Qsb0NBR0M7QUFvR0Qsa0NBc0JDO0FBV0Qsa0NBZ0NDO0FBUUQsc0NBb0JDO0FBMVFELGlEQUFzQztBQUN0QywyQkFBNkI7QUFDN0IsK0JBQXFDO0FBa0NyQyx1Q0FBdUM7QUFDdkMsTUFBTSxpQkFBaUIsR0FBRyxLQUFNLENBQUM7QUFFakM7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFnQixVQUFVLENBQUMsR0FBVztJQUNsQyxJQUFJLENBQUMsR0FBRztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUNoRCxJQUFJLFFBQVEsR0FBRyxFQUFFLENBQUM7SUFDbEIsSUFBSSxZQUFZLEdBQUcsS0FBSyxDQUFDO0lBQ3pCLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxHQUFHLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqRCxNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25DLE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsSUFBSSxFQUFFLEtBQUssR0FBRyxJQUFJLEVBQUUsS0FBSyxJQUFJLElBQUksRUFBRSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQzFDLElBQUksQ0FBQyxZQUFZO2dCQUFFLFFBQVEsSUFBSSxHQUFHLENBQUM7WUFDbkMsWUFBWSxHQUFHLElBQUksQ0FBQztRQUN4QixDQUFDO2FBQU0sSUFBSSxFQUFFLEtBQUssR0FBRyxJQUFJLGtCQUFrQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQ25E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RyxDQUFDLE1BQUEsSUFBSSxDQUFDLE9BQU8sbUNBQUksTUFBQyxJQUFJLENBQUMsT0FBNkMsMENBQUUsT0FBTyxDQUFZLENBQUM7UUFDMUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDO1lBQUUsU0FBUztRQUN0QyxNQUFNLElBQUksR0FBRyxPQUFPO2FBQ2YsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUEyQyxFQUFFO1lBQ3ZELE1BQU0sU0FBUyxHQUFHLEtBQTBDLENBQUM7WUFDN0QsT0FBTyxDQUFBLFNBQVMsYUFBVCxTQUFTLHVCQUFULFNBQVMsQ0FBRSxJQUFJLE1BQUssTUFBTSxJQUFJLE9BQU8sU0FBUyxDQUFDLElBQUksS0FBSyxRQUFRLENBQUM7UUFDNUUsQ0FBQyxDQUFDO2FBQ0QsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDO2FBQzFCLElBQUksQ0FBQyxHQUFHLENBQUM7YUFDVCxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQzthQUNwQixJQUFJLEVBQUUsQ0FBQztRQUNaLElBQUksSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUNELE9BQU8sRUFBRSxDQUFDO0FBQ2QsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog5Y6G5Y+y5Lya6K+d77ya5oqKIERTSCDnmoTkvJror53ml6Xlv5cqKuWIl+WHuuadpSoq44CBKiror7vlm57mnaUqKuOAglxuICpcbiAqICMjIOaXpeW/l+WcqOWTquOAgemVv+S7gOS5iOagt1xuICpcbiAqIGBgYFxuICogPERTSF9IT01FPi9zZXNzaW9ucy885bel56iL6ZSuPi885Lya6K+dIGlkPi9zZXNzaW9uWy52NF0uanNvbmwuenN0ZFxuICogYGBgXG4gKlxuICog44CM5bel56iL6ZSu44CN5pivIERTSCDnmoQgYHByb2plY3RLZXkoY3dkKWDvvIhgRDpcXFByb2plY3RcXGNvY29zXFxqaWhlX2RlZmVuY2VgIOKGklxuICogYC0tRC1Qcm9qZWN0LWNvY29zLWppaGVfZGVmZW5jZS0tYO+8ieOAguaWh+S7tuaYryAqKnpzdGQg5ou85o6l5binKirlrrnlmajjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjopoEgc3Bhd24g5LiA5LiqIG5vZGUg5a2Q6L+b56iL5p2l6K+7XG4gKlxuICog6Kej5Y6L6KaBIGBub2RlOnpsaWJgIOeahCB6c3RkIEFQSe+8jOmCo+aYryAqKk5vZGUg4omlIDIyLjE1Kiog5omN5pyJ55qE77yb6ICMKirnvJbovpHlmajkuLvov5vnqIvot5HlnKhcbiAqIEVsZWN0cm9uIDMx77yITm9kZSAyMC4xNe+8iemHjO+8jOayoeaciei/meS4qiBBUEkqKuOAguaJgOS7peino+WOi+i/meS7tuS6i+WPquiDveS6pOe7meWklumdoumCo+S4qiBub2RlXG4gKiDvvIhgcGF0aHMudHNgIOaOoua1i+WHuuadpeeahOOAgeS5n+aYr+eUqOadpei3kSBkc2gg55qE6YKj5Liq77yJ77yM5Li76L+b56iL5Y+q6LSf6LSj44CM5om+5Yiw5paH5Lu244CB5Yaz5a6a6K+75ZOq5Liq44CN44CCXG4gKiDnnJ/mraPlubLmtLvnmoTohJrmnKzmmK8gYHNjcmlwdHMvc2Vzc2lvbi1sb2cuanNg77yI5bin5omr5o+P54Wn5oqEIERTSCDnmoTlrp7njrDvvIzop4HpgqPovrnnmoTms6jph4rvvInjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjkuI3nlKggRFNIIOiHquW3seeahOaOpeWPo1xuICpcbiAqIFNESyBwcm9maWxlIOeahOWNj+iuruWPquaciSBgaW5pdGlhbGl6ZWAgLyBgc2Vzc2lvbi9wcm9tcHRgIC8gYHNodXRkb3duYO+8mlxuICogKirmsqHmnInku7vkvZXjgIzliJfkvJror50gLyDor7vml6Xlv5fjgI3nmoTmlrnms5UqKu+8iGBkc2gtc2Vzc2lvbi1xdWVyeWDjgIFgZHNoLXNlc3Npb24tbG9nLWV4cG9ydGBcbiAqIOi/meS6m+WMhemDveaYr+e7meWuv+S4u+i/m+eoi+WGhemDqOeahCBjb3JkaXMg5LiK5LiL5paH55So55qE77yM5LiN5piv57uZIFNESyDlrqLmiLfnq6/nmoTvvInjgIJcbiAqIOWlveWcqOaXpeW/l+aYryoq5piO5paH5Y+v6K+755qEIEpTT05MKirvvIznm7TmjqXor7vnm5jlj43ogIzmm7TnqLPvvJoqKmFnZW50IOayoeWcqOi3keeahOaXtuWAmeS5n+iDveeci+WOhuWPsioq44CCXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdvcyc7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XG5cbi8qKiDkuIDmnaHljoblj7LkvJror53nmoTmkZjopoHvvIjpnaLmnb/liJfooajnlKjvvInjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGlzdG9yeVNlc3Npb24ge1xuICAgIC8qKiDkvJror50gaWTvvIjlkIzml7bkuZ/mmK8gRFNIIOS+p+aBouWkjeS8muivneeUqOeahCBrZXnvvInjgIIgKi9cbiAgICBpZDogc3RyaW5nO1xuICAgIC8qKiDpppbmnaHnlKjmiLfmtojmga/vvIjmi7/kuI3liLDlsLHmmK/nqbrkuLLvvInjgIIgKi9cbiAgICB0aXRsZTogc3RyaW5nO1xuICAgIC8qKiDkvJror53liJvlu7rml7bliLvvvIjmnaXoh6rml6Xlv5flpLTvvInjgIIgKi9cbiAgICBjcmVhdGVkQXQ6IG51bWJlciB8IG51bGw7XG4gICAgLyoqIOaXpeW/l+acgOWQjuWGmeWFpeaXtuWIu+OAgiAqL1xuICAgIHVwZGF0ZWRBdDogbnVtYmVyO1xuICAgIC8qKiDml6Xlv5flrZfoioLmlbDjgIIgKi9cbiAgICBieXRlczogbnVtYmVyO1xuICAgIC8qKiDml6Xlv5fph4zlh7rnjrDov4flpJrlsJHkuKrlm57lkIjvvIhgdHVybi9zdGFydGAg6K6h5pWw77yJ44CCICovXG4gICAgdHVybnM6IG51bWJlcjtcbn1cblxuLyoqIOivu+aXpeW/l+eahOe7k+aenOOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBIaXN0b3J5UmVhZFJlc3VsdCB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgLyoqIOaXpeW/l+WktO+8iOWQqyBgaWRgIC8gYGN3ZGAgLyBgY3JlYXRlZEF0YO+8ieOAgiAqL1xuICAgIGhlYWRlcj86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbiAgICAvKiog5L+d55WZ5LqG5ZOq5Lqb5LqL5Lu277yIYHVzZXIvbWVzc2FnZWAgLyBgYXNzaXN0YW50L21lc3NhZ2VgIC8gYHRvb2wvY2FsbGAgLyBgdG9vbC9yZXN1bHRgIOKApu+8ieOAgiAqL1xuICAgIGV2ZW50cz86IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgICAvKiog5LqL5Lu25oC75pWw77yI5oiq5pat5YmN77yJ44CCICovXG4gICAgdG90YWw/OiBudW1iZXI7XG4gICAgLyoqIHpzdGQg5bin5pWw77yI6K+K5pat55So77yJ44CCICovXG4gICAgZnJhbWVDb3VudD86IG51bWJlcjtcbiAgICAvKiog5pyr5bC+5piv5ZCm5pyJ5Y2K5Liq5bin77yI5bSp5rqDL+ato+WcqOWGme+8ieOAgiAqL1xuICAgIHRvcm4/OiBib29sZWFuO1xufVxuXG4vKiog5Y2V5qyhIHNwYXduIOeahOS4iumZkO+8muivuyA1TUIg5pel5b+X5a6e5rWL5Lqa56eS57qn77yM57uZ6Laz5L2Z6YeP44CCICovXG5jb25zdCBSRUFERVJfVElNRU9VVF9NUyA9IDIwXzAwMDtcblxuLyoqXG4gKiBEU0gg55qE5bel56iL6ZSu77yIKirnhafmioQqKiBgQGRlZXBzZWVrLWFpL2RzaC1zZXNzaW9uLXBlcnNpc3RlbmNlLWpzb25sYCDnmoQgYHByb2plY3RLZXlg77yJ44CCXG4gKlxuICog6KeE5YiZ77yaYC9gIGBcXGAgYDpgIOaKmOWPoOaIkOS4gOS4qiBgLWDvvJtgW0EtWmEtejAtOS5fLV1gIOWOn+agt++8m+WFtuS9meWtl+espui9rOS5ieaIkCBgflhYWFhg77yI5aSn5YaZ5Y2B5YWt6L+b5Yi277yJ77ybXG4gKiDmnIDlkI7ljIXmiJAgYC0t4oCmLS1g77yM5oiq5pat5YiwIDI1MSDlrZfnrKbjgIJcbiAqXG4gKiBAcGFyYW0gY3dkIC0g5bel56iL5qC555uu5b2V44CCXG4gKiBAcmV0dXJucyDkvJror53moLnnm67lvZXkuIvnmoTlt6XnqIvlrZDnm67lvZXlkI3jgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb2plY3RLZXkoY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghY3dkKSB0aHJvdyBuZXcgRXJyb3IoJ3Byb2plY3RLZXnvvJrlt6XnqIvot6/lvoTmmK/nqbrnmoQnKTtcbiAgICBsZXQgcmVhZGFibGUgPSAnJztcbiAgICBsZXQgc2VwYXJhdG9yUnVuID0gZmFsc2U7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGN3ZC5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgICAgY29uc3QgY29kZSA9IGN3ZC5jaGFyQ29kZUF0KGluZGV4KTtcbiAgICAgICAgY29uc3QgY2ggPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpO1xuICAgICAgICBpZiAoY2ggPT09ICcvJyB8fCBjaCA9PT0gJ1xcXFwnIHx8IGNoID09PSAnOicpIHtcbiAgICAgICAgICAgIGlmICghc2VwYXJhdG9yUnVuKSByZWFkYWJsZSArPSAnLSc7XG4gICAgICAgICAgICBzZXBhcmF0b3JSdW4gPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGNoICE9PSAnficgJiYgL15bQS1aYS16MC05Ll8tXSQvLnRlc3QoY2gpKSB7XG4gICAgICAgICAgICByZWFkYWJsZSArPSBjaDtcbiAgICAgICAgICAgIHNlcGFyYXRvclJ1biA9IGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVhZGFibGUgKz0gYH4ke2NvZGUudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKCkucGFkU3RhcnQoNCwgJzAnKX1gO1xuICAgICAgICAgICAgc2VwYXJhdG9yUnVuID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGAtLSR7KHJlYWRhYmxlLnJlcGxhY2UoL14tKy8sICcnKSB8fCAncm9vdCcpLnNsaWNlKDAsIDI1MSl9LS1gO1xufVxuXG4vKiogYDxEU0hfSE9NRT4vc2Vzc2lvbnNg77yIYERTSF9IT01FYCDmsqHorr7lsLHmjIkgYH4vLmRzaGDvvIzkuI4gRFNIIOiHquW3seWQjOWPo+W+hO+8ieOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlc3Npb25zUm9vdCgpOiBzdHJpbmcge1xuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5EU0hfSE9NRT8udHJpbSgpO1xuICAgIHJldHVybiBqb2luKGhvbWUgJiYgaG9tZSAhPT0gJycgPyBob21lIDogam9pbihob21lZGlyKCksICcuZHNoJyksICdzZXNzaW9ucycpO1xufVxuXG4vKiog6K+75Y+W5Zmo6ISa5pys55qE6Lev5b6E77yIYGRpc3QvaGlzdG9yeS5qc2Ag4oaSIGA85omp5bGV5qC5Pi9zY3JpcHRzL3Nlc3Npb24tbG9nLmpzYO+8ieOAgiAqL1xuZnVuY3Rpb24gcmVhZGVyUGF0aCgpOiBzdHJpbmcge1xuICAgIHJldHVybiByZXNvbHZlKF9fZGlybmFtZSwgJy4uJywgJ3NjcmlwdHMnLCAnc2Vzc2lvbi1sb2cuanMnKTtcbn1cblxuLyoqIOaKiuW8guW4uOaUtuaVm+aIkOS4gOWPpeivneOAgiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8qKlxuICog6LeR5LiA5qyh6K+75Y+W5Zmo77yM6L+U5Zue5a6DIHN0ZG91dCDkuIrpgqPooYwgSlNPTuOAglxuICpcbiAqIOKaoCDlj4LmlbDnlKgqKuaVsOe7hCoq5Lyg77yI5LiN57uPIHNoZWxs77yJ77ya5bel56iL6ZSu5pys6Lqr5LulIGAtLWAg5byA5aS077yM5Lu75L2V5a2X56ym5Liy5ou85o6lL+WRveS7pOihjOino+aekOmDveS8mui4qeWdkeOAglxuICovXG5mdW5jdGlvbiBydW5SZWFkZXIoXG4gICAgbm9kZUV4ZTogc3RyaW5nLFxuICAgIGFyZ3M6IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZVByb21pc2UsIHJlamVjdFByb21pc2UpID0+IHtcbiAgICAgICAgbGV0IGNoaWxkO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2hpbGQgPSBzcGF3bihub2RlRXhlLCBbcmVhZGVyUGF0aCgpLCAuLi5hcmdzXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0UHJvbWlzZShuZXcgRXJyb3IoYOWQr+WKqCBub2RlIOivu+S8muivneaXpeW/l+Wksei0pe+8miR7ZGVzY3JpYmUoZXJyb3IpfWApKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzdGRvdXQgPSAnJztcbiAgICAgICAgbGV0IHN0ZGVyciA9ICcnO1xuICAgICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICAgICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjaGlsZC5raWxsKCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvKiDlt7Lnu4/pgIDkuoYgKi9cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlamVjdFByb21pc2UobmV3IEVycm9yKGDor7vkvJror53ml6Xlv5fotoXml7bvvIgke1JFQURFUl9USU1FT1VUX01TfW1z77yJYCkpO1xuICAgICAgICB9LCBSRUFERVJfVElNRU9VVF9NUyk7XG5cbiAgICAgICAgY2hpbGQuc3Rkb3V0Py5zZXRFbmNvZGluZygndXRmOCcpO1xuICAgICAgICBjaGlsZC5zdGRlcnI/LnNldEVuY29kaW5nKCd1dGY4Jyk7XG4gICAgICAgIGNoaWxkLnN0ZG91dD8ub24oJ2RhdGEnLCAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgc3Rkb3V0ICs9IGNodW5rO1xuICAgICAgICAgICAgLy8g5LiA5Lu95pel5b+X55qE5oqV5b2x5LiN6K+l6LaF6L+H6L+Z5Liq6YeP57qn77yb6LaF5LqG5bCx5piv5ZOq5YS/5LiN5a+577yM5Yir5oqK5Li76L+b56iL5pKR54iGXG4gICAgICAgICAgICBpZiAoc3Rkb3V0Lmxlbmd0aCA+IDY0ICogMTAyNCAqIDEwMjQpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjaGlsZC5raWxsKCk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIC8qIOW/veeVpSAqL1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNoaWxkLnN0ZGVycj8ub24oJ2RhdGEnLCAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgc3RkZXJyICs9IGNodW5rO1xuICAgICAgICB9KTtcblxuICAgICAgICBjaGlsZC5vbignZXJyb3InLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICByZWplY3RQcm9taXNlKG5ldyBFcnJvcihg6K+75Lya6K+d5pel5b+X5aSx6LSl77yaJHtkZXNjcmliZShlcnJvcil9YCkpO1xuICAgICAgICB9KTtcblxuICAgICAgICBjaGlsZC5vbignY2xvc2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgY29uc3QgbGluZSA9IHN0ZG91dC50cmltKCkuc3BsaXQoJ1xcbicpLnBvcCgpID8/ICcnO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXNvbHZlUHJvbWlzZShKU09OLnBhcnNlKGxpbmUpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJlamVjdFByb21pc2UoXG4gICAgICAgICAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGDor7vkvJror53ml6Xlv5fnmoTovpPlh7rkuI3mmK8gSlNPTu+8miR7bGluZS5zbGljZSgwLCAyMDApIHx8ICco56m6KSd9YCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKHN0ZGVyciA/IGDvvJtzdGRlcnLvvJoke3N0ZGVyci50cmltKCkuc2xpY2UoMCwgMjAwKX1gIDogJycpLFxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuXG4vKiog57y6IG5vZGUg5pe255qE57uf5LiA5paH5qGI77yI6L+Z5LiN5piv44CM5rKh6KOFIGRzaOOAjemCo+S5iOaYjuaYvu+8jOivtOa4healmuS4uuS7gOS5iOivu+S4jeS6hu+8ieOAgiAqL1xuY29uc3QgTk9fTk9ERV9ISU5UID1cbiAgICAn6K+75Lya6K+d5pel5b+X6ZyA6KaB5LiA5LiqICoqTm9kZSDiiaUgMjIuMTUqKu+8iOaXpeW/l+aYryB6c3RkIOWOi+e8qeeahO+8jOe8lui+keWZqOiHquW4pueahCBFbGVjdHJvbi9Ob2RlIDIwIOino+S4jeW8gO+8ieOAgicgK1xuICAgICfor7flnKjorr7nva7ph4zloavjgIxub2RlIOi3r+W+hOOAje+8jOaIluaKiiBub2RlIOWKoOWIsCBQQVRI44CCJztcblxuLyoqXG4gKiDliJflh7rmnKzlt6XnqIvnmoTljoblj7LkvJror53vvIjmjInmnIDlkI7kv67mlLnml7bpl7TlgJLluo/vvInjgIJcbiAqXG4gKiBAcGFyYW0gbm9kZUV4ZSAtIOeUqOadpei3keivu+WPluWZqOeahCBub2Rl77yIYHBhdGhzLnRzYCDmjqLmtYvlh7rmnaXnmoTpgqPkuKrvvInjgIJcbiAqIEBwYXJhbSBjd2QgLSDlt6XnqIvmoLnnm67lvZXjgIJcbiAqIEBwYXJhbSBsaW1pdCAtIOacgOWkmuWHoOadoeOAglxuICogQHJldHVybnMgYHtvaywgc2Vzc2lvbnM/LCBlcnJvcj99YO+8m+Wksei0peS4jeaKm++8jOiuqemdouadv+iDveaYvuekuuWOn+WboOOAglxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdEhpc3RvcnkoXG4gICAgbm9kZUV4ZTogc3RyaW5nIHwgbnVsbCxcbiAgICBjd2Q6IHN0cmluZyxcbiAgICBsaW1pdCA9IDIwLFxuKTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBzZXNzaW9ucz86IEhpc3RvcnlTZXNzaW9uW107IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgICBpZiAoIW5vZGVFeGUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IE5PX05PREVfSElOVCB9O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBhd2FpdCBydW5SZWFkZXIobm9kZUV4ZSwgW1xuICAgICAgICAgICAgJ2xpc3QnLFxuICAgICAgICAgICAgJy0tcm9vdCcsXG4gICAgICAgICAgICBzZXNzaW9uc1Jvb3QoKSxcbiAgICAgICAgICAgICctLXByb2plY3QnLFxuICAgICAgICAgICAgcHJvamVjdEtleShjd2QpLFxuICAgICAgICAgICAgJy0tbGltaXQnLFxuICAgICAgICAgICAgU3RyaW5nKGxpbWl0KSxcbiAgICAgICAgXSk7XG4gICAgICAgIGlmIChwYXlsb2FkLm9rICE9PSB0cnVlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcocGF5bG9hZC5lcnJvciA/PyAn6K+75Y+W5Zmo6L+U5Zue5aSx6LSlJykgfTtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbnMgPSBBcnJheS5pc0FycmF5KHBheWxvYWQuc2Vzc2lvbnMpID8gKHBheWxvYWQuc2Vzc2lvbnMgYXMgSGlzdG9yeVNlc3Npb25bXSkgOiBbXTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHNlc3Npb25zIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZGVzY3JpYmUoZXJyb3IpIH07XG4gICAgfVxufVxuXG4vKipcbiAqIOivu+S4gOS4quS8muivneeahOS6i+S7tu+8iOWbnuaUvueUqO+8ieOAglxuICpcbiAqIEBwYXJhbSBub2RlRXhlIC0g55So5p2l6LeR6K+75Y+W5Zmo55qEIG5vZGXjgIJcbiAqIEBwYXJhbSBjd2QgLSDlt6XnqIvmoLnnm67lvZXjgIJcbiAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTjgIJcbiAqIEBwYXJhbSBtYXhFdmVudHMgLSDmnIDlpJrkv53nlZnlpJrlsJHmnaHvvIjku47lsL7pg6jkv53nlZnvvInjgIJcbiAqIEByZXR1cm5zIGB7b2ssIGV2ZW50cz8sIGVycm9yP31g44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkSGlzdG9yeShcbiAgICBub2RlRXhlOiBzdHJpbmcgfCBudWxsLFxuICAgIGN3ZDogc3RyaW5nLFxuICAgIHNlc3Npb25JZDogc3RyaW5nLFxuICAgIG1heEV2ZW50cyA9IDIwMDAsXG4pOiBQcm9taXNlPEhpc3RvcnlSZWFkUmVzdWx0PiB7XG4gICAgaWYgKCFub2RlRXhlKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBOT19OT0RFX0hJTlQgfTtcbiAgICBpZiAoIXNlc3Npb25JZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ3JlYWRIaXN0b3J577ya5Lya6K+dIGlkIOaYr+epuueahCcgfTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcnVuUmVhZGVyKG5vZGVFeGUsIFtcbiAgICAgICAgICAgICdyZWFkJyxcbiAgICAgICAgICAgICctLXJvb3QnLFxuICAgICAgICAgICAgc2Vzc2lvbnNSb290KCksXG4gICAgICAgICAgICAnLS1wcm9qZWN0JyxcbiAgICAgICAgICAgIHByb2plY3RLZXkoY3dkKSxcbiAgICAgICAgICAgICctLWlkJyxcbiAgICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICAgICctLW1heC1ldmVudHMnLFxuICAgICAgICAgICAgU3RyaW5nKG1heEV2ZW50cyksXG4gICAgICAgIF0pO1xuICAgICAgICBpZiAocGF5bG9hZC5vayAhPT0gdHJ1ZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKHBheWxvYWQuZXJyb3IgPz8gJ+ivu+WPluWZqOi/lOWbnuWksei0pScpIH07XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIGhlYWRlcjogKHBheWxvYWQuaGVhZGVyID8/IG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCxcbiAgICAgICAgICAgIGV2ZW50czogQXJyYXkuaXNBcnJheShwYXlsb2FkLmV2ZW50cykgPyAocGF5bG9hZC5ldmVudHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KSA6IFtdLFxuICAgICAgICAgICAgdG90YWw6IHR5cGVvZiBwYXlsb2FkLnRvdGFsID09PSAnbnVtYmVyJyA/IHBheWxvYWQudG90YWwgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBmcmFtZUNvdW50OiB0eXBlb2YgcGF5bG9hZC5mcmFtZUNvdW50ID09PSAnbnVtYmVyJyA/IHBheWxvYWQuZnJhbWVDb3VudCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHRvcm46IHBheWxvYWQudG9ybiA9PT0gdHJ1ZSxcbiAgICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBkZXNjcmliZShlcnJvcikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog5LuO5LqL5Lu25rWB6YeM5Y+W5LiA5p2h44CM5YOP5qCH6aKY44CN55qE6aaW5p2h55So5oi35raI5oGv77yI5YiX6KGo5o6l5Y+j57uZ5LqG5qCH6aKY77yM5Zue5pS+6Lev5b6E6KaB6Ieq5bex566X5LiA6YGN77yJ44CCXG4gKlxuICogQHBhcmFtIGV2ZW50cyAtIGByZWFkSGlzdG9yeWAg6L+U5Zue55qE5LqL5Lu244CCXG4gKiBAcmV0dXJucyDmoIfpopjvvIjmnIDlpJogODAg5a2X77yJ77yb5Y+W5LiN5Yiw6L+U5Zue56m65Liy44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZU9mRXZlbnRzKGV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIGV2ZW50cykge1xuICAgICAgICBpZiAoZXZlbnQudHlwZSAhPT0gJ3VzZXIvbWVzc2FnZScpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gKGV2ZW50LmRhdGEgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBkYXRhLnNvdXJjZSBhcyB7IGtpbmQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHNvdXJjZSAmJiBzb3VyY2Uua2luZCAhPT0gJ3VzZXInKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgY29udGVudCA9IChkYXRhLmNvbnRlbnQgPz8gKGRhdGEubWVzc2FnZSBhcyB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfCB1bmRlZmluZWQpPy5jb250ZW50KSBhcyB1bmtub3duO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB0ZXh0ID0gY29udGVudFxuICAgICAgICAgICAgLmZpbHRlcigoYmxvY2spOiBibG9jayBpcyB7IHR5cGU6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGJsb2NrIGFzIHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FuZGlkYXRlPy50eXBlID09PSAndGV4dCcgJiYgdHlwZW9mIGNhbmRpZGF0ZS50ZXh0ID09PSAnc3RyaW5nJztcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAubWFwKChibG9jaykgPT4gYmxvY2sudGV4dClcbiAgICAgICAgICAgIC5qb2luKCcgJylcbiAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAgICAgICAgIC50cmltKCk7XG4gICAgICAgIGlmICh0ZXh0KSByZXR1cm4gdGV4dC5zbGljZSgwLCA4MCk7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cbiJdfQ==