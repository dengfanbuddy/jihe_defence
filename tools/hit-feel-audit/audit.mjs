#!/usr/bin/env node
/**
 * audit.mjs —— **「打击反馈的账本与钳制到底成不成立」体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**加上顿帧/震屏之后，这一局的数值口径有没有被悄悄改掉？表现会不会在后期糊屏？**
 *
 * 做法（不是静态扫描，是**真跑一遍决策层**）：
 *   把项目里真实的 `battle/types.ts` / `common/EntityVisualConfig.ts` / `common/HitFeelConfig.ts` /
 *   `game_stage/entityview/HitFeelDirector.ts` 用 `transpileModule` 编成 CJS，
 *   只给 `battle/index`（被 director 当作事件名来源 require）打一个**转发到真 types.js 的桩**，
 *   然后用**假时钟 + 假总线**喂典型节奏，读导演真正算出来的 `timeScale` / 位移 / 统计。
 *
 * 为什么需要它（打击反馈的三条硬口径**都没法靠肉眼验**）：
 *   ① **时间税**：顿帧只冻结 `ctx.Tick`，而刷怪节奏按 `elapsed` 索引 `SPAWN_BEATS`
 *      → 顿帧 = "每秒钟少打一点输出"，必须 ≤ 3%（`stopMsTotal / 真实时间`）；
 *   ② **位移钳制**：同帧 20 次 AoE 命中若相加就是 88px（演示台实测过），必须**取最大不相加**且 ≤ 6px；
 *   ③ **同帧合并**：20 次命中只能产生**一份**全局表现（塔防刚需）。
 *   这三条在编辑器里只能"感觉一下"，只有真跑 3600 帧才给得出数字。
 *
 * 用法：
 *   node tools/hit-feel-audit/audit.mjs        # 体检（任一条不过 → 退出码 1）
 *   npm run audit:hitfeel                      # 在 tools/excel_export 下的等价命令
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = 'assets/scripts/game';

/** 需要编译的真源码（相对 assets/scripts/game）—— 决策层全是纯 TS，所以能整块真跑 */
const SOURCES = [
    'battle/types.ts',
    'common/EntityVisualConfig.ts',
    'common/HitFeelConfig.ts',
    'common/EntityHpBarConfig.ts',
    'common/DamageTextConfig.ts',
    'game_stage/entityview/GeometricDigits.ts',
    'game_stage/entityview/HitFeelDirector.ts',
    'game_stage/entityview/HitVfxLayer.ts',
    'game_stage/entityview/HitScreenLayer.ts',
    'game_stage/entityview/HpBar.ts',
];

/**
 * 打桩：只桩 `battle/index`（director / 印痕层只用它取 `BattleEvents` 事件名）。
 * 桩**转发到真的 `types.js`** —— 事件名仍是唯一真源，不手抄字符串。
 */
const STUBS = {
    'game/battle/index.js': `module.exports = require('./types.js');`,
};

/**
 * `cc` 桩：**不做任何渲染，只记录绘制调用**。
 *
 * 为什么能这么干：`HitVfxLayer` 里值得验的东西全在"算了什么、画了几笔、坐标是多少"这一层 ——
 * 档位给了几条刻度 / 几层环、密度 k 有没有乘上去、并发超限淘汰的是不是最弱档……
 * 这些都不需要 GPU，只需要一个会记账的 Graphics。真正需要眼睛的部分（观感）在 `§8.2` 主观验收里。
 *
 * ⚠ 桩必须放在 `<tmp>/node_modules/cc/` 而不是 `<tmp>/assets/scripts/`：
 *   真源码里的 `import ... from 'cc'` 会从**它自己所在的目录**逐级往上找 `node_modules`，
 *   放在 tmp 根下的 `node_modules` 才能让任意深度的模块都解析到**同一个实例**
 *   （同一个实例很重要：`getComponent(Graphics)` 靠类同一性判断）。
 */
const CC_STUB = `'use strict';
function ccclass() { return (t) => t; }
function noop() { return (t) => t; }
function property(...args) {
    // @property(Node) x → 返回装饰器；@property x → 直接作用于字段（返回 undefined）
    if (args.length >= 2 && typeof args[1] === 'string') return undefined;
    return () => undefined;
}
const _decorator = { ccclass, property, executeInEditMode: noop, menu: noop };

class Component {
    constructor() {
        this.node = null;
        // ⚠ 真引擎的组件都有 isValid（真源码里会判它，例如 HpBar 借 SpriteFrame 时判 src.isValid）
        this.isValid = true;
    }
}
class Node {
    constructor(name) {
        this.name = name || '';
        this.isValid = true;
        this.parent = null;
        this.children = [];
        this.active = true;
        this.layer = 1 << 25;
        this.position = { x: 0, y: 0, z: 0 };
        this.scale = { x: 1, y: 1, z: 1 };
        this.worldPosition = { x: 0, y: 0, z: 0 };
        this._comps = new Map();
    }
    addChild(c) {
        if (!c) return;
        if (c.parent) {
            const i = c.parent.children.indexOf(c);
            if (i >= 0) c.parent.children.splice(i, 1);
        }
        c.parent = this;
        this.children.push(c);
    }
    getChildByName(n) {
        for (const c of this.children) if (c.name === n) return c;
        return null;
    }
    getSiblingIndex() { return this.parent ? this.parent.children.indexOf(this) : 0; }
    setSiblingIndex(i) {
        const p = this.parent;
        if (!p) return;
        const from = p.children.indexOf(this);
        if (from < 0) return;
        p.children.splice(from, 1);
        const to = Math.max(0, Math.min(i | 0, p.children.length));
        p.children.splice(to, 0, this);
    }
    setPosition(x, y, z) { this.position = { x, y, z: z || 0 }; }
    setScale(x, y, z) {
        this.scale = { x, y: y === undefined ? x : y, z: z === undefined ? 1 : z };
    }
    /** 按**类同一性**取组件（与引擎口径一致：不是按名字） */
    getComponent(T) { return this._comps.get(T) || null; }
    addComponent(T) {
        const c = new T();
        c.node = this;
        this._comps.set(T, c);
        return c;
    }
}
class UITransform extends Component {
    constructor() {
        super();
        this.width = 0;
        this.height = 0;
        this.anchorX = 0.5;
        this.anchorY = 0.5;
    }
    setContentSize(w, h) { this.width = w; this.height = h; }
    get contentSize() { return { width: this.width, height: this.height }; }
    setAnchorPoint(x, y) { this.anchorX = x; this.anchorY = y; }
    // 桩：不做矩阵换算（审计里两边坐标空间本来就重合，或由调用方直接给局部坐标）
    convertToNodeSpaceAR(p) { return { x: p.x, y: p.y, z: 0 }; }
    convertToWorldSpaceAR(p) { return { x: p.x, y: p.y, z: 0 }; }
}
class Color {
    constructor(r, g, b, a) { this.set(r, g, b, a); }
    set(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; return this; }
}
class Sprite extends Component {
    constructor() {
        super();
        this.spriteFrame = null;
        this.type = 0;
        this.sizeMode = 0;
        this._color = new Color(255, 255, 255, 255);
    }
    // 与引擎一致：写入时**拷贝**（不是存引用）
    set color(c) { this._color = new Color(c.r, c.g, c.b, c.a); }
    get color() { return this._color; }
}
class Widget extends Component {
    constructor() { super(); this.enabled = true; }
}

/** 记账用画布：不产生任何顶点，只把"画了什么"记下来 */
class Graphics extends Component {
    constructor() {
        super();
        this.lineWidth = 1;
        this.lineJoin = 0;
        this.lineCap = 0;
        this.strokeColor = new Color(0, 0, 0, 255);
        this.fillColor = new Color(0, 0, 0, 255);
        this.clearCount = 0;
        this.totalStrokes = 0;
        this.totalFills = 0;
        this.frameStrokes = [];
        this.frameFills = [];
        this._paths = [];
        this._cur = null;
    }
    clear() {
        this.clearCount++;
        this.frameStrokes = [];
        this.frameFills = [];
        this._paths = [];
        this._cur = null;
    }
    moveTo(x, y) { this._cur = { kind: 'poly', pts: [{ x, y }] }; this._paths.push(this._cur); }
    lineTo(x, y) {
        if (!this._cur) { this._cur = { kind: 'poly', pts: [] }; this._paths.push(this._cur); }
        this._cur.pts.push({ x, y });
    }
    close() { this._cur = null; }
    circle(x, y, r) { this._paths.push({ kind: 'circle', x, y, r }); this._cur = null; }
    rect(x, y, w, h) { this._paths.push({ kind: 'rect', x, y, w, h }); this._cur = null; }
    stroke() { this.frameStrokes.push(this._snap('stroke')); this.totalStrokes++; this._paths = []; this._cur = null; }
    fill() { this.frameFills.push(this._snap('fill')); this.totalFills++; this._paths = []; this._cur = null; }
    _snap() {
        let segs = 0;
        for (const p of this._paths) if (p.kind === 'poly') segs += Math.max(0, p.pts.length - 1);
        return {
            lineWidth: this.lineWidth,
            color: [this.strokeColor.r, this.strokeColor.g, this.strokeColor.b, this.strokeColor.a],
            paths: this._paths,
            segs,
        };
    }
}
Graphics.LineJoin = { MITER: 0, ROUND: 1, BEVEL: 2 };
Graphics.LineCap = { BUTT: 0, ROUND: 1, SQUARE: 2 };

/** 可见区（屏幕层要按它把角标贴到四个角上；桩给设计分辨率） */
const view = { getVisibleSize: () => ({ width: 750, height: 1334 }) };

module.exports = { _decorator, Component, Node, UITransform, Color, Sprite, Widget, Graphics, view };
`;

const require = createRequire(import.meta.url);

function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✖ 找不到 typescript（请在项目根目录或 tools/excel_export 下装好依赖）');
    process.exit(2);
}
const ts = resolveTypeScript();

/** 编译到系统临时目录（不污染仓库），返回可 require 的模块工厂 */
function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-hitfeel-audit-'));
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    const gameDir = path.join(out, SRC);
    for (const rel of SOURCES) {
        const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, SRC, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
            fileName: rel,
        }).outputText;
        const dest = path.join(gameDir, rel.replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js);
    }
    for (const [rel, code] of Object.entries(STUBS)) {
        const dest = path.join(out, 'assets/scripts', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
    }
    // cc 桩放进 tmp 的 node_modules（见 CC_STUB 的注释：真源码要从自己所在目录往上找到它）
    const ccDir = path.join(out, 'node_modules/cc');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'package.json'), JSON.stringify({ name: 'cc', version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(ccDir, 'index.js'), CC_STUB);
    return { out, mod: (...p) => require(path.join(gameDir, ...p)), cc: require(path.join(ccDir, 'index.js')) };
}

// ============================ 断言与报告 ============================

const groups = [];
let curGroup = null;
let pass = 0;
let fail = 0;

