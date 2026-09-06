import { LogMgr } from "../log/LogMgr";

/**
 * 配置表容器基类
 * T 必须包含 id: number 主键（可选项 code: string 用于 codeMap 查询）
 */
export abstract class TbContainer<T extends { id: number }> {
  /** 所有配置数据 */
  cfgs: T[] = [];
  /** id 主键映射 */
  cfgMap: Map<number, T> = new Map();
  /** code 映射（可选，仅配置有 code 字段时可用） */
  codeMap: Map<string, T> = new Map();

  /** 最大 id */
  maxId: number = 0;
  /** 最小 id */
  minId: number = 0;
  /** 数据条数 */
  size: number = 0;

  abstract getTbName(): string;

  getCfgById(id: number): T | undefined {
    return this.cfgMap.get(id);
  }

  getCfgByCode(code: string): T | undefined {
    return this.codeMap.get(code);
  }

  getcfgs(): T[] {
    return this.cfgs;
  }

  /**
   * 由 TbRoot 在加载完 JSON 后调用，处理原始数据
   * 默认处理数组格式；子类可重写处理 KV 对象等特殊格式
   */
  handleData(data: any): void {
    const rawData = data as T[];
    this.cfgs = rawData;
    this.size = rawData.length;
    this.cfgMap.clear();
    this.maxId = 0;
    this.minId = 0;

    for (let i = 0; i < this.size; i++) {
      const cfg = rawData[i];
      const id = cfg.id;
      this.cfgMap.set(id, cfg);
      // 可选 code 字段映射
      const code = (cfg as any).code;
      if (code !== undefined && code !== null) {
        this.codeMap.set(String(code), cfg);
      }
      if (id > this.maxId) this.maxId = id;
      if (i === 0 || id < this.minId) this.minId = id;
    }
    this.afterHandle();
  }

  /** 当前表数据 handleData 后调用，用于数据再组装（可重写） */
  afterHandle(): void {}

  /** 所有表加载完成后调用，用于跨表关联（可重写） */
  afterAllHandle(): void {}
}
