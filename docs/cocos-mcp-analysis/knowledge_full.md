# Cocos Creator MCP — 知识库全量内容(tool_guide)

> 抓取方式: `cocos_knowledge(topic:"tool_guide", query:"<kb_tool>.<action>")` 对全部枚举 action 实测抓取  
> 统计: 共 222 个查询,成功 **200** 个 action 指南,缺失 22 个(服务端无该 action 指南)

---

## `cocos_scene`(23 个 action 指南)

### 工具级指南

**描述**: Scene management: open, save, create, hierarchy, undo, script execution, class queries

**Action 概览**: get_info, list, open, save, create, close, hierarchy, is_ready, is_dirty, snapshot, snapshot_abort, undo_begin, undo_end, undo_cancel, execute_method, execute_script, soft_reload, list_classes, list_components, check_script, find_nodes_by_asset, restore_prefab, query_mode

### cocos_scene.get_info

**描述**: Get current scene info (name, uuid, path)

**返回**: Scene name, uuid, url

**示例**:

```json
{
  "input": {
    "action": "get_info"
  }
}
```

### cocos_scene.list

**描述**: List all scene assets in project

**返回**: Array of scene {name, path, uuid}

**示例**:

```json
{
  "input": {
    "action": "list"
  }
}
```

### cocos_scene.open

**描述**: Open a scene by path

**参数**:

- `scenePath`: Scene path (e.g. "db://assets/scenes/Game.scene") (`string`)

**示例**:

```json
{
  "input": {
    "action": "open",
    "scenePath": "db://assets/scenes/Game.scene"
  }
}
```

### cocos_scene.save

**描述**: Save the current scene



**示例**:

```json
{
  "input": {
    "action": "save"
  }
}
```

### cocos_scene.create

**描述**: Create a new scene asset with Camera + Canvas auto-created

**参数**:

- `sceneName`: Scene file name (`string`)
- `savePath`: Save folder (e.g. "db://assets/scenes") (`string`)

**返回**: Scene info + autoCreated[] listing nodes auto-created (Camera, Canvas)

**示例**:

```json
{
  "input": {
    "action": "create",
    "sceneName": "Level2",
    "savePath": "db://assets/scenes"
  }
}
```

**注意事项**:

- Scene is auto-opened after creation and Camera + Canvas are created automatically
- Canvas has cc.Canvas + cc.UITransform + cc.Widget (full-screen). Camera has cc.Camera (ORTHO)
- No need to manually create Camera or Canvas — they are always included in new scenes

### cocos_scene.close

**描述**: Close the current scene

**示例**:

```json
{
  "input": {
    "action": "close"
  }
}
```

### cocos_scene.hierarchy

**描述**: Get full scene hierarchy tree

**参数**:

- `includeComponents`: Include component details (`boolean`) (默认: false)

**返回**: Full node tree with optional component info

**示例**:

```json
{
  "input": {
    "action": "hierarchy",
    "includeComponents": true
  }
}
```

### cocos_scene.is_ready

**描述**: Check if scene is loaded and ready

**返回**: Boolean ready state

**示例**:

```json
{
  "input": {
    "action": "is_ready"
  }
}
```

### cocos_scene.is_dirty

**描述**: Check if scene has unsaved changes

**返回**: Boolean dirty state

**示例**:

```json
{
  "input": {
    "action": "is_dirty"
  }
}
```

### cocos_scene.snapshot

**描述**: Create an undo snapshot of current scene state

**返回**: Snapshot ID

**示例**:

```json
{
  "input": {
    "action": "snapshot"
  }
}
```

### cocos_scene.snapshot_abort

**描述**: Abort/discard current snapshot

**示例**:

```json
{
  "input": {
    "action": "snapshot_abort"
  }
}
```

### cocos_scene.undo_begin

**描述**: Begin an undo group (for batching changes)

**参数**:

- `nodeUuid`: Target node UUID for undo context (`string`)

**返回**: undoId for use with undo_end/undo_cancel

**示例**:

```json
{
  "input": {
    "action": "undo_begin",
    "nodeUuid": "abc-123"
  }
}
```

### cocos_scene.undo_end

**描述**: End and commit an undo group

**参数**:

- `undoId`: Undo ID from undo_begin (`string`)

**示例**:

```json
{
  "input": {
    "action": "undo_end",
    "undoId": "undo-123"
  }
}
```

### cocos_scene.undo_cancel

**描述**: Cancel an undo group (rollback)

**参数**:

- `undoId`: Undo ID from undo_begin (`string`)

**示例**:

```json
{
  "input": {
    "action": "undo_cancel",
    "undoId": "undo-123"
  }
}
```

### cocos_scene.execute_method

**描述**: Execute a method on a component in scene

**参数**:

- `uuid`: Component UUID (`string`)
- `name`: Method name to execute (`string`)
- `args`: Method arguments (`array`) (默认: [])

**示例**:

```json
{
  "input": {
    "action": "execute_method",
    "uuid": "comp-uuid-123",
    "name": "resetState",
    "args": []
  }
}
```

### cocos_scene.execute_script

**描述**: Execute a script/plugin method

**参数**:

- `name`: Plugin/extension name (`string`)
- `method`: Method name (`string`)
- `args`: Method arguments (`array`) (默认: [])

**示例**:

```json
{
  "input": {
    "action": "execute_script",
    "name": "my-extension",
    "method": "doSomething"
  }
}
```

### cocos_scene.soft_reload

**描述**: Soft-reload the scene (re-run scripts without full reload)

**示例**:

```json
{
  "input": {
    "action": "soft_reload"
  }
}
```

### cocos_scene.list_classes

**描述**: List registered script classes

**参数**:

- `extends`: Filter by base class (e.g. "cc.Component") (`string`)

**返回**: Array of class names

**示例**:

```json
{
  "input": {
    "action": "list_classes",
    "extends": "cc.Component"
  }
}
```

### cocos_scene.list_components

**描述**: List all registered component types

**返回**: Array of component class names

**示例**:

```json
{
  "input": {
    "action": "list_components"
  }
}
```

### cocos_scene.check_script

**描述**: Check if a script class is registered

**参数**:

- `className`: Class name to check (`string`)

**返回**: Boolean exists + class info

**示例**:

```json
{
  "input": {
    "action": "check_script",
    "className": "PlayerController"
  }
}
```

### cocos_scene.find_nodes_by_asset

**描述**: Find all nodes referencing a specific asset

**参数**:

- `assetUuid`: Asset UUID to search for (`string`)

**返回**: Array of nodes using the asset

**示例**:

```json
{
  "input": {
    "action": "find_nodes_by_asset",
    "assetUuid": "asset-uuid-123"
  }
}
```

### cocos_scene.restore_prefab

**描述**: Restore a broken prefab instance

**参数**:

- `nodeUuid`: Node UUID of broken prefab instance (`string`)
- `assetUuid`: Original prefab asset UUID (`string`)

**示例**:

```json
{
  "input": {
    "action": "restore_prefab",
    "nodeUuid": "node-123",
    "assetUuid": "prefab-456"
  }
}
```

### cocos_scene.query_mode

**描述**: Query current editor/scene mode (normal, prefab-edit, etc.)

**返回**: Current mode info

**示例**:

```json
{
  "input": {
    "action": "query_mode"
  }
}
```

---

## `cocos_node`(17 个 action 指南)

### 工具级指南

**描述**: Scene node operations: find, create, modify, move, duplicate, clipboard, scripts

**Action 概览**: find, info, list, tree, create, delete, modify, move, duplicate, copy, paste, cut, mount_script, remove_script, reset, detect_type, batch_modify

### cocos_node.find

**描述**: Search nodes by name pattern

**参数**:

- `node`: Search pattern (name, UUID, or path) (`string`)
- `exactMatch`: Exact name match (`boolean`) (默认: false)

**返回**: Array of matching nodes with uuid, name, path

**示例**:

```json
{
  "input": {
    "action": "find",
    "node": "Button"
  }
}
```

### cocos_node.info

**描述**: Get detailed node info (transform, components, children)

**参数**:

- `node`: Target node: UUID, path, or name (`string`)

**返回**: Node details: name, uuid, path, position, rotation, scale, components, children

**示例**:

```json
{
  "input": {
    "action": "info",
    "node": "Canvas/Player"
  }
}
```

### cocos_node.list

**描述**: List top-level nodes in scene

**返回**: Array of root-level nodes

**示例**:

```json
{
  "input": {
    "action": "list"
  }
}
```

### cocos_node.tree

**描述**: Get node hierarchy tree

**参数**:

- `node`: Root node (default: entire scene) (`string`)
- `maxDepth`: Max traversal depth (`number`) (默认: 10)

**返回**: Tree structure with children

**示例**:

```json
{
  "input": {
    "action": "tree",
    "node": "Canvas",
    "maxDepth": 3
  }
}
```

### cocos_node.create

**描述**: Create a new node. Use "type" for built-in UI controls (Button, Label, etc.) — creates complete control from engine prefab.

**参数**:

- `name`: Node name (default: "New Node") (`string`)
- `parent`: Parent node: UUID, path, or name (`string`)
- `nodeType`: Preset type: "2D", "3D", "UI" (`string`)
- `type`: Built-in UI control type — creates complete control from engine prefab. Types: Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, etc. (`string`)
- `components`: Components to add (e.g. ["cc.Sprite","cc.Button"]) (`array`)
- `initialTransform`: {position:{x,y,z}, rotation:{x,y,z}, scale:{x,y,z}} (`object`)

**示例**:

```json
{
  "input": {
    "action": "create",
    "name": "MyButton",
    "parent": "Canvas",
    "type": "Button"
  }
}
```

**注意事项**:

- Auto-adds cc.UITransform if parent is a UI node
- Use "type" for complete UI controls (preferred). Use nodeType/components for custom setup.
- UI node response includes viewport context (designResolution, visibleRect, center)
- For batch UI creation, prefer cocos_composite(action:"create_ui") or cocos_builder with type field

### cocos_node.delete

**描述**: Delete a node from scene

**参数**:

- `node`: Target node: UUID, path, or name (`string`)

**示例**:

```json
{
  "input": {
    "action": "delete",
    "node": "Canvas/OldPanel"
  }
}
```

