// 生成 Cocos Creator MCP 完整工具定义文档 (Markdown)
const fs = require('fs');

const raw = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/tools_list_raw.json', 'utf8'));
const tools = raw.result.tools;

function json2md(obj, indent) {
  return JSON.stringify(obj, null, 2)
    .split('\n')
    .map(l => '    ' + l)
    .join('\n');
}

let md = '';
md += '# Cocos Creator MCP — 完整工具定义\n\n';
md += `> 来源:运行中的 MCP 服务 \`POST /mcp\` → \`tools/list\`(streamable HTTP, JSON-RPC)\n\n`;
md += `> 工具总数: **${tools.length}** 个 | 服务地址: \`http://127.0.0.1:3000/mcp\`\n\n`;

md += `## 工具清单\n\n| # | 工具名 | 作用域 |\n|---|--------|--------|\n`;
const scopeMap = {
  cocos_scene: '场景', cocos_node: '节点', cocos_component: '组件', cocos_prefab: '预制体',
  cocos_asset: '资源', cocos_editor: '编辑器', cocos_view: '视口', cocos_composite: '复合UI',
  cocos_knowledge: '知识库', cocos_validate: '校验', cocos_template: '模板', cocos_capture: '快照',
  cocos_builder: 'JSON建树', cocos_animation: '动画', cocos_spine: 'Spine', cocos_label: '文本',
  cocos_devtools: '开发者工具'
};
tools.forEach((t, i) => { md += `| ${i + 1} | \`${t.name}\` | ${scopeMap[t.name] || '-'} |\n`; });

for (const t of tools) {
  md += `\n---\n\n## \`${t.name}\`\n\n`;
  md += `### 发送给模型的描述 (description)\n\n> ${t.description.replace(/\n/g, '\n> ')}\n\n`;
  md += `### 参数 Schema (inputSchema)\n\n\`\`\`json\n${json2md(t.inputSchema, 4)}\n\`\`\`\n\n`;
}

fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/tools_definition.md', md, 'utf8');
console.log('written, size:', md.length);
