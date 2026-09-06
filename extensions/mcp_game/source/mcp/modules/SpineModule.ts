/**
 * Spine 骨骼动画模块 — 查询动画/皮肤、播放动画、切换皮肤、设置属性、挂件管理
 */

import { MCPModule, MCPTool } from '../decorators';

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('spine', 'Spine 骨骼动画 - 查询动画列表/皮肤列表、播放动画、切换皮肤、设置属性、挂件管理')
export class SpineModule {

    @MCPTool('获取 Spine Skeleton 组件信息', {
        nodeUuid: { type: 'string', description: '节点 UUID（含 sp.Skeleton 组件）', required: true },
    })
    async spine_info(params: { nodeUuid: string }): Promise<any> {
        return callScene('query-component', params.nodeUuid, 'sp.Skeleton');
    }

    @MCPTool('列出 Spine 节点的所有可用动画', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async list_animations(params: { nodeUuid: string }): Promise<any> {
        return callScene('query-spine-animations', params.nodeUuid);
    }

    @MCPTool('列出 Spine 节点的所有可用皮肤', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async list_skins(params: { nodeUuid: string }): Promise<any> {
        return callScene('query-spine-skins', params.nodeUuid);
    }

    @MCPTool('播放 Spine 动画', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        animation: { type: 'string', description: '动画名称', required: true },
        loop: { type: 'string', description: '是否循环: "true" 或 "false"（可选，默认 false）' },
        track: { type: 'string', description: '轨道索引（可选，默认 0）' },
    })
    async set_animation(params: { nodeUuid: string; animation: string; loop?: string; track?: string }): Promise<any> {
        return callScene('set-spine-animation', params.nodeUuid, params.animation, params.loop === 'true', params.track ? parseInt(params.track, 10) : 0);
    }

    @MCPTool('切换 Spine 皮肤', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        skin: { type: 'string', description: '皮肤名称', required: true },
    })
    async set_skin(params: { nodeUuid: string; skin: string }): Promise<any> {
        return callScene('set-spine-skin', params.nodeUuid, params.skin);
    }

    @MCPTool('设置 Spine 组件属性（loop/timeScale/premultipliedAlpha/color 等）', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        property: { type: 'string', description: '属性名: loop/timeScale/premultipliedAlpha/defaultCacheMode/color/debugSlots/debugBones/debugMesh', required: true },
        value: { type: 'string', description: '属性值', required: true },
    })
    async set_property(params: { nodeUuid: string; property: string; value: string }): Promise<any> {
        let val: any = params.value;
        if (params.property === 'loop') val = params.value === 'true';
        else if (params.property === 'timeScale') val = parseFloat(params.value);
        else if (params.property === 'color' || params.property === 'debugSlots' || params.property === 'debugBones' || params.property === 'debugMesh') {
            try { val = JSON.parse(params.value); } catch { /* keep string */ }
        }
        return callScene('set-spine-property', params.nodeUuid, params.property, val);
    }

    @MCPTool('替换 Spine 骨骼数据资源', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        skeletonData: { type: 'string', description: '新骨骼数据资源路径（db://...）或 UUID', required: true },
    })
    async set_data(params: { nodeUuid: string; skeletonData: string }): Promise<any> {
        return callScene('set-spine-data', params.nodeUuid, params.skeletonData);
    }

    @MCPTool('在 Spine 骨骼上添加挂件节点', {
        nodeUuid: { type: 'string', description: '节点 UUID（含 sp.Skeleton）', required: true },
        path: { type: 'string', description: '骨骼路径（bone name）', required: true },
        target: { type: 'string', description: '要挂载的目标节点 UUID', required: true },
    })
    async add_socket(params: { nodeUuid: string; path: string; target: string }): Promise<any> {
        return callScene('add-spine-socket', params.nodeUuid, params.path, params.target);
    }

    @MCPTool('从 Spine 骨骼移除挂件节点', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        path: { type: 'string', description: '骨骼路径', required: true },
    })
    async remove_socket(params: { nodeUuid: string; path: string }): Promise<any> {
        return callScene('remove-spine-socket', params.nodeUuid, params.path);
    }
}
