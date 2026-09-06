// 批量抓取所有工具的所有 action 详细指南
const http = require('http');
const fs = require('fs');

const BASE = 'http://127.0.0.1:3000/mcp';
const toolActions = {
  animation: ["query_edit_info","enter_edit","exit_edit","play","pause","resume","stop","change_sample","change_speed","change_wrap_mode","create_prop","remove_prop","create_key","update_key","remove_key","move_keys","copy_keys_to","spacing_keys","clear_keys","modify_curve","add_event","delete_event","update_event","move_events","copy_events_to","remove_node","change_node_path","query_clips_info","query_clip","query_clip_dump","query_value_at_frame","query_properties","query_state","save_clip","create_clip","batch","batch_file","preset_list","preset"],
  scene: ["get_info","list","open","save","create","close","hierarchy","is_ready","is_dirty","snapshot","snapshot_abort","undo_begin","undo_end","undo_cancel","execute_method","execute_script","soft_reload","list_classes","list_components","check_script","find_nodes_by_asset","restore_prefab","query_mode","validate_scene"],
  node: ["find","info","list","tree","create","delete","modify","move","reorder","duplicate","copy","paste","cut","mount_script","remove_script","reset","detect_type","batch_modify"],
  component: ["add","remove","list","info","set_property","available_types","click_event","batch_click_event"],
  prefab: ["list","info","validate","create","delete","instantiate","edit_enter","edit_save","edit_exit","apply","revert"],
  asset: ["query_uuid","find_by_name","search","create","delete","import","list","get_info","update"],
  editor: ["project_info","project_settings","run","stop","build","build_settings","open_build_panel","builder_status","start_preview","stop_preview","console_logs","console_clear","log_read","log_search","log_info","mcp_log_read","mcp_log_clear","editor_info","performance","pref_open","pref_get","pref_set","pref_reset","pref_all","pref_categories","pref_search","pref_export","server_ips","server_port","server_status","server_test","server_interfaces","reload"],
  view: ["gizmo_tool","camera_focus","camera_align_view","camera_align_node","set_2d","set_3d","reference_image","align_node","align_view","viewport_info"],
  composite: ["create_button","create_label","create_image","mount_and_bind","setup_widget","batch","batch_create_button","batch_create_label","batch_create_image"],
  validate: ["layout","references","hierarchy","cleanup","list_rules"],
  template: ["list","apply"],
  capture: ["scene_snapshot","node_snapshot"],
  builder: ["build","preview","validate"],
  spine: ["info","list_animations","list_skins","set_animation","set_skin","set_property","set_data","add_socket","remove_socket"],
  label: ["info","list","set_text","set_font","set_style","set_outline","set_shadow","batch_set_font","batch_set_style"],
  server: ["info","status","config","test","logs"]
};

function call(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now() + Math.random(), method: 'tools/call', params: { name, arguments: args } });
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
  const out = {};
  let total = 0, ok = 0;
  for (const [tool, actions] of Object.entries(toolActions)) {
    out[tool] = {};
    for (const act of actions) {
      total++;
      const r = await call('cocos_knowledge', { topic: 'tool_guide', query: tool + '.' + act });
      out[tool][act] = r;
      try {
        const j = JSON.parse(r);
        const inner = JSON.parse(j.result.content[0].text);
        if (inner.success) ok++;
      } catch (e) {}
      await new Promise(res => setTimeout(res, 30));
    }
    console.log(tool, 'done');
  }
  fs.writeFileSync('D:/Project/cocos/jihe_defence/docs/cocos-mcp-analysis/action_guides_raw.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('TOTAL:', total, 'OK:', ok);
})();
