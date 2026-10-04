#!/usr/bin/env node
/**
 * gen-prompts.mjs —— 生成《集合防御》10 个英雄的**设计稿**与**出图提示词清单**。
 *
 * 输入（唯一作者数据，别在本脚本里重复维护内容）：
 *   tools/hero-icon-prompts/heroes.json   10 英雄：身份 / 配表数值 / 技能（含 Modifier）/ 中英文美术描述
 *
 * 输出到 docs/hero-icons/：
 *   heroes.md      人看的设计稿（身份·数值·技能·配表片段）
 *   heroes.json    机读副本（含可直接粘进 units.json / abilities.json / modifiers.json 的片段）
 *   prompts.json   出图清单（机读，20 条 = 10 头像 + 10 技能图）
 *   prompts.csv    给 comfyui_batch.py 读（UTF-8 BOM + CRLF，Excel 双击不乱码）
 *   prompts.md     出图清单（人看）
 *
 * 口径真源（改风格只改下面这几个块）：
 *   · 出图规格：**英雄头像 256×256 / 技能图标 200×200，纯白 #F6F6F6 单色白描 + 透明底**
 *     —— 扒自现有素材：`textures/heros/huoqiang.png` 不透明像素 99.9% 是 #F6F6F6（纯白单色），
 *        `textures/skills/bullet.png` 不透明像素 100% 是 #FFFFFF。底色由预制件给：
 *        `View_Game_Stage.prefab` 的 `item/content/head` = #A85A5A（暗红身份色）、
 *        `item/content/skills` = #70ACB3（青绿强调色）。所以**图本身不该带任何颜色**。
 *   · 提示词结构 = Qwen-Image-2.1 的 T2I 观察者散文（cfg 1，单图不加 `<imageX>`，比例只写 wh_ratio）
 *   · ⚠ 承载底那句**只做正向陈述**（这是踩过两次的坑：一提到「贴到浅灰板上」模型就把浅灰板画出来；
 *     改写成「不许是白的/不许是灰的」又烘焙了一张近白底板 —— 扩散模型对否定式不可靠）。
 *
 * 用法：
 *   node tools/hero-icon-prompts/gen-prompts.mjs              # 写盘
 *   node tools/hero-icon-prompts/gen-prompts.mjs --dry-run    # 只统计不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(HERE, 'heroes.json');
const OUT_DIR = path.join(ROOT, 'docs/hero-icons');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 交付尺寸（2026-10 口径变更：技能图 200 → **64**；头像是 256 不变）
 *
 * 为什么只压技能图：技能图标在工程里的真实显示处是 **50×50**（HUD `skills` 节点下
 * 每个 `skill{N}` 的 `icon`）与 **20×20**（选人卡 `content/skills`），200 是 4 倍冗余；而头像在选人卡与 HUD 上是
 * 50×50、在英雄详情里更大，256 是合理的 1.5~5 倍。
 * 压到 64 之后 `textures/skills/` 整目录统一口径（含 30 张肉鸽技能图），
 * 技能图集从 4.00 MB 降到约 0.4 MB —— 与遗物图集（也是 64）同一口径。
 *
 * ⚠ 源图（512×512）一律留着：换尺寸只是重跑 `make-hero-icons.py`，不用重新出图。
 */
const SIZE = { emblem: 256, icon: 64 };
/** 出图尺寸（工作流 ResolutionSelector 是 0.25MP → 512×512，1:1） */
const GEN = 512;
/**
 * 装机路径（resources 相对路径，**不带扩展名** —— 与 units.json 的 head_icon 同口径）。
 *   头像 `textures/heros/<code>`：与现有 4 个**完全同规则**（huoqiang/shangjin/zhousi/fuwang），
 *     所以现役 4 个是**原地替换**（换风格统一），新增 6 个是新增文件。
 *   技能图 `textures/skills/<code>_skill`：**刻意加 `_skill` 后缀** —— `textures/skills/` 里已经有
 *     `huoqiang.png` 与 `baotou.png` 两张 128×128 的青绿准星风格图（不是本次这套白描），
 *     不加后缀会把 `huoqiang.png` 覆盖掉。
 */
