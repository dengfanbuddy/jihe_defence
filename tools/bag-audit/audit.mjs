#!/usr/bin/env node
/**
 * audit.mjs —— **局外背包体检**（不依赖 Cocos 编辑器，一条命令跑完）
 *
 * 回答的问题：**这一屏的"格子、数量、文案"到底对不对** —— 表里写了 12 件道具，
 * 玩家手里那几件会不会出现在格子上、数量会不会被堆叠上限悄悄吃掉、商城的券是不是真的进了背包、
 * 详情面板那两行文案会不会**被框裁掉字**、选中那一格被用光之后会不会还显示一件"没有的东西"。
 * 这些配表验不出来（`npm run check` 只验格式），只有把真代码真跑起来才暴露。
 *
 * 做法（与 `audit:mall` / `audit:attr` / `audit:slot` 同一手法）：
 *   把项目里真实的 `BagData` / `BagConfig` / `DataCenter` / `BagVM` / `bag_items.json` /
 *   `battle_constants.json` 用 TypeScript 的 `transpileModule` 编成 CJS，
 *   只给「碰 cc / 碰 localStorage」的少数依赖打桩（`TbRoot` 桩按 `:tb/xxx` **真读** `assets/resources` 下的 JSON），
 *   然后用**真配表**驱动：发券 → 看格子 → 扣次数 → 撑爆堆叠上限 → 过期 → 存档往返 → 算一遍页面 VM。
 *
 * 为什么必须真跑（这几条是这次落地时就想清楚的，写在断言里防回归）：
 *   ① **文案会不会被框吃掉 / 被顶出面板**：详情面板的框尺寸与溢出模式**现读预制件**（B 段）——
 *      名字框是 `CLAMP`（超了**直接吃字**），正文框是 `RESIZE_HEIGHT`（不裁字，但写长了会把
 *      「使用 / 出售」一格格顶出面板）。编辑器里两种都**看不出来**，所以 B 段按框宽逐行估算
 *      （宁可保守多报，也不要"字被吃了 / 按钮点不到没人知道"）；
 *   ② **堆叠上限不能静默吞**：`stack_max` 到了就该拒绝并打 warn，而不是"看起来发了、其实没进包"；
 *   ③ **扣到 0 要整条删掉**：留着 `count: 0` 的记录 = 存档里永远清不掉的垃圾（而且背包格子的判据是"有没有记录"）；
 *   ④ **选中回落**：选中的那一格被用光后，详情面板必须回落到别的格（一件都没有 → "未选中"占位态）——
 *      显示一件玩家已经没有的道具是这类界面最典型的谎言；
 *   ⑤ **界面契约靠节点名对表**：改配表 key、改预制件格子名、改 `Scene_Menu` 里的入口路径，
 *      任何一处不一致都在 F/G 段当场爆（不用打开编辑器点）；
 *   ⑥ **预制件上"拖的引用"也要对表**（F16b）：`resolveRefs` 的 `??` 兜底只认"没拖"，**拦不住"拖错了"** ——
 *      2026-11 用户给 `item_detail` 加了一层 `content` 之后就是这么坏的（详见 F 段注释）。
 *
 * 用法：
 *   node tools/bag-audit/audit.mjs          # 体检 + 结论（有任何一条不过 → 退出码 1）
 *   npm run audit:bag                       # tools/excel_export 下的等价命令
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
const BAG_PREFAB = 'assets/resources/prefabs/ui/views/bag/View_Bag.prefab';
const CELL_PREFAB = 'assets/resources/prefabs/ui/views/bag/cmps/Bag_Cell.prefab';
const MENU_PREFAB = 'assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab';
const BAG_VIEW_SRC = 'assets/scripts/game/ui/views/bag/View_Bag.ts';
const BAG_ITEM_SRC = 'assets/scripts/game/ui/views/bag/BagItem.ts';
const BAG_VM_SRC = 'assets/scripts/game/ui/views/bag/BagVM.ts';
const BAG_SCOPE_SRC = 'assets/scripts/game/ui/views/bag/BagScope.ts';
const MENU_SRC = 'assets/scripts/game/ui/scenes/scene_menu/Scene_Menu.ts';

/**
 * 需要真跑的源码（相对 `assets/scripts/game`）。
 * 拉 `DataCenter` 就把整条数据链路都拉进来了（账号/英雄/道具/收集/任务/成就/难度/商城/背包）。
 */
const SOURCES = [
    // 配表容器
    'excel_table/Tb_BagItemConfig.ts',
    'excel_table/Tb_MallItemConfig.ts',
    'excel_table/Tb_AchievementConfig.ts',
    'excel_table/Tb_RelicConfig.ts',
    'excel_table/Tb_TaskConfig.ts',
    'excel_table/Tb_PlayerLevelConfig.ts',
    'excel_table/Tb_UnitConfig.ts',
    'excel_table/Tb_BattleConstConfig.ts',
    'excel_table/Tb_AbilityConfig.ts',
    'excel_table/Tb_AttributeConfig.ts',
    'excel_table/EffectTypes.ts',
    // 公共配置/工具
    'common/DayKey.ts',
    'common/AchievementEffectMeta.ts',
    'common/DifficultyConfig.ts',
    'common/GoldText.ts',
    'common/RelicRarityColor.ts',
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
    'data/funcs/BagData.ts',
    'data/configs/LevelConfig.ts',
    'data/configs/TaskConfig.ts',
    'data/configs/AchievementConfig.ts',
    'data/configs/HeroConfig.ts',
    'data/configs/MallConfig.ts',
    'data/configs/EquipmentConfig.ts',
    'data/configs/BagConfig.ts',
    // 界面侧（判据与契约）
    'ui/views/bag/BagScope.ts',
    'ui/views/bag/BagVM.ts',
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
 *     按 `bundle/path` **真读** `assets/resources/<path>.json` 并调 `handleData()`。
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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-bag-audit-'));
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
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ============================ 文案宽度估算（B 段的核心） ============================

/**
 * 估算一段文字在某个字号下的宽度（像素）。**故意偏保守**（宁可多报，也不要漏报裁字）：
 *   · 全角（CJK / 全角标点）：1 个字 = 1 个字号
 *   · 半角（ASCII / 数字 / 半角标点）：1 个字 = 0.6 个字号（Arial 数字约 0.55，取 0.6）
 *
 * ⚠ 这不是像素级精确排版（真排版要看字体与引擎的 measure），它要拦的是**量级错误**：
 *   写了一句 25 个字的话塞进只放得下 12 个字的框 —— 那一定会被 CLAMP 吃掉后半句。
 */
function estWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text ?? '')) {
        const code = ch.codePointAt(0);
        // 全角判定：CJK 统一表意 / 全角标点 / 中文常用符号段
        const full = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
            || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
            || (code >= 0xffe0 && code <= 0xffe6);
        w += full ? fontSize : fontSize * 0.6;
    }
    return w;
}

// ============================ 预制件读取（F 段：界面契约） ============================

/**
 * 读一个 prefab，返回「根节点 → 全部后代路径」的集合。
 * 路径口径与代码里的 `node.getChildByPath('a/b/c')` 一致（相对**视图根节点、不含根节点名**）。
 * ⚠ 预制件里嵌套的**预制件实例**节点没有 `_name`（名字在运行时才由嵌套预制件补上），
 *   那种节点按 `#inst` 占位（本体检不引用它们的路径，只保证不会因为 undefined 崩掉）。
 */
