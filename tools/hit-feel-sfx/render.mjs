/**
 * 打击反馈音效 · 离线渲染器（纯 Node，**零依赖**）
 *
 * 为什么不用 Web Audio：Node 里没有 `AudioContext` / `OfflineAudioContext`，
 * 而验收要求「两次渲染字节一致」—— 浏览器的离线渲染在浮点实现上不跨版本稳定，
 * 也不方便在 CI / 无头环境里跑。所以这里把演示台 §3 的两个基元（`noiseHit` / `toneHit`）
 * **按同样的数学实现**一遍：
 *     · 噪声 = 白噪声 → 二阶带通（Web Audio bandpass：恒定峰值增益型，α = sin(ω0)/(2Q)）→ 增益包络
 *     · 扫频 = 振荡器按**指数插值** f0→f1 → 同一增益包络；方波/三角用**带限谐波叠加**
 *       （Web Audio 的 OscillatorNode 本身是带限的，22050Hz 下naive 方波会糊出可听的混叠）
 *     · 包络 = 4ms 线性起振 → 指数衰减到 1e-4 → 最后 1.5ms 线性收敛到精确 0
 *
 * 用法（在 tools/hit-feel-sfx/ 下）：
 *     node render.mjs            渲染全部 16 个 wav 到 assets/resources/sfx/；写 manifest.json
 *                                与 tier-table.json（后者是从真源码 HitFeelConfig.ts 解析出来的快照）
 *     node render.mjs --check    全部在内存里重渲，与磁盘逐字节比对；有漂移退出码 1，**绝不写盘**
 *
 * 三类产物、三种"漂移"分别对账：wav 的字节 / manifest 的内容 / tier-table 的**真源解析结果**
 * （有人在 HitFeelConfig.ts 里改了音量或变体数却没重跑渲染器 → `--check` 必须报出来）。
 *
 * 确定性：每条音一个 PRNG（mulberry32，种子 = 键名的 FNV-1a 哈希），噪声全部从该 PRNG 取，
 * 代码里没有 `Math.random()`、没有时间戳 —— 同一份源码两次渲染必然字节一致。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RENDER_SETTINGS, SFX_ORDER, SFX_TABLE, describeLayer } from './design.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..', '..');
/** 落位：`assets/resources/sfx/`，键名不带 `sfx/` 前缀（`playSFX` 自己补，见 §12.7） */
const OUT_DIR = join(PROJECT_ROOT, 'assets', 'resources', 'sfx');
const MANIFEST_PATH = join(HERE, 'manifest.json');
/** 真源：打击反馈的**唯一数值真源**（本渲染器只解析它，绝不修改它） */
const HIT_FEEL_CONFIG_REL = 'assets/scripts/game/common/HitFeelConfig.ts';
const TIER_TABLE_PATH = join(HERE, 'tier-table.json');

const S = RENDER_SETTINGS;
const SR = S.sampleRate;
/** 16bit 定点：乘以 32768 再四舍五入（峰值 0.8 → 26214，离满刻度 32767 还很远） */
const INT_SCALE = 32768;

/* ==========================================================================================
   1. 确定性随机
   ========================================================================================== */

/**
 * FNV-1a 32 位哈希：把键名映射成一个种子。
 * 为什么不用固定种子：`hit_light` 与 `hit_light_v2` 必须是**不同的噪声**（听感上才像"随机音高"），
 * 而键名是天然的、稳定的区分量 —— 不需要在表里手写第二个种子。
 */
export function seedOf(key) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** mulberry32：32 位状态的小 PRNG，够白、够快、跨平台确定（不用 Math.random 是硬要求） */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ==========================================================================================
   2. DSP：与 Web Audio 对齐的两个基元
   ========================================================================================== */

/**
 * 二阶带通（Web Audio `BiquadFilterNode` type='bandpass' 的等价实现）。
 * 系数按 Web Audio 规范的「恒定峰值增益」形式：α = sin(ω0)/(2Q)，b0=α, b2=−α, a0=1+α,
 * a1=−2cos(ω0), a2=1−α，再统一除以 a0；用 direct form 1 差分方程、内部状态走 double。
 * 注意：bandpass 的 Q 是**传统 Q**（低通/高通的 Q 才是 dB）—— 演示台的 Q 值直接照搬即可。
 */
export function biquadBandpass(input, freq, q, sampleRate = SR) {
    const out = new Float64Array(input.length);
    const nyquist = sampleRate / 2;
    if (!(freq > 0) || freq >= nyquist || !(q > 0)) {
        return out; // 越界频率直接出静音，而不是抛错：配方手滑时听得出"这层没了"比崩掉可控
    }
    const w0 = (Math.PI * freq) / nyquist;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const b1 = 0;
    const b2 = -alpha / a0;
    const a1 = (-2 * Math.cos(w0)) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y;
    }
    return out;
}

/**
 * 扫频振荡器的源信号（不含包络）。
 * 带限谐波叠加而不是 naive 方波：22050Hz 下 150Hz 方波的 74 次以上谐波会折叠回可听频段，
 * 听感是"脏"；而 Web Audio 的振荡器本来就是带限的，所以叠加法**更接近**演示台的原声。
 * 谐波数按 max(f0,f1) 取，保证整段扫频过程都不越过 Nyquist；方波归一化 4/π、三角 8/π²（峰值 ≈1）。
 */
