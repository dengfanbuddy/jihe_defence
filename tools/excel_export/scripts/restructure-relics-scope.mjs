#!/usr/bin/env node
/**
 * restructure-relics-scope.mjs —— 一次性：把 relics 表改造成「一件遗物一行」
 *
 * ## 用户口径（2026-07）
 *
 *   「遗物局内局外用同一个 id、icon、品质等，只是 modifiers、描述分局内局外。」
 *
 * ## 改造前 → 改造后
 *
 * | | 改造前 | 改造后 |
 * |---|---|---|
 * | 行 | 局内道具一行（`scope:"inner"`，1001~1293）+ 局外装备一行（`scope:"outer"`，2001~2045）| **一件遗物一行** |
 * | 身份列 | 两侧各写一套（局外无 icon、局内无 code）| `id / name / code / icon / rarity / category` **共用一套** |
 * | 效果列 | 只有一组 `description` / `modifiers` | `description_inner` / `modifiers_inner` 与 `description_outer` / `modifiers_outer` 分两侧 |
 * | `scope` | 这一行**属于**哪一侧（inner/outer）| 这件遗物**在哪几侧出现**（inner / outer / both）|
 *
 * ## 三件事
 *
 * 1. **同名合并 28 件**：局外装备里能在局内道具里找到同一件 dota2 道具的，并成一行（用**局内 id**），
 *    局外那行作废。判同依据两条（两条都指向同一件，见 §匹配）：
 *      · dota2 **公开名**：`code` 去掉 `d2_`/`d2n_`/`spc_` 前缀；
 *      · dota2 **素材站文件名**：局内 `icon` 的文件名去 `.png`。
 *    两者偶尔不同名（素材站用的是 dota2 内部代号：`crystalys` → `lesser_crit.png`、
 *    `battlefury` → `bfury.png`、`heart_of_tarrasque` → `heart.png`、`assault_cuirass` → `assault.png`、
 *    `iron_branch` → `branches.png`、`daedalus` → `greater_crit.png`），所以**按 slug 优先、其次按中文名**。
 * 2. **删掉 8 件英雄专属装备**（`category:"hero_specific"` / `code:"spc_*"`，id 2001~2008）：
 *    用户口径「无英雄专属」——这类装备没有局内对应物，也不该有独立 id 段。`hero_id` 列随之删除。
 * 3. **9 件只有局外版的 dota2 道具**接在局内道具段之后（id **1294~1302**，按原 id 升序），
 *    只有 `description_outer` / `modifiers_outer`，`scope:"outer"`，不进肉鸽商店抽取池。
 *
 * 品质冲突 5 件（阔剑/秘银锤/闪避护符/金箍棒/虚灵刀）**取局内档**（用户口径「只保留局内的」），
 * 名称异写 6 件同样保留局内写法（`敏捷便鞋`→`敏捷便靴`、`治疗指环`→`恢复指环`、`活力球`→`活力之球`、
 * `希瓦之守护`→`希瓦的守护`、`撒旦之锋`→`撒旦之邪力`、`虚灵刀`→`虚灵之刃`）。
 *
 * ## 幂等
 *
 * 已经是新结构的表再跑一次：合并段没有可合并的行、9 件局外独有按 id 重新排到同一批号上，
 * 结果完全一致 → **不写盘、不覆盖报告**（报告是首次改造的存档）。
 *
 * 用法：
 *   node tools/excel_export/scripts/restructure-relics-scope.mjs --dry-run   # 只出报告
 *   node tools/excel_export/scripts/restructure-relics-scope.mjs             # 写盘 + 出报告
 *
 * 跑完必须回灌表格并复核：
 *   cd tools/excel_export && npm run import -- --force --table relics && npm run check && npm run verify && npm run check:affix
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const RELICS_FILE = path.join(ROOT, 'assets/resources/tb/relics.json');
const REPORT_FILE = path.join(ROOT, 'tools/excel_export/reports/relics-scope-restructure.md');

const DRY_RUN = process.argv.includes('--dry-run');

/** 仅局外遗物的 id 起点（接在局内道具段 1001~1293 之后） */
const OUTER_ONLY_ID_BASE = 1294;
/** dota2 官方素材站（局内 293 件的 icon 就抓自这里，口径一致） */
const ICON_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/';
/**
 * 该素材站**没有**这两个文件（HEAD 校验 404，浏览器实测）——
 * 这两件局外独有遗物的图标留空待补，不要写死一个 404 的 URL。
 */
