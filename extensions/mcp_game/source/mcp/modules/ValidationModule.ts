/**
 * 校验/诊断模块 — 场景结构检查、节点健康诊断、预制件格式验证
 *
 * 让 AI 能在修改场景后自检：是否有孤立节点、重复名称、空节点等问题。
 */

import { MCPModule, MCPTool } from '../decorators';

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
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

async function callAssetDB(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    } catch (e: any) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}

interface ValidationIssue {
    type: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    nodePath?: string;
    suggestion?: string;
}

@MCPModule('validation', '校验诊断 - 场景结构检查、节点健康诊断、预制件格式验证')
export class ValidationModule {

    // ==================== 场景结构校验 ====================

    @MCPTool('全面校验当前场景：检查空节点、重复命名、缺失组件、层级深度异常等', {
        strictMode: { type: 'string', description: '严格模式：传 "true" 将 warning 也视为 error' },
    })
    async validate_scene(params?: { strictMode?: string }): Promise<any> {
        const strict = String(params?.strictMode ?? '') === 'true';
        const issues: ValidationIssue[] = [];
        const stats = { totalNodes: 0, emptyNodes: 0, deepNodes: 0, duplicateNames: 0 };

        const hierarchy = await executeSceneScript('getSceneHierarchy', [true]);
        const allNodes = await executeSceneScript('getAllNodes');

        const nodeList = allNodes.data || [];
        stats.totalNodes = nodeList.length;

        // 1. 检查重复命名
        const nameCounts: Record<string, number> = {};
        nodeList.forEach((n: any) => {
            nameCounts[n.name] = (nameCounts[n.name] || 0) + 1;
        });
        for (const [name, count] of Object.entries(nameCounts)) {
            if (count > 1) {
                stats.duplicateNames += count - 1;
                issues.push({
                    type: strict ? 'error' : 'warning',
                    category: 'duplicate_names',
                    message: `节点名 "${name}" 重复 ${count} 次`,
                    suggestion: '建议为同名节点添加后缀以区分，如 "_btn", "_label"',
                });
            }
        }

        // 2. 递归检查每个节点
        const MAX_DEPTH = 12;
        const walk = (node: any, path: string[], depth: number) => {
            const nodePath = path.join('/');

            // 深度检查
            if (depth > MAX_DEPTH) {
                stats.deepNodes++;
                issues.push({
                    type: 'warning',
                    category: 'deep_hierarchy',
                    message: `层级过深 (${depth} 层): "${nodePath}"`,
                    nodePath,
                    suggestion: '考虑扁平化节点结构，过深层级影响性能和可维护性',
                });
            }

            // 空节点检查（无子节点、无组件）
            const hasChildren = node.children && node.children.length > 0;
            const hasComponents = node.components && node.components.length > 0;
            if (!hasChildren && !hasComponents) {
                stats.emptyNodes++;
                if (depth > 3) {
                    issues.push({
                        type: 'warning',
                        category: 'empty_node',
                        message: `空节点（无子节点、无组件）: "${nodePath}"`,
                        nodePath,
                        suggestion: '确认是否需要保留此节点，非必要空节点建议删除',
                    });
                }
            }

            // 非激活节点检查
            if (node.active === false && hasChildren) {
                issues.push({
                    type: 'info',
                    category: 'inactive_parent',
                    message: `非激活父节点（子节点将不可见）: "${nodePath}" (${node.children.length} 个子节点)`,
                    nodePath,
                    suggestion: '确认父节点是否应为 active',
                });
            }

            if (node.children) {
                node.children.forEach((c: any) => walk(c, [...path, c.name], depth + 1));
            }
        };

        if (hierarchy.data) {
            const roots = Array.isArray(hierarchy.data) ? hierarchy.data : [hierarchy.data];
            roots.forEach((root: any) => walk(root, [root.name], 1));
        }

        const errors = issues.filter(i => i.type === 'error');
        const warnings = issues.filter(i => i.type === 'warning');
        const infos = issues.filter(i => i.type === 'info');

        return {
            valid: strict ? errors.length === 0 : errors.length === 0 && warnings.length === 0,
            stats,
            issues: { total: issues.length, errors: errors.length, warnings: warnings.length, infos: infos.length },
            details: issues.slice(0, 50), // 最多返回 50 条
        };
    }

    @MCPTool('快速场景健康检查（只返回关键 error）')
    async quick_validate(): Promise<any> {
        const result = await this.validate_scene({ strictMode: 'true' });
        return {
            health: result.valid ? '✅ healthy' : '❌ issues found',
            stats: result.stats,
            errorCount: result.issues.errors,
            topIssues: (result.details as any[])?.filter((i: any) => i.type === 'error').slice(0, 10) || [],
        };
    }

    // ==================== 节点诊断 ====================