function renderToneSource(layer, sampleCount) {
    const out = new Float64Array(sampleCount);
    const isSine = layer.type === 'sine';
    const fMax = Math.max(layer.f0, layer.f1);
    const nMax = isSine ? 1 : Math.max(1, Math.floor(SR / 2 / fMax));
    const orders = [];
    const coefs = [];
    for (let n = 1; n <= nMax; n += 2) {
        orders.push(n);
        if (isSine) {
            coefs.push(1);
        } else if (layer.type === 'square') {
            coefs.push(4 / Math.PI / n);
        } else {
            // 三角波：奇次谐波，符号交替，1/n²
            coefs.push((8 / (Math.PI * Math.PI)) * (((n - 1) / 2) % 2 === 0 ? 1 : -1) / (n * n));
        }
    }
    const ratio = layer.f1 / layer.f0;
    let phase = 0;
    for (let i = 0; i < sampleCount; i++) {
        // 采样点取区间中点，与 a-rate 参数逐样本积分的误差同量级
        const t = (i + 0.5) / SR;
        // Web Audio 的 exponentialRampToValueAtTime 是严格指数插值；ramp 结束后保持终值
        const tc = t < layer.dur ? t : layer.dur;
        const f = layer.f0 * Math.pow(ratio, tc / layer.dur);
        phase += (2 * Math.PI * f) / SR;
        let v = 0;
        for (let k = 0; k < orders.length; k++) {
            v += coefs[k] * Math.sin(orders[k] * phase);
        }
        out[i] = v;
    }
    return out;
}

/* ==========================================================================================
   3. 单条音：层 → 混音 → 归一化 → 16bit
   ========================================================================================== */

/** 一条层占用的采样数（含收尾 1.5ms），以及它的起始采样点 */
function layerLayout(layer) {
    return {
        start: Math.round(layer.at * SR),
        decay: Math.round(layer.dur * SR),
        taper: Math.round((S.taperMs / 1000) * SR),
    };
}

/**
 * 渲染一条层到混音缓冲（就地累加）。
 * 包络分两段写：衰减段（4ms 起振 + 指数到 1e-4）与收尾段（线性到精确 0）。
 * 收尾段**接在 dur 之后**再补 1.5ms —— 设计表的 dur 是"指数衰减到 1e-4 的时刻"，
 * 若在那里直接截断，波形会从 1e-4 跳到 0；补一段线性收敛才是"尾不咔哒"的做法。
 */
function mixLayer(mix, layer, source, layout) {
    const attackSec = S.attackMs / 1000;
    const floor = S.decayFloor;
    const decaySpan = Math.max(layer.dur - attackSec, 1e-6);
    for (let i = 0; i < layout.decay; i++) {
        const t = i / SR;
        const amp = t < attackSec
            ? layer.gain * (t / attackSec)
            : layer.gain * Math.pow(floor / layer.gain, (t - attackSec) / decaySpan);
        mix[layout.start + i] += source[i] * amp;
    }
    for (let i = 0; i < layout.taper; i++) {
        const u = (i + 1) / layout.taper; // 最后一个样本 u=1 → 恰好 0
        mix[layout.start + layout.decay + i] += source[layout.decay + i] * floor * (1 - u);
    }
}

/**
 * 渲染一个键（**纯内存**，不碰磁盘）。
 * @returns {{key:string, durationMs:number, ints:Int16Array, peak:number, rms:number, layers:string[]}}
 *          peak/rms 都是**落盘后**的整数样本口径（peak = max|x|/32768），不是浮点理论值
 */
