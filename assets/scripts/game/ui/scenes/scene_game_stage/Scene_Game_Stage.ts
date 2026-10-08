import { UnitCfg, UnitCfgContainer } from '../../../excel_table/Tb_UnitConfig';
import { _decorator, Button, Node, UITransform } from 'cc';
import { uiview } from '../../../../platform/ui/UIDecorator';
import { ViewLayer } from '../../../../platform/ui/ViewInfo';
import UIManager from '../../../../platform/ui/UIManager';
import { AdMgr, type AdPlacement } from '../../../../platform/ad/AdMgr';
import { View_Game_Stage } from './cmps/View_Game_Stage';
import { RevivePromptPanel } from './cmps/RevivePromptPanel';
import type { ReviveChoice } from './cmps/RevivePromptPanel';
import { StageScopeEvents, StageScopeKeys } from './cmps/StageScope';
import BaseView from '../../../../platform/ui/BaseView';

import { useBattleStore } from '../../../stores';

import { BattleContext, EventBus, BattleConstUtil, BattleEvents, StateType } from '../../../battle';
import { EventNames } from '../../../battle/core/EventBus';
import { Entity } from '../../../battle/Entity';
import { DataCenter } from '../../../data';
import { BAG_ITEM_KEY } from '../../../data/configs/BagConfig';
import { TbRoot } from '../../../../platform/excel_table/TbRoot';
import { ShopConfig } from '../../../data/configs/ShopConfig';
import { AttributeScaling } from '../../../battle/core/AttributeScaling';
import { AttributeType } from '../../../battle/core/Types';
import { MonsterPool } from '../../../game_stage/entityview/MonsterPool';
import { ProjectileViewPool } from '../../../game_stage/entityview/ProjectileViewPool';
import { DamageTextLayer } from '../../../game_stage/entityview/DamageTextLayer';
import { HitVfxLayer } from '../../../game_stage/entityview/HitVfxLayer';
import { HitScreenLayer } from '../../../game_stage/entityview/HitScreenLayer';
import type { HitScreenAnchor } from '../../../game_stage/entityview/HitScreenLayer';
import { HitFeelDirector } from '../../../game_stage/entityview/HitFeelDirector';
import { TargetPicker } from '../../../game_stage/entityview/TargetPicker';
import { HeroSelect, RelicShop, BuffShop } from '../../../battle';
import { SkillSlots } from '../../../battle/SkillSlots';
import { BossScheduler } from '../../../battle/BossScheduler';
import type { BossSlotKey, BossSlotDef } from '../../../battle/BossScheduler';
import { RelicSystem } from '../../../battle/BattleEquipSystem';
import { Ability_LightningChain } from '../../../battle/ScriptedAbilities';
import { Modifier_CounterStorm, Modifier_EagleEye, Modifier_MusketHeadshot, Modifier_ZeusThunder } from '../../../battle/ScriptedModifiers';
import { SHOP_SKILL_SCRIPT_CLASSES } from '../../../battle/ShopSkillModifiers';
import { RELIC_HOOK_SCRIPT_CLASSES } from '../../../battle/RelicHooks';
import { pickTarget, pickTargetAtPoint } from '../../../battle/Targeting';
import { initializeAI } from '../../../battle/ai';
import { GraphCircle } from '../../../common/GraphCircle';
import {
  bossHpMul, describeLevel, enemyAtkMul, enemyHpMul, levelLabel, rewardMul, spawnGapMul,
} from '../../../common/DifficultyConfig';
import { gameModeName } from '../../../common/GameModeConfig';
import AudioMgr from '../../../../platform/audio/AudioMgr';
import { clampBattleDt, hitFeelSfxKeys } from '../../../common/HitFeelConfig';
import { TAP_SELECT } from '../../../common/TargetSelectConfig';
import { UnitKind, getUnitScale, resolveBossKind, resolveUnitKind, FINAL_BOSS_STAGE } from '../../../common/EntityVisualConfig';
import { Hero } from '../../../game_stage/Hero';
import { Scene_Menu } from '../scene_menu/Scene_Menu';
import type { AchEffectCode } from '../../../excel_table/Tb_AchievementConfig';

const { ccclass, property } = _decorator;

/**
 * 弹道预制件兜底路径。
 * 美术资源未就位时，所有未显式配置 projectile_prefab / attack_projectile_prefab
 * 的弹道统一用 projectile_1 表现（配置里显式指定的路径优先）。
 */
const DEFAULT_PROJECTILE_PREFAB = 'prefabs/unit/projectiles/projectile_1';

/**
 * 印痕层节点名（B2）。
 *
 * 取名字而不是加一个 `@property(Node)`：本组件在预制件里已序列化了一批节点引用，
 * 新增一个引用字段会让**已存在的预制件实例**多出一个悬空槽（编辑器里要手工拖一次才生效）；
 * 而按名字取是"零配置可用"的 —— 节点在就复用、不在就运行时建（见 `ensureHitVfxLayer`）。
 */
const HIT_VFX_NODE_NAME = 'vfx';

/**
 * 屏幕层节点名（B3）。
 *
 * 它是**屏幕空间**的信息层（墨闪 / 边缘角标 / 连击 / 落款 / 奖励飞入），与 `vfx`（战斗内容层）分开：
 * `vfx` 跟着内容层位移一起抖，屏幕层**绝不抖**（详见 HitScreenLayer 的类注释）。
 * 同样按名字取而不是加 `@property`（理由见上）。
 */
const HIT_SCREEN_NODE_NAME = 'screen_vfx';

/**
 * 点选层节点名（点击怪物切换普攻目标）。
 *
 * 同样按名字取而不是加 `@property(Node)`（理由见上）。
 * ⚠ 它**插在 `enimys` 之前**（bg 之上、怪之下）：选中环才读作"圈在地上的锁定框"，
 *   既不盖住怪也不盖住飘字；同时它在 HUD 之前，点 HUD 按钮不会被这一层抢走手势。
 */
const TARGET_PICKER_NODE_NAME = 'target_picker';


/**
 * Scene_Game_Stage.ts — 游戏战斗场景（总控，相当于 GameManager）
 *
 * 职责（迁移自 ts_combat_system/demo/GameManager.ts）：
 *   1. 配置加载 → BattleContext 初始化（attributes/modifiers/abilities/relics/units）
 *   2. 创建英雄（居中守点）+ 遗物系统 + 肉鸽商店
 *   3. 刷怪（随时间加快）/ 怪物 AI（朝中心移动 + 自动普攻）
 *   4. 英雄 AI（普攻索敌 + 自动施放 CD 就绪技能）
 *   5. 每帧驱动 BattleContext.Tick（Modifier 计时 / DoT / 冷却 / 弹道）
 *   6. 局内功能三分（选英雄 / 遗物商店 / Buff 商店）：**本场景只做宿主** —— 持有入口按钮与面板节点、
 *      把功能类的状态 provide 给 UI 子树、把子树冒泡上来的事件转发给它们、提供平台能力（金币扣费、广告、
 *      创建英雄实体）；规则与流程全在 `battle/` 的三个功能类（HeroSelect / RelicShop / BuffShop）里
 *   7. 胜负判定：**唯一收口是 `endRun()`**（英雄阵亡 / Boss 阶段超时 = 失败，最终 Boss 被击杀 = 胜利）——
 *      三个触发点都是**瞬时事件**（`OnDeath` / 阶段倒计时归零），所以不靠每帧轮询
 *
 * 与 FSM 状态机配合：HeroSelection（选英雄）→ Battle（战斗中）→ Pause（暂停）
 */

/** 玩法参数（BattleDemo 对应项，可整段调整；id 均为 number） */
export interface GameStageConfig {
  heroUnitId: number;
  /**
   * 本局允许出场的怪物白名单（**空数组 = 不限制**）。
   *
   * ⚠ 出怪的数量 / 间隔 / 混怪配比**不在这里** —— 唯一真源是模块级常量 `SPAWN_BEATS`（见其注释）。
   *   本字段只是叠在它上面的一道闸：把不在名单里的单位从 mix 里剔掉，方便调试时整体停用某只怪。
   */
  monsterPool: number[];
  /** 肉鸽道具（遗物）池白名单（空 = 商店遗物全表 1001~1293） */
  relicPool: number[];
  spawnRadius: [number, number];
  /** 阶段 Boss 单位 id（阶段 1~4 结束刷出；0 = 不刷）。表现类别 = 阶段 Boss（缩放 ×1.5） */
  stageBossUnitId: number;
  /** 最终 Boss 单位 id（进入 Boss 阶段时刷出；0 = 不刷）。表现类别 = 最终 Boss（缩放 ×2） */
  finalBossUnitId: number;
  shopEvery: number;
  /**
   * 存活时长阈值（秒）——**当前未被消费**：胜负由 `endRun()` 收口
   * （最终 Boss 被击杀 = 胜利 / 英雄阵亡 · Boss 阶段超时 = 失败）。
   * 保留该字段是给后续"存活满 N 秒即胜利"的玩法留口，别当成生效中的配置。
   */
  winTime: number;
  maxSkillSlots: number;
  killHeal: number;
  center: { x: number; y: number };
  /** 准备期时长（秒）：选完英雄后开始倒计时，期间不刷怪，HUD 显示「准备中」 */
  prepareTime: number;
  /** 常规阶段时长（秒）：阶段 1~4 各持续这么久 */
  stageTime: number;
  /** Boss 阶段时长（秒）：超时未击杀 = 失败 */
  bossTime: number;
}

/* ===================================================================
 * 刷怪节拍表（出怪导演的静态部分）
 *
 * 口径与推导过程见 `docs/局内刷怪节奏设计.md` §12.3。三条要点：
 *
 *   ① **beat = 60 秒**。一局 16 个常规 beat（正好对接 4 个 240s 阶段），
 *      外加 1 个 Boss 阶段 beat（elapsed ≥ 960s 后接管）。难度在**阶段内部**也连续爬升，
 *      而不是每 4 分钟才跳一次。
 *
 *   ② `n`（同时刷怪数量）是**手工配的节奏旋钮** —— 玩家看得见的那一个，只增不减（1 → 6）。
 *      `gap`（批间隔）是**推导出来的**：`gap = n × 混怪均HP ÷ 目标HP流`。
 *      两者同步变大（批更大、批与批之间的喘息也更长），于是
 *      **出怪速率 S = n / gap 基本持平（0.75 → 1.57）**，
 *      而**难度增长全部由「每只怪更肉更贵」承担（均HP 40 → 181）**。
 *      —— 这是「单英雄定点输出」结构下的算术必然，不是风格选择（见设计稿 §3 公理 1）。
 *
 *   ③ `mix` 是混怪权重 `[单位id, 权重][]`。**杂兵（哥布林/游荡者）必须全程在场**：
 *      它们脆、慢、便宜，是维持「屏幕有东西」和「收入不断流」的底盘；
 *      巨魔/重击者这类威胁占 20~40% 就够，全上精英会同时造成屏幕空旷 + 收入暴跌。
 *
 * ⚠ 单位 id：2001 哥布林 / 2002 巨魔 / 2003 游荡者 / 2004 环绕魔 / 2005 重击者
 * ⚠ **改 `config.stageTime` 不需要改这张表**（它按 elapsed 走，与阶段无关），
 *   但改单局总时长会同时影响 `SPAWN_BEAT_BOSS` 的接管时刻与 Boss 调度（见设计稿 §12.4）。
 * ⚠ 标了 ⚠ 的 beat，S 已超过裸装攻击频率（1.2 只/s）—— **这是设计要求**：
 *   从 beat 8（t=420s，约第 7 分钟）起，玩家必须开始堆攻速才能跟上。
 * =================================================================== */
const SPAWN_BEAT_SEC = 60;

interface SpawnBeat {
  /** 每批同时刷几只（手工配，只增不减） */
  n: number;
  /** 批间隔（秒，由 n × 混怪均HP ÷ 目标HP流 推导） */
  gap: number;
  /** 混怪权重 [单位id, 权重][] */
  mix: [number, number][];
}

/** 常规阶段的 16 个 beat（0~960s）：每 60s 一档，N 与均HP 连续爬升 */
const SPAWN_BEATS: SpawnBeat[] = [
  { n: 1, gap: 1.33, mix: [[2001, 100]] },                                                  // beat  1   0~60s   S=0.75
  { n: 1, gap: 1.17, mix: [[2001, 95], [2003, 5]] },                                        // beat  2            S=0.85
  { n: 2, gap: 2.20, mix: [[2001, 90], [2003, 10]] },                                       // beat  3            S=0.91
  { n: 2, gap: 2.09, mix: [[2001, 80], [2003, 20]] },                                       // beat  4  阶段1收官  S=0.96
  { n: 2, gap: 1.92, mix: [[2001, 75], [2003, 25]] },                                       // beat  5            S=1.04
  { n: 2, gap: 1.73, mix: [[2001, 70], [2003, 30]] },                                       // beat  6            S=1.15
  { n: 3, gap: 2.31, mix: [[2001, 65], [2003, 35]] },                                       // beat  7            S=1.30
  { n: 3, gap: 2.05, mix: [[2001, 60], [2003, 40]] },                                       // beat  8  阶段2收官  S=1.46 ⚠
  { n: 3, gap: 1.88, mix: [[2001, 50], [2003, 40], [2004, 10]] },                           // beat  9            S=1.60 ⚠
  { n: 3, gap: 1.70, mix: [[2001, 40], [2003, 40], [2004, 20]] },                           // beat 10            S=1.77 ⚠
  { n: 4, gap: 2.31, mix: [[2001, 30], [2003, 40], [2004, 25], [2002, 5]] },                // beat 11            S=1.73 ⚠
  { n: 4, gap: 2.41, mix: [[2001, 25], [2003, 35], [2004, 30], [2002, 10]] },               // beat 12 阶段3收官  S=1.66 ⚠
  { n: 4, gap: 2.68, mix: [[2001, 20], [2003, 30], [2004, 30], [2002, 20]] },               // beat 13            S=1.49 ⚠
  { n: 5, gap: 3.61, mix: [[2001, 15], [2003, 25], [2004, 30], [2002, 25], [2005, 5]] },    // beat 14            S=1.39 ⚠
  { n: 5, gap: 3.51, mix: [[2001, 10], [2003, 25], [2004, 30], [2002, 30], [2005, 5]] },    // beat 15            S=1.42 ⚠
  { n: 6, gap: 4.03, mix: [[2001, 10], [2003, 20], [2004, 30], [2002, 30], [2005, 10]] },   // beat 16 阶段4收官  S=1.49 ⚠
];

/** Boss 阶段（elapsed ≥ 960s）接管的刷怪节奏 */
const SPAWN_BEAT_BOSS: SpawnBeat = {
  n: 6, gap: 3.81,
  mix: [[2001, 10], [2003, 20], [2004, 30], [2002, 25], [2005, 15]],                        // S=1.57 ⚠
};

/** 开局热身（秒）：阶段 1 开始后先安静这么久再刷第一批，让玩家看清英雄的普攻节奏与射程 */
const SPAWN_WARMUP_SEC = 3;

/**
 * 存活**软阀门**（替换原来的硬截断）：
 *   存活 > SOFT → 间隔 ×1.5（收入只减 1/3，**不断流**）
 *   存活 ≥ HARD → 暂停本批，但只等 SPAWN_RETRY_SEC 就重试（**不丢这一批**）
 *
 * 为什么必须有：原写法 `min(数量, 50 - 存活)` 是硬截断，一旦贴顶就**出怪归零 → 收入归零 →
 * 死亡螺旋**（越打不出怪越买不起装备，越买不起越打不动）。
 */
const SPAWN_ALIVE_SOFT = 40;
const SPAWN_ALIVE_HARD = 50;
const SPAWN_RETRY_SEC = 0.5;

/**
 * 「敌方守卫」击杀后的刷怪加码（每个击杀各生效一次，最多 2 次）。
 *
 * 用户口径：「**每击杀一个守卫，怪物刷新加快，数量增多**」——所以两个旋钮都动：
 *   · 同时数量 `N += 1`  → **数量增多**（一批更大；顺带把出怪速率 S = N/Gap 抬上去）
 *   · 批间隔 `Gap ×= 0.95` → **刷新加快**（批与批之间更密）
 * 两次都吃掉后：N +2、Gap ×0.9 —— S 大约 ×1.6（§5.5 的「自证式加码」就是按这个量级设计的：
 * 玩家能杀掉 1500 HP 的守卫，就说明他有这个余力）。
 */
const SPAWN_GUARD_GAP_MUL = 0.95;
/** 同时数量的绝对上限（防手滑配出超大批；与 SPAWN_ALIVE_HARD 一起兜住同屏） */
const SPAWN_MAX_CONCURRENT = 8;

/**
 * 成就「闪电战」的判定窗口（秒）：**最终 Boss 出现后**多久内击杀算"快"。
 *
 * ⚠ 基准是「最终 Boss 刷出的那一刻」而不是绝对用时 —— 绝对用时会随单局时长改版而失效。
 *   旧写法 `this.elapsed <= 240` 就是个反例：最终 Boss 恰好在 elapsed=240 刷出，
 *   所以那个条件**永远不可能成立**（闪电战成就此前一直拿不到）。
 */
const CLEAR_FAST_BOSS_WINDOW_SEC = 30;

/** 按权重抽一个单位 id（权重全为 0/空 → 返回 0，调用方跳过） */
function pickWeighted(mix: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < mix.length; i++) total += Math.max(0, mix[i][1]);
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < mix.length; i++) {
    r -= Math.max(0, mix[i][1]);
    if (r < 0) return mix[i][0];
  }
  return mix[mix.length - 1][0];
}

@uiview({
  prefabPath: 'prefabs/ui/scenes/scene_game_stage/Scene_Game_Stage',
  layer: ViewLayer[ViewLayer.Scene],
  single: true,
})
@ccclass('Scene_Game_Stage')
export class Scene_Game_Stage extends BaseView {


  /** 战斗上下文（核心，纯 TS 无 cc 依赖） */
  ctx!: BattleContext;


  /* ===== 战斗实体 ===== */
  /** 玩家控制的英雄（Entity，居中心不移动） */
  hero: Entity = null;
  /** 当前在场的所有怪物 */
  // private monsters: Entity[] = [];

  /* ===== 肉鸽系统 ===== */
  /** 遗物背包（本局已获得遗物 + 属性/被动挂载，一件遗物 = 一组永久 Modifier） */
  heroRelics!: RelicSystem;

  /* ===== 怪物统一对象池（组合逻辑池 + 表现池） ===== */
  monsterPool!: MonsterPool;
  /** 弹道表现层对象池 */
  projectilePool!: ProjectileViewPool;
  /** 飘伤害字层（整场一个中央层，节点在预制件里：见 ensureDamageTextLayer） */
  private damageText: DamageTextLayer | null = null;

  /**
   * 图纸印痕层（B2，见 `docs/打击反馈设计.md` §4/§6）
   *
   * 整层一个 Graphics 画刻度 / 细环 / 对位十字 / 死亡碎片 / 起手虚线（恒定 1 draw call）。
   * 节点插在 `projectile_cache` 与 `damage_layer` 之间（压在战斗内容之上、飘字与 HUD 之下）：
   * 见 `ensureHitVfxLayer` 的三级取用。
   */
  private hitVfx: HitVfxLayer | null = null;

  /**
   * 屏幕层（B3，见 `docs/打击反馈设计.md` §7）
   *
   * 墨色闪帧（α 由导演算）/ 屏幕边缘受伤角标 / 连击计数 / 击杀落款 / 金币经验飞入。
   * 整层一个 Graphics（恒定 1 draw call），**不参与内容层位移**（信息不该跟着震屏晃），
   * 节点插在 HUD 之前（奖励飞过去时"钻进"HUD 里消失）。
   */
  private hitScreen: HitScreenLayer | null = null;

  /**
   * 点选层（点击怪物切换普攻目标）—— **输入 + 选中标记**，见 `game_stage/entityview/TargetPicker.ts`。
   *
   * 两层职责划清：本组件只把"点了一下"翻译成逻辑坐标、并按要求把选中的那只框出来；
   * **"点中了谁 / 要不要改目标"全在本场景**（`onFieldTap` → `resolveAttackTarget`），
   * 与自动索敌共用同一套"能不能打"判据（`isTargetUsable`）与同一套决策点。
   */
  private targetPicker: TargetPicker | null = null;

