/**
 * 静态合批估算：按**渲染顺序（节点树 DFS）**走一遍预制件，估算 draw call 数量并拆账。
 *
 * 依据（Cocos Creator 3.8 引擎源码 cocos/2d/renderer/batcher-2d.ts）：
 *   · 合批 = **相邻**两次提交的 texture / material / blend / layer 全部相同
 *     （`autoMergeBatches` 只在提交时收尾当前这一段，**不会回头**找更早的同贴图批次）；
 *   · Label（TTF，cacheMode = NONE）= **每个 Label 一张自己的 canvas 贴图**
 *     （label.ts 的 `_ttfSpriteFrame`）⇒ 每个 Label 恒定 1 个 draw call，且会切断前后 Sprite 的合批；
 *     只有 cacheMode = BITMAP / CHAR 的 Label 才可能与他人合批；
 *   · Mask 走模板缓冲，进出各插一个 batch；
 *   · Graphics / MotionStreak 各自独立提交。
 *
 * ⚠ 这是**静态**估算：只看预制件默认的 `_active` 状态，运行时的显隐/换图不算在内。
 *   反过来，它是"把界面全打开会花多少 DC"的上界，用来找大头足够。
 *
 * 用法： node tools/analysis/dc-scan.mjs <prefab> [--all]
 *        --all：连未激活节点一起算（默认只算激活子树）
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function buildUuidMap(dir, out = new Map()) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { buildUuidMap(p, out); continue; }
        if (!ent.name.endsWith('.meta')) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        const asset = path.relative(root, p.slice(0, -5)).replace(/\\/g, '/');
        if (meta.uuid) out.set(meta.uuid, asset);
        for (const [key, sub] of Object.entries(meta.subMetas ?? {})) {
            if (sub?.uuid) out.set(sub.uuid, asset + '#' + key);
        }
    }
    return out;
}

const uuidMap = buildUuidMap(path.join(root, 'assets'));
/** uuid（去掉 @sub）→ 资源路径；同一张图集里的多张 spriteFrame 归到同一个 base uuid = 同一张贴图 */
function texOf(uuid) {
    if (!uuid) return '(none)';
    const base = uuid.split('@')[0];
    return uuidMap.get(base) ?? uuidMap.get(uuid) ?? uuid;
}

const target = process.argv[2];
const includeInactive = process.argv.includes('--all');
if (!target) { console.error('用法: node tools/analysis/dc-scan.mjs <prefab> [--all]'); process.exit(1); }

const doc = JSON.parse(fs.readFileSync(path.resolve(root, target), 'utf8'));
const arr = Array.isArray(doc) ? doc : doc.data ?? doc;
// 序列化格式里 `__id__` 就是**数组下标**（对象自身不带 __id__ 字段）
const byId = new Map();
arr.forEach((o, i) => { if (o) byId.set(i, o); });
const deref = (v) => (v && typeof v === 'object' && v.__id__ !== undefined ? byId.get(v.__id__) : v);
const idOf = (v) => (v && typeof v === 'object' && v.__id__ !== undefined ? v.__id__ : -1);

const prefabObj = arr.find((o) => o?.__type__ === 'cc.Prefab');
const rootId = prefabObj ? idOf(prefabObj.data) : arr.findIndex((o) => o?.__type__ === 'cc.Node');
const nodeName = (id) => byId.get(id)?._name ?? '?';

const RENDER_TYPES = new Set(['cc.Sprite', 'cc.Label', 'cc.Graphics', 'cc.Mask', 'cc.RichText',
    'cc.ParticleSystem2D', 'cc.MotionStreak', 'cc.UIMeshRenderer', 'sp.Skeleton']);

/** 空文本 Label / 没图 Sprite 在引擎里 `renderData.isValid() === false` → `commitComp` 直接 return，不占 DC */
function drawsNothing(comp) {
    if (comp.__type__ === 'cc.Label') return !comp._string;
    if (comp.__type__ === 'cc.Sprite') return !comp._spriteFrame?.__uuid__;
    return false;
}

