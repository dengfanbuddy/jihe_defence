/**
 * gen-shop-from-hero-design.ts —— 由 docs/hero-design 设计稿生成肉鸽商店配表 JSON
 *
 * 数据源（设计稿，ES5 全局变量）：docs/hero-design/assets/data-*.js
 *   - data-items.js    → window.ITEM_DATA   293 件 dota2 道具
 *   - data-skills.js   → window.RSKILL_DATA 30 个肉鸽额外技能 / window.KBUFF_DATA 20 个击杀 Buff
 *   - data-draw.js     → window.RSKILL_DRAW 品质抽取概率（按英雄等级段）
 *
 * 输出到 assets/resources/tb/：
 *   relics.json      293 件道具 → 遗物的**局内版**（id 1001~1293）+ 原手工遗物（id 1~5）保留
 *   modifiers.json   **只加一条**「属性修改」共享模板（id 1000）+ 手工 Modifier（id 1~26）保留
 *   abilities.json   30 个肉鸽额外技能的**商店行**（scope='shop'，id 101~130；单位技能行原样保留）
 *   kill_buffs.json   20 条
 *   shop_draw.json     4 条
 *
 * relics/modifiers 采用**合并写入**，且**只动「局内版」**（2026-07 起遗物是「一件遗物一行」，
 * 局内版 / 局外版分两侧：`description_inner` / `modifiers_inner` 与 `description_outer` / `modifiers_outer`）：
 *   · `id < 1000` 的手工 demo 遗物 → 整条保留；
 *   · `scope="outer"`（只有局外版，id 1294~1302）→ 整条保留；
 *   · `scope="both"`（局内局外是同一件遗物）→ 保留**局外版与身份列**（`code`/`category`/`description_outer`/`modifiers_outer`），
 *     只把局内版（`name`/`icon`/`rarity`/`description_inner`/`modifiers_inner`）换成设计稿的新值。
 * 脚本可幂等重跑；**重跑后要接着跑 `npm run migrate:affix`**（设计稿给的是百分比原值，需要过品质门禁折算）。
 * 注意：shop_constants.json 是**手写源**，不由本脚本产出／覆盖。
 *
 * 用法：node tools/excel_export/scripts/gen-shop-from-hero-design.ts
 *
 * 口径说明（务必与 schema.ts / 代码保持一致）：
 *   1) **效果原子化**：道具的属性改动不再各占一条 Modifier，而是写进**遗物条目自己的 kv**：
 *        relics.modifiers = [{ "modifier": 1000, "kv": { "attrs": [[3, 14, "percent"]] } }]
 *      1000 是全项目唯一的「属性修改」共享模板（ModifierCfg.effects = [{ type:'modify_attr', attrs_var:'attrs' }]），
 *      属性类型/数值/叠加方式全由 kv.attrs 传入 —— 即「一条效果模板 + 外部参数」。
 *        · 叠加方式 'percent' → 对**英雄基础属性**的百分比加成（value 是百分数：14 = +14%），
 *          多个来源同类**加法叠加**后只对基础值乘算一次（AttributeStackMode.Percent）
 *        · 叠加方式 'add'     → **固定值**加成（不是基础属性）
 *   2) 道具的**被动**（砍树/重击/光环/吃莲花/种植/传送…）需要行为实现，设计稿只给了文字，暂不落表：
 *      文本保留在遗物 `description` 与设计稿 docs/hero-design/ 里；实现时再加独立的 Modifier
 *      （带自己的 `cd` + `effects` / `script_id`，性质属主动的走 abilities.json）。
 *      原先那批「空壳被动 Modifier」已删除，勿再批量生成。
 *   3) 遗物 id / 模板 id 见下方 RELIC_ID_BASE 注释；道具的「阶段」由 rarity 推导
 *      （白 1 / 蓝 2 / 黄 3 / 红 4），不落列。
 *   4) 设计稿把「品质」写成 white/blue/gold/red（技能写 common/rare/epic/legendary），
 *      统一映射为项目既有枚举 common/rare/epic/legendary（白/蓝/黄/红），与 relics.rarity 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DESIGN_DIR = path.join(ROOT, 'docs/hero-design/assets');
const OUT_DIR = path.join(ROOT, 'assets/resources/tb');

/**
 * ⚠ **2026-10 起本脚本默认拒绝运行**（局内遗物效果重做落地的连带处理）。
 *
 * 原因：它按 `docs/hero-design`（Dota2 道具库）重写 `relics.json` 的**局内版**
 * （`name`/`icon`/`rarity`/`description_inner`/`modifiers_inner`），而局内遗物的效果重做已经落地 ——
 * 设计真源 = `scripts/lib/relic-inner-design.mjs`，落表脚本 = `gen-relics-inner-from-design.mjs`，
 * 钩子实现 = `assets/scripts/game/battle/RelicHooks.ts`。**重跑本脚本会把整套设计覆盖回 Dota2 老效果**
 * （砍树 / 天神下凡 / 冰霜光环…），所以它现在只剩考古用途，要跑必须显式声明。
 */
