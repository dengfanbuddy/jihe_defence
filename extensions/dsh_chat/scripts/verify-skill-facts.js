/**
 * SKILL 事实门禁 —— 「每条事实必须声明它怎么被验证」，且声明为 script: 的锚点必须真跑通过。
 *
 * 背景：这一层知识的病不是"没写下来"，而是**写错了没人发现**（实测一条错事实活了 3 小时，
 * 靠下一次会话撞见才纠正）。文件型知识没有编译期，所以给它补一道能跑的判据。
 *
 * 约定（写进 `.agents/skills/cocos-editor-ops/SKILL.md`）：
 *   <!-- fact: <id> | verify: script:<name> | <note> -->
 *   <!-- fact: <id> | verify: manual | <note 说明人怎么验> -->
 *
 * 判据：
 *   ① 每条 `## 坑 N` 标题下必须有且只有一条 fact 声明（新增坑不许裸奔）
 *   ② `verify: script:X` 的 X 必须在下面的实现表里（悬空声明 = 红）
 *   ③ 实现表里的每条 X 都必须被某条事实引用（死断言 = 红，防止判据悄悄失效）
 *   ④ `verify: manual` 必须带 note 且说清楚「人在哪里、看什么」（说不清 = 没声明）
 *   ⑤ 每个 script: 锚点必须真跑通过
 *   ⑥ 归档的 recipe 不得出现在 findRecipes 的索引里
 *
 * 用法：
 *   node extensions/dsh_chat/scripts/verify-skill-facts.js
 *   node extensions/dsh_chat/scripts/verify-skill-facts.js --json
 *
 * 退出码：0 = 全绿；1 = 有上面的任一条不成立。
 *
 * @module dsh_chat/verify-skill-facts
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const EXT_ROOT = path.resolve(SCRIPT_DIR, '..');            // extensions/dsh_chat
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..');       // 工程根

/** 事实正文**随插件发布**（`<扩展根>/skills/…`），不再是消费者工程里的那份。 */
const SKILL_FILE = path.join(EXT_ROOT, 'skills', 'cocos-editor-ops', 'SKILL.md');
const HOST_FILE = path.join(EXT_ROOT, 'source', 'dsh-host.ts');
/** 消费工程里**不该**出现同名 skill —— 同名是「整体覆盖」，会把插件这份整个吃掉。 */
const SHADOW_FILE = path.join(REPO_ROOT, '.agents', 'skills', 'cocos-editor-ops', 'SKILL.md');
const BRIDGE_FILE = path.join(EXT_ROOT, 'dsh-profile', 'plugin', 'dsh-cocos-bridge', 'index.js');
const SCENE_FILE = path.join(EXT_ROOT, 'source', 'scene.ts');
const ENGINE_FILE = path.join(EXT_ROOT, 'source', 'core', 'engine.ts');
const COCOS_TOOLS_FILE = path.join(EXT_ROOT, 'source', 'cocos-tools.ts');
const LOGS_FILE = path.join(EXT_ROOT, 'source', 'logs.ts');
const INPUT_FILE = path.join(EXT_ROOT, 'source', 'input.ts');
const PREVIEW_FILE = path.join(EXT_ROOT, 'source', 'preview.ts');

const FACT_RE = /^<!--\s*fact:\s*([^|]+?)\s*\|\s*verify:\s*([^|]+?)\s*(?:\|\s*(.*?)\s*)?-->\s*$/;
const PIT_RE = /^##\s*坑\s*(\d+)\s*[：:]/;

const read = (file) => {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
};

/**
 * 剥掉注释之后的源码 —— **"有没有某次调用"这类断言必须看剥过的文本**。
 *
 * 为什么：本项目的注释是**长篇中文说明**，"我们为什么不再调 `webContents.invalidate()`"
 * 这种句子会**逐字**包含被禁的那个调用，于是"0 处调用"的断言会被自己的说明文字判红。
 * 反过来（直接把说明写得不能出现那个词）又会把最该说清的那句话逼走。
 * 所以：**丑话留给断言，把注释剥掉再说**。
 *
 * 只处理 `//` 与 `/* *\/` 两种；字符串字面量里的 `//`（如 URL）不还原成文本也无所谓 ——
 * 这个函数的用途是"找调用点"，不是当解析器用。
 */
const stripComments = (text) => (text == null ? null : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));

