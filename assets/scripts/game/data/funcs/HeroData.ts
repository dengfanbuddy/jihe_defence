/**
 * HeroDataModule - 英雄/角色数据模块（局外，跨局累积）
 *
 * 数据内容：
 * - 已解锁英雄列表（**记录存在 = 已解锁**，没有"锁定中"的中间态）
 * - 每个英雄的等级
 * - **通用英雄经验池**（所有英雄共用一份）
 *
 * ── 两种资源两种用途（2026-11 拍板，见 `docs/hero-detail/README.md` §4）──
 *   | 动作 | 花什么 | 价格公式 | 谁发放 |
 *   |---|---|---|---|
 *   | **升级** | **通用英雄经验**（本文件的 `sharedExp`） | `getExpForNextLevel(level)` | **一局结束**时发放（胜负都发；`DataCenter.grantRunClearHeroExp`，口径见 `docs/settle/README.md` §2） |
 *   | **解锁** | **金币**（`ItemData`） | `HeroConfig.getUnlockCost(id)` | 任务/成就等既有出口 |
 *
 * 两者**用途不能混**：金币只解锁、经验只升级（`heroLevelUpGoldBase/Ratio` 两个常量因此失去消费者，
 * 保留 `HeroConfig.getLevelUpCost` 只作历史口径的读法，**界面不要再调它**）。
 *
 * ── 数据形状：为什么是**数组**而不是 `{ [英雄id]: {...} }` 字典（2026-10 改）──
 * 字典形态**解锁读档会丢**：`DataModule._load()` 用 `mergeDeep` 合并存档，
 * 而它只认「默认数据里已经存在的 key」（`if (!(key in target)) continue`，防的是删字段后残留）。
 * 英雄默认数据里只预置了 `DEFAULT_UNLOCKED_HERO_IDS`（1001 / 1002）→ 运行时解锁 1003 写进 localStorage，
 * 下次启动合并时 target 里没有 `1003` 这个 key，**整条被静默跳过**（等于解锁白花钱）。
 * 数组走的是「整片覆盖」分支（`Array.isArray` 那一支），所以读档正确 ——
 * ⚠ 代价是**默认名单也被整片覆盖**：老档只解锁过 1001 的话，新加的默认英雄不会自动到手 ——
 * 这一条由 `ensureDefaultUnlocked()` 在 `DataCenter.init()` 里补齐（见那个方法的说明）。
 * 同一个坑 `TaskData.records` / `AchievementData.records` 已经踩过并因此改用数组，见那两份文件头。
 *
 * ── 经验为什么是**池子**而不是 per-hero（2026-11 改）──
 * 旧口径是「每个英雄各存一个 `exp`，发经验时自动升级」（`addHeroExp` 的 while 循环）。
 * 它与「在英雄详情弹窗里**手动花经验升级**」直接冲突：经验一进池就自己升完了，
 * 玩家永远看不到"够不够升级"这个决策点。而且那条链路**全工程没有任何调用方**（发了也没人发）。
 * 现在：经验只进**共用池子**，升级是玩家在弹窗里点出来的（`tryLevelUp`），
 * `records[].exp` 这个字段随之删除（老存档里多出来的字段读档时被忽略，不影响）。
 *
 * ── 谁改数据 ──
 *   · 升级扣的是**通用经验池**、解锁扣的是**金币**，两条都只在 `DataCenter`
 *     （`levelUpHero` / `unlockHero` —— 本项目局外资源的唯一出口），本模块只做纯数据操作
 *     （发英雄、加等级、加减池子），不认识金币、不认识界面。
 *   · 界面（英雄页 + 英雄详情弹窗）只读 `isUnlocked` / `getHeroInfo` / `getSharedExp`，
 *     动作一律走 `DataCenter`。
 */

import { DataModule } from '../DataModule';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/**
 * **默认解锁的英雄**（新档白送的两位；`units.json` hero 段，按 id 升序）。
 *
 * 口径（2026-11 用户定案「游戏默认解锁 2 个英雄」）：
 *   · 新档 = 这**两位**都 Lv.1 且不花金币（`HeroConfig.getUnlockCost` 仍会算出价，但数据层发现"已解锁"就不收费）；
 *   · 其余 8 位要靠英雄页花金币解锁（价格随列表序号涨价，见 `HeroConfig.getUnlockCost`）；
 *   · **局内选英雄的候选池只出这个集合里的英雄**（见 `battle/HeroSelect.heroPoolIds`）——
 *     所以"默认解锁几位"直接决定开局的候选有几个。
 *   · 改这里就是改默认（**只改这一个数组**：`defaultData()` 与老档补齐都用它，
 *     别在别处再手写一份 id 列表）。
 */
export const DEFAULT_UNLOCKED_HERO_IDS: readonly number[] = [1001, 1002];

