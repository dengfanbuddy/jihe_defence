/**
 * 场景脚本 — 运行在 Cocos Creator 场景上下文中
 *
 * 通过 contributions.scene 注册，由 Editor.Message.request('scene', 'execute-scene-script', ...) 调用。
 * 这里的每个方法都有权访问 require('cc') 获取引擎 API（director、Node、Component 等）。
 */

import { join } from 'path';
module.paths.push(join(Editor.App.path, 'node_modules'));

export const methods: { [key: string]: (...any: any) => any } = {

    /**
     * 创建空白新场景
     */
    createNewScene() {
        try {
            const { director, Scene } = require('cc');
            const scene = new Scene();
            scene.name = 'New Scene';
            director.runScene(scene);
            return { success: true, message: '新场景已创建' };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 为节点添加组件
     */
    addComponentToNode(nodeUuid: string, componentType: string) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const CompClass = js.getClassByName(componentType);
            if (!CompClass) return { success: false, error: `未找到组件类型: ${componentType}` };

            const comp = node.addComponent(CompClass);
            return {
                success: true,
                message: `已添加组件 ${componentType}`,
                data: { componentId: comp.uuid },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 移除节点上的组件
     */
    removeComponentFromNode(nodeUuid: string, componentType: string) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const CompClass = js.getClassByName(componentType);
            if (!CompClass) return { success: false, error: `未找到组件类型: ${componentType}` };

            const comp = node.getComponent(CompClass);
            if (!comp) return { success: false, error: `节点上无组件 ${componentType}` };

            node.removeComponent(comp);
            return { success: true, message: `已移除组件 ${componentType}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 在场景中创建新节点
     */
    createNode(name: string, parentUuid?: string) {
        try {
            const { director, Node } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = new Node(name);
            if (parentUuid) {
                const parent = scene.getChildByUuid(parentUuid);
                if (parent) {
                    parent.addChild(node);
                } else {
                    scene.addChild(node);
                }
            } else {
                scene.addChild(node);
            }

            return {
                success: true,
                message: `节点 ${name} 已创建`,
                data: { uuid: node.uuid, name: node.name },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 删除节点
     */
    deleteNode(nodeUuid: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const name = node.name;
            node.removeFromParent();
            node.destroy();
            return { success: true, message: `已删除节点: ${name}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 获取节点详情（Transform、组件列表等）
     */
    getNodeInfo(nodeUuid: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: { x: node.position.x, y: node.position.y, z: node.position.z },
                    rotation: { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z },
                    scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
                    layer: node.layer,
                    mobility: node.mobility,
                    parent: node.parent?.uuid || null,
                    children: node.children.map((c: any) => c.uuid),
                    components: node.components.map((c: any) => ({
                        type: c.constructor.name,
                        enabled: c.enabled,
                    })),
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 获取场景中所有节点（扁平列表）
     */
    getAllNodes() {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const nodes: any[] = [];
            const walk = (node: any) => {
                nodes.push({
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    parent: node.parent?.uuid || null,
                });
                node.children.forEach((c: any) => walk(c));
            };
            scene.children.forEach((c: any) => walk(c));

            return { success: true, data: nodes };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 按名称查找节点
     */
    findNodeByName(name: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const found: any[] = [];
            const walk = (node: any) => {
                if (node.name === name) {
                    found.push({
                        uuid: node.uuid,
                        name: node.name,
                        active: node.active,
                        parent: node.parent?.uuid || null,
                    });
                }
                node.children.forEach((c: any) => walk(c));
            };
            scene.children.forEach((c: any) => walk(c));

            return { success: true, data: found };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 按组件类型查找节点
     */
    findNodesByComponent(componentType: string) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const CompClass = js.getClassByName(componentType);
            const found: any[] = [];
            const walk = (node: any) => {
                if (node.getComponent(CompClass)) {
                    found.push({
                        uuid: node.uuid,
                        name: node.name,
                        active: node.active,
                        parent: node.parent?.uuid || null,
                    });
                }
                node.children.forEach((c: any) => walk(c));
            };
            scene.children.forEach((c: any) => walk(c));

            return { success: true, data: found };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 设置节点属性（Transform / active / name / layer / mobility）
     */
    setNodeProperty(nodeUuid: string, property: string, value: any) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            switch (property) {
                case 'position':
                    node.setPosition(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
                    break;
                case 'rotation':
                    node.setRotationFromEuler(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
                    break;
                case 'scale':
                    node.setScale(value?.x ?? 1, value?.y ?? 1, value?.z ?? 1);
                    break;
                case 'active':
                    node.active = !!value;
                    break;
                case 'name':
                    node.name = String(value);
                    break;
                case 'layer':
                    node.layer = Number(value);
                    break;
                case 'mobility':
                    node.mobility = Number(value);
                    break;
                default:
                    (node as any)[property] = value;
            }

            return { success: true, message: `属性 '${property}' 已更新` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 设置组件属性（支持 Sprite/Label/Button 等常见组件的特殊处理）
     */
    setComponentProperty(nodeUuid: string, componentType: string, property: string, value: any) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const CompClass = js.getClassByName(componentType);
            if (!CompClass) return { success: false, error: `未找到组件类型: ${componentType}` };

            const comp = node.getComponent(CompClass);
            if (!comp) return { success: false, error: `节点上无组件 ${componentType}` };

            // 特殊处理常见组件
            if (property === 'spriteFrame' && (componentType === 'cc.Sprite' || componentType === 'cc.Mask')) {
                if (typeof value === 'string') {
                    const { assetManager } = require('cc');
                    assetManager.loadAny({ uuid: value }, (_err: any, asset: any) => {
                        if (!_err && asset) comp.spriteFrame = asset;
                    });
                } else {
                    comp.spriteFrame = value;
                }
            } else if (property === 'string' && (componentType === 'cc.Label' || componentType === 'cc.RichText')) {
                comp.string = String(value);
            } else if (property === 'color' && componentType === 'cc.Label') {
                const { Color } = require('cc');
                if (typeof value === 'object') {
                    comp.color = new Color(value.r ?? 255, value.g ?? 255, value.b ?? 255, value.a ?? 255);
                } else {
                    comp.color = value;
                }
            } else if (property === 'material') {
                if (typeof value === 'string') {
                    const { assetManager } = require('cc');
                    assetManager.loadAny({ uuid: value }, (_err: any, asset: any) => {
                        if (!_err && asset) comp.material = asset;
                    });
                } else {
                    comp.material = value;
                }
            } else if (property === 'fontSize' && componentType === 'cc.Label') {
                comp.fontSize = Number(value);
            } else if (property === 'lineHeight' && componentType === 'cc.Label') {
                comp.lineHeight = Number(value);
            } else {
                (comp as any)[property] = value;
            }

            return { success: true, message: `组件属性 '${property}' 已更新` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 获取当前场景基本信息
     */
    getCurrentSceneInfo() {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const countNodes = (node: any): number => {
                let count = 1;
                node.children.forEach((c: any) => (count += countNodes(c)));
                return count;
            };
            let nodeCount = 0;
            scene.children.forEach((c: any) => (nodeCount += countNodes(c)));

            return {
                success: true,
                data: {
                    name: scene.name,
                    uuid: scene.uuid,
                    nodeCount,
                    active: scene.active,
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 获取完整场景层级树
     */
    getSceneHierarchy(includeComponents: boolean = false) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const processNode = (node: any): any => {
                const result: any = {
                    name: node.name,
                    uuid: node.uuid,
                    active: node.active,
                    children: [],
                };
                if (includeComponents) {
                    result.components = node.components.map((c: any) => ({
                        type: c.constructor.name,
                        enabled: c.enabled,
                    }));
                }
                node.children.forEach((c: any) => result.children.push(processNode(c)));
                return result;
            };

            const hierarchy = scene.children.map((c: any) => processNode(c));
            return { success: true, data: hierarchy };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 将场景节点保存为预制体（收集节点信息供主进程序列化）
     */
    createPrefabFromNode(nodeUuid: string, _prefabPath?: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            // 收集节点及其子树的关键信息供主进程创建预制体文件
            const collectNodeData = (n: any): any => ({
                name: n.name,
                active: n.active,
                position: { x: n.position.x, y: n.position.y, z: n.position.z },
                rotation: { x: n.rotation.x, y: n.rotation.y, z: n.rotation.z },
                scale: { x: n.scale.x, y: n.scale.y, z: n.scale.z },
                layer: n.layer,
                mobility: n.mobility,
                components: n.components.map((c: any) => ({
                    type: c.constructor.name,
                })),
                children: n.children.map((c: any) => collectNodeData(c)),
            });

            return {
                success: true,
                data: {
                    sourceNodeUuid: nodeUuid,
                    nodeName: node.name,
                    tree: collectNodeData(node),
                    prefabPath: _prefabPath || null,
                    message: `节点 '${node.name}' 数据已收集，准备创建预制体`,
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 复制节点（深拷贝）
     */
    duplicateNode(nodeUuid: string) {
        try {
            const { director, instantiate } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const clone = instantiate(node);
            clone.name = node.name + ' (Copy)';
            node.parent?.addChild(clone);

            return {
                success: true,
                message: `已复制节点: ${node.name}`,
                data: { uuid: clone.uuid, name: clone.name },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 将节点移动到另一个父节点下
     */
    moveNode(nodeUuid: string, newParentUuid: string) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene) return { success: false, error: '没有活动场景' };

            const node = scene.getChildByUuid(nodeUuid);
            if (!node) return { success: false, error: `未找到节点: ${nodeUuid}` };

            const newParent = scene.getChildByUuid(newParentUuid);
            if (!newParent) return { success: false, error: `未找到目标父节点: ${newParentUuid}` };

            node.removeFromParent();
            newParent.addChild(node);

            return { success: true, message: `节点 '${node.name}' 已移动到 '${newParent.name}' 下` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};
