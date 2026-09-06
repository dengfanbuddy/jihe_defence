// 生成知识主题完整内容文档
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_parsed.json', 'utf8'));

let md = '# Cocos Creator MCP — 知识主题内容(发送给模型的领域知识)\n\n';
md += '> 数据来源:运行中的 MCP 服务 `cocos_knowledge(topic:"<主题>")` 返回内容\n\n';

for (const [key, v] of Object.entries(d)) {
  if (!key.startsWith('topic_') || !v.success || !v.data) continue;
  const topicName = key.replace('topic_', '');
  md += `\n---\n\n## 主题: \`${topicName}\`\n\n`;
  md += '```json\n' + JSON.stringify(v.data, null, 2) + '\n```\n\n';
}

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_topics.md', md, 'utf8');
console.log('written, size:', md.length);
