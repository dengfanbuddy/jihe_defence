#!/usr/bin/env node
/**
 * audit.mjs —— **英雄卡（HeroCard）× 真预制件** 体检（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**「英雄卡改版后，代码读的节点和预制件里真实的节点，还对得上吗？」**
 *
 * 为什么需要它（一条真实教训）：`HeroItem.prefab` 改版时把 `lv` 从一个 Label 改成了
 * 「容器 + `value` 子节点」，并新增了 `exp_bar` 进度条。这类改版**不会报任何错**：
 *   · `getChildByName('lv').getComponent(Label)` 从"拿到等级"变成"拿到静态前缀 LV."——
 *     界面上等级就是不显示，控制台一片安静；
 *   · 预制件里 `@property` 的**拖引用**是历史遗留的，改完结构极易指向别的同名子节点
 *     （实测：`actionSprite` 拖到了 `unlock/icon` 金币图标上 → 按钮点不动 + 金币被染色）。
 * 所以这里**真跑**一遍：把项目里真实的 `HeroCard.ts` 用 TypeScript 编成 CJS，
 * 给它打一个 `cc` 桩，再把**真 `HeroItem.prefab`** 的节点/组件数据构造成同构的假节点树
 * （连预制件里**真拖的那些引用**也照抄接上），然后调用真 `onInit()` + 真 `setInfo(vm)`，逐条断言。
 *
 * ── 断言分九组（下方按 A→A′→B→C→D→F→E→G→H 的顺序跑） ──
 *   A  契约：真预制件 + 真拖引用 → 代码解析出来的引用是不是"该拿的那个"，**且预制件自己拖对了**
 *   A′ 对照组：**注入**一份"故意拖错引用"的副本，验 `resolveRefs` 的兜底纠正仍在（+ 只警告一次）
 *   B  渲染：未解锁 / 已解锁两态的等级、经验条、按钮文案与两态色、金币图标有没有被误染
 *   C  边界：exp=0 / exp>expMax / expMax=0（无经验口径）各画成什么
 *   D  经验公式：真 `HeroData` + 真 `battle_constants.json`，以及 `base=0` 时**不许死循环**
 *   F  两态判据：真 `HeroVM.ts` + 假数据层，卡片与弹窗必须共用同一份判据
 *   E  风格口径：颜色/字号必须落在 `docs/art-style/tokens.json` + 风格预设 §4 的阶梯里，
 *      且不许引用引擎内置贴图（改预制件颜色时这道门禁会红）
 *   G  销毁：模拟引擎的销毁级联（**先子节点、后本节点组件**）——`onDispose` 里对已被 `_destruct`
 *      的后代节点 `getComponent` 会抛 `TypeError`（真机 `node.ts:309` 读 `comps.length`），不许抛
 *   H  **英雄详情弹窗**：真 `Cmp_HeroDetail.ts` 跑在真 `Scene_Menu.prefab` 的 `ui_hero_detail` 子树上，
 *      引用契约 / 三态 / 按钮两态 / **点一下真的冒泡出哪个事件** / `onDispose` 收尾（同 G 组的级联模型）
 *
 * 用法：
 *   node tools/hero-card-audit/audit.mjs
 *   npm run audit:herocard        # 在 tools/excel_export 下的等价命令
 *   HERO_CARD_PREFAB=<临时副本> node tools/hero-card-audit/audit.mjs   # 负控：不动真资产
 *   HERO_DETAIL_PREFAB=<临时副本> node tools/hero-card-audit/audit.mjs # 同上，换 H 组那份预制件
 *
 * 退出码：有断言失败 = 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = 'assets/scripts';
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
/**
 * 被体检的预制件。`HERO_CARD_PREFAB` 可覆盖成一份**临时副本** —— 负控（"把某个值改回去，
 * 门禁该立刻变红"）因此可以不动真资产：`HERO_CARD_PREFAB=/tmp/x.prefab node audit.mjs`。
 */
const PREFAB_PATH = process.env.HERO_CARD_PREFAB
    || path.join(ROOT, 'assets/resources/prefabs/ui/scenes/scene_menu/cmps/HeroItem.prefab');

/** 需要编译的**真源码**（相对 assets/scripts；platform/reactivity 整个目录另算） */
const SOURCES = [
    'game/ui/scenes/scene_menu/cmps/HeroCard.ts',
    'game/ui/scenes/scene_menu/cmps/HeroScope.ts',
    'game/ui/scenes/scene_menu/cmps/HeroVM.ts',
    // 详情弹窗（H 组）：真组件跑在真 `Scene_Menu.prefab` 子树上
    'game/ui/scenes/scene_menu/cmps/Cmp_HeroDetail.ts',
    'game/data/funcs/HeroData.ts',
    'game/data/DataModule.ts',
    'game/common/AtlasIcon.ts',
    'game/common/NodeUtils.ts',
    'game/common/GoldText.ts',
    'platform/ui/UIWidget.ts',
    'platform/ui/UIComponent.ts',
    'platform/ui/UIScope.ts',
    'platform/event/BaseEventMgr.ts',
    'platform/log/LogMgr.ts',
];

/* ===================================================================
 * cc 桩
 * =================================================================== */

/**
 * `cc` 打桩：只实现「真 HeroCard 跑到的那条路」用到的东西。
 * 外加 `buildTree(prefab, idx)`：**按真预制件的节点/组件数据构出同构的假节点树**，
 * 并把「预制件对象下标 → 假对象」映射出来（`byId`），这样**预制件里拖的引用**能原样接到假对象上。
 *
 * 两处刻意**不**照抄引擎：① `ProgressBar.progress` 不钳位（钳位是 `HeroCard` 的责任，
 * 桩里钳了就验不出它的 clamp）；② `Button` 不做 transition（真引擎 `transition=COLOR` 会覆盖
 * 同节点 Sprite 的 color，本项目一律 `Transition.NONE` 自己写色）。
 */
