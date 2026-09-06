/**
 * UI 模板模块 — 预定义 UI 布局的一键应用
 *
 * 内置模板: dialog, scroll_list, nav_bar, settings_page
 * 内部通过 BuilderModule.build 构建节点树。
 */

import { MCPModule, MCPTool } from '../decorators';
import { LAYOUT_PATTERNS } from '../knowledge/knowledgeData';

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

/** 模板定义 */
interface UIDefinition {
    name: string;
    description: string;
    tree: any;
}

/** 内置模板定义 */
const TEMPLATES: Record<string, UIDefinition> = {
    dialog: {
        name: 'dialog',
        description: '模态弹窗：半透明遮罩 + 居中面板 + 标题 + 关闭按钮 + 内容 + 操作按钮',
        tree: {
            name: 'DialogRoot',
            position: { x: 0, y: 0, z: 0 },
            components: ['cc.UITransform', 'cc.Sprite'],
            props: {
                'cc.Sprite': { grayscale: false },
                'cc.UITransform': { contentSize: { width: 1920, height: 1080 } },
            },
            children: [
                {
                    name: 'BgOverlay',
                    components: ['cc.UITransform', 'cc.Sprite'],
                    props: { 'cc.Sprite': { grayscale: false } },
                    position: { x: 0, y: 0, z: 0 },
                },
                {
                    name: 'Panel',
                    position: { x: 0, y: 0, z: 0 },
                    components: ['cc.UITransform', 'cc.Sprite'],
                    props: { 'cc.UITransform': { contentSize: { width: 600, height: 400 } } },
                    children: [
                        {
                            name: 'Title',
                            components: ['cc.UITransform', 'cc.Label'],
                            props: {
                                'cc.Label': { string: '标题', fontSize: 32, horizontalAlign: 1 },
                                'cc.UITransform': { contentSize: { width: 500, height: 50 } },
                            },
                            position: { x: 0, y: 150, z: 0 },
                        },
                        {
                            name: 'CloseBtn',
                            type: 'Button',
                            components: ['cc.UITransform', 'cc.Button', 'cc.Sprite'],
                            props: {
                                'cc.UITransform': { contentSize: { width: 40, height: 40 } },
                            },
                            position: { x: 260, y: 150, z: 0 },
                        },
                        {
                            name: 'Content',
                            components: ['cc.UITransform', 'cc.Label'],
                            props: {
                                'cc.Label': { string: '内容区域', fontSize: 24 },
                                'cc.UITransform': { contentSize: { width: 500, height: 200 } },
                            },
                            position: { x: 0, y: 0, z: 0 },
                        },
                        {
                            name: 'ButtonGroup',
                            components: ['cc.UITransform'],
                            props: { 'cc.UITransform': { contentSize: { width: 400, height: 60 } } },
                            position: { x: 0, y: -150, z: 0 },
                            children: [
                                {
                                    name: 'CancelBtn',
                                    type: 'Button',
                                    components: ['cc.UITransform', 'cc.Button', 'cc.Label'],
                                    props: {
                                        'cc.Label': { string: '取消', fontSize: 24 },
                                        'cc.UITransform': { contentSize: { width: 140, height: 50 } },
                                    },
                                    position: { x: -120, y: 0, z: 0 },
                                },
                                {
                                    name: 'ConfirmBtn',
                                    type: 'Button',
                                    components: ['cc.UITransform', 'cc.Button', 'cc.Label'],
                                    props: {
                                        'cc.Label': { string: '确认', fontSize: 24 },
                                        'cc.UITransform': { contentSize: { width: 140, height: 50 } },
                                    },
                                    position: { x: 120, y: 0, z: 0 },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    },
    scroll_list: {
        name: 'scroll_list',
        description: '垂直滚动列表：ScrollView + Mask + content 布局 + 列表项',
        tree: {
            name: 'ScrollView',
            components: ['cc.UITransform', 'cc.ScrollView'],
            props: {
                'cc.ScrollView': { horizontal: false, vertical: true, elastic: true, inertia: true },
                'cc.UITransform': { contentSize: { width: 400, height: 600 } },
            },
            position: { x: 0, y: 0, z: 0 },
            children: [
                {
                    name: 'view',
                    components: ['cc.UITransform', 'cc.Mask'],
                    props: {
                        'cc.UITransform': { contentSize: { width: 400, height: 600 } },
                    },
                    position: { x: 0, y: 0, z: 0 },
                    children: [
                        {
                            name: 'content',
                            components: ['cc.UITransform', 'cc.Layout'],
                            props: {
                                'cc.Layout': { type: 1, resizeMode: 1, spacingY: 8, paddingTop: 8, paddingBottom: 8 },
                                'cc.UITransform': { contentSize: { width: 400, height: 1000 } },
                            },
                            position: { x: 0, y: 0, z: 0 },
                        },
                    ],
                },
                {
                    name: 'ScrollBar',
                    components: ['cc.UITransform', 'cc.ScrollBar'],
                    props: {
                        'cc.ScrollBar': { handleSize: 40 },
                        'cc.UITransform': { contentSize: { width: 10, height: 600 } },
                    },
                    position: { x: 195, y: 0, z: 0 },
                },
            ],
        },
    },
    nav_bar: {
        name: 'nav_bar',
        description: '顶栏导航：返回按钮 + 标题 + 右按钮',
        tree: {
            name: 'NavBar',
            components: ['cc.UITransform'],
            props: { 'cc.UITransform': { contentSize: { width: 1920, height: 80 } } },
            position: { x: 0, y: 360, z: 0 },
            children: [
                {
                    name: 'BackBtn',
                    type: 'Button',
                    components: ['cc.UITransform', 'cc.Button', 'cc.Label'],
                    props: {
                        'cc.Label': { string: '‹ 返回', fontSize: 28 },
                        'cc.UITransform': { contentSize: { width: 100, height: 50 } },
                    },
                    position: { x: -860, y: 0, z: 0 },
                },
                {
                    name: 'Title',
                    components: ['cc.UITransform', 'cc.Label'],
                    props: {
                        'cc.Label': { string: '标题', fontSize: 32, isBold: true },
                        'cc.UITransform': { contentSize: { width: 400, height: 50 } },
                    },
                    position: { x: 0, y: 0, z: 0 },
                },
                {
                    name: 'RightBtn',
                    type: 'Button',
                    components: ['cc.UITransform', 'cc.Button', 'cc.Label'],
                    props: {
                        'cc.Label': { string: '设置', fontSize: 28 },
                        'cc.UITransform': { contentSize: { width: 100, height: 50 } },
                    },
                    position: { x: 860, y: 0, z: 0 },
                },
            ],
        },
    },
    settings_page: {
        name: 'settings_page',
        description: '设置页面：返回导航 + 设置条目列表（音量滑块、画质下拉、开关等）',
        tree: {
            name: 'SettingsRoot',
            position: { x: 0, y: 0, z: 0 },
            children: [
                {
                    name: 'NavBar',
                    components: ['cc.UITransform'],
                    props: { 'cc.UITransform': { contentSize: { width: 1920, height: 80 } } },
                    position: { x: 0, y: 360, z: 0 },
                    children: [
                        {
                            name: 'BackBtn', type: 'Button',
                            components: ['cc.UITransform', 'cc.Button', 'cc.Label'],
                            props: { 'cc.Label': { string: '‹ 返回', fontSize: 28 }, 'cc.UITransform': { contentSize: { width: 100, height: 50 } } },
                            position: { x: -860, y: 0, z: 0 },
                        },
                        {
                            name: 'Title',
                            components: ['cc.UITransform', 'cc.Label'],
                            props: { 'cc.Label': { string: '设置', fontSize: 32, isBold: true }, 'cc.UITransform': { contentSize: { width: 200, height: 50 } } },
                            position: { x: 0, y: 0, z: 0 },
                        },
                    ],
                },
                {
                    name: 'SettingsContent',
                    position: { x: 0, y: 0, z: 0 },
                    children: [
                        {
                            name: 'AudioSection',
                            components: ['cc.UITransform', 'cc.Label'],
                            props: { 'cc.Label': { string: '音量', fontSize: 28 }, 'cc.UITransform': { contentSize: { width: 200, height: 40 } } },
                            position: { x: -300, y: 200, z: 0 },
                        },
                        {
                            name: 'VolumeSlider', type: 'Slider',
                            components: ['cc.UITransform', 'cc.Slider'],
                            props: { 'cc.Slider': { progress: 0.8 }, 'cc.UITransform': { contentSize: { width: 300, height: 20 } } },
                            position: { x: 100, y: 200, z: 0 },
                        },
                        {
                            name: 'GraphicsSection',
                            components: ['cc.UITransform', 'cc.Label'],
                            props: { 'cc.Label': { string: '画质', fontSize: 28 }, 'cc.UITransform': { contentSize: { width: 200, height: 40 } } },
                            position: { x: -300, y: 100, z: 0 },
                        },
                        {
                            name: 'GraphicsToggle', type: 'Toggle',
                            components: ['cc.UITransform', 'cc.Toggle', 'cc.Label'],
                            props: { 'cc.Label': { string: '高画质', fontSize: 24 }, 'cc.UITransform': { contentSize: { width: 120, height: 40 } } },
                            position: { x: 100, y: 100, z: 0 },
                        },
                    ],
                },
            ],
        },
    },
};

@MCPModule('template', 'UI 模板 - 预定义 UI 布局一键应用（dialog/scroll_list/nav_bar/settings_page）')
export class TemplateModule {

    @MCPTool('列出所有可用的 UI 模板', {})
    async list(): Promise<any> {
        const templates = Object.entries(TEMPLATES).map(([name, def]) => ({
            name,
            description: def.description,
        }));
        return { templates };
    }

    @MCPTool('应用指定 UI 模板到场景中', {
        template: { type: 'string', description: '模板名: dialog / scroll_list / nav_bar / settings_page', required: true },
        parent: { type: 'string', description: '父节点名或 UUID（默认 Canvas）' },
        name: { type: 'string', description: '根节点名称覆盖（可选）' },
    })
    async apply(params: { template: string; parent?: string; name?: string }): Promise<any> {
        const def = TEMPLATES[params.template];
        if (!def) {
            return {
                isError: true,
                content: [{ type: 'text', text: `未知模板: "${params.template}"。可用: ${Object.keys(TEMPLATES).join(', ')}` }],
            };
        }

        // 复制模板树，可选覆盖根节点名称
        const tree = JSON.parse(JSON.stringify(def.tree));
        if (params.name) {
            tree.name = params.name;
        }

        // 手动构建：创建根节点并递归
        const createdNodes: { name: string; uuid: string }[] = [];
        let parentUuid: string | undefined;

        if (params.parent) {
            const result = await executeSceneScript('findNodeByName', [params.parent]);
            if (result.success && result.data && result.data.length > 0) {
                parentUuid = result.data[0].uuid;
            }
        }

        const buildNode = async (def: any, parent?: string): Promise<string | null> => {
            const nodeResult = await executeSceneScript('createNode', [def.name, parent]);
            if (!nodeResult.success) return null;
            const uuid = nodeResult.data?.uuid;
            if (!uuid) return null;
            createdNodes.push({ name: def.name, uuid });

            // 添加组件
            if (def.components) {
                for (const comp of def.components) {
                    await executeSceneScript('addComponentToNode', [uuid, comp]);
                }
            }

            // 设置组件属性
            if (def.props) {
                for (const [compType, props] of Object.entries(def.props)) {
                    if (props && typeof props === 'object') {
                        for (const [propName, propValue] of Object.entries(props as object)) {
                            try {
                                await executeSceneScript('setComponentProperty', [uuid, compType as string, propName, propValue]);
                            } catch { /* 跳过 */ }
                        }
                    }
                }
            }

            // 设置 position
            if (def.position) {
                await executeSceneScript('setNodeProperty', [uuid, 'position', def.position]);
            }

            // 递归子节点
            if (def.children && Array.isArray(def.children)) {
                for (const child of def.children) {
                    await buildNode(child, uuid);
                }
            }

            return uuid;
        };

        await buildNode(tree, parentUuid);

        return {
            message: `模板 '${params.template}' 已应用，共创建 ${createdNodes.length} 个节点`,
            nodes: createdNodes,
        };
    }
}
