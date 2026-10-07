#!/usr/bin/env node
/**
 * audit.mjs —— **UI 规范门禁**：某棵 UI 子树里，每个 Sprite/Label 的颜色与字号是不是都来自工程的 token 真源
 *
 * 回答的问题（一句话）：
 *   「`<prefab>` 里 `<root>` 这棵子树，**每个 `cc.Sprite` / `cc.Label` 的 `_color` 与 `_fontSize`
 *     是否都来自 `docs/art-style/tokens.json`**（色板 + 字号阶梯），且没有引用引擎内置贴图？」
 *
 * 为什么需要它：预制件是一份**序列化 JSON**（数组 + `{"__id__":n}` 引用），改版时最容易踩的四件事
 * 全都**不报任何错**、在编辑器里预览还完全正常：
 *   · 在取色器里随手点一个"差不多的灰" → 色板里没有它，风格就此漂移
 *     （浅底上 `#6A696B` 与 `#6B6B6B` 人眼分不出，但全工程会多出一种"野生灰"）；
 *   · 字号用了阶梯外的值（16 → 17）→ 字号体系里多出一条"孤值"；
 *   · `_lineHeight` 留着改版前字号时代的残值 → `overflow=NONE` 时节点高 = `lineHeight × 1.26`，
 *     框高虚高（做重叠/越界检查时失真）；
 *   · `_spriteFrame` 指向引擎内置 `default_ui`（uuid 前缀 `7d8f9b89`）→ 构建产物里混进引擎贴图。
 *
 * 判据真源**运行时现读**（本文件绝不硬编码色表 / 字号表）：
 *   · `docs/art-style/tokens.json` → `palette[].tokens[].hex`（色板）
 *   · `docs/art-style/tokens.json` → `typography.scale[].size`（字号阶梯；现读 = 40/24/20/16/14/12）
 *
 * 四条判据（对子树里的每个 `cc.Sprite` / `cc.Label` 逐条判）：
 *   P1 `_color` 的 `#RRGGBB`（大写）必须在色板里
 *   P2 `cc.Label._fontSize` 必须在字号阶梯上
 *   P3 `cc.Label._lineHeight` 只许是 `0`（引擎自动）/ `=== _fontSize` /
 *      `round(_fontSize × 1.5)`（多行正文 1.5 倍行距；实测 `ui_hero_detail/panel/skill/desc`
 *      就是 fs14/lh21，这是**有意**的，不许判它违规）
 *   P4 `cc.Sprite._spriteFrame.__uuid__` 不许以 `7d8f9b89` 开头
 *      （= `db://internal/default_ui/*`；本工程一律用自有 `textures/common/white_4x4`）
 *
 * 用法：
 *   node tools/ui-token-audit/audit.mjs
 *   node tools/ui-token-audit/audit.mjs --prefab <相对或绝对路径> --root <子树根节点名>
 *   node tools/ui-token-audit/audit.mjs --prefab <相对或绝对路径> --root-path <节点路径>
 *   node tools/ui-token-audit/audit.mjs --json          # 结构化结果（给别的脚本消费）
 *
 * `--root` 与 `--root-path` 二选一（同时给时以 `--root-path` 为准）：
 *   · `--root` 按**节点名**找，同名节点取数组下标最小的那个 —— 一份预制件里有两个 `outer_relics`
 *     （左侧菜单项 / 右侧页面）时就分不清了；
 *   · `--root-path` 按**节点路径**找（`Scene_Menu/content/right/outer_relics`，首段可省），
 *     每段必须是上一段的直接子节点，走错时报出"走到哪一段、该层有哪些子节点"。
 *
 * 退出码：全绿 `0` / 有违规 `1` / **跑不起来 `2`**
 * （预制件不存在、根节点找不到、真源读不到 —— 一律明确报错，**绝不静默通过**）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ===================================================================
 * 常量：判据真源与默认体检目标
 * =================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 工程根：`tools/ui-token-audit/` 往上两级 */
