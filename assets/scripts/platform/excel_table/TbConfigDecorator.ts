/**
 * TbConfigDecorator.ts — 配置表容器装饰器
 *
 * 用法：
 *   @tb_config(':tb/heroes')
 *   class HeroCfgContainer extends TbContainer<HeroCfg> {
 *     getTbName(): string { return HeroCfg.name; }
 *   }
 *
 * 路径格式: "bundle:path" 或 ":path"（默认 resources bundle）
 *   ':tb/heroes'        → bundle=resources, path=tb/heroes
 *   'resources:tb/heroes' → bundle=resources, path=tb/heroes
 *   'myBundle:tb/items'  → bundle=myBundle, path=tb/items
 *
 * 加载（Main.ts）：
 *   await TbRoot.ins.loadTbs();
 *
 * 查询：
 *   TbRoot.ins.getTbContainer(HeroCfgContainer).getCfgByCode('sniper')
 */

import { TbRoot } from './TbRoot';

/**
 * 配置表容器装饰器
 * @param spec 路径格式："bundle:path" 或 ":path" 或 "path"
 */
export function tb_config(spec: string) {
  // 解析 bundle:path
  let bundle: string;
  let path: string;
  const colonIdx = spec.indexOf(':');
  if (colonIdx <= 0) {
    bundle = 'resources';
    path = colonIdx === 0 ? spec.substring(1) : spec;
  } else {
    bundle = spec.substring(0, colonIdx);
    path = spec.substring(colonIdx + 1);
  }

  return function <T extends { new(...args: any[]): any }>(constructor: T) {
    TbRoot.ins.registerContainerConfig(constructor as any, bundle, path);
  };
}
