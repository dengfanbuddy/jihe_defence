#!/usr/bin/env node
/**
 * verify-achievements.mjs — 成就系统「配表 + 容器 + 门面 + 数据模块」端到端体检（真跑源码 + 真配表）
 *
 * 为什么需要它：成就配表是**一行一档**的结构化表，格式对不代表结构对 ——
 * 「中间档偷偷带了 effect_code」「某档 count 没递增」「同一效果挂了两个来源」
 * 这三类错误都能通过导表工具（它只校验字段类型/枚举），却会在运行时静默出问题
 * （效果被忽略 / 一进游戏就完成 / 效果叠加把经济打崩）。
 * 所以本脚本把**真容器**跑起来（真读 `assets/resources/tb/achievements.json`），
 * 断言它的 `afterHandle` 一条警告都不产生，并且**验证门禁本身会失败**（负例）。
 *
 * 覆盖（A 结构 / B 门禁 / C 门禁负例 / D 真容器+门面 / E 设计区间 / F 真跑数据模块）：
 *   A 表结构：75 行 / 25 组 / 每组 3 档且 tier 连续 / id 唯一且与分类段位一致 / 词表合法
 *   B 门禁：容器零警告；效果只在末档；每个 effect_code 恰好 1 个来源；
 *           effect_value ≤ 封顶；count 与 reward_gold 严格递增；隐藏成就只在挑战类
 *   C 负例：中间档挂效果 / count 不递增 / 档位有洞 —— 三种都必须报警
 *   D 真容器与门面：getGroups / getByCategory / getGroup / getMaxTier /
 *                   getCategories / getTargetMode / formatGold / getProgressText / achEffectLabel
 *   E 设计区间：铜 200~500 / 银 800~2000 / 金 4000~8000；金币总量量级 15~25 万
 *   F 真跑数据模块（**= 设计稿 `docs/成就系统设计.md` §11 所称的「B 组（真跑数据模块）」**）：
 *     领奖不重复发 / 多档累积不被 `claimedTier` 卡住 / 效果求和与按 `cap` 封顶 /
 *     峰值只增不减 / 进度模式用错被忽略 —— 这几条配表验不出来，只有把
 *     `AchievementDataModule` 真跑起来才暴露。
 *     （§11 的第四条「初始金币真播种到 `hero.gold`」**故意不做**，见 F 段末尾的说明。）
 *
 * 用法：node tools/achievement-audit/verify-achievements.mjs   （违规退出码 1）
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

/**
 * 需要真跑的源码（相对 assets/scripts/game）。
 * F 段（真跑数据模块）要把 `data/funcs/AchievementData.ts` 拉起来，于是它的依赖整条链也得真跑：
 *   · `data/DataModule.ts`（响应式数据基类 + localStorage 自动保存）
 *   · `data/StorageUtil.ts`（localStorage 封装，只有一个全局 `localStorage` 需要打桩）
 *   · `platform/reactivity/**`（**纯 TS、不 import `cc`**，所以能整目录真跑，不用桩）
 * 与 `audit:attr` / `audit:skill` 同一手法：transpileModule → CJS → require，只桩真正碰外部环境的那几处。
 */
