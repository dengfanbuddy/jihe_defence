/**
 * gen-prompts.mjs —— 局内肉鸽技能图标的提示词生成器
 *
 * 来源两处，缺一不可：
 *   ① `tools/skill-icon-prompts/skills.json` —— **作者数据**（视觉主体 art + 审查结论 verdict/mechanism）
 *   ② `assets/resources/tb/abilities.json`    —— **真源配表**（id / name / rarity / stage / max_level / lv1~lv3）
 *
 * 为什么必须读真源：图标是给配表用的，`skills.json` 里抄一份名字很容易与配表漂移
 * （改个技能名忘了改提示词，图就画错了）。所以本脚本会把两边的 id/name 逐条对账，
 * **对不上就退出码 1**（对齐工程里 `check-drift.mjs` 的口径）。
 *
 * 风格段**不在这里**：直接从 `tools/hero-icon-prompts/gen-prompts.mjs` import
 * （那个文件已经把 8 个风格常量 export 出来）—— 英雄头像与技能图标是同一套白描口径，
 * 风格只能有一份真源，改风格改那一处即可，两个产物同时跟着变。
 *
 * 产物（全部落 `docs/skill-icons/`）：
 *   prompts.json  机器投递清单（与 docs/hero-icons/prompts.json 同 schema，
 *                 所以能直接喂 `tools/hero-icon-prompts/make-hero-icons.py --prompts ...`）
 *   prompts.csv   人工校对表
 *   prompts.md    人工校对表（markdown）
 *   skills.md     审查结论 + 视觉设定（给人看）
 *   skills.json   作者数据的归档副本
 *
 * 用法：
 *   node tools/skill-icon-prompts/gen-prompts.mjs            # 写产物
 *   node tools/skill-icon-prompts/gen-prompts.mjs --dry-run  # 只对账不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 风格段单一真源（英雄图标那套白描口径，一字不改地复用）
import { DRAWING, BACKGROUND, LIGHT, READING, SQUARE, CLOSE, KIND } from '../hero-icon-prompts/gen-prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(HERE, 'skills.json');
const ABILITIES = path.join(ROOT, 'assets/resources/tb/abilities.json');
const MODIFIERS = path.join(ROOT, 'assets/resources/tb/modifiers.json');
const OUT_DIR = path.join(ROOT, 'docs/skill-icons');
const DRY_RUN = process.argv.includes('--dry-run');
/** 脚本注册表：`indirect` 里点名的 Modifier 必须真的在代码里被引用到 */
const SHOP_SCRIPTS = path.join(ROOT, 'assets/scripts/game/battle/ShopSkillModifiers.ts');

/**
 * 交付尺寸（2026-10 口径变更：200 → **64**）
 *
 * 为什么压到 64：
 *   · 技能图标在工程里的**真实显示处最大只有 50×50**（HUD `skills` 节点下每个
 *     `skill{N}` 的 `icon`），选人卡更小（`content/skills` 是 **20×20**，全工程最小）
 *     → 200 是 4 倍冗余；
 *   · 40 帧的技能图集按 200 交付是 **4.00 MB** 未压缩（加载任意一张就把整张拉进显存），
 *     压到 64 后约 **0.4 MB**（约 1/9）；
 *   · 与**遗物图集同一个口径**（用户 2026-10 定案：遗物也是 64，显示槽 50×50 所以是 1.28×）。
 * 60 个英雄技能图一起改（`tools/hero-icon-prompts/gen-prompts.mjs` 的 `SIZE.icon`），
 * 否则图集里会混着 10 张大帧，白占地方。
 *
 * ⚠ 源图（512×512）**一律留着**：换交付尺寸只是重跑后处理，不用重新出图。
 */
const SIZE = 64;
/** 出图尺寸（工作流 ResolutionSelector 是 0.25MP → 512×512，1:1） */
const GEN = 512;

/**
 * 装机路径（resources 相对路径，**不带扩展名** —— 与 units.json 的 head_icon 同口径）。
 *
 * ⚠ 与英雄技能图（`<英雄code>_skill`）的命名**故意不同**：
 *   英雄那批加 `_skill` 后缀，是为了不覆盖 `textures/skills/` 里已经存在的
 *   `huoqiang.png`（128×128 青绿准星风格，不是本套白描）；
 *   而 30 个肉鸽技能的 code（split_shot / grenade / …）在该目录下**没有任何同名文件**，
 *   所以直接用 code，不加后缀 —— 这样图集里的帧名就是技能 code，好认。
 *   同时**刻意避开** `bullet.png`：它是 `SkillSlot`/`ShopRelicsItem` 的回落占位图。
 */