/** 单个英雄的数据 */
export interface HeroInfo {
    /** 英雄配置 ID */
    id: number;
    /** 当前等级（无上限，可无限提升） */
    level: number;
}

/** 英雄数据模块的数据结构 */
export interface IHeroData {
    /**
     * **通用英雄经验池**（所有英雄共用一份；主要来源 = 一局结束结算 + 看广告翻倍）。
     * 展示与扣除都走本文件的 `getSharedExp` / `tryLevelUp`，别在别处再存一份。
     */
    sharedExp: number;
    /**
     * 英雄记录（**数组**，见文件头 ⚠；每条记录存在 = 该英雄已解锁）
     */
    records: HeroInfo[];
}

/**
 * 「花经验升一级」的结果（`tryLevelUp` 的返回）。
 * 界面只读它画提示，**不自己重算判据**（够不够经验、解没解锁都由数据层答）。
 */
export interface IHeroLevelUpResult {
    ok: boolean;
    /**
     * 失败原因（`ok=true` 时是空串）：
     *   `locked`      还没解锁就想升级（未解锁的英雄只能先花金币解锁）
     *   `no_exp`      通用英雄经验不足
     *   `no_formula`  配表没给经验口径（`getExpForNextLevel` 算出 0）→ **不免费升级**
     */
    reason: '' | 'locked' | 'no_exp' | 'no_formula';
    /** 本次**实际消耗**的通用英雄经验（失败为 0） */
    cost: number;
    /** 操作后的英雄等级（失败时为原等级） */
    level: number;
}

export class HeroDataModule extends DataModule<IHeroData> {
    constructor() {
        super('hero_data');
    }

    /**
     * 默认数据方法
     * @returns `DEFAULT_UNLOCKED_HERO_IDS` 里的每位各一条 Lv.1 记录（现为火枪 1001 + 赏金猎人 1002）、经验池为空
     */
    protected defaultData(): IHeroData {
        return {
            sharedExp: 0,
            records: DEFAULT_UNLOCKED_HERO_IDS.map((id) => ({ id, level: 1 })),
        };
    }

    /**
     * **补齐默认英雄**（幂等；老档自愈 + 新默认英雄上线时的一次性补发）。
     *
     * 为什么需要它：`records` 是**数组**，`DataModule._load()` 的 `mergeDeep` 对数组走的是
     * 「整片覆盖」（见文件头那段 ⚠）—— 老存档里的 `records` 会**原样盖掉** `defaultData()` 里的两条记录。
     * 于是"默认解锁名单从 1 位加到 2 位"这件事对**已经有存档的玩家不生效**：
     * 他只解锁过 1001，读档后还是 1 位，局内候选池也就只有 1 个英雄。
     * 老档迁移的判据因此不能只看 `this.data`（构造时默认值已经合并进来了，新旧档长得一模一样），
     * 而是直接按"默认名单里的人是不是都在档案里"补齐 —— 这条在**任何**档上都成立且幂等
     * （没有"解锁"的反向操作，补进去不会有副作用）。
     *
     * ⚠ **只补不加钱**：本方法不扣金币、不认识 `DataCenter`（与 `unlockHero` 同一条分层口径）。
     *   调用点在 `DataCenter.init()` 的迁移清单里（与 `equipCollection.migrateCollectedShape()` 并列）。
     *
     * @returns 本次补进去几位（0 = 本来就不缺；日志/体检靠它判断"迁移到底跑没跑"）
     */
    ensureDefaultUnlocked(): number {
        let added = 0;
        for (const id of DEFAULT_UNLOCKED_HERO_IDS) {
            if (this.unlockHero(id)) added++;
        }
        return added;
    }

    // ────────────── 查询 ──────────────

    /** 获取英雄信息（未解锁/不存在则返回 null） */
    getHeroInfo(heroId: number): HeroInfo | null {
        return this.data.records.find((r) => r.id === heroId) ?? null;
    }

    /** 该英雄是否已解锁 */
    isUnlocked(heroId: number): boolean {
        return this.getHeroInfo(heroId) !== null;
    }

    /** 已解锁英雄的记录（只读视图，调用方不要直接改） */
    getUnlocked(): readonly HeroInfo[] {
        return this.data.records;
    }

    /** 英雄当前等级（未解锁返回 0） */
    getHeroLevel(heroId: number): number {
        return this.getHeroInfo(heroId)?.level ?? 0;
    }

    /** 通用英雄经验池当前持有量（英雄详情弹窗的「持有通用英雄经验」与经验条分子） */
    getSharedExp(): number {
        return Math.max(0, Math.floor(this.data.sharedExp ?? 0));
    }

    /** 池子里的经验够不够 `amount`（界面判「升级按钮能不能点」用；与扣除同一处真源） */
    hasSharedExp(amount: number): boolean {
        return amount <= 0 || this.getSharedExp() >= amount;
    }

