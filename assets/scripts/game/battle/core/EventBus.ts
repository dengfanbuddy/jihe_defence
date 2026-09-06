/**
 * battle/core/EventBus —— 旧 UI/数据层事件名定义（兼容层）
 *
 * 说明：
 *   - 新战斗系统的事件常量在 `battle/types.ts` 的 `BattleEvents` 中
 *   - 本文件是旧代码（Scene_Game_Stage / View_Game_Stage / HeroItem 等）
 *     引用的 `EventNames` / `EventName` / `EventPayload`，保持接口不变
 */
import { EventBus } from '../EventBus';
import { BattleEvents } from '../types';

/** 事件名集合（旧 UI/场景层约定） */
export const EventNames = {
    // 战斗场景
    BATTLE_EXIT: 'battle_exit',
    BATTLE_SELECT_HERO: 'battle_select_hero',
    BATTLE_START: 'battle_start',
    BATTLE_ENDED: 'battle_ended',
    BATTLE_PAUSED: 'battle_paused',
    BATTLE_RESUMED: 'battle_resumed',
    //战斗时间
     BATTLE_REMAINTIME: 'battle_remaintime',
    // 英雄状态
    HERO_HP_STATUS: 'hero_hp_status',
    HERO_SHIELD_STATUS: 'hero_shield_status',
    HERO_ENERGY_STATUS: 'hero_energy_status',
    HERO_LEVEL_UP: 'hero_level_up',
    HERO_BUFF_CHANGED: 'hero_buff_changed',
    // 商店 / 肉鸽
    SHOP_OPENED: 'shop_opened',
    SHOP_CLOSED: 'shop_closed',
    RELIC_ADDED: 'relic_added',
    RELIC_REMOVED: 'relic_removed',
    // 战斗事件（保留旧名，部分与 BattleEvents 对齐）
    // 与 BattleEvents 值相同的枚举项直接引用，保证单一来源（同名避免漂移）
    ON_DEATH: BattleEvents.OnDeath,
    ON_KILL: BattleEvents.OnKill,
    ON_DAMAGE: 'on_damage',
    ON_TAKE_DAMAGE: BattleEvents.OnTakeDamage,
} as const;

/** 事件名类型 */
export type EventName = keyof typeof EventNames;

/** 事件负载类型（EventNames.X 的值 → 事件数据结构） */
export type EventPayload<K extends string> = any;

export { EventBus };
export default EventBus;
