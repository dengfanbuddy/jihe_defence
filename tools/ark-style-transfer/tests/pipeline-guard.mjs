/**
 * 透明背景「下单前」的拦截自测（**不联网、不花钱**）
 *
 *   node tests/pipeline-guard.mjs
 *
 * 这三条守卫是被真事故逼出来的（用户勾着参考图 + 选「接口直出透明」，
 * 老代码**静默丢掉参考图**只送目标图 → 用户以为在做风格迁移，批量时白花一整批的钱）：
 *   ① 「接口直出透明」+ 参考图 → 当场拒绝（接口要求恰好 1 张输入图，2 张必报 400）
 *   ② 「接口直出透明」+ 目标图没有透明像素 → 当场拒绝（它是保留 alpha，不是去背景）
 *   ③ 合法的单图接口透明 → 守卫放行（这里用「没配 Key」的报错证明它走过了守卫）
 * 另外顺带验一下色键抠图 + 参考图是**放行**的（这才是双图透明背景的正路）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { processOne } from '../src/pipeline.mjs';
import { normalizeParams } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.data', 'guard-test');

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};

fs.mkdirSync(TMP, { recursive: true });

// 造两张输入图：一张完全不透明、一张带真透明像素（都不碰网络）
const opaque = path.join(TMP, 'opaque.png');
const alphaPng = path.join(TMP, 'alpha.png');
await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 255 } } })
    .png()
    .toFile(opaque);
await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
        {
            input: await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 255 } } })
                .png()
                .toBuffer(),
            left: 12,
            top: 12,
        },
    ])
    .png()
    .toFile(alphaPng);

/** 跑一次 processOne，返回它抛出的错误（没抛就返回 null）；不配 Key，所以守卫放行后必然停在 NoApiKey */
async function run({ alphaMode, useRef, target }) {
    const { params } = normalizeParams({
        ...(alphaMode ? { alphaMode } : {}),
        prompt: '把图2的道具重绘成图1的画风，背景纯色 #FF00FF',
        ...(useRef === undefined ? {} : { useRef }),
        sizeTier: '1K',
        outputFormat: 'png',
    });
    try {
        await processOne({
            params,
            apiKey: '', // 故意不给 Key：过了守卫就会停在 NoApiKey（证明守卫放行且没联网）
            target: { path: target },
            ref: { path: opaque, name: 'ref.png' },
            outDir: path.join(TMP, 'out'),
            mode: 'generate',
        });
        return null;
    } catch (e) {
        return e;
    }
}

console.log('\n=== 透明背景前置守卫自测（不花钱） ===\n');

const a = await run({ alphaMode: 'api', useRef: true, target: opaque });
check('① 接口透明 + 参考图 → 被拒', /恰好 1 张输入图/.test(a?.message || ''), (a?.message || '没报错！').split('\n')[0]);

const b = await run({ alphaMode: 'api', useRef: false, target: opaque });
check('② 接口透明 + 无透明像素输入 → 被拒', /不会去背景/.test(b?.message || ''), (b?.message || '没报错！').split('\n')[0]);

const c = await run({ alphaMode: 'api', useRef: false, target: alphaPng });
check('③ 接口透明 + 合法单图 → 守卫放行（停在没配 Key）', c?.code === 'NoApiKey', c?.code || c?.message || '居然没报错');

const d = await run({ alphaMode: 'chroma', useRef: true, target: opaque });
check('④ 色键抠图 + 参考图 → 守卫放行（双图透明背景的正路）', d?.code === 'NoApiKey', d?.code || d?.message || '居然没报错');

// 参数归一化层面：不该再静默把 useRef 改掉（改掉就等于偷偷把风格迁移降级成单图重绘）
const { params: np, warnings } = normalizeParams({ alphaMode: 'api', useRef: true });
check('⑤ 归一化不再静默清掉「使用参考图」', np.useRef === true, `useRef=${np.useRef}`);
check('⑤b 但会给出互斥警告', warnings.some((w) => /互斥/.test(w)), warnings.join(' | ').slice(0, 80));

// 「不处理」+ 提示词要求透明 → 必须提前说出来（这正是用户这次踩的坑）
const { warnings: w2 } = normalizeParams({ alphaMode: 'none', prompt: '背景必须透明的，四周留白' });
check('⑥ 「不处理」+ 提示词要透明 → 提前警告', w2.some((w) => /不透明的 PNG/.test(w)), w2.join(' | ').slice(0, 90));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
