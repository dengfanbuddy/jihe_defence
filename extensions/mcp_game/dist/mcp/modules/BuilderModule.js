"use strict";
/**
 * 构建器模块 — 从 JSON 定义一键构建完整节点树
 *
 * 接收 JSON 树定义，递归创建节点、添加组件、设置属性。
 * 支持 'type' 快捷创建 Button/Label/Sprite 等内置 UI 控件。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuilderModule = void 0;
const decorators_1 = require("../decorators");
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
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
let BuilderModule = class BuilderModule {
    async build(params) {
        const tree = JSON.parse(params.tree);
        const clean = params.clean === 'true';
        // 确定父节点 UUID
        let parentUuid;
        if (params.parent) {
            try {
                const result = await executeSceneScript('findNodeByName', [params.parent]);
                if (result.success && result.data && result.data.length > 0) {
                    parentUuid = result.data[0].uuid;
                }
            }
            catch ( /* 没找到 */_a) { /* 没找到 */ }
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
        const createdNodes = [];
        const buildNode = async (def, parent) => {
            var _a;
            if (!def || !def.name)
                return null;
            // 创建节点
            const nodeResult = await executeSceneScript('createNode', [def.name, parent]);
            if (!nodeResult.success)
                return null;
            const nodeUuid = (_a = nodeResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
            if (!nodeUuid)
                return null;
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
                }
                catch (_b) {
                    // fallback: 手动添加组件
                    const typeToComponent = {
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
                        }
                        catch ( /* 可能已有 */_c) { /* 可能已有 */ }
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
                    }
                    catch ( /* 已存在或无效 */_d) { /* 已存在或无效 */ }
                }
            }
            // 设置组件属性（props 或 properties）
            const compProps = def.props || def.properties;
            if (compProps && typeof compProps === 'object') {
                for (const [compType, props] of Object.entries(compProps)) {
                    if (props && typeof props === 'object') {
                        for (const [propName, propValue] of Object.entries(props)) {
                            try {
                                await executeSceneScript('setComponentProperty', [nodeUuid, compType, propName, propValue]);
                            }
                            catch ( /* 跳过属性设置失败 */_e) { /* 跳过属性设置失败 */ }
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
};
exports.BuilderModule = BuilderModule;
__decorate([
    (0, decorators_1.MCPTool)('从 JSON 定义构建完整节点树。支持嵌套节点、组件添加、属性设置。顶层节点 "type" 可快速创建内置 UI 控件（Button/Label/Sprite 等）', {
        parent: { type: 'string', description: '父节点路径、UUID 或名称（默认 Canvas）' },
        tree: { type: 'string', description: '节点树 JSON 定义（必填）。格式见注意事项', required: true },
        clean: { type: 'string', description: '构建前是否清空父节点子节点: "true" 或 "false"' },
    })
], BuilderModule.prototype, "build", null);
exports.BuilderModule = BuilderModule = __decorate([
    (0, decorators_1.MCPModule)('builder', '场景构建器 - 从 JSON 定义一键创建完整节点树（支持递归嵌套、组件、属性设置）')
], BuilderModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQnVpbGRlck1vZHVsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NvdXJjZS9tY3AvbW9kdWxlcy9CdWlsZGVyTW9kdWxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7O0FBRUgsOENBQW1EO0FBRW5ELEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxNQUFjLEVBQUUsT0FBYyxFQUFFO0lBQzlELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUU7WUFDakUsSUFBSSxFQUFFLFVBQVU7WUFDaEIsTUFBTTtZQUNOLElBQUk7U0FDUCxDQUFDLENBQUM7SUFDUCxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ25ELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDbEUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUdNLElBQU0sYUFBYSxHQUFuQixNQUFNLGFBQWE7SUFPaEIsQUFBTixLQUFLLENBQUMsS0FBSyxDQUFDLE1BQXlEO1FBQ2pFLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElB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QUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx5QkFBeUIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2hGLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGlDQUFpQyxFQUFFO0tBQzVFLENBQUM7MENBc0lEO3dCQTVJUSxhQUFhO0lBRHpCLElBQUEsc0JBQVMsRUFBQyxTQUFTLEVBQUUsNENBQTRDLENBQUM7R0FDdEQsYUFBYSxDQTZJekIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOaehOW7uuWZqOaooeWdlyDigJQg5LuOIEpTT04g5a6a5LmJ5LiA6ZSu5p6E5bu65a6M5pW06IqC54K55qCRXG4gKlxuICog5o6l5pS2IEpTT04g5qCR5a6a5LmJ77yM6YCS5b2S5Yib5bu66IqC54K544CB5re75Yqg57uE5Lu244CB6K6+572u5bGe5oCn44CCXG4gKiDmlK/mjIEgJ3R5cGUnIOW/q+aNt+WIm+W7uiBCdXR0b24vTGFiZWwvU3ByaXRlIOetieWGhee9riBVSSDmjqfku7bjgIJcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNjZW5lU2NyaXB0KG1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSA9IFtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiAnbWNwX2dhbWUnLFxuICAgICAgICAgICAgbWV0aG9kLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv6ISa5pysICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTY2VuZShtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbkBNQ1BNb2R1bGUoJ2J1aWxkZXInLCAn5Zy65pmv5p6E5bu65ZmoIC0g5LuOIEpTT04g5a6a5LmJ5LiA6ZSu5Yib5bu65a6M5pW06IqC54K55qCR77yI5pSv5oyB6YCS5b2S5bWM5aWX44CB57uE5Lu244CB5bGe5oCn6K6+572u77yJJylcbmV4cG9ydCBjbGFzcyBCdWlsZGVyTW9kdWxlIHtcblxuICAgIEBNQ1BUb29sKCfku44gSlNPTiDlrprkuYnmnoTlu7rlrozmlbToioLngrnmoJHjgILmlK/mjIHltYzlpZfoioLngrnjgIHnu4Tku7bmt7vliqDjgIHlsZ7mgKforr7nva7jgILpobblsYLoioLngrkgXCJ0eXBlXCIg5Y+v5b+r6YCf5Yib5bu65YaF572uIFVJIOaOp+S7tu+8iEJ1dHRvbi9MYWJlbC9TcHJpdGUg562J77yJJywge1xuICAgICAgICBwYXJlbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn54i26IqC54K56Lev5b6E44CBVVVJRCDmiJblkI3np7DvvIjpu5jorqQgQ2FudmFz77yJJyB9LFxuICAgICAgICB0cmVlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueagkSBKU09OIOWumuS5ie+8iOW/heWhq++8ieOAguagvOW8j+ingeazqOaEj+S6i+mhuScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGNsZWFuOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aehOW7uuWJjeaYr+WQpua4heepuueItuiKgueCueWtkOiKgueCuTogXCJ0cnVlXCIg5oiWIFwiZmFsc2VcIicgfSxcbiAgICB9KVxuICAgIGFzeW5jIGJ1aWxkKHBhcmFtczogeyBwYXJlbnQ/OiBzdHJpbmc7IHRyZWU6IHN0cmluZzsgY2xlYW4/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHRyZWUgPSBKU09OLnBhcnNlKHBhcmFtcy50cmVlKTtcbiAgICAgICAgY29uc3QgY2xlYW4gPSBwYXJhbXMuY2xlYW4gPT09ICd0cnVlJztcblxuICAgICAgICAvLyDnoa7lrprniLboioLngrkgVVVJRFxuICAgICAgICBsZXQgcGFyZW50VXVpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAocGFyYW1zLnBhcmVudCkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2ZpbmROb2RlQnlOYW1lJywgW3BhcmFtcy5wYXJlbnRdKTtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0LnN1Y2Nlc3MgJiYgcmVzdWx0LmRhdGEgJiYgcmVzdWx0LmRhdGEubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBwYXJlbnRVdWlkID0gcmVzdWx0LmRhdGFbMF0udXVpZDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyog5rKh5om+5YiwICovIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOWmguaenOaMh+WumuS6hiBjbGVhbu+8jOiOt+WPluW5tuWIoOmZpOeItuiKgueCueS4i+aJgOacieWtkOiKgueCuVxuICAgICAgICBpZiAoY2xlYW4gJiYgcGFyZW50VXVpZCkge1xuICAgICAgICAgICAgY29uc3QgcGFyZW50SW5mbyA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnZ2V0Tm9kZUluZm8nLCBbcGFyZW50VXVpZF0pO1xuICAgICAgICAgICAgaWYgKHBhcmVudEluZm8uc3VjY2VzcyAmJiBwYXJlbnRJbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkVXVpZCBvZiAocGFyZW50SW5mby5kYXRhLmNoaWxkcmVuIHx8IFtdKSkge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2RlbGV0ZU5vZGUnLCBbY2hpbGRVdWlkXSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8g6YCS5b2S5p6E5bu66IqC54K55qCRXG4gICAgICAgIGNvbnN0IGNyZWF0ZWROb2RlczogeyBuYW1lOiBzdHJpbmc7IHV1aWQ6IHN0cmluZyB9W10gPSBbXTtcblxuICAgICAgICBjb25zdCBidWlsZE5vZGUgPSBhc3luYyAoZGVmOiBhbnksIHBhcmVudD86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4gPT4ge1xuICAgICAgICAgICAgaWYgKCFkZWYgfHwgIWRlZi5uYW1lKSByZXR1cm4gbnVsbDtcblxuICAgICAgICAgICAgLy8g5Yib5bu66IqC54K5XG4gICAgICAgICAgICBjb25zdCBub2RlUmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdjcmVhdGVOb2RlJywgW2RlZi5uYW1lLCBwYXJlbnRdKTtcbiAgICAgICAgICAgIGlmICghbm9kZVJlc3VsdC5zdWNjZXNzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IG5vZGVVdWlkID0gbm9kZVJlc3VsdC5kYXRhPy51dWlkO1xuICAgICAgICAgICAgaWYgKCFub2RlVXVpZCkgcmV0dXJuIG51bGw7XG5cbiAgICAgICAgICAgIGNyZWF0ZWROb2Rlcy5wdXNoKHsgbmFtZTogZGVmLm5hbWUsIHV1aWQ6IG5vZGVVdWlkIH0pO1xuXG4gICAgICAgICAgICAvLyDorr7nva4gcG9zaXRpb25cbiAgICAgICAgICAgIGlmIChkZWYucG9zaXRpb24pIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldE5vZGVQcm9wZXJ0eScsIFtub2RlVXVpZCwgJ3Bvc2l0aW9uJywgZGVmLnBvc2l0aW9uXSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOiuvue9riBzY2FsZVxuICAgICAgICAgICAgaWYgKGRlZi5zY2FsZSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW25vZGVVdWlkLCAnc2NhbGUnLCBkZWYuc2NhbGVdKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g6K6+572uIHJvdGF0aW9uXG4gICAgICAgICAgICBpZiAoZGVmLnJvdGF0aW9uKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXROb2RlUHJvcGVydHknLCBbbm9kZVV1aWQsICdyb3RhdGlvbicsIGRlZi5yb3RhdGlvbl0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDorr7nva4gYWN0aXZlXG4gICAgICAgICAgICBpZiAoZGVmLmFjdGl2ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXROb2RlUHJvcGVydHknLCBbbm9kZVV1aWQsICdhY3RpdmUnLCBkZWYuYWN0aXZlXSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOa3u+WKoOe7hOS7tu+8iOagueaNriB0eXBlIOaIliBjb21wb25lbnRzIOWIl+ihqO+8iVxuICAgICAgICAgICAgaWYgKGRlZi50eXBlKSB7XG4gICAgICAgICAgICAgICAgLy8gdHlwZSDlv6vmjbfliJvlu7rlhoXnva4gVUkg5o6n5Lu2XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgY2FsbFNjZW5lKCdjcmVhdGUtbm9kZScsIHsgcGFyZW50VXVpZDogcGFyZW50LCBuYW1lOiBkZWYubmFtZSwgdHlwZTogZGVmLnR5cGUgfSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGZhbGxiYWNrOiDmiYvliqjmt7vliqDnu4Tku7ZcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZVRvQ29tcG9uZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ0J1dHRvbic6ICdjYy5CdXR0b24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0xhYmVsJzogJ2NjLkxhYmVsJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdTcHJpdGUnOiAnY2MuU3ByaXRlJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdFZGl0Qm94JzogJ2NjLkVkaXRCb3gnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1Njcm9sbFZpZXcnOiAnY2MuU2Nyb2xsVmlldycsXG4gICAgICAgICAgICAgICAgICAgICAgICAnUHJvZ3Jlc3NCYXInOiAnY2MuUHJvZ3Jlc3NCYXInLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1NsaWRlcic6ICdjYy5TbGlkZXInLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1RvZ2dsZSc6ICdjYy5Ub2dnbGUnLFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb21wVHlwZSA9IHR5cGVUb0NvbXBvbmVudFtkZWYudHlwZV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChjb21wVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbm9kZVV1aWQsICdjYy5VSVRyYW5zZm9ybSddKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbm9kZVV1aWQsIGNvbXBUeXBlXSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHsgLyog5Y+v6IO95bey5pyJICovIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZi5jb21wb25lbnRzICYmIEFycmF5LmlzQXJyYXkoZGVmLmNvbXBvbmVudHMpKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wIG9mIGRlZi5jb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb21wVHlwZSA9IGNvbXA7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgY29tcCA9PT0gJ29iamVjdCcgJiYgY29tcC50eXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb21wVHlwZSA9IGNvbXAudHlwZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2FkZENvbXBvbmVudFRvTm9kZScsIFtub2RlVXVpZCwgJ2NjLlVJVHJhbnNmb3JtJ10pO1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdhZGRDb21wb25lbnRUb05vZGUnLCBbbm9kZVV1aWQsIGNvbXBUeXBlXSk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiDlt7LlrZjlnKjmiJbml6DmlYggKi8gfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g6K6+572u57uE5Lu25bGe5oCn77yIcHJvcHMg5oiWIHByb3BlcnRpZXPvvIlcbiAgICAgICAgICAgIGNvbnN0IGNvbXBQcm9wcyA9IGRlZi5wcm9wcyB8fCBkZWYucHJvcGVydGllcztcbiAgICAgICAgICAgIGlmIChjb21wUHJvcHMgJiYgdHlwZW9mIGNvbXBQcm9wcyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IFtjb21wVHlwZSwgcHJvcHNdIG9mIE9iamVjdC5lbnRyaWVzKGNvbXBQcm9wcykpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByb3BzICYmIHR5cGVvZiBwcm9wcyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgW3Byb3BOYW1lLCBwcm9wVmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHByb3BzIGFzIG9iamVjdCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW25vZGVVdWlkLCBjb21wVHlwZSBhcyBzdHJpbmcsIHByb3BOYW1lLCBwcm9wVmFsdWVdKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHsgLyog6Lez6L+H5bGe5oCn6K6+572u5aSx6LSlICovIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g6YCS5b2S5p6E5bu65a2Q6IqC54K5XG4gICAgICAgICAgICBpZiAoZGVmLmNoaWxkcmVuICYmIEFycmF5LmlzQXJyYXkoZGVmLmNoaWxkcmVuKSkge1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgZGVmLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkTm9kZShjaGlsZCwgbm9kZVV1aWQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG5vZGVVdWlkO1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vIOWmguaenOaYr+aVsOe7hO+8jOWIhuWIq+WIm+W7uuavj+S4quagueiKgueCuVxuICAgICAgICBjb25zdCB0cmVlcyA9IEFycmF5LmlzQXJyYXkodHJlZSkgPyB0cmVlIDogW3RyZWVdO1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGVEZWYgb2YgdHJlZXMpIHtcbiAgICAgICAgICAgIGF3YWl0IGJ1aWxkTm9kZShub2RlRGVmLCBwYXJlbnRVdWlkKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBtZXNzYWdlOiBg6IqC54K55qCR5p6E5bu65a6M5oiQ77yM5YWx5Yib5bu6ICR7Y3JlYXRlZE5vZGVzLmxlbmd0aH0g5Liq6IqC54K5YCxcbiAgICAgICAgICAgIG5vZGVzOiBjcmVhdGVkTm9kZXMsXG4gICAgICAgIH07XG4gICAgfVxufVxuIl19