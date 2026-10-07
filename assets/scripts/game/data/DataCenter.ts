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
import { ItemDataModule, CurrencyType } from './funcs/ItemData';
import { EquipmentCollectionModule } from './funcs/EquipmentCollection';
import { TaskDataModule } from './funcs/TaskData';
import { AchievementDataModule } from './funcs/AchievementData';
import { LevelDataModule } from './funcs/LevelData';
import { ShopDataModule } from './funcs/ShopData';
import { BagDataModule } from './funcs/BagData';
import type { ILevelUpResult } from './funcs/PlayerInfo';
import type { TaskGrantResult, TaskHost } from './funcs/TaskData';
import type { AchievementHost } from './funcs/AchievementData';
import type { ShopAdCardClaimResult, ShopAdCheck } from './funcs/ShopData';
import { LevelConfig } from './configs/LevelConfig';
import { HeroConfig } from './configs/HeroConfig';
import { MallConfig } from './configs/MallConfig';
import { BAG_ITEM_KEY } from './configs/BagConfig';
import { OuterRelicDraw } from '../battle/OuterRelicDraw';
import type { OuterDrawPlan } from '../battle/OuterRelicDraw';
import type { RelicRarity } from '../excel_table/Tb_RelicConfig';
import { BattleConstUtil } from '../battle/core/BattleConstUtil';
import { rewardMul } from '../common/DifficultyConfig';
import { ACH_EFFECT_CODES, ACH_EFFECT_META, achEffectLabel } from '../common/AchievementEffectMeta';
import type { AchEffectCode } from '../excel_table/Tb_AchievementConfig';
import type { MallGrant, MallGrantType, MallItemKey } from '../excel_table/Tb_MallItemConfig';

/** 发账号经验的结果（= 升级区间 + 该区间按等级表结算的金币奖励） */
export interface IAccountExpResult extends ILevelUpResult {
    /** 升级过程中按等级表 `reward_gold` 汇总的金币（已发放） */
    bonusGold: number;
}

/**
 * **英雄操作**（解锁 / 升级）的结果 —— `DataCenter.unlockHero` / `levelUpHero` 的返回。
 *
 * 界面只读这个结构画提示，**不自己重算判据**（够不够钱、解没解锁都是数据层给的答案）。
 */
export interface IHeroActionResult {
    ok: boolean;
    /**
     * 失败原因（`ok=true` 时是空串）：
     *   `unknown_hero`     配表里没有这个英雄（表未就绪 / id 写错）
     *   `already_unlocked` 已经解锁了（重复点）
     *   `locked`           还没解锁就想升级
     *   `no_gold`          **解锁**用的局外金币不足
     *   `no_exp`           **升级**用的通用英雄经验不足
     *   `no_formula`       配表没给经验口径（`getExpForNextLevel` 算出 0）→ 不免费升级
     */
    reason: '' | 'unknown_hero' | 'already_unlocked' | 'locked' | 'no_gold' | 'no_exp' | 'no_formula';
    /** 本次**实际消耗**的资源（失败为 0；解锁是金币，升级是通用英雄经验） */
    cost: number;
    /** 操作后的英雄等级（失败为 0 / 原等级） */
    level: number;
}

/**
 * 商城发奖的**一行实发内容**（`IShopGrantResult.granted` 的元素）。
 * 与配表 `mall_items.grants[]` 的区别：这里写的是**算完之后**的实发数量
 * （每日补给要乘连续登录倍数），所以界面可以直接照着它飘字/记账，不用再算一遍。
 */
export interface IShopGrantLine {
    type: MallGrantType;
    /** 实发数量 */
    amount: number;
    /** 一行短文案（飘字/日志用）：`+300 金币` / `击杀金币 +5%` */
    text: string;
}

/**
 * 商城接口的结果。
 * ⚠ 判据（够不够、还剩几次、攒没攒满）**只在这里算一次**：界面只读 `ok` / `reason` 画提示，
 * 不自己重算 —— 否则"界面说能领、数据层说不能"这类分歧会永远查不出来（`SHOP_REASON_TEXT` 是唯一文案表）。
 */
export interface IShopGrantResult {
    ok: boolean;
    /**
     * 失败原因（`ok = true` 时是空串）：
     *   `claimed_today`      每日补给今天已经领过了
     *   `unknown_item`       配表里没有这个商品（表未就绪 / key 写错）
     *   `not_ad`             它不是广告商品（每日补给走 `claimShopDailyGift`）
     *   `item_limit`         这一格今天看满了
     *   `daily_total_limit`  今天的广告总次数用完了（跨商品共用一本账）
     *   `boost_pool_empty`   增益券池已满（10 条效果都到了 cap，本次没有可发的东西）
     *   `not_enough`         免广告卡还没攒满
     *   `active`             免广告卡已经有一张生效中
     */
    reason: '' | 'claimed_today' | 'unknown_item' | 'not_ad' | 'item_limit' | 'daily_total_limit'
        | 'boost_pool_empty' | 'not_enough' | 'active';
    /** 实发内容（失败为空数组） */
    granted: IShopGrantLine[];
    /**
     * 供界面飘字的**一行**短文案（空 = 不飘）。
     * ⚠ 只报主项（金币优先）：`reward_fly` 的框只有 240×44，塞两行会裁字 ——
     * 多项目会在顶部读数条上一起变（那也是玩家对账的地方）。
     */
    flyText: string;
}

/**
 * **局外遗物抽取的预览**（`previewOuterDraw` 的返回）—— 图鉴页画「抽 取」按钮只读它。
 *
 * ⚠ 界面**不许**自己按价格阶梯算钱：抽一次要花什么、抽不抽得动，判据只有
 * `OuterRelicDraw.plan()` 一份（见 `DataCenter.previewOuterDraw` 的注释）。
 */
