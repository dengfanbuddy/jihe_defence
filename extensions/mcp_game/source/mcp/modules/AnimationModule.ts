/**
 * 动画模块 — 动画片段查询、关键帧操作、帧事件、动画预设
 *
 * 依赖 Cocos Creator Animation 编辑器 API。
 * 使用前需先在编辑器中打开 Animation 面板。
 */

import { MCPModule, MCPTool } from '../decorators';

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

async function callAssetDB(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('asset-db', method, ...args);
    } catch (e: any) {
        throw new Error(`资产消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('animation', '动画编辑 - 动画片段/关键帧/事件/预设管理，支持批量操作和文件直接写入')
export class AnimationModule {

    // ==================== 查询 ====================

    @MCPTool('查询当前动画编辑状态（使用的片段 UUID 等）。在操作动画前调用此方法确认编辑状态', {})
    async query_edit_info(): Promise<any> {
        return callScene('query-animation-edit-info');
    }

    @MCPTool('查询指定节点上的所有动画片段列表', {
        nodeUuid: { type: 'string', description: '节点 UUID（包含 Animation 组件）' },
    })
    async query_clips_info(params?: { nodeUuid?: string }): Promise<any> {
        return callScene('query-animation-clips', params?.nodeUuid);
    }

    @MCPTool('查询指定动画片段的完整数据（轨道/关键帧/事件等）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
    })
    async query_clip_dump(params: { clipUuid: string }): Promise<any> {
        return callScene('query-animation-clip-dump', params.clipUuid);
    }

    @MCPTool('查询节点的可动画属性列表', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async query_properties(params?: { nodeUuid?: string }): Promise<any> {
        return callScene('query-animation-properties', params?.nodeUuid);
    }

    @MCPTool('查询动画片段属性（采样率/速度/循环模式等）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
    })
    async query_clip(params: { clipUuid: string }): Promise<any> {
        return callScene('query-animation-clip', params.clipUuid);
    }

    @MCPTool('查询指定帧上的属性值', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        nodePath: { type: 'string', description: '节点路径' },
        propKey: { type: 'string', description: '属性键（如 position, scale）' },
        frame: { type: 'string', description: '帧索引', required: true },
    })
    async query_value_at_frame(params: { clipUuid: string; nodePath?: string; propKey?: string; frame: string }): Promise<any> {
        return callScene('query-animation-value-at-frame', params.clipUuid, params.nodePath, params.propKey, parseInt(params.frame, 10));
    }

    @MCPTool('查询所有可用的动画预设列表', {})
    async preset_list(): Promise<any> {
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

    @MCPTool('创建动画预设。writeMode="file" 直接写入 .anim 文件（推荐，无需动画编辑模式）', {
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
    async preset(params: {
        preset: string;
        clipUuid: string;
        node?: string;
        duration?: string;
        startValue?: string;
        endValue?: string;
        distance?: string;
        direction?: string;
        count?: string;
        intensity?: string;
        writeMode?: string;
    }): Promise<any> {
        // 使用 Editor API 创建预设
        const args: any = { preset: params.preset, clipUuid: params.clipUuid };
        if (params.node) args.node = params.node;
        if (params.duration) args.duration = parseInt(params.duration, 10);
        if (params.startValue) args.startValue = JSON.parse(params.startValue);
        if (params.endValue) args.endValue = JSON.parse(params.endValue);
        if (params.distance) args.distance = parseInt(params.distance, 10);
        if (params.direction) args.direction = params.direction;
        if (params.count) args.count = parseInt(params.count, 10);
        if (params.intensity) args.intensity = parseInt(params.intensity, 10);
        args.writeMode = params.writeMode || 'file';

        return callScene('apply-animation-preset', args);
    }

    // ==================== 生命周期 ====================

    @MCPTool('进入动画编辑模式', {
        clipUuid: { type: 'string', description: '动画片段 UUID（可选）' },
    })
    async enter_edit(params?: { clipUuid?: string }): Promise<any> {
        return callScene('enter-animation-edit-mode', params?.clipUuid);
    }

    @MCPTool('退出动画编辑模式', {})
    async exit_edit(): Promise<any> {
        return callScene('exit-animation-edit-mode');
    }

    @MCPTool('播放当前动画片段', {})
    async play(): Promise<any> {
        return callScene('play-animation');
    }

    @MCPTool('暂停播放', {})
    async pause(): Promise<any> {
        return callScene('pause-animation');
    }

    @MCPTool('停止播放', {})
    async stop(): Promise<any> {
        return callScene('stop-animation');
    }

    @MCPTool('恢复播放', {})
    async resume(): Promise<any> {
        return callScene('resume-animation');
    }

    @MCPTool('创建新的空动画片段', {
        url: { type: 'string', description: '保存路径（如 db://assets/animations/MyClip.anim）' },
        clipName: { type: 'string', description: '片段名称' },
    })
    async create_clip(params: { url: string; clipName?: string }): Promise<any> {
        const uuid = await callAssetDB('uuid-to-url', params.url);
        // 通过 asset-db 创建空 .anim 文件
        const result = await callAssetDB('create-asset', params.url, 'cc.AnimationClip', {});
        return { message: `动画片段已创建: ${params.url}`, uuid: result?.uuid };
    }

    @MCPTool('保存当前动画片段到磁盘', {
        clipUuid: { type: 'string', description: '动画片段 UUID' },
    })
    async save_clip(params?: { clipUuid?: string }): Promise<any> {
        return callScene('save-animation-clip', params?.clipUuid);
    }

    // ==================== 属性轨道 ====================

    @MCPTool('在节点上创建动画属性轨道', {
        nodePath: { type: 'string', description: '节点路径（如 /Canvas/MyNode）', required: true },
        propKey: { type: 'string', description: '属性键（如 position, scale, rotation, cc.Sprite.spriteFrame）', required: true },
    })
    async create_prop(params: { nodePath: string; propKey: string }): Promise<any> {
        return callScene('create-animation-prop', params.nodePath, params.propKey);
    }

    @MCPTool('删除节点上的动画属性轨道', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
    })
    async remove_prop(params: { nodePath: string; propKey: string }): Promise<any> {
        return callScene('remove-animation-prop', params.nodePath, params.propKey);
    }

    // ==================== 关键帧 ====================

    @MCPTool('在指定帧创建关键帧', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
        value: { type: 'string', description: '属性值 JSON（如 {"x":100,"y":200,"z":0}）', required: true },
    })
    async create_key(params: { nodePath: string; propKey: string; frame: string; value: string }): Promise<any> {
        return callScene('create-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10), JSON.parse(params.value));
    }

    @MCPTool('更新关键帧（修改值）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
        value: { type: 'string', description: '新属性值 JSON', required: true },
    })
    async update_key(params: { nodePath: string; propKey: string; frame: string; value: string }): Promise<any> {
        return callScene('update-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10), JSON.parse(params.value));
    }

    @MCPTool('删除指定帧的关键帧', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '帧索引', required: true },
    })
    async remove_key(params: { nodePath: string; propKey: string; frame: string }): Promise<any> {
        return callScene('remove-animation-key', params.nodePath, params.propKey, parseInt(params.frame, 10));
    }

    @MCPTool('移动关键帧位置（偏移）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
        frame: { type: 'string', description: '源帧索引', required: true },
        target: { type: 'string', description: '目标帧索引', required: true },
    })
    async move_keys(params: { nodePath: string; propKey: string; frame: string; target: string }): Promise<any> {
        return callScene('move-animation-keys', params.nodePath, params.propKey, parseInt(params.frame, 10), parseInt(params.target, 10));
    }

    @MCPTool('清空指定轨道上的所有关键帧（保留轨道）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
        propKey: { type: 'string', description: '属性键', required: true },
    })
    async clear_keys(params: { nodePath: string; propKey: string }): Promise<any> {
        return callScene('clear-animation-keys', params.nodePath, params.propKey);
    }

    // ==================== 帧事件 ====================

    @MCPTool('在指定帧添加动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
        func: { type: 'string', description: '回调函数名', required: true },
        params: { type: 'string', description: '参数列表 JSON 数组（可选）' },
    })
    async add_event(params: { frame: string; func: string; params?: string }): Promise<any> {
        const eventData: any = { func: params.func };
        if (params.params) eventData.params = JSON.parse(params.params);
        return callScene('add-animation-event', parseInt(params.frame, 10), eventData);
    }

    @MCPTool('删除指定帧上的所有动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
    })
    async delete_event(params: { frame: string }): Promise<any> {
        return callScene('delete-animation-event', parseInt(params.frame, 10));
    }

    @MCPTool('更新指定帧的动画事件', {
        frame: { type: 'string', description: '帧索引', required: true },
        func: { type: 'string', description: '新的回调函数名', required: true },
        params: { type: 'string', description: '新的参数列表 JSON 数组（可选）' },
    })
    async update_event(params: { frame: string; func: string; params?: string }): Promise<any> {
        const eventData: any = { func: params.func };
        if (params.params) eventData.params = JSON.parse(params.params);
        return callScene('update-animation-event', parseInt(params.frame, 10), eventData);
    }

    @MCPTool('批量添加动画事件', {
        events: { type: 'string', description: '事件数组 JSON: [{"frame":0,"func":"onStart","params":[]}]', required: true },
    })
    async batch_events(params: { events: string }): Promise<any> {
        const events = JSON.parse(params.events);
        const results: any[] = [];
        for (const evt of events) {
            const result = await callScene('add-animation-event', evt.frame, { func: evt.func, params: evt.params || [] });
            results.push(result);
        }
        return { message: `已添加 ${results.length} 个事件`, results };
    }

    // ==================== 片段属性 ====================

    @MCPTool('修改动画片段的采样率（fps）', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        sample: { type: 'string', description: '采样率（如 24, 30, 60）', required: true },
    })
    async change_sample(params: { clipUuid: string; sample: string }): Promise<any> {
        return callScene('change-animation-sample', params.clipUuid, parseInt(params.sample, 10));
    }

    @MCPTool('修改动画片段的播放速度', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        speed: { type: 'string', description: '播放速度（如 1.0）', required: true },
    })
    async change_speed(params: { clipUuid: string; speed: string }): Promise<any> {
        return callScene('change-animation-speed', params.clipUuid, parseFloat(params.speed));
    }

    @MCPTool('修改动画片段的循环模式', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        wrapMode: { type: 'string', description: '循环模式: 0=Default, 1=Normal, 2=Loop, 36=PingPong' },
    })
    async change_wrap_mode(params: { clipUuid: string; wrapMode: string }): Promise<any> {
        return callScene('change-animation-wrap-mode', params.clipUuid, parseInt(params.wrapMode, 10));
    }

    // ==================== 批量操作 ====================

    @MCPTool('批量创建动画关键帧（一次调用包含完整属性轨道和关键帧）。推荐使用 writeMode:"file" 直接写入 .anim 文件', {
        clipUuid: { type: 'string', description: '动画片段 UUID', required: true },
        node: { type: 'string', description: '节点名或路径' },
        data: { type: 'string', description: '动画数据 JSON（含 tracks/keyframes/events）', required: true },
        writeMode: { type: 'string', description: '写入模式: "api" 或 "file"（推荐 file）' },
    })
    async batch(params: { clipUuid: string; node?: string; data: string; writeMode?: string }): Promise<any> {
        const data = JSON.parse(params.data);
        const args: any = { clipUuid: params.clipUuid, data };
        if (params.node) args.node = params.node;
        args.writeMode = params.writeMode || 'file';
        return callScene('batch-animation', args);
    }

    // ==================== 节点操作 ====================

    @MCPTool('删除指定节点的所有动画数据（轨道/关键帧）', {
        nodePath: { type: 'string', description: '节点路径', required: true },
    })
    async remove_node(params: { nodePath: string }): Promise<any> {
        return callScene('remove-animation-node', params.nodePath);
    }

    @MCPTool('将动画数据从一个节点路径迁移到另一个', {
        oldPath: { type: 'string', description: '旧节点路径', required: true },
        newPath: { type: 'string', description: '新节点路径', required: true },
    })
    async change_node_path(params: { oldPath: string; newPath: string }): Promise<any> {
        return callScene('change-animation-node-path', params.oldPath, params.newPath);
    }
}
