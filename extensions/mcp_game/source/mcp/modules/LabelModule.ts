/**
 * 标签/字体模块 — 文本管理、字体设置、样式设置、描边/阴影、批量操作
 */

import { MCPModule, MCPTool } from '../decorators';

async function executeSceneScript(method: string, args: any[] = []): Promise<any> {
    try {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'mcp_game',
            method,
            args,
        });
    } catch (e: any) {
        throw new Error(`场景脚本 '${method}' 失败: ${e.message || e}`);
    }
}

async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

@MCPModule('label', '文字标签 - 文本设置、字体管理、样式（描边/阴影/对齐）、批量操作')
export class LabelModule {

    // ==================== 查询 ====================

    @MCPTool('获取节点上的 Label 组件信息', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
    async label_info(params: { nodeUuid: string }): Promise<any> {
        return callScene('query-component', params.nodeUuid, 'cc.Label');
    }

    @MCPTool('列出场景中所有包含 Label 组件的节点', {
        filter: { type: 'string', description: '节点名称过滤（可选，子串匹配）' },
    })
    async list_label_nodes(params?: { filter?: string }): Promise<any> {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = params?.filter || '';
        const labelNodes: any[] = [];
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter)) continue;
            try {
                const info = await callScene('query-component', node.uuid, 'cc.Label');
                if (info) labelNodes.push({ uuid: node.uuid, name: node.name, text: info.string });
            } catch { /* 没有 Label 组件 */ }
        }
        return { count: labelNodes.length, nodes: labelNodes };
    }

    // ==================== 文本内容 ====================

    @MCPTool('设置 Label 文本内容', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        text: { type: 'string', description: '文本内容', required: true },
    })
    async set_text(params: { nodeUuid: string; text: string }): Promise<any> {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'string', params.text]);
        return { message: `文本已更新: "${params.text}"` };
    }

    // ==================== 字体 ====================

    @MCPTool('设置 Label 字体资源', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        font: { type: 'string', description: '字体资源路径（db://...）或 UUID。空字符串清除自定义字体使用系统字体', required: true },
    })
    async set_font(params: { nodeUuid: string; font: string }): Promise<any> {
        if (!params.font || params.font === '') {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'useSystemFont', true]);
            return { message: '已恢复为系统字体' };
        }
        // 设置为 false 才能使用自定义字体
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'useSystemFont', false]);
        if (params.font.startsWith('db://')) {
            // UUID 查询
            const uuid = await callScene('query-uuid', params.font);
            if (uuid) {
                await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'font', uuid]);
            }
        } else {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'font', params.font]);
        }
        return { message: `字体已更新: ${params.font}` };
    }

    @MCPTool('设置 Label 系统字体族（如 Arial, SimHei），需 useSystemFont=true', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        fontFamily: { type: 'string', description: '字体族名', required: true },
    })
    async set_font_family(params: { nodeUuid: string; fontFamily: string }): Promise<any> {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'fontFamily', params.fontFamily]);
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'useSystemFont', true]);
        return { message: `字体族已更新: ${params.fontFamily}` };
    }

    @MCPTool('批量设置场景中所有 Label 节点的字体', {
        font: { type: 'string', description: '字体资源路径或 UUID', required: true },
        filter: { type: 'string', description: '节点名称过滤（可选）' },
    })
    async batch_set_font(params: { font: string; filter?: string }): Promise<any> {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = params.filter || '';
        let updated = 0;
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter)) continue;
            try {
                const info = await callScene('query-component', node.uuid, 'cc.Label');
                if (info) {
                    await this.set_font({ nodeUuid: node.uuid, font: params.font });
                    updated++;
                }
            } catch { /* skip */ }
        }
        return { message: `已更新 ${updated} 个 Label 节点的字体` };
    }

    // ==================== 样式 ====================

    @MCPTool('设置 Label 文本样式（字号/粗体/斜体/下划线/对齐/换行/溢出模式/行高等）', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        fontSize: { type: 'string', description: '字号（可选）' },
        isBold: { type: 'string', description: '加粗: "true" 或 "false"（可选）' },
        isItalic: { type: 'string', description: '斜体: "true" 或 "false"（可选）' },
        isUnderline: { type: 'string', description: '下划线: "true" 或 "false"（可选）' },
        color: { type: 'string', description: '颜色 JSON 如 {"r":255,"g":255,"b":255,"a":255}（可选）' },
        horizontalAlign: { type: 'string', description: '水平对齐: LEFT/CENTER/RIGHT（可选）' },
        verticalAlign: { type: 'string', description: '垂直对齐: TOP/CENTER/BOTTOM（可选）' },
        lineHeight: { type: 'string', description: '行高（可选）' },
        enableWrapText: { type: 'string', description: '自动换行: "true" 或 "false"（可选）' },
        overflow: { type: 'string', description: '溢出模式: NONE/CLAMP/SHRINK/RESIZE_HEIGHT（可选）' },
        cacheMode: { type: 'string', description: '缓存模式: NONE/BITMAP/CHAR（可选）' },
        spacingX: { type: 'string', description: '字符间距（仅 BMFont）（可选）' },
        underlineHeight: { type: 'string', description: '下划线厚度（可选）' },
    })
    async set_style(params: {
        nodeUuid: string;
        fontSize?: string;
        isBold?: string;
        isItalic?: string;
        isUnderline?: string;
        color?: string;
        horizontalAlign?: string;
        verticalAlign?: string;
        lineHeight?: string;
        enableWrapText?: string;
        overflow?: string;
        cacheMode?: string;
        spacingX?: string;
        underlineHeight?: string;
    }): Promise<any> {
        const updates: string[] = [];
        if (params.fontSize) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'fontSize', parseInt(params.fontSize, 10)]);
            updates.push(`fontSize=${params.fontSize}`);
        }
        if (params.isBold !== undefined) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'isBold', params.isBold === 'true']);
            updates.push(`isBold=${params.isBold}`);
        }
        if (params.isItalic !== undefined) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'isItalic', params.isItalic === 'true']);
            updates.push(`isItalic=${params.isItalic}`);
        }
        if (params.isUnderline !== undefined) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'isUnderline', params.isUnderline === 'true']);
            updates.push(`isUnderline=${params.isUnderline}`);
        }
        if (params.color) {
            const color = JSON.parse(params.color);
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'color', color]);
            updates.push('color');
        }
        if (params.horizontalAlign) {
            const map: Record<string, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'horizontalAlign', map[params.horizontalAlign.toUpperCase()] ?? 1]);
            updates.push(`hAlign=${params.horizontalAlign}`);
        }
        if (params.verticalAlign) {
            const map: Record<string, number> = { TOP: 0, CENTER: 1, BOTTOM: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'verticalAlign', map[params.verticalAlign.toUpperCase()] ?? 1]);
            updates.push(`vAlign=${params.verticalAlign}`);
        }
        if (params.lineHeight) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'lineHeight', parseInt(params.lineHeight, 10)]);
            updates.push(`lineHeight=${params.lineHeight}`);
        }
        if (params.enableWrapText !== undefined) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'enableWrapText', params.enableWrapText === 'true']);
            updates.push(`wrap=${params.enableWrapText}`);
        }
        if (params.overflow) {
            const map: Record<string, number> = { NONE: 0, CLAMP: 1, SHRINK: 2, RESIZE_HEIGHT: 3 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'overflow', map[params.overflow.toUpperCase()] ?? 0]);
            updates.push(`overflow=${params.overflow}`);
        }
        if (params.cacheMode) {
            const map: Record<string, number> = { NONE: 0, BITMAP: 1, CHAR: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'cacheMode', map[params.cacheMode.toUpperCase()] ?? 0]);
            updates.push(`cacheMode=${params.cacheMode}`);
        }
        if (params.spacingX) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'spacingX', parseInt(params.spacingX, 10)]);
            updates.push(`spacingX=${params.spacingX}`);
        }
        if (params.underlineHeight) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'underlineHeight', parseInt(params.underlineHeight, 10)]);
            updates.push(`underlineHeight=${params.underlineHeight}`);
        }
        return { message: `样式已更新: ${updates.join(', ') || '无变化'}` };
    }

    @MCPTool('批量设置场景中所有 Label 节点的样式', {
        fontSize: { type: 'string', description: '字号（可选）' },
        isBold: { type: 'string', description: '加粗（可选）' },
        isItalic: { type: 'string', description: '斜体（可选）' },
        color: { type: 'string', description: '颜色 JSON（可选）' },
        filter: { type: 'string', description: '节点名称过滤（可选）' },
    })
    async batch_set_style(params: {
        fontSize?: string;
        isBold?: string;
        isItalic?: string;
        color?: string;
        filter?: string;
    }): Promise<any> {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = params.filter || '';
        let updated = 0;
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter)) continue;
            try {
                await callScene('query-component', node.uuid, 'cc.Label');
                await this.set_style({
                    nodeUuid: node.uuid,
                    fontSize: params.fontSize,
                    isBold: params.isBold,
                    isItalic: params.isItalic,
                    color: params.color,
                });
                updated++;
            } catch { /* skip */ }
        }
        return { message: `已更新 ${updated} 个 Label 节点的样式` };
    }

    // ==================== 描边 ====================

    @MCPTool('设置 Label 描边效果', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        enabled: { type: 'string', description: '启用: "true" 或 "false"', required: true },
        color: { type: 'string', description: '描边颜色 JSON（可选）' },
        width: { type: 'string', description: '描边宽度（可选）' },
    })
    async set_outline(params: { nodeUuid: string; enabled: string; color?: string; width?: string }): Promise<any> {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'enableOutline', params.enabled === 'true']);
        if (params.color) {
            const color = JSON.parse(params.color);
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'outlineColor', color]);
        }
        if (params.width) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'outlineWidth', parseInt(params.width, 10)]);
        }
        return { message: `描边 ${params.enabled === 'true' ? '已启用' : '已禁用'}` };
    }

    // ==================== 阴影 ====================

    @MCPTool('设置 Label 阴影效果', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        enabled: { type: 'string', description: '启用: "true" 或 "false"', required: true },
        color: { type: 'string', description: '阴影颜色 JSON（可选）' },
        offset: { type: 'string', description: '阴影偏移 JSON 如 {"x":2,"y":2}（可选）' },
        blur: { type: 'string', description: '阴影模糊（可选）' },
    })
    async set_shadow(params: { nodeUuid: string; enabled: string; color?: string; offset?: string; blur?: string }): Promise<any> {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'enableShadow', params.enabled === 'true']);
        if (params.color) {
            const color = JSON.parse(params.color);
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'shadowColor', color]);
        }
        if (params.offset) {
            const offset = JSON.parse(params.offset);
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'shadowOffset', offset]);
        }
        if (params.blur) {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'shadowBlur', parseInt(params.blur, 10)]);
        }
        return { message: `阴影 ${params.enabled === 'true' ? '已启用' : '已禁用'}` };
    }
}
