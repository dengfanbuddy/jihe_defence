/**
 * 预制件模块 — 预制件全生命周期管理
 *
 * 依赖：
 * - asset-db 扩展：资产 CRUD
 * - scene 扩展：create-node（实例化）
 * - 场景脚本（contributions.scene）：createPrefabFromNode（节点数据收集）
 */

import { MCPModule, MCPTool } from '../decorators';

/** 安全调用 Editor.Message.request */
async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function callAssetDB(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    } catch (e: any) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function executeSceneScript(method: string, args: any[] = []): Promise<any> {
    try {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
    } catch (e: any) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}

/** 将场景节点数据转换为 .prefab 文件格式 */
function buildPrefabJSON(nodeData: any, prefabName: string): any {
    const nodes: any[] = [];
    const fileIdMap = new Map<any, number>();
    let nextFileId = 1;

    // 递归收集节点
    function collectNode(n: any, parentFileId: number | null): number {
        const fileId = nextFileId++;
        fileIdMap.set(n, fileId);

        const nodeEntry: any = {
            "__type__": "cc.Node",
            "_name": n.name,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_parent": parentFileId !== null ? { "__id__": parentFileId } : null,
            "_children": [],
            "_active": n.active !== undefined ? n.active : true,
            "_components": [],
            "_prefab": {
                "__type__": "cc.PrefabInfo",
                "root": null,
                "asset": null,
                "fileId": String(fileId),
                "instance": null,
                "targetOverrides": null,
                "nestedPrefabInstanceRoots": null,
            },
            "_lpos": {
                "__type__": "cc.Vec3",
                "x": n.position?.x ?? 0,
                "y": n.position?.y ?? 0,
                "z": n.position?.z ?? 0,
            },
            "_lrot": {
                "__type__": "cc.Quat",
                "x": n.rotation?.x ?? 0,
                "y": n.rotation?.y ?? 0,
                "z": n.rotation?.z ?? 0,
                "w": 1,
            },
            "_lscale": {
                "__type__": "cc.Vec3",
                "x": n.scale?.x ?? 1,
                "y": n.scale?.y ?? 1,
                "z": n.scale?.z ?? 1,
            },
            "_mobility": n.mobility ?? 0,
            "_layer": n.layer ?? 1073741824,
            "_euler": {
                "__type__": "cc.Vec3",
                "x": n.rotation?.x ?? 0,
                "y": n.rotation?.y ?? 0,
                "z": n.rotation?.z ?? 0,
            },
            "_id": "",
        };

        // 组件
        if (n.components) {
            n.components.forEach((comp: any, ci: number) => {
                const compEntry: any = {
                    "__type__": comp.type,
                    "_name": "",
                    "_objFlags": 0,
                    "__editorExtras__": {},
                    "node": { "__id__": fileId },
                    "_enabled": comp.enabled !== undefined ? comp.enabled : true,
                    "__prefab": null,
                    "_id": `${prefabName}_comp_${fileId}_${ci}`,
                };
                const compFileId = nextFileId++;
                nodes.push(compEntry);
                nodeEntry._components.push({ "__id__": compFileId });
            });
        }

        // 子节点
        if (n.children) {
            n.children.forEach((child: any) => {
                const childFileId = collectNode(child, fileId);
                nodeEntry._children.push({ "__id__": childFileId });
            });
        }

        nodes.push(nodeEntry);
        return fileId;
    }

    collectNode(nodeData, null);

    // 设置根节点的 PrefabInfo
    const rootNode = nodes.find((n: any) => n.__type__ === 'cc.Node' && n._parent === null);
    if (rootNode && rootNode._prefab) {
        rootNode._prefab.root = { "__id__": 1 };
    }

    // 构建顶层结构
    const prefabData: any[] = [
        {
            "__type__": "cc.Prefab",
            "_name": prefabName,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_native": "",
            "data": null,
            "optimizationPolicy": 0,
            "persistent": false,
        },
        ...nodes,
    ];

    return prefabData;
}

@MCPModule('prefab', '预制件管理 - 创建/实例化/复制/查询预制件')
export class PrefabModule {

    // ==================== 查询 ====================

    @MCPTool('查询项目中的所有预制件列表', {
        folder: { type: 'string', description: '搜索文件夹路径（可选，默认 db://assets）' },
    })
    async get_prefab_list(params?: { folder?: string }): Promise<any> {
        const folder = params?.folder || 'db://assets';
        const pattern = folder.endsWith('/') ? `${folder}**/*.prefab` : `${folder}/**/*.prefab`;
        const results = await callAssetDB('query-assets', { pattern });
        const prefabs = (results || []).map((a: any) => ({
            name: a.name,
            path: a.url,
            uuid: a.uuid,
            folder: a.url ? a.url.substring(0, a.url.lastIndexOf('/')) : folder,
        }));
        return { prefabs };
    }