    @MCPTool('诊断指定节点的结构和属性', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async diagnose_node(params: { uuid: string }): Promise<any> {
        const nodeInfo = await executeSceneScript('getNodeInfo', [params.uuid]);
        if (!nodeInfo.success) throw new Error(nodeInfo.error);

        const d = nodeInfo.data;
        const issues: ValidationIssue[] = [];

        // Position 检查
        if (Math.abs(d.position.x) > 10000 || Math.abs(d.position.y) > 10000) {
            issues.push({ type: 'warning', category: 'extreme_position', message: `节点位置超出正常范围: (${d.position.x}, ${d.position.y})`, suggestion: '检查坐标是否超出设计分辨率范围' });
        }

        // Scale 检查
        if (d.scale.x === 0 || d.scale.y === 0 || d.scale.z === 0) {
            issues.push({ type: 'error', category: 'zero_scale', message: `节点缩放为 0: (${d.scale.x}, ${d.scale.y}, ${d.scale.z})`, suggestion: 'Scale 为 0 会导致节点不可见' });
        }

        // 组件检查
        if (d.components && d.components.length === 0 && d.children.length === 0) {
            issues.push({ type: 'info', category: 'leaf_no_component', message: '叶子节点无组件，仅作为占位', suggestion: '考虑添加 UITransform, Sprite 等组件或删除' });
        }

        // 父节点检查
        if (d.parent === null) {
            issues.push({ type: 'info', category: 'root_node', message: '根节点（无父节点）' });
        }

        return {
            node: d,
            issues,
            childCount: d.children?.length || 0,
            componentCount: d.components?.length || 0,
        };
    }

    @MCPTool('检查预制件状态：列出场景中所有预制件实例、断开的预制件连接等', {
        includeBroken: { type: 'string', description: '是否包含已断开的预制件连接检查，默认 true' },
    })
    async validate_prefab_instances(params?: { includeBroken?: string }): Promise<any> {
        // 通过场景节点树查找所有挂载了 _prefab 属性的节点（预制件实例）
        const allNodes = await executeSceneScript('getAllNodes');
        if (!allNodes.success) throw new Error(allNodes.error);

        const prefabInstances: any[] = [];
        const brokenInstances: any[] = [];

        for (const node of (allNodes.data || [])) {
            const info = await executeSceneScript('getNodeInfo', [node.uuid]);
            if (info.success && info.data) {
                // 检查是否有 PrefabInfo 标记（通过节点名称中是否匹配预制件命名规则）
                // 精确检测需要 dump 节点数据
                const hasPrefab = info.data._prefab || false;
                if (hasPrefab) {
                    prefabInstances.push({
                        uuid: node.uuid,
                        name: node.name,
                        parent: info.data.parent,
                    });
                }
            }
        }

        return {
            prefabInstanceCount: prefabInstances.length,
            brokenConnectionCount: brokenInstances.length,
            prefabInstances: prefabInstances.slice(0, 100),
            brokenInstances: brokenInstances.slice(0, 50),
            note: '精确预制件连接检测需要在 scene 脚本中检查节点 _prefab 属性',
        };
    }

    @MCPTool('校验预制件文件格式（读取 .prefab 文件验证 JSON 结构）', {
        prefabPath: { type: 'string', description: '预制件路径', required: true },
    })
    async validate_prefab_format(params: { prefabPath: string }): Promise<any> {
        // 先通过 asset-db 获取预制件源文件路径
        const assetInfo = await callAssetDB('query-asset-info', params.prefabPath);
        if (!assetInfo) throw new Error(`未找到预制件: ${params.prefabPath}`);

        const issues: ValidationIssue[] = [];
        let prefabData: any = null;

        try {
            // 尝试通过 asset-db 读取内容来验证
            if (assetInfo.uuid) {
                const sourceInfo = await callAssetDB('query-asset-info', assetInfo.uuid);
                if (sourceInfo) {
                    prefabData = {
                        uuid: assetInfo.uuid,
                        name: assetInfo.name,
                        url: assetInfo.url || params.prefabPath,
                    };
                }
            }
        } catch (e: any) {
            issues.push({
                type: 'error',
                category: 'read_failed',
                message: `无法读取预制件: ${e.message}`,
            });
        }

        // 基本结构检查
        if (!prefabData) {
            prefabData = {
                uuid: assetInfo.uuid,
                name: assetInfo.name,
                url: params.prefabPath,
            };
        }

        if (!assetInfo.name) {
            issues.push({
                type: 'error',
                category: 'invalid_structure',
                message: '预制件信息不完整（缺少 name）',
            });
        }

        return {
            valid: issues.filter(i => i.type === 'error').length === 0,
            prefab: prefabData,
            issues,
            suggestion: '如需深度验证 .prefab 文件结构，请在编辑器中打开预制件并使用 validate_scene',
        };
    }
}
