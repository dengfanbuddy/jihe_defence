"use strict";
/**
 * 场景脚本 — 运行在 Cocos Creator 场景上下文中
 *
 * 通过 contributions.scene 注册，由 Editor.Message.request('scene', 'execute-scene-script', ...) 调用。
 * 这里的每个方法都有权访问 require('cc') 获取引擎 API（director、Node、Component 等）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
const path_1 = require("path");
module.paths.push((0, path_1.join)(Editor.App.path, 'node_modules'));
exports.methods = {
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
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 为节点添加组件
     */
    addComponentToNode(nodeUuid, componentType) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const CompClass = js.getClassByName(componentType);
            if (!CompClass)
                return { success: false, error: `未找到组件类型: ${componentType}` };
            const comp = node.addComponent(CompClass);
            return {
                success: true,
                message: `已添加组件 ${componentType}`,
                data: { componentId: comp.uuid },
            };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 移除节点上的组件
     */
    removeComponentFromNode(nodeUuid, componentType) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const CompClass = js.getClassByName(componentType);
            if (!CompClass)
                return { success: false, error: `未找到组件类型: ${componentType}` };
            const comp = node.getComponent(CompClass);
            if (!comp)
                return { success: false, error: `节点上无组件 ${componentType}` };
            node.removeComponent(comp);
            return { success: true, message: `已移除组件 ${componentType}` };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 在场景中创建新节点
     */
    createNode(name, parentUuid) {
        try {
            const { director, Node } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = new Node(name);
            if (parentUuid) {
                const parent = scene.getChildByUuid(parentUuid);
                if (parent) {
                    parent.addChild(node);
                }
                else {
                    scene.addChild(node);
                }
            }
            else {
                scene.addChild(node);
            }
            return {
                success: true,
                message: `节点 ${name} 已创建`,
                data: { uuid: node.uuid, name: node.name },
            };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 删除节点
     */
    deleteNode(nodeUuid) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const name = node.name;
            node.removeFromParent();
            node.destroy();
            return { success: true, message: `已删除节点: ${name}` };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 获取节点详情（Transform、组件列表等）
     */
    getNodeInfo(nodeUuid) {
        var _a;
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
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
                    parent: ((_a = node.parent) === null || _a === void 0 ? void 0 : _a.uuid) || null,
                    children: node.children.map((c) => c.uuid),
                    components: node.components.map((c) => ({
                        type: c.constructor.name,
                        enabled: c.enabled,
                    })),
                },
            };
        }
        catch (e) {
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
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const nodes = [];
            const walk = (node) => {
                var _a;
                nodes.push({
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    parent: ((_a = node.parent) === null || _a === void 0 ? void 0 : _a.uuid) || null,
                });
                node.children.forEach((c) => walk(c));
            };
            scene.children.forEach((c) => walk(c));
            return { success: true, data: nodes };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 按名称查找节点
     */
    findNodeByName(name) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const found = [];
            const walk = (node) => {
                var _a;
                if (node.name === name) {
                    found.push({
                        uuid: node.uuid,
                        name: node.name,
                        active: node.active,
                        parent: ((_a = node.parent) === null || _a === void 0 ? void 0 : _a.uuid) || null,
                    });
                }
                node.children.forEach((c) => walk(c));
            };
            scene.children.forEach((c) => walk(c));
            return { success: true, data: found };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 按组件类型查找节点
     */
    findNodesByComponent(componentType) {
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const CompClass = js.getClassByName(componentType);
            const found = [];
            const walk = (node) => {
                var _a;
                if (node.getComponent(CompClass)) {
                    found.push({
                        uuid: node.uuid,
                        name: node.name,
                        active: node.active,
                        parent: ((_a = node.parent) === null || _a === void 0 ? void 0 : _a.uuid) || null,
                    });
                }
                node.children.forEach((c) => walk(c));
            };
            scene.children.forEach((c) => walk(c));
            return { success: true, data: found };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 设置节点属性（Transform / active / name / layer / mobility）
     */
    setNodeProperty(nodeUuid, property, value) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            switch (property) {
                case 'position':
                    node.setPosition((_a = value === null || value === void 0 ? void 0 : value.x) !== null && _a !== void 0 ? _a : 0, (_b = value === null || value === void 0 ? void 0 : value.y) !== null && _b !== void 0 ? _b : 0, (_c = value === null || value === void 0 ? void 0 : value.z) !== null && _c !== void 0 ? _c : 0);
                    break;
                case 'rotation':
                    node.setRotationFromEuler((_d = value === null || value === void 0 ? void 0 : value.x) !== null && _d !== void 0 ? _d : 0, (_e = value === null || value === void 0 ? void 0 : value.y) !== null && _e !== void 0 ? _e : 0, (_f = value === null || value === void 0 ? void 0 : value.z) !== null && _f !== void 0 ? _f : 0);
                    break;
                case 'scale':
                    node.setScale((_g = value === null || value === void 0 ? void 0 : value.x) !== null && _g !== void 0 ? _g : 1, (_h = value === null || value === void 0 ? void 0 : value.y) !== null && _h !== void 0 ? _h : 1, (_j = value === null || value === void 0 ? void 0 : value.z) !== null && _j !== void 0 ? _j : 1);
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
                    node[property] = value;
            }
            return { success: true, message: `属性 '${property}' 已更新` };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 设置组件属性（支持 Sprite/Label/Button 等常见组件的特殊处理）
     */
    setComponentProperty(nodeUuid, componentType, property, value) {
        var _a, _b, _c, _d;
        try {
            const { director, js } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const CompClass = js.getClassByName(componentType);
            if (!CompClass)
                return { success: false, error: `未找到组件类型: ${componentType}` };
            const comp = node.getComponent(CompClass);
            if (!comp)
                return { success: false, error: `节点上无组件 ${componentType}` };
            // 特殊处理常见组件
            if (property === 'spriteFrame' && (componentType === 'cc.Sprite' || componentType === 'cc.Mask')) {
                if (typeof value === 'string') {
                    const { assetManager } = require('cc');
                    assetManager.loadAny({ uuid: value }, (_err, asset) => {
                        if (!_err && asset)
                            comp.spriteFrame = asset;
                    });
                }
                else {
                    comp.spriteFrame = value;
                }
            }
            else if (property === 'string' && (componentType === 'cc.Label' || componentType === 'cc.RichText')) {
                comp.string = String(value);
            }
            else if (property === 'color' && componentType === 'cc.Label') {
                const { Color } = require('cc');
                if (typeof value === 'object') {
                    comp.color = new Color((_a = value.r) !== null && _a !== void 0 ? _a : 255, (_b = value.g) !== null && _b !== void 0 ? _b : 255, (_c = value.b) !== null && _c !== void 0 ? _c : 255, (_d = value.a) !== null && _d !== void 0 ? _d : 255);
                }
                else {
                    comp.color = value;
                }
            }
            else if (property === 'material') {
                if (typeof value === 'string') {
                    const { assetManager } = require('cc');
                    assetManager.loadAny({ uuid: value }, (_err, asset) => {
                        if (!_err && asset)
                            comp.material = asset;
                    });
                }
                else {
                    comp.material = value;
                }
            }
            else if (property === 'fontSize' && componentType === 'cc.Label') {
                comp.fontSize = Number(value);
            }
            else if (property === 'lineHeight' && componentType === 'cc.Label') {
                comp.lineHeight = Number(value);
            }
            else {
                comp[property] = value;
            }
            return { success: true, message: `组件属性 '${property}' 已更新` };
        }
        catch (e) {
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
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const countNodes = (node) => {
                let count = 1;
                node.children.forEach((c) => (count += countNodes(c)));
                return count;
            };
            let nodeCount = 0;
            scene.children.forEach((c) => (nodeCount += countNodes(c)));
            return {
                success: true,
                data: {
                    name: scene.name,
                    uuid: scene.uuid,
                    nodeCount,
                    active: scene.active,
                },
            };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 获取完整场景层级树
     */
    getSceneHierarchy(includeComponents = false) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const processNode = (node) => {
                const result = {
                    name: node.name,
                    uuid: node.uuid,
                    active: node.active,
                    children: [],
                };
                if (includeComponents) {
                    result.components = node.components.map((c) => ({
                        type: c.constructor.name,
                        enabled: c.enabled,
                    }));
                }
                node.children.forEach((c) => result.children.push(processNode(c)));
                return result;
            };
            const hierarchy = scene.children.map((c) => processNode(c));
            return { success: true, data: hierarchy };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 将场景节点保存为预制体（收集节点信息供主进程序列化）
     */
    createPrefabFromNode(nodeUuid, _prefabPath) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            // 收集节点及其子树的关键信息供主进程创建预制体文件
            const collectNodeData = (n) => ({
                name: n.name,
                active: n.active,
                position: { x: n.position.x, y: n.position.y, z: n.position.z },
                rotation: { x: n.rotation.x, y: n.rotation.y, z: n.rotation.z },
                scale: { x: n.scale.x, y: n.scale.y, z: n.scale.z },
                layer: n.layer,
                mobility: n.mobility,
                components: n.components.map((c) => ({
                    type: c.constructor.name,
                })),
                children: n.children.map((c) => collectNodeData(c)),
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
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 复制节点（深拷贝）
     */
    duplicateNode(nodeUuid) {
        var _a;
        try {
            const { director, instantiate } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const clone = instantiate(node);
            clone.name = node.name + ' (Copy)';
            (_a = node.parent) === null || _a === void 0 ? void 0 : _a.addChild(clone);
            return {
                success: true,
                message: `已复制节点: ${node.name}`,
                data: { uuid: clone.uuid, name: clone.name },
            };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
    /**
     * 将节点移动到另一个父节点下
     */
    moveNode(nodeUuid, newParentUuid) {
        try {
            const { director } = require('cc');
            const scene = director.getScene();
            if (!scene)
                return { success: false, error: '没有活动场景' };
            const node = scene.getChildByUuid(nodeUuid);
            if (!node)
                return { success: false, error: `未找到节点: ${nodeUuid}` };
            const newParent = scene.getChildByUuid(newParentUuid);
            if (!newParent)
                return { success: false, error: `未找到目标父节点: ${newParentUuid}` };
            node.removeFromParent();
            newParent.addChild(node);
            return { success: true, message: `节点 '${node.name}' 已移动到 '${newParent.name}' 下` };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7QUFFSCwrQkFBNEI7QUFDNUIsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUU1QyxRQUFBLE9BQU8sR0FBNEM7SUFFNUQ7O09BRUc7SUFDSCxjQUFjO1FBQ1YsSUFBSSxDQUFDO1lBQ0QsTUFBTSxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDMUMsTUFBTSxLQUFLLEdBQUcsSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUMxQixLQUFLLENBQUMsSUFBSSxHQUFHLFdBQVcsQ0FBQztZQUN6QixRQUFRLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3pCLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsQ0FBQztRQUNoRCxDQUFDO1FBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztZQUNkLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDaEQsQ0FBQztJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNILGtCQUFrQixDQUFDLFFBQWdCLEVBQUUsYUFBcUI7UUFDdEQsSUFBSSxDQUFDO1lBQ0QsTUFBTSxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDdkMsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2xDLElBQUksQ0FBQyxLQUFLO2dCQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFB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6L+Q6KGM5ZyoIENvY29zIENyZWF0b3Ig5Zy65pmv5LiK5LiL5paH5LitXG4gKlxuICog6YCa6L+HIGNvbnRyaWJ1dGlvbnMuc2NlbmUg5rOo5YaM77yM55SxIEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0JywgLi4uKSDosIPnlKjjgIJcbiAqIOi/memHjOeahOavj+S4quaWueazlemDveacieadg+iuv+mXriByZXF1aXJlKCdjYycpIOiOt+WPluW8leaTjiBBUEnvvIhkaXJlY3RvcuOAgU5vZGXjgIFDb21wb25lbnQg562J77yJ44CCXG4gKi9cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xubW9kdWxlLnBhdGhzLnB1c2goam9pbihFZGl0b3IuQXBwLnBhdGgsICdub2RlX21vZHVsZXMnKSk7XG5cbmV4cG9ydCBjb25zdCBtZXRob2RzOiB7IFtrZXk6IHN0cmluZ106ICguLi5hbnk6IGFueSkgPT4gYW55IH0gPSB7XG5cbiAgICAvKipcbiAgICAgKiDliJvlu7rnqbrnmb3mlrDlnLrmma9cbiAgICAgKi9cbiAgICBjcmVhdGVOZXdTY2VuZSgpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGlyZWN0b3IsIFNjZW5lIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBuZXcgU2NlbmUoKTtcbiAgICAgICAgICAgIHNjZW5lLm5hbWUgPSAnTmV3IFNjZW5lJztcbiAgICAgICAgICAgIGRpcmVjdG9yLnJ1blNjZW5lKHNjZW5lKTtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6ICfmlrDlnLrmma/lt7LliJvlu7onIH07XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDkuLroioLngrnmt7vliqDnu4Tku7ZcbiAgICAgKi9cbiAgICBhZGRDb21wb25lbnRUb05vZGUobm9kZVV1aWQ6IHN0cmluZywgY29tcG9uZW50VHlwZTogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yLCBqcyB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgICAgIGlmICghc2NlbmUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ+ayoeaciea0u+WKqOWcuuaZrycgfTtcblxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lLmdldENoaWxkQnlVdWlkKG5vZGVVdWlkKTtcbiAgICAgICAgICAgIGlmICghbm9kZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBg5pyq5om+5Yiw6IqC54K5OiAke25vZGVVdWlkfWAgfTtcblxuICAgICAgICAgICAgY29uc3QgQ29tcENsYXNzID0ganMuZ2V0Q2xhc3NCeU5hbWUoY29tcG9uZW50VHlwZSk7XG4gICAgICAgICAgICBpZiAoIUNvbXBDbGFzcykgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBg5pyq5om+5Yiw57uE5Lu257G75Z6LOiAke2NvbXBvbmVudFR5cGV9YCB9O1xuXG4gICAgICAgICAgICBjb25zdCBjb21wID0gbm9kZS5hZGRDb21wb25lbnQoQ29tcENsYXNzKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5bey5re75Yqg57uE5Lu2ICR7Y29tcG9uZW50VHlwZX1gLFxuICAgICAgICAgICAgICAgIGRhdGE6IHsgY29tcG9uZW50SWQ6IGNvbXAudXVpZCB9LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOenu+mZpOiKgueCueS4iueahOe7hOS7tlxuICAgICAqL1xuICAgIHJlbW92ZUNvbXBvbmVudEZyb21Ob2RlKG5vZGVVdWlkOiBzdHJpbmcsIGNvbXBvbmVudFR5cGU6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciwganMgfSA9IHJlcXVpcmUoJ2NjJyk7XG4gICAgICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XG4gICAgICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICfmsqHmnInmtLvliqjlnLrmma8nIH07XG5cbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBzY2VuZS5nZXRDaGlsZEJ5VXVpZChub2RlVXVpZCk7XG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYOacquaJvuWIsOiKgueCuTogJHtub2RlVXVpZH1gIH07XG5cbiAgICAgICAgICAgIGNvbnN0IENvbXBDbGFzcyA9IGpzLmdldENsYXNzQnlOYW1lKGNvbXBvbmVudFR5cGUpO1xuICAgICAgICAgICAgaWYgKCFDb21wQ2xhc3MpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYOacquaJvuWIsOe7hOS7tuexu+WeizogJHtjb21wb25lbnRUeXBlfWAgfTtcblxuICAgICAgICAgICAgY29uc3QgY29tcCA9IG5vZGUuZ2V0Q29tcG9uZW50KENvbXBDbGFzcyk7XG4gICAgICAgICAgICBpZiAoIWNvbXApIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYOiKgueCueS4iuaXoOe7hOS7tiAke2NvbXBvbmVudFR5cGV9YCB9O1xuXG4gICAgICAgICAgICBub2RlLnJlbW92ZUNvbXBvbmVudChjb21wKTtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IGDlt7Lnp7vpmaTnu4Tku7YgJHtjb21wb25lbnRUeXBlfWAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWcqOWcuuaZr+S4reWIm+W7uuaWsOiKgueCuVxuICAgICAqL1xuICAgIGNyZWF0ZU5vZGUobmFtZTogc3RyaW5nLCBwYXJlbnRVdWlkPzogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yLCBOb2RlIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gbmV3IE5vZGUobmFtZSk7XG4gICAgICAgICAgICBpZiAocGFyZW50VXVpZCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBhcmVudCA9IHNjZW5lLmdldENoaWxkQnlVdWlkKHBhcmVudFV1aWQpO1xuICAgICAgICAgICAgICAgIGlmIChwYXJlbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKG5vZGUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNjZW5lLmFkZENoaWxkKG5vZGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NlbmUuYWRkQ2hpbGQobm9kZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg6IqC54K5ICR7bmFtZX0g5bey5Yib5bu6YCxcbiAgICAgICAgICAgICAgICBkYXRhOiB7IHV1aWQ6IG5vZGUudXVpZCwgbmFtZTogbm9kZS5uYW1lIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5Yig6Zmk6IqC54K5XG4gICAgICovXG4gICAgZGVsZXRlTm9kZShub2RlVXVpZDogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQobm9kZVV1aWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDoioLngrk6ICR7bm9kZVV1aWR9YCB9O1xuXG4gICAgICAgICAgICBjb25zdCBuYW1lID0gbm9kZS5uYW1lO1xuICAgICAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XG4gICAgICAgICAgICBub2RlLmRlc3Ryb3koKTtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IGDlt7LliKDpmaToioLngrk6ICR7bmFtZX1gIH07XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDojrflj5boioLngrnor6bmg4XvvIhUcmFuc2Zvcm3jgIHnu4Tku7bliJfooajnrYnvvIlcbiAgICAgKi9cbiAgICBnZXROb2RlSW5mbyhub2RlVXVpZDogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQobm9kZVV1aWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDoioLngrk6ICR7bm9kZVV1aWR9YCB9O1xuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYWN0aXZlOiBub2RlLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogbm9kZS5wb3NpdGlvbi54LCB5OiBub2RlLnBvc2l0aW9uLnksIHo6IG5vZGUucG9zaXRpb24ueiB9LFxuICAgICAgICAgICAgICAgICAgICByb3RhdGlvbjogeyB4OiBub2RlLnJvdGF0aW9uLngsIHk6IG5vZGUucm90YXRpb24ueSwgejogbm9kZS5yb3RhdGlvbi56IH0sXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiB7IHg6IG5vZGUuc2NhbGUueCwgeTogbm9kZS5zY2FsZS55LCB6OiBub2RlLnNjYWxlLnogfSxcbiAgICAgICAgICAgICAgICAgICAgbGF5ZXI6IG5vZGUubGF5ZXIsXG4gICAgICAgICAgICAgICAgICAgIG1vYmlsaXR5OiBub2RlLm1vYmlsaXR5LFxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQ6IG5vZGUucGFyZW50Py51dWlkIHx8IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkcmVuOiBub2RlLmNoaWxkcmVuLm1hcCgoYzogYW55KSA9PiBjLnV1aWQpLFxuICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBub2RlLmNvbXBvbmVudHMubWFwKChjOiBhbnkpID0+ICh7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBjLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBlbmFibGVkOiBjLmVuYWJsZWQsXG4gICAgICAgICAgICAgICAgICAgIH0pKSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOiOt+WPluWcuuaZr+S4reaJgOacieiKgueCue+8iOaJgeW5s+WIl+ihqO+8iVxuICAgICAqL1xuICAgIGdldEFsbE5vZGVzKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgICAgIGlmICghc2NlbmUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ+ayoeaciea0u+WKqOWcuuaZrycgfTtcblxuICAgICAgICAgICAgY29uc3Qgbm9kZXM6IGFueVtdID0gW107XG4gICAgICAgICAgICBjb25zdCB3YWxrID0gKG5vZGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgIG5vZGVzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYWN0aXZlOiBub2RlLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50OiBub2RlLnBhcmVudD8udXVpZCB8fCBudWxsLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoYzogYW55KSA9PiB3YWxrKGMpKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBzY2VuZS5jaGlsZHJlbi5mb3JFYWNoKChjOiBhbnkpID0+IHdhbGsoYykpO1xuXG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhOiBub2RlcyB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5oyJ5ZCN56ew5p+l5om+6IqC54K5XG4gICAgICovXG4gICAgZmluZE5vZGVCeU5hbWUobmFtZTogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBmb3VuZDogYW55W10gPSBbXTtcbiAgICAgICAgICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKG5vZGUubmFtZSA9PT0gbmFtZSkge1xuICAgICAgICAgICAgICAgICAgICBmb3VuZC5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHV1aWQ6IG5vZGUudXVpZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjdGl2ZTogbm9kZS5hY3RpdmUsXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJlbnQ6IG5vZGUucGFyZW50Py51dWlkIHx8IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGM6IGFueSkgPT4gd2FsayhjKSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgc2NlbmUuY2hpbGRyZW4uZm9yRWFjaCgoYzogYW55KSA9PiB3YWxrKGMpKTtcblxuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZGF0YTogZm91bmQgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOaMiee7hOS7tuexu+Wei+afpeaJvuiKgueCuVxuICAgICAqL1xuICAgIGZpbmROb2Rlc0J5Q29tcG9uZW50KGNvbXBvbmVudFR5cGU6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciwganMgfSA9IHJlcXVpcmUoJ2NjJyk7XG4gICAgICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XG4gICAgICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICfmsqHmnInmtLvliqjlnLrmma8nIH07XG5cbiAgICAgICAgICAgIGNvbnN0IENvbXBDbGFzcyA9IGpzLmdldENsYXNzQnlOYW1lKGNvbXBvbmVudFR5cGUpO1xuICAgICAgICAgICAgY29uc3QgZm91bmQ6IGFueVtdID0gW107XG4gICAgICAgICAgICBjb25zdCB3YWxrID0gKG5vZGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChub2RlLmdldENvbXBvbmVudChDb21wQ2xhc3MpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgdXVpZDogbm9kZS51dWlkLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgYWN0aXZlOiBub2RlLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcmVudDogbm9kZS5wYXJlbnQ/LnV1aWQgfHwgbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoYzogYW55KSA9PiB3YWxrKGMpKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBzY2VuZS5jaGlsZHJlbi5mb3JFYWNoKChjOiBhbnkpID0+IHdhbGsoYykpO1xuXG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhOiBmb3VuZCB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog6K6+572u6IqC54K55bGe5oCn77yIVHJhbnNmb3JtIC8gYWN0aXZlIC8gbmFtZSAvIGxheWVyIC8gbW9iaWxpdHnvvIlcbiAgICAgKi9cbiAgICBzZXROb2RlUHJvcGVydHkobm9kZVV1aWQ6IHN0cmluZywgcHJvcGVydHk6IHN0cmluZywgdmFsdWU6IGFueSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgICAgIGlmICghc2NlbmUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ+ayoeaciea0u+WKqOWcuuaZrycgfTtcblxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lLmdldENoaWxkQnlVdWlkKG5vZGVVdWlkKTtcbiAgICAgICAgICAgIGlmICghbm9kZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBg5pyq5om+5Yiw6IqC54K5OiAke25vZGVVdWlkfWAgfTtcblxuICAgICAgICAgICAgc3dpdGNoIChwcm9wZXJ0eSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ3Bvc2l0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgbm9kZS5zZXRQb3NpdGlvbih2YWx1ZT8ueCA/PyAwLCB2YWx1ZT8ueSA/PyAwLCB2YWx1ZT8ueiA/PyAwKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAncm90YXRpb24nOlxuICAgICAgICAgICAgICAgICAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKHZhbHVlPy54ID8/IDAsIHZhbHVlPy55ID8/IDAsIHZhbHVlPy56ID8/IDApO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICdzY2FsZSc6XG4gICAgICAgICAgICAgICAgICAgIG5vZGUuc2V0U2NhbGUodmFsdWU/LnggPz8gMSwgdmFsdWU/LnkgPz8gMSwgdmFsdWU/LnogPz8gMSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FjdGl2ZSc6XG4gICAgICAgICAgICAgICAgICAgIG5vZGUuYWN0aXZlID0gISF2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAnbmFtZSc6XG4gICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSA9IFN0cmluZyh2YWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ2xheWVyJzpcbiAgICAgICAgICAgICAgICAgICAgbm9kZS5sYXllciA9IE51bWJlcih2YWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ21vYmlsaXR5JzpcbiAgICAgICAgICAgICAgICAgICAgbm9kZS5tb2JpbGl0eSA9IE51bWJlcih2YWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIChub2RlIGFzIGFueSlbcHJvcGVydHldID0gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IGDlsZ7mgKcgJyR7cHJvcGVydHl9JyDlt7Lmm7TmlrBgIH07XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDorr7nva7nu4Tku7blsZ7mgKfvvIjmlK/mjIEgU3ByaXRlL0xhYmVsL0J1dHRvbiDnrYnluLjop4Hnu4Tku7bnmoTnibnmrorlpITnkIbvvIlcbiAgICAgKi9cbiAgICBzZXRDb21wb25lbnRQcm9wZXJ0eShub2RlVXVpZDogc3RyaW5nLCBjb21wb25lbnRUeXBlOiBzdHJpbmcsIHByb3BlcnR5OiBzdHJpbmcsIHZhbHVlOiBhbnkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGlyZWN0b3IsIGpzIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQobm9kZVV1aWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDoioLngrk6ICR7bm9kZVV1aWR9YCB9O1xuXG4gICAgICAgICAgICBjb25zdCBDb21wQ2xhc3MgPSBqcy5nZXRDbGFzc0J5TmFtZShjb21wb25lbnRUeXBlKTtcbiAgICAgICAgICAgIGlmICghQ29tcENsYXNzKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDnu4Tku7bnsbvlnos6ICR7Y29tcG9uZW50VHlwZX1gIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbXAgPSBub2RlLmdldENvbXBvbmVudChDb21wQ2xhc3MpO1xuICAgICAgICAgICAgaWYgKCFjb21wKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDoioLngrnkuIrml6Dnu4Tku7YgJHtjb21wb25lbnRUeXBlfWAgfTtcblxuICAgICAgICAgICAgLy8g54m55q6K5aSE55CG5bi46KeB57uE5Lu2XG4gICAgICAgICAgICBpZiAocHJvcGVydHkgPT09ICdzcHJpdGVGcmFtZScgJiYgKGNvbXBvbmVudFR5cGUgPT09ICdjYy5TcHJpdGUnIHx8IGNvbXBvbmVudFR5cGUgPT09ICdjYy5NYXNrJykpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB7IGFzc2V0TWFuYWdlciB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkOiB2YWx1ZSB9LCAoX2VycjogYW55LCBhc3NldDogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV9lcnIgJiYgYXNzZXQpIGNvbXAuc3ByaXRlRnJhbWUgPSBhc3NldDtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29tcC5zcHJpdGVGcmFtZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcGVydHkgPT09ICdzdHJpbmcnICYmIChjb21wb25lbnRUeXBlID09PSAnY2MuTGFiZWwnIHx8IGNvbXBvbmVudFR5cGUgPT09ICdjYy5SaWNoVGV4dCcpKSB7XG4gICAgICAgICAgICAgICAgY29tcC5zdHJpbmcgPSBTdHJpbmcodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wZXJ0eSA9PT0gJ2NvbG9yJyAmJiBjb21wb25lbnRUeXBlID09PSAnY2MuTGFiZWwnKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyBDb2xvciB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICBjb21wLmNvbG9yID0gbmV3IENvbG9yKHZhbHVlLnIgPz8gMjU1LCB2YWx1ZS5nID8/IDI1NSwgdmFsdWUuYiA/PyAyNTUsIHZhbHVlLmEgPz8gMjU1KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb21wLmNvbG9yID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wZXJ0eSA9PT0gJ21hdGVyaWFsJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHsgYXNzZXRNYW5hZ2VyIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgICAgICAgICBhc3NldE1hbmFnZXIubG9hZEFueSh7IHV1aWQ6IHZhbHVlIH0sIChfZXJyOiBhbnksIGFzc2V0OiBhbnkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghX2VyciAmJiBhc3NldCkgY29tcC5tYXRlcmlhbCA9IGFzc2V0O1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb21wLm1hdGVyaWFsID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wZXJ0eSA9PT0gJ2ZvbnRTaXplJyAmJiBjb21wb25lbnRUeXBlID09PSAnY2MuTGFiZWwnKSB7XG4gICAgICAgICAgICAgICAgY29tcC5mb250U2l6ZSA9IE51bWJlcih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BlcnR5ID09PSAnbGluZUhlaWdodCcgJiYgY29tcG9uZW50VHlwZSA9PT0gJ2NjLkxhYmVsJykge1xuICAgICAgICAgICAgICAgIGNvbXAubGluZUhlaWdodCA9IE51bWJlcih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIChjb21wIGFzIGFueSlbcHJvcGVydHldID0gdmFsdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IGDnu4Tku7blsZ7mgKcgJyR7cHJvcGVydHl9JyDlt7Lmm7TmlrBgIH07XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDojrflj5blvZPliY3lnLrmma/ln7rmnKzkv6Hmga9cbiAgICAgKi9cbiAgICBnZXRDdXJyZW50U2NlbmVJbmZvKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciB9ID0gcmVxdWlyZSgnY2MnKTtcbiAgICAgICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgICAgIGlmICghc2NlbmUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ+ayoeaciea0u+WKqOWcuuaZrycgfTtcblxuICAgICAgICAgICAgY29uc3QgY291bnROb2RlcyA9IChub2RlOiBhbnkpOiBudW1iZXIgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb3VudCA9IDE7XG4gICAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjOiBhbnkpID0+IChjb3VudCArPSBjb3VudE5vZGVzKGMpKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvdW50O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGxldCBub2RlQ291bnQgPSAwO1xuICAgICAgICAgICAgc2NlbmUuY2hpbGRyZW4uZm9yRWFjaCgoYzogYW55KSA9PiAobm9kZUNvdW50ICs9IGNvdW50Tm9kZXMoYykpKTtcblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogc2NlbmUubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdXVpZDogc2NlbmUudXVpZCxcbiAgICAgICAgICAgICAgICAgICAgbm9kZUNvdW50LFxuICAgICAgICAgICAgICAgICAgICBhY3RpdmU6IHNjZW5lLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOiOt+WPluWujOaVtOWcuuaZr+Wxgue6p+agkVxuICAgICAqL1xuICAgIGdldFNjZW5lSGllcmFyY2h5KGluY2x1ZGVDb21wb25lbnRzOiBib29sZWFuID0gZmFsc2UpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGlyZWN0b3IgfSA9IHJlcXVpcmUoJ2NjJyk7XG4gICAgICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XG4gICAgICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICfmsqHmnInmtLvliqjlnLrmma8nIH07XG5cbiAgICAgICAgICAgIGNvbnN0IHByb2Nlc3NOb2RlID0gKG5vZGU6IGFueSk6IGFueSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSB7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdXVpZDogbm9kZS51dWlkLFxuICAgICAgICAgICAgICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlLFxuICAgICAgICAgICAgICAgICAgICBjaGlsZHJlbjogW10sXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBpZiAoaW5jbHVkZUNvbXBvbmVudHMpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0LmNvbXBvbmVudHMgPSBub2RlLmNvbXBvbmVudHMubWFwKChjOiBhbnkpID0+ICh7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBjLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBlbmFibGVkOiBjLmVuYWJsZWQsXG4gICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjOiBhbnkpID0+IHJlc3VsdC5jaGlsZHJlbi5wdXNoKHByb2Nlc3NOb2RlKGMpKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGhpZXJhcmNoeSA9IHNjZW5lLmNoaWxkcmVuLm1hcCgoYzogYW55KSA9PiBwcm9jZXNzTm9kZShjKSk7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhOiBoaWVyYXJjaHkgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWwhuWcuuaZr+iKgueCueS/neWtmOS4uumihOWItuS9k++8iOaUtumbhuiKgueCueS/oeaBr+S+m+S4u+i/m+eoi+W6j+WIl+WMlu+8iVxuICAgICAqL1xuICAgIGNyZWF0ZVByZWZhYkZyb21Ob2RlKG5vZGVVdWlkOiBzdHJpbmcsIF9wcmVmYWJQYXRoPzogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQobm9kZVV1aWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDoioLngrk6ICR7bm9kZVV1aWR9YCB9O1xuXG4gICAgICAgICAgICAvLyDmlLbpm4boioLngrnlj4rlhbblrZDmoJHnmoTlhbPplK7kv6Hmga/kvpvkuLvov5vnqIvliJvlu7rpooTliLbkvZPmlofku7ZcbiAgICAgICAgICAgIGNvbnN0IGNvbGxlY3ROb2RlRGF0YSA9IChuOiBhbnkpOiBhbnkgPT4gKHtcbiAgICAgICAgICAgICAgICBuYW1lOiBuLm5hbWUsXG4gICAgICAgICAgICAgICAgYWN0aXZlOiBuLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiBuLnBvc2l0aW9uLngsIHk6IG4ucG9zaXRpb24ueSwgejogbi5wb3NpdGlvbi56IH0sXG4gICAgICAgICAgICAgICAgcm90YXRpb246IHsgeDogbi5yb3RhdGlvbi54LCB5OiBuLnJvdGF0aW9uLnksIHo6IG4ucm90YXRpb24ueiB9LFxuICAgICAgICAgICAgICAgIHNjYWxlOiB7IHg6IG4uc2NhbGUueCwgeTogbi5zY2FsZS55LCB6OiBuLnNjYWxlLnogfSxcbiAgICAgICAgICAgICAgICBsYXllcjogbi5sYXllcixcbiAgICAgICAgICAgICAgICBtb2JpbGl0eTogbi5tb2JpbGl0eSxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBuLmNvbXBvbmVudHMubWFwKChjOiBhbnkpID0+ICh7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IGMuY29uc3RydWN0b3IubmFtZSxcbiAgICAgICAgICAgICAgICB9KSksXG4gICAgICAgICAgICAgICAgY2hpbGRyZW46IG4uY2hpbGRyZW4ubWFwKChjOiBhbnkpID0+IGNvbGxlY3ROb2RlRGF0YShjKSksXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlTm9kZVV1aWQ6IG5vZGVVdWlkLFxuICAgICAgICAgICAgICAgICAgICBub2RlTmFtZTogbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICB0cmVlOiBjb2xsZWN0Tm9kZURhdGEobm9kZSksXG4gICAgICAgICAgICAgICAgICAgIHByZWZhYlBhdGg6IF9wcmVmYWJQYXRoIHx8IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDoioLngrkgJyR7bm9kZS5uYW1lfScg5pWw5o2u5bey5pS26ZuG77yM5YeG5aSH5Yib5bu66aKE5Yi25L2TYCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOWkjeWItuiKgueCue+8iOa3seaLt+i0ne+8iVxuICAgICAqL1xuICAgIGR1cGxpY2F0ZU5vZGUobm9kZVV1aWQ6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBkaXJlY3RvciwgaW5zdGFudGlhdGUgfSA9IHJlcXVpcmUoJ2NjJyk7XG4gICAgICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XG4gICAgICAgICAgICBpZiAoIXNjZW5lKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICfmsqHmnInmtLvliqjlnLrmma8nIH07XG5cbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBzY2VuZS5nZXRDaGlsZEJ5VXVpZChub2RlVXVpZCk7XG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYOacquaJvuWIsOiKgueCuTogJHtub2RlVXVpZH1gIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGNsb25lID0gaW5zdGFudGlhdGUobm9kZSk7XG4gICAgICAgICAgICBjbG9uZS5uYW1lID0gbm9kZS5uYW1lICsgJyAoQ29weSknO1xuICAgICAgICAgICAgbm9kZS5wYXJlbnQ/LmFkZENoaWxkKGNsb25lKTtcblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlt7LlpI3liLboioLngrk6ICR7bm9kZS5uYW1lfWAsXG4gICAgICAgICAgICAgICAgZGF0YTogeyB1dWlkOiBjbG9uZS51dWlkLCBuYW1lOiBjbG9uZS5uYW1lIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5bCG6IqC54K556e75Yqo5Yiw5Y+m5LiA5Liq54i26IqC54K55LiLXG4gICAgICovXG4gICAgbW92ZU5vZGUobm9kZVV1aWQ6IHN0cmluZywgbmV3UGFyZW50VXVpZDogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGRpcmVjdG9yIH0gPSByZXF1aXJlKCdjYycpO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAn5rKh5pyJ5rS75Yqo5Zy65pmvJyB9O1xuXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2NlbmUuZ2V0Q2hpbGRCeVV1aWQobm9kZVV1aWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDoioLngrk6ICR7bm9kZVV1aWR9YCB9O1xuXG4gICAgICAgICAgICBjb25zdCBuZXdQYXJlbnQgPSBzY2VuZS5nZXRDaGlsZEJ5VXVpZChuZXdQYXJlbnRVdWlkKTtcbiAgICAgICAgICAgIGlmICghbmV3UGFyZW50KSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGDmnKrmib7liLDnm67moIfniLboioLngrk6ICR7bmV3UGFyZW50VXVpZH1gIH07XG5cbiAgICAgICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xuICAgICAgICAgICAgbmV3UGFyZW50LmFkZENoaWxkKG5vZGUpO1xuXG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBtZXNzYWdlOiBg6IqC54K5ICcke25vZGUubmFtZX0nIOW3suenu+WKqOWIsCAnJHtuZXdQYXJlbnQubmFtZX0nIOS4i2AgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgfSxcbn07XG4iXX0=