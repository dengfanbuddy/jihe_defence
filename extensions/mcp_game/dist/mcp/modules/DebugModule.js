"use strict";
/**
 * 调试/诊断模块 — 控制台捕获、场景统计、运行时信息
 *
 * 提供运行时状态可观测性：让 AI 能"看到"控制台输出、场景节点/组件数量等。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugModule = void 0;
const decorators_1 = require("../decorators");
/** 控制台捕获缓冲区 */
const consoleBuffer = [];
const MAX_BUFFER = 500;
let captureActive = false;
let originalConsole = null;
function startCapture() {
    if (captureActive)
        return;
    captureActive = true;
    originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
    };
    const wrap = (type, original) => {
        return (...args) => {
            const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            consoleBuffer.push({ timestamp: new Date().toISOString(), type, message });
            if (consoleBuffer.length > MAX_BUFFER)
                consoleBuffer.shift();
            original.apply(console, args);
        };
    };
    console.log = wrap('log', originalConsole.log);
    console.warn = wrap('warn', originalConsole.warn);
    console.error = wrap('error', originalConsole.error);
    console.info = wrap('info', originalConsole.info);
}
function stopCapture() {
    if (!captureActive)
        return;
    captureActive = false;
    if (originalConsole) {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.info = originalConsole.info;
        originalConsole = null;
    }
}
/** 安全调用 editor API */
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
async function executeSceneScript(method, args = []) {
    try {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
    }
    catch (e) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}