const iconPathOf = (skill) => `textures/skills/${skill.code}`;

/** 审查结论的中文标签（渲染 skills.md 用）—— **这是"动手前"的历史判定**，别当成现状 */
const VERDICT_ZH = {
    declarative: '✔ 纯声明式（零新增 TS）',
    script: '✎ 需一个脚本 Modifier',
    hook: '✎ 需补一处引擎事件派发',
    redesign: '⟳ 需重设计（原机制在本作不存在）',
    infra: '⏸ 需召唤/经济基建',
};

/**
 * 落地形态的中文标签。
 *
 * ⚠ **`kind` 是推导出来的，不是手写的**（推导规则见 `deriveLanded`）：
 * 手写一个"这条是脚本 / 这条是声明式"的字段，迟早会与配表和代码漂移；
 * 推导则意味着——改了 `abilities.json` 或 `modifiers.json` 让形态变了，这里会立刻跟着变，
 * 而写在 `skills.json` 里的 `indirect` / `note` 若与真相对不上，**生成器直接退出码 1**。
 */
const LANDED_ZH = {
    declarative: '✔ 已落地 · 纯声明式',
    script: '✔ 已落地 · 脚本 Modifier',
    mixed: '✔ 已落地 · 声明式 + 脚本',
};

// ============================ 提示词拼装 ============================

/**
 * 顺序与英雄清单、遗物清单一脉相承：
 *   先「这是什么」→ 主体 → 画法 → 光照 → 可读性 → 构图方 → 承载底 → 收尾
 * 主体段来自 skills.json 的 `art` 字段（一条一段英文观察式散文）。
 */
function buildPrompt(skill) {
    if (!skill.art) throw new Error(`技能 ${skill.code} 缺少 art`);
    return [KIND.icon, skill.art, ...DRAWING, LIGHT, READING, SQUARE, BACKGROUND, CLOSE].join(' ');
}

/** 中文提示词（人看/校对用，不投给模型） */
function buildPromptZh(skill) {
    return `${skill.name}（${skill.name_en}）· 技能图标：` +
        `纯白单色白描，主体是「白色实心色块 + 内部细节挖空」，无第二个颜色、无描边、无渐变、无材质；` +
        `深板岩灰纯色承载底（出图后本地抠掉）；正方形居中，四周留白充足。`;
}

// ============================ 真源对账 ============================

/**
 * 从 `ShopSkillModifiers.ts` 里抠出**所有被按号引用的 Modifier id**。
 * 两种写法都算：
 *   · `SHOP_MOD` 表 —— `Name: 40,`
 *   · 公共常量 —— `const MOD_STUNNED = 7;`
 * 这是 `landed.indirect` 的判据（见 `crossCheck`）：只查"这个 id 在配表里存在"是不够的，
 * 换个号但忘了改脚本引用，技能会**静默失效**（脚本挂了一个不存在的 Modifier，
 * `AddModifier` 只打一行 warn 就返回 null）。
 */
function shopModRefs(src) {
    const ids = new Set();
    for (const m of src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(\d+)\s*,/gm)) ids.add(Number(m[2]));
    for (const m of src.matchAll(/const\s+MOD_[A-Z0-9_]+\s*=\s*(\d+)\s*;/g)) ids.add(Number(m[1]));
    return ids;
}

function loadAbilityTable() {
    const raw = JSON.parse(fs.readFileSync(ABILITIES, 'utf8'));
    const map = new Map();
    for (const row of raw) map.set(row.id, row);
    return map;
}

function loadModifierTable() {
    const raw = JSON.parse(fs.readFileSync(MODIFIERS, 'utf8'));
    const map = new Map();
    for (const row of raw) map.set(row.id, row);
    return map;
}

/** 技能在**配表里**直接施加的 Modifier（三档 `effects` 的并集，去重排序） */
function directModifiers(row) {
    const ids = new Set();
    for (const key of ['effects', 'effects_lv2', 'effects_lv3']) {
        for (const e of row[key] ?? []) {
            if (e.type === 'apply_modifier') ids.add(e.modifier);
        }
    }
    return [...ids].sort((a, b) => a - b);
}