export function renderKey(key) {
    const entry = SFX_TABLE[key];
    if (!entry) {
        throw new Error(`render.mjs: design.mjs 里没有键 "${key}"`);
    }
    const layout = entry.layers.map(layerLayout);
    // 文件长度 = 最后一层的结束 + 5ms 静音
    const bodySamples = Math.max(...layout.map((l, i) => l.start + l.decay + l.taper));
    const total = bodySamples + Math.round((S.silenceMs / 1000) * SR);

    // 噪声流：按层顺序切片（每层一段互不重叠的白噪声）。
    // 与演示台唯一的**有意差异**：演示台每次 noiseHit 都从同一个噪声缓冲的 offset 0 起播，
    // 同一条音里的两层噪声因此完全相关；离线渲染按层顺序切片做**去相关**，响度与确定性都不变。
    const lens = layout.map(l => l.decay + l.taper);
    const maxLen = Math.max(...lens);
    const noiseNeed = entry.layers.reduce((a, l, i) => (l.kind === 'bp' ? a + lens[i] + 97 : a), 0);
    const rng = mulberry32(seedOf(key));
    const noise = new Float64Array(Math.max(total + maxLen, noiseNeed) + 8);
    for (let i = 0; i < noise.length; i++) {
        noise[i] = rng() * 2 - 1;
    }

    const mix = new Float64Array(total);
    let cursor = 0;
    for (let i = 0; i < entry.layers.length; i++) {
        const layer = entry.layers[i];
        const len = lens[i];
        let source;
        if (layer.kind === 'bp') {
            if (cursor + len > noise.length) {
                throw new Error(`${key}: 噪声流不够（需要 ${cursor + len}，只有 ${noise.length}）`);
            }
            source = biquadBandpass(noise.subarray(cursor, cursor + len), layer.freq, layer.q);
            cursor += len + 97; // 留一点间隔，避免相邻层的噪声片段首尾相接
        } else {
            source = renderToneSource(layer, len);
        }
        mixLayer(mix, layer, source, layout[i]);
    }

    // 峰值归一化：混音和有可能超过 1（层叠加），**不削波**，交给归一化统一压到 peakTarget
    let prePeak = 0;
    for (let i = 0; i < total; i++) {
        const a = Math.abs(mix[i]);
        if (a > prePeak) {
            prePeak = a;
        }
    }
    const scale = prePeak > 0 ? S.peakTarget / prePeak : 0;

    const ints = new Int16Array(total);
    let intPeak = 0;
    let sumSq = 0;
    for (let i = 0; i < total; i++) {
        let v = Math.round(mix[i] * scale * INT_SCALE);
        if (v > 32767) {
            v = 32767;
        } else if (v < -32768) {
            v = -32768;
        }
        ints[i] = v;
        const a = v < 0 ? -v : v;
        if (a > intPeak) {
            intPeak = a;
        }
        sumSq += (v / INT_SCALE) * (v / INT_SCALE);
    }
    const peak = intPeak / INT_SCALE;
    if (peak > S.peakTarget + 1e-9) {
        // 归一化后不该越过目标：越过说明量化或缩放写错了，直接失败而不是悄悄削波
        throw new Error(`${key}: 归一化后峰值 ${peak} 超过目标 ${S.peakTarget}`);
    }

    return {
        key: key,
        durationMs: (total / SR) * 1000,
        ints: ints,
        peak: peak,
        rms: Math.sqrt(sumSq / total),
        layers: entry.layers.map(describeLayer),
    };
}

/** 16bit PCM WAV 编码（44 字节 canonical 头 + 小端交错样本；单声道所以 blockAlign=2） */
export function encodeWav(ints, sampleRate = SR) {
    const dataBytes = ints.length * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(S.channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * S.channels * (S.bitsPerSample / 8), 28);
    buf.writeUInt16LE(S.channels * (S.bitsPerSample / 8), 32);
    buf.writeUInt16LE(S.bitsPerSample, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < ints.length; i++) {
        buf.writeInt16LE(ints[i], 44 + i * 2);
    }
    return buf;
}

/** 渲染 + 编码全部键（内存），两种模式共用这条路径 —— `--check` 比对的就是"如果现在渲染会写出什么" */
function renderAll() {
    return SFX_ORDER.map(key => {
        const r = renderKey(key);
        const buffer = encodeWav(r.ints);
        return {
            key: key,
            durationMs: r.durationMs,
            peak: r.peak,
            rms: r.rms,
            layers: r.layers,
            buffer: buffer,
            sha256: createHash('sha256').update(buffer).digest('hex'),
            variantOf: SFX_TABLE[key].variantOf,
            freqScale: SFX_TABLE[key].freqScale,
        };
    });
}

/* ==========================================================================================
   4. manifest.json
   ========================================================================================== */

const r6 = x => Math.round(x * 1e6) / 1e6;
const r2 = x => Math.round(x * 100) / 100;

function buildManifest(entries) {
    return {
        generator: 'tools/hit-feel-sfx/render.mjs',
        designTable: 'tools/hit-feel-sfx/design.mjs',
        spec: 'docs/打击反馈设计.md §12',
        settings: {
            sampleRate: SR,
            channels: S.channels,
            bitsPerSample: S.bitsPerSample,
            format: 'PCM WAV (44-byte canonical header)',
            peakTarget: S.peakTarget,
            attackMs: S.attackMs,
            decayFloor: S.decayFloor,
            taperMs: S.taperMs,
            silenceMs: S.silenceMs,
        },
        totals: {
            files: entries.length,
            bytes: entries.reduce((a, e) => a + e.buffer.length, 0),
            durationMs: r2(entries.reduce((a, e) => a + e.durationMs, 0)),
        },
        files: entries.map(e => {
            const row = {
                key: e.key,
                file: `${e.key}.wav`,
                durationMs: r2(e.durationMs),
                bytes: e.buffer.length,
                sampleRate: SR,
                peak: r6(e.peak),
                rms: r6(e.rms),
                sha256: e.sha256,
                layers: e.layers,
            };
            if (e.variantOf) {
                row.variantOf = e.variantOf;
                row.freqScale = e.freqScale;
            }
            return row;
        }),
    };
}