const PROJECT_ROOT = path.resolve(HERE, '../..');
/** 判据真源（运行时现读，只读不写） */
const TOKENS_PATH = path.join(PROJECT_ROOT, 'docs/art-style/tokens.json');
/** 默认体检对象：主界面预制件里的英雄详情弹窗子树 */
const DEFAULT_PREFAB = 'assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab';
const DEFAULT_ROOT = 'ui_hero_detail';
/** 引擎内置贴图的 uuid 前缀 = `db://internal/default_ui/*`；出现即违规 */
const ENGINE_BUILTIN_UUID_PREFIX = '7d8f9b89';
/** 多行正文的行距口径：`round(字号 × 1.5)` */
const LINE_HEIGHT_RATIO = 1.5;

/**
 * 退出码 2 = **门禁自己跑不起来**（不是"体检不通过"）。
 * 与"有违规（1）"严格区分：配置写错 / 路径写错必须让人看见，不能被当成"通过"。
 */
class GateError extends Error {}

/** 展示用相对路径（跨盘符时 `path.relative` 会给出绝对路径，照原样用） */
const relProject = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/') || '.';

/* ===================================================================
 * CLI
 * =================================================================== */

const USAGE = `UI 规范门禁（tokens.json 真源 × 真预制件子树）

用法：
  node tools/ui-token-audit/audit.mjs [--prefab <相对或绝对路径>] [--root <子树根节点名>] [--json]
  node tools/ui-token-audit/audit.mjs [--prefab <相对或绝对路径>] [--root-path <节点路径>] [--json]

参数：
  --prefab <路径>      被体检的预制件（默认 ${DEFAULT_PREFAB}）
  --root <节点名>      子树根节点名（默认 ${DEFAULT_ROOT}）；同名节点取数组下标最小的
  --root-path <路径>   子树根的**节点路径**（如 Scene_Menu/content/right/outer_relics；首段可省），
                       用来区分同名节点，优先于 --root
  --json               只打印结构化 JSON（给别的脚本消费）
  -h, --help           打印本用法

退出码：0 全绿 / 1 有违规 / 2 跑不起来（预制件不存在、根节点找不到、真源读不到）`;

/**
 * 解析 CLI 参数（支持 `--k v` 与 `--k=v` 两种写法）。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{prefab:string, root:string, rootPath:string, json:boolean, help:boolean}}
 */
function parseArgs(argv) {
    const out = { prefab: DEFAULT_PREFAB, root: DEFAULT_ROOT, rootPath: '', json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        const key = eq >= 0 ? arg.slice(0, eq) : arg;
        const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
        /** 取参数值：`--k=v` 直接给，`--k v` 往后吃一个（缺了就是用法错误） */
        const takeValue = () => {
            if (inlineValue !== null) return inlineValue;
            const next = argv[++i];
            if (next === undefined) throw new GateError(`参数 ${key} 缺一个值`);
            return next;
        };
        if (key === '--prefab') out.prefab = takeValue();
        else if (key === '--root') out.root = takeValue();
        else if (key === '--root-path') out.rootPath = takeValue();
        else if (key === '--json') out.json = true;
        else if (key === '-h' || key === '--help') out.help = true;
        else throw new GateError(`不认识的参数：${arg}（用 --help 看用法）`);
    }
    if (!out.root) throw new GateError('--root 不能是空字符串');
    return out;
}

/* ===================================================================
 * 判据真源：docs/art-style/tokens.json
 * =================================================================== */

/** `#aabbcc` / `aabbcc` / 带 alpha 的 `#aabbccdd` → 统一的 `#AABBCC`（判据只看 RGB） */
function normalizeHex(raw) {
    const h = String(raw ?? '').trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6,8}$/.test(h) ? '#' + h.slice(0, 6) : null;
}

