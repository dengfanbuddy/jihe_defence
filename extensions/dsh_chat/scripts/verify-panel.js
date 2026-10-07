/**
 * 面板的**静态契约**自检 —— 不开编辑器、不开浏览器就能跑的回归网。
 *
 * 面板有三处「写在两个地方、必须对得上」的契约，而且**对不上的时候都不报错**，
 * 只是安静地不工作（这正是这类 bug 难查的原因）：
 *
 * 1. **消息名**：面板 `MSG.xxx` ↔ `package.json` 的 `contributions.messages`。
 *    没注册的消息 `Editor.Message.request` 会直接失败，而错误经常被 `try/catch` 吞掉；
 * 2. **元素 id**：`SELECTORS` ↔ `static/template/default/index.html`。
 *    对不上时 `$` 拿到 null，面板只 warn 一句就继续跑（UI 半死不活）；
 * 3. **样式类**：新加的类名必须真在 `static/style/default/index.css` 里有定义。
 *
 * 视觉/布局/交互的验证交给 `scripts/preview-panel.js`（预览页自己把计数与量出来的高度
 * 写在顶部自检条里）；这里只管「名字有没有对上」。
 *
 * ```sh
 * node scripts/verify-panel.js
 * ```
 *
 * @module dsh_chat/verify-panel
 */

'use strict';

const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveDshHome } = require('./install-profile.js');

const ROOT = resolve(__dirname, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        // 早退路径也要红 —— 别只靠结尾那一行（见 verify-replay 踩过的洞）。
        process.exitCode = 1;
    }
};

/** 面板会用到的样式类（在 index.css 里必须都有定义）。 */
const REQUIRED_CLASSES = [
    'dsh-history',
    'dsh-history-head',
    'dsh-history-title',
    'dsh-history-note',
    'dsh-history-list',
    'dsh-history-item',
    'dsh-history-item-title',
    'dsh-history-item-meta',
    'dsh-history-empty',
    'dsh-history-bar',
    'dsh-history-bar-text',
    // 搜索 / 导出 / 删除（同一张抽屉里的三条新路）—— 还是那个理由：类名写错不会报错，
    // 只是那一段变成没有边框没有背景的裸文字，看起来像没做
    'dsh-history-searchrow',
    'dsh-history-search',
    'dsh-history-open',
    'dsh-history-actions',
    'dsh-mini-btn',
    'dsh-mini-danger',
    'dsh-history-confirm-text',
    'dsh-history-snippets',
    'dsh-history-snippet',
    'dsh-history-snippet-label',
    'dsh-history-snippet-text',
    // 图片：碎片 / 选择器 / 消息里的图（见文件头第 3 条：新加的类名必须真有定义，
    // 否则「加上了但没样式」——面板不会报错，只是看起来像没做）
    'dsh-attachments',
    'dsh-attach',
    'dsh-attach-thumb',
    'dsh-attach-meta',
    'dsh-attach-name',
    'dsh-attach-size',
    'dsh-attach-del',
    'dsh-image-btn',
    'dsh-picker',
    'dsh-picker-head',
    'dsh-picker-title',
    'dsh-picker-search',
    'dsh-picker-note',
    'dsh-picker-list',
    'dsh-pick-item',
    'dsh-pick-thumb',
    'dsh-pick-text',
    'dsh-pick-name',
    'dsh-pick-path',
    'dsh-msg-text',
    'dsh-msg-images',
    'dsh-msg-image',
    'dsh-msg-image-thumb',
    'dsh-msg-image-glyph',
    'dsh-msg-image-name',
    'dsh-msg-image-meta',
    // 交互块（模型的提问 / 授权请求 / 计划评审）—— 同样：类名写错不会报错，只是没样式，
    // 于是「一大块没边框没背景的裸文字」混在对话区里，看起来像渲染坏了
    'dsh-interaction',
    'dsh-interaction-card',
    'dsh-interaction-head',
    'dsh-interaction-badge',
    'dsh-interaction-source',
    'dsh-interaction-body',
    'dsh-interaction-question-block',
    'dsh-interaction-header',
    'dsh-interaction-question',
    'dsh-interaction-reason',
    'dsh-interaction-detail',
    'dsh-interaction-options',
    'dsh-interaction-option',
    'dsh-interaction-input',
    'dsh-interaction-actions',
    'dsh-interaction-allow',
    'dsh-interaction-submit',
    // 输入触发器（`/` 命令表 与 `@` 路径候选）—— 同一个理由：类名写错不会报错，
    // 只是那块变成一个没有边框没有背景的裸列表，混在输入框上方看起来像渲染坏了
    'dsh-popup',
    'dsh-popup-item',
    'dsh-popup-label',
    'dsh-popup-detail',
    // 用量（状态行那颗 chip + 抽屉）—— 同一个理由：类名写错不会报错，
    // 只是那块变成没有边框没有背景的裸文字，而那正是「数字看起来不可信」的来源
    'dsh-usage',
    'dsh-usage-head',
    'dsh-usage-title',
    'dsh-usage-note',
    'dsh-usage-body',
    'dsh-usage-bar',
    'dsh-usage-fill',
    'dsh-usage-block',
    'dsh-usage-block-title',
    'dsh-usage-line',
    'dsh-usage-label',
    'dsh-usage-value',
    'dsh-usage-notes',
    'dsh-usage-notes-item',
    'dsh-usage-source',
    'dsh-usage-chip',
    // 进度（待办清单 / 目标 / 回合目录）—— 抽屉外壳与清单/回合条目是这一块独有的；
    // 「一块说明 / 一行标签值」直接复用上面那批 `.dsh-usage-*`（通用件，见 CSS 里的注释）
    'dsh-progress',
    'dsh-progress-head',
    'dsh-progress-title',
    'dsh-progress-note',
    'dsh-progress-body',
    'dsh-progress-chip',
    'dsh-todo',
    'dsh-todo-item',
    'dsh-todo-mark',
    'dsh-todo-text',
    'dsh-todo-count',
    'dsh-turn',
    'dsh-turn-head',
    'dsh-turn-no',
    'dsh-turn-prompt',
    'dsh-turn-response',
    'dsh-turn-draft',
];

