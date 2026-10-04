"use strict";
/**
 * 主进程 → 场景进程的调用桥。
 *
 * `Editor.Message.request('scene', 'execute-scene-script', {...})` 是编辑器给扩展的官方口子：
 * 把 `{ name, method, args }` 丢给 scene 包，scene 包找到名为 `name` 的扩展脚本、
 * 调它的 `methods[method](...args)`。
 *
 * 两个必须处理的现实问题：
 *
 * 1. **脚本可能还没加载**。场景进程只在「有场景打开 + scene 包已启动」时才加载扩展脚本。
 *    没加载时 `execute-scene-script` 会抛或返回 undefined —— 所以要能 ping 出「不可用」，
 *    并且把错误翻译成 AI 能据此行动的话（"先打开一个场景"），而不是一句 internals。
 * 2. **失败模式不止一种**，得区分开：IPC 本身炸了 / 脚本没注册 / 脚本执行里抛了。
 *    这三种对使用者的含义完全不同。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SceneUnavailableError = void 0;
exports.callSceneScript = callSceneScript;
exports.pingScene = pingScene;
exports.requestSceneSnapshot = requestSceneSnapshot;
const constants_1 = require("../constants");
class SceneUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SceneUnavailableError';
    }
}
exports.SceneUnavailableError = SceneUnavailableError;
function describeThrow(err) {
    if (err instanceof Error)
        return err.message;
    if (err && typeof err === 'object') {
        const anyErr = err;
        if (typeof anyErr.message === 'string')
            return anyErr.message;
    }
    return String(err);
}
/**
 * 调用场景脚本里的一个方法。
 *
 * @throws {SceneUnavailableError} 场景进程/脚本不可用时（提示语面向 AI，可直接照做）
 */
async function callSceneScript(method, args = []) {
    try {
        const value = await Editor.Message.request('scene', 'execute-scene-script', {
            name: constants_1.EXTENSION_NAME,
            method,
            args,
        });
        if (value === undefined || value === null) {
            throw new SceneUnavailableError(`场景脚本方法 ${method} 没有返回任何值。` +
                '通常是没有打开场景，或扩展刚加载、scene 包还没注册本扩展的脚本。' +
                '请在 Cocos Creator 里打开任意场景后重试。');
        }
        return value;
    }
    catch (err) {
        if (err instanceof SceneUnavailableError)
            throw err;
        throw new SceneUnavailableError(`调用场景脚本 ${method} 失败：${describeThrow(err)}。` +
            '如果当前没有打开场景，请先在 Cocos Creator 里打开一个场景。');
    }
}
/** 探活：场景脚本是否已加载可用 */
async function pingScene() {
    try {
        const res = await callSceneScript('ping');
        return res && res.ok ? { available: true } : { available: false, reason: '场景脚本返回异常' };
    }
    catch (err) {
        return { available: false, reason: describeThrow(err) };
    }
}
/**
 * 请求一次场景撤销快照。
 *
 * 场景脚本里的 `snapshot()` 只置标志位，真正的快照由这里发起 ——
 * 必须由主进程调，因为从 scene 进程给 scene 包发消息是自环。
 */
