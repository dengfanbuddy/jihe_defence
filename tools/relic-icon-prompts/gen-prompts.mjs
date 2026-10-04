#!/usr/bin/env node
/**
 * gen-prompts.mjs —— 生成《集合防御》遗物图标的 AI 出图提示词清单（307 条）。
 *
 * 输入（都是权威源，别在本脚本里重复维护内容）：
 *   · tools/relic-icon-prompts/subjects.json   ← **作者数据**（每件遗物的英文视觉描述 + 中文/英文名 + 形态分类）
 *   · assets/resources/tb/relics.json          ← 遗物表（取 id / icon / rarity / scope，并逐条对回 subjects）
 *   · assets/resources/textures/relics/*.png   ← 本地已有的原图（有 = 可走「参考图重绘」路线 A）
 * 输出到 docs/relic-icon/：
 *   · prompts.json   机器读（307 条 + 元信息）
 *   · prompts.csv    给 ComfyUI 批量脚本读（UTF-8 BOM + CRLF，Excel 双击不乱码）
 *   · prompts.md     人看（共享模板 + 逐条主题表）
 *
 * 风格口径的唯一真源：
 *   · 风格段 = docs/art-style/tokens.json 的 palette + prompt 块 + docs/art-style/ui-design-prompt.md §1.3
 *   · 提示词结构 = Qwen-Image-2.1 的 T2I 观察者散文（单图 Edit **不加** `<imageX>` 标签）
 *   · 成图规格 = RelicItem.prefab 的 `content/head/inner` 是 50×50 `sizeMode=CUSTOM` Sprite（代码只换 spriteFrame）
 *
 * 用法：
 *   node tools/relic-icon-prompts/gen-prompts.mjs              # 默认 --style cartoon
 *   node tools/relic-icon-prompts/gen-prompts.mjs --dry-run    # 只统计不写盘
 *
 * ⚠ 2026-10 事故记录：本文件曾被 `Get-Content | Set-Content` 以 **GBK** 覆写，中文注释与若干中文
 *   字符串被破坏（PS 5.1 的 Set-Content 默认按 ANSI 写盘）。当时靠"英文常量与代码全部完好"
 *   加"生成产物里保留着全部中文字符串"把本文件重建了回来。
 *   **教训：改本文件一律用编辑器或带编码参数的工具，禁止 `Get-Content | Set-Content` 回写。**
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SUBJECTS = path.join(HERE, 'subjects.json');
const RELICS = path.join(ROOT, 'assets/resources/tb/relics.json');
const ICON_DIR = path.join(ROOT, 'assets/resources/textures/relics');
const OUT_DIR = path.join(ROOT, 'docs/relic-icon');
const DRY_RUN = process.argv.includes('--dry-run');

/** 风格档：`--style cartoon|dota|dota-muted|project`（**默认 cartoon**；取值在 main() 里对着 STYLE_PRESETS 校验） */
const styleArg = process.argv.indexOf('--style');
const STYLE = styleArg >= 0 && process.argv[styleArg + 1] ? process.argv[styleArg + 1] : 'cartoon';

/** resources 内相对目录（配表 icon 列写的就是这个前缀，**不带扩展名**） */
const ICON_PREFIX = 'textures/relics';
/**
 * 交付尺寸：**64×64**（2026-10 口径：压到 64×64 再进图集）。
 * 显示槽位是 50×50，所以 64 是 1.28×。**原图 512×512 一律留着** ——
 * 以后换交付尺寸只是重跑 `make-delivery.py --size N`，不用重新出图。
 * （工程其它图标仍是 200×200：`textures/common`、`property`、`skills`；本次只改了遗物这一套。）
 */
const DELIVER_SIZE = 64;

// ============================ 共享风格段（改风格只改这里） ============================