let DebugModule = class DebugModule {
    // ==================== 控制台捕获 ====================
    start_console_capture() {
        startCapture();
        return { message: '控制台捕获已开启', bufferSize: consoleBuffer.length };
    }
    stop_console_capture() {
        stopCapture();
        return { message: '控制台捕获已停止' };
    }
    get_console_logs(params) {
        let logs = [...consoleBuffer];
        if (params === null || params === void 0 ? void 0 : params.type) {
            logs = logs.filter(l => l.type === params.type);
        }
        const limit = parseInt((params === null || params === void 0 ? void 0 : params.limit) || '50', 10);
        logs = logs.slice(-limit);
        return {
            logs,
            total: consoleBuffer.length,
            captureActive,
        };
    }
    clear_console_logs() {
        consoleBuffer.length = 0;
        return { message: '缓冲区已清除' };
    }
    // ==================== 场景统计 ====================
    async get_scene_stats() {
        var _a, _b, _c, _d, _e, _f;
        // 通过场景脚本收集运行时信息
        const sceneInfo = await executeSceneScript('getCurrentSceneInfo');
        const allNodes = await executeSceneScript('getAllNodes');
        let componentCount = 0;
        if (allNodes.data && Array.isArray(allNodes.data)) {
            // 粗略估算：每个节点至少有一个 Transform
            componentCount = allNodes.data.length;
        }
        return {
            sceneName: (_a = sceneInfo.data) === null || _a === void 0 ? void 0 : _a.name,
            nodeCount: (_e = (_c = (_b = sceneInfo.data) === null || _b === void 0 ? void 0 : _b.nodeCount) !== null && _c !== void 0 ? _c : (_d = allNodes.data) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0,
            estimatedComponentCount: componentCount,
            active: (_f = sceneInfo.data) === null || _f === void 0 ? void 0 : _f.active,
        };
    }
    async get_component_stats() {
        try {
            const hierarchy = await executeSceneScript('getSceneHierarchy', [true]);
            const counts = {};
            const walk = (node) => {
                if (node.components) {
                    node.components.forEach((c) => {
                        counts[c.type] = (counts[c.type] || 0) + 1;
                    });
                }
                if (node.children)
                    node.children.forEach(walk);
            };
            if (hierarchy.data) {
                (Array.isArray(hierarchy.data) ? hierarchy.data : [hierarchy.data]).forEach(walk);
            }
            return { componentDistribution: counts };
        }
        catch (e) {
            throw new Error(`获取组件统计失败: ${e.message}`);
        }
    }
    // ==================== 编辑器诊断 ====================
    async get_editor_status() {
        const results = {};
        try {
            results.sceneReady = await callScene('query-is-ready');
        }
        catch (_a) {
            results.sceneReady = 'unknown';
        }
        try {
            results.sceneDirty = await callScene('query-dirty');
        }
        catch (_b) {
            results.sceneDirty = 'unknown';
        }
        try {
            const cs = await callScene('query-current-scene');
            results.currentScene = (cs === null || cs === void 0 ? void 0 : cs.name) || null;
        }
        catch (_c) {
            results.currentScene = null;
        }
        return results;
    }
    get_environment_info() {
        var _a;
        return {
            editorVersion: ((_a = Editor.App) === null || _a === void 0 ? void 0 : _a.version) || 'unknown',
            platform: process.platform,
            nodeVersion: process.version,
            arch: process.arch,
            cwd: process.cwd(),
            mcpExtensionVersion: '1.0.0',
        };
    }
};
exports.DebugModule = DebugModule;
__decorate([
    (0, decorators_1.MCPTool)('开启控制台日志捕获（拦截 console.log/warn/error）')
], DebugModule.prototype, "start_console_capture", null);
__decorate([
    (0, decorators_1.MCPTool)('停止控制台捕获')
], DebugModule.prototype, "stop_console_capture", null);
__decorate([
    (0, decorators_1.MCPTool)('获取捕获的控制台日志', {
        type: { type: 'string', description: '日志类型过滤（log/warn/error/info），默认全部' },
        limit: { type: 'string', description: '返回条数上限（默认 50）' },
    })
], DebugModule.prototype, "get_console_logs", null);
__decorate([
    (0, decorators_1.MCPTool)('清除控制台捕获缓冲区')
], DebugModule.prototype, "clear_console_logs", null);
__decorate([
    (0, decorators_1.MCPTool)('获取当前场景运行时统计（节点数/组件数/绘制调用等）')
], DebugModule.prototype, "get_scene_stats", null);
__decorate([
    (0, decorators_1.MCPTool)('获取场景中所有组件类型的统计分布')
], DebugModule.prototype, "get_component_stats", null);
__decorate([
    (0, decorators_1.MCPTool)('查询编辑器关键状态（场景是否就绪、是否有未保存修改等）')
], DebugModule.prototype, "get_editor_status", null);
__decorate([
    (0, decorators_1.MCPTool)('获取编辑器扩展运行环境信息')
], DebugModule.prototype, "get_environment_info", null);
exports.DebugModule = DebugModule = __decorate([
    (0, decorators_1.MCPModule)('debug', '调试诊断 - 控制台捕获、场景统计、运行时信息')
], DebugModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVidWdNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvRGVidWdNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7OztBQUVILDhDQUFtRDtBQUVuRCxlQUFlO0FBQ2YsTUFBTSxhQUFhLEdBQXNGLEVBQUUsQ0FBQztBQUM1RyxNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUM7QUFDdkIsSUFBSSxhQUFhLEdBQUcsS0FBSyxDQUFDO0FBQzFCLElBQUksZUFBZSxHQUFRLElBQUksQ0FBQztBQUVoQyxTQUFTLFlBQVk7SUFDakIsSUFBSSxhQUFhO1FBQUUsT0FBTztJQUMxQixhQUFhLEdBQUcsSUFBSSxDQUFDO0lBQ3JCLGVBQWUsR0FBRztRQUNkLEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRztRQUNoQixJQUFJLEVBQUUsT0FBTyxDQUFDLElBQUk7UUFDbEIsS0FBSyxFQUFFLE9BQU8sQ0FBQyxLQUFLO1FBQ3BCLElBQUksRUFBRSxPQUFPLENBQUMsSUFBSTtLQUNyQixDQUFDO0lBRUYsTUFBTSxJQUFJLEdBQUcsQ0FBQyxJQUF1QyxFQUFFLFFBQWtCLEVBQUUsRUFBRTtRQUN6RSxPQUFPLENBQUMsR0FBRyxJQUFXLEVBQUUsRUFBRTtZQUN0QixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ2pHLGFBQWEsQ0FBQyxJQUFJLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsRUFBRSxJQUFJLEVBQUUs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LEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRTtZQUNsQixtQkFBbUIsRUFBRSxPQUFPO1NBQy9CLENBQUM7SUFDTixDQUFDO0NBQ0osQ0FBQTtBQWxIWSxrQ0FBVztBQUtwQjtJQURDLElBQUEsb0JBQU8sRUFBQyxzQ0FBc0MsQ0FBQzt3REFJL0M7QUFHRDtJQURDLElBQUEsb0JBQU8sRUFBQyxTQUFTLENBQUM7dURBSWxCO0FBTUQ7SUFKQyxJQUFBLG9CQUFPLEVBQUMsWUFBWSxFQUFFO1FBQ25CLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGtDQUFrQyxFQUFFO1FBQ3pFLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRTtLQUMxRCxDQUFDO21EQWFEO0FBR0Q7SUFEQyxJQUFBLG9CQUFPLEVBQUMsWUFBWSxDQUFDO3FEQUlyQjtBQUtLO0lBREwsSUFBQSxvQkFBTyxFQUFDLDRCQUE0QixDQUFDO2tEQWtCckM7QUFHSztJQURMLElBQUEsb0JBQU8sRUFBQyxrQkFBa0IsQ0FBQztzREF1QjNCO0FBS0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsNkJBQTZCLENBQUM7b0RBWXRDO0FBR0Q7SUFEQyxJQUFBLG9CQUFPLEVBQUMsZUFBZSxDQUFDO3VEQVV4QjtzQkFqSFEsV0FBVztJQUR2QixJQUFBLHNCQUFTLEVBQUMsT0FBTyxFQUFFLHlCQUF5QixDQUFDO0dBQ2pDLFdBQVcsQ0FrSHZCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDosIPor5Uv6K+K5pat5qih5Z2XIOKAlCDmjqfliLblj7DmjZXojrfjgIHlnLrmma/nu5/orqHjgIHov5DooYzml7bkv6Hmga9cbiAqXG4gKiDmj5Dkvpvov5DooYzml7bnirbmgIHlj6/op4LmtYvmgKfvvJrorqkgQUkg6IO9XCLnnIvliLBcIuaOp+WItuWPsOi+k+WHuuOAgeWcuuaZr+iKgueCuS/nu4Tku7bmlbDph4/nrYnjgIJcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcblxuLyoqIOaOp+WItuWPsOaNleiOt+e8k+WGsuWMuiAqL1xuY29uc3QgY29uc29sZUJ1ZmZlcjogeyB0aW1lc3RhbXA6IHN0cmluZzsgdHlwZTogJ2xvZycgfCAnd2FybicgfCAnZXJyb3InIHwgJ2luZm8nOyBtZXNzYWdlOiBzdHJpbmcgfVtdID0gW107XG5jb25zdCBNQVhfQlVGRkVSID0gNTAwO1xubGV0IGNhcHR1cmVBY3RpdmUgPSBmYWxzZTtcbmxldCBvcmlnaW5hbENvbnNvbGU6IGFueSA9IG51bGw7XG5cbmZ1bmN0aW9uIHN0YXJ0Q2FwdHVyZSgpIHtcbiAgICBpZiAoY2FwdHVyZUFjdGl2ZSkgcmV0dXJuO1xuICAgIGNhcHR1cmVBY3RpdmUgPSB0cnVlO1xuICAgIG9yaWdpbmFsQ29uc29sZSA9IHtcbiAgICAgICAgbG9nOiBjb25zb2xlLmxvZyxcbiAgICAgICAgd2FybjogY29uc29sZS53YXJuLFxuICAgICAgICBlcnJvcjogY29uc29sZS5lcnJvcixcbiAgICAgICAgaW5mbzogY29uc29sZS5pbmZvLFxuICAgIH07XG5cbiAgICBjb25zdCB3cmFwID0gKHR5cGU6ICdsb2cnIHwgJ3dhcm4nIHwgJ2Vycm9yJyB8ICdpbmZvJywgb3JpZ2luYWw6IEZ1bmN0aW9uKSA9PiB7XG4gICAgICAgIHJldHVybiAoLi4uYXJnczogYW55W10pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBhcmdzLm1hcChhID0+ICh0eXBlb2YgYSA9PT0gJ29iamVjdCcgPyBKU09OLnN0cmluZ2lmeShhKSA6IFN0cmluZyhhKSkpLmpvaW4oJyAnKTtcbiAgICAgICAgICAgIGNvbnNvbGVCdWZmZXIucHVzaCh7IHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB0eXBlLCBtZXNzYWdlIH0pO1xuICAgICAgICAgICAgaWYgKGNvbnNvbGVCdWZmZXIubGVuZ3RoID4gTUFYX0JVRkZFUikgY29uc29sZUJ1ZmZlci5zaGlmdCgpO1xuICAgICAgICAgICAgb3JpZ2luYWwuYXBwbHkoY29uc29sZSwgYXJncyk7XG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIGNvbnNvbGUubG9nID0gd3JhcCgnbG9nJywgb3JpZ2luYWxDb25zb2xlLmxvZyk7XG4gICAgY29uc29sZS53YXJuID0gd3JhcCgnd2FybicsIG9yaWdpbmFsQ29uc29sZS53YXJuKTtcbiAgICBjb25zb2xlLmVycm9yID0gd3JhcCgnZXJyb3InLCBvcmlnaW5hbENvbnNvbGUuZXJyb3IpO1xuICAgIGNvbnNvbGUuaW5mbyA9IHdyYXAoJ2luZm8nLCBvcmlnaW5hbENvbnNvbGUuaW5mbyk7XG59XG5cbmZ1bmN0aW9uIHN0b3BDYXB0dXJlKCkge1xuICAgIGlmICghY2FwdHVyZUFjdGl2ZSkgcmV0dXJuO1xuICAgIGNhcHR1cmVBY3RpdmUgPSBmYWxzZTtcbiAgICBpZiAob3JpZ2luYWxDb25zb2xlKSB7XG4gICAgICAgIGNvbnNvbGUubG9nID0gb3JpZ2luYWxDb25zb2xlLmxvZztcbiAgICAgICAgY29uc29sZS53YXJuID0gb3JpZ2luYWxDb25zb2xlLndhcm47XG4gICAgICAgIGNvbnNvbGUuZXJyb3IgPSBvcmlnaW5hbENvbnNvbGUuZXJyb3I7XG4gICAgICAgIGNvbnNvbGUuaW5mbyA9IG9yaWdpbmFsQ29uc29sZS5pbmZvO1xuICAgICAgICBvcmlnaW5hbENvbnNvbGUgPSBudWxsO1xuICAgIH1cbn1cblxuLyoqIOWuieWFqOiwg+eUqCBlZGl0b3IgQVBJICovXG5hc3luYyBmdW5jdGlvbiBjYWxsU2NlbmUobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+a2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlU2NlbmVTY3JpcHQobWV0aG9kOiBzdHJpbmcsIGFyZ3M6IGFueVtdID0gW10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6ICdtY3BfZ2FtZScsXG4gICAgICAgICAgICBtZXRob2QsXG4gICAgICAgICAgICBhcmdzLFxuICAgICAgICB9KTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/ohJrmnKwgJyR7bWV0aG9kfScg5aSx6LSlOiAke2UubWVzc2FnZSB8fCBlfWApO1xuICAgIH1cbn1cblxuQE1DUE1vZHVsZSgnZGVidWcnLCAn6LCD6K+V6K+K5patIC0g5o6n5Yi25Y+w5o2V6I6344CB5Zy65pmv57uf6K6h44CB6L+Q6KGM5pe25L+h5oGvJylcbmV4cG9ydCBjbGFzcyBEZWJ1Z01vZHVsZSB7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDmjqfliLblj7DmjZXojrcgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCflvIDlkK/mjqfliLblj7Dml6Xlv5fmjZXojrfvvIjmi6bmiKogY29uc29sZS5sb2cvd2Fybi9lcnJvcu+8iScpXG4gICAgc3RhcnRfY29uc29sZV9jYXB0dXJlKCk6IGFueSB7XG4gICAgICAgIHN0YXJ0Q2FwdHVyZSgpO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiAn5o6n5Yi25Y+w5o2V6I635bey5byA5ZCvJywgYnVmZmVyU2l6ZTogY29uc29sZUJ1ZmZlci5sZW5ndGggfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5YGc5q2i5o6n5Yi25Y+w5o2V6I63JylcbiAgICBzdG9wX2NvbnNvbGVfY2FwdHVyZSgpOiBhbnkge1xuICAgICAgICBzdG9wQ2FwdHVyZSgpO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiAn5o6n5Yi25Y+w5o2V6I635bey5YGc5q2iJyB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfojrflj5bmjZXojrfnmoTmjqfliLblj7Dml6Xlv5cnLCB7XG4gICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pel5b+X57G75Z6L6L+H5ruk77yIbG9nL3dhcm4vZXJyb3IvaW5mb++8ie+8jOm7mOiupOWFqOmDqCcgfSxcbiAgICAgICAgbGltaXQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6L+U5Zue5p2h5pWw5LiK6ZmQ77yI6buY6K6kIDUw77yJJyB9LFxuICAgIH0pXG4gICAgZ2V0X2NvbnNvbGVfbG9ncyhwYXJhbXM/OiB7IHR5cGU/OiBzdHJpbmc7IGxpbWl0Pzogc3RyaW5nIH0pOiBhbnkge1xuICAgICAgICBsZXQgbG9ncyA9IFsuLi5jb25zb2xlQnVmZmVyXTtcbiAgICAgICAgaWYgKHBhcmFtcz8udHlwZSkge1xuICAgICAgICAgICAgbG9ncyA9IGxvZ3MuZmlsdGVyKGwgPT4gbC50eXBlID09PSBwYXJhbXMudHlwZSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbGltaXQgPSBwYXJzZUludChwYXJhbXM/LmxpbWl0IHx8ICc1MCcsIDEwKTtcbiAgICAgICAgbG9ncyA9IGxvZ3Muc2xpY2UoLWxpbWl0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGxvZ3MsXG4gICAgICAgICAgICB0b3RhbDogY29uc29sZUJ1ZmZlci5sZW5ndGgsXG4gICAgICAgICAgICBjYXB0dXJlQWN0aXZlLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmuIXpmaTmjqfliLblj7DmjZXojrfnvJPlhrLljLonKVxuICAgIGNsZWFyX2NvbnNvbGVfbG9ncygpOiBhbnkge1xuICAgICAgICBjb25zb2xlQnVmZmVyLmxlbmd0aCA9IDA7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICfnvJPlhrLljLrlt7LmuIXpmaQnIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Zy65pmv57uf6K6hID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6I635Y+W5b2T5YmN5Zy65pmv6L+Q6KGM5pe257uf6K6h77yI6IqC54K55pWwL+e7hOS7tuaVsC/nu5jliLbosIPnlKjnrYnvvIknKVxuICAgIGFzeW5jIGdldF9zY2VuZV9zdGF0cygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICAvLyDpgJrov4flnLrmma/ohJrmnKzmlLbpm4bov5DooYzml7bkv6Hmga9cbiAgICAgICAgY29uc3Qgc2NlbmVJbmZvID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRDdXJyZW50U2NlbmVJbmZvJyk7XG4gICAgICAgIGNvbnN0IGFsbE5vZGVzID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRBbGxOb2RlcycpO1xuXG4gICAgICAgIGxldCBjb21wb25lbnRDb3VudCA9IDA7XG4gICAgICAgIGlmIChhbGxOb2Rlcy5kYXRhICYmIEFycmF5LmlzQXJyYXkoYWxsTm9kZXMuZGF0YSkpIHtcbiAgICAgICAgICAgIC8vIOeyl+eVpeS8sOeul++8muavj+S4quiKgueCueiHs+WwkeacieS4gOS4qiBUcmFuc2Zvcm1cbiAgICAgICAgICAgIGNvbXBvbmVudENvdW50ID0gYWxsTm9kZXMuZGF0YS5sZW5ndGg7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc2NlbmVOYW1lOiBzY2VuZUluZm8uZGF0YT8ubmFtZSxcbiAgICAgICAgICAgIG5vZGVDb3VudDogc2NlbmVJbmZvLmRhdGE/Lm5vZGVDb3VudCA/PyBhbGxOb2Rlcy5kYXRhPy5sZW5ndGggPz8gMCxcbiAgICAgICAgICAgIGVzdGltYXRlZENvbXBvbmVudENvdW50OiBjb21wb25lbnRDb3VudCxcbiAgICAgICAgICAgIGFjdGl2ZTogc2NlbmVJbmZvLmRhdGE/LmFjdGl2ZSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6I635Y+W5Zy65pmv5Lit5omA5pyJ57uE5Lu257G75Z6L55qE57uf6K6h5YiG5biDJylcbiAgICBhc3luYyBnZXRfY29tcG9uZW50X3N0YXRzKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBoaWVyYXJjaHkgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2dldFNjZW5lSGllcmFyY2h5JywgW3RydWVdKTtcbiAgICAgICAgICAgIGNvbnN0IGNvdW50czogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuXG4gICAgICAgICAgICBjb25zdCB3YWxrID0gKG5vZGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChub2RlLmNvbXBvbmVudHMpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9kZS5jb21wb25lbnRzLmZvckVhY2goKGM6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgY291bnRzW2MudHlwZV0gPSAoY291bnRzW2MudHlwZV0gfHwgMCkgKyAxO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4pIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCh3YWxrKTtcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGlmIChoaWVyYXJjaHkuZGF0YSkge1xuICAgICAgICAgICAgICAgIChBcnJheS5pc0FycmF5KGhpZXJhcmNoeS5kYXRhKSA/IGhpZXJhcmNoeS5kYXRhIDogW2hpZXJhcmNoeS5kYXRhXSkuZm9yRWFjaCh3YWxrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHsgY29tcG9uZW50RGlzdHJpYnV0aW9uOiBjb3VudHMgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiOt+WPlue7hOS7tue7n+iuoeWksei0pTogJHtlLm1lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDnvJbovpHlmajor4rmlq0gPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LnvJbovpHlmajlhbPplK7nirbmgIHvvIjlnLrmma/mmK/lkKblsLHnu6rjgIHmmK/lkKbmnInmnKrkv53lrZjkv67mlLnnrYnvvIknKVxuICAgIGFzeW5jIGdldF9lZGl0b3Jfc3RhdHVzKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdHM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICAgICAgICB0cnkgeyByZXN1bHRzLnNjZW5lUmVhZHkgPSBhd2FpdCBjYWxsU2NlbmUoJ3F1ZXJ5LWlzLXJlYWR5Jyk7IH0gY2F0Y2ggeyByZXN1bHRzLnNjZW5lUmVhZHkgPSAndW5rbm93bic7IH1cbiAgICAgICAgdHJ5IHsgcmVzdWx0cy5zY2VuZURpcnR5ID0gYXdhaXQgY2FsbFNjZW5lKCdxdWVyeS1kaXJ0eScpOyB9IGNhdGNoIHsgcmVzdWx0cy5zY2VuZURpcnR5ID0gJ3Vua25vd24nOyB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjcyA9IGF3YWl0IGNhbGxTY2VuZSgncXVlcnktY3VycmVudC1zY2VuZScpO1xuICAgICAgICAgICAgcmVzdWx0cy5jdXJyZW50U2NlbmUgPSBjcz8ubmFtZSB8fCBudWxsO1xuICAgICAgICB9IGNhdGNoIHsgcmVzdWx0cy5jdXJyZW50U2NlbmUgPSBudWxsOyB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iOt+WPlue8lui+keWZqOaJqeWxlei/kOihjOeOr+Wig+S/oeaBrycpXG4gICAgZ2V0X2Vudmlyb25tZW50X2luZm8oKTogYW55IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGVkaXRvclZlcnNpb246IEVkaXRvci5BcHA/LnZlcnNpb24gfHwgJ3Vua25vd24nLFxuICAgICAgICAgICAgcGxhdGZvcm06IHByb2Nlc3MucGxhdGZvcm0sXG4gICAgICAgICAgICBub2RlVmVyc2lvbjogcHJvY2Vzcy52ZXJzaW9uLFxuICAgICAgICAgICAgYXJjaDogcHJvY2Vzcy5hcmNoLFxuICAgICAgICAgICAgY3dkOiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICAgICAgbWNwRXh0ZW5zaW9uVmVyc2lvbjogJzEuMC4wJyxcbiAgICAgICAgfTtcbiAgICB9XG59XG4iXX0=