const counts = new Map();
function keyOf(comp, nodeId) {
    const t = comp.__type__;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (t === 'cc.Sprite') {
        const sf = comp._spriteFrame?.__uuid__;
        const mat = comp._customMaterial?.__uuid__ ?? '';
        return `sprite|${texOf(sf)}|${mat}`;
    }
    if (t === 'cc.Label') {
        const cm = comp._cacheMode ?? 0;           // 0 NONE / 1 BITMAP / 2 CHAR
        const font = comp._font?.__uuid__ ?? comp._fontFamily ?? '';
        if (cm === 2) return `label-char|${font}`; // 共享字模图集 → 可合批
        if (cm === 1) return `label-bitmap|${font}`;
        return `label|${nodeId}`;                  // 独占 canvas 贴图 → 恒 1 DC
    }
    if (t === 'cc.Mask') return `mask|${nodeId}`;
    return `${t}|${nodeId}`;
}

const rows = [];
let lastKey = null;
let batches = 0;
function walk(nodeId, active, parentPath = '') {
    const node = byId.get(nodeId);
    if (!node) return;
    const on = active && node._active !== false;
    if (!on && !includeInactive) return;
    const here = parentPath ? `${parentPath}/${node._name ?? '?'}` : (node._name ?? '?');
    for (const cref of node._components ?? []) {
        const comp = deref(cref);
        if (!comp || !RENDER_TYPES.has(comp.__type__)) continue;
        if (drawsNothing(comp)) continue;
        const k = keyOf(comp, nodeId);
        const isNew = k !== lastKey;
        if (isNew) batches++;
        lastKey = k;
        rows.push({ nodeId, name: node._name ?? '?', path: here, type: comp.__type__, key: k, isNew });
    }
    for (const cref of node._children ?? []) walk(idOf(cref), on, here);
}
walk(rootId, true);

console.log('== ' + target + (includeInactive ? '（含未激活）' : '（只算激活子树）'));
console.log('渲染组件：', Object.fromEntries([...counts.entries()].map(([k, v]) => [k.replace('cc.', ''), v])));
console.log('估算 draw call（按 DFS 渲染顺序合批）：', batches, ' / 提交数：', rows.length);

if (process.argv.includes('--list')) {
    console.log('\n-- 全部提交（DC 序号 = 打断合批的那次）--');
    let n = 0;
    for (const r of rows) {
        if (r.isNew) n++;
        console.log(`  ${r.isNew ? String(n).padStart(3) : '  ·'}  ${r.type.replace('cc.', '').padEnd(12)} ${r.path.padEnd(52)} ${r.key.replace('sprite|', '').slice(0, 70)}`);
    }
}

// ---- 按功能子树归并（跳过"只有单个孩子"的包装层） ----
let effRootId = rootId;
while ((byId.get(effRootId)?._children ?? []).length === 1) effRootId = idOf(byId.get(effRootId)._children[0]);
const groupOf = new Map();
function mark(nodeId, name, active) {
    const node = byId.get(nodeId);
    if (!node) return;
    const on = active && node._active !== false;
    if (!on && !includeInactive) return;
    groupOf.set(nodeId, name);
    for (const cref of node._children ?? []) mark(idOf(cref), name, on);
}
for (const cref of byId.get(effRootId)?._children ?? []) {
    const cid = idOf(cref);
    mark(cid, nodeName(cid), true);
}

const perGroup = new Map();
const perNodeName = new Map();
for (const r of rows) {
    const g = groupOf.get(r.nodeId) ?? '(root)';
    const e = perGroup.get(g) ?? { dc: 0, comps: 0 };
    e.comps++; if (r.isNew) e.dc++;
    perGroup.set(g, e);

    const key = `${r.name}  [${r.type.replace('cc.', '')}]`;
    const e2 = perNodeName.get(key) ?? { dc: 0, comps: 0 };
    e2.comps++; if (r.isNew) e2.dc++;
    perNodeName.set(key, e2);
}

console.log('\n-- 按功能子树拆账 --');
[...perGroup.entries()].sort((a, b) => b[1].dc - a[1].dc)
    .forEach(([k, v]) => console.log(`  ${String(v.dc).padStart(3)} DC / ${String(v.comps).padStart(3)} 组件   ${k}`));

console.log('\n-- 按节点名拆账（Top 20）--');
[...perNodeName.entries()].sort((a, b) => b[1].dc - a[1].dc).slice(0, 20)
    .forEach(([k, v]) => console.log(`  ${String(v.dc).padStart(3)} DC / ${String(v.comps).padStart(3)} 组件   ${k}`));

const same = rows.filter((r) => !r.isNew).length;
console.log(`\n可合批进上一批的提交：${same} / ${rows.length}`);
