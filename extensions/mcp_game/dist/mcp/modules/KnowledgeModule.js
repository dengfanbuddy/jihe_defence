"use strict";
/**
 * 知识库模块 — 提供 Cocos Creator 知识查询功能
 *
 * 混合模式：关键摘要嵌入 initialize instructions，详细内容通过工具查询。
 * 主题：component_properties / ui_design_rules / layout_patterns /
 *       widget_strategy / node_structure / animation_patterns / best_practices
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeModule = void 0;
const decorators_1 = require("../decorators");
const knowledgeData_1 = require("../knowledge/knowledgeData");
let KnowledgeModule = class KnowledgeModule {
    // ==================== 主题查询 ====================
    knowledge_list_topics() {
        return {
            topics: knowledgeData_1.KNOWLEDGE_TOPICS.map(t => ({
                name: t.name,
                title: t.title,
                description: t.description,
                itemCount: t.count,
            })),
        };
    }
    knowledge_query(params) {
        var _a;
        const topic = (_a = params.topic) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase();
        switch (topic) {
            case 'component_properties':
                return { topic, data: knowledgeData_1.COMPONENT_PROPERTIES };
            case 'ui_design_rules':
                return { topic, data: knowledgeData_1.UI_DESIGN_RULES };
            case 'layout_patterns':
                return { topic, data: knowledgeData_1.LAYOUT_PATTERNS };
            case 'widget_strategy':
                return { topic, data: knowledgeData_1.WIDGET_STRATEGIES };
            case 'node_structure':
                return { topic, data: knowledgeData_1.NODE_STRUCTURES };
            case 'animation_patterns':
                return { topic, data: knowledgeData_1.ANIMATION_PATTERNS };
            case 'best_practices':
                return { topic, data: knowledgeData_1.BEST_PRACTICES };
            default:
                return {
                    isError: true,
                    content: [{ type: 'text', text: `未知主题: "${topic}"。可用主题: ${knowledgeData_1.KNOWLEDGE_TOPICS.map(t => t.name).join(', ')}` }],
                };
        }
    }
    // ==================== 组件属性查询 ====================
    knowledge_component_props(params) {
        const comp = knowledgeData_1.COMPONENT_PROPERTIES[params.component];
        if (!comp) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知组件: "${params.component}"。已知: ${Object.keys(knowledgeData_1.COMPONENT_PROPERTIES).join(', ')}` }],
            };
        }
        return { component: comp.type, description: comp.description, properties: comp.properties };
    }
    // ==================== 动画预设查询 ====================
    knowledge_animation_pattern(params) {
        const found = knowledgeData_1.ANIMATION_PATTERNS.find(p => { var _a; return p.name === ((_a = params.pattern) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()); });
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知动画: "${params.pattern}"。可用: ${knowledgeData_1.ANIMATION_PATTERNS.map(p => p.name).join(', ')}` }],
            };
        }
        return { pattern: found };
    }
    // ==================== 布局模板查询 ====================
    knowledge_layout_pattern(params) {
        const found = knowledgeData_1.LAYOUT_PATTERNS.find(p => { var _a; return p.name === ((_a = params.pattern) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()); });
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知布局: "${params.pattern}"。可用: ${knowledgeData_1.LAYOUT_PATTERNS.map(p => p.name).join(', ')}` }],
            };
        }
        return { pattern: found };
    }
    // ==================== 场景架构模板查询 ====================
    knowledge_node_structure(params) {
        const found = knowledgeData_1.NODE_STRUCTURES.find(s => { var _a; return s.name === ((_a = params.name) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()); });
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知模板: "${params.name}"。可用: ${knowledgeData_1.NODE_STRUCTURES.map(s => s.name).join(', ')}` }],
            };
        }
        return { template: found };
    }
    // ==================== Widget 策略查询 ====================
    knowledge_widget_strategies() {
        return { strategies: knowledgeData_1.WIDGET_STRATEGIES };
    }
    // ==================== 最佳实践查询 ====================
    knowledge_best_practice(params) {
        const found = knowledgeData_1.BEST_PRACTICES.find(p => { var _a; return p.category === ((_a = params.category) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()); });
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知类别: "${params.category}"。可用: ${knowledgeData_1.BEST_PRACTICES.map(p => p.category).join(', ')}` }],
            };
        }
        return { practice: found };
    }
    // ==================== 统一搜索 ====================
    knowledge_search(params) {
        var _a;
        const q = ((_a = params.query) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()) || '';
        const results = [];
        // 搜索组件属性
        const compResults = Object.entries(knowledgeData_1.COMPONENT_PROPERTIES)
            .filter(([key, val]) => key.toLowerCase().includes(q) || val.description.toLowerCase().includes(q))
            .map(([key]) => key);
        if (compResults.length > 0)
            results.push({ topic: 'component_properties', items: compResults });
        // 搜索布局模式
        const layoutResults = knowledgeData_1.LAYOUT_PATTERNS
            .filter(p => p.name.includes(q) || p.description.toLowerCase().includes(q))
            .map(p => p.name);
        if (layoutResults.length > 0)
            results.push({ topic: 'layout_patterns', items: layoutResults });
        // 搜索动画预设
        const animResults = knowledgeData_1.ANIMATION_PATTERNS
            .filter(p => p.name.includes(q) || p.description.toLowerCase().includes(q) || p.use_case.toLowerCase().includes(q))
            .map(p => p.name);
        if (animResults.length > 0)
            results.push({ topic: 'animation_patterns', items: animResults });
        // 搜索最佳实践
        const bpResults = knowledgeData_1.BEST_PRACTICES
            .filter(p => p.category.includes(q) || p.title.toLowerCase().includes(q) ||
            p.rules.some(r => r.toLowerCase().includes(q)))
            .map(p => p.category);
        if (bpResults.length > 0)
            results.push({ topic: 'best_practices', items: bpResults });
        return {
            query: params.query,
            totalResults: results.length,
            results,
            tip: results.length === 0 ? '未找到匹配内容，请尝试其他关键词或使用 knowledge_list_topics 查看所有主题' : undefined,
        };
    }
};
exports.KnowledgeModule = KnowledgeModule;
__decorate([
    (0, decorators_1.MCPTool)('列出知识库中所有可用主题', {})
], KnowledgeModule.prototype, "knowledge_list_topics", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定主题的完整知识内容。可用主题: component_properties, ui_design_rules, layout_patterns, widget_strategy, node_structure, animation_patterns, best_practices', {
        topic: {
            type: 'string',
            description: '主题名：component_properties / ui_design_rules / layout_patterns / widget_strategy / node_structure / animation_patterns / best_practices',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_query", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定组件的完整属性列表。支持常见组件: cc.Sprite, cc.Label, cc.Button, cc.Widget, cc.Layout, cc.ScrollView, cc.EditBox, cc.UITransform, cc.Canvas', {
        component: {
            type: 'string',
            description: '组件类型名，如 cc.Sprite, cc.Label',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_component_props", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定动画预设的完整代码。可用: fade_in, fade_out, scale_bounce, scale_close, slide_in_bottom, slide_in_right, shake, pulse, float, typewriter, number_roll, flip_card, combo_sequence', {
        pattern: {
            type: 'string',
            description: '动画预设名',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_animation_pattern", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定 UI 布局模板的节点结构。可用: dialog, scroll_list, tab_bar, hud, login, settings, grid_inventory, leaderboard, loading, toast, shop, level_select', {
        pattern: {
            type: 'string',
            description: '布局模板名',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_layout_pattern", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定场景架构模板。可用: game_main, main_menu, battle_scene', {
        name: {
            type: 'string',
            description: '架构模板名',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_node_structure", null);
__decorate([
    (0, decorators_1.MCPTool)('查询常用 Widget 对齐策略', {})
], KnowledgeModule.prototype, "knowledge_widget_strategies", null);
__decorate([
    (0, decorators_1.MCPTool)('查询指定类别的最佳实践。可用: performance, multi_resolution, scene_management, input_handling, memory_management, audio, animation_tips, ui_architecture', {
        category: {
            type: 'string',
            description: '最佳实践类别名',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_best_practice", null);
__decorate([
    (0, decorators_1.MCPTool)('在知识库中搜索相关内容（跨主题搜索）', {
        query: {
            type: 'string',
            description: '搜索关键词',
            required: true,
        },
    })
], KnowledgeModule.prototype, "knowledge_search", null);
exports.KnowledgeModule = KnowledgeModule = __decorate([
    (0, decorators_1.MCPModule)('knowledge', '知识库 - Cocos Creator 组件属性、UI 规范、动画预设、最佳实践查询')
], KnowledgeModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiS25vd2xlZGdlTW9kdWxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc291cmNlL21jcC9tb2R1bGVzL0tub3dsZWRnZU1vZHVsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFDbkQsOERBU29DO0FBRzdCLElBQU0sZUFBZSxHQUFyQixNQUFNLGVBQWU7SUFFeEIsaURBQWlEO0lBR2pELHFCQUFxQjtRQUNqQixPQUFPO1lBQ0gsTUFBTSxFQUFFLGdDQUFnQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQy9CLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSTtnQkFDWixLQUFLLEVBQUUsQ0FBQyxDQUFDLEtBQUs7Z0JBQ2QsV0FBVyxFQUFFLENBQUMsQ0FBQyxXQUFXO2dCQUMxQixTQUFTLEVBQUUsQ0FBQyxDQUFDLEtBQUs7YUFDckIsQ0FBQyxDQUFDO1NBQ04sQ0FBQztJQUNOLENBQUM7SUFTRCxlQUFlLENBQUMsTUFBeUI7O1FBQ3JDLE1BQU0sS0FBSyxHQUFHLE1BQUEsTUFBTSxDQUFDLEtBQUssMENBQUUsSUFBSSxHQUFHLFdBQVcsRUFBRSxDQUFDO1FBQ2pELFFBQVEsS0FBSyxFQUFFLENBQUM7WUFDWixLQUFLLHNCQUFzQjtnQkFDdkIsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsb0NBQW9CLEVBQUUsQ0FBQztZQUNqRCxLQUFLLGlCQUFpQjtnQkFDbEIsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsK0JBQWUsRUFBRSxDQUFDO1lBQzVDLEtBQUssaUJBQWlCO2dCQUNsQixPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSwrQkFBZSxFQUFFLENBQUM7WUFDNUMsS0FBSyxpQkFBaUI7Z0JBQ2xCLE9BQU8sRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLGlDQUFpQixFQUFFLENBQUM7WUFDOUMsS0FBSyxn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MEssRUFBRTtRQUNqTCxPQUFPLEVBQUU7WUFDTCxJQUFJLEVBQUUsUUFBUTtZQUNkLFdBQVcsRUFBRSxPQUFPO1lBQ3BCLFFBQVEsRUFBRSxJQUFJO1NBQ2pCO0tBQ0osQ0FBQztrRUFVRDtBQVdEO0lBUEMsSUFBQSxvQkFBTyxFQUFDLDJJQUEySSxFQUFFO1FBQ2xKLE9BQU8sRUFBRTtZQUNMLElBQUksRUFBRSxRQUFRO1lBQ2QsV0FBVyxFQUFFLE9BQU87WUFDcEIsUUFBUSxFQUFFLElBQUk7U0FDakI7S0FDSixDQUFDOytEQVVEO0FBV0Q7SUFQQyxJQUFBLG9CQUFPLEVBQUMsbURBQW1ELEVBQUU7UUFDMUQsSUFBSSxFQUFFO1lBQ0YsSUFBSSxFQUFFLFFBQVE7WUFDZCxXQUFXLEVBQUUsT0FBTztZQUNwQixRQUFRLEVBQUUsSUFBSTtTQUNqQjtLQUNKLENBQUM7K0RBVUQ7QUFLRDtJQURDLElBQUEsb0JBQU8sRUFBQyxrQkFBa0IsRUFBRSxFQUFFLENBQUM7a0VBRy9CO0FBV0Q7SUFQQyxJQUFBLG9CQUFPLEVBQUMsNElBQTRJLEVBQUU7UUFDbkosUUFBUSxFQUFFO1lBQ04sSUFBSSxFQUFFLFFBQVE7WUFDZCxXQUFXLEVBQUUsU0FBUztZQUN0QixRQUFRLEVBQUUsSUFBSTtTQUNqQjtLQUNKLENBQUM7OERBVUQ7QUFXRDtJQVBDLElBQUEsb0JBQU8sRUFBQyxvQkFBb0IsRUFBRTtRQUMzQixLQUFLLEVBQUU7WUFDSCxJQUFJLEVBQUUsUUFBUTtZQUNkLFdBQVcsRUFBRSxPQUFPO1lBQ3BCLFFBQVEsRUFBRSxJQUFJO1NBQ2pCO0tBQ0osQ0FBQzt1REFvQ0Q7MEJBdk1RLGVBQWU7SUFEM0IsSUFBQSxzQkFBUyxFQUFDLFdBQVcsRUFBRSw0Q0FBNEMsQ0FBQztHQUN4RCxlQUFlLENBd00zQiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog55+l6K+G5bqT5qih5Z2XIOKAlCDmj5DkvpsgQ29jb3MgQ3JlYXRvciDnn6Xor4bmn6Xor6Llip/og71cbiAqXG4gKiDmt7flkIjmqKHlvI/vvJrlhbPplK7mkZjopoHltYzlhaUgaW5pdGlhbGl6ZSBpbnN0cnVjdGlvbnPvvIzor6bnu4blhoXlrrnpgJrov4flt6Xlhbfmn6Xor6LjgIJcbiAqIOS4u+mimO+8mmNvbXBvbmVudF9wcm9wZXJ0aWVzIC8gdWlfZGVzaWduX3J1bGVzIC8gbGF5b3V0X3BhdHRlcm5zIC9cbiAqICAgICAgIHdpZGdldF9zdHJhdGVneSAvIG5vZGVfc3RydWN0dXJlIC8gYW5pbWF0aW9uX3BhdHRlcm5zIC8gYmVzdF9wcmFjdGljZXNcbiAqL1xuXG5pbXBvcnQgeyBNQ1BNb2R1bGUsIE1DUFRvb2wgfSBmcm9tICcuLi9kZWNvcmF0b3JzJztcbmltcG9ydCB7XG4gICAgS05PV0xFREdFX1RPUElDUyxcbiAgICBDT01QT05FTlRfUFJPUEVSVElFUyxcbiAgICBVSV9ERVNJR05fUlVMRVMsXG4gICAgTEFZT1VUX1BBVFRFUk5TLFxuICAgIFdJREdFVF9TVFJBVEVHSUVTLFxuICAgIE5PREVfU1RSVUNUVVJFUyxcbiAgICBBTklNQVRJT05fUEFUVEVSTlMsXG4gICAgQkVTVF9QUkFDVElDRVMsXG59IGZyb20gJy4uL2tub3dsZWRnZS9rbm93bGVkZ2VEYXRhJztcblxuQE1DUE1vZHVsZSgna25vd2xlZGdlJywgJ+efpeivhuW6kyAtIENvY29zIENyZWF0b3Ig57uE5Lu25bGe5oCn44CBVUkg6KeE6IyD44CB5Yqo55S76aKE6K6+44CB5pyA5L2z5a6e6Le15p+l6K+iJylcbmV4cG9ydCBjbGFzcyBLbm93bGVkZ2VNb2R1bGUge1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Li76aKY5p+l6K+iID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5YiX5Ye655+l6K+G5bqT5Lit5omA5pyJ5Y+v55So5Li76aKYJywge30pXG4gICAga25vd2xlZGdlX2xpc3RfdG9waWNzKCk6IGFueSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB0b3BpY3M6IEtOT1dMRURHRV9UT1BJQ1MubWFwKHQgPT4gKHtcbiAgICAgICAgICAgICAgICBuYW1lOiB0Lm5hbWUsXG4gICAgICAgICAgICAgICAgdGl0bGU6IHQudGl0bGUsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246IHQuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICAgICAgaXRlbUNvdW50OiB0LmNvdW50LFxuICAgICAgICAgICAgfSkpLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrprkuLvpopjnmoTlrozmlbTnn6Xor4blhoXlrrnjgILlj6/nlKjkuLvpopg6IGNvbXBvbmVudF9wcm9wZXJ0aWVzLCB1aV9kZXNpZ25fcnVsZXMsIGxheW91dF9wYXR0ZXJucywgd2lkZ2V0X3N0cmF0ZWd5LCBub2RlX3N0cnVjdHVyZSwgYW5pbWF0aW9uX3BhdHRlcm5zLCBiZXN0X3ByYWN0aWNlcycsIHtcbiAgICAgICAgdG9waWM6IHtcbiAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICfkuLvpopjlkI3vvJpjb21wb25lbnRfcHJvcGVydGllcyAvIHVpX2Rlc2lnbl9ydWxlcyAvIGxheW91dF9wYXR0ZXJucyAvIHdpZGdldF9zdHJhdGVneSAvIG5vZGVfc3RydWN0dXJlIC8gYW5pbWF0aW9uX3BhdHRlcm5zIC8gYmVzdF9wcmFjdGljZXMnLFxuICAgICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgfSlcbiAgICBrbm93bGVkZ2VfcXVlcnkocGFyYW1zOiB7IHRvcGljOiBzdHJpbmcgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IHRvcGljID0gcGFyYW1zLnRvcGljPy50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgc3dpdGNoICh0b3BpYykge1xuICAgICAgICAgICAgY2FzZSAnY29tcG9uZW50X3Byb3BlcnRpZXMnOlxuICAgICAgICAgICAgICAgIHJldHVybiB7IHRvcGljLCBkYXRhOiBDT01QT05FTlRfUFJPUEVSVElFUyB9O1xuICAgICAgICAgICAgY2FzZSAndWlfZGVzaWduX3J1bGVzJzpcbiAgICAgICAgICAgICAgICByZXR1cm4geyB0b3BpYywgZGF0YTogVUlfREVTSUdOX1JVTEVTIH07XG4gICAgICAgICAgICBjYXNlICdsYXlvdXRfcGF0dGVybnMnOlxuICAgICAgICAgICAgICAgIHJldHVybiB7IHRvcGljLCBkYXRhOiBMQVlPVVRfUEFUVEVSTlMgfTtcbiAgICAgICAgICAgIGNhc2UgJ3dpZGdldF9zdHJhdGVneSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgdG9waWMsIGRhdGE6IFdJREdFVF9TVFJBVEVHSUVTIH07XG4gICAgICAgICAgICBjYXNlICdub2RlX3N0cnVjdHVyZSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgdG9waWMsIGRhdGE6IE5PREVfU1RSVUNUVVJFUyB9O1xuICAgICAgICAgICAgY2FzZSAnYW5pbWF0aW9uX3BhdHRlcm5zJzpcbiAgICAgICAgICAgICAgICByZXR1cm4geyB0b3BpYywgZGF0YTogQU5JTUFUSU9OX1BBVFRFUk5TIH07XG4gICAgICAgICAgICBjYXNlICdiZXN0X3ByYWN0aWNlcyc6XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgdG9waWMsIGRhdGE6IEJFU1RfUFJBQ1RJQ0VTIH07XG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogYOacquefpeS4u+mimDogXCIke3RvcGljfVwi44CC5Y+v55So5Li76aKYOiAke0tOT1dMRURHRV9UT1BJQ1MubWFwKHQgPT4gdC5uYW1lKS5qb2luKCcsICcpfWAgfV0sXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOe7hOS7tuWxnuaAp+afpeivoiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+afpeivouaMh+Wumue7hOS7tueahOWujOaVtOWxnuaAp+WIl+ihqOOAguaUr+aMgeW4uOingee7hOS7tjogY2MuU3ByaXRlLCBjYy5MYWJlbCwgY2MuQnV0dG9uLCBjYy5XaWRnZXQsIGNjLkxheW91dCwgY2MuU2Nyb2xsVmlldywgY2MuRWRpdEJveCwgY2MuVUlUcmFuc2Zvcm0sIGNjLkNhbnZhcycsIHtcbiAgICAgICAgY29tcG9uZW50OiB7XG4gICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn57uE5Lu257G75Z6L5ZCN77yM5aaCIGNjLlNwcml0ZSwgY2MuTGFiZWwnLFxuICAgICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgfSlcbiAgICBrbm93bGVkZ2VfY29tcG9uZW50X3Byb3BzKHBhcmFtczogeyBjb21wb25lbnQ6IHN0cmluZyB9KTogYW55IHtcbiAgICAgICAgY29uc3QgY29tcCA9IENPTVBPTkVOVF9QUk9QRVJUSUVTW3BhcmFtcy5jb21wb25lbnRdO1xuICAgICAgICBpZiAoIWNvbXApIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGDmnKrnn6Xnu4Tku7Y6IFwiJHtwYXJhbXMuY29tcG9uZW50fVwi44CC5bey55+lOiAke09iamVjdC5rZXlzKENPTVBPTkVOVF9QUk9QRVJUSUVTKS5qb2luKCcsICcpfWAgfV0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGNvbXBvbmVudDogY29tcC50eXBlLCBkZXNjcmlwdGlvbjogY29tcC5kZXNjcmlwdGlvbiwgcHJvcGVydGllczogY29tcC5wcm9wZXJ0aWVzIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Yqo55S76aKE6K6+5p+l6K+iID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5oyH5a6a5Yqo55S76aKE6K6+55qE5a6M5pW05Luj56CB44CC5Y+v55SoOiBmYWRlX2luLCBmYWRlX291dCwgc2NhbGVfYm91bmNlLCBzY2FsZV9jbG9zZSwgc2xpZGVfaW5fYm90dG9tLCBzbGlkZV9pbl9yaWdodCwgc2hha2UsIHB1bHNlLCBmbG9hdCwgdHlwZXdyaXRlciwgbnVtYmVyX3JvbGwsIGZsaXBfY2FyZCwgY29tYm9fc2VxdWVuY2UnLCB7XG4gICAgICAgIHBhdHRlcm46IHtcbiAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICfliqjnlLvpooTorr7lkI0nLFxuICAgICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgfSlcbiAgICBrbm93bGVkZ2VfYW5pbWF0aW9uX3BhdHRlcm4ocGFyYW1zOiB7IHBhdHRlcm46IHN0cmluZyB9KTogYW55IHtcbiAgICAgICAgY29uc3QgZm91bmQgPSBBTklNQVRJT05fUEFUVEVSTlMuZmluZChwID0+IHAubmFtZSA9PT0gcGFyYW1zLnBhdHRlcm4/LnRyaW0oKS50b0xvd2VyQ2FzZSgpKTtcbiAgICAgICAgaWYgKCFmb3VuZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogYOacquefpeWKqOeUuzogXCIke3BhcmFtcy5wYXR0ZXJufVwi44CC5Y+v55SoOiAke0FOSU1BVElPTl9QQVRURVJOUy5tYXAocCA9PiBwLm5hbWUpLmpvaW4oJywgJyl9YCB9XSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgcGF0dGVybjogZm91bmQgfTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PSDluIPlsYDmqKHmnb/mn6Xor6IgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LmjIflrpogVUkg5biD5bGA5qih5p2/55qE6IqC54K557uT5p6E44CC5Y+v55SoOiBkaWFsb2csIHNjcm9sbF9saXN0LCB0YWJfYmFyLCBodWQsIGxvZ2luLCBzZXR0aW5ncywgZ3JpZF9pbnZlbnRvcnksIGxlYWRlcmJvYXJkLCBsb2FkaW5nLCB0b2FzdCwgc2hvcCwgbGV2ZWxfc2VsZWN0Jywge1xuICAgICAgICBwYXR0ZXJuOiB7XG4gICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5biD5bGA5qih5p2/5ZCNJyxcbiAgICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgIH0pXG4gICAga25vd2xlZGdlX2xheW91dF9wYXR0ZXJuKHBhcmFtczogeyBwYXR0ZXJuOiBzdHJpbmcgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gTEFZT1VUX1BBVFRFUk5TLmZpbmQocCA9PiBwLm5hbWUgPT09IHBhcmFtcy5wYXR0ZXJuPy50cmltKCkudG9Mb3dlckNhc2UoKSk7XG4gICAgICAgIGlmICghZm91bmQpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGDmnKrnn6XluIPlsYA6IFwiJHtwYXJhbXMucGF0dGVybn1cIuOAguWPr+eUqDogJHtMQVlPVVRfUEFUVEVSTlMubWFwKHAgPT4gcC5uYW1lKS5qb2luKCcsICcpfWAgfV0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IHBhdHRlcm46IGZvdW5kIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g5Zy65pmv5p625p6E5qih5p2/5p+l6K+iID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5p+l6K+i5oyH5a6a5Zy65pmv5p625p6E5qih5p2/44CC5Y+v55SoOiBnYW1lX21haW4sIG1haW5fbWVudSwgYmF0dGxlX3NjZW5lJywge1xuICAgICAgICBuYW1lOiB7XG4gICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5p625p6E5qih5p2/5ZCNJyxcbiAgICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgIH0pXG4gICAga25vd2xlZGdlX25vZGVfc3RydWN0dXJlKHBhcmFtczogeyBuYW1lOiBzdHJpbmcgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gTk9ERV9TVFJVQ1RVUkVTLmZpbmQocyA9PiBzLm5hbWUgPT09IHBhcmFtcy5uYW1lPy50cmltKCkudG9Mb3dlckNhc2UoKSk7XG4gICAgICAgIGlmICghZm91bmQpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGDmnKrnn6XmqKHmnb86IFwiJHtwYXJhbXMubmFtZX1cIuOAguWPr+eUqDogJHtOT0RFX1NUUlVDVFVSRVMubWFwKHMgPT4gcy5uYW1lKS5qb2luKCcsICcpfWAgfV0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IHRlbXBsYXRlOiBmb3VuZCB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IFdpZGdldCDnrZbnlaXmn6Xor6IgPT09PT09PT09PT09PT09PT09PT1cblxuICAgIEBNQ1BUb29sKCfmn6Xor6LluLjnlKggV2lkZ2V0IOWvuem9kOetlueVpScsIHt9KVxuICAgIGtub3dsZWRnZV93aWRnZXRfc3RyYXRlZ2llcygpOiBhbnkge1xuICAgICAgICByZXR1cm4geyBzdHJhdGVnaWVzOiBXSURHRVRfU1RSQVRFR0lFUyB9O1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09IOacgOS9s+Wunui3teafpeivoiA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgQE1DUFRvb2woJ+afpeivouaMh+Wumuexu+WIq+eahOacgOS9s+Wunui3teOAguWPr+eUqDogcGVyZm9ybWFuY2UsIG11bHRpX3Jlc29sdXRpb24sIHNjZW5lX21hbmFnZW1lbnQsIGlucHV0X2hhbmRsaW5nLCBtZW1vcnlfbWFuYWdlbWVudCwgYXVkaW8sIGFuaW1hdGlvbl90aXBzLCB1aV9hcmNoaXRlY3R1cmUnLCB7XG4gICAgICAgIGNhdGVnb3J5OiB7XG4gICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5pyA5L2z5a6e6Le157G75Yir5ZCNJyxcbiAgICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgIH0pXG4gICAga25vd2xlZGdlX2Jlc3RfcHJhY3RpY2UocGFyYW1zOiB7IGNhdGVnb3J5OiBzdHJpbmcgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gQkVTVF9QUkFDVElDRVMuZmluZChwID0+IHAuY2F0ZWdvcnkgPT09IHBhcmFtcy5jYXRlZ29yeT8udHJpbSgpLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICBpZiAoIWZvdW5kKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiBg5pyq55+l57G75YirOiBcIiR7cGFyYW1zLmNhdGVnb3J5fVwi44CC5Y+v55SoOiAke0JFU1RfUFJBQ1RJQ0VTLm1hcChwID0+IHAuY2F0ZWdvcnkpLmpvaW4oJywgJyl9YCB9XSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgcHJhY3RpY2U6IGZvdW5kIH07XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT0g57uf5LiA5pCc57SiID09PT09PT09PT09PT09PT09PT09XG5cbiAgICBATUNQVG9vbCgn5Zyo55+l6K+G5bqT5Lit5pCc57Si55u45YWz5YaF5a6577yI6Leo5Li76aKY5pCc57Si77yJJywge1xuICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aQnOe0ouWFs+mUruivjScsXG4gICAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICB9KVxuICAgIGtub3dsZWRnZV9zZWFyY2gocGFyYW1zOiB7IHF1ZXJ5OiBzdHJpbmcgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IHEgPSBwYXJhbXMucXVlcnk/LnRyaW0oKS50b0xvd2VyQ2FzZSgpIHx8ICcnO1xuICAgICAgICBjb25zdCByZXN1bHRzOiB7IHRvcGljOiBzdHJpbmc7IGl0ZW1zOiBhbnlbXSB9W10gPSBbXTtcblxuICAgICAgICAvLyDmkJzntKLnu4Tku7blsZ7mgKdcbiAgICAgICAgY29uc3QgY29tcFJlc3VsdHMgPSBPYmplY3QuZW50cmllcyhDT01QT05FTlRfUFJPUEVSVElFUylcbiAgICAgICAgICAgIC5maWx0ZXIoKFtrZXksIHZhbF0pID0+IGtleS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpIHx8IHZhbC5kZXNjcmlwdGlvbi50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKVxuICAgICAgICAgICAgLm1hcCgoW2tleV0pID0+IGtleSk7XG4gICAgICAgIGlmIChjb21wUmVzdWx0cy5sZW5ndGggPiAwKSByZXN1bHRzLnB1c2goeyB0b3BpYzogJ2NvbXBvbmVudF9wcm9wZXJ0aWVzJywgaXRlbXM6IGNvbXBSZXN1bHRzIH0pO1xuXG4gICAgICAgIC8vIOaQnOe0ouW4g+WxgOaooeW8j1xuICAgICAgICBjb25zdCBsYXlvdXRSZXN1bHRzID0gTEFZT1VUX1BBVFRFUk5TXG4gICAgICAgICAgICAuZmlsdGVyKHAgPT4gcC5uYW1lLmluY2x1ZGVzKHEpIHx8IHAuZGVzY3JpcHRpb24udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSlcbiAgICAgICAgICAgIC5tYXAocCA9PiBwLm5hbWUpO1xuICAgICAgICBpZiAobGF5b3V0UmVzdWx0cy5sZW5ndGggPiAwKSByZXN1bHRzLnB1c2goeyB0b3BpYzogJ2xheW91dF9wYXR0ZXJucycsIGl0ZW1zOiBsYXlvdXRSZXN1bHRzIH0pO1xuXG4gICAgICAgIC8vIOaQnOe0ouWKqOeUu+mihOiuvlxuICAgICAgICBjb25zdCBhbmltUmVzdWx0cyA9IEFOSU1BVElPTl9QQVRURVJOU1xuICAgICAgICAgICAgLmZpbHRlcihwID0+IHAubmFtZS5pbmNsdWRlcyhxKSB8fCBwLmRlc2NyaXB0aW9uLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkgfHwgcC51c2VfY2FzZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKVxuICAgICAgICAgICAgLm1hcChwID0+IHAubmFtZSk7XG4gICAgICAgIGlmIChhbmltUmVzdWx0cy5sZW5ndGggPiAwKSByZXN1bHRzLnB1c2goeyB0b3BpYzogJ2FuaW1hdGlvbl9wYXR0ZXJucycsIGl0ZW1zOiBhbmltUmVzdWx0cyB9KTtcblxuICAgICAgICAvLyDmkJzntKLmnIDkvbPlrp7ot7VcbiAgICAgICAgY29uc3QgYnBSZXN1bHRzID0gQkVTVF9QUkFDVElDRVNcbiAgICAgICAgICAgIC5maWx0ZXIocCA9PiBwLmNhdGVnb3J5LmluY2x1ZGVzKHEpIHx8IHAudGl0bGUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSB8fFxuICAgICAgICAgICAgICAgIHAucnVsZXMuc29tZShyID0+IHIudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSkpXG4gICAgICAgICAgICAubWFwKHAgPT4gcC5jYXRlZ29yeSk7XG4gICAgICAgIGlmIChicFJlc3VsdHMubGVuZ3RoID4gMCkgcmVzdWx0cy5wdXNoKHsgdG9waWM6ICdiZXN0X3ByYWN0aWNlcycsIGl0ZW1zOiBicFJlc3VsdHMgfSk7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgICB0b3RhbFJlc3VsdHM6IHJlc3VsdHMubGVuZ3RoLFxuICAgICAgICAgICAgcmVzdWx0cyxcbiAgICAgICAgICAgIHRpcDogcmVzdWx0cy5sZW5ndGggPT09IDAgPyAn5pyq5om+5Yiw5Yy56YWN5YaF5a6577yM6K+35bCd6K+V5YW25LuW5YWz6ZSu6K+N5oiW5L2/55SoIGtub3dsZWRnZV9saXN0X3RvcGljcyDmn6XnnIvmiYDmnInkuLvpopgnIDogdW5kZWZpbmVkLFxuICAgICAgICB9O1xuICAgIH1cbn1cbiJdfQ==