const iconPathOf = (hero, slot) => (slot === 'emblem' ? `textures/heros/${hero.code}` : `textures/skills/${hero.code}_skill`);

// ============================ 共享风格段（改风格只改这里） ============================

/**
 * 画法 · 单色白描 + 挖空（4 句）
 * 这是整个风格的核心：**一个纯白色块** + 全部细节靠「挖空」表达，而不是靠画线。
 * 依据是现有素材本身 —— 4 张英雄头像与 bullet 图标里，不透明像素几乎 100% 是同一个近白色，
 * 一个像素的第二颜色都没有，所以「白描 + 挖空」是工程既有口径，不是我的审美偏好。
 *
 * ⚠ 第一版写成「a few bold chunky masses」（几个粗大块）+「缩到很小也要认得出」，
 *   结果模型把人物**过度简化成一坨抽象色块**（幻影刺客那张读起来像一朵花/皇冠，完全不像人）。
 *   对比现有 `huoqiang.png` 就会发现：那 4 张**内部细节相当丰富**（帽檐、护目镜、胡子、手指
 *   全是负空间抠出来的）。所以口径改成「**细节丰富，但只由实心白 + 挖空两种手段构成**」，
 *   并且明确禁止"简化成 logo / 模糊一团"。
 */
export const DRAWING = [
    'The picture is a flat single-colour emblem made in the manner of a paper cut-out or a spray-paint stencil.',
    'Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the eyes, the mouth, the folds of cloth, the gaps between limbs and weapons, the openings in armour — is expressed purely as holes cut clean through that shape rather than as drawn lines.',
    'The subject is richly detailed, and that detail stays legible because every hole is given a clear open shape of its own: the emblem reads as a bold, confident piece of graphic design rather than as a vague blob or a stripped-down logo.',
    'There is exactly one white tone in the whole subject: the shape carries no second shade, no outline in another colour, no shading inside its masses and no surface pattern of any kind.',
];

/**
 * 承载底（1 句）—— **纯正向陈述**，不出现任何颜色否定
 * 底色挑的是工程自己的墨色 `c-ink-900 #445054`：与主体白形成最大对比，且是项目调色板里的颜色。
 * 这一块交给 make-hero-icons.py **按四角色键抠掉**（先采样边框取实际底色再抠，不靠固定值）。
 */
export const BACKGROUND =
    'The emblem sits alone on a completely plain uniform field of one solid deep slate grey that covers the entire frame edge to edge, the same tone everywhere, and that field is left completely empty with nothing else drawn upon it, so the white shape and the grey field are the only two things in the picture and they meet along one clean crisp edge.';

/**
 * 光照 · 无光（1 句）
 * 这一句是在**加固白描**：白描最容易被模型理解成「白色材质 + 正常打光」，
 * 于是它会在白块里画灰面、在边缘加高光 —— 那些灰面进了 alpha 通道就变成半透明脏边。
 * 说清「光不参与画面」比说「不要阴影」有效（否定式在 cfg 1 下不可靠）。
 */
export const LIGHT =
    'Light and shadow play no part in the picture at all: because the whole subject is one flat white tone, every part of the shape is equally bright, from its outermost edge to its innermost gap.';

/**
 * 可读性 · 缩到很小也要认得出（1 句）
 * 交付尺寸只有 256/200（真实显示槽位更是 50×50 与 20×20），所以「剪影可辨识」是硬指标，
 * 不是审美要求 —— 见 docs/art-style/ui-design-prompt.md 的「靠剪影辨识」。
 * ⚠ 措辞从「只靠两三个大块承载身份」改掉了：那句会把人物压成抽象色块（第一版实测）。
 */