/** `{r,g,b,a}`（0~255）→ `#RRGGBB`（大写）；字段不全则返回 null */
function hexOfColor(c) {
    if (!c || typeof c !== 'object') return null;
    const parts = [c.r, c.g, c.b];
    if (!parts.every((v) => Number.isFinite(v))) return null;
    return '#' + parts.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * 读判据真源。**现读**，任何一项读不出来都是退出码 2（拿不到判据就不该给结论）。
 *
 * 色板 = `palette[].tokens[].hex` **加上** `quality[].hex`。
 * 为什么必须带上 `quality`：那 4 个品质色（`#DDDDDD`/`#5096FF`/`#CF68FF`/`#FF6464`）也是
 * `tokens.json` 里的真源，而且**只允许出现在 UI 里**（品质不进出图，见 `docs/relic-icon/README.md` §2）。
 * 只读 `palette` 会把「遗物行的品质描边」「商店格子的品质框」全判成野生色 —— 那是门禁自己的漏，
 * 不是 UI 的错（2026-11 补：跑遗物图鉴子树时当场踩到，同色 `#DDDDDD` 被报 2 条违规）。
 * @returns {{path:string, palette:Map<string,string>, fontLadder:Set<number>, fontLadderSorted:number[]}}
 */
function loadTokens() {
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch (e) {
        throw new GateError(`读不到判据真源 ${relProject(TOKENS_PATH)}：${e.message}`);
    }
    /** 色板：`#RRGGBB` → token 名（报违规时能顺带告诉人"最接近的是哪个 token"） */
    const palette = new Map();
    for (const group of doc.palette ?? []) {
        for (const token of group.tokens ?? []) {
            const hex = normalizeHex(token.hex);
            if (hex && !palette.has(hex)) palette.set(hex, token.name ?? '(未命名)');
        }
    }
    for (const tier of doc.quality ?? []) {
        const hex = normalizeHex(tier.hex);
        if (hex && !palette.has(hex)) palette.set(hex, `quality:${tier.tier ?? '(未命名)'}`);
    }
    const fontLadder = new Set();
    for (const step of doc.typography?.scale ?? []) {
        if (Number.isFinite(step.size)) fontLadder.add(step.size);
    }
    if (!palette.size) throw new GateError(`${relProject(TOKENS_PATH)} 里没有读到任何 palette[].tokens[].hex`);
    if (!fontLadder.size) throw new GateError(`${relProject(TOKENS_PATH)} 里没有读到任何 typography.scale[].size`);
    return {
        path: TOKENS_PATH,
        palette,
        fontLadder,
        fontLadderSorted: [...fontLadder].sort((a, b) => b - a),
    };
}

/* ===================================================================
 * 预制件：数组 + `{"__id__":n}` 引用
 * =================================================================== */

/**
 * 读预制件本体。
 * @param {string} prefabPath 绝对路径
 * @returns {{elements:any[], path:string}}
 */
function loadPrefab(prefabPath) {
    if (!fs.existsSync(prefabPath)) throw new GateError(`预制件不存在：${prefabPath}`);
    if (!fs.statSync(prefabPath).isFile()) throw new GateError(`--prefab 指向的不是文件：${prefabPath}`);
    let elements;
    try {
        elements = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
    } catch (e) {
        throw new GateError(`预制件不是合法 JSON（${relProject(prefabPath)}）：${e.message}`);
    }
    if (!Array.isArray(elements)) {
        throw new GateError(`预制件不是 Cocos 序列化数组（${relProject(prefabPath)}）：顶层是 ${typeof elements}`);
    }
    return { elements, path: prefabPath };
}

/**
 * 解引用：预制件里凡是 `{"__id__": n}` 都是"下标 n 那个元素"。
 * 已是普通对象（如内联的 `{"__type__":"cc.Color",...}`）就原样返回。
 * @param {any[]} elements 预制件数组
 * @param {any} value 可能是引用、也可能是内联对象
 */
function deref(elements, value) {
    if (value && typeof value === 'object' && typeof value.__id__ === 'number') {
        return elements[value.__id__] ?? null;
    }
    return value ?? null;
}

/**
 * 找子树根节点（名字命中即算，同一份预制件里同名节点取**数组下标最小**的那个）。
 * 找不到时把"最像的几个候选"一起报出来 —— 否则只报一句"找不到"等于让人去猜。
 * @param {any[]} elements 预制件数组
 * @param {string} rootName 子树根节点名
 */
function findRootNode(elements, rootName) {
    const matches = [];
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el && el.__type__ === 'cc.Node' && el._name === rootName) matches.push(i);
    }
    if (!matches.length) {
        const near = [];
        for (const el of elements) {
            if (el && el.__type__ === 'cc.Node' && typeof el._name === 'string'
                && el._name.includes(rootName) && !near.includes(el._name)) near.push(el._name);
        }
        const hint = near.length
            ? `名字里含 "${rootName}" 的节点有：${near.slice(0, 8).join(' / ')}`
            : '该预制件里没有任何节点名含这个字符串（注意 --root 要用**节点名**，不是组件名或文件路径）';
        throw new GateError(`在预制件里找不到子树根节点 "${rootName}"：${hint}`);
    }
    return { index: matches[0], name: rootName, duplicates: matches.length };
}