/**
 * 风格四档（`--style`，**默认 `cartoon`**）：
 *   · `cartoon`    —— **默认档**（2026-10 用户口径「要明亮的卡通风格，要符合我们的游戏」）：平涂 cel shading +
 *                    粗匀圆头描边、**零装饰性材质**、**中明度主体**。最贴合美术圣经 §1.3
 *   · `dota`       —— 忠于 2026-10 那张测试斧头（`ComfyUI_00014_.png`）：厚涂材质 + 粗黑描边 + 大对比
 *                    ⚠ 用户看过之后两次反馈「太暗黑」，**不要拿它当默认**（实测明度只有 0.34~0.41）
 *   · `dota-muted` —— 同一套 dota 画法，但颜色收到项目双色（墨灰 + 青绿），商店整屏不会变成彩虹
 *   · `project`    —— 严格按美术圣经的"几何线稿"：低多边形平面几何、双色、细匀描边
 *
 * 实测依据（`.tmp/icon_style_probe.py` 逐像素量的那张测试图）：
 *   主体内相邻像素平均色差 26.2/765（工程平涂图标 < 8）、量化色数 1804（`common/atk.png` = 1 色纯白线稿）
 *   → 那张图是**厚涂/带明暗渐变**的，与 `project` 档的「平面哑光、无渐变、细匀描边」直接冲突，故分档。
 * 明度实测（`.tmp/bright_probe.py`，只统计 a>=128 的像素）：`dota` 档 4 张是 0.34~0.41，
 * 而美术圣经的底是浅色纸面（局外 `#EFEEED` / 局内 `#EBF4FB`）—— 目标区间见 PALETTE_CARTOON 的注释。
 */

/** 画法 · 明亮卡通（4 句；2026-10 用户口径「要明亮的卡通风格，符合我们的游戏」）
 * 与 `dota` 档的根本区别：**不是厚涂**。装饰性材质（划痕/木纹/做旧/锈迹）全部禁掉，
 * 改成「平涂 cel shading + 粗匀圆头描边」，颜色落在明度区间的**中间调**。
 * 依据：`docs/art-style/ui-design-prompt.md` §1.3 禁止渐变/投影/发光/纹理/拟物高光，
 * 且附录 D 把「出成暗底」列为已知走偏 —— 所以这一档连"压暗"这个词都不出现。 */
const DRAWING_CARTOON = [
    'The object is drawn as a bright cartoon game icon: its shape is built from a few simple chunky geometric volumes that read instantly at small size, and every form is closed by a bold, even, rounded outline of one dark slate tone.',
    'Colour is applied as flat cel shading: each surface carries one solid base colour plus at most one darker flat tone, with a hard clean edge between them and no soft blending anywhere.',
    'The surfaces stay completely clean: no scratches, no grain, no stitched creases, no rust, no grime, no wear and no painted texture, and no gradient, glow or specular highlight appears anywhere in the picture.',
    'The image is cheerful and simple rather than moody: the shapes are rounded and friendly, and the object keeps a solid mid-valued body closed by a strong dark outline, so both its silhouette and its interior stay legible when the icon is scaled down to a small square.',
];

/** 配色 · 明亮卡通（1 句）
 * ⚠ 这一句是**唯一管明度区间**的，改它之前先看 `docs/relic-icon/README.md` §2 的实测表。
 * 「明亮」不等于「高亮」：第一版写成 "sits in the light half of the value range"（浅灰钢/暖沙/奶油），
 * 实测明度 0.69~0.81，贴到白档品质框（`#DDDDDD`）上**42% 的像素融进底色**（最差 57.4%），
 * 而现有 dota 原图只有 5.0%。图标是 50×50 直接贴在**浅灰圆角框**上的，浅色主体必然糊。
 * 现在的口径 = **中明度主体 + 深描边 + 高明度只做受光边高光**。
 * ⚠ 判断可读性**必须带色度**（用 `.tmp/frame_de.py` 的 ΔE）：只看明度差会把"中明度身体 + 饱和底色"
 * 误判成不合格 —— 实测蓝/紫/红底按明度差算 48% 超标，按 ΔE 算**全部 0 张超标**。
 */
const PALETTE_CARTOON = 'The palette is cheerful but sits in the middle of the value range rather than at the top of it: each material takes a solid mid-tone such as steel blue-grey, warm ochre, mid brown wood, muted teal or terracotta, the pale tone appears only as a highlight on the lit edge, and the object reads as a mid-valued shape with a clear light-and-dark structure; no neon, no pastel wash and no muddy near-black fill is used.';

/** 光 · 明亮卡通（1 句）：亮面=平涂本色，暗面=**占得住面积**的一档深色（给主体补中明度质量），不投影 */
const LIGHT_CARTOON = 'The light is clear and even and comes from the front and slightly above: the lit surface is the flat base colour, the shaded surface is one flat step darker and covers roughly the shaded third of the shape, and the object casts no shadow onto the empty field around it.';

