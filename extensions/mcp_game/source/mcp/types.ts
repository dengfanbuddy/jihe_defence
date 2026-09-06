/**
 * MCP (Model Context Protocol) 类型定义
 * 基于 JSON-RPC 2.0 + MCP 2024-11-05 规范
 */

// ==================== JSON-RPC 2.0 ====================

/** JSON-RPC 2.0 请求 */
export interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: any;
}

/** JSON-RPC 2.0 响应（成功） */
export interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: number | string;
    result: any;
}

/** JSON-RPC 2.0 错误 */
export interface JSONRPCError {
    jsonrpc: '2.0';
    id: number | string | null;
    error: {
        code: number;
        message: string;
        data?: any;
    };
}

/** JSON-RPC 2.0 通知（无 id，不需要响应） */
export interface JSONRPCNotification {
    jsonrpc: '2.0';
    method: string;
    params?: any;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCError | JSONRPCNotification;

// ==================== MCP 标准错误码 ====================

export enum MCPErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    // MCP 特有
    ServerNotInitialized = -32002,
}

// ==================== MCP 协议类型 ====================

export interface Implementation {
    name: string;
    version: string;
}

export interface ClientCapabilities {
    roots?: { listChanged?: boolean };
    sampling?: Record<string, never>;
    experimental?: Record<string, any>;
}

export interface ServerCapabilities {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, never>;
    experimental?: Record<string, any>;
}

// ------ initialize ------

export interface InitializeRequest {
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: Implementation;
}

export interface InitializeResult {
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: Implementation;
    /** 注入 AI system prompt 的使用说明书（CodeGraph 首创的非标准扩展） */
    instructions?: string;
}

// ------ tools ------

/** MCP 工具的 JSON Schema 输入描述 */
export interface ToolInputSchema {
    type: 'object';
    properties: Record<string, {
        type: string;
        description?: string;
        default?: any;
        enum?: string[];
    }>;
    required?: string[];
}

/** MCP 工具定义（用于 tools/list 响应） */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema?: ToolInputSchema;
}

/** tools/call 请求参数 */
export interface ToolCallParams {
    name: string;
    arguments?: Record<string, unknown>;
}

/** tools/call 响应结果 */
export interface ToolCallResult {
    content: ToolResultContent[];
    isError?: boolean;
}

export interface ToolResultContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
}

// ------ resources ------

export interface ResourceDefinition {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface ReadResourceResult {
    contents: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    }[];
}

// ------ prompts ------

export interface PromptDefinition {
    name: string;
    description?: string;
    arguments?: PromptArgument[];
}

export interface PromptArgument {
    name: string;
    description?: string;
    required?: boolean;
}

// ------ logging ------

export interface LoggingMessageNotification {
    level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
    logger?: string;
    data: any;
}

// ==================== MCP 方法名 ====================

export const MCPMethods = {
    INITIALIZE: 'initialize',
    INITIALIZED: 'notifications/initialized',
    PING: 'ping',
    TOOLS_LIST: 'tools/list',
    TOOLS_CALL: 'tools/call',
    TOOLS_LIST_CHANGED: 'notifications/tools/list_changed',
    RESOURCES_LIST: 'resources/list',
    RESOURCES_READ: 'resources/read',
    PROMPTS_LIST: 'prompts/list',
    PROMPTS_GET: 'prompts/get',
    LOGGING_SET_LEVEL: 'logging/setLevel',
} as const;