/**
 * 按**节点路径**找子树根（`--root-path`）：`Scene_Menu/content/right/outer_relics`。
 *
 * 与 `findRootNode` 的分工：名字法在一份预制件里有**同名节点**时只能取下标最小的
 * （实测 `Scene_Menu.prefab` 里 `outer_relics` 有两个：左侧菜单项 / 右侧页面），
 * 路径法把"哪一棵"说死。首段允许省略（`content/right/outer_relics` 也行）——
 * 首段仍走 `findRootNode` 的名字匹配，之后**每段必须是上一段的直接子节点**。
 *
 * @param {any[]} elements 预制件数组
 * @param {string} rootPath 斜杠分隔的节点路径
 */
function findRootNodeByPath(elements, rootPath) {
    const segments = String(rootPath).split('/').map((s) => s.trim()).filter(Boolean);
    if (!segments.length) throw new GateError('--root-path 不能是空字符串');
    const walked = [segments[0]];
    let current = findRootNode(elements, segments[0]);
    for (let i = 1; i < segments.length; i++) {
        const node = elements[current.index];
        const children = (node?._children ?? []).map((ref) => deref(elements, ref)).filter(Boolean);
        const next = children.find((child) => child._name === segments[i]);
        if (!next) {
            const names = children.map((child) => child._name).join(' / ') || '(没有子节点)';
            throw new GateError(`--root-path 走到 "${walked.join('/')}" 时找不到子节点 "${segments[i]}"：`
                + `该节点的子节点 = ${names}`);
        }
        current = { index: elements.indexOf(next), name: segments[i], duplicates: 1 };
        walked.push(segments[i]);
    }
    return { index: current.index, name: current.name, duplicates: 1, path: walked.join('/') };
}

/* ===================================================================
 * 遍历子树：收集每个 Sprite / Label 组件 + 它的节点路径
 * =================================================================== */

/**
 * 递归遍历子树，收集体检记录。
 *
 * 为什么用 `node._children[]` 递归而**不是** `JSON.stringify` 全文正则：
 * 预制件里节点的父子关系只活在 `_children[]` 里，全文正则会把**不属于这棵子树**的组件
 * （同一份预制件里别的界面的节点）一起扫进来，还会把"文本里恰好像色值"的东西误判成违规。
 *
 * @param {any[]} elements 预制件数组
 * @param {number} rootIndex 子树根节点的数组下标
 * @param {string} rootName 子树根节点名（只用来校对"下标与名字是同一个节点"，报错路径靠节点自己的 `_name`）
 * @returns {{records:object[], stats:{nodes:number,sprites:number,labels:number}}}
 */