/** 收尾 · 明亮卡通 */
const CLOSE_CARTOON = 'The overall composition is a single centred object on a transparent square field, brightly lit and easy to read, with even margins all round and the friendly, tidy look of a casual mobile game item icon.';

/** 画法 · dota 厚涂（4 句）
 * 注意第 3 句是**唯一管明度**的一句（其余三句都在讲画法/材质/描边）：
 * 第一版把它写成「整体压暗」（heavy and dark / deep shadow / muted and heavy），实测明度只到 0.21~0.25，
 * 大面积主体（胸甲那类）甚至 70% 面积是暗部、5% 近黑。现在改成**明度区间约束**（大部分面积中到亮、
 * 暗部少数且限背光侧、最暗只到深炭灰不到黑），并把「大面积平面」单独点名 —— 实测它是最容易糊成黑的一块。
 * ⚠ 别再往这 4 句里加形容词：Qwen-Image-2.1 的 T2I 提示词按官方口径是 400~500 词，这套风格块已经
 * 占 ~500 词，加一句就会把提示词推到 600+ 词（`.tmp/style_words.js` 可以拆开数）。 */
const DRAWING_DOTA = [
    'The object is rendered the way a hand-painted Dota 2 item icon is: bold confident shapes, a heavy dark contour closing the whole silhouette, and interior shading that carries from a bright rim through a mid-tone body into a shadow confined to the side away from the light.',
    'Every material is described by texture rather than colour alone: cold steel with nicks and scratches, worn wood with visible grain, leather with stitched creases, and one warm accent colour (orange-red) reserved for the decorated band, the flame or the gem.',
    'The picture as a whole is bright and open rather than gloomy: warm mid-browns, light greys and pale highlights carry the greater part of the object, the dark values stay a minority confined to the side turned away from the light, and a broad flat surface facing the viewer — an armour plate, a cloak or a blade — reads as mid-grey steel, warm brown leather or light cloth rather than a near-black field.',
    'Contrast between the lit and the shaded side is clear, but the image never collapses into a black mass; the outline stays thick and closed all the way round, and the silhouette survives being scaled down to a small square icon.',
];

/** 画法 · 项目平面几何（4 句，美术圣经原文口径） */
const DRAWING_FLAT = [
    'The whole picture is drawn as a flat low-poly geometric illustration: the object is built from simple planes, wedges, rings, bevels and blocks, and its silhouette alone carries the shape.',
    'Every surface is flat and matte, one darker tone marks the shaded side and one lighter step marks the lit side, and every edge is closed by a thin, even, dark outline of uniform weight.',
    'There is no painted texture anywhere: no scratches, no grain, no stitched creases and no specular highlight, only clean geometric faces.',
    'No lettering, numeral, watermark, border or decorative mark is present.',
];

/** 配色 · dota 自由（1 句；只在 `dota` 档用） */
const PALETTE_DOTA = 'The palette follows the object itself rather than a fixed set of brand colours, keyed to a light mid value: the darkest tone anywhere is a deep charcoal or dark brown rather than black, the average tone sits at or above the middle of the range, and nothing is neon, pastel or rainbow-hued.';

/** 配色 · 项目双色（1 句；`project` / `dota-muted` 档用） */
const PALETTE_DUO = 'The palette stays inside a restrained duotone, with ink grey (#445054 and #465259) carrying the structure and the outline and teal (#67999A and #70ACB3) carrying the accents, while the materials of the object — wood, leather, iron, cloth, stone and glass — differ only by value steps of those same muted tones, and no third hue appears anywhere in the frame.';

/** 光 · dota 厚涂（左上高光 + 右下软阴影，与测试图一致） */
const LIGHT_DOTA = 'The light comes from the upper left at a steep angle: the top and left faces catch a bright rim, the lower right side steps down only a few values into a soft shadow covering a minority of the shape, and the warm accent sits at the brightest point of the frame; nothing casts a shadow onto the empty field.';

/** 光 · 项目平面（图表式均匀光，不留投影） */
const LIGHT_FLAT = 'The lighting is flat and even, as in a technical diagram: it falls from directly in front and slightly above, so the lit face of the object reads one value step lighter than its shaded face, and nothing in the frame casts a shadow.';

/** 收尾 · dota */
const CLOSE_DOTA = 'The overall composition is a single centred object on a transparent square field, read in clear light and mid-tones against nothing, with even margins all round and the mood of a well-used but well-kept piece of equipment.';