function readPrefab(rel) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const nodes = new Map();
    data.forEach((o, i) => { if (o && o.__type__ === 'cc.Node') nodes.set(i, o); });
    const nameOf = (id) => nodes.get(id)?._name || '#inst';
    const childrenOf = (id) => (nodes.get(id)?._children ?? []).map((c) => c.__id__);
    const parentOf = (id) => {
        const p = nodes.get(id)?._parent;
        return p ? p.__id__ : null;
    };
    const roots = [...nodes.keys()].filter((id) => parentOf(id) === null);
    const paths = new Set();
    const byPath = new Map();
    /** 节点 id → 路径（口径与 `byPath` 一致：**不含根节点名**，根自己就是它的名字） */
    const pathOfId = new Map();
    const walk = (id, prefix) => {
        const p = prefix ? `${prefix}/${nameOf(id)}` : nameOf(id);
        paths.add(p);
        byPath.set(p, id);
        pathOfId.set(id, p);
        for (const c of childrenOf(id)) walk(c, p);
    };
    for (const r of roots) {
        paths.add(nameOf(r));
        byPath.set(nameOf(r), r);
        pathOfId.set(r, nameOf(r));
        for (const c of childrenOf(r)) walk(c, '');
    }
    const compObjsOf = (p) => (nodes.get(byPath.get(p))?._components ?? []).map((c) => data[c.__id__]);
    return {
        data,
        nodes,
        paths,
        byPath,
        pathOfId,
        /** 某个路径下的直接子节点名 */
        childNames: (p) => childrenOf(byPath.get(p)).map(nameOf),
        /** 某节点上的组件类型列表 */
        comps: (p) => compObjsOf(p).map((c) => c?.__type__),
        /** 某节点上的**组件对象**（要读字段值用这个，不是上面的类型名） */
        compObjs: compObjsOf,
        /**
         * 把脚本上拖的一个引用（`{__id__}`）解析成**它所在的节点路径**。
         * 引用可能是节点本身，也可能是某个组件（那时取组件挂在哪个节点上）——
         * 两种都要认，否则"拖的是 Sprite 还是 Node"会让核对方式不一致（本文件两种都有）。
         */
        refPath: (ref) => {
            const obj = ref ? data[ref.__id__] : null;
            if (!obj) return null;
            const nodeId = obj.__type__ === 'cc.Node' ? ref.__id__ : obj.node?.__id__;
            return pathOfId.get(nodeId) ?? null;
        },
        /** 根节点上挂的那颗**业务脚本**组件（`cc.*` 之外的第一个） */
        scriptOn: (p) => compObjsOf(p).find((c) => c && typeof c.__type__ === 'string' && !c.__type__.startsWith('cc.')),
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
    const rawItems = readTb('bag_items');
    const consts = readTb('battle_constants');
    const { mod, tbRoot } = build();

    // ── 全局最小打桩：`StorageUtil` 只用到 localStorage 的四个方法（读写都包在 try 里） ──
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
    const { BagConfig, BAG_ITEM_KEY, BAG_SLOT_CAPACITY } = mod('data', 'configs', 'BagConfig.js');
    const { MallConfig } = mod('data', 'configs', 'MallConfig.js');
    const BagVM = mod('ui', 'views', 'bag', 'BagVM.js');
    const BagScope = mod('ui', 'views', 'bag', 'BagScope.js');
    const { BagItemCfgContainer } = mod('excel_table', 'Tb_BagItemConfig.js');
    const { ACH_EFFECT_CODES, ACH_EFFECT_META, achEffectLabel } = mod('common', 'AchievementEffectMeta.js');
    const { rarityColor } = mod('common', 'RelicRarityColor.js');

    // 容器真装载一次（后面 BagConfig / DataCenter 都走它的数据）
    tbRoot.ins.getTbContainer(BagItemCfgContainer);

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
        dc.bagData.reset();
    };

    // ────────────── A 配表结构（bag_items） ──────────────
    console.log('\nA 配表结构（bag_items）');
    truthy('A1 配表有道具（不是空表）', rawItems.length > 0, rawItems.length);

    const keys = rawItems.map((r) => r.key);
    check('A2 key 全局唯一', new Set(keys).size, rawItems.length);
    const ids = rawItems.map((r) => r.id);
    check('A2b id 全局唯一', new Set(ids).size, rawItems.length);

    const sorts = rawItems.map((r) => r.sort);
    check('A3 sort 互不重复（格子顺序稳定）', new Set(sorts).size, rawItems.length);

    const requiredBad = rawItems.filter((r) => !r.key || !r.name || !r.rarity || !(r.stack_max >= 0)
        || typeof r.usable !== 'boolean' || typeof r.sellable !== 'boolean' || !(r.sort >= 0));
    check('A4 必填字段齐备（key/name/rarity/stack_max/usable/sellable/sort）', requiredBad.map((r) => r.key), []);

    const rarityBad = rawItems.filter((r) => rarityColor(r.rarity) === undefined || !['common', 'rare', 'epic', 'legendary'].includes(r.rarity));
    check('A5 rarity 全在四档里（否则格子底框色会回落成白）', rarityBad.map((r) => r.key), []);

    check('A6 本期 usable / sellable 全为 false（"使用 / 出售"是只读的，见 docs/bag/README.md §5）',
        rawItems.filter((r) => r.usable || r.sellable).map((r) => r.key), []);

    // 增益券：key 必须 = `boost_<effect_code>`，且 10 条效果一条不漏（否则商城发的那张券进不了格子）
    const boostRows = rawItems.filter((r) => r.effect_code);
    check('A7 增益券行数 == 10 条成就效果', boostRows.length, ACH_EFFECT_CODES.length);
    const boostKeyBad = boostRows.filter((r) => r.key !== `boost_${r.effect_code}`);
    check('A7b 增益券的 key 必须是 boost_<effect_code>（BagConfig.boostItemKey 就是按这个拼的）',
        boostKeyBad.map((r) => r.key), []);
    const boostMissing = ACH_EFFECT_CODES.filter((code) => !boostRows.some((r) => r.effect_code === code));
    check('A7c 10 条效果都有对应的券（商城发奖时按 code 找格子，缺一条就有一张券发不出去）', boostMissing, []);
    const effectKeyBad = rawItems.filter((r) => !r.effect_code && keys.indexOf(`boost_${r.key}`) >= 0);
    check('A7d 非增益券行不许写 effect_code', effectKeyBad.map((r) => r.key), []);

    check('A8 三类"有产出源"的道具都在表里（商城 A4/A5/A6 发的东西必须接得住）',
        [BAG_ITEM_KEY.adTicket, BAG_ITEM_KEY.outerDrawTicket].filter((k) => keys.indexOf(k) < 0), []);

    // 图标：填了路径就必须真有那个 png（填了不存在的路径 = 每次开界面刷一条加载失败）
    const iconBad = [];
    for (const r of rawItems) {
        if (!r.icon) continue;
        if (!fs.existsSync(path.join(ROOT, 'assets/resources', `${r.icon}.png`))) iconBad.push(`${r.key}:${r.icon}`);
    }
    check('A9 配的图标文件都真实存在（resources 相对路径 + 不带扩展名）', iconBad, []);

    // stack_max：0 = 不限，>0 必须是个像样的正整数（1 会让"领第二张"直接失败）
    const stackBad = rawItems.filter((r) => r.stack_max !== 0 && !(r.stack_max >= 2)).map((r) => `${r.key}=${r.stack_max}`);
    check('A10 stack_max 合法（0 = 不限；>0 时至少 2，否则第 2 张就发不进去）', stackBad, []);

    // ────────────── B 文案宽度（框的尺寸**从预制件现读**，不是手抄） ──────────────
    //  ⚠ 2026-11 预制件改版后详情面板多了 `content` 容器、`desc` 的溢出模式也从 CLAMP 变成了
    //  RESIZE_HEIGHT —— 手抄的"200×64 / 两行"当场就成了假口径。所以这一段的框尺寸一律**现读预制件**：
    //  框改了，这一段的判据跟着改（要么照新框核文案，要么在体检里当场看见框变了）。
    console.log('\nB 文案宽度（详情面板 / 格子 / 底栏的框，尺寸从预制件现读）');
    const bagPrefab = readPrefab(BAG_PREFAB);
    const cellPrefab = readPrefab(CELL_PREFAB);

    /**
     * 取一个 Label 的框：宽 / 字号 / 行距 / 溢出模式。
     * `ov`：0 NONE · 1 **CLAMP（裁字）** · 2 SHRINK（缩字） · 3 RESIZE_HEIGHT（长高，不裁字）。
     */
    const labelBox = (prefab, p) => {
        const lab = prefab.compObjs(p).find((c) => c.__type__ === 'cc.Label');
        const ut = prefab.compObjs(p).find((c) => c.__type__ === 'cc.UITransform');
        return lab ? { w: ut?._contentSize?.width ?? 0, fs: lab._fontSize, lh: lab._lineHeight, ov: lab._overflow } : null;
    };
    const nodeBox = (prefab, p) => prefab.compObjs(p).find((c) => c.__type__ === 'cc.UITransform');

    const nameBox = labelBox(bagPrefab, 'item_detail/content/name');
    const descBox = labelBox(bagPrefab, 'item_detail/content/desc');
    const countBox = labelBox(cellPrefab, 'count');
    const capBox = labelBox(bagPrefab, 'bottom_bar/cap_value');
    const btnBox = labelBox(bagPrefab, 'item_detail/content/btn_use/label');
    truthy('B0 五个文案框都从预制件读到了（读不到 = 节点名改过，下面几条估算全不作数）',
        !!nameBox && !!descBox && !!countBox && !!capBox && !!btnBox,
        { nameBox, descBox, countBox, capBox, btnBox });

    const NAME_W = nameBox.w, NAME_FS = nameBox.fs;
    const DESC_W = descBox.w, DESC_FS = descBox.fs, DESC_LH = descBox.lh;
    const COUNT_W = countBox.w, COUNT_FS = countBox.fs;
    const CAP_W = capBox.w, CAP_FS = capBox.fs;
    const BTN_W = btnBox.w, BTN_FS = btnBox.fs;

    // 名字框是 CLAMP ⇒ 超了**直接吃字**（编辑器里预览看不出来），所以它是硬红线
    const nameBad = rawItems.filter((r) => estWidth(r.name, NAME_FS) > NAME_W)
        .map((r) => `${r.key}「${r.name}」${Math.round(estWidth(r.name, NAME_FS))}px>${NAME_W}`);
    check(`B1 道具名放得进名字框（${NAME_W}px / fs${NAME_FS}，CLAMP ⇒ 超了直接吃字）`, nameBad, []);

    // 正文是 RESIZE_HEIGHT ⇒ **不裁字**，但一行放不下就会折行（两行的版式被挤成三四行、把按钮往下推）
    const hintBad = rawItems.filter((r) => estWidth(r.use_hint, DESC_FS) > DESC_W)
        .map((r) => `${r.key}「${r.use_hint}」${Math.round(estWidth(r.use_hint, DESC_FS))}px>${DESC_W}`);
    check(`B2 use_hint 放得进一行（${DESC_W}px / fs${DESC_FS} ≈ 12 个汉字，折行会挤版式）`, hintBad, []);

    const descBad = rawItems.filter((r) => estWidth(r.desc, DESC_FS) > DESC_W)
        .map((r) => `${r.key}「${r.desc}」${Math.round(estWidth(r.desc, DESC_FS))}px>${DESC_W}`);
    check('B3 desc 放得进一行（它下面还有第二行，折行了第二行就被挤走）', descBad, []);

    // 第二行：增益券是 `achEffectLabel(code, 每张值)`，其余是 use_hint —— 逐条估一遍
    const boostVals = (consts.shopBoostTicketValues && typeof consts.shopBoostTicketValues === 'object')
        ? consts.shopBoostTicketValues : {};
    const line2Of = (r) => (r.effect_code ? achEffectLabel(r.effect_code, boostVals[r.effect_code] ?? 0) : (r.use_hint ?? ''));
    const line2Bad = rawItems.filter((r) => estWidth(line2Of(r), DESC_FS) > DESC_W)
        .map((r) => `${r.key}「${line2Of(r)}」`);
    check('B4 详情面板第二行（效果文案 / use_hint）放得进一行', line2Bad, []);

    const countBad = rawItems.filter((r) => estWidth(`×${Math.max(1, r.stack_max)}`, COUNT_FS) > COUNT_W)
        .map((r) => `${r.key}「×${r.stack_max}」`);
    check(`B5 格子上的「×N」放得进 ${COUNT_W}px / fs${COUNT_FS}（上限写满也不许溢出）`, countBad, []);

    const capText = `${BAG_SLOT_CAPACITY}/${BAG_SLOT_CAPACITY}`;
    truthy(`B6 底栏容量文案放得进 ${CAP_W}px / fs${CAP_FS}`,
        estWidth(capText, CAP_FS) <= CAP_W, `${capText} = ${Math.round(estWidth(capText, CAP_FS))}px`);
    for (const text of ['不可使用', '不可出售', '使用', '出售 999']) {
        truthy(`B7 按钮文案「${text}」放得进 ${BTN_W}px / fs${BTN_FS}`, estWidth(text, BTN_FS) <= BTN_W,
            `${Math.round(estWidth(text, BTN_FS))}px`);
    }

    /**
     * 按框宽折行估价：这一段文字画出来会占**几行**。
     * ⚠ 只估行数（不模拟字体度量）—— 正文框是 `RESIZE_HEIGHT`，**多一行就长高一行**。
     */
    const wrapLineCount = (text, maxWidth, fontSize) => {
        let lines = 0;
        for (const logical of String(text ?? '').split('\n')) {
            if (!logical) { lines += 1; continue; }
            let cur = '';
            for (const ch of logical) {
                if (cur && estWidth(cur + ch, fontSize) > maxWidth) { lines += 1; cur = ch; } else cur += ch;
            }
            lines += 1;
        }
        return lines;
    };

    // 详情正文的总高必须放得进面板：`desc` 是 RESIZE_HEIGHT ⇒ 写长了**不裁字**，
    // 代价是它下面的「使用 / 出售」被一格格顶下去 —— 顶出面板 = 按钮点不到了。
    // 固定部分 = 面板上下留白 + 图标 + 名字 + 两个按钮 + 它们之间那 4 道间距（口径取自预制件的 Layout）。
    const panelUt = nodeBox(bagPrefab, 'item_detail');
    const contentLayout = bagPrefab.compObjs('item_detail/content').find((c) => c.__type__ === 'cc.Layout');
    const fixedH = contentLayout._paddingTop
        + nodeBox(bagPrefab, 'item_detail/content/icon_tile')._contentSize.height
        + nodeBox(bagPrefab, 'item_detail/content/name')._contentSize.height
        + nodeBox(bagPrefab, 'item_detail/content/btn_use')._contentSize.height
        + nodeBox(bagPrefab, 'item_detail/content/btn_sell')._contentSize.height
        + contentLayout._spacingY * 4;
    const descBudget = panelUt._contentSize.height - fixedH;
    let worstLines = 0, worstKey = '';
    for (const r of rawItems) {
        const lines = wrapLineCount(`${r.desc ?? ''}\n${line2Of(r)}`, DESC_W, DESC_FS);
        if (lines > worstLines) { worstLines = lines; worstKey = r.key; }
    }
    const worstH = worstLines * DESC_LH;
    truthy(`B8 最长的详情正文（${worstKey}，估 ${worstLines} 行 ≈ ${worstH}px）放得进面板留给正文的 ${descBudget}px`
        + '（超了「使用 / 出售」会被顶出面板）', worstH <= descBudget, `${worstH}px ≤ ${descBudget}px`);
    truthy('B8b 正文框是 RESIZE_HEIGHT（不裁字 → 上面那条是"会不会顶掉按钮"，不是"会不会吃字"）',
        descBox.ov === 3, { ov: descBox.ov });
    truthy('B8c 名字框是 CLAMP（所以 B1 才是一条硬红线）', nameBox.ov === 1, { ov: nameBox.ov });

    // ────────────── C BagData 真跑（存量 / 扣费 / 堆叠上限 / 过期） ──────────────
    console.log('\nC BagData（存量与规则，真跑）');
    fresh();
    const bag = dc.bagData;

    check('C1 新号背包是空的', [bag.getCount(BAG_ITEM_KEY.adTicket), bag.getUsedSlots()], [0, 0]);

    bag.addItem(BAG_ITEM_KEY.adTicket, 3);
    check('C2 加 3 张 → 读数 3', bag.getCount(BAG_ITEM_KEY.adTicket), 3);
    check('C2b 占 1 格（一格 = 一种道具，不是一件）', bag.getUsedSlots(), 1);
    truthy('C2c has() 与读数一致', bag.has(BAG_ITEM_KEY.adTicket));

    check('C3 扣 1 张成功', bag.consumeItem(BAG_ITEM_KEY.adTicket, 1), true);
    check('C3b 扣完剩 2', bag.getCount(BAG_ITEM_KEY.adTicket), 2);
    check('C4 不够就整笔失败（不做部分扣）', bag.consumeItem(BAG_ITEM_KEY.adTicket, 5), false);
    check('C4b 失败时一张都不动', bag.getCount(BAG_ITEM_KEY.adTicket), 2);
    check('C5 没有的道具扣不动', bag.consumeItem('no_such_item', 1), false);

    // 扣到 0 → 整条记录删掉（存档里不留垃圾）
    bag.clearItem(BAG_ITEM_KEY.adTicket);
    check('C6 清空后读数 0、格子也消失', [bag.getCount(BAG_ITEM_KEY.adTicket), bag.getUsedSlots()], [0, 0]);
    check('C6b 记录整条删掉了（不是留一个 count:0）', bag.data.items.length, 0);

    // 堆叠上限：真截断 + 真告警（**不能静默吞**）
    fresh();
    const adMax = BagConfig.getStackMax(BAG_ITEM_KEY.adTicket);
    truthy('C7 广告券配了堆叠上限', adMax > 0, adMax);
    bag.addItem(BAG_ITEM_KEY.adTicket, adMax);
    bag.addItem(BAG_ITEM_KEY.adTicket, 5);
    check('C8 超上限的部分真的没进去（截断在 stack_max）', bag.getCount(BAG_ITEM_KEY.adTicket), adMax);

    // 上满时**不新建空记录**
    fresh();
    bag.addItem('no_such_item_at_all', 0);
    check('C9 加 0 张不产生记录（存档里不留空记录）', bag.data.items.length, 0);

    // 顺序：按配表 sort 升序（不是加入顺序）
    fresh();
    const bySort = rawItems.slice().sort((a, b) => a.sort - b.sort).map((r) => r.key);
    for (const key of [...bySort].reverse()) bag.addItem(key, 1);
    check('C10 getOwnedKeys 按配表 sort 升序返回（与加入顺序无关）', bag.getOwnedKeys(), bySort);

    // 配表里没有的 key（改过表）：不占格子，但也不该崩
    bag.addItem('legacy_removed_item', 1);
    check('C11 配表里没有的 key 不占格子', bag.getOwnedKeys(), bySort);
    check('C11b 它也不算进容量（不然底栏会写着"多一格"）', bag.getUsedSlots(), bySort.length);
    check('C11c 但存量本身还在（不静默删玩家的东西）', bag.getCount('legacy_removed_item'), 1);
    check('C11d getOrphanKeys 报得出它（界面据此给一条告警）', bag.getOrphanKeys(), ['legacy_removed_item']);
    fresh();

    // 过期：`expire_hours` 在**入库那一刻**算成时间戳，`pruneExpired` 到期清掉
    const adCfg = BagConfig.getItem(BAG_ITEM_KEY.adTicket);
    const savedHours = adCfg.expire_hours;
    adCfg.expire_hours = 1;
    bag.addItem(BAG_ITEM_KEY.adTicket, 1);
    const expireAt = bag.getExpireAt(BAG_ITEM_KEY.adTicket);
    within('C12 expire_hours=1 → 入库时算出约 1 小时后的时间戳',
        Math.round((expireAt - Date.now()) / 1000), 3600 - 5, 3600);
    check('C12b 没过期时 pruneExpired 不动它', [bag.pruneExpired(), bag.getCount(BAG_ITEM_KEY.adTicket)], [0, 1]);
    bag.data.items.find((r) => r.key === BAG_ITEM_KEY.adTicket).expireAt = Date.now() - 1;
    check('C13 过期之后 pruneExpired 清掉它', [bag.pruneExpired(), bag.getCount(BAG_ITEM_KEY.adTicket)], [1, 0]);
    adCfg.expire_hours = savedHours;

    // 增益券：按效果分格存（不是堆一格）
    fresh();
    bag.addBoostTicket('run_start_gold', 2);
    bag.addBoostTicket('gold_gain_bonus', 1);
    check('C14 增益券按效果分格存（两种 = 两格）', bag.getUsedSlots(), 2);
    check('C14b getBoostTotalCount = 总张数', bag.getBoostTotalCount(), 3);
    check('C14c getBoostTicketCount 按 code 取', [bag.getBoostTicketCount('run_start_gold'), bag.getBoostTicketCount('gold_gain_bonus')], [2, 1]);
    const taken = bag.consumeBoostTickets();
    check('C15 consumeBoostTickets 一次全取走并清空',
        [taken.map((t) => `${t.code}x${t.count}`).join(','), bag.getBoostTotalCount()], ['run_start_goldx2,gold_gain_bonusx1', 0]);

    // 存档往返（数组字段不能被 mergeDeep 吃掉）
    fresh();
    bag.addItem(BAG_ITEM_KEY.outerDrawTicket, 2);
    bag.addBoostTicket('hero_start_level', 1);
    const snap = bag.serialize();
    bag.reset();
    check('C16 reset 之后是空的', [bag.getOwnedKeys().length], [0]);
    bag.deserialize(snap);
    check('C17 读档后存量还在（items 是数组才存得住）',
        [bag.getCount(BAG_ITEM_KEY.outerDrawTicket), bag.getBoostTicketCount('hero_start_level')], [2, 1]);

    // ────────────── D DataCenter 接线（商城的券真的进背包） ──────────────
    console.log('\nD 接线（DataCenter.grantShopItem → 背包）');
    fresh();
    dc.grantShopItem('ad_ticket');
    check('D1 商城 A6「局内广告券」→ 背包里 +1', bag.getCount(BAG_ITEM_KEY.adTicket), 1);
    dc.grantShopItem('relic_draw');
    check('D2 商城 A4「局外遗物抽取券」→ 背包里 +1', bag.getCount(BAG_ITEM_KEY.outerDrawTicket), 1);
    dc.grantShopItem('revive_ticket');
    check('D2b 商城 A5「局内复活券」→ 背包里 +1（2026-11 顶替了「开局增益券」那一格）',
        bag.getCount(BAG_ITEM_KEY.reviveTicket), 1);
    // 本局增益券（现在只剩"连续登录 ≥7 天赠送"一个产出源）也是随机一条效果 → 总数 +1 即可
    dc.playerInfo.data.loginStreak = Math.max(dc.playerInfo.data.loginStreak, MallConfig.getStreakGiftDay());
    dc.shopData.data.freeClaimedKey = '';
    dc.claimShopDailyGift();
    check('D3 每日补给·连续登录赠券 → 背包总张数 +1', bag.getBoostTotalCount(), 1);
    check('D3b 四样东西落在**四格**上（广告券 / 抽取券 / 复活券 / 增益券，不是无主的数）', bag.getUsedSlots(), 4);
    check('D3c 券跨天保留（不随商城日键清零）',
        (() => { dc.shopData.data.dailyKey = '19700101'; dc.shopData.ensurePeriod(); return bag.getBoostTotalCount(); })(), 1);

    // 背包的 key 与配表对得上（改表 key = 发出去的券找不到格子）
    const orphanKeys = bag.getOwnedKeys().filter((k) => !BagConfig.getItem(k));
    check('D4 背包里的 key 配表全认得（改 key 会让存量变成孤儿）', orphanKeys, []);

    // ────────────── E 页面 VM（判据层：真跑 BagVM） ──────────────
    console.log('\nE 页面 VM（BagVM.buildBagPageVM，真跑）');
    // 2026-11 口径：`cells` **恒铺满**（有货在前、后面补空槽），所以下面凡是要"数道具"的地方
    // 都必须先滤掉空槽 —— 直接数 `cells.length` 会得到 80 这个与道具无关的数。
    const filled = (vm) => vm.cells.filter((c) => !c.empty);
    const empties = (vm) => vm.cells.filter((c) => c.empty);

    fresh();
    const vm0 = BagVM.buildBagPageVM('');
    check('E1 空背包也铺满 80 格（空槽看得见，2026-11 口径）',
        [vm0.cells.length, empties(vm0).length], [BAG_SLOT_CAPACITY, BAG_SLOT_CAPACITY]);
    check('E1a 空槽：key 是空串 / 占位字段干净 / 一个都没被选中',
        [empties(vm0).every((c) => c.key === '' && c.name === '' && c.icon === '' && c.count === 0 && c.expireAt === 0),
            vm0.cells.some((c) => c.selected)], [true, false]);
    check('E1b 空背包：详情面板**照样显示**，画"未选中"占位态（不是整块收起，2026-11 口径）',
        [vm0.detail.empty, vm0.detail.name], [true, BagScope.BAG_NO_SELECTION_TEXT]);
    check('E1b2 未选中占位态除 name 之外全是占位值（界面按 empty 分派，不许按这些字段渲染）',
        [vm0.detail.key, vm0.detail.desc, vm0.detail.icon, vm0.detail.usable, vm0.detail.sellable],
        ['', '', '', false, false]);
    check('E1c 空背包：容量 0/80（分子数的是**道具**，不是格子）',
        [vm0.capacity.used, vm0.capacity.cap], [0, BAG_SLOT_CAPACITY]);
    check('E1d 空背包：进度条比例的分母 = 上限', vm0.capacity.cap > 0, true);
    check('E2 顶栏读数 = 数据层读数',
        [vm0.resBar.gold, vm0.resBar.heroExp],
        [dc.itemData.getCurrency(CurrencyType.Gold), dc.heroData.getSharedExp()]);

    bag.addItem(BAG_ITEM_KEY.outerDrawTicket, 2);
    bag.addItem(BAG_ITEM_KEY.adTicket, 1);
    const vm1 = BagVM.buildBagPageVM('');
    check('E3 两个道具 = 两格，且按配表 sort 升序（有货的排在最前）',
        filled(vm1).map((c) => c.key), [BAG_ITEM_KEY.adTicket, BAG_ITEM_KEY.outerDrawTicket]);
    check('E3a 有货的 2 格 + 空槽 78 格 = 恒 80 格',
        [vm1.cells.length, empties(vm1).length], [BAG_SLOT_CAPACITY, BAG_SLOT_CAPACITY - 2]);
    check('E3b 每格的数与背包一致（只看有货的格）',
        filled(vm1).map((c) => c.count), [1, 2]);
    check('E3c 没传选中时**第一格**是选中的，且选中的那一格一定有货',
        [filled(vm1).map((c) => c.selected), vm1.cells.filter((c) => c.selected).length],
        [[true, false], 1]);
    check('E3d 详情跟着选中那一格走', [vm1.detail.key, vm1.detail.empty], [BAG_ITEM_KEY.adTicket, false]);
    check('E3e 容量的分子 = 有货的格数（空槽不算）', [vm1.capacity.used, vm1.capacity.full], [2, false]);

    const vm2 = BagVM.buildBagPageVM(BAG_ITEM_KEY.outerDrawTicket);
    check('E4 传了选中就用它', [vm2.detail.key, filled(vm2).map((c) => c.selected)], [BAG_ITEM_KEY.outerDrawTicket, [false, true]]);

    // 选中回落：选中的那一格被用光之后不许再显示它
    bag.clearItem(BAG_ITEM_KEY.outerDrawTicket);
    const vm3 = BagVM.buildBagPageVM(BAG_ITEM_KEY.outerDrawTicket);
    check('E5 选中的那一格没了 → 自动回落到第一格（不显示一件"玩家已经没有"的道具）',
        [filled(vm3).map((c) => c.key), vm3.detail.key], [[BAG_ITEM_KEY.adTicket], BAG_ITEM_KEY.adTicket]);
    check('E5a 回落**不许落到空槽上**（空槽 key 是空串，按 key 回落会命中第一个空槽）',
        [vm3.cells.filter((c) => c.selected).length, vm3.cells[1].selected], [1, false]);
    // 全空 → 回落也落不到东西，详情必须是"未选中"那一态
    bag.clearItem(BAG_ITEM_KEY.adTicket);
    check('E5b 清空后详情回到"未选中"占位态（但格子还在、面板也还在）',
        [BagVM.buildBagPageVM(BAG_ITEM_KEY.outerDrawTicket).detail.empty,
            BagVM.buildBagPageVM(BAG_ITEM_KEY.outerDrawTicket).detail.name,
            empties(BagVM.buildBagPageVM('')).length],
        [true, BagScope.BAG_NO_SELECTION_TEXT, BAG_SLOT_CAPACITY]);

    // 增益券那一格的详情第二行 = 具体效果数值（不是"自动生效"那句空话）
    fresh();
    bag.addBoostTicket('run_start_gold', 1);
    const vmBoost = BagVM.buildBagPageVM('');
    const boostLine2 = (vmBoost.detail.desc || '').split('\n')[1] || '';
    check('E6 增益券详情的第二行 = achEffectLabel（带具体数值）',
        boostLine2, achEffectLabel('run_start_gold', boostVals.run_start_gold));
    truthy('E6b 那一行里真的有数字', /\d/.test(boostLine2), boostLine2);
    check('E7 两个按钮都置灰（配表 usable/sellable 全 false）',
        [vmBoost.detail.usable, vmBoost.detail.sellable, vmBoost.detail.useText, vmBoost.detail.sellText],
        [false, false, '不可使用', '不可出售']);
    check('E7b 详情正文恰好两行（设计口径是两行；`desc` 改 RESIZE_HEIGHT 后超了不裁字、但会挤掉版式）',
        (vmBoost.detail.desc || '').split('\n').length, 2);

    // 详情里的图标 / 品质与配表一致
    check('E8 详情品质 = 配表品质（格子底框色按它染）', vmBoost.detail.rarity, BagConfig.getItem(BAG_ITEM_KEY.adTicket) ? BagConfig.getItem('boost_run_start_gold').rarity : '');
    check('E8b 详情图标路径 = 配表 icon', [vmBoost.detail.icon, filled(vmBoost)[0].icon], ['textures/shop/boost_ticket', 'textures/shop/boost_ticket']);

    // 容量拉满
    fresh();
    bag.addItem('no_such_item_at_all', 0);   // 清一下（不影响）
    for (const r of rawItems) bag.addItem(r.key, 1);
    const vmFull = BagVM.buildBagPageVM('');
    check('E9 12 种道具 = 12 个**有货的**格子（其余是空槽）',
        [filled(vmFull).length, vmFull.cells.length], [rawItems.length, BAG_SLOT_CAPACITY]);
    check('E9b 有货的那 12 格里每格都是一个"格子上真的有东西"的道具',
        filled(vmFull).every((c) => c.count > 0), true);
    check('E9c 有货的格子全都排在空槽**前面**（空槽不许插在中间）',
        vmFull.cells.map((c) => c.empty), vmFull.cells.map((_, i) => i >= rawItems.length));
    check('E9d 数量拉满也不改槽位数（铺格子与"装了多少"是两件事）',
        [vmFull.capacity.used, vmFull.capacity.full], [rawItems.length, rawItems.length >= BAG_SLOT_CAPACITY]);

    // 指纹：数据一变就得变（watcher 靠它自动重刷）
    const fp0 = BagVM.bagFingerprint();
    bag.addItem(BAG_ITEM_KEY.adTicket, 1);
    const fp1 = BagVM.bagFingerprint();
    truthy('E10 页面指纹随存量变化（watcher 才会自动重刷）', fp0 !== fp1, `${fp0} → ${fp1}`);
    dc.itemData.addCurrency(CurrencyType.Gold, 1);
    truthy('E10b 金币变了指纹也变（顶栏读数要跟着动）', BagVM.bagFingerprint() !== fp1);
    // 指纹不许有副作用（它是 watcher 的订阅源）
    fresh();
    bag.addItem(BAG_ITEM_KEY.adTicket, 1);
    bag.data.items[0].expireAt = Date.now() - 1;   // 造一条已过期的
    const before = bag.data.items.length;
    BagVM.bagFingerprint();
    check('E11 指纹没有副作用（过期记录不会在 watcher 里被清掉）', bag.data.items.length, before);
    // 判据构造（buildBagPageVM）同样不许有副作用 —— 它也会被 watcher 回调间接调用
    const vmNoSide = BagVM.buildBagPageVM('');
    check('E11b buildBagPageVM 也没有副作用（清过期只落在 View_Bag.show / tickClock）',
        [bag.data.items.length, filled(vmNoSide).length], [before, 1]);
    bag.pruneExpired();
    check('E11c 显式清过期才真的清掉', bag.data.items.length, 0);

    // ────────────── F 预制件契约（界面） ──────────────
    console.log('\nF 界面契约（View_Bag.prefab / Bag_Cell.prefab）');
    // ⚠ bagPrefab / cellPrefab 在 B 段就读了（那里的框尺寸就是从它们现读的），这里直接复用。

    truthy('F1 背包预制件的根名字是 View_Bag', bagPrefab.paths.has('View_Bag'), [...bagPrefab.paths].slice(0, 3));
    truthy('F2 格子预制件的根名字是 Bag_Cell', cellPrefab.paths.has('Bag_Cell'), [...cellPrefab.paths].slice(0, 3));

    const SKIN = bagPrefab.comps('View_Bag') ?? [];
    check('F3 根节点有 BlockInputEvents（全屏页不许点穿到主界面）', SKIN.includes('cc.BlockInputEvents'), true);

    const viewPaths = grabPaths(readSrc(BAG_VIEW_SRC), 'at');
    const missing = viewPaths.filter((p) => !bagPrefab.has(p));
    check('F4 View_Bag.resolveRefs 引用的路径全部存在', missing, []);
    truthy('F4b 至少解析了 15 个节点（防止正则抓空）', viewPaths.length >= 15, viewPaths.length);

    // 格子子节点契约（BagScope.BAG_CELL_NODE）—— ⚠ `timerLabel` 住在 `timer` **底下**，不是根的直接子节点
    const cellNode = BagScope.BAG_CELL_NODE;
    const cellTopNames = cellPrefab.childNames('Bag_Cell');
    const cellMissing = ['ring', 'icon', 'count', 'timer']
        .filter((name) => !cellTopNames.includes(name));
    check('F5 格子的直接子节点名与代码契约 BAG_CELL_NODE 一致', cellMissing, []);
    check('F5b 倒计时文字在 timer 底下（契约里的 timerLabel 就是它）',
        cellPrefab.childNames('timer').includes(cellNode.timerLabel), true);
    check('F5c 契约里的五个名字都被用到了（没有写空的键）',
        [cellNode.ring, cellNode.icon, cellNode.count, cellNode.timer, cellNode.timerLabel].filter((n) => !n), []);

    // content 下必须**恰好一个** Bag_Cell 实例（模板自己当第 1 格；多留一个会被 Layout 排进网格）
    const contentChildren = bagPrefab.childNames('scroll/view/content');
    check('F6 列表容器 content 下恰好一个格子模板（多了会被 GRID Layout 排进去）', contentChildren.length, 1);
    check('F6b 那个子节点是**嵌套预制件实例**（运行时克隆的模板）',
        bagPrefab.nodes.get(bagPrefab.byPath.get('scroll/view/content'))?._children?.length, 1);

    // 详情面板 / 底栏的关键节点都得在（⚠ 2026-11 起面板多一层 `content` 容器）
    const needPaths = [
        'top_bar/btn_back', 'top_bar/title',
        'top_bar/res_bar/chip_gold/value', 'top_bar/res_bar/chip_exp/value',
        'bottom_bar/cap_title', 'bottom_bar/cap_value', 'bottom_bar/pbar/fill',
        'item_detail', 'item_detail/content',
        'item_detail/content/icon_tile', 'item_detail/content/icon_tile/icon',
        'item_detail/content/name', 'item_detail/content/desc',
        'item_detail/content/btn_use/label', 'item_detail/content/btn_sell/label',
    ];
    check('F7 详情面板 / 底栏 / 顶栏的关键节点全部存在', needPaths.filter((p) => !bagPrefab.has(p)), []);

    // 两个按钮必须是 Button（不然点击根本接不上）
    check('F8「使用」「出售」都是 Button',
        [(bagPrefab.comps('item_detail/content/btn_use') ?? []).includes('cc.Button'),
            (bagPrefab.comps('item_detail/content/btn_sell') ?? []).includes('cc.Button')], [true, true]);
    // 扩容按钮按决策**保持收起**（本轮没有第二档容量）
    const expandNode = bagPrefab.nodes.get(bagPrefab.byPath.get('bottom_bar/btn_expand'));
    check('F9 扩容按钮存在且静置为收起（active = false）', expandNode?._active, false);

    // 详情面板是可染的白底圆角九宫格（"不可用"那两态色才染得上去）
    const useSprite = (bagPrefab.nodes.get(bagPrefab.byPath.get('item_detail/content/btn_use'))?._components ?? [])
        .map((c) => bagPrefab.data[c.__id__]).find((c) => c && c.__type__ === 'cc.Sprite');
    truthy('F10「使用」按钮有 Sprite 可以做两态色', !!useSprite, useSprite);
    const sellRing = (bagPrefab.nodes.get(bagPrefab.byPath.get('item_detail/content/btn_sell/ring'))?._components ?? [])
        .map((c) => bagPrefab.data[c.__id__]).find((c) => c && c.__type__ === 'cc.Sprite');
    truthy('F10b「出售」的环是烤色的（代码里不许染它，见 View_Bag.SELL_ON_TEXT）', !!sellRing, sellRing);

    // 打包口径：预制件必须在 resources 下（`UIManager.showUI` 走 resources.load）
    truthy('F11 预制件在 assets/resources 下（UIManager 用 resources.load 取它）',
        BAG_PREFAB.startsWith('assets/resources/'), BAG_PREFAB);
    const viewSrcText = readSrc(BAG_VIEW_SRC);
    truthy('F12 @uiview 的 prefabPath 与预制件真实位置一致',
        viewSrcText.includes("prefabPath: 'prefabs/ui/views/bag/View_Bag'"), true);
    truthy('F12b layer = View（全屏页，不是弹窗层）', viewSrcText.includes('ViewLayer[ViewLayer.View]'), true);

    // ── 空位（空槽 / 未选中）的渲染口径（2026-11）──
    // 颜色是**运行期写**的（`BagItem.setInfo` / `View_Bag.applyDetail`），`npm run audit:ui` 扫预制件扫不到它，
    // 所以在这里对 tokens 表兜一条：空位底色必须是色板里的一档、且**不许**借用品质色。
    const tokens = JSON.parse(readSrc('docs/art-style/tokens.json'));
    const tokenHexes = tokens.palette.flatMap((g) => g.tokens.map((t) => t.hex.toUpperCase()));
    const qualityHexes = tokens.quality.map((q) => q.hex.toUpperCase());
    const itemSrc = readSrc(BAG_ITEM_SRC);
    const emptyHex = BagScope.BAG_EMPTY_FRAME;
    truthy('F13 空位底色写在 BagScope.BAG_EMPTY_FRAME 里（体检能认出来）', !!emptyHex, emptyHex);
    truthy(`F13b 空位底色 ${emptyHex} 来自 tokens.json 的色板`, tokenHexes.includes(String(emptyHex).toUpperCase()),
        { emptyHex, tokenHexes });
    truthy('F13c 空位底色**不是**品质色（否则空槽看起来就是"一件白档道具"）',
        !qualityHexes.includes(String(emptyHex).toUpperCase()), qualityHexes);
    check('F14 有货 / 空槽在**同一处**分派（灰底与品质色不许各写一份）',
        /this\.isEmpty \? BAG_EMPTY_FRAME : rarityColor\(vm\.rarity\)/.test(itemSrc), true);
    check('F14b 空槽点了不冒泡（onClick 先拦空槽，否则详情面板会"选中一个不存在的道具"）',
        /if \(this\.isEmpty \|\| !this\.itemKey\) return;/.test(itemSrc), true);
    check('F14c 空槽把图标 / 数量 / 选中环全部收起（三处都得带 isEmpty 判据）',
        ['this.icon.node.active = !this.isEmpty',
            'const show = !this.isEmpty && vm.count >= COUNT_VISIBLE_FROM',
            'this.ring.node.active = !this.isEmpty && vm.selected']
            .filter((s) => !itemSrc.includes(s)), []);
    truthy('F15 界面**不许自己补格子**（槽位数是判据：`BAG_SLOT_CAPACITY` 只该出现在 BagConfig / BagVM）',
        !viewSrcText.includes('BAG_SLOT_CAPACITY'), true);

    // ── 预制件上**拖的引用**（2026-11 新增）──
    // ⚠ 这段是被真事故逼出来的：`resolveRefs` 用 `??` 兜底，**只认"空引用"、拦不住"拖错了"**——
    //   2026-11 用户给 `item_detail` 加了一层 `content` 之后：
    //     · `detailNode` 指到了 `item_detail/content`（面板的**子节点**，不是面板）；
    //     · `capFillNode` 指到了 `bottom_bar/pbar`（**轨道**，不是填充条）—— 那是**早就**拖错的，
    //       后果是"改的是轨道宽度、填充条纹丝不动"，界面上只是"进度条看着怪"，没人会去查。
    //   两张表对一遍就能全抓到：**字段 → 它应该指向哪个路径**（路径口径与代码里的 `at()` 完全一致）。
    const REF_EXPECT = {
        backBtn: 'top_bar/btn_back',
        resGoldLabel: 'top_bar/res_bar/chip_gold/value',
        resExpLabel: 'top_bar/res_bar/chip_exp/value',
        capValueLabel: 'bottom_bar/cap_value',
        capFillNode: 'bottom_bar/pbar/fill',
        contentNode: 'scroll/view/content',
        detailNode: 'item_detail',
        detailTile: 'item_detail/content/icon_tile',
        detailIcon: 'item_detail/content/icon_tile/icon',
        detailNameLabel: 'item_detail/content/name',
        detailDescLabel: 'item_detail/content/desc',
        useBtn: 'item_detail/content/btn_use',
        useLabel: 'item_detail/content/btn_use/label',
        sellBtn: 'item_detail/content/btn_sell',
        sellLabel: 'item_detail/content/btn_sell/label',
    };
    const viewScript = bagPrefab.scriptOn('View_Bag');
    truthy('F16 预制件里挂着 View_Bag 这颗脚本（体检读的是它上面拖的引用）', !!viewScript,
        Object.keys(viewScript ?? {}));
    const refBad = [];
    for (const [field, want] of Object.entries(REF_EXPECT)) {
        const ref = viewScript?.[field];
        if (!ref) { refBad.push(`${field}: 没拖`); continue; }
        const got = bagPrefab.refPath(ref);
        if (got !== want) refBad.push(`${field}: ${got} ≠ ${want}`);
    }
    check(`F16b 预制件上拖的 ${Object.keys(REF_EXPECT).length} 个引用都指向正确的节点（\`??\` 兜底拦不住"拖错"）`,
        refBad, []);

    // 兜底路径与拖的引用必须是同一批 —— 否则"编辑器里能用、不拖就废"，两种走法迟早分叉
    const atPaths = grabPaths(viewSrcText, 'at').filter((p) => p !== 'bottom_bar/btn_expand');
    check('F16c 代码里 `at()` 的兜底路径 == F16b 的期望表（一处改了另一处没改会当场爆）',
        atPaths.slice().sort(), Object.values(REF_EXPECT).slice().sort());

    // ── 详情面板的**两态**（2026-11 用户改版后的新口径）──
    // ① 面板**恒显示**：代码里不许再出现"按有没有选中去切面板的 active"（那会把面板整块藏掉）
    truthy('F17 详情面板恒显示（`View_Bag` 里不许再切 `detailNode` 的 active）',
        !/detailNode\s*\.\s*active/.test(viewSrcText), true);
    // ② 两态由 `vm.detail.empty` **一处分派**，未选中时四处全收起 + 底框走空位色 + 名字取自 VM
    check('F17b 未选中态把 icon / 正文 / 两个按钮全收起（不收起 = 面板上留着上一件道具）',
        ['if (iconNode) iconNode.active = false',
            'if (descNode) descNode.active = false',
            'if (useNode) useNode.active = false',
            'if (sellNode) sellNode.active = false']
            .filter((s) => !viewSrcText.includes(s)), []);
    check('F17c 未选中态的底框用的是**空位色常量**（与格子空槽同一个，不许自己写死一个灰）',
        /if \(d\.empty\) \{[\s\S]{0,200}fromHEX\(BAG_EMPTY_FRAME\)/.test(viewSrcText), true);
    // ③ 未选中态的名字取自 VM；「未选中」这份文案**只有一处定义**（BagScope 的常量）。
    //    ⚠ 判据只认**字符串字面量**（`= '未选中'`）—— 注释里写"未选中态"当然可以，
    //      真正要拦的是"界面自己写死一句文案"（那种地方改措辞时永远漏一处）。
    const noSel = BagScope.BAG_NO_SELECTION_TEXT;
    truthy('F17d 未选中态的名字取自 VM（`this.detailNameLabel.string = d.name`）',
        viewSrcText.includes('this.detailNameLabel.string = d.name'),
        `${noSel}: ${BagVM.buildBagPageVM('').detail.name}`);
    truthy(`F17d2 界面没把「${noSel}」写死到 Label 上（不许出现 \`.string = '${noSel}'\`）`,
        !new RegExp(`\\.string\\s*=\\s*['"]${noSel}['"]`).test(viewSrcText), true);
    const literalRe = new RegExp(`=\\s*['"]${noSel}['"]`, 'g');
    check(`F17e「${noSel}」作为**字符串字面量**只有一处定义（界面 / VM 里都不许再写一份）`,
        [BAG_VIEW_SRC, BAG_VM_SRC, BAG_ITEM_SRC, BAG_SCOPE_SRC]
            .map((f) => [f, (readSrc(f).match(literalRe) ?? []).length])
            .filter(([, n]) => n > 0).map(([f, n]) => `${f}(${n})`),
        [`${BAG_SCOPE_SRC}(1)`]);

    // ── 详情面板的结构与代码契约（`content` 容器 / 排版方式 / 框的溢出模式）──
    const detailChildren = bagPrefab.childNames('item_detail/content');
    check('F18 面板容器 content 下恰好 5 个子节点、名字与契约一致',
        detailChildren, ['icon_tile', 'name', 'desc', 'btn_use', 'btn_sell']);
    const contentLayout2 = bagPrefab.compObjs('item_detail/content').find((c) => c.__type__ === 'cc.Layout');
    truthy('F18b content 是 VERTICAL Layout（两态里会有节点藏起来，位置必须由 Layout 排、不许手摆）',
        contentLayout2?._layoutType === 2, { layoutType: contentLayout2?._layoutType });
    truthy('F18c 面板根上挂着 ScrollView（正文写长了靠它滚，见 docs/bag/README.md §2）',
        (bagPrefab.comps('item_detail') ?? []).includes('cc.ScrollView'), bagPrefab.comps('item_detail'));
    truthy('F18d content 是那个 ScrollView 的 content', (() => {
        const sv = bagPrefab.compObjs('item_detail').find((c) => c.__type__ === 'cc.ScrollView');
        return sv?._content?.__id__ === bagPrefab.byPath.get('item_detail/content');
    })(), 'item_detail/content');

    // ────────────── G 入口与互斥（Scene_Menu） ──────────────
    console.log('\nG 入口与互斥（Scene_Menu）');
    const menuPrefab = readPrefab(MENU_PREFAB);
    const menuSrc = readSrc(MENU_SRC);

    truthy('G1 底部背包页签的路径写死在 Scene_Menu.ts 里', menuSrc.includes("'bottom/left/bag'"), true);
    truthy('G1b 那个节点真存在（bottom/left/bag）', menuPrefab.has('bottom/left/bag'), true);
    truthy('G2 Scene_Menu 里把背包页签接上了点击', menuSrc.includes('onClickBag'), true);

    // `bagBtn` 的 @property 在预制件里必须真的指向 bottom/left/bag（拖丢了就只有兜底路径）
    const menuScript = menuPrefab.data.find((o) => o && o.__type__ === 'ea838//HYxIW5sqNGHOpFHx');
    truthy('G3 预制件里 Scene_Menu 脚本的 bagBtn 已拖引用', !!menuScript?.bagBtn, menuScript?.bagBtn);
    if (menuScript?.bagBtn) {
        const bagNode = menuPrefab.nodes.get(menuScript.bagBtn.__id__);
        check('G3b bagBtn 指向的正是 bottom/left/bag', [bagNode?._name, menuPrefab.nodes.get(bagNode?._parent?.__id__)?._name], ['bag', 'left']);
    }

    const bagTabPaths = grabPaths(menuSrc, 'getChildByPath');
    check('G4 Scene_Menu 里 byPath 解析的入口路径全部存在（含背包页签）',
        bagTabPaths.filter((p) => !menuPrefab.has(p)), []);

    // 三个全屏页互斥：三个视图类都得在 VIEW_PAGES 里，且 **不许** 把背包页当成场景内嵌节点
    for (const name of ['View_Bag', 'View_Shop', 'View_TaskUI']) {
        truthy(`G5 ${name} 在 VIEW_PAGES 互斥表里`, menuSrc.includes(`'${name}'`), name);
    }
    truthy('G6 开背包前会收起两个场景内嵌弹窗（互斥）',
        /onClickBag[\s\S]{0,400}closeDifficultyPanel\(\)[\s\S]{0,200}closeHeroDetail\(\)/.test(menuSrc), true);
    truthy('G6b 开商城/任务前会收起背包页（否则两个全屏页叠在一起，返回键被盖住）',
        (menuSrc.match(/closeViewPages\('View_(Shop|TaskUI)'\)/g) ?? []).length, true);

    // 背包页自己不认 UIManager 之外的宿主：返回必须自关
    truthy('G7 返回自关（views 形态，宿主不用管）', viewSrcText.includes('UIManager.ins.closeUI(View_Bag)'), true);

    // ── 收尾 ──
    console.log(`\n${failures.length ? '✘' : '✔'} 背包体检：${passed} 条通过，${failures.length} 条失败`);
    if (failures.length) {
        console.log('\n失败明细：');
        for (const f of failures) console.log(`  · ${f}`);
        process.exit(1);
    }
};

main();
