/**
 * 打击反馈音效 · 声音设计表（合成的**唯一真源**）
 *
 * 为什么单独开一张表：`docs/打击反馈设计.md` §12 只给了「键名 / 时长 / 音量 / 音色方向」，
 * 真正决定波形的是「每层用哪种基元 + 参数」。这段参数一旦散落在渲染器里，
 * 改一次音色就要翻两处，且 `--check` 的"漂移"会变成"改错了地方"。
 * 所以：**本文件只描述「要什么声音」，不做任何 DSP**；`render.mjs` 只描述「怎么算」，
 * 绝不在渲染器里出现第二个 1100 / 0.22 / square 之类的魔法数。
 *
 * 两个基元与演示台 `tools/hit-feel-preview/index.html` §3 的 `noiseHit` / `toneHit` 一一对应：
 *     BP = noiseHit(t0, dur, freq, q, gain)      白噪声 → bandpass(freq, Q) → 包络
 *     SW = toneHit(t0, f0, f1, dur, gain, type)  振荡器按指数扫频 f0→f1 → 同一包络
 *
 * 音色方向（`docs/打击反馈设计.md` §12.2）：干、短、近场、**无混响尾巴、无低频轰鸣**；
 * 质感是纸 / 木 / 金属尺 / 机械卡扣 / 铅笔划线，不是电影式 impact。
 * 所以本表里**没有任何一层是"尾音"**：最长的一层是 `kill_big` 的 300ms，且都靠指数衰减收干净。
 */

/** 渲染全局设置：单位、包络形状、归一化目标 —— 渲染器只从这里读，不许写死 */
export const RENDER_SETTINGS = {
    /** 采样率：§12.7 原写 44.1kHz，本次按任务规格降到 22050（短促打击音的上限只有 ~5.5kHz，够用且体积减半） */
    sampleRate: 22050,
    channels: 1,
    bitsPerSample: 16,
    /** 峰值归一化目标：每条音的响度差**不在素材里烘焙**，由运行时按档位表的 sfxVolume 施加 */
    peakTarget: 0.8,
    /** 起振：线性 0 → 峰值，对齐演示台 `linearRampToValueAtTime(gain, t0 + 0.004)` */
    attackMs: 4,
    /** 指数衰减的终值，对齐演示台 `exponentialRampToValueAtTime(0.0001, t0 + dur)` */
    decayFloor: 1e-4,
    /** 衰减到 floor 之后再补一段线性收敛到**精确 0**，避免尾部截断产生咔哒声 */
    taperMs: 1.5,
    /** 文件尾部静音 */
    silenceMs: 5,
};

/**
 * 噪声层（对应演示台 noiseHit）
 * @param {number} freq 带通中心频率 Hz
 * @param {number} q    带通 Q（Web Audio 的 bandpass 是"恒定峰值增益"型，Q 越大越窄越"脆"）
 * @param {number} dur  层时长 s（指数衰减到 decayFloor 的时刻）
 * @param {number} gain 线性幅度（归一化前的相对配比）
 * @param {number} at   起始偏移 s，默认 0
 */
function bp(freq, q, dur, gain, at = 0) {
    return { kind: 'bp', freq: freq, q: q, dur: dur, gain: gain, at: at };
}

/**
 * 扫频音层（对应演示台 toneHit）
 * @param {'sine'|'square'|'triangle'} type 波形
 * @param {number} f0 起始频率 Hz
 * @param {number} f1 结束频率 Hz（指数插值；f1 === f0 表示不扫，只当持续音用）
 * @param {number} dur 层时长 s
 * @param {number} gain 线性幅度
 * @param {number} at 起始偏移 s，默认 0
 */
function sw(type, f0, f1, dur, gain, at = 0) {
    return { kind: 'sw', type: type, f0: f0, f1: f1, dur: dur, gain: gain, at: at };
}

/* ==========================================================================================
   基础配方：11 个键 —— 三层栈（攻击 whoosh / 命中 impact / 暴击或重量层）+ 按档位调的性格
   ========================================================================================== */

