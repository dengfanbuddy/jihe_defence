"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
// @ts-ignore
const package_json_1 = __importDefault(require("../package.json"));
const MetadataRegistry_1 = require("./mcp/MetadataRegistry");
// ==================== MCP 模块加载（触发装饰器注册） ====================
// 注意：这些 import 会触发 @MCPModule / @MCPTool 装饰器执行，
// 从而自动向 MetadataRegistry 注册模块和工具元数据。
// 
// 添加新模块时只需在此处增加一行 import。
require("./mcp/modules");
// ==================== 扩展方法 ====================
exports.methods = {
    /**
     * 打开 MCP 管理面板
     */
    openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    /**
     * 启动 MCP 服务器（可由面板或菜单调用）
     */
    async startMCPServer() {
        var _a;
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
        if (registry.isRunning()) {
            return { success: false, message: 'MCP 服务器已在运行中' };
        }
        try {
            // 仅加载模块开关状态，不覆盖端口（端口已在面板设置阶段保存到内存）
            registry.loadModuleConfig();
            const port = (_a = registry.explicitPort) !== null && _a !== void 0 ? _a : registry.getPort();
            const { MCPServer } = await Promise.resolve().then(() => __importStar(require('./mcp/MCPServer')));
            MCPServer.ins.start(port);
            registry.setRunning(true);
            registry.saveConfig();
            return { success: true, port };
        }
        catch (e) {
            return { success: false, message: e.message };
        }
    },
    /**
     * 停止 MCP 服务器
     */
    async stopMCPServer() {
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
        if (!registry.isRunning()) {
            return { success: false, message: 'MCP 服务器未在运行' };
        }
        try {
            const { MCPServer } = await Promise.resolve().then(() => __importStar(require('./mcp/MCPServer')));
            MCPServer.ins.stop();
            registry.setRunning(false);
            return { success: true };
        }
        catch (e) {
            return { success: false, message: e.message };
        }
    },
    /**
     * 查询 MCP 状态（供面板调用）
     */
    queryMCPStatus() {
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
        return {
            running: registry.isRunning(),
            port: registry.getPort(),
            modules: registry.getModules().map(m => ({
                name: m.name,
                description: m.description,
                enabled: m.enabled,
                tools: m.tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    enabled: t.enabled,
                })),
            })),
        };
    },
    /**
     * 设置模块启用状态
     */
    setModuleEnabled(name, enabled) {
        MetadataRegistry_1.MetadataRegistry.ins.setModuleEnabled(name, enabled);
        MetadataRegistry_1.MetadataRegistry.ins.saveConfig();
    },
    /**
     * 设置工具启用状态
     */
    setToolEnabled(moduleName, toolName, enabled) {
        MetadataRegistry_1.MetadataRegistry.ins.setToolEnabled(moduleName, toolName, enabled);
        MetadataRegistry_1.MetadataRegistry.ins.saveConfig();
    },
    /**
     * 设置端口
     */
    setPort(port) {
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
        if (registry.isRunning()) {
            return { success: false, message: '请先停止服务器再修改端口' };
        }
        registry.setPort(port);
        registry.saveConfig();
        return { success: true };
    },
};
/**
 * 扩展启动时触发
 */
function load() {
    const registry = MetadataRegistry_1.MetadataRegistry.ins;
    registry.loadConfig();
    console.log('[MCP] 扩展已启动');
}
/**
 * 卸载扩展时触发
 */
