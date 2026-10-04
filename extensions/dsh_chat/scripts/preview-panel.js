/**
 * 面板预览器 —— **不开 Cocos 编辑器**就把面板画出来看一眼。
 *
 * ## 它解决什么问题
 *
 * 改面板样式/渲染时，编辑器没有热重载（改 `dist/` 必须重启编辑器），一来一回几分钟，
 * 而且面板里的报错只能靠人去控制台里捞。这个脚本把**真实的**面板代码装进一个假环境：
 *
 * - 真实：`dist/panels/default/*.js`（面板本体 + markdown + 工具卡片）、
 *   `static/style/default/*.css`（含从 DSH 抽出来的 token 层）、`static/template/default/index.html`；
 * - 假：`Editor`（`Panel.define` 原样收下配置、`Message.request` 回一段**样例转写**）、
 *   `fs`/`path`（把静态文件按文件名喂进去）、`$`（在容器里按 `SELECTORS` 查一遍，
 *   与编辑器做的事一样）。
 *
 * 于是同一个渲染路径被完整跑了一遍：气泡 / markdown / 折叠思考块 / 工具卡片 / 状态行
 * 都会真画出来，JS 报错也会落在页面上（不用去编辑器控制台）。
 *
 * ## 用法
 *
 * ```
 * node extensions/dsh_chat/scripts/preview-panel.js              # 生成 .tmp/panel-preview/index.html
 * node extensions/dsh_chat/scripts/preview-panel.js --serve      # 顺便起个静态服务打印 URL
 * ```
 *
 * 生成物是**自包含**的（CSS/JS 全内联），双击就能在任何浏览器里打开。
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.tmp', 'panel-preview');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

/** 读取面板产物；缺文件时给出可操作的提示（多半是忘了 npm run build）。 */
function read(relative) {
    const file = path.join(EXTENSION_ROOT, relative);
    if (!fs.existsSync(file)) {
        console.error(`缺少 ${relative} —— 先跑 npm run build（在 extensions/dsh_chat 下）。`);
        process.exit(1);
    }
    return fs.readFileSync(file, 'utf8');
}

/** 内联进 <script>/<style> 时防住提前闭合。 */
function safe(text) {
    return text.replace(/<\/script/gi, '<\\/script').replace(/<\/style/gi, '<\\/style');
}

