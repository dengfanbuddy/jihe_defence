"use strict";
/**
 * 场景快照模块 — 获取场景/节点子树的 JSON 快照
 *
 * 快速获取场景节点层级、位置、组件等结构化数据供 AI 上下文理解。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptureModule = void 0;
const decorators_1 = require("../decorators");
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
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
let CaptureModule = class CaptureModule {
    async scene_snapshot() {
        const result = {};
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
        }
        catch ( /* */_a) { /* */ }
        // 设计分辨率
        try {
            const canvas = await callScene('query-current-scene');
            result.designResolution = (canvas === null || canvas === void 0 ? void 0 : canvas.designResolution) || { width: 960, height: 640 };
        }
        catch (_b) {
            result.designResolution = { width: 960, height: 640 };
        }
        // 完整层级树（含组件信息）
        try {
            const hierarchy = await executeSceneScript('getSceneHierarchy', [true]);
            if (hierarchy.success) {
                result.nodes = hierarchy.data;
            }
        }
        catch ( /* */_c) { /* */ }
        // 相机信息
        try {
            const cameraNodes = await executeSceneScript('findNodesByComponent', ['cc.Camera']);
            if (cameraNodes.success && cameraNodes.data) {
                result.cameras = cameraNodes.data;
            }
        }
        catch ( /* */_d) { /* */ }
        return result;
    }
    async node_snapshot(params) {
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
        const processNode = async (uuid, depth) => {
            if (depth > maxDepth)
                return { name: '...max depth...' };
            try {
                const info = await executeSceneScript('getNodeInfo', [uuid]);
                if (!info.success)
                    return null;
                const d = info.data;
                const node = {
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
                        if (child)
                            node.children.push(child);
                    }
                }
                return node;
            }
            catch (_a) {
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
    countNodes(node) {
        if (!node)
            return 0;
        let count = 1;
        if (node.children) {
            for (const child of node.children) {
                count += this.countNodes(child);
            }
        }
        return count;
    }
};
exports.CaptureModule = CaptureModule;
__decorate([
    (0, decorators_1.MCPTool)('获取当前场景的完整布局 JSON 快照，包含场景名称、设计分辨率、节点层级、位置、大小、Widget 对齐、文本内容等', {})
], CaptureModule.prototype, "scene_snapshot", null);
__decorate([
    (0, decorators_1.MCPTool)('获取指定节点及其子树的详细快照（含位置/尺寸/组件属性等）', {
        node: { type: 'string', description: '节点 UUID、路径或名称', required: true },
        maxDepth: { type: 'string', description: '最大递归深度（默认 10）' },
    })
], CaptureModule.prototype, "node_snapshot", null);
exports.CaptureModule = CaptureModule = __decorate([
    (0, decorators_1.MCPModule)('capture', '场景快照 - 获取完整场景布局 JSON 或指定节点子树的详细快照')
], CaptureModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ2FwdHVyZU1vZHVsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NvdXJjZS9tY3AvbW9kdWxlcy9DYXB0dXJlTW9kdWxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7OztHQUlHOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFFbkQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ25ELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDbEUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUVELEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxNQUFjLEVBQUUsT0FBYyxFQUFFO0lBQzlELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUU7WUFDakUsSUFBSSxFQUFFLFVBQVU7WUFDaEIsTUFBTTtZQUNOLElBQUk7U0FDUCxDQUFDLENBQUM7SUFDUCxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBR00sSUFBTSxhQUFhLEdBQW5CLE1BQU0sYUFBYTtJQUdoQixBQUFOLEtBQUssQ0FBQyxjQUFjO1FBQ2hCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztRQUV2QixPQUFPO1FBQ1AsSUFBSSxDQUFDO1lBQ0QsTUFB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QU8sSUFBSSxDQUFDO1lBQ2hCLENBQUM7UUFDTCxDQUFDLENBQUM7UUFFRixNQUFNLFFBQVEsR0FBRyxNQUFNLFdBQVcsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDaEQsT0FBTztZQUNILFFBQVE7WUFDUixTQUFTLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUM7U0FDdkMsQ0FBQztJQUNOLENBQUM7SUFFRCxjQUFjO0lBQ04sVUFBVSxDQUFDLElBQVM7UUFDeEIsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPLENBQUMsQ0FBQztRQUNwQixJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7UUFDZCxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNoQixLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDaEMsS0FBSyxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDcEMsQ0FBQztRQUNMLENBQUM7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0NBQ0osQ0FBQTtBQWpIWSxzQ0FBYTtBQUdoQjtJQURMLElBQUEsb0JBQU8sRUFBQyw2REFBNkQsRUFBRSxFQUFFLENBQUM7bURBMEMxRTtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLCtCQUErQixFQUFFO1FBQ3RDLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3RFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRTtLQUM3RCxDQUFDO2tEQW1ERDt3QkFwR1EsYUFBYTtJQUR6QixJQUFBLHNCQUFTLEVBQUMsU0FBUyxFQUFFLG1DQUFtQyxDQUFDO0dBQzdDLGFBQWEsQ0FpSHpCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDlnLrmma/lv6vnhafmqKHlnZcg4oCUIOiOt+WPluWcuuaZry/oioLngrnlrZDmoJHnmoQgSlNPTiDlv6vnhadcbiAqXG4gKiDlv6vpgJ/ojrflj5blnLrmma/oioLngrnlsYLnuqfjgIHkvY3nva7jgIHnu4Tku7bnrYnnu5PmnoTljJbmlbDmja7kvpsgQUkg5LiK5LiL5paH55CG6Kej44CCXG4gKi9cblxuaW1wb3J0IHsgTUNQTW9kdWxlLCBNQ1BUb29sIH0gZnJvbSAnLi4vZGVjb3JhdG9ycyc7XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTY2VuZShtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTY2VuZVNjcmlwdChtZXRob2Q6IHN0cmluZywgYXJnczogYW55W10gPSBbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogJ21jcF9nYW1lJyxcbiAgICAgICAgICAgIG1ldGhvZCxcbiAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+iEmuacrCAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5ATUNQTW9kdWxlKCdjYXB0dXJlJywgJ+WcuuaZr+W/q+eFpyAtIOiOt+WPluWujOaVtOWcuuaZr+W4g+WxgCBKU09OIOaIluaMh+WumuiKgueCueWtkOagkeeahOivpue7huW/q+eFpycpXG5leHBvcnQgY2xhc3MgQ2FwdHVyZU1vZHVsZSB7XG5cbiAgICBATUNQVG9vbCgn6I635Y+W5b2T5YmN5Zy65pmv55qE5a6M5pW05biD5bGAIEpTT04g5b+r54Wn77yM5YyF5ZCr5Zy65pmv5ZCN56ew44CB6K6+6K6h5YiG6L6o546H44CB6IqC54K55bGC57qn44CB5L2N572u44CB5aSn5bCP44CBV2lkZ2V0IOWvuem9kOOAgeaWh+acrOWGheWuueetiScsIHt9KVxuICAgIGFzeW5jIHNjZW5lX3NuYXBzaG90KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0ge307XG5cbiAgICAgICAgLy8g5Zy65pmv5L+h5oGvXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBzY2VuZUluZm8gPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2dldEN1cnJlbnRTY2VuZUluZm8nKTtcbiAgICAgICAgICAgIGlmIChzY2VuZUluZm8uc3VjY2Vzcykge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5zY2VuZSA9IHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogc2NlbmVJbmZvLmRhdGEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdXVpZDogc2NlbmVJbmZvLmRhdGEudXVpZCxcbiAgICAgICAgICAgICAgICAgICAgbm9kZUNvdW50OiBzY2VuZUluZm8uZGF0YS5ub2RlQ291bnQsXG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZTogc2NlbmVJbmZvLmRhdGEuYWN0aXZlLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiAqLyB9XG5cbiAgICAgICAgLy8g6K6+6K6h5YiG6L6o546HXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYW52YXMgPSBhd2FpdCBjYWxsU2NlbmUoJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKTtcbiAgICAgICAgICAgIHJlc3VsdC5kZXNpZ25SZXNvbHV0aW9uID0gY2FudmFzPy5kZXNpZ25SZXNvbHV0aW9uIHx8IHsgd2lkdGg6IDk2MCwgaGVpZ2h0OiA2NDAgfTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXN1bHQuZGVzaWduUmVzb2x1dGlvbiA9IHsgd2lkdGg6IDk2MCwgaGVpZ2h0OiA2NDAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOWujOaVtOWxgue6p+agke+8iOWQq+e7hOS7tuS/oeaBr++8iVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgaGllcmFyY2h5ID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRTY2VuZUhpZXJhcmNoeScsIFt0cnVlXSk7XG4gICAgICAgICAgICBpZiAoaGllcmFyY2h5LnN1Y2Nlc3MpIHtcbiAgICAgICAgICAgICAgICByZXN1bHQubm9kZXMgPSBoaWVyYXJjaHkuZGF0YTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qICovIH1cblxuICAgICAgICAvLyDnm7jmnLrkv6Hmga9cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNhbWVyYU5vZGVzID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdmaW5kTm9kZXNCeUNvbXBvbmVudCcsIFsnY2MuQ2FtZXJhJ10pO1xuICAgICAgICAgICAgaWYgKGNhbWVyYU5vZGVzLnN1Y2Nlc3MgJiYgY2FtZXJhTm9kZXMuZGF0YSkge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5jYW1lcmFzID0gY2FtZXJhTm9kZXMuZGF0YTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qICovIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfojrflj5bmjIflrproioLngrnlj4rlhbblrZDmoJHnmoTor6bnu4blv6vnhafvvIjlkKvkvY3nva4v5bC65a+4L+e7hOS7tuWxnuaAp+etie+8iScsIHtcbiAgICAgICAgbm9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJROOAgei3r+W+hOaIluWQjeensCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIG1heERlcHRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+acgOWkp+mAkuW9kua3seW6pu+8iOm7mOiupCAxMO+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIG5vZGVfc25hcHNob3QocGFyYW1zOiB7IG5vZGU6IHN0cmluZzsgbWF4RGVwdGg/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IG1heERlcHRoID0gcGFyc2VJbnQocGFyYW1zLm1heERlcHRoIHx8ICcxMCcsIDEwKTtcblxuICAgICAgICAvLyDojrflj5boioLngrkgVVVJRFxuICAgICAgICBsZXQgbm9kZVV1aWQgPSBwYXJhbXMubm9kZTtcbiAgICAgICAgaWYgKCFub2RlVXVpZC5zdGFydHNXaXRoKCd7JykgJiYgbm9kZVV1aWQubGVuZ3RoICE9PSAzNikge1xuICAgICAgICAgICAgLy8g5Y+v6IO95piv5ZCN56ew77yM5bCd6K+V5p+l5om+XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2ZpbmROb2RlQnlOYW1lJywgW3BhcmFtcy5ub2RlXSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LnN1Y2Nlc3MgJiYgcmVzdWx0LmRhdGEgJiYgcmVzdWx0LmRhdGEubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIG5vZGVVdWlkID0gcmVzdWx0LmRhdGFbMF0udXVpZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHByb2Nlc3NOb2RlID0gYXN5bmMgKHV1aWQ6IHN0cmluZywgZGVwdGg6IG51bWJlcik6IFByb21pc2U8YW55PiA9PiB7XG4gICAgICAgICAgICBpZiAoZGVwdGggPiBtYXhEZXB0aCkgcmV0dXJuIHsgbmFtZTogJy4uLm1heCBkZXB0aC4uLicgfTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnZ2V0Tm9kZUluZm8nLCBbdXVpZF0pO1xuICAgICAgICAgICAgICAgIGlmICghaW5mby5zdWNjZXNzKSByZXR1cm4gbnVsbDtcblxuICAgICAgICAgICAgICAgIGNvbnN0IGQgPSBpbmZvLmRhdGE7XG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZTogYW55ID0ge1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHV1aWQ6IGQudXVpZCxcbiAgICAgICAgICAgICAgICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IGQucG9zaXRpb24sXG4gICAgICAgICAgICAgICAgICAgIHJvdGF0aW9uOiBkLnJvdGF0aW9uLFxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogZC5zY2FsZSxcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogZC5jb21wb25lbnRzLFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAvLyDpgJLlvZLlrZDoioLngrlcbiAgICAgICAgICAgICAgICBpZiAoZC5jaGlsZHJlbiAmJiBkLmNoaWxkcmVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbiA9IFtdO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkVXVpZCBvZiBkLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjaGlsZCA9IGF3YWl0IHByb2Nlc3NOb2RlKGNoaWxkVXVpZCwgZGVwdGggKyAxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjaGlsZCkgbm9kZS5jaGlsZHJlbi5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBub2RlO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSBhd2FpdCBwcm9jZXNzTm9kZShub2RlVXVpZCwgMSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzbmFwc2hvdCxcbiAgICAgICAgICAgIG5vZGVDb3VudDogdGhpcy5jb3VudE5vZGVzKHNuYXBzaG90KSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKiog6YCS5b2S57uf6K6h6IqC54K55pWwICovXG4gICAgcHJpdmF0ZSBjb3VudE5vZGVzKG5vZGU6IGFueSk6IG51bWJlciB7XG4gICAgICAgIGlmICghbm9kZSkgcmV0dXJuIDA7XG4gICAgICAgIGxldCBjb3VudCA9IDE7XG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgICAgICAgICBjb3VudCArPSB0aGlzLmNvdW50Tm9kZXMoY2hpbGQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjb3VudDtcbiAgICB9XG59XG4iXX0=