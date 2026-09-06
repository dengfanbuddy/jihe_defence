# Cocos Creator MCP v1.7.5 — 完整逆向分析与提示词整理

> 分析日期:2026-08-05 | 服务地址:`http://127.0.0.1:3000/mcp`(streamable HTTP, JSON-RPC 2.0)
> 数据来源:运行中服务的 `tools/list` + `tools/call` 实测抓取,以及 `extensions/cocos-mcp-v1.7.5-all` 源码目录结构分析

---

## 一、总览

| 项目 | 内容 |
|------|------|
| 工具数量 | **17 个**正式注册工具(`cocos_*` 前缀) |
| 隐藏工具 | `cocos_do`(意图路由器,当前配置中禁用,源码存在于 `tools/cocos/handlers/do-handler.js`) |
| 协议 | MCP streamable HTTP,只实现 `tools/list` + `tools/call`(**无** `prompts/list`、`resources/list`,实测返回 `Unknown method`) |
| 认证 | 商业版带授权验证(`auth/license-manager.js`,serverUrl `https://mcp.xman88.com`),本机已激活 |
| 源码保护 | 全部 JS 经过 **javascript-obfuscator 字符串数组 + RC4 变体加密**(`_0x1b1d92` 式解码器),`clean/`、`clean-v4/`、`dist/` 均为混淆态 |
| 已反混淆 | `deobfuscated/` 目录含 `ARCHITECTURE.md` + 每文件 decoded-strings 分析 |

---

## 二、协议与调用约定

### 2.1 请求格式(POST /mcp)

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "cocos_scene", "arguments": { "action": "hierarchy" } } }
```

Headers:`Content-Type: application/json`,`Accept: application/json, text/event-stream`

### 2.2 统一响应结构(所有工具)

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "content": [ { "type": "text", "text": "{...}" } ] } }
```

`text` 内是内层 JSON,统一包含:

| 字段 | 含义 |
|------|------|
| `success` | bool,调用是否成功 |
| `data` / `result` | 成功时的返回数据 |
| `error` | 失败原因 |
| `instruction` | **给模型的引导提示词**(错误时告诉模型该用什么 action / 怎么查文档) |
| `warning` | **固定安全提示词**(见下) |
| `project` | 当前 Cocos Creator 项目路径 |

### 2.3 全局安全提示词(每个响应都附带)

```
⚠️ NEVER directly edit .scene/.prefab/.anim/.meta files with file-writing tools.
Always use cocos_* MCP tools. If unsure, call cocos_do(intent:"your goal").
```

这是 MCP 层最强的约束:禁止用文件工具直接改场景/预制体/动画资源,必须走 `cocos_*` 工具。

### 2.4 错误引导提示词模板

```
Usage: cocos_<tool>(action:<valid_action>, ...params).
Tip: Use cocos_knowledge(topic:"tool_guide", query:"<tool>") to view detailed
parameter definitions, value formats, and examples.
```

即:报错时附带该工具全部合法 action 列表 + 指引模型去查知识库。

---

## 三、17 个正式工具清单(发送给模型的定义)

完整定义(含每个参数的描述)见 **`tools_definition.md`**,这里列摘要:

| # | 工具 | 一句话描述 | 主要 actions |
|---|------|-----------|-------------|
| 1 | `cocos_scene` | 场景管理:打开/保存/创建/层级/撤销 | `get_info, open, save, create, hierarchy, validate_scene, execute_script, undo_*` |
| 2 | `cocos_node` | 节点 CRUD + 变换 + 脚本挂载 + 批量 | `find, info, tree, create, modify, batch_modify, mount_script, remove_script` |
| 3 | `cocos_component` | 组件增删改查 + 点击事件绑定 | `add, remove, info, set_property, click_event, batch_click_event` |
| 4 | `cocos_prefab` | 预制体全生命周期 | `instantiate, create, delete, apply, edit_enter/save/exit` |
| 5 | `cocos_asset` | 资源查询/创建/删除/路径-UUID 互转 | `query_uuid, find_by_name, search, create, delete` |
| 6 | `cocos_editor` | 编辑器工具:项目信息/控制台/构建/预览 | `project_info, console_logs, build, run, stop, pref_*, server_*, reload` |
| 7 | `cocos_view` | 视口控制:gizmo/相机/参考图 | `gizmo_tool, camera_focus, camera_align_view, camera_align_node` |
| 8 | `cocos_composite` | 一键创建完整 UI 控件 + 脚本绑定 | `create_button, create_label, create_image, mount_and_bind, setup_widget, batch_*` |
| 9 | `cocos_knowledge` | **知识库查询**(提示词核心,见第五节) | `component_properties, ui_design_rules, layout_patterns, widget_strategy, node_structure, animation_patterns, best_practices, tool_guide` |
| 10 | `cocos_validate` | 深度校验:布局重叠/离屏/引用/层级 | `layout, references, hierarchy` |
| 11 | `cocos_template` | 应用预置 UI 模板 | `list, apply` (dialog/scroll_list/nav_bar/settings_page) |
| 12 | `cocos_capture` | 场景结构化快照 JSON | `scene_snapshot, node_snapshot` |
| 13 | `cocos_builder` | 用 JSON 树一次构建完整层级 | `build` |
| 14 | `cocos_animation` | 动画剪辑/关键帧/事件/预设 | `query_edit_info, batch, batch_file, preset, add_event, create_key` 等 39 个 |
| 15 | `cocos_spine` | Spine 骨骼动画管理 | `info, list_animations, set_animation, set_skin, set_data, add_socket` |
| 16 | `cocos_label` | 文本/富文本/输入框 | `set_text, set_font, set_style, set_outline, set_shadow, batch_*` |
| 17 | `cocos_devtools` | 开发者专用:组件研究/知识沉淀 | `research_component, explore_component, auto_knowledge, promote_knowledge, message_log_*` |

