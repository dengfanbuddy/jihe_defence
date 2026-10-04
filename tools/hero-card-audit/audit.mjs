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
 * ── 断言分四组 ──
 *   A 契约：真预制件 + 真拖引用 → 代码解析出来的引用是不是"该拿的那个"
 *   B 渲染：未解锁 / 已解锁两态的等级、经验条、按钮文案与两态色、金币图标有没有被误染
 *   C 边界：exp=0 / exp>expMax / expMax=0（无经验口径）各画成什么
 *   D 经验公式：真 `HeroData` + 真 `battle_constants.json`，以及 `base=0` 时**不许死循环**
 *
 * 用法：
 *   node tools/hero-card-audit/audit.mjs
 *   npm run audit:herocard        # 在 tools/excel_export 下的等价命令
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
const PREFAB_PATH = path.join(ROOT, 'assets/resources/prefabs/ui/scenes/scene_menu/cmps/HeroItem.prefab');

/** 需要编译的**真源码**（相对 assets/scripts；platform/reactivity 整个目录另算） */
const SOURCES = [
    'game/ui/scenes/scene_menu/cmps/HeroCard.ts',
    'game/ui/scenes/scene_menu/cmps/HeroScope.ts',
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
    on() { }
    off() { }
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
const builtinResMgr = { get: () => null };
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
    EventTarget, SystemEvent, resources, builtinResMgr, warn, error, buildTree, loadedPaths,
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

/** 起一张真卡：按预制件里**真拖的引用**接线（`tree` 可传第二棵同构树，用来验"只警告一次"） */
function spawnCard(treeRef) {
    const node = treeRef.node;
    const card = new HeroCard();
    card.node = node;
    for (const field of CARD_REF_FIELDS) {
        const ref = prefabCardComp[field];
        card[field] = ref ? treeRef.byId.get(ref.__id__) ?? null : null;
    }
    card.propertyNodes = (prefabCardComp.propertyNodes || []).map((r) => treeRef.byId.get(r.__id__)).filter(Boolean);
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

// 预制件里真拖的 @property（改版后有两处是拖错的，这里原样接上，看代码纠不纠得回来）
const prefabCardComp = prefab.find((e) => typeof e.__type__ === 'string' && !e.__type__.startsWith('cc.')
    && e.node && e.node.__id__ === rootIdx);
check('A0 预制件根节点上挂着 HeroCard 脚本', !!prefabCardComp, true);

const CARD_REF_FIELDS = ['headSprite', 'lockNode', 'nameLabel', 'lvLabel', 'skillSprite',
    'actionSprite', 'actionLabel', 'actionValueLabel', 'detailNode'];

// 预制件里"拖错"的那两个原始引用（下面要证明代码把它们纠正了）
const rawLvRef = prefabCardComp.lvLabel ? tree.byId.get(prefabCardComp.lvLabel.__id__) : null;
const rawActionRef = prefabCardComp.actionSprite ? tree.byId.get(prefabCardComp.actionSprite.__id__) : null;

const card = spawnCard(tree);

const lvNode = rootNode.getChildByName('lv');
const lvValueLabel = lvNode?.getChildByName('value')?.getComponent(cc.Label);
const expBarNode = rootNode.getChildByName('exp_bar');
const unlockNode = rootNode.getChildByName('unlock');
const coinIconSprite = unlockNode?.getChildByName('icon')?.getComponent(cc.Sprite);

check('A1 等级数字取的是 `lv/value`（不是 `lv` 自己的「LV.」前缀）', card.lvLabel === lvValueLabel, true);
check('A1b 预制件里那份前缀引用确实被换掉了（改版后的典型拖错）', card.lvLabel !== rawLvRef, true);
check('A2 等级**整块**（`lv` 容器）被记住用于收放', card.lvNode === lvNode, true);
check('A3 经验条取的是 `exp_bar` 上的 ProgressBar', card.expBar === expBarNode?.getComponent(cc.ProgressBar), true);
check('A4 按钮底图取的是 `unlock` 自己的 Sprite（不是 `unlock/icon` 金币图）', card.actionSprite === unlockNode?.getComponent(cc.Sprite), true);
check('A4b 预制件里那份金币图引用确实被换掉了', card.actionSprite !== rawActionRef, true);
check('A5 按钮挂在 `unlock` 节点上（80×40 的点击区域，不是 26×26 的金币图）', card.actionBtn()?.node === unlockNode, true);
check('A6 文案 / 价格 / 详情按钮 / 头像 / 技能图 / 4 行属性都解析到了',
    !!(card.actionLabel && card.actionValueLabel && card.detailNode && card.headSprite && card.skillSprite
        && card.propertyNodes.length === 4), true);
check('A7 拖错的 lvLabel 只警告一次', consoleLogs.warn.filter((l) => l.includes('lvLabel')).length, 1);
check('A7b 拖错的 actionSprite 只警告一次', consoleLogs.warn.filter((l) => l.includes('actionSprite')).length, 1);

// 再起一张卡（同一份拖错的引用）：告警**不该**再重复 —— 列表每次重铺都会克隆一批卡，逐个吼会刷屏
spawnCard(cc.buildTree(prefab, rootIdx));
check('A7c 第二张卡不再重复告警（列表重铺不刷屏）',
    [consoleLogs.warn.filter((l) => l.includes('lvLabel')).length, consoleLogs.warn.filter((l) => l.includes('actionSprite')).length],
    [1, 1]);

/* ---------- B 渲染：未解锁 / 已解锁 ---------- */

group('B 渲染（两态）');

const VM_LOCKED = {
    heroId: 1002, name: '赏金猎人', headIcon: 'textures/heros/shangjin', skillIcon: 'textures/skills/huoqiang',
    unlocked: false, level: 0, exp: 0, expMax: 0, cost: 2000, enabled: true,
    attrs: [{ attrId: 1, name: '最大生命', value: 300, growth: 12, valueText: '300', growthText: '+12/级', icon: 'textures/common/heart' }],
};
const VM_OPEN = {
    heroId: 1001, name: '火枪', headIcon: 'textures/heros/huoqiang', skillIcon: 'textures/skills/huoqiang',
    unlocked: true, level: 5, exp: 40, expMax: 100, cost: 2000, enabled: true,
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

card.setInfo(VM_OPEN);
check('B8 已解锁 → 锁收起', card.lockNode.active, false);
check('B9 已解锁 → 等级整块显示', card.lvNode.active, true);
check('B10 等级数字 = 5（只写数字，前缀「LV.」由预制件自己管）', card.lvLabel.string, '5');
check('B11 经验条显示', card.expBar.node.active, true);
check('B12 经验进度 = 40/100 = 0.4', card.expBar.progress, 0.4);
check('B13 已解锁 → 按钮文案是「升 级」', card.actionLabel.string, '升 级');
check('B14 金币图标**没被按钮配色染**（仍是预制件的 112,172,179）',
    [coinIconSprite.color.r, coinIconSprite.color.g, coinIconSprite.color.b], [112, 172, 179]);

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

/* ---------- D 经验公式（真 HeroData + 真 battle_constants） ---------- */

group('D 经验公式（真 HeroData.ts + 真 battle_constants.json）');

const { HeroDataModule } = built.mod('game', 'data', 'funcs', 'HeroData.js');
const heroData = new HeroDataModule();

check('D1 默认档案：火枪 1001 已解锁 Lv.1 exp 0',
    heroData.getHeroInfo(1001), { id: 1001, level: 1, exp: 0 });
check(`D2 升 2 级所需经验 = heroExpFormulaBase（${expBase}）`, heroData.getExpForNextLevel(1), expBase);
check(`D3 升 3 级所需经验 = floor(${expBase}×${expRatio})`, heroData.getExpForNextLevel(2), Math.floor(expBase * expRatio));
check('D4 等级 0/负数按 1 级算（不出现 0 或 NaN 的进度分母）',
    [heroData.getExpForNextLevel(0), heroData.getExpForNextLevel(-3)], [expBase, expBase]);
check('D5 给刚好一级的经验 → 升 1 级且经验清零', (() => {
    heroData.addHeroExp(1001, expBase);
    return [heroData.getHeroInfo(1001).level, heroData.getHeroInfo(1001).exp];
})(), [2, 0]);
check('D6 给两级多一点的经验 → 一次升 2 级、余数留着', (() => {
    const need = heroData.getExpForNextLevel(2) + heroData.getExpForNextLevel(3) + 7;
    heroData.addHeroExp(1001, need);
    return [heroData.getHeroInfo(1001).level, heroData.getHeroInfo(1001).exp];
})(), [4, 7]);
check('D7 经验不够 → 不升级、经验累计', heroData.addHeroExp(1001, 1), false);

// 配表把 heroExpFormulaBase 配成 0 = 曾经的**死循环**（exp -= 0; level += 1 → 整局卡死且无报错）
globalThis.__heroExpBase = 0;
const before = heroData.getHeroInfo(1001).level;
const levelled = heroData.addHeroExp(1001, 999);
check('D8 base=0（配表配错）→ 不死循环、不白升级（守卫生效）', [levelled, heroData.getHeroInfo(1001).level], [false, before]);
check('D9 base=0 时下一级所需 = 0（卡片据此收起经验条，见 C3）', heroData.getExpForNextLevel(before), 0);
globalThis.__heroExpBase = undefined;

/* ===================================================================
 * 报告
 * =================================================================== */

captureConsole = false;      // 折叠结束：下面的报告要真的打到屏幕上

console.log('');
console.log('▌英雄卡体检（真 HeroCard.ts × 真 HeroItem.prefab × 真配表）');
for (const s of sections) {
    console.log(`\n▌${s.title}`);
    for (const l of s.lines) console.log(l);
}

if (ezLogs.warn.length || ezLogs.error.length || consoleLogs.error.length) {
    console.log(`\n▌桩环境下的日志（预期：桩里没有真资产，图标一律加载失败）`
        + `info=${ezLogs.info.length} ezgame.warn=${ezLogs.warn.length} ezgame.error=${ezLogs.error.length} console.error=${consoleLogs.error.length}`);
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
