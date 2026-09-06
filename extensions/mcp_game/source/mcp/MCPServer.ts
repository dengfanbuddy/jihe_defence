/**
 * MCP HTTP + SSE 服务器
 *
 * 基于 Node.js http 模块，在编辑器内部启动本地 HTTP 服务。
 * - GET  /sse  → SSE 长连接，用于服务端推送
 * - POST /mcp  → JSON-RPC 请求处理
 *
 * 设计要点：
 * - tools/list 返回轻量入口工具（get_capabilities），按需通过 get_capabilities 获取完整 schema
 * - 参数支持 snake_case + camelCase 双格式自动归一化
 * - initialize 响应含 instructions 字段指导 AI 使用
 */

import * as http from 'http';
import {
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCError,
    MCPErrorCode,
    MCPMethods,
    ToolDefinition,
    InitializeResult,
} from './types';
import { MetadataRegistry, ToolInfo } from './MetadataRegistry';

/** SSE 客户端连接 */
interface SSEClient {
    id: string;
    res: http.ServerResponse;
}

export class MCPServer {
    private static _ins: MCPServer;
    static get ins(): MCPServer {
        if (!this._ins) this._ins = new MCPServer();
        return this._ins;
    }

    private server: http.Server | null = null;
    private sseClients: SSEClient[] = [];
    private clientIdCounter = 0;

    /** 是否已初始化（MCP initialize 握手完成） */
    private initialized = false;

    /** snake_case → camelCase 参数名映射表 */
    private static readonly PARAM_ALIASES: Record<string, string> = {
        'node_uuid': 'nodeUuid',
        'parent_uuid': 'parentUuid',
        'asset_uuid': 'assetUuid',
        'component_type': 'componentType',
        'method_name': 'methodName',
        'scene_path': 'scenePath',
        'root_node_type': 'rootNodeType',
        'file_path': 'filePath',
        'output_path': 'outputPath',
        'base_url': 'baseUrl',
        'config_path': 'configPath',
        'project_path': 'projectPath',
        'tool_names': 'toolNames',
        'module_names': 'moduleNames',
        'include_schemas': 'includeSchemas',
        'node_path': 'nodePath',
        'texture_path': 'texturePath',
        'new_path': 'newPath',
        'parent_path': 'parentPath',
        'target_path': 'targetPath',
    };