function unload() {
    // 停止 MCP 服务器（如果正在运行）
    MetadataRegistry_1.MetadataRegistry.ins.setRunning(false);
    console.log('[MCP] 扩展已卸载');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQW1IQSxvQkFJQztBQUtELHdCQUlDO0FBaElELGFBQWE7QUFDYixtRUFBMEM7QUFDMUMsNkRBQTBEO0FBRTFELDhEQUE4RDtBQUM5RCxnREFBZ0Q7QUFDaEQscUNBQXFDO0FBQ3JDLEdBQUc7QUFDSCwwQkFBMEI7QUFDMUIseUJBQXVCO0FBRXZCLGlEQUFpRDtBQUVwQyxRQUFBLE9BQU8sR0FBNEM7SUFDNUQ7O09BRUc7SUFDSCxTQUFTO1FBQ0wsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBRUQ7O09BRUc7SUFDSCxLQUFLLENBQUMsY0FBYzs7UUFDaEIsTUFBTSxRQUFRLEdBQUcsbUNBQWdCLENBQUMsR0FBRyxDQUFDO1FBQ3RDLElBQUksUUFBUSxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQUM7WUFDdkIsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxDQUFDO1FBQ3ZELENBQUM7UUFDRCxJQUFJLENBQUM7WUFDRCxtQ0FBbUM7WUFDbkMsUUFBUSxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDNUIsTUFBTSxJQUFJLEdBQUcsTUFBQSxRQUFRLENBQUMsWUFBWSxtQ0FBSSxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDekQsTUFBTSxFQUFFLFNBQVMsRUFBRSxHQUFHLHdEQUFhLGlCQUFpQixHQUFDLENBQUM7WUFDdEQsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDMUIsUUFBUSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUMxQixRQUFRLENBQUMsVUFBVSxFQUFFLENBQUM7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QUFRLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDdEIsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUM3QixDQUFDO0NBQ0osQ0FBQztBQUVGOztHQUVHO0FBQ0gsU0FBZ0IsSUFBSTtJQUNoQixNQUFNLFFBQVEsR0FBRyxtQ0FBZ0IsQ0FBQyxHQUFHLENBQUM7SUFDdEMsUUFBUSxDQUFDLFVBQVUsRUFBRSxDQUFDO0lBQ3RCLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDL0IsQ0FBQztBQUVEOztHQUVHO0FBQ0gsU0FBZ0IsTUFBTTtJQUNsQixxQkFBcUI7SUFDckIsbUNBQWdCLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN2QyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQy9CLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAdHMtaWdub3JlXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcbmltcG9ydCB7IE1ldGFkYXRhUmVnaXN0cnkgfSBmcm9tICcuL21jcC9NZXRhZGF0YVJlZ2lzdHJ5JztcblxuLy8gPT09PT09PT09PT09PT09PT09PT0gTUNQIOaooeWdl+WKoOi9ve+8iOinpuWPkeijhemlsOWZqOazqOWGjO+8iSA9PT09PT09PT09PT09PT09PT09PVxuLy8g5rOo5oSP77ya6L+Z5LqbIGltcG9ydCDkvJrop6blj5EgQE1DUE1vZHVsZSAvIEBNQ1BUb29sIOijhemlsOWZqOaJp+ihjO+8jFxuLy8g5LuO6ICM6Ieq5Yqo5ZCRIE1ldGFkYXRhUmVnaXN0cnkg5rOo5YaM5qih5Z2X5ZKM5bel5YW35YWD5pWw5o2u44CCXG4vLyBcbi8vIOa3u+WKoOaWsOaooeWdl+aXtuWPqumcgOWcqOatpOWkhOWinuWKoOS4gOihjCBpbXBvcnTjgIJcbmltcG9ydCAnLi9tY3AvbW9kdWxlcyc7XG5cbi8vID09PT09PT09PT09PT09PT09PT09IOaJqeWxleaWueazlSA9PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgY29uc3QgbWV0aG9kczogeyBba2V5OiBzdHJpbmddOiAoLi4uYW55OiBhbnkpID0+IGFueSB9ID0ge1xuICAgIC8qKlxuICAgICAqIOaJk+W8gCBNQ1Ag566h55CG6Z2i5p2/XG4gICAgICovXG4gICAgb3BlblBhbmVsKCkge1xuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5ZCv5YqoIE1DUCDmnI3liqHlmajvvIjlj6/nlLHpnaLmnb/miJboj5zljZXosIPnlKjvvIlcbiAgICAgKi9cbiAgICBhc3luYyBzdGFydE1DUFNlcnZlcigpIHtcbiAgICAgICAgY29uc3QgcmVnaXN0cnkgPSBNZXRhZGF0YVJlZ2lzdHJ5LmlucztcbiAgICAgICAgaWYgKHJlZ2lzdHJ5LmlzUnVubmluZygpKSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogJ01DUCDmnI3liqHlmajlt7LlnKjov5DooYzkuK0nIH07XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIOS7heWKoOi9veaooeWdl+W8gOWFs+eKtuaAge+8jOS4jeimhuebluerr+WPo++8iOerr+WPo+W3suWcqOmdouadv+iuvue9rumYtuauteS/neWtmOWIsOWGheWtmO+8iVxuICAgICAgICAgICAgcmVnaXN0cnkubG9hZE1vZHVsZUNvbmZpZygpO1xuICAgICAgICAgICAgY29uc3QgcG9ydCA9IHJlZ2lzdHJ5LmV4cGxpY2l0UG9ydCA/PyByZWdpc3RyeS5nZXRQb3J0KCk7XG4gICAgICAgICAgICBjb25zdCB7IE1DUFNlcnZlciB9ID0gYXdhaXQgaW1wb3J0KCcuL21jcC9NQ1BTZXJ2ZXInKTtcbiAgICAgICAgICAgIE1DUFNlcnZlci5pbnMuc3RhcnQocG9ydCk7XG4gICAgICAgICAgICByZWdpc3RyeS5zZXRSdW5uaW5nKHRydWUpO1xuICAgICAgICAgICAgcmVnaXN0cnkuc2F2ZUNvbmZpZygpO1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgcG9ydCB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDlgZzmraIgTUNQIOacjeWKoeWZqFxuICAgICAqL1xuICAgIGFzeW5jIHN0b3BNQ1BTZXJ2ZXIoKSB7XG4gICAgICAgIGNvbnN0IHJlZ2lzdHJ5ID0gTWV0YWRhdGFSZWdpc3RyeS5pbnM7XG4gICAgICAgIGlmICghcmVnaXN0cnkuaXNSdW5uaW5nKCkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiAnTUNQIOacjeWKoeWZqOacquWcqOi/kOihjCcgfTtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBNQ1BTZXJ2ZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9tY3AvTUNQU2VydmVyJyk7XG4gICAgICAgICAgICBNQ1BTZXJ2ZXIuaW5zLnN0b3AoKTtcbiAgICAgICAgICAgIHJlZ2lzdHJ5LnNldFJ1bm5pbmcoZmFsc2UpO1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDmn6Xor6IgTUNQIOeKtuaAge+8iOS+m+mdouadv+iwg+eUqO+8iVxuICAgICAqL1xuICAgIHF1ZXJ5TUNQU3RhdHVzKCkge1xuICAgICAgICBjb25zdCByZWdpc3RyeSA9IE1ldGFkYXRhUmVnaXN0cnkuaW5zO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcnVubmluZzogcmVnaXN0cnkuaXNSdW5uaW5nKCksXG4gICAgICAgICAgICBwb3J0OiByZWdpc3RyeS5nZXRQb3J0KCksXG4gICAgICAgICAgICBtb2R1bGVzOiByZWdpc3RyeS5nZXRNb2R1bGVzKCkubWFwKG0gPT4gKHtcbiAgICAgICAgICAgICAgICBuYW1lOiBtLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246IG0uZGVzY3JpcHRpb24sXG4gICAgICAgICAgICAgICAgZW5hYmxlZDogbS5lbmFibGVkLFxuICAgICAgICAgICAgICAgIHRvb2xzOiBtLnRvb2xzLm1hcCh0ID0+ICh7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IHQubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZGVzY3JpcHRpb246IHQuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICAgICAgICAgIGVuYWJsZWQ6IHQuZW5hYmxlZCxcbiAgICAgICAgICAgICAgICB9KSksXG4gICAgICAgICAgICB9KSksXG4gICAgICAgIH07XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOiuvue9ruaooeWdl+WQr+eUqOeKtuaAgVxuICAgICAqL1xuICAgIHNldE1vZHVsZUVuYWJsZWQobmFtZTogc3RyaW5nLCBlbmFibGVkOiBib29sZWFuKSB7XG4gICAgICAgIE1ldGFkYXRhUmVnaXN0cnkuaW5zLnNldE1vZHVsZUVuYWJsZWQobmFtZSwgZW5hYmxlZCk7XG4gICAgICAgIE1ldGFkYXRhUmVnaXN0cnkuaW5zLnNhdmVDb25maWcoKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog6K6+572u5bel5YW35ZCv55So54q25oCBXG4gICAgICovXG4gICAgc2V0VG9vbEVuYWJsZWQobW9kdWxlTmFtZTogc3RyaW5nLCB0b29sTmFtZTogc3RyaW5nLCBlbmFibGVkOiBib29sZWFuKSB7XG4gICAgICAgIE1ldGFkYXRhUmVnaXN0cnkuaW5zLnNldFRvb2xFbmFibGVkKG1vZHVsZU5hbWUsIHRvb2xOYW1lLCBlbmFibGVkKTtcbiAgICAgICAgTWV0YWRhdGFSZWdpc3RyeS5pbnMuc2F2ZUNvbmZpZygpO1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDorr7nva7nq6/lj6NcbiAgICAgKi9cbiAgICBzZXRQb3J0KHBvcnQ6IG51bWJlcikge1xuICAgICAgICBjb25zdCByZWdpc3RyeSA9IE1ldGFkYXRhUmVnaXN0cnkuaW5zO1xuICAgICAgICBpZiAocmVnaXN0cnkuaXNSdW5uaW5nKCkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiAn6K+35YWI5YGc5q2i5pyN5Yqh5Zmo5YaN5L+u5pS556uv5Y+jJyB9O1xuICAgICAgICB9XG4gICAgICAgIHJlZ2lzdHJ5LnNldFBvcnQocG9ydCk7XG4gICAgICAgIHJlZ2lzdHJ5LnNhdmVDb25maWcoKTtcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0sXG59O1xuXG4vKipcbiAqIOaJqeWxleWQr+WKqOaXtuinpuWPkVxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpIHtcbiAgICBjb25zdCByZWdpc3RyeSA9IE1ldGFkYXRhUmVnaXN0cnkuaW5zO1xuICAgIHJlZ2lzdHJ5LmxvYWRDb25maWcoKTtcbiAgICBjb25zb2xlLmxvZygnW01DUF0g5omp5bGV5bey5ZCv5YqoJyk7XG59XG5cbi8qKlxuICog5Y246L295omp5bGV5pe26Kem5Y+RXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKSB7XG4gICAgLy8g5YGc5q2iIE1DUCDmnI3liqHlmajvvIjlpoLmnpzmraPlnKjov5DooYzvvIlcbiAgICBNZXRhZGF0YVJlZ2lzdHJ5Lmlucy5zZXRSdW5uaW5nKGZhbHNlKTtcbiAgICBjb25zb2xlLmxvZygnW01DUF0g5omp5bGV5bey5Y246L29Jyk7XG59XG4iXX0=