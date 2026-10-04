"use strict";
/**
 * 沙箱执行器 —— Code Mode 的「入口闸门」。
 *
 * 把一段用户（AI）写的 JS 跑起来，收集它的 `return` 值、`console.*` 输出、错误与耗时。
 *
 * ## 代码约定
 *
 * 用户代码被包进 `(async () => { ... })()`，因此顶层可以直接：
 * - `return <值>` —— 这就是本次执行的返回值
 * - `await ...` —— 顶层 await
 *
 * 注入的全局量直接以裸标识符出现（`cc`、`scene`、`Editor`…），不是挂在某个 `ctx` 上 ——
 * 少一层前缀，模型少写一堆字符。
 *
 * ## 两层超时（重要）
 *
 * `vm` 的 `timeout` 选项**只管同步执行段**。也就是说：
 * - `while(true){}` → 被 vm 的 timeout 掐死 ✅
 * - `await new Promise(()=>{})` → vm 不管，靠外层 `Promise.race` 的计时器 reject ✅
 *
 * 但外层计时器只能让**调用方**不再等，**沙箱里的异步代码并不会被真正杀掉**
 * （Node 没有抢占式取消）。所以超时后的清理要谨慎：本模块只报告超时，
 * 不假装已经终止了那段代码。要绝对隔离只能上子进程，那成本不是编辑器插件该付的。
 *
 * ## 安全性说明（不要被这个类名误导）
 *
 * `vm` **不是安全边界**。它挡得住手滑（不污染宿主全局、同步死循环能被掐），
 * 挡不住有意越界（`this.constructor.constructor('return process')()` 之类的逃逸是已知的）。
 * 本插件的信任模型是「你本机、你自己的 AI 客户端」，不是「跑陌生人的代码」。
 * 真正起作用的安全边界是 **HTTP 只绑 127.0.0.1**（见 mcp/server.ts）。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapUserCode = wrapUserCode;
exports.runInSandbox = runInSandbox;
const vm = __importStar(require("vm"));
const serialize_1 = require("./serialize");
class SandboxTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`执行超时（${timeoutMs}ms）`);
        this.isSandboxTimeout = true;
        this.name = 'SandboxTimeoutError';
    }
}
/** 跨 realm 安全的 Error 归一化：沙箱里抛出的 Error 在宿主侧 `instanceof Error` 为 false */
function normalizeError(err) {
    if (err === null || err === undefined) {
        return { name: 'Error', message: String(err) };
    }
    if (typeof err === 'object') {
        const anyErr = err;
        const name = typeof anyErr.name === 'string' && anyErr.name ? anyErr.name : 'Error';
        const message = typeof anyErr.message === 'string' && anyErr.message ? anyErr.message : (0, serialize_1.formatInline)(err);
        const stack = typeof anyErr.stack === 'string' ? anyErr.stack : undefined;
        return { name, message, stack };
    }
    return { name: 'Error', message: String(err) };
}
function isTimeoutError(err) {
    if (err && typeof err === 'object') {
        const anyErr = err;
        if (anyErr.isSandboxTimeout)
            return true;
        // Node 自己抛的 vm 超时
        if (anyErr.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
            return true;
        if (typeof anyErr.message === 'string' && /Script execution timed out/i.test(anyErr.message)) {
            return true;
        }
    }
    return false;
}
function makeCapturedConsole(capture) {
    const push = (level) => (...parts) => {
        if (capture.sink.length >= capture.maxLogs) {
            capture.truncated = true;
            return;
        }
        const text = parts
            .map((p) => (typeof p === 'string' ? p : (0, serialize_1.formatInline)(p, { maxDepth: 4, maxStringLength: 2000 })))
            .join(' ');
        capture.sink.push({
            level,
            text: text.length > capture.maxLogLength ? `${text.slice(0, capture.maxLogLength)}…` : text,
            atMs: Date.now() - capture.startedAt,
        });
    };
    return {
        log: push('log'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        debug: push('debug'),
        trace: push('debug'),
        dir: push('log'),
    };
}
/** 把用户代码包成可 `return` / `await` 的异步 IIFE */
function wrapUserCode(code) {
    return `(async () => {\n${code}\n})()`;
}
/**
 * 在隔离的 vm 上下文里执行用户代码。
 *
 * @example
 * const run = await runInSandbox({
 *     code: 'return 1 + 1;',
 *     globals: { Editor },
 *     timeoutMs: 15000,
 *     label: 'editor',
 * });
 */
async function runInSandbox(options) {
    var _a, _b;
    const startedAt = Date.now();
    const logs = [];
    const maxLogs = (_a = options.maxLogs) !== null && _a !== void 0 ? _a : 200;
    const maxLogLength = (_b = options.maxLogLength) !== null && _b !== void 0 ? _b : 4000;
    const capture = {
        sink: logs,
        maxLogs,
        maxLogLength,
        truncated: false,
        startedAt,
    };
    const finish = (partial) => ({
        ...partial,
        logs,
        durationMs: Date.now() - startedAt,
        logsTruncated: capture.truncated,
    });
    // ---- 1. 编译期错误（语法错）单独抓，错误信息更干净 ----
    let script;
    try {
        script = new vm.Script(wrapUserCode(options.code), { filename: `${options.label}.js` });
    }
    catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: false });
    }
    // ---- 2. 组装沙箱全局量 ----
    const sandbox = {
        console: makeCapturedConsole(capture),
        ...options.globals,
    };
    let context;
    try {
        context = vm.createContext(sandbox, { name: options.label });
    }
    catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: false });
    }
    // ---- 3. 同步段执行（vm 的 timeout 在这一段生效）----
    let returned;
    try {
        returned = script.runInContext(context, {
            timeout: options.timeoutMs,
            displayErrors: true,
        });
    }
    catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: isTimeoutError(err) });
    }
    // ---- 4. 异步段执行（vm 的 timeout 不管 async，靠计时器兜底）----
    let timer;
    try {
        const result = await Promise.race([
            Promise.resolve(returned),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new SandboxTimeoutError(options.timeoutMs)), options.timeoutMs);
            }),
        ]);
        return finish({ ok: true, result, timedOut: false });
    }
    catch (err) {
        return finish({ ok: false, error: normalizeError(err), timedOut: isTimeoutError(err) });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2FuZGJveC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9jb3JlL3NhbmRib3gudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0E4Qkc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBd0hILG9DQUVDO0FBYUQsb0NBcUVDO0FBMU1ELHVDQUF5QjtBQUN6QiwyQ0FBMkM7QUE2QzNDLE1BQU0sbUJBQW9CLFNBQVEsS0FBSztJQUVuQyxZQUFZLFNBQWlCO1FBQ3pCLEtBQUssQ0FBQyxRQUFRLFNBQVMsS0FBSyxDQUFDLENBQUM7UUFGekIscUJBQWdCLEdBQUcsSUFBSSxDQUFDO1FBRzdCLElBQUksQ0FBQyxJQUFJLEdBQUcscUJBQXFCLENBQUM7SUFDdEMsQ0FBQztDQUNKO0FBRUQseUVBQXlFO0FBQ3pFLFNBQVMsY0FBYyxDQUFDLEdBQVk7SUFDaEMsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNwQyxPQUFPLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7SUFDbkQsQ0FBQztJQUNELElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDMUIsTUFBTSxNQUFNLEdBQUcsR0FBNkQsQ0FBQztRQUM3RSxNQUFNLElBQUksR0FBRyxPQUFPLE1BQU0sQ0FBQyxJQUFJLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztRQUNwRixNQUFNLE9BQU8sR0FDVCxPQUFPLE1BQU0sQ0FBQyxPQUFPLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxD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TUFBTSxDQUFDLElBQUksbUJBQW1CLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3BHLENBQUMsQ0FBQztTQUNMLENBQUMsQ0FBQztRQUNILE9BQU8sTUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDekQsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDWCxPQUFPLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLGNBQWMsQ0FBQyxHQUFHLENBQUMsRUFBRSxRQUFRLEVBQUUsY0FBYyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM1RixDQUFDO1lBQVMsQ0FBQztRQUNQLElBQUksS0FBSztZQUFFLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNuQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog5rKZ566x5omn6KGM5ZmoIOKAlOKAlCBDb2RlIE1vZGUg55qE44CM5YWl5Y+j6Ze46Zeo44CN44CCXG4gKlxuICog5oqK5LiA5q6155So5oi377yIQUnvvInlhpnnmoQgSlMg6LeR6LW35p2l77yM5pS26ZuG5a6D55qEIGByZXR1cm5gIOWAvOOAgWBjb25zb2xlLipgIOi+k+WHuuOAgemUmeivr+S4juiAl+aXtuOAglxuICpcbiAqICMjIOS7o+eggee6puWumlxuICpcbiAqIOeUqOaIt+S7o+eggeiiq+WMhei/myBgKGFzeW5jICgpID0+IHsgLi4uIH0pKClg77yM5Zug5q2k6aG25bGC5Y+v5Lul55u05o6l77yaXG4gKiAtIGByZXR1cm4gPOWAvD5gIOKAlOKAlCDov5nlsLHmmK/mnKzmrKHmiafooYznmoTov5Tlm57lgLxcbiAqIC0gYGF3YWl0IC4uLmAg4oCU4oCUIOmhtuWxgiBhd2FpdFxuICpcbiAqIOazqOWFpeeahOWFqOWxgOmHj+ebtOaOpeS7peijuOagh+ivhuespuWHuueOsO+8iGBjY2DjgIFgc2NlbmVg44CBYEVkaXRvcmDigKbvvInvvIzkuI3mmK/mjILlnKjmn5DkuKogYGN0eGAg5LiKIOKAlOKAlFxuICog5bCR5LiA5bGC5YmN57yA77yM5qih5Z6L5bCR5YaZ5LiA5aCG5a2X56ym44CCXG4gKlxuICogIyMg5Lik5bGC6LaF5pe277yI6YeN6KaB77yJXG4gKlxuICogYHZtYCDnmoQgYHRpbWVvdXRgIOmAiemhuSoq5Y+q566h5ZCM5q2l5omn6KGM5q61KirjgILkuZ/lsLHmmK/or7TvvJpcbiAqIC0gYHdoaWxlKHRydWUpe31gIOKGkiDooqsgdm0g55qEIHRpbWVvdXQg5o6Q5q27IOKchVxuICogLSBgYXdhaXQgbmV3IFByb21pc2UoKCk9Pnt9KWAg4oaSIHZtIOS4jeeuoe+8jOmdoOWkluWxgiBgUHJvbWlzZS5yYWNlYCDnmoTorqHml7blmaggcmVqZWN0IOKchVxuICpcbiAqIOS9huWkluWxguiuoeaXtuWZqOWPquiDveiuqSoq6LCD55So5pa5KirkuI3lho3nrYnvvIwqKuaymeeusemHjOeahOW8guatpeS7o+eggeW5tuS4jeS8muiiq+ecn+ato+adgOaOiSoqXG4gKiDvvIhOb2RlIOayoeacieaKouWNoOW8j+WPlua2iO+8ieOAguaJgOS7pei2heaXtuWQjueahOa4heeQhuimgeiwqOaFju+8muacrOaooeWdl+WPquaKpeWRiui2heaXtu+8jFxuICog5LiN5YGH6KOF5bey57uP57uI5q2i5LqG6YKj5q615Luj56CB44CC6KaB57ud5a+56ZqU56a75Y+q6IO95LiK5a2Q6L+b56iL77yM6YKj5oiQ5pys5LiN5piv57yW6L6R5Zmo5o+S5Lu26K+l5LuY55qE44CCXG4gKlxuICogIyMg5a6J5YWo5oCn6K+05piO77yI5LiN6KaB6KKr6L+Z5Liq57G75ZCN6K+v5a+877yJXG4gKlxuICogYHZtYCAqKuS4jeaYr+WuieWFqOi+ueeVjCoq44CC5a6D5oyh5b6X5L2P5omL5ruR77yI5LiN5rGh5p+T5a6/5Li75YWo5bGA44CB5ZCM5q2l5q275b6q546v6IO96KKr5o6Q77yJ77yMXG4gKiDmjKHkuI3kvY/mnInmhI/otornlYzvvIhgdGhpcy5jb25zdHJ1Y3Rvci5jb25zdHJ1Y3RvcigncmV0dXJuIHByb2Nlc3MnKSgpYCDkuYvnsbvnmoTpgIPpgLjmmK/lt7Lnn6XnmoTvvInjgIJcbiAqIOacrOaPkuS7tueahOS/oeS7u+aooeWei+aYr+OAjOS9oOacrOacuuOAgeS9oOiHquW3seeahCBBSSDlrqLmiLfnq6/jgI3vvIzkuI3mmK/jgIzot5HpmYznlJ/kurrnmoTku6PnoIHjgI3jgIJcbiAqIOecn+ato+i1t+S9nOeUqOeahOWuieWFqOi+ueeVjOaYryAqKkhUVFAg5Y+q57uRIDEyNy4wLjAuMSoq77yI6KeBIG1jcC9zZXJ2ZXIudHPvvInjgIJcbiAqL1xuXG5pbXBvcnQgKiBhcyB2bSBmcm9tICd2bSc7XG5pbXBvcnQgeyBmb3JtYXRJbmxpbmUgfSBmcm9tICcuL3NlcmlhbGl6ZSc7XG5cbmV4cG9ydCB0eXBlIFNhbmRib3hMb2dMZXZlbCA9ICdsb2cnIHwgJ2luZm8nIHwgJ3dhcm4nIHwgJ2Vycm9yJyB8ICdkZWJ1Zyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2FuZGJveExvZ0VudHJ5IHtcbiAgICBsZXZlbDogU2FuZGJveExvZ0xldmVsO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICAvKiog55u45a+55pys5qyh5omn6KGM5byA5aeL55qE5q+r56eS5YGP56e777yM5L6/5LqO5a+56b2Q5pe25bqPICovXG4gICAgYXRNczogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNhbmRib3hSdW5PcHRpb25zIHtcbiAgICAvKiog55So5oi35Luj56CB77yI6aG25bGC5pSv5oyBIGByZXR1cm5gIC8gYGF3YWl0YO+8iSAqL1xuICAgIGNvZGU6IHN0cmluZztcbiAgICAvKiog5rOo5YWl5rKZ566x55qE5YWo5bGA6YeP77yMa2V5IOWNs+ijuOagh+ivhuespuWQjSAqL1xuICAgIGdsb2JhbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIC8qKiDotoXml7bmr6vnp5IgKi9cbiAgICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgICAvKiog55So5LqOIHZtIOaWh+S7tuWQjeS4jumUmeivr+S/oeaBr++8jOS4jeWQq+aJqeWxleWQjSAqL1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAgLyoqIOWNleadoeaXpeW/l+acgOWkp+Wtl+espuaVsCAqL1xuICAgIG1heExvZ0xlbmd0aD86IG51bWJlcjtcbiAgICAvKiog5pel5b+X5p2h5pWw5LiK6ZmQICovXG4gICAgbWF4TG9ncz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTYW5kYm94RXJyb3JJbmZvIHtcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgbWVzc2FnZTogc3RyaW5nO1xuICAgIHN0YWNrPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNhbmRib3hSdW5SZXN1bHQge1xuICAgIG9rOiBib29sZWFuO1xuICAgIC8qKiDnlKjmiLfku6PnoIEgYHJldHVybmAg55qE5Y6f5YC877yI5pyq57uP5bqP5YiX5YyW77yJICovXG4gICAgcmVzdWx0PzogdW5rbm93bjtcbiAgICBsb2dzOiBTYW5kYm94TG9nRW50cnlbXTtcbiAgICBlcnJvcj86IFNhbmRib3hFcnJvckluZm87XG4gICAgZHVyYXRpb25NczogbnVtYmVyO1xuICAgIC8qKiDmmK/lkKblm6DotoXml7blpLHotKUgKi9cbiAgICB0aW1lZE91dDogYm9vbGVhbjtcbiAgICAvKiog5piv5ZCm5Zug5pel5b+X5p2h5pWw5LiK6ZmQ6ICM5Lii5byD5LqG5ZCO57ut5pel5b+XICovXG4gICAgbG9nc1RydW5jYXRlZDogYm9vbGVhbjtcbn1cblxuY2xhc3MgU2FuZGJveFRpbWVvdXRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgICByZWFkb25seSBpc1NhbmRib3hUaW1lb3V0ID0gdHJ1ZTtcbiAgICBjb25zdHJ1Y3Rvcih0aW1lb3V0TXM6IG51bWJlcikge1xuICAgICAgICBzdXBlcihg5omn6KGM6LaF5pe277yIJHt0aW1lb3V0TXN9bXPvvIlgKTtcbiAgICAgICAgdGhpcy5uYW1lID0gJ1NhbmRib3hUaW1lb3V0RXJyb3InO1xuICAgIH1cbn1cblxuLyoqIOi3qCByZWFsbSDlronlhajnmoQgRXJyb3Ig5b2S5LiA5YyW77ya5rKZ566x6YeM5oqb5Ye655qEIEVycm9yIOWcqOWuv+S4u+S+pyBgaW5zdGFuY2VvZiBFcnJvcmAg5Li6IGZhbHNlICovXG5mdW5jdGlvbiBub3JtYWxpemVFcnJvcihlcnI6IHVua25vd24pOiBTYW5kYm94RXJyb3JJbmZvIHtcbiAgICBpZiAoZXJyID09PSBudWxsIHx8IGVyciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB7IG5hbWU6ICdFcnJvcicsIG1lc3NhZ2U6IFN0cmluZyhlcnIpIH07XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZXJyID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnIgYXMgeyBuYW1lPzogdW5rbm93bjsgbWVzc2FnZT86IHVua25vd247IHN0YWNrPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGFueUVyci5uYW1lID09PSAnc3RyaW5nJyAmJiBhbnlFcnIubmFtZSA/IGFueUVyci5uYW1lIDogJ0Vycm9yJztcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9XG4gICAgICAgICAgICB0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnICYmIGFueUVyci5tZXNzYWdlID8gYW55RXJyLm1lc3NhZ2UgOiBmb3JtYXRJbmxpbmUoZXJyKTtcbiAgICAgICAgY29uc3Qgc3RhY2sgPSB0eXBlb2YgYW55RXJyLnN0YWNrID09PSAnc3RyaW5nJyA/IGFueUVyci5zdGFjayA6IHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHsgbmFtZSwgbWVzc2FnZSwgc3RhY2sgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgbmFtZTogJ0Vycm9yJywgbWVzc2FnZTogU3RyaW5nKGVycikgfTtcbn1cblxuZnVuY3Rpb24gaXNUaW1lb3V0RXJyb3IoZXJyOiB1bmtub3duKTogYm9vbGVhbiB7XG4gICAgaWYgKGVyciAmJiB0eXBlb2YgZXJyID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnIgYXMgeyBpc1NhbmRib3hUaW1lb3V0PzogYm9vbGVhbjsgY29kZT86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgICAgIGlmIChhbnlFcnIuaXNTYW5kYm94VGltZW91dCkgcmV0dXJuIHRydWU7XG4gICAgICAgIC8vIE5vZGUg6Ieq5bex5oqb55qEIHZtIOi2heaXtlxuICAgICAgICBpZiAoYW55RXJyLmNvZGUgPT09ICdFUlJfU0NSSVBUX0VYRUNVVElPTl9USU1FT1VUJykgcmV0dXJuIHRydWU7XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnICYmIC9TY3JpcHQgZXhlY3V0aW9uIHRpbWVkIG91dC9pLnRlc3QoYW55RXJyLm1lc3NhZ2UpKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG59XG5cbmludGVyZmFjZSBDYXB0dXJlZENvbnNvbGUge1xuICAgIHNpbms6IFNhbmRib3hMb2dFbnRyeVtdO1xuICAgIG1heExvZ3M6IG51bWJlcjtcbiAgICBtYXhMb2dMZW5ndGg6IG51bWJlcjtcbiAgICB0cnVuY2F0ZWQ6IGJvb2xlYW47XG4gICAgc3RhcnRlZEF0OiBudW1iZXI7XG59XG5cbmZ1bmN0aW9uIG1ha2VDYXB0dXJlZENvbnNvbGUoY2FwdHVyZTogQ2FwdHVyZWRDb25zb2xlKTogUmVjb3JkPHN0cmluZywgKC4uLnBhcnRzOiB1bmtub3duW10pID0+IHZvaWQ+IHtcbiAgICBjb25zdCBwdXNoID0gKGxldmVsOiBTYW5kYm94TG9nTGV2ZWwpID0+ICguLi5wYXJ0czogdW5rbm93bltdKSA9PiB7XG4gICAgICAgIGlmIChjYXB0dXJlLnNpbmsubGVuZ3RoID49IGNhcHR1cmUubWF4TG9ncykge1xuICAgICAgICAgICAgY2FwdHVyZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHRleHQgPSBwYXJ0c1xuICAgICAgICAgICAgLm1hcCgocCkgPT4gKHR5cGVvZiBwID09PSAnc3RyaW5nJyA/IHAgOiBmb3JtYXRJbmxpbmUocCwgeyBtYXhEZXB0aDogNCwgbWF4U3RyaW5nTGVuZ3RoOiAyMDAwIH0pKSlcbiAgICAgICAgICAgIC5qb2luKCcgJyk7XG4gICAgICAgIGNhcHR1cmUuc2luay5wdXNoKHtcbiAgICAgICAgICAgIGxldmVsLFxuICAgICAgICAgICAgdGV4dDogdGV4dC5sZW5ndGggPiBjYXB0dXJlLm1heExvZ0xlbmd0aCA/IGAke3RleHQuc2xpY2UoMCwgY2FwdHVyZS5tYXhMb2dMZW5ndGgpfeKApmAgOiB0ZXh0LFxuICAgICAgICAgICAgYXRNczogRGF0ZS5ub3coKSAtIGNhcHR1cmUuc3RhcnRlZEF0LFxuICAgICAgICB9KTtcbiAgICB9O1xuICAgIHJldHVybiB7XG4gICAgICAgIGxvZzogcHVzaCgnbG9nJyksXG4gICAgICAgIGluZm86IHB1c2goJ2luZm8nKSxcbiAgICAgICAgd2FybjogcHVzaCgnd2FybicpLFxuICAgICAgICBlcnJvcjogcHVzaCgnZXJyb3InKSxcbiAgICAgICAgZGVidWc6IHB1c2goJ2RlYnVnJyksXG4gICAgICAgIHRyYWNlOiBwdXNoKCdkZWJ1ZycpLFxuICAgICAgICBkaXI6IHB1c2goJ2xvZycpLFxuICAgIH07XG59XG5cbi8qKiDmiornlKjmiLfku6PnoIHljIXmiJDlj68gYHJldHVybmAgLyBgYXdhaXRgIOeahOW8guatpSBJSUZFICovXG5leHBvcnQgZnVuY3Rpb24gd3JhcFVzZXJDb2RlKGNvZGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAoYXN5bmMgKCkgPT4ge1xcbiR7Y29kZX1cXG59KSgpYDtcbn1cblxuLyoqXG4gKiDlnKjpmpTnprvnmoQgdm0g5LiK5LiL5paH6YeM5omn6KGM55So5oi35Luj56CB44CCXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJ1biA9IGF3YWl0IHJ1bkluU2FuZGJveCh7XG4gKiAgICAgY29kZTogJ3JldHVybiAxICsgMTsnLFxuICogICAgIGdsb2JhbHM6IHsgRWRpdG9yIH0sXG4gKiAgICAgdGltZW91dE1zOiAxNTAwMCxcbiAqICAgICBsYWJlbDogJ2VkaXRvcicsXG4gKiB9KTtcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkluU2FuZGJveChvcHRpb25zOiBTYW5kYm94UnVuT3B0aW9ucyk6IFByb21pc2U8U2FuZGJveFJ1blJlc3VsdD4ge1xuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgY29uc3QgbG9nczogU2FuZGJveExvZ0VudHJ5W10gPSBbXTtcbiAgICBjb25zdCBtYXhMb2dzID0gb3B0aW9ucy5tYXhMb2dzID8/IDIwMDtcbiAgICBjb25zdCBtYXhMb2dMZW5ndGggPSBvcHRpb25zLm1heExvZ0xlbmd0aCA/PyA0MDAwO1xuXG4gICAgY29uc3QgY2FwdHVyZTogQ2FwdHVyZWRDb25zb2xlID0ge1xuICAgICAgICBzaW5rOiBsb2dzLFxuICAgICAgICBtYXhMb2dzLFxuICAgICAgICBtYXhMb2dMZW5ndGgsXG4gICAgICAgIHRydW5jYXRlZDogZmFsc2UsXG4gICAgICAgIHN0YXJ0ZWRBdCxcbiAgICB9O1xuXG4gICAgY29uc3QgZmluaXNoID0gKFxuICAgICAgICBwYXJ0aWFsOiBPbWl0PFNhbmRib3hSdW5SZXN1bHQsICdsb2dzJyB8ICdkdXJhdGlvbk1zJyB8ICdsb2dzVHJ1bmNhdGVkJz4sXG4gICAgKTogU2FuZGJveFJ1blJlc3VsdCA9PiAoe1xuICAgICAgICAuLi5wYXJ0aWFsLFxuICAgICAgICBsb2dzLFxuICAgICAgICBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRlZEF0LFxuICAgICAgICBsb2dzVHJ1bmNhdGVkOiBjYXB0dXJlLnRydW5jYXRlZCxcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gMS4g57yW6K+R5pyf6ZSZ6K+v77yI6K+t5rOV6ZSZ77yJ5Y2V54us5oqT77yM6ZSZ6K+v5L+h5oGv5pu05bmy5YeAIC0tLS1cbiAgICBsZXQgc2NyaXB0OiB2bS5TY3JpcHQ7XG4gICAgdHJ5IHtcbiAgICAgICAgc2NyaXB0ID0gbmV3IHZtLlNjcmlwdCh3cmFwVXNlckNvZGUob3B0aW9ucy5jb2RlKSwgeyBmaWxlbmFtZTogYCR7b3B0aW9ucy5sYWJlbH0uanNgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZmluaXNoKHsgb2s6IGZhbHNlLCBlcnJvcjogbm9ybWFsaXplRXJyb3IoZXJyKSwgdGltZWRPdXQ6IGZhbHNlIH0pO1xuICAgIH1cblxuICAgIC8vIC0tLS0gMi4g57uE6KOF5rKZ566x5YWo5bGA6YePIC0tLS1cbiAgICBjb25zdCBzYW5kYm94OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgY29uc29sZTogbWFrZUNhcHR1cmVkQ29uc29sZShjYXB0dXJlKSxcbiAgICAgICAgLi4ub3B0aW9ucy5nbG9iYWxzLFxuICAgIH07XG4gICAgbGV0IGNvbnRleHQ6IHZtLkNvbnRleHQ7XG4gICAgdHJ5IHtcbiAgICAgICAgY29udGV4dCA9IHZtLmNyZWF0ZUNvbnRleHQoc2FuZGJveCwgeyBuYW1lOiBvcHRpb25zLmxhYmVsIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZmluaXNoKHsgb2s6IGZhbHNlLCBlcnJvcjogbm9ybWFsaXplRXJyb3IoZXJyKSwgdGltZWRPdXQ6IGZhbHNlIH0pO1xuICAgIH1cblxuICAgIC8vIC0tLS0gMy4g5ZCM5q2l5q615omn6KGM77yIdm0g55qEIHRpbWVvdXQg5Zyo6L+Z5LiA5q6155Sf5pWI77yJLS0tLVxuICAgIGxldCByZXR1cm5lZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm5lZCA9IHNjcmlwdC5ydW5JbkNvbnRleHQoY29udGV4dCwge1xuICAgICAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0TXMsXG4gICAgICAgICAgICBkaXNwbGF5RXJyb3JzOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IG5vcm1hbGl6ZUVycm9yKGVyciksIHRpbWVkT3V0OiBpc1RpbWVvdXRFcnJvcihlcnIpIH0pO1xuICAgIH1cblxuICAgIC8vIC0tLS0gNC4g5byC5q2l5q615omn6KGM77yIdm0g55qEIHRpbWVvdXQg5LiN566hIGFzeW5j77yM6Z2g6K6h5pe25Zmo5YWc5bqV77yJLS0tLVxuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShyZXR1cm5lZCksXG4gICAgICAgICAgICBuZXcgUHJvbWlzZTxuZXZlcj4oKF9yZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBTYW5kYm94VGltZW91dEVycm9yKG9wdGlvbnMudGltZW91dE1zKSksIG9wdGlvbnMudGltZW91dE1zKTtcbiAgICAgICAgICAgIH0pLFxuICAgICAgICBdKTtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiB0cnVlLCByZXN1bHQsIHRpbWVkT3V0OiBmYWxzZSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6IG5vcm1hbGl6ZUVycm9yKGVyciksIHRpbWVkT3V0OiBpc1RpbWVvdXRFcnJvcihlcnIpIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9XG59XG4iXX0=