    /**
     * 将 snake_case 参数名自动归一化为 camelCase
     * 递归处理嵌套对象
     */
    static normalizeParams(args: Record<string, unknown>): Record<string, unknown> {
        if (!args || typeof args !== 'object') return args;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(args)) {
            const camelKey = MCPServer.PARAM_ALIASES[key] || key;
            const val = args[key];
            if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
                result[camelKey] = MCPServer.normalizeParams(val as Record<string, unknown>);
            } else {
                result[camelKey] = val;
            }
        }
        return result;
    }

    // ==================== 启停控制 ====================

    /** 启动 HTTP 服务器 */
    start(port: number): void {
        if (this.server) {
            console.warn('[MCP] 服务器已在运行中');
            return;
        }

        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        this.server.listen(port, '127.0.0.1', () => {
            console.log(`[MCP] 服务器已启动: http://127.0.0.1:${port}`);
            console.log(`[MCP] SSE 端点: http://127.0.0.1:${port}/sse`);
            console.log(`[MCP] JSON-RPC 端点: http://127.0.0.1:${port}/mcp`);
        });

        this.server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[MCP] 端口 ${port} 已被占用`);
            } else {
                console.error('[MCP] 服务器错误:', err);
            }
        });
    }

    /** 停止 HTTP 服务器 */
    stop(): void {
        // 关闭所有 SSE 连接
        for (const client of this.sseClients) {
            client.res.end();
        }
        this.sseClients = [];

        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.initialized = false;
        console.log('[MCP] 服务器已停止');
    }

    // ==================== 请求路由 ====================

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = req.url || '/';

        if (req.method === 'GET' && url.startsWith('/sse')) {
            this.handleSSE(req, res);
        } else if (req.method === 'POST' && url === '/mcp') {
            this.handleJSONRPC(req, res);
        } else if (req.method === 'GET' && url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', initialized: this.initialized }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }

    // ==================== SSE 处理 ====================

    private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        const clientId = String(++this.clientIdCounter);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const client: SSEClient = { id: clientId, res };
        this.sseClients.push(client);

        // 发送 endpoint 事件，告知客户端 POST 地址
        this.sendSSE(client, 'endpoint', { uri: '/mcp' });

        console.log(`[MCP] SSE 客户端 #${clientId} 已连接`);

        req.on('close', () => {
            this.sseClients = this.sseClients.filter(c => c.id !== clientId);
            console.log(`[MCP] SSE 客户端 #${clientId} 已断开`);
        });
    }

    /** 向 SSE 客户端发送事件 */
    private sendSSE(client: SSEClient, event: string, data: any): void {
        const lines = [`event: ${event}`];
        const json = JSON.stringify(data);
        if (json === undefined) {
            client.res.write(`event: ${event}\ndata: null\n\n`);
            return;
        }
        // 多行数据每行 "data: <line>"
        for (const line of json.split('\n')) {
            lines.push(`data: ${line}`);
        }
        lines.push('', ''); // 空行结束
        client.res.write(lines.join('\n'));
    }

    /** 广播 SSE 事件给所有客户端 */
    private broadcastSSE(event: string, data: any): void {
        for (const client of this.sseClients) {
            this.sendSSE(client, event, data);
        }
    }

    // ==================== JSON-RPC 处理 ====================

    private async handleJSONRPC(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readBody(req);
        let request: JSONRPCRequest;

        try {
            request = JSON.parse(body);
        } catch {
            this.sendError(res, null, MCPErrorCode.ParseError, '无效的 JSON');
            return;
        }

        // 验证基本结构
        if (!request.jsonrpc || request.jsonrpc !== '2.0' || !request.method) {
            this.sendError(res, request.id ?? null, MCPErrorCode.InvalidRequest, '无效的 JSON-RPC 请求');
            return;
        }

        // 路由到对应处理器
        try {
            await this.route(request, res);
        } catch (e: any) {
            console.error('[MCP] 路由错误:', e);
            if (!res.writableEnded) {
                this.sendError(res, request.id ?? null, MCPErrorCode.InternalError, e.message || '内部错误');
            }
        }
    }

    private async route(request: JSONRPCRequest, res: http.ServerResponse): Promise<void> {
        const { method, params, id } = request;

        switch (method) {
            case MCPMethods.INITIALIZE:
                this.handleInitialize(id, params, res);
                break;
            case MCPMethods.INITIALIZED:
                // 通知，无需响应
                this.initialized = true;
                console.log('[MCP] 客户端初始化完成');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
                break;
            case MCPMethods.PING:
                this.sendResult(res, id, {});
                break;
            case MCPMethods.TOOLS_LIST:
                this.handleToolsList(id, res);
                break;
            case MCPMethods.TOOLS_CALL:
                await this.handleToolsCall(id, params, res);
                break;
            case MCPMethods.RESOURCES_LIST:
                this.sendResult(res, id, { resources: [] });
                break;
            case MCPMethods.PROMPTS_LIST:
                this.sendResult(res, id, { prompts: [] });
                break;
            default:
                this.sendError(res, id, MCPErrorCode.MethodNotFound, `未知方法: ${method}`);
        }
    }

    // ==================== MCP 方法处理器 ====================

    /** AI 使用说明书 — 注入 system prompt 指导工具选择 */
    private static readonly SERVER_INSTRUCTIONS = `# Cocos Creator MCP — 编辑器自动化工具集 (mcp_game)

## 工具选择指南

### 场景编辑 (scene)
- **场景生命周期** → \`scene/open_scene\`、\`scene/save_scene\`、\`scene/close_scene\`、\`scene/create_scene\`、\`scene/create_default_2d_scene\`
- **场景查询** → \`scene/query_current_scene\`、\`scene/query_node_tree\`、\`scene/get_scene_hierarchy\`、\`scene/query_scene_json\`
- **节点操作** → \`scene/get_all_nodes\`、\`scene/find_node_by_name\`、\`scene/create_node\`、\`scene/delete_node\`、\`scene/duplicate_node\`、\`scene/move_node\`、\`scene/set_node_property\`、\`scene/set_node_transform\`
- **组件操作** → \`scene/add_component\`、\`scene/remove_component\`、\`scene/set_component_property\`、\`scene/query_component\`、\`scene/query_components\`
- **便捷创建** → \`scene/create_sprite_node\`、\`scene/create_label_node\`、\`scene/create_button_node\`
- **批量操作** → \`scene/batch_rename\`、\`scene/find_and_set\`

### 资源管理 (asset)
- **查询** → \`asset/query_assets\`、\`asset/query_asset_info\`、\`asset/query_uuid\`、\`asset/query_path\`、\`asset/query_url\`
- **操作** → \`asset/create_asset\`、\`asset/import_asset\`、\`asset/copy_asset\`、\`asset/move_asset\`、\`asset/delete_asset\`、\`asset/save_asset\`、\`asset/refresh_asset\`

### 预制件 (prefab)
- **操作** → \`prefab/get_prefab_list\`、\`prefab/get_prefab_info\`、\`prefab/instantiate_prefab\`、\`prefab/create_prefab\`、\`prefab/duplicate_prefab\`、\`prefab/batch_instantiate\`

### 项目/构建 (project)
- **配置** → \`project/query_project_config\`、\`project/set_project_config\`、\`project/query_design_resolution\`
- **预览** → \`project/start_preview\`、\`project/refresh_preview\`、\`project/query_preview_url\`
- **构建** → \`project/command_build\`、\`project/open_build_panel\`、\`project/query_build_worker_ready\`

### 动画编辑 (animation) ⭐新
- **查询** → \`animation/query_edit_info\`、\`animation/query_clips_info\`、\`animation/query_clip\`、\`animation/query_clip_dump\`
- **关键帧** → \`animation/create_key\`、\`animation/update_key\`、\`animation/remove_key\`、\`animation/create_prop\`、\`animation/remove_prop\`
- **事件** → \`animation/add_event\`、\`animation/delete_event\`、\`animation/update_event\`、\`animation/batch_events\`
- **预设** → \`animation/preset_list\`、\`animation/preset\`（支持 13 种预设）
- **属性** → \`animation/change_sample\`、\`animation/change_speed\`、\`animation/change_wrap_mode\`

### 标签/字体 (label) ⭐新
- **操作** → \`label/set_text\`、\`label/set_font\`、\`label/set_font_family\`、\`label/set_style\`、\`label/set_outline\`、\`label/set_shadow\`
- **批量** → \`label/batch_set_font\`、\`label/batch_set_style\`

### Spine 骨骼动画 (spine) ⭐新
- **操作** → \`spine/list_animations\`、\`spine/list_skins\`、\`spine/set_animation\`、\`spine/set_skin\`、\`spine/set_property\`、\`spine/set_data\`、\`spine/add_socket\`、\`spine/remove_socket\`

### 视口控制 (view) ⭐新
- **Gizmo** → \`view/gizmo_tool\`、\`view/gizmo_pivot\`、\`view/gizmo_coordinate\`
- **视图** → \`view/mode_2d_3d\`、\`view/grid_set\`、\`view/camera_focus\`、\`view/camera_align_view\`、\`view/reset_view\`
- **参考图** → \`view/ref_add\`、\`view/ref_remove\`、\`view/ref_list\`、\`view/ref_position\` 等

### 场景构建器 (builder) ⭐新
- \`builder/build\` — 从 JSON 定义一键创建完整节点树（递归嵌套、组件、属性）

### 场景快照 (capture) ⭐新
- \`capture/scene_snapshot\` — 完整场景布局 JSON
- \`capture/node_snapshot\` — 指定节点子树快照

### UI 模板 (template) ⭐新
- \`template/list\`、\`template/apply\` — dialog / scroll_list / nav_bar / settings_page

### 知识库 (knowledge) ⭐新
- **查询** → \`knowledge/knowledge_list_topics\`、\`knowledge/knowledge_query\`、\`knowledge/knowledge_search\`
- **组件** → \`knowledge/knowledge_component_props\`、\`knowledge/knowledge_animation_pattern\`、\`knowledge/knowledge_layout_pattern\`
- **架构** → \`knowledge/knowledge_node_structure\`、\`knowledge/knowledge_widget_strategies\`、\`knowledge/knowledge_best_practice\`

### 调试/诊断 (debug)
- **控制台** → \`debug/start_console_capture\`、\`debug/stop_console_capture\`、\`debug/get_console_logs\`
- **统计** → \`debug/get_scene_stats\`、\`debug/get_component_stats\`
- **诊断** → \`debug/get_editor_status\`、\`debug/get_environment_info\`

### 校验 (validation)
- **场景** → \`validation/validate_scene\`、\`validation/quick_validate\`
- **节点** → \`validation/diagnose_node\`
- **预制件** → \`validation/validate_prefab_instances\`、\`validation/validate_prefab_format\`

### 广播 (broadcast)
- **操作** → \`broadcast/soft_reload\`、\`broadcast/refresh_preview\`、\`broadcast/broadcast_notification\`、\`broadcast/editor_notify\`

---

## 📚 知识速查 (混合模式：详情用 knowledge/* 工具查询)

### 字号规范
标题 32-40, 正文 24-28, 标注 18-22, 按钮 24-32

### 间距规范
标准间距: 8, 16, 24, 32, 48 (8 的倍数)。屏幕边缘: 16-24px

### 触摸目标
最小 44x44 点 (88x88 @2x)

### 按钮尺寸
小 120x44, 中 200x60, 大 300x80

### 动画时长
UI 过渡 0.2-0.3s 最敏捷

### 常用缓动
backOut (弹入), cubicOut (平滑减速), elasticOut (弹簧)

### 13 个动画预设
fade_in, fade_out, scale_bounce, scale_close, slide_in_bottom, slide_in_right, shake, pulse, float, typewriter, number_roll, flip_card, combo_sequence

### 12 个 UI 布局模板
dialog, scroll_list, tab_bar, hud, login, settings, grid_inventory, leaderboard, loading, toast, shop, level_select

### 7 个组件属性模板
cc.Sprite, cc.Label, cc.Button, cc.Widget, cc.Layout, cc.ScrollView, cc.EditBox

### 最佳实践类别
performance, multi_resolution, scene_management, input_handling, memory_management, audio, animation_tips, ui_architecture

---

## 常用工作流

1. 先调 \`capture/scene_snapshot\` 或 \`scene/query_current_scene\` 获取当前场景信息
2. 再用 \`scene/query_node_tree?includeComponents=true\` 或 \`scene/get_scene_hierarchy\` 查看节点层级
3. 创建节点前先 \`scene/get_all_nodes\` 确认父节点 UUID
4. 修改后调 \`scene/save_scene\` 保存
5. 复杂 UI 用 \`builder/build\` 从 JSON 定义直接构建
6. 预制件实例化用 \`prefab/instantiate_prefab\`，批量用 \`prefab/batch_instantiate\`
7. 动画用 \`animation/preset\`（writeMode:"file" 免编辑模式）
8. 场景分析用 \`capture/scene_snapshot\`
9. 知识查询用 \`knowledge/knowledge_query\` + 主题名

## 最佳实践

- 找节点优先用 \`scene/find_node_by_name\`
- 设置 Label 文本用 \`scene/set_component_property\`（property: "string"）
- 设置 Sprite 图片用 \`scene/set_component_property\`（property: "spriteFrame", value: "\${uuid}"）
- 批量实例化用 \`prefab/batch_instantiate\`
- 构建前调 \`project/query_build_worker_ready\` 确认构建就绪
- 使用 \`get_capabilities\` 按需加载工具的完整参数说明
- 参数支持 \`snake_case\` 和 \`camelCase\` 双格式

## UI 层级规范
Background → GameLayer → UILayer → PopupLayer → ToastLayer

## 注意事项
- 禁止直接编辑 .scene/.prefab/.anim/.meta 文件，只能通过 MCP 接口操作
- 结果不正确时，先检查参数，再检查接口
- 创建场景/预制件/界面时，内部结构也必须通过 MCP 创建
- 动画预设使用 writeMode:"file" 可直接写入文件绕过编辑模式限制
`;

    private handleInitialize(id: number | string, params: any, res: http.ServerResponse): void {
        const result: InitializeResult = {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {},
                resources: {},
                prompts: {},
                logging: {},
            },
            serverInfo: {
                name: 'cocos-creator-mcp',
                version: '1.0.0',
            },
            instructions: MCPServer.SERVER_INSTRUCTIONS,
        };
        this.sendResult(res, id, result);
    }

    // ==================== tools/list — 返回轻量入口工具 ====================

    /** 内置入口工具定义（始终可用，不依赖模块注册） */
    private static readonly ENTRY_TOOLS: ToolDefinition[] = [
        {
            name: 'get_capabilities',
            description: '返回 godot-devtool 风格的工具目录。默认返回轻量分类摘要；传 toolNames/moduleNames 过滤 + includeSchemas=true 可获取完整 inputSchema。这是发现所有可用工具的入口。',
            inputSchema: {
                type: 'object',
                properties: {
                    toolNames: {
                        type: 'string',
                        description: '要查询的工具名列表（JSON 数组字符串，如 ["scene/query_node_tree","asset/query_assets"]）',
                    },
                    moduleNames: {
                        type: 'string',
                        description: '要查询的模块名列表（JSON 数组字符串，如 ["scene","project"]）',
                    },
                    includeSchemas: {
                        type: 'string',
                        description: '是否包含完整 inputSchema，传入 "true" 即包含（默认不包含以节省 token）',
                    },
                },
            },
        },
        {
            name: '_meta/categories',
            description: '工具分类元数据：按模块分组的工具概览，不含 inputSchema（节省 token）',
        },
    ];

    private handleToolsList(id: number | string, res: http.ServerResponse): void {
        // tools/list 只返回入口工具，避免一次性暴露所有 schema 烧 token
        this.sendResult(res, id, { tools: MCPServer.ENTRY_TOOLS });
    }

    // ==================== tools/call — 内置 + 委派 ====================

    private async handleToolsCall(
        id: number | string,
        params: any,
        res: http.ServerResponse,
    ): Promise<void> {
        if (!params?.name) {
            this.sendError(res, id, MCPErrorCode.InvalidParams, '缺少工具名称');
            return;
        }

        const toolName = String(params.name);

        // === 内置工具：get_capabilities ===
        if (toolName === 'get_capabilities') {
            const args = MCPServer.normalizeParams(params.arguments || {});
            await this.handleGetCapabilities(args, res, id);
            return;
        }

        // === 内置工具：_meta/categories ===
        if (toolName === '_meta/categories') {
            this.handleCategories(res, id);
            return;
        }

        // === 其余工具：委派 ModuleLoader ===
        const args = MCPServer.normalizeParams(params.arguments || {});

        // 从工具全名中提取模块名（格式: moduleName/toolName 或直接 toolName）
        let moduleName = '';
        let methodName = toolName;

        if (toolName.includes('/')) {
            [moduleName, methodName] = toolName.split('/', 2);
        } else {
            // 在所有启用的模块中搜索该工具
            const registry = MetadataRegistry.ins;
            for (const mod of registry.getModules()) {
                if (!mod.enabled) continue;
                if (mod.tools.some(t => t.name === methodName && t.enabled)) {
                    moduleName = mod.name;
                    break;
                }
            }
        }

        if (!moduleName) {
            this.sendResult(res, id, {
                content: [{ type: 'text', text: `工具 '${toolName}' 不存在或未启用` }],
                isError: true,
            });
            return;
        }

        // 动态加载 ModuleLoader 执行工具
        const { ModuleLoader } = await import('./ModuleLoader');
        const result = await ModuleLoader.ins.handleToolCall(moduleName, methodName, args);
        this.sendResult(res, id, result);

        // 广播日志
        this.broadcastSSE('message', {
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: {
                level: 'info',
                logger: 'mcp',
                data: `工具调用: ${moduleName}/${methodName}(${JSON.stringify(args)})`,
            },
        });
    }

    // ==================== get_capabilities 处理器 ====================

    /**
     * 按需获取工具目录（godot-devtool 风格）。
     * 默认返回轻量分类摘要；传过滤条件 + includeSchemas 可获取完整详情。
     */
    private async handleGetCapabilities(
        args: Record<string, unknown>,
        res: http.ServerResponse,
        id: number | string,
    ): Promise<void> {
        const registry = MetadataRegistry.ins;

        // 解析过滤条件
        let toolFilter: string[] | null = null;
        let moduleFilter: string[] | null = null;
        const includeSchemas = String(args.includeSchemas ?? '') === 'true';

        if (args.toolNames) {
            try {
                toolFilter = typeof args.toolNames === 'string'
                    ? JSON.parse(args.toolNames)
                    : args.toolNames as string[];
            } catch { /* 忽略解析失败 */ }
        }
        if (args.moduleNames) {
            try {
                moduleFilter = typeof args.moduleNames === 'string'
                    ? JSON.parse(args.moduleNames)
                    : args.moduleNames as string[];
            } catch { /* 忽略解析失败 */ }
        }

        // 收集所有启用的模块 + 工具
        const modules = registry.getEnabledModules();
        const resultTools: ToolDefinition[] = [];
        const resultModules: { name: string; description: string; toolCount: number }[] = [];

        for (const mod of modules) {
            if (moduleFilter && !moduleFilter.includes(mod.name)) continue;
            const enabledTools = mod.tools.filter(t => t.enabled);
            resultModules.push({
                name: mod.name,
                description: mod.description,
                toolCount: enabledTools.length,
            });

            for (const t of enabledTools) {
                if (toolFilter && !toolFilter.includes(`${mod.name}/${t.name}`) && !toolFilter.includes(t.name)) {
                    continue;
                }
                if (includeSchemas) {
                    // 完整 schema
                    const def: ToolDefinition = {
                        name: `${mod.name}/${t.name}`,
                        description: t.description,
                    };
                    if (t.paramsSchema) {
                        def.inputSchema = {
                            type: 'object',
                            properties: t.paramsSchema as any,
                        };
                    }
                    resultTools.push(def);
                } else {
                    // 轻量条目（不含 inputSchema）
                    resultTools.push({
                        name: `${mod.name}/${t.name}`,
                        description: t.description,
                    });
                }
            }
        }

        this.sendResult(res, id, {
            tools: resultTools,
            modules: resultModules,
            routeGroups: ['scene', 'prefab', 'asset', 'project', 'debug', 'broadcast', 'validation'],
        });
    }

    // ==================== 工具分类元数据 ====================

    /** 返回模块分组概览（不含 inputSchema） */
    private handleCategories(res: http.ServerResponse, id: number | string): void {
        const registry = MetadataRegistry.ins;
        const modules = registry.getEnabledModules();
        const categories = modules.map(mod => ({
            name: mod.name,
            description: mod.description,
            tools: mod.tools.filter(t => t.enabled).map(t => ({
                name: `${mod.name}/${t.name}`,
                description: t.description,
            })),
        }));
        this.sendResult(res, id, { categories });
    }

    // ==================== HTTP 辅助 ====================

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => (data += chunk));
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    private sendResult(res: http.ServerResponse, id: number | string | null, result: any): void {
        const response: JSONRPCResponse = {
            jsonrpc: '2.0',
            id: id as number | string,
            result,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }

    private sendError(
        res: http.ServerResponse,
        id: number | string | null,
        code: MCPErrorCode,
        message: string,
    ): void {
        const error: JSONRPCError = {
            jsonrpc: '2.0',
            id,
            error: { code, message },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(error));
    }
}
