#!/usr/bin/env node
/**
 * migrate-affix-gating.mjs —— 按「品质 × 词条」门禁规则迁移既有配表（**幂等**）
 *
 * 规则真源：./lib/affix-rules.mjs（文档：docs/配置规则_品质与词条门禁.md）
 *
 * 处理两张表（**遗物是一件一行，局内版 / 局外版分两侧**）：
 *   1. units.json   英雄条目：base_attributes 收敛到 5 项、growthValues 收敛到 3 项
 *   2. relics.json  **局内版**（`modifiers_inner` / `description_inner`）：基础值为 0 的属性 percent → 固定值；
 *                   低档 percent → 固定值折算；百分比型属性处理；必要时升档；描述重写
 *   3. relics.json  **局外版**（`modifiers_outer` / `description_outer`）：基础值为 0 的属性 percent → 固定值；
 *                   低档删百分比型属性 + 描述文案清理；若删完这一侧就彻底空了 → **升档保身份**（品质是两侧共享列）
 *
 * 幂等保证：
 *   · units 是白名单过滤（重复执行结果不变）
 *   · 局外版：低档删属性/删文案后不会再生；升档后 tier≥3 不再被命中
 *   · 局内版：percent→add 只做一次（转换后 mode 已是 add）；升档后 tier≥3 不再被命中；
 *            描述由最终 attrs 重建，重复执行文本一致
 *   · base=0 的 percent→add 也只做一次（见 convertZeroBasePercents）
 *
 * 用法：
 *   node tools/excel_export/scripts/migrate-affix-gating.mjs            # 写盘 + 出报告
 *   node tools/excel_export/scripts/migrate-affix-gating.mjs --dry-run  # 只出报告不写盘
 *   ... --json-dir <目录>                                               # 换数据目录（默认 assets/resources/tb，便于在副本上试跑）
 *
 * 跑完必须回灌表格与复核：
 *   cd tools/excel_export && npm run import -- --force --table units,relics && npm run export && npm run verify
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ATTR_NAME, PERCENT_ATTRS, QUALITY_TIERS, TIER_LABEL, TIER_TO_RARITY,
    DESC_ATTR_ALIAS, dropDescriptionClauses, formatTerms, hasInnerSide, hasOuterSide,
    illegalDescriptionClauses, isZeroBaseAttr, parseTermBlock, percentToFlat, relicSide,
    tierOfRarity,
} from './lib/affix-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
/** 数据目录（`--json-dir` 可换，便于在副本上试跑） */
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const JSON_DIR = path.resolve(opt('--json-dir', path.join(ROOT, 'assets/resources/tb')));
const REPORT_FILE = path.join(ROOT, 'tools/excel_export/reports/affix-gating-migration.md');
/** 只有在默认数据目录上跑才写报告（`--json-dir` 试跑不应覆盖正式报告） */
const WRITE_REPORT = JSON_DIR === path.join(ROOT, 'assets/resources/tb');

const DRY_RUN = argv.includes('--dry-run');

/** 英雄「基础属性」白名单与规范顺序 */
const HERO_BASE_ATTRS = [1, 2, 3, 4, 16];
/** 英雄「属性成长」白名单与规范顺序 */
const HERO_GROWTH_ATTRS = [1, 2, 3];
/** 局外版永远不给的属性（数值配置手册 §4.3 铁律） */
const OUTER_FORBIDDEN_ATTRS = [4];
/** 「属性修改」共享模板 id（纯属性加成统一引用它，数值写在 kv.attrs 里） */
const ATTR_TEMPLATE_MOD_ID = 1000;

// 描述文案的词条解析/生成统一由 ./lib/affix-rules.mjs 提供（formatTerms / parseTermBlock）

// ============================ 报告 ============================

const report = [];
const log = (s = '') => report.push(s);
const stats = { units: 0, unitsChanged: 0, equipQuality: 0, equipDropped: 0, equipDescDropped: 0, equipPromoted: 0, zeroBase: 0, zeroBaseOuter: 0, relicConverted: 0, relicNormalized: 0, relicDropped: 0, relicPromoted: 0, relicUnchanged: 0 };
/** 需人工定案的条目（档位变了但白值没重算 / 与既有铁律冲突） */
const manual = [];
/** 局外版里给了攻速的条目（§4.3 铁律冲突，只报不改） */
const equipSpeedWarnings = [];

