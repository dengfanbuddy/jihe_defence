/**
 * ============================================================
 * EntityVisualConfig —— 单位「配色 / 缩放 / 受击闪烁」的唯一来源
 * ============================================================
 *
 * 为什么单独抽一张表：
 *   同一份 scale 有**两个消费者**，必须一致，否则"看起来多大"和"被推开多远"会对不上：
 *     · 表现层：EntityView / HitFlash 用它 setScale（节点放大）
 *     · 逻辑层：Entity.SetUnitKind 用它乘碰撞半径（collisionRadius）
 *   实体分离的间距是 minDist = r1 + r2，半径乘了同一个倍率，
 *   所以 2 倍大的最终 Boss 与 1 倍普通怪之间的推开距离正好等于两者体型之和。
 *
 * 本文件**不依赖 cc**（只存 0xRRGGBB 整数与数值），
 * 逻辑层（battle/）可以安全引用；颜色转 cc.Color 由表现层做（HitFlash.toColor）。
 *
 * 需求口径（策划给定）：
 *   普通怪 6B8E9B ×1     精英 9B59B6 ×1.3    金币Boss E74C3C ×1.5   击杀Boss E74C3C ×1.5
 *   阶段Boss 3B1C32 ×1.5  最终Boss 3B1C32 ×2  英雄 保留预制件本色 ×1
 *   受击色：英雄 FF4C4C / 普通 FFFFFF / 精英 E0B0FF / 金币Boss FFFFFF / 击杀Boss FFA500 / 阶段·最终 Boss 00FFFF
 */

/** 单位表现类别（由配置解析得到，见 resolveUnitKind） */
export enum UnitKind {
    /** 英雄（team=1）：不染色，保留预制件原色 */
    Hero = 'hero',
    /** 普通怪（subtype=normal） */
    Normal = 'normal',
    /** 精英怪（subtype=elite） */
    Elite = 'elite',
    /** 金币 Boss（rewardType=gold_boss；经验 Boss exp_boss 同为经济 Boss，共用配色与体型） */
    GoldBoss = 'gold_boss',
    /** 击杀 Boss（rewardType=kill_boss） */
    KillBoss = 'kill_boss',
    /** 阶段 Boss（阶段 1~4 结束刷出） */
    StageBoss = 'stage_boss',
    /** 最终 Boss（进入 Boss 阶段时刷出） */
    FinalBoss = 'final_boss',
}

/** 单个类别的表现参数 */
export interface UnitVisualStyle {
    /** 底色（0xRRGGBB）；null = 不染色，保留预制件原色（英雄） */
    color: number | null;
    /** 节点缩放；同时作为碰撞半径倍率（1 = 配置里的 collision_radius 原值） */
    scale: number;
    /** 受击闪烁色（0xRRGGBB） */
    hitColor: number;
    /** 受击色停留时长（秒），需求区间 0.05 ~ 0.1 */
    hitFlashDuration: number;
}

/** 受击色停留时长（秒）—— 需求：0.05 ~ 0.1 秒即可，取中值 0.08 */
export const HIT_FLASH_DURATION = 0.08;

/** 进入该阶段即 Boss 战（该阶段刷出的 Boss 是最终 Boss） */
export const FINAL_BOSS_STAGE = 5;

/** 各类别表现参数表（改配色/体型只动这里） */
export const UNIT_VISUALS: Record<UnitKind, UnitVisualStyle> = {
    // 英雄：美术自带配色 → 不染底；受击染 FF4C4C
    [UnitKind.Hero]: { color: null, scale: 1, hitColor: 0xff4c4c, hitFlashDuration: HIT_FLASH_DURATION },
    // 普通怪
    [UnitKind.Normal]: { color: 0x6b8e9b, scale: 1, hitColor: 0xffffff, hitFlashDuration: HIT_FLASH_DURATION },
    // 精英怪
    [UnitKind.Elite]: { color: 0x9b59b6, scale: 1.3, hitColor: 0xe0b0ff, hitFlashDuration: HIT_FLASH_DURATION },
    // 金币 Boss / 经验 Boss（经济 Boss）
    [UnitKind.GoldBoss]: { color: 0xe74c3c, scale: 1.5, hitColor: 0xffffff, hitFlashDuration: HIT_FLASH_DURATION },
    // 击杀 Boss
    [UnitKind.KillBoss]: { color: 0xe74c3c, scale: 1.5, hitColor: 0xffa500, hitFlashDuration: HIT_FLASH_DURATION },
    // 阶段 Boss
    [UnitKind.StageBoss]: { color: 0x3b1c32, scale: 1.5, hitColor: 0x00ffff, hitFlashDuration: HIT_FLASH_DURATION },
    // 最终 Boss
    [UnitKind.FinalBoss]: { color: 0x3b1c32, scale: 2, hitColor: 0x00ffff, hitFlashDuration: HIT_FLASH_DURATION },
};

/** 取某类别的表现参数（未知类别兜底为普通怪） */
export function getUnitVisualStyle(kind: UnitKind): UnitVisualStyle {
    return UNIT_VISUALS[kind] ?? UNIT_VISUALS[UnitKind.Normal];
}

/** 取某类别的缩放倍率（= 碰撞半径倍率，逻辑层与表现层共用） */
export function getUnitScale(kind: UnitKind): number {
    return getUnitVisualStyle(kind).scale;
}

/**
 * 解析单位配置对应的表现类别（UnitCfg 结构子集，避免 common → excel_table 的依赖）
 *
 * 判定优先级：英雄 → 经济/击杀 Boss（rewardType）→ 阶段/最终 Boss（rewardType=boss 或 subtype=boss）
 *             → 精英 → 普通
 * 注：最终 Boss 无法从配置单条区分（同一个单位在不同阶段出现），
 *     由刷新方显式传入（见 resolveBossKind）。
 */
export function resolveUnitKind(def: UnitKindSource | null | undefined): UnitKind {
    if (!def) return UnitKind.Normal;
    // 英雄：team=1 或 category='hero'
    if (def.team === 1 || def.category === 'hero') return UnitKind.Hero;

    switch (def.rewardType) {
        case 'gold_boss':
        case 'exp_boss': // 经验贩子：同为经济 Boss，与金币 Boss 共用配色/体型
            return UnitKind.GoldBoss;
        case 'kill_boss':
            return UnitKind.KillBoss;
        case 'boss':
            return UnitKind.StageBoss; // 关底 Boss（阶段/最终由 resolveBossKind 细分）
        default:
            break;
    }

    if (def.subtype === 'elite') return UnitKind.Elite;
    if (def.subtype === 'boss') return UnitKind.StageBoss;
    return UnitKind.Normal;
}

/** 解析类别所需的最小配置字段集（UnitCfg 可结构性赋值） */
export interface UnitKindSource {
    category?: string;
    team?: number;
    subtype?: string;
    rewardType?: string;
}

/**
 * 阶段 Boss 的类别：Scene_Game_Stage.spawnBoss(stage) 在 stage 计时结束时调用（随后 stage++），
 * 因此**进入 FINAL_BOSS_STAGE 时**刷出的那只才是最终 Boss，其余都是阶段 Boss。
 * @param stage spawnBoss 收到的当前阶段号（调用时尚未 +1）
 */
export function resolveBossKind(stage: number): UnitKind {
    return stage + 1 >= FINAL_BOSS_STAGE ? UnitKind.FinalBoss : UnitKind.StageBoss;
}
