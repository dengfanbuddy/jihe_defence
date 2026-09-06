"use strict";
/**
 * 广播/通知模块 — 编辑器状态推送、视图刷新
 *
 * 提供工具执行结果广播、编辑器视图刷新、软重载等功能。
 * 注意：SSE 广播依赖 MCPServer 实例，通过全局事件或直接引用。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BroadcastModule = void 0;
const decorators_1 = require("../decorators");
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
async function callPreview(method, ...args) {
    try {
        return await Editor.Message.request('preview', method, ...args);
    }
    catch (e) {
        throw new Error(`预览消息 '${method}' 失败: ${e.message || e}`);
    }
}
let BroadcastModule = class BroadcastModule {
    async soft_reload() {
        await callScene('soft-reload');
        return { message: '场景已刷新' };
    }
    async refresh_preview() {
        await callPreview('reload-terminal');
        return { message: '预览已刷新' };
    }
    async broadcast_notification(params) {
        // 通过 console 输出（会被 debug/start_console_capture 捕获）
        const level = params.level || 'info';
        const prefix = level === 'error' ? '❌' : level === 'warning' ? '⚠️' : '📢';
        console.log(`[MCP Broadcast] ${prefix} ${params.message}`);
        // SSE 广播由 MCPServer.handleToolsCall 自动触发
        return {
            message: '通知已发布',
            level,
        };
    }
    editor_notify(params) {
        const type = params.type || 'info';
        const method = type === 'warn' ? 'warn' : type === 'error' ? 'error' : 'info';
        // 使用 Editor.Dialog 或 console 输出
        if (type === 'warn') {
            console.warn(`[MCP] ${params.message}`);
        }
        else if (type === 'error') {
            console.error(`[MCP] ${params.message}`);
        }
        else {
            console.log(`[MCP] ${params.message}`);
        }
        return { message: '提示已发送' };
    }
    get_broadcast_capabilities() {
        return {
            capabilities: [
                'soft_reload — 刷新场景编辑器视图（保留运行时状态）',
                'refresh_preview — 刷新浏览器/模拟器预览',
                'broadcast_notification — 向所有 MCP 客户端和编辑器推送通知',
                'editor_notify — 在编辑器中显示提示消息',
            ],
            note: '每次 tools/call 成功执行后，MCPServer 会自动向所有 SSE 客户端广播调用日志',
        };
    }
};
exports.BroadcastModule = BroadcastModule;
__decorate([
    (0, decorators_1.MCPTool)('刷新场景编辑器视图（软重载，保留状态）')
], BroadcastModule.prototype, "soft_reload", null);
__decorate([
    (0, decorators_1.MCPTool)('刷新预览窗口')
], BroadcastModule.prototype, "refresh_preview", null);
__decorate([
    (0, decorators_1.MCPTool)('向所有连接的 MCP 客户端广播通知', {
        level: { type: 'string', description: '通知级别（info/warning/error），默认 info' },
        message: { type: 'string', description: '通知内容', required: true },
    })
], BroadcastModule.prototype, "broadcast_notification", null);
__decorate([
    (0, decorators_1.MCPTool)('发送编辑器提示消息', {
        message: { type: 'string', description: '提示内容', required: true },
        type: { type: 'string', description: '消息类型（info/warn/error），默认 info' },
    })
], BroadcastModule.prototype, "editor_notify", null);
__decorate([
    (0, decorators_1.MCPTool)('获取广播模块能力说明')
], BroadcastModule.prototype, "get_broadcast_capabilities", null);
exports.BroadcastModule = BroadcastModule = __decorate([
    (0, decorators_1.MCPModule)('broadcast', '广播通知 - 刷新编辑器视图、推送状态更新')
], BroadcastModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQnJvYWRjYXN0TW9kdWxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc291cmNlL21jcC9tb2R1bGVzL0Jyb2FkY2FzdE1vZHVsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7Ozs7Ozs7OztBQUVILDhDQUFtRDtBQUVuRCxLQUFLLFVBQVUsU0FBUyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ3JELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDcEUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUdNLElBQU0sZUFBZSxHQUFyQixNQUFNLGVBQWU7SUFHbEIsQUFBTixLQUFLLENBQUMsV0FBVztRQUNiLE1BQU0sU0FBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQy9CLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLENBQUM7SUFDaEMsQ0FBQztJQUdLLEFBQU4sS0FB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ZUFBZSxDQStEM0IiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOW5v+aSrS/pgJrnn6XmqKHlnZcg4oCUIOe8lui+keWZqOeKtuaAgeaOqOmAgeOAgeinhuWbvuWIt+aWsFxuICpcbiAqIOaPkOS+m+W3peWFt+aJp+ihjOe7k+aenOW5v+aSreOAgee8lui+keWZqOinhuWbvuWIt+aWsOOAgei9r+mHjei9veetieWKn+iDveOAglxuICog5rOo5oSP77yaU1NFIOW5v+aSreS+nei1liBNQ1BTZXJ2ZXIg5a6e5L6L77yM6YCa6L+H5YWo5bGA5LqL5Lu25oiW55u05o6l5byV55So44CCXG4gKi9cblxuaW1wb3J0IHsgTUNQTW9kdWxlLCBNQ1BUb29sIH0gZnJvbSAnLi4vZGVjb3JhdG9ycyc7XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTY2VuZShtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxQcmV2aWV3KG1ldGhvZDogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3ByZXZpZXcnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOmihOiniOa2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5ATUNQTW9kdWxlKCdicm9hZGNhc3QnLCAn5bm/5pKt6YCa55+lIC0g5Yi35paw57yW6L6R5Zmo6KeG5Zu+44CB5o6o6YCB54q25oCB5pu05pawJylcbmV4cG9ydCBjbGFzcyBCcm9hZGNhc3RNb2R1bGUge1xuXG4gICAgQE1DUFRvb2woJ+WIt+aWsOWcuuaZr+e8lui+keWZqOinhuWbvu+8iOi9r+mHjei9ve+8jOS/neeVmeeKtuaAge+8iScpXG4gICAgYXN5bmMgc29mdF9yZWxvYWQoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgYXdhaXQgY2FsbFNjZW5lKCdzb2Z0LXJlbG9hZCcpO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiAn5Zy65pmv5bey5Yi35pawJyB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliLfmlrDpooTop4jnqpflj6MnKVxuICAgIGFzeW5jIHJlZnJlc2hfcHJldmlldygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBjYWxsUHJldmlldygncmVsb2FkLXRlcm1pbmFsJyk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICfpooTop4jlt7LliLfmlrAnIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WQkeaJgOaciei/nuaOpeeahCBNQ1Ag5a6i5oi356uv5bm/5pKt6YCa55+lJywge1xuICAgICAgICBsZXZlbDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfpgJrnn6XnuqfliKvvvIhpbmZvL3dhcm5pbmcvZXJyb3LvvInvvIzpu5jorqQgaW5mbycgfSxcbiAgICAgICAgbWVzc2FnZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfpgJrnn6XlhoXlrrknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgYnJvYWRjYXN0X25vdGlmaWNhdGlvbihwYXJhbXM6IHsgbGV2ZWw/OiBzdHJpbmc7IG1lc3NhZ2U6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgLy8g6YCa6L+HIGNvbnNvbGUg6L6T5Ye677yI5Lya6KKrIGRlYnVnL3N0YXJ0X2NvbnNvbGVfY2FwdHVyZSDmjZXojrfvvIlcbiAgICAgICAgY29uc3QgbGV2ZWwgPSBwYXJhbXMubGV2ZWwgfHwgJ2luZm8nO1xuICAgICAgICBjb25zdCBwcmVmaXggPSBsZXZlbCA9PT0gJ2Vycm9yJyA/ICfinYwnIDogbGV2ZWwgPT09ICd3YXJuaW5nJyA/ICfimqDvuI8nIDogJ/Cfk6InO1xuICAgICAgICBjb25zb2xlLmxvZyhgW01DUCBCcm9hZGNhc3RdICR7cHJlZml4fSAke3BhcmFtcy5tZXNzYWdlfWApO1xuXG4gICAgICAgIC8vIFNTRSDlub/mkq3nlLEgTUNQU2VydmVyLmhhbmRsZVRvb2xzQ2FsbCDoh6rliqjop6blj5FcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG1lc3NhZ2U6ICfpgJrnn6Xlt7Llj5HluIMnLFxuICAgICAgICAgICAgbGV2ZWwsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WPkemAgee8lui+keWZqOaPkOekuua2iOaBrycsIHtcbiAgICAgICAgbWVzc2FnZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmj5DnpLrlhoXlrrknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB0eXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+a2iOaBr+exu+Wei++8iGluZm8vd2Fybi9lcnJvcu+8ie+8jOm7mOiupCBpbmZvJyB9LFxuICAgIH0pXG4gICAgZWRpdG9yX25vdGlmeShwYXJhbXM6IHsgbWVzc2FnZTogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0pOiBhbnkge1xuICAgICAgICBjb25zdCB0eXBlID0gcGFyYW1zLnR5cGUgfHwgJ2luZm8nO1xuICAgICAgICBjb25zdCBtZXRob2QgPSB0eXBlID09PSAnd2FybicgPyAnd2FybicgOiB0eXBlID09PSAnZXJyb3InID8gJ2Vycm9yJyA6ICdpbmZvJztcblxuICAgICAgICAvLyDkvb/nlKggRWRpdG9yLkRpYWxvZyDmiJYgY29uc29sZSDovpPlh7pcbiAgICAgICAgaWYgKHR5cGUgPT09ICd3YXJuJykge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbTUNQXSAke3BhcmFtcy5tZXNzYWdlfWApO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdlcnJvcicpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtNQ1BdICR7cGFyYW1zLm1lc3NhZ2V9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW01DUF0gJHtwYXJhbXMubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICfmj5DnpLrlt7Llj5HpgIEnIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iOt+WPluW5v+aSreaooeWdl+iDveWKm+ivtOaYjicpXG4gICAgZ2V0X2Jyb2FkY2FzdF9jYXBhYmlsaXRpZXMoKTogYW55IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNhcGFiaWxpdGllczogW1xuICAgICAgICAgICAgICAgICdzb2Z0X3JlbG9hZCDigJQg5Yi35paw5Zy65pmv57yW6L6R5Zmo6KeG5Zu+77yI5L+d55WZ6L+Q6KGM5pe254q25oCB77yJJyxcbiAgICAgICAgICAgICAgICAncmVmcmVzaF9wcmV2aWV3IOKAlCDliLfmlrDmtY/op4jlmagv5qih5ouf5Zmo6aKE6KeIJyxcbiAgICAgICAgICAgICAgICAnYnJvYWRjYXN0X25vdGlmaWNhdGlvbiDigJQg5ZCR5omA5pyJIE1DUCDlrqLmiLfnq6/lkoznvJbovpHlmajmjqjpgIHpgJrnn6UnLFxuICAgICAgICAgICAgICAgICdlZGl0b3Jfbm90aWZ5IOKAlCDlnKjnvJbovpHlmajkuK3mmL7npLrmj5DnpLrmtojmga8nLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIG5vdGU6ICfmr4/mrKEgdG9vbHMvY2FsbCDmiJDlip/miafooYzlkI7vvIxNQ1BTZXJ2ZXIg5Lya6Ieq5Yqo5ZCR5omA5pyJIFNTRSDlrqLmiLfnq6/lub/mkq3osIPnlKjml6Xlv5cnLFxuICAgICAgICB9O1xuICAgIH1cbn1cbiJdfQ==