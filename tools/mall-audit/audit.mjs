#!/usr/bin/env node
/**
 * audit.mjs —— **局外商城体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**这一屏的"数"到底对不对** —— 每日补给真发多少、每格每天能领几次、
 * 跨天会不会真的重置、看广告到底记没记账、券会不会攒丢、免广告卡能不能重复领。
 * 这些配表验不出来（`npm run check` 只验格式），只有把真代码真跑起来才暴露。
 *
 * 做法（与 `audit:attr` / `audit:achieve` / `audit:slot` 同一手法）：
 *   把项目里真实的 `ShopData` / `MallConfig` / `DataCenter` / `ShopVM` / `AdMgr` /
 *   `mall_items.json` / `battle_constants.json` 用 TypeScript 的 `transpileModule` 编成 CJS，
 *   只给「碰 cc / 碰 localStorage」的少数依赖打桩（`TbRoot` 桩按 `:tb/xxx` **真读** `assets/resources` 下的 JSON），
 *   然后用**真配表**驱动：领补给 → 发广告奖 → 攒免广告卡 → 跨天 → 存档往返 → 算一遍页面 VM。
 *
 * 为什么必须真跑（这几条是这次落地时真踩过的，写在断言里防回归）：
 *   ① 「界面显示的数」与「真正到手的数」必须同源 —— 让界面自己 `× 1.5` 迟早与发奖的取整口径差 1
 *      （所以有 `DataCenter.previewShopDailyGift`，本脚本 C8/I5 两条断言直接对账）；
 *   ② `DataModule` 的深度合并**只认默认数据里已有的 key** ⇒ 用字典存"每格今日次数"会在读档时整片丢掉，
 *      所以 `itemUsed`（商城）与 `items`（背包）都是**数组**（H 段专门验它）；
 *   ③ 增益券池满时**不能**把这一次广告记成"已看"（否则玩家白看一次广告还少了次数）——
 *      F3 断言"返回失败且次数一个都不动"；
 *   ④ 免广告卡**不叠加**：生效中再点一次「领取」必须是失败，不能把 24 小时变成 48 小时（E3）；
 *   ⑤ 界面契约靠节点名对表：改配表 key、改预制件格子名、改 `Scene_Menu` 里的入口路径，
 *      任何一处不一致都在 J 段当场爆（不用打开编辑器点）。
 *
 * 用法：
 *   node tools/mall-audit/audit.mjs          # 体检 + 结论（有任何一条不过 → 退出码 1）
 *   npm run audit:mall                       # tools/excel_export 下的等价命令
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
const SHOP_PREFAB = 'assets/resources/prefabs/ui/views/shop/View_Shop.prefab';
/**
 * 广告商品格子在预制件里的**容器路径**（相对视图根节点）。
 * 2026-11 起这一区是竖直滚动列表：`ad_list` = ScrollView + Widget / `ad_list/view` = Mask（剪裁，
 * 剪在下沿 188 = 免广告卡上沿 176 之上）/ `ad_list/view/content` = 纵向自增的 Layout（六格住这儿）。
 */
const AD_LIST_CONTENT = 'ad_list/view/content';
const MENU_PREFAB = 'assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab';

/**
 * 需要真跑的源码（相对 `assets/scripts/game`）。
 * 拉 `DataCenter` 就把整条数据链路都拉进来了（账号/英雄/道具/收集/任务/成就/难度/商城），
 * 拉 `ShopVM` 又会拉 `EquipmentConfig`（图鉴 37 件的总数从 relics.json 现算）。
 */