if (!process.argv.includes('--legacy-dota2')) {
    console.error('✖ gen-shop-from-hero-design 已停用：重跑会覆盖 2026-10 落地的局内遗物设计。');
    console.error('  · 要改局内遗物：npm run gen:relic-design → gen:relic-hooks → gen:relics-inner（再回灌 xlsx）');
    console.error('  · 确实要跑老管线（考古/对比）：显式加 --legacy-dota2');
    process.exit(1);
}

// ============================ 设计稿加载 ============================

/** 在沙箱里执行设计稿脚本，取出挂在 window 上的数据 */
function loadDesign(): Record<string, any> {
    const sandbox: any = { window: {} };
    vm.createContext(sandbox);
    for (const f of ['data-items.js', 'data-skills.js', 'data-draw.js']) {
        const file = path.join(DESIGN_DIR, f);
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: f });
    }
    return sandbox.window;
}

// ============================ 映射表 ============================

/** 品质：设计稿 → 项目枚举 */
const RARITY: Record<string, string> = {
    // 道具写 white/blue/gold/red，技能写 common/rare/epic/legendary，统一到后者
    white: 'common', blue: 'rare', gold: 'epic', red: 'legendary',
    common: 'common', rare: 'rare', epic: 'epic', legendary: 'legendary',
};
/** 品质 → 阶段（与 rarity 同序，供 shop_skills.stage 使用；道具的阶段由品质推导，不落列） */
const RARITY_STAGE = { common: 1, rare: 2, epic: 3, legendary: 4 };

/** 设计稿属性中文名 → 属性键（对齐 Tb_ShopItemConfig 的 ShopItemAttrKey） */
const ATTR_KEY: Record<string, string> = {
    攻击力: 'atk',
    生命: 'hp',
    回复: 'regen',
    护甲: 'def',
    攻速: 'aspd',
    暴击: 'crit',
    闪避: 'dodge',
    // 无 AttributeType 的派生属性（暂时无法落进 modifiers.properties，见 parseSuggest 的说明）
    冷却: 'cdr',                 // 设计稿写「冷却 -7%」= 冷却缩减 7%
    金币获取: 'goldGain',
    元素强度: 'elementPower',
    召唤物强度: 'summonPower',
};

/** 属性键 → AttributeType 编号（modifiers.properties 的键）；-1 = 暂无 AttributeType，无法落表 */
const ATTR_KEY_TO_ID: Record<string, number> = {
    hp: 1, mana: 2, atk: 3, aspd: 4, moveSpeed: 5, def: 6, magicResist: 7,
    dodge: 8, regen: 9, manaRegen: 10, damageOut: 11, crit: 14, critDmg: 15, range: 16,
    cdr: -1, goldGain: -1, elementPower: -1, summonPower: -1,
};

