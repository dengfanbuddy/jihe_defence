# Cocos Creator MCP — 工具 action 详细指南(发送给模型的知识内容)

> 数据来源:运行中的 MCP 服务 `cocos_knowledge(topic:"tool_guide", query:"<tool>.<action>")` 返回内容


---

## `animation`(39 个 action 指南)


### animation.query_edit_info

**描述**: Query current animation edit state — CALL THIS FIRST to get the active clipUuid before any write operation

**返回**: {isEditing, clip, node, rootNode, state}. Use clip uuid for write operations.

**示例**: ```json
{
  "input": {
    "action": "query_edit_info"
  }
}
```

**注意事项**: If isEditing is false, user must open Animation panel in Creator and select a clip,The clipUuid returned here is the one you must pass to write operations (batch/preset/create_prop etc.),clipUuid from query_clips_info may differ from the actual edit clip UUID assigned by Creator

*Guide for animation.query_edit_info: Query current animation edit state — CALL THIS FIRST to get the active clipUuid before any write operation*


### animation.enter_edit

**描述**: Try to enter animation edit mode via API (may not work — user may need to use Creator UI instead)

**参数**:

- `nodeUuid`: Node UUID (must have Animation component)
- `clipUuid`: AnimationClip UUID to edit

**示例**: ```json
{
  "input": {
    "action": "enter_edit",
    "nodeUuid": "<nodeUuid>",
    "clipUuid": "<clipUuid>"
  }
}
```

**注意事项**: This calls scene:record-animation but the FSM transition may not persist,If write operations still fail after enter_edit, user must manually open Animation panel in Creator

*Guide for animation.enter_edit: Try to enter animation edit mode via API (may not work — user may need to use Creator UI instead)*


### animation.exit_edit

**描述**: Exit animation edit mode

**参数**:

- `nodeUuid`: Node UUID

**示例**: ```json
{
  "input": {
    "action": "exit_edit",
    "nodeUuid": "<nodeUuid>"
  }
}
```

*Guide for animation.exit_edit: Exit animation edit mode*


### animation.play

**描述**: Play animation clip from beginning

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodeUuid`: Node UUID (optional)

**示例**: ```json
{
  "input": {
    "action": "play",
    "clipUuid": "<clipUuid>"
  }
}
```

*Guide for animation.play: Play animation clip from beginning*


### animation.pause

**描述**: Pause playback

**参数**:

- `clipUuid`: AnimationClip UUID

*Guide for animation.pause: Pause playback*


### animation.resume

**描述**: Resume playback

**参数**:

- `clipUuid`: AnimationClip UUID

*Guide for animation.resume: Resume playback*


### animation.stop

**描述**: Stop playback

**参数**:

- `clipUuid`: AnimationClip UUID

*Guide for animation.stop: Stop playback*


### animation.change_sample

**描述**: Change clip sample rate (frames per second)

**参数**:

- `clipUuid`: AnimationClip UUID
- `sample`: Sample rate

**示例**: ```json
{
  "input": {
    "action": "change_sample",
    "clipUuid": "<clipUuid>",
    "sample": 30
  }
}
```

*Guide for animation.change_sample: Change clip sample rate (frames per second)*


### animation.change_speed

**描述**: Change clip playback speed

**参数**:

- `clipUuid`: AnimationClip UUID
- `speed`: Playback speed

*Guide for animation.change_speed: Change clip playback speed*


### animation.change_wrap_mode

**描述**: Change clip wrap mode

**参数**:

- `clipUuid`: AnimationClip UUID
- `wrapMode`: Wrap mode

*Guide for animation.change_wrap_mode: Change clip wrap mode*


### animation.create_prop

**描述**: Create a property track on a node

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodePath`: Node path ("/" for root)
- `propKey`: Property key (e.g. "position", "cc.Sprite.spriteFrame", "cc.UIOpacity.opacity")

**示例**: ```json
{
  "input": {
    "action": "create_prop",
    "clipUuid": "<clipUuid>",
    "nodePath": "/",
    "propKey": "position"
  }
}
```

**注意事项**: Requires enter_edit first

*Guide for animation.create_prop: Create a property track on a node*


### animation.remove_prop

**描述**: Remove a property track

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodePath`: Node path
- `propKey`: Property key

*Guide for animation.remove_prop: Remove a property track*


### animation.create_key

**描述**: Create a keyframe at a specific frame

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frame index
- `data`: Keyframe data: {newValue: ...} e.g. {newValue: [100,200,0]} for position

**示例**: ```json
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

*Guide for animation.create_key: Create a keyframe at a specific frame*


### animation.update_key

**描述**: Update keyframes

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frame indices array

*Guide for animation.update_key: Update keyframes*


### animation.remove_key

**描述**: Remove keyframes

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frame indices to remove

*Guide for animation.remove_key: Remove keyframes*


### animation.move_keys

**描述**: Move keyframes by offset

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Source frames
- `target`: Offset

*Guide for animation.move_keys: Move keyframes by offset*


### animation.copy_keys_to

**描述**: Copy keyframes to target frame

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Source frames
- `target`: Destination frame

*Guide for animation.copy_keys_to: Copy keyframes to target frame*


### animation.spacing_keys

**描述**: Evenly space keyframes

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frames to space
- `target`: Spacing in frames

*Guide for animation.spacing_keys: Evenly space keyframes*


### animation.clear_keys

**描述**: Clear all keyframes on a track (keeps track)

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key

*Guide for animation.clear_keys: Clear all keyframes on a track (keeps track)*


### animation.modify_curve

**描述**: Modify interpolation curve of a keyframe

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frame index
- `data`: Curve data (string like "ease-in" or array)

*Guide for animation.modify_curve: Modify interpolation curve of a keyframe*


### animation.add_event

**描述**: Add a frame event

**参数**:

- `clipUuid`: Clip UUID
- `frame`: Frame index
- `eventData`: {func: string, params: any[]}

**示例**: ```json
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

*Guide for animation.add_event: Add a frame event*


### animation.delete_event

**描述**: Delete frame events

**参数**:

- `clipUuid`: Clip UUID
- `frame`: Frame indices

*Guide for animation.delete_event: Delete frame events*


### animation.update_event

**描述**: Update frame events

**参数**:

- `clipUuid`: Clip UUID
- `frame`: Frame indices
- `eventData`: Event data or array

*Guide for animation.update_event: Update frame events*


### animation.move_events

**描述**: Move events by offset

**参数**:

- `clipUuid`: Clip UUID
- `frame`: Source frames
- `target`: Offset

*Guide for animation.move_events: Move events by offset*


### animation.copy_events_to

**描述**: Copy events to target frame

**参数**:

- `clipUuid`: Clip UUID
- `frame`: Source frames
- `target`: Destination frame

*Guide for animation.copy_events_to: Copy events to target frame*


### animation.remove_node

**描述**: Remove all animation data for a node

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path

*Guide for animation.remove_node: Remove all animation data for a node*


### animation.change_node_path

**描述**: Move animation data to a different node path

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Source path
- `target`: Destination path

*Guide for animation.change_node_path: Move animation data to a different node path*


### animation.query_clips_info

**描述**: List animation clips attached to a node

**参数**:

- `nodeUuid`: Node UUID

**返回**: Clip list with names and UUIDs

**示例**: ```json
{
  "input": {
    "action": "query_clips_info",
    "nodeUuid": "<nodeUuid>"
  }
}
```

*Guide for animation.query_clips_info: List animation clips attached to a node*


### animation.query_clip

**描述**: Query single clip details

**参数**:

- `nodeUuid`: Node UUID
- `clipUuid`: Clip UUID

*Guide for animation.query_clip: Query single clip details*


### animation.query_clip_dump

**描述**: Get full clip dump data (tracks, keyframes, events)

**参数**:

- `nodeUuid`: Node UUID
- `clipUuid`: Clip UUID

*Guide for animation.query_clip_dump: Get full clip dump data (tracks, keyframes, events)*


### animation.query_value_at_frame

**描述**: Get property value at a specific frame

**参数**:

- `clipUuid`: Clip UUID
- `nodePath`: Node path
- `propKey`: Property key
- `frame`: Frame index

*Guide for animation.query_value_at_frame: Get property value at a specific frame*


### animation.query_properties

**描述**: Query animatable properties of a node

**参数**:

- `nodeUuid`: Node UUID

**返回**: List of animatable property paths

*Guide for animation.query_properties: Query animatable properties of a node*


### animation.query_state

**描述**: Query current animation editor state

**返回**: Animation state info

*Guide for animation.query_state: Query current animation editor state*


### animation.save_clip

**描述**: Save animation clip to disk

**参数**:

- `nodeUuid`: Node UUID
- `clipUuid`: Clip UUID

*Guide for animation.save_clip: Save animation clip to disk*


### animation.create_clip

**描述**: Create a new empty AnimationClip file. Returns the UUID for use with batch_file or preset.

**参数**:

- `url`: db:// path (e.g. "db://assets/animations/myAnim.anim")
- `clipName`: Clip name (default: derived from filename)

**示例**: ```json
{
  "input": {
    "action": "create_clip",
    "url": "db://assets/animations/walk.anim"
  }
}
```

**注意事项**: Creates an empty .anim file with no tracks,Use the returned UUID with batch_file or preset(writeMode:"file") to add animation data

*Guide for animation.create_clip: Create a new empty AnimationClip file. Returns the UUID for use with batch_file or preset.*


### animation.batch

**描述**: One-call animation creation via API: pass all tracks, keyframes, events, clip properties at once. Requires animation edit mode.

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodePath`: Default node path (default: "/")
- `data`: {tracks: [{propKey, keyframes: [{frame, value}]}], events: [{frame, func, params}], sample, speed, wrapMode}

