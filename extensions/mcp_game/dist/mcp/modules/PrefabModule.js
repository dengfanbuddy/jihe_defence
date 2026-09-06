"use strict";
/**
 * 预制件模块 — 预制件全生命周期管理
 *
 * 依赖：
 * - asset-db 扩展：资产 CRUD
 * - scene 扩展：create-node（实例化）
 * - 场景脚本（contributions.scene）：createPrefabFromNode（节点数据收集）
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrefabModule = void 0;
const decorators_1 = require("../decorators");
/** 安全调用 Editor.Message.request */
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
async function callAssetDB(method, ...args) {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    }
    catch (e) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}
async function executeSceneScript(method, args = []) {
    try {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
    }
    catch (e) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}
/** 将场景节点数据转换为 .prefab 文件格式 */
function buildPrefabJSON(nodeData, prefabName) {
    const nodes = [];
    const fileIdMap = new Map();
    let nextFileId = 1;
    // 递归收集节点
    function collectNode(n, parentFileId) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1;
        const fileId = nextFileId++;
        fileIdMap.set(n, fileId);
        const nodeEntry = {
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
                "x": (_b = (_a = n.position) === null || _a === void 0 ? void 0 : _a.x) !== null && _b !== void 0 ? _b : 0,
                "y": (_d = (_c = n.position) === null || _c === void 0 ? void 0 : _c.y) !== null && _d !== void 0 ? _d : 0,
                "z": (_f = (_e = n.position) === null || _e === void 0 ? void 0 : _e.z) !== null && _f !== void 0 ? _f : 0,
            },
            "_lrot": {
                "__type__": "cc.Quat",
                "x": (_h = (_g = n.rotation) === null || _g === void 0 ? void 0 : _g.x) !== null && _h !== void 0 ? _h : 0,
                "y": (_k = (_j = n.rotation) === null || _j === void 0 ? void 0 : _j.y) !== null && _k !== void 0 ? _k : 0,
                "z": (_m = (_l = n.rotation) === null || _l === void 0 ? void 0 : _l.z) !== null && _m !== void 0 ? _m : 0,
                "w": 1,
            },
            "_lscale": {
                "__type__": "cc.Vec3",
                "x": (_p = (_o = n.scale) === null || _o === void 0 ? void 0 : _o.x) !== null && _p !== void 0 ? _p : 1,
                "y": (_r = (_q = n.scale) === null || _q === void 0 ? void 0 : _q.y) !== null && _r !== void 0 ? _r : 1,
                "z": (_t = (_s = n.scale) === null || _s === void 0 ? void 0 : _s.z) !== null && _t !== void 0 ? _t : 1,
            },
            "_mobility": (_u = n.mobility) !== null && _u !== void 0 ? _u : 0,
            "_layer": (_v = n.layer) !== null && _v !== void 0 ? _v : 1073741824,
            "_euler": {
                "__type__": "cc.Vec3",
                "x": (_x = (_w = n.rotation) === null || _w === void 0 ? void 0 : _w.x) !== null && _x !== void 0 ? _x : 0,
                "y": (_z = (_y = n.rotation) === null || _y === void 0 ? void 0 : _y.y) !== null && _z !== void 0 ? _z : 0,
                "z": (_1 = (_0 = n.rotation) === null || _0 === void 0 ? void 0 : _0.z) !== null && _1 !== void 0 ? _1 : 0,
            },
            "_id": "",
        };
        // 组件
        if (n.components) {
            n.components.forEach((comp, ci) => {
                const compEntry = {
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
            n.children.forEach((child) => {
                const childFileId = collectNode(child, fileId);
                nodeEntry._children.push({ "__id__": childFileId });
            });
        }
        nodes.push(nodeEntry);
        return fileId;
    }
    collectNode(nodeData, null);
    // 设置根节点的 PrefabInfo
    const rootNode = nodes.find((n) => n.__type__ === 'cc.Node' && n._parent === null);
    if (rootNode && rootNode._prefab) {
        rootNode._prefab.root = { "__id__": 1 };
    }
    // 构建顶层结构
    const prefabData = [
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
let PrefabModule = class PrefabModule {
    // ==================== 查询 ====================
    async get_prefab_list(params) {
        const folder = (params === null || params === void 0 ? void 0 : params.folder) || 'db://assets';
        const pattern = folder.endsWith('/') ? `${folder}**/*.prefab` : `${folder}/**/*.prefab`;
        const results = await callAssetDB('query-assets', { pattern });
        const prefabs = (results || []).map((a) => ({
            name: a.name,
            path: a.url,
            uuid: a.uuid,
            folder: a.url ? a.url.substring(0, a.url.lastIndexOf('/')) : folder,
        }));
        return { prefabs };
    }
    async get_prefab_info(params) {
        const info = await callAssetDB('query-asset-info', params.prefabPath);
        if (!info)
            throw new Error(`未找到预制件: ${params.prefabPath}`);
        return info;
    }
    // ==================== 实例化 ====================
    async instantiate_prefab(params) {
        // 获取预制件资产信息
        const assetInfo = await callAssetDB('query-asset-info', params.prefabPath);
        if (!assetInfo)
            throw new Error(`未找到预制件: ${params.prefabPath}`);
        // 构建 create-node 参数
        const createOpts = {
            assetUuid: assetInfo.uuid,
        };
        if (params.parentUuid) {
            createOpts.parent = params.parentUuid;
        }
        if (params.name) {
            createOpts.name = params.name;
        }
        else if (assetInfo.name) {
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
    async create_prefab(params) {
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
            uuid: result === null || result === void 0 ? void 0 : result.uuid,
            url: result === null || result === void 0 ? void 0 : result.url,
            sourceNode: params.nodeUuid,
        };
    }
    // ==================== 复制 ====================
    async duplicate_prefab(params) {
        // 获取源预制件 UUID
        const srcUuid = await callAssetDB('query-uuid', params.sourcePrefabPath);
        if (!srcUuid)
            throw new Error(`未找到源预制件: ${params.sourcePrefabPath}`);
        const result = await callAssetDB('copy-asset', srcUuid, params.targetPrefabPath);
        return {
            message: `预制件已复制到 ${params.targetPrefabPath}`,
            uuid: result === null || result === void 0 ? void 0 : result.uuid,
            url: result === null || result === void 0 ? void 0 : result.url,
        };
    }
    // ==================== 批量实例化 ====================
    async batch_instantiate(params) {
        const count = JSON.parse(params.count);
        const spacing = params.spacing ? JSON.parse(params.spacing) : { x: 100, y: 100 };
        const cols = count.x || 1;
        const rows = count.y || 1;
        const total = cols * rows;
        if (total > 100)
            throw new Error('单次批量实例化上限为 100');
        const assetInfo = await callAssetDB('query-asset-info', params.prefabPath);
        if (!assetInfo)
            throw new Error(`未找到预制件: ${params.prefabPath}`);
        const uuids = [];
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
};
exports.PrefabModule = PrefabModule;
__decorate([
    (0, decorators_1.MCPTool)('查询项目中的所有预制件列表', {
        folder: { type: 'string', description: '搜索文件夹路径（可选，默认 db://assets）' },
    })
], PrefabModule.prototype, "get_prefab_list", null);
__decorate([
    (0, decorators_1.MCPTool)('查询预制件详细信息', {
        prefabPath: { type: 'string', description: '预制件资产路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
    })
], PrefabModule.prototype, "get_prefab_info", null);
__decorate([
    (0, decorators_1.MCPTool)('将预制件实例化到场景中', {
        prefabPath: { type: 'string', description: '预制件路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID（可选）' },
        position: { type: 'string', description: '初始位置 JSON（可选，如 {"x":100,"y":200,"z":0}）' },
        name: { type: 'string', description: '实例节点名称（可选，默认使用预制件名）' },
    })
], PrefabModule.prototype, "instantiate_prefab", null);
__decorate([
    (0, decorators_1.MCPTool)('将场景节点保存为预制件（含完整子树和组件）', {
        nodeUuid: { type: 'string', description: '源节点 UUID', required: true },
        savePath: { type: 'string', description: '预制件保存路径（如 db://assets/prefabs/MyPrefab.prefab）', required: true },
        prefabName: { type: 'string', description: '预制件名称', required: true },
    })
], PrefabModule.prototype, "create_prefab", null);
__decorate([
    (0, decorators_1.MCPTool)('复制（克隆）预制件', {
        sourcePrefabPath: { type: 'string', description: '源预制件路径', required: true },
        targetPrefabPath: { type: 'string', description: '目标预制件路径（如 db://assets/prefabs/MyPrefab_Copy.prefab）', required: true },
        newPrefabName: { type: 'string', description: '新预制件名称（可选）' },
    })
], PrefabModule.prototype, "duplicate_prefab", null);
__decorate([
    (0, decorators_1.MCPTool)('批量实例化预制件（网格排列）', {
        prefabPath: { type: 'string', description: '预制件路径', required: true },
        parentUuid: { type: 'string', description: '父节点 UUID' },
        count: { type: 'string', description: '数量（JSON 如 {"x":3,"y":2} 表示 3 列 2 行）', required: true },
        spacing: { type: 'string', description: '间距 JSON（如 {"x":100,"y":100}）' },
    })
], PrefabModule.prototype, "batch_instantiate", null);
exports.PrefabModule = PrefabModule = __decorate([
    (0, decorators_1.MCPModule)('prefab', '预制件管理 - 创建/实例化/复制/查询预制件')
], PrefabModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHJlZmFiTW9kdWxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc291cmNlL21jcC9tb2R1bGVzL1ByZWZhYk1vZHVsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7R0FPRzs7Ozs7Ozs7O0FBRUgsOENBQW1EO0FBRW5ELGtDQUFrQztBQUNsQyxLQUFLLFVBQVUsU0FBUyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ3JELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDckUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUVELEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxNQUFjLEVBQUUsT0FBYyxFQUFFO0lBQzlELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUU7WUFDakUsSUFBSSxFQUFFLFVB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QU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLDhCQUE4QixFQUFFO0tBQzNFLENBQUM7cURBc0NEO3VCQTNMUSxZQUFZO0lBRHhCLElBQUEsc0JBQVMsRUFBQyxRQUFRLEVBQUUseUJBQXlCLENBQUM7R0FDbEMsWUFBWSxDQTRMeEIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOmihOWItuS7tuaooeWdlyDigJQg6aKE5Yi25Lu25YWo55Sf5ZG95ZGo5pyf566h55CGXG4gKlxuICog5L6d6LWW77yaXG4gKiAtIGFzc2V0LWRiIOaJqeWxle+8mui1hOS6pyBDUlVEXG4gKiAtIHNjZW5lIOaJqeWxle+8mmNyZWF0ZS1ub2Rl77yI5a6e5L6L5YyW77yJXG4gKiAtIOWcuuaZr+iEmuacrO+8iGNvbnRyaWJ1dGlvbnMuc2NlbmXvvInvvJpjcmVhdGVQcmVmYWJGcm9tTm9kZe+8iOiKgueCueaVsOaNruaUtumbhu+8iVxuICovXG5cbmltcG9ydCB7IE1DUE1vZHVsZSwgTUNQVG9vbCB9IGZyb20gJy4uL2RlY29yYXRvcnMnO1xuXG4vKiog5a6J5YWo6LCD55SoIEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTY2VuZShtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxBc3NldERCKG1ldGhvZDogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgbWV0aG9kLCAuLi5hcmdzKTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotYTkuqfmtojmga8gJyR7bWV0aG9kfScg5aSx6LSlOiAke2UubWVzc2FnZSB8fCBlfWApO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNjZW5lU2NyaXB0KG1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSA9IFtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiAnbWNwX2dhbWUnLFxuICAgICAgICAgICAgbWV0aG9kLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv6ISa5pysICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbi8qKiDlsIblnLrmma/oioLngrnmlbDmja7ovazmjaLkuLogLnByZWZhYiDmlofku7bmoLzlvI8gKi9cbmZ1bmN0aW9uIGJ1aWxkUHJlZmFiSlNPTihub2RlRGF0YTogYW55LCBwcmVmYWJOYW1lOiBzdHJpbmcpOiBhbnkge1xuICAgIGNvbnN0IG5vZGVzOiBhbnlbXSA9IFtdO1xuICAgIGNvbnN0IGZpbGVJZE1hcCA9IG5ldyBNYXA8YW55LCBudW1iZXI+KCk7XG4gICAgbGV0IG5leHRGaWxlSWQgPSAxO1xuXG4gICAgLy8g6YCS5b2S5pS26ZuG6IqC54K5XG4gICAgZnVuY3Rpb24gY29sbGVjdE5vZGUobjogYW55LCBwYXJlbnRGaWxlSWQ6IG51bWJlciB8IG51bGwpOiBudW1iZXIge1xuICAgICAgICBjb25zdCBmaWxlSWQgPSBuZXh0RmlsZUlkKys7XG4gICAgICAgIGZpbGVJZE1hcC5zZXQobiwgZmlsZUlkKTtcblxuICAgICAgICBjb25zdCBub2RlRW50cnk6IGFueSA9IHtcbiAgICAgICAgICAgIFwiX190eXBlX19cIjogXCJjYy5Ob2RlXCIsXG4gICAgICAgICAgICBcIl9uYW1lXCI6IG4ubmFtZSxcbiAgICAgICAgICAgIFwiX29iakZsYWdzXCI6IDAsXG4gICAgICAgICAgICBcIl9fZWRpdG9yRXh0cmFzX19cIjoge30sXG4gICAgICAgICAgICBcIl9wYXJlbnRcIjogcGFyZW50RmlsZUlkICE9PSBudWxsID8geyBcIl9faWRfX1wiOiBwYXJlbnRGaWxlSWQgfSA6IG51bGwsXG4gICAgICAgICAgICBcIl9jaGlsZHJlblwiOiBbXSxcbiAgICAgICAgICAgIFwiX2FjdGl2ZVwiOiBuLmFjdGl2ZSAhPT0gdW5kZWZpbmVkID8gbi5hY3RpdmUgOiB0cnVlLFxuICAgICAgICAgICAgXCJfY29tcG9uZW50c1wiOiBbXSxcbiAgICAgICAgICAgIFwiX3ByZWZhYlwiOiB7XG4gICAgICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLlByZWZhYkluZm9cIixcbiAgICAgICAgICAgICAgICBcInJvb3RcIjogbnVsbCxcbiAgICAgICAgICAgICAgICBcImFzc2V0XCI6IG51bGwsXG4gICAgICAgICAgICAgICAgXCJmaWxlSWRcIjogU3RyaW5nKGZpbGVJZCksXG4gICAgICAgICAgICAgICAgXCJpbnN0YW5jZVwiOiBudWxsLFxuICAgICAgICAgICAgICAgIFwidGFyZ2V0T3ZlcnJpZGVzXCI6IG51bGwsXG4gICAgICAgICAgICAgICAgXCJuZXN0ZWRQcmVmYWJJbnN0YW5jZVJvb3RzXCI6IG51bGwsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgXCJfbHBvc1wiOiB7XG4gICAgICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLlZlYzNcIixcbiAgICAgICAgICAgICAgICBcInhcIjogbi5wb3NpdGlvbj8ueCA/PyAwLFxuICAgICAgICAgICAgICAgIFwieVwiOiBuLnBvc2l0aW9uPy55ID8/IDAsXG4gICAgICAgICAgICAgICAgXCJ6XCI6IG4ucG9zaXRpb24/LnogPz8gMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcIl9scm90XCI6IHtcbiAgICAgICAgICAgICAgICBcIl9fdHlwZV9fXCI6IFwiY2MuUXVhdFwiLFxuICAgICAgICAgICAgICAgIFwieFwiOiBuLnJvdGF0aW9uPy54ID8/IDAsXG4gICAgICAgICAgICAgICAgXCJ5XCI6IG4ucm90YXRpb24/LnkgPz8gMCxcbiAgICAgICAgICAgICAgICBcInpcIjogbi5yb3RhdGlvbj8ueiA/PyAwLFxuICAgICAgICAgICAgICAgIFwid1wiOiAxLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIFwiX2xzY2FsZVwiOiB7XG4gICAgICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLlZlYzNcIixcbiAgICAgICAgICAgICAgICBcInhcIjogbi5zY2FsZT8ueCA/PyAxLFxuICAgICAgICAgICAgICAgIFwieVwiOiBuLnNjYWxlPy55ID8/IDEsXG4gICAgICAgICAgICAgICAgXCJ6XCI6IG4uc2NhbGU/LnogPz8gMSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcIl9tb2JpbGl0eVwiOiBuLm1vYmlsaXR5ID8/IDAsXG4gICAgICAgICAgICBcIl9sYXllclwiOiBuLmxheWVyID8/IDEwNzM3NDE4MjQsXG4gICAgICAgICAgICBcIl9ldWxlclwiOiB7XG4gICAgICAgICAgICAgICAgXCJfX3R5cGVfX1wiOiBcImNjLlZlYzNcIixcbiAgICAgICAgICAgICAgICBcInhcIjogbi5yb3RhdGlvbj8ueCA/PyAwLFxuICAgICAgICAgICAgICAgIFwieVwiOiBuLnJvdGF0aW9uPy55ID8/IDAsXG4gICAgICAgICAgICAgICAgXCJ6XCI6IG4ucm90YXRpb24/LnogPz8gMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcIl9pZFwiOiBcIlwiLFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIOe7hOS7tlxuICAgICAgICBpZiAobi5jb21wb25lbnRzKSB7XG4gICAgICAgICAgICBuLmNvbXBvbmVudHMuZm9yRWFjaCgoY29tcDogYW55LCBjaTogbnVtYmVyKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgY29tcEVudHJ5OiBhbnkgPSB7XG4gICAgICAgICAgICAgICAgICAgIFwiX190eXBlX19cIjogY29tcC50eXBlLFxuICAgICAgICAgICAgICAgICAgICBcIl9uYW1lXCI6IFwiXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiX29iakZsYWdzXCI6IDAsXG4gICAgICAgICAgICAgICAgICAgIFwiX19lZGl0b3JFeHRyYXNfX1wiOiB7fSxcbiAgICAgICAgICAgICAgICAgICAgXCJub2RlXCI6IHsgXCJfX2lkX19cIjogZmlsZUlkIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiX2VuYWJsZWRcIjogY29tcC5lbmFibGVkICE9PSB1bmRlZmluZWQgPyBjb21wLmVuYWJsZWQgOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBcIl9fcHJlZmFiXCI6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIFwiX2lkXCI6IGAke3ByZWZhYk5hbWV9X2NvbXBfJHtmaWxlSWR9XyR7Y2l9YCxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbXBGaWxlSWQgPSBuZXh0RmlsZUlkKys7XG4gICAgICAgICAgICAgICAgbm9kZXMucHVzaChjb21wRW50cnkpO1xuICAgICAgICAgICAgICAgIG5vZGVFbnRyeS5fY29tcG9uZW50cy5wdXNoKHsgXCJfX2lkX19cIjogY29tcEZpbGVJZCB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5a2Q6IqC54K5XG4gICAgICAgIGlmIChuLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBuLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkOiBhbnkpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBjaGlsZEZpbGVJZCA9IGNvbGxlY3ROb2RlKGNoaWxkLCBmaWxlSWQpO1xuICAgICAgICAgICAgICAgIG5vZGVFbnRyeS5fY2hpbGRyZW4ucHVzaCh7IFwiX19pZF9fXCI6IGNoaWxkRmlsZUlkIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBub2Rlcy5wdXNoKG5vZGVFbnRyeSk7XG4gICAgICAgIHJldHVybiBmaWxlSWQ7XG4gICAgfVxuXG4gICAgY29sbGVjdE5vZGUobm9kZURhdGEsIG51bGwpO1xuXG4gICAgLy8g6K6+572u5qC56IqC54K555qEIFByZWZhYkluZm9cbiAgICBjb25zdCByb290Tm9kZSA9IG5vZGVzLmZpbmQoKG46IGFueSkgPT4gbi5fX3R5cGVfXyA9PT0gJ2NjLk5vZGUnICYmIG4uX3BhcmVudCA9PT0gbnVsbCk7XG4gICAgaWYgKHJvb3ROb2RlICYmIHJvb3ROb2RlLl9wcmVmYWIpIHtcbiAgICAgICAgcm9vdE5vZGUuX3ByZWZhYi5yb290ID0geyBcIl9faWRfX1wiOiAxIH07XG4gICAgfVxuXG4gICAgLy8g5p6E5bu66aG25bGC57uT5p6EXG4gICAgY29uc3QgcHJlZmFiRGF0YTogYW55W10gPSBbXG4gICAgICAgIHtcbiAgICAgICAgICAgIFwiX190eXBlX19cIjogXCJjYy5QcmVmYWJcIixcbiAgICAgICAgICAgIFwiX25hbWVcIjogcHJlZmFiTmFtZSxcbiAgICAgICAgICAgIFwiX29iakZsYWdzXCI6IDAsXG4gICAgICAgICAgICBcIl9fZWRpdG9yRXh0cmFzX19cIjoge30sXG4gICAgICAgICAgICBcIl9uYXRpdmVcIjogXCJcIixcbiAgICAgICAgICAgIFwiZGF0YVwiOiBudWxsLFxuICAgICAgICAgICAgXCJvcHRpbWl6YXRpb25Qb2xpY3lcIjogMCxcbiAgICAgICAgICAgIFwicGVyc2lzdGVudFwiOiBmYWxzZSxcbiAgICAgICAgfSxcbiAgICAgICAgLi4ubm9kZXMsXG4gICAgXTtcblxuICAgIHJldHVybiBwcmVmYWJEYXRhO1xufVxuXG5ATUNQTW9kdWxlKCdwcmVmYWInLCAn6aKE5Yi25Lu2566h55CGIC0g5Yib5bu6L+WunuS+i+WMli/lpI3liLYv5p+l6K+i6aKE5Yi25Lu2JylcbmV4cG9ydCBjbGFzcyBQcmVmYWJNb2R1bGUge1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5p+l6K+iID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6aG555uu5Lit55qE5omA5pyJ6aKE5Yi25Lu25YiX6KGoJywge1xuICAgICAgICBmb2xkZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pCc57Si5paH5Lu25aS56Lev5b6E77yI5Y+v6YCJ77yM6buY6K6kIGRiOi8vYXNzZXRz77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgZ2V0X3ByZWZhYl9saXN0KHBhcmFtcz86IHsgZm9sZGVyPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCBmb2xkZXIgPSBwYXJhbXM/LmZvbGRlciB8fCAnZGI6Ly9hc3NldHMnO1xuICAgICAgICBjb25zdCBwYXR0ZXJuID0gZm9sZGVyLmVuZHNXaXRoKCcvJykgPyBgJHtmb2xkZXJ9KiovKi5wcmVmYWJgIDogYCR7Zm9sZGVyfS8qKi8qLnByZWZhYmA7XG4gICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjYWxsQXNzZXREQigncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuIH0pO1xuICAgICAgICBjb25zdCBwcmVmYWJzID0gKHJlc3VsdHMgfHwgW10pLm1hcCgoYTogYW55KSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogYS5uYW1lLFxuICAgICAgICAgICAgcGF0aDogYS51cmwsXG4gICAgICAgICAgICB1dWlkOiBhLnV1aWQsXG4gICAgICAgICAgICBmb2xkZXI6IGEudXJsID8gYS51cmwuc3Vic3RyaW5nKDAsIGEudXJsLmxhc3RJbmRleE9mKCcvJykpIDogZm9sZGVyLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybiB7IHByZWZhYnMgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6aKE5Yi25Lu26K+m57uG5L+h5oGvJywge1xuICAgICAgICBwcmVmYWJQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mihOWItuS7tui1hOS6p+i3r+W+hO+8iOWmgiBkYjovL2Fzc2V0cy9wcmVmYWJzL015UHJlZmFiLnByZWZhYu+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBnZXRfcHJlZmFiX2luZm8ocGFyYW1zOiB7IHByZWZhYlBhdGg6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGNhbGxBc3NldERCKCdxdWVyeS1hc3NldC1pbmZvJywgcGFyYW1zLnByZWZhYlBhdGgpO1xuICAgICAgICBpZiAoIWluZm8pIHRocm93IG5ldyBFcnJvcihg5pyq5om+5Yiw6aKE5Yi25Lu2OiAke3BhcmFtcy5wcmVmYWJQYXRofWApO1xuICAgICAgICByZXR1cm4gaW5mbztcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDlrp7kvovljJYgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCflsIbpooTliLbku7blrp7kvovljJbliLDlnLrmma/kuK0nLCB7XG4gICAgICAgIHByZWZhYlBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKE5Yi25Lu26Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL3ByZWZhYnMvTXlQcmVmYWIucHJlZmFi77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcGFyZW50VXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfniLboioLngrkgVVVJRO+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgcG9zaXRpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yid5aeL5L2N572uIEpTT07vvIjlj6/pgInvvIzlpoIge1wieFwiOjEwMCxcInlcIjoyMDAsXCJ6XCI6MH3vvIknIH0sXG4gICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5a6e5L6L6IqC54K55ZCN56ew77yI5Y+v6YCJ77yM6buY6K6k5L2/55So6aKE5Yi25Lu25ZCN77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgaW5zdGFudGlhdGVfcHJlZmFiKHBhcmFtczoge1xuICAgICAgICBwcmVmYWJQYXRoOiBzdHJpbmc7XG4gICAgICAgIHBhcmVudFV1aWQ/OiBzdHJpbmc7XG4gICAgICAgIHBvc2l0aW9uPzogc3RyaW5nO1xuICAgICAgICBuYW1lPzogc3RyaW5nO1xuICAgIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICAvLyDojrflj5bpooTliLbku7botYTkuqfkv6Hmga9cbiAgICAgICAgY29uc3QgYXNzZXRJbmZvID0gYXdhaXQgY2FsbEFzc2V0REIoJ3F1ZXJ5LWFzc2V0LWluZm8nLCBwYXJhbXMucHJlZmFiUGF0aCk7XG4gICAgICAgIGlmICghYXNzZXRJbmZvKSB0aHJvdyBuZXcgRXJyb3IoYOacquaJvuWIsOmihOWItuS7tjogJHtwYXJhbXMucHJlZmFiUGF0aH1gKTtcblxuICAgICAgICAvLyDmnoTlu7ogY3JlYXRlLW5vZGUg5Y+C5pWwXG4gICAgICAgIGNvbnN0IGNyZWF0ZU9wdHM6IGFueSA9IHtcbiAgICAgICAgICAgIGFzc2V0VXVpZDogYXNzZXRJbmZvLnV1aWQsXG4gICAgICAgIH07XG5cbiAgICAgICAgaWYgKHBhcmFtcy5wYXJlbnRVdWlkKSB7XG4gICAgICAgICAgICBjcmVhdGVPcHRzLnBhcmVudCA9IHBhcmFtcy5wYXJlbnRVdWlkO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMubmFtZSkge1xuICAgICAgICAgICAgY3JlYXRlT3B0cy5uYW1lID0gcGFyYW1zLm5hbWU7XG4gICAgICAgIH0gZWxzZSBpZiAoYXNzZXRJbmZvLm5hbWUpIHtcbiAgICAgICAgICAgIGNyZWF0ZU9wdHMubmFtZSA9IGFzc2V0SW5mby5uYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g6K6+572u5L2N572uXG4gICAgICAgIGlmIChwYXJhbXMucG9zaXRpb24pIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IEpTT04ucGFyc2UocGFyYW1zLnBvc2l0aW9uKTtcbiAgICAgICAgICAgIGNyZWF0ZU9wdHMuZHVtcCA9IHtcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB2YWx1ZTogcG9zIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgbm9kZVV1aWQgPSBhd2FpdCBjYWxsU2NlbmUoJ2NyZWF0ZS1ub2RlJywgY3JlYXRlT3B0cyk7XG4gICAgICAgIGNvbnN0IHV1aWQgPSBBcnJheS5pc0FycmF5KG5vZGVVdWlkKSA/IG5vZGVVdWlkWzBdIDogbm9kZVV1aWQ7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDpooTliLbku7YgJyR7YXNzZXRJbmZvLm5hbWV9JyDlt7Llrp7kvovljJZgLFxuICAgICAgICAgICAgbm9kZVV1aWQ6IHV1aWQsXG4gICAgICAgICAgICBwcmVmYWJQYXRoOiBwYXJhbXMucHJlZmFiUGF0aCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDliJvlu7rpooTliLbku7YgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCflsIblnLrmma/oioLngrnkv53lrZjkuLrpooTliLbku7bvvIjlkKvlrozmlbTlrZDmoJHlkoznu4Tku7bvvIknLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+a6kOiKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgc2F2ZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKE5Yi25Lu25L+d5a2Y6Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL3ByZWZhYnMvTXlQcmVmYWIucHJlZmFi77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJlZmFiTmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfpooTliLbku7blkI3np7AnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgY3JlYXRlX3ByZWZhYihwYXJhbXM6IHtcbiAgICAgICAgbm9kZVV1aWQ6IHN0cmluZztcbiAgICAgICAgc2F2ZVBhdGg6IHN0cmluZztcbiAgICAgICAgcHJlZmFiTmFtZTogc3RyaW5nO1xuICAgIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICAvLyAxLiDmlLbpm4boioLngrnmoJHmlbDmja5cbiAgICAgICAgY29uc3Qgbm9kZVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlUHJlZmFiRnJvbU5vZGUnLCBbcGFyYW1zLm5vZGVVdWlkXSk7XG4gICAgICAgIGlmICghbm9kZVJlc3VsdC5zdWNjZXNzKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaUtumbhuiKgueCueaVsOaNruWksei0pTogJHtub2RlUmVzdWx0LmVycm9yfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gMi4g5p6E5bu6IC5wcmVmYWIg5paH5Lu2IEpTT05cbiAgICAgICAgY29uc3QgcHJlZmFiSlNPTiA9IGJ1aWxkUHJlZmFiSlNPTihub2RlUmVzdWx0LmRhdGEudHJlZSwgcGFyYW1zLnByZWZhYk5hbWUpO1xuXG4gICAgICAgIC8vIDMuIOehruS/nei3r+W+hOS7pSAucHJlZmFiIOe7k+WwvlxuICAgICAgICBjb25zdCBmdWxsUGF0aCA9IHBhcmFtcy5zYXZlUGF0aC5lbmRzV2l0aCgnLnByZWZhYicpXG4gICAgICAgICAgICA/IHBhcmFtcy5zYXZlUGF0aFxuICAgICAgICAgICAgOiBgJHtwYXJhbXMuc2F2ZVBhdGh9LyR7cGFyYW1zLnByZWZhYk5hbWV9LnByZWZhYmA7XG5cbiAgICAgICAgLy8gNC4g5YaZ5YWl6LWE5LqnXG4gICAgICAgIGNvbnN0IGNvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShwcmVmYWJKU09OLCBudWxsLCAyKTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FsbEFzc2V0REIoJ2NyZWF0ZS1hc3NldCcsIGZ1bGxQYXRoLCBjb250ZW50KTtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOmihOWItuS7tiAnJHtwYXJhbXMucHJlZmFiTmFtZX0nIOW3suWIm+W7umAsXG4gICAgICAgICAgICB1dWlkOiByZXN1bHQ/LnV1aWQsXG4gICAgICAgICAgICB1cmw6IHJlc3VsdD8udXJsLFxuICAgICAgICAgICAgc291cmNlTm9kZTogcGFyYW1zLm5vZGVVdWlkLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOWkjeWItiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+WkjeWItu+8iOWFi+mahu+8iemihOWItuS7ticsIHtcbiAgICAgICAgc291cmNlUHJlZmFiUGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmupDpooTliLbku7bot6/lvoQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB0YXJnZXRQcmVmYWJQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+mihOWItuS7tui3r+W+hO+8iOWmgiBkYjovL2Fzc2V0cy9wcmVmYWJzL015UHJlZmFiX0NvcHkucHJlZmFi77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgbmV3UHJlZmFiTmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlrDpooTliLbku7blkI3np7DvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBkdXBsaWNhdGVfcHJlZmFiKHBhcmFtczoge1xuICAgICAgICBzb3VyY2VQcmVmYWJQYXRoOiBzdHJpbmc7XG4gICAgICAgIHRhcmdldFByZWZhYlBhdGg6IHN0cmluZztcbiAgICAgICAgbmV3UHJlZmFiTmFtZT86IHN0cmluZztcbiAgICB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgLy8g6I635Y+W5rqQ6aKE5Yi25Lu2IFVVSURcbiAgICAgICAgY29uc3Qgc3JjVXVpZCA9IGF3YWl0IGNhbGxBc3NldERCKCdxdWVyeS11dWlkJywgcGFyYW1zLnNvdXJjZVByZWZhYlBhdGgpO1xuICAgICAgICBpZiAoIXNyY1V1aWQpIHRocm93IG5ldyBFcnJvcihg5pyq5om+5Yiw5rqQ6aKE5Yi25Lu2OiAke3BhcmFtcy5zb3VyY2VQcmVmYWJQYXRofWApO1xuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGxBc3NldERCKCdjb3B5LWFzc2V0Jywgc3JjVXVpZCwgcGFyYW1zLnRhcmdldFByZWZhYlBhdGgpO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBtZXNzYWdlOiBg6aKE5Yi25Lu25bey5aSN5Yi25YiwICR7cGFyYW1zLnRhcmdldFByZWZhYlBhdGh9YCxcbiAgICAgICAgICAgIHV1aWQ6IHJlc3VsdD8udXVpZCxcbiAgICAgICAgICAgIHVybDogcmVzdWx0Py51cmwsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5om56YeP5a6e5L6L5YyWID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5om56YeP5a6e5L6L5YyW6aKE5Yi25Lu277yI572R5qC85o6S5YiX77yJJywge1xuICAgICAgICBwcmVmYWJQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mihOWItuS7tui3r+W+hCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHBhcmVudFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn54i26IqC54K5IFVVSUQnIH0sXG4gICAgICAgIGNvdW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aVsOmHj++8iEpTT04g5aaCIHtcInhcIjozLFwieVwiOjJ9IOihqOekuiAzIOWIlyAyIOihjO+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHNwYWNpbmc6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6Ze06LedIEpTT07vvIjlpoIge1wieFwiOjEwMCxcInlcIjoxMDB977yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgYmF0Y2hfaW5zdGFudGlhdGUocGFyYW1zOiB7XG4gICAgICAgIHByZWZhYlBhdGg6IHN0cmluZztcbiAgICAgICAgcGFyZW50VXVpZD86IHN0cmluZztcbiAgICAgICAgY291bnQ6IHN0cmluZztcbiAgICAgICAgc3BhY2luZz86IHN0cmluZztcbiAgICB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgY291bnQgPSBKU09OLnBhcnNlKHBhcmFtcy5jb3VudCk7XG4gICAgICAgIGNvbnN0IHNwYWNpbmcgPSBwYXJhbXMuc3BhY2luZyA/IEpTT04ucGFyc2UocGFyYW1zLnNwYWNpbmcpIDogeyB4OiAxMDAsIHk6IDEwMCB9O1xuICAgICAgICBjb25zdCBjb2xzID0gY291bnQueCB8fCAxO1xuICAgICAgICBjb25zdCByb3dzID0gY291bnQueSB8fCAxO1xuXG4gICAgICAgIGNvbnN0IHRvdGFsID0gY29scyAqIHJvd3M7XG4gICAgICAgIGlmICh0b3RhbCA+IDEwMCkgdGhyb3cgbmV3IEVycm9yKCfljZXmrKHmibnph4/lrp7kvovljJbkuIrpmZDkuLogMTAwJyk7XG5cbiAgICAgICAgY29uc3QgYXNzZXRJbmZvID0gYXdhaXQgY2FsbEFzc2V0REIoJ3F1ZXJ5LWFzc2V0LWluZm8nLCBwYXJhbXMucHJlZmFiUGF0aCk7XG4gICAgICAgIGlmICghYXNzZXRJbmZvKSB0aHJvdyBuZXcgRXJyb3IoYOacquaJvuWIsOmihOWItuS7tjogJHtwYXJhbXMucHJlZmFiUGF0aH1gKTtcblxuICAgICAgICBjb25zdCB1dWlkczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgcm93ID0gMDsgcm93IDwgcm93czsgcm93KyspIHtcbiAgICAgICAgICAgIGZvciAobGV0IGNvbCA9IDA7IGNvbCA8IGNvbHM7IGNvbCsrKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgeCA9IGNvbCAqIHNwYWNpbmcueDtcbiAgICAgICAgICAgICAgICBjb25zdCB5ID0gLXJvdyAqIHNwYWNpbmcueTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmluc3RhbnRpYXRlX3ByZWZhYih7XG4gICAgICAgICAgICAgICAgICAgIHByZWZhYlBhdGg6IHBhcmFtcy5wcmVmYWJQYXRoLFxuICAgICAgICAgICAgICAgICAgICBwYXJlbnRVdWlkOiBwYXJhbXMucGFyZW50VXVpZCxcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IEpTT04uc3RyaW5naWZ5KHsgeCwgeSwgejogMCB9KSxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogYCR7YXNzZXRJbmZvLm5hbWV9XyR7cm93ICogY29scyArIGNvbCArIDF9YCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB1dWlkcy5wdXNoKHJlc3VsdC5ub2RlVXVpZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOW3suaJuemHj+WunuS+i+WMliAke3RvdGFsfSDkuKrpooTliLbku7bvvIgke2NvbHN9eCR7cm93c30g572R5qC877yJYCxcbiAgICAgICAgICAgIG5vZGVVdWlkczogdXVpZHMsXG4gICAgICAgICAgICBncmlkOiB7IGNvbHMsIHJvd3MsIHNwYWNpbmcgfSxcbiAgICAgICAgfTtcbiAgICB9XG59XG4iXX0=