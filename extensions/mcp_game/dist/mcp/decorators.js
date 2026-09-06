"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPModule = MCPModule;
exports.MCPTool = MCPTool;
const MetadataRegistry_1 = require("./MetadataRegistry");
/** 存储方法装饰器暂存数据，key 为类原型 */
const pendingTools = new WeakMap();
/**
 * 类装饰器：标记一个 MCP 功能模块
 * @param name     模块唯一标识（如 'scene', 'asset'）
 * @param description 模块描述
 */
function MCPModule(name, description) {
    return function (target) {
        const registry = MetadataRegistry_1.MetadataRegistry.ins;
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
function MCPTool(description, paramsSchema) {
    return function (target, propertyKey, descriptor) {
        const methodName = String(propertyKey);
        const methodFn = descriptor.value;
        const list = pendingTools.get(target) || [];
        list.push({ methodName, description, paramsSchema, methodFn });
        pendingTools.set(target, list);
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVjb3JhdG9ycy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9tY3AvZGVjb3JhdG9ycy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7OztHQVNHOztBQVlILDhCQVlDO0FBT0QsMEJBU0M7QUF0Q0QseURBQWdFO0FBRWhFLDJCQUEyQjtBQUMzQixNQUFNLFlBQVksR0FBRyxJQUFJLE9BQU8sRUFBc0IsQ0FBQztBQUV2RDs7OztHQUlHO0FBQ0gsU0FBZ0IsU0FBUyxDQUFDLElBQVksRUFBRSxXQUFtQjtJQUN2RCxPQUFPLFVBQVUsTUFBVztRQUN4QixNQUFNLFFBQVEsR0FBRyxtQ0FBZ0IsQ0FBQyxHQUFHLENBQUM7UUFDdEMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBRW5ELDBCQUEwQjtRQUMxQixNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDdkQsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUNwQixRQUFRLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDekYsQ0FBQztRQUNELFlBQVksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzFDLENBQUMsQ0FBQztBQUNOLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBZ0IsT0FBTyxDQUFDLFdBQW1CLEVBQUUsWUFBc0M7SUFDL0UsT0FBTyxVQUFVLE1BQWMsRUFBRSxXQUE0QixFQUFFLFVBQThCO1FBQ3pGLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUN2QyxNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUMsS0FBTSxDQUFDO1FBRW5DLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQzVDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxVQUFVLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxRQUFRLEVBQUUsQ0FBQyxDQUFDO1FBQy9ELFlBQVksQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ25DLENBQUMsQ0FBQztBQUNOLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1DUCDoo4XppbDlmagg4oCUIOagh+iusOaooeWdl+WSjOW3peWFt++8jOiHquWKqOaUtumbhuWFg+aVsOaNrlxuICpcbiAqIOS9v+eUqOaWueW8j++8mlxuICogICBATUNQTW9kdWxlKCdzY2VuZScsICflnLrmma/nvJbovpEnKVxuICogICBjbGFzcyBTY2VuZU1vZHVsZSB7XG4gKiAgICAgICBATUNQVG9vbCgn5p+l6K+i6IqC54K55qCRJywgeyBub2RlVXVpZD86IHN0cmluZyB9KVxuICogICAgICAgcXVlcnlOb2RlVHJlZShwYXJhbXM6IHsgbm9kZVV1aWQ/OiBzdHJpbmcgfSkgeyAuLi4gfVxuICogICB9XG4gKi9cblxuaW1wb3J0IHsgTWV0YWRhdGFSZWdpc3RyeSwgVG9vbE1ldGEgfSBmcm9tICcuL01ldGFkYXRhUmVnaXN0cnknO1xuXG4vKiog5a2Y5YKo5pa55rOV6KOF6aWw5Zmo5pqC5a2Y5pWw5o2u77yMa2V5IOS4uuexu+WOn+WeiyAqL1xuY29uc3QgcGVuZGluZ1Rvb2xzID0gbmV3IFdlYWtNYXA8b2JqZWN0LCBUb29sTWV0YVtdPigpO1xuXG4vKipcbiAqIOexu+ijhemlsOWZqO+8muagh+iusOS4gOS4qiBNQ1Ag5Yqf6IO95qih5Z2XXG4gKiBAcGFyYW0gbmFtZSAgICAg5qih5Z2X5ZSv5LiA5qCH6K+G77yI5aaCICdzY2VuZScsICdhc3NldCfvvIlcbiAqIEBwYXJhbSBkZXNjcmlwdGlvbiDmqKHlnZfmj4/ov7BcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIE1DUE1vZHVsZShuYW1lOiBzdHJpbmcsIGRlc2NyaXB0aW9uOiBzdHJpbmcpOiBDbGFzc0RlY29yYXRvciB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uICh0YXJnZXQ6IGFueSkge1xuICAgICAgICBjb25zdCByZWdpc3RyeSA9IE1ldGFkYXRhUmVnaXN0cnkuaW5zO1xuICAgICAgICByZWdpc3RyeS5yZWdpc3Rlck1vZHVsZShuYW1lLCBkZXNjcmlwdGlvbiwgdGFyZ2V0KTtcblxuICAgICAgICAvLyDmlLbpm4bmraTliY3nlLEgQE1DUFRvb2wg5pqC5a2Y55qE5pa55rOV5YWD5pWw5o2uXG4gICAgICAgIGNvbnN0IHRvb2xzID0gcGVuZGluZ1Rvb2xzLmdldCh0YXJnZXQucHJvdG90eXBlKSB8fCBbXTtcbiAgICAgICAgZm9yIChjb25zdCB0IG9mIHRvb2xzKSB7XG4gICAgICAgICAgICByZWdpc3RyeS5yZWdpc3RlclRvb2wobmFtZSwgdC5tZXRob2ROYW1lLCB0LmRlc2NyaXB0aW9uLCB0LnBhcmFtc1NjaGVtYSwgdC5tZXRob2RGbik7XG4gICAgICAgIH1cbiAgICAgICAgcGVuZGluZ1Rvb2xzLmRlbGV0ZSh0YXJnZXQucHJvdG90eXBlKTtcbiAgICB9O1xufVxuXG4vKipcbiAqIOaWueazleijhemlsOWZqO+8muagh+iusOS4gOS4quWPr+iwg+eUqOeahCBNQ1Ag5bel5YW3XG4gKiBAcGFyYW0gZGVzY3JpcHRpb24gIOW3peWFt+aPj+i/sFxuICogQHBhcmFtIHBhcmFtc1NjaGVtYSDlj4LmlbAgSlNPTiBTY2hlbWHvvIjlj6/pgInvvIznlKjkuo4gTUNQIHRvb2xzL2xpc3Qg5bGV56S677yJXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBNQ1BUb29sKGRlc2NyaXB0aW9uOiBzdHJpbmcsIHBhcmFtc1NjaGVtYT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogTWV0aG9kRGVjb3JhdG9yIHtcbiAgICByZXR1cm4gZnVuY3Rpb24gKHRhcmdldDogb2JqZWN0LCBwcm9wZXJ0eUtleTogc3RyaW5nIHwgc3ltYm9sLCBkZXNjcmlwdG9yOiBQcm9wZXJ0eURlc2NyaXB0b3IpIHtcbiAgICAgICAgY29uc3QgbWV0aG9kTmFtZSA9IFN0cmluZyhwcm9wZXJ0eUtleSk7XG4gICAgICAgIGNvbnN0IG1ldGhvZEZuID0gZGVzY3JpcHRvci52YWx1ZSE7XG5cbiAgICAgICAgY29uc3QgbGlzdCA9IHBlbmRpbmdUb29scy5nZXQodGFyZ2V0KSB8fCBbXTtcbiAgICAgICAgbGlzdC5wdXNoKHsgbWV0aG9kTmFtZSwgZGVzY3JpcHRpb24sIHBhcmFtc1NjaGVtYSwgbWV0aG9kRm4gfSk7XG4gICAgICAgIHBlbmRpbmdUb29scy5zZXQodGFyZ2V0LCBsaXN0KTtcbiAgICB9O1xufVxuIl19