/* ==========================================================================================
   4b. tier-table.json —— **运行期音效口径**的快照（从真源码解析，不是手抄）
   ==========================================================================================
   为什么要有它：试听页要知道"每一档放哪个键、多响、有几个变体"，而这三个数只存在于
   `assets/scripts/game/common/HitFeelConfig.ts` 里。手抄一份必然漂移（本项目在演示台上
   已经踩过同款教训：`tools/hit-feel-preview/check-drift.mjs` 就是为了治"HTML 里的常量
   跟工程对不上"）。所以：**文本扫描真源码 → 落一份快照 → `--check` 把它当产物一起对账**。

   为什么不 import / 编译它：`HitFeelConfig.ts` 第一行就是 `import { UnitKind } from
   './EntityVisualConfig'`，TS 又不能直接跑 —— 渲染器要么上编译链、要么上依赖，
   两者都违背本工具「零依赖 + 可离线重跑」。文本扫描是这里唯一不引入依赖的做法
   （与本仓库既有的 `check-drift.mjs` 同一套路）。

   ⚠ **解析失败绝不静默**：某档解析不到就写 `null` + `ok:false` + `parseErrors` 列出原因，
   且 `--check` 直接失败（报"真源解析失败：<档位>"）。这张表是试听页的唯一数据源，
   静默产出一张空表会让试听页变成"看起来正常、其实什么都不全"。
   ========================================================================================== */

/**
 * 去掉 `//` 与 `/** *\/` 注释，**但保留字符串字面量**。
 * 为什么要自己扫而不是一句正则：档位表里有 `mark: {...}` / `slowMo: {...}` 这类嵌套对象，
 * 大括号必须配对；而注释与字符串里出现的 `{` `}` 会让朴素的计数法错位。
 */
function stripComments(code) {
    let out = '';
    let i = 0;
    while (i < code.length) {
        const c = code[i];
        if (c === "'" || c === '"' || c === '`') {
            out += c;
            i++;
            while (i < code.length) {
                const d = code[i];
                if (d === '\\') {
                    out += d + (code[i + 1] === undefined ? '' : code[i + 1]);
                    i += 2;
                    continue;
                }
                out += d;
                i++;
                if (d === c) {
                    break;
                }
            }
            continue;
        }
        if (c === '/' && code[i + 1] === '/') {
            while (i < code.length && code[i] !== '\n') {
                i++;
            }
            out += '\n';
            continue;
        }
        if (c === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                i++;
            }
            i += 2;
            out += ' ';
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * 从 `openIndex`（一个 `open` 字符）开始做**字符串无关**的配对，返回两个定界符之间的文本。
 * 为什么要自己做而不是数括号：档位表里有 `mark: {...}` / `slowMo: {...}` 这类嵌套对象，
 * 而注释与字符串里出现的 `{` `}` `[` `]` 会让朴素的计数法错位（注释已在 stripComments 里去掉了）。
 */
function matchPair(code, openIndex, open, close) {
    let depth = 0;
    for (let i = openIndex; i < code.length; i++) {
        const c = code[i];
        if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < code.length && code[i] !== c) {
                if (code[i] === '\\') {
                    i++;
                }
                i++;
            }
            continue;
        }
        if (c === open) {
            depth++;
        } else if (c === close) {
            depth--;
            if (depth === 0) {
                return code.slice(openIndex + 1, i);
            }
        }
    }
    return null;
}

/** 找到 `anchor` 之后第一个 `{`，返回它配对的花括号内部文本（找不到返回 null） */
function objectBodyAfter(code, anchor) {
    const at = code.indexOf(anchor);
    if (at < 0) {
        return null;
    }
    const open = code.indexOf('{', at);
    if (open < 0) {
        return null;
    }
    return matchPair(code, open, '{', '}');
}

/** 找到 `anchor` 之后第一个 `[`，返回它配对方括号内部文本（数组字面量用；找不到返回 null） */
function arrayBodyAfter(code, anchor) {
    const at = code.indexOf(anchor);
    if (at < 0) {
        return null;
    }
    const open = code.indexOf('[', at);
    if (open < 0) {
        return null;
    }
    return matchPair(code, open, '[', ']');
}

/** 解析不到时占位：**键名留着**（试听页才知道是哪一档坏了），三个数值全 null */
function blankTier(name) {
    return { tier: name, sfx: null, volume: null, variants: null };
}

/** `export enum HitFeelTier` 的成员名（**用枚举键名，不用字符串值** —— 字符串值会随实现改） */
function parseTierNames(code, errors) {
    const body = objectBodyAfter(code, 'export enum HitFeelTier');
    if (body == null) {
        errors.push('真源解析失败：HitFeelTier（找不到枚举声明或大括号不配对）');
        return [];
    }
    return body
        .split(',')
        .map(chunk => (chunk.match(/^\s*([A-Za-z_$][\w$]*)/) || [])[1])
        .filter(Boolean);
}

