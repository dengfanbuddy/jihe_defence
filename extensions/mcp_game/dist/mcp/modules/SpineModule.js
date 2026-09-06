"use strict";
/**
 * Spine 骨骼动画模块 — 查询动画/皮肤、播放动画、切换皮肤、设置属性、挂件管理
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpineModule = void 0;
const decorators_1 = require("../decorators");
async function callScene(method, ...args) {
    try {
        return await Editor.Message.request('scene', method, ...args);
    }
    catch (e) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}
let SpineModule = class SpineModule {
    async spine_info(params) {
        return callScene('query-component', params.nodeUuid, 'sp.Skeleton');
    }
    async list_animations(params) {
        return callScene('query-spine-animations', params.nodeUuid);
    }
    async list_skins(params) {
        return callScene('query-spine-skins', params.nodeUuid);
    }
    async set_animation(params) {
        return callScene('set-spine-animation', params.nodeUuid, params.animation, params.loop === 'true', params.track ? parseInt(params.track, 10) : 0);
    }
    async set_skin(params) {
        return callScene('set-spine-skin', params.nodeUuid, params.skin);
    }
    async set_property(params) {
        let val = params.value;
        if (params.property === 'loop')
            val = params.value === 'true';
        else if (params.property === 'timeScale')
            val = parseFloat(params.value);
        else if (params.property === 'color' || params.property === 'debugSlots' || params.property === 'debugBones' || params.property === 'debugMesh') {
            try {
                val = JSON.parse(params.value);
            }
            catch ( /* keep string */_a) { /* keep string */ }
        }
        return callScene('set-spine-property', params.nodeUuid, params.property, val);
    }
    async set_data(params) {
        return callScene('set-spine-data', params.nodeUuid, params.skeletonData);
    }
    async add_socket(params) {
        return callScene('add-spine-socket', params.nodeUuid, params.path, params.target);
    }
    async remove_socket(params) {
        return callScene('remove-spine-socket', params.nodeUuid, params.path);
    }
};
exports.SpineModule = SpineModule;
__decorate([
    (0, decorators_1.MCPTool)('获取 Spine Skeleton 组件信息', {
        nodeUuid: { type: 'string', description: '节点 UUID（含 sp.Skeleton 组件）', required: true },
    })
], SpineModule.prototype, "spine_info", null);
__decorate([
    (0, decorators_1.MCPTool)('列出 Spine 节点的所有可用动画', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
], SpineModule.prototype, "list_animations", null);
__decorate([
    (0, decorators_1.MCPTool)('列出 Spine 节点的所有可用皮肤', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
], SpineModule.prototype, "list_skins", null);
__decorate([
    (0, decorators_1.MCPTool)('播放 Spine 动画', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        animation: { type: 'string', description: '动画名称', required: true },
        loop: { type: 'string', description: '是否循环: "true" 或 "false"（可选，默认 false）' },
        track: { type: 'string', description: '轨道索引（可选，默认 0）' },
    })
], SpineModule.prototype, "set_animation", null);
__decorate([
    (0, decorators_1.MCPTool)('切换 Spine 皮肤', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        skin: { type: 'string', description: '皮肤名称', required: true },
    })
], SpineModule.prototype, "set_skin", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Spine 组件属性（loop/timeScale/premultipliedAlpha/color 等）', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        property: { type: 'string', description: '属性名: loop/timeScale/premultipliedAlpha/defaultCacheMode/color/debugSlots/debugBones/debugMesh', required: true },
        value: { type: 'string', description: '属性值', required: true },
    })
], SpineModule.prototype, "set_property", null);
__decorate([
    (0, decorators_1.MCPTool)('替换 Spine 骨骼数据资源', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        skeletonData: { type: 'string', description: '新骨骼数据资源路径（db://...）或 UUID', required: true },
    })
], SpineModule.prototype, "set_data", null);
__decorate([
    (0, decorators_1.MCPTool)('在 Spine 骨骼上添加挂件节点', {
        nodeUuid: { type: 'string', description: '节点 UUID（含 sp.Skeleton）', required: true },
        path: { type: 'string', description: '骨骼路径（bone name）', required: true },
        target: { type: 'string', description: '要挂载的目标节点 UUID', required: true },
    })
], SpineModule.prototype, "add_socket", null);
__decorate([
    (0, decorators_1.MCPTool)('从 Spine 骨骼移除挂件节点', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        path: { type: 'string', description: '骨骼路径', required: true },
    })
], SpineModule.prototype, "remove_socket", null);
exports.SpineModule = SpineModule = __decorate([
    (0, decorators_1.MCPModule)('spine', 'Spine 骨骼动画 - 查询动画列表/皮肤列表、播放动画、切换皮肤、设置属性、挂件管理')
], SpineModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3BpbmVNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvU3BpbmVNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOztHQUVHOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFFbkQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ25ELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDbEUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUdNLElBQU0sV0FBVyxHQUFqQixNQUFNLFdBQVc7SUFLZCxBQUFOLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBNEI7UUFDekMsT0FBTyxTQUFTLENBQUMsaUJBQWlCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxhQUFhLENBQUMsQ0FBQztJQUN4RSxDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsZUFBZSxDQUFDLE1BQTRCO1FBQzlDLE9BQU8sU0FBUyxDQUFDLHdCQUF3QixFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNoRSxDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsVUFBVSxDQUFDLE1BQTRCO1FBQ3pDLE9BQU8sU0FBUyxDQUFDLG1CQUFtQixFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBUUssQUFBTixLQUFLLENBQUMsYUFBYSxDQUFDLE1BQThFO1FBQzlGLE9BQU8sU0FBUyxDQUFDLHFCQUFxQixFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxD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LEVBQUU7UUFDcEUsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsMkJBQTJCLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUM3RixDQUFDOzJDQUdEO0FBT0s7SUFMTCxJQUFBLG9CQUFPLEVBQUMsbUJBQW1CLEVBQUU7UUFDMUIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsd0JBQXdCLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNuRixJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxpQkFBaUIsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3hFLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQzNFLENBQUM7NkNBR0Q7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxrQkFBa0IsRUFBRTtRQUN6QixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNwRSxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNoRSxDQUFDO2dEQUdEO3NCQS9FUSxXQUFXO0lBRHZCLElBQUEsc0JBQVMsRUFBQyxPQUFPLEVBQUUsOENBQThDLENBQUM7R0FDdEQsV0FBVyxDQWdGdkIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNwaW5lIOmqqOmqvOWKqOeUu+aooeWdlyDigJQg5p+l6K+i5Yqo55S7L+earuiCpOOAgeaSreaUvuWKqOeUu+OAgeWIh+aNouearuiCpOOAgeiuvue9ruWxnuaAp+OAgeaMguS7tueuoeeQhlxuICovXG5cbmltcG9ydCB7IE1DUE1vZHVsZSwgTUNQVG9vbCB9IGZyb20gJy4uL2RlY29yYXRvcnMnO1xuXG5hc3luYyBmdW5jdGlvbiBjYWxsU2NlbmUobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+a2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5ATUNQTW9kdWxlKCdzcGluZScsICdTcGluZSDpqqjpqrzliqjnlLsgLSDmn6Xor6LliqjnlLvliJfooagv55qu6IKk5YiX6KGo44CB5pKt5pS+5Yqo55S744CB5YiH5o2i55qu6IKk44CB6K6+572u5bGe5oCn44CB5oyC5Lu2566h55CGJylcbmV4cG9ydCBjbGFzcyBTcGluZU1vZHVsZSB7XG5cbiAgICBATUNQVG9vbCgn6I635Y+WIFNwaW5lIFNrZWxldG9uIOe7hOS7tuS/oeaBrycsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUTvvIjlkKsgc3AuU2tlbGV0b24g57uE5Lu277yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNwaW5lX2luZm8ocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWNvbXBvbmVudCcsIHBhcmFtcy5ub2RlVXVpZCwgJ3NwLlNrZWxldG9uJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIl+WHuiBTcGluZSDoioLngrnnmoTmiYDmnInlj6/nlKjliqjnlLsnLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGxpc3RfYW5pbWF0aW9ucyhwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktc3BpbmUtYW5pbWF0aW9ucycsIHBhcmFtcy5ub2RlVXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIl+WHuiBTcGluZSDoioLngrnnmoTmiYDmnInlj6/nlKjnmq7ogqQnLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGxpc3Rfc2tpbnMocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LXNwaW5lLXNraW5zJywgcGFyYW1zLm5vZGVVdWlkKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5pKt5pS+IFNwaW5lIOWKqOeUuycsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBhbmltYXRpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S75ZCN56ewJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgbG9vcDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmmK/lkKblvqrnjq86IFwidHJ1ZVwiIOaIliBcImZhbHNlXCLvvIjlj6/pgInvvIzpu5jorqQgZmFsc2XvvIknIH0sXG4gICAgICAgIHRyYWNrOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i9qOmBk+e0ouW8le+8iOWPr+mAie+8jOm7mOiupCAw77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgc2V0X2FuaW1hdGlvbihwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgYW5pbWF0aW9uOiBzdHJpbmc7IGxvb3A/OiBzdHJpbmc7IHRyYWNrPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdzZXQtc3BpbmUtYW5pbWF0aW9uJywgcGFyYW1zLm5vZGVVdWlkLCBwYXJhbXMuYW5pbWF0aW9uLCBwYXJhbXMubG9vcCA9PT0gJ3RydWUnLCBwYXJhbXMudHJhY2sgPyBwYXJzZUludChwYXJhbXMudHJhY2ssIDEwKSA6IDApO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliIfmjaIgU3BpbmUg55qu6IKkJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHNraW46IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55qu6IKk5ZCN56ewJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNldF9za2luKHBhcmFtczogeyBub2RlVXVpZDogc3RyaW5nOyBza2luOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3NldC1zcGluZS1za2luJywgcGFyYW1zLm5vZGVVdWlkLCBwYXJhbXMuc2tpbik7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+iuvue9riBTcGluZSDnu4Tku7blsZ7mgKfvvIhsb29wL3RpbWVTY2FsZS9wcmVtdWx0aXBsaWVkQWxwaGEvY29sb3Ig562J77yJJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHByb3BlcnR5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WQjTogbG9vcC90aW1lU2NhbGUvcHJlbXVsdGlwbGllZEFscGhhL2RlZmF1bHRDYWNoZU1vZGUvY29sb3IvZGVidWdTbG90cy9kZWJ1Z0JvbmVzL2RlYnVnTWVzaCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHZhbHVlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WAvCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfcHJvcGVydHkocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IHByb3BlcnR5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGxldCB2YWw6IGFueSA9IHBhcmFtcy52YWx1ZTtcbiAgICAgICAgaWYgKHBhcmFtcy5wcm9wZXJ0eSA9PT0gJ2xvb3AnKSB2YWwgPSBwYXJhbXMudmFsdWUgPT09ICd0cnVlJztcbiAgICAgICAgZWxzZSBpZiAocGFyYW1zLnByb3BlcnR5ID09PSAndGltZVNjYWxlJykgdmFsID0gcGFyc2VGbG9hdChwYXJhbXMudmFsdWUpO1xuICAgICAgICBlbHNlIGlmIChwYXJhbXMucHJvcGVydHkgPT09ICdjb2xvcicgfHwgcGFyYW1zLnByb3BlcnR5ID09PSAnZGVidWdTbG90cycgfHwgcGFyYW1zLnByb3BlcnR5ID09PSAnZGVidWdCb25lcycgfHwgcGFyYW1zLnByb3BlcnR5ID09PSAnZGVidWdNZXNoJykge1xuICAgICAgICAgICAgdHJ5IHsgdmFsID0gSlNPTi5wYXJzZShwYXJhbXMudmFsdWUpOyB9IGNhdGNoIHsgLyoga2VlcCBzdHJpbmcgKi8gfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3NldC1zcGluZS1wcm9wZXJ0eScsIHBhcmFtcy5ub2RlVXVpZCwgcGFyYW1zLnByb3BlcnR5LCB2YWwpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmm7/mjaIgU3BpbmUg6aqo6aq85pWw5o2u6LWE5rqQJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHNrZWxldG9uRGF0YTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlrDpqqjpqrzmlbDmja7otYTmupDot6/lvoTvvIhkYjovLy4uLu+8ieaIliBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNldF9kYXRhKHBhcmFtczogeyBub2RlVXVpZDogc3RyaW5nOyBza2VsZXRvbkRhdGE6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnc2V0LXNwaW5lLWRhdGEnLCBwYXJhbXMubm9kZVV1aWQsIHBhcmFtcy5za2VsZXRvbkRhdGEpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCflnKggU3BpbmUg6aqo6aq85LiK5re75Yqg5oyC5Lu26IqC54K5Jywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRO+8iOWQqyBzcC5Ta2VsZXRvbu+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aqo6aq86Lev5b6E77yIYm9uZSBuYW1l77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgdGFyZ2V0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+imgeaMgui9veeahOebruagh+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGFkZF9zb2NrZXQocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgdGFyZ2V0OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2FkZC1zcGluZS1zb2NrZXQnLCBwYXJhbXMubm9kZVV1aWQsIHBhcmFtcy5wYXRoLCBwYXJhbXMudGFyZ2V0KTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5LuOIFNwaW5lIOmqqOmqvOenu+mZpOaMguS7tuiKgueCuScsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mqqOmqvOi3r+W+hCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyByZW1vdmVfc29ja2V0KHBhcmFtczogeyBub2RlVXVpZDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3JlbW92ZS1zcGluZS1zb2NrZXQnLCBwYXJhbXMubm9kZVV1aWQsIHBhcmFtcy5wYXRoKTtcbiAgICB9XG59XG4iXX0=