/**
 * 把某一侧的属性写回 `modifiers_inner` / `modifiers_outer`（保留该侧的非属性 Modifier；属性为空则删掉该侧 modifiers）。
 * @param {'inner'|'outer'} side
 */
function writeSideAttrs(relic, side, attrs) {
    const key = side === 'inner' ? 'modifiers_inner' : 'modifiers_outer';
    const list = relic[key] ?? [];
    const other = list.filter((m) => !m?.kv?.attrs);
    const kept = attrs.length ? [{ modifier: ATTR_TEMPLATE_MOD_ID, duration: null, kv: { attrs } }] : [];
    const merged = [...other, ...kept];
    if (merged.length) relic[key] = merged;
    else delete relic[key];
}

/** 属性词条 → 报告里的一行文本 */
const fmtAttrs = (attrs) => attrs.map(([id, v, m]) => `${ATTR_NAME[id] ?? id} ${v}${m === 'percent' ? '%' : ''}`).join('、') || '（空）';

/**
 * ⓪ `percent` 落在**基础值为 0** 的数值属性（护甲 6 / 生命恢复 9 / 魔法恢复 10）上 → 恒为 0
 * （`0 × (1+v/100)`），一律按 `FLAT_CONVERT_BASELINE` 折成固定值 —— 与低档折算同一套基准与门禁规则
 * （规则真源见 `lib/affix-rules.mjs` 的 `ZERO_BASE_ATTRS`）。
 *
 * 幂等：转换后 `mode` 已是 `add`，重复执行不会再命中。
 * @returns {{notes: string[], pairs: Array<[number, number, number]>, converted: number}} pairs = [属性id, 原百分值, 现固定值]
 */
function convertZeroBasePercents(attrs) {
    const notes = [];
    const pairs = [];
    for (const a of attrs) {
        if (a[2] !== 'percent' || !isZeroBaseAttr(a[0])) continue;
        const flat = percentToFlat(a[0], a[1]);
        if (flat === undefined) {
            notes.push(`⚠ ${ATTR_NAME[a[0]]} 无折算基准，保持 percent`);
            continue;
        }
        notes.push(`${ATTR_NAME[a[0]]} ${a[1]}% → 固定值 ${flat}（基础值为 0，percent 恒为 0）`);
        pairs.push([a[0], a[1], flat]);
        a[1] = flat;
        a[2] = 'add';
    }
    return { notes, pairs, converted: pairs.length };
}

/**
 * 把描述里某条 `名称 +X%` 定点改写成固定值形态。
 * 局内版是整段重建（`rewriteDescription`），只有局外版需要这个；幂等（改完不再含 `%`）。
 */
function relabelPercentTerm(desc, attrId, oldPercentValue, newFlatValue) {
    if (!desc) return desc;
    const names = Object.entries(DESC_ATTR_ALIAS).filter(([, id]) => id === attrId).map(([n]) => n)
        .sort((a, b) => b.length - a.length).join('|');
    if (!names) return desc;
    const unit = attrId === 9 || attrId === 10 ? '/s' : '';
    const re = new RegExp(`(${names})\\s*(\\+)?\\s*${oldPercentValue}\\s*%`, 'g');
    return String(desc).replace(re, (_m, name) => `${name} +${newFlatValue}${unit}`);
}

// ============================ 1. units ============================

