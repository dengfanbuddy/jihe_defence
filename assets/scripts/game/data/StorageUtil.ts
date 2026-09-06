/**
 * StorageUtil - localStorage 底层封装
 * 
 * 功能：
 * - 统一的 storage key 命名空间，避免 key 冲突
 * - 序列化/反序列化自动处理
 * - 异常安全（吞掉 localStorage 不可用时的异常）
 */

const STORAGE_NAMESPACE = 'jihe_defence_';

export class StorageUtil {
    /**
     * 从 localStorage 读取并反序列化
     */
    static getItem<T>(key: string): T | null {
        try {
            const raw = localStorage.getItem(STORAGE_NAMESPACE + key);
            if (raw === null) return null;
            return JSON.parse(raw) as T;
        } catch (e) {
            console.warn(`[StorageUtil] 读取失败: ${key}`, e);
            return null;
        }
    }

    /**
     * 序列化并写入 localStorage
     */
    static setItem(key: string, value: unknown): void {
        try {
            localStorage.setItem(STORAGE_NAMESPACE + key, JSON.stringify(value));
        } catch (e) {
            console.warn(`[StorageUtil] 写入失败: ${key}`, e);
        }
    }

    /**
     * 删除指定 key
     */
    static removeItem(key: string): void {
        try {
            localStorage.removeItem(STORAGE_NAMESPACE + key);
        } catch (e) {
            console.warn(`[StorageUtil] 删除失败: ${key}`, e);
        }
    }

    /**
     * 检查 key 是否存在
     */
    static hasItem(key: string): boolean {
        try {
            return localStorage.getItem(STORAGE_NAMESPACE + key) !== null;
        } catch {
            return false;
        }
    }

    /**
     * 清除所有本游戏 namespace 下的数据
     */
    static clearAll(): void {
        try {
            const keysToRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(STORAGE_NAMESPACE)) {
                    keysToRemove.push(k);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.warn('[StorageUtil] 清理失败', e);
        }
    }

    /**
     * 获取存储数据的大小（近似，字节）
     */
    static getStorageSize(): number {
        let total = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(STORAGE_NAMESPACE)) {
                    const v = localStorage.getItem(k);
                    total += (k.length + (v ? v.length : 0)) * 2; // UTF-16
                }
            }
        } catch { /* ignore */ }
        return total;
    }
}
