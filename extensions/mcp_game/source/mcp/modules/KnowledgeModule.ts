/**
 * 知识库模块 — 提供 Cocos Creator 知识查询功能
 *
 * 混合模式：关键摘要嵌入 initialize instructions，详细内容通过工具查询。
 * 主题：component_properties / ui_design_rules / layout_patterns /
 *       widget_strategy / node_structure / animation_patterns / best_practices
 */

import { MCPModule, MCPTool } from '../decorators';
import {
    KNOWLEDGE_TOPICS,
    COMPONENT_PROPERTIES,
    UI_DESIGN_RULES,
    LAYOUT_PATTERNS,
    WIDGET_STRATEGIES,
    NODE_STRUCTURES,
    ANIMATION_PATTERNS,
    BEST_PRACTICES,
} from '../knowledge/knowledgeData';

@MCPModule('knowledge', '知识库 - Cocos Creator 组件属性、UI 规范、动画预设、最佳实践查询')
export class KnowledgeModule {

    // ==================== 主题查询 ====================

    @MCPTool('列出知识库中所有可用主题', {})
    knowledge_list_topics(): any {
        return {
            topics: KNOWLEDGE_TOPICS.map(t => ({
                name: t.name,
                title: t.title,
                description: t.description,
                itemCount: t.count,
            })),
        };
    }

    @MCPTool('查询指定主题的完整知识内容。可用主题: component_properties, ui_design_rules, layout_patterns, widget_strategy, node_structure, animation_patterns, best_practices', {
        topic: {
            type: 'string',
            description: '主题名：component_properties / ui_design_rules / layout_patterns / widget_strategy / node_structure / animation_patterns / best_practices',
            required: true,
        },
    })
    knowledge_query(params: { topic: string }): any {
        const topic = params.topic?.trim().toLowerCase();
        switch (topic) {
            case 'component_properties':
                return { topic, data: COMPONENT_PROPERTIES };
            case 'ui_design_rules':
                return { topic, data: UI_DESIGN_RULES };
            case 'layout_patterns':
                return { topic, data: LAYOUT_PATTERNS };
            case 'widget_strategy':
                return { topic, data: WIDGET_STRATEGIES };
            case 'node_structure':
                return { topic, data: NODE_STRUCTURES };
            case 'animation_patterns':
                return { topic, data: ANIMATION_PATTERNS };
            case 'best_practices':
                return { topic, data: BEST_PRACTICES };
            default:
                return {
                    isError: true,
                    content: [{ type: 'text', text: `未知主题: "${topic}"。可用主题: ${KNOWLEDGE_TOPICS.map(t => t.name).join(', ')}` }],
                };
        }
    }

    // ==================== 组件属性查询 ====================