function scanSubtree(elements, rootIndex, rootName) {
    const records = [];
    const stats = { nodes: 0, sprites: 0, labels: 0 };
    if (elements[rootIndex]?._name !== rootName) {
        throw new GateError(`内部不一致：下标 ${rootIndex} 的节点是 "${elements[rootIndex]?._name}"，`
            + `不是 "${rootName}"（找根节点与遍历子树之间传错了东西）`);
    }
    /** 深度优先（前序），路径首段固定是子树根名，形如 `/ui_hero_detail/panel/skill/desc` */
    const walk = (node, parentPath) => {
        if (!node || node.__type__ !== 'cc.Node') return;
        const nodePath = `${parentPath}/${node._name}`;
        stats.nodes++;
        for (const ref of node._components ?? []) {
            const comp = deref(elements, ref);
            if (!comp) continue;
            if (comp.__type__ !== 'cc.Sprite' && comp.__type__ !== 'cc.Label') continue;
            if (comp.__type__ === 'cc.Sprite') stats.sprites++;
            else stats.labels++;
            const color = deref(elements, comp._color);
            const spriteFrame = deref(elements, comp._spriteFrame);
            records.push({
                path: nodePath,
                nodeName: node._name,
                type: comp.__type__,
                short: comp.__type__ === 'cc.Label' ? 'Label' : 'Sprite',
                /** `_color` 内联是常态，引用形态也一并解掉（两种写法都遇到过） */
                color,
                hex: hexOfColor(color),
                colorPresent: comp._color !== undefined && comp._color !== null,
                fontSize: comp._fontSize,
                fontSizePresent: comp._fontSize !== undefined && comp._fontSize !== null,
                lineHeight: comp._lineHeight,
                lineHeightPresent: comp._lineHeight !== undefined && comp._lineHeight !== null,
                spriteFrameUuid: spriteFrame && typeof spriteFrame === 'object'
                    ? (spriteFrame.__uuid__ ?? null) : null,
            });
        }
        for (const child of node._children ?? []) walk(deref(elements, child), nodePath);
    };
    walk(elements[rootIndex], '');
    return { records, stats };
}

/* ===================================================================
 * 四条判据（每条：通过返回 null，违规返回 {actual, reason}）
 * =================================================================== */

const RULES = [
    {
        id: 'P1',
        title: '颜色来自色板（cc.Sprite / cc.Label 的 _color）',
        /** 每条判据的适用范围（记录级） */
        applies: () => true,
        expect: (ctx) => `对 ${ctx.tokens.palette.size} 个 token 色`,
        check: (rec, ctx) => {
            if (!rec.colorPresent) return { actual: '色值缺失', reason: '组件上没有 _color 字段' };
            if (!rec.hex) return { actual: `色值非法（${JSON.stringify(rec.color)}）`, reason: '取不到 r/g/b 三个分量' };
            if (!ctx.tokens.palette.has(rec.hex)) {
                return { actual: rec.hex, reason: '不在 tokens.json 色板里（大概率是取色器里随手点的"野生色"）' };
            }
            return null;
        },
    },
    {
        id: 'P2',
        title: '字号在阶梯上（cc.Label 的 _fontSize）',
        applies: (rec) => rec.type === 'cc.Label',
        expect: (ctx) => `对 ${ctx.tokens.fontLadder.size} 档字号（${ctx.tokens.fontLadderSorted.join('/')}）`,
        check: (rec, ctx) => {
            if (!rec.fontSizePresent || !Number.isFinite(rec.fontSize)) {
                return { actual: 'fs=缺失', reason: '_fontSize 不是数字' };
            }
            if (!ctx.tokens.fontLadder.has(rec.fontSize)) {
                return { actual: `fs=${rec.fontSize}`, reason: '不在字号阶梯上' };
            }
            return null;
        },
    },
    {
        id: 'P3',
        title: 'Label 行距自洽（cc.Label 的 _lineHeight）',
        applies: (rec) => rec.type === 'cc.Label',
        expect: () => '只许 0 / = 字号 / round(字号 × 1.5)',
        check: (rec) => {
            if (!rec.lineHeightPresent || !Number.isFinite(rec.lineHeight)) {
                return { actual: 'lh=缺失', reason: '_lineHeight 不是数字' };
            }
            if (!Number.isFinite(rec.fontSize)) return null;    // 字号缺失由 P2 报，这里不重复报
            const oneAndHalf = Math.round(rec.fontSize * LINE_HEIGHT_RATIO);
            const allowed = rec.lineHeight === 0
                || rec.lineHeight === rec.fontSize
                || rec.lineHeight === oneAndHalf;
            if (!allowed) {
                return {
                    actual: `fs=${rec.fontSize} lh=${rec.lineHeight}`,
                    reason: `行距既不是 0（引擎自动）、也不等于字号 ${rec.fontSize}、也不是 round(${rec.fontSize}×${LINE_HEIGHT_RATIO})=${oneAndHalf}`,
                };
            }
            return null;
        },
    },
    {
        id: 'P4',
        title: '不引用引擎内置贴图（cc.Sprite 的 _spriteFrame.__uuid__）',
        applies: (rec) => rec.type === 'cc.Sprite',
        expect: () => `不许以 ${ENGINE_BUILTIN_UUID_PREFIX} 开头（= db://internal/default_ui/*）`,
        check: (rec) => {
            if (!rec.spriteFrameUuid) return null;             // 没拖贴图（纯色/占位）不算违规
            if (String(rec.spriteFrameUuid).startsWith(ENGINE_BUILTIN_UUID_PREFIX)) {
                return {
                    actual: `spriteFrame=${rec.spriteFrameUuid}`,
                    reason: `引擎内置贴图（应改用自有 textures/common/white_4x4）`,
                };
            }
            return null;
        },
    },
];