/** 击杀 Buff 的 stat → AttributeType 编号 */
const KBUFF_ATTR_ID = {
    atk: 3, hp: 1, range: 16, def: 6, aspd: 4, crit: 14, dodge: 8, regen: 9,
};

// ============================ 解析 ============================

const warnings: string[] = [];

/**
 * 解析设计稿 suggest，如 "攻击力 +14% | 生命 +18% | 回复 +7%" / "冷却 -7% | 金币获取 +8%"
 * @returns [属性键, 百分数][]（14 = +14%）
 */
function parseSuggest(suggest: string): [string, number][] {
    const out: [string, number][] = [];
    if (!suggest || suggest.includes('技能强化')) return out;

    const re = /([^|+]+?)\s*([+-])\s*([\d.]+)\s*%/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(suggest)) !== null) {
        const key = m[1].trim();
        const sign = m[2] === '-' ? -1 : 1;
        const val = Number(m[3]) * sign;
        const attrKey = ATTR_KEY[key];
        if (attrKey) {
            // 设计稿用负号表达「冷却缩减」，统一存为正数收益
            out.push([attrKey, attrKey === 'cdr' ? Math.abs(val) : val]);
        } else {
            warnings.push(`suggest 未识别的词条「${key}」：${suggest}`);
        }
    }
    if (out.length === 0) warnings.push(`suggest 无法解析：${suggest}`);
    return out;
}

/** 清掉设计稿 effect 文本里的「效果：」前缀，便于拼进 effect_desc */
function cleanEffectText(effect: string): string {
    return (effect ?? '').replace(/效果：/g, '').replace(/^[；;、\s]+|[；;、\s]+$/g, '').trim();
}

/**
 * 兜底：解析设计稿 effect 原文里的属性数值（仅在 suggest 没给出本作换算时使用）。
 *
 * 产出的是 modifier `properties` 的**配置值**（固定值 / add 叠加）：
 *   - 无「%」且属性**非百分比型**（生命/魔法/攻击力/移速/护甲/回复/射程）
 *       → value = n            例：最大生命 +60 → hp +60
 *   - 带「%」且属性是**百分比型**（攻速/魔抗/闪避/伤害输出/暴率/暴伤，见 AttributeScaling.SCALE）
 *       → value = n            例：魔法抗性 +1.2% → 配置值 1.2（缩放型属性的 int 口径本身就是百分数）
 *   - 其余组合一律跳过：
 *       「攻击力 +10%」这种「对基础属性乘算」的写法属于 suggest 的职责，
 *       混进这里会让同一件道具出现两种百分比语义。
 */
const RAW_ATTR_KEY: Record<string, { key: string; scaled: boolean }> = {
    最大生命: { key: 'hp', scaled: false }, 生命: { key: 'hp', scaled: false },
    最大魔法: { key: 'mana', scaled: false }, 魔法: { key: 'mana', scaled: false },
    攻击力: { key: 'atk', scaled: false },
    移动速度: { key: 'moveSpeed', scaled: false },
    护甲: { key: 'def', scaled: false },
    生命恢复: { key: 'regen', scaled: false },
    魔法恢复: { key: 'manaRegen', scaled: false },
    攻击距离: { key: 'range', scaled: false }, 攻击范围: { key: 'range', scaled: false },
    攻击速度: { key: 'aspd', scaled: true },
    魔法抗性: { key: 'magicResist', scaled: true },
    闪避几率: { key: 'dodge', scaled: true }, 闪避: { key: 'dodge', scaled: true },
    伤害输出: { key: 'damageOut', scaled: true },
    暴击: { key: 'crit', scaled: true },
    暴击伤害: { key: 'critDmg', scaled: true }, 暴击倍率: { key: 'critDmg', scaled: true },
};