  /**
   * 打击反馈导演（B1，见 `docs/打击反馈设计.md` §5/§6）
   *
   * 它只做**全局**那几件事：顿帧（时间账本）、暴击/大击杀慢动作、**战斗内容层位移**、密度统计。
   * 每只怪自己的抖动/膨胀/置顶在 `EntityView` 里（同一个 `OnTakeDamage`，按目标分组）。
   * 本场景对它的三个用途：① `update` 里推进它；② 用它算 `dtCombat`；③ 把它的位移写到位移层上。
   */
  hitFeel: HitFeelDirector | null = null;

  /** 英雄脚下的攻击范围圈（hero/range 节点上的 GraphCircle），与真实射程保持同步 */
  private heroRangeCircle: GraphCircle | null = null;

  @property(Node)
  heroNode: Node

  //死亡缓存的怪物父节点
  @property(Node)
  monsterCacheParent: Node
  //活着的怪物的父节点
  @property(Node)
  monsterParent: Node

  //死亡缓存的弹道父节点
  @property(Node)
  projectileCacheParent: Node
  //活着的弹道的父节点
  @property(Node)
  projectileParent: Node

  //伤害层（编辑器里摆好层级：压在 enimys/hero/弹道之上、UI 之下）
  @property(Node)
  damageLayerNode: Node

  /* ===== 玩法参数 / 统计 ===== */
  config!: GameStageConfig;
  private spawnTimer = 0;
  private shopTimer = 0;
  //经过的用时
  private elapsed = 0;
  //stage所处阶段
  private prepareRemainTime = 10;
  private stage = 0 //0 准备 1，2，3，4，5boss
  private stageRemainTime = 60
  private finished = false;
  private victory = false;
  private killCount = 0;
  /**
   * **本局的难度档位**（1 ~ `DifficultyConfig.DIFFICULTY_MAX`）。
   *
   * 真源是 `DataCenter.ins.levelData` 里**当前模式**那一份的 `selected`（难度选择弹窗「确定」时落盘；
   * 档位按模式各记一份，见 `LevelData` 文件头），
   * 在 `resetRun()` 里**读一次、本局全程不变** —— 局内所有缩放都取自这一个数：
   *   · 怪物/Boss 的基础属性（`monsterPool.statScaleHook` → `applyDifficultyScale`）
   *   · 刷怪间隔（`getSpawnInterval`）
   *   · 击杀金币/经验（`currentRewardScale`）
   * 曲线与倍率全在 `common/DifficultyConfig`（档 1 = ×1，即"当前基准平衡"）。
   */
  private difficulty = 1;
  /**
   * 成就标记：本局英雄**是否受过伤**（成就 `clear_no_damage` 的判据）。
   * 受击订阅（`OnTakeDamage` 且目标是英雄）置位、`resetRun` 开局清零。
   */
  private tookDamage = false;
  /** 最终 Boss 实体（进入 Boss 阶段时刷出的那一只）；它阵亡 = 通关（见 endRun 的调用点） */
  private finalBoss: Entity | null = null;
  /**
   * 最终 Boss **刷出那一刻**的 `elapsed`（-1 = 本局还没刷过）。
   *
   * 成就「闪电战」的判据基准 —— 用**相对时刻**而不是绝对用时：
   * 绝对用时会随单局时长改版而失效（旧写法 `elapsed <= 240` 就永远不可能成立，
   * 因为最终 Boss 恰好也是在 elapsed=240 刷出的）。
   */
  private finalBossSpawnElapsed = -1;

  /** 战斗事件是否已订阅到当前 ctx（同一局内换英雄只订阅一次，避免重复发奖励） */
  private eventsBound = false;
  /** 本局是否已播种初始金币（首次选英雄播一次；换英雄不重播，否则换一次英雄白拿一次） */
  private initialGoldSeeded = false;
  /** 本局是否已补「开局英雄等级」（首次选英雄补一次；换英雄不重补） */
  private startLevelApplied = false;
  /** 上一次投影到 store 的技能 id 串（只在技能变化时才写 store，避免每帧触发 UI watcher） */
  private lastSkillKey = '';

  /* ===== 成就特殊效果：**开局快照** ===== */

  /**
   * 本局的成就效果快照（`{ [effect_code]: value }`，已由数据层按 `ACH_EFFECT_META.cap` 封顶）。
   *
   * ⚠ **开局读一次、本局全程用它**（设计稿 `docs/成就系统设计.md` §5.2）：
   *   · 唯一读取点是 `snapshotAchieveEffects()`（`show()` 里调一次），**局中领奖不改本局数值**；
   *   · 下面那组 `achXxx()` 取数口是**只读**的，给战斗侧各系统用（沿既有 `deps` 注入下去），
   *     战斗层**不许**自己调 `DataCenter.ins.achieveData.getEffects()` ——
   *     那样就成了"打到一半突然多 50 金币 / 多一个商店选项"。
   */
  private achieveEffects: Partial<Record<AchEffectCode, number>> = {};

  battleStore = useBattleStore();

  /* ===================================================================
   * 局内功能三分（选英雄 / 遗物商店 / Buff 商店）—— 本场景只是**宿主**
   *
   * 每个功能一个类（都在 `game/battle/`，纯 TS、无 cc 依赖），场景只做四件事：
   *   ① 持有节点（入口按钮 / 面板节点）—— **节点在谁名下，显隐就由谁写**（绝不跨组件改别人的节点）
   *   ② 把功能类的**门面**（只读面）`provide` 给整棵 UI 子树（键见 `StageScope`）
   *   ③ 把子树冒泡上来的事件转交给功能类（本场景只是"转发"，不含任何"能不能"的判断）
   *   ④ 提供平台能力：金币真源与扣费、广告（播放期间暂停战斗）、创建/切换英雄实体
   *
   *   选英雄     HeroSelect  候选池 / 刷新（金币或广告）/ 选中 → 回调 `selectHero(heroId)`
   *   遗物商店   RelicShop   刷 4 个（抽取规则见 `RelicDraw`）/ 费用与广告额度 / 选中后入背包
   *   Buff 商店  BuffShop    4 个摊位 / 价格与层数 / 购买后属性当场生效
   *
   * ⚠ 选英雄面板与 Buff 商店面板的**节点在 HUD（View_Game_Stage）名下**，入口按钮也是 ——
   *   所以那两个面板的显隐由 HUD 写（它 inject 的是同一组 ref）；只有遗物面板的节点在本场景名下。
   * =================================================================== */

  /** 选英雄功能（纯 TS 封装，随界面建一次） */
  heroSelect!: HeroSelect;
  /** 遗物商店（纯 TS 封装，随界面建一次） */
  relicShop!: RelicShop;
  /** 击杀商店 Buff（纯 TS 封装，随界面建一次） */
  buffShop!: BuffShop;
  /**
   * 技能槽（纯 TS 封装，随界面建一次）：4 个格子的技能 id / 等级 / 锁定状态。
   * 商店抽到技能 → `RelicShop` 调 `grant()` 落槽；HUD 的 `SkillSlot` 格子读它渲染。
   */
  skillSlots!: SkillSlots;

  /**
   * Boss 调度（纯 TS 封装，随界面建一次）：三个槽位的 **充能 / 库存 / 点击放出 / 限时**。
   *
   * 与「CD 到点自动刷」的区别：CD 走完只给**库存 +1**，要**玩家点击**才真正放到场上 ——
   * Boss 因此是玩家手上的节奏资源（可以攒两只一起放造高潮，也可以留着不用）。
   * 规则全在 `battle/BossScheduler.ts`，本场景只做「持节点 + provide 门面 + 放怪/回收 + 加码」。
   */
  bossScheduler!: BossScheduler;

  /** 遗物入口按钮节点（编辑器拖引用；显隐与点击都由本场景管） */
  @property(Node)
  relicBtnNode: Node = null;
  /** 遗物面板节点（显隐唯一写入口是 applyRelicPanelVisible；面板自己不动自己的节点） */
  @property(Node)
  relicPanelNode: Node = null;

  /** 上一次投影到 store 的背包指纹（只在遗物真的变化时才写 relicBag，避免每次受伤都触发 UI watcher） */
  private lastRelicBagKey = '';

  /**
   * **复活面板**（运行期建在 HUD 节点下；见 `cmps/RevivePromptPanel.ts` 文件头）。
   * 英雄被打死那一刻由 `onLethalForHero` 弹出来，玩家的三种选择见 `onReviveChoice`。
   */
  private revivePrompt: RevivePromptPanel = null;
  /** 本局还剩几次「看广告复活」（`battle_constants.reviveAdPerRun`；`resetRun` 复位） */
  private adRevivesLeft = 0;
  /** 复活面板正开着（致命伤拦截器据此**继续拦截**：同一帧第二只怪的补刀不许真的打死英雄） */
  private revivePending = false;

  @property(Node)
  uiViewNode: Node
  uiView: View_Game_Stage

  /* ===================================================================
   * Cocos 生命周期
   * =================================================================== */

  onLoad(): void {
    this.uiView = this.uiViewNode.getComponent(View_Game_Stage)

    // 场景是整棵内嵌 UI 子树的 scope 宿主：**页面级状态**（面板开关、面板要渲染的列表）与
    // 「退出战斗」动作都在这里 provide，HUD / 面板 / item 在任意深度 inject 即可。
    //  · 放在 onLoad（不是 show）：父组件的 onLoad 一定早于子组件的 onLoad（引擎三阶段激活是前序），
    //    所以子树的 onInit 里就能注入到；而 show() 里 provide 的话，子组件 onInit 早就跑完了。
    //  · 判断哪些该放这儿：只有本界面内部读写的 → scope；跨界面 / 跨层的战斗状态 → useBattleStore。
    this.scope.provide(StageScopeKeys.ExitBattle, () => this.exit())

    // ── 三个功能类：状态（ref）由它们自己持有，本场景只负责 provide + 转发事件 + 提供平台能力 ──
    //  依赖一律用「延迟取」的闭包注入：遗物背包 / 商店随**一局**创建（选完英雄才有），
    //  而这些类随**界面**创建一次（它们的 ref 要在子树 onInit 前 provide 出去）。
    this.heroSelect = new HeroSelect({
      getGold: () => this.battleStore.gold,
      spendGold: (amount) => this.spendGold(amount),
      playAd: (placement) => this.playRewardAd(placement),
      selectHero: (heroId) => this.selectHero(heroId),
      // 成就效果（`hero_select_free`）：**只读**取本局的**开局快照**，局中领奖不改本局
      getAchAdFreeBonus: () => this.achHeroSelectFree(),
    })
    this.relicShop = new RelicShop({
      getBag: () => this.heroRelics,
      getSkillSlots: () => this.skillSlots,
      getGold: () => this.battleStore.gold,
      spendGold: (amount) => this.spendGold(amount),
      getHeroLevel: () => this.battleStore.level ?? 1,
      getPhase: () => this.stage,
      playAd: (placement) => this.playRewardAd(placement),
      // 局内广告券（背包道具）：刷新 / 补选时**先问背包**——有券就扣券免看广告，没券才走广告。
      //   ⚠ 这两个 getter 直接读 `bagData`（响应式），所以面板的 watcher 会跟着券的数量自动重画
      //   （"有券了按钮还写着看广告"这件事靠 `refreshButtonKey` 里的 viaTicket 那一位挡掉）。
      //   券**不增加局内配额**：用券照样走 `roll(true)`，`adFreeUsed` 照扣（见 docs/meta-growth/README.md §3.1）
      getAdTicketCount: () => DataCenter.ins.bagData.getCount(BAG_ITEM_KEY.adTicket),
      consumeAdTicket: () => DataCenter.ins.bagData.consumeItem(BAG_ITEM_KEY.adTicket, 1),
      // 技能槽全锁定时选中技能 → 飘字提示（节点在 HUD 名下 → 由 HUD 写它的表现）
      onSkillAllLocked: () => this.uiView?.showFloatText('技能槽已全部锁定，先解锁再选技能'),
      // 成就效果（开局快照）：抽取费用折扣 / 额外选项数 / 额外广告免费抽 / 开局赠遗物
      getAchDrawDiscount: () => this.achShopDrawDiscount(),
      // 遗物属性「24 抽卡折扣」：与成就折扣加法叠加（口径在 `RelicShop.discount()` 一处）
      getRelicDrawDiscount: () => this.hero?.attrs?.get(AttributeType.DrawDiscount) ?? 0,
      getAchOptionBonus: () => this.achShopOptionPlus(),
      getAchAdFreeBonus: () => this.achAdFreeDraw(),
      getAchStartGift: () => this.achRelicStartGift(),
      // 进度上报（成功才回调）：抽取次数 / 遗物图鉴收集
      onDraw: () => DataCenter.ins.achieveData.addProgress('draw_count', 1),
      onRelicGranted: (relicId) => this.onRelicCollected(relicId),
    }, () => this.config?.relicPool ?? [])
    this.buffShop = new BuffShop({
      getHero: () => this.hero,
      // 击杀商店的货币是**击杀数**（不是金币）：真源 = battleStore.killPoints（每杀 1 只 +1），
      // 与 HUD 的 money/kill 读的是同一个数；扣费口是 store 的 spendKillPoints
      getKillPoints: () => this.battleStore.killPoints,
      spendKillPoints: (amount) => this.battleStore.spendKillPoints(amount),
      playAd: (placement) => this.playRewardAd(placement),
      // 成就效果（`kill_buff_discount`）：价格折扣比例，折扣后价格是本类唯一的"下一层价格"口径
      getAchPriceDiscount: () => this.achKillBuffDiscount(),
      // 进度上报：买过的击杀商店 Buff 种类（`buff_types`，只记新种类）
      onBuffBought: (buffId) => DataCenter.ins.achieveData.addBuffType(buffId),
    })
    // 技能槽：等级上限于配置（abilities.json 的 max_level），英雄自带/肉鸽技能都靠它
    this.skillSlots = new SkillSlots({
      getHero: () => this.hero,
      getMaxLevel: (skillId) => {
        const cfg = ShopConfig.getAbility(skillId)
        return cfg ? ShopConfig.getSkillMaxLevel(cfg) : 1
      },
      hasSkill: (skillId) => !!ShopConfig.getAbility(skillId),
      // 槽位内容变了（升级 / 填槽 / 替换）→ 重新投影英雄技能列表，让 battleStore.heroSkills 不落后
      // （技能是在商店面板里发的，不会顺带触发受伤/回血那条同步路径）
      onChanged: () => this.syncHeroToStore(),
      // 进度上报：抽到过的肉鸽技能种类（`skills_picked`；只在**首次获得**时回调，升级不推进）
      onSkillGranted: (skillId) => DataCenter.ins.achieveData.addSkillKind(skillId),
    })

    // Boss 调度：三个槽位的充能/库存/点击放出/限时。
    // ⚠ 依赖全部用「延迟取」的闭包注入 —— `this.ctx` 要等 `initBattle()` 才有，
    //   而这个类随**界面**创建一次（它的 ref 要在子树 onInit 前 provide 出去）。
    this.bossScheduler = new BossScheduler({
      spawn: (def) => this.deployBoss(def),
      despawn: (uid, def) => this.despawnBoss(uid, def),
      // 每击杀一只敌方守卫 → 刷怪加码（同时数量 +1、批间隔缩短），见 currentBeat()
      onGuardKilled: (killed) => ezgame.info(`[Boss] 敌方守卫已击杀 ${killed} 只 → 刷怪加码生效`),
    })

    // 状态向下（provide）：**一个功能一个键，provide 的是功能实例（按只读门面声明类型）**，不是逐条裸 ref。
    //  面板/item 在任意深度 inject 到的就是这个对象：只读渲染 + 问它要规则（如 `shop.refreshGate()`），
    //  规则因此只有一处 —— 曾经拆成 19 条 ref，导致「刷新按钮能不能点」在 3 个面板里各抄了一遍。
    //  门面类型见各功能类（`HeroSelectVM` / `RelicShopVM` / `BuffShopVM` / `SkillSlotsVM` / `BossSchedulerVM`）。
    this.scope.provide(StageScopeKeys.HeroSelect, this.heroSelect)
    this.scope.provide(StageScopeKeys.RelicShop, this.relicShop)
    this.scope.provide(StageScopeKeys.BuffShop, this.buffShop)
    this.scope.provide(StageScopeKeys.SkillSlots, this.skillSlots)
    this.scope.provide(StageScopeKeys.BossScheduler, this.bossScheduler)

    // 通知向上（scope.on）：面板/item 的 emit 沿 node.parent 冒泡到这里，本场景只做转交，规则全在功能类里
    this.scope.on(StageScopeEvents.HeroRefresh, () => this.heroSelect.refresh(), this)
    this.scope.on(StageScopeEvents.HeroPicked, (heroId: number) => this.heroSelect.pick(heroId), this)
    this.scope.on(StageScopeEvents.RelicRefresh, () => this.relicShop.refresh(), this)
    this.scope.on(StageScopeEvents.RelicPicked, (relicId: number, viaAd: boolean) => this.relicShop.pick(relicId, viaAd), this)
    this.scope.on(StageScopeEvents.BuffShopRefresh, () => this.buffShop.refresh(), this)
    this.scope.on(StageScopeEvents.BuffShopBought, (buffId: number) => this.onBuffBought(buffId), this)
    // 技能槽：格子上的锁图标被点 → 由本场景改真源（格子自己不改状态）；被拒（槽 0 永久锁定）就飘字说明
    this.scope.on(StageScopeEvents.SkillLockToggled, (index: number) => this.toggleSkillSlotLock(index), this)
    // Boss 条目被点 → 转交调度器（**能不能放由它判**：库存 > 0 且场上未满；HUD 只发键）
    this.scope.on(StageScopeEvents.BossDeploy, (key: BossSlotKey) => this.bossScheduler?.deploy(key), this)

    // 面板显隐：功能类只写自己的 `panelVisible`，**节点 active 由持有节点的视图写** ——
    //   遗物面板节点在本场景名下 → 这里写；选英雄 / Buff 面板节点在 HUD 名下 → HUD 写（同一组门面）
    this.scope.watch(() => this.relicShop.panelVisible.value, () => this.applyRelicPanelVisible())

    this.applyRelicPanelVisible()
    // 费用与广告次数的初始投影（面板问门面要判据 `refreshGate()`，判据读的就是这两个 ref；
    //   换局 / 换英雄后还要再同步一次）
    this.relicShop.syncCost()
    this.buffShop.syncCost()
  }

  show() {
    // 重置本局状态
    this.resetRun();
    // 成就特殊效果：**开局读一次**（本局全程用它，局中领奖不改本局；见 achieveEffects 的注释）
    this.snapshotAchieveEffects();
    // 默认玩法参数（外部可在 show 前调用 setGameConfig 覆盖）
    this.config = this.defaultConfig;

    // 战斗常量（battle_constants.json）
    BattleConstUtil.markLoaded();

    // 事件订阅
    EventBus.on(EventNames.BATTLE_EXIT, () => this.exit());

    // 加载战斗配置（attributes/modifiers/abilities/relics/units）
    this.initBattle();
    // 开局的 UI 状态一律写 store / scope，HUD 与面板自己响应式刷新 ——
    // 场景**不再**手写 uiView.init(ctx) / unInit()：内嵌 UI 的生命周期由 Cocos 回调 + scope 驱动
    // 选英雄：抽本局候选 + 开面板（候选池、刷新费用与广告额度都在 HeroSelect 里，本场景只调一次入口）
    this.heroSelect.startRun()
    // 阶段/剩余时间改为写 store，UI 通过响应式 watch 订阅（单一来源，替代 BATTLE_REMAINTIME 事件）
    this.battleStore.phase = this.stage
    this.battleStore.phaseRemainTime = this.stageRemainTime
    this.battleStore.phaseTotalTime = this.stageDuration(this.stage)

    // 遗物入口按钮：绑定放 show（每次开局都重绑一次，先 off 再 on 保证幂等），close 里成对摘掉
    this.offNodeEvent(this.relicBtnNode, Button.EventType.CLICK, this.openRelicPanel, this)
    this.relicBtnNode?.on(Button.EventType.CLICK, this.openRelicPanel, this)
  }

  /** 入口按钮点击 → 交给 RelicShop 开面板（节点显隐由 applyRelicPanelVisible 统一写） */
  openRelicPanel(): void {
    this.relicShop?.open()
  }