/**
 * 跑全部判据。
 * @param {object[]} records `scanSubtree` 收集到的组件记录
 * @param {object} ctx `{ tokens }`
 * @returns {{violations:object[], groups:object[], assertions:{total:number,passed:number,failed:number}}}
 *   违规条目的 `message` 形如 `/ui_hero_detail/panel/skill/desc: Label fs=33（不在字号阶梯上）`
 */
function judge(records, ctx) {
    const violations = [];
    const groups = RULES.map((rule) => ({
        id: rule.id,
        title: rule.title,
        expect: rule.expect(ctx),
        checked: 0,
        passed: 0,
        failed: 0,
        messages: [],
    }));
    RULES.forEach((rule, ri) => {
        for (const rec of records) {
            if (!rule.applies(rec)) continue;
            groups[ri].checked++;
            const bad = rule.check(rec, ctx);
            if (!bad) {
                groups[ri].passed++;
                continue;
            }
            groups[ri].failed++;
            const message = `${rec.path}: ${rec.short} ${bad.actual}（${bad.reason}）`;
            groups[ri].messages.push(message);
            violations.push({
                rule: rule.id,
                ruleTitle: rule.title,
                path: rec.path,
                node: rec.nodeName,
                component: rec.type,
                actual: bad.actual,
                reason: bad.reason,
                message,
            });
        }
    });
    const total = groups.reduce((n, g) => n + g.checked, 0);
    const failed = groups.reduce((n, g) => n + g.failed, 0);
    return { violations, groups, assertions: { total, passed: total - failed, failed } };
}

/* ===================================================================
 * 报告
 * =================================================================== */

/** 扫到的规模 + 判据真源规模（一句话讲清楚"这次到底比了多少东西"） */
const scaleLine = (stats, tokens) =>
    `扫了 ${stats.sprites} Sprite + ${stats.labels} Label，对 ${tokens.palette.size} 个 token 色 / `
    + `${tokens.fontLadder.size} 档字号`;

/**
 * 人读报告（观感照抄 `tools/hero-card-audit/audit.mjs`：`✔ 通过 N 条断言` / 违规逐条列出）。
 * @param {object} r 体检结果（见 `main`）
 */