export interface IOuterDrawPreview {
    /** 请求抽几个（1 = 单抽 / 10 = 十连；已被夹到合法区间） */
    count: number;
    /** 这次**真的抽得到**几个（金币不够时可能 < `count`） */
    drawn: number;
    /** 背包里还有几张局外遗物抽取券（界面可用来解释"为什么显示的是券"） */
    ticketLeft: number;
    /** 本次会用掉几张券 */
    ticketUse: number;
    /** 本次需要花金币的抽数 */
    goldDraws: number;
    /** 金币那部分的总价（按当日阶梯逐个累加） */
    goldCost: number;
    /** 消耗文案（`抽 取` 按钮上那一行；唯一一处拼装） */
    costText: string;
    /** 至少抽得动一次（**按钮亮不亮的唯一判据**） */
    enabled: boolean;
    /** 能按 `count` 个一次抽完（false = 会少抽几个，界面该给一行提示） */
    full: boolean;
    /** 下一个**付费抽**的单价（"再抽一次要 200"这类提示 / 日志对账用） */
    nextGoldCost: number;
}

/** 一次抽取里抽到的**一件**遗物（`IOuterDrawResult.lines` 的元素） */
export interface IOuterDrawLine {
    /** 遗物 id（= `relics.json` 里那件有局外版的遗物） */
    id: number;
    name: string;
    rarity: RelicRarity;
    /** 这一抽是**用券**抽的（不扣金币、也不抬当日价格阶梯） */
    viaTicket: boolean;
    /** 这一抽花掉的金币（券抽恒为 0） */
    cost: number;
    /** 抽完之后的**总份数**（同一件可以反复抽到，份数无上限） */
    count: number;
    /** **第一次**收集到这件（界面高亮 + 播报"新"） */
    isNew: boolean;
}