/** 预览器的假 Editor 必须认得这些消息，否则预览里点了没反应（会误导人）。 */
const PREVIEW_MESSAGES = [
    'get-state',
    'get-events',
    'history-list',
    'history-open',
    'history-resume',
    'history-search',
    'history-export',
    'history-delete',
    'session-usage',
    'list-images',
    'read-image',
    'send-message',
    'interaction-answer',
    'command-list',
    'command-run',
    'file-reference',
];

/**
 * `@` token 语法的**对账基准**。
 *
 * 面板那份 `source/panels/default/mention.ts` 是 `@deepseek-ai/dsh-file-reference` 的
 * `grammar` 的**逐字移植**（面板跑在渲染进程里、零依赖，不能 import node_modules）。
 * 移植就会漂移，所以这里拿同一批输入同时跑两份、逐字符比对 —— 接口里那几条边界
 * （邮箱里的 `@` 不算触发、`@"..."` 的引号、目录不闭合引号、控制字符拒绝）
 * 每一条漂了都会表现成「插进去的路径不是模型收到的那条」，从界面上看不出来。
 */
const GRAMMAR_CASES = [
    { line: '@', col: 1 },
    { line: '看看 @assets/scr', col: 6 + '@assets/scr'.length },
    { line: 'mail me at a@b.com', col: 6 + 'mail me at a@b.com'.length },
    { line: '@"my file', col: 4 + 'my file'.length },
    { line: '  @dir/', col: 2 + '@dir/'.length },
    { line: '正文', col: 2 },
    { line: 'a @x @y', col: 7 },
];

/** 同上一批输入要走的「选中之后插入什么」的候选。 */
const MENTION_CASES = [
    { path: 'assets/scripts/a.ts', kind: 'file' },
    { path: 'assets/my file.ts', kind: 'file' },
    { path: 'assets/scripts', kind: 'directory' },
    { path: 'assets/my dir', kind: 'directory' },
    { path: 'assets/bad"name.ts', kind: 'file' },
    { path: 'assets/ctrl\u0001name.ts', kind: 'file' },
];