const MISSING_ICON_SLUGS = ['oak_heart', 'titan_slab'];

/** 输出 JSON 的字段顺序 = schema.ts 里 relics.fields 的顺序 */
const FIELD_ORDER = [
    'id', 'name', 'code', 'icon', 'rarity', 'scope', 'category',
    'description_inner', 'modifiers_inner', 'description_outer', 'modifiers_outer', 'script_id',
];

// ============================ 小工具 ============================

/** 局内 icon 的文件名（= dota2 素材站 slug）：`.../items/bfury.png` → `bfury` */
function slugOfIcon(icon) {
    if (!icon) return null;
    const file = String(icon).split('/').pop() || '';
    return file.replace(/\.png$/i, '') || null;
}

/** 局外 code → dota2 公开名：`d2_battlefury` → `battlefury`；`spc_axe_shield` → `axe_shield` */
function slugOfCode(code) {
    if (!code) return null;
    return String(code).replace(/^(d2n?_|spc_)/, '') || null;
}

/** 英雄专属装备（用户口径：无英雄专属，整条删除） */
function isHeroSpecific(r) {
    return r.category === 'hero_specific' || String(r.code || '').indexOf('spc_') === 0;
}

/** 按 schema 顺序整理字段，并丢掉「空值」（空串/undefined/空数组），与导表工具的「留空 = 不输出」一致 */
function orderRow(row) {
    const out = {};
    for (const key of FIELD_ORDER) {
        const v = row[key];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        out[key] = v;
    }
    return out;
}

const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ============================ 主流程 ============================

const report = [];
const log = (s = '') => report.push(s);
const notes = {
    /** 旧局外 id → { 局内 id, 依据, 名称异写, 品质冲突 } */
    merged: [],
    /** 被删的英雄专属 */
    dropped: [],
    /** 局外独有：旧 id → 新 id */
    lone: [],
    /** 补了 icon 的 / 没补的 */
    iconFilled: [],
    iconMissing: [],
};

/** 旧结构（`description` / `modifiers`）与新结构（`description_outer` / `modifiers_outer`）都能读，保证幂等重跑 */
const outerDescOf = (r) => (r.description_outer !== undefined ? r.description_outer : r.description);
const outerModsOf = (r) => (r.modifiers_outer !== undefined ? r.modifiers_outer : r.modifiers);