/** 最高频的一条（0.83s 一次）→ 必须最轻最短：一段中频带通噪声 + 一个短促下滑方波 */
const LAYERS_HIT_LIGHT = [
    bp(1100, 1.0, 0.070, 0.22),
    sw('square', 260, 120, 0.045, 0.12),
];

/** 暴击要"一耳可分"，但靠**更脆**而不是更响：多一层 5.2kHz 高 Q 的短噪声当"金属尺" */
const LAYERS_HIT_CRIT = [
    bp(2800, 1.6, 0.100, 0.20),
    sw('square', 560, 190, 0.090, 0.14),
    bp(5200, 3.0, 0.025, 0.10),
];

/** 普通怪死亡：与 hit_light 同族，尾巴多一层 3kHz 的"散"（对应死亡碎片） */
const LAYERS_KILL_NORMAL = [
    bp(800, 0.9, 0.120, 0.24),
    sw('square', 300, 110, 0.080, 0.12),
    bp(3000, 1.2, 0.090, 0.08),
];

/** 精英 / Boss 死亡：三层 + 一层正弦"重量"，是全表最长的非 clear 音 */
const LAYERS_KILL_BIG = [
    bp(320, 0.8, 0.300, 0.26),
    sw('square', 180, 60, 0.160, 0.15),
    sw('sine', 165, 70, 0.300, 0.22),
];

/** 基础表：键 → 层列表（顺序即混音顺序，不影响结果，只影响 manifest 里的可读摘要） */
const BASE_TABLE = {
    // T0 普攻命中
    hit_light: LAYERS_HIT_LIGHT,
    // T1 暴击命中
    hit_crit: LAYERS_HIT_CRIT,
    // T2 普通怪死亡
    kill_normal: LAYERS_KILL_NORMAL,
    // T3 精英命中 / 技能命中：读作"打到硬东西了"→ 更低更闷的体腔 + 更脆的高频边
    hit_heavy: [
        bp(600, 1.4, 0.110, 0.26),
        sw('square', 200, 85, 0.070, 0.14),
        bp(4200, 2.5, 0.030, 0.09),
    ],
    // T4 Boss 命中：比 heavy 更闷更长（Boss 体型 ×1.5~2，普通规格在它身上会"听不见"）
    hit_boss: [
        bp(380, 1.2, 0.150, 0.28),
        sw('square', 150, 60, 0.100, 0.16),
        sw('sine', 160, 90, 0.120, 0.10),
    ],
    // T5 精英 / Boss 死亡
    kill_big: LAYERS_KILL_BIG,
    // T6 英雄受击：**只有 70~260Hz**，与所有"打怪"音不同族 —— 耳朵要先于眼睛知道"我掉血了"
    hero_hurt: [
        sw('sine', 220, 70, 0.220, 0.30),
        bp(260, 0.7, 0.180, 0.18),
        sw('sine', 150, 65, 0.250, 0.18),
    ],
    // T7 通关：t=0 复用 kill_big 那一栈（同一段配方只写一次），再叠一条向上的正弦三音
    // 仍然**干**：没有一层是混响尾巴，最长的一层也靠指数衰减在 1.35s 收干净
    clear: [
        ...LAYERS_KILL_BIG,
        sw('sine', 392, 784, 0.30, 0.16, 0.22), // G4 → G5，向上"解决"
        sw('sine', 587, 587, 0.45, 0.14, 0.55), // D5 持续
        sw('sine', 784, 784, 0.50, 0.14, 0.85), // G5 持续
        bp(1200, 0.7, 0.90, 0.06, 0.10),        // 垫底的一层"纸被摊开"，很轻
    ],
    // 出手（对应 B2 起手虚线）：比命中更"空气"，只有噪声 + 一个很短的方波
    attack_shot: [
        bp(1400, 1.2, 0.070, 0.20),
        sw('square', 400, 180, 0.040, 0.08),
    ],
    // 闪避（对应 B3 斜杠）：高频短噪声 + 一段快速下滑的正弦，读作"擦身而过"
    evade: [
        bp(2000, 2.0, 0.080, 0.16),
        sw('sine', 1800, 600, 0.080, 0.10),
        sw('sine', 300, 150, 0.060, 0.06),
    ],
    // 全局按钮：机械卡扣，最短的一条（AudioMgr.defaultTouchStart 已写死这个键名）
    click: [
        bp(2400, 1.5, 0.030, 0.18),
        sw('triangle', 900, 700, 0.025, 0.10),
    ],
};