function printReport(r) {
    console.log('');
    console.log('▌UI 规范门禁（真预制件 × docs/art-style/tokens.json）');
    console.log(`  预制件    ${relProject(r.prefabPath)}`);
    console.log(`  子树根    ${r.root.path ?? r.root.name}（数组下标 ${r.root.index}`
        + `${r.root.duplicates > 1 ? `；同名节点 ${r.root.duplicates} 个，取下标最小的` : ''}）`);
    console.log(`  判据真源  ${relProject(r.tokensPath)}`);
    console.log(`  规模      ${r.scaleLine}（子树共 ${r.stats.nodes} 个节点）`);
    for (const g of r.groups) {
        console.log('');
        console.log(`▌${g.id} ${g.title}`);
        const mark = g.failed ? '✖' : '✔';
        console.log(`  ${mark} ${g.passed}/${g.checked} 条通过（${g.expect}）`);
        for (const m of g.messages) console.log(`    · ${m}`);
    }
    console.log('');
    if (r.violations.length) {
        console.log(`✖ 失败 ${r.violations.length} 条违规（通过 ${r.assertions.passed} 条断言，共 ${r.assertions.total} 条）`);
        console.log(`  ${r.scaleLine}`);
        console.log('  按判据分布：'
            + r.groups.filter((g) => g.failed).map((g) => `${g.id} ${g.title.split('（')[0]} ×${g.failed}`).join(' · '));
        console.log('  （--json 可取结构化结果，给别的脚本消费）');
        return;
    }
    console.log(`✔ 通过 ${r.assertions.passed} 条断言`);
    console.log(`  ${r.scaleLine}`);
}

/* ===================================================================
 * 入口
 * =================================================================== */

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        process.exit(0);
    }

    const tokens = loadTokens();
    const prefabPath = path.isAbsolute(args.prefab) ? args.prefab : path.resolve(PROJECT_ROOT, args.prefab);
    const prefab = loadPrefab(prefabPath);
    const root = args.rootPath
        ? findRootNodeByPath(prefab.elements, args.rootPath)
        : findRootNode(prefab.elements, args.root);
    const { records, stats } = scanSubtree(prefab.elements, root.index, root.name);
    const { violations, groups, assertions } = judge(records, { tokens });
    if (!records.length) {
        // 不判违规也不算退出码 2（子树确实可能是个空容器），但必须让人看见"这次什么都没比"
        console.error(`⚠ 子树 "${root.path ?? root.name}" 里没有扫到任何 cc.Sprite / cc.Label —— 判据没有对象可比，`
            + `确认 --root / --root-path 是不是选错了`);
    }

    const result = {
        ok: violations.length === 0,
        exitCode: violations.length ? 1 : 0,
        checkedAt: new Date().toISOString(),
        prefab: { path: relProject(prefab.path), absolute: prefab.path },
        root: { name: root.name, index: root.index, duplicates: root.duplicates, path: root.path ?? null },
        tokens: {
            path: relProject(tokens.path),
            paletteCount: tokens.palette.size,
            palette: [...tokens.palette.keys()].sort(),
            fontLadder: tokens.fontLadderSorted,
        },
        stats,
        scaleLine: scaleLine(stats, tokens),
        assertions,
        groups: groups.map((g) => ({ ...g, messages: undefined })),
        violations,
    };

    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        // 人读报告要的是"路径 + 逐条违规明细"，与给脚本消费的 JSON 分开组装（后者不带 messages 明细）
        printReport({
            prefabPath: prefab.path,
            tokensPath: tokens.path,
            root,
            stats,
            scaleLine: result.scaleLine,
            assertions,
            groups,
            violations,
        });
    }
    process.exit(result.exitCode);
}

try {
    main();
} catch (e) {
    // 退出码 2 = 门禁自己跑不起来（拿不到判据 / 找不到目标）—— 必须让人看见，绝不静默通过
    const args = process.argv.slice(2);
    if (e instanceof GateError) {
        if (args.includes('--json')) {
            console.log(JSON.stringify({ ok: false, exitCode: 2, error: e.message }, null, 2));
        }
        console.error(`✖ 门禁跑不起来（退出码 2）：${e.message}`);
        process.exit(2);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify({ ok: false, exitCode: 2, error: `内部错误：${e && e.stack || e}` }, null, 2));
    }
    console.error(`✖ 门禁内部错误（退出码 2）：${e && e.stack || e}`);
    process.exit(2);
}
