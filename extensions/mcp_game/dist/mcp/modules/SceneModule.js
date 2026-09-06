"use strict";
/**
 * 场景模块 — 场景生命周期 + 节点/组件操作
 *
 * 双通道架构：
 * 1. Editor.Message.request('scene', ...) — 编辑器级操作（打开/保存/关闭场景等）
 * 2. executeSceneScript(method, args) — 场景脚本操作（节点/组件 CRUD）
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SceneModule = void 0;
const decorators_1 = require("../decorators");
/** 调用 Cocos 内置 scene 扩展消息 */
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
/** 调用我们自己的场景脚本方法（contributions.scene） */
async function executeSceneScript(method, args = []) {
    try {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
        return result;
    }
    catch (e) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}
/** 安全调用 asset-db 扩展 */
async function callAssetDB(method, ...args) {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    }
    catch (e) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}
// ==================== 场景 JSON 模板 ====================
function buildSceneJSON(sceneName) {
    return JSON.stringify([
        {
            "__type__": "cc.SceneAsset",
            "_name": sceneName,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_native": "",
            "scene": { "__id__": 1 },
        },
        {
            "__type__": "cc.Scene",
            "_name": sceneName,
            "_objFlags": 0,
            "__editorExtras__": {},
            "_parent": null,
            "_children": [],
            "_active": true,
            "_components": [],
            "_prefab": null,
            "_lpos": { "__type__": "cc.Vec3", "x": 0, "y": 0, "z": 0 },
            "_lrot": { "__type__": "cc.Quat", "x": 0, "y": 0, "z": 0, "w": 1 },
            "_lscale": { "__type__": "cc.Vec3", "x": 1, "y": 1, "z": 1 },
            "_mobility": 0,
            "_layer": 1073741824,
            "_euler": { "__type__": "cc.Vec3", "x": 0, "y": 0, "z": 0 },
            "autoReleaseAssets": false,
            "_globals": { "__id__": 2 },
            "_id": "scene",
        },
        {
            "__type__": "cc.SceneGlobals",
            "ambient": { "__id__": 3 },
            "skybox": { "__id__": 4 },
            "fog": { "__id__": 5 },
            "octree": { "__id__": 6 },
        },
        {
            "__type__": "cc.AmbientInfo",
            "_skyColorHDR": { "__type__": "cc.Vec4", "x": 0.2, "y": 0.5, "z": 0.8, "w": 0.520833 },
            "_skyColor": { "__type__": "cc.Vec4", "x": 0.2, "y": 0.5, "z": 0.8, "w": 0.520833 },
            "_skyIllumHDR": 20000,
            "_skyIllum": 20000,
            "_groundAlbedoHDR": { "__type__": "cc.Vec4", "x": 0.2, "y": 0.2, "z": 0.2, "w": 1 },
            "_groundAlbedo": { "__type__": "cc.Vec4", "x": 0.2, "y": 0.2, "z": 0.2, "w": 1 },
        },
        {
            "__type__": "cc.SkyboxInfo",
            "_envLightingType": 0,
            "_envmapHDR": null, "_envmap": null, "_envmapLodCount": 0,
            "_diffuseMapHDR": null, "_diffuseMap": null,
            "_enabled": false, "_useHDR": true,
            "_editableMaterial": null, "_reflectionHDR": null, "_reflectionMap": null,
            "_rotationAngle": 0,
        },
        {
            "__type__": "cc.FogInfo",
            "_type": 0,
            "_fogColor": { "__type__": "cc.Color", "r": 200, "g": 200, "b": 200, "a": 255 },
            "_enabled": false, "_fogDensity": 0.3, "_fogStart": 0.5, "_fogEnd": 300,
            "_fogAtten": 5, "_fogTop": 1.5, "_fogRange": 1.2, "_accurate": false,
        },
        {
            "__type__": "cc.OctreeInfo",
            "_enabled": false,
            "_minPos": { "__type__": "cc.Vec3", "x": -1024, "y": -1024, "z": -1024 },
            "_maxPos": { "__type__": "cc.Vec3", "x": 1024, "y": 1024, "z": 1024 },
            "_depth": 8,
        },
    ], null, 2);
}
let SceneModule = class SceneModule {
    // ==================== 场景生命周期 ====================
    async get_scene_list(params) {
        const folder = (params === null || params === void 0 ? void 0 : params.folder) || 'db://assets';
        const pattern = folder.endsWith('/') ? `${folder}**/*.scene` : `${folder}/**/*.scene`;
        const results = await callAssetDB('query-assets', { pattern });
        const scenes = (results || []).map((a) => ({
            name: a.name,
            path: a.url,
            uuid: a.uuid,
        }));
        return { scenes };
    }
    async open_scene(params) {
        const uuid = await callAssetDB('query-uuid', params.scenePath);
        if (!uuid)
            throw new Error(`未找到场景: ${params.scenePath}`);
        await callScene('open-scene', uuid);
        return { message: `已打开场景: ${params.scenePath}` };
    }
    async save_scene() {
        await callScene('save-scene');
        return { message: '场景已保存' };
    }
    async save_scene_as(_params) {
        await callScene('save-as-scene');
        return { message: '已打开另存对话框' };
    }
    async close_scene() {
        await callScene('close-scene');
        return { message: '场景已关闭' };
    }
    async create_scene(params) {
        const fullPath = params.savePath.endsWith('.scene') ? params.savePath : `${params.savePath}/${params.sceneName}.scene`;
        const content = buildSceneJSON(params.sceneName);
        const result = await callAssetDB('create-asset', fullPath, content);
        return {
            message: `场景 '${params.sceneName}' 已创建`,
            uuid: result === null || result === void 0 ? void 0 : result.uuid,
            url: result === null || result === void 0 ? void 0 : result.url,
        };
    }
    // ==================== 场景查询（原有工具，统一命名） ====================
    async query_current_scene() {
        return callScene('query-current-scene');
    }
    async query_node_tree(params) {
        var _a, _b;
        // 使用双通道：先尝试 Editor API，失败则用场景脚本
        try {
            const tree = await callScene('query-node-tree', params === null || params === void 0 ? void 0 : params.uuid);
            if (tree) {
                const includeComps = String((_a = params === null || params === void 0 ? void 0 : params.includeComponents) !== null && _a !== void 0 ? _a : '') === 'true';
                if (includeComps) {
                    return this.enrichWithComponents(tree);
                }
                return tree;
            }
            throw new Error('query-node-tree 返回空');
        }
        catch (_c) {
            const includeComps = String((_b = params === null || params === void 0 ? void 0 : params.includeComponents) !== null && _b !== void 0 ? _b : '') === 'true';
            return executeSceneScript('getSceneHierarchy', [includeComps]);
        }
    }
    async query_node(params) {
        // 先试 scene API，失败则用场景脚本
        try {
            const result = await callScene('query-node', params.uuid);
            if (result)
                return result;
            throw new Error('query-node 返回空');
        }
        catch (_a) {
            return executeSceneScript('getNodeInfo', [params.uuid]);
        }
    }
    async query_component(params) {
        return callScene('query-component', params.nodeUuid, params.componentType);
    }
    async query_scene_json() {
        return callScene('query-scene-json');
    }
    async query_classes() {
        return callScene('query-classes');
    }
    async query_components(params) {
        return callScene('query-components', params.uuid);
    }
    async query_is_ready() {
        return callScene('query-is-ready');
    }
    async query_dirty() {
        return callScene('query-dirty');
    }
    // ==================== 节点操作（通过场景脚本） ====================
    async get_all_nodes(params) {
        return executeSceneScript('getAllNodes');
    }
    async find_node_by_name(params) {
        return executeSceneScript('findNodeByName', [params.name]);
    }
    async find_nodes_by_component(params) {
        return executeSceneScript('findNodesByComponent', [params.componentType]);
    }
    async get_scene_hierarchy(params) {
        var _a;
        const includeComps = String((_a = params === null || params === void 0 ? void 0 : params.includeComponents) !== null && _a !== void 0 ? _a : '') === 'true';
        return executeSceneScript('getSceneHierarchy', [includeComps]);
    }
    async create_node(params) {
        return executeSceneScript('createNode', [params.name, params.parentUuid]);
    }
    async delete_node(params) {
        return executeSceneScript('deleteNode', [params.uuid]);
    }
    async duplicate_node(params) {
        return executeSceneScript('duplicateNode', [params.uuid]);
    }
    async move_node(params) {
        return executeSceneScript('moveNode', [params.uuid, params.newParentUuid]);
    }
    async set_node_property(params) {
        const value = JSON.parse(params.value);
        return executeSceneScript('setNodeProperty', [params.uuid, params.property, value]);
    }
    async set_node_transform(params) {
        if (params.position) {
            const pos = JSON.parse(params.position);
            await executeSceneScript('setNodeProperty', [params.uuid, 'position', pos]);
        }
        if (params.rotation) {
            const rot = JSON.parse(params.rotation);
            await executeSceneScript('setNodeProperty', [params.uuid, 'rotation', rot]);
        }
        if (params.scale) {
            const scl = JSON.parse(params.scale);
            await executeSceneScript('setNodeProperty', [params.uuid, 'scale', scl]);
        }
        return { message: 'Transform 已更新' };
    }
    // ==================== 组件操作（通过场景脚本） ====================
    async add_component(params) {
        return executeSceneScript('addComponentToNode', [params.nodeUuid, params.componentType]);
    }
    async remove_component(params) {
        return executeSceneScript('removeComponentFromNode', [params.nodeUuid, params.componentType]);
    }
    async set_component_property(params) {
        const value = JSON.parse(params.value);
        return executeSceneScript('setComponentProperty', [params.nodeUuid, params.componentType, params.property, value]);
    }
    // ==================== 场景脚本执行 ====================
    async execute_scene_script(params) {
        const methodArgs = params.args ? JSON.parse(params.args) : [];
        return callScene('execute-scene-script', params.uuid, params.method, ...methodArgs);
    }
    async soft_reload() {
        return callScene('soft-reload');
    }
    // ==================== 编辑器操作（undo/redo/copy/paste/cut） ====================
    async undo() {
        await callScene('undo');
        return { message: '已撤销' };
    }
    async redo() {
        await callScene('redo');
        return { message: '已重做' };
    }
    async copy_node(params) {
        let uuids;
        try {
            uuids = JSON.parse(params.uuids);
        }
        catch (_a) {
            uuids = [params.uuids];
        }
        await callScene('copy-node', uuids);
        return { message: `已复制 ${uuids.length} 个节点` };
    }
    async paste_node(params) {
        await callScene('paste-node', params.target);
        return { message: '节点已粘贴' };
    }
    async cut_node(params) {
        let uuids;
        try {
            uuids = JSON.parse(params.uuids);
        }
        catch (_a) {
            uuids = [params.uuids];
        }
        await callScene('cut-node', uuids);
        return { message: `已剪切 ${uuids.length} 个节点` };
    }
    async reset_node_property(params) {
        await callScene('reset-node-property', params.uuid, params.path);
        return { message: `已重置属性: ${params.path}` };
    }
    // ==================== 组合工具（多步编排） ====================
    async create_default_2d_scene(params) {
        var _a, _b;
        // 1. 创建场景文件
        const fullPath = params.savePath.endsWith('.scene')
            ? params.savePath
            : `${params.savePath}/${params.sceneName}.scene`;
        const content = buildSceneJSON(params.sceneName);
        const result = await callAssetDB('create-asset', fullPath, content);
        // 2. 打开新场景
        await callScene('open-scene', result.uuid);
        // 3. 创建 Canvas 节点
        const canvasResult = await executeSceneScript('createNode', ['Canvas']);
        const canvasUuid = (_a = canvasResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
        // 4. 为 Canvas 添加 cc.Canvas 组件
        const width = parseInt(params.resolutionWidth || '1920', 10);
        const height = parseInt(params.resolutionHeight || '1080', 10);
        if (canvasUuid) {
            await executeSceneScript('addComponentToNode', [canvasUuid, 'cc.Canvas']);
            await executeSceneScript('addComponentToNode', [canvasUuid, 'cc.UITransform']);
            // 设置 Canvas 位置
            await executeSceneScript('setNodeProperty', [canvasUuid, 'position', { x: width / 2, y: height / 2, z: 0 }]);
        }
        // 5. 创建 Camera 节点
        const cameraResult = await executeSceneScript('createNode', ['Camera', canvasUuid]);
        const cameraUuid = (_b = cameraResult.data) === null || _b === void 0 ? void 0 : _b.uuid;
        if (cameraUuid) {
            await executeSceneScript('addComponentToNode', [cameraUuid, 'cc.Camera']);
        }
        // 6. 保存场景
        await callScene('save-scene');
        return {
            message: `标准 2D 场景 '${params.sceneName}' 已创建`,
            uuid: result.uuid,
            url: result.url,
            canvasUuid,
            cameraUuid,
            resolution: { width, height },
        };
    }
    async create_sprite_node(params) {
        var _a;
        // 1. 创建节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = (_a = nodeResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
        if (!nodeUuid)
            throw new Error('创建节点失败');
        // 2. 添加 Sprite + UITransform 组件
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Sprite']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);
        // 3. 设置贴图
        if (params.spriteFrameUuid) {
            await executeSceneScript('setComponentProperty', [
                nodeUuid,
                'cc.Sprite',
                'spriteFrame',
                params.spriteFrameUuid,
            ]);
        }
        // 4. 设置位置和尺寸
        if (params.position) {
            const pos = JSON.parse(params.position);
            await executeSceneScript('setNodeProperty', [nodeUuid, 'position', pos]);
        }
        if (params.size) {
            const size = JSON.parse(params.size);
            await executeSceneScript('setComponentProperty', [
                nodeUuid,
                'cc.UITransform',
                'contentSize',
                size,
            ]);
        }
        return {
            message: `Sprite 节点 '${params.name}' 已创建`,
            nodeUuid,
        };
    }
    async create_label_node(params) {
        var _a;
        // 1. 创建节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = (_a = nodeResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
        if (!nodeUuid)
            throw new Error('创建节点失败');
        // 2. 添加 Label + UITransform 组件
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Label']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);
        // 3. 设置文本
        await executeSceneScript('setComponentProperty', [
            nodeUuid, 'cc.Label', 'string', params.text,
        ]);
        // 4. 设置字号
        if (params.fontSize) {
            await executeSceneScript('setComponentProperty', [
                nodeUuid, 'cc.Label', 'fontSize', parseInt(params.fontSize, 10),
            ]);
        }
        // 5. 设置颜色
        if (params.color) {
            const color = JSON.parse(params.color);
            await executeSceneScript('setComponentProperty', [
                nodeUuid, 'cc.Label', 'color', color,
            ]);
        }
        // 6. 设置位置
        if (params.position) {
            const pos = JSON.parse(params.position);
            await executeSceneScript('setNodeProperty', [nodeUuid, 'position', pos]);
        }
        return {
            message: `Label 节点 '${params.name}' 已创建`,
            nodeUuid,
            text: params.text,
        };
    }
    async create_button_node(params) {
        var _a, _b;
        // 1. 创建按钮节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = (_a = nodeResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
        if (!nodeUuid)
            throw new Error('创建节点失败');
        // 2. 添加 Button + UITransform + Sprite 组件
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Button']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Sprite']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);
        // 3. 创建 Label 子节点
        const labelResult = await executeSceneScript('createNode', ['Label', nodeUuid]);
        const labelUuid = (_b = labelResult.data) === null || _b === void 0 ? void 0 : _b.uuid;
        if (labelUuid) {
            await executeSceneScript('addComponentToNode', [labelUuid, 'cc.Label']);
            await executeSceneScript('addComponentToNode', [labelUuid, 'cc.UITransform']);
            await executeSceneScript('setComponentProperty', [
                labelUuid, 'cc.Label', 'string', params.labelText,
            ]);
            if (params.fontSize) {
                await executeSceneScript('setComponentProperty', [
                    labelUuid, 'cc.Label', 'fontSize', parseInt(params.fontSize, 10),
                ]);
            }
        }
        // 4. 设置尺寸
        const size = params.size ? JSON.parse(params.size) : { x: 200, y: 60 };
        await executeSceneScript('setComponentProperty', [
            nodeUuid, 'cc.UITransform', 'contentSize', size,
        ]);
        // 5. 设置位置
        if (params.position) {
            const pos = JSON.parse(params.position);
            await executeSceneScript('setNodeProperty', [nodeUuid, 'position', pos]);
        }
        return {
            message: `按钮 '${params.name}' 已创建`,
            nodeUuid,
            labelUuid,
        };
    }
    // ==================== 批量操作组合 ====================
    async batch_rename(params) {
        var _a;
        const allNodes = await executeSceneScript('getAllNodes');
        const nodes = allNodes.data || [];
        const exact = String((_a = params.exactMatch) !== null && _a !== void 0 ? _a : '') === 'true';
        let renamed = 0;
        const results = [];
        for (const node of nodes) {
            const matches = exact ? node.name === params.pattern : node.name.startsWith(params.pattern);
            if (matches) {
                const newName = params.newName.replace(/\{index\}/g, String(renamed + 1));
                await executeSceneScript('setNodeProperty', [node.uuid, 'name', newName]);
                results.push({ oldName: node.name, newName });
                renamed++;
            }
        }
        return {
            message: `已重命名 ${renamed} 个节点`,
            renamed,
            results,
        };
    }
    async find_and_set(params) {
        const allNodes = await executeSceneScript('getAllNodes');
        const nodes = allNodes.data || [];
        const value = JSON.parse(params.value);
        let updated = 0;
        for (const node of nodes) {
            if (node.name.includes(params.pattern)) {
                await executeSceneScript('setNodeProperty', [node.uuid, params.property, value]);
                updated++;
            }
        }
        return {
            message: `已更新 ${updated} 个匹配节点`,
            updated,
        };
    }
    /** 将 query-node-tree 返回的节点树递归补充组件信息 */
    enrichWithComponents(tree) {
        const enrich = (node) => {
            const result = Object.assign({}, node);
            if (node.__comps__) {
                result.components = node.__comps__.map((c) => ({
                    type: c.__type__ || 'Unknown',
                    enabled: c.enabled !== undefined ? c.enabled : true,
                }));
            }
            if (node.children) {
                result.children = node.children.map((c) => enrich(c));
            }
            return result;
        };
        return enrich(tree);
    }
};
exports.SceneModule = SceneModule;
__decorate([
    (0, decorators_1.MCPTool)('查询所有场景列表', {
        folder: { type: 'string', description: '搜索文件夹路径（可选，默认 db://assets）' },
    })
], SceneModule.prototype, "get_scene_list", null);
__decorate([
    (0, decorators_1.MCPTool)('打开指定场景', {
        scenePath: { type: 'string', description: '场景路径（如 db://assets/scenes/Main.scene）', required: true },
    })
], SceneModule.prototype, "open_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('保存当前场景')
], SceneModule.prototype, "save_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('另存当前场景', {
        path: { type: 'string', description: '目标保存路径' },
    })
], SceneModule.prototype, "save_scene_as", null);
__decorate([
    (0, decorators_1.MCPTool)('关闭当前场景')
], SceneModule.prototype, "close_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('创建空白新场景', {
        sceneName: { type: 'string', description: '场景名称', required: true },
        savePath: { type: 'string', description: '保存路径（如 db://assets/scenes/NewScene.scene）', required: true },
    })
], SceneModule.prototype, "create_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前打开的场景信息')
], SceneModule.prototype, "query_current_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('查询场景节点树，返回当前打开场景的完整节点层级结构', {
        includeComponents: { type: 'string', description: '是否包含组件信息，默认 false' },
        uuid: { type: 'string', description: '节点 UUID（可选，默认根节点）' },
    })
], SceneModule.prototype, "query_node_tree", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定节点的详细信息（名称、UUID、组件列表、Transform 等）', {
        uuid: { type: 'string', description: '节点的 UUID', required: true },
    })
], SceneModule.prototype, "query_node", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定节点上某类型组件的属性和值', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label', required: true },
    })
], SceneModule.prototype, "query_component", null);
__decorate([
    (0, decorators_1.MCPTool)('获取当前场景的完整 JSON 序列化数据')
], SceneModule.prototype, "query_scene_json", null);
__decorate([
    (0, decorators_1.MCPTool)('查询场景中所有可用的组件类列表')
], SceneModule.prototype, "query_classes", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定节点上的所有组件列表', {
        uuid: { type: 'string', description: '节点的 UUID', required: true },
    })
], SceneModule.prototype, "query_components", null);
__decorate([
    (0, decorators_1.MCPTool)('查询场景编辑器是否就绪')
], SceneModule.prototype, "query_is_ready", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前场景是否有未保存的修改')
], SceneModule.prototype, "query_dirty", null);
__decorate([
    (0, decorators_1.MCPTool)('获取场景中所有节点列表', {
        includeComponents: { type: 'string', description: '是否包含组件信息，默认 false' },
    })
], SceneModule.prototype, "get_all_nodes", null);
__decorate([
    (0, decorators_1.MCPTool)('按名称查找节点（支持精确匹配）', {
        name: { type: 'string', description: '节点名称', required: true },
    })
], SceneModule.prototype, "find_node_by_name", null);
__decorate([
    (0, decorators_1.MCPTool)('按组件类型查找节点', {
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label', required: true },
    })
], SceneModule.prototype, "find_nodes_by_component", null);
__decorate([
    (0, decorators_1.MCPTool)('获取场景完整层级树（含组件信息可选）', {
        includeComponents: { type: 'string', description: '是否包含组件信息，传 "true" 即包含' },
    })
], SceneModule.prototype, "get_scene_hierarchy", null);
__decorate([
    (0, decorators_1.MCPTool)('在场景中创建新节点（通过场景脚本，支持指定父节点）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选，默认场景根节点）' },
    })
], SceneModule.prototype, "create_node", null);
__decorate([
    (0, decorators_1.MCPTool)('删除指定节点', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
    })
], SceneModule.prototype, "delete_node", null);
__decorate([
    (0, decorators_1.MCPTool)('复制节点（深拷贝）', {
        uuid: { type: 'string', description: '源节点 UUID', required: true },
    })
], SceneModule.prototype, "duplicate_node", null);
__decorate([
    (0, decorators_1.MCPTool)('移动节点到新父节点下', {
        uuid: { type: 'string', description: '要移动的节点 UUID', required: true },
        newParentUuid: { type: 'string', description: '新父节点 UUID', required: true },
    })
], SceneModule.prototype, "move_node", null);
__decorate([
    (0, decorators_1.MCPTool)('设置节点属性（position/rotation/scale/active/name/layer/mobility）', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        property: { type: 'string', description: '属性名', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
], SceneModule.prototype, "set_node_property", null);
__decorate([
    (0, decorators_1.MCPTool)('设置节点 Transform（position/rotation/scale 统一接口）', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        position: { type: 'string', description: '位置 JSON 如 {"x":100,"y":200,"z":0}' },
        rotation: { type: 'string', description: '旋转 JSON 如 {"x":0,"y":0,"z":45}' },
        scale: { type: 'string', description: '缩放 JSON 如 {"x":1,"y":1,"z":1}' },
    })
], SceneModule.prototype, "set_node_transform", null);
__decorate([
    (0, decorators_1.MCPTool)('为节点添加组件', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label, cc.Button', required: true },
    })
], SceneModule.prototype, "add_component", null);
__decorate([
    (0, decorators_1.MCPTool)('移除节点上的组件', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名', required: true },
    })
], SceneModule.prototype, "remove_component", null);
__decorate([
    (0, decorators_1.MCPTool)('设置组件属性（支持 Sprite/Label/Button 等常见组件特殊处理）', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名', required: true },
        property: { type: 'string', description: '属性名（如 string, spriteFrame, color, fontSize）', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
], SceneModule.prototype, "set_component_property", null);
__decorate([
    (0, decorators_1.MCPTool)('在场景中执行脚本方法（如组件上的方法）', {
        uuid: { type: 'string', description: '目标节点或组件的 UUID' },
        method: { type: 'string', description: '要执行的方法名' },
        args: { type: 'string', description: '方法参数（JSON 数组字符串）' },
    })
], SceneModule.prototype, "execute_scene_script", null);
__decorate([
    (0, decorators_1.MCPTool)('软重载当前场景（保留状态）')
], SceneModule.prototype, "soft_reload", null);
__decorate([
    (0, decorators_1.MCPTool)('撤销上一步编辑操作')
], SceneModule.prototype, "undo", null);
__decorate([
    (0, decorators_1.MCPTool)('重做已撤销的操作')
], SceneModule.prototype, "redo", null);
__decorate([
    (0, decorators_1.MCPTool)('复制节点到剪贴板', {
        uuids: { type: 'string', description: '节点 UUID（单个或 JSON 数组字符串）', required: true },
    })
], SceneModule.prototype, "copy_node", null);
__decorate([
    (0, decorators_1.MCPTool)('粘贴剪贴板中的节点', {
        target: { type: 'string', description: '目标父节点 UUID', required: true },
    })
], SceneModule.prototype, "paste_node", null);
__decorate([
    (0, decorators_1.MCPTool)('剪切节点（复制+删除）', {
        uuids: { type: 'string', description: '节点 UUID（单个或 JSON 数组字符串）', required: true },
    })
], SceneModule.prototype, "cut_node", null);
__decorate([
    (0, decorators_1.MCPTool)('重置节点属性为默认值', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        path: { type: 'string', description: '属性路径（position/rotation/scale/_lpos 等）', required: true },
    })
], SceneModule.prototype, "reset_node_property", null);
__decorate([
    (0, decorators_1.MCPTool)('一键创建标准 2D 场景（Canvas + Camera + 背景节点）。适用于快速初始化 UI 场景', {
        sceneName: { type: 'string', description: '场景名称', required: true },
        savePath: { type: 'string', description: '保存路径（如 db://assets/scenes/UIScene.scene）', required: true },
        resolutionWidth: { type: 'string', description: '设计分辨率宽（默认 1920）' },
        resolutionHeight: { type: 'string', description: '设计分辨率高（默认 1080）' },
    })
], SceneModule.prototype, "create_default_2d_scene", null);
__decorate([
    (0, decorators_1.MCPTool)('创建带背景 Sprite 的节点（一键创建节点+添加 Sprite 组件+设置贴图）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        spriteFrameUuid: { type: 'string', description: 'SpriteFrame 资源的 UUID' },
        position: { type: 'string', description: '位置 JSON' },
        size: { type: 'string', description: '尺寸 JSON（如 {"x":100,"y":100}）' },
    })
], SceneModule.prototype, "create_sprite_node", null);
__decorate([
    (0, decorators_1.MCPTool)('创建带 Label 文本的节点（一键创建节点+添加 Label 组件+设置文本/字号/颜色）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        text: { type: 'string', description: '文本内容', required: true },
        fontSize: { type: 'string', description: '字号（默认 40）' },
        color: { type: 'string', description: '颜色 JSON（如 {"r":255,"g":255,"b":255,"a":255}）' },
        position: { type: 'string', description: '位置 JSON' },
    })
], SceneModule.prototype, "create_label_node", null);
__decorate([
    (0, decorators_1.MCPTool)('创建带 Button 组件的按钮节点（一键创建按钮+Label子节点+绑定点击）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        labelText: { type: 'string', description: '按钮文本', required: true },
        fontSize: { type: 'string', description: '字号（默认 30）' },
        position: { type: 'string', description: '位置 JSON' },
        size: { type: 'string', description: '尺寸 JSON（默认 {"x":200,"y":60}）' },
    })
], SceneModule.prototype, "create_button_node", null);
__decorate([
    (0, decorators_1.MCPTool)('批量重命名节点（按模式重命名所有匹配节点）', {
        pattern: { type: 'string', description: '名称匹配模式（精确匹配或前缀匹配）', required: true },
        newName: { type: 'string', description: '新名称（可用 {index} 占位编号，如 "Button_{index}"）', required: true },
        exactMatch: { type: 'string', description: '是否精确匹配名称，默认 false（前缀匹配）' },
    })
], SceneModule.prototype, "batch_rename", null);
__decorate([
    (0, decorators_1.MCPTool)('查找匹配节点并批量设置属性', {
        pattern: { type: 'string', description: '节点名称匹配模式', required: true },
        property: { type: 'string', description: '属性名', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
], SceneModule.prototype, "find_and_set", null);
exports.SceneModule = SceneModule = __decorate([
    (0, decorators_1.MCPModule)('scene', '场景编辑 - 场景生命周期、节点树查询、节点/组件 CRUD、脚本执行')
], SceneModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2NlbmVNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvU2NlbmVNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7Ozs7Ozs7O0FBRUgsOENBQW1EO0FBRW5ELDZCQUE2QjtBQUM3QixLQUFLLFVBQVUsU0FBUyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQseUNBQXlDO0FBQ3pDLEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxNQUFjLEVBQUUsT0FBYyxFQUFFO0lBQzlELElBQUksQ0FBQztRQUNELE1BQU0sTUFBTSxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLHNCQUFzQixFQUFFO1lBQ3pFLElBQUksRUFBRSxVQUFVO1lBQ2hCLE1BQU07WUFDTixJQUFJO1NBQ1AsQ0FBQyxDQUFDO1FBQ0gsT0FBTyxNQUFNLENBQUM7SUFDbEIsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUVELHVCQUF1QjtBQUN2QixLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDckQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNyRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQsdURBQXVEO0FBRXZELFNBQVMsY0FBYyxDQUFDLFNBQWlCO0lBQ3JDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNsQjtZQUNJLFVBQVUsRUFBRSxlQUFlO1lBQzNCLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLFdBQVcsRUFBRSxDQUFDO1lBQ2Qsa0JBQWtCLEVBQUUsRUFBRTtZQUN0QixTQUFTLEVBQUUsRUFBRTtZQUNiLE9BQU8sRUFBRSxFQUFFLFFBQVEsRUFBRSxDQUFDLEVBQUU7U0FDM0I7UUFDRDtZQUNJLFVBQVUsRUFBRSxVQUFVO1lBQ3RCLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLFdBQVcsRUFBRSxDQUFDO1lBQ2Qsa0JBQWtCLEVBQUUsRUFBRTtZQUN0QixTQUFTLEVBQUUsSUFBSTtZQUNmLFdBQVcsRUFBRSxFQUFFO1lBQ2YsU0FBUyxFQUFFLElBQUk7WUFDZixhQUFhLEVBQUUsRUFBRTtZQUNqQixTQUFTLEVBQUUsSUFBSTtZQUNmLE9BQU8sRUFBRSxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUU7WUFDMUQsT0FBTyxFQUFFLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFO1lBQ2xFLFNBQVMsRUFBRSxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUU7WUFDNUQsV0FBVyxFQUFFLENBQUM7WUFDZCxRQUFRLEVBQUUsVUFBVTtZQUNwQixRQUFRLEVBQUUsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFO1lBQzNELG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsVUFBVSxFQUFFLEVBQUUsUUFBUSxFQUFFLENBQUMsRUFBRTtZQUMzQixLQUFLLEVBQUUsT0FBTztTQUNqQjtRQUNEO1lBQ0ksVUFBVSxFQUFFLGlCQUFpQjtZQUM3QixTQUFTLEVBQUUsRUFBRSxRQUFRLEVBQUUsQ0FBQyxFQUFFO1lBQzFCLFFBQVEsRUFBRSxFQUFFLFFBQVEsRUFBRSxDQUFDLEVBQUU7WUFDekIsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLENBQUMsRUFBRTtZQUN0QixRQUFRLEVBQUUsRUFBRSxRQUFRLEVBQUUsQ0FBQyxFQUFFO1NBQzVCO1FBQ0Q7WUFDSSxVQUFVLEVBQUUsZ0JBQWdCO1lBQzVCLGNBQWMsRUFBRSxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLFFBQVEsRUFBRTtZQUN0RixXQUFXLEVBQUUsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxRQUFRLEVBQUU7WUFDbkYsY0FBYyxFQUFFLEtBQUs7WUFDckIsV0FBVyxFQUFFLEtBQUs7WUFDbEIsa0JBQWtCLEVBQUUsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUU7WUFDbkYsZUFBZSxFQUFFLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFO1NBQ25GO1FBQ0Q7WUFDSSxVQUFVLEVBQUUsZUFBZTtZQUMzQixrQkFBa0IsRUFBRSxDQUFDO1lBQ3JCLFlBQVksRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxpQkFBaUIsRUFBRSxDQUFDO1lBQ3pELGdCQUFnQixFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsSUFBSTtZQUMzQyxVQUFVLEVBQUUsS0FBSyxFQUFFLFNBQVMsRUFBRSxJQUFJO1lBQ2xDLG1CQUFtQixFQUFFLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSTtZQUN6RSxnQkFBZ0IsRUFBRSxDQUFDO1NBQ3RCO1FBQ0Q7WUFDSSxVQUFVLEVBQUUsWUFBWTtZQUN4QixPQUFPLEVBQUUsQ0FBQztZQUNWLFdBQVcsRUFBRSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtZQUMvRSxVQUFVLEVBQUUsS0FBSyxFQUFFLGFBQWEsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEdBQUcsRUFBRSxTQUFTLEVBQUUsR0FBRztZQUN2RSxXQUFXLEVBQUUsQ0FBQyxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEdBQUcsRUFBRSxXQUFXLEVBQUUsS0FBSztTQUN2RTtRQUNEO1lBQ0ksVUFBVSxFQUFFLGVBQWU7WUFDM0IsVUFBVSxFQUFFLEtBQUs7WUFDakIsU0FBUyxFQUFFLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUksRUFBRTtZQUN4RSxTQUFTLEVBQUUsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFO1lBQ3JFLFFBQVEsRUFBRSxDQUFDO1NBQ2Q7S0FDSixFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNoQixDQUFDO0FBR00sSUFBTSxXQUFXLEdBQWpCLE1BQU0sV0FBVztJQUVwQixtREFBbUQ7SUFLN0MsQUFBTixLQUFLLENBQUMsY0FBYyxDQUFDLE1BQTRCO1FBQzdDLE1BQU0sTUFBTSxHQUFHLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLE1BQU0sS0FBSSxhQUFhLENBQUM7UUFDL0MsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxNQUFNLFlBQVksQ0FBQyxDQUFDLENBQUMsR0FBRyxNQUFNLGFBQWEsQ0FBQztRQUN0RixNQUFNLE9BQU8sR0FBRyxNQUFNLFdBQVcsQ0FBQyxjQUFjLEVBQUUsRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQy9ELE1BQU0sTUFBTSxHQUFHLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztZQUM1QyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUk7WUFDWixJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUc7WUFDWCxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUk7U0FDZixDQUFDLENBQUMsQ0FBQztRQUNKLE9BQU8sRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUN0QixDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsVUFBVSxDQUFDLE1BQTZCO1FBQzFDLE1BQU0sSUFBSSxHQUFHLE1BQU0sV0FBVyxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDL0QsSUFBSSxDQUFDLElBQUk7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsTUFBTSxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUM7UUFDekQsTUFBTSxTQUFTLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3BDLE9BQU8sRUFBRSxPQUFPLEVBQUUsVUFBVSxNQUFNLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQztJQUNyRCxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsVUFBVTtRQUNaLE1BQU0sU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQzlCLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLENBQUM7SUFDaEMsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLGFBQWEsQ0FBQyxPQUEyQjtRQUMzQyxNQUFNLFNBQVMsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUNqQyxPQUFPLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxDQUFDO0lBQ25DLENBQUM7SUFHSyxBQUFOLEtBQUssQ0FBQyxXQUFXO1FBQ2IsTUFBTSxTQUFTLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDL0IsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNoQyxDQUFDO0lBTUssQUFBTixLQUFLLENBQUMsWUFBWSxDQUFDLE1BQStDO1FBQzlELE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxRQUFRLElBQUksTUFBTSxDQUFDLFNBQVMsUUFBUSxDQUFDO1FBQ3ZILE1BQU0sT0FBTyxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDakQsTUFBTSxNQUFNLEdBQUcsTUFBTSxXQUFXLENBQUMsY0FBYyxFQUFFLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUNwRSxPQUFPO1lBQ0gsT0FBTyxFQUFFLE9BQU8sTUFBTSxDQUFDLFNBQVMsT0FBTztZQUN2QyxJQUFJLEVBQUUsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLElBQUk7WUFDbEIsR0FBRyxFQUFFLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxHQUFHO1NBQ25CLENBQUM7SUFDTixDQUFDO0lBRUQsNERBQTREO0lBR3RELEFBQU4sS0FBSyxDQUFDLG1CQUFtQjtRQUNyQixPQUFPLFNBQVMsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFNSyxBQUFOLEtBQUssQ0FBQyxlQUFlLENBQUMsTUFBc0Q7O1FBQ3hFLGdDQUFnQztRQUNoQyxJQUFJLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxNQUFNLFNBQVMsQ0FBQyxpQkFBaUIsRUFBRSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsSUFBSSxDQUFDLENBQUM7WUFDOUQsSUFBSSxJQUFJLEVBQUUsQ0FBQztnQkFDUCxNQUFNLFlBQVksR0FBRyxNQUFNLENBQUMsTUFBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsaUJBQWlCLG1DQUFJLEVBQUUsQ0FBQyxLQUFLLE1BQU0sQ0FBQztnQkFDeEUsSUFBSSxZQUFZLEVBQUUsQ0FBQztvQkFDZixPQUFPLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDM0MsQ0FBQztnQkFDRCxPQUFPLElBQUksQ0FBQztZQUNoQixDQUFDO1lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQzNDLENBQUM7UUFBQyxXQUFNLENBQUM7WUFDTCxNQUFNLFlBQVksR0FBRyxNQUFNLENBQUMsTUFBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsaUJBQWlCLG1DQUFJLEVBQUUsQ0FBQyxLQUFLLE1BQU0sQ0FBQztZQUN4RSxPQUFPLGtCQUFrQixDQUFDLG1CQUFtQixFQUFFLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztRQUNuRSxDQUFDO0lBQ0wsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUF3QjtRQUNyQyx3QkFBd0I7UUFDeEIsSUFBSSxDQUFDO1lBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUMxRCxJQUFJLE1BQU07Z0JBQUUsT0FBTyxNQUFNLENBQUM7WUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3RDLENBQUM7UUFBQyxXQUFNLENBQUM7WUFDTCxPQUFPLGtCQUFrQixDQUFDLGFBQWEsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQzVELENBQUM7SUFDTCxDQUFDO0lBTUssQUFBTixLQUFLLENBQUMsZUFBZSxDQUFDLE1BQW1EO1FBQ3JFLE9BQU8sU0FBUyxDQUFDLGlCQUFpQixFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQy9FLENBQUM7SUFHSyxBQUFOLEtBQUssQ0FBQyxnQkFBZ0I7UUFDbEIsT0FBTyxTQUFTLENBQUMsa0JBQWtCLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsYUFBYTtRQUNmLE9BQU8sU0FBUyxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxNQUF3QjtRQUMzQyxPQUFPLFNBQVMsQ0FBQyxrQkFBa0IsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUdLLEFBQU4sS0FBSyxDQUFDLGNBQWM7UUFDaEIsT0FBTyxTQUFTLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUN2QyxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsV0FBVztRQUNiLE9BQU8sU0FBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQ3BDLENBQUM7SUFFRCx5REFBeUQ7SUFLbkQsQUFBTixLQUFLLENBQUMsYUFBYSxDQUFDLE1BQXVDO1FBQ3ZELE9BQU8sa0JBQWtCLENBQUMsYUFBYSxDQUFDLENBQUM7SUFDN0MsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLGlCQUFpQixDQUFDLE1BQXdCO1FBQzVDLE9BQU8sa0JBQWtCLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUMvRCxDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsdUJBQXVCLENBQUMsTUFBaUM7UUFDM0QsT0FBTyxrQkFBa0IsQ0FBQyxzQkFBc0IsRUFBRSxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO0lBQzlFLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxNQUF1Qzs7UUFDN0QsTUFBTSxZQUFZLEdBQUcsTUFBTSxDQUFDLE1BQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLGlCQUFpQixtQ0FBSSxFQUFFLENBQUMsS0FBSyxNQUFNLENBQUM7UUFDeEUsT0FBTyxrQkFBa0IsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7SUFDbkUsQ0FBQztJQU1LLEFBQU4sS0FBSyxDQUFDLFdBQVcsQ0FBQyxNQUE2QztRQUMzRCxPQUFPLGtCQUFrQixDQUFDLFlBQVksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7SUFDOUUsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLFdBQVcsQ0FBQyxNQUF3QjtRQUN0QyxPQUFPLGtCQUFrQixDQUFDLFlBQVksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQzNELENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxjQUFjLENBQUMsTUFBd0I7UUFDekMsT0FBTyxrQkFBa0IsQ0FBQyxlQUFlLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUM5RCxDQUFDO0lBTUssQUFBTixLQUFLLENBQUMsU0FBUyxDQUFDLE1BQStDO1FBQzNELE9BQU8sa0JBQWtCLENBQUMsVUFBVSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQztJQUMvRSxDQUFDO0lBT0ssQUFBTixLQUFLLENBQUMsaUJBQWlCLENBQUMsTUFBeUQ7UUFDN0UsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsT0FBTyxrQkFBa0IsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3hGLENBQUM7SUFRSyxBQUFOLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxNQUE4RTtRQUNuRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNsQixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN4QyxNQUFNLGtCQUFrQixDQUFDLGlCQUFpQixFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNoRixDQUFDO1FBQ0QsSUFBSSxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbEIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDeEMsTUFBTSxrQkFBa0IsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDaEYsQ0FBQztRQUNELElBQUksTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2YsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDckMsTUFBTSxrQkFBa0IsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDN0UsQ0FBQztRQUNELE9BQU8sRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFLENBQUM7SUFDeEMsQ0FBQztJQUVELHlEQUF5RDtJQU1uRCxBQUFOLEtBQUssQ0FBQyxhQUFhLENBQUMsTUFBbUQ7UUFDbkUsT0FBTyxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUM7SUFDN0YsQ0FBQztJQU1LLEFBQU4sS0FBSyxDQUFDLGdCQUFnQixDQUFDLE1BQW1EO1FBQ3RFLE9BQU8sa0JBQWtCLENBQUMseUJBQXlCLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO0lBQ2xHLENBQUM7SUFRSyxBQUFOLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxNQUFvRjtRQUM3RyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxPQUFPLGtCQUFrQixDQUFDLHNCQUFzQixFQUFFLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN2SCxDQUFDO0lBRUQsbURBQW1EO0lBTzdDLEFBQU4sS0FBSyxDQUFDLG9CQUFvQixDQUFDLE1BQXVEO1FBQzlFLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDOUQsT0FBTyxTQUFTLENBQUMsc0JBQXNCLEVBQUUsTUFBTSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLEdBQUcsVUFBVSxDQUFDLENBQUM7SUFDeEYsQ0FBQztJQUdLLEFBQU4sS0FBSyxDQUFDLFdBQVc7UUFDYixPQUFPLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQsNEVBQTRFO0lBR3RFLEFBQU4sS0FBSyxDQUFDLElBQUk7UUFDTixNQUFNLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN4QixPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQzlCLENBQUM7SUFHSyxBQUFOLEtBQUssQ0FBQyxJQUFJO1FBQ04sTUFBTSxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEIsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUM5QixDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsU0FBUyxDQUFDLE1BQXlCO1FBQ3JDLElBQUksS0FBZSxDQUFDO1FBQ3BCLElBQUksQ0FBQztZQUNELEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQyxDQUFDO1FBQUMsV0FBTSxDQUFDO1lBQ0wsS0FBSyxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzNCLENBQUM7UUFDRCxNQUFNLFNBQVMsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDcEMsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEtBQUssQ0FBQyxNQUFNLE1BQU0sRUFBRSxDQUFDO0lBQ2xELENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBMEI7UUFDdkMsTUFBTSxTQUFTLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUM3QyxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2hDLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBeUI7UUFDcEMsSUFBSSxLQUFlLENBQUM7UUFDcEIsSUFBSSxDQUFDO1lBQ0QsS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3JDLENBQUM7UUFBQyxXQUFNLENBQUM7WUFDTCxLQUFLLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDM0IsQ0FBQztRQUNELE1BQU0sU0FBUyxDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNuQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sS0FBSyxDQUFDLE1BQU0sTUFBTSxFQUFFLENBQUM7SUFDbEQsQ0FBQztJQU1LLEFBQU4sS0FBSyxDQUFDLG1CQUFtQixDQUFDLE1BQXNDO1FBQzVELE1BQU0sU0FBUyxDQUFDLHFCQUFxQixFQUFFLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2pFLE9BQU8sRUFBRSxPQUFPLEVBQUUsVUFBVSxNQUFNLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQztJQUNoRCxDQUFDO0lBRUQsdURBQXVEO0lBUWpELEFBQU4sS0FBSyxDQUFDLHVCQUF1QixDQUFDLE1BSzdCOztRQUNHLFlBQVk7UUFDWixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUM7WUFDL0MsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxRQUFRO1lBQ2pCLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxRQUFRLElBQUksTUFBTSxDQUFDLFNBQVMsUUFBUSxDQUFDO1FBQ3JELE1BQU0sT0FBTyxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDakQsTUFBTSxNQUFNLEdBQUcsTUFBTSxXQUFXLENBQUMsY0FBYyxFQUFFLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUVwRSxXQUFXO1FBQ1gsTUFBTSxTQUFTLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUUzQyxrQkFBa0I7UUFDbEIsTUFBTSxZQUFZLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO1FBQ3hFLE1BQU0sVUFBVSxHQUFHLE1BQUEsWUFBWSxDQUFDLElBQUksMENBQUUsSUFBSSxDQUFDO1FBRTNDLDhCQUE4QjtRQUM5QixNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLGVBQWUsSUFBSSxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDN0QsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsSUFBSSxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFL0QsSUFBSSxVQUFVLEVBQUUsQ0FBQztZQUNiLE1BQU0sa0JBQWtCLENBQUMsb0JBQW9CLEVBQUUsQ0FBQyxVQUFVLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQztZQUMxRSxNQUFNLGtCQUFrQixDQUFDLG9CQUFvQixFQUFFLENBQUMsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQztZQUUvRSxlQUFlO1lBQ2YsTUFBTSxrQkFBa0IsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsRUFBRSxDQUFDLEVBQUUsS0FBSyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ2pILENBQUM7UUFFRCxrQkFBa0I7UUFDbEIsTUFBTSxZQUFZLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQztRQUNwRixNQUFNLFVBQVUsR0FBRyxNQUFBLFlBQVksQ0FBQyxJQUFJLDBDQUFFLElBQUksQ0FBQztRQUUzQyxJQUFJLFVBQVUsRUFBRSxDQUFDO1lBQ2IsTUFBTSxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLFVBQVUsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO1FBQzlFLENBQUM7UUFFRCxVQUFVO1FBQ1YsTUFBTSxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFOUIsT0FBTztZQUNILE9BQU8sRUFBRSxhQUFhLE1BQU0sQ0FBQyxTQUFTLE9BQU87WUFDN0MsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO1lBQ2pCLEdBQUcsRUFBRSxNQUFNLENBQUMsR0FBRztZQUNmLFVBQVU7WUFDVixVQUFVO1lBQ1YsVUFBVSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRTtTQUNoQyxDQUFDO0lBQ04sQ0FBQztJQVNLLEFBQU4sS0FBSyxDQUFDLGtCQUFrQixDQUFDLE1BTXhCOztRQUNHLFVBQVU7UUFDVixNQUFNLFVBQVUsR0FBRyxNQUFNLGtCQUFrQixDQUFDLFlBQVksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7UUFDNUYsTUFBTSxRQUFRLEdBQUcsTUFBQSxVQUFVLENBQUMsSUFBSSwwQ0FBRSxJQUFJLENBQUM7UUFDdkMsSUFBSSxDQUFDLFFBQVE7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBRXpDLGdDQUFnQztRQUNoQyxNQUFNLGtCQUFrQixDQUFDLG9CQUFvQixFQUFFLENBQUMsUUFBUSxFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUM7UUFDeEUsTUFBTSxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLFFBQVEsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7UUFFN0UsVUFBVTtRQUNWLElBQUksTUFBTSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ3pCLE1BQU0sa0JBQWtCLENBQUMsc0JBQXNCLEVBQUU7Z0JBQzdDLFFBQVE7Z0JBQ1IsV0FBVztnQkFDWCxhQUFhO2dCQUNiLE1BQU0sQ0FBQyxlQUFlO2FBQ3pCLENBQUMsQ0FBQztRQUNQLENBQUM7UUFFRCxhQUFhO1FBQ2IsSUFBSSxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbEIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDeEMsTUFBTSxrQkFBa0IsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLFFBQVEsRUFBRSxVQUFVLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUM3RSxDQUFDO1FBQ0QsSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDZCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNyQyxNQUFNLGtCQUFrQixDQUFDLHNCQUFzQixFQUFFO2dCQUM3QyxRQUFRO2dCQUNSLGdCQUFnQjtnQkFDaEIsYUFBYTtnQkFDYixJQUFJO2FBQ1AsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztRQUVELE9BQU87WUFDSCxPQUFPLEVBQUUsY0FBYyxNQUFNLENBQUMsSUFBSSxPQUFPO1lBQ3pDLFFBQVE7U0FDWCxDQUFDO0lBQ04sQ0FBQztJQVVLLEFBQU4sS0FBSyxDQUFDLGlCQUFpQixDQUFDLE1BT3ZCOztRQUNHLFVBQVU7UUFDVixNQUFNLFVBQVUsR0FBRyxNQUFNLGtCQUFrQixDQUFDLFlBQVksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7UUFDNUYsTUFBTSxRQUFRLEdBQUcsTUFBQSxVQUFVLENBQUMsSUFBSSwwQ0FBRSxJQUFJLENBQUM7UUFDdkMsSUFBSSxDQUFDLFFBQVE7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBRXpDLCtCQUErQjtRQUMvQixNQUFNLGtCQUFrQixDQUFDLG9CQUFvQixFQUFFLENBQUMsUUFBUSxFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUM7UUFDdkUsTUFBTSxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLFFBQVEsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7UUFFN0UsVUFBVTtRQUNWLE1BQU0sa0JBQWtCLENBQUMsc0JBQXNCLEVBQUU7WUFDN0MsUUFBUSxFQUFFLFVBQVUsRUFBRSxRQUFRLEVBQUUsTUFBTSxDQUFDLElBQUk7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsVUFBVTtRQUNWLElBQUksTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sa0JBQWtCLENBQUMsc0JBQXNCLEVBQUU7Z0JBQzdDLFFBQVEsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQzthQUNsRSxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsVUFBVTtRQUNWLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2YsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDdkMsTUFBTSxrQkFBa0IsQ0FBQyxzQkFBc0IsRUFBRTtnQkFDN0MsUUFBUSxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsS0FBSzthQUN2QyxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsVUFBVTtRQUNWLElBQUksTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQ3hDLE1BQU0sa0JBQWtCLENBQUMsaUJBQWlCLEVBQUUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDN0UsQ0FBQztRQUVELE9BQU87WUFDSCxPQUFPLEVBQUUsYUFBYSxNQUFNLENBQUMsSUFBSSxPQUFPO1lBQ3hDLFFBQVE7WUFDUixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7U0FDcEIsQ0FBQztJQUNOLENBQUM7SUFVSyxBQUFOLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxNQU94Qjs7UUFDRyxZQUFZO1FBQ1osTUFBTSxVQUFVLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO1FBQzVGLE1BQU0sUUFBUSxHQUFHLE1BQUEsVUFBVSxDQUFDLElBQUksMENBQUUsSUFBSSxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxRQUFRO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUV6Qyx5Q0FBeUM7UUFDekMsTUFBTSxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLFFBQVEsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO1FBQ3hFLE1BQU0sa0JBQWtCLENBQUMsb0JBQW9CLEVBQUUsQ0FBQyxRQUFRLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQztRQUN4RSxNQUFNLGtCQUFrQixDQUFDLG9CQUFvQixFQUFFLENBQUMsUUFBUSxFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQztRQUU3RSxrQkFBa0I7UUFDbEIsTUFBTSxXQUFXLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUNoRixNQUFNLFNBQVMsR0FBRyxNQUFBLFdBQVcsQ0FBQyxJQUFJLDBDQUFFLElBQUksQ0FBQztRQUV6QyxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQ1osTUFBTSxrQkFBa0IsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLFNBQVMsRUFBRSxVQUFVLENBQUMsQ0FBQyxDQUFDO1lBQ3hFLE1BQU0sa0JBQWtCLENBQUMsb0JBQW9CLEVBQUUsQ0FBQyxTQUFTLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO1lBQzlFLE1BQU0sa0JBQWtCLENBQUMsc0JBQXNCLEVBQUU7Z0JBQzdDLFNBQVMsRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxTQUFTO2FBQ3BELENBQUMsQ0FBQztZQUNILElBQUksTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNsQixNQUFNLGtCQUFrQixDQUFDLHNCQUFzQixFQUFFO29CQUM3QyxTQUFTLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUM7aUJBQ25FLENBQUMsQ0FBQztZQUNQLENBQUM7UUFDTCxDQUFDO1FBRUQsVUFBVTtRQUNWLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDO1FBQ3ZFLE1BQU0sa0JBQWtCLENBQUMsc0JBQXNCLEVBQUU7WUFDN0MsUUFBUSxFQUFFLGdCQUFnQixFQUFFLGFBQWEsRUFBRSxJQUFJO1NBQ2xELENBQUMsQ0FBQztRQUVILFVBQVU7UUFDVixJQUFJLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNsQixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN4QyxNQUFNLGtCQUFrQixDQUFDLGlCQUFpQixFQUFFLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzdFLENBQUM7UUFFRCxPQUFPO1lBQ0gsT0FBTyxFQUFFLE9BQU8sTUFBTSxDQUFDLElBQUksT0FBTztZQUNsQyxRQUFRO1lBQ1IsU0FBUztTQUNaLENBQUM7SUFDTixDQUFDO0lBRUQsbURBQW1EO0lBTzdDLEFBQU4sS0FBSyxDQUFDLFlBQVksQ0FBQyxNQUlsQjs7UUFDRyxNQUFNLFFBQVEsR0FBRyxNQUFNLGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3pELE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ2xDLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxNQUFBLE1BQU0sQ0FBQyxVQUFVLG1DQUFJLEVBQUUsQ0FBQyxLQUFLLE1BQU0sQ0FBQztRQUV6RCxJQUFJLE9BQU8sR0FBRyxDQUFDLENBQUM7UUFDaEIsTUFBTSxPQUFPLEdBQTJDLEVBQUUsQ0FBQztRQUUzRCxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDNUYsSUFBSSxPQUFPLEVBQUUsQ0FBQztnQkFDVixNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDLE9BQU8sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMxRSxNQUFNLGtCQUFrQixDQUFDLGlCQUFpQixFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztnQkFDMUUsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxDQUFDLENBQUM7Z0JBQzlDLE9BQU8sRUFBRSxDQUFDO1lBQ2QsQ0FBQztRQUNMLENBQUM7UUFFRCxPQUFPO1lBQ0gsT0FBTyxFQUFFLFFBQVEsT0FBTyxNQUFNO1lBQzlCLE9BQU87WUFDUCxPQUFPO1NBQ1YsQ0FBQztJQUNOLENBQUM7SUFPSyxBQUFOLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFJbEI7UUFDRyxNQUFNLFFBQVEsR0FBRyxNQUFNLGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3pELE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ2xDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXZDLElBQUksT0FBTyxHQUFHLENBQUMsQ0FBQztRQUNoQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3ZCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ3JDLE1BQU0sa0JBQWtCLENBQUMsaUJBQWlCLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztnQkFDakYsT0FBTyxFQUFFLENBQUM7WUFDZCxDQUFDO1FBQ0wsQ0FBQztRQUVELE9BQU87WUFDSCxPQUFPLEVBQUUsT0FBTyxPQUFPLFFBQVE7WUFDL0IsT0FBTztTQUNWLENBQUM7SUFDTixDQUFDO0lBRUQsdUNBQXVDO0lBQy9CLG9CQUFvQixDQUFDLElBQVM7UUFDbEMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxJQUFTLEVBQU8sRUFBRTtZQUM5QixNQUFNLE1BQU0scUJBQVEsSUFBSSxDQUFFLENBQUM7WUFDM0IsSUFBSSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7Z0JBQ2pCLE1BQU0sQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7b0JBQ2hELElBQUksRUFBRSxDQUFDLENBQUMsUUFBUSxJQUFJLFNBQVM7b0JBQzdCLE9BQU8sRUFBRSxDQUFDLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSTtpQkFDdEQsQ0FBQyxDQUFDLENBQUM7WUFDUixDQUFDO1lBQ0QsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ2hCLE1BQU0sQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQy9ELENBQUM7WUFDRCxPQUFPLE1BQU0sQ0FBQztRQUNsQixDQUFDLENBQUM7UUFDRixPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN4QixDQUFDO0NBQ0osQ0FBQTtBQWhwQlksa0NBQVc7QUFPZDtJQUhMLElBQUEsb0JBQU8sRUFBQyxVQUFVLEVBQUU7UUFDakIsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsNEJBQTRCLEVBQUU7S0FDeEUsQ0FBQztpREFXRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLFFBQVEsRUFBRTtRQUNmLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHVDQUF1QyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDdEcsQ0FBQzs2Q0FNRDtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLFFBQVEsQ0FBQzs2Q0FJakI7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyxRQUFRLEVBQUU7UUFDZixJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUU7S0FDbEQsQ0FBQztnREFJRDtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLFFBQVEsQ0FBQzs4Q0FJakI7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxTQUFTLEVBQUU7UUFDaEIsU0FBUyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDbEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsMkNBQTJDLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUN6RyxDQUFDOytDQVVEO0FBS0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsYUFBYSxDQUFDO3NEQUd0QjtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLDJCQUEyQixFQUFFO1FBQ2xDLGlCQUFpQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsbUJBQW1CLEVBQUU7UUFDdkUsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsbUJBQW1CLEVBQUU7S0FDN0QsQ0FBQztrREFpQkQ7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyx1Q0FBdUMsRUFBRTtRQUM5QyxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNwRSxDQUFDOzZDQVVEO0FBTUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsbUJBQW1CLEVBQUU7UUFDMUIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDcEUsYUFBYSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsNkJBQTZCLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNoRyxDQUFDO2tEQUdEO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsc0JBQXNCLENBQUM7bURBRy9CO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsaUJBQWlCLENBQUM7Z0RBRzFCO0FBS0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsZ0JBQWdCLEVBQUU7UUFDdkIsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDcEUsQ0FBQzttREFHRDtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLGFBQWEsQ0FBQztpREFHdEI7QUFHSztJQURMLElBQUEsb0JBQU8sRUFBQyxpQkFBaUIsQ0FBQzs4Q0FHMUI7QUFPSztJQUhMLElBQUEsb0JBQU8sRUFBQyxhQUFhLEVBQUU7UUFDcEIsaUJBQWlCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxtQkFBbUIsRUFBRTtLQUMxRSxDQUFDO2dEQUdEO0FBS0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsaUJBQWlCLEVBQUU7UUFDeEIsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDaEUsQ0FBQztvREFHRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLFdBQVcsRUFBRTtRQUNsQixhQUFhLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSw2QkFBNkIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ2hHLENBQUM7MERBR0Q7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyxvQkFBb0IsRUFBRTtRQUMzQixpQkFBaUIsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHVCQUF1QixFQUFFO0tBQzlFLENBQUM7c0RBSUQ7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQywyQkFBMkIsRUFBRTtRQUNsQyxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUM3RCxVQUFVLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxzQkFBc0IsRUFBRTtLQUN0RSxDQUFDOzhDQUdEO0FBS0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsUUFBUSxFQUFFO1FBQ2YsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDbkUsQ0FBQzs4Q0FHRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLFdBQVcsRUFBRTtRQUNsQixJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNwRSxDQUFDO2lEQUdEO0FBTUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsWUFBWSxFQUFFO1FBQ25CLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3BFLGFBQWEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQzlFLENBQUM7NENBR0Q7QUFPSztJQUxMLElBQUEsb0JBQU8sRUFBQyw0REFBNEQsRUFBRTtRQUNuRSxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNoRSxRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNoRSxLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUN0RSxDQUFDO29EQUlEO0FBUUs7SUFOTCxJQUFBLG9CQUFPLEVBQUMsOENBQThDLEVBQUU7UUFDckQsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDaEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsbUNBQW1DLEVBQUU7UUFDOUUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsZ0NBQWdDLEVBQUU7UUFDM0UsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsK0JBQStCLEVBQUU7S0FDMUUsQ0FBQztxREFlRDtBQVFLO0lBSkwsSUFBQSxvQkFBTyxFQUFDLFNBQVMsRUFBRTtRQUNoQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNwRSxhQUFhLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx3Q0FBd0MsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQzNHLENBQUM7Z0RBR0Q7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxVQUFVLEVBQUU7UUFDakIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDcEUsYUFBYSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDMUUsQ0FBQzttREFHRDtBQVFLO0lBTkwsSUFBQSxvQkFBTyxFQUFDLDBDQUEwQyxFQUFFO1FBQ2pELFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3BFLGFBQWEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3ZFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLDZDQUE2QyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDeEcsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDdEUsQ0FBQzt5REFJRDtBQVNLO0lBTEwsSUFBQSxvQkFBTyxFQUFDLHFCQUFxQixFQUFFO1FBQzVCLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRTtRQUN0RCxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUU7UUFDbEQsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsa0JBQWtCLEVBQUU7S0FDNUQsQ0FBQzt1REFJRDtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLGVBQWUsQ0FBQzs4Q0FHeEI7QUFLSztJQURMLElBQUEsb0JBQU8sRUFBQyxXQUFXLENBQUM7dUNBSXBCO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsVUFBVSxDQUFDO3VDQUluQjtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLFVBQVUsRUFBRTtRQUNqQixLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx5QkFBeUIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ3BGLENBQUM7NENBVUQ7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyxXQUFXLEVBQUU7UUFDbEIsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsWUFBWSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDeEUsQ0FBQzs2Q0FJRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLGFBQWEsRUFBRTtRQUNwQixLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx5QkFBeUIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ3BGLENBQUM7MkNBVUQ7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxZQUFZLEVBQUU7UUFDbkIsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDaEUsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsdUNBQXVDLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNqRyxDQUFDO3NEQUlEO0FBVUs7SUFOTCxJQUFBLG9CQUFPLEVBQUMscURBQXFELEVBQUU7UUFDNUQsU0FBUyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDbEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsMENBQTBDLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNyRyxlQUFlLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxpQkFBaUIsRUFBRTtRQUNuRSxnQkFBZ0IsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGlCQUFpQixFQUFFO0tBQ3ZFLENBQUM7MERBb0REO0FBU0s7SUFQTCxJQUFBLG9CQUFPLEVBQUMsNENBQTRDLEVBQUU7UUFDbkQsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDN0QsVUFBVSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFO1FBQzNELGVBQWUsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHNCQUFzQixFQUFFO1FBQ3hFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRTtRQUNwRCxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSw4QkFBOEIsRUFBRTtLQUN4RSxDQUFDO3FEQThDRDtBQVVLO0lBUkwsSUFBQSxvQkFBTyxFQUFDLGdEQUFnRCxFQUFFO1FBQ3ZELElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQzdELFVBQVUsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGNBQWMsRUFBRTtRQUMzRCxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUM3RCxRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUU7UUFDdEQsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsOENBQThDLEVBQUU7UUFDdEYsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFO0tBQ3ZELENBQUM7b0RBaUREO0FBVUs7SUFSTCxJQUFBLG9CQUFPLEVBQUMsMENBQTBDLEVBQUU7UUFDakQsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDN0QsVUFBVSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFO1FBQzNELFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2xFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRTtRQUN0RCxRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUU7UUFDcEQsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsOEJBQThCLEVBQUU7S0FDeEUsQ0FBQztxREFxREQ7QUFTSztJQUxMLElBQUEsb0JBQU8sRUFBQyx1QkFBdUIsRUFBRTtRQUM5QixPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxtQkFBbUIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQzdFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHlDQUF5QyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDbkcsVUFBVSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUseUJBQXlCLEVBQUU7S0FDekUsQ0FBQzsrQ0E0QkQ7QUFPSztJQUxMLElBQUEsb0JBQU8sRUFBQyxlQUFlLEVBQUU7UUFDdEIsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDcEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDaEUsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDdEUsQ0FBQzsrQ0FzQkQ7c0JBN25CUSxXQUFXO0lBRHZCLElBQUEsc0JBQVMsRUFBQyxPQUFPLEVBQUUscUNBQXFDLENBQUM7R0FDN0MsV0FBVyxDQWdwQnZCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDlnLrmma/mqKHlnZcg4oCUIOWcuuaZr+eUn+WRveWRqOacnyArIOiKgueCuS/nu4Tku7bmk43kvZxcbiAqXG4gKiDlj4zpgJrpgZPmnrbmnoTvvJpcbiAqIDEuIEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgLi4uKSDigJQg57yW6L6R5Zmo57qn5pON5L2c77yI5omT5byAL+S/neWtmC/lhbPpl63lnLrmma/nrYnvvIlcbiAqIDIuIGV4ZWN1dGVTY2VuZVNjcmlwdChtZXRob2QsIGFyZ3MpIOKAlCDlnLrmma/ohJrmnKzmk43kvZzvvIjoioLngrkv57uE5Lu2IENSVUTvvIlcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcblxuLyoqIOiwg+eUqCBDb2NvcyDlhoXnva4gc2NlbmUg5omp5bGV5raI5oGvICovXG5hc3luYyBmdW5jdGlvbiBjYWxsU2NlbmUobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+a2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG4vKiog6LCD55So5oiR5Lus6Ieq5bex55qE5Zy65pmv6ISa5pys5pa55rOV77yIY29udHJpYnV0aW9ucy5zY2VuZe+8iSAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNjZW5lU2NyaXB0KG1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSA9IFtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6ICdtY3BfZ2FtZScsXG4gICAgICAgICAgICBtZXRob2QsXG4gICAgICAgICAgICBhcmdzLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/ohJrmnKwgJyR7bWV0aG9kfScg5aSx6LSlOiAke2UubWVzc2FnZSB8fCBlfWApO1xuICAgIH1cbn1cblxuLyoqIOWuieWFqOiwg+eUqCBhc3NldC1kYiDmianlsZUgKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxBc3NldERCKG1ldGhvZDogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgbWV0aG9kLCAuLi5hcmdzKTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotYTkuqfmtojmga8gJyR7bWV0aG9kfScg5aSx6LSlOiAke2UubWVzc2FnZSB8fCBlfWApO1xuICAgIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT0g5Zy65pmvIEpTT04g5qih5p2/ID09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIGJ1aWxkU2NlbmVKU09OKHNjZW5lTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW1xuICAgICAgICB7XG4gICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuU2NlbmVBc3NldFwiLFxuICAgICAgICAgICAgXCJfbmFtZVwiOiBzY2VuZU5hbWUsXG4gICAgICAgICAgICBcIl9vYmpGbGFnc1wiOiAwLFxuICAgICAgICAgICAgXCJfX2VkaXRvckV4dHJhc19fXCI6IHt9LFxuICAgICAgICAgICAgXCJfbmF0aXZlXCI6IFwiXCIsXG4gICAgICAgICAgICBcInNjZW5lXCI6IHsgXCJfX2lkX19cIjogMSB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuU2NlbmVcIixcbiAgICAgICAgICAgIFwiX25hbWVcIjogc2NlbmVOYW1lLFxuICAgICAgICAgICAgXCJfb2JqRmxhZ3NcIjogMCxcbiAgICAgICAgICAgIFwiX19lZGl0b3JFeHRyYXNfX1wiOiB7fSxcbiAgICAgICAgICAgIFwiX3BhcmVudFwiOiBudWxsLFxuICAgICAgICAgICAgXCJfY2hpbGRyZW5cIjogW10sXG4gICAgICAgICAgICBcIl9hY3RpdmVcIjogdHJ1ZSxcbiAgICAgICAgICAgIFwiX2NvbXBvbmVudHNcIjogW10sXG4gICAgICAgICAgICBcIl9wcmVmYWJcIjogbnVsbCxcbiAgICAgICAgICAgIFwiX2xwb3NcIjogeyBcIl9fdHlwZV9fXCI6IFwiY2MuVmVjM1wiLCBcInhcIjogMCwgXCJ5XCI6IDAsIFwielwiOiAwIH0sXG4gICAgICAgICAgICBcIl9scm90XCI6IHsgXCJfX3R5cGVfX1wiOiBcImNjLlF1YXRcIiwgXCJ4XCI6IDAsIFwieVwiOiAwLCBcInpcIjogMCwgXCJ3XCI6IDEgfSxcbiAgICAgICAgICAgIFwiX2xzY2FsZVwiOiB7IFwiX190eXBlX19cIjogXCJjYy5WZWMzXCIsIFwieFwiOiAxLCBcInlcIjogMSwgXCJ6XCI6IDEgfSxcbiAgICAgICAgICAgIFwiX21vYmlsaXR5XCI6IDAsXG4gICAgICAgICAgICBcIl9sYXllclwiOiAxMDczNzQxODI0LFxuICAgICAgICAgICAgXCJfZXVsZXJcIjogeyBcIl9fdHlwZV9fXCI6IFwiY2MuVmVjM1wiLCBcInhcIjogMCwgXCJ5XCI6IDAsIFwielwiOiAwIH0sXG4gICAgICAgICAgICBcImF1dG9SZWxlYXNlQXNzZXRzXCI6IGZhbHNlLFxuICAgICAgICAgICAgXCJfZ2xvYmFsc1wiOiB7IFwiX19pZF9fXCI6IDIgfSxcbiAgICAgICAgICAgIFwiX2lkXCI6IFwic2NlbmVcIixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLlNjZW5lR2xvYmFsc1wiLFxuICAgICAgICAgICAgXCJhbWJpZW50XCI6IHsgXCJfX2lkX19cIjogMyB9LFxuICAgICAgICAgICAgXCJza3lib3hcIjogeyBcIl9faWRfX1wiOiA0IH0sXG4gICAgICAgICAgICBcImZvZ1wiOiB7IFwiX19pZF9fXCI6IDUgfSxcbiAgICAgICAgICAgIFwib2N0cmVlXCI6IHsgXCJfX2lkX19cIjogNiB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuQW1iaWVudEluZm9cIixcbiAgICAgICAgICAgIFwiX3NreUNvbG9ySERSXCI6IHsgXCJfX3R5cGVfX1wiOiBcImNjLlZlYzRcIiwgXCJ4XCI6IDAuMiwgXCJ5XCI6IDAuNSwgXCJ6XCI6IDAuOCwgXCJ3XCI6IDAuNTIwODMzIH0sXG4gICAgICAgICAgICBcIl9za3lDb2xvclwiOiB7IFwiX190eXBlX19cIjogXCJjYy5WZWM0XCIsIFwieFwiOiAwLjIsIFwieVwiOiAwLjUsIFwielwiOiAwLjgsIFwid1wiOiAwLjUyMDgzMyB9LFxuICAgICAgICAgICAgXCJfc2t5SWxsdW1IRFJcIjogMjAwMDAsXG4gICAgICAgICAgICBcIl9za3lJbGx1bVwiOiAyMDAwMCxcbiAgICAgICAgICAgIFwiX2dyb3VuZEFsYmVkb0hEUlwiOiB7IFwiX190eXBlX19cIjogXCJjYy5WZWM0XCIsIFwieFwiOiAwLjIsIFwieVwiOiAwLjIsIFwielwiOiAwLjIsIFwid1wiOiAxIH0sXG4gICAgICAgICAgICBcIl9ncm91bmRBbGJlZG9cIjogeyBcIl9fdHlwZV9fXCI6IFwiY2MuVmVjNFwiLCBcInhcIjogMC4yLCBcInlcIjogMC4yLCBcInpcIjogMC4yLCBcIndcIjogMSB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuU2t5Ym94SW5mb1wiLFxuICAgICAgICAgICAgXCJfZW52TGlnaHRpbmdUeXBlXCI6IDAsXG4gICAgICAgICAgICBcIl9lbnZtYXBIRFJcIjogbnVsbCwgXCJfZW52bWFwXCI6IG51bGwsIFwiX2Vudm1hcExvZENvdW50XCI6IDAsXG4gICAgICAgICAgICBcIl9kaWZmdXNlTWFwSERSXCI6IG51bGwsIFwiX2RpZmZ1c2VNYXBcIjogbnVsbCxcbiAgICAgICAgICAgIFwiX2VuYWJsZWRcIjogZmFsc2UsIFwiX3VzZUhEUlwiOiB0cnVlLFxuICAgICAgICAgICAgXCJfZWRpdGFibGVNYXRlcmlhbFwiOiBudWxsLCBcIl9yZWZsZWN0aW9uSERSXCI6IG51bGwsIFwiX3JlZmxlY3Rpb25NYXBcIjogbnVsbCxcbiAgICAgICAgICAgIFwiX3JvdGF0aW9uQW5nbGVcIjogMCxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLkZvZ0luZm9cIixcbiAgICAgICAgICAgIFwiX3R5cGVcIjogMCxcbiAgICAgICAgICAgIFwiX2ZvZ0NvbG9yXCI6IHsgXCJfX3R5cGVfX1wiOiBcImNjLkNvbG9yXCIsIFwiclwiOiAyMDAsIFwiZ1wiOiAyMDAsIFwiYlwiOiAyMDAsIFwiYVwiOiAyNTUgfSxcbiAgICAgICAgICAgIFwiX2VuYWJsZWRcIjogZmFsc2UsIFwiX2ZvZ0RlbnNpdHlcIjogMC4zLCBcIl9mb2dTdGFydFwiOiAwLjUsIFwiX2ZvZ0VuZFwiOiAzMDAsXG4gICAgICAgICAgICBcIl9mb2dBdHRlblwiOiA1LCBcIl9mb2dUb3BcIjogMS41LCBcIl9mb2dSYW5nZVwiOiAxLjIsIFwiX2FjY3VyYXRlXCI6IGZhbHNlLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuT2N0cmVlSW5mb1wiLFxuICAgICAgICAgICAgXCJfZW5hYmxlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgIFwiX21pblBvc1wiOiB7IFwiX190eXBlX19cIjogXCJjYy5WZWMzXCIsIFwieFwiOiAtMTAyNCwgXCJ5XCI6IC0xMDI0LCBcInpcIjogLTEwMjQgfSxcbiAgICAgICAgICAgIFwiX21heFBvc1wiOiB7IFwiX190eXBlX19cIjogXCJjYy5WZWMzXCIsIFwieFwiOiAxMDI0LCBcInlcIjogMTAyNCwgXCJ6XCI6IDEwMjQgfSxcbiAgICAgICAgICAgIFwiX2RlcHRoXCI6IDgsXG4gICAgICAgIH0sXG4gICAgXSwgbnVsbCwgMik7XG59XG5cbkBNQ1BNb2R1bGUoJ3NjZW5lJywgJ+WcuuaZr+e8lui+kSAtIOWcuuaZr+eUn+WRveWRqOacn+OAgeiKgueCueagkeafpeivouOAgeiKgueCuS/nu4Tku7YgQ1JVROOAgeiEmuacrOaJp+ihjCcpXG5leHBvcnQgY2xhc3MgU2NlbmVNb2R1bGUge1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Zy65pmv55Sf5ZG95ZGo5pyfID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5omA5pyJ5Zy65pmv5YiX6KGoJywge1xuICAgICAgICBmb2xkZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pCc57Si5paH5Lu25aS56Lev5b6E77yI5Y+v6YCJ77yM6buY6K6kIGRiOi8vYXNzZXRz77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgZ2V0X3NjZW5lX2xpc3QocGFyYW1zPzogeyBmb2xkZXI/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGZvbGRlciA9IHBhcmFtcz8uZm9sZGVyIHx8ICdkYjovL2Fzc2V0cyc7XG4gICAgICAgIGNvbnN0IHBhdHRlcm4gPSBmb2xkZXIuZW5kc1dpdGgoJy8nKSA/IGAke2ZvbGRlcn0qKi8qLnNjZW5lYCA6IGAke2ZvbGRlcn0vKiovKi5zY2VuZWA7XG4gICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjYWxsQXNzZXREQigncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuIH0pO1xuICAgICAgICBjb25zdCBzY2VuZXMgPSAocmVzdWx0cyB8fCBbXSkubWFwKChhOiBhbnkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBhLm5hbWUsXG4gICAgICAgICAgICBwYXRoOiBhLnVybCxcbiAgICAgICAgICAgIHV1aWQ6IGEudXVpZCxcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4geyBzY2VuZXMgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5omT5byA5oyH5a6a5Zy65pmvJywge1xuICAgICAgICBzY2VuZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Zy65pmv6Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL3NjZW5lcy9NYWluLnNjZW5l77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIG9wZW5fc2NlbmUocGFyYW1zOiB7IHNjZW5lUGF0aDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgY2FsbEFzc2V0REIoJ3F1ZXJ5LXV1aWQnLCBwYXJhbXMuc2NlbmVQYXRoKTtcbiAgICAgICAgaWYgKCF1dWlkKSB0aHJvdyBuZXcgRXJyb3IoYOacquaJvuWIsOWcuuaZrzogJHtwYXJhbXMuc2NlbmVQYXRofWApO1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ29wZW4tc2NlbmUnLCB1dWlkKTtcbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogYOW3suaJk+W8gOWcuuaZrzogJHtwYXJhbXMuc2NlbmVQYXRofWAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5L+d5a2Y5b2T5YmN5Zy65pmvJylcbiAgICBhc3luYyBzYXZlX3NjZW5lKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGF3YWl0IGNhbGxTY2VuZSgnc2F2ZS1zY2VuZScpO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiAn5Zy65pmv5bey5L+d5a2YJyB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCflj6blrZjlvZPliY3lnLrmma8nLCB7XG4gICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55uu5qCH5L+d5a2Y6Lev5b6EJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgc2F2ZV9zY2VuZV9hcyhfcGFyYW1zPzogeyBwYXRoPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ3NhdmUtYXMtc2NlbmUnKTtcbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogJ+W3suaJk+W8gOWPpuWtmOWvueivneahhicgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5YWz6Zet5b2T5YmN5Zy65pmvJylcbiAgICBhc3luYyBjbG9zZV9zY2VuZSgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ2Nsb3NlLXNjZW5lJyk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICflnLrmma/lt7LlhbPpl60nIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIm+W7uuepuueZveaWsOWcuuaZrycsIHtcbiAgICAgICAgc2NlbmVOYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WcuuaZr+WQjeensCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHNhdmVQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+S/neWtmOi3r+W+hO+8iOWmgiBkYjovL2Fzc2V0cy9zY2VuZXMvTmV3U2NlbmUuc2NlbmXvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgY3JlYXRlX3NjZW5lKHBhcmFtczogeyBzY2VuZU5hbWU6IHN0cmluZzsgc2F2ZVBhdGg6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgZnVsbFBhdGggPSBwYXJhbXMuc2F2ZVBhdGguZW5kc1dpdGgoJy5zY2VuZScpID8gcGFyYW1zLnNhdmVQYXRoIDogYCR7cGFyYW1zLnNhdmVQYXRofS8ke3BhcmFtcy5zY2VuZU5hbWV9LnNjZW5lYDtcbiAgICAgICAgY29uc3QgY29udGVudCA9IGJ1aWxkU2NlbmVKU09OKHBhcmFtcy5zY2VuZU5hbWUpO1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYWxsQXNzZXREQignY3JlYXRlLWFzc2V0JywgZnVsbFBhdGgsIGNvbnRlbnQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOWcuuaZryAnJHtwYXJhbXMuc2NlbmVOYW1lfScg5bey5Yib5bu6YCxcbiAgICAgICAgICAgIHV1aWQ6IHJlc3VsdD8udXVpZCxcbiAgICAgICAgICAgIHVybDogcmVzdWx0Py51cmwsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Zy65pmv5p+l6K+i77yI5Y6f5pyJ5bel5YW377yM57uf5LiA5ZG95ZCN77yJID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5b2T5YmN5omT5byA55qE5Zy65pmv5L+h5oGvJylcbiAgICBhc3luYyBxdWVyeV9jdXJyZW50X3NjZW5lKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5Zy65pmv6IqC54K55qCR77yM6L+U5Zue5b2T5YmN5omT5byA5Zy65pmv55qE5a6M5pW06IqC54K55bGC57qn57uT5p6EJywge1xuICAgICAgICBpbmNsdWRlQ29tcG9uZW50czogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmmK/lkKbljIXlkKvnu4Tku7bkv6Hmga/vvIzpu5jorqQgZmFsc2UnIH0sXG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUTvvIjlj6/pgInvvIzpu5jorqTmoLnoioLngrnvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9ub2RlX3RyZWUocGFyYW1zPzogeyB1dWlkPzogc3RyaW5nOyBpbmNsdWRlQ29tcG9uZW50cz86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgLy8g5L2/55So5Y+M6YCa6YGT77ya5YWI5bCd6K+VIEVkaXRvciBBUEnvvIzlpLHotKXliJnnlKjlnLrmma/ohJrmnKxcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHRyZWUgPSBhd2FpdCBjYWxsU2NlbmUoJ3F1ZXJ5LW5vZGUtdHJlZScsIHBhcmFtcz8udXVpZCk7XG4gICAgICAgICAgICBpZiAodHJlZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGluY2x1ZGVDb21wcyA9IFN0cmluZyhwYXJhbXM/LmluY2x1ZGVDb21wb25lbnRzID8/ICcnKSA9PT0gJ3RydWUnO1xuICAgICAgICAgICAgICAgIGlmIChpbmNsdWRlQ29tcHMpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuZW5yaWNoV2l0aENvbXBvbmVudHModHJlZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB0cmVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdxdWVyeS1ub2RlLXRyZWUg6L+U5Zue56m6Jyk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgY29uc3QgaW5jbHVkZUNvbXBzID0gU3RyaW5nKHBhcmFtcz8uaW5jbHVkZUNvbXBvbmVudHMgPz8gJycpID09PSAndHJ1ZSc7XG4gICAgICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRTY2VuZUhpZXJhcmNoeScsIFtpbmNsdWRlQ29tcHNdKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrproioLngrnnmoTor6bnu4bkv6Hmga/vvIjlkI3np7DjgIFVVUlE44CB57uE5Lu25YiX6KGo44CBVHJhbnNmb3JtIOetie+8iScsIHtcbiAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnnmoQgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9ub2RlKHBhcmFtczogeyB1dWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIC8vIOWFiOivlSBzY2VuZSBBUEnvvIzlpLHotKXliJnnlKjlnLrmma/ohJrmnKxcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGxTY2VuZSgncXVlcnktbm9kZScsIHBhcmFtcy51dWlkKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3F1ZXJ5LW5vZGUg6L+U5Zue56m6Jyk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dGVTY2VuZVNjcmlwdCgnZ2V0Tm9kZUluZm8nLCBbcGFyYW1zLnV1aWRdKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrproioLngrnkuIrmn5Dnsbvlnovnu4Tku7bnmoTlsZ7mgKflkozlgLwnLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgY29tcG9uZW50VHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7bnsbvlnovlkI3vvIzlpoIgY2MuU3ByaXRlLCBjYy5MYWJlbCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9jb21wb25lbnQocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IGNvbXBvbmVudFR5cGU6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktY29tcG9uZW50JywgcGFyYW1zLm5vZGVVdWlkLCBwYXJhbXMuY29tcG9uZW50VHlwZSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iOt+WPluW9k+WJjeWcuuaZr+eahOWujOaVtCBKU09OIOW6j+WIl+WMluaVsOaNricpXG4gICAgYXN5bmMgcXVlcnlfc2NlbmVfanNvbigpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1zY2VuZS1qc29uJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouWcuuaZr+S4reaJgOacieWPr+eUqOeahOe7hOS7tuexu+WIl+ihqCcpXG4gICAgYXN5bmMgcXVlcnlfY2xhc3NlcygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1jbGFzc2VzJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouaMh+WumuiKgueCueS4iueahOaJgOaciee7hOS7tuWIl+ihqCcsIHtcbiAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnnmoQgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9jb21wb25lbnRzKHBhcmFtczogeyB1dWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWNvbXBvbmVudHMnLCBwYXJhbXMudXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouWcuuaZr+e8lui+keWZqOaYr+WQpuWwsee7qicpXG4gICAgYXN5bmMgcXVlcnlfaXNfcmVhZHkoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktaXMtcmVhZHknKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5b2T5YmN5Zy65pmv5piv5ZCm5pyJ5pyq5L+d5a2Y55qE5L+u5pS5JylcbiAgICBhc3luYyBxdWVyeV9kaXJ0eSgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1kaXJ0eScpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOiKgueCueaTjeS9nO+8iOmAmui/h+WcuuaZr+iEmuacrO+8iSA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+iOt+WPluWcuuaZr+S4reaJgOacieiKgueCueWIl+ihqCcsIHtcbiAgICAgICAgaW5jbHVkZUNvbXBvbmVudHM6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5piv5ZCm5YyF5ZCr57uE5Lu25L+h5oGv77yM6buY6K6kIGZhbHNlJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgZ2V0X2FsbF9ub2RlcyhwYXJhbXM/OiB7IGluY2x1ZGVDb21wb25lbnRzPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRBbGxOb2RlcycpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmjInlkI3np7Dmn6Xmib7oioLngrnvvIjmlK/mjIHnsr7noa7ljLnphY3vvIknLCB7XG4gICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCN56ewJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGZpbmRfbm9kZV9ieV9uYW1lKHBhcmFtczogeyBuYW1lOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVTY3JpcHQoJ2ZpbmROb2RlQnlOYW1lJywgW3BhcmFtcy5uYW1lXSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+aMiee7hOS7tuexu+Wei+afpeaJvuiKgueCuScsIHtcbiAgICAgICAgY29tcG9uZW50VHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7bnsbvlnovlkI3vvIzlpoIgY2MuU3ByaXRlLCBjYy5MYWJlbCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBmaW5kX25vZGVzX2J5X2NvbXBvbmVudChwYXJhbXM6IHsgY29tcG9uZW50VHlwZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdmaW5kTm9kZXNCeUNvbXBvbmVudCcsIFtwYXJhbXMuY29tcG9uZW50VHlwZV0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfojrflj5blnLrmma/lrozmlbTlsYLnuqfmoJHvvIjlkKvnu4Tku7bkv6Hmga/lj6/pgInvvIknLCB7XG4gICAgICAgIGluY2x1ZGVDb21wb25lbnRzOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aYr+WQpuWMheWQq+e7hOS7tuS/oeaBr++8jOS8oCBcInRydWVcIiDljbPljIXlkKsnIH0sXG4gICAgfSlcbiAgICBhc3luYyBnZXRfc2NlbmVfaGllcmFyY2h5KHBhcmFtcz86IHsgaW5jbHVkZUNvbXBvbmVudHM/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGluY2x1ZGVDb21wcyA9IFN0cmluZyhwYXJhbXM/LmluY2x1ZGVDb21wb25lbnRzID8/ICcnKSA9PT0gJ3RydWUnO1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRTY2VuZUhpZXJhcmNoeScsIFtpbmNsdWRlQ29tcHNdKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5Zyo5Zy65pmv5Lit5Yib5bu65paw6IqC54K577yI6YCa6L+H5Zy65pmv6ISa5pys77yM5pSv5oyB5oyH5a6a54i26IqC54K577yJJywge1xuICAgICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueWQjeensCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHBhcmVudFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn54i26IqC54K5IFVVSUTvvIjlj6/pgInvvIzpu5jorqTlnLrmma/moLnoioLngrnvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBjcmVhdGVfbm9kZShwYXJhbXM6IHsgbmFtZTogc3RyaW5nOyBwYXJlbnRVdWlkPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdjcmVhdGVOb2RlJywgW3BhcmFtcy5uYW1lLCBwYXJhbXMucGFyZW50VXVpZF0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliKDpmaTmjIflrproioLngrknLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgZGVsZXRlX25vZGUocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGV4ZWN1dGVTY2VuZVNjcmlwdCgnZGVsZXRlTm9kZScsIFtwYXJhbXMudXVpZF0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCflpI3liLboioLngrnvvIjmt7Hmi7fotJ3vvIknLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5rqQ6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgZHVwbGljYXRlX25vZGUocGFyYW1zOiB7IHV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGV4ZWN1dGVTY2VuZVNjcmlwdCgnZHVwbGljYXRlTm9kZScsIFtwYXJhbXMudXVpZF0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfnp7vliqjoioLngrnliLDmlrDniLboioLngrnkuIsnLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6KaB56e75Yqo55qE6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBuZXdQYXJlbnRVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWsOeItuiKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIG1vdmVfbm9kZShwYXJhbXM6IHsgdXVpZDogc3RyaW5nOyBuZXdQYXJlbnRVdWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVTY3JpcHQoJ21vdmVOb2RlJywgW3BhcmFtcy51dWlkLCBwYXJhbXMubmV3UGFyZW50VXVpZF0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCforr7nva7oioLngrnlsZ7mgKfvvIhwb3NpdGlvbi9yb3RhdGlvbi9zY2FsZS9hY3RpdmUvbmFtZS9sYXllci9tb2JpbGl0ee+8iScsIHtcbiAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHByb3BlcnR5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WQjScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHZhbHVlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WAvO+8iEpTT07vvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgc2V0X25vZGVfcHJvcGVydHkocGFyYW1zOiB7IHV1aWQ6IHN0cmluZzsgcHJvcGVydHk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKHBhcmFtcy52YWx1ZSk7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldE5vZGVQcm9wZXJ0eScsIFtwYXJhbXMudXVpZCwgcGFyYW1zLnByb3BlcnR5LCB2YWx1ZV0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCforr7nva7oioLngrkgVHJhbnNmb3Jt77yIcG9zaXRpb24vcm90YXRpb24vc2NhbGUg57uf5LiA5o6l5Y+j77yJJywge1xuICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcG9zaXRpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5L2N572uIEpTT04g5aaCIHtcInhcIjoxMDAsXCJ5XCI6MjAwLFwielwiOjB9JyB9LFxuICAgICAgICByb3RhdGlvbjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfml4vovawgSlNPTiDlpoIge1wieFwiOjAsXCJ5XCI6MCxcInpcIjo0NX0nIH0sXG4gICAgICAgIHNjYWxlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e8qeaUviBKU09OIOWmgiB7XCJ4XCI6MSxcInlcIjoxLFwielwiOjF9JyB9LFxuICAgIH0pXG4gICAgYXN5bmMgc2V0X25vZGVfdHJhbnNmb3JtKHBhcmFtczogeyB1dWlkOiBzdHJpbmc7IHBvc2l0aW9uPzogc3RyaW5nOyByb3RhdGlvbj86IHN0cmluZzsgc2NhbGU/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGlmIChwYXJhbXMucG9zaXRpb24pIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IEpTT04ucGFyc2UocGFyYW1zLnBvc2l0aW9uKTtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW3BhcmFtcy51dWlkLCAncG9zaXRpb24nLCBwb3NdKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyYW1zLnJvdGF0aW9uKSB7XG4gICAgICAgICAgICBjb25zdCByb3QgPSBKU09OLnBhcnNlKHBhcmFtcy5yb3RhdGlvbik7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldE5vZGVQcm9wZXJ0eScsIFtwYXJhbXMudXVpZCwgJ3JvdGF0aW9uJywgcm90XSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy5zY2FsZSkge1xuICAgICAgICAgICAgY29uc3Qgc2NsID0gSlNPTi5wYXJzZShwYXJhbXMuc2NhbGUpO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXROb2RlUHJvcGVydHknLCBbcGFyYW1zLnV1aWQsICdzY2FsZScsIHNjbF0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICdUcmFuc2Zvcm0g5bey5pu05pawJyB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOe7hOS7tuaTjeS9nO+8iOmAmui/h+WcuuaZr+iEmuacrO+8iSA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+S4uuiKgueCuea3u+WKoOe7hOS7ticsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBjb21wb25lbnRUeXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tuexu+Wei+WQje+8jOWmgiBjYy5TcHJpdGUsIGNjLkxhYmVsLCBjYy5CdXR0b24nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgYWRkX2NvbXBvbmVudChwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgY29tcG9uZW50VHlwZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbcGFyYW1zLm5vZGVVdWlkLCBwYXJhbXMuY29tcG9uZW50VHlwZV0pO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfnp7vpmaToioLngrnkuIrnmoTnu4Tku7YnLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgY29tcG9uZW50VHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7bnsbvlnovlkI0nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgcmVtb3ZlX2NvbXBvbmVudChwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgY29tcG9uZW50VHlwZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gZXhlY3V0ZVNjZW5lU2NyaXB0KCdyZW1vdmVDb21wb25lbnRGcm9tTm9kZScsIFtwYXJhbXMubm9kZVV1aWQsIHBhcmFtcy5jb21wb25lbnRUeXBlXSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iuvue9rue7hOS7tuWxnuaAp++8iOaUr+aMgSBTcHJpdGUvTGFiZWwvQnV0dG9uIOetieW4uOingee7hOS7tueJueauiuWkhOeQhu+8iScsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBjb21wb25lbnRUeXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tuexu+Wei+WQjScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHByb3BlcnR5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WQje+8iOWmgiBzdHJpbmcsIHNwcml0ZUZyYW1lLCBjb2xvciwgZm9udFNpemXvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB2YWx1ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflgLzvvIhKU09O77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNldF9jb21wb25lbnRfcHJvcGVydHkocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IGNvbXBvbmVudFR5cGU6IHN0cmluZzsgcHJvcGVydHk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKHBhcmFtcy52YWx1ZSk7XG4gICAgICAgIHJldHVybiBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgcGFyYW1zLmNvbXBvbmVudFR5cGUsIHBhcmFtcy5wcm9wZXJ0eSwgdmFsdWVdKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDlnLrmma/ohJrmnKzmiafooYwgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCflnKjlnLrmma/kuK3miafooYzohJrmnKzmlrnms5XvvIjlpoLnu4Tku7bkuIrnmoTmlrnms5XvvIknLCB7XG4gICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55uu5qCH6IqC54K55oiW57uE5Lu255qEIFVVSUQnIH0sXG4gICAgICAgIG1ldGhvZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfopoHmiafooYznmoTmlrnms5XlkI0nIH0sXG4gICAgICAgIGFyZ3M6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pa55rOV5Y+C5pWw77yISlNPTiDmlbDnu4TlrZfnrKbkuLLvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBleGVjdXRlX3NjZW5lX3NjcmlwdChwYXJhbXM6IHsgdXVpZDogc3RyaW5nOyBtZXRob2Q6IHN0cmluZzsgYXJncz86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgbWV0aG9kQXJncyA9IHBhcmFtcy5hcmdzID8gSlNPTi5wYXJzZShwYXJhbXMuYXJncykgOiBbXTtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCBwYXJhbXMudXVpZCwgcGFyYW1zLm1ldGhvZCwgLi4ubWV0aG9kQXJncyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+i9r+mHjei9veW9k+WJjeWcuuaZr++8iOS/neeVmeeKtuaAge+8iScpXG4gICAgYXN5bmMgc29mdF9yZWxvYWQoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnc29mdC1yZWxvYWQnKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDnvJbovpHlmajmk43kvZzvvIh1bmRvL3JlZG8vY29weS9wYXN0ZS9jdXTvvIkgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmkqTplIDkuIrkuIDmraXnvJbovpHmk43kvZwnKVxuICAgIGFzeW5jIHVuZG8oKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgYXdhaXQgY2FsbFNjZW5lKCd1bmRvJyk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6ICflt7LmkqTplIAnIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+mHjeWBmuW3suaSpOmUgOeahOaTjeS9nCcpXG4gICAgYXN5bmMgcmVkbygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ3JlZG8nKTtcbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogJ+W3sumHjeWBmicgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5aSN5Yi26IqC54K55Yiw5Ymq6LS05p2/Jywge1xuICAgICAgICB1dWlkczogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRO+8iOWNleS4quaIliBKU09OIOaVsOe7hOWtl+espuS4su+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBjb3B5X25vZGUocGFyYW1zOiB7IHV1aWRzOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGxldCB1dWlkczogc3RyaW5nW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICB1dWlkcyA9IEpTT04ucGFyc2UocGFyYW1zLnV1aWRzKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICB1dWlkcyA9IFtwYXJhbXMudXVpZHNdO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGNhbGxTY2VuZSgnY29weS1ub2RlJywgdXVpZHMpO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiBg5bey5aSN5Yi2ICR7dXVpZHMubGVuZ3RofSDkuKroioLngrlgIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+eymOi0tOWJqui0tOadv+S4reeahOiKgueCuScsIHtcbiAgICAgICAgdGFyZ2V0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+eItuiKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHBhc3RlX25vZGUocGFyYW1zOiB7IHRhcmdldDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ3Bhc3RlLW5vZGUnLCBwYXJhbXMudGFyZ2V0KTtcbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogJ+iKgueCueW3sueymOi0tCcgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5Ymq5YiH6IqC54K577yI5aSN5Yi2K+WIoOmZpO+8iScsIHtcbiAgICAgICAgdXVpZHM6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUTvvIjljZXkuKrmiJYgSlNPTiDmlbDnu4TlrZfnrKbkuLLvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgY3V0X25vZGUocGFyYW1zOiB7IHV1aWRzOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGxldCB1dWlkczogc3RyaW5nW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICB1dWlkcyA9IEpTT04ucGFyc2UocGFyYW1zLnV1aWRzKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICB1dWlkcyA9IFtwYXJhbXMudXVpZHNdO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGNhbGxTY2VuZSgnY3V0LW5vZGUnLCB1dWlkcyk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDlt7LliarliIcgJHt1dWlkcy5sZW5ndGh9IOS4quiKgueCuWAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6YeN572u6IqC54K55bGe5oCn5Li66buY6K6k5YC8Jywge1xuICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfot6/lvoTvvIhwb3NpdGlvbi9yb3RhdGlvbi9zY2FsZS9fbHBvcyDnrYnvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgcmVzZXRfbm9kZV9wcm9wZXJ0eShwYXJhbXM6IHsgdXVpZDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGF3YWl0IGNhbGxTY2VuZSgncmVzZXQtbm9kZS1wcm9wZXJ0eScsIHBhcmFtcy51dWlkLCBwYXJhbXMucGF0aCk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDlt7Lph43nva7lsZ7mgKc6ICR7cGFyYW1zLnBhdGh9YCB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOe7hOWQiOW3peWFt++8iOWkmuatpee8luaOku+8iSA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+S4gOmUruWIm+W7uuagh+WHhiAyRCDlnLrmma/vvIhDYW52YXMgKyBDYW1lcmEgKyDog4zmma/oioLngrnvvInjgILpgILnlKjkuo7lv6vpgJ/liJ3lp4vljJYgVUkg5Zy65pmvJywge1xuICAgICAgICBzY2VuZU5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Zy65pmv5ZCN56ewJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgc2F2ZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5L+d5a2Y6Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL3NjZW5lcy9VSVNjZW5lLnNjZW5l77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcmVzb2x1dGlvbldpZHRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iuvuiuoeWIhui+qOeOh+Wuve+8iOm7mOiupCAxOTIw77yJJyB9LFxuICAgICAgICByZXNvbHV0aW9uSGVpZ2h0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iuvuiuoeWIhui+qOeOh+mrmO+8iOm7mOiupCAxMDgw77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgY3JlYXRlX2RlZmF1bHRfMmRfc2NlbmUocGFyYW1zOiB7XG4gICAgICAgIHNjZW5lTmFtZTogc3RyaW5nO1xuICAgICAgICBzYXZlUGF0aDogc3RyaW5nO1xuICAgICAgICByZXNvbHV0aW9uV2lkdGg/OiBzdHJpbmc7XG4gICAgICAgIHJlc29sdXRpb25IZWlnaHQ/OiBzdHJpbmc7XG4gICAgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIC8vIDEuIOWIm+W7uuWcuuaZr+aWh+S7tlxuICAgICAgICBjb25zdCBmdWxsUGF0aCA9IHBhcmFtcy5zYXZlUGF0aC5lbmRzV2l0aCgnLnNjZW5lJylcbiAgICAgICAgICAgID8gcGFyYW1zLnNhdmVQYXRoXG4gICAgICAgICAgICA6IGAke3BhcmFtcy5zYXZlUGF0aH0vJHtwYXJhbXMuc2NlbmVOYW1lfS5zY2VuZWA7XG4gICAgICAgIGNvbnN0IGNvbnRlbnQgPSBidWlsZFNjZW5lSlNPTihwYXJhbXMuc2NlbmVOYW1lKTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FsbEFzc2V0REIoJ2NyZWF0ZS1hc3NldCcsIGZ1bGxQYXRoLCBjb250ZW50KTtcblxuICAgICAgICAvLyAyLiDmiZPlvIDmlrDlnLrmma9cbiAgICAgICAgYXdhaXQgY2FsbFNjZW5lKCdvcGVuLXNjZW5lJywgcmVzdWx0LnV1aWQpO1xuXG4gICAgICAgIC8vIDMuIOWIm+W7uiBDYW52YXMg6IqC54K5XG4gICAgICAgIGNvbnN0IGNhbnZhc1Jlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlTm9kZScsIFsnQ2FudmFzJ10pO1xuICAgICAgICBjb25zdCBjYW52YXNVdWlkID0gY2FudmFzUmVzdWx0LmRhdGE/LnV1aWQ7XG5cbiAgICAgICAgLy8gNC4g5Li6IENhbnZhcyDmt7vliqAgY2MuQ2FudmFzIOe7hOS7tlxuICAgICAgICBjb25zdCB3aWR0aCA9IHBhcnNlSW50KHBhcmFtcy5yZXNvbHV0aW9uV2lkdGggfHwgJzE5MjAnLCAxMCk7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IHBhcnNlSW50KHBhcmFtcy5yZXNvbHV0aW9uSGVpZ2h0IHx8ICcxMDgwJywgMTApO1xuXG4gICAgICAgIGlmIChjYW52YXNVdWlkKSB7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtjYW52YXNVdWlkLCAnY2MuQ2FudmFzJ10pO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbY2FudmFzVXVpZCwgJ2NjLlVJVHJhbnNmb3JtJ10pO1xuXG4gICAgICAgICAgICAvLyDorr7nva4gQ2FudmFzIOS9jee9rlxuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXROb2RlUHJvcGVydHknLCBbY2FudmFzVXVpZCwgJ3Bvc2l0aW9uJywgeyB4OiB3aWR0aCAvIDIsIHk6IGhlaWdodCAvIDIsIHo6IDAgfV0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gNS4g5Yib5bu6IENhbWVyYSDoioLngrlcbiAgICAgICAgY29uc3QgY2FtZXJhUmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdjcmVhdGVOb2RlJywgWydDYW1lcmEnLCBjYW52YXNVdWlkXSk7XG4gICAgICAgIGNvbnN0IGNhbWVyYVV1aWQgPSBjYW1lcmFSZXN1bHQuZGF0YT8udXVpZDtcblxuICAgICAgICBpZiAoY2FtZXJhVXVpZCkge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbY2FtZXJhVXVpZCwgJ2NjLkNhbWVyYSddKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIDYuIOS/neWtmOWcuuaZr1xuICAgICAgICBhd2FpdCBjYWxsU2NlbmUoJ3NhdmUtc2NlbmUnKTtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOagh+WHhiAyRCDlnLrmma8gJyR7cGFyYW1zLnNjZW5lTmFtZX0nIOW3suWIm+W7umAsXG4gICAgICAgICAgICB1dWlkOiByZXN1bHQudXVpZCxcbiAgICAgICAgICAgIHVybDogcmVzdWx0LnVybCxcbiAgICAgICAgICAgIGNhbnZhc1V1aWQsXG4gICAgICAgICAgICBjYW1lcmFVdWlkLFxuICAgICAgICAgICAgcmVzb2x1dGlvbjogeyB3aWR0aCwgaGVpZ2h0IH0sXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIm+W7uuW4puiDjOaZryBTcHJpdGUg55qE6IqC54K577yI5LiA6ZSu5Yib5bu66IqC54K5K+a3u+WKoCBTcHJpdGUg57uE5Lu2K+iuvue9rui0tOWbvu+8iScsIHtcbiAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnlkI3np7AnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwYXJlbnRVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+eItuiKgueCuSBVVUlE77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBzcHJpdGVGcmFtZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnU3ByaXRlRnJhbWUg6LWE5rqQ55qEIFVVSUQnIH0sXG4gICAgICAgIHBvc2l0aW9uOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+S9jee9riBKU09OJyB9LFxuICAgICAgICBzaXplOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WwuuWvuCBKU09O77yI5aaCIHtcInhcIjoxMDAsXCJ5XCI6MTAwfe+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNyZWF0ZV9zcHJpdGVfbm9kZShwYXJhbXM6IHtcbiAgICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgICBwYXJlbnRVdWlkPzogc3RyaW5nO1xuICAgICAgICBzcHJpdGVGcmFtZVV1aWQ/OiBzdHJpbmc7XG4gICAgICAgIHBvc2l0aW9uPzogc3RyaW5nO1xuICAgICAgICBzaXplPzogc3RyaW5nO1xuICAgIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICAvLyAxLiDliJvlu7roioLngrlcbiAgICAgICAgY29uc3Qgbm9kZVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlTm9kZScsIFtwYXJhbXMubmFtZSwgcGFyYW1zLnBhcmVudFV1aWRdKTtcbiAgICAgICAgY29uc3Qgbm9kZVV1aWQgPSBub2RlUmVzdWx0LmRhdGE/LnV1aWQ7XG4gICAgICAgIGlmICghbm9kZVV1aWQpIHRocm93IG5ldyBFcnJvcign5Yib5bu66IqC54K55aSx6LSlJyk7XG5cbiAgICAgICAgLy8gMi4g5re75YqgIFNwcml0ZSArIFVJVHJhbnNmb3JtIOe7hOS7tlxuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtub2RlVXVpZCwgJ2NjLlNwcml0ZSddKTtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbm9kZVV1aWQsICdjYy5VSVRyYW5zZm9ybSddKTtcblxuICAgICAgICAvLyAzLiDorr7nva7otLTlm75cbiAgICAgICAgaWYgKHBhcmFtcy5zcHJpdGVGcmFtZVV1aWQpIHtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbXG4gICAgICAgICAgICAgICAgbm9kZVV1aWQsXG4gICAgICAgICAgICAgICAgJ2NjLlNwcml0ZScsXG4gICAgICAgICAgICAgICAgJ3Nwcml0ZUZyYW1lJyxcbiAgICAgICAgICAgICAgICBwYXJhbXMuc3ByaXRlRnJhbWVVdWlkLFxuICAgICAgICAgICAgXSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyA0LiDorr7nva7kvY3nva7lkozlsLrlr7hcbiAgICAgICAgaWYgKHBhcmFtcy5wb3NpdGlvbikge1xuICAgICAgICAgICAgY29uc3QgcG9zID0gSlNPTi5wYXJzZShwYXJhbXMucG9zaXRpb24pO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXROb2RlUHJvcGVydHknLCBbbm9kZVV1aWQsICdwb3NpdGlvbicsIHBvc10pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMuc2l6ZSkge1xuICAgICAgICAgICAgY29uc3Qgc2l6ZSA9IEpTT04ucGFyc2UocGFyYW1zLnNpemUpO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtcbiAgICAgICAgICAgICAgICBub2RlVXVpZCxcbiAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nLFxuICAgICAgICAgICAgICAgICdjb250ZW50U2l6ZScsXG4gICAgICAgICAgICAgICAgc2l6ZSxcbiAgICAgICAgICAgIF0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBTcHJpdGUg6IqC54K5ICcke3BhcmFtcy5uYW1lfScg5bey5Yib5bu6YCxcbiAgICAgICAgICAgIG5vZGVVdWlkLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliJvlu7rluKYgTGFiZWwg5paH5pys55qE6IqC54K577yI5LiA6ZSu5Yib5bu66IqC54K5K+a3u+WKoCBMYWJlbCDnu4Tku7Yr6K6+572u5paH5pysL+Wtl+WPty/popzoibLvvIknLCB7XG4gICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCN56ewJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcGFyZW50VXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfniLboioLngrkgVVVJRO+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgdGV4dDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlofmnKzlhoXlrrknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBmb250U2l6ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflrZflj7fvvIjpu5jorqQgNDDvvIknIH0sXG4gICAgICAgIGNvbG9yOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+minOiJsiBKU09O77yI5aaCIHtcInJcIjoyNTUsXCJnXCI6MjU1LFwiYlwiOjI1NSxcImFcIjoyNTV977yJJyB9LFxuICAgICAgICBwb3NpdGlvbjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfkvY3nva4gSlNPTicgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNyZWF0ZV9sYWJlbF9ub2RlKHBhcmFtczoge1xuICAgICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICAgIHBhcmVudFV1aWQ/OiBzdHJpbmc7XG4gICAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgICAgZm9udFNpemU/OiBzdHJpbmc7XG4gICAgICAgIGNvbG9yPzogc3RyaW5nO1xuICAgICAgICBwb3NpdGlvbj86IHN0cmluZztcbiAgICB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgLy8gMS4g5Yib5bu66IqC54K5XG4gICAgICAgIGNvbnN0IG5vZGVSZXN1bHQgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2NyZWF0ZU5vZGUnLCBbcGFyYW1zLm5hbWUsIHBhcmFtcy5wYXJlbnRVdWlkXSk7XG4gICAgICAgIGNvbnN0IG5vZGVVdWlkID0gbm9kZVJlc3VsdC5kYXRhPy51dWlkO1xuICAgICAgICBpZiAoIW5vZGVVdWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+WIm+W7uuiKgueCueWksei0pScpO1xuXG4gICAgICAgIC8vIDIuIOa3u+WKoCBMYWJlbCArIFVJVHJhbnNmb3JtIOe7hOS7tlxuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtub2RlVXVpZCwgJ2NjLkxhYmVsJ10pO1xuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtub2RlVXVpZCwgJ2NjLlVJVHJhbnNmb3JtJ10pO1xuXG4gICAgICAgIC8vIDMuIOiuvue9ruaWh+acrFxuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW1xuICAgICAgICAgICAgbm9kZVV1aWQsICdjYy5MYWJlbCcsICdzdHJpbmcnLCBwYXJhbXMudGV4dCxcbiAgICAgICAgXSk7XG5cbiAgICAgICAgLy8gNC4g6K6+572u5a2X5Y+3XG4gICAgICAgIGlmIChwYXJhbXMuZm9udFNpemUpIHtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbXG4gICAgICAgICAgICAgICAgbm9kZVV1aWQsICdjYy5MYWJlbCcsICdmb250U2l6ZScsIHBhcnNlSW50KHBhcmFtcy5mb250U2l6ZSwgMTApLFxuICAgICAgICAgICAgXSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyA1LiDorr7nva7popzoibJcbiAgICAgICAgaWYgKHBhcmFtcy5jb2xvcikge1xuICAgICAgICAgICAgY29uc3QgY29sb3IgPSBKU09OLnBhcnNlKHBhcmFtcy5jb2xvcik7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW1xuICAgICAgICAgICAgICAgIG5vZGVVdWlkLCAnY2MuTGFiZWwnLCAnY29sb3InLCBjb2xvcixcbiAgICAgICAgICAgIF0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gNi4g6K6+572u5L2N572uXG4gICAgICAgIGlmIChwYXJhbXMucG9zaXRpb24pIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IEpTT04ucGFyc2UocGFyYW1zLnBvc2l0aW9uKTtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW25vZGVVdWlkLCAncG9zaXRpb24nLCBwb3NdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBtZXNzYWdlOiBgTGFiZWwg6IqC54K5ICcke3BhcmFtcy5uYW1lfScg5bey5Yib5bu6YCxcbiAgICAgICAgICAgIG5vZGVVdWlkLFxuICAgICAgICAgICAgdGV4dDogcGFyYW1zLnRleHQsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIm+W7uuW4piBCdXR0b24g57uE5Lu255qE5oyJ6ZKu6IqC54K577yI5LiA6ZSu5Yib5bu65oyJ6ZKuK0xhYmVs5a2Q6IqC54K5K+e7keWumueCueWHu++8iScsIHtcbiAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnlkI3np7AnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwYXJlbnRVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+eItuiKgueCuSBVVUlE77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBsYWJlbFRleHQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5oyJ6ZKu5paH5pysJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgZm9udFNpemU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5a2X5Y+377yI6buY6K6kIDMw77yJJyB9LFxuICAgICAgICBwb3NpdGlvbjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfkvY3nva4gSlNPTicgfSxcbiAgICAgICAgc2l6ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsLrlr7ggSlNPTu+8iOm7mOiupCB7XCJ4XCI6MjAwLFwieVwiOjYwfe+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNyZWF0ZV9idXR0b25fbm9kZShwYXJhbXM6IHtcbiAgICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgICBwYXJlbnRVdWlkPzogc3RyaW5nO1xuICAgICAgICBsYWJlbFRleHQ6IHN0cmluZztcbiAgICAgICAgZm9udFNpemU/OiBzdHJpbmc7XG4gICAgICAgIHBvc2l0aW9uPzogc3RyaW5nO1xuICAgICAgICBzaXplPzogc3RyaW5nO1xuICAgIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICAvLyAxLiDliJvlu7rmjInpkq7oioLngrlcbiAgICAgICAgY29uc3Qgbm9kZVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlTm9kZScsIFtwYXJhbXMubmFtZSwgcGFyYW1zLnBhcmVudFV1aWRdKTtcbiAgICAgICAgY29uc3Qgbm9kZVV1aWQgPSBub2RlUmVzdWx0LmRhdGE/LnV1aWQ7XG4gICAgICAgIGlmICghbm9kZVV1aWQpIHRocm93IG5ldyBFcnJvcign5Yib5bu66IqC54K55aSx6LSlJyk7XG5cbiAgICAgICAgLy8gMi4g5re75YqgIEJ1dHRvbiArIFVJVHJhbnNmb3JtICsgU3ByaXRlIOe7hOS7tlxuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtub2RlVXVpZCwgJ2NjLkJ1dHRvbiddKTtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbm9kZVV1aWQsICdjYy5TcHJpdGUnXSk7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnYWRkQ29tcG9uZW50VG9Ob2RlJywgW25vZGVVdWlkLCAnY2MuVUlUcmFuc2Zvcm0nXSk7XG5cbiAgICAgICAgLy8gMy4g5Yib5bu6IExhYmVsIOWtkOiKgueCuVxuICAgICAgICBjb25zdCBsYWJlbFJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlTm9kZScsIFsnTGFiZWwnLCBub2RlVXVpZF0pO1xuICAgICAgICBjb25zdCBsYWJlbFV1aWQgPSBsYWJlbFJlc3VsdC5kYXRhPy51dWlkO1xuXG4gICAgICAgIGlmIChsYWJlbFV1aWQpIHtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnYWRkQ29tcG9uZW50VG9Ob2RlJywgW2xhYmVsVXVpZCwgJ2NjLkxhYmVsJ10pO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbGFiZWxVdWlkLCAnY2MuVUlUcmFuc2Zvcm0nXSk7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW1xuICAgICAgICAgICAgICAgIGxhYmVsVXVpZCwgJ2NjLkxhYmVsJywgJ3N0cmluZycsIHBhcmFtcy5sYWJlbFRleHQsXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChwYXJhbXMuZm9udFNpemUpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW1xuICAgICAgICAgICAgICAgICAgICBsYWJlbFV1aWQsICdjYy5MYWJlbCcsICdmb250U2l6ZScsIHBhcnNlSW50KHBhcmFtcy5mb250U2l6ZSwgMTApLFxuICAgICAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gNC4g6K6+572u5bC65a+4XG4gICAgICAgIGNvbnN0IHNpemUgPSBwYXJhbXMuc2l6ZSA/IEpTT04ucGFyc2UocGFyYW1zLnNpemUpIDogeyB4OiAyMDAsIHk6IDYwIH07XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbXG4gICAgICAgICAgICBub2RlVXVpZCwgJ2NjLlVJVHJhbnNmb3JtJywgJ2NvbnRlbnRTaXplJywgc2l6ZSxcbiAgICAgICAgXSk7XG5cbiAgICAgICAgLy8gNS4g6K6+572u5L2N572uXG4gICAgICAgIGlmIChwYXJhbXMucG9zaXRpb24pIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IEpTT04ucGFyc2UocGFyYW1zLnBvc2l0aW9uKTtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW25vZGVVdWlkLCAncG9zaXRpb24nLCBwb3NdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBtZXNzYWdlOiBg5oyJ6ZKuICcke3BhcmFtcy5uYW1lfScg5bey5Yib5bu6YCxcbiAgICAgICAgICAgIG5vZGVVdWlkLFxuICAgICAgICAgICAgbGFiZWxVdWlkLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOaJuemHj+aTjeS9nOe7hOWQiCA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+aJuemHj+mHjeWRveWQjeiKgueCue+8iOaMieaooeW8j+mHjeWRveWQjeaJgOacieWMuemFjeiKgueCue+8iScsIHtcbiAgICAgICAgcGF0dGVybjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflkI3np7DljLnphY3mqKHlvI/vvIjnsr7noa7ljLnphY3miJbliY3nvIDljLnphY3vvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBuZXdOYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWsOWQjeensO+8iOWPr+eUqCB7aW5kZXh9IOWNoOS9jee8luWPt++8jOWmgiBcIkJ1dHRvbl97aW5kZXh9XCLvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBleGFjdE1hdGNoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aYr+WQpueyvuehruWMuemFjeWQjeensO+8jOm7mOiupCBmYWxzZe+8iOWJjee8gOWMuemFje+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIGJhdGNoX3JlbmFtZShwYXJhbXM6IHtcbiAgICAgICAgcGF0dGVybjogc3RyaW5nO1xuICAgICAgICBuZXdOYW1lOiBzdHJpbmc7XG4gICAgICAgIGV4YWN0TWF0Y2g/OiBzdHJpbmc7XG4gICAgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGFsbE5vZGVzID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRBbGxOb2RlcycpO1xuICAgICAgICBjb25zdCBub2RlcyA9IGFsbE5vZGVzLmRhdGEgfHwgW107XG4gICAgICAgIGNvbnN0IGV4YWN0ID0gU3RyaW5nKHBhcmFtcy5leGFjdE1hdGNoID8/ICcnKSA9PT0gJ3RydWUnO1xuXG4gICAgICAgIGxldCByZW5hbWVkID0gMDtcbiAgICAgICAgY29uc3QgcmVzdWx0czogeyBvbGROYW1lOiBzdHJpbmc7IG5ld05hbWU6IHN0cmluZyB9W10gPSBbXTtcblxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBleGFjdCA/IG5vZGUubmFtZSA9PT0gcGFyYW1zLnBhdHRlcm4gOiBub2RlLm5hbWUuc3RhcnRzV2l0aChwYXJhbXMucGF0dGVybik7XG4gICAgICAgICAgICBpZiAobWF0Y2hlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IG5ld05hbWUgPSBwYXJhbXMubmV3TmFtZS5yZXBsYWNlKC9cXHtpbmRleFxcfS9nLCBTdHJpbmcocmVuYW1lZCArIDEpKTtcbiAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldE5vZGVQcm9wZXJ0eScsIFtub2RlLnV1aWQsICduYW1lJywgbmV3TmFtZV0pO1xuICAgICAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7IG9sZE5hbWU6IG5vZGUubmFtZSwgbmV3TmFtZSB9KTtcbiAgICAgICAgICAgICAgICByZW5hbWVkKys7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOW3sumHjeWRveWQjSAke3JlbmFtZWR9IOS4quiKgueCuWAsXG4gICAgICAgICAgICByZW5hbWVkLFxuICAgICAgICAgICAgcmVzdWx0cyxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l5om+5Yy56YWN6IqC54K55bm25om56YeP6K6+572u5bGe5oCnJywge1xuICAgICAgICBwYXR0ZXJuOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueWQjeensOWMuemFjeaooeW8jycsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHByb3BlcnR5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WQjScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHZhbHVlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WAvO+8iEpTT07vvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgZmluZF9hbmRfc2V0KHBhcmFtczoge1xuICAgICAgICBwYXR0ZXJuOiBzdHJpbmc7XG4gICAgICAgIHByb3BlcnR5OiBzdHJpbmc7XG4gICAgICAgIHZhbHVlOiBzdHJpbmc7XG4gICAgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGFsbE5vZGVzID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRBbGxOb2RlcycpO1xuICAgICAgICBjb25zdCBub2RlcyA9IGFsbE5vZGVzLmRhdGEgfHwgW107XG4gICAgICAgIGNvbnN0IHZhbHVlID0gSlNPTi5wYXJzZShwYXJhbXMudmFsdWUpO1xuXG4gICAgICAgIGxldCB1cGRhdGVkID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgICAgICAgICBpZiAobm9kZS5uYW1lLmluY2x1ZGVzKHBhcmFtcy5wYXR0ZXJuKSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW25vZGUudXVpZCwgcGFyYW1zLnByb3BlcnR5LCB2YWx1ZV0pO1xuICAgICAgICAgICAgICAgIHVwZGF0ZWQrKztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBtZXNzYWdlOiBg5bey5pu05pawICR7dXBkYXRlZH0g5Liq5Yy56YWN6IqC54K5YCxcbiAgICAgICAgICAgIHVwZGF0ZWQsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqIOWwhiBxdWVyeS1ub2RlLXRyZWUg6L+U5Zue55qE6IqC54K55qCR6YCS5b2S6KGl5YWF57uE5Lu25L+h5oGvICovXG4gICAgcHJpdmF0ZSBlbnJpY2hXaXRoQ29tcG9uZW50cyh0cmVlOiBhbnkpOiBhbnkge1xuICAgICAgICBjb25zdCBlbnJpY2ggPSAobm9kZTogYW55KTogYW55ID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHsgLi4ubm9kZSB9O1xuICAgICAgICAgICAgaWYgKG5vZGUuX19jb21wc19fKSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0LmNvbXBvbmVudHMgPSBub2RlLl9fY29tcHNfXy5tYXAoKGM6IGFueSkgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogYy5fX3R5cGVfXyB8fCAnVW5rbm93bicsXG4gICAgICAgICAgICAgICAgICAgIGVuYWJsZWQ6IGMuZW5hYmxlZCAhPT0gdW5kZWZpbmVkID8gYy5lbmFibGVkIDogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbikge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5jaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4ubWFwKChjOiBhbnkpID0+IGVucmljaChjKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gZW5yaWNoKHRyZWUpO1xuICAgIH1cbn1cbiJdfQ==