/* ==========================================================================================
   音高变体：演示台 E3「音高随机」在引擎侧不能播放时变调（playOneShot 无音高参数），
   只能**预渲染变体**。变体 = 整条音的所有频率 ×k（与 E3 满格 ±5% 一致）；
   噪声种子由**键名**派生（见 render.mjs 的 seedOf），所以变体的噪声也不一样，听感更"随机"。
   ========================================================================================== */
const VARIANTS = [
    { key: 'hit_light_v2', base: 'hit_light', freqScale: 0.95 },
    { key: 'hit_light_v3', base: 'hit_light', freqScale: 1.05 },
    { key: 'kill_normal_v2', base: 'kill_normal', freqScale: 0.95 },
    { key: 'kill_normal_v3', base: 'kill_normal', freqScale: 1.05 },
    { key: 'hit_crit_v2', base: 'hit_crit', freqScale: 1.05 },
];

/**
 * 把一条层的所有频率乘以 k（变体用）。
 * 为什么不复用同一个噪声种子：变体键名不同 → 种子不同 → 噪声不同，这是**想要**的。
 */
function scaleLayerFreq(layer, k) {
    if (layer.kind === 'bp') {
        return { ...layer, freq: layer.freq * k };
    }
    return { ...layer, f0: layer.f0 * k, f1: layer.f1 * k };
}

/** 键的渲染顺序：基础 11 个按档位排（T0→T7 再是三个非档位音），变体跟在本体后面 */
export const SFX_ORDER = [
    'hit_light', 'hit_crit', 'kill_normal', 'hit_heavy', 'hit_boss', 'kill_big', 'hero_hurt', 'clear',
    'attack_shot', 'evade', 'click',
    'hit_light_v2', 'hit_light_v3', 'kill_normal_v2', 'kill_normal_v3', 'hit_crit_v2',
];

/** 变体表：key → { base, freqScale }，供 manifest 里标注"这条是哪个本体的变体" */
export const SFX_VARIANTS = Object.fromEntries(
    VARIANTS.map(v => [v.key, { base: v.base, freqScale: v.freqScale }]),
);

/** 展开后的最终表：key → { key, layers, variantOf, freqScale } */
export const SFX_TABLE = (() => {
    const table = {};
    for (const key of SFX_ORDER) {
        if (Object.prototype.hasOwnProperty.call(BASE_TABLE, key)) {
            table[key] = { key: key, layers: BASE_TABLE[key], variantOf: null, freqScale: 1 };
            continue;
        }
        const variant = VARIANTS.find(v => v.key === key);
        if (!variant) {
            throw new Error(`design.mjs: SFX_ORDER 里的键 "${key}" 既不在 BASE_TABLE 也不是变体`);
        }
        table[key] = {
            key: key,
            layers: BASE_TABLE[variant.base].map(layer => scaleLayerFreq(layer, variant.freqScale)),
            variantOf: variant.base,
            freqScale: variant.freqScale,
        };
    }
    return table;
})();

/**
 * 一条层的可读摘要（写进 manifest.json，也用于控制台）。
 * 刻意保持 ASCII：manifest 要能直接 diff，中文只出现在源码注释里。
 */
export function describeLayer(layer) {
    const head = layer.at > 0 ? `@${Math.round(layer.at * 1000)}ms ` : '';
    if (layer.kind === 'bp') {
        return `${head}BP ${fmt(layer.freq)}Hz Q${layer.q.toFixed(1)} ${Math.round(layer.dur * 1000)}ms g${layer.gain.toFixed(2)}`;
    }
    return `${head}SW ${layer.type} ${fmt(layer.f0)}->${fmt(layer.f1)}Hz ${Math.round(layer.dur * 1000)}ms g${layer.gain.toFixed(2)}`;
}

/** 频率打印：先归到一位小数再判断整数 —— 1100×0.95 在浮点里是 1045.0000000000002，直接判断会打出 "1045.0" */
function fmt(hz) {
    const r = Math.round(hz * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
