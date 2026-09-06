// 黑板 - 存储行为树共享数据
export class Blackboard {
    private data: Map<string, any> = new Map();
    
    // 设置数据
    set<T>(key: string, value: T): void {
        this.data.set(key, value);
    }
    
    // 获取数据
    get<T>(key: string): T | undefined {
        return this.data.get(key);
    }
    
    // 检查数据是否存在
    has(key: string): boolean {
        return this.data.has(key);
    }
    
    // 删除数据
    delete(key: string): void {
        this.data.delete(key);
    }
    
    // 清空黑板
    clear(): void {
        this.data.clear();
    }
}