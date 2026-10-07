/**
 * HeroScope.ts — 「英雄」页（`Scene_Menu` → 左侧「英雄」→ `content/right/heros`）**与英雄详情弹窗**
 * （`Scene_Menu/ui_hero_detail`）共用的内部契约
 *
 * 与 `AchievementScope.ts`、`scene_game_stage/cmps/StageScope.ts` 同一套路：
 * 页面内部的通信只走 scope，组件之间不互相 `getComponent`。
 *
 * 方向约定（与成就页逐字同口径）：
 *   · **状态向下**：宿主把「这张卡 / 这个弹窗现在长什么样」整包下发（`HeroCard.setInfo(vm)` /
 *     `Cmp_HeroDetail.setVM(vm)`）—— 卡片与弹窗**不认识 `DataCenter`、不认识配表**，
 *     也不自己算判据（够不够经验、解没解锁、这一步花什么，全由 `HeroVM` 算一次后下发）；
 *   · **通知向上**：卡片只 `scope.emit(...)`；**真正扣资源/写存档的是宿主**
 *     （见下面的「谁收事件」）。
 *
 * ── 谁收事件（⚠ 与 README 的初版分工有一处偏差，理由在下面）──
 * `UIScope.emit` **只沿 `node.parent` 向上冒泡**，而 `ui_hero_detail` 是 `Scene_Menu` **根节点的子节点**
 * （与 `content` 平级 —— 弹窗必须盖住整屏，所以它不能塞进 `content/right/heros` 里）。
 * 于是：
 *
 * ```
 * HeroCard（content/right/heros/lists/row_*）  ──emit──▶  Cmp_Heroes ──▶ Scene_Menu（根）
 * Cmp_HeroDetail（ui_hero_detail）             ──emit──▶  Scene_Menu（根）
 * ```
 *
 * `Unlock` / `LevelUp` 的**唯一监听方是 `Scene_Menu`**（不是 `Cmp_Heroes`）：
 * 卡片与弹窗的按钮发的是**同一个事件**，落在同一处处理 —— 否则两个宿主各接一半，
 * 从弹窗点一下会被处理两次（重复扣费）。判据仍然只有一份（`HeroVM`），页面只负责画。
 */

import type { HeroAttrRow, HeroSkillInfo } from '../../../../data/configs/HeroConfig';

/** `HeroCard` / `Cmp_HeroDetail` 抛给宿主的事件（`scope.emit`，沿父链冒泡） */
export const HeroScopeEvents = {
    /** 点了「解 锁」（参数：heroId）—— 宿主负责花**金币**解锁 */
    Unlock: 'hero:unlock',
    /** 点了「升 级」（参数：heroId）—— 宿主负责花**通用英雄经验**升级 */
    LevelUp: 'hero:levelup',
    /** 卡片点了「详 情」（参数：heroId）—— 宿主负责打开英雄详情弹窗并下发 VM */
    OpenDetail: 'hero:detail:open',
    /** 弹窗点了「关闭 ×」（无参数）—— 宿主收起弹窗（**不写任何数据**） */
    CloseDetail: 'hero:detail:close',
} as const;

/** 这一步要花哪种资源（**两种资源两种用途**，见 `HeroData` 文件头） */
export type HeroCostKind = 'exp' | 'gold';

/**
 * 一张英雄卡要显示的全部内容（宿主算好、卡片只画）。
 *
 * 为什么整包下发而不是让卡片自己去查：卡片一旦能查 `DataCenter`，
 * 「够不够钱」这类判据就会在卡片里被重写一份，与宿主那份迟早不一致 ——
 * 同 `AchievementItem.setInfo(AchGroupState)` 的分工。
 */