async function requestSceneSnapshot() {
    try {
        await Editor.Message.request('scene', 'snapshot');
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUtYnJpZGdlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL2NvcmUvc2NlbmUtYnJpZGdlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRzs7O0FBc0NILDBDQXlCQztBQUdELDhCQU9DO0FBUUQsb0RBT0M7QUF0RkQsNENBQThDO0FBZTlDLE1BQWEscUJBQXNCLFNBQVEsS0FBSztJQUM1QyxZQUFZLE9BQWU7UUFDdkIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDLElBQUksR0FBRyx1QkFBdUIsQ0FBQztJQUN4QyxDQUFDO0NBQ0o7QUFMRCxzREFLQztBQUVELFNBQVMsYUFBYSxDQUFDLEdBQVk7SUFDL0IsSUFBSSxHQUFHLFlBQVksS0FBSztRQUFFLE9BQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQztJQUM3QyxJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNqQyxNQUFNLE1BQU0sR0FBRyxHQUE0QixDQUFDO1FBQzVDLElBQUksT0FBTyxNQUFNLENBQUMsT0FBTyxLQUFLLFFBQVE7WUFBRSxPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUM7SUFDbEUsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZCLENBQUM7QUFFRDs7OztHQUlHO0FBQ0ksS0FBSyxVQUFVLGVBQWUsQ0FDakMsTUFBYyxFQUNkLE9BQWtCLEVBQUU7SUFFcEIsSUFBSSxDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUU7WUFDeEUsSUFBSSxFQUFFLDBCQUFjO1lBQ3BCLE1BQU07WUFDTixJQUFJO1NBQ1AsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUN4QyxNQUFNLElBQUkscUJBQXFCLENBQzNCLFVBQVUsTUFBTSxXQUFXO2dCQUN2QixxQ0FBcUM7Z0JBQ3JDLDhCQUE4QixDQUNyQyxDQUFDO1FBQ04sQ0FBQztRQUNELE9BQU8sS0FBVSxDQUFDO0lBQ3RCLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ1gsSUFBSSxHQUFHLFlBQVkscUJBQXFCO1lBQUUsTUFBTSxHQUFHLENBQUM7UUFDcEQsTUFBTSxJQUFJLHFCQUFxQixDQUMzQixVQUFVLE1BQU0sT0FBTyxhQUFhLENBQUMsR0FBRyxDQUFDLEdBQUc7WUFDeEMsdUNBQXVDLENBQzlDLENBQUM7SUFDTixDQUFDO0FBQ0wsQ0FBQztBQUVELHFCQUFxQjtBQUNkLEtBQUssVUFBVSxTQUFTO0lBQzNCLElBQUksQ0FBQztRQUNELE1BQU0sR0FBRyxHQUFHLE1BQU0sZUFBZSxDQUFtQixNQUFNLENBQUMsQ0FBQztRQUM1RCxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsQ0FBQztJQUMxRixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxhQUFhLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztJQUM1RCxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0ksS0FBSyxVQUFVLG9CQUFvQjtJQUN0QyxJQUFJLENBQUM7UUFDRCxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUNsRCxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxLQUFLLENBQUM7SUFDakIsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOS4u+i/m+eoiyDihpIg5Zy65pmv6L+b56iL55qE6LCD55So5qGl44CCXG4gKlxuICogYEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywgey4uLn0pYCDmmK/nvJbovpHlmajnu5nmianlsZXnmoTlrpjmlrnlj6PlrZDvvJpcbiAqIOaKiiBgeyBuYW1lLCBtZXRob2QsIGFyZ3MgfWAg5Lii57uZIHNjZW5lIOWMhe+8jHNjZW5lIOWMheaJvuWIsOWQjeS4uiBgbmFtZWAg55qE5omp5bGV6ISa5pys44CBXG4gKiDosIPlroPnmoQgYG1ldGhvZHNbbWV0aG9kXSguLi5hcmdzKWDjgIJcbiAqXG4gKiDkuKTkuKrlv4XpobvlpITnkIbnmoTnjrDlrp7pl67popjvvJpcbiAqXG4gKiAxLiAqKuiEmuacrOWPr+iDvei/mOayoeWKoOi9vSoq44CC5Zy65pmv6L+b56iL5Y+q5Zyo44CM5pyJ5Zy65pmv5omT5byAICsgc2NlbmUg5YyF5bey5ZCv5Yqo44CN5pe25omN5Yqg6L295omp5bGV6ISa5pys44CCXG4gKiAgICDmsqHliqDovb3ml7YgYGV4ZWN1dGUtc2NlbmUtc2NyaXB0YCDkvJrmipvmiJbov5Tlm54gdW5kZWZpbmVkIOKAlOKAlCDmiYDku6XopoHog70gcGluZyDlh7rjgIzkuI3lj6/nlKjjgI3vvIxcbiAqICAgIOW5tuS4lOaKiumUmeivr+e/u+ivkeaIkCBBSSDog73mja7mraTooYzliqjnmoTor53vvIhcIuWFiOaJk+W8gOS4gOS4quWcuuaZr1wi77yJ77yM6ICM5LiN5piv5LiA5Y+lIGludGVybmFsc+OAglxuICogMi4gKirlpLHotKXmqKHlvI/kuI3mraLkuIDnp40qKu+8jOW+l+WMuuWIhuW8gO+8mklQQyDmnKzouqvngrjkuoYgLyDohJrmnKzmsqHms6jlhowgLyDohJrmnKzmiafooYzph4zmipvkuobjgIJcbiAqICAgIOi/meS4ieenjeWvueS9v+eUqOiAheeahOWQq+S5ieWujOWFqOS4jeWQjOOAglxuICovXG5cbmltcG9ydCB7IEVYVEVOU0lPTl9OQU1FIH0gZnJvbSAnLi4vY29uc3RhbnRzJztcblxuLyoqIHNjZW5lIOiEmuacrOe7n+S4gOi/lOWbnueahOW9oueKtu+8iOingSBzb3VyY2Uvc2NlbmUudHMg55qEIGZpbmlzaCgp77yJICovXG5leHBvcnQgaW50ZXJmYWNlIFNjZW5lU2NyaXB0RW52ZWxvcGUge1xuICAgIG9rPzogYm9vbGVhbjtcbiAgICBlcnJvcj86IHsgbmFtZT86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZzsgc3RhY2s/OiBzdHJpbmcgfTtcbiAgICBsb2dzPzogQXJyYXk8eyBsZXZlbDogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGF0TXM6IG51bWJlciB9PjtcbiAgICBsb2dzVHJ1bmNhdGVkPzogYm9vbGVhbjtcbiAgICBkdXJhdGlvbk1zPzogbnVtYmVyO1xuICAgIHJlc3VsdD86IHVua25vd247XG4gICAgdGltZWRPdXQ/OiBib29sZWFuO1xuICAgIHNuYXBzaG90UmVxdWVzdGVkPzogYm9vbGVhbjtcbiAgICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5leHBvcnQgY2xhc3MgU2NlbmVVbmF2YWlsYWJsZUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICAgIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgICAgICBzdXBlcihtZXNzYWdlKTtcbiAgICAgICAgdGhpcy5uYW1lID0gJ1NjZW5lVW5hdmFpbGFibGVFcnJvcic7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBkZXNjcmliZVRocm93KGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyLm1lc3NhZ2U7XG4gICAgaWYgKGVyciAmJiB0eXBlb2YgZXJyID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnIgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9O1xuICAgICAgICBpZiAodHlwZW9mIGFueUVyci5tZXNzYWdlID09PSAnc3RyaW5nJykgcmV0dXJuIGFueUVyci5tZXNzYWdlO1xuICAgIH1cbiAgICByZXR1cm4gU3RyaW5nKGVycik7XG59XG5cbi8qKlxuICog6LCD55So5Zy65pmv6ISa5pys6YeM55qE5LiA5Liq5pa55rOV44CCXG4gKlxuICogQHRocm93cyB7U2NlbmVVbmF2YWlsYWJsZUVycm9yfSDlnLrmma/ov5vnqIsv6ISa5pys5LiN5Y+v55So5pe277yI5o+Q56S66K+t6Z2i5ZCRIEFJ77yM5Y+v55u05o6l54Wn5YGa77yJXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsU2NlbmVTY3JpcHQ8VCA9IFNjZW5lU2NyaXB0RW52ZWxvcGU+KFxuICAgIG1ldGhvZDogc3RyaW5nLFxuICAgIGFyZ3M6IHVua25vd25bXSA9IFtdLFxuKTogUHJvbWlzZTxUPiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6IEVYVEVOU0lPTl9OQU1FLFxuICAgICAgICAgICAgbWV0aG9kLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgU2NlbmVVbmF2YWlsYWJsZUVycm9yKFxuICAgICAgICAgICAgICAgIGDlnLrmma/ohJrmnKzmlrnms5UgJHttZXRob2R9IOayoeaciei/lOWbnuS7u+S9leWAvOOAgmAgK1xuICAgICAgICAgICAgICAgICAgICAn6YCa5bi45piv5rKh5pyJ5omT5byA5Zy65pmv77yM5oiW5omp5bGV5Yia5Yqg6L2944CBc2NlbmUg5YyF6L+Y5rKh5rOo5YaM5pys5omp5bGV55qE6ISa5pys44CCJyArXG4gICAgICAgICAgICAgICAgICAgICfor7flnKggQ29jb3MgQ3JlYXRvciDph4zmiZPlvIDku7vmhI/lnLrmma/lkI7ph43or5XjgIInLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWUgYXMgVDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIFNjZW5lVW5hdmFpbGFibGVFcnJvcikgdGhyb3cgZXJyO1xuICAgICAgICB0aHJvdyBuZXcgU2NlbmVVbmF2YWlsYWJsZUVycm9yKFxuICAgICAgICAgICAgYOiwg+eUqOWcuuaZr+iEmuacrCAke21ldGhvZH0g5aSx6LSl77yaJHtkZXNjcmliZVRocm93KGVycil944CCYCArXG4gICAgICAgICAgICAgICAgJ+WmguaenOW9k+WJjeayoeacieaJk+W8gOWcuuaZr++8jOivt+WFiOWcqCBDb2NvcyBDcmVhdG9yIOmHjOaJk+W8gOS4gOS4quWcuuaZr+OAgicsXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vKiog5o6i5rS777ya5Zy65pmv6ISa5pys5piv5ZCm5bey5Yqg6L295Y+v55SoICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGluZ1NjZW5lKCk6IFByb21pc2U8eyBhdmFpbGFibGU6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbFNjZW5lU2NyaXB0PHsgb2s/OiBib29sZWFuIH0+KCdwaW5nJyk7XG4gICAgICAgIHJldHVybiByZXMgJiYgcmVzLm9rID8geyBhdmFpbGFibGU6IHRydWUgfSA6IHsgYXZhaWxhYmxlOiBmYWxzZSwgcmVhc29uOiAn5Zy65pmv6ISa5pys6L+U5Zue5byC5bi4JyB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4geyBhdmFpbGFibGU6IGZhbHNlLCByZWFzb246IGRlc2NyaWJlVGhyb3coZXJyKSB9O1xuICAgIH1cbn1cblxuLyoqXG4gKiDor7fmsYLkuIDmrKHlnLrmma/mkqTplIDlv6vnhafjgIJcbiAqXG4gKiDlnLrmma/ohJrmnKzph4znmoQgYHNuYXBzaG90KClgIOWPque9ruagh+W/l+S9je+8jOecn+ato+eahOW/q+eFp+eUsei/memHjOWPkei1tyDigJTigJRcbiAqIOW/hemhu+eUseS4u+i/m+eoi+iwg++8jOWboOS4uuS7jiBzY2VuZSDov5vnqIvnu5kgc2NlbmUg5YyF5Y+R5raI5oGv5piv6Ieq546v44CCXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXF1ZXN0U2NlbmVTbmFwc2hvdCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cbiJdfQ==