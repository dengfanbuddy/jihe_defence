/**
 * 界面接线自测（不需要浏览器）：校验 index.html 与 app.js 之间的契约
 *
 *   node tests/ui-contract.mjs
 *
 * 检查四件事（这几类错在浏览器里都是「点了没反应」，很容易漏）：
 *   1. app.js 里引用到的 #id / [data-*] 选择器，在 index.html 里都存在；
 *   2. 界面上的参数控件（f_xxx / b_xxx）与后端 DEFAULT_PARAMS 的键一一对得上；
 *   3. 每个参数字段都能在界面上找到对应控件（不会出现「参数改了没用」）；
 *   4. 关键交互节点（拖拽区/标签页/结果网格/弹窗）都存在。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const attrs = new Set([...html.matchAll(/\s(data-[a-z-]+)=/g)].map((m) => m[1]));
const classes = new Set([...html.matchAll(/\sclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));

console.log('\n=== 界面接线自测 ===\n');

// ---- 1) JS 里引用的 id 是否都存在 ----
const referenced = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_]+)'\)/g)) referenced.add(m[1]);
for (const m of js.matchAll(/getElementById\(`?f_\$\{name\}`?\)/g)) referenced.add('__dynamic__');
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) referenced.add(m[1]);
for (const m of js.matchAll(/\$\$?\('#([A-Za-z0-9_]+) /g)) referenced.add(m[1]);
// 模板拼出来的 id：row_${...} / f_${name} / b_xxx
const dynamicPrefixes = ['row_', 'f_', 'b_'];
const missing = [...referenced].filter((id) => id !== '__dynamic__' && !ids.has(id) && !dynamicPrefixes.some((p) => id.startsWith(p)));
check('app.js 引用的所有固定 #id 都存在于 HTML', missing.length === 0, missing.join(', '));

// ---- 2) data-* 属性 ----
// data-full 由 renderGrid 在运行时拼出来，静态 HTML 里当然没有
const RUNTIME_ATTRS = new Set(['data-full']);
const dataRefs = new Set([...js.matchAll(/\[data-([a-z-]+)[\]=]/g)].map((m) => `data-${m[1]}`));
const missingData = [...dataRefs].filter((d) => !attrs.has(d) && !RUNTIME_ATTRS.has(d));
check('app.js 引用的 data-* 属性都存在', missingData.length === 0, missingData.join(', '));

// ---- 3) 参数字段 ↔ 界面控件 ----
const fieldsBlock = /const PARAM_FIELDS = \[([\s\S]*?)\];/.exec(js)?.[1] || '';
const fields = [...fieldsBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
check('解析出界面参数字段', fields.length > 20, `${fields.length} 个`);
const noInput = fields.filter((f) => !ids.has(`f_${f}`));
check('每个界面参数字段都有对应的 f_xxx 控件', noInput.length === 0, noInput.join(', '));

// 后端默认参数里「应该能在界面上调」的键，是否都被界面覆盖
const uiOnly = new Set(['resolvedModel', 'size', 'estimate', 'baseUrl', 'apiKey', 'customModel']);
const batchBlock = /const BATCH_FIELDS = \[([\s\S]*?)\];/.exec(js)?.[1] || '';
const batchFields = [...batchBlock.matchAll(/\['([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
const notExposed = Object.keys(DEFAULT_PARAMS).filter((k) => !fields.includes(k) && !batchFields.includes(k) && !uiOnly.has(k));
check('后端默认参数都能在界面上调到', notExposed.length === 0, notExposed.join(', '));

// 批量专用字段
for (const b of ['b_inDir', 'b_outDir', 'b_recursive', 'b_limit', 'b_skipExisting', 'b_mode', 'b_concurrency', 'b_retries', 'b_refThumb', 'b_refPh', 'b_refName']) {
    if (!ids.has(b)) check(`批量控件 #${b} 存在`, false);
}
check('批量专用控件齐全', ['b_inDir', 'b_outDir', 'b_recursive', 'b_limit', 'b_skipExisting', 'b_mode', 'b_concurrency', 'b_retries'].every((b) => ids.has(b)));

// ---- 4) 关键交互节点 ----
const need = {
    '两个拖拽区': /class="checker dropzone" data-kind="(ref|target)"/.test(html) && (html.match(/data-kind="/g) || []).length === 2,
    '两个标签页与面板': (html.match(/class="tab[ "]/g) || []).length >= 2 && ids.has('tab-single') && ids.has('tab-batch'),
    '结果预览与对比图': ids.has('resMain') && ['target', 'raw', 'out'].every((k) => html.includes(`data-cmp="${k}"`)),
    '进度条与列表': ids.has('bar') && ids.has('barText') && ids.has('itemList'),
    '结果网格': ids.has('resultGrid'),
    '设置弹窗与大图弹窗': ids.has('modal') && ids.has('lightbox') && ids.has('s_apiKey'),
    '提示词预览容器': ids.has('promptPreview'),
    '模型能力标签容器': ids.has('modelCaps') && ids.has('alphaChips'),
    '透明方式说明行': ids.has('alphaTip'),
};
for (const [k, v] of Object.entries(need)) check(k, v);

// ---- 5) 「接口直出透明 + 参考图」互斥的界面拦截必须还在 ----
// （这两个选项能同时选中，是「生成的不是透明背景 / 白花钱」那类事故的入口）
check(
    '界面拦截「接口透明 + 参考图」互斥',
    /apiTransparentConflict/.test(js) &&
        /\$\('#f_alphaMode'\)\.addEventListener/.test(js) &&
        /\$\('#f_useRef'\)\.addEventListener/.test(js) &&
        /if \(apiTransparentConflict\(p\)\)/.test(js) &&
        /mode === 'generate' && apiTransparentConflict\(p\)/.test(js)
);
check(
    '透明方式说明写在界面上（不是只写在文档里）',
    /保留<\/b>输入图已有的透明通道|保留输入图已有的透明通道/.test(js) || /不能去背景|不是去背景/.test(js)
);

// ---- 6) 静态资源都在 ----
for (const f of ['public/index.html', 'public/app.js', 'public/style.css']) {
    check(`${f} 存在且非空`, fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).size > 500);
}

// ---- 7) 明显的语法问题（未闭合括号之类）----
const open = (js.match(/\{/g) || []).length;
const close = (js.match(/\}/g) || []).length;
check('app.js 花括号基本配平', Math.abs(open - close) <= 1, `{ ${open} } ${close}`);
const cssOpen = (fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8').match(/\{/g) || []).length;
const cssClose = (fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8').match(/\}/g) || []).length;
check('style.css 花括号配平', cssOpen === cssClose, `{ ${cssOpen} } ${cssClose}`);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
