/**
 * 透明背景处理（本地抠图）
 *
 * 为什么需要本地抠图：方舟的 `background=transparent` 官方限制「仅图生图 + 只允许输入 1 张
 * 带透明通道的图」，而本工具的核心场景是「参考图（风格）+ 目标图（内容）」两张图，
 * 且 dota2 图标本身是不透明的（深色底烘进图里）。所以透明背景靠：
 *   ① 提示词要求模型把主体画在**纯色背景**（默认 #FF00FF）上；
 *   ② 本地做「连通域色键 + 梯度生长 + 边缘反混合去溢色 + 收边」，
 *      得到干净的 alpha 通道（含半透明边缘，不会出现品红描边或黑边）。
 *
 * 两条抠图路径（自动选）：
 *  - `key`    边框大部分就是要求的键色 → 以键色为基准泛洪；
 *  - `border` 边框不是键色（模型换了背景色、或画了渐变/暗角）→ 以**边框实际颜色**为基准，
 *             从边框整圈向内生长（只沿颜色连续处走，遇到主体边缘的突跳就停）。
 * 无论哪条路径，去溢色都对着「贴着主体那一圈背景的实际颜色」算，而不是对着配置里的键色，
 * 这样模型没照做也不会留下色边。
 */

import { clamp, parseColor, toHex } from './util.mjs';

/** 三通道最大差（0~255），比欧氏距离更直观，界面滑块就是它 */
function dist(p, q) {
    return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
}

function idx(x, y, w) {
    return (y * w + x) * 4;
}

/** 取像素颜色 */
function px(data, i) {
    const p = i * 4;
    return [data[p], data[p + 1], data[p + 2]];
}

/**
 * 自动探测背景色：采样四边框（外圈 2px），按 16 级量化投票取主色，再对同桶像素求均值。
 * 四角权重 3 倍（角落几乎必然是背景）。
 */
export function detectKeyColor(data, width, height) {
    const buckets = new Map();
    const add = (x, y, weight) => {
        const p = idx(x, y, width);
        const c = [data[p], data[p + 1], data[p + 2]];
        const key = `${c[0] >> 4}_${c[1] >> 4}_${c[2] >> 4}`;
        let b = buckets.get(key);
        if (!b) {
            b = { n: 0, sum: [0, 0, 0] };
            buckets.set(key, b);
        }
        b.n += weight;
        b.sum[0] += c[0] * weight;
        b.sum[1] += c[1] * weight;
        b.sum[2] += c[2] * weight;
    };
    const ring = Math.max(1, Math.min(2, Math.floor(Math.min(width, height) / 4)));
    for (let x = 0; x < width; x++) {
        for (let r = 0; r < ring; r++) {
            add(x, r, 1);
            add(x, height - 1 - r, 1);
        }
    }
    for (let y = 0; y < height; y++) {
        for (let r = 0; r < ring; r++) {
            add(r, y, 1);
            add(width - 1 - r, y, 1);
        }
    }
    for (const [cx, cy] of [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1],
    ]) {
        add(cx, cy, 3);
    }
    let best = null;
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
    if (!best) return [255, 0, 255];
    return [0, 1, 2].map((i) => Math.round(clamp(best.sum[i] / best.n, 0, 255)));
}

/** 收集外圈 ring 像素的下标 */
function borderIndices(width, height, ring = 2) {
    const out = [];
    for (let x = 0; x < width; x++) {
        for (let r = 0; r < ring; r++) {
            out.push(r * width + x, (height - 1 - r) * width + x);
        }
    }
    for (let y = 0; y < height; y++) {
        for (let r = 0; r < ring; r++) {
            out.push(y * width + r, y * width + (width - 1 - r));
        }
    }
    return out;
}

/**
 * 抠图主函数（原地修改 data 的 alpha 与边缘颜色）
 * @param {{data:Buffer,width:number,height:number}} img  RGBA raw
 * @returns {{stats:object}}
 */
