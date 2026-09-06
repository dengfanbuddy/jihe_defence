// 将 action_guides_raw.json 解析为可读的 Markdown 文档
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/action_guides_raw.json', 'utf8'));

let md = '# Cocos Creator MCP — 工具 action 详细指南(发送给模型的知识内容)\n\n';
md += '> 数据来源:运行中的 MCP 服务 `cocos_knowledge(topic:"tool_guide", query:"<tool>.<action>")` 返回内容\n\n';

let total = 0, okCount = 0;
for (const [tool, actions] of Object.entries(d)) {
  const okActions = [];
  const failActions = [];
  for (const [act, raw] of Object.entries(actions)) {
    let inner = null;
    try {
      const j = JSON.parse(raw);
      inner = JSON.parse(j.result.content[0].text);
    } catch (e) {}
    if (inner && inner.success) { okActions.push([act, inner]); okCount++; }
    else failActions.push(act);
    total++;
  }
  if (okActions.length === 0) continue;
  md += `\n---\n\n## \`${tool}\`(${okActions.length} 个 action 指南)\n\n`;
  for (const [act, inner] of okActions) {
    md += `\n### ${tool}.${act}\n\n`;
    if (inner.data && inner.data.desc) md += `**描述**: ${inner.data.desc}\n\n`;
    if (inner.data && inner.data.params) {
      md += `**参数**:\n\n`;
      for (const [pk, pv] of Object.entries(inner.data.params)) {
        const desc = typeof pv === 'object' ? (pv.desc || JSON.stringify(pv)) : pv;
        const dflt = typeof pv === 'object' && pv.default !== undefined ? ` (默认: ${JSON.stringify(pv.default)})` : '';
        md += `- \`${pk}\`: ${desc}${dflt}\n`;
      }
      md += '\n';
    }
    if (inner.data && inner.data.returns) md += `**返回**: ${inner.data.returns}\n\n`;
    if (inner.data && inner.data.example) md += `**示例**: \`\`\`json\n${JSON.stringify(inner.data.example, null, 2)}\n\`\`\`\n\n`;
    if (inner.data && inner.data.notes) md += `**注意事项**: ${inner.data.notes}\n\n`;
    if (inner.message) md += `*${inner.message}*\n\n`;
  }
  if (failActions.length > 0) md += `> 未获取到指南的 action: ${failActions.join(', ')}\n\n`;
}

md += `\n---\n\n> 统计:共 ${total} 个 action 查询,${okCount} 个成功。\n`;

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/action_guides.md', md, 'utf8');
console.log('written, size:', md.length, 'ok:', okCount);
