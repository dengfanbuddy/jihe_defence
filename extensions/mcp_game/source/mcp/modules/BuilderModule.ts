/**
 * 构建器模块 — 从 JSON 定义一键构建完整节点树
 *
 * 接收 JSON 树定义，递归创建节点、添加组件、设置属性。
 * 支持 'type' 快捷创建 Button/Label/Sprite 等内置 UI 控件。
 */

import { MCPModule, MCPTool } from '../decorators';

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

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('builder', '场景构建器 - 从 JSON 定义一键创建完整节点树（支持递归嵌套、组件、属性设置）')
export class BuilderModule {

    @MCPTool('从 JSON 定义构建完整节点树。支持嵌套节点、组件添加、属性设置。顶层节点 "type" 可快速创建内置 UI 控件（Button/Label/Sprite 等）', {
        parent: { type: 'string', description: '父节点路径、UUID 或名称（默认 Canvas）' },
        tree: { type: 'string', description: '节点树 JSON 定义（必填）。格式见注意事项', required: true },
        clean: { type: 'string', description: '构建前是否清空父节点子节点: "true" 或 "false"' },
    })
    async build(params: { parent?: string; tree: string; clean?: string }): Promise<any> {
        const tree = JSON.parse(params.tree);
        const clean = params.clean === 'true';

        // 确定父节点 UUID
        let parentUuid: string | undefined;
        if (params.parent) {
            try {
                const result = await executeSceneScript('findNodeByName', [params.parent]);
                if (result.success && result.data && result.data.length > 0) {
                    parentUuid = result.data[0].uuid;
                }
            } catch { /* 没找到 */ }
        }

        // 如果指定了 clean，获取并删除父节点下所有子节点
        if (clean && parentUuid) {
            const parentInfo = await executeSceneScript('getNodeInfo', [parentUuid]);
            if (parentInfo.success && parentInfo.data) {
                for (const childUuid of (parentInfo.data.children || [])) {
                    await executeSceneScript('deleteNode', [childUuid]);
                }
            }
        }

        // 递归构建节点树
        const createdNodes: { name: string; uuid: string }[] = [];

        const buildNode = async (def: any, parent?: string): Promise<string | null> => {
            if (!def || !def.name) return null;

            // 创建节点
            const nodeResult = await executeSceneScript('createNode', [def.name, parent]);
            if (!nodeResult.success) return null;
            const nodeUuid = nodeResult.data?.uuid;
            if (!nodeUuid) return null;

            createdNodes.push({ name: def.name, uuid: nodeUuid });

            // 设置 position
            if (def.position) {
                await executeSceneScript('setNodeProperty', [nodeUuid, 'position', def.position]);
            }

            // 设置 scale
            if (def.scale) {
                await executeSceneScript('setNodeProperty', [nodeUuid, 'scale', def.scale]);
            }

            // 设置 rotation
            if (def.rotation) {
                await executeSceneScript('setNodeProperty', [nodeUuid, 'rotation', def.rotation]);
            }

            // 设置 active
            if (def.active !== undefined) {
                await executeSceneScript('setNodeProperty', [nodeUuid, 'active', def.active]);
            }

            // 添加组件（根据 type 或 components 列表）
            if (def.type) {
                // type 快捷创建内置 UI 控件
                try {
                    await callScene('create-node', { parentUuid: parent, name: def.name, type: def.type });
                } catch {
                    // fallback: 手动添加组件
                    const typeToComponent: Record<string, string> = {
                        'Button': 'cc.Button',
                        'Label': 'cc.Label',
                        'Sprite': 'cc.Sprite',
                        'EditBox': 'cc.EditBox',
                        'ScrollView': 'cc.ScrollView',
                        'ProgressBar': 'cc.ProgressBar',
                        'Slider': 'cc.Slider',
                        'Toggle': 'cc.Toggle',
                    };
                    const compType = typeToComponent[def.type];
                    if (compType) {
                        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);
                        try {
                            await executeSceneScript('addComponentToNode', [nodeUuid, compType]);
                        } catch { /* 可能已有 */ }
                    }
                }
            }

            if (def.components && Array.isArray(def.components)) {
                for (const comp of def.components) {
                    let compType = comp;
                    if (typeof comp === 'object' && comp.type) {
                        compType = comp.type;
                    }
                    await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);
                    try {
                        await executeSceneScript('addComponentToNode', [nodeUuid, compType]);
                    } catch { /* 已存在或无效 */ }
                }
            }

            // 设置组件属性（props 或 properties）
            const compProps = def.props || def.properties;
            if (compProps && typeof compProps === 'object') {
                for (const [compType, props] of Object.entries(compProps)) {
                    if (props && typeof props === 'object') {
                        for (const [propName, propValue] of Object.entries(props as object)) {
                            try {
                                await executeSceneScript('setComponentProperty', [nodeUuid, compType as string, propName, propValue]);
                            } catch { /* 跳过属性设置失败 */ }
                        }
                    }
                }
            }

            // 递归构建子节点
            if (def.children && Array.isArray(def.children)) {
                for (const child of def.children) {
                    await buildNode(child, nodeUuid);
                }
            }

            return nodeUuid;
        };

        // 如果是数组，分别创建每个根节点
        const trees = Array.isArray(tree) ? tree : [tree];
        for (const nodeDef of trees) {
            await buildNode(nodeDef, parentUuid);
        }

        return {
            message: `节点树构建完成，共创建 ${createdNodes.length} 个节点`,
            nodes: createdNodes,
        };
    }
}
