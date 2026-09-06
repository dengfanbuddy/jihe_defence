"use strict";
/**
 * 动画模块 — 动画片段查询、关键帧操作、帧事件、动画预设
 *
 * 依赖 Cocos Creator Animation 编辑器 API。
 * 使用前需先在编辑器中打开 Animation 面板。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnimationModule = void 0;
const decorators_1 = require("../decorators");
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
let AnimationModule = class AnimationModule {
    // ==================== 查询 ====================
    async query_edit_info() {
        return callScene('query-animation-edit-info');
    }
    async query_clips_info(params) {
        return callScene('query-animation-clips', params === null || params === void 0 ? void 0 : params.nodeUuid);
    }
    async query_clip_dump(params) {
        return callScene('query-animation-clip-dump', params.clipUuid);
    }
    async query_properties(params) {
        return callScene('query-animation-properties', params === null || params === void 0 ? void 0 : params.nodeUuid);
    }
    async query_clip(params) {
        return callScene('query-animation-clip', params.clipUuid);
    }
    async query_value_at_frame(params) {
        return callScene('query-animation-value-at-frame', params.clipUuid, params.nodePath, params.propKey, parseInt(params.frame, 10));
    }
    async preset_list() {
        const presets = [
            { name: 'fade_in', category: 'basic', description: '淡入' },
            { name: 'fade_out', category: 'basic', description: '淡出' },
            { name: 'scale_bounce', category: 'popup', description: '弹跳放大' },
            { name: 'scale_close', category: 'popup', description: '缩小消失' },
            { name: 'slide_in_bottom', category: 'slide', description: '从底部滑入' },
            { name: 'slide_in_right', category: 'slide', description: '从右侧滑入' },
            { name: 'shake', category: 'effect', description: '抖动' },
            { name: 'pulse', category: 'loop', description: '脉动呼吸' },
            { name: 'float', category: 'loop', description: '上下浮动' },
            { name: 'typewriter', category: 'text', description: '打字机' },
            { name: 'number_roll', category: 'text', description: '数字滚动' },
            { name: 'flip_card', category: 'effect', description: '卡片翻转' },
            { name: 'combo_sequence', category: 'sequence', description: '级联入场' },
        ];
        return { presets };
    }
    async preset(params) {
        // 使用 Editor API 创建预设
        const args = { preset: params.preset, clipUuid: params.clipUuid };
        if (params.node)
            args.node = params.node;
        if (params.duration)
            args.duration = parseInt(params.duration, 10);
        if (params.startValue)
            args.startValue = JSON.parse(params.startValue);
        if (params.endValue)
            args.endValue = JSON.parse(params.endValue);
        if (params.distance)
            args.distance = parseInt(params.distance, 10);
        if (params.direction)
            args.direction = params.direction;
        if (params.count)
            args.count = parseInt(params.count, 10);
        if (params.intensity)
            args.intensity = parseInt(params.intensity, 10);
        args.writeMode = params.writeMode || 'file';
        return callScene('apply-animation-preset', args);
    }
    // ==================== 生命周期 ====================
    async enter_edit(params) {
        return callScene('enter-animation-edit-mode', params === null || params === void 0 ? void 0 : params.clipUuid);
    }
    async exit_edit() {
        return callScene('exit-animation-edit-mode');
    }
    async play() {
        return callScene('play-animation');
    }
    async pause() {
        return callScene('pause-animation');
    }
    async stop() {
        return callScene('stop-animation');
    }
    async resume() {
        return callScene('resume-animation');
    }
    async create_clip(params) {
        const uuid = await callAssetDB('uuid-to-url', params.url);
        // 通过 asset-db 创建空 .anim 文件
        const result = await callAssetDB('create-asset', params.url, 'cc.AnimationClip', {});
        return { message: `动画片段已创建: ${params.url}`, uuid: result === null || result === void 0 ? void 0 : result.uuid };
    }
    async save_clip(params) {
        return callScene('save-animation-clip', params === null || params === void 0 ? void 0 : params.clipUuid);
    }
    // ==================== 属性轨道 ====================
    async create_prop(params) {
        return callScene('create-animation-prop', params.nodePath, params.propKey);
    }
    async remove_prop(params) {
        return callScene('remove-animation-prop', params.nodePath, params.propKey);
    }
    // ==================== 关键帧 ====================
    async create_key(params) {
        return callScene('create-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10), JSON.parse(params.value));
    }
    async update_key(params) {
        return callScene('update-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10), JSON.parse(params.value));
    }
    async remove_key(params) {
        return callScene('remove-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10));
    }
    async move_keys(params) {
        return callScene('move-animation-keys', params.nodePath, params.propKey, parseInt(params.frame, 10), parseInt(params.target, 10));
    }
    async clear_keys(params) {
        return callScene('clear-animation-keys', params.nodePath, params.propKey);
    }
    // ==================== 帧事件 ====================
    async add_event(params) {
        const eventData = { func: params.func };
        if (params.params)
            eventData.params = JSON.parse(params.params);
        return callScene('add-animation-event', parseInt(params.frame, 10), eventData);
    }
    async delete_event(params) {
        return callScene('delete-animation-event', parseInt(params.frame, 10));
    }
    async update_event(params) {
        const eventData = { func: params.func };
        if (params.params)
            eventData.params = JSON.parse(params.params);
        return callScene('update-animation-event', parseInt(params.frame, 10), eventData);
    }
    async batch_events(params) {
        const events = JSON.parse(params.events);
        const results = [];
        for (const evt of events) {
            const result = await callScene('add-animation-event', evt.frame, { func: evt.func, params: evt.params || [] });
            results.push(result);
        }
        return { message: `已添加 ${results.length} 个事件`, results };
    }
    // ==================== 片段属性 ====================
    async change_sample(params) {
        return callScene('change-animation-sample', params.clipUuid, parseInt(params.sample, 10));
    }
    async change_speed(params) {
        return callScene('change-animation-speed', params.clipUuid, parseFloat(params.speed));
    }
    async change_wrap_mode(params) {
        return callScene('change-animation-wrap-mode', params.clipUuid, parseInt(params.wrapMode, 10));
    }
    // ==================== 批量操作 ====================
    async batch(params) {
        const data = JSON.parse(params.data);
        const args = { clipUuid: params.clipUuid, data };
        if (params.node)
            args.node = params.node;
        args.writeMode = params.writeMode || 'file';
        return callScene('batch-animation', args);
    }
    // ==================== 节点操作 ====================
    async remove_node(params) {
        return callScene('remove-animation-node', params.nodePath);
    }
    async change_node_path(params) {
        return callScene('change-animation-node-path', params.oldPath, params.newPath);
    }
};
exports.AnimationModule = AnimationModule;
__decorate([
    (0, decorators_1.MCPTool)('查询当前动画编辑状态（使用的片段 UUID 等）。在操作动画前调用此方法确认编辑状态', {})
], AnimationModule.prototype, "query_edit_info", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定节点上的所有动画片段列表', {
        nodeUuid: { type: 'string', description: '节点 UUID（包含 Animation 组件）' },
    })
], AnimationModule.prototype, "query_clips_info", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定动画片段的完整数据（轨道/关键帧/事件等）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
    })
], AnimationModule.prototype, "query_clip_dump", null);
__decorate([
    (0, decorators_1.MCPTool)('查询节点的可动画属性列表', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
], AnimationModule.prototype, "query_properties", null);
__decorate([
    (0, decorators_1.MCPTool)('查询动画片段属性（采样率/速度/循环模式等）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
    })
], AnimationModule.prototype, "query_clip", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定帧上的属性值', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        nodePath: { type: 'string', description: '节点路径' },
        propKey: { type: 'string', description: '属性键（如 position, scale）' },
        frame: { type: 'string', description: '帧索引', required: true },
    })
], AnimationModule.prototype, "query_value_at_frame", null);
__decorate([
    (0, decorators_1.MCPTool)('查询所有可用的动画预设列表', {})
], AnimationModule.prototype, "preset_list", null);
__decorate([
    (0, decorators_1.MCPTool)('创建动画预设。writeMode="file" 直接写入 .anim 文件（推荐，无需动画编辑模式）', {
        preset: { type: 'string', description: '预设名', required: true },
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        node: { type: 'string', description: '目标节点名或路径' },
        duration: { type: 'string', description: '时长（帧数），默认 30' },
        startValue: { type: 'string', description: '起始值 JSON（可选）' },
        endValue: { type: 'string', description: '结束值 JSON（可选）' },
        distance: { type: 'string', description: '移动距离（slide/float），默认 500' },
        direction: { type: 'string', description: '方向（slide: left/right/top/bottom）' },
        count: { type: 'string', description: '重复次数（shake 默认 3）' },
        intensity: { type: 'string', description: '强度（shake 默认 10）' },
        writeMode: { type: 'string', description: '写入模式: "api" 或 "file"（推荐 file）' },
    })
], AnimationModule.prototype, "preset", null);
__decorate([
    (0, decorators_1.MCPTool)('进入动画编辑模式', {
        clipUuid: { type: 'string', description: '动画片段 UUID（可选）' },
    })
], AnimationModule.prototype, "enter_edit", null);
__decorate([
    (0, decorators_1.MCPTool)('退出动画编辑模式', {})
], AnimationModule.prototype, "exit_edit", null);
__decorate([
    (0, decorators_1.MCPTool)('播放当前动画片段', {})
], AnimationModule.prototype, "play", null);
__decorate([
    (0, decorators_1.MCPTool)('暂停播放', {})
], AnimationModule.prototype, "pause", null);
__decorate([
    (0, decorators_1.MCPTool)('停止播放', {})
], AnimationModule.prototype, "stop", null);
__decorate([
    (0, decorators_1.MCPTool)('恢复播放', {})
], AnimationModule.prototype, "resume", null);
__decorate([
    (0, decorators_1.MCPTool)('创建新的空动画片段', {
        url: { type: 'string', description: '保存路径（如 db://assets/animations/MyClip.anim）' },
        clipName: { type: 'string', description: '片段名称' },
    })
], AnimationModule.prototype, "create_clip", null);
__decorate([
    (0, decorators_1.MCPTool)('保存当前动画片段到磁盘', {
        clipUuid: { type: 'string', description: '动画片段 UUID' },
    })
], AnimationModule.prototype, "save_clip", null);
__decorate([
    (0, decorators_1.MCPTool)('在节点上创建动画属性轨道', {
        nodePath: { type: 'string', description: '节点路径（如 /Canvas/MyNode）', required: true },
        propKey: { type: 'string', description: '属性键（如 position, scale, rotation, cc.Sprite.spriteFrame）', required: true },
    })
], AnimationModule.prototype, "create_prop", null);
__decorate([
    (0, decorators_1.MCPTool)('删除节点上的动画属性轨道', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
    })
], AnimationModule.prototype, "remove_prop", null);
__decorate([
    (0, decorators_1.MCPTool)('在指定帧创建关键帧', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
        value: { type: 'string', description: '属性值 JSON（如 {"x":100,"y":200,"z":0}）', required: true },
    })
], AnimationModule.prototype, "create_key", null);
__decorate([
    (0, decorators_1.MCPTool)('更新关键帧（修改值）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
        value: { type: 'string', description: '新属性值 JSON', required: true },
    })
], AnimationModule.prototype, "update_key", null);
__decorate([
    (0, decorators_1.MCPTool)('删除指定帧的关键帧', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
    })
], AnimationModule.prototype, "remove_key", null);
__decorate([
    (0, decorators_1.MCPTool)('移动关键帧位置（偏移）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '源帧索引', required: true },
        target: { type: 'string', description: '目标帧索引', required: true },
    })
], AnimationModule.prototype, "move_keys", null);
__decorate([
    (0, decorators_1.MCPTool)('清空指定轨道上的所有关键帧（保留轨道）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
    })
], AnimationModule.prototype, "clear_keys", null);
__decorate([
    (0, decorators_1.MCPTool)('在指定帧添加动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
        func: { type: 'string', description: '回调函数名', required: true },
        params: { type: 'string', description: '参数列表 JSON 数组（可选）' },
    })
], AnimationModule.prototype, "add_event", null);
__decorate([
    (0, decorators_1.MCPTool)('删除指定帧上的所有动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
    })
], AnimationModule.prototype, "delete_event", null);
__decorate([
    (0, decorators_1.MCPTool)('更新指定帧的动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
        func: { type: 'string', description: '新的回调函数名', required: true },
        params: { type: 'string', description: '新的参数列表 JSON 数组（可选）' },
    })
], AnimationModule.prototype, "update_event", null);
__decorate([
    (0, decorators_1.MCPTool)('批量添加动画事件', {
        events: { type: 'string', description: '事件数组 JSON: [{"frame":0,"func":"onStart","params":[]}]', required: true },
    })
], AnimationModule.prototype, "batch_events", null);
__decorate([
    (0, decorators_1.MCPTool)('修改动画片段的采样率（fps）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        sample: { type: 'string', description: '采样率（如 24, 30, 60）', required: true },
    })
], AnimationModule.prototype, "change_sample", null);
__decorate([
    (0, decorators_1.MCPTool)('修改动画片段的播放速度', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        speed: { type: 'string', description: '播放速度（如 1.0）', required: true },
    })
], AnimationModule.prototype, "change_speed", null);
__decorate([
    (0, decorators_1.MCPTool)('修改动画片段的循环模式', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        wrapMode: { type: 'string', description: '循环模式: 0=Default, 1=Normal, 2=Loop, 36=PingPong' },
    })
], AnimationModule.prototype, "change_wrap_mode", null);
__decorate([
    (0, decorators_1.MCPTool)('批量创建动画关键帧（一次调用包含完整属性轨道和关键帧）。推荐使用 writeMode:"file" 直接写入 .anim 文件', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        node: { type: 'string', description: '节点名或路径' },
        data: { type: 'string', description: '动画数据 JSON（含 tracks/keyframes/events）', required: true },
        writeMode: { type: 'string', description: '写入模式: "api" 或 "file"（推荐 file）' },
    })
], AnimationModule.prototype, "batch", null);
__decorate([
    (0, decorators_1.MCPTool)('删除指定节点的所有动画数据（轨道/关键帧）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
    })
], AnimationModule.prototype, "remove_node", null);
__decorate([
    (0, decorators_1.MCPTool)('将动画数据从一个节点路径迁移到另一个', {
        oldPath: { type: 'string', description: '旧节点路径', required: true },
        newPath: { type: 'string', description: '新节点路径', required: true },
    })
], AnimationModule.prototype, "change_node_path", null);
exports.AnimationModule = AnimationModule = __decorate([
    (0, decorators_1.MCPModule)('animation', '动画编辑 - 动画片段/关键帧/事件/预设管理，支持批量操作和文件直接写入')
], AnimationModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQW5pbWF0aW9uTW9kdWxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc291cmNlL21jcC9tb2R1bGVzL0FuaW1hdGlvbk1vZHVsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7Ozs7Ozs7OztBQUVILDhDQUFtRDtBQUVuRCxLQUFLLFVBQVUsU0FBUyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxNQUFjLEVBQUUsR0FBRyxJQUFXO0lBQ3JELElBQUksQ0FBQztRQUNELE9BQU8sTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDckUsQ0FBQztJQUFDLE9BQU8sQ0FBTSxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsTUFBTSxTQUFTLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0FBQ0wsQ0FBQztBQUdNLElBQU0sZUFBZSxHQUFyQixNQUFNLGVBQWU7SUFFeEIsK0NBQStDO0lBR3pDLEFBQU4sS0FBSyxDQUFDLGVBQWU7UUFDakIsT0FBTyxTQUFTLENBQUMsMkJBQTJCLENBQUMsQ0FBQztJQUNsRCxDQUFDO0lBS0ssQUFBTixLQUFLLENBQUMsZ0JBQWdCLENBQUMsTUFBOEI7UUFDakQsT0FBTyxTQUFTLENBQUMsdUJBQXVCLEVBQUUsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxlQUFlLENBQUMsTUFBNEI7UUFDOUMsT0FBTyxTQUFTLENBQUMsMkJBQTJCLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ25FLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxNQUE4QjtRQUNqRCxPQUFPLFNBQVMsQ0FBQyw0QkFBNEIsRUFBRSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsUUFBUSxDQUFDLENBQUM7SUFDckUsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUE0QjtRQUN6QyxPQUFPLFNBQVMsQ0FBQyxzQkFBc0IsRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDOUQsQ0FBQztJQVFLLEFBQU4sS0FBSyxDQUFDLG9CQUFvQixDQUFDLE1BQWdGO1FBQ3ZHLE9BQU8sU0FBUyxDQUFDLGdDQUFnQyxFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDckksQ0FBQztJQUdLLEFBQU4sS0FBSyxDQUFDLFdBQVc7UUFDYixNQUFNLE9BQU8sR0FBRztZQUNaLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUU7WUFDekQsRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtZQUMxRCxFQUFFLElBQUksRUFBRSxjQUFjLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFO1lBQ2hFLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUU7WUFDL0QsRUFBRSxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFO1lBQ3BFLEVBQUUsSUFBSSxFQUFFLGdCQUFnQixFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRTtZQUNuRSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFO1lBQ3hELEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUU7WUFDeEQsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRTtZQUN4RCxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFO1lBQzVELEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUU7WUFDOUQsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRTtZQUM5RCxFQUFFLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxRQUFRLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUU7U0FDeEUsQ0FBQztRQUNGLE9BQU8sRUFBRSxPQUFPLEVBQUUsQ0FBQztJQUN2QixDQUFDO0lBZUssQUFBTixLQUFLLENBQUMsTUFBTSxDQUFDLE1BWVo7UUFDRyxxQkFBcUI7UUFDckIsTUFBTSxJQUFJLEdBQVEsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ3ZFLElBQUksTUFBTSxDQUFDLElBQUk7WUFBRSxJQUFJLENBQUMsSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUM7UUFDekMsSUFBSSxNQUFNLENBQUMsUUFBUTtZQUFFLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDbkUsSUFBSSxNQUFNLENBQUMsVUFBVTtZQUFFLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDdkUsSUFBSSxNQUFNLENBQUMsUUFBUTtZQUFFLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDakUsSUFBSSxNQUFNLENBQUMsUUFBUTtZQUFFLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDbkUsSUFBSSxNQUFNLENBQUMsU0FBUztZQUFFLElBQUksQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQztRQUN4RCxJQUFJLE1BQU0sQ0FBQyxLQUFLO1lBQUUsSUFBSSxDQUFDLEtBQUssR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUMxRCxJQUFJLE1BQU0sQ0FBQyxTQUFTO1lBQUUsSUFBSSxDQUFDLFNBQVMsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUN0RSxJQUFJLENBQUMsU0FBUyxHQUFHLE1BQU0sQ0FBQyxTQUFTLElBQUksTUFBTSxDQUFDO1FBRTVDLE9BQU8sU0FBUyxDQUFDLHdCQUF3QixFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ3JELENBQUM7SUFFRCxpREFBaUQ7SUFLM0MsQUFBTixLQUFLLENBQUMsVUFBVSxDQUFDLE1BQThCO1FBQzNDLE9BQU8sU0FBUyxDQUFDLDJCQUEyQixFQUFFLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxRQUFRLENBQUMsQ0FBQztJQUNwRSxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsU0FBUztRQUNYLE9BQU8sU0FBUyxDQUFDLDBCQUEwQixDQUFDLENBQUM7SUFDakQsQ0FBQztJQUdLLEFBQU4sS0FBSyxDQUFDLElBQUk7UUFDTixPQUFPLFNBQVMsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3ZDLENBQUM7SUFHSyxBQUFOLEtBQUssQ0FBQyxLQUFLO1FBQ1AsT0FBTyxTQUFTLENBQUMsaUJBQWlCLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBR0ssQUFBTixLQUFLLENBQUMsSUFBSTtRQUNOLE9BQU8sU0FBUyxDQUFDLGdCQUFnQixDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUdLLEFBQU4sS0FBSyxDQUFDLE1BQU07UUFDUixPQUFPLFNBQVMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFNSyxBQUFOLEtBQUssQ0FBQyxXQUFXLENBQUMsTUFBMEM7UUFDeEQsTUFBTSxJQUFJLEdBQUcsTUFBTSxXQUFXLENBQUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMxRCwyQkFBMkI7UUFDM0IsTUFBTSxNQUFNLEdBQUcsTUFBTSxXQUFXLENBQUMsY0FBYyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUUsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDckYsT0FBTyxFQUFFLE9BQU8sRUFBRSxZQUFZLE1BQU0sQ0FBQyxHQUFHLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLElBQUksRUFBRSxDQUFDO0lBQ3JFLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxTQUFTLENBQUMsTUFBOEI7UUFDMUMsT0FBTyxTQUFTLENBQUMscUJBQXFCLEVBQUUsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQzlELENBQUM7SUFFRCxpREFBaUQ7SUFNM0MsQUFBTixLQUFLLENBQUMsV0FBVyxDQUFDLE1BQTZDO1FBQzNELE9BQU8sU0FBUyxDQUFDLHVCQUF1QixFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQy9FLENBQUM7SUFNSyxBQUFOLEtBQUssQ0FBQyxXQUFXLENBQUMsTUFBNkM7UUFDM0QsT0FBTyxTQUFTLENBQUMsdUJBQXVCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDL0UsQ0FBQztJQUVELGdEQUFnRDtJQVExQyxBQUFOLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBMkU7UUFDeEYsT0FBTyxTQUFTLENBQUMsc0JBQXNCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDcEksQ0FBQztJQVFLLEFBQU4sS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUEyRTtRQUN4RixPQUFPLFNBQVMsQ0FBQyxzQkFBc0IsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsUUFBUSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUNwSSxDQUFDO0lBT0ssQUFBTixLQUFLLENBQUMsVUFBVSxDQUFDLE1BQTREO1FBQ3pFLE9BQU8sU0FBUyxDQUFDLHNCQUFzQixFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQzFHLENBQUM7SUFRSyxBQUFOLEtBQUssQ0FBQyxTQUFTLENBQUMsTUFBNEU7UUFDeEYsT0FBTyxTQUFTLENBQUMscUJBQXFCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDdEksQ0FBQztJQU1LLEFBQU4sS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUE2QztRQUMxRCxPQUFPLFNBQVMsQ0FBQyxzQkFBc0IsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5RSxDQUFDO0lBRUQsZ0RBQWdEO0lBTzFDLEFBQU4sS0FBSyxDQUFDLFNBQVMsQ0FBQyxNQUF3RDtRQUNwRSxNQUFNLFNBQVMsR0FBUSxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDN0MsSUFBSSxNQUFNLENBQUMsTUFBTTtZQUFFLFNBQVMsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDaEUsT0FBTyxTQUFTLENBQUMscUJBQXFCLEVBQUUsUUFBUSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDbkYsQ0FBQztJQUtLLEFBQU4sS0FBSyxDQUFDLFlBQVksQ0FBQyxNQUF5QjtRQUN4QyxPQUFPLFNBQVMsQ0FBQyx3QkFBd0IsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQzNFLENBQUM7SUFPSyxBQUFOLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFBd0Q7UUFDdkUsTUFBTSxTQUFTLEdBQVEsRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQzdDLElBQUksTUFBTSxDQUFDLE1BQU07WUFBRSxTQUFTLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ2hFLE9BQU8sU0FBUyxDQUFDLHdCQUF3QixFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7SUFLSyxBQUFOLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFBMEI7UUFDekMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDekMsTUFBTSxPQUFPLEdBQVUsRUFBRSxDQUFDO1FBQzFCLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxFQUFFLENBQUM7WUFDdkIsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMscUJBQXFCLEVBQUUsR0FBRyxDQUFDLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDL0csT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN6QixDQUFDO1FBQ0QsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLE9BQU8sQ0FBQyxNQUFNLE1BQU0sRUFBRSxPQUFPLEVBQUUsQ0FBQztJQUM3RCxDQUFDO0lBRUQsaURBQWlEO0lBTTNDLEFBQU4sS0FBSyxDQUFDLGFBQWEsQ0FBQyxNQUE0QztRQUM1RCxPQUFPLFNBQVMsQ0FBQyx5QkFBeUIsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDOUYsQ0FBQztJQU1LLEFBQU4sS0FBSyxDQUFDLFlBQVksQ0FBQyxNQUEyQztRQUMxRCxPQUFPLFNBQVMsQ0FBQyx3QkFBd0IsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLFVBQVUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUMxRixDQUFDO0lBTUssQUFBTixLQUFLLENBQUMsZ0JBQWdCLENBQUMsTUFBOEM7UUFDakUsT0FBTyxTQUFTLENBQUMsNEJBQTRCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ25HLENBQUM7SUFFRCxpREFBaUQ7SUFRM0MsQUFBTixLQUFLLENBQUMsS0FBSyxDQUFDLE1BQTZFO1FBQ3JGLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sSUFBSSxHQUFRLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDdEQsSUFBSSxNQUFNLENBQUMsSUFBSTtZQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQztRQUN6QyxJQUFJLENBQUMsU0FBUyxHQUFHLE1BQU0sQ0FBQyxTQUFTLElBQUksTUFBTSxDQUFDO1FBQzVDLE9BQU8sU0FBUyxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFFRCxpREFBaUQ7SUFLM0MsQUFBTixLQUFLLENBQUMsV0FBVyxDQUFDLE1BQTRCO1FBQzFDLE9BQU8sU0FBUyxDQUFDLHVCQUF1QixFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUMvRCxDQUFDO0lBTUssQUFBTixLQUFLLENBQUMsZ0JBQWdCLENBQUMsTUFBNEM7UUFDL0QsT0FBTyxTQUFTLENBQUMsNEJBQTRCLEVBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbkYsQ0FBQztDQUNKLENBQUE7QUF6VVksMENBQWU7QUFLbEI7SUFETCxJQUFBLG9CQUFPLEVBQUMsNENBQTRDLEVBQUUsRUFBRSxDQUFDO3NEQUd6RDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLGtCQUFrQixFQUFFO1FBQ3pCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLDBCQUEwQixFQUFFO0tBQ3hFLENBQUM7dURBR0Q7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQywyQkFBMkIsRUFBRTtRQUNsQyxRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUN6RSxDQUFDO3NEQUdEO0FBS0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsY0FBYyxFQUFFO1FBQ3JCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ3ZFLENBQUM7dURBR0Q7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyx3QkFBd0IsRUFBRTtRQUMvQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUN6RSxDQUFDO2lEQUdEO0FBUUs7SUFOTCxJQUFBLG9CQUFPLEVBQUMsWUFBWSxFQUFFO1FBQ25CLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3RFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRTtRQUNqRCxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx3QkFBd0IsRUFBRTtRQUNsRSxLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNoRSxDQUFDOzJEQUdEO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsZUFBZSxFQUFFLEVBQUUsQ0FBQztrREFrQjVCO0FBZUs7SUFiTCxJQUFBLG9CQUFPLEVBQUMsb0RBQW9ELEVBQUU7UUFDM0QsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDOUQsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDdEUsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFO1FBQ2pELFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGNBQWMsRUFBRTtRQUN6RCxVQUFVLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxjQUFjLEVBQUU7UUFDM0QsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFO1FBQ3pELFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLDBCQUEwQixFQUFFO1FBQ3JFLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGtDQUFrQyxFQUFFO1FBQzlFLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGtCQUFrQixFQUFFO1FBQzFELFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGlCQUFpQixFQUFFO1FBQzdELFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLCtCQUErQixFQUFFO0tBQzlFLENBQUM7NkNBMkJEO0FBT0s7SUFITCxJQUFBLG9CQUFPLEVBQUMsVUFBVSxFQUFFO1FBQ2pCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGVBQWUsRUFBRTtLQUM3RCxDQUFDO2lEQUdEO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQztnREFHdkI7QUFHSztJQURMLElBQUEsb0JBQU8sRUFBQyxVQUFVLEVBQUUsRUFBRSxDQUFDOzJDQUd2QjtBQUdLO0lBREwsSUFBQSxvQkFBTyxFQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7NENBR25CO0FBR0s7SUFETCxJQUFBLG9CQUFPLEVBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQzsyQ0FHbkI7QUFHSztJQURMLElBQUEsb0JBQU8sRUFBQyxNQUFNLEVBQUUsRUFBRSxDQUFDOzZDQUduQjtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLFdBQVcsRUFBRTtRQUNsQixHQUFHLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSw0Q0FBNEMsRUFBRTtRQUNsRixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUU7S0FDcEQsQ0FBQztrREFNRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLGFBQWEsRUFBRTtRQUNwQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUU7S0FDekQsQ0FBQztnREFHRDtBQVFLO0lBSkwsSUFBQSxvQkFBTyxFQUFDLGNBQWMsRUFBRTtRQUNyQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSx3QkFBd0IsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ25GLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHlEQUF5RCxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDdEgsQ0FBQztrREFHRDtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLGNBQWMsRUFBRTtRQUNyQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNqRSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNsRSxDQUFDO2tEQUdEO0FBVUs7SUFOTCxJQUFBLG9CQUFPLEVBQUMsV0FBVyxFQUFFO1FBQ2xCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQy9ELEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQzdELEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHFDQUFxQyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDaEcsQ0FBQztpREFHRDtBQVFLO0lBTkwsSUFBQSxvQkFBTyxFQUFDLFlBQVksRUFBRTtRQUNuQixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNqRSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUMvRCxLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUM3RCxLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUN0RSxDQUFDO2lEQUdEO0FBT0s7SUFMTCxJQUFBLG9CQUFPLEVBQUMsV0FBVyxFQUFFO1FBQ2xCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQy9ELEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ2hFLENBQUM7aURBR0Q7QUFRSztJQU5MLElBQUEsb0JBQU8sRUFBQyxhQUFhLEVBQUU7UUFDcEIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDL0QsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDOUQsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDbkUsQ0FBQztnREFHRDtBQU1LO0lBSkwsSUFBQSxvQkFBTyxFQUFDLHFCQUFxQixFQUFFO1FBQzVCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ2xFLENBQUM7aURBR0Q7QUFTSztJQUxMLElBQUEsb0JBQU8sRUFBQyxZQUFZLEVBQUU7UUFDbkIsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDN0QsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDOUQsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsa0JBQWtCLEVBQUU7S0FDOUQsQ0FBQztnREFLRDtBQUtLO0lBSEwsSUFBQSxvQkFBTyxFQUFDLGVBQWUsRUFBRTtRQUN0QixLQUFLLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNoRSxDQUFDO21EQUdEO0FBT0s7SUFMTCxJQUFBLG9CQUFPLEVBQUMsWUFBWSxFQUFFO1FBQ25CLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQzdELElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2hFLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLG9CQUFvQixFQUFFO0tBQ2hFLENBQUM7bURBS0Q7QUFLSztJQUhMLElBQUEsb0JBQU8sRUFBQyxVQUFVLEVBQUU7UUFDakIsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsdURBQXVELEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNuSCxDQUFDO21EQVNEO0FBUUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsaUJBQWlCLEVBQUU7UUFDeEIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDdEUsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsbUJBQW1CLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUMvRSxDQUFDO29EQUdEO0FBTUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsYUFBYSxFQUFFO1FBQ3BCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3RFLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ3hFLENBQUM7bURBR0Q7QUFNSztJQUpMLElBQUEsb0JBQU8sRUFBQyxhQUFhLEVBQUU7UUFDcEIsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDdEUsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsZ0RBQWdELEVBQUU7S0FDOUYsQ0FBQzt1REFHRDtBQVVLO0lBTkwsSUFBQSxvQkFBTyxFQUFDLGlFQUFpRSxFQUFFO1FBQ3hFLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3RFLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFFBQVEsRUFBRTtRQUMvQyxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxzQ0FBc0MsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQzdGLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLCtCQUErQixFQUFFO0tBQzlFLENBQUM7NENBT0Q7QUFPSztJQUhMLElBQUEsb0JBQU8sRUFBQyx1QkFBdUIsRUFBRTtRQUM5QixRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtLQUNwRSxDQUFDO2tEQUdEO0FBTUs7SUFKTCxJQUFBLG9CQUFPLEVBQUMsb0JBQW9CLEVBQUU7UUFDM0IsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7S0FDcEUsQ0FBQzt1REFHRDswQkF4VVEsZUFBZTtJQUQzQixJQUFBLHNCQUFTLEVBQUMsV0FBVyxFQUFFLHVDQUF1QyxDQUFDO0dBQ25ELGVBQWUsQ0F5VTNCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDliqjnlLvmqKHlnZcg4oCUIOWKqOeUu+eJh+auteafpeivouOAgeWFs+mUruW4p+aTjeS9nOOAgeW4p+S6i+S7tuOAgeWKqOeUu+mihOiuvlxuICpcbiAqIOS+nei1liBDb2NvcyBDcmVhdG9yIEFuaW1hdGlvbiDnvJbovpHlmaggQVBJ44CCXG4gKiDkvb/nlKjliY3pnIDlhYjlnKjnvJbovpHlmajkuK3miZPlvIAgQW5pbWF0aW9uIOmdouadv+OAglxuICovXG5cbmltcG9ydCB7IE1DUE1vZHVsZSwgTUNQVG9vbCB9IGZyb20gJy4uL2RlY29yYXRvcnMnO1xuXG5hc3luYyBmdW5jdGlvbiBjYWxsU2NlbmUobWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXRob2QsIC4uLmFyZ3MpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+a2iOaBryAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjYWxsQXNzZXREQihtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6LWE5Lqn5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbkBNQ1BNb2R1bGUoJ2FuaW1hdGlvbicsICfliqjnlLvnvJbovpEgLSDliqjnlLvniYfmrrUv5YWz6ZSu5binL+S6i+S7ti/pooTorr7nrqHnkIbvvIzmlK/mjIHmibnph4/mk43kvZzlkozmlofku7bnm7TmjqXlhpnlhaUnKVxuZXhwb3J0IGNsYXNzIEFuaW1hdGlvbk1vZHVsZSB7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDmn6Xor6IgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LlvZPliY3liqjnlLvnvJbovpHnirbmgIHvvIjkvb/nlKjnmoTniYfmrrUgVVVJRCDnrYnvvInjgILlnKjmk43kvZzliqjnlLvliY3osIPnlKjmraTmlrnms5Xnoa7orqTnvJbovpHnirbmgIEnLCB7fSlcbiAgICBhc3luYyBxdWVyeV9lZGl0X2luZm8oKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktYW5pbWF0aW9uLWVkaXQtaW5mbycpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrproioLngrnkuIrnmoTmiYDmnInliqjnlLvniYfmrrXliJfooagnLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlE77yI5YyF5ZCrIEFuaW1hdGlvbiDnu4Tku7bvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9jbGlwc19pbmZvKHBhcmFtcz86IHsgbm9kZVV1aWQ/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWFuaW1hdGlvbi1jbGlwcycsIHBhcmFtcz8ubm9kZVV1aWQpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrprliqjnlLvniYfmrrXnmoTlrozmlbTmlbDmja7vvIjovajpgZMv5YWz6ZSu5binL+S6i+S7tuetie+8iScsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgcXVlcnlfY2xpcF9kdW1wKHBhcmFtczogeyBjbGlwVXVpZDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1hbmltYXRpb24tY2xpcC1kdW1wJywgcGFyYW1zLmNsaXBVdWlkKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i6IqC54K555qE5Y+v5Yqo55S75bGe5oCn5YiX6KGoJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9wcm9wZXJ0aWVzKHBhcmFtcz86IHsgbm9kZVV1aWQ/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3F1ZXJ5LWFuaW1hdGlvbi1wcm9wZXJ0aWVzJywgcGFyYW1zPy5ub2RlVXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouWKqOeUu+eJh+auteWxnuaAp++8iOmHh+agt+eOhy/pgJ/luqYv5b6q546v5qih5byP562J77yJJywge1xuICAgICAgICBjbGlwVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfliqjnlLvniYfmrrUgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBxdWVyeV9jbGlwKHBhcmFtczogeyBjbGlwVXVpZDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1hbmltYXRpb24tY2xpcCcsIHBhcmFtcy5jbGlwVXVpZCk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouaMh+WumuW4p+S4iueahOWxnuaAp+WAvCcsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBub2RlUGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnot6/lvoQnIH0sXG4gICAgICAgIHByb3BLZXk6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn6ZSu77yI5aaCIHBvc2l0aW9uLCBzY2FsZe+8iScgfSxcbiAgICAgICAgZnJhbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bin57Si5byVJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHF1ZXJ5X3ZhbHVlX2F0X2ZyYW1lKHBhcmFtczogeyBjbGlwVXVpZDogc3RyaW5nOyBub2RlUGF0aD86IHN0cmluZzsgcHJvcEtleT86IHN0cmluZzsgZnJhbWU6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncXVlcnktYW5pbWF0aW9uLXZhbHVlLWF0LWZyYW1lJywgcGFyYW1zLmNsaXBVdWlkLCBwYXJhbXMubm9kZVBhdGgsIHBhcmFtcy5wcm9wS2V5LCBwYXJzZUludChwYXJhbXMuZnJhbWUsIDEwKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+afpeivouaJgOacieWPr+eUqOeahOWKqOeUu+mihOiuvuWIl+ihqCcsIHt9KVxuICAgIGFzeW5jIHByZXNldF9saXN0KCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHByZXNldHMgPSBbXG4gICAgICAgICAgICB7IG5hbWU6ICdmYWRlX2luJywgY2F0ZWdvcnk6ICdiYXNpYycsIGRlc2NyaXB0aW9uOiAn5reh5YWlJyB9LFxuICAgICAgICAgICAgeyBuYW1lOiAnZmFkZV9vdXQnLCBjYXRlZ29yeTogJ2Jhc2ljJywgZGVzY3JpcHRpb246ICfmt6Hlh7onIH0sXG4gICAgICAgICAgICB7IG5hbWU6ICdzY2FsZV9ib3VuY2UnLCBjYXRlZ29yeTogJ3BvcHVwJywgZGVzY3JpcHRpb246ICflvLnot7PmlL7lpKcnIH0sXG4gICAgICAgICAgICB7IG5hbWU6ICdzY2FsZV9jbG9zZScsIGNhdGVnb3J5OiAncG9wdXAnLCBkZXNjcmlwdGlvbjogJ+e8qeWwj+a2iOWksScgfSxcbiAgICAgICAgICAgIHsgbmFtZTogJ3NsaWRlX2luX2JvdHRvbScsIGNhdGVnb3J5OiAnc2xpZGUnLCBkZXNjcmlwdGlvbjogJ+S7juW6lemDqOa7keWFpScgfSxcbiAgICAgICAgICAgIHsgbmFtZTogJ3NsaWRlX2luX3JpZ2h0JywgY2F0ZWdvcnk6ICdzbGlkZScsIGRlc2NyaXB0aW9uOiAn5LuO5Y+z5L6n5ruR5YWlJyB9LFxuICAgICAgICAgICAgeyBuYW1lOiAnc2hha2UnLCBjYXRlZ29yeTogJ2VmZmVjdCcsIGRlc2NyaXB0aW9uOiAn5oqW5YqoJyB9LFxuICAgICAgICAgICAgeyBuYW1lOiAncHVsc2UnLCBjYXRlZ29yeTogJ2xvb3AnLCBkZXNjcmlwdGlvbjogJ+iEieWKqOWRvOWQuCcgfSxcbiAgICAgICAgICAgIHsgbmFtZTogJ2Zsb2F0JywgY2F0ZWdvcnk6ICdsb29wJywgZGVzY3JpcHRpb246ICfkuIrkuIvmta7liqgnIH0sXG4gICAgICAgICAgICB7IG5hbWU6ICd0eXBld3JpdGVyJywgY2F0ZWdvcnk6ICd0ZXh0JywgZGVzY3JpcHRpb246ICfmiZPlrZfmnLonIH0sXG4gICAgICAgICAgICB7IG5hbWU6ICdudW1iZXJfcm9sbCcsIGNhdGVnb3J5OiAndGV4dCcsIGRlc2NyaXB0aW9uOiAn5pWw5a2X5rua5YqoJyB9LFxuICAgICAgICAgICAgeyBuYW1lOiAnZmxpcF9jYXJkJywgY2F0ZWdvcnk6ICdlZmZlY3QnLCBkZXNjcmlwdGlvbjogJ+WNoeeJh+e/u+i9rCcgfSxcbiAgICAgICAgICAgIHsgbmFtZTogJ2NvbWJvX3NlcXVlbmNlJywgY2F0ZWdvcnk6ICdzZXF1ZW5jZScsIGRlc2NyaXB0aW9uOiAn57qn6IGU5YWl5Zy6JyB9LFxuICAgICAgICBdO1xuICAgICAgICByZXR1cm4geyBwcmVzZXRzIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIm+W7uuWKqOeUu+mihOiuvuOAgndyaXRlTW9kZT1cImZpbGVcIiDnm7TmjqXlhpnlhaUgLmFuaW0g5paH5Lu277yI5o6o6I2Q77yM5peg6ZyA5Yqo55S757yW6L6R5qih5byP77yJJywge1xuICAgICAgICBwcmVzZXQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKE6K6+5ZCNJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+iKgueCueWQjeaIlui3r+W+hCcgfSxcbiAgICAgICAgZHVyYXRpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pe26ZW/77yI5bin5pWw77yJ77yM6buY6K6kIDMwJyB9LFxuICAgICAgICBzdGFydFZhbHVlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1t+Wni+WAvCBKU09O77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBlbmRWYWx1ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu5PmnZ/lgLwgSlNPTu+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgZGlzdGFuY2U6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn56e75Yqo6Led56a777yIc2xpZGUvZmxvYXTvvInvvIzpu5jorqQgNTAwJyB9LFxuICAgICAgICBkaXJlY3Rpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pa55ZCR77yIc2xpZGU6IGxlZnQvcmlnaHQvdG9wL2JvdHRvbe+8iScgfSxcbiAgICAgICAgY291bnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6YeN5aSN5qyh5pWw77yIc2hha2Ug6buY6K6kIDPvvIknIH0sXG4gICAgICAgIGludGVuc2l0eTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflvLrluqbvvIhzaGFrZSDpu5jorqQgMTDvvIknIH0sXG4gICAgICAgIHdyaXRlTW9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflhpnlhaXmqKHlvI86IFwiYXBpXCIg5oiWIFwiZmlsZVwi77yI5o6o6I2QIGZpbGXvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBwcmVzZXQocGFyYW1zOiB7XG4gICAgICAgIHByZXNldDogc3RyaW5nO1xuICAgICAgICBjbGlwVXVpZDogc3RyaW5nO1xuICAgICAgICBub2RlPzogc3RyaW5nO1xuICAgICAgICBkdXJhdGlvbj86IHN0cmluZztcbiAgICAgICAgc3RhcnRWYWx1ZT86IHN0cmluZztcbiAgICAgICAgZW5kVmFsdWU/OiBzdHJpbmc7XG4gICAgICAgIGRpc3RhbmNlPzogc3RyaW5nO1xuICAgICAgICBkaXJlY3Rpb24/OiBzdHJpbmc7XG4gICAgICAgIGNvdW50Pzogc3RyaW5nO1xuICAgICAgICBpbnRlbnNpdHk/OiBzdHJpbmc7XG4gICAgICAgIHdyaXRlTW9kZT86IHN0cmluZztcbiAgICB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgLy8g5L2/55SoIEVkaXRvciBBUEkg5Yib5bu66aKE6K6+XG4gICAgICAgIGNvbnN0IGFyZ3M6IGFueSA9IHsgcHJlc2V0OiBwYXJhbXMucHJlc2V0LCBjbGlwVXVpZDogcGFyYW1zLmNsaXBVdWlkIH07XG4gICAgICAgIGlmIChwYXJhbXMubm9kZSkgYXJncy5ub2RlID0gcGFyYW1zLm5vZGU7XG4gICAgICAgIGlmIChwYXJhbXMuZHVyYXRpb24pIGFyZ3MuZHVyYXRpb24gPSBwYXJzZUludChwYXJhbXMuZHVyYXRpb24sIDEwKTtcbiAgICAgICAgaWYgKHBhcmFtcy5zdGFydFZhbHVlKSBhcmdzLnN0YXJ0VmFsdWUgPSBKU09OLnBhcnNlKHBhcmFtcy5zdGFydFZhbHVlKTtcbiAgICAgICAgaWYgKHBhcmFtcy5lbmRWYWx1ZSkgYXJncy5lbmRWYWx1ZSA9IEpTT04ucGFyc2UocGFyYW1zLmVuZFZhbHVlKTtcbiAgICAgICAgaWYgKHBhcmFtcy5kaXN0YW5jZSkgYXJncy5kaXN0YW5jZSA9IHBhcnNlSW50KHBhcmFtcy5kaXN0YW5jZSwgMTApO1xuICAgICAgICBpZiAocGFyYW1zLmRpcmVjdGlvbikgYXJncy5kaXJlY3Rpb24gPSBwYXJhbXMuZGlyZWN0aW9uO1xuICAgICAgICBpZiAocGFyYW1zLmNvdW50KSBhcmdzLmNvdW50ID0gcGFyc2VJbnQocGFyYW1zLmNvdW50LCAxMCk7XG4gICAgICAgIGlmIChwYXJhbXMuaW50ZW5zaXR5KSBhcmdzLmludGVuc2l0eSA9IHBhcnNlSW50KHBhcmFtcy5pbnRlbnNpdHksIDEwKTtcbiAgICAgICAgYXJncy53cml0ZU1vZGUgPSBwYXJhbXMud3JpdGVNb2RlIHx8ICdmaWxlJztcblxuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdhcHBseS1hbmltYXRpb24tcHJlc2V0JywgYXJncyk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g55Sf5ZG95ZGo5pyfID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6L+b5YWl5Yqo55S757yW6L6R5qih5byPJywge1xuICAgICAgICBjbGlwVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfliqjnlLvniYfmrrUgVVVJRO+8iOWPr+mAie+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIGVudGVyX2VkaXQocGFyYW1zPzogeyBjbGlwVXVpZD86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnZW50ZXItYW5pbWF0aW9uLWVkaXQtbW9kZScsIHBhcmFtcz8uY2xpcFV1aWQpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfpgIDlh7rliqjnlLvnvJbovpHmqKHlvI8nLCB7fSlcbiAgICBhc3luYyBleGl0X2VkaXQoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnZXhpdC1hbmltYXRpb24tZWRpdC1tb2RlJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+aSreaUvuW9k+WJjeWKqOeUu+eJh+autScsIHt9KVxuICAgIGFzeW5jIHBsYXkoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncGxheS1hbmltYXRpb24nKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5pqC5YGc5pKt5pS+Jywge30pXG4gICAgYXN5bmMgcGF1c2UoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncGF1c2UtYW5pbWF0aW9uJyk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WBnOatouaSreaUvicsIHt9KVxuICAgIGFzeW5jIHN0b3AoKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnc3RvcC1hbmltYXRpb24nKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5oGi5aSN5pKt5pS+Jywge30pXG4gICAgYXN5bmMgcmVzdW1lKCk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3Jlc3VtZS1hbmltYXRpb24nKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5Yib5bu65paw55qE56m65Yqo55S754mH5q61Jywge1xuICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5L+d5a2Y6Lev5b6E77yI5aaCIGRiOi8vYXNzZXRzL2FuaW1hdGlvbnMvTXlDbGlwLmFuaW3vvIknIH0sXG4gICAgICAgIGNsaXBOYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+eJh+auteWQjeensCcgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNyZWF0ZV9jbGlwKHBhcmFtczogeyB1cmw6IHN0cmluZzsgY2xpcE5hbWU/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCBjYWxsQXNzZXREQigndXVpZC10by11cmwnLCBwYXJhbXMudXJsKTtcbiAgICAgICAgLy8g6YCa6L+HIGFzc2V0LWRiIOWIm+W7uuepuiAuYW5pbSDmlofku7ZcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FsbEFzc2V0REIoJ2NyZWF0ZS1hc3NldCcsIHBhcmFtcy51cmwsICdjYy5BbmltYXRpb25DbGlwJywge30pO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiBg5Yqo55S754mH5q615bey5Yib5bu6OiAke3BhcmFtcy51cmx9YCwgdXVpZDogcmVzdWx0Py51dWlkIH07XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+S/neWtmOW9k+WJjeWKqOeUu+eJh+auteWIsOejgeebmCcsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnIH0sXG4gICAgfSlcbiAgICBhc3luYyBzYXZlX2NsaXAocGFyYW1zPzogeyBjbGlwVXVpZD86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnc2F2ZS1hbmltYXRpb24tY2xpcCcsIHBhcmFtcz8uY2xpcFV1aWQpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOWxnuaAp+i9qOmBkyA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+WcqOiKgueCueS4iuWIm+W7uuWKqOeUu+WxnuaAp+i9qOmBkycsIHtcbiAgICAgICAgbm9kZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K56Lev5b6E77yI5aaCIC9DYW52YXMvTXlOb2Rl77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJvcEtleTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfplK7vvIjlpoIgcG9zaXRpb24sIHNjYWxlLCByb3RhdGlvbiwgY2MuU3ByaXRlLnNwcml0ZUZyYW1l77yJJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNyZWF0ZV9wcm9wKHBhcmFtczogeyBub2RlUGF0aDogc3RyaW5nOyBwcm9wS2V5OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2NyZWF0ZS1hbmltYXRpb24tcHJvcCcsIHBhcmFtcy5ub2RlUGF0aCwgcGFyYW1zLnByb3BLZXkpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliKDpmaToioLngrnkuIrnmoTliqjnlLvlsZ7mgKfovajpgZMnLCB7XG4gICAgICAgIG5vZGVQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuei3r+W+hCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHByb3BLZXk6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn6ZSuJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIHJlbW92ZV9wcm9wKHBhcmFtczogeyBub2RlUGF0aDogc3RyaW5nOyBwcm9wS2V5OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3JlbW92ZS1hbmltYXRpb24tcHJvcCcsIHBhcmFtcy5ub2RlUGF0aCwgcGFyYW1zLnByb3BLZXkpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOWFs+mUruW4pyA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+WcqOaMh+WumuW4p+WIm+W7uuWFs+mUruW4pycsIHtcbiAgICAgICAgbm9kZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K56Lev5b6EJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJvcEtleTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfplK4nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBmcmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfluKfntKLlvJUnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB2YWx1ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflgLwgSlNPTu+8iOWmgiB7XCJ4XCI6MTAwLFwieVwiOjIwMCxcInpcIjowfe+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBjcmVhdGVfa2V5KHBhcmFtczogeyBub2RlUGF0aDogc3RyaW5nOyBwcm9wS2V5OiBzdHJpbmc7IGZyYW1lOiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2NyZWF0ZS1hbmltYXRpb24ta2V5JywgcGFyYW1zLm5vZGVQYXRoLCBwYXJhbXMucHJvcEtleSwgcGFyc2VJbnQocGFyYW1zLmZyYW1lLCAxMCksIEpTT04ucGFyc2UocGFyYW1zLnZhbHVlKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+abtOaWsOWFs+mUruW4p++8iOS/ruaUueWAvO+8iScsIHtcbiAgICAgICAgbm9kZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K56Lev5b6EJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJvcEtleTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfplK4nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBmcmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfluKfntKLlvJUnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB2YWx1ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlrDlsZ7mgKflgLwgSlNPTicsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyB1cGRhdGVfa2V5KHBhcmFtczogeyBub2RlUGF0aDogc3RyaW5nOyBwcm9wS2V5OiBzdHJpbmc7IGZyYW1lOiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ3VwZGF0ZS1hbmltYXRpb24ta2V5JywgcGFyYW1zLm5vZGVQYXRoLCBwYXJhbXMucHJvcEtleSwgcGFyc2VJbnQocGFyYW1zLmZyYW1lLCAxMCksIEpTT04ucGFyc2UocGFyYW1zLnZhbHVlKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+WIoOmZpOaMh+WumuW4p+eahOWFs+mUruW4pycsIHtcbiAgICAgICAgbm9kZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K56Lev5b6EJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJvcEtleTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfplK4nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBmcmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfluKfntKLlvJUnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgcmVtb3ZlX2tleShwYXJhbXM6IHsgbm9kZVBhdGg6IHN0cmluZzsgcHJvcEtleTogc3RyaW5nOyBmcmFtZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdyZW1vdmUtYW5pbWF0aW9uLWtleScsIHBhcmFtcy5ub2RlUGF0aCwgcGFyYW1zLnByb3BLZXksIHBhcnNlSW50KHBhcmFtcy5mcmFtZSwgMTApKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn56e75Yqo5YWz6ZSu5bin5L2N572u77yI5YGP56e777yJJywge1xuICAgICAgICBub2RlUGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnot6/lvoQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwcm9wS2V5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+mUricsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGZyYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+a6kOW4p+e0ouW8lScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHRhcmdldDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnm67moIfluKfntKLlvJUnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgbW92ZV9rZXlzKHBhcmFtczogeyBub2RlUGF0aDogc3RyaW5nOyBwcm9wS2V5OiBzdHJpbmc7IGZyYW1lOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdtb3ZlLWFuaW1hdGlvbi1rZXlzJywgcGFyYW1zLm5vZGVQYXRoLCBwYXJhbXMucHJvcEtleSwgcGFyc2VJbnQocGFyYW1zLmZyYW1lLCAxMCksIHBhcnNlSW50KHBhcmFtcy50YXJnZXQsIDEwKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+a4heepuuaMh+Wumui9qOmBk+S4iueahOaJgOacieWFs+mUruW4p++8iOS/neeVmei9qOmBk++8iScsIHtcbiAgICAgICAgbm9kZVBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K56Lev5b6EJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcHJvcEtleTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfplK4nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgY2xlYXJfa2V5cyhwYXJhbXM6IHsgbm9kZVBhdGg6IHN0cmluZzsgcHJvcEtleTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdjbGVhci1hbmltYXRpb24ta2V5cycsIHBhcmFtcy5ub2RlUGF0aCwgcGFyYW1zLnByb3BLZXkpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOW4p+S6i+S7tiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+WcqOaMh+WumuW4p+a3u+WKoOWKqOeUu+S6i+S7ticsIHtcbiAgICAgICAgZnJhbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bin57Si5byVJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgZnVuYzogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflm57osIPlh73mlbDlkI0nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwYXJhbXM6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y+C5pWw5YiX6KGoIEpTT04g5pWw57uE77yI5Y+v6YCJ77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgYWRkX2V2ZW50KHBhcmFtczogeyBmcmFtZTogc3RyaW5nOyBmdW5jOiBzdHJpbmc7IHBhcmFtcz86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgZXZlbnREYXRhOiBhbnkgPSB7IGZ1bmM6IHBhcmFtcy5mdW5jIH07XG4gICAgICAgIGlmIChwYXJhbXMucGFyYW1zKSBldmVudERhdGEucGFyYW1zID0gSlNPTi5wYXJzZShwYXJhbXMucGFyYW1zKTtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgnYWRkLWFuaW1hdGlvbi1ldmVudCcsIHBhcnNlSW50KHBhcmFtcy5mcmFtZSwgMTApLCBldmVudERhdGEpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliKDpmaTmjIflrprluKfkuIrnmoTmiYDmnInliqjnlLvkuovku7YnLCB7XG4gICAgICAgIGZyYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+W4p+e0ouW8lScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBkZWxldGVfZXZlbnQocGFyYW1zOiB7IGZyYW1lOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2RlbGV0ZS1hbmltYXRpb24tZXZlbnQnLCBwYXJzZUludChwYXJhbXMuZnJhbWUsIDEwKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+abtOaWsOaMh+WumuW4p+eahOWKqOeUu+S6i+S7ticsIHtcbiAgICAgICAgZnJhbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bin57Si5byVJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgZnVuYzogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlrDnmoTlm57osIPlh73mlbDlkI0nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBwYXJhbXM6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5paw55qE5Y+C5pWw5YiX6KGoIEpTT04g5pWw57uE77yI5Y+v6YCJ77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgdXBkYXRlX2V2ZW50KHBhcmFtczogeyBmcmFtZTogc3RyaW5nOyBmdW5jOiBzdHJpbmc7IHBhcmFtcz86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgZXZlbnREYXRhOiBhbnkgPSB7IGZ1bmM6IHBhcmFtcy5mdW5jIH07XG4gICAgICAgIGlmIChwYXJhbXMucGFyYW1zKSBldmVudERhdGEucGFyYW1zID0gSlNPTi5wYXJzZShwYXJhbXMucGFyYW1zKTtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgndXBkYXRlLWFuaW1hdGlvbi1ldmVudCcsIHBhcnNlSW50KHBhcmFtcy5mcmFtZSwgMTApLCBldmVudERhdGEpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmibnph4/mt7vliqDliqjnlLvkuovku7YnLCB7XG4gICAgICAgIGV2ZW50czogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfkuovku7bmlbDnu4QgSlNPTjogW3tcImZyYW1lXCI6MCxcImZ1bmNcIjpcIm9uU3RhcnRcIixcInBhcmFtc1wiOltdfV0nLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgYmF0Y2hfZXZlbnRzKHBhcmFtczogeyBldmVudHM6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgZXZlbnRzID0gSlNPTi5wYXJzZShwYXJhbXMuZXZlbnRzKTtcbiAgICAgICAgY29uc3QgcmVzdWx0czogYW55W10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBldnQgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYWxsU2NlbmUoJ2FkZC1hbmltYXRpb24tZXZlbnQnLCBldnQuZnJhbWUsIHsgZnVuYzogZXZ0LmZ1bmMsIHBhcmFtczogZXZ0LnBhcmFtcyB8fCBbXSB9KTtcbiAgICAgICAgICAgIHJlc3VsdHMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDlt7Lmt7vliqAgJHtyZXN1bHRzLmxlbmd0aH0g5Liq5LqL5Lu2YCwgcmVzdWx0cyB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOeJh+auteWxnuaApyA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+S/ruaUueWKqOeUu+eJh+auteeahOmHh+agt+eOh++8iGZwc++8iScsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBzYW1wbGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6YeH5qC3546H77yI5aaCIDI0LCAzMCwgNjDvvIknLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIH0pXG4gICAgYXN5bmMgY2hhbmdlX3NhbXBsZShwYXJhbXM6IHsgY2xpcFV1aWQ6IHN0cmluZzsgc2FtcGxlOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2NoYW5nZS1hbmltYXRpb24tc2FtcGxlJywgcGFyYW1zLmNsaXBVdWlkLCBwYXJzZUludChwYXJhbXMuc2FtcGxlLCAxMCkpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfkv67mlLnliqjnlLvniYfmrrXnmoTmkq3mlL7pgJ/luqYnLCB7XG4gICAgICAgIGNsaXBVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WKqOeUu+eJh+autSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgc3BlZWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pKt5pS+6YCf5bqm77yI5aaCIDEuMO+8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBjaGFuZ2Vfc3BlZWQocGFyYW1zOiB7IGNsaXBVdWlkOiBzdHJpbmc7IHNwZWVkOiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2NoYW5nZS1hbmltYXRpb24tc3BlZWQnLCBwYXJhbXMuY2xpcFV1aWQsIHBhcnNlRmxvYXQocGFyYW1zLnNwZWVkKSk7XG4gICAgfVxuXG4gICAgQE1DUFRvb2woJ+S/ruaUueWKqOeUu+eJh+auteeahOW+queOr+aooeW8jycsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB3cmFwTW9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflvqrnjq/mqKHlvI86IDA9RGVmYXVsdCwgMT1Ob3JtYWwsIDI9TG9vcCwgMzY9UGluZ1BvbmcnIH0sXG4gICAgfSlcbiAgICBhc3luYyBjaGFuZ2Vfd3JhcF9tb2RlKHBhcmFtczogeyBjbGlwVXVpZDogc3RyaW5nOyB3cmFwTW9kZTogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdjaGFuZ2UtYW5pbWF0aW9uLXdyYXAtbW9kZScsIHBhcmFtcy5jbGlwVXVpZCwgcGFyc2VJbnQocGFyYW1zLndyYXBNb2RlLCAxMCkpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOaJuemHj+aTjeS9nCA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+aJuemHj+WIm+W7uuWKqOeUu+WFs+mUruW4p++8iOS4gOasoeiwg+eUqOWMheWQq+WujOaVtOWxnuaAp+i9qOmBk+WSjOWFs+mUruW4p++8ieOAguaOqOiNkOS9v+eUqCB3cml0ZU1vZGU6XCJmaWxlXCIg55u05o6l5YaZ5YWlIC5hbmltIOaWh+S7ticsIHtcbiAgICAgICAgY2xpcFV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqo55S754mH5q61IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueWQjeaIlui3r+W+hCcgfSxcbiAgICAgICAgZGF0YTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfliqjnlLvmlbDmja4gSlNPTu+8iOWQqyB0cmFja3Mva2V5ZnJhbWVzL2V2ZW50c++8iScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIHdyaXRlTW9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflhpnlhaXmqKHlvI86IFwiYXBpXCIg5oiWIFwiZmlsZVwi77yI5o6o6I2QIGZpbGXvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBiYXRjaChwYXJhbXM6IHsgY2xpcFV1aWQ6IHN0cmluZzsgbm9kZT86IHN0cmluZzsgZGF0YTogc3RyaW5nOyB3cml0ZU1vZGU/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHBhcmFtcy5kYXRhKTtcbiAgICAgICAgY29uc3QgYXJnczogYW55ID0geyBjbGlwVXVpZDogcGFyYW1zLmNsaXBVdWlkLCBkYXRhIH07XG4gICAgICAgIGlmIChwYXJhbXMubm9kZSkgYXJncy5ub2RlID0gcGFyYW1zLm5vZGU7XG4gICAgICAgIGFyZ3Mud3JpdGVNb2RlID0gcGFyYW1zLndyaXRlTW9kZSB8fCAnZmlsZSc7XG4gICAgICAgIHJldHVybiBjYWxsU2NlbmUoJ2JhdGNoLWFuaW1hdGlvbicsIGFyZ3MpO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOiKgueCueaTjeS9nCA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+WIoOmZpOaMh+WumuiKgueCueeahOaJgOacieWKqOeUu+aVsOaNru+8iOi9qOmBky/lhbPplK7luKfvvIknLCB7XG4gICAgICAgIG5vZGVQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuei3r+W+hCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyByZW1vdmVfbm9kZShwYXJhbXM6IHsgbm9kZVBhdGg6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgcmV0dXJuIGNhbGxTY2VuZSgncmVtb3ZlLWFuaW1hdGlvbi1ub2RlJywgcGFyYW1zLm5vZGVQYXRoKTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5bCG5Yqo55S75pWw5o2u5LuO5LiA5Liq6IqC54K56Lev5b6E6L+B56e75Yiw5Y+m5LiA5LiqJywge1xuICAgICAgICBvbGRQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aXp+iKgueCuei3r+W+hCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIG5ld1BhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5paw6IqC54K56Lev5b6EJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB9KVxuICAgIGFzeW5jIGNoYW5nZV9ub2RlX3BhdGgocGFyYW1zOiB7IG9sZFBhdGg6IHN0cmluZzsgbmV3UGF0aDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdjaGFuZ2UtYW5pbWF0aW9uLW5vZGUtcGF0aCcsIHBhcmFtcy5vbGRQYXRoLCBwYXJhbXMubmV3UGF0aCk7XG4gICAgfVxufVxuIl19