function g(name) { curGroup = { name, lines: [] }; groups.push(curGroup); }
function ok(label, cond, detail = '') {
    if (cond) pass++; else fail++;
    curGroup.lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? '   ' + detail : ''}`);
    return cond;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

// ============================ 假总线 / 假实体 ============================

function makeBus() {
    const handlers = new Map();
    return {
        onBattleEvent(name, fn, self) {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push({ fn, self });
            return () => {
                const list = handlers.get(name) ?? [];
                const i = list.findIndex((h) => h.fn === fn && h.self === self);
                if (i >= 0) list.splice(i, 1);
            };
        },
        /** 真总线里叫 publish；体检脚本直接调 handler 更可控 */
        emit(name, payload) {
            for (const h of handlers.get(name) ?? []) h.fn.call(h.self, payload);
        },
        listenerCount(name) { return (handlers.get(name) ?? []).length; },
    };
}

function makeEntity(uid, kind, x = 0, y = 0) {
    return { uid, unitKind: kind, hp: 100, position: { x, y }, IsDead: () => false };
}

// ============================ 印痕层（B2）的假画布 ============================

/**
 * 一块"记账画布"的假节点（`HitVfxLayer` 只需要 `getComponent(Graphics/UITransform)`）。
 *
 * 用的是 **cc 桩里那个 Graphics 类**（同一个模块实例）：真源码里的 `getComponent(Graphics)`
 * 靠类同一性判断，桩与源码必须拿到同一个类。
 */
function makeVfxCanvas(cc, name = 'vfx') {
    const node = new cc.Node(name);
    const g = node.addComponent(cc.Graphics);
    const ui = node.addComponent(cc.UITransform);
    return { node, g, ui };
}

/** 造一个绑好假总线的印痕层（每个用例各造一个：层是有状态的） */
function makeVfxLayer(mod, cc, bus) {
    const { HitVfxLayer } = mod('game_stage', 'entityview', 'HitVfxLayer.js');
    const layer = new HitVfxLayer();
    const canvas = makeVfxCanvas(cc);
    layer.node = canvas.node;
    layer.bind({ bus });
    return { layer, g: canvas.g };
}

/** 造一个绑好假总线的屏幕层（B3） */
function makeScreenLayer(mod, cc, bus, opts) {
    const { HitScreenLayer } = mod('game_stage', 'entityview', 'HitScreenLayer.js');
    const layer = new HitScreenLayer();
    const canvas = makeVfxCanvas(cc, 'screen_vfx');
    layer.node = canvas.node;
    layer.bind({ bus }, opts);
    return { layer, g: canvas.g };
}

/** 一帧里画过的全部折线点（角标贴边、奖励落点这类断言要用坐标） */
function strokePoints(g) {
    const pts = [];
    for (const s of g.frameStrokes) {
        for (const p of s.paths) {
            if (p.kind === 'poly') for (const pt of p.pts) pts.push(pt);
        }
    }
    return pts;
}

/**
 * 一帧的画法快照（把记账画布上"这一帧画了什么"翻译成人话）
 *
 * `circles` = 这一帧描了几个圆（= 环层数）、`segs` = 画了几段折线（= 刻度 + 对位十字的两条臂）、
 * `rects` = 填了几个矩形（= 碎片块数）。
 */
function shot(g) {
    let circles = 0;
    let segs = 0;
    let rects = 0;
    let maxR = 0;
    const strokeSegs = [];
    for (const s of g.frameStrokes) {
        for (const p of s.paths) {
            if (p.kind === 'circle') {
                circles++;
                if (p.r > maxR) maxR = p.r;
            }
        }
        segs += s.segs;
        strokeSegs.push(s.segs);
    }
    for (const f of g.frameFills) for (const p of f.paths) if (p.kind === 'rect') rects++;
    return {
        circles, segs, rects, maxR,
        strokes: g.frameStrokes.length,
        fills: g.frameFills.length,
        strokeSegs,
    };
}

/** 这一帧记录到的所有坐标/半径是否都是有限数（掉帧注入用例用） */
function geometryFinite(g) {
    const good = (v) => Number.isFinite(v);
    for (const list of [g.frameStrokes, g.frameFills]) {
        for (const s of list) {
            if (!good(s.lineWidth)) return false;
            for (const p of s.paths) {
                if (p.kind === 'poly') {
                    for (const pt of p.pts) if (!good(pt.x) || !good(pt.y)) return false;
                } else if (p.kind === 'circle') {
                    if (!good(p.x) || !good(p.y) || !good(p.r)) return false;
                } else if (!good(p.x) || !good(p.y) || !good(p.w) || !good(p.h)) return false;
            }
        }
    }
    return true;
}

/** 把整条寿命走完，返回这一路见过的最大圆半径（用来验"环扩散到 ringRadius"） */
function maxCircleRadiusOverLife(layer, g, frames, dt) {
    let maxR = 0;
    for (let i = 0; i < frames; i++) {
        layer.update(dt);
        const s = shot(g);
        if (s.circles > 0 && s.maxR > maxR) maxR = s.maxR;
    }
    return maxR;
}

/** 推进任意"每帧驱动"的对象（`update(dt)` 或 `tick(dt)`；层对象与 HpBar 各用一种） */
function advance(target, frames, dt) {
    for (let i = 0; i < frames; i++) {
        if (typeof target.update === 'function') target.update(dt);
        else target.tick(dt);
    }
}

// ============================ 体检 ============================

function main() {
    const { mod, cc } = build();
    const { BattleEvents } = mod('battle', 'types.js');
    const { UnitKind } = mod('common', 'EntityVisualConfig.js');
    const CFG = mod('common', 'HitFeelConfig.js');
    const { HitFeelDirector } = mod('game_stage', 'entityview', 'HitFeelDirector.js');
    const {
        HitFeelTier, HIT_FEEL_TIERS, HIT_FEEL_BUDGET, HIT_FEEL_DENSITY, HIT_FEEL_MARK, HIT_FEEL_INFO,
        HIT_FEEL_SFX_EXTRA, hitFeelSfxKey, hitFeelSfxKeys, shouldPlayAttackSfx,
        getTierSpec, resolveHitTier, resolveDeathTier, hitFeelDensityScale, clampBattleDt,
    } = CFG;
    const { HP_BAR } = mod('common', 'EntityHpBarConfig.js');

    const DT = 1 / 60;
    const EV_HIT = BattleEvents.OnTakeDamage;
    const EV_DEATH = BattleEvents.OnDeath;
    const EV_ATK = BattleEvents.OnAttackStart;
    const EV_EVADE = BattleEvents.OnEvade;

    const makeDirector = () => {
        const bus = makeBus();
        const d = new HitFeelDirector();
        d.bind({ bus });
        return { d, bus };
    };

    /** 推进 n 帧，每帧开跑前回调一次（用来发事件） */
    function run(d, frames, beforeFrame, dt = DT) {
        for (let i = 0; i < frames; i++) {
            if (beforeFrame) beforeFrame(i);
            d.tick(dt);
        }
    }

    /**
     * 逐帧采样 + 滑窗复算：返回 `{ maxWindowMs, peakShake }`。
     *
     * `maxWindowMs` = max over i of ( samples[i+n-1] - samples[i-1] )，n = 1 秒的帧数。
     * 这是对导演**自己那本账**的独立交叉验证 —— 避免"账本算错了但自己说没问题"。
     */
    function auditWindow(dir, frames, beforeFrame, dt = DT) {
        const samples = [];
        let peak = 0;
        for (let i = 0; i < frames; i++) {
            if (beforeFrame) beforeFrame(i);
            dir.tick(dt);
            peak = Math.max(peak, Math.abs(dir.shakeX), Math.abs(dir.shakeY));
            samples.push(dir.stats.stopMsTotal);
        }
        const n = Math.max(1, Math.round(1 / dt));
        let maxWindowMs = 0;
        for (let i = 0; i < samples.length; i++) {
            const j = Math.min(samples.length - 1, i + n - 1);
            const base = i > 0 ? samples[i - 1] : 0;
            maxWindowMs = Math.max(maxWindowMs, samples[j] - base);
        }
        return { maxWindowMs, peakShake: peak };
    }

    const hero = makeEntity(1, UnitKind.Hero);
    const goblin = makeEntity(2, UnitKind.Normal, 100, 0);
    const elite = makeEntity(3, UnitKind.Elite, 120, 0);
    const boss = makeEntity(4, UnitKind.StageBoss, 150, 0);
    const finalBoss = makeEntity(5, UnitKind.FinalBoss, 160, 0);
    const hit = (src, tgt, extra = {}) => ({
        source: src, target: tgt, rawDamage: 10, finalDamage: 10, isCrit: false, ability: undefined, ...extra,
    });

    /* ==================== ① 档位判定（唯一的判定点） ==================== */
    g('① 事件 → 档位（resolveHitTier / resolveDeathTier）');
    ok('普攻未击杀 → T0 微', resolveHitTier(hit(hero, goblin)) === HitFeelTier.Micro);
    ok('暴击 → T1 重', resolveHitTier(hit(hero, goblin, { isCrit: true })) === HitFeelTier.Crit);
    ok('技能伤害（ability 非空）→ T3', resolveHitTier(hit(hero, goblin, { ability: { id: 16 } })) === HitFeelTier.Elite);
    ok('命中精英 → T3', resolveHitTier(hit(hero, elite)) === HitFeelTier.Elite);
    ok('命中 Boss → T4', resolveHitTier(hit(hero, boss)) === HitFeelTier.BossHit);
    ok('英雄受击 → T6（压过暴击：自己的血最重要）', resolveHitTier(hit(goblin, hero, { isCrit: true })) === HitFeelTier.HeroHurt);
    ok('DoT（无 ability / 无暴击 / 打普通怪）与普攻同档 T0 —— 不需要给 ApplyDamage 加 tag',
        resolveHitTier(hit(undefined, goblin)) === HitFeelTier.Micro);
    ok('普通怪死亡 → T2', resolveDeathTier(goblin) === HitFeelTier.Kill);
    ok('精英死亡 → T5', resolveDeathTier(elite) === HitFeelTier.BigKill);
    ok('阶段 Boss 死亡 → T5', resolveDeathTier(boss) === HitFeelTier.BigKill);
    ok('最终 Boss 死亡 → T7 通关', resolveDeathTier(finalBoss) === HitFeelTier.Clear);
    ok('英雄死亡 → None（交给结算面板，打击感不插手）', resolveDeathTier(hero) === HitFeelTier.None);
    ok('档位表 9 档齐全', Object.keys(HIT_FEEL_TIERS).length === 9, `实际 ${Object.keys(HIT_FEEL_TIERS).length}`);

    /* ==================== ② 顿帧账本（时间税） ==================== */
    g('② 顿帧账本（1s 滑动窗口 ≤ 30ms；峰值档位可一次吃满那一秒）');
    ok('常规档位的请求值都 ≤ 窗口上限（表与实现一致，写大了也拿不到）',
        [HitFeelTier.Crit, HitFeelTier.Kill, HitFeelTier.Elite, HitFeelTier.BossHit, HitFeelTier.HeroHurt, HitFeelTier.Micro]
            .every((t) => getTierSpec(t).stopMs <= HIT_FEEL_BUDGET.stopMsPerWindow),
        `上限 ${HIT_FEEL_BUDGET.stopMsPerWindow}ms`);
    ok('峰值档位（T5/T7）请求值 ≤ 单次物理上限',
        [HitFeelTier.BigKill, HitFeelTier.Clear].every((t) => getTierSpec(t).stopMs <= HIT_FEEL_BUDGET.stopHardMaxMs),
        `T5=${getTierSpec(HitFeelTier.BigKill).stopMs}ms T7=${getTierSpec(HitFeelTier.Clear).stopMs}ms ≤ ${HIT_FEEL_BUDGET.stopHardMaxMs}ms`);
    {
        // (a) 同帧 10 次暴击 → 只算 1 次顿帧，且只拿到窗口额度
        const one = makeDirector();
        for (let i = 0; i < 10; i++) one.bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
        one.d.tick(DT);
        ok('同帧 10 次暴击只算 1 次顿帧（同帧合并）', one.d.stats.stops === 1 && one.d.stats.stopsDropped === 0,
            `stops=${one.d.stats.stops} dropped=${one.d.stats.stopsDropped}`);
        ok('单次顿帧 = 窗口额度 30ms（档位请求 30ms）',
            near(one.d.stats.stopMsTotal, HIT_FEEL_BUDGET.stopMsPerWindow, 1e-9), `${fmt(one.d.stats.stopMsTotal)}ms`);
        ok('顿帧期间 timeScale = 0.02（≈停住；不用 0 是为了避开 dt=0 的边界）',
            near(one.d.timeScale, HIT_FEEL_BUDGET.stopTimeScale, 1e-9), `timeScale=${one.d.timeScale}`);

        // (b) 每帧一发暴击连打 2 秒（最坏节奏）→ 任意 1s 窗口 ≤ 30ms
        const d2 = makeDirector();
        const w = auditWindow(d2.d, 120, () => d2.bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true })));
        const tax = d2.d.stats.stopMsTotal / (120 * DT * 1000);
        ok('最坏节奏（每帧暴击）：任意 1s 窗口内顿帧 ≤ 30ms',
            w.maxWindowMs <= HIT_FEEL_BUDGET.stopMsPerWindow + 1e-6, `实测 ${fmt(w.maxWindowMs)}ms`);
        ok('超限顿帧被丢弃（stopsDropped 在计数）', d2.d.stats.stopsDropped > 0, `丢弃 ${d2.d.stats.stopsDropped} 次`);
        ok('最坏节奏的时间税仍 ≤ 3%', tax <= 0.0301, `实测 ${(tax * 100).toFixed(2)}%`);

        // (c) 峰值档位：一次吃满那一秒，之后 1s 内不再顿帧
        const d3 = makeDirector();
        d3.bus.emit(EV_DEATH, { entity: elite, killer: hero });
        d3.d.tick(DT);
        ok('T5 大击杀顿帧 = 档位请求 60ms（峰值档位可超过窗口上限）',
            near(d3.d.stats.stopMsTotal, getTierSpec(HitFeelTier.BigKill).stopMs, 1e-9), `${fmt(d3.d.stats.stopMsTotal)}ms`);
        const after5 = d3.d.stats.stops;
        for (let i = 0; i < 30; i++) { d3.bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true })); d3.d.tick(DT); }
        ok('T5 之后同一秒内的暴击不再顿帧（账本被吃满、绝不叠加）', d3.d.stats.stops === after5,
            `stops=${d3.d.stats.stops}（期间 dropped=${d3.d.stats.stopsDropped}）`);

        const d4 = makeDirector();
        d4.bus.emit(EV_DEATH, { entity: finalBoss, killer: hero });
        d4.d.tick(DT);
        ok('T7 通关顿帧 = 90ms（= 单次物理上限）',
            near(d4.d.stats.stopMsTotal, getTierSpec(HitFeelTier.Clear).stopMs, 1e-9), `${fmt(d4.d.stats.stopMsTotal)}ms`);
    }

    /* ==================== ③ 战斗内容层位移（取最大不相加 / ≤ 6px） ==================== */
    g('③ 战斗内容层位移（同帧合并 + 取最大不相加 + ≤ 6px）');
    {
        const { d, bus } = makeDirector();
        for (let i = 0; i < 20; i++) bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
        d.tick(DT);
        ok('同帧 20 次 AoE 命中 → 只产生 1 次位移（G2 合并）', d.stats.shakes === 1, `shakes=${d.stats.shakes}`);
        const peak = Math.max(...(() => {
            const arr = [];
            for (let i = 0; i < 60; i++) { d.tick(DT); arr.push(Math.abs(d.shakeX), Math.abs(d.shakeY)); }
            return arr;
        })());
        ok('位移幅度 ≤ 6px（cap）', peak <= HIT_FEEL_BUDGET.shakeMaxPx + 1e-9, `峰值 ${fmt(peak)}px`);
        ok('位移结束后归零（不残留偏移）', d.shakeX === 0 && d.shakeY === 0, `(${fmt(d.shakeX)}, ${fmt(d.shakeY)})`);

        const d3 = makeDirector();
        d3.bus.emit(EV_DEATH, { entity: finalBoss, killer: hero });   // T7 请求 8px
        d3.d.tick(DT);
        const peak7 = Math.max(...(() => {
            const arr = [];
            for (let i = 0; i < 90; i++) { d3.d.tick(DT); arr.push(Math.abs(d3.d.shakeX), Math.abs(d3.d.shakeY)); }
            return arr;
        })());
        // ⚠ 只能断言**上界**：位移是"正弦 × 线性衰减"，采样点未必落在正弦峰上（且相位随机），
        //   所以"实测峰值"天然略小于钳制值。下界只用来证明"它真的在大力抖"，不追求贴近 6px。
        ok('T7 请求 8px 被 §5.3 上限钳制（实测峰值不超 6px，且确实是大抖）',
            peak7 <= HIT_FEEL_BUDGET.shakeMaxPx + 1e-9 && peak7 > HIT_FEEL_BUDGET.shakeMaxPx * 0.6,
            `峰值 ${fmt(peak7)}px（档位请求 ${getTierSpec(HitFeelTier.Clear).shakePx}px → 钳到 ${HIT_FEEL_BUDGET.shakeMaxPx}px）`);

        // 不相加：在"更强位移**仍在播**"的窗口内请求较弱的位移 → 必须被忽略
        const d4 = makeDirector();
        d4.bus.emit(EV_DEATH, { entity: finalBoss, killer: hero });    // T7：6px / 320ms
        d4.d.tick(DT);
        d4.d.tick(DT);                                                 // 只推 2 帧 → 位移仍在播
        const shakesBefore = d4.d.stats.shakes;
        for (let i = 0; i < 5; i++) d4.bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));   // 较弱：3px
        d4.d.tick(DT);
        ok('已播更强位移时较弱的请求被忽略（不相加）',
            d4.d.stats.shakes === shakesBefore && d4.d.stats.shakesDropped > 0,
            `shakes=${d4.d.stats.shakes} dropped=${d4.d.stats.shakesDropped}`);

        // 方向性：位移必须**平行于伤害方向**（振荡会让瞬时值正负交替，所以只断言"垂直于方向的分类为 0"）
        const d5 = makeDirector();
        const attackerX = makeEntity(77, UnitKind.Normal, -100, 0);
        d5.bus.emit(EV_HIT, hit(attackerX, hero));       // 攻击者在左 → 方向 =(1,0) → 位移只应在 x 上
        const xs = [];
        const ys = [];
        for (let i = 0; i < 20; i++) { d5.d.tick(DT); xs.push(d5.d.shakeX); ys.push(d5.d.shakeY); }
        ok('方向性位移与伤害方向平行（攻击者在左 → y 分量恒为 0、x 分量正负振荡）',
            ys.every((v) => Math.abs(v) < 1e-9) && Math.max(...xs) > 0 && Math.min(...xs) < 0,
            `x∈[${fmt(Math.min(...xs))}, ${fmt(Math.max(...xs))}] y 全 0`);

        const d6 = makeDirector();
        const attackerY = makeEntity(78, UnitKind.Normal, 0, -100);
        d6.bus.emit(EV_HIT, hit(attackerY, hero));       // 攻击者在下 → 方向 =(0,1) → 位移只应在 y 上
        const xs6 = [];
        const ys6 = [];
        for (let i = 0; i < 20; i++) { d6.d.tick(DT); xs6.push(d6.d.shakeX); ys6.push(d6.d.shakeY); }
        ok('换个来向（攻击者在下）→ 位移转到 y 轴（证明方向真的来自伤害传播方向）',
            xs6.every((v) => Math.abs(v) < 1e-9) && Math.max(...ys6) > 0 && Math.min(...ys6) < 0,
            `y∈[${fmt(Math.min(...ys6))}, ${fmt(Math.max(...ys6))}] x 全 0`);
    }

    /* ==================== ④ 时间缩放（顿帧 / 慢动作） ==================== */
    g('④ 时间缩放（顿帧 0.02× / 慢动作只给 T5/T7）');
    ok('暴击**不**触发慢动作（慢放只给值得停下来看的大事件）',
        HIT_FEEL_TIERS[HitFeelTier.Crit].slowMo === null && HIT_FEEL_TIERS[HitFeelTier.BossHit].slowMo === null);
    {
        const { d, bus } = makeDirector();
        bus.emit(EV_DEATH, { entity: elite, killer: hero });            // T5：60ms 顿帧 + 0.35× 慢放 180ms
        d.tick(DT);
        ok('T5 先顿帧（timeScale = 0.02）', near(d.timeScale, HIT_FEEL_BUDGET.stopTimeScale, 1e-9), `timeScale=${d.timeScale}`);
        let sawSlow = false;
        run(d, 60, () => { if (near(d.timeScale, 0.35, 1e-9)) sawSlow = true; });
        ok('顿帧走完 → 进入 0.35× 慢动作', sawSlow, `timeScale=${d.timeScale}`);
        run(d, 60, () => { });
        ok('慢动作结束后 timeScale 回到 1', near(d.timeScale, 1, 1e-9), `timeScale=${d.timeScale}`);

        const { d: dT7, bus: bus3 } = makeDirector();
        bus3.emit(EV_DEATH, { entity: finalBoss, killer: hero });       // T7：0.25× 慢放 420ms
        dT7.tick(DT);
        let sawClearSlow = false;
        let tsMin = 1;
        let tsMax = 0;
        run(dT7, 150, () => {
            if (near(dT7.timeScale, 0.25, 1e-9)) sawClearSlow = true;
            tsMin = Math.min(tsMin, dT7.timeScale);
            tsMax = Math.max(tsMax, dT7.timeScale);
        });
        ok('T7 通关 0.25× 慢动作生效', sawClearSlow);
        ok('时间缩放恒在 [0.02, 1]（不出现越界/NaN 杂音）',
            tsMin >= HIT_FEEL_BUDGET.stopTimeScale - 1e-9 && tsMax <= 1 + 1e-9, `[${fmt(tsMin, 3)}, ${fmt(tsMax, 3)}]`);
    }

    /* ==================== ⑤ 密度自适应衰减 ==================== */
    g('⑤ 密度自适应衰减（幅度类表现统一乘 k；顿帧与飘字不吃它）');
    ok('n1s ≤ baseline（2）→ k = 1', near(hitFeelDensityScale(0), 1, 1e-9) && near(hitFeelDensityScale(2), 1, 1e-9));
    ok('n1s = 4 → k = 1/(1+0.25×2) = 0.667', near(hitFeelDensityScale(4), 2 / 3, 1e-9), `k=${fmt(hitFeelDensityScale(4), 3)}`);
    ok('n1s = 6 → 压到下限 0.55', near(hitFeelDensityScale(6), HIT_FEEL_DENSITY.minK, 1e-9), `k=${hitFeelDensityScale(6)}`);
    ok('k 恒在 [minK, 1]（后期怪群也不会把表现压没）',
        [0, 1, 2, 5, 20, 100, 1000].every((n) => {
            const k = hitFeelDensityScale(n);
            return k >= HIT_FEEL_DENSITY.minK - 1e-9 && k <= 1 + 1e-9;
        }));
    {
        const { d, bus } = makeDirector();
        for (let i = 0; i < 12; i++) bus.emit(EV_HIT, hit(hero, goblin));
        d.tick(DT);
        ok('导演的 k 跟着"最近 1 秒命中数"走',
            near(d.densityScale, hitFeelDensityScale(d.hitsInLastSec), 1e-9),
            `n1s=${d.hitsInLastSec} k=${fmt(d.densityScale, 3)}`);
        run(d, 70, () => { });
        ok('命中窗口滑出后 k 回到 1', near(d.densityScale, 1, 1e-9) && d.hitsInLastSec === 0, `n1s=${d.hitsInLastSec}`);
    }

    /* ==================== ⑥ 掉帧守卫 ==================== */
    g('⑥ 掉帧守卫（dt 钳制；长卡顿不炸、不成簇补算）');
    ok('dt = 0 → 钳到下限 1ms', near(clampBattleDt(0), HIT_FEEL_BUDGET.dtMinSec, 1e-12));
    ok('dt = NaN → 钳到下限 1ms（NaN 不能被当成有效帧）', near(clampBattleDt(NaN), HIT_FEEL_BUDGET.dtMinSec, 1e-12));
    ok('dt = 200ms → 钳到上限 50ms', near(clampBattleDt(0.2), HIT_FEEL_BUDGET.dtMaxSec, 1e-12));
    ok('dt = 16.7ms → 原样通过', near(clampBattleDt(DT), DT, 1e-12));
    {
        const { d, bus } = makeDirector();
        let err = null;
        try {
            for (let i = 0; i < 600; i++) {
                if (i % 37 === 0) bus.emit(EV_HIT, hit(hero, goblin, { isCrit: i % 3 === 0 }));
                if (i % 53 === 0) bus.emit(EV_DEATH, { entity: goblin, killer: hero });
                d.tick(clampBattleDt(i % 100 === 99 ? 0.2 : DT));      // 每 100 帧注入一次 200ms 大卡顿
                if (!Number.isFinite(d.shakeX) || !Number.isFinite(d.shakeY) || !Number.isFinite(d.timeScale)) {
                    throw new Error(`第 ${i} 帧出现非有限值 shake=(${d.shakeX}, ${d.shakeY}) ts=${d.timeScale}`);
                }
                if (d.timeScale < HIT_FEEL_BUDGET.stopTimeScale - 1e-9 || d.timeScale > 1 + 1e-9) {
                    throw new Error(`第 ${i} 帧 timeScale 越界: ${d.timeScale}`);
                }
            }
        } catch (e) { err = e; }
        ok('注入 200ms 卡顿连跑 600 帧：无异常、无 NaN、时间缩放不越界', !err, err ? err.message : '');
    }

    /* ==================== ⑦ 典型一局连跑 60 秒 ==================== */
    g('⑦ 典型节奏连跑 60 秒（攻速 1.2/s · 暴击 30% · 击杀 1/s · 每 10s 一次 AoE 20 连击）');
    {
        const { d, bus } = makeDirector();
        const FRAMES = 3600;
        const enemy = makeEntity(99, UnitKind.Normal, 100, 0);
        let hits = 0;
        let kills = 0;
        let aoeCount = 0;
        run(d, FRAMES, (i) => {
            if (i % 50 === 0) {                                             // 攻速 1.2/s → 每 50 帧一发
                bus.emit(EV_HIT, hit(hero, enemy, { isCrit: Math.random() < 0.3 }));
                hits++;
                if (i % 60 === 0) { bus.emit(EV_DEATH, { entity: enemy, killer: hero }); kills++; }
            }
            if (i % 600 === 0) {                                            // 每 10 秒一次怪群 AoE
                aoeCount++;
                for (let j = 0; j < 20; j++) bus.emit(EV_HIT, hit(hero, enemy, { isCrit: j % 2 === 0 }));
            }
        });
        const realMs = FRAMES * DT * 1000;
        const tax = d.stats.stopMsTotal / realMs;
        ok('时间税 ≤ 3%（顿帧总量 / 真实时间）', tax <= 0.03,
            `${fmt(d.stats.stopMsTotal, 1)}ms / ${fmt(realMs, 0)}ms = ${(tax * 100).toFixed(2)}%`);
        ok('命中统计一致', d.stats.hits === hits + aoeCount * 20, `stats=${d.stats.hits} 期望=${hits + aoeCount * 20}`);
        ok('死亡统计一致（英雄死亡不计）', d.stats.deaths === kills, `stats=${d.stats.deaths} 期望=${kills}`);
        ok('单帧最多命中数 ≥ 20（AoE 那一帧真的被记到）', d.stats.peakHitsPerFrame >= 20, `peak=${d.stats.peakHitsPerFrame}`);
        ok('全局表现远少于命中数（20 连击被合并成 1 份）', d.stats.shakes <= FRAMES / 600 + hits + kills,
            `shakes=${d.stats.shakes} vs 命中 ${d.stats.hits}`);
        ok('跑完不残留位移', d.shakeX === 0 && d.shakeY === 0, `(${fmt(d.shakeX)}, ${fmt(d.shakeY)})`);
        ok('跑完回到常速', near(d.timeScale, 1, 1e-9), `timeScale=${d.timeScale}`);
    }

    /* ==================== ⑧ 换局复位 ==================== */
    g('⑧ 换局复位（reset / unbind 必须清干净，否则上一局的顿帧会带进新一局）');
    {
        const { d, bus } = makeDirector();
        bus.emit(EV_DEATH, { entity: finalBoss, killer: hero });
        d.tick(DT);
        ok('T7 触发后确实处于"顿帧 + 位移中"', d.isStopping && d.timeScale < 1);
        d.reset();
        ok('reset 后 timeScale = 1', near(d.timeScale, 1, 1e-9), `timeScale=${d.timeScale}`);
        ok('reset 后位移归零', d.shakeX === 0 && d.shakeY === 0);
        ok('reset 后不再是顿帧态', !d.isStopping);
        ok('reset 后密度窗口清空', d.hitsInLastSec === 0);

        const bus2 = makeBus();
        d.bind({ bus: bus2 });
        ok('重新 bind 后新 bus 各 1 个 handler（不叠加）',
            bus2.listenerCount(EV_HIT) === 1 && bus2.listenerCount(EV_DEATH) === 1,
            `on_take_damage=${bus2.listenerCount(EV_HIT)} on_death=${bus2.listenerCount(EV_DEATH)}`);
        ok('重新 bind 后旧 bus 的 handler 已摘除（unbind 在 bind 里先跑）',
            bus.listenerCount(EV_HIT) === 0 && bus.listenerCount(EV_DEATH) === 0);
        ok('static active 指向当前实例（EntityView 读 k 用它）', HitFeelDirector.active === d);
        d.unbind();
        ok('unbind 后新旧 bus 都清空',
            bus2.listenerCount(EV_HIT) === 0 && bus2.listenerCount(EV_DEATH) === 0);
        ok('unbind 后 static 句柄释放（不会读到上一局的 k）', HitFeelDirector.active === null);
    }

    /* ==================== ⑨ 档位表自洽（防手滑改出矛盾值） ==================== */
    g('⑨ 档位表自洽（跨档单调；别改出"打 Boss 比打小怪还轻"）');
    {
        // 两条独立的"力度链"：
        //   · **命中链**（打怪那几下）：Micro ≤ Elite ≤ BossHit ≤ Crit —— 靠刻度/环数/环半径递增
        //   · **收尾链**（怪死了）：Kill ≤ BigKill ≤ Clear —— 靠碎片/环数递增
        //   · **英雄受击**是另一支（受击方是自己的锚点，不参与"打怪"链）：只要求"有一个环"看得见
        const hitChain = [HitFeelTier.Micro, HitFeelTier.Elite, HitFeelTier.BossHit, HitFeelTier.Crit];
        const killChain = [HitFeelTier.Kill, HitFeelTier.BigKill, HitFeelTier.Clear];
        const mono = (arr, pick, label) => {
            const v = arr.map((t) => pick(getTierSpec(t).mark));
            return ok(`${label}随档位单调不减`, v.every((x, i) => i === 0 || x >= v[i - 1]), v.join(' ≤ '));
        };
        const perTier = (label, cond, detail) => ok(label, cond, detail);
        mono(hitChain, (m) => m.ticks, '命中链 刻度条数');
        mono(hitChain, (m) => m.rings, '命中链 细环层数');
        perTier('命中链每档的环半径都够大（≥ 26px，看得见）',
            hitChain.every((t) => getTierSpec(t).mark.ringRadius >= 26),
            hitChain.map((t) => `${t.slice(0, 4)}=${getTierSpec(t).mark.ringRadius}`).join(' '));
        // 环半径**不参与"命中链单调"**：它是**按体型**定的而不是按力度定的 ——
        // Boss 体型 ×1.5~2，同样的 26px 环在 Boss 身上等于看不见，所以 Boss 档（56）刻意大于暴击档（40）。
        // 力度由"刻度条数 / 环层数 / 对位十字"承载（所以那三条必须单调）。
        perTier('Boss 档的环半径严格大于暴击档（体型补偿真的生效）',
            getTierSpec(HitFeelTier.BossHit).mark.ringRadius > getTierSpec(HitFeelTier.Crit).mark.ringRadius,
            `boss=${getTierSpec(HitFeelTier.BossHit).mark.ringRadius} > crit=${getTierSpec(HitFeelTier.Crit).mark.ringRadius}`);
        perTier('收尾链的环半径也随档位放大（大击杀的环要压过小怪死）',
            getTierSpec(HitFeelTier.BigKill).mark.ringRadius > getTierSpec(HitFeelTier.Kill).mark.ringRadius
            && getTierSpec(HitFeelTier.Clear).mark.ringRadius > getTierSpec(HitFeelTier.BigKill).mark.ringRadius,
            [HitFeelTier.Kill, HitFeelTier.BigKill, HitFeelTier.Clear].map((t) => getTierSpec(t).mark.ringRadius).join(' < '));
        mono(killChain, (m) => m.shards, '收尾链 碎片数');
        mono(killChain, (m) => m.rings, '收尾链 细环层数');
        ok('英雄受击至少有 1 层环（"我挨打了"必须看得见）',
            getTierSpec(HitFeelTier.HeroHurt).mark.rings >= 1,
            `rings=${getTierSpec(HitFeelTier.HeroHurt).mark.rings}`);
        ok('只有暴击带对位十字（十字 = 暴击的专属形状，不靠颜色）',
            [HitFeelTier.Micro, HitFeelTier.Elite, HitFeelTier.BossHit, HitFeelTier.Kill, HitFeelTier.BigKill]
                .every((t) => getTierSpec(t).mark.cross === false) && getTierSpec(HitFeelTier.Crit).mark.cross === true);
        ok('只有死亡档位出碎片（命中时禁粒子，见设计文档 §9 不做清单）',
            [HitFeelTier.Micro, HitFeelTier.Elite, HitFeelTier.BossHit, HitFeelTier.Crit].every((t) => getTierSpec(t).mark.shards === 0)
            && killChain.every((t) => getTierSpec(t).mark.shards > 0));

        const order = [
            HitFeelTier.Micro, HitFeelTier.Kill, HitFeelTier.Elite, HitFeelTier.BossHit,
            HitFeelTier.Crit, HitFeelTier.HeroHurt, HitFeelTier.BigKill, HitFeelTier.Clear,
        ];
        const px = order.map((t) => getTierSpec(t).shakePx);
        ok('位移幅度随档位单调不减', px.every((v, i) => i === 0 || v >= px[i - 1]), px.join(' ≤ '));
        ok('只有 T5/T7 带慢动作', order.every((t) => (getTierSpec(t).slowMo !== null) === (t === HitFeelTier.BigKill || t === HitFeelTier.Clear)));
        ok('受击膨胀在 (0, 0.2] 且时长为正，或两者都为 0', order.every((t) => {
            const s = getTierSpec(t);
            return (s.punchPct === 0 && s.punchMs === 0) || (s.punchPct > 0 && s.punchPct <= 0.2 && s.punchMs > 0);
        }));
        ok('受击抖动幅度 ≤ 位移上限（原地抖不该比整块屏还猛）',
            order.every((t) => getTierSpec(t).hitShakePx <= HIT_FEEL_BUDGET.shakeMaxPx));
        ok('墨闪只给 T5/T6/T7（浅底上只有墨色可用、且必须稀缺）',
            order.filter((t) => getTierSpec(t).flashFrameAlpha > 0).sort().join(',')
            === [HitFeelTier.HeroHurt, HitFeelTier.BigKill, HitFeelTier.Clear].sort().join(','),
            order.filter((t) => getTierSpec(t).flashFrameAlpha > 0).join(','));
        ok('墨闪 alpha ≤ 0.10（浅底上再重就压成暗屏）',
            order.every((t) => getTierSpec(t).flashFrameAlpha <= 0.10));
        ok('音效键：这 8 档都有键名，None 档为空串（B4 已接线；"文件是否真在盘上"由 ⑰ 组单独查）',
            order.every((t) => !!getTierSpec(t).sfx) && getTierSpec(HitFeelTier.None).sfx === '',
            order.map((t) => getTierSpec(t).sfx).join(' / '));
        ok('印痕参数合法（半径/线宽/条数 ≥ 0）', order.every((t) => {
            const m = getTierSpec(t).mark;
            return m.ringRadius >= 0 && m.lineWidth >= 0 && m.ticks >= 0 && m.rings >= 0 && m.shards >= 0;
        }));
    }

    /* ==================== ⑩ 印痕画法（B2，真跑 HitVfxLayer） ==================== */
    g('⑩ 印痕画法（一档一个形状：刻度条数 / 环层数 / 对位十字 / 碎片）');
    {
        // 每个档位单独喂一次事件，看它到底画了几笔 —— 期望值全部来自档位表的 mark 规格
        const cases = [
            { label: 'T0 普攻', tier: HitFeelTier.Micro, fire: (b) => b.emit(EV_HIT, hit(hero, goblin)) },
            { label: 'T1 暴击', tier: HitFeelTier.Crit, fire: (b) => b.emit(EV_HIT, hit(hero, goblin, { isCrit: true })) },
            { label: 'T3 技能', tier: HitFeelTier.Elite, fire: (b) => b.emit(EV_HIT, hit(hero, goblin, { ability: { id: 16 } })) },
            { label: 'T4 Boss', tier: HitFeelTier.BossHit, fire: (b) => b.emit(EV_HIT, hit(hero, boss)) },
            { label: 'T6 英雄受击', tier: HitFeelTier.HeroHurt, fire: (b) => b.emit(EV_HIT, hit(goblin, hero)) },
            { label: 'T2 击杀', tier: HitFeelTier.Kill, fire: (b) => b.emit(EV_DEATH, { entity: goblin, killer: hero }) },
            { label: 'T5 大击杀', tier: HitFeelTier.BigKill, fire: (b) => b.emit(EV_DEATH, { entity: elite, killer: hero }) },
            { label: 'T7 通关', tier: HitFeelTier.Clear, fire: (b) => b.emit(EV_DEATH, { entity: finalBoss, killer: hero }) },
        ];
        HitFeelDirector.active = null;                 // 无导演 → k = 1 → 画出来的就是档位表的原值

        let shapeOk = true;
        let radiusOk = true;
        let fillOk = true;
        const shapeDetail = [];
        const radiusDetail = [];
        for (const c of cases) {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            const spec = getTierSpec(c.tier).mark;
            c.fire(bus);
            // 推到 62.5ms：此时该档所有图元（含最后一层环、对位十字、刻度）都还没结束
            for (let i = 0; i < 15; i++) layer.update(1 / 240);
            const s = shot(gfx);
            const wantCircles = spec.rings;
            const wantSegs = spec.ticks + (spec.cross ? 2 : 0);
            if (s.circles !== wantCircles || s.segs !== wantSegs || s.rects !== spec.shards) shapeOk = false;
            shapeDetail.push(`${c.label} 环${s.circles}/${wantCircles} 段${s.segs}/${wantSegs} 块${s.rects}/${spec.shards}`);
            // 细环只描边：填充只允许出现在碎片上（每块碎片 = 一次 rect + fill）
            if (s.fills !== spec.shards) fillOk = false;

            // 环最终要扩散到档位表的 ringRadius（把整条寿命走完取最大半径，误差 ≤ 3%）
            const maxR = maxCircleRadiusOverLife(layer, gfx, 60, 1 / 240);
            const ratio = spec.ringRadius > 0 ? maxR / spec.ringRadius : 1;
            if (!(ratio >= 0.97 && ratio <= 1.001)) radiusOk = false;
            radiusDetail.push(`${c.label} ${fmt(maxR, 1)}/${spec.ringRadius}`);
            layer.unbind();
        }
        ok('每档画出的图元数 = 档位表（环层数 / 刻度段数 + 对位十字两臂 / 碎片块数）', shapeOk, shapeDetail.join(' · '));
        ok('环最终扩散到档位表的 ringRadius（外环最大半径与表一致）', radiusOk, radiusDetail.join(' · '));
        ok('细环只描边不填充（fill 次数恒等于碎片块数，命中档为 0）', fillOk);

        // 方向性：刻度是"垂直于伤害方向"的一排短线 —— 攻击者在左（方向 +x）时，刻度应当是竖线
        {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            const shooter = makeEntity(31, UnitKind.Normal, -100, 0);
            bus.emit(EV_HIT, hit(shooter, goblin));            // 方向 = (+1, 0)
            for (let i = 0; i < 15; i++) layer.update(1 / 240);
            let vertical = true;
            let tickCount = 0;
            for (const s of gfx.frameStrokes) {
                for (const p of s.paths) {
                    if (p.kind !== 'poly' || p.pts.length < 2) continue;
                    tickCount++;
                    // 垂直于 +x 方向 = 竖直：两端 x 相同、y 不同
                    if (Math.abs(p.pts[0].x - p.pts[1].x) > 1e-6) vertical = false;
                }
            }
            ok('刻度垂直于伤害方向（攻击者在左 → 刻度是竖线；T0 共 1 条）',
                vertical && tickCount === getTierSpec(HitFeelTier.Micro).mark.ticks,
                `竖线 ${vertical} 条数 ${tickCount}`);
            layer.unbind();
        }

        // 密度衰减真的乘到了印痕尺寸上（把导演绑上、喂一屏的命中，让 k 掉下来）
        {
            const dir = makeDirector();
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            for (let i = 0; i < 20; i++) dir.bus.emit(EV_HIT, hit(hero, goblin));
            dir.d.tick(DT);
            const k = dir.d.densityScale;
            bus.emit(EV_HIT, hit(hero, goblin));
            const maxR = maxCircleRadiusOverLife(layer, gfx, 60, 1 / 240);
            const want = getTierSpec(HitFeelTier.Micro).mark.ringRadius;
            ok('密度高时印痕按 k 缩小（环半径 = 档位值 × k）',
                k < 1 && maxR <= want * k + 0.05 && maxR >= want * k * 0.97,
                `k=${fmt(k, 3)} 环 ${fmt(maxR, 1)} ≈ ${fmt(want * k, 1)}（档位值 ${want}）`);
            layer.unbind();
            dir.d.unbind();
        }
    }

    /* ==================== ⑪ 印痕预算与合并 ==================== */
    g('⑪ 印痕预算与合并（G2 合并 / 每秒新建上限 / 并发上限淘汰最弱档 / 碎片上限）');
    HitFeelDirector.active = null;
    {
        // (a) 同帧 + 同点 + 同档 → 合并成一个（AoE 打一片读作"这一片被盖了一章"）
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            for (let i = 0; i < 20; i++) bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
            layer.update(DT);
            ok('同帧 20 次同点同档命中 → 只盖 1 个印痕（其余合并，计数在 merged）',
                layer.aliveMarkCount === 1 && layer.stats.marks === 1 && layer.stats.merged === 19,
                `alive=${layer.aliveMarkCount} marks=${layer.stats.marks} merged=${layer.stats.merged}`);
            layer.unbind();
        }
        // (b) 相距超过合并半径 → 各盖各的（不能把半屏外的一起并进来）
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            // ⚠ 距离要**从 goblin 的位置量**（它在 x=100）——写成 `mergeRadius*2` 只有 160，
            //   离 goblin 才 60px，正好落在合并半径内（这一条第一次就是这么写错的）
            const far = makeEntity(41, UnitKind.Normal, goblin.position.x + HIT_FEEL_MARK.mergeRadius * 2, 0);
            bus.emit(EV_HIT, hit(hero, goblin));
            bus.emit(EV_HIT, hit(hero, far));
            layer.update(DT);
            ok('相距 > 合并半径的同档命中不合并（各盖一个印痕）',
                layer.aliveMarkCount === 2 && layer.stats.merged === 0,
                `alive=${layer.aliveMarkCount} merged=${layer.stats.merged}`);
            layer.unbind();
        }
        // (c) 同点但不同档 → 不合并（暴击与普攻的印痕形状不同，合起来会同时说谎）
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            bus.emit(EV_HIT, hit(hero, goblin));
            bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
            layer.update(DT);
            ok('同点但档位不同 → 不合并（暴击的对位十字必须独立可见）',
                layer.aliveMarkCount === 2 && layer.stats.merged === 0,
                `alive=${layer.aliveMarkCount} merged=${layer.stats.merged}`);
            layer.unbind();
        }
        // (d) 每秒新建上限 + 并发上限
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            const N = 100;
            for (let i = 0; i < N; i++) {
                bus.emit(EV_HIT, hit(hero, makeEntity(1000 + i, UnitKind.Normal, i * 200 + 10000, 0)));
            }
            layer.update(DT);
            ok(`每秒新建上限 ${HIT_FEEL_BUDGET.markSpawnPerSecMax}：超出的**丢弃并计数**（不排队不补偿）`,
                layer.stats.spawnDropped === N - HIT_FEEL_BUDGET.markSpawnPerSecMax,
                `丢弃 ${layer.stats.spawnDropped} 个（共 ${N} 次命中）`);
            ok(`并发上限 ${HIT_FEEL_BUDGET.markAliveMax}：在场数恒不超上限，超出部分被淘汰`,
                layer.aliveMarkCount <= HIT_FEEL_BUDGET.markAliveMax
                && layer.stats.alivePeak <= HIT_FEEL_BUDGET.markAliveMax
                && layer.stats.evicted === HIT_FEEL_BUDGET.markSpawnPerSecMax - layer.aliveMarkCount,
                `alive=${layer.aliveMarkCount} 峰值=${layer.stats.alivePeak} 淘汰=${layer.stats.evicted}`);
            layer.unbind();
        }
        // (e) 淘汰的顺序：先淘汰**最弱档里最老的**，绝不能把暴击挤掉
        {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            for (let i = 0; i < HIT_FEEL_BUDGET.markAliveMax - 1; i++) {
                bus.emit(EV_HIT, hit(hero, makeEntity(2000 + i, UnitKind.Normal, i * 200 + 20000, 0)));
            }
            bus.emit(EV_HIT, hit(hero, makeEntity(2999, UnitKind.Normal, -5000, 0), { isCrit: true }));
            layer.update(DT);
            const before = layer.aliveMarkCount;
            // 再来一个最弱档 → 必须挤掉一个 T0，而不是那个暴击
            bus.emit(EV_HIT, hit(hero, makeEntity(3000, UnitKind.Normal, 5000, 0)));
            const maxR = maxCircleRadiusOverLife(layer, gfx, 40, 1 / 240);
            const critR = getTierSpec(HitFeelTier.Crit).mark.ringRadius;
            const microR = getTierSpec(HitFeelTier.Micro).mark.ringRadius;
            ok('并发超限时淘汰的是最弱档（暴击印痕活下来，环半径压过 T0 档）',
                before === HIT_FEEL_BUDGET.markAliveMax && layer.stats.evicted === 1
                && maxR > microR && maxR >= critR * 0.97,
                `淘汰 ${layer.stats.evicted} 个；最大环 ${fmt(maxR, 1)}（T0=${microR} 暴击=${critR}）`);
            layer.unbind();
        }
        // (f) 碎片上限（碎片是残骸，没有档位可分，超限淘汰最老的）
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            for (let i = 0; i < 30; i++) {
                bus.emit(EV_DEATH, { entity: makeEntity(4000 + i, UnitKind.Normal, i * 200 + 40000, 0), killer: hero });
            }
            layer.update(DT);
            ok(`碎片并发上限 ${HIT_FEEL_BUDGET.shardAliveMax}：在场数不超上限，超出淘汰最老的`,
                layer.aliveShardCount <= HIT_FEEL_BUDGET.shardAliveMax && layer.stats.shardsDropped > 0,
                `在场 ${layer.aliveShardCount} 淘汰 ${layer.stats.shardsDropped}（共生成 ${layer.stats.shards}）`);
            layer.unbind();
        }
    }

    /* ==================== ⑫ 起手印痕 + 换局清场 + 掉帧守卫 ==================== */
    g('⑫ 起手印痕（不延后结算的"前摇"）+ 换局清场 + 掉帧守卫');
    {
        // (a) 出手 → 一条朝目标的虚线（风格预设的"预告线"语法）
        {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            const shooter = makeEntity(51, UnitKind.Hero, 0, 0);
            const tgt = makeEntity(52, UnitKind.Normal, 200, 0);
            bus.emit(EV_ATK, { attacker: shooter, target: tgt, damage: 10 });
            layer.update(1 / 240);
            const s = shot(gfx);
            const segLens = [];
            const xs = [];
            const ys = [];
            for (const p of gfx.frameStrokes[0]?.paths ?? []) {
                if (p.kind !== 'poly' || p.pts.length < 2) continue;
                segLens.push(Math.hypot(p.pts[1].x - p.pts[0].x, p.pts[1].y - p.pts[0].y));
                for (const pt of p.pts) { xs.push(pt.x); ys.push(pt.y); }
            }
            ok('出手画的是虚线（段数 = attackDashes、每段长 = attackDashLen、没有环、没有填充）',
                s.circles === 0 && s.fills === 0 && s.strokes === 1
                && s.strokeSegs[0] === HIT_FEEL_MARK.attackDashes
                && segLens.length === HIT_FEEL_MARK.attackDashes
                && segLens.every((v) => near(v, HIT_FEEL_MARK.attackDashLen, 0.01)),
                `段长 ${segLens.map((v) => fmt(v, 1)).join(',')}（期望 ${HIT_FEEL_MARK.attackDashLen}）`);
            ok('虚线沿伤害方向（目标在 +x → 全部 y = 0 且 x > 0）',
                ys.every((v) => Math.abs(v) < 1e-9) && Math.min(...xs) > 0,
                `x∈[${fmt(Math.min(...xs), 1)}, ${fmt(Math.max(...xs), 1)}] y 全 0`);
            for (let i = 0; i < 24; i++) layer.update(1 / 240);         // 100ms > 寿命 80ms
            ok(`起手印痕是"预告"不是"结果"：寿命只有 ${HIT_FEEL_MARK.attackLifeMs}ms，早已回收`,
                layer.aliveMarkCount === 0);
            layer.unbind();
        }
        // (b) 攻击者与目标完全重合（方向退化）→ 不画（没有方向就画不出方向性）
        {
            const bus = makeBus();
            const { layer } = makeVfxLayer(mod, cc, bus);
            const same = makeEntity(53, UnitKind.Normal, 0, 0);
            bus.emit(EV_ATK, { attacker: same, target: same, damage: 1 });
            layer.update(DT);
            ok('起手点与目标重合 → 不画虚线（方向退化时不硬画）',
                layer.aliveMarkCount === 0 && layer.stats.attacks === 0);
            layer.unbind();
        }
        // (c) 换局清场：unbind 必须把印痕/碎片/订阅全清掉，重绑后不残留
        {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            bus.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
            bus.emit(EV_DEATH, { entity: goblin, killer: hero });
            layer.update(DT);
            const aliveBefore = layer.aliveMarkCount + layer.aliveShardCount;
            const clears = gfx.clearCount;
            layer.unbind();
            ok('unbind：印痕与碎片全部回收 + 画布清空 + 三个事件全部退订',
                aliveBefore > 0 && layer.aliveMarkCount === 0 && layer.aliveShardCount === 0
                && gfx.clearCount === clears + 1
                && bus.listenerCount(EV_HIT) === 0 && bus.listenerCount(EV_DEATH) === 0 && bus.listenerCount(EV_ATK) === 0,
                `清掉 ${aliveBefore} 个图元`);
            layer.bind({ bus });
            ok('重新 bind：每个事件恰好 1 个 handler（不叠加）',
                bus.listenerCount(EV_HIT) === 1 && bus.listenerCount(EV_DEATH) === 1 && bus.listenerCount(EV_ATK) === 1);
            const clears2 = gfx.clearCount;
            for (let i = 0; i < 5; i++) layer.update(DT);
            ok('重新 bind 后空场上**不重绘**（上一局的印痕没有残留到新一局）',
                gfx.clearCount === clears2 && shot(gfx).strokes === 0,
                `clear 次数 ${gfx.clearCount}`);
            layer.unbind();
        }
        // (d) 掉帧守卫：注入 200ms 大卡顿连跑 600 帧
        {
            const bus = makeBus();
            const { layer, g: gfx } = makeVfxLayer(mod, cc, bus);
            let err = null;
            try {
                for (let i = 0; i < 600; i++) {
                    if (i % 37 === 0) bus.emit(EV_HIT, hit(hero, goblin, { isCrit: i % 3 === 0 }));
                    if (i % 53 === 0) bus.emit(EV_DEATH, { entity: goblin, killer: hero });
                    if (i % 71 === 0) bus.emit(EV_ATK, { attacker: goblin, target: hero, damage: 1 });
                    layer.update(clampBattleDt(i % 100 === 99 ? 0.2 : DT));
                    if (!geometryFinite(gfx)) throw new Error(`第 ${i} 帧出现非有限值`);
                    if (layer.aliveMarkCount > HIT_FEEL_BUDGET.markAliveMax) throw new Error(`第 ${i} 帧印痕越界`);
                    if (layer.aliveShardCount > HIT_FEEL_BUDGET.shardAliveMax) throw new Error(`第 ${i} 帧碎片越界`);
                }
            } catch (e) { err = e; }
            ok('注入 200ms 卡顿连跑 600 帧：无异常、无 NaN 坐标、并发始终在预算内', !err, err ? err.message : '');
            ok('长跑后没有任何泄漏（在场数回落，统计自洽）',
                layer.aliveMarkCount <= HIT_FEEL_BUDGET.markAliveMax
                && layer.stats.marks + layer.stats.attacks >= layer.stats.merged
                && layer.stats.redraws <= 600,
                `marks=${layer.stats.marks} attacks=${layer.stats.attacks} merged=${layer.stats.merged} redraws=${layer.stats.redraws}`);
            layer.unbind();
        }
    }

    /* ==================== ⑬ 墨色闪帧（C10） ==================== */
    g('⑬ 墨色闪帧（C10：只有 T5/T6/T7 · α ≤ 0.10 · 50ms · 1.5s 冷却）');
    {
        const a = makeDirector();
        a.bus.emit(EV_HIT, hit(hero, goblin));
        a.d.tick(DT);
        ok('普攻命中不闪（浅底上墨色必须稀缺）', a.d.flashAlpha === 0 && a.d.stats.flashes === 0, `α=${a.d.flashAlpha}`);

        const { d, bus } = makeDirector();
        bus.emit(EV_HIT, hit(goblin, hero));                 // T6 英雄受击
        d.tick(DT);
        ok('英雄受击闪一下（T6）', d.stats.flashes === 1 && d.flashAlpha > 0, `α=${fmt(d.flashAlpha, 4)}`);
        ok('闪帧峰值 α = 档位表的 flashFrameAlpha（且 ≤ 硬上限 0.10）',
            near(d.flashPeak, getTierSpec(HitFeelTier.HeroHurt).flashFrameAlpha, 1e-9)
            && d.flashPeak <= HIT_FEEL_BUDGET.flashMaxAlpha + 1e-9
            && d.flashAlpha <= d.flashPeak + 1e-9,
            `峰值=${fmt(d.flashPeak, 4)}（表 ${getTierSpec(HitFeelTier.HeroHurt).flashFrameAlpha} / 上限 ${HIT_FEEL_BUDGET.flashMaxAlpha}）本帧画 ${fmt(d.flashAlpha, 4)}`);
        run(d, 4, () => { });
        ok(`闪帧在 ${HIT_FEEL_BUDGET.flashMs}ms 内归零（≈3 帧，够"闪一下"不够"暗一下"）`, d.flashAlpha === 0);

        const before = d.stats.flashes;
        for (let i = 0; i < 30; i++) { bus.emit(EV_HIT, hit(goblin, hero)); d.tick(DT); }
        ok('冷却期内不再闪（**丢弃并计数**，不排队不叠加）',
            d.stats.flashes === before && d.stats.flashesDropped > 0,
            `flashes=${d.stats.flashes} dropped=${d.stats.flashesDropped}`);
        run(d, 100, () => { });                              // 再推 1.67s → 冷却走完
        bus.emit(EV_HIT, hit(goblin, hero));
        d.tick(DT);
        ok('冷却（1.5s）走完后可以再闪', d.stats.flashes === before + 1, `flashes=${d.stats.flashes}`);

        const kill = makeDirector();
        kill.bus.emit(EV_DEATH, { entity: elite, killer: hero });   // T5 大击杀
        kill.d.tick(DT);
        const clear = makeDirector();
        clear.bus.emit(EV_DEATH, { entity: finalBoss, killer: hero }); // T7 通关
        clear.d.tick(DT);
        ok('T5/T7 也闪（三个峰值档位都有）', kill.d.flashAlpha > 0 && clear.d.flashAlpha > 0,
            `T5=${fmt(kill.d.flashAlpha, 4)} T7=${fmt(clear.d.flashAlpha, 4)}`);
    }

    /* ==================== ⑭ 屏幕层（F7 边缘角标 · F4 连击 · 墨闪渲染） ==================== */
    g('⑭ 屏幕层（F7 四角报红 · F4 连击计数 · C10 墨闪渲染）');
    {
        // (a) F7：英雄受击 → 四角各两条臂
        // ⚠ 先把全局导演句柄清掉：屏幕层的墨闪读的是 `HitFeelDirector.active`，
        //   上一组留下的导演会让这一帧多出一个整屏矩形（本组要精确数笔画）
        HitFeelDirector.active = null;
        const busA = makeBus();
        const a = makeScreenLayer(mod, cc, busA);
        busA.emit(EV_HIT, hit(goblin, hero));
        a.layer.update(DT);
        const sa = shot(a.g);
        ok('英雄受击 → 四角各两条臂（8 段折线，一次 stroke、无圆无填充）',
            sa.segs === 8 && sa.circles === 0 && sa.fills === 0, `段=${sa.segs} 圆=${sa.circles} 填=${sa.fills}`);
        const pts = strokePoints(a.g);
        const halfW = 750 / 2 - HIT_FEEL_INFO.hurtMarkInset;
        const halfH = 1334 / 2 - HIT_FEEL_INFO.hurtMarkInset;
        const cornerOk = pts.length === 16
            && pts.every((p) => (near(Math.abs(p.x), halfW, 0.01) || near(Math.abs(p.x), halfW - HIT_FEEL_INFO.hurtMarkArm, 0.01))
                && (near(Math.abs(p.y), halfH, 0.01) || near(Math.abs(p.y), halfH - HIT_FEEL_INFO.hurtMarkArm, 0.01)));
        ok('角标贴在屏幕四角（|x| = 屏宽/2 − inset，臂长 = hurtMarkArm）', cornerOk,
            `|x| ∈ {${fmt(halfW, 0)}, ${fmt(halfW - HIT_FEEL_INFO.hurtMarkArm, 0)}}`);
        const ca = a.g.frameStrokes[0].color;
        ok('角标用 c-danger #C0392B（不用英雄受击色 #FF4C4C：颜色通道只回答"打谁"）',
            ca[0] === 0xc0 && ca[1] === 0x39 && ca[2] === 0x2b, `rgb(${ca[0]},${ca[1]},${ca[2]})`);
        advance(a.layer, 30, DT);                            // 500ms > hurtMarkMs（注意不能一次推 0.42s：层内会把 dt 钳到 50ms）
        ok('角标到点自己收掉（不留残影）', !a.layer.hurtMarkShown && shot(a.g).segs === 0);

        const busB = makeBus();
        const b = makeScreenLayer(mod, cc, busB);
        busB.emit(EV_HIT, hit(hero, goblin));                 // 打怪
        b.layer.update(DT);
        ok('打怪不报角标（只有自己挨打才报）', b.g.totalStrokes === 0 && !b.layer.hurtMarkShown);

        // (b) F4：连击计数（**数击杀不数命中**）
        const busC = makeBus();
        const c = makeScreenLayer(mod, cc, busC);
        c.layer.killReward(0, 0, 3, 1);
        c.layer.update(DT);
        ok('1 连击不显示（没有信息量，别占屏幕）', c.layer.comboCountNow === 1 && !c.layer.comboShown);
        c.layer.killReward(20, 0, 3, 1);
        c.layer.update(DT);
        ok('2 连击 → 显示', c.layer.comboCountNow === 2 && c.layer.comboShown);
        // 窗口（2.5s）内再来一次 → 继续累加
        advance(c.layer, 60, DT);                                // 1s
        c.layer.killReward(40, 0, 3, 1);
        c.layer.update(DT);
        ok('窗口内继续累加（2.5s 断连）', c.layer.comboCountNow === 3, `连击=${c.layer.comboCountNow}`);
        // 窗口走完 → 淡出 → 清零
        advance(c.layer, 200, DT);
        ok('断连后淡出并清零', c.layer.comboCountNow === 0 && !c.layer.comboShown, `连击=${c.layer.comboCountNow}`);

        // (c) 墨闪渲染：α 由导出演，本层只画（整屏实心矩形）
        // ⚠ 屏幕层与导演**共用同一条假总线**：英雄受击这一个事件要同时喂给两边
        //   （导演出 α、屏幕层出角标）—— 各用各的 bus 会只画出一半（第一版就是这么写错的）
        const dir = makeDirector();
        const d = makeScreenLayer(mod, cc, dir.bus);
        dir.bus.emit(EV_HIT, hit(goblin, hero));
        dir.d.tick(DT);
        d.layer.update(DT);
        const sd = shot(d.g);
        ok('墨闪画成整屏实心矩形（与四角角标同一帧共存）',
            sd.fills === 1 && sd.segs === 8, `填=${sd.fills} 段=${sd.segs}`);
        const fill = d.g.frameFills[0];
        ok('墨闪颜色 = 墨 #14181B、α ≤ 0.10',
            fill.color[0] === 0x14 && fill.color[1] === 0x18 && fill.color[2] === 0x1b && fill.color[3] <= 26,
            `rgb(${fill.color[0]},${fill.color[1]},${fill.color[2]}) α=${(fill.color[3] / 255).toFixed(3)}`);
        const rect = fill.paths[0];
        ok('矩形盖住整个可见区（750×1334 再加一圈余量）', rect.w >= 750 && rect.h >= 1334, `${rect.w}×${rect.h}`);
        dir.d.unbind();
    }

    /* ==================== ⑮ 击杀落款与奖励飞入（F8 / F9） ==================== */
    g('⑮ 击杀落款与奖励飞入（F8 落款 1.2s · F9 沿弧线飞向 HUD 锚点）');
    {
        const anchor = { gold: { x: 200, y: 420 }, exp: { x: 240, y: 360 } };
        const bus = makeBus();
        const { layer, g: gfx } = makeScreenLayer(mod, cc, bus, { rewardAnchor: () => anchor });
        layer.killReward(0, 0, 5, 2);
        ok('一次击杀 → 1 个落款 + 金币/经验各一块奖励',
            layer.stats.killTags === 1 && layer.stats.loots === 2 && layer.tagAlive === 1 && layer.lootAlive === 2,
            `落款=${layer.tagAlive} 奖励=${layer.lootAlive}`);

        // 飞到末尾（0.45s 的 96%）→ 奖励块应当已经贴到锚点上
        for (let i = 0; i < 104; i++) layer.update(1 / 240);
        const fills = gfx.frameFills.map((f) => f.paths[0]).filter((p) => p && p.w === HIT_FEEL_INFO.lootSize);
        const half = HIT_FEEL_INFO.lootSize / 2;
        const nearGold = fills.some((p) => Math.abs(p.x + half - anchor.gold.x) < 8 && Math.abs(p.y + half - anchor.gold.y) < 8);
        ok('金币块飞到 HUD 金币数字上（误差 < 8px）', nearGold,
            fills.map((p) => `(${fmt(p.x + half, 0)},${fmt(p.y + half, 0)})`).join(' '));
        // 空心方块（经验）用 stroke 画
        const expRects = gfx.frameStrokes.map((s) => s.paths[0]).filter((p) => p && p.kind === 'rect');
        ok('经验块是空心方块（形状承载"哪种奖励"，颜色通道不参与）', expRects.length >= 1);

        // 没有 HUD 锚点 → 退化成"朝右上飞"，绝不静默不画
        const bus2 = makeBus();
        const noAnchor = makeScreenLayer(mod, cc, bus2);
        noAnchor.layer.killReward(0, 0, 5, 0);
        ok('没有 HUD 锚点也照飞（退化成朝右上，不静默丢表现）', noAnchor.layer.lootAlive === 1);
        for (let i = 0; i < 104; i++) noAnchor.layer.update(1 / 240);
        const f2 = noAnchor.g.frameFills.map((f) => f.paths[0]).filter((p) => p && p.w === HIT_FEEL_INFO.lootSize);
        ok('退化路径确实朝右上飞（x > 0 且 y > 0）',
            f2.length === 1 && f2[0].x > 0 && f2[0].y > 0, f2.length ? `(${fmt(f2[0].x, 0)},${fmt(f2[0].y, 0)})` : '无');

        // 并发上限
        const bus3 = makeBus();
        const many = makeScreenLayer(mod, cc, bus3);
        for (let i = 0; i < 20; i++) many.layer.killReward(i * 10, 0, 5, 0);
        many.layer.update(DT);
        ok(`奖励块并发上限 ${HIT_FEEL_INFO.lootAliveMax}（超限淘汰最老的）`,
            many.layer.lootAlive <= HIT_FEEL_INFO.lootAliveMax && many.layer.stats.lootsDropped > 0,
            `在场 ${many.layer.lootAlive} 淘汰 ${many.layer.stats.lootsDropped}`);

        // 落款寿命 1.2s
        const bus4 = makeBus();
        const tag = makeScreenLayer(mod, cc, bus4);
        tag.layer.killReward(0, 0, 5, 0);
        advance(tag.layer, Math.ceil((HIT_FEEL_INFO.killTagMs + 20) / 1000 / DT), DT);
        ok(`落款 ${HIT_FEEL_INFO.killTagMs}ms 后回收`, tag.layer.tagAlive === 0);

        // 换局清场
        const cle = makeScreenLayer(mod, cc, makeBus());
        cle.layer.killReward(0, 0, 5, 5);
        cle.layer.update(DT);
        const before = cle.layer.tagAlive + cle.layer.lootAlive;
        cle.layer.unbind();
        ok('unbind：落款/奖励/连击/角标全部清空，画布也清了',
            before > 0 && cle.layer.tagAlive === 0 && cle.layer.lootAlive === 0
            && cle.layer.comboCountNow === 0 && !cle.layer.hurtMarkShown && cle.g.clearCount > 0);
    }

    /* ==================== ⑯ 延迟掉血条（F6） ==================== */
    g(`⑯ 延迟掉血条（F6：血条瞬时到位，残影条 ${HP_BAR.lagSec}s 内先快后慢地追上）`);
    {
        const { HpBar } = mod('game_stage', 'entityview', 'HpBar.js');
        /** 造一个"单位根节点 + hp_bar"的假树（与 one.prefab 的结构一致：hp_bar 是根下唯一子节点） */
        const makeUnit = (baseScale) => {
            const root = new cc.Node('unit');
            const hp = new cc.Node(HP_BAR.nodeName);
            root.addChild(hp);
            const trans = hp.addComponent(cc.UITransform);
            trans.setContentSize(20, HP_BAR.worldHeight);
            trans.setAnchorPoint(0, 0.5);
            const sp = hp.addComponent(cc.Sprite);
            sp.spriteFrame = { fake: 'default_sprite_splash' };
            sp.color = new cc.Color(245, 33, 33, 255);
            hp.addComponent(cc.Widget).enabled = true;
            root.setScale(baseScale, baseScale, 1);
            return { root, hp, trans, sp };
        };

        const { root, hp, trans, sp } = makeUnit(1.5);
        const bar = new HpBar();
        bar.attach(hp, 1.5);
        const lag = root.getChildByName(HP_BAR.lagNodeName);
        ok('残影条是**运行时建**的兄弟节点，且插在 hp_bar 之前（= 画在血条下面）',
            !!lag && root.children.indexOf(lag) === 0 && root.children.indexOf(hp) === 1,
            `子节点顺序 = [${root.children.map((n) => n.name).join(', ')}]`);
        const lagSp = lag?.getComponent(cc.Sprite);
        ok('残影条**借** hp_bar 的 SpriteFrame（不新增资源、不做异步 load）',
            lagSp?.spriteFrame === sp.spriteFrame && lagSp.spriteFrame != null);
        ok(`残影条颜色 = 墨 #14181B α${HP_BAR.lagAlpha}（浅底上白色残影等于没画）`,
            lagSp.color.r === 0x14 && lagSp.color.g === 0x18 && lagSp.color.b === 0x1b
            && Math.abs(lagSp.color.a - Math.round(HP_BAR.lagAlpha * 255)) <= 1,
            `rgba(${lagSp.color.r},${lagSp.color.g},${lagSp.color.b},${lagSp.color.a})`);
        ok('Widget 被关掉（宽度的唯一写入方仍是 HpBar）', hp.getComponent(cc.Widget).enabled === false);
        ok('默认隐藏：血条与残影条都不显示', !hp.active && !lag.active);
        ok('高度补偿用**基准 scale**（受击膨胀改了父缩放也不跟着跳）',
            near(hp.scale.y, 1 / 1.5, 1e-9) && near(lag.scale.y, 1 / 1.5, 1e-9),
            `hp.scale.y=${fmt(hp.scale.y, 4)} lag.scale.y=${fmt(lag.scale.y, 4)}`);

        // 掉血：血条瞬时到位，残影条留在原处
        bar.hit(1);
        ok('受击后两条都显示，且都是满血长度',
            hp.active && lag.active && near(trans.width, 20, 1e-9) && near(lag.getComponent(cc.UITransform).width, 20, 1e-9));
        bar.hit(0.5);
        ok('血条**瞬时**掉到 50%，残影条留在原来的 100%（差出来的一段就是"这一下打掉了多少"）',
            near(trans.width, 10, 1e-9) && near(lag.getComponent(cc.UITransform).width, 20, 1e-9),
            `血条=${fmt(trans.width, 1)} 残影=${fmt(lag.getComponent(cc.UITransform).width, 1)}`);

        // 追赶：单调、先快后慢、0.6s 内贴上
        const lagTrans = lag.getComponent(cc.UITransform);
        const samples = [];
        for (let i = 0; i < 36; i++) { bar.tick(DT); samples.push(lagTrans.width); }
        const monotone = samples.every((v, i) => i === 0 || v <= samples[i - 1] + 1e-9);
        ok('残影条只往回收、不回头（单调）', monotone, samples.map((v) => fmt(v, 1)).join(' '));
        ok('0.3s 时已经收掉大半（ease-out 先快后慢，不是匀速飘）', samples[17] <= 12.5, `0.3s → ${fmt(samples[17], 2)}px（起点 20 → 终点 10）`);
        advance(bar, 6, DT);
        ok(`${HP_BAR.lagSec}s 内贴上血条`, near(lagTrans.width, 10, 1e-9), `${fmt(lagTrans.width, 3)}px`);

        // 回血：残影条直接跟到位（追"回血"没有信息量）
        bar.hit(0.8);
        ok('回血时残影条直接跟到位（不反向追）', near(lagTrans.width, 16, 1e-9) && near(trans.width, 16, 1e-9));

        // 回收：两条都复位
        bar.reset();
        ok('reset：两条都隐藏 + 长度回到满血 + 缩放复位',
            !hp.active && !lag.active && near(trans.width, 20, 1e-9)
            && near(lagTrans.width, 20, 1e-9) && near(hp.scale.y, 1, 1e-9) && near(lag.scale.y, 1, 1e-9));

        // 池化复用：同一条血条 attach 到另一只怪（长度不重算、残影不残留）
        bar.hit(0.4);
        bar.attach(hp, 1.5);
        ok('池化复用（重新 attach）不残留上一只的残血与残影',
            !hp.active && !lag.active && near(trans.width, 20, 1e-9) && near(lagTrans.width, 20, 1e-9));
    }

    /* ==================== ⑰ 音效账本（B4） ==================== */
    g(`⑰ 音效账本（B4：每 ${HIT_FEEL_BUDGET.sfxWindowMs}ms 最多 ${HIT_FEEL_BUDGET.sfxMaxPerWindow} 声 · 同帧只出最强档那一声 · 音量不吃密度 k）`);
    {
        // ---------- 表侧（不需要音频文件、不需要总线） ----------
        const tierOrder = Object.keys(HIT_FEEL_TIERS);
        const voiced = tierOrder.map((t) => HIT_FEEL_TIERS[t]).filter((s) => !!s.sfx);
        ok('除 None 档外每档都有音效键（None = 英雄死亡，由结算面板接管，不发声）',
            HIT_FEEL_TIERS[HitFeelTier.None].sfx === '' && voiced.length === 8,
            `${voiced.length} 档发声：${voiced.map((s) => s.sfx).join(' / ')}`);
        ok('发声档位的音量都在 (0, 1]',
            voiced.every((s) => s.sfxVolume > 0 && s.sfxVolume <= 1),
            voiced.map((s) => s.sfxVolume).join(', '));
        ok('普攻（最高频档）音量最低 —— 0.83s 一次，响一点就是"哒哒哒"的白噪音',
            HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume < HIT_FEEL_TIERS[HitFeelTier.Kill].sfxVolume
            && HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume < HIT_FEEL_TIERS[HitFeelTier.Crit].sfxVolume,
            `T0=${HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume} · T1=${HIT_FEEL_TIERS[HitFeelTier.Crit].sfxVolume} · T2=${HIT_FEEL_TIERS[HitFeelTier.Kill].sfxVolume}`);
        ok('英雄受击音量 >= 暴击（自己的血最重要，与档位强弱序同口径）',
            HIT_FEEL_TIERS[HitFeelTier.HeroHurt].sfxVolume >= HIT_FEEL_TIERS[HitFeelTier.Crit].sfxVolume,
            `T6=${HIT_FEEL_TIERS[HitFeelTier.HeroHurt].sfxVolume}`);
        ok('通关音量是全表最高（一局只响一次）',
            voiced.every((s) => s.sfxVolume <= HIT_FEEL_TIERS[HitFeelTier.Clear].sfxVolume));
        ok('出手音比命中最轻档还轻（它是"预告"，不是"结果"）',
            HIT_FEEL_SFX_EXTRA.attackShot.volume < HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume,
            `${HIT_FEEL_SFX_EXTRA.attackShot.volume} < ${HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume}`);

        const variantKeys = tierOrder.filter((t) => HIT_FEEL_TIERS[t].sfxVariants > 1).map((t) => HIT_FEEL_TIERS[t].sfx);
        ok('只给三条"高频 / 需要听出差异"的音配了音高变体（变体 = 多份预渲染文件，不是运行时变调）',
            variantKeys.length === 3
            && variantKeys.indexOf('hit_light') >= 0 && variantKeys.indexOf('hit_crit') >= 0 && variantKeys.indexOf('kill_normal') >= 0,
            variantKeys.join(' / '));

        const keys = hitFeelSfxKeys();
        ok(`音效键表 ${keys.length} 条（11 个音 + 5 个音高变体）且无重复`,
            keys.length === 16 && new Set(keys).size === 16, `去重后 ${new Set(keys).size}`);
        ok('键名一律不带 `sfx/` 前缀、不带扩展名（前缀由 `AudioMgr.playSFX` 补）',
            keys.every((k) => k.indexOf('/') < 0 && k.indexOf('.') < 0));
        ok('全局触摸音 `click` 也在清单里（`AudioMgr.defaultTouchStart` 已经写死了这个键）',
            keys.indexOf('click') >= 0);
        ok('`hitFeelSfxKey`：variants=1 不加后缀；=3 时 roll 0 / 0.5 / 0.99 → 无 / _v2 / _v3',
            hitFeelSfxKey('k', 1, 0.9) === 'k'
            && hitFeelSfxKey('k', 3, 0) === 'k'
            && hitFeelSfxKey('k', 3, 0.5) === 'k_v2'
            && hitFeelSfxKey('k', 3, 0.99) === 'k_v3');
        ok('variants 超后缀表长被夹住（写 9 也只到 _v3 —— 免得"表里 5 个变体、盘上 3 份"静默降级）',
            hitFeelSfxKey('k', 9, 0.99) === 'k_v3');
        ok('空键返回空串（None 档"不发声"这条链的起点）', hitFeelSfxKey('', 3, 0.5) === '');
        ok('`shouldPlayAttackSfx`：英雄出手响、怪出手不响、载荷缺失也不响',
            shouldPlayAttackSfx({ attacker: hero }) === true
            && shouldPlayAttackSfx({ attacker: goblin }) === false
            && shouldPlayAttackSfx(null) === false
            && shouldPlayAttackSfx({}) === false);

        // ---------- 运行侧：假播放器记账（**不依赖任何音频文件**） ----------
        /** 装上假播放器并返回它的账本 */
        const sink = (d) => {
            const plays = [];
            d.sfxPlayer = (key, volume) => plays.push({ key, volume, frame: -1 });
            return plays;
        };

        const { d: d1, bus: b1 } = makeDirector();
        const p1 = sink(d1);
        b1.emit(EV_HIT, hit(hero, goblin));
        ok('命中当帧不响（音效与顿帧/位移走**同一条"上一帧事件、这一帧提交"**的链路）', p1.length === 0);
        d1.tick(DT);
        ok('下一帧响一声；键名是 T0 的三个变体之一、音量 = 档位表原值',
            p1.length === 1
            && ['hit_light', 'hit_light_v2', 'hit_light_v3'].indexOf(p1[0].key) >= 0
            && p1[0].volume === HIT_FEEL_TIERS[HitFeelTier.Micro].sfxVolume,
            p1.length ? `${p1[0].key} @${p1[0].volume}` : '没响');

        const { d: d2, bus: b2 } = makeDirector();
        const p2 = sink(d2);
        for (let i = 0; i < 6; i++) b2.emit(EV_HIT, hit(hero, goblin));
        d2.tick(DT);
        ok('同帧 6 次命中 → 只响 1 声、且一声都不丢（同帧合并，不是 6 声也不是 0 声）',
            p2.length === 1 && d2.stats.sfx === 1 && d2.stats.sfxDropped === 0,
            `响 ${p2.length} 丢 ${d2.stats.sfxDropped}`);

        const { d: d3, bus: b3 } = makeDirector();
        const p3 = sink(d3);
        b3.emit(EV_HIT, hit(hero, goblin));
        b3.emit(EV_HIT, hit(hero, goblin, { isCrit: true }));
        d3.tick(DT);
        ok('同帧 T0 + T1 → 只响**最强档**那一声（`hit_crit`，不是 `hit_light`）',
            p3.length === 1 && p3[0].key.indexOf('hit_crit') === 0, p3.length ? p3[0].key : '没响');

        const { d: d4, bus: b4 } = makeDirector();
        const p4 = sink(d4);
        const cum4 = [];
        for (let i = 0; i < 4; i++) { b4.emit(EV_HIT, hit(hero, goblin)); d4.tick(DT); cum4.push(p4.length); }
        ok(`连续 4 帧各一次命中 → 响 3 声、丢 1 声（第 3 帧正好撞上 50ms 边界被拦 —— 60fps 下 3 帧 = ${fmt(3 * DT * 1000, 1)}ms）`,
            d4.stats.sfx === 3 && d4.stats.sfxDropped === 1,
            `响 ${d4.stats.sfx} 丢 ${d4.stats.sfxDropped}`);
        ok('窗口是**滑动**的：第 4 帧（首声满 50ms 之后）又能响 —— 不是"每 50ms 清零一次"',
            cum4[3] === 3, `逐帧累计播放数 = ${cum4.join(',')}`);

        // 压测 1：波次节奏（每 333ms 一批 6 只）—— 同帧合并把"一批 6 只"收成 1 声
        const { d: d5, bus: b5 } = makeDirector();
        const p5 = [];
        let frameNo = 0;
        d5.sfxPlayer = (key, volume) => p5.push({ key, volume, frame: frameNo });
        for (let i = 0; i < 600; i++) {
            if (i % 20 === 0) for (let k = 0; k < 6; k++) b5.emit(EV_HIT, hit(hero, goblin));
            frameNo = i;
            d5.tick(DT);
        }
        ok('压测 1（波次节奏，10s 内 180 次命中）：只响 30 声、一次都没丢 —— 同帧合并把"一批 6 只"收成 1 声',
            p5.length === 30 && d5.stats.sfxDropped === 0 && d5.stats.hits === 180,
            `命中 ${d5.stats.hits} → 响 ${p5.length}，丢 ${d5.stats.sfxDropped}`);

        // 压测 2：真正的过载（**每帧**都命中，模拟后期 AoE/DoT 铺满）—— 节流必须真的吞掉大部分
        const { d: dS, bus: bS } = makeDirector();
        const pS = [];
        let frameNoS = 0;
        dS.sfxPlayer = (key, volume) => pS.push({ key, volume, frame: frameNoS });
        for (let i = 0; i < 120; i++) {
            bS.emit(EV_HIT, hit(hero, goblin));
            frameNoS = i;
            dS.tick(DT);
        }
        const threeInWindow = pS.some((_, i) => i + 2 < pS.length
            && (pS[i + 2].frame - pS[i].frame) * DT * 1000 < HIT_FEEL_BUDGET.sfxWindowMs);
        ok('压测 2（每帧都命中，120 帧）：**任意 50ms 内不超过 2 声**（用播放时间戳独立复算，不信导演自己的账）',
            pS.length > 0 && !threeInWindow, `共响 ${pS.length} 声`);
        // ⚠ 为什么只断言"丢了不少"而不锚定比例：60fps 下 3 帧 = 50.0ms **正好等于窗口**，
        //   边界上"老的这一声算不算过期"取决于累计 dt 的浮点尾数 —— 实测约 45% 被丢，
        //   写成 1:2 会在换帧率/改 DT 之后变成假失败。这里只锁"每帧都命中时必须明显吞量"。
        ok('压测 2 里真的吞掉了大量请求（至少 1/4）—— 节流是"每帧都命中"时的唯一挡板',
            dS.stats.sfx + dS.stats.sfxDropped === 120 && dS.stats.sfxDropped >= 30,
            `120 次命中 → 响 ${dS.stats.sfx} 丢 ${dS.stats.sfxDropped}`);

        const { d: d6, bus: b6 } = makeDirector();
        const p6 = sink(d6);
        b6.emit(EV_ATK, { attacker: goblin, target: hero, damage: 5 });
        d6.tick(DT);
        ok('怪出手**不响**（"怪在打我"由 T6 英雄受击代表，因果链更清楚）',
            p6.length === 0 && d6.stats.sfx === 0);
        b6.emit(EV_ATK, { attacker: hero, target: goblin, damage: 5 });
        b6.emit(EV_HIT, hit(hero, goblin));
        d6.tick(DT);
        ok('英雄出手 + 同一帧命中 = 正好 2 声（近战一记本来就是"两声合一记"）',
            p6.length === 2 && p6[0].key === 'attack_shot' && p6[1].key.indexOf('hit_light') === 0,
            p6.map((p) => p.key).join(' → '));
        b6.emit(EV_ATK, { attacker: hero, target: goblin, damage: 5 });
        d6.tick(DT);
        ok('紧接着的第三次请求被吞掉（**丢弃并计数**，不排队、不补到下一帧）',
            p6.length === 2 && d6.stats.sfxDropped === 1, `丢 ${d6.stats.sfxDropped}`);

        const { d: d7, bus: b7 } = makeDirector();
        const p7 = sink(d7);
        b7.emit(EV_EVADE, { attacker: hero, target: goblin, dodger: goblin });
        ok('闪避**立刻**响 `evade`（"我打空了"是要当场知道的信息，不走下一帧）',
            p7.length === 1 && p7[0].key === 'evade');

        const { d: d8, bus: b8 } = makeDirector();
        b8.emit(EV_HIT, hit(hero, goblin));
        d8.tick(DT);
        ok('没注入播放器时账本照记、不抛异常（所以本组体检能完全不依赖音频文件真跑）',
            d8.stats.sfx === 1 && d8.sfxPlayer === null);

        const { d: d9, bus: b9 } = makeDirector();
        const p9 = sink(d9);
        for (let i = 0; i < 40; i++) { b9.emit(EV_HIT, hit(hero, goblin, { isCrit: true })); d9.tick(DT); }
        ok('高密度下密度系数确实降到 k<1（否则下面那条"音量不吃 k"的断言没有意义）',
            d9.stats.densityK < 1, `k=${fmt(d9.stats.densityK, 3)}`);
        ok('**音量不吃密度系数 k** —— 40 次命中后每一声仍是档位表原值（吃 k 会让后期反馈整体消失）',
            p9.length > 0 && p9.every((p) => p.volume === HIT_FEEL_TIERS[HitFeelTier.Crit].sfxVolume),
            `响 ${p9.length} 声，音量恒为 ${fmt(HIT_FEEL_TIERS[HitFeelTier.Crit].sfxVolume, 2)}`);

        const { d: d10 } = makeDirector();
        const p10 = sink(d10);
        d10.unbind();
        ok('unbind：播放回调被清掉（不留一个已退场场景的闭包）', d10.sfxPlayer === null);
        const b10 = makeBus();
        d10.bind({ bus: b10 });
        d10.sfxPlayer = (key, volume) => p10.push({ key, volume });
        b10.emit(EV_HIT, hit(hero, goblin));
        d10.tick(DT);
        ok('换局后第一声立刻能响（节流窗口随 unbind 清空，不带上一局的残留）',
            p10.length === 1, `响 ${p10.length} 声`);

        // ---------- 素材自检（**只提示、不判失败**：素材是外部的，不能卡住代码侧门禁） ----------
        const sfxDir = path.join(ROOT, 'assets/resources/sfx');
        let wavs = [];
        try { wavs = fs.readdirSync(sfxDir).filter((f) => /\.wav$/i.test(f)); } catch (e) { wavs = []; }
        const onDisk = wavs.map((f) => f.replace(/\.wav$/i, ''));
        const missing = keys.filter((k) => onDisk.indexOf(k) < 0);
        const orphans = onDisk.filter((k) => keys.indexOf(k) < 0);
        ok('素材目录里没有"孤儿文件"（产物与配置键一一对应）',
            orphans.length === 0,
            orphans.length ? `${orphans.length} 个：${orphans.slice(0, 5).join(', ')}` : `盘上 ${onDisk.length} 个 .wav`);
        curGroup.lines.push('  · 素材自检：' + (keys.length - missing.length) + '/' + keys.length + ' 个音效文件就位'
            + (missing.length
                ? '　⚠ 缺 ' + missing.join(', ') + '（`node tools/hit-feel-sfx/render.mjs` 可重新生成）'
                : '（全部就位）'));
    }

    /* ==================== 输出 ==================== */
    console.log('\n打击反馈体检（docs/打击反馈设计.md §5 / §8.1）');
    console.log('真源码：HitFeelConfig.ts + HitFeelDirector.ts + HitVfxLayer.ts（假总线 + 假时钟 + 假画布真跑）');
    console.log('='.repeat(96));
    for (const gr of groups) {
        console.log('\n' + gr.name);
        for (const line of gr.lines) console.log(line);
    }
    console.log('\n' + '='.repeat(96));
    if (fail === 0) console.log(`通过 ${pass} 条，全部通过`);
    else console.log(`通过 ${pass} 条，**失败 ${fail} 条**`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
