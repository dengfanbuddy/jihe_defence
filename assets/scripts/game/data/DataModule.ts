/**
 * DataModule - 数据模块基类
 *
 * 职责：
 * - 提供统一的序列化/反序列化生命周期
 * - 数据变更后自动写入 localStorage（debounce）
 * - 加载时深度合并，支持数据 schema 演进
 * - 提供重置到默认值的能力
 *
 * 用法：
 *   class MyData extends DataModule<IMyData> {
 *       protected defaultData(): IMyData { return { ... }; }
 *   }
 *
 * 在游戏中直接读写 this.data.xxx，任何赋值都会触发自动保存。
 */

import { reactive, toRaw, watch } from '../../platform/reactivity';

/**
 * 深度合并：将 source 对象的属性合并到 target 中
 * - 只合并 target 已有的 key（不扩展新 key，避免无关数据残留）
 * - 嵌套对象递归合并
 * - 数组直接覆盖（不做元素级合并）
 */
function mergeDeep(target: Record<string, any>, source: Record<string, any>): void {
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        if (srcVal === undefined || srcVal === null) continue;

        if (!(key in target)) continue; // 跳过 target 中没有的 key

        const tgtVal = target[key];
        if (Array.isArray(tgtVal) || Array.isArray(srcVal)) {
            target[key] = srcVal;
        } else if (typeof tgtVal === 'object' && typeof srcVal === 'object') {
            mergeDeep(tgtVal, srcVal);
        } else {
            target[key] = srcVal;
        }
    }
}

export abstract class DataModule<T extends object> {
    /** 响应式数据对象 — 游戏中直接读写此对象 */
    protected _data!: T;

    /** 当前模块的 localStorage key（已含 namespace） */
    private readonly _key: string;

    /** watch 停止函数 */
    private _stopWatch: (() => void) | null = null;

    /** 自动保存 debounce 定时器 */
    private _saveTimer: ReturnType<typeof setTimeout> | null = null;

    /** 是否正在加载中（加载过程中的变更不触发保存） */
    private _loading = false;

    constructor(key: string) {
        this._key = key;
        this._load();
        this._startAutoSave();
    }

    // ────────────── 子类必须实现 ──────────────

    /** 返回该模块的默认数据（数据 schema 由此定义） */
    protected abstract defaultData(): T;

    // ────────────── 公开接口 ──────────────

    /** 获取响应式数据（只读建议，实际可直接修改） */
    get data(): T {
        return this._data;
    }

    /** 强制立即保存到 localStorage */
    save(): void {
        const raw = toRaw(this._data);
        StorageUtil.setItem(this._key, raw);
    }

    /** 从 localStorage 重新加载 */
    load(): void {
        this._load();
    }

    /** 重置到默认值并保存 */
    reset(): void {
        this._loading = true;
        const defaults = this._buildDefaults();
        Object.assign(this._data, defaults);
        this._loading = false;
        this._scheduleSave();
    }

    /** 序列化为 JSON 字符串 */
    serialize(): string {
        return JSON.stringify(toRaw(this._data));
    }

    /** 从 JSON 字符串反序列化并恢复到数据中 */
    deserialize(json: string): void {
        try {
            const parsed = JSON.parse(json) as Partial<T>;
            this._loading = true;
            mergeDeep(this._data, parsed);
            this._loading = false;
            this._scheduleSave();
        } catch (e) {
            console.warn(`[DataModule] 反序列化失败: ${this._key}`, e);
        }
    }

    // ────────────── 内部方法 ──────────────

    /** 构建纯净的默认数据副本 */
    private _buildDefaults(): T {
        return JSON.parse(JSON.stringify(this.defaultData()));
    }

    /** 加载：localStorage 数据与默认值深度合并 → 生成响应式对象 */
    private _load(): void {
        const defaults = this._buildDefaults();
        const saved = StorageUtil.getItem<Partial<T>>(this._key);

        if (saved) {
            mergeDeep(defaults, saved);
        }

        // 如果已有响应式对象，直接覆盖属性以保持引用
        if (this._data) {
            this._loading = true;
            Object.assign(this._data, defaults);
            this._loading = false;
        } else {
            this._data = reactive(defaults) as T;
        }
    }

    /** 启动自动保存：深度 watch 数据变化，debounce 后写入 */
    private _startAutoSave(): void {
        this._stopWatch = watch(
            () => this._data,
            () => {
                if (this._loading) return;
                this._scheduleSave();
            },
            { deep: true },
        );
    }

    /** 安排一次自动保存（100ms debounce，批量操作只存一次） */
    private _scheduleSave(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
        }
        this._saveTimer = setTimeout(() => {
            this.save();
            this._saveTimer = null;
        }, 100);
    }

    /** 停止自动保存（用于模块销毁时） */
    dispose(): void {
        if (this._stopWatch) {
            this._stopWatch();
            this._stopWatch = null;
        }
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
    }
}

// 需要使用 StorageUtil，避免循环依赖，放在基类文件末尾导入
import { StorageUtil } from './StorageUtil';
