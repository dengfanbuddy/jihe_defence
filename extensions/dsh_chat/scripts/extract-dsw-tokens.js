/**
 * 从已安装的 DSH 里抽设计 token，生成 `static/style/default/dsw-tokens.css`。
 *
 * ## 为什么要抽，而不是手抄
 *
 * 面板的观感要跟 DSH 一致，靠的是它那套 `--dsw-*` 设计 token（色板 → 语义别名、
 * 明暗两套、字号阶梯、elevation 阴影、滚动条）。手抄必然抄丢、抄错、且 DSH 升级后不会跟。
 * 这套 token 在 `@deepseek-ai/dsh-client-ui-theme` 的 bundle 里是**内联的 CSS 字符串**
 * （六张样式表：base / design-platform / gradient-shadow-text / shiki / scrollbar / corner-shape），
 * 所以这里把它们抠出来、做一次**选择器降域**，直接落成 CSS 文件。
 *
 * ## 唯一改动 = 选择器降域
 *
 * 原表的 `:root` / `body` 全部改写到 `.dsh-root`，深色从 `body[data-ds-dark-theme]`
 * 改成 `.dsh-root[data-theme="dark"]`，滚动条伪元素加 `.dsh-root` 前缀。
 * 理由：面板的 `style` 会被注入进编辑器的页面，不降域就会改到编辑器自己的界面
 * （旧版面板样式里那句 `html,body{background:#252526}` 就是这种写法，属于隐患）。
 *
 * ## 用法
 *
 * ```
 * node extensions/dsh_chat/scripts/extract-dsw-tokens.js            # 生成/覆盖
 * node extensions/dsh_chat/scripts/extract-dsw-tokens.js --check    # 只比对，不一致退出码 1
 * node extensions/dsh_chat/scripts/extract-dsw-tokens.js <client.js 路径>
 * ```
 *
 * 幂等：同一份 DSH 跑多少次结果都一样。用了新版本的 DSH 之后重跑一次即可。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 生成物落点（相对扩展根）。 */
const OUT_RELATIVE = path.join('static', 'style', 'default', 'dsw-tokens.css');

/** 要抽的六张表，顺序即导入顺序（scrollbar 必须排在声明 token 的 design-platform 之后）。 */
const SHEETS = [
    ['base', 'base_css_default'],
    ['design-platform', 'design_platform_css_default'],
    ['gradient-shadow-text', 'gradient_shadow_text_css_default'],
    ['shiki', 'shiki_css_default'],
    ['scrollbar', 'scrollbar_css_default'],
    ['corner-shape', 'corner_shape_css_default'],
];

/** 扩展根（本文件在 <root>/scripts/ 下）。 */
const EXTENSION_ROOT = path.resolve(__dirname, '..');

/**
 * 找 `@deepseek-ai/dsh-client-ui-theme` 的 client bundle。
 *
 * 装了 dsh 的机器上它一定在 dsh 包自己的 node_modules 里；
 * 找法按「越确定越靠前」排：显式参数 → PATH 上的 dsh 安装位置 → 全局 npm 目录。
 */
function resolveThemeBundle(explicit) {
    const relative = path.join(
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-theme',
        'lib',
        'client.js',
    );
    const candidates = [];
    if (explicit) candidates.push(explicit);
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        candidates.push(path.join(dir, relative));
        candidates.push(path.join(dir, '..', relative));
    }
    const appData = process.env.APPDATA;
    if (appData) candidates.push(path.join(appData, 'npm', relative));
    for (const candidate of candidates) {
        try {
            if (candidate && fs.statSync(candidate).isFile()) return path.resolve(candidate);
        } catch {
            /* 换下一个 */
        }
    }
    return null;
}

/** 抠出一个 JS 字符串字面量（`"` 开头，支持常见转义）。 */
function readLiteral(source, startIndex) {
    const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', 0: '\0' };
    let index = startIndex;
    let out = '';
    while (index < source.length) {
        const char = source[index];
        if (char === '\\') {
            const next = source[index + 1];
            out += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
            index += 2;
            continue;
        }
        if (char === '"') break;
        out += char;
        index += 1;
    }
    return out;
}

/** 取出一张表的 CSS 正文。 */
function sheet(source, variableName) {
    const key = `var ${variableName} = "`;
    const index = source.indexOf(key);
    if (index < 0) throw new Error(`bundle 里找不到 ${variableName}（DSH 改了打包方式？）`);
    return readLiteral(source, index + key.length);
}

