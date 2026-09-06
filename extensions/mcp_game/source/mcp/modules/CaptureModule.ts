/**
 * 场景快照模块 — 获取场景/节点子树的 JSON 快照
 *
 * 快速获取场景节点层级、位置、组件等结构化数据供 AI 上下文理解。
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

@MCPModule('capture', '场景快照 - 获取完整场景布局 JSON 或指定节点子树的详细快照')
export class CaptureModule {

    @MCPTool('获取当前场景的完整布局 JSON 快照，包含场景名称、设计分辨率、节点层级、位置、大小、Widget 对齐、文本内容等', {})
    async scene_snapshot(): Promise<any> {
        const result: any = {};

        // 场景信息
        try {
            const sceneInfo = await executeSceneScript('getCurrentSceneInfo');
            if (sceneInfo.success) {
                result.scene = {
                    name: sceneInfo.data.name,
                    uuid: sceneInfo.data.uuid,
                    nodeCount: sceneInfo.data.nodeCount,
                    active: sceneInfo.data.active,
                };
            }
        } catch { /* */ }

        // 设计分辨率
        try {
            const canvas = await callScene('query-current-scene');
            result.designResolution = canvas?.designResolution || { width: 960, height: 640 };
        } catch {
            result.designResolution = { width: 960, height: 640 };
        }

        // 完整层级树（含组件信息）
        try {
            const hierarchy = await executeSceneScript('getSceneHierarchy', [true]);
            if (hierarchy.success) {
                result.nodes = hierarchy.data;
            }
        } catch { /* */ }

        // 相机信息
        try {
            const cameraNodes = await executeSceneScript('findNodesByComponent', ['cc.Camera']);
            if (cameraNodes.success && cameraNodes.data) {
                result.cameras = cameraNodes.data;
            }
        } catch { /* */ }

        return result;
    }

    @MCPTool('获取指定节点及其子树的详细快照（含位置/尺寸/组件属性等）', {
        node: { type: 'string', description: '节点 UUID、路径或名称', required: true },
        maxDepth: { type: 'string', description: '最大递归深度（默认 10）' },
    })
    async node_snapshot(params: { node: string; maxDepth?: string }): Promise<any> {
        const maxDepth = parseInt(params.maxDepth || '10', 10);

        // 获取节点 UUID
        let nodeUuid = params.node;
        if (!nodeUuid.startsWith('{') && nodeUuid.length !== 36) {
            // 可能是名称，尝试查找
            const result = await executeSceneScript('findNodeByName', [params.node]);
            if (result.success && result.data && result.data.length > 0) {
                nodeUuid = result.data[0].uuid;
            }
        }

        const processNode = async (uuid: string, depth: number): Promise<any> => {
            if (depth > maxDepth) return { name: '...max depth...' };
            try {
                const info = await executeSceneScript('getNodeInfo', [uuid]);
                if (!info.success) return null;

                const d = info.data;
                const node: any = {
                    name: d.name,
                    uuid: d.uuid,
                    active: d.active,
                    position: d.position,
                    rotation: d.rotation,
                    scale: d.scale,
                    components: d.components,
                };

                // 递归子节点
                if (d.children && d.children.length > 0) {
                    node.children = [];
                    for (const childUuid of d.children) {
                        const child = await processNode(childUuid, depth + 1);
                        if (child) node.children.push(child);
                    }
                }

                return node;
            } catch {
                return null;
            }
        };

        const snapshot = await processNode(nodeUuid, 1);
        return {
            snapshot,
            nodeCount: this.countNodes(snapshot),
        };
    }

    /** 递归统计节点数 */
    private countNodes(node: any): number {
        if (!node) return 0;
        let count = 1;
        if (node.children) {
            for (const child of node.children) {
                count += this.countNodes(child);
            }
        }
        return count;
    }
}