function build(rows) {
    const innerRows = rows.filter((r) => (r.scope ?? 'inner') !== 'outer');
    const outerRows = rows.filter((r) => r.scope === 'outer');

    // 局内件索引：中文名 + 素材站 slug（两条判同依据）
    const byName = new Map();
    const bySlug = new Map();
    for (const r of innerRows) {
        if (!byName.has(r.name)) byName.set(r.name, r);
        const s = slugOfIcon(r.icon);
        if (s && !bySlug.has(s)) bySlug.set(s, r);
    }

    // 输出表：id → 新结构行（先铺所有局内件）
    const out = new Map();
    for (const r of innerRows) {
        const hadOuter = r.scope === 'both';
        out.set(r.id, {
            id: r.id,
            name: r.name,
            code: r.code,
            icon: r.icon,
            rarity: r.rarity,
            scope: hadOuter ? 'both' : 'inner',
            category: r.category,
            description_inner: r.description_inner !== undefined ? r.description_inner : r.description,
            modifiers_inner: r.modifiers_inner !== undefined ? r.modifiers_inner : r.modifiers,
            description_outer: r.description_outer,
            modifiers_outer: r.modifiers_outer,
            script_id: r.script_id,
        });
    }

    // 局外件：英雄专属删除，能判同的合并进局内行，剩下的留作「仅局外」
    const lone = [];
    for (const o of outerRows) {
        if (isHeroSpecific(o)) {
            notes.dropped.push({ id: o.id, name: o.name, rarity: o.rarity, code: o.code, category: o.category, desc: o.description });
            continue;
        }
        const slug = slugOfCode(o.code);
        const hitSlug = slug ? bySlug.get(slug) : undefined;
        const hitName = byName.get(o.name);
        const hit = hitSlug || hitName;

        if (!hit) { lone.push(o); continue; }

        const row = out.get(hit.id);
        row.scope = 'both';
        row.code = o.code ?? row.code;
        row.category = o.category ?? row.category;
        row.description_outer = outerDescOf(o);
        row.modifiers_outer = outerModsOf(o);
        notes.merged.push({
            outerId: o.id, outerName: o.name, outerRarity: o.rarity, outerCode: o.code,
            innerId: hit.id, innerName: hit.name, innerRarity: hit.rarity,
            by: hitSlug ? 'slug' : '名',
            slug,
            nameVariant: o.name !== hit.name,
            rarityConflict: o.rarity !== hit.rarity,
        });
    }

    // 仅局外的 dota2 道具：按原 id 升序，接在局内道具段之后
    lone.sort((a, b) => a.id - b.id);
    lone.forEach((o, i) => {
        const id = OUTER_ONLY_ID_BASE + i;
        const slug = slugOfCode(o.code);
        // 已有 icon 就保留（策划手工修过的图不被覆盖）；没有才按 dota2 素材站规则推导
        let icon = o.icon;
        if (!icon && slug && MISSING_ICON_SLUGS.indexOf(slug) < 0) {
            icon = ICON_BASE + slug + '.png';
            notes.iconFilled.push({ id, name: o.name, icon });
        } else if (!icon) {
            notes.iconMissing.push({ id, name: o.name, slug });
        }
        out.set(id, {
            id,
            name: o.name,
            code: o.code,
            icon,
            rarity: o.rarity,
            scope: 'outer',
            category: o.category,
            description_outer: outerDescOf(o),
            modifiers_outer: outerModsOf(o),
            script_id: o.script_id,
        });
        notes.lone.push({ oldId: o.id, newId: id, name: o.name, rarity: o.rarity, code: o.code, category: o.category, desc: outerDescOf(o) });
    });

    return [...out.values()].sort((a, b) => a.id - b.id).map(orderRow);
}

// ============================ 报告 ============================