**示例**: ```json
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

**注意事项**: Requires animation edit mode (enter_edit or manual). Use batch_file instead if edit mode is unavailable.,Tracks: propKey can be "position", "scale", "eulerAngles", "cc.Sprite.spriteFrame", "cc.UIOpacity.opacity" etc.,SpriteFrame values accept db:// paths (auto-resolved to UUID),Wrap mode accepts string: "loop", "normal", "ping-pong", "reverse"

*Guide for animation.batch: One-call animation creation via API: pass all tracks, keyframes, events, clip properties at once. Requires animation edit mode.*


### animation.batch_file

**描述**: Write animation directly to .anim file — NO animation edit mode needed. Recommended when enter_edit fails.

**参数**:

- `clipUuid`: AnimationClip UUID
- `nodePath`: Default node path (default: "/")
- `data`: {tracks: [{propKey, keyframes: [{frame, value}]}], events: [{frame, func, params}], sample, speed, wrapMode}

**示例**: ```json
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

**注意事项**: Writes .anim file directly — does NOT require animation edit mode,Same data format as batch action,After writing, Creator auto-refreshes the asset. If not, reselect the node.,Supports: position, scale, eulerAngles (VectorTrack), cc.UIOpacity.opacity (RealTrack)

*Guide for animation.batch_file: Write animation directly to .anim file — NO animation edit mode needed. Recommended when enter_edit fails.*


### animation.preset_list

**描述**: List all available animation presets by category

**返回**: Presets grouped by category: sprite, transform, effect, event, combo

**示例**: ```json
{
  "input": {
    "action": "preset_list"
  }
}
```

*Guide for animation.preset_list: List all available animation presets by category*


### animation.preset

**描述**: Create animation from preset — one call for common animations. Use writeMode:"file" to bypass edit mode.

**参数**:

- `clipUuid`: AnimationClip UUID
- `preset`: Preset name
- `writeMode`: "api" (default, requires edit mode) or "file" (writes .anim directly, no edit mode needed)
- `duration`: Duration in frames (default varies by preset)
- `folder`: Image folder for sprite_sequence
- `images`: Image paths for sprite_sequence
- `startValue`: Start value for transform presets
- `endValue`: End value for transform presets
- `direction`: Direction for combo_enter/exit: left/right/top/bottom
- `distance`: Distance for slide/float
- `count`: Repeat count for blink/shake
- `intensity`: Shake intensity
- `events`: Event array for event_batch

**注意事项**: Default writeMode "api" requires enter_edit first. Use writeMode:"file" to write .anim directly (no edit mode needed).,Use preset_list to see all presets and their parameters,Preset parameters serve as defaults — explicitly provided values always take priority

*Guide for animation.preset: Create animation from preset — one call for common animations. Use writeMode:"file" to bypass edit mode.*


---

## `scene`(23 个 action 指南)


### scene.get_info

**描述**: Get current scene info (name, uuid, path)

**返回**: Scene name, uuid, url

**示例**: ```json
{
  "input": {
    "action": "get_info"
  }
}
```

*Guide for scene.get_info: Get current scene info (name, uuid, path)*


### scene.list

**描述**: List all scene assets in project

**返回**: Array of scene {name, path, uuid}

**示例**: ```json
{
  "input": {
    "action": "list"
  }
}
```

*Guide for scene.list: List all scene assets in project*


### scene.open

**描述**: Open a scene by path

**参数**:

- `scenePath`: Scene path (e.g. "db://assets/scenes/Game.scene")

**示例**: ```json
{
  "input": {
    "action": "open",
    "scenePath": "db://assets/scenes/Game.scene"
  }
}
```

*Guide for scene.open: Open a scene by path*


### scene.save

**描述**: Save the current scene

**示例**: ```json
{
  "input": {
    "action": "save"
  }
}
```

*Guide for scene.save: Save the current scene*


### scene.create

**描述**: Create a new scene asset with Camera + Canvas auto-created

**参数**:

- `sceneName`: Scene file name
- `savePath`: Save folder (e.g. "db://assets/scenes")

**返回**: Scene info + autoCreated[] listing nodes auto-created (Camera, Canvas)

**示例**: ```json
{
  "input": {
    "action": "create",
    "sceneName": "Level2",
    "savePath": "db://assets/scenes"
  }
}
```

**注意事项**: Scene is auto-opened after creation and Camera + Canvas are created automatically,Canvas has cc.Canvas + cc.UITransform + cc.Widget (full-screen). Camera has cc.Camera (ORTHO),No need to manually create Camera or Canvas — they are always included in new scenes

*Guide for scene.create: Create a new scene asset with Camera + Canvas auto-created*


### scene.close

**描述**: Close the current scene

**示例**: ```json
{
  "input": {
    "action": "close"
  }
}
```

*Guide for scene.close: Close the current scene*


### scene.hierarchy

**描述**: Get full scene hierarchy tree

**参数**:

- `includeComponents`: Include component details (默认: false)

**返回**: Full node tree with optional component info

**示例**: ```json
{
  "input": {
    "action": "hierarchy",
    "includeComponents": true
  }
}
```

*Guide for scene.hierarchy: Get full scene hierarchy tree*


### scene.is_ready

**描述**: Check if scene is loaded and ready

**返回**: Boolean ready state

**示例**: ```json
{
  "input": {
    "action": "is_ready"
  }
}
```

*Guide for scene.is_ready: Check if scene is loaded and ready*


### scene.is_dirty

**描述**: Check if scene has unsaved changes

**返回**: Boolean dirty state

**示例**: ```json
{
  "input": {
    "action": "is_dirty"
  }
}
```

*Guide for scene.is_dirty: Check if scene has unsaved changes*


### scene.snapshot

**描述**: Create an undo snapshot of current scene state

**返回**: Snapshot ID

**示例**: ```json
{
  "input": {
    "action": "snapshot"
  }
}
```

*Guide for scene.snapshot: Create an undo snapshot of current scene state*


### scene.snapshot_abort

**描述**: Abort/discard current snapshot

**示例**: ```json
{
  "input": {
    "action": "snapshot_abort"
  }
}
```

*Guide for scene.snapshot_abort: Abort/discard current snapshot*


### scene.undo_begin

**描述**: Begin an undo group (for batching changes)

**参数**:

- `nodeUuid`: Target node UUID for undo context

**返回**: undoId for use with undo_end/undo_cancel

**示例**: ```json
{
  "input": {
    "action": "undo_begin",
    "nodeUuid": "abc-123"
  }
}
```

*Guide for scene.undo_begin: Begin an undo group (for batching changes)*


### scene.undo_end

**描述**: End and commit an undo group

**参数**:

- `undoId`: Undo ID from undo_begin

**示例**: ```json
{
  "input": {
    "action": "undo_end",
    "undoId": "undo-123"
  }
}
```

*Guide for scene.undo_end: End and commit an undo group*


### scene.undo_cancel

**描述**: Cancel an undo group (rollback)

**参数**:

- `undoId`: Undo ID from undo_begin

**示例**: ```json
{
  "input": {
    "action": "undo_cancel",
    "undoId": "undo-123"
  }
}
```

*Guide for scene.undo_cancel: Cancel an undo group (rollback)*


### scene.execute_method

**描述**: Execute a method on a component in scene

**参数**:

- `uuid`: Component UUID
- `name`: Method name to execute
- `args`: Method arguments (默认: [])

**示例**: ```json
{
  "input": {
    "action": "execute_method",
    "uuid": "comp-uuid-123",
    "name": "resetState",
    "args": []
  }
}
```

*Guide for scene.execute_method: Execute a method on a component in scene*


### scene.execute_script

**描述**: Execute a script/plugin method

**参数**:

- `name`: Plugin/extension name
- `method`: Method name
- `args`: Method arguments (默认: [])

**示例**: ```json
{
  "input": {
    "action": "execute_script",
    "name": "my-extension",
    "method": "doSomething"
  }
}
```

*Guide for scene.execute_script: Execute a script/plugin method*


### scene.soft_reload

**描述**: Soft-reload the scene (re-run scripts without full reload)

**示例**: ```json
{
  "input": {
    "action": "soft_reload"
  }
}
```

*Guide for scene.soft_reload: Soft-reload the scene (re-run scripts without full reload)*


### scene.list_classes

**描述**: List registered script classes

**参数**:

- `extends`: Filter by base class (e.g. "cc.Component")

**返回**: Array of class names

**示例**: ```json
{
  "input": {
    "action": "list_classes",
    "extends": "cc.Component"
  }
}
```

*Guide for scene.list_classes: List registered script classes*


### scene.list_components

**描述**: List all registered component types

**返回**: Array of component class names

**示例**: ```json
{
  "input": {
    "action": "list_components"
  }
}
```

*Guide for scene.list_components: List all registered component types*


### scene.check_script

**描述**: Check if a script class is registered

**参数**:

- `className`: Class name to check

**返回**: Boolean exists + class info

**示例**: ```json
{
  "input": {
    "action": "check_script",
    "className": "PlayerController"
  }
}
```

*Guide for scene.check_script: Check if a script class is registered*


### scene.find_nodes_by_asset

**描述**: Find all nodes referencing a specific asset

**参数**:

- `assetUuid`: Asset UUID to search for

**返回**: Array of nodes using the asset

**示例**: ```json
{
  "input": {
    "action": "find_nodes_by_asset",
    "assetUuid": "asset-uuid-123"
  }
}
```

*Guide for scene.find_nodes_by_asset: Find all nodes referencing a specific asset*


### scene.restore_prefab

**描述**: Restore a broken prefab instance

**参数**:

- `nodeUuid`: Node UUID of broken prefab instance
- `assetUuid`: Original prefab asset UUID

**示例**: ```json
{
  "input": {
    "action": "restore_prefab",
    "nodeUuid": "node-123",
    "assetUuid": "prefab-456"
  }
}
```

*Guide for scene.restore_prefab: Restore a broken prefab instance*


### scene.query_mode

**描述**: Query current editor/scene mode (normal, prefab-edit, etc.)

**返回**: Current mode info

**示例**: ```json
{
  "input": {
    "action": "query_mode"
  }
}
```

*Guide for scene.query_mode: Query current editor/scene mode (normal, prefab-edit, etc.)*

> 未获取到指南的 action: validate_scene


---

## `node`(17 个 action 指南)


### node.find

**描述**: Search nodes by name pattern

**参数**:

- `node`: Search pattern (name, UUID, or path)
- `exactMatch`: Exact name match (默认: false)

**返回**: Array of matching nodes with uuid, name, path

**示例**: ```json
{
  "input": {
    "action": "find",
    "node": "Button"
  }
}
```

*Guide for node.find: Search nodes by name pattern*


### node.info

**描述**: Get detailed node info (transform, components, children)

**参数**:

- `node`: Target node: UUID, path, or name

**返回**: Node details: name, uuid, path, position, rotation, scale, components, children

**示例**: ```json
{
  "input": {
    "action": "info",
    "node": "Canvas/Player"
  }
}
```

*Guide for node.info: Get detailed node info (transform, components, children)*


### node.list

**描述**: List top-level nodes in scene

**返回**: Array of root-level nodes

**示例**: ```json
{
  "input": {
    "action": "list"
  }
}
```

*Guide for node.list: List top-level nodes in scene*


### node.tree

**描述**: Get node hierarchy tree

**参数**:

- `node`: Root node (default: entire scene)
- `maxDepth`: Max traversal depth (默认: 10)

**返回**: Tree structure with children

**示例**: ```json
{
  "input": {
    "action": "tree",
    "node": "Canvas",
    "maxDepth": 3
  }
}
```

*Guide for node.tree: Get node hierarchy tree*


### node.create

**描述**: Create a new node. Use "type" for built-in UI controls (Button, Label, etc.) — creates complete control from engine prefab.

**参数**:

- `name`: Node name (default: "New Node")
- `parent`: Parent node: UUID, path, or name
- `nodeType`: Preset type: "2D", "3D", "UI"
- `type`: Built-in UI control type — creates complete control from engine prefab. Types: Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, etc.
- `components`: Components to add (e.g. ["cc.Sprite","cc.Button"])
- `initialTransform`: {position:{x,y,z}, rotation:{x,y,z}, scale:{x,y,z}}

**示例**: ```json
{
  "input": {
    "action": "create",
    "name": "MyButton",
    "parent": "Canvas",
    "type": "Button"
  }
}
```

**注意事项**: Auto-adds cc.UITransform if parent is a UI node,Use "type" for complete UI controls (preferred). Use nodeType/components for custom setup.,UI node response includes viewport context (designResolution, visibleRect, center),For batch UI creation, prefer cocos_composite(action:"create_ui") or cocos_builder with type field

*Guide for node.create: Create a new node. Use "type" for built-in UI controls (Button, Label, etc.) — creates complete control from engine prefab.*


### node.delete

**描述**: Delete a node from scene

**参数**:

- `node`: Target node: UUID, path, or name

**示例**: ```json
{
  "input": {
    "action": "delete",
    "node": "Canvas/OldPanel"
  }
}
```

*Guide for node.delete: Delete a node from scene*


### node.modify

**描述**: Modify node properties (name, active, transform)

**参数**:

- `node`: Target node: UUID, path, or name
- `name`: New node name
- `active`: Set active state
- `layer`: Set node layer
- `position`: {x, y, z}
- `rotation`: {x, y, z} in degrees
- `scale`: {x, y, z}

**示例**: ```json
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

**注意事项**: Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2),Modifying position on UI nodes returns viewport context + out-of-bounds warnings

*Guide for node.modify: Modify node properties (name, active, transform)*


### node.move

**描述**: Move node to new parent or change sibling order

**参数**:

- `node`: Target node: UUID, path, or name
- `targetParent`: New parent: UUID, path, or name
- `siblingIndex`: Position among siblings

**示例**: ```json
{
  "input": {
    "action": "move",
    "node": "Canvas/Button",
    "targetParent": "Canvas/Panel",
    "siblingIndex": 0
  }
}
```

*Guide for node.move: Move node to new parent or change sibling order*


### node.duplicate

**描述**: Duplicate a node

**参数**:

- `node`: Target node: UUID, path, or name
- `includeChildren`: Include children (默认: true)

**返回**: New node UUID

**示例**: ```json
{
  "input": {
    "action": "duplicate",
    "node": "Canvas/ListItem"
  }
}
```

*Guide for node.duplicate: Duplicate a node*


### node.copy

**描述**: Copy node(s) to clipboard

**参数**:

- `node`: Single node: UUID, path, or name
- `uuids`: Multiple node UUIDs

**示例**: ```json
{
  "input": {
    "action": "copy",
    "node": "Canvas/Template"
  }
}
```

**注意事项**: Use node for single, uuids for multiple

*Guide for node.copy: Copy node(s) to clipboard*


### node.paste

**描述**: Paste node(s) from clipboard

**参数**:

- `parent`: Target parent: UUID, path, or name
- `uuids`: Specific UUIDs to paste
- `keepWorldTransform`: Keep world transform (默认: false)

**示例**: ```json
{
  "input": {
    "action": "paste",
    "parent": "Canvas/Container"
  }
}
```

*Guide for node.paste: Paste node(s) from clipboard*


### node.cut

**描述**: Cut node(s) to clipboard

**参数**:

- `node`: Single node: UUID, path, or name
- `uuids`: Multiple node UUIDs

**示例**: ```json
{
  "input": {
    "action": "cut",
    "node": "Canvas/OldItem"
  }
}
```

*Guide for node.cut: Cut node(s) to clipboard*


### node.mount_script

**描述**: Mount a TypeScript/JavaScript script component to node

**参数**:

- `node`: Target node: UUID, path, or name
- `scriptPath`: Script asset path (e.g. "db://assets/scripts/Player.ts")

**返回**: Script info + assignableProperties[] listing public properties that need node/asset assignment

**示例**: ```json
{
  "input": {
    "action": "mount_script",
    "node": "Canvas/Player",
    "scriptPath": "db://assets/scripts/PlayerController.ts"
  }
}
```

**注意事项**: WORKFLOW: mount_script > check assignableProperties > set_property for each.,Smart resolution: pass node NAME or PATH as value — no need to look up UUIDs manually.,Node refs: value:"PlayerNode" or "Canvas/Player". Component refs: value:"ScoreLabel" (auto-finds matching component).,For images: propertyType:"spriteFrame" + "db://assets/..." path. For prefabs: propertyType:"prefab" + "db://..." path.,Do NOT write runtime code (find/getChildByName) — use MCP set_property instead.

*Guide for node.mount_script: Mount a TypeScript/JavaScript script component to node*


### node.remove_script

**描述**: Remove a script component from node

**参数**:

- `node`: Target node: UUID, path, or name
- `scriptCid`: Script CID (get from component.list)

**示例**: ```json
{
  "input": {
    "action": "remove_script",
    "node": "Canvas/Player",
    "scriptCid": "1abnc..."
  }
}
```

*Guide for node.remove_script: Remove a script component from node*


### node.reset

**描述**: Reset node property, transform, or component to defaults

**参数**:

- `node`: Target node: UUID, path, or name
- `resetType`: What to reset
- `path`: Property path for reset_property type

**示例**: ```json
{
  "input": {
    "action": "reset",
    "node": "Canvas/Player",
    "resetType": "transform"
  }
}
```

*Guide for node.reset: Reset node property, transform, or component to defaults*


### node.detect_type

**描述**: Detect node type (UI/2D/3D) and component summary

**参数**:

- `node`: Target node: UUID, path, or name

**返回**: Node type classification and component list

**示例**: ```json
{
  "input": {
    "action": "detect_type",
    "node": "Canvas/Player"
  }
}
```

*Guide for node.detect_type: Detect node type (UI/2D/3D) and component summary*


### node.batch_modify

**描述**: Batch modify multiple nodes' transforms in one call. Use when adjusting 3+ nodes.

**参数**:

- `nodes`: Array of node modifications. Each: {node(required), position:{x,y,z}, scale:{x,y,z}, rotation:{x,y,z}, active:bool, name:string, anchor:{x,y}, size:{width,height}}

**返回**: Array of results for each node modification

**示例**: ```json
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