    @MCPTool('查询预制件详细信息', {
        prefabPath: { type: 'string', description: '预制件资产路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
    })
    async get_prefab_info(params: { prefabPath: string }): Promise<any> {
        const info = await callAssetDB('query-asset-info', params.prefabPath);
        if (!info) throw new Error(`未找到预制件: ${params.prefabPath}`);
        return info;
    }

    // ==================== 实例化 ====================

    @MCPTool('将预制件实例化到场景中', {
        prefabPath: { type: 'string', description: '预制件路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        position: { type: 'string', description: '初始位置 JSON（可选，如 {"x":100,"y":200,"z":0}）' },
        name: { type: 'string', description: '实例节点名称（可选，默认使用预制件名）' },
    })
    async instantiate_prefab(params: {
        prefabPath: string;
        parentUuid?: string;
        position?: string;
        name?: string;
    }): Promise<any> {
        // 获取预制件资产信息
        const assetInfo = await callAssetDB('query-asset-info', params.prefabPath);
        if (!assetInfo) throw new Error(`未找到预制件: ${params.prefabPath}`);

        // 构建 create-node 参数
        const createOpts: any = {
            assetUuid: assetInfo.uuid,
        };

        if (params.parentUuid) {
            createOpts.parent = params.parentUuid;
        }
        if (params.name) {
            createOpts.name = params.name;
        } else if (assetInfo.name) {
            createOpts.name = assetInfo.name;
        }

        // 设置位置
        if (params.position) {
            const pos = JSON.parse(params.position);
            createOpts.dump = {
                position: { value: pos },
            };
        }

        const nodeUuid = await callScene('create-node', createOpts);
        const uuid = Array.isArray(nodeUuid) ? nodeUuid[0] : nodeUuid;

        return {
            message: `预制件 '${assetInfo.name}' 已实例化`,
            nodeUuid: uuid,
            prefabPath: params.prefabPath,
        };
    }

    // ==================== 创建预制件 ====================

    @MCPTool('将场景节点保存为预制件（含完整子树和组件）', {
        nodeUuid: { type: 'string', description: '源节点 UUID', required: true },
        savePath: { type: 'string', description: '预制件保存路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
        prefabName: { type: 'string', description: '预制件名称', required: true },
    })
    async create_prefab(params: {
        nodeUuid: string;
        savePath: string;
        prefabName: string;
    }): Promise<any> {
        // 1. 收集节点树数据
        const nodeResult = await executeSceneScript('createPrefabFromNode', [params.nodeUuid]);
        if (!nodeResult.success) {
            throw new Error(`收集节点数据失败: ${nodeResult.error}`);
        }

        // 2. 构建 .prefab 文件 JSON
        const prefabJSON = buildPrefabJSON(nodeResult.data.tree, params.prefabName);

        // 3. 确保路径以 .prefab 结尾
        const fullPath = params.savePath.endsWith('.prefab')
            ? params.savePath
            : `${params.savePath}/${params.prefabName}.prefab`;

        // 4. 写入资产
        const content = JSON.stringify(prefabJSON, null, 2);
        const result = await callAssetDB('create-asset', fullPath, content);

        return {
            message: `预制件 '${params.prefabName}' 已创建`,
            uuid: result?.uuid,
            url: result?.url,
            sourceNode: params.nodeUuid,
        };
    }

    // ==================== 复制 ====================

    @MCPTool('复制（克隆）预制件', {
        sourcePrefabPath: { type: 'string', description: '源预制件路径', required: true },
        targetPrefabPath: { type: 'string', description: '目标预制件路径（如 db://assets/prefabs/MyPrefab_Copy.prefab）', required: true },
        newPrefabName: { type: 'string', description: '新预制件名称（可选）' },
    })
    async duplicate_prefab(params: {
        sourcePrefabPath: string;
        targetPrefabPath: string;
        newPrefabName?: string;
    }): Promise<any> {
        // 获取源预制件 UUID
        const srcUuid = await callAssetDB('query-uuid', params.sourcePrefabPath);
        if (!srcUuid) throw new Error(`未找到源预制件: ${params.sourcePrefabPath}`);

        const result = await callAssetDB('copy-asset', srcUuid, params.targetPrefabPath);

        return {
            message: `预制件已复制到 ${params.targetPrefabPath}`,
            uuid: result?.uuid,
            url: result?.url,
        };
    }

    // ==================== 批量实例化 ====================

    @MCPTool('批量实例化预制件（网格排列）', {
        prefabPath: { type: 'string', description: '预制件路径', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID' },
        count: { type: 'string', description: '数量（JSON 如 {"x":3,"y":2} 表示 3 列 2 行）', required: true },
        spacing: { type: 'string', description: '间距 JSON（如 {"x":100,"y":100}）' },
    })
    async batch_instantiate(params: {
        prefabPath: string;
        parentUuid?: string;
        count: string;
        spacing?: string;
    }): Promise<any> {
        const count = JSON.parse(params.count);
        const spacing = params.spacing ? JSON.parse(params.spacing) : { x: 100, y: 100 };
        const cols = count.x || 1;
        const rows = count.y || 1;

        const total = cols * rows;
        if (total > 100) throw new Error('单次批量实例化上限为 100');

        const assetInfo = await callAssetDB('query-asset-info', params.prefabPath);
        if (!assetInfo) throw new Error(`未找到预制件: ${params.prefabPath}`);

        const uuids: string[] = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const x = col * spacing.x;
                const y = -row * spacing.y;
                const result = await this.instantiate_prefab({
                    prefabPath: params.prefabPath,
                    parentUuid: params.parentUuid,
                    position: JSON.stringify({ x, y, z: 0 }),
                    name: `${assetInfo.name}_${row * cols + col + 1}`,
                });
                uuids.push(result.nodeUuid);
            }
        }

        return {
            message: `已批量实例化 ${total} 个预制件（${cols}x${rows} 网格）`,
            nodeUuids: uuids,
            grid: { cols, rows, spacing },
        };
    }
}
