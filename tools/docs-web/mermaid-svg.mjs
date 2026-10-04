/**
 * mermaid-svg.mjs —— 零依赖的 mermaid 子集 → 静态 SVG 渲染器
 *
 * 覆盖范围 = 本项目 `docs/platform-guide/*.md` 里**真实出现过**的语法
 * （用 tools/docs-web/analyze-mermaid.mjs 统计：40 张 flowchart / 16 张 sequenceDiagram / 7 张 stateDiagram-v2）：
 *   · flowchart TD|TB|LR|RL ：`A["标签"]`、`A{"标签"}`、裸 id、`<br/>`、
 *     `A --> B`、`A -- 文本 --> B`、`A -->|文本| B`、自环
 *   · sequenceDiagram       ：`participant X as 别名`、`A->>B: 文本`、`A-->>B: 文本`、
 *     `Note over/right of/left of A[,B]: 文本`、`alt/else/opt/... end`、`autonumber`
 *   · stateDiagram-v2       ：`[*]`（按左右操作数区分 start/end）、CJK 状态名、`A --> B: 文本`、
 *     `note right of X ... end note`、自环
 *
 * 输出为纯静态 SVG：无 JS、无外部资源、可 file:// 用 <img> 引用，也可直接内联进 HTML。
 * 布局是自写的分层算法（flowchart）与生命线算法（sequence），目标是**正确 + 可读 + 可打印**，
 * 不追求 mermaid 的交叉最小化最优解。
 */

