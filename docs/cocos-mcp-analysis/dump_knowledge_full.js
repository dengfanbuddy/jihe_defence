// 用权威枚举重新抓取知识库 tool_guide 全部 action 指南,补全缺失部分
const http = require('http');
const fs = require('fs');

const BASE = 'http://127.0.0.1:3000/mcp';
// 知识库内部工具名(不带 cocos_ 前缀),与 action 枚举映射
const kbToolMap = {
  cocos_scene: 'scene', cocos_node: 'node', cocos_component: 'component', cocos_prefab: 'prefab',
  cocos_asset: 'asset', cocos_editor: 'editor', cocos_view: 'view', cocos_composite: 'composite',
  cocos_validate: 'validate', cocos_template: 'template', cocos_capture: 'capture',
  cocos_builder: 'builder', cocos_animation: 'animation', cocos_spine: 'spine', cocos_label: 'label'
};
const enumData = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/actions_enum.json', 'utf8'));

function callTool(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now() + Math.random(), method: 'tools/call', params: { name, arguments: args } });
    const req = http.request(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', e => resolve(JSON.stringify({ error: e.message })));
    req.setTimeout(12000, () => { req.destroy(); resolve(JSON.stringify({ error: 'timeout' })); });
    req.write(body);
    req.end();
  });
}

(async () => {
  const out = {};
  let total = 0, ok = 0, missing = 0;
  for (const [tool, actions] of Object.entries(enumData)) {
    const kbName = kbToolMap[tool];
    if (!kbName) continue;
    out[tool] = {};
    for (const action of actions) {
      total++;
      const raw = await callTool('cocos_knowledge', { topic: 'tool_guide', query: kbName + '.' + action });
      let inner = null;
      try { inner = JSON.parse(JSON.parse(raw).result.content[0].text); } catch (e) {}
      if (inner && inner.success) { ok++; out[tool][action] = inner.data; }
      else {
        missing++;
        // 尝试仅工具名查询(可能返回该工具全部指南)
        if (!out[tool]['__tool__']) {
          const raw2 = await callTool('cocos_knowledge', { topic: 'tool_guide', query: kbName });
          try { const i2 = JSON.parse(JSON.parse(raw2).result.content[0].text); if (i2.success) out[tool]['__tool__'] = i2.data; } catch (e) {}
        }
      }
      await new Promise(res => setTimeout(res, 20));
    }
    console.log(tool + ' done, ok=' + ok);
  }
  fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/knowledge_full_raw.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('TOTAL:', total, 'OK:', ok, 'MISSING:', missing);
})();
