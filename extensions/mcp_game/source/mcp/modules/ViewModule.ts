/**
 * 视口控制模块 — Gizmo 工具、2D/3D 模式、相机控制、网格、图标、参考图
 */

import { MCPModule, MCPTool } from '../decorators';

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('view', '视口控制 - Gizmo 工具切换、2D/3D 模式、相机聚焦/对齐、网格、参考图管理')
export class ViewModule {

    // ==================== Gizmo ====================

    @MCPTool('设置当前 Gizmo 变换工具', {
        tool: { type: 'string', description: '工具名: position/rotation/scale/rect', required: true },
    })
    async gizmo_tool(params: { tool: string }): Promise<any> {
        return callScene('set-gizmo-tool', params.tool);
    }

    @MCPTool('查询当前 Gizmo 工具', {})
    async gizmo_tool_query(): Promise<any> {
        return callScene('query-gizmo-tool');
    }

    @MCPTool('设置 Gizmo 枢轴模式', {
        pivot: { type: 'string', description: '枢轴模式: center/pivot', required: true },
    })
    async gizmo_pivot(params: { pivot: string }): Promise<any> {
        return callScene('set-gizmo-pivot', params.pivot);
    }

    @MCPTool('查询当前 Gizmo 枢轴模式', {})
    async gizmo_pivot_query(): Promise<any> {
        return callScene('query-gizmo-pivot');
    }

    @MCPTool('设置 Gizmo 坐标系', {
        coordinate: { type: 'string', description: '坐标系: local/global', required: true },
    })
    async gizmo_coordinate(params: { coordinate: string }): Promise<any> {
        return callScene('set-gizmo-coordinate', params.coordinate);
    }

    @MCPTool('查询当前坐标系', {})
    async gizmo_coordinate_query(): Promise<any> {
        return callScene('query-gizmo-coordinate');
    }

    // ==================== 2D/3D 模式 ====================

    @MCPTool('切换编辑模式 2D/3D', {
        is2D: { type: 'string', description: '"true"=2D 模式, "false"=3D 模式', required: true },
    })
    async mode_2d_3d(params: { is2D: string }): Promise<any> {
        return callScene('set-2d-3d-mode', params.is2D === 'true');
    }

    @MCPTool('查询当前编辑模式（2D/3D）', {})
    async mode_query(): Promise<any> {
        return callScene('query-2d-3d-mode');
    }

    // ==================== 网格 ====================

    @MCPTool('显示/隐藏场景网格', {
        visible: { type: 'string', description: '"true"=显示, "false"=隐藏', required: true },
    })
    async grid_set(params: { visible: string }): Promise<any> {
        return callScene('set-grid-visible', params.visible === 'true');
    }

    @MCPTool('查询网格是否可见', {})
    async grid_query(): Promise<any> {
        return callScene('query-grid-visible');
    }

    // ==================== 相机 ====================

    @MCPTool('将相机聚焦到指定节点', {
        nodes: { type: 'string', description: '节点 UUID（单个）或 JSON 数组字符串', required: true },
    })
    async camera_focus(params: { nodes: string }): Promise<any> {
        let uuids: string[];
        try { uuids = JSON.parse(params.nodes); } catch { uuids = [params.nodes]; }
        return callScene('focus-camera', uuids);
    }

    @MCPTool('将选中节点对齐到当前相机视图', {})
    async camera_align_view(): Promise<any> {
        return callScene('align-view-to-selection');
    }

    @MCPTool('将相机对齐到选中节点', {})
    async camera_align_node(): Promise<any> {
        return callScene('align-selection-to-view');
    }

    // ==================== 视口状态 ====================

    @MCPTool('获取当前场景视口状态（模式/网格/Gizmo 状态等）', {})
    async view_status(): Promise<any> {
        return callScene('query-view-status');
    }

    @MCPTool('重置场景视口为默认', {})
    async reset_view(): Promise<any> {
        return callScene('reset-view');
    }

    // ==================== 参考图 ====================

    @MCPTool('添加参考图到场景视图', {
        imageUrl: { type: 'string', description: '图片 URL', required: true },
        name: { type: 'string', description: '参考图名称（可选）' },
    })
    async ref_add(params: { imageUrl: string; name?: string }): Promise<any> {
        return callScene('add-reference-image', params.imageUrl, params.name);
    }

    @MCPTool('移除指定参考图', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
    })
    async ref_remove(params: { imageId: string }): Promise<any> {
        return callScene('remove-reference-image', params.imageId);
    }

    @MCPTool('切换活动参考图', {
        index: { type: 'string', description: '参考图索引', required: true },
    })
    async ref_switch(params: { index: string }): Promise<any> {
        return callScene('switch-reference-image', parseInt(params.index, 10));
    }

    @MCPTool('移除所有参考图', {})
    async ref_clear(): Promise<any> {
        return callScene('clear-reference-images');
    }

    @MCPTool('列出所有参考图', {})
    async ref_list(): Promise<any> {
        return callScene('list-reference-images');
    }

    @MCPTool('设置参考图位置', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        x: { type: 'string', description: 'X 位置' },
        y: { type: 'string', description: 'Y 位置' },
    })
    async ref_position(params: { imageId: string; x?: string; y?: string }): Promise<any> {
        return callScene('set-reference-image-position', params.imageId, params.x ? parseInt(params.x, 10) : 0, params.y ? parseInt(params.y, 10) : 0);
    }

    @MCPTool('设置参考图缩放', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        scale: { type: 'string', description: '缩放值', required: true },
    })
    async ref_scale(params: { imageId: string; scale: string }): Promise<any> {
        return callScene('set-reference-image-scale', params.imageId, parseFloat(params.scale));
    }

    @MCPTool('设置参考图透明度', {
        imageId: { type: 'string', description: '参考图 ID', required: true },
        opacity: { type: 'string', description: '透明度 0-1', required: true },
    })
    async ref_opacity(params: { imageId: string; opacity: string }): Promise<any> {
        return callScene('set-reference-image-opacity', params.imageId, parseFloat(params.opacity));
    }
}