function parseRawAttrs(effect: string): { key: string; value: number }[] {
    const out: { key: string; value: number }[] = [];
    const re = /([^；;:：]+?)\s*[+＋]\s*([\d.]+)\s*(%?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(effect ?? '')) !== null) {
        const hit = RAW_ATTR_KEY[m[1].trim()];
        if (!hit) continue;
        if (hit.scaled !== (m[3] === '%')) continue; // 只处理「非缩放+无%」与「缩放+有%」
        out.push({ key: hit.key, value: Number(m[2]) });
    }
    return out;
}

/** 一次性描述全部效果：设计稿 suggest（本作换算）+ 设计稿 effect（原始机制） */
function buildEffectDesc(it: any): string {
    const parts: string[] = [];
    const suggest = (it.suggest ?? '').trim();
    if (suggest && !suggest.includes('技能强化')) parts.push(suggest);
    const effectText = cleanEffectText(it.effect);
    if (effectText) parts.push(effectText);
    if (!parts.length) {
        const ability = (it.ability ?? '').split('\n')[0].trim();
        parts.push(ability || it.name);
    }
    return parts.join('；');
}

// ============================ 构建各表 ============================

/**
 * 道具 → 遗物的编号规则
 *
 *   遗物 id            = 1000 + 设计稿道具 id   （1001 ~ 1293）
 *   属性修改共享模板 id = 1000                   （全项目唯一一条，与 battle/types.ts 的 MODIFY_ATTR_TEMPLATE_ID 一致）
 *
 * id < 1000 的条目是**手工维护**的旧遗物/Modifier（demo 用），脚本不碰。
 * 1000 段不再「一物一 Modifier」：纯属性加成统一引用共享模板 + kv.attrs 传参。
 */
const RELIC_ID_BASE = 1000;
/** 属性修改共享模板 id（必须与 assets/scripts/game/battle/types.ts 的 MODIFY_ATTR_TEMPLATE_ID 一致） */
const ATTR_TEMPLATE_MOD_ID = 1000;

/** 无法落进遗物 kv.attrs 的属性键（暂无 AttributeType），只统计不落表 */
const skippedAttrKeys = new Map<string, number>();

/** 「属性修改」共享模板：属性类型/数值/叠加方式全部由施加方 kv.attrs 传入 */
const ATTR_TEMPLATE_MOD: Record<string, any> = {
    id: ATTR_TEMPLATE_MOD_ID,
    name: '属性修改',
    is_debuff: false,
    is_hidden: true,
    dispel_level: 0,
    duration: -1,               // 永久：直到本局结束
    stack_mode: 'none',         // 实例身份 = (模板 id, origin)，origin = relic:<遗物id>，遗物间互不干扰
    effects: [{ type: 'modify_attr', attrs_var: 'attrs' }],
};

/**
 * 293 件道具 → 遗物的**局内版**。
 *
 * 每件遗物只有 **1 条** modifiers_inner 引用（属性为空则没有）：
 *   `{ modifier: 1000, duration: null, kv: { attrs: [[属性id, 值, 叠加方式], ...] } }`
 * 即「遗物 → Modifier」两层，效果模板共用、参数外置在遗物条目里。
 *
 * `description_inner` 即玩家可见的一次性效果总述（含被动原文，被动行为待实现）。
 * `scope` 一律先写 `inner`；若这件遗物已有局外版，`mergeInto` 会把它修成 `both`。
 */