const CJK = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\u2010-\u203B\u2190-\u21FF\u2500-\u257F]/;
const NARROW = /[iIl1.,:;'|!()\[\]{} ]/;

/** 与页面一致的字体栈：写进 <svg> 根节点，保证「我量的宽度」和「浏览器画的宽度」尽量一致 */
const FONT = "system-ui,-apple-system,'Segoe UI','Noto Sans SC','Microsoft YaHei',sans-serif";
const FONT_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
/** 测量值的安全系数：不同字体渲染宽度有 ±5% 波动，宁可留白也不让字溢出盒子 */
const SLACK = 1.06;

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plain(s) {
  return String(s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function charW(ch, fs) {
  if (CJK.test(ch)) return fs;
  if (NARROW.test(ch)) return fs * 0.35;
  return fs * 0.56;
}
function textW(s, fs) {
  let w = 0;
  for (const ch of s) w += charW(ch, fs);
  return w * SLACK;
}
/** 按像素宽度折行（CJK 逐字断，ASCII 尽量在分隔符后断） */
function wrap(text, maxWidth, fs) {
  const out = [];
  for (const seg of String(text).split(/<br\s*\/?>/i)) {
    const chars = [...seg];
    let cur = '';
    let w = 0;
    let brk = -1;
    for (const ch of chars) {
      const cw = charW(ch, fs);
      if (w + cw > maxWidth && cur.length) {
        const cut = brk > 0 && cur.length - brk <= 10 ? brk + 1 : cur.length;
        out.push(cur.slice(0, cut).trim());
        cur = cur.slice(cut);
        w = textW(cur, fs);
        brk = -1;
      }
      cur += ch;
      w += cw;
      if (/[ ,/·→←：:，、)】」|]/.test(ch)) brk = cur.length - 1;
    }
    out.push(cur.trim());
  }
  const r = out.filter((l) => l !== '');
  return r.length ? r : [''];
}

const rnd = () => Math.random().toString(36).slice(2, 8);

// ══════════════════════════════ 图解析（flowchart / state） ══════════════════════════════

const ID = '[^\\s\\[\\]{}"]+';

function parseNodeToken(tok, role) {
  const t = String(tok).trim();
  if (/^\[\*\]$/.test(t)) return { id: role === 'left' ? '\u0000start' : '\u0000end', label: '', shape: 'endpoint' };
  let m;
  if ((m = t.match(new RegExp(`^(${ID})\\s*\\[\\s*"([\\s\\S]*)"\\s*\\]$`))) && !m[2].includes('-->')) return { id: m[1], label: m[2], shape: 'rect' };
  if ((m = t.match(new RegExp(`^(${ID})\\s*\\{\\s*"([\\s\\S]*)"\\s*\\}$`))) && !m[2].includes('-->')) return { id: m[1], label: m[2], shape: 'diamond' };
  if ((m = t.match(new RegExp(`^(${ID})\\s*\\{\\s*([\\s\\S]*?)\\s*\\}$`))) && !m[2].includes('-->')) return { id: m[1], label: m[2], shape: 'diamond' };
  if ((m = t.match(new RegExp(`^(${ID})\\s*\\[\\s*([\\s\\S]*?)\\s*\\]$`))) && !m[2].includes('-->')) return { id: m[1], label: m[2], shape: 'rect' };
  if ((m = t.match(new RegExp(`^(${ID})$`)))) return { id: m[1], label: null, shape: 'rect' };
  return null;
}

function parseGraph(src, { state = false } = {}) {
  const nodes = new Map();
  const edges = [];
  const notes = [];
  let direction = 'TD';
  const lines = src.split(/\r?\n/);

  const touch = (ref) => {
    if (!ref) return null;
    const cur = nodes.get(ref.id);
    if (!cur) nodes.set(ref.id, { id: ref.id, label: ref.label, shape: ref.shape, order: nodes.size });
    else {
      if (cur.label == null && ref.label != null) cur.label = ref.label;
      if (ref.shape) cur.shape = ref.shape;
    }
    return ref.id;
  };
  const edge = (left, right, label, dashed) => {
    const a = parseNodeToken(left, 'left');
    const b = parseNodeToken(right, 'right');
    if (!a || !b) return false;
    touch(a); touch(b);
    edges.push({ from: a.id, to: b.id, label: label || '', dashed: !!dashed });
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const t = line.trim();
    if (!t || /^%%/.test(t)) continue;
    if (/^(flowchart|graph)\b/i.test(t)) {
      const d = (t.split(/\s+/)[1] || 'TD').toUpperCase();
      direction = /^(LR|RL|BT|TD|TB)$/.test(d) ? (d === 'TB' ? 'TD' : d) : 'TD';
      continue;
    }
    if (/^stateDiagram/i.test(t)) continue;
    if (/^direction\b/i.test(t)) { direction = t.split(/\s+/)[1] || direction; continue; }

    const noteStart = t.match(/^note\s+(right of|left of|over)\s+(.+)$/i);
    if (noteStart) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*end note\s*$/i.test(lines[i])) { body.push(lines[i].trim()); i++; }
      notes.push({ side: noteStart[1].toLowerCase(), target: noteStart[2].trim(), text: body.join('\n') });
      continue;
    }
    if (/^end note$/i.test(t)) continue;

    let m;
    // ① A -- 文本 --> B（两端都要有空白，mermaid 的旧式写法）
    if ((m = t.match(/^(.+?)\s+--\s+(.+?)\s+-->\s*(.+)$/))) { if (edge(m[1], m[3], plain(m[2]))) continue; }
    // ② A -->|文本| B（注意：mermaid 里 `-->` 与 `|` 之间**通常没有空格**，必须 \s*）
    if ((m = t.match(/^(.+?)\s*(-->|---|-\.->|==>)\s*\|([^|]*)\|\s*(.+)$/))) { if (edge(m[1], m[4], plain(m[3]), m[2] === '-.->')) continue; }
    // ③ stateDiagram 的 A --> B: 文本
    if ((m = t.match(/^(.+?)\s+(-->|---|-\.->|==>|~~~)\s+(.+?)\s*:\s*(.+)$/))) { if (edge(m[1], m[3], plain(m[4]), m[2] === '-.->')) continue; }
    // ④ 裸边 A --> B
    if ((m = t.match(/^(.+?)\s*(-->|---|-\.->|==>|~~~)\s*(.+)$/))) { if (edge(m[1], m[3], '', m[2] === '-.->')) continue; }

    const solo = parseNodeToken(t, 'left');
    if (solo) touch(solo);
  }

  for (const n of nodes.values()) {
    if (n.shape === 'endpoint') n.label = '';
    else if (n.label == null) n.label = n.id;
  }
  return { nodes: [...nodes.values()], edges, notes, direction, state };
}