export function chromaKey(img, o = {}) {
    const { data, width, height } = img;
    const tol = clamp(Number(o.tolerance ?? 68), 0, 255);
    const localGrow = clamp(Number(o.localGrow ?? 14), 0, 255);
    const maxDriftCfg = clamp(Number(o.maxDrift ?? Math.round(tol * 3.2)), 0, 255);
    const despill = o.despill !== false;
    const spillStrength = clamp(Number(o.spillStrength ?? 0.75), 0, 1.5);
    const rampAuto = o.rampAuto !== false;
    const shrinkEdge = clamp(Number(o.shrinkEdge ?? 1), 0, 4);
    const maxTransparent = clamp(Number(o.maxTransparent ?? 0.96), 0.3, 1);
    const minTransparent = clamp(Number(o.minTransparent ?? 0.01), 0, 0.5);
    const n = width * height;

    const autoKey = o.autoKey !== false;
    const detected = autoKey ? detectKeyColor(data, width, height) : null;
    const K = detected || parseColor(o.keyColor) || [255, 0, 255];

    // ---- 判定走哪条路径：边框上有多大比例是「要抠的键色」 ----
    const border = borderIndices(width, height, Math.max(1, Math.min(2, Math.floor(Math.min(width, height) / 4))));
    const keyLike = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (dist(px(data, i), K) <= tol) keyLike[i] = 1;
    }
    let borderKeyHits = 0;
    for (const i of border) if (keyLike[i]) borderKeyHits++;
    const borderKeyFraction = border.length ? borderKeyHits / border.length : 0;
    // chroma：边框被某一种颜色占据（含「自动探测到的实际底色」）→ 以该色为基准
    // frame ：边框颜色很杂（主体顶到边、或背景本身花）→ 只按「颜色连续性」从整圈边框向内吃
    const mode = borderKeyFraction >= 0.35 ? 'chroma' : 'frame';

    // 边框实测底色
    const B = (() => {
        let s = [0, 0, 0];
        let c = 0;
        for (const i of border) {
            if (mode === 'chroma' && !keyLike[i]) continue;
            const p = px(data, i);
            s[0] += p[0];
            s[1] += p[1];
            s[2] += p[2];
            c++;
        }
        if (!c) return K;
        return s.map((v) => Math.round(v / c));
    })();

    const base = mode === 'chroma' ? K : B;
    const maxDrift = mode === 'chroma' ? maxDriftCfg : Math.min(maxDriftCfg, Math.max(tol * 2, 96));

    // ---- 统一泛洪：从边框种子出发，既要求「接近底色」，也要求「与相邻已判定像素颜色连续」 ----
    // 只靠全局颜色匹配会把「颜色恰好接近背景的主体部分」一起吃掉；加上连续性约束后，
    // 主体边缘的颜色突跳会天然挡住泛洪 —— 失败方向从「吃掉主体」变成「少抠一点」，后者可调可控。
    const isBg = new Uint8Array(n);
    const queue = [];
    let seeded = 0;
    for (const i of border) {
        const ok = mode === 'chroma' ? keyLike[i] === 1 : dist(px(data, i), base) <= maxDrift;
        if (!isBg[i] && ok) {
            isBg[i] = 1;
            queue.push(i);
            seeded++;
        }
    }
    let head = 0;
    while (head < queue.length) {
        const i = queue[head++];
        const x = i % width;
        const y = (i - x) / width;
        const c = px(data, i);
        const neigh = [];
        if (x > 0) neigh.push(i - 1);
        if (x < width - 1) neigh.push(i + 1);
        if (y > 0) neigh.push(i - width);
        if (y < height - 1) neigh.push(i + width);
        for (const j of neigh) {
            if (isBg[j]) continue;
            const cj = px(data, j);
            if (dist(cj, c) > localGrow) continue;
            if (dist(cj, base) > maxDrift) continue;
            if (mode === 'chroma' && !keyLike[j]) continue;
            isBg[j] = 1;
            queue.push(j);
        }
    }
    const bgCount = queue.length;

    // ---- 贴着主体那一圈背景的实测颜色（去溢色的真正基准）----
    const Kedge = (() => {
        let s = [0, 0, 0];
        let c = 0;
        const band = 3;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (!isBg[i]) continue;
                let touches = false;
                for (let dy = -band; dy <= band && !touches; dy++) {
                    for (let dx = -band; dx <= band; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (!isBg[ny * width + nx]) {
                            touches = true;
                            break;
                        }
                    }
                }
                if (!touches) continue;
                const p = px(data, i);
                s[0] += p[0];
                s[1] += p[1];
                s[2] += p[2];
                c++;
            }
        }
        if (c < 8) return base;
        return s.map((v) => Math.round(v / c));
    })();

    // ---- 量一下「过渡带」有多宽，用来定 alpha 渐变的上界 ----
    // 为什么不能把它写死成容差的 1.6 倍：实测真实模型输出的背景**平坦区**很干净
    // （边框到键色的距离 p99≈18、σ≈4），但主体边缘有一圈「背景与主体混色」的过渡带，
    // 最远能到 150 左右。渐变上界若只到 ~109，过渡带外圈会以 alpha=255 留下来，
    // 表现就是一圈约 0.7px 的键色描边（实测：容差68 → 0.745px，上界放到 150 → 0.202px）。
    let rampHi = Math.max(tol * 1.6, tol + 24);
    let rampP98 = null;
    if (rampAuto && bgCount > 64) {
        const hist = new Uint32Array(256);
        for (const i of queue) hist[Math.min(255, dist(px(data, i), Kedge))]++;
        const target = bgCount * 0.98;
        let acc = 0;
        for (let d = 0; d < 256; d++) {
            acc += hist[d];
            if (acc >= target) {
                rampP98 = d;
                break;
            }
        }
        if (rampP98 != null) rampHi = clamp(rampP98, tol + 30, 200);
    }

    // ---- 写 alpha：背景 0；与背景相邻的一圈按「离底色多远」给半透明；其余 255 ----
    const alphaOut = new Float32Array(n);
    for (let i = 0; i < n; i++) alphaOut[i] = isBg[i] ? 0 : 255;
    const band = 2;
    const edgeFlag = new Uint8Array(n);
    let edgeCount = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (isBg[i]) continue;
            let touches = false;
            for (let dy = -band; dy <= band && !touches; dy++) {
                for (let dx = -band; dx <= band; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (isBg[ny * width + nx]) {
                        touches = true;
                        break;
                    }
                }
            }
            if (!touches) continue;
            edgeFlag[i] = 1;
            edgeCount++;
            const d = dist(px(data, i), Kedge);
            // 离底色越近 → 越透明：tol 以下全透明，rampHi 以上全不透明，中间线性过渡
            alphaOut[i] = 255 * clamp((d - tol) / Math.max(1, rampHi - tol), 0, 1);
        }
    }

    // ---- 安全阀：抠得太狠 / 几乎没抠掉 → 整张回退成不透明，宁可不抠也不毁图 ----
    let transparentPreview = 0;
    for (let i = 0; i < n; i++) if (alphaOut[i] === 0) transparentPreview++;
    const ratioPreview = transparentPreview / n;
    if (ratioPreview > maxTransparent || ratioPreview < minTransparent) {
        const tooMuch = ratioPreview > maxTransparent;
        return {
            stats: {
                reverted: true,
                keyColor: toHex(base),
                keyRequested: toHex(K),
                keyDetected: detected ? toHex(detected) : null,
                keyEdge: toHex(Kedge),
                mode,
                borderKeyFraction,
                transparentRatio: 0,
                wouldBeTransparentRatio: ratioPreview,
                partialRatio: 0,
                seededPixels: seeded,
                floodPixels: bgCount,
                edgePixels: edgeCount,
                edgePixelsFixed: 0,
                width,
                height,
                bbox: null,
                warnings: [
                    tooMuch
                        ? `抠图会去掉 ${(ratioPreview * 100).toFixed(1)}% 的画面（超过安全线 ${(maxTransparent * 100).toFixed(0)}%），判定为「连主体一起吃了」，已回退为不透明输出 —— 请调小容差、换一个主体上不出现的键色，或关闭「自动探测背景色」`
                        : `只判定出 ${(ratioPreview * 100).toFixed(2)}% 背景（低于 ${(minTransparent * 100).toFixed(0)}%），判定为「没抠到」，已保留不透明输出 —— 请调大容差或换键色`,
                ],
            },
        };
    }

    // ---- 收边：对 alpha 做 n 次腐蚀，压掉 1~2px 的残留杂边 ----
    if (shrinkEdge > 0) {
        for (let it = 0; it < shrinkEdge; it++) {
            const copy = Float32Array.from(alphaOut);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    if (copy[i] === 0) continue;
                    let m = copy[i];
                    if (x > 0) m = Math.min(m, copy[i - 1]);
                    if (x < width - 1) m = Math.min(m, copy[i + 1]);
                    if (y > 0) m = Math.min(m, copy[i - width]);
                    if (y < height - 1) m = Math.min(m, copy[i + width]);
                    alphaOut[i] = m;
                }
            }
        }
    }

    // ---- 回写 alpha，并对边缘做反混合去溢色（基准 = 贴边底色 Kedge）----
    let edgeFixed = 0;
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const a = alphaOut[i];
        if (a <= 0) {
            data[p + 3] = 0;
            continue;
        }
        if (despill && edgeFlag[i] && a < 255) {
            const af = a / 255;
            if (af > 0.18) {
                for (let c = 0; c < 3; c++) {
                    data[p + c] = clamp(Math.round((data[p + c] - (1 - af) * Kedge[c]) / af), 0, 255);
                }
                edgeFixed++;
            }
            data[p + 3] = Math.round(a);
            continue;
        }
        data[p + 3] = Math.round(a);
    }

    // ---- 贴边溢色抑制（key spill suppression）----
    // 上半段只对「半透明边缘」做了反混合；实测真实模型输出在边缘还会留约 0.6px 的
    // 键色染色（主体边缘被模型画成与背景相近的过渡色，但 alpha 仍是 255），
    // 这里对「紧贴背景的、颜色偏向键色的不透明像素」做投影去溢色：
    //   把像素沿「键色相对中性灰的方向」的分量按比例压掉 —— 对品红/绿/蓝键都通用，
    //   且不会改变轮廓（只改颜色，不动 alpha）。
    let spillFixed = 0;
    if (despill) {
        const kGray = (Kedge[0] + Kedge[1] + Kedge[2]) / 3;
        const dir = Kedge.map((v) => v - kGray);
        const dirLen2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
        if (dirLen2 > 1) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    if (alphaOut[i] !== 255) continue; // 半透明的那些上面已经反混合过了
                    // 必须紧贴背景（1px），否则会误伤主体内部的同色细节
                    let near = false;
                    for (let dy = -1; dy <= 1 && !near; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const nx = x + dx;
                            const ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                            if (isBg[ny * width + nx]) {
                                near = true;
                                break;
                            }
                        }
                    }
                    if (!near) continue;
                    const p = i * 4;
                    const c = [data[p], data[p + 1], data[p + 2]];
                    const g = (c[0] + c[1] + c[2]) / 3;
                    // 沿「键色相对中性灰的方向」的分量：1.0 = 就是这个键色，0 = 无关
                    const proj = ((c[0] - g) * dir[0] + (c[1] - g) * dir[1] + (c[2] - g) * dir[2]) / dirLen2;
                    if (proj < 0.12) continue; // 键色味不足，不动它
                    const cut = proj * spillStrength;
                    for (let ch = 0; ch < 3; ch++) data[p + ch] = clamp(Math.round(data[p + ch] - cut * dir[ch]), 0, 255);
                    spillFixed++;
                }
            }
        }
    }

    // ---- QC ----
    let transparent = 0;
    let partial = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const a = data[(y * width + x) * 4 + 3];
            if (a === 0) transparent++;
            else if (a < 255) partial++;
            if (a > 8) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    const transparentRatio = transparent / n;
    // 贴边杂边：紧贴透明区、颜色仍偏向底色的不透明像素 —— 就是肉眼看到的「一圈键色描边」
    let edgeFringe = 0;
    if (edgeCount > 0) {
        const nearK = tol * 2.2;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (!edgeFlag[i] || data[i * 4 + 3] !== 255) continue;
                if (dist(px(data, i), Kedge) <= nearK) edgeFringe++;
            }
        }
    }
    const fringePerEdge = edgeFringe / Math.max(1, edgeCount);
    const warnings = [];
    if (transparentRatio > 0.9) warnings.push('透明区域 >90%，主体边缘可能被啃掉 —— 调小容差/局部连续，或换一个主体上不出现的键色');
    if (transparentRatio < 0.05) warnings.push('透明区域 <5%，几乎没有抠掉背景 —— 调大容差；若模型没给纯色背景，请勾选「自动探测背景色」');
    if (fringePerEdge > 0.5)
        warnings.push(
            `边缘还有约 ${fringePerEdge.toFixed(2)}px 的底色杂边（贴边像素 ${edgeFringe}/${edgeCount}）—— 把「容差」调大 15~25，或用「只重跑抠图」重新抠一遍（不花钱）`
        );
    if (mode === 'frame') warnings.push(`边框颜色很杂（键色命中率 ${(borderKeyFraction * 100).toFixed(0)}%），已按「边框底色 + 颜色连续性」抠图（实测底色 ${toHex(B)}）`);
    // 暗色/低饱和底色做色键先天不可靠：主体往往也是暗色，容易连主体一起吃
    const mx = Math.max(...base);
    const mn = Math.min(...base);
    if (mx < 110 || mx - mn < 32) {
        warnings.push(`背景底色偏暗/偏灰（${toHex(base)}），色键对这类底色不可靠 —— 建议在提示词里坚持用纯品红 ${toHex(parseColor(o.keyColor) || [255, 0, 255])} 背景，或手动指定一个主体上不出现的键色并关闭「自动探测」`);
    }
    if (seeded < 4) warnings.push('边框上几乎没有可用的背景种子像素，抠图结果可能不完整');

    return {
        stats: {
            reverted: false,
            keyColor: toHex(base),
            keyRequested: toHex(K),
            keyDetected: detected ? toHex(detected) : null,
            keyEdge: toHex(Kedge),
            mode,
            borderKeyFraction,
            transparentRatio,
            partialRatio: partial / n,
            seededPixels: seeded,
            floodPixels: bgCount,
            edgePixels: edgeCount,
            edgePixelsFixed: edgeFixed,
            spillPixelsFixed: spillFixed,
            edgeFringe,
            fringePerEdge,
            rampHi,
            rampP98,
            width,
            height,
            bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
            warnings,
        },
    };
}

