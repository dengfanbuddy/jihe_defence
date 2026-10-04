"use strict";
/**
 * DSH SDK 协议客户端：在子进程的 stdio 上跑**按换行分帧的 JSON-RPC 2.0**。
 *
 * 协议面很小（`dsh-sdk-protocol` 就这么多）：
 *
 * | 方向 | 方法 | 说明 |
 * |---|---|---|
 * | c→s | `initialize` | `{cwd, provider, model, reasoningEffort?, maxTokens?}` → `{serverInfo}` |
 * | c→s | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}`（只是入队回执，不是答案） |
 * | c→s | `shutdown` | 服务端回完就把自己 `process.exit(0)` |
 * | s→c | `session.event` | 会话事件（`user/message`、`assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`…） |
 * | s→c | `session.status` | `running` / `idle` |
 * | s→c | `subagent.started` / `subagent.finished` | 子 agent 生命周期 |
 *
 * ## 两条必须守住的纪律
 *
 * 1. **stdout 只属于协议帧**。任何杂质行（插件误用 `console.log`）都可能出现，
 *    所以解析失败就**跳过并计数**，绝不因为一行垃圾把整条流搞死。计数会在状态里暴露出来，
 *    真出问题看得见。
 * 2. **`session/prompt` 的返回不代表答案**。答案通过 `session.event` 异步推来，
 *    所以「问完」与「答完」是两件事：前者看请求回执，后者看 `turn/end`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkClient = void 0;
/** 请求默认超时。`initialize` 要加载整棵树 + 解析适配器，给得宽一些。 */
const DEFAULT_TIMEOUT_MS = 300000;
/** SDK 协议客户端。 */
class SdkClient {
    /**
     * @param child - 已 fork 的子进程（必须有 stdin/stdout 管道）。
     * @param onNotification - 通知回调（`session.event` 等）。
     */
    constructor(child, onNotification) {
        this.child = child;
        this.onNotification = onNotification;
        this.buffer = '';
        this.pending = new Map();
        this.seq = 0;
        this.malformedLines = 0;
        this.disposed = false;
        this.handleData = (chunk) => {
            this.buffer += chunk;
            for (;;) {
                const newline = this.buffer.indexOf('\n');
                if (newline < 0)
                    break;
                const line = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                if (line)
                    this.handleLine(line);
            }
        };
    }
    /** 杂质行计数（非 JSON 或结构不对的行），用于诊断。 */
    get malformed() {
        return this.malformedLines;
    }
    /** 挂上 stdout 监听。 */
    attach() {
        var _a, _b;
        (_a = this.child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding('utf8');
        (_b = this.child.stdout) === null || _b === void 0 ? void 0 : _b.on('data', this.handleData);
    }
    /** 摘掉监听并让所有在飞请求失败。 */
    dispose() {
        var _a;
        this.disposed = true;
        (_a = this.child.stdout) === null || _a === void 0 ? void 0 : _a.off('data', this.handleData);
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`dsh chat：连接已关闭（${entry.label} 未完成）`));
        }
        this.pending.clear();
    }
    /**
     * 发一个请求并等回执。
     *
     * @param method - JSON-RPC 方法名。
     * @param params - 参数。
     * @param timeoutMs - 超时。
     * @returns 回执的 `result`。
     */
    request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (this.disposed)
            return Promise.reject(new Error('dsh chat：连接已关闭'));
        const id = `c_${++this.seq}`;
        return new Promise((resolve, reject) => {
            var _a;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`dsh chat：${method} 在 ${timeoutMs}ms 内没有回执`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, label: method });
            try {
                (_a = this.child.stdin) === null || _a === void 0 ? void 0 : _a.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    /**
     * 握手。必须在任何 `session/prompt` 之前完成——服务端在初始化期间解析路由，
     * 失败会明确报错而不是悄悄回落默认模型。
     */
    initialize(params) {
        return this.request('initialize', params, 180000);
    }
    /**
     * 提交一条用户消息。返回的 `messageId` 只代表**入队**成功。
     *
     * ## 图片是**编码块**，不是路径
     *
     * `contentBlocks` 逐字就是用户消息的内容，而图片只有一种合法形式：
     * `{type:'image', data, mimeType}` —— 服务端在 `session/prompt` 里把它交给附件库
     * （`admitEncodedImages`）落成 `{type:'image', attachment}`，**没有**「给我个文件路径」这种入口。
     * 详见 `dsh-sdk-protocol` 的 `SdkPromptContentBlock`。
     *
     * @param sessionId - 会话 id（未知 id 会被懒创建）。
     * @param blocks - 内容块（文本 + 图片，顺序即消息顺序）。
     * @returns `{messageId}`。
     */
    prompt(sessionId, blocks) {
        return this.request('session/prompt', { sessionId, contentBlocks: blocks }, 120000);
    }
    /** 请求关闭。服务端回完即自行退出（所以调用方不必再 kill，但我们仍会兜底 kill）。 */
    shutdown() {
        return this.request('shutdown', {}, 30000);
    }
    handleLine(line) {
        var _a;
        let frame;
        try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('not an object');
            frame = parsed;
        }
        catch {
            // 不是协议帧 —— 多半是某个插件往 stdout 写了日志。跳过并计数，不打断整条流。
            this.malformedLines += 1;
            return;
        }
        const id = frame.id;
        const method = frame.method;
        // 回执：只有 id
        if (id !== undefined && method === undefined) {
            const entry = this.pending.get(String(id));
            if (!entry)
                return;
            clearTimeout(entry.timer);
            this.pending.delete(String(id));
            if (frame.error && typeof frame.error === 'object') {
                const error = frame.error;
                entry.reject(new Error(`${entry.label} 失败：${(_a = error.message) !== null && _a !== void 0 ? _a : '未知错误'}${error.code === undefined ? '' : `（code ${error.code}）`}`));
            }
            else {
                entry.resolve(frame.result);
            }
            return;
        }
        // 通知：只有 method
        if (method !== undefined && id === undefined) {
            const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
            this.onNotification(String(method), params);
            return;
        }
        // 服务端反向请求：当前协议没有（README 明确写了「未使用的功能」），忽略即可。
    }
}
exports.SdkClient = SdkClient;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2RrLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9zZGstY2xpZW50LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBcUJHOzs7QUFrQkgsZ0RBQWdEO0FBQ2hELE1BQU0sa0JBQWtCLEdBQUcsTUFBTyxDQUFDO0FBRW5DLGlCQUFpQjtBQUNqQixNQUFhLFNBQVM7SUFPbEI7OztPQUdHO0lBQ0gsWUFDcUIsS0FBbUIsRUFDbkIsY0FBeUU7UUFEekUsVUFBSyxHQUFMLEtBQUssQ0FBYztRQUNuQixtQkFBYyxHQUFkLGNBQWMsQ0FBMkQ7UUFadEYsV0FBTSxHQUFHLEVBQUUsQ0FBQztRQUNILFlBQU8sR0FBRyxJQUFJLEdBQUcsRUFBbUIsQ0FBQztRQUM5QyxRQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQ1IsbUJBQWMsR0FBRyxDQUFDLENBQUM7UUFDbkIsYUFBUSxHQUFHLEtBQUssQ0FBQztRQTJGUixlQUFVLEdBQUcsQ0FBQyxLQUFhLEVBQVEsRUFBRTtZQUNsRCxJQUFJLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQztZQUNyQixTQUFTLENBQUM7Z0JBQ04sTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzFDLElBQUksT0FBTyxHQUFHLENBQUM7b0JBQUUsTUFBTTtnQkFDdkIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNsRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFDN0MsSUFBSSxJQUFJO29CQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDcEMsQ0FBQztRQUNMLENB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5a2Q6L+b56iL55qEIHN0ZGlvIOS4iui3kSoq5oyJ5o2i6KGM5YiG5bin55qEIEpTT04tUlBDIDIuMCoq44CCXG4gKlxuICog5Y2P6K6u6Z2i5b6I5bCP77yIYGRzaC1zZGstcHJvdG9jb2xgIOWwsei/meS5iOWkmu+8ie+8mlxuICpcbiAqIHwg5pa55ZCRIHwg5pa55rOVIHwg6K+05piOIHxcbiAqIHwtLS18LS0tfC0tLXxcbiAqIHwgY+KGknMgfCBgaW5pdGlhbGl6ZWAgfCBge2N3ZCwgcHJvdmlkZXIsIG1vZGVsLCByZWFzb25pbmdFZmZvcnQ/LCBtYXhUb2tlbnM/fWAg4oaSIGB7c2VydmVySW5mb31gIHxcbiAqIHwgY+KGknMgfCBgc2Vzc2lvbi9wcm9tcHRgIHwgYHtzZXNzaW9uSWQsIGNvbnRlbnRCbG9ja3N9YCDihpIgYHttZXNzYWdlSWR9YO+8iOWPquaYr+WFpemYn+WbnuaJp++8jOS4jeaYr+etlOahiO+8iSB8XG4gKiB8IGPihpJzIHwgYHNodXRkb3duYCB8IOacjeWKoeerr+WbnuWujOWwseaKiuiHquW3sSBgcHJvY2Vzcy5leGl0KDApYCB8XG4gKiB8IHPihpJjIHwgYHNlc3Npb24uZXZlbnRgIHwg5Lya6K+d5LqL5Lu277yIYHVzZXIvbWVzc2FnZWDjgIFgYXNzaXN0YW50L21lc3NhZ2Vg44CBYGFzc2lzdGFudC9jaHVua2DjgIFgdG9vbC9jYWxsYOOAgWB0b29sL3Jlc3VsdGDigKbvvIkgfFxuICogfCBz4oaSYyB8IGBzZXNzaW9uLnN0YXR1c2AgfCBgcnVubmluZ2AgLyBgaWRsZWAgfFxuICogfCBz4oaSYyB8IGBzdWJhZ2VudC5zdGFydGVkYCAvIGBzdWJhZ2VudC5maW5pc2hlZGAgfCDlrZAgYWdlbnQg55Sf5ZG95ZGo5pyfIHxcbiAqXG4gKiAjIyDkuKTmnaHlv4XpobvlrojkvY/nmoTnuqrlvotcbiAqXG4gKiAxLiAqKnN0ZG91dCDlj6rlsZ7kuo7ljY/orq7luKcqKuOAguS7u+S9leadgui0qOihjO+8iOaPkuS7tuivr+eUqCBgY29uc29sZS5sb2dg77yJ6YO95Y+v6IO95Ye6546w77yMXG4gKiAgICDmiYDku6Xop6PmnpDlpLHotKXlsLEqKui3s+i/h+W5tuiuoeaVsCoq77yM57ud5LiN5Zug5Li65LiA6KGM5Z6D5Zy+5oqK5pW05p2h5rWB5pCe5q2744CC6K6h5pWw5Lya5Zyo54q25oCB6YeM5pq06Zyy5Ye65p2l77yMXG4gKiAgICDnnJ/lh7rpl67popjnnIvlvpfop4HjgIJcbiAqIDIuICoqYHNlc3Npb24vcHJvbXB0YCDnmoTov5Tlm57kuI3ku6PooajnrZTmoYgqKuOAguetlOahiOmAmui/hyBgc2Vzc2lvbi5ldmVudGAg5byC5q2l5o6o5p2l77yMXG4gKiAgICDmiYDku6XjgIzpl67lrozjgI3kuI7jgIznrZTlrozjgI3mmK/kuKTku7bkuovvvJrliY3ogIXnnIvor7fmsYLlm57miafvvIzlkI7ogIXnnIsgYHR1cm4vZW5kYOOAglxuICovXG5cbmltcG9ydCB0eXBlIHsgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbi8qKiDkuIDmnaHmnI3liqHnq6/mjqjmnaXnmoTpgJrnn6XjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2RrTm90aWZpY2F0aW9uIHtcbiAgICBtZXRob2Q6IHN0cmluZztcbiAgICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vKiog5Zyo6aOe6K+35rGC55qE6K6w6LSm44CCICovXG5pbnRlcmZhY2UgUGVuZGluZyB7XG4gICAgcmVzb2x2ZTogKHZhbHVlOiB1bmtub3duKSA9PiB2b2lkO1xuICAgIHJlamVjdDogKGVycm9yOiBFcnJvcikgPT4gdm9pZDtcbiAgICB0aW1lcjogTm9kZUpTLlRpbWVvdXQ7XG4gICAgbGFiZWw6IHN0cmluZztcbn1cblxuLyoqIOivt+axgum7mOiupOi2heaXtuOAgmBpbml0aWFsaXplYCDopoHliqDovb3mlbTmo7XmoJEgKyDop6PmnpDpgILphY3lmajvvIznu5nlvpflrr3kuIDkupvjgIIgKi9cbmNvbnN0IERFRkFVTFRfVElNRU9VVF9NUyA9IDMwMF8wMDA7XG5cbi8qKiBTREsg5Y2P6K6u5a6i5oi356uv44CCICovXG5leHBvcnQgY2xhc3MgU2RrQ2xpZW50IHtcbiAgICBwcml2YXRlIGJ1ZmZlciA9ICcnO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBQZW5kaW5nPigpO1xuICAgIHByaXZhdGUgc2VxID0gMDtcbiAgICBwcml2YXRlIG1hbGZvcm1lZExpbmVzID0gMDtcbiAgICBwcml2YXRlIGRpc3Bvc2VkID0gZmFsc2U7XG5cbiAgICAvKipcbiAgICAgKiBAcGFyYW0gY2hpbGQgLSDlt7IgZm9yayDnmoTlrZDov5vnqIvvvIjlv4XpobvmnIkgc3RkaW4vc3Rkb3V0IOeuoemBk++8ieOAglxuICAgICAqIEBwYXJhbSBvbk5vdGlmaWNhdGlvbiAtIOmAmuefpeWbnuiwg++8iGBzZXNzaW9uLmV2ZW50YCDnrYnvvInjgIJcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihcbiAgICAgICAgcHJpdmF0ZSByZWFkb25seSBjaGlsZDogQ2hpbGRQcm9jZXNzLFxuICAgICAgICBwcml2YXRlIHJlYWRvbmx5IG9uTm90aWZpY2F0aW9uOiAobWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHZvaWQsXG4gICAgKSB7fVxuXG4gICAgLyoqIOadgui0qOihjOiuoeaVsO+8iOmdniBKU09OIOaIlue7k+aehOS4jeWvueeahOihjO+8ie+8jOeUqOS6juiviuaWreOAgiAqL1xuICAgIGdldCBtYWxmb3JtZWQoKTogbnVtYmVyIHtcbiAgICAgICAgcmV0dXJuIHRoaXMubWFsZm9ybWVkTGluZXM7XG4gICAgfVxuXG4gICAgLyoqIOaMguS4iiBzdGRvdXQg55uR5ZCs44CCICovXG4gICAgYXR0YWNoKCk6IHZvaWQge1xuICAgICAgICB0aGlzLmNoaWxkLnN0ZG91dD8uc2V0RW5jb2RpbmcoJ3V0ZjgnKTtcbiAgICAgICAgdGhpcy5jaGlsZC5zdGRvdXQ/Lm9uKCdkYXRhJywgdGhpcy5oYW5kbGVEYXRhKTtcbiAgICB9XG5cbiAgICAvKiog5pGY5o6J55uR5ZCs5bm26K6p5omA5pyJ5Zyo6aOe6K+35rGC5aSx6LSl44CCICovXG4gICAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5kaXNwb3NlZCA9IHRydWU7XG4gICAgICAgIHRoaXMuY2hpbGQuc3Rkb3V0Py5vZmYoJ2RhdGEnLCB0aGlzLmhhbmRsZURhdGEpO1xuICAgICAgICBmb3IgKGNvbnN0IFssIGVudHJ5XSBvZiB0aGlzLnBlbmRpbmcpIHtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dChlbnRyeS50aW1lcik7XG4gICAgICAgICAgICBlbnRyeS5yZWplY3QobmV3IEVycm9yKGBkc2ggY2hhdO+8mui/nuaOpeW3suWFs+mXre+8iCR7ZW50cnkubGFiZWx9IOacquWujOaIkO+8iWApKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnBlbmRpbmcuY2xlYXIoKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiDlj5HkuIDkuKror7fmsYLlubbnrYnlm57miafjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBtZXRob2QgLSBKU09OLVJQQyDmlrnms5XlkI3jgIJcbiAgICAgKiBAcGFyYW0gcGFyYW1zIC0g5Y+C5pWw44CCXG4gICAgICogQHBhcmFtIHRpbWVvdXRNcyAtIOi2heaXtuOAglxuICAgICAqIEByZXR1cm5zIOWbnuaJp+eahCBgcmVzdWx0YOOAglxuICAgICAqL1xuICAgIHJlcXVlc3QobWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHRpbWVvdXRNcyA9IERFRkFVTFRfVElNRU9VVF9NUyk6IFByb21pc2U8dW5rbm93bj4ge1xuICAgICAgICBpZiAodGhpcy5kaXNwb3NlZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcignZHNoIGNoYXTvvJrov57mjqXlt7LlhbPpl60nKSk7XG4gICAgICAgIGNvbnN0IGlkID0gYGNfJHsrK3RoaXMuc2VxfWA7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMucGVuZGluZy5kZWxldGUoaWQpO1xuICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYGRzaCBjaGF077yaJHttZXRob2R9IOWcqCAke3RpbWVvdXRNc31tcyDlhoXmsqHmnInlm57miadgKSk7XG4gICAgICAgICAgICB9LCB0aW1lb3V0TXMpO1xuICAgICAgICAgICAgdGhpcy5wZW5kaW5nLnNldChpZCwgeyByZXNvbHZlLCByZWplY3QsIHRpbWVyLCBsYWJlbDogbWV0aG9kIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICB0aGlzLmNoaWxkLnN0ZGluPy53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IGpzb25ycGM6ICcyLjAnLCBpZCwgbWV0aG9kLCBwYXJhbXMgfSl9XFxuYCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICAgICAgdGhpcy5wZW5kaW5nLmRlbGV0ZShpZCk7XG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOaPoeaJi+OAguW/hemhu+WcqOS7u+S9lSBgc2Vzc2lvbi9wcm9tcHRgIOS5i+WJjeWujOaIkOKAlOKAlOacjeWKoeerr+WcqOWIneWni+WMluacn+mXtOino+aekOi3r+eUse+8jFxuICAgICAqIOWksei0peS8muaYjuehruaKpemUmeiAjOS4jeaYr+aChOaChOWbnuiQvem7mOiupOaooeWei+OAglxuICAgICAqL1xuICAgIGluaXRpYWxpemUocGFyYW1zOiB7IGN3ZDogc3RyaW5nOyBwcm92aWRlcjogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyByZWFzb25pbmdFZmZvcnQ/OiBzdHJpbmc7IG1heFRva2Vucz86IG51bWJlciB9KTogUHJvbWlzZTx1bmtub3duPiB7XG4gICAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2luaXRpYWxpemUnLCBwYXJhbXMsIDE4MF8wMDApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIOaPkOS6pOS4gOadoeeUqOaIt+a2iOaBr+OAgui/lOWbnueahCBgbWVzc2FnZUlkYCDlj6rku6PooagqKuWFpemYnyoq5oiQ5Yqf44CCXG4gICAgICpcbiAgICAgKiAjIyDlm77niYfmmK8qKue8lueggeWdlyoq77yM5LiN5piv6Lev5b6EXG4gICAgICpcbiAgICAgKiBgY29udGVudEJsb2Nrc2Ag6YCQ5a2X5bCx5piv55So5oi35raI5oGv55qE5YaF5a6577yM6ICM5Zu+54mH5Y+q5pyJ5LiA56eN5ZCI5rOV5b2i5byP77yaXG4gICAgICogYHt0eXBlOidpbWFnZScsIGRhdGEsIG1pbWVUeXBlfWAg4oCU4oCUIOacjeWKoeerr+WcqCBgc2Vzc2lvbi9wcm9tcHRgIOmHjOaKiuWug+S6pOe7memZhOS7tuW6k1xuICAgICAqIO+8iGBhZG1pdEVuY29kZWRJbWFnZXNg77yJ6JC95oiQIGB7dHlwZTonaW1hZ2UnLCBhdHRhY2htZW50fWDvvIwqKuayoeaciSoq44CM57uZ5oiR5Liq5paH5Lu26Lev5b6E44CN6L+Z56eN5YWl5Y+j44CCXG4gICAgICog6K+m6KeBIGBkc2gtc2RrLXByb3RvY29sYCDnmoQgYFNka1Byb21wdENvbnRlbnRCbG9ja2DjgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBzZXNzaW9uSWQgLSDkvJror50gaWTvvIjmnKrnn6UgaWQg5Lya6KKr5oeS5Yib5bu677yJ44CCXG4gICAgICogQHBhcmFtIGJsb2NrcyAtIOWGheWuueWdl++8iOaWh+acrCArIOWbvueJh++8jOmhuuW6j+WNs+a2iOaBr+mhuuW6j++8ieOAglxuICAgICAqIEByZXR1cm5zIGB7bWVzc2FnZUlkfWDjgIJcbiAgICAgKi9cbiAgICBwcm9tcHQoc2Vzc2lvbklkOiBzdHJpbmcsIGJsb2NrczogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KTogUHJvbWlzZTx1bmtub3duPiB7XG4gICAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3Nlc3Npb24vcHJvbXB0JywgeyBzZXNzaW9uSWQsIGNvbnRlbnRCbG9ja3M6IGJsb2NrcyB9LCAxMjBfMDAwKTtcbiAgICB9XG5cbiAgICAvKiog6K+35rGC5YWz6Zet44CC5pyN5Yqh56uv5Zue5a6M5Y2z6Ieq6KGM6YCA5Ye677yI5omA5Lul6LCD55So5pa55LiN5b+F5YaNIGtpbGzvvIzkvYbmiJHku6zku43kvJrlhZzlupUga2lsbO+8ieOAgiAqL1xuICAgIHNodXRkb3duKCk6IFByb21pc2U8dW5rbm93bj4ge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzaHV0ZG93bicsIHt9LCAzMF8wMDApO1xuICAgIH1cblxuICAgIHByaXZhdGUgcmVhZG9ubHkgaGFuZGxlRGF0YSA9IChjaHVuazogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgICAgIHRoaXMuYnVmZmVyICs9IGNodW5rO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgICBjb25zdCBuZXdsaW5lID0gdGhpcy5idWZmZXIuaW5kZXhPZignXFxuJyk7XG4gICAgICAgICAgICBpZiAobmV3bGluZSA8IDApIGJyZWFrO1xuICAgICAgICAgICAgY29uc3QgbGluZSA9IHRoaXMuYnVmZmVyLnNsaWNlKDAsIG5ld2xpbmUpLnRyaW0oKTtcbiAgICAgICAgICAgIHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2UobmV3bGluZSArIDEpO1xuICAgICAgICAgICAgaWYgKGxpbmUpIHRoaXMuaGFuZGxlTGluZShsaW5lKTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBwcml2YXRlIGhhbmRsZUxpbmUobGluZTogc3RyaW5nKTogdm9pZCB7XG4gICAgICAgIGxldCBmcmFtZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICAgICAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIHBhcnNlZCAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShwYXJzZWQpKSB0aHJvdyBuZXcgRXJyb3IoJ25vdCBhbiBvYmplY3QnKTtcbiAgICAgICAgICAgIGZyYW1lID0gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIOS4jeaYr+WNj+iuruW4pyDigJTigJQg5aSa5Y2K5piv5p+Q5Liq5o+S5Lu25b6AIHN0ZG91dCDlhpnkuobml6Xlv5fjgILot7Pov4flubborqHmlbDvvIzkuI3miZPmlq3mlbTmnaHmtYHjgIJcbiAgICAgICAgICAgIHRoaXMubWFsZm9ybWVkTGluZXMgKz0gMTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGlkID0gZnJhbWUuaWQ7XG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IGZyYW1lLm1ldGhvZDtcblxuICAgICAgICAvLyDlm57miafvvJrlj6rmnIkgaWRcbiAgICAgICAgaWYgKGlkICE9PSB1bmRlZmluZWQgJiYgbWV0aG9kID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5wZW5kaW5nLmdldChTdHJpbmcoaWQpKTtcbiAgICAgICAgICAgIGlmICghZW50cnkpIHJldHVybjtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dChlbnRyeS50aW1lcik7XG4gICAgICAgICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKFN0cmluZyhpZCkpO1xuICAgICAgICAgICAgaWYgKGZyYW1lLmVycm9yICYmIHR5cGVvZiBmcmFtZS5lcnJvciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBlcnJvciA9IGZyYW1lLmVycm9yIGFzIHsgY29kZT86IG51bWJlcjsgbWVzc2FnZT86IHN0cmluZyB9O1xuICAgICAgICAgICAgICAgIGVudHJ5LnJlamVjdChuZXcgRXJyb3IoYCR7ZW50cnkubGFiZWx9IOWksei0pe+8miR7ZXJyb3IubWVzc2FnZSA/PyAn5pyq55+l6ZSZ6K+vJ30ke2Vycm9yLmNvZGUgPT09IHVuZGVmaW5lZCA/ICcnIDogYO+8iGNvZGUgJHtlcnJvci5jb2Rlfe+8iWB9YCkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBlbnRyeS5yZXNvbHZlKGZyYW1lLnJlc3VsdCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyDpgJrnn6XvvJrlj6rmnIkgbWV0aG9kXG4gICAgICAgIGlmIChtZXRob2QgIT09IHVuZGVmaW5lZCAmJiBpZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJhbXMgPSBmcmFtZS5wYXJhbXMgJiYgdHlwZW9mIGZyYW1lLnBhcmFtcyA9PT0gJ29iamVjdCcgPyAoZnJhbWUucGFyYW1zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IHt9O1xuICAgICAgICAgICAgdGhpcy5vbk5vdGlmaWNhdGlvbihTdHJpbmcobWV0aG9kKSwgcGFyYW1zKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOacjeWKoeerr+WPjeWQkeivt+axgu+8muW9k+WJjeWNj+iuruayoeacie+8iFJFQURNRSDmmI7noa7lhpnkuobjgIzmnKrkvb/nlKjnmoTlip/og73jgI3vvInvvIzlv73nlaXljbPlj6/jgIJcbiAgICB9XG59XG4iXX0=