const SOURCES = [
    'excel_table/Tb_AchievementConfig.ts',
    'data/configs/AchievementConfig.ts',
    'common/AchievementEffectMeta.ts',
    // `AchievementConfig.formatGold` 现在转发到这份共用实现（英雄页的价格也用同一份缩写口径）
    'common/GoldText.ts',
    // 平台层：容器基类（handleData / size）与装饰器（注册契约）也真跑
    '../platform/excel_table/TbContainer.ts',
    '../platform/excel_table/TbConfigDecorator.ts',
    '../platform/log/LogMgr.ts',
    // 数据模块链路（F 段用）
    'data/DataModule.ts',
    'data/StorageUtil.ts',
    'data/funcs/AchievementData.ts',
    // 响应式框架（DataModule 的依赖；整目录真跑，无 cc 依赖）
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

const readTb = (name) => JSON.parse(fs.readFileSync(path.join(TB_DIR, `${name}.json`), 'utf8'));

/**
 * 打桩：只桩掉**必须**桩的两处（它们直接 import `cc`），且**忠实复刻契约**：
 *   · TbRoot：按 `registerContainerConfig(cls, bundle, path)` 记账，
 *     `getTbContainer(cls)` 首次访问时按 `bundle:path` **真读** `assets/resources/<bundle>/<path>.json`
 *     并调 `handleData()` —— 与真管线（`:tb/achievements` → resources bundle）同一路径口径。
 *     `_useData` / `_clearData` 是本脚本自用的口子：把某个容器的数据换成**篡改版**再重新装载，
 *     用来把真表下不可达的分支（同 effect_code 多来源 → 求和 > cap）逼出来。真工程不会调它们。
 */
const STUBS = {
    'platform/excel_table/TbRoot.js': `
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const registry = [];
class TbRootStub {
    registerContainerConfig(cls, bundle, p) { registry.push({ cls, bundle, path: p, inst: null, data: null }); }
    getTbContainer(cls) {
        const rec = registry.find((r) => r.cls === cls);
        if (!rec) throw new Error('容器未注册：' + (cls && cls.name));
        if (!rec.inst) {
            const file = path.join(ROOT, 'assets', rec.bundle, rec.path + '.json');
            const data = rec.data ?? JSON.parse(fs.readFileSync(file, 'utf8'));
            rec.inst = new rec.cls();
            rec.inst.handleData(data);
        }
        return rec.inst;
    }
    /** 体检用：清掉已建实例（配合负例重新装载） */
    _reset() { for (const r of registry) r.inst = null; }
    /** 体检用：下次 getTbContainer 改读这份（篡改版）数据 */
    _useData(cls, data) {
        const rec = registry.find((r) => r.cls === cls);
        if (!rec) throw new Error('容器未注册：' + (cls && cls.name));
        rec.inst = null;
        rec.data = data;
    }
    /** 体检用：恢复成真读 assets/resources 下的 JSON */
    _clearData(cls) {
        const rec = registry.find((r) => r.cls === cls);
        if (!rec) return;
        rec.inst = null;
        rec.data = null;
    }
}
exports.TbRoot = { ins: new TbRootStub() };
`,
};

const require = createRequire(import.meta.url);
function resolveTypeScript() {
    for (const p of [path.join(ROOT, 'node_modules/typescript'), path.join(ROOT, 'tools/excel_export/node_modules/typescript')]) {
        if (fs.existsSync(p)) return require(p);
    }
    console.error('✘ 找不到 typescript');
    process.exit(2);
}
const ts = resolveTypeScript();

function build() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jihe-achieve-'));
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
        /** 打桩后的 TbRoot（= 真管线里的容器注册表） */
        tbRoot: require(path.join(out, 'assets/scripts/platform/excel_table/TbRoot.js')).TbRoot,
    };
}

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
/** 区间断言（数值调优不应打断体检，量级错了才拦） */
function within(label, v, lo, hi) {
    if (typeof v === 'number' && v >= lo && v <= hi) ok(label);
    else bad(label, v, `${lo} ~ ${hi}`);
}

/** 捕获 console.warn（容器的门禁就是靠它报的） */
function captureWarnings(fn) {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try { fn(); } finally { console.warn = orig; }
    return warnings;
}

const CATEGORY_SEGMENT = { level: 31, stage: 32, combat: 33, economy: 34, collect: 35, challenge: 36 };
const CATEGORY_TOTAL = { level: 4, stage: 4, combat: 5, economy: 4, collect: 4, challenge: 4 };