async function main() {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const template = readFileSync(join(ROOT, 'static', 'template', 'default', 'index.html'), 'utf8');
    const componentCss = readFileSync(join(ROOT, 'static', 'style', 'default', 'index.css'), 'utf8');
    /**
     * ⚠ 面板是**一个目录**、不是一个文件：纯函数那几块（`mention.ts` / `progress.ts`）
     * 是独立模块（它们要能单独 `require` 出来跑已知答案）。所以「面板源码」= 整个目录拼起来 ——
     * 只读 `index.ts` 的话，凡是搬进模块里的东西都会「找不到」，而那正是第一版的假失败。
     */
    const panelSource = readdirSync(join(ROOT, 'source', 'panels', 'default'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(join(ROOT, 'source', 'panels', 'default', name), 'utf8'))
        .join('\n');
    const previewSource = readFileSync(join(ROOT, 'scripts', 'preview-panel.js'), 'utf8');

    // ---- 1. 消息名 ----
    const { MSG } = require(join(ROOT, 'dist', 'constants.js'));
    const registered = new Set(Object.keys(manifest.contributions?.messages ?? {}));
    console.log('消息名（面板 → 主进程）');
    for (const [key, value] of Object.entries(MSG)) {
        check(`MSG.${key} (${value}) 已在 package.json 注册`, registered.has(value));
    }
    const unused = [...registered].filter((name) => !Object.values(MSG).includes(name));
    console.log(`  （仅菜单/外部用的消息：${unused.join(', ') || '无'}）`);

    // ---- 2. 元素 id ----
    const block = /const SELECTORS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(panelSource);
    check('能从面板源码里解析出 SELECTORS', Boolean(block));
    const selectors = {};
    if (block) {
        for (const line of block[1].split('\n')) {
            const match = /^\s*(\w+):\s*'([^']+)'/.exec(line);
            if (match) selectors[match[1]] = match[2];
        }
    }
    console.log(`\n元素选择器（共 ${Object.keys(selectors).length} 个）`);
    check('SELECTORS 解析出了条目', Object.keys(selectors).length > 0);
    for (const [key, selector] of Object.entries(selectors)) {
        let ok;
        if (selector.startsWith('#')) {
            ok = template.includes(`id="${selector.slice(1)}"`);
        } else if (selector.startsWith('.')) {
            ok = new RegExp(`class="[^"]*\\b${selector.slice(1)}\\b`).test(template);
        } else {
            ok = template.includes(`<${selector}`);
        }
        check(`  ${key} → ${selector} 能在模板里找到`, ok);
    }

    // ---- 3. 样式类 ----
    console.log('\n样式类（必须都在 index.css 里定义）');
    for (const name of REQUIRED_CLASSES) {
        check(`  .${name} 有定义`, new RegExp(`\\.${name}[\\s,:{[]`).test(componentCss));
    }

    // ---- 3b. 配色层（palette=editor）：跟随 Cocos 编辑器的那套 token 覆盖 ----
    /**
     * 这一层有三条硬口径，缺一条就会变成"设了没反应"或"升级即丢失"：
     * ① 覆盖层必须**独立成文件**（`dsw-tokens.css` 是生成物，重跑生成器会整份覆盖）；
     * ② 只能重定义 token，**不许出现组件选择器**（否则组件层的职责被劈成两半）；
     * ③ 必须挂在 `[data-palette='editor'][data-theme='dark']` 上（特异度压过深色块，
     *    不依赖样式注入顺序），且面板真的把设置写到了根节点的 `data-palette`。
     */
    console.log('\n配色层（palette=editor → editor-theme.css）');
    const editorThemePath = join(ROOT, 'static', 'style', 'default', 'editor-theme.css');
    const editorThemeCss = existsSync(editorThemePath) ? readFileSync(editorThemePath, 'utf8') : '';
    check('editor-theme.css 在（面板 readStyle 会读它）', editorThemeCss !== '');
    check(
        '覆盖层挂在 [data-palette="editor"][data-theme="dark"] 上（特异度压过深色块，不靠注入顺序）',
        /\.dsh-root\[data-palette=['"]editor['"]\]\[data-theme=['"]dark['"]\]/.test(editorThemeCss),
    );
    /** 面板实际消费过的 token（类别各取代表）—— 少一个都会在界面上留一块没跟上的色。 */
    const PALETTE_TOKENS = [
        '--dsw-alias-bg-base',
        '--dsw-alias-bg-layer-1',
        '--dsw-alias-label-primary',
        '--dsw-alias-label-secondary',
        '--dsw-alias-border-l1',
        '--dsw-alias-state-business-primary',
        '--dsw-alias-state-error-primary',
        '--dsw-alias-state-success-primary',
        '--dsw-alias-state-warn-primary',
        '--dsw-alias-markdown-code-block',
        '--dsw-alias-scrollbar-bg-l1',
        '--dsw-alias-interactive-bg-hover-solid',
    ];
    for (const token of PALETTE_TOKENS) {
        check(`  覆盖了 ${token}`, new RegExp(`${token}\\s*:`).test(editorThemeCss));
    }
    check(
        '覆盖层只碰 token、不写组件选择器（`.dsh-*` 规则体一个都没有）',
        !/^\s*\.dsh-(?!root)/m.test(editorThemeCss),
    );
    check('面板把设置写到了根节点的 data-palette 上', panelSource.includes('root.dataset.palette'));
    check("设置 UI 里有 palette 下拉", panelSource.includes("addSelect('palette'"));
    check(
        '面板源码 import 了 PanelPalette 类型（设置与外观共用一份口径）',
        /PanelPalette/.test(panelSource) || /PanelPalette/.test(readFileSync(join(ROOT, 'source', 'constants.ts'), 'utf8')),
    );
    check('preview-panel 也注入了这一层（否则离线预览看不出配色）', previewSource.includes("'editor-theme.css'"));

    // ---- 4. 预览器认得新消息 ----
    console.log('\n预览器（假 Editor 要能回答这些消息）');
    for (const message of PREVIEW_MESSAGES) {
        check(`  预览器处理了 ${message}`, previewSource.includes(`'${message}'`));
    }
    check(
        '  预览器把 dist/images.js 也喂进去了（面板 require 的那个模块）',
        previewSource.includes("'../../images'") && previewSource.includes("read(path.join('dist', 'images.js'))"),
    );
    /**
     * 每新增一个面板模块，`preview-panel.js` 都要跟着喂 —— 忘了的症状是「一点开就报
     * 预览器没有这个模块：./progress」，而那看起来像面板坏了。所以这里把模块表逐个盯住。
     */
    for (const [module, file] of [
        ['./mention', 'mention.js'],
        ['./progress', 'progress.js'],
        ['./cost', 'cost.js'],
    ]) {
        check(
            `  预览器把 dist/panels/default/${file} 也喂进去了（面板 require('${module}')）`,
            previewSource.includes(`'${module}'`) && previewSource.includes(`'${file}'`),
        );
    }
    check(
        '  预览器能拍「花费」那四种状态（不然这一块只有文字、没有一张图）',
        ["costMode === 'ledger'", "costMode === 'noconfig'", "costMode === 'disagree'", "get('scroll')"].every((needle) =>
            previewSource.includes(needle),
        ),
    );
    // ---- 4b. 预览器那两个大模板里**不许出现反引号** ----
    // 这一条是踩了**两次**才变成断言的坑（README 坑 35）：`editorShim` 与 `buildHtml` 返回的都是
    // 模板字符串，里面任何一颗反引号都会把模板提前截断 —— 症状是 `SyntaxError: Invalid or
    // unexpected token` 指着一行中文注释，与真正的原因隔着几百行。注释里写「别用反引号」
    // 已经拦不住了（写注释的人正是要引用它的人），所以这里直接扫。
    for (const [label, from] of [
        ['editorShim', 'function editorShim'],
        ['buildHtml', 'function buildHtml'],
    ]) {
        const start = previewSource.indexOf(from);
        const open = start >= 0 ? previewSource.indexOf('return `', start) : -1;
        const close = open >= 0 ? previewSource.indexOf('`;', open + 7) : -1;
        const body = open >= 0 && close > open ? previewSource.slice(open + 8, close) : '';
        check(`  预览器的 ${label} 模板里没有多余的反引号（有的话整个预览脚本语法错）`, body.length > 0 && !body.includes('`'), body ? `模板 ${body.length} 字符` : '没找到模板');
    }

    // ---- 5. 面板真的在用它 ----
    console.log('\n面板源码里的引用');
    for (const needle of [
        'MSG.historyList',
        'MSG.historyOpen',
        'MSG.historyResume',
        'MSG.listImages',
        'MSG.readImage',
        'MSG.sendMessage',
        'MSG.interactionAnswer',
        'btnRestart',
        'resetUi',
        // 图片这条路的关键三处：粘贴入口、三条路共用的加图口、选择器懒加载
        'imagesFromClipboard',
        'attachBlobs',
        'pickerObserver',
        // 交互块的三处：画卡片、收答案（从 DOM 读）、提交
        'renderInteractions',
        'buildInteractionCard',
        'collectAnswers',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    check(
        '  面板与主进程**共用**图片那份真源（MIME 白名单/上限不许抄第二份）',
        panelSource.includes("from '../../images'"),
    );
    check(
        '  预览器与样式文件都在（漏了会在编辑器里静默降级）',
        existsSync(join(ROOT, 'scripts', 'preview-panel.js')) && existsSync(join(ROOT, 'static', 'style', 'default', 'index.css')),
    );
    for (const needle of [
        // 输入触发器的三处：输入时重算菜单、键盘协议、`/` 开头整行不走模型
        'refreshPopup',
        'handlePopupKey',
        'runCommandLine',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    for (const needle of [
        // 历史抽屉的三条新路：磁盘全文搜索、导出、两段式删除
        'runHistorySearch',
        'exportHistorySession',
        'deleteHistorySession',
        // 「搜到了但打不开」是最差的结果：回放完要能滚到命中的那一条
        'applyJump',
        'jumpTo',
        // 搜索结果必须**如实**说出覆盖率（扫了几个 / 一共几个 / 为什么停）
        'stoppedText',
        'scanned',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    check(
        '  「搜全文」按钮与「返回列表」按钮都在模板里',
        template.includes('id="btn-history-search"') && template.includes('id="btn-history-back"'),
    );

    // ---- 5b. 用量：类名、按钮、以及那两个**缩写函数**的已知答案 ----
    console.log('\n用量（token / 上下文占用）');
    for (const needle of [
        // 三条纪律：只画不算（格式化走 constants）、null 画成「—」、口径说明跟着数字一起显示
        'toggleUsage',
        'readUsage',
        'renderUsageChip',
        'usageChipText',
        'usageTone',
        'usageBusy',
        'MSG.sessionUsage',
        'formatTokens',
        'formatDuration',
        // 数据来源/水位那一行（「这个数字有多新」的唯一答案，放在 sticky 的抽屉头部）
        'usageFreshness',
        'usage.behind',
        'usage.notes',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    check(
        '  chip 与抽屉的三个按钮都在模板里',
        ['#btn-usage', '#usage', '#usage-body', '#usage-note', '#btn-usage-refresh', '#btn-usage-close'].every((selector) =>
            template.includes(`id="${selector.slice(1)}"`),
        ),
    );
    /**
     * `formatTokens` / `formatDuration` 是**面板与主进程共用的缩写口径**，纯函数、有已知答案。
     * 为什么要断言：它们坏了不会报错，只会让面板上的数字**看着还行但其实不对**
     * （比如 `999_950` 显示成 `1000.0k`）。而这两个函数是全扩展唯一一处「把数字变短」的地方，
     * 错一次会同时污染状态行、抽屉与主进程写进转写的那条 note。
     */
    const { formatTokens, formatDuration } = require(join(ROOT, 'dist', 'constants.js'));
    const tokenCases = [
        [0, '0'],
        [999, '999'],
        [1000, '1.0k'],
        [85811, '85.8k'],
        [999_949, '999.9k'],
        [999_950, '1.0M'],
        [153_424_640, '153.4M'],
        [1_000_000_000, '1.0G'],
        [null, '—'],
        [-1, '—'],
        [NaN, '—'],
    ];
    for (const [input, expected] of tokenCases) {
        const actual = formatTokens(input);
        check(`  formatTokens(${String(input)}) === ${expected}`, actual === expected, `得到 ${actual}`);
    }
    const durationCases = [
        [999, '999 ms'],
        [1500, '1.5 秒'],
        [60_000, '1 分'],
        [2_671_113, '44 分 31 秒'],
        [null, '—'],
    ];
    for (const [input, expected] of durationCases) {
        const actual = formatDuration(input);
        check(`  formatDuration(${String(input)}) === ${expected}`, actual === expected, `得到 ${actual}`);
    }

    // ---- 5c. 进度：清单 / 目标 / 回合目录 ----
    console.log('\n进度（待办清单 / 目标 / 回合目录）');
    for (const needle of [
        'toggleProgress',
        'renderProgress',
        'renderProgressChip',
        'progressChipText',
        'progressFreshness',
        'jumpToTurn',
        'progress.stale',
        'progress.todosSource',
        'progress.todosTurn',
        'turn.entrySeq',
        'progress.turnsTotal',
        'progress.draft',
        'turnHeadHint',
        // 三句必须说出来的话（每一句都是「不说就会误导」的那种，见面板里那一大段注释）
        '本轮 agent 还没写新清单',
        '只有摘要',
        '只保留最近 600 条',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    check(
        '  chip 与抽屉的按钮都在模板里',
        ['#btn-progress', '#progress', '#progress-body', '#progress-note', '#btn-progress-refresh', '#btn-progress-close'].every(
            (selector) => template.includes(`id="${selector.slice(1)}"`),
        ),
    );
    /**
     * `progressChipText` 是**状态行那颗 chip 的唯一判据**（有没有清单、完成几条、是不是上一轮的），
     * 纯函数、有已知答案（与 `mention.ts` 同一个摆法：纯函数独立成模块，面板入口里只画 DOM）。
     * 为什么要断言：它坏了不报错，只会让状态行**平静地撒谎** —— 最难看的一种是把上一轮的清单
     * 写成「现在正在做的事 3/8」（丢了「（上一轮）」那四个字）。
     */
    const { progressChipText, todoCounts, turnHeadHint } = require(join(ROOT, 'dist', 'panels', 'default', 'progress.js'));
    /**
     * ⚠ `todos` 的基线是 **null**（「这份记录里没有清单」），不是 `[]`（「agent 写了空表」）——
     * 这两个在面板上是两句话，测试数据搞错了就会验出一个假的通过。
     */
    const baseProgress = {
        todos: null,
        todosSource: 'events',
        todosTurn: null,
        stale: false,
        currentTurn: 1,
        goal: null,
        turns: [],
        turnsTotal: 0,
        draft: '',
        seq: 1,
        behind: null,
        updatedAt: 0,
        notes: [],
    };
    const chipCases = [
        ['没有读数 → 藏起来', null, null],
        ['会话还没动静 + 没清单 → 藏起来（全新会话没有清单是理所当然的）', { ...baseProgress, currentTurn: 0 }, null],
        ['开跑了但这一轮没写清单 → 「待办 —」（破折号是「不知道」，不是 0）', { ...baseProgress, currentTurn: 2 }, '待办 —'],
        [
            'agent 明确写了空表 → 「待办 空」（是它自己说的，不是读不到）',
            { ...baseProgress, todos: [] },
            '待办 空',
        ],
        [
            '有清单 → 完成数 / 总数',
            { ...baseProgress, todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] },
            '待办 1/3',
        ],
        [
            '⚠ 清单是上一轮的 → 必须带「（上一轮）」（不带就是看板撒谎）',
            { ...baseProgress, stale: true, todosTurn: 2, currentTurn: 3, todos: [{ content: 'a', status: 'completed' }] },
            '待办 1/1（上一轮）',
        ],
    ];
    for (const [label, input, expected] of chipCases) {
        const actual = progressChipText(input);
        check(`  chip「${label}」`, actual === expected, `得到 ${JSON.stringify(actual)}`);
    }
    check(
        '  todoCounts：三种状态各数各的（`pending` 不进 done/active）',
        JSON.stringify(todoCounts([{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'completed' }])) ===
            JSON.stringify({ done: 2, active: 1, total: 4 }),
    );
    check('  todoCounts：空清单是四个 0 里挑三个 0（不是 undefined）', JSON.stringify(todoCounts([])) === JSON.stringify({ done: 0, active: 0, total: 0 }));
    check(
        '  回合条目头部：能点 / 只能看 两句不一样',
        turnHeadHint(true) === '· 点一下跳到那一轮' && turnHeadHint(false) === '· 只有摘要',
        `${turnHeadHint(true)} / ${turnHeadHint(false)}`,
    );
    check(
        '  纯函数模块**零依赖**（面板跑在渲染进程里，那条 import 会在加载时炸掉整个面板）',
        !/require\(/.test(readFileSync(join(ROOT, 'dist', 'panels', 'default', 'progress.js'), 'utf8')),
    );

    // ---- 5b. 花费那一块（金额在缓存里、显示口径在账本里）----
    console.log('\n花费那一块（两个文件才画得出来）');
    for (const needle of [
        '账本原值（美元）',
        '今日（',
        '全部工程',
        '没有花费记录',
        'costTextOf',
        'costLines',
    ]) {
        check(`  面板源码出现 ${needle}`, panelSource.includes(needle));
    }
    /**
     * `costTextOf` / `formatMoney` 是**花费那一块的唯一判据**，两个都有已知答案。
     * 为什么钉死期望字符串而不是「算一遍再比」：这里的数**不许**由我们自己发明 ——
     * 面板上的钱必须与 DSH 自己（web 那边的花费面板）一模一样，而那份口径是上游的
     * `formatMoney`（逐字移植）。所以期望值全是**字面量**，
     * `verify-stats.js` 里另有一条断言把真插件 import 进来对拍。
     */
    const costModule = require(join(ROOT, 'dist', 'panels', 'default', 'cost.js'));
    const cny = { currency: 'CNY', symbol: '¥', decimals: 4, exchangeRate: 7.2, pricingCurrency: 'USD' };
    const usd = { currency: 'USD', symbol: '$', decimals: 2, exchangeRate: 1, pricingCurrency: 'USD' };
    for (const [label, amount, display, expected] of [
        ['人民币：先乘汇率、再去掉末尾的零', 2.652012124000002, cny, '¥19.0945'],
        ['美元：汇率 1 就是原值', 2.6520121240000016, usd, '$2.65'],
        ['0 就是 0（不是空字符串）', 0, cny, '¥0'],
        ['数值过小时放宽两位小数（上游的写法）', 0.00003, cny, '¥0.0002'],
        ['符号为空时回落 $（不画一个没有符号的数）', 2.652012124000002, { ...cny, symbol: '' }, '$19.0945'],
        ['汇率非法（0）按 1 兜底', 2.652012124000002, { ...cny, exchangeRate: 0 }, '¥2.652'],
        ['小数位 0 是合法配置（不许被当成缺省 2）', 2.652012124000002, { ...cny, decimals: 0, exchangeRate: 1 }, '¥3'],
    ]) {
        const actual = costModule.formatMoney(amount, display);
        check(`  formatMoney「${label}」`, actual === expected, `得到 ${JSON.stringify(actual)}`);
    }
    const costWith = costModule.costTextOf({
        cost: { amount: 2.652012124000002, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
        display: cny,
        ledger: { sessionUsd: 2.65, calls: 1225, todayUsd: 14.9217, todayKey: '2026-10-05' },
        note: null,
        mounted: true,
        bundle: 'dsh-cost-meter',
    });
    check(
        '  有检查点 + 有账本：金额按账本的显示口径画，原值（美元）与调用次数并列',
        costWith.amount === '¥19.0945' && costWith.usd === '$2.6520' && costWith.calls === '1225 次模型调用',
        JSON.stringify(costWith),
    );
    check(
        '  今日那一行带上日期与「全部工程」（账本是这台机器共享的）',
        costWith.today === '¥107.4362',
        String(costWith.today),
    );
    check(
        '  折算这件事必须说出来（币种 / 汇率 / 价表币种三样都在）',
        costWith.notes.some((note) => note.includes('汇率 7.2') && note.includes('USD')),
        costWith.notes.join(' ｜ '),
    );
    check(
        '  两处金额差得多 → 明确说「对不上」并说明为什么（不挑一个安静地画）',
        costModule
            .costTextOf({ cost: { amount: 2.65, provider: 'p', model: 'm' }, display: cny, ledger: { sessionUsd: 9.9, calls: 3, todayUsd: null, todayKey: '2026-10-05' }, note: null, mounted: true, bundle: 'dsh-cost-meter' })
            .notes.some((note) => note.includes('对不上')),
    );
    check(
        '  两处差一点点（< 1%）不啰嗦',
        !costModule
            .costTextOf({ cost: { amount: 2.65, provider: 'p', model: 'm' }, display: cny, ledger: { sessionUsd: 2.651, calls: 3, todayUsd: null, todayKey: '2026-10-05' }, note: null, mounted: true, bundle: 'dsh-cost-meter' })
            .notes.some((note) => note.includes('对不上')),
    );
    const costLedgerOnly = costModule.costTextOf({
        cost: null,
        display: cny,
        ledger: { sessionUsd: 1.25, calls: 7, todayUsd: null, todayKey: '2026-10-05' },
        note: null,
        mounted: true,
        bundle: 'dsh-cost-meter',
    });
    check(
        '  检查点里没有这一行 → 用账本兜底，并**标明来路**（不是偷偷换一个数）',
        costLedgerOnly.head === '本会话（来自账本）' && costLedgerOnly.amount === '¥9' && costLedgerOnly.notes.some((n) => n.includes('取自 cost-meter 的账本')),
        JSON.stringify(costLedgerOnly),
    );
    const costNoDisplay = costModule.costTextOf({
        cost: { amount: 2.652012124000002, provider: 'p', model: 'm' },
        display: null,
        ledger: null,
        note: '读不到 cost-meter 的账本（那个插件还没跑过，或者它换了位置）。',
        mounted: true,
        bundle: 'dsh-cost-meter',
    });
    check(
        '  读不到账本 → 按美元原值画 + 说清原因（绝不猜一个汇率）',
        costNoDisplay.amount === '$2.6520' && costNoDisplay.notes.length === 2 && costNoDisplay.notes[1].includes('美元'),
        JSON.stringify(costNoDisplay),
    );
    /**
     * **「没有花费记录」有三种来路，话术必须分成三句**（这一节是这一轮的重点）：
     * 光看缓存分不出来，只有读 profile 清单才知道「这个 profile 压根没装那个第三方 bundle」——
     * 而那种情况下用户唯一需要的就是**一条能直接粘的命令**，不是「更早的会话没有这一行」。
     */
    const noRecord = (mounted) =>
        costModule.costTextOf({ cost: null, display: null, ledger: null, note: null, mounted, bundle: 'dsh-cost-meter' });
    const notMounted = noRecord(false);
    check(
        '  这个 profile **刻意没挂**那个 bundle → 说清是刻意的 + 给一条能直接粘的命令（不是「会话太老」）',
        notMounted.amount === null &&
            notMounted.notes.length === 1 &&
            notMounted.notes[0].includes('刻意不挂') &&
            notMounted.notes[0].includes('dsh plugin --profile cocos add dsh-cost-meter'),
        JSON.stringify(notMounted.notes),
    );
    check(
        '  挂着、只是这条会话太老 → 说清「只对挂上之后跑过的会话有值」',
        noRecord(true).notes[0].includes('更早的会话') && noRecord(true).notes[0].includes('挂着它'),
        JSON.stringify(noRecord(true).notes),
    );
    check(
        '  读不到 profile 清单 → **说分不清**，不许猜（猜错的两句话都很难看）',
        noRecord(null).notes[0].includes('分不清'),
        JSON.stringify(noRecord(null).notes),
    );
    const costNothing = costModule.costTextOf({ cost: null, display: null, ledger: null, note: '账本坏了', mounted: false, bundle: 'dsh-cost-meter' });
    check(
        '  **一个金额都没有时 amount 是 null**（面板画「没有花费记录」，绝不画 0）',
        costNothing.amount === null && costNothing.notes.length === 2 && costNothing.notes[0] === '账本坏了',
        JSON.stringify(costNothing),
    );
    /**
     * 这一条是**目测抓到的**：没有金额、也没有原因时，它原来会画一句
     * 「上面显示的是账本原值（美元）」—— 而它上面除了「没有花费记录」什么都没有。
     * 判据本身没错（少了一句「怎么显示钱」的说明），错在**顺序**：先判有没有金额。
     */
    const costBare = costModule.costTextOf({ cost: null, display: null, ledger: null, note: null, mounted: false, bundle: 'dsh-cost-meter' });
    check(
        '  没有金额时**只有**「为什么没有」那一句（不许再说「上面显示的是美元原值」这种指着空气的话）',
        costBare.amount === null && costBare.notes.length === 1 && !costBare.notes[0].includes('上面显示的是'),
        JSON.stringify(costBare.notes),
    );
    check(
        '  账本里也没这条会话、检查点也没有 → 仍然是 null（不是 0）',
        costModule.costTextOf({ cost: null, display: cny, ledger: { sessionUsd: null, calls: null, todayUsd: 1, todayKey: '2026-10-05' }, note: null, mounted: true, bundle: 'dsh-cost-meter' }).amount === null,
    );
    check(
        '  纯函数模块**零依赖**（同 progress.js：多一条 import 就会在加载时炸掉整个面板）',
        !/require\(/.test(readFileSync(join(ROOT, 'dist', 'panels', 'default', 'cost.js'), 'utf8')),
    );

    /**
     * 面板面向用户的那句话**不许出现 markdown 的 `**`**：面板一律 `textContent` 写入
     * （不解析 markdown），所以 `**本轮还没写清单**` 会**原样**渲染成两个星号。
     *
     * 这个坑已经踩过**三次**（进度那一块两次、花费这次一次）—— 每次都是「从注释里
     * 复制一句话到代码里」，而注释里加粗是合理的。写注释提醒拦不住，只能直接扫。
     * 唯一的豁免是 `markdown.ts`：**它自己就是那个渲染器**（那里 `**` 是语法的组成部分）。
     */
    for (const file of readdirSync(join(ROOT, 'source', 'panels', 'default')).filter((name) => name.endsWith('.ts'))) {
        if (file === 'markdown.ts') continue;
        const source = readFileSync(join(ROOT, 'source', 'panels', 'default', file), 'utf8');
        const offenders = [...source.matchAll(/'([^'\r\n]*)'/g)]
            .map((match) => match[1])
            .filter((text) => text.includes('**'));
        check(
            `  ${file} 里没有「markdown 加粗」混进面板文案（textContent 会把 ** 原样画出来）`,
            offenders.length === 0,
            offenders.slice(0, 2).join(' ｜ '),
        );
    }

    // ---- 6. `@` 语法对账（我们那份 vs DSH 装的那份）----
    await checkMentionGrammar();

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * `@` token 语法的**对账**：同一批输入同时跑「面板那份移植」与「DSH 装的那份」，
 * 逐字符比对结果。
 *
 * 为什么要对账而不是只测我们自己的：这两份代码的**唯一**关系就是「应该一样」，
 * 而我们只会在 DSH 升级时被动发现它们不一样 —— 那时症状是「某些路径插进去之后
 * 模型收到的不是那个路径」，从界面上完全看不出来。所以把这条关系变成一条断言。
 *
 * 两份都用**真的编译产物**跑：面板那份取 `dist/panels/default/mention.js`（面板真加载的就是它），
 * DSH 那份从 `$DSH_HOME/profiles/node_modules` 里动态 import（与 `verify-bridge` 同一条路）。
 */
async function checkMentionGrammar() {
    console.log('\n@ 语法对账（面板那份移植 vs DSH 的 grammar）');
    const ours = require(join(ROOT, 'dist', 'panels', 'default', 'mention.js'));
    const reference = join(
        resolveDshHome(),
        'profiles',
        'node_modules',
        '@deepseek-ai',
        'dsh-file-reference',
        'lib',
        'types',
        'grammar.js',
    );
    if (!existsSync(reference)) {
        check('  找得到 DSH 装的那份 grammar.js（对账基准）', false, reference);
        return;
    }
    let theirs;
    try {
        theirs = await import(pathToFileURL(reference).href);
    } catch (error) {
        check('  能 import DSH 那份 grammar.js', false, error instanceof Error ? error.message : String(error));
        return;
    }

    for (const [index, item] of GRAMMAR_CASES.entries()) {
        const mine = ours.activeAtToken(item.line, item.col);
        const other = theirs.activeAtToken(item.line, item.col);
        check(
            `  activeAtToken #${index + 1}（${JSON.stringify(item.line)} @${item.col}）与 DSH 一致`,
            JSON.stringify(mine) === JSON.stringify(other),
            `我们 ${JSON.stringify(mine)} / DSH ${JSON.stringify(other)}`,
        );
    }
    for (const [index, candidate] of MENTION_CASES.entries()) {
        for (const preserve of [false, true]) {
            const mine = ours.formatFileMention(candidate, preserve);
            const other = theirs.formatFileMention(candidate, preserve);
            check(
                `  formatFileMention #${index + 1}（${candidate.kind} ${JSON.stringify(candidate.path)}，quote=${preserve}）与 DSH 一致`,
                mine === other,
                `我们 ${JSON.stringify(mine)} / DSH ${JSON.stringify(other)}`,
            );
        }
    }

    // 面板自己那层「整份输入 → 行 + 列」的换算：`activeAtToken` 只认一行，
    // 而面板用的是能换行的 textarea，所以这层是移植之外**我们自己的**代码，
    // 也要有自己的断言（否则多行输入里 `@` 补全会指到上一行去）。
    const multiLine = '第一行\n第二行 @x';
    check(
        '  lineAt：多行输入里取的是光标所在那一行',
        JSON.stringify(ours.lineAt(multiLine, multiLine.length)) === JSON.stringify({ line: '第二行 @x', col: 6 }),
        JSON.stringify(ours.lineAt(multiLine, multiLine.length)),
    );
    const mentionLine = '第二行 @a';
    const token = ours.activeAtToken(mentionLine, mentionLine.length);
    check('  replaceToken：把光标处那个 @token 换成选中项', token !== undefined);
    if (token) {
        const next = ours.replaceToken(mentionLine, mentionLine.length, token, '@assets/x.ts');
        check(
            '  replaceToken 的结果与光标位置都对',
            next.value === '第二行 @assets/x.ts' && next.caret === '第二行 @assets/x.ts'.length,
            JSON.stringify(next),
        );
        const stale = ours.replaceToken('第二行 改了', 6, token, '@assets/x.ts');
        check(
            '  replaceToken：token 已经不在光标前时**一个字符都不改**',
            stale.value === '第二行 改了',
            JSON.stringify(stale),
        );
    }
    check(
        '  commandDraft：`/xx` 算命令草稿，`/xx 参数` 不算（已经在写参数了）',
        JSON.stringify(ours.commandDraft('/com', 4)) === JSON.stringify({ query: 'com' }) &&
            ours.commandDraft('/compact 全部', 12) === undefined &&
            ours.commandDraft('看 /compact', 10) === undefined,
        JSON.stringify([ours.commandDraft('/com', 4), ours.commandDraft('/compact 全部', 12), ours.commandDraft('看 /compact', 10)]),
    );
}

main().catch((error) => {
    console.error(`verify-panel 崩了：${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
});
