#!/usr/bin/env node
/**
 * migrate-relic-icons.mjs —— 遗物图标「远程 URL → 本地资源路径」迁移（**幂等**）
 *
 * 背景：`relics.json` 的 `icon` 列原本是 dota2 官方 CDN 的**远程 URL**
 * （`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/xxx.png`），
 * 运行时靠 `ShopRelicsItem.loadIcon` 的 `loadRemoteFrame` 分支加载 —— 离线/断网就整面板空图。
 * 现在把官方图标落到本地 `assets/resources/textures/relics/<dota2 key>.png`，
 * 配置列改成 **resources 相对路径**（与 `units.head_icon` = `textures/heros/huoqiang` 同一口径，
 * **不带扩展名**，由 `resources.load('<路径>/spriteFrame')` 解析）。
 *
 * 映射规则（只有一条）：远程 URL 的**文件名主干** = 本地 png 的文件名主干
 *   `.../items/quelling_blade.png`  →  `textures/relics/quelling_blade`
 * 本地不存在同名 png 时**保留原值不动**（只报不改）—— 例如 1294/1295/1297/1298/1299/1301/1302
 * 这 7 件局外独有中立道具，素材站没有对应文件（那 7 件的 UI 尚未落地，保留 URL 不丢信息）。
 *
 * 幂等保证：
 *   · 已是本地路径（`textures/...`）的行**一律不动**（只做存在性体检）；
 *   · 远程 URL 只有在本地文件确实存在时才被替换，重跑时已无远程 URL，结果不变。
 *
 * 用法：
 *   node tools/excel_export/scripts/migrate-relic-icons.mjs             # 写盘 + 出报告
 *   node tools/excel_export/scripts/migrate-relic-icons.mjs --dry-run   # 只出报告不写盘
 *   ... --json-dir <目录> --icon-dir <目录>                             # 换目录（便于在副本上试跑）
 *
 * 跑完必须回灌表格与复校（xlsx 才是编辑源，只改 JSON 会被下一次导表覆盖）：
 *   cd tools/excel_export && node src/cli.ts json2excel --force --table relics && npm run check && npm run verify
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const DRY_RUN = argv.includes('--dry-run');

/** JSON 目录（配表真源之一，改完再回灌 xlsx） */
const JSON_DIR = path.resolve(opt('--json-dir', path.join(ROOT, 'assets/resources/tb')));
/** 本地图标目录（dota2 官方 png 的落地处） */
const ICON_DIR = path.resolve(opt('--icon-dir', path.join(ROOT, 'assets/resources/textures/relics')));
/** 写进配表的路径前缀 = `resources/` 下的相对目录（不带扩展名） */
const ICON_PREFIX = 'textures/relics';
/** 判断「已是本地路径」的前缀（宽容一点：别的 textures/ 子目录也算本地） */
const LOCAL_PREFIX = 'textures/';

const REPORT_FILE = path.join(ROOT, 'tools/excel_export/reports/relic-icon-migration.md');
/** 只有跑在默认数据目录上才写正式报告（`--json-dir` 试跑不覆盖） */
const WRITE_REPORT = JSON_DIR === path.join(ROOT, 'assets/resources/tb');

const RELICS = path.join(JSON_DIR, 'relics.json');

// ============================ 报告 ============================

const report = [];
const log = (s = '') => report.push(s);

/** 迁移明细（远程 URL → 本地路径） */
const migrated = [];
/** 远程 URL 但本地没图 —— 保留原值，只报 */
const missingLocal = [];
/** 本来就是本地路径但文件不在 —— 配表写错或图被删了 */
const brokenLocal = [];
/** 压根没配图标（`icon` 为空） */
const emptyIcon = [];

// ============================ 主流程 ============================

