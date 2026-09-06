"use strict";
/**
 * UI 模板模块 — 预定义 UI 布局的一键应用
 *
 * 内置模板: dialog, scroll_list, nav_bar, settings_page
 * 内部通过 BuilderModule.build 构建节点树。
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateModule = void 0;
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
/** 内置模板定义 */
const TEMPLATES = {
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
let TemplateModule = class TemplateModule {
    async list() {
        const templates = Object.entries(TEMPLATES).map(([name, def]) => ({
            name,
            description: def.description,
        }));
        return { templates };
    }
    async apply(params) {
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
        const createdNodes = [];
        let parentUuid;
        if (params.parent) {
            const result = await executeSceneScript('findNodeByName', [params.parent]);
            if (result.success && result.data && result.data.length > 0) {
                parentUuid = result.data[0].uuid;
            }
        }
        const buildNode = async (def, parent) => {
            var _a;
            const nodeResult = await executeSceneScript('createNode', [def.name, parent]);
            if (!nodeResult.success)
                return null;
            const uuid = (_a = nodeResult.data) === null || _a === void 0 ? void 0 : _a.uuid;
            if (!uuid)
                return null;
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
                        for (const [propName, propValue] of Object.entries(props)) {
                            try {
                                await executeSceneScript('setComponentProperty', [uuid, compType, propName, propValue]);
                            }
                            catch ( /* 跳过 */_b) { /* 跳过 */ }
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
};
exports.TemplateModule = TemplateModule;
__decorate([
    (0, decorators_1.MCPTool)('列出所有可用的 UI 模板', {})
], TemplateModule.prototype, "list", null);
__decorate([
    (0, decorators_1.MCPTool)('应用指定 UI 模板到场景中', {
        template: { type: 'string', description: '模板名: dialog / scroll_list / nav_bar / settings_page', required: true },
        parent: { type: 'string', description: '父节点名或 UUID（默认 Canvas）' },
        name: { type: 'string', description: '根节点名称覆盖（可选）' },
    })
], TemplateModule.prototype, "apply", null);
exports.TemplateModule = TemplateModule = __decorate([
    (0, decorators_1.MCPModule)('template', 'UI 模板 - 预定义 UI 布局一键应用（dialog/scroll_list/nav_bar/settings_page）')
], TemplateModule);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVGVtcGxhdGVNb2R1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvVGVtcGxhdGVNb2R1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7QUFFSCw4Q0FBbUQ7QUFHbkQsS0FBSyxVQUFVLGtCQUFrQixDQUFDLE1BQWMsRUFBRSxPQUFjLEVBQUU7SUFDOUQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxzQkFBc0IsRUFBRTtZQUNqRSxJQUFJLEVBQUUsVUFBVTtZQUNoQixNQUFNO1lBQ04sSUFBSTtTQUNQLENBQUMsQ0FBQztJQUNQLENBQUM7SUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO1FBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLE1BQU0sU0FBUyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDOUQsQ0FBQztBQUNMLENBQUM7QUFTRCxhQUFhO0FBQ2IsTUFBTSxTQUFTLEdBQWlDO0lBQzVDLE1BQU0sRUFBRTtRQUNKLElBQUksRUFBRSxRQUFRO1FBQ2QsV0FBVyxFQUFFLDJDQUEyQztRQUN4RCxJQUFJLEVBQUU7WUFDRixJQUFJLEVBQUUsWUFBWTtZQUNsQixRQUFRLEVBQUUsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRTtZQUM5QixVQUFVLEVBQUUsQ0FBQyxnQkFBZ0IsRUFBRSxXQUFXLENBQUM7WUFDM0MsS0FBSyxFQUFFO2dCQUNILFdBQVcsRUFBRSxFQUFFLFNBQVMsRUFBRSxLQUFLLEVBQUU7Z0JBQ2pDLGdCQUFnQixFQUFFLEVBQUUsV0FBVyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLEVBQUU7YUFDbkU7WUFDRCxR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O0NBQ0osQ0FBQTtBQTNGWSx3Q0FBYztBQUdqQjtJQURMLElBQUEsb0JBQU8sRUFBQyxlQUFlLEVBQUUsRUFBRSxDQUFDOzBDQU81QjtBQU9LO0lBTEwsSUFBQSxvQkFBTyxFQUFDLGdCQUFnQixFQUFFO1FBQ3ZCLFFBQVEsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLHFEQUFxRCxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7UUFDaEgsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsdUJBQXVCLEVBQUU7UUFDaEUsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxXQUFXLEVBQUUsYUFBYSxFQUFFO0tBQ3ZELENBQUM7MkNBMkVEO3lCQTFGUSxjQUFjO0lBRDFCLElBQUEsc0JBQVMsRUFBQyxVQUFVLEVBQUUsaUVBQWlFLENBQUM7R0FDNUUsY0FBYyxDQTJGMUIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFVJIOaooeadv+aooeWdlyDigJQg6aKE5a6a5LmJIFVJIOW4g+WxgOeahOS4gOmUruW6lOeUqFxuICpcbiAqIOWGhee9ruaooeadvzogZGlhbG9nLCBzY3JvbGxfbGlzdCwgbmF2X2Jhciwgc2V0dGluZ3NfcGFnZVxuICog5YaF6YOo6YCa6L+HIEJ1aWxkZXJNb2R1bGUuYnVpbGQg5p6E5bu66IqC54K55qCR44CCXG4gKi9cblxuaW1wb3J0IHsgTUNQTW9kdWxlLCBNQ1BUb29sIH0gZnJvbSAnLi4vZGVjb3JhdG9ycyc7XG5pbXBvcnQgeyBMQVlPVVRfUEFUVEVSTlMgfSBmcm9tICcuLi9rbm93bGVkZ2Uva25vd2xlZGdlRGF0YSc7XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTY2VuZVNjcmlwdChtZXRob2Q6IHN0cmluZywgYXJnczogYW55W10gPSBbXSk6IFByb21pc2U8YW55PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogJ21jcF9nYW1lJyxcbiAgICAgICAgICAgIG1ldGhvZCxcbiAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+iEmuacrCAnJHttZXRob2R9JyDlpLHotKU6ICR7ZS5tZXNzYWdlIHx8IGV9YCk7XG4gICAgfVxufVxuXG4vKiog5qih5p2/5a6a5LmJICovXG5pbnRlcmZhY2UgVUlEZWZpbml0aW9uIHtcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgICB0cmVlOiBhbnk7XG59XG5cbi8qKiDlhoXnva7mqKHmnb/lrprkuYkgKi9cbmNvbnN0IFRFTVBMQVRFUzogUmVjb3JkPHN0cmluZywgVUlEZWZpbml0aW9uPiA9IHtcbiAgICBkaWFsb2c6IHtcbiAgICAgICAgbmFtZTogJ2RpYWxvZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5qih5oCB5by556qX77ya5Y2K6YCP5piO6YGu572pICsg5bGF5Lit6Z2i5p2/ICsg5qCH6aKYICsg5YWz6Zet5oyJ6ZKuICsg5YaF5a65ICsg5pON5L2c5oyJ6ZKuJyxcbiAgICAgICAgdHJlZToge1xuICAgICAgICAgICAgbmFtZTogJ0RpYWxvZ1Jvb3QnLFxuICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5TcHJpdGUnXSxcbiAgICAgICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgICAgICAgJ2NjLlNwcml0ZSc6IHsgZ3JheXNjYWxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgICAgICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDE5MjAsIGhlaWdodDogMTA4MCB9IH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgY2hpbGRyZW46IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6ICdCZ092ZXJsYXknLFxuICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLlNwcml0ZSddLFxuICAgICAgICAgICAgICAgICAgICBwcm9wczogeyAnY2MuU3ByaXRlJzogeyBncmF5c2NhbGU6IGZhbHNlIH0gfSxcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiAnUGFuZWwnLFxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiAwLCB5OiAwLCB6OiAwIH0sXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IFsnY2MuVUlUcmFuc2Zvcm0nLCAnY2MuU3ByaXRlJ10sXG4gICAgICAgICAgICAgICAgICAgIHByb3BzOiB7ICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDYwMCwgaGVpZ2h0OiA0MDAgfSB9IH0sXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkcmVuOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ1RpdGxlJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLkxhYmVsJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICfmoIfpopgnLCBmb250U2l6ZTogMzIsIGhvcml6b250YWxBbGlnbjogMSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiA1MDAsIGhlaWdodDogNTAgfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMTUwLCB6OiAwIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6ICdDbG9zZUJ0bicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogJ0J1dHRvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5CdXR0b24nLCAnY2MuU3ByaXRlJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogNDAsIGhlaWdodDogNDAgfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMjYwLCB5OiAxNTAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ0NvbnRlbnQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IFsnY2MuVUlUcmFuc2Zvcm0nLCAnY2MuTGFiZWwnXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuTGFiZWwnOiB7IHN0cmluZzogJ+WGheWuueWMuuWfnycsIGZvbnRTaXplOiAyNCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiA1MDAsIGhlaWdodDogMjAwIH0gfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ0J1dHRvbkdyb3VwJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHsgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogNDAwLCBoZWlnaHQ6IDYwIH0gfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IC0xNTAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaGlsZHJlbjogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnQ2FuY2VsQnRuJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6ICdCdXR0b24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5CdXR0b24nLCAnY2MuTGFiZWwnXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICflj5bmtognLCBmb250U2l6ZTogMjQgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiAxNDAsIGhlaWdodDogNTAgfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IC0xMjAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ0NvbmZpcm1CdG4nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogJ0J1dHRvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLkJ1dHRvbicsICdjYy5MYWJlbCddLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuTGFiZWwnOiB7IHN0cmluZzogJ+ehruiupCcsIGZvbnRTaXplOiAyNCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDE0MCwgaGVpZ2h0OiA1MCB9IH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMTIwLCB5OiAwLCB6OiAwIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICBzY3JvbGxfbGlzdDoge1xuICAgICAgICBuYW1lOiAnc2Nyb2xsX2xpc3QnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+WeguebtOa7muWKqOWIl+ihqO+8mlNjcm9sbFZpZXcgKyBNYXNrICsgY29udGVudCDluIPlsYAgKyDliJfooajpobknLFxuICAgICAgICB0cmVlOiB7XG4gICAgICAgICAgICBuYW1lOiAnU2Nyb2xsVmlldycsXG4gICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLlNjcm9sbFZpZXcnXSxcbiAgICAgICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgICAgICAgJ2NjLlNjcm9sbFZpZXcnOiB7IGhvcml6b250YWw6IGZhbHNlLCB2ZXJ0aWNhbDogdHJ1ZSwgZWxhc3RpYzogdHJ1ZSwgaW5lcnRpYTogdHJ1ZSB9LFxuICAgICAgICAgICAgICAgICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDQwMCwgaGVpZ2h0OiA2MDAgfSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgIGNoaWxkcmVuOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiAndmlldycsXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IFsnY2MuVUlUcmFuc2Zvcm0nLCAnY2MuTWFzayddLFxuICAgICAgICAgICAgICAgICAgICBwcm9wczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogNDAwLCBoZWlnaHQ6IDYwMCB9IH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgY2hpbGRyZW46IFtcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnY29udGVudCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5MYXlvdXQnXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuTGF5b3V0JzogeyB0eXBlOiAxLCByZXNpemVNb2RlOiAxLCBzcGFjaW5nWTogOCwgcGFkZGluZ1RvcDogOCwgcGFkZGluZ0JvdHRvbTogOCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiA0MDAsIGhlaWdodDogMTAwMCB9IH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiAwLCB5OiAwLCB6OiAwIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiAnU2Nyb2xsQmFyJyxcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5TY3JvbGxCYXInXSxcbiAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdjYy5TY3JvbGxCYXInOiB7IGhhbmRsZVNpemU6IDQwIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiAxMCwgaGVpZ2h0OiA2MDAgfSB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiAxOTUsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICB9LFxuICAgIG5hdl9iYXI6IHtcbiAgICAgICAgbmFtZTogJ25hdl9iYXInLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+mhtuagj+WvvOiIqu+8mui/lOWbnuaMiemSriArIOagh+mimCArIOWPs+aMiemSricsXG4gICAgICAgIHRyZWU6IHtcbiAgICAgICAgICAgIG5hbWU6ICdOYXZCYXInLFxuICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybSddLFxuICAgICAgICAgICAgcHJvcHM6IHsgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogMTkyMCwgaGVpZ2h0OiA4MCB9IH0gfSxcbiAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDM2MCwgejogMCB9LFxuICAgICAgICAgICAgY2hpbGRyZW46IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6ICdCYWNrQnRuJyxcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogJ0J1dHRvbicsXG4gICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IFsnY2MuVUlUcmFuc2Zvcm0nLCAnY2MuQnV0dG9uJywgJ2NjLkxhYmVsJ10sXG4gICAgICAgICAgICAgICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnY2MuTGFiZWwnOiB7IHN0cmluZzogJ+KAuSDov5Tlm54nLCBmb250U2l6ZTogMjggfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDEwMCwgaGVpZ2h0OiA1MCB9IH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IC04NjAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogJ1RpdGxlJyxcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5MYWJlbCddLFxuICAgICAgICAgICAgICAgICAgICBwcm9wczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICfmoIfpopgnLCBmb250U2l6ZTogMzIsIGlzQm9sZDogdHJ1ZSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogNDAwLCBoZWlnaHQ6IDUwIH0gfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiAnUmlnaHRCdG4nLFxuICAgICAgICAgICAgICAgICAgICB0eXBlOiAnQnV0dG9uJyxcbiAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5CdXR0b24nLCAnY2MuTGFiZWwnXSxcbiAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdjYy5MYWJlbCc6IHsgc3RyaW5nOiAn6K6+572uJywgZm9udFNpemU6IDI4IH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiAxMDAsIGhlaWdodDogNTAgfSB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiA4NjAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICB9LFxuICAgIHNldHRpbmdzX3BhZ2U6IHtcbiAgICAgICAgbmFtZTogJ3NldHRpbmdzX3BhZ2UnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+iuvue9rumhtemdou+8mui/lOWbnuWvvOiIqiArIOiuvue9ruadoeebruWIl+ihqO+8iOmfs+mHj+a7keWdl+OAgeeUu+i0qOS4i+aLieOAgeW8gOWFs+etie+8iScsXG4gICAgICAgIHRyZWU6IHtcbiAgICAgICAgICAgIG5hbWU6ICdTZXR0aW5nc1Jvb3QnLFxuICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgICAgICAgY2hpbGRyZW46IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIG5hbWU6ICdOYXZCYXInLFxuICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJ10sXG4gICAgICAgICAgICAgICAgICAgIHByb3BzOiB7ICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDE5MjAsIGhlaWdodDogODAgfSB9IH0sXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDM2MCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICBjaGlsZHJlbjogW1xuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6ICdCYWNrQnRuJywgdHlwZTogJ0J1dHRvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5CdXR0b24nLCAnY2MuTGFiZWwnXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wczogeyAnY2MuTGFiZWwnOiB7IHN0cmluZzogJ+KAuSDov5Tlm54nLCBmb250U2l6ZTogMjggfSwgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogMTAwLCBoZWlnaHQ6IDUwIH0gfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IC04NjAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ1RpdGxlJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLkxhYmVsJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHsgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICforr7nva4nLCBmb250U2l6ZTogMzIsIGlzQm9sZDogdHJ1ZSB9LCAnY2MuVUlUcmFuc2Zvcm0nOiB7IGNvbnRlbnRTaXplOiB7IHdpZHRoOiAyMDAsIGhlaWdodDogNTAgfSB9IH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogJ1NldHRpbmdzQ29udGVudCcsXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IDAsIHk6IDAsIHo6IDAgfSxcbiAgICAgICAgICAgICAgICAgICAgY2hpbGRyZW46IFtcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnQXVkaW9TZWN0aW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLkxhYmVsJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHsgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICfpn7Pph48nLCBmb250U2l6ZTogMjggfSwgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogMjAwLCBoZWlnaHQ6IDQwIH0gfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IC0zMDAsIHk6IDIwMCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnVm9sdW1lU2xpZGVyJywgdHlwZTogJ1NsaWRlcicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50czogWydjYy5VSVRyYW5zZm9ybScsICdjYy5TbGlkZXInXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wczogeyAnY2MuU2xpZGVyJzogeyBwcm9ncmVzczogMC44IH0sICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDMwMCwgaGVpZ2h0OiAyMCB9IH0gfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiAxMDAsIHk6IDIwMCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnR3JhcGhpY3NTZWN0aW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLkxhYmVsJ10sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHM6IHsgJ2NjLkxhYmVsJzogeyBzdHJpbmc6ICfnlLvotKgnLCBmb250U2l6ZTogMjggfSwgJ2NjLlVJVHJhbnNmb3JtJzogeyBjb250ZW50U2l6ZTogeyB3aWR0aDogMjAwLCBoZWlnaHQ6IDQwIH0gfSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB7IHg6IC0zMDAsIHk6IDEwMCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnR3JhcGhpY3NUb2dnbGUnLCB0eXBlOiAnVG9nZ2xlJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBbJ2NjLlVJVHJhbnNmb3JtJywgJ2NjLlRvZ2dsZScsICdjYy5MYWJlbCddLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzOiB7ICdjYy5MYWJlbCc6IHsgc3RyaW5nOiAn6auY55S76LSoJywgZm9udFNpemU6IDI0IH0sICdjYy5VSVRyYW5zZm9ybSc6IHsgY29udGVudFNpemU6IHsgd2lkdGg6IDEyMCwgaGVpZ2h0OiA0MCB9IH0gfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogeyB4OiAxMDAsIHk6IDEwMCwgejogMCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICB9LFxufTtcblxuQE1DUE1vZHVsZSgndGVtcGxhdGUnLCAnVUkg5qih5p2/IC0g6aKE5a6a5LmJIFVJIOW4g+WxgOS4gOmUruW6lOeUqO+8iGRpYWxvZy9zY3JvbGxfbGlzdC9uYXZfYmFyL3NldHRpbmdzX3BhZ2XvvIknKVxuZXhwb3J0IGNsYXNzIFRlbXBsYXRlTW9kdWxlIHtcblxuICAgIEBNQ1BUb29sKCfliJflh7rmiYDmnInlj6/nlKjnmoQgVUkg5qih5p2/Jywge30pXG4gICAgYXN5bmMgbGlzdCgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCB0ZW1wbGF0ZXMgPSBPYmplY3QuZW50cmllcyhURU1QTEFURVMpLm1hcCgoW25hbWUsIGRlZl0pID0+ICh7XG4gICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IGRlZi5kZXNjcmlwdGlvbixcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4geyB0ZW1wbGF0ZXMgfTtcbiAgICB9XG5cbiAgICBATUNQVG9vbCgn5bqU55So5oyH5a6aIFVJIOaooeadv+WIsOWcuuaZr+S4rScsIHtcbiAgICAgICAgdGVtcGxhdGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5qih5p2/5ZCNOiBkaWFsb2cgLyBzY3JvbGxfbGlzdCAvIG5hdl9iYXIgLyBzZXR0aW5nc19wYWdlJywgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgICAgcGFyZW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+eItuiKgueCueWQjeaIliBVVUlE77yI6buY6K6kIENhbnZhc++8iScgfSxcbiAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmoLnoioLngrnlkI3np7Dopobnm5bvvIjlj6/pgInvvIknIH0sXG4gICAgfSlcbiAgICBhc3luYyBhcHBseShwYXJhbXM6IHsgdGVtcGxhdGU6IHN0cmluZzsgcGFyZW50Pzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0pOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCBkZWYgPSBURU1QTEFURVNbcGFyYW1zLnRlbXBsYXRlXTtcbiAgICAgICAgaWYgKCFkZWYpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGDmnKrnn6XmqKHmnb86IFwiJHtwYXJhbXMudGVtcGxhdGV9XCLjgILlj6/nlKg6ICR7T2JqZWN0LmtleXMoVEVNUExBVEVTKS5qb2luKCcsICcpfWAgfV0sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5aSN5Yi25qih5p2/5qCR77yM5Y+v6YCJ6KaG55uW5qC56IqC54K55ZCN56ewXG4gICAgICAgIGNvbnN0IHRyZWUgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGRlZi50cmVlKSk7XG4gICAgICAgIGlmIChwYXJhbXMubmFtZSkge1xuICAgICAgICAgICAgdHJlZS5uYW1lID0gcGFyYW1zLm5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDmiYvliqjmnoTlu7rvvJrliJvlu7rmoLnoioLngrnlubbpgJLlvZJcbiAgICAgICAgY29uc3QgY3JlYXRlZE5vZGVzOiB7IG5hbWU6IHN0cmluZzsgdXVpZDogc3RyaW5nIH1bXSA9IFtdO1xuICAgICAgICBsZXQgcGFyZW50VXVpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwYXJhbXMucGFyZW50KSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlU2NlbmVTY3JpcHQoJ2ZpbmROb2RlQnlOYW1lJywgW3BhcmFtcy5wYXJlbnRdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuc3VjY2VzcyAmJiByZXN1bHQuZGF0YSAmJiByZXN1bHQuZGF0YS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgcGFyZW50VXVpZCA9IHJlc3VsdC5kYXRhWzBdLnV1aWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBidWlsZE5vZGUgPSBhc3luYyAoZGVmOiBhbnksIHBhcmVudD86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4gPT4ge1xuICAgICAgICAgICAgY29uc3Qgbm9kZVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnY3JlYXRlTm9kZScsIFtkZWYubmFtZSwgcGFyZW50XSk7XG4gICAgICAgICAgICBpZiAoIW5vZGVSZXN1bHQuc3VjY2VzcykgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBjb25zdCB1dWlkID0gbm9kZVJlc3VsdC5kYXRhPy51dWlkO1xuICAgICAgICAgICAgaWYgKCF1dWlkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGNyZWF0ZWROb2Rlcy5wdXNoKHsgbmFtZTogZGVmLm5hbWUsIHV1aWQgfSk7XG5cbiAgICAgICAgICAgIC8vIOa3u+WKoOe7hOS7tlxuICAgICAgICAgICAgaWYgKGRlZi5jb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wIG9mIGRlZi5jb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnYWRkQ29tcG9uZW50VG9Ob2RlJywgW3V1aWQsIGNvbXBdKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOiuvue9rue7hOS7tuWxnuaAp1xuICAgICAgICAgICAgaWYgKGRlZi5wcm9wcykge1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgW2NvbXBUeXBlLCBwcm9wc10gb2YgT2JqZWN0LmVudHJpZXMoZGVmLnByb3BzKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocHJvcHMgJiYgdHlwZW9mIHByb3BzID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBbcHJvcE5hbWUsIHByb3BWYWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocHJvcHMgYXMgb2JqZWN0KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Q29tcG9uZW50UHJvcGVydHknLCBbdXVpZCwgY29tcFR5cGUgYXMgc3RyaW5nLCBwcm9wTmFtZSwgcHJvcFZhbHVlXSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCB7IC8qIOi3s+i/hyAqLyB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOiuvue9riBwb3NpdGlvblxuICAgICAgICAgICAgaWYgKGRlZi5wb3NpdGlvbikge1xuICAgICAgICAgICAgICAgIGF3YWl0IGV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0Tm9kZVByb3BlcnR5JywgW3V1aWQsICdwb3NpdGlvbicsIGRlZi5wb3NpdGlvbl0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDpgJLlvZLlrZDoioLngrlcbiAgICAgICAgICAgIGlmIChkZWYuY2hpbGRyZW4gJiYgQXJyYXkuaXNBcnJheShkZWYuY2hpbGRyZW4pKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBkZWYuY2hpbGRyZW4pIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgYnVpbGROb2RlKGNoaWxkLCB1dWlkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB1dWlkO1xuICAgICAgICB9O1xuXG4gICAgICAgIGF3YWl0IGJ1aWxkTm9kZSh0cmVlLCBwYXJlbnRVdWlkKTtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWVzc2FnZTogYOaooeadvyAnJHtwYXJhbXMudGVtcGxhdGV9JyDlt7LlupTnlKjvvIzlhbHliJvlu7ogJHtjcmVhdGVkTm9kZXMubGVuZ3RofSDkuKroioLngrlgLFxuICAgICAgICAgICAgbm9kZXM6IGNyZWF0ZWROb2RlcyxcbiAgICAgICAgfTtcbiAgICB9XG59XG4iXX0=