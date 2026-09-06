import { JsonAsset, resources, assetManager } from "cc";
import { TbContainer } from "./TbContainer";
import { LogMgr } from "../log/LogMgr";

interface ContainerConfig {
  containerType: new (...args: any[]) => TbContainer<any>;
  bundle: string;
  path: string;
}

export class TbRoot {
  private static instance: TbRoot = null;

  /** 注册的容器配置（容器类 → 加载路径） */
  private containerConfigs: Map<string, ContainerConfig> = new Map();
  /** 已实例化的容器（容器类名 → 容器实例） */
  private containers: Map<string, TbContainer<any>> = new Map();
  private initialized = false;

  public static get ins(): TbRoot {
    if (!this.instance) {
      this.instance = new TbRoot();
    }
    return this.instance;
  }

  /**
   * 注册一个装饰器修饰的容器类
   * 由 @tb_config 装饰器自动调用
   */
  public registerContainerConfig(
    containerType: new (...args: any[]) => TbContainer<any>,
    bundle: string,
    path: string
  ): void {
    const name = containerType.name;
    if (this.containerConfigs.has(name)) {
      LogMgr.warn(`[TbRoot] 重复注册容器: ${name}`);
      return;
    }
    this.containerConfigs.set(name, { containerType, bundle, path });
    // LogMgr.info(`[TbRoot] 已注册容器: ${name} → ${bundle}:${path}`);
  }

  /**
   * 获取已加载的容器实例
   * @example TbRoot.ins.getTbContainer(HeroCfgContainer)
   */
  public getTbContainer<C extends TbContainer<any>>(
    type: new (...args: any[]) => C
  ): C {
    const container = this.containers.get(type.name);
    if (!container) {
      throw new Error(`[TbRoot] 容器未加载: ${type.name}`);
    }
    return container as C;
  }

  /**
   * 异步加载所有已注册的配置表
   */
  public async loadTbs(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.initialized) {
        LogMgr.info('[TbRoot] 配置表已加载，跳过');
        resolve(true);
        return;
      }
      const entries = Array.from(this.containerConfigs.entries());
      LogMgr.info(`[TbRoot] 开始加载配置表，共 ${entries.length} 个...`);

      // 1. 实例化所有容器
      for (const [name, config] of entries) {
        const container = new config.containerType();
        this.containers.set(name, container);
      }

      // 2. 并行加载 JSON 数据
      Promise.all(
        entries.map(async ([name, config]) => {
          try {
            const json = await this._loadJson(config.bundle, config.path);
            if (json != null) {
              const container = this.containers.get(name);
              container.handleData(json);
              LogMgr.info(`[TbRoot] ${config.bundle}:${config.path} 加载完成，共 ${container.size} 条`);
            }
          } catch (e) {
            LogMgr.err(`[TbRoot] 加载失败 ${config.bundle}:${config.path}`, e);
          }
        })
      ).then(() => {
        // 3. 所有表加载完成后的钩子
        for (const [, container] of this.containers) {
          container.afterAllHandle();
        }
        this.initialized = true;
        LogMgr.info('[TbRoot] 所有配置表加载完成');
        resolve(true);
      }).catch(e => {
        LogMgr.err('[TbRoot] 配置表加载失败', e);
        resolve(false);
      })


    })

  }

  // ===== 内部 =====

  private _loadJson(bundle: string, path: string): Promise<any | null> {
    return new Promise(resolve => {
      if (bundle === 'resources') {
        resources.load(path, JsonAsset, (err, asset) => {
          if (err) {
            LogMgr.warn(`[TbRoot] 加载失败 ${bundle}:${path}: ${err.message}`);
            resolve(null);
          } else {
            resolve(asset.json);
          }
        });
      } else {
        assetManager.loadBundle(bundle, (err, bundleAsset) => {
          if (err) {
            LogMgr.warn(`[TbRoot] 加载 bundle 失败 ${bundle}: ${err.message}`);
            resolve(null);
            return;
          }
          bundleAsset.load(path, JsonAsset, (err2, asset) => {
            if (err2) {
              LogMgr.warn(`[TbRoot] 加载失败 ${bundle}:${path}: ${err2.message}`);
              resolve(null);
            } else {
              resolve(asset.json);
            }
          });
        });
      }
    });
  }
}