/** 收尾 · 项目 */
const CLOSE_FLAT = 'The overall composition is a single object centred on a transparent square field, balanced about the vertical axis, with generous even margins all round and a calm, schematic, uncluttered mood.';

/**
 * 交付硬要求（各档共用，与风格无关）：
 *   · 四周留白 —— 实测用户样图的主体**顶到了左/右/上三边**（包围盒边距 0.0% / 0.0% / 0.2%），
 *     放进 50×50 槽位 + 70×70 底框会被框切掉；这里写死「留出约十分之一」。
 *   · ⚠ 但这句**只是建议**：实测漂移很大（`magic_stick` 只留 1.2%、`clarity` 宽到 35.5%），
 *     真正保证留白的是交付步骤 `make-delivery.py`（按 alpha 包围盒归一到 80%）。
 */
const MARGIN = 'The whole silhouette stops short of every edge, leaving a margin of roughly one tenth of the frame empty on the left, on the right, above and below, so the object never touches the border of the square.';

/** 背景：完全透明（Qwen-Image-2.1 的 VAE 是 4 通道，T2I 可直接出 alpha）
 *
 * ⚠ 2026-10 踩过（两次，一起记下来）：
 *   ① 用户那张测试图：把浅灰棋盘格画进了像素（alpha 最小 237、61.4% 面积假透明）；
 *   ② 我自己写的一句 "reads clearly when placed on a pale grey plate"（本意是"贴到浅灰品质框上要清楚"）
 *      → 4 张图 alpha 全部 213~252、**整张不透** —— **提示词里只要提到"承载底"，模型就会把底画出来**。
 *   ③ 更反直觉的一次：把本句改写成"**不许是白的、不许是灰的、不许是任何平涂色**"并挪到段末之后，
 *      4 张图又全部变成"烘焙了一张近白圆角底板"（alpha 240~255，只有圆角处真透明）。
 *      → **扩散模型对否定式不可靠，"不要白/不要灰"反而把白灰引出来了**（经典 negation priming）。
 *   **结论：这一句改字要慎重 —— 只做正向陈述（"背景是透的、空的"），禁止列举"不要什么颜色"；
 *   任何关于"贴到什么底上"的话都不能写进来。** 真出假透明就走官方去背景模板（README §4）。
 */
const BACKGROUND = 'Nothing else appears in the frame: the field around the object is fully transparent, with no backdrop, no ground plane, no horizon, no floor shadow and no border, so the empty area shows evenly to the left, to the right, above and below the object.';

/** `--style` 名 → 风格句数组 */
const STYLE_PRESETS = {
    cartoon: [DRAWING_CARTOON, PALETTE_CARTOON, LIGHT_CARTOON, CLOSE_CARTOON],
    dota: [DRAWING_DOTA, PALETTE_DOTA, LIGHT_DOTA, CLOSE_DOTA],
    'dota-muted': [DRAWING_DOTA, PALETTE_DUO, LIGHT_DOTA, CLOSE_DOTA],
    project: [DRAWING_FLAT, PALETTE_DUO, LIGHT_FLAT, CLOSE_FLAT],
};
const STYLE_PRESETS_NAMES = Object.keys(STYLE_PRESETS);

/** 首句（锚点）：按档换口径，别让卡通档顶着「Dota 2 inventory item icon」的开头 */
const ANCHORS = {
    cartoon: (s) => `The image is a square cartoon game item icon of ${s}, isolated on a fully transparent background and drawn in a bright, clean, flat style that matches the rest of the game's light-toned interface art.`,
    project: (s) => `The image is a square flat-illustration game icon of ${s}, isolated on a fully transparent background and drawn in the same restrained geometric style as the rest of the game interface art.`,
    dota: (s) => `The image is a square hand-painted game item icon of ${s}, isolated on a fully transparent background in the style of a Dota 2 inventory item icon.`,
};

/**
 * 形态 → 摆位句（spatial）+ 朝向句（present）。
 * 只按「这件东西是什么形状」分档，保证 307 张的出图构图口径一致（这是图标成套的关键）。
 */
