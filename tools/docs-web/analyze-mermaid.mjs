// 一次性分析脚本：把 docs/platform-guide/*.md 里的 mermaid 代码块抽出来，
// 统计「我到底用了哪些 mermaid 语法」，供 renderer 定范围。零依赖。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'docs/platform-guide';
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md')).sort();

const blocks = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/);
  let inBlock = false;
  let buf = [];
  let start = 0;
  lines.forEach((l, i) => {
    if (!inBlock && /^\s*```mermaid\s*$/.test(l)) { inBlock = true; buf = []; start = i + 1; return; }
    if (inBlock && /^\s*```\s*$/.test(l)) { inBlock = false; blocks.push({ file: f, line: start, src: buf.join('\n') }); return; }
    if (inBlock) buf.push(l);
  });
}

const types = {};
const features = {};
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
for (const b of blocks) {
  const first = b.src.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('%%'))[0] || '';
  bump(types, first.split(/\s+/)[0]);
  const s = b.src;
  if (/^\s*subgraph\b/m.test(s)) bump(features, 'subgraph');
  if (/^\s*(style|classDef|class|linkStyle)\b/m.test(s)) bump(features, 'style/classDef/linkStyle');
  if (/-->/.test(s)) bump(features, 'arrow -->');
  if (/---/.test(s)) bump(features, 'open link ---');
  if (/-\.->|==>|~~~/.test(s)) bump(features, 'dotted/thick/invisible');
  if (/\|[^|]*\|/.test(s)) bump(features, 'edge label |x|');
  if (/--\s*[^->|][^-]*-->/.test(s)) bump(features, 'edge label -- x -->');
  if (/\{/.test(s) && /flowchart/.test(first)) bump(features, 'decision {}');
  if (/\(\("/.test(s)) bump(features, 'stadium ([])');
  if (/\["|\[\//.test(s)) bump(features, 'node with quotes');
  if (/<br\s*\/?>/.test(s)) bump(features, '<br/> in label');
  if (/Note\s+(over|right of|left of)/i.test(s)) bump(features, 'Note');
  if (/^\s*(alt|else|opt|loop|par|end|critical|break)\b/m.test(s)) bump(features, 'seq block(alt/opt/loop/par)');
  if (/autonumber/.test(s)) bump(features, 'autonumber');
  if (/->>|-->>|->|--x|--\)/.test(s)) bump(features, 'seq arrow');
  if (/participant\s+\w+\s+as\s/.test(s)) bump(features, 'participant ... as');
  if (/stateDiagram-v2/.test(first)) {
    if (/^\s*note\b/m.test(s)) bump(features, 'state note');
    if (/^\s*state\s+\w+\s*\{/m.test(s)) bump(features, 'composite state');
    if (/\[\*\]/.test(s)) bump(features, '[*] start/end');
  }
  if (/^\s*%%/.test(s)) bump(features, 'comments %%');
  // 标签里带括号/引号等潜在陷阱
  if (/\[[^"\]]*[()（）][^"\]]*\]/.test(s)) bump(features, 'UNQUOTED-PARENS');
  if (/&/.test(s)) bump(features, 'ampersand');
  if (/[""''·—…]/.test(s)) bump(features, 'cjk-punct-in-label');
}

console.log('文件数:', files.length, ' 图总数:', blocks.length);
console.log('\n--- 图类型 ---');
Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
console.log('\n--- 用到的语法 ---');
Object.entries(features).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`));

// 每张图的规模（行数 / 节点数 / 边数）
console.log('\n--- 规模（前 8 大的图）---');
const sized = blocks.map((b) => {
  const nl = b.src.split('\n').length;
  const nodes = new Set();
  const edges = (b.src.match(/-->|---|-\.->|->>|-->>/g) || []).length;
  for (const m of b.src.matchAll(/^\s*([A-Za-z_][\w]*)\s*[\[\(\{]/gm)) nodes.add(m[1]);
  for (const m of b.src.matchAll(/^\s*participant\s+([^\s]+)/gm)) nodes.add(m[1]);
  return { ...b, nl, nodes: nodes.size, edges };
}).sort((a, b) => b.nl - a.nl);
sized.slice(0, 8).forEach((b) => console.log(`  ${b.file}:${b.line}  行 ${b.nl}  节点 ${b.nodes}  边 ${b.edges}`));

files.slice(0, 0); // noop（保留变量引用，避免 lint 噪音）
console.log('\n（本脚本只做统计，不写盘；要看单张图的源码就打开对应的 .md）');