/** 一段能让卡片/气泡/markdown 都露脸的样例转写。 */
function sampleEntries() {
    return [
        {
            seq: 1,
            rev: 1,
            kind: 'user',
            at: Date.now() - 42000,
            text: '看一眼当前场景，把 Canvas 下的节点列出来；顺便讲一下 Main.ts 里 initBattle 都干了什么。',
        },
        {
            // 带图的两条样例：seq 故意用 100 段（不与下面的 1~9 撞号）
            seq: 100,
            rev: 100,
            kind: 'user',
            at: Date.now() - 41500,
            text: '这张图里的血条位置不对，帮我看看。',
            // 带图的消息：转写里只有**元数据**（像素不进转写，见 constants.ts 的 EntryImage）
            images: [{ name: 'gold_boss.png', mimeType: 'image/png', bytes: 62259, width: 128, height: 128 }],
        },
        {
            seq: 101,
            rev: 101,
            kind: 'user',
            at: Date.now() - 41300,
            text: '',
            // 纯图片消息：只画碎片（气泡里不该出现空文字）
            images: [{ mimeType: 'image/jpeg', bytes: 184320, width: 1920, height: 1080 }],
        },
        {
            seq: 2,
            rev: 2,
            kind: 'thinking',
            at: Date.now() - 41000,
            text:
                '用户要两件事：① 场景节点清单 —— 走 cocos_execute_code 的 scene 上下文拿 tree()；\n' +
                '② initBattle 的讲解 —— 先 read 那个文件，别凭记忆答。\n' +
                '注意 scene 上下文里 cc.find 对含斜杠的名字不好使，节点清单用 tree() 更稳。',
        },
        {
            seq: 3,
            rev: 3,
            kind: 'tool',
            at: Date.now() - 38000,
            tool: {
                name: 'cocos_execute_code',
                callId: 'call_1',
                args: '{"context":"scene","code":"return tree({maxDepth:2, withComponents:true})"}',
                output:
                    '{\n  "name": "Main",\n  "children": [\n    { "name": "Canvas", "components": ["Canvas", "UITransform", "Widget"] },\n    { "name": "damege_layer" },\n    { "name": "enimys" }\n  ]\n}',
                done: true,
                ok: true,
                endedAt: Date.now() - 37200,
            },
        },
        {
            seq: 4,
            rev: 4,
            kind: 'tool',
            at: Date.now() - 37000,
            tool: {
                name: 'cocos_describe_api',
                callId: 'call_1b',
                args: '{"context":"scene","target":"cc.UITransform","nodeUuid":"b9c33cda-6b22-4316-9689-92169ed6aacf"}',
                output:
                    '{\n  "ok": true,\n  "kind": "class",\n  "className": "cc.UITransform",\n  "instanceFound": true,\n  "definition": "// cc.UITransform  extends Component\\nexport class UITransform {\\n    _contentSize: any;  // 当前 = {\\"width\\":960,\\"height\\":640}\\n    _anchorPoint: any;"\n}',
                done: true,
                ok: true,
                endedAt: Date.now() - 36800,
            },
        },
        {
            seq: 5,
            rev: 5,
            kind: 'agent',
            at: Date.now() - 36000,
            text:
                '## 场景节点（maxDepth = 2）\n\n' +
                '当前打开的是 **Main** 场景，根节点下有这些：\n\n' +
                '- `Canvas` —— UI 根，挂着 `Canvas` / `UITransform` / `Widget`\n' +
                '- `damege_layer` —— 飘字层，与 `enimys` 同级，故意排在战斗实体之后\n' +
                '- `enimys` —— 怪物父节点\n\n' +
                '### initBattle 做了什么\n\n' +
                '一句话：**建 ctx、挂英雄、注册脚本化 modifier、绑战斗事件**。关键三行是：\n\n' +
                '```ts\n' +
                'this.ctx = new BattleContext(...)\n' +
                'ScriptedModifiers.register(this.ctx)\n' +
                'this.bindBattleEvents()\n' +
                '```\n\n' +
                '| 阶段 | 做的事 | 谁负责 |\n' +
                '| --- | --- | --- |\n' +
                '| 建容器 | `BattleContext` + 属性系统 | `initBattle` |\n' +
                '| 挂英雄 | `selectHero` 建实体、重挂遗物/Buff/技能槽 | `Scene_Game_Stage` |\n' +
                '| 绑事件 | `OnDeath` / `OnTakeDamage` / `BATTLE_ENDED` | `bindBattleEvents` |\n\n' +
                '> 结算只认 `endRun`：退出按钮**不算**一次对局结束。详见 [排错清单](https://example.com/docs) 那条。',
        },
        {
            seq: 6,
            rev: 6,
            kind: 'tool',
            at: Date.now() - 20000,
            tool: {
                name: 'pwsh',
                callId: 'call_2',
                args: '{"command":"npm run audit:attr","workdir":"tools/excel_export"}',
                output: '> audit:attr\n\n护甲 0 ⇒ 1.5   ✔\n回血 0 ⇒ 0.28  ✔\n\n2 项词条全部生效（退出码 0）',
                done: true,
                ok: true,
                endedAt: Date.now() - 12800,
            },
        },
        {
            seq: 7,
            rev: 7,
            kind: 'tool',
            at: Date.now() - 9000,
            tool: {
                name: 'edit',
                callId: 'call_3',
                args: '{"path":"assets/scripts/game/battle/Entity.ts","old_string":"if (this.hp <= 0)","new_string":"if (this.hp <= 0 && !this.dead)"}',
                output: '旧文本在 assets/scripts/game/battle/Entity.ts 里出现了 2 次，无法唯一确定要改哪一处。',
                done: true,
                ok: false,
                endedAt: Date.now() - 8400,
            },
        },
        {
            seq: 8,
            rev: 8,
            kind: 'note',
            at: Date.now() - 8000,
            text: '注入上下文：AGENTS.md（65143 字节，已按预算截断）',
        },
        {
            seq: 9,
            rev: 9,
            kind: 'error',
            at: Date.now() - 7000,
            text: 'dsh profile 同步失败：ENOENT: no such file or directory, open \'C:\\Users\\wx\\.dsh\\profiles\\cocos\\cordis.yml\'',
        },
    ];
}

