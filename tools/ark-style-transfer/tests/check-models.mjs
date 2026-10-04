/**
 * 免费校验「模型 ID 能不能用于图片生成」。
 *
 *   node tests/check-models.mjs                # 校验内置模型表里的所有 ID 与别名
 *   node tests/check-models.mjs --account      # 再把账户模型列表里图片相关的 ID 也一起校验
 *   node tests/check-models.mjs --ids a,b,c    # 只校验指定 ID
 *
 * 原理：发一个不可能成功的请求（尺寸 1x1 + 1 字节坏图），看报错类型 ——
 * 报「模型不存在」就是不可用；报参数错就说明网关认了这个模型。**不产生费用**。
 *
 * 结果写到 .data/model-probe.json，界面也会读它来标注模型可用性。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, modelIds, loadConfig, saveConfig, effectiveApiKey, effectiveBaseUrl } from '../src/config.mjs';
import { probeModelId, listModels } from '../src/ark.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.data', 'model-probe.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : '';
};

const apiKey = effectiveApiKey();
if (!apiKey) {
    console.error('没有 API Key：先在界面「设置」里填，或设环境变量 ARK_API_KEY');
    process.exit(1);
}
const baseUrl = effectiveBaseUrl();

let ids = [];
if (val('ids')) ids = val('ids').split(',').map((s) => s.trim()).filter(Boolean);
else ids = [...new Set(MODELS.flatMap(modelIds))];

if (flag('account')) {
    const extra = loadConfig().accountModels || [];
    const { ids: live } = await listModels({ apiKey, baseUrl }).catch(() => ({ ids: [] }));
    const pool = live.length ? live : extra;
    for (const id of pool) {
        if (/seedream|seededit/i.test(id) && !ids.includes(id)) ids.push(id);
    }
}

console.log(`\n=== 模型 ID 可用性校验（免费，共 ${ids.length} 个）===\n`);
const results = [];
for (const id of ids) {
    const r = await probeModelId({ apiKey, baseUrl, model: id });
    results.push(r);
    const icon = r.usable === true ? '✓' : r.usable === false ? '✗' : '?';
    const tag = r.usable === true ? (r.generated ? '可用（居然真出图了）' : '可用') : r.usable === false ? '不可用' : '未知';
    console.log(`  ${icon} ${id.padEnd(40)} ${tag.padEnd(8)} ${r.code} ${r.ms}ms`);
    if (r.usable === false) console.log(`      ${r.message.slice(0, 130)}`);
}

const summary = {
    at: Date.now(),
    baseUrl,
    total: results.length,
    usable: results.filter((r) => r.usable === true).map((r) => r.model),
    unusable: results.filter((r) => r.usable === false).map((r) => r.model),
    unknown: results.filter((r) => r.usable === null).map((r) => r.model),
    results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');

// 同步进 config.json，界面才能把 ✓/✗ 标在模型下拉上（两边共用一份事实）
const cur = loadConfig().modelProbe || {};
for (const r of results) cur[r.model] = { usable: r.usable, code: r.code, status: r.status, at: Date.now() };
saveConfig({ modelProbe: cur });

console.log(`\n可用 ${summary.usable.length} 个 / 不可用 ${summary.unusable.length} 个 / 未知 ${summary.unknown.length} 个`);
console.log(`结果已写入 ${OUT}`);
if (summary.usable.length && summary.unusable.length) {
    console.log('\n结论：同一个模型「带日期」的 ID 可用，不带日期的别名不可用 ——');
    console.log('界面里请选带日期的那一版（模型表的主 ID 就是带日期的）。');
}