---

## 四、核心设计:每个工具 = action 路由 + 统一参数

所有工具都是**单入口 action 路由**模式:

```
tools/call(name: "cocos_xxx", arguments: { action: "<action>", ...其余参数 })
```

- `action` 为必填枚举参数
- 描述中明确写出**命名冲突规避**(如 `cocos_node` 用 `info` 而非 `get_info`、`remove_script` 而非 `component.remove`)
- 描述中**批量提示**:3+ 节点用 `batch_modify`、3+ 按钮用 `batch_create_button` 等(引导模型减少调用次数)
- 描述中带 **JSON 示例**:`Example: {action:"list"}`

### 4.1 关键约定(写在描述里的模型引导)

| 工具 | 描述中的关键引导 |
|------|-----------------|
| `cocos_node` | "⚡ BATCH: 3+ 节点修改用 batch_modify,更快且原子" |
| `cocos_component` | "⚡ BATCH: 3+ 点击事件用 batch_click_event";"删脚本用 cocos_node(action:remove_script)" |
| `cocos_prefab` | "所有预制体操作(含 delete)在这里,NOT cocos_asset" |
| `cocos_builder` | "建复杂多层 UI 用本工具 NOT composite/node;控件用 type:'Button' 快捷方式" |
| `cocos_template` | "标准 UI 模式用本工具 NOT composite/builder" |
| `cocos_capture` | "需要位置/尺寸/组件数据做布局分析时用本工具 NOT hierarchy" |
| `cocos_knowledge` | "用陌生工具前先查 tool_guide" |
| `cocos_validate` | "深度检查用本工具 NOT scene.validate_scene" |

---

## 五、知识库系统(提示词的核心载体)

`cocos_knowledge` 是本 MCP 的**知识注入系统**,8 个主题,全部内容见 **`knowledge_topics.md`**。

### 5.1 主题清单

| 主题 | 内容 | 大小 |
|------|------|------|
| `component_properties` | 67 种组件类型索引(cc.Label/sp.Skeleton 等) | 2.8KB |
| `ui_design_rules` | 坐标系(Canvas 中心原点)、包围盒计算、触摸目标 44px、字号规范、间距 8 倍数、安全区 | 1.8KB |
| `layout_patterns` | 布局模式索引 | 0.7KB |
| `widget_strategy` | Widget 响应式策略:全屏背景/居中弹窗/顶栏/底栏/安全区 | 0.9KB |
| `node_structure` | 节点结构规范 | 0.6KB |
| `animation_patterns` | 动画模式索引 | 0.8KB |
| `best_practices` | 最佳实践 | 0.7KB |
| `tool_guide` | **工具使用指南**(13 个工具 × 全部 action 的参数/示例/注意事项) | 5.3KB |

### 5.2 tool_guide 查询方式(给模型的文档系统)

```
cocos_knowledge(topic: "tool_guide", query: "<tool>.<action>")
```

返回该 action 的:描述(desc)、参数(params 含默认值)、返回(returns)、示例(example)、注意事项(notes)。
已抓取 **196 个 action 查询,157 个成功**,完整内容见 **`action_guides.md`**(73KB)。

示例(`scene.hierarchy` 返回):