/** 假 Editor：`Panel.define` 原样收下配置，`Message.request` 回样例数据。 */
function editorShim(entries, imageSample) {
    return `
const __entries = ${JSON.stringify(entries)};
const __query = new URLSearchParams(location.search);
window.__dshErrors = [];
// 调用计数：预览器用它断言「面板自己在轮询」——不传 show 钩子时计数也必须涨
window.__dshStats = { getState: 0, getEvents: 0, other: 0 };

/* ---- 图片样本 ----
 * list-images / read-image 的回执在这里造假，但**形状与真主进程一样**：
 * 面板那条归一化链路（解码 → 缩放 → 编码 → 缩略图）是真跑的，只有字节是样本。
 * 其中一张是现画的 3000×2000（超过 2048×2048 的预算 → 面板必须把它缩下来）。 */
const __sample = ${JSON.stringify(imageSample)};
const __sampleName = ${JSON.stringify(imageSample.name || 'sample.png')};
const __sampleBytes = Math.floor((__sample.data.length * 3) / 4);
const __bigPath = 'db://assets/resources/textures/game_bg/boss.png';

/**
 * 现画一张 3000×2000 的图（渐变 + 网格），用来验「超预算会缩到 2048×2048 像素以内」。
 * @param {boolean} [noisy] 加一层噪声：PNG 压不动（>4MB），用来验 PNG → webp / JPEG 那条梯子
 * @returns {Record<string, unknown>} read-image 形状的回执
 */
function __fakeBigImage(noisy) {
    const canvas = document.createElement('canvas');
    // 噪声那张用 2000×1500（**在像素预算内**，所以不会被缩）+ 纯噪声（**PNG 压不动**）：
    // 这样触发的是**字节预算**那条路（PNG → webp / JPEG），而不是缩放那条路
    canvas.width = noisy ? 2000 : 3000;
    canvas.height = noisy ? 1500 : 2000;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#2b6cb0');
    gradient.addColorStop(1, '#f6ad55');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    for (let x = 0; x < canvas.width; x += 150) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += 150) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
    if (noisy) {
        // 必须用真随机：周期序列（i*37 取模这种）PNG 一压就没了（实测 2000×1500 只剩 93KB），
        // 于是「字节超预算」这条路根本触发不到。真噪声才是压不动的。
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = (Math.random() * 256) | 0;
            data[i + 1] = (Math.random() * 256) | 0;
            data[i + 2] = (Math.random() * 256) | 0;
            data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
    }
    const dataUrl = canvas.toDataURL('image/png');
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { ok: true, name: noisy ? 'noisy.png' : 'boss.png', mimeType: 'image/png', bytes: Math.floor((data.length * 3) / 4), data };
}

/** 假工程图片清单（路径都在 assets/ 下，形状与 asset-db 那条路一致）。 */
const __fakeImages = [
    { url: __bigPath, path: 'D:/Project/demo/assets/resources/textures/game_bg/boss.png', name: 'boss.png', rel: 'db://assets/resources/textures/game_bg/boss.png', bytes: 971000, source: 'asset-db' },
    { url: 'db://assets/resources/textures/common/' + __sampleName, path: 'D:/Project/demo/assets/resources/textures/common/' + __sampleName, name: __sampleName, rel: 'db://assets/resources/textures/common/' + __sampleName, bytes: __sampleBytes, source: 'asset-db' },
    { url: 'db://assets/resources/textures/heros/hero_1.png', path: 'D:/Project/demo/assets/resources/textures/heros/hero_1.png', name: 'hero_1.png', rel: 'db://assets/resources/textures/heros/hero_1.png', bytes: 99700, source: 'asset-db' },
    { url: 'db://assets/resources/textures/items/yazhizhiren.png', path: 'D:/Project/demo/assets/resources/textures/items/yazhizhiren.png', name: 'yazhizhiren.png', rel: 'db://assets/resources/textures/items/yazhizhiren.png', bytes: 481000, source: 'asset-db' },
    { url: 'db://assets/resources/textures/skills/bullet.png', path: 'D:/Project/demo/assets/resources/textures/skills/bullet.png', name: 'bullet.png', rel: 'db://assets/resources/textures/skills/bullet.png', bytes: 4200, source: 'asset-db' },
    { url: 'db://assets/resources/textures/common/logo.png', path: 'D:/Project/demo/assets/resources/textures/common/logo.png', name: 'logo.png', rel: 'db://assets/resources/textures/common/logo.png', bytes: 235000, source: 'asset-db' },
];

/**
 * 模拟「按 Ctrl+V」：造一个带图的剪贴板事件丢给面板。
 * 用 Event + defineProperty('clipboardData') 而不是 new ClipboardEvent(...)：
 * 后者在部分 Chromium 版本里不接受 clipboardData 初值（拿到的永远是 null），
 * 而面板读的就是 event.clipboardData。
 * @param {string} [kind] text=纯文字（必须原样进输入框） bmp=非白名单格式 image=一张画出来的 PNG
 *   noise=不可压缩的大图（验 PNG → webp/JPEG 那条预算梯子）
 * @returns {string} 这次粘贴实际做了什么
 */
window.__dshFakePaste = function (kind) {
    const input = document.querySelector('.dsh-root #input');
    const transfer = new DataTransfer();
    if (kind === 'text') {
        transfer.setData('text/plain', '这是一段纯文字，粘贴后必须**原样**进输入框。');
    } else if (kind === 'bmp') {
        // 面板只收 png/jpeg/webp/gif：造一个 \"image/bmp\"，看它会不会被转成 PNG 而不是被丢掉
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e53e3e';
        ctx.fillRect(0, 0, 400, 240);
        const url = canvas.toDataURL('image/png');
        const binary = atob(url.slice(url.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], 'screenshot.bmp', { type: 'image/bmp' }));
    } else {
        const big = __fakeBigImage(kind === 'noise');
        const binary = atob(big.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], kind === 'noise' ? 'noisy.png' : 'image.png', { type: 'image/png' }));
    }    const target = input || document.querySelector('.dsh-root');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    target.dispatchEvent(event);
    return 'paste(' + (kind || 'image') + ') dispatched, defaultPrevented=' + event.defaultPrevented;
};

window.Editor = {
    Panel: {
        define(options) { window.__dshPanel = options; return options; },
    },
    Message: {
        async request(extension, message, payload) {
            if (window.__dshLog) window.__dshLog.push(extension + ':' + message);
            if (message === 'get-events') window.__dshStats.getEvents += 1;
            else if (message === 'get-state') window.__dshStats.getState += 1;
            else window.__dshStats.other += 1;
            if (message === 'get-state') {
                return {
                    ok: true,
                    agent: {
                        status: __query.get('status') || 'ready',
                        running: __query.get('idle') !== '1',
                        sessionId: 'a1b2c3d4e5f60718',
                        // ?view=history 看「只读回放」横幅；?view=resumed 看「已接上」
                        sessionKind: __query.get('view') === 'history' ? 'history' : __query.get('view') === 'resumed' ? 'resumed' : 'sdk',
                        history: __query.get('view')
                            ? {
                                  sessionId: 'ccafd312-6f0b-4c4d-9363-8f59aba0c2ea',
                                  title: '请用 10 行、每行一句话介绍响应式系统，行首不要任何符号。',
                                  createdAt: Date.now() - 86400000,
                                  messageCount: __entries.length,
                                  live: __query.get('view') === 'resumed',
                              }
                            : null,
                        generation: 1,
                        pid: 179188,
                        lastBootMs: 2354,
                        lastError: null,
                        entryCount: __entries.length,
                        revision: 99,
                        runtime: {
                            nodeExe: 'C:\\\\nvm4w\\\\nodejs\\\\node.exe',
                            dshBin: 'D:\\\\MyApplication\\\\nodejs\\\\node_cache\\\\node_modules\\\\@deepseek-ai\\\\dsh\\\\lib\\\\bin.js',
                            nodeSource: 'known-path',
                            dshSource: 'where',
                        },
                        stderrTail: [],
                    },
                    settings: {
                        autoStart: true,
                        nodePath: '',
                        dshBin: '',
                        provider: 'deepseek-official',
                        model: 'deepseek-v4-flash-vision-exp',
                        reasoningEffort: 'high',
                        maxTokens: 0,
                        workdir: '',
                        showStderrNotes: false,
                        // ?theme=light|dark|auto  ?font=12..17 —— 预览器自己的开关
                        theme: __query.get('theme') || 'dark',
                        fontSize: Number(__query.get('font') || 0),
                    },
                    profile: { ok: true, profileDir: 'C:\\\\Users\\\\wx\\\\.dsh\\\\profiles\\\\cocos', version: '1', changes: [] },
                };
            }
            if (message === 'get-events') return { ok: true, entries: __entries, revision: 99, generation: 1 };
            // 历史抽屉：回一组看起来像真的会话（点它只会把回放结果记进 __dshLog）
            if (message === 'history-list') {
                window.__dshHistoryAsked = true;
                return {
                    ok: true,
                    sessions: [
                        { id: 'session-1aba7f97-d490-49cc-acfd-6e888baa26f0', title: 'cocos里能嵌入dsh么？', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 600000, bytes: 2421519, turns: 2, current: false },
                        { id: '8a43a543-413b-458e-9ffb-42264dc1f412', title: '你是谁', createdAt: Date.now() - 7200000, updatedAt: Date.now() - 1800000, bytes: 636900, turns: 3, current: true },
                        { id: 'ccafd312-6f0b-4c4d-9363-8f59aba0c2ea', title: '请用 10 行、每行一句话介绍响应式系统，行首不要任何符号。', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 80000000, bytes: 188416, turns: 2, current: false },
                        { id: '6df0e7a6-68a9-4972-982c-8cee04cc55bf', title: '你是谁', createdAt: Date.now() - 172800000, updatedAt: Date.now() - 170000000, bytes: 78592, turns: 4, current: false },
                    ],
                };
            }
            if (message === 'history-open') return { ok: true, events: 143 };
            if (message === 'history-resume') return { ok: true, sessionId: payload && payload.sessionId };
            // ---- 图片（面板的粘贴/选图这条路）----
            // ?failimages=1 资源库读不到（看选择器的错误文案）；?readfail=1 单张读不出来（看横幅会不会被状态刷新抹掉）
            if (message === 'list-images') {
                if (__query.get('failimages') === '1') return { ok: false, error: 'asset-db 查询超时（预览里造的错）' };
                return { ok: true, source: __query.get('scan') === '1' ? 'scan' : 'asset-db', total: __fakeImages.length, images: __fakeImages };
            }
            if (message === 'read-image') {
                if (__query.get('readfail') === '1') return { ok: false, error: '这张图 25.0MB，超过单张上限 20.0MB（预览里造的错）' };
                // 真面板会拿到**真字节**：这里给样本字节（形状与主进程一致），大图那条现画一张
                const path = String((payload && payload.path) || '');
                if (/[\\\\/]boss\\.png$/.test(path)) return { ...__fakeBigImage(), path: path, url: (payload && payload.url) || '' };
                return {
                    ok: true,
                    name: __sampleName,
                    path: path,
                    url: (payload && payload.url) || '',
                    mimeType: __sample.mimeType,
                    bytes: __sampleBytes,
                    data: __sample.data,
                };
            }
            if (message === 'send-message') {
                // 记一笔「真发出去了什么」，自检条上显示图片张数与解码后的总字节
                const images = (payload && payload.images) || [];
                const bytes = images.reduce((sum, item) => sum + Math.floor((String(item.data || '').length * 3) / 4), 0);
                window.__dshSent = (window.__dshSent || []).concat([
                    { text: (payload && payload.text) || '', images: images.length, bytes, mimes: images.map((item) => item.mimeType) },
                ]);
                // 再把这条**回显**进转写：真主进程就是这么干的（append('user', …) + 元数据），
                // 于是「自己发出去的消息」那个气泡也能在预览里被验到（含 sentThumbs 的缩略图）
                __entries.push({
                    seq: 200 + __entries.length,
                    rev: 900 + __entries.length,
                    kind: 'user',
                    at: Date.now(),
                    text: (payload && payload.text) || '',
                    images: images.map((item) => ({ name: item.name, mimeType: item.mimeType })),
                });
                return { ok: true };
            }
            return { ok: true };
        },
    },
};
`;
}