function migrateUnits(units) {
    log('## 1. units.json —— 英雄基础属性 / 成长收敛');
    log();
    log('| 英雄 | 基础属性 前 → 后 | 成长 前 → 后 |');
    log('|---|---|---|');

    for (const u of units) {
        if (u.team !== 1 && u.category !== 'hero') continue;
        stats.units++;
        const snapshot = JSON.stringify([u.base_attributes, u.growthValues]);

        const baseBefore = (u.base_attributes ?? []).map(([id, v]) => `${ATTR_NAME[id] ?? id} ${v}`).join('、');
        const growthBefore = (u.growthValues ?? []).map(([id, v]) => `${ATTR_NAME[id] ?? id} ${v}`).join('、');

        const baseMap = new Map((u.base_attributes ?? []).map(([id, v]) => [id, v]));
        u.base_attributes = HERO_BASE_ATTRS.filter((id) => baseMap.has(id)).map((id) => [id, baseMap.get(id)]);

        const growthMap = new Map((u.growthValues ?? []).map(([id, v]) => [id, v]));
        if (u.growthValues) {
            u.growthValues = HERO_GROWTH_ATTRS.filter((id) => growthMap.has(id)).map((id) => [id, growthMap.get(id)]);
            if (!u.growthValues.length) delete u.growthValues;
        }

        const baseAfter = u.base_attributes.map(([id, v]) => `${ATTR_NAME[id]} ${v}`).join('、');
        const growthAfter = (u.growthValues ?? []).map(([id, v]) => `${ATTR_NAME[id]} ${v}`).join('、');
        if (JSON.stringify([u.base_attributes, u.growthValues]) !== snapshot) stats.unitsChanged++;
        log(`| ${u.id} ${u.name} | ${baseBefore} → **${baseAfter}** | ${growthBefore} → **${growthAfter}** |`);
    }

    log();
    log('> 被剔除的属性（护甲/魔抗/闪避/回血/暴击/移速）不再由英雄配置提供，回落 `attributes.json.base`');
    log('> （移速 300 / 护甲 0 / 魔抗 25 / 闪避 0 / 回血 0 / 暴击率 0 / 暴伤 100），改由**局外遗物 + 局内遗物**给。');
    log();
}

// ============================ 3. 局外版（relics 的 modifiers_outer / description_outer） ============================

function migrateOuterSide(relics) {
    log('## 3. relics.json 局外版 —— base=0 属性折算 / 低档百分比型属性 + 描述文案');
    log();
    log('| id | 遗物 | 档位 | 属性 前 → 后 | 说明 |');
    log('|---|---|---|---|---|');

    for (const r of relics) {
        if (!hasOuterSide(r)) continue;
        const tierBefore = tierOfRarity(r.rarity);
        if (tierBefore === 0) continue;
        let tier = tierBefore;

        const side = relicSide(r, 'outer');
        const attrs = side.modifiers.flatMap((m) => m?.kv?.attrs ?? []);
        const before = fmtAttrs(attrs);
        const notes = [];

        // ⓪ 基础值为 0 的数值属性不能用 percent（恒为 0）→ 先统一折成固定值
        const zero = convertZeroBasePercents(attrs);
        notes.push(...zero.notes);
        stats.zeroBaseOuter += zero.converted;
        if (zero.converted) {
            r.description_outer = zero.pairs.reduce(
                (d, [id, oldV, newV]) => relabelPercentTerm(d, id, oldV, newV), r.description_outer,
            );
            notes.push('描述已同步');
        }

        if (tier < 3) {
            const illegal = attrs.filter((a) => PERCENT_ATTRS.indexOf(a[0]) >= 0);
            const legal = attrs.filter((a) => PERCENT_ATTRS.indexOf(a[0]) < 0);

            if (illegal.length && !legal.length) {
                // 删完这一侧就彻底空了 —— 这个词条就是这件遗物的身份，**升档保身份**（与局内版的升档规则同源）
                r.rarity = TIER_TO_RARITY[3];
                tier = 3;
                stats.equipPromoted++;
                notes.push(`**升档到 ${TIER_LABEL[3]}**（局外版词条全是百分比型属性，删掉这件就彻底没效果了）`);
                manual.push(`- **遗物 ${r.id} ${r.name}** 局外版升档 ${TIER_LABEL[tierBefore]} → ${TIER_LABEL[3]}：`
                    + `${illegal.map((a) => `${ATTR_NAME[a[0]]} ${a[1]}`).join('、')}`
                    + ' —— 品质是**局内局外共享列**（一件遗物一行），局内商店里这件跟着一起变黄档，请复核要不要单独调白值');
            } else if (illegal.length) {
                // ① 低档：删掉百分比型属性（白/蓝只允许数值属性的固定值）
                for (const a of illegal) {
                    attrs.splice(attrs.indexOf(a), 1);
                    stats.equipDropped++;
                    notes.push(`删除 ${ATTR_NAME[a[0]]} ${a[1]}`);
                }
                // 描述里的同类文案也要删（兼容「攻击力 +8」与「+0.1 攻击速度」两种写法）
                const illegalClauses = illegalDescriptionClauses(side.description, tier);
                if (illegalClauses.length) {
                    r.description_outer = dropDescriptionClauses(side.description, illegalClauses);
                    stats.equipDescDropped += illegalClauses.length;
                    notes.push(`同步删描述词条 ${illegalClauses.join('、')}`);
                }
            }
        }

        if (notes.length) writeSideAttrs(r, 'outer', attrs);

        // ② 局外铁律提醒：攻速不进局外（不自动删，交由策划定案）
        for (const a of attrs) {
            if (OUTER_FORBIDDEN_ATTRS.indexOf(a[0]) < 0) continue;
            equipSpeedWarnings.push({ id: r.id, name: r.name, quality: r.rarity, value: a[1] });
        }

        if (!notes.length) continue;
        const tierText = tierBefore === tier ? TIER_LABEL[tier] : `${TIER_LABEL[tierBefore]} → **${TIER_LABEL[tier]}**`;
        log(`| ${r.id} | ${r.name} | ${tierText} | ${before} → **${fmtAttrs(attrs)}** | ${notes.join('；')} |`);
    }

    log();
    log(`> 局外版：低档删除百分比型属性 ${stats.equipDropped} 条、删描述词条 ${stats.equipDescDropped} 条、升档保身份 ${stats.equipPromoted} 件。`);
    log('> **未自动处理**：局外版给攻速（见 §5.2）——与《数值配置参考手册》§4.3 铁律冲突，保留现状待策划定案。');
    log();
}

