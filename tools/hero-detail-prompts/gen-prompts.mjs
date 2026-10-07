#!/usr/bin/env node
/**
 * gen-prompts.mjs —— 生成《集合防御》**英雄详情弹窗**的 AI 提示词清单。
 *
 * 需求（用户口径，2026-11 · 第二版）：
 *   · 英雄详情面板是一个**弹窗**，要把**英雄的所有信息**显示全；
 *   · 面板上有**升级操作**，升级**消耗经验**（经验在**一局结束时发放**），并且**看得到资源**；
 *   · **提示词只描述"要显示什么内容" + "这是一个弹窗"** —— 布局/分区/尺寸/视觉组织**由 AI 自己分析决定**，
 *     不写"第 3 行放在 x=+150"这种施工级指令。
 *
 * 输出到 `docs/hero-detail/`：
 *   prompts.md    人读：内容清单（唯一口径）+ 三版主提示词（中文/英文/极简）+ 2 个属性图标 + 验收
 *   prompts.json  机读：`items[]` 喂 make-hero-icons.py / install-hero-icons.py / check-hero-icons.py
 *   prompts.csv   投递：给 tools/relic-icon-prompts/comfyui_batch.py（UTF-8 BOM + CRLF）
 *
 * ============================ 这一版为什么只有 3 条图 ============================
 *
 * ① **主提示词 1 条**（`hero_detail_popup`，9:16）= 让 AI 出一张"弹窗显示这些内容"的效果图；
 * ② **属性图标 2 条**（1:1，交付 64×64）= 面板要显示英雄真配了的 5 项属性，而 `textures/property/`
 *    只有 `atk` / `defence` / `atk_range` —— **缺「攻击速度」与「最大魔法」**（设计口径见 §3.1）。
 *
 * 其余一律不要出图：面板骨架是「九宫格贴图 + 纯色 + `cc.Label`」，现成素材齐了
 * （`rect_rd_5/10/20`、`common/close`、`common/lock`、`common/conor`、`common/heart`、`common/exp_icon`、
 * `common/gold`、`common/right`、`textures/heros/*`、`textures/skills` 图集）—— 见 §4。
 * ⚠ 文字与数字**绝不出一张图**（不可本地化/不可改字号/不可染色），一律 `cc.Label`。
 *
 * ============================ 风格真源 ============================
 *
 * 白描图标的画法口径**不在这里重写**：`DRAWING` / `BACKGROUND` / `LIGHT` / `SQUARE` / `CLOSE`
 * 全部 `import` 自 `tools/hero-icon-prompts/gen-prompts.mjs` —— 与英雄头像 / 技能图标 / 难度徽记同一份。
 *
 * 为什么能直接复用（2026-11 实测）：把 `property/atk.png`、`property/defence.png`、`property/atk_range.png`、
 * `common/heart.png`、`common/energy.png`、`common/gold.png`、`common/lock.png`、`common/close.png` 的 alpha
 * 拍成**深色实心**看，它们全是**实心填充 + 内部挖空**那一套（实心匕首 / 实心盾 / 实心圆盘挖楔形与同心弧 /
 * 实心心 / 实心闪电 / 实心圆盘挖 ¥ / 实心锁挖钥匙孔），且不透明像素 **100% 是同一个纯白 `#FFFFFF`、真 alpha 底**
 * （可用 `Sprite.color` 染色）—— 与英雄头像那套「纸雕白描」是同一个画法，所以**同一个风格段就够**。
 *
 * 用法：
 *   node tools/hero-detail-prompts/gen-prompts.mjs              # 写盘
 *   node tools/hero-detail-prompts/gen-prompts.mjs --dry-run    # 只统计不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRAWING, BACKGROUND, LIGHT, SQUARE, CLOSE } from '../hero-icon-prompts/gen-prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_DIR = path.join(ROOT, 'docs/hero-detail');
const DRY_RUN = process.argv.includes('--dry-run');

/** 出图尺寸：工作流 Resolution Selector = 0.25MP → 512×512（1:1）。与技能图标/难度徽记同口径。 */
const GEN = 512;
/** 交付 **64×64 RGBA**：真实槽位是 20×20（属性行图标），64 是 3.2 倍，与 `property/` 现有 200×200 相比是降采样。 */
const ICON_SIZE = 64;
/** 属性图标进 `textures/property/`（与 `atk` / `defence` / `atk_range` 同一排）。 */
const PROP_BASE = 'textures/property';

// ============================ 本地三段（题材相关，非风格） ============================

/** 「这是什么」—— 把模型从"插画"拉到"UI 图标"。 */
const KIND = 'This is a small interface icon for a mobile game: a single object or symbol treated as a bold graphic sign rather than as an illustration, and no character, no lettering and no background scene of any kind is included.';

/**
 * 「缩到很小也要认得出」—— 验收指标，不是审美。
 * 唯一验收现场：和 `property/*` 那一排摆在一起不违和、不被认成别的属性。
 */