const KIND_TEMPLATE = {
    weapon_melee: {
        spatial: 'The weapon stands upright through the middle of the frame, its business end reaching into the upper third and its grip resting in the lower third, the whole of it inside the frame with clear space on every side.',
        present: 'It is turned so that its full profile faces the viewer, tilted a little off vertical so the blade runs from the lower left toward the upper right.',
    },
    weapon_ranged: {
        spatial: 'The weapon lies diagonally across the frame, its head in the upper right and its butt in the lower left, entirely inside the frame with margin on all four sides.',
        present: 'It is turned flat to the viewer so that its whole length reads at once.',
    },
    staff: {
        spatial: 'The staff runs vertically up the centre of the frame, its head filling the upper third and its foot stopping above the bottom margin.',
        present: 'It is turned slightly so that the head and its setting face the viewer.',
    },
    armor: {
        spatial: 'The armour is presented front-on and fills the middle of the frame, its shoulders near the upper third and its hem just above the bottom margin.',
        present: 'It is opened out flat so that its full shape reads as one silhouette.',
    },
    shield: {
        spatial: 'The shield faces the viewer squarely in the centre of the frame and occupies about three quarters of it, its rim staying clear of all four edges.',
        present: 'It is turned a few degrees off square so that its thickness shows along one side.',
    },
    helm: {
        spatial: 'The helmet sits centred, its crown in the upper third and its face opening toward the lower middle, wholly inside the frame.',
        present: 'It is turned three-quarters toward the viewer so that one side and the opening both read.',
    },
    boots: {
        spatial: 'The boot stands alone in the centre of the frame, its top at the upper third and its sole just above the bottom margin.',
        present: 'It is turned three-quarters toward the viewer, the toe angled a little to the left.',
    },
    jewelry: {
        spatial: 'The piece hangs in the exact centre of the frame and occupies roughly half its width, small in the frame but never so small that its structure is lost.',
        present: 'It is turned to face the viewer directly, its setting and its gem fully visible.',
    },
    garment: {
        spatial: 'The garment is opened out and centred, occupying the middle two thirds of the frame with even margins on every side.',
        present: 'It is turned front-on so that its outline reads as a single shape.',
    },
    consumable: {
        spatial: 'The item sits upright in the centre of the frame, complete and self-contained, its whole silhouette inside the middle third.',
        present: 'It is turned a little to one side so that its body and its opening both read.',
    },
    ward: {
        spatial: 'The ward stands upright in the centre of the frame, its carved head in the upper third and its stake running down into the lower third.',
        present: 'It is turned front-on so that the carving faces the viewer.',
    },
    book: {
        spatial: 'The book sits centred and slightly tilted, occupying about two thirds of the frame with clear space around it.',
        present: 'It is turned so that its cover faces the viewer and one corner lifts toward the light.',
    },
    gem: {
        spatial: 'The stone floats in the exact centre of the frame and occupies about half its width, its whole outline clear of the edges.',
        present: 'It is turned so that its main facet faces the viewer.',
    },
    banner: {
        spatial: 'The banner hangs from a short pole across the upper half of the frame, its cloth falling through the centre and stopping above the bottom margin.',
        present: 'It is turned slightly so that a fold of the cloth shows behind the front face.',
    },
    organ: {
        spatial: 'The piece is presented front-on in the centre of the frame, its whole form inside the middle two thirds.',
        present: 'It is turned a few degrees so that both its thickness and its curve read.',
    },
    plant: {
        spatial: 'The plant is centred in the frame, its full height inside the middle two thirds with even margins on every side.',
        present: 'It is turned so that its face and its stalk both read against the transparent field.',
    },
    creature: {
        spatial: 'The little figure stands centred in the frame, its whole body inside the middle two thirds and its feet just above the lower margin.',
        present: 'It is turned three-quarters toward the viewer so that its head and what it carries both read.',
    },
    tool: {
        spatial: 'The tool stands upright through the middle of the frame, its working end in the upper third and its handle running down into the lower third.',
        present: 'It is turned so that the full face of the blade meets the viewer.',
    },
    rune_glyph: {
        spatial: 'The symbol is centred in the frame as one abstract emblem and occupies about two thirds of it, built from a few bold geometric strokes of even weight.',
        present: 'It is drawn flat and front-on, its strokes evenly spaced around the centre.',
    },
    misc: {
        spatial: 'The object sits alone in the centre of the frame and occupies about three quarters of it, entirely clear of the edges.',
        present: 'It is turned three-quarters toward the viewer so that its form and its front face both read.',
    },
};

// ============================ 路线 A（Edit，中文指令） ============================

