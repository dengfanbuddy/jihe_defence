// 解析 knowledge_dump_raw.json,提取每个响应的纯文本提示词内容
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_dump_raw.json', 'utf8'));

const out = {};
for (const [key, raw] of Object.entries(d)) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { continue; }
  const contents = parsed.result && parsed.result.content;
  if (!contents) { out[key] = { error: 'no content', raw: raw.slice(0, 300) }; continue; }
  const texts = contents.map(c => c.text || '').join('\n');
  let inner = null;
  try { inner = JSON.parse(texts); } catch (e) { inner = { rawText: texts }; }
  out[key] = inner;
}

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_parsed.json', JSON.stringify(out, null, 2), 'utf8');
console.log('parsed keys:', Object.keys(out).length);

// 打印 tool_guide 的完整内容(这是知识库的"帮助文档",最能说明如何用这个 MCP)
const tg = out['topic_tool_guide'];
console.log('=== topic_tool_guide ===');
console.log(JSON.stringify(tg, null, 2).slice(0, 5500));