const CC_STUB = `
class Color {
    constructor(r = 255, g = 255, b = 255, a = 255) { this.r = r; this.g = g; this.b = b; this.a = a; }
    clone() { return new Color(this.r, this.g, this.b, this.a); }
    fromHEX(hex) {
        const h = String(hex || '').replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        this.r = parseInt(full.slice(0, 2), 16);
        this.g = parseInt(full.slice(2, 4), 16);
        this.b = parseInt(full.slice(4, 6), 16);
        return this;
    }
}
class Component {
    constructor() { this.node = null; this.isValid = true; this.enabled = true; this.customMaterial = null; }
}
class UIRenderer extends Component { }
class UITransform extends Component {
    constructor() { super(); this._w = 0; this._h = 0; this._ax = 0.5; this._ay = 0.5; }
    get width() { return this._w; }
    get height() { return this._h; }
    get anchorX() { return this._ax; }
    get anchorY() { return this._ay; }
    setContentSize(w, h) { this._w = w; this._h = h; }
    setAnchorPoint(x, y) { this._ax = x; this._ay = y; }
}
class Label extends UIRenderer {
    constructor() { super(); this._color = new Color(255, 255, 255, 255); this.string = ''; this.fontSize = 20; this.lineHeight = 0; }
    get color() { return this._color; }
    set color(v) { this._color = v; }
}
class Sprite extends UIRenderer {
    constructor() { super(); this.spriteFrame = null; this.color = new Color(); this.fillRange = 0; this.sizeMode = 0; this.type = 0; }
}
class ProgressBar extends Component {
    constructor() { super(); this._barSprite = null; this._mode = 0; this._totalLength = 100; this._raw = 0; }
    // 故意不钳位：见文件头 cc 桩说明
    get progress() { return this._raw; }
    set progress(v) { this._raw = v; }
}
ProgressBar.ProgressBarMode = { HORIZONTAL: 0, VERTICAL: 1, FILLED: 2 };
class Button extends Component {
    constructor() { super(); this.transition = 1; this.interactable = true; this.normalColor = new Color(); this.hoverColor = new Color(); this.pressedColor = new Color(); }
}
Button.EventType = { CLICK: 'click' };
Button.Transition = { NONE: 0, COLOR: 1, SPRITE: 2, SCALE: 3 };
class Mask extends Component { }
class Graphics extends Component { }
class EditBox extends Component { }
class Slider extends Component { }
class Toggle extends Component { }
class ToggleContainer extends Component { }
class Material { }
class SpriteFrame { }
class SpriteAtlas { getSpriteFrame() { return null; } getSpriteFrames() { return []; } }
class EventTarget {
    constructor() { this._events = {}; }
    on(type, cb, target) { (this._events[type] = this._events[type] || []).push({ cb, target }); }
    off(type, cb, target) { const l = this._events[type] || []; this._events[type] = l.filter((e) => e.cb !== cb || e.target !== target); }
    emit(type, ...args) { for (const e of (this._events[type] || []).slice()) e.cb.apply(e.target, args); }
}
class Node {
    constructor(name = '') { this.name = name; this._children = []; this.parent = null; this._active = true; this._components = []; this.isValid = true; this._destroyed = false; }
    get children() { return this._children; }
    get active() { return this._active; }
    set active(v) { this._active = !!v; }
    get activeInHierarchy() { return this._active && (!this.parent || this.parent.activeInHierarchy); }
    get components() { return this._components; }
    getChildByName(n) { return this._children.find((c) => c.name === n) || null; }
    /** 引擎的 \`getChildByPath('a/b/c')\`：逐段 \`getChildByName\`，任一段断了就 null（详情弹窗靠它按名字兜底解析契约） */
    getChildByPath(p) {
        let cur = this;
        for (const seg of String(p || '').split('/')) {
            if (!seg) continue;
            cur = cur.getChildByName(seg);
            if (!cur) return null;
        }
        return cur === this ? null : cur;
    }
    getSiblingIndex() { return this.parent ? this.parent._children.indexOf(this) : 0; }
    getComponent(t) { return this._components.find((c) => c instanceof t) || null; }
    getComponents(t) { return this._components.filter((c) => c instanceof t); }
    getComponentsInChildren(t) {
        const out = [];
        const walk = (n) => {
            for (const c of n._components) if (c instanceof t) out.push(c);
            for (const ch of n._children) walk(ch);
        };
        walk(this);
        return out;
    }
    addComponent(t) { const c = new t(); c.node = this; this._components.push(c); return c; }
    removeFromParent() { if (this.parent) this.parent._children = this.parent._children.filter((c) => c !== this); this.parent = null; }
    destroy() { this._destroyed = true; this.isValid = false; return true; }
    // 节点事件记账（G 组要数「挂了几条 / 摘了几条 / 有没有去碰已销毁的节点」）
    on(type, cb, target) { (this._onCalls = this._onCalls || []).push({ type, cb, target }); }
    off(type, cb, target) { (this._offCalls = this._offCalls || []).push({ type, cb, target }); }
}
Node.EventType = { TOUCH_START: 'touch-start', TOUCH_MOVE: 'touch-move', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel', MOUSE_DOWN: 'mouse-down' };
const _decorator = { ccclass: () => (cls) => cls, property: () => () => { } };
const SystemEvent = { EVENT_SHOW: 'show', EVENT_HIDE: 'hide', EVENT_DESTROY: 'destroy' };
/** 记录所有 resources.load 的路径（用来断言"头像/技能图真的按 resources 相对路径要过图"） */
const loadedPaths = [];
const resources = {
    load(p, type, cb) {
        loadedPaths.push(p);
        // 桩里没有真资产：一律回错误（真代码的失败分支只报错、不把已有图刷空白）
        if (typeof cb === 'function') cb(new Error('audit stub: no asset'), null);
        return null;
    },
};
/**
 * 置灰材质哨兵（真引擎是 builtinResMgr.get('ui-sprite-gray-material')）。
 * 桩里必须给一个**可比的对象**：若照抄成 get: () => null，「置灰」与「取消置灰」在桩里都是 null，
 * NodeUtils.setGray 的两条路就区分不出来了（H 组要验"灰面板 + 亮按钮"）。
 */
const GRAY_MAT = { name: 'ui-sprite-gray-material' };
const builtinResMgr = { get: (n) => (n ? GRAY_MAT : null) };
const warn = (...a) => console.warn(...a);
const error = (...a) => console.error(...a);
function buildTree(prefab, idx) {
    const byId = new Map();
    function make(i) {
        const e = prefab[i];
        const node = new Node(e._name === undefined ? '' : e._name);
        node._active = e._active === undefined ? true : !!e._active;
        byId.set(i, node);
        for (const ref of e._components || []) {
            const comp = prefab[ref.__id__];
            let stub = null;
            if (comp.__type__ === 'cc.UITransform') stub = new UITransform();
            else if (comp.__type__ === 'cc.Label') {
                stub = new Label();
                stub.string = comp._string;
                stub.fontSize = comp._fontSize;
                stub.lineHeight = comp._lineHeight;
                if (comp._color) stub._color = new Color(comp._color.r, comp._color.g, comp._color.b, comp._color.a);
            } else if (comp.__type__ === 'cc.Sprite') {
                stub = new Sprite();
                if (comp._color) stub.color = new Color(comp._color.r, comp._color.g, comp._color.b, comp._color.a);
            } else if (comp.__type__ === 'cc.ProgressBar') {
                stub = new ProgressBar();
                stub._mode = comp._mode;
                stub._totalLength = comp._totalLength;
                stub._raw = comp._progress;
            } else if (comp.__type__ === 'cc.Button') stub = new Button();
            if (!stub) continue;
            stub.node = node;
            node._components.push(stub);
            byId.set(ref.__id__, stub);
        }
        for (const ch of e._children || []) {
            const child = make(ch.__id__);
            child.parent = node;
            node._children.push(child);
        }
        return node;
    }
    const node = make(idx);
    return { node, byId };
}
module.exports = {
    _decorator, Color, Component, UIRenderer, Label, Sprite, ProgressBar, Button, Node, UITransform,
    Mask, Graphics, EditBox, Slider, Toggle, ToggleContainer, Material, SpriteFrame, SpriteAtlas,
    EventTarget, SystemEvent, resources, builtinResMgr, warn, error, buildTree, loadedPaths, GRAY_MAT,
};
`;

/* ===================================================================
 * 打桩：只桩「与卡片渲染无关」的依赖
 * =================================================================== */

const battleConst = JSON.parse(fs.readFileSync(path.join(TB_DIR, 'battle_constants.json'), 'utf8'));
const expBase = Number(battleConst.heroExpFormulaBase);
const expRatio = Number(battleConst.heroExpFormulaRatio);

const STUBS = {
    /**
     * 经验公式的**配置来源**（真 `battle_constants.json` 的值，不是手抄的魔法数）。
     * 额外留了两个可写开关：`base=0` 是「配表配错」的对照组 —— 验证 `addHeroExp` 的死循环守卫。
     */
    'game/battle/core/BattleConstUtil': `exports.BattleConstUtil = {
    getHeroExpFormulaBase: () => (globalThis.__heroExpBase === undefined ? ${expBase} : globalThis.__heroExpBase),
    getHeroExpFormulaRatio: () => (globalThis.__heroExpRatio === undefined ? ${expRatio} : globalThis.__heroExpRatio),
};`,
    /** 存档底座：Node 里没有 localStorage，全部空实现（本体检不验存档，只验卡片与公式） */
    'game/data/StorageUtil': `exports.StorageUtil = {
    getItem: () => null, setItem: () => { }, removeItem: () => { }, hasItem: () => false,
    clearAll: () => { }, getStorageSize: () => 0,
};`,

    /* ── 下面两个假模块只服务 F 组（`HeroVM.ts` 的判据）。──
     * 为什么打桩而不是用真的：`HeroVM` 的 `import { DataCenter } from '../../../../data'` 会把
     * 整个数据层（DataCenter → 7 个模块 → TbRoot → cc）拖进来，与"只验判据"这件事无关。
     * 桩的状态由 `globalThis.__heroFake` 驱动（`gold` / `exp` / `records` / `noFormula`），
     * 所以**两态（未解锁 → 解锁后）可以在同一个函数上前后各跑一次**。 */
    'game/data/index': `exports.CurrencyType = { Gold: 'gold', Diamond: 'diamond', Stamina: 'stamina', Honor: 'honor' };
const fake = () => globalThis.__heroFake;
exports.DataCenter = { ins: {
    get itemData() { return { getCurrency: (t) => (t === 'gold' ? fake().gold : 0) }; },
    get heroData() { return {
        getHeroInfo: (id) => fake().records.find((r) => r.id === id) || null,
        getUnlocked: () => fake().records,
        getSharedExp: () => fake().exp,
        // 与真 HeroData 同一个公式（heroExpFormulaBase=100 / Ratio=1.12）；
        // noFormula 是"配表把基数配成 0"的对照组
        getExpForNextLevel: (lv) => (fake().noFormula
            ? 0
            : Math.floor(100 * Math.pow(1.12, Math.max(1, Math.floor(lv || 1)) - 1))),
    }; },
} };`,
    'game/data/configs/HeroConfig': `exports.HERO_DETAIL_ATTR_ROWS = [1, 2, 3, 4, 16];
const HEROES = {
    1001: { id: 1001, name: '火枪', head_icon: 'textures/heros/huoqiang' },
    1002: { id: 1002, name: '赏金猎人', head_icon: 'textures/heros/shangjin' },
};
/** 最近一次 \`getAttrRows\` 拿到的等级（F8 用它验"未解锁按 1 级画"） */
exports.__lastAttrLevel = 0;
exports.HeroConfig = {
    getHero: (id) => HEROES[id],
    getUnlockCost: (id) => (id === 1002 ? 2000 : 0),
    getSkillIcons: () => ['textures/skills/huoqiang_skill'],
    getSkill: () => ({ icon: 'textures/skills/huoqiang_skill', name: '爆头冲击', desc: '普攻附带…', tag: '（被动）' }),
    getAttrRows: (id, lv, rows) => {
        exports.__lastAttrLevel = lv;
        return (rows && rows.length ? rows : [1, 3, 6, 16]).map((a) => ({
            attrId: a, name: '属性' + a, value: 1, growth: 0, valueText: '1', growthText: '—', icon: '',
        }));
    },
};`,
};

/* ===================================================================
 * 编译真源码
 * =================================================================== */

const require = createRequire(import.meta.url);

function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✖ 找不到 typescript（请在项目根目录或 tools/excel_export 下装好依赖）');
    process.exit(2);
}
const ts = resolveTypeScript();

function collectTs(absDir, prefix) {
    const out = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) out.push(...collectTs(path.join(absDir, entry.name), rel));
        else if (entry.name.endsWith('.ts')) out.push(rel);
    }
    return out;
}

