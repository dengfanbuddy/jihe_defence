/**
 * BagConfig.ts — **通用道具**配置门面（唯一读口）
 *
 * 数据源：`assets/resources/tb/bag_items.json`（配表编辑源 `tools/excel_export/excel/bag_items.xlsx`）。
 * 一行一件道具；**长什么样、叫什么、堆叠到几** 全在表里，代码里不写死任何一件道具
 * （加一件新道具 = 表里加一行 + 给它一个产出源，界面与 VM 都不用改）。
 *
 * 分工（与项目其它界面一致）：
 *   · **本文件只回答"这件道具是什么"**（定义 / 图标 / 排序 / 堆叠上限 / 品质）；
 *   · **"玩家有几件"在 `data/funcs/BagData.ts`**（存档，按 `key` 记账）；
 *   · **"界面显示什么"在 `ui/views/bag/BagVM.ts`**（判据算一次，视图照着画）。
 *
 * ⚠ `key` 是**代码与存档之间的唯一契约**：`ad_ticket` / `outer_draw_ticket` / `boost_<code>`。
 *   改表里的 `key` = 存档里那份存量当场对不上（旧 key 的存量变成"没人认的孤儿"）。
 *   所以下面的常量与 `boostItemKey()` 是**唯一**写这些字符串的地方，别在业务代码里再拼一遍。
 *
 * 用法：
 *   BagConfig.getSortedItems()                 // 表里全部道具（按 sort 升序）
 *   BagConfig.getItem('ad_ticket')             // 局内广告券那一行
 *   BagConfig.boostItemKey('run_start_gold')   // → 'boost_run_start_gold'
 *   BagConfig.getSlotCapacity()                // 80（背包格子上限）
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
// （`Main.ts` 里对本文件做了副作用导入，注册顺序见那里）
import { BagItemCfgContainer } from '../../excel_table/Tb_BagItemConfig';
import type { BagItemCfg } from '../../excel_table/Tb_BagItemConfig';
import type { AchEffectCode } from '../../excel_table/Tb_AchievementConfig';

/**
 * **背包格子上限（80）** —— 2026-11 拍板"先定死"。
 *
 * 口径：**一格 = 一种道具**（不是一件），所以容量约束的是"有存量的种类数"。
 * 现在表里只有 12 种道具，80 是**够用的长期值**（留出后续加道具的余量），
 * 底栏「容量 N/80」显示的就是"已占用 / 80"。
 *
 * ⚠ 原预制件里写着「56/120」是**样例文案**，运行期一律被 `BagVM` 覆盖 ——
 *   别再去看预制件那一行来推容量。
 * ⚠ 之所以不建配表常量：这一轮它没有第二档取值（不做扩容），
 *   等真要做"扩容"（消耗钻石抬上限 / 分档上限）时再挪进 `battle_constants` ——
 *   那时它才是一份**会变的数据**，现在放进表里只是把常量搬了个家。
 */
export const BAG_SLOT_CAPACITY = 80;

/**
 * 三类「有产出源」的道具 key —— **全工程唯一写这几个字符串的地方**。
 * 产出源见 `DataCenter.grantMallLines`（商城 A4/A6/A7 发奖）。
 * ⚠ 三类**都是券、都进背包、都在"用的地方"问 `BagData.has/consumeItem`**（2026-11 口径）：
 *   · `ad_ticket`        局内广告券   → 局内肉鸽商店的两个广告位（`RelicShop` 的刷新 / 补选）
 *   · `revive_ticket`    局内复活券   → 局内英雄阵亡那一刻（`Scene_Game_Stage` 的复活面板）
 *   · `outer_draw_ticket` 局外遗物抽取券 → 局外遗物抽取链路（扣券优先于扣金币）
 */
export const BAG_ITEM_KEY = {
    /** 局内广告券（商城 A6；局内免看一次广告） */
    adTicket: 'ad_ticket',
    /** 局内复活券（商城 A5；局内阵亡免看广告复活一次） */
    reviveTicket: 'revive_ticket',
    /** 局外遗物抽取券（商城 A4；不花金币也不抬当日价格） */
    outerDrawTicket: 'outer_draw_ticket',
} as const;

/** 容器未就绪 / 表里没这一行时的堆叠上限回落（**不是**上限值来源，只是别让 addItem 变成 NaN） */
const FALLBACK_STACK_MAX = 99;

export class BagConfig {

    /** 配表是否已就绪（未就绪时 `getSortedItems()` 返回空数组，界面会保持预制件的样例态） */
    static isReady(): boolean {
        try {
            return TbRoot.ins.getTbContainer(BagItemCfgContainer).size > 0;
        } catch {
            return false;
        }
    }

    /** 表里全部道具（按 `sort` 升序） */
    static getSortedItems(): BagItemCfg[] {
        try {
            return TbRoot.ins.getTbContainer(BagItemCfgContainer).getSortedItems();
        } catch {
            return [];
        }
    }

    /** 按 key 取一行（配表未就绪 / key 写错时返回 undefined） */
    static getItem(key: string): BagItemCfg | undefined {
        if (!key) return undefined;
        try {
            return TbRoot.ins.getTbContainer(BagItemCfgContainer).getItemByKey(key);
        } catch {
            return undefined;
        }
    }

    /** 某条成就效果对应的增益券那一行（`boost_*` 行的 `effect_code` 反查） */
    static getItemByEffectCode(code: AchEffectCode | string): BagItemCfg | undefined {
        if (!code) return undefined;
        try {
            return TbRoot.ins.getTbContainer(BagItemCfgContainer).getItemByEffectCode(code);
        } catch {
            return undefined;
        }
    }

    /**
     * 增益券的存档 key：`成就效果 code` → `boost_<code>`。
     * ⚠ 这张券**按效果分格存**（不是"所有增益券堆一格"）——
     *   因为增益券的**效果在发放那一刻就定了**（`DataCenter.rollBoostCode` 随机一条），
     *   合并成一个数之后，入局时就没法还原"手里分别是哪几张"了。
     */
    static boostItemKey(code: AchEffectCode | string): string {
        return `boost_${code}`;
    }

    /** 某个 key 的单格堆叠上限（0 = 不限；表里没这行时回落到内置值，别让调用方拿到 NaN） */
    static getStackMax(key: string): number {
        const cfg = BagConfig.getItem(key);
        if (!cfg) return FALLBACK_STACK_MAX;
        return Math.max(0, cfg.stack_max ?? 0);
    }

    /** 背包格子上限（一格 = 一种道具；见 `BAG_SLOT_CAPACITY`） */
    static getSlotCapacity(): number {
        return BAG_SLOT_CAPACITY;
    }
}
