/**
 * 调试/诊断模块 — 控制台捕获、场景统计、运行时信息
 *
 * 提供运行时状态可观测性：让 AI 能"看到"控制台输出、场景节点/组件数量等。
 */

import { MCPModule, MCPTool } from '../decorators';

/** 控制台捕获缓冲区 */
const consoleBuffer: { timestamp: string; type: 'log' | 'warn' | 'error' | 'info'; message: string }[] = [];
const MAX_BUFFER = 500;
let captureActive = false;
let originalConsole: any = null;

function startCapture() {
    if (captureActive) return;
    captureActive = true;
    originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
    };

    const wrap = (type: 'log' | 'warn' | 'error' | 'info', original: Function) => {
        return (...args: any[]) => {
            const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            consoleBuffer.push({ timestamp: new Date().toISOString(), type, message });
            if (consoleBuffer.length > MAX_BUFFER) consoleBuffer.shift();
            original.apply(console, args);
        };
    };

    console.log = wrap('log', originalConsole.log);
    console.warn = wrap('warn', originalConsole.warn);
    console.error = wrap('error', originalConsole.error);
    console.info = wrap('info', originalConsole.info);
}

function stopCapture() {
    if (!captureActive) return;
    captureActive = false;
    if (originalConsole) {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.info = originalConsole.info;
        originalConsole = null;
    }
}

/** 安全调用 editor API */
async function callScene(method: string, ...args: any[]): Promise<any> {
    try {
        return await Editor.Message.request('scene', method, ...args);
    } catch (e: any) {
        throw new Error(`场景消息 '${method}' 失败: ${e.message || e}`);
    }
}

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

@MCPModule('debug', '调试诊断 - 控制台捕获、场景统计、运行时信息')
export class DebugModule {

    // ==================== 控制台捕获 ====================

    @MCPTool('开启控制台日志捕获（拦截 console.log/warn/error）')
    start_console_capture(): any {
        startCapture();
        return { message: '控制台捕获已开启', bufferSize: consoleBuffer.length };
    }

    @MCPTool('停止控制台捕获')
    stop_console_capture(): any {
        stopCapture();
        return { message: '控制台捕获已停止' };
    }

    @MCPTool('获取捕获的控制台日志', {
        type: { type: 'string', description: '日志类型过滤（log/warn/error/info），默认全部' },
        limit: { type: 'string', description: '返回条数上限（默认 50）' },
    })
    get_console_logs(params?: { type?: string; limit?: string }): any {
        let logs = [...consoleBuffer];
        if (params?.type) {
            logs = logs.filter(l => l.type === params.type);
        }
        const limit = parseInt(params?.limit || '50', 10);
        logs = logs.slice(-limit);
        return {
            logs,
            total: consoleBuffer.length,
            captureActive,
        };
    }

    @MCPTool('清除控制台捕获缓冲区')
    clear_console_logs(): any {
        consoleBuffer.length = 0;
        return { message: '缓冲区已清除' };
    }

    // ==================== 场景统计 ====================

    @MCPTool('获取当前场景运行时统计（节点数/组件数/绘制调用等）')
    async get_scene_stats(): Promise<any> {
        // 通过场景脚本收集运行时信息
        const sceneInfo = await executeSceneScript('getCurrentSceneInfo');
        const allNodes = await executeSceneScript('getAllNodes');

        let componentCount = 0;
        if (allNodes.data && Array.isArray(allNodes.data)) {
            // 粗略估算：每个节点至少有一个 Transform
            componentCount = allNodes.data.length;
        }

        return {
            sceneName: sceneInfo.data?.name,
            nodeCount: sceneInfo.data?.nodeCount ?? allNodes.data?.length ?? 0,
            estimatedComponentCount: componentCount,
            active: sceneInfo.data?.active,
        };
    }

    @MCPTool('获取场景中所有组件类型的统计分布')
    async get_component_stats(): Promise<any> {
        try {
            const hierarchy = await executeSceneScript('getSceneHierarchy', [true]);
            const counts: Record<string, number> = {};

            const walk = (node: any) => {
                if (node.components) {
                    node.components.forEach((c: any) => {
                        counts[c.type] = (counts[c.type] || 0) + 1;
                    });
                }
                if (node.children) node.children.forEach(walk);
            };

            if (hierarchy.data) {
                (Array.isArray(hierarchy.data) ? hierarchy.data : [hierarchy.data]).forEach(walk);
            }

            return { componentDistribution: counts };
        } catch (e: any) {
            throw new Error(`获取组件统计失败: ${e.message}`);
        }
    }

    // ==================== 编辑器诊断 ====================

    @MCPTool('查询编辑器关键状态（场景是否就绪、是否有未保存修改等）')
    async get_editor_status(): Promise<any> {
        const results: Record<string, any> = {};

        try { results.sceneReady = await callScene('query-is-ready'); } catch { results.sceneReady = 'unknown'; }
        try { results.sceneDirty = await callScene('query-dirty'); } catch { results.sceneDirty = 'unknown'; }
        try {
            const cs = await callScene('query-current-scene');
            results.currentScene = cs?.name || null;
        } catch { results.currentScene = null; }

        return results;
    }

    @MCPTool('获取编辑器扩展运行环境信息')
    get_environment_info(): any {
        return {
            editorVersion: Editor.App?.version || 'unknown',
            platform: process.platform,
            nodeVersion: process.version,
            arch: process.arch,
            cwd: process.cwd(),
            mcpExtensionVersion: '1.0.0',
        };
    }
}
