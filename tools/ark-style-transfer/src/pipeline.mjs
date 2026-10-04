/**
 * 单张图片的处理流水线：组装提示词 → 调方舟 → 透明背景后处理 → 落盘 + QC
 *
 * 批量和单图调试台走的是**同一条**流水线，保证「单图调好的参数」批量时行为一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateImage } from './ark.mjs';
import { normalizeInput, readRaw, writePng, writeJpeg, saveRaw, writeThumb, probeImage, alphaStats } from './images.mjs';
import { chromaKey, trimTransparent, padToSquare, multiplyAlpha } from './alpha.mjs';
import { toHex, parseColor, safeName } from './util.mjs';

/**
 * 组装最终提示词
 * - `{keyHex}` 占位符会被替换成键色
 * - 双图时自动声明「图1 = 风格参考 / 图2 = 内容目标」（方舟官方提示词指南建议显式说明每张图的角色）
 * - 抠图模式且开启 appendKeyInstruction 时，自动追加纯色背景要求
 */
export function composePrompt(params, imageCount = 1) {
    const keyHex = toHex(parseColor(params.keyColor) || [255, 0, 255]);
    let p = String(params.prompt ?? '');
    const parts = [];

    if (params.labelImages && imageCount >= 2) {
        parts.push('图1 = 风格参考图（只参考画风、材质、配色、光影）；图2 = 内容目标图（只参考造型与结构）。');
    } else if (params.labelImages && imageCount === 1) {
        parts.push('图1 = 内容目标图。');
    }
    parts.push(p.replaceAll('{keyHex}', keyHex));

    // 实测结论（见 README §4.3）：模型对**文字**的服从度远高于对参考图像素的服从度 ——
    // 换参考图能让输出动的幅度很小（~17/255），而把风格写成文字能明显改变它。
    // 所以单开一个「风格描述」字段，双图迁移时它是比参考图更有效的杠杆。
    const styleDesc = String(params.styleDesc ?? '').trim();
    if (styleDesc) parts.push(`画风要求（最高优先级，必须照做，不要用你自己的默认画风）：${styleDesc}`);

    if (params.alphaMode === 'chroma' && params.appendKeyInstruction && !p.includes('{keyHex}')) {
        parts.push(
            `背景要求：整张背景必须是纯色 ${keyHex}（无渐变、无纹理、无噪点、无阴影、无边框）；道具本身不要使用 ${keyHex} 这个颜色，也不要有同色描边或反光。`
        );
    }
    return parts.filter(Boolean).join('\n\n').trim();
}

function extOfFormat(format) {
    return format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png';
}

/**
 * 把「实际送进接口的输入图」记进质检信息 —— "换了参考图出图却一样"这类问题，
 * 第一步永远是先看清送进去的到底是什么尺寸、有没有被缩放糊掉。
 */
function describeInput(label, norm, name) {
    const out = [];
    if (norm?.upscaled) {
        out.push(`${label}（${name}）只有 ${norm.width}×${norm.height}，被**放大**后送进接口 —— 放大不会增加细节，风格信息会被抹平`);
    } else if (norm?.scaled) {
        out.push(`${label}（${name}）从 ${norm.width}×${norm.height} 压到上限内再送接口`);
    }
    return out;
}

/** 给结果带上「发了哪几张图、各自什么尺寸」—— 用户一眼就能确认参考图有没有真的发出去 */
function inputRecord(role, norm, name) {
    return {
        role,
        name,
        sourceWidth: norm?.width || 0,
        sourceHeight: norm?.height || 0,
        sentWidth: norm?.sentWidth || 0,
        sentHeight: norm?.sentHeight || 0,
        bytes: norm?.buffer?.length || 0,
        upscaled: !!norm?.upscaled,
        scaled: !!norm?.scaled,
    };
}

/** 从 {path} 或 {dataUrl} 描述里取到 buffer */
async function loadSource(src, label) {
    if (!src) throw new Error(`缺少${label}`);
    if (src.dataUrl) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(src.dataUrl);
        if (!m) throw new Error(`${label} 不是合法的 data URL`);
        return { buffer: Buffer.from(m[2], 'base64'), name: src.name || `${label}.png` };
    }
    if (src.path) {
        const p = src.path;
        if (!fs.existsSync(p)) throw new Error(`${label} 不存在：${p}`);
        return { buffer: fs.readFileSync(p), name: path.basename(p) };
    }
    throw new Error(`${label} 参数不合法（需要 path 或 dataUrl）`);
}

/**
 * 处理单张
 * @param {object} o
 * @param {object} o.params      已经过 normalizeParams 的参数
 * @param {object} o.apiKey
 * @param {string} o.baseUrl
 * @param {object} [o.ref]       {path|dataUrl, name}
 * @param {object} o.target      {path|dataUrl, name}
 * @param {string} o.outDir      输出目录
 * @param {string} [o.outName]   输出文件名（不含扩展名）
 * @param {string} [o.mode]      generate | realpha（只重跑抠图，用已有 _raw）
 * @param {function} [o.onStep]
 * @param {AbortSignal} [o.signal]
 */
