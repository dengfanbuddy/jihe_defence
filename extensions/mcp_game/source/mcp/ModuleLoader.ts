/**
 * MCP 模块加载器 — 集中导入所有模块文件触发装饰器注册，
 * 并维护模块类实例用于工具调用。
 */

import { MetadataRegistry, ModuleInfo } from './MetadataRegistry';

export class ModuleLoader {
    private static _ins: ModuleLoader;
    static get ins(): ModuleLoader {
        if (!this._ins) this._ins = new ModuleLoader();
        return this._ins;
    }

    /** 模块名 → 类实例 */
    private instances = new Map<string, any>();

    /**
     * 从 MetadataRegistry 中获取所有已注册模块的 classRef，
     * 创建实例并缓存。
     * 调用前确保已 import 所有模块文件（触发装饰器）。
     */
    initAll(): void {
        const registry = MetadataRegistry.ins;
        for (const mod of registry.getModules()) {
            this.getOrCreateInstance(mod);
        }
        console.log(`[MCP] 模块加载完成，共 ${this.instances.size} 个模块`);
    }

    /** 获取或创建模块实例 */
    private getOrCreateInstance(mod: ModuleInfo): any {
        if (this.instances.has(mod.name)) {
            return this.instances.get(mod.name);
        }
        try {
            const instance = new mod.classRef();
            this.instances.set(mod.name, instance);
            return instance;
        } catch (e) {
            console.error(`[MCP] 创建模块 '${mod.name}' 实例失败:`, e);
            return null;
        }
    }

    /**
     * 执行指定模块的工具方法
     * @returns 工具返回值，或带 isError 的 ToolCallResult
     */
    async handleToolCall(
        moduleName: string,
        toolName: string,
        args: Record<string, unknown> | undefined,
    ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
        const registry = MetadataRegistry.ins;
        const mod = registry.getModule(moduleName);

        if (!mod || !mod.enabled) {
            return {
                content: [{ type: 'text', text: `模块 '${moduleName}' 不存在或已禁用` }],
                isError: true,
            };
        }

        const tool = mod.tools.find(t => t.name === toolName);
        if (!tool || !tool.enabled) {
            return {
                content: [{ type: 'text', text: `工具 '${toolName}' 不存在或已禁用` }],
                isError: true,
            };
        }

        const instance = this.getOrCreateInstance(mod);
        if (!instance) {
            return {
                content: [{ type: 'text', text: `无法创建模块 '${moduleName}' 的实例` }],
                isError: true,
            };
        }

        const methodFn = instance[toolName];
        if (typeof methodFn !== 'function') {
            return {
                content: [{ type: 'text', text: `方法 '${toolName}' 在模块 '${moduleName}' 中不是函数` }],
                isError: true,
            };
        }

        try {
            const result = await methodFn.call(instance, args || {});
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return { content: [{ type: 'text', text }] };
        } catch (e: any) {
            return {
                content: [{ type: 'text', text: `工具执行错误: ${e.message}` }],
                isError: true,
            };
        }
    }

    /** 获取所有已初始化的模块名 */
    getModuleNames(): string[] {
        return Array.from(this.instances.keys());
    }
}