```json
{ "success": true, "data": {
    "desc": "Get full scene hierarchy tree",
    "params": { "includeComponents": { "type": "boolean", "desc": "Include component details", "default": false } },
    "returns": "Full node tree with optional component info",
    "example": { "input": { "action": "hierarchy", "includeComponents": true } } },
  "message": "Guide for scene.hierarchy: ..." }
```

### 5.3 知识库数据在源码中的位置

`clean/tools/cocos/data/tool-guides/` 下 14 个混淆的 guide 文件(`scene-guide.js` 29KB、`animation-guide.js` 100KB、`component-guide.js` 98KB、`composite-guide.js` 71KB、`builder-guide.js` 76KB…),运行时解码后即为上述返回内容。

---

## 六、隐藏工具 `cocos_do`(意图路由器)

源码位置:`clean/tools/cocos/handlers/do-handler.js`(混淆态,但描述可解出):

```
Universal intent router for Cocos Creator. Describe your goal in natural language,
auto-routes to the correct cocos_* tool.
Two modes: (1) Execute mode (default): describe intent, auto-route.
(2) Plan mode: mode:"plan" to get a step-by-step plan.
USE THIS TOOL if you are unsure which cocos_* tool to call.
⚠️ NEVER directly edit .scene/.prefab/.anim/.meta files — this tool will guide you.
```

- 参数:`intent`(自然语言目标,必填)、`mode`(`execute`/`plan`)、`params`
- **内置意图路由表**(中文关键词 + 英文关键词 → tool/action/paramKeys),已从代码中解出约 28 条规则,例如:

| 关键词(中/英) | 路由到 |
|---------------|--------|
| 创建节点 / create node / add node | `node.create` (params: name, parent, type, ...) |
| 删除节点 / delete node / remove node | `node.delete` (node) |
| 移动节点 / move node / reparent | `node.move` (node, targetParent, position) |
| 查找节点 / find node / search node | `node.find` (name, ...) |
| 节点树 / hierarchy | `node.tree` (node, maxDepth) |
| 节点信息 / node info | `node.info` (node) |
| 添加组件 / add component | `component.add` (node, componentType) |
| 移除组件 / remove component | `component.remove` (node, componentType) |
| 设置属性 / set property | `component.set_property` (node, component, property, value) |
| 组件列表 / list components | `component.list` (node) |
| 打开场景 / open scene | `scene.open` (scenePath) |
| 保存场景 / save scene | `scene.save` |
| 场景信息 / scene info | `scene.info` |
| 创建预制体 / create prefab | `prefab.create_from_node` (node, savePath) |
| 实例化预制体 / instantiate prefab | `prefab.instantiate` (prefabPath, name) |
| 创建动画 / create clip | `animation.create_clip` |
| 设置关键帧 / set keyframe | `animation.set_keyframe` |
| 动画信息 / animation info | `animation.info` (node) |
| 查询资源 / find asset / query asset | `asset.query_uuid` (path, uuid, type) |
| 创建按钮 / create button | `composite.create_button` (parent, name, fontSize, size) |
| 创建文本 / create text | `composite.create_label` (parent, name, text, fontSize) |
| 创建图片 / create sprite | `composite.create_image` (parent, name, spriteFrame, size) |
| 设置 Widget / set widget | `composite.setup_widget` (node, align) |
| 截图 / screenshot / 场景快照 | `capture.scene_snapshot` |
| 构建 / compile / 编译 | `editor.build` (platform, path) |
| ... | ... |

- **危险操作拦截**:内置正则 `/edit|write|modify|change|update|delete|remove|创建|编辑|写入|修改|删除|更新|覆盖|替换|保存/i`,若 intent 命中且目标涉及受保护文件,则返回拒绝 + 提示改用 cocos_* 工具(配合 `file-guard.js` 文件保护器)。

> 注意:当前安装配置中 `cocos_do` 未注册(禁用),实测调用返回 `Unknown cocos tool: do`。

---

## 七、源码架构(供自研参考)

```
extensions/cocos-mcp-v1.7.5-all/
├── dist/                       # 发布版(混淆)
├── clean/ clean-v4/            # 反混淆尝试产物(仍是混淆态)
├── deobfuscated/               # 反混淆分析:ARCHITECTURE.md + decoded-strings.json + *.analysis.json
├── package.json                # 扩展入口 main: dist/main.js,面板 panels/default
└── clean/tools/cocos/
    ├── cocos-tools.js          # CocosTools 主类
    ├── data/tool-guides/       # 知识库 guide 数据(混淆的 14 个 JS 文件)
    ├── handlers/               # 每个工具的 handler
    │   ├── animation-handler.js / animation-file-writer.js / animation-presets.js
    │   ├── asset-handler.js / builder-handler.js / capture-handler.js
    │   ├── component-handler.js / composite-handler.js / devtools-handler.js
    │   ├── do-handler.js       # cocos_do 意图路由
    │   └── scene-handler.js 等
    └── utils/                  # node-resolver(节点解析) / file-guard(文件保护)
        ├── component-knowledge.js  # 组件知识
        ├── editor-mode.js          # 编辑器模式检测
        └── message-recorder.js     # 消息记录(devtools)
```