/**
 * 路线 A 的中文指令（Qwen-Image-2.1 Edit：单图**不加** `<imageX>` 标签，用观察者散文、正面陈述）。
 *
 * ⚠ 2026-10 修正：这段①画风原先写的是 dota 厚涂口径（"按 Dota 2 道具图标那种手绘厚涂质感重画"），
 * 加 `cartoon` 档时没同步 —— 于是 `--style cartoon` 会产出一段**与风格段自相矛盾**的中文指令。
 * 现在按档分开：`project` 用美术圣经双色口径，其余（cartoon / dota / dota-muted）用明亮卡通口径。
 * 路线 A 本轮没跑（用户用的是 T2I 工作流），但 README §3 把它列为推荐路线，所以这段得跟风格对齐。
 */
function editPrompt(zh, preset) {
    const flat = preset === 'project';
    const drawing = flat
        ? '①画风——《集合防御》的界面是浅色纸面上的低多边形几何，所以按这个口径重画：' +
          '形体只用简单平面、楔形、环、倒角与方块概括，剪影自己就把形状说清楚；' +
          '每个面都是平的、哑光的，暗面用一档更深的色、亮面用一档更亮的色，每条边用一条细而均匀的深色线收住；' +
          '**没有任何贴图质感**：不画划痕、不画木纹、不画缝线褶皱、不画金属高光；' +
          '颜色只用一套克制的双色 —— 墨色 #445054 / #465259 支撑结构与轮廓，青绿 #67999A / #70ACB3 做点缀，' +
          '木、革、铁、布、石、玻璃这些材质只靠这套色阶的深浅区分，画面里不出现第三种色相。'
        : '①画风——按**明亮卡通**的游戏道具图标重画：形体用几个简单、厚实的几何体概括，小尺寸下也要一眼认得出；' +
          '每个形体用一条粗、匀、圆头的深色描边收住轮廓；' +
          '上色是**平涂 cel shading**：每个面一块纯色底 + 最多一档更深的平涂，两者之间是硬的干净边，不做柔和过渡；' +
          '表面保持完全干净：不画划痕、不画木纹、不画缝线褶皱、不画锈迹、不画做旧、不画任何贴图纹理；' +
          '颜色落在明度的中间调：钢青灰、赭石、中褐木色、柔青绿、赭红，亮色只用在受光边的高光上；' +
          '不要霓虹色、不要粉彩、不要渐变、不要发光、不要高光反光。';
    return [
        `把图中这件道具「${zh}」重绘成《集合防御》里使用的游戏道具图标。要改的只有两件事：`,
        drawing,
        '②背景——去掉原图的方形卡片底与一切背景，输出**真正带 alpha 通道的透明背景**：物体之外的像素 alpha 必须是 0，不许把浅灰底或棋盘格画进像素里来假装透明；没有地面、没有地平线、没有落影、没有边框。',
        '必须保持不变的是：这件道具的造型轮廓、部件数量、部件之间的位置关系与比例，以及让它一眼可辨的特征；原图里的文字、数字与水印要一并抹掉。',
        '构图同样是单个道具居中、正对或略偏四分之三视角，物体外轮廓**不许顶到画面四边**，四周留出约十分之一的空白，整体轮廓完整落在画面内。',
    ].join('');
}

// ============================ 组装 ============================

/**
 * ⚠ 试过但**无效**、已撤掉的做法（留个记录，别再试一遍）：
 * 全量 307 张按 ΔE 体检时，白档 `#DDDDDD` 上有 33 张超标，全是浅色银剑/白帽/浅色宝珠
 * （`skadi` 54%、`fluffy_hat` 48%、`ultimate_orb` 45%…）。于是给这 33 条加过一句
 * 「浅色材质也要落深描边 + 中明度身体」（`subjects.json` 加 `"pale": true` 触发），
 * 实测**几乎没变**：skadi 54.4%→54.8%、ultimate_orb 45.3%→46.3%、fluffy_hat 47.7%→45.9%。
 * **原因是这些物件本身就该是浅色的**（银剑就是银的），"大面积浅色身体贴近浅灰底"不是描边能救的。
 * 看图确认过：这类图**实际是能认的** —— 深描边 + 一块中明度暗面把形状撑住了，
 * 是**指标没给描边记功**，不是图糊了。
 * 真要再压这个组合，**更有效的杠杆是白档底框颜色**（`ShopRelicsItem.RARITY_COLOR.common`
 * 从 `#DDDDDD` 略压深，或给框加一道描边），而不是继续改出图提示词。
 */