export const READING =
    'The emblem is built to be recognised instantly at the size of a small square badge: the head and its identifying features — the shape of the hat or hood, the weapons, the distinctive outline — stay unmistakable at a single glance.';

/**
 * 构图 · 剪影要接近正方形（1 句）
 * ⚠ 这一句是**工程要求**，不是审美：交付图的 alpha 包围盒会决定 sprite 的 trim，
 *   而槽位是 `sizeMode=CUSTOM` + `trim=true` → 包围盒越不方，画面被拉伸得越狠。
 *   现有素材就是这么做的 —— 看那 4 张头像，`shangjin` 背后的菱形/尖刺底衬、
 *   `fuwang` 背后的盾形底衬、`zhousi` 背后的闪电尖角，**都是用来把剪影撑成方块的**。
 *   所以这里不是新发明，是把现有素材已经存在的构图规律写成话。
 */
export const SQUARE =
    'The overall silhouette fills the square frame evenly, its total width and its total height coming out very nearly equal, with simple angular masses arranged around the subject to square the shape off like the backing plate of a heraldic badge.';

/**
 * 收尾（1 句）
 */
export const CLOSE =
    'The subject is centred in a square frame with generous even margins all round, the full shape sitting well inside the edges, and the picture is calm, simple and easy to read at a glance.';

/**
 * 头像 / 技能图各自的定位句
 * 两者的差别只是「画面里装什么」：头像是**人物胸像徽记**，技能图是**物件图形**。
 * 这一句是用来把模型从「插画」拉到「徽记」上的——不然它很容易画出立体感和背景环境。
 */
export const KIND = {
    emblem:
        'This is a hero portrait emblem: it shows only the head and shoulders of a single character, treated as a bold heraldic badge rather than as an illustration, and no background scene, no ground and no environment of any kind is included. The head is large and occupies most of the emblem, presented front-on or in a clear three-quarter turn and unmistakably built like a real head with a brow, eyes and a jaw, while the shoulders and the shapes arranged behind them fill out the rest of the square.',
    icon:
        'This is a skill icon: it shows a single object or symbol treated as a bold graphic sign rather than as an illustration, and no character and no background scene of any kind is included.',
};

// ============================ 主体段（每条一行，来自 heroes.json 的 art 字段） ============================

function buildPrompt(hero, slot) {
    const subject = hero.art?.[slot];
    if (!subject) throw new Error(`hero ${hero.code} 缺少 art.${slot}`);
    // 顺序与 relic 清单一脉相承：先「这是什么」→ 主体 → 画法 → 光照 → 可读性 → 构图方 → 承载底 → 收尾
    return [KIND[slot], subject, ...DRAWING, LIGHT, READING, SQUARE, BACKGROUND, CLOSE].join(' ');
}

/** 中文提示词（人看/校对用，不投给模型） */
function buildPromptZh(hero, slot) {
    const what = slot === 'emblem' ? '英雄头像徽记' : '技能图标';
    return `${hero.name}（${hero.name_en}）· ${what}：` +
        `纯白单色白描，主体是「白色实心色块 + 内部细节挖空」，无第二个颜色、无描边、无渐变、无材质；` +
        `深板岩灰纯色承载底（出图后本地抠掉）；正方形居中，四周留白充足。`;
}

// ============================ 生成 ============================

function buildItems(data) {
    const items = [];
    for (const hero of data.heroes) {
        for (const slot of ['emblem', 'icon']) {
            items.push({
                key: `${slot === 'emblem' ? 'hero' : 'skill'}_${hero.code}`,
                code: hero.code,
                hero_id: hero.id,
                hero: hero.name,
                hero_en: hero.name_en,
                slot,
                slot_zh: slot === 'emblem' ? '英雄头像' : '技能图标',
                size: SIZE[slot],
                gen_size: GEN,
                wh_ratio: '1:1',
                out_png: `${slot === 'emblem' ? 'hero' : 'skill'}_${hero.code}.png`,
                icon_path: iconPathOf(hero, slot),
                prompt_t2i: buildPrompt(hero, slot),
                prompt_zh: buildPromptZh(hero, slot),
            });
        }
    }
    return items;
}

