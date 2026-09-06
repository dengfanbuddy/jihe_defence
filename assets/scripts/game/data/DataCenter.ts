/**
 * DataCenter - 数据中心（单例）
 *
 * 职责：
 * - 持有所有数据模块的引用
 * - 统一初始化、保存、重置
 * - 作为游戏逻辑访问数据的唯一入口
 *
 * 用法：
 *   // 游戏启动时
 *   DataCenter.ins.init();
 *
 *   // 游戏中读写数据
 *   DataCenter.ins.playerInfo.data.level;
 *   DataCenter.ins.itemData.addCurrency(CurrencyType.Gold, 100);
 *
 *   // 游戏退出前或切后台时
 *   DataCenter.ins.saveAll();
 *
 *   // 重置账号
 *   DataCenter.ins.resetAll();
 */

import { StorageUtil } from './StorageUtil';
import { PlayerInfoModule } from './funcs/PlayerInfo';
import { HeroDataModule } from './funcs/HeroData';
import { ItemDataModule } from './funcs/ItemData';
import { EquipmentCollectionModule } from './funcs/EquipmentCollection';

export class DataCenter {
    private static _ins: DataCenter;

    static get ins(): DataCenter {
        if (!DataCenter._ins) {
            DataCenter._ins = new DataCenter();
        }
        return DataCenter._ins;
    }

    //玩家基本信息
    playerInfo = new PlayerInfoModule();
    //解锁的英雄数据
    heroData = new HeroDataModule();
    //道具数据
    itemData = new ItemDataModule();
    //局外装备收集（类似图鉴系统）
    equipCollection = new EquipmentCollectionModule();

    private _inited = false;
    private _migrated = false;

    private constructor() {}

    /** 初始化数据中心（加载所有数据） */
    init(): void {
        if (this._inited) return;
        this._inited = true;

        // 模块在构造函数中已自动加载，此处只需标记初始化完成
        // 如果需要额外的初始化逻辑（如版本迁移），在这里加
        this._migrateIfNeeded();

        console.log('[DataCenter] 数据中心初始化完成');
    }

    /** 保存所有模块到 localStorage */
    saveAll(): void {
        this.playerInfo.save();
        this.heroData.save();
        this.itemData.save();
        this.equipCollection.save();
        console.log('[DataCenter] 全部数据已保存');
    }

    /** 重置所有数据到默认值 */
    resetAll(): void {
        this.playerInfo.reset();
        this.heroData.reset();
        this.itemData.reset();
        this.equipCollection.reset();
        console.log('[DataCenter] 全部数据已重置');
    }

    /** 重置指定模块 */
    resetModule(moduleName: 'playerInfo' | 'heroData' | 'itemData' | 'equipCollection'): void {
        this[moduleName].reset();
    }

    /** 导出全部数据为 JSON（用于云存档） */
    exportAll(): Record<string, string> {
        return {
            playerInfo: this.playerInfo.serialize(),
            heroData: this.heroData.serialize(),
            itemData: this.itemData.serialize(),
            equipCollection: this.equipCollection.serialize(),
        };
    }

    /** 从 JSON 导入全部数据（用于云存档恢复） */
    importAll(data: Record<string, string>): void {
        if (data.playerInfo) this.playerInfo.deserialize(data.playerInfo);
        if (data.heroData) this.heroData.deserialize(data.heroData);
        if (data.itemData) this.itemData.deserialize(data.itemData);
        if (data.equipCollection) this.equipCollection.deserialize(data.equipCollection);
    }

    /** 释放所有模块资源（用于游戏销毁时） */
    disposeAll(): void {
        this.playerInfo.dispose();
        this.heroData.dispose();
        this.itemData.dispose();
        this.equipCollection.dispose();
        this._inited = false;
        console.log('[DataCenter] 数据中心已释放');
    }

    // ────────────── 数据版本迁移 ──────────────

    private static readonly DATA_VERSION_KEY = 'data_version';
    private static readonly CURRENT_VERSION = 1;

    /** 检查是否需要数据版本迁移 */
    private _migrateIfNeeded(): void {
        if (this._migrated) return;
        this._migrated = true;
        const savedVersion = StorageUtil.getItem<number>(DataCenter.DATA_VERSION_KEY) ?? 0;

        if (savedVersion < DataCenter.CURRENT_VERSION) {
            // 未来版本迁移逻辑：
            // if (savedVersion < 2) { this._migrateV1ToV2(); }
            // if (savedVersion < 3) { this._migrateV2ToV3(); }

            StorageUtil.setItem(DataCenter.DATA_VERSION_KEY, DataCenter.CURRENT_VERSION);
            console.log(`[DataCenter] 数据版本已迁移: v${savedVersion} → v${DataCenter.CURRENT_VERSION}`);
        }
    }
}
