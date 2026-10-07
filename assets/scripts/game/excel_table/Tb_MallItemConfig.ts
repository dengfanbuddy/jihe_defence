import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 局外商城商品配置表（mall_items.json）
 *
 * ⚠ 与 `shop_constants` / `shop_draw` / `kill_buffs`（**局内**肉鸽商店）不是一回事：
 * 这一张是**局外全屏商城**（`prefabs/ui/views/shop/View_Shop`，入口 = 主界面底部「商城」页签
 * + 顶栏三格的「+」）的商品，卖的全是既有资源的加速，一律靠激励视频获得
 * （外加每天 1 次不看广告的「每日补给」，`kind = 'free'`）。
 * 口径真源：`docs/shop/README.md` §2；查询门面：`game/data/configs/MallConfig.ts`。
 *
 * 查询：`TbRoot.ins.getTbContainer(MallItemCfgContainer).getItemByKey('gold')`
 */

/** 商品的获取方式：free = 每日免费（不看广告）/ ad = 看一次激励视频领一份 */
export type MallItemKind = 'free' | 'ad';

/**
 * 发放内容的类别（`grants[].type`）—— **一项一件**，与 `DataCenter.grantMallLines` 的发奖分支一一对应：
 *   gold           局外金币（`ItemData.currencies.gold`，≠ 局内 `hero.gold`）
 *   hero_exp       通用英雄经验（`HeroData.sharedExp`）
 *   acc_exp        账号经验（走 `DataCenter.addAccountExp`，**含等级奖励结算**）
 *   relic_draw     局外遗物**抽取券**（1 张 = 1 次抽取，不是遗物本体；进背包 `outer_draw_ticket`）
 *   revive_ticket  局内**复活券**（1 张 = 阵亡时免看广告复活一次；进背包 `revive_ticket`）
 *   ad_ticket      局内广告券（局内免看广告，跨局累积；进背包 `ad_ticket`）
 *   boost          本局增益券（随机一条成就效果，见 `AchievementEffectMeta`）——
 *                  ⚠ **商城已经没有这一格了**（A5 已改成「局内复活券」，2026-11）：
 *                  它现在只剩「连续登录 ≥ `shopStreakGiftDay` 天」这一个产出源
 *                  （`DataCenter.claimShopDailyGift` 的赠券那一支），类型保留是因为那条路径还在发。
 *
 * ⚠ 三种券类（`relic_draw` / `revive_ticket` / `ad_ticket`）**一律进背包**（`DataCenter.ins.bagData`），
 *   不在这里另存一份 —— 口径见 `docs/bag/README.md` §1。
 */
export type MallGrantType = 'gold' | 'hero_exp' | 'acc_exp' | 'relic_draw' | 'revive_ticket' | 'boost' | 'ad_ticket';

/** 一份发放内容 */
export interface MallGrant {
    type: MallGrantType;
    amount: number;
}

/**
 * 商品 key（= 代码里的 `ShopItemKey` + 每日补给的 `daily_free`）。
 * ⚠ `boost` 曾经在这里（A5 开局增益券），2026-11 起被 **`revive_ticket`（局内复活券）** 顶替 ——
 *   商城六格与预制件 `ad_list` 的六个格子一一对应，见 `ui/views/shop/ShopScope.SHOP_CELL_NODE`。
 */
export type MallItemKey = 'daily_free' | 'gold' | 'hero_exp' | 'acc_exp' | 'relic_draw' | 'revive_ticket' | 'ad_ticket';

export interface MallItemCfg {
    id: number;
    /** 商品标识（`key` 列；配置里唯一，界面按它回推是哪个格子） */
    key: MallItemKey | string;
    kind: MallItemKind;
    name: string;
    /** 格子的 sub 行文案（留空 = 该格不写 sub；`relic_draw` 的 sub 由 `ShopVM` 动态算「已收集 N/M」） */
    subtitle?: string;
    /** 格子的 amount 行文案（如 `+300 金币`） */
    amount_text?: string;
    /** 发放内容（一项一件；可能有多项，如每日补给 = 金币 + 通用英雄经验） */
    grants: MallGrant[];
    /** 每日次数上限（每日补给填 1；0 = 不限） */
    daily_limit: number;
    /** 广告位标识（`kind = 'ad'` 必填，原样传给 `AdMgr.showRewardVideo`） */
    placement?: string;
    /** 排序（升序） */
    sort?: number;
}

@tb_config(':tb/mall_items')
export class MallItemCfgContainer extends TbContainer<MallItemCfg> {
    getTbName(): string { return 'MallItemCfg'; }

    /** 按商品 key 取（`key` 列是语义标识，配置内唯一） */
    getItemByKey(key: string): MallItemCfg | undefined {
        return this.cfgs.find(c => c.key === key);
    }

    /** 每日免费商品（`kind = 'free'`；当前只有「每日补给」一条） */
    getFreeItem(): MallItemCfg | undefined {
        return this.cfgs.find(c => c.kind === 'free');
    }

    /** 广告商品（`kind = 'ad'`，按 `sort` 升序）—— 就是界面上那一排格子 */
    getAdItems(): MallItemCfg[] {
        return this.cfgs.filter(c => c.kind === 'ad')
            .sort((a, b) => (a.sort ?? a.id) - (b.sort ?? b.id));
    }

    /** 某个商品的每日次数上限（配表没写 = 0 = 不限） */
    getDailyLimit(key: string): number {
        return Math.max(0, this.getItemByKey(key)?.daily_limit ?? 0);
    }
}