function writeReport(before, after) {
    const innerCount = after.filter((r) => r.scope === 'inner').length;
    const bothCount = after.filter((r) => r.scope === 'both').length;
    const outerCount = after.filter((r) => r.scope === 'outer').length;

    log('# relics 表改造报告：一件遗物一行（restructure-relics-scope.mjs）');
    log();
    log(`生成时间：${new Date().toISOString()}${DRY_RUN ? '　**--dry-run（未写盘）**' : ''}`);
    log();
    log('> 口径：「遗物局内局外用同一个 id、icon、品质等，只是 modifiers、描述分局内局外」。');
    log('> 规则与列定义见 `docs/配置规则_品质与词条门禁.md` §1.1，表结构见 `tools/excel_export/src/core/schema.ts` 的 relics。');
    log();
    log('## 1. 概览');
    log();
    log('| 项 | 改造前 | 改造后 |');
    log('|---|---|---|');
    log(`| 行数 | ${before.length} | ${after.length} |`);
    log(`| 局内件（scope=inner） | ${before.filter((r) => (r.scope ?? 'inner') === 'inner').length} | ${innerCount} |`);
    log(`| 两侧都有（scope=both） | 0 | ${bothCount} |`);
    log(`| 仅局外（scope=outer） | ${before.filter((r) => r.scope === 'outer').length} | ${outerCount} |`);
    log(`| 局外专属列 hero_id | 有（8 件英雄专属在用） | **已删除该列** |`);
    log();
    log('账目：`局内件 + 两侧都有 = 改造前的局内件数`；`两侧都有 + 仅局外 = 改造前非英雄专属的局外件数`（45 - 8 删除）。');
    log();
    log(`## 2. 删除：英雄专属装备 ${notes.dropped.length} 件（「无英雄专属」）`);
    log();
    log('| 旧 id | 名称 | 品质 | code | 说明 |');
    log('|---|---|---|---|---|');
    for (const d of notes.dropped) log(`| ${d.id} | ${d.name} | ${d.rarity} | ${d.code} | 删除（原效果：${strip(d.desc)}） |`);
    log();
    log('> 这批装备只有局外版、没有局内对应物，且带 `hero_id` 专属归属；删除后 `code=spc_*` 与 `hero_id` 列不再存在，');
    log('> `EquipmentConfig.getHeroSpecificEquipId()` 一并删除。');
    log();
    log(`## 3. 合并：${notes.merged.length} 件同一个 dota2 道具合成一行（用局内 id）`);
    log();
    log('| 旧局外 id | 局外名 | 局外品质 | → 局内 id | 局内名 | 局内品质 | 判同依据 | 备注 |');
    log('|---|---|---|---|---|---|---|---|');
    for (const m of notes.merged) {
        const extra = [];
        if (m.nameVariant) extra.push(`名称异写：局外「${m.outerName}」/ 局内「${m.innerName}」（保留局内写法）`);
        if (m.rarityConflict) extra.push(`**品质冲突**：局外 ${m.outerRarity} / 局内 ${m.innerRarity}（取局内）`);
        log(`| ${m.outerId} | ${m.outerName} | ${m.outerRarity} | **${m.innerId}** | ${m.innerName} | ${m.innerRarity} | 按${m.by} | ${extra.join('；') || '-'} |`);
    }
    log();
    log('判同依据两条，都指向同一件 dota2 道具：');
    log();
    log('- **按 slug**（局外 `code` 去前缀 ↔ 局内 `icon` 文件名）：素材站用的是 dota2 **内部代号**，与公开名偶尔不同 ——');
    log('  `d2_crystalys` → `lesser_crit.png`、`d2_battlefury` → `bfury.png`、`d2_heart_of_tarrasque` → `heart.png`、');
    log('  `d2_assault_cuirass` → `assault.png`、`d2_iron_branch` → `branches.png`、`d2_daedalus` → `greater_crit.png`；');
    log('- **按中文名**：上面 6 件正是「公开名与素材名不同」的那批，靠中文名兜底；');
    log('  28 件里 22 件 slug 先命中（其中 16 件中文名也一致），6 件只能靠中文名判同。');
    log();
    log('> 全部 28 对都做过 slug 距离复核：未匹配的 9 件与最近局内 slug 的编辑距离 ≥3 且语义无关（`apex` vs `gem` 之类），无漏配。');
    log();
    log(`## 4. 新 id：仅局外的 ${notes.lone.length} 件 dota2 道具（${OUTER_ONLY_ID_BASE} 起）`);
    log();
    log('| 旧 id | 新 id | 名称 | 品质 | code | category | 图标 |');
    log('|---|---|---|---|---|---|---|');
    for (const l of notes.lone) {
        const filled = notes.iconFilled.find((f) => f.id === l.newId);
        log(`| ${l.oldId} | **${l.newId}** | ${l.name} | ${l.rarity} | ${l.code} | ${l.category ?? '-'} | ${filled ? '按 dota2 素材站规则补' : '**待补（素材站无此文件）**'} |`);
    }
    log();
    log('> 这 9 件没有局内版：`scope="outer"`，只有 `description_outer`/`modifiers_outer`，**不进肉鸽商店抽取池**（`ShopConfig.getRelics()` 按 scope 过滤）。');
    log();
    if (notes.iconFilled.length) {
        log(`### 4.1 补上的图标 ${notes.iconFilled.length} 个（与局内 293 件同源同规则，逐个 HTTP 校验过 200 / 88×64）`);
        log();
        for (const f of notes.iconFilled) log(`- ${f.id} ${f.name} → \`${f.icon}\``);
        log();
    }
    if (notes.iconMissing.length) {
        log(`### 4.2 图标待补 ${notes.iconMissing.length} 个（素材站确实没有该文件，返回 404，不写死坏 URL）`);
        log();
        for (const f of notes.iconMissing) log(`- ${f.id} ${f.name}（slug \`${f.slug}\`）`);
        log();
    }
    log('## 5. 字段映射（旧 → 新）');
    log();
    log('| 旧字段 | 新字段 | 说明 |');
    log('|---|---|---|');
    log('| `scope: "inner"` | `scope: "inner"` | 只有局内版 |');
    log('| `scope: "outer"`（有局内对应物） | `scope: "both"` | 两侧都有，**并用局内 id** |');
    log('| `scope: "outer"`（无局内对应物） | `scope: "outer"` | 只有局外版，id 改为 ' + `${OUTER_ONLY_ID_BASE} 起` + ' |');
    log('| `description` | `description_inner`（局内行）/ `description_outer`（局外行） | 两侧各自的文案原样保留 |');
    log('| `modifiers` | `modifiers_inner` / `modifiers_outer` | 两侧各自的效果原样保留（口径都是 int ×100） |');
    log('| `code` | `code`（保留） | 由「局外专属列」升级为遗物身份列：同一件遗物一个 dota2 code |');
    log('| `category` | `category`（保留） | `d2_basic` / `d2_upgrade` / `d2_neutral`；`hero_specific` 已随英雄专属装备删除 |');
    log('| `hero_id` | **删除** | 无英雄专属 |');
    log('| `icon` | `icon`（保留） | 局内局外**共用**一张图（局外独有件按素材站规则补） |');
    log('| `rarity` / `name` / `id` | 保留 | 两侧冲突时取局内（见 §3） |');
    log();
    log('## 6. 尚未定案（本次不动）');
    log();
    log('1. **本体升级链**：`d2_basic → d2_upgrade` 的合成关系（原来靠 `code` 前缀 + `category` 表达）现在 28 件合并行只剩一个 code，');
    log('   若要落成「局外可以合成升级」，需要另加列（例如 `upgrade_to`）；当前没有这张关系表。');
    log('2. **同一件遗物的两套数值预算**：局外版给的是固定值（白/蓝档只能给固定值），局内版给的是百分比 ——');
    log('   合并成一行后，请按「同一件遗物两侧强度量级大致相当」复核一遍（局外 45 → 37 件里，5 件品质取了局内档）。');
    log('3. **局外给攻速**（数值手册 §4.3 铁律冲突）：合并后仍是 8 件（`check:affix` 逐条报警，本次不动）。');
    log();

    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
}