  /**
   * 技能槽的锁图标被点：**真源在 `SkillSlots`，只有本场景能改**（格子组件只上报下标）。
   *
   * 被拒的情形（槽 0 = 英雄专属技能，按设计稿永久锁定）→ 飘字告诉玩家为什么点不动，
   * 而不是静默无反应 —— 「点不动又不说」是最容易被当成 bug 的交互。
   */
  private toggleSkillSlotLock(index: number): void {
    if (!this.skillSlots) return;
    if (this.skillSlots.toggleLock(index)) return;
    if (index === 0) this.uiView?.showFloatText('英雄专属技能槽不可解锁');
  }

  close() {
    EventBus.off(EventNames.BATTLE_EXIT);
    // 遗物入口按钮事件成对摘掉（本组件自己的节点事件，不涉及别的组件）
    this.offNodeEvent(this.relicBtnNode, Button.EventType.CLICK, this.openRelicPanel, this);
    // 这里不用再通知 HUD：close 只会把节点 active=false（scope 随 onDisable 暂停），
    // 真销毁时 UIWidget.onDispose 会自己摘节点事件
  }

  start(): void {
    // 空实现（BaseView 约定）
  }

  /**
   * 离开战斗、回主界面（HUD 的退出按钮，以及结算面板的「确定」都走这里）。
   *
   * 两件事：**清战斗残留**（池里的节点/预制件引用）→ 回菜单。
   * ⚠ 不调 `endRun()`：**中途退出不算一次对局结束**（不上报任务进度、不写 recordGameEnd、不弹面板）。
   * 想让"退出即结算"就把 `endRun('defeat','quit')` 加在这里 —— 但注意那会改变任务进度的口径
   *（「完成 N 局」这类任务会把中途退出也算一局）。
   */
  exit() {
    // 退出副本：先把打击反馈的位移归零并退订（否则残留偏移会跟着场景一起被销毁前的最后一帧画出去）
    this.hitFeel?.unbind();
    this.hitFeel = null;
    // 印痕层同理：退订 + 清掉画面上的印痕（节点保留，下次进战斗时 ensureHitVfxLayer 会重新 bind）
    this.hitVfx?.unbind();
    // 屏幕层同理（角标/连击/落款/奖励都是"这一局"的，别带回主界面）
    this.hitScreen?.unbind();
    // 点选层同理：摘触摸 + 清选中环（回主界面时草地上不该留着一个锁定框）
    this.targetPicker?.unbind();
    this.manualTarget = null;
    this.applyBattleShake(0, 0);
    // 复活面板：中途退出/结算退回主界面时也要收掉（它是**全屏遮罩**，留着会挡住整个主界面）
    this.revivePending = false;
    this.revivePrompt?.hide();
    // 退出副本：先卸载预制件缓存（节点池清空 + resources 引用释放）
    this.monsterPool?.releasePrefabs();
    this.projectilePool?.releasePrefabs();
    this.finished = true;   // 停止本局推进（update 的守卫）；真正的结束收口见 endRun

    UIManager.ins.showUI(Scene_Menu);
  }

  onDestroy(): void {
    // 打击反馈导演只是退订 + 清计时器（纯 TS，不碰节点）
    this.hitFeel?.unbind();
    this.hitFeel = null;
    // 印痕层：**这里不调 unbind()**（它会 clear 画布，而画布可能已被销毁 → 抛异常会堵死引擎销毁队列）。
    // 退订由 HitVfxLayer.onDestroy 自己做；这里只断引用。
    this.hitVfx = null;
    // 屏幕层同上（不碰画布，onDestroy 里自己退订）
    this.hitScreen = null;
    if (this.ctx) this.ctx.bus.clear();
    // 必须调 super：UIComponent.onDestroy 负责 scope.dispose()（撤 provide / 停 watcher / 清局部事件）
    // 与绑定清理 —— 少了它，本场景 provide 出去的键与 watcher 都不会回收
    super.onDestroy();
  }

  /* ===================================================================
   * 初始化（对应 GameManager.init）
   * =================================================================== */

  private resetRun(): void {
    this.elapsed = 0;
    this.stage = 0
    this.stageRemainTime = this.stageDuration(0)
    this.finished = false;
    this.victory = false;
    this.killCount = 0;
    // 换局：成就的「本局未受伤」标记清零（受击订阅会重新置位）
    this.tookDamage = false;
    // 换局：最终 Boss 引用作废（旧 ctx 的实体）
    this.finalBoss = null;

    // 换局：上一局的英雄实体**必须一并作废**（本函数是全项目唯一的换局入口）。
    //   ① 逻辑侧：`hero` 不清 → `update` 的守卫（`!this.hero` 早退）形同虚设，而上一局阵亡的英雄
    //      `IsDead()` 恒为 true → **新一局第一帧**就命中那条兜底断言 → `endRun('defeat','hero_dead_fallback')`
    //      → 结算面板立刻又弹出来（表现：「点确定退出后再进游戏，显示的是上一次的结算页面」），
    //      而且顺带多记一次对局结算（reportRunTasks 会再跑一遍：完成对局 +1）。
    //      上一局是胜利（英雄还活着）时不会弹面板，但会带着旧英雄一路 `tick`，同样不对。
    //   ② 表现侧：解绑 hero 节点的受击订阅（节点保留，等 selectHero 重新 bind）——
    //      顺带保证 selectHero 里 `if (hero.entity) RemoveEntity(...)` 不会去动**别的 ctx** 的实体。
    //   清掉之后不变式成立：`hero` 要么是 null，要么属于当前 `ctx`。
    this.hero = null;
    this.heroNode?.getComponent(Hero)?.unbind();

    // this.monsters = [];
    // 开局热身：先安静 SPAWN_WARMUP_SEC 秒再刷第一批（不做的话选完英雄当场就挨一波）
    this.spawnTimer = SPAWN_WARMUP_SEC
    // 批计数（只用于日志）
    this.waveCount = 0
    // 闪电战成就：最终 Boss 的出现时刻作废（新一局重新记）
    this.finalBossSpawnElapsed = -1

    this.battleStore.reset();
    // ── 本局难度（难度选择弹窗「确定」时落盘）──
    //   ⚠ 必须写在 `battleStore.reset()` **之后**：reset 会把 difficulty 归 1，
    //     写在前面会被它吃掉（表现就是"HUD 永远显示难度 1"）。
    //   读一次、本局全程不变；顺带记「上次玩过」给主界面用。
    this.difficulty = DataCenter.ins.levelData.getSelectedLevel();
    DataCenter.ins.levelData.markPlayed(this.difficulty);
    this.battleStore.difficulty = this.difficulty;
    console.log(`[难度] 本局难度：${describeLevel(this.difficulty)}`);
    // ── 本局模式（主界面模式卡「点一下就落盘」，与难度同一个读法）──
    //   同样必须写在 `battleStore.reset()` 之后（reset 会把它归默认）。
    //   ⚠ 目前**只做投影 + 日志**：无尽模式还没有自己的局内规则（见 GameModeConfig 文件头），
    //     要分岔就在 `checkStage` 一处按 `this.battleStore.mode` 走（别在别处零散判模式）。
    this.battleStore.mode = DataCenter.ins.levelData.getMode();
    console.log(`[模式] 本局模式：${gameModeName(this.battleStore.mode)}`);
    // 换局：三个功能的界面状态整体复位（面板收起、槽位清空、抽数与广告次数归零）——规则在功能类里
    this.heroSelect?.reset();
    this.relicShop?.reset();
    this.buffShop?.reset();
    // 换局：技能槽整体复位（技能清空、只剩槽 0 锁定）；技能本身随英雄实体一起重建
    this.skillSlots?.reset();
    // 换局：Boss 调度复位（库存清空、守卫回到 2 只、CD 归位、守卫击杀数归零 → 加码撤销）
    this.bossScheduler?.reset();
    this.lastRelicBagKey = '';
    // 换局：复活名额复位（**每局** `battle_constants.reviveAdPerRun` 次；背包里的复活券不受影响），
    //   同时把上一局可能还开着的复活面板收掉 —— 否则新一局开局就顶着一块全屏遮罩
    this.adRevivesLeft = BattleConstUtil.getReviveAdPerRun();
    this.revivePending = false;
    this.revivePrompt?.hide();
    // 换局：普攻锁定目标随战斗上下文作废（避免指向上一局的实体）
    this.attackTarget = null;
    // 换局：战斗事件要在新 ctx 上重新订阅（旧 ctx 的 bus 随旧上下文一起丢弃）
    this.eventsBound = false;
    // 换局：初始金币播种 / 开局英雄等级的「只做一次」标记复位（新一局要重新播一次）
    this.initialGoldSeeded = false;
    this.startLevelApplied = false;
    this.lastSkillKey = '';
    this.lastShownSec = -1;
    // 换局：遗物背包属于「这一局」——旧 ctx 已作废，必须重建（同一局内换英雄才复用，见 selectHero）
    this.heroRelics = null;
    // 清理怪物池（场景重开：隐藏并销毁池中节点，复用逻辑实体清空）
    this.monsterPool?.Clear();
    this.projectilePool?.Clear();
    // 飘字层整场清空（节点保留复用，只退订 + 回收飘字；下一局 initBattle 里重新 bind）
    this.damageText?.unbind();
    // 印痕层（B2）同理：退订 + 回收在场印痕/碎片（否则上一局打了一半的印痕会留在新一局画面上）
    this.hitVfx?.unbind();
    // 屏幕层（B3）同理：退订 + 清掉角标/连击/落款/奖励（否则新一局一开场就顶着上一局的连击数）
    this.hitScreen?.unbind();
    // 点选层同理：摘触摸 + 清标记（否则上一局的选中环会留在新一局的草地上）；
    // 手动锁定目标随战斗上下文作废（下一局 initBattle 里重新 bind）
    this.targetPicker?.unbind();
    this.manualTarget = null;
    // 打击反馈：退订旧 ctx 的总线 + 清掉计时器，并把**位移归零** ——
    // 否则上一局抖到一半的偏移会留在屏幕上（下一局 initBattle 会重新建导演、重采基准位置）
    this.hitFeel?.unbind();
    this.hitFeel = null;
    this.applyBattleShake(0, 0);
    this.ctx = null;
  }

  /**
   * 创建 BattleContext（配置由 TbRoot 管线在 Main.start 已加载，见 Tb_*Config.ts）
   */
  private initBattle(): void {
    this.ctx = new BattleContext();
    this.monsterPool = new MonsterPool(this.ctx, this.monsterParent, this.monsterCacheParent);
    // 难度缩放钩子：**池子自己不知道"难度"是什么**，只负责在每次取出实体后回调一下 ——
    // 这样"每一只怪都被缩放过"是结构保证的（刷小怪 / 阶段 Boss / 调度放出的 Boss 三条路共用一个 acquire）。
    // ⚠ 对象池复用（EntityPool）会在每次 acquire 时按配置 `Reinit` 重置基础属性，
    //   所以倍率**必须每次乘**，不能只乘一次（只乘一次的话第二只同 id 的怪就没加成）。
    this.monsterPool.statScaleHook = (entity, kind) => this.applyDifficultyScale(entity, kind);
    this.projectilePool = new ProjectileViewPool();
    // 飘伤害字层：整场一个中央层（层级在预制件里摆好：enimys/hero/弹道之上、UI 之下）
    // 第二个参数 = 参照节点：飘字不做坐标转换，靠"层节点与 monsterParent 同坐标系"这个契约，这里用于自检
    this.ensureDamageTextLayer().bind(this.ctx, this.monsterParent);

    // 打击反馈导演（B1）：顿帧 / 慢动作 / 内容层位移 / 预算账本。
    // 必须排在飘字层 bind **之后** —— 位移层的清单里含飘字层节点，且采基准位置时它的 position 必须还是 (0,0)
    // （DamageTextLayer.checkSpace 会在 bind 时自检坐标系，先位移再 bind 会误报）。
    this.hitFeel = new HitFeelDirector();
    this.hitFeel.bind(this.ctx);

    // 音效（B4）：导演只回答"该不该响 / 响哪一个 / 多大声"，**播放**交给平台层
    // —— 用回调注入是为了让导演保持"纯 TS 无 cc 依赖"（它现在能被 `audit:hitfeel` 真跑就靠这条）。
    // 顺带预加载本局会用到的全部音效键：`playSFX` 是"先加载再播"，第一次命中才加载会明显晚半拍。
    // ⚠ `playSFX` / `preloadSfx` 都是 async：这里**必须吞掉异常**（缺文件、平台不支持音频都只是"没声音"，
    //   绝不能变成一个未处理的 Promise 拒绝把渲染循环搅乱 —— 音效是可有可无的东西）。
    this.hitFeel.sfxPlayer = (key, volume) => {
      AudioMgr.ins.playSFX(key, volume).catch((e) => console.warn('[打击反馈] 音效播放失败：' + key, e));
    };
    AudioMgr.ins.preloadSfx(hitFeelSfxKeys()).catch((e) => console.warn('[打击反馈] 音效预加载失败', e));

    // 图纸印痕层（B2）：刻度 / 细环 / 对位十字 / 死亡碎片 / 起手虚线（整层一个 Graphics）。
    // 同样必须排在 collectShakeTargets **之前** —— 它也是参与位移的战斗内容层。
    // 它读密度系数 k 走 HitFeelDirector.active，所以必须排在导演 bind 之后。
    this.ensureHitVfxLayer().bind(this.ctx, this.monsterParent);

    // 屏幕层（B3）：墨闪 / 边缘角标 / 连击 / 落款 / 奖励飞入。
    // ⚠ **不进 collectShakeTargets** —— 屏幕信息不参与内容层位移（见 HitScreenLayer 类注释）。
    // 奖励落点用闭包现算（HUD 位置由 Widget 布局决定，缓存会在换分辨率后指错）。
    this.ensureHitScreenLayer().bind(this.ctx, { rewardAnchor: () => this.resolveRewardAnchor() });

    // 点选层（点击怪物切换普攻目标）：把"点了一下"交给本场景判（`onFieldTap`），并按需画选中标记。
    // ⚠ 必须排在 `collectShakeTargets()` **之前** —— 标记要跟怪一起晃（同偏移，见那里的注释）。
    this.ensureTargetPicker().bind(this.monsterParent, (x, y) => this.onFieldTap(x, y));

    this.collectShakeTargets();
    this.applyBattleShake(0, 0);

    // 注册脚本逃逸口（闪电链等代码类技能 / 鹰眼·反击·雷核·爆头等代码类 Modifier）
    this.ctx.scriptRegistry.registerClass('Ability_LightningChain', Ability_LightningChain);
    this.ctx.scriptRegistry.registerClass('Modifier_EagleEye', Modifier_EagleEye);
    this.ctx.scriptRegistry.registerClass('Modifier_CounterStorm', Modifier_CounterStorm);
    this.ctx.scriptRegistry.registerClass('Modifier_ZeusThunder', Modifier_ZeusThunder);
    this.ctx.scriptRegistry.registerClass('Modifier_MusketHeadshot', Modifier_MusketHeadshot);

    // 肉鸽商店技能（abilities.json scope='shop'，id 101~130）的脚本 Modifier
    // —— 清单在 battle/ShopSkillModifiers.ts 的 SHOP_SKILL_SCRIPT_CLASSES 里，
    //    加技能只改那张表；漏注册会在运行时静默降级成普通 Modifier（技能"抽到了却没效果"），
    //    所以 npm run audit:skill 有一条断言专门盯 script_id ↔ 注册表。
    // 注意：不要用 Object.entries —— tsconfig 的 lib 目标是 ES2015，ObjectConstructor 上没有它
    for (const name of Object.keys(SHOP_SKILL_SCRIPT_CLASSES)) {
      this.ctx.scriptRegistry.registerClass(name, SHOP_SKILL_SCRIPT_CLASSES[name]);
    }

    // 局内遗物钩子（modifiers.json id 200~239 的脚本行，一条钩子一行）的脚本 Modifier
    // —— 清单在 battle/RelicHooks.ts 的 RELIC_HOOK_SCRIPT_CLASSES 里；
    //    同样漏注册会静默降级成普通 Modifier（遗物"拿到了却没效果"），
    //    生成器侧 `npm run gen:relic-design` 与落表脚本都按 impl 名对齐，别手改类名。
    for (const name of Object.keys(RELIC_HOOK_SCRIPT_CLASSES)) {
      this.ctx.scriptRegistry.registerClass(name, RELIC_HOOK_SCRIPT_CLASSES[name]);
    }

    // 注册怪物 AI（chase/wander/orbit/attack_stop/boss）
    initializeAI();

    // 战斗常量刷新（battle_constants.json）
    BattleConstUtil.markLoaded();

    // 预加载本局所有可能用到的预制件（怪物 + 弹道），避免战斗中首帧卡顿
    // this.preloadBattleAssets();

    // console.log('[战斗] BattleContext 就绪，单位配置数:', this.ctx.unitContainer.size);
  }

  /**
   * 取（必要时创建）飘伤害字层。
   *
   * 三级取用顺序（都不需要改代码）：
   *   ① `damageLayerNode` 上挂着 DamageTextLayer（编辑器摆好层级：压在 enimys/hero/弹道之上）——
   *      **推荐**，层级由美术/策划在预制件里决定；
   *   ② 没拖引用，但预制件子树里已经有 DamageTextLayer 组件 → 直接用（防手滑漏拖）；
   *   ③ 都没有 → 运行时建一个节点挂在 monsterParent 最后一个子节点（与怪物同父、压在怪物之上）。
   *
   * ⚠ **坐标系契约**：飘字按逻辑坐标直接绘制、**不做坐标转换**（EntityView.bind 是直接
   *   node.setPosition(entity.position)，即 monsterParent 的局部空间 == 逻辑世界坐标），
   *   所以 ①② 的层节点必须与 monsterParent **同坐标系** —— 预制件里 `damege_layer` 与 `enimys`
   *   同为场景根子节点、position 都是 (0,0)、缩放都是 1，正好满足。改层级时只要别动它的
   *   position/scale 就行（bind 里有自检，挪了会打警告）；③ 建的节点与参照节点同父同变换，天然满足。
   *
   * ⚠ ③ 的路径 `new Node()` 的 layer 默认不是 UI_2D（UI 相机会看不到），必须显式继承父节点 layer。
   */
  private ensureDamageTextLayer(): DamageTextLayer {
    if (this.damageText && this.damageText.node?.isValid) return this.damageText;

    let layer: DamageTextLayer | null = null;
    // ① 编辑器里挂好的（引用 + 组件都在）
    if (this.damageLayerNode?.isValid) {
      layer = this.damageLayerNode.getComponent(DamageTextLayer)
        ?? this.damageLayerNode.addComponent(DamageTextLayer);
    }
    // ② 兜底：整个预制件子树里已有 DamageTextLayer
    if (!layer) layer = this.node.getComponentInChildren(DamageTextLayer);
    // ③ 兜底：运行时建一个，挂在怪物层最后
    if (!layer) {
      const node = new Node('damage_text');
      node.layer = this.monsterParent.layer;
      this.monsterParent.addChild(node);
      layer = node.addComponent(DamageTextLayer);
    }

    this.damageText = layer;
    return layer;
  }

  /**
   * 取（必要时创建）图纸印痕层（B2）。
   *
   * 三级取用顺序（都不需要改代码）：
   *   ① 根下已有名为 `vfx` 的节点（美术/策划在预制件里摆层级）→ 取它，缺组件就补上；
   *   ② 没有该节点，但预制件子树里已经有 HitVfxLayer 组件 → 直接用（防手滑改节点名）；
   *   ③ 都没有 → 运行时建一个节点，并**插到 `damage_layer` 之前**（压在 `projectile_cache` 之上、
   *      飘字与 HUD 之下）。
   *
   * ⚠ 为什么 ③ 必须插在 `damage_layer` 之前，而不是像飘字层那样 `addChild` 到最后：
   *   根下的最后一个子节点是 `ctlrs_right`（HUD）—— 追加到末尾会让印痕**盖在 HUD 面板上**。
   *
   * ⚠ 坐标系契约与飘字层完全一致（见 DamageTextLayer 的类注释）：印痕按逻辑坐标直接绘制、
   *   **不做坐标转换**，靠"层节点与 monsterParent 同坐标系"保证位置正确。预制件里所有战斗内容层
   *   都是根下兄弟、position (0,0)、scale 1，正好满足；改层级时别动它的 position/scale
   *   （bind 里有自检，挪了会打警告）。
   *
   * ⚠ ③ 的 `new Node()` 的 layer 默认不是 UI_2D（UI 相机会看不到），必须显式继承参照节点的 layer。
   */
  private ensureHitVfxLayer(): HitVfxLayer {
    if (this.hitVfx && this.hitVfx.node?.isValid) return this.hitVfx;

    let layer: HitVfxLayer | null = null;
    // ① 编辑器里摆好的 vfx 节点
    const vfxNode = this.node.getChildByName(HIT_VFX_NODE_NAME);
    if (vfxNode?.isValid) layer = vfxNode.getComponent(HitVfxLayer) ?? vfxNode.addComponent(HitVfxLayer);
    // ② 兜底：整个预制件子树里已有 HitVfxLayer
    if (!layer) layer = this.node.getComponentInChildren(HitVfxLayer);
    // ③ 兜底：运行时建一个，插在 damage_layer 之前（不要追加到最后 —— 最后是 HUD）
    if (!layer) {
      const node = new Node(HIT_VFX_NODE_NAME);
      node.layer = this.monsterParent?.layer ?? this.node.layer;
      this.node.addChild(node);
      const anchor = this.damageLayerNode?.isValid ? this.damageLayerNode : null;
      // 没有 damage_layer 引用时退一步：插在**最后一个子节点之前**（当前预制件里最后一个是
      // `ctlrs_right` = HUD）。留在这个位置最坏也只是压在别的战斗层上，绝不会盖住 HUD。
      node.setSiblingIndex(anchor ? anchor.getSiblingIndex() : Math.max(0, this.node.children.length - 2));
      layer = node.addComponent(HitVfxLayer);
    }

    this.hitVfx = layer;
    return layer;
  }

