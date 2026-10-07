#!/usr/bin/env node
/**
 * audit.mjs —— **局外遗物抽取体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**抽一次到底扣了什么、抽到的是不是池子里那 37 件、价格阶梯对不对、券有没有先用**。
 * 这些配表验不出来（`npm run check` 只验格式），只有把真代码真跑起来才暴露。
 *
 * 做法（与 `audit:mall` / `audit:bag` / `audit:slot` 同一手法）：
 *   把项目里真实的 `OuterRelicDraw` / `DataCenter` / `EquipmentCollection` / `BagData` /
 *   `relics.json` / `battle_constants.json` / `bag_items.json` 用 TypeScript 的 `transpileModule`
 *   编成 CJS，只给「碰 cc / 碰 localStorage」的少数依赖打桩（`TbRoot` 桩按 `:tb/xxx`
 *   **真读** `assets/resources` 下的 JSON），然后用**真配表**驱动整条链路。
 *
 * 为什么必须真跑（这几条是这次落地时真踩过的，写在断言里防回归）：
 *   ① **界面显示的数 == 真正扣的数**：按钮上的消耗与 `drawOuterRelic` 的扣账必须出自
 *      同一个 `OuterRelicDraw.plan()`（D7 直接拿 preview 与实扣对账）；
 *   ② **券优先于金币、且用券抽不抬当日价格阶梯**（D2/D4/D9）—— 写反了就是"越抽越贵但没扣钱"；
 *   ③ ⚠⚠ **`collected` 必须是数组**：`DataModule.mergeDeep` 只认「默认数据里已有的 key」，
 *      动态字典 `{id: count}` 读档时会被**整片吃掉**（E 段把这条钉死：抽完 → 新实例读档 → 份数还在）。
 *      这个 bug 在 2026-11 之前一直没暴露（那时图鉴没有真来源），现在抽到的是玩家花金币换的，丢不起；
 *   ④ 旧存档那种字典形态要能被 `migrateCollectedShape()` 救回来（F 段）；
 *   ⑤ 界面契约靠节点名对表：预制件里改掉 `draw_btn` / `ten_box` / `cost` 任何一个名字，
 *      G 段当场爆（不用打开编辑器点）。
 *
 * 用法：
 *   node tools/outer-draw-audit/audit.mjs          # 体检 + 结论（有任何一条不过 → 退出码 1）
 *   npm run audit:draw                             # tools/excel_export 下的等价命令
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TB_DIR = path.join(ROOT, 'assets/resources/tb');
const SRC = 'assets/scripts/game';
const MENU_PREFAB = 'assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab';
const MENU_CTRL = 'ui/scenes/scene_menu/cmps/Cmp_OuterRelics.ts';

/**
 * 需要真跑的源码（相对 `assets/scripts/game`）。
 * 拉 `DataCenter` 就把整条数据链路都拉进来了（账号/英雄/道具/收集/任务/成就/难度/商城/背包），
 * 而抽取规则本身就是 `battle/OuterRelicDraw.ts`。
 */
const SOURCES = [
    'excel_table/Tb_MallItemConfig.ts',
    'excel_table/Tb_AchievementConfig.ts',
    'excel_table/Tb_RelicConfig.ts',
    'excel_table/Tb_TaskConfig.ts',
    'excel_table/Tb_PlayerLevelConfig.ts',
    'excel_table/Tb_UnitConfig.ts',
    'excel_table/Tb_BattleConstConfig.ts',
    'excel_table/Tb_AbilityConfig.ts',
    'excel_table/Tb_AttributeConfig.ts',
    'excel_table/Tb_BagItemConfig.ts',
    'excel_table/EffectTypes.ts',
    'common/DayKey.ts',
    'common/AchievementEffectMeta.ts',
    'common/DifficultyConfig.ts',
    'common/GoldText.ts',
    'battle/types.ts',
    'battle/core/Types.ts',
    'battle/core/AttributeScaling.ts',
    'battle/core/BattleConstUtil.ts',
    'battle/OuterRelicDraw.ts',
    'data/index.ts',
    'data/DataCenter.ts',
    'data/DataModule.ts',
    'data/StorageUtil.ts',
    'data/OuterAttributeCalculator.ts',
    'data/funcs/PlayerInfo.ts',
    'data/funcs/HeroData.ts',
    'data/funcs/ItemData.ts',
    'data/funcs/EquipmentCollection.ts',
    'data/funcs/TaskData.ts',
    'data/funcs/AchievementData.ts',
    'data/funcs/LevelData.ts',
    'data/funcs/ShopData.ts',
    'data/funcs/BagData.ts',
    'data/configs/LevelConfig.ts',
    'data/configs/TaskConfig.ts',
    'data/configs/AchievementConfig.ts',
    'data/configs/HeroConfig.ts',
    'data/configs/MallConfig.ts',
    'data/configs/EquipmentConfig.ts',
    'data/configs/BagConfig.ts',
    '../platform/excel_table/TbContainer.ts',
    '../platform/excel_table/TbConfigDecorator.ts',
    '../platform/log/LogMgr.ts',
    '../platform/reactivity/index.ts',
    '../platform/reactivity/arrayInstrumentations.ts',
    '../platform/reactivity/baseHandlers.ts',
    '../platform/reactivity/collectionHandlers.ts',
    '../platform/reactivity/computed.ts',
    '../platform/reactivity/constants.ts',
    '../platform/reactivity/dep.ts',
    '../platform/reactivity/effect.ts',
    '../platform/reactivity/effectScope.ts',
    '../platform/reactivity/reactive.ts',
    '../platform/reactivity/ref.ts',
    '../platform/reactivity/warning.ts',
    '../platform/reactivity/watch.ts',
    '../platform/reactivity/shared/general.ts',
    '../platform/reactivity/shared/makeMap.ts',
    '../platform/reactivity/shared/typeUtils.ts',
];