function main() {
    if (!fs.existsSync(RELICS)) {
        console.error(`✗ 找不到 ${RELICS}`);
        process.exit(1);
    }
    if (!fs.existsSync(ICON_DIR)) {
        console.error(`✗ 找不到图标目录 ${ICON_DIR}`);
        process.exit(1);
    }

    const localFiles = new Set(
        fs.readdirSync(ICON_DIR)
            .filter(f => /\.png$/i.test(f))
            .map(f => f.replace(/\.png$/i, '')),
    );

    const relics = JSON.parse(fs.readFileSync(RELICS, 'utf8'));
    const rows = Object.values(relics);

    for (const row of rows) {
        const icon = row.icon;
        if (!icon) {
            emptyIcon.push(row);
            continue;
        }

        if (/^https?:\/\//i.test(icon)) {
            const base = icon.split('/').pop().replace(/\.png$/i, '');
            if (localFiles.has(base)) {
                row.icon = `${ICON_PREFIX}/${base}`;
                migrated.push({ id: row.id, name: row.name, from: icon, to: row.icon });
            } else {
                missingLocal.push({ id: row.id, name: row.name, url: icon, base });
            }
            continue;
        }

        if (icon.startsWith(LOCAL_PREFIX)) {
            const base = icon.split('/').pop().replace(/\.png$/i, '');
            if (!localFiles.has(base)) brokenLocal.push({ id: row.id, name: row.name, icon });
            continue;
        }

        // 既不是 URL 也不是本地路径：只报，不动
        brokenLocal.push({ id: row.id, name: row.name, icon });
    }

    // ============================ 报告 ============================
    log('# 遗物图标迁移报告（远程 URL → `textures/relics/*`）');
    log();
    log(`- 配表：\`${path.relative(ROOT, RELICS).replace(/\\/g, '/')}\``);
    log(`- 图标目录：\`${path.relative(ROOT, ICON_DIR).replace(/\\/g, '/')}\`（png ${localFiles.size} 张）`);
    log(`- 路径口径：\`${ICON_PREFIX}/<dota2 key>\`（**不带扩展名**，与 \`units.head_icon\` 一致）`);
    log(`- 遗物总行数：${rows.length}`);
    log();
    log('## 汇总');
    log();
    log('| 项 | 数量 |');
    log('|---|---|');
    log(`| 本次改为本地路径 | ${migrated.length} |`);
    log(`| 无本地图（保留远程 URL） | ${missingLocal.length} |`);
    log(`| 无图标（本来就没配） | ${emptyIcon.length} |`);
    log(`| 本地路径但文件缺失 | ${brokenLocal.length} |`);
    log();

    if (missingLocal.length) {
        log('## 无本地图的行（保留远程 URL，只报不改）');
        log();
        log('> 这 7 件是**局外独有**的中立道具（`scope=outer`），素材站没有对应文件；局外 UI 尚未落地，先保留 URL。');
        log();
        log('| id | 遗物 | 期望文件名 |');
        log('|---|---|---|');
        for (const m of missingLocal) log(`| ${m.id} | ${m.name} | ${m.base}.png |`);
        log();
    }

    if (emptyIcon.length) {
        log('## 没有 icon 的行（运行时回落占位图 `textures/skills/bullet`）');
        log();
        log('| id | 遗物 | scope |');
        log('|---|---|---|');
        for (const r of emptyIcon) log(`| ${r.id} | ${r.name} | ${r.scope ?? ''} |`);
        log();
    }

    if (brokenLocal.length) {
        log('## ⚠ 写成本地路径但文件缺失（需要人工处理）');
        log();
        log('| id | 遗物 | icon |');
        log('|---|---|---|');
        for (const b of brokenLocal) log(`| ${b.id} | ${b.name} | \`${b.icon}\` |`);
        log();
    }

    log('## 明细（本次迁移）');
    log();
    log('| id | 遗物 | 本地路径 |');
    log('|---|---|---|');
    for (const m of migrated) log(`| ${m.id} | ${m.name} | \`${m.to}\` |`);
    log();

    if (DRY_RUN) {
        console.log(report.join('\n'));
        console.log(`\n（--dry-run：未写盘；将改 ${migrated.length} 行）`);
        return;
    }

    if (migrated.length === 0) {
        console.log('✓ 本次无任何改动（幂等重跑）：`icon` 列已全部是本地路径或保留远程 URL。');
        if (!brokenLocal.length) return;
    } else {
        fs.writeFileSync(RELICS, JSON.stringify(relics, null, 2) + '\n', 'utf8');
        console.log(`✓ 已写盘：${path.relative(ROOT, RELICS)}（${migrated.length} 行 icon → ${ICON_PREFIX}/…）`);
    }

    if (WRITE_REPORT) {
        fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
        fs.writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
        console.log(`✓ 报告：${path.relative(ROOT, REPORT_FILE)}`);
    }

    console.log(`  无本地图 ${missingLocal.length} 行（保留远程 URL）· 无 icon ${emptyIcon.length} 行 · 本地路径缺文件 ${brokenLocal.length} 行`);
    console.log('\n接着执行：cd tools/excel_export && node src/cli.ts json2excel --force --table relics && npm run check && npm run verify');
}

main();