### cocos_node.modify

**描述**: Modify node properties (name, active, transform)

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `name`: New node name (`string`)
- `active`: Set active state (`boolean`)
- `layer`: Set node layer (`number`)
- `position`: {x, y, z} (`object`)
- `rotation`: {x, y, z} in degrees (`object`)
- `scale`: {x, y, z} (`object`)

**示例**:

```json
{
  "input": {
    "action": "modify",
    "node": "Canvas/Player",
    "position": {
      "x": 100,
      "y": 200,
      "z": 0
    }
  }
}
```

**注意事项**:

- Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2)
- Modifying position on UI nodes returns viewport context + out-of-bounds warnings

### cocos_node.move

**描述**: Move node to new parent or change sibling order

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `targetParent`: New parent: UUID, path, or name (`string`)
- `siblingIndex`: Position among siblings (`number`)

**示例**:

```json
{
  "input": {
    "action": "move",
    "node": "Canvas/Button",
    "targetParent": "Canvas/Panel",
    "siblingIndex": 0
  }
}
```

### cocos_node.duplicate

**描述**: Duplicate a node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `includeChildren`: Include children (`boolean`) (默认: true)

**返回**: New node UUID

**示例**:

```json
{
  "input": {
    "action": "duplicate",
    "node": "Canvas/ListItem"
  }
}
```

### cocos_node.copy

**描述**: Copy node(s) to clipboard

**参数**:

- `node`: Single node: UUID, path, or name (`string`)
- `uuids`: Multiple node UUIDs (`array`)

**示例**:

```json
{
  "input": {
    "action": "copy",
    "node": "Canvas/Template"
  }
}
```

**注意事项**:

- Use node for single, uuids for multiple

### cocos_node.paste

**描述**: Paste node(s) from clipboard

**参数**:

- `parent`: Target parent: UUID, path, or name (`string`)
- `uuids`: Specific UUIDs to paste (`array`)
- `keepWorldTransform`: Keep world transform (`boolean`) (默认: false)

**示例**:

```json
{
  "input": {
    "action": "paste",
    "parent": "Canvas/Container"
  }
}
```

### cocos_node.cut

**描述**: Cut node(s) to clipboard

**参数**:

- `node`: Single node: UUID, path, or name (`string`)
- `uuids`: Multiple node UUIDs (`array`)

**示例**:

```json
{
  "input": {
    "action": "cut",
    "node": "Canvas/OldItem"
  }
}
```

### cocos_node.mount_script

**描述**: Mount a TypeScript/JavaScript script component to node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `scriptPath`: Script asset path (e.g. "db://assets/scripts/Player.ts") (`string`)

**返回**: Script info + assignableProperties[] listing public properties that need node/asset assignment

**示例**:

```json
{
  "input": {
    "action": "mount_script",
    "node": "Canvas/Player",
    "scriptPath": "db://assets/scripts/PlayerController.ts"
  }
}
```

**注意事项**:

- WORKFLOW: mount_script > check assignableProperties > set_property for each.
- Smart resolution: pass node NAME or PATH as value — no need to look up UUIDs manually.
- Node refs: value:"PlayerNode" or "Canvas/Player". Component refs: value:"ScoreLabel" (auto-finds matching component).
- For images: propertyType:"spriteFrame" + "db://assets/..." path. For prefabs: propertyType:"prefab" + "db://..." path.
- Do NOT write runtime code (find/getChildByName) — use MCP set_property instead.

### cocos_node.remove_script

**描述**: Remove a script component from node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `scriptCid`: Script CID (get from component.list) (`string`)

**示例**:

```json
{
  "input": {
    "action": "remove_script",
    "node": "Canvas/Player",
    "scriptCid": "1abnc..."
  }
}
```

### cocos_node.reset

**描述**: Reset node property, transform, or component to defaults

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `resetType`: What to reset (`string`)
- `path`: Property path for reset_property type (`string`)

**示例**:

```json
{
  "input": {
    "action": "reset",
    "node": "Canvas/Player",
    "resetType": "transform"
  }
}
```

### cocos_node.detect_type

**描述**: Detect node type (UI/2D/3D) and component summary

**参数**:

- `node`: Target node: UUID, path, or name (`string`)

**返回**: Node type classification and component list

**示例**:

```json
{
  "input": {
    "action": "detect_type",
    "node": "Canvas/Player"
  }
}
```

### cocos_node.batch_modify

**描述**: Batch modify multiple nodes' transforms in one call. Use when adjusting 3+ nodes.

**参数**:

- `nodes`: Array of node modifications. Each: {node(required), position:{x,y,z}, scale:{x,y,z}, rotation:{x,y,z}, active:bool, name:string, anchor:{x,y}, size:{width,height}} (`array`)

**返回**: Array of results for each node modification

**示例**:

```json
{
  "input": {
    "action": "batch_modify",
    "nodes": [
      {
        "node": "Canvas/Header",
        "position": {
          "x": 0,
          "y": 280,
          "z": 0
        }
      },
      {
        "node": "Canvas/Content",
        "position": {
          "x": 0,
          "y": 0,
          "z": 0
        }
      },
      {
        "node": "Canvas/Footer",
        "position": {
          "x": 0,
          "y": -280,
          "z": 0
        }
      }
    ]
  }
}
```

**注意事项**:

- Preferred over multiple modify calls for layout adjustments
- Each entry in the array is processed sequentially with the same atomicity guarantees
- If a node is not found, that entry fails but others still succeed

---

## `cocos_component`(8 个 action 指南)

### cocos_component.add

**描述**: Add component(s) to a node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `componentType`: Component type(s) e.g. "cc.Sprite" or ["cc.Sprite","cc.Button"] (`string|array`)

**返回**: Added component info

### cocos_component.remove

**描述**: Remove component from a node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `componentType`: Use exact CID from list action (e.g. "1abnc...") (`string`)

**示例**:

```json
{
  "input": {
    "action": "remove",
    "node": "Canvas/Player",
    "componentType": "1abnc..."
  }
}
```

**注意事项**:

- Use list action first to get exact CID for removal

### cocos_component.list

**描述**: List all components on a node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)

**返回**: Array of {type, cid, properties}

**示例**:

```json
{
  "input": {
    "action": "list",
    "node": "Canvas/Player"
  }
}
```

### cocos_component.info

**描述**: Get detailed component info (properties and values)

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `componentType`: Filter by type (e.g. "cc.Label"). Omit for all. (`string`)

**返回**: Component properties with current values

**示例**:

```json
{
  "input": {
    "action": "info",
    "node": "Canvas/Score",
    "componentType": "cc.Label"
  }
}
```

### cocos_component.set_property

**描述**: Set component property. Two modes: single (property+value) or batch (properties object). Type auto-detected if propertyType omitted.

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `componentType`: e.g. "cc.Label", "cc.Sprite", or script CID (`string`)
- `property`: Property name (single mode) (`string`)
- `propertyType`: Type hint (auto-detected if omitted) (`string`)
- `value`: Value to set (single mode). Format depends on propertyType. (`any`)
- `properties`: Batch mode: {"prop": {"type":"<type>","value":<val>}} (`object`)

**注意事项**:

- Single mode: property+value. Batch mode: properties object. Do NOT mix.
- Color: "#FF0000"/"#FF0000FF" or {r,g,b,a}(0-255). Vec3: {x,y,z}. Vec2: {x,y}. Size: {width,height}.
- --- SMART REFERENCE RESOLUTION ---
- For node/component/nodeArray/componentArray references: pass node NAME, PATH, or UUID as value. Examples: "ScoreLabel", "Canvas/HUD/Score", "<uuid>".
- Auto-resolves names using nearby-first strategy: child nodes > sibling nodes > global. Handles same-name ambiguity automatically.
- Component refs: auto-detects required component type from property metadata (e.g. scoreLabel needs cc.Label) and finds it on the target node.
- componentArray: pass array of node names/paths/UUIDs. Each node is resolved, matching component auto-found.
- WORKFLOW: mount_script > check assignableProperties > set_property for each. No need to manually look up UUIDs — just use node names!
- For spriteFrame: pass "db://assets/textures/xxx.png" — auto-resolved to SpriteFrame sub-asset UUID.
- propertyType is auto-detected from component dump if omitted. Explicit propertyType still supported for edge cases.
- ⚠ SPRITE SIZE WARNING: Setting spriteFrame on cc.Sprite may auto-resize the node to the sprite's original dimensions. Response includes sizeChangeInfo (sizeBefore, sizeAfter, sizeChanged). If size changed and you need a specific size, follow up with set_property on cc.UITransform.contentSize.

### cocos_component.available_types

**描述**: List available component types by category

**参数**:

- `category`: Filter category (`string`) (默认: "all")

**返回**: Array of available component types

**示例**:

```json
{
  "input": {
    "action": "available_types",
    "category": "ui"
  }
}
```

### cocos_component.click_event

**描述**: Manage Button click event handlers

**参数**:

- `node`: Button node: UUID, path, or name (`string`)
- `operation`: Event operation (`string`) (默认: "add")
- `targetNode`: Node with callback component (UUID/path/name) (`string`)
- `componentName`: Component type or script class name (e.g. "TestController") (`string`)
- `handlerName`: Callback method name on the component (`string`)
- `customEventData`: Custom string data passed to handler at runtime (`string`)
- `eventIndex`: Event index for remove/modify operation (`number`)

**注意事项**:

- add: targetNode+componentName+handlerName required
- remove: eventIndex required. clear: removes all events.
- modify: eventIndex + fields to change

### cocos_component.batch_click_event

**描述**: Bind click events on multiple buttons in one call. Use when binding 3+ button events.

**参数**:

- `events`: Array of click event bindings. Each: {node(required), target(required), componentName(required), handler(required), customEventData?(optional)} (`array`)

**返回**: Array of results for each event binding

**示例**:

```json
{
  "input": {
    "action": "batch_click_event",
    "events": [
      {
        "node": "Canvas/StartBtn",
        "target": "Canvas",
        "componentName": "GameController",
        "handler": "onStartGame"
      },
      {
        "node": "Canvas/SettingsBtn",
        "target": "Canvas",
        "componentName": "GameController",
        "handler": "onOpenSettings"
      },
      {
        "node": "Canvas/ShopBtn",
        "target": "Canvas",
        "componentName": "GameController",
        "handler": "onOpenShop"
      },
      {
        "node": "Canvas/QuitBtn",
        "target": "Canvas",
        "componentName": "GameController",
        "handler": "onQuitGame"
      }
    ]
  }
}
```