export async function processOne(o) {
    const t0 = Date.now();
    const { params, apiKey, baseUrl, outDir, mode = 'generate', onStep = () => {}, signal } = o;
    const warnings = [];
    const inputs = []; // 实际发出去的输入图记录（质检面板会显示，用来回答"参考图到底发了没"）
    // 以前这里是 `&& params.alphaMode !== 'api'` —— 「接口直出透明」模式下**静默丢掉参考图**，
    // 于是用户勾着参考图却做成了单图重绘（批量时是白花一整批的钱）。现在改成当场拒绝。
    const wantsRef = !!params.useRef && !!o.ref;
    if (mode !== 'realpha' && params.alphaMode === 'api' && wantsRef) {
        throw new Error(
            '「接口直出透明」不能用参考图：方舟要求**恰好 1 张输入图**，两张会直接报 400（原文：transparent background requires exactly one input image）。\n' +
                '要做「参考图风格迁移 + 透明背景」，请把处理方式改成「色键抠图」（提示词里要求一个纯色背景，例如 #FF00FF，本地抠干净）；\n' +
                '要坚持单图接口透明，就关掉「使用参考图」。'
        );
    }
    const useRef = mode === 'realpha' ? false : wantsRef;

    const targetSrc = await loadSource(o.target, '目标图');
    const outName = safeName(o.outName || path.basename(targetSrc.name, path.extname(targetSrc.name)));
    const rawDir = path.join(outDir, '_raw');
    const thumbDir = path.join(outDir, '_thumb');
    const rawExt = extOfFormat(params.outputFormat);

    let generatedBuffer = null;
    let gen = null;

    if (mode === 'realpha') {
        // 只重跑抠图：用上次模型直出的图，避免再花一次钱
        const cand = [path.join(rawDir, `${outName}.png`), path.join(rawDir, `${outName}.jpg`)];
        const hit = cand.find((p) => fs.existsSync(p));
        if (!hit) throw new Error(`没找到直出图（${cand.map((c) => path.basename(c)).join(' / ')}），无法只重跑抠图`);
        generatedBuffer = fs.readFileSync(hit);
        onStep({ phase: 'realpha', from: hit });
    } else {
        const label = useRef ? 2 : 1;
        const prompt = composePrompt(params, label);
        onStep({ phase: 'prepare' });
        const targetNorm = await normalizeInput(targetSrc.buffer, { inputMaxEdge: params.inputMaxEdge ?? 512, allowUpscale: !!params.inputUpscale });
        const images = [];
        if (useRef) {
            const refSrc = await loadSource(o.ref, '参考图');
            const refNorm = await normalizeInput(refSrc.buffer, { inputMaxEdge: params.inputMaxEdge ?? 512, allowUpscale: !!params.inputUpscale });
            images.push(`data:image/png;base64,${refNorm.buffer.toString('base64')}`);
            warnings.push(...describeInput('参考图', refNorm, refSrc.name));
            inputs.push(inputRecord('参考图（图1 = 风格）', refNorm, refSrc.name));
        }
        images.push(`data:image/png;base64,${targetNorm.buffer.toString('base64')}`);
        warnings.push(...describeInput('目标图', targetNorm, targetSrc.name));
        inputs.push(inputRecord(useRef ? '目标图（图2 = 内容）' : '目标图（图1）', targetNorm, targetSrc.name));

        // 「接口直出透明」的第二条硬限制：输入图**本身必须已经有透明像素**（它是保留 alpha，不是去背景）。
        // 这一条免费就能判 —— 与其让接口报 400，不如在下单前拦住（批量时能省下一整批的失败请求）。
        if (params.alphaMode === 'api' && !useRef) {
            const inAlpha = await alphaStats(targetNorm.buffer);
            if (inAlpha.transparentRatio <= 0) {
                throw new Error(
                    '「接口直出透明」只保留输入图**已有**的透明像素，它不会去背景 —— 当前目标图一个透明像素都没有，这次调用必然被接口拒（原文：transparent background requires a PNG input with at least one transparent pixel）。\n' +
                        '要"把不透明图标变成透明背景"，请把处理方式改成「色键抠图」。'
                );
            }
        }

        gen = await generateImage(
            {
                apiKey,
                baseUrl,
                model: params.resolvedModel,
                prompt,
                images,
                size: params.size,
                outputFormat: params.outputFormat,
                background: params.alphaMode === 'api' ? 'transparent' : 'opaque',
                watermark: !!params.watermark,
                responseFormat: 'b64_json',
                optimizePrompt: params.optimizePrompt,
                sequential: params.sequential,
                timeoutMs: params.timeoutMs,
                retries: params.retries,
            },
            { onStep, signal }
        );
        if (gen.images.length > 1) warnings.push(`模型一次返回了 ${gen.images.length} 张图，本工具取第 1 张`);
        generatedBuffer = gen.images[0];
        fs.mkdirSync(rawDir, { recursive: true });
        await saveRaw(generatedBuffer, path.join(rawDir, `${outName}.${rawExt}`), { format: params.outputFormat });
    }

    onStep({ phase: 'alpha' });
    const probe = await probeImage(generatedBuffer);
    let img = await readRaw(generatedBuffer);
    const alphaReport = { mode: params.alphaMode, keyColor: null, warnings: [] };

    if (params.alphaMode === 'chroma') {
        const { stats } = chromaKey(img, {
            autoKey: params.keyAuto,
            keyColor: params.keyColor,
            tolerance: params.keyTolerance,
            localGrow: params.localGrow ?? 14,
            despill: params.despill,
            spillStrength: params.spillStrength ?? 0.75,
            shrinkEdge: params.shrinkEdge,
        });
        alphaReport.keyColor = stats.keyColor;
        alphaReport.keyDetected = stats.keyDetected;
        alphaReport.stats = stats;
        warnings.push(...stats.warnings);
    } else if (params.alphaMode === 'source') {
        const mask = await readRaw(targetSrc.buffer);
        multiplyAlpha(img, mask.data, mask.width, mask.height);
        alphaReport.keyColor = null;
        alphaReport.note = '沿用目标图 alpha 通道';
    } else if (params.alphaMode === 'api') {
        alphaReport.note = '透明背景由接口直出（background=transparent）';
    }

    if (params.alphaMode !== 'none') {
        if (params.trim) {
            const before = { w: img.width, h: img.height };
            img = trimTransparent(img, params.trimMargin);
            if (params.padSquare) img = padToSquare(img, { padRatio: params.padSquarePad ?? 0.08 });
            alphaReport.geometry = { from: before, to: { w: img.width, h: img.height } };
        } else if (params.padSquare) {
            warnings.push('未开启「裁掉透明边」，补方形对整幅方图无效果');
        }
    }

    const finalExt = params.alphaMode === 'none' && params.outputFormat === 'jpeg' ? 'jpg' : 'png';
    const outPath = path.join(outDir, `${outName}.${finalExt}`);
    let written;
    if (finalExt === 'png') {
        written = await writePng(img.data, img.width, img.height, outPath, { outSize: params.outSize });
    } else {
        written = await writeJpeg(img.data, img.width, img.height, outPath, {
            outSize: params.outSize,
            quality: params.jpegQuality ?? 95,
            // jpeg 没有 alpha，透明区域压到黑底上（要透明就不要选 jpeg 输出）
            background: '#000000',
        });
    }
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbPath = path.join(thumbDir, `${outName}.png`);
    await writeThumb(outPath, thumbPath, 200);

    // 成品自检：量**写盘后的那张图**（不依赖任何中间态），透明处理没生效时当场告警 ——
    // 「选错了处理方式 → 拿到不透明图却没人说」是这次踩的坑，这里补上唯一一处与实际产物对齐的断言。
    const finalAlpha = await alphaStats(outPath);
    alphaReport.output = {
        transparentRatio: +finalAlpha.transparentRatio.toFixed(4),
        partialRatio: +finalAlpha.partialRatio.toFixed(4),
        bbox: finalAlpha.bbox,
    };
    alphaReport.alphaOk = params.alphaMode === 'none' || finalAlpha.transparentRatio >= 0.005;
    if (!alphaReport.alphaOk) {
        warnings.push(
            `成品几乎没有透明像素（透明占比 ${(finalAlpha.transparentRatio * 100).toFixed(2)}%）—— 透明处理没生效：检查「处理方式」是不是被设成了「不处理」，或抠图容差/键色不对`
        );
    }

    onStep({ phase: 'done', outPath });
    return {
        ok: true,
        name: outName,
        outputPath: outPath,
        thumbPath,
        rawPath: path.join(rawDir, `${outName}.${rawExt}`),
        width: written.width,
        height: written.height,
        bytes: written.size,
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        apiFormat: gen?.format || params.outputFormat,
        apiSize: gen?.size || '',
        attempts: gen?.attempts || 0,
        requestId: gen?.requestId || '',
        usage: gen?.usage || null,
        requestBody: gen?.requestBody || null,
        prompt: mode === 'realpha' ? '' : composePrompt(params, useRef ? 2 : 1),
        inputs,
        alpha: alphaReport,
        warnings,
        ms: Date.now() - t0,
        apiMs: gen?.ms ?? null,
    };
}