// ============================ 2. 局内版（relics 的 modifiers_inner / description_inner） ============================

function migrateInnerSide(relics) {
    log('## 2. relics.json 局内版 —— base=0 属性折算 / 低档 percent 折算 / 百分比型属性处理 / 升档 / 描述重写');
    log();
    log('| id | 遗物 | 档位 前 → 后 | 属性 前 → 后 | 说明 |');
    log('|---|---|---|---|---|');

    for (const r of relics) {
        if (!hasInnerSide(r)) continue;
        const tierBefore = tierOfRarity(r.rarity);
        if (tierBefore === 0) continue;

        const side = relicSide(r, 'inner');
        const attrs = side.modifiers.flatMap((m) => m?.kv?.attrs ?? []);
        if (!attrs.length) continue;

        const before = fmtAttrs(attrs);
        const notes = [];

        // ⓪ 基础值为 0 的数值属性（护甲/回血/回蓝）用 percent 恒为 0 → 一律折成固定值
        //    （与低档折算同一基准；转换后不再被 ② 的 percent 折算重复处理）
        const zero = convertZeroBasePercents(attrs);
        notes.push(...zero.notes);
        stats.zeroBase += zero.converted;

        // ① 百分比型属性禁止 percent 叠加 → 改成 add（配置值即百分点，语义等价且不再因 base=0 失效）
        for (const a of attrs) {
            if (PERCENT_ATTRS.indexOf(a[0]) >= 0 && a[2] === 'percent') {
                a[2] = 'add';
                stats.relicNormalized++;
                notes.push(`${ATTR_NAME[a[0]]} percent → add（百分点）`);
            }
        }

        let tier = tierOfRarity(r.rarity);

        // ② 低档：区分「可折算的数值 percent」与「低档完全不允许的百分比型属性」
        if (tier < 3) {
            const illegal = attrs.filter((a) => PERCENT_ATTRS.indexOf(a[0]) >= 0);
            const legalish = attrs.filter((a) => PERCENT_ATTRS.indexOf(a[0]) < 0);

            if (illegal.length === attrs.length) {
                // 全部词条都是百分比型 → 升到黄档，保留物品身份
                r.rarity = TIER_TO_RARITY[3];
                tier = 3;
                stats.relicPromoted++;
                notes.push(`**升档到 ${TIER_LABEL[3]}**（词条全是百分比型属性）`);
                manual.push(`- **遗物 ${r.id} ${r.name}** 升档 白/蓝 → 黄：${attrs.map((a) => `${ATTR_NAME[a[0]]} ${a[1]}%`).join('、')} —— 白值是按原低档给的，升档后偏弱，需按黄档预算重算`);
            } else {
                // 删除非法词条 + 数值 percent 折成固定值
                for (const a of illegal) {
                    const i = attrs.indexOf(a);
                    attrs.splice(i, 1);
                    stats.relicDropped++;
                    notes.push(`删除 ${ATTR_NAME[a[0]]} ${a[1]}%`);
                }
                for (const a of attrs) {
                    if (a[2] !== 'percent') continue;
                    const flat = percentToFlat(a[0], a[1]);
                    if (flat === undefined) {
                        notes.push(`⚠ ${ATTR_NAME[a[0]]} 无折算基准，保持 percent`);
                        continue;
                    }
                    notes.push(`${ATTR_NAME[a[0]]} ${a[1]}% → 固定值 ${flat}`);
                    a[1] = flat;
                    a[2] = 'add';
                    stats.relicConverted++;
                }
            }
        }

        // ③ 写回 modifiers_inner（属性可能在 ② 里被删/升档，重挂）
        writeSideAttrs(r, 'inner', attrs);

        // ④ 描述重写：头部属性词条段按最终 attrs 重建；`；` 之后的机制原文原样保留
        const descBefore = r.description_inner;
        r.description_inner = rewriteDescription(r.description_inner, attrs, tier, notes);

        const after = fmtAttrs(attrs);
        const tierText = tierBefore === tier ? TIER_LABEL[tier] : `${TIER_LABEL[tierBefore]} → **${TIER_LABEL[tier]}**`;
        const descChanged = r.description_inner !== descBefore;
        if (!notes.length && !descChanged && tierBefore === tier) { stats.relicUnchanged++; continue; }
        log(`| ${r.id} | ${r.name} | ${tierText} | ${before} → **${after}** | ${notes.join('；')}${descChanged ? '；描述已同步' : ''} |`);
    }

    log();
    log(`> 低档 percent → 固定值折算 ${stats.relicConverted} 条；百分比型属性 percent→add 归一 ${stats.relicNormalized} 条；`
        + `低档删除百分比型词条 ${stats.relicDropped} 条；升档 ${stats.relicPromoted} 件。`);
    log();
}

