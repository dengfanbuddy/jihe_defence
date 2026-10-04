/**
 * 配置与模型登记表
 *
 * 这里的模型元数据是**建议性**的（用于 UI 联动、参数校验与费用预估），
 * 不作为硬性拦截依据 —— 火山方舟的真实能力以接口返回为准，遇到不支持的
 * 参数会返回明确的错误码，由 ark.mjs 归一化后透传到界面。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, '.data');
export const DEFAULT_OUT_DIR = path.join(ROOT, 'out');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 模型登记表
 *
 * id       : **带版本日期的真实模型 ID**，形如 `doubao-seedream-5-0-flash-260915`。
 *            ⚠ 两条实测结论（都踩过）：
 *            ① 日期必须对 —— flash 的真实日期是 260915，我先写成 260628 就报
 *               `InvalidEndpointOrModel.NotFound`；
 *            ② **不带日期的别名不能用于 generations** —— `doubao-seedream-5-0-flash`
 *               虽然能在 `GET /models` 列表里查到，但调图片生成会被拒（同样报 NotFound）。
 *               所以主 ID 必须是带日期的版本，不带日期的只作为「识别用户手输」的别名。
 *            换模型/换版本时，请点界面上的「拉取账户模型」再按提示改这里。
 * aliases  : 其它可用写法（不带日期 / 点号写法），仅用于识别用户填的 ID
 * sizeTiers: 支持的分辨率档位；也可传 `宽x高`（总像素须落在 minPixels~maxPixels 且比例 1/16~16）
 * transparent : 官方文档标注支持 background=transparent 的模型（5.0 pro / 5.0 flash）
 * png      : 官方标注 output_format 支持 png
 * priceCNY : 参考单价（元/张，输出图），仅用于界面费用预估，实价以火山方舟计费为准
 */