export interface HeroCardVM {
    /** 英雄 id（`units.json`，1000 段） */
    heroId: number;
    /** 英雄名 */
    name: string;
    /** 头像路径（`units.head_icon`，**resources 相对、不带扩展名**的碎图） */
    headIcon: string;
    /** 技能图标路径（该英雄第一个有图标的技能；空 = 保留预制件里的占位图） */
    skillIcon: string;
    /** 是否已解锁（false → 头像盖锁 + 整卡置灰） */
    unlocked: boolean;
    /** 英雄等级（未解锁时为 0，卡片会收起 `lv`） */
    level: number;
    /**
     * 当前**通用英雄经验池**的持有量（未解锁时为 0）。
     *
     * ⚠ 与账号等级的经验（任务系统）不是一套：这是「一局通关发给所有英雄共用的经验」，
     *   在英雄详情弹窗里花它升级；卡片只负责把「离升级还差多少」画出来。
     */
    exp: number;
    /**
     * 从当前等级升到下一级所需的**经验总量**（`HeroData.getExpForNextLevel(level)`）。
     * 0 = 没有经验口径/未解锁 → 卡片收起经验条（不画一条永远空的进度）。
     */
    expMax: number;
    /** 这一步花哪种资源（未解锁 = `gold`，已解锁 = `exp`）—— 按钮上的图标跟着它走 */
    costKind: HeroCostKind;
    /** 这一步要花多少：未解锁 = 解锁价（金币），已解锁 = 升下一级的价（通用经验）；0 = 免费/没口径 */
    cost: number;
    /** 这一步**现在能不能点**（判据由宿主算：解锁看金币、升级看经验池；false → 按钮置灰） */
    enabled: boolean;
    /** 属性行（`HeroConfig.getAttrRows` 的产出，已换算成展示文案） */
    attrs: HeroAttrRow[];
}

/**
 * 英雄详情弹窗要显示的全部内容（`Cmp_HeroDetail` 只画，不查数据）。
 *
 * 与 `HeroCardVM` 的关系：卡片是**摘要**（4 行属性 + 一个价格），弹窗是**全量**
 * （5 行属性 + 每级成长 + 技能三件套 + 两种资源读数 + 价格）。两者由同一个
 * `HeroVM` 模块构建，所以"够不够、花什么、花多少"这三条判据不会各说一套。
 */
export interface HeroDetailVM {
    /** 英雄 id */
    heroId: number;
    /** 英雄名 */
    name: string;
    /** 头像路径（碎图，`resources` 相对不带扩展名） */
    headIcon: string;
    /** 是否已解锁（false → 整块置灰 + 头像盖锁 + 收起等级/经验） */
    unlocked: boolean;
    /**
     * 英雄等级（**未解锁时为 0**）。
     * 属性行由 `attrs` 直接给（未解锁时那些值是按 **1 级**算的），界面不要自己按 level 推。
     */
    level: number;
    /** 通用英雄经验池持有量（经验条分子 = `exp / expMax`） */
    exp: number;
    /** 升下一级所需经验（0 = 没有经验口径 → 收起经验块；未解锁时也收起） */
    expMax: number;
    /** 这一步花哪种资源（未解锁 = `gold`，已解锁 = `exp`） */
    costKind: HeroCostKind;
    /** 这一步要花多少（0 = 免费 → 收起价格数字，别显示孤零零的「0」） */
    cost: number;
    /** 这一步现在能不能点（解锁看金币、升级看经验池 —— 与卡片同一套判据） */
    enabled: boolean;
    /** 持有金币（解锁语境用；「金币只用于解锁英雄」） */
    gold: number;
    /**
     * 该英雄**真配了的那 5 项**属性（最大生命/最大魔法/攻击力/攻击速度/攻击距离），
     * 顺序即行序 `attr_1` ~ `attr_5`（**不是**卡片那 4 行 —— 卡片第 3 行的「护甲」对英雄恒为 0）。
     */
    attrs: HeroAttrRow[];
    /** 技能三件套（null = 没有技能 → 收起技能块） */
    skill: HeroSkillInfo | null;
}
