"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;
const http = __importStar(require("http"));
const types_1 = require("./types");
const MetadataRegistry_1 = require("./MetadataRegistry");
class MCPServer {
    constructor() {
        this.server = null;
        this.sseClients = [];
        this.clientIdCounter = 0;
        /** 是否已初始化（MCP initialize 握手完成） */
        this.initialized = false;
    }
    static get ins() {
        if (!this._ins)
            this._ins = new MCPServer();
        return this._ins;
    }
    /**
     * 将 snake_case 参数名自动归一化为 camelCase
     * 递归处理嵌套对象
     */
    static normalizeParams(args) {
        if (!args || typeof args !== 'object')
            return args;
        const result = {};
        for (const key of Object.keys(args)) {
            const camelKey = MCPServer.PARAM_ALIASES[key] || key;
            const val = args[key];
            if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
                result[camelKey] = MCPServer.normalizeParams(val);
            }
            else {
                result[camelKey] = val;
            }
        }
        return result;
    }
    // ==================== 启停控制 ====================
    /** 启动 HTTP 服务器 */
    start(port) {
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
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[MCP] 端口 ${port} 已被占用`);
            }
            else {
                console.error('[MCP] 服务器错误:', err);
            }
        });
    }
    /** 停止 HTTP 服务器 */
    stop() {
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
    handleRequest(req, res) {
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
        }
        else if (req.method === 'POST' && url === '/mcp') {
            this.handleJSONRPC(req, res);
        }
        else if (req.method === 'GET' && url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', initialized: this.initialized }));
        }
        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
    // ==================== SSE 处理 ====================
    handleSSE(req, res) {
        const clientId = String(++this.clientIdCounter);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const client = { id: clientId, res };
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
    sendSSE(client, event, data) {
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
    broadcastSSE(event, data) {
        for (const client of this.sseClients) {
            this.sendSSE(client, event, data);
        }
    }
    // ==================== JSON-RPC 处理 ====================
    async handleJSONRPC(req, res) {
        var _a, _b;
        const body = await this.readBody(req);
        let request;
        try {
            request = JSON.parse(body);
        }
        catch (_c) {
            this.sendError(res, null, types_1.MCPErrorCode.ParseError, '无效的 JSON');
            return;
        }
        // 验证基本结构
        if (!request.jsonrpc || request.jsonrpc !== '2.0' || !request.method) {
            this.sendError(res, (_a = request.id) !== null && _a !== void 0 ? _a : null, types_1.MCPErrorCode.InvalidRequest, '无效的 JSON-RPC 请求');
            return;
        }
        // 路由到对应处理器
        try {
            await this.route(request, res);
        }
        catch (e) {
            console.error('[MCP] 路由错误:', e);
            if (!res.writableEnded) {
                this.sendError(res, (_b = request.id) !== null && _b !== void 0 ? _b : null, types_1.MCPErrorCode.InternalError, e.message || '内部错误');
            }
        }
    }
    async route(request, res) {
        const { method, params, id } = request;
        switch (method) {
            case types_1.MCPMethods.INITIALIZE:
                this.handleInitialize(id, params, res);
                break;
            case types_1.MCPMethods.INITIALIZED:
                // 通知，无需响应
                this.initialized = true;
                console.log('[MCP] 客户端初始化完成');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
                break;
            case types_1.MCPMethods.PING:
                this.sendResult(res, id, {});
                break;
            case types_1.MCPMethods.TOOLS_LIST:
                this.handleToolsList(id, res);
                break;
            case types_1.MCPMethods.TOOLS_CALL:
                await this.handleToolsCall(id, params, res);
                break;
            case types_1.MCPMethods.RESOURCES_LIST:
                this.sendResult(res, id, { resources: [] });
                break;
            case types_1.MCPMethods.PROMPTS_LIST:
                this.sendResult(res, id, { prompts: [] });
                break;
            default:
                this.sendError(res, id, types_1.MCPErrorCode.MethodNotFound, `未知方法: ${method}`);
        }
    }
    handleInitialize(id, params, res) {
        const result = {
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
    handleToolsList(id, res) {
        // tools/list 只返回入口工具，避免一次性暴露所有 schema 烧 token
        this.sendResult(res, id, { tools: MCPServer.ENTRY_TOOLS });
    }
    // ==================== tools/call — 内置 + 委派 ====================
    async handleToolsCall(id, params, res) {
        if (!(params === null || params === void 0 ? void 0 : params.name)) {
            this.sendError(res, id, types_1.MCPErrorCode.InvalidParams, '缺少工具名称');
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
        }
        else {
            // 在所有启用的模块中搜索该工具
            const registry = MetadataRegistry_1.MetadataRegistry.ins;
            for (const mod of registry.getModules()) {
                if (!mod.enabled)
                    continue;
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
        const { ModuleLoader } = await Promise.resolve().then(() => __importStar(require('./ModuleLoader')));
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
    async handleGetCapabilities(args, res, id) {
        var _a;
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
        // 解析过滤条件
        let toolFilter = null;
        let moduleFilter = null;
        const includeSchemas = String((_a = args.includeSchemas) !== null && _a !== void 0 ? _a : '') === 'true';
        if (args.toolNames) {
            try {
                toolFilter = typeof args.toolNames === 'string'
                    ? JSON.parse(args.toolNames)
                    : args.toolNames;
            }
            catch ( /* 忽略解析失败 */_b) { /* 忽略解析失败 */ }
        }
        if (args.moduleNames) {
            try {
                moduleFilter = typeof args.moduleNames === 'string'
                    ? JSON.parse(args.moduleNames)
                    : args.moduleNames;
            }
            catch ( /* 忽略解析失败 */_c) { /* 忽略解析失败 */ }
        }
        // 收集所有启用的模块 + 工具
        const modules = registry.getEnabledModules();
        const resultTools = [];
        const resultModules = [];
        for (const mod of modules) {
            if (moduleFilter && !moduleFilter.includes(mod.name))
                continue;
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
                    const def = {
                        name: `${mod.name}/${t.name}`,
                        description: t.description,
                    };
                    if (t.paramsSchema) {
                        def.inputSchema = {
                            type: 'object',
                            properties: t.paramsSchema,
                        };
                    }
                    resultTools.push(def);
                }
                else {
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
    handleCategories(res, id) {
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
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
    readBody(req) {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => (data += chunk));
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }
    sendResult(res, id, result) {
        const response = {
            jsonrpc: '2.0',
            id: id,
            result,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }
    sendError(res, id, code, message) {
        const error = {
            jsonrpc: '2.0',
            id,
            error: { code, message },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(error));
    }
}
exports.MCPServer = MCPServer;
/** snake_case → camelCase 参数名映射表 */
MCPServer.PARAM_ALIASES = {
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
// ==================== MCP 方法处理器 ====================
/** AI 使用说明书 — 注入 system prompt 指导工具选择 */
MCPServer.SERVER_INSTRUCTIONS = `# Cocos Creator MCP — 编辑器自动化工具集 (mcp_game)

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
// ==================== tools/list — 返回轻量入口工具 ====================
/** 内置入口工具定义（始终可用，不依赖模块注册） */
MCPServer.ENTRY_TOOLS = [
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTUNQU2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL21jcC9NQ1BTZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7OztHQVdHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCwyQ0FBNkI7QUFDN0IsbUNBUWlCO0FBQ2pCLHlEQUFnRTtBQVFoRSxNQUFhLFNBQVM7SUFBdEI7UUFPWSxXQUFNLEdBQXVCLElBQUksQ0FBQztRQUNsQyxlQUFVLEdBQWdCLEVBQUUsQ0FBQztRQUM3QixvQkFBZSxHQUFHLENBQUMsQ0FBQztRQUU1QixrQ0FBa0M7UUFDMUIsZ0JBQVcsR0FBRyxLQUFLLENBQUM7SUFzbkJoQyxDQUFDO0lBaG9CRyxNQUFNLEtBQUssR0FBRztRQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSTtZQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxTQUFTLEVBQUUsQ0FBQztRQUM1QyxPQUFPLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDckIsQ0FBQztJQWlDRDs7O09BR0c7SUFDSCxNQUFNLENBQUMsZUFBZSxDQUFDLElBQTZCO1FBQ2hELElBQUksQ0FBQyxJQUFJLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ25ELE1BQU0sTUFBTSxHQUE0QixFQUFFLENBQUM7UUFDM0MsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDbEMsTUFBTSxRQUFRLEdBQUcsU0FBUyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsSUFBSSxHQUFHLENBQUM7WUFDckQsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3RCLElBQUksR0FBRyxLQUFLLElBQUksSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLElBQUksQ0FBQyxLQUFLLENBQUMsT0FB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VyxFQUFFLDZDQUE2QztLQUM3RDtDQUNKLEFBMUJrQyxDQTBCakMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1DUCBIVFRQICsgU1NFIOacjeWKoeWZqFxuICpcbiAqIOWfuuS6jiBOb2RlLmpzIGh0dHAg5qih5Z2X77yM5Zyo57yW6L6R5Zmo5YaF6YOo5ZCv5Yqo5pys5ZywIEhUVFAg5pyN5Yqh44CCXG4gKiAtIEdFVCAgL3NzZSAg4oaSIFNTRSDplb/ov57mjqXvvIznlKjkuo7mnI3liqHnq6/mjqjpgIFcbiAqIC0gUE9TVCAvbWNwICDihpIgSlNPTi1SUEMg6K+35rGC5aSE55CGXG4gKlxuICog6K6+6K6h6KaB54K577yaXG4gKiAtIHRvb2xzL2xpc3Qg6L+U5Zue6L276YeP5YWl5Y+j5bel5YW377yIZ2V0X2NhcGFiaWxpdGllc++8ie+8jOaMiemcgOmAmui/hyBnZXRfY2FwYWJpbGl0aWVzIOiOt+WPluWujOaVtCBzY2hlbWFcbiAqIC0g5Y+C5pWw5pSv5oyBIHNuYWtlX2Nhc2UgKyBjYW1lbENhc2Ug5Y+M5qC85byP6Ieq5Yqo5b2S5LiA5YyWXG4gKiAtIGluaXRpYWxpemUg5ZON5bqU5ZCrIGluc3RydWN0aW9ucyDlrZfmrrXmjIflr7wgQUkg5L2/55SoXG4gKi9cblxuaW1wb3J0ICogYXMgaHR0cCBmcm9tICdodHRwJztcbmltcG9ydCB7XG4gICAgSlNPTlJQQ1JlcXVlc3QsXG4gICAgSlNPTlJQQ1Jlc3BvbnNlLFxuICAgIEpTT05SUENFcnJvcixcbiAgICBNQ1BFcnJvckNvZGUsXG4gICAgTUNQTWV0aG9kcyxcbiAgICBUb29sRGVmaW5pdGlvbixcbiAgICBJbml0aWFsaXplUmVzdWx0LFxufSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IE1ldGFkYXRhUmVnaXN0cnksIFRvb2xJbmZvIH0gZnJvbSAnLi9NZXRhZGF0YVJlZ2lzdHJ5JztcblxuLyoqIFNTRSDlrqLmiLfnq6/ov57mjqUgKi9cbmludGVyZmFjZSBTU0VDbGllbnQge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgcmVzOiBodHRwLlNlcnZlclJlc3BvbnNlO1xufVxuXG5leHBvcnQgY2xhc3MgTUNQU2VydmVyIHtcbiAgICBwcml2YXRlIHN0YXRpYyBfaW5zOiBNQ1BTZXJ2ZXI7XG4gICAgc3RhdGljIGdldCBpbnMoKTogTUNQU2VydmVyIHtcbiAgICAgICAgaWYgKCF0aGlzLl9pbnMpIHRoaXMuX2lucyA9IG5ldyBNQ1BTZXJ2ZXIoKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2lucztcbiAgICB9XG5cbiAgICBwcml2YXRlIHNlcnZlcjogaHR0cC5TZXJ2ZXIgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHNzZUNsaWVudHM6IFNTRUNsaWVudFtdID0gW107XG4gICAgcHJpdmF0ZSBjbGllbnRJZENvdW50ZXIgPSAwO1xuXG4gICAgLyoqIOaYr+WQpuW3suWIneWni+WMlu+8iE1DUCBpbml0aWFsaXplIOaPoeaJi+WujOaIkO+8iSAqL1xuICAgIHByaXZhdGUgaW5pdGlhbGl6ZWQgPSBmYWxzZTtcblxuICAgIC8qKiBzbmFrZV9jYXNlIOKGkiBjYW1lbENhc2Ug5Y+C5pWw5ZCN5pig5bCE6KGoICovXG4gICAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgUEFSQU1fQUxJQVNFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgJ25vZGVfdXVpZCc6ICdub2RlVXVpZCcsXG4gICAgICAgICdwYXJlbnRfdXVpZCc6ICdwYXJlbnRVdWlkJyxcbiAgICAgICAgJ2Fzc2V0X3V1aWQnOiAnYXNzZXRVdWlkJyxcbiAgICAgICAgJ2NvbXBvbmVudF90eXBlJzogJ2NvbXBvbmVudFR5cGUnLFxuICAgICAgICAnbWV0aG9kX25hbWUnOiAnbWV0aG9kTmFtZScsXG4gICAgICAgICdzY2VuZV9wYXRoJzogJ3NjZW5lUGF0aCcsXG4gICAgICAgICdyb290X25vZGVfdHlwZSc6ICdyb290Tm9kZVR5cGUnLFxuICAgICAgICAnZmlsZV9wYXRoJzogJ2ZpbGVQYXRoJyxcbiAgICAgICAgJ291dHB1dF9wYXRoJzogJ291dHB1dFBhdGgnLFxuICAgICAgICAnYmFzZV91cmwnOiAnYmFzZVVybCcsXG4gICAgICAgICdjb25maWdfcGF0aCc6ICdjb25maWdQYXRoJyxcbiAgICAgICAgJ3Byb2plY3RfcGF0aCc6ICdwcm9qZWN0UGF0aCcsXG4gICAgICAgICd0b29sX25hbWVzJzogJ3Rvb2xOYW1lcycsXG4gICAgICAgICdtb2R1bGVfbmFtZXMnOiAnbW9kdWxlTmFtZXMnLFxuICAgICAgICAnaW5jbHVkZV9zY2hlbWFzJzogJ2luY2x1ZGVTY2hlbWFzJyxcbiAgICAgICAgJ25vZGVfcGF0aCc6ICdub2RlUGF0aCcsXG4gICAgICAgICd0ZXh0dXJlX3BhdGgnOiAndGV4dHVyZVBhdGgnLFxuICAgICAgICAnbmV3X3BhdGgnOiAnbmV3UGF0aCcsXG4gICAgICAgICdwYXJlbnRfcGF0aCc6ICdwYXJlbnRQYXRoJyxcbiAgICAgICAgJ3RhcmdldF9wYXRoJzogJ3RhcmdldFBhdGgnLFxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiDlsIYgc25ha2VfY2FzZSDlj4LmlbDlkI3oh6rliqjlvZLkuIDljJbkuLogY2FtZWxDYXNlXG4gICAgICog6YCS5b2S5aSE55CG5bWM5aWX5a+56LGhXG4gICAgICovXG4gICAgc3RhdGljIG5vcm1hbGl6ZVBhcmFtcyhhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICAgICAgaWYgKCFhcmdzIHx8IHR5cGVvZiBhcmdzICE9PSAnb2JqZWN0JykgcmV0dXJuIGFyZ3M7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoYXJncykpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhbWVsS2V5ID0gTUNQU2VydmVyLlBBUkFNX0FMSUFTRVNba2V5XSB8fCBrZXk7XG4gICAgICAgICAgICBjb25zdCB2YWwgPSBhcmdzW2tleV07XG4gICAgICAgICAgICBpZiAodmFsICE9PSBudWxsICYmIHR5cGVvZiB2YWwgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHZhbCkpIHtcbiAgICAgICAgICAgICAgICByZXN1bHRbY2FtZWxLZXldID0gTUNQU2VydmVyLm5vcm1hbGl6ZVBhcmFtcyh2YWwgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXN1bHRbY2FtZWxLZXldID0gdmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5ZCv5YGc5o6n5Yi2ID09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvKiog5ZCv5YqoIEhUVFAg5pyN5Yqh5ZmoICovXG4gICAgc3RhcnQocG9ydDogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIGlmICh0aGlzLnNlcnZlcikge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdbTUNQXSDmnI3liqHlmajlt7LlnKjov5DooYzkuK0nKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuc2VydmVyID0gaHR0cC5jcmVhdGVTZXJ2ZXIoKHJlcSwgcmVzKSA9PiB0aGlzLmhhbmRsZVJlcXVlc3QocmVxLCByZXMpKTtcbiAgICAgICAgdGhpcy5zZXJ2ZXIubGlzdGVuKHBvcnQsICcxMjcuMC4wLjEnLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW01DUF0g5pyN5Yqh5Zmo5bey5ZCv5YqoOiBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gKTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbTUNQXSBTU0Ug56uv54K5OiBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3NlYCk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW01DUF0gSlNPTi1SUEMg56uv54K5OiBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbWNwYCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuc2VydmVyLm9uKCdlcnJvcicsIChlcnI6IGFueSkgPT4ge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlID09PSAnRUFERFJJTlVTRScpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbTUNQXSDnq6/lj6MgJHtwb3J0fSDlt7LooqvljaDnlKhgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcignW01DUF0g5pyN5Yqh5Zmo6ZSZ6K+vOicsIGVycik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKiDlgZzmraIgSFRUUCDmnI3liqHlmaggKi9cbiAgICBzdG9wKCk6IHZvaWQge1xuICAgICAgICAvLyDlhbPpl63miYDmnIkgU1NFIOi/nuaOpVxuICAgICAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiB0aGlzLnNzZUNsaWVudHMpIHtcbiAgICAgICAgICAgIGNsaWVudC5yZXMuZW5kKCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zc2VDbGllbnRzID0gW107XG5cbiAgICAgICAgaWYgKHRoaXMuc2VydmVyKSB7XG4gICAgICAgICAgICB0aGlzLnNlcnZlci5jbG9zZSgpO1xuICAgICAgICAgICAgdGhpcy5zZXJ2ZXIgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuaW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgICAgICAgY29uc29sZS5sb2coJ1tNQ1BdIOacjeWKoeWZqOW3suWBnOatoicpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOivt+axgui3r+eUsSA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgcHJpdmF0ZSBoYW5kbGVSZXF1ZXN0KHJlcTogaHR0cC5JbmNvbWluZ01lc3NhZ2UsIHJlczogaHR0cC5TZXJ2ZXJSZXNwb25zZSk6IHZvaWQge1xuICAgICAgICAvLyBDT1JTIOWktFxuICAgICAgICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nLCAnKicpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJywgJ0dFVCwgUE9TVCwgT1BUSU9OUycpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJywgJ0NvbnRlbnQtVHlwZSwgTWNwLVNlc3Npb24tSWQnKTtcblxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDIwNCk7XG4gICAgICAgICAgICByZXMuZW5kKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB1cmwgPSByZXEudXJsIHx8ICcvJztcblxuICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnN0YXJ0c1dpdGgoJy9zc2UnKSkge1xuICAgICAgICAgICAgdGhpcy5oYW5kbGVTU0UocmVxLCByZXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwgPT09ICcvbWNwJykge1xuICAgICAgICAgICAgdGhpcy5oYW5kbGVKU09OUlBDKHJlcSwgcmVzKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwgPT09ICcvaGVhbHRoJykge1xuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9KTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdvaycsIGluaXRpYWxpemVkOiB0aGlzLmluaXRpYWxpemVkIH0pKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0KTtcbiAgICAgICAgICAgIHJlcy5lbmQoJ05vdCBGb3VuZCcpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0gU1NFIOWkhOeQhiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgcHJpdmF0ZSBoYW5kbGVTU0UocmVxOiBodHRwLkluY29taW5nTWVzc2FnZSwgcmVzOiBodHRwLlNlcnZlclJlc3BvbnNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNsaWVudElkID0gU3RyaW5nKCsrdGhpcy5jbGllbnRJZENvdW50ZXIpO1xuXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7XG4gICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgICAgICdDYWNoZS1Db250cm9sJzogJ25vLWNhY2hlJyxcbiAgICAgICAgICAgICdDb25uZWN0aW9uJzogJ2tlZXAtYWxpdmUnLFxuICAgICAgICAgICAgJ1gtQWNjZWwtQnVmZmVyaW5nJzogJ25vJyxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgY2xpZW50OiBTU0VDbGllbnQgPSB7IGlkOiBjbGllbnRJZCwgcmVzIH07XG4gICAgICAgIHRoaXMuc3NlQ2xpZW50cy5wdXNoKGNsaWVudCk7XG5cbiAgICAgICAgLy8g5Y+R6YCBIGVuZHBvaW50IOS6i+S7tu+8jOWRiuefpeWuouaIt+erryBQT1NUIOWcsOWdgFxuICAgICAgICB0aGlzLnNlbmRTU0UoY2xpZW50LCAnZW5kcG9pbnQnLCB7IHVyaTogJy9tY3AnIH0pO1xuXG4gICAgICAgIGNvbnNvbGUubG9nKGBbTUNQXSBTU0Ug5a6i5oi356uvICMke2NsaWVudElkfSDlt7Lov57mjqVgKTtcblxuICAgICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zc2VDbGllbnRzID0gdGhpcy5zc2VDbGllbnRzLmZpbHRlcihjID0+IGMuaWQgIT09IGNsaWVudElkKTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbTUNQXSBTU0Ug5a6i5oi356uvICMke2NsaWVudElkfSDlt7Lmlq3lvIBgKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqIOWQkSBTU0Ug5a6i5oi356uv5Y+R6YCB5LqL5Lu2ICovXG4gICAgcHJpdmF0ZSBzZW5kU1NFKGNsaWVudDogU1NFQ2xpZW50LCBldmVudDogc3RyaW5nLCBkYXRhOiBhbnkpOiB2b2lkIHtcbiAgICAgICAgY29uc3QgbGluZXMgPSBbYGV2ZW50OiAke2V2ZW50fWBdO1xuICAgICAgICBjb25zdCBqc29uID0gSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG4gICAgICAgIGlmIChqc29uID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNsaWVudC5yZXMud3JpdGUoYGV2ZW50OiAke2V2ZW50fVxcbmRhdGE6IG51bGxcXG5cXG5gKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyDlpJrooYzmlbDmja7mr4/ooYwgXCJkYXRhOiA8bGluZT5cIlxuICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YganNvbi5zcGxpdCgnXFxuJykpIHtcbiAgICAgICAgICAgIGxpbmVzLnB1c2goYGRhdGE6ICR7bGluZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBsaW5lcy5wdXNoKCcnLCAnJyk7IC8vIOepuuihjOe7k+adn1xuICAgICAgICBjbGllbnQucmVzLndyaXRlKGxpbmVzLmpvaW4oJ1xcbicpKTtcbiAgICB9XG5cbiAgICAvKiog5bm/5pKtIFNTRSDkuovku7bnu5nmiYDmnInlrqLmiLfnq68gKi9cbiAgICBwcml2YXRlIGJyb2FkY2FzdFNTRShldmVudDogc3RyaW5nLCBkYXRhOiBhbnkpOiB2b2lkIHtcbiAgICAgICAgZm9yIChjb25zdCBjbGllbnQgb2YgdGhpcy5zc2VDbGllbnRzKSB7XG4gICAgICAgICAgICB0aGlzLnNlbmRTU0UoY2xpZW50LCBldmVudCwgZGF0YSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSBKU09OLVJQQyDlpITnkIYgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIHByaXZhdGUgYXN5bmMgaGFuZGxlSlNPTlJQQyhyZXE6IGh0dHAuSW5jb21pbmdNZXNzYWdlLCByZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IGF3YWl0IHRoaXMucmVhZEJvZHkocmVxKTtcbiAgICAgICAgbGV0IHJlcXVlc3Q6IEpTT05SUENSZXF1ZXN0O1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXF1ZXN0ID0gSlNPTi5wYXJzZShib2R5KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICB0aGlzLnNlbmRFcnJvcihyZXMsIG51bGwsIE1DUEVycm9yQ29kZS5QYXJzZUVycm9yLCAn5peg5pWI55qEIEpTT04nKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOmqjOivgeWfuuacrOe7k+aehFxuICAgICAgICBpZiAoIXJlcXVlc3QuanNvbnJwYyB8fCByZXF1ZXN0Lmpzb25ycGMgIT09ICcyLjAnIHx8ICFyZXF1ZXN0Lm1ldGhvZCkge1xuICAgICAgICAgICAgdGhpcy5zZW5kRXJyb3IocmVzLCByZXF1ZXN0LmlkID8/IG51bGwsIE1DUEVycm9yQ29kZS5JbnZhbGlkUmVxdWVzdCwgJ+aXoOaViOeahCBKU09OLVJQQyDor7fmsYInKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOi3r+eUseWIsOWvueW6lOWkhOeQhuWZqFxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5yb3V0ZShyZXF1ZXN0LCByZXMpO1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tNQ1BdIOi3r+eUsemUmeivrzonLCBlKTtcbiAgICAgICAgICAgIGlmICghcmVzLndyaXRhYmxlRW5kZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNlbmRFcnJvcihyZXMsIHJlcXVlc3QuaWQgPz8gbnVsbCwgTUNQRXJyb3JDb2RlLkludGVybmFsRXJyb3IsIGUubWVzc2FnZSB8fCAn5YaF6YOo6ZSZ6K+vJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBwcml2YXRlIGFzeW5jIHJvdXRlKHJlcXVlc3Q6IEpTT05SUENSZXF1ZXN0LCByZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgY29uc3QgeyBtZXRob2QsIHBhcmFtcywgaWQgfSA9IHJlcXVlc3Q7XG5cbiAgICAgICAgc3dpdGNoIChtZXRob2QpIHtcbiAgICAgICAgICAgIGNhc2UgTUNQTWV0aG9kcy5JTklUSUFMSVpFOlxuICAgICAgICAgICAgICAgIHRoaXMuaGFuZGxlSW5pdGlhbGl6ZShpZCwgcGFyYW1zLCByZXMpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSBNQ1BNZXRob2RzLklOSVRJQUxJWkVEOlxuICAgICAgICAgICAgICAgIC8vIOmAmuefpe+8jOaXoOmcgOWTjeW6lFxuICAgICAgICAgICAgICAgIHRoaXMuaW5pdGlhbGl6ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdbTUNQXSDlrqLmiLfnq6/liJ3lp4vljJblrozmiJAnKTtcbiAgICAgICAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0pO1xuICAgICAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBqc29ucnBjOiAnMi4wJywgaWQsIHJlc3VsdDoge30gfSkpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSBNQ1BNZXRob2RzLlBJTkc6XG4gICAgICAgICAgICAgICAgdGhpcy5zZW5kUmVzdWx0KHJlcywgaWQsIHt9KTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgTUNQTWV0aG9kcy5UT09MU19MSVNUOlxuICAgICAgICAgICAgICAgIHRoaXMuaGFuZGxlVG9vbHNMaXN0KGlkLCByZXMpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSBNQ1BNZXRob2RzLlRPT0xTX0NBTEw6XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5oYW5kbGVUb29sc0NhbGwoaWQsIHBhcmFtcywgcmVzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgTUNQTWV0aG9kcy5SRVNPVVJDRVNfTElTVDpcbiAgICAgICAgICAgICAgICB0aGlzLnNlbmRSZXN1bHQocmVzLCBpZCwgeyByZXNvdXJjZXM6IFtdIH0pO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSBNQ1BNZXRob2RzLlBST01QVFNfTElTVDpcbiAgICAgICAgICAgICAgICB0aGlzLnNlbmRSZXN1bHQocmVzLCBpZCwgeyBwcm9tcHRzOiBbXSB9KTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhpcy5zZW5kRXJyb3IocmVzLCBpZCwgTUNQRXJyb3JDb2RlLk1ldGhvZE5vdEZvdW5kLCBg5pyq55+l5pa55rOVOiAke21ldGhvZH1gKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IE1DUCDmlrnms5XlpITnkIblmaggPT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8qKiBBSSDkvb/nlKjor7TmmI7kuaYg4oCUIOazqOWFpSBzeXN0ZW0gcHJvbXB0IOaMh+WvvOW3peWFt+mAieaLqSAqL1xuICAgIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IFNFUlZFUl9JTlNUUlVDVElPTlMgPSBgIyBDb2NvcyBDcmVhdG9yIE1DUCDigJQg57yW6L6R5Zmo6Ieq5Yqo5YyW5bel5YW36ZuGIChtY3BfZ2FtZSlcblxuIyMg5bel5YW36YCJ5oup5oyH5Y2XXG5cbiMjIyDlnLrmma/nvJbovpEgKHNjZW5lKVxuLSAqKuWcuuaZr+eUn+WRveWRqOacnyoqIOKGkiBcXGBzY2VuZS9vcGVuX3NjZW5lXFxg44CBXFxgc2NlbmUvc2F2ZV9zY2VuZVxcYOOAgVxcYHNjZW5lL2Nsb3NlX3NjZW5lXFxg44CBXFxgc2NlbmUvY3JlYXRlX3NjZW5lXFxg44CBXFxgc2NlbmUvY3JlYXRlX2RlZmF1bHRfMmRfc2NlbmVcXGBcbi0gKirlnLrmma/mn6Xor6IqKiDihpIgXFxgc2NlbmUvcXVlcnlfY3VycmVudF9zY2VuZVxcYOOAgVxcYHNjZW5lL3F1ZXJ5X25vZGVfdHJlZVxcYOOAgVxcYHNjZW5lL2dldF9zY2VuZV9oaWVyYXJjaHlcXGDjgIFcXGBzY2VuZS9xdWVyeV9zY2VuZV9qc29uXFxgXG4tICoq6IqC54K55pON5L2cKiog4oaSIFxcYHNjZW5lL2dldF9hbGxfbm9kZXNcXGDjgIFcXGBzY2VuZS9maW5kX25vZGVfYnlfbmFtZVxcYOOAgVxcYHNjZW5lL2NyZWF0ZV9ub2RlXFxg44CBXFxgc2NlbmUvZGVsZXRlX25vZGVcXGDjgIFcXGBzY2VuZS9kdXBsaWNhdGVfbm9kZVxcYOOAgVxcYHNjZW5lL21vdmVfbm9kZVxcYOOAgVxcYHNjZW5lL3NldF9ub2RlX3Byb3BlcnR5XFxg44CBXFxgc2NlbmUvc2V0X25vZGVfdHJhbnNmb3JtXFxgXG4tICoq57uE5Lu25pON5L2cKiog4oaSIFxcYHNjZW5lL2FkZF9jb21wb25lbnRcXGDjgIFcXGBzY2VuZS9yZW1vdmVfY29tcG9uZW50XFxg44CBXFxgc2NlbmUvc2V0X2NvbXBvbmVudF9wcm9wZXJ0eVxcYOOAgVxcYHNjZW5lL3F1ZXJ5X2NvbXBvbmVudFxcYOOAgVxcYHNjZW5lL3F1ZXJ5X2NvbXBvbmVudHNcXGBcbi0gKirkvr/mjbfliJvlu7oqKiDihpIgXFxgc2NlbmUvY3JlYXRlX3Nwcml0ZV9ub2RlXFxg44CBXFxgc2NlbmUvY3JlYXRlX2xhYmVsX25vZGVcXGDjgIFcXGBzY2VuZS9jcmVhdGVfYnV0dG9uX25vZGVcXGBcbi0gKirmibnph4/mk43kvZwqKiDihpIgXFxgc2NlbmUvYmF0Y2hfcmVuYW1lXFxg44CBXFxgc2NlbmUvZmluZF9hbmRfc2V0XFxgXG5cbiMjIyDotYTmupDnrqHnkIYgKGFzc2V0KVxuLSAqKuafpeivoioqIOKGkiBcXGBhc3NldC9xdWVyeV9hc3NldHNcXGDjgIFcXGBhc3NldC9xdWVyeV9hc3NldF9pbmZvXFxg44CBXFxgYXNzZXQvcXVlcnlfdXVpZFxcYOOAgVxcYGFzc2V0L3F1ZXJ5X3BhdGhcXGDjgIFcXGBhc3NldC9xdWVyeV91cmxcXGBcbi0gKirmk43kvZwqKiDihpIgXFxgYXNzZXQvY3JlYXRlX2Fzc2V0XFxg44CBXFxgYXNzZXQvaW1wb3J0X2Fzc2V0XFxg44CBXFxgYXNzZXQvY29weV9hc3NldFxcYOOAgVxcYGFzc2V0L21vdmVfYXNzZXRcXGDjgIFcXGBhc3NldC9kZWxldGVfYXNzZXRcXGDjgIFcXGBhc3NldC9zYXZlX2Fzc2V0XFxg44CBXFxgYXNzZXQvcmVmcmVzaF9hc3NldFxcYFxuXG4jIyMg6aKE5Yi25Lu2IChwcmVmYWIpXG4tICoq5pON5L2cKiog4oaSIFxcYHByZWZhYi9nZXRfcHJlZmFiX2xpc3RcXGDjgIFcXGBwcmVmYWIvZ2V0X3ByZWZhYl9pbmZvXFxg44CBXFxgcHJlZmFiL2luc3RhbnRpYXRlX3ByZWZhYlxcYOOAgVxcYHByZWZhYi9jcmVhdGVfcHJlZmFiXFxg44CBXFxgcHJlZmFiL2R1cGxpY2F0ZV9wcmVmYWJcXGDjgIFcXGBwcmVmYWIvYmF0Y2hfaW5zdGFudGlhdGVcXGBcblxuIyMjIOmhueebri/mnoTlu7ogKHByb2plY3QpXG4tICoq6YWN572uKiog4oaSIFxcYHByb2plY3QvcXVlcnlfcHJvamVjdF9jb25maWdcXGDjgIFcXGBwcm9qZWN0L3NldF9wcm9qZWN0X2NvbmZpZ1xcYOOAgVxcYHByb2plY3QvcXVlcnlfZGVzaWduX3Jlc29sdXRpb25cXGBcbi0gKirpooTop4gqKiDihpIgXFxgcHJvamVjdC9zdGFydF9wcmV2aWV3XFxg44CBXFxgcHJvamVjdC9yZWZyZXNoX3ByZXZpZXdcXGDjgIFcXGBwcm9qZWN0L3F1ZXJ5X3ByZXZpZXdfdXJsXFxgXG4tICoq5p6E5bu6Kiog4oaSIFxcYHByb2plY3QvY29tbWFuZF9idWlsZFxcYOOAgVxcYHByb2plY3Qvb3Blbl9idWlsZF9wYW5lbFxcYOOAgVxcYHByb2plY3QvcXVlcnlfYnVpbGRfd29ya2VyX3JlYWR5XFxgXG5cbiMjIyDliqjnlLvnvJbovpEgKGFuaW1hdGlvbikg4q2Q5pawXG4tICoq5p+l6K+iKiog4oaSIFxcYGFuaW1hdGlvbi9xdWVyeV9lZGl0X2luZm9cXGDjgIFcXGBhbmltYXRpb24vcXVlcnlfY2xpcHNfaW5mb1xcYOOAgVxcYGFuaW1hdGlvbi9xdWVyeV9jbGlwXFxg44CBXFxgYW5pbWF0aW9uL3F1ZXJ5X2NsaXBfZHVtcFxcYFxuLSAqKuWFs+mUruW4pyoqIOKGkiBcXGBhbmltYXRpb24vY3JlYXRlX2tleVxcYOOAgVxcYGFuaW1hdGlvbi91cGRhdGVfa2V5XFxg44CBXFxgYW5pbWF0aW9uL3JlbW92ZV9rZXlcXGDjgIFcXGBhbmltYXRpb24vY3JlYXRlX3Byb3BcXGDjgIFcXGBhbmltYXRpb24vcmVtb3ZlX3Byb3BcXGBcbi0gKirkuovku7YqKiDihpIgXFxgYW5pbWF0aW9uL2FkZF9ldmVudFxcYOOAgVxcYGFuaW1hdGlvbi9kZWxldGVfZXZlbnRcXGDjgIFcXGBhbmltYXRpb24vdXBkYXRlX2V2ZW50XFxg44CBXFxgYW5pbWF0aW9uL2JhdGNoX2V2ZW50c1xcYFxuLSAqKumihOiuvioqIOKGkiBcXGBhbmltYXRpb24vcHJlc2V0X2xpc3RcXGDjgIFcXGBhbmltYXRpb24vcHJlc2V0XFxg77yI5pSv5oyBIDEzIOenjemihOiuvu+8iVxuLSAqKuWxnuaApyoqIOKGkiBcXGBhbmltYXRpb24vY2hhbmdlX3NhbXBsZVxcYOOAgVxcYGFuaW1hdGlvbi9jaGFuZ2Vfc3BlZWRcXGDjgIFcXGBhbmltYXRpb24vY2hhbmdlX3dyYXBfbW9kZVxcYFxuXG4jIyMg5qCH562+L+Wtl+S9kyAobGFiZWwpIOKtkOaWsFxuLSAqKuaTjeS9nCoqIOKGkiBcXGBsYWJlbC9zZXRfdGV4dFxcYOOAgVxcYGxhYmVsL3NldF9mb250XFxg44CBXFxgbGFiZWwvc2V0X2ZvbnRfZmFtaWx5XFxg44CBXFxgbGFiZWwvc2V0X3N0eWxlXFxg44CBXFxgbGFiZWwvc2V0X291dGxpbmVcXGDjgIFcXGBsYWJlbC9zZXRfc2hhZG93XFxgXG4tICoq5om56YePKiog4oaSIFxcYGxhYmVsL2JhdGNoX3NldF9mb250XFxg44CBXFxgbGFiZWwvYmF0Y2hfc2V0X3N0eWxlXFxgXG5cbiMjIyBTcGluZSDpqqjpqrzliqjnlLsgKHNwaW5lKSDirZDmlrBcbi0gKirmk43kvZwqKiDihpIgXFxgc3BpbmUvbGlzdF9hbmltYXRpb25zXFxg44CBXFxgc3BpbmUvbGlzdF9za2luc1xcYOOAgVxcYHNwaW5lL3NldF9hbmltYXRpb25cXGDjgIFcXGBzcGluZS9zZXRfc2tpblxcYOOAgVxcYHNwaW5lL3NldF9wcm9wZXJ0eVxcYOOAgVxcYHNwaW5lL3NldF9kYXRhXFxg44CBXFxgc3BpbmUvYWRkX3NvY2tldFxcYOOAgVxcYHNwaW5lL3JlbW92ZV9zb2NrZXRcXGBcblxuIyMjIOinhuWPo+aOp+WItiAodmlldykg4q2Q5pawXG4tICoqR2l6bW8qKiDihpIgXFxgdmlldy9naXptb190b29sXFxg44CBXFxgdmlldy9naXptb19waXZvdFxcYOOAgVxcYHZpZXcvZ2l6bW9fY29vcmRpbmF0ZVxcYFxuLSAqKuinhuWbvioqIOKGkiBcXGB2aWV3L21vZGVfMmRfM2RcXGDjgIFcXGB2aWV3L2dyaWRfc2V0XFxg44CBXFxgdmlldy9jYW1lcmFfZm9jdXNcXGDjgIFcXGB2aWV3L2NhbWVyYV9hbGlnbl92aWV3XFxg44CBXFxgdmlldy9yZXNldF92aWV3XFxgXG4tICoq5Y+C6ICD5Zu+Kiog4oaSIFxcYHZpZXcvcmVmX2FkZFxcYOOAgVxcYHZpZXcvcmVmX3JlbW92ZVxcYOOAgVxcYHZpZXcvcmVmX2xpc3RcXGDjgIFcXGB2aWV3L3JlZl9wb3NpdGlvblxcYCDnrYlcblxuIyMjIOWcuuaZr+aehOW7uuWZqCAoYnVpbGRlcikg4q2Q5pawXG4tIFxcYGJ1aWxkZXIvYnVpbGRcXGAg4oCUIOS7jiBKU09OIOWumuS5ieS4gOmUruWIm+W7uuWujOaVtOiKgueCueagke+8iOmAkuW9kuW1jOWll+OAgee7hOS7tuOAgeWxnuaAp++8iVxuXG4jIyMg5Zy65pmv5b+r54WnIChjYXB0dXJlKSDirZDmlrBcbi0gXFxgY2FwdHVyZS9zY2VuZV9zbmFwc2hvdFxcYCDigJQg5a6M5pW05Zy65pmv5biD5bGAIEpTT05cbi0gXFxgY2FwdHVyZS9ub2RlX3NuYXBzaG90XFxgIOKAlCDmjIflrproioLngrnlrZDmoJHlv6vnhadcblxuIyMjIFVJIOaooeadvyAodGVtcGxhdGUpIOKtkOaWsFxuLSBcXGB0ZW1wbGF0ZS9saXN0XFxg44CBXFxgdGVtcGxhdGUvYXBwbHlcXGAg4oCUIGRpYWxvZyAvIHNjcm9sbF9saXN0IC8gbmF2X2JhciAvIHNldHRpbmdzX3BhZ2VcblxuIyMjIOefpeivhuW6kyAoa25vd2xlZGdlKSDirZDmlrBcbi0gKirmn6Xor6IqKiDihpIgXFxga25vd2xlZGdlL2tub3dsZWRnZV9saXN0X3RvcGljc1xcYOOAgVxcYGtub3dsZWRnZS9rbm93bGVkZ2VfcXVlcnlcXGDjgIFcXGBrbm93bGVkZ2Uva25vd2xlZGdlX3NlYXJjaFxcYFxuLSAqKue7hOS7tioqIOKGkiBcXGBrbm93bGVkZ2Uva25vd2xlZGdlX2NvbXBvbmVudF9wcm9wc1xcYOOAgVxcYGtub3dsZWRnZS9rbm93bGVkZ2VfYW5pbWF0aW9uX3BhdHRlcm5cXGDjgIFcXGBrbm93bGVkZ2Uva25vd2xlZGdlX2xheW91dF9wYXR0ZXJuXFxgXG4tICoq5p625p6EKiog4oaSIFxcYGtub3dsZWRnZS9rbm93bGVkZ2Vfbm9kZV9zdHJ1Y3R1cmVcXGDjgIFcXGBrbm93bGVkZ2Uva25vd2xlZGdlX3dpZGdldF9zdHJhdGVnaWVzXFxg44CBXFxga25vd2xlZGdlL2tub3dsZWRnZV9iZXN0X3ByYWN0aWNlXFxgXG5cbiMjIyDosIPor5Uv6K+K5patIChkZWJ1Zylcbi0gKirmjqfliLblj7AqKiDihpIgXFxgZGVidWcvc3RhcnRfY29uc29sZV9jYXB0dXJlXFxg44CBXFxgZGVidWcvc3RvcF9jb25zb2xlX2NhcHR1cmVcXGDjgIFcXGBkZWJ1Zy9nZXRfY29uc29sZV9sb2dzXFxgXG4tICoq57uf6K6hKiog4oaSIFxcYGRlYnVnL2dldF9zY2VuZV9zdGF0c1xcYOOAgVxcYGRlYnVnL2dldF9jb21wb25lbnRfc3RhdHNcXGBcbi0gKiror4rmlq0qKiDihpIgXFxgZGVidWcvZ2V0X2VkaXRvcl9zdGF0dXNcXGDjgIFcXGBkZWJ1Zy9nZXRfZW52aXJvbm1lbnRfaW5mb1xcYFxuXG4jIyMg5qCh6aqMICh2YWxpZGF0aW9uKVxuLSAqKuWcuuaZryoqIOKGkiBcXGB2YWxpZGF0aW9uL3ZhbGlkYXRlX3NjZW5lXFxg44CBXFxgdmFsaWRhdGlvbi9xdWlja192YWxpZGF0ZVxcYFxuLSAqKuiKgueCuSoqIOKGkiBcXGB2YWxpZGF0aW9uL2RpYWdub3NlX25vZGVcXGBcbi0gKirpooTliLbku7YqKiDihpIgXFxgdmFsaWRhdGlvbi92YWxpZGF0ZV9wcmVmYWJfaW5zdGFuY2VzXFxg44CBXFxgdmFsaWRhdGlvbi92YWxpZGF0ZV9wcmVmYWJfZm9ybWF0XFxgXG5cbiMjIyDlub/mkq0gKGJyb2FkY2FzdClcbi0gKirmk43kvZwqKiDihpIgXFxgYnJvYWRjYXN0L3NvZnRfcmVsb2FkXFxg44CBXFxgYnJvYWRjYXN0L3JlZnJlc2hfcHJldmlld1xcYOOAgVxcYGJyb2FkY2FzdC9icm9hZGNhc3Rfbm90aWZpY2F0aW9uXFxg44CBXFxgYnJvYWRjYXN0L2VkaXRvcl9ub3RpZnlcXGBcblxuLS0tXG5cbiMjIPCfk5og55+l6K+G6YCf5p+lICjmt7flkIjmqKHlvI/vvJror6bmg4XnlKgga25vd2xlZGdlLyog5bel5YW35p+l6K+iKVxuXG4jIyMg5a2X5Y+36KeE6IyDXG7moIfpopggMzItNDAsIOato+aWhyAyNC0yOCwg5qCH5rOoIDE4LTIyLCDmjInpkq4gMjQtMzJcblxuIyMjIOmXtOi3neinhOiMg1xu5qCH5YeG6Ze06LedOiA4LCAxNiwgMjQsIDMyLCA0OCAoOCDnmoTlgI3mlbAp44CC5bGP5bmV6L6557yYOiAxNi0yNHB4XG5cbiMjIyDop6bmkbjnm67moIdcbuacgOWwjyA0NHg0NCDngrkgKDg4eDg4IEAyeClcblxuIyMjIOaMiemSruWwuuWvuFxu5bCPIDEyMHg0NCwg5LitIDIwMHg2MCwg5aSnIDMwMHg4MFxuXG4jIyMg5Yqo55S75pe26ZW/XG5VSSDov4fmuKEgMC4yLTAuM3Mg5pyA5pWP5o23XG5cbiMjIyDluLjnlKjnvJPliqhcbmJhY2tPdXQgKOW8ueWFpSksIGN1YmljT3V0ICjlubPmu5Hlh4/pgJ8pLCBlbGFzdGljT3V0ICjlvLnnsKcpXG5cbiMjIyAxMyDkuKrliqjnlLvpooTorr5cbmZhZGVfaW4sIGZhZGVfb3V0LCBzY2FsZV9ib3VuY2UsIHNjYWxlX2Nsb3NlLCBzbGlkZV9pbl9ib3R0b20sIHNsaWRlX2luX3JpZ2h0LCBzaGFrZSwgcHVsc2UsIGZsb2F0LCB0eXBld3JpdGVyLCBudW1iZXJfcm9sbCwgZmxpcF9jYXJkLCBjb21ib19zZXF1ZW5jZVxuXG4jIyMgMTIg5LiqIFVJIOW4g+WxgOaooeadv1xuZGlhbG9nLCBzY3JvbGxfbGlzdCwgdGFiX2JhciwgaHVkLCBsb2dpbiwgc2V0dGluZ3MsIGdyaWRfaW52ZW50b3J5LCBsZWFkZXJib2FyZCwgbG9hZGluZywgdG9hc3QsIHNob3AsIGxldmVsX3NlbGVjdFxuXG4jIyMgNyDkuKrnu4Tku7blsZ7mgKfmqKHmnb9cbmNjLlNwcml0ZSwgY2MuTGFiZWwsIGNjLkJ1dHRvbiwgY2MuV2lkZ2V0LCBjYy5MYXlvdXQsIGNjLlNjcm9sbFZpZXcsIGNjLkVkaXRCb3hcblxuIyMjIOacgOS9s+Wunui3teexu+WIq1xucGVyZm9ybWFuY2UsIG11bHRpX3Jlc29sdXRpb24sIHNjZW5lX21hbmFnZW1lbnQsIGlucHV0X2hhbmRsaW5nLCBtZW1vcnlfbWFuYWdlbWVudCwgYXVkaW8sIGFuaW1hdGlvbl90aXBzLCB1aV9hcmNoaXRlY3R1cmVcblxuLS0tXG5cbiMjIOW4uOeUqOW3peS9nOa1gVxuXG4xLiDlhYjosIMgXFxgY2FwdHVyZS9zY2VuZV9zbmFwc2hvdFxcYCDmiJYgXFxgc2NlbmUvcXVlcnlfY3VycmVudF9zY2VuZVxcYCDojrflj5blvZPliY3lnLrmma/kv6Hmga9cbjIuIOWGjeeUqCBcXGBzY2VuZS9xdWVyeV9ub2RlX3RyZWU/aW5jbHVkZUNvbXBvbmVudHM9dHJ1ZVxcYCDmiJYgXFxgc2NlbmUvZ2V0X3NjZW5lX2hpZXJhcmNoeVxcYCDmn6XnnIvoioLngrnlsYLnuqdcbjMuIOWIm+W7uuiKgueCueWJjeWFiCBcXGBzY2VuZS9nZXRfYWxsX25vZGVzXFxgIOehruiupOeItuiKgueCuSBVVUlEXG40LiDkv67mlLnlkI7osIMgXFxgc2NlbmUvc2F2ZV9zY2VuZVxcYCDkv53lrZhcbjUuIOWkjeadgiBVSSDnlKggXFxgYnVpbGRlci9idWlsZFxcYCDku44gSlNPTiDlrprkuYnnm7TmjqXmnoTlu7pcbjYuIOmihOWItuS7tuWunuS+i+WMlueUqCBcXGBwcmVmYWIvaW5zdGFudGlhdGVfcHJlZmFiXFxg77yM5om56YeP55SoIFxcYHByZWZhYi9iYXRjaF9pbnN0YW50aWF0ZVxcYFxuNy4g5Yqo55S755SoIFxcYGFuaW1hdGlvbi9wcmVzZXRcXGDvvIh3cml0ZU1vZGU6XCJmaWxlXCIg5YWN57yW6L6R5qih5byP77yJXG44LiDlnLrmma/liIbmnpDnlKggXFxgY2FwdHVyZS9zY2VuZV9zbmFwc2hvdFxcYFxuOS4g55+l6K+G5p+l6K+i55SoIFxcYGtub3dsZWRnZS9rbm93bGVkZ2VfcXVlcnlcXGAgKyDkuLvpopjlkI1cblxuIyMg5pyA5L2z5a6e6Le1XG5cbi0g5om+6IqC54K55LyY5YWI55SoIFxcYHNjZW5lL2ZpbmRfbm9kZV9ieV9uYW1lXFxgXG4tIOiuvue9riBMYWJlbCDmlofmnKznlKggXFxgc2NlbmUvc2V0X2NvbXBvbmVudF9wcm9wZXJ0eVxcYO+8iHByb3BlcnR5OiBcInN0cmluZ1wi77yJXG4tIOiuvue9riBTcHJpdGUg5Zu+54mH55SoIFxcYHNjZW5lL3NldF9jb21wb25lbnRfcHJvcGVydHlcXGDvvIhwcm9wZXJ0eTogXCJzcHJpdGVGcmFtZVwiLCB2YWx1ZTogXCJcXCR7dXVpZH1cIu+8iVxuLSDmibnph4/lrp7kvovljJbnlKggXFxgcHJlZmFiL2JhdGNoX2luc3RhbnRpYXRlXFxgXG4tIOaehOW7uuWJjeiwgyBcXGBwcm9qZWN0L3F1ZXJ5X2J1aWxkX3dvcmtlcl9yZWFkeVxcYCDnoa7orqTmnoTlu7rlsLHnu6pcbi0g5L2/55SoIFxcYGdldF9jYXBhYmlsaXRpZXNcXGAg5oyJ6ZyA5Yqg6L295bel5YW355qE5a6M5pW05Y+C5pWw6K+05piOXG4tIOWPguaVsOaUr+aMgSBcXGBzbmFrZV9jYXNlXFxgIOWSjCBcXGBjYW1lbENhc2VcXGAg5Y+M5qC85byPXG5cbiMjIFVJIOWxgue6p+inhOiMg1xuQmFja2dyb3VuZCDihpIgR2FtZUxheWVyIOKGkiBVSUxheWVyIOKGkiBQb3B1cExheWVyIOKGkiBUb2FzdExheWVyXG5cbiMjIOazqOaEj+S6i+mhuVxuLSDnpoHmraLnm7TmjqXnvJbovpEgLnNjZW5lLy5wcmVmYWIvLmFuaW0vLm1ldGEg5paH5Lu277yM5Y+q6IO96YCa6L+HIE1DUCDmjqXlj6Pmk43kvZxcbi0g57uT5p6c5LiN5q2j56Gu5pe277yM5YWI5qOA5p+l5Y+C5pWw77yM5YaN5qOA5p+l5o6l5Y+jXG4tIOWIm+W7uuWcuuaZry/pooTliLbku7Yv55WM6Z2i5pe277yM5YaF6YOo57uT5p6E5Lmf5b+F6aG76YCa6L+HIE1DUCDliJvlu7pcbi0g5Yqo55S76aKE6K6+5L2/55SoIHdyaXRlTW9kZTpcImZpbGVcIiDlj6/nm7TmjqXlhpnlhaXmlofku7bnu5Xov4fnvJbovpHmqKHlvI/pmZDliLZcbmA7XG5cbiAgICBwcml2YXRlIGhhbmRsZUluaXRpYWxpemUoaWQ6IG51bWJlciB8IHN0cmluZywgcGFyYW1zOiBhbnksIHJlczogaHR0cC5TZXJ2ZXJSZXNwb25zZSk6IHZvaWQge1xuICAgICAgICBjb25zdCByZXN1bHQ6IEluaXRpYWxpemVSZXN1bHQgPSB7XG4gICAgICAgICAgICBwcm90b2NvbFZlcnNpb246ICcyMDI0LTExLTA1JyxcbiAgICAgICAgICAgIGNhcGFiaWxpdGllczoge1xuICAgICAgICAgICAgICAgIHRvb2xzOiB7fSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IHt9LFxuICAgICAgICAgICAgICAgIHByb21wdHM6IHt9LFxuICAgICAgICAgICAgICAgIGxvZ2dpbmc6IHt9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHNlcnZlckluZm86IHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnY29jb3MtY3JlYXRvci1tY3AnLFxuICAgICAgICAgICAgICAgIHZlcnNpb246ICcxLjAuMCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgaW5zdHJ1Y3Rpb25zOiBNQ1BTZXJ2ZXIuU0VSVkVSX0lOU1RSVUNUSU9OUyxcbiAgICAgICAgfTtcbiAgICAgICAgdGhpcy5zZW5kUmVzdWx0KHJlcywgaWQsIHJlc3VsdCk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0gdG9vbHMvbGlzdCDigJQg6L+U5Zue6L276YeP5YWl5Y+j5bel5YW3ID09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvKiog5YaF572u5YWl5Y+j5bel5YW35a6a5LmJ77yI5aeL57uI5Y+v55So77yM5LiN5L6d6LWW5qih5Z2X5rOo5YaM77yJICovXG4gICAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgRU5UUllfVE9PTFM6IFRvb2xEZWZpbml0aW9uW10gPSBbXG4gICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICdnZXRfY2FwYWJpbGl0aWVzJyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn6L+U5ZueIGdvZG90LWRldnRvb2wg6aOO5qC855qE5bel5YW355uu5b2V44CC6buY6K6k6L+U5Zue6L276YeP5YiG57G75pGY6KaB77yb5LygIHRvb2xOYW1lcy9tb2R1bGVOYW1lcyDov4fmu6QgKyBpbmNsdWRlU2NoZW1hcz10cnVlIOWPr+iOt+WPluWujOaVtCBpbnB1dFNjaGVtYeOAgui/meaYr+WPkeeOsOaJgOacieWPr+eUqOW3peWFt+eahOWFpeWPo+OAgicsXG4gICAgICAgICAgICBpbnB1dFNjaGVtYToge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgdG9vbE5hbWVzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn6KaB5p+l6K+i55qE5bel5YW35ZCN5YiX6KGo77yISlNPTiDmlbDnu4TlrZfnrKbkuLLvvIzlpoIgW1wic2NlbmUvcXVlcnlfbm9kZV90cmVlXCIsXCJhc3NldC9xdWVyeV9hc3NldHNcIl3vvIknLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBtb2R1bGVOYW1lczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+imgeafpeivoueahOaooeWdl+WQjeWIl+ihqO+8iEpTT04g5pWw57uE5a2X56ym5Liy77yM5aaCIFtcInNjZW5lXCIsXCJwcm9qZWN0XCJd77yJJyxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZVNjaGVtYXM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICfmmK/lkKbljIXlkKvlrozmlbQgaW5wdXRTY2hlbWHvvIzkvKDlhaUgXCJ0cnVlXCIg5Y2z5YyF5ZCr77yI6buY6K6k5LiN5YyF5ZCr5Lul6IqC55yBIHRva2Vu77yJJyxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogJ19tZXRhL2NhdGVnb3JpZXMnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICflt6XlhbfliIbnsbvlhYPmlbDmja7vvJrmjInmqKHlnZfliIbnu4TnmoTlt6XlhbfmpoLop4jvvIzkuI3lkKsgaW5wdXRTY2hlbWHvvIjoioLnnIEgdG9rZW7vvIknLFxuICAgICAgICB9LFxuICAgIF07XG5cbiAgICBwcml2YXRlIGhhbmRsZVRvb2xzTGlzdChpZDogbnVtYmVyIHwgc3RyaW5nLCByZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UpOiB2b2lkIHtcbiAgICAgICAgLy8gdG9vbHMvbGlzdCDlj6rov5Tlm57lhaXlj6Plt6XlhbfvvIzpgb/lhY3kuIDmrKHmgKfmmrTpnLLmiYDmnIkgc2NoZW1hIOeDpyB0b2tlblxuICAgICAgICB0aGlzLnNlbmRSZXN1bHQocmVzLCBpZCwgeyB0b29sczogTUNQU2VydmVyLkVOVFJZX1RPT0xTIH0pO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IHRvb2xzL2NhbGwg4oCUIOWGhee9riArIOWnlOa0viA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgcHJpdmF0ZSBhc3luYyBoYW5kbGVUb29sc0NhbGwoXG4gICAgICAgIGlkOiBudW1iZXIgfCBzdHJpbmcsXG4gICAgICAgIHBhcmFtczogYW55LFxuICAgICAgICByZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UsXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGlmICghcGFyYW1zPy5uYW1lKSB7XG4gICAgICAgICAgICB0aGlzLnNlbmRFcnJvcihyZXMsIGlkLCBNQ1BFcnJvckNvZGUuSW52YWxpZFBhcmFtcywgJ+e8uuWwkeW3peWFt+WQjeensCcpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdG9vbE5hbWUgPSBTdHJpbmcocGFyYW1zLm5hbWUpO1xuXG4gICAgICAgIC8vID09PSDlhoXnva7lt6XlhbfvvJpnZXRfY2FwYWJpbGl0aWVzID09PVxuICAgICAgICBpZiAodG9vbE5hbWUgPT09ICdnZXRfY2FwYWJpbGl0aWVzJykge1xuICAgICAgICAgICAgY29uc3QgYXJncyA9IE1DUFNlcnZlci5ub3JtYWxpemVQYXJhbXMocGFyYW1zLmFyZ3VtZW50cyB8fCB7fSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZUdldENhcGFiaWxpdGllcyhhcmdzLCByZXMsIGlkKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vID09PSDlhoXnva7lt6XlhbfvvJpfbWV0YS9jYXRlZ29yaWVzID09PVxuICAgICAgICBpZiAodG9vbE5hbWUgPT09ICdfbWV0YS9jYXRlZ29yaWVzJykge1xuICAgICAgICAgICAgdGhpcy5oYW5kbGVDYXRlZ29yaWVzKHJlcywgaWQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gPT09IOWFtuS9meW3peWFt++8muWnlOa0viBNb2R1bGVMb2FkZXIgPT09XG4gICAgICAgIGNvbnN0IGFyZ3MgPSBNQ1BTZXJ2ZXIubm9ybWFsaXplUGFyYW1zKHBhcmFtcy5hcmd1bWVudHMgfHwge30pO1xuXG4gICAgICAgIC8vIOS7juW3peWFt+WFqOWQjeS4reaPkOWPluaooeWdl+WQje+8iOagvOW8jzogbW9kdWxlTmFtZS90b29sTmFtZSDmiJbnm7TmjqUgdG9vbE5hbWXvvIlcbiAgICAgICAgbGV0IG1vZHVsZU5hbWUgPSAnJztcbiAgICAgICAgbGV0IG1ldGhvZE5hbWUgPSB0b29sTmFtZTtcblxuICAgICAgICBpZiAodG9vbE5hbWUuaW5jbHVkZXMoJy8nKSkge1xuICAgICAgICAgICAgW21vZHVsZU5hbWUsIG1ldGhvZE5hbWVdID0gdG9vbE5hbWUuc3BsaXQoJy8nLCAyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIOWcqOaJgOacieWQr+eUqOeahOaooeWdl+S4reaQnOe0ouivpeW3peWFt1xuICAgICAgICAgICAgY29uc3QgcmVnaXN0cnkgPSBNZXRhZGF0YVJlZ2lzdHJ5LmlucztcbiAgICAgICAgICAgIGZvciAoY29uc3QgbW9kIG9mIHJlZ2lzdHJ5LmdldE1vZHVsZXMoKSkge1xuICAgICAgICAgICAgICAgIGlmICghbW9kLmVuYWJsZWQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGlmIChtb2QudG9vbHMuc29tZSh0ID0+IHQubmFtZSA9PT0gbWV0aG9kTmFtZSAmJiB0LmVuYWJsZWQpKSB7XG4gICAgICAgICAgICAgICAgICAgIG1vZHVsZU5hbWUgPSBtb2QubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFtb2R1bGVOYW1lKSB7XG4gICAgICAgICAgICB0aGlzLnNlbmRSZXN1bHQocmVzLCBpZCwge1xuICAgICAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogYOW3peWFtyAnJHt0b29sTmFtZX0nIOS4jeWtmOWcqOaIluacquWQr+eUqGAgfV0sXG4gICAgICAgICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5Yqo5oCB5Yqg6L29IE1vZHVsZUxvYWRlciDmiafooYzlt6XlhbdcbiAgICAgICAgY29uc3QgeyBNb2R1bGVMb2FkZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9Nb2R1bGVMb2FkZXInKTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgTW9kdWxlTG9hZGVyLmlucy5oYW5kbGVUb29sQ2FsbChtb2R1bGVOYW1lLCBtZXRob2ROYW1lLCBhcmdzKTtcbiAgICAgICAgdGhpcy5zZW5kUmVzdWx0KHJlcywgaWQsIHJlc3VsdCk7XG5cbiAgICAgICAgLy8g5bm/5pKt5pel5b+XXG4gICAgICAgIHRoaXMuYnJvYWRjYXN0U1NFKCdtZXNzYWdlJywge1xuICAgICAgICAgICAganNvbnJwYzogJzIuMCcsXG4gICAgICAgICAgICBtZXRob2Q6ICdub3RpZmljYXRpb25zL21lc3NhZ2UnLFxuICAgICAgICAgICAgcGFyYW1zOiB7XG4gICAgICAgICAgICAgICAgbGV2ZWw6ICdpbmZvJyxcbiAgICAgICAgICAgICAgICBsb2dnZXI6ICdtY3AnLFxuICAgICAgICAgICAgICAgIGRhdGE6IGDlt6XlhbfosIPnlKg6ICR7bW9kdWxlTmFtZX0vJHttZXRob2ROYW1lfSgke0pTT04uc3RyaW5naWZ5KGFyZ3MpfSlgLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0gZ2V0X2NhcGFiaWxpdGllcyDlpITnkIblmaggPT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8qKlxuICAgICAqIOaMiemcgOiOt+WPluW3peWFt+ebruW9le+8iGdvZG90LWRldnRvb2wg6aOO5qC877yJ44CCXG4gICAgICog6buY6K6k6L+U5Zue6L276YeP5YiG57G75pGY6KaB77yb5Lyg6L+H5ruk5p2h5Lu2ICsgaW5jbHVkZVNjaGVtYXMg5Y+v6I635Y+W5a6M5pW06K+m5oOF44CCXG4gICAgICovXG4gICAgcHJpdmF0ZSBhc3luYyBoYW5kbGVHZXRDYXBhYmlsaXRpZXMoXG4gICAgICAgIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICByZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UsXG4gICAgICAgIGlkOiBudW1iZXIgfCBzdHJpbmcsXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGNvbnN0IHJlZ2lzdHJ5ID0gTWV0YWRhdGFSZWdpc3RyeS5pbnM7XG5cbiAgICAgICAgLy8g6Kej5p6Q6L+H5ruk5p2h5Lu2XG4gICAgICAgIGxldCB0b29sRmlsdGVyOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuICAgICAgICBsZXQgbW9kdWxlRmlsdGVyOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuICAgICAgICBjb25zdCBpbmNsdWRlU2NoZW1hcyA9IFN0cmluZyhhcmdzLmluY2x1ZGVTY2hlbWFzID8/ICcnKSA9PT0gJ3RydWUnO1xuXG4gICAgICAgIGlmIChhcmdzLnRvb2xOYW1lcykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICB0b29sRmlsdGVyID0gdHlwZW9mIGFyZ3MudG9vbE5hbWVzID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICAgICA/IEpTT04ucGFyc2UoYXJncy50b29sTmFtZXMpXG4gICAgICAgICAgICAgICAgICAgIDogYXJncy50b29sTmFtZXMgYXMgc3RyaW5nW107XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyog5b+955Wl6Kej5p6Q5aSx6LSlICovIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoYXJncy5tb2R1bGVOYW1lcykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBtb2R1bGVGaWx0ZXIgPSB0eXBlb2YgYXJncy5tb2R1bGVOYW1lcyA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAgICAgPyBKU09OLnBhcnNlKGFyZ3MubW9kdWxlTmFtZXMpXG4gICAgICAgICAgICAgICAgICAgIDogYXJncy5tb2R1bGVOYW1lcyBhcyBzdHJpbmdbXTtcbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiDlv73nlaXop6PmnpDlpLHotKUgKi8gfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8g5pS26ZuG5omA5pyJ5ZCv55So55qE5qih5Z2XICsg5bel5YW3XG4gICAgICAgIGNvbnN0IG1vZHVsZXMgPSByZWdpc3RyeS5nZXRFbmFibGVkTW9kdWxlcygpO1xuICAgICAgICBjb25zdCByZXN1bHRUb29sczogVG9vbERlZmluaXRpb25bXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN1bHRNb2R1bGVzOiB7IG5hbWU6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZzsgdG9vbENvdW50OiBudW1iZXIgfVtdID0gW107XG5cbiAgICAgICAgZm9yIChjb25zdCBtb2Qgb2YgbW9kdWxlcykge1xuICAgICAgICAgICAgaWYgKG1vZHVsZUZpbHRlciAmJiAhbW9kdWxlRmlsdGVyLmluY2x1ZGVzKG1vZC5uYW1lKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBlbmFibGVkVG9vbHMgPSBtb2QudG9vbHMuZmlsdGVyKHQgPT4gdC5lbmFibGVkKTtcbiAgICAgICAgICAgIHJlc3VsdE1vZHVsZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgbmFtZTogbW9kLm5hbWUsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246IG1vZC5kZXNjcmlwdGlvbixcbiAgICAgICAgICAgICAgICB0b29sQ291bnQ6IGVuYWJsZWRUb29scy5sZW5ndGgsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgZm9yIChjb25zdCB0IG9mIGVuYWJsZWRUb29scykge1xuICAgICAgICAgICAgICAgIGlmICh0b29sRmlsdGVyICYmICF0b29sRmlsdGVyLmluY2x1ZGVzKGAke21vZC5uYW1lfS8ke3QubmFtZX1gKSAmJiAhdG9vbEZpbHRlci5pbmNsdWRlcyh0Lm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaW5jbHVkZVNjaGVtYXMpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8g5a6M5pW0IHNjaGVtYVxuICAgICAgICAgICAgICAgICAgICBjb25zdCBkZWY6IFRvb2xEZWZpbml0aW9uID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogYCR7bW9kLm5hbWV9LyR7dC5uYW1lfWAsXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogdC5kZXNjcmlwdGlvbixcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHQucGFyYW1zU2NoZW1hKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWYuaW5wdXRTY2hlbWEgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydGllczogdC5wYXJhbXNTY2hlbWEgYXMgYW55LFxuICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXN1bHRUb29scy5wdXNoKGRlZik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy8g6L276YeP5p2h55uu77yI5LiN5ZCrIGlucHV0U2NoZW1h77yJXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFRvb2xzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogYCR7bW9kLm5hbWV9LyR7dC5uYW1lfWAsXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogdC5kZXNjcmlwdGlvbixcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zZW5kUmVzdWx0KHJlcywgaWQsIHtcbiAgICAgICAgICAgIHRvb2xzOiByZXN1bHRUb29scyxcbiAgICAgICAgICAgIG1vZHVsZXM6IHJlc3VsdE1vZHVsZXMsXG4gICAgICAgICAgICByb3V0ZUdyb3VwczogWydzY2VuZScsICdwcmVmYWInLCAnYXNzZXQnLCAncHJvamVjdCcsICdkZWJ1ZycsICdicm9hZGNhc3QnLCAndmFsaWRhdGlvbiddLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDlt6XlhbfliIbnsbvlhYPmlbDmja4gPT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8qKiDov5Tlm57mqKHlnZfliIbnu4TmpoLop4jvvIjkuI3lkKsgaW5wdXRTY2hlbWHvvIkgKi9cbiAgICBwcml2YXRlIGhhbmRsZUNhdGVnb3JpZXMocmVzOiBodHRwLlNlcnZlclJlc3BvbnNlLCBpZDogbnVtYmVyIHwgc3RyaW5nKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHJlZ2lzdHJ5ID0gTWV0YWRhdGFSZWdpc3RyeS5pbnM7XG4gICAgICAgIGNvbnN0IG1vZHVsZXMgPSByZWdpc3RyeS5nZXRFbmFibGVkTW9kdWxlcygpO1xuICAgICAgICBjb25zdCBjYXRlZ29yaWVzID0gbW9kdWxlcy5tYXAobW9kID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBtb2QubmFtZSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBtb2QuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICB0b29sczogbW9kLnRvb2xzLmZpbHRlcih0ID0+IHQuZW5hYmxlZCkubWFwKHQgPT4gKHtcbiAgICAgICAgICAgICAgICBuYW1lOiBgJHttb2QubmFtZX0vJHt0Lm5hbWV9YCxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogdC5kZXNjcmlwdGlvbixcbiAgICAgICAgICAgIH0pKSxcbiAgICAgICAgfSkpO1xuICAgICAgICB0aGlzLnNlbmRSZXN1bHQocmVzLCBpZCwgeyBjYXRlZ29yaWVzIH0pO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IEhUVFAg6L6F5YqpID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBwcml2YXRlIHJlYWRCb2R5KHJlcTogaHR0cC5JbmNvbWluZ01lc3NhZ2UpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgbGV0IGRhdGEgPSAnJztcbiAgICAgICAgICAgIHJlcS5vbignZGF0YScsIGNodW5rID0+IChkYXRhICs9IGNodW5rKSk7XG4gICAgICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoZGF0YSkpO1xuICAgICAgICAgICAgcmVxLm9uKCdlcnJvcicsIHJlamVjdCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHByaXZhdGUgc2VuZFJlc3VsdChyZXM6IGh0dHAuU2VydmVyUmVzcG9uc2UsIGlkOiBudW1iZXIgfCBzdHJpbmcgfCBudWxsLCByZXN1bHQ6IGFueSk6IHZvaWQge1xuICAgICAgICBjb25zdCByZXNwb25zZTogSlNPTlJQQ1Jlc3BvbnNlID0ge1xuICAgICAgICAgICAganNvbnJwYzogJzIuMCcsXG4gICAgICAgICAgICBpZDogaWQgYXMgbnVtYmVyIHwgc3RyaW5nLFxuICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICB9O1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHJlc3BvbnNlKSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBzZW5kRXJyb3IoXG4gICAgICAgIHJlczogaHR0cC5TZXJ2ZXJSZXNwb25zZSxcbiAgICAgICAgaWQ6IG51bWJlciB8IHN0cmluZyB8IG51bGwsXG4gICAgICAgIGNvZGU6IE1DUEVycm9yQ29kZSxcbiAgICAgICAgbWVzc2FnZTogc3RyaW5nLFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCBlcnJvcjogSlNPTlJQQ0Vycm9yID0ge1xuICAgICAgICAgICAganNvbnJwYzogJzIuMCcsXG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIGVycm9yOiB7IGNvZGUsIG1lc3NhZ2UgfSxcbiAgICAgICAgfTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShlcnJvcikpO1xuICAgIH1cbn1cbiJdfQ==