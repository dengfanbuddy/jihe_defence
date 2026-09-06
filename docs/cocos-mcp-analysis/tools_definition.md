# Cocos Creator MCP — 完整工具定义

> 来源:运行中的 MCP 服务 `POST /mcp` → `tools/list`(streamable HTTP, JSON-RPC)

> 工具总数: **17** 个 | 服务地址: `http://127.0.0.1:3000/mcp`

## 工具清单

| # | 工具名 | 作用域 |
|---|--------|--------|
| 1 | `cocos_scene` | 场景 |
| 2 | `cocos_node` | 节点 |
| 3 | `cocos_component` | 组件 |
| 4 | `cocos_prefab` | 预制体 |
| 5 | `cocos_asset` | 资源 |
| 6 | `cocos_editor` | 编辑器 |
| 7 | `cocos_view` | 视口 |
| 8 | `cocos_composite` | 复合UI |
| 9 | `cocos_knowledge` | 知识库 |
| 10 | `cocos_validate` | 校验 |
| 11 | `cocos_template` | 模板 |
| 12 | `cocos_capture` | 快照 |
| 13 | `cocos_builder` | JSON建树 |
| 14 | `cocos_animation` | 动画 |
| 15 | `cocos_spine` | Spine |
| 16 | `cocos_label` | 文本 |
| 17 | `cocos_devtools` | 开发者工具 |

---

## `cocos_scene`

### 发送给模型的描述 (description)