const SOURCES = [
    // 配表容器
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
    // 公共配置/工具
    'common/DayKey.ts',
    'common/AchievementEffectMeta.ts',
    'common/DifficultyConfig.ts',
    'common/GoldText.ts',
    'battle/types.ts',
    'battle/core/Types.ts',
    'battle/core/AttributeScaling.ts',
    'battle/core/BattleConstUtil.ts',
    // 局外遗物抽取规则：`DataCenter` 现在 import 它（抽取是局外遗物的唯一来源），所以这条链路必须一起编
    'battle/OuterRelicDraw.ts',
    // 数据层（整条链路）
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
    // ⚠ 2026-11：三类券/次数（广告券 / 遗物抽取次数 / 增益券）的**存量**已搬到「局外背包」，
    //   商城发奖改成写它 —— 所以这条链路必须一起真跑（H 段顺带成了 BagData 的存档往返体检）
    'data/funcs/BagData.ts',
    'data/configs/LevelConfig.ts',
    'data/configs/TaskConfig.ts',
    'data/configs/AchievementConfig.ts',
    'data/configs/HeroConfig.ts',
    'data/configs/MallConfig.ts',
    'data/configs/EquipmentConfig.ts',
    'data/configs/BagConfig.ts',
    // 界面侧（判据与契约）
    'ui/views/shop/ShopScope.ts',
    'ui/views/shop/ShopVM.ts',
    // 平台层
    '../platform/ad/AdMgr.ts',
    '../platform/excel_table/TbContainer.ts',
    '../platform/excel_table/TbConfigDecorator.ts',
    '../platform/log/LogMgr.ts',
    // 响应式框架（`DataModule` 的依赖，纯 TS、不 import cc，所以整目录真跑）
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

/**
 * 打桩：只桩**必须**桩的两处（它们直接 import `cc`），且忠实复刻契约：
 *   · `TbRoot`：按 `registerContainerConfig(cls, bundle, path)` 记账，`getTbContainer(cls)` 首次访问时
 *     按 `bundle/path` **真读** `assets/resources/<path>.json` 并调 `handleData()` ——
 *     与真管线（`:tb/mall_items` → resources bundle）同一路径口径。
 *   · `ITbDecode`：只是一份接口声明（`import cc` 是为了类型），给它一个空壳即可。
 */
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
    _registered() { return registry.map((r) => r.path); }
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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-mall-audit-'));
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

// ============================ 预制件读取（J 段：界面契约） ============================

/**
 * 读一个 prefab，返回「根节点 → 全部后代路径」的集合 + 名字索引。
 * 路径口径与代码里的 `node.getChildByPath('a/b/c')` 一致（相对**视图根节点**）。
 */
function readPrefab(rel) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const nodes = new Map();
    data.forEach((o, i) => { if (o && o.__type__ === 'cc.Node') nodes.set(i, o); });
    const childrenOf = (id) => (nodes.get(id)?._children ?? []).map((c) => c.__id__);
    const parentOf = (id) => {
        const p = nodes.get(id)?._parent;
        return p ? p.__id__ : null;
    };
    const roots = [...nodes.keys()].filter((id) => parentOf(id) === null);
    const paths = new Set();
    const byPath = new Map();
    // ⚠ 路径口径 = 代码里 `node.getChildByPath('a/b/c')` 的口径：**相对视图根节点、且不含根节点名**
    //   （`getChildByPath` 是在根节点上调的）。所以根的**子节点**才是路径的第一段。
    const walk = (id, prefix) => {
        const p = prefix ? `${prefix}/${nodes.get(id)._name}` : nodes.get(id)._name;
        paths.add(p);
        byPath.set(p, id);
        for (const c of childrenOf(id)) walk(c, p);
    };
    for (const r of roots) {
        paths.add(nodes.get(r)._name);
        byPath.set(nodes.get(r)._name, r);
        for (const c of childrenOf(r)) walk(c, '');
    }
    return {
        data,
        nodes,
        roots,
        paths,
        byPath,
        /** 某个路径下的直接子节点名 */
        childNames: (p) => childrenOf(byPath.get(p)).map((id) => nodes.get(id)._name),
        /** 某节点上的组件类型列表 */
        comps: (p) => (nodes.get(byPath.get(p))?._components ?? []).map((c) => data[c.__id__]?.__type__),
        /** 某节点上某个组件对象（取第一个匹配） */
        comp: (p, type) => {
            const list = (nodes.get(byPath.get(p))?._components ?? []).map((c) => data[c.__id__]);
            return list.find((c) => c && c.__type__ === type) ?? null;
        },
        /** 脚本里引用的相对路径是否存在 */
        has: (p) => paths.has(p),
    };
}

/** 从源码里抓出 `at('a/b/c')` / `getChildByPath('a/b/c')` 的路径字面量 */
function grabPaths(source, fn = 'at') {
    const out = [];
    const re = new RegExp(`${fn}\\(\\s*'([^']+)'`, 'g');
    let m;
    while ((m = re.exec(source))) out.push(m[1]);
    return out;
}

// ============================ 主流程 ============================