  /**
   * 取（必要时创建）屏幕层（B3）。
   *
   * 三级取用（与 `ensureHitVfxLayer` 同一套路）：
   *   ① 根下已有名为 `screen_vfx` 的节点 → 取它，缺组件就补上；
   *   ② 没有该节点，但子树里已有 HitScreenLayer 组件 → 直接用；
   *   ③ 都没有 → 运行时建一个节点，插在 **HUD（`uiViewNode`）之前**。
   *
   * ⚠ ③ 的位置很关键：屏幕层必须**画在 HUD 下面**（奖励飞过去时要"钻进"HUD 里消失），
   *   而不是 `addChild` 到最后（那会盖在 HUD 面板上）。
   */
  private ensureHitScreenLayer(): HitScreenLayer {
    if (this.hitScreen && this.hitScreen.node?.isValid) return this.hitScreen;

    let layer: HitScreenLayer | null = null;
    const exist = this.node.getChildByName(HIT_SCREEN_NODE_NAME);
    if (exist?.isValid) layer = exist.getComponent(HitScreenLayer) ?? exist.addComponent(HitScreenLayer);
    if (!layer) layer = this.node.getComponentInChildren(HitScreenLayer);
    if (!layer) {
      const node = new Node(HIT_SCREEN_NODE_NAME);
      node.layer = this.monsterParent?.layer ?? this.node.layer;
      this.node.addChild(node);
      const hud = this.uiViewNode?.isValid ? this.uiViewNode : null;
      node.setSiblingIndex(hud ? hud.getSiblingIndex() : Math.max(0, this.node.children.length - 1));
      layer = node.addComponent(HitScreenLayer);
    }

    this.hitScreen = layer;
    return layer;
  }

  /**
   * 取（必要时创建）点选层（点击怪物切换普攻目标）。
   *
   * 三级取用（与 `ensureHitVfxLayer` / `ensureHitScreenLayer` 同一套路，零配置可用）：
   *   ① 根下已有名为 `target_picker` 的节点 → 取它，缺组件就补上；
   *   ② 没有该节点，但子树里已有 TargetPicker 组件 → 直接用（防手滑改节点名）；
   *   ③ 都没有 → 运行时建一个，随后统一把层级坐实到 `enimys` 之前。
   *
   * ⚠ 层级是本功能的**功能需求**，不是美术偏好，两头都不能错：
   *   · 必须在 **HUD 之前**（`uiViewNode` 之前）—— 2D 手势派发按"同父兄弟下标更大者先"，
   *     谁先命中谁把这次触摸认领掉；排到 HUD 之后就会**点 HUD 按钮顺带改目标**；
   *   · 必须在 **怪之下**（`enimys` 之前）—— 选中环是"圈在地上的锁定框"，压住怪或压住飘字都不对。
   *   落到 `enimys` 的下标上正好同时满足这两条（bg → 点选层 → enimys → … → HUD）；
   *   所以本函数会把"排在怪之后"的节点挪回来（已在它之前的原样不动）。
   *
   * ⚠ 坐标系契约与印痕层一致：层节点与 `monsterParent` 同父、局部变换 (0,0)/1，
   *   所以标记可以直接按 `entity.position` 画；bind 里做一次自检（见 TargetPicker.checkSpace）。
   */
  private ensureTargetPicker(): TargetPicker {
    if (this.targetPicker && this.targetPicker.node?.isValid) return this.targetPicker;

    let picker: TargetPicker | null = null;
    const exist = this.node.getChildByName(TARGET_PICKER_NODE_NAME);
    if (exist?.isValid) picker = exist.getComponent(TargetPicker) ?? exist.addComponent(TargetPicker);
    if (!picker) picker = this.node.getComponentInChildren(TargetPicker);
    if (!picker) {
      const node = new Node(TARGET_PICKER_NODE_NAME);
      node.layer = this.monsterParent?.layer ?? this.node.layer;
      this.node.addChild(node);
      picker = node.addComponent(TargetPicker);
    }

    // 层级**坐实**（不是"摆过一次就算"）：本层的输入正确性依赖兄弟下标，所以不接受它排在怪之后 ——
    // 已在 `enimys` 之前的（美术在预制件里摆好的）不动，在它之后的（含刚 addChild 到末尾的）
    // 统一提到 `enimys` 的下标上（那时 enimys 顺势后移一位，点选层正好落在它前面）。
    const under = this.monsterParent?.isValid ? this.monsterParent : null;
    const layerNode = picker.node;
    const mount = under ? under.getSiblingIndex() : 1;
    if (layerNode.parent === this.node && layerNode.getSiblingIndex() > mount) {
      layerNode.setSiblingIndex(mount);
    }

    this.targetPicker = picker;
    return picker;
  }

  /**
   * 奖励飞入的落点（F9）：把 HUD 上金币 / 经验数字的位置换算到**屏幕层的局部坐标**。
   *
   * 为什么需要换算：屏幕层与 HUD 都是预制件根的直接子节点（局部空间重合），但 HUD 内部
   * 还有若干层嵌套节点（`head/money/gold/value`…），数字节点的**世界位置**只有经过
   * `convertToNodeSpaceAR` 才能落到屏幕层的局部空间里。**每次击杀现算**（不缓存）——
   * 缓存会在换分辨率 / 改布局之后指到错的地方，而"飞错地方"比"不飞"更糟。
   *
   * 任何一环缺失都返回 null → 屏幕层退化成"朝右上飞一小段"（**绝不静默不画**）。
   */
  private resolveRewardAnchor(): HitScreenAnchor | null {
    const layerNode = this.hitScreen?.node;
    const ui = this.uiView;
    if (!layerNode?.isValid || !ui) return null;
    const trans = layerNode.getComponent(UITransform);
    if (!trans) return null;
    const toLocal = (n: Node | null | undefined): { x: number; y: number } | null => {
      if (!n?.isValid) return null;
      const p = trans.convertToNodeSpaceAR(n.worldPosition);
      return { x: p.x, y: p.y };
    };
    return {
      gold: toLocal(ui.money_gold_value?.node),
      exp: toLocal(ui.lv__exp_value?.node),
    };
  }

  /* ===================================================================
   * 打击反馈（B1）：战斗内容层位移
   *
   * 只有一个 UI 相机（Main > Canvas > Camera），所以**不做相机震屏** ——
   * 动相机会把 HUD 一起抖，正解是位移"战斗内容层"。
   * =================================================================== */

  /**
   * 参与位移的层（**连带记录基准位置**：位移永远写"基准 + 偏移"，绝不相对累加）
   *
   * 为什么是这几层、以及为什么必须**同偏移**：
   *   · `damage_layer`（飘字层）与 `enimys` 在预制件里是同父兄弟、局部变换相同 ——
   *     只位移其中一个会让飘字与实体**错位**（飘字按逻辑坐标直接绘制、不做坐标转换，见 DamageTextLayer）。
   *   · `vfx`（印痕层，B2）同理：它也在同一坐标系里按逻辑坐标直接绘制，**必须跟同样的偏移**。
   *   · `target_picker`（点选层）同理：选中标记贴着怪画，不同偏移就会在震屏那一帧跟怪脱开。
   *   · `bg-001` 是满屏 Sprite：位移它没有观感收益，只会在边缘露底。
   *   · `hero` / 其子节点 `range`（射程圈）不参与：英雄是固定锚点，射程圈必须与真实判定圈一致。
   *   · HUD（`ctlrs_right` 那一支）不参与。
   */
  private shakeTargets: { node: Node; bx: number; by: number }[] = [];
  /** 上一次写出去的位移（脏检查：没变就不写节点，省 transform 重算） */
  private lastShakeX = Number.NaN;
  private lastShakeY = Number.NaN;

