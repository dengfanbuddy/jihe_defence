/**
 * MCP 元数据注册表 — 单例，存储所有模块和工具信息及启用状态
 *
 * 装饰器在类加载时自动向这里注册，MCPServer 从这里动态读取可用工具列表。
 * 启用状态通过面板控制，可持久化到 Editor.Profile。
 */

/** 单个工具的元数据 */
export interface ToolMeta {
    methodName: string;
    description: string;
    paramsSchema?: Record<string, unknown>;
    /** 实际的导出方法（由 @MCPTool 装饰的方法） */
    methodFn: (...args: any[]) => any;
}

/** 工具运行时信息（含启用状态） */
export interface ToolInfo {
    name: string;
    description: string;
    paramsSchema?: Record<string, unknown>;
    enabled: boolean;
    /** 所属模块名 */
    moduleName: string;
}

/** 模块运行时信息 */
export interface ModuleInfo {
    name: string;
    description: string;
    enabled: boolean;
    /** 该模块下的工具列表 */
    tools: ToolInfo[];
    /** 类构造函数引用 */
    classRef: new (...args: any[]) => any;
}

/** 持久化的配置结构 */
export interface MCPConfig {
    port: number;
    modules: Record<string, { enabled: boolean; tools: Record<string, boolean> }>;
}

export class MetadataRegistry {
    private static _ins: MetadataRegistry;
    static get ins(): MetadataRegistry {
        if (!this._ins) this._ins = new MetadataRegistry();
        return this._ins;
    }

    /** 模块名 → ModuleInfo */
    private modules = new Map<string, ModuleInfo>();
    /** 默认 MCP 端口 */
    private port = 9786;
    /** 用户是否显式设过端口（防止 loadConfig 覆盖面板设置的端口） */
    explicitPort: number | null = null;
    /** 服务器运行状态 */
    private running = false;

    // ==================== 模块注册 ====================

    /** 注册一个模块（由 @MCPModule 调用） */
    registerModule(name: string, description: string, classRef: new (...args: any[]) => any): void {
        if (this.modules.has(name)) {
            // 重复注册：更新 classRef，保留已有配置
            const existing = this.modules.get(name)!;
            existing.classRef = classRef;
            existing.description = description;
            return;
        }
        this.modules.set(name, {
            name,
            description,
            enabled: true,
            tools: [],
            classRef,
        });
    }

    /** 注册一个工具到指定模块（由 @MCPTool 调用） */
    registerTool(
        moduleName: string,
        methodName: string,
        description: string,
        paramsSchema: Record<string, unknown> | undefined,
        methodFn: (...args: any[]) => any,
    ): void {
        const mod = this.modules.get(moduleName);
        if (!mod) {
            console.warn(`[MCP] 模块 '${moduleName}' 未注册，工具 '${methodName}' 将暂存`);
            // 模块可能还未注册 — 先存储到临时区，后续 registerModule 时合并
            // 这里简化处理：先创建模块占位
            this.modules.set(moduleName, {
                name: moduleName,
                description: '',
                enabled: true,
                tools: [],
                classRef: class {},
            });
        }
        const mod2 = this.modules.get(moduleName)!;
        mod2.tools.push({
            name: methodName,
            description,
            paramsSchema,
            enabled: true,
            moduleName,
        });
    }

    // ==================== 查询 API ====================

    getModules(): ModuleInfo[] {
        return Array.from(this.modules.values());
    }

    getModule(name: string): ModuleInfo | undefined {
        return this.modules.get(name);
    }

    getEnabledModules(): ModuleInfo[] {
        return this.getModules().filter(m => m.enabled);
    }

    getEnabledTools(): ToolInfo[] {
        const result: ToolInfo[] = [];
        for (const mod of this.modules.values()) {
            if (!mod.enabled) continue;
            for (const tool of mod.tools) {
                if (tool.enabled) result.push(tool);
            }
        }
        return result;
    }

    /** 查找工具的执行函数 */
    findToolExecutor(moduleName: string, toolName: string): ((...args: any[]) => any) | null {
        const mod = this.modules.get(moduleName);
        if (!mod || !mod.enabled) return null;
        const tool = mod.tools.find(t => t.name === toolName);
        if (!tool || !tool.enabled) return null;

        // 从类实例中获取方法
        // 实际上方法已经由装饰器保存 — 但我们需要另一种方式
        // 这里从 ModuleLoader 中获取实例
        return null; // 实际执行由 ModuleLoader.handleToolCall 处理
    }

    // ==================== 开关控制 ====================

    setModuleEnabled(name: string, enabled: boolean): void {
        const mod = this.modules.get(name);
        if (mod) mod.enabled = enabled;
    }

    setToolEnabled(moduleName: string, toolName: string, enabled: boolean): void {
        const mod = this.modules.get(moduleName);
        if (!mod) return;
        const tool = mod.tools.find(t => t.name === toolName);
        if (tool) tool.enabled = enabled;
    }

    // ==================== 端口 & 运行状态 ====================

    getPort(): number {
        return this.port;
    }

    setPort(port: number): void {
        this.port = port;
        this.explicitPort = port;
    }

    /** 获取有效端口：用户显式设置过的优先 */
    getEffectivePort(): number {
        return this.explicitPort ?? this.port;
    }

    isRunning(): boolean {
        return this.running;
    }

    setRunning(val: boolean): void {
        this.running = val;
    }

    // ==================== 持久化 ====================

    /** 从 Editor.Profile 加载配置（含端口） */
    loadConfig(): void {
        try {
            const profile = (Editor as any).Profile?.getConfig?.('mcp_game');
            if (profile) {
                // 仅当用户未面板设过端口时，才从配置恢复端口
                if (this.explicitPort === null) {
                    this.port = profile.port ?? 9786;
                }
                if (profile.modules) {
                    for (const [name, cfg] of Object.entries(profile.modules) as [string, any][]) {
                        const mod = this.modules.get(name);
                        if (mod) {
                            mod.enabled = cfg.enabled ?? true;
                            if (cfg.tools) {
                                for (const [tName, tEnabled] of Object.entries(cfg.tools)) {
                                    const tool = mod.tools.find(t => t.name === tName);
                                    if (tool) tool.enabled = tEnabled as boolean;
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[MCP] 加载配置失败:', e);
        }
    }

    /** 仅加载模块/工具开关状态（不覆盖端口） */
    loadModuleConfig(): void {
        try {
            const profile = (Editor as any).Profile?.getConfig?.('mcp_game');
            if (profile && profile.modules) {
                for (const [name, cfg] of Object.entries(profile.modules) as [string, any][]) {
                    const mod = this.modules.get(name);
                    if (mod) {
                        mod.enabled = cfg.enabled ?? true;
                        if (cfg.tools) {
                            for (const [tName, tEnabled] of Object.entries(cfg.tools)) {
                                const tool = mod.tools.find(t => t.name === tName);
                                if (tool) tool.enabled = tEnabled as boolean;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[MCP] 加载模块配置失败:', e);
        }
    }

    /** 保存配置到 Editor.Profile */
    saveConfig(): void {
        try {
            const config: MCPConfig = {
                port: this.port,
                modules: {},
            };
            for (const mod of this.modules.values()) {
                config.modules[mod.name] = {
                    enabled: mod.enabled,
                    tools: {},
                };
                for (const tool of mod.tools) {
                    config.modules[mod.name].tools[tool.name] = tool.enabled;
                }
            }
            (Editor as any).Profile?.setConfig?.('mcp_game', config);
        } catch (e) {
            console.warn('[MCP] 保存配置失败:', e);
        }
    }
}
