# Cocos Creator 3.8.6 内置插件消息/广播参考文档

> 来源: `C:\ProgramData\cocos\editors\Creator\3.8.6\resources\app\builtin\`
> 基于各插件的 `package.json`、`@types/*.d.ts` 和 `source/` 源码提取。

---

## 目录

1. [插件总览](#1-插件总览)
2. [animation-graph](#2-animation-graph)
3. [animator](#3-animator)
4. [asset-db](#4-asset-db)
5. [builder](#5-builder)
6. [engine](#6-engine)
7. [information](#7-information)
8. [menu](#8-menu)
9. [messages（调试面板）](#9-messages调试面板)
10. [metrics](#10-metrics)
11. [placeholder](#11-placeholder)
12. [preferences](#12-preferences)
13. [preview](#13-preview)
14. [profile](#14-profile)
15. [program](#15-program)
16. [programming](#16-programming)
17. [project](#17-project)
18. [scene](#18-scene)
19. [server](#19-server)
20. [shortcuts](#20-shortcuts)
21. [tester](#21-tester)
22. [utils](#22-utils)
23. [window](#23-window)
24. [跨插件广播事件流](#24-跨插件广播事件流)

---

## 1. 插件总览

| # | 插件名 | 包名 | 版本 | 说明 |
|---|--------|------|------|------|
| 1 | animation-graph | animation-graph | 1.0.0 | 动画图编辑器面板 |
| 2 | animator | animator | 1.0.0 | 动画器面板（时间线编辑） |
| 3 | **asset-db** | asset-db | 1.0.0 | **核心** 资源数据库 |
| 4 | builder | builder | 1.3.9 | 构建系统 |
| 5 | engine | engine | 1.0.12 | 引擎管理 |
| 6 | information | information | 1.0.1 | 信息对话框 |
| 7 | menu | menu | 1.0.0 | 编辑器菜单 |
| 8 | messages | messages | 1.0.0 | 消息调试面板 |
| 9 | metrics | metrics | 1.0.0 | 统计/遥测 |
| 10 | placeholder | placeholder | 1.0.0 | 占位插件 |
| 11 | preferences | preferences | 1.0.0 | 偏好设置 |
| 12 | preview | preview | 1.0.1 | 游戏预览 |
| 13 | profile | profile | 1.0.0 | 性能分析 |
| 14 | program | program | 1.0.4 | 程序管理 |
| 15 | programming | programming | 1.0.0 | 编程（编译/打包） |
| 16 | project | project | 1.0.6 | 项目管理 |
| 17 | **scene** | scene | 1.0.3 | **核心** 场景编辑器 |
| 18 | server | server | 1.0.0 | 预览服务器 |
| 19 | shortcuts | shortcuts | 1.0.1 | 快捷键管理 |
| 20 | tester | tester | 1.0.0 | 自动化测试 |
| 21 | utils | utils | 1.0.0 | 工具 |
| 22 | window | window | 1.0.0 | 窗口管理 |

---

## 2. animation-graph

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `open` | — | — | 打开动画图面板 |
| `dialog-warn` | `[string]` | — | 弹出警告对话框 |
| `apply` | — | — | 应用面板中的更改 |
| `unselect` | — | — | 取消选中 |
| `delete` | — | — | 删除选中项 |
| `copy` | — | — | 复制选中项 |
| `duplicate` | — | — | 复制选中项 |
| `paste` | — | — | 粘贴 |

### 监听的广播

| 广播 | 说明 |
|------|------|
| `scene:ready` | 场景就绪时刷新面板 |
| `animation-graph:changed` | 动画图变更时刷新面板 |

---

## 3. animator

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `open` | — | — | 打开动画器面板 |
| `inspector-drop-animation` | `[uuid, path]` | — | 拖放动画剪辑到节点 |
| `change-debug-mode` | `[boolean]` | — | 切换调试模式 |
| `copy` | — | — | 复制关键帧 |
| `paste` | — | — | 粘贴关键帧 |
| `select-all` | — | — | 全选所有关键帧 |
| `delete` | — | — | 删除选中 |
| `create` | — | — | 创建关键帧 |
| `focus` | — | — | 显示所有关键帧 |
| `show-selected-keys` | — | — | 显示选中的关键帧 |
| `next-step` / `prev-step` | — | — | 前进/后退一帧 |
| `jump-to-next-key` / `jump-to-prev-key` | — | — | 跳转到下一个/上一个关键帧 |
| `jump-to-first-frame` / `jump-to-last-frame` | — | — | 跳转到第一帧/最后一帧 |
| `play-or-pause` | — | — | 播放/暂停动画 |
| `stop` | — | — | 停止动画 |
| `clear-selected` | — | — | 清除选中 |
| `switch-animation-mode` | — | — | 切换录制模式 |
| `open-docs` | — | — | 打开文档 |
| `query-last-clip-cache` | `[uuid]` | — | 查询上次剪辑缓存 |
| `save-clip-cache` | `[jsonData]` | — | 保存剪辑缓存 |
| `update-cache-config` | `[config]` | — | 更新缓存配置 |
| `enable-embedded-player` | `[boolean]` | — | 启用嵌入播放器 |
| `enable-auxiliary-curve` | `[boolean]` | — | 启用辅助曲线 |

### 监听的广播

| 广播 | 说明 |
|------|------|
| `scene:ready` | 场景打开 |
| `scene:close` | 场景关闭 |
| `scene:change-node` | 选中节点改变 |
| `scene:animation-start` | 动画开始播放 |
| `scene:animation-end` | 动画结束播放 |
| `scene:animation-change` | 动画变更 |
| `scene:animation-state-change` | 动画状态变更 |
| `scene:change-mode` | 编辑器模式变更 |
| `scene:animation-clip-change` | 当前剪辑变更 |
| `selection:activated` | 选中激活 |
| `asset-db:asset-change` | 资源变更 |
| `asset-db:asset-delete` | 资源删除 |

---

## 4. asset-db

**核心插件** — 资源数据库管理。`public` 消息均可被外部扩展调用。

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-ready` | `[]` | `boolean` | 检查 asset-db 是否就绪 |
| `create-asset` | `[url, content\|Buffer]` 或 `+AssetOperationOption` | `AssetInfo \| null` | 创建新资源 |
| `import-asset` | `[src, dest]` 或 `+AssetOperationOption` | `AssetInfo \| null` | 导入资源 |
| `copy-asset` | `[src, dest]` 或 `+AssetOperationOption` | `AssetInfo \| null` | 复制资源 |
| `move-asset` | `[src, dest]` 或 `+AssetOperationOption` | `AssetInfo \| null` | 移动资源 |
| `delete-asset` | `[url]` | `AssetInfo \| null` | 删除资源 |
| `open-asset` | `[url]` | `void` | 在编辑器中打开资源 |
| `save-asset` | `[url, content\|Buffer]` | `AssetInfo \| null` | 保存资源 |
| `save-asset-meta` | `[url, meta]` | `AssetInfo \| null` | 保存资源元数据 |
| `reimport-asset` | `[url]` | `boolean` | 重新导入资源 |
| `refresh-asset` | `[url]` | `boolean` | 刷新资源 |
| `query-asset-info` | `[urlOrUUIDOrPath, dataKeys?]` | `AssetInfo \| null` | 查询资源信息 |
| `query-missing-asset-info` | `[urlOrPath]` | `MissingAssetInfo \| null` | 查询缺失资源信息 |
| `query-asset-meta` | `[url]` | `IAssetMeta \| null` | 查询资源元数据 |
| `query-path` | `[url]` | `string \| null` | URL/UUID 转路径 |
| `query-url` | `[url]` | `string \| null` | UUID/路径转 URL |
| `query-uuid` | `[url]` | `string \| null` | URL/路径转 UUID |
| `query-assets` | `[options?, dataKeys?]` | `AssetInfo[]` | 批量查询资源 |
| `generate-available-url` | `[url]` | `string` | 生成不冲突的 URL |
| `new-asset` | `[CreateAssetOptions]` | `AssetInfo \| null` | 通过选项创建资源 |
| `execute-custom-operation` | `[handlerName, operate, ...args]` | `any` | 执行自定义处理器 |
| `batch-message-handler` | `[messageList, parallelism?]` | `any[]` | 批量处理消息 |

### 关键类型

```typescript
interface AssetInfo {
    name: string; displayName: string;
    source: string; path: string; url: string;
    file: string; uuid: string;
    importer: string; type: string;
    isDirectory: boolean; library: { [key: string]: string };
    subAssets: { [key: string]: AssetInfo };
    visible: boolean; readonly: boolean;
    imported: boolean; invalid: boolean;
}

interface AssetOperationOption {
    overwrite?: boolean;  // 强制覆盖
    rename?: boolean;     // 自动重命名
}

interface QueryAssetsOption {
    ccType?: string | string[];
    isBundle?: boolean;
    importer?: string | string[];
    pattern?: string;        // globs 路径匹配
    extname?: string | string[];
    userData?: Record<string, boolean | string | number>;
}
```

### 广播事件

| 广播 | 载荷 | 说明 |
|------|------|------|
| `asset-db:ready` | `AssetInfo?` | 资源数据库就绪 |
| `asset-db:close` | — | 资源数据库关闭 |
| `asset-db:asset-add` | `AssetInfo?` | 新增资源 |
| `asset-db:asset-change` | `AssetInfo?` | 资源变更 |
| `asset-db:asset-delete` | `AssetInfo?` | 资源删除 |
| `project:change-high-quality` | — | 项目高品质设置变更 |

---

## 5. builder

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-worker-ready` | — | `boolean` | 查询构建 worker 是否就绪 |
| `query-tasks-info` | — | `TaskInfo[]` | 查询构建任务信息 |
| `query-platform-config` | `[platform]` | — | 查询平台配置 |
| `query-compress-config` | — | — | 查询压缩配置 |
| `query-bundle-config` | — | — | 查询包配置 |

### 内部消息

| 消息 | 说明 |
|------|------|
| `open` | 打开构建面板（不同子页） |
| `open-bundle` | 打开 Bundle 面板 |
| `open-platform-debug-tools` | 打开平台调试工具 |
| `execute-build-stage` | 执行构建阶段 |
| `create-build-plugin-template` | 创建构建插件模板 |
| `create-build-template` | 创建构建模板 |
| `create-application-template` | 创建应用模板 |
| `open-devtools` | 打开 worker 开发者工具 |
| `generate-preview-setting` | 生成预览设置 |
| `add-task` | 添加构建任务 |
| `add-bundle-task` | 添加 Bundle 任务 |
| `recompile-task` | 重新编译任务 |
| `remove-task` | 移除任务 |
| `break-task` | 打断任务 |
| `query-task` | 查询指定任务 |
| `update-task` | 更新任务 |
| `save-task` | 保存任务 |
| `preview-pac` | 预览纹理打包 |
| `query-atlas-files` | 查询图集文件 |
| `command-build` | 命令行构建 |
| `preview-bundle-config` | 预览包配置 |
| `migrate-options` | 迁移构建选项 |
| `change-debug-mode` | 切换调试模式 |
| `build-by-shortcut` | 快捷键构建 |
| `preferences-changed` | 偏好设置变更 |
| `register-package` / `unregister-package` | 注册/注销构建包 |
| `open-docs` | 打开文档 |
| `check-and-complete-options` | 验证并补全选项 |
| `open-panel-devtools` | 打开面板开发者工具 |
| `open-worker-devtools` | 打开 worker 开发者工具 |
| `clear-all-cache` | 清除所有缓存 |
| `clear-assets-cache` | 清除资源缓存 |
| `clear-engine-cache` | 清除引擎缓存 |
| `copy-build-notice` | 复制构建通知 |
| `export-bundle-config` | 导出包配置 |
| `console:update-log-level` | 更新日志级别 |
| `request-to-build-worker` | 请求构建 worker |
| `change-build-bundle` | 切换构建包 |

### 广播事件

| 广播 | 说明 |
|------|------|
| `builder:task-changed` | 构建任务变更 |
| `builder:task-add` | 添加构建任务 |
| `builder:task-delete` | 删除构建任务 |
| `builder:bundle-task-changed` | Bundle 任务变更 |
| `build-worker:ready` | 构建 worker 就绪 |
| `build-worker:closed` | 构建 worker 关闭 |

---

## 6. engine

| 消息 | 参数 | 返回 | 公开 | 说明 |
|------|------|------|------|------|
| `rebuild` | — | — | — | 重建引擎（Ctrl+F7） |
| `relaunch` | — | — | — | 重新启动引擎 |
| `import-engine-error` | — | — | — | 引擎导入错误 |
| `pipeline-config-change` | — | — | — | 渲染管线配置变更 |
| `query-info` | `[]` | `EngineInfo` | ✅ | 查询引擎信息 |
| `query-engine-info` | `[]` | `EngineInfo[]` | ✅ | 查询完整引擎信息 |
| `query-modules-config` | — | — | — | 查询模块配置 |
| `change-custom-engine-config` | — | — | — | 变更自定义引擎配置 |
| `engine-custom-macro-changed` | — | — | — | 自定义宏变更 |

### 广播

| 广播 | 说明 |
|------|------|
| `engine:engine-modules-global-config-changed` | 全局模块配置变更 |

---

## 7. information

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-information` | `[tag]` | `string` | 按标签查询信息 |
| `open-information-dialog` | `[tag]` | — | 打开信息对话框 |
| `has-dialog` | `[tag]` | `boolean` | 检查对话框是否存在 |
| `close-dialog` | — | — | 关闭对话框 |

---

## 8. menu

### 监听的广播

| 广播 | 说明 |
|------|------|
| `engine:engine-modules-global-config-changed` | 引擎模块配置变更 |
| `edit-mode:enter` | 进入编辑模式 |
| `shortcuts:change` | 快捷键变更 |

### 系统角色消息

| 消息 | 说明 |
|------|------|
| `cut` | 剪切 |
| `copy` | 复制 |
| `paste` | 粘贴 |
| `select-all` | 全选 |

---

## 9. messages（调试面板）

| 消息 | 说明 |
|------|------|
| `open` | 打开消息面板 |
| `open-debug` | 打开调试面板 |
| `start-record` | 开始录制消息 |
| `stop-record` | 停止录制消息 |
| `start-auto-save` | 开始自动保存 |
| `stop-auto-save` | 停止自动保存 |
| `broadcast` | 调试：发送广播 |
| `request` | 调试：发送请求 |
| `send` | 调试：发送消息 |
| `reply` | 调试：回复消息 |
| `query-message-state` | 查询消息录制状态 |

---

## 10. metrics

| 消息 | 说明 |
|------|------|
| `track-event` | 追踪事件（分析埋点） |
| `open` | 打开相关面板 |

---

## 11. placeholder

占位插件 — 不定义具体消息。

---

## 12. preferences

| 消息 | 说明 |
|------|------|
| `open` | 打开偏好设置面板 |
| `query-config` | 查询配置 |
| `set-config` | 设置配置 |
| `reset-config` | 重置配置 |

---

## 13. preview

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-preview-info` | — | `PreviewInfo` | 查询预览信息 |

### 内部消息

| 消息 | 说明 |
|------|------|
| `open` | 打开预览 |
| `close` | 关闭预览 |
| `start` | 启动预览 |
| `stop` | 停止预览 |
| `refresh` | 刷新预览 |
| `query-play-panel-info` | 查询播放面板信息 |
| `set-preview-info` | 设置预览信息 |
| `query-scene-preview-data` | 查询场景预览数据 |
| `preview:open` | 预览打开事件 |
| `preview:close` | 预览关闭事件 |

### 监听的广播

| 广播 | 说明 |
|------|------|
| `asset-db:ready` | 资源数据库就绪 |
| `asset-db:close` | 资源数据库关闭 |
| `asset-db:asset-add` | 新增资源 |
| `asset-db:asset-change` | 资源变更 |
| `asset-db:asset-delete` | 资源删除 |
| `build-worker:ready` | 构建 worker 就绪 |
| `build-worker:closed` | 构建 worker 关闭 |
| `programming:compiled` | 编译完成 |
| `programming:compile-start` | 开始编译 |
| `programming:pack-build-end` | 打包构建完成 |

---

## 14. profile

| 消息 | 说明 |
|------|------|
| `open` | 打开性能分析面板 |
| `start-profiling` | 开始性能分析 |
| `stop-profiling` | 停止性能分析 |
| `query-profile-data` | 查询分析数据 |

---

## 15. program

| 消息 | 说明 |
|------|------|
| `open` | 打开程序面板 |
| `run` | 运行程序 |
| `stop` | 停止程序 |
| `query-program-state` | 查询程序状态 |

---

## 16. programming

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-is-worker-ready` | — | `boolean` | 查询 worker 是否就绪 |

### 内部消息

| 消息 | 说明 |
|------|------|
| `compile` | 编译项目脚本 |
| `compile-start` | 开始编译 |
| `compile-end` | 编译完成 |
| `compile-error` | 编译出错 |
| `pack-build` | 打包构建 |
| `pack-build-start` | 开始打包 |
| `pack-build-end` | 打包完成 |
| `build-worker:ready` | Worker 就绪 |

### 广播事件

| 广播 | 说明 |
|------|------|
| `programming:compile-start` | 编译开始 |
| `programming:compiled` | 编译完成 |
| `programming:compile-error` | 编译出错 |
| `programming:pack-build-start` | 打包构建开始 |
| `programming:pack-build-end` | 打包构建结束 |

---

## 17. project

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `open` | — | — | 打开项目 |
| `close` | — | — | 关闭项目 |
| `query-project-info` | — | `ProjectInfo` | 查询项目信息 |

### 内部消息

| 消息 | 说明 |
|------|------|
| `create` | 创建新项目 |
| `save` | 保存项目 |
| `save-as` | 另存为 |
| `query-opened` | 查询是否已打开 |
| `query-recent-projects` | 查询最近项目列表 |
| `add-recent-project` | 添加最近项目 |
| `remove-recent-project` | 移除最近项目 |
| `query-profile` | 查询项目配置文件 |
| `set-profile` | 设置项目配置文件 |

---

## 18. scene

**核心插件** — 场景编辑器。管理所有节点/组件/属性/动画操作。

### 公共消息 — 场景管理

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `open-scene` | `[uuid: string]` | `boolean` | 按 UUID 打开场景 |
| `save-scene` | `[]` 或 `[boolean]` | `boolean` | 保存当前场景 |
| `save-as-scene` | `[boolean]` | `boolean` | 另存场景 |
| `close-scene` | `[]` | `boolean` | 关闭当前场景 |
| `query-is-ready` | `[]` | `boolean` | 场景是否就绪 |
| `query-dirty` | `[]` | `boolean` | 是否有未保存的更改 |

### 公共消息 — 节点操作

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-node` | `[uuid, opts?]` | `INode` | 查询节点 dump 数据 |
| `query-node-tree` | `[uuid]` | `INode` | 查询节点树（含子节点） |
| `query-nodes-by-asset-uuid` | `[assetUuid]` | `string[]` | 查找使用某资源的节点 |
| `create-node` | `[options]` | `string` | 创建节点 |
| `copy-node` | `[uuid \| uuid[]]` | `string[]` | 复制节点 |
| `duplicate-node` | `[uuid \| uuid[]]` | `string[]` | 复制节点 |
| `paste-node` | `[options]` | `string[]` | 粘贴节点 |
| `cut-node` | `[uuid \| uuid[]]` | `void` | 剪切节点 |
| `set-parent` | `[options]` | `string[]` | 重设父级 |
| `remove-node` | `[uuid \| uuid[]]` | `boolean` | 移除节点 |
| `reset-node` | `[uuid \| uuid[]]` | `boolean` | 重置节点变换 |
| `set-property` | `[SetPropertyOptions]` | `boolean` | 设置属性 |
| `reset-property` | `[SetPropertyOptions]` | `boolean` | 重置属性为默认值 |
| `move-array-element` | `[MoveArrayOptions]` | `void` | 移动数组属性元素 |
| `remove-array-element` | `[RemoveArrayOptions]` | `void` | 移除数组属性元素 |

### 公共消息 — 组件操作

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-component` | `[uuid]` | `IComponent` | 查询组件 dump |
| `query-components` | `[type?]` | `IComponent[]` | 列出所有组件类型 |
| `query-classes` | `[options?]` | `IClass[]` | 查询类列表 |
| `query-component-has-script` | `[uuid]` | `boolean` | 检查组件是否有脚本 |
| `create-component` | `[options]` | `string[]` | 添加组件 |
| `remove-component` | `[uuid]` | `void` | 移除组件 |
| `reset-component` | `[uuid]` | `boolean` | 重置组件 |
| `execute-component-method` | `[uuid, method, ...args]` | `any` | 调用组件方法 |
| `execute-scene-script` | `[scriptPath, method, ...args]` | `any` | 执行扩展脚本 |

### 公共消息 — Prefab / Undo

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `restore-prefab` | `[uuid]` | `string[]` | 从资源恢复 prefab |
| `snapshot` | `[uuid?]` | `void` | 记录撤销快照 |
| `snapshot-abort` | — | `void` | 中止录制 |
| `begin-recording` | — | `void` | 开始撤销录制 |
| `end-recording` | — | `void` | 结束撤销录制 |
| `cancel-recording` | — | `void` | 取消撤销录制 |

### 公共消息 — Gizmo / 视口

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `change-gizmo-tool` | `[tool]` | `void` | 切换工具 |
| `query-gizmo-tool-name` | — | `string` | 查询当前工具 |
| `change-gizmo-pivot` | `[type]` | `void` | 切换轴心 |
| `query-gizmo-pivot` | — | `string` | 查询轴心模式 |
| `change-gizmo-coordinate` | `[type]` | `void` | 切换坐标系 |
| `query-gizmo-coordinate` | — | `string` | 查询坐标系 |
| `change-is2D` | `[boolean]` | `void` | 切换 2D/3D |
| `query-is2D` | — | `boolean` | 查询 2D/3D 模式 |
| `set-grid-visible` | `[boolean]` | `void` | 显示/隐藏网格 |
| `query-is-grid-visible` | — | `boolean` | 查询网格可见性 |
| `set-icon-gizmo-3d` | `[boolean]` | `void` | 切换图标 3D/2D |
| `query-is-icon-gizmo-3d` | — | `boolean` | 查询图标模式 |
| `set-icon-gizmo-size` | `[size]` | `void` | 设置图标大小 |
| `query-icon-gizmo-size` | — | `number` | 查询图标大小 |
| `focus-camera` | `[uuids?]` | `void` | 聚焦相机到节点 |
| `query-scene-bounds` | — | `IBounds` | 查询场景边界 |

工具值: `position` / `rotation` / `scale` / `rect`
轴心值: `pivot` / `center`
坐标系值: `local` / `global`

### 广播事件（`ISceneEvents`）

| 事件 | 载荷 | 说明 |
|------|------|------|
| `scene:show-loading` | — | 显示加载指示器 |
| `scene:hide-loading` | — | 隐藏加载指示器 |
| `scene:ready` | — | 场景就绪 |
| `scene:close` | — | 场景关闭 |
| `scene:change-node` | — | 选中节点变更 |
| `scene:animation-start` | — | 动画开始播放 |
| `scene:animation-end` | — | 动画停止播放 |
| `scene:animation-change` | — | 动画变更 |
| `scene:animation-state-change` | — | 动画状态变更 |
| `scene:change-mode` | — | 编辑器模式切换 |
| `scene:animation-clip-change` | — | 当前剪辑变更 |
| `selection:activated` | — | 选中节点激活 |
| `window:zoom-level-change` | — | 窗口缩放级别变更 |
| `window:focus-zoom-level-change` | — | 焦点窗口缩放级别变更 |

---

## 19. server

### 公共消息

| 消息 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `query-ip-list` | — | `string[]` | 查询本地 IP 列表 |
| `query-sort-ip-list` | — | `string[]` | 查询排序后的 IP 列表 |
| `query-port` | — | `number` | 查询预览端口 |

### 内部消息

| 消息 | 说明 |
|------|------|
| `query-https-enabled` | 查询是否启用 HTTPS |
| `scan-lan` | 扫描局域网设备 |
| `change-preview-port` | 更改预览端口 |
| `change-https-options` | 更改 HTTPS 选项 |

---

## 20. shortcuts

| 消息 | 说明 |
|------|------|
| `open` | 打开快捷键面板 |
| `query-shortcut-map` | 查询所有快捷键映射 |
| `change-shortcut` | 更改快捷键绑定 |
| `change-tab` | 切换面板标签 |
| `reset-shortcut` | 重置快捷键 |
| `query-packages-shortcut-list` | 查询扩展包的快捷键 |
| `remove-custom-shortcut` | 移除自定义快捷键 |

### 广播

| 广播 | 说明 |
|------|------|
| `shortcuts:change` | 快捷键变更 |

---

## 21. tester

| 消息 | 说明 |
|------|------|
| `open` | 打开测试面板 |
| `forwarding-to-window` | 转发消息到测试窗口 |
| `*`（通配符） | 所有消息转发到面板 |
| `auto-test` | 运行自动化测试 |

---

## 22. utils

| 消息 | 说明 |
|------|------|
| `export-dts` | 导出类型声明文件 |
| `tester-tag` | 测试标签 |

---

## 23. window

| 消息 | 说明 |
|------|------|
| `focus-window-zoom-in` | 放大焦点窗口（Ctrl+Shift+=） |
| `focus-window-zoom-out` | 缩小焦点窗口（Ctrl+Shift+-） |
| `focus-window-zoom-to-initial` | 重置缩放（Ctrl+Shift+0） |
| `window-zoom-level-change` | 窗口缩放级别变更（广播） |

---

## 24. 跨插件广播事件流

| 广播事件 | 发送者 | 监听者 | 说明 |
|----------|--------|--------|------|
| `asset-db:ready` | asset-db | builder, project, preview, animator, scene | 资源数据库就绪 |
| `asset-db:close` | asset-db | builder, preview | 资源数据库关闭 |
| `asset-db:asset-add` | asset-db | builder, preview, animator, scene | 新增资源 |
| `asset-db:asset-change` | asset-db | builder, preview, animator, scene | 资源变更 |
| `asset-db:asset-delete` | asset-db | builder, preview, animator, scene | 资源删除 |
| `scene:ready` | scene | animator, animation-graph | 场景就绪 |
| `scene:close` | scene | animator | 场景关闭 |
| `scene:change-node` | scene | animator | 选中节点变更 |
| `scene:animation-start` | scene | animator | 动画开始 |
| `scene:animation-end` | scene | animator | 动画结束 |
| `scene:animation-change` | scene | animator | 动画变更 |
| `scene:animation-state-change` | scene | animator | 动画状态变更 |
| `scene:change-mode` | scene | animator | 编辑器模式切换 |
| `scene:animation-clip-change` | scene | animator | 当前剪辑变更 |
| `selection:activated` | scene | animator | 选中节点激活 |
| `shortcuts:change` | scene / shortcuts | shortcuts, menu | 快捷键变更 |
| `engine:engine-modules-global-config-changed` | engine | menu | 引擎模块配置变更 |
| `build-worker:ready` | builder | preview | 构建 worker 就绪 |
| `build-worker:closed` | builder | preview | 构建 worker 关闭 |
| `programming:compiled` | programming | preview | 编译完成 |
| `programming:compile-start` | programming | preview | 开始编译 |
| `programming:pack-build-end` | programming | builder, preview | 打包构建完成 |
| `edit-mode:enter` | 核心编辑器 | menu | 进入编辑模式 |
| `window:zoom-level-change` | window | scene | 窗口缩放变更 |
| `window:focus-zoom-level-change` | window | scene | 焦点窗口缩放变更 |

---

## 如何为扩展注册消息

### 在 `package.json` 中定义

```jsonc
{
  "name": "my-extension",
  "contributions": {
    "messages": {
      "my-message": {
        "public": true,           // 是否公开
        "methods": ["myHandler"]
      }
    },
    // 监听广播
    "asset-db:asset-change": {
      "methods": ["onAssetChange"]
    }
  }
}
```

### 从代码中发送消息/请求

```typescript
// 发送消息（单向，无返回）
Editor.Message.send('asset-db', 'create-asset', url, content);

// 请求（等待返回）
const info = await Editor.Message.request('asset-db', 'query-asset-info', url);

// 广播
Editor.Message.broadcast('my-custom-event', payload);
```