/** 源码里必须有某段字符串 —— "插件行为"类事实的锚点 */
const mustContain = (file, needle, why) => ({
    desc: path.relative(REPO_ROOT, file) + ' 里仍有 ' + JSON.stringify(needle),
    run() {
        const text = read(file);
        if (text == null) return { ok: false, detail: '读不到 ' + path.relative(REPO_ROOT, file) };
        const hit = text.includes(needle);
        return {
            ok: hit,
            detail: hit
                ? path.relative(REPO_ROOT, file) + ' 里仍有 ' + JSON.stringify(needle)
                : path.relative(REPO_ROOT, file) + ' 里**已经找不到** ' + JSON.stringify(needle) + ' —— ' + why,
        };
    },
});

/** 源码里必须有**全部**这些字符串 —— 多锚点「插件行为」类事实的锚点 */
const mustContainAll = (file, needles, why) => ({
    desc: path.relative(REPO_ROOT, file) + ' 里仍有 ' + needles.map((n) => JSON.stringify(n)).join(' + '),
    run() {
        const text = read(file);
        if (text == null) return { ok: false, detail: '读不到 ' + path.relative(REPO_ROOT, file) };
        const missing = needles.filter((n) => !text.includes(n));
        return {
            ok: missing.length === 0,
            detail: missing.length === 0
                ? path.relative(REPO_ROOT, file) + ' 里 ' + needles.length + ' 个锚点都在'
                : path.relative(REPO_ROOT, file) + ' 里**已经找不到** ' + missing.map((n) => JSON.stringify(n)).join('、')
                    + ' —— ' + why,
        };
    },
});

/** 复刻 listRecipeRecords 的扫描口径：非递归、只收 recipes/ 本层的 *.js */
const listIndexedRecipes = () => {
    const dir = path.join(REPO_ROOT, '.dsh-mcp', 'recipes');
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return { dir, files: [] }; }
    const files = [];
    for (const entry of entries.sort()) {
        if (!entry.toLowerCase().endsWith('.js')) continue;
        const file = path.join(dir, entry);
        try { if (fs.statSync(file).isFile()) files.push(file); } catch { /* 忽略 */ }
    }
    return { dir, files };
};