/** 打桩：只桩**必须**桩的两处（它们直接 import `cc`）——与 `audit:mall` 逐字同口径 */
const STUBS = {
    'platform/excel_table/TbRoot.js': `
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const registry = [];
class TbRootStub {
    registerContainerConfig(cls, bundle, p) { registry.push({ cls, bundle, path: p, inst: null }); }
    getTbContainer(cls) {
        const rec = registry.find((r) => r.cls === cls);
        if (!rec) throw new Error('容器未注册：' + (cls && cls.name));
        if (!rec.inst) {
            const file = path.join(ROOT, 'assets', rec.bundle, rec.path + '.json');
            rec.inst = new rec.cls();
            rec.inst.handleData(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
        return rec.inst;
    }
    async loadTbs() { /* 容器按需加载，这里不需要预加载 */ }
    _reset() { for (const r of registry) r.inst = null; }
}
exports.TbRoot = { ins: new TbRootStub() };
`,
    'platform/excel_table/ITbDecode.js': 'exports.__esModule = true;\n',
};

// ============================ 编译真源码 ============================

const require = createRequire(import.meta.url);

function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✘ 找不到 typescript（请在项目根目录或 tools/excel_export 下装好依赖）');
    process.exit(2);
}
const ts = resolveTypeScript();

function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-draw-audit-'));
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    for (const rel of SOURCES) {
        const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, SRC, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
            fileName: rel,
        }).outputText;
        const dest = path.join(out, 'assets/scripts/game', rel.replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js);
    }
    for (const [rel, code] of Object.entries(STUBS)) {
        const dest = path.join(out, 'assets/scripts', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
    }
    return {
        out,
        mod: (...p) => require(path.join(out, 'assets/scripts/game', ...p)),
        tbRoot: require(path.join(out, 'assets/scripts/platform/excel_table/TbRoot.js')).TbRoot,
    };
}

// ============================ 断言工具 ============================

let passed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✔ ${label}`); }
function bad(label, actual, expected) {
    failures.push(`${label}\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`);
    console.log(`  ✘ ${label}：实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}
function check(label, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
    else bad(label, actual, expected);
}
function truthy(label, cond, detail) {
    if (cond) ok(label);
    else bad(label, detail ?? cond, true);
}
/** 区间断言（数值微调不该打断体检，量级错了才拦） */
function within(label, v, lo, hi) {
    if (typeof v === 'number' && v >= lo && v <= hi) ok(label);
    else bad(label, v, `${lo} ~ ${hi}`);
}

const readTb = (name) => JSON.parse(fs.readFileSync(path.join(TB_DIR, `${name}.json`), 'utf8'));

// ============================ 预制件读取（G 段：界面契约） ============================