**注意事项**: Preferred over multiple modify calls for layout adjustments,Each entry in the array is processed sequentially with the same atomicity guarantees,If a node is not found, that entry fails but others still succeed

*Guide for node.batch_modify: Batch modify multiple nodes' transforms in one call. Use when adjusting 3+ nodes.*

> 未获取到指南的 action: reorder


---

## `component`(8 个 action 指南)


### component.add

**描述**: Add component(s) to a node

**参数**:

- `node`: Target node: UUID, path, or name
- `componentType`: Component type(s) e.g. "cc.Sprite" or ["cc.Sprite","cc.Button"]

**返回**: Added component info

*Guide for component.add: Add component(s) to a node*


### component.remove

**描述**: Remove component from a node

**参数**:

- `node`: Target node: UUID, path, or name
- `componentType`: Use exact CID from list action (e.g. "1abnc...")

**示例**: ```json
{
  "input": {
    "action": "remove",
    "node": "Canvas/Player",
    "componentType": "1abnc..."
  }
}
```

**注意事项**: Use list action first to get exact CID for removal

*Guide for component.remove: Remove component from a node*


### component.list

**描述**: List all components on a node

**参数**:

- `node`: Target node: UUID, path, or name

**返回**: Array of {type, cid, properties}

**示例**: ```json
{
  "input": {
    "action": "list",
    "node": "Canvas/Player"
  }
}
```

*Guide for component.list: List all components on a node*


### component.info

**描述**: Get detailed component info (properties and values)

**参数**:

- `node`: Target node: UUID, path, or name
- `componentType`: Filter by type (e.g. "cc.Label"). Omit for all.

**返回**: Component properties with current values

**示例**: ```json
{
  "input": {
    "action": "info",
    "node": "Canvas/Score",
    "componentType": "cc.Label"
  }
}
```

*Guide for component.info: Get detailed component info (properties and values)*


### component.set_property

**描述**: Set component property. Two modes: single (property+value) or batch (properties object). Type auto-detected if propertyType omitted.

**参数**:

- `node`: Target node: UUID, path, or name
- `componentType`: e.g. "cc.Label", "cc.Sprite", or script CID
- `property`: Property name (single mode)
- `propertyType`: Type hint (auto-detected if omitted)
- `value`: Value to set (single mode). Format depends on propertyType.
- `properties`: Batch mode: {"prop": {"type":"<type>","value":<val>}}

**注意事项**: Single mode: property+value. Batch mode: properties object. Do NOT mix.,Color: "#FF0000"/"#FF0000FF" or {r,g,b,a}(0-255). Vec3: {x,y,z}. Vec2: {x,y}. Size: {width,height}.,--- SMART REFERENCE RESOLUTION ---,For node/component/nodeArray/componentArray references: pass node NAME, PATH, or UUID as value. Examples: "ScoreLabel", "Canvas/HUD/Score", "<uuid>".,Auto-resolves names using nearby-first strategy: child nodes > sibling nodes > global. Handles same-name ambiguity automatically.,Component refs: auto-detects required component type from property metadata (e.g. scoreLabel needs cc.Label) and finds it on the target node.,componentArray: pass array of node names/paths/UUIDs. Each node is resolved, matching component auto-found.,WORKFLOW: mount_script > check assignableProperties > set_property for each. No need to manually look up UUIDs — just use node names!,For spriteFrame: pass "db://assets/textures/xxx.png" — auto-resolved to SpriteFrame sub-asset UUID.,propertyType is auto-detected from component dump if omitted. Explicit propertyType still supported for edge cases.,⚠ SPRITE SIZE WARNING: Setting spriteFrame on cc.Sprite may auto-resize the node to the sprite's original dimensions. Response includes sizeChangeInfo (sizeBefore, sizeAfter, sizeChanged). If size changed and you need a specific size, follow up with set_property on cc.UITransform.contentSize.

*Guide for component.set_property: Set component property. Two modes: single (property+value) or batch (properties object). Type auto-detected if propertyType omitted.*


### component.available_types

**描述**: List available component types by category

**参数**:

- `category`: Filter category (默认: "all")

**返回**: Array of available component types

**示例**: ```json
{
  "input": {
    "action": "available_types",
    "category": "ui"
  }
}
```

*Guide for component.available_types: List available component types by category*


### component.click_event

**描述**: Manage Button click event handlers

**参数**:

- `node`: Button node: UUID, path, or name
- `operation`: Event operation (默认: "add")
- `targetNode`: Node with callback component (UUID/path/name)
- `componentName`: Component type or script class name (e.g. "TestController")
- `handlerName`: Callback method name on the component
- `customEventData`: Custom string data passed to handler at runtime
- `eventIndex`: Event index for remove/modify operation

**注意事项**: add: targetNode+componentName+handlerName required,remove: eventIndex required. clear: removes all events.,modify: eventIndex + fields to change

*Guide for component.click_event: Manage Button click event handlers*


### component.batch_click_event

**描述**: Bind click events on multiple buttons in one call. Use when binding 3+ button events.

**参数**:

- `events`: Array of click event bindings. Each: {node(required), target(required), componentName(required), handler(required), customEventData?(optional)}

**返回**: Array of results for each event binding

