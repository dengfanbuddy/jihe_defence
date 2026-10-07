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
 * 开关（都挂在 URL 上，见文件里各处 `__query.get(...)`）：
 * `?theme=light|dark` `?palette=dsw|editor` `?font=12..17` `?idle=1` `?view=history|resumed` `?ask=question|approval|plan`
 * `?click=<选择器>[,<选择器>…]` `?hsearch=<词>` `?hits=0` `?partial=0` `?exportfail=1` `?deletefail=1`
 * `?scroll=<选择器>`（把那个**滚动容器**滚到底：抽屉是 `#usage` / `#progress`）
 * `?title=0`（看不带会话标题的样子）`?click=<选择器>`（自动点一下）
 * `?type=<文本>`（**输入触发器**：塞进输入框并触发 input —— `/compact` 看命令表，`@rel` 看路径候选）
 * `?nocommands=1` `?norefs=1`（两个服务不可用时的降级）。
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

/**
 * 上下文增长曲线那几句「为什么不画」的**原文**（版本不认识 / 还没有请求记录）。
 *
 * 为什么要 require 真产物、而不是在样本里手写一份：预览是拿来看「面板原样画出来是什么样」
 * 的，而手写的样本话术**一定会与真读取器漂移** —— 漂移之后预览看起来一切正常
 * （它只是显示了一句真面板永远不会说的话）。require 的是 `npm run build` 的产物，
 * 所以两边永远是同一份；读不到就退化成一句明确写着「占位」的文本（不假装是真的）。
 */
