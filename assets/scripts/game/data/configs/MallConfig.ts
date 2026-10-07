/**
 * MallConfig.ts — **局外商城**配置门面（唯一读口）
 *
 * 数据源（`assets/resources/tb/`，由 `tools/excel_export` 导表产出）：
 *   · `mall_items.json`        商品表：一行一个商品（每日补给 + 6 个广告商品），
 *                              每行自带 `name` / `amount_text` / `grants` / `daily_limit` / `placement`
 *                              ⚠ 其中**三种券**（局外遗物抽取券 / 局内复活券 / 局内广告券）发的是**背包道具**：
 *                              `grants[].type` = `relic_draw` / `revive_ticket` / `ad_ticket`，
 *                              实发落点都是 `DataCenter.ins.bagData`（口径见 `docs/bag/README.md` §1）
 *   · `battle_constants.json`  全局规则常量（`shop*` 那 6 个键：每日广告总上限 / 免广告卡门槛与时长 /
 *                              连续登录加成阶梯 / 连续登录送券）
 *
 * ⚠ 与 `ShopConfig`（**局内**肉鸽商店：`shop_constants` / `shop_draw` / `relics` / `kill_buffs`）
 * **完全是两套东西**：本文件读的是局外全屏商城的商品，发的是局外资源（`ItemData` 金币 /
 * `HeroData.sharedExp` / `PlayerInfo.exp`），与局内那套双货币经济无关。
 * 口径真源是 `docs/shop/README.md` §2（卖什么 / 给多少 / 为什么），改数值一律改表、不改这里。
 *
 * 容错：容器未就绪时回落到本文件的内置默认值（与 `ShopConfig` 同一套路），
 * 保证启动早期（配表还没加载完）调用安全。
 *
 * 用法：
 *   MallConfig.getAdItems()                 // 六个广告商品（按 sort 升序）
 *   MallConfig.getItem('gold')              // 金币袋那一行
 *   MallConfig.getStreakMul(4)              // 连续登录 4 天的倍数 = 1.5
 *   MallConfig.getAdCardNeedWatches()       // 84
 */
import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
// （`Main.ts` 里对本文件做了副作用导入，注册顺序见那里）
import { MallItemCfgContainer } from '../../excel_table/Tb_MallItemConfig';
import type { MallItemCfg, MallItemKey } from '../../excel_table/Tb_MallItemConfig';
import { BattleConstCfgContainer } from '../../excel_table/Tb_BattleConstConfig';

/**
 * 内置默认值（与 `battle_constants.json` 的 `shop*` 键、`mall_items.json` 的取向保持一致）——
 * 只在容器不可用时兜底，**不要在业务代码里另外写一份**。
 */
const DEFAULTS = {
    /** 每日广告总次数上限（跨商品共用一本账） */
    adDailyTotalLimit: 14,
    /** 免广告卡需要累计观看的广告次数 */
    adCardNeedWatches: 84,
    /** 免广告卡生效时长（小时） */
    adCardHours: 24,
    /** 连续登录加成：下标 = 连续天数 - 1（1~2 天 ×1 / 3~6 天 ×1.5 / ≥7 天 ×2） */
    streakMuls: [1, 1, 1.5, 1.5, 1.5, 1.5, 2] as number[],
    /** 连续登录到该天数时，每日补给额外送券（0 = 不送） */
    streakGiftDay: 7,
    /** 上面那条额外送的本局增益券张数 */
    streakGiftTickets: 1,
    /** 本局增益券：一张券折算的效果数值（与 battle_constants 的 shopBoostTicketValues 一致） */
    boostTicketValues: {
        run_start_gold: 50,
        shop_option_plus: 1,
        shop_draw_discount: 10,
        ad_free_draw: 1,
        kill_buff_discount: 10,
        gold_gain_bonus: 5,
        battle_exp_bonus: 5,
        hero_start_level: 1,
        hero_select_free: 1,
        relic_start_gift: 1,
    } as Record<string, number>,
};

/** 读 `battle_constants` 的原始常量值（容器不可用时返回 undefined） */
function rawConst(key: string): any {
    try {
        return TbRoot.ins.getTbContainer(BattleConstCfgContainer).getCfgByCode(key)?.value;
    } catch {
        return undefined;
    }
}

/** 读数值常量（非数值回落 defaultValue） */
function numConst(key: string, defaultValue: number): number {
    const v = rawConst(key);
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    return defaultValue;
}

export class MallConfig {

    // ============ 商品表（mall_items） ============

    /** 配表是否已就绪（未就绪时 `getAdItems()` 返回空数组，界面会保持预制件的样例态） */
    static isReady(): boolean {
        try {
            return TbRoot.ins.getTbContainer(MallItemCfgContainer).size > 0;
        } catch {
            return false;
        }
    }

    /** 全部商品（含每日补给；按 `sort` 升序） */
    static getItems(): MallItemCfg[] {
        try {
            return TbRoot.ins.getTbContainer(MallItemCfgContainer).getcfgs()
                .slice()
                .sort((a, b) => (a.sort ?? a.id) - (b.sort ?? b.id));
        } catch {
            return [];
        }
    }

