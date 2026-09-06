/**
 * MCP 装饰器 — 标记模块和工具，自动收集元数据
 *
 * 使用方式：
 *   @MCPModule('scene', '场景编辑')
 *   class SceneModule {
 *       @MCPTool('查询节点树', { nodeUuid?: string })
 *       queryNodeTree(params: { nodeUuid?: string }) { ... }
 *   }
 */

import { MetadataRegistry, ToolMeta } from './MetadataRegistry';

/** 存储方法装饰器暂存数据，key 为类原型 */
const pendingTools = new WeakMap<object, ToolMeta[]>();

/**
 * 类装饰器：标记一个 MCP 功能模块
 * @param name     模块唯一标识（如 'scene', 'asset'）
 * @param description 模块描述
 */
export function MCPModule(name: string, description: string): ClassDecorator {
    return function (target: any) {
        const registry = MetadataRegistry.ins;
        registry.registerModule(name, description, target);

        // 收集此前由 @MCPTool 暂存的方法元数据
        const tools = pendingTools.get(target.prototype) || [];
        for (const t of tools) {
            registry.registerTool(name, t.methodName, t.description, t.paramsSchema, t.methodFn);
        }
        pendingTools.delete(target.prototype);
    };
}

/**
 * 方法装饰器：标记一个可调用的 MCP 工具
 * @param description  工具描述
 * @param paramsSchema 参数 JSON Schema（可选，用于 MCP tools/list 展示）
 */
export function MCPTool(description: string, paramsSchema?: Record<string, unknown>): MethodDecorator {
    return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const methodName = String(propertyKey);
        const methodFn = descriptor.value!;

        const list = pendingTools.get(target) || [];
        list.push({ methodName, description, paramsSchema, methodFn });
        pendingTools.set(target, list);
    };
}
