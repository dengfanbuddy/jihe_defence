/**
 * 打印预制件的节点树（名称 / 激活 / 渲染组件），用于核对渲染顺序与层级。
 * 用法： node tools/analysis/prefab-tree.mjs <prefab> [最大深度]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = process.argv[2];
const maxDepth = Number(process.argv[3] ?? 99);
const doc = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
const arr = Array.isArray(doc) ? doc : doc.data ?? doc;
const byId = new Map(arr.map((o, i) => [i, o]));
const der = (v) => (v && typeof v === 'object' && v.__id__ !== undefined ? byId.get(v.__id__) : v);
const idOf = (v) => (v && typeof v === 'object' && v.__id__ !== undefined ? v.__id__ : -1);

const prefab = arr.find((o) => o?.__type__ === 'cc.Prefab');
const rootId = prefab ? idOf(prefab.data) : arr.findIndex((o) => o?.__type__ === 'cc.Node');

const RENDER = /^(cc\.(Sprite|Label|Graphics|Mask|RichText|MotionStreak|ParticleSystem2D|UIMeshRenderer)|sp\.Skeleton)$/;
function dump(id, depth) {
    const n = byId.get(id);
    if (!n) return;
    const comps = (n._components ?? []).map((c) => der(c)).filter(Boolean).map((c) => c.__type__);
    const off = n._active === false ? '  [inactive]' : '';
    console.log(`${'  '.repeat(depth)}${n._name}${off}${comps.length ? '  {' + comps.map((c) => c.replace('cc.', '')).join(', ') + '}' : ''}`);
    if (depth >= maxDepth) return;
    for (const c of n._children ?? []) dump(idOf(c), depth + 1);
}
dump(rootId, 0);