  /** 收集位移层并记录基准位置（initBattle 里调；可反复调用 —— 每次重新采基准） */
  private collectShakeTargets(): void {
    const nodes = [
      this.monsterParent,
      this.projectileParent,
      this.projectileCacheParent,
      this.hitVfx?.node ?? null,
      this.damageText?.node ?? null,
      this.targetPicker?.node ?? null,
    ];
    this.shakeTargets = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n && n.isValid) this.shakeTargets.push({ node: n, bx: n.position.x, by: n.position.y });
    }
    // NaN 与任何数都不相等 → 强制下一帧写一次，把基准位置坐实
    this.lastShakeX = Number.NaN;
    this.lastShakeY = Number.NaN;
  }

  /**
   * 把位移写到全部战斗内容层（**基准 + 偏移**）
   *
   * ⚠ 这不是"逻辑位移"：`Entity.ApplyKnockback` 改的是 `entity.position`（持久、影响 AI 与索敌），
   *   而这里改的是**层节点**的 position（瞬时、每帧重算），两者不要混。
   */
  private applyBattleShake(x: number, y: number): void {
    if (x === this.lastShakeX && y === this.lastShakeY) return;
    this.lastShakeX = x;
    this.lastShakeY = y;
    for (let i = 0; i < this.shakeTargets.length; i++) {
      const t = this.shakeTargets[i];
      if (!t.node?.isValid) continue;
      t.node.setPosition(t.bx + x, t.by + y);
    }
  }

  /* ===================================================================
   * 每帧更新（对应 GameManager.tick）
   * =================================================================== */

  update(deltaTime: number): void {
    if (this.battleStore.isPaused) {
      // 暂停：战斗时间不推进，但**位移必须归零** —— 否则画面会停在"抖到一半"的位置上
      this.applyBattleShake(0, 0)
      return
    }

    if (!this.ctx || this.finished || !this.hero) {
      // 尚未开局或已结束：同理把位移归零，别把上一局的偏移留在屏幕上
      this.applyBattleShake(0, 0)
      return;
    }
    // 兜底断言（**不是第二套判据**）：正常路径是英雄阵亡那一刻 `OnDeath → endRun('defeat')`，
    // 本局立刻就结束了。这里只防"事件漏了 → 带着死英雄继续刷怪推进阶段"这种卡死态；
    // 命中说明事件链有问题，所以打 warn 而不是静默处理。
    if (this.hero.IsDead()) {
      ezgame.warn('[战斗] 英雄已阵亡但本局未结束，走兜底结束（检查 OnDeath 订阅）');
      this.endRun('defeat', 'hero_dead_fallback');
      return;
    }

    // ── 打击反馈（B1）：先让导演提交**上一帧**命中累积的表现，产出本帧的 timeScale 与位移 ——
    //    必须排在 `ctx.Tick` 之前（时间缩放要先于推进传进去，位移要先于渲染写出去）。
    //    dt 先过掉帧守卫（钳到 [1ms, 50ms]，见 HitFeelConfig 的 BUDGET.dtMinSec 注释）。
    const dtReal = clampBattleDt(deltaTime)
    this.hitFeel?.tick(dtReal)
    this.applyBattleShake(this.hitFeel?.shakeX ?? 0, this.hitFeel?.shakeY ?? 0)

    // ⚠ 阶段倒计时 / 刷怪 / elapsed 一律走**真实 dt**（`deltaTime`，不钳不缩）：
    //   顿帧只冻结战斗实体（ctx.Tick），**不冻结阶段时钟** —— 否则就是"全局变慢"，
    //   而刷怪节奏按 elapsed 索引 SPAWN_BEATS、成就「闪电战」也按 elapsed 判定，会静默改难度曲线。
    this.checkStage(deltaTime);
    // checkStage 可能刚好结束了本局（Boss 阶段倒计时归零）→ 这一帧不再推进战斗
    if (this.finished) {
      this.applyBattleShake(0, 0)
      return;
    }
    this.tick(deltaTime, dtReal * (this.hitFeel?.timeScale ?? 1));
    // 点选索敌的每帧维护（失效即解除 + 把选中环画到它身上）——
    // 排在 `tick` **之后**：本帧死在 `ctx.Tick` 里的怪，到这一步已经被判为不可用并解除，
    // 不会带着死引用（以及回池后复位过的 position）进下一帧。
    // 早退分支（暂停 / 未开局 / 已结束）不调它：那些状态下目标与标记都不该变，
    // 而"已结束"那一条在 `endRun` 里已经把标记收掉了。
    this.tickManualTarget();
  }
  /** 上一次通知 UI 的整秒数：仅整秒变化时才广播，避免跳秒 */
  private lastShownSec = -1

  /**
   * 每个阶段的时长（秒）——**阶段时长的唯一来源**（UI 不再各自写死 300/120）。
   *   0 准备期 → config.prepareTime（默认 10s，选完英雄才开始倒计时）
   *   1~4 常规阶段 → config.stageTime（默认 60s）
   *   5 Boss 阶段 → config.bossTime（默认 60s）
   * 剩下多少时间由 checkStage 每秒投影到 store（UI 用 remain/total 画进度条）。
   */
  private stageDuration(stage: number): number {
    const cfg = this.config
    if (stage <= 0) return cfg?.prepareTime ?? this.prepareRemainTime;
    if (stage >= FINAL_BOSS_STAGE) return cfg?.bossTime ?? cfg?.stageTime ?? 60;
    return cfg?.stageTime ?? 60;
  }

  checkStage(deltaTime: number) {
    this.stageRemainTime -= deltaTime
    this.stageRemainTime = this.stageRemainTime < 0 ? 0 : this.stageRemainTime
    // 只在整秒变化时通知 UI（ceil：9.7s 显示 10、9.0s 显示 9）→ 逐秒推进不跳秒
    // 到达 0 的瞬间会立即切阶段/结束，不播 00:00，避免闪现
    const shownSec = Math.ceil(this.stageRemainTime)
    if (shownSec !== 0 && shownSec !== this.lastShownSec) {
      this.lastShownSec = shownSec
      this.battleStore.phase = this.stage
      this.battleStore.phaseRemainTime = this.stageRemainTime
      this.battleStore.phaseTotalTime = this.stageDuration(this.stage)
    }
    if (this.stageRemainTime == 0) {
      if (this.stage == FINAL_BOSS_STAGE) {
        // boss 阶段超时未击杀 → 失败（结算 / 面板 / 回主界面全部由 endRun 收口）
        this.endRun('defeat', 'boss_timeout')
        return
      }
      this.spawnBoss(this.stage)
      //进入下一阶段
      const prevStage = this.stage
      this.stage++
      ezgame.info("进入阶段：", this.stage)
      // 阶段切换事件（2026-10 遗物重做新增）：遗物钩子「阶段契约」靠它叠层。
      // 只在**阶段号真的变了**之后发一次，且带上 from/to（钩子只关心"进了新阶段"）。
      this.ctx?.bus?.publish(BattleEvents.OnPhaseChanged, { from: prevStage, to: this.stage })
      this.stageRemainTime = this.stageDuration(this.stage)
      // 阶段切换要立刻通知 UI（不能等下一秒的整秒广播，否则进度条会先跳完再换字）
      this.lastShownSec = Math.ceil(this.stageRemainTime)
      this.battleStore.phase = this.stage
      this.battleStore.phaseRemainTime = this.stageRemainTime
      this.battleStore.phaseTotalTime = this.stageRemainTime
    }
    if (this.stage == 0) {

      return
    }
    this.elapsed += deltaTime;

    // 1. 刷怪计时（按 beat 表推进：数量与间隔都随 beat 爬升，见 SPAWN_BEATS）
    this.spawnTimer -= deltaTime;
    if (this.spawnTimer <= 0) {
      const alive = this.ctx.activeEntityCount() - 1; // 减英雄
      if (alive >= SPAWN_ALIVE_HARD) {
        // 硬阀门（性能保险丝）：本批不刷，但**只等一小会儿就重试** —— 不丢内容、不断收入
        this.spawnTimer = SPAWN_RETRY_SEC;
      } else {
        // 真的刷出来了才按 beat 间隔等；没刷出来（池/配置异常）也走短重试
        const spawned = this.spawnWave();
        this.spawnTimer = spawned ? this.getSpawnInterval() : SPAWN_RETRY_SEC;
      }
    }
  }
  spawnBoss(stage: number) {
    if (stage <= 0) return
    // 阶段 Boss / 最终 Boss 由「本次刷新属于进入哪个阶段」决定：
    // spawnBoss(stage) 在 stage 计时结束时调用（随后 stage++），
    // 所以进入 FINAL_BOSS_STAGE(=5) 时刷出的那只就是最终 Boss（缩放 ×2），其余为阶段 Boss（×1.5）。
    const kind = resolveBossKind(stage)
    const isFinal = kind === UnitKind.FinalBoss
    const defId = isFinal ? this.config.finalBossUnitId : this.config.stageBossUnitId
    if (!defId) {
      // 配置为 0 = 关闭该类 Boss 的刷新（美术/配表未就位时用）
      console.log(`刷新阶段boss:${stage}（${isFinal ? 'finalBossUnitId' : 'stageBossUnitId'} = 0，跳过）`)
      return
    }
    const def = this.ctx.getUnitDef(defId)
    if (!def) {
      console.warn(`[战斗] 未找到 Boss 单位配置: ${defId}`)
      return
    }

    // 从环形外侧入场（与刷怪同一圈层，Boss 体型更大、推距按缩放算，见 Entity.SetUnitKind）
    const boss = this.monsterPool.acquire(def, kind)
    const angle = Math.random() * Math.PI * 2
    const dist = this.config.spawnRadius[1]
    boss.position = {
      x: this.config.center.x + Math.cos(angle) * dist,
      y: this.config.center.y + Math.sin(angle) * dist,
    }
    // 最终 Boss 记引用：它阵亡 = 通关（判定在 bindBattleEvents 的 OnDeath 里）
    if (isFinal) {
      this.finalBoss = boss;
      // 成就「闪电战」的计时基准：最终 Boss **出现**的时刻（不是绝对用时，见字段注释）
      this.finalBossSpawnElapsed = this.elapsed;
    }
    console.log(`[战斗] 刷新${isFinal ? '最终' : '阶段'}Boss: ${def.name}（进入阶段 ${stage + 1}, ${kind}, 缩放 ${getUnitScale(kind)}）`)
  }

  /**
   * 单步推进（英雄AI → 弹道表现 → 核心Tick）。胜负不在这一层判，见 endRun
   *
   * @param dtReal  真实帧增量（**规则时钟**）：Boss 调度的充能/场上限时用它 ——
   *                那是"这一局的节奏预算"，不该被打击反馈的顿帧拖慢
   * @param dtCombat 战斗帧增量 = `dtReal × 打击反馈的 timeScale`（顿帧/慢动作就落在这一点上）：
   *                 只喂给 `ctx.Tick`（Modifier 计时 / DoT / 冷却 / 普攻冷却 / 弹道 / AI 移动）
   */
  private tick(dtReal: number, dtCombat: number): void {



    // 3. 英雄 AI（普攻索敌 + 自动施法）
    this.heroAI();



    // 5. 弹道表现：为新发射的弹道创建视图（命中回收由事件驱动）
    this.updateProjectiles();
    // 4. 推进核心战斗系统（Modifier 计时 / DoT / 冷却 / 普攻冷却 / 弹道）
    this.ctx.Tick(dtCombat);
    // 4.1 技能栏冷却投影：把 4 个槽的 CD 进度写给 UI（必须排在 ctx.Tick 之后，读到的是本帧的冷却）
    this.skillSlots?.tick();
    // 4.2 Boss 调度：充能 / 场上限时。**排在 ctx.Tick 之后** —— 限时到期的回收要发生在
    //     本帧的战斗推进结束之后，否则会在遍历实体表的过程中改集合
    this.bossScheduler?.tick(dtReal);

    // 6. 商店：遗物被动的独立冷却由 ModifierSystem 随 ctx.Tick 一起推进，无需额外处理
    // this.shopTimer -= dt;
    // if (this.shopTimer <= 0) {
    //   this.openShop();
    //   this.shopTimer = this.config.shopEvery;
    // }

    // 7. 胜负判定：**不在这里**（原 checkEnd 每帧轮询已删除）—— 结束是瞬时事件，
    //    统一由 `endRun()` 收口，触发点见 endRun 的注释
  }

  /**
   * 弹道表现管理：
   *   - 遍历 ctx.projectiles，为还没有视图的弹道创建 ProjectileView
   *   - 预制件路径从配置读取：
   *       普攻弹道 → 单位配置 unitDef.attack_projectile_prefab
   *       技能弹道 → 技能配置 abilityDef.projectile_prefab
   *       两者都未配置 → 兜底 DEFAULT_PROJECTILE_PREFAB（projectile_1）
   *   - 命中/落空的弹道已从 ctx.projectiles 移除，视图回收由
   *     OnProjectileHit / OnProjectileMiss 事件驱动（见 bindBattleEvents）
   */
  private updateProjectiles(): void {
    if (!this.ctx || !this.projectilePool) return;
    for (const p of this.ctx.projectiles) {
      if (p.view) continue; // 已有视图
      const prefabPath = this.resolveProjectilePrefab(p);
      if (!prefabPath) continue;
      this.projectilePool.acquire(p, prefabPath, this.projectileParent, (view) => {
        p.view = view; // 视图绑定到逻辑弹道（回收事件靠它）
      });
    }
  }

  /** 解析弹道预制件路径（配置驱动：优先单位普攻弹道，其次技能弹道，都缺省则用兜底预制件） */
  private resolveProjectilePrefab(p: any): string | null {
    // 普攻弹道（isAttack=true）→ 攻击者单位配置
    if (p.isAttack) {
      const src = p.source;
      // source 可能是 Entity；其 id 是单位配置 id
      if (src?.id !== undefined) {
        const def = this.ctx?.getUnitDef(src.id);
        if (def?.attack_projectile_prefab) return def.attack_projectile_prefab;
      }
      // 兜底：单位未配弹道预制件 → 默认弹道
      return DEFAULT_PROJECTILE_PREFAB;
    }
    // 技能弹道 → 技能配置
    const ability = p.ability;
    if (ability?.def?.projectile_prefab) return ability.def.projectile_prefab;
    // 兜底：技能未配弹道预制件 → 默认弹道（不再按 ability_{id} 命名约定猜路径）
    return DEFAULT_PROJECTILE_PREFAB;
  }

  /* ===================================================================
   * 英雄选择 / 创建
   * =================================================================== */

  /**
   * 把英雄脚下范围圈（hero/range 预制件节点）的大小同步为**真实射程**。
   *   - GraphCircle.radius = 射程（attr16，如火枪 350px）→ 重画圆的半径
   *   - UITransform.contentSize = 射程 × 2 → 节点尺寸与画出来的圈一致
   * 目的：画面上的圈必须等于逻辑射程，否则会出现"火枪打到圈外"的错觉
   * （索敌本身始终以射程为准，见 pickEnemy）。
   * 调用时机：初始化英雄（selectHero）时 + 每次升级后（射程可能随等级成长）。
   */
  private syncHeroRangeCircle(): void {
    if (!this.hero || !this.heroNode) return;
    const rangeNode = this.heroNode.getChildByName('range');
    if (!rangeNode) return;

    const range = this.hero.getAttackRange();

    if (!this.heroRangeCircle) {
      this.heroRangeCircle = rangeNode.getComponent(GraphCircle);
    }
    if (this.heroRangeCircle) this.heroRangeCircle.radius = range;

    // 节点尺寸同步（直径），便于后续挂 Mask/Widget 或做调试框
    const ui = rangeNode.getComponent(UITransform);
    if (ui) ui.setContentSize(range * 2, range * 2);
  }

  /**
   * 创建 / 切换本局英雄 —— **选英雄功能的落地点**（`HeroSelect.pick` 校验通过后回调进来）。
   *
   * 为什么这段留在场景（而不是塞进 HeroSelect）：这里动的东西全都是「这一局战斗」的 ——
   * 创建实体、移除旧实体、范围圈、战斗事件订阅、遗物/ Buff 重挂、投影到 store。
   * `HeroSelect` 只回答「选了谁、什么时候选」，实体怎么建是战斗逻辑。
   *
   * @param heroId units.json 里的英雄单位 id（1000 段）
   */
  selectHero(heroId: number) {
    if (!this.ctx) {
      console.warn('[战斗] 配置未就绪，忽略选英雄');
      return;
    }
    const def = this.ctx.getUnitDef(heroId);
    if (!def) {
      console.error(`[战斗] 未找到英雄配置: ${heroId}`);
      return;
    }
    // 英雄节点上必须有 Hero 组件（表现层），否则后面 hero.bind 会空指针
    const hero = this.heroNode ? this.heroNode.getComponent(Hero) : null;
    if (!hero) {
      console.error('[战斗] heroNode 上缺少 Hero 组件，无法创建英雄表现');
      return;
    }

    // 创建英雄（居中守点，不移动）。同一局内再次选英雄 = 换英雄：
    // 旧实体连同它的 ModifierSystem 一起移除并重建（遗物/Buff 随后重新挂回来）
    if (hero.entity) {
      this.ctx.RemoveEntity(hero.entity);
    }
    this.hero = this.ctx.CreateEntityFromDef(def);
    this.hero.position = { ...this.config.center };
    this.hero.immovable = true; // 英雄为锚点：实体分离时只推怪不推英雄
    hero.bind(this.hero);
    // 本局初始金币播种（设计稿 §10.4 的既有 bug 修复 + §5.1 第 1 条效果）：
    //   `units.json` 的 10 个英雄 `gold` 全是 0，所以**改前开局是 0 金币**；
    //   `battle_constants.initialGold`（100）此前零消费方，这里补上它，再叠加成就快照的 `run_start_gold`。
    //   ⚠ 必须在 `CreateEntityFromDef` **之后**播种：实体构造里 `gold = def.gold` 会覆盖早写的值。
    //   ⚠ 首次选英雄才播种（同一局换英雄不重播初始金币，否则换一次英雄就白拿一次）。
    if (!this.initialGoldSeeded) {
      this.initialGoldSeeded = true;
      this.hero.gold = BattleConstUtil.getInitialGold() + this.achRunStartGold();
    }
    // 战斗事件只订阅一次（同一局 ctx 不变；重复订阅会导致击杀奖励/统计翻倍）
    this.bindBattleEvents();

    // 换英雄：上一任的普攻锁定目标随之作废（新英雄按自己的 attack_targeting 重新锁），
    // 玩家点选的那只同样作废（换英雄 = 换一套攻击方式，旧的手动指令不该跨英雄生效）
    this.attackTarget = null;
    this.clearManualTarget();

    // 英雄就位后立刻把范围圈预制件设成本英雄的真实射程（同理：换英雄/升级都要重设）
    this.syncHeroRangeCircle();

    // 遗物背包 + Buff 商店的已购 Buff 都**属于这一局**、不属于某个英雄实体：
    //   遗物背包只在首次选英雄时创建 —— 换英雄时**复用**并把已有遗物重新挂到新实体上
    //   （`RelicSystem.RebindOwner`），即「重新选英雄后等级 / 经验 / 装备（遗物）/ Buff 都不变」；
    //   重建它 = 把已获得的遗物整袋丢掉（换局时 resetRun 会把它置空，下一局自然重建）。
    if (!this.heroRelics) this.heroRelics = new RelicSystem(this.hero, this.ctx);
    else this.heroRelics.RebindOwner(this.hero);
    // Buff 商店买过的层数同样按层重放（层数真源在 BuffShop，不在英雄实体上）
    this.buffShop?.rebind();

    // 技能槽：英雄自带技能（不含普攻）按顺序占最低的几个索引（槽 0 = 英雄专属技能，永久锁定），
    // 已抽到的肉鸽技能尽量留在原槽并重新挂到新实体上（与遗物/Buff 一样：换英雄不丢）
    const unitSkillIds = this.hero.abilities.getAll()
      .filter((a) => !a.isAttack())
      .map((a) => a.getId());
    this.skillSlots?.attachHero(this.hero, unitSkillIds);

    // 成就效果（`hero_start_level`）：开局给英雄补 N 级。
    //   复用 `addBattleExp`（升级 → 按 growthValues 加属性 → 事件触发点），
    //   传入的就是「从 Lv.1 升到 Lv.(1+N) 所需的经验」——不重算成长与经验公式，
    //   本函数与「纯吃经验打上来的升级」走的是同一条路。只做一次（换英雄不重给）。
    if (!this.startLevelApplied) {
      this.startLevelApplied = true;
      const bonusLevel = this.achHeroStartLevel();
      if (bonusLevel > 0) {
        const base = BattleConstUtil.getBattleExpFormulaBase();
        const ratio = BattleConstUtil.getBattleExpFormulaRatio();
        const maxLevel = BattleConstUtil.getBattleLevelMax();
        const target = Math.min(maxLevel, 1 + bonusLevel);
        let need = 0;
        for (let lv = 1; lv < target; lv++) need += Math.floor(base * Math.pow(ratio, lv - 1));
        if (need > 0) {
          this.addBattleExp(need);
          console.log(`[成就] 开局英雄等级 +${bonusLevel}：补 ${need} 经验升到 Lv.${this.battleStore.level}`);
        }
      }
    }

    // 遗物面板的费用/广告次数（换局/换英雄后都要重算，面板按它决定刷新按钮置灰）
    this.relicShop?.syncCost();
    // 成就效果（`relic_start_gift`）：开局白送 N 件随机遗物（**只在本局首次选英雄时发一次**）
    this.relicShop?.grantStartGift();

    // 第一波怪
    // this.shopTimer = this.config.shopEvery;

    // 同步初始状态到 store（UI 读取）
    this.syncHeroToStore();

    console.log(`[战斗] 英雄: ${this.hero.name} @ (${this.config.center.x}, ${this.config.center.y}) 射程 ${this.hero.getAttackRange()}`);

  }

  /**
   * 扣局内金币 —— **选英雄刷新 / 遗物商店共用的唯一扣费口**（金币真源是 `hero.gold`）。
   *
   * 由 `HeroSelect` / `RelicShop` 通过 `deps.spendGold` 调用；扣完立刻投影到 store
   * （HUD 的金币数字、以及面板的置灰判据读的都是 `battleStore.gold`）。
   *
   * ⚠ **击杀商店（Buff）不走这里**：它花的是**击杀数**，扣费口是
   *   `battleStore.spendKillPoints()`（见 `onLoad` 里 `buffShop` 的依赖注入）——
   *   两条经济线分开是设计口径（设计稿 `docs/局内刷怪节奏设计.md` §7.1：金币管抽卡、击杀管 Buff）。
   *
   * @returns false = 余额不足（调用方负责拒绝本次操作）
   */
  private spendGold(amount: number): boolean {
    if (!this.hero) return false;
    if ((this.hero.gold ?? 0) < amount) return false;
    this.hero.gold -= amount;
    this.syncHeroToStore();
    // 任务进度：局内累计消耗金币（target=spend_gold）。
    // 这里是**金币**的唯一扣费口，所以挂在这一处就覆盖了选英雄刷新 / 遗物商店
    DataCenter.ins.taskData.addProgress('spend_gold', amount);
    // 成就进度：局内累计消耗金币（target=spend_gold，与任务同一处、同一数值）
    DataCenter.ins.achieveData.addProgress('spend_gold', amount);
    return true;
  }

  /**
   * 击杀商店「买一个 Buff」：**先让功能类判定并落盘，再按结果上报任务进度**。
   * （买失败——击杀数不够 / 已满层——不该算一次购买，所以不能无条件上报）
   */
  private onBuffBought(buffId: number): void {
    if (this.buffShop.buy(buffId)) {
      DataCenter.ins.taskData.addProgress('buffs_bought', 1);
    }
  }

  /**
   * 遗物真的发到手里（`RelicShop` 的 `deps.onRelicGranted` 回调）。
   *
   * ⚠ **2026-11 起这里什么都不做** —— 口径改动见 `docs/meta-growth/README.md` §0.2：
   * **局内抽到的遗物不再写进局外图鉴**。局外遗物只有一个来源，就是图鉴页的「抽 取」
   * （`DataCenter.drawOuterRelic`，花金币或抽取券）。
   *
   * 为什么要删掉原来那行 `equipCollection.addCollected(relicId)`：局内池 268 件里有
   * **28 件"两侧都有"**（scope = both）、一局抽满必然全部到手一遍，而
   * `getAllEquipmentBonuses()` 是**按份数线性累加**的 ⇒ **打两局局外属性就翻倍**。
   * 这条漏洞在"局外遗物只能金币抽取"上线之前看不出来（那样图鉴只是白涨），
   * 抽取上线之后它会直接把局外成长线翻倍。
   *
   * 保留这个（空的）回调位是因为它仍是「局内发货」的契约点：以后要接别的记账
   * （埋点 / 引导 / "本局获得了什么"的统计）落点还是这里，**但不许再写图鉴**。
   */
  private onRelicCollected(_relicId: number): void {
  }

  /** 默认玩法参数（与 BattleDemo 默认一致；id 为 number 配置编号） */
  get defaultConfig(): GameStageConfig {
    return {
      heroUnitId: 1002, // 赏金猎人（hero 1000 段：1001 火枪 / 1002 赏金 / 1003 宙斯 / 1004 斧王）
      monsterPool: [2001, 2002, 2003, 2004, 2005, 2006], // 哥布林/巨魔/游荡者/环绕魔/重击者/深渊领主
      relicPool: [], // 空 = 商店遗物全表（293 件道具，id 1001~1293）
      spawnRadius: [650, 800],
      // Boss 单位：2006 = 深渊领主（units.json 里唯一的关底 Boss，带 boss AI 分阶段）
      // 阶段 Boss 缩放 ×1.5、最终 Boss 缩放 ×2，配色/受击色见 common/EntityVisualConfig.ts
      // 想临时关掉 Boss 刷新就把对应项设为 0
      stageBossUnitId: 2006,
      finalBossUnitId: 2006,
      shopEvery: 20,
      winTime: 90,
      maxSkillSlots: 3,
      killHeal: 6,
      center: { x: 0, y: 0 },
      // 阶段时长（HUD 的「准备中 / 阶段 N/4 / Boss」倒计时与进度条都以它为准）
      // 240s/阶段 = 16 个 60s 刷怪 beat（见 SPAWN_BEATS），总长 15 + 240×4 + 150 = 1125s（18.8 分钟）
      prepareTime: 15,
      stageTime: 240,
      bossTime: 150,
    };
  }

  /** 注入玩法参数（外部可在 show 前调用覆盖默认值） */
  setGameConfig(partial: Partial<GameStageConfig>): void {
    this.config = { ...this.defaultConfig, ...partial };
  }

  /**
   * 订阅本局战斗事件（击杀回血 / 英雄状态同步到 store / 弹道回收）。
   *
   * ⚠ 幂等：事件订阅挂在 `this.ctx.bus` 上，同一局内换英雄时 ctx 没变，
   *   重复订阅会让 OnDeath / OnTakeDamage 的处理器叠加（击杀 +2、奖励翻倍、回血翻倍）。
   *   换局（resetRun）会把 eventsBound 复位，新 ctx 自然重新订阅一次。
   */
  private bindBattleEvents(): void {
    if (this.eventsBound || !this.ctx) return;
    this.eventsBound = true;
    // 实体入战/出战 → 同步敌人数量到 store（统计由订阅方负责，ctx 只发事件）
    this.ctx.bus.onBattleEvent(BattleEvents.OnEntityAdded, (e: { entity: Entity }) => {
      if (e.entity !== this.hero && e.entity.team === 2) {
        this.battleStore.enemiesAlive = this.ctx.activeEntityCount() - 1; // 减英雄
      }
    });
    this.ctx.bus.onBattleEvent(BattleEvents.OnEntityRemoved, (e: { entity: Entity }) => {
      if (e.entity !== this.hero && e.entity.team === 2) {
        this.battleStore.enemiesAlive = this.ctx.activeEntityCount() - 1;
      }
    });

    // 击杀统计 + 击杀回血 + 击杀奖励 + 怪物死亡回收
    this.ctx.bus.onBattleEvent(BattleEvents.OnDeath, (e: { entity: Entity, killer: Entity }) => {
      if (e.entity === this.hero) {
        // 英雄阵亡 → 本局失败（收尾统一走 endRun；这里立刻 return，不再往下走怪物回收）
        this.endRun('defeat', 'hero_dead')
        return
      }
      // Boss 调度：死的是不是它放出去的 Boss（守卫 → 触发刷怪加码；其他 → 只清场上记录）。
      // 放在奖励/回收**之前** —— 加码要在这一帧就生效，别等下一帧。
      if (this.slotBosses[e.entity.uid]) {
        delete this.slotBosses[e.entity.uid]
        this.bossScheduler?.onEntityDead(e.entity.uid)
      }
      // 非英雄死亡 → 回收进对象池（ctx 统一管理回收状态，防重复回收）
      if (e.entity !== this.hero && !this.ctx.IsRecycled(e.entity)) {
        this.recycleMonster(e.entity);
      }
      // 普攻锁定的目标死亡 → 立刻解除锁定（下一帧按 attack_targeting 重新锁一个）
      // 必须在这里清：实体回池后会被复用成"另一只怪"，旧引用不能继续当锁定目标
      if (e.entity === this.attackTarget) this.attackTarget = null;
      if (this.hero?.forcedTarget === e.entity) this.hero.ClearForcedTarget();
      if (e.killer === this.hero && e.entity !== this.hero) {
        this.killCount++;
        this.hero.Heal(this.config.killHeal);
        this.battleStore.onEnemyKilled();
        this.grantKillReward(e.entity);
        // 任务进度：击杀数（tasks.json 的 target=kill_enemies，即时累加，中途退出也保留）
        DataCenter.ins.taskData.addProgress('kill_enemies', 1);
        // 成就进度：累计击杀数（target=kill_enemies，与任务共用词表）
        DataCenter.ins.achieveData.addProgress('kill_enemies', 1);
      }
      // 最终 Boss 阵亡 → 通关。放在统计/奖励**之后**，让这一杀算进本局结算（击杀数 / 掉金）
      if (e.entity === this.finalBoss) {
        this.finalBoss = null; // 实体已回池，引用作废（防复用时误判）
        this.endRun('victory', 'boss_killed')
      }
    });
    // 英雄受伤/治疗 → 投影到 store（UI 血条）；唯一写入口 syncHeroToStore
    this.ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, (e: any) => {
      if (e.target === this.hero) {
        // ★ 致命伤拦截：**必须在这里**（Phase 7 的 `OnTakeDamage` 在 Phase 8 的死亡检查之前，
        //   见 `DamagePipeline`）—— 这一击若把英雄打到 hp ≤ 0，就地补回来 + 置回 `alive`，
        //   Phase 8 的 `IsDead()` 就不成立、`Die()`（会 `modifiers.Clear()`）不会被调用，
        //   所以"复活"不需要重建任何遗物/Buff/技能状态。同一套路见 `Modifier_TimeRewind`。
        this.onLethalForHero();
        this.syncHeroToStore();
        // 成就标记：英雄本局挨过伤害（`clear_no_damage` 的判据，结算时读，见 reportRunTasks）
        this.tookDamage = true;
      }
      // 成就进度：英雄造成的伤害与暴击次数（只认 `source === hero` 的一侧，取数见设计稿 §9.C）
      if (e.source === this.hero) {
        DataCenter.ins.achieveData.addProgress('damage_dealt', e.finalDamage ?? 0);
        if (e.isCrit) DataCenter.ins.achieveData.addProgress('crit_hits', 1);
      }
    });
    this.ctx.bus.onBattleEvent(BattleEvents.OnHeal, (e: any) => {
      if (e.target === this.hero) this.syncHeroToStore();
    });
    /**
     * 局内金币变化 → 投影到 store（HUD 金币读数）。
     *
     * 为什么需要这条订阅：`hero.gold` 的**既有**写入方只有 `grantKillReward`（击杀奖励），
     * 它自己顺手调了 `syncHeroToStore()`；而技能侧（111 淘金 / 122 击杀回响的掉金）
     * 是脚本直接改 `hero.gold` 的，没有这条订阅的话**金币要等到下一次受伤/治疗才在界面上跳**。
     */
    this.ctx.bus.onBattleEvent(BattleEvents.OnGoldGained, (e: any) => {
      if (e.target === this.hero) this.syncHeroToStore();
    });
    /**
     * 局内经验入账（2026-10 遗物重做新增）→ 折算成局内英雄经验。
     *
     * 为什么走事件：遗物钩子「领悟（killExpFlat）」按击杀额外发经验，而局内经验的唯一入口是本类的
     * `addBattleExp`（要处理升级 / growthValues 成长 / HUD 投影），战斗层碰不到它。
     * 所以约定：脚本 `publish(BattleEvents.OnExpGained, { target, amount })`，这里收口。
     */
    this.ctx.bus.onBattleEvent(BattleEvents.OnExpGained, (e: any) => {
      if (e.target !== this.hero) return;
      const amount = Math.max(0, Math.floor(Number(e?.amount ?? 0)));
      if (amount > 0) this.addBattleExp(amount);
    });
    // 遗物记录
    this.ctx.bus.onBattleEvent(BattleEvents.OnRelicAdded, (e: any) => {
      if (e.target === this.hero) {
        this.syncHeroToStore();
        // 任务进度：累计获得遗物数（target=relics_picked）
        DataCenter.ins.taskData.addProgress('relics_picked', 1);
        // 成就进度：累计获得遗物数（target=relics_picked，语义与任务一致）
        DataCenter.ins.achieveData.addProgress('relics_picked', 1);
      }
    });
    // 技能施放 → 任务进度（target=skills_used）。
    // ⚠ 只有**主动施放**才会发这个事件（被动不进这条路径）；当前英雄技能全是被动，
    //   所以配表里暂时没有用这个条件的任务，等有主动技能再启用。
    this.ctx.bus.onBattleEvent(BattleEvents.OnAbilityCast, (e: { caster: Entity, abilityId: number }) => {
      if (e.caster === this.hero) {
        DataCenter.ins.taskData.addProgress('skills_used', 1);
      }
    });
    // 弹道命中/落空 → 回收弹道视图（移到 projectileCacheParent 隐藏）
    this.ctx.bus.onBattleEvent(BattleEvents.OnProjectileHit, (e: any) => {
      if (e.projectile?.view) {
        this.projectilePool.release(e.projectile, this.projectileCacheParent);
        e.projectile.view = null;
      }
    });
    this.ctx.bus.onBattleEvent(BattleEvents.OnProjectileMiss, (e: any) => {
      if (e.projectile?.view) {
        this.projectilePool.release(e.projectile, this.projectileCacheParent);
        e.projectile.view = null;
      }
    });
  }

  /**
   * 英雄状态同步到 battleStore（UI 响应式读取）。
   *
   * 这是英雄侧**所有 UI 展示数据的唯一写入口**：血量 / 上限 / 金币 / 英雄 id / 技能栏 / 遗物背包。
   *  - `heroId`：UI 靠它查 units.json 拿 head_icon → HUD 头像、选英雄面板高亮
   *  - `heroSkills`：只在该列表真的变了时才写（本方法会被每次受伤/回血调用，
   *    数组若每次都赋新值会让 UI watcher 每帧空跑）
   */
  private syncHeroToStore(): void {
    if (!this.hero) return;
    this.battleStore.hp = this.hero.hp;
    this.battleStore.maxHp = this.hero.getMaxHp();
    this.battleStore.gold = this.hero.gold;
    this.battleStore.heroId = this.hero.id;

    // 技能栏 = 英雄实体拥有的技能（units.json 的 abilities + 肉鸽额外学会的；含被动，不含普攻）
    const skills = this.hero.abilities?.getAll?.() ?? [];
    const skillIds = skills.map((a) => a.getId());
    const skillKey = skillIds.join(',');
    if (skillKey !== this.lastSkillKey) {
      this.lastSkillKey = skillKey;
      this.battleStore.heroSkills = skillIds;
    }

    // 遗物背包（本局已获得遗物 id）：真源在 RelicSystem，这里只做投影。
    // 与技能栏同样用指纹挡重复写 —— 本方法会被每次受伤/回血调用，数组每帧换新会让 UI watcher 空跑
    const relicIds = this.heroRelics?.getAll?.().map((r) => r.getId()) ?? [];
    const relicKey = relicIds.join(',');
    if (relicKey !== this.lastRelicBagKey) {
      this.lastRelicBagKey = relicKey;
      this.battleStore.relicBag = relicIds;
    }
    // 局内等级/经验：真源在 battleStore（响应式），无需重复投影
  }



  /** 回收一只怪物（统一池：内部先还表现再还逻辑） */
  private recycleMonster(m: Entity): void {
    this.monsterPool.release(m);
  }

  /* ===================================================================
   * Boss 调度的宿主能力（放怪 / 限时离场）
   *
   * `BossScheduler` 只管规则（充能 / 库存 / 限时），**放怪与回收的实体操作全在这里**。
   * =================================================================== */

  /** 场上由 Boss 调度放出的实体（uid → Entity）——限时到期时要能精确找到它并回收 */
  private slotBosses: Record<number, Entity> = {};

  /**
   * 把调度器放出的 Boss 摆到刷新圈外（`BossSchedulerDeps.spawn` 的实现）。
   *
   * 表现类别交给 `resolveUnitKind` 按 `rewardType` 解析 —— 所以
   * `gold_boss` / `kill_boss` / `boss` 三种配色与缩放（1.5×）**自动生效，不用在这里特判**。
   *
   * @returns 实体 uid；**<0 = 失败**（配表缺单位等），调度器据此回滚库存
   */
  private deployBoss(def: BossSlotDef): number {
    if (!this.ctx) return -1;
    const unitDef = this.ctx.getUnitDef(def.unitId);
    if (!unitDef) {
      ezgame.warn(`[Boss] units.json 里没有单位 ${def.unitId}（${def.label}），放不出来`);
      return -1;
    }
    const kind = resolveUnitKind(unitDef);
    const boss = this.monsterPool.acquire(unitDef, kind);
    const angle = Math.random() * Math.PI * 2;
    const dist = this.config.spawnRadius[1];
    boss.position = {
      x: this.config.center.x + Math.cos(angle) * dist,
      y: this.config.center.y + Math.sin(angle) * dist,
    };
    this.slotBosses[boss.uid] = boss;
    console.log(`[Boss] 放出 ${def.label}（${unitDef.name}, ${kind}, 缩放 ${getUnitScale(kind)}）`);
    return boss.uid;
  }

  /**
   * 限时到期 → 让 Boss **离场**（`BossSchedulerDeps.despawn` 的实现）。
   *
   * ⚠ 走的是「撤离」而**不是死亡**：`ctx.RemoveEntity`（会发 `OnEntityRemoved` → 敌人计数同步）
   *   ＋ 回对象池，**不发奖励、不触发 `OnDeath`**。
   *   如果图省事写成 `boss.hp = 0`，会走完整条死亡链 → 白送一份金币/经验；对金币怪尤其致命
   *   —— 它本来就是「没打死就带着钱跑掉」的设计，给奖励等于这个限时机制完全失效。
   */
  private despawnBoss(uid: number, def: BossSlotDef): void {
    const boss = this.slotBosses[uid];
    delete this.slotBosses[uid];
    if (!boss || !this.ctx || this.ctx.IsRecycled(boss)) return;
    this.ctx.RemoveEntity(boss);
    this.recycleMonster(boss);
    ezgame.info(`[Boss] ${def.label} 限时离场（未击杀，不给奖励）`);
  }

  /* ===================================================================
   * 击杀奖励（金币 / 经验）
   * =================================================================== */

  /**
   * 击杀奖励发放：
   *   实际奖励 = 基地值（units.json 的 goldReward/expReward） × 阶段难度系数 × 时间通胀系数 × 本局难度系数
   *   （三个乘区都收在 `currentRewardScale()` 里，本方法只用它的结果）
   *   金币 → 局内 hero.gold（HUD，局内经济）
   *   经验 → 局内英雄等级（addBattleExp：升级→按 units.json growthValues 加属性）
   *   ⚠️ 不写局外 DataCenter——局外经验在对局结束 `endRun()` 时按配置一次性结算。
   *
   * 金币/经验 boss 走 rewardType 专门放大（一次性大量奖励）。
   */
  private grantKillReward(dead: Entity): void {
    if (!dead) return;
    // 从运行时唯一的单位配置表取奖励基数（units.json / UnitCfg）
    const def = this.ctx?.getUnitDef(dead.id);
    if (!def) return;

    const goldBase = def.goldReward ?? BattleConstUtil.getEnemyDropGoldDefault();
    const expBase = def.expReward ?? BattleConstUtil.getEnemyDropExpDefault();

    const scale = this.currentRewardScale();

    let gold = Math.round(goldBase * scale);
    let exp = Math.round(expBase * scale);

    // 成就效果（开局快照）：击杀金币 / 局内经验各一条加成，**只在这里折算一次**，
    // 放在 boss 倍率之前（两条效果是"全局收益"，不该被 boss 奖励类型放大/缩小）。
    //   配表是百分数（10 = 10%）→ 取数口给的就是比例（0.1）；未生效时为 0，乘出来仍是原值。
    // 遗物属性「21 金币获取 / 22 经验获取」（2026-10 遗物重做）：与成就加成**加法叠加**，
    //   同样是全局收益、同样放在 boss 倍率之前。运行时值是比例（0.2 = +20%），由 attributes.json 钳制。
    const achGoldBonus = this.achGoldGainBonus();
    const relicGoldBonus = this.hero?.attrs?.get(AttributeType.GoldGain) ?? 0;
    const goldBonus = achGoldBonus + relicGoldBonus;
    if (goldBonus > 0) gold = Math.round(gold * (1 + goldBonus));
    const achExpBonus = this.achBattleExpBonus();
    const relicExpBonus = this.hero?.attrs?.get(AttributeType.ExpGain) ?? 0;
    const expBonus = achExpBonus + relicExpBonus;
    if (expBonus > 0) exp = Math.round(exp * (1 + expBonus));

    // 专门 boss：一次性大量奖励（相对常规 boss 的倍率加成）
    if (def.rewardType === 'gold_boss') {
      gold = Math.round(gold * BattleConstUtil.getRewardBossGoldBonus());
    } else if (def.rewardType === 'exp_boss') {
      exp = Math.round(exp * BattleConstUtil.getRewardBossExpBonus());
    }

    // 打击反馈 B3：击杀落款 + 奖励飞入 + 连击（F4/F8/F9）。
    // **由算数的一方把数递进去**：表现层自己算奖励会算出另一个数（基础值 × 阶段系数 × 通胀 ×
    // 成就/遗物加成 × Boss 倍率全在这上面几行）。放在早退之前 —— 金币经验都为 0 的击杀
    // 一样要算连击、一样要有落款（"这一下算数"本身就是信息）。
    if (dead.position) {
      this.hitScreen?.killReward(dead.position.x, dead.position.y, gold, exp);
    }

    if (gold <= 0 && exp <= 0) return;
    // 金币：局内经济（HUD 读取 battleStore.gold，由 syncHeroToStore 投影）。
    // 局外金币不属于局内经济体系，此处不写 DataCenter。
    if (gold > 0) {
      this.hero.gold = (this.hero.gold ?? 0) + gold;
      this.syncHeroToStore();
      // 任务进度：局内累计获得金币（target=gold_earned）
      DataCenter.ins.taskData.addProgress('gold_earned', gold);
      // 成就进度：局内累计获得金币（target=gold_earned，与任务同一数值）
      DataCenter.ins.achieveData.addProgress('gold_earned', gold);
    }

    // 经验：局内英雄等级（升级→加属性）。不是局外经验！
    if (exp > 0) {
      this.addBattleExp(exp);
    }

    console.log(`[奖励] 击杀 ${def.name}: 金币 +${gold}, 局内经验 +${exp} (敌人奖励缩放 x${scale.toFixed(2)})`
      + (goldBonus > 0 || expBonus > 0
        ? `（加成：金币 +${Math.round(goldBonus * 100)}% / 经验 +${Math.round(expBonus * 100)}%`
          + `（成就 ${Math.round(achGoldBonus * 100)}%/${Math.round(achExpBonus * 100)}%，遗物 ${Math.round(relicGoldBonus * 100)}%/${Math.round(relicExpBonus * 100)}%））`
        : ''));
  }

  /* ===================================================================
   * 局内英雄等级 / 经验（非局外数据中心）
   * =================================================================== */

  /**
   * 局内经验：累加到当前出战英雄，满了就升级。
   * 升级时按 units.json 的 growthValues 调 attrs.addBase 加属性，并同步 HUD。
   * **升级不恢复生命/魔法**（只抬上限，当前值保持原样）—— 见下面 `leveled` 分支的注释。
   * 局内等级只存活于本局，局终清零；不会写入局外 PlayerInfo/HeroData。
   */
  private addBattleExp(amount: number): void {
    if (!this.hero) return;
    const st = this.battleStore;
    st.exp += amount;

    let leveled = false;
    const maxLevel = BattleConstUtil.getBattleLevelMax();
    while (st.level < maxLevel && st.exp >= st.expToNext) {
      st.exp -= st.expToNext;
      st.level += 1;
      st.expToNext = Math.floor(BattleConstUtil.getBattleExpFormulaBase() * Math.pow(BattleConstUtil.getBattleExpFormulaRatio(), st.level - 1));
      this.applyHeroGrowth(st.level);
      // 技能随局内等级进化（火枪鹰眼 Lv.10/20/30 自动升阶；无对应技能的英雄静默跳过）
      if (st.level === 10 || st.level === 20 || st.level === 30) {
        this.tryAutoUpgradeSkill();
      }
      leveled = true;
    }
    if (leveled) {
      // ⚠ **升级不恢复生命/魔法**（用户口径）：只按 growthValues 抬上限，当前 hp/mana 保持原值。
      //   曾经的写法是 `hp = getMaxHp()` + `mana = getMaxMana()`（升级即满血），已删除 ——
      //   那会让"残血时升级"变成一次白送的治疗，把续航压力抹平。
      //   「加最大生命的同时补当前生命」这条**满血口径**只属于**遗物 / 击杀商店 Buff**
      //   （唯一入口 `Entity.ApplyWithMaxHpCarry`，判据是"施放前是否满血"），升级不走它。
      this.syncHeroToStore();
      console.log(`[局内] 英雄升级到 Lv.${st.level}（升级不回血：当前 ${Math.ceil(this.hero.hp)}/${Math.ceil(this.hero.getMaxHp())}）`);
    }
  }

  /**
   * 技能随局内等级进化（hero-design「仅技能随英雄等级 Lv.1/10/20/30 升级」）。
   * 通用实现：英雄当前拥有「带 upgrades_to 升级链」的技能时沿链升一阶；
   * 火枪鹰眼 12→13→14→15、宙斯雷霆之核 19→20→21→22；无升级链的英雄静默跳过（不报错）。
   * 普攻不算技能：普攻（behavior=attack）即使带 upgrades_to 也不参与技能进化。
   */
  private tryAutoUpgradeSkill(): void {
    if (!this.hero) return;
    const current = this.hero.abilities.getAll().find((a) => !a.isAttack() && !!a.def.upgrades_to);
    if (!current) return;
    const upgraded = this.hero.abilities.UpgradeAbility(current.getId());
    if (upgraded) {
      console.log(`[局内] 英雄升到 Lv.${this.battleStore.level}，技能进化为「${upgraded.def.name}」`);
    }
  }

  /**
   * 按 units.json 英雄条目的 growthValues 给英雄加一级属性。
   * 英雄配置来源单位配置（units.json team=1 英雄条目，id 1000 段），与英雄实体 this.hero.id 一致。
   * growthValues 为 [[属性序号, 每级成长值], ...]，值为运行时 float 语义（如暴击 0.005 = 0.5%/级）。
   */
  private applyHeroGrowth(level: number): void {
    if (!this.hero) return;

    let ct = TbRoot.ins.getTbContainer(UnitCfgContainer)

    const heroCfg = ct.getCfgById(this.hero.id);
    if (!heroCfg) return;

    // growthValues 二维数组，一维0位为属性序号，1位为成长值；
    // 缺失时跳过（怪物等非英雄单位无成长配置，不会进入本方法）
    heroCfg.growthValues?.forEach((kv) => {
      let type = kv[0] as AttributeType
      let value = kv[1]
      const configInt = AttributeScaling.isScaled(type) ? value * AttributeScaling.scale(type) : value;
      this.hero.attrs.addBase(type, configInt);
    })

    // 射程可能随等级成长（如赏金猎人 attr16 +0.05/级）→ 同步范围圈
    this.syncHeroRangeCircle();
  }


  /** 属性名 → AttributeType 编号（growthValues 用名称，系统用编号） */
  private attrNameToId(name: string): AttributeType | undefined {
    const map: Record<string, AttributeType> = {
      maxHp: AttributeType.MaxHp, atk: AttributeType.Atk, atkSpeed: AttributeType.AtkSpeed,
      moveSpeed: AttributeType.MoveSpeed, def: AttributeType.Def, magicResist: AttributeType.MagicResist,
      dodge: AttributeType.Evasion, hpRegen: AttributeType.HpRegen, manaRegen: AttributeType.ManaRegen,
      critRate: AttributeType.CritRate, critDmg: AttributeType.CritDmg, atkRange: AttributeType.AtkRange,
    };
    return map[name];
  }

  /** 重置局内英雄等级（每次选英雄 / 开局调用；局内体系局终清零） */
  private resetHeroLevel(): void {
    const st = this.battleStore;
    st.level = 1;
    st.exp = 0;
    st.expToNext = BattleConstUtil.getBattleExpFormulaBase();
  }

  /**
   * 当前奖励缩放系数（击杀金币/经验的总乘区，**结算口径的唯一出口**）：
   *   阶段难度系数 = 1 + 阶段序号进度（阶段越高越难，奖励越高）
   *   时间通胀系数 = 1 + min(elapsed × 每秒系数, 上限)
   *   本局难度系数 = (1.06)^(N-1)（`DifficultyConfig.rewardMul`，档 1 = ×1）
   * 三者相乘：跨阶段靠难度跳，阶段内靠时间缓涨，跨档位靠难度系数抬（打更难的档就该赚更多）。
   *
   * ⚠ 难度系数**刻意低于怪 HP 的涨幅**（HP 1.10^N vs 收益 1.06^N）—— 差额要由局外成长补，
   *   这是设计稿的口径（`docs/数值设计调研报告_肉鸽塔防.md` §4），不要在代码里"顺手配平"。
   */
  private currentRewardScale(): number {
    // 阶段难度（0 准备、1-4 常规、5 boss）。这里用阶段序号近似难度增益。
    const phaseMul = 1 + Math.max(0, this.stage - 1) * 0.15;
    const timeMul = 1 + Math.min(this.elapsed * BattleConstUtil.getRewardTimeBasePerSec(), BattleConstUtil.getRewardTimeCap());
    return phaseMul * timeMul * rewardMul(this.difficulty);
  }

  /* ===================================================================
   * 英雄 AI（对应 GameManager.heroAI）
   * =================================================================== */

  private heroAI(): void {
    const attackRange = this.hero.getAttackRange();
    let cfg = TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(this.hero.id)
    // 4.1 普攻（普通攻击，不算技能：独立于技能体系，冷却 = 普攻间隔 / 攻速，由 Entity.Attack 驱动）
    // 普攻索敌：**粘性锁定** —— attack_targeting 只在"重新索敌"时起作用（缺省 nearest），
    // 所以火枪 "farthest" = 本次锁定时挑攻击范围内最远的那个，然后一直打到它死为止
    // （见 resolveAttackTarget；早期实现每帧重新挑，导致普攻在两只怪之间反复横跳）
    const attackStrategy = cfg?.attack_targeting ?? 'nearest';
    const target = this.resolveAttackTarget(attackStrategy, attackRange);
    if (target) this.hero.Attack(target);

    // 4.2 自动施放主动技能（仅技能；普攻/被动不算技能，已在 getCastableSkills 中排除）
    for (const ability of this.hero.abilities.getCastableSkills()) {
      if (ability.isOnCooldown()) continue;
      if (!ability.canCast()) continue;

      const range = ability.def.cast_range ?? attackRange;

      // 无目标技能（如毒镖：多目标弹道自己选）：范围内有敌人即可施放
      if (ability.def.behavior === 'no_target') {
        if (!this.pickEnemy('nearest', range)) continue;
        this.hero.abilities.CastAbility(ability.getId());
        continue;
      }

      // 需要目标的技能：按技能自己的 targeting 索敌
      const enemy = this.pickEnemy(ability.def.targeting ?? 'nearest', range);
      if (!enemy) continue;
      this.hero.abilities.CastAbility(ability.getId(), enemy);
    }
  }

  /**
   * 普攻锁定目标（粘性索敌状态）—— 一旦锁定就一直打它，不每帧重新比较。
   *
   * 为什么需要：索敌若每帧都跑，怪物稍微挪一下"最近/最远"就换了人，
   * 普攻会在两只怪之间反复横跳，攻击次数被摊平，谁都打不死。
   * 规则：**只有锁定目标死亡/失效/离开射程（且射程内有别的敌人）时才换目标**；
   * 两个例外：嘲讽（hero.forcedTarget）与**玩家点选的手动目标**（`manualTarget`），
   * 两者都压过锁定，且都在 `resolveAttackTarget` 里判（别在别处插判断）。
   *
   * 重置时机：换英雄（selectHero）/ 本局重开（resetRun）/ 锁定目标死亡（OnDeath）。
   * 注意：实体回对象池后会被复用成"另一只怪"，所以旧引用必须在这三处作废。
   */
  private attackTarget: Entity | null = null;

  /**
   * **玩家点选的目标**（手动锁定，点一下怪就锁它）—— 与 `attackTarget`（自动粘性锁定）是两件事：
   *   · `attackTarget` 是"系统替我挑的，我会一直打它"；本字段是"我要打它"；
   *   · 生命周期也不同：前者随"目标失效/离开射程"随时被换掉，后者**只由玩家解除**
   *     （点空地 / 换英雄 / 换局 / 结束）或目标失效（死亡、被回收、离场、不可选中）时自动解除。
   *
   * 优先级见 `resolveAttackTarget`：嘲讽 > **手动目标（射程内）** > 粘性锁定 > 按策略重新索敌。
   * ⚠ 手动目标**在射程外不占坑**：那一帧照常打射程内的别的怪，它一进圈立刻被优先打
   *   —— 点远处那只怪不会让英雄站在原地发呆（口径由玩家拍板，见 `onFieldTap` 的注释）。
   */
  private manualTarget: Entity | null = null;

  /**
   * 每帧的普攻决策：返回本帧该打的敌人（null = 本帧不出手）
   *
   * 优先级：
   *   ① 强制目标（嘲讽）：只要还活着就优先，**不看射程挑别人** ——
   *      射程外返回 null（站原地等它靠近），但锁定不换；
   *      目标死亡/被回收时强制状态自动解除，落回 ②③④。
   *   ② **手动目标**（玩家点选，见 `manualTarget`）：**在射程内**就优先打它；
   *      射程外不返回（继续往 ③④ 走，照常打射程内别的怪），它一进圈立刻重新被这一步接住。
   *      是否失效由 `tickManualTarget` 每帧统一判（死亡/回收/离场/不可选中 → 自动解除）。
   *   ③ 粘性锁定：锁定目标仍存活、可选中、在射程内 → 继续打它（不重新比较）。
   *   ④ 重新索敌：按 attack_targeting 在射程内挑一个（挑不到就保留锁定，等它回射程）。
   *
   * @param strategy 索敌策略（units.json 的 attack_targeting，缺省 nearest），仅在 ④ 生效
   * @param range 攻击射程
   */
  private resolveAttackTarget(strategy: string, range: number): Entity | null {
    // ① 嘲讽（强制目标）优先：这是"粘性锁定"的唯一例外
    const forced = this.hero?.forcedTarget ?? null;
    if (forced) {
      if (this.isTargetUsable(forced)) {
        return this.isInRange(forced, range) ? forced : null; // 射程外：等它过来，不换目标
      }
      this.hero.ClearForcedTarget(); // 已死/已回收 → 解除嘲讽，走常规流程
    }

    // ② 手动目标（玩家点选）：射程内优先打它；射程外**不占坑**（往下走，别让英雄空转）
    const picked = this.manualTarget;
    if (picked && this.isTargetUsable(picked) && this.isInRange(picked, range)) return picked;

    // ③ 粘性锁定：目标没死就继续打，不做任何重新比较
    const locked = this.attackTarget;
    if (locked && this.isTargetUsable(locked) && this.isInRange(locked, range)) return locked;

    // ④ 锁定失效（死亡/回收/不可选中）或离开射程 → 重新索敌
    const next = this.pickEnemy(strategy, range);
    if (next) {
      this.attackTarget = next;
      return next;
    }
    // 射程内没有别的敌人：锁定目标若已失效就清掉，否则保留（它可能马上回到射程内）
    if (locked && !this.isTargetUsable(locked)) this.attackTarget = null;
    return null;
  }

  /* ===================================================================
   * 点选索敌（点击怪物切换攻击目标）
   *
   * 分层：`TargetPicker`（表现/输入层，cc 组件）只做"点到哪了 + 画标记"；
   *       **规则全在本节**（谁算点中、选它还是取消、什么时候自动解除）。
   * 与自动索敌共用 `isTargetUsable` / `isInRange` / `pickTargetAtPoint`，所以手动与自动
   * 永远满足同一套"能不能打"判据（不会出现"自动能打、手动选不上"这类双口径）。
   * =================================================================== */

  /**
   * 战场被点了一下（`TargetPicker` 把触摸点换算成**逻辑坐标**后回调）——
   * 「点击怪物切换攻击目标」的落地点。
   *
   * 三种情形（口径由玩家拍板）：
   *   · **点中一只怪** → 选它：点不同的怪 = 切换；点**同一只** = 保持（不取消、不重选）；
   *   · **点空地** → 取消手动选择，回到自动索敌；
   *   · 暂停 / 没选英雄 / 已结束 → 忽略（点选改的是"接下来打谁"，这些状态下没有"接下来"）。
   *
   * 为什么"点空地"要顺带清掉 `attackTarget`：手动目标在射程内时它是**最高优先**的，
   * 粘性锁定里多半已经存着同一只（自动索敌那一套仍在跑）—— 只清手动而不清粘性，
   * "取消"在表现上完全看不出来（英雄照样打它）。清掉之后下一帧按 `attack_targeting` 重新锁，
   * 该打谁还是谁（若策略又挑中同一只，那也**不再是"手动锁定"**，标记不再画）。
   */
  private onFieldTap(x: number, y: number): void {
    if (!this.ctx || !this.hero || this.finished || this.battleStore.isPaused) return;

    // 候选集与自动索敌**同一套判据**：存活 / 未回收 / 可选中 / 敌对阵营
    const candidates = this.ctx.GetTeamEntities(2).filter((e) => this.isTargetUsable(e));
    const hit = pickTargetAtPoint(
      candidates, { x, y }, TAP_SELECT.hitPadPx, TAP_SELECT.minHitRadiusPx,
    ) as Entity | null;

    if (!hit) {
      if (!this.manualTarget) return;   // 本来就没有手动选择 → 点空地什么也不改（幂等）
      this.clearManualTarget();
      this.attackTarget = null;
      return;
    }
    if (hit === this.manualTarget) return;   // 点同一只 = 保持
    this.manualTarget = hit;                 // 切换 / 新选（点不同的怪）
  }

  /**
   * 清掉手动锁定（**只改状态与表现，不碰 `attackTarget`** —— 要不要回自动索敌由调用方决定）。
   * 取消点选（`onFieldTap` 的空地分支）、换英雄、换局、本局结束都走这里，保证"解除"只有一处。
   */
  private clearManualTarget(): void {
    this.manualTarget = null;
    this.targetPicker?.clearMark();
  }

  /**
   * 手动目标的**每帧维护**：失效即自动解除 + 把标记画到它身上（宿主每帧调一次）。
   *
   * 为什么放在每帧而不是只挂在 `OnDeath` 上：手动目标失效的路不止"死亡"一条 ——
   * Boss 调度到期**撤离**（`despawnBoss`，走 `RemoveEntity` 不发 `OnDeath`）、被魅惑改阵营、
   * 进不可选中状态，都会让旧引用变成"不该继续画环的东西"。
   * 一条判据（`isTargetUsable`）盖住全部，也就不会有"漏了某条路 → 环停在草地上"。
   *
   * 必须在 `ctx.Tick` **之后**调用：本帧死在 Tick 里的怪，在这一步已经被标成不可用并解除，
   * 不会带着死引用进下一帧（更不会拿到回池后复位过的 position 去画环）。
   */
  private tickManualTarget(): void {
    const picked = this.manualTarget;
    if (picked && !this.isTargetUsable(picked)) this.manualTarget = null;
    this.targetPicker?.mark(this.manualTarget);
  }

  /**
   * 目标是否还能被打（**不含射程判定**）
   *   - 存活、未被回收（对象池复用后是"另一只怪"，旧引用必须作废）
   *   - 仍是敌对阵营、且非「不可选中」状态
   */
  private isTargetUsable(e: Entity | null): boolean {
    if (!e) return false;
    if (e.IsDead()) return false;
    if (this.ctx.IsRecycled(e)) return false;                       // 已回对象池
    if (this.hero && e.team === this.hero.team) return false;        // 阵营变了（魅惑/召唤物等）
    if (e.status.get(StateType.Untargetable)) return false;          // 不可选中
    return true;
  }

  /** 目标是否在射程内（以英雄为圆心；英雄是固定锚点，射程圈即真实判定圈） */
  private isInRange(e: Entity, range: number): boolean {
    const center = this.hero?.position ?? this.config.center;
    const dx = e.position.x - center.x;
    const dy = e.position.y - center.y;
    return dx * dx + dy * dy <= range * range;
  }

  /**
   * 按策略在"射程内"选目标（**只在重新索敌时调用**，粘性锁定见 resolveAttackTarget）。
   * 两步：① 以英雄自身位置为圆心、range 为半径过滤候选；
   *       ② 在候选集内按策略挑选。
   * 因此 farthest = **攻击范围内最远的敌人**（不是全图最远）；nearest = 范围内最近。
   * @param range 射程（普攻传 getAttackRange()，技能传 cast_range）
   */
  private pickEnemy(strategy: string, range: number): Entity | null {
    const center = this.hero?.position ?? this.config.center;
    const enemies = this.ctx.GetTeamEntities(2).filter((e) => {
      if (e.status.get(StateType.Untargetable)) return false; // 不可选中不参与索敌
      const dx = e.position.x - center.x;
      const dy = e.position.y - center.y;
      return dx * dx + dy * dy <= range * range;
    });
    return pickTarget(strategy as any, enemies, center) as Entity | null;
  }

  /* ===================================================================
   * 难度缩放（"这一档到底多难"的唯一落地点）
   *
   * 曲线与倍率全在 `common/DifficultyConfig`（设计稿口径，档 1 = ×1）；本场景只负责**把它乘上去**：
   *   · 怪 HP / 攻击   ← `MonsterPool.statScaleHook`（每只怪出生时乘一次，三条放怪路径共用）
   *   · 刷怪间隔       ← `getSpawnInterval`
   *   · 击杀金币/经验  ← `currentRewardScale`
   * 通关解锁下一档在 `endRun`（`LevelData.markCleared`）。
   *
   * ⚠ 只乘 **HP 与攻击**，不动别的属性：护甲/魔抗/闪避/移速属于"怪的个性"，
   *   跟着难度一起涨会让"这只怪是什么怪"变得不可辨认（设计稿 §4.6 也只给了这两个乘区）。
   * =================================================================== */

  /**
   * 把本局难度的倍率乘到怪物实体的**基础属性**上。
   *
   * - **每次 acquire 都要乘**：对象池复用会先按配置 `Reinit`（基础属性回到配置值），
   *   所以这是"每只怪出生一次"的动作，不是"开局一次"的动作。
   * - **只乘基础值**（`AttributeSystem.setBase`）：遗物/Buff 那类 Modifier 贡献是另一层，
   *   乘基础值 = 难度对所有怪一视同仁，也不会和玩家的减益效果互相污染。
   * - 乘完要把当前血**补到新上限**：`Reinit` 里 `hp` 已经按旧上限设过了。
   */
  private applyDifficultyScale(e: Entity, kind?: UnitKind): void {
    if (!e || this.difficulty <= 1) return;   // 档 1 = 基准平衡，一个数都不动
    // 没显式传 kind 时用实体自己解析出来的类别（`Reinit` → `resolveUnitKind(def)` 已经算过一遍）——
    // 这样"经济/守卫 Boss 拿哪条 HP 曲线"在三条放怪路径上口径一致，不依赖调用方有没有传 kind
    const k = kind ?? e.unitKind;
    const isBoss = k === UnitKind.StageBoss || k === UnitKind.FinalBoss;
    const hpMul = isBoss ? bossHpMul(this.difficulty) : enemyHpMul(this.difficulty);
    this.mulBaseAttr(e, AttributeType.MaxHp, hpMul);
    this.mulBaseAttr(e, AttributeType.Atk, enemyAtkMul(this.difficulty));
    e.hp = e.getMaxHp();
  }

  /**
   * 把某个属性的**基础值**乘一个倍率。
   *
   * ⚠ 单位口径是坑：`AttributeSystem.getBase` 给的是**运行时 float**，而 `setBase` 吃的是
   *   **配置 int**（缩放型属性内部会 ÷100）。所以回写必须过 `denormalize`，否则攻速/魔抗这类
   *   缩放属性会被连除两次 100（`mulBaseAttr` 现在只用在不缩放的 HP/攻击上，但别把这条删了）。
   */
  private mulBaseAttr(e: Entity, id: AttributeType, mul: number): void {
    if (!(mul > 0) || mul === 1) return;
    const before = e.attrs.getBase(id);
    if (!(before > 0)) return;   // 配置没给这项（0）= 不凭空加出来
    e.attrs.setBase(id, AttributeScaling.denormalize(id, before * mul));
  }

  /* ===================================================================
   * 刷怪（出怪导演的运行时部分：批表 + 存活软阀门）
   * 静态配置见模块头部 `SPAWN_BEATS`
   * =================================================================== */

  /** 批计数（只用于日志；对局统计里的「波数」用的是 `this.stage`，见 reportRunTasks） */
  private waveCount = 0;

  /** 当前处于第几个 beat（0 起；每 SPAWN_BEAT_SEC 秒进一档） */
  private currentBeatIndex(): number {
    return Math.max(0, Math.floor(this.elapsed / SPAWN_BEAT_SEC));
  }

  /** 当前 beat 的刷怪参数（超出常规 beat 后由 Boss 阶段 beat 接管；再叠加守卫击杀的加码） */
  private currentBeat(): SpawnBeat {
    const i = this.currentBeatIndex();
    const base = i < SPAWN_BEATS.length ? SPAWN_BEATS[i] : SPAWN_BEAT_BOSS;
    // 敌方守卫每被击杀 1 只 → 同时数量 +1、批间隔 ×0.95（见 SPAWN_GUARD_GAP_MUL 的注释）
    const guards = this.bossScheduler ? this.bossScheduler.getGuardKills() : 0;
    if (guards <= 0) return base;
    return {
      n: Math.min(base.n + guards, SPAWN_MAX_CONCURRENT),
      gap: base.gap * Math.pow(SPAWN_GUARD_GAP_MUL, guards),
      mix: base.mix,
    };
  }

  /**
   * 下一批的间隔（秒）= 当前 beat 的 `gap` × 存活软阀门系数。
   *
   * ⚠ 间隔**不是难度旋钮，是呼吸旋钮**：它随「每批更多 + 每只更肉」同步变长（1.33s → 4.03s），
   *   把难度增长切成一节一节的「脉冲」，而不是一条永不喘息的加速带。
   *   真正决定难度的是 `gap` 背后的推导公式（见模块头部 SPAWN_BEATS 的注释），不是这个数字本身。
   */
  private getSpawnInterval(): number {
    const gap = this.currentBeat().gap;
    const alive = this.ctx ? this.ctx.activeEntityCount() - 1 : 0; // 减英雄
    // 难度侧：间隔 ×(0.97)^(N-1)（已按 SPAWN_GAP_MIN 封顶 —— 见 DifficultyConfig 的口径 ①：
    // 后期难度靠"每只怪更肉"承担，不靠"一秒比一秒多"，否则会撞上同屏保险丝与攻击频率墙）
    const byDifficulty = gap * spawnGapMul(this.difficulty);
    return alive > SPAWN_ALIVE_SOFT ? byDifficulty * 1.5 : byDifficulty;
  }

  /**
   * 把 beat 的混怪权重按 `config.monsterPool` 白名单过滤（空名单 = 不限制）。
   *
   * 白名单把整张 mix 剔空时**回落到原始 mix** —— 名单配错不该让游戏停止出怪。
   */
  private filterMix(mix: [number, number][]): [number, number][] {
    const allow = this.config.monsterPool;
    if (!allow || !allow.length) return mix;
    const kept = mix.filter((pair) => allow.indexOf(pair[0]) >= 0);
    return kept.length ? kept : mix;
  }

  /**
   * 从四周刷新**一批**怪物 —— 数量与混怪完全由当前 beat 决定。
   *
   * 存活上限**不在本函数判**（那是 `checkStage` 的软阀门与保险丝的事，见 SPAWN_ALIVE_SOFT/HARD），
   * 本函数只负责"按当前 beat 刷一批"，并**把这一批夹进剩余容量**——
   * 否则存活 49 时遇上 beat.n=6 的一批会一口气冲破保险丝（最多溢出 5 只）。
   * @returns 是否真的刷出来了（false → 调用方只等一小会儿就重试，见 SPAWN_RETRY_SEC）
   */
  private spawnWave(): boolean {
    const [rMin, rMax] = this.config.spawnRadius;
    const beat = this.currentBeat();
    const mix = this.filterMix(beat.mix);

    const room = Math.max(0, SPAWN_ALIVE_HARD - (this.ctx.activeEntityCount() - 1)); // 减英雄
    const count = Math.min(beat.n, room);
    if (count <= 0) return false;

    let born = 0;
    for (let i = 0; i < count; i++) {
      const defId = pickWeighted(mix);
      if (!defId) continue;
      const def = this.ctx.getUnitDef(defId);
      if (!def) continue;

      // 从统一池取一只怪物：逻辑实体 + 预制件节点 + EntityView 一次搞定
      const m = this.monsterPool.acquire(def);
      const angle = Math.random() * Math.PI * 2;
      const dist = rMin + Math.random() * (rMax - rMin);
      m.position = {
        x: this.config.center.x + Math.cos(angle) * dist,
        y: this.config.center.y + Math.sin(angle) * dist,
      };
      born++;
    }

    if (born <= 0) return false;
    this.waveCount++;
    console.log(`[战斗] 第 ${this.waveCount} 批刷新 ${born}/${beat.n} 只（beat ${this.currentBeatIndex() + 1}，`
      + `gap=${beat.gap}s，场上 ${this.ctx.activeEntityCount() - 1}，逻辑池空闲 ${this.monsterPool.idleCount()}）`);
    return true;
  }

  /* ===================================================================
   * 遗物功能（肉鸽商店）—— 本场景只是**宿主**，规则全在 `RelicShop`（battle/RelicShop.ts）
   *
   * 数据流（单向，UI 只渲染与上报；本场景只做「节点 + 转发 + 平台能力」）：
   *   入口按钮 click ──▶ openRelicPanel()                   → relicShop.open()
   *   面板「刷新」  ──▶ emit(RelicRefresh)                  → relicShop.refresh()
   *   item 点击     ──▶ emit(RelicPicked,id,viaAd)          → relicShop.pick() → 背包/属性
   *   面板置灰      ◀── relicShop 的 refreshCost/adFreeLeft + store 的 gold（面板只读）
   * =================================================================== */

  /** 面板节点显隐的**唯一写入口**（面板只写 panelVisible 这个开关，不自己动自己的节点） */
  private applyRelicPanelVisible(): void {
    const visible = this.relicShop.panelVisible.value;
    if (this.relicPanelNode) this.relicPanelNode.active = visible;
    // 技能详情面板常驻、渲染层级在遗物面板之上 → 面板一开就把它收掉（它由 HUD 持有）
    if (visible) this.uiView?.hideSkillDetail();
  }

  /**
   * 拉起激励视频广告 —— 本场景提供给三个商店的**平台能力**（`playAd` 依赖）。
   *
   * 播放期间把本局置为暂停（广告回来再恢复原状态）—— 广告是覆盖全屏的原生层，
   * 不暂停的话玩家回来会发现自己已经被怪打死了。
   *
   * 平台 SDK 由接入方通过 `AdMgr.inst.setProvider(...)` 注入；**未接入时 `AdMgr` 一律返回 false**
   * （`isAvailable` 也是 false）→ 商店按"没看成"正常拒绝本次刷新/补选，**不发奖励**。
   * 口径见 `AdMgr` 文件头：这里曾经靠"开发兜底按看完处理"白送过免费刷新。
   */
  private playRewardAd(placement: AdPlacement): Promise<boolean> {
    const wasPaused = this.battleStore.isPaused;
    this.battleStore.isPaused = true;
    return AdMgr.inst.showRewardVideo(placement).then((ok) => {
      this.battleStore.isPaused = wasPaused;
      if (!ok) ezgame.info(`[广告] ${placement}：未看完，不发奖励`);
      return ok;
    });
  }

  /* ===================================================================
   * 复活（局内复活券 / 看广告复活）—— 用的地方**检查背包**，不另存一份
   *
   * 三种"复活来源"的口径（`docs/bag/README.md` §6）：
   *   ① **局内复活券**：背包道具 `revive_ticket`（商城 A5 发，跨局累积）→ 有几张就能复活几次
   *   ② **看广告复活**：每局 `battle_constants.reviveAdPerRun` 次（现 1），且 `AdMgr` 可用
   *   ③ 都没有 → 与旧行为**逐字一致**：不弹面板，直接 `endRun('defeat','hero_dead')`
   *
   * ⚠ 拦截时机是本文件唯一一处"技术选择"：**不能**等到 `OnDeath`（那时 `Die()` 已经清空 Modifier，
   *   复活就得把遗物 / Buff / 技能全部重挂一遍）。走 `OnTakeDamage` 补血 + 置回 `alive`，
   *   死亡检查就永远不成立 —— 机制说明见 `DamagePipeline` 的 Phase 7 / Phase 8 注释。
   * =================================================================== */

  /**
   * 英雄这一击被打死时的处理（在 `OnTakeDamage` 里调，此时 `Die()` 还没跑）。
   *
   * 判据（**只有这里读过一次**，面板只负责画）：
   *   · 有复活券（`bagData.getCount('revive_ticket') > 0`）→ 面板出现「用复活券复活」
   *   · 没有券但本局还有广告复活次数且广告可用 → 面板出现「看广告复活」
   *   · 两样都没有 → **什么都不做**，让 `DamagePipeline` 照旧判死（`OnDeath → endRun`）
   */
  private onLethalForHero(): void {
    if (this.finished || !this.hero) return;
    // 没被打死（大多数情况）→ 立刻返回，别在每次受伤时都去读背包
    if (this.hero.hp > 0 && this.hero.alive) return;

    if (this.revivePending) {
      // 面板已经开着（同一帧里的第二只怪补刀）→ 继续拦住，绝不让它真的判死
      this.keepHeroAlive();
      return;
    }

    const ticketLeft = DataCenter.ins.bagData.getCount(BAG_ITEM_KEY.reviveTicket);
    const canAd = this.adRevivesLeft > 0 && AdMgr.inst.isAvailable('revive');
    if (ticketLeft <= 0 && !canAd) return;

    this.keepHeroAlive();
    this.revivePending = true;
    // 面板期间**暂停本局**（`update` 的暂停分支会停掉战斗推进，也就不会再有伤害进来）
    this.battleStore.isPaused = true;
    this.showRevivePrompt(ticketLeft, canAd);
  }

  /**
   * 把"这一击打死了"就地撤销：补回 1 点血 + **把 `alive` 置回 true**。
   *
   * ⚠ 第二件事不能漏：`Entity.ChangeHp` 在 `hp <= 0` 时会把 `alive` 置 false，而
   *   `IsDead()` 判的是 `!alive || hp <= 0` —— 只补血不置回 `alive` 照样判死
   *   （同一个坑记在 `Modifier_TimeRewind` 的注释里）。
   * ⚠ 只补到 1 点血（不是满血）：满血是**玩家选了复活之后**才给的（`finishRevive`），
   *   否则"点放弃"那一刻的状态就已经是满血了。
   */
  private keepHeroAlive(): void {
    const hero = this.hero;
    if (!hero) return;
    hero.alive = true;
    if (hero.hp < 1) hero.ChangeHp(1 - hero.hp);
  }

  /** 弹复活面板（首次调用时把面板建在 HUD 节点下，之后复用同一块） */
  private showRevivePrompt(ticketLeft: number, canAd: boolean): void {
    if (!this.revivePrompt) {
      this.revivePrompt = RevivePromptPanel.ensure(this.uiViewNode);
      if (this.revivePrompt) this.revivePrompt.onChoose = (c) => this.onReviveChoice(c);
    }
    if (!this.revivePrompt) {
      ezgame.error('[复活] 面板没建起来（HUD 节点缺失？）→ 本局按阵亡结束');
      this.giveUpRevive('panel_missing');
      return;
    }
    this.revivePrompt.show({ ticketLeft, canAd });
  }

  /**
   * 玩家在复活面板上做了选择（面板只上报，动作全在这里）。
   * @param choice `ticket` 用复活券 · `ad` 看广告 · `giveup` 放弃本局
   */
  private onReviveChoice(choice: ReviveChoice): void {
    if (!this.revivePending) return;

    if (choice === 'ticket') {
      // 扣券与判据同源：扣不动（存量刚被别处扣掉）就重画一次面板，而不是白送一次复活
      if (!DataCenter.ins.bagData.consumeItem(BAG_ITEM_KEY.reviveTicket, 1)) {
        const left = DataCenter.ins.bagData.getCount(BAG_ITEM_KEY.reviveTicket);
        this.revivePrompt?.show({ ticketLeft: left, canAd: this.adRevivesLeft > 0 && AdMgr.inst.isAvailable('revive') });
        return;
      }
      this.finishRevive(`用 1 张局内复活券复活（背包剩 ${DataCenter.ins.bagData.getCount(BAG_ITEM_KEY.reviveTicket)} 张）`);
      return;
    }

    if (choice === 'ad') {
      if (this.adRevivesLeft <= 0) return;
      this.playRewardAd('revive').then((ok) => {
        if (!this.node || !this.node.isValid) return;
        if (!ok) {
          // 没看完 = 不发奖（`AdMgr` 的既定语义）；面板留着，玩家还能选券或放弃
          this.uiView?.showFloatText(AdMgr.inst.hasProvider ? '看完视频才能复活' : '广告暂不可用');
          return;
        }
        this.adRevivesLeft--;
        this.finishRevive(`看广告复活（本局还剩 ${this.adRevivesLeft} 次）`);
      });
      return;
    }

    this.giveUpRevive('hero_giveup');
  }

  /** 复活成功：收起面板 → 满血 → 解除暂停（本局继续） */
  private finishRevive(reason: string): void {
    this.revivePending = false;
    this.revivePrompt?.hide();
    this.hero?.FullHeal();
    this.battleStore.isPaused = false;
    this.syncHeroToStore();
    ezgame.info(`[复活] ${reason} → 满血继续本局（第 ${this.stage} 阶段，存活 ${this.elapsed.toFixed(0)}s）`);
  }

  /** 放弃复活 → 本局判负（与旧的"英雄阵亡"同一条收口，只换一个 reason 便于日志对账） */
  private giveUpRevive(reason: string): void {
    this.revivePending = false;
    this.revivePrompt?.hide();
    if (this.hero && !this.hero.IsDead()) this.hero.Die();
    this.endRun('defeat', reason);
  }

  /* ===================================================================
   * 本局结束 —— 唯一收口
   * =================================================================== */

  /**
   * 结束本局。**全项目唯一的收尾入口**（幂等：谁先触发谁生效，后来的一律忽略）。
   *
   * 触发点（都是瞬时事件，所以**不需要每帧轮询**）：
   *   · `bindBattleEvents` 的 `OnDeath` —— 英雄阵亡 → `defeat`；最终 Boss 阵亡 → `victory`
   *   · `checkStage` 里 Boss 阶段倒计时归零（超时未击杀）→ `defeat`
   *   · `update` 里那条英雄死亡的**兜底断言**（只为"事件漏了也不卡住"，命中会打 warn）
   *
   * 职责边界（三条，别越界）：
   *   ① **只做**：定胜负 → 局外结算 → 写 store / 发事件 → 弹结算面板；
   *   ② **不回主界面**：回主界面是结算面板「确定」→ `exit()` 的事（先看结算、再由玩家决定离开）；
   *   ③ **不销毁战斗实体**：调用点在 `ctx.Tick` 的伤害/死亡链里，那一刻 BattleContext 还在遍历
   *      实体/弹道列表，当场回收池会踩"遍历中改集合" —— 池与节点的清理交给 `exit()`（点确定时）。
   *
   * @param result 胜负（victory = 最终 Boss 被击杀；defeat = 英雄阵亡 / Boss 阶段超时）
   * @param reason 结束原因（日志与 BATTLE_ENDED 事件用：hero_dead / boss_timeout / boss_killed …）
   */
  endRun(result: 'victory' | 'defeat', reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.victory = result === 'victory';

    // 本局结束 → 手动锁定与选中环一并收掉（面板弹出后 `update` 不再推进，标记不会自己消失）
    this.clearManualTarget();

    console.log(`========== 战斗结算 ==========\n结果: ${result}（${reason}） 难度 ${this.difficulty} 存活 ${this.elapsed.toFixed(0)}s\n击杀: ${this.killCount}\n金币: ${Math.floor(this.hero?.gold ?? 0)}`);

    // 通关 → **解锁下一档**（「通关第 N 档 → 解锁第 N+1 档」，见 LevelData.markCleared）。
    // ⚠ 放在 reportRunTasks 之前：进度先落盘，任务/成就上报里若以后要读"已解锁到第几档"才是新值。
    if (this.victory) {
      const advanced = DataCenter.ins.levelData.markCleared(this.difficulty);
      const next = DataCenter.ins.levelData.getUnlockedLevel();
      ezgame.info(`[难度] 通关 ${levelLabel(this.difficulty)}`
        + (advanced ? ` → 已解锁 ${levelLabel(next)}` : '（已通关过，进度不变）'));

      // 通关 → 发**通用英雄经验**（英雄详情弹窗里花它升级，见 docs/hero-detail/README.md §4）。
      // ⚠ 只有**通关**发：它是 `clearRewardHeroExpBase` 唯一的消费方，那个键的自述就是
      //   "通关局外英雄经验基数（结算时按配置发）"；中途退出走 `exit()` 不调 `endRun`，所以不发。
      // ⚠ 与「任务领奖发账号经验/金币」不冲突：那是**另一条轴**（账号等级与经济），
      //   英雄经验只买英雄等级、没有第二个出口，所以留在结算里发（见下面的说明）。
      const heroExp = DataCenter.ins.grantClearHeroExp(this.difficulty);
      if (heroExp > 0) {
        ezgame.info(`[英雄经验] 通关结算 +${heroExp}（难度 ${levelLabel(this.difficulty)} 收益系数参与计算）`);
      }
    }

    // ⚠ 除上面那笔**英雄经验**外，这里**不再发局外奖励**（旧版在此一次性发账号经验/英雄经验）。
    //   账号经验与金币的口径是「**完成任务才发奖**」：本局只把结算数据**上报成任务进度**，
    //   玩家在任务界面点「领取」时由 DataCenter.grantTaskReward 发放。
    this.reportRunTasks(this.victory);

    this.battleStore.isGameOver = true;
    EventBus.emit(EventNames.BATTLE_ENDED, { result, reason });

    // 弹结算面板（面板数据后续再补）；玩家点「确定」才回主界面（见 View_Game_Stage.exit）
    this.uiView?.showEnd(this.victory);
  }

  /**
   * 把本局战果上报成任务进度（**局外奖励改由「完成任务」发放后的唯一结算出口**），
   * 并在同一处并排上报**成就进度**（本局峰值 + 通关类，见 `docs/成就系统设计.md` §9.B）。
   *
   * 口径：
   *   · `play_games` +1 —— **只有真正打完一局才算**（中途退出走 `exit()`，不调 `endRun`，所以不计）
   *   · `victory`   +1 —— 只有击杀最终 Boss 通关
   *   · `stage_reached` / `hero_level` —— **取峰值**（单局最高阶段 / 单局最高英雄等级，只增不减）
   *
   * 即时类进度（击杀数 / 获得金币 / 消耗金币 / 遗物）在各自的事件点上报，不在这里补。
   */
  private reportRunTasks(victory: boolean): void {
    const taskData = DataCenter.ins.taskData;
    const achieveData = DataCenter.ins.achieveData;
    taskData.addProgress('play_games', 1);
    // 成就进度：完成对局（target=play_games，胜负都算）
    achieveData.addProgress('play_games', 1);
    if (victory) {
      taskData.addProgress('victory', 1);
      // 成就进度：通关次数（target=victory，只在击杀最终 Boss 通关时 +1）
      achieveData.addProgress('victory', 1);

      /* ── 通关类成就（设计稿 §9.B，**与上面的 victory 同一个判定分支**，各 +1）── */
      // 闪电战：最终 Boss **出现后** CLEAR_FAST_BOSS_WINDOW_SEC 秒内击杀它。
      // ⚠ 基准是「最终 Boss 刷出的那一刻」，不是绝对用时 —— 绝对用时会随单局时长改版而失效
      //   （旧写法 `elapsed <= 240`：最终 Boss 恰好在 elapsed=240 刷出，所以那个条件**永远不可能成立**，
      //    这个成就此前一直是死的；改成相对窗口后与单局时长解耦）。
      if (this.finalBossSpawnElapsed >= 0
        && this.elapsed - this.finalBossSpawnElapsed <= CLEAR_FAST_BOSS_WINDOW_SEC) {
        achieveData.addProgress('clear_fast', 1);
      }
      // 残血英雄：通关时 hp / maxHp ≤ 0.1
      const maxHp = this.hero ? this.hero.getMaxHp() : 0;
      if (maxHp > 0 && this.hero.hp / maxHp <= 0.1) achieveData.addProgress('clear_low_hp', 1);
      // 裸装勇士：本局一件遗物都没有
      const relicCount = this.heroRelics ? this.heroRelics.getAll().length : 0;
      if (relicCount === 0) achieveData.addProgress('run_no_relic_clear', 1);
      // 独门绝技：技能槽占用 ≤ 1（只剩英雄自带的那一个技能，没抽过肉鸽技能）
      const usedSlots = this.skillSlots ? this.skillSlots.getSkillIds().filter((id) => id > 0).length : 0;
      if (usedSlots <= 1) achieveData.addProgress('clear_one_skill', 1);
      // 毫发无伤：本局英雄未受过伤（tookDamage 在受击订阅里置位、resetRun 里清零）
      if (!this.tookDamage) achieveData.addProgress('clear_no_damage', 1);
    }
    taskData.peakProgress('stage_reached', this.stage);
    // 成就进度：单局最高阶段（target=stage_reached，峰值型）
    achieveData.peakProgress('stage_reached', this.stage);
    taskData.peakProgress('hero_level', this.battleStore.level ?? 1);
    // 成就进度：单局最高英雄等级（target=hero_level，峰值型）
    achieveData.peakProgress('hero_level', this.battleStore.level ?? 1);

    /* ── 成就专属的本局峰值（§9.B）：**失败局也记** —— 单局击杀 / 单局金币 / 存活时长都不看胜负 ── */
    achieveData.peakProgress('kill_in_run', this.killCount);
    achieveData.peakProgress('gold_in_run', this.hero ? this.hero.gold : 0);
    achieveData.peakProgress('survive_time', this.elapsed);

    // 对局统计（总场次 / 总击杀 / 最高波数）——与奖励无关，保持原样
    DataCenter.ins.playerInfo.recordGameEnd(this.killCount, this.stage);
    DataCenter.ins.saveAll();

    console.log(`[局外结算] 上报任务进度：完成对局 +1${victory ? ' / 通关 +1' : ''}`
      + ` / 单局最高阶段 ${this.stage} / 单局英雄等级 ${this.battleStore.level ?? 1}`
      + `（奖励改为在任务界面领取）`);
  }

  /* ===================================================================
   * 对外查询
   * =================================================================== */

  isFinished(): boolean { return this.finished; }
  isVictory(): boolean { return this.victory; }
  getElapsed(): number { return this.elapsed; }
  getKillCount(): number { return this.killCount; }
  getCurrentPhase(): number { return 1; }

  /* ===================================================================
   * 成就特殊效果（开局快照的**唯一读取口**）
   * =================================================================== */

  /**
   * 读本局成就效果快照 —— **每局只调一次**（`show()`），读到的值本局全程不变。
   *
   * 为什么不让各系统自己读：`AchievementData.getEffects()` 是**实时**的（局中领奖立刻变），
   * 若战斗层各自实时读，会出现「打到一半突然多 50 金币 / 多一个商店选项」——
   * 与设计稿 §5.2「开局快照」正好相反。所以只在这里读一次，再由下面那组取数口往下发。
   */
  private snapshotAchieveEffects(): void {
    this.achieveEffects = DataCenter.ins.achieveData.getEffects() ?? {};
    const codes = Object.keys(this.achieveEffects);
    if (codes.length) {
      console.log(`[成就] 本局开局快照 ${codes.length} 条效果：`
        + codes.map((c) => `${c}=${this.achieveEffects[c as AchEffectCode]}`).join(' / '));
    }
  }

  /** 快照里某条效果的数值（未生效 = 0）—— 只读，全部取数口都走它 */
  private achValue(code: AchEffectCode): number {
    return this.achieveEffects[code] ?? 0;
  }

  /**
   * 百分比类效果的**折算比例**（配表填百分数：`10` = 10% → 返回 `0.1`），已钳在 [0, 1]。
   *
   * 两个用途（按语义选一个，别两边都折算）：
   *   · **折扣类**（抽取费用 / 击杀商店价格）—— 消费方写 `原价 × (1 - 比例)`；
   *   · **加成类**（击杀金币 / 局内经验）—— 消费方写 `原值 × (1 + 比例)`。
   */
  private achPercent(code: AchEffectCode): number {
    return Math.max(0, Math.min(1, this.achValue(code) / 100));
  }

  /** 局内初始金币的成就加成（`run_start_gold`，`selectHero` 播种时叠加） */
  private achRunStartGold(): number { return Math.max(0, Math.floor(this.achValue('run_start_gold'))); }

  /** 开局英雄额外等级（`hero_start_level`） */
  private achHeroStartLevel(): number { return Math.max(0, Math.floor(this.achValue('hero_start_level'))); }

  /** 击杀金币加成比例（`gold_gain_bonus`，`grantKillReward` 金币侧用） */
  private achGoldGainBonus(): number { return this.achPercent('gold_gain_bonus'); }

  /** 局内经验加成比例（`battle_exp_bonus`，`grantKillReward` 经验侧用） */
  private achBattleExpBonus(): number { return this.achPercent('battle_exp_bonus'); }

  /** 肉鸽抽取费用折扣比例（`shop_draw_discount`，`RelicShop` 费用侧用） */
  private achShopDrawDiscount(): number { return this.achPercent('shop_draw_discount'); }

  /** 肉鸽商店额外选项数（`shop_option_plus`，`RelicShop` 抽取格数用） */
  private achShopOptionPlus(): number { return Math.max(0, Math.floor(this.achValue('shop_option_plus'))); }

  /** 肉鸽商店额外「广告免费抽」次数（`ad_free_draw`，与配置的 `adFreeDrawPerRun` 叠加） */
  private achAdFreeDraw(): number { return Math.max(0, Math.floor(this.achValue('ad_free_draw'))); }

  /** 击杀商店价格折扣比例（`kill_buff_discount`，`BuffShop` 价格侧用） */
  private achKillBuffDiscount(): number { return this.achPercent('kill_buff_discount'); }

  /** 选人阶段额外免费刷新次数（`hero_select_free`，叠加在配置的广告次数上） */
  private achHeroSelectFree(): number { return Math.max(0, Math.floor(this.achValue('hero_select_free'))); }

  /** 开局赠遗物件数（`relic_start_gift`，`RelicShop` 开局发放用） */
  private achRelicStartGift(): number { return Math.max(0, Math.floor(this.achValue('relic_start_gift'))); }
}