function buildItemRelics(w: Record<string, any>): any[] {
    const relics: any[] = [];

    for (const it of w.ITEM_DATA) {
        const rarity = RARITY[it.quality as keyof typeof RARITY];
        if (!rarity) warnings.push(`item ${it.id} 品质未识别：${it.quality}`);

        const relicId = RELIC_ID_BASE + it.id;

        // ---------- 属性：一条共享模板引用，参数外置 ----------
        // 优先用设计稿 suggest 的百分比换算；没有时退回解析原文里的固定值
        const attrs: [number, number, string][] = [];
        const suggested = parseSuggest(it.suggest ?? '');
        if (suggested.length) {
            for (const [key, value] of suggested) {
                const attrId = ATTR_KEY_TO_ID[key];
                if (attrId === undefined || attrId < 0) {
                    skippedAttrKeys.set(key, (skippedAttrKeys.get(key) ?? 0) + 1);
                    continue;
                }
                attrs.push([attrId, value, 'percent']);
            }
        } else {
            for (const { key, value } of parseRawAttrs(it.effect)) {
                const attrId = ATTR_KEY_TO_ID[key];
                if (attrId === undefined || attrId < 0) continue;
                attrs.push([attrId, value, 'add']);
            }
        }

        const rec: Record<string, any> = {
            id: relicId,
            name: it.name,
            icon: it.img,
            rarity,
            scope: 'inner',
            description_inner: buildEffectDesc(it),
        };
        if (attrs.length) {
            rec.modifiers_inner = [{ modifier: ATTR_TEMPLATE_MOD_ID, duration: null, kv: { attrs } }];
        }
        relics.push(rec);
    }

    return relics;
}

/** 肉鸽额外技能在 abilities 表里的 id 段（设计稿 id 1~30 → 101~130，避开单位技能 id 1~22） */
const SHOP_SKILL_ID_BASE = 100;

/**
 * 设计稿的 30 个肉鸽额外技能 → abilities 行。
 *
 * ⚠ 设计稿只给了「文案」：分裂弹 / 召唤炮台 / 时间回廊 这类机制现有 ConfigAction 词汇表表达不了，
 *   所以这里只落 `behavior: 'passive'` + `effects: []`，**不带战斗效果** ——
 *   要生效得给条目补 `effects`（纯属性/DoT 类）或 `script_id`（复杂机制），与遗物被动的处境相同。
 *   好消息是这个文件重跑时会**按 id 覆盖**商店技能行，所以将来手工补的效果会被设计稿重跑冲掉，
 *   补效果请改这里或改用 `merge-shop-skills-into-abilities.mjs` 之外的维护方式。
 */
function buildShopSkills(w: Record<string, any>): any[] {
    return w.RSKILL_DATA.map((sk: any) => {
        const rarity = RARITY[sk.rarity as keyof typeof RARITY];
        if (!rarity) warnings.push(`skill ${sk.id} 品质未识别：${sk.rarity}`);
        const rec: Record<string, any> = {
            id: Number(sk.id) + SHOP_SKILL_ID_BASE,
            name: sk.name,
            code: sk.code,
            name_en: sk.en,
            scope: 'shop',
            behavior: 'passive',
            cooldown: 0,
            mana_cost: 0,
            effects: [],
            rarity,
            stage: RARITY_STAGE[rarity as keyof typeof RARITY_STAGE] ?? 1,
            weight: sk.weight,
            max_level: sk.lv3 ? 3 : sk.lv2 ? 2 : 1,
        };
        if (Array.isArray(sk.tags) && sk.tags.length) rec.tags = sk.tags;
        rec.lv1 = sk.lv1;
        if (sk.lv2) rec.lv2 = sk.lv2;
        if (sk.lv3) rec.lv3 = sk.lv3;
        if (sk.synergy) rec.synergy = sk.synergy;
        return rec;
    });
}

function buildKillBuffs(w: Record<string, any>): any[] {
    return w.KBUFF_DATA.map((b: any) => {
        const rec: Record<string, any> = {
            id: b.id,
            code: b.code,
            name: b.name,
            stat: b.stat,
            per: 0,
            per_desc: b.per,
            max_stack: b.max,
            price: b.price,
            price_growth: b.growth,
        };
        const attrId = KBUFF_ATTR_ID[b.stat as keyof typeof KBUFF_ATTR_ID];
        if (attrId !== undefined) {
            rec.attr_id = attrId;
            const m = /([\d.]+)\s*%/.exec(b.per ?? '');
            rec.per = m ? Number(m[1]) : 0;
        } else {
            // special：机制由代码实现，per 保持 0
            rec.per = 0;
            rec.script_id = `KillBuff_${b.code}`;
        }
        if (Array.isArray(b.tags) && b.tags.length) rec.tags = b.tags;
        if (b.note) rec.note = b.note;
        return rec;
    });
}