function readPrefab(rel) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const nodes = new Map();
    data.forEach((o, i) => { if (o && o.__type__ === 'cc.Node') nodes.set(i, o); });
    const childrenOf = (id) => (nodes.get(id)?._children ?? []).map((c) => c.__id__);
    const parentOf = (id) => (nodes.get(id)?._parent ? nodes.get(id)._parent.__id__ : null);
    const roots = [...nodes.keys()].filter((id) => parentOf(id) === null);
    const byPath = new Map();
    const walk = (id, prefix) => {
        const p = prefix ? `${prefix}/${nodes.get(id)._name}` : nodes.get(id)._name;
        byPath.set(p, id);
        for (const c of childrenOf(id)) walk(c, p);
    };
    for (const r of roots) {
        byPath.set(nodes.get(r)._name, r);
        for (const c of childrenOf(r)) walk(c, '');
    }
    const compObjsOf = (p) => (nodes.get(byPath.get(p))?._components ?? []).map((c) => data[c.__id__]);
    return {
        data, nodes, byPath,
        childNames: (p) => childrenOf(byPath.get(p)).map((id) => nodes.get(id)._name),
        comp: (p, type) => compObjsOf(p).find((c) => c && c.__type__ === type) ?? null,
        /** 节点上的**脚本**组件（`__type__` 不是引擎类型的就是脚本） */
        scriptOn: (p) => compObjsOf(p).find((c) => c && typeof c.__type__ === 'string' && !c.__type__.startsWith('cc.')),
        has: (p) => byPath.has(p),
        /** 某节点上的 UITransform（读框尺寸） */
        box: (p) => compObjsOf(p).find((c) => c && c.__type__ === 'cc.UITransform'),
        /** 某个引用字段指向哪个节点名 */
        refName: (obj, field) => {
            const ref = obj?.[field];
            if (!ref || ref.__id__ === undefined) return null;
            const t = data[ref.__id__];
            if (!t) return '<missing>';
            if (t.__type__ === 'cc.Node') return t._name;
            const n = t.node && t.node.__id__ !== undefined ? data[t.node.__id__] : null;
            return n ? `${n._name}::${t.__type__}` : `(${t.__type__})`;
        },
    };
}

// ============================ 主流程 ============================