/** `HIT_FEEL_TIERS`：每一档取 sfx / sfxVolume / sfxVariants（键名来自枚举，顺序按枚举） */
function parseTiers(code, names, errors) {
    const body = objectBodyAfter(code, 'export const HIT_FEEL_TIERS');
    if (body == null) {
        errors.push('真源解析失败：HIT_FEEL_TIERS（找不到该常量或大括号不配对）');
        return names.map(blankTier);
    }
    const bodies = new Map();
    const entryRe = /\[HitFeelTier\.([A-Za-z_$][\w$]*)\]\s*:\s*\{/g;
    let m;
    while ((m = entryRe.exec(body)) !== null) {
        const tierBody = matchPair(body, m.index + m[0].length - 1, '{', '}');
        if (tierBody == null) {
            errors.push(`真源解析失败：${m[1]}（该档的大括号不配对）`);
            continue;
        }
        bodies.set(m[1], tierBody);
    }
    // 反向兜底：表里有、枚举里没有 —— 少一个枚举成员会让这一档**静默消失**（试听页少一行而没人知道）
    for (const name of bodies.keys()) {
        if (names.indexOf(name) < 0) {
            errors.push(`真源解析失败：${name}（HIT_FEEL_TIERS 里有这一档，但 HitFeelTier 枚举里没有）`);
        }
    }
    return names.map(name => {
        const tierBody = bodies.get(name);
        if (tierBody === undefined) {
            errors.push(`真源解析失败：${name}（HIT_FEEL_TIERS 里没有这一档）`);
            return blankTier(name);
        }
        const sfx = tierBody.match(/\bsfx\s*:\s*'([^']*)'/);
        const volume = tierBody.match(/\bsfxVolume\s*:\s*(-?[0-9.]+)/);
        const variants = tierBody.match(/\bsfxVariants\s*:\s*(-?[0-9]+)/);
        const missing = [];
        if (!sfx) {
            missing.push('sfx');
        }
        if (!volume) {
            missing.push('sfxVolume');
        }
        if (!variants) {
            missing.push('sfxVariants');
        }
        if (missing.length > 0) {
            errors.push(`真源解析失败：${name}（缺少 ${missing.join(' / ')}）`);
            return blankTier(name);
        }
        return { tier: name, sfx: sfx[1], volume: Number(volume[1]), variants: Number(variants[1]) };
    });
}

/** `HIT_FEEL_SFX_EXTRA`：非档位音（出手 / 闪避）—— 源码里是 `key` 而不是 `sfx`，字段名照搬 */
function parseExtras(code, errors) {
    const body = objectBodyAfter(code, 'export const HIT_FEEL_SFX_EXTRA');
    const out = {};
    for (const name of ['attackShot', 'evade']) {
        let entryBody = null;
        if (body != null) {
            const at = body.search(new RegExp(`\\b${name}\\s*:\\s*\\{`));
            if (at >= 0) {
                entryBody = matchPair(body, body.indexOf('{', at), '{', '}');
            }
        }
        if (entryBody == null) {
            errors.push(`真源解析失败：HIT_FEEL_SFX_EXTRA.${name}（找不到这一条或大括号不配对）`);
            out[name] = null;
            continue;
        }
        const key = entryBody.match(/\bkey\s*:\s*'([^']*)'/);
        const volume = entryBody.match(/\bvolume\s*:\s*(-?[0-9.]+)/);
        const variants = entryBody.match(/\bvariants\s*:\s*(-?[0-9]+)/);
        const missing = [];
        if (!key) {
            missing.push('key');
        }
        if (!volume) {
            missing.push('volume');
        }
        if (!variants) {
            missing.push('variants');
        }
        if (missing.length > 0) {
            errors.push(`真源解析失败：HIT_FEEL_SFX_EXTRA.${name}（缺少 ${missing.join(' / ')}）`);
            out[name] = null;
            continue;
        }
        out[name] = { key: key[1], volume: Number(volume[1]), variants: Number(variants[1]) };
    }
    return out;
}

/** `HIT_FEEL_BUDGET` 里与音效有关的两条（节流窗口与窗口内上限） */
function parseSfxBudget(code, errors) {
    const body = objectBodyAfter(code, 'export const HIT_FEEL_BUDGET');
    if (body == null) {
        errors.push('真源解析失败：HIT_FEEL_BUDGET（找不到该常量或大括号不配对）');
        return null;
    }
    const windowMs = body.match(/\bsfxWindowMs\s*:\s*(-?[0-9.]+)/);
    const maxPerWindow = body.match(/\bsfxMaxPerWindow\s*:\s*(-?[0-9.]+)/);
    const missing = [];
    if (!windowMs) {
        missing.push('sfxWindowMs');
    }
    if (!maxPerWindow) {
        missing.push('sfxMaxPerWindow');
    }
    if (missing.length > 0) {
        errors.push(`真源解析失败：HIT_FEEL_BUDGET（缺少 ${missing.join(' / ')}）`);
        return null;
    }
    return { sfxWindowMs: Number(windowMs[1]), sfxMaxPerWindow: Number(maxPerWindow[1]) };
}

/**
 * 变体后缀表（`['', '_v2', '_v3']`）。
 * 为什么要解析它而不是在渲染器里写死：变体命名是**配置侧的口径**，写死就等于同一件事有两份真源；
 * 而它正好是"表里写了 n 个变体 → 磁盘上该有哪几个文件"的翻译表，器材自检必须用它。
 */