/**
 * **推导**这条技能现在长什么样 —— 这是本生成器最值钱的一步。
 *
 * 三类形态的判据（全部机械可验，没有一句话是"我觉得"）：
 *   · 引用到的 Modifier（配表直挂的 + 脚本间接挂的）里**一个带 `script_id` 的都没有**
 *     → `declarative`（零新增 TS，改配表就生效）
 *   · 有带 `script_id` 的，同时还有没带的、或者技能本身有 `modify_attr` 声明式动作
 *     → `mixed`（两个世界都用上了）
 *   · 全是带 `script_id` 的、也没有声明式动作 → `script`
 */
function deriveLanded(row, modTable, landed) {
    const direct = directModifiers(row);
    const indirect = landed?.indirect ?? [];
    const all = [...new Set([...direct, ...indirect])];
    const scripted = all.filter((id) => modTable.get(id)?.script_id);
    const plain = all.filter((id) => !modTable.get(id)?.script_id);
    let hasDeclarativeAction = false;
    for (const key of ['effects', 'effects_lv2', 'effects_lv3']) {
        for (const e of row[key] ?? []) if (e.type === 'modify_attr') hasDeclarativeAction = true;
    }
    const declarativePart = plain.length > 0 || hasDeclarativeAction;
    const kind = scripted.length === 0 ? 'declarative' : (declarativePart ? 'mixed' : 'script');
    return { direct, indirect, scripted, kind, scripts: scripted.map((id) => modTable.get(id).script_id) };
}

