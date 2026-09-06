"use strict";
/**
 * 项目模块 — 对接 Cocos Creator 内置 project / preview / builder 扩展
 *
 * 提供项目配置查询/修改、预览启停、构建等功能。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectModule = void 0;
const decorators_1 = require("../decorators");
async function callProject(method, ...args) {
    try {
        return await Editor.Message.request('project', method, ...args);
    }
    catch (e) {
        throw new Error(`项目消息 '${method}' 失败: ${e.message || e}`);
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
async function callBuilder(method, ...args) {
    try {
        return await Editor.Message.request('builder', method, ...args);
    }
    catch (e) {
        throw new Error(`构建消息 '${method}' 失败: ${e.message || e}`);
    }
}
let ProjectModule = class ProjectModule {
    // ==================== 项目配置 ====================
    async query_project_config(params) {
        return callProject('query-config', params.key);
    }
    async set_project_config(params) {
        const value = JSON.parse(params.value);
        return callProject('set-config', params.key, value);
    }
    async query_design_resolution() {
        return callProject('query-design-resolution');
    }
    async query_project_configs() {
        return callProject('query-project-configs');
    }
    async open_project_settings() {
        return callProject('open-settings');
    }
    // ==================== 预览 ====================
    async start_preview() {
        return callPreview('open-terminal');
    }
    async refresh_preview() {
        return callPreview('reload-terminal');
    }
    async query_preview_url() {
        return callPreview('query-preview-url');
    }
    async restart_preview() {
        return callPreview('restart-simulator');
    }
    // ==================== 构建 ====================
    async open_build_panel() {
        return callBuilder('open');
    }
    async query_build_tasks() {
        return callBuilder('query-tasks-info');
    }
    async query_build_worker_ready() {
        return callBuilder('query-worker-ready');
    }
    async command_build(params) {
        return callBuilder('command-build', params.platform, params.configPath);
    }
};
exports.ProjectModule = ProjectModule;
__decorate([
    (0, decorators_1.MCPTool)('查询项目配置项的值', {
        key: { type: 'string', description: '配置项路径，如 general.designResolution.width' },
    })
], ProjectModule.prototype, "query_project_config", null);
__decorate([
    (0, decorators_1.MCPTool)('设置项目配置项的值', {
        key: { type: 'string', description: '配置项路径' },
        value: { type: 'string', description: '配置值（JSON 格式）' },
    })
], ProjectModule.prototype, "set_project_config", null);
__decorate([
    (0, decorators_1.MCPTool)('查询设计分辨率')
], ProjectModule.prototype, "query_design_resolution", null);
__decorate([
    (0, decorators_1.MCPTool)('查询项目所有配置')
], ProjectModule.prototype, "query_project_configs", null);
__decorate([
    (0, decorators_1.MCPTool)('打开项目设置面板')
], ProjectModule.prototype, "open_project_settings", null);
__decorate([
    (0, decorators_1.MCPTool)('启动项目预览（在浏览器中运行游戏）')
], ProjectModule.prototype, "start_preview", null);
__decorate([
    (0, decorators_1.MCPTool)('刷新预览窗口')
], ProjectModule.prototype, "refresh_preview", null);
__decorate([
    (0, decorators_1.MCPTool)('查询预览 URL')
], ProjectModule.prototype, "query_preview_url", null);
__decorate([
    (0, decorators_1.MCPTool)('重启模拟器预览')
], ProjectModule.prototype, "restart_preview", null);
__decorate([
    (0, decorators_1.MCPTool)('打开构建面板')
], ProjectModule.prototype, "open_build_panel", null);
__decorate([
    (0, decorators_1.MCPTool)('查询构建任务信息')
], ProjectModule.prototype, "query_build_tasks", null);
__decorate([
    (0, decorators_1.MCPTool)('查询构建 Worker 是否就绪')
], ProjectModule.prototype, "query_build_worker_ready", null);
__decorate([
    (0, decorators_1.MCPTool)('执行命令行构建', {
        platform: { type: 'string', description: '目标平台，如 web-desktop, android, ios' },
        configPath: { type: 'string', description: '构建配置文件路径（可选）' },
    })
], ProjectModule.prototype, "command_build", null);
exports.ProjectModule = ProjectModule = __decorate([
    (0, decorators_1.MCPModule)('project', '项目与构建 - 查询/修改项目配置，预览，构建')
], ProjectModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHJvamVjdE1vZHVsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NvdXJjZS9tY3AvbW9kdWxlcy9Qcm9qZWN0TW9kdWxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7OztHQUlHOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFFbkQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ3JELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDcEUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUVELEtBQUssVUFBVSxXQUFXLENBQUMsTUFBYyxFQUFFLEdBQUcsSUFBVztJQUNyRCxJQUFJLENBQUM7UUFDRCxPQUFPLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQ3BFLENBQUM7SUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO1FBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLE1BQU0sU0FBUyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDOUQsQ0FBQztBQUNMLENBQUM7QUFFRCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDckQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNwRSxDQUFDO0lBQUMs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LElBQUEsb0JBQU8sRUFBQyxtQkFBbUIsQ0FBQztrREFHNUI7QUFHSztJQURMLElBQUEsb0JBQU8sRUFBQyxRQUFRLENBQUM7b0RBR2pCO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsVUFBVSxDQUFDO3NEQUduQjtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLFNBQVMsQ0FBQztvREFHbEI7QUFLSztJQURMLElBQUEsb0JBQU8sRUFBQyxRQUFRLENBQUM7cURBR2pCO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsVUFBVSxDQUFDO3NEQUduQjtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLGtCQUFrQixDQUFDOzZEQUczQjtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLFNBQVMsRUFBRTtRQUNoQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxrQ0FBa0MsRUFBRTtRQUM3RSxVQUFVLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxjQUFjLEVBQUU7S0FDOUQsQ0FBQztrREFHRDt3QkFoRlEsYUFBYTtJQUR6QixJQUFBLHNCQUFTLEVBQUMsU0FBUyxFQUFFLHlCQUF5QixDQUFDO0dBQ25DLGFBQWEsQ0FpRnpCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDpobnnm67mqKHlnZcg4oCUIOWvueaOpSBDb2NvcyBDcmVhdG9yIOWGhee9riBwcm9qZWN0IC8gcHJldmlldyAvIGJ1aWxkZXIg5omp5bGVXG4gKlxuICog5o+Q5L6b6aG555uu6YWN572u5p+l6K+iL+S/ruaUueOAgemihOiniOWQr+WBnOOAgeaehOW7uuetieWKn+iDveOAglxuICovXG5cbmltcG9ydCB7IE1DUE1vZHVsZSwgTUNQVG9vbCB9IGZyb20gJy4uL2RlY29yYXRvcnMnO1xuXG5hc3luYyBmdW5jdGlvbiBjYWxsUHJvamVjdChtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdwcm9qZWN0JywgbWV0aG9kLCAuLi5hcmdzKTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDpobnnm67mtojmga8gJyR7bWV0aG9kfScg5aSx6LSlOiAke2UubWVzc2FnZSB8fCBlfWApO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY2FsbFByZXZpZXcobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgncHJldmlldycsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6aKE6KeI5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdWlsZGVyKG1ldGhvZDogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2J1aWxkZXInLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaehOW7uua2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5ATUNQTW9kdWxlKCdwcm9qZWN0JywgJ+mhueebruS4juaehOW7uiAtIOafpeivoi/kv67mlLnpobnnm67phY3nva7vvIzpooTop4jvvIzmnoTlu7onKVxuZXhwb3J0IGNsYXNzIFByb2plY3RNb2R1bGUge1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g6aG555uu6YWN572uID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6aG555uu6YWN572u6aG555qE5YC8Jywge1xuICAgICAgICBrZXk6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6YWN572u6aG56Lev5b6E77yM5aaCIGdlbmVyYWwuZGVzaWduUmVzb2x1dGlvbi53aWR0aCcgfSxcbiAgICB9KVxuICAgIGFzeW5jIHF1ZXJ5X3Byb2plY3RfY29uZmlnKHBhcmFtczogeyBrZXk6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxQcm9qZWN0KCdxdWVyeS1jb25maWcnLCBwYXJhbXMua2V5KTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6K6+572u6aG555uu6YWN572u6aG555qE5YC8Jywge1xuICAgICAgICBrZXk6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6YWN572u6aG56Lev5b6EJyB9LFxuICAgICAgICB2YWx1ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfphY3nva7lgLzvvIhKU09OIOagvOW8j++8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNldF9wcm9qZWN0X2NvbmZpZyhwYXJhbXM6IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gSlNPTi5wYXJzZShwYXJhbXMudmFsdWUpO1xuICAgICAgICByZXR1cm4gY2FsbFByb2plY3QoJ3NldC1jb25maWcnLCBwYXJhbXMua2V5LCB2YWx1ZSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouiuvuiuoeWIhui+qOeOhycpXG4gICAgYXN5bmMgcXVlcnlfZGVzaWduX3Jlc29sdXRpb24oKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxQcm9qZWN0KCdxdWVyeS1kZXNpZ24tcmVzb2x1dGlvbicpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6Lpobnnm67miYDmnInphY3nva4nKVxuICAgIGFzeW5jIHF1ZXJ5X3Byb2plY3RfY29uZmlncygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFByb2plY3QoJ3F1ZXJ5LXByb2plY3QtY29uZmlncycpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmiZPlvIDpobnnm67orr7nva7pnaLmnb8nKVxuICAgIGFzeW5jIG9wZW5fcHJvamVjdF9zZXR0aW5ncygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFByb2plY3QoJ29wZW4tc2V0dGluZ3MnKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDpooTop4ggPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCflkK/liqjpobnnm67pooTop4jvvIjlnKjmtY/op4jlmajkuK3ov5DooYzmuLjmiI/vvIknKVxuICAgIGFzeW5jIHN0YXJ0X3ByZXZpZXcoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxQcmV2aWV3KCdvcGVuLXRlcm1pbmFsJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIt+aWsOmihOiniOeql+WPoycpXG4gICAgYXN5bmMgcmVmcmVzaF9wcmV2aWV3KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsUHJldmlldygncmVsb2FkLXRlcm1pbmFsJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivoumihOiniCBVUkwnKVxuICAgIGFzeW5jIHF1ZXJ5X3ByZXZpZXdfdXJsKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsUHJldmlldygncXVlcnktcHJldmlldy11cmwnKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6YeN5ZCv5qih5ouf5Zmo6aKE6KeIJylcbiAgICBhc3luYyByZXN0YXJ0X3ByZXZpZXcoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxQcmV2aWV3KCdyZXN0YXJ0LXNpbXVsYXRvcicpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOaehOW7uiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+aJk+W8gOaehOW7uumdouadvycpXG4gICAgYXN5bmMgb3Blbl9idWlsZF9wYW5lbCgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEJ1aWxkZXIoJ29wZW4nKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5p6E5bu65Lu75Yqh5L+h5oGvJylcbiAgICBhc3luYyBxdWVyeV9idWlsZF90YXNrcygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEJ1aWxkZXIoJ3F1ZXJ5LXRhc2tzLWluZm8nKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5p6E5bu6IFdvcmtlciDmmK/lkKblsLHnu6onKVxuICAgIGFzeW5jIHF1ZXJ5X2J1aWxkX3dvcmtlcl9yZWFkeSgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEJ1aWxkZXIoJ3F1ZXJ5LXdvcmtlci1yZWFkeScpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmiafooYzlkb3ku6TooYzmnoTlu7onLCB7XG4gICAgICAgIHBsYXRmb3JtOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+W5s+WPsO+8jOWmgiB3ZWItZGVza3RvcCwgYW5kcm9pZCwgaW9zJyB9LFxuICAgICAgICBjb25maWdQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aehOW7uumFjee9ruaWh+S7tui3r+W+hO+8iOWPr+mAie+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNvbW1hbmRfYnVpbGQocGFyYW1zOiB7IHBsYXRmb3JtOiBzdHJpbmc7IGNvbmZpZ1BhdGg/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQnVpbGRlcignY29tbWFuZC1idWlsZCcsIHBhcmFtcy5wbGF0Zm9ybSwgcGFyYW1zLmNvbmZpZ1BhdGgpO1xuICAgIH1cbn1cbiJdfQ==