function parseVariantSuffixes(code, errors) {
    // ⚠ 它是**数组字面量**（`= ['', '_v2', '_v3']`），必须用方括号配对 —— 用 `{` 配对会
    //    顺着文件往下抓到后面某个对象里去（这是本解析器真的踩过一次的坑）
    const body = arrayBodyAfter(code, 'export const HIT_FEEL_SFX_VARIANT_SUFFIXES');
    if (body == null) {
        errors.push('真源解析失败：HIT_FEEL_SFX_VARIANT_SUFFIXES（找不到该常量或方括号不配对）');
        return null;
    }
    const out = [];
    const re = /'([^']*)'|"([^"]*)"/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        out.push(m[1] === undefined ? m[2] : m[1]);
    }
    if (out.length === 0 || out[0] !== '') {
        // 第 1 项必须是空串（"第 1 份不带后缀"是这个表的契约），否则变体名会整体错位
        errors.push('真源解析失败：HIT_FEEL_SFX_VARIANT_SUFFIXES（第 1 项必须是空串，表示"第 1 份不带后缀"）');
        return null;
    }
    return out;
}

/**
 * 解析**源码文本** → 快照内容（纯函数，不碰磁盘）。
 *
 * 为什么单独拆出来并导出：失败路径（少字段 / 改写法 / 删枚举成员）必须能被测到，
 * 而唯一诚实的测法是喂一份**改坏的源码文本**；为了测它去临时改真源码是绝对不能做的事
 * （`HitFeelConfig.ts` 是别人正在编辑的文件）。
 * `ok=false` 时 `parseErrors` 里是人话，且所有解析不到的档位都是 null —— 绝不静默降级成空表。
 */
export function parseHitFeelSource(sourceText) {
    const errors = [];
    const code = stripComments(sourceText);
    const names = parseTierNames(code, errors);
    const tiers = parseTiers(code, names, errors);
    const extra = parseExtras(code, errors);
    const budget = parseSfxBudget(code, errors);
    const suffixes = parseVariantSuffixes(code, errors);
    return {
        ok: errors.length === 0,
        /**
         * `source` 是**字符串**（路径），不是对象 —— 试听页直接把它拼进文案（`真源 = <source>`），
         * 塞对象会渲染成 `[object Object]`；"别手改"那句单独放 `note`。
         * 形状与 `audition.html` 里 `check-drift.mjs --write` 生成的那份快照保持一致，
         * 这样两边可以互换/对账（见该文件 DRIFT 段）。
         */
        source: HIT_FEEL_CONFIG_REL,
        note: 'GENERATED by tools/hit-feel-sfx/render.mjs from HitFeelConfig.ts — do not hand-edit; re-run `node render.mjs`',
        parsedBy: 'regex/text scan, no TS compile (symbols: HitFeelTier, HIT_FEEL_TIERS, HIT_FEEL_SFX_EXTRA, HIT_FEEL_BUDGET, HIT_FEEL_SFX_VARIANT_SUFFIXES)',
        tiers: tiers,
        extra: extra,
        budget: budget,
        parseErrors: errors,
        /** 内部用（器材自检）：变体后缀表；不进 JSON —— 快照只留试听页要用的口径 */
        variantSuffixes: suffixes,
    };
}

/** 读真源文件 → 快照。文件缺失也算"解析失败"（`ok=false`），不抛异常 —— 免得把 `--check` 的退出码语义搞乱 */
export function buildTierTable() {
    const abs = join(PROJECT_ROOT, HIT_FEEL_CONFIG_REL);
    if (!existsSync(abs)) {
        const snapshot = parseHitFeelSource('');
        snapshot.parseErrors.unshift(`真源解析失败：找不到 ${HIT_FEEL_CONFIG_REL}`);
        snapshot.ok = false;
        return snapshot;
    }
    return parseHitFeelSource(readFileSync(abs, 'utf8'));
}

/** 快照落盘时的形状：去掉内部字段，并把 `ok` 放最前面（人肉 diff 时第一眼就看到有没有解析失败） */
function tierTableJson(snapshot) {
    return {
        ok: snapshot.ok,
        source: snapshot.source,
        note: snapshot.note,
        parsedBy: snapshot.parsedBy,
        tiers: snapshot.tiers,
        extra: snapshot.extra,
        budget: snapshot.budget,
        parseErrors: snapshot.parseErrors,
    };
}

/**
 * 器材自检：**配置引用的每一个键，磁盘上都要有对应文件**。
 *
 * 为什么它值得让 `--check` 失败：`playSFX` 是"加载失败就静默不响"，
 * 表里写了 3 个变体而磁盘只有 2 份，表现为"偶尔这一下没声音"，在实机上极难定位。
 * 反向（渲染了但没人引用）只警告不失败：多一个几 KB 的文件无害，它可能是别的调用方引用的。
 */
export function checkTierCoverage(snapshot, renderedKeys) {
    const missing = [];
    const referenced = new Set();
    const suffixes = snapshot.variantSuffixes || [''];
    const want = (base, variants, who) => {
        if (!base) {
            return;
        }
        const n = Math.max(1, Math.min(variants | 0, suffixes.length));
        for (let i = 0; i < n; i++) {
            const key = base + suffixes[i];
            referenced.add(key);
            if (!renderedKeys.has(key)) {
                missing.push({ key: key, who: who });
            }
        }
    };
    for (const tier of snapshot.tiers) {
        if (tier && tier.sfx !== null && tier.variants !== null) {
            want(tier.sfx, tier.variants, `${tier.tier} 档`);
        }
    }
    for (const name of Object.keys(snapshot.extra)) {
        const e = snapshot.extra[name];
        if (e) {
            want(e.key, e.variants, `HIT_FEEL_SFX_EXTRA.${name}`);
        }
    }
    return { missing: missing, referenced: referenced };
}