/**
 * 按最终 kv.attrs 重建描述（**幂等**）。
 *
 * 两条截然不同的描述形态，分开处理：
 *   · **纯属性描述**（每一段都是词条块，如「最大生命 +800；攻击速度 +40%；护甲 +5.6」）
 *     → 整条按最终 attrs 重建（这条文案本身就是属性清单，必须与 kv 一致）。
 *   · **属性段 + 机制段**（如「攻击力 +14%；砍树；压制」）
 *     → 只重写首个 `；` 之前的属性块 + **删除尾部与头段重复的属性词条**；
 *       `；` 之后的机制原文（闪烁距离/作用半径/被动名）原样保留 —— 与迁移前口径一致。
 *
 * 功能性词条（schema 暂无结构化字段，只存在于文案）：功能性固定值 < 蓝档 → 删；
 * 功能性百分比 < 红档 → 删（最高品质专属）。
 */
function rewriteDescription(desc, attrs, tier, notes) {
    if (!desc) return desc;
    const segs = String(desc).split('；').map((s) => s.trim()).filter((s) => s.length);
    if (!segs.length) return desc;

    const headTerms = parseTermBlock(segs[0]);
    if (!headTerms) return desc; // 描述里没有任何属性文案 → 不动

    const kvIds = new Set(attrs.map((a) => a[0]));
    const glue = segs[0].includes('|') ? ' | ' : '；';
    const blocks = segs.map(parseTermBlock);

    // 功能性词条按档位过滤（返回保留的原文 + 记账）
    const filterFunctional = (t, kept) => {
        if (t.kind === 'functional_percent') {
            if (tier < 4) notes.push(`删除描述里的功能性百分比「${t.raw}」（最高品质红档专属）`);
            else kept.push(t.raw);
        } else if (t.kind === 'functional_flat') {
            if (tier < 2) notes.push(`删除描述里的功能性固定值「${t.raw}」（蓝档起）`);
            else kept.push(t.raw);
        }
    };

    // ---------- 纯属性描述：整条重建 ----------
    if (blocks.every((b) => b !== null)) {
        const kept = [];
        for (const b of blocks) for (const t of b) filterFunctional(t, kept);
        return [formatTerms(attrs, glue), ...kept].filter(Boolean).join('；');
    }

    // ---------- 头段重写 ----------
    const used = new Set();
    const head = [];
    for (const t of headTerms) {
        if (t.kind === 'attr') {
            const final = attrs.find((a) => a[0] === t.attrId);
            if (!final) {
                notes.push(`删除头段词条「${t.raw}」（最终未授予该属性）`);
                continue;
            }
            used.add(t.attrId);
            head.push(formatTerms([final], ''));
            continue;
        }
        const kept = [];
        filterFunctional(t, kept);
        head.push(...kept);
    }

    // ---------- 尾部：删掉与头段重复的属性词条，其余机制原文保留 ----------
    const tail = [];
    const tailAttrIds = new Set();
    for (const seg of segs.slice(1)) {
        const block = parseTermBlock(seg);
        if (!block) {
            tail.push(seg);
            continue;
        }
        const keptTerms = [];
        for (const t of block) {
            if (t.kind === 'attr') {
                // 同一属性已在头段按最终值给出 → 尾部重复的删掉（记进 used 的补漏逻辑）
                if (kvIds.has(t.attrId)) continue;
                tailAttrIds.add(t.attrId);
            }
            keptTerms.push(t.raw);
        }
        if (keptTerms.length) tail.push(keptTerms.join(' | '));
    }

    // ---------- 补漏：kv 里授予、但头段与尾部都没提到的属性 ----------
    for (const a of attrs) {
        if (used.has(a[0]) || tailAttrIds.has(a[0])) continue;
        head.push(formatTerms([a], ''));
    }

    return [head.join(glue), ...tail].filter(Boolean).join('；');
}