export const MODELS = [
    {
        id: 'doubao-seedream-5-0-flash-260915',
        aliases: ['doubao-seedream-5-0-flash', 'doubao-seedream-5.0-flash'],
        label: 'Seedream 5.0 flash（快、最便宜）',
        sizeTiers: ['1K', '1.5K', '2K'],
        defaultSize: '1K',
        minPixels: 921600,
        maxPixels: 4624220,
        maxRefImages: 10,
        transparent: true,
        png: true,
        sequential: false,
        stream: false,
        webSearch: false,
        priceCNY: 0.12,
        notes:
            'background=transparent 只「保留输入图已有的透明通道」：要求恰好 1 张输入图且该图至少 1 个透明像素（实测 400 原文见 README §4.1）—— 双图风格迁移用不了，透明请走色键抠图。生成最快、单价最低。ID 已用真实调用核对过（260915）',
    },
    {
        id: 'doubao-seedream-5-0-260128',
        aliases: ['doubao-seedream-5-0', 'doubao-seedream-5.0'],
        label: 'Seedream 5.0（综合）',
        sizeTiers: ['2K', '3K', '4K'],
        defaultSize: '2K',
        minPixels: 3686400,
        maxPixels: 16777216,
        maxRefImages: 14,
        transparent: false,
        png: true,
        sequential: true,
        stream: true,
        webSearch: true,
        priceCNY: 0.2,
        notes: '支持组图 / 联网搜索 / 流式输出；尺寸档位从 2K 起（最小总像素 368 万）',
    },
    {
        id: 'doubao-seedream-5-0-lite-260128',
        aliases: ['doubao-seedream-5-0-lite', 'doubao-seedream-5.0-lite'],
        label: 'Seedream 5.0 lite',
        sizeTiers: ['2K', '3K', '4K'],
        defaultSize: '2K',
        minPixels: 3686400,
        maxPixels: 16777216,
        maxRefImages: 14,
        transparent: false,
        png: true,
        sequential: true,
        stream: true,
        webSearch: true,
        priceCNY: 0.2,
        notes: '与 5.0 同档能力；账户里没开通时界面会标出「不在账户可用列表」',
    },
    {
        id: 'doubao-seedream-5-0-pro-260628',
        aliases: ['doubao-seedream-5-0-pro', 'doubao-seedream-5.0-pro'],
        label: 'Seedream 5.0 pro（画质最高）',
        sizeTiers: ['1K', '1.5K', '2K'],
        defaultSize: '1K',
        minPixels: 921600,
        maxPixels: 4624220,
        maxRefImages: 10,
        transparent: true,
        png: true,
        sequential: false,
        stream: false,
        webSearch: false,
        priceCNY: 0.3,
        notes:
            '图层拆分 / 精确编辑；透明背景同为「仅保留单图已有 alpha」（恰好 1 张输入图 + 该图至少 1 个透明像素）。不支持组图、联网搜索、流式输出',
    },
    {
        id: 'doubao-seedream-4-5-251128',
        aliases: ['doubao-seedream-4-5', 'doubao-seedream-4.5'],
        label: 'Seedream 4.5',
        sizeTiers: ['2K', '4K'],
        defaultSize: '2K',
        minPixels: 3686400,
        maxPixels: 16777216,
        maxRefImages: 14,
        transparent: false,
        png: true,
        sequential: true,
        stream: true,
        webSearch: false,
        priceCNY: 0.25,
        notes: '4K 超高清；尺寸档位从 2K 起（最小总像素 368 万）',
    },
    {
        id: 'doubao-seedream-4-0-250828',
        aliases: ['doubao-seedream-4-0', 'doubao-seedream-4.0', 'doubao-seedream-4-0-20260415'],
        label: 'Seedream 4.0（便宜老版）',
        sizeTiers: ['1K', '2K', '4K'],
        defaultSize: '1K',
        minPixels: 921600,
        maxPixels: 16777216,
        maxRefImages: 14,
        transparent: false,
        png: true,
        sequential: true,
        stream: true,
        webSearch: false,
        priceCNY: 0.2,
        notes: '多图融合 / 组图生成；部分场景只出 jpeg',
    },
    {
        id: 'doubao-seededit-3-0-i2i-250628',
        aliases: ['doubao-seededit-3-0-i2i', 'doubao-seededit-3.0-i2i'],
        label: 'SeedEdit 3.0（纯图片编辑，单图）',
        sizeTiers: ['adaptive', '512x512', '1024x1024'],
        defaultSize: 'adaptive',
        minPixels: 0,
        maxPixels: 0,
        maxRefImages: 1,
        transparent: false,
        png: false,
        sequential: false,
        stream: false,
        webSearch: false,
        priceCNY: 0.2,
        notes: '指令式图片编辑；只吃 1 张图，做不了「参考图+目标图」的风格迁移',
    },
];

/** 这个模型的所有可用写法（主 ID + 别名） */
export function modelIds(m) {
    return [m.id, ...(m.aliases || [])];
}

export function findModel(idOrAlias) {
    if (!idOrAlias) return null;
    const s = String(idOrAlias).trim();
    return MODELS.find((m) => modelIds(m).includes(s)) || null;
}

/** 归一化到主 ID（用户填的是别名时也认） */
export function canonicalModelId(idOrAlias) {
    const m = findModel(idOrAlias);
    return m ? m.id : String(idOrAlias || '').trim();
}

/** 默认提示词：参考图 = 图1（风格），目标图 = 图2（内容） */
export const DEFAULT_PROMPT = `参考图1（风格参考）的画风、材质质感、色彩饱和度与打光方式，把图2（目标图）中的装备道具重绘成同一风格的高品质游戏道具图标。

要求：
1. 严格保留图2道具的造型、结构、比例与辨识度，不要换成别的道具，不要添加多余物件；
2. 只改变画风：笔触、材质、配色、光影与细节精度统一到参考图的水准；
3. 道具单独居中放置，四周留出均匀留白，不要底座、不要投影板、不要边框；
4. 背景必须是纯色 {keyHex}，整张背景无渐变、无纹理、无噪点、无阴影；
5. 道具本身不要出现 {keyHex} 这个颜色，不要有同色描边、反光或高光。`;