/* ==========================================================================================
   5. 控制台输出（ASCII-safe）
   ========================================================================================== */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const kb = n => (n / 1024).toFixed(2);

function printRow(e) {
    const file = `${e.key}.wav`;
    console.log(
        `[render] ${pad(file, 22)}${padL(Math.round(e.durationMs), 6)} ms${padL(kb(e.buffer.length), 9)} KB` +
        `  peak ${e.peak.toFixed(6)}  rms ${e.rms.toFixed(6)}  ${e.buffer.length} B`,
    );
}

function printSummary(entries) {
    console.log('');
    console.log(`${pad('key', 18)}${pad('file', 22)}${padL('ms', 8)}${padL('KB', 9)}${padL('peak', 11)}${padL('rms', 10)}`);
    console.log('-'.repeat(78));
    for (const e of entries) {
        console.log(
            `${pad(e.key, 18)}${pad(`${e.key}.wav`, 22)}${padL(r2(e.durationMs), 8)}${padL(kb(e.buffer.length), 9)}` +
            `${padL(e.peak.toFixed(6), 11)}${padL(e.rms.toFixed(6), 10)}`,
        );
    }
    console.log('-'.repeat(78));
    const bytes = entries.reduce((a, e) => a + e.buffer.length, 0);
    const ms = entries.reduce((a, e) => a + e.durationMs, 0);
    console.log(`${pad(`TOTAL ${entries.length} files`, 48)}${padL(r2(ms), 8)}${padL(kb(bytes), 9)}`);
    console.log(`total bytes: ${bytes} (${kb(bytes)} KB)   budget: < 300 KB at ${SR} Hz mono 16-bit`);
}

/* ==========================================================================================
   6. CLI
   ========================================================================================== */