function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(items) {
    const cols = ['key', 'hero', 'slot', 'size', 'out_png', 'icon_path', 'prompt_t2i', 'prompt_zh'];
    const lines = [cols.join(',')];
    for (const it of items) lines.push(cols.map((c) => csvEscape(it[c])).join(','));
    return '\ufeff' + lines.join('\r\n') + '\r\n'; // BOM + CRLF：Excel 双击不乱码
}

const DAMAGE_ZH = { physical: '物理', magical: '法术' };
const ATTR_ZH = { 1: '最大生命', 2: '最大魔法', 3: '攻击力', 4: '攻击速度', 5: '移动速度', 6: '护甲', 7: '魔法抗性', 8: '闪避', 9: '生命恢复/秒', 10: '魔法恢复/秒', 11: '伤害输出倍率', 12: '物理受伤倍率', 13: '魔法受伤倍率', 14: '暴击率', 15: '暴击倍率', 16: '攻击距离' };
const TARGETING_ZH = { nearest: '最近', lowest_hp: '残血', farthest: '最远', strongest: '最强', random: '随机' };

function fmtAttrs(list) {
    return list.map(([id, v]) => `${ATTR_ZH[id] ?? id} ${v}`).join(' / ');
}
function fmtAttrEntry(e) {
    if (Array.isArray(e)) return `${ATTR_ZH[e[0]] ?? e[0]} ${e[1]}${e[2] ? `(${e[2]})` : ''}`;
    return `${ATTR_ZH[e.attr] ?? e.attr} ${e.value}${e.mode ? `(${e.mode})` : ''}`;
}
function fmtAction(a) {
    switch (a.type) {
        case 'apply_modifier':
            return `施加 Modifier ${a.modifier}${a.duration !== undefined ? `（${a.duration === -1 ? '永久' : a.duration + 's'}）` : ''}${a.chance ? `，${Math.round(a.chance * 100)}% 概率` : ''}${a.kv ? `，kv=${JSON.stringify(a.kv)}` : ''}`;
        case 'damage':
            return `造成 ${a.value} 点${DAMAGE_ZH[a.damage_type] ?? a.damage_type ?? '法术'}伤害`;
        case 'aoe_damage':
            return `对 ${a.radius} 半径内敌人造成 ${a.value} 点${DAMAGE_ZH[a.damage_type] ?? a.damage_type ?? '法术'}伤害`;
        case 'modify_attr':
            return `属性：${(a.attrs ?? []).map(fmtAttrEntry).join('、')}`;
        case 'steal_gold': return `偷取 ${a.value} 金币`;
        case 'lifesteal': return `吸血 ${a.ratio}`;
        case 'reflect': return `反弹 ${a.ratio}`;
        case 'heal': return `回复 ${a.value}`;
        default: return a.type;
    }
}