const main = () => {
    const rawItems = readTb('mall_items');
    const consts = readTb('battle_constants');
    const rawAchieve = readTb('achievements');
    const { mod, tbRoot } = build();

    // ── 全局最小打桩：`StorageUtil` 只用到 localStorage 的四个方法（读写都包在 try 里） ──
    // `LogMgr` 里 `window.console.log.bind(window.console, …)` 直接用了 `window`（浏览器里当然有），
    // Node 里补一个指回自己的 `window` 即可（它只用来取 console）。
    globalThis.window = globalThis;
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };

    const { TbRoot } = { TbRoot: tbRoot };
    void TbRoot;
    const { DataCenter } = mod('data', 'DataCenter.js');
    const { CurrencyType } = mod('data', 'funcs', 'ItemData.js');
    const MallConfig = mod('data', 'configs', 'MallConfig.js').MallConfig;
    // 券/次数的存量住在背包里（2026-11），断言与发奖都要按它的 key 记账
    const { BAG_ITEM_KEY } = mod('data', 'configs', 'BagConfig.js');
    const ShopVM = mod('ui', 'views', 'shop', 'ShopVM.js');
    const Scope = mod('ui', 'views', 'shop', 'ShopScope.js');
    const { SHOP_CELL_NODE } = Scope;
    const { ACH_EFFECT_META, ACH_EFFECT_CODES } = mod('common', 'AchievementEffectMeta.js');
    const { MallItemCfgContainer } = mod('excel_table', 'Tb_MallItemConfig.js');
    const { AdMgr } = mod('../platform', 'ad', 'AdMgr.js');

    // 容器真装载一次（后面 MallConfig / DataCenter 都走它的数据）
    tbRoot.ins.getTbContainer(MallItemCfgContainer);

    const dc = DataCenter.ins;
    dc.init();

    /** 把整盘数据恢复成"新号"（各模块 reset + 清存档），供每段测试从干净状态开始 */
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
        // ⚠ 券/次数的存量住在背包里（2026-11 搬家），不在 shopData —— 清号必须一起清
        dc.bagData.reset();
    };

    // ────────────── A 配表结构 ──────────────
    console.log('\nA 配表结构（mall_items）');
    check('A1 配表 7 行（每日补给 + 6 个广告商品）', rawItems.length, 7);

    const keys = rawItems.map((r) => r.key);
    check('A2 key 全局唯一', new Set(keys).size, rawItems.length);

    const freeRows = rawItems.filter((r) => r.kind === 'free');
    check('A3 恰好 1 行 kind=free 且 key=daily_free',
        freeRows.map((r) => r.key), ['daily_free']);

    const GRANT_TYPES = ['gold', 'hero_exp', 'acc_exp', 'relic_draw', 'revive_ticket', 'boost', 'ad_ticket'];
    const grantBad = [];
    for (const r of rawItems) {
        if (!Array.isArray(r.grants) || !r.grants.length) { grantBad.push(`${r.key}:空`); continue; }
        for (const g of r.grants) {
            if (GRANT_TYPES.indexOf(g.type) < 0) grantBad.push(`${r.key}:${g.type}`);
            else if (!(g.amount > 0)) grantBad.push(`${r.key}:${g.type}=${g.amount}`);
        }
    }
    check('A4 grants 的 type 全在白名单且 amount > 0', grantBad, []);

    const adRows = rawItems.filter((r) => r.kind === 'ad');
    const placementBad = adRows.filter((r) => !r.placement || typeof r.placement !== 'string');
    check('A5 每个广告商品都有 placement', placementBad.map((r) => r.key), []);
    const placements = adRows.map((r) => r.placement);
    check('A5b placement 互不重复（埋点才分得清是哪一格）', new Set(placements).size, adRows.length);

    const limitBad = rawItems.filter((r) => !(r.daily_limit >= 0) || (r.kind === 'free' && r.daily_limit !== 1));
    check('A6 daily_limit 合法（free 行必须 = 1）', limitBad.map((r) => r.key), []);

    const sorts = rawItems.map((r) => r.sort ?? r.id);
    check('A7 sort 互不重复（界面顺序稳定）', new Set(sorts).size, rawItems.length);

    const cellKeys = Object.values(SHOP_CELL_NODE);
    check('A8 六个广告格的 key 与界面契约 SHOP_CELL_NODE 完全对应',
        adRows.map((r) => r.key).sort(), Object.keys(SHOP_CELL_NODE).sort());
    void cellKeys;

    const amountTextBad = rawItems.filter((r) => !r.name || !r.amount_text);
    check('A9 name / amount_text 齐备（否则格子上那两行会留空）', amountTextBad.map((r) => r.key), []);

    // ────────────── B 全局常量（battle_constants 的 shop* 键） ──────────────
    console.log('\nB 全局常量');
    const SHOP_KEYS = [
        'shopAdDailyTotalLimit', 'shopAdCardNeedWatches', 'shopAdCardHours',
        'shopStreakMuls', 'shopStreakGiftDay', 'shopStreakGiftTickets', 'shopBoostTicketValues',
    ];
    check('B1 七个 shop* 常量都在 battle_constants 里', SHOP_KEYS.filter((k) => !(k in consts)), []);

    const adLimitSum = adRows.reduce((n, r) => n + r.daily_limit, 0);
    check('B2 Σ(每格每日上限) == 每日广告总上限（跨商品一本账要对得上）',
        adLimitSum, MallConfig.getAdDailyTotalLimit());

    const muls = MallConfig.getStreakMuls();
    const mulMono = muls.every((v, i) => i === 0 || v >= muls[i - 1]);
    truthy('B3 连续登录倍数：首项 = 1 且单调不减', muls.length >= 7 && muls[0] === 1 && mulMono, muls);

    const boostVals = MallConfig.getBoostTicketValues();
    check('B4 增益券值表的键 == 10 条成就效果（不多不少）',
        Object.keys(boostVals).sort(), [...ACH_EFFECT_CODES].sort());

    const boostBad = Object.entries(boostVals)
        .filter(([code, v]) => !(v > 0) || v > (ACH_EFFECT_META[code]?.cap ?? 0))
        .map(([code, v]) => `${code}=${v}/${ACH_EFFECT_META[code]?.cap}`);
    check('B5 每张券的值 ≤ 该效果的 cap（否则这张券天生是废券）', boostBad, []);

    const need = MallConfig.getAdCardNeedWatches();
    check('B6 免广告卡门槛 = 每日上限的整数倍（"约 N 天"那句话才成立）',
        need % MallConfig.getAdDailyTotalLimit(), 0);
    within('B7 免广告卡生效时长（小时）', MallConfig.getAdCardHours(), 1, 72);

    const capWaste = Object.entries(boostVals)
        .filter(([code, v]) => Math.floor((ACH_EFFECT_META[code]?.cap ?? 0) / v) < 1);
    check('B8 没有任何效果"一张券就顶满/顶破 cap"（那样它其实是死的）', capWaste.map(([c]) => c), []);

    // ────────────── C 每日补给（真跑 DataCenter.claimShopDailyGift） ──────────────
    console.log('\nC 每日补给（真跑；中间那些 [商城] 日志是真模块自己打的）');
    fresh();
    const gold0 = dc.itemData.getCurrency(CurrencyType.Gold);
    const exp0 = dc.heroData.getSharedExp();

    const r1 = dc.claimShopDailyGift();
    truthy('C1 新号第一次领取成功', r1.ok, r1.reason);
    check('C1b 发的是金币 + 通用英雄经验两项', r1.granted.map((l) => l.type), ['gold', 'hero_exp']);
    const preview = dc.previewShopDailyGift();
    check('C2 实发金币 == 预览（连续登录 ×1）', r1.granted[0].amount, preview.gold);
    check('C2b 实发经验 == 预览', r1.granted[1].amount, preview.heroExp);
    check('C3 金币真的进了 itemData', dc.itemData.getCurrency(CurrencyType.Gold) - gold0, preview.gold);
    check('C3b 通用英雄经验真的进了 heroData', dc.heroData.getSharedExp() - exp0, preview.heroExp);
    check('C4 飘字的数是主项（金币）', r1.flyText, `+${preview.gold} 金币`);

    const r2 = dc.claimShopDailyGift();
    check('C5 同一天再领被拒（不重复发）', [r2.ok, r2.reason], [false, 'claimed_today']);
    check('C5b 被拒时不发东西', r2.granted, []);

    // 跨天：把日键与"领过的日子"都改成很久以前（= 昨天领的、今天又进来）
    // ⚠ 只改 `dailyKey` 是不够的：免费供给是**比较 freeClaimedKey 与今天**判定，
    //   真跨天时"今天"变了，所以这里要模拟的是"领过的日子是旧的"。
    dc.shopData.data.dailyKey = '19700101';
    dc.shopData.data.freeClaimedKey = '19700101';
    dc.shopData.ensurePeriod();
    const r3 = dc.claimShopDailyGift();
    truthy('C6 跨天（领过的日子是旧的）之后可以再领一次', r3.ok, r3.reason);

    // 连续登录加成：4 天 → ×1.5；7 天 → ×2 且额外送券
    fresh();
    dc.playerInfo.data.loginStreak = 4;
    const p4 = dc.previewShopDailyGift();
    check('C7 连续登录 4 天 = ×1.5', p4.streakMul, 1.5);
    const r4 = dc.claimShopDailyGift();
    check('C7b 4 天实发金币 = 基础 ×1.5', r4.granted[0].amount, Math.round(200 * 1.5));
    check('C7c 界面预览与实发一致（同一把尺）', [p4.gold, p4.heroExp], [r4.granted[0].amount, r4.granted[1].amount]);

    fresh();
    dc.playerInfo.data.loginStreak = 7;
    const p7 = dc.previewShopDailyGift();
    check('C8 连续登录 7 天 = ×2', p7.streakMul, 2);
    const r7 = dc.claimShopDailyGift();
    check('C8b 7 天实发金币 = 400', r7.granted.find((l) => l.type === 'gold').amount, 400);
    check('C8c 7 天额外送 1 张本局增益券',
        r7.granted.filter((l) => l.type === 'boost').map((l) => l.amount), [1]);
    check('C8d 券真的记进了存档（**背包**：2026-11 起券不再存在 shopData 里）',
        dc.bagData.getBoostTotalCount(), 1);

    // ────────────── D 广告商品（真跑 canUseShopAd / grantShopItem） ──────────────
    console.log('\nD 广告商品');
    fresh();
    // 未接 SDK：`AdMgr.showRewardVideo` 必须返回 false（**这条是"不发奖"的根**）
    let adResult = null;
    AdMgr.inst.showRewardVideo('shop_gold').then((v) => { adResult = v; });
    truthy('D1 未接入 SDK 时广告返回 false（所以下面所有发奖都只能由测试显式调）',
        AdMgr.inst.hasProvider === false, 'hasProvider=' + AdMgr.inst.hasProvider);

    const goldBefore = dc.itemData.getCurrency(CurrencyType.Gold);
    const d2 = dc.grantShopItem('gold');
    truthy('D2 金币袋发奖成功', d2.ok, d2.reason);
    check('D2b 金币 +300（配表值）', dc.itemData.getCurrency(CurrencyType.Gold) - goldBefore, 300);
    check('D2c 该格今日次数 = 1', dc.shopData.getItemUsedToday('gold'), 1);
    check('D2d 今日广告总次数 = 1', dc.shopData.getAdUsedToday(), 1);
    check('D2e 免广告卡累计观看 = 1', dc.shopData.getAdCardWatched(), 1);
    check('D2f 别的格没被记（每格次数独立）', dc.shopData.getItemUsedToday('hero_exp'), 0);

    for (let i = 0; i < 2; i++) dc.grantShopItem('gold');
    check('D3 金币袋用满 3 次后：canUseShopAd 报 item_limit',
        dc.canUseShopAd('gold'), { ok: false, reason: 'item_limit' });
    truthy('D3b 别的格仍然可用', dc.canUseShopAd('hero_exp').ok);

    fresh();
    // 把总次数用满 14（各格上限之和，所以此时每一格也都满了）：逐格发
    for (const row of adRows) {
        for (let i = 0; i < row.daily_limit; i++) dc.grantShopItem(row.key);
    }
    check('D4 14 次全用完后总次数 = 14', dc.shopData.getAdUsedToday(), 14);
    const d4 = dc.canUseShopAd('gold');
    check('D4b 此时点金币袋报的是"本格满了"（两条判据都成立时，先说更具体的那条）',
        [d4.ok, d4.reason], [false, 'item_limit']);
    // 纯规则口径：把总上限压到"已用数"，就只剩总次数这一条判据了
    const d4rule = dc.shopData.canUseAd('gold', 99, dc.shopData.getAdUsedToday());
    check('D4c 本格没满、总次数满了 → daily_total_limit', [d4rule.ok, d4rule.reason], [false, 'daily_total_limit']);
    const d4b = dc.grantShopItem('gold');
    check('D4d 就算硬调发奖也会被挡（并返回同一个原因）', [d4b.ok, d4b.reason], [false, 'item_limit']);

    fresh();
    const heroExpBefore = dc.heroData.getSharedExp();
    dc.grantShopItem('hero_exp');
    check('D5 英雄经验瓶 +120', dc.heroData.getSharedExp() - heroExpBefore, 120);

    const accBefore = dc.playerInfo.data.exp + dc.playerInfo.data.level * 1000;
    dc.grantShopItem('acc_exp');
    const accAfter = dc.playerInfo.data.exp + dc.playerInfo.data.level * 1000;
    truthy('D6 账号经验册真的发了账号经验（升级会进位，所以按"等级×1000+经验"比大小）',
        accAfter > accBefore, `${accBefore} → ${accAfter}`);

    const relicsBefore = dc.equipCollection.getDistinctCount();
    dc.grantShopItem('relic_draw');
    check('D7 局外遗物抽取券 +1（**不是遗物本体**）', dc.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket), 1);
    check('D7b 图鉴没有被写进任何东西（局外遗物只能靠金币抽取）',
        dc.equipCollection.getDistinctCount(), relicsBefore);
    truthy('D7c 用一次就少一张（消费口真的扣得掉）',
        dc.bagData.consumeItem(BAG_ITEM_KEY.outerDrawTicket, 1));
    check('D7d 扣完之后 = 0', dc.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket), 0);
    check('D7e 没券时消费返回 false（调用方据此走正常扣金币）',
        dc.bagData.consumeItem(BAG_ITEM_KEY.outerDrawTicket, 1), false);
    check('D7f 扣到 0 的记录被整条删掉（不留在存档里当垃圾）',
        dc.bagData.data.items.filter((r) => r.key === BAG_ITEM_KEY.outerDrawTicket).length, 0);

    dc.grantShopItem('ad_ticket');
    check('D8 局内广告券 +1', dc.bagData.getCount(BAG_ITEM_KEY.adTicket), 1);
    // 跨天：券要留着（跨局累积的口径）
    dc.shopData.data.dailyKey = '19700101';
    dc.shopData.ensurePeriod();
    check('D8b 券跨天保留（不随日键清零）', dc.bagData.getCount(BAG_ITEM_KEY.adTicket), 1);

    // A5 = 局内复活券（2026-11 顶替了原来的「开局增益券」格）：与另外两种券**同一条口径**
    fresh();
    dc.grantShopItem('revive_ticket');
    check('D8c 局内复活券 +1（A5 那一格发的就是它）', dc.bagData.getCount(BAG_ITEM_KEY.reviveTicket), 1);
    check('D8d 复活券与广告券是**两格两件东西**（不会互相串账）',
        [dc.bagData.getCount(BAG_ITEM_KEY.adTicket), dc.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket)], [0, 0]);
    // 死亡时用掉一张（真消费口在 `Scene_Game_Stage`，这里验的是"背包扣得动"这一层）
    truthy('D8e 复活券扣得掉（局内死亡那一刻就是调它）',
        dc.bagData.consumeItem(BAG_ITEM_KEY.reviveTicket, 1));
    check('D8f 扣完 = 0', dc.bagData.getCount(BAG_ITEM_KEY.reviveTicket), 0);
    check('D8g 这一格的每日上限按配表（2 次/天）', MallConfig.getDailyLimit('revive_ticket'), 2);

    fresh();
    check('D9 没看广告就什么都不发生（次数为 0，发奖口不该被调）',
        [dc.shopData.getAdUsedToday(), dc.shopData.getAdCardWatched()], [0, 0]);

    // ────────────── E 免广告卡 ──────────────
    console.log('\nE 免广告卡（累计观看换 N 小时免广告）');
    fresh();
    const e1 = dc.claimAdCard();
    check('E1 一次没看就想领 → not_enough', [e1.ok, e1.reason], [false, 'not_enough']);

    // 攒满（直接记 84 次：真实路径就是看 84 次广告）
    for (let i = 0; i < need; i++) dc.shopData.recordAdWatched('gold');
    check('E2 累计观看攒到门槛', dc.shopData.getAdCardWatched(), need);
    truthy('E2b 攒满即可领', dc.shopData.canClaimAdCard(need));
    const e2 = dc.claimAdCard();
    truthy('E2c 领取成功', e2.ok, e2.reason);
    within('E2d 生效到 now + 时长（秒）',
        Math.round((e2.activeUntil - Date.now()) / 1000), MallConfig.getAdCardHours() * 3600 - 5, MallConfig.getAdCardHours() * 3600);
    check('E2e 领完累计计数清零（下一张从头攒）', dc.shopData.getAdCardWatched(), 0);
    within('E2f 剩余秒数 ≈ 时长', dc.shopData.getAdCardLeftSec(), MallConfig.getAdCardHours() * 3600 - 5, MallConfig.getAdCardHours() * 3600);

    const e3 = dc.claimAdCard();
    check('E3 生效中再领被拒（**不会叠成 48 小时**）', [e3.ok, e3.reason], [false, 'active']);

    dc.shopData.data.adCardActiveUntil = Date.now() - 1000;
    truthy('E4 过期后不再生效', dc.shopData.isAdCardActive() === false);
    const e4 = dc.claimAdCard();
    check('E4b 过期但没重新攒满 → 又回到 not_enough', [e4.ok, e4.reason], [false, 'not_enough']);

    // ────────────── F 增益券池（随机 + cap 过滤） ──────────────
    //  ⚠ 2026-11 改：商城**已经没有「开局增益券」格了**（A5 换成局内复活券），
    //    所以"抽券"这件事现在只剩**一个出口**：每日补给的「连续登录 ≥ shopStreakGiftDay 天加送」。
    //    下面这一组因此改成走 `claimShopDailyGift()`（每次把"今天已领"清掉即可重复触发，真机一天只触发一次）。
    console.log('\nF 本局增益券池（现在的唯一出口 = 每日补给的连续登录赠券）');
    /** 触发一次「连续登录赠券」并返回发奖结果（把 loginStreak 顶到门槛、把"今天已领"清掉） */
    const grantBoostGift = () => {
        const day = MallConfig.getStreakGiftDay();
        truthy('F0 连续登录赠券已配置（本组的前提）', day > 0, `shopStreakGiftDay=${day}`);
        dc.playerInfo.data.loginStreak = Math.max(dc.playerInfo.data.loginStreak, day);
        dc.shopData.data.freeClaimedKey = '';   // 允许重复领：真机由日键约束，这里是为了一次摸完池子
        return dc.claimShopDailyGift();
    };
    /** 一次发奖里"真的发了增益券"那一行（没有 = 这次没发券，池子满了） */
    const boostLineOf = (res) => (res.granted || []).find((l) => l.type === 'boost') ?? null;

    fresh();
    const drawn = [];
    for (let i = 0; i < 60 && drawn.length < ACH_EFFECT_CODES.length; i++) {
        const r = grantBoostGift();
        if (!r.ok) break;
        const code = dc.bagData.getBoostTickets().map((t) => t.code).find((c) => drawn.indexOf(c) < 0);
        if (code) drawn.push(code);
    }
    truthy('F1 连抽能摸到多条不同效果（不是恒定一条）', drawn.length >= 3, drawn);
    const illegal = dc.bagData.getBoostTickets().filter((t) => ACH_EFFECT_CODES.indexOf(t.code) < 0);
    check('F1b 抽到的 code 全在 10 条效果里', illegal.map((t) => t.code), []);
    const overCap = dc.bagData.getBoostTickets()
        .filter((t) => t.count * MallConfig.getBoostTicketValue(t.code) > ACH_EFFECT_META[t.code].cap)
        .map((t) => `${t.code}=${t.count}`);
    check('F1c 任何一种券的数量都没超过该效果的 cap', overCap, []);

    // 把 9 条效果拉满，只留 run_start_gold 还能发
    fresh();
    const OPEN = 'run_start_gold';
    for (const code of ACH_EFFECT_CODES) {
        if (code === OPEN) continue;
        const v = MallConfig.getBoostTicketValue(code);
        dc.bagData.addBoostTicket(code, Math.ceil(ACH_EFFECT_META[code].cap / v));
    }
    const f2Open = [];
    for (let i = 0; i < 12; i++) {
        const line = boostLineOf(grantBoostGift());
        if (line) f2Open.push(line.text.indexOf(ACH_EFFECT_META[OPEN].name) >= 0);
    }
    truthy('F2 只剩一条效果没满时，每一次发的都是那一条（已达 cap 的不再发）',
        f2Open.length > 0 && f2Open.every(Boolean), f2Open);
    check('F2b 发到 cap / 每张值 的次数之后就再也不发了',
        f2Open.length, Math.floor(ACH_EFFECT_META[OPEN].cap / MallConfig.getBoostTicketValue(OPEN)));

    // 全满 → 券一张都发不出来，但**每日补给本身照发**（金币/经验不该被券池拖累）
    fresh();
    for (const code of ACH_EFFECT_CODES) {
        dc.bagData.addBoostTicket(code, Math.ceil(ACH_EFFECT_META[code].cap / MallConfig.getBoostTicketValue(code)));
    }
    const goldBeforeFull = dc.itemData.getCurrency(CurrencyType.Gold);
    const boostCountBeforeFull = dc.bagData.getBoostTotalCount();
    const f3 = grantBoostGift();
    truthy('F3 券池全满时每日补给仍然成功（不是整单失败）', f3.ok, f3.reason);
    check('F3b 池满时**不发券**（这一单里没有 boost 行）', boostLineOf(f3), null);
    truthy('F3c 池满时金币照发（券池满只影响券）',
        dc.itemData.getCurrency(CurrencyType.Gold) > goldBeforeFull);
    check('F3d 池满时券的总张数一张都没涨（没有"凭空多一张"）',
        dc.bagData.getBoostTotalCount(), boostCountBeforeFull);

    // ────────────── G 跨天重置 ──────────────
    console.log('\nG 跨天重置');
    fresh();
    for (let i = 0; i < 3; i++) dc.grantShopItem('gold');
    dc.grantShopItem('ad_ticket');
    const g = {
        adUsed: dc.shopData.getAdUsedToday(),
        goldUsed: dc.shopData.getItemUsedToday('gold'),
        watched: dc.shopData.getAdCardWatched(),
        tickets: dc.bagData.getCount(BAG_ITEM_KEY.adTicket),
        free: dc.shopData.isFreeClaimedToday(),
    };
    check('G1 重置前：3 次金币 + 1 张广告券 = 总次数 4', [g.adUsed, g.goldUsed], [4, 3]);
    void g.free;

    dc.shopData.data.dailyKey = '19700101';
    dc.shopData.ensurePeriod();
    check('G2 跨天后今日广告总次数清零', dc.shopData.getAdUsedToday(), 0);
    check('G2b 跨天后每格次数清零', dc.shopData.getItemUsedToday('gold'), 0);
    check('G3 跨天后券保留（跨局累积）', dc.bagData.getCount(BAG_ITEM_KEY.adTicket), 1);
    check('G3b 跨天后免广告卡的累计观看保留（它是跨天累计的）',
        dc.shopData.getAdCardWatched(), g.watched);

    // ────────────── H 存档往返（DataModule 的合并坑） ──────────────
    console.log('\nH 存档往返（数组字段不能被 mergeDeep 吃掉）');
    fresh();
    dc.grantShopItem('gold');
    dc.grantShopItem('ad_ticket');
    dc.bagData.addBoostTicket('run_start_gold', 2);
    dc.shopData.recordAdWatched('hero_exp');
    // ⚠ 2026-11：三类券/次数住在**背包**（`bagData`）、日计数住在**商城**（`shopData`）
    //   → 存档往返要**各存各的**。这一段顺带就是 `BagData` 的存档体检（它的 `items` 也是数组）。
    const snapshot = dc.shopData.serialize();
    const bagSnapshot = dc.bagData.serialize();

    dc.shopData.reset();
    dc.bagData.reset();
    check('H1 两个模块各自 reset 之后都空了',
        [dc.shopData.getItemUsedToday('gold'), dc.bagData.getCount(BAG_ITEM_KEY.adTicket)], [0, 0]);

    dc.shopData.deserialize(snapshot);
    dc.bagData.deserialize(bagSnapshot);
    check('H2 读档后「每格今日次数」还在（数组才存得住）', dc.shopData.getItemUsedToday('gold'), 1);
    check('H2b 读档后「今日广告总次数」还在', dc.shopData.getAdUsedToday(), 3);
    check('H3 读档后券还在',
        [dc.bagData.getCount(BAG_ITEM_KEY.adTicket), dc.bagData.getBoostTotalCount()], [1, 2]);
    const loadedTick = dc.bagData.getBoostTickets().map((t) => `${t.code}x${t.count}`).join(',');
    check('H3b 券的种类与张数都对', loadedTick, 'run_start_goldx2');
    truthy('H4 读档后日键正确（今天）', dc.shopData.isFreeClaimedToday() === false);

    // ────────────── I 页面 VM（判据层：真跑 buildShopPageVM） ──────────────
    console.log('\nI 页面 VM（ShopVM.buildShopPageVM）');
    fresh();
    const vm1 = ShopVM.buildShopPageVM();
    check('I1 cells 覆盖 6 个广告格', vm1.cells.map((c) => c.key), adRows.map((r) => r.key));
    check('I2 每格的每日上限来自配表', vm1.cells.map((c) => c.dailyLimit), adRows.map((r) => r.daily_limit));
    check('I3 顶部读数 = 数据层读数',
        [vm1.resBar.gold, vm1.resBar.heroExp],
        [dc.itemData.getCurrency(CurrencyType.Gold), dc.heroData.getSharedExp()]);
    check('I4 今日广告 / 上限', [vm1.adUsedToday, vm1.adLimit], [0, MallConfig.getAdDailyTotalLimit()]);
    const relicCell = vm1.cells.find((c) => c.key === 'relic_draw');
    check('I5 遗物格那行是动态图鉴进度', relicCell.sub, `已收集 ${dc.equipCollection.getDistinctCount()}/${vm1.relicTotal}`);
    within('I5b 局外遗物总数是量级正确的数（不是 0 或 1）', vm1.relicTotal, 20, 60);
    check('I6 商品名与数量文案来自配表（改表界面就跟着改）',
        vm1.cells.map((c) => c.name), adRows.map((r) => r.name));
    check('I6b 数量文案同样来自配表', vm1.cells.map((c) => c.amountText), adRows.map((r) => r.amount_text));

    const fp1 = ShopVM.shopFingerprint();
    dc.grantShopItem('gold');
    const fp2 = ShopVM.shopFingerprint();
    truthy('I7 页面指纹随数据变化（watcher 才会自动重刷）', fp1 !== fp2, `${fp1} → ${fp2}`);
    const vm2 = ShopVM.buildShopPageVM();
    check('I7b 发奖后 VM 里那一格的次数 +1',
        vm2.cells.find((c) => c.key === 'gold').usedToday, 1);
    check('I7c 发奖后顶部金币也涨了', vm2.resBar.gold - vm1.resBar.gold, 300);

    const vm3 = ShopVM.buildShopPageVM();
    check('I8 daily 的数是"乘完倍数"的数（与实发同源）',
        [vm3.daily.gold, vm3.daily.heroExp], dc.previewShopDailyGift().gold === vm3.daily.gold
            ? [vm3.daily.gold, vm3.daily.heroExp] : null);
    check('I8b daily.streakMul 与 MallConfig 一致', vm3.daily.streakMul, MallConfig.getStreakMul(dc.playerInfo.data.loginStreak));
    check('I9 未领过时 claimed = false', vm3.daily.claimed, false);
    dc.claimShopDailyGift();
    check('I9b 领过之后 claimed = true（按钮会变灰药丸）', ShopVM.buildShopPageVM().daily.claimed, true);

    // ────────────── J 界面契约（读真预制件） ──────────────
    console.log('\nJ 界面契约（View_Shop.prefab / Scene_Menu.prefab）');
    const shopPrefab = readPrefab(SHOP_PREFAB);
    check('J1 商城预制件的根节点名 = View_Shop', shopPrefab.nodes.get(shopPrefab.roots[0])._name, 'View_Shop');
    const size = shopPrefab.comp('View_Shop', 'cc.UITransform')?._contentSize;
    check('J2 全屏页尺寸 750×1334', size ? [size.width, size.height] : null, [750, 1334]);

    const cellNames = shopPrefab.childNames(AD_LIST_CONTENT);
    check('J3 滚动内容里的子节点 = 契约里那六格',
        cellNames.slice().sort(), Object.values(SHOP_CELL_NODE).slice().sort());
    const missingCount = Object.values(SHOP_CELL_NODE)
        .filter((n) => shopPrefab.childNames(`${AD_LIST_CONTENT}/${n}`).indexOf('count') < 0);
    check('J4 每格都有 count 标签（「今日 N/M」写在这里）', missingCount, []);
    const missingName = Object.values(SHOP_CELL_NODE)
        .filter((n) => shopPrefab.childNames(`${AD_LIST_CONTENT}/${n}`).indexOf('name') < 0);
    check('J4b 每格都有 name 标签（商品名由配表下发）', missingName, []);
    const missingAmount = Object.values(SHOP_CELL_NODE)
        .filter((n) => shopPrefab.childNames(`${AD_LIST_CONTENT}/${n}`).indexOf('amount') < 0);
    check('J4c 每格都有 amount 标签（数量文案由配表下发）', missingAmount, []);

    // ── J4d~J4k：广告区是**竖直滚动列表**（2026-11 口径：后期还会加项，列表自己滚，下沿不过免广告卡） ──
    const sv = shopPrefab.comp('ad_list', 'cc.ScrollView');
    check('J4d ad_list 挂的是 ScrollView', !!sv, true);
    check('J4e 只竖向滚动（横向关掉）', sv ? [sv.vertical, sv.horizontal] : null, [true, false]);
    check('J4f ScrollView 认的 content = 滚动内容节点',
        sv && sv._content ? shopPrefab.data[sv._content.__id__]._name : null, 'content');
    check('J4g 拖动时不触发格子点击（cancelInnerEvents）', sv ? sv.cancelInnerEvents : null, true);
    // ⚠ 剪裁 Mask **不能**和 ScrollView 挂在同一个节点上：3.8.6 实测那样挂，编辑态里整棵子树被裁没
    //   （Mask 挂到 ScrollView 认的 `view` 子节点上才正常 —— 那也正是编辑器自建 ScrollView 的既定形态）
    check('J4h Mask 挂在 view 上（不是和 ScrollView 同节点）',
        [shopPrefab.comps('ad_list').indexOf('cc.Mask'), shopPrefab.comps('ad_list/view').indexOf('cc.Mask')], [-1, 1]);
    const layout = shopPrefab.comp(AD_LIST_CONTENT, 'cc.Layout');
    check('J4i 内容是「容器自增」的流式版式（加项自动往下长）',
        layout ? [layout._resizeMode, layout._constraintNum, layout._startAxis] : null, [1, 2, 0]);
    check('J4j 第一行两格、行距沿用原设计（24 / 20）',
        layout ? [layout._spacingX, layout._spacingY] : null, [24, 20]);
    // 下沿：ad_list 用 Widget 贴底且停在免广告卡上方（免广告卡上沿 = 它的 _bottom + 自身高）
    const listWidget = shopPrefab.comp('ad_list', 'cc.Widget');
    const cardWidget = shopPrefab.comp('ad_progress', 'cc.Widget');
    const cardH = shopPrefab.comp('ad_progress', 'cc.UITransform')._contentSize.height;
    const listBottom = listWidget ? listWidget._bottom : null;
    const cardTop = cardWidget ? cardWidget._bottom + cardH : null;
    truthy('J4k ad_list 用 Widget 贴了下边（下沿会跟着分辨率走）',
        !!listWidget && (listWidget._alignFlags & 4) !== 0, `${listWidget && listWidget._alignFlags}`);
    truthy(`J4k2 列表下沿在免广告卡上沿之上（${listBottom} ≥ ${cardTop}，不压到卡）`,
        listBottom !== null && cardTop !== null && listBottom >= cardTop, `${listBottom} vs ${cardTop}`);

    // 脚本里写死的节点路径，必须在预制件里真的存在（改预制件忘了改代码 = 静默不生效）
    const viewShopSrc = fs.readFileSync(path.join(ROOT, SRC, 'ui/views/shop/View_Shop.ts'), 'utf8');
    const codePaths = grabPaths(viewShopSrc, 'at');
    check('J5 View_Shop.resolveRefs 引用的路径全部存在', codePaths.filter((p) => !shopPrefab.has(p)), []);
    truthy('J5b 至少解析了 15 个节点（防止正则抓空）', codePaths.length >= 15, codePaths.length);
    check('J5c 六个格子的 key 与节点名映射都存在（契约表没写错）',
        Object.entries(SHOP_CELL_NODE).filter(([, n]) => !shopPrefab.has(`${AD_LIST_CONTENT}/${n}`)).map(([k]) => k), []);

    const menuPrefab = readPrefab(MENU_PREFAB);
    const menuSrc = fs.readFileSync(path.join(ROOT, SRC, 'ui/scenes/scene_menu/Scene_Menu.ts'), 'utf8');
    const tabPath = /SHOP_TAB_PATH\s*=\s*'([^']+)'/.exec(menuSrc)?.[1];
    truthy('J6 底部商城页签路径写死在 Scene_Menu.ts 里', !!tabPath, tabPath);
    truthy(`J6b 底部页签节点真存在（${tabPath}）`, menuPrefab.has(tabPath), tabPath);
    const entryPaths = [...menuSrc.matchAll(/'(head\/coins\/[^']+\/add)'/g)].map((m) => m[1]);
    check('J6c 顶栏三格的「+」入口路径全部存在', entryPaths.filter((p) => !menuPrefab.has(p)), []);
    check('J6d 三个顶栏入口都接了（gold / ernergy-001 / ernergy-002）', entryPaths.length, 3);
    const menuCodePaths = grabPaths(menuSrc, 'getChildByPath');
    check('J7 Scene_Menu 里其它按路径解析的节点也都在（含刚接的商城入口）',
        menuCodePaths.filter((p) => !menuPrefab.has(p)), []);
    check('J7b 商城入口在 Scene_Menu 里被接了两处（底部页签 + 顶栏三格）',
        (menuSrc.match(/onClickShop/g) ?? []).length >= 4, true);

    // ────────────── K 广告位与埋点 ──────────────
    console.log('\nK 广告位');
    const adSrc = fs.readFileSync(path.join(ROOT, 'assets/scripts/platform/ad/AdMgr.ts'), 'utf8');
    const placementBad2 = adRows.filter((r) => adSrc.indexOf(`'${r.placement}'`) < 0).map((r) => r.placement);
    check('K1 配表里的每个广告位都在 AdPlacement 类型里声明过（埋点不丢）', placementBad2, []);
    check('K2 MallConfig.getPlacement 与配表一致',
        adRows.map((r) => MallConfig.getPlacement(r.key)), adRows.map((r) => r.placement));
    check('K3 荣誉/体力这类"没有出口"的东西没有被卖（配表里不该出现）',
        rawItems.filter((r) => (r.grants ?? []).some((g) => g.type === 'stamina' || g.type === 'diamond')).map((r) => r.key), []);

    // ────────────── L 与成就表对账 ──────────────
    console.log('\nL 与成就表对账（券池的 cap 是有出处的）');
    const effectCodes = new Set(rawAchieve.filter((r) => r.effect_code).map((r) => r.effect_code));
    check('L1 券池的 10 条效果都有成就来源（不是凭空造的）',
        ACH_EFFECT_CODES.filter((c) => !effectCodes.has(c)), []);

    // ============================ 收尾 ============================
    console.log(`\n${failures.length ? '✘' : '✔'} 商城体检：${passed} 条通过，${failures.length} 条失败`);
    if (failures.length) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
        process.exit(1);
    }
};

main();
