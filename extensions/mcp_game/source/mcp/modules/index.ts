/**
 * MCP 模块统一导出
 *
 * 此文件被 source/main.ts 导入，触发所有 @MCPModule / @MCPTool 装饰器执行，
 * 从而自动向 MetadataRegistry 注册模块和工具元数据。
 *
 * 添加新模块时在此处增加一行 export。
 */

export { SceneModule } from './SceneModule';
export { AssetModule } from './AssetModule';
export { ProjectModule } from './ProjectModule';
export { PrefabModule } from './PrefabModule';
export { DebugModule } from './DebugModule';
export { BroadcastModule } from './BroadcastModule';
export { ValidationModule } from './ValidationModule';
export { KnowledgeModule } from './KnowledgeModule';
export { AnimationModule } from './AnimationModule';
export { LabelModule } from './LabelModule';
export { SpineModule } from './SpineModule';
export { ViewModule } from './ViewModule';
export { BuilderModule } from './BuilderModule';
export { CaptureModule } from './CaptureModule';
export { TemplateModule } from './TemplateModule';