/** 渲染模式的收尾：解析真源、落 tier-table.json、做器材自检。返回退出码（解析失败＝1） */
function writeTierTable(entries) {
    const snapshot = buildTierTable();
    const json = tierTableJson(snapshot);
    writeFileSync(TIER_TABLE_PATH, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    const renderedKeys = new Set(entries.map(e => e.key));
    const coverage = checkTierCoverage(snapshot, renderedKeys);
    const tiers = snapshot.tiers.length;
    console.log(`[ok] wrote tier table -> ${TIER_TABLE_PATH}`);
    console.log(
        `[tier] ${tiers} tiers parsed from ${HIT_FEEL_CONFIG_REL}` +
        (snapshot.budget
            ? `  sfxWindowMs=${snapshot.budget.sfxWindowMs} sfxMaxPerWindow=${snapshot.budget.sfxMaxPerWindow}`
            : '  budget: PARSE FAILED'),
    );
    if (!snapshot.ok) {
        // 绝不静默：表照写（试听页至少能看到"哪一档是 null"），但渲染器以失败收场
        console.log('');
        console.log(`[DRIFT] ${snapshot.parseErrors.length} source parse failure(s) in ${HIT_FEEL_CONFIG_REL}:`);
        for (const err of snapshot.parseErrors) {
            console.log(`  - ${err}`);
        }
        console.log('[tier] FAILED to parse the source of truth (exit 1) - tier-table.json has null entries');
        return 1;
    }
    if (coverage.missing.length > 0) {
        console.log('');
        console.log(`[DRIFT] ${coverage.missing.length} key(s) referenced by HitFeelConfig.ts have no rendered file:`);
        for (const miss of coverage.missing) {
            console.log(`  - ${pad(miss.key, 24)} ${miss.who} - add it to design.mjs and re-render`);
        }
        console.log('[tier] FAILED asset self-check (exit 1)');
        return 1;
    }
    const unreferenced = entries.map(e => e.key).filter(k => !coverage.referenced.has(k) && k !== 'click');
    console.log(`[tier] all ${coverage.referenced.size} keys referenced by the source exist on disk`);
    if (unreferenced.length > 0) {
        // 只警告：多渲染一个键无害（`click` 是平台层写死的，天然不在 HitFeelConfig 里，故排除）
        console.log(`[warn] rendered but not referenced by HitFeelConfig.ts: ${unreferenced.join(', ')}`);
    }
    return 0;
}

function runRender() {
    const entries = renderAll();
    mkdirSync(OUT_DIR, { recursive: true });
    for (const e of entries) {
        writeFileSync(join(OUT_DIR, `${e.key}.wav`), e.buffer);
        printRow(e);
    }
    const manifest = buildManifest(entries);
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    printSummary(entries);
    console.log(`[ok] wrote ${entries.length} wav -> ${OUT_DIR}${sep}`);
    console.log(`[ok] wrote manifest -> ${MANIFEST_PATH}`);
    return writeTierTable(entries);
}

/**
 * `--check`：全部在内存里重渲，与磁盘逐字节比对。
 * 只读：不 mkdir、不写文件。漂移的四种口径分开报，便于一眼看出"是缺文件还是内容变了"。
 */
function runCheck() {
    const entries = renderAll();
    console.log(`[check] rendered ${entries.length} files in memory (no writes)`);
    const drifts = [];
    const expected = new Set(entries.map(e => `${e.key}.wav`));

    for (const e of entries) {
        const name = `${e.key}.wav`;
        const path = join(OUT_DIR, name);
        if (!existsSync(path)) {
            drifts.push({ name: name, reason: 'missing', detail: `expected ${e.buffer.length} bytes, file absent` });
            continue;
        }
        const onDisk = readFileSync(path);
        if (onDisk.length !== e.buffer.length) {
            drifts.push({
                name: name,
                reason: 'size',
                detail: `disk ${onDisk.length} bytes vs expected ${e.buffer.length} bytes`,
            });
            continue;
        }
        if (!onDisk.equals(e.buffer)) {
            const diskHash = createHash('sha256').update(onDisk).digest('hex').slice(0, 16);
            drifts.push({
                name: name,
                reason: 'hash',
                detail: `sha256 disk ${diskHash} vs expected ${e.sha256.slice(0, 16)}`,
            });
        }
    }

    if (existsSync(OUT_DIR)) {
        for (const name of readdirSync(OUT_DIR)) {
            if (name.toLowerCase().endsWith('.wav') && !expected.has(name)) {
                drifts.push({ name: name, reason: 'extra', detail: 'not produced by design.mjs' });
            }
        }
    }

    const manifestBuffer = Buffer.from(`${JSON.stringify(buildManifest(entries), null, 2)}\n`, 'utf8');
    if (!existsSync(MANIFEST_PATH)) {
        drifts.push({ name: 'manifest.json', reason: 'missing', detail: 'run `node render.mjs` to generate' });
    } else if (!readFileSync(MANIFEST_PATH).equals(manifestBuffer)) {
        drifts.push({ name: 'manifest.json', reason: 'hash', detail: 'stale (wav hashes / sizes differ)' });
    }

    // ---- tier-table.json：真源解析 + 与磁盘快照对账 + 器材自检 ----
    const snapshot = buildTierTable();
    const parsedErrors = snapshot.parseErrors;
    const tierBuffer = Buffer.from(`${JSON.stringify(tierTableJson(snapshot), null, 2)}\n`, 'utf8');
    if (!existsSync(TIER_TABLE_PATH)) {
        drifts.push({ name: 'tier-table.json', reason: 'missing', detail: 'run `node render.mjs` to generate' });
    } else if (!readFileSync(TIER_TABLE_PATH).equals(tierBuffer)) {
        drifts.push({
            name: 'tier-table.json',
            reason: 'stale',
            detail: `${HIT_FEEL_CONFIG_REL} changed since the snapshot was written - re-run \`node render.mjs\``,
        });
    }
    const coverage = checkTierCoverage(snapshot, new Set(entries.map(e => e.key)));
    for (const miss of coverage.missing) {
        drifts.push({
            name: `${miss.key}.wav`,
            reason: 'asset',
            detail: `${miss.who} references it, but no rendered file exists (design.mjs has no such key)`,
        });
    }

    if (drifts.length > 0) {
        console.log('');
        if (parsedErrors.length > 0) {
            console.log(`[DRIFT] ${parsedErrors.length} source parse failure(s) in ${HIT_FEEL_CONFIG_REL}:`);
            for (const err of parsedErrors) {
                console.log(`  - ${err}`);
            }
        }
        console.log(`[DRIFT] ${drifts.length} file(s) differ from a fresh render:`);
        for (const d of drifts) {
            console.log(`  - ${pad(d.name, 24)} ${pad(d.reason, 8)} ${d.detail}`);
        }
        console.log('[check] FAILED (exit 1)');
        return 1;
    }

    const bytes = entries.reduce((a, e) => a + e.buffer.length, 0);
    console.log(`[check] OK: ${entries.length}/${entries.length} wav match byte-for-byte, manifest.json up to date`);
    console.log(
        `[check] OK: tier-table.json matches a fresh parse of ${HIT_FEEL_CONFIG_REL}` +
        ` (${snapshot.tiers.length} tiers, ${coverage.referenced.size} referenced keys all present)`,
    );
    console.log(`[check] total ${bytes} bytes (${kb(bytes)} KB), ${r2(entries.reduce((a, e) => a + e.durationMs, 0))} ms of audio`);
    return 0;
}

function main(argv) {
    const args = argv.slice(2);
    if (args.length === 0) {
        return runRender();
    }
    if (args.length === 1 && args[0] === '--check') {
        return runCheck();
    }
    console.log('usage: node render.mjs [--check]');
    console.log('  (no args)  render all wav into assets/resources/sfx/, write manifest.json + tier-table.json');
    console.log('  --check    re-render in memory and compare byte-for-byte; never writes');
    return 2;
}

// 只有被当作 CLI 直接运行时才执行；被 import 时（例如量化自检脚本）只提供函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv);
}