function t2iPrompt(subject, kind, preset) {
    const t = KIND_TEMPLATE[kind] ?? KIND_TEMPLATE.misc;
    const p = STYLE_PRESETS[preset] ?? STYLE_PRESETS.cartoon;
    const anchor = (ANCHORS[preset] ?? ANCHORS.cartoon)(subject);
    // 顺序：`BACKGROUND`（透明底）保持在第 2 句 —— **实测过它挪到段末会诱发"画一张底板"，
    // 已回退**（详见 BACKGROUND 的注释）。别凭"越靠后权重越高"的直觉改这里。
    return [anchor, BACKGROUND, t.spatial, t.present, ...p.flat(), MARGIN].join(' ');
}

function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
    if (!STYLE_PRESETS_NAMES.includes(STYLE)) {
        console.error(`✗ 未知风格档 --style ${STYLE}（可选：${STYLE_PRESETS_NAMES.join(' / ')}）`);
        process.exit(1);
    }
    const subjects = JSON.parse(fs.readFileSync(SUBJECTS, 'utf8'));
    const relicsRaw = JSON.parse(fs.readFileSync(RELICS, 'utf8'));
    const relics = Array.isArray(relicsRaw) ? relicsRaw : Object.values(relicsRaw);
    const localFiles = new Set(
        fs.existsSync(ICON_DIR)
            ? fs.readdirSync(ICON_DIR).filter(f => /\.png$/i.test(f)).map(f => f.replace(/\.png$/i, ''))
            : [],
    );

    const byKey = new Map(subjects.map(s => [s.key, s]));
    const byZh = new Map(subjects.map(s => [s.zh, s]));

    const rows = [];
    const missing = [];
    const usedSubjects = new Set();

    for (const relic of relics) {
        const stem = (relic.icon || '').split('/').pop()?.replace(/\.png$/i, '') || '';
        const s = (stem && byKey.get(stem)) || byZh.get(relic.name);
        if (!s) {
            missing.push(`${relic.id} ${relic.name}（icon=${relic.icon ?? '空'}）在 subjects.json 里没有对应条目`);
            continue;
        }
        usedSubjects.add(s.key);

        const hasLocal = localFiles.has(s.key);
        rows.push({
            index: rows.length + 1,
            relic_id: relic.id,
            key: s.key,
            name_zh: s.zh,
            name_en: s.en,
            kind: s.kind,
            rarity: relic.rarity ?? '',
            scope: relic.scope ?? '',
            icon_column: relic.icon ?? '',
            input_image: hasLocal ? `assets/resources/${ICON_PREFIX}/${s.key}.png` : '',
            out_png: `${s.key}.png`,
            out_size: DELIVER_SIZE,
            wh_ratio: '1:1',
            prompt_t2i: t2iPrompt(s.subject, s.kind, STYLE),
            prompt_edit_zh: hasLocal ? editPrompt(s.zh, STYLE) : '',
            note: hasLocal ? '' : '本地暂无原图：只能走文生图；出图后需把配表 icon 列指向本文件',
        });
    }

    const unused = subjects.filter(s => !usedSubjects.has(s.key));
    const kinds = {};
    for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;

    console.log(`✓ 提示词 ${rows.length} 条（遗物表 ${relics.length} 行）· 风格档 --style ${STYLE}`);
    console.log(`  可直接走「参考图重绘」的：${rows.filter(r => r.input_image).length} 条；只有文生图的：${rows.filter(r => !r.input_image).length} 条`);
    console.log(`  形态分布：${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (missing.length) {
        console.error(`✗ ${missing.length} 行遗物没有对应的视觉描述（subjects.json 缺条目）：\n  ${missing.join('\n  ')}`);
    }
    if (unused.length) {
        console.error(`✗ ${unused.length} 条 subjects.json 条目没有被任何遗物用到：${unused.map(u => u.key).join(', ')}`);
    }
    if (missing.length || unused.length) process.exit(1);
    if (DRY_RUN) {
        console.log('（--dry-run，没写盘）');
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    /**
     * 写盘（锁安全）：产物可能正被 Excel / WPS 打开 —— `prompts.csv` 在 Windows 上会抛 EBUSY。
     * 这时改写成 `<名字>.new` 并记下来，最后用退出码 1 提醒（**别抛异常把整批产物写坏一半**）。
     * JSON 与 CSV 都要走它。
     */
    const locked = [];
    const writeOut = (name, text) => {
        const dst = path.join(OUT_DIR, name);
        try {
            fs.writeFileSync(dst, text, 'utf8');
            return;
        } catch (err) {
            if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
                fs.writeFileSync(dst + '.new', text, 'utf8');
                locked.push(`${name} 被占用，已写成 ${name}.new`);
                return;
            }
            throw err;
        }
    };

    writeOut('prompts.json', JSON.stringify({
        generated_by: 'tools/relic-icon-prompts/gen-prompts.mjs',
        model: 'Qwen-Image-2.1（ComfyUI）',
        style: STYLE,
        wh_ratio: '1:1',
        deliver_size: `${DELIVER_SIZE}x${DELIVER_SIZE} PNG (RGBA)`,
        count: rows.length,
        items: rows,
    }, null, 2) + '\n');

    // ---- CSV ----
    const COLS = ['index', 'relic_id', 'key', 'name_zh', 'name_en', 'kind', 'rarity', 'scope', 'input_image', 'out_png', 'out_size', 'wh_ratio', 'prompt_t2i', 'prompt_edit_zh', 'note'];
    const csv = [COLS.join(',')]
        .concat(rows.map(r => COLS.map(c => csvCell(r[c])).join(',')))
        .join('\r\n') + '\r\n';
    writeOut('prompts.csv', '\uFEFF' + csv);

    // ---- MD（人看的：共享模板 + 逐条主题，307 行表） ----
    const md = [];
    md.push('# 遗物图标 · AI 出图提示词清单');
    md.push('');
    md.push(`> 由 \`tools/relic-icon-prompts/gen-prompts.mjs --style ${STYLE}\` 从 \`subjects.json\` 生成，**不要手改本文件**（改描述改 subjects.json 再重跑）。`);
    md.push('');
    md.push(`风格档：**\`${STYLE}\`**（可选 \`dota\` / \`dota-muted\` / \`project\`，换档重跑即覆盖本文件的三份产物）。`);
    md.push('');
    md.push(`共 **${rows.length}** 条（= \`relics.json\` 全部 ${relics.length} 行）：可直接走「参考图重绘」${rows.filter(r => r.input_image).length} 条，只有文生图 ${rows.filter(r => !r.input_image).length} 条。`);
    md.push('');
    md.push('完整提示词在 `prompts.json` / `prompts.csv`；本文件只列**共享模板**与**逐条主题**，方便肉眼看风格是否跑偏。');
    md.push('');
    md.push('## 一、两条路线（同一个主题，两种出图方式）');
    md.push('');
    md.push('| 路线 | 输入 | 提示词字段 | 适用 |');
    md.push('|---|---|---|---|');
    md.push('| **A 参考图重绘**（推荐） | 现成的 dota 图标（88×64） | `prompt_edit_zh`（中文指令） | 293 件肉鸽道具 + 7 件局外中立道具 —— 造型最保真 |');
    md.push('| **B 纯文生图** | 无 | `prompt_t2i`（英文散文） | 全部 307 件；也是 9 件没图的遗物（id 1~5 / 1296 / 1300）唯一的路 |');
    md.push('');
    md.push(`## 二、当前风格档 \`${STYLE}\` 的共享风格段（307 条都含这一段；换档改 \`gen-prompts.mjs\` 的 \`STYLE_PRESETS\`）`);
    md.push('');
    for (const s of STYLE_PRESETS[STYLE].flat()) md.push(`- ${s}`);
    md.push(`- ${MARGIN}`);
    md.push('');
    md.push('背景段（每条都有）：' + BACKGROUND);
    md.push('');
    md.push('## 三、逐条主题（`kind` 决定摆位与朝向句）');
    md.push('');
    md.push('| # | id | key | 中文名 | English | kind | 主题（英文视觉描述，插进模板 anchor 句） |');
    md.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
        const s = byKey.get(r.key);
        md.push(`| ${r.index} | ${r.relic_id} | \`${r.key}\` | ${r.name_zh} | ${r.name_en} | ${r.kind} | ${s.subject} |`);
    }
    md.push('');
    writeOut('prompts.md', md.join('\n'));

    console.log(`✓ 写盘：docs/relic-icon/prompts.json · prompts.csv · prompts.md（风格档 ${STYLE}）`);
    if (locked.length) {
        console.error('✗ 以下产物被占用，已写成 .new（关掉 Excel / WPS 后重跑；本次退出码 1）：');
        for (const l of locked) console.error(`   · ${l}`);
        process.exit(1);
    }
}

main();
