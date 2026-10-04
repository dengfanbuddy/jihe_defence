#!/usr/bin/env node
/**
 * check-affix-gating.mjs —— 「品质 × 词条」门禁体检（CI 用，违规即失败）
 *
 * 规则真源：./lib/affix-rules.mjs（文档：docs/配置规则_品质与词条门禁.md）
 *
 * 检查项：
 *   units   英雄条目 base_attributes ⊆ {1,2,3,4,16}；growthValues ⊆ {1,2,3}（**错误**）
 *   relics  一件遗物一行，局内版 / 局外版分两侧（`scope` = inner|outer|both）：
 *           · `scope` 必填且合法；`rarity` ∈ 4 档（**错误**）
 *           · **每一侧**的 `kv.attrs` 属性词条按档位门禁（**错误**）
 *           · 局外版给攻速 → 警告（数值手册 §4.3 铁律：攻速是局内构筑杠杆）
 *           · **每一侧**的描述文案里的属性词条同样过门禁 / 功能性百分比提示（警告）
 *           · `scope` 说的侧别与 `description_*` / `modifiers_*` 是否对得上（**错误** / 警告）
 *
 * 用法：
 *   node tools/excel_export/scripts/check-affix-gating.mjs
 *   npm run check:affix          （在 tools/excel_export 下；--strict 警告也算失败、--limit 0 打全量）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ATTR_NAME, LEGACY_ATTR_IDS, RELIC_SCOPES, TIER_LABEL,
    classifyAttrAffix, collectRelicAttrs, hasInnerSide, hasOuterSide, illegalDescriptionClauses,
    parseTermBlock, relicSide, tierOfRarity,
} from './lib/affix-rules.mjs';
// 钩子文案反查（2026-10 局内遗物重做）：把钩子文案从描述里剥掉再解析属性词条，
// 否则「普攻命中叠 1 层：攻击速度 +2%」这种**效果描述**会被误判成"低档承诺了攻速"。
import { hookTextByModId } from './lib/relic-inner-design.mjs';

/**
 * 去掉描述里的**钩子文案**（逐条钩子按本件品质取原文，原样删除）。
 * 剥不掉的（例如手改过描述）会照旧参与解析 —— 那正是我们要报的漂移。
 */
