/**
 * 资产模块 — 对接 Cocos Creator 内置 asset-db 扩展
 *
 * 提供资产的查询、创建、导入、复制、移动、删除、保存等功能。
 */

import { MCPModule, MCPTool } from '../decorators';

/** 安全调用 Editor.Message.request，统一错误处理 */
async function callAssetDB(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    } catch (e: any) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('asset', '资产管理 - 查询/创建/导入/删除项目资源')
export class AssetModule {

    @MCPTool('查询项目中的所有资产列表，支持按类型/路径过滤', {
        type: { type: 'string', description: '资产类型（可选），如 cc.Prefab, cc.Texture2D' },
        pattern: { type: 'string', description: '路径匹配模式（可选）' },
    })
    async query_assets(params?: { type?: string; pattern?: string }): Promise<any> {
        return callAssetDB('query-assets', params?.type, params?.pattern);
    }

    @MCPTool('查询指定资产的详细信息', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async query_asset_info(params: { uuid: string }): Promise<any> {
        return callAssetDB('query-asset-info', params.uuid);
    }

    @MCPTool('查询资产的路径', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async query_path(params: { uuid: string }): Promise<any> {
        return callAssetDB('query-path', params.uuid);
    }

    @MCPTool('查询资产的 URL', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async query_url(params: { uuid: string }): Promise<any> {
        return callAssetDB('query-url', params.uuid);
    }

    @MCPTool('通过路径查询资产 UUID', {
        path: { type: 'string', description: '资产的路径（如 db://assets/...）' },
    })
    async query_uuid(params: { path: string }): Promise<any> {
        return callAssetDB('query-uuid', params.path);
    }

    @MCPTool('查询资产的 .meta 元数据内容', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async query_asset_meta(params: { uuid: string }): Promise<any> {
        return callAssetDB('query-asset-meta', params.uuid);
    }

    @MCPTool('创建新资产', {
        type: { type: 'string', description: '资产类型，如 cc.Prefab, cc.Material' },
        url: { type: 'string', description: '目标路径（如 db://assets/NewMaterial.mtl）' },
        options: { type: 'string', description: '额外选项（JSON 字符串，可选）' },
    })
    async create_asset(params: { type: string; url: string; options?: string }): Promise<any> {
        const options = params.options ? JSON.parse(params.options) : {};
        return callAssetDB('create-asset', params.url, params.type, options);
    }

    @MCPTool('从外部文件导入资产到项目', {
        source: { type: 'string', description: '源文件路径' },
        dest: { type: 'string', description: '目标路径（如 db://assets/...）' },
    })
    async import_asset(params: { source: string; dest: string }): Promise<any> {
        return callAssetDB('import-asset', params.source, params.dest);
    }

    @MCPTool('复制资产', {
        source: { type: 'string', description: '源资产 UUID 或路径' },
        dest: { type: 'string', description: '目标路径' },
    })
    async copy_asset(params: { source: string; dest: string }): Promise<any> {
        return callAssetDB('copy-asset', params.source, params.dest);
    }

    @MCPTool('移动资产', {
        source: { type: 'string', description: '源资产 UUID 或路径' },
        dest: { type: 'string', description: '目标路径' },
    })
    async move_asset(params: { source: string; dest: string }): Promise<any> {
        return callAssetDB('move-asset', params.source, params.dest);
    }

    @MCPTool('删除资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async delete_asset(params: { uuid: string }): Promise<any> {
        return callAssetDB('delete-asset', params.uuid);
    }

    @MCPTool('保存资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async save_asset(params: { uuid: string }): Promise<any> {
        return callAssetDB('save-asset', params.uuid);
    }

    @MCPTool('刷新资产（重新导入）', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async refresh_asset(params: { uuid: string }): Promise<any> {
        return callAssetDB('refresh-asset', params.uuid);
    }

    @MCPTool('重新导入资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async reimport_asset(params: { uuid: string }): Promise<any> {
        return callAssetDB('reimport-asset', params.uuid);
    }

    @MCPTool('在编辑器中打开资产', {
        uuid: { type: 'string', description: '资产的 UUID' },
    })
    async open_asset(params: { uuid: string }): Promise<any> {
        return callAssetDB('open-asset', params.uuid);
    }

    @MCPTool('生成一个可用的资产 URL', {
        baseUrl: { type: 'string', description: '基础路径（如 db://assets/NewScript）' },
        ext: { type: 'string', description: '文件扩展名（如 .ts）' },
    })
    async generate_available_url(params: { baseUrl: string; ext: string }): Promise<any> {
        return callAssetDB('generate-available-url', params.baseUrl, params.ext);
    }

    @MCPTool('查询资产数据库是否就绪')
    async query_ready(): Promise<any> {
        return callAssetDB('query-ready');
    }
}