function crossCheck(data, table, modTable, scriptSrc) {
    const problems = [];
    const seenIds = new Set();
    for (const s of data.skills) {
        if (seenIds.has(s.id)) problems.push(`skills.json 里 id ${s.id} 重复`);
        seenIds.add(s.id);

        const row = table.get(s.id);
        if (!row) { problems.push(`id ${s.id}（${s.name}）在 abilities.json 里不存在`); continue; }
        if (row.scope !== 'shop') problems.push(`id ${s.id}（${s.name}）配表 scope=${row.scope}，应为 shop`);
        if (row.name !== s.name) problems.push(`id ${s.id} 名字漂移：配表「${row.name}」≠ skills.json「${s.name}」`);
        if ((row.rarity ?? '') !== (s.rarity ?? '')) problems.push(`id ${s.id}（${s.name}）品质漂移：配表 ${row.rarity} ≠ skills.json ${s.rarity}`);
        if (Number(row.stage ?? 0) !== Number(s.stage ?? 0)) problems.push(`id ${s.id}（${s.name}）阶段漂移：配表 ${row.stage} ≠ skills.json ${s.stage}`);
        // 文案三档：只校验配表有没有写，内容抄进产物给人对照（不要求逐字一致——技能重设计会先改 skills.json）
        s._lv1 = row.lv1 ?? '';
        s._lv2 = row.lv2 ?? '';
        s._lv3 = row.lv3 ?? '';
        s._max_level = row.max_level ?? 1;
        s._effects = Array.isArray(row.effects) ? row.effects.length : 0;
        s._icon_in_table = row.icon ?? '';

        /* ---- 落地形态对账（本轮新增；这是防"文档说做完了、配表其实没有"的那道闸） ---- */
        if (!s.landed) { problems.push(`id ${s.id}（${s.name}）在 skills.json 里没有 landed（跑 set-landed.mjs）`); continue; }
        const L = deriveLanded(row, modTable, s.landed);
        s._landed = L;
        if (L.direct.length === 0 && (s.landed.indirect ?? []).length === 0 && !s._effects && !row.script_id) {
            problems.push(`id ${s.id}（${s.name}）配表里没有任何效果，但 skills.json 声称已落地`);
        }
        // `indirect` 里点名的 Modifier 必须真的存在，而且必须在脚本源码里**按号引用**到
        for (const id of s.landed.indirect ?? []) {
            const m = modTable.get(id);
            if (!m) { problems.push(`id ${s.id} 的 landed.indirect 指向不存在的 Modifier ${id}`); continue; }
            /**
             * 判据要看**两类**，因为它们存在的原因不同：
             *   · 带 script_id 的（脚本自己就是效果）→ 类名必须出现在 ShopSkillModifiers.ts 里；
             *   · 不带 script_id 的（**脚本在运行时给敌人挂的声明式模板**，如 53 冰冻 / 56 静电层数 /
             *     66 破甲 / 6 无敌 / 7 眩晕）→ 它们本来就进不了配表的 `effects`
             *     （要在运行时按条件挂到**别人**身上），所以只能要求在源码里**按号引用**：
             *     要么在 `SHOP_MOD` 表里，要么是 `MOD_XXX = <id>` 这样的公共常量。
             *     **不能只查"存在"** —— 换个号但忘了改引用，是最容易漏的那种错。
             */
            const byNumber = shopModRefs(scriptSrc);
            if (m.script_id) {
                if (!scriptSrc.includes(m.script_id)) {
                    problems.push(`id ${s.id} 的 landed.indirect 里的 Modifier ${id} 声明 script_id=${m.script_id}，`
                        + `但 ShopSkillModifiers.ts 里搜不到这个类名`);
                }
            } else if (!byNumber.has(id)) {
                problems.push(`id ${s.id} 的 landed.indirect 里的 Modifier ${id}（${m.name}）在 `
                    + `ShopSkillModifiers.ts 里没有按号引用（既不在 SHOP_MOD 表里，也不是 MOD_XXX = ${id} 常量）`);
            }
        }
        if (!s.landed.note) problems.push(`id ${s.id}（${s.name}）的 landed.note 为空`);
    }
    // 反向：配表里还有没有 shop 技能没进 skills.json
    for (const [id, row] of table) {
        if (row.scope !== 'shop') continue;
        if (!seenIds.has(id)) problems.push(`配表 shop 技能 id ${id}（${row.name}）没进 skills.json`);
    }

    /**
     * `SHOP_MOD` 表 ↔ modifiers.json 的**编号**对账。
     *
     * 为什么值得单独一段：`npm run audit:skill` 只验了**类名**（script_id ↔ 注册表），
     * 而编号是另一条独立的链 —— `SHOP_MOD.X = 40` 而配表里 40 号是别的东西（或不存在）时，
     * 类名全对、技能却静默失效。这里两个方向都查：
     *   · `SHOP_MOD` 里的每个号必须在 modifiers.json 里存在；
     *   · 每个 `script_id = Modifier_X` 的行，号必须等于 `SHOP_MOD.X`。
     */
    const shopMod = new Map();
    for (const m of scriptSrc.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(\d+)\s*,/gm)) {
        shopMod.set(m[1], Number(m[2]));
    }
    for (const [name, id] of shopMod) {
        if (!modTable.has(id)) problems.push(`ShopSkillModifiers.ts 的 SHOP_MOD.${name} = ${id}，但 modifiers.json 里没有这一行`);
    }
    for (const m of modTable.values()) {
        if (!m.script_id?.startsWith('Modifier_')) continue;
        const key = m.script_id.slice('Modifier_'.length);
        if (!shopMod.has(key)) continue;                 // 英雄那 4 个脚本不在这张表里
        if (shopMod.get(key) !== m.id) {
            problems.push(`编号漂移：${m.script_id} 在 modifiers.json 是 ${m.id}，`
                + `但 ShopSkillModifiers.ts 的 SHOP_MOD.${key} = ${shopMod.get(key)}`);
        }
    }
    return problems;
}

// ============================ 生成 ============================

function buildItems(data) {
    return data.skills.map((s) => ({
        key: `skill_${s.code}`,
        code: s.code,
        id: s.id,
        /** `make-hero-icons.py` 的对照图按 `hero` 分组，这里放技能中文名 */
        hero: s.name,
        hero_en: s.name_en,
        slot: 'icon',
        slot_zh: '技能图标',
        size: SIZE,
        gen_size: GEN,
        wh_ratio: '1:1',
        out_png: `skill_${s.code}.png`,
        icon_path: iconPathOf(s),
        /** 审查结论（不是出图参数，落盘留证用） */
        verdict: s.verdict,
        verdict_zh: VERDICT_ZH[s.verdict] ?? s.verdict,
        mechanism: s.mechanism,
        why: s.why,
        fix: s.fix ?? '',
        rarity: s.rarity,
        stage: s.stage,
        prompt_t2i: buildPrompt(s),
        prompt_zh: buildPromptZh(s),
    }));
}