const READING = 'The icon is built to be recognised instantly at the size of a small square chip of about twenty pixels: its silhouette is unmistakable at a single glance, and it holds its own next to simple filled shapes such as a heart, a shield, a dagger and a pair of concentric rings without being mistaken for any of them.';

/**
 * 画法段 —— 与英雄/技能/难度同一份 `DRAWING`，**只把第二句的细节列举按题材改写**。
 * 原句列的是 `the eyes, the mouth, the folds of cloth, the openings in armour` —— 那是**人物**的细节清单，
 * 喂给"速度符号 / 水滴"会把模型带向画一张脸或一件武器插画，所以换成边、角、圆孔与缺口。
 */
const DRAWING_GEOM = [
    DRAWING[0],
    'Every part of the subject is filled with one uniform white tone, so the whole figure reads as one connected white shape, and the whole of its detail — the straight edges, the sharp corners, the round holes punched through it, the slots and notches cut into its outline — is expressed purely as holes and gaps cut clean through that shape rather than as drawn lines.',
    DRAWING[2],
    DRAWING[3],
];

/** 题材细节（1 句）：把"几何词表"写死（`docs/美术风格预设.md` §1.3），防止模型自行加装饰或加材质。 */
const DETAIL = 'Every part of the icon is a plain four-sided, round or triangular form, all of its edges are either dead straight or evenly curved, and every opening is wide enough to stay clean when the whole icon is shown very small.';

/** 底与锚（1 句）：说清"画面里只有这一个符号"，否则模型会补场景、补地平面、补第二个物体。 */
const MASS = 'No ground plane, no horizon, no sky and no second object appear anywhere in the picture, and the mass is centred in the square with its weight spread evenly so it sits squarely inside the frame.';

// ============================ 白描图标（2 条，1:1，交付 64×64） ============================

/**
 * `subject` 只描述**画什么**（形状/方向/挖空位置），不描述画法/底色/光照 —— 那些在共享段里。
 *
 * 两条的防撞形约束（本清单唯一的构图硬指标）：
 *   · `atk_speed` 用**向右的三角 + 速度短杠**：`property/atk.png` 是斜向实心匕首、
 *     `property/atk_range.png` 是实心圆盘挖楔形 + 同心弧，三者不撞形；
 *   · `mana` 用**水滴**（下圆上尖）：避开 `common/gold.png`（圆盘挖 ¥）、`common/energy.png`（实心闪电）、
 *     `common/exp_icon.png`（青绿菱形徽记 —— 它就在本面板的经验行上，撞形代价最大）。
 */
const ICONS = [
    {
        key: 'hero_attr_atk_speed',
        code: 'atk_speed',
        name: '属性图标 · 攻击速度',
        where: '详情面板属性行「攻击速度」（20×20）；英雄卡若将来显示攻速也用它',
        optional: false,
        iconPath: `${PROP_BASE}/atk_speed`,
        zh: '攻击速度图标：一个指向右的实心三角箭头（楔形，背面竖直），左方紧挨三条平行横杠（自上而下一条比一条长），'
            + '三角正中挖一个小圆孔，底部一条通底短横杠把重量压住。',
        subject: 'A single speed mark filling the centre of the square: one broad arrowhead pointing to the right, drawn as a solid triangular wedge with a straight vertical back edge and a sharp tip, sitting on the horizontal centre line a little to the right of the middle of the frame. Immediately to the left of the wedge three parallel horizontal bars are stacked one above the other with clear even gaps between them, all three the same thickness and each bar a little longer than the one above it, so the three bars read as a short ladder of motion streaks running toward the wedge. One small round hole is punched clean through the middle of the arrowhead, a short solid baseline runs along the bottom of the frame under both the bars and the wedge, and the whole mark is squared off so that its total width and its total height come out very nearly equal.',
    },
    {
        key: 'hero_attr_mana',
        code: 'mana',
        name: '属性图标 · 最大魔法',
        where: '详情面板属性行「最大魔法」（20×20）',
        optional: false,
        iconPath: `${PROP_BASE}/mana`,
        zh: '最大魔法图标：一颗直立的水滴（下半是饱满的圆、上半均匀收成一个窄尖，尖端切平），'
            + '水滴正中挖一个较小的同形水滴孔，下方再挖一个小圆孔，左右两侧各悬一段短横杠，底部一个短柄通底。',
        subject: 'A single upright droplet standing at the centre of the square: a solid form whose lower half is one broad even circle and whose upper half tapers smoothly to a narrow tip, and that tip is cut flat straight across the very top. A second, smaller droplet of the same shape is cut clean through the middle of the big one as open space, and one small round hole is punched through the solid part just below that opening. A short horizontal bar stands off to the left of the droplet and another to the right, both at the height where the droplet is widest, each separated from the droplet by a clear gap of even width, and a short thick stub sits under the lowest point of the droplet so the mass is squared off along the bottom of the frame and its height matches its width.',
    },
];

// ============================ 主提示词（1 条，9:16，只讲"显示什么"） ============================