function buildHeroesMd(data, items) {
    const L = [];
    L.push('# 集合防御 · 10 个 Dota2 代表英雄（设计稿 + 头像/技能图标出图清单）');
    L.push('');
    L.push('> 本文件由 `node tools/hero-icon-prompts/gen-prompts.mjs` 生成，**别手改** —— 改设计改 `tools/hero-icon-prompts/heroes.json`。');
    L.push('');
    L.push(`- 英雄 **${data.heroes.length}** 个：现役 ${data.heroes.filter((h) => h.existing).length} 个 + 新增 ${data.heroes.filter((h) => !h.existing).length} 个`);
    L.push(`- 出图 **${items.length}** 张：英雄头像 ${SIZE.emblem}×${SIZE.emblem} × ${data.heroes.length} + 技能图标 ${SIZE.icon}×${SIZE.icon} × ${data.heroes.length}`);
    L.push('- 伤害体系：**只有物理 / 法术**（本作没有元素体系，`element_effects.json` 已于 2026-07 删除）');
    L.push('');
    L.push('## 0. 两条先说清楚的硬口径');
    L.push('');
    L.push('### 0.1 英雄技能**必须是被动**');
    L.push('');
    L.push('`AbilitySystem.AddAbility()` 对被动技能会立即 `ApplyPassive()`（挂永久 Modifier），但**英雄侧没有任何主动施放入口** ——');
    L.push('`castAbility` 在整个工程里的唯一调用方是 `ai/BossAI.tryCastSkill`。所以 10 个英雄的技能全部设计成 `behavior: "passive"`。');
    L.push('');
    L.push('想让英雄技能能按 CD 自动放（比如给水晶室女一个「主动开极寒领域」），要补的是**一处**：在英雄每帧的 tick 里对');
    L.push('`hero.abilities.getCastableSkills()` 逐个尝试施放（`Ability.Cast` 已实现，含冷却与蓝耗判定）。');
    L.push('本稿不依赖这一条 —— 全部 10 个技能**不加一行 TS 就能生效**。');
    L.push('');
    L.push('### 0.2 技能效果全部走现有声明式词汇');
    L.push('');
    L.push('只有两种来源，都在 `excel_table/EffectTypes.ts` 里：');
    L.push('');
    L.push('| 来源 | 何时生效 | 可用动作 |');
    L.push('|---|---|---|');
    L.push('| `modifiers.effects[]` | Modifier 存活期间**持续**（声明式） | `modify_attr` / `apply_state` / `tick_damage` / `tick_heal` / `tick_apply_modifier` |');
    L.push('| `modifiers.events[].actions[]` | **事件触发**时执行一次 | `damage` / `aoe_damage` / `heal` / `apply_modifier` / `remove_modifier` / `modify_attr` / `lifesteal` / `reflect` / `steal_gold` / `projectile` / `execute_script` |');
    L.push('');
    L.push('⚠ **事件动作的目标是「事件目标，无则宿主」**（`Modifier.runAction`：`target = event?.target ?? host`）：');
    L.push('');
    L.push('- `on_attack_landed` → `event.target` 是**被打的那个敌人** → 可以对他造成伤害 / 施加减速');
    L.push('- `on_take_damage` → `event.target` 是**宿主自己**（攻击者在 `event.source`）→ `aoe_damage` 会以自己为圆心；');
    L.push('  **`apply_modifier` 会施加到自己身上**，所以「受击时冻住打我的人」这类效果**声明式做不到**（本稿因此没这么设计）');
    L.push('');
    L.push('## 1. 英雄总览');
    L.push('');
    L.push('| id | 英雄 | Dota2 原型 | 伤害 | 流派 | 生命 | 魔法 | 攻击 | 攻速 | 射程 | 普攻索敌 | 状态 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const h of data.heroes) {
        const a = Object.fromEntries(h.base_attributes);
        L.push(`| ${h.id} | **${h.name}**<br>${h.name_en} | ${h.dota2} | ${DAMAGE_ZH[h.damage]} | ${h.role.split(' · ').slice(1).join(' · ') || h.role} | ${a[1]} | ${a[2]} | ${a[3]} | ${(a[4] / 100).toFixed(2)} | ${a[16]} | ${TARGETING_ZH[h.attack_targeting] ?? h.attack_targeting} | ${h.existing ? '现役' : '**新增**'} |`);
    }
    L.push('');
    L.push('> 攻速一栏已把配表的 int 换算回倍率（配表 `120` = 1.20 次/秒）。射程单位是**像素**（`battle_constants.pxPerMeter` = 50 px/m）。');
    L.push('');
    L.push('### 流派覆盖');
    L.push('');
    const byDamage = { physical: data.heroes.filter((h) => h.damage === 'physical'), magical: data.heroes.filter((h) => h.damage === 'magical') };
    for (const [k, list] of Object.entries(byDamage)) {
        L.push(`- **${DAMAGE_ZH[k]}（${list.length}）**：${list.map((h) => `${h.name}（${h.role.split(' · ')[1]}）`).join('、')}`);
    }
    L.push('');
    L.push('## 2. 逐个英雄');
    L.push('');
    for (const h of data.heroes) {
        const a = Object.fromEntries(h.base_attributes);
        L.push(`### ${h.id} · ${h.name} ${h.name_en}${h.existing ? '（现役）' : '（新增）'}`);
        L.push('');
        L.push(`> ${h.blurb}`);
        L.push('');
        L.push(`- **Dota2 原型**：${h.dota2}　**伤害**：${DAMAGE_ZH[h.damage]}　**流派**：${h.role.split(' · ').slice(1).join(' · ') || h.role}`);
        L.push(`- **基础属性**（配表 int 原值）：${fmtAttrs(h.base_attributes)}`);
        L.push(`- **每级成长**：${fmtAttrs(h.growthValues)}`);
        L.push(`- **普攻**：间隔 ${h.attack_interval}s　索敌 ${TARGETING_ZH[h.attack_targeting] ?? h.attack_targeting}　弹道 ${h.attack_projectile || '（近战无弹道）'}`);
        L.push(`- **头像**：\`${h.head_icon}\``);
        if (h._warn) L.push(`- ⚠️ **待确认**：${h._warn}`);
        L.push('');
        L.push(`#### 技能：${h.skill.name}`);
        L.push('');
        L.push(`**效果**：${h.skill.lv1}`);
        L.push('');
        L.push(`- ` + h.skill.effects.map(fmtAction).join('；'));
        const mods = [];
        if (h.skill.modifier) mods.push(h.skill.modifier);
        if (h.skill.modifier_extra) mods.push(...h.skill.modifier_extra);
        for (const m of mods) {
            L.push(`- Modifier **${m.id} ${m.name}**：duration ${m.duration === -1 ? '永久' : m.duration}，stack_mode ${m.stack_mode}${m.max_stack ? `，max_stack ${m.max_stack}` : ''}`);
            if (m.effects) L.push(`  - ` + (Array.isArray(m.effects) ? m.effects : [m.effects]).map(fmtAction).join('；'));
            if (m.events) for (const ev of m.events) L.push(`  - 事件 \`${ev.event}\` → ` + ev.actions.map(fmtAction).join('；'));
        }
        if (h.skill.modifier_ref) L.push(`- ${h.skill.modifier_ref}`);
        if (h.skill.note) L.push(`- 口径：${h.skill.note}`);
        if (h.skill.upgrade_path) L.push(`- 升级路径：${h.skill.upgrade_path}`);
        L.push('');
        L.push(`**落地成本**：${h.needs_code ? '需要新增 TS' : '**不需要写代码**（纯配表）'}${h.needs_code_if ? `　（${h.needs_code_if}）` : ''}`);
        L.push('');
        L.push('---');
        L.push('');
    }
    L.push('## 3. 出图清单（20 张）');
    L.push('');
    L.push('| key | 英雄 | 类型 | 交付尺寸 | 装机路径 |');
    L.push('|---|---|---|---|---|');
    for (const it of items) L.push(`| \`${it.key}\` | ${it.hero} ${it.hero_en} | ${it.slot_zh} | ${it.size}×${it.size} | \`${it.icon_path}\` |`);
    L.push('');
    L.push('完整提示词见同目录 `prompts.md`；投递用 `tools/relic-icon-prompts/comfyui_batch.py`（见 README §4）。');
    L.push('');
    return L.join('\n');
}