function buildShopDraw(w: Record<string, any>): any[] {
    const BAND_LEVEL: Record<string, [number, number]> = {
        '英雄 Lv.1-9': [1, 9],
        '英雄 Lv.10-19': [10, 19],
        '英雄 Lv.20-29': [20, 29],
        '英雄 Lv.30': [30, 30],
    };
    return w.RSKILL_DRAW.map((d: any, i: number) => {
        const lv = BAND_LEVEL[d.band] ?? [1, 30];
        if (!BAND_LEVEL[d.band]) warnings.push(`抽取档位「${d.band}」未映射等级区间`);
        return {
            id: i + 1,
            band: d.band,
            level_min: lv[0],
            level_max: lv[1],
            common: d.white,
            rare: d.blue,
            epic: d.gold,
            legendary: d.red,
            // 越阶概率：设计稿未给数值，取 15% 作为初值（策划在表里调）
            upgrade_chance: 15,
        };
    });
}

// ============================ 写盘 ============================

/** 与导表工具 writeJsonFile 保持一致的格式（2 空格缩进 + 末尾换行） */
function writeJson(name: string, data: unknown): void {
    const file = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    const rows = Array.isArray(data) ? data.length : Object.keys(data as object).length;
    console.log(`  ✔ ${(`assets/resources/tb/${name}.json`).padEnd(46)} ${String(rows).padStart(4)} 条`);
}

/** abilities 表字段顺序（与 src/core/schema.ts 保持一致，写盘时按列序排） */
const ABILITY_KEYS = [
    'id', 'name', 'code', 'name_en', 'scope', 'icon',
    'behavior', 'cooldown', 'mana_cost', 'cast_range', 'cast_point',
    'damage_type', 'damage', 'targeting', 'effects', 'script_id',
    'level', 'level_damage', 'upgrades_to', 'projectile_prefab',
    'rarity', 'stage', 'weight', 'max_level', 'tags',
    'lv1', 'lv2', 'lv3', 'effects_lv2', 'effects_lv3', 'synergy',
];

/** 按 schema 列序整理 abilities 字段，并丢掉空值/空数组 */
function orderAbility(row: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of ABILITY_KEYS) {
        const v = row[key];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && !v.length) continue;
        out[key] = v;
    }
    return out;
}

/**
 * 把设计稿的**肉鸽额外技能**合并进 `abilities.json`（原 `shop_skills` 表已并入本表）。
 *
 * 保留规则（脚本可幂等重跑）：
 *   · `scope` 不是 `shop` 的条目（单位技能 / 手工条目）→ **整条保留**，设计稿不碰；
 *   · `scope="shop"` 且 id 命中设计稿段（`SHOP_SKILL_ID_BASE + 设计稿id`）→ 换成设计稿的新值。
 */
function mergeShopSkillsIntoAbilities(generated: any[]): void {
    const file = path.join(OUT_DIR, 'abilities.json');
    const existing: any[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const kept = existing.filter(r => r.scope !== 'shop');
    const keptIds = new Set(kept.map(r => r.id));
    const merged = generated.filter(g => !keptIds.has(g.id));
    const all = [...kept, ...merged].map(orderAbility).sort((a, b) => a.id - b.id);
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
    console.log(`  abilities.json  保留非商店条目 ${kept.length} 条，写入肉鸽技能 ${merged.length} 条（共 ${all.length} 条）`);
}

/** relics 表字段顺序（与 src/core/schema.ts 保持一致，写盘时按列序排） */
const RELIC_KEYS = [
    'id', 'name', 'code', 'icon', 'rarity', 'scope', 'category',
    'description_inner', 'modifiers_inner', 'description_outer', 'modifiers_outer', 'script_id',
];

/** 按 schema 列序整理字段，并丢掉空值/空数组（= 导表口径「留空则不输出该字段」） */
function orderRelic(row: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of RELIC_KEYS) {
        const v = row[key];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && !v.length) continue;
        out[key] = v;
    }
    return out;
}