> Scene management — open/save/create scenes, get hierarchy, undo, detect mode, list_components, validate_scene.
> Common: hierarchy, get_info, open, save, create, validate_scene, list_components.
> Note: validate_scene checks broken refs IN this tool (NOT cocos_validate). list_components lists all available component types.
> Example: {action:"hierarchy"} or {action:"validate_scene"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "get_info",
            "list",
            "open",
            "save",
            "create",
            "close",
            "hierarchy",
            "is_ready",
            "is_dirty",
            "snapshot",
            "snapshot_abort",
            "undo_begin",
            "undo_end",
            "undo_cancel",
            "execute_method",
            "execute_script",
            "soft_reload",
            "list_classes",
            "list_components",
            "check_script",
            "find_nodes_by_asset",
            "restore_prefab",
            "query_mode",
            "validate_scene"
          ],
          "description": "Scene action to perform"
        },
        "scenePath": {
          "type": "string",
          "description": "Scene path, e.g. \"db://assets/scenes/Game.scene\""
        },
        "sceneName": {
          "type": "string",
          "description": "New scene name, e.g. \"Level2\""
        },
        "savePath": {
          "type": "string",
          "description": "Save path, e.g. \"db://assets/scenes/\""
        },
        "includeComponents": {
          "type": "boolean",
          "description": "Include component details in hierarchy output",
          "default": false
        },
        "uuid": {
          "type": "string",
          "description": "Component UUID for execute_method"
        },
        "name": {
          "type": "string",
          "description": "Method or plugin name for execute_method/execute_script"
        },
        "method": {
          "type": "string",
          "description": "Script method for execute_script"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Arguments for method execution",
          "default": []
        },
        "nodeUuid": {
          "type": "string",
          "description": "Node UUID for undo_begin or restore_prefab"
        },
        "undoId": {
          "type": "string",
          "description": "Undo ID for undo_end/undo_cancel"
        },
        "assetUuid": {
          "type": "string",
          "description": "Asset UUID for find_nodes_by_asset"
        },
        "extends": {
          "type": "string",
          "description": "Base class filter for list_classes"
        },
        "className": {
          "type": "string",
          "description": "Class name for check_script"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_node`

### 发送给模型的描述 (description)

> ⚡ BATCH: When modifying 3+ nodes (position/size/anchor), use "batch_modify" instead of calling "modify" repeatedly — it's faster and atomic.
> Node CRUD — create/find/modify/delete nodes, list all nodes, set transform, mount/remove scripts, reorder siblings.
> Actions: find, info, list, tree, create, delete, modify, move, reorder, duplicate, copy, paste, cut, mount_script, remove_script, reset, detect_type, batch_modify.
> Note: "list" returns all nodes flat list, "tree" returns subtree of a node. Use "info" (NOT get_info), "reset" (NOT reset_transform). "remove_script" for scripts (NOT component.remove). "reorder" to change sibling order within same parent. "batch_modify" to modify multiple nodes in one call.
> Example: {action:"list"} or {action:"tree", node:"Canvas"} or {action:"batch_modify", nodes:[{node:"Player", position:{x:0,y:0,z:0}}]}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "find",
            "info",
            "list",
            "tree",
            "create",
            "delete",
            "modify",
            "move",
            "reorder",
            "duplicate",
            "copy",
            "paste",
            "cut",
            "mount_script",
            "remove_script",
            "reset",
            "detect_type",
            "batch_modify"
          ],
          "description": "Node action to perform"
        },
        "node": {
          "type": "string",
          "description": "Node: UUID, path, or name. e.g. \"Canvas/Panel\" or \"Player\""
        },
        "name": {
          "type": "string",
          "description": "Node name for create, e.g. \"Player\""
        },
        "parent": {
          "type": "string",
          "description": "Parent node, e.g. \"Canvas\" or UUID. Default: scene root"
        },
        "nodeType": {
          "type": "string",
          "description": "Node preset type, e.g. \"2D\", \"3D\", \"UI\""
        },
        "type": {
          "type": "string",
          "description": "Built-in UI control type — creates complete control from engine prefab template with all children and bindings. Types: Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, Graphics, Mask, Layout, Widget, ParticleSystem2D, VideoPlayer, WebView, TiledMap"
        },
        "components": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Components to add on create, e.g. [\"cc.Sprite\"]"
        },
        "initialTransform": {
          "type": "object",
          "description": "Initial transform: {position:{x,y,z}, scale:{x,y,z}}"
        },
        "active": {
          "type": "boolean",
          "description": "Set node active state"
        },
        "layer": {
          "type": "number",
          "description": "Set node layer"
        },
        "position": {
          "type": "object",
          "description": "Position: {x, y, z}"
        },
        "rotation": {
          "type": "object",
          "description": "Rotation: {x, y, z}"
        },
        "scale": {
          "type": "object",
          "description": "Scale: {x, y, z}"
        },
        "targetParent": {
          "type": "string",
          "description": "New parent for move: UUID, path, or name"
        },
        "siblingIndex": {
          "type": "number",
          "description": "Position among siblings after move"
        },
        "includeChildren": {
          "type": "boolean",
          "description": "Include children in duplicate",
          "default": true
        },
        "uuids": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Multiple node UUIDs for copy/paste/cut"
        },
        "keepWorldTransform": {
          "type": "boolean",
          "description": "Keep world transform on paste",
          "default": false
        },
        "scriptPath": {
          "type": "string",
          "description": "Script path, e.g. \"db://assets/scripts/Player.ts\""
        },
        "scriptCid": {
          "type": "string",
          "description": "Script CID for remove_script"
        },
        "maxDepth": {
          "type": "number",
          "description": "Max depth for tree action",
          "default": 10
        },
        "exactMatch": {
          "type": "boolean",
          "description": "Exact match for find action",
          "default": false
        },
        "resetType": {
          "type": "string",
          "enum": [
            "property",
            "transform",
            "component"
          ],
          "description": "What to reset: property, transform, or component"
        },
        "path": {
          "type": "string",
          "description": "Property path for reset_property"
        },
        "nodes": {
          "type": "array",
          "description": "Array of node modifications for batch_modify. Each item: {node, position?, scale?, rotation?, active?, name?, anchor?, size?}",
          "items": {
            "type": "object",
            "properties": {
              "node": {
                "type": "string",
                "description": "Node: UUID, path, or name"
              },
              "position": {
                "type": "object",
                "description": "Position: {x, y, z}"
              },
              "scale": {
                "type": "object",
                "description": "Scale: {x, y, z}"
              },
              "rotation": {
                "type": "object",
                "description": "Rotation: {x, y, z}"
              },
              "active": {
                "type": "boolean",
                "description": "Set node active state"
              },
              "name": {
                "type": "string",
                "description": "Rename node"
              },
              "anchor": {
                "type": "object",
                "description": "Anchor point: {x, y}"
              },
              "size": {
                "type": "object",
                "description": "Content size: {width, height}"
              }
            },
            "required": [
              "node"
            ]
          }
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_component`

### 发送给模型的描述 (description)

> ⚡ BATCH: When binding 3+ click events, use "batch_click_event" instead of calling "click_event" repeatedly.
> Component management — add/remove/configure components on nodes.
> Actions: add, remove, list, info, set_property, available_types, click_event, batch_click_event.
> Note: use "info" to view component properties (NOT get_properties). To remove scripts, use cocos_node(action:"remove_script"). "batch_click_event" binds click events on multiple buttons in one call.
> Example: {action:"info", node:"Canvas/Btn", componentType:"cc.Button"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "add",
            "remove",
            "list",
            "info",
            "set_property",
            "available_types",
            "click_event",
            "batch_click_event"
          ],
          "description": "Component action to perform"
        },
        "node": {
          "type": "string",
          "description": "Node: UUID, path, or name. e.g. \"Canvas/Button\""
        },
        "componentType": {
          "type": [
            "string",
            "array"
          ],
          "items": {
            "type": "string"
          },
          "description": "Component type, e.g. \"cc.Sprite\", \"cc.Label\""
        },
        "property": {
          "type": "string",
          "description": "Property name, e.g. \"string\", \"fontSize\""
        },
        "propertyType": {
          "type": "string",
          "description": "Property type (auto-detected). e.g. \"string\", \"number\", \"color\", \"node\"",
          "enum": [
            "string",
            "number",
            "boolean",
            "integer",
            "float",
            "color",
            "vec2",
            "vec3",
            "size",
            "node",
            "component",
            "spriteFrame",
            "prefab",
            "asset",
            "nodeArray",
            "componentArray",
            "colorArray",
            "numberArray",
            "stringArray"
          ]
        },
        "value": {
          "description": "Value for set_property. Node refs: pass name/path/UUID"
        },
        "properties": {
          "type": "object",
          "description": "Batch props: {\"propName\": {\"type\":\"string\",\"value\":\"Hi\"}}"
        },
        "operation": {
          "type": "string",
          "enum": [
            "add",
            "modify",
            "remove",
            "clear"
          ],
          "description": "Click event op: add, modify, remove, clear"
        },
        "targetNode": {
          "type": "string",
          "description": "Target node with callback, e.g. \"Canvas/Controller\""
        },
        "componentName": {
          "type": "string",
          "description": "Component or script name, e.g. \"cc.Button\""
        },
        "handlerName": {
          "type": "string",
          "description": "Callback method name, e.g. \"onStartClick\""
        },
        "customEventData": {
          "type": "string",
          "description": "Custom data passed to handler at runtime"
        },
        "eventIndex": {
          "type": "number",
          "description": "Event index for remove operation"
        },
        "eventType": {
          "type": "string",
          "enum": [
            "click",
            "slide",
            "toggle"
          ],
          "description": "Event type: click (Button), slide (Slider), toggle (Toggle). Auto-detected if not specified."
        },
        "category": {
          "type": "string",
          "enum": [
            "all",
            "renderer",
            "ui",
            "physics",
            "animation",
            "audio"
          ],
          "description": "Type filter: all, renderer, ui, physics, animation, audio"
        },
        "events": {
          "type": "array",
          "description": "Array of click event bindings for batch_click_event. Each: {node, target, componentName, handler, customEventData?}",
          "items": {
            "type": "object",
            "properties": {
              "node": {
                "type": "string",
                "description": "Button node: UUID, path, or name"
              },
              "target": {
                "type": "string",
                "description": "Target node with callback"
              },
              "componentName": {
                "type": "string",
                "description": "Component or script name on target"
              },
              "handler": {
                "type": "string",
                "description": "Callback method name"
              },
              "customEventData": {
                "type": "string",
                "description": "Custom data passed to handler"
              }
            },
            "required": [
              "node",
              "target",
              "componentName",
              "handler"
            ]
          }
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_prefab`

### 发送给模型的描述 (description)

> Prefab management — list/info/delete/create/instantiate/edit prefabs, apply/revert changes.
> All prefab operations (including delete) belong here, NOT cocos_asset.
> Common: instantiate, create, delete, apply, edit_enter, edit_save, edit_exit.
> Example: {action:"instantiate", prefabPath:"db://assets/prefabs/Enemy.prefab", parent:"Canvas"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "list",
            "info",
            "validate",
            "create",
            "delete",
            "instantiate",
            "unlink",
            "apply",
            "revert",
            "edit_enter",
            "edit_save",
            "edit_exit",
            "edit_test"
          ],
          "description": "Prefab action to perform"
        },
        "prefabPath": {
          "type": "string",
          "description": "Prefab path, e.g. \"db://assets/prefabs/Button.prefab\""
        },
        "folder": {
          "type": "string",
          "description": "Folder for list, e.g. \"db://assets/prefabs\""
        },
        "node": {
          "type": "string",
          "description": "Target node: UUID, path, or name"
        },
        "nodeUuid": {
          "type": "string",
          "description": "Node UUID for create/unlink/apply/revert"
        },
        "prefabName": {
          "type": "string",
          "description": "Prefab name for create, e.g. \"MyButton\""
        },
        "savePath": {
          "type": "string",
          "description": "Save path for create, e.g. \"db://assets/prefabs/\""
        },
        "parent": {
          "type": "string",
          "description": "Parent node, e.g. \"Canvas\" or UUID"
        },
        "parentUuid": {
          "type": "string",
          "description": "Parent UUID for instantiate/edit_test"
        },
        "position": {
          "type": "object",
          "description": "Initial position: {x, y, z}"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_asset`

### 发送给模型的描述 (description)

> Asset operations — query/search/create/delete assets, path-UUID conversion.
> Common: query_uuid, find_by_name, search, create, delete.
> Example: {action:"query_uuid", url:"db://assets/textures/bg.png"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "query_info",
            "search",
            "find_by_name",
            "details",
            "create",
            "copy",
            "move",
            "delete",
            "save",
            "reimport",
            "import",
            "import_folder",
            "refresh",
            "dependencies",
            "manifest",
            "check_ready",
            "query_path",
            "query_uuid",
            "query_url"
          ],
          "description": "Asset action to perform"
        },
        "url": {
          "type": "string",
          "description": "Asset URL, e.g. \"db://assets/textures/bg.png\""
        },
        "uuid": {
          "type": "string",
          "description": "Asset UUID"
        },
        "type": {
          "type": "string",
          "description": "Type filter, e.g. \"cc.ImageAsset\", \"cc.Prefab\", \"all\"",
          "default": "all"
        },
        "folder": {
          "type": "string",
          "description": "Search folder, e.g. \"db://assets/textures\""
        },
        "name": {
          "type": "string",
          "description": "Name pattern for find_by_name, e.g. \"player\""
        },
        "content": {
          "type": "string",
          "description": "File content for create/save"
        },
        "source": {
          "type": "string",
          "description": "Source path for copy/move"
        },
        "target": {
          "type": "string",
          "description": "Target path for copy/move"
        },
        "overwrite": {
          "type": "boolean",
          "description": "Overwrite existing file",
          "default": false
        },
        "sourcePath": {
          "type": "string",
          "description": "External file path for import"
        },
        "targetFolder": {
          "type": "string",
          "description": "Target folder for import"
        },
        "deep": {
          "type": "boolean",
          "description": "Deep dependency analysis",
          "default": true
        },
        "includeSubAssets": {
          "type": "boolean",
          "description": "Include sub-assets in details",
          "default": true
        },
        "format": {
          "type": "string",
          "description": "Output format: json or csv",
          "default": "json"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_editor`

### 发送给模型的描述 (description)

> Editor utilities — project info, console logs, preferences, build, preview, run/stop, reload.
> Groups: project_*, console_*, log_*, pref_*, build*, server_*, run, stop, reload.
> "run" launches preview (platform: browser/simulator/editor). "stop" stops editor preview. "reload" reloads editor window (Developer → 重新加载).
> Example: {action:"run", platform:"editor"} then {action:"stop"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "project_info",
            "project_settings",
            "run",
            "stop",
            "build",
            "build_settings",
            "open_build_panel",
            "builder_status",
            "start_preview",
            "stop_preview",
            "console_logs",
            "console_clear",
            "log_read",
            "log_search",
            "log_info",
            "mcp_log_read",
            "mcp_log_clear",
            "editor_info",
            "performance",
            "pref_open",
            "pref_get",
            "pref_set",
            "pref_reset",
            "pref_all",
            "pref_categories",
            "pref_search",
            "pref_export",
            "server_ips",
            "server_port",
            "server_status",
            "server_test",
            "server_interfaces",
            "reload"
          ],
          "description": "Editor action to perform"
        },
        "category": {
          "type": "string",
          "description": "Settings or preferences category"
        },
        "platform": {
          "type": "string",
          "description": "For \"run\": preview platform (browser/simulator/editor). For \"build\": build platform (web-mobile/web-desktop/ios/android/windows/mac)."
        },
        "port": {
          "type": "number",
          "description": "Preview server port"
        },
        "limit": {
          "type": "number",
          "description": "Max log entries to return"
        },
        "logType": {
          "type": "string",
          "description": "Log type filter: log, warn, error"
        },
        "keyword": {
          "type": "string",
          "description": "Search keyword for log_search"
        },
        "lines": {
          "type": "number",
          "description": "Number of log lines to read"
        },
        "tab": {
          "type": "string",
          "description": "Preferences panel tab to open"
        },
        "path": {
          "type": "string",
          "description": "Preference config path"
        },
        "value": {
          "description": "Value to set for pref_set"
        },
        "query": {
          "type": "string",
          "description": "Search query for pref_search"
        },
        "timeout": {
          "type": "number",
          "description": "Timeout for server_test in ms"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_view`

### 发送给模型的描述 (description)

> Viewport control — gizmo tools, 2D/3D mode, camera focus/align, reference images.
> Common: gizmo_tool, camera_focus, camera_align_view (sync camera→view), camera_align_node (sync view→node).
> Example: {action:"camera_focus", nodes:["Player"]} or {action:"camera_align_node", nodes:["Camera"]}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "gizmo_tool",
            "gizmo_tool_query",
            "gizmo_pivot",
            "gizmo_pivot_query",
            "gizmo_coordinate",
            "gizmo_coordinate_query",
            "gizmo_view_mode",
            "mode_2d_3d",
            "mode_query",
            "grid_set",
            "grid_query",
            "icon_3d_mode",
            "icon_3d_query",
            "icon_size",
            "icon_size_query",
            "camera_focus",
            "camera_align_view",
            "camera_align_node",
            "status",
            "reset_view",
            "ref_add",
            "ref_remove",
            "ref_switch",
            "ref_clear",
            "ref_config",
            "ref_current",
            "ref_list",
            "ref_position",
            "ref_scale",
            "ref_opacity",
            "ref_data",
            "ref_refresh"
          ],
          "description": "View action to perform"
        },
        "tool": {
          "type": "string",
          "description": "Gizmo tool: position, rotation, scale, rect"
        },
        "pivot": {
          "type": "string",
          "description": "Gizmo pivot: center, pivot"
        },
        "coordinate": {
          "type": "string",
          "description": "Coordinate system: local, global"
        },
        "is2D": {
          "type": "boolean",
          "description": "Set 2D mode (true) or 3D mode (false)"
        },
        "visible": {
          "type": "boolean",
          "description": "Grid visibility"
        },
        "mode": {
          "type": "string",
          "description": "Icon gizmo 3D mode"
        },
        "size": {
          "type": "number",
          "description": "Icon gizmo size"
        },
        "nodes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Node UUIDs/names for camera_focus"
        },
        "imagePath": {
          "type": "string",
          "description": "Local image path for ref_add"
        },
        "imageUrl": {
          "type": "string",
          "description": "Image URL for ref_add"
        },
        "imageId": {
          "type": "string",
          "description": "Reference image ID"
        },
        "index": {
          "type": "number",
          "description": "Image index for ref_switch"
        },
        "x": {
          "type": "number",
          "description": "X position for ref_position"
        },
        "y": {
          "type": "number",
          "description": "Y position for ref_position"
        },
        "scaleValue": {
          "type": "number",
          "description": "Scale value for ref_scale"
        },
        "opacity": {
          "type": "number",
          "description": "Opacity 0-1 for ref_opacity"
        },
        "data": {
          "type": "object",
          "description": "Raw data for ref_data"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_composite`

### 发送给模型的描述 (description)

> One-call UI creation — create complete Button/Label/Image, mount script with bindings.
> Actions: create_button, create_label, create_image, mount_and_bind, setup_widget, batch, batch_create_button, batch_create_label, batch_create_image.
> Note: mount_and_bind mounts script AND binds properties in one call (NOT node.mount_script which only mounts). create_button supports optional clickEvent to bind click handler in one call.
> Batch hint: 3+ buttons → batch_create_button, 3+ labels → batch_create_label, 3+ images → batch_create_image.
> Example: {action:"mount_and_bind", node:"Hero", scriptPath:"db://assets/scripts/Game.ts", bindings:{...}}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "create_button",
            "create_label",
            "create_image",
            "create_ui",
            "mount_and_bind",
            "setup_widget",
            "batch",
            "batch_create_button",
            "batch_create_label",
            "batch_create_image"
          ],
          "description": "Composite action to perform. create_ui creates any built-in UI control from engine prefab template."
        },
        "parent": {
          "type": "string",
          "description": "Parent node, e.g. \"Canvas\" or UUID"
        },
        "name": {
          "type": "string",
          "description": "Node name, e.g. \"StartButton\""
        },
        "node": {
          "type": "string",
          "description": "Target node for mount_and_bind/setup_widget"
        },
        "text": {
          "type": "string",
          "description": "Label text content, e.g. \"Start Game\""
        },
        "fontSize": {
          "type": "number",
          "description": "Font size, default 28"
        },
        "size": {
          "type": "object",
          "description": "Size: {width, height}"
        },
        "position": {
          "type": "object",
          "description": "Position: {x, y}"
        },
        "color": {
          "description": "Color: \"#FF0000\" or {r,g,b,a}"
        },
        "spriteFrame": {
          "type": "string",
          "description": "Sprite frame path or \"default\""
        },
        "type": {
          "type": "string",
          "description": "Built-in UI type for create_ui: Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, Graphics, Mask, Layout, Widget, ParticleSystem2D, VideoPlayer, WebView, TiledMap"
        },
        "clickEvent": {
          "type": "object",
          "description": "Optional click event for create_button: {target, componentName, handler, customEventData?}",
          "properties": {
            "target": {
              "type": "string",
              "description": "Target node with callback, e.g. \"Canvas/Controller\""
            },
            "componentName": {
              "type": "string",
              "description": "Component or script name on target"
            },
            "handler": {
              "type": "string",
              "description": "Callback method name, e.g. \"onStartGame\""
            },
            "customEventData": {
              "type": "string",
              "description": "Custom data passed to handler"
            }
          },
          "required": [
            "target",
            "componentName",
            "handler"
          ]
        },
        "scriptPath": {
          "type": "string",
          "description": "Script path, e.g. \"db://assets/scripts/UI.ts\""
        },
        "bindings": {
          "type": "object",
          "description": "Property bindings: {\"prop\": \"NodeName\"}"
        },
        "align": {
          "type": "string",
          "enum": [
            "full",
            "top",
            "bottom",
            "left",
            "right",
            "center",
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
            "stretch-horizontal",
            "stretch-vertical"
          ],
          "description": "Widget preset: full, top, center, stretch-horizontal..."
        },
        "margin": {
          "type": "object",
          "description": "Widget margins: {top, bottom, left, right}"
        },
        "count": {
          "type": "number",
          "description": "Number of items to create in batch"
        },
        "template": {
          "type": "object",
          "description": "Template for batch: {type, text, ...}"
        },
        "source": {
          "type": "string",
          "description": "Source node to clone in batch"
        },
        "namePrefix": {
          "type": "string",
          "description": "Name prefix for batch items"
        },
        "buttons": {
          "type": "array",
          "description": "Array of button definitions for batch_create_button: [{name, text?, fontSize?, size?, spriteFrame?, color?, clickEvent?, position?}]",
          "items": {
            "type": "object"
          }
        },
        "labels": {
          "type": "array",
          "description": "Array of label definitions for batch_create_label: [{name, text, fontSize?, color?, position?}]",
          "items": {
            "type": "object"
          }
        },
        "images": {
          "type": "array",
          "description": "Array of image definitions for batch_create_image: [{name, spriteFrame, size?, position?}]",
          "items": {
            "type": "object"
          }
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_knowledge`

### 发送给模型的描述 (description)

> Cocos Creator reference — component properties, UI rules, layout patterns, animation recipes, best practices, tool guides.
> Use topic:"tool_guide" with query:"tool.action" before calling unfamiliar tools.
> Example: {topic:"component_properties", query:"cc.Label"}, {topic:"animation_patterns", query:"scale_bounce"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "topic": {
          "type": "string",
          "enum": [
            "component_properties",
            "ui_design_rules",
            "layout_patterns",
            "widget_strategy",
            "node_structure",
            "animation_patterns",
            "best_practices",
            "tool_guide"
          ],
          "description": "Knowledge topic, e.g. \"component_properties\", \"animation_patterns\", \"best_practices\""
        },
        "query": {
          "type": "string",
          "description": "Query: \"cc.Label\" or \"component.set_property\""
        }
      },
      "required": [
        "topic"
      ]
    }
