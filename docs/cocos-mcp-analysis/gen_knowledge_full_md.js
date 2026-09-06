// 生成知识库全量内容文档(200 个 action 指南 + 工具级指南)
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_full_raw.json', 'utf8'));

let md = '# Cocos Creator MCP — 知识库全量内容(tool_guide)\n\n';
md += '> 抓取方式: `cocos_knowledge(topic:"tool_guide", query:"<kb_tool>.<action>")` 对全部枚举 action 实测抓取\n';
md += '> 统计: 共 222 个查询,成功 **200** 个 action 指南,缺失 22 个(服务端无该 action 指南)\n\n';

let total = 0;
for (const [tool, actions] of Object.entries(d)) {
  const guideEntries = Object.entries(actions).filter(([k]) => !k.startsWith('__'));
  const toolGuide = actions['__tool__'];
  if (guideEntries.length === 0 && !toolGuide) continue;
  md += `\n---\n\n## \`${tool}\`(${guideEntries.length} 个 action 指南)\n\n`;
  if (toolGuide) {
    md += `### 工具级指南\n\n`;
    if (toolGuide.desc) md += `**描述**: ${toolGuide.desc}\n\n`;
    if (toolGuide.actions) {
      md += `**Action 概览**: ${Object.keys(toolGuide.actions).join(', ')}\n\n`;
    }
  }
  for (const [action, g] of guideEntries) {
    total++;
    md += `\n### ${tool}.${action}\n\n`;
    if (g.desc) md += `**描述**: ${g.desc}\n\n`;
    if (g.params) {
      md += `**参数**:\n\n`;
      for (const [pk, pv] of Object.entries(g.params)) {
        const desc = typeof pv === 'object' ? (pv.desc || JSON.stringify(pv)) : pv;
        const dflt = typeof pv === 'object' && pv.default !== undefined ? ` (默认: ${JSON.stringify(pv.default)})` : '';
        const type = typeof pv === 'object' && pv.type ? ` (\`${pv.type}\`)` : '';
        md += `- \`${pk}\`: ${desc}${type}${dflt}\n`;
      }
      md += '\n';
    }
    if (g.returns) md += `**返回**: ${g.returns}\n\n`;
    if (g.example) md += `**示例**:\n\n\`\`\`json\n${JSON.stringify(g.example, null, 2)}\n\`\`\`\n\n`;
    if (g.notes) md += `**注意事项**: ${Array.isArray(g.notes) ? g.notes.map(n => '\n- ' + n).join('') : g.notes}\n\n`;
  }
}

md += `\n---\n\n> 共 ${total} 个 action 指南。缺失的 22 个 action 指南(服务端无数据): ${getMissingList(d)}\n`;

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_full.md', md, 'utf8');
console.log('written, size:', md.length, 'guides:', total);

function getMissingList(d) {
  const miss = [];
  for (const [tool, actions] of Object.entries(d)) {
    // 需要对照枚举找出缺失——这里简单列出无指南的 action
    for (const [k, v] of Object.entries(actions)) {
      if (!k.startsWith('__') && (!v || !v.desc)) miss.push(tool + '.' + k);
    }
  }
  return miss.join(', ') || '无';
}
