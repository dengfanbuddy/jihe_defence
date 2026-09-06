// @ts-ignore
import packageJSON from '../package.json';
import { MetadataRegistry } from './mcp/MetadataRegistry';

// ==================== MCP 模块加载（触发装饰器注册） ====================
// 注意：这些 import 会触发 @MCPModule / @MCPTool 装饰器执行，
// 从而自动向 MetadataRegistry 注册模块和工具元数据。
// 
// 添加新模块时只需在此处增加一行 import。
import './mcp/modules';

// ==================== 扩展方法 ====================

export const methods: { [key: string]: (...any: any) => any } = {
    /**
     * 打开 MCP 管理面板
     */
    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    /**
     * 启动 MCP 服务器（可由面板或菜单调用）
     */
    async startMCPServer() {
        const registry = MetadataRegistry.ins;
        if (registry.isRunning()) {
            return { success: false, message: 'MCP 服务器已在运行中' };
        }
        try {
            // 仅加载模块开关状态，不覆盖端口（端口已在面板设置阶段保存到内存）
            registry.loadModuleConfig();
            const port = registry.explicitPort ?? registry.getPort();
            const { MCPServer } = await import('./mcp/MCPServer');
            MCPServer.ins.start(port);
            registry.setRunning(true);
            registry.saveConfig();
            return { success: true, port };
        } catch (e: any) {
            return { success: false, message: e.message };
        }
    },

    /**
     * 停止 MCP 服务器
     */
    async stopMCPServer() {
        const registry = MetadataRegistry.ins;
        if (!registry.isRunning()) {
            return { success: false, message: 'MCP 服务器未在运行' };
        }
        try {
            const { MCPServer } = await import('./mcp/MCPServer');
            MCPServer.ins.stop();
            registry.setRunning(false);
            return { success: true };
        } catch (e: any) {
            return { success: false, message: e.message };
        }
    },

    /**
     * 查询 MCP 状态（供面板调用）
     */
    queryMCPStatus() {
        const registry = MetadataRegistry.ins;
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
    setModuleEnabled(name: string, enabled: boolean) {
        MetadataRegistry.ins.setModuleEnabled(name, enabled);
        MetadataRegistry.ins.saveConfig();
    },

    /**
     * 设置工具启用状态
     */
    setToolEnabled(moduleName: string, toolName: string, enabled: boolean) {
        MetadataRegistry.ins.setToolEnabled(moduleName, toolName, enabled);
        MetadataRegistry.ins.saveConfig();
    },

    /**
     * 设置端口
     */
    setPort(port: number) {
        const registry = MetadataRegistry.ins;
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
export function load() {
    const registry = MetadataRegistry.ins;
    registry.loadConfig();
    console.log('[MCP] 扩展已启动');
}

/**
 * 卸载扩展时触发
 */
export function unload() {
    // 停止 MCP 服务器（如果正在运行）
    MetadataRegistry.ins.setRunning(false);
    console.log('[MCP] 扩展已卸载');
}