export const PROMPT_PRESETS = [
    { name: '风格迁移 + 纯色背景（默认）', prompt: DEFAULT_PROMPT },
    {
        name: '风格迁移（英文）',
        prompt: `Restyle the prop in image 2 into the art style, material rendering and lighting of image 1.

Rules:
1. Keep the exact silhouette, structure and proportions of the prop in image 2 — do not swap it for another item, do not add extra objects;
2. Change ONLY the art style: brushwork, material, color grading, lighting and detail density must match image 1;
3. Center the prop with even margins; no pedestal, no shadow plate, no frame;
4. The background must be flat solid {keyHex} — no gradient, no texture, no noise, no shadow;
5. Never use {keyHex} inside the prop itself, and no outline or highlight of that color.`,
    },
    {
        name: '高清重绘（不放参考图，仅放大精修）',
        prompt: `把图1中的游戏道具重绘为高精度版本：保留原有造型、结构、比例与辨识度，补齐细节与材质质感，提升清晰度与光影层次。

要求：
1. 主体居中，四周均匀留白；
2. 背景必须是纯色 {keyHex}，无渐变、无纹理、无噪点、无阴影；
3. 道具本身不要出现 {keyHex} 这个颜色。`,
    },
    {
        name: '像素/手绘卡通化',
        prompt: `以图1为风格参考，把图2中的道具重绘成干净利落的手绘卡通游戏图标：粗描边、扁平色块、少量高光。

要求：
1. 保留图2道具的造型与辨识度；
2. 主体居中、四周留白；
3. 背景必须是纯色 {keyHex}，无渐变无纹理；
4. 道具本身不要出现 {keyHex} 这个颜色。`,
    },
];

/** 默认处理参数（界面初始值） */
export const DEFAULT_PARAMS = {
    model: 'doubao-seedream-5-0-flash-260915',
    customModel: '',
    prompt: DEFAULT_PROMPT,
    styleDesc: '', // 风格描述（可选）：实测模型更听文字而不是参考图像素，双图迁移时这是比参考图更强的杠杆
    appendKeyInstruction: true,
    labelImages: true,
    sizeMode: 'tier', // tier | custom
    sizeTier: '1K',
    sizeW: 1024,
    sizeH: 1024,
    optimizePrompt: 'none', // none | fast | standard
    outputFormat: 'png', // png | jpeg
    watermark: false, // 无水印
    sequential: 'disabled', // disabled | auto
    useRef: true, // 是否使用参考图（关闭 = 单图重绘）
    inputMaxEdge: 512, // 送进接口前把参考图/目标图等比缩放到这个最长边（0 = 保持原始尺寸；**只缩小，不放大**）
    inputUpscale: false, // 是否允许把小图放大后再送接口（默认 false：放大不增加细节，实测细节量掉 82%）
    alphaMode: 'chroma', // chroma | api | source | none
    keyColor: '#FF00FF',
    keyAuto: true, // 自动从生成图边缘探测背景色（覆盖 keyColor）
    keyTolerance: 88, // 泛洪容差：实测真实模型输出的边缘过渡带较宽，68 会留约 0.7px 杂边，88 降到 ~0.2px
    localGrow: 14, // 沿「与邻居颜色相近」生长，吃掉渐变/暗角背景
    despill: true,
    shrinkEdge: 1, // 边缘收 1px，压掉残留杂边
    trim: true,
    trimMargin: 2,
    padSquare: true,
    padSquarePad: 0.08,
    outSize: 512,
    jpegQuality: 95,
    // 批量
    inDir: '',
    outDir: DEFAULT_OUT_DIR,
    recursive: false,
    limit: 0,
    skipExisting: true,
    concurrency: 2,
    retries: 2,
    timeoutMs: 300000,
};

export function ensureDirs() {
    for (const d of [DATA_DIR, DEFAULT_OUT_DIR]) {
        fs.mkdirSync(d, { recursive: true });
    }
}

/** 读取持久化配置（API Key / 上次用的参数 / 上次的目录 / 账户模型列表） */
export function loadConfig() {
    ensureDirs();
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        saved = {};
    }
    return {
        apiKey: '',
        baseUrl: BASE_URL,
        params: {},
        ...saved,
    };
}

