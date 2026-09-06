/**
 * 场景模块 — 场景生命周期 + 节点/组件操作
 *
 * 双通道架构：
 * 1. Editor.Message.request('scene', ...) — 编辑器级操作（打开/保存/关闭场景等）
 * 2. executeSceneScript(method, args) — 场景脚本操作（节点/组件 CRUD）
 */

import { MCPModule, MCPTool } from '../decorators';

/** 调用 Cocos 内置 scene 扩展消息 */
async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

/** 调用我们自己的场景脚本方法（contributions.scene） */
async function executeSceneScript(method: string, args: any[] = []): Promise<any> {
    try {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
        return result;
    } catch (e: any) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}

/** 安全调用 asset-db 扩展 */
async function callAssetDB(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    } catch (e: any) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}

// ==================== 场景 JSON 模板 ====================

function buildSceneJSON(sceneName: string): string {
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

@MCPModule('scene', '场景编辑 - 场景生命周期、节点树查询、节点/组件 CRUD、脚本执行')
export class SceneModule {

    // ==================== 场景生命周期 ====================

    @MCPTool('查询所有场景列表', {
        folder: { type: 'string', description: '搜索文件夹路径（可选，默认 db://assets）' },
    })
    async get_scene_list(params?: { folder?: string }): Promise<any> {
        const folder = params?.folder || 'db://assets';
        const pattern = folder.endsWith('/') ? `${folder}**/*.scene` : `${folder}/**/*.scene`;
        const results = await callAssetDB('query-assets', { pattern });
        const scenes = (results || []).map((a: any) => ({
            name: a.name,
            path: a.url,
            uuid: a.uuid,
        }));
        return { scenes };
    }

    @MCPTool('打开指定场景', {
        scenePath: { type: 'string', description: '场景路径（如 db://assets/scenes/Main.scene）', required: true },
    })
    async open_scene(params: { scenePath: string }): Promise<any> {
        const uuid = await callAssetDB('query-uuid', params.scenePath);
        if (!uuid) throw new Error(`未找到场景: ${params.scenePath}`);
        await callScene('open-scene', uuid);
        return { message: `已打开场景: ${params.scenePath}` };
    }

    @MCPTool('保存当前场景')
    async save_scene(): Promise<any> {
        await callScene('save-scene');
        return { message: '场景已保存' };
    }

    @MCPTool('另存当前场景', {
        path: { type: 'string', description: '目标保存路径' },
    })
    async save_scene_as(_params?: { path?: string }): Promise<any> {
        await callScene('save-as-scene');
        return { message: '已打开另存对话框' };
    }

    @MCPTool('关闭当前场景')
    async close_scene(): Promise<any> {
        await callScene('close-scene');
        return { message: '场景已关闭' };
    }

    @MCPTool('创建空白新场景', {
        sceneName: { type: 'string', description: '场景名称', required: true },
        savePath: { type: 'string', description: '保存路径（如 db://assets/scenes/NewScene.scene）', required: true },
    })
    async create_scene(params: { sceneName: string; savePath: string }): Promise<any> {
        const fullPath = params.savePath.endsWith('.scene') ? params.savePath : `${params.savePath}/${params.sceneName}.scene`;
        const content = buildSceneJSON(params.sceneName);
        const result = await callAssetDB('create-asset', fullPath, content);
        return {
            message: `场景 '${params.sceneName}' 已创建`,
            uuid: result?.uuid,
            url: result?.url,
        };
    }

    // ==================== 场景查询（原有工具，统一命名） ====================

    @MCPTool('查询当前打开的场景信息')
    async query_current_scene(): Promise<any> {
        return callScene('query-current-scene');
    }

    @MCPTool('查询场景节点树，返回当前打开场景的完整节点层级结构', {
        includeComponents: { type: 'string', description: '是否包含组件信息，默认 false' },
        uuid: { type: 'string', description: '节点 UUID（可选，默认根节点）' },
    })
    async query_node_tree(params?: { uuid?: string; includeComponents?: string }): Promise<any> {
        // 使用双通道：先尝试 Editor API，失败则用场景脚本
        try {
            const tree = await callScene('query-node-tree', params?.uuid);
            if (tree) {
                const includeComps = String(params?.includeComponents ?? '') === 'true';
                if (includeComps) {
                    return this.enrichWithComponents(tree);
                }
                return tree;
            }
            throw new Error('query-node-tree 返回空');
        } catch {
            const includeComps = String(params?.includeComponents ?? '') === 'true';
            return executeSceneScript('getSceneHierarchy', [includeComps]);
        }
    }

    @MCPTool('查询指定节点的详细信息（名称、UUID、组件列表、Transform 等）', {
        uuid: { type: 'string', description: '节点的 UUID', required: true },
    })
    async query_node(params: { uuid: string }): Promise<any> {
        // 先试 scene API，失败则用场景脚本
        try {
            const result = await callScene('query-node', params.uuid);
            if (result) return result;
            throw new Error('query-node 返回空');
        } catch {
            return executeSceneScript('getNodeInfo', [params.uuid]);
        }
    }

    @MCPTool('查询指定节点上某类型组件的属性和值', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label', required: true },
    })
    async query_component(params: { nodeUuid: string; componentType: string }): Promise<any> {
        return callScene('query-component', params.nodeUuid, params.componentType);
    }

    @MCPTool('获取当前场景的完整 JSON 序列化数据')
    async query_scene_json(): Promise<any> {
        return callScene('query-scene-json');
    }

    @MCPTool('查询场景中所有可用的组件类列表')
    async query_classes(): Promise<any> {
        return callScene('query-classes');
    }

    @MCPTool('查询指定节点上的所有组件列表', {
        uuid: { type: 'string', description: '节点的 UUID', required: true },
    })
    async query_components(params: { uuid: string }): Promise<any> {
        return callScene('query-components', params.uuid);
    }

    @MCPTool('查询场景编辑器是否就绪')
    async query_is_ready(): Promise<any> {
        return callScene('query-is-ready');
    }

    @MCPTool('查询当前场景是否有未保存的修改')
    async query_dirty(): Promise<any> {
        return callScene('query-dirty');
    }

    // ==================== 节点操作（通过场景脚本） ====================

    @MCPTool('获取场景中所有节点列表', {
        includeComponents: { type: 'string', description: '是否包含组件信息，默认 false' },
    })
    async get_all_nodes(params?: { includeComponents?: string }): Promise<any> {
        return executeSceneScript('getAllNodes');
    }

    @MCPTool('按名称查找节点（支持精确匹配）', {
        name: { type: 'string', description: '节点名称', required: true },
    })
    async find_node_by_name(params: { name: string }): Promise<any> {
        return executeSceneScript('findNodeByName', [params.name]);
    }

    @MCPTool('按组件类型查找节点', {
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label', required: true },
    })
    async find_nodes_by_component(params: { componentType: string }): Promise<any> {
        return executeSceneScript('findNodesByComponent', [params.componentType]);
    }

    @MCPTool('获取场景完整层级树（含组件信息可选）', {
        includeComponents: { type: 'string', description: '是否包含组件信息，传 "true" 即包含' },
    })
    async get_scene_hierarchy(params?: { includeComponents?: string }): Promise<any> {
        const includeComps = String(params?.includeComponents ?? '') === 'true';
        return executeSceneScript('getSceneHierarchy', [includeComps]);
    }

    @MCPTool('在场景中创建新节点（通过场景脚本，支持指定父节点）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选，默认场景根节点）' },
    })
    async create_node(params: { name: string; parentUuid?: string }): Promise<any> {
        return executeSceneScript('createNode', [params.name, params.parentUuid]);
    }

    @MCPTool('删除指定节点', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async delete_node(params: { uuid: string }): Promise<any> {
        return executeSceneScript('deleteNode', [params.uuid]);
    }

    @MCPTool('复制节点（深拷贝）', {
        uuid: { type: 'string', description: '源节点 UUID', required: true },
    })
    async duplicate_node(params: { uuid: string }): Promise<any> {
        return executeSceneScript('duplicateNode', [params.uuid]);
    }

    @MCPTool('移动节点到新父节点下', {
        uuid: { type: 'string', description: '要移动的节点 UUID', required: true },
        newParentUuid: { type: 'string', description: '新父节点 UUID', required: true },
    })
    async move_node(params: { uuid: string; newParentUuid: string }): Promise<any> {
        return executeSceneScript('moveNode', [params.uuid, params.newParentUuid]);
    }

    @MCPTool('设置节点属性（position/rotation/scale/active/name/layer/mobility）', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        property: { type: 'string', description: '属性名', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
    async set_node_property(params: { uuid: string; property: string; value: string }): Promise<any> {
        const value = JSON.parse(params.value);
        return executeSceneScript('setNodeProperty', [params.uuid, params.property, value]);
    }

    @MCPTool('设置节点 Transform（position/rotation/scale 统一接口）', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        position: { type: 'string', description: '位置 JSON 如 {"x":100,"y":200,"z":0}' },
        rotation: { type: 'string', description: '旋转 JSON 如 {"x":0,"y":0,"z":45}' },
        scale: { type: 'string', description: '缩放 JSON 如 {"x":1,"y":1,"z":1}' },
    })
    async set_node_transform(params: { uuid: string; position?: string; rotation?: string; scale?: string }): Promise<any> {
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

    @MCPTool('为节点添加组件', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名，如 cc.Sprite, cc.Label, cc.Button', required: true },
    })
    async add_component(params: { nodeUuid: string; componentType: string }): Promise<any> {
        return executeSceneScript('addComponentToNode', [params.nodeUuid, params.componentType]);
    }

    @MCPTool('移除节点上的组件', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名', required: true },
    })
    async remove_component(params: { nodeUuid: string; componentType: string }): Promise<any> {
        return executeSceneScript('removeComponentFromNode', [params.nodeUuid, params.componentType]);
    }

    @MCPTool('设置组件属性（支持 Sprite/Label/Button 等常见组件特殊处理）', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        componentType: { type: 'string', description: '组件类型名', required: true },
        property: { type: 'string', description: '属性名（如 string, spriteFrame, color, fontSize）', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
    async set_component_property(params: { nodeUuid: string; componentType: string; property: string; value: string }): Promise<any> {
        const value = JSON.parse(params.value);
        return executeSceneScript('setComponentProperty', [params.nodeUuid, params.componentType, params.property, value]);
    }

    // ==================== 场景脚本执行 ====================

    @MCPTool('在场景中执行脚本方法（如组件上的方法）', {
        uuid: { type: 'string', description: '目标节点或组件的 UUID' },
        method: { type: 'string', description: '要执行的方法名' },
        args: { type: 'string', description: '方法参数（JSON 数组字符串）' },
    })
    async execute_scene_script(params: { uuid: string; method: string; args?: string }): Promise<any> {
        const methodArgs = params.args ? JSON.parse(params.args) : [];
        return callScene('execute-scene-script', params.uuid, params.method, ...methodArgs);
    }

    @MCPTool('软重载当前场景（保留状态）')
    async soft_reload(): Promise<any> {
        return callScene('soft-reload');
    }

    // ==================== 编辑器操作（undo/redo/copy/paste/cut） ====================

    @MCPTool('撤销上一步编辑操作')
    async undo(): Promise<any> {
        await callScene('undo');
        return { message: '已撤销' };
    }

    @MCPTool('重做已撤销的操作')
    async redo(): Promise<any> {
        await callScene('redo');
        return { message: '已重做' };
    }

    @MCPTool('复制节点到剪贴板', {
        uuids: { type: 'string', description: '节点 UUID（单个或 JSON 数组字符串）', required: true },
    })
    async copy_node(params: { uuids: string }): Promise<any> {
        let uuids: string[];
        try {
            uuids = JSON.parse(params.uuids);
        } catch {
            uuids = [params.uuids];
        }
        await callScene('copy-node', uuids);
        return { message: `已复制 ${uuids.length} 个节点` };
    }

    @MCPTool('粘贴剪贴板中的节点', {
        target: { type: 'string', description: '目标父节点 UUID', required: true },
    })
    async paste_node(params: { target: string }): Promise<any> {
        await callScene('paste-node', params.target);
        return { message: '节点已粘贴' };
    }

    @MCPTool('剪切节点（复制+删除）', {
        uuids: { type: 'string', description: '节点 UUID（单个或 JSON 数组字符串）', required: true },
    })
    async cut_node(params: { uuids: string }): Promise<any> {
        let uuids: string[];
        try {
            uuids = JSON.parse(params.uuids);
        } catch {
            uuids = [params.uuids];
        }
        await callScene('cut-node', uuids);
        return { message: `已剪切 ${uuids.length} 个节点` };
    }

    @MCPTool('重置节点属性为默认值', {
        uuid: { type: 'string', description: '节点 UUID', required: true },
        path: { type: 'string', description: '属性路径（position/rotation/scale/_lpos 等）', required: true },
    })
    async reset_node_property(params: { uuid: string; path: string }): Promise<any> {
        await callScene('reset-node-property', params.uuid, params.path);
        return { message: `已重置属性: ${params.path}` };
    }

    // ==================== 组合工具（多步编排） ====================

    @MCPTool('一键创建标准 2D 场景（Canvas + Camera + 背景节点）。适用于快速初始化 UI 场景', {
        sceneName: { type: 'string', description: '场景名称', required: true },
        savePath: { type: 'string', description: '保存路径（如 db://assets/scenes/UIScene.scene）', required: true },
        resolutionWidth: { type: 'string', description: '设计分辨率宽（默认 1920）' },
        resolutionHeight: { type: 'string', description: '设计分辨率高（默认 1080）' },
    })
    async create_default_2d_scene(params: {
        sceneName: string;
        savePath: string;
        resolutionWidth?: string;
        resolutionHeight?: string;
    }): Promise<any> {
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
        const canvasUuid = canvasResult.data?.uuid;

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
        const cameraUuid = cameraResult.data?.uuid;

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

    @MCPTool('创建带背景 Sprite 的节点（一键创建节点+添加 Sprite 组件+设置贴图）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        spriteFrameUuid: { type: 'string', description: 'SpriteFrame 资源的 UUID' },
        position: { type: 'string', description: '位置 JSON' },
        size: { type: 'string', description: '尺寸 JSON（如 {"x":100,"y":100}）' },
    })
    async create_sprite_node(params: {
        name: string;
        parentUuid?: string;
        spriteFrameUuid?: string;
        position?: string;
        size?: string;
    }): Promise<any> {
        // 1. 创建节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = nodeResult.data?.uuid;
        if (!nodeUuid) throw new Error('创建节点失败');

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

    @MCPTool('创建带 Label 文本的节点（一键创建节点+添加 Label 组件+设置文本/字号/颜色）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        text: { type: 'string', description: '文本内容', required: true },
        fontSize: { type: 'string', description: '字号（默认 40）' },
        color: { type: 'string', description: '颜色 JSON（如 {"r":255,"g":255,"b":255,"a":255}）' },
        position: { type: 'string', description: '位置 JSON' },
    })
    async create_label_node(params: {
        name: string;
        parentUuid?: string;
        text: string;
        fontSize?: string;
        color?: string;
        position?: string;
    }): Promise<any> {
        // 1. 创建节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = nodeResult.data?.uuid;
        if (!nodeUuid) throw new Error('创建节点失败');

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

    @MCPTool('创建带 Button 组件的按钮节点（一键创建按钮+Label子节点+绑定点击）', {
        name: { type: 'string', description: '节点名称', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        labelText: { type: 'string', description: '按钮文本', required: true },
        fontSize: { type: 'string', description: '字号（默认 30）' },
        position: { type: 'string', description: '位置 JSON' },
        size: { type: 'string', description: '尺寸 JSON（默认 {"x":200,"y":60}）' },
    })
    async create_button_node(params: {
        name: string;
        parentUuid?: string;
        labelText: string;
        fontSize?: string;
        position?: string;
        size?: string;
    }): Promise<any> {
        // 1. 创建按钮节点
        const nodeResult = await executeSceneScript('createNode', [params.name, params.parentUuid]);
        const nodeUuid = nodeResult.data?.uuid;
        if (!nodeUuid) throw new Error('创建节点失败');

        // 2. 添加 Button + UITransform + Sprite 组件
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Button']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.Sprite']);
        await executeSceneScript('addComponentToNode', [nodeUuid, 'cc.UITransform']);

        // 3. 创建 Label 子节点
        const labelResult = await executeSceneScript('createNode', ['Label', nodeUuid]);
        const labelUuid = labelResult.data?.uuid;

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

    @MCPTool('批量重命名节点（按模式重命名所有匹配节点）', {
        pattern: { type: 'string', description: '名称匹配模式（精确匹配或前缀匹配）', required: true },
        newName: { type: 'string', description: '新名称（可用 {index} 占位编号，如 "Button_{index}"）', required: true },
        exactMatch: { type: 'string', description: '是否精确匹配名称，默认 false（前缀匹配）' },
    })
    async batch_rename(params: {
        pattern: string;
        newName: string;
        exactMatch?: string;
    }): Promise<any> {
        const allNodes = await executeSceneScript('getAllNodes');
        const nodes = allNodes.data || [];
        const exact = String(params.exactMatch ?? '') === 'true';

        let renamed = 0;
        const results: { oldName: string; newName: string }[] = [];

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

    @MCPTool('查找匹配节点并批量设置属性', {
        pattern: { type: 'string', description: '节点名称匹配模式', required: true },
        property: { type: 'string', description: '属性名', required: true },
        value: { type: 'string', description: '属性值（JSON）', required: true },
    })
    async find_and_set(params: {
        pattern: string;
        property: string;
        value: string;
    }): Promise<any> {
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
    private enrichWithComponents(tree: any): any {
        const enrich = (node: any): any => {
            const result = { ...node };
            if (node.__comps__) {
                result.components = node.__comps__.map((c: any) => ({
                    type: c.__type__ || 'Unknown',
                    enabled: c.enabled !== undefined ? c.enabled : true,
                }));
            }
            if (node.children) {
                result.children = node.children.map((c: any) => enrich(c));
            }
            return result;
        };
        return enrich(tree);
    }
}