// ============================ main ============================

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(JSON_DIR, `${name}.json`), 'utf8'));
}

function writeJson(name, data) {
    fs.writeFileSync(path.join(JSON_DIR, `${name}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function main() {
    log('# 品质 × 词条门禁迁移报告（migrate-affix-gating.mjs）');
    log();
    log(`生成时间：${new Date().toISOString()}${DRY_RUN ? '　**--dry-run（未写盘）**' : ''}`);
    log();
    log(`品质 4 档：${QUALITY_TIERS.map((t) => `${t.label}=${t.key}(quality ${t.quality})`).join(' / ')}`);
    log();

    const units = readJson('units');
    const relics = readJson('relics');

    migrateUnits(units);
    // 局内版先跑：它可能升档（品质是两侧共享列），局外版据此拿到最终档位再判定
    migrateInnerSide(relics);
    migrateOuterSide(relics);

    log('## 4. 汇总');
    log();
    const totalChanges = stats.unitsChanged + stats.equipQuality + stats.equipDropped + stats.equipDescDropped
        + stats.equipPromoted + stats.zeroBase + stats.zeroBaseOuter
        + stats.relicConverted + stats.relicNormalized + stats.relicDropped + stats.relicPromoted;
    if (totalChanges === 0) {
        log('> **本次是幂等重跑：所有条目已符合门禁规则，没有任何改动。**');
        log('> （要看首次迁移的变更明细，请从 `node src/cli.ts excel2json` 还原基线后重跑本脚本。）');
        log();
    }
    log('| 项 | 数量 |');
    log('|---|---|');
    log(`| 英雄条目收敛 | ${stats.units} |`);
    log(`| 局内版 base=0 属性 percent→固定值 | ${stats.zeroBase} |`);
    log(`| 局外版 base=0 属性 percent→固定值 | ${stats.zeroBaseOuter} |`);
    log(`| 局内版低档 percent→固定值 | ${stats.relicConverted} |`);
    log(`| 局内版百分比型属性 percent→add | ${stats.relicNormalized} |`);
    log(`| 局内版低档删除百分比型词条 | ${stats.relicDropped} |`);
    log(`| 局内版升档 | ${stats.relicPromoted} |`);
    log(`| 局外版低档删除百分比型属性 | ${stats.equipDropped} |`);
    log(`| 局外版低档删除描述词条 | ${stats.equipDescDropped} |`);
    log(`| 局外版升档保身份 | ${stats.equipPromoted} |`);
    log(`| 遗物无需改动（未列出） | ${stats.relicUnchanged} |`);
    log();

    log('## 5. 需人工定案（本次不自动处理）');
    log();
    log('### 5.1 升档后白值未重算 / 共享品质被局外版抬档（需人工复核）');
    log();
    log('> 一件遗物只有**一个品质**（局内局外共享），所以任何一侧的升档都会连带另一侧 —— 下面逐条列出。');
    log();
    if (manual.length) for (const m of manual) log(m); else log('- （无）');
    log();
    log('### 5.2 局外版给攻速（与《数值配置参考手册》§4.3 铁律冲突）');
    log();
    log('| id | 遗物 | 品质 | 攻速加成 |');
    log('|---|---|---|---|');
    for (const e of equipSpeedWarnings) log(`| ${e.id} | ${e.name} | ${e.quality} | ${e.value} |`);
    log();
    log('> 规则冲突：新口径「百分比属性从黄档起」允许黄/红档条目给攻速，');
    log('> 但 2026-06 定案的 §4.3 铁律要求「局外永久加成一律不给攻速」（攻速是局内构筑杠杆）。');
    log('> 本次两套口径都保留、只报不改 —— 请定案后二选一：');
    log(`> ① 局外彻底禁攻速（删这 ${equipSpeedWarnings.length} 条，删空的件改给固定值）；② 废止 §4.3 铁律（黄档起可给攻速）。`);
    log();
    log('### 5.3 局外/局内专属词条');
    log();
    log('> 用户口径：「有些功能性词条只能局外获得，有些只能局内获得，具体哪些还没想好」。');
    log('> 钩子已在 `tools/excel_export/scripts/lib/affix-rules.mjs` 的 `AFFIX_SCOPE` / `AFFIX_SCOPE_REGISTRY` 留好，');
    log('> 定案后逐条登记进 `docs/配置规则_品质与词条门禁.md` §5。');
    log();

    if (DRY_RUN) {
        console.log(report.join('\n'));
        console.log('\n（--dry-run：未写盘）');
        return;
    }

    // 无改动时**不覆盖已有报告**（否则幂等重跑会把首次迁移的明细冲掉，只留一张空表）
    if (totalChanges === 0) {
        console.log('✔ 本次无任何改动（幂等重跑）：所有条目已符合门禁规则，未写盘、报告保持原样。');
        return;
    }

    // 两侧都在 relics 这一张表里，统一写盘
    writeJson('relics', relics);
    writeJson('units', units);

    if (WRITE_REPORT) {
        fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
        fs.writeFileSync(REPORT_FILE, report.join('\n') + '\n', 'utf8');
    } else {
        console.log(report.join('\n'));
    }

    console.log(`✔ 已写盘：${path.relative(ROOT, JSON_DIR)} 的 units.json / relics.json（一件遗物一行，局内版 / 局外版分两侧）`);
    if (WRITE_REPORT) console.log(`✔ 报告：${path.relative(ROOT, REPORT_FILE)}`);
    if (WRITE_REPORT) console.log('\n接着执行：cd tools/excel_export && npm run import -- --force --table units,relics && npm run export && npm run verify');
}

main();