**示例**: ```json
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

**注意事项**: Preferred over multiple click_event calls,Each entry binds one click event on the specified button node,If a node is not found, that entry fails but others still succeed

*Guide for component.batch_click_event: Bind click events on multiple buttons in one call. Use when binding 3+ button events.*


---

## `prefab`(11 个 action 指南)


### prefab.list

**描述**: List prefab assets in folder

**参数**:

- `folder`: Folder path (default: "db://assets") (默认: "db://assets")

**返回**: Array of prefab info {name, path, uuid}

**示例**: ```json
{
  "input": {
    "action": "list",
    "folder": "db://assets/prefabs"
  }
}
```

*Guide for prefab.list: List prefab assets in folder*


### prefab.info

**描述**: Get prefab asset metadata

**参数**:

- `prefabPath`: Prefab path (e.g. "db://assets/prefabs/Button.prefab")

**返回**: Prefab metadata: uuid, path, dependencies

**示例**: ```json
{
  "input": {
    "action": "info",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

*Guide for prefab.info: Get prefab asset metadata*


### prefab.validate

**描述**: Validate prefab asset integrity

**参数**:

- `prefabPath`: Prefab path

**返回**: Validation result with warnings

**示例**: ```json
{
  "input": {
    "action": "validate",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

*Guide for prefab.validate: Validate prefab asset integrity*


### prefab.create

**描述**: Create prefab from existing scene node

**参数**:

- `nodeUuid`: Source node UUID
- `node`: Source node: UUID, path, or name (alternative to nodeUuid)
- `prefabName`: Prefab file name
- `savePath`: Save folder path (e.g. "db://assets/prefabs")

**示例**: ```json
{
  "input": {
    "action": "create",
    "node": "Canvas/MyButton",
    "prefabName": "MyButton",
    "savePath": "db://assets/prefabs"
  }
}
```

**注意事项**: Either nodeUuid or node required. Node must exist in scene.

*Guide for prefab.create: Create prefab from existing scene node*


### prefab.delete

**描述**: Delete prefab asset file

**参数**:

- `prefabPath`: Prefab path

**示例**: ```json
{
  "input": {
    "action": "delete",
    "prefabPath": "db://assets/prefabs/OldButton.prefab"
  }
}
```

*Guide for prefab.delete: Delete prefab asset file*


### prefab.instantiate

**描述**: Instantiate prefab into scene

**参数**:

- `prefabPath`: Prefab path
- `parentUuid`: Parent node UUID
- `parent`: Parent node: UUID, path, or name (alternative to parentUuid)
- `position`: Initial position: {x, y, z}

**返回**: New node UUID

**示例**: ```json
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

*Guide for prefab.instantiate: Instantiate prefab into scene*


### prefab.edit_enter

**描述**: Enter prefab edit mode (opens prefab for editing)

**参数**:

- `prefabPath`: Prefab path

**示例**: ```json
{
  "input": {
    "action": "edit_enter",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

**注意事项**: Saves current scene internally. Use edit_exit to return.,In edit mode, scene root is still cc.Scene; check child "should_hide_in_hierarchy" to detect mode.

*Guide for prefab.edit_enter: Enter prefab edit mode (opens prefab for editing)*


### prefab.edit_save

**描述**: Save changes in prefab edit mode

**参数**:

- `prefabPath`: Prefab path (must match edit_enter)

**示例**: ```json
{
  "input": {
    "action": "edit_save",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

*Guide for prefab.edit_save: Save changes in prefab edit mode*


### prefab.edit_exit

**描述**: Exit prefab edit mode (restores previous scene)

**参数**:

- `prefabPath`: Prefab path

**示例**: ```json
{
  "input": {
    "action": "edit_exit",
    "prefabPath": "db://assets/prefabs/Button.prefab"
  }
}
```

**注意事项**: Always call edit_save before edit_exit if changes were made

*Guide for prefab.edit_exit: Exit prefab edit mode (restores previous scene)*


### prefab.apply

**描述**: Apply scene changes back to prefab asset

**参数**:

- `nodeUuid`: Prefab instance node UUID
- `node`: Node: UUID, path, or name (alternative)

**示例**: ```json
{
  "input": {
    "action": "apply",
    "node": "Canvas/MyButton"
  }
}
```

**注意事项**: Node must be a prefab instance in scene

*Guide for prefab.apply: Apply scene changes back to prefab asset*


### prefab.revert

**描述**: Revert prefab instance to original prefab state

**参数**:

- `nodeUuid`: Prefab instance node UUID
- `node`: Node: UUID, path, or name (alternative)

**示例**: ```json
{
  "input": {
    "action": "revert",
    "node": "Canvas/MyButton"
  }
}
```

*Guide for prefab.revert: Revert prefab instance to original prefab state*


---

## `asset`(6 个 action 指南)


### asset.query_uuid

**描述**: Get UUID for asset URL

**参数**:

- `url`: Asset URL

**返回**: Asset UUID string

**示例**: ```json
{
  "input": {
    "action": "query_uuid",
    "url": "db://assets/textures/bg.png"
  }
}
```

*Guide for asset.query_uuid: Get UUID for asset URL*


### asset.find_by_name

**描述**: Find assets by name pattern

**参数**:

- `name`: Asset name pattern
- `type`: Asset type filter
- `folder`: Folder to search

**返回**: Array of matching assets

**示例**: ```json
{
  "input": {
    "action": "find_by_name",
    "name": "player",
    "type": "cc.ImageAsset"
  }
}
```

*Guide for asset.find_by_name: Find assets by name pattern*


### asset.search

**描述**: Search assets by type in folder

**参数**:

- `type`: Asset type filter (e.g. "cc.ImageAsset", "cc.Prefab", "all") (默认: "all")
- `folder`: Folder to search (default: "db://assets")

**返回**: Array of matching assets

**示例**: ```json
{
  "input": {
    "action": "search",
    "type": "cc.Prefab",
    "folder": "db://assets/prefabs"
  }
}
```

*Guide for asset.search: Search assets by type in folder*


### asset.create

**描述**: Create a new asset file

**参数**:

- `url`: Target URL (e.g. "db://assets/scripts/NewScript.ts")
- `content`: File content
- `overwrite`: Overwrite if exists (默认: false)

**示例**: ```json
{
  "input": {
    "action": "create",
    "url": "db://assets/scripts/GameManager.ts",
    "content": "import { _decorator } from \"cc\";\n..."
  }
}
```

*Guide for asset.create: Create a new asset file*


### asset.delete

**描述**: Delete an asset

**参数**:

- `url`: Asset URL to delete

**示例**: ```json
{
  "input": {
    "action": "delete",
    "url": "db://assets/unused/old-sprite.png"
  }
}
```

*Guide for asset.delete: Delete an asset*


### asset.import

**描述**: Import external file into project

**参数**:

- `sourcePath`: External file system path
- `targetFolder`: Target folder in project (e.g. "db://assets/textures")

**示例**: ```json
{
  "input": {
    "action": "import",
    "sourcePath": "/Users/me/Desktop/icon.png",
    "targetFolder": "db://assets/textures"
  }
}
```

*Guide for asset.import: Import external file into project*

> 未获取到指南的 action: list, get_info, update


---

## `editor`(32 个 action 指南)


### editor.project_info

**描述**: Get project info (name, path, engine version)

**返回**: Project name, path, engine version, settings

**示例**: ```json
{
  "input": {
    "action": "project_info"
  }
}
```

*Guide for editor.project_info: Get project info (name, path, engine version)*


### editor.project_settings

**描述**: Get project settings by category

**参数**:

- `category`: Settings category (e.g. "general", "physics")

**返回**: Settings object for category

**示例**: ```json
{
  "input": {
    "action": "project_settings",
    "category": "general"
  }
}
```

*Guide for editor.project_settings: Get project settings by category*


### editor.run

**描述**: Run/preview the project

**示例**: ```json
{
  "input": {
    "action": "run"
  }
}
```

*Guide for editor.run: Run/preview the project*


### editor.build

**描述**: Build the project

**参数**:

- `platform`: Build platform (e.g. "web-mobile", "android")

**示例**: ```json
{
  "input": {
    "action": "build",
    "platform": "web-mobile"
  }
}
```

*Guide for editor.build: Build the project*


### editor.build_settings

**描述**: Get current build settings

**返回**: Build configuration

**示例**: ```json
{
  "input": {
    "action": "build_settings"
  }
}
```

*Guide for editor.build_settings: Get current build settings*


### editor.open_build_panel

**描述**: Open the Build panel in editor

**示例**: ```json
{
  "input": {
    "action": "open_build_panel"
  }
}
```

*Guide for editor.open_build_panel: Open the Build panel in editor*


### editor.builder_status

**描述**: Check builder/compile status

**返回**: Builder status info

**示例**: ```json
{
  "input": {
    "action": "builder_status"
  }
}
```

*Guide for editor.builder_status: Check builder/compile status*


### editor.start_preview

**描述**: Start preview server

**参数**:

- `port`: Preview server port

**示例**: ```json
{
  "input": {
    "action": "start_preview"
  }
}
```

*Guide for editor.start_preview: Start preview server*


### editor.stop_preview

**描述**: Stop preview server

**示例**: ```json
{
  "input": {
    "action": "stop_preview"
  }
}
```

*Guide for editor.stop_preview: Stop preview server*


### editor.console_logs

**描述**: Get console log entries

**参数**:

- `limit`: Max entries to return
- `logType`: Filter: "log", "warn", or "error"

**返回**: Array of log entries

**示例**: ```json
{
  "input": {
    "action": "console_logs",
    "limit": 20,
    "logType": "error"
  }
}
```

*Guide for editor.console_logs: Get console log entries*


### editor.console_clear

**描述**: Clear console logs

**示例**: ```json
{
  "input": {
    "action": "console_clear"
  }
}
```

*Guide for editor.console_clear: Clear console logs*


### editor.log_read

**描述**: Read editor log file

**参数**:

- `lines`: Number of lines to read
- `keyword`: Filter by keyword
- `logType`: Log type filter

**返回**: Log file content

**示例**: ```json
{
  "input": {
    "action": "log_read",
    "lines": 50,
    "keyword": "ERROR"
  }
}
```

*Guide for editor.log_read: Read editor log file*


### editor.log_search

**描述**: Search logs by keyword

**参数**:

- `keyword`: Search keyword

**返回**: Matching log entries

**示例**: ```json
{
  "input": {
    "action": "log_search",
    "keyword": "TypeError"
  }
}
```

*Guide for editor.log_search: Search logs by keyword*


### editor.log_info

**描述**: Get log file info (path, size)

**返回**: Log file metadata

**示例**: ```json
{
  "input": {
    "action": "log_info"
  }
}
```

*Guide for editor.log_info: Get log file info (path, size)*


### editor.mcp_log_read

**描述**: Read MCP server log

**参数**:

- `lines`: Number of lines
- `keyword`: Filter keyword

**示例**: ```json
{
  "input": {
    "action": "mcp_log_read",
    "lines": 30
  }
}
```

*Guide for editor.mcp_log_read: Read MCP server log*


### editor.mcp_log_clear

**描述**: Clear MCP server log

**示例**: ```json
{
  "input": {
    "action": "mcp_log_clear"
  }
}
```

*Guide for editor.mcp_log_clear: Clear MCP server log*


### editor.editor_info

**描述**: Get editor info (version, platform, language)

**返回**: Editor version, platform, language

**示例**: ```json
{
  "input": {
    "action": "editor_info"
  }
}
```

*Guide for editor.editor_info: Get editor info (version, platform, language)*


### editor.performance

**描述**: Get editor performance metrics

**返回**: Memory, CPU, and timing info

**示例**: ```json
{
  "input": {
    "action": "performance"
  }
}
```

*Guide for editor.performance: Get editor performance metrics*


### editor.pref_open

**描述**: Open Preferences panel

**参数**:

- `tab`: Tab to open

**示例**: ```json
{
  "input": {
    "action": "pref_open",
    "tab": "general"
  }
}
```

*Guide for editor.pref_open: Open Preferences panel*


### editor.pref_get

**描述**: Get preference value

**参数**:

- `category`: Preference category
- `path`: Config path within category

**返回**: Preference value

**示例**: ```json
{
  "input": {
    "action": "pref_get",
    "category": "general",
    "path": "language"
  }
}
```

*Guide for editor.pref_get: Get preference value*


### editor.pref_set

**描述**: Set preference value

**参数**:

- `category`: Preference category
- `path`: Config path
- `value`: Value to set

**示例**: ```json
{
  "input": {
    "action": "pref_set",
    "category": "general",
    "path": "language",
    "value": "en"
  }
}
```

*Guide for editor.pref_set: Set preference value*


### editor.pref_reset

**描述**: Reset preference category to defaults

**参数**:

- `category`: Category to reset

**示例**: ```json
{
  "input": {
    "action": "pref_reset",
    "category": "general"
  }
}
```

*Guide for editor.pref_reset: Reset preference category to defaults*


### editor.pref_all

**描述**: Get all preferences

**返回**: All preference categories and values

**示例**: ```json
{
  "input": {
    "action": "pref_all"
  }
}
```

*Guide for editor.pref_all: Get all preferences*


### editor.pref_categories

**描述**: List available preference categories

**返回**: Array of category names

**示例**: ```json
{
  "input": {
    "action": "pref_categories"
  }
}
```

*Guide for editor.pref_categories: List available preference categories*


### editor.pref_search

**描述**: Search preferences by keyword

**参数**:

- `query`: Search query

**返回**: Matching preference entries

**示例**: ```json
{
  "input": {
    "action": "pref_search",
    "query": "font"
  }
}
```

*Guide for editor.pref_search: Search preferences by keyword*


### editor.pref_export

**描述**: Export all preferences as JSON

**返回**: Full preferences JSON

**示例**: ```json
{
  "input": {
    "action": "pref_export"
  }
}
```

*Guide for editor.pref_export: Export all preferences as JSON*


### editor.server_ips

**描述**: Get server IP addresses

**返回**: Array of IP addresses

**示例**: ```json
{
  "input": {
    "action": "server_ips"
  }
}
```

*Guide for editor.server_ips: Get server IP addresses*


### editor.server_port

**描述**: Get MCP server port

**返回**: Port number

**示例**: ```json
{
  "input": {
    "action": "server_port"
  }
}
```

*Guide for editor.server_port: Get MCP server port*


### editor.server_status

**描述**: Get MCP server status

**返回**: Server running state and info

**示例**: ```json
{
  "input": {
    "action": "server_status"
  }
}
```

*Guide for editor.server_status: Get MCP server status*


### editor.server_test

**描述**: Test server connectivity

**参数**:

- `timeout`: Timeout in ms

**返回**: Connection test result

**示例**: ```json
{
  "input": {
    "action": "server_test",
    "timeout": 5000
  }
}
```

*Guide for editor.server_test: Test server connectivity*


### editor.server_interfaces

**描述**: List network interfaces

**返回**: Network interface details

**示例**: ```json
{
  "input": {
    "action": "server_interfaces"
  }
}
```

*Guide for editor.server_interfaces: List network interfaces*


### editor.reload

**描述**: Reload editor window (equivalent to Developer → 重新加载)

**示例**: ```json
{
  "input": {
    "action": "reload"
  }
}
```

*Guide for editor.reload: Reload editor window (equivalent to Developer → 重新加载)*

> 未获取到指南的 action: stop


---

## `view`(4 个 action 指南)


### view.gizmo_tool

**描述**: Set active gizmo tool

**参数**:

- `tool`: Tool name

**示例**: ```json
{
  "input": {
    "action": "gizmo_tool",
    "tool": "position"
  }
}
```

*Guide for view.gizmo_tool: Set active gizmo tool*


### view.camera_focus

**描述**: Focus camera on node(s)

**参数**:

- `nodes`: Node UUIDs to focus on (default: current selection)

**示例**: ```json
{
  "input": {
    "action": "camera_focus",
    "nodes": [
      "uuid-1"
    ]
  }
}
```

*Guide for view.camera_focus: Focus camera on node(s)*


### view.camera_align_view

**描述**: Align selected node to current camera view

**示例**: ```json
{
  "input": {
    "action": "camera_align_view"
  }
}
```

*Guide for view.camera_align_view: Align selected node to current camera view*


### view.camera_align_node

**描述**: Align camera to selected node view

**参数**:

- `nodes`: Node UUIDs

**示例**: ```json
{
  "input": {
    "action": "camera_align_node",
    "nodes": [
      "uuid-1"
    ]
  }
}
```

*Guide for view.camera_align_node: Align camera to selected node view*

> 未获取到指南的 action: set_2d, set_3d, reference_image, align_node, align_view, viewport_info


---

## `composite`(9 个 action 指南)


### composite.create_button

**描述**: Create a complete Button node (with Label, Sprite, Button component)

**参数**:

- `parent`: Parent node: UUID, path, or name
- `name`: Button node name
- `text`: Button label text
- `fontSize`: Font size (默认: 28)
- `size`: {width, height}
- `position`: {x, y}
- `color`: Color: "#hex" or {r,g,b,a}
- `spriteFrame`: Button normal-state sprite frame path (e.g. "db://assets/resources/textures/ui/btn-normal/spriteFrame")
- `pressedSpriteFrame`: Button pressed-state sprite frame path (e.g. "db://assets/resources/textures/ui/btn-pressed/spriteFrame")

**示例**: ```json
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

**注意事项**: Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2),Response includes viewport context. Out-of-bounds positions trigger warnings.,Button auto-configured: Sprite sizeMode=CUSTOM, _type=SLICED(nine-slice), Button transition=SPRITE, Label overflow=SHRINK(auto-fit text),IMPORTANT: After creation, bind click event with cocos_component(action:"click_event") — buttons without click events do nothing when clicked

*Guide for composite.create_button: Create a complete Button node (with Label, Sprite, Button component)*


### composite.create_label

**描述**: Create a Label node

**参数**:

- `parent`: Parent node: UUID, path, or name
- `name`: Label node name
- `text`: Text content
- `fontSize`: Font size (默认: 28)
- `size`: {width, height}
- `position`: {x, y}

**示例**: ```json
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

**注意事项**: Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2),Response includes viewport context. Out-of-bounds positions trigger warnings.

*Guide for composite.create_label: Create a Label node*


### composite.create_image

**描述**: Create a Sprite/image node

**参数**:

- `parent`: Parent node: UUID, path, or name
- `name`: Sprite node name
- `size`: {width, height}
- `position`: {x, y}
- `spriteFrame`: Sprite frame path or "default"

**示例**: ```json
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

**注意事项**: Canvas children: (0,0)=screen center. Visible: (-designWidth/2,-designHeight/2)~(designWidth/2,designHeight/2),Response includes viewport context. Out-of-bounds positions trigger warnings.

*Guide for composite.create_image: Create a Sprite/image node*


### composite.mount_and_bind

**描述**: Mount script to node and bind properties to child nodes/assets

**参数**:

- `node`: Target node: UUID, path, or name
- `scriptPath`: Script asset path (e.g. "db://assets/scripts/Game.ts")
- `bindings`: Property bindings: {"propName": "NodeName" or "Canvas/Path/Node" or "db://asset/path"}. Node names auto-resolved with nearby-first strategy.

**示例**: ```json
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

**注意事项**: bindings values: node names/paths (auto-resolved), asset db:// URLs, or UUIDs. Same-name nodes resolved by proximity to target node.

*Guide for composite.mount_and_bind: Mount script to node and bind properties to child nodes/assets*


### composite.setup_widget

**描述**: Configure Widget component alignment on a node

**参数**:

- `node`: Target node: UUID, path, or name
- `align`: Alignment preset
- `margin`: Margins: {top, bottom, left, right}

**示例**: ```json
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

**注意事项**: Automatically adds Widget component if not present

*Guide for composite.setup_widget: Configure Widget component alignment on a node*


### composite.batch

**描述**: Batch create multiple nodes from template or source

**参数**:

- `parent`: Parent node: UUID, path, or name
- `count`: Number of items to create
- `template`: Template definition: {type, text, ...}
- `source`: Source node to clone (UUID, path, or name)
- `namePrefix`: Name prefix for items (e.g. "Item" → "Item_0", "Item_1")

**示例**: ```json
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

**注意事项**: Use template for new nodes, or source to clone existing node

*Guide for composite.batch: Batch create multiple nodes from template or source*


### composite.batch_create_button

**描述**: Batch create multiple complete Button nodes in one call (3+ buttons → use this)

**参数**:

- `parent`: Default parent node for all buttons (can be overridden per-button)
- `buttons`: Array of button definitions: [{name, text?, fontSize?, size?, spriteFrame?, color?, clickEvent?, position?}]

**示例**: ```json
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

**注意事项**: Each button is created using the same logic as create_button,Per-button position is set after creation if provided,Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

*Guide for composite.batch_create_button: Batch create multiple complete Button nodes in one call (3+ buttons → use this)*


### composite.batch_create_label

**描述**: Batch create multiple Label nodes in one call (3+ labels → use this)

**参数**:

- `parent`: Default parent node for all labels (can be overridden per-label)
- `labels`: Array of label definitions: [{name, text, fontSize?, color?, position?}]

**示例**: ```json
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

**注意事项**: Each label is created using the same logic as create_label,Per-label position and color are set after creation if provided,Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

*Guide for composite.batch_create_label: Batch create multiple Label nodes in one call (3+ labels → use this)*


### composite.batch_create_image

**描述**: Batch create multiple Sprite/image nodes in one call (3+ images → use this)

**参数**:

- `parent`: Default parent node for all images (can be overridden per-image)
- `images`: Array of image definitions: [{name, spriteFrame, size?, position?}]

**示例**: ```json
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

**注意事项**: Each image is created using the same logic as create_image,Per-image position is set after creation if provided,Returns {created, failed, results: [{name, uuid, warnings?, error?}]}

*Guide for composite.batch_create_image: Batch create multiple Sprite/image nodes in one call (3+ images → use this)*


---

## `validate`(3 个 action 指南)


### validate.layout

**描述**: Validate UI layout (overlaps, out-of-bounds, sizing issues)

**参数**:

- `rootNode`: Root node to validate (default: entire scene)

**返回**: Array of layout issues with severity and fix suggestions

**示例**: ```json
{
  "input": {
    "action": "layout"
  }
}
```

*Guide for validate.layout: Validate UI layout (overlaps, out-of-bounds, sizing issues)*


### validate.references

**描述**: Check for broken asset/node references

**参数**:

- `rootNode`: Root node to validate (default: entire scene)

**返回**: Array of broken references with affected nodes

**示例**: ```json
{
  "input": {
    "action": "references",
    "rootNode": "Canvas"
  }
}
```

*Guide for validate.references: Check for broken asset/node references*


### validate.hierarchy

**描述**: Validate node hierarchy (depth, naming, structure)

**参数**:

- `rootNode`: Root node to validate (default: entire scene)

**返回**: Array of hierarchy issues

**示例**: ```json
{
  "input": {
    "action": "hierarchy"
  }
}
```

*Guide for validate.hierarchy: Validate node hierarchy (depth, naming, structure)*

> 未获取到指南的 action: cleanup, list_rules


---

## `template`(2 个 action 指南)


### template.list

**描述**: List available UI templates

**返回**: Array of template names and descriptions

**示例**: ```json
{
  "input": {
    "action": "list"
  }
}
```

*Guide for template.list: List available UI templates*


### template.apply

**描述**: Apply a UI template (creates complete node hierarchy via builder engine)

**参数**:

- `template`: Template name
- `parent`: Parent node: UUID, path, or name (default: Canvas)
- `name`: Root node name override

**返回**: { rootUuid, rootName, totalCreated, nodes[], errors[], warnings[], postBuildActions?[] }

**示例**: ```json
{
  "input": {
    "action": "apply",
    "template": "dialog",
    "parent": "Canvas",
    "name": "ConfirmDialog"
  }
}
```

**注意事项**: Templates now use the builder engine — all builder features (UIRenderer conflict detection, default sprite, postBuildActions) apply automatically,After apply, check postBuildActions for required property linking (e.g. ScrollView.content),Template nodes come with sensible defaults (sizes, colors, text). Customize with set_component_property after creation.

*Guide for template.apply: Apply a UI template (creates complete node hierarchy via builder engine)*


---

## `capture`(2 个 action 指南)


### capture.scene_snapshot

**描述**: Full scene layout snapshot. Returns structured JSON with: scene name, design resolution, cameras, and full node hierarchy (name, position, size, widget alignment, label text, active state). Use this to understand the overall scene structure.

**参数**:

- `maxDepth`: Max hierarchy traversal depth (默认: 10)

**返回**: { sceneName, resolution:{width,height,fitWidth,fitHeight}, cameras:[{nodeName,enabled,projection,...}], totalNodes, maxDepth, hierarchy:[{name,uuid,path,active,position:{x,y},size:{width,height},anchor?,scale?,rotation?,opacity?,components:[],widget?,label?,children?}] }

**示例**: ```json
{
  "input": {
    "action": "scene_snapshot"
  },
  "output": "Full scene JSON with hierarchy, resolution 960x640, 1 camera"
}
```

**注意事项**: Each node includes: name, uuid, path, active, position(x,y), size(width,height), components list,Optional fields only appear when non-default: anchor(if not 0.5,0.5), scale(if not 1,1), rotation(if not 0), opacity(if not 255),Widget alignment info included when cc.Widget is present: alignFlags[], top/bottom/left/right margins,Label text and fontSize included when cc.Label is present,Cameras detected automatically from any cc.Camera components in the tree,Design resolution extracted from cc.Canvas component (fitWidth/fitHeight adaptation mode),Nodes beyond maxDepth show _childCount instead of children array

*Guide for capture.scene_snapshot: Full scene layout snapshot. Returns structured JSON with: scene name, design resolution, cameras, and full node hierarchy (name, position, size, widget alignment, label text, active state). Use this to understand the overall scene structure.*


### capture.node_snapshot

**描述**: Focused snapshot of a specific node and its subtree. Returns layout hierarchy plus detailed component properties for the node and its children. Handles duplicate names via UUID or path.

**参数**:

- `node`: Target node: UUID, path (e.g. "Canvas/Panel"), or name. Use path or UUID for duplicate names.
- `maxDepth`: Max hierarchy traversal depth (默认: 15)

**返回**: { rootName, rootUuid, rootPath, totalNodes, maxDepth, cameras, layout:{...compact hierarchy...}, componentDetails:{nodeName:[{type,size?,string?,fontSize?,color?,widget?,...}]} }

**注意事项**: layout: same compact hierarchy format as scene_snapshot, but includes sprite info (spriteFrame, sizeMode),componentDetails: per-node component breakdown with type-specific properties extracted,Component properties extracted: UITransform(size,anchor), Label(string,fontSize,align,color,wrap), Sprite(spriteFrame,type,sizeMode,color), Button(transition,normalColor,zoomScale), Widget(alignment), Layout(type,spacing), ProgressBar(progress), Camera(projection,fov),For duplicate node names, use path format: "Canvas/Panel/MyButton" or UUID directly,componentDetails covers root + up to 3 levels of children for performance

*Guide for capture.node_snapshot: Focused snapshot of a specific node and its subtree. Returns layout hierarchy plus detailed component properties for the node and its children. Handles duplicate names via UUID or path.*


---

## `builder`(1 个 action 指南)


### builder.build

**描述**: Build a complete node tree from a JSON definition. Creates nodes, adds components, sets properties recursively in one call.

**参数**:

- `parent`: Parent node: UUID, path, or name (default: "Canvas")
- `tree`: Node tree JSON. Each node object has: name(required), position({x,y}), size({width,height}), color("#hex" or {r,g,b,a}), anchor({x,y}), scale(number or {x,y}), rotation(number), opacity(0-255), active(bool), components(string[]), props({componentType:{prop:value}}), children(node[])
- `clean`: Remove all children of parent before building (default: false)

**返回**: { rootUuid, rootName, totalCreated, nodes: [{name,uuid,path,depth,components?}], errors[], warnings[], postBuildActions?[] }

**注意事项**: --- JSON NODE FORMAT ---,Required: "name" (string) — node name,PREFAB SHORTCUT: "type" (string) — set to a built-in UI type (Button, Label, Sprite, EditBox, ScrollView, PageView, Slider, ProgressBar, Toggle, ToggleContainer, RichText, Graphics, Mask, Layout, Widget, ParticleSystem2D, VideoPlayer, WebView, TiledMap) to create a complete control from engine prefab template. When using "type", you do NOT need "components" — the prefab handles everything. Children matching prefab children (e.g. "Label" in Button) have props applied to existing nodes instead of creating new ones.,Shortcuts (node-level): position({x,y,z?}), size({width,height}), color("#hex"|{r,g,b,a}), anchor({x,y}), scale(number|{x,y}), rotation(number, Z-axis degrees), opacity(0-255, auto-adds UIOpacity), active(bool),Components: string array like ["cc.Sprite","cc.Button"]. Do NOT include "cc.UITransform" — engine auto-creates it. Not needed when using "type".,Props: grouped by component type. Example: { "cc.Label": { "string": "Hello", "fontSize": 28 } },Children: array of nested node objects (same format recursively),--- PROPERTY VALUE FORMATS ---,Number/String/Boolean: write directly — "fontSize": 28, "string": "Hello", "enabled": true,Color: "#FF0000" or "#FF0000FF" (with alpha) or {r:255, g:0, b:0, a:255},Asset reference: "db://assets/textures/icon/spriteFrame" — auto-resolved to UUID,SpriteFrame shortcuts: "default", "button", "panel", "image", "toggle", "scrollbar",Enum values: use numbers — sizeMode: 0(CUSTOM)/1(TRIMMED)/2(RAW), horizontalAlign: 0(LEFT)/1(CENTER)/2(RIGHT), verticalAlign: 0(TOP)/1(CENTER)/2(BOTTOM), overflow: 0(NONE)/1(CLAMP)/2(SHRINK)/3(RESIZE_HEIGHT), transition(Button): 0(NONE)/1(COLOR)/2(SPRITE)/3(SCALE),--- AVAILABLE COMPONENTS ---,Renderer: cc.Sprite, cc.Label, cc.RichText, cc.Graphics, cc.Mask, cc.TiledMap, cc.Spine, cc.DragonBones,UI: cc.Button, cc.Toggle, cc.ToggleContainer, cc.Slider, cc.ProgressBar, cc.EditBox, cc.ScrollView, cc.PageView, cc.ScrollBar,Layout: cc.Widget, cc.Layout, cc.UITransform(auto), cc.UIOpacity(auto for opacity shortcut), cc.Canvas, cc.SafeArea, cc.BlockInputEvents,Animation: cc.Animation, cc.Skeleton,Audio: cc.AudioSource,Camera: cc.Camera,--- COMMON COMPONENT PROPERTIES ---,cc.Sprite: spriteFrame("db://..." or "default"), sizeMode(0=CUSTOM,1=TRIMMED,2=RAW), type(0=SIMPLE,1=SLICED,2=TILED,3=FILLED), color("#hex"),cc.Label: string, fontSize, lineHeight, horizontalAlign(0=LEFT,1=CENTER,2=RIGHT), verticalAlign(0=TOP,1=CENTER,2=BOTTOM), overflow(0=NONE,1=CLAMP,2=SHRINK,3=RESIZE_HEIGHT), color, isBold, isItalic, enableWrapText,cc.Button: transition(0=NONE,1=COLOR,2=SPRITE,3=SCALE), normalColor/pressedColor/hoverColor/disabledColor, zoomScale(for SCALE transition, default 1.2), normalSprite/pressedSprite/hoverSprite/disabledSprite,cc.Widget: isAlignTop/isAlignBottom/isAlignLeft/isAlignRight(bool), top/bottom/left/right(number), isAlignHorizontalCenter/isAlignVerticalCenter(bool), horizontalCenter/verticalCenter(number),cc.Layout: type(0=NONE,1=HORIZONTAL,2=VERTICAL,3=GRID), resizeMode(0=NONE,1=CONTAINER,2=CHILDREN), spacingX, spacingY, paddingTop/paddingBottom/paddingLeft/paddingRight,cc.ScrollView: horizontal(bool), vertical(bool), inertia(bool), brake(number 0-1), bounceDuration(number),cc.ProgressBar: mode(0=HORIZONTAL,1=VERTICAL), totalLength, progress(0-1),cc.Toggle: isChecked(bool),cc.EditBox: string, placeholder, maxLength, inputMode(0-6), returnType(0-4),cc.UIOpacity: opacity(0-255),--- UIRenderer CONFLICT ---,IMPORTANT: cc.Sprite, cc.Label, cc.RichText, cc.Graphics, cc.TiledMap, cc.Spine, cc.DragonBones are all UIRenderer subclasses and CANNOT coexist on the same node. Only the first UIRenderer in the components list is added; others are skipped with a warning. Place text (cc.Label) in a child node of the Sprite node.,--- DEFAULT SPRITE BEHAVIOR ---,When cc.Sprite is added without a spriteFrame in props, a default SpriteFrame is auto-assigned with type=SLICED and sizeMode=CUSTOM. If you specify a spriteFrame, type defaults to SIMPLE.,SPRITE SIZE FIX: Setting spriteFrame may reset sizeMode to TRIMMED, causing auto-resize to sprite dimensions. Builder automatically re-enforces sizeMode=CUSTOM and re-applies your specified size AFTER spriteFrame assignment. Your "size" field always wins.,--- POST-BUILD ACTIONS ---,Components like cc.ScrollView, cc.ProgressBar, cc.Slider, cc.Toggle need post-build property linking. After build, check the postBuildActions array in the response for required set_component_property calls with UUIDs.,--- DESIGN RESOLUTION ---,Build response includes designResolution({width,height}) and viewport context. Use these to correctly size your UI elements.,Auto-created Camera: ORTHO + SOLID_COLOR + orthoHeight=designHeight/2 + visibility=DEFAULT|UI_2D|UI_3D|USER. Matches project design resolution.,Canvas UITransform contentSize matches actual project design resolution (queried from project settings, not hardcoded).,--- COORDINATE SYSTEM ---,Canvas anchor=(0.5,0.5), so children use CENTER-ORIGIN: (0,0)=screen center.,Visible bounds for Canvas children: x∈[-designWidth/2, designWidth/2], y∈[-designHeight/2, designHeight/2].,Example 1280x720: center=(0,0). Visible=(-640,-360)~(640,360). A button at position(0,0) is screen-center.,Direct Canvas children should default to position(0,0) unless offset is needed.,Bounding box: left=x-w*ax, right=x+w*(1-ax), bottom=y-h*ay, top=y+h*(1-ay). Default anchor=(0.5,0.5).,Positions are RELATIVE TO PARENT. Direct Canvas children: position relative to Canvas center. Nested children: worldPos=parent.worldPos+local.position.,Build response includes "viewport" with designResolution, visibleRect, center, coordinateHint. Out-of-bounds nodes generate warnings.,--- AUTO CANVAS + CAMERA ---,If parent is "Canvas" (default) and Canvas does not exist in the scene, the builder auto-creates Camera(ORTHO) + Canvas(full-screen with design resolution). Existing Camera/Canvas detected by component (cc.Camera/cc.Canvas), not just by name. Duplicate Canvas nodes are auto-removed.,--- LIMITS ---,Max 200 nodes per build call, max 15 levels deep,Uses snapshot for atomicity — if build fails midway, all changes are rolled back,--- BATCH TIP ---,After building a node tree, use cocos_node(action:"batch_modify") to adjust positions/sizes of multiple nodes at once, rather than calling modify repeatedly.

*Guide for builder.build: Build a complete node tree from a JSON definition. Creates nodes, adds components, sets properties recursively in one call.*

> 未获取到指南的 action: preview, validate


---

> 统计:共 196 个 action 查询,157 个成功。