function main() {
    if (!fs.existsSync(SRC)) throw new Error(`找不到作者数据：${SRC}`);
    const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const items = buildItems(data);

    // 自检：提示词长度落在 Qwen T2I 的甜区（官方口径 400~500 词）
    const lens = items.map((it) => it.prompt_t2i.split(/\s+/).length);
    const minL = Math.min(...lens), maxL = Math.max(...lens);
    console.log(`◆ 英雄 ${data.heroes.length} 个；出图条目 ${items.length} 条（头像 ${data.heroes.length} + 技能 ${data.heroes.length}）`);
    console.log(`◆ 提示词词数 ${minL}~${maxL}（Qwen T2I 官方甜区 400~500）`);
    if (minL < 380) console.warn(`  ⚠ 有提示词偏短（${minL} 词），主体段可能太薄`);
    if (maxL > 560) console.warn(`  ⚠ 有提示词偏长（${maxL} 词），可精简主体段`);

    if (DRY_RUN) {
        console.log('◆ --dry-run：不写盘。第一条示例：\n');
        console.log(items[0].prompt_t2i);
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const write = (name, content) => {
        const p = path.join(OUT_DIR, name);
        fs.writeFileSync(p, content, 'utf8');
        console.log(`  √ ${path.relative(ROOT, p).replace(/\\/g, '/')}  (${Buffer.byteLength(content)} B)`);
    };

    write('heroes.md', buildHeroesMd(data, items));
    write('heroes.json', JSON.stringify({
        meta: { generated_by: 'tools/hero-icon-prompts/gen-prompts.mjs', source: 'tools/hero-icon-prompts/heroes.json', count: data.heroes.length, damage_types: ['physical', 'magical'] },
        heroes: data.heroes.map(({ art, ...rest }) => rest),
    }, null, 2) + '\n');
    write('prompts.json', JSON.stringify({
        meta: {
            generated_by: 'tools/hero-icon-prompts/gen-prompts.mjs',
            style: 'flat single-colour white stencil, transparent background',
            gen_size: GEN, gen_ratio: '1:1',
            deliver: { emblem: SIZE.emblem, icon: SIZE.icon },
            note: 'prompt_t2i 投给 ComfyUI（节点 7 PrimitiveStringMultiline.value）；prompt_zh 只给人看',
        },
        items,
    }, null, 2) + '\n');
    write('prompts.csv', toCsv(items));
    write('prompts.md', [
        '# 10 英雄 · 头像/技能图标出图清单',
        '',
        '> 由 `node tools/hero-icon-prompts/gen-prompts.mjs` 生成，别手改。',
        '',
        `出图 ${GEN}×${GEN}（1:1），交付 **头像 ${SIZE.emblem}×${SIZE.emblem} / 技能图 ${SIZE.icon}×${SIZE.icon}**（RGBA，纯白单色 + 透明底）。`,
        '',
        ...items.map((it) => [
            `## ${it.key}　${it.hero} ${it.hero_en} · ${it.slot_zh}`,
            '',
            `- 交付：\`${it.out_png}\`　${it.size}×${it.size}`,
            '',
            '**中文（校对用，不投递）**',
            '',
            `> ${it.prompt_zh}`,
            '',
            '**英文提示词（投递这份）**',
            '',
            it.prompt_t2i,
            '',
        ].join('\n')),
    ].join('\n'));
    console.log('◆ 完成。');
}

/**
 * 只在「被直接执行」时跑 main()。
 *
 * 为什么要这层判断：本文件把风格段（DRAWING / BACKGROUND / KIND…）export 出来，
 * 供 `tools/skill-icon-prompts/gen-prompts.mjs` import —— 风格只能有一份真源。
 * 但 import 会**执行整个模块**，于是跑技能生成器时会顺带重写一遍英雄产物
 * （幂等、不丢数据，但会污染日志与退出码，且让"我只想生成技能"变成"顺手动了英雄"）。
 * 加了这层判断后：直接执行照旧，被 import 时只剩常量。
 */
const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