/**
 * 三条硬口径（写提示词时反复要用，改任何一句都别破坏它们）：
 *   ① **必须说明这是弹窗**（模态浮层 + 全屏遮罩 + 面板浮在中间），否则模型会画成一整个页面；
 *   ② **布局交给 AI**：提示词里不出现"第几行 / 在左边 / x=+150 / 宽 640"这类施工级坐标，
 *      只给**内容的优先级与分组暗示**（"标题 + 头像名字等级 + 经验 + 属性 + 技能 + 一个主按钮"），
 *      并明确写一句"如何分区、每块多大由你分析决定"；
 *   ③ 升级**花经验**、解锁**花金币**（两种资源两种用途），且一屏**只有一个主按钮**。
 */
const POPUP = {
    key: 'hero_detail_popup',
    code: 'popup',
    ratio: '9:16',
    size: 0,
    name: '英雄详情弹窗效果图（已解锁态 · 内容全展开）',
    install: '不进工程（只给评审/施工参考，落 docs/hero-detail/popup.png）',
    optional: false,
    /**
     * 词数区间：这一条要**逐项点名 12 条内容**（含 5 行属性与两处资源读数），所以比 T2I 甜区（400~500）宽 ——
     * 少写一项模型就少画一块。上下文紧张时用下面的 `promptShort`。
     */
    words: [300, 560],
    zh: '英雄详情弹窗效果图：竖屏，主界面被 70% 黑遮罩压暗，白色大圆角面板浮在中间；'
        + '面板里显示一个英雄（火枪 · LV.12）的全部信息 —— 头像、名字、等级、经验条与「120/347」、'
        + '五项属性（生命/魔法/攻击/攻速/距离，各带每级成长）、技能（爆头冲击 · 被动 · 效果文案）、'
        + '一个青绿主按钮「升 级」、可升级用的经验 1,280、解锁用的金币 640、关闭入口。'
        + '**布局如何分区、每块多大、留白怎么留，全部由 AI 自己分析决定**。',
    prompt: 'This is a flat layout concept for a modal popup in a mobile game, drawn face-on as it would appear on a vertical phone screen, with no device frame, no perspective and no drop shadow. The whole screen behind the popup is a warm off-white paper field laid over by one even sheet of flat black, and a single white panel with generously rounded corners floats in the middle of that darkened field, well clear of every edge. The popup is about one hero, and how its contents are arranged, how large each part is and how the information is grouped are all left open, so the panel simply has to show everything listed here in whatever order and grouping reads most clearly. At the head of the popup stands the hero: a flat white stencil portrait of a musketeer in a wide-brimmed hat and round goggles, set on a rounded square of muted brick red, with the name "火枪" in large dark slate type and the small teal pill "LV.12" close beside it. Near the name sits the hero\'s experience: a thin rounded bar filled in flat teal a third of the way across, the pale grey text "120 / 347" at its end, and one short line of small grey text explaining that the next level costs 347 experience. Elsewhere in the panel the hero\'s five attributes are listed, each one a small flat white glyph with a slate name, a larger dark value and a small pale note of how much it grows per level: "最大生命 452 +12/级", "最大魔法 120", "攻击力 73 +3/级", "攻击速度 120%", "攻击距离 250". The hero\'s single skill appears as a rounded skill tile in flat teal holding a small white glyph of a bullet and an impact ring, with the name "爆头冲击（被动）" beside it and two short lines of grey text reading "普攻附带 5% 攻击力的额外伤害；15% 概率击退敌人 1m". One single main button sits in the popup, a teal pill with the white label "升 级" and a small white arrow, and next to that button stands the resource it spends: a small experience emblem with the number "1,280". A second read-out shows a small round gold coin glyph with "640" beside it in warm gold, which is the currency used to unlock a hero rather than to raise one, and a thin slate circle with a white cross sits at one corner of the panel as the way out. Every surface in the picture is one flat tone from edge to edge, with no gradient, no cast shadow, no glow, no bevel and no texture on anything, and light plays no part in the picture at all, so the palette is held to one cool ink family for all type and glyphs, one teal used only for the button, the progress fill and the skill tile, one muted brick red for the hero portrait only, and one warm gold for the currency read-outs only. The panel sits centred in the frame with generous even margins, the popup is quiet and easy to scan, and the flat picture reads as a printed diagram of a modal dialog rather than as a photograph of a device.',
    /** 短版：只点"内容有哪几块 + 什么调性"，分区照样交给 AI。 */
    promptShort: 'Flat minimal mobile game popup, portrait: a warm off-white screen dimmed by one even sheet of seventy percent black with a single white rounded panel floating in the middle of it. The panel is the detail sheet of one hero: a flat white stencil portrait of a musketeer on a muted brick red tile, the name "火枪", a small teal pill "LV.12", a thin teal experience bar with the pale grey text "120 / 347", a list of five attributes each with a small white glyph, a slate name and a dark value, one teal-tiled skill icon with the name "爆头冲击（被动）" and two lines of grey text, one single teal pill button labelled "升 级" with a small white arrow, a small experience emblem showing "1,280", a small gold coin glyph showing "640", and a thin slate cross to close it. How the panel is divided and how large each part is are left open. Everything is one flat tone with no gradient, no shadow, no glow and no texture, in a palette of one cool ink family, one teal, one muted brick red and one warm gold only.',
    /** 换态说明（不是独立出图要求）：把这三处换掉就是未解锁态。 */
    variants: [
        '头像上盖一把白色小锁，英雄信息整块变灰',
        '去掉等级与经验（未解锁没有档案）',
        '唯一的主按钮文案变「解 锁」，旁边换成**金币**价 675（而非经验）',
    ],
};