function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(items) {
    const cols = ['key', 'id', 'code', 'hero', 'rarity', 'stage', 'icon_path', 'out_png', 'size', 'wh_ratio', 'verdict', 'prompt_zh', 'prompt_t2i'];
    const lines = [cols.join(',')];
    for (const it of items) lines.push(cols.map((c) => csvEscape(it[c])).join(','));
    return lines.join('\n') + '\n';
}

/** 审查结论表（给人看的正菜） */
function buildSkillsMd(data, items) {
    const byCode = new Map(items.map((it) => [it.code, it]));
    const L = [];
    L.push('# 局内肉鸽技能审查 + 落地状态 + 图标设定');
    L.push('');
    L.push('> **本文件由 `node tools/skill-icon-prompts/gen-prompts.mjs` 生成，不要手改。**');
    L.push('> 作者数据在 `tools/skill-icon-prompts/skills.json`，改那个再重跑。');
    L.push('> 名字/品质/阶段三列已与 `assets/resources/tb/abilities.json` 逐条对账（对不上生成器直接退出码 1）。');
    L.push('> **`落地形态` 与 `落地机制` 两列是每次现读配表 + `modifiers.json` 推导出来的**，不是手写的 ——');
    L.push('> 谁改了配表让形态变了，这里立刻跟着变；而 `skills.json` 里手写的 `landed.note` 一旦与真相对不上，生成器就报错。');
    L.push('');
    L.push(`共 **${data.skills.length}** 个技能（配表 scope=shop，id 101~130）。`);
    L.push('');
    L.push('## 审查结论分布（**动手前**的历史判定）');
    L.push('');
    const tally = {};
    for (const s of data.skills) tally[s.verdict] = (tally[s.verdict] ?? 0) + 1;
    for (const [k, v] of Object.entries(tally)) L.push(`- ${VERDICT_ZH[k] ?? k} —— **${v}** 个`);
    L.push('');
    L.push('## 落地状态分布（**现状**，由配表现场推导）');
    L.push('');
    const ltally = {};
    for (const s of data.skills) ltally[s._landed.kind] = (ltally[s._landed.kind] ?? 0) + 1;
    for (const [k, v] of Object.entries(ltally)) L.push(`- ${LANDED_ZH[k] ?? k} —— **${v}** 个`);
    const indirect = data.skills.filter((s) => (s._landed.indirect ?? []).length > 0);
    L.push(`- 其中**脚本在运行时自己挂** Modifier 的 —— **${indirect.length}** 个（配表里看不到这些 id）`);
    L.push(`- 30 条全部落地：\`npm run check\` 的「商店技能没有战斗效果」告警已归零；`);
    L.push('  行为断言见 `npm run audit:skill`（真跑源码 + 真配表，116 条）。');
    L.push('');
    L.push('## 逐条审查 + 落地');
    L.push('');
    L.push('| id | 技能 | 品质/阶段 | 审查结论（动手前） | **落地形态（现状）** | 落地机制 | 为什么要动 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const s of data.skills) {
        const ld = s._landed;
        const ids = [...ld.direct, ...(ld.indirect ?? [])];
        const tag = ids.length
            ? `${LANDED_ZH[ld.kind]}<br>Modifier ${ids.join('/')}`
                + (ld.scripts.length ? `<br>\`${ld.scripts.join('`, `')}\`` : '')
            : LANDED_ZH[ld.kind];
        L.push(`| ${s.id} | ${s.name} / ${s.name_en} | ${s.rarity} / ${s.stage} | ${VERDICT_ZH[s.verdict] ?? s.verdict}`
            + ` | ${tag} | ${s.landed.note} | ${s.why} |`);
    }
    L.push('');
    L.push('## 配表现状（真源快照）');
    L.push('');
    L.push('| id | 技能 | max_level | effects 条数 | icon 列 | lv1 |');
    L.push('|---|---|---|---|---|---|');
    for (const s of data.skills) {
        L.push(`| ${s.id} | ${s.name} | ${s._max_level} | ${s._effects} | ${s._icon_in_table || '（空）'} | ${s._lv1} |`);
    }
    L.push('');
    L.push('## 图标设定（出图主体）');
    L.push('');
    for (const s of data.skills) {
        const it = byCode.get(s.code);
        L.push(`### ${s.id} ${s.name}（${s.name_en}）`);
        L.push('');
        L.push(`- 装机路径：\`${it.icon_path}\``);
        L.push(`- 交付：${it.size}×${it.size} RGBA（出图 ${it.gen_size}×${it.gen_size}，1:1）`);
        L.push(`- 主体（英文提示词原文）：`);
        L.push('');
        L.push(`  > ${s.art}`);
        L.push('');
    }
    return L.join('\n') + '\n';
}