/** 生成整页。 */
function buildHtml(parts) {
    const { template, tokensCss, componentCss, markdownJs, toolCardJs, constantsJs, imagesJs, panelJs, entries, imageSample } = parts;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>DSH 面板预览</title>
<style>
  html, body { margin: 0; background: #0b0c0e; color: #ddd; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { display: flex; gap: 18px; padding: 18px; align-items: flex-start; }
  .frame { display: flex; flex-direction: column; gap: 6px; }
  .frame > .label { color: #7d828a; font-size: 12px; }
  .panel-box { height: 780px; border-radius: 10px; overflow: hidden; outline: 1px solid #ffffff1f; background: #151517; }
  .wide { width: 640px; }
  .narrow { width: 380px; }
  #errors { margin: 12px 18px; padding: 10px 12px; border-radius: 8px; background: #f25a5a26; color: #f25a5a; white-space: pre-wrap; font: 12px/1.5 Consolas, monospace; display: none; }
  #stats { position: sticky; top: 0; z-index: 9; padding: 6px 18px; background: #151517; color: #9aa0a8; font: 12px/1.6 Consolas, monospace; border-bottom: 1px solid #ffffff1f; }
</style>
<style>${safe(tokensCss)}</style>
<style>${safe(componentCss)}</style>
</head>
<body>
<div id="errors"></div>
<!-- 自检条：轮询计数必须持续增长（面板靠自己 mount 时的轮询更新，不依赖 show 钩子） -->
<div id="stats">stats…</div>
<div class="wrap">
  <div class="frame"><div class="label">停靠宽度（package.json 的 min-width 380）</div><div class="panel-box narrow" id="panel-narrow">${template}</div></div>
  <div class="frame"><div class="label">拉宽到 640</div><div class="panel-box wide" id="panel-wide">${template}</div></div>
</div>

<script>
window.__dshLog = [];
window.addEventListener('error', (event) => {
  const box = document.getElementById('errors');
  box.style.display = 'block';
  box.textContent += (event.message || String(event.error)) + '\\n' + ((event.error && event.error.stack) || '') + '\\n';
});
</script>
<script>${safe(editorShim(entries, imageSample))}</script>
<script>
/* ---- CommonJS 环境（面板 dist 是 CJS：require('fs') / require('../../constants')） ---- */
(function () {
  const cache = {};
  const files = {
    '../../constants': ${JSON.stringify(constantsJs)},
    // 面板与主进程**共用**图片那份真源（MIME 白名单 / 上限 / 筛选），预览里也必须真加载它，
    // 否则「面板导入的常量」这条链路在预览里是假的
    '../../images': ${JSON.stringify(imagesJs)},
    './markdown': ${JSON.stringify(markdownJs)},
    './tool-card': ${JSON.stringify(toolCardJs)},
  };
  const pathShim = { join: function () { return Array.prototype.slice.call(arguments).join('/'); } };
  const fsShim = { readFileSync: function (file) { return window.__dshStatic[String(file).split(/[\\\\/]/).pop()] || ''; } };
  function load(id, source) {
    const module = { exports: {} };
    const fn = new Function('exports', 'require', 'module', '__dirname', source);
    fn(module.exports, requireShim, module, '/dsh_chat/dist/panels/default');
    cache[id] = module.exports;
    return module.exports;
  }
  function requireShim(id) {
    if (id === 'fs') return fsShim;
    if (id === 'path') return pathShim;
    if (cache[id]) return cache[id];
    if (files[id]) return load(id, files[id]);
    throw new Error('预览器没有这个模块：' + id);
  }
  window.__dshRequire = requireShim;
  window.__dshLoad = load;
})();
</script>
<script>
/* 静态文件（面板会按文件名 readFileSync，这里直接喂） */
window.__dshStatic = {
  'index.html': ${JSON.stringify(template)},
  'dsw-tokens.css': ${JSON.stringify(tokensCss)},
  'index.css': ${JSON.stringify(componentCss)},
};
</script>
<script>
try {
  __dshLoad('../../constants', ${JSON.stringify(constantsJs)});
  __dshLoad('../../images', ${JSON.stringify(imagesJs)});
  __dshLoad('./markdown', ${JSON.stringify(markdownJs)});
  __dshLoad('./tool-card', ${JSON.stringify(toolCardJs)});
  const options = __dshLoad('panel', ${JSON.stringify(panelJs)});
  window.__dshHookCalls = { show: 0, hide: 0 };
  window.__dshMissing = 0;
  // ?click=<选择器>：挂载后自动点一下（用来给历史抽屉拍照，不用手工点）
  const autoClick = __query.get('click');
  // 编辑器做的事：在面板子树里按选择器解析 $ 与调用生命周期钩子（这里手工做一遍，行为一致）
  for (const id of ['panel-narrow', 'panel-wide']) {
    const box = document.getElementById(id);
    const ctx = { $: {} };
    for (const key of Object.keys(options.$)) {
      const node = box.querySelector(options.$[key]);
      ctx.$[key] = node;
      if (!node) window.__dshMissing += 1;
    }
    const instance = { $: ctx.$, id: id };
    options.ready.call(instance);
    if (autoClick && box.querySelector(autoClick)) box.querySelector(autoClick).click();
    // ?noShow=1 故意**不**调 show：面板必须靠自己 mount 时就起来的轮询更新（回归口径）
    if (options.listeners && options.listeners.show && __query.get('noShow') !== '1') {
      options.listeners.show.call(instance);
      window.__dshHookCalls.show += 1;
    }
    // ?hide=毫秒：模拟「hide 钩子在面板仍可见时误触发」
    const hideAfter = Number(__query.get('hide') || 0);
    if (hideAfter > 0 && options.listeners && options.listeners.hide) {
      setTimeout(() => {
        options.listeners.hide.call(instance);
        window.__dshHookCalls.hide += 1;
      }, hideAfter);
    }
  }
  // 自检条：把计数画出来（不用开控制台，也不用往页面里注入脚本）
  const stats = document.getElementById('stats');
  // 布局自检：headless 截图看不到「哪块塌了」，所以把量出来的高度写进自检条（文本可读）
  function measure() {
    const out = [];
    for (const id of ['panel-narrow', 'panel-wide']) {
      const box = document.getElementById(id);
      const root = box.querySelector('.dsh-root');
      const body = box.querySelector('#body');
      const hist = box.querySelector('#history');
      const bar = box.querySelector('#history-bar');
      const images = box.querySelector('#attachments');
      const picker = box.querySelector('#picker');
      const overflow = root.scrollWidth - root.clientWidth;
      out.push(
        id.replace('panel-', '') +
          ': root=' + root.clientHeight +
          '/body=' + (body ? body.clientHeight : '?') +
          (hist && !hist.hidden ? '/hist=' + hist.clientHeight : '') +
          (bar && !bar.hidden ? '/bar=' + bar.clientHeight : '') +
          (images && !images.hidden ? '/图=' + images.querySelectorAll('.dsh-attach').length : '') +
          (picker && !picker.hidden ? '/选择器=' + picker.clientHeight + '(' + picker.querySelectorAll('.dsh-pick-item').length + '项)' : '') +
          (overflow > 1 ? ' OVERFLOW+' + overflow : ''),
      );
    }
    return out.join('   ');
  }
  setInterval(() => {
    const s = window.__dshStats;
    const hooks = window.__dshHookCalls;
    const sent = window.__dshSent || [];
    stats.textContent =
      'getEvents=' + s.getEvents + '  getState=' + s.getState + '  other=' + s.other +
      '  show调用=' + hooks.show + '  hide调用=' + hooks.hide +
      '  未找到元素=' + window.__dshMissing + '  错误=' + window.__dshErrors.length +
      '  历史列表=' + (window.__dshHistoryAsked ? '已请求' : '未请求') +
      '  已发送=' + sent.map((item) => item.images + '图/' + item.bytes + 'B').join(',') +
      '  ' + measure() +
      '  查询=' + (location.search || '(无)');
  }, 300);
} catch (error) {
  const box = document.getElementById('errors');
  box.style.display = 'block';
  box.textContent += (error && error.stack ? error.stack : String(error)) + '\\n';
}
</script>
</body>
</html>
`;
}

/**
 * 预览用的图片样本：读一张**工程里真存在**的小图内联进来（预览 HTML 必须自包含，
 * 不能去 `file://` 拿图）。找不到就退化成一张 1×1 的 PNG，并打一行提示 —— 缩略图会是空白，
 * 但面板那条链路照样能跑（比整个预览打不开好）。
 */
function imageSample() {
    const candidates = [
        ['gold_boss.png', 'assets/resources/textures/common/gold_boss.png'],
        ['add.png', 'assets/resources/textures/common/add.png'],
        ['enimy1.png', 'assets/resources/textures/enimys/enimy1.png'],
    ];
    for (const [name, rel] of candidates) {
        const file = path.join(PROJECT_ROOT, rel);
        try {
            const bytes = fs.readFileSync(file);
            console.log(`图片样本：${rel}（${Math.round(bytes.length / 1024)}KB）`);
            return { name, mimeType: 'image/png', data: bytes.toString('base64') };
        } catch {
            /* 试下一张 */
        }
    }
    console.warn('没找到可用的工程图片，预览里的缩略图会是空白（1×1 PNG 占位）');
    return {
        name: 'placeholder.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    };
}

function main() {
    const template = read(path.join('static', 'template', 'default', 'index.html'));
    const tokensCss = read(path.join('static', 'style', 'default', 'dsw-tokens.css'));
    const componentCss = read(path.join('static', 'style', 'default', 'index.css'));
    const panelJs = read(path.join('dist', 'panels', 'default', 'index.js'));
    const markdownJs = read(path.join('dist', 'panels', 'default', 'markdown.js'));
    const toolCardJs = read(path.join('dist', 'panels', 'default', 'tool-card.js'));
    const constantsJs = read(path.join('dist', 'constants.js'));
    // 面板会 `require('../../images')`（图片的 MIME 白名单/上限/筛选都从那儿来）—— 必须一起喂进去
    const imagesJs = read(path.join('dist', 'images.js'));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
        OUT_FILE,
        buildHtml({
            template,
            tokensCss,
            componentCss,
            panelJs,
            markdownJs,
            toolCardJs,
            constantsJs,
            imagesJs,
            entries: sampleEntries(),
            imageSample: imageSample(),
        }),
        'utf8',
    );
    console.log(`已生成 ${path.relative(process.cwd(), OUT_FILE)}（自包含，浏览器直接打开）`);

    if (process.argv.includes('--serve')) {
        const port = Number(process.env.PORT || 7788);
        const server = http.createServer((request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(fs.readFileSync(OUT_FILE));
        });
        server.listen(port, '127.0.0.1', () => {
            console.log(`预览地址：http://127.0.0.1:${port}/  （Ctrl+C 结束）`);
        });
    }
}

main();