// ============================ 生成 ============================

function stencilPrompt(subject) {
    // 顺序与英雄/技能/难度清单一脉相承：
    // 这是什么 → 主体 → 画法 → 题材细节 → 光照 → 可读性 → 构图方 → 底与锚 → 承载底 → 收尾
    return [KIND, subject, ...DRAWING_GEOM, DETAIL, LIGHT, READING, SQUARE, MASS, BACKGROUND, CLOSE].join(' ');
}

function buildItems() {
    return ICONS.map((i) => ({
        key: i.key,
        code: i.code,
        hero: i.name,
        group: 'attr',
        name: i.name,
        where: i.where,
        optional: i.optional,
        // `slot` 只为对齐 `check-hero-icons.py` 的契约：它的 `EXPECT = {emblem:256, icon:64}`
        // 在 `--installed` 模式下按 `slot` 取期望边长，写 'icon' 正好等于本清单的 64。
        slot: 'icon',
        size: ICON_SIZE,
        gen_size: GEN,
        wh_ratio: '1:1',
        out_png: `${i.key}.png`,
        icon_path: i.iconPath,
        prompt_t2i: stencilPrompt(i.subject),
        prompt_zh: i.zh,
    }));
}

function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 一张 CSV 装全部：`comfyui_batch.py --only <key,...>` 分批投（比例不同，必须分两批）。 */
function toCsv(items) {
    const cols = ['key', 'name', 'wh_ratio', 'size', 'out_png', 'icon_path', 'prompt_t2i', 'prompt_zh'];
    const lines = [cols.join(',')];
    const rows = [
        ...items.map((it) => ({ ...it, size: it.size })),
        {
            key: POPUP.key, name: POPUP.name, wh_ratio: POPUP.ratio, size: '—',
            out_png: `${POPUP.key}.png`, icon_path: '', prompt_t2i: POPUP.prompt, prompt_zh: POPUP.zh,
        },
    ];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// ============================ 内容清单（提示词的唯一口径） ============================

/** 「弹窗要显示什么」—— 提示词里的每一项都来自这张表，数据全部取自真配表。 */
const CONTENT_TABLE = [
    ['英雄头像', '白描徽记（`textures/heros/*`），暗红 `#A85A5A` 底', '头像**不是**彩色立绘，是本作那套白色单色徽记'],
    ['英雄名', '「火枪」', '`units.json` 的 `name`'],
    ['等级', '「LV.12」', '未解锁时**不显示**（没有档案）'],
    ['经验（可升级用）', '进度条 + 「120/347」+ 一句「升下一级需要 347 经验」', '**升级花的就是它**；数字 = 持有 / 本级所需'],
    ['五项属性 + 每级成长', '最大生命 452（+12/级）· 最大魔法 120（—）· 攻击力 73（+3/级）· 攻击速度 120%（—）· 攻击距离 250（—）', '英雄**真配了的 5 项**，不是英雄卡上那 4 行（卡上第 3 行「护甲」对英雄恒为 0）'],
    ['技能', '图标 + 「爆头冲击（被动）」+ 效果文案', '英雄自带技能**恰好 1 个且必为被动**'],
    ['唯一的主操作按钮', '「升 级」（可升级 = 青绿 `#3F9E9B`；经验不够 = 浅灰 `#B9C1C1` 且点不动）', '一屏**只许一个**主按钮'],
    ['升级要花的资源', '经验 347（= 本级所需）', '**花经验，不花金币**'],
    ['持有的可升级资源', '通用英雄经验 1,280', '一局结束时发放，所有英雄共用'],
    ['解锁用的货币', '金币 640', '金币**只用于解锁英雄**，不参与升级'],
    ['关闭入口', '右上角细描边 ×', '弹窗的唯一出口'],
    ['未解锁的同款态', '信息整块灰 + 头像盖白锁 + 去掉等级与经验 + 按钮变「解 锁」+ 金币价 675', '与已解锁态是**同一个弹窗**，只换 3 处'],
];

/** 「这些一律不要出图」。 */
const NO_ART_TABLE = [
    ['面板底 / 圆角 / 描边环', '`common/rect_rd_20` · `rect_rd_10` · `rect_rd_5` · `rect_board_rd_*`', '九宫格贴图 + 运行时染色；**不要出"面板底纹"图**（风格禁止材质）'],
    ['关闭 × / 未解锁锁 / 角饰', '`common/close` · `common/lock` · `common/conor`', '现成的白描挖空图'],
    ['英雄头像 / 技能图标', '`textures/heros/*` · `textures/skills` 图集', '10 个英雄都有；技能图走 `common/AtlasIcon.ts` 三级降级'],
    ['生命 / 攻击 / 护甲 / 攻击距离图标', '`common/heart` · `property/atk` · `property/defence` · `property/atk_range`', '已有；本次只补缺的**攻速**与**魔法**两个'],
    ['经验 / 金币 / 升级箭头图标', '`common/exp_icon`（青绿本色）· `common/gold`（染 `c-gold #D38C1E`）· `common/right`', '金币图标**必须染成 `#D38C1E`**（工程历史上"两态色把金币图标染了"当 bug 记过）'],
    ['进度条 / 分隔线', '`rect_rd_20` 九宫格 + `Sprite.color` · `cc.Graphics`', '填充 `#70ACB3`、轨道 `#D8D8D8`；线是代码画的'],
    ['**所有文字与数字**', '**`cc.Label`**', '**绝不出图**：英雄名 / 等级 / 经验数字 / 属性名与值 / 技能名与效果 / 按钮文案 —— 出了就不可本地化、不可改字号、不可染色'],
];

function buildMd(items) {
    const L = [];
    const p = (s = '') => L.push(s);

    p('# 英雄详情弹窗 · AI 提示词（只描述显示内容）');
    p();
    p('> 本文件由 `node tools/hero-detail-prompts/gen-prompts.mjs` 生成，**别手改** —— 改内容改生成器。');
    p('> 同目录另有 `prompts.json`（机读）与 `prompts.csv`（投递用），以及 `README.md`（面板契约 / 数据来源 / 施工清单）。');
    p();
    p('**口径**：提示词**只讲"这个弹窗要显示什么" + "它是一个弹窗"** —— 布局、分区、尺寸、留白、视觉组织');
    p('**全部交给 AI 自己分析**，提示词里不出现施工级坐标。需要施工规格时另看 `README.md`。');
    p();
    p('---');
    p();
    p('## 0. 这个弹窗要显示什么（提示词的唯一内容口径）');
    p();
    p('| 显示什么 | 长什么样（样例用真配表的火枪 12 级） | 口径 / 坑 |');
    p('|---|---|---|');
    for (const [a, b, c] of CONTENT_TABLE) p(`| ${a} | ${b} | ${c} |`);
    p();
    p('### 0.1 两条已拍板的规则');
    p();
    p('1. **升级花经验，经验在一局结束时发放**（所有英雄共用一份通用英雄经验池）。');
    p('   金币**只用来解锁英雄**（`500 × 1.35^列表序号`），不参与升级 —— 所以面板上两种资源都要**看得见**，但用途要分清。');
    p('2. **面板必须自带资源读数**：弹窗遮罩是**全屏**的（`rgba(0,0,0,.70)` 盖 750×1334），');
    p('   主界面顶栏那条资源栏会被一起压暗 —— 玩家在弹窗里**看不到顶栏**，所以「经验 / 金币」要画进弹窗。');
    p();
    p('### 0.2 这一版改了哪两处（相对上一版）');
    p();
    p('| 项 | 上一版 | 这一版 |');
    p('|---|---|---|');
    p('| 升级花什么 | 金币（`50 × 1.25^(lv-1)`） | **经验**（= 本级所需，`100 × 1.12^(lv-1)`） |');
    p('| 提示词写到什么粒度 | 逐格坐标（"经验条 300×10 @ x=+4"） | **只写显示内容**，布局交给 AI 分析 |');
    p();
    p('> ⚠ **一处实现后果**（写代码时躲不掉）：`HeroData.addHeroExp()` 现在是**发经验即自动升级**的循环');
    p('> （`HeroData.ts:139-155`），而"在详情面板花经验升级"要求**发经验只进池、升级要玩家手动点**。');
    p('> 落地时必须二选一：① 新增一份**通用经验池**（放 `ItemData` 或 `PlayerInfo`）并让 `addHeroExp` 只加不升；');
    p('> ② 沿用 per-hero 的 `exp` 字段但**删掉自动升级循环**，把升级收敛到面板这一条路径。');
    p();
    p('---');
    p();
    p('## 1. 主提示词：给 AI 描述「弹窗要显示什么」');
    p();
    p('> 三版同一个内容口径，按用途挑一条：**中文版**给"AI 设计器/实现者"（要规格），');
    p('> **英文版**给图像模型（要效果图），**极简版**只列内容（上下文紧张或想先试一版）。');
    p();
    p('### 1.1 中文版（可直接复制 · 给 AI 设计器 / 前端 / Cocos 实现者）');
    p();
    p('```text');
    p('请设计《集合防御》里的「英雄详情」界面。**它是一个弹窗**（模态浮层）：全屏遮罩 + 浮在中间的面板，');
    p('背景是主界面被压暗后的样子。');
    p();
    p('【只要求这些内容，布局由你自己分析决定】');
    p('下面这些内容怎么分区、每块多大、留白怎么留、视觉层级怎么排，你按最清晰易读的方式自己定 ——');
    p('我只规定「必须显示什么」，不规定摆在哪。');
    p();
    p('【必须显示的内容】（括号里是样例数据，用这些真实感数据，不要占位文案）');
    p('1. 英雄头像（本作是白色单色徽记，暗红底，不是彩色立绘）');
    p('2. 英雄名：「火枪」');
    p('3. 等级：「LV.12」');
    p('4. 经验：进度条 + 「120 / 347」+ 一句「升下一级需要 347 经验」');
    p('5. 五项属性，每项都要有「当前值」和「每级成长」：');
    p('   最大生命 452（+12/级）· 最大魔法 120（—）· 攻击力 73（+3/级）· 攻击速度 120%（—）· 攻击距离 250（—）');
    p('6. 技能：图标 + 名称「爆头冲击（被动）」+ 效果文案「普攻附带 5% 攻击力的额外伤害；15% 概率击退敌人 1m」');
    p('7. **一个主操作按钮**：「升 级」。已解锁时它有两种状态要能画出来：可升级 / 经验不足（置灰点不动）');
    p('8. 升级要花的资源：经验 347（**升级花经验，不花金币**）');
    p('9. 持有的通用英雄经验：1,280（一局结束时发放，所有英雄共用）');
    p('10. 金币 640（**金币只用于解锁英雄**，不参与升级）');
    p('11. 关闭入口');
    p('12. 同一个弹窗的**未解锁态**：英雄信息整块置灰 + 头像盖一把白锁 + 去掉等级与经验 + 按钮文案变「解 锁」、旁边换成金币价 675');
    p();
    p('【视觉风格（这是本项目既定风格，不是可选项）】');
    p('浅色纸面上的低多边形几何、双色制、大留白、图纸沙盘感；**零渐变、零投影、零发光、零材质纹理**。');
    p('颜色只有这几个来源：墨色阶 #445054 / #56636A / #6A696B / #999999（文字与图标）、');
    p('青绿 #67999A / #70ACB3（**只表示系统与操作**：按钮、进度、可点元素）、');
    p('暗红 #A85A5A（**只表示英雄与人**：头像格）、暖金 #D38C1E（**只表示货币**：经验与金币读数）。');
    p('字号只用 40 / 24 / 20 / 16 / 14 / 12；圆角只用 4 / 8 / 16；间距只用 6 / 10 / 20 / 30。');
    p('图标一律几何线稿（圆/方/三角/菱/环/盾/箭头的组合），不要 emoji、不要写实图形、不要贴图。');
    p();
    p('【硬约束】');
    p('- 一屏**只有一个**主按钮；不许出现第三种强调色');
    p('- 所有文字与数字都必须是**可替换的文本**（不要做成图片）');
    p('- 弹窗自带资源读数（遮罩会把主界面顶栏压暗，玩家看不到顶栏）');
    p();
    p('【交付】先给一段「设计说明」（≤120 字：这一屏服务什么动作、视觉引导顺序），');
    p('再给一节「你决定的分区方案」（每块放什么、为什么这么排、留白怎么留），最后给「自检」（上面 12 项是否都在）。');
    p('```');
    p();
    p('### 1.2 英文版（给图像模型 · 要一张效果图）');
    p();
    p(`- 比例 **${POPUP.ratio}**　装机：${POPUP.install}`);
    p(`- 中文（校对用，**不投递**）：${POPUP.zh}`);
    p();
    p('**英文提示词**');
    p();
    p('```text');
    p(POPUP.prompt);
    p('```');
    p();
    p(`**短版（同图简写 · ~${POPUP.promptShort.split(/\s+/).length} 词 · 上下文紧张或先试一版时用）**`);
    p();
    p('```text');
    p(POPUP.promptShort);
    p('```');
    p();
    p('**未解锁态怎么画**（不是单独一条，把下面三处换掉即可）：');
    p();
    for (const v of POPUP.variants) p(`- ${v}`);
    p();
    p('### 1.3 极简版（只列内容 · 想先试一版时用）');
    p();
    p('```text');
    p('画一个手游的「英雄详情」弹窗（竖屏，模态浮层，全屏遮罩 + 白色圆角面板浮在中间）。');
    p('面板里显示：英雄头像、名字「火枪」、等级「LV.12」、经验条与「120/347」、');
    p('五项属性（最大生命 452 +12/级、最大魔法 120、攻击力 73 +3/级、攻击速度 120%、攻击距离 250）、');
    p('一个技能（爆头冲击 · 被动 · 效果文案）、一个主按钮「升 级」（花 347 经验）、');
    p('持有的通用英雄经验 1,280、金币 640、关闭入口。');
    p('布局、分区、尺寸、留白你自己分析决定，只要这几项都在、且一眼能找到「等级经验」和「升级按钮」。');
    p('风格：浅色纸面低多边形几何、大留白、零渐变零投影零发光；墨色阶文字 + 青绿操作色 + 暗红英雄色 + 暖金货币色；');
    p('字号只用 40/24/20/16/14/12，圆角只用 4/8/16。');
    p('```');
    p();
    p('---');
    p();
    p('## 2. 要新出的 2 个属性图标（白描，1:1 → 64×64）');
    p();
    p('面板要显示英雄**真配了的 5 项属性**，而 `textures/property/` 只有 `atk` / `defence` / `atk_range` ——');
    p('**缺「攻击速度」与「最大魔法」**（这正是英雄卡一直不显示攻速的原因）。这两个是要出图的。');
    p();
    p('| # | key | 是什么 | 用在哪 | 装机路径 |');
    p('|---|---|---|---|---|');
    items.forEach((it, i) => {
        p(`| ${i + 1} | \`${it.key}\` | ${it.name} | ${it.where} | \`${it.icon_path}\` |`);
    });
    p();
    p('**规格**：出图 512×512（1:1）→ 交付 **64×64 RGBA**；主体**纯白 `#FFFFFF` 单色**（不透明像素只许一个白）；');
    p('出图画在**深板岩灰 `#445054`** 承载底上，本地按四边采样**色键抠掉** → 真透明，可用 `Sprite.color` 染色。');
    p('风格段 `import` 自 `tools/hero-icon-prompts/gen-prompts.mjs`（与英雄头像 / 技能图标 / 难度徽记同一份）。');
    p();
    for (const it of items) {
        p(`### 2.${items.indexOf(it) + 1} \`${it.key}\`　${it.name}`);
        p();
        p(`- 交付：\`${it.out_png}\`　**${it.size}×${it.size}**　装机：\`${it.icon_path}\``);
        p(`- 中文（校对用，**不投递**）：${it.prompt_zh}`);
        p();
        p('**英文提示词**');
        p();
        p('```text');
        p(it.prompt_t2i);
        p('```');
        p();
    }
    p('> ⚠ 两条防撞形要求（**这是这套图标唯一的构图硬指标**）：');
    p('> `hero_attr_atk_speed` 不能像 `property/atk`（斜匕首）或 `property/atk_range`（圆盘 + 同心弧）；');
    p('> `hero_attr_mana` 不能像 `common/gold`（圆盘挖 ¥）、`common/energy`（闪电）或 `common/exp_icon`（青绿菱形）。');
    p();
    p('---');
    p();
    p('## 3. 这些一律不要出图');
    p();
    p('| 要什么 | 用什么 | 说明 |');
    p('|---|---|---|');
    for (const [a, b, c] of NO_ART_TABLE) p(`| ${a} | ${b} | ${c} |`);
    p();
    p('---');
    p();
    p('## 4. 怎么投递');
    p();
    p('```powershell');
    p('# 0) 生成/刷新清单（幂等）');
    p('node tools/hero-detail-prompts/gen-prompts.mjs');
    p();
    p('# 1) 2 个属性图标：Resolution Selector = 1:1 / 0.25MP');
    p('python tools/relic-icon-prompts/comfyui_batch.py `');
    p('  --workflow .tmp/comfy_api_base.json --csv docs/hero-detail/prompts.csv `');
    p('  --prompt-node 7 --prompt-key value --route t2i `');
    p('  --out .tmp/hero-detail-icons-out --skip-existing --free-every 0 --unload-every 0 `');
    p(`  --only ${items.map((i) => i.key).join(',')}`);
    p();
    p('# 2) 弹窗效果图：Resolution Selector 改成 9:16 后跑这一条（输出目录不同）');
    p('python tools/relic-icon-prompts/comfyui_batch.py `');
    p('  --workflow .tmp/comfy_api_base.json --csv docs/hero-detail/prompts.csv `');
    p('  --prompt-node 7 --prompt-key value --route t2i `');
    p(`  --out .tmp/hero-detail-scenes-out --skip-existing --only ${POPUP.key}`);
    p('```');
    p();
    p('### 4.1 出完图怎么处理与装机（**只对 2 个图标**）');
    p();
    p('```powershell');
    p('# 3) 色键抠底 + 拍平白 + 正方形包围盒 → 64×64');
    p('python tools/hero-icon-prompts/make-hero-icons.py `');
    p('  --src .tmp/hero-detail-icons-out --dst .tmp/hero-detail-icons-final `');
    p('  --prompts docs/hero-detail/prompts.json');
    p();
    p('# 4) 体检（真 alpha / 正方形 / 64×64 / 留白 / 纯白比例）');
    p('#    ⚠ 必须带 --prompts，否则它按**英雄那份**清单取期望边长（本清单的 key 不在里面 → 尺寸检查被跳过）');
    p('python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/hero-detail-icons-final `');
    p('  --prompts docs/hero-detail/prompts.json --limit 20');
    p();
    p('# 5) 装机（缺省只演练，看清楚再 --apply；装完切回 Cocos 窗口让它导入生成 .meta）');
    p('python tools/hero-icon-prompts/install-hero-icons.py `');
    p('  --src .tmp/hero-detail-icons-final --prompts docs/hero-detail/prompts.json --apply');
    p('```');
    p();
    p('> ⚠ **弹窗效果图不跑第 3 步**（跑了会把概念稿毁掉），也不用装机：存成 `docs/hero-detail/popup.png` 就完事。');
    p('> ⚠ `textures/property/atk_speed.png` 与 `mana.png` 是**新文件**，`.meta` 要等 Cocos 编辑器首次导入才生成，**必须随提交入库**。');
    p();
    p('---');
    p();
    p('## 5. 验收清单');
    p();
    p('- [ ] 效果图里看得出来**这是一个弹窗**：全屏遮罩 + 浮在中间的面板 + 背景被压暗；');
    p('- [ ] 12 项内容**一项不缺**：头像 / 名字 / 等级 / 经验条与数字 / 5 项属性（含每级成长）/ 技能 / 一个主按钮 / 升级所需经验 / 持有经验 / 金币 / 关闭入口 / 未解锁态说明；');
    p('- [ ] **只有 1 个主按钮**，且看得出「可升级 / 经验不足」两态；');
    p('- [ ] 升级花的是**经验**（不是金币），金币只出现在解锁语境里；');
    p('- [ ] 一屏只有**一个**强调色家族（青绿），没有第四种颜色；暗红只在头像上、暖金只在货币上；');
    p('- [ ] 没有渐变、没有投影、没有发光、没有材质纹理；');
    p('- [ ] 面板里**自带资源读数**（不能假设玩家看得到主界面顶栏）；');
    p('- [ ] 2 个图标与 `property/atk` `property/defence` `property/atk_range` `common/heart` **摆成一行看不出是两批出的图**；');
    p('- [ ] 每张图标 `形变 ≤ 1.15×`（后处理打印；超了改**具体构图动作**再跑，别接受形变）；');
    p('- [ ] 图标**缩到 20×20** 还认得出，且染成 `#6A696B` 与 `#70ACB3` 两种色都读得清；');
    p('- [ ] 效果图里的文字**只当版式锚点**（错字不算不合格），但「升级按钮」与「等级经验」必须一眼找得到。');
    p();
    return L.join('\n');
}

// ============================ main ============================

function main() {
    const items = buildItems();

    const lens = items.map((it) => it.prompt_t2i.split(/\s+/).length);
    const minL = Math.min(...lens);
    const maxL = Math.max(...lens);
    const popupWords = POPUP.prompt.split(/\s+/).length;
    console.log(`◆ 主提示词 1 条（弹窗内容）+ 属性图标 ${items.length} 条 = ${items.length + 1} 条`);
    console.log(`◆ 图标提示词词数 ${minL}~${maxL}（参照：已装机的技能图标 549~634、难度徽记 578~690）`);
    if (minL < 480) console.warn(`  ⚠ 有图标提示词偏短（${minL} 词），主体段可能太薄`);
    if (maxL > 720) console.warn(`  ⚠ 有图标提示词偏长（${maxL} 词），可精简主体段`);
    const [lo, hi] = POPUP.words;
    const tag = popupWords < lo ? '⚠ 偏短' : popupWords > hi ? '⚠ 偏长' : '√';
    console.log(`◆ 弹窗效果图提示词 ${tag} ${popupWords} 词（期望 ${lo}~${hi}） · 另有短版 ${POPUP.promptShort.split(/\s+/).length} 词`);

    if (DRY_RUN) {
        console.log('\n◆ --dry-run：不写盘。示例（弹窗提示词前 400 字）：\n');
        console.log(POPUP.prompt.slice(0, 400) + ' …');
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const write = (name, content) => {
        const fp = path.join(OUT_DIR, name);
        fs.writeFileSync(fp, content, 'utf8');
        console.log(`  √ ${path.relative(ROOT, fp).replace(/\\/g, '/')}  (${Buffer.byteLength(content)} B)`);
    };

    write('prompts.json', JSON.stringify({
        meta: {
            generated_by: 'tools/hero-detail-prompts/gen-prompts.mjs',
            version: 2,
            target: '英雄详情弹窗（局外 · Scene_Menu）：显示英雄所有信息 + 升级（**花经验**）+ 经验与货币读数',
            prompt_scope: '提示词只描述"要显示什么内容"与"这是弹窗"；布局/分区/尺寸由 AI 自行分析（不写施工级坐标）',
            style: 'flat single-colour white stencil (hero/skill/difficulty icon family), slate-grey keyed background',
            gen_size: GEN, gen_ratio: '1:1', deliver: ICON_SIZE,
            icon_base: PROP_BASE,
            contract: 'docs/hero-detail/README.md（面板契约 / 数据来源 / 施工清单）',
            note: 'items[] 走 make-hero-icons.py（色键/拍平白/正方形包围盒）；popup 是效果图，只做缩放、绝不要跑那个脚本',
            no_art: NO_ART_TABLE.map(([a, b, c]) => `${a} → ${b}（${c}）`),
            content: CONTENT_TABLE.map(([a, b, c]) => `${a}｜${b}｜${c}`),
        },
        items,
        popup: POPUP,
    }, null, 2) + '\n');
    write('prompts.csv', toCsv(items));
    write('prompts.md', buildMd(items));
    console.log('◆ 完成。下一句：python tools/relic-icon-prompts/comfyui_batch.py --csv docs/hero-detail/prompts.csv …（见 prompts.md §4）');
}

main();
