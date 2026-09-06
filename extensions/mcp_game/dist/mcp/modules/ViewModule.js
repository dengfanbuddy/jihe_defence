"use strict";
/**
 * 视口控制模块 — Gizmo 工具、2D/3D 模式、相机控制、网格、图标、参考图
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewModule = void 0;
const decorators_1 = require("../decorators");
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
let ViewModule = class ViewModule {
    // ==================== Gizmo ====================
    async gizmo_tool(params) {
        return callScene('set-gizmo-tool', params.tool);
    }
    async gizmo_tool_query() {
        return callScene('query-gizmo-tool');
    }
    async gizmo_pivot(params) {
        return callScene('set-gizmo-pivot', params.pivot);
    }
    async gizmo_pivot_query() {
        return callScene('query-gizmo-pivot');
    }
    async gizmo_coordinate(params) {
        return callScene('set-gizmo-coordinate', params.coordinate);
    }
    async gizmo_coordinate_query() {
        return callScene('query-gizmo-coordinate');
    }
    // ==================== 2D/3D 模式 ====================
    async mode_2d_3d(params) {
        return callScene('set-2d-3d-mode', params.is2D === 'true');
    }
    async mode_query() {
        return callScene('query-2d-3d-mode');
    }
    // ==================== 网格 ====================
    async grid_set(params) {
        return callScene('set-grid-visible', params.visible === 'true');
    }
    async grid_query() {
        return callScene('query-grid-visible');
    }
    // ==================== 相机 ====================
    async camera_focus(params) {
        let uuids;
        try {
            uuids = JSON.parse(params.nodes);
        }
        catch (_a) {
            uuids = [params.nodes];
        }
        return callScene('focus-camera', uuids);
    }
    async camera_align_view() {
        return callScene('align-view-to-selection');
    }
    async camera_align_node() {
        return callScene('align-selection-to-view');
    }
    // ==================== 视口状态 ====================
    async view_status() {
        return callScene('query-view-status');
    }
    async reset_view() {
        return callScene('reset-view');
    }
    // ==================== 参考图 ====================
    async ref_add(params) {
        return callScene('add-reference-image', params.imageUrl, params.name);
    }
    async ref_remove(params) {
        return callScene('remove-reference-image', params.imageId);
    }
    async ref_switch(params) {
        return callScene('switch-reference-image', parseInt(params.index, 10));
    }
    async ref_clear() {
        return callScene('clear-reference-images');
    }
    async ref_list() {
        return callScene('list-reference-images');
    }
    async ref_position(params) {
        return callScene('set-reference-image-position', params.imageId, params.x ? parseInt(params.x, 10) : 0, params.y ? parseInt(params.y, 10) : 0);
    }
    async ref_scale(params) {
        return callScene('set-reference-image-scale', params.imageId, parseFloat(params.scale));
    }
    async ref_opacity(params) {
        return callScene('set-reference-image-opacity', params.imageId, parseFloat(params.opacity));
    }
};
exports.ViewModule = ViewModule;
__decorate([
    (0, decorators_1.MCPTool)('设置当前 Gizmo 变换工具', {
        tool: { type: 'string', description: '工具名: position/rotation/scale/rect', required: true },
    })
], ViewModule.prototype, "gizmo_tool", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前 Gizmo 工具', {})
], ViewModule.prototype, "gizmo_tool_query", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Gizmo 枢轴模式', {
        pivot: { type: 'string', description: '枢轴模式: center/pivot', required: true },
    })
], ViewModule.prototype, "gizmo_pivot", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前 Gizmo 枢轴模式', {})
], ViewModule.prototype, "gizmo_pivot_query", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Gizmo 坐标系', {
        coordinate: { type: 'string', description: '坐标系: local/global', required: true },
    })
], ViewModule.prototype, "gizmo_coordinate", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前坐标系', {})
], ViewModule.prototype, "gizmo_coordinate_query", null);
__decorate([
    (0, decorators_1.MCPTool)('切换编辑模式 2D/3D', {
        is2D: { type: 'string', description: '"true"=2D 模式, "false"=3D 模式', required: true },
    })
], ViewModule.prototype, "mode_2d_3d", null);
__decorate([
    (0, decorators_1.MCPTool)('查询当前编辑模式（2D/3D）', {})
], ViewModule.prototype, "mode_query", null);
__decorate([
    (0, decorators_1.MCPTool)('显示/隐藏场景网格', {
        visible: { type: 'string', description: '"true"=显示, "false"=隐藏', required: true },
    })
], ViewModule.prototype, "grid_set", null);
__decorate([
    (0, decorators_1.MCPTool)('查询网格是否可见', {})
], ViewModule.prototype, "grid_query", null);
__decorate([
    (0, decorators_1.MCPTool)('将相机聚焦到指定节点', {
        nodes: { type: 'string', description: '节点 UUID（单个）或 JSON 数组字符串', required: true },
    })
], ViewModule.prototype, "camera_focus", null);
__decorate([
    (0, decorators_1.MCPTool)('将选中节点对齐到当前相机视图', {})
], ViewModule.prototype, "camera_align_view", null);
__decorate([
    (0, decorators_1.MCPTool)('将相机对齐到选中节点', {})
], ViewModule.prototype, "camera_align_node", null);
__decorate([
    (0, decorators_1.MCPTool)('获取当前场景视口状态（模式/网格/Gizmo 状态等）', {})
], ViewModule.prototype, "view_status", null);
__decorate([
    (0, decorators_1.MCPTool)('重置场景视口为默认', {})
], ViewModule.prototype, "reset_view", null);
__decorate([
    (0, decorators_1.MCPTool)('添加参考图到场景视图', {
        imageUrl: { type: 'string', description: '图片 URL', required: true },
        name: { type: 'string', description: '参考图名称（可选）' },
    })
], ViewModule.prototype, "ref_add", null);
__decorate([
    (0, decorators_1.MCPTool)('移除指定参考图', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
    })
], ViewModule.prototype, "ref_remove", null);
__decorate([
    (0, decorators_1.MCPTool)('切换活动参考图', {
        index: { type: 'string', description: '参考图索引', required: true },
    })
], ViewModule.prototype, "ref_switch", null);
__decorate([
    (0, decorators_1.MCPTool)('移除所有参考图', {})
], ViewModule.prototype, "ref_clear", null);
__decorate([
    (0, decorators_1.MCPTool)('列出所有参考图', {})
], ViewModule.prototype, "ref_list", null);
__decorate([
    (0, decorators_1.MCPTool)('设置参考图位置', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        x: { type: 'string', description: 'X 位置' },
        y: { type: 'string', description: 'Y 位置' },
    })
], ViewModule.prototype, "ref_position", null);
__decorate([
    (0, decorators_1.MCPTool)('设置参考图缩放', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        scale: { type: 'string', description: '缩放值', required: true },
    })
], ViewModule.prototype, "ref_scale", null);
__decorate([
    (0, decorators_1.MCPTool)('设置参考图透明度', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        opacity: { type: 'string', description: '透明度 0-1', required: true },
    })
], ViewModule.prototype, "ref_opacity", null);
exports.ViewModule = ViewModule = __decorate([
    (0, decorators_1.MCPModule)('view', '视口控制 - Gizmo 工具切换、2D/3D 模式、相机聚焦/对齐、网格、参考图管理')
], ViewModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVmlld01vZHVsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NvdXJjZS9tY3AvbW9kdWxlcy9WaWV3TW9kdWxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7R0FFRzs7Ozs7Ozs7O0FBRUgsOENBQW1EO0FBRW5ELEtBQUssVUFBVSxTQUFTLENBQUMsTUFBYyxFQUFFLEdBQUcsSUFBVztJQUNuRCxJQUFJLENBQUM7UUFDRCxPQUFPLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQ2xFLENBQUM7SUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO1FBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLE1BQU0sU0FBUyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDOUQsQ0FBQztBQUNMLENBQUM7QUFHTSxJQUFNLFVBQVUsR0FBaEIsTUFBTSxVQUFVO0lBRW5CLGtEQUFrRDtJQUs1QyxBQUFOLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBd0I7UUFDckMsT0FBTyxTQUFTLENBQUMsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFHSyxBQUFOLEtBQUssQ0FBQyxnQkFBZ0I7UUFDbEIsT0FBTyxTQUFTLENBQUMsa0JBQWtCLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsV0FBVyxDQUFDLE1BQXlCO1FBQ3ZDLE9BQU8sU0FBUyxDQUFDLGlCQUFpQixFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0RCxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsaUJBQWlCO1FBQ25CLE9BQU8sU0FBUyxDQUFDLG1CQUFtQixDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLGdCQUFnQixDQUFDLE1BQThCO1FBQ2pELE9B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QUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ2hFLENBQUM7MkNBR0Q7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxVQUFVLEVBQUU7UUFDakIsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDbEUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDdEUsQ0FBQzs2Q0FHRDtxQkE5SlEsVUFBVTtJQUR0QixJQUFBLHNCQUFTLEVBQUMsTUFBTSxFQUFFLDZDQUE2QyxDQUFDO0dBQ3BELFVBQVUsQ0ErSnRCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDop4blj6PmjqfliLbmqKHlnZcg4oCUIEdpem1vIOW3peWFt+OAgTJELzNEIOaooeW8j+OAgeebuOacuuaOp+WItuOAgee9keagvOOAgeWbvuagh+OAgeWPguiAg+WbvlxuICovXG5cbmltcG9ydCB7IE1DUE1vZHVsZSwgTUNQVG9vbCB9IGZyb20gJy4uL2RlY29yYXRvcnMnO1xuXG5hc3luYyBmdW5jdGlvbiBjYWxsU2NlbmUobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+a2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5ATUNQTW9kdWxlKCd2aWV3JywgJ+inhuWPo+aOp+WItiAtIEdpem1vIOW3peWFt+WIh+aNouOAgTJELzNEIOaooeW8j+OAgeebuOacuuiBmueEpi/lr7npvZDjgIHnvZHmoLzjgIHlj4LogIPlm77nrqHnkIYnKVxuZXhwb3J0IGNsYXNzIFZpZXdNb2R1bGUge1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0gR2l6bW8gPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCforr7nva7lvZPliY0gR2l6bW8g5Y+Y5o2i5bel5YW3Jywge1xuICAgICAgICB0b29sOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+W3peWFt+WQjTogcG9zaXRpb24vcm90YXRpb24vc2NhbGUvcmVjdCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBnaXptb190b29sKHBhcmFtczogeyB0b29sOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3NldC1naXptby10b29sJywgcGFyYW1zLnRvb2wpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LlvZPliY0gR2l6bW8g5bel5YW3Jywge30pXG4gICAgYXN5bmMgZ2l6bW9fdG9vbF9xdWVyeSgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1naXptby10b29sJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iuvue9riBHaXptbyDmnqLovbTmqKHlvI8nLCB7XG4gICAgICAgIHBpdm90OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aeoui9tOaooeW8jzogY2VudGVyL3Bpdm90JywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGdpem1vX3Bpdm90KHBhcmFtczogeyBwaXZvdDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtZ2l6bW8tcGl2b3QnLCBwYXJhbXMucGl2b3QpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LlvZPliY0gR2l6bW8g5p6i6L205qih5byPJywge30pXG4gICAgYXN5bmMgZ2l6bW9fcGl2b3RfcXVlcnkoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktZ2l6bW8tcGl2b3QnKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6K6+572uIEdpem1vIOWdkOagh+ezuycsIHtcbiAgICAgICAgY29vcmRpbmF0ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflnZDmoIfns7s6IGxvY2FsL2dsb2JhbCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBnaXptb19jb29yZGluYXRlKHBhcmFtczogeyBjb29yZGluYXRlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3NldC1naXptby1jb29yZGluYXRlJywgcGFyYW1zLmNvb3JkaW5hdGUpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LlvZPliY3lnZDmoIfns7snLCB7fSlcbiAgICBhc3luYyBnaXptb19jb29yZGluYXRlX3F1ZXJ5KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWdpem1vLWNvb3JkaW5hdGUnKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSAyRC8zRCDmqKHlvI8gPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfliIfmjaLnvJbovpHmqKHlvI8gMkQvM0QnLCB7XG4gICAgICAgIGlzMkQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnXCJ0cnVlXCI9MkQg5qih5byPLCBcImZhbHNlXCI9M0Qg5qih5byPJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIG1vZGVfMmRfM2QocGFyYW1zOiB7IGlzMkQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnc2V0LTJkLTNkLW1vZGUnLCBwYXJhbXMuaXMyRCA9PT0gJ3RydWUnKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5b2T5YmN57yW6L6R5qih5byP77yIMkQvM0TvvIknLCB7fSlcbiAgICBhc3luYyBtb2RlX3F1ZXJ5KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LTJkLTNkLW1vZGUnKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDnvZHmoLwgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmmL7npLov6ZqQ6JeP5Zy65pmv572R5qC8Jywge1xuICAgICAgICB2aXNpYmxlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ1widHJ1ZVwiPeaYvuekuiwgXCJmYWxzZVwiPemakOiXjycsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBncmlkX3NldChwYXJhbXM6IHsgdmlzaWJsZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtZ3JpZC12aXNpYmxlJywgcGFyYW1zLnZpc2libGUgPT09ICd0cnVlJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivoue9keagvOaYr+WQpuWPr+ingScsIHt9KVxuICAgIGFzeW5jIGdyaWRfcXVlcnkoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktZ3JpZC12aXNpYmxlJyk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g55u45py6ID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5bCG55u45py66IGa54Sm5Yiw5oyH5a6a6IqC54K5Jywge1xuICAgICAgICBub2RlczogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRO+8iOWNleS4qu+8ieaIliBKU09OIOaVsOe7hOWtl+espuS4sicsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBjYW1lcmFfZm9jdXMocGFyYW1zOiB7IG5vZGVzOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGxldCB1dWlkczogc3RyaW5nW107XG4gICAgICAgIHRyeSB7IHV1aWRzID0gSlNPTi5wYXJzZShwYXJhbXMubm9kZXMpOyB9IGNhdGNoIHsgdXVpZHMgPSBbcGFyYW1zLm5vZGVzXTsgfVxuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdmb2N1cy1jYW1lcmEnLCB1dWlkcyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WwhumAieS4reiKgueCueWvuem9kOWIsOW9k+WJjeebuOacuuinhuWbvicsIHt9KVxuICAgIGFzeW5jIGNhbWVyYV9hbGlnbl92aWV3KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2FsaWduLXZpZXctdG8tc2VsZWN0aW9uJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WwhuebuOacuuWvuem9kOWIsOmAieS4reiKgueCuScsIHt9KVxuICAgIGFzeW5jIGNhbWVyYV9hbGlnbl9ub2RlKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2FsaWduLXNlbGVjdGlvbi10by12aWV3Jyk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g6KeG5Y+j54q25oCBID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6I635Y+W5b2T5YmN5Zy65pmv6KeG5Y+j54q25oCB77yI5qih5byPL+e9keagvC9HaXptbyDnirbmgIHnrYnvvIknLCB7fSlcbiAgICBhc3luYyB2aWV3X3N0YXR1cygpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS12aWV3LXN0YXR1cycpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfph43nva7lnLrmma/op4blj6PkuLrpu5jorqQnLCB7fSlcbiAgICBhc3luYyByZXNldF92aWV3KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3Jlc2V0LXZpZXcnKTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDlj4LogIPlm74gPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmt7vliqDlj4LogIPlm77liLDlnLrmma/op4blm74nLCB7XG4gICAgICAgIGltYWdlVXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WbvueJhyBVUkwnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WPguiAg+WbvuWQjeensO+8iOWPr+mAie+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIHJlZl9hZGQocGFyYW1zOiB7IGltYWdlVXJsOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2FkZC1yZWZlcmVuY2UtaW1hZ2UnLCBwYXJhbXMuaW1hZ2VVcmwsIHBhcmFtcy5uYW1lKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn56e76Zmk5oyH5a6a5Y+C6ICD5Zu+Jywge1xuICAgICAgICBpbWFnZUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WPguiAg+WbviBJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyByZWZfcmVtb3ZlKHBhcmFtczogeyBpbWFnZUlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3JlbW92ZS1yZWZlcmVuY2UtaW1hZ2UnLCBwYXJhbXMuaW1hZ2VJZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIh+aNoua0u+WKqOWPguiAg+WbvicsIHtcbiAgICAgICAgaW5kZXg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y+C6ICD5Zu+57Si5byVJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHJlZl9zd2l0Y2gocGFyYW1zOiB7IGluZGV4OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3N3aXRjaC1yZWZlcmVuY2UtaW1hZ2UnLCBwYXJzZUludChwYXJhbXMuaW5kZXgsIDEwKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+enu+mZpOaJgOacieWPguiAg+WbvicsIHt9KVxuICAgIGFzeW5jIHJlZl9jbGVhcigpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdjbGVhci1yZWZlcmVuY2UtaW1hZ2VzJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIl+WHuuaJgOacieWPguiAg+WbvicsIHt9KVxuICAgIGFzeW5jIHJlZl9saXN0KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2xpc3QtcmVmZXJlbmNlLWltYWdlcycpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCforr7nva7lj4LogIPlm77kvY3nva4nLCB7XG4gICAgICAgIGltYWdlSWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y+C6ICD5Zu+IElEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgeDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdYIOS9jee9ricgfSxcbiAgICAgICAgeTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdZIOS9jee9ricgfSxcbiAgICB9KVxuICAgIGFzeW5jIHJlZl9wb3NpdGlvbihwYXJhbXM6IHsgaW1hZ2VJZDogc3RyaW5nOyB4Pzogc3RyaW5nOyB5Pzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtcmVmZXJlbmNlLWltYWdlLXBvc2l0aW9uJywgcGFyYW1zLmltYWdlSWQsIHBhcmFtcy54ID8gcGFyc2VJbnQocGFyYW1zLngsIDEwKSA6IDAsIHBhcmFtcy55ID8gcGFyc2VJbnQocGFyYW1zLnksIDEwKSA6IDApO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCforr7nva7lj4LogIPlm77nvKnmlL4nLCB7XG4gICAgICAgIGltYWdlSWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y+C6ICD5Zu+IElEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgc2NhbGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn57yp5pS+5YC8JywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHJlZl9zY2FsZShwYXJhbXM6IHsgaW1hZ2VJZDogc3RyaW5nOyBzY2FsZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtcmVmZXJlbmNlLWltYWdlLXNjYWxlJywgcGFyYW1zLmltYWdlSWQsIHBhcnNlRmxvYXQocGFyYW1zLnNjYWxlKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iuvue9ruWPguiAg+WbvumAj+aYjuW6picsIHtcbiAgICAgICAgaW1hZ2VJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj4LogIPlm74gSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBvcGFjaXR5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mAj+aYjuW6piAwLTEnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgcmVmX29wYWNpdHkocGFyYW1zOiB7IGltYWdlSWQ6IHN0cmluZzsgb3BhY2l0eTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtcmVmZXJlbmNlLWltYWdlLW9wYWNpdHknLCBwYXJhbXMuaW1hZ2VJZCwgcGFyc2VGbG9hdChwYXJhbXMub3BhY2l0eSkpO1xuICAgIH1cbn1cbiJdfQ==