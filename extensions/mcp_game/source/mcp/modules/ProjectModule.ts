/**
 * 项目模块 — 对接 Cocos Creator 内置 project / preview / builder 扩展
 *
 * 提供项目配置查询/修改、预览启停、构建等功能。
 */

import { MCPModule, MCPTool } from '../decorators';

async function callProject(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('project', method, ...args);
    } catch (e: any) {
        throw new Error(`项目消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function callPreview(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('preview', method, ...args);
    } catch (e: any) {
        throw new Error(`预览消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function callBuilder(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('builder', method, ...args);
    } catch (e: any) {
        throw new Error(`构建消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('project', '项目与构建 - 查询/修改项目配置，预览，构建')
export class ProjectModule {

    // ==================== 项目配置 ====================

    @MCPTool('查询项目配置项的值', {
        key: { type: 'string', description: '配置项路径，如 general.designResolution.width' },
    })
    async query_project_config(params: { key: string }): Promise<any> {
        return callProject('query-config', params.key);
    }

    @MCPTool('设置项目配置项的值', {
        key: { type: 'string', description: '配置项路径' },
        value: { type: 'string', description: '配置值（JSON 格式）' },
    })
    async set_project_config(params: { key: string; value: string }): Promise<any> {
        const value = JSON.parse(params.value);
        return callProject('set-config', params.key, value);
    }

    @MCPTool('查询设计分辨率')
    async query_design_resolution(): Promise<any> {
        return callProject('query-design-resolution');
    }

    @MCPTool('查询项目所有配置')
    async query_project_configs(): Promise<any> {
        return callProject('query-project-configs');
    }

    @MCPTool('打开项目设置面板')
    async open_project_settings(): Promise<any> {
        return callProject('open-settings');
    }

    // ==================== 预览 ====================

    @MCPTool('启动项目预览（在浏览器中运行游戏）')
    async start_preview(): Promise<any> {
        return callPreview('open-terminal');
    }

    @MCPTool('刷新预览窗口')
    async refresh_preview(): Promise<any> {
        return callPreview('reload-terminal');
    }

    @MCPTool('查询预览 URL')
    async query_preview_url(): Promise<any> {
        return callPreview('query-preview-url');
    }

    @MCPTool('重启模拟器预览')
    async restart_preview(): Promise<any> {
        return callPreview('restart-simulator');
    }

    // ==================== 构建 ====================

    @MCPTool('打开构建面板')
    async open_build_panel(): Promise<any> {
        return callBuilder('open');
    }

    @MCPTool('查询构建任务信息')
    async query_build_tasks(): Promise<any> {
        return callBuilder('query-tasks-info');
    }

    @MCPTool('查询构建 Worker 是否就绪')
    async query_build_worker_ready(): Promise<any> {
        return callBuilder('query-worker-ready');
    }

    @MCPTool('执行命令行构建', {
        platform: { type: 'string', description: '目标平台，如 web-desktop, android, ios' },
        configPath: { type: 'string', description: '构建配置文件路径（可选）' },
    })
    async command_build(params: { platform: string; configPath?: string }): Promise<any> {
        return callBuilder('command-build', params.platform, params.configPath);
    }
}