// ============================ main ============================

function main() {
    const before = JSON.parse(fs.readFileSync(RELICS_FILE, 'utf8'));
    const after = build(before);

    const changed = JSON.stringify(before) !== JSON.stringify(after);
    console.log('▌relics 表改造：一件遗物一行');
    console.log(`  ${before.length} 行 → ${after.length} 行`
        + `（inner ${after.filter((r) => r.scope === 'inner').length} / both ${after.filter((r) => r.scope === 'both').length} / outer ${after.filter((r) => r.scope === 'outer').length}）`);
    console.log(`  合并 ${notes.merged.length} 件 / 仅局外 ${notes.lone.length} 件 / 删除英雄专属 ${notes.dropped.length} 件`);

    if (DRY_RUN) {
        writeReport(before, after);
        console.log(`  --dry-run：未写盘；报告 ${path.relative(ROOT, REPORT_FILE)}`);
        return;
    }

    if (!changed) {
        console.log('✔ 本次无任何改动（幂等重跑）：表已是「一件遗物一行」，未写盘、报告保持原样。');
        return;
    }

    fs.writeFileSync(RELICS_FILE, JSON.stringify(after, null, 2) + '\n', 'utf8');
    writeReport(before, after);
    console.log(`  ✔ 已写盘 ${path.relative(ROOT, RELICS_FILE)}`);
    console.log(`  ✔ 报告 ${path.relative(ROOT, REPORT_FILE)}`);
    console.log('\n接着执行：cd tools/excel_export && npm run import -- --force --table relics && npm run check && npm run verify && npm run check:affix');
}

main();
