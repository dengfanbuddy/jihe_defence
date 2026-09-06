/**
 * MCP 管理面板
 *
 * 功能：
 * - 端口配置
 * - 服务器启停控制 + 状态指示
 * - 模块展示（启用/禁用开关，展开查看工具列表）
 * - 工具级开关（独立启用/禁用）
 * - 实时日志输出
 */

import { createApp, App, defineComponent } from 'vue';
import { readFileSync } from 'fs-extra';
import { join } from 'path';

// @ts-ignore
import packageJSON from '../../../package.json';

const PKG_NAME: string = (packageJSON as any).name;
const panelDataMap = new WeakMap<any, App>();

interface ToolState {
    name: string;
    description: string;
    enabled: boolean;
}

interface ModuleState {
    name: string;
    description: string;
    enabled: boolean;
    tools: ToolState[];
    expanded: boolean;
}

interface PanelData {
    running: boolean;
    port: number;
    modules: ModuleState[];
    logs: string[];
}

export = Editor.Panel.define({
    listeners: {
        show() {
            const app = panelDataMap.get(this);
            if (app) {
                const vm = app._instance?.proxy as any;
                if (vm) vm.loadStatus();
            }
        },
        hide() {},
    },

    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),

    $: {
        app: '#app',
    },

    ready() {
        if (this.$.app) {
            const app = createApp(
                defineComponent({
                    data(): PanelData {
                        return {
                            running: false,
                            port: 9786,
                            modules: [],
                            logs: [],
                        };
                    },

                    methods: {
                        // ===== 状态加载 =====
                        async loadStatus() {
                            try {
                                const status = await Editor.Message.request(PKG_NAME, 'query-mcp-status');
                                this.running = status.running;
                                this.port = status.port;
                                this.modules = (status.modules || []).map((m: any) => ({
                                    name: m.name,
                                    description: m.description,
                                    enabled: m.enabled,
                                    tools: (m.tools || []).map((t: any) => ({
                                        name: t.name,
                                        description: t.description,
                                        enabled: t.enabled,
                                    })),
                                    expanded: false,
                                }));
                            } catch (e) {
                                console.error('[MCP Panel] 加载状态失败:', e);
                            }
                        },

                        // ===== 服务器启停 =====
                        async startServer() {
                            try {
                                const result = await Editor.Message.request(PKG_NAME, 'start-mcp');
                                if (result.success) {
                                    this.log(`服务器已启动，端口: ${result.port}`);
                                } else {
                                    this.log(`启动失败: ${result.message}`);
                                }
                                await this.loadStatus();
                            } catch (e: any) {
                                this.log(`启动异常: ${e.message}`);
                            }
                        },

                        async stopServer() {
                            try {
                                const result = await Editor.Message.request(PKG_NAME, 'stop-mcp');
                                this.log(result.success ? '服务器已停止' : `停止失败: ${result.message}`);
                                await this.loadStatus();
                            } catch (e: any) {
                                this.log(`停止异常: ${e.message}`);
                            }
                        },

                        // ===== 模块/工具开关 =====
                        async toggleModule(name: string, enabled: boolean) {
                            await Editor.Message.request(PKG_NAME, 'set-module-enabled', name, enabled);
                            this.log(`模块 '${name}' ${enabled ? '已启用' : '已禁用'}`);
                            await this.loadStatus();
                        },

                        async toggleTool(moduleName: string, toolName: string, enabled: boolean) {
                            await Editor.Message.request(PKG_NAME, 'set-tool-enabled', moduleName, toolName, enabled);
                            this.log(`工具 '${moduleName}/${toolName}' ${enabled ? '已启用' : '已禁用'}`);
                            await this.loadStatus();
                        },

                        async updatePort(port: number) {
                            const result = await Editor.Message.request(PKG_NAME, 'set-mcp-port', port);
                            if (!result.success) {
                                this.log(`设置端口失败: ${result.message}`);
                            } else {
                                this.log(`端口已更新为: ${port}`);
                            }
                            await this.loadStatus();
                        },

                        // ===== 日志 =====
                        log(msg: string) {
                            const time = new Date().toLocaleTimeString();
                            this.logs.push(`[${time}] ${msg}`);
                            if (this.logs.length > 200) {
                                this.logs.shift();
                            }
                        },

                        // ===== 展开/折叠 =====
                        toggleExpand(name: string) {
                            const mod = this.modules.find((m: any) => m.name === name);
                            if (mod) {
                                mod.expanded = !mod.expanded;
                            }
                        },

                        // ===== 复制地址 =====
                        copyUrl(url: string) {
                            navigator.clipboard.writeText(url).then(() => {
                                this.log(`已复制: ${url}`);
                            }).catch(() => {
                                // 降级方案
                                const ta = document.createElement('textarea');
                                ta.value = url;
                                ta.style.position = 'fixed';
                                ta.style.opacity = '0';
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                document.body.removeChild(ta);
                                this.log(`已复制: ${url}`);
                            });
                        },
                    },

                    template: readFileSync(join(__dirname, '../../../static/template/vue/panel.html'), 'utf-8'),
                }),
            );
            app.mount(this.$.app);
            panelDataMap.set(this, app);

            // 初始加载状态
            const vm = app._instance?.proxy as any;
            if (vm) vm.loadStatus();
        }
    },

    beforeClose() {},

    close() {
        const app = panelDataMap.get(this);
        if (app) {
            app.unmount();
        }
    },
});