**架构特点**:
1. 扩展在 Cocos Creator 编辑器内运行(`package.json` contributions.scene 挂载场景脚本)
2. `MCPServer` 类是 HTTP 服务器,把 MCP JSON-RPC 请求转发给内部工具
3. 工具 → 编辑器底层通过 `Editor.Message.request()` 调用场景/资源管线
4. 每个工具类实现 `getToolDefinition()`(返回 name/description/inputSchema)+ `execute(args)`(返回 success/data/error/instruction/warning)
5. 授权:启动时校验 license(device-identity 机器指纹 + RSA 签名),未激活时拒绝服务

### 7.1 工具指南模块结构(`data/tool-guides/index.js`)

从混淆代码可解出的导出接口(即知识库 `tool_guide` 主题的实现):

| 导出 | 作用 |
|------|------|
| `getToolOverview()` | 返回全部 13 个工具的 `{tool: {desc, actions[]}}` 概览(即 `topic:"tool_guide"` 无 query 时返回的完整索引) |
| `getToolGuide(tool)` | 返回某工具的 `{desc, actions: {action: {desc, params{...}, returns, example}}}` 全量指南 |
| `getActionGuide(tool, action)` | 返回单个 action 的指南(即 `query:"<tool>.<action>"` 时返回的内容) |
| `getToolNames()` | 全部工具名列表 |

13 个 guide 模块:`scene-guide / node-guide / component-guide / prefab-guide / asset-guide / editor-guide / view-guide / composite-guide / validate-guide / template-guide / capture-guide / builder-guide / animation-guide`。
每个模块导出 `<name>Guide` 对象,含 `desc` + `actions`(每个 action: `desc/params/returns/example/notes`)。

---

## 八、自研 MCP 实现建议

基于以上分析,一个最小可用的 Cocos Creator MCP 需要:

1. **传输层**:Node.js 实现 streamable HTTP(或 stdio),只实现 `tools/list`、`tools/call` 即可(客户端按 tools 工作,无需 prompts/resources)
2. **工具层**:每个工具 = `{name, description, inputSchema, execute(args)}`,用 `action` 枚举路由
3. **描述写法要点**(直接影响模型表现):
   - 写清 action 枚举 + 参数 + JSON 示例
   - 写清工具边界(哪些操作归哪个工具)
   - 批量提示(3+ 用 batch_*)减少调用
   - 命名冲突规避说明
4. **知识库层**:`cocos_knowledge` 工具 + guide 数据文件,模型不确定时先查文档再动手(这是本 MCP 表现好的关键)
5. **安全层**:文件保护(file-guard)——禁止直接编辑 .scene/.prefab/.anim/.meta,统一走工具
6. **编辑器通信**:通过 `Editor.Message.request('scene', 'query-node', ...)` 等编辑器 API 与场景交互(需在 Creator 扩展环境内运行)

---

## 九、附件文件清单

| 文件 | 内容 |
|------|------|
| `tools_definition.md` | 17 个工具的完整 description + inputSchema(52KB) |
| `action_guides.md` | 157 个 action 详细指南(73KB) |
| `knowledge_full.md` | **知识库全量内容**:200 个 action 指南 + 工具级指南(79KB,推荐看这份) |
| `knowledge_topics.md` | 8 个知识主题全文(10.7KB) |
| `test_plan_and_prompts.md` | **全操作测试清单 + 每个 action 返回提示词(395KB)** |
| `tools_list_raw.json` | tools/list 原始响应(34KB) |
| `actions_enum.json` | 17 工具 × 236 个 action 枚举清单 |
| `knowledge_dump_raw.json` / `knowledge_parsed.json` | 知识库抓取原始/解析数据 |
| `knowledge_full_raw.json` | 知识库全量抓取原始数据 |
| `action_guides_raw.json` | 196 个 action 指南原始响应 |
| `probe_results_raw.json` | 236 个 action 实测返回原始数据 |
| `scan_strings.js` / `dump_*.js` / `gen_*.js` / `probe_all_actions.js` | 分析脚本 |