**注意事项**:

- Preferred over multiple click_event calls
- Each entry binds one click event on the specified button node
- If a node is not found, that entry fails but others still succeed

---

## `cocos_prefab`(13 个 action 指南)

### cocos_prefab.list

**描述**: List prefab assets in folder

**参数**:

- `folder`: Folder path (default: "db://assets") (`string`) (默认: "db://assets")

**返回**: Array of prefab info {name, path, uuid}

**示例**:

```json
{
  "input": {
    "action": "list",
    "folder": "db://assets/prefabs"
  }
}
```

### cocos_prefab.info

**描述**: Get prefab asset metadata

**参数**:

- `prefabPath`: Prefab path (e.g. "db://assets/prefabs/Button.prefab") (`string`)

**返回**: Prefab metadata: uuid, path, dependencies

**示例**:

```json
{
  "input": {
    "action": "info",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

### cocos_prefab.validate

**描述**: Validate prefab asset integrity

**参数**:

- `prefabPath`: Prefab path (`string`)

**返回**: Validation result with warnings

**示例**:

```json
{
  "input": {
    "action": "validate",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

### cocos_prefab.create

**描述**: Create prefab from existing scene node

**参数**:

- `nodeUuid`: Source node UUID (`string`)
- `node`: Source node: UUID, path, or name (alternative to nodeUuid) (`string`)
- `prefabName`: Prefab file name (`string`)
- `savePath`: Save folder path (e.g. "db://assets/prefabs") (`string`)

**示例**:

```json
{
  "input": {
    "action": "create",
    "node": "Canvas/MyButton",
    "prefabName": "MyButton",
    "savePath": "db://assets/prefabs"
  }
}
```

**注意事项**:

- Either nodeUuid or node required. Node must exist in scene.

### cocos_prefab.delete

**描述**: Delete prefab asset file

**参数**:

- `prefabPath`: Prefab path (`string`)

**示例**:

```json
{
  "input": {
    "action": "delete",
    "prefabPath": "db://assets/prefabs/OldButton.prefab"
  }
}
```

### cocos_prefab.instantiate

**描述**: Instantiate prefab into scene

**参数**:

- `prefabPath`: Prefab path (`string`)
- `parentUuid`: Parent node UUID (`string`)
- `parent`: Parent node: UUID, path, or name (alternative to parentUuid) (`string`)
- `position`: Initial position: {x, y, z} (`object`)

**返回**: New node UUID

**示例**:

```json
{
  "input": {
    "action": "instantiate",
    "prefabPath": "db://assets/prefabs/Enemy.prefab",
    "parent": "Canvas/GameLayer",
    "position": {
      "x": 100,
      "y": 200,
      "z": 0
    }
  }
}
```

### cocos_prefab.unlink

**描述**: Unlink node from its prefab (make independent)

**参数**:

- `nodeUuid`: Node UUID (`string`)
- `node`: Node: UUID, path, or name (alternative) (`string`)

**示例**:

```json
{
  "input": {
    "action": "unlink",
    "node": "Canvas/MyButton"
  }
}
```

### cocos_prefab.apply

**描述**: Apply scene changes back to prefab asset

**参数**:

- `nodeUuid`: Prefab instance node UUID (`string`)
- `node`: Node: UUID, path, or name (alternative) (`string`)

**示例**:

```json
{
  "input": {
    "action": "apply",
    "node": "Canvas/MyButton"
  }
}
```

**注意事项**:

- Node must be a prefab instance in scene

### cocos_prefab.revert

**描述**: Revert prefab instance to original prefab state

**参数**:

- `nodeUuid`: Prefab instance node UUID (`string`)
- `node`: Node: UUID, path, or name (alternative) (`string`)

**示例**:

```json
{
  "input": {
    "action": "revert",
    "node": "Canvas/MyButton"
  }
}
```

### cocos_prefab.edit_enter

**描述**: Enter prefab edit mode (opens prefab for editing)

**参数**:

- `prefabPath`: Prefab path (`string`)

**示例**:

```json
{
  "input": {
    "action": "edit_enter",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

**注意事项**:

- Saves current scene internally. Use edit_exit to return.
- In edit mode, scene root is still cc.Scene; check child "should_hide_in_hierarchy" to detect mode.

### cocos_prefab.edit_save

**描述**: Save changes in prefab edit mode

**参数**:

- `prefabPath`: Prefab path (must match edit_enter) (`string`)

**示例**:

```json
{
  "input": {
    "action": "edit_save",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

### cocos_prefab.edit_exit

**描述**: Exit prefab edit mode (restores previous scene)

**参数**:

- `prefabPath`: Prefab path (`string`)

**示例**:

```json
{
  "input": {
    "action": "edit_exit",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

**注意事项**:

- Always call edit_save before edit_exit if changes were made

### cocos_prefab.edit_test

**描述**: Test prefab by instantiating into current scene temporarily

**参数**:

- `prefabPath`: Prefab path (`string`)
- `parentUuid`: Parent node UUID (`string`)
- `parent`: Parent node: UUID, path, or name (`string`)

**示例**:

```json
{
  "input": {
    "action": "edit_test",
    "prefabPath": "db://assets/prefabs/Button.prefab",
    "parent": "Canvas"
  }
}
```

---

## `cocos_asset`(18 个 action 指南)

### 工具级指南

**描述**: Asset database operations: query, search, create, copy, move, delete, import, dependencies

**Action 概览**: query_info, search, find_by_name, details, create, copy, move, delete, save, reimport, import, refresh, dependencies, manifest, check_ready, query_path, query_uuid, query_url

### cocos_asset.query_info

**描述**: Get asset info by URL

**参数**:

- `url`: Asset URL (e.g. "db://assets/textures/bg.png") (`string`)

**返回**: Asset metadata: uuid, type, path, library info

**示例**:

```json
{
  "input": {
    "action": "query_info",
    "url": "db://assets/textures/bg.png"
  }
}
```

### cocos_asset.search

**描述**: Search assets by type in folder

**参数**:

- `type`: Asset type filter (e.g. "cc.ImageAsset", "cc.Prefab", "all") (`string`) (默认: "all")
- `folder`: Folder to search (default: "db://assets") (`string`)

**返回**: Array of matching assets

**示例**:

```json
{
  "input": {
    "action": "search",
    "type": "cc.Prefab",
    "folder": "db://assets/prefabs"
  }
}
```

### cocos_asset.find_by_name

**描述**: Find assets by name pattern

**参数**:

- `name`: Asset name pattern (`string`)
- `type`: Asset type filter (`string`)
- `folder`: Folder to search (`string`)

**返回**: Array of matching assets

**示例**:

```json
{
  "input": {
    "action": "find_by_name",
    "name": "player",
    "type": "cc.ImageAsset"
  }
}
```

### cocos_asset.details

**描述**: Get detailed asset info including sub-assets

**参数**:

- `url`: Asset URL (`string`)
- `includeSubAssets`: Include sub-assets (`boolean`) (默认: true)

**返回**: Full asset details with sub-assets

**示例**:

```json
{
  "input": {
    "action": "details",
    "url": "db://assets/textures/atlas.plist"
  }
}
```

### cocos_asset.create

**描述**: Create a new asset file

**参数**:

- `url`: Target URL (e.g. "db://assets/scripts/NewScript.ts") (`string`)
- `content`: File content (`string`)
- `overwrite`: Overwrite if exists (`boolean`) (默认: false)

**示例**:

```json
{
  "input": {
    "action": "create",
    "url": "db://assets/scripts/GameManager.ts",
    "content": "import { _decorator } from \"cc\";\n..."
  }
}
```

### cocos_asset.copy

**描述**: Copy asset to new location

**参数**:

- `source`: Source asset URL (`string`)
- `target`: Target URL (`string`)
- `overwrite`: Overwrite if exists (`boolean`) (默认: false)

**示例**:

```json
{
  "input": {
    "action": "copy",
    "source": "db://assets/scripts/Template.ts",
    "target": "db://assets/scripts/Player.ts"
  }
}
```

### cocos_asset.move

**描述**: Move/rename asset

**参数**:

- `source`: Source asset URL (`string`)
- `target`: Target URL (`string`)
- `overwrite`: Overwrite if exists (`boolean`) (默认: false)

**示例**:

```json
{
  "input": {
    "action": "move",
    "source": "db://assets/old.ts",
    "target": "db://assets/scripts/new.ts"
  }
}
```

### cocos_asset.delete

**描述**: Delete an asset

**参数**:

- `url`: Asset URL to delete (`string`)

**示例**:

```json
{
  "input": {
    "action": "delete",
    "url": "db://assets/unused/old-sprite.png"
  }
}
```

### cocos_asset.save

**描述**: Save/overwrite asset content

**参数**:

- `url`: Asset URL (`string`)
- `content`: New file content (`string`)

**示例**:

```json
{
  "input": {
    "action": "save",
    "url": "db://assets/scripts/Config.ts",
    "content": "export const CONFIG = {...}"
  }
}
```

### cocos_asset.reimport

**描述**: Force reimport an asset

**参数**:

- `url`: Asset URL (`string`)

**示例**:

```json
{
  "input": {
    "action": "reimport",
    "url": "db://assets/textures/bg.png"
  }
}
```

### cocos_asset.import

**描述**: Import external file into project

**参数**:

- `sourcePath`: External file system path (`string`)
- `targetFolder`: Target folder in project (e.g. "db://assets/textures") (`string`)

**示例**:

```json
{
  "input": {
    "action": "import",
    "sourcePath": "/Users/me/Desktop/icon.png",
    "targetFolder": "db://assets/textures"
  }
}
```

### cocos_asset.refresh

**描述**: Refresh asset database

**参数**:

- `folder`: Folder to refresh (default: entire db) (`string`)

**示例**:

```json
{
  "input": {
    "action": "refresh"
  }
}
```

### cocos_asset.dependencies

**描述**: Get asset dependency tree

**参数**:

- `url`: Asset URL (`string`)
- `deep`: Deep/recursive analysis (`boolean`) (默认: true)

**返回**: Dependency tree

**示例**:

```json
{
  "input": {
    "action": "dependencies",
    "url": "db://assets/prefabs/Player.prefab",
    "deep": true
  }
}
```

### cocos_asset.manifest

**描述**: Get asset manifest/summary for a folder

**参数**:

- `folder`: Folder (default: "db://assets") (`string`)
- `format`: Output format (`string`) (默认: "json")

**返回**: Asset manifest with counts by type

**示例**:

```json
{
  "input": {
    "action": "manifest",
    "folder": "db://assets"
  }
}
```

### cocos_asset.check_ready

**描述**: Check if asset database is ready

**返回**: Boolean ready state

**示例**:

```json
{
  "input": {
    "action": "check_ready"
  }
}
```

### cocos_asset.query_path

**描述**: Get filesystem path for asset URL

**参数**:

- `url`: Asset URL (`string`)

**返回**: Absolute filesystem path

**示例**:

```json
{
  "input": {
    "action": "query_path",
    "url": "db://assets/scripts/Game.ts"
  }
}
```

### cocos_asset.query_uuid

**描述**: Get UUID for asset URL

**参数**:

- `url`: Asset URL (`string`)

**返回**: Asset UUID string

**示例**:

```json
{
  "input": {
    "action": "query_uuid",
    "url": "db://assets/textures/bg.png"
  }
}
```

### cocos_asset.query_url

**描述**: Get asset URL from UUID

**参数**:

- `uuid`: Asset UUID (`string`)

**返回**: Asset URL string

**示例**:

```json
{
  "input": {
    "action": "query_url",
    "uuid": "abc-123-def"
  }
}
```

---

## `cocos_editor`(32 个 action 指南)

### 工具级指南

**描述**: Editor operations: project info, build, preview, console logs, preferences, server status

**Action 概览**: project_info, project_settings, run, build, build_settings, open_build_panel, builder_status, start_preview, stop_preview, console_logs, console_clear, log_read, log_search, log_info, mcp_log_read, mcp_log_clear, editor_info, performance, pref_open, pref_get, pref_set, pref_reset, pref_all, pref_categories, pref_search, pref_export, server_ips, server_port, server_status, server_test, server_interfaces, reload

### cocos_editor.project_info

**描述**: Get project info (name, path, engine version)

**返回**: Project name, path, engine version, settings

**示例**:

```json
{
  "input": {
    "action": "project_info"
  }
}
```

### cocos_editor.project_settings

**描述**: Get project settings by category

**参数**:

- `category`: Settings category (e.g. "general", "physics") (`string`)

**返回**: Settings object for category

**示例**:

```json
{
  "input": {
    "action": "project_settings",
    "category": "general"
  }
}
```

### cocos_editor.run

**描述**: Run/preview the project

**示例**:

```json
{
  "input": {
    "action": "run"
  }
}
```

### cocos_editor.build

**描述**: Build the project

**参数**:

- `platform`: Build platform (e.g. "web-mobile", "android") (`string`)

**示例**:

```json
{
  "input": {
    "action": "build",
    "platform": "web-mobile"
  }
}
```

### cocos_editor.build_settings

**描述**: Get current build settings

**返回**: Build configuration

**示例**:

```json
{
  "input": {
    "action": "build_settings"
  }
}
```

### cocos_editor.open_build_panel

**描述**: Open the Build panel in editor

**示例**:

```json
{
  "input": {
    "action": "open_build_panel"
  }
}
```

### cocos_editor.builder_status

**描述**: Check builder/compile status

**返回**: Builder status info

**示例**:

```json
{
  "input": {
    "action": "builder_status"
  }
}
```

### cocos_editor.start_preview

**描述**: Start preview server

**参数**:

- `port`: Preview server port (`number`)

**示例**:

```json
{
  "input": {
    "action": "start_preview"
  }
}
```

### cocos_editor.stop_preview

**描述**: Stop preview server

**示例**:

```json
{
  "input": {
    "action": "stop_preview"
  }
}
```

### cocos_editor.console_logs

**描述**: Get console log entries

**参数**:

- `limit`: Max entries to return (`number`)
- `logType`: Filter: "log", "warn", or "error" (`string`)

**返回**: Array of log entries

**示例**:

```json
{
  "input": {
    "action": "console_logs",
    "limit": 20,
    "logType": "error"
  }
}
```

### cocos_editor.console_clear

**描述**: Clear console logs

**示例**:

```json
{
  "input": {
    "action": "console_clear"
  }
}
```

### cocos_editor.log_read

**描述**: Read editor log file

**参数**:

- `lines`: Number of lines to read (`number`)
- `keyword`: Filter by keyword (`string`)
- `logType`: Log type filter (`string`)

**返回**: Log file content

**示例**:

```json
{
  "input": {
    "action": "log_read",
    "lines": 50,
    "keyword": "ERROR"
  }
}
```

### cocos_editor.log_search

**描述**: Search logs by keyword

**参数**:

- `keyword`: Search keyword (`string`)

**返回**: Matching log entries

**示例**:

```json
{
  "input": {
    "action": "log_search",
    "keyword": "TypeError"
  }
}
```

### cocos_editor.log_info

**描述**: Get log file info (path, size)

**返回**: Log file metadata

**示例**:

```json
{
  "input": {
    "action": "log_info"
  }
}
```

### cocos_editor.mcp_log_read

**描述**: Read MCP server log

**参数**:

- `lines`: Number of lines (`number`)
- `keyword`: Filter keyword (`string`)

**示例**:

```json
{
  "input": {
    "action": "mcp_log_read",
    "lines": 30
  }
}
```

### cocos_editor.mcp_log_clear

**描述**: Clear MCP server log

**示例**:

```json
{
  "input": {
    "action": "mcp_log_clear"
  }
}
```

### cocos_editor.editor_info

**描述**: Get editor info (version, platform, language)

**返回**: Editor version, platform, language

**示例**:

```json
{
  "input": {
    "action": "editor_info"
  }
}
```

### cocos_editor.performance

**描述**: Get editor performance metrics

**返回**: Memory, CPU, and timing info

**示例**:

```json
{
  "input": {
    "action": "performance"
  }
}
```

### cocos_editor.pref_open

**描述**: Open Preferences panel

**参数**:

- `tab`: Tab to open (`string`)

**示例**:

```json
{
  "input": {
    "action": "pref_open",
    "tab": "general"
  }
}
```

### cocos_editor.pref_get

**描述**: Get preference value

**参数**:

- `category`: Preference category (`string`)
- `path`: Config path within category (`string`)

**返回**: Preference value

**示例**:

```json
{
  "input": {
    "action": "pref_get",
    "category": "general",
    "path": "language"
  }
}
```

### cocos_editor.pref_set

**描述**: Set preference value

**参数**:

- `category`: Preference category (`string`)
- `path`: Config path (`string`)
- `value`: Value to set (`any`)

**示例**:

```json
{
  "input": {
    "action": "pref_set",
    "category": "general",
    "path": "language",
    "value": "en"
  }
}
```

### cocos_editor.pref_reset

**描述**: Reset preference category to defaults

**参数**:

- `category`: Category to reset (`string`)

**示例**:

```json
{
  "input": {
    "action": "pref_reset",
    "category": "general"
  }
}
```

### cocos_editor.pref_all

**描述**: Get all preferences

**返回**: All preference categories and values

**示例**:

```json
{
  "input": {
    "action": "pref_all"
  }
}
```

### cocos_editor.pref_categories

**描述**: List available preference categories

**返回**: Array of category names

**示例**:

```json
{
  "input": {
    "action": "pref_categories"
  }
}
```

### cocos_editor.pref_search

**描述**: Search preferences by keyword

**参数**:

- `query`: Search query (`string`)

**返回**: Matching preference entries

**示例**:

```json
{
  "input": {
    "action": "pref_search",
    "query": "font"
  }
}
```

### cocos_editor.pref_export

**描述**: Export all preferences as JSON

**返回**: Full preferences JSON

**示例**:

```json
{
  "input": {
    "action": "pref_export"
  }
}
```

### cocos_editor.server_ips

**描述**: Get server IP addresses

**返回**: Array of IP addresses

**示例**:

```json
{
  "input": {
    "action": "server_ips"
  }
}
```

### cocos_editor.server_port

**描述**: Get MCP server port

**返回**: Port number

**示例**:

```json
{
  "input": {
    "action": "server_port"
  }
}
```

### cocos_editor.server_status

**描述**: Get MCP server status

**返回**: Server running state and info

**示例**:

```json
{
  "input": {
    "action": "server_status"
  }
}
```

### cocos_editor.server_test

**描述**: Test server connectivity

**参数**:

- `timeout`: Timeout in ms (`number`)

**返回**: Connection test result

**示例**:

```json
{
  "input": {
    "action": "server_test",
    "timeout": 5000
  }
}
```

### cocos_editor.server_interfaces

**描述**: List network interfaces

**返回**: Network interface details

**示例**:

```json
{
  "input": {
    "action": "server_interfaces"
  }
}
```

### cocos_editor.reload

**描述**: Reload editor window (equivalent to Developer → 重新加载)

**示例**:

```json
{
  "input": {
    "action": "reload"
  }
}
```

---

## `cocos_view`(32 个 action 指南)

### cocos_view.gizmo_tool

**描述**: Set active gizmo tool

**参数**:

- `tool`: Tool name (`string`)

**示例**:

```json
{
  "input": {
    "action": "gizmo_tool",
    "tool": "position"
  }
}
```

### cocos_view.gizmo_tool_query

**描述**: Get current active gizmo tool

**返回**: Current tool name

**示例**:

```json
{
  "input": {
    "action": "gizmo_tool_query"
  }
}
```

### cocos_view.gizmo_pivot

**描述**: Set gizmo pivot mode

**参数**:

- `pivot`: Pivot mode (`string`)

**示例**:

```json
{
  "input": {
    "action": "gizmo_pivot",
    "pivot": "center"
  }
}
```

### cocos_view.gizmo_pivot_query

**描述**: Get current gizmo pivot mode

**返回**: Current pivot mode

**示例**:

```json
{
  "input": {
    "action": "gizmo_pivot_query"
  }
}
```

### cocos_view.gizmo_coordinate

**描述**: Set gizmo coordinate system

**参数**:

- `coordinate`: Coordinate system (`string`)

**示例**:

```json
{
  "input": {
    "action": "gizmo_coordinate",
    "coordinate": "local"
  }
}
```

### cocos_view.gizmo_coordinate_query

**描述**: Get current coordinate system

**返回**: Current coordinate system

**示例**:

```json
{
  "input": {
    "action": "gizmo_coordinate_query"
  }
}
```

### cocos_view.gizmo_view_mode

**描述**: Get current gizmo view mode info

**返回**: View mode details

**示例**:

```json
{
  "input": {
    "action": "gizmo_view_mode"
  }
}
```

### cocos_view.mode_2d_3d

**描述**: Switch between 2D and 3D editor mode

**参数**:

- `is2D`: true=2D mode, false=3D mode (`boolean`)

**示例**:

```json
{
  "input": {
    "action": "mode_2d_3d",
    "is2D": true
  }
}
```

### cocos_view.mode_query

**描述**: Get current 2D/3D mode

**返回**: Current mode state

**示例**:

```json
{
  "input": {
    "action": "mode_query"
  }
}
```

### cocos_view.grid_set

**描述**: Show/hide scene grid

**参数**:

- `visible`: Grid visibility (`boolean`)

**示例**:

```json
{
  "input": {
    "action": "grid_set",
    "visible": true
  }
}
```

### cocos_view.grid_query

**描述**: Get grid visibility state

**返回**: Boolean visible state

**示例**:

```json
{
  "input": {
    "action": "grid_query"
  }
}
```

### cocos_view.icon_3d_mode

**描述**: Set 3D icon gizmo display mode

**参数**:

- `mode`: Icon display mode (`string`)

**示例**:

```json
{
  "input": {
    "action": "icon_3d_mode",
    "mode": "normal"
  }
}
```

### cocos_view.icon_3d_query

**描述**: Get current 3D icon mode

**返回**: Current icon mode

**示例**:

```json
{
  "input": {
    "action": "icon_3d_query"
  }
}
```

### cocos_view.icon_size

**描述**: Set icon gizmo size

**参数**:

- `size`: Icon size value (`number`)

**示例**:

```json
{
  "input": {
    "action": "icon_size",
    "size": 32
  }
}
```

### cocos_view.icon_size_query

**描述**: Get current icon size

**返回**: Current size value

**示例**:

```json
{
  "input": {
    "action": "icon_size_query"
  }
}
```

### cocos_view.camera_focus

**描述**: Focus camera on node(s)

**参数**:

- `nodes`: Node UUIDs to focus on (default: current selection) (`array`)

**示例**:

```json
{
  "input": {
    "action": "camera_focus",
    "nodes": [
      "uuid-1"
    ]
  }
}
```

### cocos_view.camera_align_view

**描述**: Align selected node to current camera view

**示例**:

```json
{
  "input": {
    "action": "camera_align_view"
  }
}
```

### cocos_view.camera_align_node

**描述**: Align camera to selected node view

**参数**:

- `nodes`: Node UUIDs (`array`)

**示例**:

```json
{
  "input": {
    "action": "camera_align_node",
    "nodes": [
      "uuid-1"
    ]
  }
}
```

### cocos_view.status

**描述**: Get scene view status (mode, grid, gizmo state)

**返回**: Full scene view status

**示例**:

```json
{
  "input": {
    "action": "status"
  }
}
```

### cocos_view.reset_view

**描述**: Reset scene view to default

**示例**:

```json
{
  "input": {
    "action": "reset_view"
  }
}
```

### cocos_view.ref_add

**描述**: Add reference image to scene view

**参数**:

- `imagePath`: Local image path (e.g. "db://assets/ref/design.png") (`string`)
- `imageUrl`: Image URL (alternative to imagePath) (`string`)

**示例**:

```json
{
  "input": {
    "action": "ref_add",
    "imagePath": "db://assets/ref/mockup.png"
  }
}
```

**注意事项**:

- Provide either imagePath or imageUrl, not both

### cocos_view.ref_remove

**描述**: Remove a reference image

**参数**:

- `imageId`: Reference image ID (`string`)

**示例**:

```json
{
  "input": {
    "action": "ref_remove",
    "imageId": "ref-123"
  }
}
```

### cocos_view.ref_switch

**描述**: Switch active reference image by index

**参数**:

- `index`: Image index (0-based) (`number`)

**示例**:

```json
{
  "input": {
    "action": "ref_switch",
    "index": 0
  }
}
```

### cocos_view.ref_clear

**描述**: Remove all reference images

**示例**:

```json
{
  "input": {
    "action": "ref_clear"
  }
}
```

### cocos_view.ref_config

**描述**: Get reference image configuration

**返回**: Current ref image config

**示例**:

```json
{
  "input": {
    "action": "ref_config"
  }
}
```

### cocos_view.ref_current

**描述**: Get current active reference image info

**返回**: Active image details

**示例**:

```json
{
  "input": {
    "action": "ref_current"
  }
}
```

### cocos_view.ref_list

**描述**: List all reference images

**返回**: Array of reference images

**示例**:

```json
{
  "input": {
    "action": "ref_list"
  }
}
```

### cocos_view.ref_position

**描述**: Set reference image position

**参数**:

- `x`: X position (`number`)
- `y`: Y position (`number`)

**示例**:

```json
{
  "input": {
    "action": "ref_position",
    "x": 0,
    "y": 0
  }
}
```

### cocos_view.ref_scale

**描述**: Set reference image scale

**参数**:

- `scaleValue`: Scale value (1.0 = original) (`number`)

**示例**:

```json
{
  "input": {
    "action": "ref_scale",
    "scaleValue": 0.5
  }
}
```

### cocos_view.ref_opacity

**描述**: Set reference image opacity

**参数**:

- `opacity`: Opacity value (0-1) (`number`)

**示例**:

```json
{
  "input": {
    "action": "ref_opacity",
    "opacity": 0.5
  }
}
```

### cocos_view.ref_data

**描述**: Set raw reference image data

**参数**:

- `data`: Raw reference image data object (`object`)

**示例**:

```json
{
  "input": {
    "action": "ref_data",
    "data": {
      "x": 0,
      "y": 0,
      "scale": 1,
      "opacity": 0.8
    }
  }
}
```

### cocos_view.ref_refresh

**描述**: Refresh reference image display

**示例**:

```json
{
  "input": {
    "action": "ref_refresh"
  }
}
```

---

## `cocos_composite`(10 个 action 指南)

### cocos_composite.create_button

**描述**: Create a complete Button node (with Label, Sprite, Button component)

**参数**:

- `parent`: Parent node: UUID, path, or name (`string`)
- `name`: Button node name (`string`)
- `text`: Button label text (`string`)
- `fontSize`: Font size (`number`) (默认: 28)
- `size`: {width, height} (`object`)
- `position`: {x, y} (`object`)
- `color`: Color: "#hex" or {r,g,b,a} (`any`)
- `spriteFrame`: Button normal-state sprite frame path (e.g. "db://assets/resources/textures/ui/btn-normal/spriteFrame") (`string`)
- `pressedSpriteFrame`: Button pressed-state sprite frame path (e.g. "db://assets/resources/textures/ui/btn-pressed/spriteFrame") (`string`)

**示例**:

```json
{
  "input": {
    "action": "create_button",
    "parent": "Canvas",
    "name": "StartBtn",
    "text": "Start Game",
    "fontSize": 32,
    "size": {
      "width": 200,
      "height": 60
    },
    "spriteFrame": "db://assets/resources/textures/ui/btn-normal/spriteFrame",
    "pressedSpriteFrame": "db://assets/resources/textures/ui/btn-pressed/spriteFrame"
  }
}
```

**注意事项**:

- Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2)
- Response includes viewport context. Out-of-bounds positions trigger warnings.
- Button auto-configured: Sprite sizeMode=CUSTOM, \_type=SLICED(nine-slice), Button transition=SPRITE, Label overflow=SHRINK(auto-fit text)
- IMPORTANT: After creation, bind click event with cocos_component(action:"click_event") — buttons without click events do nothing when clicked

### cocos_composite.create_label

**描述**: Create a Label node

**参数**:

- `parent`: Parent node: UUID, path, or name (`string`)
- `name`: Label node name (`string`)
- `text`: Text content (`string`)
- `fontSize`: Font size (`number`) (默认: 28)
- `size`: {width, height} (`object`)
- `position`: {x, y} (`object`)

**示例**:

```json
{
  "input": {
    "action": "create_label",
    "parent": "Canvas/HUD",
    "name": "Score",
    "text": "Score: 0",
    "fontSize": 24
  }
}
```

**注意事项**:

- Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2)
- Response includes viewport context. Out-of-bounds positions trigger warnings.

### cocos_composite.create_image

**描述**: Create a Sprite/image node

**参数**:

- `parent`: Parent node: UUID, path, or name (`string`)
- `name`: Sprite node name (`string`)
- `size`: {width, height} (`object`)
- `position`: {x, y} (`object`)
- `spriteFrame`: Sprite frame path or "default" (`string`)

**示例**:

```json
{
  "input": {
    "action": "create_image",
    "parent": "Canvas",
    "name": "BgImage",
    "spriteFrame": "db://assets/textures/bg/spriteFrame",
    "size": {
      "width": 960,
      "height": 640
    }
  }
}
```

**注意事项**:

- Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2)
- Response includes viewport context. Out-of-bounds positions trigger warnings.

### cocos_composite.create_ui

**描述**: Create any built-in UI control from engine prefab template — produces the exact result as editor menu → Create → UI → {type}

**参数**:

- `type`: Built-in UI type: Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, Graphics, Mask, Layout, Widget, ParticleSystem2D, VideoPlayer, WebView, TiledMap (`string`)
- `parent`: Parent node: UUID, path, or name (default: Canvas) (`string`)
- `name`: Custom node name (`string`)
- `position`: {x, y} (`object`)
- `size`: {width, height} (`object`)
- `spriteFrame`: Sprite frame path for root Sprite component (e.g. "db://assets/textures/btn/spriteFrame" or "default") (`string`)
- `text`: Text content for Label component (root or Label child) (`string`)
- `fontSize`: Font size for Label component (`number`)
- `color`: Root Sprite color: "#hex" or {r,g,b,a} (`any`)

**示例**:

```json
{
  "input": {
    "action": "create_ui",
    "type": "Button",
    "parent": "Canvas",
    "name": "StartBtn",
    "text": "Start",
    "spriteFrame": "db://assets/textures/ui/btn/spriteFrame"
  }
}
```

**注意事项**:

- Preferred over manual node+component creation — engine handles all internal structure, child nodes, bindings, and defaults
- Response includes childUuids map (childName → UUID). Use UUIDs to modify children: cocos_component(action:"set_property", node:"<UUID>", ...)
- spriteFrame/text/fontSize/color are convenience shortcuts — for deeper customization, use childUuids + cocos_component
- For complex multi-level UI, prefer cocos_builder with type field on each node

### cocos_composite.mount_and_bind

**描述**: Mount script to node and bind properties to child nodes/assets

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `scriptPath`: Script asset path (e.g. "db://assets/scripts/Game.ts") (`string`)
- `bindings`: Property bindings: {"propName": "NodeName" or "Canvas/Path/Node" or "db://asset/path"}. Node names auto-resolved with nearby-first strategy. (`object`)

**示例**:

```json
{
  "input": {
    "action": "mount_and_bind",
    "node": "Canvas/Dialog",
    "scriptPath": "db://assets/scripts/DialogController.ts",
    "bindings": {
      "titleLabel": "Title",
      "confirmBtn": "ButtonGroup/Confirm"
    }
  }
}
```

**注意事项**:

- bindings values: node names/paths (auto-resolved), asset db:// URLs, or UUIDs. Same-name nodes resolved by proximity to target node.

### cocos_composite.setup_widget

**描述**: Configure Widget component alignment on a node

**参数**:

- `node`: Target node: UUID, path, or name (`string`)
- `align`: Alignment preset (`string`)
- `margin`: Margins: {top, bottom, left, right} (`object`)

**示例**:

```json
{
  "input": {
    "action": "setup_widget",
    "node": "Canvas/Background",
    "align": "full",
    "margin": {
      "top": 0,
      "bottom": 0,
      "left": 0,
      "right": 0
    }
  }
}
```

**注意事项**:

- Automatically adds Widget component if not present

### cocos_composite.batch

**描述**: Batch create multiple nodes from template or source

**参数**:

- `parent`: Parent node: UUID, path, or name (`string`)
- `count`: Number of items to create (`number`)
- `template`: Template definition: {type, text, ...} (`object`)
- `source`: Source node to clone (UUID, path, or name) (`string`)
- `namePrefix`: Name prefix for items (e.g. "Item" → "Item_0", "Item_1") (`string`)

**示例**:

```json
{
  "input": {
    "action": "batch",
    "parent": "Canvas/List",
    "count": 5,
    "source": "Canvas/List/ItemTemplate",
    "namePrefix": "ListItem"
  }
}
```

**注意事项**:

- Use template for new nodes, or source to clone existing node

### cocos_composite.batch_create_button

**描述**: Batch create multiple complete Button nodes in one call (3+ buttons → use this)

**参数**:

- `parent`: Default parent node for all buttons (can be overridden per-button) (`string`)
- `buttons`: Array of button definitions: [{name, text?, fontSize?, size?, spriteFrame?, color?, clickEvent?, position?}] (`array`)

**示例**:

```json
{
  "input": {
    "action": "batch_create_button",
    "parent": "Canvas",
    "buttons": [
      {
        "name": "StartBtn",
        "text": "Start",
        "size": {
          "width": 200,
          "height": 60
        }
      },
      {
        "name": "QuitBtn",
        "text": "Quit",
        "size": {
          "width": 200,
          "height": 60
        },
        "position": {
          "x": 0,
          "y": -80
        }
      }
    ]
  }
}
```

**注意事项**:

- Each button is created using the same logic as create_button
- Per-button position is set after creation if provided
- Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

### cocos_composite.batch_create_label

**描述**: Batch create multiple Label nodes in one call (3+ labels → use this)

**参数**:

- `parent`: Default parent node for all labels (can be overridden per-label) (`string`)
- `labels`: Array of label definitions: [{name, text, fontSize?, color?, position?}] (`array`)

**示例**:

```json
{
  "input": {
    "action": "batch_create_label",
    "parent": "Canvas/HUD",
    "labels": [
      {
        "name": "Score",
        "text": "Score: 0",
        "fontSize": 24
      },
      {
        "name": "Lives",
        "text": "Lives: 3",
        "fontSize": 24,
        "position": {
          "x": 200,
          "y": 0
        }
      }
    ]
  }
}
```

**注意事项**:

- Each label is created using the same logic as create_label
- Per-label position and color are set after creation if provided
- Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

### cocos_composite.batch_create_image

**描述**: Batch create multiple Sprite/image nodes in one call (3+ images → use this)

**参数**:

- `parent`: Default parent node for all images (can be overridden per-image) (`string`)
- `images`: Array of image definitions: [{name, spriteFrame, size?, position?}] (`array`)

**示例**:

```json
{
  "input": {
    "action": "batch_create_image",
    "parent": "Canvas",
    "images": [
      {
        "name": "Icon1",
        "spriteFrame": "db://assets/textures/icon1/spriteFrame",
        "size": {
          "width": 64,
          "height": 64
        }
      },
      {
        "name": "Icon2",
        "spriteFrame": "db://assets/textures/icon2/spriteFrame",
        "size": {
          "width": 64,
          "height": 64
        },
        "position": {
          "x": 80,
          "y": 0
        }
      }
    ]
  }
}
```

**注意事项**:

- Each image is created using the same logic as create_image
- Per-image position is set after creation if provided
- Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

---

## `cocos_validate`(3 个 action 指南)

### cocos_validate.layout

**描述**: Validate UI layout (overlaps, out-of-bounds, sizing issues)

**参数**:

- `rootNode`: Root node to validate (default: entire scene) (`string`)

**返回**: Array of layout issues with severity and fix suggestions

**示例**:

```json
{
  "input": {
    "action": "layout"
  }
}
```

### cocos_validate.references

**描述**: Check for broken asset/node references

**参数**:

- `rootNode`: Root node to validate (default: entire scene) (`string`)

**返回**: Array of broken references with affected nodes

**示例**:

```json
{
  "input": {
    "action": "references",
    "rootNode": "Canvas"
  }
}
```

### cocos_validate.hierarchy

**描述**: Validate node hierarchy (depth, naming, structure)

**参数**:

- `rootNode`: Root node to validate (default: entire scene) (`string`)

**返回**: Array of hierarchy issues

**示例**:

```json
{
  "input": {
    "action": "hierarchy"
  }
}
```

---

## `cocos_template`(2 个 action 指南)

### cocos_template.list

**描述**: List available UI templates

**返回**: Array of template names and descriptions

**示例**:

```json
{
  "input": {
    "action": "list"
  }
}
```

### cocos_template.apply

**描述**: Apply a UI template (creates complete node hierarchy via builder engine)

**参数**:

- `template`: Template name (`string`)
- `parent`: Parent node: UUID, path, or name (default: Canvas) (`string`)
- `name`: Root node name override (`string`)

**返回**: { rootUuid, rootName, totalCreated, nodes[], errors[], warnings[], postBuildActions?[] }

**示例**:

```json
{
  "input": {
    "action": "apply",
    "template": "dialog",
    "parent": "Canvas",
    "name": "ConfirmDialog"
  }
}
```

**注意事项**:

- Templates now use the builder engine — all builder features (UIRenderer conflict detection, default sprite, postBuildActions) apply automatically
- After apply, check postBuildActions for required property linking (e.g. ScrollView.content)
- Template nodes come with sensible defaults (sizes, colors, text). Customize with set_component_property after creation.

---

## `cocos_capture`(2 个 action 指南)

### cocos_capture.scene_snapshot

**描述**: Full scene layout snapshot. Returns structured JSON with: scene name, design resolution, cameras, and full node hierarchy (name, position, size, widget alignment, label text, active state). Use this to understand the overall scene structure.

**参数**:

- `maxDepth`: Max hierarchy traversal depth (`number`) (默认: 10)

**返回**: { sceneName, resolution:{width,height,fitWidth,fitHeight}, cameras:[{nodeName,enabled,projection,...}], totalNodes, maxDepth, hierarchy:[{name,uuid,path,active,position:{x,y},size:{width,height},anchor?,scale?,rotation?,opacity?,components:[],widget?,label?,children?}] }

**示例**:

```json
{
  "input": {
    "action": "scene_snapshot"
  },
  "output": "Full scene JSON with hierarchy, resolution 960x640, 1 camera"
}
```

**注意事项**:

- Each node includes: name, uuid, path, active, position(x,y), size(width,height), components list
- Optional fields only appear when non-default: anchor(if not 0.5,0.5), scale(if not 1,1), rotation(if not 0), opacity(if not 255)
- Widget alignment info included when cc.Widget is present: alignFlags[], top/bottom/left/right margins
- Label text and fontSize included when cc.Label is present
- Cameras detected automatically from any cc.Camera components in the tree
- Design resolution extracted from cc.Canvas component (fitWidth/fitHeight adaptation mode)
- Nodes beyond maxDepth show \_childCount instead of children array

### cocos_capture.node_snapshot

**描述**: Focused snapshot of a specific node and its subtree. Returns layout hierarchy plus detailed component properties for the node and its children. Handles duplicate names via UUID or path.

**参数**:

- `node`: Target node: UUID, path (e.g. "Canvas/Panel"), or name. Use path or UUID for duplicate names. (`string`)
- `maxDepth`: Max hierarchy traversal depth (`number`) (默认: 15)

**返回**: { rootName, rootUuid, rootPath, totalNodes, maxDepth, cameras, layout:{...compact hierarchy...}, componentDetails:{nodeName:[{type,size?,string?,fontSize?,color?,widget?,...}]} }

**注意事项**:

- layout: same compact hierarchy format as scene_snapshot, but includes sprite info (spriteFrame, sizeMode)
- componentDetails: per-node component breakdown with type-specific properties extracted
- Component properties extracted: UITransform(size,anchor), Label(string,fontSize,align,color,wrap), Sprite(spriteFrame,type,sizeMode,color), Button(transition,normalColor,zoomScale), Widget(alignment), Layout(type,spacing), ProgressBar(progress), Camera(projection,fov)
- For duplicate node names, use path format: "Canvas/Panel/MyButton" or UUID directly
- componentDetails covers root + up to 3 levels of children for performance

---

## `cocos_builder`(1 个 action 指南)

### cocos_builder.build

**描述**: Build a complete node tree from a JSON definition. Creates nodes, adds components, sets properties recursively in one call.

**参数**:

- `parent`: Parent node: UUID, path, or name (default: "Canvas") (`string`)
- `tree`: Node tree JSON. Each node object has: name(required), position({x,y}), size({width,height}), color("#hex" or {r,g,b,a}), anchor({x,y}), scale(number or {x,y}), rotation(number), opacity(0-255), active(bool), components(string[]), props({componentType:{prop:value}}), children(node[]) (`object`)
- `clean`: Remove all children of parent before building (default: false) (`boolean`)

**返回**: { rootUuid, rootName, totalCreated, nodes: [{name,uuid,path,depth,components?}], errors[], warnings[], postBuildActions?[] }

**注意事项**:

- --- JSON NODE FORMAT ---
- Required: "name" (string) — node name
- PREFAB SHORTCUT: "type" (string) — set to a built-in UI type (Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, Graphics, Mask, Layout, Widget, ParticleSystem2D, VideoPlayer, WebView, TiledMap) to create a complete control from engine prefab template. When using "type", you do NOT need "components" — the prefab handles everything. Children matching prefab children (e.g. "Label" in Button) have props applied to existing nodes instead of creating new ones.
- Shortcuts (node-level): position({x,y,z?}), size({width,height}), color("#hex"|{r,g,b,a}), anchor({x,y}), scale(number|{x,y}), rotation(number, Z-axis degrees), opacity(0-255, auto-adds UIOpacity), active(bool)
- Components: string array like ["cc.Sprite","cc.Button"]. Do NOT include "cc.UITransform" — engine auto-creates it. Not needed when using "type".
- Props: grouped by component type. Example: { "cc.Label": { "string": "Hello", "fontSize": 28 } }
- Children: array of nested node objects (same format recursively)
- --- PROPERTY VALUE FORMATS ---
- Number/String/Boolean: write directly — "fontSize": 28, "string": "Hello", "enabled": true
- Color: "#FF0000" or "#FF0000FF" (with alpha) or {r:255, g:0, b:0, a:255}
- Asset reference: "db://assets/textures/icon/spriteFrame" — auto-resolved to UUID
- SpriteFrame shortcuts: "default", "button", "panel", "image", "toggle", "scrollbar"
- Enum values: use numbers — sizeMode: 0(CUSTOM)/1(TRIMMED)/2(RAW), horizontalAlign: 0(LEFT)/1(CENTER)/2(RIGHT), verticalAlign: 0(TOP)/1(CENTER)/2(BOTTOM), overflow: 0(NONE)/1(CLAMP)/2(SHRINK)/3(RESIZE_HEIGHT), transition(Button): 0(NONE)/1(COLOR)/2(SPRITE)/3(SCALE)
- --- AVAILABLE COMPONENTS ---
- Renderer: cc.Sprite, cc.Label, cc.RichText, cc.Graphics, cc.Mask, cc.TiledMap, cc.Spine, cc.DragonBones
- UI: cc.Button, cc.Toggle, cc.ToggleContainer, cc.Slider, cc.ProgressBar, cc.EditBox, cc.ScrollView, cc.PageView, cc.ScrollBar
- Layout: cc.Widget, cc.Layout, cc.UITransform(auto), cc.UIOpacity(auto for opacity shortcut), cc.Canvas, cc.SafeArea, cc.BlockInputEvents
- Animation: cc.Animation, cc.Skeleton
- Audio: cc.AudioSource
- Camera: cc.Camera
- --- COMMON COMPONENT PROPERTIES ---
- cc.Sprite: spriteFrame("db://..." or "default"), sizeMode(0=CUSTOM,1=TRIMMED,2=RAW), type(0=SIMPLE,1=SLICED,2=TILED,3=FILLED), color("#hex")
- cc.Label: string, fontSize, lineHeight, horizontalAlign(0=LEFT,1=CENTER,2=RIGHT), verticalAlign(0=TOP,1=CENTER,2=BOTTOM), overflow(0=NONE,1=CLAMP,2=SHRINK,3=RESIZE_HEIGHT), color, isBold, isItalic, enableWrapText
- cc.Button: transition(0=NONE,1=COLOR,2=SPRITE,3=SCALE), normalColor/pressedColor/hoverColor/disabledColor, zoomScale(for SCALE transition, default 1.2), normalSprite/pressedSprite/hoverSprite/disabledSprite
- cc.Widget: isAlignTop/isAlignBottom/isAlignLeft/isAlignRight(bool), top/bottom/left/right(number), isAlignHorizontalCenter/isAlignVerticalCenter(bool), horizontalCenter/verticalCenter(number)
- cc.Layout: type(0=NONE,1=HORIZONTAL,2=VERTICAL,3=GRID), resizeMode(0=NONE,1=CONTAINER,2=CHILDREN), spacingX, spacingY, paddingTop/paddingBottom/paddingLeft/paddingRight
- cc.ScrollView: horizontal(bool), vertical(bool), inertia(bool), brake(number 0-1), bounceDuration(number)
- cc.ProgressBar: mode(0=HORIZONTAL,1=VERTICAL), totalLength, progress(0-1)
- cc.Toggle: isChecked(bool)
- cc.EditBox: string, placeholder, maxLength, inputMode(0-6), returnType(0-4)
- cc.UIOpacity: opacity(0-255)
- --- UIRenderer CONFLICT ---
- IMPORTANT: cc.Sprite, cc.Label, cc.RichText, cc.Graphics, cc.TiledMap, cc.Spine, cc.DragonBones are all UIRenderer subclasses and CANNOT coexist on the same node. Only the first UIRenderer in the components list is added; others are skipped with a warning. Place text (cc.Label) in a child node of the Sprite node.
- --- DEFAULT SPRITE BEHAVIOR ---
- When cc.Sprite is added without a spriteFrame in props, a default SpriteFrame is auto-assigned with type=SLICED and sizeMode=CUSTOM. If you specify a spriteFrame, type defaults to SIMPLE.
- SPRITE SIZE FIX: Setting spriteFrame may reset sizeMode to TRIMMED, causing auto-resize to sprite dimensions. Builder automatically re-enforces sizeMode=CUSTOM and re-applies your specified size AFTER spriteFrame assignment. Your "size" field always wins.
- --- POST-BUILD ACTIONS ---
- Components like cc.ScrollView, cc.ProgressBar, cc.Slider, cc.Toggle need post-build property linking. After build, check the postBuildActions array in the response for required set_component_property calls with UUIDs.
- --- DESIGN RESOLUTION ---
- Build response includes designResolution({width,height}) and viewport context. Use these to correctly size your UI elements.
- Auto-created Camera: ORTHO + SOLID_COLOR + orthoHeight=designHeight/2 + visibility=DEFAULT|UI_2D|UI_3D|USER. Matches project design resolution.
- Canvas UITransform contentSize matches actual project design resolution (queried from project settings, not hardcoded).
- --- COORDINATE SYSTEM ---
- Canvas anchor=(0.5,0.5), so children use CENTER-ORIGIN: (0,0)=screen center.
- Visible bounds for Canvas children: x∈[-designWidth/2, designWidth/2], y∈[-designHeight/2, designHeight/2].
- Example 1280x720: center=(0,0). Visible=(-640,-360)~(640,360). A button at position(0,0) is screen-center.
- Direct Canvas children should default to position(0,0) unless offset is needed.
- Bounding box: left=x-w*ax, right=x+w*(1-ax), bottom=y-h*ay, top=y+h*(1-ay). Default anchor=(0.5,0.5).
- Positions are RELATIVE TO PARENT. Direct Canvas children: position relative to Canvas center. Nested children: worldPos=parent.worldPos+local.position.
- Build response includes "viewport" with designResolution, visibleRect, center, coordinateHint. Out-of-bounds nodes generate warnings.
- --- AUTO CANVAS + CAMERA ---
- If parent is "Canvas" (default) and Canvas does not exist in the scene, the builder auto-creates Camera(ORTHO) + Canvas(full-screen with design resolution). Existing Camera/Canvas detected by component (cc.Camera/cc.Canvas), not just by name. Duplicate Canvas nodes are auto-removed.
- --- LIMITS ---
- Max 200 nodes per build call, max 15 levels deep
- Uses snapshot for atomicity — if build fails midway, all changes are rolled back
- --- BATCH TIP ---
- After building a node tree, use cocos_node(action:"batch_modify") to adjust positions/sizes of multiple nodes at once, rather than calling modify repeatedly.

---

## `cocos_animation`(39 个 action 指南)

### cocos_animation.play

**描述**: Play animation clip from beginning

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodeUuid`: Node UUID (optional) (`string`)

**示例**:

```json
{
  "input": {
    "action": "play",
    "clipUuid": "<clipUuid>"
  }
}
```

### cocos_animation.pause

**描述**: Pause playback

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)

### cocos_animation.resume

**描述**: Resume playback

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)

### cocos_animation.stop

**描述**: Stop playback

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)

### cocos_animation.change_sample

**描述**: Change clip sample rate (frames per second)

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `sample`: Sample rate (`number`)

**示例**:

```json
{
  "input": {
    "action": "change_sample",
    "clipUuid": "<clipUuid>",
    "sample": 30
  }
}
```

### cocos_animation.change_speed

**描述**: Change clip playback speed

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `speed`: Playback speed (`number`)

### cocos_animation.change_wrap_mode

**描述**: Change clip wrap mode

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `wrapMode`: Wrap mode (`number`)

### cocos_animation.create_prop

**描述**: Create a property track on a node

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodePath`: Node path ("/" for root) (`string`)
- `propKey`: Property key (e.g. "position", "cc.Sprite.spriteFrame", "cc.UIOpacity.opacity") (`string`)

**示例**:

```json
{
  "input": {
    "action": "create_prop",
    "clipUuid": "<clipUuid>",
    "nodePath": "/",
    "propKey": "position"
  }
}
```

**注意事项**:

- Requires enter_edit first

### cocos_animation.remove_prop

**描述**: Remove a property track

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)

### cocos_animation.create_key

**描述**: Create a keyframe at a specific frame

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frame index (`number`)
- `data`: Keyframe data: {newValue: ...} e.g. {newValue: [100,200,0]} for position (`object`)

**示例**:

```json
{
  "input": {
    "action": "create_key",
    "clipUuid": "<clipUuid>",
    "nodePath": "/",
    "propKey": "position",
    "frame": 30,
    "data": {
      "newValue": [
        100,
        200,
        0
      ]
    }
  }
}
```

### cocos_animation.update_key

**描述**: Update keyframes

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frame indices array (`array`)

### cocos_animation.remove_key

**描述**: Remove keyframes

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frame indices to remove (`array`)

### cocos_animation.move_keys

**描述**: Move keyframes by offset

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Source frames (`array`)
- `target`: Offset (`number`)

### cocos_animation.copy_keys_to

**描述**: Copy keyframes to target frame

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Source frames (`array`)
- `target`: Destination frame (`number`)

### cocos_animation.spacing_keys

**描述**: Evenly space keyframes

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frames to space (`array`)
- `target`: Spacing in frames (`number`)

### cocos_animation.clear_keys

**描述**: Clear all keyframes on a track (keeps track)

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)

### cocos_animation.modify_curve

**描述**: Modify interpolation curve of a keyframe

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frame index (`number`)
- `data`: Curve data (string like "ease-in" or array) (`any`)

### cocos_animation.add_event

**描述**: Add a frame event

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `frame`: Frame index (`number`)
- `eventData`: {func: string, params: any[]} (`object`)

**示例**:

```json
{
  "input": {
    "action": "add_event",
    "clipUuid": "<clipUuid>",
    "frame": 30,
    "eventData": {
      "func": "onHit",
      "params": [
        "enemy"
      ]
    }
  }
}
```

### cocos_animation.delete_event

**描述**: Delete frame events

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `frame`: Frame indices (`array`)

### cocos_animation.update_event

**描述**: Update frame events

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `frame`: Frame indices (`array`)
- `eventData`: Event data or array (`any`)

### cocos_animation.move_events

**描述**: Move events by offset

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `frame`: Source frames (`array`)
- `target`: Offset (`number`)

### cocos_animation.copy_events_to

**描述**: Copy events to target frame

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `frame`: Source frames (`array`)
- `target`: Destination frame (`number`)

### cocos_animation.remove_node

**描述**: Remove all animation data for a node

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)

### cocos_animation.change_node_path

**描述**: Move animation data to a different node path

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Source path (`string`)
- `target`: Destination path (`string`)

### cocos_animation.query_clips_info

**描述**: List animation clips attached to a node

**参数**:

- `nodeUuid`: Node UUID (`string`)

**返回**: Clip list with names and UUIDs

**示例**:

```json
{
  "input": {
    "action": "query_clips_info",
    "nodeUuid": "<nodeUuid>"
  }
}
```

### cocos_animation.query_clip

**描述**: Query single clip details

**参数**:

- `nodeUuid`: Node UUID (`string`)
- `clipUuid`: Clip UUID (`string`)

### cocos_animation.query_clip_dump

**描述**: Get full clip dump data (tracks, keyframes, events)

**参数**:

- `nodeUuid`: Node UUID (`string`)
- `clipUuid`: Clip UUID (`string`)

### cocos_animation.query_value_at_frame

**描述**: Get property value at a specific frame

**参数**:

- `clipUuid`: Clip UUID (`string`)
- `nodePath`: Node path (`string`)
- `propKey`: Property key (`string`)
- `frame`: Frame index (`number`)

### cocos_animation.query_properties

**描述**: Query animatable properties of a node

**参数**:

- `nodeUuid`: Node UUID (`string`)

**返回**: List of animatable property paths

### cocos_animation.query_state

**描述**: Query current animation editor state

**返回**: Animation state info

### cocos_animation.query_edit_info

**描述**: Query current animation edit state — CALL THIS FIRST to get the active clipUuid before any write operation

**返回**: {isEditing, clip, node, rootNode, state}. Use clip uuid for write operations.

**示例**:

```json
{
  "input": {
    "action": "query_edit_info"
  }
}
```

**注意事项**:

- If isEditing is false, user must open Animation panel in Creator and select a clip
- The clipUuid returned here is the one you must pass to write operations (batch/preset/create_prop etc.)
- clipUuid from query_clips_info may differ from the actual edit clip UUID assigned by Creator

### cocos_animation.enter_edit

**描述**: Try to enter animation edit mode via API (may not work — user may need to use Creator UI instead)

**参数**:

- `nodeUuid`: Node UUID (must have Animation component) (`string`)
- `clipUuid`: AnimationClip UUID to edit (`string`)

**示例**:

```json
{
  "input": {
    "action": "enter_edit",
    "nodeUuid": "<nodeUuid>",
    "clipUuid": "<clipUuid>"
  }
}
```

**注意事项**:

- This calls scene:record-animation but the FSM transition may not persist
- If write operations still fail after enter_edit, user must manually open Animation panel in Creator

### cocos_animation.exit_edit

**描述**: Exit animation edit mode

**参数**:

- `nodeUuid`: Node UUID (`string`)

**示例**:

```json
{
  "input": {
    "action": "exit_edit",
    "nodeUuid": "<nodeUuid>"
  }
}
```

### cocos_animation.save_clip

**描述**: Save animation clip to disk

**参数**:

- `nodeUuid`: Node UUID (`string`)
- `clipUuid`: Clip UUID (`string`)

### cocos_animation.create_clip

**描述**: Create a new empty AnimationClip file. Returns the UUID for use with batch_file or preset.

**参数**:

- `url`: db:// path (e.g. "db://assets/animations/myAnim.anim") (`string`)
- `clipName`: Clip name (default: derived from filename) (`string`)

**示例**:

```json
{
  "input": {
    "action": "create_clip",
    "url": "db://assets/animations/walk.anim"
  }
}
```

**注意事项**:

- Creates an empty .anim file with no tracks
- Use the returned UUID with batch_file or preset(writeMode:"file") to add animation data

### cocos_animation.batch

**描述**: One-call animation creation via API: pass all tracks, keyframes, events, clip properties at once. Requires animation edit mode.

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodePath`: Default node path (default: "/") (`string`)
- `data`: {tracks: [{propKey, keyframes: [{frame, value}]}], events: [{frame, func, params}], sample, speed, wrapMode} (`object`)

**示例**:

```json
{
  "input": {
    "action": "batch",
    "clipUuid": "<clipUuid>",
    "nodePath": "/",
    "data": {
      "tracks": [
        {
          "propKey": "position",
          "keyframes": [
            {
              "frame": 0,
              "value": [
                0,
                0,
                0
              ]
            },
            {
              "frame": 30,
              "value": [
                100,
                200,
                0
              ]
            }
          ]
        }
      ],
      "wrapMode": "loop"
    }
  }
}
```

**注意事项**:

- Requires animation edit mode (enter_edit or manual). Use batch_file instead if edit mode is unavailable.
- Tracks: propKey can be "position", "scale", "eulerAngles", "cc.Sprite.spriteFrame", "cc.UIOpacity.opacity" etc.
- SpriteFrame values accept db:// paths (auto-resolved to UUID)
- Wrap mode accepts string: "loop", "normal", "ping-pong", "reverse"

### cocos_animation.batch_file

**描述**: Write animation directly to .anim file — NO animation edit mode needed. Recommended when enter_edit fails.

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `nodePath`: Default node path (default: "/") (`string`)
- `data`: {tracks: [{propKey, keyframes: [{frame, value}]}], events: [{frame, func, params}], sample, speed, wrapMode} (`object`)

**示例**:

```json
{
  "input": {
    "action": "batch_file",
    "clipUuid": "<clipUuid>",
    "nodePath": "/",
    "data": {
      "tracks": [
        {
          "propKey": "position",
          "keyframes": [
            {
              "frame": 0,
              "value": [
                0,
                0,
                0
              ]
            },
            {
              "frame": 30,
              "value": [
                100,
                200,
                0
              ]
            }
          ]
        }
      ],
      "wrapMode": "loop"
    }
  }
}
```

**注意事项**:

- Writes .anim file directly — does NOT require animation edit mode
- Same data format as batch action
- After writing, Creator auto-refreshes the asset. If not, reselect the node.
- Supports: position, scale, eulerAngles (VectorTrack), cc.UIOpacity.opacity (RealTrack)

### cocos_animation.preset_list

**描述**: List all available animation presets by category

**返回**: Presets grouped by category: sprite, transform, effect, event, combo

**示例**:

```json
{
  "input": {
    "action": "preset_list"
  }
}
```

### cocos_animation.preset

**描述**: Create animation from preset — one call for common animations. Use writeMode:"file" to bypass edit mode.

**参数**:

- `clipUuid`: AnimationClip UUID (`string`)
- `preset`: Preset name (`string`)
- `writeMode`: "api" (default, requires edit mode) or "file" (writes .anim directly, no edit mode needed) (`string`)
- `duration`: Duration in frames (default varies by preset) (`number`)
- `folder`: Image folder for sprite_sequence (`string`)
- `images`: Image paths for sprite_sequence (`array`)
- `startValue`: Start value for transform presets (`array`)
- `endValue`: End value for transform presets (`array`)
- `direction`: Direction for combo_enter/exit: left/right/top/bottom (`string`)
- `distance`: Distance for slide/float (`number`)
- `count`: Repeat count for blink/shake (`number`)
- `intensity`: Shake intensity (`number`)
- `events`: Event array for event_batch (`array`)

**注意事项**:

- Default writeMode "api" requires enter_edit first. Use writeMode:"file" to write .anim directly (no edit mode needed).
- Use preset_list to see all presets and their parameters
- Preset parameters serve as defaults — explicitly provided values always take priority

---

> 共 200 个 action 指南。缺失的 22 个 action 指南(服务端无数据): 无
