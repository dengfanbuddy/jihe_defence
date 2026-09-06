"use strict";
/**
 * 标签/字体模块 — 文本管理、字体设置、样式设置、描边/阴影、批量操作
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LabelModule = void 0;
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
let LabelModule = class LabelModule {
    // ==================== 查询 ====================
    async label_info(params) {
        return callScene('query-component', params.nodeUuid, 'cc.Label');
    }
    async list_label_nodes(params) {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = (params === null || params === void 0 ? void 0 : params.filter) || '';
        const labelNodes = [];
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter))
                continue;
            try {
                const info = await callScene('query-component', node.uuid, 'cc.Label');
                if (info)
                    labelNodes.push({ uuid: node.uuid, name: node.name, text: info.string });
            }
            catch ( /* 没有 Label 组件 */_a) { /* 没有 Label 组件 */ }
        }
        return { count: labelNodes.length, nodes: labelNodes };
    }
    // ==================== 文本内容 ====================
    async set_text(params) {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'string', params.text]);
        return { message: `文本已更新: "${params.text}"` };
    }
    // ==================== 字体 ====================
    async set_font(params) {
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
        }
        else {
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'font', params.font]);
        }
        return { message: `字体已更新: ${params.font}` };
    }
    async set_font_family(params) {
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'fontFamily', params.fontFamily]);
        await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'useSystemFont', true]);
        return { message: `字体族已更新: ${params.fontFamily}` };
    }
    async batch_set_font(params) {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = params.filter || '';
        let updated = 0;
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter))
                continue;
            try {
                const info = await callScene('query-component', node.uuid, 'cc.Label');
                if (info) {
                    await this.set_font({ nodeUuid: node.uuid, font: params.font });
                    updated++;
                }
            }
            catch ( /* skip */_a) { /* skip */ }
        }
        return { message: `已更新 ${updated} 个 Label 节点的字体` };
    }
    // ==================== 样式 ====================
    async set_style(params) {
        var _a, _b, _c, _d;
        const updates = [];
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
            const map = { LEFT: 0, CENTER: 1, RIGHT: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'horizontalAlign', (_a = map[params.horizontalAlign.toUpperCase()]) !== null && _a !== void 0 ? _a : 1]);
            updates.push(`hAlign=${params.horizontalAlign}`);
        }
        if (params.verticalAlign) {
            const map = { TOP: 0, CENTER: 1, BOTTOM: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'verticalAlign', (_b = map[params.verticalAlign.toUpperCase()]) !== null && _b !== void 0 ? _b : 1]);
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
            const map = { NONE: 0, CLAMP: 1, SHRINK: 2, RESIZE_HEIGHT: 3 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'overflow', (_c = map[params.overflow.toUpperCase()]) !== null && _c !== void 0 ? _c : 0]);
            updates.push(`overflow=${params.overflow}`);
        }
        if (params.cacheMode) {
            const map = { NONE: 0, BITMAP: 1, CHAR: 2 };
            await executeSceneScript('setComponentProperty', [params.nodeUuid, 'cc.Label', 'cacheMode', (_d = map[params.cacheMode.toUpperCase()]) !== null && _d !== void 0 ? _d : 0]);
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
    async batch_set_style(params) {
        const allNodes = await executeSceneScript('getAllNodes');
        const filter = params.filter || '';
        let updated = 0;
        for (const node of (allNodes.data || [])) {
            if (filter && !node.name.includes(filter))
                continue;
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
            }
            catch ( /* skip */_a) { /* skip */ }
        }
        return { message: `已更新 ${updated} 个 Label 节点的样式` };
    }
    // ==================== 描边 ====================
    async set_outline(params) {
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
    async set_shadow(params) {
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
};
exports.LabelModule = LabelModule;
__decorate([
    (0, decorators_1.MCPTool)('获取节点上的 Label 组件信息', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
    })
], LabelModule.prototype, "label_info", null);
__decorate([
    (0, decorators_1.MCPTool)('列出场景中所有包含 Label 组件的节点', {
        filter: { type: 'string', description: '节点名称过滤（可选，子串匹配）' },
    })
], LabelModule.prototype, "list_label_nodes", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 文本内容', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        text: { type: 'string', description: '文本内容', required: true },
    })
], LabelModule.prototype, "set_text", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 字体资源', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        font: { type: 'string', description: '字体资源路径（db://...）或 UUID。空字符串清除自定义字体使用系统字体', required: true },
    })
], LabelModule.prototype, "set_font", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 系统字体族（如 Arial, SimHei），需 useSystemFont=true', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        fontFamily: { type: 'string', description: '字体族名', required: true },
    })
], LabelModule.prototype, "set_font_family", null);
__decorate([
    (0, decorators_1.MCPTool)('批量设置场景中所有 Label 节点的字体', {
        font: { type: 'string', description: '字体资源路径或 UUID', required: true },
        filter: { type: 'string', description: '节点名称过滤（可选）' },
    })
], LabelModule.prototype, "batch_set_font", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 文本样式（字号/粗体/斜体/下划线/对齐/换行/溢出模式/行高等）', {
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
], LabelModule.prototype, "set_style", null);
__decorate([
    (0, decorators_1.MCPTool)('批量设置场景中所有 Label 节点的样式', {
        fontSize: { type: 'string', description: '字号（可选）' },
        isBold: { type: 'string', description: '加粗（可选）' },
        isItalic: { type: 'string', description: '斜体（可选）' },
        color: { type: 'string', description: '颜色 JSON（可选）' },
        filter: { type: 'string', description: '节点名称过滤（可选）' },
    })
], LabelModule.prototype, "batch_set_style", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 描边效果', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        enabled: { type: 'string', description: '启用: "true" 或 "false"', required: true },
        color: { type: 'string', description: '描边颜色 JSON（可选）' },
        width: { type: 'string', description: '描边宽度（可选）' },
    })
], LabelModule.prototype, "set_outline", null);
__decorate([
    (0, decorators_1.MCPTool)('设置 Label 阴影效果', {
        nodeUuid: { type: 'string', description: '节点 UUID', required: true },
        enabled: { type: 'string', description: '启用: "true" 或 "false"', required: true },
        color: { type: 'string', description: '阴影颜色 JSON（可选）' },
        offset: { type: 'string', description: '阴影偏移 JSON 如 {"x":2,"y":2}（可选）' },
        blur: { type: 'string', description: '阴影模糊（可选）' },
    })
], LabelModule.prototype, "set_shadow", null);
exports.LabelModule = LabelModule = __decorate([
    (0, decorators_1.MCPModule)('label', '文字标签 - 文本设置、字体管理、样式（描边/阴影/对齐）、批量操作')
], LabelModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTGFiZWxNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvTGFiZWxNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOztHQUVHOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFFbkQsS0FBSyxVQUFVLGtCQUFrQixDQUFDLE1BQWMsRUFBRSxPQUFjLEVBQUU7SUFDOUQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxzQkFBc0IsRUFBRTtZQUNqRSxJQUFJLEVBQUUsVUFBVTtZQUNoQixNQUFNO1lBQ04sSUFBSTtTQUNQLENBQUMsQ0FBQztJQUNQLENBQUM7SUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO1FBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLE1BQU0sU0FBUyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDOUQsQ0FBQztBQUNMLENBQUM7QUFFRCxLQUFLLFVBQVUsU0FBUyxDQUFDLE1BQWMsRUFBRSxHQUFHLElBQVc7SUFDbkQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNkLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxNQUFNLFNBQVMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7QUFDTCxDQUFDO0FBR00sSUFBTSxXQUFXLEdBQWpCLE1BQU0sV0FBVztJQUVwQiwrQ0FBK0M7SUFLekMsQUFBTixLQUFLLENBQUMsVUFBVSxDQUFDLE1BQTRCO1FBQ3pDLE9BQU8sU0FBUyxDQUFDLGlCQUFpQixFQUFFLE1BQU0sQ0FBQyxRQUFR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QUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsZUFBZSxFQUFFO1FBQ3ZELEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRTtLQUNyRCxDQUFDOzhDQVdEO0FBV0s7SUFQTCxJQUFBLG9CQUFPLEVBQUMsZUFBZSxFQUFFO1FBQ3RCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ3BFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHNCQUFzQixFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDaEYsS0FBSyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsZUFBZSxFQUFFO1FBQ3ZELE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLCtCQUErQixFQUFFO1FBQ3hFLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRTtLQUNwRCxDQUFDOzZDQWVEO3NCQTNRUSxXQUFXO0lBRHZCLElBQUEsc0JBQVMsRUFBQyxPQUFPLEVBQUUsb0NBQW9DLENBQUM7R0FDNUMsV0FBVyxDQTRRdkIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOagh+etvi/lrZfkvZPmqKHlnZcg4oCUIOaWh+acrOeuoeeQhuOAgeWtl+S9k+iuvue9ruOAgeagt+W8j+iuvue9ruOAgeaPj+i+uS/pmLTlvbHjgIHmibnph4/mk43kvZxcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNjZW5lU2NyaXB0KG1ldGhvZDogc3RyaW5nLCBhcmdzOiBhbnlbXSA9IFtdKTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiAnbWNwX2dhbWUnLFxuICAgICAgICAgICAgbWV0aG9kLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv6ISa5pysICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTY2VuZShtZXRob2Q6IHN0cmluZywgLi4uYXJnczogYW55W10pOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIG1ldGhvZCwgLi4uYXJncyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5raI5oGvICcke21ldGhvZH0nIOWksei0pTogJHtlLm1lc3NhZ2UgfHwgZX1gKTtcbiAgICB9XG59XG5cbkBNQ1BNb2R1bGUoJ2xhYmVsJywgJ+aWh+Wtl+agh+etviAtIOaWh+acrOiuvue9ruOAgeWtl+S9k+euoeeQhuOAgeagt+W8j++8iOaPj+i+uS/pmLTlvbEv5a+56b2Q77yJ44CB5om56YeP5pON5L2cJylcbmV4cG9ydCBjbGFzcyBMYWJlbE1vZHVsZSB7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDmn6Xor6IgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfojrflj5boioLngrnkuIrnmoQgTGFiZWwg57uE5Lu25L+h5oGvJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBsYWJlbF9pbmZvKHBhcmFtczogeyBub2RlVXVpZDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICByZXR1cm4gY2FsbFNjZW5lKCdxdWVyeS1jb21wb25lbnQnLCBwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcpO1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfliJflh7rlnLrmma/kuK3miYDmnInljIXlkKsgTGFiZWwg57uE5Lu255qE6IqC54K5Jywge1xuICAgICAgICBmaWx0ZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCN56ew6L+H5ruk77yI5Y+v6YCJ77yM5a2Q5Liy5Yy56YWN77yJJyB9LFxuICAgIH0pXG4gICAgYXN5bmMgbGlzdF9sYWJlbF9ub2RlcyhwYXJhbXM/OiB7IGZpbHRlcj86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgY29uc3QgYWxsTm9kZXMgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2dldEFsbE5vZGVzJyk7XG4gICAgICAgIGNvbnN0IGZpbHRlciA9IHBhcmFtcz8uZmlsdGVyIHx8ICcnO1xuICAgICAgICBjb25zdCBsYWJlbE5vZGVzOiBhbnlbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgKGFsbE5vZGVzLmRhdGEgfHwgW10pKSB7XG4gICAgICAgICAgICBpZiAoZmlsdGVyICYmICFub2RlLm5hbWUuaW5jbHVkZXMoZmlsdGVyKSkgY29udGludWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBjYWxsU2NlbmUoJ3F1ZXJ5LWNvbXBvbmVudCcsIG5vZGUudXVpZCwgJ2NjLkxhYmVsJyk7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8pIGxhYmVsTm9kZXMucHVzaCh7IHV1aWQ6IG5vZGUudXVpZCwgbmFtZTogbm9kZS5uYW1lLCB0ZXh0OiBpbmZvLnN0cmluZyB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiDmsqHmnIkgTGFiZWwg57uE5Lu2ICovIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBjb3VudDogbGFiZWxOb2Rlcy5sZW5ndGgsIG5vZGVzOiBsYWJlbE5vZGVzIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5paH5pys5YaF5a65ID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6K6+572uIExhYmVsIOaWh+acrOWGheWuuScsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICB0ZXh0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWh+acrOWGheWuuScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfdGV4dChwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ3N0cmluZycsIHBhcmFtcy50ZXh0XSk7XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDmlofmnKzlt7Lmm7TmlrA6IFwiJHtwYXJhbXMudGV4dH1cImAgfTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDlrZfkvZMgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCforr7nva4gTGFiZWwg5a2X5L2T6LWE5rqQJywge1xuICAgICAgICBub2RlVXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGZvbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5a2X5L2T6LWE5rqQ6Lev5b6E77yIZGI6Ly8uLi7vvInmiJYgVVVJROOAguepuuWtl+espuS4sua4hemZpOiHquWumuS5ieWtl+S9k+S9v+eUqOezu+e7n+Wtl+S9kycsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfZm9udChwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgZm9udDogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBpZiAoIXBhcmFtcy5mb250IHx8IHBhcmFtcy5mb250ID09PSAnJykge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICd1c2VTeXN0ZW1Gb250JywgdHJ1ZV0pO1xuICAgICAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogJ+W3suaBouWkjeS4uuezu+e7n+Wtl+S9kycgfTtcbiAgICAgICAgfVxuICAgICAgICAvLyDorr7nva7kuLogZmFsc2Ug5omN6IO95L2/55So6Ieq5a6a5LmJ5a2X5L2TXG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAndXNlU3lzdGVtRm9udCcsIGZhbHNlXSk7XG4gICAgICAgIGlmIChwYXJhbXMuZm9udC5zdGFydHNXaXRoKCdkYjovLycpKSB7XG4gICAgICAgICAgICAvLyBVVUlEIOafpeivolxuICAgICAgICAgICAgY29uc3QgdXVpZCA9IGF3YWl0IGNhbGxTY2VuZSgncXVlcnktdXVpZCcsIHBhcmFtcy5mb250KTtcbiAgICAgICAgICAgIGlmICh1dWlkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdmb250JywgdXVpZF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdmb250JywgcGFyYW1zLmZvbnRdKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiBg5a2X5L2T5bey5pu05pawOiAke3BhcmFtcy5mb250fWAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn6K6+572uIExhYmVsIOezu+e7n+Wtl+S9k+aXj++8iOWmgiBBcmlhbCwgU2ltSGVp77yJ77yM6ZyAIHVzZVN5c3RlbUZvbnQ9dHJ1ZScsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBmb250RmFtaWx5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+Wtl+S9k+aXj+WQjScsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfZm9udF9mYW1pbHkocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IGZvbnRGYW1pbHk6IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdmb250RmFtaWx5JywgcGFyYW1zLmZvbnRGYW1pbHldKTtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICd1c2VTeXN0ZW1Gb250JywgdHJ1ZV0pO1xuICAgICAgICByZXR1cm4geyBtZXNzYWdlOiBg5a2X5L2T5peP5bey5pu05pawOiAke3BhcmFtcy5mb250RmFtaWx5fWAgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5om56YeP6K6+572u5Zy65pmv5Lit5omA5pyJIExhYmVsIOiKgueCueeahOWtl+S9kycsIHtcbiAgICAgICAgZm9udDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflrZfkvZPotYTmupDot6/lvoTmiJYgVVVJRCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGZpbHRlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnlkI3np7Dov4fmu6TvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBiYXRjaF9zZXRfZm9udChwYXJhbXM6IHsgZm9udDogc3RyaW5nOyBmaWx0ZXI/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IGFsbE5vZGVzID0gYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdnZXRBbGxOb2RlcycpO1xuICAgICAgICBjb25zdCBmaWx0ZXIgPSBwYXJhbXMuZmlsdGVyIHx8ICcnO1xuICAgICAgICBsZXQgdXBkYXRlZCA9IDA7XG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiAoYWxsTm9kZXMuZGF0YSB8fCBbXSkpIHtcbiAgICAgICAgICAgIGlmIChmaWx0ZXIgJiYgIW5vZGUubmFtZS5pbmNsdWRlcyhmaWx0ZXIpKSBjb250aW51ZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGNhbGxTY2VuZSgncXVlcnktY29tcG9uZW50Jywgbm9kZS51dWlkLCAnY2MuTGFiZWwnKTtcbiAgICAgICAgICAgICAgICBpZiAoaW5mbykge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnNldF9mb250KHsgbm9kZVV1aWQ6IG5vZGUudXVpZCwgZm9udDogcGFyYW1zLmZvbnQgfSk7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZWQrKztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogc2tpcCAqLyB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogYOW3suabtOaWsCAke3VwZGF0ZWR9IOS4qiBMYWJlbCDoioLngrnnmoTlrZfkvZNgIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5qC35byPID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6K6+572uIExhYmVsIOaWh+acrOagt+W8j++8iOWtl+WPty/nspfkvZMv5pac5L2TL+S4i+WIkue6vy/lr7npvZAv5o2i6KGML+a6ouWHuuaooeW8jy/ooYzpq5jnrYnvvIknLCB7XG4gICAgICAgIG5vZGVVdWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSBVVUlEJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgZm9udFNpemU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5a2X5Y+377yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBpc0JvbGQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Yqg57KXOiBcInRydWVcIiDmiJYgXCJmYWxzZVwi77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBpc0l0YWxpYzogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlpzkvZM6IFwidHJ1ZVwiIOaIliBcImZhbHNlXCLvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIGlzVW5kZXJsaW5lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+S4i+WIkue6vzogXCJ0cnVlXCIg5oiWIFwiZmFsc2VcIu+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgY29sb3I6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKc6ImyIEpTT04g5aaCIHtcInJcIjoyNTUsXCJnXCI6MjU1LFwiYlwiOjI1NSxcImFcIjoyNTV977yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBob3Jpem9udGFsQWxpZ246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5rC05bmz5a+56b2QOiBMRUZUL0NFTlRFUi9SSUdIVO+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgdmVydGljYWxBbGlnbjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflnoLnm7Tlr7npvZA6IFRPUC9DRU5URVIvQk9UVE9N77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBsaW5lSGVpZ2h0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ihjOmrmO+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgZW5hYmxlV3JhcFRleHQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6Ieq5Yqo5o2i6KGMOiBcInRydWVcIiDmiJYgXCJmYWxzZVwi77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBvdmVyZmxvdzogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmuqLlh7rmqKHlvI86IE5PTkUvQ0xBTVAvU0hSSU5LL1JFU0laRV9IRUlHSFTvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIGNhY2hlTW9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnvJPlrZjmqKHlvI86IE5PTkUvQklUTUFQL0NIQVLvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIHNwYWNpbmdYOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+Wtl+espumXtOi3ne+8iOS7hSBCTUZvbnTvvInvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIHVuZGVybGluZUhlaWdodDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfkuIvliJLnur/ljprluqbvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfc3R5bGUocGFyYW1zOiB7XG4gICAgICAgIG5vZGVVdWlkOiBzdHJpbmc7XG4gICAgICAgIGZvbnRTaXplPzogc3RyaW5nO1xuICAgICAgICBpc0JvbGQ/OiBzdHJpbmc7XG4gICAgICAgIGlzSXRhbGljPzogc3RyaW5nO1xuICAgICAgICBpc1VuZGVybGluZT86IHN0cmluZztcbiAgICAgICAgY29sb3I/OiBzdHJpbmc7XG4gICAgICAgIGhvcml6b250YWxBbGlnbj86IHN0cmluZztcbiAgICAgICAgdmVydGljYWxBbGlnbj86IHN0cmluZztcbiAgICAgICAgbGluZUhlaWdodD86IHN0cmluZztcbiAgICAgICAgZW5hYmxlV3JhcFRleHQ/OiBzdHJpbmc7XG4gICAgICAgIG92ZXJmbG93Pzogc3RyaW5nO1xuICAgICAgICBjYWNoZU1vZGU/OiBzdHJpbmc7XG4gICAgICAgIHNwYWNpbmdYPzogc3RyaW5nO1xuICAgICAgICB1bmRlcmxpbmVIZWlnaHQ/OiBzdHJpbmc7XG4gICAgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGNvbnN0IHVwZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmIChwYXJhbXMuZm9udFNpemUpIHtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAnZm9udFNpemUnLCBwYXJzZUludChwYXJhbXMuZm9udFNpemUsIDEwKV0pO1xuICAgICAgICAgICAgdXBkYXRlcy5wdXNoKGBmb250U2l6ZT0ke3BhcmFtcy5mb250U2l6ZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyYW1zLmlzQm9sZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ2lzQm9sZCcsIHBhcmFtcy5pc0JvbGQgPT09ICd0cnVlJ10pO1xuICAgICAgICAgICAgdXBkYXRlcy5wdXNoKGBpc0JvbGQ9JHtwYXJhbXMuaXNCb2xkfWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMuaXNJdGFsaWMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdpc0l0YWxpYycsIHBhcmFtcy5pc0l0YWxpYyA9PT0gJ3RydWUnXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goYGlzSXRhbGljPSR7cGFyYW1zLmlzSXRhbGljfWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMuaXNVbmRlcmxpbmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdpc1VuZGVybGluZScsIHBhcmFtcy5pc1VuZGVybGluZSA9PT0gJ3RydWUnXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goYGlzVW5kZXJsaW5lPSR7cGFyYW1zLmlzVW5kZXJsaW5lfWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMuY29sb3IpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbG9yID0gSlNPTi5wYXJzZShwYXJhbXMuY29sb3IpO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdjb2xvcicsIGNvbG9yXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goJ2NvbG9yJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy5ob3Jpem9udGFsQWxpZ24pIHtcbiAgICAgICAgICAgIGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHsgTEVGVDogMCwgQ0VOVEVSOiAxLCBSSUdIVDogMiB9O1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdob3Jpem9udGFsQWxpZ24nLCBtYXBbcGFyYW1zLmhvcml6b250YWxBbGlnbi50b1VwcGVyQ2FzZSgpXSA/PyAxXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goYGhBbGlnbj0ke3BhcmFtcy5ob3Jpem9udGFsQWxpZ259YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy52ZXJ0aWNhbEFsaWduKSB7XG4gICAgICAgICAgICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IFRPUDogMCwgQ0VOVEVSOiAxLCBCT1RUT006IDIgfTtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAndmVydGljYWxBbGlnbicsIG1hcFtwYXJhbXMudmVydGljYWxBbGlnbi50b1VwcGVyQ2FzZSgpXSA/PyAxXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goYHZBbGlnbj0ke3BhcmFtcy52ZXJ0aWNhbEFsaWdufWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMubGluZUhlaWdodCkge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdsaW5lSGVpZ2h0JywgcGFyc2VJbnQocGFyYW1zLmxpbmVIZWlnaHQsIDEwKV0pO1xuICAgICAgICAgICAgdXBkYXRlcy5wdXNoKGBsaW5lSGVpZ2h0PSR7cGFyYW1zLmxpbmVIZWlnaHR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy5lbmFibGVXcmFwVGV4dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ2VuYWJsZVdyYXBUZXh0JywgcGFyYW1zLmVuYWJsZVdyYXBUZXh0ID09PSAndHJ1ZSddKTtcbiAgICAgICAgICAgIHVwZGF0ZXMucHVzaChgd3JhcD0ke3BhcmFtcy5lbmFibGVXcmFwVGV4dH1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyYW1zLm92ZXJmbG93KSB7XG4gICAgICAgICAgICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IE5PTkU6IDAsIENMQU1QOiAxLCBTSFJJTks6IDIsIFJFU0laRV9IRUlHSFQ6IDMgfTtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAnb3ZlcmZsb3cnLCBtYXBbcGFyYW1zLm92ZXJmbG93LnRvVXBwZXJDYXNlKCldID8/IDBdKTtcbiAgICAgICAgICAgIHVwZGF0ZXMucHVzaChgb3ZlcmZsb3c9JHtwYXJhbXMub3ZlcmZsb3d9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy5jYWNoZU1vZGUpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHsgTk9ORTogMCwgQklUTUFQOiAxLCBDSEFSOiAyIH07XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ2NhY2hlTW9kZScsIG1hcFtwYXJhbXMuY2FjaGVNb2RlLnRvVXBwZXJDYXNlKCldID8/IDBdKTtcbiAgICAgICAgICAgIHVwZGF0ZXMucHVzaChgY2FjaGVNb2RlPSR7cGFyYW1zLmNhY2hlTW9kZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyYW1zLnNwYWNpbmdYKSB7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ3NwYWNpbmdYJywgcGFyc2VJbnQocGFyYW1zLnNwYWNpbmdYLCAxMCldKTtcbiAgICAgICAgICAgIHVwZGF0ZXMucHVzaChgc3BhY2luZ1g9JHtwYXJhbXMuc3BhY2luZ1h9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy51bmRlcmxpbmVIZWlnaHQpIHtcbiAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAndW5kZXJsaW5lSGVpZ2h0JywgcGFyc2VJbnQocGFyYW1zLnVuZGVybGluZUhlaWdodCwgMTApXSk7XG4gICAgICAgICAgICB1cGRhdGVzLnB1c2goYHVuZGVybGluZUhlaWdodD0ke3BhcmFtcy51bmRlcmxpbmVIZWlnaHR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogYOagt+W8j+W3suabtOaWsDogJHt1cGRhdGVzLmpvaW4oJywgJykgfHwgJ+aXoOWPmOWMlid9YCB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmibnph4/orr7nva7lnLrmma/kuK3miYDmnIkgTGFiZWwg6IqC54K555qE5qC35byPJywge1xuICAgICAgICBmb250U2l6ZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflrZflj7fvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIGlzQm9sZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfliqDnspfvvIjlj6/pgInvvIknIH0sXG4gICAgICAgIGlzSXRhbGljOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWnOS9k++8iOWPr+mAie+8iScgfSxcbiAgICAgICAgY29sb3I6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKc6ImyIEpTT07vvIjlj6/pgInvvIknIH0sXG4gICAgICAgIGZpbHRlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnlkI3np7Dov4fmu6TvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBiYXRjaF9zZXRfc3R5bGUocGFyYW1zOiB7XG4gICAgICAgIGZvbnRTaXplPzogc3RyaW5nO1xuICAgICAgICBpc0JvbGQ/OiBzdHJpbmc7XG4gICAgICAgIGlzSXRhbGljPzogc3RyaW5nO1xuICAgICAgICBjb2xvcj86IHN0cmluZztcbiAgICAgICAgZmlsdGVyPzogc3RyaW5nO1xuICAgIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCBhbGxOb2RlcyA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnZ2V0QWxsTm9kZXMnKTtcbiAgICAgICAgY29uc3QgZmlsdGVyID0gcGFyYW1zLmZpbHRlciB8fCAnJztcbiAgICAgICAgbGV0IHVwZGF0ZWQgPSAwO1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgKGFsbE5vZGVzLmRhdGEgfHwgW10pKSB7XG4gICAgICAgICAgICBpZiAoZmlsdGVyICYmICFub2RlLm5hbWUuaW5jbHVkZXMoZmlsdGVyKSkgY29udGludWU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGF3YWl0IGNhbGxTY2VuZSgncXVlcnktY29tcG9uZW50Jywgbm9kZS51dWlkLCAnY2MuTGFiZWwnKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnNldF9zdHlsZSh7XG4gICAgICAgICAgICAgICAgICAgIG5vZGVVdWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBwYXJhbXMuZm9udFNpemUsXG4gICAgICAgICAgICAgICAgICAgIGlzQm9sZDogcGFyYW1zLmlzQm9sZCxcbiAgICAgICAgICAgICAgICAgICAgaXNJdGFsaWM6IHBhcmFtcy5pc0l0YWxpYyxcbiAgICAgICAgICAgICAgICAgICAgY29sb3I6IHBhcmFtcy5jb2xvcixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB1cGRhdGVkKys7XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogc2tpcCAqLyB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgbWVzc2FnZTogYOW3suabtOaWsCAke3VwZGF0ZWR9IOS4qiBMYWJlbCDoioLngrnnmoTmoLflvI9gIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5o+P6L65ID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6K6+572uIExhYmVsIOaPj+i+ueaViOaenCcsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBlbmFibGVkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WQr+eUqDogXCJ0cnVlXCIg5oiWIFwiZmFsc2VcIicsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGNvbG9yOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aPj+i+ueminOiJsiBKU09O77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICB3aWR0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmj4/ovrnlrr3luqbvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBzZXRfb3V0bGluZShwYXJhbXM6IHsgbm9kZVV1aWQ6IHN0cmluZzsgZW5hYmxlZDogc3RyaW5nOyBjb2xvcj86IHN0cmluZzsgd2lkdGg/OiBzdHJpbmcgfSk6IFByb21pc2U8YW55PiB7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbcGFyYW1zLm5vZGVVdWlkLCAnY2MuTGFiZWwnLCAnZW5hYmxlT3V0bGluZScsIHBhcmFtcy5lbmFibGVkID09PSAndHJ1ZSddKTtcbiAgICAgICAgaWYgKHBhcmFtcy5jb2xvcikge1xuICAgICAgICAgICAgY29uc3QgY29sb3IgPSBKU09OLnBhcnNlKHBhcmFtcy5jb2xvcik7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ291dGxpbmVDb2xvcicsIGNvbG9yXSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy53aWR0aCkge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdvdXRsaW5lV2lkdGgnLCBwYXJzZUludChwYXJhbXMud2lkdGgsIDEwKV0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDmj4/ovrkgJHtwYXJhbXMuZW5hYmxlZCA9PT0gJ3RydWUnID8gJ+W3suWQr+eUqCcgOiAn5bey56aB55SoJ31gIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g6Zi05b2xID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn6K6+572uIExhYmVsIOmYtOW9seaViOaenCcsIHtcbiAgICAgICAgbm9kZVV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IFVVSUQnLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgICBlbmFibGVkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WQr+eUqDogXCJ0cnVlXCIg5oiWIFwiZmFsc2VcIicsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgIGNvbG9yOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mYtOW9seminOiJsiBKU09O77yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBvZmZzZXQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6Zi05b2x5YGP56e7IEpTT04g5aaCIHtcInhcIjoyLFwieVwiOjJ977yI5Y+v6YCJ77yJJyB9LFxuICAgICAgICBibHVyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mYtOW9seaooeeziu+8iOWPr+mAie+8iScgfSxcbiAgICB9KVxuICAgIGFzeW5jIHNldF9zaGFkb3cocGFyYW1zOiB7IG5vZGVVdWlkOiBzdHJpbmc7IGVuYWJsZWQ6IHN0cmluZzsgY29sb3I/OiBzdHJpbmc7IG9mZnNldD86IHN0cmluZzsgYmx1cj86IHN0cmluZyB9KTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdlbmFibGVTaGFkb3cnLCBwYXJhbXMuZW5hYmxlZCA9PT0gJ3RydWUnXSk7XG4gICAgICAgIGlmIChwYXJhbXMuY29sb3IpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbG9yID0gSlNPTi5wYXJzZShwYXJhbXMuY29sb3IpO1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdzaGFkb3dDb2xvcicsIGNvbG9yXSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcmFtcy5vZmZzZXQpIHtcbiAgICAgICAgICAgIGNvbnN0IG9mZnNldCA9IEpTT04ucGFyc2UocGFyYW1zLm9mZnNldCk7XG4gICAgICAgICAgICBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ3NldENvbXBvbmVudFByb3BlcnR5JywgW3BhcmFtcy5ub2RlVXVpZCwgJ2NjLkxhYmVsJywgJ3NoYWRvd09mZnNldCcsIG9mZnNldF0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXMuYmx1cikge1xuICAgICAgICAgICAgYXdhaXQgZXhlY3V0ZVNjZW5lU2NyaXB0KCdzZXRDb21wb25lbnRQcm9wZXJ0eScsIFtwYXJhbXMubm9kZVV1aWQsICdjYy5MYWJlbCcsICdzaGFkb3dCbHVyJywgcGFyc2VJbnQocGFyYW1zLmJsdXIsIDEwKV0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG1lc3NhZ2U6IGDpmLTlvbEgJHtwYXJhbXMuZW5hYmxlZCA9PT0gJ3RydWUnID8gJ+W3suWQr+eUqCcgOiAn5bey56aB55SoJ31gIH07XG4gICAgfVxufVxuIl19