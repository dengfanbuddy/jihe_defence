/**
 * build.mjs —— 把 docs/platform-guide/*.md 构建成一站式静态站点（零依赖）
 *
 * 产物（全部在 docs/platform-guide/web/ 下，可整目录拷走 / 用 file:// 直接打开）：
 *   index.html            ← README.md
 *   00-lifecycle.html …   ← 每章一页（左侧章节导航 + 页内目录 + 上/下一章）
 *   assets/style.css
 *   assets/diagrams/<slug>-NN.svg   ← 每张 mermaid 图渲染成的**静态 SVG**（同时内联进页面）
 *
 * 用法：node tools/docs-web/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderMermaid, esc } from './mermaid-svg.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC_DIR = path.join(ROOT, 'docs/platform-guide');
const OUT_DIR = path.join(SRC_DIR, 'web');
const DIAG_DIR = path.join(OUT_DIR, 'assets/diagrams');

// ─────────────────────────── 章节清单 ───────────────────────────

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.md')).sort();
const chapterOf = (f) => f.replace(/\.md$/, '');
const slugOf = (f) => (chapterOf(f) === 'README' ? 'index' : chapterOf(f));
const bySlug = new Map(files.map((f) => [slugOf(f), f]));

const mdFiles = files.filter((f) => chapterOf(f) !== 'README');
const nav = [{ slug: 'index', title: '总览 / 索引', num: '' }].concat(
  mdFiles.map((f) => {
    const m = chapterOf(f).match(/^(\d+)-(.*)$/);
    const num = m ? m[1] : '';
    // 标题优先取正文 H1（形如「# 生命周期总纲：…」），取不到再退回文件名
    const h1 = (fs.readFileSync(path.join(SRC_DIR, f), 'utf8').match(/^#\s+(.+)$/m) || [])[1];
    let title = h1 ? h1.replace(/[*`]/g, '').trim() : (m ? m[2] : chapterOf(f));
    title = title.replace(/（[^）]*）$/, '').split(/[：:]/)[0].trim() || title;
    return { slug: slugOf(f), title, num };
  }),
);
nav.push({ slug: 'diagrams', title: '全部图表（63）', num: '★' });

// ─────────────────────────── 行内 markdown ───────────────────────────

function rewriteLink(href) {
  const [p, hash = ''] = href.split('#');
  if (/^https?:/i.test(p)) return href;
  if (!p) return href;
  const clean = p.replace(/^\.\//, '');
  if (/\.md$/i.test(clean)) {
    const base = path.posix.basename(clean);
    if (!clean.includes('/') && bySlug.has(slugOf(base))) return slugOf(base) + '.html' + (hash ? '#' + hash : '');
    return '../' + clean + (hash ? '#' + hash : ''); // web/ 深一层，指回 docs 里的原始 md
  }
  return '../' + clean + (hash ? '#' + hash : '');
}

function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${esc(rewriteLink(h))}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br/>');
  return s;
}

function slugAnchor(text) {
  return text
    .replace(/[`*]/g, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sec';
}

function splitRow(row) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// ─────────────────────────── 块级解析 ───────────────────────────

function mdToHtml(md, ctx) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const toc = [];
  let i = 0;
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[]}
  let quote = [];
  const anchors = new Map();
  const uniq = (t) => {
    const base = slugAnchor(t);
    const n = anchors.get(base) || 0;
    anchors.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type;
    const items = list.items.map((it) => {
      // 二级缩进：以 2+ 空格开头的子项
      const sub = it.sub && it.sub.length ? `<ul>${it.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>` : '';
      return `<li>${inline(it.text)}${sub}</li>`;
    });
    out.push(`<${tag}>${items.join('')}</${tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const inner = quote.join('\n');
    const html = inner.split('\n').map((l) => (l.trim() === '' ? '' : `<p>${inline(l)}</p>`)).join('');
    out.push(`<blockquote>${html}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  while (i < lines.length) {
    const line = lines[i];

    // mermaid
    if (/^\s*```mermaid\s*$/.test(line)) {
      flushAll();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const src = buf.join('\n');
      const res = renderMermaid(src);
      ctx.figN++;
      const file = `${ctx.slug}-${String(ctx.figN).padStart(2, '0')}.svg`;
      fs.writeFileSync(path.join(DIAG_DIR, file), res.svg, 'utf8');
      ctx.diagrams.push({ file, ...res, src });
      out.push(
        `<figure class="diagram" id="fig-${ctx.figN}">`
        + `<div class="diagram-body${res.width > 900 ? ' wide' : ''}">${res.svg}</div>`
        + `<figcaption>图 ${ctx.figN} · ${res.width}×${res.height} · 静态 SVG${res.width > 900 ? ' · 宽图可横向滚动' : ''} `
        + `<a class="svg-link" href="assets/diagrams/${file}" target="_blank" rel="noopener">查看/下载 .svg</a></figcaption>`
        + `</figure>`,
      );
      continue;
    }

    // 普通代码块
    if (/^\s*```/.test(line)) {
      flushAll();
      const lang = line.trim().replace(/^```/, '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="code" data-lang="${esc(lang)}"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushAll();
      const level = m[1].length;
      const text = m[2].trim();
      const id = uniq(text);
      out.push(`<h${level} id="${id}">${inline(text)}<a class="anchor" href="#${id}" aria-label="链接">§</a></h${level}>`);
      if (level === 2 || level === 3) toc.push({ level, id, text: text.replace(/[`*]/g, '') });
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushAll(); out.push('<hr/>'); i++; continue; }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushAll();
      const head = splitRow(line.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i].trim())); i++; }
      out.push('<div class="table-wrap"><table><thead><tr>'
        + head.map((h) => `<th>${inline(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
      continue;
    }

    // 引用
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); i++; continue; }

    // 列表
    if ((m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/))) {
      flushPara(); flushQuote();
      const indent = m[1].length;
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      if (indent >= 2 && list.items.length) {
        const last = list.items[list.items.length - 1];
        last.sub = last.sub || [];
        last.sub.push(m[3]);
      } else list.items.push({ text: m[3], sub: [] });
      i++;
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { flushAll(); i++; continue; }

    // 普通段落
    flushList(); flushQuote();
    para.push(line.trim());
    i++;
  }
  flushAll();
  ctx.toc = toc;
  return out.join('\n');
}

// ─────────────────────────── 页面模板 ───────────────────────────

const CSS = `:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#22272e; --ink-soft:#5b6470; --line:#e2e6ea;
  --accent:#2f6f5f; --accent-soft:#e8f2ee; --code-bg:#f4f6f8; --warn:#b4642a;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15.5px;line-height:1.72}
a{color:#1f6feb;text-decoration:none}
a:hover{text-decoration:underline}
.layout{display:flex;min-height:100vh;align-items:flex-start}
.side{position:sticky;top:0;flex:0 0 268px;height:100vh;overflow-y:auto;background:#1f2733;color:#cfd8e3;padding:18px 0 40px}
.side h1{font-size:15px;margin:6px 18px 4px;color:#fff;letter-spacing:.02em}
.side .sub{font-size:11.5px;color:#8b98a8;margin:0 18px 14px;line-height:1.5}
.side nav a{display:flex;gap:8px;align-items:baseline;padding:6px 18px;color:#c3ccd8;font-size:13px;border-left:3px solid transparent}
.side nav a:hover{background:#26303d;text-decoration:none;color:#fff}
.side nav a.on{background:#26303d;color:#fff;border-left-color:#5ec2a0;font-weight:600}
.side nav a .n{font-family:var(--mono);font-size:11px;color:#7f8c9b;min-width:18px}
.side nav a.on .n{color:#5ec2a0}
.main{flex:1;min-width:0;padding:34px 46px 90px;max-width:1180px}
.crumb{font-size:12.5px;color:var(--ink-soft);margin-bottom:10px}
.crumb a{color:var(--ink-soft)}
article{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:34px 42px 46px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
article h1{font-size:27px;margin:0 0 14px;line-height:1.35}
article h2{font-size:20.5px;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
article h3{font-size:17px;margin:26px 0 8px;color:#1d3b33}
article h4{font-size:15.5px;margin:20px 0 6px}
article p{margin:10px 0}
article ul,article ol{margin:10px 0 10px 4px;padding-left:22px}
article li{margin:5px 0}
article li>ul{margin:4px 0}
article code{background:var(--code-bg);border:1px solid var(--line);border-radius:4px;padding:.5px 4px;font-family:var(--mono);font-size:12.8px;color:#2d5c4d;word-break:break-word}
article pre.code{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
article pre.code code{background:none;border:0;padding:0;font-size:12.6px;color:#2b3138;white-space:pre}
article blockquote{margin:14px 0;padding:10px 16px;background:var(--accent-soft);border-left:4px solid #7fbfa6;border-radius:0 8px 8px 0;color:#294a40}
article blockquote p{margin:6px 0}
article hr{border:0;border-top:1px dashed var(--line);margin:26px 0}
.anchor{opacity:0;margin-left:8px;color:var(--accent);font-size:.8em}
h2:hover .anchor,h3:hover .anchor{opacity:.6}
.table-wrap{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13.6px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f0f3f6;font-weight:600}
tbody tr:nth-child(even){background:#fafbfc}
figure.diagram{margin:22px 0;padding:0}
.diagram-body{background:#fbfcfd;border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto}
.diagram-body svg{display:block;max-width:100%;height:auto}
.diagram-body.wide{overflow-x:auto}
.diagram-body.wide svg{max-width:none}
figcaption{font-size:12px;color:var(--ink-soft);margin-top:6px;display:flex;gap:10px;align-items:baseline}
.svg-link{font-family:var(--mono);font-size:11.5px}
details.toc{background:#f7f9fb;border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:0 0 22px}
details.toc summary{cursor:pointer;font-size:13px;color:var(--ink-soft);font-weight:600}
details.toc ol{margin:8px 0 4px;padding-left:20px;font-size:13.2px}
details.toc li.lv3{margin-left:14px;list-style:circle}
.pager{display:flex;justify-content:space-between;gap:12px;margin:26px 0 0;font-size:13.5px}
.pager a{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
footer.foot{margin-top:22px;font-size:12px;color:var(--ink-soft);text-align:center}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 0}
.kpi{background:var(--accent-soft);border:1px solid #cfe3da;border-radius:999px;padding:3px 12px;font-size:12.5px;color:#28564a}
@media (max-width:1000px){
  .layout{display:block}
  .side{position:static;height:auto;flex:none}
  .main{padding:20px 16px 60px}
  article{padding:20px 18px 30px}
}
@media print{
  .side,.pager,.crumb,details.toc,.svg-link{display:none}
  body{background:#fff}
  article{border:0;box-shadow:none;padding:0}
  figure.diagram{break-inside:avoid}
  article h2{break-after:avoid}
  .diagram-body.wide{overflow:visible}
  .diagram-body.wide svg{max-width:100%}
}`;

function renderPage({ slug, title, bodyHtml, toc, figN }) {
  const idx = nav.findIndex((n) => n.slug === slug);
  const prev = nav[idx - 1];
  const next = nav[idx + 1];
  const navHtml = nav.map((n) => `<a class="${n.slug === slug ? 'on' : ''}" href="${n.slug}.html"><span class="n">${n.num || '·'}</span><span>${esc(n.title)}</span></a>`).join('');
  const tocHtml = toc.length >= 3
    ? `<details class="toc" open><summary>页内目录（${toc.length} 节）</summary><ol>${toc.map((t) => `<li class="${t.level === 3 ? 'lv3' : ''}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></details>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · 集合防御 平台层使用教程</title>
<link rel="stylesheet" href="assets/style.css"/>
</head>
<body>
<div class="layout">
  <aside class="side">
    <h1>平台层使用教程</h1>
    <p class="sub">集合防御 · Cocos Creator 3.8.6<br/>19 章 · ${figN} 张静态 SVG 图</p>
    <nav>${navHtml}</nav>
  </aside>
  <main class="main">
    <div class="crumb"><a href="index.html">总览</a> / ${esc(title)}</div>
    <article>
${tocHtml}
${bodyHtml}
      <div class="pager">
        ${prev ? `<a href="${prev.slug}.html">← ${esc(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a href="${next.slug}.html">${esc(next.title)} →</a>` : '<span></span>'}
      </div>
    </article>
    <footer class="foot">本页由 <code>tools/docs-web/build.mjs</code> 从 <code>docs/platform-guide/${slug === 'index' ? 'README' : slug}.md</code> 生成 · 图全部是静态 SVG（可单独下载）</footer>
  </main>
</div>
</body>
</html>`;
}

// ─────────────────────────── 构建 ───────────────────────────

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(DIAG_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'assets/style.css'), CSS, 'utf8');

const manifest = [];
const allDiagrams = [];
let totalFig = 0;
for (const f of files) {
  const slug = slugOf(f);
  const md = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  const ctx = { slug, figN: 0, diagrams: [], toc: [] };
  const bodyHtml = mdToHtml(md, ctx);
  const title = nav.find((n) => n.slug === slug).title;
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), renderPage({ slug, title, bodyHtml, toc: ctx.toc, figN: ctx.figN }), 'utf8');
  totalFig += ctx.figN;
  for (const d of ctx.diagrams) allDiagrams.push({ ...d, slug, title });
  manifest.push({ slug, src: f, figs: ctx.figN, size: Buffer.byteLength(bodyHtml, 'utf8') });
}

// 图表总览页（★）：所有 SVG 一页看全，点击可跳到所在章节
{
  const groups = new Map();
  for (const d of allDiagrams) {
    if (!groups.has(d.slug)) groups.set(d.slug, { title: d.title, items: [] });
    groups.get(d.slug).items.push(d);
  }
  const body = ['<h1>全部图表（静态 SVG）</h1>',
    `<p>共 <strong>${allDiagrams.length}</strong> 张，全部由 <code>tools/docs-web/mermaid-svg.mjs</code> 从章节里的 mermaid 源码渲染成<strong>静态 SVG</strong>（无 JS、无外部依赖）。每张图都能单独下载。</p>`]
    .concat([...groups.entries()].map(([slug, g]) => {
      const items = g.items.map((d, i) => `<figure class="diagram" id="${d.file}">`
        + `<div class="diagram-body">${d.svg}</div>`
        + `<figcaption><a href="${slug}.html#fig-${i + 1}">${esc(g.title)} · 图 ${i + 1}</a> · ${d.width}×${d.height} `
        + `<a class="svg-link" href="assets/diagrams/${d.file}" target="_blank" rel="noopener">下载 .svg</a></figcaption></figure>`).join('');
      return `<h2 id="${slug}"><a href="${slug}.html">${esc(g.title)}</a>（${g.items.length} 张）</h2>${items}`;
    }));
  const toc = [{ level: 2, id: 'index', text: '返回总览' }].concat([...groups.entries()].map(([slug, g]) => ({ level: 2, id: slug, text: `${g.title}（${g.items.length}）` })));
  fs.writeFileSync(path.join(OUT_DIR, 'diagrams.html'), renderPage({ slug: 'diagrams', title: '全部图表', bodyHtml: body.join('\n'), toc, figN: allDiagrams.length }), 'utf8');
}

const indexHtml = (() => {
  const readme = fs.readFileSync(path.join(SRC_DIR, 'README.md'), 'utf8');
  const md = fs.readFileSync(path.join(SRC_DIR, 'README.md'), 'utf8');
  return { readme, md };
})();

console.log('输出目录:', path.relative(ROOT, OUT_DIR));
for (const m of manifest) console.log(`  ${m.slug.padEnd(18)} 图 ${String(m.figs).padStart(2)}  正文 ${(m.size / 1024).toFixed(1)} KB`);
console.log(`  合计 ${manifest.length} 页 / ${totalFig} 张 SVG`);
console.log('  校验：index.html 已生成 =', fs.existsSync(path.join(OUT_DIR, 'index.html')));