const IMPLS = {
    'tool-count-is-8': {
        desc: 'bridge 里 ctx.tools.register 正好 8 次（工具面表格的前提）',
        run() {
            const text = read(BRIDGE_FILE);
            if (text == null) return { ok: false, detail: '读不到 bridge 插件' };
            const n = (text.match(/ctx\.tools\.register\s*\(/g) || []).length;
            return {
                ok: n === 8,
                detail: '实测注册 ' + n + ' 个工具' + (n === 8 ? '' : '（不是 8 → 「工具面」那张表已失真）'),
            };
        },
    },
    /**
     * 「点与跑」那一节的锚点：三件套**四处都要在**，缺一处那节说法就站不住 ——
     * 插件要注册三个工具名、要真发对应的帧、编辑器侧要有分发表条目、
     * 两个实现文件要有各自的"这条通道靠什么成立"的关键字。
     */
    'interaction-tools-wired': {
        desc: 'cocos_click_node / cocos_send_keys / cocos_runtime 三处都在（注册 + 帧 + 分发表 + 实现文件），且 runtime 只剩只读 `state`',
        run() {
            const bridgeText = read(BRIDGE_FILE);
            const toolsText = read(COCOS_TOOLS_FILE);
            const inputText = read(INPUT_FILE);
            const previewText = read(PREVIEW_FILE);
            if (bridgeText == null || toolsText == null || inputText == null || previewText == null) {
                return { ok: false, detail: '读不到 bridge / cocos-tools / input / preview 源码' };
            }
            const missing = [];
            for (const name of ['cocos_click_node', 'cocos_send_keys', 'cocos_runtime']) {
                if (!bridgeText.includes(`name: '${name}'`)) missing.push(`bridge 里没有 ${name} 的注册`);
            }
            for (const frame of ["'click_node'", "'send_keys'", "'runtime'"]) {
                if (!bridgeText.includes(frame)) missing.push(`bridge 里没有发 ${frame} 帧`);
            }
            for (const entry of ['click_node: withRefs', 'send_keys: withRefs', 'runtime: withRefs']) {
                if (!toolsText.includes(entry)) missing.push(`cocos-tools 分发表里没有 ${entry}`);
            }
            if (!inputText.includes('sendInputEvent')) missing.push('input.ts 里没有 sendInputEvent（那就不是真事件了）');
            if (!inputText.includes('MAX_TEXT_CHARS')) missing.push('input.ts 里没有 text 长度上限');
            /**
             * ⚠ 2026-10-08 之后 `preview.ts` **不再开关预览**（那两条消息连同直调一起撤了）。
             * 现在这里钉的是**相反的两件事**：只读探针还在（`query-scene-mode`），
             * 而"开关预览"的那两条消息**一个字都不许留**（留了就是后门）。
             */
            if (!previewText.includes('query-scene-mode')) missing.push('preview.ts 里没有只读的 query-scene-mode 探针');
            if (previewText.includes('editor-preview-set-play')) missing.push('preview.ts 里又出现了 editor-preview-set-play（开关预览的后门）');
            if (previewText.includes('editor-preview-call-method')) missing.push('preview.ts 里又出现了 editor-preview-call-method（pause/step 的后门）');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '注册 / 帧 / 分发表 / 两个实现文件都在，且 runtime 只剩只读那一格' : missing.join('；'),
            };
        },
    },
    /**
     * `view`（编辑器场景 vs 跑着的游戏）那条口径的锚点：**两侧都要在** ——
     * 场景脚本要真的读模式（`readSceneMode`），主进程要真的把它报出来（`mode` 里带 requested/actual）。
     *
     * ⚠ 2026-11 真机验收之后加了两条更硬的：判据必须是 **`PreviewPlay._state`**（`previewState`），
     * 因为实测预览跑着的时候 facade 那两条**仍然是 `general`** —— 只钉"读了 cce 单例"是不够的，
     * 那正是"断言看着绿、真机上判不出来"的状态。
     */
    'capture-view-mode': {
        desc: 'capture_view 的 view 参数有来源也有出口（scene.ts 读 _state + engine.ts 报 mode + bridge 有 view 参数）',
        run() {
            const sceneText = read(SCENE_FILE);
            const engineText = read(ENGINE_FILE);
            const bridgeText = read(BRIDGE_FILE);
            if (sceneText == null || engineText == null || bridgeText == null) {
                return { ok: false, detail: '读不到 scene / engine / bridge 源码' };
            }
            const missing = [];
            if (!sceneText.includes('function readSceneMode')) missing.push('scene.ts 里没有 readSceneMode（模式就没来源了）');
            if (!sceneText.includes('previewState')) missing.push('scene.ts 没读 PreviewPlay._state（真机上只有它判得出运行态）');
            if (!sceneText.includes("previewState === 'play'")) missing.push('scene.ts 没拿 previewState 判 running（那就又退回 facade 了）');
            if (!sceneText.includes("out.paused = previewState === 'pause'")) missing.push('scene.ts 没报 paused（冻住没有就说不清）');
            if (!sceneText.includes('cce.SceneFacadeManager')) missing.push('scene.ts 没读 SceneFacadeManager（预制件/动画模式就没来源了）');
            if (!sceneText.includes('totalFrames')) missing.push('scene.ts 没报帧计数（"真的冻住了"没有判据）');
            if (!engineText.includes('normalizeViewTarget')) missing.push('engine.ts 里没有 view 参数解析');
            if (!engineText.includes('requested: options.view')) missing.push('engine.ts 回执里没有 mode.requested（说不清"要的"是哪种）');
            if (!engineText.includes('paused: typeof runtime.paused')) missing.push('engine.ts 回执里没有 mode.paused');
            if (!bridgeText.includes("enum: ['auto', 'scene', 'game']")) missing.push('bridge 里 capture_view 没有 view 参数');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '判据（_state）+ 来源 + 回执出口 + 工具参数都在' : missing.join('；'),
            };
        },
    },
    /**
     * 「合成输入进不了引擎」这条边界的锚点 —— 2026-11 真机验收最大的收获。
     *
     * 三处都得在，缺一处那节说法就站不住：
     * ① 插件的 `cocos_click_node` 描述里要**明说这条路在编辑器里点不动引擎**（不能留着"像真人点一样"的旧话）；
     * ② `cocos_send_keys` 描述里要有同源的边界（含"打字进 DOM 输入框仍然有效"这个区别）；
     * ③ 场景脚本仍以 `_state` 作运行态判据（那条拒绝到底会不会触发，全看它）。
     */
    'editor-input-not-dom': {
        desc: '桥接里点/按键的描述都写着「引擎在编辑器构建里不注册 DOM 监听」，且运行态判据仍是 _state',
        run() {
            const bridgeText = read(BRIDGE_FILE);
            const sceneText = read(SCENE_FILE);
            if (bridgeText == null || sceneText == null) return { ok: false, detail: '读不到 bridge / scene 源码' };
            const missing = [];
            if (!bridgeText.includes('不注册 DOM 监听')) missing.push('bridge 里没有「引擎在编辑器构建里不注册 DOM 监听」这条边界');
            if (!bridgeText.includes('manually event dispatching')) missing.push('bridge 里没引引擎源码那句注释（说服力全靠它）');
            if (!bridgeText.includes('_dispatchMouse')) missing.push('bridge 里没写换路方向（cc.input._dispatchMouse*）');
            if (!bridgeText.includes('引擎收不到')) missing.push('bridge 里没明说"合成事件引擎收不到"（"像真人点一样"的旧话就会重新长回来）');
            if (!sceneText.includes('previewState')) missing.push('scene.ts 的运行态判据不再是 _state（那条拒绝又会永远不触发）');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '三条边界 + 运行态判据都在' : missing.join('；'),
            };
        },
    },
    /**
     * 坑 15（`open-scene` 给 `db://` 会开出新空场景）的锚点：
     * 这条只能靠"提示位里写着"来保证 —— 模型不会主动去读 skill 才发现这件事。
     */
    'open-scene-uuid': {
        desc: 'editor_state 的「下一步」提示里写着 open-scene 要用资源 uuid（别给 db:// 路径）',
        run() {
            const toolsText = read(COCOS_TOOLS_FILE);
            if (toolsText == null) return { ok: false, detail: '读不到 cocos-tools.ts' };
            const hasLine = toolsText.includes('要开别的场景：open-scene 给**资源 uuid**');
            const hasWhy = toolsText.includes('会开出**一个新的空场景**');
            return {
                ok: hasLine && hasWhy,
                detail: hasLine && hasWhy
                    ? '提示位里写了「用资源 uuid」+ 后果'
                    : (hasLine ? '' : 'cocos-tools.ts 的下一步提示里没有 open-scene 用 uuid 那条；')
                        + (hasWhy ? '' : '没有写"给 db:// 会开出新的空场景"这个后果'),
            };
        },
    },
    'prune-reports-hidden': mustContain(SCENE_FILE, 'editorChildrenHidden',
        '坑 1 说「剪枝时不静默，会回 editorChildrenHidden」就站不住了'),
    'nodebypath-greedy': mustContain(SCENE_FILE, 'resolvePathBySegments',
        '坑 2 说「nodeByPath 用贪心按段匹配兜住含 / 的节点名」就站不住了'),
    'capture-reports-viewstate': {
        desc: '坑 5 的判据还在（回执带 view.visibleMatchesDesign），且**本扩展一处 `invalidate()` 都不调**（2026-10-08 口径）',
        run() {
            const sceneText = read(SCENE_FILE);
            const captureText = read(path.join(EXT_ROOT, 'source', 'capture.ts'));
            const engineText = read(ENGINE_FILE);
            if (sceneText == null || captureText == null || engineText == null) {
                return { ok: false, detail: '读不到 scene / capture / engine 源码' };
            }
            const missing = [];
            if (!sceneText.includes('visibleMatchesDesign')) missing.push('scene.ts 里没有 visibleMatchesDesign（"设备模拟被改过"就说不清）');
            /**
             * ⚠ 2026-10-08 口径**反过来了**：以前钉的是「重绘要了才排」，现在钉的是
             * **一次都没有** —— 因为"靠一个默认值把危险动作关掉"在**模块级 require 缓存**面前
             * 是不可验证的（那次会话里编辑器跑的就是旧构建，回执仍在恒报 `forcedRepaint:true`）。
             */
            if (stripComments(captureText).includes('forceRepaint')) missing.push('capture.ts 里又出现了 forceRepaint（"不碰合成器"这条硬口径被改回去了）');
            if (/\.invalidate\(/.test(stripComments(captureText))) missing.push('capture.ts 里出现了 invalidate() 调用点（空图那次也不行）');
            if (/\.invalidate\(/.test(stripComments(engineText))) missing.push('engine.ts 里出现了 invalidate() 调用点（取景后逼帧那次也不行）');
            if (engineText.includes('forcedRepaint')) missing.push('engine.ts 回执里又带上了 forcedRepaint');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '视图状态读数在，且 capture/engine 里 0 处 invalidate() 调用' : missing.join('；'),
            };
        },
    },
    /**
     * 坑 16（场景面板画面停住 / 黑掉）的锚点：SKILL 里那份**恢复配方**必须还在，
     * 而且它指的那份判定文档要真存在 —— 否则这条坑就变成"只说了症状，没说怎么办"。
     */
    'scene-frozen-recipe': {
        desc: '坑 16 的恢复配方（重启编辑器）+ 判定文档 `docs/冻结诊断.md` 都在，且三处源码里**一处 `invalidate()` 调用都没有**',
        run() {
            const skillText = read(SKILL_FILE);
            const captureText = read(path.join(EXT_ROOT, 'source', 'capture.ts'));
            const engineText = read(ENGINE_FILE);
            const sceneText = read(SCENE_FILE);
            if (skillText == null || captureText == null || engineText == null || sceneText == null) {
                return { ok: false, detail: '读不到 SKILL / capture / engine / scene 源码' };
            }
            const docFile = path.join(EXT_ROOT, 'docs', '冻结诊断.md');
            const missing = [];
            if (!skillText.includes('docs/冻结诊断.md')) missing.push('SKILL 的坑 16 里没有指向 docs/冻结诊断.md');
            if (!skillText.includes('重启编辑器')) missing.push('SKILL 的坑 16 里没写"只有重启编辑器能恢复"这条恢复配方');
            if (!skillText.includes('pit-16-scene-frozen')) missing.push('SKILL 里没有坑 16 的 fact 锚点行');
            if (read(docFile) == null) missing.push('docs/冻结诊断.md 不在了（坑 16 指的判定文档没了）');
            for (const [name, text] of [['capture.ts', captureText], ['engine.ts', engineText], ['scene.ts', sceneText]]) {
                if (/\.invalidate\(/.test(stripComments(text))) missing.push(name + ' 里出现了 invalidate() 调用点（"不碰合成器"落不了地）');
            }
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '恢复配方 + 判定文档 + 三处源码 0 处 invalidate() 调用' : missing.join('；'),
            };
        },
    },
    /**
     * 坑 17（运行预览开关已撤掉）的锚点：**四个入口都得堵上** ——
     * bridge 的 action 白名单、cocos-tools 的拒绝分支、package.json 的 scene methods、scene.ts 的直调。
     * 只堵一半（比如 UI 上去了、直调还在）等于留了个后门，所以这里逐个点名。
     */
    'preview-control-removed': {
        desc: '运行预览开关撤干净了：bridge enum 只剩 state、cocos-tools 拒绝五个动作、package.json 无 runtimeControl、scene.ts 不再直调 PreviewPlay 开关',
        run() {
            const bridgeText = read(path.join(EXT_ROOT, 'dsh-profile', 'plugin', 'dsh-cocos-bridge', 'index.js'));
            const toolsText = read(path.join(EXT_ROOT, 'source', 'cocos-tools.ts'));
            const sceneText = read(SCENE_FILE);
            const pkgText = read(path.join(EXT_ROOT, 'package.json'));
            if (bridgeText == null || toolsText == null || sceneText == null || pkgText == null) {
                return { ok: false, detail: '读不到 bridge / cocos-tools / scene / package.json' };
            }
            const missing = [];
            /** ① bridge：action 的 enum 只剩 state，且描述里必须写清"为什么撤" */
            if (!/enum:\s*\['state'\]/.test(bridgeText)) missing.push('bridge 的 cocos_runtime action enum 不是只剩 [state]');
            if (/enum:\s*\['state',\s*'play'/.test(bridgeText)) missing.push('bridge 里 play 又在 enum 里了');
            if (!bridgeText.includes('冻结诊断')) missing.push('bridge 的 runtime 描述里没说清"为什么撤"（没提冻结诊断）');
            /** ② cocos-tools：只认 state，其余一律拒绝 */
            if (!/action !== 'state'/.test(toolsText)) missing.push('cocos-tools 里没有"非 state 一律拒"的分支');
            if (!toolsText.includes('黑屏')) missing.push('cocos-tools 的拒绝文案里没说清黑屏这件事');
            /** ③ package.json：scene methods 里不许再有 runtimeControl */
            if (pkgText.includes('runtimeControl')) missing.push('package.json 的 scene methods 里还有 runtimeControl');
            /** ④ scene.ts：不许再直调 PreviewPlay 的开关方法（只读 `_state` 是允许的） */
            if (/PreviewPlay\s*\[/.test(sceneText) || /play\[method\]/.test(sceneText)) missing.push('scene.ts 里还在直调 PreviewPlay 的开关方法');
            if (/async runtimeControl\s*\(/.test(sceneText)) missing.push('scene.ts 里 runtimeControl 方法又出现了');
            if (!sceneText.includes('PreviewPlay')) missing.push('scene.ts 里连 PreviewPlay.\u005fstate 都不读了（运行态判据会瞎）');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '四个入口（bridge / cocos-tools / package.json / scene.ts）都堵上了，只读判据仍在' : missing.join('；'),
            };
        },
    },
    /**
     * 坑 5 续（取景）的锚点：两侧都得在 ——
     * 主进程要还在推那条链（`runFitChain`），场景侧要还在摆相机（`applyFitStep`）
     * 并且量的还是「真实内容」（`contentBounds`）。缺任何一处，SKILL 里那套说法就不成立。
     */
    'framing-chain': {
        desc: '取景链仍在（engine 的 runFitChain + scene 的 applyFitStep / contentBounds），framing 回执才有来源',
        run() {
            const engineText = read(ENGINE_FILE);
            const sceneText = read(SCENE_FILE);
            if (engineText == null || sceneText == null) return { ok: false, detail: '读不到 engine/scene 源码' };
            const missing = [];
            if (!engineText.includes('runFitChain')) missing.push('engine 里没有 runFitChain');
            if (!engineText.includes('fitIgnored')) missing.push('engine 里没有「兜底通道不取景」的说明（fitIgnored）');
            if (!sceneText.includes('applyFitStep')) missing.push('scene 里没有 applyFitStep');
            if (!sceneText.includes('contentBounds')) missing.push('scene 里没有 contentBounds');
            if (!sceneText.includes('restoreCameraState')) missing.push('scene 里没有 restoreCameraState（还原视角）');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '取景三级 + 覆盖判据 + 还原都在' : missing.join('；'),
            };
        },
    },
    'context-inference': mustContain(ENGINE_FILE, 'contextInferred',
        '坑 6 说「漏给 context 会被推断并在回执里注明」就站不住了'),
    /**
     * 坑 12 的锚点，**两侧都要在**：
     * ① 场景脚本里仍产出 `editor-overlay` 这个判词（"截图里那东西不是节点"靠它一次说清）；
     * ② `verify-cocos-engine.js` 里仍钉着那条回归（内容为空 + 编辑器装饰非空）。
     * 只有 ① 的话，判词还在但没人验它是否真的会出 —— 那正是坑 12 想消灭的状态。
     */
    'pick-editor-overlay': {
        desc: 'pick 仍在产出 editor-overlay 判词，且它的回归断言仍在 verify-cocos-engine.js 里',
        run() {
            const sceneText = read(SCENE_FILE);
            const verifyText = read(path.join(SCRIPT_DIR, 'verify-cocos-engine.js'));
            if (sceneText == null || verifyText == null) return { ok: false, detail: '读不到 scene.ts / verify-cocos-engine.js' };
            const missing = [];
            if (!sceneText.includes("'editor-overlay'")) missing.push('scene.ts 里没有 editor-overlay 判词');
            if (!sceneText.includes('helpers.pick =')) missing.push('scene.ts 里没有 helpers.pick');
            if (!sceneText.includes('不在场景数据里')) missing.push('scene.ts 没有「它不在场景数据里」这条说明');
            if (!verifyText.includes('verdict === \'editor-overlay\'')) missing.push('verify-cocos-engine.js 里没有 editor-overlay 的回归断言');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? 'pick + editor-overlay 判词 + 回归断言都在' : missing.join('；'),
            };
        },
    },
    /**
     * 坑 13 的锚点：那条公式与它的回归都要在。
     * 回归钉的是**历史上真实发生过的那个 bug**（原始框裁掉第 2 行 / 加高后放得下），
     * 所以它一旦被删掉，坑 13 就退化成"我写着玩的公式"。
     */
    'label-fit-formula': {
        desc: 'labelFit 的实测公式仍在，且「原始框裁第 2 行 → 加高后放得下」这条回归仍在',
        run() {
            const sceneText = read(SCENE_FILE);
            const verifyText = read(path.join(SCRIPT_DIR, 'verify-cocos-engine.js'));
            if (sceneText == null || verifyText == null) return { ok: false, detail: '读不到 scene.ts / verify-cocos-engine.js' };
            const missing = [];
            if (!sceneText.includes('LABEL_LAST_LINE_FACTOR')) missing.push('scene.ts 里没有 LABEL_LAST_LINE_FACTOR（1.26 那个系数）');
            if (!sceneText.includes('helpers.labelFit =')) missing.push('scene.ts 里没有 helpers.labelFit');
            if (!sceneText.includes('clippedText')) missing.push('scene.ts 不回 clippedText（"看不见的那几个字"就交不出来）');
            if (!verifyText.includes('maxLinesFit === 1')) missing.push('verify-cocos-engine.js 里没有「原始框只放得下 1 行」的回归');
            if (!verifyText.includes('maxLinesFit === 2')) missing.push('verify-cocos-engine.js 里没有「加高后放得下 2 行」的回归');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '公式 + labelFit + 两条回归断言都在' : missing.join('；'),
            };
        },
    },
    'loadframe-rejects-internal': mustContain(SCENE_FILE, 'db://internal',
        '坑 8 与「内置资源」那节的前提（loadFrame 只认 db://assets，内置图走 loadAny）就站不住了'),
    /**
     * 「日志」那一节的锚点：四处在，缺一处那张说法就站不住 ——
     * 插件要注册工具名、要真的发 `read_logs` 帧、编辑器侧要有分发表条目、实现文件要有候选目录表。
     */
    'logs-tool-wired': {
        desc: 'cocos_logs 四处都在（bridge 注册 + read_logs 帧 + 分发表 + logs.ts 候选目录）',
        run() {
            const bridgeText = read(BRIDGE_FILE);
            const toolsText = read(COCOS_TOOLS_FILE);
            const logsText = read(LOGS_FILE);
            if (bridgeText == null || toolsText == null || logsText == null) {
                return { ok: false, detail: '读不到 bridge / cocos-tools / logs 源码' };
            }
            const missing = [];
            if (!bridgeText.includes("name: 'cocos_logs'")) missing.push('bridge 里没有 cocos_logs 的注册');
            if (!bridgeText.includes("'read_logs'")) missing.push('bridge 里没有发 read_logs 帧');
            if (!toolsText.includes('read_logs: withRefs(readLogs)')) missing.push('cocos-tools 分发表里没有 read_logs');
            if (!logsText.includes('LOG_DIR_CANDIDATES')) missing.push('logs.ts 里没有通用候选目录表');
            if (!logsText.includes('CLEAR_CONFIRM')) missing.push('logs.ts 里没有 clear 的确认口令');
            return {
                ok: missing.length === 0,
                detail: missing.length === 0 ? '注册 / 帧 / 分发表 / 候选目录 / 确认口令都在' : missing.join('；'),
            };
        },
    },
    'archive-not-indexed': {
        desc: '归档目录（.dsh-mcp/archive/）里的文件不得进入 findRecipes 索引',
        run() {
            const { files } = listIndexedRecipes();
            const leaked = files.filter((f) => path.dirname(f) !== path.join(REPO_ROOT, '.dsh-mcp', 'recipes'));
            const archiveHit = files.filter((f) => f.split(path.sep).includes('archive'));
            if (leaked.length || archiveHit.length) {
                return { ok: false, detail: '索引里混进了非本层/归档文件：' + leaked.concat(archiveHit).join(', ') };
            }
            const archived = (() => {
                try { return fs.readdirSync(path.join(REPO_ROOT, '.dsh-mcp', 'archive')).filter((f) => f.endsWith('.js')); }
                catch { return []; }
            })();
            return {
                ok: true,
                detail: '索引 ' + files.length + ' 条（' + files.map((f) => path.basename(f)).join(', ') + '）'
                    + '；archive/ 里另有 ' + archived.length + ' 条已退出索引',
            };
        },
    },
    'bundled-skill-wired': {
        desc: 'dsh-host.ts 把 <扩展根>/skills 注入 DSH_BUNDLED_SKILL_DIR（知识才能跟着插件走）',
        run() {
            const text = read(HOST_FILE);
            if (text == null) return { ok: false, detail: '读不到 source/dsh-host.ts' };
            const hasEnv = text.includes('DSH_BUNDLED_SKILL_DIR');
            const hasFn = text.includes('bundledSkillDir');
            const hasSkill = fs.existsSync(path.join(EXT_ROOT, 'skills', 'cocos-editor-ops', 'SKILL.md'));
            return {
                ok: hasEnv && hasFn && hasSkill,
                detail: (hasEnv ? '' : 'dsh-host.ts 里没有 DSH_BUNDLED_SKILL_DIR；')
                    + (hasFn ? '' : '没有 bundledSkillDir()；')
                    + (hasSkill ? 'skills/cocos-editor-ops/SKILL.md 在位' : 'skills/cocos-editor-ops/SKILL.md 不存在'),
            };
        },
    },
    'no-shadowing-skill': {
        desc: '消费工程里没有同名的 cocos-editor-ops（同名是整体覆盖，会把插件这份吃掉）',
        run() {
            if (!fs.existsSync(SHADOW_FILE)) {
                return { ok: true, detail: path.relative(REPO_ROOT, SHADOW_FILE) + ' 不存在（正确）' };
            }
            return {
                ok: false,
                detail: '存在 ' + path.relative(REPO_ROOT, SHADOW_FILE)
                    + ' —— 它的 rank 是 200、插件 bundled 是 600，按名字去重时**低 rank 赢**，'
                    + '插件这份的坑会**全部失效**（不是合并）。项目专有约定请另起一个名字。',
            };
        },
    },
};