```


---

## `cocos_validate`

### 发送给模型的描述 (description)

> Advanced validation rules — layout overlap/offscreen, reference consistency, hierarchy depth.
> Note: Use this for deep inspection (NOT scene.validate_scene which only checks broken refs).
> Actions: layout (overlap/offscreen), references (broken asset refs), hierarchy (depth/naming).
> Example: {action:"layout"} or {action:"references"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "layout",
            "references",
            "hierarchy"
          ],
          "description": "Validation type: layout, references, hierarchy"
        },
        "rootNode": {
          "type": "string",
          "description": "Root node to validate. Default: entire scene"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_template`

### 发送给模型的描述 (description)

> UI templates — apply pre-built structures (dialog, scroll_list, nav_bar, settings_page).
> Note: Use this (NOT composite/builder) when user wants a standard UI pattern. Use list to show available templates.
> Actions: list, apply.
> Example: {action:"list"} or {action:"apply", template:"dialog", parent:"Canvas"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "list",
            "apply"
          ],
          "description": "Template action: list or apply"
        },
        "template": {
          "type": "string",
          "enum": [
            "dialog",
            "scroll_list",
            "nav_bar",
            "settings_page"
          ],
          "description": "Template name: dialog, scroll_list, nav_bar, settings_page"
        },
        "parent": {
          "type": "string",
          "description": "Parent node, e.g. \"Canvas\". Default: Canvas"
        },
        "name": {
          "type": "string",
          "description": "Root node name override"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_capture`

### 发送给模型的描述 (description)

> Scene snapshot — get structured JSON of scene/node layout for AI understanding.
> Actions: scene_snapshot (full scene), node_snapshot (focused subtree).
> Note: Use this (NOT hierarchy) when you need position/size/component data for layout analysis.
> Example: {action:"scene_snapshot"} or {action:"node_snapshot", node:"Canvas/Panel"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "scene_snapshot",
            "node_snapshot"
          ],
          "description": "Capture action: scene_snapshot or node_snapshot"
        },
        "node": {
          "type": "string",
          "description": "Target node for node_snapshot, e.g. \"Canvas/Panel\""
        },
        "maxDepth": {
          "type": "number",
          "description": "Max traversal depth, default 10 (scene) / 15 (node)"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_builder`

### 发送给模型的描述 (description)

> Build node tree from JSON — create complete hierarchies with components in one call.
> Note: Use this (NOT composite/node) when building complex multi-level UI structures. Query tool_guide for JSON format.
> Prefab shortcut: use "type":"Button" (or Label, Sprite, ScrollView, etc.) instead of components[] to create complete UI controls from engine prefab templates.
> Example: {action:"build", parent:"Canvas", tree:{name:"Panel", components:["cc.Sprite"], children:[{name:"MyBtn", type:"Button"}]}}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "build"
          ],
          "description": "Builder action: build"
        },
        "parent": {
          "type": "string",
          "description": "Parent node, e.g. \"Canvas\". Default: Canvas"
        },
        "tree": {
          "type": "object",
          "description": "Node tree JSON definition. Use \"props\" or \"properties\" for component properties."
        },
        "clean": {
          "type": "boolean",
          "description": "Remove parent's children before building"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_animation`

### 发送给模型的描述 (description)

> Animation editing — clips, keyframes, tracks, events, presets, batch operations.
> Recommended: batch_file (no edit mode needed), fallback to batch. Use preset for common animations.
> Example: {action:"preset", clipUuid:"...", preset:"sprite_fade_in"} or {action:"add_event", clipUuid:"...", frame:10, eventData:{func:"onHit"}}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "play",
            "pause",
            "resume",
            "stop",
            "change_sample",
            "change_speed",
            "change_wrap_mode",
            "create_prop",
            "remove_prop",
            "create_key",
            "update_key",
            "remove_key",
            "move_keys",
            "copy_keys_to",
            "spacing_keys",
            "clear_keys",
            "modify_curve",
            "add_event",
            "delete_event",
            "update_event",
            "move_events",
            "copy_events_to",
            "remove_node",
            "change_node_path",
            "query_clips_info",
            "query_clip",
            "query_clip_dump",
            "query_value_at_frame",
            "query_properties",
            "query_state",
            "query_edit_info",
            "enter_edit",
            "exit_edit",
            "save_clip",
            "create_clip",
            "batch",
            "batch_file",
            "preset_list",
            "preset"
          ],
          "description": "Animation action to perform"
        },
        "nodeUuid": {
          "type": "string",
          "description": "Node UUID (has Animation component)"
        },
        "node": {
          "type": "string",
          "description": "Node name or path, e.g. \"Canvas/GameRoot\""
        },
        "clipUuid": {
          "type": "string",
          "description": "AnimationClip UUID"
        },
        "nodePath": {
          "type": "string",
          "description": "Node path in clip, e.g. \"/\" for root"
        },
        "propKey": {
          "type": "string",
          "description": "Property key, e.g. \"position\", \"cc.Sprite.spriteFrame\""
        },
        "frame": {
          "description": "Frame index (number) or array of indices"
        },
        "target": {
          "description": "Target: dest frame, offset, spacing, or node path"
        },
        "data": {
          "description": "Action-specific data. Supports db:// path auto-resolve"
        },
        "eventData": {
          "description": "Event data: {func, params} or array of events"
        },
        "sample": {
          "type": "number",
          "description": "Sample rate (frames per second)"
        },
        "speed": {
          "type": "number",
          "description": "Playback speed"
        },
        "wrapMode": {
          "type": "number",
          "description": "Wrap mode: 0=Default, 1=Normal, 2=Loop, 36=PingPong"
        },
        "preset": {
          "type": "string",
          "description": "Preset name, e.g. \"sprite_fade_in\", \"effect_bounce\", \"sprite_sequence\""
        },
        "folder": {
          "type": "string",
          "description": "Image folder for sprite_sequence"
        },
        "images": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Image paths for sprite_sequence"
        },
        "duration": {
          "type": "number",
          "description": "Duration in frames, default 30"
        },
        "direction": {
          "type": "string",
          "description": "Direction: left, right, top, bottom"
        },
        "distance": {
          "type": "number",
          "description": "Distance for slide/float, default 500"
        },
        "count": {
          "type": "number",
          "description": "Repeat count for blink/shake, default 3"
        },
        "intensity": {
          "type": "number",
          "description": "Intensity for shake, default 10"
        },
        "startValue": {
          "description": "Start value, e.g. [0,0,0]"
        },
        "endValue": {
          "description": "End value, e.g. [100,200,0]"
        },
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "frame": {
                "type": "number"
              },
              "func": {
                "type": "string"
              },
              "params": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          "description": "Event array: [{frame, func, params}]"
        },
        "writeMode": {
          "type": "string",
          "enum": [
            "api",
            "file"
          ],
          "description": "Write mode: \"api\" or \"file\" (no edit mode needed)"
        },
        "url": {
          "type": "string",
          "description": "db:// path for create_clip"
        },
        "clipName": {
          "type": "string",
          "description": "Clip name, default derived from filename"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_spine`

### 发送给模型的描述 (description)

> Spine (sp.Skeleton) — query animations/skins, set animation/skin, change properties, swap skeleton data, manage sockets.
> Actions: info, list_animations, list_skins, set_animation, set_skin, set_property, set_data, add_socket, remove_socket.
> Note: "node" is the node path or UUID with sp.Skeleton component.
> Example: {action:"list_animations", node:"spinNode"} or {action:"set_animation", node:"spinNode", animation:"idle"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "info",
            "list_animations",
            "list_skins",
            "set_animation",
            "set_skin",
            "set_property",
            "set_data",
            "add_socket",
            "remove_socket"
          ],
          "description": "Spine operation to perform"
        },
        "node": {
          "type": "string",
          "description": "Node path or UUID with sp.Skeleton component"
        },
        "animation": {
          "type": "string",
          "description": "Animation name (set_animation). Use list_animations to see available names."
        },
        "skin": {
          "type": "string",
          "description": "Skin name (set_skin). Use list_skins to see available names."
        },
        "property": {
          "type": "string",
          "enum": [
            "loop",
            "timeScale",
            "premultipliedAlpha",
            "defaultCacheMode",
            "useTint",
            "enableBatch",
            "color",
            "debugSlots",
            "debugBones",
            "debugMesh"
          ],
          "description": "Property name (set_property)"
        },
        "value": {
          "description": "Property value (set_property). Type depends on property."
        },
        "skeletonData": {
          "type": "string",
          "description": "Spine skeleton data asset path (db://...) or UUID (set_data)"
        },
        "path": {
          "type": "string",
          "description": "Bone path for socket operations"
        },
        "target": {
          "type": "string",
          "description": "Target node path or UUID to attach to socket (add_socket)"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_label`

### 发送给模型的描述 (description)

> Label & Text — manage cc.Label, cc.RichText, cc.EditBox. Query/set text, font, style, outline, shadow. Batch operations.
> Actions: info, list, set_text, set_font, set_style, set_outline, set_shadow, batch_set_font, batch_set_style.
> Supports: cc.Label (full), cc.RichText (text/font/fontSize/color), cc.EditBox (text/placeholder).
> Example: {action:"set_text", node:"Title", text:"Hello"}
> {action:"set_style", node:"Title", fontSize:32, isBold:true, color:{r:255,g:0,b:0,a:255}}
> {action:"batch_set_font", font:"db://assets/fonts/myfont.ttf"}

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "info",
            "list",
            "set_text",
            "set_font",
            "set_style",
            "set_outline",
            "set_shadow",
            "batch_set_font",
            "batch_set_style"
          ],
          "description": "Font/Label operation"
        },
        "node": {
          "type": "string",
          "description": "Node path or UUID with cc.Label"
        },
        "text": {
          "type": "string",
          "description": "Text content (set_text)"
        },
        "font": {
          "type": "string",
          "description": "Font asset path (db://...) or UUID. Empty string = clear custom font"
        },
        "useSystemFont": {
          "type": "boolean",
          "description": "Use system font instead of custom font"
        },
        "fontFamily": {
          "type": "string",
          "description": "System font family name (e.g. \"Arial\", \"SimHei\")"
        },
        "fontSize": {
          "type": "number",
          "description": "Font size in pixels"
        },
        "lineHeight": {
          "type": "number",
          "description": "Line height in pixels"
        },
        "horizontalAlign": {
          "type": "string",
          "description": "Horizontal alignment: LEFT, CENTER, RIGHT"
        },
        "verticalAlign": {
          "type": "string",
          "description": "Vertical alignment: TOP, CENTER, BOTTOM"
        },
        "overflow": {
          "type": "string",
          "description": "Overflow mode: NONE, CLAMP, SHRINK, RESIZE_HEIGHT"
        },
        "enableWrapText": {
          "type": "boolean",
          "description": "Enable text wrapping"
        },
        "isBold": {
          "type": "boolean",
          "description": "Bold text"
        },
        "isItalic": {
          "type": "boolean",
          "description": "Italic text"
        },
        "isUnderline": {
          "type": "boolean",
          "description": "Underline text"
        },
        "underlineHeight": {
          "type": "number",
          "description": "Underline thickness in pixels"
        },
        "cacheMode": {
          "type": "string",
          "description": "Cache mode: NONE, BITMAP, CHAR"
        },
        "color": {
          "description": "Text/outline/shadow color {r,g,b,a}"
        },
        "enabled": {
          "type": "boolean",
          "description": "Enable/disable outline or shadow"
        },
        "width": {
          "type": "number",
          "description": "Outline width in pixels"
        },
        "offset": {
          "description": "Shadow offset {x, y}"
        },
        "blur": {
          "type": "number",
          "description": "Shadow blur radius"
        },
        "filter": {
          "type": "string",
          "description": "Batch filter: node name pattern (substring match)"
        }
      },
      "required": [
        "action"
      ]
    }
```


---

## `cocos_devtools`

### 发送给模型的描述 (description)

> [DEV-ONLY] Component research & knowledge system.
> Actions: message_record_*, message_log*, research_component, explore_component, auto_knowledge, save/get/list/delete/promote_knowledge.
> Workflow: auto_knowledge(componentType, save:true) → promote_knowledge. Or manual: research → explore → save → promote.

### 参数 Schema (inputSchema)

```json
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "message_record_start",
            "message_record_stop",
            "message_record_status",
            "message_log",
            "message_log_export",
            "message_log_clear",
            "research_component",
            "explore_component",
            "auto_knowledge",
            "save_knowledge",
            "get_knowledge",
            "list_knowledge",
            "delete_knowledge",
            "promote_knowledge"
          ],
          "description": "DevTools action to perform"
        },
        "componentType": {
          "type": "string",
          "description": "Component type, e.g. \"cc.Button\""
        },
        "version": {
          "type": "string",
          "description": "Cocos Creator version for docs lookup, e.g. \"3.8\""
        },
        "knowledge": {
          "type": "object",
          "description": "ComponentKnowledge object to save"
        },
        "save": {
          "type": "boolean",
          "description": "For auto_knowledge: also save the recommended knowledge to file (default: false)"
        },
        "tail": {
          "type": "number",
          "description": "Number of recent message records to return"
        },
        "plugin": {
          "type": "string",
          "description": "Filter messages by plugin name"
        },
        "method": {
          "type": "string",
          "description": "Filter messages by method name (substring match)"
        },
        "source": {
          "type": "string",
          "description": "Filter messages by source (substring match)"
        },
        "dir": {
          "type": "string",
          "enum": [
            "request",
            "send",
            "broadcast"
          ],
          "description": "Filter messages by direction"
        }
      },
      "required": [
        "action"
      ]
    }
```