function stripHookText(desc, modifiers, rarity) {
    let out = desc ?? '';
    for (const m of modifiers ?? []) {
        const text = hookTextByModId(m?.modifier, rarity);
        if (text) out = out.split(text).join('');
    }
    return out;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

// ============================ 参数 ============================

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const JSON_DIR = path.resolve(opt('--json-dir', path.join(ROOT, 'assets/resources/tb')));
const STRICT = flag('--strict');
/** 终端最多打印多少条（--limit 0 = 不限，便于导出全量清单） */
const LIMIT = Number(opt('--limit', '80'));

/** 英雄「基础属性」白名单（units.json，仅英雄条目） */
const HERO_BASE_ATTRS = [1, 2, 3, 4, 16];
/** 英雄「属性成长」白名单 */
const HERO_GROWTH_ATTRS = [1, 2, 3];
/** 局外版永远不给的属性（数值配置手册 §4.3 铁律：攻速是局内构筑杠杆） */
const OUTER_FORBIDDEN_ATTRS = [4];

// ============================ 输出 ============================

const errors = [];
const warnings = [];
const err = (s) => errors.push(s);
const warn = (s) => warnings.push(s);

function readJson(name) {
    const file = path.join(JSON_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
        err(`缺表：${path.relative(ROOT, file)}`);
        return [];
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 属性词条门禁：返回违规文本（无违规则 null） */
function checkAttrAffix(attr, tier, where) {
    const attrId = attr[0];
    const mode = attr[2];
    const cls = classifyAttrAffix(attrId, mode);
    const name = ATTR_NAME[attrId] ?? `属性${attrId}`;
    if (cls.violation) return `${where}：${cls.violation}`;
    if (tier > 0 && tier < cls.minTier) {
        return `${where}：${name} ${attr[1]}${mode === 'percent' ? '%' : ''}（${mode ?? 'add'}）需要 ${TIER_LABEL[cls.minTier]} 起，当前 ${TIER_LABEL[tier]}`;
    }
    return null;
}

// ============================ 1. units ============================

function checkUnits(units) {
    for (const u of units) {
        if (u.team !== 1 && u.category !== 'hero') continue;
        const where = `units id=${u.id} ${u.name}`;

        const baseIds = (u.base_attributes ?? []).map((a) => a[0]);
        for (const id of baseIds) {
            if (!HERO_BASE_ATTRS.includes(id)) {
                err(`${where}：base_attributes 含非法基础属性 ${ATTR_NAME[id] ?? id}（只允许 ${HERO_BASE_ATTRS.map((i) => ATTR_NAME[i]).join('/')}）`);
            }
        }
        for (const id of HERO_BASE_ATTRS) {
            if (!baseIds.includes(id)) warn(`${where}：base_attributes 缺基础属性 ${ATTR_NAME[id]}`);
        }
        if (baseIds.length !== new Set(baseIds).size) err(`${where}：base_attributes 有重复属性编号`);

        const growthIds = (u.growthValues ?? []).map((a) => a[0]);
        for (const id of growthIds) {
            if (!HERO_GROWTH_ATTRS.includes(id)) {
                err(`${where}：growthValues 含非法成长属性 ${ATTR_NAME[id] ?? id}（只允许 ${HERO_GROWTH_ATTRS.map((i) => ATTR_NAME[i]).join('/')}）`);
            }
        }
        if (growthIds.length !== new Set(growthIds).size) err(`${where}：growthValues 有重复属性编号`);
    }
}

// ============================ 2. relics（一件遗物一行，局内版 / 局外版分两侧） ============================

function checkRelics(relics) {
    for (const r of relics) {
        const where = `relics id=${r.id} ${r.name}`;

        if (RELIC_SCOPES.indexOf(r.scope) < 0) {
            err(`${where}：scope=${r.scope ?? '(缺)'} 非法（必须 inner=只有局内版 / outer=只有局外版 / both=两侧都有）`);
            continue;
        }
        const tier = tierOfRarity(r.rarity);
        if (tier === 0) {
            err(`${where}：rarity=${r.rarity} 不在 4 档内（common/rare/epic/legendary）`);
            continue;
        }

        // scope 说的侧别与两侧的列必须对得上
        for (const side of ['inner', 'outer']) {
            const declared = side === 'inner' ? hasInnerSide(r) : hasOuterSide(r);
            const s = relicSide(r, side);
            const filled = s.description !== '' || s.modifiers.length > 0;
            if (declared && !filled && !r.script_id) {
                warn(`${where}：scope 含 ${side}，但 description_${side} / modifiers_${side} 都是空的（这一侧没有任何效果）`);
            }
            if (!declared && filled) {
                err(`${where}：填了 ${s.label}版的效果（description_${side} / modifiers_${side}），但 scope=${r.scope} 不含 ${side}`);
            }
        }

        // 逐侧过门禁：属性词条 + 描述文案
        let hasEffect = false;
        for (const s of [hasInnerSide(r) ? relicSide(r, 'inner') : null, hasOuterSide(r) ? relicSide(r, 'outer') : null]) {
            if (!s) continue;
            const sideWhere = `${where}（${s.label}版）`;
            const attrs = collectRelicAttrs(s.modifiers);
            if (attrs.length || s.modifiers.some((m) => m?.modifier !== 1000) || r.script_id) hasEffect = true;

            for (const { attr } of attrs) {
                if (LEGACY_ATTR_IDS.indexOf(attr[0]) >= 0) {
                    warn(`${sideWhere}：属性用了遗留编号 ${attr[0]}（AttributeType/attributes.json 里没有该属性，不会生效）`);
                    continue;
                }
                const msg = checkAttrAffix(attr, tier, sideWhere);
                if (msg) err(msg);
                if (s.side === 'outer' && OUTER_FORBIDDEN_ATTRS.indexOf(attr[0]) >= 0) {
                    warn(`${sideWhere}：**局外版**给了 ${ATTR_NAME[attr[0]]}（数值配置手册 §4.3 铁律：局外永久加成不给攻速，待定案）`);
                }
            }

            // 描述文案：功能性百分比（红档专属）+ 属性词条越档
            // ⚠ 先剥掉钩子文案（钩子文案里的「攻击速度 +2%」是效果描述，不是本档位的属性承诺）
            const descAttrsOnly = stripHookText(s.description, s.modifiers, r.rarity);
            warnIfFunctionalPercent(descAttrsOnly, tier, sideWhere);
            const badClauses = illegalDescriptionClauses(descAttrsOnly, tier);
            if (badClauses.length) {
                warn(`${sideWhere}：描述文案里有 ${badClauses.length} 条当前档位不允许的属性词条「${badClauses.slice(0, 2).join('、')}」—— 需删除或升档`);
            }
        }

        // 空效果
        if (!hasEffect) warn(`${where}：既没有属性词条也没有 modifiers/script_id（获得后无任何效果）`);
    }
}

/** 描述文案里出现「金币/经验/冷却/幸运…+N%」这类**功能性百分比**时，提示它属于红档专属 */
const FUNCTIONAL_PERCENT_RE = /(金币|金钱|经验|冷却|幸运|抽卡|刷新|掉落|掉落率|收益)[^；;|]{0,6}[+＋-]\s*[\d.]+\s*%/;
function warnIfFunctionalPercent(desc, tier, where) {
    if (!desc || tier >= 4) return;
    const m = FUNCTIONAL_PERCENT_RE.exec(desc);
    if (m) warn(`${where}：描述含功能性百分比「${m[0].trim()}」→ 红档(legendary)专属，当前 ${TIER_LABEL[tier]}（若只是文案残留请删除）`);
}

// 兼容旧引用：遗物描述里的属性词条解析也走 lib 的 parseTermBlock（保留导入便于后续扩展）
void parseTermBlock;

// ============================ main ============================

function main() {
    console.log('▌品质 × 词条门禁体检（tools/excel_export/scripts/check-affix-gating.mjs）');
    console.log(`  数据目录：${path.relative(ROOT, JSON_DIR)}`);

    checkUnits(readJson('units'));
    checkRelics(readJson('relics'));

    const shown = LIMIT > 0 ? LIMIT : Number.MAX_SAFE_INTEGER;
    if (warnings.length) {
        console.log(`\n⚠ 警告 ${warnings.length} 条${STRICT ? '（--strict：视为错误）' : ''}：`);
        for (const w of warnings.slice(0, shown)) console.log('  · ' + w);
        if (warnings.length > shown) console.log(`  ... 其余 ${warnings.length - shown} 条已省略`);
    }
    if (errors.length) {
        console.log(`\n✖ 违规 ${errors.length} 条：`);
        for (const e of errors.slice(0, shown)) console.log('  · ' + e);
        if (errors.length > shown) console.log(`  ... 其余 ${errors.length - shown} 条已省略`);
    }

    const failed = errors.length > 0 || (STRICT && warnings.length > 0);
    console.log(failed
        ? `\n✖ 门禁体检未通过：错误 ${errors.length} / 警告 ${warnings.length}`
        : `\n✔ 门禁体检通过：错误 0 / 警告 ${warnings.length}`);
    process.exitCode = failed ? 1 : 0;
}

main();
