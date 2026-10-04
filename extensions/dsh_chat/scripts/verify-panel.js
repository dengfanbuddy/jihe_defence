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

const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures += 1;
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
];

/** 预览器的假 Editor 必须认得这些消息，否则预览里点了没反应（会误导人）。 */
const PREVIEW_MESSAGES = [
    'get-state',
    'get-events',
    'history-list',
    'history-open',
    'history-resume',
    'list-images',
    'read-image',
    'send-message',
];

function main() {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const template = readFileSync(join(ROOT, 'static', 'template', 'default', 'index.html'), 'utf8');
    const componentCss = readFileSync(join(ROOT, 'static', 'style', 'default', 'index.css'), 'utf8');
    const panelSource = readFileSync(join(ROOT, 'source', 'panels', 'default', 'index.ts'), 'utf8');
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

    // ---- 4. 预览器认得新消息 ----
    console.log('\n预览器（假 Editor 要能回答这些消息）');
    for (const message of PREVIEW_MESSAGES) {
        check(`  预览器处理了 ${message}`, previewSource.includes(`'${message}'`));
    }
    check(
        '  预览器把 dist/images.js 也喂进去了（面板 require 的那个模块）',
        previewSource.includes("'../../images'") && previewSource.includes("read(path.join('dist', 'images.js'))"),
    );

    // ---- 5. 面板真的在用它 ----
    console.log('\n面板源码里的引用');
    for (const needle of [
        'MSG.historyList',
        'MSG.historyOpen',
        'MSG.historyResume',
        'MSG.listImages',
        'MSG.readImage',
        'MSG.sendMessage',
        'btnRestart',
        'resetUi',
        // 图片这条路的关键三处：粘贴入口、三条路共用的加图口、选择器懒加载
        'imagesFromClipboard',
        'attachBlobs',
        'pickerObserver',
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

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