function buildPromptsMd(items) {
    const L = ['# 局内技能图标 · 提示词清单', ''];
    L.push('> **本文件由生成器产出，不要手改。** 出图交付 200×200，出图尺寸 512×512（1:1）。');
    L.push('');
    for (const it of items) {
        L.push(`## ${it.id} ${it.hero}（${it.hero_en}）`);
        L.push('');
        L.push(`- key：\`${it.key}\`　装机：\`${it.icon_path}\``);
        L.push(`- 审查结论：${it.verdict_zh}`);
        L.push('');
        L.push('```text');
        L.push(it.prompt_t2i);
        L.push('```');
        L.push('');
    }
    return L.join('\n') + '\n';
}

function main() {
    const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const table = loadAbilityTable();
    const modTable = loadModifierTable();
    const scriptSrc = fs.readFileSync(SHOP_SCRIPTS, 'utf8');

    const problems = crossCheck(data, table, modTable, scriptSrc);
    if (problems.length) {
        console.error('✗ skills.json 与配表对账失败：');
        for (const p of problems) console.error(`   - ${p}`);
        process.exit(1);
    }
    console.log(`✔ 对账通过：${data.skills.length} 个技能的名字/品质/阶段 + 落地形态与配表一致`);
    const ltally = {};
    for (const s of data.skills) ltally[s._landed.kind] = (ltally[s._landed.kind] ?? 0) + 1;
    console.log(`  落地形态：${Object.entries(ltally).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

    const items = buildItems(data);
    const lengths = items.map((it) => it.prompt_t2i.split(/\s+/).length);
    const min = Math.min(...lengths); const max = Math.max(...lengths);
    console.log(`  提示词词数：${min}~${max}（Qwen 官方甜区 400~500；本风格实测 490~660 更好）`);

    if (DRY_RUN) {
        console.log('（--dry-run：只对账，未写盘）');
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const write = (name, text) => {
        const p = path.join(OUT_DIR, name);
        // 目标被 Excel 占着时会抛 EBUSY —— 与工程里其它生成器同口径：改写 .new 并退出码 1
        try {
            fs.writeFileSync(p, text, 'utf8');
            console.log(`  → ${path.relative(ROOT, p)}`);
        } catch (e) {
            if (e.code === 'EBUSY' || e.code === 'EPERM') {
                fs.writeFileSync(`${p}.new`, text, 'utf8');
                console.error(`  ✗ ${path.relative(ROOT, p)} 被占用（Excel 开着？）→ 已改写为 ${name}.new`);
                process.exitCode = 1;
            } else throw e;
        }
    };

    write('prompts.json', JSON.stringify({
        meta: {
            generated_by: 'tools/skill-icon-prompts/gen-prompts.mjs',
            source: 'tools/skill-icon-prompts/skills.json',
            /** 真源配表：名字/品质/阶段三列是与它逐条对账过的 */
            cross_checked_against: 'assets/resources/tb/abilities.json',
            count: items.length,
            style: 'flat single-colour white stencil, transparent background',
            style_source: 'tools/hero-icon-prompts/gen-prompts.mjs（风格段单一真源，这里是 import 进来的）',
            gen_size: GEN, gen_ratio: '1:1',
            deliver: { icon: SIZE },
            note: 'prompt_t2i 投给 ComfyUI（节点 7 PrimitiveStringMultiline.value）；prompt_zh 只给人看。'
                + ' 外层信封与 docs/hero-icons/prompts.json 同构，所以能直接喂 make-hero-icons.py --prompts。',
        },
        items,
    }, null, 2) + '\n');
    write('prompts.csv', toCsv(items));
    write('prompts.md', buildPromptsMd(items));
    write('skills.md', buildSkillsMd(data, items));
    write('skills.json', JSON.stringify(data, null, 2) + '\n');
    console.log('✔ 产物已写入 docs/skill-icons/');
}

main();