    @MCPTool('查询指定组件的完整属性列表。支持常见组件: cc.Sprite, cc.Label, cc.Button, cc.Widget, cc.Layout, cc.ScrollView, cc.EditBox, cc.UITransform, cc.Canvas', {
        component: {
            type: 'string',
            description: '组件类型名，如 cc.Sprite, cc.Label',
            required: true,
        },
    })
    knowledge_component_props(params: { component: string }): any {
        const comp = COMPONENT_PROPERTIES[params.component];
        if (!comp) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知组件: "${params.component}"。已知: ${Object.keys(COMPONENT_PROPERTIES).join(', ')}` }],
            };
        }
        return { component: comp.type, description: comp.description, properties: comp.properties };
    }

    // ==================== 动画预设查询 ====================

    @MCPTool('查询指定动画预设的完整代码。可用: fade_in, fade_out, scale_bounce, scale_close, slide_in_bottom, slide_in_right, shake, pulse, float, typewriter, number_roll, flip_card, combo_sequence', {
        pattern: {
            type: 'string',
            description: '动画预设名',
            required: true,
        },
    })
    knowledge_animation_pattern(params: { pattern: string }): any {
        const found = ANIMATION_PATTERNS.find(p => p.name === params.pattern?.trim().toLowerCase());
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知动画: "${params.pattern}"。可用: ${ANIMATION_PATTERNS.map(p => p.name).join(', ')}` }],
            };
        }
        return { pattern: found };
    }

    // ==================== 布局模板查询 ====================

    @MCPTool('查询指定 UI 布局模板的节点结构。可用: dialog, scroll_list, tab_bar, hud, login, settings, grid_inventory, leaderboard, loading, toast, shop, level_select', {
        pattern: {
            type: 'string',
            description: '布局模板名',
            required: true,
        },
    })
    knowledge_layout_pattern(params: { pattern: string }): any {
        const found = LAYOUT_PATTERNS.find(p => p.name === params.pattern?.trim().toLowerCase());
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知布局: "${params.pattern}"。可用: ${LAYOUT_PATTERNS.map(p => p.name).join(', ')}` }],
            };
        }
        return { pattern: found };
    }

    // ==================== 场景架构模板查询 ====================

    @MCPTool('查询指定场景架构模板。可用: game_main, main_menu, battle_scene', {
        name: {
            type: 'string',
            description: '架构模板名',
            required: true,
        },
    })
    knowledge_node_structure(params: { name: string }): any {
        const found = NODE_STRUCTURES.find(s => s.name === params.name?.trim().toLowerCase());
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知模板: "${params.name}"。可用: ${NODE_STRUCTURES.map(s => s.name).join(', ')}` }],
            };
        }
        return { template: found };
    }

    // ==================== Widget 策略查询 ====================

    @MCPTool('查询常用 Widget 对齐策略', {})
    knowledge_widget_strategies(): any {
        return { strategies: WIDGET_STRATEGIES };
    }

    // ==================== 最佳实践查询 ====================

    @MCPTool('查询指定类别的最佳实践。可用: performance, multi_resolution, scene_management, input_handling, memory_management, audio, animation_tips, ui_architecture', {
        category: {
            type: 'string',
            description: '最佳实践类别名',
            required: true,
        },
    })
    knowledge_best_practice(params: { category: string }): any {
        const found = BEST_PRACTICES.find(p => p.category === params.category?.trim().toLowerCase());
        if (!found) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知类别: "${params.category}"。可用: ${BEST_PRACTICES.map(p => p.category).join(', ')}` }],
            };
        }
        return { practice: found };
    }

    // ==================== 统一搜索 ====================

    @MCPTool('在知识库中搜索相关内容（跨主题搜索）', {
        query: {
            type: 'string',
            description: '搜索关键词',
            required: true,
        },
    })
    knowledge_search(params: { query: string }): any {
        const q = params.query?.trim().toLowerCase() || '';
        const results: { topic: string; items: any[] }[] = [];

        // 搜索组件属性
        const compResults = Object.entries(COMPONENT_PROPERTIES)
            .filter(([key, val]) => key.toLowerCase().includes(q) || val.description.toLowerCase().includes(q))
            .map(([key]) => key);
        if (compResults.length > 0) results.push({ topic: 'component_properties', items: compResults });

        // 搜索布局模式
        const layoutResults = LAYOUT_PATTERNS
            .filter(p => p.name.includes(q) || p.description.toLowerCase().includes(q))
            .map(p => p.name);
        if (layoutResults.length > 0) results.push({ topic: 'layout_patterns', items: layoutResults });

        // 搜索动画预设
        const animResults = ANIMATION_PATTERNS
            .filter(p => p.name.includes(q) || p.description.toLowerCase().includes(q) || p.use_case.toLowerCase().includes(q))
            .map(p => p.name);
        if (animResults.length > 0) results.push({ topic: 'animation_patterns', items: animResults });

        // 搜索最佳实践
        const bpResults = BEST_PRACTICES
            .filter(p => p.category.includes(q) || p.title.toLowerCase().includes(q) ||
                p.rules.some(r => r.toLowerCase().includes(q)))
            .map(p => p.category);
        if (bpResults.length > 0) results.push({ topic: 'best_practices', items: bpResults });

        return {
            query: params.query,
            totalResults: results.length,
            results,
            tip: results.length === 0 ? '未找到匹配内容，请尝试其他关键词或使用 knowledge_list_topics 查看所有主题' : undefined,
        };
    }
}