function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-hero-card-audit-'));
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));

    // 编译产物落在 <out>/assets/scripts/**，所以 db://assets/scripts/X 要改写成那个绝对前缀
    const outPrefix = path.join(out, SRC).replace(/\\/g, '/');

    const files = [...SOURCES, ...collectTs(path.join(ROOT, SRC, 'platform/reactivity'), 'platform/reactivity')];
    for (const rel of files) {
        let js = ts.transpileModule(fs.readFileSync(path.join(ROOT, SRC, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
            fileName: rel,
        }).outputText;
        // `import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget'` → 落到编译产物里的绝对路径
        js = js.replace(/(['"])db:\/\/assets\/scripts\/([^'"]+)\1/g, (_m, q, rest) => `${q}${outPrefix}/${rest}${q}`);
        const dest = path.join(out, SRC, rel.replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js);
    }
    for (const [rel, code] of Object.entries(STUBS)) {
        const dest = path.join(out, SRC, `${rel}.js`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
    }
    const ccDir = path.join(out, 'node_modules/cc');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'index.js'), CC_STUB);
    return { out, mod: (...p) => require(path.join(out, SRC, ...p)) };
}

/* ===================================================================
 * 跑
 * =================================================================== */

/** `ezgame` 是工程里的全局门面（真机上是 window.ezgame）；把日志收起来，别刷屏 */
const ezLogs = { info: [], warn: [], error: [] };
globalThis.ezgame = {
    info: (...a) => ezLogs.info.push(a.map(String).join(' ')),
    warn: (...a) => ezLogs.warn.push(a.map(String).join(' ')),
    error: (...a) => ezLogs.error.push(a.map(String).join(' ')),
    debug: () => { },
};

/**
 * 直接 `console.warn/error` 的日志（组件里是这么写的，与 `ezgame.*` 是两套）也要收起来 ——
 * 「拖错的引用只警告一次」这条断言要数的就是它。跑卡片期间折叠，报告阶段放行。
 */
const consoleLogs = { warn: [], error: [] };
let captureConsole = false;
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
console.warn = (...a) => { if (captureConsole) { consoleLogs.warn.push(a.map(String).join(' ')); return; } origWarn(...a); };
console.error = (...a) => { if (captureConsole) { consoleLogs.error.push(a.map(String).join(' ')); return; } origError(...a); };

let passed = 0;
const failures = [];
const sections = [];
let currentSection = null;

function group(title) {
    currentSection = { title, lines: [] };
    sections.push(currentSection);
}
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++;
    else failures.push(`[${currentSection ? currentSection.title : '?'}] ${label}：实际 ${a}，期望 ${e}`);
    currentSection.lines.push(`  ${ok ? '✔' : '✖'} ${label}（${a}${ok ? '' : ` ≠ ${e}`}）`);
    return ok;
}

const built = build();
const cc = require(path.join(built.out, 'node_modules/cc'));
const { HeroCard } = built.mod('game', 'ui', 'scenes', 'scene_menu', 'cmps', 'HeroCard.js');

/**
 * 起一张真卡：按那份 prefab 数据里**真拖的引用**接线。
 *
 * @param treeRef `cc.buildTree` 出来的假节点树（A′ 对照组会传一棵"引用被故意拖错"的副本）
 * @param comp    与之配套的 HeroCard 组件数据（默认 = 真预制件里那一份）
 */
function spawnCard(treeRef, comp = prefabCardComp) {
    const node = treeRef.node;
    const card = new HeroCard();
    card.node = node;
    for (const field of CARD_REF_FIELDS) {
        const ref = comp[field];
        card[field] = ref ? treeRef.byId.get(ref.__id__) ?? null : null;
    }
    card.propertyNodes = (comp.propertyNodes || []).map((r) => treeRef.byId.get(r.__id__)).filter(Boolean);
    card.onInit();          // 真生命周期入口（内部 = resolveRefs + 绑两个按钮）
    return card;
}

captureConsole = true;

/* ---------- A 契约：真预制件 + 真拖引用 ---------- */

group('A 契约（真 HeroItem.prefab + 预制件里真拖的引用）');

const prefab = JSON.parse(fs.readFileSync(PREFAB_PATH, 'utf8'));
const rootIdx = prefab[0].data.__id__;
const tree = cc.buildTree(prefab, rootIdx);
const rootNode = tree.node;

// 预制件里真拖的 @property（**2026-10 已在编辑器里重拖修正**，这里按真实状态接上）
const prefabCardComp = prefab.find((e) => typeof e.__type__ === 'string' && !e.__type__.startsWith('cc.')
    && e.node && e.node.__id__ === rootIdx);
check('A0 预制件根节点上挂着 HeroCard 脚本', !!prefabCardComp, true);

const CARD_REF_FIELDS = ['headSprite', 'lockNode', 'nameLabel', 'lvLabel', 'skillSprite',
    'actionSprite', 'actionLabel', 'actionValueLabel', 'detailNode'];

/** 数一数纠正告警打了几条（`resolveRefs` 里那两条 warn 的标志串） */
const warnCount = (key) => consoleLogs.warn.filter((l) => l.includes(key)).length;

// 预制件里拖的那两个引用（A1b/A4b 断言它们**指向正确的节点**，不再是"拖错、靠代码纠回来"）
const rawLvRef = prefabCardComp.lvLabel ? tree.byId.get(prefabCardComp.lvLabel.__id__) : null;
const rawActionRef = prefabCardComp.actionSprite ? tree.byId.get(prefabCardComp.actionSprite.__id__) : null;

const card = spawnCard(tree);

const lvNode = rootNode.getChildByName('lv');
const lvValueLabel = lvNode?.getChildByName('value')?.getComponent(cc.Label);
const expBarNode = rootNode.getChildByName('exp_bar');
const unlockNode = rootNode.getChildByName('unlock');
const coinIconSprite = unlockNode?.getChildByName('icon')?.getComponent(cc.Sprite);

check('A1 等级数字取的是 `lv/value`（不是 `lv` 自己的「LV.」前缀）', card.lvLabel === lvValueLabel, true);
check('A1b 预制件里的 `lvLabel` 本身已指向 `lv/value`（不是靠代码纠回来的）',
    [card.lvLabel === rawLvRef, rawLvRef === lvValueLabel], [true, true]);
check('A2 等级**整块**（`lv` 容器）被记住用于收放', card.lvNode === lvNode, true);
check('A3 经验条取的是 `exp_bar` 上的 ProgressBar', card.expBar === expBarNode?.getComponent(cc.ProgressBar), true);
check('A4 按钮底图取的是 `unlock` 自己的 Sprite（不是 `unlock/icon` 金币图）', card.actionSprite === unlockNode?.getComponent(cc.Sprite), true);
check('A4b 预制件里的 `actionSprite` 本身已指向 `unlock` 自己的 Sprite（不是 26×26 的金币图）',
    [card.actionSprite === rawActionRef, rawActionRef === unlockNode?.getComponent(cc.Sprite)], [true, true]);
check('A5 按钮挂在 `unlock` 节点上（80×40 的点击区域，不是 26×26 的金币图）', card.actionBtn()?.node === unlockNode, true);
check('A6 文案 / 价格 / 价格图标 / 详情按钮 / 头像 / 技能图 / 4 行属性都解析到了',
    !!(card.actionLabel && card.actionValueLabel && card.actionIconSprite && card.detailNode && card.headSprite
        && card.skillSprite && card.propertyNodes.length === 4), true);
check('A6b 价格图标取的是 `unlock/icon`（金币图那个节点，不是按钮底图）',
    card.actionIconSprite === coinIconSprite, true);
check('A7 预制件引用都对 → 一条「已按名字改用…」的纠正告警都不该有',
    [warnCount('lvLabel'), warnCount('actionSprite')], [0, 0]);

/* ---------- A′ 对照组：把两处引用**故意**拖错（兜底路径不能因为预制件修好了就失去覆盖）----------
 *
 * 2026-10 在编辑器里把预制件那两处重拖修正之后，`resolveRefs` 里"按名字纠正 + 只警告一次"的
 * 兜底就再也没有真人触发过了 —— 那段逻辑必须留着（它防的是下一次改版又拖错），所以这里
 * **注入**一份拖错引用的副本再跑一遍，把兜底路径继续钉住。
 * 顺序要紧：那两个模块级 flag 是"只警告一次"，上面 A7 那轮一条都没打，所以这一轮必然各打一条。
 */
group('A′ 对照组（注入两处拖错引用：兜底纠正 + 只在第一次警告）');

/** 按名字路径找节点在 prefab 数组里的下标（只给对照组造数据用） */
const nodeIdxAt = (arr, root, names) => {
    let idx = root;
    for (const nm of names) {
        const next = (arr[idx]._children || []).map((c) => c.__id__).find((i) => arr[i]._name === nm);
        if (next === undefined) return -1;
        idx = next;
    }
    return idx;
};
/** 某个节点上挂着的第一个指定类型组件的下标 */
const compIdxOn = (arr, nodeIdx, type) => {
    if (nodeIdx < 0) return -1;
    for (const c of arr[nodeIdx]._components || []) if (arr[c.__id__].__type__ === type) return c.__id__;
    return -1;
};

const badPrefab = JSON.parse(JSON.stringify(prefab));
const badCardIdx = badPrefab.findIndex((e) => typeof e.__type__ === 'string' && !e.__type__.startsWith('cc.')
    && e.node && e.node.__id__ === rootIdx);
const badComp = badPrefab[badCardIdx];
badComp.lvLabel = { __id__: compIdxOn(badPrefab, nodeIdxAt(badPrefab, rootIdx, ['lv']), 'cc.Label') };
badComp.actionSprite = { __id__: compIdxOn(badPrefab, nodeIdxAt(badPrefab, rootIdx, ['unlock', 'icon']), 'cc.Sprite') };

const badTree = cc.buildTree(badPrefab, rootIdx);
const badCard = spawnCard(badTree, badComp);

// 断言"注入生效"要读**接线那一刻**的引用（`onInit → resolveRefs` 之后字段一律已被纠正）
check('A7b 对照组确实被注入了「LV.」前缀引用',
    badTree.byId.get(badComp.lvLabel.__id__) === badTree.node.getChildByName('lv').getComponent(cc.Label), true);
check('A7c 对照组确实被注入了金币图引用（26×26 那张）',
    badTree.byId.get(badComp.actionSprite.__id__) === badTree.node.getChildByName('unlock').getChildByName('icon').getComponent(cc.Sprite), true);
check('A7d 代码把拖错的两处都按名字纠正了',
    [badCard.lvLabel === badTree.node.getChildByName('lv').getChildByName('value').getComponent(cc.Label),
        badCard.actionSprite === badTree.node.getChildByName('unlock').getComponent(cc.Sprite)], [true, true]);
check('A7e 纠正时各警告一次', [warnCount('lvLabel'), warnCount('actionSprite')], [1, 1]);

// 再起一张卡（同一份拖错引用）：告警**不该**再重复 —— 列表每次重铺都会克隆一批卡，逐个吼会刷屏
spawnCard(cc.buildTree(badPrefab, rootIdx), badComp);
check('A7f 第二张卡不再重复告警（列表重铺不刷屏）', [warnCount('lvLabel'), warnCount('actionSprite')], [1, 1]);

/* ---------- B 渲染：未解锁 / 已解锁 ---------- */

group('B 渲染（两态）');

const VM_LOCKED = {
    heroId: 1002, name: '赏金猎人', headIcon: 'textures/heros/shangjin', skillIcon: 'textures/skills/huoqiang',
    unlocked: false, level: 0, exp: 0, expMax: 0, costKind: 'gold', cost: 2000, enabled: true,
    attrs: [{ attrId: 1, name: '最大生命', value: 300, growth: 12, valueText: '300', growthText: '+12/级', icon: 'textures/common/heart' }],
};
const VM_OPEN = {
    heroId: 1001, name: '火枪', headIcon: 'textures/heros/huoqiang', skillIcon: 'textures/skills/huoqiang',
    unlocked: true, level: 5, exp: 40, expMax: 100, costKind: 'exp', cost: 2000, enabled: true,
    attrs: [{ attrId: 1, name: '最大生命', value: 368, growth: 12, valueText: '368', growthText: '+12/级', icon: 'textures/common/heart' }],
};

card.setInfo(VM_LOCKED);
check('B1 未解锁 → 盖锁', card.lockNode.active, true);
check('B2 未解锁 → 等级整块收起（不留孤零零的「LV.」）', card.lvNode.active, false);
check('B3 未解锁 → 经验条收起', card.expBar.node.active, false);
check('B4 未解锁 → 按钮文案是「解 锁」', card.actionLabel.string, '解 锁');
check('B5 未解锁 → 价格文案（2000 → 2k）', card.actionValueLabel.string, '2k');
check('B6 未解锁 → 可点（钱够）→ 底图是青色 #3F9E9B', [card.actionSprite.color.r, card.actionSprite.color.g, card.actionSprite.color.b], [63, 158, 155]);
check('B7 未解锁 → 按钮 interactable = true', card.actionBtn().interactable, true);
// 2026-11 起「花什么」分两态（解锁花金币 / 升级花通用英雄经验），图标必须跟着走
check('B7b 未解锁 → 价格图标还是**金币图**（保留预制件那张 + 它原本的颜色）',
    [card.actionIconSprite.color.r, card.actionIconSprite.color.g, card.actionIconSprite.color.b], [112, 172, 179]);
check('B7c 金币语境**不请求**经验图（没白加载一张图）',
    cc.loadedPaths.includes('textures/common/exp_icon/spriteFrame'), false);

card.setInfo(VM_OPEN);
check('B8 已解锁 → 锁收起', card.lockNode.active, false);
check('B9 已解锁 → 等级整块显示', card.lvNode.active, true);
check('B10 等级数字 = 5（只写数字，前缀「LV.」由预制件自己管）', card.lvLabel.string, '5');
check('B11 经验条显示', card.expBar.node.active, true);
check('B12 经验进度 = 40/100 = 0.4', card.expBar.progress, 0.4);
check('B13 已解锁 → 按钮文案是「升 级」', card.actionLabel.string, '升 级');
check('B14 已解锁 → 价格图标换成**经验图**（青绿本色 → 回白），且确实去加载了 exp_icon',
    [card.actionIconSprite.color.r, card.actionIconSprite.color.g, card.actionIconSprite.color.b,
    cc.loadedPaths.includes('textures/common/exp_icon/spriteFrame')], [255, 255, 255, true]);
// 切回金币语境必须能复原（同一张卡在两态之间来回切是常态：解锁前看一眼、解锁后看一眼）
card.setInfo(VM_LOCKED);
check('B14b 从经验语境切回金币语境 → 图标颜色复原成预制件那一个',
    [card.actionIconSprite.color.r, card.actionIconSprite.color.g, card.actionIconSprite.color.b], [112, 172, 179]);
card.setInfo(VM_OPEN);

const disabled = { ...VM_OPEN, enabled: false };
card.setInfo(disabled);
check('B15 钱不够 → 底图转灰 #B9C1C1', [card.actionSprite.color.r, card.actionSprite.color.g, card.actionSprite.color.b], [185, 193, 193]);
check('B16 钱不够 → interactable = false（点不动）', card.actionBtn().interactable, false);

const free = { ...VM_OPEN, cost: 0 };
card.setInfo(free);
check('B17 免费（价 0）→ 价格文字收起，不显示孤零零的「0」', card.actionValueLabel.node.active, false);

/* ---------- C 边界 ---------- */

group('C 边界');

card.setInfo({ ...VM_OPEN, exp: 0 });
check('C1 exp = 0 → 进度 0，但条仍显示（已解锁就是有条）', [card.expBar.node.active, card.expBar.progress], [true, 0]);
card.setInfo({ ...VM_OPEN, exp: 250, expMax: 100 });
check('C2 exp > expMax（脏数据）→ 进度钳在 1，不画出框', card.expBar.progress, 1);
card.setInfo({ ...VM_OPEN, expMax: 0 });
check('C3 expMax = 0（没有经验口径）→ 收起经验条，不画永远空的条', card.expBar.node.active, false);
card.setInfo({ ...VM_OPEN, exp: 40, expMax: 100 });
check('C4 连刷两次不会串（回到 0.4）', card.expBar.progress, 0.4);

/* ---------- D 经验公式与通用经验池（真 HeroData + 真 battle_constants） ---------- */

group('D 经验池与升级（真 HeroData.ts + 真 battle_constants.json）');

const { HeroDataModule } = built.mod('game', 'data', 'funcs', 'HeroData.js');
const heroData = new HeroDataModule();

check('D1 默认档案：火枪 1001 已解锁 Lv.1（记录形态 = id + level，**没有 per-hero 经验**了）',
    heroData.getHeroInfo(1001), { id: 1001, level: 1 });
check('D1b 通用英雄经验池初始为 0', heroData.getSharedExp(), 0);
check(`D2 升 2 级所需经验 = heroExpFormulaBase（${expBase}）`, heroData.getExpForNextLevel(1), expBase);
check(`D3 升 3 级所需经验 = floor(${expBase}×${expRatio})`, heroData.getExpForNextLevel(2), Math.floor(expBase * expRatio));
check('D4 等级 0/负数按 1 级算（不出现 0 或 NaN 的进度分母）',
    [heroData.getExpForNextLevel(0), heroData.getExpForNextLevel(-3)], [expBase, expBase]);

// 2026-11 口径：**发经验只进池、不自动升级** —— 升级是玩家在详情弹窗里点出来的
check('D5 发经验 → 只进池，等级一动不动（发经验即自动升级的循环已删除）', (() => {
    heroData.addSharedExp(expBase);
    return [heroData.getHeroInfo(1001).level, heroData.getSharedExp()];
})(), [1, expBase]);
check('D6 池子刚好够一级 → tryLevelUp 成功：等级 +1、池子扣空', (() => {
    const r = heroData.tryLevelUp(1001);
    return [r.ok, r.reason, r.cost, r.level, heroData.getSharedExp()];
})(), [true, '', expBase, 2, 0]);
check('D7 池子不够 → 拒绝升级、**一个字节都不动**（等级与池子都不变）', (() => {
    const r = heroData.tryLevelUp(1001);
    return [r.ok, r.reason, r.cost, r.level, heroData.getSharedExp()];
})(), [false, 'no_exp', 0, 2, 0]);
check('D7b 未解锁的英雄不能升级（只能先花金币解锁）', (() => {
    const r = heroData.tryLevelUp(1002);
    return [r.ok, r.reason];
})(), [false, 'locked']);
check('D7c 池子够两级 → 也要点两次（一次只升一级，玩家自己决定花不花）', (() => {
    heroData.addSharedExp(heroData.getExpForNextLevel(2) + heroData.getExpForNextLevel(3));
    const first = heroData.tryLevelUp(1001);
    heroData.tryLevelUp(1001);
    return [first.level, heroData.getHeroInfo(1001).level, heroData.getSharedExp()];
})(), [3, 4, 0]);

// 配表把 heroExpFormulaBase 配成 0 = 曾经的**死循环**（exp -= 0; level += 1 → 整局卡死且无报错）。
// 现在的形态是"免费升级"：解锁是一次性的，升级无上限，放行就是点一下升一级 → 必须拒绝。
globalThis.__heroExpBase = 0;
const before = heroData.getHeroInfo(1001).level;
const freeTry = heroData.tryLevelUp(1001);
check('D8 base=0（配表配错）→ 拒绝升级（不免费白送等级）',
    [freeTry.ok, freeTry.reason, heroData.getHeroInfo(1001).level], [false, 'no_formula', before]);
check('D9 base=0 时下一级所需 = 0（卡片据此收起经验条，见 C3）', heroData.getExpForNextLevel(before), 0);
globalThis.__heroExpBase = undefined;

// 解锁写记录时不能再塞 `exp`（per-hero 经验已下线；老存档里多出来的字段读档时被忽略）
check('D10 解锁写进去的记录只有 id + level',
    (() => { heroData.unlockHero(1002); return Object.keys(heroData.getHeroInfo(1002)).sort(); })(), ['id', 'level']);

/* ---------- F 两态判据（真 HeroVM.ts + 假数据层）----------
 *
 * 这一组回答的是**用户看得见的那件事**：「未解锁时，消耗够的话解锁按钮要是能点的状态；解锁后状态改变」。
 * `HeroVM` 是卡片与弹窗共用的唯一判据落点（两个消费方各写一份的话迟早会"卡片说能点、弹窗说不能点"），
 * 所以只要把它的两态分支钉住，两处界面就都不会错。
 */
group('F 两态判据（真 HeroVM.ts + 假 DataCenter/HeroConfig）');

const { buildCardVM, buildDetailVM } = built.mod('game', 'ui', 'scenes', 'scene_menu', 'cmps', 'HeroVM.js');
const heroCfgStub = require(path.join(built.out, SRC, 'game/data/configs/HeroConfig.js'));

const CFG_1001 = { id: 1001, name: '火枪', head_icon: 'textures/heros/huoqiang' };
const CFG_1002 = { id: 1002, name: '赏金猎人', head_icon: 'textures/heros/shangjin' };

/** 摆一份假数据层状态（`records` 里没有那个 id = 未解锁） */
const fakeState = (o = {}) => {
    globalThis.__heroFake = {
        gold: o.gold ?? 0,
        exp: o.exp ?? 0,
        records: o.records ?? [],
        noFormula: !!o.noFormula,
    };
};

fakeState({ gold: 2000 });
const fLocked = buildCardVM(CFG_1002);
check('F1 未解锁 + 金币够 → 花金币、价 = 解锁价、**按钮可点**',
    [fLocked.unlocked, fLocked.costKind, fLocked.cost, fLocked.enabled], [false, 'gold', 2000, true]);

fakeState({ gold: 1999 });
const fPoor = buildCardVM(CFG_1002);
check('F2 未解锁 + 金币差 1 → 按钮置灰（不可点）', [fPoor.costKind, fPoor.enabled], ['gold', false]);

fakeState({ gold: 1999, exp: 100, records: [{ id: 1002, level: 1 }] });
const fOpen = buildCardVM(CFG_1002);
check('F3 **解锁后同一个函数给出另一份 VM**：改花经验、价 = 本级所需、经验够 → 可点',
    [fOpen.unlocked, fOpen.costKind, fOpen.cost, fOpen.enabled], [true, 'exp', 100, true]);
check('F3b 解锁后金币不再参与判断（只剩 1999，照样能升级）', fOpen.enabled, true);

fakeState({ gold: 999999, exp: 99, records: [{ id: 1002, level: 1 }] });
const fNoExp = buildCardVM(CFG_1002);
check('F4 已解锁 + 经验差 1 → 不可点（金币再多也不管用：金币只用于解锁）',
    [fNoExp.costKind, fNoExp.enabled], ['exp', false]);

fakeState({ gold: 0, exp: 999, records: [{ id: 1001, level: 1 }], noFormula: true });
const fNoFormula = buildCardVM(CFG_1001);
check('F5 已解锁 + 价 0（配表没给经验口径）→ **不可点**（无上限的升级不能白送）',
    [fNoFormula.cost, fNoFormula.enabled], [0, false]);

fakeState({ gold: 0, records: [] });
const fFree = buildCardVM(CFG_1001);
check('F5b 未解锁 + 价 0（配表把解锁价配成 0 的免费英雄）→ 可点（一次性，白送得起）',
    [fFree.costKind, fFree.cost, fFree.enabled], ['gold', 0, true]);

fakeState({ gold: 500, exp: 250, records: [{ id: 1001, level: 1 }] });
const detailVM = buildDetailVM(1001);
const cardVM = buildCardVM(CFG_1001);
check('F6 弹窗 VM 与卡片 VM **同源**（解锁态 / 花什么 / 花多少 / 能不能点逐字相同）',
    [detailVM.unlocked === cardVM.unlocked, detailVM.costKind === cardVM.costKind,
    detailVM.cost === cardVM.cost, detailVM.enabled === cardVM.enabled], [true, true, true, true]);
check('F6b 弹窗铺的是**真配了的那 5 行**（含魔法 / 攻速，不是卡片那 4 行）', detailVM.attrs.length, 5);
check('F6c 技能三件套带上了（名字里的「(被动)」由 HeroConfig 剥掉、改由 tag 表达）',
    [!!detailVM.skill, detailVM.skill.tag], [true, '（被动）']);
check('F6d 两个资源读数都在（遮罩会盖住顶栏，必须画进面板）',
    [detailVM.gold, detailVM.exp], [500, 250]);

fakeState({ gold: 0, records: [] });
check('F7 配表里没有的 id → null（宿主据此收起弹窗，而不是画个空壳）', buildDetailVM(9999), null);
check('F8 未解锁的英雄 → 属性行按 **1 级**算（不是 0 级）',
    (() => { buildDetailVM(1002); return heroCfgStub.__lastAttrLevel; })(), 1);
fakeState({ gold: 0, exp: 0, records: [{ id: 1002, level: 3 }] });
check('F8b 已解锁 → 属性行按**真实等级**算', (() => { buildDetailVM(1002); return heroCfgStub.__lastAttrLevel; })(), 3);

/* ---------- E 风格口径（真源 = docs/art-style/tokens.json，2026-10 收敛时补的一道门禁） ---------- */

group('E 风格口径（真源 = docs/art-style/tokens.json + 美术风格预设 §4 字号阶梯）');

const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/art-style/tokens.json'), 'utf8'));
const palette = new Set();
for (const g of tokens.palette) for (const t of g.tokens) palette.add(String(t.hex).toUpperCase());
const fontLadder = new Set(tokens.typography.scale.map((s) => s.size));

const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const nodeIdx2 = (names) => nodeIdxAt(prefab, rootIdx, names);

/** 组件元素 → 它挂在哪个节点上（只给失败信息用：`exp_bar: #B6BABE` 比一个孤零零的色值好查） */
const compOwnerName = new Map();
for (const e of prefab) if (e.__type__ === 'cc.Node') for (const c of e._components || []) compOwnerName.set(c.__id__, e._name);
const nodeNameOf = (compEl) => compOwnerName.get(prefab.indexOf(compEl)) ?? '?';

const compOn = (names, type) => {
    const idx = nodeIdx2(names);
    if (idx < 0) return null;
    return (prefab[idx]._components || []).map((c) => prefab[c.__id__]).find((c) => c.__type__ === type) ?? null;
};
/** 同一个东西，但入参是节点元素本身（E7 要在 unlock 的子节点上取 UITransform） */
const compOnEl = (nodeEl, type) => (nodeEl._components || []).map((c) => prefab[c.__id__]).find((c) => c.__type__ === type) ?? null;

// 卡片里出现的**每一个**颜色与字号（Sprite/Label 全算），逐条对规范真源
const offPalette = [];
const offLadder = [];
for (const e of prefab) {
    if (e.__type__ !== 'cc.Sprite' && e.__type__ !== 'cc.Label') continue;
    const owner = nodeNameOf(e);
    if (e._color) {
        const hex = hexOf(e._color);
        if (!palette.has(hex)) offPalette.push(`${owner}:${hex}`);
    }
    if (e.__type__ === 'cc.Label' && !fontLadder.has(e._fontSize)) offLadder.push(`${owner}:${e._fontSize}`);
}
check('E1 卡片里的颜色都在 tokens.json 色板里（青绿/身份/墨色/纸面/语义）', offPalette, []);
check('E2 卡片的字号都在阶梯上（40/24/20/16/14/12）', offLadder, []);
check('E3 不再引用引擎内置贴图（default_sprite_splash 一律换成自有 white_4x4）',
    prefab.filter((e) => e.__type__ === 'cc.Sprite' && String(e._spriteFrame?.__uuid__).startsWith('7d8f9b89')).length, 0);
check('E4 经验条：轨道 = ink-200、填充 = accent-400',
    [hexOf(compOn(['exp_bar'], 'cc.Sprite')._color), hexOf(compOn(['exp_bar', 'Bar'], 'cc.Sprite')._color)],
    ['#D8D8D8', '#70ACB3']);
check('E5 等级：前缀 16（Body）/ 数字 20（H2）',
    [compOn(['lv'], 'cc.Label')._fontSize, compOn(['lv', 'value'], 'cc.Label')._fontSize], [16, 20]);
// 本卡约定 `lineHeight = fontSize`（`0` = 引擎自动，也算自洽）。
// 为什么值得盯：overflow=NONE 时节点高 = `lineHeight × 1.26`，字号改小而不动 lineHeight 会留下
// 一个"虚高"的框（实测 `name`/两个按钮 Label 都还留着 40px 时代的 `lineHeight = 40` → 框高 50.4，
// 对渲染无影响，但编辑器里做重叠/越界检查会失真）。改字号时忘了改它，这条断言会红。
check('E6 Label 的 `lineHeight` 与字号自洽（不留改版前字号时代的残值）',
    prefab.filter((e) => e.__type__ === 'cc.Label' && e._lineHeight !== 0 && e._lineHeight !== e._fontSize)
        .map((e) => `${nodeNameOf(e)}: fs${e._fontSize}/lh${e._lineHeight}`), []);

/**
 * 节点在父节点局部坐标里的矩形（用 `position + anchor + contentSize` 自洽累加，同 `worldRect` 的口径）。
 * 用来验「一颗按钮的三件必须成组」—— 2026-10 之前金币图标与价格被摆在了 80×40 按钮**矩形之外**
 * （价格飘在按钮左边 10px），点得着但读起来不像一组；现在按同页成就卡那个组件收进 140×40 里。
 */
const rectIn = (nodeEl, parentEl) => {
    const ut = compOnEl(nodeEl, 'cc.UITransform');
    const w = ut._contentSize.width; const h = ut._contentSize.height;
    const cx = parentEl._lpos.x + nodeEl._lpos.x + (0.5 - ut._anchorPoint.x) * w;
    const cy = parentEl._lpos.y + nodeEl._lpos.y + (0.5 - ut._anchorPoint.y) * h;
    return { l: cx - w / 2, r: cx + w / 2, b: cy - h / 2, t: cy + h / 2 };
};
const unlockEl = prefab[nodeIdx2(['unlock'])];
const unlockRect = rectIn(unlockEl, { _lpos: { x: 0, y: 0 } });
const piecesOut = (unlockEl._children || []).map((c) => prefab[c.__id__]).filter((n) => n._name !== 'lock').map((n) => {
    const r = rectIn(n, unlockEl);
    const ok = r.l >= unlockRect.l - 0.5 && r.r <= unlockRect.r + 0.5 && r.b >= unlockRect.b - 0.5 && r.t <= unlockRect.t + 0.5;
    return ok ? null : `${n._name}(l${r.l.toFixed(1)} r${r.r.toFixed(1)})`;
}).filter(Boolean);
check('E7 解锁/升级按钮 = 140×40，且文案·金币图标·价格**三件都在按钮框内**（不许飘在框外）',
    [`${unlockEl ? compOn(['unlock'], 'cc.UITransform')._contentSize.width : '?'}x${compOn(['unlock'], 'cc.UITransform')._contentSize.height}`,
        piecesOut, compOn(['unlock', 'Label'], 'cc.Label')._fontSize], ['140x40', [], 16]);

/**
 * 风格规范是**三处同源**（`docs/美术风格预设.md` §1 + `docs/art-style/tokens.json` + `docs/art-style/index.html`，
 * 文档自己规定的"改色必须三处同改"）。2026-10 补这道门禁时它当场抓出两条真缺口：
 * `c-gold` 只活在 tokens/样式板里、§1 根本没有它；`c-scrim` 没进样式板的色板格子。
 * 带 alpha 的 token（`c-scrim`）在 md/样式板里写的是 `rgba(...)`，所以对它只校 token 名。
 */
const mdDoc = fs.readFileSync(path.join(ROOT, 'docs/美术风格预设.md'), 'utf8');
const htmlDoc = fs.readFileSync(path.join(ROOT, 'docs/art-style/index.html'), 'utf8');
const trioMissing = [];
for (const g of tokens.palette) {
    for (const t of g.tokens) {
        const hex = String(t.hex).toUpperCase();
        const inMd = t.alpha !== undefined
            ? new RegExp('\\| `' + t.name + '` \\| `?rgba').test(mdDoc)
            : new RegExp('\\| `' + t.name + '` \\| `' + hex + '`').test(mdDoc);
        const inCssVar = new RegExp('--' + t.name + ':').test(htmlDoc);
        const inSwatch = new RegExp("'--" + t.name + "'").test(htmlDoc);
        if (!(inMd && inCssVar && inSwatch)) trioMissing.push(`${t.name}(${hex}) md=${inMd} cssVar=${inCssVar} swatch=${inSwatch}`);
    }
}
check('E8 风格规范三处同源（tokens.json 每个 token 都在 §1 与样式板里）', trioMissing, []);

/* ---------- G 销毁：子节点先销毁、本节点组件后销毁 ----------
 *
 * 真机踩到的（用户报的那条栈）：
 * ```
 * TypeError: Cannot read properties of null (reading 'length')
 *     at Node._findComponent (node.ts:309)   ← comps = node._components 已经是 null
 *     at Node.getComponent (node.ts:899)
 *     at HeroCard.detailBtn (HeroCard.ts:386) ← 销毁时又去 getComponent 找按钮
 *     at HeroCard.onDispose (HeroCard.ts:181)
 * ```
 * 为什么 `_components` 会是 null：引擎销毁一个节点时（`node.ts:1532-1545` 实测）
 *  ① 先 `this._eventProcessor.destroy()`，
 *  ② **再递归销毁全部子节点**（`children[i]._destroyImmediate()` → 每个对象跑 `_destruct()`，
 *     own 字段一律置 null，`Node._components` 就在其中），
 *  ③ **最后才是本节点自己的组件**（`comps[i]._destroyImmediate()` → `onDestroy` → `onDispose`）。
 * 所以 `onDispose` 跑起来时，卡片下面那棵子树**已经是空壳**：`getChildByName` 拿到的节点还在手上，
 * 但 `getComponent` 一进去就炸。`UIWidget` 已 try/catch 兜住（画面不会卡死），但那条报错本身
 * 说明"销毁路径碰了别的组件"—— 本组就是把它钉住：**按钮引用必须在 `onInit` 就记下来**。
 */
group('G 销毁（模拟引擎级联：先子节点、后本节点组件）');

/**
 * 模拟引擎的销毁级联第一步（`node.ts:1532-1537`）：递归销毁子树 + 对每个对象跑 `_destruct()`。
 * 只销毁**后代**，本节点自己的组件留给调用方（对应 ③ 那一步的 `onDestroy`）。
 */
function destroySubtreeLikeEngine(node) {
    for (const child of node._children || []) {
        destroySubtreeLikeEngine(child);
        for (const c of child._components || []) {
            for (const k of Object.keys(c)) c[k] = null;   // `CCObject._destruct()`：对象字段置 null
        }
        child._components = null;       // ← `Node._findComponent` 读 null.length 的就是它
        child._eventProcessor = null;   // ← `Node.off` = `_eventProcessor.off(...)` 也一并没了
        child.isValid = false;
        child._destroyed = true;
    }
    node._children = [];
}

// ① 节点还活着、只销毁组件（`removeComponent` / 换局回收）→ 两条监听都要**真的摘掉**（不许改成"干脆不退订"）
const liveCard = spawnCard(cc.buildTree(prefab, rootIdx));
const liveDetail = liveCard.node.getChildByName('detail');
const liveUnlock = liveCard.node.getChildByName('unlock');
const clickOn = (n) => (n._onCalls || []).filter((e) => e.type === cc.Button.EventType.CLICK).length;
const unclickOn = (n) => (n._offCalls || []).filter((e) => e.type === cc.Button.EventType.CLICK).length;
check('G1 onInit 把「详 情」「解 锁/升 级」两个 CLICK 挂上了', [clickOn(liveDetail), clickOn(liveUnlock)], [1, 1]);
liveCard.onDestroy();
check('G2 节点还活着时 → 两条 CLICK 都摘干净（不是靠"节点反正要没了"蒙混过关）',
    [unclickOn(liveDetail), unclickOn(liveUnlock)], [1, 1]);

// ② 真机顺序：后代已被 `_destruct`，此后才轮到卡片自己的组件
const dyingTree = cc.buildTree(prefab, rootIdx);
const dyingCard = spawnCard(dyingTree);
const dyingDetail = dyingCard.node.getChildByName('detail');
const dyingUnlock = dyingCard.node.getChildByName('unlock');
destroySubtreeLikeEngine(dyingCard.node);

// 负控：老写法（`onDispose` 里 `detailBtn(false)` → `node.getComponent`）在同一状态下必抛 —— 这就是用户报的那条
let legacyErr = null;
try { dyingDetail.getComponent(cc.Button); } catch (e) { legacyErr = e.constructor.name; }
check('G3 负控：对已被 `_destruct` 的后代节点 `getComponent` 必抛 TypeError（= 真机 node.ts:309 那条）',
    legacyErr, 'TypeError');

// 正题：真 `onDestroy()`（引擎在 ③ 那一步调的就是它）不许抛，且**一次 `getComponent` 都不许有**。
// ⚠ 只断言"没抛"是不够的：`UIWidget.onDestroy` 把 `onDispose` 包在 try/catch 里（防的是堵死引擎销毁队列），
//   所以"抛了"也看不出来 —— 这里连**那条兜底 catch 的日志**一起数（`UIWidget.ts:64` 的固定文案）。
const swallowedBefore = consoleLogs.error.filter((l) => l.includes('onDispose 抛异常')).length;
let disposeErr = null;
let getComponentCalls = 0;
const origGetComponent = cc.Node.prototype.getComponent;
cc.Node.prototype.getComponent = function (...a) { getComponentCalls++; return origGetComponent.apply(this, a); };
try {
    dyingCard.onDestroy();
} catch (e) {
    disposeErr = `${e.constructor.name}: ${e.message}`;
} finally {
    cc.Node.prototype.getComponent = origGetComponent;
}
const swallowed = consoleLogs.error.filter((l) => l.includes('onDispose 抛异常')).length - swallowedBefore;
check('G4 子节点已销毁 → 不抛异常，也没走 `UIWidget` 的兜底 catch（走了就会打「onDispose 抛异常」）',
    [disposeErr, swallowed], [null, 0]);
check('G4b 销毁期间一次 `getComponent` 都没有（按钮引用是 `onInit` 记下来的组件，不是销毁时现找的）',
    getComponentCalls, 0);
check('G4c 记下来的两个按钮引用此刻已被 `_destruct`（`.node` = null）→ `offNodeEvent` 天然跳过',
    [!!dyingCard.detailButton, !!dyingCard.actionButton,
        dyingCard.detailButton?.node ?? null, dyingCard.actionButton?.node ?? null],
    [true, true, null, null]);
check('G5 跳过是"连碰都不碰"：已销毁的两个按钮节点上一个事件调用都没有（跳过不会泄漏，监听随节点消亡）',
    [unclickOn(dyingDetail), unclickOn(dyingUnlock)], [0, 0]);

/* ===================================================================
 * H 英雄详情弹窗（真 Cmp_HeroDetail.ts × 真 Scene_Menu.prefab 子树 × 真 HeroVM）
 * ===================================================================
 *
 * 为什么要有这一组：A~E 组覆盖 `HeroCard` + `HeroItem.prefab`，F 组覆盖判据 `HeroVM`，
 * **弹窗组件本身原先零覆盖** —— 于是"未解锁时消耗够的话按钮能点、解锁后状态改变"这条链
 * 只能靠读代码推（上一次交付里就是这么推的）。本组把**真组件跑在真预制件子树上**，
 * 把那条链的每一环都钉住：
 *   ① 23 个 `@property` 引用与"按名字兜底"两条路都能解析到；② 三态互斥；
 *   ③ 按钮两态色 + 能不能点；④ **点一下真的冒泡出事件**（事件名 + heroId）；
 *   ⑤ `onDispose` 的收尾不碰别的组件（与 G 组同一套引擎级联模型）。
 *
 * 两处刻意的桩：
 *   · `_scope` 直接塞**假作用域**（只记账 `emit`）—— 冒泡路径是 `UIScope` 的事，它有自己的一套；
 *     本组要证明的是"组件在这一下里发出了什么"。
 *   · 节点事件只有记账、没有派发（真 `Node.on/off` 在 cc 桩里是记账式），
 *     所以"点一下"= 取 `_onCalls` 里登记的那对 `(cb, target)` 直接调 —— 与引擎调的是同一对。
 */
group('H 英雄详情弹窗（真 Cmp_HeroDetail.ts × 真 Scene_Menu.prefab 子树 × 真 HeroVM）');

/** 被体检的场景预制件（`HERO_DETAIL_PREFAB` 可覆盖成临时副本做负控） */
const MENU_PREFAB_PATH = process.env.HERO_DETAIL_PREFAB
    || path.join(ROOT, 'assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab');
const DETAIL_NODE = 'ui_hero_detail';
const menuPrefab = JSON.parse(fs.readFileSync(MENU_PREFAB_PATH, 'utf8'));
const detailNodeIdx = menuPrefab.findIndex((e) => e && e.__type__ === 'cc.Node' && e._name === DETAIL_NODE);
if (detailNodeIdx < 0) {
    console.error(`✖ ${path.relative(ROOT, MENU_PREFAB_PATH)} 里找不到节点 ${DETAIL_NODE}`);
    process.exit(2);
}
/** 弹窗节点上那个**脚本**组件（非 `cc.*`）= `Cmp_HeroDetail` 的序列化引用表 */
const detailCompEl = (menuPrefab[detailNodeIdx]._components || [])
    .map((r) => menuPrefab[r.__id__])
    .find((c) => c && !String(c.__type__).startsWith('cc.'));
if (!detailCompEl) {
    console.error(`✖ ${DETAIL_NODE} 上没有脚本组件 —— 预制件里没挂 Cmp_HeroDetail？`);
    process.exit(2);
}

const { Cmp_HeroDetail } = built.mod('game', 'ui', 'scenes', 'scene_menu', 'cmps', 'Cmp_HeroDetail.js');
const { HeroScopeEvents } = built.mod('game', 'ui', 'scenes', 'scene_menu', 'cmps', 'HeroScope.js');

/** 弹窗的 `@property` 引用（排除 `__prefab`/`__editorExtras__` 这类引擎字段） */
const DETAIL_REF_FIELDS = Object.keys(detailCompEl)
    .filter((k) => !k.startsWith('__'))
    .filter((k) => detailCompEl[k] && typeof detailCompEl[k] === 'object' && '__id__' in detailCompEl[k]);

/** 假作用域：只记账 emit，其余 no-op（`UIWidget.onEnable/onDestroy` 会碰 resume/pause/dispose） */
function makeScopeSpy() {
    const emitted = [];
    return {
        emitted,
        on() { return this; },
        off() { return this; },
        emit(type, ...args) { emitted.push({ type, args }); return true; },
        watch() { return () => { }; },
        provide(_k, v) { return v; },
        inject(_k, fallback) { return fallback; },
        resume() { }, pause() { }, dispose() { },
    };
}

/**
 * 起一个真弹窗。
 *
 * @param opts.refs   `false` = 模拟"作者一个引用都没拖"（走 `resolveRefs` 的按名字兜底）
 * @param opts.mangle 在 `onInit` 之前改一改假节点树（负控用：摘掉契约里的某个节点）
 */
function spawnDetail(opts = {}) {
    const tree = cc.buildTree(menuPrefab, detailNodeIdx);
    if (opts.mangle) opts.mangle(tree);
    const detail = new Cmp_HeroDetail();
    detail.node = tree.node;
    if (opts.refs !== false) {
        for (const field of DETAIL_REF_FIELDS) detail[field] = tree.byId.get(detailCompEl[field].__id__) ?? null;
    }
    const scope = makeScopeSpy();
    detail._scope = scope;      // 私有字段，运行时直接塞（假作用域只负责记账）
    detail.onInit();
    return { detail, tree, scope };
}

/* ---------- H1 节点契约 ---------- */

const CONT = spawnDetail();
const D = CONT.detail;

check('H1 真预制件里真拖的引用：23 个 `@property` 全部解析到（少一个就是契约破了）',
    DETAIL_REF_FIELDS.filter((f) => !D[f]), []);
check('H1b 一个引用都不拖时，`resolveRefs` 按名字兜底也要全解析到（这是它写进注释的契约）',
    DETAIL_REF_FIELDS.filter((f) => !spawnDetail({ refs: false }).detail[f]), []);
check('H1c 属性行 5 行都在（`attr_1` ~ `attr_5`）', D.attrRows.length, 5);
check('H1d 契约完整时**不打**「子节点契约不完整」告警', ezLogs.warn.filter((l) => l.includes('子节点契约不完整')).length, 0);

// 负控：真缺一个契约节点、且没有可兜的引用 → 必须出声（不是静默画个空壳）
const warnMark = ezLogs.warn.length;
spawnDetail({
    refs: false,
    mangle: (tree) => {
        const header = tree.node.getChildByPath('panel/header');
        header._children = header._children.filter((c) => c.name !== 'name');
    },
});
check('H1e 负控：契约真缺 `panel/header/name` → 必打「子节点契约不完整」告警',
    ezLogs.warn.slice(warnMark).some((l) => l.includes('子节点契约不完整')), true);

/* ---------- H2 三态渲染（VM 来自真 HeroVM.buildDetailVM） ---------- */

const hx = (c) => hexOf(c);
const btnOf = (detail) => detail.btnSprite.node.getComponent(cc.Button);
const fireClick = (node) => {
    const hit = (node._onCalls || []).find((e) => e.type === cc.Button.EventType.CLICK);
    if (!hit) return false;
    hit.cb.apply(hit.target, []);
    return true;
};

fakeState({ gold: 500, exp: 400, records: [{ id: 1001, level: 3 }] });
D.setVM(buildDetailVM(1001));
check('H2 已解锁态：锁收起 / 等级药丸与经验块显示 / **金币读数也在**（遮罩盖住了顶栏，两个读数都得画在面板里）',
    [D.lockNode.active, D.lvNode.active, D.expNode.active, D.goldNode.active], [false, true, true, true]);
check('H2b 已解锁态：名字与等级来自 VM', [D.nameLabel.string, D.lvValueLabel.string], ['火枪', '3']);
check('H2c 已解锁态：按钮「升 级」+ 花经验 + 亮青可点',
    [D.btnLabel.string, D.costLabel.string, hx(D.btnSprite.color), btnOf(D).interactable],
    ['升 级', '升级花费经验', '#3F9E9B', true]);

fakeState({ gold: 2000, exp: 0, records: [] });
D.setVM(buildDetailVM(1002));
check('H3 未解锁态：盖锁 / 等级与经验收起 / **金币读数照样显示**（这一步花的就是金币，余额必须看得见 —— '
    + '这里原先写成 `active = vm.unlocked`，正好反了）',
    [D.lockNode.active, D.lvNode.active, D.expNode.active, D.goldNode.active, D.goldValueLabel.string],
    [true, false, false, true, '2,000']);
check('H3b 未解锁态 + 金币够：按钮「解 锁」+ 花金币 + **亮青可点**（用户点名的那条）',
    [D.btnLabel.string, D.costLabel.string, hx(D.btnSprite.color), btnOf(D).interactable],
    ['解 锁', '解锁花费金币', '#3F9E9B', true]);
check('H3c 未解锁态：面板其余部分置灰（真材质），**按钮子树单独复原**（灰面板 + 亮按钮 = 一眼看出这里能买）',
    [D.nameLabel.customMaterial === cc.GRAY_MAT, D.btnSprite.customMaterial], [true, null]);

fakeState({ gold: 1999, exp: 0, records: [] });
D.setVM(buildDetailVM(1002));
check('H4 未解锁 + 金币差 1 → 按钮 `c-disabled-pill` 且 `interactable=false`，**页面其余部分保持置灰态不变**',
    [hx(D.btnSprite.color), btnOf(D).interactable, D.nameLabel.customMaterial === cc.GRAY_MAT],
    ['#B9C1C1', false, true]);

fakeState({ gold: 999999, exp: 99, records: [{ id: 1001, level: 1 }] });
D.setVM(buildDetailVM(1001));
check('H5 已解锁 + 经验差 1 → 灰按钮不可点（金币再多也不管用）',
    [hx(D.btnSprite.color), btnOf(D).interactable], ['#B9C1C1', false]);

fakeState({ gold: 0, exp: 0, records: [] });
D.setVM(buildDetailVM(1001));
check('H6 价 0（配表把解锁价配成 0 的免费英雄）→ 价格整格收起，不留一个孤零零的「0」',
    [D.costLabel.node.active, D.costValueLabel.node.active, D.costIconSprite.node.active, btnOf(D).interactable],
    [false, false, false, true]);

/* ---------- H7 点击链：这一组的正题 ---------- */

const btnNodeOf = (tree) => tree.node.getChildByPath('panel/detail/btn_upgrade');
const closeNodeOf = (tree) => tree.node.getChildByPath('panel/header/btn_close');

fakeState({ gold: 2000, exp: 0, records: [] });
D.setVM(buildDetailVM(1002));
check('H7 两次 `onInit` 之后按钮上只有**一条** CLICK（重复初始化会挂两遍 → 点一下扣两次）',
    (btnNodeOf(CONT.tree)._onCalls || []).filter((e) => e.type === cc.Button.EventType.CLICK).length, 1);
check('H7b 未解锁 + 够钱：真节点上点一下 → 冒泡 `hero:unlock` + heroId（不是"看起来能点"，是**真的发出了那件事**）',
    (fireClick(btnNodeOf(CONT.tree)), CONT.scope.emitted), [{ type: HeroScopeEvents.Unlock, args: [1002] }]);

fakeState({ gold: 2000, exp: 999, records: [{ id: 1001, level: 2 }] });
D.setVM(buildDetailVM(1001));
check('H7c 已解锁 + 经验够：点一下 → 冒泡 `hero:levelup` + heroId（花的是经验，不是金币）',
    (fireClick(btnNodeOf(CONT.tree)), CONT.scope.emitted.slice(-1)),
    [{ type: HeroScopeEvents.LevelUp, args: [1001] }]);

fakeState({ gold: 0, exp: 0, records: [] });
D.setVM(buildDetailVM(1002));
const emittedBefore = CONT.scope.emitted.length;
fireClick(btnNodeOf(CONT.tree));
check('H7d 不可点（金币不够）时点了**什么都不发**（防御在组件里，不只靠 `interactable`）',
    CONT.scope.emitted.length, emittedBefore);

D.setVM(null);
fireClick(btnNodeOf(CONT.tree));
check('H7e 没有 VM（宿主收起弹窗）时点了也什么都不发（不会拿旧 heroId 乱发）',
    CONT.scope.emitted.length, emittedBefore);

fireClick(closeNodeOf(CONT.tree));
check('H7f 点「关闭 ×」→ 冒泡 `hero:detail:close`（且**不带参**：关弹窗不涉及是哪个英雄）',
    CONT.scope.emitted.slice(-1), [{ type: HeroScopeEvents.CloseDetail, args: [] }]);

const sceneMenuSrc = fs.readFileSync(path.join(ROOT, SRC, 'game/ui/scenes/scene_menu/Scene_Menu.ts'), 'utf8');
check('H7g 弹窗冒泡的四个事件在宿主 `Scene_Menu.ts` 里都有落点（发/收不脱节）',
    Object.values(HeroScopeEvents).filter((e) => !sceneMenuSrc.includes(`'${e}'`) && !sceneMenuSrc.includes(`HeroScopeEvents.`)),
    []);

/* ---------- H8 数值与文案 ---------- */

fakeState({ gold: 0, exp: 60, records: [{ id: 1001, level: 1 }] });
D.setVM(buildDetailVM(1001));
check('H8 经验没满：读数 `持有 / 本级所需`，提示「还差 N 经验」',
    [D.expTextLabel.string, D.expHintLabel.string], ['60 / 100', '还差 40 经验']);

fakeState({ gold: 0, exp: 9999, records: [{ id: 1001, level: 1 }] });
D.setVM(buildDetailVM(1001));
check('H8b 脏存档（经验池比本级所需还大）→ 进度条**钳在 1**，不会画到框外；提示改口「可以升级」',
    [D.expBar.progress, D.expHintLabel.string], [1, '经验已足够，可以升级']);

const fullVM = buildDetailVM(1001);
D.setVM({ ...fullVM, attrs: fullVM.attrs.slice(0, 3) });
check('H8c VM 只给 3 行属性 → 后两行**整行收起**（不留空壳）',
    D.attrRows.map((r) => r.active), [true, true, true, false, false]);
D.setVM({ ...fullVM, skill: null });
check('H8d VM 没给技能 → 技能块整块收起', D.skillNode.active, false);
D.setVM(fullVM);
check('H8e 5 行属性写到正确的节点上（第 1 行的名字/值来自 VM 第 1 项）',
    [D.attrRows[0].getChildByName('name').getComponent(cc.Label).string,
    D.attrRows[0].getChildByName('value').getComponent(cc.Label).string],
    [fullVM.attrs[0].name, fullVM.attrs[0].valueText]);

/* ---------- H9 收尾：onDispose 不许碰别的组件（与 G 组同一套引擎级联） ---------- */

/**
 * 真引擎的销毁顺序（`node.ts:1493-1545`）：**先递归销毁后代**（每个对象跑 `_destruct()`：
 * 对象/函数字段置 null、**字符串字段置 ''**），**最后**才轮到本节点自己的组件（`onDestroy` → `onDispose`）。
 * 与 G 组那份模拟的差别：这里**不把 `_children` 清空** —— 真引擎里 `destroyByParent` 时子节点不会
 * 把自己从父的 `_children` 里摘掉，所以 `onDispose` 里 `getChildByPath('panel')` 是**逐段比对空名字**
 * 之后返回 null 的（`_name` 被清空正是它现在能安全返回 null 的原因，也正是不该依赖它的原因）。
 *
 * ⚠ 真引擎里 `_destruct()` 只在**非编辑器**进程跑（`object.ts:377` 的 `EDITOR_NOT_IN_PREVIEW`）。
 * 编辑器里对象字段还在 —— 但那条路同样安全：节点 `_objFlags` 已置 `Destroyed`，
 * 于是 `offNodeEvent` 的 `!node.isValid` 判断会跳过。两条路都得安全，本组按更严的**真机那条**验。
 */
function destroySubtreeLikeEngineKeepShell(node) {
    for (const child of node._children || []) {
        destroySubtreeLikeEngineKeepShell(child);
        for (const c of child._components || []) {
            for (const k of Object.keys(c)) c[k] = null;
        }
        child._components = null;
        child._eventProcessor = null;
        child.name = '';        // 桩里的字段名是 `name`（真引擎是 `_name`，同样被清成 ''）
        child._name = '';
        child.isValid = false;
        child._destroyed = true;
    }
}

const hLiveDetail = spawnDetail();
hLiveDetail.detail.onDestroy();
check('H9 节点还活着时只销毁组件 → 两条 CLICK 都**真的摘掉**（不许靠"节点反正要没了"蒙混）',
    [(closeNodeOf(hLiveDetail.tree)._offCalls || []).length,
    (btnNodeOf(hLiveDetail.tree)._offCalls || []).length], [1, 1]);

const hDying = spawnDetail();
destroySubtreeLikeEngineKeepShell(hDying.tree.node);
const hSwallowedBefore = consoleLogs.error.filter((l) => l.includes('onDispose 抛异常')).length;
let hDisposeErr = null;
let hGetComponent = 0;
const hOrigGetComponent = cc.Node.prototype.getComponent;
cc.Node.prototype.getComponent = function (...a) { hGetComponent++; return hOrigGetComponent.apply(this, a); };
try {
    hDying.detail.onDestroy();
} catch (e) {
    hDisposeErr = `${e.constructor.name}: ${e.message}`;
} finally {
    cc.Node.prototype.getComponent = hOrigGetComponent;
}
const hSwallowed = consoleLogs.error.filter((l) => l.includes('onDispose 抛异常')).length - hSwallowedBefore;
check('H9b 后代已是空壳 → `onDispose` 不抛、也不走 `UIWidget` 的兜底 catch',
    [hDisposeErr, hSwallowed], [null, 0]);
check('H9c 收尾期间一次 `getComponent` 都没有（现在的写法是靠"名字兜底在空壳树上返回 null"才安全 —— '
    + '`HeroCard` 就是这么真炸过一次，见 G3/G4；这条断言防的是"以后改成现找组件"）',
    hGetComponent, 0);

/* ===================================================================
 * 报告
 * =================================================================== */

captureConsole = false;      // 折叠结束：下面的报告要真的打到屏幕上

console.log('');
console.log('▌英雄卡 + 英雄详情弹窗体检（真 HeroCard.ts / 真 Cmp_HeroDetail.ts × 真预制件 × 真配表）');
for (const s of sections) {
    console.log(`\n▌${s.title}`);
    for (const l of s.lines) console.log(l);
}

if (ezLogs.warn.length || ezLogs.error.length || consoleLogs.error.length) {
    console.log(`\n▌桩环境下的日志（预期：桩里没有真资产，图标一律加载失败）`
        + `info=${ezLogs.info.length} ezgame.warn=${ezLogs.warn.length} ezgame.error=${ezLogs.error.length} console.error=${consoleLogs.error.length}`);
    for (const l of ezLogs.warn.slice(0, 2)) console.log(`  · ezgame.warn: ${l}`);
    for (const l of ezLogs.error.slice(0, 3)) console.log(`  · ezgame.error: ${l}`);
    for (const l of consoleLogs.error.slice(0, 2)) console.log(`  · console.error: ${l}`);
}

console.log('');
if (failures.length) {
    console.log(`✖ 失败 ${failures.length} 条（通过 ${passed} 条）`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
}
console.log(`✔ 通过 ${passed} 条断言`);
process.exit(0);