/**
 * 裁掉四周全透明的边（trim），可选四周留 margin。
 */
export function trimTransparent(img, margin = 0) {
    const { data, width, height } = img;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return { ...img, trimmed: false };
    minX = Math.max(0, minX - margin);
    minY = Math.max(0, minY - margin);
    maxX = Math.min(width - 1, maxX + margin);
    maxY = Math.min(height - 1, maxY + margin);
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return { ...img, trimmed: false };
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const src = ((y + minY) * width + minX) * 4;
        data.copy(out, y * w * 4, src, src + w * 4);
    }
    return { data: out, width: w, height: h, trimmed: true };
}

/** 把主体等比缩放到方形画布中央（透明补边），四周留 padRatio 比例的空隙 */
export function padToSquare(img, { padRatio = 0.08 } = {}) {
    const { data, width, height } = img;
    const side = Math.round(Math.max(width, height) * (1 + padRatio * 2));
    const out = Buffer.alloc(side * side * 4);
    const ox = Math.round((side - width) / 2);
    const oy = Math.round((side - height) / 2);
    for (let y = 0; y < height; y++) {
        const dst = ((y + oy) * side + ox) * 4;
        data.copy(out, dst, y * width * 4, (y + 1) * width * 4);
    }
    return { data: out, width: side, height: side };
}

/**
 * 用「源图 alpha」当遮罩（source 模式）：把 mask 缩放到目标尺寸并与生成图的 alpha 相乘。
 * 适合「源图本身就是抠好的透明 PNG」的场景。
 */
export function multiplyAlpha(img, mask, maskW, maskH) {
    const { data, width, height } = img;
    for (let y = 0; y < height; y++) {
        const my = Math.min(maskH - 1, Math.floor((y * maskH) / height));
        for (let x = 0; x < width; x++) {
            const mx = Math.min(maskW - 1, Math.floor((x * maskW) / width));
            const a = mask[(my * maskW + mx) * 4 + 3];
            const p = (y * width + x) * 4;
            data[p + 3] = Math.round((data[p + 3] * a) / 255);
        }
    }
    return img;
}