    /** 六个广告商品（`kind = 'ad'`，按 `sort` 升序）—— 界面上那一排格子（含三种券） */
    static getAdItems(): MallItemCfg[] {
        try {
            return TbRoot.ins.getTbContainer(MallItemCfgContainer).getAdItems();
        } catch {
            return [];
        }
    }

    /** 每日免费商品（`kind = 'free'`；当前只有「每日补给」） */
    static getFreeItem(): MallItemCfg | undefined {
        try {
            return TbRoot.ins.getTbContainer(MallItemCfgContainer).getFreeItem();
        } catch {
            return undefined;
        }
    }

    /** 按 key 取商品（`daily_free` / `gold` / `hero_exp` / `acc_exp` / `relic_draw` / `revive_ticket` / `ad_ticket`） */
    static getItem(key: MallItemKey | string): MallItemCfg | undefined {
        try {
            return TbRoot.ins.getTbContainer(MallItemCfgContainer).getItemByKey(key);
        } catch {
            return undefined;
        }
    }

    /** 某个商品的每日次数上限（配表没写 = 0 = 不限） */
    static getDailyLimit(key: MallItemKey | string): number {
        return Math.max(0, MallConfig.getItem(key)?.daily_limit ?? 0);
    }

    /** 某个商品的广告位标识（`kind = 'ad'` 才有；缺配时回落成 `shop_<key>`，至少埋点不空） */
    static getPlacement(key: MallItemKey | string): string {
        const cfg = MallConfig.getItem(key);
        return cfg?.placement || `shop_${key}`;
    }

    // ============ 全局规则常量（battle_constants 的 shop* 键） ============

    /** 每日广告总次数上限（跨商品共用一本账；界面底部「今日广告 N/14」） */
    static getAdDailyTotalLimit(): number {
        return Math.max(1, numConst('shopAdDailyTotalLimit', DEFAULTS.adDailyTotalLimit));
    }

    /** 免广告卡需要累计观看的广告次数（攒满即可领） */
    static getAdCardNeedWatches(): number {
        return Math.max(1, numConst('shopAdCardNeedWatches', DEFAULTS.adCardNeedWatches));
    }

    /** 免广告卡生效时长（小时） */
    static getAdCardHours(): number {
        return Math.max(1, numConst('shopAdCardHours', DEFAULTS.adCardHours));
    }

    /** 连续登录加成阶梯（下标 = 连续天数 - 1；配表给的不是数组时回落内置阶梯） */
    static getStreakMuls(): number[] {
        const v = rawConst('shopStreakMuls');
        return Array.isArray(v) && v.length ? (v as number[]) : DEFAULTS.streakMuls;
    }

    /**
     * 连续 `streakDays` 天的每日补给倍数（1 / 1.5 / 2…）。
     * 阶梯按**下表**取：`min(天数, 阶梯长度) - 1`（超出阶梯长度按最后一项，不是回到 1 倍）。
     */
    static getStreakMul(streakDays: number): number {
        const muls = MallConfig.getStreakMuls();
        const idx = Math.min(Math.max(1, Math.floor(streakDays || 1)), muls.length) - 1;
        const mul = muls[idx];
        return typeof mul === 'number' && mul > 0 ? mul : 1;
    }

    /** 连续登录达到门槛时，每日补给额外送的本局增益券张数（没到门槛 = 0） */
    static getStreakGiftTickets(streakDays: number): number {
        const day = Math.max(0, numConst('shopStreakGiftDay', DEFAULTS.streakGiftDay));
        if (day <= 0 || streakDays < day) return 0;
        return Math.max(0, Math.floor(numConst('shopStreakGiftTickets', DEFAULTS.streakGiftTickets)));
    }

    /**
     * 连续登录赠券的**门槛天数**（`shopStreakGiftDay`，现 7；0 = 这条赠券关掉了）。
     *
     * ⚠ 2026-11 起它是**本局增益券唯一的产出源**（商城 A5 那一格改成「局内复活券」了），
     * 所以这个 getter 不只是给界面看进度用的：体检（`audit:mall` F 组）靠它把连续登录顶到门槛，
     * 才摸得到那条发券路径。
     */
    static getStreakGiftDay(): number {
        return Math.max(0, numConst('shopStreakGiftDay', DEFAULTS.streakGiftDay));
    }

    /**
     * **本局增益券**（A5）每种效果「一张券折算多少」的整张表 ——
     * 键 = `AchEffectCode`（10 个候选取一），值 = 一张券的效果数值（百分比类填百分数，10 = 10%）。
     *
     * ⚠ 这张表只回答"一张券值多少"；**能不能发**（是否已达 `cap`）由
     * `AchievementEffectMeta.cap` + `DataCenter` 的抽取逻辑判（见 `docs/shop/README.md` §2.2 的 A5）。
     */
    static getBoostTicketValues(): Record<string, number> {
        const v = rawConst('shopBoostTicketValues');
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
        return { ...DEFAULTS.boostTicketValues };
    }

    /** 某条成就效果「一张增益券」的数值（没配 = 0 = 这张券发不出去） */
    static getBoostTicketValue(code: string): number {
        const v = MallConfig.getBoostTicketValues()[code];
        return typeof v === 'number' && v > 0 ? v : 0;
    }
}
