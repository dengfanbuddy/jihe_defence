/**
 * HeroScope.ts — 「英雄」页（`Scene_Menu` → 左侧「英雄」→ `content/right/heros`）的内部契约
 *
 * 与 `AchievementScope.ts`、`scene_game_stage/cmps/StageScope.ts` 同一套路：
 * 页面内部的通信只走 scope，组件之间不互相 `getComponent`。
 *
 * 方向约定（与成就页逐字同口径）：
 *   · **状态向下**：宿主 `Cmp_Heroes` 把「这张卡现在长什么样」整包下发（`HeroCard.setInfo(vm)`）——
 *     卡片不认识 `DataCenter`、不认识配表，也不自己算判据（够不够钱、解没解锁都由宿主给）；
 *   · **通知向上**：卡片只 `scope.emit(...)`；**真正扣金币/写存档的是宿主**
 *     （宿主 → `DataCenter.ins.unlockHero / levelUpHero`），然后按结果重刷。
 */

import type { HeroAttrRow } from '../../../../data/configs/HeroConfig';

/** `HeroCard` 抛给宿主的事件（`scope.emit`，沿父链冒泡） */
export const HeroScopeEvents = {
    /** 点了「解 锁」（参数：heroId）—— 宿主负责花钱解锁 */
    Unlock: 'hero:unlock',
    /** 点了「升 级」（参数：heroId）—— 宿主负责花钱升级 */
    LevelUp: 'hero:levelup',
    /**
     * 点了「详 情 / 收 起」（参数：heroId, expanded）—— 卡片自己切了显示，**通知宿主是为了互斥**：
     * 页面靠它保证「同时只展开一张卡」（不然 10 张卡叠起来能展开 10 份）。
     */
    Detail: 'hero:detail',
} as const;

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
     * 当前**英雄经验**（局外成长经验，未解锁时为 0）。
     *
     * ⚠ 与账号等级的经验（任务系统）不是一套：这里是「打完一局发给英雄的经验」，
     *   将来在英雄详情面板消耗它升级，卡片只负责把进度画出来。
     */
    exp: number;
    /**
     * 从当前等级升到下一级所需的**经验总量**（`HeroData.getExpForNextLevel(level)`）。
     * 0 = 没有经验口径/未解锁 → 卡片收起经验条（不画一条永远空的进度）。
     */
    expMax: number;
    /** 这一步要花的金币：未解锁 = 解锁价，已解锁 = 升下一级的价（0 = 免费） */
    cost: number;
    /** 这一步**现在能不能点**（判据由宿主算：金币够不够；false → 按钮置灰） */
    enabled: boolean;
    /** 4 行属性（`HeroConfig.getAttrRows` 的产出，已换算成展示文案） */
    attrs: HeroAttrRow[];
}
