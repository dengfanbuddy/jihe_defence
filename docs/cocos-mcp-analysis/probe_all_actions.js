// 对 Cocos MCP 全部 action 做实测调用,收集每个请求返回的提示词
// 策略:传最小/无效参数,让服务返回 usage/instruction/warning 提示词(避免真实副作用)
const http = require('http');
const fs = require('fs');

const BASE = 'http://127.0.0.1:3000/mcp';
const enumData = JSON.parse(fs.readFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/actions_enum.json', 'utf8'));

// 每个 action 的安全测试参数:优先用无效值触发失败/提示路径
const SAFE_ARGS = {
  // 通用:节点类工具用不存在的节点
  node: '__MCP_TEST_NONEXISTENT_NODE__',
  name: '__MCP_TEST_NONEXISTENT__',
  parent: '__MCP_TEST_NONEXISTENT__',
  nodeUuid: '00000000-0000-0000-0000-000000000000',
  prefabPath: 'db://assets/__mcp_test_nonexistent__.prefab',
  url: 'db://assets/__mcp_test_nonexistent__.png',
  uuid: '00000000-0000-0000-0000-000000000000',
  scenePath: 'db://assets/__mcp_test_nonexistent__.scene',
  savePath: 'db://assets/__mcp_test_nonexistent_dir__/',
  source: 'db://assets/__mcp_test_nonexistent__.png',
  target: 'db://assets/__mcp_test_nonexistent_target__.png',
  template: '__mcp_test_nonexistent__',
  scriptPath: 'db://assets/__mcp_test_nonexistent__.ts',
  imagePath: 'db://assets/__mcp_test_nonexistent__.png',
  font: 'db://assets/__mcp_test_nonexistent__.ttf',
  clipUuid: '00000000-0000-0000-0000-000000000000',
  clipName: '__MCP_TEST_NONEXISTENT__',
  folder: 'db://assets/__mcp_test_nonexistent_dir__',
  category: 'general',
  topic: 'tool_guide',
  query: 'scene.hierarchy',
  // devtools
  componentType: 'cc.Label',
  version: '3.8',
};

// 已知有副作用的 action:跳过(不做真实调用),避免改动用户项目
const SKIP_ACTIONS = {
  cocos_scene: ['save'],               // 真实保存当前场景
  cocos_editor: ['reload'],            // 重载编辑器
  cocos_asset: ['delete', 'create'],   // 真实增删资源(create 传无效路径也会尝试)
  cocos_prefab: ['delete'],            // 真实删除
  cocos_node: ['delete', 'create', 'duplicate', 'paste', 'cut', 'move', 'modify', 'reorder', 'batch_modify', 'mount_script', 'remove_script', 'reset'],
  cocos_component: ['add', 'remove', 'set_property', 'click_event', 'batch_click_event'],
  cocos_animation: ['save_clip', 'create_clip', 'batch', 'batch_file', 'preset', 'add_event', 'create_key', 'update_key', 'remove_key', 'move_keys', 'copy_keys_to', 'spacing_keys', 'clear_keys', 'modify_curve', 'delete_event', 'update_event', 'move_events', 'copy_events_to', 'remove_node', 'create_prop', 'remove_prop', 'enter_edit', 'exit_edit'],
  cocos_spine: ['set_animation', 'set_skin', 'set_property', 'set_data', 'add_socket', 'remove_socket'],
  cocos_label: ['set_text', 'set_font', 'set_style', 'set_outline', 'set_shadow', 'batch_set_font', 'batch_set_style'],
  cocos_view: ['reference_image', 'align_node', 'align_view', 'set_2d', 'set_3d', 'gizmo_tool'],
  cocos_composite: ['create_button', 'create_label', 'create_image', 'mount_and_bind', 'setup_widget', 'batch', 'batch_create_button', 'batch_create_label', 'batch_create_image'],
  cocos_template: ['apply'],
  cocos_builder: ['build'],
  cocos_validate: ['cleanup'],
};

// 只读 action:空参调用也安全,能看到成功返回
const READONLY_PATTERN = /^(get_info|list|info|hierarchy|tree|find|search|query|is_ready|is_dirty|available|show|preview|validate|snapshot|check|detect|list_classes|list_components|list_animations|list_skins|editor_info|project_info|project_settings|build_settings|builder_status|server_|log_|console_|performance|pref_|query_|preset_list|explore|research)/;

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

function buildArgs(tool, action) {
  const skip = SKIP_ACTIONS[tool] || [];
  if (skip.includes(action)) return null; // 跳过
  const args = { action };
  // 只读类空参即可;其余补无效参数
  if (!READONLY_PATTERN.test(action)) {
    for (const [k, v] of Object.entries(SAFE_ARGS)) {
      if (args[k] === undefined) args[k] = v;
      if (Object.keys(args).length >= 4) break;
    }
  }
  return args;
}

(async () => {
  const results = {};   // tool -> {action: {status, args, raw, parsed}}
  let total = 0, called = 0, skipped = 0;
  for (const [tool, actions] of Object.entries(enumData)) {
    results[tool] = {};
    for (const action of actions) {
      total++;
      const args = buildArgs(tool, action);
      if (args === null) {
        skipped++;
        results[tool][action] = { status: 'skipped', reason: '写操作,避免副作用,未调用' };
        continue;
      }
      const raw = await callTool(tool, args);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw }; }
      // 提取内层 text
      let inner = null;
      try {
        const texts = parsed.result.content.map(c => c.text || '').join('');
        inner = JSON.parse(texts);
      } catch (e) { inner = texts ? { rawText: texts.slice(0, 200) } : null; }
      results[tool][action] = { status: inner && inner.success ? 'success' : 'error', args, inner };
      called++;
      console.log(tool + '.' + action + ' -> ' + (inner ? (inner.success ? 'OK' : 'ERR:' + (inner.error || '').slice(0, 40)) : 'PARSE_FAIL'));
      await new Promise(res => setTimeout(res, 25));
    }
  }
  // 知识库 8 主题
  const topics = ['component_properties', 'ui_design_rules', 'layout_patterns', 'widget_strategy', 'node_structure', 'animation_patterns', 'best_practices', 'tool_guide'];
  results['__knowledge_topics__'] = {};
  for (const topic of topics) {
    const raw = await callTool('cocos_knowledge', { topic });
    let inner = null;
    try { inner = JSON.parse(JSON.parse(raw).result.content[0].text); } catch (e) {}
    results['__knowledge_topics__'][topic] = { status: inner && inner.success ? 'success' : 'error', inner };
    console.log('knowledge.' + topic + ' -> ' + (inner && inner.success ? 'OK' : 'ERR'));
    await new Promise(res => setTimeout(res, 25));
  }

  fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/probe_results_raw.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('TOTAL:', total, 'CALLED:', called, 'SKIPPED:', skipped);
})();
