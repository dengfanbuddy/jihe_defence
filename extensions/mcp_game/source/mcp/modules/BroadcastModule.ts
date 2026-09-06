/**
 * 广播/通知模块 — 编辑器状态推送、视图刷新
 *
 * 提供工具执行结果广播、编辑器视图刷新、软重载等功能。
 * 注意：SSE 广播依赖 MCPServer 实例，通过全局事件或直接引用。
 */

import { MCPModule, MCPTool } from '../decorators';

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function callPreview(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('preview', method, ...args);
    } catch (e: any) {
        throw new Error(`预览消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('broadcast', '广播通知 - 刷新编辑器视图、推送状态更新')
export class BroadcastModule {

    @MCPTool('刷新场景编辑器视图（软重载，保留状态）')
    async soft_reload(): Promise<any> {
        await callScene('soft-reload');
        return { message: '场景已刷新' };
    }

    @MCPTool('刷新预览窗口')
    async refresh_preview(): Promise<any> {
        await callPreview('reload-terminal');
        return { message: '预览已刷新' };
    }

    @MCPTool('向所有连接的 MCP 客户端广播通知', {
        level: { type: 'string', description: '通知级别（info/warning/error），默认 info' },
        message: { type: 'string', description: '通知内容', required: true },
    })
    async broadcast_notification(params: { level?: string; message: string }): Promise<any> {
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

    @MCPTool('发送编辑器提示消息', {
        message: { type: 'string', description: '提示内容', required: true },
        type: { type: 'string', description: '消息类型（info/warn/error），默认 info' },
    })
    editor_notify(params: { message: string; type?: string }): any {
        const type = params.type || 'info';
        const method = type === 'warn' ? 'warn' : type === 'error' ? 'error' : 'info';

        // 使用 Editor.Dialog 或 console 输出
        if (type === 'warn') {
            console.warn(`[MCP] ${params.message}`);
        } else if (type === 'error') {
            console.error(`[MCP] ${params.message}`);
        } else {
            console.log(`[MCP] ${params.message}`);
        }

        return { message: '提示已发送' };
    }

    @MCPTool('获取广播模块能力说明')
    get_broadcast_capabilities(): any {
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
}