export function saveConfig(patch) {
    const cur = loadConfig();
    const next = { ...cur, ...patch };
    // 存盘时就归一化，避免「完整端点」被反复带下去
    if (typeof next.baseUrl === 'string' && next.baseUrl.trim()) next.baseUrl = normalizeBaseUrl(next.baseUrl);
    ensureDirs();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

/** 生效的 API Key：界面保存的优先，其次环境变量 */
export function effectiveApiKey() {
    const cfg = loadConfig();
    return cfg.apiKey || process.env.ARK_API_KEY || '';
}

/**
 * 归一化端点地址。
 * 踩过：用户从文档里复制的是**完整端点**（`…/api/v3/images/generations`）粘进「API 端点」，
 * 而代码还要再拼一次 `/images/generations` → 变成 `…/images/generations/images/generations`。
 * 所以这里容错：把末尾的具体资源路径剥掉，只留 base（`…/api/v3`）。
 */
export function normalizeBaseUrl(u) {
    let s = String(u || '').trim().replace(/\s+/g, '');
    s = s.replace(/\/+$/, '');
    let prev;
    do {
        prev = s;
        s = s.replace(/\/(images\/generations|chat\/completions|responses|models|embeddings)$/i, '');
    } while (s !== prev);
    return s.replace(/\/+$/, '') || BASE_URL;
}

export function effectiveBaseUrl() {
    const cfg = loadConfig();
    return normalizeBaseUrl(cfg.baseUrl || process.env.ARK_BASE_URL || BASE_URL);
}

/** 实际调用的完整端点（界面/日志里展示，避免用户再猜） */
export function imagesEndpoint(baseUrl = effectiveBaseUrl()) {
    return `${normalizeBaseUrl(baseUrl)}/images/generations`;
}

/** 合并后的默认参数（默认值 ← 上次保存 ← 本次请求） */
export function mergedDefaults() {
    const cfg = loadConfig();
    return { ...DEFAULT_PARAMS, ...(cfg.params || {}) };
}

/** 校验 & 归一化处理参数，返回 { params, warnings, meta } */
export function normalizeParams(input = {}) {
    const params = { ...mergedDefaults(), ...input };
    const warnings = [];
    const modelId = (params.customModel || '').trim() || params.model;
    params.resolvedModel = modelId;
    const meta = findModel(modelId);

    // 尺寸
    if (params.sizeMode === 'custom') {
        const w = Math.round(Number(params.sizeW) || 0);
        const h = Math.round(Number(params.sizeH) || 0);
        if (w < 16 || h < 16) {
            warnings.push('自定义宽高过小（至少 16x16），已回退到档位');
            params.sizeMode = 'tier';
        } else if (meta && meta.minPixels) {
            const px = w * h;
            const ratio = w / h;
            if (px < meta.minPixels || px > meta.maxPixels) {
                warnings.push(
                    `自定义尺寸 ${w}x${h}（总像素 ${px}）超出 ${meta.label} 允许的 ${meta.minPixels}~${meta.maxPixels}，接口可能报错`
                );
            }
            if (ratio < 1 / 16 || ratio > 16) {
                warnings.push(`自定义尺寸 ${w}x${h} 宽高比 ${ratio.toFixed(2)} 超出 1/16~16，接口可能报错`);
            }
        }
        params.size = `${w}x${h}`;
    } else {
        if (meta && meta.sizeTiers.length && !meta.sizeTiers.includes(params.sizeTier)) {
            warnings.push(`${meta.label} 不支持尺寸档位 ${params.sizeTier}，已回退到 ${meta.defaultSize}`);
            params.sizeTier = meta.defaultSize;
        }
        params.size = params.sizeTier;
    }

    // 透明通道走接口时：两条**实测**硬限制（2026-10 真调用 3 例，报错原文见 README / tests/check-transparent.mjs）
    //   ① background=transparent 要求**恰好 1 张输入图**（2 图必报 InvalidParameter）
    //   ② 输入图必须**本身已经有透明像素** —— 它是"保留已有 alpha"，**不是去背景**
    if (params.alphaMode === 'api') {
        if (params.useRef) {
            // 以前这里是**静默**把 useRef 改成 false（只送目标图）—— 用户以为在做风格迁移，
            // 实际是单图重绘，批量时白花钱。现在只警告，真正的拒绝在 pipeline（下单前、不花钱）。
            warnings.push(
                '「接口直出透明」与「使用参考图」互斥：接口要求恰好 1 张输入图，风格迁移做不了 —— 请改用「色键抠图」'
            );
        }
        if (params.outputFormat === 'jpeg') {
            warnings.push('接口透明背景与 output_format=jpeg 互斥，已改用 png');
            params.outputFormat = 'png';
        }
        if (meta && !meta.transparent) {
            warnings.push(`${meta?.label || modelId} 官方未标注支持透明背景，接口可能报错（可换 5.0 pro / 5.0 flash）`);
        }
    }

    // 「不处理」+ 提示词却要求透明背景：模型直出的 PNG 一定是不透明的，先把话说在前面
    if (params.alphaMode === 'none' && /透明|去背|抠图|background\s*[:=]?\s*transparent|transparent background/i.test(String(params.prompt || ''))) {
        warnings.push(
            '提示词里要求了透明背景，但「处理方式 = 不处理」→ 输出一定是不透明的 PNG。要透明请把处理方式改成「色键抠图」（提示词里同时要求一个纯色背景，例如 #FF00FF）。'
        );
    }

    // 抠图模式下提示词写「透明背景」也是白写：模型只会画出一个"看起来透明"的底色（棋盘格/白底），
    // 接口除了保留已有 alpha 之外给不出 alpha 通道 —— 要透明就得走「纯色背景 + 本地抠」。
    if (
        params.alphaMode === 'chroma' &&
        /透明背景|背景.{0,4}透明|transparent background/i.test(String(params.prompt || '')) &&
        !/\{keyHex\}/.test(String(params.prompt || '')) &&
        !/#?[0-9A-Fa-f]{6}\b/.test(String(params.prompt || ''))
    ) {
        warnings.push(
            '提示词要求「背景透明」是拿不到透明的 —— 模型不会输出 alpha 通道（它只会画出看起来像透明的底色，抠图时会抠不干净）。请把这条改成「背景必须是纯色 #FF00FF」（或写 {keyHex} 占位符），透明背景交给本地抠图。'
        );
    }

    if (params.alphaMode !== 'none' && params.outputFormat === 'jpeg') {
        warnings.push('output_format=jpeg 会丢失 alpha 通道，抠图结果仍会存成 png');
    }
    // 尺寸档位为 adaptive 的编辑模型
    if (meta && meta.sizeTiers.includes('adaptive') && params.sizeMode === 'tier' && params.sizeTier !== 'adaptive') {
        warnings.push(`${meta.label} 只支持 adaptive 自适应尺寸，已回退`);
        params.sizeTier = 'adaptive';
        params.size = 'adaptive';
    }

    params.concurrency = Math.min(8, Math.max(1, Math.round(Number(params.concurrency) || 1)));
    params.retries = Math.min(6, Math.max(0, Math.round(Number(params.retries) || 0)));
    params.keyTolerance = Math.min(255, Math.max(0, Math.round(Number(params.keyTolerance) || 0)));
    params.outSize = Math.min(4096, Math.max(0, Math.round(Number(params.outSize) || 0)));
    params.inputMaxEdge = Math.min(2048, Math.max(0, Math.round(Number(params.inputMaxEdge) || 0)));
    params.trimMargin = Math.min(200, Math.max(0, Math.round(Number(params.trimMargin) || 0)));
    params.shrinkEdge = Math.min(4, Math.max(0, Math.round(Number(params.shrinkEdge) || 0)));
    params.localGrow = Math.min(255, Math.max(0, Math.round(Number(params.localGrow) || 0)));
    params.padSquarePad = Math.min(0.5, Math.max(0, Number(params.padSquarePad) || 0));
    params.jpegQuality = Math.min(100, Math.max(50, Math.round(Number(params.jpegQuality) || 95)));
    return { params, warnings, meta };
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.avif']);
