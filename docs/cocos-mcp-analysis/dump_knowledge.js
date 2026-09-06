// 批量抓取 Cocos MCP 知识库提示词:所有工具指南 + 知识主题
const http = require('http');

const BASE = 'http://127.0.0.1:3000/mcp';

function call(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now() + Math.random(), method: 'tools/call', params });
    const req = http.request(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const tools = ['scene', 'node', 'component', 'prefab', 'asset', 'editor', 'view', 'composite', 'validate', 'template', 'capture', 'builder', 'animation', 'spine', 'label'];
  const topics = ['component_properties', 'ui_design_rules', 'layout_patterns', 'widget_strategy', 'node_structure', 'animation_patterns', 'best_practices', 'tool_guide'];

  const fs = require('fs');
  const out = {};

  // 1. 每个工具的 tool_guide
  for (const t of tools) {
    const r = await call({ name: 'cocos_knowledge', arguments: { topic: 'tool_guide', query: t + '.overview' } });
    out['guide_' + t] = r;
    console.log('guide', t, '->', r.length, 'bytes');
  }

  // 2. 每个知识主题(空 query 看返回什么)
  for (const topic of topics) {
    const r = await call({ name: 'cocos_knowledge', arguments: { topic, query: '' } });
    out['topic_' + topic] = r;
    console.log('topic', topic, '->', r.length, 'bytes');
  }

  fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_dump_raw.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('DONE');
})();