/** 解析 SKILL.md 里的事实声明，并检查 §判据 ①②③④ */
function parseFacts() {
    const text = read(SKILL_FILE);
    if (text == null) return { error: '读不到 ' + SKILL_FILE };

    const lines = text.split(/\r?\n/);
    const facts = [];
    const pits = [];               // { n, line, facts: [] }
    let current = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const pit = PIT_RE.exec(line);
        if (pit) {
            current = { n: Number(pit[1]), line: i + 1, facts: [] };
            pits.push(current);
            continue;
        }
        if (/^##\s/.test(line)) current = null;   // 出了这个坑

        const m = FACT_RE.exec(line);
        if (!m) continue;
        const fact = { id: m[1], verify: m[2], note: (m[3] || '').trim(), line: i + 1, pit: current };
        facts.push(fact);
        if (current) current.facts.push(fact);
    }
    return { facts, pits };
}

function main() {
    const json = process.argv.includes('--json');
    const parsed = parseFacts();
    if (parsed.error) {
        console.error(parsed.error);
        process.exit(1);
    }

    const { facts, pits } = parsed;
    const problems = [];
    const rows = [];

    // ① 每条坑都要有声明
    for (const pit of pits) {
        if (pit.facts.length === 0) problems.push('坑 ' + pit.n + '（SKILL.md:' + pit.line + '）没有任何 <!-- fact: --> 声明');
        if (pit.facts.length > 1) problems.push('坑 ' + pit.n + '（SKILL.md:' + pit.line + '）有 ' + pit.facts.length + ' 条声明，只允许 1 条');
    }

    // ② 悬空声明 / ④ manual 必须说清怎么验 / ⑤ 真跑
    const used = new Set();
    for (const fact of facts) {
        const m = /^script:(.+)$/.exec(fact.verify);
        if (m) {
            const name = m[1].trim();
            used.add(name);
            const impl = IMPLS[name];
            if (!impl) {
                problems.push(fact.id + ' 声明了不存在的锚点 script:' + name);
                rows.push({ fact: fact.id, verify: fact.verify, ok: false, detail: '锚点未实现' });
                continue;
            }
            let result;
            try { result = impl.run(); } catch (error) { result = { ok: false, detail: '抛错：' + error.message }; }
            if (!result.ok) problems.push(fact.id + ' 的锚点未通过 —— ' + result.detail);
            rows.push({ fact: fact.id, verify: fact.verify, ok: result.ok, detail: result.detail });
        } else if (fact.verify === 'manual') {
            if (!fact.note) problems.push(fact.id + ' 标了 manual 却没写「人在哪看什么」—— 等于没声明');
            rows.push({ fact: fact.id, verify: 'manual', ok: true, detail: fact.note || '(缺 note)' });
        } else {
            problems.push(fact.id + ' 的 verify 既不是 script:<name> 也不是 manual：' + fact.verify);
            rows.push({ fact: fact.id, verify: fact.verify, ok: false, detail: '无法识别的 verify 形式' });
        }
    }

    // ③ 死断言
    for (const name of Object.keys(IMPLS)) {
        if (!used.has(name)) problems.push('实现表里的 ' + name + ' 没有任何事实引用（死断言：它挂掉也没人知道）');
    }

    if (json) {
        console.log(JSON.stringify({ ok: problems.length === 0, facts: rows, problems }, null, 2));
    } else {
        const auto = rows.filter((r) => r.verify.startsWith('script:'));
        const manual = rows.filter((r) => r.verify === 'manual');
        console.log('SKILL 事实门禁 —— ' + path.relative(REPO_ROOT, SKILL_FILE));
        console.log('');
        for (const r of rows) {
            console.log('  ' + (r.ok ? ' ok ' : 'FAIL') + '  ' + r.fact.padEnd(30) + ' ' + r.verify);
            if (!r.ok) console.log('        └ ' + r.detail);
        }
        console.log('');
        console.log('事实 ' + rows.length + ' 条：可执行锚点 ' + auto.length + ' 条 / 显式 manual ' + manual.length + ' 条');
        console.log('（manual = 承认它只能人验；这个数字应该降，但不该假装是 0）');
        if (problems.length) {
            console.log('');
            console.log('不通过：');
            for (const p of problems) console.log('  ✗ ' + p);
        }
    }

    process.exit(problems.length ? 1 : 0);
}

main();