// ══════════════════════════════ flowchart 布局与出图 ══════════════════════════════

const FS = 13, FS_EDGE = 11.5, LINE_H = 17, PAD_X = 13;
const GAP_CROSS = 30, GAP_MAIN = 46, M = 22;

function layoutGraph(g) {
  const nodes = g.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const LR = g.direction === 'LR' || g.direction === 'RL';

  // ① 尺寸（自然宽高，不随方向变）
  for (const n of nodes) {
    if (n.shape === 'endpoint') { n.w = 20; n.h = 20; n.lines = []; continue; }
    n.lines = wrap(n.label, LR ? 200 : 250, FS);
    const tw = Math.max(...n.lines.map((l) => textW(l, FS)), 54);
    n.h = n.lines.length * LINE_H + 18;
    if (n.shape === 'diamond') { n.w = tw + 44; n.h = n.h + 22; }
    else n.w = tw + PAD_X * 2;
  }

  // ② 断环
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of g.edges) if (out.has(e.from)) out.get(e.from).push(e);
  const color = new Map();
  const back = new Set();
  const dfs = (id) => {
    color.set(id, 1);
    for (const e of out.get(id) || []) {
      const c = color.get(e.to) || 0;
      if (c === 1) back.add(e);
      else if (c === 0 && byId.has(e.to)) dfs(e.to);
    }
    color.set(id, 2);
  };
  for (const n of nodes) if (!color.get(n.id)) dfs(n.id);

  // ③ 分层：DAG 上最长路径
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (!back.has(e) && e.from !== e.to && indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set();
  while (q.length) {
    const id = q.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) {
      if (back.has(e) || e.from !== id || e.to === id || !byId.has(e.to)) continue;
      layer.set(e.to, Math.max(layer.get(e.to) || 0, (layer.get(id) || 0) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) <= 0) q.push(e.to);
    }
  }
  // 环内/未覆盖的节点：接在最后一层之后（按出现顺序）
  const uncovered = nodes.filter((n) => !seen.has(n.id));
  if (uncovered.length) {
    const base = Math.max(0, ...[...seen].map((id) => layer.get(id) || 0)) + 1;
    uncovered.forEach((n, i) => layer.set(n.id, base + i));
  }

  const layers = new Map();
  for (const n of nodes) {
    const l = layer.get(n.id) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(n);
  }
  const keys = [...layers.keys()].sort((a, b) => a - b);

  // ④ 层内排序（重心法，4 轮）
  const pos = new Map();
  keys.forEach((k) => layers.get(k).forEach((n, i) => pos.set(n.id, i)));
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    for (const k of keys) {
      const arr = layers.get(k);
      const bary = (n) => {
        const idxs = g.edges
          .filter((e) => (down ? e.to === n.id : e.from === n.id))
          .map((e) => pos.get(down ? e.from : e.to))
          .filter((v) => v != null);
        return idxs.length ? idxs.reduce((a, b) => a + b, 0) / idxs.length : pos.get(n.id);
      };
      arr.sort((a, b) => bary(a) - bary(b) || a.order - b.order);
      arr.forEach((n, i) => pos.set(n.id, i));
    }
  }

  // ⑤ 坐标：main = 层方向（TD 的 y / LR 的 x），cross = 层内方向
  const crossOf = (n) => (LR ? n.h : n.w);
  let mainCursor = 0;
  keys.forEach((k) => {
    const arr = layers.get(k);
    const totalCross = arr.reduce((s, n) => s + crossOf(n), 0) + GAP_CROSS * (arr.length - 1);
    let c = 0;
    for (const n of arr) {
      n._cross = c + crossOf(n) / 2;
      c += crossOf(n) + GAP_CROSS;
    }
    arr[0]._rowCross = totalCross;
    arr[0]._rowMain = Math.max(...arr.map((n2) => (LR ? n2.w : n2.h)));
    for (const n2 of arr) { n2._main = mainCursor + arr[0]._rowMain / 2; }
    mainCursor += arr[0]._rowMain + GAP_MAIN;
  });
  const maxCross = Math.max(...keys.map((k) => layers.get(k)[0]._rowCross), 60);
  for (const k of keys) {
    const arr = layers.get(k);
    const shift = (maxCross - arr[0]._rowCross) / 2;
    for (const n of arr) n._cross += shift;
  }
  const totalMain = mainCursor - GAP_MAIN;

  const boxOf = (n) => {
    const cx = LR ? n._main : n._cross;
    const cy = LR ? n._cross : n._main;
    return { cx, cy, x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h };
  };
  const W = (LR ? totalMain : maxCross) + M * 2;
  const H = (LR ? maxCross : totalMain) + M * 2;
  return { byId, keys, layers, boxOf, W, H, LR, shift: M };
}

