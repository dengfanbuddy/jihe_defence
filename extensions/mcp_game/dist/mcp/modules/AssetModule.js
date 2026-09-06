"use strict";
/**
 * 资产模块 — 对接 Cocos Creator 内置 asset-db 扩展
 *
 * 提供资产的查询、创建、导入、复制、移动、删除、保存等功能。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetModule = void 0;
const decorators_1 = require("../decorators");
/** 安全调用 Editor.Message.request，统一错误处理 */
async function callAssetDB(method, ...args) {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    }
    catch (e) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}
let AssetModule = class AssetModule {
    async query_assets(params) {
        return callAssetDB('query-assets', params === null || params === void 0 ? void 0 : params.type, params === null || params === void 0 ? void 0 : params.pattern);
    }
    async query_asset_info(params) {
        return callAssetDB('query-asset-info', params.uuid);
    }
    async query_path(params) {
        return callAssetDB('query-path', params.uuid);
    }
    async query_url(params) {
        return callAssetDB('query-url', params.uuid);
    }
    async query_uuid(params) {
        return callAssetDB('query-uuid', params.path);
    }
    async query_asset_meta(params) {
        return callAssetDB('query-asset-meta', params.uuid);
    }
    async create_asset(params) {
        const options = params.options ? JSON.parse(params.options) : {};
        return callAssetDB('create-asset', params.url, params.type, options);
    }
    async import_asset(params) {
        return callAssetDB('import-asset', params.source, params.dest);
    }
    async copy_asset(params) {
        return callAssetDB('copy-asset', params.source, params.dest);
    }
    async move_asset(params) {
        return callAssetDB('move-asset', params.source, params.dest);
    }
    async delete_asset(params) {
        return callAssetDB('delete-asset', params.uuid);
    }
    async save_asset(params) {
        return callAssetDB('save-asset', params.uuid);
    }
    async refresh_asset(params) {
        return callAssetDB('refresh-asset', params.uuid);
    }
    async reimport_asset(params) {
        return callAssetDB('reimport-asset', params.uuid);
    }
    async open_asset(params) {
        return callAssetDB('open-asset', params.uuid);
    }
    async generate_available_url(params) {
        return callAssetDB('generate-available-url', params.baseUrl, params.ext);
    }
    async query_ready() {
        return callAssetDB('query-ready');
    }
};
exports.AssetModule = AssetModule;
__decorate([
    (0, decorators_1.MCPTool)('查询项目中的所有资产列表，支持按类型/路径过滤', {
        type: { type: 'string', description: '资产类型（可选），如 cc.Prefab, cc.Texture2D' },
        pattern: { type: 'string', description: '路径匹配模式（可选）' },
    })
], AssetModule.prototype, "query_assets", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定资产的详细信息', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "query_asset_info", null);
__decorate([
    (0, decorators_1.MCPTool)('查询资产的路径', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "query_path", null);
__decorate([
    (0, decorators_1.MCPTool)('查询资产的 URL', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "query_url", null);
__decorate([
    (0, decorators_1.MCPTool)('通过路径查询资产 UUID', {
        path: { type: 'string', description: '资产的路径（如 db://assets/...）' },
    })
], AssetModule.prototype, "query_uuid", null);
__decorate([
    (0, decorators_1.MCPTool)('查询资产的 .meta 元数据内容', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "query_asset_meta", null);
__decorate([
    (0, decorators_1.MCPTool)('创建新资产', {
        type: { type: 'string', description: '资产类型，如 cc.Prefab, cc.Material' },
        url: { type: 'string', description: '目标路径（如 db://assets/NewMaterial.mtl）' },
        options: { type: 'string', description: '额外选项（JSON 字符串，可选）' },
    })
], AssetModule.prototype, "create_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('从外部文件导入资产到项目', {
        source: { type: 'string', description: '源文件路径' },
        dest: { type: 'string', description: '目标路径（如 db://assets/...）' },
    })
], AssetModule.prototype, "import_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('复制资产', {
        source: { type: 'string', description: '源资产 UUID 或路径' },
        dest: { type: 'string', description: '目标路径' },
    })
], AssetModule.prototype, "copy_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('移动资产', {
        source: { type: 'string', description: '源资产 UUID 或路径' },
        dest: { type: 'string', description: '目标路径' },
    })
], AssetModule.prototype, "move_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('删除资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "delete_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('保存资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "save_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('刷新资产（重新导入）', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "refresh_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('重新导入资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "reimport_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('在编辑器中打开资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
], AssetModule.prototype, "open_asset", null);
__decorate([
    (0, decorators_1.MCPTool)('生成一个可用的资产 URL', {
        baseUrl: { type: 'string', description: '基础路径（如 db://assets/NewScript）' },
        ext: { type: 'string', description: '文件扩展名（如 .ts）' },
    })
], AssetModule.prototype, "generate_available_url", null);
__decorate([
    (0, decorators_1.MCPTool)('查询资产数据库是否就绪')
], AssetModule.prototype, "query_ready", null);
exports.AssetModule = AssetModule = __decorate([
    (0, decorators_1.MCPModule)('asset', '资产管理 - 查询/创建/导入/删除项目资源')
], AssetModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQXNzZXRNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvQXNzZXRNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7OztBQUVILDhDQUFtRDtBQUVuRCx5Q0FBeUM7QUFDekMsS0FBSyxVQUFVLFdBQVcsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ3JELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDckUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUdNLElBQU0sV0FBVyxHQUFqQixNQUFNLFdBQVc7SUFNZCxBQUFOLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFBNEM7UUFDM0QsT0FBTyxXQUFXLENBQUMsY0FBYyxFQUFFLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxJQUFJLEVBQUUsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxNQUF3QjtRQUMzQyxPQUFPLFdBQVcsQ0FBQyxrQkFBa0IsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUF3QjtRQUNyQyxPQUFPLFdBQVcsQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xELENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxTQUFTLENBQUMs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QUFDO2lEQUdEO0FBS0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsV0FBVyxFQUFFO1FBQ2xCLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRTtLQUNwRCxDQUFDOzZDQUdEO0FBTUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsZUFBZSxFQUFFO1FBQ3RCLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLCtCQUErQixFQUFFO1FBQ3pFLEdBQUcsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGNBQWMsRUFBRTtLQUN2RCxDQUFDO3lEQUdEO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsYUFBYSxDQUFDOzhDQUd0QjtzQkE3SFEsV0FBVztJQUR2QixJQUFBLHNCQUFTLEVBQUMsT0FBTyxFQUFFLHdCQUF3QixDQUFDO0dBQ2hDLFdBQVcsQ0E4SHZCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDotYTkuqfmqKHlnZcg4oCUIOWvueaOpSBDb2NvcyBDcmVhdG9yIOWGhee9riBhc3NldC1kYiDmianlsZVcbiAqXG4gKiDmj5DkvpvotYTkuqfnmoTmn6Xor6LjgIHliJvlu7rjgIHlr7zlhaXjgIHlpI3liLbjgIHnp7vliqjjgIHliKDpmaTjgIHkv53lrZjnrYnlip/og73jgIJcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcblxuLyoqIOWuieWFqOiwg+eUqCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN077yM57uf5LiA6ZSZ6K+v5aSE55CGICovXG5hc3luYyBmdW5jdGlvbiBjYWxsQXNzZXREQihtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6LWE5Lqn5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbkBNQ1BNb2R1bGUoJ2Fzc2V0JywgJ+i1hOS6p+euoeeQhiAtIOafpeivoi/liJvlu7ov5a+85YWlL+WIoOmZpOmhueebrui1hOa6kCcpXG5leHBvcnQgY2xhc3MgQXNzZXRNb2R1bGUge1xuXG4gICAgQE1DUFRvb2woJ+afpeivoumhueebruS4reeahOaJgOaciei1hOS6p+WIl+ihqO+8jOaUr+aMgeaMieexu+Weiy/ot6/lvoTov4fmu6QnLCB7XG4gICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn57G75Z6L77yI5Y+v6YCJ77yJ77yM5aaCIGNjLlByZWZhYiwgY2MuVGV4dHVyZTJEJyB9LFxuICAgICAgICBwYXR0ZXJuOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i3r+W+hOWMuemFjeaooeW8j++8iOWPr+mAie+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIHF1ZXJ5X2Fzc2V0cyhwYXJhbXM/OiB7IHR5cGU/OiBzdHJpbmc7IHBhdHRlcm4/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQXNzZXREQigncXVlcnktYXNzZXRzJywgcGFyYW1zPy50eXBlLCBwYXJhbXM/LnBhdHRlcm4pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrprotYTkuqfnmoTor6bnu4bkv6Hmga8nLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn55qEIFVVSUQnIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9hc3NldF9pbmZvKHBhcmFtczogeyB1dWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQXNzZXREQigncXVlcnktYXNzZXQtaW5mbycsIHBhcmFtcy51dWlkKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6LWE5Lqn55qE6Lev5b6EJywge1xuICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOS6p+eahCBVVUlEJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgcXVlcnlfcGF0aChwYXJhbXM6IHsgdXVpZDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEFzc2V0REIoJ3F1ZXJ5LXBhdGgnLCBwYXJhbXMudXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivoui1hOS6p+eahCBVUkwnLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn55qEIFVVSUQnIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV91cmwocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdxdWVyeS11cmwnLCBwYXJhbXMudXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+mAmui/h+i3r+W+hOafpeivoui1hOS6pyBVVUlEJywge1xuICAgICAgICBwYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOS6p+eahOi3r+W+hO+8iOWmgiBkYjovL2Fzc2V0cy8uLi7vvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV91dWlkKHBhcmFtczogeyBwYXRoOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQXNzZXREQigncXVlcnktdXVpZCcsIHBhcmFtcy5wYXRoKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6LWE5Lqn55qEIC5tZXRhIOWFg+aVsOaNruWGheWuuScsIHtcbiAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfotYTkuqfnmoQgVVVJRCcgfSxcbiAgICB9KVxuICAgIGFzeW5jIHF1ZXJ5X2Fzc2V0X21ldGEocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdxdWVyeS1hc3NldC1tZXRhJywgcGFyYW1zLnV1aWQpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliJvlu7rmlrDotYTkuqcnLCB7XG4gICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn57G75Z6L77yM5aaCIGNjLlByZWZhYiwgY2MuTWF0ZXJpYWwnIH0sXG4gICAgICAgIHVybDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnm67moIfot6/lvoTvvIjlpoIgZGI6Ly9hc3NldHMvTmV3TWF0ZXJpYWwubXRs77yJJyB9LFxuICAgICAgICBvcHRpb25zOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mineWklumAiemhue+8iEpTT04g5a2X56ym5Liy77yM5Y+v6YCJ77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgY3JlYXRlX2Fzc2V0KHBhcmFtczogeyB0eXBlOiBzdHJpbmc7IHVybDogc3RyaW5nOyBvcHRpb25zPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gcGFyYW1zLm9wdGlvbnMgPyBKU09OLnBhcnNlKHBhcmFtcy5vcHRpb25zKSA6IHt9O1xuICAgICAgICByZXR1cm4gY2FsbEFzc2V0REIoJ2NyZWF0ZS1hc3NldCcsIHBhcmFtcy51cmwsIHBhcmFtcy50eXBlLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5LuO5aSW6YOo5paH5Lu25a+85YWl6LWE5Lqn5Yiw6aG555uuJywge1xuICAgICAgICBzb3VyY2U6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5rqQ5paH5Lu26Lev5b6EJyB9LFxuICAgICAgICBkZXN0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+i3r+W+hO+8iOWmgiBkYjovL2Fzc2V0cy8uLi7vvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBpbXBvcnRfYXNzZXQocGFyYW1zOiB7IHNvdXJjZTogc3RyaW5nOyBkZXN0OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQXNzZXREQignaW1wb3J0LWFzc2V0JywgcGFyYW1zLnNvdXJjZSwgcGFyYW1zLmRlc3QpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCflpI3liLbotYTkuqcnLCB7XG4gICAgICAgIHNvdXJjZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmupDotYTkuqcgVVVJRCDmiJbot6/lvoQnIH0sXG4gICAgICAgIGRlc3Q6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55uu5qCH6Lev5b6EJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgY29weV9hc3NldChwYXJhbXM6IHsgc291cmNlOiBzdHJpbmc7IGRlc3Q6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdjb3B5LWFzc2V0JywgcGFyYW1zLnNvdXJjZSwgcGFyYW1zLmRlc3QpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfnp7vliqjotYTkuqcnLCB7XG4gICAgICAgIHNvdXJjZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmupDotYTkuqcgVVVJRCDmiJbot6/lvoQnIH0sXG4gICAgICAgIGRlc3Q6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55uu5qCH6Lev5b6EJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgbW92ZV9hc3NldChwYXJhbXM6IHsgc291cmNlOiBzdHJpbmc7IGRlc3Q6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdtb3ZlLWFzc2V0JywgcGFyYW1zLnNvdXJjZSwgcGFyYW1zLmRlc3QpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliKDpmaTotYTkuqcnLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn55qEIFVVSUQnIH0sXG4gICAgfSlcbiAgICBhc3luYyBkZWxldGVfYXNzZXQocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdkZWxldGUtYXNzZXQnLCBwYXJhbXMudXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+S/neWtmOi1hOS6pycsIHtcbiAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfotYTkuqfnmoQgVVVJRCcgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNhdmVfYXNzZXQocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdzYXZlLWFzc2V0JywgcGFyYW1zLnV1aWQpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliLfmlrDotYTkuqfvvIjph43mlrDlr7zlhaXvvIknLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5Lqn55qEIFVVSUQnIH0sXG4gICAgfSlcbiAgICBhc3luYyByZWZyZXNoX2Fzc2V0KHBhcmFtczogeyB1dWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsQXNzZXREQigncmVmcmVzaC1hc3NldCcsIHBhcmFtcy51dWlkKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6YeN5paw5a+85YWl6LWE5LqnJywge1xuICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOS6p+eahCBVVUlEJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgcmVpbXBvcnRfYXNzZXQocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdyZWltcG9ydC1hc3NldCcsIHBhcmFtcy51dWlkKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5Zyo57yW6L6R5Zmo5Lit5omT5byA6LWE5LqnJywge1xuICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOS6p+eahCBVVUlEJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgb3Blbl9hc3NldChwYXJhbXM6IHsgdXVpZDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEFzc2V0REIoJ29wZW4tYXNzZXQnLCBwYXJhbXMudXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+eUn+aIkOS4gOS4quWPr+eUqOeahOi1hOS6pyBVUkwnLCB7XG4gICAgICAgIGJhc2VVcmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Z+656GA6Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL05ld1NjcmlwdO+8iScgfSxcbiAgICAgICAgZXh0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWh+S7tuaJqeWxleWQje+8iOWmgiAudHPvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBnZW5lcmF0ZV9hdmFpbGFibGVfdXJsKHBhcmFtczogeyBiYXNlVXJsOiBzdHJpbmc7IGV4dDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbEFzc2V0REIoJ2dlbmVyYXRlLWF2YWlsYWJsZS11cmwnLCBwYXJhbXMuYmFzZVVybCwgcGFyYW1zLmV4dCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivoui1hOS6p+aVsOaNruW6k+aYr+WQpuWwsee7qicpXG4gICAgYXN5bmMgcXVlcnlfcmVhZHkoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxBc3NldERCKCdxdWVyeS1yZWFkeScpO1xuICAgIH1cbn1cbiJdfQ==