/** 选择器降域：一切落到 `.dsh-root` 子树里。 */
function scope(css) {
    return css
        .replace(/body\[data-ds-dark-theme\]/g, '.dsh-root[data-theme="dark"]')
        .replace(/body,body \*/g, '.dsh-root,.dsh-root *')
        .replace(/\bbody\b/g, '.dsh-root')
        .replace(/:root/g, '.dsh-root')
        .replace(/\*,:before,:after/g, '.dsh-root,.dsh-root :before,.dsh-root :after')
        .replace(/(^|\})(::-webkit-scrollbar)/g, '$1.dsh-root$2,.dsh-root $2')
        .replace(/(^|\})(::-webkit-scrollbar-[a-z-]+)/g, '$1.dsh-root$2,.dsh-root $2');
}

/** 压成一行的 CSS 拆开（生成物是给人 review 的）。 */
function pretty(css) {
    return css
        .replace(/\}/g, '}\n')
        .replace(/([^;\n{}])\}/g, '$1\n}')
        .replace(/;(?=--)/g, ';\n  ')
        .replace(/\{/g, ' {\n  ')
        .replace(/\n\s*\n/g, '\n');
}

/** 头的说明（写清来源与那条唯一改动）。 */
function header() {
    return [
        '/*',
        ' * DSH 设计 token —— 从已安装的 @deepseek-ai/dsh 直接抽取，不是手抄。',
        ' *',
        ' * 源：@deepseek-ai/dsh-client-ui-theme（六张样式表 base / design-platform /',
        ' * gradient-shadow-text / shiki / scrollbar / corner-shape，在 bundle 里是内联的 CSS 字符串）',
        ' * 生成：node extensions/dsh_chat/scripts/extract-dsw-tokens.js（幂等，重跑即覆盖本文件）',
        ' *',
        ' * 唯一改动 = 选择器降域：原表的 :root / body 全部落到 .dsh-root，',
        ' * 深色从 body[data-ds-dark-theme] 改成 .dsh-root[data-theme="dark"]，',
        ' * 滚动条伪元素加 .dsh-root 前缀 —— 面板的 style 注入在编辑器页面里，',
        ' * 不降域会改到编辑器自己的界面。',
        ' */',
        '',
        '/* 面板自己补的两条根变量：正文字号（原由 DSH web 客户端的启动脚本注入）与 color-scheme。 */',
        '.dsh-root {',
        '  --dsh-content-font-size: 14px;',
        '  color-scheme: light;',
        '}',
        '.dsh-root[data-theme="dark"] {',
        '  color-scheme: dark;',
        '}',
        '',
    ].join('\n');
}

/** 组装最终 CSS。 */
function build(bundlePath) {
    const source = fs.readFileSync(bundlePath, 'utf8');
    const parts = SHEETS.map(([label, variable]) => {
        const css = scope(sheet(source, variable));
        return `/* ==== ${label}.css ==== */\n${pretty(css)}`;
    });
    return `${header()}${parts.join('\n')}\n`;
}

function main() {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const explicit = args.find((arg) => !arg.startsWith('--'));
    const bundle = resolveThemeBundle(explicit);
    if (!bundle) {
        console.error(
            '找不到 @deepseek-ai/dsh-client-ui-theme 的 client.js。\n' +
                '请显式给路径：node scripts/extract-dsw-tokens.js <dsh 包>/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
        );
        process.exit(1);
    }

    const output = build(bundle);
    const target = path.join(EXTENSION_ROOT, OUT_RELATIVE);
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

    if (checkOnly) {
        if (previous === output) {
            console.log(`dsw-tokens.css 与 ${bundle} 一致（${output.length} 字节）`);
            return;
        }
        console.error('dsw-tokens.css 与已安装的 DSH 不一致 —— 重跑一次脚本（去掉 --check）即可。');
        process.exit(1);
    }

    fs.writeFileSync(target, output, 'utf8');
    console.log(
        `${previous === output ? '无需改动' : '已写入'} ${path.relative(process.cwd(), target)}\n` +
            `  源：${bundle}\n` +
            `  ${output.split('\n').length} 行，${(output.match(/--dsw-[\w-]+\s*:/g) || []).length} 条 token 声明`,
    );
}

main();