function timelineNoteSamples() {
    try {
        return require(path.join(EXTENSION_ROOT, 'dist', 'constants.js'));
    } catch (error) {
        console.warn(`读不到 dist/constants.js（${error.message}）：预览里那两句样本说明用占位文本（先跑 npm run build）`);
        return null;
    }
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
    /**
     * 两句样本说明**从真产物里取**（见 `timelineNoteSamples`）：`oldver` / `empty` 两个
     * 开关要展示的正是真读取器会说的那两句，手写一份必然漂移。
     */
    const noteSamples = timelineNoteSamples();
    const versionNote = noteSamples
        ? noteSamples.contextTimelineVersionNote(12)
        : '（预览读不到 dist/constants.js，这一句是占位：版本不认识）';
    const emptyNote = noteSamples
        ? noteSamples.contextTimelineEmptyNote()
        : '（预览读不到 dist/constants.js，这一句是占位：还没有请求记录）';
    return `
const __entries = ${JSON.stringify(entries)};
const __query = new URLSearchParams(location.search);
window.__dshErrors = [];
// 调用计数：预览器用它断言「面板自己在轮询」——不传 show 钩子时计数也必须涨
window.__dshStats = { getState: 0, getEvents: 0, other: 0 };

/* ---- 交互样本（?ask=question|approval|plan）----
 * 这三个形状**逐字对应 DSH 的契约**（AskUserQuestionItem / ApprovalRequestEvent），
 * 面板只按字段画、不做语义判断 —— 所以这里造假也要照抄字段名，否则验的不是真形状。 */
function __fakeInteraction(kind) {
    if (kind === 'approval') {
        return [{
            id: 'ask-1-1', kind: 'approval', at: Date.now(), agentId: 'agent-preview',
            toolName: 'pwsh', reason: '这条命令要写到工作区之外的目录，需要你批准一次。',
        }];
    }
    if (kind === 'plan') {
        return [{
            id: 'ask-1-1', kind: 'question', at: Date.now(), agentId: 'agent-preview', sessionId: 'a1b2c3d4e5f60718',
            questions: [{
                id: 'plan-review',
                header: 'Plan review',
                question: '批准这份计划吗？',
                detail: '# 见面板加一个交互块\\n\\n1. 主进程接住插件的 ask 帧\\n2. 面板画成卡片\\n3. 回答经控制帧回给插件\\n\\n> 「allowed-once」是唯一的授予。',
                options: [{ label: '批准并开始', description: '按这份计划动手' }, { label: '继续规划', description: '我还没想好' }],
                intent: { kind: 'plan-review', approve: '批准并开始' },
            }],
        }];
    }
    if (kind === 'question') {
        return [{
            id: 'ask-1-1', kind: 'question', at: Date.now(), agentId: 'agent-preview',
            questions: [
                { id: 'q1', header: '范围', question: '这次要改哪些表？', options: [{ label: '只改 relics.json' }, { label: '连 modifiers.json 一起' }], multiSelect: true },
                { id: 'q2', question: '有没有别的约束？' },
            ],
        }];
    }
    return [];
}
const __interactions = __fakeInteraction(__query.get('ask'));

/* ---- 上下文增长曲线样本（?timeline=ok|none|oldver|empty）----
 * 形状与**真读取器**（stats.ts 的 parseContextTimeline 产物）逐字一致，所以那一块在预览里
 * 是**真跑**的：回合带、柱高归一、✂ 钉在哪一根柱上，全走面板的真代码，只有数字是样本。
 * 数字按真数据的量级造（本机 470 份真缓存：requests 中位 37 次、prompt ÷ total 中位 1.34、
 * 一次 compaction 净释放 ~200k、几条 prune 在几十毫秒内连发）。
 * 开关：
 *   （默认）ok   42 次调用：一路涨到 ~298k → 第 24 根柱上被压缩掉一大截 → 又涨 → 第 33 根柱上连发 4 条 prune
 *   none         这一行**根本不存在**（新会话 / 别的 profile 跑的会话）—— 看那句「由第三方注册、本 profile 不挂它」
 *   oldver       ver 不认识（看那句「版本是 12，本读取器只认 13」）
 *   empty        这一行在、但还没有请求记录（还没发过消息）
 * 另外两根柱故意**没有实测 prompt**（provider 没报那两次的 usage）→ 看斜纹柱与那句「不许混进实测里」。
 */
const __timelineOldverNote = ${JSON.stringify(versionNote)};
const __timelineEmptyNote = ${JSON.stringify(emptyNote)};
function __fakeTimeline(mode) {
    if (mode === 'none') return { timeline: null, timelineNote: null };
    if (mode === 'oldver') return { timeline: null, timelineNote: __timelineOldverNote };
    if (mode === 'empty') return { timeline: null, timelineNote: __timelineEmptyNote };
    const maxWindow = 1000000;
    const total = 42;
    // 轮次边界（真数据里一轮几步到几十步都有，这里是 5 轮 42 步）
    const turnOf = function (index) {
        if (index <= 9) return 1;
        if (index <= 18) return 2;
        if (index <= 27) return 3;
        if (index <= 36) return 4;
        return 5;
    };
    // 柱高：涨 → 压缩掉一大截（第 24 根）→ 再涨 → 第 33 根上被几条 prune 削掉一点
    const tokensOf = function (index) {
        if (index <= 23) return 12000 + (index - 1) * 13000;
        return 95000 + (index - 24) * 9000;
    };
    const points = [];
    const stepsInTurn = {};
    let max = 0;
    let estimatedCount = 0;
    for (let index = 1; index <= total; index += 1) {
        const turn = turnOf(index);
        stepsInTurn[turn] = (stepsInTurn[turn] || 0) + 1;
        const value = tokensOf(index);
        // 第 12 / 33 根柱：provider 没报那两次的 usage → 只有估算的 total（真数据里 4 万条里 32 条如此）
        const estimated = index === 12 || index === 33;
        if (estimated) estimatedCount += 1;
        if (value > max) max = value;
        points.push({
            index: index,
            tokens: value,
            prompt: estimated ? null : value,
            total: estimated ? value : Math.round(value / 1.34),
            estimated: estimated,
            turn: turn,
            step: stepsInTurn[turn],
            seq: 1000 + index * 1500,
            steps: 1,
            cuts: index === 24
                ? [{ kind: 'compaction', tokens: 202931, count: 346, merged: 1, time: 1790987060357, seq: 35000 }]
                : index === 33
                  ? [{ kind: 'prune', tokens: 4560, count: null, merged: 4, time: 1790361489890, seq: 49000 }]
                  : [],
        });
    }
    return {
        timeline: {
            ver: 13,
            seq: 426224,
            points: points,
            requests: total,
            aggregated: false,
            dropped: 0,
            max: max,
            estimatedCount: estimatedCount,
            lastTokens: tokensOf(total),
            lastEstimated: false,
            contextWindow: maxWindow,
            archiveFloor: null,
            cutsTotal: 2,
        },
        timelineNote: null,
    };
}

/* ---- 用量样本（?usage=…）----
 * 形状与**真主进程**（source/stats.ts 归一化之后）逐字一致，所以抽屉里那七块在预览里是真跑的，
 * 只有数字是样本。数字抄的是本机真缓存里 session-50c4078c 那份（1M 窗口的 vision 模型）——
 * 用真量级才能看出「缩写有没有搞错、条画得对不对」。
 *
 * 开关：
 *   （默认）   正常一份
 *   ?usage=none    新会话 / 还没落过检查点（只有一句 note，没有一个数字）
 *   ?usage=compact 压缩过的记录（占用率是修正后的预估 + 那条「压缩过」的说明）
 *   ?usage=error   读失败（JSON 坏了 / 权限）
 *   ?usage=full    占用率 92%（看危险色）
 *   ?cost=1        带上花费那一行（检查点 + 账本，币种 ¥）：真 cocos profile 从 2026-12 起就有它了
 *   ?cost=ledger   检查点里**没有**那一行、只有账本里有（老会话：抽屉要说清来路并兜底）
 *   ?cost=noconfig 有金额，但读不到账本（没有显示币种/汇率 → 按美元原值画 + 那句原因）
 *   ?cost=disagree 两处金额对不上（> 1% 容差 → 必须说出「对不上」并解释为什么）
 *   ?timeline=ok|none|oldver|empty   上下文增长曲线那一块（见上面 __fakeTimeline 的开关清单）
 */
function __fakeUsage() {
    const mode = __query.get('usage') || 'ok';
    if (mode === 'none') {
        return { ok: false, usage: null, note: '这条会话还没有投影缓存记录（DSH 会在创建 / 每轮结束 / 关闭时写一次检查点）。' };
    }
    if (mode === 'error') {
        return { ok: false, usage: null, note: '读不了投影缓存：EACCES: permission denied（预览里造的错）' };
    }
    const full = mode === 'full';
    const compact = mode === 'compact';
    // 花费：默认**没有**（老会话那种），加 ?cost=… 才带上（四种状态见文件头那张表）。
    const costMode = __query.get('cost') || 'off';
    const window = 1000000;
    // full 是「快满了」那一档：样本压在 920k、当前 surface 不变 → 预估 92%（看危险色）
    const pressure = compact ? 273437 : full ? 920000 : 172328;
    const sampled = compact ? 180625 : full ? 130285 : pressure;
    const surface = compact ? 3864 : 130285;
    const projected = Math.max(0, pressure + surface - sampled);
    // 上下文增长曲线那一块（?timeline=ok|none|oldver|empty）—— 只算一次，别在对象里调两遍
    const timelineSample = __fakeTimeline(__query.get('timeline') || 'ok');
    return {
        ok: true,
        note: null,
        usage: {
            id: 'session-50c4078c-ae41-4d4f-b876-c2698ceafd00',
            version: 5,
            seq: 426224,
            behind: __query.get('behind') === '0' ? null : 412,
            updatedAt: Date.now() - 42000,
            identity: { cwd: 'D:\\\\Project\\\\cocos\\\\jihe_defence', seeded: false, inheritedEvents: 0 },
            model: 'deepseek-v4-flash-vision-exp',
            provider: 'deepseek-official',
            context: { window: window, projected: projected, pressure: pressure, ratio: projected / window, system: 1769, tools: 10763, messages: surface },
            usage: {
                totals: { input: 769619, output: 450703, cacheRead: 156776192, cacheWrite: 0 },
                last: { turn: 6, step: 45, buckets: { input: 168, output: 366, cacheRead: 172160, cacheWrite: 0 } },
            },
            // cost=ledger 是「检查点里没有这一行，只有账本里有」——正是老会话的样子
            cost:
                costMode === 'off' || costMode === 'ledger'
                    ? null
                    : { amount: 1.5802035320000016, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
            costDisplay:
                costMode === 'off' || costMode === 'noconfig'
                    ? null
                    : { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2, pricingCurrency: 'USD' },
            costLedger:
                costMode === 'off' || costMode === 'noconfig'
                    ? null
                    : {
                          // 账本那一份：差 0.0002 美元（< 1% 容差）→ 不该触发「对不上」那句话
                          sessionUsd: costMode === 'disagree' ? 9.9 : costMode === 'ledger' ? 1.5804 : 1.5802,
                          calls: 1225,
                          todayUsd: 14.9217,
                          todayKey: '2026-10-05',
                      },
            costNote:
                costMode === 'off'
                    ? null
                    : costMode === 'noconfig'
                      ? '读不到 cost-meter 的账本（那个插件还没跑过，或者它换了位置）。'
                      : null,
            /**
             * ⚠ 这两个字段以前**样本里没有**（costBundle / costMounted 是花费那一轮加的），
             * 于是预览里那一句会印成「花费那一行由 undefined 注册」—— 看着像面板的 bug，
             * 其实是样本不全（真主进程**永远**会给这两个字段：见 stats.ts 的 attachCostLedger）。
             * （这一整段在 editorShim 的模板字符串里，所以上面一个反引号都没写。）
             */
            costBundle: 'dsh-cost-meter',
            costMounted: costMode === 'off' ? null : true,
            session: { turns: 6, steps: 743, llmMs: 2671113, toolMs: 438231, ttftMs: 1070229, ttftSteps: 743, decodeMs: 1600884, decodeTokens: 450703 },
            // 上下文增长曲线（?timeline=… 见 __fakeTimeline 的开关清单）——
            // 它与上面那些字段同一个来路（同一次读盘），所以摆在同一个对象里
            timeline: timelineSample.timeline,
            timelineNote: timelineSample.timelineNote,
            notes: compact
                ? ['这份记录里上下文被压缩过（surface 180625 → 3864），所以占用率用的是「修正后的预估」，不是上一次请求的实测 —— 数字变小是正常的。']
                : [],
        },
    };
}

/* ---- 活动样本（?activity=…）----
 * 形状与**真宿主**（source/dsh-host.ts 的 normalizeActivity 产物 ActivityView）逐字一致，
 * 所以抽屉里那两块（后台任务 / 子 agent）在预览里是真跑的，只有文字是样本。
 *
 * 开关：
 *   （默认）           一份正常的：3 个后台任务（跑着 / 完成 / 状态不明）+ 2 个子 agent（一个运行中的可继续、一个只在磁盘上的一次性）
 *   ?activity=empty    两个服务都在，但都没有东西（抽屉里应是两句「现在没有…」）
 *   ?activity=missing  服务没挂（说清是哪个服务，而不是画空列表）
 *   ?activity=subonly  只有子 agent（验「块与块之间互不牵连」）
 */
function __fakeActivity() {
    const mode = __query.get('activity') || 'ok';
    if (mode === 'missing') {
        return {
            jobs: [],
            subagents: [],
            jobsAvailable: false,
            subagentsAvailable: false,
            jobsReason: '这个 profile 没挂 jobs 服务（它是 dsh-base 的行）—— 所以看不到后台任务。会话、工具、编辑器操作都不受影响。',
            subagentsReason: '这个 profile 没挂 subagents 服务（它是 dsh-base 的行）—— 所以看不到子 agent。会话、工具、编辑器操作都不受影响。',
            notes: [],
            at: Date.now() - 1500,
        };
    }
    if (mode === 'empty') {
        return {
            jobs: [],
            subagents: [],
            jobsAvailable: true,
            subagentsAvailable: true,
            jobsReason: null,
            subagentsReason: null,
            notes: [],
            at: Date.now() - 1500,
        };
    }
    const subOnly = mode === 'subonly';
    const jobs = subOnly
        ? []
        : [
              {
                  id: 'pwsh-7',
                  kind: 'pwsh',
                  label: 'npx tsc --noEmit -p tsconfig.json',
                  status: 'running',
                  detail: null,
                  startedAt: Date.now() - 42000,
                  finishedAt: null,
                  ownerSessionId: 'a1b2c3d4e5f60718',
                  depth: 0,
              },
              {
                  id: 'pwsh-6',
                  kind: 'pwsh',
                  label: 'node tools/excel_export/src/cli.ts json2excel --force --table relics',
                  status: 'completed',
                  detail: 'exit code: 0',
                  startedAt: Date.now() - 300000,
                  finishedAt: Date.now() - 240000,
                  ownerSessionId: 'a1b2c3d4e5f60718',
                  depth: 0,
              },
              {
                  // 子 agent 起的任务：面板上要标出「属于子 agent」那一句
                  id: 'subagent-2',
                  kind: 'subagent',
                  label: '查一遍 30 个肉鸽技能的落地形态并汇总',
                  status: 'unknown',
                  detail: null,
                  startedAt: Date.now() - 90000,
                  finishedAt: null,
                  ownerSessionId: 'e5f60718a1b2c3d4',
                  depth: 1,
              },
          ];
    return {
        jobs,
        subagents: [
            {
                id: 'e5f60718a1b2c3d4',
                kind: 'child',
                label: '查一遍 30 个肉鸽技能的落地形态并汇总',
                mode: 'continuable',
                depth: 1,
                hasChildren: true,
                activity: 'running',
                reason: null,
                status: 'running',
            },
            {
                id: 'b2c3d4e5f60718a1',
                kind: 'child',
                label: '',
                mode: 'one-shot',
                depth: 1,
                hasChildren: false,
                activity: 'inactive',
                reason: null,
                status: 'ready',
            },
        ],
        jobsAvailable: true,
        subagentsAvailable: true,
        jobsReason: null,
        subagentsReason: null,
        notes: ['后台任务只画了最近 40 条（一共 41 条）。'],
        at: Date.now() - 1500,
    };
}

/* ---- 进度样本（?progress=…）----
 * 形状与**真宿主**（source/dsh-host.ts 合并之后的 ProgressView）逐字一致，
 * 所以抽屉里那三块（清单 / 目标 / 回合目录）在预览里是真跑的，只有文字是样本。
 *
 * 开关（都可叠加）：
 *   （默认）          一份正常的：5 条清单（1 条在做）+ 目标 + 12 轮目录（前 9 轮点不动）
 *   ?progress=none    还没有读数（只有一句 note，三块都不画）
 *   ?progress=error   读失败
 *   ?progress=empty   读过，但清单是 null、没有目标、大纲也是空的（新会话）
 *   ?progress=stale   清单是**上一轮**写的（chip 上要出现「（上一轮）」，抽屉里要有那句警告）
 *   ?progress=checkpoint 清单来自检查点（不是实时事件）
 *   ?progress=done    全部完成（看「完成 5 / 共 5」与全灰的样子）
 *   ?progress=goal    只带目标（看阶段/轮次/卡住原因）
 */
function __fakeProgress() {
    const mode = __query.get('progress') || 'ok';
    if (mode === 'none') {
        return { ok: false, progress: null, progressNote: '这条会话还没有投影缓存记录（DSH 会在创建 / 每轮结束 / 关闭时写一次检查点）。' };
    }
    if (mode === 'error') {
        return { ok: false, progress: null, progressNote: '读不了投影缓存：EACCES: permission denied（预览里造的错）' };
    }
    const empty = mode === 'empty';
    const stale = mode === 'stale';
    const done = mode === 'done';
    const goalOnly = mode === 'goal';
    const todos = empty || goalOnly
        ? null
        : done
          ? [
                { content: '读一遍现成的面板与宿主代码', status: 'completed' },
                { content: '写 progressOf 的解析与三种「没有」', status: 'completed' },
                { content: '宿主实时接 todo/write / turn/start / goal/change', status: 'completed' },
                { content: '画进度抽屉与那颗 chip', status: 'completed' },
                { content: '跑 verify-stats / verify-panel 与预览目测', status: 'completed' },
            ]
          : [
                { content: '读一遍现成的面板与宿主代码', status: 'completed' },
                { content: '写 progressOf 的解析与三种「没有」', status: 'completed' },
                { content: '宿主实时接 todo/write / turn/start / goal/change', status: 'in_progress' },
                { content: '画进度抽屉与那颗 chip（清单 / 目标 / 回合目录三块）', status: 'pending' },
                { content: '跑 verify-stats / verify-panel 与预览目测', status: 'pending' },
            ];
    const turns = [];
    if (!empty) {
        // 12 轮：**前 9 轮点不动**（entrySeq 是 null —— 已经被 600 条上限挤掉了），
        // 后面几轮能点。这正是真环境里长会话的样子，也是「只有摘要」那句话的验收样本。
        //
        // 后三轮的锚点故意指向**样例转写里真有的条目号**（5 / 7 / 9），这样
        // ?click=#btn-progress,#progress .dsh-turn[data-jump="true"] 能真的跳一次 ——
        // 跳转成功与「那一轮被挤掉了」两条路都得能当场看见（后者见 jumpToTurn 的横幅）。
        const anchors = [5, 7, 9];
        const prompts = [
            '把用量面板做出来（token / 上下文占用）',
            '顺手把「压缩过」那条说明也说清楚',
            '会话列表能搜全文么？再加个导出',
            '面板里嵌 web 会不会影响操作 cocos',
            '不嵌 web 的话把缺的能力补回来',
            '先把授权/提问/计划评审三个对话框补上',
            '加个会话搜索、导出、删除',
            '现在这个会话有多长？加个用量面板',
            '压缩之后再读一次用量看看',
            '把待办清单做进面板（agent 写的那份）',
            '回合目录要能点着跳过去',
            '目标模式那一条也顺手显示出来',
        ];
        for (let index = 0; index < 12; index += 1) {
            const turn = index + 1;
            turns.push({
                turn,
                seq: turn * 412,
                prompt: prompts[index],
                response:
                    index < 9
                        ? '做完了，验证通过。'
                        : index === 11
                          ? ''
                          : '改好了，并且跑通了全量 verify（8 个脚本全绿）。',
                entrySeq: turn > 9 ? anchors[turn - 10] : null,
            });
        }
    }
    return {
        ok: true,
        progressNote: null,
        progress: {
            todos: todos,
            todosSource: mode === 'checkpoint' ? 'checkpoint' : 'events',
            todosTurn: stale ? 11 : todos === null ? null : 12,
            stale: stale,
            currentTurn: 12,
            goal: empty
                ? null
                : {
                      objective:
                          '把 dsh_chat 面板缺的能力按优先级补齐：先是三个对话框（授权 / 提问 / 计划评审），' +
                          '再是会话搜索与导出，然后是 token 用量，最后是待办清单与回合目录。profile 不变。',
                      phase: mode === 'goal' ? 'blocked' : 'active',
                      roundsStarted: mode === 'goal' ? 12 : 3,
                      maxGoalRounds: 12,
                      blockedReason: mode === 'goal' ? '连续三轮没有进展：等用户确认要不要做 jobs 面板（要动 bridge 插件多发一条控制帧）。' : null,
                      updatedAt: Date.now() - 125000,
                  },
            turns: turns,
            turnsTotal: empty ? 0 : 12,
            draft: empty ? '' : '正在写这一轮的回复：先把宿主那三个事件接上…',
            seq: 426224,
            behind: __query.get('behind') === '0' ? null : 412,
            updatedAt: Date.now() - 42000,
            notes:
                mode === 'checkpoint'
                    ? ['回合大纲一共 12 轮，面板上只列最近 80 轮（每条都带两段摘要，全发太重）。']
                    : [],
        },
    };
}

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
                        // ?ask=question|approval|plan 看交互块（见文件头的开关清单）
                        interactions: __interactions,
                        // 会话标题（session/title 事件折出来的那条）；?title=0 看不带标题的样子
                        title: __query.get('title') === '0' ? null : '把局内遗物效果重做成钩子体系',
                        // 用量（?usage=… 见 __fakeUsage 的开关清单）。摘要与抽屉共用同一份 ——
                        // 真主进程也是「快照里带一份、广播里带一份」，两处同一个来源
                        usage: __fakeUsage().usage,
                        usageNote: __fakeUsage().note,
                        // 进度（?progress=… 见 __fakeProgress 的开关清单）。同样是「快照一份、广播一份」
                        progress: __fakeProgress().progress,
                        progressNote: __fakeProgress().progressNote,
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
                        // ?theme=light|dark|auto  ?palette=dsw|editor  ?font=12..17 —— 预览器自己的开关
                        theme: __query.get('theme') || 'dark',
                        palette: __query.get('palette') === 'editor' ? 'editor' : 'dsw',
                        fontSize: Number(__query.get('font') || 0),
                    },
                    profile: { ok: true, profileDir: 'C:\\\\Users\\\\wx\\\\.dsh\\\\profiles\\\\cocos', version: '1', changes: [] },
                };
            }
            if (message === 'get-events') return { ok: true, entries: __entries, revision: 99, generation: 1 };
            // 交互作答：记一笔（自检条/控制台能看到真发出去了什么），并把那张卡片收掉
            // —— 真主进程也是这个行为（回答后插件回 settled，卡片才消失）
            if (message === 'interaction-answer') {
                window.__dshAnswers = (window.__dshAnswers || []).concat([payload]);
                const id = payload && payload.id;
                for (let i = __interactions.length - 1; i >= 0; i--) if (__interactions[i].id === id) __interactions.splice(i, 1);
                return { ok: true };
            }
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
            // 读数：用量与进度**是同一个方法**（真主进程一次读盘、两半一起回），
            // 所以两个抽屉的「刷新」在预览里也走这一条
            if (message === 'session-usage') {
                window.__dshUsageReads = (window.__dshUsageReads || 0) + 1;
                const usageReply = __fakeUsage();
                const progressReply = __fakeProgress();
                return {
                    ok: usageReply.ok,
                    usage: usageReply.usage,
                    note: usageReply.note,
                    progress: progressReply.progress,
                    progressNote: progressReply.progressNote,
                    // 真主进程在读失败时把同一个原因给两边（见 dsh-host 的 refreshUsage）
                    error: usageReply.ok ? undefined : usageReply.note,
                };
            }
            // 活动（后台任务 + 子 agent）：?activity=… 见 __fakeActivity 的开关清单。
            // 真主进程是**两条控制帧并发**打给插件、再合成一份给面板，这里回的就是合成后的形状。
            if (message === 'panel-activity') {
                window.__dshActivityReads = (window.__dshActivityReads || 0) + 1;
                return { ok: true, activity: __fakeActivity() };
            }
            if (message === 'subagent-interrupt') {
                window.__dshInterrupts = (window.__dshInterrupts || []).concat([payload]);
                return { ok: true, subagentId: payload && payload.subagentId };
            }
            // 全文搜索 / 导出 / 删除：回执形状与真主进程**逐字一致**（它只是把脚本的输出收敛一层），
            // 所以抽屉里这三条路的渲染在预览里是真跑的，只有数据是样本。
            // ?hits=0 搜不到；?partial=0 假装「整个工程都扫过了」；?slowsearch=1800 假装很慢（看「搜索中…」）
            if (message === 'history-search') {
                window.__dshHistorySearches = (window.__dshHistorySearches || []).concat([payload]);
                const query = String((payload && payload.query) || '');
                const noHits = __query.get('hits') === '0';
                const complete = __query.get('partial') === '0';
                return {
                    ok: true,
                    query: query,
                    scanned: complete ? 107 : 6,
                    available: 107,
                    partial: !complete,
                    stoppedBy: complete ? null : 'limit',
                    elapsedMs: complete ? 9012 : 1454,
                    scannedBytes: complete ? 166712630 : 10590617,
                    hits: noHits
                        ? []
                        : [
                              {
                                  id: 'session-1aba7f97-d490-49cc-acfd-6e888baa26f0',
                                  title: 'dsh_chat嵌入web方案咨询',
                                  createdAt: Date.now() - 3600000,
                                  updatedAt: Date.now() - 600000,
                                  bytes: 4567098,
                                  turns: 5,
                                  hits: 20,
                                  seq: 255028,
                                  snippets: [
                                      { role: 'thinking', label: '思考', seq: 255028, snippet: '…搜遍工程里所有会话的全文才是真正有用的那件事：「我上次那个关于打击感的会话在哪」。于是加一条 search 子命令…' },
                                      { role: 'tool-result', label: '工具结果', seq: 255100, snippet: '…设计文档：docs/打击反馈设计.md（「图纸印痕」）。改打击感只动这一个文件…' },
                                      { role: 'assistant', label: '我', seq: 255200, snippet: '…中文按字断词，所以字面子串扫描才是这个面板要的语义，FTS5 的 unicode61 分词器搜「打击感」基本搜不到东西…' },
                                  ],
                              },
                              {
                                  id: '36eb7318-c17b-4ded-9cca-441a471c6cfe',
                                  title: '（无标题）',
                                  createdAt: Date.now() - 86400000,
                                  updatedAt: Date.now() - 80000000,
                                  bytes: 604449,
                                  turns: 1,
                                  hits: 5,
                                  seq: 665,
                                  snippets: [
                                      { role: 'assistant', label: '我', seq: 665, snippet: '…顿帧是「对 DPS 的隐性征税」：只缩 ctx.Tick，不缩 elapsed 与阶段倒计时。打击感的强度走密度自适应衰减…' },
                                  ],
                              },
                          ],
                };
            }
            if (message === 'history-export') {
                window.__dshHistoryExports = (window.__dshHistoryExports || []).concat([payload]);
                const format = (payload && payload.format) === 'jsonl' ? 'jsonl' : 'md';
                if (__query.get('exportfail') === '1') return { ok: false, error: '写文件失败：EACCES（预览里造的错）' };
                return {
                    ok: true,
                    id: (payload && payload.sessionId) || 'session-1aba7f97',
                    title: 'dsh_chat嵌入web方案咨询',
                    format: format,
                    // ⚠ 反斜杠要写**四**个：这一整段是外层模板字符串里的文本，四个到了页面源码里
                    //   是两个，页面里的字符串才真正有一个反斜杠（写两个的话「反斜杠 + U」会被
                    //   当成未知转义，反斜杠当场消失 —— 预览里就变成「C:Userswx.dsh...」这种
                    //   看着像 bug 的路径）
                    path: 'C:\\\\Users\\\\wx\\\\.dsh\\\\exports\\\\--D-Project-cocos-jihe_defence--\\\\20261005-051230-dsh_chat嵌入web方案咨询-1aba7f97.' + format,
                    dir: 'C:\\\\Users\\\\wx\\\\.dsh\\\\exports\\\\--D-Project-cocos-jihe_defence--',
                    bytes: format === 'md' ? 90241 : 4567098,
                    events: format === 'md' ? 1240 : 9871,
                };
            }
            if (message === 'history-delete') {
                window.__dshHistoryDeletes = (window.__dshHistoryDeletes || []).concat([payload]);
                if (__query.get('deletefail') === '1') return { ok: false, error: '这是 agent 当前正在用的会话 —— 先在面板上点「新会话」，再回来删它' };
                return {
                    ok: true,
                    id: (payload && payload.sessionId) || 'session-1aba7f97',
                    removed: !(payload && payload.dryRun),
                    fileCount: 1,
                    bytes: 2421519,
                    cleared: false,
                };
            }
            // ---- 输入触发器（斜杠命令 / @路径）----
            // 这三个回执的形状与真主进程**逐字一致**（它自己也只是转发插件的回执 + 收敛）：
            // 面板那两个菜单的渲染路径在预览里是**真跑的**，只有数据是样本。
            if (message === 'command-list') {
                window.__dshCommandsAsked = (window.__dshCommandsAsked || 0) + 1;
                if (__query.get('nocommands') === '1') return { ok: false, error: 'commands 服务不可用（预览里造的错）' };
                return {
                    ok: true,
                    commands: [
                        { name: 'compact', description: 'Compact older conversation history' },
                        { name: 'plan', description: 'Enter or leave plan mode', hint: '[off|message]', images: true },
                        { name: 'goal', description: 'set or view the goal for a long-running task', hint: '<goal>' },
                        { name: 'feedback', description: '记录一次反馈（分享会话记录给 DSH 团队）' },
                    ],
                };
            }
            if (message === 'command-run') {
                window.__dshCommands = (window.__dshCommands || []).concat([payload]);
                const line = String((payload && payload.line) || '');
                if (line.indexOf('/nope') === 0) return { ok: false, known: false, error: '没有这个斜杠命令：/nope' };
                if (line.indexOf('/compact') === 0) return { ok: true, known: true, kind: 'error', text: '没有可压缩的历史（这一轮太短了）' };
                return { ok: true, known: true, kind: 'success', text: 'Plan mode on.' };
            }
            if (message === 'file-reference') {
                const query = String((payload && payload.query) || '');
                window.__dshRefQuery = query;
                if (__query.get('norefs') === '1') return { ok: false, error: 'fileReferences 服务不可用（预览里造的错）' };
                const all = [
                    { path: 'assets/scripts/game/battle', kind: 'directory' },
                    { path: 'assets/scripts/game/battle/RelicHooks.ts', kind: 'file' },
                    { path: 'assets/scripts/game/battle/RelicShop.ts', kind: 'file' },
                    { path: 'assets/scripts/game/battle/RelicDraw.ts', kind: 'file' },
                    { path: 'assets/resources/tb/relics.json', kind: 'file' },
                    { path: 'tools/excel_export/scripts/lib/relic-inner-design.mjs', kind: 'file' },
                    { path: 'docs/agent-notes/配表与数值口径.md', kind: 'file' },
                ];
                return { ok: true, candidates: query ? all.filter((item) => item.path.indexOf(query) >= 0) : all };
            }
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
    const { template, tokensCss, componentCss, markdownJs, toolCardJs, mentionJs, progressJs, costJs, constantsJs, imagesJs, panelJs, entries, imageSample } = parts;
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
<style>${safe(editorThemeCss)}</style>
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
    // 输入触发器（/ 命令 与 @ 路径）的 token 语法在单独一个文件里 —— 必须一起喂
    './mention': ${JSON.stringify(mentionJs)},
    // 进度的纯函数（chip 文案 / 清单计数）也在单独一个文件里，同理
    './progress': ${JSON.stringify(progressJs)},
    // 花费的纯函数（金额格式化 / 那几句话）同理 —— 它必须与面板真加载的那份是同一个文件
    './cost': ${JSON.stringify(costJs)},
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
  'editor-theme.css': ${JSON.stringify(editorThemeCss)},
};
</script>
<script>
try {
  __dshLoad('../../constants', ${JSON.stringify(constantsJs)});
  __dshLoad('../../images', ${JSON.stringify(imagesJs)});
  __dshLoad('./markdown', ${JSON.stringify(markdownJs)});
  __dshLoad('./tool-card', ${JSON.stringify(toolCardJs)});
  __dshLoad('./mention', ${JSON.stringify(mentionJs)});
  __dshLoad('./progress', ${JSON.stringify(progressJs)});
  __dshLoad('./cost', ${JSON.stringify(costJs)});
  const options = __dshLoad('panel', ${JSON.stringify(panelJs)});
  window.__dshHookCalls = { show: 0, hide: 0 };
  window.__dshMissing = 0;
  // ?click=<选择器>：挂载后自动点一下（用来给历史抽屉拍照，不用手工点）
  // ?click=<选择器>[,<选择器>…]：挂载后自动点（用来给历史抽屉拍照，不用手工点）。
  // 支持一串是因为抽屉里那几条新路是**有先后**的：先开抽屉、再点某一行的「删」。
  const autoClick = __query.get('click');
  /**
   * ?hsearch=<词>：在历史抽屉的搜索框里打字并按「搜全文」。
   *
   * 为什么要单独一个开关而不是靠「?click=」：搜索是**输入事件**驱动的（与「/」「@」两个
   * 菜单同一个理由），不塞文本 + 派发 input 就没法拍照。
   */
  const autoSearch = __query.get('hsearch');
  /**
   * ?scroll=<选择器>：把匹配到的第一个元素**滚到底**（scrollTop = scrollHeight）。
   *
   * 为什么需要它：两个抽屉（#usage / #progress）**自己就是滚动容器**
   * （CSS 里 max-height: 62% + overflow: auto），而最靠下的那一块（花费 / 回合目录）
   * 在 380px 宽的面板里一开始根本不在视野内 —— 页面级的滚动碰不到它，
   * 于是「底部那块布局有没有被撑破」就只能靠「文本里确实有这几个字」来推。
   * 与 ?click= 同一族：都是为了让**目测**这条路真的走得到那一屏。
   */
  const autoScroll = __query.get('scroll');
  const clickAll = (box, selector) => {
    const steps = String(selector || '').split(',').map((item) => item.trim()).filter(Boolean);
    steps.forEach((step, index) => {
      setTimeout(() => {
        const node = box.querySelector(step);
        if (node) node.click();
        else window.__dshErrors.push(new Error('预览的 ?click= 没找到元素：' + step));
      }, 220 * (index + 1));
    });
  };
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
    if (autoClick) clickAll(box, autoClick);
    if (autoScroll) {
      // 晚于 ?click= 那几步（220ms × n）：抽屉是**点开**的，点完才谈得上滚动
      setTimeout(() => {
        const node = box.querySelector(autoScroll);
        if (node) node.scrollTop = node.scrollHeight;
        else window.__dshErrors.push(new Error('预览的 ?scroll= 没找到元素：' + autoScroll));
      }, 900);
    }
    if (autoSearch) {
      setTimeout(() => {
        const search = box.querySelector('#history-search');
        const button = box.querySelector('#btn-history-search');
        if (!search || !button) {
          window.__dshErrors.push(new Error('预览里没有历史搜索框（#history-search / #btn-history-search）'));
          return;
        }
        search.value = autoSearch;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
      }, 600);
    }
    // ?type=<文本>：把文本塞进输入框并触发一次 input（截图用 —— 两个输入触发器
    // （/ 命令表 与 @ 路径候选）都是**输入事件**驱动的，不开这个开关就没法拍照）
    const autoType = __query.get('type');
    if (autoType) {
      const box2 = box.querySelector('#input');
      if (box2) {
        box2.value = autoType;
        box2.dispatchEvent(new Event('input', { bubbles: true }));
        box2.focus();
      }
    }
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
      // 输入触发器弹出块（/ 命令表 与 @ 路径候选共用 #popup）：它**不是浮层**，
      // 占的是对话区上方的版面 —— 高度写进自检条，免得「挤掉一截对话区」被当成渲染问题
      const popup = box.querySelector('#popup');
      // 用量抽屉：同样不是浮层，占对话区上方的版面（高度进自检条）
      const usage = box.querySelector('#usage');
      // 进度抽屉：同上。它比用量更该量 —— 一条清单十几行、一个目录十轮，
      // 「抽屉自己滚不动、把对话区挤没了」这种塌法只有量高度才看得出来
      const progress = box.querySelector('#progress');
      const overflow = root.scrollWidth - root.clientWidth;
      out.push(
        id.replace('panel-', '') +
          ': root=' + root.clientHeight +
          '/body=' + (body ? body.clientHeight : '?') +
          (hist && !hist.hidden
            ? '/hist=' + hist.clientHeight + '(' + hist.querySelectorAll('.dsh-history-item').length + '条' +
              (hist.querySelectorAll('.dsh-history-snippet').length ? ' 片段' + hist.querySelectorAll('.dsh-history-snippet').length : '') +
              (hist.querySelector('.dsh-history-actions[data-confirm="true"]') ? ' 确认中' : '') +
              ')'
            : '') +
          (bar && !bar.hidden ? '/bar=' + bar.clientHeight : '') +
          (images && !images.hidden ? '/图=' + images.querySelectorAll('.dsh-attach').length : '') +
          (picker && !picker.hidden ? '/选择器=' + picker.clientHeight + '(' + picker.querySelectorAll('.dsh-pick-item').length + '项)' : '') +
          (hist && !hist.hidden
            ? '/历史=' + hist.clientHeight + '(' + hist.querySelectorAll('.dsh-history-item').length + '条' +
              (hist.querySelectorAll('.dsh-history-snippet').length ? ' 片段' + hist.querySelectorAll('.dsh-history-snippet').length : '') +
              (hist.querySelector('.dsh-history-actions[data-confirm="true"]') ? ' 确认中' : '') +
              ')'
            : '') +
          (popup && !popup.hidden
            ? '/弹出=' + popup.clientHeight + '(' + popup.dataset.kind + ' ' + popup.querySelectorAll('.dsh-popup-item').length + '项)'
            : '') +
          (usage && !usage.hidden
            ? '/用量=' + usage.clientHeight + '(' + usage.querySelectorAll('.dsh-usage-block').length + '块' +
              (usage.querySelectorAll('.dsh-usage-notes-item').length ? ' 说明' + usage.querySelectorAll('.dsh-usage-notes-item').length : '') +
              // 曲线：柱数 / 压缩点 / 回合带 —— 「图上到底画出来几根」是截图看不出的那一半
              (usage.querySelectorAll('.dsh-timeline-slot').length
                ? ' 曲线' + usage.querySelectorAll('.dsh-timeline-slot').length + '柱' +
                  (usage.querySelectorAll('.dsh-timeline-cut').length ? '剪' + usage.querySelectorAll('.dsh-timeline-cut').length : '') +
                  '/带' + usage.querySelectorAll('.dsh-timeline-band').length +
                  '/估' + usage.querySelectorAll('.dsh-timeline-bar[data-estimated="true"]').length
                : '') +
              ')'
            : '') +
          (progress && !progress.hidden
            ? '/进度=' + progress.clientHeight + '(' + progress.querySelectorAll('.dsh-usage-block').length + '块' +
              (progress.querySelectorAll('.dsh-todo-item').length ? ' 清单' + progress.querySelectorAll('.dsh-todo-item').length + '条' : '') +
              (progress.querySelectorAll('.dsh-turn').length ? ' 回合' + progress.querySelectorAll('.dsh-turn').length + '轮' +
                (progress.querySelectorAll('.dsh-turn[data-jump="true"]').length ? ' 可点' + progress.querySelectorAll('.dsh-turn[data-jump="true"]').length : '') : '') +
              ')'
            : '') +
          (overflow > 1 ? ' OVERFLOW+' + overflow : ''),
      );
    }
    return out.join('   ');
  }
  /**
   * 状态行两颗 chip 的**实际文本**（藏起来的写「-」）。
   *
   * 为什么要打进自检条：chip 是「看一眼就知道 agent 在干什么」的那一格，
   * 而它的内容全是判据（有没有清单、是不是上一轮的、占用率多少）—— 截图里能看见，
   * 但文字版更容易对比两次改动之间有没变。
   */
  function chipText() {
    const box = document.getElementById('panel-narrow');
    if (!box) return '?';
    const parts = [];
    for (const id of ['btn-usage', 'btn-progress']) {
      const node = box.querySelector('#' + id);
      parts.push(node && !node.hidden ? node.textContent : '-');
    }
    return parts.join('/');
  }
  /**
   * 花费那一块画出来的是哪几个字（用量抽屉得先打开才有）。
   * 为什么放进自检条：这一块的**大半个内容都是文字**（原值 / 折算 / 来路 / 对账），
   * 截图只能看出「有一块」，看不出「说的是哪一句」—— 而说错话与没说话，在线上一模一样。
   */
  function costText() {
    const rows = document.querySelectorAll('#panel-narrow .dsh-usage-block');
    for (const row of rows) {
      const title = row.querySelector('.dsh-usage-block-title');
      if (!title || title.textContent !== '花费') continue;
      const values = row.querySelectorAll('.dsh-usage-value');
      const sources = row.querySelectorAll('.dsh-usage-source');
      const head = values.length > 0 ? values[0].textContent : (sources[0] ? '（没有记录）' : '?');
      return head + (sources.length > 0 ? '+' + sources.length + '句' : '');
    }
    return '（抽屉没开）';
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
      '  搜索=' + ((window.__dshHistorySearches || []).length ? (window.__dshHistorySearches.length + '次') : '未请求') +
      '  导出=' + ((window.__dshHistoryExports || []).length) +
      '  删除=' + ((window.__dshHistoryDeletes || []).length) +
      '  用量=' + ((window.__dshUsageReads || 0) + '次') +
      '  chip=' + chipText() +
      '  花费=' + costText() +
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
    // 配色覆盖层（palette=editor）：预览台也要能看出它，否则「改了配色」在离线预览里是隐形的
    const editorThemeCss = read(path.join('static', 'style', 'default', 'editor-theme.css'));
    const panelJs = read(path.join('dist', 'panels', 'default', 'index.js'));
    const markdownJs = read(path.join('dist', 'panels', 'default', 'markdown.js'));
    const toolCardJs = read(path.join('dist', 'panels', 'default', 'tool-card.js'));
    const mentionJs = read(path.join('dist', 'panels', 'default', 'mention.js'));
    const progressJs = read(path.join('dist', 'panels', 'default', 'progress.js'));
    const costJs = read(path.join('dist', 'panels', 'default', 'cost.js'));
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
            mentionJs,
            progressJs,
            costJs,
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