/** 这件遗物有局内版吗（scope=inner / both） */
function hasInnerSide(r: Record<string, any>): boolean {
    return r.scope === 'inner' || r.scope === 'both' || r.scope === undefined;
}

/** 这件遗物有局外版吗（scope=outer / both） */
function hasOuterSide(r: Record<string, any>): boolean {
    return r.scope === 'outer' || r.scope === 'both';
}

/**
 * 把生成的条目合并进已有 JSON：**只更新「局内版」**（详见文件头注释）。
 *
 * 保留规则（脚本可幂等重跑）：
 *   · `id < RELIC_ID_BASE` 的手工 demo 遗物 → 整条保留；
 *   · `scope="outer"`（只有局外版，id 1294~1302）→ 整条保留；
 *   · `scope="both"` → 保留**局外版与身份列**，只换局内版（还要把 scope 修正为 `both`）。
 */
function mergeInto(name: string, generated: any[]): void {
    const file = path.join(OUT_DIR, `${name}.json`);
    const existing: any[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const byId = new Map<number, Record<string, any>>();
    for (const r of existing) if (typeof r.id === 'number') byId.set(r.id, r);

    const kept = existing.filter(r => typeof r.id !== 'number' || r.id < RELIC_ID_BASE || !hasInnerSide(r));
    let withOuter = 0;
    const merged = generated.map(g => {
        const old = byId.get(g.id);
        if (!old || !hasOuterSide(old)) return g;
        withOuter++;
        return {
            ...g,
            scope: 'both',
            code: old.code,
            category: old.category,
            description_outer: old.description_outer,
            modifiers_outer: old.modifiers_outer,
        };
    });

    const all = [...kept, ...merged].sort((a, b) => a.id - b.id);
    // ⚠ 只有 relics 是「一件遗物一行」的新结构（需要按列序整理 + 丢空值）；
    //   `mergeInto` 也被 modifiers 表复用，那些表必须**原样写回**，否则会被 orderRelic 把字段吃掉
    writeJson(name, name === 'relics' ? all.map(orderRelic) : all);
    console.log(`     ${' '.repeat(2)}（保留手工/仅局外条目 ${kept.length} 条，写入生成条目 ${merged.length} 条，其中 ${withOuter} 条带局外版）`);
}

function main(): void {
    const w = loadDesign();

    console.log('▌由 docs/hero-design 生成肉鸽商店配表 JSON');

    // 293 件道具 → 遗物（属性走共享模板 + kv.attrs），modifiers 只补一条共享模板
    const relics = buildItemRelics(w);
    mergeInto('relics', relics);
    mergeInto('modifiers', [ATTR_TEMPLATE_MOD]);

    // 30 个肉鸽额外技能 → 并入 abilities 表（scope='shop'，id 101~130）
    mergeShopSkillsIntoAbilities(buildShopSkills(w));
    writeJson('kill_buffs', buildKillBuffs(w));
    writeJson('shop_draw', buildShopDraw(w));

    if (skippedAttrKeys.size) {
        const detail = [...skippedAttrKeys.entries()].map(([k, n]) => `${k}×${n}`).join('、');
        warnings.push(`以下属性暂无 AttributeType，未落进遗物 kv.attrs（仅保留在 description 文案里）：${detail}`);
    }
    if (warnings.length) {
        console.log(`\n⚠ ${warnings.length} 条提示：`);
        for (const s of warnings) console.log('  · ' + s);
    }
    console.log('\n完成。接着执行：cd tools/excel_export && npm run import -- --force --table relics,modifiers,abilities,kill_buffs,shop_draw');
}

main();
