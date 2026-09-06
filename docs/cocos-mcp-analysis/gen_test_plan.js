// 生成测试清单 + 每个 action 返回提示词文档
const fs = require('fs');
const results = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/probe_results_raw.json', 'utf8'));
const enumData = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/actions_enum.json', 'utf8'));

const toolCN = {
  cocos_scene: '场景', cocos_node: '节点', cocos_component: '组件', cocos_prefab: '预制体',
  cocos_asset: '资源', cocos_editor: '编辑器', cocos_view: '视口', cocos_composite: '复合UI',
  cocos_knowledge: '知识库', cocos_validate: '校验', cocos_template: '模板', cocos_capture: '快照',
  cocos_builder: 'JSON建树', cocos_animation: '动画', cocos_spine: 'Spine', cocos_label: '文本',
  cocos_devtools: '开发者工具'
};

let md = '# Cocos Creator MCP — 全操作测试清单与返回提示词\n\n';
md += `> 测试日期:2026-08-05 | 服务: http://127.0.0.1:3000/mcp | 方式: 每个 action 以最小/无效参数实测调用,记录返回提示词\n`;
md += `> 统计: 枚举 action 共 **236** 个,实测 **166** 个,跳过写操作 **70** 个(避免改动项目)\n\n`;

let mdAll = '';
let summary = '| 工具 | 枚举 | 实测 | 成功 | 缺参/报错 | 跳过 |\n|------|------|------|------|----------|------|\n';

for (const [tool, actions] of Object.entries(enumData)) {
  const res = results[tool] || {};
  let ok = 0, err = 0, skip = 0;
  const rows = [];
  for (const action of actions) {
    const r = res[action];
    if (!r) { rows.push(`| \`${action}\` | 未测试 | - | - |`); continue; }
    if (r.status === 'skipped') { skip++; rows.push(`| \`${action}\` | ⏭️ 跳过(写操作) | - | 避免副作用 |`); continue; }
    const inner = r.inner;
    if (inner && inner.success) { ok++; rows.push(`| \`${action}\` | ✅ 成功 | ${inner.data ? (JSON.stringify(inner.data).length > 60 ? '有返回数据' : '`' + JSON.stringify(inner.data).slice(0, 60) + '`') : '-'} | ${(inner.message || '').slice(0, 40)} |`); continue; }
    err++;
    const errMsg = inner && inner.error ? String(inner.error).slice(0, 80) : '解析失败';
    const instr = inner && inner.instruction ? String(inner.instruction).slice(0, 100) : '';
    rows.push(`| \`${action}\` | ❌ ${errMsg} | ${instr} | - |`);
  }
  summary += `| ${toolCN[tool] || tool} \`${tool}\` | ${actions.length} | ${actions.length - skip} | ${ok} | ${err} | ${skip} |\n`;

  mdAll += `\n---\n\n## \`${tool}\`(${toolCN[tool] || tool})\n\n`;
  mdAll += `**描述**: ${getToolDesc(tool)}\n\n`;
  mdAll += `**Action 列表与测试结果**:\n\n`;
  mdAll += `| Action | 结果 | 返回要点 | 提示词(instruction/message) |\n|--------|------|----------|------------------------------|\n`;
  for (const row of rows) mdAll += row + '\n';
}

md += `## 汇总统计\n\n${summary}\n`;
md += `\n> 说明: 测试使用无效参数(不存在的节点/路径),因此大多数返回错误 + usage 引导提示词,这正是服务给模型看的"提示词"。成功项为只读查询。\n`;
md += mdAll;

// ===== 附录A: 每个 action 的完整返回提示词(instruction/warning/error) =====
md += `\n\n---\n\n# 附录 A: 每个 action 请求的完整返回提示词\n\n`;
md += `> 从 probe_results_raw.json 提取,包含 success/data/error/instruction/warning/project 全字段\n\n`;
for (const [tool, actions] of Object.entries(enumData)) {
  const res = results[tool] || {};
  let hasAny = false;
  for (const action of actions) {
    const r = res[action];
    if (!r || r.status === 'skipped' || !r.inner) continue;
    const inner = r.inner;
    if (!inner.success && (!inner.instruction && !inner.warning && !inner.error)) continue;
    if (!hasAny) { md += `\n## \`${tool}\`\n\n`; hasAny = true; }
    md += `\n### ${tool}.${action} — ${inner.success ? '✅ 成功' : '❌ 失败'}\n\n`;
    const fields = [];
    if (inner.success && inner.data) fields.push(['data', inner.data]);
    if (inner.error) fields.push(['error', inner.error]);
    if (inner.message) fields.push(['message', inner.message]);
    if (inner.instruction) fields.push(['instruction', inner.instruction]);
    if (inner.warning) fields.push(['warning', inner.warning]);
    for (const [k, v] of fields) {
      md += `**${k}**: ` + (typeof v === 'string' ? `> ${v.replace(/\n/g, '\n> ')}\n\n` : '```json\n' + JSON.stringify(v, null, 2) + '\n```\n\n');
    }
  }
}

// ===== 附录B: 知识库主题 =====
md += `\n---\n\n# 附录 B: 知识库主题实测返回\n\n`;
const kt = results['__knowledge_topics__'] || {};
for (const [topic, r] of Object.entries(kt)) {
  md += `\n## \`${topic}\`\n\n`;
  if (r.inner && r.inner.success && r.inner.data) {
    md += '```json\n' + JSON.stringify(r.inner.data, null, 2) + '\n```\n\n';
  } else {
    md += `> 返回: ${JSON.stringify(r.inner || {}).slice(0, 200)}\n\n`;
  }
}

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/test_plan_and_prompts.md', md, 'utf8');
console.log('written, size:', md.length);

function getToolDesc(tool) {
  try {
    const d = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/tools_list_raw.json', 'utf8'));
    const t = d.result.tools.find(x => x.name === tool);
    return t ? t.description.split('\n')[0] : '';
  } catch (e) { return ''; }
}