const main = () => {
    const raw = readTb('achievements');
    const { mod, tbRoot } = build();
    const { AchievementCfgContainer } = mod('excel_table', 'Tb_AchievementConfig.js');
    const AchieveConfig = mod('data', 'configs', 'AchievementConfig.js');
    const { AchievementConfig } = AchieveConfig;
    const meta = mod('common', 'AchievementEffectMeta.js');
    const { ACH_EFFECT_META, ACH_EFFECT_CODES, achEffectLabel } = meta;
    const { ACH_CATEGORY_ORDER } = AchieveConfig;

    // ────────────── A 表结构 ──────────────
    console.log('\nA 表结构');
    check('A1 配表 75 行（25 条 × 3 档）', raw.length, 75);

    const byGroup = new Map();
    for (const r of raw) {
        if (!byGroup.has(r.group)) byGroup.set(r.group, []);
        byGroup.get(r.group).push(r);
    }
    check('A2 恰好 25 条成就（group 数）', byGroup.size, 25);

    const ids = raw.map((r) => r.id);
    check('A3 id 全局唯一', new Set(ids).size, raw.length);

    const tierBad = [...byGroup.entries()].filter(([, rows]) => {
        const ts = rows.map((r) => r.tier).sort((a, b) => a - b);
        return JSON.stringify(ts) !== JSON.stringify([1, 2, 3]);
    }).map(([g]) => g);
    check('A4 每组恰好 3 档且 tier = 1/2/3', tierBad, []);

    const catBad = raw.filter((r) => !(r.category in CATEGORY_SEGMENT));
    check('A5 category 全部合法', catBad.map((r) => r.category), []);

    const segBad = raw.filter((r) => Math.floor(r.id / 100) !== CATEGORY_SEGMENT[r.category]);
    check('A6 id 段位与分类一致（31xx 等级 … 36xx 挑战）', segBad.map((r) => `${r.id}/${r.category}`), []);

    const targetBad = raw.filter((r) => !(r.target in AchieveConfig.ACH_TARGET_MODE));
    check('A7 target 全部在词表内（防拼写错）', targetBad.map((r) => r.target), []);

    const effectBad = raw.filter((r) => r.effect_code && !(r.effect_code in ACH_EFFECT_META));
    check('A8 effect_code 全部在白名单内', effectBad.map((r) => r.effect_code), []);

    const reqBad = raw.filter((r) => !r.name || !r.desc || !r.target || !(r.count > 0) || !(r.reward_gold > 0));
    check('A9 name/desc/target/count/reward_gold 齐备且为正', reqBad.map((r) => r.id), []);

    const silentBad = raw.filter((r) => (r.silent ?? 0) === 1 && r.category !== 'challenge');
    check('A10 隐藏成就（silent=1）只出现在挑战类', silentBad.map((r) => `${r.id}/${r.category}`), []);

    // ────────────── B 门禁（容器零警告 + 与 JSON 对账） ──────────────
    console.log('\nB 门禁');
    let container = null;
    const containerWarnings = captureWarnings(() => { container = tbRoot.ins.getTbContainer(AchievementCfgContainer); });
    check('B1 容器装载零警告（门禁全过）', containerWarnings.length, 0);
    if (containerWarnings.length) containerWarnings.forEach((w) => console.log(`      ⚠ ${w}`));

    const midEffect = raw.filter((r) => r.effect_code && r.tier !== 3);
    check('B2 没有任何效果挂在非末档', midEffect.map((r) => `${r.group}#${r.tier}`), []);

    const effectCount = {};
    for (const r of raw) if (r.effect_code) effectCount[r.effect_code] = (effectCount[r.effect_code] ?? 0) + 1;
    const multi = Object.entries(effectCount).filter(([, n]) => n !== 1);
    check('B3 每个 effect_code 恰好 1 个来源（不叠加）', multi, []);
    check('B4 效果总数 = 10', Object.keys(effectCount).length, 10);
    check('B4b 10 条效果全部有成就来源（无死效果）',
        ACH_EFFECT_CODES.filter((c) => !(c in effectCount)), []);

    const capBad = raw.filter((r) => r.effect_code && !(r.effect_value <= ACH_EFFECT_META[r.effect_code].cap));
    check('B5 effect_value 未超封顶', capBad.map((r) => `${r.effect_code}=${r.effect_value}`), []);

    const monoBad = [];
    for (const [g, rows] of byGroup) {
        const sorted = rows.slice().sort((a, b) => a.tier - b.tier);
        for (let i = 1; i < sorted.length; i++) {
            if (!(sorted[i].count > sorted[i - 1].count)) monoBad.push(`${g} count`);
            if (!(sorted[i].reward_gold > sorted[i - 1].reward_gold)) monoBad.push(`${g} gold`);
        }
    }
    check('B6 count 与 reward_gold 组内严格递增', monoBad, []);

    // ────────────── C 门禁负例（门禁必须真的会拦） ──────────────
    console.log('\nC 门禁负例（把坏数据喂给真容器，必须报警）');
    const runMutant = (mutate, label) => {
        const data = JSON.parse(JSON.stringify(raw));
        mutate(data);
        const c = new AchievementCfgContainer();
        const w = captureWarnings(() => c.handleData(data));
        truthy(label, w.length > 0, '没有产生任何警告（门禁失效）');
    };
    runMutant((d) => { const r = d.find((x) => x.group === 'st_clear' && x.tier === 1); r.effect_code = 'run_start_gold'; r.effect_value = 50; },
        'C1 中间档挂 effect_code → 报警');
    runMutant((d) => { const r = d.find((x) => x.group === 'st_clear' && x.tier === 2); r.count = 1; },
        'C2 count 不递增 → 报警');
    runMutant((d) => { const i = d.findIndex((x) => x.group === 'st_clear' && x.tier === 2); d.splice(i, 1); },
        'C3 档位有洞（缺 tier2）→ 报警');

    // ────────────── D 真容器 + 门面 ──────────────
    console.log('\nD 真容器与门面');
    check('D1 容器 size = 75', container.size, 75);
    const groups = AchievementConfig.getAll();
    check('D2 门面 getAll() = 25 条', groups.length, 25);
    check('D3 门面 isReady()', AchievementConfig.isReady(), true);

    const perCat = {};
    for (const c of ACH_CATEGORY_ORDER) perCat[c] = AchievementConfig.getByCategory(c).length;
    check('D4 各分类条数 4/4/5/4/4/4', perCat, CATEGORY_TOTAL);

    const cats = AchievementConfig.getCategories();
    check('D5 分类条 6 项且中文名正确', cats.map((c) => `${c.code}:${c.name}`),
        ['level:等级', 'stage:闯关', 'combat:战斗', 'economy:经济', 'collect:收集', 'challenge:挑战']);

    const stClear = AchievementConfig.getGroup('st_clear');
    check('D6 st_clear 归并正确', [stClear.maxTier, stClear.tiers.map((t) => t.tier), stClear.effect.code, stClear.effect.value],
        [3, [1, 2, 3], 'run_start_gold', 50]);
    check('D7 无效果的末档 effect = null', AchievementConfig.getGroup('st_speed').effect, null);
    check('D8 隐藏成就标记正确', AchievementConfig.getGroup('ch_norelic').silent, true);
    check('D8b 非隐藏成就标记正确', AchievementConfig.getGroup('st_clear').silent, false);

    check('D9 进度模式 max（单局峰值类）', [
        AchievementConfig.getTargetMode('stage_reached'),
        AchievementConfig.getTargetMode('hero_level'),
        AchievementConfig.getTargetMode('kill_in_run'),
        AchievementConfig.getTargetMode('gold_in_run'),
        AchievementConfig.getTargetMode('survive_time'),
        AchievementConfig.getTargetMode('relic_collected'),
        AchievementConfig.getTargetMode('login_streak'),
    ], ['max', 'max', 'max', 'max', 'max', 'max', 'max']);
    check('D10 进度模式 add / flag', [
        AchievementConfig.getTargetMode('victory'),
        AchievementConfig.getTargetMode('kill_enemies'),
        AchievementConfig.getTargetMode('damage_dealt'),
        AchievementConfig.getTargetMode('login'),
    ], ['add', 'add', 'add', 'flag']);

    check('D11 金币缩写口径', [
        AchievementConfig.formatGold(850), AchievementConfig.formatGold(1000),
        AchievementConfig.formatGold(1200), AchievementConfig.formatGold(10000),
        AchievementConfig.formatGold(185650),
    ], ['850', '1k', '1.2k', '1万', '18.6万']);

    const tier1 = AchievementConfig.getTierCfg('st_clear', 1);
    check('D12 进度文案按目标钳制', AchievementConfig.getProgressText(tier1, 999), '1/1');
    check('D13 未达标进度文案', AchievementConfig.getProgressText(AchievementConfig.getTierCfg('st_clear', 3), 12), '12/50');

    check('D14 效果展示文本（加成类带 +）', achEffectLabel('run_start_gold', 50), '局内初始金币 +50');
    check('D15 效果展示文本（折扣类带 -）', achEffectLabel('shop_draw_discount', 10), '肉鸽抽取费用 -10%');
    check('D16 效果展示文本（件/级/次）', [
        achEffectLabel('relic_start_gift', 1), achEffectLabel('hero_start_level', 1), achEffectLabel('hero_select_free', 1),
    ], ['开局赠遗物 +1件', '开局英雄等级 +1级', '选人免费刷新 +1次']);

    // ────────────── E 设计区间 ──────────────
    console.log('\nE 设计区间（数值调优不该打断体检，量级错了才拦）');
    const band = { 1: [200, 500], 2: [800, 2000], 3: [4000, 8000] };
    const bandBad = raw.filter((r) => r.reward_gold < band[r.tier][0] || r.reward_gold > band[r.tier][1]);
    check('E1 金币梯度落在设计区间（铜 200~500 / 银 800~2000 / 金 4000~8000）',
        bandBad.map((r) => `${r.group}#${r.tier}=${r.reward_gold}`), []);

    const totalGold = raw.reduce((s, r) => s + r.reward_gold, 0);
    within('E2 金币总投放量级（15~25 万）', totalGold, 150000, 250000);

    const goldByCat = {};
    for (const r of raw) goldByCat[r.category] = (goldByCat[r.category] ?? 0) + r.reward_gold;
    console.log(`  ℹ 金币小计：${Object.entries(goldByCat).map(([c, v]) => `${c} ${v}`).join(' / ')}`);
    console.log(`  ℹ 金币总计：${totalGold}`);
    console.log(`  ℹ 效果：${Object.entries(effectCount).map(([c, n]) => `${c}×${n}`).join(' / ')}`);

    // ────────────── F 真跑数据模块（设计稿 §11 所称的「B 组」） ──────────────
    // 这一段回答的是配表层**答不了**的问题：领奖会不会双发 / 领完铜档后银档还涨不涨 /
    // 效果怎么求和怎么封顶。做法与 audit:attr / audit:skill 一致 ——
    // 把真 `AchievementDataModule`（连同 `DataModule` + `platform/reactivity`）编起来真跑，
    // 只桩掉一个全局 `localStorage`（它本来就不是这套逻辑的一部分）。
    console.log('\nF 真跑数据模块（AchievementDataModule + 真配表；= 设计稿 §11 的「B 组」）');
    // 说明：下面夹在断言之间的 `[成就] 领取…` 行不是本脚本打的，是**真模块自己的日志**
    //（`AchievementData.claim()` 里那条 console.log）—— 看到它就说明真的跑在真代码上。
    console.log('  ℹ 中间那些 `[成就] 领取…` 是真模块自己打的日志（证明跑的是真代码）');

    // 最小打桩：`StorageUtil` 只用到 get/set/remove，且读写都包在 try 里。
    // 用内存 Map 忠实复刻「存进去能读回来」的契约（别只返回 null —— 那样连读档路径都测不到）。
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };

    const { AchievementDataModule } = mod('data', 'funcs', 'AchievementData.js');

    /** 宿主打桩（`DataCenter` 的替身）：把发奖逐笔记下来，好断言「只发一次 / 金额对不对」 */
    const paid = [];
    const host = {
        getAccountLevel: () => 1,
        getLoginStreak: () => 1,
        getRelicKinds: () => 0,
        grantReward: (gold, group) => { paid.push({ gold, group }); },
    };

    /** 造一个干净的模块（每小节互不污染；真 new 真构造函数，走真读档 + 真自动保存） */
    const newModule = () => { const m = new AchievementDataModule(); m.setHost(host); return m; };

    /** 取**原始进度**（绕开界面那层「钳到下一档目标」的显示逻辑） */
    const rawProgress = (m, group) => m.data.records.find((r) => r.group === group)?.progress ?? 0;

    /** 效果表按 code 排序后比较（`getEffects()` 的键顺序不该成为断言的一部分） */
    const effPairs = (o) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    /** 把一条成就的三档全领掉（进度一次顶到末档目标；按 target 模式走对应的上报口） */
    const claimAllTiers = (m, group) => {
        const g = AchievementConfig.getGroup(group);
        const last = g.tiers[g.tiers.length - 1];
        if (AchievementConfig.getTargetMode(g.target) === 'max') m.peakProgress(g.target, last.count);
        else m.addProgress(g.target, last.count);
        for (let i = 0; i < g.maxTier; i++) m.claim(group);
        return m;
    };

    // ——— F·1 领奖不重复发 + 多档累积不被 claimedTier 卡住 ———
    // 用真成就 `st_clear`（胜利 1/10/50 次）：铜档目标 1 次，最容易把「连点双发」逼出来。
    {
        paid.length = 0;
        const d = newModule();
        const [t1, t2, t3] = [1, 2, 3].map((t) => AchievementConfig.getTierCfg('st_clear', t));

        d.addProgress('victory', t1.count);
        check('F1 进度到铜档目标 → state=claimable', d.getGroupState('st_clear').state, 'claimable');

        const r1 = d.claim('st_clear');
        check('F2 第一次 claim 领到铜档', [r1.ok, r1.tier, r1.gold], [true, 1, t1.reward_gold]);

        const r2 = d.claim('st_clear');
        check('F3 同一条连点第二次必须失败（ok=false）', [r2.ok, r2.reason], [false, 'unfinished']);
        check('F4 claimedTier 只前进一档', d.getGroupState('st_clear').claimedTier, 1);
        check('F5 金币只发一次（宿主实收 1 笔 = 铜档金额）',
            [paid.length, paid.reduce((s, p) => s + p.gold, 0)], [1, t1.reward_gold]);

        // 口径差别就这一条：任务是 `claimed: boolean`（领完不再累积），成就必须能滚到下一档。
        d.addProgress('victory', t2.count - t1.count);
        check('F6 领掉铜档后继续 addProgress → 银档仍能到 claimable（不被 claimedTier 卡住）',
            [d.getGroupState('st_clear').state, d.getProgress('st_clear')], ['claimable', t2.count]);

        const r3 = d.claim('st_clear');
        check('F7 银档可领并领到', [r3.ok, r3.tier, r3.gold], [true, 2, t2.reward_gold]);
        const r4 = d.claim('st_clear');
        check('F8 银档领完再点仍失败（不重复发）', [r4.ok, r4.reason], [false, 'unfinished']);
        check('F9 累计金币 = 铜 + 银 各一次',
            [paid.length, paid.reduce((s, p) => s + p.gold, 0)], [2, t1.reward_gold + t2.reward_gold]);

        d.addProgress('victory', t3.count);
        check('F10 金档可领', d.getGroupState('st_clear').state, 'claimable');
        const r5 = d.claim('st_clear');
        check('F11 领完金档 → state=done', [r5.ok, r5.tier, d.getGroupState('st_clear').state], [true, 3, 'done']);
        const r6 = d.claim('st_clear');
        check('F12 领完再点 ok=false / reason=claimed', [r6.ok, r6.reason], [false, 'claimed']);
        d.addProgress('victory', 9999);
        check('F13 领完后进度不再涨（钳在末档目标）', rawProgress(d, 'st_clear'), t3.count);
    }

    // ——— F·2 效果：未领 = 0，末档领掉才生效，多条各按配表值并存 ———
    {
        const d = newModule();
        const stRow3 = raw.find((r) => r.group === 'st_clear' && r.tier === 3);
        const coRow3 = raw.find((r) => r.group === 'co_relic' && r.tier === 3);

        check('F14 末档未领时效果为 0', [d.getEffect('run_start_gold'), d.getEffect('hero_select_free')], [0, 0]);

        const stEffect = AchievementConfig.getGroup('st_clear').effect;
        check('F15 末档效果引用（真配表该条自己给的值）',
            [stEffect.code, stEffect.value], [stRow3.effect_code, stRow3.effect_value]);

        claimAllTiers(d, 'st_clear');
        check('F16 st_clear 三档领满后效果生效',
            effPairs(d.getEffects()), [[stRow3.effect_code, stRow3.effect_value]]);

        claimAllTiers(d, 'co_relic');
        check('F17 两条成就的效果并存（各自按配表值）',
            effPairs(d.getEffects()),
            [[stRow3.effect_code, stRow3.effect_value], [coRow3.effect_code, coRow3.effect_value]]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }

    // ——— F·3 同 code 多来源：求和 + 按 `ACH_EFFECT_META.cap` 封顶 ———
    // 真表每个 effect_code 恰好 1 个来源（B3 已钉死），所以「求和 > cap」在真表下**不可达**；
    // 这里篡改一份配表把分支逼出来 —— 断言的是**真代码的求和与 clamp**，不是真配表的数字。
    {
        const cap = ACH_EFFECT_META.run_start_gold.cap;
        const stGold = raw.find((r) => r.group === 'st_clear' && r.tier === 3).effect_value;

        /**
         * 篡改一份成就表：让 `cb_damage` 的末档也改给 `run_start_gold`（与 `st_clear` 同 code）。
         * @returns { effValue, warnCount } —— 求和后的效果值 + 容器门禁告警数（>0 = 篡改真的生效了）
         */
        const runEffectCase = (cbDamageValue) => {
            const data = JSON.parse(JSON.stringify(raw));
            const row = data.find((r) => r.group === 'cb_damage' && r.tier === 3);
            row.effect_code = 'run_start_gold';
            row.effect_value = cbDamageValue;
            tbRoot.ins._useData(AchievementCfgContainer, data);
            const m = newModule();
            // 装载体（= 第一次读配表）放在 captureWarnings 里：篡改必然触发「同 code 多来源」门禁告警
            const warns = captureWarnings(() => { claimAllTiers(m, 'st_clear'); claimAllTiers(m, 'cb_damage'); });
            const eff = m.getEffects();
            tbRoot.ins._clearData(AchievementCfgContainer);
            return { effValue: eff.run_start_gold, warnCount: warns.length };
        };

        const sumUnderCap = runEffectCase(30);
        check(`F18 同 code 两来源求和（${stGold}+30，未到 cap）+ 篡改前提成立（有门禁告警）`,
            [sumUnderCap.effValue, sumUnderCap.warnCount > 0], [stGold + 30, true]);

        const sumOverCap = runEffectCase(cap * 3);
        check(`F19 求和超封顶 → clamp 到 cap（${stGold}+${cap * 3} → ${cap}）`,
            sumOverCap.effValue, cap);
    }

    // ——— F·4 峰值只增不减 / 进度模式用错必须被忽略 ———
    {
        const d = newModule();
        d.peakProgress('stage_reached', 3);
        check('F20 峰值型首次上报写入原始进度', rawProgress(d, 'st_stage'), 3);
        d.peakProgress('stage_reached', 2);
        check('F21 峰值只增不减（再报 2 仍是 3）', rawProgress(d, 'st_stage'), 3);
        d.peakProgress('stage_reached', 5);
        check('F22 峰值可以继续往上顶（3 → 5，且下一档转为可领）',
            [rawProgress(d, 'st_stage'), d.getGroupState('st_stage').state], [5, 'claimable']);

        const m2 = newModule();
        const w1 = captureWarnings(() => m2.addProgress('stage_reached', 3));   // max 型 → 该忽略
        check('F23 addProgress 用在 max 型 target 上 → 忽略 + warn（不建记录）',
            [w1.length, m2.data.records.length], [1, 0]);
        const w2 = captureWarnings(() => m2.peakProgress('victory', 5));        // add 型 → 该忽略
        check('F24 peakProgress 用在 add 型 target 上 → 忽略 + warn（不建记录）',
            [w2.length, m2.data.records.length], [1, 0]);
    }

    // ⚠ **待补（本轮故意不做）**：设计稿 §11 的第四条「**初始金币真播种到 `hero.gold`**」——
    //    它验的是战斗侧那一处改动（`Scene_Game_Stage.selectHero` 里
    //    `hero.gold = BattleConstUtil.getInitialGold() + getEffects().run_start_gold`，见设计稿 §10.4），
    //    而那处**当前还没落地**（`BattleConstUtil.getInitialGold()` 仍是零调用）。
    //    现在写这条断言只会去验一个不存在的调用点（要么永远红、要么写成假的）。
    //    等播种落地后，这里应追加：真开一局 → `hero.gold` == `initialGold + 快照的 run_start_gold`，
    //    且**局中领奖不改本局数值**（`getEffects()` 是开局快照口径）。

    // ────────────── 汇总 ──────────────
    console.log(`\n${failures.length ? '✘' : '✔'} 成就体检：${passed} 条通过，${failures.length} 条失败`);
    if (failures.length) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
        process.exit(1);
    }
};

main();