const main = () => {
    const consts = readTb('battle_constants');
    const rawRelics = readTb('relics');
    const rawBag = readTb('bag_items');
    const { mod, tbRoot } = build();

    globalThis.window = globalThis;
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };

    const { DataCenter } = mod('data', 'DataCenter.js');
    const { CurrencyType } = mod('data', 'funcs', 'ItemData.js');
    const { OuterRelicDraw } = mod('battle', 'OuterRelicDraw.js');
    const { BAG_ITEM_KEY } = mod('data', 'configs', 'BagConfig.js');
    const { getOuterRelics } = mod('data', 'configs', 'EquipmentConfig.js');
    const { getOuterRelicCfgs } = mod('excel_table', 'Tb_RelicConfig.js');

    const dc = DataCenter.ins;
    dc.init();

    const fresh = () => {
        store.clear();
        dc.playerInfo.reset();
        dc.heroData.reset();
        dc.itemData.reset();
        dc.equipCollection.reset();
        dc.taskData.reset();
        dc.achieveData.reset();
        dc.levelData.reset();
        dc.shopData.reset();
        dc.shopData.ensurePeriod();
        dc.bagData.reset();
    };
    const giveGold = (n) => dc.itemData.addCurrency(CurrencyType.Gold, n);
    const gold = () => dc.itemData.getCurrency(CurrencyType.Gold);
    const countOf = (key) => dc.bagData.getCount(key);
    const nextCost = () => OuterRelicDraw.costOfDraw(dc.equipCollection.getOuterDrawIndex());

    const BASE = consts.outerDrawCostBase;
    const STEP = consts.outerDrawCostStep;
    const CAP = consts.outerDrawCostCap;
    const ladder = (n) => { let s = 0; for (let i = 0; i < n; i++) s += OuterRelicDraw.costOfDraw(i); return s; };

    // ────────────── A 配表与池子 ──────────────
    console.log('\nA 配表与池子');
    truthy('A1 battle_constants 有 outerDrawCostBase / Step / Cap',
        [BASE, STEP, CAP].every((v) => typeof v === 'number'), { BASE, STEP, CAP });
    truthy('A2 基准价 ' + BASE + ' > 0、步长 ' + STEP + ' ≥ 0、封顶 ' + CAP + ' ≥ 基准（或 0 = 不封顶）',
        BASE > 0 && STEP >= 0 && (CAP === 0 || CAP >= BASE), { BASE, STEP, CAP });

    const ticketRow = rawBag.find((r) => r.key === 'outer_draw_ticket');
    truthy('A3 bag_items 里有「局外遗物抽取券」这一行（券的存档 key 是契约）', !!ticketRow, ticketRow?.name);
    check('A3b 代码常量与配表 key 对得上', BAG_ITEM_KEY.outerDrawTicket, 'outer_draw_ticket');

    const pool = getOuterRelics();
    const outerOnly = rawRelics.filter((r) => r.scope === 'outer' || r.scope === 'both');
    check('A4 局外池 = relics.json 里 scope 含 outer 的那些行', pool.map((r) => r.id).sort((a, b) => a - b), outerOnly.map((r) => r.id).sort((a, b) => a - b));
    truthy(`A5 池子里 ${pool.length} 件（现 37：白12/蓝8/紫11/红6）`, pool.length > 0, pool.length);
    check('A5b 池外一件都不许进来（只有局内版的遗物抽出来没有局外属性）',
        pool.filter((r) => r.scope !== 'outer' && r.scope !== 'both').map((r) => r.id), []);
    const tierCount = { common: 0, rare: 0, epic: 0, legendary: 0 };
    pool.forEach((r) => { if (tierCount[r.rarity] !== undefined) tierCount[r.rarity]++; });
    truthy('A6 四档品质在池子里都有货（缺一档会让该档权重白掷）',
        Object.values(tierCount).every((n) => n > 0), tierCount);

    // ────────────── B 抽取规则（品质权重 / 档内优先未收集） ──────────────
    console.log('\nB 抽取规则');
    const N = 60000;
    const hit = { common: 0, rare: 0, epic: 0, legendary: 0 };
    const idSet = new Set(pool.map((r) => r.id));
    let outside = 0;
    for (let i = 0; i < N; i++) {
        const r = OuterRelicDraw.roll(pool, () => 0);
        if (!r || !idSet.has(r.id)) { outside++; continue; }
        hit[r.rarity]++;
    }
    check('B1 抽出来的 id 全在池子里（一万次都不会越界）', outside, 0);
    check('B2 四档都抽到过', Object.values(hit).every((n) => n > 0), true);
    within('B3 白档 ≈ 60%（权重 6/(6+2.5+1+0.5)）', hit.common / N, 0.585, 0.615);
    within('B4 蓝档 ≈ 25%', hit.rare / N, 0.235, 0.265);
    within('B5 紫档 ≈ 10%', hit.epic / N, 0.090, 0.110);
    within('B6 红档 ≈ 5%', hit.legendary / N, 0.040, 0.060);

    // 档内优先未收集：把某一档锁到只剩 1 件没收集 → 该档必出那一件（强制掷档，不靠运气）
    const tier = 'epic';
    const inTier = pool.filter((r) => r.rarity === tier);
    const target = inTier[0];
    const ownedMap = new Map(inTier.filter((r) => r.id !== target.id).map((r) => [r.id, 3]));
    const onlyOne = (id) => ownedMap.get(id) ?? 0;
    const saved = OuterRelicDraw.rollRarity;
    OuterRelicDraw.rollRarity = () => tier;
    const forced = Array.from({ length: 300 }, () => OuterRelicDraw.roll(pool, onlyOne)?.id);
    OuterRelicDraw.rollRarity = saved;
    check(`B7 该档只剩 1 件没收集时，掷到该档**必出那一件**（${inTier.length} 件里锁定 ${target.id}）`,
        [...new Set(forced)], [target.id]);
    // 该档集齐之后回到纯随机重复（份数无上限）
    const allOwned = () => 1;
    const repeat = new Set(Array.from({ length: 400 }, () => OuterRelicDraw.pickInTier(inTier, allOwned)?.id));
    truthy('B8 集齐之后再掷该档 = 等概率随机重复（不是"抽不出东西"）', repeat.size > 1, repeat.size);
    // 空档兜底
    OuterRelicDraw.rollRarity = () => 'epic';
    const fallback = OuterRelicDraw.roll(pool.filter((r) => r.rarity !== 'epic'), () => 0);
    OuterRelicDraw.rollRarity = saved;
    truthy('B9 掷到空档时退回全池（不让这一抽落空）', !!fallback, fallback);

    // ────────────── C 价格阶梯与付费方案 ──────────────
    console.log('\nC 价格阶梯与付费方案');
    check(`C1 当日价格序列 = base + step × (N-1)（现 ${[0, 1, 2, 3, 4].map((i) => OuterRelicDraw.costOfDraw(i)).join(' / ')}…）`,
        [0, 1, 2, 3, 4].map((i) => OuterRelicDraw.costOfDraw(i)),
        [0, 1, 2, 3, 4].map((i) => (CAP > 0 ? Math.min(BASE + STEP * i, CAP) : BASE + STEP * i)));
    if (CAP > 0) {
        check('C2 封顶之后不再涨（第 5 / 10 / 99 抽同价）',
            [OuterRelicDraw.costOfDraw(5), OuterRelicDraw.costOfDraw(10), OuterRelicDraw.costOfDraw(99)], [CAP, CAP, CAP]);
        within('C2b 封顶价 ≤ 基准的 4 倍（再高就是"一天只能抽一次"）', CAP / BASE, 0, 4);
    } else {
        ok('C2 配表写了不封顶（cap = 0）→ 阶梯线性上涨，不做额外断言');
    }

    const plan10 = OuterRelicDraw.plan(10, 0, 0, 1e9);
    check('C3 十连（无券）= 接下来 10 抽逐个累加，没有十连折扣',
        [plan10.steps.length, plan10.goldDraws, plan10.goldCost, plan10.ticketUse], [10, 10, ladder(10), 0]);
    const planMix = OuterRelicDraw.plan(10, 0, 3, 1e9);
    check('C4 3 张券 + 十连 = 前 3 抽用券、后 7 抽花金币',
        [planMix.ticketUse, planMix.goldDraws, planMix.goldCost, planMix.steps.slice(0, 4).map((s) => s.viaTicket)],
        [3, 7, ladder(7), [true, true, true, false]]);
    const planTicket = OuterRelicDraw.plan(10, 0, 10, 0);
    check('C5 10 张券 + 0 金币照样抽得动（券优先于金币）',
        [planTicket.steps.length, planTicket.goldCost, planTicket.steps.every((s) => s.viaTicket)], [10, 0, true]);
    const planPoor = OuterRelicDraw.plan(10, 0, 0, ladder(2));
    check('C6 金币只够 2 抽 → 方案只排 2 步（部分是刻意的：不该把能抽的两次吞掉）',
        [planPoor.steps.length, planPoor.goldCost, planPoor.goldCost <= ladder(2)], [2, ladder(2), true]);
    check('C6b 差 1 枚金币就是抽不动（阶梯是按顺序累加的，不是"平均价"）',
        OuterRelicDraw.plan(10, 0, 0, ladder(2) - 1).steps.length, 1);
    check('C7 一抽都抽不动 → 空方案', OuterRelicDraw.plan(10, 0, 0, BASE - 1).steps.length, 0);
    check('C8 券抽不占阶梯（付费序号只随金币抽前进）',
        OuterRelicDraw.plan(4, 2, 4, 1e9).steps.map((s) => s.cost), [0, 0, 0, 0]);
    check('C9 消耗文案：纯券 / 纯金币 / 混付三种形态',
        [OuterRelicDraw.formatCost(planTicket), OuterRelicDraw.formatCost(plan10), OuterRelicDraw.formatCost(planMix)],
        [`抽取券 10`, `金币 ${ladder(10)}`, `券3 金币${ladder(7)}`]);
    check('C10 空方案的文案不吹牛（显示 — 而不是"金币 0"）', OuterRelicDraw.formatCost({ steps: [], ticketUse: 0, goldDraws: 0, goldCost: 0 }), '—');

    // ────────────── D 端到端：DataCenter.drawOuterRelic ──────────────
    console.log('\nD 端到端（先扣券、再扣金币、记账、阶梯）');
    fresh();
    giveGold(100000);
    const d1 = dc.drawOuterRelic(1);
    check('D1 单抽：ok + 抽到 1 件', [d1.ok, d1.drawn, d1.lines.length], [true, 1, 1]);
    check('D1b 单抽扣的钱 = costOfDraw(0)', d1.goldSpent, BASE);
    check('D1c 单抽之后当日付费抽数 = 1（下一抽涨价）', [dc.equipCollection.getOuterDrawIndex(), nextCost()], [1, OuterRelicDraw.costOfDraw(1)]);
    check('D1d 图鉴里那件 +1 份', dc.equipCollection.getCollectedCount(d1.lines[0].id), 1);

    fresh();
    dc.bagData.addItem(BAG_ITEM_KEY.outerDrawTicket, 1);
    const d2 = dc.drawOuterRelic(1);
    check('D2 有券时**先用券**：券 −1、金币一分不扣', [d2.ok, d2.ticketUsed, d2.goldSpent, gold(), countOf(BAG_ITEM_KEY.outerDrawTicket)], [true, 1, 0, 0, 0]);
    check('D2b ⚠ 用券抽**不抬当日价格阶梯**（下一抽仍是基准价）',
        [dc.equipCollection.getOuterDrawIndex(), nextCost()], [0, BASE]);
    const d2c = dc.drawOuterRelic(1);
    check('D2c 券用完了才轮到金币（第 2 次没券 → 扣钱）', [d2c.ok, d2c.ticketUsed, d2c.goldSpent], [false, 0, 0]);

    fresh();
    dc.bagData.addItem(BAG_ITEM_KEY.outerDrawTicket, 3);
    giveGold(100000);
    const d3 = dc.drawOuterRelic(10);
    check('D3 十连（3 券 + 金币）：抽满 10 件', [d3.drawn, d3.lines.length], [10, 10]);
    check('D3b 用掉 3 张券、金币扣的是"后 7 抽"的和', [d3.ticketUsed, d3.goldSpent], [3, ladder(7)]);
    check('D3c 付费抽数只前进 7（券抽不占阶梯）', [dc.equipCollection.getOuterDrawIndex(), nextCost()], [7, OuterRelicDraw.costOfDraw(7)]);
    check('D3d 金币余额 = 初始 − 实扣', gold(), 100000 - ladder(7));

    fresh();
    giveGold(ladder(2));
    const d4 = dc.drawOuterRelic(10);
    check('D4 金币只够 2 抽：部分成功（drawn < requested，仍是 ok）',
        [d4.ok, d4.drawn, d4.requested, d4.goldSpent, gold()], [true, 2, 10, ladder(2), 0]);
    check('D4b 花光了就停下来，不会扣成负数', gold() >= 0, true);

    fresh();
    const d5 = dc.drawOuterRelic(10);
    check('D5 没券也没钱：ok=false / no_resource', [d5.ok, d5.reason, d5.drawn, d5.lines.length], [false, 'no_resource', 0, 0]);
    check('D5b 失败了就**一点数据都不许动**（不扣钱、不记账、不写日键）',
        [gold(), countOf(BAG_ITEM_KEY.outerDrawTicket), dc.equipCollection.getDistinctCount(), dc.equipCollection.data.drawPaidCount],
        [0, 0, 0, 0]);

    fresh();
    giveGold(100000);
    const d6 = dc.drawOuterRelic(10);
    const poolIds = new Set(pool.map((r) => r.id));
    check('D6 十连抽到的 id 全在池内', d6.lines.filter((l) => !poolIds.has(l.id)).map((l) => l.id), []);
    check('D6b 十连的份数与图鉴种类数对得上（总份数 = 10）',
        [dc.equipCollection.getTotalCollectionCount(), dc.equipCollection.getDistinctCount() <= 10],
        [10, true]);
    const sameId = d6.lines.filter((l) => l.id === d6.lines[0].id).length;
    truthy('D6c 同一件可以反复抽到（份数无上限，不做去重）',
        dc.equipCollection.getCollectedCount(d6.lines[0].id) === sameId, `${d6.lines[0].id} 出现 ${sameId} 次`);
    check('D6d isNew 只在"抽之前一份都没有"时为 true',
        d6.lines.filter((l) => l.isNew).length, dc.equipCollection.getDistinctCount());
    check('D6e 十连之后付费抽数 = 10（封顶后每抽同价）',
        [dc.equipCollection.getOuterDrawIndex(), nextCost()], [10, CAP > 0 ? CAP : BASE + STEP * 10]);

    // 界面显示的数 == 真正扣的数（判据同源）
    fresh();
    dc.bagData.addItem(BAG_ITEM_KEY.outerDrawTicket, 2);
    giveGold(100000);
    const vm = dc.previewOuterDraw(10);
    check('D7f 有券时单抽预览报「用券」而不是「金币」',
        (() => { const one = dc.previewOuterDraw(1); return [one.goldCost, one.goldDraws, one.ticketUse, one.costText]; })(),
        [0, 0, 1, '抽取券 1']);
    const d7 = dc.drawOuterRelic(10);
    check('D7 **预览说的消耗 == 实扣**（金币那部分）', [vm.goldCost, vm.goldDraws, vm.ticketUse], [d7.goldSpent, 8, 2]);
    check('D7b 预览文案 == 实扣文案', vm.costText, OuterRelicDraw.formatSpent(d7.ticketUsed, d7.goldSpent));
    check('D7c 预览的"抽得到几件" == 实际抽到几件', vm.drawn, d7.drawn);
    check('D7d 抽得动 → enabled=true', vm.enabled, true);
    check('D7e 预览的"下一抽单价" == 阶梯算出来的下一档（封顶后是 cap）',
        dc.previewOuterDraw(1).nextGoldCost, OuterRelicDraw.costOfDraw(dc.equipCollection.getOuterDrawIndex()));

    // 什么都抽不动时的预览（新号：0 券 0 金币）
    fresh();
    const vmZero = dc.previewOuterDraw(1);
    check('D7g 抽不动 → enabled=false、drawn=0、文案不装样子',
        [vmZero.enabled, vmZero.drawn, vmZero.goldCost, vmZero.costText], [false, 0, 0, '—']);
    const vmZero10 = dc.previewOuterDraw(10);
    check('D7h 十连预览在抽不动时同样如实', [vmZero10.enabled, vmZero10.drawn, vmZero10.count], [false, 0, 10]);

    // 跨天：价格阶梯按**本地日期键**重置
    fresh();
    giveGold(100000);
    dc.drawOuterRelic(1);
    const afterOne = dc.equipCollection.getOuterDrawIndex();
    dc.equipCollection.data.drawDayKey = '20200101';   // 假装上次抽是"昨天"
    check('D8 跨天后当日付费抽数归零（价格回到基准价，不是"距上次 24 小时"）',
        [afterOne, dc.equipCollection.getOuterDrawIndex(), nextCost()], [1, 0, BASE]);
    const d8b = dc.drawOuterRelic(1);
    check('D8b 跨天后的第一抽按基准价扣', d8b.goldSpent, BASE);

    // preview 不改数据（纯读）
    const before8 = JSON.stringify(dc.equipCollection.data);
    dc.previewOuterDraw(10);
    dc.previewOuterDraw(1);
    check('D9 预览是**纯读**的（连调两次不动任何数据）', JSON.stringify(dc.equipCollection.data), before8);

    // ────────────── E 存档往返（collected 必须是数组，否则读档会被吃掉） ──────────────
    console.log('\nE 存档往返（⚠ `collected` 是动态字典就会被 mergeDeep 吃掉）');
    fresh();
    giveGold(ladder(3));
    const e1 = dc.drawOuterRelic(3);
    const expect = e1.lines.map((l) => [l.id, dc.equipCollection.getCollectedCount(l.id)]);
    dc.equipCollection.save();
    const rawSaved = JSON.parse(store.get('jihe_defence_equip_collection'));
    truthy('E1 存档里 `collected` 是**数组**（字典形态读档会被整片丢掉）', Array.isArray(rawSaved.collected), typeof rawSaved.collected);

    const ModuleCls = mod('data', 'funcs', 'EquipmentCollection.js').EquipmentCollectionModule;
    const reloaded = new ModuleCls();   // 新实例 = 真读一次 localStorage
    check('E2 新实例读档后**每一件的份数都还在**（这是抽取能长期成立的底线）',
        expect.map(([id]) => reloaded.getCollectedCount(id)), expect.map(([, n]) => n));
    check('E2b 当日付费抽数也读得回来', reloaded.data.drawPaidCount, 3);
    reloaded.dispose();

    // ────────────── F 旧存档迁移（字典 → 数组） ──────────────
    console.log('\nF 旧存档迁移');
    store.set('jihe_defence_equip_collection', JSON.stringify({ collected: { 1167: 2, 1001: 1 }, drawDayKey: '', drawPaidCount: 0 }));
    const legacy = new ModuleCls();
    const moved = legacy.migrateCollectedShape();
    check('F1 字典形态被就地转成数组（老玩家的份数救得回来）', [moved, Array.isArray(legacy.data.collected)], [2, true]);
    check('F2 转换之后照常读得到', [legacy.getCollectedCount(1167), legacy.getCollectedCount(1001), legacy.getDistinctCount()], [2, 1, 2]);
    check('F3 迁移是幂等的（已经是数组时什么都不做）', legacy.migrateCollectedShape(), 0);
    legacy.addCollected(1167, 1);
    check('F4 迁移之后能继续累加', legacy.getCollectedCount(1167), 3);
    // 没跑过迁移也炸不了：写入口自己兜底
    store.set('jihe_defence_equip_collection', JSON.stringify({ collected: { 1167: 2 } }));
    const legacy2 = new ModuleCls();
    legacy2.addCollected(1167, 1);   // 没人调 migrate 也必须在写入侧兜底
    check('F5 即使没人调 migrate（写入侧也兜底）：老形态下 addCollected 不炸且累加正确',
        [Array.isArray(legacy2.data.collected), legacy2.getCollectedCount(1167)], [true, 3]);
    legacy.dispose();
    legacy2.dispose();

    // ────────────── G 界面契约（真预制件） ──────────────
    console.log('\nG 界面契约（Scene_Menu.prefab 的 outer_relics）');
    const prefab = readPrefab(MENU_PREFAB);
    // ⚠ 路径口径 = 代码里 `node.getChildByPath('a/b/c')` 的口径：**相对视图根节点、且不含根节点名**
    const SRC_PATH = 'content/right/outer_relics';
    truthy(`G1 右侧遗物页在（${SRC_PATH}）`, prefab.has(SRC_PATH), SRC_PATH);
    const ov = `${SRC_PATH}/pages/overview`;
    for (const name of ['summary', 'ten_box', 'draw_btn', 'scroll']) {
        truthy(`G2 总览页顶部有 ${name}（它不在 scroll 里，才不会被滚走）`, prefab.has(`${ov}/${name}`), `${ov}/${name}`);
    }
    check('G2b 三个控件从左到右：进度卡 → 勾选框 → 抽取按钮（x 递增）',
        ['summary', 'ten_box', 'draw_btn']
            .map((n) => prefab.nodes.get(prefab.byPath.get(`${ov}/${n}`))?._lpos.x)
            .every((v, i, a) => typeof v === 'number' && (i === 0 || a[i - 1] < v)), true);
    check('G3 抽取按钮里是 [title, cost]', prefab.childNames(`${ov}/draw_btn`), ['title', 'cost']);
    check('G4 勾选框里是 [box, name]', prefab.childNames(`${ov}/ten_box`), ['box', 'name']);
    check('G5 方框里是 [check]（勾）', prefab.childNames(`${ov}/ten_box/box`), ['check']);
    check('G5b 勾默认不显示（未勾态）', prefab.nodes.get(prefab.byPath.get(`${ov}/ten_box/box/check`))._active, false);
    // 引用的节点/组件类型
    const script = prefab.scriptOn(SRC_PATH);
    truthy('G6 页面上挂着遗物页的脚本', !!script, script?.__type__);
    check('G7 脚本上拖的 5 个引用都指向正确的节点',
        ['relicList', 'relicSummary', 'drawButton', 'tenToggle', 'relicSummary']
            .map((f) => prefab.refName(script, f)),
        ['lists', 'summary', 'draw_btn', 'ten_box', 'summary']);
    check('G8 消耗文案挂在 draw_btn/cost 的 Label 上',
        (prefab.refName(script, 'drawCostLabel') ?? '').split('::')[0], 'cost');
    truthy('G8b 消耗文案那个引用真的是 cc.Label',
        (prefab.refName(script, 'drawCostLabel') ?? '').indexOf('::cc.Label') > 0, prefab.refName(script, 'drawCostLabel'));
    // 按钮组件（点了要有反应）
    check('G9 抽取按钮带 cc.Button 且过渡是 NONE（否则 normalColor 会冲掉底图色）',
        ['cc.Button', 0], (() => { const b = prefab.comp(`${ov}/draw_btn`, 'cc.Button'); return [b ? b.__type__ : null, b ? b._transition : null]; })());
    check('G9b 勾选框也带 cc.Button 且过渡是 NONE',
        ['cc.Button', 0], (() => { const b = prefab.comp(`${ov}/ten_box`, 'cc.Button'); return [b ? b.__type__ : null, b ? b._transition : null]; })());
    // 代码里的兜底路径必须与预制件对得上（改名了要一起改）
    const src = fs.readFileSync(path.join(ROOT, SRC, MENU_CTRL), 'utf8');
    const consts2 = {};
    for (const m of src.matchAll(/const\s+(DRAW_BUTTON_NAME|COST_LABEL_NAME|TEN_TOGGLE_NAME|TEN_BOX_NAME|TEN_CHECK_NAME|TEN_TEXT_NAME)\s*=\s*'([^']+)'/g)) consts2[m[1]] = m[2];
    check('G10 代码里的节点名常量 == 预制件实际节点名',
        [consts2.DRAW_BUTTON_NAME, consts2.COST_LABEL_NAME, consts2.TEN_TOGGLE_NAME, consts2.TEN_BOX_NAME, consts2.TEN_CHECK_NAME, consts2.TEN_TEXT_NAME],
        ['draw_btn', 'cost', 'ten_box', 'box', 'check', 'name']);
    truthy('G11 界面不许自己算价格（阶梯只在 OuterRelicDraw 里）',
        src.indexOf('outerDrawCost') < 0 && src.indexOf('costOfDraw') < 0, '源码里出现了价格键名');
    truthy('G12 界面走的是数据层那两个入口（previewOuterDraw / drawOuterRelic）',
        src.indexOf('previewOuterDraw') > 0 && src.indexOf('drawOuterRelic') > 0, '没找到调用');
    truthy('G13 十连的档位来自 OuterRelicDraw.TEN_DRAW_COUNT（不是界面里写死 10）',
        src.indexOf('TEN_DRAW_COUNT') > 0, '源码里没引用 TEN_DRAW_COUNT');

    // ────────────── H 漏洞已堵（局内抽到的不再写图鉴） ──────────────
    console.log('\nH 局外遗物只有"抽取"一个来源');
    const stageSrc = fs.readFileSync(path.join(ROOT, SRC, 'ui/scenes/scene_game_stage/Scene_Game_Stage.ts'), 'utf8');
    const onRelic = /private\s+onRelicCollected[\s\S]*?\n  \}/.exec(stageSrc)?.[0] ?? '';
    truthy('H1 `Scene_Game_Stage.onRelicCollected` 里不再有 `addCollected`（否则打两局属性翻倍）',
        onRelic.indexOf('addCollected') < 0, onRelic.slice(0, 120));
    /** 去掉注释再扫（注释里提到 `addCollected` 是**说明**，不是调用方） */
    const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
    const addCollectedCallers = [];
    const walkSrc = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) { walkSrc(p); continue; }
            if (!f.name.endsWith('.ts')) continue;
            const t = stripComments(fs.readFileSync(p, 'utf8'));
            if (/\.addCollected\s*\(/.test(t) && p.indexOf('EquipmentCollection.ts') < 0) {
                addCollectedCallers.push(path.relative(ROOT, p).split(path.sep).join('/'));
            }
        }
    };
    walkSrc(path.join(ROOT, 'assets/scripts'));
    check('H2 全工程 `addCollected` 的调用方只有抽取链路一处',
        addCollectedCallers.sort(), ['assets/scripts/game/data/DataCenter.ts']);

    // ============================ 收尾 ============================
    console.log(`\n${failures.length ? '✘' : '✔'} 局外遗物抽取体检：${passed} 条通过，${failures.length} 条失败`);
    if (failures.length) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
        process.exit(1);
    }
};

main();