    /**
     * 从 `level` 升到 `level + 1` 所需的**经验总量**（`battle_constants.heroExpFormulaBase/Ratio`）。
     *
     * **同一个公式不要再抄第二份** —— 经验条的进度、升级按钮的价格、`tryLevelUp` 的扣费
     * 用的都是本方法（`docs/hero-detail/README.md` §4 的"同一把尺"）。
     *
     * @param level 当前等级（≥ 1；传 0/负数按 1 处理）
     */
    getExpForNextLevel(level: number): number {
        const base = BattleConstUtil.getHeroExpFormulaBase();
        const ratio = BattleConstUtil.getHeroExpFormulaRatio();
        const lv = Math.max(1, Math.floor(level || 1));
        return Math.max(0, Math.floor(base * Math.pow(ratio > 0 ? ratio : 1, lv - 1)));
    }

    // ────────────── 写操作（纯数据，不含金币/界面） ──────────────

    /**
     * 解锁英雄（**纯数据操作**：只写记录，不扣任何货币）。
     *
     * ⚠ 界面上的「解锁」按钮**不要**直接用它 —— 那条路要先收钱：
     *   `DataCenter.ins.unlockHero(id)`（查价 → 扣金币 → 调本方法）。
     *   本方法留给「免费发英雄」的场景（活动、奖励、剧情解锁）。
     * @returns 真正写入了记录才为 true（已解锁 = false）
     */
    unlockHero(heroId: number): boolean {
        if (!heroId || this.isUnlocked(heroId)) return false;
        this.data.records.push({ id: heroId, level: 1 });
        return true;
    }

    /** 英雄升 1 级（**纯数据操作**，不扣经验；扣经验那一层在 `tryLevelUp`） */
    addLevel(heroId: number): boolean {
        const hero = this.getHeroInfo(heroId);
        if (!hero) return false;
        hero.level += 1;
        return true;
    }

    // ────────────── 通用英雄经验（唯一入口） ──────────────

    /**
     * 往通用经验池里加经验（**发放的唯一入口**）。
     *
     * 调用方有**三处**（2026-11 起）：
     *   ① `DataCenter.grantRunClearHeroExp` ← `Scene_Game_Stage.endRun`（**胜负都发**，
     *      按「阶段 × 时间」算；中途退出走 `exit()`，不调 `endRun`，所以不发 ——
     *      口径见 `docs/settle/README.md` §2）；
     *   ①′ `DataCenter.grantRunClearAdBonus` ← 结算面板的**看广告翻倍**（只补差额，同一局第二条路）；
     *   ② `DataCenter.grantMallLines` ← 局外商城的 **A2 英雄经验瓶**（`mall_items.json` 里
     *      `grants[{type:'hero_exp'}]` 那一行）。⚠ 商城那条**不能绕过本方法**：
     *      池子是唯一一份（`sharedExp`），绕过它就等于在别处又存了一份。
     *
     * ⚠ 本方法**只加不升**：升级是玩家在详情弹窗里点出来的（`tryLevelUp`）。
     *   旧版"发经验即自动升级"的 while 循环已删除（见文件头）。
     *
     * @returns 加完之后的池子余量（界面/日志想回显时用）
     */
    addSharedExp(amount: number): number {
        const add = Math.floor(amount);
        if (add > 0) {
            this.data.sharedExp = this.getSharedExp() + add;
        }
        return this.getSharedExp();
    }

    /**
     * **花经验升一级** —— 升级的唯一入口（校验 → 扣池 → `addLevel`）。
     *
     * 顺序是「先校验 → 再扣 → 再改等级」，任何一步不满足都不动数据（同 `DataCenter.unlockHero`）。
     * 判据（够不够经验 / 该花多少）全在本方法里算一次，界面只展示 `DataCenter` 给的结论。
     *
     * ⚠ `cost <= 0`（配表没给经验口径）时**拒绝升级**而不是免费升级：
     *   解锁是一次性的（免费解锁最多白送一个英雄），升级是**无上限**的 ——
     *   一旦放行就是"点一下升一级"的无限白送。
     */
    tryLevelUp(heroId: number): IHeroLevelUpResult {
        const hero = this.getHeroInfo(heroId);
        if (!hero) return { ok: false, reason: 'locked', cost: 0, level: 0 };

        const cost = this.getExpForNextLevel(hero.level);
        if (cost <= 0) return { ok: false, reason: 'no_formula', cost: 0, level: hero.level };
        if (!this.hasSharedExp(cost)) return { ok: false, reason: 'no_exp', cost: 0, level: hero.level };

        this.data.sharedExp = this.getSharedExp() - cost;
        hero.level += 1;
        return { ok: true, reason: '', cost, level: hero.level };
    }
}