function renderFlowchart(g) {
  const L = layoutGraph(g);
  const { byId, boxOf, LR } = L;
  const S = M;
  const at = (n) => { const b = boxOf(n); return { ...b, cx: b.cx + S, cy: b.cy + S, x: b.x + S, y: b.y + S }; };
  const uid = 'f' + rnd();
  const arrow = `a-${uid}`;
  const head = `<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b6470"/></marker></defs>`;

  const edgesSvg = [];
  const labelsSvg = [];
  const selfCount = new Map();
  const addLabel = (x, y, text, anchor = 'middle') => {
    const lines = wrap(text, 140, FS_EDGE);
    const w = Math.max(...lines.map((l) => textW(l, FS_EDGE))) + 10;
    const h = lines.length * 14 + 4;
    const rx = anchor === 'middle' ? x - w / 2 : x;
    const tx = anchor === 'middle' ? x : rx + 5;
    labelsSvg.push(
      `<g><rect x="${rx.toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="4" fill="#f6f8f9" opacity="0.95"/>`
      + lines.map((l, i) => `<text x="${tx.toFixed(1)}" y="${(y + 4 + i * 13).toFixed(1)}" font-size="${FS_EDGE}" fill="#4a5560" text-anchor="${anchor}" font-family="ui-monospace,Consolas,monospace">${esc(l)}</text>`).join('')
      + `</g>`);
  };

  for (const e of g.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const A = at(a), B = at(b);
    const dash = e.dashed ? ' stroke-dasharray="5 4"' : '';
    const stroke = '#5b6470';
    if (e.from === e.to) {
      const k = selfCount.get(e.from) || 0;
      selfCount.set(e.from, k + 1);
      const r = 26 + k * 16;
      const x0 = A.x + A.w, y0 = A.cy - A.h * 0.2;
      edgesSvg.push(`<path d="M${x0},${y0} C${x0 + r},${y0 - r} ${x0 + r},${y0 + r} ${x0},${y0 + A.h * 0.34}" fill="none" stroke="${stroke}" stroke-width="1.3" marker-end="url(#${arrow})"${dash}/>`);
      if (e.label) addLabel(x0 + r + 6, y0, e.label, 'start');
      continue;
    }
    const forwardMain = (LR ? B.cx >= A.cx : B.cy >= A.cy);
    let d, lx, ly;
    if (LR) {
      const x1 = A.x + A.w, x2 = B.x;
      const y1 = A.cy, y2 = B.cy;
      const dx = Math.max(18, (x2 - x1) * 0.5);
      d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      lx = (x1 + x2) / 2; ly = (y1 + y2) / 2;
    } else {
      const y1 = forwardMain ? A.y + A.h : A.y;
      const y2 = forwardMain ? B.y : B.y + B.h;
      const x1 = A.cx, x2 = B.cx;
      const dy = (y2 - y1) * 0.5;
      d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
      lx = (x1 + x2) / 2; ly = (y1 + y2) / 2;
    }
    edgesSvg.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.3" marker-end="url(#${arrow})"${dash}/>`);
    if (e.label) addLabel(lx, ly, e.label);
  }

  const nodesSvg = [];
  for (const n of g.nodes) {
    const b = at(n);
    if (n.shape === 'endpoint') { nodesSvg.push(`<circle cx="${b.cx}" cy="${b.cy}" r="10" fill="#39424d"/>`); continue; }
    const fill = n.shape === 'diamond' ? '#fdf5e3' : (g.state ? '#edf3fa' : '#f3f7f4');
    const stroke = n.shape === 'diamond' ? '#c9a227' : (g.state ? '#7d9fc4' : '#87a596');
    const rx = g.state ? 15 : 7;
    if (n.shape === 'diamond') nodesSvg.push(`<polygon points="${b.cx},${b.y} ${b.x + b.w},${b.cy} ${b.cx},${b.y + b.h} ${b.x},${b.cy}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`);
    else nodesSvg.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`);
    const lines = n.lines || [];
    const y0 = b.cy - ((lines.length - 1) * LINE_H) / 2 + 4.6;
    nodesSvg.push(`<g>${lines.map((l, i) => {
      const lw = textW(l, FS);
      const x = b.cx - lw / 2;
      return `<text x="${x.toFixed(1)}" y="${(y0 + i * LINE_H).toFixed(1)}" font-size="${FS}" fill="#2b3138">${esc(l)}</text>`;
    }).join('')}</g>`);
  }

  // note（stateDiagram）
  const notesSvg = [];
  let extraW = 0;
  for (const note of g.notes) {
    const target = byId.get(note.target.split(',')[0].trim());
    const lines = [];
    for (const seg of note.text.split('\n')) lines.push(...wrap(seg, 340, 12));
    const w = Math.max(...lines.map((l) => textW(l, 12)), 100) + 26;
    const h = lines.length * 16 + 22;
    const cy = target ? at(target).cy : M + h / 2;
    const x = L.W + 24 + extraW;
    notesSvg.push(`<g><rect x="${x}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="7" fill="#fffcf0" stroke="#d9c98a" stroke-width="1.2"/>`
      + `<path d="M${x + 14},${(cy - h / 2).toFixed(1)} l16,0 l-16,16 z" fill="#e8dcae"/>`
      + lines.map((l, i) => `<text x="${x + 14}" y="${(cy - h / 2 + 28 + i * 16).toFixed(1)}" font-size="12" fill="#5c5433">${esc(l)}</text>`).join('') + `</g>`);
    if (target) {
      const A = at(target);
      notesSvg.push(`<path d="M${(A.x + A.w).toFixed(1)},${cy.toFixed(1)} L${x},${cy.toFixed(1)}" stroke="#d9c98a" stroke-dasharray="4 3" fill="none"/>`);
    }
    extraW += w + 22;
  }

  const W = Math.round(L.W + extraW);
  const H = Math.round(L.H);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="diagram" font-family="${FONT}">`
    + head
    + `<g class="edges">${edgesSvg.join('')}</g>`
    + `<g class="nodes">${nodesSvg.join('')}</g>`
    + `<g class="edge-labels">${labelsSvg.join('')}</g>`
    + `<g class="notes">${notesSvg.join('')}</g>`
    + `</svg>`;
  return { svg, width: W, height: H };
}

// ══════════════════════════════ sequenceDiagram ══════════════════════════════

function parseSequence(src) {
  const actors = [];
  const idx = (name) => {
    let i = actors.findIndex((a) => a.id === name);
    if (i < 0) { actors.push({ id: name, alias: name }); i = actors.length - 1; }
    return i;
  };
  const steps = [];
  let autonumber = false;
  for (const raw of src.split(/\r?\n/)) {
    const t = raw.trim().replace(/;$/, '');
    if (!t || /^%%/.test(t)) continue;
    if (/^sequenceDiagram/i.test(t)) { if (/autonumber/i.test(t)) autonumber = true; continue; }
    if (/^autonumber/i.test(t)) { autonumber = true; continue; }
    let m;
    if ((m = t.match(/^(?:participant|actor)\s+(\S+)\s+as\s+(.+)$/i))) { idx(m[1].trim()); actors.find((a) => a.id === m[1].trim()).alias = plain(m[2]); continue; }
    if ((m = t.match(/^(?:participant|actor)\s+(\S+)$/i))) { idx(m[1].trim()); continue; }
    if ((m = t.match(/^Note\s+(over|right of|left of)\s+([^:]+):\s*(.+)$/i))) {
      steps.push({ type: 'note', side: m[1].toLowerCase(), actors: m[2].split(',').map((s) => idx(s.trim())), text: m[3] });
      continue;
    }
    if ((m = t.match(/^(alt|else|opt|loop|par|critical|break)\b\s*(.*)$/i))) { steps.push({ type: 'block', kind: m[1].toLowerCase(), label: plain(m[2] || '') }); continue; }
    if (/^end$/i.test(t)) { steps.push({ type: 'endblock' }); continue; }
    if ((m = t.match(/^(.+?)\s*(-->>|->>|-->|->|--x|-x)\s*(.+?)\s*:\s*(.*)$/))) {
      steps.push({ type: 'msg', from: idx(m[1].trim()), to: idx(m[3].trim()), text: plain(m[4]), dashed: m[2].startsWith('--') });
      continue;
    }
    if ((m = t.match(/^(.+?)\s*(-->>|->>|-->|->)\s*(.+)$/))) {
      steps.push({ type: 'msg', from: idx(m[1].trim()), to: idx(m[3].trim()), text: '', dashed: m[2].startsWith('--') });
      continue;
    }
  }
  return { actors, steps, autonumber };
}

function renderSequence(src) {
  const { actors, steps, autonumber } = parseSequence(src);
  const F_A = 13, F_M = 12.5, F_N = 12;
  const TOP = 16, HEAD_H = 30, GAP = 40, M = 26, MSG_GAP = 30;
  if (!actors.length) return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"></svg>', width: 200, height: 40 };

  for (const a of actors) {
    a.lines = wrap(a.alias, 190, F_A);
    a.w = Math.max(...a.lines.map((l) => textW(l, F_A)), 64) + 28;
    a.h = HEAD_H;
  }
  let no = 0;
  for (const s of steps) {
    if (s.type === 'msg') {
      s.lines = s.text ? wrap(s.text, 300, F_M) : [''];
      if (autonumber) s.no = ++no;
    }
    if (s.type === 'note') {
      s.lines = [];
      for (const seg of s.text.split(/<br\s*\/?>/i)) s.lines.push(...wrap(seg, 340, F_N));
    }
  }

  const actorsW = actors.reduce((s, a) => s + a.w, 0) + GAP * (actors.length - 1);
  let need = 0;
  for (const s of steps) {
    if (s.type === 'msg' && s.lines) need = Math.max(need, Math.max(...s.lines.map((l) => textW(l, F_M))) + 70);
    if (s.type === 'note' && s.lines) need = Math.max(need, Math.max(...s.lines.map((l) => textW(l, F_N))) + 70);
    if (s.type === 'block' && s.label) need = Math.max(need, textW(s.kind + ' ' + s.label, 11.5) + 70);
  }
  const W = Math.max(actorsW, need) + M * 2;

  const free = W - M * 2 - actors.reduce((s, a) => s + a.w, 0);
  const step = actors.length > 1 ? free / (actors.length - 1) : 0;
  let cur = M;
  for (const a of actors) { a.x = actors.length > 1 ? cur + a.w / 2 : W / 2; cur += a.w + step; }

  // 竖向排布 + 块范围（按步骤下标记录，等 x 算完再解析）
  let y = TOP + HEAD_H + 16;
  const items = [];
  const stack = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'block') { const frame = { top: y, startIdx: i, kind: s.kind, label: s.label }; stack.push(frame); items.push({ kind: 'blockstart', frame }); y += 34; continue; }
    if (s.type === 'endblock') { const f = stack.pop(); if (f) { f.bottom = y + 6; f.endIdx = i; items.push({ kind: 'blockend', frame: f }); y += 18; } continue; }
    if (s.type === 'msg') { s.y = y; items.push({ kind: 'msg', step: s }); y += MSG_GAP + (s.lines.length - 1) * 15; continue; }
    if (s.type === 'note') {
      const xs = s.actors.map((k) => actors[k] && actors[k].x).filter((v) => v != null);
      const from = Math.min(...xs), to = Math.max(...xs);
      const w = Math.max(...s.lines.map((l) => textW(l, F_N)), 90) + 26;
      const h = s.lines.length * 16 + 18;
      let x;
      if (s.actors.length > 1 || s.side === 'over') x = (from + to) / 2 - w / 2;
      else if (s.side === 'right of') x = from + 18;
      else x = from - 18 - w;
      x = Math.max(6, Math.min(W - w - 6, x));
      items.push({ kind: 'note', s, x, y, w, h });
      y += h + 18;
      continue;
    }
  }
  const H = Math.round(y + (stack.length ? 30 : 14));

  // 块左右边界：只统计块内的消息参与者
  for (const it of items) {
    if (it.kind !== 'blockstart') continue;
    const f = it.frame;
    if (f.bottom == null) continue;
    let left = Infinity, right = -Infinity;
    for (let i = f.startIdx; i <= f.endIdx; i++) {
      const s = steps[i];
      if (s && s.type === 'msg') for (const k of [s.from, s.to]) { const a = actors[k]; if (a) { left = Math.min(left, a.x - a.w / 2); right = Math.max(right, a.x + a.w / 2); } }
    }
    if (!Number.isFinite(left)) { left = M; right = W - M; }
    f.left = Math.max(6, left - 14);
    f.right = Math.min(W - 6, right + 14);
  }

  const uid = 's' + rnd();
  const arrow = `a-${uid}`;
  const parts = [`<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a5560"/></marker></defs>`];
  const lifeTop = TOP + HEAD_H;
  const lifeBottom = H - 14;

  // 块框背景
  for (const it of items) {
    if (it.kind !== 'blockstart' || it.frame.bottom == null) continue;
    const f = it.frame;
    parts.push(`<rect x="${f.left.toFixed(1)}" y="${f.top.toFixed(1)}" width="${(f.right - f.left).toFixed(1)}" height="${(f.bottom - f.top).toFixed(1)}" rx="7" fill="rgba(238,243,249,0.45)" stroke="#b9c6d4" stroke-width="1.2"/>`);
  }
  // 生命线
  for (const a of actors) parts.push(`<line x1="${a.x.toFixed(1)}" y1="${lifeTop}" x2="${a.x.toFixed(1)}" y2="${lifeBottom}" stroke="#c8d1da" stroke-dasharray="4 4" stroke-width="1"/>`);

  // 消息 / 备注
  for (const it of items) {
    if (it.kind === 'msg') {
      const s = it.step;
      const A = actors[s.from], B = actors[s.to];
      if (!A || !B) continue;
      const lines = s.lines.map((l, i) => (i === 0 && s.no ? `${s.no}. ${l}` : l));
      const lw = Math.max(...lines.map((l) => textW(l, F_M)));
      const dash = s.dashed ? ' stroke-dasharray="5 4"' : '';
      if (s.from === s.to) {
        const x = A.x, r = 36;
        parts.push(`<path d="M${x.toFixed(1)},${(s.y + 4).toFixed(1)} C${(x + r).toFixed(1)},${(s.y - 4).toFixed(1)} ${(x + r).toFixed(1)},${(s.y + 20).toFixed(1)} ${x.toFixed(1)},${(s.y + 18).toFixed(1)}" fill="none" stroke="#4a5560" stroke-width="1.3" marker-end="url(#${arrow})"${dash}/>`);
        parts.push(lines.map((l, i) => `<text x="${(x + r + 8).toFixed(1)}" y="${(s.y + 6 + i * 15).toFixed(1)}" font-size="${F_M}" fill="#333c45">${esc(l)}</text>`).join(''));
      } else {
        parts.push(`<line x1="${A.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${B.x.toFixed(1)}" y2="${s.y.toFixed(1)}" stroke="#4a5560" stroke-width="1.3" marker-end="url(#${arrow})"${dash}/>`);
        const cx = (A.x + B.x) / 2;
        const bh = lines.length * 15 + 2;
        parts.push(`<rect x="${(cx - lw / 2 - 5).toFixed(1)}" y="${(s.y - bh - 4).toFixed(1)}" width="${(lw + 10).toFixed(1)}" height="${bh}" rx="3" fill="#ffffff" opacity="0.93"/>`);
        parts.push(lines.map((l, i) => `<text x="${cx.toFixed(1)}" y="${(s.y - 8 - (lines.length - 1 - i) * 15).toFixed(1)}" font-size="${F_M}" fill="#333c45" text-anchor="middle">${esc(l)}</text>`).join(''));
      }
      continue;
    }
    if (it.kind === 'note') {
      const s = it.s;
      parts.push(`<g><rect x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" width="${it.w.toFixed(1)}" height="${it.h.toFixed(1)}" rx="7" fill="#fffcf0" stroke="#d9c98a" stroke-width="1.2"/>`
        + `<path d="M${(it.x + 14).toFixed(1)},${it.y.toFixed(1)} l15,0 l-15,15 z" fill="#e8dcae"/>`
        + s.lines.map((l, i) => `<text x="${(it.x + 14).toFixed(1)}" y="${(it.y + 28 + i * 16).toFixed(1)}" font-size="${F_N}" fill="#5c5433">${esc(l)}</text>`).join('') + `</g>`);
      if (s.actors.length === 1) {
        const a = actors[s.actors[0]];
        if (a) {
          const edgeX = s.side === 'left of' ? it.x + it.w : it.x;
          const yy = it.y + 13;
          parts.push(`<line x1="${edgeX.toFixed(1)}" y1="${yy.toFixed(1)}" x2="${a.x.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#d9c98a" stroke-dasharray="4 3"/>`);
        }
      }
    }
  }

  // 参与者盒子
  for (const a of actors) {
    parts.push(`<g><rect x="${(a.x - a.w / 2).toFixed(1)}" y="${TOP}" width="${a.w.toFixed(1)}" height="${a.h}" rx="7" fill="#eef4fb" stroke="#8fb0cd" stroke-width="1.3"/>`
      + a.lines.map((l, i) => `<text x="${a.x.toFixed(1)}" y="${(TOP + 20 + i * 16).toFixed(1)}" font-size="${F_A}" fill="#26405a" text-anchor="middle">${esc(l)}</text>`).join('') + `</g>`);
  }

  // 块标签（压在最上）
  for (const it of items) {
    if (it.kind !== 'blockstart' || it.frame.bottom == null) continue;
    const f = it.frame;
    const text = f.kind + (f.label ? ' ' + f.label : '');
    const tabW = Math.min(240, Math.max(46, textW(text, 11.5) + 16));
    parts.push(`<g><path d="M${f.left.toFixed(1)},${(f.top + 20).toFixed(1)} h${tabW.toFixed(1)} v-20 h-${tabW.toFixed(1)} z" fill="#eef3f9" stroke="#b9c6d4" stroke-width="1.2"/>`
      + `<text x="${(f.left + 8).toFixed(1)}" y="${(f.top + 14.5).toFixed(1)}" font-size="11.5" fill="#41576e" font-family="ui-monospace,Consolas,monospace">${esc(text)}</text></g>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(W)} ${H}" width="${Math.round(W)}" height="${H}" role="img" aria-label="sequence diagram" font-family="${FONT}">${parts.join('')}</svg>`;
  return { svg, width: Math.round(W), height: H };
}

// ══════════════════════════════ 入口 ══════════════════════════════

export function renderMermaid(src) {
  const first = src.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('%%')) || '';
  if (/^sequenceDiagram/i.test(first)) return renderSequence(src);
  if (/^stateDiagram/i.test(first)) return renderFlowchart(parseGraph(src, { state: true }));
  return renderFlowchart(parseGraph(src));
}