/** 一次抽取（单抽 / 十连）的结果 */
export interface IOuterDrawResult {
    ok: boolean;
    /**
     * 失败原因（`ok = true` 时是空串）：
     *   `unknown_pool` 抽取池是空的（配表未就绪 / 表被改窄了）
     *   `no_resource`  券没有、金币也不够当天的第一抽 → **什么都没扣、什么都没抽**
     */
    reason: '' | 'unknown_pool' | 'no_resource';
    /** 请求抽几个 */
    requested: number;
    /** 实际抽到几个（`< requested` = 资源只够抽这么多，部分成功） */
    drawn: number;
    /** 实际用掉几张券 */
    ticketUsed: number;
    /** 实际花掉多少金币 */
    goldSpent: number;
    /** 抽到的遗物（顺序即抽取顺序；失败为空数组） */
    lines: IOuterDrawLine[];
    /** 实际消耗的一行文案（飘字/日志用，与按钮上的显示同形） */
    spentText: string;
}

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
    //任务数据（日/周任务进度 + 领奖发经验/金币）
    taskData = new TaskDataModule();
    //成就数据（一次性永久目标 + 领奖发金币 + 末档效果快照，见 docs/成就系统设计.md）
    achieveData = new AchievementDataModule();
    //难度（关卡）进度：已通关档位 / 当前选择 / 上次玩过 —— 难度弹窗与局内难度缩放的唯一数据源
    levelData = new LevelDataModule();
    //局外商城：每日补给的领取日键 / 每日广告次数 / 免广告卡
    shopData = new ShopDataModule();
    //局外背包：玩家持有的可堆叠道具（局内广告券 / 遗物抽取次数 / 本局增益券；定义表见 configs/BagConfig）
    bagData = new BagDataModule();

    private _inited = false;
    private _migrated = false;

    private constructor() {
        // 任务模块的宿主能力（等级过滤 + 发奖）。
        // 用**注入**而不是让 TaskData 直接 import DataCenter：那会形成模块循环依赖。
        const host: TaskHost = {
            getAccountLevel: () => this.playerInfo.data.level,
            grantReward: (exp, gold, taskId) => this.grantTaskReward(exp, gold, taskId),
        };
        this.taskData.setHost(host);

        // 成就模块的宿主能力（与任务同一套路：注入而不是互相 import）
        const achHost: AchievementHost = {
            getAccountLevel: () => this.playerInfo.data.level,
            getLoginStreak: () => this.playerInfo.data.loginStreak,
            // 遗物**图鉴**种类数（`relic_collected` 的数据源）：
            // 收集记录只由 `RelicShop.grantRelic` 写入，且已过滤成「有局外版」的那 37 件，
            // 所以这里直接取种类数就与图鉴页 `Cmp_OuterRelics` 的「已收集 N/37」同口径
            getRelicKinds: () => this.equipCollection.getDistinctCount(),
            grantReward: (gold, group) => this.grantAchieveReward(gold, group),
        };
        this.achieveData.setHost(achHost);
    }

    /** 初始化数据中心（加载所有数据） */
    init(): void {
        if (this._inited) return;
        this._inited = true;

        // 模块在构造函数中已自动加载，此处只需标记初始化完成
        // 如果需要额外的初始化逻辑（如版本迁移），在这里加
        this._migrateIfNeeded();

        // 等级表驱动的以下两件事必须在这里对齐一次（此时 TbRoot 已加载完）：
        // ① 读档里的 expToNext 可能是旧公式算出来的 → 按等级表刷新
        this.playerInfo.syncExpToNext();
        // ② 任务周期（跨天/跨周重置 + 每日登录置完成）
        this.taskData.ensurePeriod();
        // ③ 账号等级上报给「等级类」任务（如「账号达到 5 级」）
        this.taskData.peakProgress('level_reached', this.playerInfo.data.level);
        // ④ 成就里**不需要打一局就会变**的那几条（账号等级 / 连续登录 / 遗物种类数 / 两个种类集合）
        this.achieveData.syncNonRunPeaks();
        // ⑤ 商城的日键对齐（跨天要把「今日广告次数 / 每格今日次数」清掉）
        this.shopData.ensurePeriod();
        // ⑥ 遗物收集记录的**旧存档形态迁移**：2026-11 之前 `collected` 是 `{id: count}` 字典，
        //    而 `mergeDeep` 会把这种动态字典整片吃掉、读档后剩下的那个对象又过不了 `.find`
        //    （口径与原因见 `funcs/EquipmentCollection` 文件头 ⚠⚠）→ 启动时统一转成数组
        this.equipCollection.migrateCollectedShape();

        console.log('[DataCenter] 数据中心初始化完成');
    }

    // ────────────── 账号经验 / 等级（唯一入口） ──────────────

    /**
     * 发**账号经验**（全项目唯一入口，**不要**直接调 `playerInfo.addExp()`）。
     *
     * 为什么必须走这里：升级时按等级表 `reward_gold` 发放的金币奖励在本方法里结算，
     * 并且会把新等级上报给「账号等级」类任务；绕过它就等于丢掉等级奖励与任务进度。
     *
     * @param amount 经验值（≤0 只做一次等级对齐）
     */
    addAccountExp(amount: number): IAccountExpResult {
        const res = this.playerInfo.addExp(amount);

        // 等级奖励：跨过的每一级都算（一次加满多级时逐级累加）
        let bonusGold = 0;
        for (let lv = res.fromLevel + 1; lv <= res.toLevel; lv++) {
            bonusGold += LevelConfig.getGoldReward(lv);
        }
        if (bonusGold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, bonusGold);
        }

        if (res.leveledUp) {
            // 等级类任务（tasks.json 的 target = level_reached）
            this.taskData.peakProgress('level_reached', res.toLevel);
            // 成就：累计升级次数（add 型 —— 一次加满多级就按跨过的级数累加）
            this.achieveData.addProgress('level_up_count', res.toLevel - res.fromLevel);
            // 成就：账号等级（峰值型）—— 与 taskData 上面那行同一个落点，
            // 领奖/打局升级后**立刻**刷新，不必等下次 `syncNonRunPeaks()`（否则红点会慢一拍）
            this.achieveData.peakProgress('level_reached', res.toLevel);
            console.log(`[账号] 升级 ${res.fromLevel} → ${res.toLevel}（等级 ${res.toLevel}：${LevelConfig.getDesc(res.toLevel) || '无新解锁'}）`
                + (bonusGold > 0 ? `，等级奖励 +${bonusGold} 金币` : ''));
        }
        return { ...res, bonusGold };
    }

    /**
     * 任务领奖回填（`TaskData.claim()` 通过 TaskHost 回调到这里）：
     * 账号经验走 `addAccountExp`（含等级奖励），金币直接进 ItemData。
     */
    private grantTaskReward(exp: number, gold: number, _taskId: number): TaskGrantResult {
        const res = this.addAccountExp(exp);
        if (gold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, gold);
        }
        this.saveAll();
        return {
            leveledUp: res.leveledUp,
            fromLevel: res.fromLevel,
            toLevel: res.toLevel,
            bonusGold: res.bonusGold,
        };
    }

    /**
     * 成就领奖回填（`AchievementData.claim()` 通过 `AchievementHost` 回调到这里）。
     *
     * 与任务领奖的区别：成就**只发金币、不发账号经验**，也不产生「等级奖励」结算
     * （「末档效果永久生效」不需要在这里发 —— `AchievementData` 落盘 `claimedTier` 就等于生效，
     * 消费方开局读 `getEffects()` 快照）。
     */
    private grantAchieveReward(gold: number, _group: string): void {
        if (gold > 0) {
            this.itemData.addCurrency(CurrencyType.Gold, gold);
        }
        this.saveAll();
    }

    // ────────────── 英雄解锁 / 升级（唯一入口：含扣金币） ──────────────

    /**
     * **花金币解锁英雄**（英雄页「解 锁」按钮的唯一入口）。
     *
     * 分工：价格与公式在 `configs/HeroConfig`（读 `battle_constants`），
     * 纯数据操作在 `heroData.unlockHero`，**金币只在这里扣**（本项目局外金币的唯一出口是 `itemData`）。
     * 顺序是「先校验 → 再扣钱 → 再写存档」，任何一步不满足都不动数据。
     */
    unlockHero(heroId: number): IHeroActionResult {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) {
            return { ok: false, reason: 'unknown_hero', cost: 0, level: 0 };
        }
        if (this.heroData.isUnlocked(heroId)) {
            return { ok: false, reason: 'already_unlocked', cost: 0, level: this.heroData.getHeroLevel(heroId) };
        }

        const cost = HeroConfig.getUnlockCost(heroId);
        if (cost > 0) {
            if (!this.itemData.hasEnoughCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: 0 };
            }
            if (!this.itemData.spendCurrency(CurrencyType.Gold, cost)) {
                return { ok: false, reason: 'no_gold', cost: 0, level: 0 };
            }
        }

        this.heroData.unlockHero(heroId);
        // ⚠ 不往 tasks/achievements 的 `spend_gold` 上报：那条口径是**局内**累计消耗金币
        //   （见 Tb_TaskConfig 的字段说明与 `Scene_Game_Stage` 的上报点），
        //   局外金币（itemData）与局内金币（hero.gold）是两套经济，混在一起会把任务进度算错。
        this.saveAll();

        const level = this.heroData.getHeroLevel(heroId);
        console.log(`[英雄] 解锁 ${cfg.name}（id=${heroId}），消耗 ${cost} 金币，当前 Lv.${level}`);
        return { ok: true, reason: '', cost, level };
    }

    /**
     * **花通用英雄经验给已解锁英雄升 1 级**（英雄页卡片 / 英雄详情弹窗「升 级」按钮的唯一入口）。
     *
     * 与 `unlockHero` 的分工逐字对称：价格公式在 `HeroData.getExpForNextLevel`（**唯一一把尺**，
     * 经验条、按钮价格、这里扣费共用），纯数据操作在 `heroData.tryLevelUp`，
     * 本方法只负责「配表校验 → 写存档 → 打日志」。
     *
     * ⚠ 花的**不是金币**：金币只用于解锁（见 `unlockHero`）。等级无上限、价格指数上涨。
     */
    levelUpHero(heroId: number): IHeroActionResult {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) {
            return { ok: false, reason: 'unknown_hero', cost: 0, level: 0 };
        }

        const res = this.heroData.tryLevelUp(heroId);
        if (!res.ok) {
            return { ok: false, reason: res.reason || 'no_exp', cost: 0, level: res.level };
        }
        // ⚠ 不往 tasks/achievements 的 `spend_gold` / `hero_level` 上报（与 `unlockHero` 同一段说明）：
        //   前者是局内金币口径，后者是**单局局内**英雄等级口径，局外升级喂进去会算错。
        this.saveAll();

        console.log(`[英雄] ${cfg.name} 升级到 Lv.${res.level}，消耗 ${res.cost} 通用英雄经验`);
        return { ok: true, reason: '', cost: res.cost, level: res.level };
    }

    /**
     * **一局通关结算：发通用英雄经验**（全项目唯一的英雄经验发放点）。
     *
     * 调用点只有一处：`Scene_Game_Stage.endRun` 的**通关分支**（`clearRewardHeroExpBase` 这个键
     * 的自述就是"通关局外英雄经验基数（结算时按配置发）"）。中途退出走 `exit()`，不调 `endRun` → 不发。
     *
     * 数量 = `clearRewardHeroExpBase × rewardMul(难度档位)`（`DifficultyConfig.rewardMul` —— 与
     * 局内击杀奖励的收益倍率**同一个函数**，档位越高发得越多，档 1 = ×1）。
     *
     * @param difficulty 本局难度档位（1 ~ `DIFFICULTY_MAX`）
     * @returns 实际发放的经验（0 = 本次没发）
     */
    grantClearHeroExp(difficulty: number): number {
        const base = BattleConstUtil.getClearRewardHeroExpBase();
        const amount = Math.max(0, Math.round(base * rewardMul(difficulty)));
        if (amount <= 0) return 0;

        this.heroData.addSharedExp(amount);
        this.saveAll();
        console.log(`[英雄经验] 通关结算 +${amount}（基数 ${base} × 难度收益 ×${rewardMul(difficulty).toFixed(2)}）`
            + `，通用经验池现有 ${this.heroData.getSharedExp()}`);
        return amount;
    }

    /* ===================================================================
     * 局外遗物抽取（图鉴页 `Cmp_OuterRelics` 的「抽 取」按钮）
     *
     * 分工（口径真源 `docs/meta-growth/README.md` §1）：
     *   · 规则（池子 / 品质权重 / 档内优先未收集 / 价格阶梯）在 `battle/OuterRelicDraw`（纯函数）
     *   · 存量（局外遗物份数 / 当日已付费抽数）在 `funcs/EquipmentCollection`
     *   · 券在 `funcs/BagData`（`outer_draw_ticket`）、金币在 `funcs/ItemData`
     *   · **本方法是唯一的抽取出口**：校验 → 先用券、再花金币 → 记图鉴 → 写当日阶梯 → 存档
     *
     * ⚠ **局外遗物只有这一个来源**：局内肉鸽商店抽到的遗物**不写**图鉴
     *   （`Scene_Game_Stage.onRelicCollected` 已删掉那一笔，否则打两局属性就翻倍，见 §0.2）。
     * =================================================================== */

    /**
     * 一次抽取的**预览** —— 界面画按钮（消耗文案 / 亮不亮）只读它，**不自己算钱**。
     *
     * 与 `drawOuterRelic` 共用同一个 `OuterRelicDraw.plan()`：界面显示的数 == 真正扣的数
     * （与商城 `previewShopDailyGift` 同一套路；让界面自己按阶梯累加迟早差一档）。
     */
    public previewOuterDraw(count: number): IOuterDrawPreview {
        const want = DataCenter.clampDrawCount(count);
        const ticketLeft = this.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket);
        const paidIndex = this.equipCollection.getOuterDrawIndex();
        const plan = OuterRelicDraw.plan(want, paidIndex,
            ticketLeft, this.itemData.getCurrency(CurrencyType.Gold));

        return {
            count: want,
            // `drawn` = 这次真的抽得到几个（金币不够时可能 < count，界面据此给一行提示）
            drawn: plan.steps.length,
            ticketLeft,
            ticketUse: plan.ticketUse,
            goldDraws: plan.goldDraws,
            goldCost: plan.goldCost,
            costText: OuterRelicDraw.formatCost(plan),
            /** 至少抽得动一次（**按钮亮不亮的唯一判据**） */
            enabled: plan.steps.length > 0,
            /** 能按 `count` 个一次抽完（false = 会少抽几个） */
            full: plan.steps.length === want,
            /** 下一个**付费抽**的单价（界面的"再抽一次要 200"提示 / 日志对账用） */
            nextGoldCost: OuterRelicDraw.costOfDraw(paidIndex),
        };
    }

    /**
     * **抽局外遗物（唯一出口）**：`count` 个（1 = 单抽 / 10 = 十连）。
     *
     * 顺序写死（与 §1.6 一致）：**先扣抽取券，券用完了才扣金币**；
     * 花金币的那几步按当日价格阶梯逐个累加（券抽**不抬价**）；一次都抽不动时
     * **不扣任何东西、也不抽**（判据只有这里一份）。
     *
     * ⚠ 金币不够抽满时是**部分成功**（抽得动几个抽几个，`drawn < requested`）——
     * 十连的中途失败不该把已经能抽的那几次也吞掉；界面据 `drawn` 给一行提示。
     *
     * @returns 结果（`ok = false` 时 `lines` 为空，可依据 `reason` 画提示）
     */
    public drawOuterRelic(count: number): IOuterDrawResult {
        const want = DataCenter.clampDrawCount(count);
        const pool = OuterRelicDraw.outerPool();
        if (!pool.length) {
            console.warn('[局外遗物] 抽取池是空的（relics 表没加载 / 没有 scope 含 outer 的行）→ 本次不抽也不扣');
            return { ok: false, reason: 'unknown_pool', requested: want, drawn: 0, ticketUsed: 0, goldSpent: 0, lines: [], spentText: '—' };
        }

        const paidIndex = this.equipCollection.getOuterDrawIndex();
        const plan = OuterRelicDraw.plan(want, paidIndex,
            this.bagData.getCount(BAG_ITEM_KEY.outerDrawTicket),
            this.itemData.getCurrency(CurrencyType.Gold));
        if (!plan.steps.length) {
            return { ok: false, reason: 'no_resource', requested: want, drawn: 0, ticketUsed: 0, goldSpent: 0, lines: [], spentText: '—' };
        }

        const lines = this.executeOuterDraw(plan, pool);
        if (!lines.length) {
            // 方案排出来了却一步都没执行成功（存量在同一帧被别处用掉 / 池子在中途变空）
            // → 什么都没发生，别写阶梯、别存档
            console.warn('[局外遗物] 方案排出来了但一步都没抽成（券/金币被别处用掉？）→ 本次不记账');
            return { ok: false, reason: 'no_resource', requested: want, drawn: 0, ticketUsed: 0, goldSpent: 0, lines: [], spentText: '—' };
        }

        const ticketUsed = lines.filter(l => l.viaTicket).length;
        const goldSpent = lines.reduce((s, l) => s + l.cost, 0);
        // 阶梯**只往前走花掉金币的那几步**（用券抽不抬价）；按**实际执行**的步数写，不按方案长度
        this.equipCollection.setOuterDrawIndex(paidIndex + lines.filter(l => !l.viaTicket).length);
        this.saveAll();

        const spentText = OuterRelicDraw.formatSpent(ticketUsed, goldSpent);
        console.log(`[局外遗物] 抽取 ${lines.length}/${want} 件（花掉 ${spentText}，其中券 ${ticketUsed} 张）`
            + `：${lines.map(l => `${l.name}${l.isNew ? '(新)' : `×${l.count}`}`).join('、')}`
            + ` —— 图鉴 ${this.equipCollection.getDistinctCount()} 种，下一抽 ${OuterRelicDraw.costOfDraw(this.equipCollection.getOuterDrawIndex())} 金币`);

        // 成就 `relic_collected`（图鉴种类数）**立刻**上报一次：图鉴页与成就页是两个界面，
        // 等 `Cmp_Achievement.show()` 里的 `syncNonRunPeaks()` 会让红点慢一拍（与升级上报同一口径）
        this.achieveData.peakProgress('relic_collected', this.equipCollection.getDistinctCount());

        return {
            ok: true,
            reason: '',
            requested: want,
            drawn: lines.length,
            ticketUsed,
            goldSpent,
            lines,
            spentText,
        };
    }

    /**
     * 照方案逐步执行（**每一步都单独复核**：券还在不在 / 金币还够不够）。
     * 某一步付不出来就跳过它继续下一次（`plan` 是按开抽前的存量排的，理论上不会发生；
     * 真发生了也只少抽一次，不会扣了钱不发货）。
     */
    private executeOuterDraw(plan: OuterDrawPlan, pool: ReturnType<typeof OuterRelicDraw.outerPool>): IOuterDrawLine[] {
        const lines: IOuterDrawLine[] = [];

        for (const step of plan.steps) {
            if (step.viaTicket) {
                if (!this.bagData.consumeItem(BAG_ITEM_KEY.outerDrawTicket, 1)) continue;
            } else if (!this.itemData.spendCurrency(CurrencyType.Gold, step.cost)) {
                continue;
            }

            const relic = OuterRelicDraw.roll(pool, (id) => this.equipCollection.getCollectedCount(id));
            if (!relic) break; // 池子空了，后面的步骤也没有意义

            const before = this.equipCollection.getCollectedCount(relic.id);
            this.equipCollection.addCollected(relic.id, 1);
            lines.push({
                id: relic.id,
                name: relic.name,
                rarity: relic.rarity,
                viaTicket: step.viaTicket,
                cost: step.cost,
                count: before + 1,
                // 「首次收集」= 抽之前一份都没有（界面用它高亮 + 播报"新"）
                isNew: before <= 0,
            });
        }

        return lines;
    }

    /** 抽取次数夹取：只允许 1 ~ `OuterRelicDraw.MAX_DRAW`（十连）；非法值一律当单抽 */
    private static clampDrawCount(count: number): number {
        const n = Math.floor(count) || 1;
        return Math.max(1, Math.min(OuterRelicDraw.MAX_DRAW, n));
    }

    /* ===================================================================
     * 局外商城（全屏页 `View_Shop`）—— **局外资源的又一个出口**
     *
     * 分工（口径真源 `docs/shop/README.md` §1 / §4）：
     *   · 卖什么 / 给多少 / 门槛：`mall_items.json` + `battle_constants.shop*` → `configs/MallConfig`
     *   · 领没领过 / 今天几次 / 免广告卡生效到何时：`funcs/ShopData`（存档）
     *   · **发奖只在这里**（本文件是局外资源的唯一出口）：金币进 `itemData`、通用英雄经验进 `heroData`、
     *     账号经验走 `addAccountExp`（**含等级奖励结算**）、券与次数进 **`bagData`**（局外背包，2026-11 搬过去）
     *   · 拉广告是界面的事（`AdMgr.showRewardVideo`）：**只有拿到 `true` 才调 `grantShopItem`**
     *
     * ⚠ 三条硬口径：
     *   ① 广告返回 `false`（未接 SDK / 中途关闭）→ **不发奖、不扣次数**，由调用方给一行提示；
     *   ② A4 给的是**局外遗物抽取次数**（不是遗物本体）：不扣金币、也不抬当日价格阶梯
     *      （消费方是遗物抽取链路，出口见 `BagData.consumeItem(BAG_ITEM_KEY.outerDrawTicket)`）；
     *   ③ 免广告卡**只替换局内那两个广告位**，不抬局内次数上限（局内消费点见 `docs/meta-growth/README.md` §3）。
     * =================================================================== */

    /** 发「每日补给」时**会随连续登录倍数放大的**发放类型（券/次数类按配表原值发，不乘倍数） */
    private static readonly MALL_MUL_TYPES: MallGrantType[] = ['gold', 'hero_exp', 'acc_exp'];

    /**
     * **每日补给的预览**：真的发奖时会给多少（连续登录倍数 + 取整口径都与 `claimShopDailyGift` 同一把尺）。
     *
     * 为什么要有它：界面要显示「金币 300 + 通用英雄经验 150」（**乘完之后的数**，README §2.1），
     * 如果让界面自己 `× 1.5`，一旦取整口径不一样（`round` vs `floor`），玩家看到的数就与实际到手的数
     * 差 1 —— 这种差异在界面上永远看不出来，只能靠"只算一次"避免。
     */
    public previewShopDailyGift(): { gold: number; heroExp: number; streakDays: number; streakMul: number } {
        const streak = this.playerInfo.data.loginStreak;
        const mul = MallConfig.getStreakMul(streak);
        let gold = 0;
        let heroExp = 0;
        for (const grant of MallConfig.getFreeItem()?.grants ?? []) {
            if (grant.type === 'gold') gold += DataCenter.scaleAmount(grant.amount, mul, grant.type);
            else if (grant.type === 'hero_exp') heroExp += DataCenter.scaleAmount(grant.amount, mul, grant.type);
        }
        return { gold, heroExp, streakDays: streak, streakMul: mul };
    }

    /** 本次广告能不能看 */
    public canUseShopAd(itemKey: MallItemKey | string): ShopAdCheck {
        const cfg = MallConfig.getItem(itemKey);
        if (!cfg) return { ok: false, reason: 'unknown_item' };
        if (cfg.kind !== 'ad') return { ok: false, reason: 'not_ad' };
        return this.shopData.canUseAd(String(cfg.key), Math.max(0, cfg.daily_limit),
            MallConfig.getAdDailyTotalLimit());
    }

    /**
     * **每日免费补给**（F1；一天一次、不看广告）。
     *
     * 数额 = 配表 `mall_items.daily_free.grants` **× 连续登录倍数**（`MallConfig.getStreakMul(loginStreak)`，
     * 1~2 天 ×1 / 3~6 天 ×1.5 / ≥7 天 ×2），另按 `shopStreakGiftDay` 额外送本局增益券。
     */
    public claimShopDailyGift(): IShopGrantResult {
        const shop = this.shopData;
        shop.ensurePeriod();
        if (shop.isFreeClaimedToday()) return DataCenter.fail('claimed_today');

        const cfg = MallConfig.getFreeItem();
        if (!cfg || !cfg.grants || !cfg.grants.length) {
            console.warn('[商城] 每日补给没配表（mall_items 里 kind=free 的那一行）→ 本次不发放');
            return DataCenter.fail('unknown_item');
        }

        // ⚠ **先记账再发奖**（与 TaskData.claim 同一顺序）：发奖过程里若又被点一次
        //   （连点 / 重复事件），第二次会直接看到"今天已领"而失败，不会双发。
        shop.markFreeClaimed();

        const streak = this.playerInfo.data.loginStreak;
        const mul = MallConfig.getStreakMul(streak);
        const granted = this.grantMallLines(cfg.grants, mul);
        // 连续登录阶梯的额外奖励（≥ shopStreakGiftDay 天送券；不乘倍数）
        const giftTickets = MallConfig.getStreakGiftTickets(streak);
        if (giftTickets > 0) {
            granted.push(...this.grantMallLines([{ type: 'boost', amount: giftTickets }], 1));
        }
        this.saveAll();

        const result = DataCenter.ok(granted);
        console.log(`[商城] 每日补给领取成功（连续登录 ${streak} 天 ×${mul}）：`
            + `${result.granted.map(l => l.text).join(' / ') || '本次没发出东西'}`);
        return result;
    }

    /**
     * **看完广告之后发奖**（A1~A6）。
     *
     * ⚠ 调用方必须**先**从 `AdMgr.showRewardVideo` 拿到 `true` 再调本方法 ——
     *   这里只复查一遍次数上限（防止"广告播放期间次数被别处用掉"），**不代表广告看完了**。
     *   没拿到 `true` 就调它 = 白送（`AdMgr` 的兜底语义见 `platform/ad/AdMgr.ts` 文件头）。
     */
    public grantShopItem(itemKey: MallItemKey | string): IShopGrantResult {
        const cfg = MallConfig.getItem(itemKey);
        if (!cfg) return DataCenter.fail('unknown_item');
        if (cfg.kind !== 'ad') return DataCenter.fail('not_ad');

        const check = this.canUseShopAd(cfg.key);
        if (!check.ok) return DataCenter.fail(check.reason);

        const granted = this.grantMallLines(cfg.grants ?? [], 1);
        if (!granted.length) {
            // 什么都没发出去（当前只有增益券池满这一种可能）→ **不算这一格用过、也不记广告次数**：
            // 让玩家白看一次广告才是真的坑
            console.warn(`[商城] ${cfg.name}：本次没有可发放的内容（增益券池已满？）→ 不计次数`);
            return DataCenter.fail('boost_pool_empty');
        }

        // 记账：本格今日 +1、今日广告总次数 +1、免广告卡累计观看 +1
        this.shopData.recordAdWatched(String(cfg.key));
        this.saveAll();

        const result = DataCenter.ok(granted);
        console.log(`[商城] ${cfg.name}（${cfg.placement}）发放成功：${result.granted.map(l => l.text).join(' / ')}`
            + `，今日广告 ${this.shopData.getAdUsedToday()}/${MallConfig.getAdDailyTotalLimit()}`
            + `，免广告卡累计 ${this.shopData.getAdCardWatched()}/${MallConfig.getAdCardNeedWatches()}`);
        return result;
    }

    /** **领免广告卡**（累计观看攒满 → 换 N 小时免广告；见 `docs/shop/README.md` §2.3） */
    public claimAdCard(): ShopAdCardClaimResult {
        const res = this.shopData.claimAdCard(MallConfig.getAdCardNeedWatches(), MallConfig.getAdCardHours());
        if (res.ok) {
            this.saveAll();
            console.log(`[商城] 免广告卡生效 ${MallConfig.getAdCardHours()} 小时（到 `
                + `${new Date(res.activeUntil).toLocaleString()}），累计观看已清零`);
        }
        return res;
    }

    /**
     * 按配表的 `grants` 发东西（**唯一的分发点**）—— 加新商品只需在 `mall_items.json` 加一行，
     * 除非要加**新的发放类型**（那时才动这里与 `MallGrantType`）。
     * @param mul 倍数（只有 `MALL_MUL_TYPES` 里的类型会被放大；每日补给的连续登录加成用它）
     * @returns 实发内容（**空数组 = 什么都没发出去**，调用方要当失败处理）
     */
    private grantMallLines(grants: MallGrant[], mul: number): IShopGrantLine[] {
        const out: IShopGrantLine[] = [];
        const scale = mul > 0 ? mul : 1;

        for (const grant of grants) {
            const type = grant?.type;
            const raw = Math.max(0, Math.floor(grant?.amount ?? 0));
            if (!type || raw <= 0) continue;

            switch (type) {
                case 'gold': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    this.itemData.addCurrency(CurrencyType.Gold, amount);
                    out.push({ type, amount, text: `+${amount} 金币` });
                    break;
                }
                case 'hero_exp': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    this.heroData.addSharedExp(amount);
                    out.push({ type, amount, text: `+${amount} 通用英雄经验` });
                    break;
                }
                case 'acc_exp': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    // ⚠ 账号经验必须走 addAccountExp：升级时按等级表发金币奖励，
                    //   并给「账号等级」类任务/成就上报（绕过它等于丢掉等级奖励）
                    this.addAccountExp(amount);
                    out.push({ type, amount, text: `+${amount} 账号经验` });
                    break;
                }
                case 'relic_draw': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    // ⚠ 发的是**抽取券**（1 张 = 1 次抽取，不是遗物本体）：进背包（`bagData`），
                    //   由遗物抽取链路在扣金币之前先问 `consumeItem`（见 docs/meta-growth/README.md §1.3）
                    this.bagData.addItem(BAG_ITEM_KEY.outerDrawTicket, amount);
                    out.push({ type, amount, text: `+${amount} 张遗物抽取券` });
                    break;
                }
                case 'revive_ticket': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    // 局内复活券：进背包，跨局累积。**消费点只有一处** ——
                    // `Scene_Game_Stage` 的致命伤拦截器（`docs/bag/README.md` §6）
                    this.bagData.addItem(BAG_ITEM_KEY.reviveTicket, amount);
                    out.push({ type, amount, text: `+${amount} 张局内复活券` });
                    break;
                }
                case 'ad_ticket': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    this.bagData.addItem(BAG_ITEM_KEY.adTicket, amount);
                    out.push({ type, amount, text: `+${amount} 张局内广告券` });
                    break;
                }
                case 'boost': {
                    const amount = DataCenter.scaleAmount(raw, scale, type);
                    const line = this.grantBoostTickets(amount);
                    if (line) out.push(line);
                    break;
                }
                default:
                    console.warn(`[商城] 不认识的发放类型「${type}」（mall_items.grants 写错了？）→ 跳过`);
                    break;
            }
        }
        return out;
    }

    /**
     * 发本局增益券：从 10 条成就效果里**随机**抽（每条券一个效果），
     * **已达 `cap` 的效果不参与**（成就 + 手里已有的券合计 = 满；否则玩家领到一张废券）。
     * @returns 实发的那一行（一条都没发出去时返回 null）
     */
    private grantBoostTickets(count: number): IShopGrantLine | null {
        let got = 0;
        const codes: AchEffectCode[] = [];
        for (let i = 0; i < count; i++) {
            const code = this.rollBoostCode();
            if (!code) break;
            this.bagData.addBoostTicket(code, 1);
            codes.push(code);
            got++;
        }
        if (!got) return null;

        // 飘字/文案用 `achEffectLabel`（它自带效果名，别再套一层名字，会读成"开局英雄等级（开局英雄等级 +1级）"）
        const first = codes[0];
        const label = achEffectLabel(first, MallConfig.getBoostTicketValue(first));
        const same = codes.every(c => c === first);
        const text = same ? (got > 1 ? `${label} ×${got}` : label) : `${label} 等 ${got} 张`;
        return { type: 'boost', amount: got, text };
    }

    /** 随机一条**还能发**的增益效果（都满了返回 null） */
    private rollBoostCode(): AchEffectCode | null {
        const cur = this.achieveData.getEffects();
        const pool = ACH_EFFECT_CODES.filter((code) => {
            const meta = ACH_EFFECT_META[code];
            if (!meta || meta.cap <= 0) return false;
            const value = MallConfig.getBoostTicketValue(code);
            if (value <= 0 || value > meta.cap) return false; // 没配值 / 一张就超上限 = 发不出去
            // ⚠ 两边必须是**同一个量纲**：成就给的是"效果数值"，券给出的是"张数 × 每张的数值"。
            //   把张数直接当数值加进去，就是"券堆到 cap 也照样发"（audit:mall 的 F2/F3 会当场抓到）。
            const owned = (cur[code] ?? 0) + this.bagData.getBoostTicketCount(code) * value;
            return owned + value <= meta.cap;
        });
        if (!pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    /** 倍数只作用于 MALL_MUL_TYPES 里的类型；其余按配表原值（取整，最小的非零结果至少 1） */
    private static scaleAmount(raw: number, scale: number, type: MallGrantType): number {
        // 用 `indexOf` 而不是 `includes`：工程 tsconfig 的 lib 到不了 ES2016，`includes` 会报 TS2550
        if (DataCenter.MALL_MUL_TYPES.indexOf(type) < 0) return raw;
        return Math.max(1, Math.round(raw * scale));
    }

    /** 失败结果（`granted` 空、`flyText` 空） */
    private static fail(reason: IShopGrantResult['reason']): IShopGrantResult {
        return { ok: false, reason, granted: [], flyText: '' };
    }

    /** 成功结果（飘字取**主项**：金币优先，其次第一条） */
    private static ok(granted: IShopGrantLine[]): IShopGrantResult {
        const main = granted.find(l => l.type === 'gold') ?? granted[0];
        return { ok: true, reason: '', granted, flyText: main ? main.text : '' };
    }

    /** 保存所有模块到 localStorage */
    saveAll(): void {
        this.playerInfo.save();
        this.heroData.save();
        this.itemData.save();
        this.equipCollection.save();
        this.taskData.save();
        this.achieveData.save();
        this.levelData.save();
        this.shopData.save();
        this.bagData.save();
        console.log('[DataCenter] 全部数据已保存');
    }

    /** 重置所有数据到默认值 */
    resetAll(): void {
        this.playerInfo.reset();
        this.heroData.reset();
        this.itemData.reset();
        this.equipCollection.reset();
        this.taskData.reset();
        this.achieveData.reset();
        this.levelData.reset();
        this.shopData.reset();
        this.bagData.reset();
        console.log('[DataCenter] 全部数据已重置');
    }

    /** 重置指定模块 */
    resetModule(moduleName: 'playerInfo' | 'heroData' | 'itemData' | 'equipCollection' | 'taskData' | 'achieveData' | 'levelData' | 'shopData' | 'bagData'): void {
        this[moduleName].reset();
    }

    /** 导出全部数据为 JSON（用于云存档） */
    exportAll(): Record<string, string> {
        return {
            playerInfo: this.playerInfo.serialize(),
            heroData: this.heroData.serialize(),
            itemData: this.itemData.serialize(),
            equipCollection: this.equipCollection.serialize(),
            taskData: this.taskData.serialize(),
            achieveData: this.achieveData.serialize(),
            levelData: this.levelData.serialize(),
            shopData: this.shopData.serialize(),
            bagData: this.bagData.serialize(),
        };
    }

    /** 从 JSON 导入全部数据（用于云存档恢复） */
    importAll(data: Record<string, string>): void {
        if (data.playerInfo) this.playerInfo.deserialize(data.playerInfo);
        if (data.heroData) this.heroData.deserialize(data.heroData);
        if (data.itemData) this.itemData.deserialize(data.itemData);
        if (data.equipCollection) this.equipCollection.deserialize(data.equipCollection);
        if (data.taskData) this.taskData.deserialize(data.taskData);
        if (data.achieveData) this.achieveData.deserialize(data.achieveData);
        if (data.levelData) this.levelData.deserialize(data.levelData);
        if (data.shopData) this.shopData.deserialize(data.shopData);
        if (data.bagData) this.bagData.deserialize(data.bagData);
    }

    /** 释放所有模块资源（用于游戏销毁时） */
    disposeAll(): void {
        this.playerInfo.dispose();
        this.heroData.dispose();
        this.itemData.dispose();
        this.equipCollection.dispose();
        this.taskData.dispose();
        this.achieveData.dispose();
        this.levelData.dispose();
        this.shopData.dispose();
        this.bagData.dispose();
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
